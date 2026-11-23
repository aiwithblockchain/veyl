// 售价与支付配置：全部来自 wrangler 的 vars（非 secret），dev / prod 各一份。
// 日价与充值面额都必须与代码里的唯一真源一致；缺配置时视为不可售，不拿成本价兜底。

export interface PaymentConfigEnv {
  ENVIRONMENT?: string;
  /** 日价（USD 分/天）：{"s-1vcpu-1gb":30}。唯一真源，月价由它派生。 */
  PLAN_DAILY_PRICE_CENTS?: string;
  /** 可充值面额（美分）的 JSON 数组："[1200,2400,3600,4800]"。唯一真源。 */
  TOPUP_DENOMINATIONS_CENTS?: string;
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

export interface TopupDenominationConfig {
  cents: number[];
  /** 未配置 / 配置非法；调用方据此返回「充值未就绪」，不要当成用户传错面额。 */
  problem: "missing" | "invalid" | null;
}

/**
 * 读充值面额白名单。只接受非空的正整数 JSON 数组；配置了但解析为空/含非数字
 * 都算 infrastructure 问题，打 error 让调用方 fail closed。
 */
export function readTopupDenominations(env: PaymentConfigEnv): TopupDenominationConfig {
  const raw = env.TOPUP_DENOMINATIONS_CENTS?.trim();
  if (!raw) return { cents: [], problem: "missing" };
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    console.error("[topup] TOPUP_DENOMINATIONS_CENTS 不是合法 JSON");
    return { cents: [], problem: "invalid" };
  }
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    !value.every((entry) => typeof entry === "number" && Number.isInteger(entry) && entry > 0)
  ) {
    console.error("[topup] TOPUP_DENOMINATIONS_CENTS 必须是非空正整数数组");
    return { cents: [], problem: "invalid" };
  }
  return { cents: [...new Set(value)].sort((a, b) => a - b), problem: null };
}

export function paymentReturnUrl(env: PaymentConfigEnv): string | null {
  const url = env.APP_PAYMENT_RETURN_URL?.trim();
  return url && url.startsWith("https://") ? url : null;
}
