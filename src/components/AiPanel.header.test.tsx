/** @vitest-environment jsdom */
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
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
