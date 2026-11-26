// 「还能用几天」的两条聚合走真实 SQL：fakeD1 用 JS 重写了一遍谓词，
// 这里验的是控制面实际发出的语句（§5.4）。
import { describe, expect, it } from "vitest";

import { walletSummary } from "../src/topups";
import { openMigratedDb, sqliteAvailable, type SqliteD1 } from "./helpers/sqliteD1";

const ACCOUNT = "acct_wallet_summary";
const NOW = Date.parse("2026-11-26T12:00:00Z");
const DAY_MS = 24 * 3600 * 1000;

// Node 22 上 node:sqlite 需要 --experimental-sqlite；拿不到就跳过，不让环境差异变成红。
const hasSqlite = sqliteAvailable();
if (!hasSqlite) {
  console.warn(
    "[wallet_summary_sqlite] 跳过真实 SQL 用例：node:sqlite 不可用（Node 22 需要 --experimental-sqlite）",
  );
}
const describeSqlite = hasSqlite ? describe : describe.skip;

let port = 40000;

function addServer(
  db: SqliteD1,
  id: string,
  cents: number,
  options: {
    billingState?: string;
    destroyedAt?: number | null;
    providerGoneAt?: number | null;
  } = {},
): void {
  db.run(
    "INSERT INTO servers (id, account_id, order_id, name, region, plan, hourly_usd, monthly_usd, " +
      "daily_price_cents, billing_anchor_at, state, node_port, created_at, updated_at, destroyed_at, billing_state, provider_gone_at) " +
      "VALUES (?, ?, ?, ?, 'sgp1', 's-1vcpu-1gb', 0, 0, ?, 0, 'healthy', ?, ?, ?, ?, ?, ?)",
    id,
    ACCOUNT,
    `ord_${id}`,
    `机器 ${id}`,
    cents,
    port++,
    NOW,
    NOW,
    options.destroyedAt ?? null,
    options.billingState ?? "active",
    options.providerGoneAt ?? null,
  );
}

function addLedger(
  db: SqliteD1,
  id: string,
  amountCents: number,
  refType: string,
  createdAt: number,
  kind = "charge",
): void {
  db.run(
    "INSERT INTO wallet_ledger (id, account_id, kind, amount_cents, balance_after_cents, ref_type, ref_id, note, created_at) " +
      "VALUES (?, ?, ?, ?, 0, ?, ?, NULL, ?)",
    id,
    ACCOUNT,
    kind,
    amountCents,
    refType,
    id,
    createdAt,
  );
}

async function summaryOf(
  db: SqliteD1,
  balance: number,
): Promise<Awaited<ReturnType<typeof walletSummary>>> {
  return walletSummary({ DB: db as unknown as D1Database }, ACCOUNT, balance, NOW);
}

async function emptySummary(
  balance: number,
): Promise<Awaited<ReturnType<typeof walletSummary>>> {
  return summaryOf(await openMigratedDb(), balance);
}

describeSqlite("钱包剩余天数（真实 SQL）", () => {
  it("日价只合计在跑的机器", async () => {
    const db = await openMigratedDb();
    addServer(db, "srv_a", 30);
    addServer(db, "srv_b", 40, { billingState: "past_due" });
    addServer(db, "srv_pending", 100, { billingState: "pending" });
    addServer(db, "srv_expired", 50, { billingState: "expired" });
    addServer(db, "srv_gone", 60, { destroyedAt: NOW - DAY_MS });
    // DO 后台直接删掉的：destroyed_at 仍是 null、billing_state 仍是 active，只能靠 provider_gone_at 排除。
    addServer(db, "srv_provider_gone", 100, { providerGoneAt: NOW });

    const summary = await summaryOf(db, 4200);
    expect(summary.daily_cents).toBe(70);
    expect(summary.remaining_days).toBe(60);
  });

  it("超支扣费只取近 7 天的 server_traffic / charge 并取反", async () => {
    const db = await openMigratedDb();
    addServer(db, "srv_a", 70);
    addLedger(db, "wl_traffic_now", -700, "server_traffic", NOW - 3 * DAY_MS);
    addLedger(db, "wl_traffic_edge", -140, "server_traffic", NOW - 7 * DAY_MS + 1);
    addLedger(db, "wl_traffic_old", -1400, "server_traffic", NOW - 7 * DAY_MS - 1);
    addLedger(db, "wl_day", -30, "server_day", NOW - DAY_MS);
    addLedger(db, "wl_topup", 5000, "stripe_payment", NOW - DAY_MS, "topup");

    // 840 / 7 = 120；完整日消耗 = 70 + 120 = 190；1000 / 190 = 5.26 → 5 天。
    const summary = await summaryOf(db, 1000);
    expect(summary.daily_cents).toBe(190);
    expect(summary.remaining_days).toBe(5);
  });

  it("没有在跑的机器时日消耗为 0，天数为 null", async () => {
    const summary = await emptySummary(5000);
    expect(summary.daily_cents).toBe(0);
    expect(summary.remaining_days).toBeNull();
  });

  it("余额为 0 时是 0 天", async () => {
    const db = await openMigratedDb();
    addServer(db, "srv_a", 30);
    const summary = await summaryOf(db, 0);
    expect(summary.remaining_days).toBe(0);
  });
});
