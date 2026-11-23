// 支付回调样本捕获（只在 dev 包）：把验签通过的真实报文脱敏后落进 `webhook_samples`，
// 再由 scripts/export-webhook-fixture.mjs 导出成 test/fixtures 的回归样本。
//
// 开关是**编译期**的 `__WEBHOOK_SAMPLE__`：生产包注入 "0"，这段代码连同表名都被
// 常量折叠删掉，运行时没有任何判断。捕获只是辅助手段：任何失败都吞掉并打一行 warn，
// 不能影响回调本身。
//
// 脱敏用 **allowlist**：只保留结构、id、金额、时间戳、type/status/currency，
// 其余字符串一律占位。denylist 永远会漏下一个新字段（billing_address、phone_number、
// payment_method.last4、checkout_url 里的活会话 id 都是这么漏的）。

const FAKE_EMAIL = "buyer@example.com";
const FAKE_URL = "https://checkout.example.com/sample";
const PLACEHOLDER = "***";

/** 固定占位值：保留 Stripe id 前缀形状，便于回归样本和真实结构对得上。 */
const ID_PLACEHOLDERS: Record<string, string> = {
  payment_intent: "pi_sample00000000000000",
  payment_method_id: "pm_sample00000000000000",
  topup_id: "top_sample00000000000000",
  client_reference_id: "top_sample00000000000000",
  account_id: "acct_sample000000000000",
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

/** 允许保留原值的标量键：与 Stripe Checkout 的业务状态和结构有关。 */
const KEEP_KEYS = new Set([
  "type",
  "status",
  "payment_status",
  "object",
  "mode",
  "terms_of_service",
  "currency",
  "quantity",
  "count",
  "livemode",
]);

/** 金额字段：保留数值类型，换成固定占位值（美分）。 */
const AMOUNT_KEYS = new Set([
  "amount",
  "amount_total",
  "amount_subtotal",
  "amount_discount",
  "amount_tax",
  "amount_shipping",
  "unit_amount",
]);

/** 时间字段：保留原始形态（ISO 字符串或 epoch），不参与 PII 判定。 */
const TIME_KEYS = new Set([
  "timestamp",
  "created",
  "created_at",
  "updated_at",
  "expires_at",
  "canceled_at",
]);

const URL_KEYS = new Set(["url", "checkout_url", "return_url", "cancel_url", "success_url"]);

function isIdKey(key: string): boolean {
  return key === "id" || key === "payment_intent" || key.endsWith("_id");
}

function idPlaceholder(key: string, parent: string): string {
  // Stripe 事件顶层 id 是 evt_，data.object（checkout session）的 id 是 cs_。
  if (key === "id" && parent === "") return "evt_sample0000000000000";
  if (key === "id" && parent === "object") return "cs_sample00000000000000";
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
    if (typeof value === "string") return idPlaceholder(key, parent);
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
 * 请求头也走 allowlist：只留 Stripe 验签需要的 `stripe-signature`，
 * 以及内容类型与 UA。IP、forwarded、自定义头一律不落库。
 */
const HEADER_ALLOWLIST = new Set(["stripe-signature", "content-type", "user-agent"]);

export function sanitizeWebhookHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of headers) {
    const name = key.toLowerCase();
    if (!HEADER_ALLOWLIST.has(name)) continue;
    out[name] = name === "stripe-signature" ? PLACEHOLDER : value;
  }
  return out;
}

export interface SampleEnv {
  DB?: D1Database;
}

/**
 * 把一次验签通过的回调存成脱敏样本。**只在注入 `__WEBHOOK_SAMPLE__ = "1"` 的包里存在**；
 * 失败只 warn，绝不把异常抛回回调处理。
 */
export async function captureWebhookSample(
  env: SampleEnv,
  input: { raw: string; headers: Headers; eventId: string; kind: string },
): Promise<void> {
  if (__WEBHOOK_SAMPLE__ !== "1" || !env.DB) return;
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
    console.warn(`[stripe-webhook] sample_capture_failed: ${(error as Error).message}`);
  }
}
