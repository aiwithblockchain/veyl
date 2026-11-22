/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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

  it("普通提问不再弹这个模态", () => {
    renderQuestion({
      ...confirmQuestion(),
      kind: null,
      upgradeConfirm: null,
      question: "你主要用它做什么？",
      options: ["浏览网页", "桌面软件"],
    });

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByText("需要你的确认")).toBeNull();
    expect(screen.queryByText("你主要用它做什么？")).toBeNull();
  });
});

function setModeQuestion(overrides: Partial<PendingQuestion> = {}): PendingQuestion {
  return {
    ...confirmQuestion(),
    kind: "config_set_mode_confirm",
    upgradeConfirm: null,
    configSetModeConfirm: {
      configId: "cfg_1",
      mode: "tun",
      previousMode: "system_proxy",
      willDisconnect: true,
    },
    options: ["切换", "取消"],
    ...overrides,
  };
}

describe("AskQuestionDialog：接管方式确认卡", () => {
  it("写目标方式与断开提示，不出现实现词", async () => {
    renderQuestion(setModeQuestion());

    expect(await screen.findByText("切换接管方式")).toBeTruthy();
    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toContain("全部软件");
    expect(dialog.textContent).toContain("会短暂断开当前连接");
    expect(dialog.textContent).not.toContain("tun");
    expect(dialog.textContent).not.toContain("system_proxy");
    expect(screen.getByRole("button", { name: "切换" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "取消" })).toBeTruthy();
  });

  it("本机代理用左栏词汇", async () => {
    renderQuestion(
      setModeQuestion({
        configSetModeConfirm: {
          configId: "cfg_1",
          mode: "system_proxy",
          previousMode: "tun",
          willDisconnect: true,
        },
      }),
    );

    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("本机代理");
  });

  it("默认焦点在取消，Esc 回传取消", async () => {
    const { onAnswer } = renderQuestion(setModeQuestion());
    const cancel = await screen.findByRole("button", { name: "取消" });
    expect(document.activeElement).toBe(cancel);

    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(onAnswer).toHaveBeenCalledWith("取消"));
  });

  it("点切换回传切换", async () => {
    const { onAnswer } = renderQuestion(setModeQuestion());
    fireEvent.click(await screen.findByRole("button", { name: "切换" }));
    await waitFor(() => expect(onAnswer).toHaveBeenCalledWith("切换"));
  });
});

function rotateQuestion(overrides: Partial<PendingQuestion> = {}): PendingQuestion {
  return {
    ...confirmQuestion(),
    kind: "node_rotate_confirm",
    upgradeConfirm: null,
    question: "重置这台服务器的节点端口与密码？",
    options: ["重置", "取消"],
    defaultIndex: 1,
    ...overrides,
  };
}

describe("AskQuestionDialog：节点端口重置确认卡", () => {
  it("走阻塞对话框，写标题与影响，按钮是重置 / 取消", async () => {
    renderQuestion(rotateQuestion());

    expect(await screen.findByText("重置节点端口与密码")).toBeTruthy();
    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toContain("重置会重启节点");
    expect(screen.getByRole("button", { name: "重置" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "取消" })).toBeTruthy();
  });

  it("default_index=1：默认焦点在取消", async () => {
    renderQuestion(rotateQuestion());
    const cancel = await screen.findByRole("button", { name: "取消" });
    await waitFor(() => expect(document.activeElement).toBe(cancel));
  });

  it("没给 default_index 也默认落在取消", async () => {
    renderQuestion(rotateQuestion({ defaultIndex: null }));
    const cancel = await screen.findByRole("button", { name: "取消" });
    await waitFor(() => expect(document.activeElement).toBe(cancel));
  });

  it("default_index=0 时焦点落在重置", async () => {
    renderQuestion(rotateQuestion({ defaultIndex: 0 }));
    const reset = await screen.findByRole("button", { name: "重置" });
    await waitFor(() => expect(document.activeElement).toBe(reset));
  });

  it("Esc 按取消选项原文回传", async () => {
    const { onAnswer } = renderQuestion(
      rotateQuestion({ options: ["确认重置", "暂不重置"] }),
    );
    await screen.findByText("重置节点端口与密码");

    fireEvent.keyDown(window, { key: "Escape" });

    await waitFor(() => expect(onAnswer).toHaveBeenCalledWith("暂不重置"));
  });

  it("点重置回传重置选项原文", async () => {
    const { onAnswer } = renderQuestion(
      rotateQuestion({ options: ["确认重置", "暂不重置"] }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "重置" }));

    await waitFor(() => expect(onAnswer).toHaveBeenCalledWith("确认重置"));
  });
});

function issueSubmitQuestion(
  overrides: Partial<PendingQuestion> = {},
): PendingQuestion {
  return {
    ...confirmQuestion(),
    kind: "issue_submit_confirm",
    upgradeConfirm: null,
    question: "要把这个问题发到问题墙吗？",
    options: ["上报", "取消"],
    defaultIndex: 1,
    issueSubmitConfirm: {
      title: "重置端口超时",
      summary: "连通正常，重置时没有返回。",
      expected: "自动重连并恢复",
      actual: "停在正在重置",
      repro: "连续两次触发",
      platform: "macos",
      appVersion: "1.0.0",
      steps: [
        {
          step: "rotate",
          ok: false,
          durationMs: 90000,
          reason: "agent_timeout",
        },
      ],
    },
    ...overrides,
  };
}

describe("AskQuestionDialog：问题墙上报确认卡", () => {
  it("展示标题、四段正文、平台版本与步骤，不出现原始 JSON", async () => {
    renderQuestion(issueSubmitQuestion());

    expect(await screen.findByText("发到问题墙")).toBeTruthy();
    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toContain("重置端口超时");
    expect(dialog.textContent).toContain("连通正常，重置时没有返回。");
    expect(dialog.textContent).toContain("自动重连并恢复");
    expect(dialog.textContent).toContain("停在正在重置");
    expect(dialog.textContent).toContain("连续两次触发");
    expect(dialog.textContent).toContain("macOS · 1.0.0");
    expect(dialog.textContent).toContain("重置端口 · 未通过 · 90.0 秒");
    expect(dialog.textContent).not.toContain("agent_timeout");
    expect(dialog.textContent).toContain("会上报版本、平台、诊断步骤");
    expect(dialog.textContent).not.toContain('"steps"');
    expect(screen.getByRole("button", { name: "上报" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "取消" })).toBeTruthy();
  });

  it("Host 把默认焦点指向确认时，仍然落在取消", async () => {
    renderQuestion(issueSubmitQuestion({ defaultIndex: 0 }));
    const cancel = await screen.findByRole("button", { name: "取消" });
    await waitFor(() => expect(document.activeElement).toBe(cancel));
  });

  it("Esc 按取消选项原文回传", async () => {
    const { onAnswer } = renderQuestion(issueSubmitQuestion());
    await screen.findByText("发到问题墙");

    fireEvent.keyDown(window, { key: "Escape" });

    await waitFor(() => expect(onAnswer).toHaveBeenCalledWith("取消"));
  });

  it("点上报回传上报选项原文", async () => {
    const { onAnswer } = renderQuestion(issueSubmitQuestion());
    fireEvent.click(await screen.findByRole("button", { name: "上报" }));

    await waitFor(() => expect(onAnswer).toHaveBeenCalledWith("上报"));
  });
});
