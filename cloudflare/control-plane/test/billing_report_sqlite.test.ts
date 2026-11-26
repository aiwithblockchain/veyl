import { describe, expect, it } from "vitest";

import { buildLedgerReport } from "../src/billing_report";
import { openMigratedDb, sqliteAvailable, type SqliteD1 } from "./helpers/sqliteD1";

const ACCOUNT = "acct_ledger_sql";
const OTHER_ACCOUNT = "acct_ledger_sql_other";
const NOW = Date.parse("2026-11-26T12:00:00Z");
const DAY_MS = 24 * 3600 * 1000;

// Node 22 上 node:sqlite 需要 --experimental-sqlite；拿不到就跳过，不让环境差异变成红。
const hasSqlite = sqliteAvailable();
if (!hasSqlite) {
  console.warn(
    "[billing_report_sqlite] 跳过真实 SQL 用例：node:sqlite 不可用（Node 22 需要 --experimental-sqlite）",
  );
}
const describeSqlite = hasSqlite ? describe : describe.skip;

function addLedger(
  db: SqliteD1,
  entry: {
    id: string;
    ref_type: string;
    ref_id: string;
    amount_cents: number;
    created_at?: number;
    account_id?: string;
  },
): void {
  db.run(
    "INSERT INTO wallet_ledger (id, account_id, kind, amount_cents, balance_after_cents, ref_type, ref_id, note, created_at) " +
      "VALUES (?, ?, 'charge', ?, 0, ?, ?, NULL, ?)",
    entry.id,
    entry.account_id ?? ACCOUNT,
    entry.amount_cents,
    entry.ref_type,
    entry.ref_id,
    entry.created_at ?? NOW - 1000,
  );
}

function addServer(db: SqliteD1, id: string, orderId: string, name = "东京-01"): void {
  db.run(
    "INSERT INTO servers (id, account_id, order_id, name, region, plan, hourly_usd, monthly_usd, " +
      "daily_price_cents, billing_anchor_at, state, node_port, created_at, updated_at, destroyed_at) " +
      "VALUES (?, ?, ?, ?, 'sgp1', 's-1vcpu-1gb', 0, 0, 0, 0, 'active', 1, ?, ?, NULL)",
    id,
    ACCOUNT,
    orderId,
    name,
    NOW,
    NOW,
  );
}

function addOrder(db: SqliteD1, id: string): void {
  db.run(
    "INSERT INTO orders (id, account_id, region, plan, amount_usd, amount_cents, hourly_usd, state, idempotency_key, created_at) " +
      "VALUES (?, ?, 'sgp1', 's-1vcpu-1gb', 0, 0, 0, 'ready', ?, ?)",
    id,
    ACCOUNT,
    id,
    NOW,
  );
}

async function openDb(): Promise<SqliteD1> {
  const db = await openMigratedDb();
  db.run(
    "INSERT INTO accounts (id, kind, status, balance_cents, created_at) VALUES (?, 'email', 'active', 11806, ?)",
    ACCOUNT,
    NOW,
  );
  return db;
}

describeSqlite("账单流水 · 真实 SQL（node:sqlite + 全部迁移）", () => {
  it("类别映射与机器归属：order 走 orders.order_id，计量类取 ref_id 前缀", async () => {
    const db = await openDb();
    try {
      addServer(db, "srv_sql", "ord_sql");
      addOrder(db, "ord_sql");
      addLedger(db, { id: "led_stripe", ref_type: "stripe_payment", ref_id: "cs_1", amount_cents: 7000 });
      addLedger(db, { id: "led_dodo", ref_type: "dodo_payment", ref_id: "pay_1", amount_cents: 5000 });
      addLedger(db, { id: "led_order", ref_type: "order", ref_id: "ord_sql", amount_cents: -164 });
      addLedger(db, { id: "led_order_gone", ref_type: "order", ref_id: "ord_gone", amount_cents: -164 });
      addLedger(db, { id: "led_day", ref_type: "server_day", ref_id: "srv_sql:2026-11-25", amount_cents: -30 });
      addLedger(db, { id: "led_traffic", ref_type: "server_traffic", ref_id: "srv_sql:2026-11:2", amount_cents: -2 });
      addLedger(db, { id: "led_refund", ref_type: "server_refund", ref_id: "srv_sql", amount_cents: 60 });
      addLedger(db, { id: "led_manual", ref_type: "manual", ref_id: "adj_1", amount_cents: -5 });

      const report = await buildLedgerReport(db as unknown as D1Database, ACCOUNT, 30, NOW);
      const byId = Object.fromEntries(report.entries.map((entry) => [entry.id, entry]));

      expect(Object.fromEntries(report.entries.map((entry) => [entry.id, entry.kind]))).toEqual({
        led_stripe: "topup",
        led_dodo: "topup",
        led_order: "machine_day",
        led_order_gone: "machine_day",
        led_day: "machine_day",
        led_traffic: "traffic",
        led_refund: "refund",
        led_manual: "other",
      });
      const brief = { id: "srv_sql", name: "东京-01", plan: "s-1vcpu-1gb", region: "sgp1" };
      expect(byId.led_order.server).toEqual(brief);
      expect(byId.led_day.server).toEqual(brief);
      expect(byId.led_traffic.server).toEqual(brief);
      expect(byId.led_refund.server).toEqual(brief);
      expect(byId.led_stripe.server).toBeNull();
      expect(byId.led_manual.server).toBeNull();
      // 解析不到机器时整行仍返回。
      expect(byId.led_order_gone).toMatchObject({ server: null, amount_cents: -164 });
      expect(report.balance_cents).toBe(11806);
      expect(report.currency).toBe("USD");
    } finally {
      db.close();
    }
  });

  it("账号隔离：别人的行不进列表、不进合计，余额是本人余额", async () => {
    const db = await openDb();
    try {
      db.run(
        "INSERT INTO accounts (id, kind, status, balance_cents, created_at) VALUES (?, 'email', 'active', 999999, ?)",
        OTHER_ACCOUNT,
        NOW,
      );
      addLedger(db, { id: "led_mine", ref_type: "server_day", ref_id: "srv_x:d1", amount_cents: -30 });
      addLedger(db, {
        id: "led_theirs_topup",
        ref_type: "stripe_payment",
        ref_id: "cs_theirs",
        amount_cents: 50_000,
        account_id: OTHER_ACCOUNT,
      });
      addLedger(db, {
        id: "led_theirs_charge",
        ref_type: "server_day",
        ref_id: "srv_y:d1",
        amount_cents: -700,
        account_id: OTHER_ACCOUNT,
      });

      const report = await buildLedgerReport(db as unknown as D1Database, ACCOUNT, 30, NOW);
      expect(report.entries.map((entry) => entry.id)).toEqual(["led_mine"]);
      expect(report.totals).toEqual({ topup_cents: 0, charge_cents: 30 });
      expect(report.balance_cents).toBe(11806);
    } finally {
      db.close();
    }
  });

  it("snapshot 与超窗行不出现；totals 与逐行求和一致", async () => {
    const db = await openDb();
    try {
      addLedger(db, { id: "led_snap", ref_type: "snapshot", ref_id: `${ACCOUNT}:2026-09`, amount_cents: 0 });
      addLedger(db, { id: "led_edge", ref_type: "server_day", ref_id: "srv_x:d1", amount_cents: -30, created_at: NOW - 30 * DAY_MS });
      addLedger(db, { id: "led_topup", ref_type: "stripe_payment", ref_id: "cs_1", amount_cents: 12_000 });
      addLedger(db, { id: "led_day", ref_type: "server_day", ref_id: "srv_x:d2", amount_cents: -30 });
      addLedger(db, { id: "led_order", ref_type: "order", ref_id: "ord_x", amount_cents: -164 });
      addLedger(db, { id: "led_traffic", ref_type: "server_traffic", ref_id: "srv_x:2026-11:2", amount_cents: -100 });
      addLedger(db, { id: "led_refund", ref_type: "server_refund", ref_id: "srv_x", amount_cents: 60 });
      // 上界是 now：未来时间的行不进窗口。
      addLedger(db, { id: "led_future", ref_type: "server_day", ref_id: "srv_x:d3", amount_cents: -30, created_at: NOW + 1 });

      const report = await buildLedgerReport(db as unknown as D1Database, ACCOUNT, 30, NOW);
      expect(report.entries.map((entry) => entry.id).sort()).toEqual([
        "led_day",
        "led_order",
        "led_refund",
        "led_topup",
        "led_traffic",
      ]);
      expect(report.totals).toEqual({ topup_cents: 12_000, charge_cents: 294 });
    } finally {
      db.close();
    }
  });

  it("排序 created_at DESC、id DESC，最多 1000 条", async () => {
    const db = await openDb();
    try {
      db.exec("BEGIN");
      for (let index = 0; index < 1005; index += 1) {
        addLedger(db, {
          id: `led_${String(index).padStart(4, "0")}`,
          ref_type: "server_day",
          ref_id: `srv_x:d${index}`,
          amount_cents: -30,
          created_at: NOW - 1000 - Math.floor(index / 3),
        });
      }
      db.exec("COMMIT");

      const report = await buildLedgerReport(db as unknown as D1Database, ACCOUNT, 30, NOW);
      expect(report.entries).toHaveLength(1000);
      expect(report.truncated).toBe(true);
      // 全量求和：1005 × 30，不是前 1000 行。
      expect(report.totals).toEqual({ topup_cents: 0, charge_cents: 1005 * 30 });
      expect(report.entries.slice(0, 3).map((entry) => entry.id)).toEqual([
        "led_0002",
        "led_0001",
        "led_0000",
      ]);
      expect(report.entries[999].id).toBe("led_1001");
      const times = report.entries.map((entry) => entry.at);
      expect(times).toEqual([...times].sort((left, right) => right - left));
    } finally {
      db.close();
    }
  });

  it("超过 1000 笔：列表截断、truncated=true，totals 仍是全量求和", async () => {
    const db = await openDb();
    try {
      db.exec("BEGIN");
      // 200 笔充值在最旧的一端：列表只留下 1000 笔扣费，合计必须仍包含这 200 笔。
      for (let index = 0; index < 200; index += 1) {
        addLedger(db, {
          id: `led_top_${String(index).padStart(3, "0")}`,
          ref_type: "stripe_payment",
          ref_id: `cs_${index}`,
          amount_cents: 100,
          created_at: NOW - 200_000 - index,
        });
      }
      for (let index = 0; index < 1000; index += 1) {
        addLedger(db, {
          id: `led_day_${String(index).padStart(4, "0")}`,
          ref_type: "server_day",
          ref_id: `srv_x:d${index}`,
          amount_cents: -3,
          created_at: NOW - 1000 - index,
        });
      }
      db.exec("COMMIT");

      const report = await buildLedgerReport(db as unknown as D1Database, ACCOUNT, 30, NOW);
      expect(report.entries).toHaveLength(1000);
      expect(report.truncated).toBe(true);
      expect(report.entries.every((entry) => entry.kind === "machine_day")).toBe(true);
      expect(report.totals).toEqual({ topup_cents: 200 * 100, charge_cents: 1000 * 3 });
    } finally {
      db.close();
    }
  });
});
