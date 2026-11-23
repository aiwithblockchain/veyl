import type { MyServer, MyServerRegion, MyServerState } from "../agent/bridge";
import { t } from "../i18n";
import { zh } from "../i18n/zh";
import type { MessageKey } from "../i18n";

const CONTINENT_KEYS: Record<MyServerRegion["continent"], MessageKey> = {
  asia: "myservers.continent.asia",
  europe: "myservers.continent.europe",
  north_america: "myservers.continent.northAmerica",
  south_america: "myservers.continent.southAmerica",
  oceania: "myservers.continent.oceania",
  africa: "myservers.continent.africa",
};

/** 兼容旧调用点（只有 mock 测试用）；按界面语言取词请用 continentLabel()。 */
export const CONTINENT_LABELS: Record<MyServerRegion["continent"], string> = {
  asia: zh["myservers.continent.asia"],
  europe: zh["myservers.continent.europe"],
  north_america: zh["myservers.continent.northAmerica"],
  south_america: zh["myservers.continent.southAmerica"],
  oceania: zh["myservers.continent.oceania"],
  africa: zh["myservers.continent.africa"],
};

export function continentLabel(continent: MyServerRegion["continent"]): string {
  return t(CONTINENT_KEYS[continent]);
}

const STATE_KEYS: Record<MyServerState, MessageKey> = {
  creating: "myservers.state.creating",
  booting: "myservers.state.booting",
  installing: "myservers.state.installing",
  verifying: "myservers.state.verifying",
  healthy: "myservers.state.healthy",
  active: "myservers.state.active",
  error: "myservers.state.error",
  destroying: "myservers.state.destroying",
  destroyed: "myservers.state.destroyed",
  gone: "myservers.state.gone",
};

export function serverStateLabel(state: MyServerState): string {
  return t(STATE_KEYS[state]);
}

export function serverTombstoneWord(): string {
  return t("myservers.tombstone.word");
}

export function serverTombstoneText(): string {
  return t("myservers.tombstone.text");
}

export function nodeTombstoneWord(): string {
  return t("myservers.nodeTombstone");
}

const RAIL_PHASE_KEYS: Partial<Record<MyServerState, MessageKey>> = {
  creating: "myservers.rail.creating",
  booting: "myservers.rail.booting",
  installing: "myservers.rail.installing",
  verifying: "myservers.rail.verifying",
};

/** 欠费词只在这里出现一次：左栏与详情页同源，避免同一台机器两个说法。 */
function billingStateWord(
  billing: MyServer["billing_state"],
): MessageKey | null {
  if (billing === "past_due") return "myservers.billing.pastDue";
  if (billing === "expired") return "myservers.billing.expiredState";
  return null;
}

/**
 * 左栏状态词：短词，一行放得下；停机删除压过欠费词（机器已经没了，不再说欠费）。
 * 进行中的机器 billing_state 是 pending，不会命中这两档。
 */
export function serverRailState(
  server: Pick<MyServer, "state" | "billing_state">,
): string {
  if (server.state === "destroyed") return serverTombstoneWord();
  const billing = billingStateWord(server.billing_state);
  if (billing) return t(billing);
  const phase = RAIL_PHASE_KEYS[server.state];
  if (phase) return t(phase);
  return serverStateLabel(server.state);
}

/** 详情页标题词：用长词；停机删除与欠费覆盖同源。 */
export function serverDetailState(
  server: Pick<MyServer, "state" | "billing_state">,
): string {
  if (server.state === "destroyed") return serverTombstoneWord();
  const billing = billingStateWord(server.billing_state);
  if (billing) return t(billing);
  return serverStateLabel(server.state);
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
  if (days < 1) return t("myservers.trial.endsLessThanOne");
  return days === 1
    ? t("myservers.trial.endsInOne", { days })
    : t("myservers.trial.endsIn", { days });
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
    return t("myservers.trial.emptyAvailable", { count: seedNodeCount });
  }
  if (phase.kind !== "counting") return null;
  return t("myservers.trial.emptyCounting", {
    count: seedNodeCount,
    countdown: formatTrialCountdown(phase.days),
  });
}

/** 节点卡免费组标题右侧：拿不到时间写「试用中」，过期写「已到期」。 */
export function trialGroupHint(
  state: "available" | "active" | "expired" | null,
  expiresAt: string | null,
  now: number,
): string {
  const phase = trialPhase(state, expiresAt, now);
  if (phase.kind === "counting") return formatTrialCountdown(phase.days);
  return phase.kind === "ended"
    ? t("myservers.trial.ended")
    : t("myservers.trial.onTrial");
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
    return t("myservers.trial.availableHint", { count: seedNodeCount });
  }
  if (phase.kind !== "counting") return null;
  return t("myservers.trial.availableHintCounting", {
    count: seedNodeCount,
    countdown: formatTrialCountdown(phase.days),
  });
}

/** 时长文案：满 1 小时报「2 小时 0 分」，满 1 分钟报「1 分 20 秒」，否则只报秒。 */
export function formatDuration(totalSeconds: number): string {
  const total = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) return t("myservers.duration.hours", { hours, minutes });
  return minutes > 0
    ? t("myservers.duration.minutes", { minutes, seconds })
    : t("myservers.duration.seconds", { seconds });
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

/** 机器详情费用行：日价 + 计费状态的单一文案函数。 */
export function serverBillingText(
  server: Pick<MyServer, "daily_price_cents" | "paid_until" | "billing_state">,
  now = Date.now(),
): string {
  const price = formatDailyPrice(server.daily_price_cents);
  const ends = server.paid_until ? new Date(server.paid_until).getTime() : NaN;
  // active 但已过 paid_until：还在等当天 Cron 补扣，不当作已停用。
  if (
    server.billing_state === "active" &&
    !Number.isNaN(ends) &&
    ends <= now
  ) {
    return t("myservers.billing.dailyExpired", {
      price,
      word: t("myservers.paid.expired"),
    });
  }
  return t("myservers.billing.daily", { price });
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
      ? t("myservers.billing.pastDueNoGrace")
      : t("myservers.billing.pastDueGrace", { days });
  }
  if (server.billing_state === "expired") {
    return t("myservers.billing.expired");
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
