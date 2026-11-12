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

  it("有选项时有「解释这个设置的含义」入口", () => {
    render(
      <AskQuestionCard question={question()} onAnswer={vi.fn(async () => {})} onExpire={() => {}} />,
    );

    expect(screen.getByRole("button", { name: "解释这个设置的含义" })).toBeTruthy();
  });

  it("没有选项时不出现解释入口", () => {
    render(
      <AskQuestionCard
        question={question({ options: [] })}
        onAnswer={vi.fn(async () => {})}
        onExpire={() => {}}
      />,
    );

    expect(screen.queryByRole("button", { name: "解释这个设置的含义" })).toBeNull();
  });

  it("选项里只有解释文案时按无选项处理", () => {
    render(
      <AskQuestionCard
        question={question({ options: ["解释这个设置的含义"] })}
        onAnswer={vi.fn(async () => {})}
        onExpire={() => {}}
      />,
    );

    expect(screen.getByText("直接在下面说你的想法。")).toBeTruthy();
    expect(document.querySelector(".ask-card__explain")).toBeNull();
    expect(document.querySelector(".ask-card__option")).toBeNull();
  });

  it("确认卡不出现解释入口，选项照常渲染", () => {
    render(
      <AskQuestionCard
        question={question({ options: ["创建", "取消"] })}
        onAnswer={vi.fn(async () => {})}
        onExpire={() => {}}
      />,
    );

    expect(screen.queryByRole("button", { name: "解释这个设置的含义" })).toBeNull();
    expect(screen.getByRole("button", { name: "创建" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "取消" })).toBeTruthy();
  });

  it("「关闭」类确认卡同样不出现解释入口", () => {
    render(
      <AskQuestionCard
        question={question({ options: ["升级", "关闭"] })}
        onAnswer={vi.fn(async () => {})}
        onExpire={() => {}}
      />,
    );

    expect(screen.queryByRole("button", { name: "解释这个设置的含义" })).toBeNull();
    expect(screen.getByRole("button", { name: "升级" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "关闭" })).toBeTruthy();
  });

  it("普通两选项设置卡仍有解释入口", () => {
    render(
      <AskQuestionCard
        question={question({ options: ["浏览器上网页", "桌面软件也要用"] })}
        onAnswer={vi.fn(async () => {})}
        onExpire={() => {}}
      />,
    );

    expect(screen.getByRole("button", { name: "解释这个设置的含义" })).toBeTruthy();
  });

  it("尾随空格的解释文案同样被过滤", () => {
    render(
      <AskQuestionCard
        question={question({ options: ["解释这个设置的含义 "] })}
        onAnswer={vi.fn(async () => {})}
        onExpire={() => {}}
      />,
    );

    expect(screen.getByText("直接在下面说你的想法。")).toBeTruthy();
    expect(document.querySelector(".ask-card__explain")).toBeNull();
    expect(document.querySelector(".ask-card__option")).toBeNull();
  });

  it("点解释说逐字回传约定值", async () => {
    const onAnswer = vi.fn(async () => {});
    render(<AskQuestionCard question={question()} onAnswer={onAnswer} onExpire={() => {}} />);

    fireEvent.click(screen.getByRole("button", { name: "解释这个设置的含义" }));

    await waitFor(() => expect(onAnswer).toHaveBeenCalledWith("解释这个设置的含义"));
  });

  it("submitting 期间解释行不可点", () => {
    const onAnswer = vi.fn(() => new Promise<void>(() => {}));
    render(<AskQuestionCard question={question()} onAnswer={onAnswer} onExpire={() => {}} />);

    fireEvent.click(screen.getByRole("button", { name: "解释这个设置的含义" }));

    expect(onAnswer).toHaveBeenCalledTimes(1);
    expect(
      (screen.getByRole("button", { name: "解释这个设置的含义" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("换下一题后解释行恢复可用", () => {
    const onAnswer = vi.fn(() => new Promise<void>(() => {}));
    const { rerender } = render(
      <AskQuestionCard question={question()} onAnswer={onAnswer} onExpire={() => {}} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "解释这个设置的含义" }));
    const explain = screen.getByRole("button", { name: "解释这个设置的含义" });
    expect((explain as HTMLButtonElement).disabled).toBe(true);

    rerender(
      <AskQuestionCard
        question={question({ questionId: "q_2" })}
        onAnswer={onAnswer}
        onExpire={() => {}}
      />,
    );

    expect(
      (screen.getByRole("button", { name: "解释这个设置的含义" }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it("解释行在选项容器之外", () => {
    render(
      <AskQuestionCard question={question()} onAnswer={vi.fn(async () => {})} onExpire={() => {}} />,
    );

    expect(
      screen.getByRole("button", { name: "解释这个设置的含义" }).closest(".ask-card__options"),
    ).toBeNull();
  });

  it("模型把解释文案写进选项时只留一个，选项区不含它", () => {
    const onAnswer = vi.fn(async () => {});
    render(
      <AskQuestionCard
        question={question({ options: ["浏览网页", "解释这个设置的含义", "桌面软件"] })}
        onAnswer={onAnswer}
        onExpire={() => {}}
      />,
    );

    expect(
      screen.getAllByRole("button", { name: "解释这个设置的含义" }),
    ).toHaveLength(1);
    const optionLabels = Array.from(
      document.querySelectorAll(".ask-card__options .ask-card__option"),
    ).map((option) => option.textContent);
    expect(optionLabels).toEqual(["浏览网页", "桌面软件"]);
  });

  it("跳过回传空串，只结束这一问", async () => {
    const onAnswer = vi.fn(async () => {});
    render(<AskQuestionCard question={question()} onAnswer={onAnswer} onExpire={() => {}} />);

    fireEvent.click(screen.getByRole("button", { name: "跳过" }));

    await waitFor(() => expect(onAnswer).toHaveBeenCalledWith(""));
  });
});
