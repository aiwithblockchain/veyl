import { describe, expect, it } from "vitest";
import {
  assistantColumnWidth,
  defaultPanelOpen,
  initialPanelOpen,
  shellLayout,
} from "./breakpoints";

describe("shellLayout 断点", () => {
  it("≥1440 完整三栏", () => {
    expect(shellLayout(1568)).toEqual({
      mode: "wide",
      rail: 280,
      assistant: 420,
      docked: true,
    });
  });

  it("1200–1439 收窄但助手仍停靠", () => {
    expect(shellLayout(1439)).toMatchObject({ mode: "compact", rail: 260, assistant: 380, docked: true });
    expect(shellLayout(1200)).toMatchObject({ mode: "compact", rail: 260 });
  });

  it("1024–1199 助手收起为 56px tab", () => {
    expect(shellLayout(1199)).toEqual({
      mode: "tab",
      rail: 240,
      assistant: 56,
      docked: false,
    });
    expect(shellLayout(1024)).toMatchObject({ mode: "tab", rail: 240 });
  });

  it("<1024 配置栏变成 72px 图标栏", () => {
    expect(shellLayout(1000)).toEqual({
      mode: "drawer",
      rail: 72,
      assistant: 56,
      docked: false,
    });
  });

  it("窄窗口默认收起助手，宽窗口默认展开", () => {
    expect(defaultPanelOpen(1568)).toBe(true);
    expect(defaultPanelOpen(1200)).toBe(true);
    expect(defaultPanelOpen(1100)).toBe(false);
    expect(defaultPanelOpen(900)).toBe(false);
  });
});

describe("assistantColumnWidth", () => {
  it("宽屏打开是 420，收起缩到 56", () => {
    expect(assistantColumnWidth(shellLayout(1568), true)).toBe(420);
    expect(assistantColumnWidth(shellLayout(1568), false)).toBe(56);
  });

  it("1200–1439 打开是 380，收起也是 56", () => {
    expect(assistantColumnWidth(shellLayout(1300), true)).toBe(380);
    expect(assistantColumnWidth(shellLayout(1300), false)).toBe(56);
  });

  it("窄屏无论开合列宽都是 56（打开走浮层）", () => {
    expect(assistantColumnWidth(shellLayout(1100), true)).toBe(56);
    expect(assistantColumnWidth(shellLayout(1100), false)).toBe(56);
    expect(assistantColumnWidth(shellLayout(900), true)).toBe(56);
  });
});

describe("initialPanelOpen", () => {
  const currentVersion = "2";

  it("没有存过版本：按窗口宽度给默认值", () => {
    expect(
      initialPanelOpen({
        storedVersion: null,
        storedOpen: null,
        width: 1568,
        currentVersion,
      }),
    ).toBe(true);
    expect(
      initialPanelOpen({
        storedVersion: null,
        storedOpen: null,
        width: 1100,
        currentVersion,
      }),
    ).toBe(false);
  });

  it("版本一致时沿用用户的选择", () => {
    expect(
      initialPanelOpen({
        storedVersion: currentVersion,
        storedOpen: "0",
        width: 1568,
        currentVersion,
      }),
    ).toBe(false);
    expect(
      initialPanelOpen({
        storedVersion: currentVersion,
        storedOpen: "1",
        width: 1100,
        currentVersion,
      }),
    ).toBe(true);
  });

  it("旧版本存下的收起不再作数：升级后第一次按首次处理", () => {
    expect(
      initialPanelOpen({
        storedVersion: "1",
        storedOpen: "0",
        width: 1568,
        currentVersion,
      }),
    ).toBe(true);
    expect(
      initialPanelOpen({
        storedVersion: null,
        storedOpen: "0",
        width: 1568,
        currentVersion,
      }),
    ).toBe(true);
  });
});
