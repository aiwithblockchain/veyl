// 计费（设计 §4.6）：每天跑一次——续期、补建「已付但没机器」、对账。
// 只改状态与记账，不销毁任何实例。

import { provisionPaidOrder, type OrdersEnv } from "./orders";
import { reconciliationDrift, recordLedgerEntry } from "./wallet";

const PERIOD_MS = 30 * 24 * 3600 * 1000;
const GRACE_MS = 7 * 24 * 3600 * 1000;
const MAX_CATCH_UP_PERIODS = 12;

export interface BillingEnv extends OrdersEnv {}

interface BillingRow {
  id: string;
  account_id: string;
  plan_price_cents: number;
  paid_until: number;
  billing_state: string;
}

export interface BillingReport {
  renewed: number;
  pastDue: number;
  expired: number;
  rebuilt: number;
  drift: number;
}

export async function runBilling(env: BillingEnv): Promise<BillingReport> {
  const report: BillingReport = { renewed: 0, pastDue: 0, expired: 0, rebuilt: 0, drift: 0 };
  const db = env.DB;
  if (!db) return report;

  const now = Date.now();
  // 只给「真的建出来了」的机器计费：没 provider_id 或出错待处置的，交给失败处置，不扣钱。
  // expired 也要继续扫：机器没删、仍在计费（§4.6）。充值后下一轮补扣并把状态拉回 active。
  const due = await db
    .prepare(
      "SELECT id, account_id, plan_price_cents, paid_until, billing_state FROM servers " +
        "WHERE destroyed_at IS NULL AND provider_id IS NOT NULL " +
        "AND state IN ('booting', 'installing', 'verifying', 'healthy', 'active') " +
        "AND paid_until <= ? LIMIT 50",
    )
    .bind(now)
    .all<BillingRow>();

  for (const server of due.results ?? []) {
    try {
      let paidUntil = Number(server.paid_until);
      let chargedPeriods = 0;

      // 欠多期时一次补到 now 之后，最多 12 期；超过就交给人工。
      while (paidUntil <= now && chargedPeriods < MAX_CATCH_UP_PERIODS) {
        const periodStart = paidUntil;
        const result = await recordLedgerEntry(env, {
          accountId: server.account_id,
          kind: "charge",
          amountCents: -Number(server.plan_price_cents),
          refType: "server_period",
          refId: `${server.id}:${periodStart}`,
          followUps: (ledgerId) => [
            db
              .prepare(
                "UPDATE servers SET paid_until = ?, billing_state = 'active', updated_at = ? " +
                  "WHERE id = ? AND EXISTS (SELECT 1 FROM wallet_ledger WHERE id = ?)",
              )
              .bind(periodStart + PERIOD_MS, now, server.id, ledgerId),
          ],
        });

        if (result.ok) {
          paidUntil = periodStart + PERIOD_MS;
          chargedPeriods += 1;
          continue;
        }

        if (result.reason === "duplicate") {
          // 这一期已经扣过（上次崩在状态更新前）：只把 paid_until 往前推，不重复收钱。
          paidUntil = periodStart + PERIOD_MS;
          chargedPeriods += 1;
          await db
            .prepare("UPDATE servers SET paid_until = MAX(paid_until, ?), billing_state = 'active' WHERE id = ?")
            .bind(paidUntil, server.id)
            .run();
          continue;
        }

        break;
      }

      if (paidUntil > now) {
        report.renewed += 1;
        continue;
      }

      // 没补到 now：宽限从「最后一次补齐后的到期时间」起算，不是从旧值。
      const graceEnd = paidUntil + GRACE_MS;
      const nextState = now >= graceEnd ? "expired" : "past_due";
      if (server.billing_state !== nextState) {
        await db.prepare("UPDATE servers SET billing_state = ?, updated_at = ? WHERE id = ?").bind(nextState, now, server.id).run();
      }
      if (nextState === "expired") report.expired += 1;
      else report.pastDue += 1;
    } catch (error) {
      // 单台出错不能中断整轮：否则其它服务器当天都不续费、对账也不跑。
      console.error(`[billing] server_failed id=${server.id} error=${String(error)}`);
    }
  }

  // 已收款但没有机器：补建（unique(servers.order_id) 保证不会建第二台）。
  // 含卡在 provisioning 的：只要还没拿到 provider_id（或上次建机失败），就再试一次。
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

  const drift = await reconciliationDrift(env);
  report.drift = drift.length;
  for (const item of drift) {
    await db
      .prepare("INSERT INTO audit_log (at, account_id, action, detail) VALUES (?, ?, 'wallet.drift', ?)")
      .bind(now, item.accountId, JSON.stringify(item))
      .run();
    console.error(`[billing] wallet_drift account=${item.accountId} balance=${item.balance} ledger=${item.ledgerSum}`);
  }

  return report;
}
