/** @vitest-environment jsdom */
import { act, renderHook } from "@testing-library/react";
import type {
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
} from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { usePaneLayout } from "./usePaneLayout";

class MockResizeObserver implements ResizeObserver {
  static instances: MockResizeObserver[] = [];
  private callback: ResizeObserverCallback;

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    MockResizeObserver.instances.push(this);
  }

  observe() {}
  unobserve() {}
  disconnect() {}

  emit(width: number) {
    this.callback([{ contentRect: { width } } as unknown as ResizeObserverEntry], this);
  }
}

const cleanups: Array<() => void> = [];

function setup(width: number) {
  const app = document.createElement("div");
  document.body.appendChild(app);
  const appRef = { current: app };
  const { result, unmount } = renderHook(() =>
    usePaneLayout({ appRef, panelOpen: true, active: true }),
  );
  cleanups.push(unmount);
  const observer = MockResizeObserver.instances[MockResizeObserver.instances.length - 1];
  act(() => observer.emit(width));
  return result;
}

function pointerEvent(clientX: number): ReactPointerEvent<HTMLDivElement> {
  return {
    button: 0,
    pointerId: 1,
    clientX,
    preventDefault: vi.fn(),
    currentTarget: {
      setPointerCapture: vi.fn(),
      hasPointerCapture: () => true,
      releasePointerCapture: vi.fn(),
    },
  } as unknown as ReactPointerEvent<HTMLDivElement>;
}

function keyEvent(key: string): ReactKeyboardEvent<HTMLDivElement> {
  return {
    key,
    preventDefault: vi.fn(),
    shiftKey: false,
  } as unknown as ReactKeyboardEvent<HTMLDivElement>;
}

beforeEach(() => {
  MockResizeObserver.instances = [];
  vi.stubGlobal("ResizeObserver", MockResizeObserver);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  localStorage.clear();
});

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
  document.body.innerHTML = "";
  delete document.body.dataset.resizing;
});

describe("usePaneLayout 偏好持久化", () => {
  it("窄窗口单击手柄不写偏好", () => {
    const result = setup(1100);
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    act(() => result.current.panelHandlers.onPointerDown(pointerEvent(500)));
    act(() => result.current.panelHandlers.onPointerUp());
    expect(setItem).not.toHaveBeenCalled();
  });

  it("窄窗口 Home 存名义默认 240，放大后恢复", () => {
    localStorage.setItem("veyl.ui.railWidth", "360");
    const result = setup(1100);
    act(() => result.current.railHandlers.onKeyDown(keyEvent("Home")));
    expect(localStorage.getItem("veyl.ui.railWidth")).toBe("240");
    const observer = MockResizeObserver.instances[0];
    act(() => observer.emit(1600));
    expect(result.current.rail).toBe(240);
  });

  it("窄窗口右栏 Home 存名义默认 400", () => {
    localStorage.setItem("veyl.ui.panelWidth", "560");
    const result = setup(1100);
    act(() => result.current.panelHandlers.onKeyDown(keyEvent("Home")));
    expect(localStorage.getItem("veyl.ui.panelWidth")).toBe("400");
  });

  it("窄窗口 End 存名义上限 560，不存有效上限 384", () => {
    vi.useFakeTimers();
    localStorage.setItem("veyl.ui.panelWidth", "400");
    const result = setup(1100);
    act(() => result.current.panelHandlers.onKeyDown(keyEvent("End")));
    act(() => vi.advanceTimersByTime(150));
    expect(localStorage.getItem("veyl.ui.panelWidth")).toBe("560");
  });

  it("拖拽存起始偏好加位移，不存有效宽度", () => {
    localStorage.setItem("veyl.ui.panelWidth", "400");
    const result = setup(1100);
    act(() => result.current.panelHandlers.onPointerDown(pointerEvent(500)));
    act(() => result.current.panelHandlers.onPointerMove(pointerEvent(490)));
    act(() => result.current.panelHandlers.onPointerUp());
    expect(localStorage.getItem("veyl.ui.panelWidth")).toBe("410");
  });
});
