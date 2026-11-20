// 充值（设计 §4.3）：固定面额 → Dodo 一次性产品 → webhook 入账。
// 余额是账本的结果，这里只负责把「要充多少」变成一笔待支付的 topup。

import { authenticate, isResponse, type MaybeAuthEnv } from "./auth";
import { randomId } from "./lib/crypto";
import { apiError, json } from "./lib/http";
import { paymentReturnUrl, topupDenominations, topupProductId } from "./lib/config";
import { idempotencyKey, requestHashOf, withIdempotency, type StoredResponse } from "./lib/idempotency";
import { createCheckoutSession, type DodoEnv } from "./payments/dodo";
import { balanceCents } from "./wallet";

export interface TopupEnv extends MaybeAuthEnv, DodoEnv {}

export type TopupStart =
  | { ok: true; topupId: string; checkoutUrl: string; denominationCents: number }
  | {
      ok: false;
      reason:
        | "invalid_denomination"
        | "unavailable"
        | "no_return_url"
        | "no_api_key"
        | "checkout_failed";
      status?: number;
      detail?: string;
    };

/** 开一笔充值：固定面额 → Dodo 一次性产品 → 收银台会话。只有这一条路径。 */
export async function startTopupSession(
  env: TopupEnv,
  input: { accountId: string; email: string; cents: number },
): Promise<TopupStart> {
  const db = env.DB;
  if (!db) return { ok: false, reason: "unavailable" };
  const productId = topupProductId(env, input.cents);
  if (!productId) return { ok: false, reason: "invalid_denomination" };

  // 缺 return URL 或 API Key 时根本建不出会话，也就不会有 webhook 先到的竞态——
  // 在落 pending 行之前失败，别留下永远等不到支付的单子。
  const returnUrl = paymentReturnUrl(env);
  if (!returnUrl) return { ok: false, reason: "no_return_url" };
  if (!env.DODO_API_KEY) return { ok: false, reason: "no_api_key" };

  const topupId = randomId("top_");
  const now = Date.now();

  // 先落 pending 行再开收银台：webhook 可能比建会话的响应先到，先有行才匹配得上。
  await db
    .prepare(
      "INSERT INTO topups (id, account_id, denomination_cents, product_id, status, created_at) " +
        "VALUES (?, ?, ?, ?, 'pending', ?)",
    )
    .bind(topupId, input.accountId, input.cents, productId, now)
    .run();

  const session = await createCheckoutSession(env, {
    productId,
    email: input.email,
    returnUrl,
    metadata: { topup_id: topupId, account_id: input.accountId },
  });
  if (!session.ok) {
    await db.prepare("UPDATE topups SET status = 'failed' WHERE id = ?").bind(topupId).run();
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

  const identity = await authenticate(request, env);
  if (isResponse(identity)) return identity;

  const denominations = topupDenominations(env);
  if (isWallet) {
    return json({
      balance_cents: await balanceCents(env, identity.accountId),
      currency: "USD",
      denominations_cents: denominations,
    });
  }

  if (identity.kind !== "email") {
    return apiError("UNAUTHENTICATED", "登录后才能充值", { retryable: true, reason: "auth_required" });
  }

  let body: { denomination_cents?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return apiError("PRECONDITION_FAILED", "请求体不是合法 JSON", { reason: "invalid_denomination" });
  }
  const cents = Number(body.denomination_cents);
  if (!Number.isInteger(cents) || !topupProductId(env, cents)) {
    return apiError("PRECONDITION_FAILED", "没有这个充值面额", { reason: "invalid_denomination" });
  }

  const account = await env.DB.prepare("SELECT email FROM accounts WHERE id = ?")
    .bind(identity.accountId)
    .first<{ email: string | null }>();
  if (!account?.email) {
    return apiError("UNAUTHENTICATED", "登录后才能充值", { retryable: true, reason: "auth_required" });
  }

  // 连点、重试都只应该产生一个充值单：有幂等键就按 key 回放。
  const create = async (): Promise<StoredResponse> => {
    const started = await startTopupSession(env, {
      accountId: identity.accountId,
      email: account.email as string,
      cents,
    });
    if (!started.ok) {
      return {
        status: 502,
        body: {
          code: "UPSTREAM_ERROR",
          message: "充值暂时不可用",
          retryable: true,
          details: {
            reason:
              started.reason === "invalid_denomination" ? "invalid_denomination" : "checkout_unavailable",
          },
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
  return withIdempotency(env.DB, identity.accountId, "topups.create", key, await requestHashOf({ cents }), create);
}
