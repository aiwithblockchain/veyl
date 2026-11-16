// 售价与支付配置：全部来自 wrangler 的 vars（非 secret），dev / prod 各一份。
// 售价必须与 Dodo 产品价逐一对齐；缺配置时视为不可售，不拿成本价兜底。

export interface PaymentConfigEnv {
  ENVIRONMENT?: string;
  /** 日价（USD 分/天）：{"s-1vcpu-1gb":30}。唯一真源，月价由它派生。 */
  PLAN_DAILY_PRICE_CENTS?: string;
  DODO_PRODUCT_IDS?: string;
  /** 充值面额 → Dodo 一次性产品 ID：{"1000":"pdt_…"}，键是美分。 */
  DODO_TOPUP_PRODUCT_IDS?: string;
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

/** 日价（USD 分/天）；没配置或不是正整数就返回 null，调用方必须当成「不可售」。 */
export function planDailyPriceCents(env: PaymentConfigEnv, plan: string): number | null {
  const raw = parseMap(env.PLAN_DAILY_PRICE_CENTS)[plan];
  if (raw === undefined) return null;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) return null;
  return value;
}

/** 月价只用于展示：日价 × 30 天。 */
export function monthlyUsdFromDaily(dailyCents: number): number {
  return (dailyCents * 30) / 100;
}

export function dodoProductId(env: PaymentConfigEnv, plan: string): string | null {
  const id = parseMap(env.DODO_PRODUCT_IDS)[plan];
  return id && id.startsWith("pdt_") ? id : null;
}

export function topupProductId(env: PaymentConfigEnv, cents: number): string | null {
  const id = parseMap(env.DODO_TOPUP_PRODUCT_IDS)[String(cents)];
  return id && id.startsWith("pdt_") ? id : null;
}

/** 可充值面额（美分），只返回配了产品 ID 的档位。 */
export function topupDenominations(env: PaymentConfigEnv): number[] {
  const map = parseMap(env.DODO_TOPUP_PRODUCT_IDS);
  return Object.keys(map)
    .map((key) => Number(key))
    .filter((cents) => Number.isInteger(cents) && cents > 0 && topupProductId(env, cents) !== null)
    .sort((a, b) => a - b);
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
