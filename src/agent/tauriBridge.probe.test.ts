import { beforeEach, describe, expect, it, vi } from "vitest";

const { invoke, handlers } = vi.hoisted(() => ({
  invoke: vi.fn(),
  handlers: new Map<string, Array<(event: { payload: unknown }) => void>>(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, cb: (event: { payload: unknown }) => void) => {
    const list = handlers.get(name) ?? [];
    list.push(cb);
    handlers.set(name, list);
    return () => {};
  }),
}));

import { AGENT_EVENTS } from "./protocol";
import type { AgentEvent } from "./protocol";
import { TauriAgentBridge } from "./tauriBridge";

/** 每个桥实例都会注册一份监听；测试里对同名事件全部投递，等价于一次真实事件。 */
function emitEvent(name: string, payload: unknown) {
  for (const cb of handlers.get(name) ?? []) cb({ payload });
}

/** 等本实例的监听注册好：反复投递直到订阅者收到，不依赖微任务时序。 */
async function emitUntilSeen(
  name: string,
  payload: unknown,
  seen: AgentEvent[],
): Promise<void> {
  await vi.waitFor(() => {
    emitEvent(name, payload);
    expect(seen.length).toBeGreaterThan(0);
  });
}

beforeEach(() => {
  invoke.mockReset();
  handlers.clear();
});

describe("批量测速命令映射", () => {
  it("node_probe_all 传 configId，返回 camelCase", async () => {
    invoke.mockResolvedValueOnce({
      run_id: "run-1",
      config_id: "cfg-1",
      total: 23,
      concurrency: 6,
    });
    const bridge = new TauriAgentBridge();
    await expect(bridge.nodeProbeAll("cfg-1")).resolves.toEqual({
      runId: "run-1",
      configId: "cfg-1",
      total: 23,
      concurrency: 6,
      ignoredNodeIds: [],
    });
    expect(invoke).toHaveBeenCalledWith("node_probe_all", { configId: "cfg-1" });
  });

  it("省略 configId 时用 active 配置，不带参数", async () => {
    invoke.mockResolvedValueOnce({});
    const bridge = new TauriAgentBridge();
    await expect(bridge.nodeProbeAll()).resolves.toEqual({
      runId: "",
      configId: "",
      total: 0,
      concurrency: 0,
      ignoredNodeIds: [],
    });
    expect(invoke).toHaveBeenCalledWith("node_probe_all", undefined);
  });

  it("node_probe_all 带子集时只传 nodeIds，并透传 ignored_node_ids", async () => {
    invoke.mockResolvedValueOnce({
      run_id: "run-2",
      config_id: "cfg-1",
      total: 2,
      concurrency: 6,
      ignored_node_ids: ["ghost", 7],
    });
    const bridge = new TauriAgentBridge();
    await expect(bridge.nodeProbeAll("cfg-1", ["n1", "n2", "ghost"])).resolves.toEqual({
      runId: "run-2",
      configId: "cfg-1",
      total: 2,
      concurrency: 6,
      ignoredNodeIds: ["ghost"],
    });
    expect(invoke).toHaveBeenCalledWith("node_probe_all", {
      configId: "cfg-1",
      nodeIds: ["n1", "n2", "ghost"],
    });
  });

  it("node_probe_cancel 原样返回，缺字段按未取消", async () => {
    invoke.mockResolvedValueOnce({ cancelled: true });
    const bridge = new TauriAgentBridge();
    await expect(bridge.nodeProbeCancel("run-1")).resolves.toEqual({ cancelled: true });
    expect(invoke).toHaveBeenCalledWith("node_probe_cancel", { runId: "run-1" });

    invoke.mockResolvedValueOnce({});
    await expect(bridge.nodeProbeCancel("run-1")).resolves.toEqual({ cancelled: false });
  });

  it("node_probe_snapshot 归一结果与运行态，坏数据不穿透到界面", async () => {
    invoke.mockResolvedValueOnce({
      config_id: "cfg-1",
      results: [
        {
          node_id: "n1",
          status: "ok",
          reachable: true,
          latency_ms: 38,
          probe_method: "clash_delay",
          checked_at: 1700000000000,
          error: null,
        },
        { node_id: "n2", reachable: false, error: { code: "PROBE_TIMEOUT" } },
        // 没测成：reachable 是 null，不能收口成 false。
        {
          node_id: "n3",
          status: "untested",
          reachable: null,
          probe_method: "none",
          checked_at: 0,
          error: null,
        },
        { node_id: "", reachable: true },
        null,
      ],
      run: { run_id: "run-1", done: 12, total: 23, started_at: 1700000000000 },
    });
    const bridge = new TauriAgentBridge();
    await expect(bridge.nodeProbeSnapshot("cfg-1")).resolves.toEqual({
      configId: "cfg-1",
      results: [
        {
          node_id: "n1",
          status: "ok",
          reachable: true,
          latency_ms: 38,
          probe_method: "clash_delay",
          checked_at: 1700000000000,
          error: null,
        },
        {
          node_id: "n2",
          status: "unreachable",
          reachable: false,
          latency_ms: null,
          probe_method: "none",
          checked_at: 0,
          error: { code: "PROBE_TIMEOUT", message: "" },
        },
        {
          node_id: "n3",
          status: "untested",
          reachable: null,
          latency_ms: null,
          probe_method: "none",
          checked_at: 0,
          error: null,
        },
      ],
      run: { runId: "run-1", done: 12, total: 23, startedAt: 1700000000000, phase: "probing", method: "none" },
    });
    expect(invoke).toHaveBeenCalledWith("node_probe_snapshot", { configId: "cfg-1" });
  });

  it("run 为空或字段不可信时按「没有批次在跑」处理", async () => {
    invoke.mockResolvedValueOnce({ config_id: "cfg-1", results: [], run: null });
    const bridge = new TauriAgentBridge();
    await expect(bridge.nodeProbeSnapshot("cfg-1")).resolves.toMatchObject({ run: null });

    invoke.mockResolvedValueOnce({ config_id: "cfg-1", run: { done: 3 } });
    await expect(bridge.nodeProbeSnapshot("cfg-1")).resolves.toMatchObject({ run: null });
  });
});

describe("三态归一：status 优先于旧字段", () => {
  async function normalizeOne(result: Record<string, unknown>) {
    invoke.mockResolvedValueOnce({
      config_id: "cfg-1",
      results: [result],
      run: null,
    });
    const snapshot = await new TauriAgentBridge().nodeProbeSnapshot("cfg-1");
    return snapshot.results[0];
  }

  it("status=ok + reachable=false：按 status 推导 reachable=true", async () => {
    const entry = await normalizeOne({
      node_id: "n1",
      status: "ok",
      reachable: false,
      latency_ms: 38,
      probe_method: "clash_delay",
      checked_at: 1700000000000,
      error: null,
    });
    expect(entry).toMatchObject({ status: "ok", reachable: true });
  });

  it("status=untested + reachable=false：reachable 归 null，不收口成 false", async () => {
    const entry = await normalizeOne({
      node_id: "n1",
      status: "untested",
      reachable: false,
      probe_method: "none",
      checked_at: 0,
      error: null,
    });
    expect(entry).toMatchObject({ status: "untested", reachable: null });
  });

  it("status 缺失且 reachable 不可用：按 untested 处理", async () => {
    const entry = await normalizeOne({ node_id: "n1", reachable: null });
    expect(entry).toMatchObject({ status: "untested", reachable: null });
  });

  it("status 缺失 + reachable=true：按 ok 处理，不塌成 untested", async () => {
    const entry = await normalizeOne({ node_id: "n1", reachable: true, latency_ms: 30 });
    expect(entry).toMatchObject({ status: "ok", reachable: true, latency_ms: 30 });
  });

  it("status 缺失 + reachable=false：按 unreachable 处理，不塌成 untested", async () => {
    const entry = await normalizeOne({ node_id: "n1", reachable: false });
    expect(entry).toMatchObject({ status: "unreachable", reachable: false });
  });

  it("status 未知且缺 reachable：untested / reachable null / method none", async () => {
    const entry = await normalizeOne({
      node_id: "n1",
      status: "weird",
      probe_method: "tcp",
      checked_at: 0,
      error: null,
    });
    expect(entry).toMatchObject({
      status: "untested",
      reachable: null,
      probe_method: "none",
    });
  });
});

describe("单节点与 progress 事件走同一套归一化", () => {
  it("node_probe 返回矛盾字段时按 status 纠正 reachable", async () => {
    invoke.mockResolvedValueOnce({
      node_id: "n1",
      status: "ok",
      reachable: false,
      latency_ms: 42,
      probe_method: "clash_delay",
      checked_at: 1700000000000,
      error: null,
    });
    await expect(new TauriAgentBridge().nodeProbe("n1")).resolves.toMatchObject({
      node_id: "n1",
      status: "ok",
      reachable: true,
      latency_ms: 42,
    });
  });

  it("node_probe 结果没有 node_id 时抛错，不伪造节点", async () => {
    invoke.mockResolvedValueOnce({ status: "ok", reachable: true });
    await expect(new TauriAgentBridge().nodeProbe("n1")).rejects.toMatchObject({
      code: "PROBE_RESULT_INVALID",
    });
  });

  it("progress 事件里的 result 同样被纠正", async () => {
    const bridge = new TauriAgentBridge();
    const seen: AgentEvent[] = [];
    bridge.subscribe((event) => seen.push(event));

    await emitUntilSeen(
      AGENT_EVENTS.nodeProbeProgress,
      {
        run_id: "run-1",
        config_id: "cfg-1",
        done: 1,
        total: 2,
        result: { node_id: "n1", status: "untested", reachable: true },
      },
      seen,
    );

    const payload = seen[0].payload as unknown as { result: Record<string, unknown> };
    expect(payload.result).toMatchObject({ status: "untested", reachable: null });
  });

  it("progress 的 result 归一失败时丢弃，按阶段事件处理", async () => {
    const bridge = new TauriAgentBridge();
    const seen: AgentEvent[] = [];
    bridge.subscribe((event) => seen.push(event));

    await emitUntilSeen(
      AGENT_EVENTS.nodeProbeProgress,
      {
        run_id: "run-1",
        config_id: "cfg-1",
        done: 1,
        total: 2,
        result: { status: "ok", reachable: true },
      },
      seen,
    );

    const payload = seen[0].payload as unknown as { result: unknown };
    expect(payload.result).toBeNull();
  });
});
