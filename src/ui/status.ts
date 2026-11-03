import type { RuntimeView } from "../agent/protocol";
import type { RuntimeAction } from "../agent/bridge";

/** 界面上只区分这四种连接状态；degraded 仍算已连接，但用 warn 语气。 */
export type LinkState = "idle" | "connecting" | "connected" | "failed";
export type StatusTone = "ok" | "warn" | "err" | "muted";

export function toLinkState(state: RuntimeView["state"]): LinkState {
  switch (state) {
    case "running":
    case "degraded":
      return "connected";
    case "starting":
    case "restarting":
    case "stopping":
      return "connecting";
    case "failed":
      return "failed";
    default:
      return "idle";
  }
}

export function statusSentence(
  link: LinkState,
  nodeName: string | null,
  degraded = false,
  stopping = false,
): string {
  if (stopping) return "正在断开…";
  switch (link) {
    case "connected":
      return degraded
        ? `连接异常 · ${nodeName ?? "当前节点"}`
        : `已连接 · ${nodeName ?? "当前节点"}`;
    case "connecting":
      return "正在连接…";
    case "failed":
      return "连接失败";
    default:
      return "未连接";
  }
}

export function statusTone(link: LinkState, degraded = false): StatusTone {
  switch (link) {
    case "connected":
      return degraded ? "warn" : "ok";
    case "connecting":
      return "warn";
    case "failed":
      return "err";
    default:
      return "muted";
  }
}

/** 顶栏胶囊只说状态，不带节点名与按钮。 */
export function statusPillLabel(
  link: LinkState,
  degraded = false,
  stopping = false,
): string {
  if (stopping) return "断开中";
  switch (link) {
    case "connected":
      return degraded ? "连接异常" : "已连接";
    case "connecting":
      return "连接中";
    case "failed":
      return "连接失败";
    default:
      return "未连接";
  }
}

/** 状态到 CSS 修饰符的映射，组件里不再各写一遍。 */
export function toneClass(tone: StatusTone): string {
  return `is-${tone}`;
}

export interface PrimaryAction {
  label: string;
  kind: "start" | "stop" | "default";
  disabled: boolean;
  /** 主按钮下方的一行说明；没有就不渲染。 */
  note: string | null;
}

/**
 * 同一屏幕唯一主按钮的文案与行为。控制台与右栏共用这一个函数。
 */
export function primaryAction(options: {
  state: RuntimeView["state"];
  hasProfiles: boolean;
  pending: RuntimeAction | null;
  defaultBusy: boolean;
}): PrimaryAction {
  const { state, hasProfiles, pending, defaultBusy } = options;
  const busyLabel = pending === "stop" ? "正在断开…" : "正在连接…";

  // 已经进入 stopping 就不能再显示「取消」：断开已经在执行。
  if (state === "stopping") {
    return { label: "正在断开…", kind: "stop", disabled: true, note: null };
  }
  // 在线/过渡态优先：默认配置包连接时 profile 列表本来就是空的。
  if (state === "starting" || state === "restarting") {
    return {
      label: pending === null ? "取消" : busyLabel,
      kind: "stop",
      disabled: pending !== null,
      note: null,
    };
  }
  if (state === "running" || state === "degraded") {
    return {
      label: pending === null ? "断开" : busyLabel,
      kind: "stop",
      disabled: pending !== null,
      note: null,
    };
  }
  if (!hasProfiles) {
    return {
      label: defaultBusy ? "获取中…" : "使用测试节点",
      kind: "default",
      disabled: defaultBusy || pending !== null,
      note: null,
    };
  }
  if (state === "failed") {
    return {
      label: pending === null ? "重新连接" : busyLabel,
      kind: "start",
      disabled: pending !== null,
      note: null,
    };
  }
  return {
    label: pending === null ? "连接" : busyLabel,
    kind: "start",
    disabled: pending !== null,
    note: null,
  };
}

/** 控制台的连接状态只有这四种；批 2 由假数据驱动，接上运行时后沿用同一套文案。 */
export type ConsoleConnectionState = "idle" | "starting" | "connected" | "stopping";

export function consoleStatus(
  state: ConsoleConnectionState,
  hasConfig: boolean,
  hasNodes: boolean,
): { text: string; tone: StatusTone } {
  if (state === "connected") return { text: "已连接", tone: "ok" };
  if (state === "starting") return { text: "正在启动…", tone: "warn" };
  if (state === "stopping") return { text: "正在断开…", tone: "warn" };
  if (!hasConfig) return { text: "还没有配置", tone: "muted" };
  if (!hasNodes) return { text: "这套配置还没有节点", tone: "muted" };
  return { text: "未连接", tone: "muted" };
}

export function consolePrimary(
  state: ConsoleConnectionState,
  canConnect: boolean,
): { label: string; disabled: boolean; stop: boolean } {
  if (state === "starting") return { label: "正在启动…", disabled: true, stop: false };
  if (state === "connected") return { label: "断开 VPN", disabled: false, stop: true };
  if (state === "stopping") return { label: "正在断开…", disabled: true, stop: true };
  return { label: "启动 VPN", disabled: !canConnect, stop: false };
}
