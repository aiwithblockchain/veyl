// Dodo Payments：建收银台会话 + webhook 验签（Standard Webhooks）。
// 参考实现：TweetPilot cloudflare/license-worker/src/routes/dodo-*.ts。

import { dodoApiBase, type PaymentConfigEnv } from "../lib/config";

export interface DodoEnv extends PaymentConfigEnv {
  DODO_API_KEY?: string;
  DODO_WEBHOOK_SECRET?: string;
}

export type CheckoutResult =
  | { ok: true; sessionId: string; checkoutUrl: string }
  | { ok: false; reason: "not_configured" | "upstream"; status?: number; detail?: string };

export async function createCheckoutSession(
  env: DodoEnv,
  input: {
    productId: string;
    email: string;
    returnUrl: string;
    metadata?: Record<string, string>;
  },
): Promise<CheckoutResult> {
  const productId = input.productId;
  if (!env.DODO_API_KEY || !productId) return { ok: false, reason: "not_configured" };

  let response: Response;
  const url = `${dodoApiBase(env)}/checkouts`;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.DODO_API_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        product_cart: [{ product_id: productId, quantity: 1 }],
        customer: { email: input.email },
        return_url: input.returnUrl,
        // 能否原样回传待核（设计 §9.1）；回不来就靠 checkout_session_id 匹配订单。
        metadata: input.metadata ?? {},
      }),
    });
  } catch (error) {
    const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    console.warn(`[dodo] checkout_request_failed ${detail}`);
    return { ok: false, reason: "upstream", detail };
  }

  if (!response.ok) {
    const text = (await response.text().catch(() => "")).slice(0, 300);
    console.warn(`[dodo] checkout_failed status=${response.status} body=${text}`);
    return { ok: false, reason: "upstream", status: response.status, detail: text };
  }

  const body = (await response.json().catch(() => null)) as
    | { id?: unknown; session_id?: unknown; checkout_url?: unknown }
    | null;
  // Dodo 实际返回 session_id；旧文档/参考实现里写的是 id，两个都认。
  const rawId = typeof body?.session_id === "string" ? body.session_id : body?.id;
  const sessionId = typeof rawId === "string" ? rawId : "";
  const checkoutUrl = typeof body?.checkout_url === "string" ? body.checkout_url : "";
  if (!sessionId || !checkoutUrl.startsWith("https://")) {
    const keys = body && typeof body === "object" ? Object.keys(body).join(",") : "non_object";
    console.warn(`[dodo] checkout_unexpected_body keys=${keys}`);
    return { ok: false, reason: "upstream", detail: `unexpected_body:${keys}` };
  }
  return { ok: true, sessionId, checkoutUrl };
}

export interface WebhookPayload {
  type?: string;
  data?: Record<string, unknown>;
}

export type SignatureResult =
  | { ok: true; eventId: string; sentAt: number; payload: WebhookPayload }
  | { ok: false };

const TIMESTAMP_TOLERANCE_SECONDS = 300;

function decodeSecret(secret: string): Uint8Array {
  if (secret.startsWith("whsec_")) {
    const raw = secret.slice(6).replace(/-/g, "+").replace(/_/g, "/");
    const pad = raw.length % 4 === 0 ? "" : "=".repeat(4 - (raw.length % 4));
    try {
      const binary = atob(raw + pad);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
      return bytes;
    } catch {
      // 非法 base64 视作原始字节，交给签名比较去失败。
    }
  }
  return new TextEncoder().encode(secret);
}

/** Standard Webhooks：HMAC-SHA256 over `${id}.${timestamp}.${body}`，结果 base64。 */
export async function verifyDodoSignature(
  rawBody: string,
  headers: Headers,
  secret: string,
  nowMs = Date.now(),
): Promise<SignatureResult> {
  const eventId = headers.get("webhook-id") ?? "";
  const signatureHeader = headers.get("webhook-signature") ?? "";
  const timestamp = headers.get("webhook-timestamp") ?? "";
  if (!eventId || !signatureHeader || !timestamp || !secret) return { ok: false };

  const sentAt = Number(timestamp);
  if (!Number.isFinite(sentAt)) return { ok: false };
  if (Math.abs(nowMs / 1000 - sentAt) > TIMESTAMP_TOLERANCE_SECONDS) return { ok: false };

  const key = await crypto.subtle.importKey(
    "raw",
    decodeSecret(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${eventId}.${timestamp}.${rawBody}`),
  );
  const digest = new Uint8Array(mac);
  let binary = "";
  for (const byte of digest) binary += String.fromCharCode(byte);
  const expected = `v1,${btoa(binary)}`;

  const matches = signatureHeader
    .split(" ")
    .filter((entry) => entry.startsWith("v1,"))
    .some((entry) => constantTimeEqual(entry, expected));
  if (!matches) return { ok: false };

  try {
    return { ok: true, eventId, sentAt: sentAt * 1000, payload: JSON.parse(rawBody) as WebhookPayload };
  } catch {
    return { ok: false };
  }
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
