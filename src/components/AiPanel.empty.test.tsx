/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PendingQuestion } from "../agent/bridge";
import type { Session } from "../state/chatStore";
import { AiPanel } from "./AiPanel";

afterEach(cleanup);

const noop = () => {};
const asyncOk = async () => ({ ok: true });

const PRESETS = [
  "连上了，但网页打不开",
  "怎么换成更快的节点",
  "为什么有的软件没走 VPN",
  "为什么个别网站还是打不开",
  "终端里的命令也想走 VPN",
];

function makeSession(over: Partial<Session> = {}): Session {
  return {
    id: "s1",
    title: "新对话",
    createdAt: 1,
    updatedAt: 1,
    messages: [],
    toolCalls: {},
    status: null,
    activeRequestId: null,
    requesting: false,
    historyLoaded: true,
    ...over,
  };
}

function renderPanel(over: {
  session?: Session | null;
  aiReady?: boolean;
  presetsVisible?: boolean;
  question?: PendingQuestion | null;
  onEmptySend?: (text: string) => void;
  onAnswerFromComposer?: (text: string) => void;
} = {}) {
  const session = over.session === undefined ? makeSession() : over.session;
  render(
    <AiPanel
      session={session}
      sessions={session ? [session] : []}
      activeSessionId={session?.id ?? ""}
      aiReady={over.aiReady ?? true}
      presetsVisible={over.presetsVisible ?? true}
      aiProviderName="DeepSeek"
      hasEverConnected
      hasConfigs
      focusSignal={0}
      question={over.question ?? null}
      onSelectSession={noop}
      onNewSession={noop}
      onRenameSession={asyncOk}
      onDeleteSession={asyncOk}
      onSend={noop}
      onEmptySend={over.onEmptySend ?? noop}
      onAnswerFromComposer={over.onAnswerFromComposer}
      onStop={noop}
      onNextAction={noop}
      onOpenSettings={noop}
      onConfigureKey={noop}
      onCollapse={noop}
    />,
  );
}

function shownPresets(): string[] {
  const group = screen.queryByRole("group", { name: "可以这样问" });
  return group
    ? [...group.querySelectorAll("button")].map(
        (button) => button.textContent ?? "",
      )
    : [];
}

describe("对话空态的预制问题", () => {
  it("空会话一次显示五条原文", () => {
    renderPanel();
    expect(shownPresets()).toEqual(PRESETS);
  });

  it("没有 AI、AI 正在提问、已有消息时不显示", () => {
    renderPanel({ aiReady: false });
    expect(shownPresets()).toEqual([]);
    cleanup();

    renderPanel({
      question: {
        questionId: "q1",
        sessionId: "s1",
        requestId: "r1",
        question: "用哪个？",
        options: ["A", "B"],
        createdAt: 1,
        expiresAt: 2,
        kind: null,
      },
    });
    expect(shownPresets()).toEqual([]);
    cleanup();

    renderPanel({
      session: makeSession({
        messages: [{ id: "m1", role: "user", text: "你好", at: 1 }],
      }),
    });
    expect(shownPresets()).toEqual([]);
  });

  it("不在 client / no_nodes 屏时不显示", () => {
    renderPanel({ presetsVisible: false });
    expect(shownPresets()).toEqual([]);
  });

  it("点击把原文交给普通发送路径，不走回答路径", () => {
    const onEmptySend = vi.fn();
    const onAnswerFromComposer = vi.fn();
    renderPanel({ onEmptySend, onAnswerFromComposer });

    fireEvent.click(screen.getByRole("button", { name: "怎么换成更快的节点" }));
    expect(onEmptySend).toHaveBeenCalledWith("怎么换成更快的节点");
    expect(onAnswerFromComposer).not.toHaveBeenCalled();
  });

  it("同一会话发过消息后不再出现；新会话重新出现", () => {
    const bridged: Session = makeSession({
      messages: [{ id: "m1", role: "user", text: "连上了", at: 1 }],
    });
    const { rerender } = render(
      <AiPanel
        session={bridged}
        sessions={[bridged]}
        activeSessionId="s1"
        aiReady
        aiProviderName="DeepSeek"
        hasEverConnected
        hasConfigs
        focusSignal={0}
        onSelectSession={noop}
        onNewSession={noop}
        onRenameSession={asyncOk}
        onDeleteSession={asyncOk}
        onSend={noop}
        onEmptySend={noop}
        onStop={noop}
        onNextAction={noop}
        onOpenSettings={noop}
        onConfigureKey={noop}
        onCollapse={noop}
      />,
    );
    expect(shownPresets()).toEqual([]);

    const fresh = makeSession({ id: "s2", title: "新对话" });
    rerender(
      <AiPanel
        session={fresh}
        sessions={[bridged, fresh]}
        activeSessionId="s2"
        aiReady
        aiProviderName="DeepSeek"
        hasEverConnected
        hasConfigs
        focusSignal={0}
        onSelectSession={noop}
        onNewSession={noop}
        onRenameSession={asyncOk}
        onDeleteSession={asyncOk}
        onSend={noop}
        onEmptySend={noop}
        onStop={noop}
        onNextAction={noop}
        onOpenSettings={noop}
        onConfigureKey={noop}
        onCollapse={noop}
      />,
    );
    expect(shownPresets()).toEqual(PRESETS);
  });
});
