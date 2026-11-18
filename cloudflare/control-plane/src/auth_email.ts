// 邮箱验证码登录（docs/design/login-and-payment.md §2）。
// 验证码只存 sha256(code + ":" + email)；邮箱与验证码都不进日志。

import {
  authenticate,
  bumpRateLimit,
  isResponse,
  issueTokens,
  type MaybeAuthEnv,
} from "./auth";
import { apiError, json } from "./lib/http";
import { randomId, sha256B64u } from "./lib/crypto";
import { sendVerificationCodeEmail, type EmailEnv } from "./lib/email";

const CODE_TTL_MS = 300_000;
const COOLDOWN_MS = 60_000;
const SEND_PER_IP_PER_HOUR = 10;
const VERIFY_PER_IP_PER_HOUR = 20;
const MAX_ATTEMPTS = 3;

export interface EmailAuthEnv extends MaybeAuthEnv, EmailEnv {}

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

function normaliseEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  if (email.length < 5 || email.length > 254) return null;
  return EMAIL_RE.test(email) ? email : null;
}

function generateCode(): string {
  const buffer = new Uint32Array(1);
  crypto.getRandomValues(buffer);
  return String(buffer[0] % 1_000_000).padStart(6, "0");
}

/** 定长十六进制/Base64 URL 摘要的等值比较，不提前返回。 */
function isBase64Url(value: unknown, min = 20, max = 128): value is string {
  return typeof value === "string" && value.length >= min && value.length <= max && /^[A-Za-z0-9_-]+$/.test(value);
}

/**
 * 验证码没被消费掉：区分「码不对」「已用过 / 过期」「错满」。
 * 计数只走一条带守卫的 UPDATE（`attempts < 上限`），并发下不会越过 3 次。
 */
async function rejectCode(db: D1Database, email: string, now: number): Promise<Response> {
  const row = await db
    .prepare("SELECT code_hash, expires_at, attempts FROM email_codes WHERE email = ?")
    .bind(email)
    .first<{ code_hash: string; expires_at: number; attempts: number }>();
  if (!row) {
    // 行不在不一定是过期：最常见的是一次成功的校验已经把这一行消费掉了。
    return apiError("PRECONDITION_FAILED", "验证码已经用过了，重新发一次", { reason: "code_used" });
  }
  if (Number(row.expires_at) <= now) {
    await db.prepare("DELETE FROM email_codes WHERE email = ?").bind(email).run();
    return apiError("PRECONDITION_FAILED", "验证码已过期，重新发一次", { reason: "code_expired" });
  }
  if (Number(row.attempts) >= MAX_ATTEMPTS) {
    await db.prepare("DELETE FROM email_codes WHERE email = ?").bind(email).run();
    return apiError("PRECONDITION_FAILED", "验证码已作废，重新发一次", { reason: "too_many_attempts" });
  }

  await db
    .prepare("UPDATE email_codes SET attempts = attempts + 1 WHERE email = ? AND attempts < ? AND expires_at > ?")
    .bind(email, MAX_ATTEMPTS, now)
    .run();
  // 计数以写后的值为准：并发下别人可能同时记了一笔。
  const after = await db
    .prepare("SELECT attempts FROM email_codes WHERE email = ?")
    .bind(email)
    .first<{ attempts: number }>();
  const remaining = Math.max(0, MAX_ATTEMPTS - Number(after?.attempts ?? Number(row.attempts) + 1));
  return apiError("PRECONDITION_FAILED", remaining > 0 ? "验证码不对" : "验证码已作废，重新发一次", {
    retryable: remaining > 0,
    reason: remaining > 0 ? "code_invalid" : "too_many_attempts",
    details: { attempts_remaining: remaining },
  });
}

async function start(request: Request, env: EmailAuthEnv): Promise<Response> {
  const db = env.DB!;
  let body: { email?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return apiError("PRECONDITION_FAILED", "请求体不是合法 JSON", { reason: "email_invalid" });
  }

  const email = normaliseEmail(body.email);
  if (!email) return apiError("PRECONDITION_FAILED", "邮箱格式不对", { reason: "email_invalid" });

  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  if (!(await bumpRateLimit(db, `email-send:${ip}`, SEND_PER_IP_PER_HOUR, 3_600_000))) {
    return apiError("RATE_LIMITED", "发得太频繁了，一小时后再试", {
      retryable: true,
      reason: "email_rate_limited",
    });
  }

  const now = Date.now();
  const existing = await db
    .prepare("SELECT created_at FROM email_codes WHERE email = ?")
    .bind(email)
    .first<{ created_at: number }>();
  if (existing && now - existing.created_at < COOLDOWN_MS) {
    const retryAfter = Math.ceil((COOLDOWN_MS - (now - existing.created_at)) / 1000);
    console.log(`[auth-email] start result=cooldown retry_after=${retryAfter}`);
    return apiError("RATE_LIMITED", `等一下再发，${retryAfter} 秒后可以重发`, {
      retryable: true,
      reason: "email_cooldown",
      details: { retry_after_seconds: retryAfter },
    });
  }

  const code = generateCode();
  const codeHash = await sha256B64u(`${code}:${email}`);
  await db
    .prepare(
      "INSERT INTO email_codes (email, code_hash, expires_at, attempts, created_at, last_ip) " +
        "VALUES (?, ?, ?, 0, ?, ?) " +
        "ON CONFLICT(email) DO UPDATE SET code_hash = excluded.code_hash, expires_at = excluded.expires_at, " +
        "attempts = 0, created_at = excluded.created_at, last_ip = excluded.last_ip",
    )
    .bind(email, codeHash, now + CODE_TTL_MS, now, ip)
    .run();

  try {
    await sendVerificationCodeEmail(env, email, code);
  } catch (error) {
    // 发信失败不向调用方暴露「这个邮箱能不能收到」，只记原因码。
    console.warn(`[auth-email] send_failed reason=${(error as Error).message}`);
  }

  console.log("[auth-email] start result=sent");
  return json({ sent: true, cooldown_seconds: COOLDOWN_MS / 1000 });
}

interface DeviceRow {
  id: string;
  account_id: string;
  secret_hash: string;
  revoked_at: number | null;
}

async function verify(request: Request, env: EmailAuthEnv): Promise<Response> {
  const db = env.DB!;
  let body: {
    email?: unknown;
    code?: unknown;
    device_id?: unknown;
    secret_hash?: unknown;
    platform?: unknown;
    app_version?: unknown;
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return apiError("PRECONDITION_FAILED", "请求体不是合法 JSON", { reason: "email_invalid" });
  }

  const email = normaliseEmail(body.email);
  if (!email) return apiError("PRECONDITION_FAILED", "邮箱格式不对", { reason: "email_invalid" });
  if (typeof body.code !== "string" || !/^\d{6}$/.test(body.code.trim())) {
    return apiError("PRECONDITION_FAILED", "验证码是 6 位数字", { reason: "code_invalid", retryable: true });
  }
  const code = body.code.trim();
  const deviceId = body.device_id;
  const secretHash = body.secret_hash;
  if (!isBase64Url(deviceId) || !deviceId.startsWith("dev_")) {
    return apiError("PRECONDITION_FAILED", "device_id 不合法", { reason: "device_invalid" });
  }
  if (!isBase64Url(secretHash, 40, 88)) {
    return apiError("PRECONDITION_FAILED", "secret_hash 不合法", { reason: "device_invalid" });
  }

  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  if (!(await bumpRateLimit(db, `email-verify:${ip}`, VERIFY_PER_IP_PER_HOUR, 3_600_000))) {
    return apiError("RATE_LIMITED", "验证太频繁了，一小时后再试", {
      retryable: true,
      reason: "email_rate_limited",
    });
  }

  const now = Date.now();

  // ── 设备证明（必须在消费验证码之前）────────────────────────────────────
  // 设备被停用或用错凭据时，如果先消费验证码，用户会被白烧一个码并卡 60 秒重发。
  // 校验失败不消费、不计数。
  const device = await db.prepare("SELECT * FROM devices WHERE id = ?").bind(deviceId).first<DeviceRow & Record<string, unknown>>();
  if (device?.revoked_at) {
    return apiError("FORBIDDEN", "这台设备已被停用", { reason: "device_revoked" });
  }
  if (device && device.secret_hash !== secretHash) {
    return apiError("PRECONDITION_FAILED", "设备凭据与原记录不一致", { reason: "device_mismatch" });
  }

  const submitted = await sha256B64u(`${code}:${email}`);
  // 消费验证码是一条带全部守卫的 DELETE：并发请求里只有一个能删掉这一行，
  // 「先读 → 比对 → 再删」会让同一个码被用两次、也绕过 3 次上限。
  const consumed = await db
    .prepare(
      "DELETE FROM email_codes WHERE email = ? AND code_hash = ? AND expires_at > ? AND attempts < ?",
    )
    .bind(email, submitted, now, MAX_ATTEMPTS)
    .run();
  if (Number((consumed as { meta?: { changes?: number } }).meta?.changes ?? 0) !== 1) {
    return rejectCode(db, email, now);
  }

  // ── 邮箱账户 ────────────────────────────────────────────────────────────
  const existingAccount = await db
    .prepare("SELECT id, kind FROM accounts WHERE email = ?")
    .bind(email)
    .first<{ id: string; kind: string }>();

  let emailAccountId = existingAccount?.id ?? null;
  const statements: D1PreparedStatement[] = [];
  if (!emailAccountId) {
    // 一个邮箱只能对应一个账户：靠 accounts_email 唯一索引兜住并发，插入被忽略时重新读出真实 id。
    const candidate = randomId("acct_");
    await db
      .prepare("INSERT OR IGNORE INTO accounts (id, kind, email, status, created_at) VALUES (?, 'email', ?, 'active', ?)")
      .bind(candidate, email, now)
      .run();
    const created = await db
      .prepare("SELECT id, kind FROM accounts WHERE email = ?")
      .bind(email)
      .first<{ id: string; kind: string }>();
    emailAccountId = created?.id ?? candidate;
  }

  let previousAccountId = device?.account_id ?? null;
  let merged = false;

  if (previousAccountId && previousAccountId !== emailAccountId) {
    const previous = await db
      .prepare("SELECT kind, email FROM accounts WHERE id = ?")
      .bind(previousAccountId)
      .first<{ kind: string; email: string | null }>();
    if (previous?.kind === "email" && previous.email !== email) {
      // 设备已经属于另一个邮箱账户：不做隐式换绑，否则 A 的服务器会并进 B。
      return apiError("PRECONDITION_FAILED", "这台设备已经登录了另一个账户，先退出当前账户", {
        reason: "account_conflict",
      });
    }
    if (previous && previous.kind !== "email") {
      merged = true;
      statements.push(
        db.prepare("UPDATE devices SET account_id = ? WHERE id = ?").bind(emailAccountId, deviceId),
        db.prepare("UPDATE orders SET account_id = ? WHERE account_id = ?").bind(emailAccountId, previousAccountId),
        db.prepare("UPDATE servers SET account_id = ? WHERE account_id = ?").bind(emailAccountId, previousAccountId),
        db
          .prepare("UPDATE accounts SET merged_into = ?, status = 'disabled' WHERE id = ?")
          .bind(emailAccountId, previousAccountId),
        db.prepare("UPDATE refresh_tokens SET revoked_at = ? WHERE device_id = ?").bind(now, deviceId),
        db
          .prepare("INSERT INTO audit_log (at, account_id, action, detail) VALUES (?, ?, 'account.merge', ?)")
          .bind(now, emailAccountId, JSON.stringify({ from: previousAccountId })),
      );
    }
  } else if (!previousAccountId) {
    // 设备还没注册过：登录顺带完成注册，直接落到邮箱账户，不制造一个立刻作废的匿名账户。
    const platform = body.platform === "windows" ? "windows" : "macos";
    const appVersion = typeof body.app_version === "string" && body.app_version.trim() ? body.app_version.trim() : "unknown";
    statements.push(
      db
        .prepare(
          "INSERT INTO devices (id, account_id, secret_hash, platform, app_version, refresh_family, created_at, last_seen_at) " +
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(deviceId, emailAccountId, secretHash, platform, appVersion, randomId("rf_"), now, now),
    );
  }

  statements.push(
    db
      .prepare("INSERT INTO audit_log (at, account_id, action, detail) VALUES (?, ?, 'account.login', ?)")
      .bind(now, emailAccountId, JSON.stringify({ merged })),
  );
  await db.batch(statements);

  try {
    const tokens = await issueTokens({ DB: db, TOKEN_SIGNING_JWK: env.TOKEN_SIGNING_JWK }, deviceId, emailAccountId, "email");
    console.log(`[auth-email] verify ok account=${emailAccountId} merged=${merged}`);
    return json(tokens);
  } catch {
    return apiError("INTERNAL", "签发令牌失败", { reason: "signing_unavailable" });
  }
}

async function logout(request: Request, env: EmailAuthEnv): Promise<Response> {
  const identity = await authenticate(request, env);
  if (isResponse(identity)) return identity;
  const db = env.DB!;

  const now = Date.now();
  const anonymousId = randomId("acct_");
  await db.batch([
    db.prepare("UPDATE refresh_tokens SET revoked_at = ? WHERE device_id = ? AND revoked_at IS NULL").bind(now, identity.deviceId),
    db.prepare("INSERT INTO accounts (id, kind, status, created_at) VALUES (?, 'device', 'active', ?)").bind(anonymousId, now),
    db.prepare("UPDATE devices SET account_id = ? WHERE id = ?").bind(anonymousId, identity.deviceId),
    db
      .prepare("INSERT INTO audit_log (at, account_id, action, detail) VALUES (?, ?, 'account.logout', ?)")
      .bind(now, identity.accountId, JSON.stringify({ to: anonymousId })),
  ]);

  try {
    return json(await issueTokens({ DB: db, TOKEN_SIGNING_JWK: env.TOKEN_SIGNING_JWK }, identity.deviceId, anonymousId, "device"));
  } catch {
    return apiError("INTERNAL", "签发令牌失败", { reason: "signing_unavailable" });
  }
}

export async function handleEmailAuth(
  request: Request,
  maybeEnv: EmailAuthEnv,
): Promise<Response | null> {
  const { pathname } = new URL(request.url);
  const post = request.method === "POST";
  const matched =
    pathname === "/v1/auth/email/start" ||
    pathname === "/v1/auth/email/verify" ||
    pathname === "/v1/auth/logout";
  if (!matched || !post) return null;
  if (!maybeEnv.DB) return apiError("INTERNAL", "服务还没准备好", { retryable: true, status: 503 });

  if (pathname === "/v1/auth/email/start") return start(request, maybeEnv);
  if (pathname === "/v1/auth/email/verify") return verify(request, maybeEnv);
  return logout(request, maybeEnv);
}
