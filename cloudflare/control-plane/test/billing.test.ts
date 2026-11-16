import { describe, expect, it } from "vitest";

import { runBilling } from "../src/billing";
import { provisionPaidOrder } from "../src/orders";
import { FakeD1 } from "./helpers/fakeD1";

const ACCOUNT = "acct_billing00000000000";
const DAY = 24 * 3600 * 1000;

function envWith(db: FakeD1) {
  db.rows("accounts").push({ id: ACCOUNT, kind: "email", balance_cents: 0 });
  return {
    DB: db as unknown as D1Database,
    ENVIRONMENT: "test",
    PLAN_PRICES_USD: JSON.stringify({ "s-1vcpu-1gb": 6 }),
  };
}

function seedServer(db: FakeD1, overrides: Record<string, unknown> = {}) {
  db.rows("servers").push({
    id: "srv_billing0000000000",
    account_id: ACCOUNT,
    order_id: "ord_seed",
    name: "我的服务器0001",
    region: "sgp1",
    plan: "s-1vcpu-1gb",
    hourly_usd: 0.0125,
    monthly_usd: 6,
    plan_price_cents: 600,
    state: "healthy",
    billing_state: "active",
    node_port: 12345,
    provider_id: "4242",
    paid_until: 0,
    created_at: Date.now() - 60 * DAY,
    updated_at: Date.now() - DAY,
    destroyed_at: null,
    ...overrides,
  });
}

function seedOrder(db: FakeD1, overrides: Record<string, unknown> = {}) {
  db.rows("orders").push({
    id: "ord_orphan0000000000",
    account_id: ACCOUNT,
    region: "sgp1",
    plan: "s-1vcpu-1gb",
    amount_usd: 6,
    amount_cents: 600,
    hourly_usd: 0.0125,
    state: "paid",
    idempotency_key: "idem-billing-0001",
    created_at: Date.now() - 10 * 60 * 1000,
    paid_at: Date.now() - 10 * 60 * 1000,
    expires_at: null,
    server_id: null,
    failure_code: null,
    failure_stage: null,
    checkout_session_id: null,
    checkout_url: null,
    paid_via: "wallet",
    ...overrides,
  });
}

describe("每日计费", () => {
  it("到期扣一个月：账本一条 server_period，paid_until 顺延 30 天", async () => {
    const db = new FakeD1();
    const env = envWith(db);
    db.rows("accounts")[0].balance_cents = 1000;
    seedServer(db, { paid_until: Date.now() - DAY });

    const report = await runBilling(env as never);

    expect(report.renewed).toBe(1);
    const ledger = db.rows("wallet_ledger");
    expect(ledger).toHaveLength(1);
    expect(ledger[0].ref_type).toBe("server_period");
    expect(ledger[0].amount_cents).toBe(-600);
    const server = db.rows("servers")[0];
    expect(Number(server.paid_until)).toBeGreaterThan(Date.now() + 28 * DAY);
    expect(server.billing_state).toBe("active");
    expect(db.rows("accounts")[0].balance_cents).toBe(400);
  });

  it("补了部分期仍不够：宽限从补齐后的到期时间起算，不该立刻 expired", async () => {
    const db = new FakeD1();
    const env = envWith(db);
    db.rows("accounts")[0].balance_cents = 600; // 只够一期
    seedServer(db, { paid_until: Date.now() - 35 * DAY });

    const report = await runBilling(env as never);

    // 补扣一期后 paid_until = now-5d，宽限到 now+2d：还在宽限期，不是 expired。
    expect(report.pastDue).toBe(1);
    expect(db.rows("servers")[0].billing_state).toBe("past_due");
    expect(db.rows("accounts")[0].balance_cents).toBe(0);
  });

  it("expired 的机器充值后仍会被扫到，补扣成功即回 active", async () => {
    const db = new FakeD1();
    const env = envWith(db);
    db.rows("accounts")[0].balance_cents = 2000;
    seedServer(db, { paid_until: Date.now() - 35 * DAY, billing_state: "expired" });

    const report = await runBilling(env as never);

    expect(report.renewed).toBe(1);
    expect(db.rows("servers")[0].billing_state).toBe("active");
    expect(Number(db.rows("servers")[0].paid_until)).toBeGreaterThan(Date.now());
  });

  it("没建出来的机器（error / 无 provider_id）不扣月费", async () => {
    const db = new FakeD1();
    const env = envWith(db);
    db.rows("accounts")[0].balance_cents = 1000;
    seedServer(db, { paid_until: Date.now() - DAY, state: "error", provider_id: null });

    const report = await runBilling(env as never);

    expect(report.renewed).toBe(0);
    expect(db.rows("wallet_ledger")).toHaveLength(0);
    expect(db.rows("accounts")[0].balance_cents).toBe(1000);
  });

  it("卡在 provisioning 且没有 provider_id 的订单会被补建", async () => {
    const db = new FakeD1();
    const env = envWith(db);
    seedOrder(db, { state: "provisioning", created_at: Date.now() - 10 * 60 * 1000 });

    await runBilling(env as never);

    const server = db.rows("servers")[0];
    expect(server).toBeTruthy();
    expect(server.order_id).toBe("ord_orphan0000000000");
    expect(Number(server.paid_until)).toBeGreaterThan(Date.now() + 25 * DAY);
    expect(server.plan_price_cents).toBe(600);
  });
});

describe("已收款订单的补建", () => {
  it("建机失败把订单退回 paid，钱和单都不丢", async () => {
    const db = new FakeD1();
    const env = envWith(db);
    seedOrder(db);

    const result = await provisionPaidOrder(env as never, "ord_orphan0000000000");

    expect(result.ok).toBe(false);
    const order = db.rows("orders")[0];
    expect(order.state).toBe("paid");
    expect(order.failure_code).toBe("provider_unconfigured");
    const server = db.rows("servers")[0];
    expect(server.state).toBe("error");
  });
});
