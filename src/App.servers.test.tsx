/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import App from "./App";
import { getAgentBridge } from "./agent";
import type { MyServer, MyServerCredentialNode } from "./agent/bridge";
import type { ConfigSummary } from "./agent/protocol";
import { DESTINATION_KEY, DESTINATION_VERSION, DESTINATION_VERSION_KEY } from "./ui/destination";

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

const SERVER: MyServer = {
  server_id: "srv_1",
  name: "新加坡 1 · DigitalOcean",
  region: "nrt",
  plan: "vc2-1c-1gb",
  state: "healthy",
  created_at: new Date(0).toISOString(),
  ip: "45.76.20.100",
  port: 8388,
  node_id: "node_srv_1",
  hourly_usd: 0.007,
  monthly_usd: 5,
  daily_price_cents: 30,
  paid_until: new Date(86_400_000).toISOString(),
  billing_state: "active",
  grace_ends_at: null,
  transfer_gib: 1000,
  failure: null,
};

const bridge = getAgentBridge();
const modeDescriptor = Object.getOwnPropertyDescriptor(bridge, "mode");

function prepare(servers: MyServer[] = []) {
  Object.defineProperty(bridge, "mode", { value: "tauri", configurable: true });
  vi.spyOn(bridge, "getDeepSeekKey").mockResolvedValue({
    masked: "sk-****abcd",
    verified: true,
    validation: "ok",
  });
  vi.spyOn(bridge, "trialStatus").mockResolvedValue({
    state: "active",
    started_at: new Date(0).toISOString(),
    expires_at: new Date(7 * 86_400_000).toISOString(),
    remaining_ms: 7 * 86_400_000,
    seed_node_count: 1,
  });
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
    plans: [
      {
        id: "s-1vcpu-512mb-10gb",
        label: "1 核 · 512 MB",
        hourly_usd: 0.00595,
        monthly_usd: 6,
        daily_price_cents: 20,
        transfer_gib: 500,
      },
      {
        id: "s-1vcpu-1gb",
        label: "1 核 · 1 GB",
        hourly_usd: 0.00893,
        monthly_usd: 9,
        daily_price_cents: 30,
        transfer_gib: 1000,
      },
      {
        id: "s-1vcpu-2gb",
        label: "1 核 · 2 GB",
        hourly_usd: 0.01786,
        monthly_usd: 18,
        daily_price_cents: 60,
        transfer_gib: 2000,
      },
    ],
    currency: "USD",
    updated_at: new Date(0).toISOString(),
  });
  vi.spyOn(bridge, "myServerAccount").mockResolvedValue({
    logged_in: true,
    email: "me@example.com",
    account_id: "acct_1",
    device_id: "dev_1",
    account_kind: "email",
  });
  vi.spyOn(bridge, "myServerWallet").mockResolvedValue({
    balance_cents: 1000,
    currency: "USD",
    denominations_cents: [1000],
    updated_at: new Date(0).toISOString(),
  });
  vi.spyOn(bridge, "myServerList").mockResolvedValue({ servers });
  vi.spyOn(bridge, "myServerGet").mockResolvedValue(SERVER);
  vi.spyOn(bridge, "myServerCredentials").mockResolvedValue({
    server_id: SERVER.server_id,
    node_id: "local_node_srv_1",
    name: "新加坡 1 01",
    host: "45.76.20.100",
    port: 8388,
    method: "aes-256-gcm",
  });
  const runtimeStart = vi.spyOn(bridge, "runtimeStart");
  const configCreate = vi.spyOn(bridge, "configCreate");
  return { runtimeStart, configCreate };
}

beforeAll(async () => {
  await bridge.saveDeepSeekKey("sk-" + "abcdefghijklmnopqrstuvwxyz0123");
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
  if (modeDescriptor) Object.defineProperty(bridge, "mode", modeDescriptor);
});

describe("destination 与我的服务器", () => {
  it("记住上次停留的 destination；版本不符回连接屏", async () => {
    const { runtimeStart } = prepare();
    localStorage.setItem(DESTINATION_KEY, "servers");
    localStorage.setItem(DESTINATION_VERSION_KEY, DESTINATION_VERSION);

    const first = render(<App />);
    expect(
      await screen.findByRole("complementary", { name: "服务器列表" }),
    ).toBeTruthy();
    first.unmount();

    localStorage.setItem(DESTINATION_KEY, "servers");
    localStorage.setItem(DESTINATION_VERSION_KEY, "old-version");
    const second = render(<App />);
    expect(await screen.findByRole("button", { name: "启动 VPN" })).toBeTruthy();
    expect(runtimeStart).not.toHaveBeenCalled();
    second.unmount();
  });

  it("切换 destination 不发运行时命令；安装中的服务器图标带圆点", async () => {
    const { runtimeStart } = prepare([
      SERVER,
      {
        ...SERVER,
        server_id: "srv_2",
        name: "纽约 1 · DigitalOcean",
        state: "installing",
        node_id: null,
      },
    ]);
    const { container } = render(<App />);
    await screen.findByRole("button", { name: "启动 VPN" });

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "我的服务器，1 台安装中" }),
      ).toBeTruthy(),
    );
    expect(container.querySelector(".activity__dot")).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /我的服务器/ }));
    expect(
      await screen.findByRole("complementary", { name: "服务器列表" }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "连接" }));
    expect(await screen.findByRole("button", { name: "启动 VPN" })).toBeTruthy();
    expect(runtimeStart).not.toHaveBeenCalled();
  });

  it("取凭据失败：不建配置，给出三段式提示", async () => {
    const { configCreate } = prepare([SERVER]);
    // 节点池为空才会真的去取凭据。
    vi.mocked(bridge.configList).mockResolvedValue({
      configs: [{ ...SUMMARY, node_count: 0, current_node_id: null }],
      active_config_id: CONFIG_ID,
    });
    vi.mocked(bridge.configDetail).mockResolvedValue({
      config_id: CONFIG_ID,
      name: SUMMARY.name,
      connect_mode: "tun",
      routing_mode: "proxy_all",
      node_count: 0,
      listen_port: null,
      is_active: true,
      current_node_id: null,
      created_at: 0,
      updated_at: 0,
      last_used_at: null,
      nodes: [],
      dns: { mode: "auto", local: [], remote: [] },
      tun_excludes: [],
      layout: null,
      layout_revision: null,
    });
    vi.mocked(bridge.myServerCredentials).mockRejectedValueOnce({
      code: "TIMEOUT",
      message: "请求超时。",
      details: { reason: "timeout" },
      retryable: true,
    });
    render(<App />);
    await screen.findByText("从哪里开始？");

    fireEvent.click(screen.getByRole("button", { name: /我的服务器/ }));
    fireEvent.click(
      await screen.findByRole("button", { name: /新加坡 1 · DigitalOcean/ }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "用来建配置" }));

    expect(await screen.findByText(/没有改动任何配置/)).toBeTruthy();
    expect(configCreate).not.toHaveBeenCalled();
  });

  it("取凭据期间切走：resolve 后不建配置、不跳回连接屏", async () => {
    const { configCreate } = prepare([SERVER]);
    vi.mocked(bridge.configList).mockResolvedValue({
      configs: [{ ...SUMMARY, node_count: 0, current_node_id: null }],
      active_config_id: CONFIG_ID,
    });
    vi.mocked(bridge.configDetail).mockResolvedValue({
      config_id: CONFIG_ID,
      name: SUMMARY.name,
      connect_mode: "tun",
      routing_mode: "proxy_all",
      node_count: 0,
      listen_port: null,
      is_active: true,
      current_node_id: null,
      created_at: 0,
      updated_at: 0,
      last_used_at: null,
      nodes: [],
      dns: { mode: "auto", local: [], remote: [] },
      tun_excludes: [],
      layout: null,
      layout_revision: null,
    });
    let release: (node: MyServerCredentialNode) => void = () => {};
    vi.mocked(bridge.myServerCredentials).mockImplementationOnce(
      () =>
        new Promise<MyServerCredentialNode>((resolve) => {
          release = resolve;
        }),
    );
    render(<App />);
    await screen.findByText("从哪里开始？");

    fireEvent.click(screen.getByRole("button", { name: /我的服务器/ }));
    fireEvent.click(
      await screen.findByRole("button", { name: /新加坡 1 · DigitalOcean/ }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "用来建配置" }));
    fireEvent.click(screen.getByRole("button", { name: "连接" }));

    await act(async () => {
      release({
        server_id: SERVER.server_id,
        node_id: "local_node_srv_1",
        name: "新加坡 1 01",
        host: "45.76.20.100",
        port: 8388,
        method: "aes-256-gcm",
      });
    });

    expect(configCreate).not.toHaveBeenCalled();
    expect(await screen.findByText("从哪里开始？")).toBeTruthy();
  });
});
