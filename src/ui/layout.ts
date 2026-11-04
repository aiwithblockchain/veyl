/** 三栏布局的纯计算。窗口宽度、偏好宽度进，实际列宽出。 */

export const ACTIVITY_WIDTH = 56;
export const RAIL_DEFAULT = 240;
export const RAIL_MIN = 200;
export const RAIL_MAX = 360;
export const PANEL_DEFAULT = 400;
export const PANEL_MIN = 360;
export const PANEL_MAX = 560;
export const CONSOLE_MIN = 420;
export const OVERLAY_BREAKPOINT = 1100;
/** 浮层的理论上限；实际还受当前窗口停靠时右栏的有效上限钳制，见 computePaneLayout。 */
export const OVERLAY_MAX = 480;

export interface PaneLayout {
  floating: boolean;
  rail: number;
  /** 停靠时的右栏宽度；关闭与浮层模式下为 0。 */
  panel: number;
  console: number;
  /** 停靠时为右栏宽度，浮层时为浮层宽度。 */
  panelWidth: number;
}

export function clampWidth(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** 读取持久化的偏好宽度：非法或缺失用默认，合法值钳到名义范围。 */
export function parseStoredWidth(
  raw: string | null,
  fallback: number,
  min: number,
  max: number,
): number {
  if (raw === null) return fallback;
  const trimmed = raw.trim();
  if (!trimmed) return fallback;
  const value = Number(trimmed);
  if (!Number.isFinite(value)) return fallback;
  return Math.round(clampWidth(value, min, max));
}

/** 拖左栏时允许的最大宽度：控制台保住 420，另一侧不动。 */
export function railMaxFor(windowWidth: number, panelWidth: number): number {
  return Math.max(
    RAIL_MIN,
    Math.min(RAIL_MAX, windowWidth - ACTIVITY_WIDTH - panelWidth - CONSOLE_MIN),
  );
}

/** 拖右栏时允许的最大宽度：控制台保住 420，另一侧不动。 */
export function panelMaxFor(windowWidth: number, railWidth: number): number {
  return Math.max(
    PANEL_MIN,
    Math.min(PANEL_MAX, windowWidth - ACTIVITY_WIDTH - railWidth - CONSOLE_MIN),
  );
}

/**
 * 同一窗口宽度对应唯一布局；可用空间变化时按压缩公式分配，变宽变窄同一套。
 * available = W - ACTIVITY_WIDTH - CONSOLE_MIN。
 * 两侧偏好都放得下就都取偏好；否则右栏在 360 以上时由右栏让出/吸收差值；
 * 右栏已到最小 360 后，剩余差值由左栏吸收（左栏不低于最小 200）。
 * 控制台吃剩余空间；拖拽不走这里，拖哪侧钳哪侧。
 */
export function computePaneLayout(input: {
  windowWidth: number;
  railPref: number;
  panelPref: number;
  panelOpen: boolean;
}): PaneLayout {
  const windowWidth = Math.max(0, input.windowWidth);
  const railPref = clampWidth(input.railPref, RAIL_MIN, RAIL_MAX);
  const panelPref = clampWidth(input.panelPref, PANEL_MIN, PANEL_MAX);
  const floating = windowWidth < OVERLAY_BREAKPOINT;

  if (floating) {
    const rail = clampWidth(railPref, RAIL_MIN, railMaxFor(windowWidth, 0));
    // 不超过停靠时这个窗口能给右栏的宽度，跨 1100 不会反向跳。
    // 取舍：900 宽时浮层从 480 降到 360，窄屏优先让控制台完整可见，是有意的。
    const dockedPanelMax = panelMaxFor(windowWidth, rail);
    return {
      floating: true,
      rail,
      panel: 0,
      console: Math.max(CONSOLE_MIN, windowWidth - ACTIVITY_WIDTH - rail),
      panelWidth: clampWidth(
        panelPref,
        PANEL_MIN,
        Math.min(OVERLAY_MAX, dockedPanelMax),
      ),
    };
  }

  if (!input.panelOpen) {
    const rail = clampWidth(railPref, RAIL_MIN, railMaxFor(windowWidth, 0));
    return {
      floating: false,
      rail,
      panel: 0,
      console: Math.max(CONSOLE_MIN, windowWidth - ACTIVITY_WIDTH - rail),
      panelWidth: 0,
    };
  }

  // 左栏跨 1100 会反向跳（如偏好 360：浮层 360、停靠 264）：
  // 停靠后右栏必须占列宽，这是结构性结果，不在跨断点连续性修复范围内。
  const available = windowWidth - ACTIVITY_WIDTH - CONSOLE_MIN;
  let rail: number;
  let panel: number;
  if (available >= railPref + panelPref) {
    rail = railPref;
    panel = panelPref;
  } else if (available >= railPref + PANEL_MIN) {
    rail = railPref;
    panel = available - railPref;
  } else {
    panel = PANEL_MIN;
    rail = Math.max(RAIL_MIN, available - PANEL_MIN);
  }
  const consoleWidth = windowWidth - ACTIVITY_WIDTH - rail - panel;

  return {
    floating: false,
    rail,
    panel,
    console: consoleWidth,
    panelWidth: panel,
  };
}
