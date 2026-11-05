/** @vitest-environment jsdom */
import { act, cleanup, renderHook } from "@testing-library/react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { shellLayout } from "./breakpoints";
import { ASSISTANT_WIDTH_KEY, RAIL_WIDTH_KEY } from "./layout";
import { usePaneLayout } from "./usePaneLayout";

beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  localStorage.clear();
});

function key(name: string, shiftKey = false): ReactKeyboardEvent<HTMLDivElement> {
  return { key: name, shiftKey, preventDefault: () => {} } as ReactKeyboardEvent<HTMLDivElement>;
}

function setup(initial: { width?: number; panelOpen?: boolean; docked?: boolean } = {}) {
  return renderHook(
    ({ width, panelOpen, docked }: { width: number; panelOpen: boolean; docked: boolean }) =>
      usePaneLayout({
        windowWidth: width,
        mode: shellLayout(width).mode,
        docked,
        panelOpen,
      }),
    {
      initialProps: {
        width: initial.width ?? 1568,
        panelOpen: initial.panelOpen ?? true,
        docked: initial.docked ?? true,
      },
    },
  );
}

describe("usePaneLayout", () => {
  it("默认宽度来自断点，键盘第一次调整后写成用户偏好", () => {
    const { result } = setup();
    expect(result.current.rail).toBe(280);
    expect(result.current.assistant).toBe(420);

    act(() => result.current.railHandlers.onKeyDown(key("ArrowRight")));
    expect(result.current.rail).toBe(296);
    expect(localStorage.getItem(RAIL_WIDTH_KEY)).toBe("296");

    act(() => result.current.railHandlers.onKeyDown(key("ArrowRight", true)));
    expect(result.current.rail).toBe(360);
    act(() => result.current.railHandlers.onKeyDown(key("ArrowRight")));
    expect(result.current.rail).toBe(360);
  });

  it("方向键在最小值处停住", () => {
    const { result } = setup();
    for (let index = 0; index < 5; index += 1) {
      act(() => result.current.railHandlers.onKeyDown(key("ArrowLeft")));
    }
    expect(result.current.rail).toBe(220);
  });

  it("Home 到最小、End 到当前上限（Window Splitter 惯例）", () => {
    localStorage.setItem(RAIL_WIDTH_KEY, "340");
    const { result } = setup();
    expect(result.current.rail).toBe(340);

    act(() => result.current.railHandlers.onKeyDown(key("End")));
    expect(result.current.rail).toBe(360);
    act(() => result.current.railHandlers.onKeyDown(key("Home")));
    expect(result.current.rail).toBe(220);
    expect(localStorage.getItem(RAIL_WIDTH_KEY)).toBe("220");
  });

  it("助手向左拖（ArrowLeft）变宽", () => {
    const { result } = setup();
    act(() => result.current.assistantHandlers.onKeyDown(key("ArrowLeft")));
    expect(result.current.assistant).toBe(436);
    act(() => result.current.assistantHandlers.onKeyDown(key("ArrowLeft", true)));
    expect(result.current.assistant).toBe(500);
    expect(localStorage.getItem(ASSISTANT_WIDTH_KEY)).toBe("500");
  });

  it("关闭再打开，助手回到上次宽度", () => {
    localStorage.setItem(ASSISTANT_WIDTH_KEY, "600");
    const { result, rerender } = setup();
    expect(result.current.assistant).toBe(600);

    rerender({ width: 1568, panelOpen: false, docked: true });
    expect(result.current.assistant).toBe(56);
    expect(result.current.canDragPanel).toBe(false);

    rerender({ width: 1568, panelOpen: true, docked: true });
    expect(result.current.assistant).toBe(600);
  });

  it("窗口缩小后 clamp，放大回来恢复用户宽度", () => {
    localStorage.setItem(ASSISTANT_WIDTH_KEY, "640");
    const { result, rerender } = setup();
    expect(result.current.assistant).toBe(640);

    rerender({ width: 1200, panelOpen: true, docked: true });
    // 1200 - 420 可用 780；配置栏默认 260，助手被压到 520。
    expect(result.current.assistant).toBe(520);

    rerender({ width: 1568, panelOpen: true, docked: true });
    expect(result.current.assistant).toBe(640);
  });

  it("断点切到浮层后不再可拖", () => {
    const { result, rerender } = setup();
    expect(result.current.canDragRail).toBe(true);
    expect(result.current.canDragPanel).toBe(true);

    rerender({ width: 1100, panelOpen: true, docked: false });
    expect(result.current.canDragPanel).toBe(false);
    expect(result.current.assistant).toBe(56);
    expect(result.current.canDragRail).toBe(true);
  });

  it("图标栏断点下配置栏也不可拖", () => {
    const { result } = setup({ width: 1000, panelOpen: false, docked: false });
    expect(result.current.canDragRail).toBe(false);
    expect(result.current.rail).toBe(72);
  });
});
