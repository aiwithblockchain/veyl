/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PaneHandle } from "../components/PaneHandle";
import { ASSISTANT_MIN, ASSISTANT_WIDTH_KEY, RAIL_MIN, RAIL_WIDTH_KEY } from "./layout";
import { usePaneLayout } from "./usePaneLayout";

function Harness({ width = 1568 }: { width?: number }) {
  const panes = usePaneLayout({
    windowWidth: width,
    mode: "wide",
    docked: true,
    panelOpen: true,
  });
  return (
    <div>
      <span data-testid="rail-width">{panes.rail}</span>
      <span data-testid="assistant-width">{panes.assistant}</span>
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
        side="assistant"
        label="调整 AI 对话宽度"
        controls="ai-panel"
        value={panes.assistant}
        min={ASSISTANT_MIN}
        max={panes.assistantMax}
        dragging={panes.draggingPane === "assistant"}
        {...panes.assistantHandlers}
      />
    </div>
  );
}

const railHandle = () => screen.getByRole("separator", { name: "调整配置列表宽度" });
const assistantHandle = () => screen.getByRole("separator", { name: "调整 AI 对话宽度" });

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  Element.prototype.setPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();
  Element.prototype.hasPointerCapture = vi.fn(() => true);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
  delete document.body.dataset.resizing;
});

describe("PaneHandle 事件接线", () => {
  it("拖配置栏：指针捕获、宽度变化、松手持久化", () => {
    render(<Harness />);
    const handle = railHandle();
    expect(screen.getByTestId("rail-width").textContent).toBe("280");
    expect(handle.getAttribute("aria-valuemax")).toBe("360");

    fireEvent.pointerDown(handle, { button: 0, pointerId: 1, clientX: 300 });
    expect(Element.prototype.setPointerCapture).toHaveBeenCalledWith(1);
    expect(document.body.dataset.resizing).toBe("true");

    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 340 });
    expect(screen.getByTestId("rail-width").textContent).toBe("320");
    expect(handle.getAttribute("aria-valuenow")).toBe("320");

    fireEvent.pointerUp(handle, { pointerId: 1, clientX: 340 });
    expect(localStorage.getItem(RAIL_WIDTH_KEY)).toBe("320");
    expect(document.body.dataset.resizing).toBeUndefined();
  });

  it("拖助手：向左变宽，松手持久化", () => {
    render(<Harness />);
    const handle = assistantHandle();
    expect(screen.getByTestId("assistant-width").textContent).toBe("420");

    fireEvent.pointerDown(handle, { button: 0, pointerId: 2, clientX: 1200 });
    fireEvent.pointerMove(handle, { pointerId: 2, clientX: 1100 });
    expect(screen.getByTestId("assistant-width").textContent).toBe("520");
    fireEvent.pointerUp(handle, { pointerId: 2, clientX: 1100 });
    expect(localStorage.getItem(ASSISTANT_WIDTH_KEY)).toBe("520");
  });

  it("拖到边界外按最小/最大钳制", () => {
    render(<Harness />);
    const handle = assistantHandle();

    fireEvent.pointerDown(handle, { button: 0, pointerId: 3, clientX: 1200 });
    fireEvent.pointerMove(handle, { pointerId: 3, clientX: -2000 });
    expect(screen.getByTestId("assistant-width").textContent).toBe("640");
    fireEvent.pointerUp(handle, { pointerId: 3, clientX: -2000 });

    fireEvent.pointerDown(handle, { button: 0, pointerId: 4, clientX: 1200 });
    fireEvent.pointerMove(handle, { pointerId: 4, clientX: 5000 });
    expect(screen.getByTestId("assistant-width").textContent).toBe("320");
  });

  it("没有移动的单击不写存储", () => {
    render(<Harness />);
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const handle = railHandle();

    fireEvent.pointerDown(handle, { button: 0, pointerId: 5, clientX: 300 });
    fireEvent.pointerUp(handle, { pointerId: 5, clientX: 300 });

    expect(screen.getByTestId("rail-width").textContent).toBe("280");
    expect(setItem).not.toHaveBeenCalledWith(RAIL_WIDTH_KEY, expect.anything());
  });

  it("Esc 取消这次拖拽，不写存储", () => {
    render(<Harness />);
    const handle = railHandle();

    fireEvent.pointerDown(handle, { button: 0, pointerId: 6, clientX: 300 });
    fireEvent.pointerMove(handle, { pointerId: 6, clientX: 340 });
    expect(screen.getByTestId("rail-width").textContent).toBe("320");

    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(screen.getByTestId("rail-width").textContent).toBe("280");
    expect(localStorage.getItem(RAIL_WIDTH_KEY)).toBeNull();
  });

  it("pointercancel 取消拖拽，不写存储", () => {
    render(<Harness />);
    const handle = railHandle();

    fireEvent.pointerDown(handle, { button: 0, pointerId: 7, clientX: 300 });
    fireEvent.pointerMove(handle, { pointerId: 7, clientX: 340 });
    fireEvent.pointerCancel(handle, { pointerId: 7 });

    expect(screen.getByTestId("rail-width").textContent).toBe("280");
    expect(localStorage.getItem(RAIL_WIDTH_KEY)).toBeNull();
    expect(document.body.dataset.resizing).toBeUndefined();
  });

  it("拖拽中窗口变化会取消这次拖拽", () => {
    const view = render(<Harness />);
    const handle = railHandle();

    fireEvent.pointerDown(handle, { button: 0, pointerId: 8, clientX: 300 });
    fireEvent.pointerMove(handle, { pointerId: 8, clientX: 340 });
    expect(screen.getByTestId("rail-width").textContent).toBe("320");

    view.rerender(<Harness width={1300} />);
    // 1300 断点的默认配置栏是 260；拖拽被取消，宽度回到布局值。
    expect(screen.getByTestId("rail-width").textContent).toBe("260");
    expect(localStorage.getItem(RAIL_WIDTH_KEY)).toBeNull();
  });

  it("双击复位到断点默认宽度并持久化", () => {
    localStorage.setItem(RAIL_WIDTH_KEY, "340");
    render(<Harness />);
    const handle = railHandle();
    expect(screen.getByTestId("rail-width").textContent).toBe("340");

    fireEvent.doubleClick(handle);
    expect(screen.getByTestId("rail-width").textContent).toBe("280");
    expect(localStorage.getItem(RAIL_WIDTH_KEY)).toBe("280");
  });

  it("丢失指针捕获按完成处理并持久化", () => {
    render(<Harness />);
    const handle = railHandle();

    fireEvent.pointerDown(handle, { button: 0, pointerId: 9, clientX: 300 });
    fireEvent.pointerMove(handle, { pointerId: 9, clientX: 340 });
    fireEvent(handle, new Event("lostpointercapture", { bubbles: true }));

    expect(screen.getByTestId("rail-width").textContent).toBe("320");
    expect(localStorage.getItem(RAIL_WIDTH_KEY)).toBe("320");
  });

  it("键盘调整同步更新 aria-valuenow", () => {
    render(<Harness />);
    const handle = railHandle();
    fireEvent.keyDown(handle, { key: "ArrowRight" });
    expect(screen.getByTestId("rail-width").textContent).toBe("296");
    expect(handle.getAttribute("aria-valuenow")).toBe("296");

    fireEvent.keyDown(handle, { key: "Home" });
    expect(handle.getAttribute("aria-valuenow")).toBe("220");
    fireEvent.keyDown(handle, { key: "End" });
    expect(handle.getAttribute("aria-valuenow")).toBe("360");
  });
});
