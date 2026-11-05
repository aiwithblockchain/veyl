/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentBridge, CoreInfo } from "../agent/bridge";
import { AGENT_EVENTS } from "../agent/protocol";
import type { AgentEvent } from "../agent/protocol";
import { RuntimeUpgradeRow, useRuntimeUpgrade } from "./RuntimeUpgrade";

afterEach(cleanup);

const BUNDLED: CoreInfo = {
  bundledVersion: "1.14.4",
  activeVersion: "1.14.4",
  activeSource: "bundled",
  restartRequired: false,
};

const INSTALLED: CoreInfo = {
  bundledVersion: "1.14.4",
  activeVersion: "1.15.0",
  activeSource: "installed",
  restartRequired: false,
};

function harness(
  info: CoreInfo,
  overrides: Partial<Record<keyof AgentBridge, unknown>> = {},
  connected = false,
) {
  let listener: ((event: AgentEvent) => void) | null = null;
  const bridge = {
    mode: "mock",
    subscribe: vi.fn((fn: (event: AgentEvent) => void) => {
      listener = fn;
      return () => {
        listener = null;
      };
    }),
    coreInfo: vi.fn(async () => info),
    coreCheckUpdates: vi.fn(async () => ({
      network: "ok" as const,
      candidates: [{ version: "1.15.0", size: 12 * 1024 * 1024 }],
      cached: false,
    })),
    coreUpgrade: vi.fn(async () => ({ jobId: "job_1" })),
    coreCancelUpgrade: vi.fn(async () => ({ cancelled: true })),
    coreRollback: vi.fn(async () => {}),
    ...overrides,
  } as unknown as AgentBridge;

  function Harness() {
    const controller = useRuntimeUpgrade({ bridge, enabled: true, connected });
    return <RuntimeUpgradeRow controller={controller} />;
  }

  render(<Harness />);
  return {
    bridge,
    emit: (event: AgentEvent) => act(() => listener?.(event)),
  };
}

async function startUpgrade() {
  fireEvent.click(await screen.findByRole("button", { name: "检查更新" }));
  await screen.findByText("可升级到 1.15.0（约 12 MB）");
  fireEvent.click(screen.getByRole("button", { name: "升级" }));
  await act(async () => {});
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("RuntimeUpgradeRow", () => {
  it("随包版本：展示版本与检查更新", async () => {
    harness(BUNDLED);
    expect(
      await screen.findByText("正在使用随包版本 1.14.4", {
        selector: ".core-upgrade__status",
      }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "检查更新" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "回到随包版本" })).toBeNull();
  });

  it("已安装版本：提供回到随包版本", async () => {
    harness(INSTALLED);
    expect(
      await screen.findByText("正在使用 1.15.0（随包 1.14.4）", {
        selector: ".core-upgrade__status",
      }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "回到随包版本" })).toBeTruthy();
  });

  it("检查后展示可升级版本与体积", async () => {
    harness(BUNDLED);
    fireEvent.click(await screen.findByRole("button", { name: "检查更新" }));
    expect(await screen.findByText("可升级到 1.15.0（约 12 MB）")).toBeTruthy();
    expect(screen.getByRole("button", { name: "升级" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "取消" })).toBeTruthy();
  });

  it("缓存结果标注可能过期，且不提供升级按钮", async () => {
    const coreCheckUpdates = vi.fn(async () => ({
      network: "unreachable" as const,
      candidates: [{ version: "1.15.0", size: 12 * 1024 * 1024 }],
      cached: true,
    }));
    const { bridge } = harness(BUNDLED, { coreCheckUpdates });

    fireEvent.click(await screen.findByRole("button", { name: "检查更新" }));
    expect(
      await screen.findByText("可升级到 1.15.0（约 12 MB）", {
        selector: ".core-upgrade__status",
      }),
    ).toBeTruthy();
    expect(screen.getByText("上次检查的结果，可能不是最新")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "升级" })).toBeNull();
    expect(screen.getByRole("button", { name: "重新检查" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "重新检查" }));
    await waitFor(() => expect(bridge.coreCheckUpdates).toHaveBeenCalledTimes(2));
  });

  it("缓存里没有候选时仍按连不上处理", async () => {
    harness(BUNDLED, {
      coreCheckUpdates: vi.fn(async () => ({
        network: "unreachable" as const,
        candidates: [],
        cached: true,
      })),
    });
    fireEvent.click(await screen.findByRole("button", { name: "检查更新" }));
    expect(
      await screen.findByText("连不上更新服务器", {
        selector: ".core-upgrade__status",
      }),
    ).toBeTruthy();
    expect(screen.queryByText("上次检查的结果，可能不是最新")).toBeNull();
  });

  it("非缓存且联网失败时不展示候选", async () => {
    harness(BUNDLED, {
      coreCheckUpdates: vi.fn(async () => ({
        network: "unreachable" as const,
        candidates: [{ version: "1.15.0", size: 12 * 1024 * 1024 }],
        cached: false,
      })),
    });
    fireEvent.click(await screen.findByRole("button", { name: "检查更新" }));
    expect(
      await screen.findByText("连不上更新服务器", {
        selector: ".core-upgrade__status",
      }),
    ).toBeTruthy();
    expect(screen.queryByText("可升级到 1.15.0（约 12 MB）")).toBeNull();
  });

  it("下载、校验、安装到生效", async () => {
    const { emit } = harness(BUNDLED);
    await startUpgrade();

    emit({
      name: AGENT_EVENTS.coreUpgradeProgress,
      payload: {
        job_id: "job_1",
        phase: "download",
        received: 6 * 1024 * 1024,
        total: 12 * 1024 * 1024,
      },
    });
    expect(await screen.findByText("正在下载 50%")).toBeTruthy();
    expect(screen.queryByText("由对话发起")).toBeNull();

    emit({
      name: AGENT_EVENTS.coreUpgradeProgress,
      payload: { job_id: "job_1", phase: "verify", received: 0, total: null },
    });
    expect(await screen.findByText("正在校验安装包…")).toBeTruthy();

    emit({
      name: AGENT_EVENTS.coreUpgradeProgress,
      payload: { job_id: "job_1", phase: "install", received: 0, total: null },
    });
    expect(await screen.findByText("正在安装…")).toBeTruthy();

    emit({
      name: AGENT_EVENTS.coreUpgradeFinished,
      payload: { job_id: "job_1", ok: true, version: "1.15.0" },
    });
    expect(
      await screen.findByText("新版本会在下次连接时生效", {
        selector: ".core-upgrade__status",
      }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "关闭" })).toBeTruthy();
  });

  it("restart_required 为 true 时提示重启 Veyl", async () => {
    const coreInfo = vi
      .fn()
      .mockResolvedValueOnce(BUNDLED)
      .mockResolvedValue({ ...BUNDLED, restartRequired: true });
    const { emit } = harness(BUNDLED, { coreInfo });
    await startUpgrade();

    emit({
      name: AGENT_EVENTS.coreUpgradeFinished,
      payload: { job_id: "job_1", ok: true, version: "1.15.0" },
    });

    expect(
      await screen.findByText("新版本会在重启 Veyl 后生效", {
        selector: ".core-upgrade__status",
      }),
    ).toBeTruthy();
  });

  it("有连接且不需要重启 App 时提示断开重连", async () => {
    const { emit } = harness(BUNDLED, {}, true);
    await startUpgrade();

    emit({
      name: AGENT_EVENTS.coreUpgradeFinished,
      payload: { job_id: "job_1", ok: true, version: "1.15.0" },
    });

    expect(
      await screen.findByText("新版本会在断开并重新连接后生效", {
        selector: ".core-upgrade__status",
      }),
    ).toBeTruthy();
  });

  it("取消升级后回到可升级态，不展示失败", async () => {
    const { bridge, emit } = harness(BUNDLED);
    await startUpgrade();

    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    await waitFor(() => expect(bridge.coreCancelUpgrade).toHaveBeenCalledWith("job_1"));

    emit({
      name: AGENT_EVENTS.coreUpgradeFinished,
      payload: { job_id: "job_1", ok: false, code: "CANCELLED" },
    });

    expect(await screen.findByText("可升级到 1.15.0（约 12 MB）")).toBeTruthy();
    expect(screen.queryByText("升级没有完成。")).toBeNull();
  });

  it("后端取消不带 code 时也回到可升级态", async () => {
    const { emit } = harness(BUNDLED, {
      coreCancelUpgrade: vi.fn(async () => ({ cancelled: false })),
    });
    await startUpgrade();

    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    await act(async () => {});

    emit({
      name: AGENT_EVENTS.coreUpgradeFinished,
      payload: { job_id: "job_1", ok: false },
    });

    expect(await screen.findByText("可升级到 1.15.0（约 12 MB）")).toBeTruthy();
    expect(screen.queryByText("升级没有完成。")).toBeNull();
  });

  it("finished 早于 jobId 返回时仍落到失败态并可重试", async () => {
    const gate = deferred<{ jobId: string }>();
    const { emit, bridge } = harness(BUNDLED, {
      coreUpgrade: vi.fn(() => gate.promise),
    });

    fireEvent.click(await screen.findByRole("button", { name: "检查更新" }));
    await screen.findByText("可升级到 1.15.0（约 12 MB）");
    fireEvent.click(screen.getByRole("button", { name: "升级" }));
    await act(async () => {});

    // 后端先 spawn 任务再返回 job_id：失败事件抢在 invoke 前面到。
    const finished = {
      name: AGENT_EVENTS.coreUpgradeFinished,
      payload: { job_id: "job_1", ok: false, code: "NETWORK_UNREACHABLE" },
    } as const;
    emit(finished);
    emit(finished);
    expect(screen.getByText("正在下载 0%")).toBeTruthy();

    await act(async () => {
      gate.resolve({ jobId: "job_1" });
      await Promise.resolve();
    });

    expect(await screen.findByText("安装包没有下载完。")).toBeTruthy();
    expect(screen.getByRole("button", { name: "重试" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "复制诊断" })).toBeTruthy();
    // 初始读取 + 结束刷新各一次；重复的 finished 不再触发收尾。
    expect(bridge.coreInfo).toHaveBeenCalledTimes(2);
  });

  it("jobId 返回前的进度事件会回放", async () => {
    const gate = deferred<{ jobId: string }>();
    const { emit } = harness(BUNDLED, {
      coreUpgrade: vi.fn(() => gate.promise),
    });

    fireEvent.click(await screen.findByRole("button", { name: "检查更新" }));
    await screen.findByText("可升级到 1.15.0（约 12 MB）");
    fireEvent.click(screen.getByRole("button", { name: "升级" }));
    await act(async () => {});

    emit({
      name: AGENT_EVENTS.coreUpgradeProgress,
      payload: {
        job_id: "job_1",
        phase: "downloading",
        received: 6 * 1024 * 1024,
        total: 12 * 1024 * 1024,
      },
    });
    expect(screen.getByText("正在下载 0%")).toBeTruthy();

    await act(async () => {
      gate.resolve({ jobId: "job_1" });
      await Promise.resolve();
    });

    expect(await screen.findByText("正在下载 50%")).toBeTruthy();
  });

  it("jobId 返回前取消，拿到 id 后补发取消", async () => {
    const gate = deferred<{ jobId: string }>();
    const { bridge } = harness(BUNDLED, {
      coreUpgrade: vi.fn(() => gate.promise),
    });

    fireEvent.click(await screen.findByRole("button", { name: "检查更新" }));
    await screen.findByText("可升级到 1.15.0（约 12 MB）");
    fireEvent.click(screen.getByRole("button", { name: "升级" }));
    await act(async () => {});

    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(screen.getByText("正在取消…")).toBeTruthy();

    await act(async () => {
      gate.resolve({ jobId: "job_1" });
      await Promise.resolve();
    });

    await waitFor(() => expect(bridge.coreCancelUpgrade).toHaveBeenCalledWith("job_1"));
    expect(await screen.findByText("可升级到 1.15.0（约 12 MB）")).toBeTruthy();
  });

  it("百分比变化不重复播报，只在阶段变化时播报", async () => {
    const { emit } = harness(BUNDLED);
    await startUpgrade();

    const live = screen.getByRole("status");
    emit({
      name: AGENT_EVENTS.coreUpgradeProgress,
      payload: {
        job_id: "job_1",
        phase: "downloading",
        received: 6 * 1024 * 1024,
        total: 12 * 1024 * 1024,
      },
    });
    expect(await screen.findByText("正在下载 50%")).toBeTruthy();
    expect(live.textContent).toBe("正在下载安装包");

    emit({
      name: AGENT_EVENTS.coreUpgradeProgress,
      payload: {
        job_id: "job_1",
        phase: "downloading",
        received: 9 * 1024 * 1024,
        total: 12 * 1024 * 1024,
      },
    });
    expect(await screen.findByText("正在下载 75%")).toBeTruthy();
    expect(live.textContent).toBe("正在下载安装包");

    emit({
      name: AGENT_EVENTS.coreUpgradeProgress,
      payload: { job_id: "job_1", phase: "verifying", received: 0, total: null },
    });
    await waitFor(() => expect(live.textContent).toBe("正在校验安装包"));
  });

  it("失败时给三段式与重试、复制诊断", async () => {
    const { emit } = harness(BUNDLED);
    await startUpgrade();

    emit({
      name: AGENT_EVENTS.coreUpgradeFinished,
      payload: { job_id: "job_1", ok: false, code: "CHECKSUM_MISMATCH" },
    });

    expect(await screen.findByText("安装包校验没有通过。")).toBeTruthy();
    expect(
      screen.getByText("当前的运行时没有被替换，连接和配置都没有改动。"),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "点「重试」再试一次；仍失败就继续用当前版本，复制诊断信息发给助手。",
      ),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "重试" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "复制诊断" })).toBeTruthy();
  });

  it("连不上更新服务器", async () => {
    harness(BUNDLED, {
      coreCheckUpdates: vi.fn(async () => ({
        network: "unreachable" as const,
        candidates: [],
        cached: false,
      })),
    });
    fireEvent.click(await screen.findByRole("button", { name: "检查更新" }));
    expect(
      await screen.findByText("连不上更新服务器", {
        selector: ".core-upgrade__status",
      }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "重试" })).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "用随包版本继续" }),
    ).toBeTruthy();
  });

  it("命令不存在时降级为只读展示", async () => {
    harness(BUNDLED, {
      coreInfo: vi.fn(async () => {
        throw new Error("Command core_info not found");
      }),
    });
    expect(await screen.findByText("暂时读不到运行时信息。")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("接管对话发起的升级并标注来源、可取消", async () => {
    const { bridge, emit } = harness(BUNDLED);
    await screen.findByText("正在使用随包版本 1.14.4", {
      selector: ".core-upgrade__status",
    });

    emit({
      name: AGENT_EVENTS.coreUpgradeProgress,
      payload: {
        job_id: "job_chat",
        phase: "downloading",
        received: 6 * 1024 * 1024,
        total: 12 * 1024 * 1024,
        origin: "agent",
      },
    });

    expect(await screen.findByText("正在下载 50%")).toBeTruthy();
    expect(screen.getByText("由对话发起")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    await waitFor(() => expect(bridge.coreCancelUpgrade).toHaveBeenCalledWith("job_chat"));
  });

  it("对话任务结束时也保留来源标注", async () => {
    const { emit } = harness(BUNDLED);
    await screen.findByText("正在使用随包版本 1.14.4", {
      selector: ".core-upgrade__status",
    });

    emit({
      name: AGENT_EVENTS.coreUpgradeFinished,
      payload: {
        job_id: "job_chat",
        ok: true,
        version: "1.15.0",
        origin: "agent",
      },
    });

    expect(
      await screen.findByText("新版本会在下次连接时生效", {
        selector: ".core-upgrade__status",
      }),
    ).toBeTruthy();
    expect(screen.getByText("由对话发起")).toBeTruthy();
  });
});
