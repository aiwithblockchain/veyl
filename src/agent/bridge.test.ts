import { describe, expect, it } from "vitest";
import { applyRuntimeEvent, emptyRuntimeView, keepLiveHealth, readQuestionDetail, snapshotToView, viewAfterConnected, viewAfterStopped } from "./bridge";
import {
  AGENT_EVENTS,
  CONTRACT_VERSION,
  type RuntimeSnapshot,
} from "./protocol";

const EMPTY_HEALTH = emptyRuntimeView().health;
const TRAFFIC = {
  up_bytes: 10,
  down_bytes: 20,
  up_rate: 0,
  down_rate: 0,
  sampled_at: "",
};

const SNAPSHOT: RuntimeSnapshot = {
  contract_version: CONTRACT_VERSION,
  state: "running",
  mode: "system_proxy",
  pid: 123,
  upstream_version: "1.14.0",
  uptime_seconds: 10,
  config_id: "cfg",
  config_name: "配置",
  node_id: "n1",
  node_name: "节点",
  config_hash: "hash",
  system_proxy_enabled: true,
  health: EMPTY_HEALTH,
  traffic: null,
  connections: 2,
  restart_count: 0,
  last_error: null,
  last_transition_at: "",
  mixed_port: 7890,
  port_fallback: null,
  connected_since: new Date().toISOString(),
  latency_ms: 42,
  node_latency_ms: 42,
  applied_route_revision: 1,
  route_region: "cn",
  direct_ip: "203.0.113.1",
};

describe("runtime 快照与事件兜底", () => {
  it("snapshotToView 缺 health/traffic/connections 时归一", () => {
    const view = snapshotToView({
      ...SNAPSHOT,
      health: undefined,
      traffic: undefined,
      connections: undefined,
    } as unknown as RuntimeSnapshot);
    expect(view.health).toMatchObject({ exit_ip: null, process: false });
    expect(view.traffic).toBeNull();
    expect(view.connections).toBeNull();
  });

  it("非连接态丢弃健康事件里的流量/连接数/延迟", () => {
    const next = applyRuntimeEvent(emptyRuntimeView(), {
      name: AGENT_EVENTS.runtimeHealthChanged,
      payload: {
        contract_version: CONTRACT_VERSION,
        health: EMPTY_HEALTH,
        traffic: TRAFFIC,
        connections: 7,
        latency_ms: 42,
        node_latency_ms: 42,
        emitted_at: "",
      },
    });
    expect(next.traffic).toBeNull();
    expect(next.connections).toBeNull();
    expect(next.latency_ms).toBeNull();
    expect(next.node_latency_ms).toBeNull();
  });

  it("在线态采用健康事件里的流量/连接数/延迟", () => {
    const view = { ...emptyRuntimeView(), state: "running" as const };
    const next = applyRuntimeEvent(view, {
      name: AGENT_EVENTS.runtimeHealthChanged,
      payload: {
        contract_version: CONTRACT_VERSION,
        health: EMPTY_HEALTH,
        traffic: TRAFFIC,
        connections: 7,
        latency_ms: 42,
        node_latency_ms: 38,
        emitted_at: "",
      },
    });
    expect(next.traffic?.down_bytes).toBe(20);
    expect(next.connections).toBe(7);
    expect(next.latency_ms).toBe(42);
    expect(next.node_latency_ms).toBe(38);
  });

  it("离开在线态清空流量/连接数/延迟和连接时刻", () => {
    const view = {
      ...emptyRuntimeView(),
      state: "running" as const,
      traffic: TRAFFIC,
      connections: 7,
      latency_ms: 42,
      node_latency_ms: 38,
      connected_since: new Date().toISOString(),
      route_region: "cn",
    };
    expect(snapshotToView(SNAPSHOT).route_region).toBe("cn");
    const next = applyRuntimeEvent(view, {
      name: AGENT_EVENTS.runtimeStateChanged,
      payload: {
        contract_version: CONTRACT_VERSION,
        from: "running",
        to: "idle",
        event: "stopped",
        pid: null,
        upstream_version: null,
        reason: null,
        error: null,
        snapshot: SNAPSHOT,
        emitted_at: "",
      },
    });
    expect(next.traffic).toBeNull();
    expect(next.connections).toBeNull();
    expect(next.latency_ms).toBeNull();
    expect(next.node_latency_ms).toBeNull();
    expect(next.connected_since).toBeNull();
    expect(next.route_region).toBeNull();
  });

  it("快照晚到时保留请求期间收到的节点延迟，不被打回确认中", () => {
    const base = snapshotToView({
      ...SNAPSHOT,
      latency_ms: null,
      node_latency_ms: null,
      traffic: null,
      connections: null,
    });
    const live = applyRuntimeEvent(
      { ...emptyRuntimeView(), state: "running" },
      {
        name: AGENT_EVENTS.runtimeHealthChanged,
        payload: {
          contract_version: CONTRACT_VERSION,
          health: EMPTY_HEALTH,
          traffic: TRAFFIC,
          connections: 2,
          latency_ms: 999,
          node_latency_ms: 38,
          emitted_at: "",
        },
      },
    );

    const merged = keepLiveHealth(base, live);
    expect(merged.node_latency_ms).toBe(38);
    expect(merged.latency_ms).toBe(999);
    expect(merged.traffic?.down_bytes).toBe(20);
    expect(merged.connections).toBe(2);
    // 其余字段仍以快照为准。
    expect(merged.state).toBe("running");
    expect(merged.mixed_port).toBe(7890);
  });
});

describe("readQuestionDetail", () => {
  it("读取嵌套的升级明细", () => {
    expect(
      readQuestionDetail({
        kind: "core_upgrade_confirm",
        details: {
          current_version: "1.14.4",
          target_version: "1.15.0",
          size: 12 * 1024 * 1024,
          restart_required: true,
        },
      }),
    ).toEqual({
      kind: "core_upgrade_confirm",
      upgradeConfirm: {
        currentVersion: "1.14.4",
        targetVersion: "1.15.0",
        size: 12 * 1024 * 1024,
        restartRequired: true,
      },
    });
  });

  it("兼容与 kind 同级的扁平字段，大小缺失为 null", () => {
    expect(
      readQuestionDetail({
        kind: "core_upgrade_confirm",
        current_version: "1.14.4",
        target_version: "1.15.0",
        size: 0,
      }),
    ).toEqual({
      kind: "core_upgrade_confirm",
      upgradeConfirm: {
        currentVersion: "1.14.4",
        targetVersion: "1.15.0",
        size: null,
        restartRequired: false,
      },
    });
  });

  it("普通提问不产出升级明细", () => {
    expect(readQuestionDetail({ kind: null })).toEqual({
      kind: null,
      upgradeConfirm: null,
    });
    expect(readQuestionDetail({ question: "要升级吗？" })).toEqual({
      kind: null,
      upgradeConfirm: null,
    });
  });
});

describe("start 成功后的视图校正", () => {
  it("failed / idle / starting 都校正为 running，并清掉上次错误", () => {
    const oldError = {
      contract_version: "1.0.0",
      code: "PRECONDITION_FAILED" as const,
      message: "旧错误",
      retryable: false,
      details: null,
      request_id: "",
    };
    for (const state of ["failed", "idle", "starting", "restarting", "stopping"] as const) {
      const view = { ...emptyRuntimeView(), state, last_error: oldError };
      expect(viewAfterConnected(view)).toMatchObject({
        state: "running",
        last_error: null,
      });
    }
  });

  it("已经是 running / degraded 时原样保留", () => {
    const running = { ...emptyRuntimeView(), state: "running" as const };
    expect(viewAfterConnected(running)).toBe(running);
    const degraded = { ...emptyRuntimeView(), state: "degraded" as const };
    expect(viewAfterConnected(degraded)).toBe(degraded);
  });
});

describe("stop 成功后的视图校正", () => {
  it("进入 idle 并清掉连接期字段", () => {
    const oldError = {
      contract_version: "1.0.0",
      code: "PRECONDITION_FAILED" as const,
      message: "旧错误",
      retryable: false,
      details: null,
      request_id: "",
    };
    const running = {
      ...emptyRuntimeView(),
      state: "running" as const,
      pid: 123,
      connected_since: "2026-11-09T00:00:00Z",
      route_region: "jp",
      latency_ms: 42,
      node_latency_ms: 30,
      traffic: TRAFFIC,
      connections: 3,
      port_fallback: { requested: 7890, actual: 7891, reason: "occupied" as const },
      last_error: oldError,
    };

    expect(viewAfterStopped(running)).toMatchObject({
      state: "idle",
      pid: null,
      connected_since: null,
      route_region: null,
      latency_ms: null,
      node_latency_ms: null,
      traffic: null,
      connections: null,
      port_fallback: null,
      last_error: null,
    });
  });
});
