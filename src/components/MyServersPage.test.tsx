/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AgentBridge,
  MyServer,
  MyServerAccount,
  MyServerCatalog,
  MyServerCreateInput,
  MyServerWallet,
} from "../agent/bridge";
import type { AgentEvent } from "../agent/protocol";
import { AGENT_EVENTS } from "../agent/protocol";
import { useMyServers } from "../myservers/useMyServers";
import { MyServersPage } from "./MyServersPage";
import { MyServersRail } from "./MyServersRail";
import { MyServerLogin } from "./MyServerLogin";
import { MyServerTopUp } from "./MyServerTopUp";

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
    daily_price_cents: 30,
    paid_until: new Date(86_400_000).toISOString(),
    billing_state: "active",
    grace_ends_at: null,
    transfer_gib: 1000,
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

const ACCOUNT: MyServerAccount = {
  logged_in: true,
  email: "me@example.com",
  account_id: "acct_1",
  device_id: "dev_1",
  account_kind: "email",
};

const LOGGED_OUT: MyServerAccount = {
  logged_in: false,
  email: null,
  account_id: null,
  device_id: "dev_1",
  account_kind: "device",
};

const WALLET: MyServerWallet = {
  balance_cents: 800,
  currency: "USD",
  denominations_cents: [1000, 2000, 5000, 10_000],
  updated_at: new Date(0).toISOString(),
};

function makeBridge(servers: MyServer[] = SERVERS) {
  const listeners = new Set<(event: AgentEvent) => void>();
  const state = { account: { ...ACCOUNT } };
  return {
    myServerAccount: vi.fn(async () => ({ ...state.account })),
    setAccount: (next: MyServerAccount) => {
      state.account = { ...next };
    },
    myServerLoginStart: vi.fn(async () => ({ sent: true, cooldown_seconds: 60 })),
    myServerLoginVerify: vi.fn(async (email: string) => {
      state.account = { ...ACCOUNT, email };
      return { ...state.account };
    }),
    myServerLogout: vi.fn(async () => {
      state.account = { ...LOGGED_OUT };
      return { ...state.account };
    }),
    myServerWallet: vi.fn(async () => ({ ...WALLET })),
    myServerTopup: vi.fn(async (denomination: number) => ({
      topup_id: "topup_1",
      checkout_url: null,
      denomination_cents: denomination,
    })),
    myServerCatalog: vi.fn(async () => CATALOG),
    myServerIdentity: vi.fn(
      async (): Promise<{ has_identity: boolean; account_id: string | null }> => ({
        has_identity: true,
        account_id: "acct_1",
      }),
    ),
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
    myServerCreate: vi.fn(async (_input: MyServerCreateInput) => ({
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
      charged_cents: 30,
      balance_after_cents: 770,
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
  onUseServer = vi.fn(),
}: {
  bridge: StubBridge;
  rootSignal?: number;
  onUseServer?: (server: MyServer) => void;
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
        identityMissing={state.identityMissing}
        account={state.account}
        accountLoaded={state.accountLoaded}
        accountError={state.accountError}
        wallet={state.wallet}
        walletError={state.walletError}
        error={state.error}
        retrying={state.retrying}
        retryNotice={state.retryNotice}
        disabled={state.identityLost}
        onSelect={state.select}
        onNew={state.openWizard}
        onRetry={() => void state.retry()}
        onLogin={state.openLogin}
        onLogout={state.logout}
        onTopUp={state.openTopUp}
        onRefreshWallet={() => void state.refreshWallet()}
        onRefreshAccount={() => void state.refreshAccount()}
        onToggleAccount={() => {}}
      />
      <MyServersPage
        bridge={bridge as unknown as AgentBridge}
        catalog={state.catalog}
        selected={state.selected}
        view={state.view}
        detailError={state.detailError}
        detailRetrying={state.detailRetrying}
        readOnly={state.identityLost}
        sharedTransfer={state.sharedTransfer}
        onNew={state.openWizard}
        onEnsureIdentity={state.ensureIdentity}
        onTopUp={state.openTopUp}
        onUseServer={onUseServer}
        onChanged={() => void state.refresh()}
        onOrdered={state.ordered}
        onRebuilt={state.rebuilt}
        onRetryDetail={state.retryDetail}
        onAuthRequired={state.openLogin}
      />
      {state.loginOpen ? (
        <MyServerLogin
          onStart={state.loginStart}
          onVerify={state.loginVerify}
          onCancel={state.closeLogin}
        />
      ) : null}
      {state.topupOpen ? (
        <MyServerTopUp
          wallet={state.wallet}
          loading={state.walletLoading}
          error={state.walletError}
          onRetry={() => void state.refreshWallet()}
          onTopUp={state.topup}
          onClose={state.closeTopUp}
        />
      ) : null}
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

describe("我的服务器 destination", () => {
  it("列表要求登录：左栏显示登录，点开登录弹窗", async () => {
    const bridge = makeBridge();
    bridge.myServerList.mockRejectedValue({
      code: "UNAUTHENTICATED",
      message: "需要先登录。",
      details: { reason: "auth_required" },
      retryable: true,
    });
    renderHarness(bridge);

    const status = await screen.findByRole("button", { name: "登录" });
    expect(await screen.findByText("登录后查看你的服务器")).toBeTruthy();
    expect(
      await screen.findByRole("heading", { name: "新建节点" }),
    ).toBeTruthy();

    fireEvent.click(status);
    expect(
      await screen.findByRole("dialog", { name: "登录我的服务器" }),
    ).toBeTruthy();
  });

  it("中间默认是创建页，展示目录价格", async () => {
    renderHarness(makeBridge([]));

    expect(await screen.findByRole("heading", { name: "新建节点" })).toBeTruthy();
    expect(await screen.findByRole("radiogroup", { name: "服务器类型" })).toBeTruthy();
    expect(document.querySelector(".wizard-foot__price")?.textContent).toContain(
      "每天 $0.30 · 约 $9/月",
    );
    expect(document.querySelectorAll(".myservers .btn--primary")).toHaveLength(1);
  });

  it("列表失败：左栏就地重试，中间仍是创建页", async () => {
    const bridge = makeBridge();
    bridge.myServerList.mockRejectedValueOnce(new Error("down"));
    renderHarness(bridge);

    expect((await screen.findByRole("alert")).textContent).toContain(
      "连不上服务器，稍后再试",
    );
    expect(document.querySelectorAll(".rail__placeholder")).toHaveLength(3);
    expect(await screen.findByRole("heading", { name: "新建节点" })).toBeTruthy();
    const retry = screen.getByRole("button", { name: "重试" });

    bridge.myServerList.mockResolvedValueOnce({ servers: SERVERS });
    fireEvent.click(retry);

    expect(
      await screen.findByRole("button", { name: /新加坡 1 · DigitalOcean/ }),
    ).toBeTruthy();
    expect(screen.getByText("已重新读取服务器列表。")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "重试" })).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("heading", { name: "新建节点" })).toBeTruthy();
  });

  it("未登录：打开时不请求列表，登录成功后回到列表", async () => {
    const bridge = makeBridge();
    bridge.setAccount(LOGGED_OUT);
    renderHarness(bridge);

    expect(await screen.findByText("登录后查看你的服务器")).toBeTruthy();
    expect(await screen.findByRole("button", { name: "登录" })).toBeTruthy();
    expect(await screen.findByRole("heading", { name: "新建节点" })).toBeTruthy();
    expect(
      await screen.findByRole("radiogroup", { name: "服务器类型" }),
    ).toBeTruthy();
    expect(bridge.myServerList).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "登录" }));
    const dialog = await screen.findByRole("dialog", { name: "登录我的服务器" });
    fireEvent.change(within(dialog).getByLabelText("邮箱"), {
      target: { value: "me@example.com" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "发送验证码" }));
    expect(
      await within(dialog).findByText("验证码已发到 me@example.com。"),
    ).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText("验证码"), {
      target: { value: "123456" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "登录" }));

    expect(
      await screen.findByRole("button", { name: /新加坡 1 · DigitalOcean/ }),
    ).toBeTruthy();
    expect(
      await screen.findByRole("button", { name: /me@example.com/ }),
    ).toBeTruthy();
    expect(screen.queryByRole("dialog", { name: "登录我的服务器" })).toBeNull();
  });

  it("点创建时先初始化身份，再下单", async () => {
    const bridge = makeBridge();
    bridge.myServerIdentity.mockResolvedValue({
      has_identity: false,
      account_id: null,
    });
    let release: (value: { servers: MyServer[] }) => void = () => {};
    bridge.myServerList.mockImplementation(
      () =>
        new Promise<{ servers: MyServer[] }>((resolve) => {
          release = resolve;
        }),
    );
    renderHarness(bridge);

    fireEvent.click(await screen.findByRole("button", { name: "创建" }));
    expect(await screen.findByRole("button", { name: "正在登录…" })).toBeTruthy();
    expect(bridge.myServerCreate).not.toHaveBeenCalled();

    await act(async () => {
      release({ servers: [] });
    });

    await waitFor(() => expect(bridge.myServerCreate).toHaveBeenCalled());
    expect(bridge.myServerList.mock.invocationCallOrder[0]).toBeLessThan(
      bridge.myServerCreate.mock.invocationCallOrder[0],
    );
  });

  it("左栏列出服务器与状态，默认选中第一台", async () => {
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
    ).toBeNull();
    expect(await screen.findByRole("heading", { name: "新建节点" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /新加坡 1 · DigitalOcean/ }));
    expect(await screen.findByText("已就绪")).toBeTruthy();
  });

  it("收到 my-server-changed 后重新读取选中详情", async () => {
    const bridge = makeBridge();
    renderHarness(bridge);

    fireEvent.click(await screen.findByRole("button", { name: /新加坡 1 · DigitalOcean/ }));
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

  it("详情读不到：中间保留卡片与重试，不空白", async () => {
    const bridge = makeBridge();
    bridge.myServerGet.mockRejectedValue(new Error("down"));
    renderHarness(bridge);

    fireEvent.click(
      await screen.findByRole("button", { name: /新加坡 1 · DigitalOcean/ }),
    );
    const card = await screen.findByRole("alert");
    expect(card.textContent).toContain("连不上服务器");
    expect(card.textContent).toContain("没有产生或改动任何服务器");
    expect(card.className).toContain("myservers__detail-card");

    bridge.myServerGet.mockResolvedValue(SERVERS[0]);
    fireEvent.click(within(card).getByRole("button", { name: "重试" }));

    expect(await screen.findByText("已就绪")).toBeTruthy();
    expect(screen.queryByText("没有产生或改动任何服务器。")).toBeNull();
  });

  it("切换服务器时清掉上一台的详情错误", async () => {
    const bridge = makeBridge();
    bridge.myServerGet.mockImplementation(async (serverId: string) => {
      if (serverId === "srv_1") throw new Error("down");
      return SERVERS[1];
    });
    renderHarness(bridge);

    fireEvent.click(
      await screen.findByRole("button", { name: /新加坡 1 · DigitalOcean/ }),
    );
    expect(
      await screen.findByText("没有产生或改动任何服务器。"),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /纽约 1 · DigitalOcean/ }));
    expect(await screen.findByText("正在安装 65%")).toBeTruthy();
    expect(screen.queryByText("没有产生或改动任何服务器。")).toBeNull();
  });

  it("超时重试复用幂等键；业务终态失败才换新键", async () => {
    const bridge = makeBridge();
    const keys: string[] = [];
    bridge.myServerCreate.mockImplementation(async (input) => {
      keys.push(input.idempotencyKey);
      throw {
        code: "TIMEOUT",
        message: "请求超时。",
        details: { reason: "timeout" },
        retryable: true,
      };
    });
    renderHarness(bridge);

    fireEvent.click(await screen.findByRole("button", { name: "创建" }));
    await screen.findByText("可以点「创建」再试一次。");
    fireEvent.click(screen.getByRole("button", { name: "创建" }));
    await waitFor(() => expect(keys).toHaveLength(2));
    expect(keys[0]).toBe(keys[1]);

    bridge.myServerCreate.mockImplementationOnce(async (input) => {
      keys.push(input.idempotencyKey);
      throw {
        code: "PRECONDITION_FAILED",
        message: "这个地区暂时没货。",
        details: { reason: "region_unavailable" },
        retryable: false,
      };
    });
    fireEvent.click(screen.getByRole("button", { name: "创建" }));
    await waitFor(() => expect(keys).toHaveLength(3));
    expect(keys[2]).toBe(keys[1]);

    bridge.myServerCreate.mockImplementationOnce(async (input) => {
      keys.push(input.idempotencyKey);
      throw {
        code: "TIMEOUT",
        message: "请求超时。",
        details: { reason: "timeout" },
        retryable: true,
      };
    });
    fireEvent.click(screen.getByRole("button", { name: "创建" }));
    await waitFor(() => expect(keys).toHaveLength(4));
    expect(keys[3]).not.toBe(keys[2]);
  });

  it("换了地区或套餐再下单，必须换新幂等键", async () => {
    const bridge = makeBridge();
    const keys: string[] = [];
    bridge.myServerCreate.mockImplementation(async (input) => {
      keys.push(input.idempotencyKey);
      throw {
        code: "TIMEOUT",
        message: "请求超时。",
        details: { reason: "timeout" },
        retryable: true,
      };
    });
    renderHarness(bridge);

    fireEvent.click(await screen.findByRole("button", { name: "创建" }));
    await screen.findByText("可以点「创建」再试一次。");

    // 超时后换了地区：同一个键配不同请求体，控制面会直接拒绝。
    fireEvent.click(screen.getByRole("radio", { name: "纽约 1" }));
    fireEvent.click(screen.getByRole("button", { name: "创建" }));
    await waitFor(() => expect(keys).toHaveLength(2));
    expect(keys[1]).not.toBe(keys[0]);
  });

  it("安装中：只有进度和销毁", async () => {
    renderHarness(makeBridge());

    fireEvent.click(await screen.findByRole("button", { name: /纽约 1 · DigitalOcean/ }));
    expect(await screen.findByText("正在安装 65%")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "用来建配置" })).toBeNull();
    expect(screen.getByRole("button", { name: "销毁" })).toBeTruthy();
  });

  it("出错时不显示重建入口（端点未支持）", async () => {
    renderHarness(makeBridge());
    fireEvent.click(await screen.findByRole("button", { name: /法兰克福 1 · DigitalOcean/ }));
    expect(await screen.findByText(/服务端没装好/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "重新建一台" })).toBeNull();
  });

  it("创建中销毁：确认文案说明会中断安装", async () => {
    renderHarness(makeBridge());

    fireEvent.click(await screen.findByRole("button", { name: /纽约 1 · DigitalOcean/ }));
    await screen.findByText("正在安装 65%");
    fireEvent.click(screen.getByRole("button", { name: "销毁" }));
    expect(
      screen.getByText("取消创建并销毁这台服务器？正在进行的安装会中断。"),
    ).toBeTruthy();
  });

  it("可用时销毁：二次确认后调用 myServerDestroy", async () => {
    const bridge = makeBridge();
    renderHarness(bridge);

    fireEvent.click(await screen.findByRole("button", { name: /新加坡 1 · DigitalOcean/ }));
    await screen.findByText("已就绪");
    fireEvent.click(screen.getByRole("button", { name: "销毁" }));
    expect(screen.getByText(/销毁后不再产生新费用。未用完的整天退回余额/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "确认销毁" }));
    await waitFor(() =>
      expect(bridge.myServerDestroy).toHaveBeenCalledWith("srv_1", true),
    );
  });

  it("零台：中间仍是创建页，左栏提示、状态已登录", async () => {
    renderHarness(makeBridge([]));

    expect(await screen.findByText("还没有服务器")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: /me@example.com/ }),
    ).toBeTruthy();
    expect(await screen.findByRole("heading", { name: "新建节点" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "创建" })).toBeTruthy();
    expect(document.querySelectorAll(".myservers .btn--primary")).toHaveLength(1);
  });

  it("Esc 从详情回创建页；再点图标同理", async () => {
    const { rerenderWithSignal } = renderHarness(makeBridge());

    fireEvent.click(await screen.findByRole("button", { name: /法兰克福 1 · DigitalOcean/ }));
    expect(await screen.findByText(/服务端没装好/)).toBeTruthy();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(await screen.findByRole("heading", { name: "新建节点" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /法兰克福 1 · DigitalOcean/ }));
    rerenderWithSignal(1);
    expect(await screen.findByRole("heading", { name: "新建节点" })).toBeTruthy();
  });

  it("创建页默认就在：三区块、默认中档、底部汇总与唯一主按钮", async () => {
    renderHarness(makeBridge());

    expect(await screen.findByRole("heading", { name: "新建节点" })).toBeTruthy();

    expect(screen.getByRole("radiogroup", { name: "地区" })).toBeTruthy();
    expect(screen.getByText("亚洲")).toBeTruthy();
    expect(screen.getByText("北美洲")).toBeTruthy();
    expect(screen.getByRole("radiogroup", { name: "服务器类型" })).toBeTruthy();
    expect(screen.getByText("Ubuntu 24.04 LTS")).toBeTruthy();

    // 默认地区按大洲渲染顺序取第一组第一个，不是目录数组的第一个。
    expect(
      screen.getByRole("radio", { name: "新加坡 1" }).getAttribute("aria-checked"),
    ).toBe("true");

    // 三档按目录顺序排；默认选中 1 GB 那档。
    expect(
      screen.getByRole("radio", { name: /1 GB/ }).getAttribute("aria-checked"),
    ).toBe("true");
    expect(
      screen.getByRole("radio", { name: /每月 1000 GB 流量/ }),
    ).toBeTruthy();
    expect(screen.getByText("入门")).toBeTruthy();
    expect(screen.getByText("标准")).toBeTruthy();
    expect(screen.getByText("进阶")).toBeTruthy();

    expect(document.querySelector(".wizard-foot__price")?.textContent).toContain(
      "每天 $0.30 · 约 $9/月",
    );
    expect(document.querySelectorAll(".myservers .btn--primary")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "创建" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "下一步" })).toBeNull();
    expect(screen.queryByText("确认订单")).toBeNull();
    expect(screen.queryByRole("button", { name: "返回" })).toBeNull();
  });

  it("服务器类型卡 ↑↓ 切换选中，汇总跟着变", async () => {
    renderHarness(makeBridge());

    fireEvent.click(await screen.findByRole("button", { name: "新建节点" }));
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
      "每天 $0.60 · 约 $18/月",
    );

    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "ArrowUp" });
    expect(
      within(group).getByRole("radio", { name: /1 GB/ }).getAttribute("aria-checked"),
    ).toBe("true");
  });

  it("创建按所选地区与档位下单", async () => {
    const bridge = makeBridge();
    renderHarness(bridge);

    fireEvent.click(await screen.findByRole("button", { name: "新建节点" }));
    fireEvent.click(await screen.findByRole("radio", { name: "纽约 1" }));
    fireEvent.click(await screen.findByRole("radio", { name: /2 GB/ }));
    fireEvent.click(screen.getByRole("button", { name: "创建" }));

    await waitFor(() =>
      expect(bridge.myServerCreate).toHaveBeenCalledWith({
        region: "nyc1",
        plan: "s-1vcpu-2gb",
        idempotencyKey: expect.any(String),
      }),
    );
    expect(bridge.myServerCheckout).toHaveBeenCalledWith("ord_1");
  });

  it("Host 回 auth_required 时拉起登录框，不当作普通错误", async () => {
    const bridge = makeBridge();
    bridge.myServerCreate.mockRejectedValueOnce({
      code: "PRECONDITION_FAILED",
      message: "需要先登录。",
      details: { reason: "auth_required" },
      retryable: true,
    });
    renderHarness(bridge);

    fireEvent.click(await screen.findByRole("button", { name: "创建" }));
    expect(await screen.findByRole("dialog", { name: "登录我的服务器" })).toBeTruthy();
    expect(await screen.findByText("登录已过期。重新登录后再试。")).toBeTruthy();
  });

  it("余额不足：显示还差多少，点「去充值」打开充值档位", async () => {
    const bridge = makeBridge();
    bridge.myServerCheckout.mockRejectedValueOnce({
      code: "PRECONDITION_FAILED",
      message: "余额不够扣这个月的费用。",
      details: { reason: "insufficient_balance", shortfall_cents: 520 },
      retryable: true,
    });
    renderHarness(bridge);

    fireEvent.click(await screen.findByRole("button", { name: "创建" }));
    expect(await screen.findByText("余额不足，还差 $5.20。")).toBeTruthy();
    expect(screen.getByText("充值后回到这里，再点「创建」。")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "去充值" }));
    expect(await screen.findByRole("dialog", { name: "充值" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "$10.00" })).toBeTruthy();
  });

  it("创建前先查余额：不够就不下单", async () => {
    const bridge = makeBridge();
    bridge.myServerWallet.mockResolvedValue({ ...WALLET, balance_cents: 10 });
    renderHarness(bridge);

    fireEvent.click(await screen.findByRole("button", { name: "创建" }));
    expect(await screen.findByText(/余额不足，还差/)).toBeTruthy();
    expect(bridge.myServerCreate).not.toHaveBeenCalled();
  });

  it("扣费成功：显示扣了多少、还剩多少", async () => {
    const bridge = makeBridge();
    renderHarness(bridge);

    fireEvent.click(await screen.findByRole("button", { name: "创建" }));
    expect(await screen.findByText("已扣 $0.30，余额 $7.70。")).toBeTruthy();
  });

  it("左栏底部不再有设置，设置只留活动栏", async () => {
    const bridge = makeBridge();
    renderHarness(bridge);
    await screen.findByRole("button", { name: /me@example.com/ });
    expect(screen.queryByRole("button", { name: "设置" })).toBeNull();
  });

  it("账号块：行内显示邮箱与余额摘要", async () => {
    const bridge = makeBridge();
    renderHarness(bridge);

    expect(await screen.findByText("$8.00")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: /me@example.com/ }),
    ).toBeTruthy();
  });

  it("验证码错误：提示还能试几次", async () => {
    const bridge = makeBridge();
    bridge.setAccount(LOGGED_OUT);
    bridge.myServerLoginVerify.mockRejectedValueOnce({
      code: "PRECONDITION_FAILED",
      message: "验证码不对。",
      details: { reason: "code_invalid", attempts_remaining: 2 },
      retryable: true,
    });
    renderHarness(bridge);

    fireEvent.click(await screen.findByRole("button", { name: "登录" }));
    const dialog = await screen.findByRole("dialog", { name: "登录我的服务器" });
    fireEvent.change(within(dialog).getByLabelText("邮箱"), {
      target: { value: "me@example.com" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "发送验证码" }));
    fireEvent.change(await within(dialog).findByLabelText("验证码"), {
      target: { value: "000000" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "登录" }));

    expect(await within(dialog).findByText("还可以试 2 次。")).toBeTruthy();
    expect(bridge.myServerLoginVerify).toHaveBeenCalledWith("me@example.com", "000000");
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

    fireEvent.click(await screen.findByRole("button", { name: "新建节点" }));
    fireEvent.click(await screen.findByRole("button", { name: "创建" }));
    expect(
      await screen.findByText("可以点「创建」再试一次。"),
    ).toBeTruthy();

    bridge.myServerCreate.mockRejectedValueOnce({
      code: "PRECONDITION_FAILED",
      message: "这个地区暂时没货。",
      details: { reason: "region_unavailable" },
      retryable: false,
    });
    fireEvent.click(screen.getByRole("button", { name: "创建" }));
    expect(
      await screen.findByText("换一个地区或档位，再点「创建」。"),
    ).toBeTruthy();
  });

  it("读不到目录：一句提示 + 重试，重试成功后进入向导", async () => {
    const bridge = makeBridge();
    bridge.myServerCatalog.mockRejectedValue(new Error("catalog down"));
    renderHarness(bridge);

    expect(await screen.findByText("读不到可选地区")).toBeTruthy();

    bridge.myServerCatalog.mockResolvedValue(CATALOG);
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(
      await screen.findByRole("radiogroup", { name: "服务器类型" }),
    ).toBeTruthy();
  });

  it("创建页 Esc 不弹确认、不丢选择", async () => {
    renderHarness(makeBridge());

    expect(await screen.findByRole("heading", { name: "新建节点" })).toBeTruthy();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByText(/还没下单/)).toBeNull();
    expect(screen.getByRole("heading", { name: "新建节点" })).toBeTruthy();
  });

  it("用来建配置把 node_id 交回新建流程", async () => {
    const onUseServer = vi.fn();
    render(<Harness bridge={makeBridge()} onUseServer={onUseServer} />);

    fireEvent.click(await screen.findByRole("button", { name: /新加坡 1 · DigitalOcean/ }));
    await screen.findByText("已就绪");
    fireEvent.click(screen.getByRole("button", { name: "用来建配置" }));
    expect(onUseServer).toHaveBeenCalledWith(
      expect.objectContaining({ server_id: "srv_1" }),
    );
  });
});
