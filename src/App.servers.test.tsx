/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import App from "./App";
import { getAgentBridge } from "./agent";
import type { MyServer, MyServerCredentialNode } from "./agent/bridge";
import type { ConfigSummary } from "./agent/protocol";

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


function detailConnect() {
  const detail = document.querySelector(".myservers__detail");
  if (!(detail instanceof HTMLElement)) throw new Error("详情不在");
  fireEvent.click(within(detail).getByRole("button", { name: "连接" }));
}

function navConnect() {
  const nav = screen.getByRole("navigation", { name: "切换主区" });
  fireEvent.click(within(nav).getByRole("button", { name: "连接" }));
}


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
  const stop = vi.spyOn(bridge, "runtimeStop");
  const activate = vi.spyOn(bridge, "configActivate");
  const nodeAttach = vi.spyOn(bridge, "nodeAttach").mockResolvedValue({
    config_id: CONFIG_ID,
    created_config: false,
    attached_node_ids: ["local_node_srv_1"],
    skipped_node_ids: [],
    node_count: 2,
    current_node_id: null,
  });
  const nodeSwitch = vi
    .spyOn(bridge, "nodeSwitch")
    .mockResolvedValue({} as never);
  return { runtimeStart, configCreate, nodeAttach, nodeSwitch, stop, activate };
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
  it("冷启动一律落在连接页，不恢复上次的 destination", async () => {
    prepare();
    // 旧实现会按这两个键恢复到服务器页；现在它们不再被读取。
    localStorage.setItem("veyl.ui.destination", "servers");
    localStorage.setItem("veyl.ui.destinationVersion", "destinations-4");

    render(<App />);

    expect(await screen.findByRole("button", { name: "连接节点" })).toBeTruthy();
    expect(
      screen.queryByRole("complementary", { name: "服务器列表" }),
    ).toBeNull();
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
    await screen.findByRole("button", { name: "连接节点" });

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
    navConnect();
    expect(await screen.findByRole("button", { name: "连接节点" })).toBeTruthy();
    expect(runtimeStart).not.toHaveBeenCalled();
  });

  it("服务器页 ＋ 打开 client 新建节点，返回回到服务器列表", async () => {
    prepare([SERVER]);
    render(<App />);
    await screen.findByRole("button", { name: /我的服务器/ });
    fireEvent.click(screen.getByRole("button", { name: /我的服务器/ }));
    const rail = await screen.findByRole("complementary", { name: "服务器列表" });
    fireEvent.click(within(rail).getByRole("button", { name: "新建节点" }));

    await waitFor(() =>
      expect(document.querySelector('main[aria-label="新建节点"]')).not.toBeNull(),
    );
    expect(screen.queryByRole("complementary", { name: "服务器列表" })).toBeNull();

    const stage = document.querySelector('main[aria-label="新建节点"]') as HTMLElement;
    fireEvent.click(within(stage).getByRole("button", { name: "返回" }));
    await waitFor(() =>
      expect(screen.getByRole("complementary", { name: "服务器列表" })).toBeTruthy(),
    );
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
    detailConnect();

    expect(await screen.findByText(/没有改动任何配置/)).toBeTruthy();
    expect(configCreate).not.toHaveBeenCalled();
  });

  it("服务器节点绑进全局池：attach → node_switch，不新建配置", async () => {
    const { configCreate, nodeAttach, nodeSwitch, activate } = prepare([SERVER]);
    render(<App />);
    await screen.findByRole("button", { name: "连接节点" });

    fireEvent.click(screen.getByRole("button", { name: /我的服务器/ }));
    fireEvent.click(
      await screen.findByRole("button", { name: /新加坡 1 · DigitalOcean/ }),
    );
    detailConnect();

    await waitFor(() =>
      expect(nodeAttach).toHaveBeenCalledWith({ nodeIds: ["local_node_srv_1"] }),
    );
    await waitFor(() =>
      expect(nodeSwitch).toHaveBeenCalledWith(CONFIG_ID, "local_node_srv_1"),
    );
    expect(configCreate).not.toHaveBeenCalled();
    expect(activate).not.toHaveBeenCalled();
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
    detailConnect();
    navConnect();

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

  it("非激活配置有节点也不点亮连接屏：hasNodes 只看全局配置", async () => {
    prepare([]);
    vi.mocked(bridge.configList).mockResolvedValue({
      configs: [
        { ...SUMMARY, node_count: 0, current_node_id: null },
        {
          ...SUMMARY,
          config_id: "cfg_hidden",
          name: "旧配置",
          node_count: 2,
          is_active: false,
        },
      ],
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

    render(<App />);

    expect(await screen.findByText("从哪里开始？")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "连接节点" })).toBeNull();
  });
});

describe("已连接时改用服务器节点", () => {
  function prepareConnected() {
    const spies = prepare([SERVER]);
    const state = {
      runtimeConfigId: CONFIG_ID as string | null,
      at: Date.now() - 60_000,
      switched: null as string | null,
      attached: false,
    };
    const seedNode = {
      node_id: "node_1",
      name: "东京 01",
      server: "203.0.113.1",
      port: 8388,
      method: "aes-128-gcm",
      protocol: "shadowsocks",
      source: "seed",
      created_at: 0,
    };
    const serverNode = {
      node_id: "local_node_srv_1",
      name: "新加坡 1 01",
      server: "45.76.20.100",
      port: 8388,
      method: "aes-256-gcm",
      protocol: "shadowsocks",
      source: "server",
      created_at: 0,
    };
    const detail = () => ({
      config_id: CONFIG_ID,
      name: SUMMARY.name,
      connect_mode: "system_proxy",
      routing_mode: "direct",
      node_count: state.attached ? 2 : 1,
      listen_port: null,
      is_active: true,
      current_node_id: state.switched ?? "node_1",
      created_at: 0,
      updated_at: 0,
      last_used_at: null,
      nodes: [seedNode, ...(state.attached ? [serverNode] : [])],
      dns: { mode: "auto", local: [], remote: [] },
      tun_excludes: [],
      layout: null,
      layout_revision: null,
    });
    vi.mocked(bridge.configDetail).mockImplementation(async () => detail() as never);
    const running = () => {
      state.at += 1000;
      return {
        state: "running",
        config_id: CONFIG_ID,
        config_name: SUMMARY.name,
        node_id: state.switched ?? "node_1",
        node_name: state.switched ? "新加坡 1 01" : "东京 01",
        connected_since: new Date(state.at).toISOString(),
        last_transition_at: new Date(state.at).toISOString(),
        system_proxy_enabled: true,
      } as never;
    };
    vi.mocked(bridge.getRuntimeSnapshot).mockImplementation(async () =>
      state.runtimeConfigId ? running() : null,
    );
    const attach = vi
      .spyOn(bridge, "nodeAttach")
      .mockImplementation(async () => {
        state.attached = true;
        return {
          config_id: CONFIG_ID,
          created_config: false,
          attached_node_ids: ["local_node_srv_1"],
          skipped_node_ids: [],
          node_count: 2,
          current_node_id: state.switched,
        };
      });
    const nodeSwitch = vi
      .spyOn(bridge, "nodeSwitch")
      .mockImplementation(async (_configId, nodeId) => {
        state.switched = nodeId;
        return {} as never;
      });
    vi.mocked(bridge.runtimeStart).mockImplementation(async (configId?: string) => {
      state.runtimeConfigId = configId ?? CONFIG_ID;
      return running();
    });
    return { ...spies, attach, nodeSwitch, state };
  }

  async function openServerDetail() {
    render(<App />);
    await waitFor(() =>
      expect(
        document.querySelector(".state-line__label")?.textContent,
      ).toContain("已连接"),
    );
    fireEvent.click(screen.getByRole("button", { name: /我的服务器/ }));
    fireEvent.click(
      await screen.findByRole("button", { name: /新加坡 1 · DigitalOcean/ }),
    );
  }

  it("attach → node_switch → 启动，旧连接交给 runtime_start 停", async () => {
    const { runtimeStart, attach, nodeSwitch, state, activate, stop } =
      prepareConnected();

    await openServerDetail();
    detailConnect();

    await waitFor(() => expect(runtimeStart).toHaveBeenCalledTimes(1));
    expect(attach).toHaveBeenCalledWith({ nodeIds: ["local_node_srv_1"] });
    expect(nodeSwitch).toHaveBeenCalledWith(CONFIG_ID, "local_node_srv_1");
    expect(runtimeStart).toHaveBeenCalledWith(CONFIG_ID);
    expect(attach.mock.invocationCallOrder[0]).toBeLessThan(
      nodeSwitch.mock.invocationCallOrder[0],
    );
    expect(nodeSwitch.mock.invocationCallOrder[0]).toBeLessThan(
      runtimeStart.mock.invocationCallOrder[0],
    );
    expect(bridge.configCreate).not.toHaveBeenCalled();
    expect(activate).not.toHaveBeenCalled();
    // 停旧连接由 runtime_start 自己完成（commands.md §7.1），界面不再额外 stop。
    expect(stop).not.toHaveBeenCalled();
    expect(state.runtimeConfigId).toBe(CONFIG_ID);
  });

  it("attach 失败时旧连接不受影响", async () => {
    const { runtimeStart, attach, nodeSwitch, state, stop } = prepareConnected();
    attach.mockRejectedValue({
      code: "TIMEOUT",
      message: "请求超时。",
      retryable: true,
      details: { reason: "timeout" },
    });

    await openServerDetail();
    detailConnect();

    expect(await screen.findByText(/请求超时/)).toBeTruthy();
    expect(nodeSwitch).not.toHaveBeenCalled();
    expect(runtimeStart).not.toHaveBeenCalled();
    expect(stop).not.toHaveBeenCalled();
    expect(state.runtimeConfigId).toBe(CONFIG_ID);
  });

  it("同一台服务器连接两次：节点不重复、配置仍一行", async () => {
    const { nodeAttach, nodeSwitch, configCreate } = prepare([SERVER]);
    const seedNode = {
      node_id: "node_1",
      name: "东京 01",
      server: "203.0.113.1",
      port: 8388,
      method: "aes-128-gcm",
      protocol: "shadowsocks",
      source: "seed",
      created_at: 0,
    };
    const srvNode = {
      node_id: "local_node_srv_1",
      name: "新加坡 1 01",
      server: "45.76.20.100",
      port: 8388,
      method: "aes-256-gcm",
      protocol: "shadowsocks",
      source: "server",
      created_at: 0,
    };
    let detail = {
      config_id: CONFIG_ID,
      name: SUMMARY.name,
      connect_mode: "system_proxy",
      routing_mode: "direct",
      node_count: 1,
      listen_port: null,
      is_active: true,
      current_node_id: "node_1",
      created_at: 0,
      updated_at: 0,
      last_used_at: null,
      nodes: [seedNode],
      dns: { mode: "auto", local: [], remote: [] },
      tun_excludes: [],
      layout: null,
      layout_revision: null,
    };
    vi.mocked(bridge.configDetail).mockImplementation(async () => detail as never);
    nodeAttach.mockImplementation(async (input) => {
      const ids = input.nodeIds ?? [];
      const existing = new Set(detail.nodes.map((node) => node.node_id));
      const added = ids.filter((id) => !existing.has(id));
      detail = {
        ...detail,
        node_count: detail.nodes.length + added.length,
        nodes: [...detail.nodes, ...added.map((id) => ({ ...srvNode, node_id: id }))],
      };
      return {
        config_id: CONFIG_ID,
        created_config: false,
        attached_node_ids: added,
        skipped_node_ids: ids.filter((id) => existing.has(id)),
        node_count: detail.node_count,
        current_node_id: detail.current_node_id,
      };
    });
    nodeSwitch.mockImplementation(async (_configId, nodeId) => {
      detail = { ...detail, current_node_id: nodeId };
      return {} as never;
    });

    render(<App />);
    await screen.findByRole("button", { name: "连接节点" });

    fireEvent.click(screen.getByRole("button", { name: /我的服务器/ }));
    fireEvent.click(
      await screen.findByRole("button", { name: /新加坡 1 · DigitalOcean/ }),
    );
    detailConnect();
    await waitFor(() => expect(nodeAttach).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole("button", { name: /我的服务器/ }));
    fireEvent.click(
      await screen.findByRole("button", { name: /新加坡 1 · DigitalOcean/ }),
    );
    detailConnect();
    await waitFor(() => expect(nodeAttach).toHaveBeenCalledTimes(2));

    expect(nodeSwitch).toHaveBeenCalledTimes(2);
    expect(configCreate).not.toHaveBeenCalled();
    expect(detail.nodes.map((node) => node.node_id)).toEqual([
      "node_1",
      "local_node_srv_1",
    ]);
    expect(detail.node_count).toBe(2);
    const list = await bridge.configList();
    expect(list.configs).toHaveLength(1);
  });
});
