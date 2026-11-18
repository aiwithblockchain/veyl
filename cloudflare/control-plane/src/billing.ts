// 计费（设计 §4.6 / §4.12）：每天跑一次——按天续费、补建「已付没机器」、对账、账本归档。
// 只改状态与记账，不销毁任何实例。

import { randomId } from "./lib/crypto";
import { provisionPaidOrder, type OrdersEnv } from "./orders";
import { refundProvision } from "./provision";
import { reconciliationDrift, recordLedgerEntry } from "./wallet";

const DAY_MS = 24 * 3600 * 1000;
const GRACE_MS = 7 * DAY_MS;
const MAX_CATCH_UP_DAYS = 30;
const PAGE_SIZE = 100;
const MAX_PAGES = 5;
const PRUNE_BATCH = 5000;

export interface BillingEnv extends OrdersEnv {}

interface BillingRow {
  id: string;
  account_id: string;
  daily_price_cents: number;
  billing_anchor_at: number;
  paid_until: number;
  billing_state: string;
}

export interface BillingReport {
  renewed: number;
  pastDue: number;
  expired: number;
  rebuilt: number;
  refunded: number;
  archived: number;
  drift: number;
}

/** 第 n 天要扣多少：累计取整，30 天合计正好等于月价（日价 × 30）。 */
function chargeForDay(dailyCents: number, dayIndex: number): number {
  const monthly = dailyCents * 30;
  return Math.floor((monthly * (dayIndex + 1)) / 30) - Math.floor((monthly * dayIndex) / 30);
}

/** 账本裁剪边界：上上个月末，实际保留 31–60 天。用上月末会只留 1–31 天。 */
function archiveCutoff(now: number): number {
  const date = new Date(now);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() - 1, 1) - 1;
}

function monthKey(at: number): string {
  const date = new Date(at);
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

export async function runBilling(env: BillingEnv): Promise<BillingReport> {
  const report: BillingReport = { renewed: 0, pastDue: 0, expired: 0, rebuilt: 0, refunded: 0, archived: 0, drift: 0 };
  const db = env.DB;
  if (!db) return report;

  const now = Date.now();
  const due = await collectDue(env, now);

  for (const server of due) {
    try {
      const result = await settleServer(env, server, now);
      // 收集之后才被销毁：销毁已按当时 paid_until 退款，这里不能再扣。
      if (result.state === "destroyed") continue;
      if (result.state === "active") report.renewed += 1;
      else if (result.state === "expired") report.expired += 1;
      else report.pastDue += 1;
    } catch (error) {
      // 单台出错不能中断整轮；也要留下痕迹，否则这台会永远不扣费且无处可查。
      console.error(`[billing] server_failed id=${server.id} error=${String(error)}`);
      await db
        .prepare("INSERT INTO audit_log (at, account_id, server_id, action, detail) VALUES (?, ?, ?, 'billing.failed', ?)")
        .bind(now, server.account_id, server.id, JSON.stringify({ error: String(error) }))
        .run()
        .catch(() => {});
    }
  }

  // 已收款但没有机器：补建（unique(servers.order_id) 保证不会建第二台）。
  const orphaned = await db
    .prepare(
      "SELECT o.id FROM orders o LEFT JOIN servers s ON s.order_id = o.id " +
        "WHERE o.state IN ('paid', 'provisioning') AND o.created_at < ? " +
        "AND (s.id IS NULL OR s.provider_id IS NULL OR s.state = 'error') LIMIT 5",
    )
    .bind(now - 5 * 60 * 1000)
    .all<{ id: string }>();
  for (const row of orphaned.results ?? []) {
    try {
      const result = await provisionPaidOrder(env, row.id);
      if (result.ok) report.rebuilt += 1;
    } catch (error) {
      console.error(`[billing] provision_failed order=${row.id} error=${String(error)}`);
    }
  }

  // 扣了钱、机器没建成、退款又没写成的单：每轮补退一次，避免钱和状态都卡住。
  report.refunded = await retryStuckRefunds(env, now);

  const drift = await reconciliationDrift(env);
  report.drift = drift.length;  for (const item of drift) {
    try {
      await db
        .prepare("INSERT INTO audit_log (at, account_id, action, detail) VALUES (?, ?, 'wallet.drift', ?)")
        .bind(now, item.accountId, JSON.stringify(item))
        .run();
    } catch (error) {
      console.error(`[billing] drift_audit_failed account=${item.accountId} error=${String(error)}`);
    }
    console.error(`[billing] wallet_drift account=${item.accountId} balance=${item.balance} latest=${item.latest}`);
  }

  report.archived = await archiveLedger(env, now);
  return report;
}

/** 一条补退连续失败这么多次就放弃重试，只留每日告警，免得无限刷日志。 */
const MAX_REFUND_FAILURES = 5;
/** 每轮最多补退这么多单；按 `created_at ASC` 取，老单先处理。 */
const REFUND_BATCH = 5;

/**
 * 残留的「扣了没退」：建机永久失败时退款可能没写成（账户被并、D1 抖动）。
 * 每轮补退一次；成功了由 refundProvision 写 provision.refunded 审计。
 *
 * 只扫 `s.state = 'error'`：已销毁的机器走销毁退款，金额口径不同，不能被这里按 1 天退掉。
 * 连续失败 `MAX_REFUND_FAILURES` 次的单跳过，每天写一次 `provision.refund_abandoned`，
 * 否则它会在 `LIMIT` 里长期占位，把后面的单饿死。
 */
async function retryStuckRefunds(env: BillingEnv, now: number): Promise<number> {
  const db = env.DB!;
  const rows = await db
    .prepare(
      "SELECT o.id AS order_id, o.account_id, o.amount_cents, s.id AS server_id, s.failure_code, " +
        "o.created_at AS created_at, " +
        "(SELECT COUNT(*) FROM audit_log a WHERE a.action = 'provision.refund_failed' AND a.server_id = s.id) AS failures, " +
        "(SELECT MAX(a.at) FROM audit_log a WHERE a.action = 'provision.refund_abandoned' AND a.server_id = s.id) AS abandoned_at " +
        "FROM orders o JOIN servers s ON s.order_id = o.id " +
        "WHERE o.state = 'failed' AND o.paid_via = 'wallet' AND s.state = 'error' " +
        "AND EXISTS (SELECT 1 FROM wallet_ledger w WHERE w.ref_type = 'order' AND w.ref_id = o.id AND w.kind = 'charge') " +
        "AND NOT EXISTS (SELECT 1 FROM wallet_ledger w WHERE w.ref_type = 'server_refund' AND w.ref_id = s.id) " +
        "ORDER BY o.created_at ASC LIMIT 50",
    )
    .all<{
      order_id: string;
      account_id: string;
      amount_cents: number;
      server_id: string;
      failure_code: string | null;
      failures: number;
      abandoned_at: number | null;
    }>();

  const dayStart = Math.floor(now / DAY_MS) * DAY_MS;
  let refunded = 0;
  let attempted = 0;
  for (const row of rows.results ?? []) {
    if (Number(row.failures ?? 0) >= MAX_REFUND_FAILURES) {
      // 每天只告警一次：拿不到账户之类的错误重试也没用，等人处理。
      if (Number(row.abandoned_at ?? 0) < dayStart) {
        await db
          .prepare(
            "INSERT INTO audit_log (at, account_id, server_id, action, detail) VALUES (?, ?, ?, 'provision.refund_abandoned', ?)",
          )
          .bind(
            now,
            row.account_id,
            row.server_id,
            JSON.stringify({
              order_id: row.order_id,
              amount_cents: Number(row.amount_cents ?? 0),
              failures: Number(row.failures ?? 0),
            }),
          )
          .run()
          .catch(() => {});
      }
      continue;
    }
    if (attempted >= REFUND_BATCH) continue;
    attempted += 1;
    try {
      const result = await refundProvision({ DB: db }, {
        accountId: row.account_id,
        orderId: row.order_id,
        serverId: row.server_id,
        amountCents: Number(row.amount_cents ?? 0),
        reason: row.failure_code ?? "provision_failed",
        now,
      });
      if (result.ok) refunded += 1;
      else console.error(`[billing] refund_retry_failed order=${row.order_id} reason=${result.reason}`);
    } catch (error) {
      console.error(`[billing] refund_retry_failed order=${row.order_id} error=${String(error)}`);
    }
  }
  return refunded;
}

/**
 * 取本轮到期的服务器：游标分页，避免「永远只扣前 50 台」。
 * expired 不参与（§4.6：停机期间不产生费用），只由充值后的恢复路径处理。
 */
async function collectDue(env: BillingEnv, now: number): Promise<BillingRow[]> {
  const db = env.DB!;
  const stored = await db
    .prepare("SELECT value FROM billing_cursor WHERE id = 'servers'")
    .first<{ value: string }>();
  let cursor = stored?.value ?? "";
  const rows: BillingRow[] = [];
  let exhausted = false;

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const result = await db
      .prepare(
        "SELECT id, account_id, daily_price_cents, billing_anchor_at, paid_until, billing_state FROM servers " +
          "WHERE destroyed_at IS NULL AND provider_id IS NOT NULL AND paid_until > 0 " +
          "AND billing_state <> 'expired' " +
          "AND state IN ('booting', 'installing', 'verifying', 'healthy', 'active') " +
          "AND paid_until <= ? AND id > ? ORDER BY id LIMIT ?",
      )
      .bind(now, cursor, PAGE_SIZE)
      .all<BillingRow>();
    const pageRows = result.results ?? [];
    rows.push(...pageRows);
    if (pageRows.length < PAGE_SIZE) {
      exhausted = true;
      break;
    }
    cursor = pageRows[pageRows.length - 1].id;
  }

  await db
    .prepare("INSERT OR REPLACE INTO billing_cursor (id, value) VALUES ('servers', ?)")
    .bind(exhausted ? "" : cursor)
    .run();
  return rows;
}

/** 当前是否还能扣费；行不存在、已销毁、正在销毁都不能。 */
async function liveServerState(
  db: D1Database,
  server: BillingRow,
): Promise<{ live: boolean; state: string | null; paidUntil: number }> {
  const row = await db
    .prepare("SELECT * FROM servers WHERE id = ? AND account_id = ?")
    .bind(server.id, server.account_id)
    .first<{ state?: string; destroyed_at?: number | null; paid_until?: number }>();
  if (!row) return { live: false, state: null, paidUntil: Number(server.paid_until) };
  const state = row.destroyed_at != null ? "destroyed" : (row.state ?? null);
  return {
    live: state !== "destroying" && state !== "destroyed",
    state,
    paidUntil: Number(row.paid_until ?? server.paid_until),
  };
}

/** 把一台服务器的账补到 now 之后；返回最终状态。 */
async function settleServer(
  env: BillingEnv,
  server: BillingRow,
  now: number,
): Promise<{ state: string; days: number; paidUntil: number }> {
  const db = env.DB!;
  const daily = Number(server.daily_price_cents);
  const anchor = Number(server.billing_anchor_at);
  if (!Number.isFinite(daily) || daily <= 0 || !Number.isFinite(anchor) || anchor <= 0) {
    return { state: server.billing_state, days: 0, paidUntil: Number(server.paid_until) };
  }

  // collectDue 取到行之后、结算之前，用户可能已经开始销毁（destroying）或已销毁。
  // 销毁会退款并停止计费；不在结算前复查，销毁之后仍会扣一天，而退款覆盖不到。
  // 复查后到记账之间仍有缝，真正的拦截在账本 INSERT 的守卫里。
  // 复查同时带回最新的 paid_until：循环用它起算，不拿循环外的旧值。
  const live = await liveServerState(db, server);
  if (!live.live) {
    return { state: "destroyed", days: 0, paidUntil: live.paidUntil };
  }

  let paidUntil = live.paidUntil;
  let days = 0;

  while (paidUntil <= now && days < MAX_CATCH_UP_DAYS) {
    const bucket = paidUntil;
    const dayIndex = Math.max(0, Math.floor((bucket - anchor) / DAY_MS));
    const amount = chargeForDay(daily, dayIndex);
    const result = await recordLedgerEntry(env, {
      accountId: server.account_id,
      kind: "charge",
      amountCents: -amount,
      refType: "server_day",
      refId: `${server.id}:${bucket}`,
      // 守卫和记账在同一条 INSERT 里：服务器一旦进入 destroyed / destroying，
      // 这一格就不写账，避免销毁之后继续扣。
      guard: {
        sql: "SELECT 1 FROM servers WHERE id = ? AND destroyed_at IS NULL AND state NOT IN ('destroying', 'destroyed')",
        args: [server.id],
      },
      followUps: (ledgerId) => [
        db
          .prepare(
            "UPDATE servers SET paid_until = ?, updated_at = ? " +
              "WHERE id = ? AND paid_until = ? AND EXISTS (SELECT 1 FROM wallet_ledger WHERE id = ?)",
          )
          .bind(bucket + DAY_MS, now, server.id, bucket, ledgerId),
      ],
    });

    if (result.ok) {
      paidUntil = bucket + DAY_MS;
      days += 1;
      continue;
    }

    if (result.reason === "duplicate") {
      // 这一格已经扣过（上次崩在状态更新前）：只把 paid_until 往前推，不重复收钱。
      paidUntil = bucket + DAY_MS;
      days += 1;
      await db
        .prepare(
          "UPDATE servers SET paid_until = MAX(paid_until, ?), updated_at = ? WHERE id = ? AND paid_until = ?",
        )
        .bind(paidUntil, now, server.id, bucket)
        .run();
      continue;
    }

    // 守卫不成立会落到 insufficient：以库里的状态为准，别把正在销毁的机器标成欠费。
    const current = await liveServerState(db, server);
    if (!current.live) return { state: "destroyed", days, paidUntil };

    break;
  }

  // 状态只在整轮结束后写一次：中途 break 不会留下「已欠费却显示 active」。
  const state =
    paidUntil > now
      ? "active"
      : days >= MAX_CATCH_UP_DAYS || now >= paidUntil + GRACE_MS
        ? "expired"
        : "past_due";
  if (state !== server.billing_state) {
    await db
      .prepare("UPDATE servers SET billing_state = ?, updated_at = ? WHERE id = ?")
      .bind(state, now, server.id)
      .run();
  }
  return { state, days, paidUntil };
}

/**
 * 充值后的恢复路径（§4.6）：expired 不参与每日扫描，只有充值能把它拉回来。
 * 欠超过 30 天时先豁免到「现在往前 30 天」的锚点格，再正常补 30 天。
 */
export async function recoverExpiredServers(env: BillingEnv, accountId: string): Promise<number> {
  const db = env.DB;
  if (!db) return 0;
  const now = Date.now();
  const rows = await db
    .prepare(
      "SELECT id, account_id, daily_price_cents, billing_anchor_at, paid_until, billing_state FROM servers " +
        "WHERE account_id = ? AND billing_state = 'expired' AND destroyed_at IS NULL " +
        "AND provider_id IS NOT NULL LIMIT 20",
    )
    .bind(accountId)
    .all<BillingRow>();

  let recovered = 0;
  for (const server of rows.results ?? []) {
    try {
      const anchor = Number(server.billing_anchor_at);
      const owed = Math.floor((now - Number(server.paid_until)) / DAY_MS);
      if (owed > MAX_CATCH_UP_DAYS && anchor > 0) {
        const nNow = Math.floor((now - anchor) / DAY_MS);
        // +1：对齐点落在「今天这一格的起点」，再补 30 天正好越过 now。
        const aligned = anchor + Math.max(0, nNow - MAX_CATCH_UP_DAYS + 1) * DAY_MS;
        await db
          .prepare("UPDATE servers SET paid_until = ?, updated_at = ? WHERE id = ? AND billing_state = 'expired'")
          .bind(aligned, now, server.id)
          .run();
        await db
          .prepare("INSERT INTO audit_log (at, account_id, server_id, action, detail) VALUES (?, ?, ?, 'grace_waived', ?)")
          .bind(now, server.account_id, server.id, JSON.stringify({ owed, waived: owed - MAX_CATCH_UP_DAYS }))
          .run();
        server.paid_until = aligned;
      }
      const result = await settleServer(env, server, now);
      if (result.state === "active") recovered += 1;
    } catch (error) {
      console.error(`[billing] recover_failed account=${accountId} server=${server.id} error=${String(error)}`);
    }
  }
  return recovered;
}

/**
 * 账本归档（§4.12）：逐账户先写月末快照，成功后再删该账户已过期明细。
 * 快照没写成就不删——宁可多留，不能留下无依据的余额。
 */
async function archiveLedger(env: BillingEnv, now: number): Promise<number> {
  const db = env.DB;
  if (!db) return 0;
  const cutoff = archiveCutoff(now);

  const accounts = await db
    .prepare(
      "SELECT DISTINCT account_id FROM wallet_ledger WHERE ref_type = 'server_day' AND created_at <= ? " +
        "ORDER BY account_id LIMIT 200",
    )
    .bind(cutoff)
    .all<{ account_id: string }>();

  let pruned = 0;
  for (const row of accounts.results ?? []) {
    try {
      const last = await db
        .prepare(
          "SELECT balance_after_cents FROM wallet_ledger WHERE account_id = ? AND created_at <= ? " +
            "ORDER BY created_at DESC, rowid DESC LIMIT 1",
        )
        .bind(row.account_id, cutoff)
        .first<{ balance_after_cents: number }>();
      if (!last) continue;

      const refId = `${row.account_id}:${monthKey(cutoff)}`;
      await db
        .prepare(
          "INSERT OR IGNORE INTO wallet_ledger (id, account_id, kind, amount_cents, balance_after_cents, ref_type, ref_id, note, created_at) " +
            "VALUES (?, ?, 'snapshot', 0, ?, 'snapshot', ?, NULL, ?)",
        )
        .bind(randomId("snap_"), row.account_id, Number(last.balance_after_cents), refId, cutoff)
        .run();

      const snapshot = await db
        .prepare("SELECT id FROM wallet_ledger WHERE ref_type = 'snapshot' AND ref_id = ?")
        .bind(refId)
        .first<{ id: string }>();
      if (!snapshot) continue;

      // 可移植分片：D1 不保证支持 DELETE ... LIMIT；只删这个账户已被快照承接的行。
      const deleted = await db
        .prepare(
          "DELETE FROM wallet_ledger WHERE id IN (" +
            "SELECT id FROM wallet_ledger WHERE account_id = ? AND ref_type = 'server_day' AND created_at <= ? LIMIT ?)",
        )
        .bind(row.account_id, cutoff, PRUNE_BATCH)
        .run();
      pruned += (deleted as { meta?: { changes?: number } }).meta?.changes ?? 0;
    } catch (error) {
      console.error(`[billing] archive_failed account=${row.account_id} error=${String(error)}`);
    }
  }
  return pruned;
}
