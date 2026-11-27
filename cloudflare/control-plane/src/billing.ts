// 计费（设计 §4.6 / §4.12）：每小时跑一次——按天续费、补建「已付没机器」、对账、账本归档。
// 续费在到期前 1 小时进入可扣窗口，保证扣费发生在到期之前；只改状态与记账，不销毁任何实例。

import { randomId } from "./lib/crypto";
import { provisionPaidOrder, type OrdersEnv } from "./orders";
import { failPermanently, refundProvision, type ServerToProvision } from "./provision";
import { deleteDroplet, getDroplet, listDropletsByTag } from "./providers/digitalocean";
import { destroyUnpaidServer, sweepExpiredEnrollments, sweepUnsettledSettlements } from "./servers";
import { reconciliationDrift, recordLedgerEntry, type WalletEnv } from "./wallet";

const DAY_MS = 24 * 3600 * 1000;
const GRACE_MS = 7 * DAY_MS;
/** 到期前多久进入可扣窗口：续费提前到到期之前，不再等过期后才补扣。 */
const PREPAY_MS = 60 * 60 * 1000;
const MAX_CATCH_UP_DAYS = 30;
const PAGE_SIZE = 100;
const MAX_PAGES = 5;
const PRUNE_BATCH = 5000;
/** 历史数据保留期：server_traffic 与已销毁机器同为 45 天（traffic-billing.md §7.4）。 */
const RETENTION_MS = 45 * DAY_MS;
/** 单条 DELETE / 单页扫描的上限：每轮多次分页，不写无界大 DELETE。 */
const TRAFFIC_PRUNE_BATCH = 1000;
/**
 * D1 单条语句最多 100 个绑定参数：servers 清理每条语句绑 `99 个 id + 1 个 cutoff = 100`。
 * `TRAFFIC_PRUNE_BATCH` 不受影响——那条 DELETE 只绑 3 个参数（周期 / 截止时间 / LIMIT）。
 */
const SERVERS_PRUNE_BATCH = 99;
const RETENTION_MAX_PAGES = 5;
/** 刷新令牌保留 30 天：已用过/已作废的历史只需覆盖轮换重放窗口。 */
const TOKEN_RETENTION_MS = 30 * DAY_MS;
const TOKEN_PRUNE_BATCH = 1000;
/** 登出留下的匿名账户：过一天、确认没人引用才删。 */
const ORPHAN_ACCOUNT_MIN_AGE_MS = DAY_MS;
const ORPHAN_ACCOUNT_BATCH = 200;

export interface BillingEnv extends OrdersEnv {}

export interface BillingRow {
  id: string;
  account_id: string;
  daily_price_cents: number;
  billing_anchor_at: number;
  paid_until: number;
  billing_state: string;
}

/** `collectDue` 多带四列，只给「失联判定」用；结算本身不需要。 */
interface DueRow extends BillingRow {
  provider_id: string | null;
  last_seen_at: number | null;
  ready_at: number | null;
  provider_gone_at: number | null;
}

export interface BillingReport {
  renewed: number;
  /** 窗口内扣不动、已停机销毁的台数（余额不足）。 */
  unpaidDestroyed: number;
  /** DO 侧确认已不存在、本轮停止计费的台数（不销毁）。 */
  providerGone: number;
  /** 本轮真的打了 DO 存在性查询的台数（含判「还在」与判「消失」）：探测量级一眼可见。 */
  providerProbed: number;
  /** 心跳静默但 DO 查询没给出结论（超时/5xx/无令牌）的台数：下一轮再查，仍照常扣。 */
  providerUnknown: number;
  /**
   * 当前被冻结、还没被用户销毁的台数（`provider_gone_at` 非空且未销毁）。
   * `providerGone` 只计本轮新增，事故过去后从报告里看不出来；这个数才是存量。
   */
  providerGoneActive: number;
  pastDue: number;
  expired: number;
  rebuilt: number;
  refunded: number;
  reaped: number;
  settleReaped: number;
  /** 卡在 `creating` 超过 10 分钟（发起建机的 Worker 已死）被收尾的台数。 */
  creatingReaped: number;
  /** 卡在 `destroying`（Worker 在删远端与落库之间死掉）被恢复成 active 的台数。 */
  destroyingRecovered: number;
  archived: number;
  /** 超龄的历史 `server_traffic` 行（保留每台机器的最大 last_seq 行）。 */
  trafficPruned: number;
  /** 已销毁超过 45 天的 servers 行（同批删掉对应 credentials）。 */
  serversPruned: number;
  tokensPruned: number;
  accountsPruned: number;
  drift: number;
}

/** 第 n 天要扣多少：累计取整，30 天合计正好等于月价（日价 × 30）。 */
function chargeForDay(dailyCents: number, dayIndex: number): number {
  const monthly = dailyCents * 30;
  return Math.floor((monthly * (dayIndex + 1)) / 30) - Math.floor((monthly * dayIndex) / 30);
}

/**
 * 账本裁剪边界：`min(上上个月末, now − 31 天)`，保证机器费明细至少保留 31 天。
 * 只用上上个月末时真实保留期是 28–61 天（3 月 1 日只剩 28 天），会切掉 30 天账单窗口。
 * 文档 §7.4 引用的行号会随重构浮动，以函数名为准。
 */
export function archiveCutoff(now: number): number {
  const date = new Date(now);
  const monthEnd = Date.UTC(date.getUTCFullYear(), date.getUTCMonth() - 1, 1) - 1;
  return Math.min(monthEnd, now - 31 * DAY_MS);
}

function monthKey(at: number): string {
  const date = new Date(at);
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

export async function runBilling(env: BillingEnv): Promise<BillingReport> {
  const report: BillingReport = { renewed: 0, unpaidDestroyed: 0, providerGone: 0, providerProbed: 0, providerUnknown: 0, providerGoneActive: 0, pastDue: 0, expired: 0, rebuilt: 0, refunded: 0, reaped: 0, settleReaped: 0, creatingReaped: 0, destroyingRecovered: 0, archived: 0, trafficPruned: 0, serversPruned: 0, tokensPruned: 0, accountsPruned: 0, drift: 0 };
  const db = env.DB;
  if (!db) return report;

  const now = Date.now();
  // 先处理「enroll 已消费但结算没写成」的 at_ready 残留：这一步要赶在
  // enrollment 超时清理之前，订单才会留下 settle_insufficient 而不是普通建机超时。
  report.settleReaped = await sweepUnsettledSettlements(env, now);
  // 再清掉 enrollment 过期还没回传的机器：它们已经不可能建成，
  // 这一步放在计费之前，免得同一轮又把没人认领的机器扣一天。
  report.reaped = await sweepExpiredEnrollments(env);
  // 再收掉「建机请求没回来」的 creating 行：必须排在补建扫描之前，否则超龄 creating
  // 会先被补建再建一次；关单之后补建条件（paid / provisioning）自然不命中。
  report.creatingReaped = await sweepStaleCreating(env, now);
  // 先把卡住的 destroying 恢复成 active：这类行既不被 collectDue 取到、也不会自己
  // 恢复，不清理就会「机器还在跑、却永远不再扣费」。要在收集到期之前做。
  report.destroyingRecovered = await recoverStuckDestroying(env, now);
  const due = await collectDue(env, now);

  for (const server of due) {
    try {
      // 先确认 DO 侧还在不在，再谈钱：不存在的机器既不该扣费，也不该按「余额不足」销毁。
      const check = await markProviderGone(env, server, now);
      if (check.probed) report.providerProbed += 1;
      if (check.verdict === "gone") {
        report.providerGone += 1;
        continue;
      }
      if (check.verdict === "unknown") report.providerUnknown += 1;
      const result = await settleServer(env, server, now, { delinquent: false });
      // 收集之后才被销毁：销毁已按当时 paid_until 退款，这里不能再扣。
      if (result.reason === "destroyed") continue;
      // 收集之后才被确认 DO 侧已不存在：停扣，不销毁、不写 billing_state。
      // 正常路径在 markProviderGone 就 continue 了，这里兜的是「标记在两步之间才落库」。
      if (result.reason === "gone") {
        report.providerGone += 1;
        await db
          .prepare(
            "INSERT INTO audit_log (at, account_id, server_id, action, detail) VALUES (?, ?, ?, 'billing.gone_at_settle', ?)",
          )
          .bind(
            now,
            server.account_id,
            server.id,
            JSON.stringify({
              provider_gone_at: result.providerGoneAt ?? null,
              paid_until: result.paidUntil,
            }),
          )
          .run()
          .catch((error) =>
            console.warn(
              `[billing] audit_failed action=billing.gone_at_settle server=${server.id} error=${String(error)}`,
            ),
          );
        continue;
      }
      if (result.reason === "ok") {
        report.renewed += 1;
        continue;
      }
      if (result.reason !== "insufficient") {
        // 算不出账 / 账户缺失 / 账本暂不可用：不是欠费，不停机，下一轮再试。
        console.warn(
          `[billing] skip server=${server.id} reason=${result.reason}`,
        );
        continue;
      }
      // 可扣窗口内钱不够：当场停机销毁，没有宽限。销毁失败（DO 删不掉）
      // 时状态由 destroyInstance 还原，下一轮 Cron 再试，不写 past_due / expired。
      if (await destroyUnpaidServer(env, server.id, server.account_id)) {
        report.unpaidDestroyed += 1;
      }
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
  // `s.destroyed_at IS NULL` 是必须的：用户销毁失败态 / 建机中的机器后，订单可能还没关，
  // 少了这一条就会把这台机器重新建出来。
  const orphaned = await db
    .prepare(
      "SELECT o.id FROM orders o LEFT JOIN servers s ON s.order_id = o.id " +
        "WHERE o.state IN ('paid', 'provisioning') AND o.charge_mode = 'upfront' AND o.created_at < ? " +
        "AND s.destroyed_at IS NULL " +
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
  report.trafficPruned = await pruneServerTraffic(env, now);
  report.serversPruned = await pruneDestroyedServers(env, now);
  report.tokensPruned = await pruneRefreshTokens(env, now);
  report.accountsPruned = await pruneOrphanAccounts(env, now);
  // 事故可见性：`providerGone` 只记本轮新增，事故过去后就看不出冻了多少台。
  // 只读计数，查失败不影响这一轮计费。
  try {
    const gone = await db
      .prepare("SELECT id FROM servers WHERE provider_gone_at IS NOT NULL AND destroyed_at IS NULL")
      .all<{ id: string }>();
    report.providerGoneActive = (gone.results ?? []).length;
  } catch (error) {
    console.warn(`[billing] provider_gone_count_failed error=${String(error)}`);
  }
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
        "WHERE o.state = 'failed' AND o.paid_via = 'wallet' AND o.charge_mode = 'upfront' AND s.state = 'error' " +
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
 * 卡住的 `destroying`：`destroyInstance` 先写状态再删远端，失败会自己还原；
 * Worker 恰好在两步之间被踢时，行会永久停在 `destroying`——`collectDue` 不取它，
 * 于是 droplet 还在跑却再也不会扣费。
 *
 * 这里只恢复成 `active`，**不补完销毁**：我们不知道当初为什么销毁、该按哪种退款
 * 口径，猜错就是钱的事。恢复后正常的几条线会接管——到期扫描照常计费，DO 侧真没了的
 * 机器会被 `markProviderGone` 发现，用户也可以自己再点销毁。
 *
 * `billing_state = 'pending'` 的行不能恢复：那是建机阶段，扣费扫描永远不取它，
 * 而两个收割器只认 booting / installing / verifying、孤儿补建要求 provider_id 为空或
 * state='error'——恢复成 active 就会变成一台「运行中却连不上」的永久幻影。
 * 它们维持原状，界面仍有「重试销毁」；让 enroll 收割器补完销毁是更彻底的解法，待办。
 */
const DESTROYING_STUCK_MS = 30 * 60 * 1000;
const DESTROYING_RECOVER_BATCH = 100;

async function recoverStuckDestroying(env: BillingEnv, now: number): Promise<number> {
  const db = env.DB!;
  let recovered = 0;
  try {
    const rows = await db
      .prepare(
        "SELECT id, account_id, updated_at FROM servers " +
          "WHERE state = 'destroying' AND destroyed_at IS NULL AND updated_at < ? " +
          "AND billing_state <> 'pending' LIMIT ?",
      )
      .bind(now - DESTROYING_STUCK_MS, DESTROYING_RECOVER_BATCH)
      .all<{ id: string; account_id: string; updated_at: number }>();
    for (const row of rows.results ?? []) {
      // `updated_at` 一起比对：并发的销毁刚好刷新过这行时不能把它改回 active。
      const updated = await db
        .prepare(
          "UPDATE servers SET state = 'active', updated_at = ? " +
            "WHERE id = ? AND state = 'destroying' AND destroyed_at IS NULL AND updated_at = ?",
        )
        .bind(now, row.id, row.updated_at)
        .run();
      if (Number((updated as { meta?: { changes?: number } }).meta?.changes ?? 0) !== 1) continue;
      recovered += 1;
      await db
        .prepare(
          "INSERT INTO audit_log (at, account_id, server_id, action, detail) VALUES (?, ?, ?, 'server.destroying_recovered', ?)",
        )
        .bind(
          now,
          row.account_id,
          row.id,
          JSON.stringify({ previous_updated_at: Number(row.updated_at) }),
        )
        .run()
        .catch((error) =>
          console.warn(
            `[billing] audit_failed action=server.destroying_recovered server=${row.id} error=${String(error)}`,
          ),
        );
    }
  } catch (error) {
    // 清扫失败不能拖垮整轮计费：下一轮再来。
    console.error(`[billing] destroying_sweep_failed error=${String(error)}`);
  }
  return recovered;
}

/**
 * 建机请求是同步的（秒级）。行停在 `creating` 超过 10 分钟，说明发起它的 Worker 已经死了：
 * DO 上可能建了一半，也可能已经建好但没来得及写 `provider_id`。
 *
 * 收尾口径与 `failPermanently` 一致：落 `error`、关单（补建不再命中）、有已扣的 upfront 款退回。
 * 动手前先按 `veyl:srv:<id>` 反查一次 droplet 并删掉——没有记录的机器没人会再认领它。
 * 删失败不阻断收尾（机器由 DO 侧账单兜底），下一轮也不会再为这一行走一遍。
 */
const CREATING_STALE_MS = 10 * 60 * 1000;
const CREATING_REAP_BATCH = 20;

async function sweepStaleCreating(env: BillingEnv, now: number): Promise<number> {
  const db = env.DB!;
  let reaped = 0;
  try {
    const rows = await db
      .prepare(
        "SELECT id, account_id, order_id, region, plan, node_port FROM servers " +
          "WHERE state = 'creating' AND destroyed_at IS NULL AND updated_at < ? " +
          "ORDER BY updated_at ASC LIMIT ?",
      )
      .bind(now - CREATING_STALE_MS, CREATING_REAP_BATCH)
      .all<ServerToProvision>();
    for (const row of rows.results ?? []) {
      try {
        // 扫描到处理之间建机可能刚好成功（booting）：先认领，抢不到就放手。
        const claimed = await db
          .prepare(
            "UPDATE servers SET state = 'error', failure_code = ?, updated_at = ? " +
              "WHERE id = ? AND state = 'creating' AND destroyed_at IS NULL",
          )
          .bind("creating_timeout", now, row.id)
          .run();
        if (Number((claimed as { meta?: { changes?: number } }).meta?.changes ?? 0) !== 1) continue;
        await deleteCreatingOrphans(env, row.id);
        await failPermanently(
          { DB: db },
          row,
          "creating_timeout",
          JSON.stringify({ reason: "creating_timeout" }),
          now,
        );
        reaped += 1;
      } catch (error) {
        // 认领之后收尾失败就撤回认领：否则行停在 error、订单还在 paid，补建扫描会把它
        // 重新建出来；退回 creating 让下一轮重来，收敛路径保持不变。
        await db
          .prepare(
            "UPDATE servers SET state = 'creating', failure_code = NULL WHERE id = ? " +
              "AND state = 'error' AND failure_code = 'creating_timeout' AND destroyed_at IS NULL",
          )
          .bind(row.id)
          .run()
          .catch(() => {});
        console.error(`[billing] creating_reap_failed server=${row.id} error=${String(error)}`);
      }
    }
  } catch (error) {
    console.error(`[billing] creating_sweep_failed error=${String(error)}`);
  }
  return reaped;
}

/** 建机 tag 在 `provisionServer` 建 droplet 时就写上；没有记录又没来得及登记的机器只能靠它找回来。 */
async function deleteCreatingOrphans(env: BillingEnv, serverId: string): Promise<void> {
  if (!env.DO_API_TOKEN) return;
  const tagged = await listDropletsByTag(env.DO_API_TOKEN, `veyl:srv:${serverId}`);
  if (!tagged.ok) {
    console.warn(
      `[billing] creating_orphan_lookup_failed server=${serverId} reason=${tagged.reason}`,
    );
    return;
  }
  for (const droplet of tagged.value) {
    const deleted = await deleteDroplet(env.DO_API_TOKEN, droplet.providerId);
    if (!deleted.ok && deleted.status !== 404) {
      console.warn(
        `[billing] creating_orphan_delete_failed server=${serverId} droplet=${droplet.providerId} reason=${deleted.reason}`,
      );
    }
  }
}

/**
 * 取本轮到期的服务器：游标分页，避免「永远只扣前 50 台」。
 * expired 不参与（§4.6：停机期间不产生费用），只由充值后的恢复路径处理。
 */
async function collectDue(env: BillingEnv, now: number): Promise<DueRow[]> {
  const db = env.DB!;
  const stored = await db
    .prepare("SELECT value FROM billing_cursor WHERE id = 'servers'")
    .first<{ value: string }>();
  let cursor = stored?.value ?? "";
  const rows: DueRow[] = [];
  let exhausted = false;

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const result = await db
      .prepare(
        "SELECT id, account_id, daily_price_cents, billing_anchor_at, paid_until, billing_state, " +
          "provider_id, last_seen_at, ready_at, provider_gone_at FROM servers " +
          "WHERE destroyed_at IS NULL AND provider_id IS NOT NULL AND paid_until > 0 " +
          "AND daily_price_cents > 0 AND billing_anchor_at > 0 " +
          "AND billing_state <> 'expired' AND billing_state <> 'pending' " +
          "AND provider_gone_at IS NULL " +
          "AND state IN ('booting', 'installing', 'verifying', 'healthy', 'active') " +
          "AND paid_until <= ? AND id > ? ORDER BY id LIMIT ?",
      )
      .bind(now + PREPAY_MS, cursor, PAGE_SIZE)
      .all<DueRow>();
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

/** agent 30 分钟必报一次（空闲也报 0 字节）；静默超过这个时间才值得花一次 DO 查询。 */
const GONE_PROBE_AFTER_MS = 2 * 60 * 60 * 1000;

type ProviderGoneVerdict = "gone" | "alive" | "unknown";

interface ProviderGoneCheck {
  verdict: ProviderGoneVerdict;
  /** 本轮真的打了 DO（不论结论）：上线第一轮要能从 cron 报告里看出探测量级。 */
  probed: boolean;
}

/**
 * 用户在 DO 后台直接删掉 droplet 时，我们自己的表没有任何痕迹（迁移 0017）：
 * `state` 还是 active、`destroyed_at` 为空，于是照常扣费、额度照常涨。
 * 只在「到期待扣 + 心跳静默超过 2 小时」的交集上问一次 DO：
 *
 * - 404：唯一正向的「不存在」信号，落 `provider_gone_at`，本轮不扣、不销毁；
 * - 200：机器还在。agent 挂了不是停计费的理由（计费不看在线），照常扣；
 * - 超时 / 5xx / 429 / 401 / 没配令牌：**不下结论**，本轮照常扣、下一轮再查。
 *   绝不能「查不出来就免费」——那会把一次 DO 抖动变成全站免单。
 */
async function markProviderGone(
  env: BillingEnv,
  server: DueRow,
  now: number,
): Promise<ProviderGoneCheck> {
  const db = env.DB;
  if (!db) return { verdict: "unknown", probed: false };
  if (server.provider_gone_at != null) return { verdict: "gone", probed: false };
  // 心跳优先；0010 之前建的老机器没有心跳，退到 ready_at / 计费锚点当「最后一次已知存活」——
  // 否则恰恰是这类最老的机器永远绕过检测，而它们最可能早就被删了。
  // 已结算行必有其一（collectDue 要求 `billing_anchor_at > 0`）。
  const seen = server.last_seen_at ?? server.ready_at ?? server.billing_anchor_at;
  if (now - Number(seen) <= GONE_PROBE_AFTER_MS) return { verdict: "alive", probed: false };
  if (!env.DO_API_TOKEN || !server.provider_id) return { verdict: "unknown", probed: false };

  const droplet = await getDroplet(env.DO_API_TOKEN, server.provider_id);
  if (droplet.ok) return { verdict: "alive", probed: true };
  if (droplet.status !== 404) return { verdict: "unknown", probed: true };

  // 写入失败不能静默：标记没落库就等于这台继续扣费，下一轮还会重来。
  const marked = await db
    .prepare(
      "UPDATE servers SET provider_gone_at = ?, updated_at = ? WHERE id = ? AND provider_gone_at IS NULL",
    )
    .bind(now, now, server.id)
    .run()
    .catch((error) => {
      console.warn(`[billing] provider_gone_write_failed server=${server.id} error=${String(error)}`);
      return null;
    });
  // 只有真改了这一行才写审计：并发双例会重复写，写失败时审计也没有依据。
  // 两种情况都不影响本轮结论——探测已经看到 404，这一轮不扣钱，下一轮自然重来。
  if (marked === null || Number(marked.meta?.changes ?? 0) !== 1) {
    return { verdict: "gone", probed: true };
  }
  await db
    .prepare(
      "INSERT INTO audit_log (at, account_id, server_id, action, detail) VALUES (?, ?, ?, 'server.provider_gone', ?)",
    )
    .bind(
      now,
      server.account_id,
      server.id,
      JSON.stringify({
        provider_id: server.provider_id,
        last_seen_at: server.last_seen_at ?? null,
        ready_at: server.ready_at ?? null,
        seen_at: Number(seen),
        checked_at: now,
      }),
    )
    .run()
    .catch((error) =>
      console.warn(`[billing] audit_failed action=server.provider_gone server=${server.id} error=${String(error)}`),
    );
  console.warn(
    `[billing] provider_gone server=${server.id} provider_id=${server.provider_id} seen_at=${seen}`,
  );
  return { verdict: "gone", probed: true };
}

/** 当前是否还能扣费；行不存在、已销毁、正在销毁、DO 侧已确认不存在都不能。 */
async function liveServerState(
  db: D1Database,
  server: BillingRow,
): Promise<{
  live: boolean;
  state: string | null;
  paidUntil: number;
  providerGoneAt: number | null;
}> {
  const row = await db
    .prepare("SELECT * FROM servers WHERE id = ? AND account_id = ?")
    .bind(server.id, server.account_id)
    .first<{ state?: string; destroyed_at?: number | null; paid_until?: number; provider_gone_at?: number | null }>();
  if (!row) {
    return {
      live: false,
      state: null,
      paidUntil: Number(server.paid_until),
      providerGoneAt: null,
    };
  }
  const state = row.destroyed_at != null ? "destroyed" : (row.state ?? null);
  return {
    live: state !== "destroying" && state !== "destroyed",
    state,
    paidUntil: Number(row.paid_until ?? server.paid_until),
    providerGoneAt: row.provider_gone_at == null ? null : Number(row.provider_gone_at),
  };
}

/**
 * 结算结论。`runBilling` 只对 `insufficient` 停机销毁：
 * 算不出账（`unbillable`）、账户缺失、账本暂时不可用都不能当成欠费。
 */
type SettleReason =
  | "ok"
  | "destroyed"
  | "gone"
  | "unbillable"
  | "missing_account"
  | "unavailable"
  | "insufficient";

interface SettleOutcome {
  state: string;
  days: number;
  charged: boolean;
  paidUntil: number;
  reason: SettleReason;
  /** `reason === "gone"` 时标记的原值：审计要写，别的路径不带。 */
  providerGoneAt?: number | null;
}

/** 把一台服务器的账补到 now 之后；返回最终状态。 */
export async function settleServer(
  env: WalletEnv,
  server: BillingRow,
  now: number,
  options: { delinquent?: boolean } = {},
): Promise<SettleOutcome> {
  const db = env.DB!;
  const daily = Number(server.daily_price_cents);
  const anchor = Number(server.billing_anchor_at);
  if (!Number.isFinite(daily) || daily <= 0 || !Number.isFinite(anchor) || anchor <= 0) {
    // 存量行可能缺日价/锚点：算不出该扣多少，绝不能因此停机删机器。
    return {
      state: server.billing_state,
      days: 0,
      charged: false,
      paidUntil: Number(server.paid_until),
      reason: "unbillable",
    };
  }

  // collectDue 取到行之后、结算之前，用户可能已经开始销毁（destroying）或已销毁。
  // 销毁会退款并停止计费；不在结算前复查，销毁之后仍会扣一天，而退款覆盖不到。
  // 复查后到记账之间仍有缝，真正的拦截在账本 INSERT 的守卫里。
  // 复查同时带回最新的 paid_until：循环用它起算，不拿循环外的旧值。
  const live = await liveServerState(db, server);
  if (!live.live) {
    return {
      state: "destroyed",
      days: 0,
      charged: false,
      paidUntil: live.paidUntil,
      reason: "destroyed",
    };
  }
  // DO 侧已确认不存在（`provider_gone_at` 非空）：停扣，但**不是** destroyed。
  // 只靠账本守卫拦的话，扣不动会落到 insufficient，runBilling 会按欠费去销毁一台
  // 已经不存在的机器、走退款流程——所以必须在结算这层先短路。
  if (live.providerGoneAt != null) {
    return {
      state: live.state ?? server.billing_state,
      days: 0,
      charged: false,
      paidUntil: live.paidUntil,
      reason: "gone",
      providerGoneAt: live.providerGoneAt,
    };
  }

  let paidUntil = live.paidUntil;
  let days = 0;
  let failure: SettleReason | null = null;

  while (paidUntil - PREPAY_MS <= now && days < MAX_CATCH_UP_DAYS) {
    const bucket = paidUntil;
    const dayIndex = Math.max(0, Math.floor((bucket - anchor) / DAY_MS));
    const amount = chargeForDay(daily, dayIndex);
    const result = await recordLedgerEntry(env, {
      accountId: server.account_id,
      kind: "charge",
      amountCents: -amount,
      refType: "server_day",
      refId: `${server.id}:${bucket}`,
      // 守卫和记账在同一条 INSERT 里：服务器一旦进入 destroyed / destroying、
      // 或在 DO 侧被确认已不存在，这一格就不写账，避免销毁之后继续扣。
      guard: {
        sql:
          "SELECT 1 FROM servers WHERE id = ? AND destroyed_at IS NULL " +
          "AND state NOT IN ('destroying', 'destroyed') AND provider_gone_at IS NULL",
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
    if (!current.live) {
      return { state: "destroyed", days, charged: days > 0, paidUntil, reason: "destroyed" };
    }

    // 记账失败要分清原因：只有「钱不够」才停机；账户缺失、账本不可用都是环境问题。
    failure = result.reason;
    break;
  }

  // 状态只在整轮结束后写一次：中途 break 不会留下「已欠费却显示 active」。
  // 欠费判定点仍是 `paid_until` 本身，不含提前量：提前扣失败时机器还没到期，必须仍是 active。
  const state =
    paidUntil > now
      ? "active"
      : days >= MAX_CATCH_UP_DAYS || now >= paidUntil + GRACE_MS
        ? "expired"
        : "past_due";
  // 新路径不再产生 past_due / expired（扣不动直接停机销毁），但旧行还能被读；
  // 它们补扣成功时仍要写回 active，所以「只写 active」不受 delinquent 限制。
  const mayMarkDelinquent = options.delinquent !== false || state === "active";
  if (state !== server.billing_state && mayMarkDelinquent) {
    await db
      .prepare("UPDATE servers SET billing_state = ?, updated_at = ? WHERE id = ?")
      .bind(state, now, server.id)
      .run();
  }
  // 扣款失败要按原因区分；补到 30 天上限仍然过期，同样算「钱不够」。
  const reason: SettleReason = failure ?? (paidUntil > now ? "ok" : "insufficient");
  return { state, days, charged: days > 0, paidUntil, reason };
}

/**
 * 充值后的恢复路径（§4.6）：expired 不参与每日扫描，只有充值能把它拉回来。
 * 欠超过 30 天时先豁免到「现在往前 30 天」的锚点格，再正常补 30 天。
 *
 * **只服务存量行**：新扣费路径不再产生 past_due / expired（窗口内扣不动直接停机销毁），
 * 这里补扣失败时仍会写这两种状态，给界面读老数据用。
 */
export async function recoverExpiredServers(env: WalletEnv, accountId: string): Promise<number> {
  const db = env.DB;
  if (!db) return 0;
  const now = Date.now();
  const rows = await db
    .prepare(
      "SELECT id, account_id, daily_price_cents, billing_anchor_at, paid_until, billing_state FROM servers " +
        "WHERE account_id = ? AND billing_state = 'expired' AND destroyed_at IS NULL " +
        "AND provider_gone_at IS NULL AND provider_id IS NOT NULL LIMIT 20",
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
 * 刷新令牌清理：每次刷新插一行，活跃设备一天约 96 行。
 * 不能按 `created_at` 删：30 天前签发、最近还在轮换的令牌是活凭据。
 * - 已用过/已作废：按「最后一次生命周期事件」（COALESCE(revoked_at, used_at)）满 30 天才删；
 * - 从没用过但已过期的行：已经不可能再换出新令牌，直接清掉。
 * 分页靠 LIMIT 每轮最多删一批；单轮失败只记日志，不影响计费。
 */
async function pruneRefreshTokens(env: BillingEnv, now: number): Promise<number> {
  const db = env.DB!;
  try {
    const deleted = await db
      .prepare(
        "DELETE FROM refresh_tokens WHERE hash IN (" +
          "SELECT hash FROM refresh_tokens " +
          "WHERE COALESCE(revoked_at, used_at) < ? " +
          "OR (used_at IS NULL AND revoked_at IS NULL AND expires_at < ?) LIMIT ?)",
      )
      .bind(now - TOKEN_RETENTION_MS, now, TOKEN_PRUNE_BATCH)
      .run();
    return Number((deleted as { meta?: { changes?: number } }).meta?.changes ?? 0);
  } catch (error) {
    console.error(`[billing] token_prune_failed error=${String(error)}`);
    return 0;
  }
}

/**
 * 孤儿匿名账户：登出把设备挪到新匿名账户，旧的留在库里。
 * 没有任何设备/订单/服务器/充值单/支付流水/余额且超过一天才删；
 * 有余额或任何业务记录都保留——否则未结算的充值会失去账户，入账变 missing_account。
 * 已并入邮箱账户的行（merged_into）不删：那是合并审计的一部分。
 */
async function pruneOrphanAccounts(env: BillingEnv, now: number): Promise<number> {
  const db = env.DB!;
  try {
    const deleted = await db
      .prepare(
        "DELETE FROM accounts WHERE id IN (" +
          "SELECT a.id FROM accounts a " +
          "WHERE a.kind = 'device' AND a.merged_into IS NULL AND a.created_at < ? " +
          "AND a.balance_cents = 0 " +
          "AND NOT EXISTS (SELECT 1 FROM devices d WHERE d.account_id = a.id) " +
          "AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.account_id = a.id) " +
          "AND NOT EXISTS (SELECT 1 FROM servers s WHERE s.account_id = a.id) " +
          "AND NOT EXISTS (SELECT 1 FROM topups t WHERE t.account_id = a.id) " +
          "AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.account_id = a.id) " +
          "LIMIT ?)",
      )
      .bind(now - ORPHAN_ACCOUNT_MIN_AGE_MS, ORPHAN_ACCOUNT_BATCH)
      .run();
    return Number((deleted as { meta?: { changes?: number } }).meta?.changes ?? 0);
  } catch (error) {
    console.error(`[billing] account_prune_failed error=${String(error)}`);
    return 0;
  }
}

/**
 * 账本归档（§4.12）：逐账户先写月末快照，成功后再删该账户已过期明细。
 * 快照没写成就不删——宁可多留，不能留下无依据的余额。
 *
 * 已知限制（traffic-billing.md §7.4）：这里只裁剪 `server_day`（机器费）明细；
 * 充值、流量超支（`server_traffic`）与退款明细目前永久保留，本批不动。
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

      // 快照按裁剪边界所在 UTC 月归集；边界被 now−31 天夹住后不一定是月末，
      // 但按月生成的 refId 仍然幂等，INSERT OR IGNORE 不会重复写。
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

/**
 * `server_traffic` 保留清理（§7.4）：三个条件缺一不可——
 * 1) 不是当前周期（当前周期还在累加）；
 * 2) `updated_at` 超过 45 天（防止删掉 agent 仍在用的行）；
 * 3) `last_seq` 小于该 server 的历史最大值。去重取 `MAX(last_seq) WHERE server_id = ?`
 *    且跨周期；若某台机器所有行都超龄，整批删掉会让 MAX 归零，一个压了很久的旧 seq
 *    重发就会被重复记账。加这条后每台机器的最大 seq 行永远保留。
 * 复合主键没有单列 id，用行值 `(server_id, cycle_id)` 定位，不依赖 rowid。
 */
export async function pruneServerTraffic(env: BillingEnv, now: number): Promise<number> {
  const db = env.DB;
  if (!db) return 0;
  const cycle = monthKey(now);
  const cutoff = now - RETENTION_MS;
  let pruned = 0;
  try {
    for (let page = 0; page < RETENTION_MAX_PAGES; page += 1) {
      const deleted = await db
        .prepare(
          "DELETE FROM server_traffic WHERE (server_id, cycle_id) IN (" +
            "SELECT st.server_id, st.cycle_id FROM server_traffic st " +
            "WHERE st.cycle_id != ? AND st.updated_at < ? " +
            "AND st.last_seq < (SELECT MAX(t2.last_seq) FROM server_traffic t2 WHERE t2.server_id = st.server_id) " +
            "LIMIT ?)",
        )
        .bind(cycle, cutoff, TRAFFIC_PRUNE_BATCH)
        .run();
      const changes = Number((deleted as { meta?: { changes?: number } }).meta?.changes ?? 0);
      pruned += changes;
      if (changes < TRAFFIC_PRUNE_BATCH) break;
    }
  } catch (error) {
    console.error(`[billing] traffic_prune_failed error=${String(error)}`);
  }
  return pruned;
}

/**
 * 已销毁超过 45 天的 servers 行清理（§7.4）：同批删对应 credentials 与 server_traffic，
 * 否则会留下永久孤儿密文 / 孤儿计量行（token 已随 servers 行消失，last_seq 不再有去重意义）。
 *
 * 只删「订单不处于 paid / provisioning」的机器：仅删服务器行会解开 `servers_order` 唯一约束，
 * 补建逻辑（含 `s.id IS NULL`）可能把一台用户已销毁的机器重新建出来并继续扣费。
 * 三条语句都带同样的 destroyed + 订单守卫，避免 servers 行没删掉却删了从属数据。
 *
 * 已知影响：更早的 `wallet_ledger` 行 `ref_id` 会指向已删除的 server id（悬空）；
 * 账单 §8.1 允许解析失败时只显示类别，且超支 / 退款明细本就永久保留，故不级联清理。
 */
export async function pruneDestroyedServers(env: BillingEnv, now: number): Promise<number> {
  const db = env.DB;
  if (!db) return 0;
  const cutoff = now - RETENTION_MS;
  let pruned = 0;
  try {
    for (let page = 0; page < RETENTION_MAX_PAGES; page += 1) {
      const rows = await db
        .prepare(
          "SELECT id FROM servers WHERE state = 'destroyed' AND destroyed_at IS NOT NULL " +
            "AND destroyed_at < ? " +
            "AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.id = servers.order_id " +
            "AND o.state IN ('paid', 'provisioning')) " +
            "ORDER BY destroyed_at ASC LIMIT ?",
        )
        .bind(cutoff, SERVERS_PRUNE_BATCH)
        .all<{ id: string }>();
      const ids = (rows.results ?? []).map((row) => String(row.id));
      if (ids.length === 0) break;
      const placeholders = ids.map(() => "?").join(", ");
      const guard =
        " AND server_id IN (SELECT id FROM servers WHERE state = 'destroyed' " +
        "AND destroyed_at IS NOT NULL AND destroyed_at < ? " +
        "AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.id = servers.order_id " +
        "AND o.state IN ('paid', 'provisioning')))";
      const results = await db.batch([
        db
          .prepare(`DELETE FROM server_traffic WHERE server_id IN (${placeholders})${guard}`)
          .bind(...ids, cutoff),
        db
          .prepare(`DELETE FROM credentials WHERE server_id IN (${placeholders})${guard}`)
          .bind(...ids, cutoff),
        db
          .prepare(
            `DELETE FROM servers WHERE id IN (${placeholders}) AND state = 'destroyed' ` +
              "AND destroyed_at IS NOT NULL AND destroyed_at < ? " +
              "AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.id = servers.order_id " +
              "AND o.state IN ('paid', 'provisioning'))",
          )
          .bind(...ids, cutoff),
      ]);
      const removed = Number(
        (results[2] as { meta?: { changes?: number } } | undefined)?.meta?.changes ?? 0,
      );
      pruned += removed;
      if (ids.length < SERVERS_PRUNE_BATCH) break;
    }
  } catch (error) {
    console.error(`[billing] server_prune_failed error=${String(error)}`);
  }
  return pruned;
}
