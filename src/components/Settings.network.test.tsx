/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
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
    getAppVersion: vi.fn(async () => "0.1.0"),
    defaultProfileRefresh: vi.fn(),
    defaultProfileStatus: vi.fn(),
    issueReportPreference: vi.fn(async (includeDomains?: boolean) => ({
      includeDomains: includeDomains ?? false,
    })),
  } as unknown as AgentBridge;
}

function runtime(over: Partial<RuntimeView> = {}): RuntimeView {
  return { ...emptyRuntimeView(), ...over };
}

function renderSettings(
  bridge: AgentBridge,
  {
    connectMode = null,
    configId = "cfg_1",
    section = "network",
    runtimeView = runtime(),
    proxyPort,
    onAskAi,
    onReportProblem,
    routingMode,
    onSetRoutingMode,
    onConnectModeChanged,
    assistant,
    onConsultAi,
  }: {
    connectMode?: "tun" | "system_proxy" | null;
    assistant?: ReactNode;
    configId?: string | null;
    routingMode?: "direct" | "proxy_all" | "proxy_selected" | null;
    onSetRoutingMode?: (mode: "direct" | "proxy_all") => Promise<{ ok: boolean; message?: string }>;
    onConnectModeChanged?: (mode: "tun" | "system_proxy") => void;
    section?: "ai" | "network" | "advanced";
    runtimeView?: RuntimeView;
    proxyPort?: number;
    onAskAi?: (text: string, section: string) => void;
    onReportProblem?: () => void;
    onConsultAi?: (prompt: string) => boolean;
  } = {},
) {
  return render(
    <Settings
      open
      bridge={bridge}
      runtime={runtimeView}
      defaultProfile={null}
      connectMode={connectMode}
      configId={configId}
      proxyPort={proxyPort}
      onClose={() => {}}
      onRestartOnboarding={() => {}}
      onOpenLogs={() => {}}
      onRestoreNetwork={() => {}}
      onAskAi={onAskAi ?? (() => {})}
      onReportProblem={onReportProblem}
      routingMode={routingMode}
      onSetRoutingMode={onSetRoutingMode}
      onConnectModeChanged={onConnectModeChanged}
      assistant={assistant}
      onConsultAi={onConsultAi}
      initialSection={section}
    />,
  );
}

describe("连接 tab", () => {
  it("接管方式用 Proxy / Tun 分段，按 connect_mode 选中", async () => {
    renderSettings(makeBridge(), { connectMode: "tun" });
    expect(await screen.findByRole("button", { name: "Tun 模式" })).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Tun 模式" }).getAttribute("aria-pressed"),
    ).toBe("true");
    expect(
      [...screen.getByRole("group", { name: "接管方式" }).querySelectorAll("button")].map(
        (button) => button.textContent,
      ),
    ).toEqual(["Proxy 模式", "Tun 模式"]);
    cleanup();

    renderSettings(makeBridge(), { connectMode: "system_proxy" });
    expect(
      (await screen.findByRole("button", { name: "Proxy 模式" })).getAttribute("aria-pressed"),
    ).toBe("true");
  });

  it("未连接时直接切换 Proxy 并回写", async () => {
    const bridge = makeBridge();
    const setMode = vi.fn(async () => ({ changed: true }));
    (bridge as unknown as { configSetMode: unknown }).configSetMode = setMode;
    const onConnectModeChanged = vi.fn();
    renderSettings(bridge, { connectMode: "tun", onConnectModeChanged });

    fireEvent.click(await screen.findByRole("button", { name: "Proxy 模式" }));
    await waitFor(() =>
      expect(setMode).toHaveBeenCalledWith({ configId: "cfg_1", mode: "system_proxy" }),
    );
    expect(onConnectModeChanged).toHaveBeenCalledWith("system_proxy");
  });

  it("已连接时先就地确认，取消不发命令", async () => {
    const bridge = makeBridge();
    const setMode = vi.fn(async () => ({ changed: true }));
    (bridge as unknown as { configSetMode: unknown }).configSetMode = setMode;
    const onConnectModeChanged = vi.fn();
    renderSettings(bridge, {
      connectMode: "tun",
      runtimeView: runtime({ state: "running" }),
      onConnectModeChanged,
    });

    fireEvent.click(await screen.findByRole("button", { name: "Proxy 模式" }));
    expect(await screen.findByText("切换会短暂断开当前连接。")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(setMode).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Proxy 模式" }));
    fireEvent.click(screen.getByRole("button", { name: "切换" }));
    await waitFor(() => expect(setMode).toHaveBeenCalledTimes(1));
  });

  it("流量范围默认智能，点全局回写", async () => {
    const onSetRoutingMode = vi.fn(async () => ({ ok: true }));
    renderSettings(makeBridge(), { connectMode: "tun", onSetRoutingMode });

    fireEvent.click(await screen.findByRole("button", { name: "全局" }));
    await waitFor(() => expect(onSetRoutingMode).toHaveBeenCalledWith("proxy_all"));
  });

  it("没有节点时只说一句，设置里不给新建入口，不显示端口", async () => {
    renderSettings(makeBridge(), { connectMode: null, configId: null });
    expect(await screen.findByText(/^还没有节点。/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "新建节点" })).toBeNull();
    expect(screen.queryByText("本地代理端口")).toBeNull();
    expect(document.querySelector(".seed-refresh")).toBeNull();
  });

  it("节点切换不在设置里", async () => {
    renderSettings(makeBridge(), { connectMode: "tun" });
    expect(await screen.findByText("接管方式")).toBeTruthy();
    expect(screen.queryByText("用哪个节点")).toBeNull();
  });

  it("网络页不出现修复动作", async () => {
    renderSettings(makeBridge(), { connectMode: "system_proxy" });
    await screen.findByText("接管方式");
    expect(screen.queryByText("清除残留代理")).toBeNull();
    expect(screen.queryByText("重置网络")).toBeNull();
  });
});


describe("tab 语义与键盘", () => {
  it("三个 tab 有 tab 角色（账户已独立成弹层）", async () => {
    renderSettings(makeBridge(), { section: "ai" });
    await screen.findByText("用哪个 AI 服务");
    expect(
      screen.getAllByRole("tab").map((tab) => tab.textContent),
    ).toEqual(["AI", "连接", "高级"]);
    expect(document.querySelector(".settings-section__title")).toBeNull();
  });

  it("三个 tab 都有对应的 tabpanel", async () => {
    for (const section of ["ai", "network", "advanced"] as const) {
      renderSettings(makeBridge(), { section, connectMode: "system_proxy" });
      await screen.findByRole("tabpanel");
      const panel = screen.getByRole("tabpanel");
      expect(panel.id).toBe(`settings-panel-${section}`);
      expect(panel.getAttribute("aria-labelledby")).toBe(`settings-tab-${section}`);
      cleanup();
    }
  });

  it("方向键切换 tab 并移动焦点", async () => {
    renderSettings(makeBridge(), { section: "network" });
    await screen.findByText("接管方式");
    const tabs = screen.getAllByRole("tab");

    fireEvent.keyDown(tabs[1], { key: "ArrowRight" });
    expect(screen.getByRole("tab", { name: "高级" }).getAttribute("aria-selected")).toBe(
      "true",
    );
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: "高级" }));

    fireEvent.keyDown(screen.getByRole("tab", { name: "高级" }), { key: "Home" });
    expect(screen.getByRole("tab", { name: "AI" }).getAttribute("aria-selected")).toBe(
      "true",
    );
  });
});

describe("AI 服务 tab", () => {
  it("只有一个服务列表，没有基础/高级切换与独立 Key 表单", async () => {
    renderSettings(makeBridge(), { section: "ai" });
    expect(await screen.findByText("用哪个 AI 服务")).toBeTruthy();
    expect(screen.getByText("DeepSeek")).toBeTruthy();
    expect(screen.getByText("添加 AI 服务")).toBeTruthy();
    const pane = screen.getByRole("tabpanel");
    expect(within(pane).queryByRole("tab", { name: "基础" })).toBeNull();
    expect(within(pane).queryByRole("tab", { name: "高级" })).toBeNull();
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

describe("遇到问题 tab", () => {
  it("页内标题已删除，首句说明仍在", async () => {
    renderSettings(makeBridge(), { section: "advanced" });
    expect(
      await screen.findByText("这里的东西平时不用改。连不上网、打不开网页时再看。"),
    ).toBeTruthy();
    expect(document.querySelector(".settings-section__title")).toBeNull();
  });

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

  it("维护区默认收起", async () => {
    renderSettings(makeBridge(), { section: "advanced" });
    const fold = document.querySelector("details.settings-fold") as HTMLDetailsElement;
    expect(fold).not.toBeNull();
    expect(fold.open).toBe(false);
    expect(screen.getByText("更新与诊断")).toBeTruthy();
  });
});

describe("关于信息（在高级里）", () => {
  it("版本与数据去向；没有仓库地址时不摆空链接", async () => {
    renderSettings(makeBridge(), { section: "advanced" });
    expect(await screen.findByText("版本")).toBeTruthy();
    expect(await screen.findByText("v0.1.0")).toBeTruthy();
    expect(
      screen.getByText("AI 对话会发给你选的服务；配置、节点和日志都留在本机。"),
    ).toBeTruthy();
    expect(screen.queryByText("开源与反馈")).toBeNull();
    expect(screen.queryByRole("button", { name: "打开仓库" })).toBeNull();
    expect(document.querySelector(".settings-section__title")).toBeNull();
  });
});

describe("文案扫描", () => {
  it("可见文本没有禁用词与英文跳过原因", async () => {
    for (const section of ["ai", "network", "advanced"] as const) {
      renderSettings(makeBridge(), { section, connectMode: "system_proxy" });
      await screen.findByRole("tab", { name: "AI" });
      const text = document.querySelector(".modal--settings")?.textContent ?? "";
      expect(text.replace(/Tun 模式|Proxy 模式/g, "")).not.toMatch(/proxy|TUN|分流|规则集/i);
      expect(text).not.toMatch(/duplicate|malformed|unsupported/);
      cleanup();
    }
  });
});

describe("问题报告偏好", () => {
  it("默认关闭；勾选后写一次命令", async () => {
    const bridge = makeBridge();
    renderSettings(bridge, { section: "advanced", onReportProblem: () => {} });

    const box = (await screen.findByRole("checkbox", {
      name: "报告中包含我访问过的网站域名",
    })) as HTMLInputElement;
    await waitFor(() => expect(bridge.issueReportPreference).toHaveBeenCalledWith());
    expect(box.checked).toBe(false);

    fireEvent.click(box);
    await waitFor(() =>
      expect(bridge.issueReportPreference).toHaveBeenCalledWith(true),
    );
    expect(box.checked).toBe(true);
  });

  it("写入失败时复选框回滚并就地提示", async () => {
    const bridge = makeBridge();
    (bridge as unknown as { issueReportPreference: ReturnType<typeof vi.fn> })
      .issueReportPreference = vi.fn(async (includeDomains?: boolean) => {
      if (includeDomains === undefined) return { includeDomains: false };
      throw { code: "INTERNAL", message: "磁盘只读" };
    });
    renderSettings(bridge, { section: "advanced", onReportProblem: () => {} });

    const box = (await screen.findByRole("checkbox", {
      name: "报告中包含我访问过的网站域名",
    })) as HTMLInputElement;
    await waitFor(() => expect(bridge.issueReportPreference).toHaveBeenCalledWith());

    fireEvent.click(box);
    expect(await screen.findByText("没保存成功，设置没有改。")).toBeTruthy();
    expect(box.checked).toBe(false);
  });
});

describe("原生表单与输入法", () => {
  it("组合态回车被拦，普通回车不拦", async () => {
    renderSettings(makeBridge(), { section: "ai" });
    fireEvent.click(await screen.findByRole("button", { name: "添加 AI 服务" }));
    const name = await screen.findByLabelText("名称");

    expect(fireEvent.keyDown(name, { key: "Enter", keyCode: 229 })).toBe(false);
    expect(fireEvent.keyDown(name, { key: "Enter" })).toBe(true);
  });

  it("服务表单里没有行内「问 AI」，只剩顶部「咨询 AI」", async () => {
    renderSettings(makeBridge(), { section: "ai" });
    fireEvent.click(await screen.findByRole("button", { name: "添加 AI 服务" }));
    await screen.findByLabelText("名称");

    expect(screen.queryAllByRole("button", { name: "问 AI" })).toHaveLength(0);
    expect(screen.getByRole("button", { name: "咨询 AI" })).toBeTruthy();
  });
});

describe("咨询 AI 的焦点", () => {
  it("咨询时 aria-modal 去掉，Tab 在设置与助手之间循环", async () => {
    renderSettings(makeBridge(), {
      connectMode: "tun",
      assistant: <input aria-label="助手输入" />,
    });

    fireEvent.click(await screen.findByRole("button", { name: "咨询 AI" }));

    const input = await screen.findByLabelText("助手输入");
    expect(
      document.querySelector(".modal--settings")?.getAttribute("aria-modal"),
    ).toBeNull();

    // 助手输入是 backdrop 里最后一个可聚焦元素：Tab 应回到设置卡的第一个。
    input.focus();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "咨询 AI" }),
    );
  });
});

describe("咨询 AI 的提示词", () => {
  it("从关闭态打开：回调收到带当前分区事实的咨询提示词", async () => {
    const onConsultAi = vi.fn((_prompt: string) => true);
    renderSettings(makeBridge(), {
      connectMode: "system_proxy",
      runtimeView: runtime({ state: "running" }),
      proxyPort: 7891,
      routingMode: "proxy_all",
      onConsultAi,
    });
    await act(async () => {});

    fireEvent.click(await screen.findByRole("button", { name: "咨询 AI" }));

    expect(onConsultAi).toHaveBeenCalledTimes(1);
    const prompt = onConsultAi.mock.calls[0][0] as string;
    expect(prompt).toContain("我在 Veyl 的设置页，当前在「连接」分区");
    expect(prompt).toContain("接管方式：Proxy 模式");
    expect(prompt).toContain("流量范围：全局");
    expect(prompt).toContain("本地代理端口：7891");
    expect(prompt).toContain("节点配置同步间隔：30 分钟");
    // 不再反问模块，也不留占位符。
    expect(prompt).not.toContain("想咨询哪个模块");
    expect(prompt).not.toMatch(/\{\w+\}/);
  });

  it("流量范围按两档给事实，direct 按界面写成智能，旧的三值不再出现", async () => {
    const cases = [
      ["proxy_all", "流量范围：全局"],
      ["direct", "流量范围：智能"],
    ] as const;
    for (const [mode, expected] of cases) {
      const onConsultAi = vi.fn((_prompt: string) => true);
      const view = renderSettings(makeBridge(), { routingMode: mode, onConsultAi });
      fireEvent.click(await screen.findByRole("button", { name: "咨询 AI" }));
      const prompt = onConsultAi.mock.calls[0][0] as string;
      expect(prompt).toContain(expected);
      // 内部值 direct 不能再以「直连」的形态出现在事实里。
      if (mode === "direct") expect(prompt).not.toContain("流量范围：直连");
      view.unmount();
    }

    // 「指定服务走 VPN」已随旧分流下线：旧配置读到 proxy_selected 时不再给这条事实。
    const onConsultAi = vi.fn((_prompt: string) => true);
    const view = renderSettings(makeBridge(), {
      routingMode: "proxy_selected",
      onConsultAi,
    });
    fireEvent.click(await screen.findByRole("button", { name: "咨询 AI" }));
    const prompt = onConsultAi.mock.calls[0][0] as string;
    expect(prompt).not.toContain("指定服务");
    expect(prompt).not.toContain("流量范围：");
    view.unmount();
  });

  it("Tun 模式下端口事实标注当前模式用不到，Proxy 模式下不标注", async () => {
    const cases = [
      ["tun", true],
      ["system_proxy", false],
    ] as const;
    for (const [mode, expectUnused] of cases) {
      const onConsultAi = vi.fn((_prompt: string) => true);
      const view = renderSettings(makeBridge(), {
        connectMode: mode,
        proxyPort: 7891,
        onConsultAi,
      });
      fireEvent.click(await screen.findByRole("button", { name: "咨询 AI" }));
      const prompt = onConsultAi.mock.calls[0][0] as string;
      expect(prompt).toContain("本地代理端口：7891");
      if (expectUnused) {
        expect(prompt).toContain("本地代理端口：7891（当前模式用不到）");
      } else {
        expect(prompt).not.toContain("当前模式用不到");
      }
      view.unmount();
    }
  });

  it("AI 分区事实带服务商、类型与模型，Key 本身不出现", async () => {
    const onConsultAi = vi.fn((_prompt: string) => true);
    renderSettings(makeBridge(), { section: "ai", onConsultAi });
    await act(async () => {});

    fireEvent.click(await screen.findByRole("button", { name: "咨询 AI" }));

    const prompt = onConsultAi.mock.calls[0][0] as string;
    expect(prompt).toContain("服务商：DeepSeek");
    expect(prompt).toContain("接口类型：openai 兼容");
    expect(prompt).toContain("模型：deepseek-chat");
    expect(prompt).not.toMatch(/sk-/);
    expect(prompt).not.toContain("apiKey");
    // 已配置 Key 时不再多写一句状态。
    expect(prompt).not.toContain("尚未配置 Key");
  });

  it("没有 Key 时只写「尚未配置 Key」", async () => {
    const onConsultAi = vi.fn((_prompt: string) => true);
    renderSettings(makeBridge({ providers: [provider({ hasKey: false })] }), {
      section: "ai",
      onConsultAi,
    });
    await act(async () => {});

    fireEvent.click(await screen.findByRole("button", { name: "咨询 AI" }));

    const prompt = onConsultAi.mock.calls[0][0] as string;
    expect(prompt).toContain("尚未配置 Key");
  });

  it("分区名跟着页签走：AI / 高级", async () => {
    const cases = [
      ["ai", "AI"],
      ["advanced", "高级"],
    ] as const;
    for (const [section, label] of cases) {
      const onConsultAi = vi.fn((_prompt: string) => true);
      const view = renderSettings(makeBridge(), { section, onConsultAi });
      fireEvent.click(await screen.findByRole("button", { name: "咨询 AI" }));
      expect(onConsultAi.mock.calls[0][0]).toContain(`当前在「${label}」`);
      view.unmount();
    }
  });

  it("开启态再点只关闭，不再发消息", async () => {
    const onConsultAi = vi.fn((_prompt: string) => true);
    renderSettings(makeBridge(), { connectMode: "tun", onConsultAi });
    await act(async () => {});

    const button = await screen.findByRole("button", { name: "咨询 AI" });
    fireEvent.click(button);
    expect(onConsultAi).toHaveBeenCalledTimes(1);
    expect(button.getAttribute("aria-pressed")).toBe("true");

    fireEvent.click(button);
    expect(onConsultAi).toHaveBeenCalledTimes(1);
    expect(button.getAttribute("aria-pressed")).toBe("false");
  });

  it("回调返回 false：不进入咨询布局", async () => {
    const onConsultAi = vi.fn(() => false);
    const { container } = renderSettings(makeBridge(), {
      connectMode: "tun",
      onConsultAi,
    });
    await act(async () => {});

    const button = await screen.findByRole("button", { name: "咨询 AI" });
    fireEvent.click(button);

    expect(onConsultAi).toHaveBeenCalledTimes(1);
    expect(button.getAttribute("aria-pressed")).toBe("false");
    expect(container.querySelector(".settings-backdrop.is-consulting")).toBeNull();
    expect(container.querySelector(".settings-assistant")).toBeNull();
  });
});
