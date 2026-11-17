/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QuitDialog } from "./QuitDialog";

afterEach(cleanup);

describe("退出确认弹窗", () => {
  it("已连接：标题与两行「按钮名 + 结果」，默认焦点在后台运行", () => {
    render(
      <QuitDialog busy={false} error={null} connected onDecision={() => {}} />,
    );

    expect(screen.getByText("退出 Veyl？")).toBeTruthy();
    const desc = document.getElementById("quit-dialog-desc") as HTMLElement;
    expect(within(desc).getByText("后台运行")).toBeTruthy();
    expect(within(desc).getByText("保持连接")).toBeTruthy();
    expect(within(desc).getByText("退出")).toBeTruthy();
    expect(within(desc).getByText("断开连接并恢复网络设置")).toBeTruthy();
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "后台运行" }),
    );
  });

  it("未连接：换成 留在菜单栏 / 关闭 Veyl，两个选项都可用", () => {
    const onDecision = vi.fn();
    render(
      <QuitDialog
        busy={false}
        error={null}
        connected={false}
        onDecision={onDecision}
      />,
    );

    const desc = document.getElementById("quit-dialog-desc") as HTMLElement;
    expect(within(desc).getByText("留在菜单栏")).toBeTruthy();
    expect(within(desc).getByText("关闭 Veyl")).toBeTruthy();
    expect(within(desc).queryByText("保持连接")).toBeNull();
    expect(within(desc).queryByText("断开连接并恢复网络设置")).toBeNull();

    const quit = screen.getByRole("button", { name: "退出" });
    const background = screen.getByRole("button", { name: "后台运行" });
    expect((quit as HTMLButtonElement).disabled).toBe(false);
    expect((background as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(quit);
    expect(onDecision).toHaveBeenLastCalledWith("quit");
    fireEvent.click(background);
    expect(onDecision).toHaveBeenLastCalledWith("background");
  });

  it("是 alertdialog，并用 aria-describedby 指向两句后果", () => {
    render(
      <QuitDialog busy={false} error={null} connected onDecision={() => {}} />,
    );

    const dialog = screen.getByRole("alertdialog");
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(dialog.getAttribute("aria-labelledby")).toBe("quit-dialog-title");
    const describedBy = dialog.getAttribute("aria-describedby");
    expect(describedBy).toBe("quit-dialog-desc");
    const desc = document.getElementById(describedBy as string);
    expect(desc).toBe(dialog.querySelector(".quit-dialog__body"));
    expect(desc?.textContent).toContain("保持连接");
    expect(desc?.textContent).toContain("断开连接并恢复网络设置");
  });

  it("退出按钮：已连接是描边危险按钮，未连接是普通描边；都排在左", () => {
    const { rerender } = render(
      <QuitDialog busy={false} error={null} connected onDecision={() => {}} />,
    );
    let quit = screen.getByRole("button", { name: "退出" });
    expect(quit.className).toContain("btn--danger-ghost");

    rerender(
      <QuitDialog
        busy={false}
        error={null}
        connected={false}
        onDecision={() => {}}
      />,
    );
    quit = screen.getByRole("button", { name: "退出" });
    expect(quit.className).toContain("btn--ghost");
    expect(quit.className).not.toContain("btn--danger-ghost");

    const background = screen.getByRole("button", { name: "后台运行" });
    expect(background.className).toContain("btn--primary");
    expect(quit.className).toContain("quit-dialog__btn");
    expect(background.className).toContain("quit-dialog__btn");
    expect(quit.compareDocumentPosition(background)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });

  it("Esc、×、点遮罩都按后台运行回传", () => {
    const onDecision = vi.fn();
    const { container } = render(
      <QuitDialog
        busy={false}
        error={null}
        connected
        onDecision={onDecision}
      />,
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
    render(
      <QuitDialog busy={false} error={null} connected onDecision={() => {}} />,
    );

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
      <QuitDialog
        busy={false}
        error="后台没有响应"
        connected
        onDecision={() => {}}
      />,
    );

    expect(screen.getByRole("alert").textContent).toBe("后台没有响应");
  });

  it("命令在途时按钮与取消入口都不可用", () => {
    const onDecision = vi.fn();
    render(
      <QuitDialog busy error={null} connected onDecision={onDecision} />,
    );

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
    expect(screen.getByRole("alertdialog").getAttribute("aria-busy")).toBe("true");
  });
});
