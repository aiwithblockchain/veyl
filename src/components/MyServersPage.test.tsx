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
import { isSignedIn, useMyServers } from "../myservers/useMyServers";
import { setLanguage } from "../i18n";
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
    local_node_id: "local_node_srv_1",
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
  session_expires_at: null,
};

const LOGGED_OUT: MyServerAccount = {
  logged_in: false,
  email: null,
  account_id: null,
  device_id: "dev_1",
  account_kind: "device",
  session_expires_at: null,
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

type TrialProp = NonNullable<
  Parameters<typeof MyServersPage>[0]["trial"]
>;

type ServersState = ReturnType<typeof useMyServers>;

function Harness({
  bridge,
  rootSignal = 0,
  trial = null,
  onGoConnect = vi.fn(),
  stateRef,
}: {
  bridge: StubBridge;
  rootSignal?: number;
  trial?: TrialProp | null;
  onGoConnect?: () => void;
  /** 和 App.tsx 一样把 hook 状态接到页面上，用例里通过它触发下单。 */
  stateRef?: { current: ServersState | null };
}) {
  const state = useMyServers(bridge as unknown as AgentBridge, {
    active: true,
    rootSignal,
  });
  if (stateRef) stateRef.current = state;
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
        signedIn={!state.accountLoaded || isSignedIn(state.account)}
        accountError={state.accountError}
        catalogError={state.catalogError}
        onSelect={state.select}
        onNew={state.openWizard}
      />
      <MyServersPage
        bridge={bridge as unknown as AgentBridge}
        catalog={state.catalog}
        selected={state.selected}
        account={state.account}
        signedIn={isSignedIn(state.account)}
        accountLoaded={state.accountLoaded}
        accountError={state.accountError}
        catalogError={state.catalogError}
        loading={state.loading}
        error={state.error}
        retrying={state.retrying}
        detailError={state.detailError}
        detailRetrying={state.detailRetrying}
        readOnly={state.identityLost}
        onNew={state.openWizard}
        onLogin={state.openLogin}
        onRefreshAccount={() => void state.refreshAccount()}
        onRetry={() => void state.retry()}
        onChanged={() => void state.refresh()}
        onGone={() => state.ordered(null)}
        onForget={async () => {}}
        onRebuilt={state.rebuilt}
        onRetryDetail={state.retryDetail}
        trial={trial}
        onGoConnect={onGoConnect}
        pendingServer={state.pendingServer || state.awaitingSelected}
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

function renderHarness(
  bridge: StubBridge,
  over: {
    trial?: TrialProp | null;
    onGoConnect?: () => void;
  } = {},
) {
  const view = render(<Harness bridge={bridge} {...over} />);
  return {
    rerenderWithSignal: (signal: number) =>
      view.rerender(<Harness bridge={bridge} rootSignal={signal} {...over} />),
  };
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  setLanguage("zh");
});

describe("英文界面", () => {
  it("未登录空态取 en 字典", async () => {
    setLanguage("en");
    const bridge = makeBridge([]);
    bridge.setAccount(LOGGED_OUT);
    renderHarness(bridge);
    expect(
      await screen.findByText("Sign in to manage your servers"),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Sign in / Sign up" }),
    ).toBeTruthy();
  });

  it("会话过期：登录引导写明超过 30 天没用过", async () => {
    const bridge = makeBridge([]);
    bridge.setAccount({
      logged_in: false,
      email: "me@example.com",
      account_id: "acct_1",
      device_id: "dev_1",
      account_kind: "email",
      session_expires_at: "2020-01-01T00:00:00Z",
    });
    renderHarness(bridge);
    expect(
      await screen.findByText("超过 30 天没有使用，请重新登录。"),
    ).toBeTruthy();
  });

  it("设备身份：用通用登录说明，不误报过期", async () => {
    const bridge = makeBridge([]);
    bridge.setAccount(LOGGED_OUT);
    renderHarness(bridge);
    expect(
      await screen.findByText("用邮箱验证码登录，服务器与余额跟着账户走。"),
    ).toBeTruthy();
    expect(screen.queryByText("超过 30 天没有使用，请重新登录。")).toBeNull();
  });

  it("已登录首屏先给加载态，不闪登录引导", async () => {
    const bridge = makeBridge();
    let resolveAccount: (value: MyServerAccount) => void = () => {};
    vi.mocked(bridge.myServerAccount).mockReturnValue(
      new Promise((resolve) => {
        resolveAccount = resolve;
      }),
    );
    renderHarness(bridge);

    // 账户还没读回来：没有登录按钮，也没有登录引导标题。
    expect(screen.queryByRole("button", { name: "登录 / 注册" })).toBeNull();
    expect(
      screen.queryByRole("heading", { name: "登录后管理你的服务器" }),
    ).toBeNull();

    await act(async () => {
      resolveAccount({ ...ACCOUNT });
    });

    expect(
      await screen.findByRole("heading", { name: "新加坡 1 · DigitalOcean" }),
    ).toBeTruthy();
  });
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

    expect(await screen.findByRole("heading", { name: "登录后管理你的服务器" })).toBeTruthy();
    // 空态在舞台可用高度内垂直居中：容器带 --empty 修饰类。
    expect(document.querySelector(".myservers--empty")).not.toBeNull();
    const rail = await screen.findByRole("complementary", { name: "服务器列表" });
    expect(within(rail).getByText("我的服务器")).toBeTruthy();
    // 未登录左栏只留标题与一行提示，不渲染行、计数与任何按钮。
    expect(
      within(rail).getByText("登录后这里会列出你的服务器。"),
    ).toBeTruthy();
    expect(within(rail).queryByRole("button")).toBeNull();
    expect(bridge.myServerList).not.toHaveBeenCalled();

    expect(
      screen.getByText("用邮箱验证码登录，服务器与余额跟着账户走。"),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "登录 / 注册" }));
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

  it("账户读失败时优先显示错误态，不显示登录引导", async () => {
    const bridge = makeBridge([]);
    bridge.setAccount(LOGGED_OUT);
    const stateRef: { current: ServersState | null } = { current: null };
    render(<Harness bridge={bridge} stateRef={stateRef} />);

    await screen.findByRole("heading", { name: "登录后管理你的服务器" });

    // 控制面不可达：account 命令失败，本地还留着 logged_in=false 的旧账户。
    vi.mocked(bridge.myServerAccount).mockRejectedValueOnce({
      code: "NETWORK",
      message: "",
    });
    await act(async () => {
      await stateRef.current?.refreshAccount();
    });

    expect(
      await screen.findByRole("heading", { name: "账户暂时读不到" }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("heading", { name: "登录后管理你的服务器" }),
    ).toBeNull();
    expect(screen.getByRole("button", { name: "重试" })).toBeTruthy();
    // 左栏同样给「连不上」，不写成登录提示。
    expect(screen.getByText("连不上服务器，稍后再试")).toBeTruthy();
    expect(screen.queryByText("登录后这里会列出你的服务器。")).toBeNull();

    // 重试成功：清掉错误，回到原来的登录前空态。
    await act(async () => {
      await stateRef.current?.refreshAccount();
    });
    expect(
      await screen.findByRole("heading", { name: "登录后管理你的服务器" }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("heading", { name: "账户暂时读不到" }),
    ).toBeNull();
  });

  it("目录探针失败且未登录：显示控制面不可达，恢复后回到登录引导", async () => {
    const bridge = makeBridge([]);
    bridge.setAccount(LOGGED_OUT);
    vi.mocked(bridge.myServerCatalog).mockRejectedValueOnce({
      code: "UPSTREAM_ERROR",
      details: { reason: "network" },
    });
    const stateRef: { current: ServersState | null } = { current: null };
    render(<Harness bridge={bridge} stateRef={stateRef} />);

    expect(
      await screen.findByRole("heading", { name: "账户暂时读不到" }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("heading", { name: "登录后管理你的服务器" }),
    ).toBeNull();
    expect(screen.getByText("连不上服务器，稍后再试")).toBeTruthy();
    expect(stateRef.current?.catalogError).toBe(true);

    // 重试同时重拉目录：目录恢复但确实未登录，回到登录引导。
    await act(async () => {
      await stateRef.current?.refreshAccount();
    });
    expect(
      await screen.findByRole("heading", { name: "登录后管理你的服务器" }),
    ).toBeTruthy();
    expect(stateRef.current?.catalogError).toBe(false);
  });

  it("目录 5xx（upstream_status）：控制面可达，未登录仍显示登录引导", async () => {
    const bridge = makeBridge([]);
    bridge.setAccount(LOGGED_OUT);
    vi.mocked(bridge.myServerCatalog).mockRejectedValueOnce({
      code: "UPSTREAM_ERROR",
      details: { reason: "upstream_status", status: 502 },
    });
    const stateRef: { current: ServersState | null } = { current: null };
    render(<Harness bridge={bridge} stateRef={stateRef} />);

    expect(
      await screen.findByRole("heading", { name: "登录后管理你的服务器" }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("heading", { name: "账户暂时读不到" }),
    ).toBeNull();
    // 服务端错误不算「控制面不可达」，只记日志。
    expect(stateRef.current?.catalogError).toBe(false);
  });

  it("已登录后账户重读失败：中间保留详情，左栏保留列表，不整页报错", async () => {
    const bridge = makeBridge([
      server({ server_id: "srv_1", name: "新加坡 1 · DigitalOcean" }),
    ]);
    const stateRef: { current: ServersState | null } = { current: null };
    render(<Harness bridge={bridge} stateRef={stateRef} />);
    await screen.findByRole("heading", { name: "新加坡 1 · DigitalOcean" });

    // 已登录，随后账户重读失败（断网）：不能把整页翻成错误态。
    vi.mocked(bridge.myServerAccount).mockRejectedValueOnce({
      code: "NETWORK",
      message: "",
    });
    await act(async () => {
      await stateRef.current?.refreshAccount();
    });

    expect(stateRef.current?.accountError).toBe(true);
    expect(
      screen.getByRole("heading", { name: "新加坡 1 · DigitalOcean" }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("heading", { name: "账户暂时读不到" }),
    ).toBeNull();
    const rail = screen.getByRole("complementary", { name: "服务器列表" });
    expect(
      within(rail).getByRole("button", { name: /新加坡 1 · DigitalOcean/ }),
    ).toBeTruthy();
    expect(screen.queryByText("连不上服务器，稍后再试")).toBeNull();
  });

  it("断网错误态之后登录成功：错误态消失，进入已登录界面", async () => {
    const bridge = makeBridge([]);
    bridge.setAccount(LOGGED_OUT);
    vi.mocked(bridge.myServerAccount).mockRejectedValueOnce({
      code: "NETWORK",
      message: "",
    });
    vi.mocked(bridge.myServerCatalog).mockRejectedValueOnce({
      code: "UPSTREAM_ERROR",
      details: { reason: "network" },
    });
    const stateRef: { current: ServersState | null } = { current: null };
    render(<Harness bridge={bridge} stateRef={stateRef} />);

    expect(
      await screen.findByRole("heading", { name: "账户暂时读不到" }),
    ).toBeTruthy();
    expect(stateRef.current?.accountError).toBe(true);
    expect(stateRef.current?.catalogError).toBe(true);

    await act(async () => {
      await stateRef.current?.loginVerify("me@example.com", "123456");
    });

    expect(
      screen.queryByRole("heading", { name: "账户暂时读不到" }),
    ).toBeNull();
    expect(stateRef.current?.accountError).toBe(false);
    expect(stateRef.current?.catalogError).toBe(false);
    expect(
      await screen.findByRole("heading", { name: "还没有服务器" }),
    ).toBeTruthy();
  });

  it("断网错误态之后登出：回到登录引导，不残留错误态", async () => {
    const bridge = makeBridge();
    const stateRef: { current: ServersState | null } = { current: null };
    render(<Harness bridge={bridge} stateRef={stateRef} />);
    await screen.findByRole("heading", { name: "新加坡 1 · DigitalOcean" });

    vi.mocked(bridge.myServerAccount).mockRejectedValueOnce({
      code: "NETWORK",
      message: "",
    });
    vi.mocked(bridge.myServerCatalog).mockRejectedValueOnce({
      code: "UPSTREAM_ERROR",
      details: { reason: "network" },
    });
    await act(async () => {
      await stateRef.current?.refreshAccount();
    });
    expect(stateRef.current?.accountError).toBe(true);
    expect(stateRef.current?.catalogError).toBe(true);

    await act(async () => {
      await stateRef.current?.logout();
    });

    expect(stateRef.current?.accountError).toBe(false);
    expect(stateRef.current?.catalogError).toBe(false);
    expect(
      await screen.findByRole("heading", { name: "登录后管理你的服务器" }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("heading", { name: "账户暂时读不到" }),
    ).toBeNull();
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

  it("下单后列表还没回来：显示「正在创建」而不是空态，列表出现后恢复详情", async () => {
    let list: MyServer[] = [];
    const bridge = makeBridge([]);
    bridge.myServerList.mockImplementation(async () => ({ servers: list }));
    // 新机器还没进列表时，详情接口自然查不到：不能靠它先渲染出一台机器。
    bridge.myServerGet.mockImplementation(async (serverId: string) => {
      const found = list.find((item) => item.server_id === serverId);
      if (!found) throw { code: "NOT_FOUND", message: "没有这台服务器" };
      return found;
    });
    const stateRef: { current: ServersState | null } = { current: null };
    render(<Harness bridge={bridge} stateRef={stateRef} />);

    await screen.findByRole("heading", { name: "还没有服务器" });

    // 下单成功：选中新 id，刷新还在路上，列表仍是空的。
    await act(async () => {
      stateRef.current!.ordered("srv_new");
    });
    expect(
      screen.getByText("服务器已下单，正在创建，稍后会自动出现。"),
    ).toBeTruthy();
    expect(screen.queryByText("还没有服务器")).toBeNull();

    // 列表返回这台新机器：自动回到它的详情，不再停在「正在创建」。
    list = [
      server({
        server_id: "srv_new",
        name: "新建的一台",
        state: "installing",
        node_id: null,
      }),
    ];
    await act(async () => {
      await stateRef.current!.refresh();
    });

    expect(await screen.findByRole("heading", { name: "新建的一台" })).toBeTruthy();
    expect(
      screen.queryByText("服务器已下单，正在创建，稍后会自动出现。"),
    ).toBeNull();
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

  it("详情读取失败：中间给新文案，不再写「连不上服务器」", () => {
    const onRetryDetail = vi.fn();
    render(
      <MyServersPage
        bridge={makeBridge() as unknown as AgentBridge}
        catalog={CATALOG}
        selected={server()}
        account={ACCOUNT}
        signedIn={true}
        accountLoaded={true}
        accountError={false}
        loading={false}
        error={null}
        retrying={false}
        detailError="这台服务器的详情暂时读不到。已有服务器和节点不受影响；稍后再试。"
        detailRetrying={false}
        readOnly={false}
        onNew={vi.fn()}
        onLogin={vi.fn()}
        onRefreshAccount={vi.fn()}
        onRetry={vi.fn()}
        onChanged={vi.fn()}
        onGone={vi.fn()}
        onForget={async () => {}}
        onRebuilt={vi.fn()}
        onRetryDetail={onRetryDetail}
        onGoConnect={vi.fn()}
      />,
    );

    const card = screen.getByRole("alert");
    expect(within(card).getByText("这台服务器的详情暂时读不到。")).toBeTruthy();
    expect(
      within(card).getByText("已有服务器和节点不受影响；稍后再试。"),
    ).toBeTruthy();
    expect(screen.queryByText("连不上服务器。")).toBeNull();
    fireEvent.click(within(card).getByRole("button", { name: "重试" }));
    expect(onRetryDetail).toHaveBeenCalledTimes(1);
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

  it("详情事实显示地区 / IP / 节点 / 费用 / 流量，不显示规格", async () => {
    const bridge = makeBridge([
      server({ server_id: "srv_1", name: "新加坡 1 · DigitalOcean" }),
    ]);
    renderHarness(bridge);

    await screen.findByRole("heading", { name: "新加坡 1 · DigitalOcean" });
    const facts = [...document.querySelectorAll(".myservers__facts dt")].map(
      (node) => node.textContent,
    );
    expect(facts).toEqual(["地区", "IP", "节点", "费用", "流量"]);
    expect(screen.getByText("45.76.20.100")).toBeTruthy();
    expect(screen.getByRole("button", { name: "复制 IP" })).toBeTruthy();
    expect(screen.queryByText("1 核 · 1 GB")).toBeNull();
  });

  it("主按钮按状态：就绪没有主按钮，出错是重新建一台，安装中不显示", async () => {
    const bridge = makeBridge([
      server({ server_id: "srv_1", name: "可用的一台" }),
      server({ server_id: "srv_2", name: "出错的一台", state: "error", node_id: null }),
      server({ server_id: "srv_3", name: "安装中的一台", state: "installing", node_id: null }),
    ]);
    renderHarness(bridge);

    await screen.findByRole("heading", { name: "可用的一台" });
    expect(screen.queryByRole("button", { name: /连接|断开/ })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /出错的一台/ }));
    expect(await screen.findByRole("heading", { name: "出错的一台" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "重新建一台" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /安装中的一台/ }));
    expect(
      await screen.findByRole("heading", { name: "安装中的一台" }),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: /连接|断开/ })).toBeNull();
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

describe("空态里的免费节点说明", () => {
  const daysFromNow = (days: number) =>
    new Date(Date.now() + days * 86_400_000).toISOString();
  const hint = () =>
    document.querySelector(".myservers__trial-hint") as HTMLElement | null;

  it("已领试用未首次连接：写试用 7 天，不写倒计时，左栏计数不含免费节点", async () => {
    renderHarness(makeBridge([]), {
      trial: { state: "available", seedNodeCount: 2, expiresAt: null },
    });

    expect(
      await screen.findByText("还有 2 个免费节点，试用 7 天。"),
    ).toBeTruthy();
    expect(hint()?.textContent).not.toContain("天后到期");
    const rail = screen.getByRole("complementary", { name: "服务器列表" });
    expect(within(rail).getByText("0")).toBeTruthy();
    const empty = document.querySelector(".myservers__empty") as HTMLElement;
    expect(within(empty).getByRole("button", { name: "新建节点" })).toBeTruthy();
  });

  it("进行中：向下取整写到期（6 天 23 小时算 6 天），且不写试用 7 天", async () => {
    renderHarness(makeBridge([]), {
      trial: {
        state: "active",
        seedNodeCount: 2,
        expiresAt: daysFromNow(6 + 23 / 24),
      },
    });

    expect(
      await screen.findByText("还有 2 个免费节点，6 天后到期。"),
    ).toBeTruthy();
    expect(hint()?.textContent).not.toContain("试用 7 天");
    expect(document.querySelectorAll(".myservers__trial-hint")).toHaveLength(1);
  });

  it("剩余不足 24 小时写不到 1 天，不写今天", async () => {
    renderHarness(makeBridge([]), {
      trial: { state: "active", seedNodeCount: 1, expiresAt: daysFromNow(23 / 24) },
    });

    expect(
      await screen.findByText("还有 1 个免费节点，不到 1 天后到期。"),
    ).toBeTruthy();
    expect(hint()?.textContent).not.toContain("今天");
  });

  it("时间已过：即使还有 2 个免费节点也整行不显示", async () => {
    renderHarness(makeBridge([]), {
      trial: { state: "active", seedNodeCount: 2, expiresAt: daysFromNow(-1) },
    });

    await screen.findByRole("heading", { name: "还没有服务器" });
    expect(hint()).toBeNull();
    expect(screen.queryByText(/免费节点/)).toBeNull();
    expect(screen.queryByRole("button", { name: "去控制台" })).toBeNull();
  });

  it("expired 状态不信未来时间：有节点也不显示", async () => {
    renderHarness(makeBridge([]), {
      trial: { state: "expired", seedNodeCount: 2, expiresAt: daysFromNow(1) },
    });

    await screen.findByRole("heading", { name: "还没有服务器" });
    expect(hint()).toBeNull();
    expect(screen.queryByRole("button", { name: "去控制台" })).toBeNull();
  });

  it("没有到期时间或时间非法：不编造倒计时", async () => {
    renderHarness(makeBridge([]), {
      trial: { state: "active", seedNodeCount: 2, expiresAt: null },
    });
    await screen.findByRole("heading", { name: "还没有服务器" });
    expect(hint()).toBeNull();

    cleanup();
    renderHarness(makeBridge([]), {
      trial: { state: "active", seedNodeCount: 2, expiresAt: "not-a-date" },
    });
    await screen.findByRole("heading", { name: "还没有服务器" });
    expect(hint()).toBeNull();
  });

  it("有自建服务器时不显示", async () => {
    renderHarness(makeBridge(), {
      trial: {
        state: "active",
        seedNodeCount: 2,
        expiresAt: daysFromNow(6),
      },
    });

    await screen.findByRole("heading", { name: /新加坡 1 · DigitalOcean/ });
    expect(hint()).toBeNull();
    expect(screen.queryByText(/免费节点/)).toBeNull();
  });

  it("未登录也显示，且不抢主按钮", async () => {
    const bridge = makeBridge([]);
    bridge.setAccount(LOGGED_OUT);
    renderHarness(bridge, {
      trial: { state: "active", seedNodeCount: 2, expiresAt: daysFromNow(6.5) },
    });

    await screen.findByRole("heading", { name: "登录后管理你的服务器" });
    expect(screen.getByText("还有 2 个免费节点，6 天后到期。")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "登录 / 注册" }),
    ).toBeTruthy();
  });

  it("空态旁注「去控制台」只切目的地：不发起连接", async () => {
    const onGoConnect = vi.fn();
    renderHarness(makeBridge([]), {
      trial: { state: "available", seedNodeCount: 2, expiresAt: null },
      onGoConnect,
    });

    fireEvent.click(await screen.findByRole("button", { name: "去控制台" }));
    expect(onGoConnect).toHaveBeenCalledTimes(1);
  });

  it("没有试用状态时整块提示都不渲染", async () => {
    renderHarness(makeBridge([]), { trial: null });

    await screen.findByRole("heading", { name: "还没有服务器" });
    expect(hint()).toBeNull();
    expect(screen.queryByRole("button", { name: "去控制台" })).toBeNull();
  });
});

describe("服务器列表行的开通状态", () => {
  it("billing_state=pending 时显示开通中，不显示日价", () => {
    render(
      <MyServersRail
        servers={[
          server({
            name: "新加坡 1 · 新建",
            state: "installing",
            node_id: null,
            billing_state: "pending",
            paid_until: null,
          }),
        ]}
        selectedId={null}
        loading={false}
        catalog={CATALOG}
        onSelect={() => {}}
        onNew={() => {}}
      />,
    );

    const meta = document.querySelector(".rail-server__meta");
    expect(meta?.textContent).toContain("开通中");
    expect(meta?.textContent).not.toContain("/天");
  });

  it("active 行的状态词是「已开通」", () => {
    render(
      <MyServersRail
        servers={[server({ state: "active", node_id: "node_srv_1" })]}
        selectedId={null}
        loading={false}
        catalog={CATALOG}
        onSelect={() => {}}
        onNew={() => {}}
      />,
    );

    const meta = document.querySelector(".rail-server__meta");
    expect(meta?.textContent).toContain("已开通");
    expect(meta?.textContent).not.toContain("已在使用");
  });
});

describe("待开通机器失败后的列表行", () => {
  it("settle_insufficient 后立刻显示出错，不再停在开通中", () => {
    render(
      <MyServersRail
        servers={[
          server({
            name: "新加坡 1 · 新建",
            state: "error",
            node_id: null,
            billing_state: "pending",
            paid_until: null,
            failure: {
              stage: "verifying",
              code: "settle_insufficient",
              message: "余额不足。",
              retryable: true,
            },
          }),
        ]}
        selectedId={null}
        loading={false}
        catalog={CATALOG}
        onSelect={() => {}}
        onNew={() => {}}
      />,
    );

    const meta = document.querySelector(".rail-server__meta");
    expect(meta?.textContent).toContain("出错了");
    expect(meta?.textContent).not.toContain("开通中");
    // 计费字段可能全是 0：不能渲染成「$0.00/天」。
    expect(meta?.textContent).not.toContain("/天");
  });
});

describe("左栏的试用提示常驻", () => {
  it("有服务器时在列表底部显示一行只读提示与去控制台", () => {
    const onGoConnect = vi.fn();
    render(
      <MyServersRail
        servers={[server()]}
        selectedId={null}
        loading={false}
        catalog={CATALOG}
        trialHint="还有 2 个免费节点可用，6 天后到期。"
        onGoConnect={onGoConnect}
        onSelect={() => {}}
        onNew={() => {}}
      />,
    );

    const hint = document.querySelector(".myservers__trial-hint--rail");
    expect(hint?.textContent).toContain("还有 2 个免费节点可用，6 天后到期。");
    fireEvent.click(screen.getByRole("button", { name: "去控制台" }));
    expect(onGoConnect).toHaveBeenCalledTimes(1);
  });

  it("没有剩余免费节点时不显示", () => {
    render(
      <MyServersRail
        servers={[server()]}
        selectedId={null}
        loading={false}
        catalog={CATALOG}
        trialHint={null}
        onGoConnect={vi.fn()}
        onSelect={() => {}}
        onNew={() => {}}
      />,
    );

    expect(document.querySelector(".myservers__trial-hint--rail")).toBeNull();
    expect(screen.queryByRole("button", { name: "去控制台" })).toBeNull();
  });
});

describe("左栏滚动容器与常驻新建行", () => {
  function many(count: number): MyServer[] {
    return Array.from({ length: count }, (_, index) =>
      server({
        server_id: `srv_${index}`,
        name: `服务器 ${index}`,
      }),
    );
  }

  it("超过一屏时列表在自己滚动，新建行在滚动容器外始终可见", () => {
    render(
      <MyServersRail
        servers={many(13)}
        selectedId="srv_0"
        loading={false}
        catalog={CATALOG}
        onSelect={() => {}}
        onNew={() => {}}
      />,
    );

    const body = document.querySelector(".rail__body");
    expect(body).not.toBeNull();
    expect(body?.querySelectorAll(".rail-server").length).toBe(13);
    // 新建行不在滚动容器里，列表滚到底也遮不住它。
    expect(body?.querySelector(".rail__new-row")).toBeNull();
    const row = document.querySelector(".rail__new-row");
    expect(row?.textContent).toContain("新建节点");
  });

  it("空列表不显示新建行（空态由中间主按钮承担）", () => {
    render(
      <MyServersRail
        servers={[]}
        selectedId={null}
        loading={false}
        catalog={CATALOG}
        onSelect={() => {}}
        onNew={() => {}}
      />,
    );

    expect(document.querySelector(".rail__new-row")).toBeNull();
  });

  it("点常驻新建行调用 onNew；禁用时不可点", () => {
    const onNew = vi.fn();
    const view = render(
      <MyServersRail
        servers={many(1)}
        selectedId={null}
        loading={false}
        catalog={CATALOG}
        onSelect={() => {}}
        onNew={onNew}
      />,
    );
    fireEvent.click(document.querySelector(".rail__new-row") as HTMLButtonElement);
    expect(onNew).toHaveBeenCalledTimes(1);

    view.rerender(
      <MyServersRail
        servers={many(1)}
        selectedId={null}
        loading={false}
        catalog={CATALOG}
        disabled
        onSelect={() => {}}
        onNew={onNew}
      />,
    );
    expect(
      (document.querySelector(".rail__new-row") as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});

describe("左栏常驻区与抽屉滚动", () => {
  function many(count: number): MyServer[] {
    return Array.from({ length: count }, (_, index) =>
      server({ server_id: `srv_${index}`, name: `服务器 ${index}` }),
    );
  }

  it("长列表下免费节点提示不随列表滚走，紧挨在新建行上方", () => {
    render(
      <MyServersRail
        servers={many(13)}
        selectedId={null}
        loading={false}
        catalog={CATALOG}
        trialHint="还有 2 个免费节点可用，6 天后到期。"
        onGoConnect={() => {}}
        onSelect={() => {}}
        onNew={() => {}}
      />,
    );

    const hint = document.querySelector(".myservers__trial-hint--rail");
    expect(hint).not.toBeNull();
    // 不在滚动容器里：列表滚到底也还看得见。
    expect(document.querySelector(".rail__body .myservers__trial-hint--rail")).toBeNull();
    expect(hint?.nextElementSibling?.classList.contains("rail__new-row")).toBe(true);
  });

  it("抽屉里的长列表也有滚动容器", () => {
    render(
      <MyServersRail
        servers={many(13)}
        selectedId={null}
        loading={false}
        compact
        catalog={CATALOG}
        onSelect={() => {}}
        onNew={() => {}}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "服务器列表，13 台" }),
    );
    const body = document.querySelector(".rail-drawer .rail__body");
    expect(body).not.toBeNull();
    expect(body?.querySelectorAll(".rail-server").length).toBe(13);
  });
});

describe("左栏试用旁注的边界", () => {
  it("列表读取失败时不显示旁注（与新建行同条件）", () => {
    render(
      <MyServersRail
        servers={[server()]}
        selectedId={null}
        loading={false}
        error="连不上服务器，稍后再试"
        catalog={CATALOG}
        trialHint="还有 2 个免费节点可用，6 天后到期。"
        onGoConnect={() => {}}
        onSelect={() => {}}
        onNew={() => {}}
      />,
    );

    expect(document.querySelector(".myservers__trial-hint--rail")).toBeNull();
    expect(document.querySelector(".rail__new-row")).toBeNull();
  });

  it("锁定期间「去控制台」也禁用", () => {
    render(
      <MyServersRail
        servers={[server()]}
        selectedId={null}
        loading={false}
        disabled
        catalog={CATALOG}
        trialHint="还有 2 个免费节点可用，6 天后到期。"
        onGoConnect={() => {}}
        onSelect={() => {}}
        onNew={() => {}}
      />,
    );

    const link = document.querySelector(
      ".myservers__trial-link",
    ) as HTMLButtonElement;
    expect(link.disabled).toBe(true);
  });
});
