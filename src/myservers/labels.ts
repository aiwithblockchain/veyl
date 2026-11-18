import type { MyServer, MyServerRegion, MyServerState } from "../agent/bridge";

export const CONTINENT_LABELS: Record<MyServerRegion["continent"], string> = {
  asia: "亚洲",
  europe: "欧洲",
  north_america: "北美洲",
  south_america: "南美洲",
  oceania: "大洋洲",
  africa: "非洲",
};

export const MY_SERVER_STATE_LABEL: Record<MyServerState, string> = {
  creating: "正在建机器",
  booting: "等待开机",
  installing: "安装服务端",
  verifying: "检查是否可用",
  healthy: "可用",
  active: "已在使用",
  error: "出错了",
  destroying: "正在销毁",
  destroyed: "已销毁",
  gone: "已失效",
};

export const MY_SERVER_PHASE_TEXT: Partial<Record<MyServerState, string>> = {
  creating: "正在建机器",
  booting: "正在开机",
  installing: "正在安装",
  verifying: "正在检查",
};

/** 左栏状态词：短一些，带百分比时一行放得下。 */
export const MY_SERVER_RAIL_PHASE: Partial<Record<MyServerState, string>> = {
  creating: "建机器中",
  booting: "开机中",
  installing: "安装中",
  verifying: "检查中",
};

export function serverRailState(state: MyServerState): string {
  const phase = MY_SERVER_RAIL_PHASE[state];
  return phase ? `${phase} ${serverProgress(state)}%` : MY_SERVER_STATE_LABEL[state];
}

const PHASE_PROGRESS: Record<string, number> = {
  creating: 15,
  booting: 40,
  installing: 65,
  verifying: 90,
};

export function serverProgress(state: MyServerState): number {
  return PHASE_PROGRESS[state] ?? 100;
}

export function isProvisioning(state: MyServerState): boolean {
  return (
    state === "creating" ||
    state === "booting" ||
    state === "installing" ||
    state === "verifying"
  );
}

/** 钱包金额：USD 分，固定两位小数。 */
export function formatUsdCents(cents: number): string {
  return `$${(Math.max(0, cents) / 100).toFixed(2)}`;
}

/** 日价：USD 分 → $0.20。 */
export function formatDailyPrice(cents: number): string {
  return formatUsdCents(cents);
}

/** 月估只用于展示：日价 × 30，不参与扣费。 */
export function formatMonthlyFromDaily(cents: number): string {
  const dollars = (Math.max(0, cents) * 30) / 100;
  return Number.isInteger(dollars) ? `$${dollars}` : `$${dollars.toFixed(2)}`;
}

/**
 * 试用剩余：「我的服务器」空态与节点卡组标题共用这一条口径。
 * 向下取整（少报安全）；不足 24 小时不写「今天」，写「不到 1 天后到期」；已过期返回 null。
 */
export function formatTrialExpiry(
  expiresAt: string | null,
  now: number,
): string | null {
  if (!expiresAt) return null;
  const ends = Date.parse(expiresAt);
  if (!Number.isFinite(ends)) return null;
  const remaining = ends - now;
  if (remaining <= 0) return null;
  if (remaining < 86_400_000) return "不到 1 天后到期";
  return `${Math.floor(remaining / 86_400_000)} 天后到期`;
}

/** 计费截止措辞的唯一出处；定稿后只改这里。 */
export const PAID_THROUGH_WORDING = "本期有效至";
export const PAID_EXPIRED_WORDING = "本期已到期，下一轮扣费顺延";

/** 计费日期：本地日期 YYYY-MM-DD。 */
export function formatPaidUntil(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
}

/** 机器详情费用行：日价 + 计费截止的单一文案函数。 */
export function serverBillingText(
  server: Pick<MyServer, "daily_price_cents" | "paid_until" | "billing_state">,
  now = Date.now(),
): string {
  const price = formatDailyPrice(server.daily_price_cents);
  const ends = new Date(server.paid_until).getTime();
  // active 但已过 paid_until：还在等当天 Cron 补扣，不当作已停用。
  if (
    server.billing_state === "active" &&
    !Number.isNaN(ends) &&
    ends <= now
  ) {
    return `每天 ${price} · ${PAID_EXPIRED_WORDING}`;
  }
  return `每天 ${price} · ${PAID_THROUGH_WORDING} ${formatPaidUntil(server.paid_until)}`;
}

/** 宽限剩余天数：向上取整，过期为 0。 */
export function graceDaysLeft(graceEndsAt: string | null, now = Date.now()): number | null {
  if (!graceEndsAt) return null;
  const ends = new Date(graceEndsAt).getTime();
  if (Number.isNaN(ends)) return null;
  return Math.max(0, Math.ceil((ends - now) / 86_400_000));
}

/** 欠费 / 停用提示：只有 past_due 给宽限剩余天数；expired 不再有宽限。 */
export function billingNoticeText(
  server: Pick<MyServer, "billing_state" | "grace_ends_at">,
  now = Date.now(),
): string | null {
  if (server.billing_state === "past_due") {
    const days = graceDaysLeft(server.grace_ends_at, now);
    return days === null
      ? "余额不足，今天这次没扣上。7 天内充值可继续使用。"
      : `余额不足，今天这次没扣上。宽限还剩 ${days} 天，7 天内充值可继续使用。`;
  }
  if (server.billing_state === "expired") {
    return "余额不足，服务已停用。服务器还在，停机期间不再产生费用；充值后自动补扣，最多补 30 天即可恢复。";
  }
  return null;
}

export function formatServerTime(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(
    at.getHours(),
  )}:${pad(at.getMinutes())}`;
}

/** 状态点颜色：正常是 ok，失败是 err，其余（进行中/已销毁）都是中性色。 */
export function stateTone(state: MyServerState): "ok" | "err" | "idle" {
  if (state === "healthy" || state === "active") return "ok";
  if (state === "error" || state === "gone") return "err";
  return "idle";
}
