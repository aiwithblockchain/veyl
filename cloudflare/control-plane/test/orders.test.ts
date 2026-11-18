import { afterEach, describe, expect, it, vi } from "vitest";

import { handleOrders } from "../src/orders";
import { signAccessToken, sha256B64u } from "../src/lib/crypto";
import { FakeD1 } from "./helpers/fakeD1";

const ACCOUNT = "acct_test0000000000000000";
const DEVICE = "dev_test00000000000000000";

async function signingJwk(): Promise<string> {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  return JSON.stringify(await crypto.subtle.exportKey("jwk", pair.privateKey));
}

async function envWith(db: FakeD1, jwk: string) {
  db.rows("accounts").push({ id: ACCOUNT, status: "active" });
  db.rows("devices").push({ id: DEVICE, account_id: ACCOUNT, revoked_at: null });
  const token = await signAccessToken(jwk, {
    sub: ACCOUNT,
    did: DEVICE,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 600,
    jti: "jti_test",
  });
  return {
    DB: db as unknown as D1Database,
    TOKEN_SIGNING_JWK: jwk,
    DO_API_TOKEN: "do-token",
    ENROLL_BASE_URL: "https://control.example.com",
    ENVIRONMENT: "test",
    PLAN_DAILY_PRICE_CENTS: JSON.stringify({ "s-1vcpu-512mb-10gb": 20, "s-1vcpu-1gb": 30, "s-1vcpu-2gb": 60 }),
    token,
  };
}

function stubCatalog() {
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
      if (href.endsWith("/droplets") && init?.method === "POST") {
        return new Response(
          JSON.stringify({
            droplet: { id: 424242, status: "new", networks: { v4: [] } },
          }),
          { status: 202 },
        );
      }
      return new Response(
        JSON.stringify({
          sizes: [
            { slug: "s-1vcpu-512mb-10gb", memory: 512, vcpus: 1, price_hourly: 0.00595, price_monthly: 4, transfer: 0.5, regions: ["sgp1"] },
            { slug: "s-1vcpu-1gb", memory: 1024, vcpus: 1, price_hourly: 0.00893, price_monthly: 6, transfer: 1, regions: ["sgp1"] },
          ],
        }),
        { status: 200 },
      );
    }),
  );
}

/** 目录里 s-1vcpu-1gb 只支持 nyc3：验证地区 × 档位只看目录，不靠推断。 */
function stubCatalogRegionMismatch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request) => {
      const href = String(input);
      if (href.includes("/regions")) {
        return new Response(
          JSON.stringify({
            regions: [
              { slug: "sgp1", name: "Singapore 1", available: true },
              { slug: "nyc3", name: "New York 3", available: true },
            ],
          }),
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
              regions: ["nyc3"],
            },
          ],
        }),
        { status: 200 },
      );
    }),
  );
}

function orderRequest(token: string, key: string, body: unknown = { region: "sgp1", plan: "s-1vcpu-1gb" }) {
  return new Request("https://example.com/v1/orders", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "Idempotency-Key": key },
    body: JSON.stringify(body),
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("orders", () => {
  it("下单成功并按目录取价", async () => {
    const db = new FakeD1();
    const env = await envWith(db, await signingJwk());
    stubCatalog();

    const res = await handleOrders(orderRequest(env.token, "idem-key-0001"), env as never);
    expect(res?.status).toBe(200);
    const body = (await res!.json()) as { order_id: string; amount_usd: number; state: string; region: string };
    expect(body.state).toBe("pending_payment");
    expect(body.amount_usd).toBe(0.3);
    expect(body.region).toBe("sgp1");
    expect(body.order_id.startsWith("ord_")).toBe(true);
    // amount_cents 是 NOT NULL：下单必须落这一列，否则线上建单会撞约束。
    expect((db.rows("orders")[0] as { amount_cents?: number }).amount_cents).toBe(30);
  });

  it("在途的幂等占位会拒绝重复请求，超时未完成的会被接管", async () => {
    const db = new FakeD1();
    const env = await envWith(db, await signingJwk());
    stubCatalog();
    const requestHash = await sha256B64u(
      JSON.stringify({ region: "sgp1", plan: "s-1vcpu-1gb" }),
    );
    const seedClaim = (createdAt: number) => {
      db.rows("idempotency_keys").length = 0;
      db.rows("idempotency_keys").push({
        account_id: ACCOUNT,
        endpoint: "orders.create",
        key: "idem-key-inflight",
        request_hash: requestHash,
        status: 0,
        response: null,
        created_at: createdAt,
      });
    };

    seedClaim(Date.now() - 1000);
    const blocked = await handleOrders(orderRequest(env.token, "idem-key-inflight"), env as never);
    expect(blocked?.status).toBe(409);
    expect(((await blocked!.json()) as { details: { reason: string } }).details.reason).toBe(
      "idempotency_in_flight",
    );

    // 占位超过 2 分钟没写完：视为进程已死，允许接管并正常下单。
    seedClaim(Date.now() - 10 * 60 * 1000);
    const taken = await handleOrders(orderRequest(env.token, "idem-key-inflight"), env as never);
    expect(taken?.status).toBe(200);
    expect(db.rows("orders")).toHaveLength(1);
  });

  it("同一幂等键重复下单只产生一笔订单", async () => {    const db = new FakeD1();
    const env = await envWith(db, await signingJwk());
    stubCatalog();

    const first = await handleOrders(orderRequest(env.token, "idem-key-0002"), env as never);
    const firstBody = (await first!.json()) as { order_id: string };
    const second = await handleOrders(orderRequest(env.token, "idem-key-0002"), env as never);
    const secondBody = (await second!.json()) as { order_id: string };

    expect(secondBody.order_id).toBe(firstBody.order_id);
    expect(db.rows("orders")).toHaveLength(1);
  });

  it("同键不同请求体被拒绝", async () => {
    const db = new FakeD1();
    const env = await envWith(db, await signingJwk());
    stubCatalog();

    await handleOrders(orderRequest(env.token, "idem-key-0003"), env as never);
    const conflict = await handleOrders(
      orderRequest(env.token, "idem-key-0003", { region: "sgp1", plan: "s-1vcpu-512mb-10gb" }),
      env as never,
    );
    expect(conflict?.status).toBe(409);
    const body = (await conflict!.json()) as { details: { reason: string } };
    expect(body.details.reason).toBe("idempotency_conflict");
  });

  it("没配售价的套餐不卖，不拿 DigitalOcean 成本价兜底", async () => {
    const db = new FakeD1();
    const env = await envWith(db, await signingJwk());
    stubCatalog();

    const res = await handleOrders(
      orderRequest(env.token, "idem-key-price", { region: "sgp1", plan: "s-1vcpu-512mb-10gb" }),
      { ...env, PLAN_DAILY_PRICE_CENTS: JSON.stringify({ "s-1vcpu-1gb": 30 }) } as never,
    );
    expect(res?.status).toBe(409);
    const body = (await res!.json()) as { details: { reason: string } };
    expect(body.details.reason).toBe("invalid_plan");
    expect(db.rows("orders")).toHaveLength(0);
  });

  it("不可售的套餐被拒绝", async () => {
    const db = new FakeD1();
    const env = await envWith(db, await signingJwk());
    stubCatalog();

    const res = await handleOrders(
      orderRequest(env.token, "idem-key-0004", { region: "sgp1", plan: "s-9vcpu-99gb" }),
      env as never,
    );
    expect(res?.status).toBe(409);
    const body = (await res!.json()) as { details: { reason: string } };
    expect(body.details.reason).toBe("invalid_plan");
  });

  it("余额扣费创建服务器并选定端口", async () => {
    const db = new FakeD1();
    const env = await envWith(db, await signingJwk());
    stubCatalog();

    const created = (await (
      await handleOrders(orderRequest(env.token, "idem-key-0005"), env as never)
    )!.json()) as { order_id: string };
    db.rows("accounts")[0].balance_cents = 2000;

    const checkout = await handleOrders(
      new Request(`https://example.com/v1/orders/${created.order_id}/checkout`, {
        method: "POST",
        headers: { authorization: `Bearer ${env.token}`, "Idempotency-Key": "idem-checkout-1" },
      }),
      env as never,
    );
    expect(checkout?.status).toBe(200);
    const paid = (await checkout!.json()) as { charged_cents: number; balance_after_cents: number };
    // 2.37.1：余额只需覆盖 7 天日价（30 × 7 = 210），实际仍只扣第 1 天的 30。
    expect(paid.charged_cents).toBe(30);
    expect(paid.balance_after_cents).toBe(1970);
    expect(db.rows("servers")).toHaveLength(1);

    const server = db.rows("servers")[0];
    expect(server.node_port).toBeGreaterThanOrEqual(10000);
    expect(server.node_port).toBeLessThan(60000);
    expect(server.state).toBe("booting");
    expect(server.provider_id).toBe("424242");
    expect(typeof server.enrollment_hash).toBe("string");
    // 建机快照：目录 transfer(TB) × 1000 落进 servers 行，供详情展示。
    expect(server.transfer_gib).toBe(1000);
  });

  it("余额不足 7 天日价时拒绝建机，details 带门槛值", async () => {
    const db = new FakeD1();
    const env = await envWith(db, await signingJwk());
    stubCatalog();

    const created = (await (
      await handleOrders(orderRequest(env.token, "idem-key-6d"), env as never)
    )!.json()) as { order_id: string };
    // s-1vcpu-1gb 日价 30：余额只有 6 天（180），门槛是 210，差 30。
    db.rows("accounts")[0].balance_cents = 180;

    const checkout = await handleOrders(
      new Request(`https://example.com/v1/orders/${created.order_id}/checkout`, {
        method: "POST",
        headers: { authorization: `Bearer ${env.token}`, "Idempotency-Key": "idem-checkout-6d" },
      }),
      env as never,
    );
    expect(checkout?.status).toBe(409);
    const body = (await checkout!.json()) as {
      details: { reason: string; required_cents: number; shortfall_cents: number; min_days: number };
    };
    expect(body.details.reason).toBe("insufficient_balance");
    expect(body.details.required_cents).toBe(210);
    expect(body.details.shortfall_cents).toBe(30);
    expect(body.details.min_days).toBe(7);
    // 不扣钱、不建机、订单留在 pending_payment。
    expect(db.rows("accounts")[0].balance_cents).toBe(180);
    expect(db.rows("servers")).toHaveLength(0);
    expect(db.rows("orders")[0].state).toBe("pending_payment");
  });

  it("余额正好 7 天日价时放行，只扣 1 天", async () => {
    const db = new FakeD1();
    const env = await envWith(db, await signingJwk());
    stubCatalog();

    const created = (await (
      await handleOrders(orderRequest(env.token, "idem-key-7d"), env as never)
    )!.json()) as { order_id: string };
    db.rows("accounts")[0].balance_cents = 210;

    const checkout = await handleOrders(
      new Request(`https://example.com/v1/orders/${created.order_id}/checkout`, {
        method: "POST",
        headers: { authorization: `Bearer ${env.token}`, "Idempotency-Key": "idem-checkout-7d" },
      }),
      env as never,
    );
    expect(checkout?.status).toBe(200);
    const paid = (await checkout!.json()) as { charged_cents: number; balance_after_cents: number };
    expect(paid.charged_cents).toBe(30);
    expect(paid.balance_after_cents).toBe(180);
    expect(db.rows("servers")).toHaveLength(1);
  });

  it("预检之后余额被并发花掉，门槛在记账语句里再次拦住", async () => {
    const db = new FakeD1();
    const env = await envWith(db, await signingJwk());
    stubCatalog();

    const created = (await (
      await handleOrders(orderRequest(env.token, "idem-key-race"), env as never)
    )!.json()) as { order_id: string };
    db.rows("accounts")[0].balance_cents = 210;
    // 另一笔扣费在预检之后、记账之前落地：只靠快照会打穿，必须由 INSERT 的守卫挡住。
    db.beforeWalletInsert = () => {
      db.beforeWalletInsert = undefined;
      db.rows("accounts")[0].balance_cents = 179;
    };

    const checkout = await handleOrders(
      new Request(`https://example.com/v1/orders/${created.order_id}/checkout`, {
        method: "POST",
        headers: { authorization: `Bearer ${env.token}`, "Idempotency-Key": "idem-checkout-race" },
      }),
      env as never,
    );
    expect(checkout?.status).toBe(409);
    const body = (await checkout!.json()) as {
      details: { reason: string; required_cents: number; shortfall_cents: number; min_days: number };
    };
    expect(body.details.reason).toBe("insufficient_balance");
    expect(body.details.required_cents).toBe(210);
    expect(body.details.shortfall_cents).toBe(31);
    expect(body.details.min_days).toBe(7);
    expect(db.rows("servers")).toHaveLength(0);
  });

  it("守卫失败后余额被充值补上，重试一次完成扣费", async () => {
    const db = new FakeD1();
    const env = await envWith(db, await signingJwk());
    stubCatalog();

    const created = (await (
      await handleOrders(orderRequest(env.token, "idem-key-retry"), env as never)
    )!.json()) as { order_id: string };
    db.rows("accounts")[0].balance_cents = 210;
    // 第一笔记账被并发扣费挡在守卫外；充值在守卫之后、重试之前落地。
    db.beforeWalletInsert = () => {
      db.beforeWalletInsert = undefined;
      db.rows("accounts")[0].balance_cents = 179;
      queueMicrotask(() => {
        db.rows("accounts")[0].balance_cents = 210;
      });
    };

    const checkout = await handleOrders(
      new Request(`https://example.com/v1/orders/${created.order_id}/checkout`, {
        method: "POST",
        headers: { authorization: `Bearer ${env.token}`, "Idempotency-Key": "idem-checkout-retry" },
      }),
      env as never,
    );
    expect(checkout?.status).toBe(200);
    const paid = (await checkout!.json()) as { charged_cents: number; balance_after_cents: number };
    expect(paid.charged_cents).toBe(30);
    expect(paid.balance_after_cents).toBe(180);
    expect(db.rows("servers")).toHaveLength(1);
    expect(
      db.rows("wallet_ledger").filter((row) => row.ref_type === "order"),
    ).toHaveLength(1);
  });

  it("守卫失败后余额已够但仍记账失败：返回可重试的通用错误，不编差额", async () => {
    const db = new FakeD1();
    const env = await envWith(db, await signingJwk());
    stubCatalog();

    const created = (await (
      await handleOrders(orderRequest(env.token, "idem-key-ghost"), env as never)
    )!.json()) as { order_id: string };
    db.rows("accounts")[0].balance_cents = 210;
    // 两次记账都被守卫挡住；重试之后、回包之前充值到账，余额已经够门槛。
    // 这时差额应为 0（界面会显示「还差 $0.00」），所以只能回通用可重试错误。
    let calls = 0;
    db.beforeWalletInsert = () => {
      calls += 1;
      db.rows("accounts")[0].balance_cents = 179;
      // 每次守卫失败后充值立刻到账：重读余额会认为「已经够了」，于是重试一次。
      queueMicrotask(() => {
        db.rows("accounts")[0].balance_cents = 210;
      });
    };

    const checkout = await handleOrders(
      new Request(`https://example.com/v1/orders/${created.order_id}/checkout`, {
        method: "POST",
        headers: { authorization: `Bearer ${env.token}`, "Idempotency-Key": "idem-checkout-ghost" },
      }),
      env as never,
    );
    expect(checkout?.status).toBe(503);
    const body = (await checkout!.json()) as {
      code: string;
      details: { reason: string; shortfall_cents?: number };
    };
    expect(body.code).toBe("INTERNAL");
    expect(body.details.reason).toBe("wallet_unavailable");
    expect(body.details.shortfall_cents).toBeUndefined();
    expect(db.rows("servers")).toHaveLength(0);
  });

  it("端口唯一冲突时换端口重试，不会把可建的订单判死", async () => {
    const db = new FakeD1();
    const env = await envWith(db, await signingJwk());
    stubCatalog();

    const created = (await (
      await handleOrders(orderRequest(env.token, "idem-key-port"), env as never)
    )!.json()) as { order_id: string };
    db.rows("accounts")[0].balance_cents = 210;
    // 另一个并发建机先占了这次随机出来的端口：整批回滚后必须换端口重试。
    db.beforeWalletInsert = () => {
      db.beforeWalletInsert = undefined;
      throw new Error("UNIQUE constraint failed: servers.account_id, servers.node_port");
    };

    const checkout = await handleOrders(
      new Request(`https://example.com/v1/orders/${created.order_id}/checkout`, {
        method: "POST",
        headers: { authorization: `Bearer ${env.token}`, "Idempotency-Key": "idem-checkout-port" },
      }),
      env as never,
    );
    expect(checkout?.status).toBe(200);
    expect(db.rows("servers")).toHaveLength(1);
    expect(db.rows("accounts")[0].balance_cents).toBe(180);
    expect(
      db.rows("wallet_ledger").filter((row) => row.ref_type === "order"),
    ).toHaveLength(1);
  });

  it("端口在最后一步冲突：整批回滚，重试用尽后返回可重试的 port_conflict", async () => {
    const db = new FakeD1();
    const env = await envWith(db, await signingJwk());
    stubCatalog();

    const created = (await (
      await handleOrders(orderRequest(env.token, "idem-key-port-late"), env as never)
    )!.json()) as { order_id: string };
    db.rows("accounts")[0].balance_cents = 210;
    // 真实的冲突点：账本、余额、订单状态都已在本批写过，只有 servers 插入撞唯一索引。
    db.beforeServerInsert = () => {
      throw new Error("UNIQUE constraint failed: servers.account_id, servers.node_port");
    };

    const checkout = await handleOrders(
      new Request(`https://example.com/v1/orders/${created.order_id}/checkout`, {
        method: "POST",
        headers: { authorization: `Bearer ${env.token}`, "Idempotency-Key": "idem-checkout-port-late" },
      }),
      env as never,
    );
    expect(checkout?.status).toBe(503);
    const body = (await checkout!.json()) as {
      code: string;
      retryable: boolean;
      details: { reason: string };
    };
    expect(body.code).toBe("UPSTREAM_ERROR");
    expect(body.retryable).toBe(true);
    expect(body.details.reason).toBe("port_conflict");
    // 整批回滚：没有扣费、没有服务器，订单还能原样重试。
    expect(db.rows("wallet_ledger")).toHaveLength(0);
    expect(db.rows("accounts")[0].balance_cents).toBe(210);
    expect(db.rows("servers")).toHaveLength(0);
    expect(db.rows("orders")[0].state).toBe("pending_payment");
  });

  it("两笔 checkout 并发时门槛只放行一笔", async () => {
    const db = new FakeD1();
    const env = await envWith(db, await signingJwk());
    stubCatalog();

    const create = async (key: string) => {
      const res = await handleOrders(orderRequest(env.token, key), env as never);
      return ((await res!.json()) as { order_id: string }).order_id;
    };
    const first = await create("idem-key-conc-1");
    const second = await create("idem-key-conc-2");
    // 只够一笔 7 天门槛：两笔同时结账，第二笔必须被挡住。
    db.rows("accounts")[0].balance_cents = 210;

    const checkout = (orderId: string, key: string) =>
      handleOrders(
        new Request(`https://example.com/v1/orders/${orderId}/checkout`, {
          method: "POST",
          headers: { authorization: `Bearer ${env.token}`, "Idempotency-Key": key },
        }),
        env as never,
      );

    const results = await Promise.all([
      checkout(first, "idem-conc-a"),
      checkout(second, "idem-conc-b"),
    ]);
    expect(results.map((res) => res?.status).sort()).toEqual([200, 409]);
    const refused = results.find((res) => res?.status === 409)!;
    const body = (await refused.json()) as {
      details: { reason: string; required_cents: number; min_days: number };
    };
    expect(body.details.reason).toBe("insufficient_balance");
    expect(body.details.required_cents).toBe(210);
    expect(body.details.min_days).toBe(7);
    expect(db.rows("servers")).toHaveLength(1);
    expect(db.rows("accounts")[0].balance_cents).toBe(180);
    expect(
      db.rows("wallet_ledger").filter((row) => row.ref_type === "order"),
    ).toHaveLength(1);
  });

  it("目录里这个地区没有该规格时拒绝下单，details 带 region / plan", async () => {
    const db = new FakeD1();
    const env = await envWith(db, await signingJwk());
    stubCatalogRegionMismatch();

    const res = await handleOrders(orderRequest(env.token, "idem-key-mismatch"), env as never);
    expect(res?.status).toBe(409);
    const body = (await res!.json()) as {
      code: string;
      details: { reason: string; region: string; plan: string };
    };
    expect(body.code).toBe("PRECONDITION_FAILED");
    expect(body.details).toEqual({
      reason: "plan_unavailable_in_region",
      region: "sgp1",
      plan: "s-1vcpu-1gb",
    });
    expect(db.rows("orders")).toHaveLength(0);
  });

  it("结账前发现地区没有该规格：不扣费、不建机", async () => {
    const db = new FakeD1();
    const env = await envWith(db, await signingJwk());
    stubCatalogRegionMismatch();
    // 下单时还允许（例如目录刚变化），结账前必须重新按当前目录校验。
    db.rows("orders").push({
      id: "ord_mismatch0000000000",
      account_id: ACCOUNT,
      region: "sgp1",
      plan: "s-1vcpu-1gb",
      amount_usd: 0.3,
      amount_cents: 30,
      hourly_usd: 0.00893,
      state: "pending_payment",
      idempotency_key: "idem-order-mismatch",
      created_at: Date.now(),
      paid_at: null,
      expires_at: Date.now() + 10 * 60 * 1000,
      server_id: null,
      failure_code: null,
      failure_stage: null,
      checkout_session_id: null,
      checkout_url: null,
      paid_via: null,
    });
    db.rows("accounts")[0].balance_cents = 2000;

    const res = await handleOrders(
      new Request("https://example.com/v1/orders/ord_mismatch0000000000/checkout", {
        method: "POST",
        headers: { authorization: `Bearer ${env.token}`, "Idempotency-Key": "idem-checkout-mismatch" },
      }),
      env as never,
    );
    expect(res?.status).toBe(409);
    const body = (await res!.json()) as {
      details: { reason: string; region: string; plan: string };
    };
    expect(body.details.reason).toBe("plan_unavailable_in_region");
    expect(body.details.region).toBe("sgp1");
    expect(body.details.plan).toBe("s-1vcpu-1gb");
    expect(db.rows("wallet_ledger")).toHaveLength(0);
    expect(db.rows("servers")).toHaveLength(0);
    expect(db.rows("accounts")[0].balance_cents).toBe(2000);
  });

  it("未支付订单可以取消；已支付不行", async () => {
    const db = new FakeD1();
    const env = await envWith(db, await signingJwk());
    stubCatalog();

    const created = (await (
      await handleOrders(orderRequest(env.token, "idem-key-0006"), env as never)
    )!.json()) as { order_id: string };
    const cancel = (key: string) =>
      handleOrders(
        new Request(`https://example.com/v1/orders/${created.order_id}/cancel`, {
          method: "POST",
          headers: { authorization: `Bearer ${env.token}`, "Idempotency-Key": key },
        }),
        env as never,
      );

    const cancelled = await cancel("idem-cancel-1");
    expect(cancelled?.status).toBe(200);
    expect(((await cancelled!.json()) as { state: string }).state).toBe("cancelled");

    const paidOrder = (await (
      await handleOrders(orderRequest(env.token, "idem-key-0007"), env as never)
    )!.json()) as { order_id: string };
    db.rows("accounts")[0].balance_cents = 2000;
    await handleOrders(
      new Request(`https://example.com/v1/orders/${paidOrder.order_id}/checkout`, {
        method: "POST",
        headers: { authorization: `Bearer ${env.token}`, "Idempotency-Key": "idem-checkout-2" },
      }),
      env as never,
    );
    const refused = await handleOrders(
      new Request(`https://example.com/v1/orders/${paidOrder.order_id}/cancel`, {
        method: "POST",
        headers: { authorization: `Bearer ${env.token}`, "Idempotency-Key": "idem-cancel-2" },
      }),
      env as never,
    );
    expect(refused?.status).toBe(409);
    const body = (await refused!.json()) as { details: { reason: string } };
    expect(body.details.reason).toBe("cancel_after_paid");
  });

  it("同一订单重复结账只建一台机器", async () => {
    const db = new FakeD1();
    const env = await envWith(db, await signingJwk());
    stubCatalog();

    const order = (await (
      await handleOrders(orderRequest(env.token, "idem-key-0011"), env as never)
    )!.json()) as { order_id: string };
    db.rows("accounts")[0].balance_cents = 2000;

    const checkout = (key: string) =>
      handleOrders(
        new Request(`https://example.com/v1/orders/${order.order_id}/checkout`, {
          method: "POST",
          headers: { authorization: `Bearer ${env.token}`, "Idempotency-Key": key },
        }),
        env as never,
      );

    expect((await checkout("idem-checkout-a"))?.status).toBe(200);
    // 第二次带了不同的幂等键：认领时 state 已经不是 pending_payment，必须不再建机。
    expect((await checkout("idem-checkout-b"))?.status).toBe(200);
    expect(db.rows("servers")).toHaveLength(1);
  });

  it("建机请求的名称与 tag 符合 DigitalOcean 的字符约束", async () => {
    const db = new FakeD1();
    const env = await envWith(db, await signingJwk());
    let dropletBody: { name?: string; tags?: string[] } = {};

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
        if (href.endsWith("/droplets") && init?.method === "POST") {
          dropletBody = JSON.parse(String(init.body)) as typeof dropletBody;
          return new Response(
            JSON.stringify({ droplet: { id: 42, status: "new", networks: { v4: [] } } }),
            { status: 202 },
          );
        }
        return new Response(JSON.stringify({ id: "fw_1" }), { status: 202 });
      }),
    );

    const order = (await (
      await handleOrders(orderRequest(env.token, "idem-key-0009"), env as never)
    )!.json()) as { order_id: string };
    db.rows("accounts")[0].balance_cents = 2000;
    await handleOrders(
      new Request(`https://example.com/v1/orders/${order.order_id}/checkout`, {
        method: "POST",
        headers: { authorization: `Bearer ${env.token}`, "Idempotency-Key": "idem-checkout-9" },
      }),
      env as never,
    );

    // name 必须匹配 ^[a-zA-Z0-9]?[a-z0-9A-Z.\-]*[a-z0-9A-Z]$，tag 必须匹配 ^[a-zA-Z0-9_\-:]+$。
    expect(dropletBody.name).toMatch(/^[a-zA-Z0-9]?[a-z0-9A-Z.\-]*[a-z0-9A-Z]$/);
    expect(dropletBody.tags).toHaveLength(3);
    for (const tag of dropletBody.tags ?? []) {
      expect(tag).toMatch(/^[a-zA-Z0-9_\-:]+$/);
    }
  });
});
