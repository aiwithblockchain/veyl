/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StageQuickToggles } from "./StageQuickToggles";

afterEach(cleanup);

function renderToggles(
  overrides: Partial<Parameters<typeof StageQuickToggles>[0]> = {},
) {
  const onAskAi = vi.fn();
  const props = {
    connectMode: "system_proxy" as const,
    routingMode: "direct" as const,
    connected: false,
    modeLocked: false,
    helperPreparing: false,
    onSetConnectMode: vi.fn(async () => ({ ok: true })),
    onSetRoutingMode: vi.fn(async () => ({ ok: true })),
    onAskAi,
    ...overrides,
  };
  render(<StageQuickToggles {...props} />);
  return { onAskAi };
}

describe("两个 chip 的「问 AI」", () => {
  it("Proxy + 智能：交给 AI 的提示词带当前两个值，措辞逐字固定", () => {
    const { onAskAi } = renderToggles();
    fireEvent.click(screen.getByRole("button", { name: "问 AI" }));

    expect(onAskAi).toHaveBeenCalledTimes(1);
    expect(onAskAi).toHaveBeenCalledWith(
      "我在 Veyl 的连接页看接管方式和流量范围。当前是「Proxy 模式」+「智能」。\n" +
        "请用不超过四句话说明：接管方式两句（改了什么、什么时候该改），流量范围两句（智能只让需要的流量走、全局全部走）。\n" +
        "不要给通用教程，只说这两个开关本身。",
    );
  });

  it("Tun + 全局：提示词跟着当前值变", () => {
    const { onAskAi } = renderToggles({
      connectMode: "tun",
      routingMode: "proxy_all",
    });
    fireEvent.click(screen.getByRole("button", { name: "问 AI" }));

    const prompt = onAskAi.mock.calls[0][0] as string;
    expect(prompt).toContain("「Tun 模式」+「全局」");
  });

  it("正在请求授权时不出现「问 AI」", () => {
    renderToggles({ helperPreparing: true });

    expect(screen.queryByRole("button", { name: "问 AI" })).toBeNull();
  });

  it("没有流量范围（routingMode 为 null）时不出现「问 AI」", () => {
    renderToggles({ routingMode: null });

    expect(screen.queryByRole("button", { name: "问 AI" })).toBeNull();
  });

  it("没有传 onAskAi 时不渲染「问 AI」", () => {
    render(
      <StageQuickToggles
        connectMode="system_proxy"
        routingMode="direct"
        connected={false}
        modeLocked={false}
        helperPreparing={false}
        onSetConnectMode={vi.fn(async () => ({ ok: true }))}
        onSetRoutingMode={vi.fn(async () => ({ ok: true }))}
      />,
    );

    expect(screen.queryByRole("button", { name: "问 AI" })).toBeNull();
  });
});
