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
  it("Proxy + 智能：提示词带当前两个值，并要求分场景说明", () => {
    const { onAskAi } = renderToggles();
    fireEvent.click(screen.getByRole("button", { name: "问 AI" }));

    expect(onAskAi).toHaveBeenCalledTimes(1);
    const prompt = onAskAi.mock.calls[0][0] as string;
    // 当前组合必须原样带进去，模型才知道用户选的是什么。
    expect(prompt).toContain("当前是「Proxy 模式」+「智能」");
    // 结构固定：先接管方式、再流量范围，两种情况分别说清楚。
    expect(prompt).toContain("一、接管方式");
    expect(prompt).toContain("二、流量范围");
    expect(prompt).toContain("不要出现 HTTP/3、QUIC、分流、规则、DNS 这类词");
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
