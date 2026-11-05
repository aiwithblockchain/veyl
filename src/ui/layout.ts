/** 三栏宽度：偏好值来自用户拖动，当前有效宽度再由窗口与断点算出。 */
import { ASSISTANT_TAB_WIDTH, shellLayout, type ShellMode } from "./breakpoints";

export const RAIL_MIN = 220;
export const RAIL_MAX = 360;
export const ASSISTANT_MIN = 320;
export const ASSISTANT_MAX = 640;
/** 控制台保底宽度：两侧都吃不下时先压助手、再压配置栏。 */
export const CONSOLE_MIN = 420;

/** 宽度偏好单独带版本，换版式时旧值不参与计算。 */
export const LAYOUT_VERSION = "v1";
export const RAIL_WIDTH_KEY = `veyl.ui.railWidth.${LAYOUT_VERSION}`;
export const ASSISTANT_WIDTH_KEY = `veyl.ui.assistantWidth.${LAYOUT_VERSION}`;

export type Pane = "rail" | "assistant";

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function clampWidth(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** 读取存下来的宽度：缺失或非法返回 null（跟随断点默认），合法值钳到名义范围。 */
export function parseStoredWidth(
  raw: string | null,
  min: number,
  max: number,
): number | null {
  if (raw === null) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const value = Number(trimmed);
  if (!Number.isFinite(value)) return null;
  return Math.round(clampWidth(value, min, max));
}

export interface PanePrefs {
  rail: number | null;
  assistant: number | null;
}

export function readPanePrefs(storage: StorageLike): PanePrefs {
  try {
    return {
      rail: parseStoredWidth(storage.getItem(RAIL_WIDTH_KEY), RAIL_MIN, RAIL_MAX),
      assistant: parseStoredWidth(
        storage.getItem(ASSISTANT_WIDTH_KEY),
        ASSISTANT_MIN,
        ASSISTANT_MAX,
      ),
    };
  } catch {
    return { rail: null, assistant: null };
  }
}

/** 只写宽度，不碰 layout 表，也不写数据库。 */
export function writePaneWidth(storage: StorageLike, pane: Pane, value: number): void {
  try {
    storage.setItem(
      pane === "rail" ? RAIL_WIDTH_KEY : ASSISTANT_WIDTH_KEY,
      String(Math.round(value)),
    );
  } catch {
    // 存不了就只在本次会话里记住。
  }
}

/** 拖配置栏时允许的最大宽度：控制台保住 420，助手那一侧不动。 */
export function railMaxFor(windowWidth: number, assistantWidth: number): number {
  return Math.max(
    RAIL_MIN,
    Math.min(RAIL_MAX, windowWidth - assistantWidth - CONSOLE_MIN),
  );
}

/** 拖助手时允许的最大宽度：控制台保住 420，配置栏那一侧不动。 */
export function assistantMaxFor(windowWidth: number, railWidth: number): number {
  return Math.max(
    ASSISTANT_MIN,
    Math.min(ASSISTANT_MAX, windowWidth - railWidth - CONSOLE_MIN),
  );
}

export interface PaneWidths {
  rail: number;
  /** 停靠且打开时的实际宽度；收起或浮层时这里是偏好值，列宽由调用方取 56。 */
  assistant: number;
  railMax: number;
  assistantMax: number;
}

export interface ResolveInput {
  windowWidth: number;
  mode: ShellMode;
  docked: boolean;
  panelOpen: boolean;
  prefs: PanePrefs;
}

/**
 * 同一窗口宽度对应唯一布局。
 * - 没拖过就跟随断点默认宽度；拖过就一直用用户宽度。
 * - 窗口缩小时先压助手（到 320），再压配置栏（到 220）；放大回来恢复用户宽度。
 * - 助手收起或浮层时，配置栏按「只剩 56px tab」计算上限。
 */
export function resolvePaneWidths(input: ResolveInput): PaneWidths {
  const windowWidth = Math.max(0, input.windowWidth);
  const defaults = shellLayout(windowWidth);
  const railPref = clampWidth(input.prefs.rail ?? defaults.rail, RAIL_MIN, RAIL_MAX);
  const assistantPref = clampWidth(
    input.prefs.assistant ?? defaults.assistant,
    ASSISTANT_MIN,
    ASSISTANT_MAX,
  );

  // <1024 配置栏收成 72px 图标栏，拖动不参与。
  if (input.mode === "drawer") {
    return {
      rail: defaults.rail,
      assistant: ASSISTANT_TAB_WIDTH,
      railMax: defaults.rail,
      assistantMax: ASSISTANT_MIN,
    };
  }

  if (!input.docked || !input.panelOpen) {
    const railMax = railMaxFor(windowWidth, ASSISTANT_TAB_WIDTH);
    const rail = clampWidth(railPref, RAIL_MIN, railMax);
    return {
      rail,
      assistant: ASSISTANT_TAB_WIDTH,
      railMax,
      assistantMax: ASSISTANT_MIN,
    };
  }

  const available = windowWidth - CONSOLE_MIN;
  let rail = railPref;
  let assistant = assistantPref;
  if (rail + assistant > available) {
    if (rail + ASSISTANT_MIN <= available) {
      assistant = available - rail;
    } else {
      assistant = ASSISTANT_MIN;
      rail = clampWidth(available - ASSISTANT_MIN, RAIL_MIN, RAIL_MAX);
    }
  }

  return {
    rail,
    assistant,
    railMax: railMaxFor(windowWidth, assistant),
    assistantMax: assistantMaxFor(windowWidth, rail),
  };
}
