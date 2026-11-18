// 预付费钱包（login-and-payment.md §4）：充值入账、webhook 幂等、余额不足。
import { afterEach, describe, expect, it, vi } from "vitest";

import { handleOrders } from "../src/orders";
import { runBilling } from "../src/billing";
import { handleTopups } from "../src/topups";
import { handleDodoWebhook } from "../src/webhooks/dodo";
import { signAccessToken } from "../src/lib/crypto";
import { FakeD1 } from "./helpers/fakeD1";

const ACCOUNT = "acct_wallet00000000000000";
const DEVICE = "dev_wallettest00000000000";
const WEBHOOK_SECRET = "test-webhook-secret";

async function signingJwk(): Promise<string> {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  return JSON.stringify(await crypto.subtle.exportKey("jwk", pair.privateKey));
}

async function makeEnv(db: FakeD1, environment = "dev") {
  const jwk = await signingJwk();
  db.rows("accounts").push({
    id: ACCOUNT,
    kind: "email",
    email: "buyer@example.com",
    status: "active",
    merged_into: null,
    created_at: 0,
    balance_cents: 0,
  });
  db.rows("devices").push({
    id: DEVICE,
    account_id: ACCOUNT,
    secret_hash: "x",
    platform: "macos",
    app_version: "1.0.0",
    refresh_family: "rf",
    created_at: 0,
    last_seen_at: 0,
    revoked_at: null,
  });
  const token = await signAccessToken(jwk, {
    sub: ACCOUNT,
    did: DEVICE,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 600,
    jti: "jti_wallet",
  });
  return {
    DB: db as unknown as D1Database,
    TOKEN_SIGNING_JWK: jwk,
    DO_API_TOKEN: "do-token",
    ENROLL_BASE_URL: "https://control.example.com",
    ENVIRONMENT: environment,
    DODO_API_KEY: "dodo-key",
    DODO_WEBHOOK_SECRET: WEBHOOK_SECRET,
    PLAN_DAILY_PRICE_CENTS: JSON.stringify({ "s-1vcpu-1gb": 30 }),
    DODO_TOPUP_PRODUCT_IDS: JSON.stringify({ "1000": "pdt_top10", "2000": "pdt_top20" }),
    APP_PAYMENT_RETURN_URL: "https://control.example.com/payment/return",
    token,
  };
}

type TestEnv = Awaited<ReturnType<typeof makeEnv>>;

function stubUpstream(options: { droplet?: { status: number; body: string } } = {}) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const href = String(input);
      if (href.includes("/regions")) {
        return new Response(
          JSON.stringify({ regions: [{ slug: "sgp1", name: "Singapore 1", available: true }] }),
          { status: 200 },
        );
      }
      if (href.includes("/sizes")) {
        return new Response(
          JSON.stringify({
            sizes: [
              { slug: "s-1vcpu-1gb", memory: 1024, vcpus: 1, price_hourly: 0.00893, price_monthly: 6, regions: ["sgp1"] },
            ],
          }),
          { status: 200 },
        );
      }
      if (href.endsWith("/checkouts") && init?.method === "POST") {
        return new Response(JSON.stringify({ id: "cs_wallet", checkout_url: "https://checkout.test/cs_wallet" }), {
          status: 201,
        });
      }
      if (href.endsWith("/droplets") && init?.method === "POST") {
        if (options.droplet) {
          return new Response(options.droplet.body, { status: options.droplet.status });
        }
        return new Response(
          JSON.stringify({ droplet: { id: 888001, status: "new", networks: { v4: [] } } }),
          { status: 202 },
        );
      }
      return new Response(JSON.stringify({}), { status: 200 });
    }),
  );
}

function authed(token: string) {
  return { authorization: `Bearer ${token}` };
}

function topupRequest(env: TestEnv, cents: number, channel?: string) {
  return new Request("https://example.com/v1/topups", {
    method: "POST",
    headers: authed(env.token),
    body: JSON.stringify(channel ? { denomination_cents: cents, channel } : { denomination_cents: cents }),
  });
}

function walletRequest(env: TestEnv) {
  return new Request("https://example.com/v1/wallet", { headers: authed(env.token) });
}

async function signWebhook(body: string, id: string, timestamp: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(WEBHOOK_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${id}.${timestamp}.${body}`));
  return `v1,${btoa(String.fromCharCode(...new Uint8Array(mac)))}`;
}

let webhookSeq = 0;

async function webhookRequest(
  payload: unknown,
  options: { id?: string; timestamp?: string; signature?: string } = {},
): Promise<Request> {
  const body = JSON.stringify(payload);
  const id = options.id ?? `wh_${(webhookSeq += 1)}`;
  const timestamp = options.timestamp ?? String(Math.floor(Date.now() / 1000));
  const signature = options.signature ?? (await signWebhook(body, id, timestamp));
  return new Request("https://example.com/v1/webhooks/dodo", {
    method: "POST",
    headers: {
      "webhook-id": id,
      "webhook-timestamp": timestamp,
      "webhook-signature": signature,
      "content-type": "application/json",
    },
    body,
  });
}

function topupPaidEvent(topupId: string, paymentId = "pay_top_1") {
  return {
    type: "payment.succeeded",
    data: {
      id: paymentId,
      metadata: { topup_id: topupId },
      settlement_amount: 1000,
      currency: "USD",
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("充值", () => {
  it("fake 通道直接入账，余额与账本同步", async () => {
    const db = new FakeD1();
    const env = await makeEnv(db);
    stubUpstream();

    const res = await handleTopups(topupRequest(env, 2000, "fake"), env as never);
    expect(res?.status).toBe(200);
    const body = (await res!.json()) as { topup_id: string; denomination_cents: number; balance_cents: number };
    expect(body.denomination_cents).toBe(2000);
    expect(body.balance_cents).toBe(2000);
    expect(db.rows("wallet_ledger")).toHaveLength(1);

    const wallet = await handleTopups(walletRequest(env), env as never);
    const view = (await wallet!.json()) as { balance_cents: number; denominations_cents: number[] };
    expect(view.balance_cents).toBe(2000);
    expect(view.denominations_cents).toEqual([1000, 2000]);
  });

  it("同一幂等键连点只产生一个充值单", async () => {
    const db = new FakeD1();
    const env = await makeEnv(db);
    stubUpstream();

    const withKey = () =>
      new Request("https://example.com/v1/topups", {
        method: "POST",
        headers: { ...authed(env.token), "Idempotency-Key": "idem-topup-0001" },
        body: JSON.stringify({ denomination_cents: 1000, channel: "fake" }),
      });

    const first = (await (await handleTopups(withKey(), env as never))!.json()) as { topup_id: string };
    const second = (await (await handleTopups(withKey(), env as never))!.json()) as { topup_id: string };
    expect(second.topup_id).toBe(first.topup_id);
    expect(db.rows("topups")).toHaveLength(1);
    expect(db.rows("accounts")[0].balance_cents).toBe(1000);
  });

  it("默认走真实收银台，返回 checkout_url", async () => {
    const db = new FakeD1();
    const env = await makeEnv(db);
    stubUpstream();

    const res = await handleTopups(topupRequest(env, 2000), env as never);
    expect(res?.status).toBe(200);
    const body = (await res!.json()) as { checkout_url: string | null; topup_id: string };
    expect(body.checkout_url).toBe("https://checkout.test/cs_wallet");
    expect(db.rows("topups")[0].status).toBe("pending");
    expect(db.rows("accounts")[0].balance_cents).toBe(0);
  });

  it("生产环境拒绝 fake 通道", async () => {
    const db = new FakeD1();
    const env = await makeEnv(db, "production");
    stubUpstream();
    const res = await handleTopups(topupRequest(env, 1000, "fake"), env as never);
    expect(res?.status).toBe(409);
    const body = (await res!.json()) as { details: { reason: string } };
    expect(body.details.reason).toBe("channel_not_allowed");
  });

  it("没配产品的面额被拒绝", async () => {
    const db = new FakeD1();
    const env = await makeEnv(db);
    stubUpstream();
    const res = await handleTopups(topupRequest(env, 5000), env as never);
    expect(res?.status).toBe(409);
    const body = (await res!.json()) as { details: { reason: string } };
    expect(body.details.reason).toBe("invalid_denomination");
  });
});

describe("Dodo 回调入账", () => {
  it("支付成功入账一次，重复投递不重复加钱", async () => {
    const db = new FakeD1();
    const env = await makeEnv(db);
    stubUpstream();
    db.rows("topups").push({
      id: "top_1",
      account_id: ACCOUNT,
      denomination_cents: 1000,
      product_id: "pdt_top10",
      checkout_session_id: "cs_1",
      checkout_url: "https://checkout.test/cs_1",
      status: "pending",
      created_at: 0,
      paid_at: null,
    });

    const first = await handleDodoWebhook(await webhookRequest(topupPaidEvent("top_1")), env as never);
    expect(first?.status).toBe(200);
    expect(db.rows("accounts")[0].balance_cents).toBe(1000);
    expect(db.rows("topups")[0].status).toBe("paid");

    // 同一 webhook-id 重投。
    const again = await handleDodoWebhook(
      await webhookRequest(topupPaidEvent("top_1"), { id: "wh_replay" }),
      env as never,
    );
    expect(again?.status).toBe(200);
    expect(db.rows("accounts")[0].balance_cents).toBe(1000);
    expect(db.rows("wallet_ledger")).toHaveLength(1);
    expect(db.rows("payments")).toHaveLength(1);
  });

  it("坏签名一律 401，不入账", async () => {
    const db = new FakeD1();
    const env = await makeEnv(db);
    stubUpstream();
    db.rows("topups").push({
      id: "top_2",
      account_id: ACCOUNT,
      denomination_cents: 1000,
      product_id: "pdt_top10",
      checkout_session_id: "cs_2",
      checkout_url: "https://checkout.test/cs_2",
      status: "pending",
      created_at: 0,
      paid_at: null,
    });

    const res = await handleDodoWebhook(
      await webhookRequest(topupPaidEvent("top_2"), { signature: "v1,deadbeef" }),
      env as never,
    );
    expect(res?.status).toBe(401);
    expect(db.rows("accounts")[0].balance_cents).toBe(0);
    expect(db.rows("wallet_ledger")).toHaveLength(0);
  });

  it("时间戳超出窗口按重放拒绝", async () => {
    const db = new FakeD1();
    const env = await makeEnv(db);
    stubUpstream();
    const stale = String(Math.floor(Date.now() / 1000) - 3600);
    const res = await handleDodoWebhook(
      await webhookRequest(topupPaidEvent("top_3"), { timestamp: stale }),
      env as never,
    );
    expect(res?.status).toBe(401);
  });
});

describe("买机扣余额", () => {
  async function createOrder(env: TestEnv): Promise<string> {
    const res = await handleOrders(
      new Request("https://example.com/v1/orders", {
        method: "POST",
        headers: { ...authed(env.token), "Idempotency-Key": "idem-wallet-order-1" },
        body: JSON.stringify({ region: "sgp1", plan: "s-1vcpu-1gb" }),
      }),
      env as never,
    );
    expect(res?.status).toBe(200);
    return ((await res!.json()) as { order_id: string }).order_id;
  }

  it("余额不足时不扣钱不建机", async () => {
    const db = new FakeD1();
    const env = await makeEnv(db);
    stubUpstream();
    const orderId = await createOrder(env);

    const res = await handleOrders(
      new Request(`https://example.com/v1/orders/${orderId}/checkout`, {
        method: "POST",
        headers: { ...authed(env.token), "Idempotency-Key": "idem-wallet-checkout-1" },
      }),
      env as never,
    );
    expect(res?.status).toBe(409);
    const body = (await res!.json()) as {
      retryable: boolean;
      details: { reason: string; required_cents: number; shortfall_cents: number; min_days: number };
    };
    expect(body.details.reason).toBe("insufficient_balance");
    // 2.37.1：门槛是 7 天日价（30 × 7 = 210），余额 0 时差额就是整笔门槛。
    expect(body.details.required_cents).toBe(210);
    expect(body.details.shortfall_cents).toBe(210);
    expect(body.details.min_days).toBe(7);
    // 契约要求充值后可重试；retryable=false 会让 Host 当终态处理。
    expect(body.retryable).toBe(true);
    expect(db.rows("servers")).toHaveLength(0);
    expect(db.rows("wallet_ledger")).toHaveLength(0);
  });

  it("扣完余额建机，服务器带上本期到期时间", async () => {
    const db = new FakeD1();
    const env = await makeEnv(db);
    stubUpstream();
    db.rows("accounts")[0].balance_cents = 2000;
    const orderId = await createOrder(env);

    const res = await handleOrders(
      new Request(`https://example.com/v1/orders/${orderId}/checkout`, {
        method: "POST",
        headers: { ...authed(env.token), "Idempotency-Key": "idem-wallet-checkout-2" },
      }),
      env as never,
    );
    expect(res?.status).toBe(200);
    const body = (await res!.json()) as {
      order_id: string;
      state: string;
      charged_cents: number;
      balance_after_cents: number;
    };
    expect(body.charged_cents).toBe(30);
    expect(body.balance_after_cents).toBe(1970);
    // Host 按 order_id + state 解析；少任何一个都会在扣款成功后报错、用户重试再扣一次。
    expect(body.order_id).toBe(orderId);
    expect(body.state).toBe("provisioning");

    const server = db.rows("servers")[0];
    expect(server.daily_price_cents).toBe(30);
    // 不写 paid_until 会让续费扫描永远扫不到（永久免单）。
    expect(Number(server.paid_until)).toBeGreaterThan(Date.now());
  });

  it("建机被 4xx 拒绝：退款、订单置 failed、服务器保留 error", async () => {
    const db = new FakeD1();
    const env = await makeEnv(db);
    stubUpstream({
      droplet: {
        status: 422,
        body: JSON.stringify({ id: "unprocessable_entity", message: "You specified an invalid image" }),
      },
    });
    db.rows("accounts")[0].balance_cents = 2000;
    const orderId = await createOrder(env);

    const res = await handleOrders(
      new Request(`https://example.com/v1/orders/${orderId}/checkout`, {
        method: "POST",
        headers: { ...authed(env.token), "Idempotency-Key": "idem-wallet-checkout-422" },
      }),
      env as never,
    );
    expect(res?.status).toBe(502);
    const body = (await res!.json()) as { retryable: boolean; details: { reason: string } };
    expect(body.details.reason).toBe("upstream_422");
    expect(body.retryable).toBe(false);

    // 扣了 30 又退 30：用户不该为拿不到的机器付钱。
    expect(db.rows("accounts")[0].balance_cents).toBe(2000);
    const refunds = db.rows("wallet_ledger").filter((row) => row.ref_type === "server_refund");
    expect(refunds).toHaveLength(1);
    expect(refunds[0].amount_cents).toBe(30);

    expect(db.rows("orders")[0].state).toBe("failed");
    const server = db.rows("servers")[0];
    expect(server.state).toBe("error");
    expect(server.provider_id).toBeNull();

    const audit = db.rows("audit_log");
    const failed = audit.find((row) => row.action === "provision.failed");
    expect(String(failed?.detail)).toContain("upstream");
    expect(String(failed?.detail)).toContain("invalid image");
    expect(audit.some((row) => row.action === "provision.refunded")).toBe(true);
  });

  it("建机被 5xx 拒绝：不退款，订单退回 paid 等补建", async () => {
    const db = new FakeD1();
    const env = await makeEnv(db);
    stubUpstream({ droplet: { status: 500, body: JSON.stringify({ id: "server_error" }) } });
    db.rows("accounts")[0].balance_cents = 2000;
    const orderId = await createOrder(env);

    const res = await handleOrders(
      new Request(`https://example.com/v1/orders/${orderId}/checkout`, {
        method: "POST",
        headers: { ...authed(env.token), "Idempotency-Key": "idem-wallet-checkout-500" },
      }),
      env as never,
    );
    expect(res?.status).toBe(502);
    const body = (await res!.json()) as { retryable: boolean; details: { reason: string } };
    expect(body.details.reason).toBe("upstream_500");
    expect(body.retryable).toBe(true);

    // 钱不退：Cron 会按 paid 订单继续补建。
    expect(db.rows("accounts")[0].balance_cents).toBe(1970);
    expect(db.rows("wallet_ledger").filter((row) => row.ref_type === "server_refund")).toHaveLength(0);
    expect(db.rows("orders")[0].state).toBe("paid");
    expect(db.rows("servers")[0].state).toBe("error");
  });

  it("退款失败会留证，计费 Cron 下一轮补退且不重复退", async () => {
    const db = new FakeD1();
    const env = await makeEnv(db);
    stubUpstream({ droplet: { status: 422, body: JSON.stringify({ id: "unprocessable_entity" }) } });
    db.rows("accounts")[0].balance_cents = 2000;
    const orderId = await createOrder(env);

    // 账户在退款落账那一刻不可用（模拟 D1 抖动 / 账户异常）：扣费照旧、退款写不进去。
    const account = db.rows("accounts")[0];
    let inserts = 0;
    db.beforeWalletInsert = () => {
      inserts += 1;
      if (inserts === 2) {
        db.beforeWalletInsert = undefined;
        db.rows("accounts").splice(0);
      }
    };

    const res = await handleOrders(
      new Request(`https://example.com/v1/orders/${orderId}/checkout`, {
        method: "POST",
        headers: { ...authed(env.token), "Idempotency-Key": "idem-wallet-checkout-refund-fail" },
      }),
      env as never,
    );
    expect(res?.status).toBe(502);
    expect(db.rows("orders")[0].state).toBe("failed");
    expect(db.rows("wallet_ledger").filter((row) => row.ref_type === "server_refund")).toHaveLength(0);
    const failed = db.rows("audit_log").find((row) => row.action === "provision.refund_failed");
    expect(failed).toBeDefined();
    expect(String(failed?.detail)).toContain("missing_account");

    // 下一轮计费把这些「扣了没退」的单补退回来。
    db.rows("accounts").push(account);
    const report = await runBilling(env as never);
    expect(report.refunded).toBe(1);
    expect(db.rows("accounts")[0].balance_cents).toBe(2000);
    expect(db.rows("wallet_ledger").filter((row) => row.ref_type === "server_refund")).toHaveLength(1);
    expect(db.rows("audit_log").some((row) => row.action === "provision.refunded")).toBe(true);

    // 再跑一轮：钱已经退了，不能退第二次。
    const again = await runBilling(env as never);
    expect(again.refunded).toBe(0);
    expect(db.rows("wallet_ledger").filter((row) => row.ref_type === "server_refund")).toHaveLength(1);
    expect(db.rows("accounts")[0].balance_cents).toBe(2000);
  });
});
