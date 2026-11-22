/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AiRequiredDialog } from "./AiRequiredDialog";

afterEach(cleanup);

function renderDialog(over: { open?: boolean } = {}) {
  const onConfigure = vi.fn();
  const onClose = vi.fn();
  render(
    <AiRequiredDialog
      open={over.open ?? true}
      onConfigure={onConfigure}
      onClose={onClose}
    />,
  );
  return { onConfigure, onClose };
}

describe("未配置 AI 的全局告警", () => {
  it("关闭时不渲染", () => {
    renderDialog({ open: false });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("渲染标题、正文与两个按钮，焦点落在告警内", () => {
    renderDialog();
    const dialog = screen.getByRole("dialog", { name: "还没有配置 AI 服务" });
    expect(dialog).toBeTruthy();
    expect(screen.getByText("配置后才能使用对话与智能操作。")).toBeTruthy();
    expect(dialog.contains(document.activeElement)).toBe(true);
    // trap 之后落到主按钮。
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "去配置" }),
    );
    // 必须压过设置弹层（z-index 70）和嵌套弹层（80）。
    expect(
      document.querySelector(".modal-backdrop")?.classList.contains(
        "modal-backdrop--top",
      ),
    ).toBe(true);
  });

  it("Tab 在告警内部循环", () => {
    renderDialog();
    const dialog = screen.getByRole("dialog", { name: "还没有配置 AI 服务" });
    const buttons = within(dialog).getAllByRole("button");
    const first = buttons[0];
    const last = buttons[buttons.length - 1];

    last.focus();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(document.activeElement).toBe(first);

    first.focus();
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(last);
  });

  it("取消关闭，不触发配置", () => {
    const { onClose, onConfigure } = renderDialog();
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onConfigure).not.toHaveBeenCalled();
  });

  it("Esc 关闭", () => {
    const { onClose, onConfigure } = renderDialog();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onConfigure).not.toHaveBeenCalled();
  });

  it("点遮罩关闭，点面板本身不关闭", () => {
    const { onClose } = renderDialog();
    fireEvent.mouseDown(screen.getByRole("dialog"));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.mouseDown(document.querySelector(".modal-backdrop") as Element);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("点主按钮去配置", () => {
    const { onConfigure, onClose } = renderDialog();
    fireEvent.click(screen.getByRole("button", { name: "去配置" }));
    expect(onConfigure).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
  });
});
