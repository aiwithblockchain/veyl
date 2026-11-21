// 预付费钱包（login-and-payment.md §4）：充值入账、webhook 幂等、余额不足。
import { afterEach, describe, expect, it, vi } from "vitest";

import { handleOrders } from "../src/orders";
import { handleTopups } from "../src/topups";
import { handleDodoWebhook } from "../src/webhooks/dodo";
import { signAccessToken } from "../src/lib/crypto";
import { dodoApiBase } from "../src/lib/config";
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
      // 建机前先 ensure 全局共享防火墙。
      if (href.includes("/firewalls?")) {
        return new Response(JSON.stringify({ firewalls: [] }), { status: 200 });
      }
      if (href.endsWith("/firewalls") && init?.method === "POST") {
        return new Response(JSON.stringify({ firewall: { id: "fw_shared" } }), { status: 202 });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    }),
  );
}

function authed(token: string) {
  return { authorization: `Bearer ${token}` };
}

function topupRequest(env: TestEnv, cents: number) {
  return new Request("https://example.com/v1/topups", {
    method: "POST",
    headers: authed(env.token),
    body: JSON.stringify({ denomination_cents: cents }),
  });
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
  it("同一幂等键连点只产生一个充值单", async () => {
    const db = new FakeD1();
    const env = await makeEnv(db);
    stubUpstream();

    const withKey = () =>
      new Request("https://example.com/v1/topups", {
        method: "POST",
        headers: { ...authed(env.token), "Idempotency-Key": "idem-topup-0001" },
        body: JSON.stringify({ denomination_cents: 1000 }),
      });

    const first = (await (await handleTopups(withKey(), env as never))!.json()) as { topup_id: string };
    const second = (await (await handleTopups(withKey(), env as never))!.json()) as { topup_id: string };
    expect(second.topup_id).toBe(first.topup_id);
    expect(db.rows("topups")).toHaveLength(1);
    expect(db.rows("topups")[0].status).toBe("pending");
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

  it("没配产品的面额被拒绝", async () => {
    const db = new FakeD1();
    const env = await makeEnv(db);
    stubUpstream();
    const res = await handleTopups(topupRequest(env, 5000), env as never);
    expect(res?.status).toBe(409);
    const body = (await res!.json()) as { details: { reason: string } };
    expect(body.details.reason).toBe("invalid_denomination");
  });

  it("ENVIRONMENT 不参与收银台选路：dev 变量也能建出本包固定环境的会话", async () => {
    const db = new FakeD1();
    const env = await makeEnv(db, "dev");
    stubUpstream();

    const res = await handleTopups(topupRequest(env, 2000), env as never);
    expect(res?.status).toBe(200);
    expect(db.rows("topups")[0].status).toBe("pending");
  });

  it("缺 return URL 或 API Key 时表里不新增行", async () => {
    for (const patch of [
      { APP_PAYMENT_RETURN_URL: undefined },
      { DODO_API_KEY: undefined },
    ]) {
      const db = new FakeD1();
      const env = await makeEnv(db);
      stubUpstream();

      const res = await handleTopups(topupRequest(env, 2000), { ...env, ...patch } as never);
      expect(res?.status).toBe(502);
      expect(db.rows("topups")).toHaveLength(0);
    }
  });
});

describe("Dodo 收银台基址（编译期常量）", () => {
  it("只返回本包的地址：测试包注入 live", () => {
    expect(dodoApiBase()).toBe("https://live.dodopayments.com");
  });
});

describe("Dodo 回调样本（dev）", () => {
  function seedTopup(db: FakeD1) {
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
  }

  it("dev 捕获脱敏样本：签名、支付 id、邮箱、金额、topup id 都换成占位值", async () => {
    const db = new FakeD1();
    const env = await makeEnv(db);
    stubUpstream();
    seedTopup(db);

    const event = topupPaidEvent("top_1", "pay_live_secret");
    (event.data as Record<string, unknown>).customer = { email: "real.buyer@example.net" };
    const res = await handleDodoWebhook(await webhookRequest(event), env as never);
    expect(res?.status).toBe(200);

    expect(db.rows("webhook_samples")).toHaveLength(1);
    const sample = db.rows("webhook_samples")[0];
    const headers = JSON.parse(String(sample.headers)) as Record<string, string>;
    expect(headers["webhook-signature"]).toBe("***");
    expect(headers["webhook-id"]).toBeTruthy();

    const body = JSON.parse(String(sample.body)) as {
      data: { id: string; customer: { email: string }; metadata: { topup_id: string }; settlement_amount: number };
    };
    expect(body.data.id).toBe("pay_sample0000000000000");
    expect(body.data.metadata.topup_id).toBe("top_sample00000000000000");
    expect(body.data.customer.email).toBe("buyer@example.com");
    expect(body.data.settlement_amount).toBe(1000);
    expect(String(sample.body)).not.toContain("pay_live_secret");
    expect(String(sample.body)).not.toContain("real.buyer@example.net");
    // 捕获不影响正常入账。
    expect(db.rows("accounts")[0].balance_cents).toBe(1000);
  });

  it("对象型 PII、payment_method 与未知字段都按 allowlist 占位", async () => {
    const db = new FakeD1();
    const env = await makeEnv(db);
    stubUpstream();
    seedTopup(db);

    const event = topupPaidEvent("top_1", "pay_live_secret");
    (event.data as Record<string, unknown>).customer = {
      email: "real.buyer@example.net",
      phone_number: "+65 9123 4567",
      // 对象型地址：整棵子树必须占位，不能递归带出 line1 / postal_code。
      billing_address: { line1: "1 Secret Road", line2: "#02-01", postal_code: "123456", country: "SG" },
    };
    (event.data as Record<string, unknown>).payment_method = {
      type: "card",
      last4: "4242",
      brand: "visa",
      expiry: "12/29",
    };
    (event.data as Record<string, unknown>).metadata = {
      topup_id: "top_1",
      uid: 12345,
      plan: "s-1vcpu-1gb",
    };
    Object.assign(event.data as Record<string, unknown>, {
      payment_method_id: "pm_live_abcdef",
      ip: "198.51.100.9",
      zip_code: 123456,
      checkout_url: "https://checkout.dodopayments.com/session/cks_live_secret",
    });

    const base = await webhookRequest(event);
    const bodyText = await base.text();
    const headers = new Headers(base.headers);
    headers.set("user-agent", "Dodo/1.0");
    headers.set("x-real-ip", "198.51.100.9");
    headers.set("x-custom", "should-not-be-stored");
    const request = new Request(base.url, {
      method: "POST",
      headers,
      body: bodyText,
    });

    const res = await handleDodoWebhook(request, env as never);
    expect(res?.status).toBe(200);

    const sample = db.rows("webhook_samples")[0];
    const storedHeaders = JSON.parse(String(sample.headers)) as Record<string, string>;
    // 请求头 allowlist：只有 id / 时间戳 / 签名 / content-type / user-agent。
    expect(Object.keys(storedHeaders).sort()).toEqual([
      "content-type",
      "user-agent",
      "webhook-id",
      "webhook-signature",
      "webhook-timestamp",
    ]);
    expect(storedHeaders["webhook-signature"]).toBe("***");

    const body = JSON.parse(String(sample.body)) as {
      data: {
        customer: { email: string; phone_number: string; billing_address: string };
        payment_method: { type: string; last4: string; brand: string; expiry: string };
        metadata: { topup_id: string; uid: number; plan: string };
        payment_method_id: string;
        ip: string;
        zip_code: string;
        checkout_url: string;
      };
    };
    expect(body.data.customer.email).toBe("buyer@example.com");
    expect(body.data.customer.phone_number).toBe("***");
    expect(body.data.customer.billing_address).toBe("***");
    expect(body.data.payment_method).toEqual({
      type: "***",
      last4: "***",
      brand: "***",
      expiry: "***",
    });
    // 未知数值归零；档位是业务键，原样保留（会落进 subscriptions.product_id）。
    expect(body.data.metadata.uid).toBe(0);
    expect(body.data.metadata.plan).toBe("s-1vcpu-1gb");
    expect(body.data.metadata.topup_id).toBe("top_sample00000000000000");
    expect(body.data.payment_method_id).toBe("pm_sample00000000000000");
    expect(body.data.ip).toBe("***");
    expect(body.data.zip_code).toBe("***");
    expect(body.data.checkout_url).toBe("https://checkout.example.com/sample");
    expect(String(sample.body)).not.toContain("Secret Road");
    expect(String(sample.body)).not.toContain("cks_live_secret");
    expect(String(sample.headers)).not.toContain("198.51.100.9");
  });

  it("捕获只认编译期开关，不再看 ENVIRONMENT", async () => {
    // 本测试包注入 __WEBHOOK_SAMPLE__="1"，即使 ENVIRONMENT=production 也会落样本：
    // 「生产不捕获」由生产包不带这段代码保证（dry-run 后 grep webhook_samples 为 0），
    // 运行期没有任何 env 判断。
    const db = new FakeD1();
    const env = await makeEnv(db, "production");
    stubUpstream();
    seedTopup(db);

    const res = await handleDodoWebhook(await webhookRequest(topupPaidEvent("top_1")), env as never);
    expect(res?.status).toBe(200);
    expect(db.rows("webhook_samples")).toHaveLength(1);
    expect(db.rows("accounts")[0].balance_cents).toBe(1000);
  });

  it("捕获失败不影响回调处理", async () => {
    const db = new FakeD1();
    const env = await makeEnv(db);
    stubUpstream();
    seedTopup(db);
    db.beforeWebhookSample = () => {
      throw new Error("d1 down");
    };

    const res = await handleDodoWebhook(await webhookRequest(topupPaidEvent("top_1")), env as never);
    expect(res?.status).toBe(200);
    expect(db.rows("accounts")[0].balance_cents).toBe(1000);
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

  it("确认下单不扣费：服务器 pending，等就绪后结算", async () => {
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
      server_id: string;
      charged_cents?: number;
    };
    // 2.39.0：checkout 返回 MyServerOrder，没有扣费金额。
    expect(body.order_id).toBe(orderId);
    expect(body.state).toBe("provisioning");
    expect(body.charged_cents).toBeUndefined();
    expect(db.rows("accounts")[0].balance_cents).toBe(2000);
    expect(db.rows("wallet_ledger")).toHaveLength(0);

    const server = db.rows("servers")[0];
    expect(server.state).toBe("booting");
    expect(server.billing_state).toBe("pending");
    // 结算前没有「已付到」的时刻，计费三列留空。
    expect(server.paid_until).toBeNull();
    expect(server.daily_price_cents).toBe(0);
    expect(Number(server.billing_anchor_at)).toBe(0);
  });

  it("建机被 4xx 拒绝：不扣费也不退款，订单 failed、服务器保留 error", async () => {
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

    // 没扣过钱就不该有退款；余额原样。
    expect(db.rows("accounts")[0].balance_cents).toBe(2000);
    expect(db.rows("wallet_ledger")).toHaveLength(0);
    expect(db.rows("orders")[0].state).toBe("failed");
    const server = db.rows("servers")[0];
    expect(server.state).toBe("error");
    expect(server.provider_id).toBeNull();

    const audit = db.rows("audit_log");
    const failed = audit.find((row) => row.action === "provision.failed");
    expect(String(failed?.detail)).toContain("upstream");
    expect(String(failed?.detail)).toContain("invalid image");
    expect(audit.some((row) => row.action === "refund_skipped_no_charge")).toBe(true);
  });

  it("建机被 5xx 拒绝：at_ready 直接关单，不落到无人补建的 paid", async () => {
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
    // 补建只服务存量 upfront 单；at_ready 没有可补的口径，失败即终态。
    expect(body.retryable).toBe(false);

    expect(db.rows("accounts")[0].balance_cents).toBe(2000);
    expect(db.rows("wallet_ledger")).toHaveLength(0);
    expect(db.rows("orders")[0].state).toBe("failed");
    expect(db.rows("servers")[0].state).toBe("error");
  });
});
