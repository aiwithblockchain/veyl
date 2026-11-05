/**
 * 三栏外壳的断点判定（ui-redesign-proposal.md §4.2）。
 * 纯函数：只按窗口宽度决定栏宽与助手形态，不读 DOM。
 */
export type ShellMode = "wide" | "compact" | "tab" | "drawer";

export interface ShellLayout {
  mode: ShellMode;
  /** 配置栏宽度。 */
  rail: number;
  /** 助手停靠宽度；收起时为右边缘 tab 的 56px。 */
  assistant: number;
  /** 助手是否停靠在第三栏；false 时收起为 tab，打开是浮层。 */
  docked: boolean;
}

export const ASSISTANT_TAB_WIDTH = 56;
export const DRAWER_RAIL_WIDTH = 72;

export function shellLayout(width: number): ShellLayout {
  if (width >= 1440) {
    return { mode: "wide", rail: 280, assistant: 420, docked: true };
  }
  if (width >= 1200) {
    return { mode: "compact", rail: 260, assistant: 380, docked: true };
  }
  if (width >= 1024) {
    return { mode: "tab", rail: 240, assistant: ASSISTANT_TAB_WIDTH, docked: false };
  }
  return { mode: "drawer", rail: DRAWER_RAIL_WIDTH, assistant: ASSISTANT_TAB_WIDTH, docked: false };
}

/** 首次进入（没有用户选择）时助手是否展开：宽屏展开，窄屏收成 tab。 */
export function defaultPanelOpen(width: number): boolean {
  return shellLayout(width).docked;
}

/**
 * 助手占的第三列宽度。收起时永远只留 56px tab；
 * 窄屏即使打开也是浮层，列宽仍是 56。
 */
export function assistantColumnWidth(layout: ShellLayout, open: boolean): number {
  return open && layout.docked ? layout.assistant : ASSISTANT_TAB_WIDTH;
}

/**
 * 启动时助手是否展开。界面大改版后旧版本存下的「收起」不再作数：
 * 版本号对不上就当首次进入，按窗口宽度给默认值；之后用户的开关照常记住。
 */
export function initialPanelOpen(input: {
  storedVersion: string | null;
  storedOpen: string | null;
  width: number;
  currentVersion: string;
}): boolean {
  if (
    input.storedVersion === input.currentVersion &&
    input.storedOpen !== null
  ) {
    return input.storedOpen === "1";
  }
  return defaultPanelOpen(input.width);
}
