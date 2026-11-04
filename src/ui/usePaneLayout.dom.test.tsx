/** @vitest-environment jsdom */
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PaneHandle } from "../components/PaneHandle";
import { PANEL_MIN, RAIL_MIN } from "./layout";
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

function Harness() {
  const appRef = useRef<HTMLDivElement>(null);
  const panes = usePaneLayout({ appRef, panelOpen: true, active: true });
  return (
    <div ref={appRef}>
      <span data-testid="rail-width">{panes.rail}</span>
      <span data-testid="panel-width">{panes.panel}</span>
      <PaneHandle
        side="rail"
        label="调整配置列表宽度"
        controls="config-rail"
        value={panes.rail}
        min={RAIL_MIN}
        max={panes.railMax}
        dragging={panes.draggingPane === "rail"}
        {...panes.railHandlers}
      />
      <PaneHandle
        side="panel"
        label="调整 AI 对话宽度"
        controls="ai-panel"
        value={panes.panel}
        min={PANEL_MIN}
        max={panes.panelMax}
        dragging={panes.draggingPane === "panel"}
        {...panes.panelHandlers}
      />
    </div>
  );
}

function renderHarness(width: number) {
  render(<Harness />);
  const observer = MockResizeObserver.instances[MockResizeObserver.instances.length - 1];
  act(() => observer.emit(width));
}

function panelHandle() {
  return screen.getByRole("separator", { name: "调整 AI 对话宽度" });
}

beforeEach(() => {
  MockResizeObserver.instances = [];
  vi.stubGlobal("ResizeObserver", MockResizeObserver);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  Element.prototype.setPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();
  Element.prototype.hasPointerCapture = vi.fn(() => true);
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
  document.body.innerHTML = "";
  delete document.body.dataset.resizing;
});

describe("PaneHandle 事件接线", () => {
  it("真实手柄：pointerdown → pointermove → pointerup 改变宽度、捕获指针并持久化", () => {
    localStorage.setItem("veyl.ui.panelWidth", "560");
    renderHarness(1200);
    const handle = panelHandle();
    expect(screen.getByTestId("panel-width").textContent).toBe("484");
    expect(handle.getAttribute("aria-valuenow")).toBe("484");
    expect(handle.getAttribute("aria-valuemax")).toBe("484");

    fireEvent.pointerDown(handle, { button: 0, pointerId: 1, clientX: 500 });
    expect(Element.prototype.setPointerCapture).toHaveBeenCalledWith(1);
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 540 });
    expect(screen.getByTestId("panel-width").textContent).toBe("444");
    expect(handle.getAttribute("aria-valuenow")).toBe("444");

    fireEvent.pointerUp(handle, { pointerId: 1, clientX: 540 });
    expect(screen.getByTestId("panel-width").textContent).toBe("444");
    expect(localStorage.getItem("veyl.ui.panelWidth")).toBe("444");
  });

  it("真实手柄：pointerdown → pointerup 无移动不写存储", () => {
    localStorage.setItem("veyl.ui.panelWidth", "400");
    renderHarness(1100);
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const handle = panelHandle();

    fireEvent.pointerDown(handle, { button: 0, pointerId: 1, clientX: 500 });
    fireEvent.pointerUp(handle, { pointerId: 1, clientX: 500 });

    expect(screen.getByTestId("panel-width").textContent).toBe("384");
    expect(setItem).not.toHaveBeenCalled();
  });

  it("真实手柄：pointerdown → Esc 回到按下宽度且不写存储", () => {
    localStorage.setItem("veyl.ui.panelWidth", "560");
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    renderHarness(1200);
    const handle = panelHandle();
    expect(screen.getByTestId("panel-width").textContent).toBe("484");

    fireEvent.pointerDown(handle, { button: 0, pointerId: 1, clientX: 500 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 540 });
    expect(screen.getByTestId("panel-width").textContent).toBe("444");

    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.getByTestId("panel-width").textContent).toBe("484");
    expect(Element.prototype.releasePointerCapture).toHaveBeenCalledWith(1);
    expect(setItem).not.toHaveBeenCalled();
  });
});
