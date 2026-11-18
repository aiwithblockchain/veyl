// Dodo 回调样本捕获（只在 dev）：把验签通过的真实报文脱敏后落进 `webhook_samples`，
// 再由 scripts/export-webhook-fixture.mjs 导出成 test/fixtures 的回归样本。
//
// 生产绝不捕获：入口先看 ENVIRONMENT，不是 dev 直接返回。
// 捕获只是辅助手段：任何失败都吞掉并打一行 warn，不能影响回调本身。
//
// 脱敏用 **allowlist**：只保留结构、id、金额、时间戳、type/status/currency，
// 其余字符串一律占位。denylist 永远会漏下一个新字段（billing_address、phone_number、
// payment_method.last4、checkout_url 里的活会话 id 都是这么漏的）。

const FAKE_EMAIL = "buyer@example.com";
const FAKE_URL = "https://checkout.example.com/sample";
const PLACEHOLDER = "***";

/** 固定占位值：保留 id 前缀形状，便于回归样本和真实结构对得上。 */
const ID_PLACEHOLDERS: Record<string, string> = {
  id: "pay_sample0000000000000",
  payment_id: "pay_sample0000000000000",
  payment_method_id: "pm_sample00000000000000",
  order_id: "ord_sample00000000000000",
  topup_id: "top_sample00000000000000",
  account_id: "acct_sample000000000000",
  subscription_id: "sub_sample0000000000000",
  customer_id: "cus_sample0000000000000",
  checkout_session_id: "cks_sample0000000000000",
  session_id: "cks_sample0000000000000",
  event_id: "evt_sample0000000000000",
};

/** 整棵子树替换：地址、姓名、电话这类字段不管值是什么类型都不能落库。 */
const PII_KEYS = new Set([
  "name",
  "full_name",
  "phone",
  "phone_number",
  "mobile",
  "address",
  "billing_address",
  "shipping_address",
  "line1",
  "line2",
  "city",
  "state",
  "zip",
  "zip_code",
  "postcode",
  "postal_code",
  "country",
  "company",
  "tax_id",
  "ip",
  "ip_address",
  "ipv4",
  "ipv6",
]);

/** 允许保留原值的标量键：与业务状态和结构有关，不含个人信息。 */
const KEEP_KEYS = new Set([
  "type",
  "status",
  "currency",
  "quantity",
  "count",
  "cancel_at_period_end",
  "active",
  "paid",
  "livemode",
  // 档位不是 PII，且 findOrder/recordSubscription 会把它落进 subscriptions.product_id。
  "plan",
]);

/** 金额字段：保留数值类型，换成固定占位值（美分/美元都有，测试只关心结构）。 */
const AMOUNT_KEYS = new Set([
  "amount",
  "settlement_amount",
  "total_amount",
  "subtotal",
  "tax",
  "discount",
  "price",
  "unit_price",
  "denomination_cents",
]);

/** 时间字段：保留原始形态（ISO 字符串或 epoch），不参与 PII 判定。 */
const TIME_KEYS = new Set([
  "timestamp",
  "next_billing_date",
  "current_period_end",
  "ends_at",
  "starts_at",
  "expires_at",
  "paid_at",
  "created_at",
  "updated_at",
  "received_at",
]);

const URL_KEYS = new Set(["url", "checkout_url", "return_url", "cancel_url", "success_url"]);

function isIdKey(key: string): boolean {
  return key === "id" || key.endsWith("_id");
}

function idPlaceholder(key: string): string {
  const known = ID_PLACEHOLDERS[key];
  if (known) return known;
  // 任意新 id 字段：保留键名形状，避免整段被误当成普通字符串。
  return `sample_${key}`;
}

function sanitizeScalar(key: string, value: unknown, parent: string): unknown {
  if (value === null || value === undefined) return value;
  // payment_method 是支付工具对象：叶子（last4 / brand / expiry / type）全部占位。
  if (parent === "payment_method") return PLACEHOLDER;
  if (key.includes("email") && typeof value === "string") return FAKE_EMAIL;
  if (isIdKey(key)) {
    if (typeof value === "string") return idPlaceholder(key);
    if (typeof value === "number") return 1;
    return PLACEHOLDER;
  }
  if (AMOUNT_KEYS.has(key) && typeof value === "number") return 1000;
  if (URL_KEYS.has(key) && typeof value === "string") return FAKE_URL;
  if (TIME_KEYS.has(key) || key.endsWith("_date") || key.endsWith("_at")) return value;
  if (KEEP_KEYS.has(key)) return value;
  if (typeof value === "boolean") return value;
  // 未知数值也可能是账号/用户标识（metadata.uid、zip_code 等）：统一归零，
  // 比逐个补键更彻底；金额与 id 已在上面的分支按类型占位。
  if (typeof value === "number") return 0;
  return PLACEHOLDER;
}

function sanitizeValue(key: string, value: unknown, parent = ""): unknown {
  // PII 判定必须在对象分支之前：billing_address 这类字段可能是对象，
  // 先递归就会把 line1 / postal_code 原样带出来。
  if (PII_KEYS.has(key)) return PLACEHOLDER;
  if (Array.isArray(value)) return value.map((item) => sanitizeValue(key, item, parent));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>)) {
      out[childKey] = sanitizeValue(childKey, childValue, key);
    }
    return out;
  }
  return sanitizeScalar(key, value, parent);
}

/** 深拷贝并按 allowlist 脱敏；JSON 形状保持原样，解析路径的测试才有意义。 */
export function sanitizeWebhookBody(payload: unknown): unknown {
  return sanitizeValue("", payload);
}

/**
 * 请求头也走 allowlist：只留 Standard Webhooks 需要的 id / 时间戳 / 签名，
 * 以及内容类型与 UA。IP、forwarded、自定义头一律不落库。
 */
const HEADER_ALLOWLIST = new Set([
  "webhook-id",
  "webhook-timestamp",
  "webhook-signature",
  "content-type",
  "user-agent",
]);

export function sanitizeWebhookHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of headers) {
    const name = key.toLowerCase();
    if (!HEADER_ALLOWLIST.has(name)) continue;
    out[name] = name === "webhook-signature" ? PLACEHOLDER : value;
  }
  return out;
}

export interface SampleEnv {
  DB?: D1Database;
  ENVIRONMENT?: string;
}

/**
 * 把一次验签通过的回调存成脱敏样本。**只在 dev 执行**；
 * 失败只 warn，绝不把异常抛回回调处理。
 */
export async function captureWebhookSample(
  env: SampleEnv,
  input: { raw: string; headers: Headers; eventId: string; kind: string },
): Promise<void> {
  if (env.ENVIRONMENT !== "dev" || !env.DB) return;
  try {
    const parsed = JSON.parse(input.raw) as unknown;
    const body = JSON.stringify(sanitizeWebhookBody(parsed), null, 2);
    const headers = JSON.stringify(sanitizeWebhookHeaders(input.headers), null, 2);
    await env.DB.prepare(
      "INSERT OR REPLACE INTO webhook_samples (id, kind, received_at, headers, body) VALUES (?, ?, ?, ?, ?)",
    )
      .bind(input.eventId, input.kind || "unknown", Date.now(), headers, body)
      .run();
  } catch (error) {
    console.warn(`[dodo-webhook] sample_capture_failed: ${(error as Error).message}`);
  }
}
