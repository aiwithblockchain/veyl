/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import App from "./App";
import { getAgentBridge } from "./agent";
import type { MyServer, MyServerCredentialNode } from "./agent/bridge";
import { AGENT_EVENTS } from "./agent/protocol";
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


/** 左栏里的服务器行；详情标题的改名按钮也带服务器名，必须限定在 rail 里找。 */
async function clickRailServer(name: RegExp) {
  const rail = await screen.findByRole("complementary", { name: "服务器列表" });
  fireEvent.click(await within(rail).findByRole("button", { name }));
}

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

  it("服务器页 ＋ 进入向导：留在 servers，左栏保留但禁用；返回回列表", async () => {
    prepare([SERVER]);
    render(<App />);
    await screen.findByRole("button", { name: /我的服务器/ });
    fireEvent.click(screen.getByRole("button", { name: /我的服务器/ }));
    const rail = await screen.findByRole("complementary", { name: "服务器列表" });
    // 左上角 + 与列表底部常驻行同名，按类名定位这一处的按钮。
    fireEvent.click(rail.querySelector(".rail__add") as HTMLButtonElement);

    await waitFor(() =>
      expect(document.querySelector('main[aria-label="新建节点"]')).not.toBeNull(),
    );
    // 导航高亮仍在「我的服务器」，左栏还在。
    expect(
      screen.getByRole("button", { name: /我的服务器/ }).getAttribute("aria-pressed"),
    ).toBe("true");
    const lockedRail = screen.getByRole("complementary", { name: "服务器列表" });
    expect(lockedRail.className).toContain("rail--locked");
    expect(
      (lockedRail.querySelector(".rail__add") as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (lockedRail.querySelector(".rail__new-row") as HTMLButtonElement).disabled,
    ).toBe(true);

    const stage = document.querySelector('main[aria-label="新建节点"]') as HTMLElement;
    fireEvent.click(within(stage).getByRole("button", { name: "返回" }));
    await waitFor(() =>
      expect(document.querySelector('main[aria-label="新建节点"]')).toBeNull(),
    );
    expect(
      screen.getByRole("button", { name: /我的服务器/ }).getAttribute("aria-pressed"),
    ).toBe("true");
    expect(
      screen.getByRole("complementary", { name: "服务器列表" }).className,
    ).not.toContain("rail--locked");
  });

  it("服务器宿主里点导航切走：先关向导，切回不恢复半填表单与 AI 待选", async () => {
    prepare([SERVER]);
    render(<App />);
    await screen.findByRole("button", { name: /我的服务器/ });
    fireEvent.click(screen.getByRole("button", { name: /我的服务器/ }));
    const rail = await screen.findByRole("complementary", { name: "服务器列表" });
    fireEvent.click(rail.querySelector(".rail__add") as HTMLButtonElement);

    const stage = await screen.findByRole("main", { name: "新建节点" });
    fireEvent.click(within(stage).getByRole("radio", { name: /1 核 · 512 MB/ }));
    expect(
      within(stage)
        .getByRole("radio", { name: /1 核 · 512 MB/ })
        .getAttribute("aria-checked"),
    ).toBe("true");

    navConnect();
    await waitFor(() =>
      expect(document.querySelector('main[aria-label="新建节点"]')).toBeNull(),
    );
    expect(await screen.findByRole("button", { name: "连接节点" })).toBeTruthy();

    // 切回 servers 再打开：不恢复上一轮的地区/档位，也不应用上一条 AI 待选。
    fireEvent.click(screen.getByRole("button", { name: /我的服务器/ }));
    const railAgain = await screen.findByRole("complementary", {
      name: "服务器列表",
    });
    fireEvent.click(railAgain.querySelector(".rail__add") as HTMLButtonElement);
    const reopened = await screen.findByRole("main", { name: "新建节点" });
    expect(
      within(reopened)
        .getByRole("radio", { name: /1 核 · 512 MB/ })
        .getAttribute("aria-checked"),
    ).not.toBe("true");
  });

  it("servers 宿主下 StageSelect 不被丢弃", async () => {
    prepare([SERVER]);
    render(<App />);
    await screen.findByRole("button", { name: /我的服务器/ });
    fireEvent.click(screen.getByRole("button", { name: /我的服务器/ }));
    const rail = await screen.findByRole("complementary", { name: "服务器列表" });
    fireEvent.click(rail.querySelector(".rail__add") as HTMLButtonElement);
    const stage = await screen.findByRole("main", { name: "新建节点" });

    act(() => {
      (
        bridge as unknown as { emit(event: unknown): void }
      ).emit({
        name: AGENT_EVENTS.stageSelect,
        payload: { region: "sgp1", plan: "s-1vcpu-512mb-10gb" },
      });
    });

    await waitFor(() =>
      expect(
        within(stage)
          .getByRole("radio", { name: /1 核 · 512 MB/ })
          .getAttribute("aria-checked"),
      ).toBe("true"),
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
    await clickRailServer(/新加坡 1 · DigitalOcean/);
    detailConnect();

    expect(await screen.findByText(/没有改动任何配置/)).toBeTruthy();
    expect(configCreate).not.toHaveBeenCalled();
  });

  it("服务器节点绑进全局池：attach → node_switch，不新建配置", async () => {
    const { configCreate, nodeAttach, nodeSwitch, activate } = prepare([SERVER]);
    render(<App />);
    await screen.findByRole("button", { name: "连接节点" });

    fireEvent.click(screen.getByRole("button", { name: /我的服务器/ }));
    await clickRailServer(/新加坡 1 · DigitalOcean/);
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
    await clickRailServer(/新加坡 1 · DigitalOcean/);
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
    await clickRailServer(/新加坡 1 · DigitalOcean/);
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
    await clickRailServer(/新加坡 1 · DigitalOcean/);
    detailConnect();
    await waitFor(() => expect(nodeAttach).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole("button", { name: /我的服务器/ }));
    await clickRailServer(/新加坡 1 · DigitalOcean/);
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

describe("下单成功后回到详情", () => {
  const NEW_SERVER: MyServer = {
    ...SERVER,
    server_id: "srv_new",
    name: "新加坡 1 · 新建",
    state: "creating",
    // 刚下单：计时从此刻起，不是 created_at 的哨兵值。
    created_at: new Date().toISOString(),
    node_id: null,
    failure: null,
  };

  /** 模拟真实链路：create 只给订单（server_id 为 null），checkout 之后 server_id 才写回订单。 */
  function stubOrderFlow() {
    const order = {
      order_id: "ord_1",
      state: "provisioning" as const,
      region: "sgp1",
      plan: "s-1vcpu-1gb",
      amount_usd: 5,
      created_at: new Date(0).toISOString(),
      expires_at: null,
      server_id: null as string | null,
      failure: null,
    };
    vi.spyOn(bridge, "myServerGet").mockImplementation(async (id: string) =>
      id === NEW_SERVER.server_id ? NEW_SERVER : SERVER,
    );
    vi.spyOn(bridge, "myServerIdentity").mockResolvedValue({
      has_identity: true,
      account_id: "acct_1",
    });
    vi.spyOn(bridge, "myServerCreate").mockResolvedValue({ ...order } as never);
    // 结账回订单形状；paid 路径上 server_id 还没写回，按订单详情解析。
    const checkout = vi.spyOn(bridge, "myServerCheckout").mockResolvedValue({
      ...order,
      state: "provisioning",
      server_id: null,
    } as never);
    vi.spyOn(bridge, "myServerOrderGet").mockResolvedValue({
      ...order,
      server_id: NEW_SERVER.server_id,
    } as never);
    return { order, checkout };
  }

  async function openWizardAndCreate() {
    render(<App />);
    await screen.findByRole("button", { name: "连接节点" });
    fireEvent.click(screen.getByRole("button", { name: /我的服务器/ }));
    const rail = await screen.findByRole("complementary", { name: "服务器列表" });
    fireEvent.click(rail.querySelector(".rail__add") as HTMLButtonElement);
    await screen.findByRole("heading", { name: "新建节点" });
    fireEvent.click(screen.getByRole("button", { name: "创建" }));
  }

  it("create 不返回 server_id：按订单详情解析出服务器，打开四段进度", async () => {
    prepare([]);
    const { checkout } = stubOrderFlow();
    await openWizardAndCreate();

    expect(
      await screen.findByRole("heading", { name: "新加坡 1 · 新建" }),
    ).toBeTruthy();
    expect(checkout).toHaveBeenCalledWith("ord_1");
    // 没有真实百分比，也就不再有 progressbar 角色与 15% 这种假数字。
    expect(screen.queryByRole("progressbar")).toBeNull();
    expect(screen.queryByText(/%/)).toBeNull();
    expect(
      document.querySelector(".myservers__progress-head")?.textContent,
    ).toContain("正在建机器");
    expect(
      document.querySelector(".myservers__progress-head")?.textContent,
    ).toMatch(/已等待 \d+ 秒/);
    const steps = [...document.querySelectorAll(".myservers__steps li")].map(
      (node) => node.textContent,
    );
    expect(steps).toEqual(["正在建机器", "等待开机", "安装服务端", "检查是否可用"]);
    expect(screen.queryByRole("heading", { name: "新建节点" })).toBeNull();
  }, 15_000);

  it("列表还没刷新时，显式选中的新机器不被默认选择覆盖", async () => {
    prepare([SERVER]); // 列表里只有旧机器，新机器还没进来。
    stubOrderFlow();
    await openWizardAndCreate();

    expect(
      await screen.findByRole("heading", { name: "新加坡 1 · 新建" }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("heading", { name: "新加坡 1 · DigitalOcean" }),
    ).toBeNull();
  }, 15_000);

  it("订单详情也没有 server_id：不选中任何一台旧机器，只给一行提示", async () => {
    const OTHER: MyServer = {
      ...SERVER,
      server_id: "srv_other",
      name: "纽约 1 · DigitalOcean",
    };
    prepare([SERVER, OTHER]);
    const { order } = stubOrderFlow();
    vi.spyOn(bridge, "myServerOrderGet").mockResolvedValue({
      ...order,
      server_id: null,
    } as never);
    await openWizardAndCreate();

    expect(
      await screen.findByText("服务器已下单，正在创建，稍后会自动出现。"),
    ).toBeTruthy();
    // 两台旧机器一台都不能被当成「刚下单的那台」打开。
    expect(
      screen.queryByRole("heading", { name: "新加坡 1 · DigitalOcean" }),
    ).toBeNull();
    expect(
      screen.queryByRole("heading", { name: "纽约 1 · DigitalOcean" }),
    ).toBeNull();
    expect(screen.queryByRole("progressbar")).toBeNull();
  }, 15_000);
});

describe("设备身份丢失后的恢复入口", () => {
  it("账号菜单给「重新注册设备」，点击后重新注册并回到正常态", async () => {
    prepare([]);
    let recovered = false;
    vi.spyOn(bridge, "myServerList").mockImplementation(async () => {
      if (!recovered) {
        throw {
          code: "UNAUTHENTICATED",
          message: "这台设备的身份丢了。",
          details: { reason: "device_identity_lost" },
          retryable: false,
        };
      }
      return { servers: [] };
    });
    const register = vi
      .spyOn(bridge, "myServerRegisterDevice")
      .mockImplementation(async () => {
        recovered = true;
        return { device_id: "dev_new", account_id: null } as never;
      });

    render(<App />);
    await screen.findByRole("button", { name: "连接节点" });
    fireEvent.click(screen.getByRole("button", { name: /我的服务器/ }));

    fireEvent.click(
      await screen.findByRole("button", { name: "账户，me@example.com" }),
    );
    const entry = await screen.findByRole("button", { name: "重新注册设备" });
    expect(
      screen.getByText("这台设备的身份丢了，需要重新注册设备；账户和服务器都在。"),
    ).toBeTruthy();

    fireEvent.click(entry);

    await waitFor(() => expect(register).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "重新注册设备" })).toBeNull(),
    );
  }, 15_000);
});

describe("设备 / 账户被停用的出路", () => {
  function jeBlockList(code: string, reason: string) {
    let recovered = false;
    vi.spyOn(bridge, "myServerList").mockImplementation(async () => {
      if (!recovered) {
        throw { code, message: "被停用", details: { reason }, retryable: false };
      }
      return { servers: [] };
    });
    return {
      recover: () => {
        recovered = true;
      },
    };
  }

  it("账户停用：诚实说明 + 「退出这台设备」真的退出到未登录", async () => {
    prepare([]);
    jeBlockList("PERMISSION_DENIED", "account_blocked");
    const logout = vi.spyOn(bridge, "myServerLogout").mockResolvedValue({
      logged_in: false,
      email: null,
      account_id: "acct_1",
      device_id: "dev_1",
      account_kind: "device",
    });

    render(<App />);
    await screen.findByRole("button", { name: "连接节点" });
    fireEvent.click(screen.getByRole("button", { name: /我的服务器/ }));
    fireEvent.click(
      await screen.findByRole("button", { name: "账户，me@example.com" }),
    );

    expect(
      await screen.findByText(
        "这个账户已停用。换一个账户需要重新注册这台设备；这台设备上的旧账户仍会保留。",
      ),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "退出登录" })).toBeNull();
    expect(screen.queryByText(/稍后再试/)).toBeNull();
    expect(screen.queryByText(/换一台设备/)).toBeNull();
    // 停用态整页只读：rail 的新建入口不可点，避免点下去才 403。
    const rail = screen.getByRole("complementary", { name: "服务器列表" });
    expect(
      (rail.querySelector(".rail__add") as HTMLButtonElement).disabled,
    ).toBe(true);
    for (const button of screen.getAllByRole("button", { name: "新建节点" })) {
      expect((button as HTMLButtonElement).disabled).toBe(true);
    }

    fireEvent.click(screen.getByRole("button", { name: "退出这台设备" }));

    await waitFor(() => expect(logout).toHaveBeenCalledTimes(1));
    expect(
      await screen.findByRole("button", { name: "账户，未登录" }),
    ).toBeTruthy();
    expect(screen.queryByRole("dialog", { name: "账户菜单" })).toBeNull();
  }, 15_000);

  it("账户停用：主行动「换一个账户」重新注册设备并打开登录", async () => {
    prepare([]);
    let recovered = false;
    vi.spyOn(bridge, "myServerList").mockImplementation(async () => {
      if (!recovered) {
        throw {
          code: "PERMISSION_DENIED",
          message: "账户已被停用",
          details: { reason: "account_blocked" },
          retryable: false,
        };
      }
      return { servers: [] };
    });
    const register = vi
      .spyOn(bridge, "myServerRegisterDevice")
      .mockImplementation(async () => {
        recovered = true;
        return { device_id: "dev_new", account_id: null } as never;
      });
    const logout = vi.spyOn(bridge, "myServerLogout");

    render(<App />);
    await screen.findByRole("button", { name: "连接节点" });
    fireEvent.click(screen.getByRole("button", { name: /我的服务器/ }));
    fireEvent.click(
      await screen.findByRole("button", { name: "账户，me@example.com" }),
    );

    expect(
      await screen.findByText(
        "这个账户已停用。换一个账户需要重新注册这台设备；这台设备上的旧账户仍会保留。",
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/稍后再试/)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "换一个账户" }));

    await waitFor(() => expect(register).toHaveBeenCalledTimes(1));
    expect(logout).not.toHaveBeenCalled();
    expect(
      await screen.findByRole("dialog", { name: "登录我的服务器" }),
    ).toBeTruthy();
  }, 15_000);

  it("设备停用：动作同样是真实退出", async () => {
    prepare([]);
    jeBlockList("PERMISSION_DENIED", "device_revoked");
    const logout = vi.spyOn(bridge, "myServerLogout").mockResolvedValue({
      logged_in: false,
      email: null,
      account_id: "acct_1",
      device_id: "dev_1",
      account_kind: "device",
    });

    render(<App />);
    await screen.findByRole("button", { name: "连接节点" });
    fireEvent.click(screen.getByRole("button", { name: /我的服务器/ }));
    fireEvent.click(
      await screen.findByRole("button", { name: "账户，me@example.com" }),
    );

    expect(
      await screen.findByText("这台设备已被停用。退出这台设备后可以重新登录。"),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "退出这台设备" }));

    await waitFor(() => expect(logout).toHaveBeenCalledTimes(1));
    expect(
      await screen.findByRole("button", { name: "账户，未登录" }),
    ).toBeTruthy();
  }, 15_000);

  it("用同一个被停用邮箱登录后仍回到停用态，不是假承诺", async () => {
    prepare([]);
    vi.spyOn(bridge, "myServerList").mockRejectedValue({
      code: "PERMISSION_DENIED",
      message: "账户已被停用",
      details: { reason: "account_blocked" },
      retryable: false,
    });
    vi.spyOn(bridge, "myServerLogout").mockResolvedValue({
      logged_in: false,
      email: null,
      account_id: "acct_1",
      device_id: "dev_1",
      account_kind: "device",
    });
    vi.spyOn(bridge, "myServerLoginStart").mockResolvedValue({
      sent: true,
      cooldown_seconds: 60,
    });
    vi.spyOn(bridge, "myServerLoginVerify").mockResolvedValue({
      logged_in: true,
      email: "me@example.com",
      account_id: "acct_1",
      device_id: "dev_1",
      account_kind: "email",
    });

    render(<App />);
    await screen.findByRole("button", { name: "连接节点" });
    fireEvent.click(screen.getByRole("button", { name: /我的服务器/ }));
    fireEvent.click(
      await screen.findByRole("button", { name: "账户，me@example.com" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "退出这台设备" }));

    fireEvent.click(
      await screen.findByRole("button", { name: "账户，未登录" }),
    );
    const dialog = await screen.findByRole("dialog", { name: "登录我的服务器" });
    fireEvent.change(within(dialog).getByLabelText("邮箱"), {
      target: { value: "me@example.com" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "发送验证码" }));
    fireEvent.change(await within(dialog).findByLabelText("验证码"), {
      target: { value: "123456" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "登录" }));

    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "登录我的服务器" })).toBeNull(),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "账户，me@example.com" }),
    );
    expect(
      await screen.findByText(
        "这个账户已停用。换一个账户需要重新注册这台设备；这台设备上的旧账户仍会保留。",
      ),
    ).toBeTruthy();
  }, 15_000);

  it("收到 my-server-account-cleared 后收起菜单并回到未登录", async () => {
    prepare([]);

    render(<App />);
    await screen.findByRole("button", { name: "连接节点" });
    fireEvent.click(screen.getByRole("button", { name: /我的服务器/ }));
    fireEvent.click(
      await screen.findByRole("button", { name: "账户，me@example.com" }),
    );
    expect(
      await screen.findByRole("dialog", { name: "账户菜单" }),
    ).toBeTruthy();

    act(() => {
      (
        bridge as unknown as { emit(event: unknown): void }
      ).emit({
        name: AGENT_EVENTS.myServerAccountCleared,
        payload: { reason: "account_blocked", emitted_at: "" },
      });
    });

    expect(
      await screen.findByRole("button", { name: "账户，未登录" }),
    ).toBeTruthy();
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "账户菜单" })).toBeNull(),
    );
  }, 15_000);

  it("account_blocked 优先于身份丢失", async () => {
    prepare([]);
    let call = 0;
    vi.spyOn(bridge, "myServerList").mockImplementation(async () => {
      call += 1;
      throw {
        code: call === 1 ? "PERMISSION_DENIED" : "UNAUTHENTICATED",
        message: "不可用",
        details: {
          reason: call === 1 ? "account_blocked" : "device_identity_lost",
        },
        retryable: false,
      };
    });

    render(<App />);
    await screen.findByRole("button", { name: "连接节点" });
    fireEvent.click(screen.getByRole("button", { name: /我的服务器/ }));

    // 第一次：账户停用；再触发一次刷新，这次报身份丢失。账户停用必须仍然优先。
    act(() => {
      (
        bridge as unknown as { emit(event: unknown): void }
      ).emit({
        name: AGENT_EVENTS.myServerChanged,
        payload: { server_id: "srv_x", state: "creating", node_id: null, failure: null },
      });
    });

    fireEvent.click(
      await screen.findByRole("button", { name: "账户，me@example.com" }),
    );
    expect(
      await screen.findByText(
        "这个账户已停用。换一个账户需要重新注册这台设备；这台设备上的旧账户仍会保留。",
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/这台设备的身份丢了/)).toBeNull();
  }, 15_000);
});

describe("销毁服务器后的选中", () => {
  it("不出现「已下单」提示，剩下的机器被自动选中", async () => {
    const second: MyServer = {
      ...SERVER,
      server_id: "srv_2",
      name: "纽约 1 · DigitalOcean",
    };
    prepare([SERVER, second]);
    let list = [SERVER, second];
    vi.spyOn(bridge, "myServerList").mockImplementation(async () => ({ servers: list }));
    vi.spyOn(bridge, "myServerGet").mockImplementation(async (id: string) =>
      id === second.server_id ? second : SERVER,
    );
    const destroy = vi
      .spyOn(bridge, "myServerDestroy")
      .mockImplementation(async (id: string) => {
        list = list.filter((server) => server.server_id !== id);
        return { ...SERVER, server_id: id, state: "destroyed" } as never;
      });

    render(<App />);
    await screen.findByRole("button", { name: "连接节点" });
    fireEvent.click(screen.getByRole("button", { name: /我的服务器/ }));
    expect(
      await screen.findByRole("heading", { name: /新加坡 1 · DigitalOcean/ }),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "销毁" }));
    fireEvent.click(await screen.findByRole("button", { name: "确认销毁" }));
    await waitFor(() => expect(destroy).toHaveBeenCalled());

    expect(
      await screen.findByRole("heading", { name: /纽约 1 · DigitalOcean/ }),
    ).toBeTruthy();
    expect(
      screen.queryByText("服务器已下单，正在创建，稍后会自动出现。"),
    ).toBeNull();
  }, 15_000);
});

describe("新建节点：导航与 Esc", () => {
  function openServersWizard() {
    fireEvent.click(screen.getByRole("button", { name: /我的服务器/ }));
    const rail = screen.getByRole("complementary", { name: "服务器列表" });
    fireEvent.click(rail.querySelector(".rail__add") as HTMLButtonElement);
  }

  it("登录弹窗开着时 Esc 只关弹窗，不关向导", async () => {
    prepare([SERVER]);
    vi.spyOn(bridge, "myServerCreate").mockRejectedValue({
      code: "UNAUTHENTICATED",
      message: "需要登录后使用",
      details: { reason: "auth_required" },
      retryable: true,
    });

    render(<App />);
    await screen.findByRole("button", { name: /我的服务器/ });
    openServersWizard();
    await screen.findByRole("main", { name: "新建节点" });

    fireEvent.click(screen.getByRole("button", { name: "创建" }));
    await screen.findByRole("dialog", { name: "登录我的服务器" });

    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "登录我的服务器" })).toBeNull(),
    );
    expect(document.querySelector('main[aria-label="新建节点"]')).not.toBeNull();

    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    await waitFor(() =>
      expect(document.querySelector('main[aria-label="新建节点"]')).toBeNull(),
    );
  }, 15_000);

  it("创建在途：导航禁用，Esc 与返回都不生效", async () => {
    prepare([SERVER]);
    let release: (value: { server_id: string; order_id: string }) => void =
      () => {};
    const pending = new Promise<{ server_id: string; order_id: string }>(
      (resolve) => {
        release = resolve;
      },
    );
    vi.spyOn(bridge, "myServerCreate").mockImplementation(() => pending as never);
    vi.spyOn(bridge, "myServerCheckout").mockResolvedValue({
      order_id: "ord_1",
      state: "provisioning",
      region: "sgp1",
      plan: "s-1vcpu-1gb",
      amount_usd: 5,
      created_at: new Date(0).toISOString(),
      expires_at: null,
      server_id: "srv_new",
      failure: null,
    } as never);

    render(<App />);
    await screen.findByRole("button", { name: /我的服务器/ });
    openServersWizard();
    await screen.findByRole("main", { name: "新建节点" });

    fireEvent.click(screen.getByRole("button", { name: "创建" }));
    await waitFor(() => expect(bridge.myServerCreate).toHaveBeenCalled());

    expect(
      (screen.getByRole("button", { name: "连接" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (screen.getByRole("button", { name: /我的服务器/ }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);

    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(document.querySelector('main[aria-label="新建节点"]')).not.toBeNull();

    await act(async () => {
      release({ server_id: "srv_new", order_id: "ord_1" });
      await pending;
    });
  }, 15_000);
});
