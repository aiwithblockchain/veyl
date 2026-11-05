import { defaultPanelOpen, initialPanelOpen } from "./breakpoints";

export const PANEL_KEY = "veyl.ui.panelOpen";
export const PANEL_VERSION_KEY = "veyl.ui.panelVersion";
/** 界面改版版本；变化后旧版本存的「收起」不再作数。 */
export const PANEL_VERSION = "redesign-1";

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** 启动时读助手是否展开：旧版本或没选过 → 按窗口宽度给默认值。 */
export function readPanelOpen(storage: StorageLike, width: number): boolean {
  try {
    return initialPanelOpen({
      storedVersion: storage.getItem(PANEL_VERSION_KEY),
      storedOpen: storage.getItem(PANEL_KEY),
      width,
      currentVersion: PANEL_VERSION,
    });
  } catch {
    return defaultPanelOpen(width);
  }
}

/**
 * 只有用户点了开关才调用。开关值和版本号必须一起写：
 * 分开两处写，中途失败就会出现「版本已是新值 + 值是旧的」。
 */
export function writePanelChoice(storage: StorageLike, open: boolean): void {
  try {
    storage.setItem(PANEL_KEY, open ? "1" : "0");
    storage.setItem(PANEL_VERSION_KEY, PANEL_VERSION);
  } catch {
    // 存不了就只在本次会话里记住。
  }
}
