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

const NO_UPDATE = () => ({
  network: "ok" as const,
  candidates: [],
  cached: false,
});

const WITH_UPDATE = () => ({
  network: "ok" as const,
  candidates: [{ version: "1.15.0", size: 12 * 1024 * 1024 }],
  cached: false,
});

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
    coreCheckUpdates: vi.fn(async () => WITH_UPDATE()),
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
  fireEvent.click(await screen.findByRole("button", { name: "升级" }));
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
  it("打开即自动检查；已是最新时不给任何按钮", async () => {
    const { bridge } = harness(BUNDLED, { coreCheckUpdates: vi.fn(async () => NO_UPDATE()) });

    expect(
      await screen.findByText("已是最新 · 版本 1.14.4", {
        selector: ".core-upgrade__status",
      }),
    ).toBeTruthy();
    expect(bridge.coreCheckUpdates).toHaveBeenCalledTimes(1);
    expect(screen.getByText("连接程序")).toBeTruthy();
    expect(screen.getByText("真正建立连接的程序。")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("有新版本时只有一个主按钮，没有取消", async () => {
    harness(BUNDLED);
    expect(await screen.findByText("有新版本 1.15.0（约 12 MB）")).toBeTruthy();
    const upgrade = screen.getByRole("button", { name: "升级" });
    expect(upgrade.className).toContain("btn--primary");
    expect(screen.queryByRole("button", { name: "取消" })).toBeNull();
    expect(screen.queryByRole("button", { name: "检查更新" })).toBeNull();
  });

  it("使用已升级版本时提供换回自带的版本", async () => {
    harness(INSTALLED, { coreCheckUpdates: vi.fn(async () => NO_UPDATE()) });
    expect(
      await screen.findByText("已是最新 · 版本 1.15.0", {
        selector: ".core-upgrade__status",
      }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "换回自带的版本" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "回到随包版本" })).toBeNull();
  });

  it("断网时只说明继续用自带版本，并给再试一次", async () => {
    harness(BUNDLED, {
      coreCheckUpdates: vi.fn(async () => ({
        network: "unreachable" as const,
        candidates: [{ version: "1.15.0", size: 12 * 1024 * 1024 }],
        cached: true,
      })),
    });

    expect(
      await screen.findByText("暂时连不上更新服务器，继续用自带的版本。", {
        selector: ".core-upgrade__status",
      }),
    ).toBeTruthy();
    const buttons = screen.getAllByRole("button").map((button) => button.textContent);
    expect(buttons).toEqual(["再试一次"]);
    expect(screen.queryByText(/用随包版本继续/)).toBeNull();
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

    expect(await screen.findByText("有新版本 1.15.0（约 12 MB）")).toBeTruthy();
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

    expect(await screen.findByText("有新版本 1.15.0（约 12 MB）")).toBeTruthy();
    expect(screen.queryByText("升级没有完成。")).toBeNull();
  });

  it("finished 早于 jobId 返回时仍落到失败态并可重试", async () => {
    const gate = deferred<{ jobId: string }>();
    const { emit, bridge } = harness(BUNDLED, {
      coreUpgrade: vi.fn(() => gate.promise),
    });
    await startUpgrade();

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

  it("可用态刚渲染就点升级也能开始（不等 effect 同步阶段）", async () => {
    const gate = deferred<{ jobId: string }>();
    const { bridge } = harness(BUNDLED, {
      coreUpgrade: vi.fn(() => gate.promise),
    });

    // 提交可用态到 passive effect 之间有个窗口：DOM 已经显示「升级」，
    // 阶段却还没同步进 ref。MutationObserver 在提交后、effect 前触发，
    // 用来稳定复现这段窗口里的点击。
    let clicked = false;
    const observer = new MutationObserver(() => {
      if (clicked) return;
      const button = screen.queryByRole("button", { name: "升级" });
      if (!button) return;
      clicked = true;
      act(() => (button as HTMLButtonElement).click());
    });
    observer.observe(document.body, { childList: true, subtree: true });

    try {
      await waitFor(() => expect(bridge.coreUpgrade).toHaveBeenCalledWith("1.15.0"));
      expect(await screen.findByText("正在下载 0%")).toBeTruthy();
    } finally {
      observer.disconnect();
      await act(async () => {
        gate.resolve({ jobId: "job_1" });
        await Promise.resolve();
      });
    }
  });

  it("jobId 返回前的进度事件会回放", async () => {
    const gate = deferred<{ jobId: string }>();
    const { emit } = harness(BUNDLED, {
      coreUpgrade: vi.fn(() => gate.promise),
    });

    await startUpgrade();

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

    await startUpgrade();

    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(screen.getByText("正在取消…")).toBeTruthy();

    await act(async () => {
      gate.resolve({ jobId: "job_1" });
      await Promise.resolve();
    });

    await waitFor(() => expect(bridge.coreCancelUpgrade).toHaveBeenCalledWith("job_1"));
    expect(await screen.findByText("有新版本 1.15.0（约 12 MB）")).toBeTruthy();
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
      screen.getByText("当前的连接程序没有被替换，连接和配置都没有改动。"),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "点「重试」再试一次；仍失败就继续用当前版本，复制诊断信息发给助手。",
      ),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "重试" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "复制诊断" })).toBeTruthy();
  });

  it("命令不存在时降级为只读展示", async () => {
    harness(BUNDLED, {
      coreInfo: vi.fn(async () => {
        throw new Error("Command core_info not found");
      }),
    });
    expect(await screen.findByText("暂时读不到连接程序信息。")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("接管对话发起的升级并标注来源、可取消", async () => {
    const { bridge, emit } = harness(BUNDLED, {
      coreCheckUpdates: vi.fn(async () => NO_UPDATE()),
    });
    await screen.findByText("已是最新 · 版本 1.14.4", {
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
    const { emit } = harness(BUNDLED, {
      coreCheckUpdates: vi.fn(async () => NO_UPDATE()),
    });
    await screen.findByText("已是最新 · 版本 1.14.4", {
      selector: ".core-upgrade__status",
    });

    emit({
      name: AGENT_EVENTS.coreUpgradeProgress,
      payload: {
        job_id: "job_chat2",
        phase: "downloading",
        received: 1,
        total: 2,
        origin: "agent",
      },
    });
    await screen.findByText("由对话发起");

    emit({
      name: AGENT_EVENTS.coreUpgradeFinished,
      payload: { job_id: "job_chat2", ok: true, version: "1.15.0", origin: "agent" },
    });

    expect(await screen.findByText("由对话发起")).toBeTruthy();
  });
});
