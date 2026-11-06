import { beforeEach, describe, expect, it, vi } from "vitest";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));

import { TauriAgentBridge } from "./tauriBridge";

beforeEach(() => {
  invoke.mockReset();
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
          reachable: true,
          latency_ms: 38,
          probe_method: "clash_delay",
          checked_at: 1700000000000,
          error: null,
        },
        { node_id: "n2", reachable: false, error: { code: "PROBE_TIMEOUT" } },
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
          reachable: true,
          latency_ms: 38,
          probe_method: "clash_delay",
          checked_at: 1700000000000,
          error: null,
        },
        {
          node_id: "n2",
          reachable: false,
          latency_ms: null,
          probe_method: "tcp",
          checked_at: 0,
          error: { code: "PROBE_TIMEOUT", message: "" },
        },
      ],
      run: { runId: "run-1", done: 12, total: 23, startedAt: 1700000000000, phase: "probing", method: "tcp" },
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
