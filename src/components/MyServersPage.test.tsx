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
        catalog={state.catalog}
        error={state.error}
        retryNotice={state.retryNotice}
        disabled={state.identityLost}
        onSelect={state.select}
        onNew={state.openWizard}
      />
      <MyServersPage
        bridge={bridge as unknown as AgentBridge}
        catalog={state.catalog}
        selected={state.selected}
        account={state.account}
        accountLoaded={state.accountLoaded}
        accountError={state.accountError}
        loading={state.loading}
        error={state.error}
        retrying={state.retrying}
        detailError={state.detailError}
        detailRetrying={state.detailRetrying}
        readOnly={state.identityLost}
        sharedTransfer={state.sharedTransfer}
        onNew={state.openWizard}
        onLogin={state.openLogin}
        onRefreshAccount={() => void state.refreshAccount()}
        onRetry={() => void state.retry()}
        onUseServer={onUseServer}
        onChanged={() => void state.refresh()}
        onGone={() => state.ordered(null)}
        onRebuilt={state.rebuilt}
        onRetryDetail={state.retryDetail}
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
  it("有服务器默认选中第一台，左栏两行、中间是详情", async () => {
    const bridge = makeBridge();
    renderHarness(bridge);

    expect(
      await screen.findByRole("button", { name: /新加坡 1 · DigitalOcean/ }),
    ).toBeTruthy();
    // 左栏第二行：状态 · 地区 · 每日价
    const rail = screen.getByRole("complementary", { name: "服务器列表" });
    expect(rail.textContent).toContain("可用 · 新加坡 1 · $0.30/天");
    // 中间直接是第一台详情，没有创建向导
    expect(
      await screen.findByRole("heading", { name: "新加坡 1 · DigitalOcean" }),
    ).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "新建节点" })).toBeNull();
  });

  it("未登录：左栏只留标题行，中间先登录，登录后加载列表并选中第一台", async () => {
    const bridge = makeBridge();
    bridge.setAccount(LOGGED_OUT);
    renderHarness(bridge);

    expect(await screen.findByRole("heading", { name: "先登录" })).toBeTruthy();
    // 空态在舞台可用高度内垂直居中：容器带 --empty 修饰类。
    expect(document.querySelector(".myservers--empty")).not.toBeNull();
    const rail = await screen.findByRole("complementary", { name: "服务器列表" });
    expect(within(rail).getByText("我的服务器")).toBeTruthy();
    expect(within(rail).getByText("0")).toBeTruthy();
    // 空态与 CTA 只在中间，左栏不再给同义入口。
    expect(within(rail).queryByText("登录后查看你的服务器")).toBeNull();
    expect(
      within(rail).queryByRole("button", { name: "登录" }),
    ).toBeNull();
    expect(bridge.myServerList).not.toHaveBeenCalled();

    expect(
      screen.getByText("登录后可以买服务器；服务器装好后，节点会出现在节点池里。"),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "登录" }));
    const dialog = await screen.findByRole("dialog", { name: "登录我的服务器" });
    fireEvent.change(within(dialog).getByLabelText("邮箱"), {
      target: { value: "me@example.com" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "发送验证码" }));
    fireEvent.change(await within(dialog).findByLabelText("验证码"), {
      target: { value: "123456" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "登录" }));

    expect(
      await screen.findByRole("heading", { name: "新加坡 1 · DigitalOcean" }),
    ).toBeTruthy();
    expect(bridge.myServerList).toHaveBeenCalled();
  });

  it("已登录零台：左栏只留标题行，中间空态与新建入口", async () => {
    const bridge = makeBridge([]);
    renderHarness(bridge);

    expect((await screen.findAllByText("还没有服务器")).length).toBe(1);
    expect(document.querySelector(".myservers--empty")).not.toBeNull();
    const rail = screen.getByRole("complementary", { name: "服务器列表" });
    expect(within(rail).getByText("我的服务器")).toBeTruthy();
    expect(within(rail).getByText("0")).toBeTruthy();
    expect(within(rail).queryByText("还没有服务器")).toBeNull();
    expect(within(rail).getByRole("button", { name: "新建节点" })).toBeTruthy();
    expect(
      screen.getAllByRole("button", { name: "新建节点" }).length,
    ).toBeGreaterThanOrEqual(2);
  });

  it("列表失败：只保留中间一个重试按钮，重试可恢复", async () => {
    const bridge = makeBridge();
    bridge.myServerList.mockRejectedValueOnce({
      code: "NETWORK",
      message: "连不上。",
      retryable: true,
    });
    renderHarness(bridge);

    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getAllByText("连不上服务器，稍后再试").length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "重试" })).toBeTruthy();
    // 左栏不再放第二个重试按钮。
    expect(screen.getAllByRole("button", { name: "重试" }).length).toBe(1);
  });

  it("账户读取失败：中间账户暂时读不到 + 重试", async () => {
    const bridge = makeBridge();
    bridge.myServerAccount.mockRejectedValue({
      code: "NETWORK",
      message: "连不上。",
      retryable: true,
    });
    renderHarness(bridge);

    expect(
      await screen.findByRole("heading", { name: "账户暂时读不到" }),
    ).toBeTruthy();
    expect(screen.getByText("检查网络后再试。")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(bridge.myServerAccount.mock.calls.length).toBeGreaterThan(1);
  });

  it("详情事实只有地区 / 节点 / 费用 / 流量，不显示 IP 与规格", async () => {
    const bridge = makeBridge([
      server({ server_id: "srv_1", name: "新加坡 1 · DigitalOcean" }),
    ]);
    renderHarness(bridge);

    await screen.findByRole("heading", { name: "新加坡 1 · DigitalOcean" });
    const facts = [...document.querySelectorAll(".myservers__facts dt")].map(
      (node) => node.textContent,
    );
    expect(facts).toEqual(["地区", "节点", "费用", "流量"]);
    expect(screen.queryByText("45.76.20.100")).toBeNull();
    expect(screen.queryByText("1 核 · 1 GB")).toBeNull();
  });

  it("主按钮按状态：可用是连接，出错是重新建一台，安装中不显示", async () => {
    const bridge = makeBridge([
      server({ server_id: "srv_1", name: "可用的一台" }),
      server({ server_id: "srv_2", name: "出错的一台", state: "error", node_id: null }),
      server({ server_id: "srv_3", name: "安装中的一台", state: "installing", node_id: null }),
    ]);
    renderHarness(bridge);

    await screen.findByRole("heading", { name: "可用的一台" });
    expect(screen.getByRole("button", { name: "连接" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /出错的一台/ }));
    expect(await screen.findByRole("heading", { name: "出错的一台" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "重新建一台" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /安装中的一台/ }));
    expect(
      await screen.findByRole("heading", { name: "安装中的一台" }),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "连接" })).toBeNull();
  });

  it("左栏底部不再有设置，账号只留导航入口", async () => {
    const bridge = makeBridge();
    renderHarness(bridge);
    await screen.findByRole("button", { name: /新加坡 1 · DigitalOcean/ });
    expect(screen.queryByRole("button", { name: "设置" })).toBeNull();
    expect(screen.queryByText("me@example.com")).toBeNull();
  });

  it("一条服务器被事件改成安装中后，左栏第二行跟着变", async () => {
    const bridge = makeBridge([
      server({ server_id: "srv_1", name: "新加坡 1 · DigitalOcean" }),
    ]);
    renderHarness(bridge);
    await screen.findByRole("button", { name: /新加坡 1 · DigitalOcean/ });

    act(() => {
      bridge.emit({
        name: AGENT_EVENTS.myServerChanged,
        payload: {
          contract_version: "x",
          server_id: "srv_1",
          state: "installing",
          node_id: null,
          failure: null,
          emitted_at: "",
        },
      } as never);
    });
    await waitFor(() =>
      expect(
        screen.getByRole("complementary", { name: "服务器列表" }).textContent,
      ).toContain("安装中"),
    );
  });
});
