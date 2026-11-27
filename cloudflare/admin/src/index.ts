// admin.dessage.xyz 的访问门禁：身份完全交给 Cloudflare Access，Worker 只验 Access 下发的 JWT。
// 不认 Cf-Access-Authenticated-User-Email 这类可被客户端伪造的头。

export interface Env {
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
  /** 控制面的库（运维看板直接读）。见 agent/docs/agent-health.md §5.6。 */
  DB?: D1Database;
}

const CERTS_TTL_MS = 5 * 60_000;
/** 未知 kid 的强制重拉冷却：防止伪造 kid 把 5 分钟缓存反复打掉。 */
const FORCED_FETCH_COOLDOWN_MS = 30_000;
/** 时钟容差：exp 上等于接受刚过期 30 秒内的令牌，nbf 上等于允许提前 30 秒生效，用来抵消边缘与 isolate 的时钟差。 */
const CLOCK_SKEW_MS = 30_000;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

interface AccessClaims {
  aud?: unknown;
  email?: unknown;
  exp?: unknown;
  iss?: unknown;
  nbf?: unknown;
}

/** workers-types 的 JsonWebKey 不含 kid，这里只取验签需要的字段。 */
interface AccessJwk {
  kid?: unknown;
  kty?: unknown;
  n?: unknown;
  e?: unknown;
}

/** isolate 内缓存 JWKS；不落 D1/KV，isolate 重启自然重拉。 */
let certsCache: AccessJwk[] | null = null;
let certsFetchedAt = 0;
let lastForcedFetchAt = 0;

function fromB64u(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(text)) return null;
  const padded = text.replace(/-/g, "+").replace(/_/g, "/");
  const pad = padded.length % 4 === 0 ? "" : "=".repeat(4 - (padded.length % 4));
  try {
    const binary = atob(padded + pad);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

function decodeJson<T>(part: string): T | null {
  const bytes = fromB64u(part);
  if (!bytes) return null;
  try {
    return JSON.parse(decoder.decode(bytes)) as T;
  } catch {
    return null;
  }
}

function normalizeDomain(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

async function loadKeys(teamDomain: string, force: boolean): Promise<AccessJwk[]> {
  const now = Date.now();
  if (!force && certsCache && now - certsFetchedAt < CERTS_TTL_MS) return certsCache;

  try {
    const response = await fetch(`${teamDomain}/cdn-cgi/access/certs`);
    if (!response.ok) return certsCache ?? [];
    const body = (await response.json()) as { keys?: unknown };
    const keys = Array.isArray(body.keys) ? (body.keys as AccessJwk[]) : [];
    certsCache = keys;
    certsFetchedAt = now;
    return keys;
  } catch {
    // 拉取失败时退回上一次的缓存：轮换窗口内旧公钥通常仍然有效。
    return certsCache ?? [];
  }
}

async function verifyAccessJwt(token: string, env: Env): Promise<string | null> {
  const teamDomain = normalizeDomain(env.ACCESS_TEAM_DOMAIN ?? "");
  const audience = (env.ACCESS_AUD ?? "").trim();
  if (!teamDomain || !audience) return null;

  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [headerPart, payloadPart, signaturePart] = parts;

  const header = decodeJson<{ alg?: unknown; kid?: unknown }>(headerPart);
  if (!header || header.alg !== "RS256" || typeof header.kid !== "string") return null;

  const signature = fromB64u(signaturePart);
  if (!signature) return null;

  let keys = await loadKeys(teamDomain, false);
  let jwk = keys.find((key) => key.kid === header.kid);
  if (!jwk) {
    // 密钥轮换：缓存里没有这个 kid 时强制重拉一次，但 30 秒内只重拉一次。
    if (Date.now() - lastForcedFetchAt < FORCED_FETCH_COOLDOWN_MS) return null;
    lastForcedFetchAt = Date.now();
    keys = await loadKeys(teamDomain, true);
    jwk = keys.find((key) => key.kid === header.kid);
  }
  if (!jwk || jwk.kty !== "RSA" || typeof jwk.n !== "string" || typeof jwk.e !== "string") {
    return null;
  }

  try {
    const key = await crypto.subtle.importKey(
      "jwk",
      { kty: "RSA", n: jwk.n, e: jwk.e },
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
    const valid = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      key,
      signature,
      encoder.encode(`${headerPart}.${payloadPart}`),
    );
    if (!valid) return null;
  } catch {
    return null;
  }

  const claims = decodeJson<AccessClaims>(payloadPart);
  if (!claims) return null;

  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audiences.includes(audience)) return null;
  if (typeof claims.exp !== "number" || claims.exp * 1000 + CLOCK_SKEW_MS <= Date.now()) return null;
  // nbf 可以不存在；存在时才要求它不在未来。
  if (typeof claims.nbf === "number" && claims.nbf * 1000 > Date.now() + CLOCK_SKEW_MS) return null;
  if (typeof claims.iss !== "string" || normalizeDomain(claims.iss) !== teamDomain) return null;
  if (typeof claims.email !== "string" || claims.email.trim() === "") return null;

  return claims.email;
}

function baseHeaders(): Record<string, string> {
  return {
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "no-referrer",
    "content-security-policy":
      "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
  };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function homePage(email: string): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Veyl 管理后台</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 32px; background: #f6f7f9; color: #1b1d21;
    font: 15px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; }
  main { max-width: 720px; margin: 0 auto; padding: 24px; background: #fff; border: 1px solid #e4e6ea;
    border-radius: 12px; }
  h1 { margin: 0 0 16px; font-size: 17px; font-weight: 600; }
  p { margin: 0 0 20px; color: #5b6068; }
  strong { color: #1b1d21; font-weight: 500; }
  a { display: inline-block; height: 36px; padding: 0 16px; line-height: 34px; color: #1b1d21;
    background: #fff; border: 1px solid #d6d9de; border-radius: 8px; text-decoration: none; }
  a:hover { background: #f1f2f4; }
</style>
</head>
<body>
<main>
  <h1>Veyl 管理后台</h1>
  <p>已登录：<strong>${escapeHtml(email)}</strong></p>
  <a href="/cdn-cgi/access/logout">退出</a>
</main>
</body>
</html>`;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) {
      return new Response("服务未配置", { status: 503, headers: baseHeaders() });
    }

    const token = request.headers.get("cf-access-jwt-assertion") ?? "";
    const email = token ? await verifyAccessJwt(token, env) : null;
    // Access 在边缘就拦下了未登录请求，能走到这里还验不过的只可能是绕过或伪造。
    if (!email) return new Response("Unauthorized", { status: 401, headers: baseHeaders() });

    const { pathname } = new URL(request.url);

    if (pathname === "/" && request.method.toUpperCase() === "GET") {
      return new Response(homePage(email), {
        status: 200,
        headers: { ...baseHeaders(), "content-type": "text/html; charset=utf-8" },
      });
    }
    return new Response("Not Found", { status: 404, headers: baseHeaders() });
  },
};
