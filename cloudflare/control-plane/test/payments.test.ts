// 预付费钱包（stripe-migration.md §3–§5、§8）：充值入账、Stripe 回调幂等、余额不足。
import { afterEach, describe, expect, it, vi } from "vitest";

import { handleOrders } from "../src/orders";
import { handleTopups } from "../src/topups";
import { route } from "../src/index";
import type { Env } from "../src/index";
import { handleStripeWebhook } from "../src/webhooks/stripe";
import { signAccessToken } from "../src/lib/crypto";
import { FakeD1 } from "./helpers/fakeD1";

const ACCOUNT = "acct_wallet00000000000000";
const DEVICE = "dev_wallettest00000000000";
const WEBHOOK_SECRET = "whsec_test_secret";
const QUICK_TIERS = [600, 1000, 2500, 5000, 10000];
const LEGACY_TIERS = [1200, 2400, 3600, 4800];

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
    AGENT_VERSION: "0.1.0",
    AGENT_SHA256: "a".repeat(64),
    AGENT_DOWNLOAD_URL: "https://control.example.com/veyl-agent",
    SING_BOX_VERSION: "1.14.4",
    SING_BOX_SHA256: "b".repeat(64),
    SING_BOX_DOWNLOAD_URL: "https://control.example.com/sing-box.tar.gz",
    STRIPE_SECRET_KEY: "sk_test_wallet",
    STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
    PLAN_DAILY_PRICE_CENTS: JSON.stringify({ "s-1vcpu-1gb": 30 }),
    TOPUP_DENOMINATIONS_CENTS: JSON.stringify(QUICK_TIERS),
    MIN_TOPUP_CENTS: "600",
    MAX_TOPUP_CENTS: "30000",
    APP_PAYMENT_RETURN_URL: "https://control.example.com/payment/return",
    PUBLIC_SITE_URL:
      environment === "production"
        ? "https://veyl.dessage.xyz"
        : "https://veyl-edge-dev.pages.dev",
    token,
  };
}

type TestEnv = Awaited<ReturnType<typeof makeEnv>>;

function stubUpstream(
  options: {
    droplet?: { status: number; body: string };
    checkout?: { status: number; body: string };
  } = {},
) {
  const state: { checkoutForm: URLSearchParams | null; checkoutHeaders: Headers | null } = {
    checkoutForm: null,
    checkoutHeaders: null,
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const href = String(input);
      if (href.includes("/checkout/sessions") && init?.method === "POST") {
        state.checkoutForm =
          typeof init.body === "string" ? new URLSearchParams(init.body) : new URLSearchParams();
        state.checkoutHeaders = new Headers(init.headers);
        if (options.checkout) {
          return new Response(options.checkout.body, { status: options.checkout.status });
        }
        return new Response(JSON.stringify({ id: "cs_wallet", url: "https://checkout.test/cs_wallet" }), {
          status: 200,
        });
      }
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
  return state;
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

function walletRequest(env: TestEnv) {
  return new Request("https://example.com/v1/wallet", { headers: authed(env.token) });
}

async function signStripe(body: string, timestamp: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(WEBHOOK_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${timestamp}.${body}`));
  return [...new Uint8Array(mac)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function stripeEvent(
  type: string,
  session: Record<string, unknown>,
  id?: string,
  livemode = false,
) {
  return {
    id: id ?? `evt_${crypto.randomUUID()}`,
    object: "event",
    livemode,
    type,
    data: { object: session },
  };
}

async function webhookRequest(
  payload: unknown,
  options: { timestamp?: string; signature?: string; extraV0?: boolean } = {},
): Promise<Request> {
  const body = JSON.stringify(payload);
  const timestamp = options.timestamp ?? String(Math.floor(Date.now() / 1000));
  const v1 = await signStripe(body, timestamp);
  const signature =
    options.signature ??
    `t=${timestamp}${options.extraV0 ? ",v0=deadbeef" : ""},v1=${v1}`;
  return new Request("https://example.com/v1/webhooks/stripe", {
    method: "POST",
    headers: {
      "stripe-signature": signature,
      "content-type": "application/json",
    },
    body,
  });
}

function seedTopup(db: FakeD1, overrides: Record<string, unknown> = {}) {
  const row = {
    id: "top_1",
    account_id: ACCOUNT,
    denomination_cents: 1200,
    product_id: null,
    checkout_session_id: "cs_1",
    checkout_url: "https://checkout.test/cs_1",
    status: "pending",
    created_at: 0,
    paid_at: null,
    ...overrides,
  };
  db.rows("topups").push(row);
  return row;
}

function checkoutSession(overrides: Record<string, unknown> = {}) {
  return {
    id: "cs_1",
    object: "checkout.session",
    mode: "payment",
    payment_status: "paid",
    payment_intent: "pi_1",
    client_reference_id: "top_1",
    customer_email: "buyer@example.com",
    customer_details: { email: "buyer@example.com" },
    metadata: { topup_id: "top_1", account_id: ACCOUNT },
    amount_total: 1200,
    currency: "usd",
    consent: { terms_of_service: "accepted" },
    url: "https://checkout.stripe.com/c/pay/cs_test_secret",
    ...overrides,
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
        body: JSON.stringify({ denomination_cents: 1200 }),
      });

    const first = (await (await handleTopups(withKey(), env as never))!.json()) as { topup_id: string };
    const second = (await (await handleTopups(withKey(), env as never))!.json()) as { topup_id: string };
    expect(second.topup_id).toBe(first.topup_id);
    expect(db.rows("topups")).toHaveLength(1);
    expect(db.rows("topups")[0].status).toBe("pending");
  });

  it("默认走 Stripe Checkout，返回 checkout_url", async () => {
    const db = new FakeD1();
    const env = await makeEnv(db);
    stubUpstream();

    const res = await handleTopups(topupRequest(env, 2400), env as never);
    expect(res?.status).toBe(200);
    const body = (await res!.json()) as { checkout_url: string | null; topup_id: string };
    expect(body.checkout_url).toBe("https://checkout.test/cs_wallet");
    expect(db.rows("topups")[0].status).toBe("pending");
    expect(db.rows("topups")[0].product_id).toBeNull();
    expect(db.rows("accounts")[0].balance_cents).toBe(0);
  });

  it("$6–$300 的整美元金额与新旧快捷档都能建会话", async () => {
    for (const cents of [...QUICK_TIERS, ...LEGACY_TIERS, 30000]) {
      const db = new FakeD1();
      const env = await makeEnv(db);
      stubUpstream();
      const res = await handleTopups(topupRequest(env, cents), env as never);
      expect(res?.status, `金额 ${cents}`).toBe(200);
      expect(db.rows("topups")[0].denomination_cents).toBe(cents);
      expect(db.rows("topups")[0].product_id).toBeNull();
    }
  });

  it("非整美元、越界、负数、NaN 都被拒绝", async () => {
    for (const raw of [599, 30001, 1250, -100, "abc"]) {
      const db = new FakeD1();
      const env = await makeEnv(db);
      stubUpstream();
      const req = new Request("https://example.com/v1/topups", {
        method: "POST",
        headers: authed(env.token),
        body: JSON.stringify({ denomination_cents: raw }),
      });
      const res = await handleTopups(req, env as never);
      expect(res?.status, String(raw)).toBe(409);
      const body = (await res!.json()) as {
        details: { reason: string; min_cents: number; max_cents: number; whole_dollars: boolean };
      };
      expect(body.details.reason).toBe("invalid_denomination");
      expect(body.details.min_cents).toBe(600);
      expect(body.details.max_cents).toBe(30000);
      expect(body.details.whole_dollars).toBe(true);
      expect(db.rows("topups")).toHaveLength(0);
    }
  });

  it("请求体不是对象或金额不是数字时 409", async () => {
    for (const rawBody of [
      "null",
      "[]",
      JSON.stringify("3600"),
      JSON.stringify({ denomination_cents: "3600" }),
      JSON.stringify({ denomination_cents: ["3600"] }),
    ]) {
      const db = new FakeD1();
      const env = await makeEnv(db);
      stubUpstream();
      const req = new Request("https://example.com/v1/topups", {
        method: "POST",
        headers: authed(env.token),
        body: rawBody,
      });
      const res = await handleTopups(req, env as never);
      expect(res?.status, rawBody).toBe(409);
      const body = (await res!.json()) as { details: { reason: string } };
      expect(body.details.reason).toBe("invalid_denomination");
      expect(db.rows("topups")).toHaveLength(0);
    }
  });

  it("缺 return URL 或 Stripe Key 时表里不新增行", async () => {
    for (const patch of [
      { APP_PAYMENT_RETURN_URL: undefined },
      { STRIPE_SECRET_KEY: undefined },
    ]) {
      const db = new FakeD1();
      const env = await makeEnv(db);
      stubUpstream();

      const res = await handleTopups(topupRequest(env, 2400), { ...env, ...patch } as never);
      expect(res?.status).toBe(502);
      expect(db.rows("topups")).toHaveLength(0);
    }
  });

  it("快捷档缺失/非法不阻断自定义充值，wallet 返回空快捷档", async () => {
    for (const raw of ["[]", "[\"1200\"]", "not-json"]) {
      const db = new FakeD1();
      const env = await makeEnv(db);
      stubUpstream();
      const patched = { ...env, TOPUP_DENOMINATIONS_CENTS: raw };
      const res = await handleTopups(topupRequest(patched as TestEnv, 1000), patched as never);
      expect(res?.status, raw).toBe(200);
      const wallet = await handleTopups(walletRequest(patched as TestEnv), patched as never);
      expect(wallet?.status, raw).toBe(200);
      const body = (await wallet!.json()) as {
        denominations_cents: number[];
        min_topup_cents: number;
        max_topup_cents: number;
      };
      expect(body.denominations_cents).toEqual([]);
      expect(body.min_topup_cents).toBe(600);
      expect(body.max_topup_cents).toBe(30000);
    }
  });

  it("MIN/MAX 缺失或非法时 503", async () => {
    for (const patch of [
      { MIN_TOPUP_CENTS: undefined },
      { MAX_TOPUP_CENTS: undefined },
      { MIN_TOPUP_CENTS: "50" },
      { MIN_TOPUP_CENTS: "abc" },
      { MIN_TOPUP_CENTS: "30000", MAX_TOPUP_CENTS: "600" },
    ]) {
      const db = new FakeD1();
      const env = await makeEnv(db);
      stubUpstream();
      const patched = { ...env, ...patch };
      const res = await handleTopups(topupRequest(patched as TestEnv, 1000), patched as never);
      expect(res?.status, JSON.stringify(patch)).toBe(503);
      const body = (await res!.json()) as { retryable: boolean; details: { reason: string } };
      expect(body.retryable).toBe(false);
      expect(body.details.reason).toBe("topup_config_unavailable");
      expect(db.rows("topups")).toHaveLength(0);
    }
  });

  it("wallet 返回 min/max，并过滤越界/非整美元的快捷档", async () => {
    const db = new FakeD1();
    const env = await makeEnv(db);
    const patched = {
      ...env,
      TOPUP_DENOMINATIONS_CENTS: JSON.stringify([500, 600, 1000, 1250, 2500, 5000, 10000, 35000]),
    };
    const res = await handleTopups(walletRequest(patched as TestEnv), patched as never);
    expect(res?.status).toBe(200);
    const body = (await res!.json()) as {
      denominations_cents: number[];
      min_topup_cents: number;
      max_topup_cents: number;
    };
    expect(body.denominations_cents).toEqual(QUICK_TIERS);
    expect(body.min_topup_cents).toBe(600);
    expect(body.max_topup_cents).toBe(30000);
  });

  it("同一账号一小时内第 6 笔 pending/paid 充值被 429，failed 不计数", async () => {
    const now = Date.now();
    const seed = (db: FakeD1, status: string, ageMs: number, i: number) => {
      db.rows("topups").push({
        id: `top_seed_${status}_${i}`,
        account_id: ACCOUNT,
        denomination_cents: 1000,
        product_id: null,
        checkout_session_id: null,
        checkout_url: null,
        status,
        created_at: now - ageMs,
        paid_at: status === "paid" ? now - ageMs : null,
      });
    };

    const db = new FakeD1();
    const env = await makeEnv(db);
    stubUpstream();
    for (let i = 0; i < 5; i += 1) seed(db, i % 2 === 0 ? "pending" : "paid", 1000, i);
    const blocked = await handleTopups(topupRequest(env, 1000), env as never);
    expect(blocked?.status).toBe(429);
    const blockedBody = (await blocked!.json()) as {
      request_id?: string;
      details: { reason: string };
    };
    expect(blockedBody.details.reason).toBe("topup_rate_limited");
    expect(typeof blockedBody.request_id).toBe("string");
    expect(db.rows("topups")).toHaveLength(5);

    const failedDb = new FakeD1();
    const failedEnv = await makeEnv(failedDb);
    stubUpstream();
    for (let i = 0; i < 4; i += 1) seed(failedDb, "failed", 1000, i);
    const allowed = await handleTopups(topupRequest(failedEnv, 1000), failedEnv as never);
    expect(allowed?.status).toBe(200);
    expect(failedDb.rows("topups")).toHaveLength(5);

    const oldDb = new FakeD1();
    const oldEnv = await makeEnv(oldDb);
    stubUpstream();
    for (let i = 0; i < 5; i += 1) seed(oldDb, "paid", 2 * 60 * 60 * 1000, i);
    const oldAllowed = await handleTopups(topupRequest(oldEnv, 1000), oldEnv as never);
    expect(oldAllowed?.status).toBe(200);
  });

  it("429 不作永久幂等缓存：新 key 或过期后可重试", async () => {
    const now = Date.now();
    const db = new FakeD1();
    const env = await makeEnv(db);
    stubUpstream();
    for (let i = 0; i < 5; i += 1) {
      db.rows("topups").push({
        id: `top_seed_rate_${i}`,
        account_id: ACCOUNT,
        denomination_cents: 1000,
        product_id: null,
        checkout_session_id: null,
        checkout_url: null,
        status: i % 2 === 0 ? "pending" : "paid",
        created_at: now - 1000,
        paid_at: null,
      });
    }

    const keyed = (key: string) =>
      new Request("https://example.com/v1/topups", {
        method: "POST",
        headers: { ...authed(env.token), "Idempotency-Key": key },
        body: JSON.stringify({ denomination_cents: 1000 }),
      });

    const first = await handleTopups(keyed("idem-rate-0001"), env as never);
    expect(first?.status).toBe(429);

    const freshKey = await handleTopups(keyed("idem-rate-0002"), env as never);
    expect(freshKey?.status).toBe(429);

    for (const row of db.rows("topups")) row.status = "failed";

    const newKey = await handleTopups(keyed("idem-rate-0003"), env as never);
    expect(newKey?.status).toBe(200);

    const replay = await handleTopups(keyed("idem-rate-0001"), env as never);
    expect(replay?.status).toBe(429);

    const stored = db
      .rows("idempotency_keys")
      .find((row) => row.key === "idem-rate-0001");
    expect(stored).toBeTruthy();
    stored!.created_at = Date.now() - 61_000;

    const retried = await handleTopups(keyed("idem-rate-0001"), env as never);
    expect(retried?.status).toBe(200);
  });

  it("Stripe key 前缀与环境不匹配时 fail closed", async () => {
    for (const [environment, key] of [
      ["production", "sk_test_wallet"],
      ["dev", "sk_live_wallet"],
    ] as const) {
      const db = new FakeD1();
      const base = await makeEnv(db, environment);
      stubUpstream();
      const env = { ...base, STRIPE_SECRET_KEY: key };
      const res = await handleTopups(topupRequest(env as TestEnv, 2400), env as never);
      expect(res?.status, `${environment}/${key}`).toBe(502);
      expect(db.rows("topups")).toHaveLength(0);
    }
  });

  it("缺 webhook secret 时不建单、不扣款", async () => {
    const db = new FakeD1();
    const base = await makeEnv(db);
    stubUpstream();
    const env = { ...base, STRIPE_WEBHOOK_SECRET: undefined };
    const res = await handleTopups(topupRequest(base, 2400), env as never);
    expect(res?.status).toBe(502);
    expect(db.rows("topups")).toHaveLength(0);
  });

  it("Checkout 请求体用 price_data 携带白名单金额，不预建 Price", async () => {
    const db = new FakeD1();
    const env = await makeEnv(db);
    const upstream = stubUpstream();

    const res = await handleTopups(topupRequest(env, 2400), env as never);
    expect(res?.status).toBe(200);
    const form = upstream.checkoutForm!;
    expect(form.get("mode")).toBe("payment");
    expect(form.get("success_url")).toBe(
      "https://control.example.com/payment/return?session_id={CHECKOUT_SESSION_ID}",
    );
    expect(form.get("cancel_url")).toBe("https://control.example.com/payment/return?canceled=1");
    expect(form.get("customer_email")).toBe("buyer@example.com");
    expect(form.get("client_reference_id")).toBe(db.rows("topups")[0].id);
    expect(form.get("metadata[topup_id]")).toBe(db.rows("topups")[0].id);
    expect(form.get("metadata[account_id]")).toBe(ACCOUNT);
    expect(form.get("line_items[0][quantity]")).toBe("1");
    expect(form.get("line_items[0][price_data][currency]")).toBe("usd");
    expect(form.get("line_items[0][price_data][unit_amount]")).toBe("2400");
    expect(form.get("line_items[0][price_data][product_data][name]")).toBe("Veyl Service Credits");
    expect(form.get("line_items[0][price_data][product_data][description]")).toBe(
      "Prepaid credits for Veyl cloud servers. Use within Veyl only; non-refundable.",
    );
    expect(form.get("locale")).toBe("en");
    expect(form.get("branding_settings[display_name]")).toBe("Veyl");
    expect(form.get("branding_settings[background_color]")).toBe("#FAFAF8");
    expect(form.get("branding_settings[button_color]")).toBe("#14161C");
    expect(form.get("branding_settings[font_family]")).toBe("inter");
    expect(form.get("branding_settings[border_style]")).toBe("rounded");
    expect(form.get("branding_settings[logo][type]")).toBe("url");
    expect(form.get("branding_settings[logo][url]")).toBe(
      "https://veyl-edge-dev.pages.dev/logo.png",
    );
    expect(form.get("custom_text[submit][message]")).toBe(
      "Credits are added to your Veyl account after payment.",
    );
    expect(form.get("custom_text[after_submit][message]")).toBe(
      "Return to the Veyl app to see your credits. Cards post instantly; WeChat Pay and Alipay may take a few minutes.",
    );
    expect(form.get("consent_collection[terms_of_service]")).toBe("required");
    expect(form.get("payment_method_types")).toBeNull();
    expect(form.get("payment_method_options[wechat_pay][client]")).toBe("web");
    expect(upstream.checkoutHeaders?.get("idempotency-key")).toBe(db.rows("topups")[0].id);
  });

  it("生产环境 logo 跟随生产站 origin", async () => {
    const db = new FakeD1();
    const env = {
      ...(await makeEnv(db, "production")),
      STRIPE_SECRET_KEY: "sk_live_wallet",
    };
    const upstream = stubUpstream();

    const res = await handleTopups(topupRequest(env, 1200), env as never);
    expect(res?.status).toBe(200);
    expect(upstream.checkoutForm?.get("branding_settings[logo][url]")).toBe(
      "https://veyl.dessage.xyz/logo.png",
    );
  });

  it("Stripe 建会话失败时把 pending 标 failed，不返回上游原文", async () => {
    const db = new FakeD1();
    const env = await makeEnv(db);
    stubUpstream({ checkout: { status: 400, body: JSON.stringify({ error: { code: "parameter_invalid" } }) } });

    const res = await handleTopups(topupRequest(env, 2400), env as never);
    expect(res?.status).toBe(502);
    const body = (await res!.json()) as { details: { reason: string } };
    expect(body.details.reason).toBe("checkout_unavailable");
    expect(db.rows("topups")[0].status).toBe("failed");
  });
});

describe("Stripe 回调验签", () => {
  it("新鲜时间戳但 v1 不匹配 → 401，覆盖 HMAC 失败", async () => {
    const db = new FakeD1();
    const env = await makeEnv(db);
    stubUpstream();
    seedTopup(db);

    const timestamp = String(Math.floor(Date.now() / 1000));
    const res = await handleStripeWebhook(
      await webhookRequest(stripeEvent("checkout.session.completed", checkoutSession()), {
        signature: `t=${timestamp},v1=${"a".repeat(64)}`,
      }),
      env as never,
    );
    expect(res?.status).toBe(401);
    const body = (await res!.json()) as { details: { reason: string } };
    expect(body.details.reason).toBe("mismatch");
    expect(db.rows("accounts")[0].balance_cents).toBe(0);
    expect(db.rows("wallet_ledger")).toHaveLength(0);
  });

  it("签名正确但 body 被篡改 → 401", async () => {
    const db = new FakeD1();
    const env = await makeEnv(db);
    stubUpstream();
    seedTopup(db);

    const timestamp = String(Math.floor(Date.now() / 1000));
    const original = JSON.stringify(stripeEvent("checkout.session.completed", checkoutSession()));
    const signature = await signStripe(original, timestamp);
    const tampered = JSON.stringify(
      stripeEvent("checkout.session.completed", checkoutSession({ amount_total: 999_999 })),
    );
    const res = await handleStripeWebhook(
      new Request("https://example.com/v1/webhooks/stripe", {
        method: "POST",
        headers: { "stripe-signature": `t=${timestamp},v1=${signature}` },
        body: tampered,
      }),
      env as never,
    );
    expect(res?.status).toBe(401);
    const body = (await res!.json()) as { details: { reason: string } };
    expect(body.details.reason).toBe("mismatch");
    expect(db.rows("accounts")[0].balance_cents).toBe(0);
  });

  it("缺 Stripe-Signature 头 → 401 missing_header", async () => {
    const db = new FakeD1();
    const env = await makeEnv(db);
    stubUpstream();

    const res = await handleStripeWebhook(
      new Request("https://example.com/v1/webhooks/stripe", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
      env as never,
    );
    expect(res?.status).toBe(401);
    const body = (await res!.json()) as { details: { reason: string } };
    expect(body.details.reason).toBe("missing_header");
  });

  it("头里只有 t、没有 v1 → 401 no_v1", async () => {
    const db = new FakeD1();
    const env = await makeEnv(db);
    stubUpstream();

    const timestamp = String(Math.floor(Date.now() / 1000));
    const res = await handleStripeWebhook(
      new Request("https://example.com/v1/webhooks/stripe", {
        method: "POST",
        headers: { "stripe-signature": `t=${timestamp}` },
        body: "{}",
      }),
      env as never,
    );
    expect(res?.status).toBe(401);
    const body = (await res!.json()) as { details: { reason: string } };
    expect(body.details.reason).toBe("no_v1");
  });

  it("event.livemode 与环境不一致时 400", async () => {
    const db = new FakeD1();
    const env = await makeEnv(db);
    stubUpstream();
    seedTopup(db);

    const res = await handleStripeWebhook(
      await webhookRequest(
        stripeEvent("checkout.session.completed", checkoutSession(), "evt_live_mode", true),
      ),
      env as never,
    );
    expect(res?.status).toBe(400);
    expect(db.rows("accounts")[0].balance_cents).toBe(0);
  });

  it("时间戳超出 5 分钟按重放拒绝", async () => {
    const db = new FakeD1();
    const env = await makeEnv(db);
    stubUpstream();
    const stale = String(Math.floor(Date.now() / 1000) - 3600);
    const res = await handleStripeWebhook(
      await webhookRequest(stripeEvent("checkout.session.completed", checkoutSession()), {
        timestamp: stale,
      }),
      env as never,
    );
    expect(res?.status).toBe(401);
    const body = (await res!.json()) as { details: { reason: string } };
    expect(body.details.reason).toBe("stale_timestamp");
  });

  it("忽略 v0，只要任一 v1 正确就通过", async () => {
    const db = new FakeD1();
    const env = await makeEnv(db);
    stubUpstream();
    seedTopup(db);

    const res = await handleStripeWebhook(
      await webhookRequest(stripeEvent("checkout.session.completed", checkoutSession()), {
        extraV0: true,
      }),
      env as never,
    );
    expect(res?.status).toBe(200);
    expect(db.rows("accounts")[0].balance_cents).toBe(1200);
  });

  it("未订阅的事件记成 processed，返回 200", async () => {
    const db = new FakeD1();
    const env = await makeEnv(db);
    stubUpstream();
    seedTopup(db);

    const res = await handleStripeWebhook(
      await webhookRequest(stripeEvent("charge.refunded", checkoutSession())),
      env as never,
    );
    expect(res?.status).toBe(200);
    expect(db.rows("accounts")[0].balance_cents).toBe(0);
    expect(db.rows("webhook_events")[0].status).toBe("processed");
  });

  it("body 超过 256 KiB 返回 413", async () => {
    const db = new FakeD1();
    const env = await makeEnv(db);
    stubUpstream();

    const timestamp = String(Math.floor(Date.now() / 1000));
    const big = JSON.stringify({
      id: "evt_big",
      type: "checkout.session.completed",
      data: { object: { id: "cs_big", padding: "x".repeat(300_000) } },
    });
    const signature = await signStripe(big, timestamp);
    const res = await handleStripeWebhook(
      new Request("https://example.com/v1/webhooks/stripe", {
        method: "POST",
        headers: { "stripe-signature": `t=${timestamp},v1=${signature}` },
        body: big,
      }),
      env as never,
    );
    expect(res?.status).toBe(413);
  });

  it("声明的 Content-Length 超限时直接 413", async () => {
    const db = new FakeD1();
    const env = await makeEnv(db);
    stubUpstream();

    const res = await handleStripeWebhook(
      new Request("https://example.com/v1/webhooks/stripe", {
        method: "POST",
        headers: {
          "stripe-signature": "t=1,v1=deadbeef",
          "content-length": String(300_000),
        },
        body: "{}",
      }),
      env as never,
    );
    expect(res?.status).toBe(413);
  });
});

describe("Stripe 回调入账", () => {
  it("completed(paid) 入账一次，重复事件与重复 payment_intent 都不重复加钱", async () => {
    const db = new FakeD1();
    const env = await makeEnv(db);
    stubUpstream();
    seedTopup(db);

    const event = stripeEvent("checkout.session.completed", checkoutSession(), "evt_paid_1");
    const first = await handleStripeWebhook(await webhookRequest(event), env as never);
    expect(first?.status).toBe(200);
    expect(db.rows("accounts")[0].balance_cents).toBe(1200);
    expect(db.rows("topups")[0].status).toBe("paid");
    expect(db.rows("wallet_ledger")[0].ref_type).toBe("stripe_payment");
    expect(db.rows("wallet_ledger")[0].ref_id).toBe("top_1");

    // 同一 event.id 重投。
    const again = await handleStripeWebhook(await webhookRequest(event), env as never);
    expect(again?.status).toBe(200);
    expect(db.rows("accounts")[0].balance_cents).toBe(1200);
    expect(db.rows("wallet_ledger")).toHaveLength(1);

    // 不同 event.id、同一个 payment_intent：payments / 账本都不重复。
    const other = stripeEvent("checkout.session.completed", checkoutSession(), "evt_paid_2");
    const third = await handleStripeWebhook(await webhookRequest(other), env as never);
    expect(third?.status).toBe(200);
    expect(db.rows("accounts")[0].balance_cents).toBe(1200);
    expect(db.rows("wallet_ledger")).toHaveLength(1);
    expect(db.rows("payments")).toHaveLength(1);
  });

  it("无 payment_intent 时同一 session 的两个事件只入账一次", async () => {
    const db = new FakeD1();
    const env = await makeEnv(db);
    stubUpstream();
    seedTopup(db);

    const session = checkoutSession({ payment_intent: null });
    const completed = stripeEvent("checkout.session.completed", session, "evt_no_pi_1");
    const first = await handleStripeWebhook(await webhookRequest(completed), env as never);
    expect(first?.status).toBe(200);
    expect(db.rows("accounts")[0].balance_cents).toBe(1200);
    expect(db.rows("payments")).toHaveLength(1);
    expect(db.rows("wallet_ledger")).toHaveLength(1);
    expect(db.rows("wallet_ledger")[0].ref_id).toBe("top_1");
    expect(db.rows("payments")[0].id).toBe("cs_1");

    const asyncEvent = stripeEvent(
      "checkout.session.async_payment_succeeded",
      checkoutSession({ payment_intent: null }),
      "evt_no_pi_2",
    );
    const second = await handleStripeWebhook(await webhookRequest(asyncEvent), env as never);
    expect(second?.status).toBe(200);
    expect(db.rows("accounts")[0].balance_cents).toBe(1200);
    expect(db.rows("payments")).toHaveLength(1);
    expect(db.rows("wallet_ledger")).toHaveLength(1);
  });

  it("币种不是 USD 时不入账，写 currency_mismatch", async () => {
    const db = new FakeD1();
    const env = await makeEnv(db);
    stubUpstream();
    seedTopup(db);

    const res = await handleStripeWebhook(
      await webhookRequest(
        stripeEvent("checkout.session.completed", checkoutSession({ currency: "eur" })),
      ),
      env as never,
    );
    expect(res?.status).toBe(200);
    expect(db.rows("accounts")[0].balance_cents).toBe(0);
    expect(db.rows("topups")[0].status).toBe("pending");
    expect(db.rows("unmatched_payments")[0].reason).toBe("currency_mismatch");
  });

  it("amount_total 与本地面额不一致时不入账，写 amount_mismatch", async () => {
    const db = new FakeD1();
    const env = await makeEnv(db);
    stubUpstream();
    seedTopup(db);

    const res = await handleStripeWebhook(
      await webhookRequest(
        stripeEvent("checkout.session.completed", checkoutSession({ amount_total: 9999 })),
      ),
      env as never,
    );
    expect(res?.status).toBe(200);
    expect(db.rows("accounts")[0].balance_cents).toBe(0);
    expect(db.rows("topups")[0].status).toBe("pending");
    expect(db.rows("unmatched_payments")[0].reason).toBe("amount_mismatch");
  });

  it("completed(unpaid) 不入账，等 async_payment_succeeded 才入账", async () => {
    const db = new FakeD1();
    const env = await makeEnv(db);
    stubUpstream();
    seedTopup(db);

    const completed = stripeEvent(
      "checkout.session.completed",
      checkoutSession({ payment_status: "unpaid" }),
    );
    const first = await handleStripeWebhook(await webhookRequest(completed), env as never);
    expect(first?.status).toBe(200);
    expect(db.rows("accounts")[0].balance_cents).toBe(0);
    expect(db.rows("topups")[0].status).toBe("pending");

    const async = stripeEvent(
      "checkout.session.async_payment_succeeded",
      checkoutSession({ payment_status: "paid" }),
    );
    const second = await handleStripeWebhook(await webhookRequest(async), env as never);
    expect(second?.status).toBe(200);
    expect(db.rows("accounts")[0].balance_cents).toBe(1200);
    expect(db.rows("topups")[0].status).toBe("paid");
  });

  it("async_payment_failed 把 pending 的充值单标成 failed", async () => {
    const db = new FakeD1();
    const env = await makeEnv(db);
    stubUpstream();
    seedTopup(db);

    const event = stripeEvent(
      "checkout.session.async_payment_failed",
      checkoutSession({ payment_status: "unpaid" }),
    );
    const res = await handleStripeWebhook(await webhookRequest(event), env as never);
    expect(res?.status).toBe(200);
    expect(db.rows("topups")[0].status).toBe("failed");
    expect(db.rows("accounts")[0].balance_cents).toBe(0);
  });

  it("checkout.session.expired 把 pending 的充值单标成 failed", async () => {
    const db = new FakeD1();
    const env = await makeEnv(db);
    stubUpstream();
    seedTopup(db);

    const event = stripeEvent(
      "checkout.session.expired",
      checkoutSession({ payment_status: "unpaid" }),
    );
    const res = await handleStripeWebhook(await webhookRequest(event), env as never);
    expect(res?.status).toBe(200);
    expect(db.rows("topups")[0].status).toBe("failed");
    expect(db.rows("accounts")[0].balance_cents).toBe(0);
    expect(db.rows("webhook_events")[0].status).toBe("processed");
  });

  it("充值入账后恢复 expired 服务器，恢复失败不影响 200", async () => {
    const db = new FakeD1();
    const env = await makeEnv(db);
    stubUpstream();
    seedTopup(db);
    const now = Date.now();
    const DAY = 24 * 3600 * 1000;
    db.rows("servers").push({
      id: "srv_recover",
      account_id: ACCOUNT,
      state: "running",
      destroyed_at: null,
      daily_price_cents: 30,
      billing_anchor_at: now - 10 * DAY,
      paid_until: now - 2 * DAY,
      billing_state: "expired",
      provider_id: "do-1",
    });

    const res = await handleStripeWebhook(
      await webhookRequest(stripeEvent("checkout.session.completed", checkoutSession())),
      env as never,
    );
    expect(res?.status).toBe(200);
    expect(db.rows("servers")[0].billing_state).toBe("active");
    expect(db.rows("wallet_ledger").some((row) => row.ref_type === "server_day")).toBe(true);
  });

  it("metadata 缺失时退到 client_reference_id", async () => {
    const db = new FakeD1();
    const env = await makeEnv(db);
    stubUpstream();
    seedTopup(db);

    const session = checkoutSession({
      metadata: null,
      client_reference_id: "top_1",
    });
    const res = await handleStripeWebhook(
      await webhookRequest(stripeEvent("checkout.session.completed", session)),
      env as never,
    );
    expect(res?.status).toBe(200);
    expect(db.rows("accounts")[0].balance_cents).toBe(1200);
  });

  it("前两层都缺时退到 checkout_session_id", async () => {
    const db = new FakeD1();
    const env = await makeEnv(db);
    stubUpstream();
    seedTopup(db);

    const session = checkoutSession({
      metadata: null,
      client_reference_id: null,
      id: "cs_1",
    });
    const res = await handleStripeWebhook(
      await webhookRequest(stripeEvent("checkout.session.completed", session)),
      env as never,
    );
    expect(res?.status).toBe(200);
    expect(db.rows("accounts")[0].balance_cents).toBe(1200);
  });

  it("三层都匹配不上：写 unmatched_payments 留证并返回 200", async () => {
    const db = new FakeD1();
    const env = await makeEnv(db);
    stubUpstream();
    seedTopup(db);

    const session = checkoutSession({
      id: "cs_unknown",
      metadata: null,
      client_reference_id: null,
    });
    const res = await handleStripeWebhook(
      await webhookRequest(stripeEvent("checkout.session.completed", session)),
      env as never,
    );
    expect(res?.status).toBe(200);
    expect(db.rows("accounts")[0].balance_cents).toBe(0);
    expect(db.rows("unmatched_payments")).toHaveLength(1);
    expect(db.rows("unmatched_payments")[0].reason).toBe("no_metadata");
  });

  it("有 topup 引用但匹配不上：reason=unknown_topup", async () => {
    const db = new FakeD1();
    const env = await makeEnv(db);
    stubUpstream();
    seedTopup(db);

    const session = checkoutSession({
      id: "cs_unknown",
      metadata: { topup_id: "top_unknown" },
      client_reference_id: null,
    });
    const res = await handleStripeWebhook(
      await webhookRequest(stripeEvent("checkout.session.completed", session)),
      env as never,
    );
    expect(res?.status).toBe(200);
    expect(db.rows("unmatched_payments")[0].reason).toBe("unknown_topup");
  });

  it("账户已不存在：留证 missing_account，不 5xx", async () => {
    const db = new FakeD1();
    const env = await makeEnv(db);
    stubUpstream();
    seedTopup(db, { account_id: "acct_missing000000000000" });

    const res = await handleStripeWebhook(
      await webhookRequest(stripeEvent("checkout.session.completed", checkoutSession())),
      env as never,
    );
    expect(res?.status).toBe(200);
    expect(db.rows("wallet_ledger")).toHaveLength(0);
    expect(db.rows("unmatched_payments")[0].reason).toBe("missing_account");
  });
});

describe("Stripe 回调样本（dev）", () => {
  it("脱敏样本：签名、evt_/cs_/pi_、邮箱、金额、topup id 都换成占位值", async () => {
    const db = new FakeD1();
    const env = await makeEnv(db);
    stubUpstream();
    seedTopup(db);

    const event = stripeEvent(
      "checkout.session.completed",
      checkoutSession({
        id: "cs_live_secret",
        payment_intent: "pi_live_secret",
        customer_details: { email: "real.buyer@example.net" },
        metadata: { topup_id: "top_1", account_id: ACCOUNT },
      }),
      "evt_live_secret",
    );
    const res = await handleStripeWebhook(await webhookRequest(event), env as never);
    expect(res?.status).toBe(200);

    expect(db.rows("webhook_samples")).toHaveLength(1);
    const sample = db.rows("webhook_samples")[0];
    const headers = JSON.parse(String(sample.headers)) as Record<string, string>;
    expect(headers["stripe-signature"]).toBe("***");

    const body = JSON.parse(String(sample.body)) as {
      id: string;
      type: string;
      data: {
        object: {
          id: string;
          object: string;
          mode: string;
          payment_status: string;
          payment_intent: string;
          customer_details: { email: string };
          metadata: { topup_id: string };
          amount_total: number;
          consent: { terms_of_service: string };
        };
      };
    };
    expect(body.id).toBe("evt_sample0000000000000");
    expect(body.data.object.id).toBe("cs_sample00000000000000");
    expect(body.data.object.payment_intent).toBe("pi_sample00000000000000");
    expect(body.data.object.customer_details.email).toBe("buyer@example.com");
    expect(body.data.object.metadata.topup_id).toBe("top_sample00000000000000");
    expect(body.data.object.payment_status).toBe("paid");
    expect(body.data.object.object).toBe("checkout.session");
    expect(body.data.object.mode).toBe("payment");
    expect(body.data.object.consent.terms_of_service).toBe("accepted");
    expect(body.data.object.amount_total).toBe(1000);
    expect(String(sample.body)).not.toContain("cs_live_secret");
    expect(String(sample.body)).not.toContain("pi_live_secret");
    expect(String(sample.body)).not.toContain("evt_live_secret");
    expect(String(sample.body)).not.toContain("real.buyer@example.net");
    // 捕获不影响正常入账。
    expect(db.rows("accounts")[0].balance_cents).toBe(1200);
  });

  it("对象型 PII、payment_method 与未知字段按 allowlist 占位", async () => {
    const db = new FakeD1();
    const env = await makeEnv(db);
    stubUpstream();
    seedTopup(db);

    const event = stripeEvent(
      "checkout.session.completed",
      checkoutSession({
        customer_details: {
          email: "real.buyer@example.net",
          phone_number: "+65 9123 4567",
          billing_address: {
            line1: "1 Secret Road",
            line2: "#02-01",
            postal_code: "123456",
            country: "SG",
          },
        },
        payment_method: { type: "card", last4: "4242", brand: "visa", expiry: "12/29" },
        metadata: { topup_id: "top_1", uid: 12345, plan: "s-1vcpu-1gb" },
        payment_method_id: "pm_live_abcdef",
        ip: "198.51.100.9",
        zip_code: 123456,
        checkout_url: "https://checkout.stripe.com/session/cs_live_secret",
      }),
    );
    const res = await handleStripeWebhook(await webhookRequest(event), env as never);
    expect(res?.status).toBe(200);

    const sample = db.rows("webhook_samples")[0];
    const body = JSON.parse(String(sample.body)) as {
      data: {
        object: {
          customer_details: { email: string; phone_number: string; billing_address: string };
          payment_method: { type: string; last4: string; brand: string; expiry: string };
          metadata: { topup_id: string; uid: number; plan: string };
          payment_method_id: string;
          ip: string;
          zip_code: string;
          checkout_url: string;
        };
      };
    };
    expect(body.data.object.customer_details.email).toBe("buyer@example.com");
    expect(body.data.object.customer_details.phone_number).toBe("***");
    expect(body.data.object.customer_details.billing_address).toBe("***");
    expect(body.data.object.payment_method).toEqual({
      type: "***",
      last4: "***",
      brand: "***",
      expiry: "***",
    });
    expect(body.data.object.metadata.uid).toBe(0);
    // 未知字符串一律占位；Stripe Checkout 不再带 Dodo 时期的 plan 键。
    expect(body.data.object.metadata.plan).toBe("***");
    expect(body.data.object.metadata.topup_id).toBe("top_sample00000000000000");
    expect(body.data.object.payment_method_id).toBe("pm_sample00000000000000");
    expect(body.data.object.ip).toBe("***");
    expect(body.data.object.zip_code).toBe("***");
    expect(body.data.object.checkout_url).toBe("https://checkout.example.com/sample");
    expect(String(sample.body)).not.toContain("Secret Road");
    expect(String(sample.body)).not.toContain("cs_live_secret");
  });

  it("请求头 allowlist 只留 stripe-signature 等必要头", async () => {
    const db = new FakeD1();
    const env = await makeEnv(db);
    stubUpstream();
    seedTopup(db);

    const base = await webhookRequest(
      stripeEvent("checkout.session.completed", checkoutSession()),
    );
    const bodyText = await base.text();
    const headers = new Headers(base.headers);
    headers.set("user-agent", "Stripe/1.0");
    headers.set("x-real-ip", "198.51.100.9");
    headers.set("x-custom", "should-not-be-stored");
    const request = new Request(base.url, { method: "POST", headers, body: bodyText });

    const res = await handleStripeWebhook(request, env as never);
    expect(res?.status).toBe(200);

    const stored = JSON.parse(String(db.rows("webhook_samples")[0].headers)) as Record<string, string>;
    expect(Object.keys(stored).sort()).toEqual([
      "content-type",
      "stripe-signature",
      "user-agent",
    ]);
    expect(String(db.rows("webhook_samples")[0].headers)).not.toContain("198.51.100.9");
  });

  it("捕获失败不影响回调处理", async () => {
    const db = new FakeD1();
    const env = await makeEnv(db);
    stubUpstream();
    seedTopup(db);
    db.beforeWebhookSample = () => {
      throw new Error("d1 down");
    };

    const res = await handleStripeWebhook(
      await webhookRequest(stripeEvent("checkout.session.completed", checkoutSession())),
      env as never,
    );
    expect(res?.status).toBe(200);
    expect(db.rows("accounts")[0].balance_cents).toBe(1200);
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

describe("支付回跳页 /payment/return", () => {
  const env = {
    ENVIRONMENT: "dev",
    PUBLIC_SITE_URL: "https://veyl.dessage.xyz",
    STRIPE_SECRET_KEY: "sk_test_return",
  } as unknown as Env;

  const get = (query: string, acceptLanguage?: string) =>
    route(
      new Request(`https://control.example.com/payment/return${query}`, {
        headers: acceptLanguage ? { "accept-language": acceptLanguage } : {},
      }),
      env,
    );

  function stubSession(body: unknown, status = 200) {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        calls.push(String(input));
        return new Response(JSON.stringify(body), { status });
      }),
    );
    return calls;
  }

  it("paid 才显示完成页，强制英文、只查一次 Stripe、不回显 session_id", async () => {
    const calls = stubSession({ status: "complete", payment_status: "paid" });
    // 即便浏览器偏好中文，支付页也保持英文（美国公司）。
    const res = await get("?session_id=cs_test_123", "zh-CN,zh;q=0.9,en;q=0.8");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("no-store");
    const html = await res.text();
    expect(calls).toEqual(["https://api.stripe.com/v1/checkout/sessions/cs_test_123"]);
    expect(html).toContain('<html lang="en">');
    expect(html).toContain("Payment complete");
    expect(html).toContain(
      "Return to the Veyl app to view your service credits. You can close this page.",
    );
    expect(html).toContain('href="https://veyl.dessage.xyz"');
    expect(html).toContain("Learn about Veyl");
    expect(html).toContain('name="robots" content="noindex"');
    expect(html).toContain('stroke="#1B7A4E"');
    expect(html).not.toContain("cs_test_123");
    expect(html).not.toContain("支付");
  });

  it("unpaid + complete 显示处理中，不宣称完成也不给绿勾", async () => {
    stubSession({ status: "complete", payment_status: "unpaid" });
    const html = await (await get("?session_id=cs_test_123", "zh-CN")).text();
    expect(html).toContain('<html lang="en">');
    expect(html).toContain("Payment processing");
    expect(html).toContain(
      "WeChat Pay or Alipay can take a few minutes to settle. Your credits update automatically once it does; you can close this page.",
    );
    expect(html).not.toContain("Payment complete");
    expect(html).not.toContain('stroke="#1B7A4E"');
    expect(html).toContain('stroke="#9A6B12"');
    expect(html).not.toContain("cs_test_123");
    expect(html).not.toContain("支付");
  });

  it("session 仍 open / 已过期时不给完成页", async () => {
    for (const session of [
      { status: "open", payment_status: "unpaid" },
      { status: "expired", payment_status: "unpaid" },
    ]) {
      stubSession(session);
      const html = await (await get("?session_id=cs_test_123", "zh-CN")).text();
      expect(html).toContain("Payment flow ended");
      expect(html).not.toContain("Payment complete");
      expect(html).not.toContain('stroke="#1B7A4E"');
      expect(html).not.toContain("cs_test_123");
    }
  });

  it("Stripe 查询失败时回落中性提示", async () => {
    stubSession({ error: { message: "upstream" } }, 500);
    const html = await (await get("?session_id=cs_test_123", "zh-CN")).text();
    expect(html).toContain("Payment flow ended");
    expect(html).not.toContain("Payment complete");
    expect(html).not.toContain('stroke="#1B7A4E"');
    expect(html).not.toContain("cs_test_123");
  });

  it("open + paid 的异常组合不给完成页", async () => {
    stubSession({ status: "open", payment_status: "paid" });
    const html = await (await get("?session_id=cs_test_123", "zh-CN")).text();
    expect(html).toContain("Payment flow ended");
    expect(html).not.toContain("Payment complete");
    expect(html).not.toContain('stroke="#1B7A4E"');
  });

  it("Stripe 请求网络抛错时回落中性提示", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );
    const html = await (await get("?session_id=cs_test_123", "zh-CN")).text();
    expect(html).toContain("Payment flow ended");
    expect(html).not.toContain("Payment complete");
    expect(html).not.toContain('stroke="#1B7A4E"');
  });

  it("Stripe 请求超时（TimeoutError）时回落中性提示", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        const error = new Error("The operation timed out");
        error.name = "TimeoutError";
        throw error;
      }),
    );
    const html = await (await get("?session_id=cs_test_123", "zh-CN")).text();
    expect(html).toContain("Payment flow ended");
    expect(html).not.toContain("Payment complete");
  });

  it("Stripe 返回非 JSON 时回落中性提示", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("not json", { status: 200 })));
    const html = await (await get("?session_id=cs_test_123", "zh-CN")).text();
    expect(html).toContain("Payment flow ended");
    expect(html).not.toContain("Payment complete");
  });

  it("Stripe 返回缺 status / payment_status 时回落中性提示", async () => {
    for (const body of [{ status: "complete" }, { payment_status: "paid" }, {}]) {
      stubSession(body);
      const html = await (await get("?session_id=cs_test_123", "zh-CN")).text();
      expect(html).toContain("Payment flow ended");
      expect(html).not.toContain("Payment complete");
    }
  });

  it("非法 session_id 形状不请求 Stripe，直接中性页", async () => {
    const calls = stubSession({ status: "complete", payment_status: "paid" });
    const html = await (await get("?session_id=../../v1/charges", "zh-CN")).text();
    expect(calls).toHaveLength(0);
    expect(html).toContain("Payment flow ended");
    expect(html).not.toContain("Payment complete");
  });

  it("canceled=1 返回未完成，优先于 session_id 且不查询 Stripe", async () => {
    const calls = stubSession({ status: "complete", payment_status: "paid" });
    const res = await get("?canceled=1&session_id=cs_test_123", "zh-CN");
    expect(calls).toHaveLength(0);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<html lang="en">');
    expect(html).toContain("Payment not completed");
    expect(html).toContain(
      "Return to the Veyl app to start the top-up again. You can close this page.",
    );
    expect(html).not.toContain("Payment complete");
    expect(html).not.toContain('stroke="#1B7A4E"');
    expect(html).not.toContain("cs_test_123");
    expect(html).toContain('href="https://veyl.dessage.xyz"');
    expect(html).not.toContain("支付");
  });

  it("没有 canceled / session_id 时返回中性页且不查询 Stripe", async () => {
    const calls = stubSession({ status: "complete", payment_status: "paid" });
    const res = await get("", "zh-CN");
    expect(calls).toHaveLength(0);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<html lang="en">');
    expect(html).toContain("Payment flow ended");
    expect(html).toContain(
      "Return to the Veyl app to see the result. You can close this page.",
    );
    expect(html).not.toContain("Payment complete");
    expect(html).not.toContain('stroke="#1B7A4E"');
    expect(html).toContain('href="https://veyl.dessage.xyz"');
    expect(html).not.toContain("支付");
  });
});
