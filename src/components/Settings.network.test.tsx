/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentBridge, LlmProvider } from "../agent/bridge";
import { emptyRuntimeView } from "../agent/bridge";
import { Settings } from "./Settings";

afterEach(cleanup);

function provider(over: Partial<LlmProvider> = {}): LlmProvider {
  return {
    providerId: "deepseek",
    name: "DeepSeek",
    protocol: "openai",
    baseUrl: "https://api.deepseek.com",
    model: "deepseek-chat",
    hasKey: true,
    isActive: true,
    isBuiltin: true,
    ...over,
  };
}

function makeBridge(
  {
    activeProviderId = "deepseek",
    masked = "sk-****abcd",
  }: { activeProviderId?: string | null; masked?: string | null } = {},
  overrides: Partial<Record<keyof AgentBridge, unknown>> = {},
): AgentBridge {
  return {
    mode: "mock",
    subscribe: vi.fn(() => () => {}),
    coreInfo: vi.fn(async () => ({
      bundledVersion: "1.14.4",
      activeVersion: "1.14.4",
      activeSource: "bundled" as const,
      restartRequired: false,
    })),
    tunHelperInfo: vi.fn(async () => ({
      runningBuild: null,
      expectedBuild: "2026.11.1",
      stale: false,
      state: "not_running" as const,
      needsAdminRestart: false,
    })),
    tunHelperRestart: vi.fn(async () => ({ ok: true, restarted: true, needsAdminRestart: false })),
    getDeepSeekKey: vi.fn(async () => ({
      masked,
      verified: true,
      validation: "ok" as const,
    })),
    llmProviderList: vi.fn(async () => ({
      providers: [provider({ isActive: activeProviderId === "deepseek" })],
      activeProviderId,
    })),
    defaultProfileRefresh: vi.fn(),
    ...overrides,
  } as unknown as AgentBridge;
}

function renderSettings(
  bridge: AgentBridge,
  {
    connectMode = null,
    section = "network",
  }: { connectMode?: "tun" | "system_proxy" | null; section?: "ai" | "network" | "advanced" | "about" } = {},
) {
  return render(
    <Settings
      open
      bridge={bridge}
      runtime={emptyRuntimeView()}
      defaultProfile={null}
      connectMode={connectMode}
      onClose={() => {}}
      onNotice={() => {}}
      importing={false}
      dragging={false}
      importResult={null}
      importError={null}
      onImportPath={() => {}}
      onRestartOnboarding={() => {}}
      onOpenLogs={() => {}}
      onRestoreNetwork={() => {}}
      onAskAi={() => {}}
      initialSection={section}
    />,
  );
}

describe("网络 → 当前连接", () => {
  it("全部流量的配置显示「全部流量」", async () => {
    renderSettings(makeBridge(), { connectMode: "tun" });
    expect(await screen.findByText("当前连接")).toBeTruthy();
    expect(screen.getByText("全部流量")).toBeTruthy();
    expect(screen.getByText("这套配置的连接方式，在新建配置时选择。")).toBeTruthy();
  });

  it("只给代理地址的配置显示对应文案", async () => {
    renderSettings(makeBridge(), { connectMode: "system_proxy" });
    expect(await screen.findByText("只给代理地址")).toBeTruthy();
    expect(screen.queryByText("全部流量")).toBeNull();
  });

  it("没有配置时如实说还没有配置，不给来源说明", async () => {
    renderSettings(makeBridge(), { connectMode: null });
    expect(await screen.findByText("还没有配置")).toBeTruthy();
    expect(screen.queryByText("这套配置的连接方式，在新建配置时选择。")).toBeNull();
  });

  it("旧的「代理模式」整行已删除", async () => {
    renderSettings(makeBridge(), { connectMode: "tun" });
    await screen.findByText("当前连接");
    expect(screen.queryByText("代理模式")).toBeNull();
    expect(screen.queryByText("系统代理")).toBeNull();
  });

  it("网络页不再有只读行的「问 AI」", async () => {
    renderSettings(makeBridge(), { connectMode: "tun" });
    await screen.findByText("当前连接");
    expect(screen.queryByRole("button", { name: "问 AI" })).toBeNull();
  });
});

describe("被删除的只读设置项", () => {
  it("高级页不再有测试节点地址、日志级别", async () => {
    renderSettings(makeBridge(), { section: "advanced" });
    await screen.findByText("测试节点");
    expect(screen.queryByText("测试节点地址")).toBeNull();
    expect(screen.queryByText("日志级别")).toBeNull();
    expect(screen.queryByText("bootstrap.json")).toBeNull();
  });

  it("关于页不再有事件源", async () => {
    renderSettings(makeBridge(), { section: "about" });
    expect(await screen.findByText("版本")).toBeTruthy();
    expect(screen.queryByText("事件源")).toBeNull();
    expect(screen.queryByText(/MOCK 事件源|已连接 Host/)).toBeNull();
  });

  it("诊断信息行只保留复制，不再有问 AI", async () => {
    renderSettings(makeBridge(), { section: "advanced" });
    const row = (await screen.findByText("诊断信息")).closest(".settings-row") as HTMLElement;
    expect(within(row).getByRole("button", { name: "复制诊断信息" })).toBeTruthy();
    expect(within(row).queryByRole("button", { name: "问 AI" })).toBeNull();
  });
});

describe("会话重建提示", () => {
  it("当前服务是 DeepSeek 时，更换 Key 才警告会清空上下文", async () => {
    renderSettings(makeBridge({ activeProviderId: "deepseek" }), { section: "ai" });
    fireEvent.click(await screen.findByRole("button", { name: "更换" }));
    expect(
      await screen.findByText("更换 Key 会重建当前会话，对话上下文将清空。"),
    ).toBeTruthy();
  });

  it("当前服务不是 DeepSeek 时不再显示这条警告", async () => {
    const bridge = makeBridge({ activeProviderId: "anthropic" });
    renderSettings(bridge, { section: "ai" });
    fireEvent.click(await screen.findByRole("button", { name: "更换" }));
    // 等 provider 列表真的回来，否则「没有警告」可能只是还没读到。
    await waitFor(() => expect(bridge.llmProviderList).toHaveBeenCalled());
    await act(async () => {
      await Promise.resolve();
    });
    expect(await screen.findByRole("button", { name: "显示" })).toBeTruthy();
    expect(screen.queryByText("更换 Key 会重建当前会话，对话上下文将清空。")).toBeNull();
  });

  it("高级 provider 列表说明切换服务会开始新会话", async () => {
    renderSettings(makeBridge(), { section: "ai" });
    fireEvent.click(await screen.findByRole("tab", { name: "高级" }));

    expect(
      await screen.findByText(
        "切换当前使用的服务会开始一个新会话，之前对话的上下文不会带过去。",
      ),
    ).toBeTruthy();
  });
});
