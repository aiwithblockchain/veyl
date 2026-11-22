/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NodeRepairDialog } from "./NodeRepairDialog";

afterEach(cleanup);

function renderDialog(onConfirm = vi.fn(), onCancel = vi.fn()) {
  render(
    <NodeRepairDialog
      nodeName="悉尼0.2u"
      onCancel={onCancel}
      onConfirm={onConfirm}
    />,
  );
  return { onConfirm, onCancel };
}

describe("连接页智能修复确认", () => {
  it("380 宽 alertdialog：复用详情页文案，默认焦点在取消", async () => {
    renderDialog();

    const dialog = screen.getByRole("alertdialog");
    expect(dialog.classList.contains("quit-dialog--repair")).toBe(true);
    expect(dialog.getAttribute("aria-label")).toBe("对悉尼0.2u执行智能修复");
    expect(dialog.textContent).toContain("节点会重启一次");
    const cancel = screen.getByRole("button", { name: "取消" });
    await waitFor(() => expect(document.activeElement).toBe(cancel));
    expect(screen.getByRole("button", { name: "智能修复" })).toBeTruthy();
  });

  it("Esc 与点背景都按取消处理", () => {
    const { onCancel, onConfirm } = renderDialog();

    fireEvent.keyDown(window, { key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();

    fireEvent.mouseDown(document.querySelector(".quit-backdrop") as HTMLElement);
    expect(onCancel).toHaveBeenCalledTimes(2);
  });

  it("确认修复只调用 onConfirm", () => {
    const { onCancel, onConfirm } = renderDialog();

    fireEvent.click(screen.getByRole("button", { name: "智能修复" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
  });
});

describe("先更新配置", () => {
  it("给了 onSync 才出现次按钮，点击只调用 onSync", () => {
    const onSync = vi.fn();
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(
      <NodeRepairDialog
        nodeName="悉尼0.2u"
        onCancel={onCancel}
        onConfirm={onConfirm}
        onSync={onSync}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "先更新配置" }));
    expect(onSync).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("没给 onSync 时不渲染这个次按钮", () => {
    renderDialog();
    expect(screen.queryByRole("button", { name: "先更新配置" })).toBeNull();
  });
});
