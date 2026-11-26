/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import App from "./App";
import { emptyRuntimeView, getAgentBridge } from "./agent";
import type { MyServer } from "./agent/bridge";
import { AGENT_EVENTS } from "./agent/protocol";
import type { ConfigDetail, ConfigSummary, RuntimeSnapshot } from "./agent/protocol";

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
  local_node_id: "local_node_srv_1",
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

/** 诊断用的配置详情：本地节点端口可变，用来验证「同步前现读基准」。 */
function ownedDetail(localPort: number): ConfigDetail {
  return {
    config_id: CONFIG_ID,
    name: SUMMARY.name,
    connect_mode: "tun",
    routing_mode: "proxy_all",
    node_count: 2,
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
      {
        node_id: "local_node_srv_1",
        name: "新加坡 1 01",
        server: "45.76.20.100",
        port: localPort,
        method: "aes-256-gcm",
        protocol: "shadowsocks",
        source: "owned",
        created_at: 0,
      },
    ],
    dns: { mode: "auto", local: [], remote: [] },
    tun_excludes: [],
    layout: null,
    layout_revision: null,
  };
}

function unreachableProbeSnapshot() {
  return {
    configId: CONFIG_ID,
    results: [
      {
        node_id: "local_node_srv_1",
        status: "unreachable" as const,
        reachable: false,
        latency_ms: null,
        probe_method: "clash_delay" as const,
        checked_at: Date.now(),
        error: { code: "probe_failed", message: "" },
      },
    ],
    run: null,
  };
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
    session_expires_at: null,
  });
  vi.spyOn(bridge, "myServerWallet").mockResolvedValue({
    balance_cents: 1000,
    currency: "USD",
    denominations_cents: [1000],
    updated_at: new Date(0).toISOString(),
  });
  vi.spyOn(bridge, "myServerList").mockResolvedValue({ servers });
  vi.spyOn(bridge, "myServerGet").mockResolvedValue(SERVER);
  const credentials = vi
    .spyOn(bridge, "myServerCredentials")
    .mockResolvedValue({
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
  return { runtimeStart, configCreate, nodeAttach, nodeSwitch, stop, activate, credentials };
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

  it("切到「我的服务器」时主动拉一次列表；1 秒内连点只算一次", async () => {
    prepare([]);
    render(<App />);
    await screen.findByRole("button", { name: "连接节点" });

    const listMock = vi.mocked(bridge.myServerList);
    const base = listMock.mock.calls.length;

    fireEvent.click(screen.getByRole("button", { name: /我的服务器/ }));
    await screen.findByRole("complementary", { name: "服务器列表" });
    expect(listMock.mock.calls.length).toBe(base + 1);

    // 同一 destination 再点一次：1 秒内不重复拉。
    fireEvent.click(screen.getByRole("button", { name: /我的服务器/ }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(listMock.mock.calls.length).toBe(base + 1);
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
      (lockedRail.querySelector(".rail-build") as HTMLButtonElement).disabled,
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
    // 不显示百分比：进度条只报「第几步 / 共 4 步」。
    const bar = screen.getByRole("progressbar");
    expect(bar.getAttribute("aria-valuemin")).toBe("1");
    expect(bar.getAttribute("aria-valuemax")).toBe("4");
    expect(Number(bar.getAttribute("aria-valuenow"))).toBeGreaterThanOrEqual(1);
    expect(screen.queryByText(/%/)).toBeNull();
    expect(
      document.querySelector(".myservers__progress-head")?.textContent,
    ).toContain("正在建机器");
    expect(
      document.querySelector(".myservers__progress-head")?.textContent,
    ).toMatch(/已等待 \d+ 秒/);
    expect(document.querySelector(".myservers__steps")).toBeNull();
    expect(document.querySelectorAll(".myservers__bar span")).toHaveLength(4);
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
  it("设置 › 账户给「重新注册设备」，点击后重新注册并回到正常态", async () => {
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
      session_expires_at: null,
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
    expect(screen.queryByRole("dialog", { name: "设置" })).toBeNull();
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
      session_expires_at: null,
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
      session_expires_at: null,
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
      session_expires_at: null,
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

  it("收到 my-server-account-cleared 后账户页回到未登录", async () => {
    prepare([]);

    render(<App />);
    await screen.findByRole("button", { name: "连接节点" });
    fireEvent.click(screen.getByRole("button", { name: /我的服务器/ }));
    fireEvent.click(
      await screen.findByRole("button", { name: "账户，me@example.com" }),
    );
    expect(
      await screen.findByRole("dialog", { name: "设置" }),
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
    const settings = screen.getByRole("dialog", { name: "设置" });
    expect(await within(settings).findByRole("button", { name: "登录" })).toBeTruthy();
    expect(within(settings).queryByText("me@example.com")).toBeNull();
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

describe("停机删除的墓碑与空态", () => {
  const TOMB_NODE = "local_node_srv_1";
  const detailConfig = (nodes: ConfigDetail["nodes"]): ConfigDetail => ({
    config_id: CONFIG_ID,
    name: SUMMARY.name,
    connect_mode: "tun",
    routing_mode: "proxy_all",
    node_count: nodes.length,
    listen_port: null,
    is_active: true,
    current_node_id: nodes[0]?.node_id ?? null,
    created_at: 0,
    updated_at: 0,
    last_used_at: null,
    nodes,
    dns: { mode: "auto", local: [], remote: [] },
    tun_excludes: [],
    layout: null,
    layout_revision: null,
  });
  const configNode = (id: string): ConfigDetail["nodes"][number] => ({
    node_id: id,
    name: "东京 01",
    server: "203.0.113.1",
    port: 8388,
    method: "aes-128-gcm",
    protocol: "shadowsocks",
    source: "seed",
    created_at: 0,
  });

  it("删掉最后一台墓碑：服务器页回「还没有服务器」，连接页写「这条配置没有节点了」", async () => {
    const tombstone: MyServer = {
      ...SERVER,
      state: "destroyed",
      failure: {
        stage: "active",
        code: "billing_unpaid",
        message: "余额不足，已停机删除",
        retryable: false,
      },
    };
    prepare([tombstone]);

    let alive = true;
    vi.mocked(bridge.myServerGet).mockImplementation(async () => tombstone);
    vi.mocked(bridge.myServerList).mockImplementation(async () => ({
      servers: alive ? [tombstone] : [],
    }));
    vi.mocked(bridge.configList).mockImplementation(async () => ({
      configs: [
        {
          ...SUMMARY,
          node_count: alive ? 1 : 0,
          current_node_id: alive ? TOMB_NODE : null,
        },
      ],
      active_config_id: CONFIG_ID,
    }));
    vi.mocked(bridge.configDetail).mockImplementation(async () =>
      detailConfig(alive ? [configNode(TOMB_NODE)] : []),
    );
    vi.spyOn(bridge, "nodeForget").mockImplementation(async () => {
      alive = false;
      return { forgotten: true };
    });

    render(<App />);
    await screen.findByRole("button", { name: /我的服务器/ });
    fireEvent.click(screen.getByRole("button", { name: /我的服务器/ }));

    const rail = await screen.findByRole("complementary", { name: "服务器列表" });
    fireEvent.click(
      await within(rail).findByRole("button", { name: /已停机删除/ }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "删除" }));
    fireEvent.click(await screen.findByRole("button", { name: "确认删除" }));

    // 服务器页：回到页面级空态。
    expect(await screen.findByText("还没有服务器")).toBeTruthy();

    // 连接页：这一条配置没有节点了。
    navConnect();
    expect(await screen.findByText("这条配置没有节点了")).toBeTruthy();
  }, 15_000);

  it("根本没有配置：不写「这条配置没有节点了」，两种空态不互相顶替", async () => {
    prepare([]);
    vi.mocked(bridge.configList).mockResolvedValue({
      configs: [],
      active_config_id: null,
    });

    render(<App />);

    expect(await screen.findByText("从哪里开始？")).toBeTruthy();
    expect(screen.queryByText("这条配置没有节点了")).toBeNull();
  });

  it("节点删光但隧道还在跑：连接页照常渲染，能点「断开」", async () => {
    const { stop } = prepare([]);
    vi.mocked(bridge.runtimeStop).mockResolvedValue(undefined);
    vi.mocked(bridge.configList).mockResolvedValue({
      configs: [{ ...SUMMARY, node_count: 0, current_node_id: null }],
      active_config_id: CONFIG_ID,
    });
    vi.mocked(bridge.configDetail).mockResolvedValue(detailConfig([]));
    const running: RuntimeSnapshot = {
      ...emptyRuntimeView(),
      contract_version: "2.0.0",
      state: "running",
      mode: "tun",
      pid: 123,
      config_id: CONFIG_ID,
      config_name: SUMMARY.name,
      node_id: TOMB_NODE,
      node_name: "东京 01",
      connected_since: new Date(Date.now() - 5000).toISOString(),
      last_transition_at: "",
    };
    vi.mocked(bridge.getRuntimeSnapshot).mockResolvedValue(running);

    render(<App />);

    // 没有节点也不再退回 StartChoice：这一页是唯一的断开入口。
    expect(await screen.findByText("这条配置没有节点了")).toBeTruthy();
    const disconnect = (await screen.findByRole("button", {
      name: "断开连接",
    })) as HTMLButtonElement;
    expect(disconnect.disabled).toBe(false);

    fireEvent.click(disconnect);
    await waitFor(() => expect(stop).toHaveBeenCalled());
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

describe("节点诊断入口", () => {
  it("自有节点测不通：详情打开面板，面板用这台的事实发起探测", async () => {
    prepare([SERVER]);

    const ownedConfig: ConfigDetail = {
      config_id: CONFIG_ID,
      name: SUMMARY.name,
      connect_mode: "tun",
      routing_mode: "proxy_all",
      node_count: 2,
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
        {
          node_id: "local_node_srv_1",
          name: "新加坡 1 01",
          server: "45.76.20.100",
          port: 8388,
          method: "aes-256-gcm",
          protocol: "shadowsocks",
          source: "owned",
          created_at: 0,
        },
      ],
      dns: { mode: "auto", local: [], remote: [] },
      tun_excludes: [],
      layout: null,
      layout_revision: null,
    };
    vi.mocked(bridge.configDetail).mockResolvedValue(ownedConfig);
    vi.spyOn(bridge, "nodeProbeSnapshot").mockResolvedValue({
      configId: CONFIG_ID,
      results: [
        {
          node_id: "local_node_srv_1",
          status: "unreachable",
          reachable: false,
          latency_ms: null,
          probe_method: "clash_delay",
          checked_at: Date.now(),
          error: { code: "probe_failed", message: "" },
        },
      ],
      run: null,
    });
    const reachability = vi
      .spyOn(bridge, "nodeProbeReachability")
      .mockResolvedValue({
        icmp: { ok: true, rtt_ms: 32, loss: 0 },
        tcp: { ok: true, ms: 12, error: null },
      });

    render(<App />);
    await screen.findByRole("button", { name: "连接节点" });
    fireEvent.click(screen.getByRole("button", { name: /我的服务器/ }));

    fireEvent.click(
      await screen.findByRole("button", { name: "智能诊断" }),
    );
    expect(
      await screen.findByRole("dialog", {
        name: "智能诊断：新加坡 1 · DigitalOcean",
      }),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "开始分析" }));
    await waitFor(() =>
      expect(reachability).toHaveBeenCalledWith("45.76.20.100", 32100),
    );
    expect(await screen.findByText(/ICMP 通/)).toBeTruthy();
  });

  it("AI 未配置：点「去问 AI」弹告警，面板留着，焦点在告警里", async () => {
    prepare([SERVER]);
    // 未配置 AI 会先挡首启；这里只要告警本身，跳过首启直接进主界面。
    localStorage.setItem("veyl.onboarding.skipped", "1");
    vi.spyOn(bridge, "llmProviderList").mockResolvedValue({
      providers: [],
      activeProviderId: null,
    });
    vi.mocked(bridge.configDetail).mockResolvedValue(ownedDetail(8388));
    vi.spyOn(bridge, "nodeProbeSnapshot").mockResolvedValue(
      unreachableProbeSnapshot() as never,
    );
    vi.spyOn(bridge, "nodeProbeReachability").mockResolvedValue({
      icmp: { ok: false, rtt_ms: null, loss: 100 },
      tcp: { ok: false, ms: null, error: "refused" },
    });

    render(<App />);
    await screen.findByRole("button", { name: /我的服务器/ });
    fireEvent.click(screen.getByRole("button", { name: /我的服务器/ }));
    fireEvent.click(
      await screen.findByRole("button", { name: "智能诊断" }),
    );
    await screen.findByRole("dialog", {
      name: "智能诊断：新加坡 1 · DigitalOcean",
    });

    fireEvent.click(screen.getByRole("button", { name: "开始分析" }));
    fireEvent.click(await screen.findByRole("button", { name: "去问 AI" }));

    const alert = await screen.findByRole("dialog", {
      name: "还没有配置 AI 服务",
    });
    expect(
      screen.getByRole("dialog", { name: "智能诊断：新加坡 1 · DigitalOcean" }),
    ).toBeTruthy();
    await waitFor(() =>
      expect(alert.contains(document.activeElement)).toBe(true),
    );

    // 点「去配置」后焦点应交给设置，诊断面板不再抢替；Esc 也不该关掉它。
    fireEvent.click(screen.getByRole("button", { name: "去配置" }));
    const settings = await screen.findByRole("dialog", { name: "设置" });
    await waitFor(() => expect(settings.contains(document.activeElement)).toBe(true));

    fireEvent.keyDown(window, { key: "Escape" });
    expect(
      screen.getByRole("dialog", { name: "智能诊断：新加坡 1 · DigitalOcean" }),
    ).toBeTruthy();
  });

  it("面板打开后本地端口已被同步改过：同步配置判为无变化", async () => {
    prepare([SERVER]);
    let localPort = 8388;
    vi.mocked(bridge.configDetail).mockImplementation(async () =>
      ownedDetail(localPort),
    );
    vi.spyOn(bridge, "nodeProbeSnapshot").mockResolvedValue(
      unreachableProbeSnapshot() as never,
    );
    vi.spyOn(bridge, "nodeProbeReachability").mockResolvedValue({
      icmp: { ok: true, rtt_ms: 20, loss: 0 },
      tcp: { ok: true, ms: 15, error: null },
    });
    vi.spyOn(bridge, "nodeProbe").mockResolvedValue({
      node_id: "local_node_srv_1",
      status: "unreachable",
      reachable: false,
      latency_ms: null,
      probe_method: "clash_delay",
      checked_at: Date.now(),
      error: { code: "probe_failed", message: "" },
    });
    vi.spyOn(bridge, "myServerCredentials").mockImplementation(async () => ({
      server_id: SERVER.server_id,
      node_id: "local_node_srv_1",
      name: "新加坡 1 01",
      host: SERVER.ip ?? "",
      port: localPort,
      method: "aes-256-gcm",
    }));

    render(<App />);
    await screen.findByRole("button", { name: /我的服务器/ });
    fireEvent.click(screen.getByRole("button", { name: /我的服务器/ }));
    fireEvent.click(
      await screen.findByRole("button", { name: "智能诊断" }),
    );
    await screen.findByRole("dialog", {
      name: "智能诊断：新加坡 1 · DigitalOcean",
    });

    // 面板打开后本地端口已经被别处同步改过：基准必须现读，不能用打开时的快照。
    localPort = 9999;

    fireEvent.click(screen.getByRole("button", { name: "开始分析" }));
    fireEvent.click(await screen.findByRole("button", { name: "同步配置" }));

    expect(await screen.findByText("配置没有变化")).toBeTruthy();
    expect(screen.queryByText("配置已更新，重新连接后生效")).toBeNull();
  });
});

describe("左栏门禁", () => {
  const DEVICE_ACCOUNT = {
    logged_in: false,
    email: null,
    account_id: "acct_1",
    device_id: "dev_1",
    account_kind: "device" as const,
    session_expires_at: null,
  };

  async function openServers() {
    render(<App />);
    await screen.findByRole("button", { name: /我的服务器/ });
    fireEvent.click(screen.getByRole("button", { name: /我的服务器/ }));
    return screen.findByRole("complementary", { name: "服务器列表" });
  }

  it("已登录且有就绪服务器：左栏有服务器行与「在其它设备上使用」", async () => {
    prepare([SERVER]);

    const rail = await openServers();
    expect(
      within(rail).getByRole("button", { name: /新加坡 1 · DigitalOcean/ }),
    ).toBeTruthy();
    expect(rail.querySelector(".rail__action-row")).toBeTruthy();
  }, 15_000);

  it("设备身份（未登录）：左栏只留提示，没有建机入口、服务器行与手机入口", async () => {
    prepare([SERVER]);
    vi.spyOn(bridge, "myServerAccount").mockResolvedValue(DEVICE_ACCOUNT);

    const rail = await openServers();
    expect(await screen.findByText("登录后这里会列出你的服务器。")).toBeTruthy();
    // 未登录左栏不渲染建机入口：登录主按钮在中间区。
    expect(within(rail).queryByRole("button", { name: /新建节点/ })).toBeNull();
    expect(rail.querySelector(".rail-build")).toBeNull();
    expect(within(rail).queryByRole("button", { name: /新加坡/ })).toBeNull();
    expect(rail.querySelector(".rail__action-row")).toBeNull();
    // 中间是登录引导，不是服务器详情。
    expect(
      await screen.findByRole("heading", { name: "登录后管理你的服务器" }),
    ).toBeTruthy();
    // 未登录不发账户命令。
    expect(bridge.myServerList).not.toHaveBeenCalled();
  }, 15_000);

  it("会话已过期：即便 logged_in=true 也按未登录处理", async () => {
    prepare([SERVER]);
    vi.spyOn(bridge, "myServerAccount").mockResolvedValue({
      ...DEVICE_ACCOUNT,
      logged_in: true,
      email: "me@example.com",
      account_kind: "email",
      session_expires_at: "2020-01-01T00:00:00Z",
    });

    const rail = await openServers();
    expect(await screen.findByText("登录后这里会列出你的服务器。")).toBeTruthy();
    expect(rail.querySelector(".rail__action-row")).toBeNull();
    expect(bridge.myServerList).not.toHaveBeenCalled();
  }, 15_000);

  it("已登录但没有就绪服务器：不出现手机入口", async () => {
    prepare([
      { ...SERVER, state: "creating", node_id: null, local_node_id: null },
    ]);

    const rail = await openServers();
    expect(rail.querySelector(".rail__action-row")).toBeNull();
  }, 15_000);
});

describe("新建节点：AI 入口按配置显隐", () => {
  async function openWizard() {
    render(<App />);
    await screen.findByRole("button", { name: /我的服务器/ });
    fireEvent.click(screen.getByRole("button", { name: /我的服务器/ }));
    const rail = await screen.findByRole("complementary", { name: "服务器列表" });
    fireEvent.click(rail.querySelector(".rail__add") as HTMLButtonElement);
    await screen.findByRole("main", { name: "新建节点" });
  }

  it("AI 可用：标题区右上角出现 ghost「让 AI 帮我选」", async () => {
    prepare([SERVER]);
    localStorage.setItem("veyl.onboarding.skipped", "1");
    vi.spyOn(bridge, "llmProviderList").mockResolvedValue({
      providers: [
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
      ],
      activeProviderId: "deepseek",
    } as never);

    await openWizard();
    const ask = await screen.findByRole("button", { name: "让 AI 帮我选" });
    expect(ask.className).toContain("btn--ghost");
    expect(ask.closest(".myservers__wizard-head")).toBeTruthy();
  }, 15_000);

  it("AI 未配置：不渲染这个入口", async () => {
    prepare([SERVER]);
    localStorage.setItem("veyl.onboarding.skipped", "1");
    vi.spyOn(bridge, "llmProviderList").mockResolvedValue({
      providers: [],
      activeProviderId: null,
    } as never);

    await openWizard();
    expect(screen.queryByRole("button", { name: "让 AI 帮我选" })).toBeNull();
  }, 15_000);
});
