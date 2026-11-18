/** @vitest-environment jsdom */
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentBridge, MyServer } from "../agent/bridge";
import { AGENT_EVENTS } from "../agent/protocol";
import type { AgentEvent } from "../agent/protocol";
import { useMyServers } from "./useMyServers";

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
  hourly_usd: 0.00893,
  monthly_usd: 9,
  daily_price_cents: 30,
  paid_until: new Date(86_400_000).toISOString(),
  billing_state: "active",
  grace_ends_at: null,
  transfer_gib: 1000,
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
    })),
    myServerIdentity: vi.fn(async () => ({ has_identity: true, account_id: "acct_1" })),
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
    subscribe: vi.fn(() => () => {}),
  } as unknown as AgentBridge;
}

afterEach(() => {
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

  it("新行出现在列表后自动解除占位并选中它", async () => {
    const list = { current: [] as MyServer[] };
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
});

describe("开通中的轮询", () => {
  it("最长 5 秒一次，详情跟着刷新，就绪后停止", async () => {
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

    // 第一拍 2 秒。
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(listMock.mock.calls.length).toBe(listBase + 1);

    // 第二拍起封顶 5 秒：2.4 秒不刷新，再 2.6 秒才刷新。
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2400);
    });
    expect(listMock.mock.calls.length).toBe(listBase + 1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2600);
    });
    expect(listMock.mock.calls.length).toBe(listBase + 2);

    // 详情也随每次列表刷新重取，而不是只在选中时拉一次。
    expect(getMock.mock.calls.length).toBeGreaterThan(getBase + 1);

    // 状态就绪：下一拍刷新看到 healthy，之后不再轮询。
    list.current = [{ ...SERVER_A, state: "healthy" as const }];
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
