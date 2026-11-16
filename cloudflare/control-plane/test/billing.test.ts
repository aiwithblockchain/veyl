import { describe, expect, it } from "vitest";

import { recoverExpiredServers, runBilling } from "../src/billing";
import { provisionPaidOrder } from "../src/orders";
import { FakeD1 } from "./helpers/fakeD1";

const ACCOUNT = "acct_billing00000000000";
const DAY = 24 * 3600 * 1000;
const DAILY = 20; // 20 分/天：$6/月 ÷ 30

function envWith(db: FakeD1) {
  db.rows("accounts").push({ id: ACCOUNT, kind: "email", balance_cents: 0 });
  return {
    DB: db as unknown as D1Database,
    ENVIRONMENT: "test",
    PLAN_DAILY_PRICE_CENTS: JSON.stringify({ "s-1vcpu-1gb": DAILY }),
  };
}

function seedServer(db: FakeD1, overrides: Record<string, unknown> = {}) {
  const anchor = Number(overrides.billing_anchor_at ?? Date.now() - 60 * DAY);
  db.rows("servers").push({
    id: "srv_billing0000000000",
    account_id: ACCOUNT,
    order_id: "ord_seed",
    name: "我的服务器0001",
    region: "sgp1",
    plan: "s-1vcpu-1gb",
    hourly_usd: 0.0125,
    monthly_usd: 6,
    daily_price_cents: DAILY,
    billing_anchor_at: anchor,
    state: "healthy",
    billing_state: "active",
    node_port: 12345,
    provider_id: "4242",
    paid_until: 0,
    created_at: anchor,
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
    amount_usd: 0.3,
    amount_cents: 30,
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
  it("到期扣一天：账本一条 server_day，paid_until 顺延 1 天", async () => {
    const db = new FakeD1();
    const env = envWith(db);
    db.rows("accounts")[0].balance_cents = 1000;
    // 差一点满一天到期：补一格就回到未来，只扣一天。
    seedServer(db, { paid_until: Date.now() - DAY + 60_000 });

    const report = await runBilling(env as never);

    expect(report.renewed).toBe(1);
    const ledger = db.rows("wallet_ledger");
    expect(ledger).toHaveLength(1);
    expect(ledger[0].ref_type).toBe("server_day");
    expect(ledger[0].amount_cents).toBe(-DAILY);
    const server = db.rows("servers")[0];
    expect(Number(server.paid_until)).toBeGreaterThan(Date.now());
    expect(server.billing_state).toBe("active");
    expect(db.rows("accounts")[0].balance_cents).toBe(1000 - DAILY);
  });

  it("一次补齐欠的天数，但不超过 30 天", async () => {
    const db = new FakeD1();
    const env = envWith(db);
    db.rows("accounts")[0].balance_cents = 1000;
    seedServer(db, { paid_until: Date.now() - 5 * DAY });

    await runBilling(env as never);

    const days = db.rows("wallet_ledger").filter((row) => row.ref_type === "server_day");
    expect(days).toHaveLength(6); // 5 天欠账 + 今天这一格
    expect(db.rows("accounts")[0].balance_cents).toBe(1000 - 6 * DAILY);
  });

  it("只补了一部分：宽限从补齐后的到期时间起算", async () => {
    const db = new FakeD1();
    const env = envWith(db);
    db.rows("accounts")[0].balance_cents = 3 * DAILY; // 只够 3 天
    seedServer(db, { paid_until: Date.now() - 8 * DAY });

    const report = await runBilling(env as never);

    // 补 3 天后 paid_until = now-5d，宽限到 now+2d：还在宽限期，不是 expired。
    expect(report.pastDue).toBe(1);
    expect(db.rows("servers")[0].billing_state).toBe("past_due");
    expect(db.rows("accounts")[0].balance_cents).toBe(0);
  });

  it("expired 不参与每日扫描：停机期间不再产生费用", async () => {
    const db = new FakeD1();
    const env = envWith(db);
    db.rows("accounts")[0].balance_cents = 10 * DAILY;
    seedServer(db, { paid_until: Date.now() - 3 * DAY, billing_state: "expired" });

    const report = await runBilling(env as never);

    expect(report.renewed).toBe(0);
    expect(db.rows("wallet_ledger")).toHaveLength(0);
    expect(db.rows("servers")[0].billing_state).toBe("expired");
    expect(Number(db.rows("servers")[0].paid_until)).toBeLessThan(Date.now());
  });

  it("充值后恢复：补扣到 active", async () => {
    const db = new FakeD1();
    const env = envWith(db);
    db.rows("accounts")[0].balance_cents = 10 * DAILY;
    seedServer(db, { paid_until: Date.now() - 3 * DAY, billing_state: "expired" });

    const recovered = await recoverExpiredServers(env as never, ACCOUNT);

    expect(recovered).toBe(1);
    expect(db.rows("servers")[0].billing_state).toBe("active");
    expect(Number(db.rows("servers")[0].paid_until)).toBeGreaterThan(Date.now());
  });

  it("停机超过 30 天：先豁免到最近 30 天，再补扣恢复", async () => {
    const db = new FakeD1();
    const env = envWith(db);
    const anchor = Date.now() - 40 * DAY;
    db.rows("accounts")[0].balance_cents = 30 * DAILY;
    seedServer(db, {
      billing_anchor_at: anchor,
      created_at: anchor,
      paid_until: anchor + DAY,
      billing_state: "expired",
    });

    const recovered = await recoverExpiredServers(env as never, ACCOUNT);

    expect(recovered).toBe(1);
    const days = db.rows("wallet_ledger").filter((row) => row.ref_type === "server_day");
    expect(days).toHaveLength(30);
    const waived = db.rows("audit_log").find((row) => row.action === "grace_waived");
    expect(waived).toBeTruthy();
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

  it("到期服务器超过一页时全部处理，不会只扣前 100 台", async () => {
    const db = new FakeD1();
    const env = envWith(db);
    db.rows("accounts")[0].balance_cents = 150 * DAILY;
    for (let i = 0; i < 150; i += 1) {
      seedServer(db, {
        id: `srv_${String(i).padStart(4, "0")}`,
        order_id: `ord_${i}`,
        billing_anchor_at: Date.now() - 2 * DAY,
        created_at: Date.now() - 2 * DAY,
        paid_until: Date.now() - DAY + 60_000,
      });
    }

    await runBilling(env as never);

    const charges = db.rows("wallet_ledger").filter((row) => row.ref_type === "server_day");
    expect(charges).toHaveLength(150);
  });

  it("卡在 provisioning 且没有 provider_id 的订单会被补建", async () => {
    const db = new FakeD1();
    const env = envWith(db);
    seedOrder(db, { state: "provisioning", created_at: Date.now() - 10 * 60 * 1000 });

    await runBilling(env as never);

    const server = db.rows("servers")[0];
    expect(server).toBeTruthy();
    expect(server.order_id).toBe("ord_orphan0000000000");
    expect(server.daily_price_cents).toBe(30);
    // 锚点取订单已扣的那一天，不是 now。
    expect(server.billing_anchor_at).toBe(db.rows("orders")[0].paid_at);
    expect(Number(server.paid_until)).toBe(Number(server.billing_anchor_at) + DAY);
  });

  it("账本明细超过保留期时：先写月末快照，再裁剪 server_day", async () => {
    const db = new FakeD1();
    const env = envWith(db);
    const old = Date.now() - 70 * DAY;
    db.rows("accounts")[0].balance_cents = 800;
    db.rows("wallet_ledger").push({
      id: "led_old",
      account_id: ACCOUNT,
      kind: "charge",
      amount_cents: -200,
      balance_after_cents: 800,
      ref_type: "server_day",
      ref_id: "srv_x:1",
      note: null,
      created_at: old,
    });

    const report = await runBilling(env as never);

    const snapshot = db.rows("wallet_ledger").find((row) => row.ref_type === "snapshot");
    expect(snapshot).toBeTruthy();
    expect(snapshot?.amount_cents).toBe(0);
    expect(snapshot?.balance_after_cents).toBe(800);
    expect(db.rows("wallet_ledger").some((row) => row.id === "led_old")).toBe(false);
    expect(report.archived).toBe(1);
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
