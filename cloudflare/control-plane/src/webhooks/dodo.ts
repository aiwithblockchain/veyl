// Dodo 支付回调（设计 §4.3）：验签 → 事件去重 → 订单匹配 → 标记已付 → 建机。
// 只有这里能把订单推进到 paid；客户端轮询不触发建机。

import { sha256B64u } from "../lib/crypto";
import { json } from "../lib/http";
import { provisionPaidOrder, type OrdersEnv } from "../orders";
import { verifyDodoSignature } from "../payments/dodo";

interface PaymentData {
  id?: unknown;
  subscription_id?: unknown;
  customer?: { email?: unknown };
  metadata?: Record<string, unknown>;
  checkout_session_id?: unknown;
  session_id?: unknown;
  payment_id?: unknown;
  settlement_amount?: unknown;
  total_amount?: unknown;
  amount?: unknown;
  currency?: unknown;
  status?: unknown;
  /** 本期账单周期，续费后顺延；`ends_at` 是 ISO 8601。 */
  service_periods?: Array<{ ends_at?: unknown }>;
  next_billing_date?: unknown;
  current_period_end?: unknown;
  cancel_at_period_end?: unknown;
}

/** 订阅事件 → 我们自己的状态。未列出的事件只更新到期时间，不改状态。 */
const SUBSCRIPTION_STATUS: Record<string, string> = {
  "subscription.active": "active",
  "subscription.renewed": "active",
  "subscription.unpaused": "active",
  "subscription.past_due": "past_due",
  "subscription.failed": "past_due",
  "subscription.on_hold": "on_hold",
  "subscription.paused": "paused",
  "subscription.cancelled": "cancelled",
  "subscription.expired": "expired",
};

/** epoch 秒 / 毫秒 / ISO 字符串都接受，统一成毫秒。 */
function parseInstant(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value > 1e12 ? value : value * 1000;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** 本期结束时间：优先 service_periods 里最晚的 ends_at，其次到期字段。 */
function periodEnd(data: PaymentData): number | null {
  const periods = Array.isArray(data.service_periods) ? data.service_periods : [];
  let latest: number | null = null;
  for (const period of periods) {
    const at = parseInstant(period?.ends_at);
    if (at !== null && (latest === null || at > latest)) latest = at;
  }
  if (latest !== null) return latest;
  return parseInstant(data.next_billing_date) ?? parseInstant(data.current_period_end);
}

interface MatchedOrder {
  id: string;
  account_id: string;
  amount_usd: number;
}

function amountUsd(data: PaymentData): number {
  // settlement_amount 是美元分；total_amount 是结账币种分；amount 偶见美元数值。
  if (typeof data.settlement_amount === "number" && data.settlement_amount > 0) {
    return Math.round(data.settlement_amount) / 100;
  }
  if (typeof data.amount === "number" && data.amount > 0) return data.amount;
  if (typeof data.total_amount === "number" && data.total_amount > 0) {
    return Math.round(data.total_amount) / 100;
  }
  return 0;
}

async function markEvent(
  env: OrdersEnv,
  eventId: string,
  status: "processed" | "failed",
  orderId: string | null,
  paymentId: string | null,
): Promise<void> {
  await env.DB!.prepare(
    "UPDATE webhook_events SET status = ?, processed_at = ?, order_id = ?, payment_id = ? WHERE id = ?",
  )
    .bind(status, Date.now(), orderId, paymentId, eventId)
    .run();
}

async function findOrder(env: OrdersEnv, data: PaymentData): Promise<MatchedOrder | null> {
  const db = env.DB!;
  const metadataOrder = data.metadata?.order_id;
  if (typeof metadataOrder === "string" && metadataOrder.startsWith("ord_")) {
    const row = await db
      .prepare("SELECT id, account_id, amount_usd FROM orders WHERE id = ?")
      .bind(metadataOrder)
      .first<MatchedOrder>();
    if (row) return row;
  }
  const sessionId =
    typeof data.checkout_session_id === "string"
      ? data.checkout_session_id
      : typeof data.session_id === "string"
        ? data.session_id
        : "";
  if (sessionId) {
    const row = await db
      .prepare("SELECT id, account_id, amount_usd FROM orders WHERE checkout_session_id = ?")
      .bind(sessionId)
      .first<MatchedOrder>();
    if (row) return row;
  }
  return null;
}

async function recordSubscription(
  env: OrdersEnv,
  subscriptionId: string,
  orderId: string,
  status: string,
  data: PaymentData,
  serverId: string | null,
  event: { id: string; at: number },
): Promise<void> {
  if (!subscriptionId) return;
  const db = env.DB!;
  const order = await db
    .prepare("SELECT account_id FROM orders WHERE id = ?")
    .bind(orderId)
    .first<{ account_id: string }>();
  if (!order) return;

  // 乱序保护：比已知事件更旧的一律丢弃；同一时刻只认同一个事件 id。
  const seen = await db
    .prepare("SELECT last_event_at, last_event_id FROM subscriptions WHERE id = ?")
    .bind(subscriptionId)
    .first<{ last_event_at: number; last_event_id: string | null }>();
  if (seen) {
    if (seen.last_event_at > event.at) return;
    if (seen.last_event_at === event.at && seen.last_event_id === event.id) return;
  }

  const end = periodEnd(data);
  const now = Date.now();
  const cancelAtEnd = data.cancel_at_period_end === true ? 1 : 0;
  await db
    .prepare(
      "INSERT INTO subscriptions (id, account_id, order_id, server_id, product_id, status, current_period_end, cancel_at_period_end, created_at, updated_at, last_event_at, last_event_id) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) " +
        "ON CONFLICT(id) DO UPDATE SET status = excluded.status, " +
        "current_period_end = COALESCE(excluded.current_period_end, subscriptions.current_period_end), " +
        "cancel_at_period_end = excluded.cancel_at_period_end, " +
        "server_id = COALESCE(excluded.server_id, subscriptions.server_id), " +
        "last_event_at = excluded.last_event_at, last_event_id = excluded.last_event_id, " +
        "updated_at = excluded.updated_at",
    )
    .bind(
      subscriptionId,
      order.account_id,
      orderId,
      serverId,
      typeof data.metadata?.plan === "string" ? data.metadata.plan : null,
      status,
      end,
      cancelAtEnd,
      now,
      now,
      event.at,
      event.id,
    )
    .run();

  await db
    .prepare("UPDATE orders SET subscription_id = ? WHERE id = ? AND subscription_id IS NULL")
    .bind(subscriptionId, orderId)
    .run();

  // 本期有效到什么时候，落在服务器行上；只增不减，避免迟到事件把有效期缩短。
  if (end !== null) {
    await db
      .prepare("UPDATE servers SET paid_until = MAX(COALESCE(paid_until, 0), ?) WHERE order_id = ?")
      .bind(end, orderId)
      .run();
  }
}

export async function handleDodoWebhook(
  request: Request,
  env: OrdersEnv,
  ctx?: ExecutionContext,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== "/v1/webhooks/dodo" || request.method !== "POST") return null;
  if (!env.DB || !env.DODO_WEBHOOK_SECRET) {
    return json({ ok: false, error: "not_configured" }, 503);
  }

  const raw = await request.text();
  const verified = await verifyDodoSignature(raw, request.headers, env.DODO_WEBHOOK_SECRET);
  if (!verified.ok) return json({ error: "invalid_signature" }, 401);

  const { eventId, sentAt, payload } = verified;
  const db = env.DB;
  const kind = typeof payload.type === "string" ? payload.type : "";
  const data = (payload.data ?? {}) as PaymentData;
  const paymentId = typeof data.id === "string" ? data.id : "";

  const existing = await db
    .prepare("SELECT status FROM webhook_events WHERE id = ?")
    .bind(eventId)
    .first<{ status: string }>();
  // 处理过的事件直接 200；上次处理到一半失败的允许重来（事件行还在 received/failed）。
  if (existing?.status === "processed") return json({ ok: true });
  if (!existing) {
    await db
      .prepare("INSERT INTO webhook_events (id, kind, received_at, status) VALUES (?, ?, ?, 'received')")
      .bind(eventId, kind || "ignored", Date.now())
      .run();
  }

  // 订阅生命周期事件只维护订阅状态与到期时间；建机仍然只由 payment.succeeded 触发。
  if (kind.startsWith("subscription.")) {
    const order = await findOrder(env, data);
    const status = SUBSCRIPTION_STATUS[kind];
    if (order && status) {
      const subscriptionId =
        typeof data.id === "string"
          ? data.id
          : typeof data.subscription_id === "string"
            ? data.subscription_id
            : "";
      await recordSubscription(env, subscriptionId, order.id, status, data, null, {
        id: eventId,
        at: sentAt,
      });
    } else if (!order) {
      console.warn(`[dodo-webhook] subscription_unmatched event=${eventId} kind=${kind}`);
    }
    await markEvent(env, eventId, "processed", order?.id ?? null, null);
    return json({ ok: true });
  }

  if (kind !== "payment.succeeded" && kind !== "payment.failed") {
    await markEvent(env, eventId, "processed", null, paymentId || null);
    return json({ ok: true });
  }

  try {
    const order = await findOrder(env, data);
    if (!order) {
      // 匹配不上不要 5xx：Dodo 会无限重投。留证据等人工重放（设计 §4.3）。
      const email = typeof data.customer?.email === "string" ? data.customer.email.toLowerCase() : "";
      await db
        .prepare(
          "INSERT OR IGNORE INTO unmatched_payments (payment_id, email_hash, amount_usd, currency, reason, payload_hash, received_at) " +
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(
          paymentId || eventId,
          email ? await sha256B64u(email) : null,
          amountUsd(data),
          typeof data.currency === "string" ? data.currency : "USD",
          data.metadata?.order_id ? "unknown_order" : "no_metadata",
          await sha256B64u(raw),
          Date.now(),
        )
        .run();
      await markEvent(env, eventId, "processed", null, paymentId || null);
      console.warn(`[dodo-webhook] unmatched event=${eventId} payment=${paymentId || "-"}`);
      return json({ ok: true });
    }

    const amount = amountUsd(data);
    if (paymentId) {
      await db
        .prepare(
          "INSERT OR IGNORE INTO payments (id, order_id, subscription_id, account_id, amount_usd, currency, status, period_end, raw_digest, received_at) " +
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(
          paymentId,
          order.id,
          typeof data.subscription_id === "string" ? data.subscription_id : null,
          order.account_id,
          amount,
          typeof data.currency === "string" ? data.currency : "USD",
          kind === "payment.succeeded" ? "succeeded" : "failed",
          periodEnd(data),
          await sha256B64u(raw),
          Date.now(),
        )
        .run();
    }
    if (amount > 0 && Math.abs(amount - order.amount_usd) >= 0.01) {
      // 钱已经收了，差额人工处理；不因为金额不符就不交付。
      console.warn(
        `[dodo-webhook] amount_mismatch order=${order.id} paid=${amount} expected=${order.amount_usd}`,
      );
    }

    if (kind === "payment.failed") {
      await db
        .prepare("UPDATE orders SET state = 'payment_failed' WHERE id = ? AND state = 'awaiting_payment'")
        .bind(order.id)
        .run();
      await markEvent(env, eventId, "processed", order.id, paymentId || null);
      return json({ ok: true });
    }

    // 已过期、已取消的订单也照常认：没有退款能力，收了钱必须交付。
    await db
      .prepare(
        "UPDATE orders SET state = 'paid', paid_at = COALESCE(paid_at, ?), paid_via = 'dodo' " +
          "WHERE id = ? AND state IN ('pending_payment', 'awaiting_payment', 'payment_failed', 'expired', 'cancelled')",
      )
      .bind(Date.now(), order.id)
      .run();

    // 建机失败不要 5xx：订单已经是 paid，由订单 / 服务器状态机与 Cron 兜底。
    const provisioned = await provisionPaidOrder(env, order.id, ctx?.waitUntil?.bind(ctx));
    // 首期付款同时带上订阅信息：记下本期到期时间，界面与门禁都看它。
    const subscriptionId = typeof data.subscription_id === "string" ? data.subscription_id : "";
    if (subscriptionId) {
      await recordSubscription(env, subscriptionId, order.id, "active", data, provisioned.serverId ?? null, {
        id: eventId,
        at: sentAt,
      });
    }
    await markEvent(env, eventId, "processed", order.id, paymentId || null);
    return json({ ok: true });
  } catch (error) {
    console.error(`[dodo-webhook] failed event=${eventId}: ${(error as Error).message}`);
    await markEvent(env, eventId, "failed", null, paymentId || null);
    return json({ error: "internal_error" }, 500);
  }
}
