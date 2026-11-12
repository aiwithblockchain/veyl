/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HelperPermissionDialog } from "./HelperPermissionDialog";

afterEach(cleanup);

describe("HelperPermissionDialog", () => {
  it("关闭时不渲染", () => {
    render(
      <HelperPermissionDialog open={false} onClose={() => {}} onOpenSettings={async () => {}} />,
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("说明去哪允许后台助手，并且只有引导按钮", () => {
    render(<HelperPermissionDialog open onClose={vi.fn()} onOpenSettings={async () => {}} />);
    expect(screen.getByRole("dialog", { name: "需要允许后台助手" })).toBeTruthy();
    expect(screen.getByText(/系统设置 › 通用 › 登录项与扩展/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "取消" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "打开系统设置" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /重试/ })).toBeNull();
  });

  it("打开时焦点在「打开系统设置」", () => {
    render(<HelperPermissionDialog open onClose={vi.fn()} onOpenSettings={async () => {}} />);
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "打开系统设置" }),
    );
  });

  it("点打开系统设置：先调用后端，再关闭", async () => {
    const onOpenSettings = vi.fn(async () => undefined);
    const onClose = vi.fn();
    render(
      <HelperPermissionDialog open onClose={onClose} onOpenSettings={onOpenSettings} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "打开系统设置" }));
    await waitFor(() => expect(onOpenSettings).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it("打开失败时留在原地，并给出手动路径", async () => {
    const onClose = vi.fn();
    render(
      <HelperPermissionDialog
        open
        onClose={onClose}
        onOpenSettings={vi.fn(async () => {
          throw new Error("command not found");
        })}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "打开系统设置" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("手动打开");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("Esc 关闭", () => {
    const onClose = vi.fn();
    render(<HelperPermissionDialog open onClose={onClose} onOpenSettings={async () => {}} />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
