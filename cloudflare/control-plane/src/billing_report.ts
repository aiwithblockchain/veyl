// 账单流水：把 wallet_ledger 摊平成 App 账单页能直读的形状。
// 响应的字段名就是 App 契约，改之前先改契约。

import { authenticate, isResponse, type MaybeAuthEnv } from "./auth";
import { apiError, json } from "./lib/http";
import { balanceCents } from "./wallet";

const DAY_MS = 24 * 3600 * 1000;
const DEFAULT_DAYS = 30;
/**
 * 窗口上限 30 天必须 **≤ 账本保留期（≥31 天，traffic-billing.md §7.4）**：
 * 调大就会读到已被裁剪的区间，账单静默少算。
 */
const MAX_DAYS = 30;
/** 列表上限；多查一条只为判断有没有被截断，不下发。 */
const MAX_ENTRIES = 1000;

export type BillingReportEnv = MaybeAuthEnv;

export type EntryKind = "topup" | "machine_day" | "traffic" | "refund" | "other";

/**
 * `order` 是建机第 0 天的扣费，和 `server_day` 一样要归到 `machine_day`；
 * 归不出来的 ref_type 一律 `other`，**不能丢行**，否则合计对不上。
 *
 * `other` 的钱**有意不进 `totals`**：它既不是入账（topup）也不是扣费（charge 只看负数），
 * 只是在明细里露个面。等 `manual` 真有人写入时再单独拍口径。
 */
const KIND_BY_REF_TYPE: Record<string, EntryKind> = {
  stripe_payment: "topup",
  dodo_payment: "topup",
  order: "machine_day",
  server_day: "machine_day",
  server_traffic: "traffic",
  server_refund: "refund",
};

function kindOf(refType: string): EntryKind {
  return KIND_BY_REF_TYPE[refType] ?? "other";
}

/**
 * 机器归属：
 * - `server_day` 的 ref_id 是 `<server_id>:<day>`、`server_traffic` 是 `<server_id>:<cycle>:<seq>`、
 *   `server_refund` 是 `<server_id>`，取第一个冒号前的前缀；
 * - `order` 的 ref_id 是订单号，走 `orders.id → servers.order_id`（不是 orders.server_id，
 *   那样重建后会指向另一台机器）。
 * 解析不出机器时整行照样返回，只是 `server` 为 null。
 */
const LEDGER_SQL =
  "SELECT w.id AS id, w.ref_type AS ref_type, w.ref_id AS ref_id, " +
  "w.amount_cents AS amount_cents, w.created_at AS created_at, w.note AS note, " +
  "s.id AS server_id, s.name AS server_name, s.plan AS server_plan, s.region AS server_region " +
  "FROM wallet_ledger w " +
  "LEFT JOIN orders o ON w.ref_type = 'order' AND o.id = w.ref_id " +
  "LEFT JOIN servers s ON (w.ref_type = 'order' AND s.order_id = o.id) " +
  "OR (w.ref_type IN ('server_day', 'server_traffic', 'server_refund') " +
  "AND s.id = substr(w.ref_id, 1, instr(w.ref_id || ':', ':') - 1)) " +
  "WHERE w.account_id = ? AND w.ref_type <> 'snapshot' " +
  "AND w.created_at > ? AND w.created_at <= ? " +
  "ORDER BY w.created_at DESC, w.id DESC LIMIT ?";

/**
 * 合计必须与列表同条件但**不受 LIMIT 影响**：窗口超过 1000 行时，列表被截断，
 * 合计仍要是全量，否则顶部「充值 12000」和下面列出来的行对不上。
 */
const TOTALS_SQL =
  "SELECT " +
  "COALESCE(SUM(CASE WHEN ref_type IN ('stripe_payment', 'dodo_payment') THEN amount_cents ELSE 0 END), 0) AS topup_cents, " +
  "COALESCE(SUM(CASE WHEN amount_cents < 0 THEN -amount_cents ELSE 0 END), 0) AS charge_cents " +
  "FROM wallet_ledger " +
  "WHERE account_id = ? AND ref_type <> 'snapshot' AND created_at > ? AND created_at <= ?";

interface LedgerRow {
  id: string;
  ref_type: string;
  ref_id: string;
  amount_cents: number;
  created_at: number;
  note: string | null;
  server_id: string | null;
  server_name: string;
  server_plan: string;
  server_region: string;
}

interface ServerBrief {
  id: string;
  name: string;
  plan: string;
  region: string;
}

export interface LedgerEntry {
  id: string;
  kind: EntryKind;
  amount_cents: number;
  at: number;
  server: ServerBrief | null;
  note: string | null;
}

export interface LedgerReport {
  balance_cents: number;
  currency: "USD";
  window_days: number;
  /** 窗口内超过 1000 笔时列表被截断，客户端据此提示「只显示最近 1000 笔」。 */
  truncated: boolean;
  totals: { topup_cents: number; charge_cents: number };
  entries: LedgerEntry[];
}

/** 只接受十进制整数 1–30；缺省、非数字（含 `0x10`/`1e1` 这类 Number 能认的写法）、越界都按 30 处理。 */
export function windowDays(raw: string | null): number {
  if (raw == null || !/^\d+$/.test(raw)) return DEFAULT_DAYS;
  const value = Number(raw);
  if (value < 1 || value > MAX_DAYS) return DEFAULT_DAYS;
  return value;
}

export async function buildLedgerReport(
  db: D1Database,
  accountId: string,
  days: number,
  now: number,
): Promise<LedgerReport> {
  // 窗口是半开区间 (now - days, now]：恰好卡在 N 天前那一毫秒的行不在本窗口内。
  // 列表与合计都用这一条边界，两者口径一致。
  const cutoff = now - days * DAY_MS;
  // 多取一条：用来判断是否截断，比 `entries.length === 1000` 准（正好 1000 行时不会误报）。
  const result = await db
    .prepare(LEDGER_SQL)
    .bind(accountId, cutoff, now, MAX_ENTRIES + 1)
    .all<LedgerRow>();
  const rows = result.results ?? [];

  const entries: LedgerEntry[] = rows.slice(0, MAX_ENTRIES).map((row) => ({
    id: row.id,
    kind: kindOf(row.ref_type),
    // 符号直接沿用账本：扣费为负、入账为正。
    amount_cents: Number(row.amount_cents),
    at: Number(row.created_at),
    server:
      row.server_id == null
        ? null
        : {
            id: row.server_id,
            name: row.server_name,
            plan: row.server_plan,
            region: row.server_region,
          },
    note: row.note ?? null,
  }));

  const totals = await db
    .prepare(TOTALS_SQL)
    .bind(accountId, cutoff, now)
    .first<{ topup_cents: number; charge_cents: number }>();

  return {
    balance_cents: await balanceCents({ DB: db }, accountId),
    currency: "USD",
    window_days: days,
    truncated: rows.length > MAX_ENTRIES,
    totals: {
      topup_cents: Number(totals?.topup_cents ?? 0),
      charge_cents: Number(totals?.charge_cents ?? 0),
    },
    entries,
  };
}

export async function handleBillingLedger(
  request: Request,
  env: BillingReportEnv,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== "/v1/billing/ledger") return null;
  if (request.method !== "GET") {
    return apiError("PRECONDITION_FAILED", "方法不允许", { status: 405 });
  }
  if (!env.DB) return apiError("INTERNAL", "服务还没准备好", { retryable: true, status: 503 });

  const identity = await authenticate(request, env);
  if (isResponse(identity)) return identity;

  const days = windowDays(url.searchParams.get("days"));
  const report = await buildLedgerReport(env.DB, identity.accountId, days, Date.now());
  return json(report);
}
