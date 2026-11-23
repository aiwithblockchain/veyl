// Stripe 支付回调（设计 §4）：验签 → 事件去重 → 充值单匹配 → 入账。
// 只有这里能把充值单推进到 paid；客户端轮询不触发入账。
//
// 卡：completed 时 payment_status=paid；支付宝 / 微信：completed 可能先到且为 unpaid，
// 真正到账在 async_payment_succeeded。所以 completed 不能无条件入账。

import { sha256B64u } from "../lib/crypto";
import { json } from "../lib/http";
import { captureWebhookSample } from "../lib/webhook_sample";
import { recoverExpiredServers } from "../billing";
import { verifyStripeSignature } from "../payments/stripe";
import { recordLedgerEntry } from "../wallet";

export interface StripeWebhookEnv {
  DB?: D1Database;
  STRIPE_WEBHOOK_SECRET?: string;
  ENVIRONMENT?: string;
}

/** 256 KiB：优先看 Content-Length；没有时读后按 raw.length 兜底。正常 Stripe 事件远小于此。 */
const MAX_BODY_BYTES = 256 * 1024;

interface CheckoutSession {
  id?: unknown;
  payment_status?: unknown;
  payment_intent?: unknown;
  client_reference_id?: unknown;
  customer_email?: unknown;
  customer_details?: { email?: unknown } | null;
  metadata?: Record<string, unknown> | null;
  amount_total?: unknown;
  currency?: unknown;
}

interface TopupRow {
  id: string;
  account_id: string;
  denomination_cents: number;
}

async function markEvent(
  env: StripeWebhookEnv,
  eventId: string,
  status: "processed" | "failed",
  paymentId: string | null,
): Promise<void> {
  await env.DB!.prepare(
    "UPDATE webhook_events SET status = ?, processed_at = ?, order_id = ?, payment_id = ? WHERE id = ?",
  )
    .bind(status, Date.now(), null, paymentId, eventId)
    .run();
}

function sessionId(session: CheckoutSession): string {
  return typeof session.id === "string" ? session.id : "";
}

/** `payment_intent` 可能是字符串，也可能是展开的对象。 */
function paymentIntentId(session: CheckoutSession): string {
  const raw = session.payment_intent;
  if (typeof raw === "string") return raw;
  if (raw && typeof raw === "object") {
    const id = (raw as { id?: unknown }).id;
    if (typeof id === "string") return id;
  }
  return "";
}

/** 事件/支付流水的稳定引用：优先 payment_intent，其次 session id。 */
function paymentRef(session: CheckoutSession): string {
  return paymentIntentId(session) || sessionId(session);
}

/** 留证行必须有主键：前两层都没有时退回事件 id。 */
function paymentRefOrEvent(session: CheckoutSession, eventId: string): string {
  return paymentRef(session) || eventId;
}

function emailOf(session: CheckoutSession): string {
  const details = session.customer_details;
  if (details && typeof details.email === "string") return details.email;
  return typeof session.customer_email === "string" ? session.customer_email : "";
}

function currencyOf(session: CheckoutSession): string {
  return typeof session.currency === "string" && session.currency
    ? session.currency.toUpperCase()
    : "USD";
}

function hasTopupRef(session: CheckoutSession): boolean {
  return [session.metadata?.topup_id, session.client_reference_id].some(
    (value) => typeof value === "string" && value.length > 0,
  );
}

function unmatchedReason(session: CheckoutSession): string {
  return hasTopupRef(session) ? "unknown_topup" : "no_metadata";
}

/** 三层匹配：metadata.topup_id → client_reference_id → checkout_session_id。 */
async function findTopup(
  env: StripeWebhookEnv,
  session: CheckoutSession,
): Promise<TopupRow | null> {
  const db = env.DB!;
  const candidates = new Set<string>();
  for (const value of [session.metadata?.topup_id, session.client_reference_id]) {
    if (typeof value === "string" && value.length > 0) candidates.add(value);
  }
  for (const candidate of candidates) {
    const row = await db
      .prepare("SELECT id, account_id, denomination_cents FROM topups WHERE id = ?")
      .bind(candidate)
      .first<TopupRow>();
    if (row) return row;
  }
  const id = sessionId(session);
  if (id) {
    const row = await db
      .prepare(
        "SELECT id, account_id, denomination_cents FROM topups WHERE checkout_session_id = ?",
      )
      .bind(id)
      .first<TopupRow>();
    if (row) return row;
  }
  return null;
}

async function recordUnmatched(
  env: StripeWebhookEnv,
  session: CheckoutSession,
  eventId: string,
  reason: string,
  rawDigest: string,
): Promise<void> {
  const paymentId = paymentRefOrEvent(session, eventId);
  const email = emailOf(session);
  const amountTotal = Number(session.amount_total);
  const amountUsd = Number.isFinite(amountTotal) && amountTotal > 0 ? amountTotal / 100 : 0;
  await env.DB!.prepare(
    "INSERT OR IGNORE INTO unmatched_payments (payment_id, email_hash, amount_usd, currency, reason, payload_hash, received_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(
      paymentId,
      email ? await sha256B64u(email.toLowerCase()) : null,
      amountUsd,
      currencyOf(session),
      reason,
      rawDigest,
      Date.now(),
    )
    .run();
  console.warn(`[stripe-webhook] unmatched event=${eventId} payment=${paymentId} reason=${reason}`);
}

/**
 * 入账：金额只取本地 `topups.denomination_cents`，不看 `amount_total`。
 * 账本幂等键用本地 `topup.id`；`payments.id` 用 payment_intent / session id。
 * `payments` 绑满 10 个占位符（order / subscription / period_end 为 NULL），
 * 让真实 D1 与测试替身的列映射一致。
 */
async function creditTopup(
  env: StripeWebhookEnv,
  session: CheckoutSession,
  eventId: string,
  rawDigest: string,
  topup: TopupRow,
  ctx?: ExecutionContext,
): Promise<Response> {
  const db = env.DB!;
  const eventPaymentId = paymentRef(session) || null;

  const credited = await recordLedgerEntry(env, {
    accountId: topup.account_id,
    kind: "topup",
    amountCents: topup.denomination_cents,
    refType: "stripe_payment",
    refId: topup.id,
  });
  // duplicate = 这笔充值已经入过账（重投 / 另一个事件先到），同样把 topup 标成 paid。
  if (credited.ok || credited.reason === "duplicate") {
    await db.prepare(
      "INSERT OR IGNORE INTO payments (id, order_id, subscription_id, account_id, amount_usd, currency, status, period_end, raw_digest, received_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
      .bind(
        paymentRefOrEvent(session, eventId),
        null,
        null,
        topup.account_id,
        topup.denomination_cents / 100,
        currencyOf(session),
        "succeeded",
        null,
        rawDigest,
        Date.now(),
      )
      .run();
    await db
      .prepare("UPDATE topups SET status = 'paid', paid_at = ? WHERE id = ? AND status != 'paid'")
      .bind(Date.now(), topup.id)
      .run();
    await markEvent(env, eventId, "processed", eventPaymentId);

    // 充值成功后尝试恢复停机中的机器（expired 只由充值拉回）。恢复失败只记日志，
    // 不能把一个已经入账的事件变成 500；测试没有 ctx 时直接 await。
    const recovery = Promise.resolve()
      .then(() => recoverExpiredServers(env, topup.account_id))
      .catch((error) => {
        console.error(
          `[stripe-webhook] recover_failed account=${topup.account_id}: ${(error as Error).message}`,
        );
      });
    if (ctx) ctx.waitUntil(recovery);
    else await recovery;
    return json({ ok: true });
  }
  if (credited.reason === "missing_account") {
    // 账户被删 / 不存在：只留证据等人工补账，不写 payments（避免幻影 succeeded），
    // 也不要 5xx 让 Stripe 重投。
    await recordUnmatched(env, session, eventId, "missing_account", rawDigest);
    await markEvent(env, eventId, "processed", eventPaymentId);
    return json({ ok: true });
  }
  console.error(`[stripe-webhook] topup_credit_failed topup=${topup.id} reason=${credited.reason}`);
  await markEvent(env, eventId, "failed", eventPaymentId);
  return json({ error: "credit_failed" }, 500);
}

async function settlePaid(
  env: StripeWebhookEnv,
  session: CheckoutSession,
  eventId: string,
  rawDigest: string,
  ctx?: ExecutionContext,
): Promise<Response> {
  const topup = await findTopup(env, session);
  if (!topup) {
    await recordUnmatched(env, session, eventId, unmatchedReason(session), rawDigest);
    await markEvent(env, eventId, "processed", paymentRef(session) || null);
    return json({ ok: true });
  }

  // 入账只认 USD 与本地白名单金额；币种/金额对不上时不加钱，留证等人工。
  const currency = typeof session.currency === "string" ? session.currency.toLowerCase() : "";
  if (currency !== "usd") {
    console.warn(`[stripe-webhook] currency_mismatch event=${eventId} currency=${currency || "-"}`);
    await recordUnmatched(env, session, eventId, "currency_mismatch", rawDigest);
    await markEvent(env, eventId, "processed", paymentRef(session) || null);
    return json({ ok: true });
  }
  const amountTotal = Number(session.amount_total);
  if (Number.isFinite(amountTotal) && amountTotal !== topup.denomination_cents) {
    console.warn(
      `[stripe-webhook] amount_mismatch event=${eventId} expected=${topup.denomination_cents} actual=${amountTotal}`,
    );
    await recordUnmatched(env, session, eventId, "amount_mismatch", rawDigest);
    await markEvent(env, eventId, "processed", paymentRef(session) || null);
    return json({ ok: true });
  }

  return creditTopup(env, session, eventId, rawDigest, topup, ctx);
}

/** async_payment_failed / checkout.session.expired：pending 的充值单标 failed。 */
async function failPendingTopup(
  env: StripeWebhookEnv,
  session: CheckoutSession,
  eventId: string,
  rawDigest: string,
): Promise<Response> {
  const topup = await findTopup(env, session);
  if (topup) {
    await env.DB!.prepare("UPDATE topups SET status = 'failed' WHERE id = ? AND status = 'pending'")
      .bind(topup.id)
      .run();
  } else {
    await recordUnmatched(env, session, eventId, unmatchedReason(session), rawDigest);
  }
  await markEvent(env, eventId, "processed", paymentRef(session) || null);
  return json({ ok: true });
}

export async function handleStripeWebhook(
  request: Request,
  env: StripeWebhookEnv,
  ctx?: ExecutionContext,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== "/v1/webhooks/stripe" || request.method !== "POST") return null;
  if (!env.DB || !env.STRIPE_WEBHOOK_SECRET) {
    return json({ ok: false, error: "not_configured" }, 503);
  }

  // 先看声明长度，避免把超大 body 读进内存；没有 header 时读后再按 raw.length 兜底。
  const declared = request.headers.get("content-length");
  if (declared) {
    const size = Number(declared);
    if (Number.isFinite(size) && size > MAX_BODY_BYTES) {
      return json({ error: "payload_too_large" }, 413);
    }
  }
  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) return json({ error: "payload_too_large" }, 413);

  const verified = await verifyStripeSignature(
    raw,
    request.headers.get("stripe-signature"),
    env.STRIPE_WEBHOOK_SECRET,
  );
  if (!verified.ok) {
    console.warn(`[stripe-webhook] signature_invalid reason=${verified.reason}`);
    return json({ error: "invalid_signature", details: { reason: verified.reason } }, 401);
  }

  const payload = verified.payload;
  const eventId = typeof payload.id === "string" ? payload.id : "";
  const kind = typeof payload.type === "string" ? payload.type : "";
  const data = payload.data?.object;
  if (!eventId || !kind || !data || typeof data !== "object") {
    return json({ error: "invalid_payload" }, 400);
  }

  // test / live 事件不能串环境；不匹配直接拒绝，只记一条 error。
  const expectedLive = env.ENVIRONMENT === "production";
  if (payload.livemode !== expectedLive) {
    console.error(
      `[stripe-webhook] livemode_mismatch environment=${env.ENVIRONMENT ?? "unknown"} livemode=${String(payload.livemode)}`,
    );
    return json({ error: "livemode_mismatch" }, 400);
  }
  const session = data as CheckoutSession;

  try {
    const db = env.DB;
    // 原子去重：重复 id 静默忽略；处理过的事件直接 200，失败/半途的允许重来。
    await db
      .prepare("INSERT OR IGNORE INTO webhook_events (id, kind, received_at, status) VALUES (?, ?, ?, 'received')")
      .bind(eventId, kind, Date.now())
      .run();
    const existing = await db
      .prepare("SELECT status FROM webhook_events WHERE id = ?")
      .bind(eventId)
      .first<{ status: string }>();
    if (existing?.status === "processed") return json({ ok: true });

    // dev 包才留样本；放在去重之后，重投不会重复覆盖。内部吞掉一切失败。
    await captureWebhookSample(env, { raw, headers: request.headers, eventId, kind });

    const rawDigest = await sha256B64u(raw);

    if (kind === "checkout.session.completed") {
      const paymentStatus = typeof session.payment_status === "string" ? session.payment_status : "";
      if (paymentStatus === "paid") return await settlePaid(env, session, eventId, rawDigest, ctx);
      // 支付宝 / 微信可能先到 completed(unpaid)；只记事件，不入账，等 async 事件。
      console.log(`[stripe-webhook] completed_unpaid event=${eventId}`);
      await markEvent(env, eventId, "processed", paymentRef(session) || null);
      return json({ ok: true });
    }

    if (kind === "checkout.session.async_payment_succeeded") {
      return await settlePaid(env, session, eventId, rawDigest, ctx);
    }

    if (kind === "checkout.session.async_payment_failed" || kind === "checkout.session.expired") {
      return await failPendingTopup(env, session, eventId, rawDigest);
    }

    // 其它事件：记成 processed（不是 ignored），返回 200。
    await markEvent(env, eventId, "processed", paymentRef(session) || null);
    return json({ ok: true });
  } catch (error) {
    console.error(`[stripe-webhook] failed event=${eventId}: ${(error as Error).message}`);
    try {
      await markEvent(env, eventId, "failed", paymentRef(session) || null);
    } catch (markError) {
      console.error(`[stripe-webhook] mark_failed_error event=${eventId}: ${(markError as Error).message}`);
    }
    return json({ error: "internal_error" }, 500);
  }
}
