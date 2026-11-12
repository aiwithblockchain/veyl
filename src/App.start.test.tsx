/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import { emptyRuntimeView, getAgentBridge } from "./agent";
import { AGENT_EVENTS, CONTRACT_VERSION } from "./agent/protocol";
import type { AgentEvent, ConfigDetail, ConfigSummary, RuntimeState } from "./agent/protocol";

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

function stateEvent(from: RuntimeState, to: RuntimeState): AgentEvent {
  return {
    name: AGENT_EVENTS.runtimeStateChanged,
    payload: {
      contract_version: CONTRACT_VERSION,
      from,
      to,
      event: "stopped",
      pid: null,
      upstream_version: null,
      reason: null,
      error: null,
      snapshot: {} as never,
      emitted_at: "",
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
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

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
  if (modeDescriptor) Object.defineProperty(bridge, "mode", modeDescriptor);
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
    vi.spyOn(bridge, "runtimeStart").mockImplementation(() => gate.promise as Promise<void>);
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
    vi.spyOn(bridge, "runtimeStart").mockResolvedValue(undefined);

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

  it("后台助手没被允许时弹引导，不显示安装失败 toast", async () => {
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
    vi.spyOn(bridge, "runtimeStart").mockRejectedValue({
      code: "PRECONDITION_FAILED",
      message: "安装后台助手失败",
      details: { reason: "helper_unavailable" },
    });
    vi.spyOn(bridge, "runtimeStop").mockResolvedValue(undefined);
    const openSettings = vi.spyOn(bridge, "tunHelperOpenSettings").mockResolvedValue(undefined);

    const { container } = render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "启动 VPN" }));

    expect(await screen.findByRole("dialog", { name: "需要允许后台助手" })).toBeTruthy();
    expect(container.querySelector(".app-toast")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "打开系统设置" }));
    await waitFor(() => expect(openSettings).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
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
