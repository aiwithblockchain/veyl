// 售价与支付配置：全部来自 wrangler 的 vars（非 secret），dev / prod 各一份。
// 售价必须与 Dodo 产品价逐一对齐；缺配置时视为不可售，不拿成本价兜底。

export interface PaymentConfigEnv {
  ENVIRONMENT?: string;
  PLAN_PRICES_USD?: string;
  DODO_PRODUCT_IDS?: string;
  APP_PAYMENT_RETURN_URL?: string;
}

function parseMap(raw: string | undefined): Record<string, string> {
  if (!raw || raw.trim() === "") return {};
  try {
    const value = JSON.parse(raw) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    const map: Record<string, string> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (typeof entry === "string" || typeof entry === "number") map[key] = String(entry);
    }
    return map;
  } catch {
    return {};
  }
}

/** 售价（USD）；没配置这个套餐就返回 null，调用方必须当成「不可售」。 */
export function planPriceUsd(env: PaymentConfigEnv, plan: string): number | null {
  const raw = parseMap(env.PLAN_PRICES_USD)[plan];
  if (raw === undefined) return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return null;
  return Math.round(value * 100) / 100;
}

/** 恰好两位小数的小时价，只用于展示。 */
export function planHourlyUsd(monthly: number): number {
  return Math.round((monthly / 730) * 10000) / 10000;
}

export function dodoProductId(env: PaymentConfigEnv, plan: string): string | null {
  const id = parseMap(env.DODO_PRODUCT_IDS)[plan];
  return id && id.startsWith("pdt_") ? id : null;
}

export function dodoApiBase(env: PaymentConfigEnv): string {
  return env.ENVIRONMENT === "production"
    ? "https://live.dodopayments.com"
    : "https://test.dodopayments.com";
}

export function paymentReturnUrl(env: PaymentConfigEnv): string | null {
  const url = env.APP_PAYMENT_RETURN_URL?.trim();
  return url && url.startsWith("https://") ? url : null;
}
