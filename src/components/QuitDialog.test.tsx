/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QuitDialog } from "./QuitDialog";

afterEach(cleanup);

describe("退出确认弹窗", () => {
  it("显示标题与两行说明，默认焦点在后台运行", () => {
    render(<QuitDialog busy={false} error={null} onDecision={() => {}} />);

    expect(screen.getByText("退出 Veyl？")).toBeTruthy();
    expect(screen.getByText("后台运行会保持连接。")).toBeTruthy();
    expect(screen.getByText("退出会断开连接并恢复网络设置。")).toBeTruthy();
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "后台运行" }),
    );
  });

  it("两个按钮分别回传 background / quit", () => {
    const onDecision = vi.fn();
    render(<QuitDialog busy={false} error={null} onDecision={onDecision} />);

    fireEvent.click(screen.getByRole("button", { name: "后台运行" }));
    expect(onDecision).toHaveBeenLastCalledWith("background");

    fireEvent.click(screen.getByRole("button", { name: "退出" }));
    expect(onDecision).toHaveBeenLastCalledWith("quit");
  });

  it("Esc、×、点遮罩都按后台运行回传", () => {
    const onDecision = vi.fn();
    const { container } = render(
      <QuitDialog busy={false} error={null} onDecision={onDecision} />,
    );

    fireEvent.keyDown(window, { key: "Escape" });
    expect(onDecision).toHaveBeenLastCalledWith("background");

    fireEvent.click(screen.getByRole("button", { name: "关闭" }));
    expect(onDecision).toHaveBeenLastCalledWith("background");

    fireEvent.mouseDown(container.querySelector(".quit-backdrop") as HTMLElement);
    expect(onDecision).toHaveBeenLastCalledWith("background");
    expect(onDecision).toHaveBeenCalledTimes(3);
  });

  it("Tab 在弹窗内循环，不逃出去", () => {
    render(<QuitDialog busy={false} error={null} onDecision={() => {}} />);

    const close = screen.getByRole("button", { name: "关闭" });
    const primary = screen.getByRole("button", { name: "后台运行" });
    expect(document.activeElement).toBe(primary);

    fireEvent.keyDown(document, { key: "Tab" });
    expect(document.activeElement).toBe(close);

    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(primary);
  });

  it("失败时在弹窗内显示错误", () => {
    render(
      <QuitDialog busy={false} error="后台没有响应" onDecision={() => {}} />,
    );

    expect(screen.getByRole("alert").textContent).toBe("后台没有响应");
  });

  it("命令在途时按钮与取消入口都不可用", () => {
    const onDecision = vi.fn();
    render(<QuitDialog busy error={null} onDecision={onDecision} />);

    fireEvent.click(screen.getByRole("button", { name: "退出" }));
    fireEvent.click(screen.getByRole("button", { name: "后台运行" }));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onDecision).not.toHaveBeenCalled();

    expect(
      (screen.getByRole("button", { name: "关闭" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (screen.getByRole("button", { name: "退出" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});
