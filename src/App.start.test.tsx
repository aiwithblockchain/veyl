/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import { emptyRuntimeView, getAgentBridge } from "./agent";
import { AGENT_EVENTS, CONTRACT_VERSION } from "./agent/protocol";
import type {
  AgentEvent,
  ConfigDetail,
  ConfigSummary,
  RuntimeSnapshot,
  RuntimeState,
} from "./agent/protocol";
import type { RuntimeStartResult } from "./agent/bridge";
import { PANEL_VERSION } from "./ui/panelPreference";

const CONFIG_ID = "cfg_tun_1";

const DETAIL: ConfigDetail = {
  config_id: CONFIG_ID,
  name: "全部流量",
  connect_mode: "tun",
  routing_mode: "direct",
  node_count: 1,
  listen_port: null,
  is_active: true,
  current_node_id: "node_1",
  created_at: 0,
  updated_at: 0,
  last_used_at: null,
  nodes: [
    {
      node_id: "node_1",
      name: "东京 01",
      server: "203.0.113.1",
      port: 8388,
      method: "aes-128-gcm",
      protocol: "shadowsocks",
      source: "seed",
      created_at: 0,
    },
  ],
  dns: { mode: "auto", local: [], remote: [] },
  tun_excludes: [],
  layout: null,
  layout_revision: null,
};

const SUMMARY: ConfigSummary = {
  config_id: DETAIL.config_id,
  name: DETAIL.name,
  connect_mode: DETAIL.connect_mode,
  routing_mode: DETAIL.routing_mode,
  node_count: DETAIL.node_count,
  listen_port: DETAIL.listen_port,
  is_active: true,
  current_node_id: DETAIL.current_node_id,
  created_at: 0,
  updated_at: 0,
  last_used_at: null,
};

let appClock = Date.now() - 60_000;

function stateEvent(
  from: RuntimeState,
  to: RuntimeState,
  configId: string | null = CONFIG_ID,
): AgentEvent {
  appClock += 1000;
  const at = new Date(appClock).toISOString();
  return {
    name: AGENT_EVENTS.runtimeStateChanged,
    payload: {
      contract_version: CONTRACT_VERSION,
      from,
      to,
      event:
        to === "running"
          ? "process_ready"
          : to === "stopping"
            ? "stop_req"
            : "stopped",
      pid: null,
      upstream_version: null,
      reason: null,
      error: null,
      snapshot: {
        state: to,
        config_id:
          to === "running" || to === "degraded" ? configId : null,
        last_transition_at: at,
      } as RuntimeSnapshot,
      emitted_at: at,
    },
  };
}

/** runtime_start 的返回：默认按成功连上。 */
function startResult(
  configId: string | null = CONFIG_ID,
  state: RuntimeState = "running",
): RuntimeStartResult {
  return {
    state,
    config_id: state === "running" || state === "degraded" ? configId : null,
    last_transition_at: new Date(appClock).toISOString(),
  } as RuntimeStartResult;
}

function deferred<T>() {  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function requestEnd(
  requestId: string,
  result: "success" | "error" | "cancelled",
): AgentEvent {
  return {
    name: AGENT_EVENTS.requestEnd,
    payload: {
      contract_version: CONTRACT_VERSION,
      request_id: requestId,
      assistant_message_id: "m_1",
      result,
      final_text: null,
      error: null,
      usage: null,
      duration_ms: 1,
      emitted_at: "",
    },
  };
}

function healthEvent(): AgentEvent {
  return {
    name: AGENT_EVENTS.runtimeHealthChanged,
    payload: {
      contract_version: CONTRACT_VERSION,
      health: emptyRuntimeView().health,
      emitted_at: "",
    },
  };
}

const bridge = getAgentBridge();
const modeDescriptor = Object.getOwnPropertyDescriptor(bridge, "mode");
const widthDescriptor = Object.getOwnPropertyDescriptor(window, "innerWidth");

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
  if (modeDescriptor) Object.defineProperty(bridge, "mode", modeDescriptor);
  if (widthDescriptor) {
    Object.defineProperty(window, "innerWidth", widthDescriptor);
  } else {
    Object.defineProperty(window, "innerWidth", { value: 1024, configurable: true });
  }
});

function renderStartWithFailure(error: unknown) {
  Object.defineProperty(bridge, "mode", { value: "tauri", configurable: true });
  localStorage.setItem("veyl.onboarding.skipped", "1");

  vi.spyOn(bridge, "configList").mockResolvedValue({
    configs: [SUMMARY],
    active_config_id: CONFIG_ID,
  });
  vi.spyOn(bridge, "configDetail").mockResolvedValue(DETAIL);
  vi.spyOn(bridge, "getRuntimeSnapshot").mockResolvedValue(null);
  vi.spyOn(bridge, "tunHelperInfo").mockResolvedValue({
    runningBuild: null,
    expectedBuild: "2026.11.1",
    stale: false,
    state: "not_running",
    needsAdminRestart: false,
  } as never);
  vi.spyOn(bridge, "runtimeStart").mockRejectedValue(error);
  vi.spyOn(bridge, "runtimeStop").mockResolvedValue(undefined);
  return render(<App />);
}

describe("切换配置只改 active", () => {
  function setupTwoConfigs() {
    Object.defineProperty(bridge, "mode", { value: "tauri", configurable: true });
    localStorage.setItem("veyl.onboarding.skipped", "1");

    const base = {
      ...SUMMARY,
      connect_mode: "system_proxy" as const,
      listen_port: 7890,
    };
    const firstSummary = { ...base, config_id: CONFIG_ID, name: "全部流量", is_active: true };
    const secondSummary = {
      ...base,
      config_id: "cfg_proxy_2",
      name: "家里",
      is_active: false,
    };
    const thirdSummary = {
      ...base,
      config_id: "cfg_proxy_3",
      name: "公司",
      is_active: false,
    };
    const detailOf = (summary: ConfigSummary): ConfigDetail => ({
      ...DETAIL,
      config_id: summary.config_id,
      name: summary.name,
      connect_mode: summary.connect_mode,
      listen_port: summary.listen_port,
      is_active: summary.is_active,
    });
    const summaries = [firstSummary, secondSummary, thirdSummary];
    let activeId = CONFIG_ID;

    vi.spyOn(bridge, "configList").mockImplementation(async () => ({
      configs: summaries.map((summary) => ({
        ...summary,
        is_active: summary.config_id === activeId,
      })),
      active_config_id: activeId,
    }));
    vi.spyOn(bridge, "configDetail").mockImplementation(async (configId: string) => {
      const summary = summaries.find((item) => item.config_id === configId);
      return summary ? detailOf(summary) : DETAIL;
    });
    vi.spyOn(bridge, "getRuntimeSnapshot").mockResolvedValue(null);
    const activate = vi
      .spyOn(bridge, "configActivate")
      .mockImplementation(async (configId: string) => {
        activeId = configId;
        return { active_config_id: configId, runtime: {} as RuntimeSnapshot };
      });
    return { firstSummary, secondSummary, thirdSummary, activate };
  }

  it("已连接时切换：不弹确认、不断开，提示仍连着哪套", async () => {
    const { secondSummary, activate } = setupTwoConfigs();

    render(<App />);
    await screen.findByText("全部流量", { selector: ".config__name-text" });
    act(() => {
      (bridge as unknown as { emit(event: AgentEvent): void }).emit(
        stateEvent("idle", "running"),
      );
    });
    await waitFor(() =>
      expect(document.querySelector(".state-line__label")?.textContent).toContain(
        "已连接",
      ),
    );

    fireEvent.click(screen.getByText("家里", { selector: ".config__name-text" }));

    await waitFor(() =>
      expect(activate).toHaveBeenCalledWith(secondSummary.config_id),
    );
    expect(activate).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog", { name: "切换配置" })).toBeNull();
    expect(
      await screen.findByText(
        "已切到「家里」，当前仍连着「全部流量」。点连接会先断开再连。",
      ),
    ).toBeTruthy();
    expect(document.querySelector(".state-line__label")?.textContent).toContain(
      "已连接",
    );
  }, 15_000);

  it("已连接时主按钮变成连接新配置，点一次只启动一次", async () => {
    const { secondSummary } = setupTwoConfigs();
    const start = vi.spyOn(bridge, "runtimeStart").mockResolvedValue(startResult());
    vi.spyOn(bridge, "runtimeStop").mockResolvedValue(undefined);

    render(<App />);
    await screen.findByText("全部流量", { selector: ".config__name-text" });
    act(() => {
      (bridge as unknown as { emit(event: AgentEvent): void }).emit(
        stateEvent("idle", "running"),
      );
    });
    await waitFor(() =>
      expect(document.querySelector(".state-line__label")?.textContent).toContain(
        "已连接",
      ),
    );

    fireEvent.click(screen.getByText("家里", { selector: ".config__name-text" }));
    await waitFor(() =>
      expect(screen.getByText("当前连接：全部流量")).toBeTruthy(),
    );

    const connect = screen.getByRole("button", {
      name: "连接 VPN",
    });
    fireEvent.click(connect);

    await waitFor(() =>
      expect(start).toHaveBeenCalledWith(secondSummary.config_id),
    );
    expect(start).toHaveBeenCalledTimes(1);
  }, 15_000);

  it("正在连接时切换：提示按真正的启动配置取名，不随 active 抖动", async () => {
    const { secondSummary, thirdSummary, activate } = setupTwoConfigs();
    const gate = deferred<unknown>();
    vi.spyOn(bridge, "runtimeStart").mockImplementation(
      () => gate.promise as unknown as Promise<RuntimeStartResult>,
    );
    vi.spyOn(bridge, "runtimeStop").mockResolvedValue(undefined);

    render(<App />);
    await screen.findByText("全部流量", { selector: ".config__name-text" });
    fireEvent.click(await screen.findByRole("button", { name: "启动 VPN" }));
    await waitFor(() => expect(bridge.runtimeStart).toHaveBeenCalledTimes(1));
    act(() => {
      (bridge as unknown as { emit(event: AgentEvent): void }).emit(
        stateEvent("idle", "starting"),
      );
    });
    await waitFor(() =>
      expect(document.querySelector(".state-word")?.textContent).toContain(
        "正在连接",
      ),
    );

    fireEvent.click(screen.getByText("家里", { selector: ".config__name-text" }));
    await waitFor(() =>
      expect(activate).toHaveBeenCalledWith(secondSummary.config_id),
    );
    expect(
      await screen.findByText("已切到「家里」，正在连接的是「全部流量」。"),
    ).toBeTruthy();

    fireEvent.click(screen.getByText("公司", { selector: ".config__name-text" }));
    await waitFor(() =>
      expect(activate).toHaveBeenCalledWith(thirdSummary.config_id),
    );
    expect(
      await screen.findByText("已切到「公司」，正在连接的是「全部流量」。"),
    ).toBeTruthy();

    await act(async () => {
      gate.resolve({});
    });
  }, 15_000);

  it("正在连接 A 时切到 B：hero 说明在连谁，主按钮能连 B", async () => {
    const { secondSummary, activate } = setupTwoConfigs();
    const gate = deferred<RuntimeStartResult>();
    const start = vi
      .spyOn(bridge, "runtimeStart")
      .mockImplementation(() => gate.promise);
    vi.spyOn(bridge, "runtimeStop").mockResolvedValue(undefined);

    render(<App />);
    await screen.findByText("全部流量", { selector: ".config__name-text" });
    fireEvent.click(await screen.findByRole("button", { name: "启动 VPN" }));
    await waitFor(() => expect(start).toHaveBeenCalledTimes(1));
    act(() => {
      (bridge as unknown as { emit(event: AgentEvent): void }).emit(
        stateEvent("idle", "starting"),
      );
    });
    await waitFor(() =>
      expect(document.querySelector(".state-word")?.textContent).toContain(
        "正在连接",
      ),
    );

    fireEvent.click(screen.getByText("家里", { selector: ".config__name-text" }));
    await waitFor(() =>
      expect(activate).toHaveBeenCalledWith(secondSummary.config_id),
    );
    expect(await screen.findByText("正在连接：全部流量")).toBeTruthy();

    fireEvent.click(
      screen.getByRole("button", { name: "连接 VPN" }),
    );
    await waitFor(() => expect(start).toHaveBeenCalledTimes(2));
    expect(start.mock.calls[1][0]).toBe(secondSummary.config_id);

    await act(async () => {
      gate.resolve(startResult(secondSummary.config_id));
    });
  }, 15_000);

  it("切回正在连着的那套：不提示", async () => {
    const { activate } = setupTwoConfigs();

    render(<App />);
    await screen.findByText("全部流量", { selector: ".config__name-text" });
    act(() => {
      (bridge as unknown as { emit(event: AgentEvent): void }).emit(
        stateEvent("idle", "running"),
      );
    });
    await waitFor(() =>
      expect(document.querySelector(".state-line__label")?.textContent).toContain(
        "已连接",
      ),
    );

    fireEvent.click(screen.getByText("家里", { selector: ".config__name-text" }));
    await waitFor(() =>
      expect(screen.getByText(/已切到「家里」/)).toBeTruthy(),
    );

    fireEvent.click(screen.getByText("全部流量", { selector: ".config__name-text" }));
    await waitFor(() => expect(activate).toHaveBeenCalledTimes(2));
    await act(async () => {});

    expect(screen.queryByText(/已切到「全部流量」/)).toBeNull();
  }, 15_000);

  it("连接身份未知时：只说还有一条连接，不编名字", async () => {
    const { secondSummary, activate } = setupTwoConfigs();

    render(<App />);
    await screen.findByText("全部流量", { selector: ".config__name-text" });
    act(() => {
      (bridge as unknown as { emit(event: AgentEvent): void }).emit(
        stateEvent("idle", "running", null),
      );
    });
    await waitFor(() =>
      expect(document.querySelector(".state-line__label")?.textContent).toContain(
        "已连接",
      ),
    );

    fireEvent.click(screen.getByText("家里", { selector: ".config__name-text" }));
    await waitFor(() =>
      expect(activate).toHaveBeenCalledWith(secondSummary.config_id),
    );

    expect(
      await screen.findByText("已切到「家里」，当前仍有一条连接。点连接会先断开再连。"),
    ).toBeTruthy();
  }, 15_000);

  it("断开时切换：不弹也不提示", async () => {
    const { secondSummary, activate } = setupTwoConfigs();

    render(<App />);
    await screen.findByText("全部流量", { selector: ".config__name-text" });

    fireEvent.click(screen.getByText("家里", { selector: ".config__name-text" }));

    await waitFor(() =>
      expect(activate).toHaveBeenCalledWith(secondSummary.config_id),
    );
    await act(async () => {});
    expect(screen.queryByRole("dialog", { name: "切换配置" })).toBeNull();
    expect(screen.queryByText(/已切到/)).toBeNull();
  }, 15_000);
});

describe("TUN 启动成功后的界面状态", () => {
  it("runtimeStart 挂起时来了 failed 事件，成功后仍显示已连接", async () => {
    // 用真实分支（非 mock）跑 App；桥本身仍是 mock 实现。
    Object.defineProperty(bridge, "mode", { value: "tauri", configurable: true });
    localStorage.setItem("veyl.onboarding.skipped", "1");

    const gate = deferred<unknown>();
    vi.spyOn(bridge, "configList").mockResolvedValue({
      configs: [SUMMARY],
      active_config_id: CONFIG_ID,
    });
    vi.spyOn(bridge, "configDetail").mockResolvedValue(DETAIL);
    vi.spyOn(bridge, "getRuntimeSnapshot").mockResolvedValue(null);
    vi.spyOn(bridge, "tunHelperInfo").mockResolvedValue({
      runningBuild: "2026.11.1",
      expectedBuild: "2026.11.1",
      stale: false,
      state: "running",
      needsAdminRestart: false,
    } as never);
    vi.spyOn(bridge, "runtimeStart").mockImplementation(() => gate.promise as unknown as Promise<RuntimeStartResult>);
    vi.spyOn(bridge, "runtimeStop").mockResolvedValue(undefined);

    const { container } = render(<App />);
    const start = await screen.findByRole("button", { name: "启动 VPN" });
    fireEvent.click(start);

    await waitFor(() => expect(bridge.runtimeStart).toHaveBeenCalledTimes(1));

    // 28 秒里后端先报了一个非 running 的状态：界面此时会变成失败。
    act(() => {
      (bridge as unknown as { emit(event: AgentEvent): void }).emit(
        stateEvent("starting", "failed"),
      );
    });
    await waitFor(() =>
      expect(container.querySelector(".state-word")?.textContent).toContain("连接失败"),
    );

    // runtimeStart 最终成功：必须回到已连接，而不是停在失败。
    await act(async () => {
      gate.resolve({});
    });

    await waitFor(() =>
      expect(container.querySelector(".state-line__label")?.textContent).toContain("已连接"),
    );
    expect(container.querySelector(".state-word")).toBeNull();
  }, 15_000);

  it("连接态的健康事件最多每 5 秒补拉一次快照", async () => {
    Object.defineProperty(bridge, "mode", { value: "tauri", configurable: true });
    localStorage.setItem("veyl.onboarding.skipped", "1");

    vi.spyOn(bridge, "configList").mockResolvedValue({
      configs: [SUMMARY],
      active_config_id: CONFIG_ID,
    });
    vi.spyOn(bridge, "configDetail").mockResolvedValue(DETAIL);
    const snapshots = vi.spyOn(bridge, "getRuntimeSnapshot").mockResolvedValue(null);
    vi.spyOn(bridge, "tunHelperInfo").mockResolvedValue({
      runningBuild: "2026.11.1",
      expectedBuild: "2026.11.1",
      stale: false,
      state: "running",
      needsAdminRestart: false,
    } as never);
    vi.spyOn(bridge, "runtimeStart").mockResolvedValue(startResult());

    const { container } = render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "启动 VPN" }));
    await waitFor(() =>
      expect(container.querySelector(".state-line__label")?.textContent).toContain("已连接"),
    );

    const base = Date.now();
    const before = snapshots.mock.calls.length;
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(base + 4_000);
    act(() => {
      (bridge as unknown as { emit(event: AgentEvent): void }).emit(healthEvent());
    });
    await act(async () => {});
    expect(snapshots.mock.calls.length).toBe(before);

    nowSpy.mockReturnValue(base + 6_000);
    act(() => {
      (bridge as unknown as { emit(event: AgentEvent): void }).emit(healthEvent());
    });
    await act(async () => {});
    expect(snapshots.mock.calls.length).toBe(before + 1);
  }, 15_000);

  it("dev_unbundled 不弹引导，只说要换打包后的 App", async () => {
    const { container } = renderStartWithFailure({
      code: "PRECONDITION_FAILED",
      message:
        "当前是未打包的调试进程，系统不认这个后台助手；请用 bash scripts/dev/tun-dev.sh 启动打包后的 Veyl.app。代理模式与直连仍可用。",
      details: { reason: "dev_unbundled" },
    });
    fireEvent.click(await screen.findByRole("button", { name: "启动 VPN" }));

    await waitFor(() =>
      expect(container.querySelector(".app-toast")?.textContent).toContain("tun-dev.sh"),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  }, 15_000);

  it("helper_missing 不弹引导，原样显示后端的失败原因", async () => {
    const { container } = renderStartWithFailure({
      code: "PRECONDITION_FAILED",
      message: "安装后台助手失败",
      details: { reason: "helper_missing" },
    });
    fireEvent.click(await screen.findByRole("button", { name: "启动 VPN" }));

    await waitFor(() =>
      expect(container.querySelector(".app-toast")?.textContent).toContain("安装后台助手失败"),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  }, 15_000);

  it("tun_denied 也打开引导，不显示 toast", async () => {
    const { container } = renderStartWithFailure({
      code: "PRECONDITION_FAILED",
      message: "需要你在「系统设置 › 登录项与扩展」里允许 Veyl 的后台助手",
      details: { reason: "tun_denied" },
    });
    fireEvent.click(await screen.findByRole("button", { name: "启动 VPN" }));

    expect(await screen.findByRole("dialog", { name: "需要允许后台助手" })).toBeTruthy();
    expect(container.querySelector(".app-toast")).toBeNull();
  }, 15_000);

  it("helper_busy 不打开引导，只报提示", async () => {
    const { container } = renderStartWithFailure({
      code: "PRECONDITION_FAILED",
      retryable: true,
      message: "后台组件正在准备，请稍后再试",
      details: { reason: "helper_busy" },
    });
    fireEvent.click(await screen.findByRole("button", { name: "启动 VPN" }));

    await waitFor(() =>
      expect(container.querySelector(".app-toast")?.textContent).toContain("后台组件正在准备"),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  }, 15_000);

  it("helper_file_invalid 不打开引导，只报重装提示", async () => {
    const { container } = renderStartWithFailure({
      code: "PRECONDITION_FAILED",
      message: "后台组件文件不可用（验签未通过），请重新安装 Veyl。代理模式与直连仍可用。",
      details: { reason: "helper_file_invalid" },
    });
    fireEvent.click(await screen.findByRole("button", { name: "启动 VPN" }));

    await waitFor(() =>
      expect(container.querySelector(".app-toast")?.textContent).toContain("重新安装"),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  }, 15_000);

  it("未知 reason 不打开引导", async () => {
    const { container } = renderStartWithFailure({
      code: "PRECONDITION_FAILED",
      message: "无法建立后台组件会话租约，暂时不能接管全部流量。",
      details: { reason: "helper_lease_unavailable" },
    });
    fireEvent.click(await screen.findByRole("button", { name: "启动 VPN" }));

    await waitFor(() =>
      expect(container.querySelector(".app-toast")?.textContent).toContain("租约"),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  }, 15_000);
});

function setupAi(ready: boolean) {
  Object.defineProperty(bridge, "mode", { value: "tauri", configurable: true });
  Object.defineProperty(window, "innerWidth", { value: 1440, configurable: true });
  localStorage.setItem("veyl.onboarding.skipped", "1");
  vi.spyOn(bridge, "configList").mockResolvedValue({
    configs: [SUMMARY],
    active_config_id: CONFIG_ID,
  });
  vi.spyOn(bridge, "configDetail").mockResolvedValue(DETAIL);
  vi.spyOn(bridge, "getRuntimeSnapshot").mockResolvedValue(null);
  vi.spyOn(bridge, "tunHelperInfo").mockResolvedValue({
    runningBuild: null,
    expectedBuild: "2026.11.1",
    stale: false,
    state: "not_running",
    needsAdminRestart: false,
  } as never);
  vi.spyOn(bridge, "getDeepSeekKey").mockResolvedValue(
    (ready
      ? { masked: "sk-****abcd", verified: true, validation: "ok" }
      : { masked: null, verified: false, validation: "unverified" }) as never,
  );
  vi.spyOn(bridge, "llmProviderList").mockResolvedValue({
    providers: ready
      ? [
          {
            providerId: "deepseek",
            name: "DeepSeek",
            protocol: "openai",
            baseUrl: "https://api.deepseek.com",
            model: "deepseek-chat",
            hasKey: true,
            isActive: true,
            isBuiltin: true,
          },
        ]
      : [],
    activeProviderId: ready ? "deepseek" : null,
  } as never);
  return {
    sendMessage: vi.spyOn(bridge, "sendMessage").mockResolvedValue({
      requestId: "req_new_config",
    }),
  };
}

describe("新建配置入口", () => {
  it("AI 已就绪时进 AI 对话，不弹静态表单；连点只开一条", async () => {
    const { sendMessage } = setupAi(true);
    // 先收起右栏，才能证明是入口把它打开的。
    localStorage.setItem("veyl.ui.panelOpen", "0");
    localStorage.setItem("veyl.ui.panelVersion", PANEL_VERSION);
    const { container } = render(<App />);
    await waitFor(() => expect(bridge.getDeepSeekKey).toHaveBeenCalled());
    await act(async () => {});
    expect(container.querySelector(".assistant-slot")).toBeNull();

    const entry = await screen.findByRole("button", { name: "新建配置" });
    fireEvent.click(entry);
    fireEvent.click(entry);

    await waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
    expect(container.querySelector(".assistant-slot")).toBeTruthy();
    expect(container.querySelector(".modal.new-config")).toBeNull();

    const call = (sendMessage as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[1]).toBe("帮我新建一套配置。");
    expect((call[2] as { hidden?: boolean }).hidden).toBeFalsy();
    expect(container.querySelectorAll(".msg--user")).toHaveLength(1);
  }, 15_000);

  it("开场没发出去时回退到手动表单", async () => {
    const { sendMessage } = setupAi(true);
    sendMessage.mockRejectedValue({ code: "INTERNAL", message: "AI 服务连不上" });
    const { container } = render(<App />);
    await waitFor(() => expect(bridge.getDeepSeekKey).toHaveBeenCalled());
    await act(async () => {});

    fireEvent.click(await screen.findByRole("button", { name: "新建配置" }));

    await waitFor(() =>
      expect(container.querySelector(".modal.new-config")).toBeTruthy(),
    );
    expect(screen.getByText("怎么接管")).toBeTruthy();
  }, 15_000);

  it("后台把开场判为失败时回退表单并提示", async () => {
    const { sendMessage } = setupAi(true);
    const { container } = render(<App />);
    await waitFor(() => expect(bridge.getDeepSeekKey).toHaveBeenCalled());
    await act(async () => {});

    fireEvent.click(await screen.findByRole("button", { name: "新建配置" }));
    await waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
    await act(async () => {});

    act(() => {
      (bridge as unknown as { emit(event: AgentEvent): void }).emit(
        requestEnd("req_new_config", "error"),
      );
    });

    await waitFor(() =>
      expect(container.querySelector(".modal.new-config")).toBeTruthy(),
    );
    expect(screen.getByText("AI 没接上，先用表单建一套。")).toBeTruthy();
    expect(sendMessage).toHaveBeenCalledTimes(1);
  }, 15_000);

  it.each(["success", "cancelled"] as const)(
    "开场请求以 %s 结束时不弹表单",
    async (result) => {
      const { sendMessage } = setupAi(true);
      const { container } = render(<App />);
      await waitFor(() => expect(bridge.getDeepSeekKey).toHaveBeenCalled());
      await act(async () => {});

      fireEvent.click(await screen.findByRole("button", { name: "新建配置" }));
      await waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
      await act(async () => {});

      act(() => {
        (bridge as unknown as { emit(event: AgentEvent): void }).emit(
          requestEnd("req_new_config", result),
        );
      });
      await act(async () => {});

      expect(container.querySelector(".modal.new-config")).toBeNull();
      expect(screen.queryByText("AI 没接上，先用表单建一套。")).toBeNull();
    },
    15_000,
  );

  it("没有 AI 时仍弹两问表单", async () => {
    setupAi(false);
    const { container } = render(<App />);
    await waitFor(() => expect(bridge.getDeepSeekKey).toHaveBeenCalled());
    await act(async () => {});

    fireEvent.click(await screen.findByRole("button", { name: "新建配置" }));

    expect(container.querySelector(".modal.new-config")).toBeTruthy();
    expect(screen.getByText("怎么接管")).toBeTruthy();
  }, 15_000);
});
