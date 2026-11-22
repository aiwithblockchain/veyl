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
  db.rows("accounts").push({ id: ACCOUNT, kind: "email", status: "active" });
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
    AGENT_VERSION: "0.1.0",
    AGENT_SHA256: "a".repeat(64),
    AGENT_DOWNLOAD_URL: "https://control.example.com/veyl-agent",
    SING_BOX_VERSION: "1.14.4",
    SING_BOX_SHA256: "b".repeat(64),
    SING_BOX_DOWNLOAD_URL: "https://control.example.com/sing-box.tar.gz",
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
      // 建机前先 ensure 全局共享防火墙：列表为空就创建，再建 Droplet。
      if (href.includes("/firewalls?")) {
        return new Response(JSON.stringify({ firewalls: [] }), { status: 200 });
      }
      if (href.endsWith("/firewalls") && init?.method === "POST") {
        return new Response(JSON.stringify({ firewall: { id: "fw_shared" } }), { status: 202 });
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

  it("确认下单：建服务器行并开始建机，但不扣费", async () => {
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
    const body = (await checkout!.json()) as {
      order_id: string;
      state: string;
      server_id: string;
      charge_mode: string;
      charged_cents?: number;
    };
    // 2.39.0：checkout 只确认下单，返回 MyServerOrder；扣费在就绪后由 enroll 结算。
    expect(body.order_id).toBe(created.order_id);
    expect(body.state).toBe("provisioning");
    // 口径来自 DB 列，不是客户端自己猜的缺省值。
    expect(body.charge_mode).toBe("at_ready");
    expect(body.server_id).toBeTruthy();
    expect(body.charged_cents).toBeUndefined();
    expect(db.rows("accounts")[0].balance_cents).toBe(2000);
    expect(db.rows("wallet_ledger")).toHaveLength(0);
    expect(db.rows("servers")).toHaveLength(1);

    const server = db.rows("servers")[0];
    // 端口落在共享防火墙放行的带内（30000-30999）。
    expect(server.node_port).toBeGreaterThanOrEqual(30000);
    expect(server.node_port).toBeLessThanOrEqual(30999);
    expect(server.state).toBe("booting");
    expect(server.provider_id).toBe("424242");
    expect(typeof server.enrollment_hash).toBe("string");
    // 结算前不写计费三列。
    expect(server.billing_state).toBe("pending");
    expect(server.paid_until).toBeNull();
    expect(Number(server.daily_price_cents)).toBe(0);
    expect(Number(server.billing_anchor_at)).toBe(0);
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

  it("余额正好 7 天日价时放行，checkout 仍不扣费", async () => {
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
    // 7 天只是预检，不预扣；余额原样留到就绪结算那一刻。
    expect(db.rows("accounts")[0].balance_cents).toBe(210);
    expect(db.rows("wallet_ledger")).toHaveLength(0);
    expect(db.rows("servers")).toHaveLength(1);
  });

  it("端口唯一冲突时换端口重试，不会把可建的订单判死", async () => {
    const db = new FakeD1();
    const env = await envWith(db, await signingJwk());
    stubCatalog();

    const created = (await (
      await handleOrders(orderRequest(env.token, "idem-key-port"), env as never)
    )!.json()) as { order_id: string };
    db.rows("accounts")[0].balance_cents = 210;
    // 另一个并发建机先占了这次随机出来的端口：整批回滚后换端口重试，第一次失败不影响结果。
    db.beforeServerInsert = () => {
      db.beforeServerInsert = undefined;
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
    // checkout 不扣费：余额与账本都不受影响。
    expect(db.rows("accounts")[0].balance_cents).toBe(210);
    expect(db.rows("wallet_ledger")).toHaveLength(0);
  });

  it("端口在最后一步冲突：整批回滚，重试用尽后返回可重试的 port_conflict", async () => {
    const db = new FakeD1();
    const env = await envWith(db, await signingJwk());
    stubCatalog();

    const created = (await (
      await handleOrders(orderRequest(env.token, "idem-key-port-late"), env as never)
    )!.json()) as { order_id: string };
    db.rows("accounts")[0].balance_cents = 210;
    // 真实的冲突点：订单认领已在本批写过，只有 servers 插入撞唯一索引。
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

  it("已有同名共享防火墙时不再创建，直接建机", async () => {
    const db = new FakeD1();
    const env = await envWith(db, await signingJwk());
    let firewallPosts = 0;
    let dropletPosts = 0;
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
        if (href.includes("/firewalls?")) {
          return new Response(
            JSON.stringify({
              firewalls: [
                {
                  id: "fw_env",
                  name: "veyl-shared-node-firewall",
                  // 按名称匹配：tag 为空也认。
                  tags: [],
                  created_at: "2026-11-20T00:00:00Z",
                  droplet_ids: [],
                },
              ],
            }),
            { status: 200 },
          );
        }
        if (href.endsWith("/firewalls") && init?.method === "POST") {
          firewallPosts += 1;
          return new Response(JSON.stringify({ firewall: { id: "fw_dup" } }), { status: 202 });
        }
        if (href.endsWith("/droplets") && init?.method === "POST") {
          dropletPosts += 1;
          return new Response(
            JSON.stringify({ droplet: { id: 5150, status: "new", networks: { v4: [] } } }),
            { status: 202 },
          );
        }
        return new Response(JSON.stringify({}), { status: 200 });
      }),
    );

    const created = (await (
      await handleOrders(orderRequest(env.token, "idem-key-shared-fw"), env as never)
    )!.json()) as { order_id: string };
    db.rows("accounts")[0].balance_cents = 2000;
    const checkout = await handleOrders(
      new Request(`https://example.com/v1/orders/${created.order_id}/checkout`, {
        method: "POST",
        headers: { authorization: `Bearer ${env.token}`, "Idempotency-Key": "idem-checkout-shared-fw" },
      }),
      env as never,
    );

    expect(checkout?.status).toBe(200);
    expect(firewallPosts).toBe(0);
    expect(dropletPosts).toBe(1);
    expect(db.rows("servers")[0].state).toBe("booting");
  });

  it("共享防火墙 ensure 失败：订单失败，绝不建出一台没防火墙的 Droplet", async () => {
    const db = new FakeD1();
    const env = await envWith(db, await signingJwk());
    let dropletPosts = 0;
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
        if (href.includes("/firewalls?")) {
          return new Response("upstream down", { status: 500 });
        }
        if (href.endsWith("/droplets") && init?.method === "POST") {
          dropletPosts += 1;
          return new Response(
            JSON.stringify({ droplet: { id: 5151, status: "new", networks: { v4: [] } } }),
            { status: 202 },
          );
        }
        return new Response(JSON.stringify({}), { status: 200 });
      }),
    );

    const created = (await (
      await handleOrders(orderRequest(env.token, "idem-key-firewall-down"), env as never)
    )!.json()) as { order_id: string };
    db.rows("accounts")[0].balance_cents = 2000;
    const checkout = await handleOrders(
      new Request(`https://example.com/v1/orders/${created.order_id}/checkout`, {
        method: "POST",
        headers: { authorization: `Bearer ${env.token}`, "Idempotency-Key": "idem-checkout-firewall-down" },
      }),
      env as never,
    );

    expect(checkout?.status).toBe(502);
    const body = (await checkout!.json()) as { retryable: boolean; details: { reason: string } };
    expect(body.details.reason).toBe("firewall_failed");
    expect(body.retryable).toBe(false);
    // 防火墙没起来就一台 Droplet 都不能建。
    expect(dropletPosts).toBe(0);
    expect(db.rows("servers")).toHaveLength(1);
    expect(db.rows("servers")[0].state).toBe("error");
    expect(db.rows("servers")[0].provider_id).toBeNull();
    expect(db.rows("orders")[0].state).toBe("failed");
    // at_ready 没扣过钱，也就没有退款。
    expect(db.rows("accounts")[0].balance_cents).toBe(2000);
    expect(db.rows("wallet_ledger")).toHaveLength(0);
  });

  it("agent 构建信息是占位符：整单失败，不建 Droplet", async () => {
    const db = new FakeD1();
    const env = await envWith(db, await signingJwk());
    // 真实配置里 sha256 必须是 64 位十六进制；占位符不允许悄悄建机。
    env.AGENT_SHA256 = "REPLACE_WITH_AGENT_SHA256";
    stubCatalog();

    const created = (await (
      await handleOrders(orderRequest(env.token, "idem-key-agent-config"), env as never)
    )!.json()) as { order_id: string };
    db.rows("accounts")[0].balance_cents = 2000;
    const checkout = await handleOrders(
      new Request(`https://example.com/v1/orders/${created.order_id}/checkout`, {
        method: "POST",
        headers: { authorization: `Bearer ${env.token}`, "Idempotency-Key": "idem-checkout-agent-config" },
      }),
      env as never,
    );

    expect(checkout?.status).toBe(502);
    const body = (await checkout!.json()) as { details: { reason: string } };
    expect(body.details.reason).toBe("agent_unconfigured");
    expect(db.rows("servers")[0].state).toBe("error");
    // 没建出 Droplet：provider_id 一直是空的。
    expect(db.rows("servers")[0].provider_id).toBeNull();
    expect(db.rows("orders")[0].state).toBe("failed");
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
        if (href.includes("/firewalls?")) {
          return new Response(JSON.stringify({ firewalls: [] }), { status: 200 });
        }
        if (href.endsWith("/firewalls") && init?.method === "POST") {
          return new Response(JSON.stringify({ firewall: { id: "fw_shared" } }), { status: 202 });
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
    expect(dropletBody.tags).toHaveLength(4);
    // 全局共享防火墙按这个 tag 覆盖所有节点。
    expect(dropletBody.tags).toContain("veyl:node");
    for (const tag of dropletBody.tags ?? []) {
      expect(tag).toMatch(/^[a-zA-Z0-9_\-:]+$/);
    }
  });
});
