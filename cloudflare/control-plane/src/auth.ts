// 设备令牌（§19.2）：静默注册、签发、刷新与重放检测。
// 只存 sha256(device_secret) 与 refresh 的哈希；任何明文凭据都不落库、不进日志。

import { apiError, json } from "./lib/http";
import { randomId, sha256B64u, signAccessToken, verifyAccessToken, b64u, randomBytes } from "./lib/crypto";

const ACCESS_TTL_SECONDS = 15 * 60;
const REFRESH_TTL_SECONDS = 30 * 24 * 3600;
const REGISTER_LIMIT_PER_HOUR = 10;
/**
 * 轮换宽限：服务端已换发、客户端还没来得及落盘（崩溃、双开、响应丢失）时，
 * 旧 refresh 在宽限内再出现一次不算重放。超出宽限、或出现比它更早的令牌，
 * 仍然整族作废——宽限只覆盖「最近一次轮换」，不是关掉重放检测。
 */
const REFRESH_ROTATION_GRACE_MS = 60_000;

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
  /** 登录态：device = 匿名设备账户，email = 邮箱账户。 */
  account_kind: string;
  email: string | null;
}

interface RefreshRow {
  hash: string;
  device_id: string;
  expires_at: number;
  used_at: number | null;
  revoked_at: number | null;
  redeemed_count: number;
}

function isBase64Url(value: unknown, min = 20, max = 128): value is string {
  return typeof value === "string" && value.length >= min && value.length <= max && /^[A-Za-z0-9_-]+$/.test(value);
}

export async function bumpRateLimit(db: D1Database, key: string, limit: number, windowMs: number): Promise<boolean> {
  const now = Date.now();
  const changed = (result: unknown) =>
    Number((result as { meta?: { changes?: number } })?.meta?.changes ?? 0);

  // 三条单语句守卫，不做「读行 → 判断 → 写」：并发请求不会各自读到同一份旧计数。
  // 1) 窗口内且还有额度：原子 +1。
  const fresh = await db
    .prepare(
      "UPDATE rate_limits SET count = count + 1 WHERE key = ? AND window_start > ? AND count < ?",
    )
    .bind(key, now - windowMs, limit)
    .run();
  if (changed(fresh) === 1) return true;

  // 2) 窗口已过期：原子重置。
  const rolled = await db
    .prepare(
      "UPDATE rate_limits SET window_start = ?, count = 1 WHERE key = ? AND window_start <= ?",
    )
    .bind(now, key, now - windowMs)
    .run();
  if (changed(rolled) === 1) return true;

  // 3) 首次出现：唯一键冲突说明窗口内已到上限，拒绝。
  const created = await db
    .prepare("INSERT OR IGNORE INTO rate_limits (key, window_start, count) VALUES (?, ?, 1)")
    .bind(key, now)
    .run();
  return changed(created) === 1;
}

/** 签发一整套令牌。`amr` 记的是「这次是怎么验的」，与账户本身是哪种无关。 */
export async function issueTokens(
  env: AuthEnv,
  deviceId: string,
  accountId: string,
  amr: "device" | "email" = "device",
): Promise<TokenBundle> {
  if (!env.TOKEN_SIGNING_JWK) throw new Error("missing TOKEN_SIGNING_JWK");

  const account = await env.DB.prepare("SELECT kind, email FROM accounts WHERE id = ?")
    .bind(accountId)
    .first<{ kind: string; email: string | null }>();
  const accountKind = account?.kind ?? "device";

  const nowSeconds = Math.floor(Date.now() / 1000);
  const accessExpires = nowSeconds + ACCESS_TTL_SECONDS;
  const accessToken = await signAccessToken(env.TOKEN_SIGNING_JWK, {
    sub: accountId,
    did: deviceId,
    iat: nowSeconds,
    exp: accessExpires,
    jti: randomId("jti_", 12),
    kind: accountKind,
    amr,
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
    account_kind: accountKind,
    email: account?.email ?? null,
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

/** 同一设备上是否有比 `usedAt` 更晚被用掉的令牌：有就说明这一枚是更早的旧令牌。 */
async function hasNewerUsedToken(env: AuthEnv, deviceId: string, usedAt: number): Promise<boolean> {
  const row = await env.DB.prepare(
    "SELECT hash FROM refresh_tokens WHERE device_id = ? AND used_at IS NOT NULL AND used_at > ? LIMIT 1",
  )
    .bind(deviceId, usedAt)
    .first<{ hash: string }>();
  return row !== null;
}

/**
 * 宽限期赎回：刚被轮换掉、但客户端可能没落盘的旧令牌再出现时，补发一套令牌，
 * 不再整族作废。只认「最近一次轮换」且在 `REFRESH_ROTATION_GRACE_MS` 内；
 * 不满足条件返回 `null`，由调用方按重放处理。
 *
 * **一枚旧令牌只兑现一次**（`redeemed_count`）。双开时两路请求各补发一套等价于
 * 两枚各自用掉一次，但同一枚令牌被第三次拿来兑换就必须整族作废——否则宽限
 * 会变成「60 秒内无限续命」，重放检测等于关掉。
 *
 * 只存哈希，拿不回上一次签发的那串明文，所以这里补发的是新的一套；
 * 同族在宽限内可能短暂存在两条有效链。
 */
async function redeemWithinGrace(
  env: AuthEnv,
  row: RefreshRow,
  device: Device,
): Promise<Response | null> {
  if (row.revoked_at !== null || row.used_at === null) return null;
  const now = Date.now();
  if (now - row.used_at > REFRESH_ROTATION_GRACE_MS) return null;
  if (row.expires_at <= now) return null;
  if (await hasNewerUsedToken(env, row.device_id, row.used_at)) return null;

  // 条件更新就是限次的锁：并发两路只有一路能把计数从 0 加到 1，另一路拿到 0 行。
  const claimed = await env.DB.prepare(
    "UPDATE refresh_tokens SET redeemed_count = redeemed_count + 1 WHERE hash = ? AND redeemed_count < 1 AND revoked_at IS NULL",
  )
    .bind(row.hash)
    .run();
  if (Number((claimed as { meta?: { changes?: number } }).meta?.changes ?? 0) !== 1) return null;

  try {
    return json(await issueTokens(env, device.id, device.account_id));
  } catch {
    // 签发失败不该吃掉这一次宽限：退回计数，下次还能再试。
    await env.DB.prepare(
      "UPDATE refresh_tokens SET redeemed_count = redeemed_count - 1 WHERE hash = ? AND redeemed_count > 0",
    )
      .bind(row.hash)
      .run()
      .catch(() => undefined);
    return apiError("INTERNAL", "签发令牌失败", { reason: "signing_unavailable" });
  }
}

/** 重放处理：整族作废，用户必须重新验证设备。 */
async function revokeFamily(env: AuthEnv, deviceId: string): Promise<Response> {
  await env.DB.prepare("UPDATE refresh_tokens SET revoked_at = ? WHERE device_id = ? AND revoked_at IS NULL")
    .bind(Date.now(), deviceId)
    .run();
  return apiError("UNAUTHENTICATED", "刷新令牌已失效，请重新验证设备", {
    reason: "refresh_reused",
  });
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
    .first<RefreshRow>();

  if (!row) return apiError("UNAUTHENTICATED", "刷新令牌无效", { reason: "refresh_unknown" });

  const device = await env.DB.prepare("SELECT * FROM devices WHERE id = ?")
    .bind(row.device_id)
    .first<Device>();
  if (!device || device.revoked_at) {
    return apiError("FORBIDDEN", "这台设备已被停用", { reason: "device_revoked" });
  }

  // 已作废的令牌永不放行：只可能是被复制出去，整族作废。
  if (row.revoked_at !== null) return revokeFamily(env, row.device_id);

  // 已被轮换掉、但客户端没落盘（崩溃 / 双开 / 响应丢失）：宽限内补发一套，
  // 不把用户踢下线；超出宽限或更早的令牌仍按重放处理。
  if (row.used_at !== null) {
    const redeemed = await redeemWithinGrace(env, row, device);
    return redeemed ?? revokeFamily(env, row.device_id);
  }

  if (row.expires_at <= Date.now()) {
    return apiError("UNAUTHENTICATED", "刷新令牌已过期", { reason: "refresh_expired" });
  }

  const usedAt = Date.now();
  // 条件更新就是这次轮换的锁：两个并发请求只有一个能把 used_at 从 NULL 改掉，
  // 另一个拿到 0 行。抢不到不代表一定是攻击——双开就是两个实例同时用同一枚
  // 令牌——所以先看宽限，抢不到且不满足宽限才按重放处理。
  const claimed = await env.DB.prepare(
    "UPDATE refresh_tokens SET used_at = ? WHERE hash = ? AND used_at IS NULL AND revoked_at IS NULL",
  )
    .bind(usedAt, hash)
    .run();
  if (Number((claimed as { meta?: { changes?: number } }).meta?.changes ?? 0) !== 1) {
    const current = await env.DB.prepare("SELECT * FROM refresh_tokens WHERE hash = ?")
      .bind(hash)
      .first<RefreshRow>();
    const redeemed = current ? await redeemWithinGrace(env, current, device) : null;
    return redeemed ?? revokeFamily(env, row.device_id);
  }

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
): Promise<{ accountId: string; deviceId: string; kind: string } | Response> {
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
  const account = await env.DB.prepare("SELECT status, kind, merged_into FROM accounts WHERE id = ?")
    .bind(claims.sub)
    .first<{ status: string; kind: string; merged_into: string | null }>();
  if (!account) return apiError("UNAUTHENTICATED", "账户不存在", { reason: "account_missing" });
  // 已并入邮箱账户的旧匿名账户：留下的令牌最多再活 15 分钟，但不该续命。
  if (account.merged_into) return apiError("UNAUTHENTICATED", "账户已合并", { reason: "account_merged" });
  if (account.status !== "active") {
    return apiError("FORBIDDEN", "账户已被停用", { reason: "account_blocked" });
  }

  return { accountId: claims.sub, deviceId: claims.did, kind: account.kind };
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
