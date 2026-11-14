// 设备令牌（§19.2）：静默注册、签发、刷新与重放检测。
// 只存 sha256(device_secret) 与 refresh 的哈希；任何明文凭据都不落库、不进日志。

import { apiError, json } from "./lib/http";
import { randomId, sha256B64u, signAccessToken, verifyAccessToken, b64u, randomBytes } from "./lib/crypto";

const ACCESS_TTL_SECONDS = 15 * 60;
const REFRESH_TTL_SECONDS = 30 * 24 * 3600;
const REGISTER_LIMIT_PER_HOUR = 10;

export interface AuthEnv {
  DB: D1Database;
  TOKEN_SIGNING_JWK?: string;
}

/** 外层环境：D1 绑定尚未创建时也允许 Worker 部署，认证端点返回 503 而不是崩。 */
export interface MaybeAuthEnv {
  DB?: D1Database;
  TOKEN_SIGNING_JWK?: string;
}

export interface Device {
  id: string;
  account_id: string;
  secret_hash: string;
  platform: string;
  app_version: string;
  refresh_family: string;
  revoked_at: number | null;
}

interface TokenBundle {
  account_id: string;
  device_id: string;
  access_token: string;
  access_expires_at: string;
  refresh_token: string;
  refresh_expires_at: string;
}

function isBase64Url(value: unknown, min = 20, max = 128): value is string {
  return typeof value === "string" && value.length >= min && value.length <= max && /^[A-Za-z0-9_-]+$/.test(value);
}

async function bumpRateLimit(db: D1Database, key: string, limit: number, windowMs: number): Promise<boolean> {
  const now = Date.now();
  const row = await db
    .prepare("SELECT window_start, count FROM rate_limits WHERE key = ?")
    .bind(key)
    .first<{ window_start: number; count: number }>();

  if (!row || now - row.window_start >= windowMs) {
    await db
      .prepare(
        "INSERT INTO rate_limits (key, window_start, count) VALUES (?, ?, 1) " +
          "ON CONFLICT(key) DO UPDATE SET window_start = excluded.window_start, count = 1",
      )
      .bind(key, now)
      .run();
    return true;
  }

  if (row.count >= limit) return false;
  await db
    .prepare("UPDATE rate_limits SET count = count + 1 WHERE key = ?")
    .bind(key)
    .run();
  return true;
}

async function issueTokens(env: AuthEnv, deviceId: string, accountId: string): Promise<TokenBundle> {
  if (!env.TOKEN_SIGNING_JWK) throw new Error("missing TOKEN_SIGNING_JWK");

  const nowSeconds = Math.floor(Date.now() / 1000);
  const accessExpires = nowSeconds + ACCESS_TTL_SECONDS;
  const accessToken = await signAccessToken(env.TOKEN_SIGNING_JWK, {
    sub: accountId,
    did: deviceId,
    iat: nowSeconds,
    exp: accessExpires,
    jti: randomId("jti_", 12),
  });

  const refreshToken = b64u(randomBytes(32));
  const refreshHash = await sha256B64u(refreshToken);
  const refreshExpires = Date.now() + REFRESH_TTL_SECONDS * 1000;
  await env.DB.prepare(
    "INSERT INTO refresh_tokens (hash, device_id, expires_at, created_at) VALUES (?, ?, ?, ?)",
  )
    .bind(refreshHash, deviceId, refreshExpires, Date.now())
    .run();

  return {
    account_id: accountId,
    device_id: deviceId,
    access_token: accessToken,
    access_expires_at: new Date(accessExpires * 1000).toISOString(),
    refresh_token: refreshToken,
    refresh_expires_at: new Date(refreshExpires).toISOString(),
  };
}

async function register(request: Request, env: AuthEnv): Promise<Response> {
  let body: { device_id?: unknown; secret_hash?: unknown; platform?: unknown; app_version?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return apiError("PRECONDITION_FAILED", "请求体不是合法 JSON");
  }

  const { device_id, secret_hash, platform, app_version } = body;
  if (!isBase64Url(device_id) || !device_id.startsWith("dev_")) {
    return apiError("PRECONDITION_FAILED", "device_id 不合法");
  }
  if (!isBase64Url(secret_hash, 40, 88)) {
    return apiError("PRECONDITION_FAILED", "secret_hash 不合法");
  }
  if (platform !== "macos" && platform !== "windows") {
    return apiError("PRECONDITION_FAILED", "platform 不合法");
  }
  if (typeof app_version !== "string" || app_version.trim() === "") {
    return apiError("PRECONDITION_FAILED", "app_version 不合法");
  }

  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  if (!(await bumpRateLimit(env.DB, `device-register:${ip}`, REGISTER_LIMIT_PER_HOUR, 3600_000))) {
    return apiError("RATE_LIMITED", "注册太频繁，稍后再试", { retryable: true });
  }

  const now = Date.now();
  const existing = await env.DB.prepare("SELECT * FROM devices WHERE id = ?")
    .bind(device_id)
    .first<Device>();

  let accountId: string;
  if (existing) {
    if (existing.revoked_at) {
      return apiError("FORBIDDEN", "这台设备已被停用", { reason: "device_revoked" });
    }
    if (existing.secret_hash !== secret_hash) {
      return apiError("PRECONDITION_FAILED", "设备凭据与原记录不一致", { reason: "device_mismatch" });
    }
    accountId = existing.account_id;
    await env.DB.prepare("UPDATE devices SET last_seen_at = ?, app_version = ? WHERE id = ?")
      .bind(now, app_version, device_id)
      .run();
  } else {
    accountId = randomId("acct_");
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO accounts (id, kind, status, created_at) VALUES (?, 'device', 'active', ?)",
      ).bind(accountId, now),
      env.DB.prepare(
        "INSERT INTO devices (id, account_id, secret_hash, platform, app_version, refresh_family, created_at, last_seen_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ).bind(device_id, accountId, secret_hash, platform, app_version, randomId("rf_"), now, now),
      env.DB.prepare(
        "INSERT INTO audit_log (at, account_id, action, detail) VALUES (?, ?, 'device.register', ?)",
      ).bind(now, accountId, JSON.stringify({ platform })),
    ]);
  }

  try {
    return json(await issueTokens(env, device_id, accountId));
  } catch {
    return apiError("INTERNAL", "签发令牌失败", { reason: "signing_unavailable" });
  }
}

async function refresh(request: Request, env: AuthEnv): Promise<Response> {
  let body: { refresh_token?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return apiError("PRECONDITION_FAILED", "请求体不是合法 JSON");
  }
  if (typeof body.refresh_token !== "string" || body.refresh_token.length === 0) {
    return apiError("PRECONDITION_FAILED", "refresh_token 缺失");
  }

  const hash = await sha256B64u(body.refresh_token);
  const row = await env.DB.prepare("SELECT * FROM refresh_tokens WHERE hash = ?")
    .bind(hash)
    .first<{ device_id: string; expires_at: number; used_at: number | null; revoked_at: number | null }>();

  if (!row) return apiError("UNAUTHENTICATED", "刷新令牌无效", { reason: "refresh_unknown" });

  const device = await env.DB.prepare("SELECT * FROM devices WHERE id = ?")
    .bind(row.device_id)
    .first<Device>();
  if (!device || device.revoked_at) {
    return apiError("FORBIDDEN", "这台设备已被停用", { reason: "device_revoked" });
  }

  // 已用过或已作废的令牌再次出现，只可能是被复制出去：整族作废。
  if (row.used_at !== null || row.revoked_at !== null) {
    await env.DB.prepare("UPDATE refresh_tokens SET revoked_at = ? WHERE device_id = ? AND revoked_at IS NULL")
      .bind(Date.now(), row.device_id)
      .run();
    return apiError("UNAUTHENTICATED", "刷新令牌已失效，请重新验证设备", {
      reason: "refresh_reused",
    });
  }

  if (row.expires_at <= Date.now()) {
    return apiError("UNAUTHENTICATED", "刷新令牌已过期", { reason: "refresh_expired" });
  }

  await env.DB.prepare("UPDATE refresh_tokens SET used_at = ? WHERE hash = ?")
    .bind(Date.now(), hash)
    .run();

  try {
    return json(await issueTokens(env, device.id, device.account_id));
  } catch {
    return apiError("INTERNAL", "签发令牌失败", { reason: "signing_unavailable" });
  }
}

/** 供其它端点复用：解析 Bearer token 并确认设备与账户仍然可用。 */
export async function authenticate(
  request: Request,
  maybeEnv: MaybeAuthEnv,
): Promise<{ accountId: string; deviceId: string } | Response> {
  if (!maybeEnv.DB) return apiError("INTERNAL", "服务还没准备好", { retryable: true, status: 503 });
  const env: AuthEnv = { DB: maybeEnv.DB, TOKEN_SIGNING_JWK: maybeEnv.TOKEN_SIGNING_JWK };
  const header = request.headers.get("authorization") ?? "";
  const token = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
  if (!token || !env.TOKEN_SIGNING_JWK) {
    return apiError("UNAUTHENTICATED", "需要先验证设备", { retryable: false });
  }

  const claims = await verifyAccessToken(env.TOKEN_SIGNING_JWK, token);
  if (!claims) return apiError("UNAUTHENTICATED", "登录已过期", { reason: "token_invalid" });

  const device = await env.DB.prepare("SELECT * FROM devices WHERE id = ?")
    .bind(claims.did)
    .first<Device>();
  if (!device || device.revoked_at || device.account_id !== claims.sub) {
    return apiError("FORBIDDEN", "这台设备已被停用", { reason: "device_revoked" });
  }
  const account = await env.DB.prepare("SELECT status FROM accounts WHERE id = ?")
    .bind(claims.sub)
    .first<{ status: string }>();
  if (!account) return apiError("UNAUTHENTICATED", "账户不存在", { reason: "account_missing" });
  if (account.status !== "active") {
    return apiError("FORBIDDEN", "账户已被停用", { reason: "account_blocked" });
  }

  return { accountId: claims.sub, deviceId: claims.did };
}

export function isResponse(value: unknown): value is Response {
  return value instanceof Response;
}

export async function handleAuth(
  request: Request,
  maybeEnv: MaybeAuthEnv,
): Promise<Response | null> {
  const { pathname } = new URL(request.url);
  const post = request.method === "POST";
  const matched =
    (pathname === "/v1/auth/device" && post) || (pathname === "/v1/auth/refresh" && post);
  if (!matched) return null;
  if (!maybeEnv.DB) return apiError("INTERNAL", "服务还没准备好", { retryable: true, status: 503 });

  const env: AuthEnv = { DB: maybeEnv.DB, TOKEN_SIGNING_JWK: maybeEnv.TOKEN_SIGNING_JWK };
  if (pathname === "/v1/auth/device") return register(request, env);
  return refresh(request, env);
}
