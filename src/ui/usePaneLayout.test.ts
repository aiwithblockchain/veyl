/** @vitest-environment jsdom */
import { act, fireEvent, renderHook } from "@testing-library/react";
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

interface PointerTarget {
  setPointerCapture: ReturnType<typeof vi.fn>;
  hasPointerCapture: () => boolean;
  releasePointerCapture: ReturnType<typeof vi.fn>;
}

function makeTarget(): PointerTarget {
  return {
    setPointerCapture: vi.fn(),
    hasPointerCapture: () => true,
    releasePointerCapture: vi.fn(),
  };
}

function pointerEvent(
  clientX: number,
  target: PointerTarget = makeTarget(),
): ReactPointerEvent<HTMLDivElement> {
  return {
    button: 0,
    pointerId: 1,
    clientX,
    preventDefault: vi.fn(),
    currentTarget: target,
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

  it("窄窗口 End 跳到有效上限 384", () => {
    vi.useFakeTimers();
    localStorage.setItem("veyl.ui.panelWidth", "560");
    const result = setup(1100);
    act(() => result.current.panelHandlers.onKeyDown(keyEvent("End")));
    act(() => vi.advanceTimersByTime(150));
    expect(localStorage.getItem("veyl.ui.panelWidth")).toBe("384");
  });

  it("偏好高于有效宽度时，第一次方向键就生效", () => {
    vi.useFakeTimers();
    localStorage.setItem("veyl.ui.panelWidth", "560");
    const result = setup(1100);
    expect(result.current.panel).toBe(384);
    act(() => result.current.panelHandlers.onKeyDown(keyEvent("ArrowRight")));
    expect(result.current.panel).toBe(368);
    act(() => vi.advanceTimersByTime(150));
    expect(localStorage.getItem("veyl.ui.panelWidth")).toBe("368");
  });

  it("拖拽存可见宽度加位移", () => {
    localStorage.setItem("veyl.ui.panelWidth", "400");
    const result = setup(1440);
    act(() => result.current.panelHandlers.onPointerDown(pointerEvent(500)));
    act(() => result.current.panelHandlers.onPointerMove(pointerEvent(490)));
    act(() => result.current.panelHandlers.onPointerUp());
    expect(localStorage.getItem("veyl.ui.panelWidth")).toBe("410");
  });

  it("压缩区间右栏拖拽松手不回弹：484 拖到 444 后保持", () => {
    localStorage.setItem("veyl.ui.panelWidth", "560");
    const result = setup(1200);
    act(() => result.current.panelHandlers.onPointerDown(pointerEvent(500)));
    act(() => result.current.panelHandlers.onPointerMove(pointerEvent(540)));
    expect(result.current.panel).toBe(444);
    act(() => result.current.panelHandlers.onPointerUp());
    expect(result.current.panel).toBe(444);
    expect(localStorage.getItem("veyl.ui.panelWidth")).toBe("444");
  });

  it("压缩区间左栏拖拽松手不回弹：264 拖到 228 后保持", () => {
    localStorage.setItem("veyl.ui.railWidth", "300");
    const result = setup(1100);
    act(() => result.current.railHandlers.onPointerDown(pointerEvent(500)));
    act(() => result.current.railHandlers.onPointerMove(pointerEvent(464)));
    expect(result.current.rail).toBe(228);
    act(() => result.current.railHandlers.onPointerUp());
    expect(result.current.rail).toBe(228);
    expect(localStorage.getItem("veyl.ui.railWidth")).toBe("228");
  });

  it("取消拖拽时释放 pointer capture", () => {
    const result = setup(1100);
    const target = makeTarget();
    act(() => result.current.railHandlers.onPointerDown(pointerEvent(500, target)));
    act(() => {
      fireEvent.keyDown(window, { key: "Escape" });
    });
    expect(target.releasePointerCapture).toHaveBeenCalledWith(1);
  });
});
