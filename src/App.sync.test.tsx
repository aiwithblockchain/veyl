/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import { getAgentBridge } from "./agent";
import type { MyServer, ServerSyncChanged } from "./agent/bridge";
import { AGENT_EVENTS, CONTRACT_VERSION } from "./agent/protocol";
import { useServerSync } from "./myservers/useServerSync";

const SKIP_KEY = "veyl.onboarding.skipped";

const SERVER: MyServer = {
  server_id: "srv_sync_1",
  name: "新加坡 1 · DigitalOcean",
  region: "sgp1",
  plan: "s-1vcpu-1gb",
  state: "healthy",
  created_at: new Date(0).toISOString(),
  ip: "45.76.20.100",
  port: 8388,
  node_id: "nd_sync_1",
  local_node_id: "local_nd_sync_1",
  hourly_usd: 0.007,
  monthly_usd: 5,
  daily_price_cents: 30,
  paid_until: null,
  billing_state: "active",
  grace_ends_at: null,
  transfer_gib: 1000,
  failure: null,
};

const TOMB: MyServer = {
  ...SERVER,
  server_id: "srv_tomb",
  name: "已停机服务器",
  state: "destroyed",
  node_id: "nd_tomb",
  local_node_id: "local_tomb",
  billing_state: "expired",
  failure: {
    stage: "active",
    code: "billing_unpaid",
    message: "余额不足，已停机删除",
    retryable: false,
  },
};

const bridge = getAgentBridge();
const modeDescriptor = Object.getOwnPropertyDescriptor(bridge, "mode");
const widthDescriptor = Object.getOwnPropertyDescriptor(window, "innerWidth");

type SyncResult = {
  servers: MyServer[];
  changed: ServerSyncChanged[];
  failed: Array<{ server_id: string; code: string; message: string }>;
};

let syncImpl: () => Promise<SyncResult>;
let intervalMinutes: number;

/** Ivy 的 bridge 方法落盘前用 defineProperty 挂 mock；落盘后同样生效。 */
const ownedKeys = ["myServerSync", "serverSyncIntervalGet", "serverSyncIntervalSet"];

function defineMethod(name: string, value: unknown) {
  Object.defineProperty(bridge, name, { value, configurable: true, writable: true });
}

beforeEach(() => {
  Object.defineProperty(bridge, "mode", { value: "tauri", configurable: true });
  Object.defineProperty(window, "innerWidth", { value: 1440, configurable: true });
  localStorage.setItem(SKIP_KEY, "1");
  intervalMinutes = 30;
  syncImpl = async () => ({ servers: [SERVER], changed: [], failed: [] });
  defineMethod("myServerSync", vi.fn(() => syncImpl()));
  defineMethod("serverSyncIntervalGet", vi.fn(async () => ({ minutes: intervalMinutes })));
  defineMethod("serverSyncIntervalSet", vi.fn(async (minutes: number) => ({ minutes })));

  vi.spyOn(bridge, "configList").mockResolvedValue({
    configs: [],
    active_config_id: null,
  });
  vi.spyOn(bridge, "getRuntimeSnapshot").mockResolvedValue(null);
  vi.spyOn(bridge, "getDeepSeekKey").mockResolvedValue({
    masked: "sk-****abcd",
    verified: true,
    validation: "ok",
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
  } as never);
  vi.spyOn(bridge, "myServerCatalog").mockResolvedValue({
    regions: [],
    plans: [],
    currency: "USD",
    updated_at: new Date(0).toISOString(),
  } as never);
  vi.spyOn(bridge, "trialStatus").mockResolvedValue({
    state: "active",
    started_at: new Date(0).toISOString(),
    expires_at: new Date(7 * 86_400_000).toISOString(),
    remaining_ms: 7 * 86_400_000,
    seed_node_count: 1,
  } as never);
  vi.spyOn(bridge, "myServerList").mockResolvedValue({ servers: [SERVER] });
  vi.spyOn(bridge, "myServerGet").mockResolvedValue(SERVER);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  localStorage.clear();
  for (const key of ownedKeys) {
    delete (bridge as unknown as Record<string, unknown>)[key];
  }
  if (modeDescriptor) Object.defineProperty(bridge, "mode", modeDescriptor);
  if (widthDescriptor) {
    Object.defineProperty(window, "innerWidth", widthDescriptor);
  } else {
    Object.defineProperty(window, "innerWidth", { value: 1024, configurable: true });
  }
});

async function waitForShell() {
  await waitFor(() => expect(document.querySelector(".app")).not.toBeNull());
}

/** 打开设置 › 连接，拿「立即同步」。 */
async function openSyncRow() {
  fireEvent.click(screen.getByRole("button", { name: "设置" }));
  const settings = await screen.findByRole("dialog", { name: "设置" });
  fireEvent.click(within(settings).getByRole("tab", { name: "连接" }));
  await within(settings).findByText("节点配置同步");
  return within(settings).getByRole("button", { name: "立即同步" });
}

async function openSyncSelect(): Promise<HTMLSelectElement> {
  const settings = await screen.findByRole("dialog", { name: "设置" });
  return within(settings).getByRole("combobox", {
    name: "同步间隔",
  }) as HTMLSelectElement;
}

function toastText(): string | null {
  return document.querySelector(".app-toast__text")?.textContent ?? null;
}

function change(name: string): ServerSyncChanged {
  return {
    server_id: "srv_sync_1",
    node_id: "local_nd_sync_1",
    name,
    port_changed: true,
    password_changed: false,
  };
}

describe("节点配置同步", () => {
  it("手动同步：单台提示节点名", async () => {
    intervalMinutes = 0;
    syncImpl = async () => ({
      servers: [SERVER],
      changed: [change(SERVER.name)],
      failed: [],
    });
    render(<App />);
    await waitForShell();

    fireEvent.click(await openSyncRow());
    await waitFor(() =>
      expect(toastText()).toBe(`「${SERVER.name}」配置已更新`),
    );
    expect(bridge.myServerSync).toHaveBeenCalledTimes(1);
  }, 15_000);

  it("手动同步：多台提示数量", async () => {
    intervalMinutes = 0;
    syncImpl = async () => ({
      servers: [SERVER],
      changed: [change("A"), change("B")],
      failed: [],
    });
    render(<App />);
    await waitForShell();

    fireEvent.click(await openSyncRow());
    await waitFor(() => expect(toastText()).toBe("2 个节点配置已更新"));
  }, 15_000);

  it("没有变化不提示", async () => {
    intervalMinutes = 0;
    const sync = vi.mocked(bridge.myServerSync);
    render(<App />);
    await waitForShell();

    fireEvent.click(await openSyncRow());
    await waitFor(() => expect(sync).toHaveBeenCalledTimes(1));
    await act(async () => {});
    expect(toastText()).toBeNull();
  }, 15_000);

  it("同步失败：不提示、列表保留、只记日志", async () => {
    intervalMinutes = 0;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    syncImpl = async () => {
      throw { code: "INTERNAL", message: "boom" };
    };
    render(<App />);
    await waitForShell();

    fireEvent.click(await openSyncRow());
    await waitFor(() => expect(bridge.myServerSync).toHaveBeenCalledTimes(1));
    await act(async () => {});
    expect(toastText()).toBeNull();
    expect(warn).toHaveBeenCalled();

    // 列表与旧节点值仍在。
    fireEvent.click(screen.getByRole("button", { name: "关闭设置" }));
    fireEvent.click(await screen.findByRole("button", { name: /我的服务器/ }));
    const rail = await screen.findByRole("complementary", { name: "服务器列表" });
    expect(await within(rail).findByRole("button", { name: /新加坡 1/ })).toBeTruthy();
  }, 15_000);

  it("同步期间「立即同步」禁用", async () => {
    intervalMinutes = 0;
    let resolve!: (value: SyncResult) => void;
    syncImpl = () =>
      new Promise((done) => {
        resolve = done;
      });
    render(<App />);
    await waitForShell();

    const button = await openSyncRow();
    fireEvent.click(button);
    await waitFor(() => expect(button.hasAttribute("disabled")).toBe(true));

    await act(async () => {
      resolve({ servers: [SERVER], changed: [], failed: [] });
    });
    await waitFor(() => expect(button.hasAttribute("disabled")).toBe(false));
  }, 15_000);

  it("同步后 Host 发 node-list-changed：连接页自己重拉配置", async () => {
    intervalMinutes = 0;
    syncImpl = async () => ({
      servers: [SERVER],
      changed: [change(SERVER.name)],
      failed: [],
    });
    render(<App />);
    await waitForShell();
    await waitFor(() => expect(bridge.configList).toHaveBeenCalled());
    const before = vi.mocked(bridge.configList).mock.calls.length;

    fireEvent.click(await openSyncRow());
    await waitFor(() => expect(bridge.myServerSync).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(toastText()).not.toBeNull());

    // hook 不订阅事件；这里模拟 Host 广播，验证既有链路会重拉配置。
    act(() => {
      (
        bridge as unknown as { emit: (event: unknown) => void }
      ).emit({
        name: AGENT_EVENTS.nodeListChanged,
        payload: {
          contract_version: CONTRACT_VERSION,
          reason: "node_synced",
          config_id: null,
          node_count_total: 1,
          changed_node_ids: [],
          emitted_at: new Date().toISOString(),
        },
      });
    });
    await waitFor(() =>
      expect(vi.mocked(bridge.configList).mock.calls.length).toBeGreaterThan(
        before,
      ),
    );
  }, 15_000);

  it("间隔为手动：不自动跑", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    intervalMinutes = 0;
    render(<App />);
    await waitForShell();
    // 等间隔值读回来（启动是异步的），再推进时间。
    await act(async () => {});
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60 * 60_000);
    });
    expect(bridge.myServerSync).not.toHaveBeenCalled();
  }, 15_000);

  it("启动先同步一次：间隔非手动时挂载即跑", async () => {
    intervalMinutes = 5;
    render(<App />);
    await waitForShell();
    await waitFor(() => expect(bridge.myServerAccount).toHaveBeenCalled());
    await waitFor(() => expect(bridge.serverSyncIntervalGet).toHaveBeenCalled());
    await screen.findByRole("button", { name: /me@example.com/ });
    await waitFor(() =>
      expect(bridge.myServerSync).toHaveBeenCalledTimes(1),
    );
  }, 15_000);

  it("未登录：不启动同步、也不排定时", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    intervalMinutes = 5;
    vi.mocked(bridge.myServerAccount).mockResolvedValue({
      logged_in: false,
      email: null,
      account_id: null,
      device_id: null,
      account_kind: null,
    });
    render(<App />);
    await waitForShell();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30 * 60_000);
    });
    expect(bridge.myServerSync).not.toHaveBeenCalled();
  }, 15_000);

  it("先未登录、随后登录：登录后补跑首轮且只跑一次", async () => {
    const onChanged = vi.fn();
    const { rerender } = renderHook(
      ({ enabled }: { enabled: boolean }) =>
        useServerSync({
          bridge,
          intervalMinutes: 5,
          enabled,
          accountEpoch: 0,
          onChanged,
        }),
      { initialProps: { enabled: false } },
    );
    await act(async () => {});
    expect(bridge.myServerSync).not.toHaveBeenCalled();

    rerender({ enabled: true });
    await waitFor(() =>
      expect(bridge.myServerSync).toHaveBeenCalledTimes(1),
    );

    // 登录态再变化也只补这一次。
    rerender({ enabled: true });
    await act(async () => {});
    expect(bridge.myServerSync).toHaveBeenCalledTimes(1);
  }, 15_000);

  it("迟到的间隔读取不覆盖用户刚选的档位", async () => {
    let resolveGet!: (value: { minutes: 5 | 30 }) => void;
    defineMethod(
      "serverSyncIntervalGet",
      vi.fn(
        () =>
          new Promise<{ minutes: 5 | 30 }>((done) => {
            resolveGet = done;
          }),
      ),
    );
    render(<App />);
    await waitForShell();
    await waitFor(() =>
      expect(bridge.serverSyncIntervalGet).toHaveBeenCalled(),
    );

    fireEvent.click(screen.getByRole("button", { name: "设置" }));
    const settings = await screen.findByRole("dialog", { name: "设置" });
    fireEvent.click(within(settings).getByRole("tab", { name: "连接" }));
    const select = (await within(settings).findByRole("combobox", {
      name: "同步间隔",
    })) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "5" } });
    await waitFor(() =>
      expect(
        (
          document.querySelector(".settings-sync__select") as HTMLSelectElement
        ).value,
      ).toBe("5"),
    );

    // 迟到的读取（30）落地，档位仍是用户选的 5。
    await act(async () => {
      resolveGet({ minutes: 30 });
    });
    await act(async () => {});
    expect(
      (document.querySelector(".settings-sync__select") as HTMLSelectElement)
        .value,
    ).toBe("5");
  }, 15_000);

  it("改间隔只重建定时器，不立即触发同步", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    intervalMinutes = 5;
    render(<App />);
    await waitForShell();
    await waitFor(() =>
      expect(bridge.myServerSync).toHaveBeenCalledTimes(1),
    );

    fireEvent.click(screen.getByRole("button", { name: "设置" }));
    const settings = await screen.findByRole("dialog", { name: "设置" });
    fireEvent.click(within(settings).getByRole("tab", { name: "连接" }));
    const select = (await within(settings).findByRole("combobox", {
      name: "同步间隔",
    })) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "15" } });
    await waitFor(() =>
      expect(bridge.serverSyncIntervalSet).toHaveBeenCalledWith(15),
    );
    await act(async () => {});
    expect(bridge.myServerSync).toHaveBeenCalledTimes(1);

    // 新的 15 分钟周期到点才跑。
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15 * 60_000);
    });
    await waitFor(() =>
      expect(bridge.myServerSync).toHaveBeenCalledTimes(2),
    );
  }, 15_000);

  it("同步成功后用返回的服务器更新列表，不再发 my_server_list", async () => {
    intervalMinutes = 0;
    syncImpl = async () => ({
      servers: [SERVER, { ...SERVER, server_id: "srv_sync_2", name: "东京 2 · DigitalOcean" }],
      changed: [],
      failed: [],
    });
    render(<App />);
    await waitForShell();
    fireEvent.click(await screen.findByRole("button", { name: /我的服务器/ }));
    const rail = await screen.findByRole("complementary", { name: "服务器列表" });
    await within(rail).findByRole("button", { name: /新加坡 1/ });
    expect(rail.querySelector(".rail__count")?.textContent).toBe("1");
    const before = vi.mocked(bridge.myServerList).mock.calls.length;

    fireEvent.click(await openSyncRow());
    await waitFor(() =>
      expect(bridge.myServerSync).toHaveBeenCalledTimes(1),
    );
    await waitFor(() =>
      expect(
        document.querySelector(".rail__count")?.textContent,
      ).toBe("2"),
    );
    // 返回值直接落地：同步不应再额外发一次列表请求。
    expect(vi.mocked(bridge.myServerList).mock.calls.length).toBe(before);
  }, 15_000);

  it("停机删除的墓碑不会因同步返回的列表复活", async () => {
    intervalMinutes = 0;
    vi.mocked(bridge.myServerList).mockResolvedValue({ servers: [TOMB] });
    vi.spyOn(bridge, "nodeForget").mockResolvedValue({
      forgotten: true,
    } as never);
    syncImpl = async () => ({ servers: [TOMB], changed: [], failed: [] });
    render(<App />);
    await waitForShell();

    fireEvent.click(await screen.findByRole("button", { name: /我的服务器/ }));
    const rail = await screen.findByRole("complementary", {
      name: "服务器列表",
    });
    fireEvent.click(
      await within(rail).findByRole("button", { name: /已停机删除/ }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "删除" }));
    fireEvent.click(await screen.findByRole("button", { name: "确认删除" }));
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: /已停机删除/ })).toBeNull(),
    );

    fireEvent.click(await openSyncRow());
    await waitFor(() =>
      expect(bridge.myServerSync).toHaveBeenCalledTimes(1),
    );
    await act(async () => {});
    // 同步返回里仍有这台，但本地墓碑过滤仍然生效。
    expect(screen.queryByRole("button", { name: /已停机删除/ })).toBeNull();
  }, 15_000);

  it("同步挂起时切账号：迟到结果不落地、不提示", async () => {
    let resolveSync!: (value: SyncResult) => void;
    syncImpl = () =>
      new Promise((done) => {
        resolveSync = done;
      });
    const applyServers = vi.fn();
    const onChanged = vi.fn();
    const { result, rerender } = renderHook(
      (props: { accountEpoch: number; enabled: boolean }) =>
        useServerSync({
          bridge,
          intervalMinutes: 0,
          enabled: props.enabled,
          accountEpoch: props.accountEpoch,
          applyServers,
          onChanged,
        }),
      { initialProps: { accountEpoch: 0, enabled: true } },
    );

    await act(async () => {
      void result.current.syncNow();
    });
    rerender({ accountEpoch: 1, enabled: true });
    await act(async () => {
      resolveSync({
        servers: [SERVER],
        changed: [change("别的账号的节点")],
        failed: [],
      });
    });

    expect(applyServers).not.toHaveBeenCalled();
    expect(onChanged).not.toHaveBeenCalled();
    // 换账号已把时间置空，迟到结果也不能再写回。
    expect(result.current.lastSyncedAt).toBeNull();
  }, 15_000);

  it("同步挂起时登出：迟到结果不落地、不提示", async () => {
    let resolveSync!: (value: SyncResult) => void;
    syncImpl = () =>
      new Promise((done) => {
        resolveSync = done;
      });
    const applyServers = vi.fn();
    const onChanged = vi.fn();
    const { result, rerender } = renderHook(
      (props: { accountEpoch: number; enabled: boolean }) =>
        useServerSync({
          bridge,
          intervalMinutes: 0,
          enabled: props.enabled,
          accountEpoch: props.accountEpoch,
          applyServers,
          onChanged,
        }),
      { initialProps: { accountEpoch: 0, enabled: true } },
    );

    await act(async () => {
      void result.current.syncNow();
    });
    rerender({ accountEpoch: 1, enabled: false });
    await act(async () => {
      resolveSync({
        servers: [SERVER],
        changed: [change("登出前的节点")],
        failed: [],
      });
    });

    expect(applyServers).not.toHaveBeenCalled();
    expect(onChanged).not.toHaveBeenCalled();
    expect(result.current.lastSyncedAt).toBeNull();
  }, 15_000);

  it("写库失败：回退上一个有效值并标未保存；再次成功清除", async () => {
    defineMethod(
      "serverSyncIntervalSet",
      vi.fn(async () => {
        throw { code: "INTERNAL", message: "" };
      }),
    );
    render(<App />);
    await waitForShell();
    fireEvent.click(screen.getByRole("button", { name: "设置" }));
    await screen.findByRole("dialog", { name: "设置" });
    const settings = screen.getByRole("dialog", { name: "设置" });
    fireEvent.click(within(settings).getByRole("tab", { name: "连接" }));
    const select = await openSyncSelect();

    fireEvent.change(select, { target: { value: "5" } });
    await waitFor(() => expect(toastText()).toBe("同步间隔保存失败"));
    // 回退到读取到的旧档位，并标未保存。
    expect(select.value).toBe("30");
    expect(screen.getByText("未保存")).toBeTruthy();

    // 下一次写入成功：档位更新、未保存清除。
    defineMethod(
      "serverSyncIntervalSet",
      vi.fn(async () => ({ minutes: 15 })),
    );
    fireEvent.change(select, { target: { value: "15" } });
    await waitFor(() => expect(select.value).toBe("15"));
    expect(screen.queryByText("未保存")).toBeNull();
  }, 15_000);

  it("首次读取间隔失败会重试一次", async () => {
    intervalMinutes = 5;
    defineMethod(
      "serverSyncIntervalGet",
      vi
        .fn()
        .mockRejectedValueOnce({ code: "INTERNAL", message: "" })
        .mockResolvedValueOnce({ minutes: 5 }),
    );
    render(<App />);
    await waitForShell();
    await waitFor(() =>
      expect(bridge.serverSyncIntervalGet).toHaveBeenCalledTimes(2),
    );
    // 5 分钟档生效后启动首轮同步。
    await waitFor(() =>
      expect(bridge.myServerSync).toHaveBeenCalledTimes(1),
    );
  }, 15_000);

  it("读取间隔连续失败按 30，不写库", async () => {
    defineMethod(
      "serverSyncIntervalGet",
      vi.fn(async () => {
        throw { code: "INTERNAL", message: "" };
      }),
    );
    render(<App />);
    await waitForShell();
    await waitFor(() =>
      expect(bridge.serverSyncIntervalGet).toHaveBeenCalledTimes(2),
    );
    expect(bridge.serverSyncIntervalSet).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "设置" }));
    await screen.findByRole("dialog", { name: "设置" });
    const settings = screen.getByRole("dialog", { name: "设置" });
    fireEvent.click(within(settings).getByRole("tab", { name: "连接" }));
    const select = await openSyncSelect();
    expect(select.value).toBe("30");
    expect(screen.queryByText("未保存")).toBeNull();
  }, 15_000);

  it("旧 set 的迟到成功不回写、迟到失败不弹提示", async () => {
    intervalMinutes = 30;
    let resolveFirst!: (value: { minutes: 5 | 15 }) => void;
    const setMock = vi.fn();
    setMock.mockImplementationOnce(
      () =>
        new Promise<{ minutes: 5 | 15 }>((done) => {
          resolveFirst = done;
        }),
    );
    setMock.mockImplementationOnce(async () => ({ minutes: 5 }));
    defineMethod("serverSyncIntervalSet", setMock);
    render(<App />);
    await waitForShell();
    fireEvent.click(screen.getByRole("button", { name: "设置" }));
    await screen.findByRole("dialog", { name: "设置" });
    const settings = screen.getByRole("dialog", { name: "设置" });
    fireEvent.click(within(settings).getByRole("tab", { name: "连接" }));
    const select = await openSyncSelect();

    fireEvent.change(select, { target: { value: "15" } });
    fireEvent.change(select, { target: { value: "5" } });
    await waitFor(() => expect(select.value).toBe("5"));

    // 第一次写入的迟到结果不应覆盖第二次。
    await act(async () => {
      resolveFirst({ minutes: 15 });
    });
    await act(async () => {});
    expect(select.value).toBe("5");
    expect(toastText()).toBeNull();
    // 迟到的旧写入之后补发一次最新意图，保证最终落库是新档。
    expect(setMock).toHaveBeenCalledTimes(3);
    expect(setMock.mock.calls[2][0]).toBe(5);
  }, 15_000);

  it("成功同步记录 lastSyncedAt，失败不更新", async () => {
    const onChanged = vi.fn();
    const { result } = renderHook(() =>
      useServerSync({
        bridge,
        intervalMinutes: 0,
        enabled: true,
        accountEpoch: 0,
        onChanged,
      }),
    );
    expect(result.current.lastSyncedAt).toBeNull();

    await act(async () => {
      await result.current.syncNow();
    });
    const first = result.current.lastSyncedAt;
    expect(first).not.toBeNull();

    syncImpl = async () => {
      throw { code: "INTERNAL", message: "" };
    };
    await act(async () => {
      await result.current.syncNow();
    });
    expect(result.current.lastSyncedAt).toBe(first);
  }, 15_000);

  it("换账号后新账号有自己的首轮同步", async () => {
    const onChanged = vi.fn();
    const { result, rerender } = renderHook(
      (props: { accountEpoch: number; enabled: boolean }) =>
        useServerSync({
          bridge,
          intervalMinutes: 5,
          enabled: props.enabled,
          accountEpoch: props.accountEpoch,
          onChanged,
        }),
      { initialProps: { accountEpoch: 0, enabled: true } },
    );
    await waitFor(() =>
      expect(bridge.myServerSync).toHaveBeenCalledTimes(1),
    );

    expect(result.current.lastSyncedAt).not.toBeNull();

    rerender({ accountEpoch: 1, enabled: false });
    await act(async () => {});
    expect(bridge.myServerSync).toHaveBeenCalledTimes(1);
    // 换账号立即清空，不显示上一账号的同步时间。
    expect(result.current.lastSyncedAt).toBeNull();

    rerender({ accountEpoch: 2, enabled: true });
    await waitFor(() =>
      expect(bridge.myServerSync).toHaveBeenCalledTimes(2),
    );
    await waitFor(() => expect(result.current.lastSyncedAt).not.toBeNull());
  }, 15_000);

  it("旧 set 的迟到失败不弹提示", async () => {
    intervalMinutes = 30;
    let rejectFirst!: (reason: unknown) => void;
    const setMock = vi.fn();
    setMock.mockImplementationOnce(
      () =>
        new Promise((_done, reject) => {
          rejectFirst = reject;
        }),
    );
    setMock.mockImplementationOnce(async () => ({ minutes: 5 }));
    defineMethod("serverSyncIntervalSet", setMock);
    render(<App />);
    await waitForShell();
    fireEvent.click(screen.getByRole("button", { name: "设置" }));
    await screen.findByRole("dialog", { name: "设置" });
    const settings = screen.getByRole("dialog", { name: "设置" });
    fireEvent.click(within(settings).getByRole("tab", { name: "连接" }));
    const select = await openSyncSelect();

    fireEvent.change(select, { target: { value: "15" } });
    fireEvent.change(select, { target: { value: "5" } });
    await waitFor(() => expect(select.value).toBe("5"));

    await act(async () => {
      rejectFirst({ code: "INTERNAL", message: "" });
    });
    await act(async () => {});
    expect(toastText()).toBeNull();
    expect(select.value).toBe("5");
  }, 15_000);

  it("初始列表失败后同步成功：列表恢复且可交互", async () => {
    intervalMinutes = 0;
    vi.mocked(bridge.myServerList).mockRejectedValue({
      code: "INTERNAL",
      message: "",
    });
    syncImpl = async () => ({ servers: [SERVER], changed: [], failed: [] });
    render(<App />);
    await waitForShell();

    fireEvent.click(await screen.findByRole("button", { name: /我的服务器/ }));
    const rail = await screen.findByRole("complementary", {
      name: "服务器列表",
    });
    expect(
      within(rail).queryByRole("button", { name: /新加坡 1/ }),
    ).toBeNull();

    fireEvent.click(await openSyncRow());
    await waitFor(() =>
      expect(bridge.myServerSync).toHaveBeenCalledTimes(1),
    );
    const row = await within(rail).findByRole("button", {
      name: /新加坡 1/,
    });
    expect(row.hasAttribute("disabled")).toBe(false);
  }, 15_000);

  it("间隔 5 分钟：启动跑一次，到点再跑一次", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    intervalMinutes = 5;
    render(<App />);
    await waitForShell();
    await waitFor(() =>
      expect(bridge.myServerSync).toHaveBeenCalledTimes(1),
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5 * 60_000);
    });
    await waitFor(() =>
      expect(bridge.myServerSync).toHaveBeenCalledTimes(2),
    );
  }, 15_000);

  it("后台超过间隔后回到前台补跑一次", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    intervalMinutes = 30;
    render(<App />);
    await waitForShell();
    // 启动首轮。
    await waitFor(() =>
      expect(bridge.myServerSync).toHaveBeenCalledTimes(1),
    );

    // 时间前移 31 分钟，但不推进定时器（模拟休眠）。
    await act(async () => {
      vi.setSystemTime(Date.now() + 31 * 60_000);
    });
    Object.defineProperty(document, "visibilityState", {
      value: "visible",
      configurable: true,
    });
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await waitFor(() =>
      expect(bridge.myServerSync).toHaveBeenCalledTimes(2),
    );
  }, 15_000);
});
