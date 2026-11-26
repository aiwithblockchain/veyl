// 售价与支付配置：全部来自 wrangler 的 vars（非 secret），dev / prod 各一份。
// 日价与充值面额都必须与代码里的唯一真源一致；缺配置时视为不可售，不拿成本价兜底。

export interface PaymentConfigEnv {
  ENVIRONMENT?: string;
  /** 日价（USD 分/天）：{"s-1vcpu-1gb":30}。唯一真源，月价由它派生。 */
  PLAN_DAILY_PRICE_CENTS?: string;
  /** UI 快捷充值档（美分）的 JSON 数组："[600,1000,2500,5000,10000]"。不是支付白名单。 */
  TOPUP_DENOMINATIONS_CENTS?: string;
  /** 自定义充值范围（美分）；两者都是必需配置。 */
  MIN_TOPUP_CENTS?: string;
  MAX_TOPUP_CENTS?: string;
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
}

/**
 * 读 UI 快捷充值档。只接受非空的正整数 JSON 数组；解析失败 / 为空返回空数组并记日志，
 * 不参与控制流——自定义金额只看 MIN_TOPUP_CENTS / MAX_TOPUP_CENTS。
 */
export function readTopupDenominations(env: PaymentConfigEnv): TopupDenominationConfig {
  const raw = env.TOPUP_DENOMINATIONS_CENTS?.trim();
  if (!raw) {
    console.warn("[topup] TOPUP_DENOMINATIONS_CENTS 未配置，快捷档为空");
    return { cents: [] };
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    console.error("[topup] TOPUP_DENOMINATIONS_CENTS 不是合法 JSON");
    return { cents: [] };
  }
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    !value.every((entry) => typeof entry === "number" && Number.isInteger(entry) && entry > 0)
  ) {
    console.error("[topup] TOPUP_DENOMINATIONS_CENTS 必须是非空正整数数组");
    return { cents: [] };
  }
  return { cents: [...new Set(value)].sort((a, b) => a - b) };
}

export interface TopupRangeConfig {
  minCents: number;
  maxCents: number;
  /** 缺失或非法；调用方据此返回「充值未就绪」。 */
  problem: "missing" | "invalid" | null;
}

/**
 * 读自定义充值范围。两者都是必需配置：正整数、MIN <= MAX、MIN >= 100。
 * 缺任何一个都 fail closed，不拿默认值兜底。
 */
export function readTopupRange(env: PaymentConfigEnv): TopupRangeConfig {
  const minRaw = env.MIN_TOPUP_CENTS?.trim();
  const maxRaw = env.MAX_TOPUP_CENTS?.trim();
  if (!minRaw || !maxRaw) {
    console.error("[topup] MIN_TOPUP_CENTS / MAX_TOPUP_CENTS 未配置");
    return { minCents: 0, maxCents: 0, problem: "missing" };
  }
  const minCents = Number(minRaw);
  const maxCents = Number(maxRaw);
  if (
    !Number.isInteger(minCents) ||
    !Number.isInteger(maxCents) ||
    minCents < 100 ||
    maxCents < minCents
  ) {
    console.error("[topup] 充值范围必须是正整数且 100 <= MIN <= MAX");
    return { minCents: 0, maxCents: 0, problem: "invalid" };
  }
  return { minCents, maxCents, problem: null };
}

export function paymentReturnUrl(env: PaymentConfigEnv): string | null {
  const url = env.APP_PAYMENT_RETURN_URL?.trim();
  return url && url.startsWith("https://") ? url : null;
}
