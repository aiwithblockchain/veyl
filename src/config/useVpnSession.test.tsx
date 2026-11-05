/** @vitest-environment jsdom */
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentBridge } from "../agent/bridge";
import type {
  AgentEvent,
  RuntimeSnapshot,
  RuntimeState,
} from "../agent/protocol";
import { AGENT_EVENTS, CONTRACT_VERSION } from "../agent/protocol";
import { useVpnSession } from "./useVpnSession";

afterEach(cleanup);

function stateEvent(from: RuntimeState, to: RuntimeState): AgentEvent {
  return {
    name: AGENT_EVENTS.runtimeStateChanged,
    payload: {
      contract_version: CONTRACT_VERSION,
      from,
      to,
      event: "stopped",
      pid: null,
      upstream_version: null,
      reason: null,
      error: null,
      snapshot: {} as RuntimeSnapshot,
      emitted_at: "",
    },
  };
}

function healthEvent(): AgentEvent {
  return {
    name: AGENT_EVENTS.runtimeHealthChanged,
    payload: {
      contract_version: CONTRACT_VERSION,
      health: {
        contract_version: CONTRACT_VERSION,
        process: true,
        clash_api: true,
        data_plane: true,
        exit_ip: "203.0.113.9",
        consecutive_failures: 0,
        checked_at: "",
      },
      emitted_at: "",
    },
  };
}

/** 快照永远不回来，顺便数一数被拉了几次。 */
function makeBridge() {
  const bus: { emit: ((event: AgentEvent) => void) | null } = { emit: null };
  const calls = { snapshots: 0 };
  const bridge = {
    subscribe: (listener: (event: AgentEvent) => void) => {
      bus.emit = listener;
      return () => {
        bus.emit = null;
      };
    },
    configList: async () => ({ configs: [], active_config_id: null }),
    getRuntimeSnapshot: () => {
      calls.snapshots += 1;
      return new Promise<RuntimeSnapshot | null>(() => {});
    },
  } as unknown as AgentBridge;
  return { bridge, bus, calls };
}

describe("useVpnSession 状态迁移", () => {
  it("收到 runtimeStateChanged 时 connection 立即切换，不等快照", () => {
    const { bridge, bus } = makeBridge();
    const { result } = renderHook(() => useVpnSession(bridge, false));
    expect(result.current.connection).toBe("idle");

    act(() => bus.emit?.(stateEvent("idle", "starting")));
    expect(result.current.connection).toBe("starting");

    act(() => bus.emit?.(stateEvent("starting", "running")));
    expect(result.current.connection).toBe("connected");

    act(() => bus.emit?.(stateEvent("running", "failed")));
    expect(result.current.connection).toBe("idle");
  });

  it("健康事件不拉全量快照，只有状态迁移才拉", async () => {
    const { bridge, bus, calls } = makeBridge();
    renderHook(() => useVpnSession(bridge, false));
    // 挂载时 refreshReal 自己拉一次，之后的计数以它为基线。
    await waitFor(() => expect(calls.snapshots).toBe(1));

    act(() => bus.emit?.(healthEvent()));
    expect(calls.snapshots).toBe(1);

    act(() => bus.emit?.(healthEvent()));
    expect(calls.snapshots).toBe(1);

    act(() => bus.emit?.(stateEvent("idle", "starting")));
    expect(calls.snapshots).toBe(2);
  });
});
