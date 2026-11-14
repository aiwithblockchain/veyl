import type { MyServerRegion, MyServerState } from "../agent/bridge";

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

export function formatUsd(value: number): string {
  return Number.isInteger(value) ? `$${value}` : `$${value.toFixed(3)}`;
}

/** 小时价保留 5 位；按 3 位会把手里的 $0.00893 截成 $0.009。 */
export function formatUsdHourly(value: number): string {
  return `$${value.toFixed(5)}`;
}

export function formatServerTime(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(
    at.getHours(),
  )}:${pad(at.getMinutes())}`;
}

/** 状态点颜色：复用现有 `.led` 的三种 tone。 */
export function stateTone(state: MyServerState): "ok" | "warn" | "err" | "idle" {
  if (state === "healthy" || state === "active") return "ok";
  if (state === "error" || state === "gone") return "err";
  if (state === "destroying" || state === "destroyed") return "idle";
  return "warn";
}
