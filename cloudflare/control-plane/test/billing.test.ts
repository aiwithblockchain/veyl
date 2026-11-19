import { afterEach, describe, expect, it, vi } from "vitest";

import { recoverExpiredServers, runBilling } from "../src/billing";
import { provisionPaidOrder } from "../src/orders";
import { FakeD1 } from "./helpers/fakeD1";

afterEach(() => {
  vi.unstubAllGlobals();
});

const ACCOUNT = "acct_billing00000000000";
const DAY = 24 * 3600 * 1000;
const DAILY = 20; // 20 分/天：$6/月 ÷ 30

function envWith(db: FakeD1) {
  db.rows("accounts").push({ id: ACCOUNT, kind: "email", balance_cents: 0 });
  return {
    DB: db as unknown as D1Database,
    ENVIRONMENT: "test",
    // 余额不足停机销毁要走 DO 删除；没有令牌 destroyInstance 会直接还原状态。
    DO_API_TOKEN: "do-token",
    PLAN_DAILY_PRICE_CENTS: JSON.stringify({ "s-1vcpu-1gb": DAILY }),
  };
}

function stubDoDeletes() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(null, { status: 204 })),
  );
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

describe("按天续费", () => {
  it("到期扣一天：账本一条 server_day，paid_until 顺延 1 天", async () => {
    const db = new FakeD1();
    const env = envWith(db);
    db.rows("accounts")[0].balance_cents = 1000;
    // 刚过到期时刻：补一格就回到未来且不在预热窗口内，只扣一天。
    seedServer(db, { paid_until: Date.now() - 60_000 });

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

  it("collectDue 之后被销毁的服务器不再扣费", async () => {
    const db = new FakeD1();
    const env = envWith(db);
    db.rows("accounts")[0].balance_cents = 1000;
    seedServer(db, { paid_until: Date.now() - 60_000 });
    // 竞态：到期行已经取到，用户在结算前销毁了这台（销毁已按当时 paid_until 退款）。
    db.onBillingCursor = () => {
      db.rows("servers")[0].destroyed_at = Date.now();
    };

    const report = await runBilling(env as never);

    expect(db.rows("wallet_ledger")).toHaveLength(0);
    expect(db.rows("accounts")[0].balance_cents).toBe(1000);
    expect(report.renewed).toBe(0);
    expect(report.pastDue).toBe(0);
  });

  it("collectDue 之后进入 destroying 的服务器不再扣费", async () => {
    const db = new FakeD1();
    const env = envWith(db);
    db.rows("accounts")[0].balance_cents = 1000;
    seedServer(db, { paid_until: Date.now() - 60_000 });
    // destroy 在处理开头就写 destroying，destroyed_at 要等 DO 删除完才落。
    db.onBillingCursor = () => {
      db.rows("servers")[0].state = "destroying";
    };

    const report = await runBilling(env as never);

    expect(db.rows("wallet_ledger")).toHaveLength(0);
    expect(db.rows("accounts")[0].balance_cents).toBe(1000);
    expect(report.renewed).toBe(0);
    expect(report.pastDue).toBe(0);
  });

  it("复查之后、记账之前被销毁：账本守卫拒绝这一天", async () => {
    const db = new FakeD1();
    const env = envWith(db);
    db.rows("accounts")[0].balance_cents = 1000;
    seedServer(db, { paid_until: Date.now() - 60_000 });
    db.beforeWalletInsert = () => {
      db.rows("servers")[0].state = "destroying";
    };

    const report = await runBilling(env as never);

    expect(db.rows("wallet_ledger")).toHaveLength(0);
    expect(db.rows("accounts")[0].balance_cents).toBe(1000);
    expect(report.pastDue).toBe(0);
    expect(db.rows("servers")[0].billing_state).toBe("active");
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

  it("只补了一部分：补完仍然过期 → 停机销毁，不写 past_due", async () => {
    const db = new FakeD1();
    const env = envWith(db);
    stubDoDeletes();
    db.rows("accounts")[0].balance_cents = 3 * DAILY; // 只够 3 天
    seedServer(db, { paid_until: Date.now() - 8 * DAY });

    const report = await runBilling(env as never);

    // 补 3 天后 paid_until = now-5d，仍然过期：按新规则直接停机销毁，没有宽限。
    expect(report.unpaidDestroyed).toBe(1);
    expect(report.pastDue).toBe(0);
    expect(db.rows("servers")[0].state).toBe("destroyed");
    expect(db.rows("servers")[0].failure_code).toBe("billing_unpaid");
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
        paid_until: Date.now() - 60_000,
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

  it("清理旧刷新令牌：按最后一次使用/作废时间算，已过期未使用的也清", async () => {
    const db = new FakeD1();
    const env = envWith(db);
    const now = Date.now();
    const token = (overrides: Record<string, unknown>) => ({
      hash: "h",
      device_id: "dev_x",
      expires_at: now + DAY,
      used_at: null,
      revoked_at: null,
      created_at: now,
      ...overrides,
    });
    db.rows("refresh_tokens").push(
      token({ hash: "old_used", used_at: now - 40 * DAY, created_at: now - 40 * DAY }),
      token({ hash: "old_revoked", revoked_at: now - 40 * DAY, created_at: now - 40 * DAY }),
      // 签发很久但最近还在轮换：活凭据，不能按 created_at 删。
      token({ hash: "recently_used_old", used_at: now - DAY, created_at: now - 40 * DAY }),
      // 从没用过但已过期：不可能再换出新令牌。
      token({ hash: "expired_unused", expires_at: now - DAY, created_at: now - 40 * DAY }),
      // 未使用且未过期的是活凭据：即使很老也不能删。
      token({ hash: "old_live", created_at: now - 40 * DAY }),
      token({ hash: "new_used", used_at: now - DAY, created_at: now - DAY }),
    );

    const report = await runBilling(env as never);

    expect(report.tokensPruned).toBe(3);
    expect(db.rows("refresh_tokens").map((row) => row.hash).sort()).toEqual([
      "new_used",
      "old_live",
      "recently_used_old",
    ]);
  });

  it("删除孤儿匿名账户：有充值单或支付流水也必须保留", async () => {
    const db = new FakeD1();
    const env = envWith(db);
    const now = Date.now();
    const account = (id: string, overrides: Record<string, unknown> = {}) => ({
      id,
      kind: "device",
      email: null,
      status: "active",
      merged_into: null,
      balance_cents: 0,
      created_at: now - 2 * DAY,
      ...overrides,
    });
    db.rows("accounts").push(
      account("acct_orphan"),
      account("acct_young", { created_at: now - 60_000 }),
      account("acct_rich", { balance_cents: 1 }),
      account("acct_has_device"),
      account("acct_has_order"),
      account("acct_has_server"),
      account("acct_has_topup"),
      account("acct_has_payment"),
      account("acct_merged", { merged_into: "acct_email" }),
    );
    db.rows("devices").push({ id: "dev_live", account_id: "acct_has_device" });
    db.rows("orders").push({ id: "ord_x", account_id: "acct_has_order" });
    db.rows("servers").push({ id: "srv_x", account_id: "acct_has_server" });
    db.rows("topups").push({ id: "top_x", account_id: "acct_has_topup" });
    db.rows("payments").push({ id: "pay_x", account_id: "acct_has_payment" });

    const report = await runBilling(env as never);

    expect(report.accountsPruned).toBe(1);
    const ids = db.rows("accounts").map((row) => row.id);
    expect(ids).not.toContain("acct_orphan");
    for (const kept of [
      "acct_young",
      "acct_rich",
      "acct_has_device",
      "acct_has_order",
      "acct_has_server",
      "acct_has_topup",
      "acct_has_payment",
      "acct_merged",
      ACCOUNT,
    ]) {
      expect(ids).toContain(kept);
    }
  });
});

describe("提前续费（到期前 1 小时）", () => {
  const MIN = 60 * 1000;
  const SERVER_ID = "srv_billing0000000000";

  it("到期前 59 分钟：扣一天，paid_until 在原值上顺延 24h", async () => {
    const db = new FakeD1();
    const env = envWith(db);
    db.rows("accounts")[0].balance_cents = 1000;
    const anchor = Date.now() - 60 * DAY;
    const paidUntil = Date.now() + 59 * MIN;
    seedServer(db, {
      billing_anchor_at: anchor,
      created_at: anchor,
      paid_until: paidUntil,
    });

    const report = await runBilling(env as never);

    expect(report.renewed).toBe(1);
    const ledger = db.rows("wallet_ledger").filter((row) => row.ref_type === "server_day");
    expect(ledger).toHaveLength(1);
    // 扣的是原到期时刻那一格，新 paid_until = 原值 + 24h（不是 now + 24h）。
    expect(ledger[0].ref_id).toBe(`${SERVER_ID}:${paidUntil}`);
    expect(Number(db.rows("servers")[0].paid_until)).toBe(paidUntil + DAY);
    expect(db.rows("servers")[0].billing_state).toBe("active");
  });

  it("到期前 61 分钟：还没进窗口，不扣", async () => {
    const db = new FakeD1();
    const env = envWith(db);
    db.rows("accounts")[0].balance_cents = 1000;
    const paidUntil = Date.now() + 61 * MIN;
    seedServer(db, { paid_until: paidUntil });

    const report = await runBilling(env as never);

    expect(report.renewed).toBe(0);
    expect(db.rows("wallet_ledger")).toHaveLength(0);
    expect(Number(db.rows("servers")[0].paid_until)).toBe(paidUntil);
  });

  it("窗口内扣不动：当场停机销毁，即使机器还没到期", async () => {
    const db = new FakeD1();
    const env = envWith(db);
    stubDoDeletes();
    db.rows("accounts")[0].balance_cents = 0;
    seedServer(db, { paid_until: Date.now() + 59 * MIN });

    const report = await runBilling(env as never);

    expect(report.unpaidDestroyed).toBe(1);
    expect(
      db.rows("wallet_ledger").filter((row) => row.ref_type === "server_day"),
    ).toHaveLength(0);
    const server = db.rows("servers")[0];
    expect(server.state).toBe("destroyed");
    expect(server.failure_code).toBe("billing_unpaid");
    expect(server.destroyed_at).toBeTruthy();
  });

  it("已到期且扣不动：直接停机销毁，不再转 past_due / expired", async () => {
    const db = new FakeD1();
    const env = envWith(db);
    stubDoDeletes();
    db.rows("accounts")[0].balance_cents = 0;
    seedServer(db, { id: "srv_past_due000000000", paid_until: Date.now() - 60 * MIN });
    seedServer(db, { id: "srv_expired000000000", paid_until: Date.now() - 8 * DAY });

    const report = await runBilling(env as never);

    expect(report.unpaidDestroyed).toBe(2);
    expect(report.pastDue).toBe(0);
    expect(report.expired).toBe(0);
    for (const server of db.rows("servers")) {
      expect(server.state).toBe("destroyed");
      expect(server.failure_code).toBe("billing_unpaid");
    }
  });

  it("同一 bucket 连跑两次只扣一次", async () => {
    const db = new FakeD1();
    const env = envWith(db);
    db.rows("accounts")[0].balance_cents = 1000;
    const paidUntil = Date.now() + 59 * MIN;
    seedServer(db, { paid_until: paidUntil });

    await runBilling(env as never);
    await runBilling(env as never);

    const ledger = db.rows("wallet_ledger").filter((row) => row.ref_type === "server_day");
    expect(ledger).toHaveLength(1);
    expect(db.rows("accounts")[0].balance_cents).toBe(1000 - DAILY);
  });

  it("算不出账的行（日价 0）：进了窗口也不扣、不销毁", async () => {
    const db = new FakeD1();
    const env = envWith(db);
    stubDoDeletes();
    db.rows("accounts")[0].balance_cents = 1000;
    seedServer(db, { state: "active", paid_until: Date.now() + 59 * MIN });
    Object.assign(db.rows("servers")[0], { daily_price_cents: 0 });

    const report = await runBilling(env as never);

    expect(report.unpaidDestroyed).toBe(0);
    expect(report.renewed).toBe(0);
    expect(db.rows("wallet_ledger")).toHaveLength(0);
    expect(db.rows("servers")[0].state).toBe("active");
  });

  it("账户缺失：记账失败但不当作欠费，不扣、不销毁", async () => {
    const db = new FakeD1();
    const env = envWith(db);
    stubDoDeletes();
    // 服务器行指向一个不存在的账户：账本只能报 missing_account，不是欠费。
    seedServer(db, {
      account_id: "acct_missing000000000000",
      state: "active",
      paid_until: Date.now() + 59 * MIN,
    });

    const report = await runBilling(env as never);

    expect(report.unpaidDestroyed).toBe(0);
    expect(db.rows("wallet_ledger")).toHaveLength(0);
    expect(db.rows("servers")[0].state).toBe("active");
  });

  it("destroying / destroyed 的机器即使进了窗口也不扣", async () => {    const db = new FakeD1();
    const env = envWith(db);
    db.rows("accounts")[0].balance_cents = 1000;
    const paidUntil = Date.now() + 59 * MIN;
    seedServer(db, { id: "srv_destroying0000000", state: "destroying", paid_until: paidUntil });
    seedServer(db, {
      id: "srv_destroyed00000000",
      state: "destroyed",
      destroyed_at: Date.now(),
      paid_until: paidUntil,
    });

    const report = await runBilling(env as never);

    expect(db.rows("wallet_ledger")).toHaveLength(0);
    expect(report.renewed).toBe(0);
  });
});

describe("过期未 enroll 的 booting 机器", () => {
  function seedExpiredBooting(
    db: FakeD1,
    expiresAt: number,
    usedAt: number | null = null,
    state = "booting",
  ) {
    const orderId = "ord_boot00000000000000";
    const serverId = "srv_boot0000000000000";
    db.rows("orders").push({
      id: orderId,
      account_id: ACCOUNT,
      region: "fra1",
      plan: "s-1vcpu-1gb",
      amount_usd: DAILY / 100,
      amount_cents: DAILY,
      hourly_usd: 0.0125,
      state: "provisioning",
      idempotency_key: "idem-boot",
      created_at: expiresAt,
      paid_at: expiresAt,
      expires_at: null,
      server_id: serverId,
      failure_code: null,
      failure_stage: null,
      checkout_session_id: null,
      checkout_url: null,
      paid_via: "wallet",
    });
    db.rows("servers").push({
      id: serverId,
      account_id: ACCOUNT,
      order_id: orderId,
      name: "我的服务器0002",
      region: "fra1",
      plan: "s-1vcpu-1gb",
      hourly_usd: 0.0125,
      monthly_usd: 6,
      daily_price_cents: DAILY,
      billing_anchor_at: expiresAt,
      state,
      billing_state: "active",
      node_port: 12346,
      provider_id: "4242",
      enrollment_hash: usedAt === null ? "hash" : null,
      enrollment_used_at: usedAt,
      enrollment_expires_at: expiresAt,
      paid_until: expiresAt + DAY,
      created_at: expiresAt,
      updated_at: expiresAt,
      destroyed_at: null,
      failure_code: null,
    });
    db.rows("wallet_ledger").push({
      id: "led_boot_order",
      account_id: ACCOUNT,
      kind: "charge",
      amount_cents: -DAILY,
      balance_after_cents: 0,
      ref_type: "order",
      ref_id: orderId,
      note: null,
      created_at: expiresAt,
    });
    return { orderId, serverId };
  }

  function stubDeletes() {
    const deleted: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const href = String(input);
        if (init?.method === "DELETE" && href.includes("/droplets/")) {
          deleted.push(href);
          return new Response(null, { status: 204 });
        }
        return new Response(JSON.stringify({}), { status: 200 });
      }),
    );
    return deleted;
  }

  it("计费 Cron 销毁并退回已扣的钱，之后不再扣费", async () => {
    const db = new FakeD1();
    const env = { ...envWith(db), DO_API_TOKEN: "do-token" };
    const deleted = stubDeletes();
    const { orderId, serverId } = seedExpiredBooting(db, Date.now() - 60_000);

    const report = await runBilling(env as never);

    expect(report.reaped).toBe(1);
    expect(deleted).toHaveLength(1);
    expect(deleted[0]).toContain("/droplets/4242");
    const server = db.rows("servers")[0];
    expect(server.state).toBe("destroyed");
    expect(server.destroyed_at).not.toBeNull();
    expect(db.rows("orders")[0].state).toBe("failed");
    // 机器没建成：已扣的那一天原样退回。
    const refund = db.rows("wallet_ledger").find((row) => row.ref_type === "server_refund");
    expect(refund?.ref_id).toBe(serverId);
    expect(refund?.amount_cents).toBe(DAILY);
    expect(db.rows("accounts")[0].balance_cents).toBe(DAILY);
    const audit = db.rows("audit_log").find(
      (row) => row.action === "provision.enrollment_timeout",
    );
    expect(audit).toBeTruthy();
    expect(String(audit?.detail)).toContain("enrollment_expires_at");
    expect(db.rows("orders")[0].id).toBe(orderId);

    // 再跑一轮：没有可清的机器，也不会重复退款或扣费。
    const again = await runBilling(env as never);
    expect(again.reaped).toBe(0);
    expect(db.rows("wallet_ledger").filter((row) => row.ref_type === "server_refund")).toHaveLength(1);
    expect(db.rows("wallet_ledger").filter((row) => row.ref_type === "server_day")).toHaveLength(0);
    expect(db.rows("accounts")[0].balance_cents).toBe(DAILY);
  });

  it("还在 enrollment 有效期内的 booting 机器不动", async () => {
    const db = new FakeD1();
    const env = { ...envWith(db), DO_API_TOKEN: "do-token" };
    const deleted = stubDeletes();
    seedExpiredBooting(db, Date.now() + 60_000);

    const report = await runBilling(env as never);

    expect(report.reaped).toBe(0);
    expect(deleted).toHaveLength(0);
    expect(db.rows("servers")[0].state).toBe("booting");
    expect(db.rows("wallet_ledger").filter((row) => row.ref_type === "server_refund")).toHaveLength(0);
  });

  it("已回传 enroll 但在 activate 前停住：过期后同样销毁退款，原因记为 activate_stalled", async () => {
    const db = new FakeD1();
    const env = { ...envWith(db), DO_API_TOKEN: "do-token" };
    const deleted = stubDeletes();
    const expiresAt = Date.now() - 60_000;
    const { serverId } = seedExpiredBooting(db, expiresAt, expiresAt - 30_000);

    const report = await runBilling(env as never);

    expect(report.reaped).toBe(1);
    expect(deleted).toHaveLength(1);
    const server = db.rows("servers")[0];
    expect(server.state).toBe("destroyed");
    expect(server.failure_code).toBe("activate_stalled");
    expect(db.rows("orders")[0].state).toBe("failed");
    expect(db.rows("orders")[0].failure_code).toBe("activate_stalled");
    const refunds = db.rows("wallet_ledger").filter((row) => row.ref_type === "server_refund");
    expect(refunds).toHaveLength(1);
    expect(refunds[0].ref_id).toBe(serverId);
    expect(refunds[0].amount_cents).toBe(DAILY);
    const audit = db.rows("audit_log").find(
      (row) => row.action === "provision.activate_stalled",
    );
    expect(audit).toBeTruthy();
    expect(String(audit?.detail)).toContain("enrollment_used_at");

    // 再跑一轮：已销毁，不会退第二次。
    const again = await runBilling(env as never);
    expect(again.reaped).toBe(0);
    expect(db.rows("wallet_ledger").filter((row) => row.ref_type === "server_refund")).toHaveLength(1);
  });

  it("已回传但 enrollment 还没过期：不动，给 activate 留时间", async () => {
    const db = new FakeD1();
    const env = { ...envWith(db), DO_API_TOKEN: "do-token" };
    const deleted = stubDeletes();
    seedExpiredBooting(db, Date.now() + 60_000, Date.now() - 60_000);

    const report = await runBilling(env as never);

    expect(report.reaped).toBe(0);
    expect(deleted).toHaveLength(0);
    expect(db.rows("servers")[0].state).toBe("booting");
    expect(db.rows("wallet_ledger").filter((row) => row.ref_type === "server_refund")).toHaveLength(0);
  });

  it("卡在 installing / verifying 过期：各自按 install_timeout / verify_timeout 销毁退款", async () => {
    for (const [state, reason] of [
      ["installing", "install_timeout"],
      ["verifying", "verify_timeout"],
    ] as const) {
      const db = new FakeD1();
      const env = { ...envWith(db), DO_API_TOKEN: "do-token" };
      stubDeletes();
      seedExpiredBooting(db, Date.now() - 60_000, null, state);

      const report = await runBilling(env as never);

      expect(report.reaped, state).toBe(1);
      const server = db.rows("servers")[0];
      expect(server.state).toBe("destroyed");
      expect(server.failure_code).toBe(reason);
      expect(server.failure_stage).toBe(state);
      expect(
        db.rows("wallet_ledger").filter((row) => row.ref_type === "server_refund"),
      ).toHaveLength(1);
      expect(
        db.rows("audit_log").some((row) => row.action === `provision.${reason}`),
      ).toBe(true);
    }
  });

  it("前 50 台销毁都失败时，后面的过期机器仍能扫到并销毁", async () => {
    const db = new FakeD1();
    const env = { ...envWith(db), DO_API_TOKEN: "do-token" };
    const base = Date.now() - 10 * 60 * 1000;
    for (let index = 1; index <= 55; index += 1) {
      db.rows("servers").push({
        id: `srv_${String(index).padStart(3, "0")}`,
        account_id: ACCOUNT,
        order_id: `ord_page_${index}`,
        name: "我的服务器",
        region: "fra1",
        plan: "s-1vcpu-1gb",
        hourly_usd: 0.0125,
        monthly_usd: 6,
        daily_price_cents: DAILY,
        billing_anchor_at: base,
        state: "booting",
        billing_state: "active",
        node_port: 20000 + index,
        provider_id: String(index),
        enrollment_hash: "hash",
        enrollment_used_at: null,
        // 前 50 台更早过期：单次 LIMIT 50 的写法会把 51–55 挡在窗口外。
        enrollment_expires_at: base + index,
        paid_until: base + index + DAY,
        created_at: base,
        updated_at: base,
        destroyed_at: null,
        failure_code: null,
      });
    }
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        if (init?.method === "DELETE") {
          const id = Number(String(input).split("/droplets/")[1]?.split("?")[0] ?? "0");
          // 前 50 台的 DO 删除一直失败；它们不占销毁名额，也不该挡住后面的行。
          return new Response(null, { status: id <= 50 ? 500 : 204 });
        }
        return new Response(JSON.stringify({}), { status: 200 });
      }),
    );

    const report = await runBilling(env as never);

    expect(report.reaped).toBe(5);
    const destroyed = db
      .rows("servers")
      .filter((row) => row.state === "destroyed")
      .map((row) => row.id)
      .sort();
    expect(destroyed).toEqual(["srv_051", "srv_052", "srv_053", "srv_054", "srv_055"]);
    expect(db.rows("servers").filter((row) => row.state === "booting")).toHaveLength(50);
  });
});

describe("结算兜底（at_ready）", () => {
  it("enroll 已消费 token 但没写出 charge：Cron 按结算失败收尾并删除实例", async () => {
    const db = new FakeD1();
    const env = { ...envWith(db), DO_API_TOKEN: "do-token" };
    const now = Date.now();
    db.rows("servers").push({
      id: "srv_settle00000000000",
      account_id: ACCOUNT,
      order_id: "ord_settle",
      provider: "digitalocean",
      provider_id: "4242",
      name: "我的服务器0002",
      region: "sgp1",
      plan: "s-1vcpu-1gb",
      hourly_usd: 0.00893,
      monthly_usd: 6,
      daily_price_cents: 0,
      billing_anchor_at: 0,
      state: "verifying",
      billing_state: "pending",
      node_port: 20444,
      paid_until: null,
      created_at: now - 20 * 60 * 1000,
      updated_at: now - 20 * 60 * 1000,
      destroyed_at: null,
      enrollment_expires_at: now + 10 * 60 * 1000,
      enrollment_used_at: now - 11 * 60 * 1000,
    });
    db.rows("orders").push({
      id: "ord_settle",
      account_id: ACCOUNT,
      region: "sgp1",
      plan: "s-1vcpu-1gb",
      amount_usd: 0.3,
      amount_cents: 30,
      hourly_usd: 0.00893,
      state: "provisioning",
      idempotency_key: "idem-settle-cron",
      charge_mode: "at_ready",
      created_at: now - 20 * 60 * 1000,
    });
    const calls: Array<{ url: string; method?: string }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(input), method: init?.method });
        return new Response(null, { status: 204 });
      }),
    );

    const report = await runBilling(env as never);

    expect(report.settleReaped).toBe(1);
    const server = db.rows("servers")[0];
    expect(server.state).toBe("error");
    expect(server.failure_code).toBe("settle_insufficient");
    expect(server.destroyed_at).toBeNull();
    expect(db.rows("orders")[0].state).toBe("failed");
    expect(db.rows("wallet_ledger")).toHaveLength(0);
    expect(db.rows("audit_log").some((row) => row.action === "settle_insufficient")).toBe(true);
    expect(calls.some((call) => call.method === "DELETE" && call.url.includes("/droplets/4242"))).toBe(true);
  });

  it("并发结算已把订单置 ready：兜底不重复删机器、不计入 reaped", async () => {
    const db = new FakeD1();
    const env = { ...envWith(db), DO_API_TOKEN: "do-token" };
    const now = Date.now();
    db.rows("servers").push({
      id: "srv_settle_race00000",
      account_id: ACCOUNT,
      order_id: "ord_race",
      provider: "digitalocean",
      provider_id: "4242",
      name: "我的服务器0004",
      region: "sgp1",
      plan: "s-1vcpu-1gb",
      hourly_usd: 0.00893,
      monthly_usd: 6,
      daily_price_cents: 0,
      billing_anchor_at: 0,
      state: "verifying",
      billing_state: "pending",
      node_port: 20446,
      paid_until: null,
      created_at: now - 20 * 60 * 1000,
      updated_at: now - 20 * 60 * 1000,
      destroyed_at: null,
      enrollment_expires_at: now + 10 * 60 * 1000,
      enrollment_used_at: now - 11 * 60 * 1000,
    });
    db.rows("orders").push({
      id: "ord_race",
      account_id: ACCOUNT,
      region: "sgp1",
      plan: "s-1vcpu-1gb",
      amount_usd: 0.3,
      amount_cents: 30,
      hourly_usd: 0.00893,
      state: "provisioning",
      idempotency_key: "idem-settle-race",
      charge_mode: "at_ready",
      created_at: now - 20 * 60 * 1000,
    });
    // 扫描到处理后、认领之前，另一路结算成功：订单 ready、服务器 active、钱已扣。
    db.beforeSettleClaim = () => {
      db.rows("orders")[0].state = "ready";
      db.rows("servers")[0].state = "active";
    };
    const calls: Array<{ url: string; method?: string }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(input), method: init?.method });
        return new Response(null, { status: 204 });
      }),
    );

    const report = await runBilling(env as never);

    // 认领不到就不删：多删一次就是删掉用户刚付过钱的机器。
    expect(report.settleReaped).toBe(0);
    expect(calls.some((call) => call.method === "DELETE")).toBe(false);
    expect(db.rows("servers")[0].state).toBe("active");
    expect(db.rows("orders")[0].state).toBe("ready");
    expect(db.rows("audit_log").some((row) => row.action === "settle_insufficient")).toBe(false);
  });

  it("还没到兜底时间的不动", async () => {
    const db = new FakeD1();
    const env = { ...envWith(db), DO_API_TOKEN: "do-token" };
    const now = Date.now();
    db.rows("servers").push({
      id: "srv_settle_fresh00000",
      account_id: ACCOUNT,
      order_id: "ord_fresh",
      provider: "digitalocean",
      provider_id: "4242",
      name: "我的服务器0003",
      region: "sgp1",
      plan: "s-1vcpu-1gb",
      hourly_usd: 0.00893,
      monthly_usd: 6,
      daily_price_cents: 0,
      billing_anchor_at: 0,
      state: "verifying",
      billing_state: "pending",
      node_port: 20445,
      paid_until: null,
      created_at: now,
      updated_at: now,
      destroyed_at: null,
      enrollment_expires_at: now + 30 * 60 * 1000,
      enrollment_used_at: now - 60 * 1000,
    });
    db.rows("orders").push({
      id: "ord_fresh",
      account_id: ACCOUNT,
      region: "sgp1",
      plan: "s-1vcpu-1gb",
      amount_usd: 0.3,
      amount_cents: 30,
      hourly_usd: 0.00893,
      state: "provisioning",
      idempotency_key: "idem-settle-fresh",
      charge_mode: "at_ready",
      created_at: now,
    });

    const report = await runBilling(env as never);

    expect(report.settleReaped).toBe(0);
    expect(db.rows("servers")[0].state).toBe("verifying");
    expect(db.rows("orders")[0].state).toBe("provisioning");
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

describe("失败退款的补退扫描", () => {
  function seedStuckOrder(
    db: FakeD1,
    options: { orderId: string; serverId: string; createdAt: number; serverState?: string; failures?: number },
  ) {
    db.rows("orders").push({
      id: options.orderId,
      account_id: ACCOUNT,
      region: "sgp1",
      plan: "s-1vcpu-1gb",
      amount_usd: 0.3,
      amount_cents: 30,
      hourly_usd: 0.0125,
      state: "failed",
      paid_via: "wallet",
      idempotency_key: `idem-${options.orderId}`,
      created_at: options.createdAt,
      paid_at: options.createdAt,
    });
    db.rows("servers").push({
      id: options.serverId,
      account_id: ACCOUNT,
      order_id: options.orderId,
      name: "我的服务器",
      region: "sgp1",
      plan: "s-1vcpu-1gb",
      hourly_usd: 0.0125,
      monthly_usd: 6,
      daily_price_cents: 30,
      billing_anchor_at: options.createdAt,
      state: options.serverState ?? "error",
      billing_state: "active",
      node_port: 12345,
      provider_id: null,
      paid_until: options.createdAt + DAY,
      created_at: options.createdAt,
      updated_at: options.createdAt,
      destroyed_at: options.serverState === "destroyed" ? options.createdAt : null,
      failure_code: "upstream_422",
    });
    db.rows("wallet_ledger").push({
      account_id: ACCOUNT,
      ref_type: "order",
      ref_id: options.orderId,
      kind: "charge",
      amount_cents: -30,
    });
    for (let index = 0; index < (options.failures ?? 0); index += 1) {
      db.rows("audit_log").push({
        at: options.createdAt + index,
        account_id: ACCOUNT,
        server_id: options.serverId,
        action: "provision.refund_failed",
        detail: JSON.stringify({ error: "missing_account" }),
      });
    }
  }

  it("长期退不动的老单不会把后面的单饿死，且每天只告警一次", async () => {
    const db = new FakeD1();
    const env = envWith(db);
    // 老单：退款连败 5 次，已到放弃线；新单正常可退。
    seedStuckOrder(db, { orderId: "ord_old", serverId: "srv_old", createdAt: 1_000, failures: 5 });
    seedStuckOrder(db, { orderId: "ord_new", serverId: "srv_new", createdAt: 2_000 });

    const report = await runBilling(env as never);

    expect(report.refunded).toBe(1);
    const refunds = db.rows("wallet_ledger").filter((row) => row.ref_type === "server_refund");
    expect(refunds).toHaveLength(1);
    expect(refunds[0].ref_id).toBe("srv_new");
    expect(
      db.rows("audit_log").filter((row) => row.action === "provision.refund_abandoned"),
    ).toHaveLength(1);

    // 同一天再跑：新单已退，老单的告警不重复写。
    await runBilling(env as never);
    expect(
      db.rows("audit_log").filter((row) => row.action === "provision.refund_abandoned"),
    ).toHaveLength(1);
    expect(db.rows("wallet_ledger").filter((row) => row.ref_type === "server_refund")).toHaveLength(1);
  });

  it("已销毁的服务器不进补退扫描（毁机退款口径不同）", async () => {
    const db = new FakeD1();
    const env = envWith(db);
    seedStuckOrder(db, {
      orderId: "ord_dead",
      serverId: "srv_dead",
      createdAt: 1_000,
      serverState: "destroyed",
    });

    const report = await runBilling(env as never);

    expect(report.refunded).toBe(0);
    expect(db.rows("wallet_ledger").filter((row) => row.ref_type === "server_refund")).toHaveLength(0);
  });
});
