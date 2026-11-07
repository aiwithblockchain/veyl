/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PendingQuestion } from "../agent/bridge";
import type { Session } from "../state/chatStore";
import { ChatView } from "./ChatView";

afterEach(cleanup);

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: "s_1",
    title: "测试",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    messages: [{ id: "m1", role: "user", text: "帮我配一下", at: Date.now() }],
    toolCalls: {},
    status: { text: "正在回复", phase: "thinking" },
    activeRequestId: "r_1",
    requesting: false,
    historyLoaded: true,
    ...overrides,
  };
}

function question(overrides: Partial<PendingQuestion> = {}): PendingQuestion {
  return {
    questionId: "q_1",
    sessionId: "s_1",
    requestId: "r_1",
    question: "你主要用它做什么？",
    options: ["浏览网页", "桌面软件"],
    createdAt: Date.now(),
    expiresAt: Date.now() + 300_000,
    kind: null,
    upgradeConfirm: null,
    ...overrides,
  };
}

function textarea(): HTMLTextAreaElement {
  return screen.getByRole("textbox") as HTMLTextAreaElement;
}

describe("ChatView 的提问卡片", () => {
  it("普通提问渲染在消息流末尾，输入框保持可用", () => {
    render(
      <ChatView
        session={session()}
        question={question()}
        onSend={vi.fn()}
        onAnswerQuestion={vi.fn(async () => {})}
        onAnswerFromComposer={vi.fn()}
        onQuestionExpired={vi.fn()}
        onStop={vi.fn()}
        onNextAction={vi.fn()}
        hasKey
        onConfigureKey={vi.fn()}
      />,
    );

    expect(screen.getByText("你主要用它做什么？")).toBeTruthy();
    expect(
      screen.getAllByRole("button").some((button) => button.textContent === "发送"),
    ).toBe(true);
    expect(screen.queryByRole("button", { name: "等待回复" })).toBeNull();
    expect(textarea().disabled).toBe(false);
    expect(
      screen.getByText("回答上面的问题，也可以直接说你的想法"),
    ).toBeTruthy();
  });

  it("输入框发送交给回答路径，不走普通的 onSend", () => {
    const onSend = vi.fn();
    const onAnswerFromComposer = vi.fn(() => true);
    render(
      <ChatView
        session={session()}
        question={question()}
        onSend={onSend}
        onAnswerQuestion={vi.fn(async () => {})}
        onAnswerFromComposer={onAnswerFromComposer}
        onQuestionExpired={vi.fn()}
        onStop={vi.fn()}
        onNextAction={vi.fn()}
        hasKey
        onConfigureKey={vi.fn()}
      />,
    );

    fireEvent.change(textarea(), { target: { value: "桌面软件" } });
    fireEvent.keyDown(textarea(), { key: "Enter" });

    expect(onAnswerFromComposer).toHaveBeenCalledWith("桌面软件");
    expect(onSend).not.toHaveBeenCalled();
  });

  it("升级确认不渲染内联卡片，仍走居中模态", () => {
    render(
      <ChatView
        session={session()}
        question={question({ kind: "core_upgrade_confirm", question: "要更新吗？" })}
        onSend={vi.fn()}
        onAnswerQuestion={vi.fn(async () => {})}
        onAnswerFromComposer={vi.fn()}
        onQuestionExpired={vi.fn()}
        onStop={vi.fn()}
        onNextAction={vi.fn()}
        hasKey
        onConfigureKey={vi.fn()}
      />,
    );

    expect(screen.queryByText("要更新吗？")).toBeNull();
    expect(screen.getByRole("button", { name: "等待回复" })).toBeTruthy();
  });
});
