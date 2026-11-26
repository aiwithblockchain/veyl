import type { MyServer } from "../agent/bridge";
import type { Language } from "../i18n";

const GIB = 1024 ** 3;
/** 与控制面 `traffic_cycle.ts` 的 `RELEASE_DAYS` 一致。 */
const RELEASE_DAYS = 28;

/**
 * 数值部分（不带单位）：字节按 GiB 换算，≥100 取整、其余保留一位小数，
 * 有量但不足 0.1 GiB 写 `<0.1`；非有限值写「—」，不伪装成 0。
 */
export function formatTrafficGibValue(bytes: number): string {
  if (!Number.isFinite(bytes)) return "—";
  const gib = Math.max(0, bytes) / GIB;
  if (bytes > 0 && gib < 0.1) return "<0.1";
  const rounded = gib >= 100 ? Math.round(gib) : Math.round(gib * 10) / 10;
  return Number.isInteger(rounded) ? `${rounded}` : rounded.toFixed(1);
}

/** 带单位的展示串，例如 `115.2 GiB`。0 字节照常写 `0 GiB`。 */
export function formatTrafficGib(bytes: number): string {
  const value = formatTrafficGibValue(bytes);
  return value === "—" ? value : `${value} GiB`;
}

/**
 * 这台机器明天会新增的额度（字节）：`min(月额度 / 28, 月额度 − 已释放)`。
 * 已销毁不增长；到 28 天封顶（`traffic_limit_bytes` 追平月额度）贡献 0。
 */
export function trafficTomorrowBytes(
  server: Pick<MyServer, "state" | "transfer_gib" | "traffic_limit_bytes">,
): number {
  if (server.state === "destroyed") return 0;
  // 脏值不往下传：否则会渲染成「明天 +NaN GiB」。
  if (
    !Number.isFinite(server.transfer_gib) ||
    !Number.isFinite(server.traffic_limit_bytes)
  ) {
    return 0;
  }
  const monthly = Math.max(0, server.transfer_gib) * GIB;
  if (monthly <= 0) return 0;
  const remaining = Math.max(0, monthly - server.traffic_limit_bytes);
  return Math.min(monthly / RELEASE_DAYS, remaining);
}

/** 账号明天总共会新增多少额度：逐台增量之和。 */
export function trafficPoolTomorrowBytes(
  servers: readonly Pick<
    MyServer,
    "state" | "transfer_gib" | "traffic_limit_bytes"
  >[],
): number {
  return servers.reduce((sum, server) => sum + trafficTomorrowBytes(server), 0);
}

const RESET_FORMATTERS: Record<Language, Intl.DateTimeFormat> = {
  // 与账单、创建时间同一口径：英文统一 short month，避免同页混排 Dec / December。
  zh: new Intl.DateTimeFormat("zh-CN", { month: "short", day: "numeric" }),
  en: new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }),
};

/**
 * 周期清零点：ISO → 本地日。空串（旧控制面 / 离线）与非法值都返回 null，
 * 界面整段不渲染日期，绝不对空串 `new Date("")`。
 */
export function formatTrafficReset(
  iso: string,
  language: Language,
): string | null {
  if (iso.trim() === "") return null;
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return null;
  return RESET_FORMATTERS[language].format(new Date(at));
}
