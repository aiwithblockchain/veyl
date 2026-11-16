// 邮箱验证码登录（login-and-payment.md §2）：发码、冷却、失败上限、合并、登出。
import { afterEach, describe, expect, it, vi } from "vitest";

import { handleEmailAuth } from "../src/auth_email";
import { FakeD1 } from "./helpers/fakeD1";

const EMAIL = "buyer@example.com";
const DEVICE = "dev_signin000000000000";
const DEVICE_HASH = "a".repeat(43);

async function signingJwk(): Promise<string> {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  return JSON.stringify(await crypto.subtle.exportKey("jwk", pair.privateKey));
}

async function makeEnv(db: FakeD1, ip = "203.0.113.1") {
  return {
    DB: db as unknown as D1Database,
    TOKEN_SIGNING_JWK: await signingJwk(),
    RESEND_API_KEY: "re_test",
    RESEND_FROM_EMAIL: "Veyl <no-reply@dessage.xyz>",
    ENVIRONMENT: "dev",
    ip,
  };
}

type TestEnv = Awaited<ReturnType<typeof makeEnv>>;

/** 拦住 Resend，把验证码从邮件正文里取出来（真实环境里这当然不该被读到）。 */
function stubEmail(): { code: () => string } {
  let latest = "";
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).includes("api.resend.com")) {
        const body = JSON.parse(String(init?.body ?? "{}")) as { html?: string };
        latest = /(\d{6})/.exec(body.html ?? "")?.[1] ?? "";
        return new Response(JSON.stringify({ id: "email_1" }), { status: 200 });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    }),
  );
  return { code: () => latest };
}

function startRequest(env: TestEnv, email = EMAIL) {
  return new Request("https://example.com/v1/auth/email/start", {
    method: "POST",
    headers: { "CF-Connecting-IP": env.ip },
    body: JSON.stringify({ email }),
  });
}

function verifyRequest(env: TestEnv, code: string, overrides: Record<string, unknown> = {}) {
  return new Request("https://example.com/v1/auth/email/verify", {
    method: "POST",
    headers: { "CF-Connecting-IP": env.ip },
    body: JSON.stringify({
      email: EMAIL,
      code,
      device_id: DEVICE,
      secret_hash: DEVICE_HASH,
      platform: "macos",
      ...overrides,
    }),
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("发验证码", () => {
  it("发成功后 60 秒内重发被冷却挡住", async () => {
    const db = new FakeD1();
    const env = await makeEnv(db);
    stubEmail();

    const first = await handleEmailAuth(startRequest(env), env as never);
    expect(first?.status).toBe(200);
    expect(((await first!.json()) as { sent: boolean }).sent).toBe(true);

    const second = await handleEmailAuth(startRequest(env), env as never);
    expect(second?.status).toBe(429);
    const body = (await second!.json()) as { details: { reason: string; retry_after_seconds: number } };
    expect(body.details.reason).toBe("email_cooldown");
    expect(body.details.retry_after_seconds).toBeGreaterThan(0);
  });

  it("邮箱格式不对直接拒绝", async () => {
    const db = new FakeD1();
    const env = await makeEnv(db);
    stubEmail();
    const res = await handleEmailAuth(startRequest(env, "not-an-email"), env as never);
    expect(res?.status).toBe(409);
    const body = (await res!.json()) as { details: { reason: string } };
    expect(body.details.reason).toBe("email_invalid");
  });
});

describe("校验验证码", () => {
  it("登录成功会把设备并入邮箱账户并回 email 令牌", async () => {
    const db = new FakeD1();
    const env = await makeEnv(db);
    const mail = stubEmail();

    // 设备先以匿名身份存在，服务器挂在这个匿名账户下。
    db.rows("accounts").push({ id: "acct_anon", kind: "device", email: null, status: "active", merged_into: null, created_at: 0 });
    db.rows("devices").push({
      id: DEVICE,
      account_id: "acct_anon",
      secret_hash: DEVICE_HASH,
      platform: "macos",
      app_version: "1.0.0",
      refresh_family: "rf",
      created_at: 0,
      last_seen_at: 0,
      revoked_at: null,
    });
    db.rows("orders").push({ id: "ord_old", account_id: "acct_anon" });

    await handleEmailAuth(startRequest(env), env as never);
    const res = await handleEmailAuth(verifyRequest(env, mail.code()), env as never);
    expect(res?.status).toBe(200);
    const tokens = (await res!.json()) as {
      account_id: string;
      account_kind: string;
      email: string;
      device_id: string;
    };
    expect(tokens.account_kind).toBe("email");
    expect(tokens.email).toBe(EMAIL);
    expect(tokens.device_id).toBe(DEVICE);

    const emailAccount = db.rows("accounts").find((row) => row.kind === "email")!;
    expect(tokens.account_id).toBe(emailAccount.id);
    // 设备与订单都搬到了邮箱账户下，旧匿名账户作废。
    expect(db.rows("devices")[0].account_id).toBe(emailAccount.id);
    expect(db.rows("orders")[0].account_id).toBe(emailAccount.id);
    expect(db.rows("accounts").find((row) => row.id === "acct_anon")!.merged_into).toBe(emailAccount.id);
  });

  it("验证码错误返回剩余次数，错满三次作废", async () => {
    const db = new FakeD1();
    const env = await makeEnv(db);
    const mail = stubEmail();
    await handleEmailAuth(startRequest(env), env as never);
    const code = mail.code();
    const wrong = code === "000000" ? "111111" : "000000";

    const first = await handleEmailAuth(verifyRequest(env, wrong), env as never);
    expect(first?.status).toBe(409);
    expect(((await first!.json()) as { details: { attempts_remaining: number } }).details.attempts_remaining).toBe(2);

    await handleEmailAuth(verifyRequest(env, wrong), env as never);
    await handleEmailAuth(verifyRequest(env, wrong), env as never);

    // 第 4 次即使输对也不能再登录。
    const after = await handleEmailAuth(verifyRequest(env, code), env as never);
    expect(after?.status).toBe(409);
    const body = (await after!.json()) as { details: { reason: string } };
    expect(body.details.reason).toBe("too_many_attempts");
  });

  it("同一邮箱第二次登录复用同一个账户，不会建出第二个", async () => {
    const db = new FakeD1();
    const env = await makeEnv(db);
    const mail = stubEmail();

    await handleEmailAuth(startRequest(env), env as never);
    const first = (await (await handleEmailAuth(verifyRequest(env, mail.code()), env as never))!.json()) as {
      account_id: string;
    };

    // 绕过 60 秒冷却，再走一次完整登录。
    db.rows("email_codes").forEach((row) => {
      row.created_at = Number(row.created_at) - 120_000;
    });
    await handleEmailAuth(startRequest(env), env as never);
    const second = (await (await handleEmailAuth(verifyRequest(env, mail.code()), env as never))!.json()) as {
      account_id: string;
    };

    expect(second.account_id).toBe(first.account_id);
    expect(db.rows("accounts").filter((row) => row.kind === "email")).toHaveLength(1);
  });

  it("设备已登录另一个邮箱时拒绝隐式换绑", async () => {
    const db = new FakeD1();
    const env = await makeEnv(db);
    const mail = stubEmail();

    db.rows("accounts").push({
      id: "acct_other",
      kind: "email",
      email: "someone@example.com",
      status: "active",
      merged_into: null,
      created_at: 0,
    });
    db.rows("devices").push({
      id: DEVICE,
      account_id: "acct_other",
      secret_hash: DEVICE_HASH,
      platform: "macos",
      app_version: "1.0.0",
      refresh_family: "rf",
      created_at: 0,
      last_seen_at: 0,
      revoked_at: null,
    });

    await handleEmailAuth(startRequest(env), env as never);
    const res = await handleEmailAuth(verifyRequest(env, mail.code()), env as never);
    expect(res?.status).toBe(409);
    const body = (await res!.json()) as { details: { reason: string } };
    expect(body.details.reason).toBe("account_conflict");
  });
});
