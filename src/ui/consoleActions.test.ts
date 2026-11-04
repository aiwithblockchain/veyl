import { describe, expect, it, vi } from "vitest";
import { activeSession, chatReducer, createInitialState, createSession } from "../state/chatStore";
import {
  runZeroConfigPrimaryAction,
  shouldSendZeroConfigAsk,
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

    runZeroConfigPrimaryAction("manual", handlers);
    expect(onNewConfig).toHaveBeenCalledTimes(1);
    expect(onAskAi).toHaveBeenCalledTimes(1);
  });

  it("会话空闲时，主按钮发出一条用户消息", () => {
    expect(
      shouldSendZeroConfigAsk({
        requesting: false,
        hasActiveRequest: false,
        hasPendingQuestion: false,
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
      }),
    ).toBe(false);
    expect(
      shouldSendZeroConfigAsk({
        requesting: false,
        hasActiveRequest: true,
        hasPendingQuestion: false,
      }),
    ).toBe(false);
    expect(
      shouldSendZeroConfigAsk({
        requesting: false,
        hasActiveRequest: false,
        hasPendingQuestion: true,
      }),
    ).toBe(false);
  });
});
