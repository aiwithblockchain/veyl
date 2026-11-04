import { describe, expect, it, vi } from "vitest";
import { activeSession, chatReducer, createInitialState, createSession } from "../state/chatStore";
import {
  isZeroConfigAskSuppressed,
  lastAssistantTextOf,
  runZeroConfigPrimaryAction,
  shouldResetJustOnboarded,
  shouldSendZeroConfigAsk,
  shouldSettleZeroConfig,
  zeroConfigActions,
  zeroConfigContent,
  zeroConfigMode,
} from "./consoleActions";

describe("零配置入口", () => {
  it("A：刚配好 AI 时只有「我自己配置」", () => {
    expect(zeroConfigMode(true, true)).toBe("just-onboarded");
    expect(zeroConfigActions("just-onboarded")).toEqual(["new-config"]);
  });

  it("B：已配 AI、非刚引导时有「让 AI 帮我配」和「我自己配置」", () => {
    expect(zeroConfigMode(true, false)).toBe("ai-ready");
    expect(zeroConfigActions("ai-ready")).toEqual(["ask-ai", "new-config"]);
  });

  it("C：未配 AI 时只有「我自己配置」，文案不提 AI", () => {
    expect(zeroConfigMode(false, false)).toBe("manual");
    expect(zeroConfigMode(false, true)).toBe("manual");
    expect(zeroConfigActions("manual")).toEqual(["new-config"]);

    const content = zeroConfigContent("manual");
    const text = [
      content.title,
      content.body ?? "",
      ...(content.steps ?? []),
    ].join(" ");
    expect(text).not.toMatch(/AI/i);
  });

  it("A 没有主按钮动作，B 走让 AI 帮我配，C 走我自己配置", () => {
    const onAskAi = vi.fn();
    const onNewConfig = vi.fn();
    const handlers = { onAskAi, onNewConfig };

    runZeroConfigPrimaryAction("just-onboarded", handlers);
    expect(onAskAi).not.toHaveBeenCalled();
    expect(onNewConfig).not.toHaveBeenCalled();

    runZeroConfigPrimaryAction("ai-ready", handlers);
    expect(onAskAi).toHaveBeenCalledTimes(1);
    expect(onNewConfig).not.toHaveBeenCalled();

    runZeroConfigPrimaryAction("just-onboarded-stopped", handlers);
    expect(onAskAi).toHaveBeenCalledTimes(2);

    runZeroConfigPrimaryAction("manual", handlers);
    expect(onNewConfig).toHaveBeenCalledTimes(1);
    expect(onAskAi).toHaveBeenCalledTimes(2);
  });

  it("会话空闲时，主按钮发出一条用户消息", () => {
    expect(
      shouldSendZeroConfigAsk({
        requesting: false,
        hasActiveRequest: false,
        hasPendingQuestion: false,
        alreadyAsked: false,
      }),
    ).toBe(true);

    const session = createSession(1);
    let state = chatReducer(createInitialState(), {
      type: "add_session",
      session,
    });
    state = chatReducer(state, {
      type: "send_user_message",
      sessionId: session.id,
      text: "帮我配一下网络",
      localRequestId: "local_ask",
    });

    const current = activeSession(state)!;
    expect(current.messages[0]).toMatchObject({
      role: "user",
      text: "帮我配一下网络",
    });
  });

  it("会话正在请求中、或有未回答的问题时，主按钮只给焦点，不重复发消息", () => {
    expect(
      shouldSendZeroConfigAsk({
        requesting: true,
        hasActiveRequest: false,
        hasPendingQuestion: false,
        alreadyAsked: false,
      }),
    ).toBe(false);
    expect(
      shouldSendZeroConfigAsk({
        requesting: false,
        hasActiveRequest: true,
        hasPendingQuestion: false,
        alreadyAsked: false,
      }),
    ).toBe(false);
    expect(
      shouldSendZeroConfigAsk({
        requesting: false,
        hasActiveRequest: false,
        hasPendingQuestion: true,
        alreadyAsked: false,
      }),
    ).toBe(false);
  });

  it("同一运行内连点两次只发一条", () => {
    const idle = {
      requesting: false,
      hasActiveRequest: false,
      hasPendingQuestion: false,
    };

    let asked = false;
    expect(shouldSendZeroConfigAsk({ ...idle, alreadyAsked: asked })).toBe(true);
    asked = true;
    expect(shouldSendZeroConfigAsk({ ...idle, alreadyAsked: asked })).toBe(false);
  });

  it("配置从有变无后 A 文案不再出现", () => {
    let justOnboarded = true;
    expect(zeroConfigMode(true, justOnboarded)).toBe("just-onboarded");

    // 建出配置后复位；之后删光配置，入口回到 B，而不是 A。
    expect(shouldResetJustOnboarded(justOnboarded, 1)).toBe(true);
    justOnboarded = false;
    expect(shouldResetJustOnboarded(justOnboarded, 0)).toBe(false);
    expect(zeroConfigMode(true, justOnboarded)).toBe("ai-ready");
    expect(zeroConfigContent("ai-ready").title).not.toBe(
      zeroConfigContent("just-onboarded").title,
    );
  });

  it("A 状态在请求结束后切成可继续", () => {
    const settled = shouldSettleZeroConfig({
      requesting: false,
      hasActiveRequest: false,
      hasPendingQuestion: false,
      messageCount: 2,
      lastAssistantText: "好的。",
    });
    expect(settled).toBe(true);

    const mode = zeroConfigMode(true, true, settled);
    expect(mode).toBe("just-onboarded-stopped");
    expect(zeroConfigActions(mode)).toEqual(["ask-ai", "new-config"]);
    expect(zeroConfigContent(mode).title).toBe("还没配好。");
    expect(zeroConfigContent(mode).primaryLabel).toBe("继续帮我配");
  });

  it("A 状态请求进行中保持原状", () => {
    expect(
      shouldSettleZeroConfig({
        requesting: true,
        hasActiveRequest: false,
        hasPendingQuestion: false,
        messageCount: 2,
      lastAssistantText: "好的。",
      }),
    ).toBe(false);
    expect(
      shouldSettleZeroConfig({
        requesting: false,
        hasActiveRequest: true,
        hasPendingQuestion: false,
        messageCount: 2,
      lastAssistantText: "好的。",
      }),
    ).toBe(false);
    expect(
      shouldSettleZeroConfig({
        requesting: false,
        hasActiveRequest: false,
        hasPendingQuestion: true,
        messageCount: 2,
      lastAssistantText: "好的。",
      }),
    ).toBe(false);
    expect(
      shouldSettleZeroConfig({
        requesting: false,
        hasActiveRequest: false,
        hasPendingQuestion: false,
        messageCount: 0,
        lastAssistantText: null,
      }),
    ).toBe(false);

    expect(zeroConfigMode(true, true, false)).toBe("just-onboarded");
    expect(zeroConfigActions("just-onboarded")).toEqual(["new-config"]);
  });

  it("assistant 以问句结尾时不切 settled", () => {
    const base = {
      requesting: false,
      hasActiveRequest: false,
      hasPendingQuestion: false,
      messageCount: 2,
    };

    expect(
      shouldSettleZeroConfig({ ...base, lastAssistantText: "把订阅链接发我？" }),
    ).toBe(false);
    expect(
      shouldSettleZeroConfig({
        ...base,
        lastAssistantText: "你的服务器地址是多少?",
      }),
    ).toBe(false);
    expect(
      shouldSettleZeroConfig({ ...base, lastAssistantText: "好的，我先看看。" }),
    ).toBe(true);
  });

  it("从 assistant 消息里取最后一段文本", () => {
    const messages = [
      { role: "user" },
      {
        role: "assistant",
        items: [
          { kind: "thinking", content: "想一下" },
          { kind: "text", content: "把订阅链接发我？" },
        ],
      },
    ];
    expect(lastAssistantTextOf(messages)).toBe("把订阅链接发我？");
  });

  it("B/C 不受 settled 影响", () => {
    expect(zeroConfigMode(true, false, true)).toBe("ai-ready");
    expect(zeroConfigMode(false, true, true)).toBe("manual");
    expect(zeroConfigActions("ai-ready")).toEqual(["ask-ai", "new-config"]);
    expect(zeroConfigActions("manual")).toEqual(["new-config"]);
  });

  it("AI 回了新内容后按钮可以再次发送", () => {
    expect(
      isZeroConfigAskSuppressed({ asked: true, askedAtCount: 2, messageCount: 2 }),
    ).toBe(true);
    expect(
      isZeroConfigAskSuppressed({ asked: true, askedAtCount: 2, messageCount: 4 }),
    ).toBe(false);
  });
});
