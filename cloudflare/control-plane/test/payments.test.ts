// 登录门禁与支付（login-and-payment.md §4）：收银台会话、webhook 验签与幂等。
import { afterEach, describe, expect, it, vi } from "vitest";

import { handleOrders } from "../src/orders";
import { handleDodoWebhook } from "../src/webhooks/dodo";
import { signAccessToken } from "../src/lib/crypto";
import { FakeD1 } from "./helpers/fakeD1";

const ACCOUNT = "acct_email000000000000000";
const DEVICE = "dev_emailtest00000000000";
const WEBHOOK_SECRET = "test-webhook-secret";

async function signingJwk(): Promise<string> {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  return JSON.stringify(await crypto.subtle.exportKey("jwk", pair.privateKey));
}

interface EnvOptions {
  kind?: "email" | "device";
  environment?: string;
  prices?: string;
}

async function makeEnv(db: FakeD1, options: EnvOptions = {}) {
  const kind = options.kind ?? "email";
  const jwk = await signingJwk();
  db.rows("accounts").push({
    id: ACCOUNT,
    kind,
    email: kind === "email" ? "buyer@example.com" : null,
    status: "active",
    merged_into: null,
    created_at: 0,
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
    jti: "jti_pay",
  });
  return {
    DB: db as unknown as D1Database,
    TOKEN_SIGNING_JWK: jwk,
    DO_API_TOKEN: "do-token",
    ENROLL_BASE_URL: "https://control.example.com",
    ENVIRONMENT: options.environment ?? "dev",
    DODO_API_KEY: "dodo-key",
    DODO_WEBHOOK_SECRET: WEBHOOK_SECRET,
    PLAN_PRICES_USD: options.prices ?? JSON.stringify({ "s-1vcpu-1gb": 9 }),
    DODO_PRODUCT_IDS: JSON.stringify({ "s-1vcpu-1gb": "pdt_test0001" }),
    APP_PAYMENT_RETURN_URL: "https://control.example.com/payment/return",
    token,
  };
}

type TestEnv = Awaited<ReturnType<typeof makeEnv>>;

function stubUpstream(sessionUrl = "https://checkout.dodopayments.test/cs_1") {
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
              { slug: "s-1vcpu-1gb", memory: 1024, vcpus: 1, price_hourly: 0.00893, price_monthly: 6 },
            ],
          }),
          { status: 200 },
        );
      }
      if (href.endsWith("/checkouts") && init?.method === "POST") {
        return new Response(JSON.stringify({ id: "cs_1", checkout_url: sessionUrl }), { status: 201 });
      }
      if (href.endsWith("/droplets") && init?.method === "POST") {
        return new Response(
          JSON.stringify({ droplet: { id: 777001, status: "new", networks: { v4: [] } } }),
          { status: 202 },
        );
      }
      return new Response(JSON.stringify({}), { status: 200 });
    }),
  );
}

function orderRequest(token: string, key: string) {
  return new Request("https://example.com/v1/orders", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "Idempotency-Key": key },
    body: JSON.stringify({ region: "sgp1", plan: "s-1vcpu-1gb" }),
  });
}

function checkoutRequest(token: string, orderId: string, key: string, channel?: string) {
  return new Request(`https://example.com/v1/orders/${orderId}/checkout`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "Idempotency-Key": key },
    body: JSON.stringify(channel ? { channel } : {}),
  });
}

async function createOrder(env: TestEnv, key: string): Promise<string> {
  const res = await handleOrders(orderRequest(env.token, key), env as never);
  expect(res?.status).toBe(200);
  const body = (await res!.json()) as { order_id: string };
  return body.order_id;
}

async function signWebhook(body: string, id: string, timestamp: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(WEBHOOK_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${id}.${timestamp}.${body}`),
  );
  return `v1,${btoa(String.fromCharCode(...new Uint8Array(mac)))}`;
}

let webhookSeq = 0;

async function webhookRequest(
  payload: unknown,
  options: { id?: string; timestamp?: string; signature?: string } = {},
): Promise<Request> {
  const body = JSON.stringify(payload);
  // 默认每次都是新事件：真实 Dodo 每次投递有自己的 webhook-id。
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

function paidEvent(orderId: string, paymentId = "pay_1") {
  return {
    type: "payment.succeeded",
    data: {
      id: paymentId,
      customer: { email: "buyer@example.com" },
      metadata: { order_id: orderId },
      settlement_amount: 900,
      currency: "USD",
    },
  };
}

function subscriptionEvent(
  kind: string,
  subscriptionId: string,
  orderId: string,
  endsAt: string,
  cancelAtPeriodEnd = false,
) {
  return {
    type: kind,
    data: {
      id: subscriptionId,
      metadata: { order_id: orderId },
      next_billing_date: endsAt,
      cancel_at_period_end: cancelAtPeriodEnd,
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("真支付结账", () => {
  it("结账只建收银台会话，不建机", async () => {
    const db = new FakeD1();
    const env = await makeEnv(db);
    stubUpstream();

    const orderId = await createOrder(env, "idem-pay-0001");
    const res = await handleOrders(checkoutRequest(env.token, orderId, "idem-checkout-0001"), env as never);
    expect(res?.status).toBe(200);
    const body = (await res!.json()) as { state: string; checkout_url: string; session_id: string };
    expect(body.state).toBe("awaiting_payment");
    expect(body.checkout_url).toBe("https://checkout.dodopayments.test/cs_1");
    expect(body.session_id).toBe("cs_1");
    expect(db.rows("servers")).toHaveLength(0);
    expect(db.rows("orders")[0].checkout_session_id).toBe("cs_1");
  });

  it("订单金额与售价不一致时拒绝建会话", async () => {
    const db = new FakeD1();
    const env = await makeEnv(db, { prices: JSON.stringify({ "s-1vcpu-1gb": 7.5 }) });
    stubUpstream();

    const orderId = await createOrder(env, "idem-pay-0002");
    // 下单时用的就是 PLAN_PRICES_USD，所以先把订单改成旧价模拟配置漂移。
    db.rows("orders")[0].amount_usd = 6;
    const res = await handleOrders(checkoutRequest(env.token, orderId, "idem-checkout-0002"), env as never);
    expect(res?.status).toBe(409);
    const body = (await res!.json()) as { details: { reason: string } };
    expect(body.details.reason).toBe("price_mismatch");
  });

  it("生产环境不接受假支付，匿名设备账户也不能下单", async () => {
    const db = new FakeD1();
    const env = await makeEnv(db, { kind: "device", environment: "production" });
    stubUpstream();

    const rejected = await handleOrders(orderRequest(env.token, "idem-pay-0003"), env as never);
    expect(rejected?.status).toBe(401);
    const body = (await rejected!.json()) as { details: { reason: string } };
    expect(body.details.reason).toBe("auth_required");
  });
});

describe("Dodo webhook", () => {
  it("验签通过后把订单标记为已付并只建一台服务器", async () => {
    const db = new FakeD1();
    const env = await makeEnv(db);
    stubUpstream();
    const orderId = await createOrder(env, "idem-pay-0010");
    await handleOrders(checkoutRequest(env.token, orderId, "idem-checkout-0010"), env as never);

    const res = await handleDodoWebhook(await webhookRequest(paidEvent(orderId)), env as never);
    expect(res?.status).toBe(200);
    expect(db.rows("orders")[0].state).toBe("provisioning");
    expect(db.rows("servers")).toHaveLength(1);
    expect(db.rows("payments")).toHaveLength(1);

    // 同一事件重投：不再处理，也不会建第二台。
    const again = await handleDodoWebhook(await webhookRequest(paidEvent(orderId)), env as never);
    expect(again?.status).toBe(200);
    expect(db.rows("servers")).toHaveLength(1);
    expect(db.rows("payments")).toHaveLength(1);
  });

  it("坏签名一律 401，订单不变", async () => {
    const db = new FakeD1();
    const env = await makeEnv(db);
    stubUpstream();
    const orderId = await createOrder(env, "idem-pay-0011");
    await handleOrders(checkoutRequest(env.token, orderId, "idem-checkout-0011"), env as never);

    const res = await handleDodoWebhook(
      await webhookRequest(paidEvent(orderId), { signature: "v1,deadbeef" }),
      env as never,
    );
    expect(res?.status).toBe(401);
    expect(db.rows("orders")[0].state).toBe("awaiting_payment");
    expect(db.rows("servers")).toHaveLength(0);
  });

  it("时间戳超出窗口按重放拒绝", async () => {
    const db = new FakeD1();
    const env = await makeEnv(db);
    stubUpstream();
    const orderId = await createOrder(env, "idem-pay-0012");

    const stale = String(Math.floor(Date.now() / 1000) - 3600);
    const res = await handleDodoWebhook(
      await webhookRequest(paidEvent(orderId), { timestamp: stale }),
      env as never,
    );
    expect(res?.status).toBe(401);
  });

  it("匹配不到订单时留证据并回 200", async () => {
    const db = new FakeD1();
    const env = await makeEnv(db);
    stubUpstream();

    const res = await handleDodoWebhook(await webhookRequest(paidEvent("ord_unknown")), env as never);
    expect(res?.status).toBe(200);
    expect(db.rows("unmatched_payments")).toHaveLength(1);
    expect(db.rows("unmatched_payments")[0].reason).toBe("unknown_order");
  });

  it("订阅只挂在服务器上：首期付款记下本期到期时间", async () => {
    const db = new FakeD1();
    const env = await makeEnv(db);
    stubUpstream();
    const orderId = await createOrder(env, "idem-sub-0001");
    await handleOrders(checkoutRequest(env.token, orderId, "idem-checkout-sub-0001"), env as never);

    const endsAt = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString();
    const event = paidEvent(orderId, "pay_sub_1");
    (event.data as Record<string, unknown>).subscription_id = "sub_1";
    (event.data as Record<string, unknown>).service_periods = [{ ends_at: endsAt }];
    const res = await handleDodoWebhook(await webhookRequest(event), env as never);
    expect(res?.status).toBe(200);

    expect(db.rows("subscriptions")).toHaveLength(1);
    const subscription = db.rows("subscriptions")[0];
    expect(subscription.id).toBe("sub_1");
    expect(subscription.status).toBe("active");
    expect(subscription.order_id).toBe(orderId);
    // 订阅跟着服务器走：到期时间落在 servers.paid_until 上。
    expect(db.rows("servers")[0].paid_until).toBe(Date.parse(endsAt));
  });

  it("续费顺延到期时间，取消只改状态不删机", async () => {
    const db = new FakeD1();
    const env = await makeEnv(db);
    stubUpstream();
    const orderId = await createOrder(env, "idem-sub-0002");
    await handleOrders(checkoutRequest(env.token, orderId, "idem-checkout-sub-0002"), env as never);

    const first = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString();
    const event = paidEvent(orderId, "pay_sub_2");
    (event.data as Record<string, unknown>).subscription_id = "sub_2";
    (event.data as Record<string, unknown>).service_periods = [{ ends_at: first }];
    await handleDodoWebhook(await webhookRequest(event), env as never);

    const renewed = new Date(Date.now() + 60 * 24 * 3600 * 1000).toISOString();
    await handleDodoWebhook(
      await webhookRequest(subscriptionEvent("subscription.renewed", "sub_2", orderId, renewed)),
      env as never,
    );
    expect(db.rows("servers")[0].paid_until).toBe(Date.parse(renewed));

    await handleDodoWebhook(
      await webhookRequest(subscriptionEvent("subscription.cancelled", "sub_2", orderId, renewed, true)),
      env as never,
    );
    expect(db.rows("subscriptions")[0].status).toBe("cancelled");
    expect(db.rows("servers")[0].state).not.toBe("destroyed");
  });

  it("迟到的旧事件不会把订阅状态和有效期改回去", async () => {
    const db = new FakeD1();
    const env = await makeEnv(db);
    stubUpstream();
    const orderId = await createOrder(env, "idem-sub-0003");
    await handleOrders(checkoutRequest(env.token, orderId, "idem-checkout-sub-0003"), env as never);

    const now = Math.floor(Date.now() / 1000);
    const later = new Date(Date.now() + 60 * 24 * 3600 * 1000).toISOString();
    const sooner = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString();

    // 先有一期付款，机器才存在；到期时间从这一期开始。
    const first = paidEvent(orderId, "pay_sub_3");
    (first.data as Record<string, unknown>).subscription_id = "sub_3";
    (first.data as Record<string, unknown>).service_periods = [{ ends_at: sooner }];
    await handleDodoWebhook(await webhookRequest(first, { id: "wh_first" }), env as never);

    await handleDodoWebhook(
      await webhookRequest(subscriptionEvent("subscription.renewed", "sub_3", orderId, later), {
        id: "wh_new",
        timestamp: String(now),
      }),
      env as never,
    );
    // 旧事件晚到：时间戳更早，必须被丢弃。
    await handleDodoWebhook(
      await webhookRequest(subscriptionEvent("subscription.cancelled", "sub_3", orderId, sooner), {
        id: "wh_old",
        timestamp: String(now - 30),
      }),
      env as never,
    );

    expect(db.rows("subscriptions")[0].status).toBe("active");
    expect(db.rows("servers")[0].paid_until).toBe(Date.parse(later));
  });
});
