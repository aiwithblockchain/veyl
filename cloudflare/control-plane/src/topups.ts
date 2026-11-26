// 充值（设计 §4.3）：固定面额 → Stripe Checkout → webhook 入账。
// 余额是账本的结果，这里只负责把「要充多少」变成一笔待支付的 topup。

import { authenticate, isResponse, type MaybeAuthEnv } from "./auth";
import { randomId } from "./lib/crypto";
import { apiError, json } from "./lib/http";
import { paymentReturnUrl, readTopupDenominations, readTopupRange } from "./lib/config";
import { idempotencyKey, requestHashOf, withIdempotency, type StoredResponse } from "./lib/idempotency";
import { createCheckoutSession, stripeCheckoutProblem, type StripeEnv } from "./payments/stripe";
import { balanceCents } from "./wallet";

export interface TopupEnv extends MaybeAuthEnv, StripeEnv {}

export type TopupStart =
  | { ok: true; topupId: string; checkoutUrl: string; denominationCents: number }
  | {
      ok: false;
      reason:
        | "invalid_denomination"
        | "rate_limited"
        | "unavailable"
        | "no_return_url"
        | "no_api_key"
        | "no_webhook_secret"
        | "checkout_failed";
      status?: number;
      detail?: string;
    };

/** 开一笔充值：范围内的整美元金额 → Stripe Checkout 会话。只有这一条路径。 */
export async function startTopupSession(
  env: TopupEnv,
  input: { accountId: string; email: string; cents: number },
  minCents: number,
  maxCents: number,
  maxActive: number,
): Promise<TopupStart> {
  const db = env.DB;
  if (!db) return { ok: false, reason: "unavailable" };
  if (
    !Number.isInteger(input.cents) ||
    input.cents % 100 !== 0 ||
    input.cents < minCents ||
    input.cents > maxCents
  ) {
    return { ok: false, reason: "invalid_denomination" };
  }

  // 缺 return URL 或 API Key 时根本建不出会话，也就不会有 webhook 先到的竞态——
  // 在落 pending 行之前失败，别留下永远等不到支付的单子。
  const returnUrl = paymentReturnUrl(env);
  if (!returnUrl) return { ok: false, reason: "no_return_url" };
  const problem = stripeCheckoutProblem(env);
  if (problem) {
    return {
      ok: false,
      reason: problem === "missing_webhook_secret" ? "no_webhook_secret" : "no_api_key",
    };
  }

  const topupId = randomId("top_");
  const now = Date.now();

  // 先落 pending 行再开收银台：webhook 可能比建会话的响应先到，先有行才匹配得上。
  // 计数与写入在同一条语句里，D1 串行执行，并发请求不会同时读到 4 再各插一笔。
  const inserted = await db
    .prepare(
      "INSERT INTO topups (id, account_id, denomination_cents, product_id, status, created_at) " +
        "SELECT ?, ?, ?, NULL, 'pending', ? " +
        "WHERE (SELECT COUNT(*) FROM topups " +
        "WHERE account_id = ? AND created_at >= ? AND status IN ('pending','paid')) < ?",
    )
    .bind(
      topupId,
      input.accountId,
      input.cents,
      now,
      input.accountId,
      now - 60 * 60 * 1000,
      maxActive,
    )
    .run();
  if (!inserted.meta.changes) return { ok: false, reason: "rate_limited" };

  const session = await createCheckoutSession(env, {
    cents: input.cents,
    email: input.email,
    returnUrl,
    metadata: { topup_id: topupId, account_id: input.accountId },
  });
  if (!session.ok) {
    await db
      .prepare("UPDATE topups SET status = 'failed' WHERE id = ? AND status = 'pending'")
      .bind(topupId)
      .run();
    return {
      ok: false,
      reason: session.reason === "not_configured" ? "no_api_key" : "checkout_failed",
      status: session.status,
      detail: session.detail,
    };
  }

  await db
    .prepare("UPDATE topups SET checkout_session_id = ?, checkout_url = ? WHERE id = ?")
    .bind(session.sessionId, session.checkoutUrl, topupId)
    .run();

  console.log(`[topup] session account=${input.accountId} cents=${input.cents} session=${session.sessionId}`);
  return { ok: true, topupId, checkoutUrl: session.checkoutUrl, denominationCents: input.cents };
}

export async function handleTopups(request: Request, env: TopupEnv): Promise<Response | null> {
  const url = new URL(request.url);
  const isWallet = url.pathname === "/v1/wallet";
  const isTopup = url.pathname === "/v1/topups";
  if (!isWallet && !isTopup) return null;
  if (isWallet && request.method !== "GET") return apiError("PRECONDITION_FAILED", "方法不允许", { status: 405 });
  if (isTopup && request.method !== "POST") return apiError("PRECONDITION_FAILED", "方法不允许", { status: 405 });
  if (!env.DB) return apiError("INTERNAL", "服务还没准备好", { retryable: true, status: 503 });
  const db = env.DB;

  const range = readTopupRange(env);
  if (range.problem) {
    return apiError("INTERNAL", "充值暂未开放", {
      retryable: false,
      status: 503,
      reason: "topup_config_unavailable",
    });
  }
  // 快捷档只用于 wallet 展示；配置坏了不阻断自定义充值。
  const config = readTopupDenominations(env);
  const denominations = config.cents.filter(
    (cents) => cents % 100 === 0 && cents >= range.minCents && cents <= range.maxCents,
  );
  if (denominations.length !== config.cents.length) {
    console.warn(
      `[topup] 快捷档过滤 count=${config.cents.length - denominations.length} min=${range.minCents} max=${range.maxCents}`,
    );
  }

  const identity = await authenticate(request, env);
  if (isResponse(identity)) return identity;

  if (isWallet) {
    return json({
      balance_cents: await balanceCents(env, identity.accountId),
      currency: "USD",
      denominations_cents: denominations,
      min_topup_cents: range.minCents,
      max_topup_cents: range.maxCents,
    });
  }

  if (identity.kind !== "email") {
    return apiError("UNAUTHENTICATED", "登录后才能充值", { retryable: true, reason: "auth_required" });
  }

  const invalidAmount = () =>
    apiError("PRECONDITION_FAILED", "充值金额无效", {
      reason: "invalid_denomination",
      details: {
        min_cents: range.minCents,
        max_cents: range.maxCents,
        whole_dollars: true,
      },
    });
  const invalidAmountStored = async (): Promise<StoredResponse> => {
    const response = invalidAmount();
    return { status: response.status, body: await response.json() };
  };

  let parsed: unknown;
  try {
    parsed = await request.json();
  } catch {
    return invalidAmount();
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return invalidAmount();
  }
  const raw = (parsed as { denomination_cents?: unknown }).denomination_cents;
  if (
    typeof raw !== "number" ||
    !Number.isInteger(raw) ||
    raw % 100 !== 0 ||
    raw < range.minCents ||
    raw > range.maxCents
  ) {
    return invalidAmount();
  }
  const cents = raw;

  const account = await env.DB.prepare("SELECT email FROM accounts WHERE id = ?")
    .bind(identity.accountId)
    .first<{ email: string | null }>();
  if (!account?.email) {
    return apiError("UNAUTHENTICATED", "登录后才能充值", { retryable: true, reason: "auth_required" });
  }

  // 连点、重试都只应该产生一个充值单：有幂等键就按 key 回放。
  const create = async (): Promise<StoredResponse> => {
    const started = await startTopupSession(
      env,
      {
        accountId: identity.accountId,
        email: account.email as string,
        cents,
      },
      range.minCents,
      range.maxCents,
      5,
    );
    if (!started.ok && started.reason === "rate_limited") {
      const response = apiError("RATE_LIMITED", "充值太频繁，稍后再试", {
        status: 429,
        retryable: true,
        reason: "topup_rate_limited",
      });
      return { status: response.status, body: await response.json() };
    }
    if (!started.ok) {
      if (started.reason === "invalid_denomination") return invalidAmountStored();
      return {
        status: 502,
        body: {
          code: "UPSTREAM_ERROR",
          message: "充值暂时不可用",
          retryable: true,
          details: { reason: "checkout_unavailable" },
        },
      };
    }
    return {
      status: 200,
      body: {
        topup_id: started.topupId,
        denomination_cents: started.denominationCents,
        checkout_url: started.checkoutUrl,
      },
    };
  };

  const key = idempotencyKey(request);
  if (!key) {
    const stored = await create();
    return json(stored.body, stored.status);
  }
  return withIdempotency(db, identity.accountId, "topups.create", key, await requestHashOf({ cents }), create);
}
