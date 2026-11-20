// 环境隔离的硬约束：生产入口不含任何 /v1/debug/*，且三处写路径在 ENVIRONMENT 缺失时一律拒绝。
import { afterEach, describe, expect, it, vi } from "vitest";

import prodWorker, { route } from "../src/index";
import devWorker from "../src/dev";
import { startTopupSession } from "../src/topups";
import { handleOrders } from "../src/orders";
import { handleServers } from "../src/servers";
import { sealSecret, signAccessToken } from "../src/lib/crypto";
import { FakeD1 } from "./helpers/fakeD1";

const ACCOUNT = "acct_envtest0000000000000";
const DEVICE = "dev_envtest00000000000000";
const SERVER = "srv_envtest0000000000000";
const ENC_KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

function ctx(): ExecutionContext {
  return { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
}

function debugRequest(path = "/v1/debug/account"): Request {
  return new Request(`https://control-plane.test${path}`);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("生产入口与 /v1/debug/*（物理不可达）", () => {
  // 这些断言不依赖 ENVIRONMENT 的取值：路由根本不在生产包里。
  for (const environment of ["production", "dev", "test", undefined]) {
    it(`ENVIRONMENT=${String(environment)} 时仍是 404`, async () => {
      const env = { ENVIRONMENT: environment } as never;
      for (const path of ["/v1/debug/account", "/v1/debug/billing", "/v1/debug/do-scopes"]) {
        const res = await prodWorker.fetch(debugRequest(path), env, ctx());
        expect(res.status).toBe(404);
        expect(await res.json()).toMatchObject({ ok: false, error: "not_found" });
      }
    });
  }
});

describe("dev 入口", () => {
  it("dev 环境装配了调试路由：没有 D1 时返回 db_unavailable", async () => {
    const res = await devWorker.fetch(
      debugRequest("/v1/debug/account?email=a@b.c"),
      { ENVIRONMENT: "dev" } as never,
      ctx(),
    );
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ ok: false, error: "db_unavailable" });
  });

  it("非 dev 环境即使跑在 dev 入口上，调试路由也不生效", async () => {
    const res = await devWorker.fetch(
      debugRequest("/v1/debug/account?email=a@b.c"),
      { ENVIRONMENT: "production" } as never,
      ctx(),
    );
    expect(res.status).toBe(404);
  });

  it("其余请求原样交给生产入口", async () => {
    const res = await route(new Request("https://control-plane.test/health"), {
      ENVIRONMENT: "dev",
    } as never);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, service: "veyl-control-plane" });
  });
});

describe("ENVIRONMENT 缺失时写路径必须拒绝", () => {
  it("fake 充值：只有明确的 dev 才允许，变量缺失直接拒绝", async () => {
    const db = new FakeD1();
    db.rows("accounts").push({
      id: ACCOUNT,
      kind: "email",
      email: "buyer@example.com",
      status: "active",
      created_at: 0,
      balance_cents: 0,
    });
    const base = {
      DB: db as unknown as D1Database,
      DODO_TOPUP_PRODUCT_IDS: JSON.stringify({ "1000": "pdt_test_product_0001" }),
    };

    const missing = await startTopupSession({ ...base } as never, {
      accountId: ACCOUNT,
      email: "buyer@example.com",
      cents: 1000,
      mode: "fake",
    });
    expect(missing).toMatchObject({ ok: false, reason: "fake_not_allowed" });

    const typo = await startTopupSession({ ...base, ENVIRONMENT: "prod" } as never, {
      accountId: ACCOUNT,
      email: "buyer@example.com",
      cents: 1000,
      mode: "fake",
    });
    expect(typo).toMatchObject({ ok: false, reason: "fake_not_allowed" });

    const dev = await startTopupSession({ ...base, ENVIRONMENT: "dev" } as never, {
      accountId: ACCOUNT,
      email: "buyer@example.com",
      cents: 1000,
      mode: "fake",
    });
    expect(dev).toMatchObject({ ok: true, checkoutUrl: null, balanceAfterCents: 1000 });
  });

  it("匿名账户下单：ENVIRONMENT 缺失时按生产处理，要求登录", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const href = String(input);
        if (href.includes("/regions")) {
          return new Response(
            JSON.stringify({ regions: [{ slug: "sgp1", name: "Singapore 1", available: true }] }),
            { status: 200 },
          );
        }
        return new Response(
          JSON.stringify({
            sizes: [
              {
                slug: "s-1vcpu-1gb",
                memory: 1024,
                vcpus: 1,
                price_hourly: 0.00893,
                price_monthly: 6,
                transfer: 1,
                regions: ["sgp1"],
              },
            ],
          }),
          { status: 200 },
        );
      }),
    );

    const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
      "sign",
      "verify",
    ])) as CryptoKeyPair;
    const jwk = JSON.stringify(await crypto.subtle.exportKey("jwk", pair.privateKey));

    const db = new FakeD1();
    db.rows("accounts").push({ id: ACCOUNT, kind: "anonymous", status: "active" });
    db.rows("devices").push({ id: DEVICE, account_id: ACCOUNT, revoked_at: null });
    const token = await signAccessToken(jwk, {
      sub: ACCOUNT,
      did: DEVICE,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 600,
      jti: "jti_env",
    });

    const build = () =>
      new Request("https://control-plane.test/v1/orders", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "Idempotency-Key": "idem_env_1" },
        body: JSON.stringify({ region: "sgp1", plan: "s-1vcpu-1gb" }),
      });
    const base = {
      DB: db as unknown as D1Database,
      TOKEN_SIGNING_JWK: jwk,
      DO_API_TOKEN: "do-token",
      PLAN_DAILY_PRICE_CENTS: JSON.stringify({ "s-1vcpu-1gb": 30 }),
    };

    const missing = await handleOrders(build(), { ...base } as never);
    expect(missing?.status).toBe(401);
    expect(await missing!.json()).toMatchObject({ code: "UNAUTHENTICATED" });

    const typo = await handleOrders(build(), { ...base, ENVIRONMENT: "prod" } as never);
    expect(typo?.status).toBe(401);
  });

  it("凭据签发：生产缺 CREDENTIAL_KEY_ID 拒绝，dev 才回落到默认密钥", async () => {
    const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
      "sign",
      "verify",
    ])) as CryptoKeyPair;
    const jwk = JSON.stringify(await crypto.subtle.exportKey("jwk", pair.privateKey));
    const sealed = await sealSecret(ENC_KEY, JSON.stringify({
      host: "203.0.113.10",
      port: 20443,
      password: "pw",
      method: "2022-blake3-aes-128-gcm",
    }));

    const db = new FakeD1();
    db.rows("accounts").push({ id: ACCOUNT, kind: "email", status: "active" });
    db.rows("devices").push({ id: DEVICE, account_id: ACCOUNT, revoked_at: null });
    db.rows("servers").push({
      id: SERVER,
      account_id: ACCOUNT,
      order_id: "ord_env",
      provider: "digitalocean",
      provider_id: "4242",
      name: "我的服务器0001",
      region: "sgp1",
      plan: "s-1vcpu-1gb",
      hourly_usd: 0.00893,
      monthly_usd: 6,
      state: "active",
      node_port: 20443,
      ip: "203.0.113.10",
      node_id: null,
      enrollment_hash: null,
      enrollment_expires_at: null,
      enrollment_used_at: null,
      firewall_id: null,
      created_at: Date.now(),
      updated_at: Date.now(),
      destroyed_at: null,
    });
    db.rows("credentials").push({
      server_id: SERVER,
      key_version: 1,
      iv: sealed.iv,
      ciphertext: sealed.ciphertext,
      created_at: Date.now(),
      destroyed_at: null,
    });

    const token = await signAccessToken(jwk, {
      sub: ACCOUNT,
      did: DEVICE,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 600,
      jti: "jti_env2",
    });

    const request = () =>
      new Request(`https://control-plane.test/v1/servers/${SERVER}/credentials`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
      });
    const base = {
      DB: db as unknown as D1Database,
      TOKEN_SIGNING_JWK: jwk,
      CREDENTIAL_SIGNING_JWK: jwk,
      CREDENTIAL_ENC_KEY: ENC_KEY,
    };

    const missing = await handleServers(request(), { ...base } as never);
    expect(missing?.status).toBe(500);
    expect(await missing!.json()).toMatchObject({
      code: "INTERNAL",
      details: { reason: "credential_key_missing" },
    });

    const dev = await handleServers(request(), { ...base, ENVIRONMENT: "dev" } as never);
    expect(dev?.status).toBe(200);
    expect(await dev!.json()).toMatchObject({ key_id: "cp-2026-11" });

    const prod = await handleServers(
      request(),
      { ...base, ENVIRONMENT: "production", CREDENTIAL_KEY_ID: "cp-2026-12" } as never,
    );
    expect(prod?.status).toBe(200);
    expect(await prod!.json()).toMatchObject({ key_id: "cp-2026-12" });
  });
});
