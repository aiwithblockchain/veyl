import { describe, expect, it } from "vitest";
import {
  PANEL_KEY,
  PANEL_VERSION,
  PANEL_VERSION_KEY,
  readPanelOpen,
  writePanelChoice,
  type StorageLike,
} from "./panelPreference";

function memoryStorage(initial: Record<string, string> = {}): StorageLike & {
  data: Record<string, string>;
} {
  const data = { ...initial };
  return {
    data,
    getItem: (key) => (key in data ? data[key] : null),
    setItem: (key, value) => {
      data[key] = value;
    },
  };
}

describe("readPanelOpen", () => {
  it("没有存过版本：按窗口宽度给默认值", () => {
    expect(readPanelOpen(memoryStorage(), 1568)).toBe(true);
    expect(readPanelOpen(memoryStorage(), 1100)).toBe(false);
  });

  it("版本一致时沿用用户的选择", () => {
    const storage = memoryStorage({
      [PANEL_KEY]: "0",
      [PANEL_VERSION_KEY]: PANEL_VERSION,
    });
    expect(readPanelOpen(storage, 1568)).toBe(false);
  });

  it("旧版本存下的收起不再作数，升级后第一次按首次处理", () => {
    const old = memoryStorage({
      [PANEL_KEY]: "0",
      [PANEL_VERSION_KEY]: "old-version",
    });
    expect(readPanelOpen(old, 1568)).toBe(true);
    expect(readPanelOpen(old, 1100)).toBe(false);
  });
});

describe("writePanelChoice", () => {
  it("开关值和版本号一起写，不留半套状态", () => {
    const storage = memoryStorage();
    writePanelChoice(storage, false);
    expect(storage.data).toEqual({
      [PANEL_KEY]: "0",
      [PANEL_VERSION_KEY]: PANEL_VERSION,
    });

    writePanelChoice(storage, true);
    expect(storage.data).toEqual({
      [PANEL_KEY]: "1",
      [PANEL_VERSION_KEY]: PANEL_VERSION,
    });
  });
});
