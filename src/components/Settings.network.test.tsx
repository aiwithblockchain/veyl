/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentBridge, LlmProvider } from "../agent/bridge";
import { emptyRuntimeView } from "../agent/bridge";
import type { RuntimeView } from "../agent/protocol";
import { Settings } from "./Settings";

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
});

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
    providers = [provider()],
  }: { activeProviderId?: string | null; providers?: LlmProvider[] } = {},
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
    coreCheckUpdates: vi.fn(async () => ({ network: "ok" as const, candidates: [], cached: false })),
    tunHelperInfo: vi.fn(async () => ({
      runningBuild: null,
      helperVersion: null,
      expectedBuild: "2026.11.1",
      stale: false,
      state: "not_running" as const,
      needsAdminRestart: false,
    })),
    tunHelperRestart: vi.fn(async () => ({ ok: true, restarted: true, needsAdminRestart: false })),
    llmProviderList: vi.fn(async () => ({ providers, activeProviderId })),
    defaultProfileRefresh: vi.fn(),
    defaultProfileStatus: vi.fn(),
  } as unknown as AgentBridge;
}

function runtime(over: Partial<RuntimeView> = {}): RuntimeView {
  return { ...emptyRuntimeView(), ...over };
}

function renderSettings(
  bridge: AgentBridge,
  {
    connectMode = null,
    currentNodeName = null,
    nodeCount = 0,
    section = "network",
    runtimeView = runtime(),
    onOpenNodePanel,
    onNewConfig,
  }: {
    connectMode?: "tun" | "system_proxy" | null;
    currentNodeName?: string | null;
    nodeCount?: number;
    section?: "ai" | "network" | "advanced" | "about";
    runtimeView?: RuntimeView;
    onOpenNodePanel?: () => void;
    onNewConfig?: () => void;
  } = {},
) {
  return render(
    <Settings
      open
      bridge={bridge}
      runtime={runtimeView}
      defaultProfile={null}
      connectMode={connectMode}
      currentNodeName={currentNodeName}
      nodeCount={nodeCount}
      onOpenNodePanel={onOpenNodePanel}
      onNewConfig={onNewConfig}
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

describe("连接 tab", () => {
  it("全部流量配置显示行为描述与换方式的入口", async () => {
    const onNewConfig = vi.fn();
    renderSettings(makeBridge(), { connectMode: "tun", onNewConfig });
    expect(await screen.findByText("现在怎么连")).toBeTruthy();
    expect(screen.getByText("全部流量走 VPN")).toBeTruthy();
    expect(screen.getByText(/要换方式/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "新建一套配置" }));
    expect(onNewConfig).toHaveBeenCalledTimes(1);
  });

  it("代理配置显示行为描述", async () => {
    renderSettings(makeBridge(), { connectMode: "system_proxy" });
    expect(await screen.findByText("只有设置了代理的软件走 VPN")).toBeTruthy();
    expect(screen.queryByText("全部流量走 VPN")).toBeNull();
  });

  it("没有配置时说明先去新建", async () => {
    renderSettings(makeBridge(), { connectMode: null });
    const values = await screen.findAllByText("还没有配置");
    expect(values.length).toBeGreaterThan(0);
    expect(screen.getByText("先在左侧新建一套配置，再回来这里看。")).toBeTruthy();
  });

  it("代理已连接时给出可复制的本机地址", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    renderSettings(makeBridge(), {
      connectMode: "system_proxy",
      runtimeView: runtime({ state: "running", mixed_port: 2080, system_proxy_enabled: true }),
    });

    expect(await screen.findByText("127.0.0.1:2080")).toBeTruthy();
    expect(
      screen.getByText("现在用的是 2080；保存的是 7890，下次连接生效。"),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "复制" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("127.0.0.1:2080"));
  });

  it("多个节点时整行可点，直接打开节点面板", async () => {
    const onOpenNodePanel = vi.fn();
    renderSettings(makeBridge(), {
      connectMode: "tun",
      currentNodeName: "东京 01",
      nodeCount: 2,
      onOpenNodePanel,
    });

    expect(await screen.findByText("用哪个节点")).toBeTruthy();
    expect(screen.getByText("东京 01")).toBeTruthy();
    expect(screen.getByText("›")).toBeTruthy();
    expect(screen.queryByText("点这里可以换节点。")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /用哪个节点/ }));
    expect(onOpenNodePanel).toHaveBeenCalledTimes(1);
  });

  it("只有一个节点时不可点，也没有 ›", async () => {
    renderSettings(makeBridge(), {
      connectMode: "tun",
      currentNodeName: "东京 01",
      nodeCount: 1,
    });
    expect(await screen.findByText("东京 01")).toBeTruthy();
    expect(screen.queryByText("这套配置只有一个节点。")).toBeNull();
    expect(screen.queryByRole("button", { name: /用哪个节点/ })).toBeNull();
    expect(screen.queryByText("›")).toBeNull();
  });

  it("没有节点时指到导入或试用节点", async () => {
    renderSettings(makeBridge(), { connectMode: "tun", currentNodeName: null });
    expect(await screen.findByText("还没有节点")).toBeTruthy();
    expect(screen.getByText("先导入节点或更新试用节点。")).toBeTruthy();
  });

  it("导入收成一行，点开弹层才有拖放区与密码提醒", async () => {
    renderSettings(makeBridge(), { connectMode: "tun" });
    expect(await screen.findByText("导入节点文件")).toBeTruthy();
    expect(screen.queryByText("导入不需要联网。")).toBeNull();
    expect(screen.queryByRole("button", { name: "选择文件" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "导入" }));

    const dialog = await screen.findByRole("dialog", { name: "导入节点文件" });
    expect(
      within(dialog).getByText("导入不需要联网。文件里有节点密码，不要外传。"),
    ).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: "选择文件" })).toBeTruthy();

    fireEvent.click(within(dialog).getByRole("button", { name: "关闭" }));
    expect(screen.queryByRole("dialog", { name: "导入节点文件" })).toBeNull();
  });

  it("网络页不出现修复动作", async () => {
    renderSettings(makeBridge(), { connectMode: "system_proxy" });
    await screen.findByText("现在怎么连");
    expect(screen.queryByText("清除残留代理")).toBeNull();
    expect(screen.queryByText("强制重置网络")).toBeNull();
  });
});

describe("删除项与旧入口", () => {
  it("网络页不再有代理模式、本地端口、恢复直连与问 AI", async () => {
    renderSettings(makeBridge(), { connectMode: "tun" });
    await screen.findByText("现在怎么连");
    expect(screen.queryByText("代理模式")).toBeNull();
    expect(screen.queryByText("本地端口")).toBeNull();
    expect(screen.queryByText("恢复直连")).toBeNull();
    expect(screen.queryByRole("button", { name: "问 AI" })).toBeNull();
  });

  it("高级页不再有日志级别、测试节点地址、事件源与旧按钮", async () => {
    renderSettings(makeBridge(), { section: "advanced" });
    await screen.findByText("遇到问题", { selector: ".settings-section__title" });
    expect(screen.queryByText("日志级别")).toBeNull();
    expect(screen.queryByText("测试节点地址")).toBeNull();
    expect(screen.queryByText("事件源")).toBeNull();
    expect(screen.queryByText("bootstrap.json")).toBeNull();
    expect(screen.queryByRole("button", { name: "检查并更新" })).toBeNull();
    expect(screen.queryByRole("button", { name: "用随包版本继续" })).toBeNull();
  });

  it("关于页只剩版本，不再有日志与首次引导", async () => {
    renderSettings(makeBridge(), { section: "about" });
    expect(await screen.findByText("版本")).toBeTruthy();
    expect(screen.queryByText("日志")).toBeNull();
    expect(screen.queryByText("首次引导")).toBeNull();
  });

  it("正式构建不出现重新运行引导，DEV 才保留", async () => {
    vi.stubEnv("DEV", false);
    renderSettings(makeBridge(), { section: "advanced" });
    await screen.findByText("更新与诊断");
    expect(screen.queryByText("重新运行引导")).toBeNull();
  });
});

describe("遇到问题 tab", () => {
  it("代理模式未连接时在修复组显示清除残留代理", async () => {
    renderSettings(makeBridge(), { section: "advanced", connectMode: "system_proxy" });
    expect(
      await screen.findByText("清除残留代理", { selector: ".settings-row__label" }),
    ).toBeTruthy();
    expect(screen.getByText("不会影响「全部流量」的接管。")).toBeTruthy();
  });

  it("全部流量且没有残留时不显示清除残留代理", async () => {
    renderSettings(makeBridge(), { section: "advanced", connectMode: "tun" });
    await screen.findByText("修复网络");
    expect(screen.queryByText("清除残留代理")).toBeNull();
  });

  it("正在连接代理时不显示清除残留代理", async () => {
    renderSettings(makeBridge(), {
      section: "advanced",
      connectMode: "system_proxy",
      runtimeView: runtime({ state: "running", mixed_port: 2080 }),
    });
    await screen.findByText("修复网络");
    expect(screen.queryByText("清除残留代理")).toBeNull();
  });

  it("首句说明平时不用改，维护区默认收起", async () => {
    renderSettings(makeBridge(), { section: "advanced" });
    expect(
      await screen.findByText("这里的东西平时不用改。连不上网、打不开网页时再看。"),
    ).toBeTruthy();
    const fold = document.querySelector("details.settings-fold") as HTMLDetailsElement;
    expect(fold).not.toBeNull();
    expect(fold.open).toBe(false);
    expect(screen.getByText("更新与诊断")).toBeTruthy();
    expect(screen.getByText("平时不用管")).toBeTruthy();
  });

  it("强制重置独立成危险区域，说明什么时候用与不该用", async () => {
    renderSettings(makeBridge(), { section: "advanced" });
    const zone = (
      await screen.findByText("强制重置网络", { selector: ".danger-zone__title" })
    ).closest(".danger-zone") as HTMLElement;
    expect(zone).not.toBeNull();
    expect(
      screen.getByText(/网络出问题时用。停掉 Veyl 的后台服务/),
    ).toBeTruthy();
    expect(screen.getByText("能正常上网时不要用。只想断开连接，回主界面点「断开 VPN」。")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "强制重置网络" }).className,
    ).toContain("btn--danger-ghost");
  });
});

describe("AI 助手 tab", () => {
  it("只有一个服务列表，没有基础/高级切换与独立 Key 表单", async () => {
    renderSettings(makeBridge(), { section: "ai" });
    expect(await screen.findByText("用哪个 AI 服务")).toBeTruthy();
    expect(screen.getByText("DeepSeek")).toBeTruthy();
    expect(screen.getByText("添加 AI 服务")).toBeTruthy();
    expect(screen.queryByRole("tab", { name: "基础" })).toBeNull();
    expect(screen.queryByRole("tab", { name: "高级" })).toBeNull();
    expect(screen.queryByLabelText("DeepSeek API Key")).toBeNull();
    expect(screen.queryByRole("button", { name: "刷新" })).toBeNull();
  });

  it("列表项可以直接测试当前服务", async () => {
    const bridge = makeBridge();
    (bridge as unknown as { llmProviderTest: unknown }).llmProviderTest = vi.fn(async () => ({
      ok: true,
      latencyMs: 42,
    }));
    renderSettings(bridge, { section: "ai" });

    fireEvent.click(await screen.findByRole("button", { name: "测试" }));
    expect(await screen.findByText("连接成功 · 42 ms")).toBeTruthy();
  });

  it("说明切换服务会开始新会话", async () => {
    renderSettings(makeBridge(), { section: "ai" });
    expect(
      await screen.findByText(
        "切换当前使用的服务会开始一个新会话，之前对话的上下文不会带过去。",
      ),
    ).toBeTruthy();
  });
});
