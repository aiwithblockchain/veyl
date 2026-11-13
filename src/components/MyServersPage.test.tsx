/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentBridge, MyServer, MyServerCatalog } from "../agent/bridge";
import { saveAccount } from "../myservers/account";
import { useMyServers } from "../myservers/useMyServers";
import { MyServersPage } from "./MyServersPage";
import { MyServersRail } from "./MyServersRail";

const CATALOG: MyServerCatalog = {
  regions: [
    { id: "nrt", name: "东京", continent: "asia" },
    { id: "kix", name: "大阪", continent: "asia" },
    { id: "icn", name: "首尔", continent: "asia" },
    { id: "sgp", name: "新加坡", continent: "asia" },
    { id: "lax", name: "洛杉矶", continent: "north_america" },
  ],
  plans: [
    {
      id: "vc2-1c-1gb",
      label: "1 核 · 1 GB 内存 · 25 GB 硬盘",
      hourly_usd: 0.007,
      monthly_usd: 5,
    },
  ],
  currency: "USD",
  updated_at: new Date(0).toISOString(),
};

function server(over: Partial<MyServer> = {}): MyServer {
  return {
    server_id: "srv_1",
    name: "东京 · Vultr",
    region: "nrt",
    plan: "vc2-1c-1gb",
    state: "healthy",
    created_at: new Date(0).toISOString(),
    ip: "45.76.20.100",
    port: 8388,
    node_id: "node_srv_1",
    hourly_usd: 0.007,
    monthly_usd: 5,
    failure: null,
    ...over,
  };
}

const FOUR: MyServer[] = [
  server({ server_id: "srv_1", name: "东京 · Vultr" }),
  server({ server_id: "srv_2", name: "洛杉矶 · Vultr", state: "installing", node_id: null }),
  server({
    server_id: "srv_3",
    name: "新加坡 · Vultr",
    state: "error",
    node_id: null,
    failure: {
      stage: "installing",
      code: "install_failed",
      message: "服务端没装好。这台已自动销毁。点「重新建一台」再试一次。",
      retryable: true,
    },
  }),
  server({ server_id: "srv_4", name: "圣保罗 · Vultr" }),
];

interface StubOptions {
  servers?: MyServer[];
  catalog?: MyServerCatalog;
}

function makeBridge(options: StubOptions = {}) {
  const servers = options.servers ?? [];
  return {
    myServerCatalog: vi.fn(async () => options.catalog ?? CATALOG),
    myServerList: vi.fn(async () => ({ servers })),
    myServerCreate: vi.fn(async () => ({
      order_id: "ord_1",
      state: "pending_payment" as const,
      region: "lax",
      plan: "vc2-1c-1gb",
      amount_usd: 5,
      created_at: new Date(0).toISOString(),
      expires_at: null,
      server_id: null,
      failure: null,
    })),
    myServerCheckout: vi.fn(async () => ({
      order_id: "ord_1",
      state: "provisioning" as const,
      region: "lax",
      plan: "vc2-1c-1gb",
      amount_usd: 5,
      created_at: new Date(0).toISOString(),
      expires_at: null,
      server_id: "srv_new",
      failure: null,
    })),
    myServerCancelOrder: vi.fn(),
    myServerRebuild: vi.fn(async () => ({
      newServerId: "srv_new",
      state: "creating" as const,
    })),
    myServerDestroy: vi.fn(async (id: string) =>
      server({ server_id: id, state: "destroyed", node_id: null }),
    ),
    myServerCredentials: vi.fn(),
    myServerSshCredentials: vi.fn(async () => ({
      host: "45.76.20.100",
      port: 22,
      username: "veyl",
      auth_type: "password" as const,
      password: "veyl-demo-2026",
      public_key: null,
      updated_at: new Date(0).toISOString(),
    })),
  };
}

type StubBridge = ReturnType<typeof makeBridge>;

function Harness({ bridge, rootSignal = 0 }: { bridge: StubBridge; rootSignal?: number }) {
  const state = useMyServers(bridge as unknown as AgentBridge, {
    active: true,
    rootSignal,
  });
  return (
    <>
      <MyServersRail
        servers={state.servers}
        selectedId={state.selectedId}
        loading={state.loading}
        account={state.account}
        onSelect={state.select}
        onNew={state.openWizard}
        onOpenSettings={() => {}}
      />
      <MyServersPage
        bridge={bridge as unknown as AgentBridge}
        account={state.account}
        catalog={state.catalog}
        servers={state.servers}
        loading={state.loading}
        error={state.error}
        selected={state.selected}
        view={state.view}
        confirmLeave={state.confirmLeave}
        loginOpen={state.loginOpen}
        onOpenLogin={state.openLogin}
        onCloseLogin={state.closeLogin}
        onSignedIn={state.signedIn}
        onNew={state.openWizard}
        onUseServer={() => {}}
        onChanged={() => void state.refresh()}
        onLeaveWizard={state.leaveWizard}
        onKeepWizard={state.keepWizard}
        onOrdered={state.ordered}
        onResetToRoot={state.resetToRoot}
      />
    </>
  );
}

function renderHarness(bridge: StubBridge) {
  const view = render(<Harness bridge={bridge} />);
  return {
    rerenderWithSignal: (signal: number) =>
      view.rerender(<Harness bridge={bridge} rootSignal={signal} />),
  };
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("服务器左栏与主从详情", () => {
  it("未登录：中间是登录门，左栏提示登录", async () => {
    const bridge = makeBridge();
    renderHarness(bridge);

    expect(await screen.findByText("登录后查看你的服务器", { selector: ".myservers__gate-text" })).toBeTruthy();
    expect(screen.getByText("1 核 1 GB · $0.007/小时 · 约 $5/月")).toBeTruthy();
    expect(screen.getByText("登录后查看你的服务器", { selector: ".myservers__rail-hint" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "登录" }));
    fireEvent.change(screen.getByLabelText("邮箱"), { target: { value: "me@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "发送验证码" }));
    fireEvent.change(screen.getByLabelText("验证码"), { target: { value: "123456" } });
    fireEvent.click(
      within(screen.getByRole("dialog", { name: "登录" })).getByRole("button", { name: "登录" }),
    );

    await waitFor(() => expect(bridge.myServerList).toHaveBeenCalled());
    expect(localStorage.getItem("veyl.myservers.account")).toBe("me@example.com");
  });

  it("左栏列出每台的名字与状态，默认选中第一台并在中间显示详情", async () => {
    saveAccount("me@example.com");
    renderHarness(makeBridge({ servers: FOUR }));

    expect(await screen.findByRole("button", { name: /东京 · Vultr/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /洛杉矶 · Vultr/ }).textContent).toContain(
      "安装中 65%",
    );
    expect(screen.getByRole("button", { name: /新加坡 · Vultr/ }).textContent).toContain(
      "出错了",
    );

    expect(await screen.findByRole("heading", { level: 4, name: "东京 · Vultr" })).toBeTruthy();
    expect(
      screen.getByRole("button", { name: /东京 · Vultr/ }).getAttribute("aria-current"),
    ).toBe("true");

    fireEvent.click(screen.getByRole("button", { name: /洛杉矶 · Vultr/ }));
    expect(await screen.findByRole("heading", { level: 4, name: "洛杉矶 · Vultr" })).toBeTruthy();
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("65");
    expect(
      screen.getByRole("button", { name: /洛杉矶 · Vultr/ }).getAttribute("aria-current"),
    ).toBe("true");
  });

  it("详情不露节点 id；安装中显示四段进度", async () => {
    saveAccount("me@example.com");
    renderHarness(makeBridge({ servers: FOUR }));

    expect(await screen.findByText("已就绪，可作为节点使用")).toBeTruthy();
    expect(screen.queryByText("node_srv_1")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /洛杉矶 · Vultr/ }));
    expect(await screen.findByText("正在安装 65%")).toBeTruthy();
    ["正在建机器", "等待开机", "安装服务端", "检查是否可用"].forEach((label) =>
      expect(screen.getAllByText(label).length).toBeGreaterThan(0),
    );
  });

  it("出错那台：详情里有重新建一台", async () => {
    saveAccount("me@example.com");
    const bridge = makeBridge({ servers: FOUR });
    renderHarness(bridge);

    fireEvent.click(await screen.findByRole("button", { name: /新加坡 · Vultr/ }));
    expect(await screen.findByText(/服务端没装好/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "重新建一台" }));
    await waitFor(() => expect(bridge.myServerRebuild).toHaveBeenCalledWith("srv_3", true));
  });

  it("入口按状态出现：可用有两个入口；安装中、出错只剩销毁", async () => {
    saveAccount("me@example.com");
    renderHarness(makeBridge({ servers: FOUR }));

    expect(await screen.findByRole("heading", { level: 4, name: "东京 · Vultr" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "用来建配置" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /SSH 登录/ })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /洛杉矶 · Vultr/ }));
    expect(await screen.findByRole("heading", { level: 4, name: "洛杉矶 · Vultr" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "用来建配置" })).toBeNull();
    expect(screen.queryByRole("button", { name: /SSH 登录/ })).toBeNull();
    expect(screen.getByRole("button", { name: "销毁" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /新加坡 · Vultr/ }));
    expect(await screen.findByText(/服务端没装好/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "重新建一台" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "销毁" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "用来建配置" })).toBeNull();
    expect(screen.queryByRole("button", { name: /SSH 登录/ })).toBeNull();
  });

  it("空态：中间只有一个「新建服务器」主按钮", async () => {
    saveAccount("me@example.com");
    renderHarness(makeBridge());

    expect(await screen.findByText("还没有服务器", { selector: ".myservers__empty-title" })).toBeTruthy();
    // 左栏「+」是页头动作；中间空态块只留一个实心主按钮。
    expect(document.querySelectorAll(".myservers .btn--primary")).toHaveLength(1);
    expect(screen.getByText("还没有服务器", { selector: ".myservers__rail-hint" })).toBeTruthy();
  });

  it("左栏「+」打开向导；Esc 先确认", async () => {
    saveAccount("me@example.com");
    renderHarness(makeBridge({ servers: FOUR }));

    await screen.findByRole("heading", { level: 4, name: "东京 · Vultr" });
    fireEvent.click(screen.getByRole("button", { name: "新建服务器" }));
    expect(await screen.findByText("选择地区")).toBeTruthy();

    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.getByText("还没下单，离开后这次选择不会保存。")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "离开" }));
    expect(await screen.findByRole("heading", { level: 4, name: "东京 · Vultr" })).toBeTruthy();
  });

  it("详情 Esc 回根：重新选中第一台", async () => {
    saveAccount("me@example.com");
    renderHarness(makeBridge({ servers: FOUR }));

    fireEvent.click(await screen.findByRole("button", { name: /圣保罗 · Vultr/ }));
    expect(await screen.findByRole("heading", { level: 4, name: "圣保罗 · Vultr" })).toBeTruthy();

    fireEvent.keyDown(window, { key: "Escape" });
    expect(await screen.findByRole("heading", { level: 4, name: "东京 · Vultr" })).toBeTruthy();
  });

  it("再点服务器图标回根", async () => {
    saveAccount("me@example.com");
    const { rerenderWithSignal } = renderHarness(makeBridge({ servers: FOUR }));

    fireEvent.click(await screen.findByRole("button", { name: /圣保罗 · Vultr/ }));
    expect(await screen.findByRole("heading", { level: 4, name: "圣保罗 · Vultr" })).toBeTruthy();

    rerenderWithSignal(1);
    expect(await screen.findByRole("heading", { level: 4, name: "东京 · Vultr" })).toBeTruthy();
  });

  it("向导下单后回到详情并选中新机器", async () => {
    saveAccount("me@example.com");
    const bridge = makeBridge({ servers: FOUR });
    renderHarness(bridge);

    fireEvent.click(await screen.findByRole("button", { name: "新建服务器" }));
    fireEvent.click(await screen.findByRole("radio", { name: "洛杉矶" }));
    fireEvent.click(screen.getByRole("button", { name: "下一步" }));
    fireEvent.click(screen.getByRole("button", { name: "确认下单" }));

    await waitFor(() => expect(bridge.myServerCheckout).toHaveBeenCalledWith("ord_1"));
    await waitFor(() => expect(bridge.myServerList).toHaveBeenCalledTimes(2));
    expect(screen.queryByText("选择地区")).toBeNull();
  });
});

describe("详情、SSH 与销毁", () => {
  it("SSH 折叠、密码默认打码；销毁要确认", async () => {
    saveAccount("me@example.com");
    const bridge = makeBridge({ servers: FOUR });
    renderHarness(bridge);

    await screen.findByRole("heading", { level: 4, name: "东京 · Vultr" });
    expect(await screen.findByText("45.76.20.100")).toBeTruthy();
    expect(screen.queryByText("veyl-demo-2026")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /SSH 登录/ }));
    expect(await screen.findByText(/••••••••/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "显示" }));
    expect(screen.getByText("veyl-demo-2026")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "销毁" }));
    expect(screen.getByText("销毁后这台服务器和它的节点都不能再用。")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "确认销毁" }));
    await waitFor(() => expect(bridge.myServerDestroy).toHaveBeenCalledWith("srv_1", true));
  });

  it("用来建配置把 node_id 交回新建流程", async () => {
    saveAccount("me@example.com");
    const bridge = makeBridge({ servers: FOUR });
    const onUseServer = vi.fn();
    function One() {
      const state = useMyServers(bridge as unknown as AgentBridge, {
        active: true,
        rootSignal: 0,
      });
      return (
        <MyServersPage
          bridge={bridge as unknown as AgentBridge}
          account={state.account}
          catalog={state.catalog}
          servers={state.servers}
          loading={state.loading}
          error={state.error}
          selected={state.selected}
          view={state.view}
          confirmLeave={state.confirmLeave}
          loginOpen={state.loginOpen}
          onOpenLogin={state.openLogin}
          onCloseLogin={state.closeLogin}
          onSignedIn={state.signedIn}
          onNew={state.openWizard}
          onUseServer={onUseServer}
          onChanged={() => {}}
          onLeaveWizard={state.leaveWizard}
          onKeepWizard={state.keepWizard}
          onOrdered={state.ordered}
          onResetToRoot={state.resetToRoot}
        />
      );
    }
    render(<One />);

    fireEvent.click(await screen.findByRole("button", { name: "用来建配置" }));
    expect(onUseServer).toHaveBeenCalledWith("node_srv_1", "东京 · Vultr");
  });
});
