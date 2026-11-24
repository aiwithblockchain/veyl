// Stripe Checkout：建收银台会话 + webhook 验签。
// 金额由控制面白名单决定，用 price_data 动态传，不在 Stripe 后台预建 Product / Price。

import type { PaymentConfigEnv } from "../lib/config";
import { toHex } from "../lib/crypto";

export interface StripeEnv extends PaymentConfigEnv {
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
}

const STRIPE_API = "https://api.stripe.com/v1/checkout/sessions";
/** 固定 API 版本；升级时单独改、单独测，不跟随账户默认版本漂移。 */
const STRIPE_VERSION = "2026-11-18.endive";
const PRODUCT_NAME = "Veyl SAAS服务额度";
const PRODUCT_DESCRIPTION = "Veyl 云服务器管理服务的预付额度，仅限本服务消费，不退不转让。";

export type CheckoutResult =
  | { ok: true; sessionId: string; checkoutUrl: string }
  | { ok: false; reason: "not_configured" | "upstream"; status?: number; detail?: string };

function withQuery(url: string, param: string): string {
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}${param}`;
}

function withSessionId(url: string): string {
  return withQuery(url, "session_id={CHECKOUT_SESSION_ID}");
}

/** Checkout 需要 secret key 与 webhook secret 同时存在；缺任一都 fail closed。 */
export function stripeCheckoutProblem(
  env: StripeEnv,
): "missing_key" | "key_mismatch" | "missing_webhook_secret" | null {
  if (!env.STRIPE_SECRET_KEY) return "missing_key";
  const expected = env.ENVIRONMENT === "production" ? "sk_live_" : "sk_test_";
  if (!env.STRIPE_SECRET_KEY.startsWith(expected)) {
    console.error(
      `[stripe] key_mode_mismatch environment=${env.ENVIRONMENT ?? "unknown"} expected=${expected}`,
    );
    return "key_mismatch";
  }
  if (!env.STRIPE_WEBHOOK_SECRET) {
    // 没有 webhook secret 就不能验签：用户会被扣款却永远不入账，必须提前拒绝。
    console.error("[stripe] webhook_secret_missing");
    return "missing_webhook_secret";
  }
  return null;
}

async function stripeErrorCode(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: { code?: unknown; type?: unknown } };
    const code = body?.error?.code ?? body?.error?.type;
    return typeof code === "string" && code ? code : `status_${response.status}`;
  } catch {
    return `status_${response.status}`;
  }
}

export async function createCheckoutSession(
  env: StripeEnv,
  input: {
    cents: number;
    email: string;
    returnUrl: string;
    metadata?: Record<string, string>;
  },
): Promise<CheckoutResult> {
  if (!Number.isInteger(input.cents) || input.cents <= 0 || stripeCheckoutProblem(env)) {
    return { ok: false, reason: "not_configured" };
  }
  if (!input.returnUrl.startsWith("https://")) {
    return { ok: false, reason: "upstream", detail: "invalid_return_url" };
  }
  const topupId = input.metadata?.topup_id ?? "";
  if (!topupId) return { ok: false, reason: "upstream", detail: "missing_topup_id" };

  const form = new URLSearchParams();
  form.set("mode", "payment");
  form.set("success_url", withSessionId(input.returnUrl));
  form.set("cancel_url", withQuery(input.returnUrl, "canceled=1"));
  form.set("customer_email", input.email);
  form.set("client_reference_id", topupId);
  form.set("metadata[topup_id]", topupId);
  if (input.metadata?.account_id) form.set("metadata[account_id]", input.metadata.account_id);
  form.set("line_items[0][quantity]", "1");
  form.set("line_items[0][price_data][currency]", "usd");
  form.set("line_items[0][price_data][unit_amount]", String(input.cents));
  form.set("line_items[0][price_data][product_data][name]", PRODUCT_NAME);
  form.set("line_items[0][price_data][product_data][description]", PRODUCT_DESCRIPTION);
  form.set("consent_collection[terms_of_service]", "required");

  let response: Response;
  try {
    response = await fetch(STRIPE_API, {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
        "content-type": "application/x-www-form-urlencoded",
        "stripe-version": STRIPE_VERSION,
        // 同一次充值重试只应该建出一个 Checkout Session。
        "idempotency-key": topupId,
      },
      body: form.toString(),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    console.warn(`[stripe] checkout_request_failed ${detail}`);
    return { ok: false, reason: "upstream", detail };
  }

  if (!response.ok) {
    const code = await stripeErrorCode(response);
    // 只记状态与 Stripe 的稳定错误码；响应体可能回显邮箱等请求参数，不落日志。
    console.warn(`[stripe] checkout_failed status=${response.status} code=${code}`);
    return { ok: false, reason: "upstream", status: response.status, detail: code };
  }

  const body = (await response.json().catch(() => null)) as { id?: unknown; url?: unknown } | null;
  const sessionId = typeof body?.id === "string" ? body.id : "";
  const checkoutUrl = typeof body?.url === "string" ? body.url : "";
  if (!sessionId || !checkoutUrl.startsWith("https://")) {
    const keys = body && typeof body === "object" ? Object.keys(body).join(",") : "non_object";
    console.warn(`[stripe] checkout_unexpected_body keys=${keys}`);
    return { ok: false, reason: "upstream", detail: `unexpected_body:${keys}` };
  }
  return { ok: true, sessionId, checkoutUrl };
}

export interface StripeEventPayload {
  id?: unknown;
  type?: unknown;
  /** 事件属于 test 还是 live；必须与控制面的 ENVIRONMENT 一致。 */
  livemode?: unknown;
  data?: { object?: Record<string, unknown> };
}

export type StripeSignatureFailure =
  | "missing_header"
  | "stale_timestamp"
  | "no_v1"
  | "mismatch";

export type StripeSignatureResult =
  | { ok: true; payload: StripeEventPayload }
  | { ok: false; reason: StripeSignatureFailure };

const TIMESTAMP_TOLERANCE_SECONDS = 300;

/**
 * Stripe 验签：`Stripe-Signature: t=…,v1=…`，HMAC-SHA256 hex over `${t}.${rawBody}`。
 * 只认 `v1`；`v0`、`secret`、`destination`、`payload` 一律忽略。多个 `v1` 任一匹配即通过。
 * `whsec_…` 原样作为字符串密钥（与 Dodo 的 base64 解码不同）。
 */
export async function verifyStripeSignature(
  rawBody: string,
  header: string | null,
  secret: string,
  nowMs = Date.now(),
): Promise<StripeSignatureResult> {
  if (!header) return { ok: false, reason: "missing_header" };
  if (!secret) return { ok: false, reason: "mismatch" };

  let timestamp = "";
  const signatures: string[] = [];
  for (const part of header.split(",")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key === "t") timestamp = value;
    else if (key === "v1") signatures.push(value);
  }
  if (signatures.length === 0) return { ok: false, reason: "no_v1" };
  if (!timestamp) return { ok: false, reason: "stale_timestamp" };

  const sentAt = Number(timestamp);
  if (!Number.isFinite(sentAt)) return { ok: false, reason: "stale_timestamp" };
  if (Math.abs(nowMs / 1000 - sentAt) > TIMESTAMP_TOLERANCE_SECONDS) {
    return { ok: false, reason: "stale_timestamp" };
  }

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${timestamp}.${rawBody}`));
  const expected = toHex(new Uint8Array(mac));

  if (!signatures.some((signature) => constantTimeEqual(signature, expected))) {
    return { ok: false, reason: "mismatch" };
  }

  try {
    return { ok: true, payload: JSON.parse(rawBody) as StripeEventPayload };
  } catch {
    return { ok: false, reason: "mismatch" };
  }
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
