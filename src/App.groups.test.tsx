/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import { saveAccount } from "./myservers/account";
import { getAgentBridge } from "./agent";
import { AGENT_EVENTS, CONTRACT_VERSION } from "./agent/protocol";
import type { AgentEvent, ConfigSummary, RuntimeSnapshot, RuntimeState } from "./agent/protocol";

const CONFIG_ID = "cfg_1";

const SUMMARY: ConfigSummary = {
  config_id: CONFIG_ID,
  name: "全部流量",
  connect_mode: "tun",
  routing_mode: "proxy_all",
  node_count: 1,
  listen_port: null,
  is_active: true,
  current_node_id: "node_1",
  created_at: 0,
  updated_at: 0,
  last_used_at: null,
};

const bridge = getAgentBridge();
const modeDescriptor = Object.getOwnPropertyDescriptor(bridge, "mode");

let clock = Date.now() - 60_000;

function stateEvent(to: RuntimeState): AgentEvent {
  clock += 1000;
  const at = new Date(clock).toISOString();
  return {
    name: AGENT_EVENTS.runtimeStateChanged,
    payload: {
      contract_version: CONTRACT_VERSION,
      from: "idle",
      to,
      event: to === "running" ? "process_ready" : "stopped",
      pid: null,
      upstream_version: null,
      reason: null,
      error: null,
      snapshot: {
        state: to,
        config_id: to === "running" ? CONFIG_ID : null,
        last_transition_at: at,
      } as RuntimeSnapshot,
      emitted_at: at,
    },
  };
}

function prepare() {
  Object.defineProperty(bridge, "mode", { value: "tauri", configurable: true });
  localStorage.setItem("veyl.onboarding.skipped", "1");
  vi.spyOn(bridge, "configList").mockResolvedValue({
    configs: [SUMMARY],
    active_config_id: CONFIG_ID,
  });
  vi.spyOn(bridge, "configDetail").mockResolvedValue({
    config_id: CONFIG_ID,
    name: SUMMARY.name,
    connect_mode: "tun",
    routing_mode: "proxy_all",
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
  });
  vi.spyOn(bridge, "getRuntimeSnapshot").mockResolvedValue(null);
  vi.spyOn(bridge, "tunHelperInfo").mockResolvedValue({
    runningBuild: null,
    expectedBuild: "2026.11.1",
    stale: false,
    state: "not_running",
    needsAdminRestart: false,
  } as never);
  vi.spyOn(bridge, "myServerCatalog").mockResolvedValue({
    regions: [{ id: "sgp1", name: "新加坡 1", continent: "asia" }],
    plans: [],
    currency: "USD",
    updated_at: new Date(0).toISOString(),
  });
  vi.spyOn(bridge, "myServerList").mockResolvedValue({ servers: [] });
}

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
  if (modeDescriptor) Object.defineProperty(bridge, "mode", modeDescriptor);
});

describe("节点组 destination", () => {
  it("客户端底部节点卡显示当前节点组", async () => {
    prepare();
    render(<App />);

    expect(
      await waitFor(() => {
        const line = document.querySelector(".node-card__group");
        expect(line?.textContent).toBe("组·Veyl 免费节点");
        return line;
      }),
    ).toBeTruthy();
  });

  it("免费组只读；新建组可加节点、移除并激活", async () => {
    prepare();
    render(<App />);
    await screen.findByRole("button", { name: "启动 VPN" });

    fireEvent.click(screen.getByRole("button", { name: "节点组" }));
    expect(await screen.findByRole("heading", { name: "Veyl 免费节点" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "添加节点" })).toBeNull();
    expect(screen.queryByRole("button", { name: "设为当前节点组" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "新建组" }));
    expect(await screen.findByRole("heading", { name: "新组 1" })).toBeTruthy();
    expect(screen.getByText("这个组还没有节点")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "添加节点" }));
    fireEvent.click(screen.getByRole("button", { name: /手动填写/ }));
    expect(await screen.findByText("手动节点 01")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "移除" }));
    expect(screen.queryByText("手动节点 01")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "添加节点" }));
    fireEvent.click(screen.getByRole("button", { name: /粘贴或订阅/ }));
    expect(await screen.findByText("粘贴节点 01")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "设为当前节点组" }));
    expect(await screen.findByText("已设为当前节点组。")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "客户端" }));
    await waitFor(() =>
      expect(document.querySelector(".node-card__group")?.textContent).toBe(
        "组·新组 1",
      ),
    );
  });

  it("已连接时激活只提示，不断开也不重连", async () => {
    prepare();
    const runtimeStart = vi.spyOn(bridge, "runtimeStart");
    render(<App />);
    await screen.findByRole("button", { name: "启动 VPN" });

    act(() => {
      (bridge as unknown as { emit(event: AgentEvent): void }).emit(stateEvent("running"));
    });
    await waitFor(() =>
      expect(document.querySelector(".state-line__label")?.textContent).toContain("已连接"),
    );

    fireEvent.click(screen.getByRole("button", { name: "节点组" }));
    fireEvent.click(await screen.findByRole("button", { name: /我的节点/ }));

    fireEvent.click(await screen.findByRole("button", { name: "设为当前节点组" }));
    expect(
      await screen.findByText(
        "已切到「我的节点」，当前仍连着「Veyl 免费节点」，下次连接生效。",
      ),
    ).toBeTruthy();
    expect(runtimeStart).not.toHaveBeenCalled();
  });

  it("控制台「组 · X」可跳到该组详情", async () => {
    prepare();
    render(<App />);
    await screen.findByRole("button", { name: "启动 VPN" });

    const link = await waitFor(() => {
      const el = document.querySelector(".node-card__group");
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    fireEvent.click(link);

    expect(await screen.findByRole("heading", { name: "Veyl 免费节点" })).toBeTruthy();
    expect(
      screen.getByRole("complementary", { name: "节点组列表" }),
    ).toBeTruthy();
  });

  it("组详情 → 从我的服务器添加 → 加入目标组并回到组详情", async () => {
    prepare();
    saveAccount("me@example.com");
    vi.spyOn(bridge, "myServerList").mockResolvedValue({
      servers: [
        {
          server_id: "srv_1",
          name: "新加坡 1 · DigitalOcean",
          region: "gru",
          plan: "vc2-1c-1gb",
          state: "healthy",
          created_at: new Date(0).toISOString(),
          ip: "45.76.23.103",
          port: 8388,
          node_id: "node_srv_1",
          hourly_usd: 0.007,
          monthly_usd: 5,
          failure: null,
        },
        {
          server_id: "srv_2",
          name: "纽约 1 · DigitalOcean",
          region: "lax",
          plan: "vc2-1c-1gb",
          state: "installing",
          created_at: new Date(0).toISOString(),
          ip: "45.76.21.101",
          port: null,
          node_id: null,
          hourly_usd: 0.007,
          monthly_usd: 5,
          failure: null,
        },
      ],
    });
    render(<App />);
    await screen.findByRole("button", { name: "启动 VPN" });

    fireEvent.click(screen.getByRole("button", { name: "节点组" }));
    fireEvent.click(await screen.findByRole("button", { name: /我的节点/ }));
    fireEvent.click(await screen.findByRole("button", { name: "添加节点" }));
    fireEvent.click(screen.getByRole("button", { name: /从我的服务器添加/ }));

    expect(
      await screen.findByText("选择一台服务器，把节点加入「我的节点」"),
    ).toBeTruthy();
    expect(
      screen.getByRole("complementary", { name: "服务器列表" }),
    ).toBeTruthy();

    // 安装中的那台不给加入动作。
    fireEvent.click(screen.getByRole("button", { name: /纽约 1 · DigitalOcean/ }));
    expect(screen.queryByRole("button", { name: "加入「我的节点」" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /新加坡 1 · DigitalOcean/ }));
    fireEvent.click(await screen.findByRole("button", { name: "加入「我的节点」" }));

    expect(await screen.findByRole("heading", { name: "我的节点" })).toBeTruthy();
    expect(await screen.findByText("新加坡 1 01")).toBeTruthy();
    expect(screen.queryByText(/选择一台服务器/)).toBeNull();
  });
});
