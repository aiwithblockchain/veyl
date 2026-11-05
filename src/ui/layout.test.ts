import { describe, expect, it } from "vitest";
import { shellLayout } from "./breakpoints";
import {
  ASSISTANT_MAX,
  ASSISTANT_MIN,
  ASSISTANT_WIDTH_KEY,
  CONSOLE_MIN,
  RAIL_MAX,
  RAIL_MIN,
  RAIL_WIDTH_KEY,
  assistantMaxFor,
  parseStoredWidth,
  railMaxFor,
  readPanePrefs,
  resolvePaneWidths,
  writePaneWidth,
  type PanePrefs,
  type StorageLike,
} from "./layout";

const NO_PREFS: PanePrefs = { rail: null, assistant: null };

function resolve(windowWidth: number, prefs: PanePrefs = NO_PREFS) {
  const shell = shellLayout(windowWidth);
  return resolvePaneWidths({
    windowWidth,
    mode: shell.mode,
    docked: shell.docked,
    panelOpen: true,
    prefs,
  });
}

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

describe("resolvePaneWidths 默认值", () => {
  it("没拖过时跟随断点：1568 是 280/420，1300 是 260/380", () => {
    expect(resolve(1568)).toMatchObject({ rail: 280, assistant: 420 });
    expect(resolve(1300)).toMatchObject({ rail: 260, assistant: 380 });
  });

  it("助手收起或浮层时列宽只留 56，配置栏按剩余空间算上限", () => {
    const shell = shellLayout(1100);
    const closed = resolvePaneWidths({
      windowWidth: 1100,
      mode: shell.mode,
      docked: false,
      panelOpen: false,
      prefs: NO_PREFS,
    });
    expect(closed).toMatchObject({ rail: 240, assistant: 56 });
    expect(closed.railMax).toBe(RAIL_MAX);
  });

  it("小于 1024 进入图标栏，宽度固定 72", () => {
    const shell = shellLayout(1000);
    const drawer = resolvePaneWidths({
      windowWidth: 1000,
      mode: shell.mode,
      docked: false,
      panelOpen: true,
      prefs: { rail: 340, assistant: 500 },
    });
    expect(drawer.rail).toBe(72);
    expect(drawer.assistant).toBe(56);
  });
});

describe("resolvePaneWidths 用户宽度", () => {
  const prefs: PanePrefs = { rail: 340, assistant: 600 };

  it("拖过之后用用户宽度", () => {
    expect(resolve(1568, prefs)).toMatchObject({ rail: 340, assistant: 600 });
  });

  it("窗口缩小先压助手，放大后恢复用户宽度", () => {
    // 1200 - 420 = 780 可用；340 固定，助手压到 440。
    const small = resolve(1200, prefs);
    expect(small.rail).toBe(340);
    expect(small.assistant).toBe(440);
    expect(small.assistant).toBeLessThan(600);

    const big = resolve(1568, prefs);
    expect(big.rail).toBe(340);
    expect(big.assistant).toBe(600);
  });

  it("助手降到可用空间的上限，配置栏保持用户宽度", () => {
    // 1200 可用 780；rail 360 + 助手 640 = 1000 超了，助手先降到 420。
    const width = 1200;
    const next = resolvePaneWidths({
      windowWidth: width,
      mode: "compact",
      docked: true,
      panelOpen: true,
      prefs: { rail: 360, assistant: 640 },
    });
    expect(next).toMatchObject({ rail: 360, assistant: width - CONSOLE_MIN - 360 });
  });

  it("偏好超出名义范围时钳到 220–360 / 320–640", () => {
    expect(resolve(1568, { rail: 999, assistant: 999 })).toMatchObject({
      rail: RAIL_MAX,
      assistant: ASSISTANT_MAX,
    });
    expect(resolve(1568, { rail: 10, assistant: 10 })).toMatchObject({
      rail: RAIL_MIN,
      assistant: ASSISTANT_MIN,
    });
  });

  it("关闭助手再打开，恢复上次宽度", () => {
    const shell = shellLayout(1568);
    const closed = resolvePaneWidths({
      windowWidth: 1568,
      mode: shell.mode,
      docked: shell.docked,
      panelOpen: false,
      prefs,
    });
    expect(closed.assistant).toBe(56);
    expect(resolve(1568, prefs).assistant).toBe(600);
  });

  it("拖拽上限给另一侧和控制台留空间", () => {
    expect(railMaxFor(1568, 420)).toBe(RAIL_MAX);
    expect(railMaxFor(1000, 420)).toBe(RAIL_MIN);
    expect(assistantMaxFor(1568, 280)).toBe(ASSISTANT_MAX);
    expect(assistantMaxFor(1200, 360)).toBe(420);
  });
});

describe("宽度持久化", () => {
  it("只读宽度、缺失或非法返回 null", () => {
    expect(readPanePrefs(memoryStorage())).toEqual({ rail: null, assistant: null });
    expect(
      readPanePrefs(memoryStorage({ [RAIL_WIDTH_KEY]: "abc", [ASSISTANT_WIDTH_KEY]: "  " })),
    ).toEqual({ rail: null, assistant: null });
  });

  it("存下来的宽度读回时钳到名义范围", () => {
    const storage = memoryStorage({
      [RAIL_WIDTH_KEY]: "999",
      [ASSISTANT_WIDTH_KEY]: "300",
    });
    expect(readPanePrefs(storage)).toEqual({ rail: RAIL_MAX, assistant: ASSISTANT_MIN });
  });

  it("写入只碰宽度键，键名带版本", () => {
    const storage = memoryStorage();
    writePaneWidth(storage, "rail", 300.4);
    writePaneWidth(storage, "assistant", 512);
    expect(storage.data).toEqual({
      "veyl.ui.railWidth.v1": "300",
      "veyl.ui.assistantWidth.v1": "512",
    });
    expect(storage.data).not.toHaveProperty("layout");
  });

  it("parseStoredWidth 边界", () => {
    expect(parseStoredWidth(null, RAIL_MIN, RAIL_MAX)).toBeNull();
    expect(parseStoredWidth("", RAIL_MIN, RAIL_MAX)).toBeNull();
    expect(parseStoredWidth("abc", RAIL_MIN, RAIL_MAX)).toBeNull();
    expect(parseStoredWidth("210", RAIL_MIN, RAIL_MAX)).toBe(RAIL_MIN);
    expect(parseStoredWidth("300.6", RAIL_MIN, RAIL_MAX)).toBe(301);
    expect(parseStoredWidth("999", RAIL_MIN, RAIL_MAX)).toBe(RAIL_MAX);
  });

  it("任意窗口与偏好组合下控制台都不低于 420", () => {
    const prefsList: PanePrefs[] = [
      NO_PREFS,
      { rail: RAIL_MIN, assistant: ASSISTANT_MIN },
      { rail: RAIL_MAX, assistant: ASSISTANT_MAX },
      { rail: null, assistant: ASSISTANT_MAX },
      { rail: RAIL_MAX, assistant: null },
    ];
    for (let width = 1024; width <= 2000; width += 19) {
      const shell = shellLayout(width);
      for (const prefs of prefsList) {
        const next = resolvePaneWidths({
          windowWidth: width,
          mode: shell.mode,
          docked: shell.docked,
          panelOpen: true,
          prefs,
        });
        expect(width - next.rail - next.assistant).toBeGreaterThanOrEqual(CONSOLE_MIN);
      }
    }
  });
});
