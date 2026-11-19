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
  active: "已开通",
  error: "出错了",
  destroying: "正在销毁",
  destroyed: "已停机删除",
  gone: "已失效",
};

/** 停机删除：到期前扣费失败，后端停机销毁，只留一行墓碑等用户自己删。 */
export const MY_SERVER_TOMBSTONE_WORD = "已停机删除";

/** 墓碑详情页只写这一句，不提供续费 / 重建 / 恢复。 */
export const MY_SERVER_TOMBSTONE_TEXT =
  "这台机器因余额不足已停机销毁，节点不能再连接。删除后不再显示。";

/** 连接页上悬挂节点那一行的词，比左栏短。 */
export const NODE_TOMBSTONE_WORD = "停机删除";

/** 完成态的四个步骤词：进度块就绪后全部打勾，用完成式，不沿用进行中的状态词。 */
export const MY_SERVER_STEP_DONE_LABEL: Record<
  "creating" | "booting" | "installing" | "verifying",
  string
> = {
  creating: "已建机器",
  booting: "已开机",
  installing: "已安装服务端",
  verifying: "已检查可用",
};

/** 左栏状态词：短一些，带百分比时一行放得下。 */
export const MY_SERVER_RAIL_PHASE: Partial<Record<MyServerState, string>> = {
  creating: "建机器中",
  booting: "开机中",
  installing: "安装中",
  verifying: "检查中",
};

/** 欠费词只在这里出现一次：左栏与详情页同源，避免同一台机器两个说法。 */
function billingStateWord(
  billing: MyServer["billing_state"],
): "已欠费" | "已停用" | null {
  if (billing === "past_due") return "已欠费";
  if (billing === "expired") return "已停用";
  return null;
}

/**
 * 左栏状态词：短词，一行放得下；停机删除压过欠费词（机器已经没了，不再说欠费）。
 * 进行中的机器 billing_state 是 pending，不会命中这两档。
 */
export function serverRailState(
  server: Pick<MyServer, "state" | "billing_state">,
): string {
  if (server.state === "destroyed") return MY_SERVER_TOMBSTONE_WORD;
  return (
    billingStateWord(server.billing_state) ??
    MY_SERVER_RAIL_PHASE[server.state] ??
    MY_SERVER_STATE_LABEL[server.state]
  );
}

/** 详情页标题词：用长词；停机删除与欠费覆盖同源。 */
export function serverDetailState(
  server: Pick<MyServer, "state" | "billing_state">,
): string {
  if (server.state === "destroyed") return MY_SERVER_TOMBSTONE_WORD;
  return (
    billingStateWord(server.billing_state) ??
    MY_SERVER_STATE_LABEL[server.state]
  );
}

export function isProvisioning(state: MyServerState): boolean {
  return (
    state === "creating" ||
    state === "booting" ||
    state === "installing" ||
    state === "verifying"
  );
}

/**
 * 节点已就绪：机器可用且已关联控制面节点。
 * 详情事实行、左栏「在手机上使用」与导出端点共用这一条判定——曾经就绪、
 * 后来健康检查失败的机器 node_id 还在，但节点不能再用。
 */
export function isServerNodeReady(server: MyServer): boolean {
  return (
    (server.state === "healthy" || server.state === "active") &&
    server.node_id !== null
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

export type TrialPhase =
  | { kind: "available" }
  | { kind: "counting"; days: number }
  | { kind: "ended" }
  | { kind: "unknown" };

/**
 * 试用状态归一：节点卡组标题与「我的服务器」空态共用这一份口径。
 * available 还没起算；ended 已过到期时刻；unknown 拿不到可用时间；只有 counting 能写倒计时。
 */
export function trialPhase(
  state: "available" | "active" | "expired" | null,
  expiresAt: string | null,
  now: number,
): TrialPhase {
  if (state === "expired") return { kind: "ended" };
  if (state === "available") return { kind: "available" };
  if (!expiresAt) return { kind: "unknown" };
  const ends = Date.parse(expiresAt);
  if (!Number.isFinite(ends)) return { kind: "unknown" };
  const remaining = ends - now;
  if (remaining <= 0) return { kind: "ended" };
  // 向下取整（少报安全）；不足 24 小时不写「今天」。
  return { kind: "counting", days: Math.floor(remaining / 86_400_000) };
}

export function formatTrialCountdown(days: number): string {
  return days < 1 ? "不到 1 天后到期" : `${days} 天后到期`;
}

/** 「我的服务器」空态那一行：available / counting 各一句，ended / unknown 不显示。 */
export function trialEmptyHint(
  state: "available" | "active" | "expired",
  seedNodeCount: number,
  expiresAt: string | null,
  now: number,
): string | null {
  if (seedNodeCount <= 0) return null;
  const phase = trialPhase(state, expiresAt, now);
  if (phase.kind === "available") {
    return `还有 ${seedNodeCount} 个免费节点，试用 7 天。`;
  }
  if (phase.kind !== "counting") return null;
  return `还有 ${seedNodeCount} 个免费节点，${formatTrialCountdown(phase.days)}。`;
}

/** 节点卡免费组标题右侧：拿不到时间写「试用中」，过期写「已到期」。 */
export function trialGroupHint(
  state: "available" | "active" | "expired" | null,
  expiresAt: string | null,
  now: number,
): string {
  const phase = trialPhase(state, expiresAt, now);
  if (phase.kind === "counting") return formatTrialCountdown(phase.days);
  return phase.kind === "ended" ? "已到期" : "试用中";
}

/**
 * 「我的服务器」左栏常驻提示：有自建服务器时也提醒还有免费节点可用。
 * 空态里的那句另有措辞（trialEmptyHint），两处只为各自位置服务。
 */
export function trialAvailableHint(
  state: "available" | "active" | "expired",
  seedNodeCount: number,
  expiresAt: string | null,
  now: number,
): string | null {
  if (seedNodeCount <= 0) return null;
  const phase = trialPhase(state, expiresAt, now);
  if (phase.kind === "available") {
    return `还有 ${seedNodeCount} 个免费节点可用，试用 7 天。`;
  }
  if (phase.kind !== "counting") return null;
  return `还有 ${seedNodeCount} 个免费节点可用，${formatTrialCountdown(phase.days)}。`;
}

/** 时长文案：满 1 小时报「2 小时 0 分」，满 1 分钟报「1 分 20 秒」，否则只报秒。 */
export function formatDuration(totalSeconds: number): string {
  const total = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) return `${hours} 小时 ${minutes} 分`;
  return minutes > 0 ? `${minutes} 分 ${seconds} 秒` : `${seconds} 秒`;
}

/** 创建用时：ready_at − created_at。旧机器没有 ready_at 时返回 null。 */
export function formatBuildDuration(
  createdAt: string,
  readyAt: string | null,
): string | null {
  if (!readyAt) return null;
  const start = Date.parse(createdAt);
  const end = Date.parse(readyAt);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return formatDuration((end - start) / 1000);
}

/** 计费截止措辞的唯一出处；定稿后只改这里。 */
export const PAID_THROUGH_WORDING = "本期有效至";
/** 覆盖期刚结束、下一轮计费任务还没跑：机器照常可用，不能说「到期」。 */
export const PAID_EXPIRED_WORDING = "本期已过，服务正常";
/** 建机成功、还没开通扣费时的费用行文案。 */
export const PENDING_BILLING_WORDING = "创建中，开通后开始计费";

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
  if (server.billing_state === "pending") return PENDING_BILLING_WORDING;
  const price = formatDailyPrice(server.daily_price_cents);
  if (!server.paid_until) return `每天 ${price}`;
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
      ? "余额不足，最近一次扣费没成功。7 天内充值可继续使用。"
      : `余额不足，最近一次扣费没成功。宽限还剩 ${days} 天，7 天内充值可继续使用。`;
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

/**
 * 状态点颜色（看整台机器）：欠费 / 停用是 warn，其余沿用 stateTone。
 * 欠费存在 billing_state 里，只看 state 会把 past_due 的机器画成绿点。
 */
export function serverTone(
  server: Pick<MyServer, "state" | "billing_state">,
): "ok" | "err" | "idle" | "warn" {
  if (server.state === "destroyed") return "warn";
  if (server.billing_state === "past_due" || server.billing_state === "expired") {
    return "warn";
  }
  return stateTone(server.state);
}
