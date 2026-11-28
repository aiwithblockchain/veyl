// admin.dessage.xyz 的访问门禁：身份完全交给 Cloudflare Access，Worker 只验 Access 下发的 JWT。
// 不认 Cf-Access-Authenticated-User-Email 这类可被客户端伪造的头。
//
// 第一屏是体检表，不是仪表盘：同时读 prod 与 dev 的 servers，服务端直出 HTML。
// 唯一会改状态的动作是「签只读票」——它只签一张读票并写一条审计，不碰节点。

import type { D1Database } from "@cloudflare/workers-types";

import {
  renderPage,
  type EnvName,
  type LabelledServer,
  type ServerRow,
} from "./render";
import { buildCurl, signOpsTicket } from "./ticket";

export interface Env {
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
  /** 控制面的库（运维看板直接读）。一个 worker 同时绑生产与 dev。见 agent/docs/agent-health.md §5.6。 */
  DB_PROD?: D1Database;
  DB_DEV?: D1Database;
  /** 运维票的 Ed25519 私钥（JWK），只在运维 worker 里，与业务签名密钥互不持有。 */
  OPS_TOKEN_SIGNING_JWK?: string;
}

const CERTS_TTL_MS = 5 * 60_000;
/** 未知 kid 的强制重拉冷却：防止伪造 kid 把 5 分钟缓存反复打掉。 */
const FORCED_FETCH_COOLDOWN_MS = 30_000;
/** 时钟容差：exp 上等于接受刚过期 30 秒内的令牌，nbf 上等于允许提前 30 秒生效，用来抵消边缘与 isolate 的时钟差。 */
const CLOCK_SKEW_MS = 30_000;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** 只取体检表需要的列；少了任何一列渲染就少一格。 */
const SERVER_COLUMNS =
  "id, name, state, agent_version, ip, control_port, cert_not_after, last_seen_at, failure_code, failure_stage";

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

/** 页面脚本只有一小段内联，用 nonce 放行；fetch 只允许同源。 */
function htmlHeaders(nonce: string): Record<string, string> {
  return {
    ...baseHeaders(),
    "content-type": "text/html; charset=utf-8",
    "content-security-policy":
      "default-src 'none'; style-src 'unsafe-inline'; " +
      `script-src 'nonce-${nonce}'; connect-src 'self'; ` +
      "frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  };
}

function jsonHeaders(): Record<string, string> {
  return {
    ...baseHeaders(),
    "content-type": "application/json; charset=utf-8",
    "content-security-policy": "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: jsonHeaders() });
}

function nonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

interface LoadedServers {
  rows: LabelledServer[];
  notes: string[];
}

async function loadServers(
  db: D1Database | undefined,
  envName: EnvName,
  notes: string[],
): Promise<LabelledServer[]> {
  if (!db) {
    notes.push(`${envName} 未绑定数据库`);
    return [];
  }
  try {
    const result = await db
      .prepare(`SELECT ${SERVER_COLUMNS} FROM servers WHERE destroyed_at IS NULL`)
      .all<ServerRow>();
    const rows = Array.isArray(result.results) ? result.results : [];
    return rows.map((row) => ({ ...row, env: envName }));
  } catch (error) {
    notes.push(`${envName} 读库失败：${errorText(error)}`);
    return [];
  }
}

function errorText(error: unknown): string {
  // 只取 message，不要把整个 D1 异常对象带进页面。
  return error instanceof Error ? error.message : String(error);
}

/** 日志里只放类型，不放正文——正文可能夹带配置值。 */
function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

async function loadAll(env: Env): Promise<LoadedServers> {
  const notes: string[] = [];
  const [prod, dev] = await Promise.all([
    loadServers(env.DB_PROD, "prod", notes),
    loadServers(env.DB_DEV, "dev", notes),
  ]);
  return { rows: [...prod, ...dev], notes };
}

interface TicketRow {
  id: string;
  account_id: string;
  ip: string | null;
  control_port: number | null;
}

async function issueTicket(request: Request, env: Env): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: "请求体不是 JSON", code: "bad_request" }, 400);
  }
  const payload = body as { env?: unknown; server_id?: unknown };
  const envName = payload.env === "prod" || payload.env === "dev" ? payload.env : null;
  if (!envName) return json({ error: "env 必须是 prod 或 dev", code: "bad_env" }, 400);
  if (typeof payload.server_id !== "string" || payload.server_id.trim() === "") {
    return json({ error: "缺少 server_id", code: "bad_server_id" }, 400);
  }
  // 只按参数绑定，不拼 SQL。
  const serverId = payload.server_id.trim();

  const db = envName === "prod" ? env.DB_PROD : env.DB_DEV;
  if (!db) return json({ error: `${envName} 未绑定数据库`, code: "db_unavailable" }, 503);

  let row: TicketRow | null;
  try {
    row = await db
      .prepare(
        "SELECT id, account_id, ip, control_port FROM servers WHERE id = ? AND destroyed_at IS NULL",
      )
      .bind(serverId)
      .first<TicketRow>();
  } catch (error) {
    console.warn(`[admin] ops_ticket_read_failed name=${errorName(error)}`);
    return json({ error: "读取节点失败", code: "read_failed" }, 500);
  }
  if (!row) return json({ error: "节点不存在或已销毁", code: "not_found" }, 404);

  if (!env.OPS_TOKEN_SIGNING_JWK) {
    return json({ error: "未配置运维签名密钥", code: "signing_key_missing" }, 503);
  }

  let ticket;
  try {
    ticket = await signOpsTicket(
      env.OPS_TOKEN_SIGNING_JWK,
      row.id,
      Math.floor(Date.now() / 1000),
    );
  } catch (error) {
    // 解析/导入密钥抛出的错误可能把 JWK 片段带在 message 里：对外只回稳定 code，
    // 日志只记错误类型，绝不记错误正文。
    console.warn(`[admin] ops_ticket_sign_failed name=${errorName(error)}`);
    return json({ error: "签票失败", code: "sign_failed" }, 500);
  }

  // 审计只记 env 与 jti；JWT 本身绝不落库、绝不进日志。
  try {
    await db
      .prepare(
        "INSERT INTO audit_log (at, account_id, server_id, action, detail) VALUES (?, ?, ?, ?, ?)",
      )
      .bind(
        Date.now(),
        row.account_id,
        row.id,
        "ops.ticket.issued",
        JSON.stringify({ env: envName, jti: ticket.jti }),
      )
      .run();
  } catch (error) {
    console.warn(`[admin] ops_ticket_audit_failed name=${errorName(error)}`);
    return json({ error: "审计写入失败，票未下发", code: "audit_failed" }, 500);
  }

  const curl =
    row.ip && row.control_port !== null ? buildCurl(row.ip, row.control_port, ticket.jwt) : "";
  return json({ jwt: ticket.jwt, curl, exp: ticket.exp });
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
    const method = request.method.toUpperCase();

    if (pathname === "/" && method === "GET") {
      const { rows, notes } = await loadAll(env);
      const pageNonce = nonce();
      const html = renderPage({ email, servers: rows, now: Date.now(), nonce: pageNonce, notes });
      return new Response(html, { status: 200, headers: htmlHeaders(pageNonce) });
    }

    if (pathname === "/ticket" && method === "POST") {
      return issueTicket(request, env);
    }

    return new Response("Not Found", { status: 404, headers: baseHeaders() });
  },
};
