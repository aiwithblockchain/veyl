/** @vitest-environment jsdom */
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentBridge, MyServer, MyServerAccount } from "../agent/bridge";
import { AGENT_EVENTS } from "../agent/protocol";
import type { AgentEvent } from "../agent/protocol";
import { uiLog } from "../log/uiLog";
import { useMyServers } from "./useMyServers";

vi.mock("../log/uiLog", () => ({ uiLog: vi.fn() }));

const SERVER_A: MyServer = {
  server_id: "srv_a",
  name: "东京 1",
  region: "sgp1",
  plan: "s-1vcpu-1gb",
  state: "healthy",
  created_at: new Date(0).toISOString(),
  ip: "203.0.113.1",
  port: 8388,
  node_id: "node_a",
  local_node_id: "local_node_a",
  hourly_usd: 0.00893,
  monthly_usd: 9,
  daily_price_cents: 30,
  paid_until: new Date(86_400_000).toISOString(),
  billing_state: "active",
  grace_ends_at: null,
  transfer_gib: 1000,
  traffic_used_bytes: 0,
  traffic_limit_bytes: 0,
  traffic_reset_at: "",
  traffic_state: "ok",
  failure: null,
};

const SERVER_B: MyServer = { ...SERVER_A, server_id: "srv_b", name: "大阪 1" };

function makeBridge(listRef: { current: MyServer[] }) {
  return {
    myServerCatalog: vi.fn(async () => ({
      regions: [],
      plans: [],
      currency: "USD",
      updated_at: new Date(0).toISOString(),
    })),
    myServerAccount: vi.fn(async () => ({
      logged_in: true,
      email: "me@example.com",
      account_id: "acct_1",
      device_id: "dev_1",
      account_kind: "email",
      session_expires_at: null,
    })),
    myServerIdentity: vi.fn(async () => ({ has_identity: true, account_id: "acct_1" })),
    myServerLogout: vi.fn(async () => ({
      logged_in: false,
      email: null,
      account_id: "acct_1",
      device_id: "dev_1",
      account_kind: "device",
      session_expires_at: null,
    })),
    myServerLoginVerify: vi.fn(async (email: string) => ({
      logged_in: true,
      email,
      account_id: "acct_2",
      device_id: "dev_1",
      account_kind: "email",
      session_expires_at: null,
    })),
    myServerList: vi.fn(async () => ({ servers: listRef.current })),
    myServerGet: vi.fn(async (id: string) => {
      const found = listRef.current.find((server) => server.server_id === id);
      if (!found) throw { code: "NOT_FOUND", message: "没有这台服务器" };
      return found;
    }),
    myServerWallet: vi.fn(async () => ({
      balance_cents: 1000,
      currency: "USD",
      denominations_cents: [1000],
      updated_at: new Date(0).toISOString(),
    })),
    nodeForget: vi.fn(async () => ({ forgotten: true })),
    subscribe: vi.fn(() => () => {}),
  } as unknown as AgentBridge;
}

afterEach(() => {
  // 没有 globals，Testing Library 不会自动卸载：上一条用例挂着的 hook 还会听事件。
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
});

async function mount(listRef: { current: MyServer[] }) {
  const bridge = makeBridge(listRef);
  const view = renderHook(() => useMyServers(bridge, { active: true, rootSignal: 0 }));
  await waitFor(() => expect(view.result.current.loading).toBe(false));
  return { bridge, ...view };
}

describe("「已下单但认不出新机器」的生命周期", () => {
  it("普通刷新读目录不带 fresh（fresh 只留给新建向导）", async () => {
    const list = { current: [] as MyServer[] };
    const { bridge } = await mount(list);

    const catalog = vi.mocked(bridge.myServerCatalog);
    expect(catalog).toHaveBeenCalled();
    expect(catalog.mock.calls[0]).toEqual([]);
  });

  it("选中刚下单的新 id、列表还没回来：awaitingSelected 为 true，回来后自动恢复", async () => {
    const list = { current: [] as MyServer[] };
    const { result } = await mount(list);

    // 下单成功立刻选中新 id；列表刷新返回时这台还没出现。
    await act(async () => {
      result.current.ordered("srv_new");
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(result.current.awaitingSelected).toBe(true);
    expect(result.current.selected).toBeNull();

    list.current = [{ ...SERVER_A, server_id: "srv_new" }];
    await act(async () => {
      await result.current.refresh();
    });
    expect(result.current.awaitingSelected).toBe(false);
    expect(result.current.selected?.server_id).toBe("srv_new");
  });

  it("新行出现在列表后自动解除占位并选中它", async () => {    const list = { current: [] as MyServer[] };
    const { result } = await mount(list);

    await act(async () => {
      result.current.ordered(null);
    });
    expect(result.current.pendingServer).toBe(true);
    // 下单触发的刷新先落地，避免和下面手动刷新抢最后一次 setServers。
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    list.current = [SERVER_A];
    await act(async () => {
      await result.current.refresh();
    });
    expect(result.current.pendingServer).toBe(false);
    expect(result.current.selected?.server_id).toBe("srv_a");
  });

  it("回到根时清掉占位", async () => {
    const list = { current: [] as MyServer[] };
    const { result } = await mount(list);

    await act(async () => {
      result.current.ordered(null);
    });
    expect(result.current.pendingServer).toBe(true);

    act(() => {
      result.current.resetToRoot();
    });
    expect(result.current.pendingServer).toBe(false);
  });

  it("销毁后清掉选中，剩下的第一台自动接上", async () => {
    const list = { current: [SERVER_A, SERVER_B] };
    const { result } = await mount(list);
    await waitFor(() => expect(result.current.selected?.server_id).toBe("srv_a"));

    list.current = [SERVER_B];
    await act(async () => {
      result.current.clearSelection();
    });

    await waitFor(() => expect(result.current.selected?.server_id).toBe("srv_b"));
    expect(result.current.pendingServer).toBe(false);
  });

  it("销毁最后一台：刷新后回到空态，不拿旧列表回填", async () => {
    const list = { current: [SERVER_A] };
    const { result } = await mount(list);
    await waitFor(() => expect(result.current.selected?.server_id).toBe("srv_a"));

    // 控制面列表已把 destroyed 过滤掉：清选中之后刷新回来是空列表。
    list.current = [];
    await act(async () => {
      result.current.clearSelection();
    });
    await act(async () => {
      await result.current.refresh();
    });

    expect(result.current.selected).toBeNull();
    expect(result.current.pendingServer).toBe(false);
  });

  it("选中的那台从列表消失：清掉选中回空态，不落到别的机器上", async () => {
    const list = { current: [SERVER_A, SERVER_B] };
    const { result } = await mount(list);
    await waitFor(() => expect(result.current.selected?.server_id).toBe("srv_a"));

    // 没走 clearSelection，选中那台直接不在刷新后的列表里。
    list.current = [SERVER_B];
    await act(async () => {
      await result.current.refresh();
    });

    expect(result.current.selected).toBeNull();
  });

  it("停机删除：删节点、立刻收起墓碑行，后端还在返回时也不再显示", async () => {
    const list: { current: MyServer[] } = {
      current: [{ ...SERVER_A, state: "destroyed" }],
    };
    const { result, bridge } = await mount(list);
    await waitFor(() => expect(result.current.selected?.server_id).toBe("srv_a"));

    await act(async () => {
      await result.current.forgetServer("srv_a", "local_node_a");
    });

    expect(vi.mocked(bridge.nodeForget)).toHaveBeenCalledWith({
      nodeId: "local_node_a",
    });
    expect(result.current.servers).toHaveLength(0);
    expect(result.current.selected).toBeNull();

    // 后端还没停止返回墓碑：刷新后依旧不显示。
    await act(async () => {
      await result.current.refresh();
    });
    expect(result.current.servers).toHaveLength(0);
  });

  it("nodeForget 抛错：墓碑行保留，不做乐观移除", async () => {
    const list: { current: MyServer[] } = {
      current: [{ ...SERVER_A, state: "destroyed" }],
    };
    const { result, bridge } = await mount(list);
    await waitFor(() => expect(result.current.selected?.server_id).toBe("srv_a"));
    vi.mocked(bridge.nodeForget).mockRejectedValueOnce({
      code: "NETWORK",
      message: "连不上。",
    });

    await expect(
      result.current.forgetServer("srv_a", "local_node_a"),
    ).rejects.toBeTruthy();

    // 没删成就什么都没变：那一行还在、选中还在、也没有被记进「已删除」。
    expect(result.current.servers).toHaveLength(1);
    expect(result.current.servers[0].server_id).toBe("srv_a");
    expect(result.current.selected?.server_id).toBe("srv_a");

    // 之后再刷新，墓碑行照常出现。
    await act(async () => {
      await result.current.refresh();
    });
    expect(result.current.servers).toHaveLength(1);
  });
});

describe("开通中的轮询", () => {
  it("开通中每 2 秒一次，详情跟着刷新，就绪后停止", async () => {
    vi.useFakeTimers();
    const list: { current: MyServer[] } = {
      current: [{ ...SERVER_A, state: "creating" }],
    };
    const bridge = makeBridge(list);
    const view = renderHook(() =>
      useMyServers(bridge, { active: true, rootSignal: 0 }),
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const listMock = vi.mocked(bridge.myServerList);
    const getMock = vi.mocked(bridge.myServerGet);
    const listBase = listMock.mock.calls.length;
    const getBase = getMock.mock.calls.length;

    // 开通中不按兜底退避：每一拍都是 2 秒。
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(listMock.mock.calls.length).toBe(listBase + 1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1900);
    });
    expect(listMock.mock.calls.length).toBe(listBase + 1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(listMock.mock.calls.length).toBe(listBase + 2);

    // 详情也随每次列表刷新重取，而不是只在选中时拉一次。
    expect(getMock.mock.calls.length).toBeGreaterThan(getBase + 1);

    // 状态就绪：下一拍刷新看到 healthy，之后不再轮询。
    list.current = [{ ...SERVER_A, state: "healthy" as const }];
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    const stopped = listMock.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(listMock.mock.calls.length).toBe(stopped);
    view.unmount();
    vi.useRealTimers();
  });

  it("销毁中也轮询：列表把那一行过滤掉后停止", async () => {
    vi.useFakeTimers();
    const list: { current: MyServer[] } = {
      current: [{ ...SERVER_A, state: "destroying" }],
    };
    const bridge = makeBridge(list);
    const view = renderHook(() =>
      useMyServers(bridge, { active: true, rootSignal: 0 }),
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const listMock = vi.mocked(bridge.myServerList);
    const listBase = listMock.mock.calls.length;

    // 销毁中不再等用户重进页面：第一拍 2 秒就自己去拉列表。
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(listMock.mock.calls.length).toBe(listBase + 1);

    // 控制面列表已过滤掉 destroyed：这一行消失后不再轮询。
    list.current = [];
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    const stopped = listMock.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(listMock.mock.calls.length).toBe(stopped);
    view.unmount();
    vi.useRealTimers();
  });
  it("拉取失败时按兜底退避，不在 2 秒上死循环", async () => {
    vi.useFakeTimers();
    const list: { current: MyServer[] } = {
      current: [{ ...SERVER_A, state: "creating" }],
    };
    const bridge = makeBridge(list);
    const view = renderHook(() =>
      useMyServers(bridge, { active: true, rootSignal: 0 }),
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const listMock = vi.mocked(bridge.myServerList);
    const base = listMock.mock.calls.length;

    // 之后每次都失败：旧列表仍写着 creating，但不能拿它压 2 秒。
    listMock.mockRejectedValue({ code: "NETWORK", message: "连不上。" });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(listMock.mock.calls.length).toBe(base + 1);

    // 失败后退到 5 秒。
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4999);
    });
    expect(listMock.mock.calls.length).toBe(base + 1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(listMock.mock.calls.length).toBe(base + 2);

    // 恢复成功、仍开通中：这一拍成功，下一拍回到 2 秒。
    listMock.mockResolvedValue({ servers: list.current });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(listMock.mock.calls.length).toBe(base + 3);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(listMock.mock.calls.length).toBe(base + 4);

    view.unmount();
    vi.useRealTimers();
  });

  it("离开开通态后回到 5 秒节奏（销毁中的机器继续轮询）", async () => {
    vi.useFakeTimers();
    const list: { current: MyServer[] } = {
      current: [
        { ...SERVER_A, state: "creating" },
        { ...SERVER_B, state: "destroying" },
      ],
    };
    const bridge = makeBridge(list);
    const view = renderHook(() =>
      useMyServers(bridge, { active: true, rootSignal: 0 }),
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const listMock = vi.mocked(bridge.myServerList);
    const base = listMock.mock.calls.length;

    // 开通中：两拍都是 2 秒。
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(listMock.mock.calls.length).toBe(base + 1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(listMock.mock.calls.length).toBe(base + 2);

    // A 就绪、B 还在销毁：这一拍之后列表里没有开通中的机器了。
    list.current = [
      { ...SERVER_A, state: "healthy" },
      { ...SERVER_B, state: "destroying" },
    ];
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    const after = listMock.mock.calls.length;
    expect(after).toBe(base + 3);

    // 回到兜底节奏：5 秒内不再刷新，到点才刷一次。
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4999);
    });
    expect(listMock.mock.calls.length).toBe(after);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(listMock.mock.calls.length).toBe(after + 1);

    view.unmount();
    vi.useRealTimers();
  });
});

describe("详情请求失败时的降级", () => {
  async function flush() {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(0);
    });
  }

  it("有列表快照时失败只在后台重试，不出错误、仍显示服务器", async () => {
    vi.useFakeTimers();
    const list = { current: [SERVER_A] };
    const bridge = makeBridge(list);
    const get = vi.mocked(bridge.myServerGet);
    get.mockRejectedValue({ code: "NETWORK", message: "网络不可用" });
    const view = renderHook(() =>
      useMyServers(bridge, { active: true, rootSignal: 0 }),
    );
    await flush();

    // 切换节点路径时详情读失败：列表快照顶上，不出现错误。
    expect(view.result.current.selected?.server_id).toBe("srv_a");
    expect(view.result.current.detailError).toBeNull();

    const firstRound = get.mock.calls.length;
    expect(firstRound).toBeGreaterThan(0);
    // 列表/账户落地可能让详情 effect 重启一次，重试计时从那一拍算起。
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(get.mock.calls.length).toBeGreaterThan(firstRound);
    expect(view.result.current.detailError).toBeNull();

    // 网络恢复后写回最新详情，重试停下。
    get.mockResolvedValue({ ...SERVER_A, name: "东京 1（最新）" });
    await act(async () => {
      for (
        let i = 0;
        i < 10 && view.result.current.selected?.name !== "东京 1（最新）";
        i += 1
      ) {
        await vi.advanceTimersByTimeAsync(1000);
      }
    });
    expect(view.result.current.detailError).toBeNull();
    expect(view.result.current.selected?.name).toBe("东京 1（最新）");

    const settled = get.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(get.mock.calls.length).toBe(settled);
    view.unmount();
    vi.useRealTimers();
  });

  it("没有详情也没有列表快照时，连续失败约 10 秒才报错", async () => {
    vi.useFakeTimers();
    const list = { current: [] as MyServer[] };
    const bridge = makeBridge(list);
    vi.mocked(bridge.myServerGet).mockRejectedValue({
      code: "NETWORK",
      message: "网络不可用",
    });
    const view = renderHook(() =>
      useMyServers(bridge, { active: true, rootSignal: 0 }),
    );
    await flush();

    act(() => {
      view.result.current.select("srv_gone");
    });
    await flush();

    expect(view.result.current.selected).toBeNull();
    // 首次失败不报。
    expect(view.result.current.detailError).toBeNull();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(9000);
    });
    expect(view.result.current.detailError).toBeNull();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(view.result.current.detailError).toBe(
      "这台服务器的详情暂时读不到。已有服务器和节点不受影响；稍后再试。",
    );
    view.unmount();
    vi.useRealTimers();
  });

  it("错误出现后网络恢复，不用点重试也会自动清错", async () => {
    vi.useFakeTimers();
    const list = { current: [] as MyServer[] };
    const bridge = makeBridge(list);
    const get = vi.mocked(bridge.myServerGet);
    get.mockRejectedValue({ code: "NETWORK", message: "网络不可用" });
    const view = renderHook(() =>
      useMyServers(bridge, { active: true, rootSignal: 0 }),
    );
    await flush();
    act(() => {
      view.result.current.select("srv_a");
    });
    await flush();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(view.result.current.detailError).not.toBeNull();

    get.mockResolvedValue(SERVER_A);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(8000);
    });

    expect(view.result.current.detailError).toBeNull();
    expect(view.result.current.selected?.server_id).toBe("srv_a");
    view.unmount();
    vi.useRealTimers();
  });

  it("错误出现后重试成功，错误自动消失", async () => {
    vi.useFakeTimers();
    const list = { current: [] as MyServer[] };
    const bridge = makeBridge(list);
    const get = vi.mocked(bridge.myServerGet);
    get.mockRejectedValue({ code: "NETWORK", message: "网络不可用" });
    const view = renderHook(() =>
      useMyServers(bridge, { active: true, rootSignal: 0 }),
    );
    await flush();
    act(() => {
      view.result.current.select("srv_a");
    });
    await flush();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(view.result.current.detailError).not.toBeNull();

    get.mockResolvedValue(SERVER_A);
    act(() => {
      view.result.current.retryDetail();
    });
    await flush();

    expect(view.result.current.detailError).toBeNull();
    expect(view.result.current.detailRetrying).toBe(false);
    expect(view.result.current.selected?.server_id).toBe("srv_a");
    view.unmount();
    vi.useRealTimers();
  });
  it("A 重试中切到 B：B 的重试按钮不显示重试中", async () => {
    const list = { current: [SERVER_A, SERVER_B] };
    const { bridge, result } = await mount(list);
    await waitFor(() => expect(result.current.selected?.server_id).toBe("srv_a"));

    // B 的详情请求一直不落地：重试态只能靠切换时复位清掉。
    vi.mocked(bridge.myServerGet).mockImplementation(() => new Promise(() => {}));
    act(() => {
      result.current.retryDetail();
    });
    expect(result.current.detailRetrying).toBe(true);

    act(() => {
      result.current.select("srv_b");
    });
    expect(result.current.selected?.server_id).toBe("srv_b");
    expect(result.current.detailRetrying).toBe(false);
  });
});

describe("重建占位", () => {
  it("新机器占位帧把 local_node_id 一起置空，不带旧机器的本地节点", async () => {
    const list = { current: [SERVER_A] };
    const bridge = makeBridge(list);
    // 详情比列表多一个可区分的名字：等它落地，确保后面的占位是从详情复制出来的。
    vi.mocked(bridge.myServerGet).mockResolvedValue({
      ...SERVER_A,
      name: "详情里的新加坡 1",
    });
    const view = renderHook(() =>
      useMyServers(bridge, { active: true, rootSignal: 0 }),
    );
    await waitFor(() =>
      expect(view.result.current.selected?.name).toBe("详情里的新加坡 1"),
    );

    // 新机器详情永远不回来：占位帧原样留在 selected 上。
    vi.mocked(bridge.myServerGet).mockImplementation(() => new Promise(() => {}));
    act(() => {
      view.result.current.rebuilt("srv_c", "creating");
    });

    expect(view.result.current.selected?.server_id).toBe("srv_c");
    expect(view.result.current.selected?.local_node_id).toBeNull();
  });
});

describe("重命名同步", () => {
  it("用返回的服务器更新列表与详情，不二次拉取", async () => {
    const list = { current: [SERVER_A] };
    const { bridge, result } = await mount(list);
    await waitFor(() => expect(result.current.selected?.server_id).toBe("srv_a"));
    const listCalls = vi.mocked(bridge.myServerList).mock.calls.length;
    const getCalls = vi.mocked(bridge.myServerGet).mock.calls.length;

    act(() => {
      result.current.renamed({ ...SERVER_A, name: "新名" });
    });

    expect(result.current.servers[0].name).toBe("新名");
    expect(result.current.selected?.name).toBe("新名");
    expect(vi.mocked(bridge.myServerList).mock.calls.length).toBe(listCalls);
    expect(vi.mocked(bridge.myServerGet).mock.calls.length).toBe(getCalls);
  });

  it("my-server-renamed 事件按 server_id 写同一份 state", async () => {
    const list = { current: [SERVER_A] };
    const bridge = makeBridge(list);
    const listeners = new Set<(event: AgentEvent) => void>();
    (
      bridge as unknown as {
        subscribe: (fn: (event: AgentEvent) => void) => () => void;
      }
    ).subscribe = (fn) => {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    };

    const view = renderHook(() =>
      useMyServers(bridge, { active: true, rootSignal: 0 }),
    );
    await waitFor(() =>
      expect(view.result.current.selected?.server_id).toBe("srv_a"),
    );

    act(() => {
      for (const listener of listeners) {
        listener({
          name: AGENT_EVENTS.myServerRenamed,
          payload: {
            contract_version: "x",
            server_id: "srv_a",
            name: "事件新名",
            emitted_at: "",
          },
        } as never);
      }
    });

    expect(view.result.current.servers[0].name).toBe("事件新名");
    expect(view.result.current.selected?.name).toBe("事件新名");
  });
});

describe("余额刷新", () => {
  async function flushWallet() {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(0);
    });
  }

  it("打开时 30 秒内用缓存，超过 30 秒才再发请求", async () => {
    vi.useFakeTimers();
    const list = { current: [] as MyServer[] };
    const bridge = makeBridge(list);
    const wallet = vi.mocked(bridge.myServerWallet);
    const view = renderHook(() =>
      useMyServers(bridge, { active: true, rootSignal: 0 }),
    );
    await flushWallet();
    const base = wallet.mock.calls.length;
    expect(base).toBeGreaterThan(0);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    window.dispatchEvent(new Event("focus"));
    await flushWallet();
    expect(wallet.mock.calls.length).toBe(base);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });
    window.dispatchEvent(new Event("focus"));
    await flushWallet();
    expect(wallet.mock.calls.length).toBe(base + 1);

    view.unmount();
    vi.useRealTimers();
  });

  it("不做定时轮询：只有窗口重新可见时补一次，补刷受 30 秒门禁", async () => {
    vi.useFakeTimers();
    const list = { current: [] as MyServer[] };
    const bridge = makeBridge(list);
    const wallet = vi.mocked(bridge.myServerWallet);
    let visibility: "visible" | "hidden" = "visible";
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => visibility,
    });
    const view = renderHook(() =>
      useMyServers(bridge, { active: false, rootSignal: 0 }),
    );
    await flushWallet();
    const base = wallet.mock.calls.length;

    // 可见状态下空转 15 分钟：没有任何自动请求。
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15 * 60_000);
    });
    expect(wallet.mock.calls.length).toBe(base);

    visibility = "hidden";
    document.dispatchEvent(new Event("visibilitychange"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15 * 60_000);
    });
    expect(wallet.mock.calls.length).toBe(base);

    // 恢复可见：补一次。
    visibility = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
    await flushWallet();
    expect(wallet.mock.calls.length).toBe(base + 1);

    // 紧接着再来一次「隐藏→可见」：被 30 秒门禁挡掉。
    visibility = "hidden";
    document.dispatchEvent(new Event("visibilitychange"));
    visibility = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
    await flushWallet();
    expect(wallet.mock.calls.length).toBe(base + 1);

    view.unmount();
    vi.useRealTimers();
  });

  it("进入「我的服务器」destination 会刷新余额（建机门槛依赖它）", async () => {
    vi.useFakeTimers();
    const list = { current: [] as MyServer[] };
    const bridge = makeBridge(list);
    const wallet = vi.mocked(bridge.myServerWallet);
    const view = renderHook(
      ({ active }: { active: boolean }) =>
        useMyServers(bridge, { active, rootSignal: 0 }),
      { initialProps: { active: false } },
    );
    await flushWallet();
    const base = wallet.mock.calls.length;

    // 不在那个 destination：空转 31 秒也不补。
    await act(async () => {
      await vi.advanceTimersByTimeAsync(31_000);
    });
    expect(wallet.mock.calls.length).toBe(base);

    // 进入：过了 30 秒门禁，补一次。
    view.rerender({ active: true });
    await flushWallet();
    expect(wallet.mock.calls.length).toBe(base + 1);

    view.unmount();
    vi.useRealTimers();
  });

  it("启动读完账户后，登录那一次刷新真的发出请求（active:false 也一样）", async () => {
    const list = { current: [] as MyServer[] };
    const bridge = makeBridge(list);
    const wallet = vi.mocked(bridge.myServerWallet);
    vi.mocked(uiLog).mockClear();
    const view = renderHook(() =>
      useMyServers(bridge, { active: false, rootSignal: 0 }),
    );
    await waitFor(() => expect(view.result.current.accountLoaded).toBe(true));
    // 不进入「我的服务器」、也不切窗口：只剩登录那条路径能发请求。
    await waitFor(() => expect(wallet).toHaveBeenCalled());
    expect(wallet.mock.calls.length).toBe(1);
    expect(
      vi.mocked(uiLog).mock.calls.some(([, message]) =>
        String(message).includes("skipped reason=logged_out"),
      ),
    ).toBe(false);
  });

  it("陈旧提示：刷新失败标注旧余额，恢复成功后消失", async () => {
    const list = { current: [] as MyServer[] };
    const bridge = makeBridge(list);
    const wallet = vi.mocked(bridge.myServerWallet);
    const view = renderHook(() =>
      useMyServers(bridge, { active: true, rootSignal: 0 }),
    );
    await waitFor(() => expect(view.result.current.wallet).not.toBeNull());
    expect(view.result.current.walletStale).toBe(false);

    wallet.mockRejectedValueOnce({ code: "NETWORK", message: "连不上。" });
    await act(async () => {
      await view.result.current.refreshWallet({ force: true });
    });
    // 旧值还在，但明确标注是上次的；这不是「从未取到值」。
    expect(view.result.current.wallet).not.toBeNull();
    expect(view.result.current.walletStale).toBe(true);
    expect(view.result.current.walletError).toBeNull();

    wallet.mockResolvedValue({
      balance_cents: 1800,
      currency: "USD",
      denominations_cents: [1000],
      updated_at: new Date().toISOString(),
    });
    await act(async () => {
      await view.result.current.refreshWallet({ force: true });
    });
    expect(view.result.current.walletStale).toBe(false);
  });

  it("从未取到值就失败：报读不到，不算「显示旧值」", async () => {
    const list = { current: [] as MyServer[] };
    const bridge = makeBridge(list);
    vi.mocked(bridge.myServerWallet).mockRejectedValue({
      code: "NETWORK",
      message: "连不上。",
    });
    const view = renderHook(() =>
      useMyServers(bridge, { active: true, rootSignal: 0 }),
    );
    await waitFor(() => expect(view.result.current.walletError).not.toBeNull());
    expect(view.result.current.wallet).toBeNull();
    expect(view.result.current.walletStale).toBe(false);
  });

  it("窗口隐藏 1 小时：不发任何钱包请求；恢复可见才补", async () => {
    vi.useFakeTimers();
    const list = { current: [] as MyServer[] };
    const bridge = makeBridge(list);
    const wallet = vi.mocked(bridge.myServerWallet);
    let visibility: "visible" | "hidden" = "hidden";
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => visibility,
    });
    const view = renderHook(() =>
      useMyServers(bridge, { active: false, rootSignal: 0 }),
    );
    await flushWallet();
    const base = wallet.mock.calls.length;

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60 * 60_000);
    });
    expect(wallet.mock.calls.length).toBe(base);

    visibility = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
    await flushWallet();
    expect(wallet.mock.calls.length).toBe(base + 1);

    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "visible",
    });

    view.unmount();
    vi.useRealTimers();
  });

  it("停在任意页面 30 分钟：除显示刷新外不发任何请求", async () => {
    vi.useFakeTimers();
    const list = { current: [] as MyServer[] };
    const bridge = makeBridge(list);
    const wallet = vi.mocked(bridge.myServerWallet);
    const view = renderHook(() =>
      useMyServers(bridge, { active: false, rootSignal: 0 }),
    );
    await flushWallet();
    const base = wallet.mock.calls.length;

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30 * 60_000);
    });
    expect(wallet.mock.calls.length).toBe(base);

    view.unmount();
    vi.useRealTimers();
  });

  it("手动刷新不受 30 秒限制", async () => {
    const list = { current: [] as MyServer[] };
    const bridge = makeBridge(list);
    const wallet = vi.mocked(bridge.myServerWallet);
    const view = renderHook(() =>
      useMyServers(bridge, { active: true, rootSignal: 0 }),
    );
    await waitFor(() => expect(view.result.current.wallet).not.toBeNull());
    const base = wallet.mock.calls.length;

    // 普通调用（打开面）：30 秒内直接用缓存。
    await act(async () => {
      await view.result.current.refreshWallet();
    });
    expect(wallet.mock.calls.length).toBe(base);

    // 手动刷新：强制发请求。
    await act(async () => {
      await view.result.current.refreshWallet({ force: true });
    });
    expect(wallet.mock.calls.length).toBe(base + 1);
  });
});

describe("余额请求在途去重", () => {
  it("两处同时触发只发一次", async () => {
    const list = { current: [] as MyServer[] };
    const bridge = makeBridge(list);
    const wallet = vi.mocked(bridge.myServerWallet);
    let release: () => void = () => {};
    wallet.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () =>
            resolve({
              balance_cents: 920,
              currency: "USD",
              denominations_cents: [1000],
              updated_at: new Date().toISOString(),
            });
        }),
    );
    const view = renderHook(() =>
      useMyServers(bridge, { active: true, rootSignal: 0 }),
    );
    await waitFor(() => expect(wallet).toHaveBeenCalled());
    expect(wallet.mock.calls.length).toBe(1);

    let first: Promise<unknown> = Promise.resolve();
    let second: Promise<unknown> = Promise.resolve();
    act(() => {
      first = view.result.current.refreshWallet({ force: true });
      second = view.result.current.refreshWallet({ force: true });
    });
    expect(wallet.mock.calls.length).toBe(1);

    await act(async () => {
      release();
      await Promise.all([first, second]);
    });
  });
});

describe("打开即刷的 30 秒门禁", () => {
  it("30 秒内反复打开只发一次", async () => {
    const list = { current: [] as MyServer[] };
    const bridge = makeBridge(list);
    const wallet = vi.mocked(bridge.myServerWallet);
    const view = renderHook(() =>
      useMyServers(bridge, { active: true, rootSignal: 0 }),
    );
    await waitFor(() => expect(view.result.current.wallet).not.toBeNull());
    const base = wallet.mock.calls.length;

    // 关掉再打开两次（门禁版）：不再发请求。
    await act(async () => {
      await view.result.current.refreshWallet();
      await view.result.current.refreshWallet();
    });
    expect(wallet.mock.calls.length).toBe(base);
  });
});

describe("余额刷新的日志", () => {
  function lines(): string[] {
    return vi.mocked(uiLog).mock.calls.map(
      ([level, message]) => `${level} ${message}`,
    );
  }
  function matching(pattern: RegExp): string[] {
    return lines().filter((line) => pattern.test(line));
  }
  async function flush() {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(0);
    });
  }

  it("触发与结果各一行：成功带余额与耗时，门禁跳过带距上次成功的间隔", async () => {
    const list = { current: [] as MyServer[] };
    const bridge = makeBridge(list);
    const wallet = vi.mocked(bridge.myServerWallet);
    const view = renderHook(() =>
      useMyServers(bridge, { active: true, rootSignal: 0 }),
    );
    await waitFor(() => expect(view.result.current.wallet).not.toBeNull());
    // 启动读完账户就刷一次：触发和结果各一行。
    expect(matching(/^debug refresh seq=\d+ trigger=login$/).length).toBe(1);
    expect(
      matching(/^debug refresh seq=\d+ done outcome=ok balance_cents=1000 elapsed_ms=\d+$/)
        .length,
    ).toBe(1);
    vi.mocked(uiLog).mockClear();

    const before = wallet.mock.calls.length;
    await act(async () => {
      await view.result.current.refreshWallet({ trigger: "visible" });
    });
    expect(wallet.mock.calls.length).toBe(before);
    expect(matching(/^debug refresh seq=\d+ trigger=visible$/).length).toBe(1);
    expect(
      matching(/^debug refresh seq=\d+ skipped reason=gate elapsed_ms=\d+$/).length,
    ).toBe(1);

    await act(async () => {
      await view.result.current.refreshWallet({ force: true, trigger: "manual" });
    });
    expect(wallet.mock.calls.length).toBe(before + 1);
    expect(matching(/^debug refresh seq=\d+ trigger=manual$/).length).toBe(1);
    expect(
      matching(/^debug refresh seq=\d+ done outcome=ok balance_cents=1000 elapsed_ms=\d+$/)
        .length,
    ).toBe(1);
    // 一次刷新只有触发和结果两行，没有中间态。
    expect(matching(/^debug refresh /).length).toBe(4);

    // 触发行与结果行同 seq：交错时靠它配对。
    const done = lines().find((line) =>
      /^debug refresh seq=\d+ done outcome=ok/.test(line),
    ) as string;
    const doneSeq = done.match(/seq=(\d+)/)?.[1];
    expect(lines()).toContain(`debug refresh seq=${doneSeq} trigger=manual`);
    const gate = lines().find((line) => line.includes("reason=gate")) as string;
    const gateSeq = gate.match(/seq=(\d+)/)?.[1];
    expect(lines()).toContain(`debug refresh seq=${gateSeq} trigger=visible`);
  });

  it("open_menu 是显式动作：30 秒内也强制刷新", async () => {
    const list = { current: [] as MyServer[] };
    const bridge = makeBridge(list);
    const wallet = vi.mocked(bridge.myServerWallet);
    const view = renderHook(() =>
      useMyServers(bridge, { active: true, rootSignal: 0 }),
    );
    await waitFor(() => expect(view.result.current.wallet).not.toBeNull());
    const before = wallet.mock.calls.length;

    await act(async () => {
      await view.result.current.refreshWallet({ trigger: "open_menu" });
    });
    expect(wallet.mock.calls.length).toBe(before + 1);
  });

  it("5 秒内重复开合菜单只刷一次，跳过记一行 open_menu_floor", async () => {
    const list = { current: [] as MyServer[] };
    const bridge = makeBridge(list);
    const wallet = vi.mocked(bridge.myServerWallet);
    const view = renderHook(() =>
      useMyServers(bridge, { active: true, rootSignal: 0 }),
    );
    await waitFor(() => expect(view.result.current.wallet).not.toBeNull());
    vi.mocked(uiLog).mockClear();
    const before = wallet.mock.calls.length;

    await act(async () => {
      await view.result.current.refreshWallet({ trigger: "open_menu" });
    });
    expect(wallet.mock.calls.length).toBe(before + 1);

    await act(async () => {
      await view.result.current.refreshWallet({ trigger: "open_menu" });
    });
    expect(wallet.mock.calls.length).toBe(before + 1);
    expect(
      matching(/skipped reason=open_menu_floor elapsed_ms=\d+$/).length,
    ).toBe(1);
  });

  it("超过 5 秒后再次打开会恢复刷新", async () => {
    const list = { current: [] as MyServer[] };
    const bridge = makeBridge(list);
    const wallet = vi.mocked(bridge.myServerWallet);
    const view = renderHook(() =>
      useMyServers(bridge, { active: true, rootSignal: 0 }),
    );
    await waitFor(() => expect(view.result.current.wallet).not.toBeNull());

    // 只推进时钟，不动定时器：waitFor 仍跑在真实时间上。
    let clock = Date.now();
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => clock);
    try {
      vi.mocked(uiLog).mockClear();
      const before = wallet.mock.calls.length;

      await act(async () => {
        await view.result.current.refreshWallet({ trigger: "open_menu" });
      });
      expect(wallet.mock.calls.length).toBe(before + 1);

      clock += 5_001;
      await act(async () => {
        await view.result.current.refreshWallet({ trigger: "open_menu" });
      });
      expect(wallet.mock.calls.length).toBe(before + 2);
      expect(matching(/skipped reason=open_menu_floor/).length).toBe(0);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("在途去重也记一行 skipped", async () => {
    let release: (value: unknown) => void = () => {};
    const list = { current: [] as MyServer[] };
    const bridge = makeBridge(list);
    const wallet = vi.mocked(bridge.myServerWallet);
    const view = renderHook(() =>
      useMyServers(bridge, { active: true, rootSignal: 0 }),
    );
    await waitFor(() => expect(view.result.current.wallet).not.toBeNull());
    wallet.mockImplementationOnce(
      () => new Promise((resolve) => (release = resolve)) as never,
    );
    vi.mocked(uiLog).mockClear();

    act(() => {
      void view.result.current.refreshWallet({ force: true, trigger: "retry" });
      void view.result.current.refreshWallet({ force: true, trigger: "retry" });
    });
    expect(matching(/^debug refresh seq=\d+ skipped reason=inflight$/).length).toBe(1);

    await act(async () => {
      release({
        balance_cents: 1000,
        currency: "USD",
        denominations_cents: [1000],
        updated_at: new Date(0).toISOString(),
      });
    });
  });

  it("失败只记错误码，不记错误原文；陈旧翻转各一行且只打一次", async () => {
    const list = { current: [] as MyServer[] };
    const bridge = makeBridge(list);
    const wallet = vi.mocked(bridge.myServerWallet);
    const view = renderHook(() =>
      useMyServers(bridge, { active: true, rootSignal: 0 }),
    );
    await waitFor(() => expect(view.result.current.wallet).not.toBeNull());
    vi.mocked(uiLog).mockClear();

    wallet.mockRejectedValueOnce({
      code: "NETWORK",
      message: "连不上 10.0.0.9:443，令牌 abc123",
    });
    await act(async () => {
      await view.result.current.refreshWallet({ force: true });
    });
    expect(
      matching(/^warn refresh seq=\d+ done outcome=failed elapsed_ms=\d+ reason=network$/)
        .length,
    ).toBe(1);
    expect(lines().some((line) => line.includes("令牌"))).toBe(false);
    expect(lines().some((line) => line.includes("10.0.0.9"))).toBe(false);
    expect(matching(/^warn stale changed value=true idle_ms=\d+$/).length).toBe(1);

    await act(async () => {
      await view.result.current.refreshWallet({ force: true });
    });
    expect(matching(/^debug stale changed value=false idle_ms=\d+$/).length).toBe(
      1,
    );
    // 恢复成功后不再重复记 false。
    await act(async () => {
      await view.result.current.refreshWallet({ force: true });
    });
    expect(matching(/^debug stale changed value=false idle_ms=\d+$/).length).toBe(
      1,
    );
  });

  it("窗口隐藏只在可见→隐藏的那一刻记一条，隐藏期间不刷屏", async () => {
    vi.useFakeTimers();
    const list = { current: [] as MyServer[] };
    const bridge = makeBridge(list);
    let visibility: "visible" | "hidden" = "visible";
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => visibility,
    });
    try {
      const view = renderHook(() =>
        useMyServers(bridge, { active: false, rootSignal: 0 }),
      );
      await flush();
      vi.mocked(uiLog).mockClear();

      visibility = "hidden";
      document.dispatchEvent(new Event("visibilitychange"));
      await flush();
      expect(matching(/^debug refresh skipped reason=hidden$/).length).toBe(1);

      // 有些平台会连发多次 hidden：不重复落。
      document.dispatchEvent(new Event("visibilitychange"));
      document.dispatchEvent(new Event("visibilitychange"));
      await flush();
      expect(matching(/^debug refresh skipped reason=hidden$/).length).toBe(1);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(2 * 15 * 60_000);
      });
      expect(matching(/^debug refresh skipped reason=hidden$/).length).toBe(1);

      visibility = "visible";
      document.dispatchEvent(new Event("visibilitychange"));
      visibility = "hidden";
      document.dispatchEvent(new Event("visibilitychange"));
      await flush();
      // 恢复可见用自己的 trigger，和聚焦、打开面分得开。
      expect(matching(/^debug refresh seq=\d+ trigger=visible$/).length).toBe(1);
      expect(matching(/^debug refresh skipped reason=hidden$/).length).toBe(2);

      view.unmount();
    } finally {
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        get: () => "visible",
      });
      vi.useRealTimers();
    }
  });

  it("details.reason 不合规（空格 / 邮箱 / 超长 / 符号）回落 unknown", async () => {
    const list = { current: [] as MyServer[] };
    const bridge = makeBridge(list);
    const wallet = vi.mocked(bridge.myServerWallet);
    const view = renderHook(() =>
      useMyServers(bridge, { active: true, rootSignal: 0 }),
    );
    await waitFor(() => expect(view.result.current.wallet).not.toBeNull());

    const bad = ["bad reason", "buyer@example.com", "x".repeat(40), "bad:reason!"];
    for (const reason of bad) {
      vi.mocked(uiLog).mockClear();
      wallet.mockRejectedValueOnce({
        code: "NETWORK",
        message: "连不上。",
        details: { reason },
      });
      await act(async () => {
        await view.result.current.refreshWallet({ force: true });
      });
      expect(
        matching(
          /^warn refresh seq=\d+ done outcome=failed elapsed_ms=\d+ reason=unknown$/,
        ).length,
      ).toBe(1);
      expect(lines().some((line) => line.includes(reason))).toBe(false);
    }

    // 合规的短枚举照常透出，不被白名单误伤。
    vi.mocked(uiLog).mockClear();
    wallet.mockRejectedValueOnce({
      code: "NETWORK",
      message: "连不上。",
      details: { reason: "quota_exhausted" },
    });
    await act(async () => {
      await view.result.current.refreshWallet({ force: true });
    });
    expect(
      matching(
        /^warn refresh seq=\d+ done outcome=failed elapsed_ms=\d+ reason=quota_exhausted$/,
      ).length,
    ).toBe(1);
  });
});

describe("换账户与登出", () => {
  const WALLET_A = {
    balance_cents: 1000,
    currency: "USD",
    denominations_cents: [1000],
    updated_at: new Date(0).toISOString(),
  };

  async function mounted() {
    const list = { current: [] as MyServer[] };
    const bridge = makeBridge(list);
    const wallet = vi.mocked(bridge.myServerWallet);
    const view = renderHook(() =>
      useMyServers(bridge, { active: true, rootSignal: 0 }),
    );
    await waitFor(() => expect(view.result.current.wallet).not.toBeNull());
    // 登录刷新与进入服务器页的刷新共用门禁：挂载只发一次。
    expect(wallet.mock.calls.length).toBe(1);
    return { bridge, wallet, view };
  }

  it("登出清余额与陈旧态；30 秒内重新登录照样能取到新值", async () => {
    const { wallet, view } = await mounted();
    expect(view.result.current.wallet?.balance_cents).toBe(WALLET_A.balance_cents);

    await act(async () => {
      await view.result.current.logout();
    });
    expect(view.result.current.wallet).toBeNull();
    expect(view.result.current.walletError).toBeNull();
    expect(view.result.current.walletStale).toBe(false);

    // 30 秒门禁跟着账户一起重置：新账户的余额不能被上一个账户的成功时间挡掉。
    wallet.mockResolvedValue({
      balance_cents: 500,
      currency: "USD",
      denominations_cents: [1000],
      updated_at: new Date(0).toISOString(),
    });
    await act(async () => {
      await view.result.current.loginVerify("b@example.com", "123456");
    });
    await waitFor(() =>
      expect(view.result.current.wallet?.balance_cents).toBe(500),
    );
  });

  it("登出后才回来的余额响应被丢弃，不写回旧账户的值", async () => {
    let release: (value: unknown) => void = () => {};
    const { view, wallet } = await mounted();
    wallet.mockImplementationOnce(
      () => new Promise((resolve) => (release = resolve)) as never,
    );
    vi.mocked(uiLog).mockClear();

    act(() => {
      void view.result.current.refreshWallet({ force: true });
    });
    await act(async () => {
      await view.result.current.logout();
    });
    expect(view.result.current.wallet).toBeNull();

    await act(async () => {
      release({ ...WALLET_A, balance_cents: 4242 });
      await Promise.resolve();
    });
    expect(view.result.current.wallet).toBeNull();
    expect(
      vi
        .mocked(uiLog)
        .mock.calls.some(([, message]) =>
          String(message).includes("discarded reason=account_changed"),
        ),
    ).toBe(true);
  });

  it("换账户：旧余额在第一次响应回来之前不显示", async () => {
    let release: (value: unknown) => void = () => {};
    const { view, wallet } = await mounted();
    wallet.mockImplementationOnce(
      () => new Promise((resolve) => (release = resolve)) as never,
    );

    await act(async () => {
      await view.result.current.loginVerify("b@example.com", "123456");
    });
    // 这是新账户的界面：不能还挂着上一个账户的 $10.00。
    expect(view.result.current.wallet).toBeNull();

    await act(async () => {
      release({ ...WALLET_A, balance_cents: 700 });
      await Promise.resolve();
    });
    expect(view.result.current.wallet?.balance_cents).toBe(700);
  });

  it("旧请求在途时登出再登录新账户：旧响应丢弃，新请求不被旧 finally 清掉", async () => {
    let releaseOld: (value: unknown) => void = () => {};
    let releaseNew: (value: unknown) => void = () => {};
    const { view, wallet } = await mounted();

    wallet.mockImplementationOnce(
      () => new Promise((resolve) => (releaseOld = resolve)) as never,
    );
    act(() => {
      void view.result.current.refreshWallet({ force: true });
    });
    await act(async () => {
      await view.result.current.logout();
    });
    expect(view.result.current.wallet).toBeNull();

    // 新账户的请求也挂住，便于观察在途标记归谁。
    wallet.mockImplementationOnce(
      () => new Promise((resolve) => (releaseNew = resolve)) as never,
    );
    await act(async () => {
      await view.result.current.loginVerify("b@example.com", "123456");
    });
    expect(view.result.current.walletRefreshing).toBe(true);

    // 旧响应晚到：值丢掉，在途标记不能跟着被清掉。
    await act(async () => {
      releaseOld({ ...WALLET_A, balance_cents: 4242 });
      await Promise.resolve();
    });
    expect(view.result.current.wallet).toBeNull();
    expect(view.result.current.walletRefreshing).toBe(true);

    await act(async () => {
      releaseNew({ ...WALLET_A, balance_cents: 700 });
      await Promise.resolve();
    });
    expect(view.result.current.wallet?.balance_cents).toBe(700);
    expect(view.result.current.walletRefreshing).toBe(false);
  });

  it("登出后同账号重登：不靠进入服务器页也能立刻取到新值", async () => {
    const list = { current: [] as MyServer[] };
    const bridge = makeBridge(list);
    const wallet = vi.mocked(bridge.myServerWallet);
    vi.mocked(bridge.myServerLoginVerify).mockResolvedValue({
      logged_in: true,
      email: "me@example.com",
      account_id: "acct_1",
      device_id: "dev_1",
      account_kind: "email",
      session_expires_at: null,
    });
    const view = renderHook(() =>
      useMyServers(bridge, { active: false, rootSignal: 0 }),
    );
    await waitFor(() => expect(view.result.current.wallet).not.toBeNull());

    await act(async () => {
      await view.result.current.logout();
    });
    expect(view.result.current.wallet).toBeNull();

    wallet.mockResolvedValue({ ...WALLET_A, balance_cents: 640 });
    const before = wallet.mock.calls.length;
    await act(async () => {
      await view.result.current.loginVerify("me@example.com", "123456");
    });
    await waitFor(() =>
      expect(view.result.current.wallet?.balance_cents).toBe(640),
    );
    expect(wallet.mock.calls.length).toBe(before + 1);
    expect(view.result.current.walletRefreshing).toBe(false);
  });

  it("同账号重登不重置余额：已有值保留，30 秒内不重复请求", async () => {
    const { bridge, view, wallet } = await mounted();
    vi.mocked(bridge.myServerLoginVerify).mockResolvedValue({
      logged_in: true,
      email: "me@example.com",
      account_id: "acct_1",
      device_id: "dev_1",
      account_kind: "email",
      session_expires_at: null,
    });

    const before = wallet.mock.calls.length;
    await act(async () => {
      await view.result.current.loginVerify("me@example.com", "123456");
    });
    expect(view.result.current.wallet?.balance_cents).toBe(
      WALLET_A.balance_cents,
    );
    expect(wallet.mock.calls.length).toBe(before);
  });

  it("账户重读换到另一个账户：旧余额不显示", async () => {
    let release: (value: unknown) => void = () => {};
    const { bridge, view, wallet } = await mounted();
    vi.mocked(bridge.myServerAccount).mockResolvedValue({
      logged_in: true,
      email: "b@example.com",
      account_id: "acct_2",
      device_id: "dev_1",
      account_kind: "email",
      session_expires_at: null,
    });
    wallet.mockImplementationOnce(
      () => new Promise((resolve) => (release = resolve)) as never,
    );

    await act(async () => {
      await view.result.current.refreshAccount();
    });
    expect(view.result.current.wallet).toBeNull();

    await act(async () => {
      release({ ...WALLET_A, balance_cents: 300 });
      await Promise.resolve();
    });
    expect(view.result.current.wallet?.balance_cents).toBe(300);
  });

  it("失败态点「重试」：不受 30 秒门禁，立刻再发一次", async () => {
    const { view, wallet } = await mounted();
    wallet.mockRejectedValueOnce({ code: "NETWORK", message: "连不上。" });
    await act(async () => {
      await view.result.current.refreshWallet({ force: true });
    });
    expect(view.result.current.walletStale).toBe(true);

    const before = wallet.mock.calls.length;
    await act(async () => {
      await view.result.current.refreshWallet({ trigger: "retry" });
    });
    expect(wallet.mock.calls.length).toBe(before + 1);
  });
});

describe("未登录不发账户命令", () => {
  it("设备身份：账户读完前后都不发列表请求", async () => {
    const listRef = { current: [SERVER_A] };
    const bridge = makeBridge(listRef);
    let resolveAccount: (value: MyServerAccount) => void = () => {};
    vi.mocked(bridge.myServerAccount).mockReturnValue(
      new Promise((resolve) => {
        resolveAccount = resolve;
      }),
    );

    const view = renderHook(() =>
      useMyServers(bridge as unknown as AgentBridge, {
        active: true,
        rootSignal: 0,
      }),
    );

    // 首帧：账户还没读回来，也不许发列表请求。
    await act(async () => {});
    expect(bridge.myServerList).not.toHaveBeenCalled();
    expect(view.result.current.accountLoaded).toBe(false);

    await act(async () => {
      resolveAccount({
        logged_in: false,
        email: null,
        account_id: "acct_1",
        device_id: "dev_1",
        account_kind: "device",
        session_expires_at: null,
      });
    });

    await waitFor(() => expect(view.result.current.accountLoaded).toBe(true));
    expect(view.result.current.loggedIn).toBe(false);
    expect(bridge.myServerList).not.toHaveBeenCalled();
  });
});

describe("进入服务器页的静默重读", () => {
  const LOGGED_OUT: MyServerAccount = {
    logged_in: false,
    email: null,
    account_id: null,
    device_id: null,
    account_kind: null,
    session_expires_at: null,
  };

  it("进入页面时网络失败：未登录态翻成错误态，且不落骨架", async () => {
    const list = { current: [] as MyServer[] };
    const bridge = makeBridge(list);
    vi.mocked(bridge.myServerAccount).mockResolvedValueOnce(LOGGED_OUT);

    const view = renderHook(
      ({ active }: { active: boolean }) =>
        useMyServers(bridge, { active, rootSignal: 0 }),
      { initialProps: { active: false } },
    );
    await waitFor(() => expect(view.result.current.accountLoaded).toBe(true));
    expect(view.result.current.loggedIn).toBe(false);

    vi.mocked(bridge.myServerAccount).mockRejectedValueOnce({
      code: "NETWORK",
      message: "",
    });
    vi.mocked(bridge.myServerCatalog).mockRejectedValueOnce({
      code: "UPSTREAM_ERROR",
      details: { reason: "network" },
    });
    view.rerender({ active: true });

    await waitFor(() => expect(view.result.current.accountError).toBe(true));
    expect(view.result.current.catalogError).toBe(true);
    // 静默：accountLoaded 不能被打回 false，否则页面会闪骨架。
    expect(view.result.current.accountLoaded).toBe(true);
  });

  it("重试成功后回到登录引导", async () => {
    const list = { current: [] as MyServer[] };
    const bridge = makeBridge(list);
    vi.mocked(bridge.myServerAccount).mockResolvedValueOnce(LOGGED_OUT);

    const view = renderHook(
      ({ active }: { active: boolean }) =>
        useMyServers(bridge, { active, rootSignal: 0 }),
      { initialProps: { active: false } },
    );
    await waitFor(() => expect(view.result.current.accountLoaded).toBe(true));

    vi.mocked(bridge.myServerAccount)
      .mockRejectedValueOnce({ code: "NETWORK", message: "" })
      .mockResolvedValueOnce(LOGGED_OUT);
    vi.mocked(bridge.myServerCatalog).mockRejectedValueOnce({
      code: "UPSTREAM_ERROR",
      details: { reason: "network" },
    });
    view.rerender({ active: true });
    await waitFor(() => expect(view.result.current.accountError).toBe(true));

    await act(async () => {
      await view.result.current.refreshAccount();
    });

    expect(view.result.current.accountError).toBe(false);
    expect(view.result.current.catalogError).toBe(false);
    expect(view.result.current.loggedIn).toBe(false);
    expect(view.result.current.accountLoaded).toBe(true);
  });

  it("已登录进入页面：重读失败不闪骨架，列表保留", async () => {
    const list = { current: [SERVER_A] };
    const bridge = makeBridge(list);

    const view = renderHook(
      ({ active }: { active: boolean }) =>
        useMyServers(bridge, { active, rootSignal: 0 }),
      { initialProps: { active: false } },
    );
    await waitFor(() => expect(view.result.current.loading).toBe(false));
    expect(view.result.current.servers).toHaveLength(1);

    vi.mocked(bridge.myServerAccount).mockRejectedValueOnce({
      code: "NETWORK",
      message: "",
    });
    view.rerender({ active: true });

    await waitFor(() => expect(view.result.current.accountError).toBe(true));
    expect(view.result.current.accountLoaded).toBe(true);
    expect(view.result.current.servers).toHaveLength(1);
  });

  it("登录成功后清掉账户与目录的错误标记", async () => {
    const list = { current: [] as MyServer[] };
    const bridge = makeBridge(list);
    vi.mocked(bridge.myServerAccount).mockResolvedValueOnce(LOGGED_OUT);

    const view = renderHook(
      ({ active }: { active: boolean }) =>
        useMyServers(bridge, { active, rootSignal: 0 }),
      { initialProps: { active: false } },
    );
    await waitFor(() => expect(view.result.current.accountLoaded).toBe(true));

    vi.mocked(bridge.myServerAccount).mockRejectedValueOnce({
      code: "NETWORK",
      message: "",
    });
    vi.mocked(bridge.myServerCatalog).mockRejectedValueOnce({
      code: "UPSTREAM_ERROR",
      details: { reason: "network" },
    });
    view.rerender({ active: true });
    await waitFor(() => expect(view.result.current.accountError).toBe(true));
    await waitFor(() => expect(view.result.current.catalogError).toBe(true));

    await act(async () => {
      await view.result.current.loginVerify("me@example.com", "123456");
    });

    expect(view.result.current.loggedIn).toBe(true);
    expect(view.result.current.accountError).toBe(false);
    expect(view.result.current.catalogError).toBe(false);
  });

  it("登出成功后清掉账户与目录的错误标记", async () => {
    const list = { current: [] as MyServer[] };
    const bridge = makeBridge(list);

    const view = renderHook(
      ({ active }: { active: boolean }) =>
        useMyServers(bridge, { active, rootSignal: 0 }),
      { initialProps: { active: false } },
    );
    await waitFor(() => expect(view.result.current.loggedIn).toBe(true));

    vi.mocked(bridge.myServerAccount).mockRejectedValueOnce({
      code: "NETWORK",
      message: "",
    });
    vi.mocked(bridge.myServerCatalog).mockRejectedValueOnce({
      code: "UPSTREAM_ERROR",
      details: { reason: "network" },
    });
    view.rerender({ active: true });
    await waitFor(() => expect(view.result.current.accountError).toBe(true));
    await waitFor(() => expect(view.result.current.catalogError).toBe(true));

    await act(async () => {
      await view.result.current.logout();
    });

    expect(view.result.current.loggedIn).toBe(false);
    expect(view.result.current.accountError).toBe(false);
    expect(view.result.current.catalogError).toBe(false);
  });

  it("目录请求乱序：迟到的失败不把已到手的新目录翻成错误", async () => {
    const list = { current: [] as MyServer[] };
    const bridge = makeBridge(list);
    let rejectFirst: (error: unknown) => void = () => {};
    vi.mocked(bridge.myServerCatalog).mockImplementationOnce(
      () => new Promise((_, reject) => (rejectFirst = reject)) as never,
    );

    const view = renderHook(() =>
      useMyServers(bridge, { active: false, rootSignal: 0 }),
    );
    // 挂载时第一次目录请求挂住；第二次（重读账户）正常返回。
    await act(async () => {
      await view.result.current.refreshAccount();
    });
    expect(view.result.current.catalog).not.toBeNull();

    await act(async () => {
      rejectFirst({ code: "UPSTREAM_ERROR", details: { reason: "network" } });
      await Promise.resolve();
    });
    expect(view.result.current.catalog).not.toBeNull();
    expect(view.result.current.catalogError).toBe(false);
  });
});
