/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentBridge, MyServer, MyServerCatalog } from "../agent/bridge";
import type { AgentEvent } from "../agent/protocol";
import { AGENT_EVENTS } from "../agent/protocol";
import { saveAccount } from "../myservers/account";
import { useMyServers } from "../myservers/useMyServers";
import { MyServersPage } from "./MyServersPage";
import { MyServersRail } from "./MyServersRail";

const CATALOG: MyServerCatalog = {
  regions: [
    { id: "nyc1", name: "纽约 1", continent: "north_america" },
    { id: "sgp1", name: "新加坡 1", continent: "asia" },
  ],
  plans: [
    {
      id: "s-1vcpu-512mb-10gb",
      label: "1 核 · 512 MB",
      hourly_usd: 0.00595,
      monthly_usd: 4,
    },
    {
      id: "s-1vcpu-1gb",
      label: "1 核 · 1 GB",
      hourly_usd: 0.00893,
      monthly_usd: 6,
    },
    {
      id: "s-1vcpu-2gb",
      label: "1 核 · 2 GB",
      hourly_usd: 0.01786,
      monthly_usd: 12,
    },
  ],
  currency: "USD",
  updated_at: new Date(0).toISOString(),
};

function server(over: Partial<MyServer> = {}): MyServer {
  return {
    server_id: "srv_1",
    name: "新加坡 1 · DigitalOcean",
    region: "sgp1",
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

const SERVERS: MyServer[] = [
  server({ server_id: "srv_1", name: "新加坡 1 · DigitalOcean" }),
  server({ server_id: "srv_2", name: "纽约 1 · DigitalOcean", state: "installing", node_id: null }),
  server({
    server_id: "srv_3",
    name: "法兰克福 1 · DigitalOcean",
    state: "error",
    node_id: null,
    failure: {
      stage: "installing",
      code: "install_failed",
      message: "服务端没装好。这台还在，但没有可用节点。点「重新建一台」再试一次。",
      retryable: true,
    },
  }),
];

function makeBridge(servers: MyServer[] = SERVERS) {
  const listeners = new Set<(event: AgentEvent) => void>();
  return {
    myServerCatalog: vi.fn(async () => CATALOG),
    myServerList: vi.fn(async () => ({ servers })),
    myServerGet: vi.fn(
      async (serverId: string) =>
        servers.find((item) => item.server_id === serverId) ??
        server({ server_id: serverId }),
    ),
    subscribe: vi.fn((listener: (event: AgentEvent) => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    }),
    emit: (event: AgentEvent) => {
      for (const listener of listeners) listener(event);
    },
    myServerCreate: vi.fn(async () => ({
      order_id: "ord_1",
      state: "pending_payment" as const,
      region: "nyc1",
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
      region: "nyc1",
      plan: "vc2-1c-1gb",
      amount_usd: 5,
      created_at: new Date(0).toISOString(),
      expires_at: null,
      server_id: "srv_new",
      failure: null,
    })),
    myServerCancelOrder: vi.fn(),
    myServerRebuild: vi.fn(async () => ({ newServerId: "srv_new", state: "creating" as const })),
    myServerDestroy: vi.fn(async (id: string) =>
      server({ server_id: id, state: "destroyed", node_id: null }),
    ),
    myServerCredentials: vi.fn(),
    myServerSshCredentials: vi.fn(),
  };
}

type StubBridge = ReturnType<typeof makeBridge>;

function Harness({
  bridge,
  rootSignal = 0,
  joinGroupName = null,
  onJoinServer = vi.fn(),
  onUseServer = vi.fn(),
}: {
  bridge: StubBridge;
  rootSignal?: number;
  joinGroupName?: string | null;
  onJoinServer?: (server: MyServer) => void;
  onUseServer?: (nodeId: string, name: string) => void;
}) {
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
        disabled={state.view === "wizard" || state.identityLost}
        onSelect={state.select}
        onNew={state.openWizard}
        onOpenSettings={() => {}}
      />
      <MyServersPage
        bridge={bridge as unknown as AgentBridge}
        catalog={state.catalog}
        servers={state.servers}
        loading={state.loading}
        error={state.error}
        detailError={state.detailError}
        selected={state.selected}
        view={state.view}
        confirmLeave={state.confirmLeave}
        identityLost={state.identityLost}
        identityMessage={state.identityMessage}
        joinGroupName={joinGroupName}
        onNew={state.openWizard}
        onJoinServer={onJoinServer}
        onUseServer={onUseServer}
        onChanged={() => void state.refresh()}
        onLeaveWizard={state.leaveWizard}
        onKeepWizard={state.keepWizard}
        onOrdered={state.ordered}
        onReRegister={() => void state.reRegister()}
      />
    </>
  );
}

function renderHarness(bridge: StubBridge, joinGroupName: string | null = null) {
  const view = render(<Harness bridge={bridge} joinGroupName={joinGroupName} />);
  return {
    rerenderWithSignal: (signal: number) =>
      view.rerender(
        <Harness bridge={bridge} joinGroupName={joinGroupName} rootSignal={signal} />,
      ),
  };
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("我的服务器 destination", () => {
  it("设备身份不可用：提示 + 重新注册设备入口", async () => {
    const bridge = makeBridge();
    bridge.myServerList.mockRejectedValue({
      code: "PRECONDITION_FAILED",
      message: "身份需要重新注册",
      details: { reason: "auth_required" },
      retryable: true,
    });
    renderHarness(bridge);

    expect(
      await screen.findByText(
        "这台设备的身份已丢失。已买的服务器仍在计费，这里无法管理。",
      ),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "登录" })).toBeNull();

    bridge.myServerList.mockClear();
    bridge.myServerList.mockResolvedValue({ servers: SERVERS });
    fireEvent.click(screen.getByRole("button", { name: "重新注册设备" }));

    await waitFor(() => expect(bridge.myServerList).toHaveBeenCalled());
    await waitFor(() =>
      expect(screen.queryByText(/这台设备的身份已丢失/)).toBeNull(),
    );
  });

  it("空态显示目录价格；缺 1 GB 档时不显示价格", async () => {
    const bridge = makeBridge([]);
    renderHarness(bridge);
    await waitFor(() =>
      expect(document.querySelector(".myservers__price")?.textContent).toContain(
        "$0.00893/小时",
      ),
    );
    cleanup();

    const missing = makeBridge([]);
    missing.myServerCatalog.mockResolvedValue({
      ...CATALOG,
      plans: CATALOG.plans.filter((plan) => plan.id !== "s-1vcpu-1gb"),
    });
    renderHarness(missing);
    expect(
      await screen.findByText("还没有服务器", { selector: ".myservers__empty-title" }),
    ).toBeTruthy();
    expect(document.querySelector(".myservers__price")).toBeNull();
  });

  it("左栏列出服务器与状态，默认选中第一台", async () => {
    saveAccount("me@example.com");
    renderHarness(makeBridge());

    expect(await screen.findByRole("button", { name: /新加坡 1 · DigitalOcean/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /纽约 1 · DigitalOcean/ }).textContent).toContain(
      "安装中 65%",
    );
    expect(screen.getByRole("button", { name: /法兰克福 1 · DigitalOcean/ }).textContent).toContain(
      "出错了",
    );
    expect(
      screen.getByRole("button", { name: /新加坡 1 · DigitalOcean/ }).getAttribute("aria-current"),
    ).toBe("true");
    expect(await screen.findByText("已就绪")).toBeTruthy();
  });

  it("收到 my-server-changed 后重新读取选中详情", async () => {
    const bridge = makeBridge();
    renderHarness(bridge);

    await screen.findByText("已就绪");
    const before = bridge.myServerGet.mock.calls.length;

    act(() => {
      bridge.emit({
        name: AGENT_EVENTS.myServerChanged,
        payload: {
          contract_version: "2.13.0",
          server_id: "srv_1",
          state: "installing",
          failure: null,
          node_id: null,
          at: new Date().toISOString(),
          emitted_at: new Date().toISOString(),
        },
      });
    });

    await waitFor(() =>
      expect(bridge.myServerGet.mock.calls.length).toBeGreaterThan(before),
    );
  });

  it("安装中：只有进度和销毁", async () => {
    saveAccount("me@example.com");
    renderHarness(makeBridge());

    fireEvent.click(await screen.findByRole("button", { name: /纽约 1 · DigitalOcean/ }));
    expect(await screen.findByText("正在安装 65%")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "用来建配置" })).toBeNull();
    expect(screen.getByRole("button", { name: "销毁" })).toBeTruthy();
  });

  it("出错：重新建一台 + 销毁", async () => {
    saveAccount("me@example.com");
    const bridge = makeBridge();
    renderHarness(bridge);

    fireEvent.click(await screen.findByRole("button", { name: /法兰克福 1 · DigitalOcean/ }));
    expect(await screen.findByText(/服务端没装好/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "重新建一台" }));
    await waitFor(() => expect(bridge.myServerRebuild).toHaveBeenCalledWith("srv_3", true));
    expect(screen.getByRole("button", { name: "销毁" })).toBeTruthy();
  });

  it("创建中销毁：确认文案说明会中断安装", async () => {
    saveAccount("me@example.com");
    renderHarness(makeBridge());

    fireEvent.click(await screen.findByRole("button", { name: /纽约 1 · DigitalOcean/ }));
    await screen.findByText("正在安装 65%");
    fireEvent.click(screen.getByRole("button", { name: "销毁" }));
    expect(
      screen.getByText("取消创建并销毁这台服务器？正在进行的安装会中断。"),
    ).toBeTruthy();
  });

  it("可用时销毁：二次确认后调用 myServerDestroy", async () => {
    saveAccount("me@example.com");
    const bridge = makeBridge();
    renderHarness(bridge);

    await screen.findByText("已就绪");
    fireEvent.click(screen.getByRole("button", { name: "销毁" }));
    expect(screen.getByText("销毁后这台服务器和它的节点都不能再用。")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "确认销毁" }));
    await waitFor(() =>
      expect(bridge.myServerDestroy).toHaveBeenCalledWith("srv_1", true),
    );
  });

  it("零台：空态只有一个主按钮", async () => {
    saveAccount("me@example.com");
    renderHarness(makeBridge([]));

    expect(await screen.findByText("还没有服务器", { selector: ".myservers__empty-title" })).toBeTruthy();
    expect(document.querySelectorAll(".myservers .btn--primary")).toHaveLength(1);
  });

  it("Esc 回根：重新选中第一台；再点图标同理", async () => {
    saveAccount("me@example.com");
    const { rerenderWithSignal } = renderHarness(makeBridge());

    fireEvent.click(await screen.findByRole("button", { name: /法兰克福 1 · DigitalOcean/ }));
    expect(await screen.findByText(/服务端没装好/)).toBeTruthy();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(await screen.findByText("已就绪")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /法兰克福 1 · DigitalOcean/ }));
    rerenderWithSignal(1);
    expect(await screen.findByText("已就绪")).toBeTruthy();
  });

  it("左栏「+」打开单页向导：三区块、默认中档、底部汇总与唯一主按钮", async () => {
    saveAccount("me@example.com");
    renderHarness(makeBridge());

    await screen.findByText("已就绪");
    fireEvent.click(screen.getByRole("button", { name: "新建服务器" }));
    expect(await screen.findByRole("heading", { name: "新建服务器" })).toBeTruthy();

    expect(screen.getByRole("radiogroup", { name: "地区" })).toBeTruthy();
    expect(screen.getByText("亚洲")).toBeTruthy();
    expect(screen.getByText("北美洲")).toBeTruthy();
    expect(screen.getByRole("radiogroup", { name: "服务器类型" })).toBeTruthy();
    expect(screen.getByText("Ubuntu 24.04 LTS")).toBeTruthy();

    // 默认地区按大洲渲染顺序取第一组第一个，不是目录数组的第一个。
    expect(
      screen.getByRole("radio", { name: "新加坡 1" }).getAttribute("aria-checked"),
    ).toBe("true");
    // 向导期间左栏行不可选，避免无确认丢掉已选。
    const railRow = screen.getByRole("button", {
      name: /纽约 1 · DigitalOcean/,
    }) as HTMLButtonElement;
    expect(railRow.disabled).toBe(true);
    expect(railRow.getAttribute("aria-disabled")).toBe("true");

    // 三档按目录顺序排；默认选中 1 GB 那档。
    expect(
      screen.getByRole("radio", { name: /1 GB/ }).getAttribute("aria-checked"),
    ).toBe("true");
    expect(screen.getByText("入门")).toBeTruthy();
    expect(screen.getByText("标准")).toBeTruthy();
    expect(screen.getByText("进阶")).toBeTruthy();

    expect(document.querySelector(".wizard-foot__price")?.textContent).toContain(
      "约 $6/月 · $0.00893/小时",
    );
    expect(document.querySelectorAll(".myservers .btn--primary")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "创建服务器" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "下一步" })).toBeNull();
    expect(screen.queryByText("确认订单")).toBeNull();
    expect(screen.queryByRole("button", { name: "返回" })).toBeNull();
  });

  it("服务器类型卡 ↑↓ 切换选中，汇总跟着变", async () => {
    saveAccount("me@example.com");
    renderHarness(makeBridge());

    await screen.findByText("已就绪");
    fireEvent.click(screen.getByRole("button", { name: "新建服务器" }));
    const group = await screen.findByRole("radiogroup", { name: "服务器类型" });
    const oneGb = within(group).getByRole("radio", {
      name: /1 GB/,
    }) as HTMLButtonElement;
    oneGb.focus();

    fireEvent.keyDown(oneGb, { key: "ArrowDown" });
    expect(
      within(group).getByRole("radio", { name: /2 GB/ }).getAttribute("aria-checked"),
    ).toBe("true");
    expect(document.querySelector(".wizard-foot__price")?.textContent).toContain(
      "约 $12/月 · $0.01786/小时",
    );

    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "ArrowUp" });
    expect(
      within(group).getByRole("radio", { name: /1 GB/ }).getAttribute("aria-checked"),
    ).toBe("true");
  });

  it("创建服务器按所选地区与档位下单", async () => {
    saveAccount("me@example.com");
    const bridge = makeBridge();
    renderHarness(bridge);

    await screen.findByText("已就绪");
    fireEvent.click(screen.getByRole("button", { name: "新建服务器" }));
    fireEvent.click(await screen.findByRole("radio", { name: "纽约 1" }));
    fireEvent.click(await screen.findByRole("radio", { name: /2 GB/ }));
    fireEvent.click(screen.getByRole("button", { name: "创建服务器" }));

    await waitFor(() =>
      expect(bridge.myServerCreate).toHaveBeenCalledWith({
        region: "nyc1",
        plan: "s-1vcpu-2gb",
        idempotencyKey: expect.any(String),
      }),
    );
    expect(bridge.myServerCheckout).toHaveBeenCalledWith("ord_1");
  });

  it("创建失败按可重试与否给不同下一步", async () => {
    const bridge = makeBridge();
    bridge.myServerCreate.mockRejectedValueOnce({
      code: "UPSTREAM_ERROR",
      message: "服务器没建起来。",
      details: { reason: "instance_create_failed" },
      retryable: true,
    });
    renderHarness(bridge);

    await screen.findByText("已就绪");
    fireEvent.click(screen.getByRole("button", { name: "新建服务器" }));
    fireEvent.click(await screen.findByRole("button", { name: "创建服务器" }));
    expect(
      await screen.findByText("可以点「创建服务器」再试一次。"),
    ).toBeTruthy();

    bridge.myServerCreate.mockRejectedValueOnce({
      code: "PRECONDITION_FAILED",
      message: "这个地区暂时没货。",
      details: { reason: "region_unavailable" },
      retryable: false,
    });
    fireEvent.click(screen.getByRole("button", { name: "创建服务器" }));
    expect(
      await screen.findByText("换一个地区或档位，再点「创建服务器」。"),
    ).toBeTruthy();
  });

  it("读不到目录：一句提示 + 重试，重试成功后进入向导", async () => {
    saveAccount("me@example.com");
    const bridge = makeBridge();
    bridge.myServerCatalog.mockRejectedValue(new Error("catalog down"));
    renderHarness(bridge);

    await screen.findByText("已就绪");
    fireEvent.click(screen.getByRole("button", { name: "新建服务器" }));
    expect(await screen.findByText("读不到可选地区")).toBeTruthy();

    bridge.myServerCatalog.mockResolvedValue(CATALOG);
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(
      await screen.findByRole("radiogroup", { name: "服务器类型" }),
    ).toBeTruthy();
  });

  it("向导 Esc 先确认放弃", async () => {
    saveAccount("me@example.com");
    renderHarness(makeBridge());

    await screen.findByText("已就绪");
    fireEvent.click(screen.getByRole("button", { name: "新建服务器" }));
    expect(await screen.findByRole("heading", { name: "新建服务器" })).toBeTruthy();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.getByText("还没下单，离开后这次选择不会保存。")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "继续填写" }));
    expect(screen.queryByText("还没下单，离开后这次选择不会保存。")).toBeNull();
  });

  it("用来建配置把 node_id 交回新建流程", async () => {
    saveAccount("me@example.com");
    const onUseServer = vi.fn();
    render(<Harness bridge={makeBridge()} onUseServer={onUseServer} />);

    await screen.findByText("已就绪");
    fireEvent.click(screen.getByRole("button", { name: "用来建配置" }));
    expect(onUseServer).toHaveBeenCalledWith("node_srv_1", "新加坡 1 · DigitalOcean");
  });

  it("带着目标组进来：顶部横幅，可用那台给加入动作，安装中不给", async () => {
    saveAccount("me@example.com");
    const onJoinServer = vi.fn();
    render(<Harness bridge={makeBridge()} joinGroupName="上海 1 号" onJoinServer={onJoinServer} />);

    expect(
      await screen.findByText("选择一台服务器，把节点加入「上海 1 号」"),
    ).toBeTruthy();
    expect(
      await screen.findByRole("button", { name: "加入「上海 1 号」" }),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "用来建配置" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /纽约 1 · DigitalOcean/ }));
    expect(await screen.findByText("正在安装 65%")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "加入「上海 1 号」" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /新加坡 1 · DigitalOcean/ }));
    fireEvent.click(await screen.findByRole("button", { name: "加入「上海 1 号」" }));
    expect(onJoinServer).toHaveBeenCalled();
  });
});
