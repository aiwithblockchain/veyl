/** @vitest-environment jsdom */
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentBridge } from "../agent/bridge";
import type {
  AgentEvent,
  ConfigDetail,
  ConfigSummary,
  Layout,
  RuntimeSnapshot,
  RuntimeState,
} from "../agent/protocol";
import { AGENT_EVENTS, CONTRACT_VERSION } from "../agent/protocol";
import { isHelperPermissionReason, useVpnSession } from "./useVpnSession";
import type { ActionResult } from "./useVpnSession";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

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

const CONFIG_ID = "cfg_1";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function startDetail(mode: "tun" | "system_proxy"): ConfigDetail {
  return {
    config_id: CONFIG_ID,
    name: "测试配置",
    connect_mode: mode,
    routing_mode: "proxy_all",
    node_count: 1,
    listen_port: null,
    is_active: true,
    current_node_id: "node_1",
    created_at: 0,
    updated_at: 0,
    last_used_at: null,
    nodes: [
      {
        node_id: "node_1",
        name: "东京 01",
        server: "203.0.113.1",
        port: 8388,
        method: "aes-128-gcm",
        protocol: "shadowsocks",
        source: "seed",
        created_at: 0,
      },
    ],
    dns: { mode: "auto", local: [], remote: [] },
    tun_excludes: [],
    layout: null,
    layout_revision: null,
  };
}

function startSummary(mode: "tun" | "system_proxy"): ConfigSummary {
  const detail = startDetail(mode);
  return {
    config_id: detail.config_id,
    name: detail.name,
    connect_mode: detail.connect_mode,
    routing_mode: detail.routing_mode,
    node_count: detail.node_count,
    listen_port: detail.listen_port,
    is_active: detail.is_active,
    current_node_id: detail.current_node_id,
    created_at: detail.created_at,
    updated_at: detail.updated_at,
    last_used_at: detail.last_used_at,
  };
}

function makeStartBridge(
  mode: "tun" | "system_proxy",
  {
    needsAdmin = false,
    runtimeStart,
  }: { needsAdmin?: boolean; runtimeStart?: () => Promise<unknown> } = {},
) {
  return {
    subscribe: () => () => {},
    configList: async () => ({ configs: [startSummary(mode)], active_config_id: CONFIG_ID }),
    configDetail: async () => startDetail(mode),
    getRuntimeSnapshot: async () => null,
    runtimeStart: vi.fn(runtimeStart ?? (async () => ({}))),
    runtimeStop: vi.fn(async () => ({})),
    tunHelperInfo: vi.fn(async () => ({
      runningBuild: "2026.11.1",
      expectedBuild: "2026.11.1",
      stale: needsAdmin,
      state: needsAdmin ? ("stale" as const) : ("running" as const),
      needsAdminRestart: needsAdmin,
    })),
  } as unknown as AgentBridge;
}

/** 拿得到事件回调的启动桥，用来模拟 start 挂起期间的后端事件。 */
function makeEventedStartBridge(
  mode: "tun" | "system_proxy",
  options: { needsAdmin?: boolean; runtimeStart?: () => Promise<unknown> } = {},
) {
  const bridge = makeStartBridge(mode, options);
  let emit: ((event: AgentEvent) => void) | null = null;
  (
    bridge as unknown as {
      subscribe: (listener: (event: AgentEvent) => void) => () => void;
    }
  ).subscribe = (listener) => {
    emit = listener;
    return () => {
      emit = null;
    };
  };
  return { bridge, emit: (event: AgentEvent) => emit?.(event) };
}

describe("连接前告知后台组件授权", () => {
  it("接管全部流量需要授权时，准备提示先出现并一直显示到连接返回", async () => {
    const gate = deferred<unknown>();
    const bridge = makeStartBridge("tun", {
      needsAdmin: true,
      runtimeStart: () => gate.promise,
    });
    const { result } = renderHook(() => useVpnSession(bridge, false));
    await waitFor(() => expect(result.current.activeConfig).not.toBeNull());

    let pending!: Promise<ActionResult>;
    act(() => {
      pending = result.current.start();
    });

    // 后端这一步会卡在系统弹窗上：弹窗期间提示必须一直在。
    await waitFor(() => expect(result.current.preparingHelper).toBe(true));
    expect(bridge.runtimeStart).toHaveBeenCalledTimes(1);

    await act(async () => {
      gate.resolve({});
      await pending;
    });
    expect(result.current.preparingHelper).toBe(false);
  });

  it("不需要授权时不显示准备提示", async () => {
    const bridge = makeStartBridge("tun");
    const { result } = renderHook(() => useVpnSession(bridge, false));
    await waitFor(() => expect(result.current.activeConfig).not.toBeNull());

    let result_: ActionResult | undefined;
    await act(async () => {
      result_ = await result.current.start();
    });

    expect(result_?.ok).toBe(true);
    expect(bridge.tunHelperInfo).toHaveBeenCalledTimes(1);
    expect(result.current.preparingHelper).toBe(false);
  });

  it("代理模式不查后台组件，也不显示准备提示", async () => {
    const bridge = makeStartBridge("system_proxy", { needsAdmin: true });
    const { result } = renderHook(() => useVpnSession(bridge, false));
    await waitFor(() => expect(result.current.activeConfig).not.toBeNull());

    await act(async () => {
      await result.current.start();
    });

    expect(bridge.tunHelperInfo).not.toHaveBeenCalled();
    expect(result.current.preparingHelper).toBe(false);
  });

  it("需要管理员授权时把原因交给界面弹引导", async () => {
    const bridge = makeStartBridge("tun", {
      needsAdmin: true,
      runtimeStart: async () => {
        throw {
          code: "PRECONDITION_FAILED",
          message: "需要你在「系统设置 › 登录项与扩展」里允许 Veyl 的后台助手",
          details: { reason: "tun_denied" },
        };
      },
    });
    const { result } = renderHook(() => useVpnSession(bridge, false));
    await waitFor(() => expect(result.current.activeConfig).not.toBeNull());

    let result_: ActionResult | undefined;
    await act(async () => {
      result_ = await result.current.start();
    });

    expect(result_).toEqual({ ok: false, reason: "tun_denied" });
    expect(result.current.preparingHelper).toBe(false);
    expect(result.current.connection).toBe("idle");
  });

  it("取消管理员授权只给普通重试提示，不弹去系统设置的引导", async () => {
    const bridge = makeStartBridge("tun", {
      runtimeStart: async () => {
        throw {
          code: "PRECONDITION_FAILED",
          message: "需要管理员授权",
          details: { reason: "helper_admin_cancelled" },
        };
      },
    });
    const { result } = renderHook(() => useVpnSession(bridge, false));
    await waitFor(() => expect(result.current.activeConfig).not.toBeNull());

    let result_: ActionResult | undefined;
    await act(async () => {
      result_ = await result.current.start();
    });

    expect(result_).toEqual({
      ok: false,
      message: "这次没有授权，可以再试一次。",
      reason: "helper_admin_cancelled",
    });
    expect(isHelperPermissionReason("helper_admin_cancelled")).toBe(false);
  });

  it("用户取消授权只给普通重试提示，不弹去系统设置的引导", async () => {
    const bridge = makeStartBridge("tun", {
      runtimeStart: async () => {
        throw {
          code: "USER_CANCELLED",
          message: "已取消",
          details: { reason: "user_cancelled" },
        };
      },
    });
    const { result } = renderHook(() => useVpnSession(bridge, false));
    await waitFor(() => expect(result.current.activeConfig).not.toBeNull());

    let result_: ActionResult | undefined;
    await act(async () => {
      result_ = await result.current.start();
    });

    expect(result_).toEqual({
      ok: false,
      message: "这次没有授权，可以再试一次。",
      reason: "user_cancelled",
    });
    expect(isHelperPermissionReason("user_cancelled")).toBe(false);
  });

  it("组件缺失不算权限问题：原因照旧带回，但不弹引导", async () => {
    const bridge = makeStartBridge("tun", {
      runtimeStart: async () => {
        throw {
          code: "PRECONDITION_FAILED",
          message: "安装后台助手失败",
          details: { reason: "helper_missing" },
        };
      },
    });
    const { result } = renderHook(() => useVpnSession(bridge, false));
    await waitFor(() => expect(result.current.activeConfig).not.toBeNull());

    let result_: ActionResult | undefined;
    await act(async () => {
      result_ = await result.current.start();
    });

    // 后端给的原因和文案都要原样到界面：它决定用户该做什么，不能被换成「去点允许」。
    expect(result_).toEqual({
      ok: false,
      message: "安装后台助手失败",
      reason: "helper_missing",
    });
    expect(isHelperPermissionReason("helper_missing")).toBe(false);
    expect(isHelperPermissionReason("dev_unbundled")).toBe(false);
    expect(isHelperPermissionReason("tun_denied")).toBe(true);
  });

  it("文件校验失败仍然只报文案，不弹引导", async () => {
    const bridge = makeStartBridge("tun", {
      runtimeStart: async () => {
        throw {
          code: "PRECONDITION_FAILED",
          message: "后台组件文件不可用，请重新安装 Veyl。代理模式与直连仍可用。",
          details: { reason: "helper_file_invalid" },
        };
      },
    });
    const { result } = renderHook(() => useVpnSession(bridge, false));
    await waitFor(() => expect(result.current.activeConfig).not.toBeNull());

    let result_: ActionResult | undefined;
    await act(async () => {
      result_ = await result.current.start();
    });

    expect(result_?.ok).toBe(false);
    expect(result_?.reason).toBe("helper_file_invalid");
    expect(result_?.message).toContain("重新安装");
  });
});

describe("点击后立即反馈", () => {
  function helperInfo(needsAdmin: boolean) {
    return {
      runningBuild: "2026.11.1",
      expectedBuild: "2026.11.1",
      stale: needsAdmin,
      state: needsAdmin ? ("stale" as const) : ("running" as const),
      needsAdminRestart: needsAdmin,
    };
  }

  it("点击那一刻就进入连接中，不等后台组件查询返回", async () => {
    const helperGate = deferred<unknown>();
    const bridge = makeStartBridge("tun", { needsAdmin: true });
    (bridge as unknown as { tunHelperInfo: unknown }).tunHelperInfo = vi.fn(
      () => helperGate.promise,
    );

    const { result } = renderHook(() => useVpnSession(bridge, false));
    await waitFor(() => expect(result.current.activeConfig).not.toBeNull());

    let pending!: Promise<ActionResult>;
    act(() => {
      pending = result.current.start();
    });

    // 同步断言：这次调用返回时中间态就应该在了，遮罩下一帧可见。
    expect(result.current.connection).toBe("starting");
    // 授权文案要等查询结果，但「已经点到了」不依赖它。
    expect(result.current.preparingHelper).toBe(false);
    expect(result.current.checkingHelper).toBe(true);
    expect(bridge.runtimeStart).not.toHaveBeenCalled();

    await act(async () => {
      helperGate.resolve(helperInfo(true));
      await pending;
    });
    expect(result.current.checkingHelper).toBe(false);
    expect(bridge.runtimeStart).toHaveBeenCalledTimes(1);
    expect(result.current.connection).toBe("connected");
  });

  it("中间态里再点一次不会发起第二次连接", async () => {
    const gate = deferred<unknown>();
    const bridge = makeStartBridge("tun", { runtimeStart: () => gate.promise });

    const { result } = renderHook(() => useVpnSession(bridge, false));
    await waitFor(() => expect(result.current.activeConfig).not.toBeNull());

    let first!: Promise<ActionResult>;
    let second!: Promise<ActionResult>;
    let secondOutcome: ActionResult | undefined;
    act(() => {
      first = result.current.start();
      second = result.current.start().then((value) => (secondOutcome = value));
    });
    await waitFor(() => expect(bridge.runtimeStart).toHaveBeenCalledTimes(1));

    await act(async () => {
      gate.resolve({});
      await first;
      await second;
    });
    expect(bridge.runtimeStart).toHaveBeenCalledTimes(1);
    expect(result.current.connection).toBe("connected");
    // 重入按成功返回、不带 message：调用方 showActionResult 不会弹成功提示。
    expect(secondOutcome).toEqual({ ok: true });
  });

  it("后台组件查询很慢时保持中间态，查询完再继续连接", async () => {
    const helperGate = deferred<unknown>();
    const gate = deferred<unknown>();
    const bridge = makeStartBridge("tun", {
      needsAdmin: true,
      runtimeStart: () => gate.promise,
    });
    (bridge as unknown as { tunHelperInfo: unknown }).tunHelperInfo = vi.fn(
      () => helperGate.promise,
    );

    const { result } = renderHook(() => useVpnSession(bridge, false));
    await waitFor(() => expect(result.current.activeConfig).not.toBeNull());

    let pending!: Promise<ActionResult>;
    act(() => {
      pending = result.current.start();
    });
    expect(result.current.connection).toBe("starting");
    expect(result.current.checkingHelper).toBe(true);

    await act(async () => {
      helperGate.resolve(helperInfo(true));
    });
    await waitFor(() => expect(result.current.preparingHelper).toBe(true));
    expect(result.current.checkingHelper).toBe(false);
    expect(result.current.connection).toBe("starting");
    await waitFor(() => expect(bridge.runtimeStart).toHaveBeenCalledTimes(1));

    await act(async () => {
      gate.resolve({});
      await pending;
    });
    expect(result.current.checkingHelper).toBe(false);
    expect(result.current.preparingHelper).toBe(false);
  });

  it("前置检查之后的启动失败回到未连接，不会卡在连接中", async () => {
    const helperGate = deferred<unknown>();
    const bridge = makeStartBridge("tun", {
      needsAdmin: true,
      runtimeStart: async () => {
        throw { code: "INTERNAL", message: "启动失败" };
      },
    });
    (bridge as unknown as { tunHelperInfo: unknown }).tunHelperInfo = vi.fn(
      () => helperGate.promise,
    );

    const { result } = renderHook(() => useVpnSession(bridge, false));
    await waitFor(() => expect(result.current.activeConfig).not.toBeNull());

    let pending!: Promise<ActionResult>;
    let outcome: ActionResult | undefined;
    act(() => {
      pending = result.current.start().then((value) => (outcome = value));
    });
    expect(result.current.connection).toBe("starting");

    await act(async () => {
      helperGate.resolve(helperInfo(true));
      await pending;
    });

    expect(outcome?.ok).toBe(false);
    expect(result.current.connection).toBe("idle");
    expect(result.current.preparingHelper).toBe(false);

    // 闸必须在 finally 里释放：失败后还能再发起一次。
    let retry: ActionResult | undefined;
    await act(async () => {
      retry = await result.current.start();
    });
    expect(retry?.ok).toBe(false);
    expect(bridge.runtimeStart).toHaveBeenCalledTimes(2);
    expect(result.current.connection).toBe("idle");
  });

  it("后台组件查询期间取消：不发起连接，状态停在 idle", async () => {
    const helperGate = deferred<unknown>();
    const bridge = makeStartBridge("tun", { needsAdmin: true });
    (bridge as unknown as { tunHelperInfo: unknown }).tunHelperInfo = vi.fn(
      () => helperGate.promise,
    );

    const { result } = renderHook(() => useVpnSession(bridge, false));
    await waitFor(() => expect(result.current.activeConfig).not.toBeNull());

    let pending!: Promise<ActionResult>;
    let outcome: ActionResult | undefined;
    act(() => {
      pending = result.current.start().then((value) => (outcome = value));
    });
    expect(result.current.connection).toBe("starting");
    expect(result.current.checkingHelper).toBe(true);

    let stopped: ActionResult | undefined;
    await act(async () => {
      stopped = await result.current.stop();
    });
    expect(stopped?.ok).toBe(true);
    expect(result.current.connection).toBe("idle");

    await act(async () => {
      helperGate.resolve(helperInfo(true));
      await pending;
    });

    // 主动取消不是失败：不报错，也不再发起连接。
    expect(outcome).toEqual({ ok: true });
    expect(bridge.runtimeStart).not.toHaveBeenCalled();
    expect(result.current.connection).toBe("idle");
    expect(result.current.checkingHelper).toBe(false);
  });

  it("runtimeStart 进行中取消：补一次 runtimeStop，最终 idle", async () => {
    const gate = deferred<unknown>();
    const bridge = makeStartBridge("tun", { runtimeStart: () => gate.promise });

    const { result } = renderHook(() => useVpnSession(bridge, false));
    await waitFor(() => expect(result.current.activeConfig).not.toBeNull());

    let pending!: Promise<ActionResult>;
    let outcome: ActionResult | undefined;
    act(() => {
      pending = result.current.start().then((value) => (outcome = value));
    });
    await waitFor(() => expect(bridge.runtimeStart).toHaveBeenCalledTimes(1));

    await act(async () => {
      await result.current.stop();
    });
    expect(result.current.connection).toBe("idle");

    await act(async () => {
      gate.resolve({});
      await pending;
    });

    // 用户 stop 一次 + 这轮 start 补一次收尾，运行时不会留在跑着的状态。
    expect(bridge.runtimeStop).toHaveBeenCalledTimes(2);
    expect(outcome).toEqual({ ok: true });
    expect(result.current.connection).toBe("idle");
  });

  it("后台组件查询本身失败时照旧连接，不会把中间态挂住", async () => {
    const bridge = makeStartBridge("tun");
    (bridge as unknown as { tunHelperInfo: unknown }).tunHelperInfo = vi.fn(async () => {
      throw new Error("unknown command tun_helper_info");
    });

    const { result } = renderHook(() => useVpnSession(bridge, false));
    await waitFor(() => expect(result.current.activeConfig).not.toBeNull());

    let res: ActionResult | undefined;
    await act(async () => {
      res = await result.current.start();
    });

    expect(res?.ok).toBe(true);
    expect(bridge.runtimeStart).toHaveBeenCalledTimes(1);
    expect(result.current.connection).toBe("connected");
  });

  it("runtimeStart 挂起（日志里的 28 秒）后成功，最终仍是 connected", async () => {
    const gate = deferred<unknown>();
    const bridge = makeStartBridge("tun", { runtimeStart: () => gate.promise });

    const { result } = renderHook(() => useVpnSession(bridge, false));
    await waitFor(() => expect(result.current.activeConfig).not.toBeNull());

    let pending!: Promise<ActionResult>;
    act(() => {
      pending = result.current.start();
    });
    await waitFor(() => expect(bridge.runtimeStart).toHaveBeenCalledTimes(1));
    // 这 28 秒里没有状态事件，界面应一直停在 starting，不能被别的快照推回去。
    expect(result.current.connection).toBe("starting");

    await act(async () => {
      gate.resolve({});
      await pending;
    });
    expect(result.current.connection).toBe("connected");
    expect(result.current.connectedConfigId).toBe(CONFIG_ID);
  });

  it("runtimeStart 挂起期间收到 failed 状态事件，成功后仍回到 connected", async () => {
    const gate = deferred<unknown>();
    const { bridge, emit } = makeEventedStartBridge("tun", {
      runtimeStart: () => gate.promise,
    });

    const { result } = renderHook(() => useVpnSession(bridge, false));
    await waitFor(() => expect(result.current.activeConfig).not.toBeNull());

    let pending!: Promise<ActionResult>;
    let outcome: ActionResult | undefined;
    act(() => {
      pending = result.current.start().then((value) => (outcome = value));
    });
    await waitFor(() => expect(bridge.runtimeStart).toHaveBeenCalledTimes(1));

    // 后端在挂起期间先报了一个非 running 的状态。
    act(() => {
      emit(stateEvent("starting", "failed"));
    });
    await waitFor(() => expect(result.current.connection).toBe("idle"));

    await act(async () => {
      gate.resolve({});
      await pending;
    });
    // runtimeStart 最终成功，说明连接是成功的，不能被中间事件留在未连接。
    expect(outcome).toEqual({ ok: true, connected: true });
    expect(result.current.connection).toBe("connected");
  });
});

describe("mock 启动", () => {
  it("点下去立刻进入 starting，700ms 后 connected", async () => {
    localStorage.setItem(
      "veyl.configs.mock.v1",
      JSON.stringify({
        configs: [startDetail("system_proxy")],
        activeId: CONFIG_ID,
      }),
    );
    const bridge = makeStartBridge("system_proxy");
    const { result } = renderHook(() => useVpnSession(bridge, true));
    await waitFor(() => expect(result.current.activeConfig).not.toBeNull());

    let pending!: Promise<ActionResult>;
    act(() => {
      pending = result.current.start();
    });
    // 不依赖任何 await：mock 分支也必须先给出中间态。
    expect(result.current.connection).toBe("starting");
    expect(result.current.connectedConfigId).toBeNull();

    await act(async () => {
      await pending;
    });
    await waitFor(() => expect(result.current.connection).toBe("connected"), {
      timeout: 1500,
    });
    expect(result.current.connectedConfigId).toBe(CONFIG_ID);
    expect(bridge.runtimeStart).toHaveBeenCalledTimes(1);
  });
});

describe("断开的状态收尾", () => {
  async function connectedHook(bridge: AgentBridge) {
    const utils = renderHook(() => useVpnSession(bridge, false));
    await waitFor(() => expect(utils.result.current.activeConfig).not.toBeNull());
    await act(async () => {
      await utils.result.current.start();
    });
    expect(utils.result.current.connection).toBe("connected");
    return utils;
  }

  it("断开成功后进入 idle，并标记 stopped", async () => {
    const bridge = makeStartBridge("system_proxy");
    const { result } = await connectedHook(bridge);

    let outcome: ActionResult | undefined;
    await act(async () => {
      outcome = await result.current.stop();
    });

    expect(outcome).toEqual({ ok: true, stopped: true });
    expect(result.current.connection).toBe("idle");
    expect(result.current.connectedConfigId).toBeNull();
  });

  it("断开期间收到迟到的 running 事件，完成后仍是 idle", async () => {
    const stopGate = deferred<void>();
    const { bridge, emit } = makeEventedStartBridge("system_proxy");
    const { result } = await connectedHook(bridge);
    (bridge as unknown as { runtimeStop: unknown }).runtimeStop = vi.fn(
      () => stopGate.promise,
    );

    let pending!: Promise<ActionResult>;
    let outcome: ActionResult | undefined;
    act(() => {
      pending = result.current.stop().then((value) => (outcome = value));
    });
    await waitFor(() => expect(bridge.runtimeStop).toHaveBeenCalledTimes(1));

    act(() => {
      emit(stateEvent("stopping", "running"));
    });
    // 断开中的迟到在线事件被忽略，界面继续停在「正在断开」。
    expect(result.current.connection).toBe("stopping");

    await act(async () => {
      stopGate.resolve();
      await pending;
    });
    expect(outcome).toEqual({ ok: true, stopped: true });
    expect(result.current.connection).toBe("idle");
  });

  it("断开失败保持已连接并报错", async () => {
    const bridge = makeStartBridge("system_proxy");
    const { result } = await connectedHook(bridge);
    (bridge as unknown as { runtimeStop: unknown }).runtimeStop = vi.fn(async () => {
      throw { code: "INTERNAL", message: "断开失败" };
    });

    let outcome: ActionResult | undefined;
    await act(async () => {
      outcome = await result.current.stop();
    });

    expect(outcome).toEqual({ ok: false, message: "断开失败" });
    expect(result.current.connection).toBe("connected");
    expect(result.current.connectedConfigId).toBe(CONFIG_ID);
  });
});

function makeLayoutBridge(detail: ConfigDetail = startDetail("tun")) {
  let emit: ((event: AgentEvent) => void) | null = null;
  const bridge = {
    subscribe: (listener: (event: AgentEvent) => void) => {
      emit = listener;
      return () => {
        emit = null;
      };
    },
    configList: async () => ({
      configs: [startSummary("tun")],
      active_config_id: CONFIG_ID,
    }),
    configDetail: async () => ({ ...detail }),
    getRuntimeSnapshot: async () => null,
  } as unknown as AgentBridge;
  return {
    bridge,
    emit: (event: AgentEvent) => {
      emit?.(event);
    },
  };
}

function layoutEvent(
  configId: string,
  revision: number,
  blocks: Layout["blocks"],
): AgentEvent {
  return {
    name: AGENT_EVENTS.layoutUpdated,
    payload: {
      contract_version: CONTRACT_VERSION,
      config_id: configId,
      revision,
      layout: { version: 1, blocks },
      emitted_at: "",
    },
  };
}

describe("layout-updated 消费", () => {
  it("当前配置的更新 revision 直接打补丁，不改其它字段", async () => {
    const { bridge, emit } = makeLayoutBridge();
    const { result } = renderHook(() => useVpnSession(bridge, false));
    await waitFor(() => expect(result.current.activeConfig).not.toBeNull());

    act(() => {
      emit(layoutEvent(CONFIG_ID, 1, [{ type: "empty_hint" }]));
    });

    expect(result.current.activeConfig?.layout).toEqual({
      version: 1,
      blocks: [{ type: "empty_hint" }],
    });
    expect(result.current.activeConfig?.layout_revision).toBe(1);
    expect(result.current.activeConfig?.name).toBe("测试配置");
  });

  it("revision 不更新的迟到事件丢弃", async () => {
    const detail = { ...startDetail("tun") };
    detail.layout = { version: 1, blocks: [{ type: "source_choice" }] };
    detail.layout_revision = 3;
    const { bridge, emit } = makeLayoutBridge(detail);
    const { result } = renderHook(() => useVpnSession(bridge, false));
    await waitFor(() => expect(result.current.activeConfig).not.toBeNull());

    act(() => {
      emit(layoutEvent(CONFIG_ID, 3, [{ type: "empty_hint" }]));
      emit(layoutEvent(CONFIG_ID, 2, [{ type: "empty_hint" }]));
    });
    expect(result.current.activeConfig?.layout).toEqual({
      version: 1,
      blocks: [{ type: "source_choice" }],
    });

    act(() => {
      emit(layoutEvent(CONFIG_ID, 4, [{ type: "empty_hint" }]));
    });
    expect(result.current.activeConfig?.layout_revision).toBe(4);
  });

  it("别的配置的事件不会串到当前配置", async () => {
    const { bridge, emit } = makeLayoutBridge();
    const { result } = renderHook(() => useVpnSession(bridge, false));
    await waitFor(() => expect(result.current.activeConfig).not.toBeNull());

    act(() => {
      emit(layoutEvent("cfg_other", 99, [{ type: "proxy_card" }]));
    });
    expect(result.current.activeConfig?.layout).toBeNull();
    expect(result.current.activeConfig?.layout_revision).toBeNull();
  });
});

describe("过渡状态在请求结束时必须收敛", () => {
  it("启动成功但刷新快照失败：连接状态落到已连接，过渡层不会挂住", async () => {
    const bridge = makeStartBridge("tun");
    const list = vi
      .fn()
      .mockResolvedValueOnce({ configs: [startSummary("tun")], active_config_id: CONFIG_ID })
      .mockRejectedValue(new Error("boom"));
    (bridge as unknown as { configList: unknown }).configList = list;

    const { result } = renderHook(() => useVpnSession(bridge, false));
    await waitFor(() => expect(result.current.activeConfig).not.toBeNull());

    let res: ActionResult | undefined;
    await act(async () => {
      res = await result.current.start();
    });

    expect(res?.ok).toBe(true);
    expect(result.current.connection).toBe("connected");
  });

  it("启动失败且刷新快照也失败：回到 idle，不让遮罩停在「正在连接」", async () => {
    const bridge = makeStartBridge("tun", {
      runtimeStart: async () => {
        throw { code: "INTERNAL", message: "启动失败" };
      },
    });
    const list = vi
      .fn()
      .mockResolvedValueOnce({ configs: [startSummary("tun")], active_config_id: CONFIG_ID })
      .mockRejectedValue(new Error("boom"));
    (bridge as unknown as { configList: unknown }).configList = list;

    const { result } = renderHook(() => useVpnSession(bridge, false));
    await waitFor(() => expect(result.current.activeConfig).not.toBeNull());

    let res: ActionResult | undefined;
    await act(async () => {
      res = await result.current.start();
    });

    expect(res?.ok).toBe(false);
    expect(result.current.connection).toBe("idle");
  });
});
