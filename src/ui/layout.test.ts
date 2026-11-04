import { describe, expect, it } from "vitest";
import {
  CONSOLE_MIN,
  OVERLAY_BREAKPOINT,
  PANEL_DEFAULT,
  PANEL_MAX,
  PANEL_MIN,
  RAIL_DEFAULT,
  RAIL_MAX,
  RAIL_MIN,
  computePaneLayout,
  parseStoredWidth,
  panelMaxFor,
  railMaxFor,
} from "./layout";

const docked = (windowWidth: number, railPref = RAIL_DEFAULT, panelPref = PANEL_DEFAULT) =>
  computePaneLayout({ windowWidth, railPref, panelPref, panelOpen: true });

describe("computePaneLayout", () => {
  it("宽窗口默认偏好：左 240、右 400，剩余给控制台", () => {
    for (const width of [1920, 1440, 1200]) {
      const layout = docked(width);
      expect(layout).toMatchObject({ rail: 240, panel: 400, floating: false });
      expect(layout.console).toBe(width - 56 - 240 - 400);
    }
  });

  it("窗口 1116 时控制台恰好 420", () => {
    const layout = docked(1116);
    expect(layout.console).toBe(420);
    expect(layout.panel).toBe(400);
    expect(layout.rail).toBe(240);
  });

  it("窗口 1100 时先压右栏到 384", () => {
    const layout = docked(1100);
    expect(layout.console).toBe(420);
    expect(layout.panel).toBe(384);
    expect(layout.rail).toBe(240);
  });

  it("窗口 1100、左 360 / 右 560 时：右 360、左 264", () => {
    const layout = docked(1100, 360, 560);
    expect(layout.console).toBe(420);
    expect(layout.panel).toBe(360);
    expect(layout.rail).toBe(264);
  });

  it("窗口 1200 / 1440、左 360 / 右 560 的列宽", () => {
    const at1200 = docked(1200, 360, 560);
    expect(at1200).toMatchObject({ rail: 360, panel: 364, console: 420 });
    const at1440 = docked(1440, 360, 560);
    expect(at1440).toMatchObject({ rail: 360, panel: 560, console: 464 });
  });

  it("窗口 1200、左 360 / 右 400：左保持偏好，右 364", () => {
    const layout = docked(1200, 360, 400);
    expect(layout).toMatchObject({ rail: 360, panel: 364, console: 420 });
  });

  it("断点以下转浮层：右栏不占列宽，控制台只扣左栏", () => {
    const layout = computePaneLayout({
      windowWidth: 900,
      railPref: 240,
      panelPref: 400,
      panelOpen: true,
    });
    expect(layout.floating).toBe(true);
    expect(layout.rail).toBe(240);
    expect(layout.panel).toBe(0);
    expect(layout.console).toBe(604);
    expect(layout.panelWidth).toBe(400);
    expect(OVERLAY_BREAKPOINT).toBe(1100);
  });

  it("浮层宽度钳在 360–480，偏好 560 时取 480", () => {
    const layout = computePaneLayout({
      windowWidth: 900,
      railPref: 240,
      panelPref: 560,
      panelOpen: true,
    });
    expect(layout.panelWidth).toBe(480);
  });

  it("右栏关闭时 panel 为 0，控制台拿回空间", () => {
    const layout = computePaneLayout({
      windowWidth: 1200,
      railPref: 240,
      panelPref: 400,
      panelOpen: false,
    });
    expect(layout.panel).toBe(0);
    expect(layout.console).toBe(1200 - 56 - 240);
  });

  it("左栏偏好超出范围时钳到名义范围", () => {
    expect(docked(1600, 999, 400).rail).toBe(RAIL_MAX);
    expect(docked(1600, 10, 400).rail).toBe(RAIL_MIN);
  });
});

describe("拖拽边界", () => {
  it("拖左栏时保住控制台 420，不推动右栏", () => {
    expect(railMaxFor(1100, 400)).toBe(224);
    expect(railMaxFor(1440, 400)).toBe(360);
    expect(railMaxFor(1600, 0)).toBe(360);
  });

  it("拖右栏时保住控制台 420，不推动左栏", () => {
    expect(panelMaxFor(1100, 240)).toBe(384);
    expect(panelMaxFor(1440, 240)).toBe(560);
    expect(panelMaxFor(1200, 360)).toBe(364);
  });
});

describe("偏好持久化解析", () => {
  it("缺失用默认", () => {
    expect(parseStoredWidth(null, RAIL_DEFAULT, RAIL_MIN, RAIL_MAX)).toBe(240);
  });

  it("非数字用默认", () => {
    expect(parseStoredWidth("abc", PANEL_DEFAULT, PANEL_MIN, PANEL_MAX)).toBe(400);
    expect(parseStoredWidth("", PANEL_DEFAULT, PANEL_MIN, PANEL_MAX)).toBe(400);
  });

  it("合法值保留，越界钳到名义范围", () => {
    expect(parseStoredWidth("310", RAIL_DEFAULT, RAIL_MIN, RAIL_MAX)).toBe(310);
    expect(parseStoredWidth("9999", RAIL_DEFAULT, RAIL_MIN, RAIL_MAX)).toBe(RAIL_MAX);
    expect(parseStoredWidth("10", PANEL_DEFAULT, PANEL_MIN, PANEL_MAX)).toBe(PANEL_MIN);
  });

  it("CONSOLE_MIN 是 420", () => {
    expect(CONSOLE_MIN).toBe(420);
  });
});
