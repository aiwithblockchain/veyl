/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PendingQuestion } from "../agent/bridge";
import { AskQuestionDialog } from "./AskQuestionDialog";

afterEach(cleanup);

function confirmQuestion(overrides: Partial<PendingQuestion> = {}): PendingQuestion {
  return {
    questionId: "q_1",
    sessionId: "s_1",
    requestId: "r_1",
    question: "要更新后台运行库吗？",
    options: ["升级", "取消"],
    createdAt: Date.now(),
    expiresAt: Date.now() + 300_000,
    kind: "core_upgrade_confirm",
    upgradeConfirm: {
      currentVersion: "1.14.4",
      targetVersion: "1.15.0",
      size: 12 * 1024 * 1024,
      restartRequired: false,
    },
    ...overrides,
  };
}

function renderQuestion(
  question: PendingQuestion,
  onAnswer = vi.fn(async () => {}),
  connected = false,
) {
  render(
    <AskQuestionDialog
      question={question}
      onAnswer={onAnswer}
      onExpire={() => {}}
      connected={connected}
    />,
  );
  return { onAnswer };
}

describe("AskQuestionDialog：升级确认卡", () => {
  it("展示标题、四项信息与固定按钮", async () => {
    renderQuestion(confirmQuestion());

    expect(await screen.findByText("更新后台运行库")).toBeTruthy();
    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toContain("当前 1.14.4 → 目标 1.15.0");
    expect(dialog.textContent).toContain("12 MB");
    expect(dialog.textContent).toContain("官方更新");
    expect(dialog.textContent).toContain("下次连接时生效");
    expect(screen.getByRole("button", { name: "升级" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "取消" })).toBeTruthy();
  });

  it("默认焦点在取消", async () => {
    renderQuestion(confirmQuestion());
    const cancel = await screen.findByRole("button", { name: "取消" });
    expect(document.activeElement).toBe(cancel);
  });

  it("Esc 按取消选项原文回传", async () => {
    const { onAnswer } = renderQuestion(
      confirmQuestion({ options: ["现在升级", "先不升级"] }),
    );
    await screen.findByText("更新后台运行库");

    fireEvent.keyDown(window, { key: "Escape" });

    await waitFor(() => expect(onAnswer).toHaveBeenCalledWith("先不升级"));
  });

  it("点升级回传升级选项原文", async () => {
    const { onAnswer } = renderQuestion(
      confirmQuestion({ options: ["现在升级", "先不升级"] }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "升级" }));

    await waitFor(() => expect(onAnswer).toHaveBeenCalledWith("现在升级"));
  });

  it("大小缺失显示大小未知，restart_required 为 true 时提示重启 Veyl", async () => {
    renderQuestion(
      confirmQuestion({
        upgradeConfirm: {
          currentVersion: "1.14.4",
          targetVersion: "1.15.0",
          size: null,
          restartRequired: true,
        },
      }),
    );

    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("大小未知");
    expect(dialog.textContent).toContain("重启 Veyl 后生效");
  });

  it("有连接时提示断开并重新连接", async () => {
    renderQuestion(confirmQuestion(), vi.fn(async () => {}), true);
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("断开并重新连接后生效");
    expect(dialog.textContent).not.toContain("重启 Veyl 后生效");
  });

  it("普通提问保持原样，跳过回传空串", async () => {
    const { onAnswer } = renderQuestion({
      ...confirmQuestion(),
      kind: null,
      upgradeConfirm: null,
      question: "你主要用它做什么？",
      options: ["浏览网页", "桌面软件"],
    });

    expect(await screen.findByText("需要你的确认")).toBeTruthy();
    expect(screen.queryByText("更新后台运行库")).toBeNull();

    await act(async () => {
      fireEvent.keyDown(window, { key: "Escape" });
    });
    await waitFor(() => expect(onAnswer).toHaveBeenCalledWith(""));
  });
});
