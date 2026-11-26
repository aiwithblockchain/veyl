// 账号本周期口径（traffic-billing.md §4.1）：扣费与界面共用同一份求和。
//
// 单独成模块的原因和 traffic_cycle.ts 一样——traffic.ts 依赖 servers.ts
// （destroyUnpaidServer），servers.ts 需要这里的 accountTotals 给列表加
// traffic_pool；放在中立模块里两边都能取，不形成循环。

import { releasedBytes, type ReleasedRow } from "./traffic_cycle";

export interface TrafficTotals {
  used: number;
  released: number;
  charged: number;
}

/**
 * 账号本周期口径：`used` / `charged` 来自各机器上报行；
 * `released` 从 `servers` 表现算账号下**每台**机器，不依赖「本周期有上报行」——
 * 否则周期开始后、静默或新机首报前的窗口里额度会缺席，导致同账号其它机器被多扣。
 *
 * 注意分母是 `servers` 全表（含已销毁、已 dismiss 的机器），不是列表接口返回的那些。
 */
export async function accountTotals(
  db: D1Database,
  accountId: string,
  cycleId: string,
  now: number,
): Promise<TrafficTotals> {
  const row = await db
    .prepare(
      "SELECT COALESCE(SUM(t.bytes), 0) AS used, COALESCE(SUM(t.charged_cents), 0) AS charged " +
        "FROM server_traffic t JOIN servers s ON s.id = t.server_id " +
        "WHERE s.account_id = ? AND t.cycle_id = ?",
    )
    .bind(accountId, cycleId)
    .first<{ used: number; charged: number }>();
  const servers = await db
    .prepare(
      "SELECT transfer_gib, ready_at, billing_anchor_at, created_at, destroyed_at, provider_gone_at, paid_until " +
        "FROM servers WHERE account_id = ?",
    )
    .bind(accountId)
    .all<ReleasedRow>();
  const released = (servers.results ?? []).reduce(
    (sum, server) => sum + releasedBytes(server, cycleId, now),
    0,
  );
  return {
    used: Number(row?.used ?? 0),
    released,
    charged: Number(row?.charged ?? 0),
  };
}
