/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConfigDetail, RuntimeView } from "../agent/protocol";
import { emptyRuntimeView } from "../agent/bridge";
import type { NodeProbesController } from "../config/useNodeProbes";
import { ConnectionStage } from "./ConnectionStage";

afterEach(cleanup);

const CONFIG: ConfigDetail = {
  config_id: "cfg_1",
  name: "免费节点",
  connect_mode: "tun",
  routing_mode: "direct",
  node_count: 2,
  listen_port: null,
  is_active: true,
  current_node_id: "n1",
  created_at: 0,
  updated_at: 0,
  last_used_at: null,
  nodes: [
    {
      node_id: "n1",
      name: "东京 01",
      server: "203.0.113.1",
      port: 8388,
      method: "aes-256-gcm",
      protocol: "shadowsocks",
      source: "seed",
      created_at: 0,
    },
    {
      node_id: "n2",
      name: "新加坡 01",
      server: "203.0.113.2",
      port: 8388,
      method: "aes-256-gcm",
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

function probes(over: Partial<NodeProbesController> = {}): NodeProbesController {
  return {
    results: {},
    run: null,
    probing: new Set(),
    finished: null,
    notice: null,
    available: true,
    loadSnapshot: async () => {},
    start: async () => ({ ok: true }),
    cancel: async () => {},
    clearNotice: () => {},
    ...over,
  };
}

function renderStage(over: {
  runtime?: RuntimeView;
  connection?: "idle" | "starting" | "connected" | "stopping";
  nodeProbes?: NodeProbesController;
  onStart?: () => void;
  onStop?: () => void;
  onReconnect?: () => void;
  failedAfterConnected?: boolean;
} = {}) {
  const handlers = {
    onStart: over.onStart ?? vi.fn(),
    onStop: over.onStop ?? vi.fn(),
    onReconnect: over.onReconnect ?? vi.fn(),
  };
  render(
    <ConnectionStage
      config={CONFIG}
      connection={over.connection ?? "idle"}
      runtime={over.runtime ?? emptyRuntimeView()}
      onStart={handlers.onStart}
      onStop={handlers.onStop}
      onReconnect={handlers.onReconnect}
      onSwitchNode={async () => ({ ok: true })}
      nodeProbes={over.nodeProbes ?? probes()}
      failedAfterConnected={over.failedAfterConnected ?? false}
      helperPreparing={false}
    />,
  );
  return handlers;
}

function runtime(over: Partial<RuntimeView> = {}): RuntimeView {
  const base = emptyRuntimeView();
  return { ...base, ...over, health: { ...base.health, ...(over.health ?? {}) } };
}

describe("连接舞台", () => {
  it("已连接时状态带显示计时，按钮是断开", async () => {
    const onStop = vi.fn();
    renderStage({
      connection: "connected",
      runtime: runtime({
        state: "running",
        connected_since: new Date(Date.now() - 5000).toISOString(),
        health: { ...emptyRuntimeView().health, data_plane: true, checked_at: new Date().toISOString() },
      }),
      onStop,
    });

    await screen.findAllByText("已连接");
    expect(screen.getByText(/^00:00:0[0-9]$/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "断开连接" }));
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it("已连接不通：不带计时，按钮是重新连接", async () => {
    const onReconnect = vi.fn();
    renderStage({
      connection: "connected",
      runtime: runtime({
        state: "running",
        connected_since: new Date().toISOString(),
        health: {
          ...emptyRuntimeView().health,
          data_plane: false,
          checked_at: new Date().toISOString(),
        },
      }),
      onReconnect,
    });

    expect(await screen.findByText("已连接，不通")).toBeTruthy();
    expect(screen.queryByText(/^00:00:/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "重新连接" }));
    expect(onReconnect).toHaveBeenCalledTimes(1);
  });

  it("失败时主按钮是让 AI 检查，旁边保留重新连接", async () => {
    const onDiagnose = vi.fn();
    const onStart = vi.fn();
    render(
      <ConnectionStage
        config={CONFIG}
        connection="idle"
        runtime={runtime({
          state: "failed",
          last_error: {
            contract_version: "2.15.0",
            code: "INTERNAL",
            message: "没连上。",
            retryable: true,
            details: null,
            request_id: "req_1",
          },
        })}
        onStart={onStart}
        onStop={() => {}}
        onReconnect={() => {}}
        onSwitchNode={async () => ({ ok: true })}
        nodeProbes={probes()}
        failedAfterConnected={false}
        helperPreparing={false}
        onDiagnose={onDiagnose}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "让 AI 检查" }));
    expect(onDiagnose).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "重新连接" }));
    expect(onStart).toHaveBeenCalledTimes(1);
  });

  it("失败态显示原因与报告入口", async () => {
    const onReport = vi.fn();
    render(
      <ConnectionStage
        config={CONFIG}
        connection="idle"
        runtime={runtime({
          state: "failed",
          last_error: {
            contract_version: "2.15.0",
            code: "INTERNAL",
            message: "装环境超时。",
            retryable: true,
            details: null,
            request_id: "req_1",
          },
        })}
        onStart={() => {}}
        onStop={() => {}}
        onReconnect={() => {}}
        onSwitchNode={async () => ({ ok: true })}
        nodeProbes={probes()}
        failedAfterConnected={false}
        helperPreparing={false}
        onReportProblem={onReport}
      />,
    );

    expect(await screen.findByText(/装环境超时/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "报告问题" }));
    expect(onReport).toHaveBeenCalledTimes(1);
  });

  it("已销毁的节点标「已销毁」且不可点", async () => {
    const onSwitchNode = vi.fn(async () => ({ ok: true }));
    render(
      <ConnectionStage
        config={CONFIG}
        connection="idle"
        runtime={emptyRuntimeView()}
        onStart={() => {}}
        onStop={() => {}}
        onReconnect={() => {}}
        onSwitchNode={onSwitchNode}
        nodeProbes={probes()}
        failedAfterConnected={false}
        helperPreparing={false}
        destroyedNodeIds={new Set(["n2"])}
      />,
    );

    expect(await screen.findByText("已销毁")).toBeTruthy();
    const row = screen.getByRole("option", { name: /新加坡 01/ });
    expect((row as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(row);
    expect(onSwitchNode).not.toHaveBeenCalled();
  });

  it("节点行显示测速结果，未测到显示破折号", async () => {
    renderStage({
      nodeProbes: probes({
        results: {
          n2: {
            node_id: "n2",
            reachable: true,
            latency_ms: 42,
            probe_method: "tcp",
            checked_at: Date.now(),
            error: null,
          },
        },
      }),
    });

    expect(await screen.findByText("42 毫秒")).toBeTruthy();
    // n1 没有结果
    expect(screen.getAllByText("—").length).toBeGreaterThan(0);
  });
});
