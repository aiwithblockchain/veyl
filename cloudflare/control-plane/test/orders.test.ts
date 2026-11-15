import { afterEach, describe, expect, it, vi } from "vitest";

import { handleOrders } from "../src/orders";
import { signAccessToken } from "../src/lib/crypto";
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
            { slug: "s-1vcpu-512mb-10gb", memory: 512, vcpus: 1, price_hourly: 0.00595, price_monthly: 4 },
            { slug: "s-1vcpu-1gb", memory: 1024, vcpus: 1, price_hourly: 0.00893, price_monthly: 6 },
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
    expect(body.amount_usd).toBe(6);
    expect(body.region).toBe("sgp1");
    expect(body.order_id.startsWith("ord_")).toBe(true);
  });

  it("同一幂等键重复下单只产生一笔订单", async () => {
    const db = new FakeD1();
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

  it("假支付创建服务器并选定端口", async () => {
    const db = new FakeD1();
    const env = await envWith(db, await signingJwk());
    stubCatalog();

    const created = (await (
      await handleOrders(orderRequest(env.token, "idem-key-0005"), env as never)
    )!.json()) as { order_id: string };

    const checkout = await handleOrders(
      new Request(`https://example.com/v1/orders/${created.order_id}/checkout`, {
        method: "POST",
        headers: { authorization: `Bearer ${env.token}`, "Idempotency-Key": "idem-checkout-1" },
        body: JSON.stringify({ channel: "fake" }),
      }),
      env as never,
    );
    expect(checkout?.status).toBe(200);
    const paid = (await checkout!.json()) as { state: string; server_id: string };
    expect(paid.state).toBe("provisioning");
    expect(paid.server_id.startsWith("srv_")).toBe(true);

    const server = db.rows("servers")[0];
    expect(server.node_port).toBeGreaterThanOrEqual(10000);
    expect(server.node_port).toBeLessThan(60000);
    expect(server.state).toBe("booting");
    expect(server.provider_id).toBe("424242");
    expect(typeof server.enrollment_hash).toBe("string");
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
    await handleOrders(
      new Request(`https://example.com/v1/orders/${paidOrder.order_id}/checkout`, {
        method: "POST",
        headers: { authorization: `Bearer ${env.token}`, "Idempotency-Key": "idem-checkout-2" },
        body: JSON.stringify({ channel: "fake" }),
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

    const checkout = (key: string) =>
      handleOrders(
        new Request(`https://example.com/v1/orders/${order.order_id}/checkout`, {
          method: "POST",
          headers: { authorization: `Bearer ${env.token}`, "Idempotency-Key": key },
          body: JSON.stringify({ channel: "fake" }),
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
                { slug: "s-1vcpu-1gb", memory: 1024, vcpus: 1, price_hourly: 0.00893, price_monthly: 6 },
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
    await handleOrders(
      new Request(`https://example.com/v1/orders/${order.order_id}/checkout`, {
        method: "POST",
        headers: { authorization: `Bearer ${env.token}`, "Idempotency-Key": "idem-checkout-9" },
        body: JSON.stringify({ channel: "fake" }),
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
