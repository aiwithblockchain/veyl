/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PendingQuestion } from "../agent/bridge";
import { AskQuestionCard } from "./AskQuestionCard";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

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

describe("AskQuestionCard", () => {
  it("内联展示问题、选项与倒计时，不是模态", () => {
    render(
      <AskQuestionCard question={question()} onAnswer={vi.fn(async () => {})} onExpire={() => {}} />,
    );

    expect(screen.getByText("你主要用它做什么？")).toBeTruthy();
    expect(screen.getByRole("button", { name: "浏览网页" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "桌面软件" })).toBeTruthy();
    expect(screen.getByText("剩 5:00")).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("点选项按选项原文回答", async () => {
    const onAnswer = vi.fn(async () => {});
    render(<AskQuestionCard question={question()} onAnswer={onAnswer} onExpire={() => {}} />);

    fireEvent.click(screen.getByRole("button", { name: "桌面软件" }));

    await waitFor(() => expect(onAnswer).toHaveBeenCalledWith("桌面软件"));
  });

  it("倒计时每秒递减，到点只触发一次超时收起", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-07T00:00:00Z"));
    const onExpire = vi.fn();
    render(
      <AskQuestionCard
        question={question({ expiresAt: Date.now() + 3_000 })}
        onAnswer={vi.fn(async () => {})}
        onExpire={onExpire}
      />,
    );

    expect(screen.getByText("剩 0:03")).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(screen.getByText("剩 0:02")).toBeTruthy();

    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    expect(onExpire).toHaveBeenCalledTimes(1);
  });

  it("回答失败时在卡片里说明，选项仍可再点", async () => {
    const onAnswer = vi.fn(async () => {
      throw { code: "INTERNAL", message: "回答没送到" };
    });
    render(<AskQuestionCard question={question()} onAnswer={onAnswer} onExpire={() => {}} />);

    fireEvent.click(screen.getByRole("button", { name: "浏览网页" }));

    await waitFor(() => expect(screen.getByText("回答没送到")).toBeTruthy());
    expect(
      (screen.getByRole("button", { name: "浏览网页" }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it("提交中禁用选项，避免重复回答", () => {
    const onAnswer = vi.fn(() => new Promise<void>(() => {}));
    render(<AskQuestionCard question={question()} onAnswer={onAnswer} onExpire={() => {}} />);

    fireEvent.click(screen.getByRole("button", { name: "浏览网页" }));

    expect(onAnswer).toHaveBeenCalledTimes(1);
    expect(
      (screen.getByRole("button", { name: "浏览网页" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("没有选项时提示直接在下面说", () => {
    render(
      <AskQuestionCard
        question={question({ options: [] })}
        onAnswer={vi.fn(async () => {})}
        onExpire={() => {}}
      />,
    );

    expect(screen.getByText("直接在下面说你的想法。")).toBeTruthy();
  });

  it("跳过回传空串，只结束这一问", async () => {
    const onAnswer = vi.fn(async () => {});
    render(<AskQuestionCard question={question()} onAnswer={onAnswer} onExpire={() => {}} />);

    fireEvent.click(screen.getByRole("button", { name: "跳过" }));

    await waitFor(() => expect(onAnswer).toHaveBeenCalledWith(""));
  });
});
