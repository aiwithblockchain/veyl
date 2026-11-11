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

const CONFIG_ID = "cfg_tun_stop";

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

function makeSnapshot(state: RuntimeState): RuntimeSnapshot {
  return {
    contract_version: "2.0.0",
    state,
    mode: "tun",
    pid: state === "running" || state === "degraded" ? 123 : null,
    upstream_version: "1.14.4",
    uptime_seconds: null,
    config_id: CONFIG_ID,
    config_name: DETAIL.name,
    node_id: "node_1",
    node_name: "东京 01",
    config_hash: null,
    system_proxy_enabled: false,
    system_dns: null,
    health: emptyRuntimeView().health,
    traffic: null,
    connections: null,
    restart_count: 0,
    last_error: null,
    last_transition_at: "",
    mixed_port: null,
    port_fallback: null,
    connected_since: null,
    latency_ms: null,
    node_latency_ms: null,
    applied_route_revision: null,
    route_region: null,
    direct_ip: null,
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

function prepareBridge() {
  Object.defineProperty(bridge, "mode", { value: "tauri", configurable: true });
  localStorage.setItem("veyl.onboarding.skipped", "1");
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
  vi.spyOn(bridge, "runtimeStart").mockResolvedValue(undefined);
}

function emit(event: AgentEvent) {
  (bridge as unknown as { emit(event: AgentEvent): void }).emit(event);
}

async function connect(container: HTMLElement) {
  const start = await screen.findByRole("button", { name: "启动 VPN" });
  fireEvent.click(start);
  await waitFor(() =>
    expect(container.querySelector(".state-line__label")?.textContent).toContain("已连接"),
  );
}

describe("断开成功后的界面状态", () => {
  it("断开成功后控制台显示未连接", async () => {
    prepareBridge();
    vi.spyOn(bridge, "runtimeStop").mockResolvedValue(undefined);

    const { container } = render(<App />);
    await connect(container);

    fireEvent.click(screen.getByRole("button", { name: "断开 VPN" }));

    await waitFor(() =>
      expect(container.querySelector(".state-word")?.textContent).toContain("未连接"),
    );
    expect(container.querySelector(".state-line__label")).toBeNull();
  }, 15_000);

  it("断开期间迟到的 running 事件不会把界面推回已连接", async () => {
    prepareBridge();
    let snapshot: RuntimeSnapshot | null = null;
    vi.spyOn(bridge, "getRuntimeSnapshot").mockImplementation(async () => snapshot);
    const gate = deferred<void>();
    vi.spyOn(bridge, "runtimeStop").mockImplementation(() => gate.promise);

    const { container } = render(<App />);
    await connect(container);

    fireEvent.click(screen.getByRole("button", { name: "断开 VPN" }));
    await waitFor(() =>
      expect(container.querySelector(".connection-overlay")?.textContent).toContain(
        "正在断开连接",
      ),
    );

    // 先让界面进入断开中，再来一个迟到的 running 事件。
    snapshot = makeSnapshot("stopping");
    act(() => {
      emit(stateEvent("running", "stopping"));
    });
    await waitFor(() =>
      expect(container.querySelector(".state-word")?.textContent).toContain("正在断开"),
    );

    act(() => {
      emit(stateEvent("stopping", "running"));
    });
    // 迟到的在线事件被忽略，遮罩还在、顶部没翻回已连接。
    expect(container.querySelector(".connection-overlay")).not.toBeNull();
    expect(container.querySelector(".state-word")?.textContent).toContain("正在断开");
    expect(container.querySelector(".state-line__label")).toBeNull();

    snapshot = makeSnapshot("idle");
    await act(async () => {
      gate.resolve();
    });
    await waitFor(() =>
      expect(container.querySelector(".state-word")?.textContent).toContain("未连接"),
    );
  }, 15_000);

  it("断开失败保持已连接并报错", async () => {
    prepareBridge();
    vi.spyOn(bridge, "runtimeStop").mockRejectedValue({
      code: "INTERNAL",
      message: "断开失败",
    });

    const { container } = render(<App />);
    await connect(container);

    fireEvent.click(screen.getByRole("button", { name: "断开 VPN" }));

    await waitFor(() =>
      expect(container.querySelector(".app-toast")?.textContent).toContain("断开失败"),
    );
    expect(container.querySelector(".state-line__label")?.textContent).toContain("已连接");
    expect(container.querySelector(".state-word")).toBeNull();
  }, 15_000);
});
