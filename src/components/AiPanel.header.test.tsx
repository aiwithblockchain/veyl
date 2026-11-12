/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AiPanel } from "./AiPanel";

afterEach(cleanup);

const noop = () => {};
const asyncOk = async () => ({ ok: true });

function renderPanel(props: { aiReady: boolean; aiProviderName: string | null }) {
  const { container } = render(
    <AiPanel
      session={null}
      sessions={[]}
      activeSessionId=""
      aiReady={props.aiReady}
      aiProviderName={props.aiProviderName}
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
  return container;
}

describe("助手头部服务名", () => {
  it("跟随当前服务商，不再写死 DeepSeek", () => {
    const root = renderPanel({ aiReady: true, aiProviderName: "OpenAI" });
    expect(root.querySelector(".ai-panel__model")?.textContent).toBe("OpenAI");
  });

  it("未知服务名回退 AI，未配置显示未连接 AI", () => {
    const unknown = renderPanel({ aiReady: true, aiProviderName: null });
    expect(unknown.querySelector(".ai-panel__model")?.textContent).toBe("AI");
    cleanup();

    const off = renderPanel({ aiReady: false, aiProviderName: null });
    expect(off.querySelector(".ai-panel__model")?.textContent).toBe("未连接 AI");
  });
});

describe("会话重命名输入法", () => {
  it("组合态回车不提交，正常回车提交", async () => {
    const session = {
      id: "s1",
      title: "老名字",
      createdAt: 1,
      updatedAt: 1,
      messages: [],
      toolCalls: {},
      status: null,
      activeRequestId: null,
      requesting: false,
      historyLoaded: true,
    };
    const onRenameSession = vi.fn(async () => ({ ok: true }));
    render(
      <AiPanel
        session={session}
        sessions={[session]}
        activeSessionId="s1"
        aiReady
        aiProviderName={null}
        hasEverConnected
        hasConfigs
        focusSignal={0}
        onSelectSession={noop}
        onNewSession={noop}
        onRenameSession={onRenameSession}
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

    fireEvent.click(screen.getByRole("button", { name: "历史会话" }));
    fireEvent.click(screen.getByRole("button", { name: "重命名会话 老名字" }));
    const input = screen.getByRole("textbox", { name: "会话标题" }) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "新名字" } });

    fireEvent.keyDown(input, { key: "Enter", keyCode: 229 });
    expect(onRenameSession).not.toHaveBeenCalled();

    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(onRenameSession).toHaveBeenCalledWith("s1", "新名字"));
  });
});
