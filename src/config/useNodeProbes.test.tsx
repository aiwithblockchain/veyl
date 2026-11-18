/** @vitest-environment jsdom */
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentBridge } from "../agent/bridge";
import { AGENT_EVENTS, CONTRACT_VERSION } from "../agent/protocol";
import type { AgentEvent, NodeProbeData, NodeProbeMethod, NodeProbePhase } from "../agent/protocol";
import { useNodeProbes } from "./useNodeProbes";

const IDS = ["n1", "n2", "n3", "n4", "n5", "n6", "n7", "n8"];

function probe(nodeId: string, latency: number | null): NodeProbeData {
  return {
    node_id: nodeId,
    reachable: latency !== null,
    latency_ms: latency,
    probe_method: "tcp",
    checked_at: Date.now(),
    error: latency === null ? { code: "PROBE_TIMEOUT", message: "" } : null,
  };
}

function harness(overrides: Partial<Record<keyof AgentBridge, unknown>> = {}) {
  const listeners = new Set<(event: AgentEvent) => void>();
  const bridge = {
    subscribe: vi.fn((listener: (event: AgentEvent) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }),
    nodeProbeSnapshot: vi.fn(async () => ({
      configId: "cfg-1",
      results: [],
      run: null,
    })),
    nodeProbeAll: vi.fn(async () => ({
      runId: "run-1",
      configId: "cfg-1",
      total: IDS.length,
      concurrency: 6,
      ignoredNodeIds: [],
    })),
    nodeProbeCancel: vi.fn(async () => ({ cancelled: true })),
    nodeProbe: vi.fn(async (nodeId: string) => probe(nodeId, 40)),
    ...overrides,
  } as unknown as AgentBridge;
  const view = renderHook(() => useNodeProbes({ bridge }));
  return {
    ...view,
    bridge,
    emit: (event: AgentEvent) =>
      act(() => {
        for (const listener of listeners) listener(event);
      }),
  };
}

function progress(
  runId: string,
  done: number,
  result: NodeProbeData | null,
  configId = "cfg-1",
  phase: NodeProbePhase = "probing",
  method: NodeProbeMethod = "tcp",
) {
  return {
    name: AGENT_EVENTS.nodeProbeProgress,
    payload: {
      contract_version: CONTRACT_VERSION,
      run_id: runId,
      config_id: configId,
      phase,
      method,
      done,
      total: IDS.length,
      result,
      emitted_at: new Date().toISOString(),
    },
  } as AgentEvent;
}

function finished(
  runId: string,
  over: Partial<{
    ok: number;
    failed: number;
    cancelled: boolean;
    network: "ok" | "offline";
    configId: string;
    method: NodeProbeMethod;
    reason: "connected" | null;
  }> = {},
) {
  return {
    name: AGENT_EVENTS.nodeProbeFinished,
    payload: {
      contract_version: CONTRACT_VERSION,
      run_id: runId,
      config_id: over.configId ?? "cfg-1",
      total: IDS.length,
      ok: over.ok ?? 0,
      failed: over.failed ?? 0,
      method: over.method ?? "tcp",
      cancelled: over.cancelled ?? false,
      reason: over.reason ?? null,
      network: over.network ?? "ok",
      emitted_at: new Date().toISOString(),
    },
  } as AgentEvent;
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("useNodeProbes", () => {
  it("开始批次后先进入准备态，探测阶段最多 6 个节点处于测速中", async () => {
    const { result, emit } = harness();
    await act(async () => {
      await result.current.start("cfg-1", IDS);
    });

    expect(result.current.run).toMatchObject({
      runId: "run-1",
      done: 0,
      total: 8,
      phase: "preparing",
    });
    // 命令一发出就点亮行内「测速中」，命令返回后仍保持，不必等第一批事件。
    expect(result.current.probing.size).toBe(6);

    emit(progress("run-1", 0, null, "cfg-1", "probing", "clash"));
    expect(result.current.run).toMatchObject({ phase: "probing", method: "clash" });
    expect(result.current.probing.size).toBe(6);
    expect(result.current.probing.has("n1")).toBe(true);
    expect(result.current.probing.has("n7")).toBe(false);

    emit(progress("run-1", 1, probe("n1", 38)));
    expect(result.current.results.n1).toMatchObject({ latency_ms: 38 });
    expect(result.current.run?.done).toBe(1);
    expect(result.current.probing.has("n1")).toBe(false);
    expect(result.current.probing.has("n7")).toBe(true);
    expect(result.current.probing.size).toBe(6);
  });

  it("同一窗口发起的批次里，有缓存的行也会进入测速中（旧值降级）", async () => {
    const { result, emit } = harness({
      nodeProbeSnapshot: vi.fn(async () => ({
        configId: "cfg-1",
        results: [probe("n1", 38)],
        run: null,
      })),
    });
    await act(async () => {
      await result.current.loadSnapshot("cfg-1", IDS);
    });
    expect(result.current.results.n1).toMatchObject({ latency_ms: 38 });

    await act(async () => {
      await result.current.start("cfg-1", IDS);
    });
    emit(progress("run-1", 0, null, "cfg-1", "probing", "tcp"));
    expect(result.current.probing.has("n1")).toBe(true);
    expect(result.current.probing.size).toBe(6);
  });

  it("重开面板时仍在准备阶段：恢复 preparing，不伪造探测行", async () => {
    const { result } = harness({
      nodeProbeSnapshot: vi.fn(async () => ({
        configId: "cfg-1",
        results: [],
        run: {
          runId: "run-1",
          done: 0,
          total: 8,
          startedAt: 0,
          phase: "preparing",
          method: "tcp",
        },
      })),
    });
    await act(async () => {
      await result.current.loadSnapshot("cfg-1", IDS);
    });
    expect(result.current.run).toMatchObject({ phase: "preparing", done: 0 });
    expect(result.current.probing.size).toBe(0);
  });

  it("重开面板时按 snapshot.run 恢复进度，迟到事件不回退", async () => {
    const { result, emit } = harness({
      nodeProbeSnapshot: vi.fn(async () => ({
        configId: "cfg-1",
        results: [probe("n1", 38)],
        run: {
          runId: "run-1",
          done: 5,
          total: 8,
          startedAt: 0,
          phase: "probing",
          method: "tcp",
        },
      })),
    });

    await act(async () => {
      await result.current.loadSnapshot("cfg-1", IDS);
    });
    expect(result.current.run).toMatchObject({ runId: "run-1", done: 5 });
    expect(result.current.results.n1).toMatchObject({ latency_ms: 38 });
    expect(result.current.probing.size).toBe(6);

    // 重开后先到一条更早的迟到事件：按 done 去重，不覆盖已有结果。
    emit(progress("run-1", 3, probe("n2", 12)));
    expect(result.current.results.n2).toBeUndefined();
    expect(result.current.run?.done).toBe(5);

    emit(progress("run-1", 6, probe("n2", 12)));
    expect(result.current.results.n2).toMatchObject({ latency_ms: 12 });
    expect(result.current.run?.done).toBe(6);
  });

  it("忽略别的配置 / 别的批次的迟到事件", async () => {
    const { result, emit } = harness();
    await act(async () => {
      await result.current.start("cfg-1", IDS);
    });
    emit(progress("run-other", 2, probe("n2", 20)));
    emit(progress("run-1", 1, probe("n2", 20), "cfg-2"));
    expect(result.current.results.n2).toBeUndefined();
    expect(result.current.run?.done).toBe(0);
  });

  it("取消后回到可浏览态，并给出「已停止」汇总", async () => {
    const cancel = vi.fn(async () => ({ cancelled: true }));
    const { result, emit } = harness({ nodeProbeCancel: cancel });
    await act(async () => {
      await result.current.start("cfg-1", IDS);
    });
    emit(progress("run-1", 1, probe("n1", 38)));
    await act(async () => {
      await result.current.cancel();
    });
    expect(cancel).toHaveBeenCalledWith("run-1");

    emit(finished("run-1", { ok: 1, failed: 0, cancelled: true }));
    expect(result.current.run).toBeNull();
    expect(result.current.notice).toEqual({
      configId: "cfg-1",
      text: "已停止 · 已测 1/8",
    });
    expect(result.current.finished).toMatchObject({ cancelled: true });
    expect(result.current.results.n1).toMatchObject({ latency_ms: 38 });
  });

  it("全部失败且离线时记录 network=offline", async () => {
    const { result, emit } = harness();
    await act(async () => {
      await result.current.start("cfg-1", IDS);
    });
    emit(finished("run-1", { ok: 0, failed: 8, network: "offline" }));
    expect(result.current.finished).toMatchObject({
      network: "offline",
      failed: 8,
      method: "tcp",
    });
  });

  it("连接导致取消时说明原因", async () => {
    const { result, emit } = harness();
    await act(async () => {
      await result.current.start("cfg-1", IDS);
    });
    emit(progress("run-1", 2, probe("n1", 38)));
    emit(finished("run-1", { ok: 2, failed: 0, cancelled: true, reason: "connected" }));
    expect(result.current.finished).toMatchObject({ reason: "connected" });
    expect(result.current.notice).toEqual({
      configId: "cfg-1",
      text: "连接后测速已停止",
    });
  });

  it("快照晚到时不把已收到的进度改小", async () => {
    let resolveSnapshot!: (value: unknown) => void;
    const gate = new Promise((resolve) => {
      resolveSnapshot = resolve;
    });
    const { result, emit } = harness({
      nodeProbeSnapshot: vi.fn(() => gate),
    });
    await act(async () => {
      await result.current.start("cfg-1", IDS);
    });
    emit(progress("run-1", 6, probe("n6", 30)));
    expect(result.current.run?.done).toBe(6);

    // 事件先到、快照后到：快照的 done 更旧，不能倒退。
    let loading!: Promise<void>;
    act(() => {
      loading = result.current.loadSnapshot("cfg-1", IDS);
    });
    await act(async () => {
      resolveSnapshot({
        configId: "cfg-1",
        results: [],
        run: {
          runId: "run-1",
          done: 3,
          total: 8,
          startedAt: 0,
          phase: "preparing",
          method: "tcp",
        },
      });
      await loading;
    });
    expect(result.current.run).toMatchObject({
      done: 6,
      phase: "probing",
      method: "tcp",
    });
  });

  it("命令缺失时降级为不可用，不抛出", async () => {
    const missing = async () => {
      throw new Error("Command node_probe_snapshot not found");
    };
    const { result } = harness({ nodeProbeSnapshot: vi.fn(missing) });
    await act(async () => {
      await result.current.loadSnapshot("cfg-1", IDS);
    });
    expect(result.current.available).toBe(false);
    expect(result.current.run).toBeNull();
  });

  it("子集测速只把过滤后的 id 传给命令，分母用后端 total", async () => {
    const all = vi.fn(async () => ({
      runId: "run-1",
      configId: "cfg-1",
      total: 2,
      concurrency: 6,
      ignoredNodeIds: ["ghost"],
    }));
    const { result } = harness({ nodeProbeAll: all });
    await act(async () => {
      await result.current.start("cfg-1", ["n1", "n2", "ghost"]);
    });
    expect(all).toHaveBeenCalledWith("cfg-1", ["n1", "n2", "ghost"]);
    expect(result.current.run).toMatchObject({ total: 2, ignored: 1, done: 0 });
  });

  it("已有批次时再次开始直接拒绝", async () => {
    const all = vi.fn(async () => ({
      runId: "run-1",
      configId: "cfg-1",
      total: IDS.length,
      concurrency: 6,
      ignoredNodeIds: [],
    }));
    const { result } = harness({ nodeProbeAll: all });
    await act(async () => {
      await result.current.start("cfg-1", IDS);
    });
    await act(async () => {
      const again = await result.current.start("cfg-1", IDS);
      expect(again.ok).toBe(false);
    });
    expect(all).toHaveBeenCalledTimes(1);
  });

  it("卸载后取消订阅", async () => {
    const { unmount, bridge } = harness();
    await waitFor(() => expect(bridge.subscribe).toHaveBeenCalled());
    unmount();
    expect(bridge.subscribe).toHaveBeenCalledTimes(1);
  });
});

describe("点击后的即时反馈与失败复测", () => {
  it("命令在途时 starting 为真，行内立刻进入测速中", async () => {
    let release: (value: unknown) => void = () => {};
    const pending = new Promise((resolve) => {
      release = resolve;
    });
    const { result } = harness({ nodeProbeAll: vi.fn(() => pending) });

    let started: Promise<unknown> = Promise.resolve();
    act(() => {
      started = result.current.start("cfg-1", IDS);
    });
    expect(result.current.starting).toBe(true);
    expect(result.current.probing.size).toBe(6);

    await act(async () => {
      release({
        runId: "run-1",
        configId: "cfg-1",
        total: IDS.length,
        concurrency: 6,
        ignoredNodeIds: [],
      });
      await started;
    });
    expect(result.current.starting).toBe(false);
    expect(result.current.run?.runId).toBe("run-1");
    // 命令返回后仍保持「测速中」，等探测事件推进。
    expect(result.current.probing.size).toBe(6);
  });

  it("批量失败后逐节点直接复测，直连通的节点补上数字", async () => {
    const nodeProbe = vi.fn(async (nodeId: string) =>
      probe(nodeId, nodeId === "n1" ? 40 : null),
    );
    const { result, emit } = harness({ nodeProbe });
    await act(async () => {
      await result.current.start("cfg-1", ["n1", "n2"]);
    });

    emit(
      progress("run-1", 1, {
        ...probe("n1", null),
        error: { code: "CLASH_DELAY_FAILED", message: "no such outbound" },
      }),
    );
    emit(progress("run-1", 2, probe("n2", null)));
    emit(finished("run-1", { ok: 0, failed: 2, method: "clash" }));

    await waitFor(() => expect(nodeProbe).toHaveBeenCalledWith("n1"));
    await waitFor(() =>
      expect(result.current.results.n1).toMatchObject({
        reachable: true,
        latency_ms: 40,
      }),
    );
    expect(result.current.results.n2).toMatchObject({ reachable: false });
    expect(result.current.finished?.ok).toBe(1);
    expect(result.current.finished?.failed).toBe(1);
  });

  it("复测期间点了新批次：上一批的兜底结果被丢弃", async () => {
    let releaseRetry: (value: NodeProbeData) => void = () => {};
    const retryGate = new Promise<NodeProbeData>((resolve) => {
      releaseRetry = resolve;
    });
    const nodeProbe = vi.fn(() => retryGate);
    const { result, emit } = harness({ nodeProbe });
    await act(async () => {
      await result.current.start("cfg-1", ["n1"]);
    });
    emit(progress("run-1", 1, probe("n1", null)));
    emit(finished("run-1", { ok: 0, failed: 1, method: "clash" }));
    await waitFor(() => expect(nodeProbe).toHaveBeenCalled());

    await act(async () => {
      await result.current.start("cfg-1", ["n1"]);
    });
    await act(async () => {
      releaseRetry(probe("n1", 40));
      await Promise.resolve();
    });
    // 新批次开始后，旧批的「40ms」不能盖到新一轮上。
    expect(result.current.results.n1).toMatchObject({ reachable: false });
  });
});

describe("复测的边界", () => {
  it("TCP 批次的失败不再复测：直连已经试过了", async () => {
    const nodeProbe = vi.fn(async (nodeId: string) => probe(nodeId, 40));
    const { result, emit } = harness({ nodeProbe });
    await act(async () => {
      await result.current.start("cfg-1", ["n1"]);
    });
    emit(progress("run-1", 1, probe("n1", null)));
    emit(finished("run-1", { ok: 0, failed: 1, method: "tcp" }));

    await act(async () => {
      await Promise.resolve();
    });
    expect(nodeProbe).not.toHaveBeenCalled();
    expect(result.current.results.n1).toMatchObject({ reachable: false });
  });

  it("复测沿用 6 路限流，不一次打出全部 IPC", async () => {
    const resolvers = new Map<string, (value: NodeProbeData) => void>();
    const nodeProbe = vi.fn(
      (nodeId: string) =>
        new Promise<NodeProbeData>((resolve) => {
          resolvers.set(nodeId, resolve);
        }),
    );
    const { result, emit } = harness({ nodeProbe });
    await act(async () => {
      await result.current.start("cfg-1", IDS);
    });
    IDS.forEach((id, index) => emit(progress("run-1", index + 1, probe(id, null))));
    emit(finished("run-1", { ok: 0, failed: IDS.length, method: "clash" }));

    await waitFor(() => expect(nodeProbe).toHaveBeenCalledTimes(6));
    await act(async () => {
      resolvers.get("n1")?.(probe("n1", 40));
      await Promise.resolve();
    });
    await waitFor(() => expect(nodeProbe).toHaveBeenCalledTimes(7));

    await act(async () => {
      for (const id of IDS) {
        resolvers.get(id)?.(probe(id, 40));
        await Promise.resolve();
      }
    });
    await waitFor(() => expect(result.current.finished?.ok).toBe(IDS.length));
    expect(nodeProbe.mock.calls.length).toBeLessThanOrEqual(IDS.length);
  });

  it("外部逐节点探测可以点亮再清掉行内的测速中", () => {
    const { result } = harness();
    act(() => {
      result.current.markProbing(["n1"]);
    });
    expect(result.current.probing.has("n1")).toBe(true);
    act(() => {
      result.current.markProbing([]);
    });
    expect(result.current.probing.size).toBe(0);
  });
});
