/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ConfigConnectMode,
  ConfigDetail,
  ConfigRouteMode,
  RuntimeView,
} from "../agent/protocol";import { emptyRuntimeView } from "../agent/bridge";
import type { NodeProbesController } from "../config/useNodeProbes";
import { ConnectionStage, type PendingServerNode } from "./ConnectionStage";

vi.mock("../log/uiLog", () => ({ uiLog: vi.fn() }));

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
    starting: false,
    probing: new Set(),
    forget: () => {},
    finished: null,
    notice: null,
    available: true,
    recordResults: () => {},
    markProbing: () => {},
    loadSnapshot: async () => {},
    start: async () => ({ ok: true }),
    cancel: async () => {},
    clearNotice: () => {},
    ...over,
  };
}

function probeResult(nodeId: string, latency: number) {
  return {
    node_id: nodeId,
    status: "ok" as const,
    reachable: true as const,
    latency_ms: latency,
    probe_method: "clash_delay" as const,
    checked_at: Date.now(),
    error: null,
  };
}

function failedProbe(nodeId: string) {
  return {
    node_id: nodeId,
    status: "unreachable" as const,
    reachable: false as const,
    latency_ms: null,
    probe_method: "clash_delay" as const,
    checked_at: Date.now(),
    error: { code: "PROBE_TIMEOUT", message: "" },
  };
}

/** 没测成：reachable 为 null，既不是可用也不是连不上。 */
function untestedProbe(nodeId: string) {
  return {
    node_id: nodeId,
    status: "untested" as const,
    reachable: null,
    latency_ms: null,
    probe_method: "none" as const,
    checked_at: 0,
    error: null,
  };
}

function probeRun(runId: string): NonNullable<NodeProbesController["run"]> {
  return {
    runId,
    configId: "cfg_1",
    done: 0,
    total: 2,
    startedAt: Date.now(),
    phase: "probing",
    method: "clash",
    ignored: 0,
  };
}

function probeFinished(
  over: Partial<NonNullable<NodeProbesController["finished"]>> = {},
): NonNullable<NodeProbesController["finished"]> {
  return {
    configId: "cfg_1",
    total: 2,
    ok: 2,
    failed: 0,
    untested: 0,
    method: "clash",
    cancelled: false,
    reason: null,
    network: "ok",
    ...over,
  };
}

interface StageOverrides {
  config?: ConfigDetail;
  runtime?: RuntimeView;
  connection?: "idle" | "starting" | "connected" | "stopping";
  nodeProbes?: NodeProbesController;
  onStart?: () => void;
  onStop?: () => void;
  onReconnect?: () => void;
  failedAfterConnected?: boolean;
  onSwitchNode?: (nodeId: string) => Promise<{ ok: boolean; message?: string }>;
  onEditNode?: (node: import("../agent/protocol").NodeSummary) => void;
  onRemoveNode?: (nodeId: string) => Promise<{
    ok: boolean;
    message?: string;
    wasCurrent?: boolean;
  }>;
  preselect?: {
    configId: string;
    nodeId: string;
    nonce: number;
    markFastest?: boolean;
  } | null;
  trialSummary?: { configId: string; count: number; fastestMs: number | null } | null;
  trialExpiresAt?: string | null;
  danglingNodeIds?: ReadonlySet<string>;
  onProbe?: () => void;
  onAddNode?: () => void;
  manualProbed?: boolean;
  onProbeAvailabilityChange?: (available: boolean) => void;
  routingMode?: ConfigRouteMode | null;
  onSetConnectMode?: (
    mode: ConfigConnectMode,
    options?: { onRestoring?: () => void },
  ) => Promise<{
    ok: boolean;
    restored?: boolean | null;
    actualMode?: ConfigConnectMode | null;
    message?: string;
  }>;
  onSetRoutingMode?: (
    mode: "direct" | "proxy_all",
  ) => Promise<{ ok: boolean; message?: string }>;
  onReportProblem?: () => void;
  reportBusy?: boolean;
  onAskAi?: (prompt: string) => void;
  onAskAiAboutNode?: (nodeId: string, prompt: string) => void;
  serverIdForNode?: (nodeId: string) => string | null;
  onAnalyzeNode?: (target: { serverId: string; nodeName: string }) => void;
  onReconnectAndTest?: () => Promise<boolean>;
  staleConfigNode?: boolean;
  onStaleConfigRetry?: () => void;
  pendingServerNodes?: PendingServerNode[];
}

function stageElement(over: StageOverrides = {}) {
  return (
    <ConnectionStage
      config={over.config ?? CONFIG}
      connection={over.connection ?? "idle"}
      runtime={over.runtime ?? emptyRuntimeView()}
      onStart={over.onStart ?? vi.fn()}
      onStop={over.onStop ?? vi.fn()}
      onReconnect={over.onReconnect ?? vi.fn()}
      onSwitchNode={over.onSwitchNode ?? (async () => ({ ok: true }))}
      onRemoveNode={over.onRemoveNode}
      onEditNode={over.onEditNode}
      nodeProbes={over.nodeProbes ?? probes()}
      failedAfterConnected={over.failedAfterConnected ?? false}
      helperPreparing={false}
      preselect={over.preselect ?? null}
      trialSummary={over.trialSummary ?? null}
      trialExpiresAt={over.trialExpiresAt ?? null}
      danglingNodeIds={over.danglingNodeIds}
      onProbe={over.onProbe}
      onAddNode={over.onAddNode}
      manualProbed={over.manualProbed ?? false}
      onProbeAvailabilityChange={over.onProbeAvailabilityChange}
      routingMode={over.routingMode ?? null}
      onSetConnectMode={over.onSetConnectMode}
      onSetRoutingMode={over.onSetRoutingMode}
      onReportProblem={over.onReportProblem}
      reportBusy={over.reportBusy}
      onAskAi={over.onAskAi}
      onAskAiAboutNode={over.onAskAiAboutNode}
      serverIdForNode={over.serverIdForNode}
      onAnalyzeNode={over.onAnalyzeNode}
      onReconnectAndTest={over.onReconnectAndTest}
      staleConfigNode={over.staleConfigNode}
      onStaleConfigRetry={over.onStaleConfigRetry}
      pendingServerNodes={over.pendingServerNodes}
    />
  );
}

function renderStage(over: StageOverrides = {}) {
  return render(stageElement(over));
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

  it("托管节点失败：主按钮是智能诊断，旁边保留重新连接", async () => {
    const onDiagnose = vi.fn();
    const onStart = vi.fn();
    const ownedNode = {
      ...CONFIG.nodes[0],
      node_id: "m1",
      name: "托管服务器",
      source: "owned" as const,
    };
    render(
      <ConnectionStage
        config={{ ...CONFIG, current_node_id: "m1", nodes: [ownedNode] }}
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

    fireEvent.click(await screen.findByRole("button", { name: "智能诊断" }));
    expect(onDiagnose).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "重新连接" }));
    expect(onStart).toHaveBeenCalledTimes(1);
  });

  it("免费节点失败：主按钮不是智能诊断，只剩重新连接", () => {
    const onDiagnose = vi.fn();
    render(
      <ConnectionStage
        config={CONFIG}
        connection="idle"
        runtime={runtime({ state: "failed" })}
        onStart={() => {}}
        onStop={() => {}}
        onReconnect={() => {}}
        onSwitchNode={async () => ({ ok: true })}
        nodeProbes={probes()}
        failedAfterConnected={false}
        helperPreparing={false}
        onDiagnose={onDiagnose}
      />,
    );

    expect(
      screen.queryByRole("button", { name: "智能诊断" }),
    ).toBeNull();
    expect(
      (document.querySelector("button.stage-primary") as HTMLButtonElement)
        .textContent,
    ).toBe("重新连接");
    expect(onDiagnose).not.toHaveBeenCalled();
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

    // 后端 message 只进日志：未登记的码不追加原因行。
    expect(await screen.findByText(/没有连上节点/)).toBeTruthy();
    expect(screen.queryByText(/装环境超时/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "报告问题" }));
    expect(onReport).toHaveBeenCalledTimes(1);
  });

  it("节点行显示测速结果，未测到写「未测」", async () => {
    renderStage({
      nodeProbes: probes({
        results: {
          n2: {
            node_id: "n2",
            status: "ok",
            reachable: true,
            latency_ms: 42,
            probe_method: "clash_delay",
            checked_at: Date.now(),
            error: null,
          },
        },
      }),
    });

    expect(await screen.findByText("42 毫秒")).toBeTruthy();
    // n1 没有结果
    expect(screen.getAllByText("未测").length).toBeGreaterThan(0);
    expect(screen.queryByText("—")).toBeNull();
  });

  it("免费节点按国家 + 序号显示，原名只进 title", () => {
    renderStage({
      config: {
        ...CONFIG,
        current_node_id: "n1",
        nodes: [
          { ...CONFIG.nodes[0], name: "meshflux69 [美国]" },
          { ...CONFIG.nodes[1], name: "meshflux10 [美国2]" },
        ],
      },
    });

    const us1 = screen.getByRole("option", { name: /美国 01/ });
    const us2 = screen.getByRole("option", { name: /美国 02/ });
    expect(us1.querySelector(".stage-node__name")?.getAttribute("title")).toBe(
      "meshflux69 [美国]",
    );
    expect(us2.querySelector(".stage-node__name")?.getAttribute("title")).toBe(
      "meshflux10 [美国2]",
    );
    expect(screen.queryByText(/meshflux69/)).toBeNull();
  });

  it("已连接时状态标签与计时器是同一行的前后两个子节点", async () => {
    renderStage({
      connection: "connected",
      runtime: runtime({
        state: "running",
        connected_since: new Date(Date.now() - 5000).toISOString(),
        health: {
          ...emptyRuntimeView().health,
          data_plane: true,
          checked_at: new Date().toISOString(),
        },
      }),
    });

    await screen.findAllByText("已连接");
    const line = document.querySelector(".state-line");
    expect(line).not.toBeNull();
    const children = [...(line?.children ?? [])];
    expect(children[0].className).toContain("state-line__label");
    expect(children[1].className).toContain("timecode");
    // jsdom 不计算 flex 布局：这里只锁结构顺序与类名，
    // 真正的一行排列由 `app.css` 的 `.state-line { flex-direction: row }` 保证。
  });

  it("自动测速结果不产生预选，也不标最快", () => {
    const onSwitch = vi.fn(async () => ({ ok: true }));
    renderStage({
      config: { ...CONFIG, current_node_id: null },
      nodeProbes: probes({
        results: { n1: probeResult("n1", 90), n2: probeResult("n2", 42) },
      }),
      onSwitchNode: onSwitch,
    });

    const rows = screen.getAllByRole("option");
    expect(rows[0].getAttribute("aria-selected")).toBe("false");
    expect(rows[1].getAttribute("aria-selected")).toBe("false");
    expect(document.querySelectorAll(".stage-node__fastest").length).toBe(0);
    expect(onSwitch).not.toHaveBeenCalled();
  });

  it("试用完成只预选一次，之后测速不重新推导", () => {
    const preselect = { configId: "cfg_1", nodeId: "n2", nonce: 1, markFastest: true };
    const view = renderStage({
      config: { ...CONFIG, current_node_id: null },
      nodeProbes: probes({
        results: { n1: probeResult("n1", 90), n2: probeResult("n2", 42) },
      }),
      preselect,
    });
    let rows = screen.getAllByRole("option");
    expect(rows[1].getAttribute("aria-selected")).toBe("true");
    expect(rows[1].querySelector(".stage-node__fastest")?.textContent).toBe("最快");

    // 后续自动测速把 n1 变成最快：预选不重算，标记也不挪。
    view.rerender(
      stageElement({
        config: { ...CONFIG, current_node_id: null },
        nodeProbes: probes({
          results: { n1: probeResult("n1", 30), n2: probeResult("n2", 42) },
        }),
        preselect,
      }),
    );
    rows = screen.getAllByRole("option");
    expect(rows[1].getAttribute("aria-selected")).toBe("true");
    expect(rows[1].querySelector(".stage-node__fastest")).not.toBeNull();
    expect(rows[0].querySelector(".stage-node__fastest")).toBeNull();
  });

  it("预选缺省不标「最快」：从服务器详情跳过来没测过速", () => {
    renderStage({
      config: { ...CONFIG, current_node_id: null },
      nodeProbes: probes({
        results: { n1: probeResult("n1", 90), n2: probeResult("n2", 42) },
      }),
      preselect: { configId: "cfg_1", nodeId: "n2", nonce: 1 },
    });

    const rows = screen.getAllByRole("option");
    expect(rows[1].getAttribute("aria-selected")).toBe("true");
    expect(document.querySelectorAll(".stage-node__fastest").length).toBe(0);
  });

  it("本地预选不写任何本地存储", () => {
    localStorage.clear();
    sessionStorage.clear();
    renderStage({
      config: { ...CONFIG, current_node_id: null },
      nodeProbes: probes({
        results: { n1: probeResult("n1", 90), n2: probeResult("n2", 42) },
      }),
      preselect: { configId: "cfg_1", nodeId: "n2", nonce: 1, markFastest: true },
    });
    expect(document.querySelectorAll(".stage-node__fastest").length).toBe(1);
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
  });

  it("点连接先切到本地预选的节点，再发起连接", async () => {
    const onSwitch = vi.fn(async () => ({ ok: true }));
    const onStart = vi.fn();
    renderStage({
      config: { ...CONFIG, current_node_id: null },
      nodeProbes: probes({
        results: { n1: probeResult("n1", 90), n2: probeResult("n2", 42) },
      }),
      preselect: { configId: "cfg_1", nodeId: "n2", nonce: 1 },
      onSwitchNode: onSwitch,
      onStart,
    });

    fireEvent.click(screen.getByRole("button", { name: "连接节点" }));
    await waitFor(() => expect(onStart).toHaveBeenCalledTimes(1));
    expect(onSwitch).toHaveBeenCalledWith("n2");
    expect(onSwitch.mock.invocationCallOrder[0]).toBeLessThan(
      onStart.mock.invocationCallOrder[0],
    );
  });

  it("切换失败就停下，并说明是切换失败", async () => {
    const onSwitch = vi.fn(async () => ({
      ok: false,
      message: "节点不存在。",
    }));
    const onStart = vi.fn();
    renderStage({
      config: { ...CONFIG, current_node_id: null },
      nodeProbes: probes({
        results: { n1: probeResult("n1", 90), n2: probeResult("n2", 42) },
      }),
      preselect: { configId: "cfg_1", nodeId: "n2", nonce: 1 },
      onSwitchNode: onSwitch,
      onStart,
    });

    fireEvent.click(screen.getByRole("button", { name: "连接节点" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("切换节点失败");
    expect(alert.textContent).toContain("节点不存在。");
    expect(onStart).not.toHaveBeenCalled();
  });

  it("已连接时点行不改选中，以当前节点为准", async () => {
    const onSwitch = vi.fn(async () => ({ ok: true }));
    renderStage({
      config: { ...CONFIG, current_node_id: "n1" },
      connection: "connected",
      runtime: runtime({
        state: "running",
        connected_since: new Date(Date.now() - 5000).toISOString(),
        health: {
          ...emptyRuntimeView().health,
          data_plane: true,
          checked_at: new Date().toISOString(),
        },
      }),
      nodeProbes: probes({
        results: { n1: probeResult("n1", 90), n2: probeResult("n2", 42) },
      }),
      // 即使有旧的本地预选，已连接也不采用。
      preselect: { configId: "cfg_1", nodeId: "n2", nonce: 1 },
      onSwitchNode: onSwitch,
    });

    fireEvent.click(screen.getByRole("option", { name: /新加坡 01/ }));
    await waitFor(() => expect(onSwitch).toHaveBeenCalledWith("n2"));
    const rows = screen.getAllByRole("option");
    expect(rows[0].getAttribute("aria-selected")).toBe("true");
    expect(rows[1].getAttribute("aria-selected")).toBe("false");
  });

  it("已连接切换失败后仍可再点重试", async () => {
    const onSwitch = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, message: "节点不存在。" })
      .mockResolvedValueOnce({ ok: true });
    renderStage({
      config: { ...CONFIG, current_node_id: "n1" },
      connection: "connected",
      runtime: runtime({
        state: "running",
        connected_since: new Date(Date.now() - 5000).toISOString(),
        health: {
          ...emptyRuntimeView().health,
          data_plane: true,
          checked_at: new Date().toISOString(),
        },
      }),
      nodeProbes: probes({
        results: { n1: probeResult("n1", 90), n2: probeResult("n2", 42) },
      }),
      onSwitchNode: onSwitch,
    });

    const row = screen.getByRole("option", { name: /新加坡 01/ });
    fireEvent.click(row);
    await waitFor(() => expect(onSwitch).toHaveBeenCalledTimes(1));
    expect((await screen.findByRole("alert")).textContent).toContain("节点不存在。");
    // 失败后选中仍是当前节点，点同一行还能再发一次切换。
    expect(
      screen.getAllByRole("option")[0].getAttribute("aria-selected"),
    ).toBe("true");
    fireEvent.click(row);
    await waitFor(() => expect(onSwitch).toHaveBeenCalledTimes(2));
  });

  it("未连接时跟随外部 current_node_id 变化，不被旧预选拉回", async () => {
    const nodes = [
      CONFIG.nodes[0],
      CONFIG.nodes[1],
      { ...CONFIG.nodes[0], node_id: "n3", name: "纽约 01" },
    ];
    const onSwitch = vi.fn(async () => ({ ok: true }));
    const onStart = vi.fn();
    const view = renderStage({
      config: { ...CONFIG, nodes, current_node_id: "n1" },
      nodeProbes: probes({ results: {} }),
      onSwitchNode: onSwitch,
      onStart,
    });

    // 用户本地选了新加坡（不发命令）。
    fireEvent.click(screen.getByRole("option", { name: /新加坡 01/ }));
    expect(
      screen.getAllByRole("option")[1].getAttribute("aria-selected"),
    ).toBe("true");
    expect(onSwitch).not.toHaveBeenCalled();

    // AI 在未连接时把当前节点改成纽约：界面跟随，不被本地预选拉回。
    view.rerender(
      stageElement({
        config: { ...CONFIG, nodes, current_node_id: "n3" },
        nodeProbes: probes({ results: {} }),
        onSwitchNode: onSwitch,
        onStart,
      }),
    );
    await waitFor(() =>
      expect(
        screen.getAllByRole("option")[2].getAttribute("aria-selected"),
      ).toBe("true"),
    );
    expect(
      screen.getAllByRole("option")[1].getAttribute("aria-selected"),
    ).toBe("false");

    // 点连接连的是新的当前节点，不需要再切换。
    fireEvent.click(screen.getByRole("button", { name: "连接节点" }));
    await waitFor(() => expect(onStart).toHaveBeenCalledTimes(1));
    expect(onSwitch).not.toHaveBeenCalled();
  });

  it("没有测速结果时不预选，按钮仍可用并连当前 / 第一个", async () => {
    const onSwitch = vi.fn(async () => ({ ok: true }));
    const onStart = vi.fn();
    renderStage({
      config: { ...CONFIG, current_node_id: null },
      nodeProbes: probes({ results: {} }),
      onSwitchNode: onSwitch,
      onStart,
    });

    const rows = screen.getAllByRole("option");
    expect(rows[0].getAttribute("aria-selected")).toBe("false");
    expect(rows[1].getAttribute("aria-selected")).toBe("false");
    const primary = screen.getByRole("button", { name: "连接节点" });
    expect((primary as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(primary);
    await waitFor(() => expect(onStart).toHaveBeenCalledTimes(1));
    expect(onSwitch).toHaveBeenCalledWith("n1");
  });

  it("没有本会话步骤流时不显示收尾句", () => {
    renderStage({
      config: { ...CONFIG, current_node_id: null },
      nodeProbes: probes({
        results: { n1: probeResult("n1", 42), n2: probeResult("n2", 90) },
      }),
    });
    expect(screen.queryByText(/已加入/)).toBeNull();
  });

  it("收尾句只显示在试用步骤流对应的配置上", () => {
    renderStage({
      trialSummary: { configId: "cfg_other", count: 2, fastestMs: 42 },
    });
    expect(screen.queryByText(/已加入/)).toBeNull();
    cleanup();

    renderStage({
      trialSummary: { configId: "cfg_1", count: 2, fastestMs: 42 },
    });
    expect(screen.getByText(/已加入 2 个免费节点，最快 42ms/)).toBeTruthy();
  });

  it("手动测速只更新延迟，不改选中、不连接", () => {
    const onProbe = vi.fn();
    const onSwitch = vi.fn(async () => ({ ok: true }));
    const onStart = vi.fn();
    renderStage({
      config: { ...CONFIG, current_node_id: "n1" },
      onProbe,
      onSwitchNode: onSwitch,
      onStart,
    });

    fireEvent.click(screen.getByRole("button", { name: "测速" }));
    expect(onProbe).toHaveBeenCalledTimes(1);
    expect(onSwitch).not.toHaveBeenCalled();
    expect(onStart).not.toHaveBeenCalled();
    expect(
      screen.getAllByRole("option")[0].getAttribute("aria-selected"),
    ).toBe("true");
  });

  it("测速中入口禁用并显示三点，点击不重复触发", () => {
    const onProbe = vi.fn();
    renderStage({ nodeProbes: probes({ run: probeRun("r1") }), onProbe });

    const button = screen.getByRole("button", { name: /测速中/ });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(button.querySelectorAll(".stage-step__dots span").length).toBe(3);
    fireEvent.click(button);
    expect(onProbe).not.toHaveBeenCalled();
  });

  it("主动测速后最快标记跟随本次结果移动", () => {
    const onProbe = vi.fn();
    const base: StageOverrides = {
      nodeProbes: probes({
        results: { n1: probeResult("n1", 238), n2: probeResult("n2", 300) },
      }),
      preselect: { configId: "cfg_1", nodeId: "n1", nonce: 1, markFastest: true },
      onProbe,
    };
    const view = renderStage(base);
    expect(
      screen.getAllByRole("option")[0].querySelector(".stage-node__fastest"),
    ).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "测速" }));
    // 一批开始：手动测速不立刻清标记。
    view.rerender(
      stageElement({
        ...base,
        nodeProbes: probes({
          run: probeRun("r_manual"),
          results: { n1: probeResult("n1", 238), n2: probeResult("n2", 300) },
        }),
      }),
    );
    // 结束：n2 更低，标记移过去。
    view.rerender(
      stageElement({
        ...base,
        nodeProbes: probes({
          finished: probeFinished(),
          results: { n1: probeResult("n1", 238), n2: probeResult("n2", 180) },
        }),
      }),
    );
    const rows = screen.getAllByRole("option");
    expect(rows[1].querySelector(".stage-node__fastest")).not.toBeNull();
    expect(rows[0].querySelector(".stage-node__fastest")).toBeNull();
  });

  it("自动测速只清掉标记，不移动", () => {
    const base: StageOverrides = {
      nodeProbes: probes({
        results: { n1: probeResult("n1", 238), n2: probeResult("n2", 300) },
      }),
      preselect: { configId: "cfg_1", nodeId: "n1", nonce: 1, markFastest: true },
    };
    const view = renderStage(base);
    expect(
      screen.getAllByRole("option")[0].querySelector(".stage-node__fastest"),
    ).not.toBeNull();

    view.rerender(
      stageElement({
        ...base,
        nodeProbes: probes({
          run: probeRun("r_auto"),
          results: { n1: probeResult("n1", 238), n2: probeResult("n2", 300) },
        }),
      }),
    );
    view.rerender(
      stageElement({
        ...base,
        nodeProbes: probes({
          finished: probeFinished(),
          results: { n1: probeResult("n1", 238), n2: probeResult("n2", 180) },
        }),
      }),
    );
    expect(document.querySelectorAll(".stage-node__fastest").length).toBe(0);
  });

  it("全部失败：失败行写「测不通」并与无障碍名一致，卡内给再试一次", async () => {
    renderStage({
      runtime: runtime({ node_id: "n1", node_latency_ms: 40 }),
      nodeProbes: probes({
        finished: probeFinished({ ok: 0, failed: 2 }),
        results: { n1: failedProbe("n1"), n2: failedProbe("n2") },
      }),
      onProbe: () => {},
    });

    expect(await screen.findByText("这次都没测通。")).toBeTruthy();
    expect(
      await screen.findByRole("button", { name: "再试一次" }),
    ).toBeTruthy();
    const values = [...document.querySelectorAll(".stage-node__ms")].map(
      (node) => node.textContent,
    );
    // 测过但没通：写「测不通」，不再和「还没测」的破折号混在一起。
    expect(values).toEqual(["测不通", "测不通"]);
    expect(document.querySelectorAll(".stage-node__ms.is-muted").length).toBe(2);
    expect(screen.getAllByLabelText("这次没测通").length).toBe(2);
  });

  it("整批没测成（method=none）：说「这次没测成」，不说连不通，按钮不变成再试一次", async () => {
    renderStage({
      nodeProbes: probes({
        finished: probeFinished({ ok: 0, failed: 0, method: "none" }),
        results: { n1: untestedProbe("n1"), n2: untestedProbe("n2") },
      }),
      onProbe: () => {},
    });

    expect(await screen.findByText("这次没测成。")).toBeTruthy();
    expect(screen.queryByText("这次都没测通。")).toBeNull();
    expect(screen.queryByRole("button", { name: "再试一次" })).toBeNull();
    expect(screen.getByRole("button", { name: "测速" })).toBeTruthy();
    const values = [...document.querySelectorAll(".stage-node__ms")].map(
      (node) => node.textContent,
    );
    expect(values).toEqual(["未测", "未测"]);
  });

  it("三态行：ok 写数值、unreachable 写「测不通」、untested 写「未测」并带原因", () => {
    const config = {
      ...CONFIG,
      nodes: [
        ...CONFIG.nodes,
        { ...CONFIG.nodes[0], node_id: "n3", name: "洛杉矶 01" },
      ],
    };
    renderStage({
      config,
      nodeProbes: probes({
        results: {
          n1: probeResult("n1", 238),
          n2: failedProbe("n2"),
          n3: {
            ...untestedProbe("n3"),
            error: { code: "RUNTIME_FAILED", message: "临时运行时没起来" },
          },
        },
      }),
    });

    const values = [...document.querySelectorAll(".stage-node__ms")];
    expect(values.map((node) => node.textContent)).toEqual([
      "238 毫秒",
      "测不通",
      "未测",
    ]);
    expect(values[2].getAttribute("title")).toBe("临时运行时没起来");
    expect(values[1].getAttribute("title")).toBeNull();
  });

  it("混合批：部分连不上、部分没测成，只列没测成的数量，不写都没测通", () => {
    renderStage({
      nodeProbes: probes({
        finished: probeFinished({ ok: 0, failed: 1, untested: 1 }),
        results: { n1: failedProbe("n1"), n2: untestedProbe("n2") },
      }),
      onProbe: () => {},
    });

    expect(screen.queryByText("这次都没测通。")).toBeNull();
    expect(screen.getByText("1 个没测成。")).toBeTruthy();
    const values = [...document.querySelectorAll(".stage-node__ms")].map(
      (node) => node.textContent,
    );
    expect(values).toEqual(["测不通", "未测"]);
  });

  it("有可用也有未测：照样列「N 个没测成」，不改成失败提示", () => {
    renderStage({
      nodeProbes: probes({
        finished: probeFinished({ ok: 2, failed: 0, untested: 1 }),
        results: { n1: probeResult("n1", 38), n2: probeResult("n2", 52) },
      }),
      onProbe: () => {},
    });

    expect(screen.queryByText("这次都没测通。")).toBeNull();
    expect(screen.getByText("1 个没测成。")).toBeTruthy();
  });

  it("切到没测过的配置：不带上一套的「都没测通」", () => {
    const base: StageOverrides = {
      nodeProbes: probes({
        finished: probeFinished({ ok: 0, failed: 2 }),
        results: { n1: failedProbe("n1"), n2: failedProbe("n2") },
      }),
      onProbe: () => {},
    };
    const view = renderStage(base);
    expect(screen.getByText("这次都没测通。")).toBeTruthy();

    view.rerender(
      stageElement({
        ...base,
        config: { ...CONFIG, config_id: "cfg_2" },
        nodeProbes: probes({ results: {} }),
      }),
    );
    expect(screen.queryByText("这次都没测通。")).toBeNull();
    expect(screen.queryByText("这次没测成。")).toBeNull();
  });

  it("切到一套整批未测的配置：显示「这次没测成」，不串台成都没测通", () => {
    const base: StageOverrides = {
      nodeProbes: probes({
        finished: probeFinished({ ok: 0, failed: 2 }),
        results: { n1: failedProbe("n1"), n2: failedProbe("n2") },
      }),
      onProbe: () => {},
    };
    const view = renderStage(base);
    expect(screen.getByText("这次都没测通。")).toBeTruthy();

    view.rerender(
      stageElement({
        ...base,
        config: { ...CONFIG, config_id: "cfg_2" },
        nodeProbes: probes({
          finished: probeFinished({
            configId: "cfg_2",
            ok: 0,
            failed: 0,
            untested: 2,
            method: "none",
          }),
          results: { n1: untestedProbe("n1"), n2: untestedProbe("n2") },
        }),
      }),
    );
    expect(screen.queryByText("这次都没测通。")).toBeNull();
    expect(screen.getByText("这次没测成。")).toBeTruthy();
  });

  it("部分失败：只有失败行标「测不通」，不触发整批失败提示", () => {
    renderStage({
      nodeProbes: probes({
        finished: probeFinished({ ok: 1, failed: 1 }),
        results: { n1: probeResult("n1", 238), n2: failedProbe("n2") },
      }),
      onProbe: () => {},
    });

    expect(screen.queryByText("这次都没测通。")).toBeNull();
    expect(screen.getByRole("button", { name: "测速" })).toBeTruthy();
    const values = [...document.querySelectorAll(".stage-node__ms")].map(
      (node) => node.textContent,
    );
    expect(values).toEqual(["238 毫秒", "测不通"]);
  });

  it("测速状态链：点击 → 立即进行中 → 数值或失败标记", () => {
    const onProbe = vi.fn();
    const base: StageOverrides = { onProbe };
    const view = renderStage({
      ...base,
      nodeProbes: probes({ results: {} }),
    });

    fireEvent.click(screen.getByRole("button", { name: "测速" }));
    expect(onProbe).toHaveBeenCalledTimes(1);

    // 命令刚发出（starting）：入口立刻变成「测速中」且不可再点。
    view.rerender(
      stageElement({ ...base, nodeProbes: probes({ starting: true }) }),
    );
    const busy = screen.getByRole("button", { name: /测速中/ });
    expect((busy as HTMLButtonElement).disabled).toBe(true);

    // 行内也立刻有反馈。
    view.rerender(
      stageElement({
        ...base,
        nodeProbes: probes({ starting: true, probing: new Set(["n1"]) }),
      }),
    );
    expect(
      screen.getAllByRole("option")[0].querySelector(".stage-node__ms")
        ?.textContent,
    ).toBe("测速中");

    // 只回了 n1：n2 还没测，写「未测」。
    view.rerender(
      stageElement({
        ...base,
        nodeProbes: probes({ results: { n1: probeResult("n1", 238) } }),
      }),
    );
    expect(
      [...document.querySelectorAll(".stage-node__ms")].map(
        (node) => node.textContent,
      ),
    ).toEqual(["238 毫秒", "未测"]);

    // 结果回来：clash 与直连都用同一个毫秒格式；失败写「测不通」。
    view.rerender(
      stageElement({
        ...base,
        nodeProbes: probes({
          results: {
            n1: { ...probeResult("n1", 238), probe_method: "clash_delay" },
            n2: {
              ...failedProbe("n2"),
              error: { code: "CLASH_DELAY_FAILED", message: "no such outbound" },
            },
          },
        }),
      }),
    );
    const values = [...document.querySelectorAll(".stage-node__ms")];
    expect(values[0].textContent).toBe("238 毫秒");
    expect(values[1].textContent).toBe("测不通");
    expect(values[1].textContent).not.toBe("未测");
    expect(values[1].getAttribute("title")).toBe("no such outbound");
    // 两种文字态都小一档；数值仍是 13px 读数。
    expect(values[0].classList.contains("is-muted")).toBe(false);
    expect(values[1].classList.contains("is-muted")).toBe(true);

    // 可达却没有数值（契约异常）：按测不通处理，不冒称「未测」。
    view.rerender(
      stageElement({
        ...base,
        nodeProbes: probes({
          results: {
            n1: probeResult("n1", 238),
            n2: { ...probeResult("n2", 1), latency_ms: null },
          },
        }),
      }),
    );
    expect(
      [...document.querySelectorAll(".stage-node__ms")][1].textContent,
    ).toBe("测不通");

    // 没测成（reachable === null）：保持「未测」，不掉进「测不通」。
    view.rerender(
      stageElement({
        ...base,
        nodeProbes: probes({
          results: { n1: probeResult("n1", 238), n2: untestedProbe("n2") },
        }),
      }),
    );
    expect(
      [...document.querySelectorAll(".stage-node__ms")][1].textContent,
    ).toBe("未测");
  });

  it("手动测速后收尾句去掉数字", () => {
    renderStage({
      trialSummary: { configId: "cfg_1", count: 2, fastestMs: 238 },
    });
    expect(screen.getByText(/已加入 2 个免费节点，最快 238ms/)).toBeTruthy();
    cleanup();

    renderStage({
      trialSummary: { configId: "cfg_1", count: 2, fastestMs: 238 },
      manualProbed: true,
    });
    expect(screen.getByText("已加入 2 个免费节点")).toBeTruthy();
    expect(screen.queryByText(/最快 238ms/)).toBeNull();
  });
});

describe("舞台快捷切换", () => {
  const proxyConfig: ConfigDetail = { ...CONFIG, connect_mode: "system_proxy" };

  function openModeLayer() {
    fireEvent.click(
      screen.getByRole("button", { name: "接管方式，当前 Proxy 模式" }),
    );
  }

  it("只在有节点时出现，初始不展开", () => {
    renderStage({
      routingMode: "direct",
      onSetConnectMode: async () => ({ ok: true }),
      onSetRoutingMode: async () => ({ ok: true }),
    });
    expect(
      screen.getByRole("button", { name: "接管方式，当前 Tun 模式" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "流量范围，当前 智能" }),
    ).toBeTruthy();
    expect(screen.queryByRole("listbox", { name: "接管方式" })).toBeNull();
    cleanup();

    renderStage({
      config: { ...proxyConfig, nodes: [], node_count: 0 },
      routingMode: "direct",
      onSetConnectMode: async () => ({ ok: true }),
      onSetRoutingMode: async () => ({ ok: true }),
    });
    expect(screen.queryByRole("button", { name: /接管方式/ })).toBeNull();
  });

  it("点 chip 只展开，不调用切换", () => {
    const onSetConnectMode = vi.fn(async () => ({ ok: true }));
    renderStage({
      config: proxyConfig,
      routingMode: "direct",
      onSetConnectMode,
      onSetRoutingMode: async () => ({ ok: true }),
    });

    openModeLayer();

    expect(screen.getByRole("listbox", { name: "接管方式" })).toBeTruthy();
    expect(
      screen.getByRole("option", { name: "Proxy 模式" }),
    ).toBeTruthy();
    expect(screen.getByRole("option", { name: "Tun 模式" })).toBeTruthy();
    expect(onSetConnectMode).not.toHaveBeenCalled();
    // 再点同一个 chip 收起。
    openModeLayer();
    expect(screen.queryByRole("listbox", { name: "接管方式" })).toBeNull();
  });

  it("接管方式选定目标值：先确认，确认后才调用", async () => {
    const onSetConnectMode = vi.fn(async () => ({ ok: true }));
    renderStage({
      config: proxyConfig,
      routingMode: "direct",
      onSetConnectMode,
      onSetRoutingMode: async () => ({ ok: true }),
    });

    openModeLayer();
    fireEvent.click(screen.getByRole("option", { name: "Tun 模式" }));

    expect(
      screen.getByText(
        "切到 Tun 模式？接管全部软件；首次使用需要系统授权。",
      ),
    ).toBeTruthy();
    expect(onSetConnectMode).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "继续" }));

    await waitFor(() =>
      expect(onSetConnectMode).toHaveBeenCalledWith(
        "tun",
        expect.objectContaining({ onRestoring: expect.any(Function) }),
      ),
    );
    expect(await screen.findByText("已切到 Tun 模式")).toBeTruthy();
  });

  it("流量范围选定后立即热切，不等确认", async () => {
    const onSetRoutingMode = vi.fn(async () => ({ ok: true }));
    renderStage({
      config: proxyConfig,
      routingMode: "direct",
      onSetConnectMode: async () => ({ ok: true }),
      onSetRoutingMode,
    });

    fireEvent.click(
      screen.getByRole("button", { name: "流量范围，当前 智能" }),
    );
    expect(screen.getByRole("listbox", { name: "流量范围" })).toBeTruthy();
    fireEvent.click(screen.getByRole("option", { name: "全局" }));

    await waitFor(() => expect(onSetRoutingMode).toHaveBeenCalledWith("proxy_all"));
    expect(await screen.findByText("已切到全局")).toBeTruthy();
    expect(screen.queryByRole("listbox", { name: "接管方式" })).toBeNull();
    // 不弹确认条。
    expect(screen.queryByRole("button", { name: "继续" })).toBeNull();
  });

  it("选中当前值：只关层，不发命令", () => {
    const onSetConnectMode = vi.fn(async () => ({ ok: true }));
    const onSetRoutingMode = vi.fn(async () => ({ ok: true }));
    renderStage({
      config: proxyConfig,
      routingMode: "direct",
      onSetConnectMode,
      onSetRoutingMode,
    });

    openModeLayer();
    fireEvent.click(screen.getByRole("option", { name: "Proxy 模式" }));

    expect(screen.queryByRole("listbox", { name: "接管方式" })).toBeNull();
    expect(screen.queryByRole("button", { name: "继续" })).toBeNull();
    expect(onSetConnectMode).not.toHaveBeenCalled();
  });

  it("Esc 与点层外都能关闭选择层", () => {
    renderStage({
      config: proxyConfig,
      routingMode: "direct",
      onSetConnectMode: async () => ({ ok: true }),
      onSetRoutingMode: async () => ({ ok: true }),
    });

    openModeLayer();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("listbox", { name: "接管方式" })).toBeNull();
    // 焦点回到打开它的 chip。
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "接管方式，当前 Proxy 模式" }),
    );

    openModeLayer();
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("listbox", { name: "接管方式" })).toBeNull();
  });

  it("同时只开一个选择层", () => {
    renderStage({
      config: proxyConfig,
      routingMode: "direct",
      onSetConnectMode: async () => ({ ok: true }),
      onSetRoutingMode: async () => ({ ok: true }),
    });

    openModeLayer();
    expect(screen.getByRole("listbox", { name: "接管方式" })).toBeTruthy();

    fireEvent.click(
      screen.getByRole("button", { name: "流量范围，当前 智能" }),
    );

    expect(screen.queryByRole("listbox", { name: "接管方式" })).toBeNull();
    expect(screen.getByRole("listbox", { name: "流量范围" })).toBeTruthy();
  });

  it("确认后进入进行中态，成功后播报", async () => {
    let release: (value: { ok: boolean }) => void = () => {};
    const pending = new Promise<{ ok: boolean }>((resolve) => {
      release = resolve;
    });
    const onSetConnectMode = vi.fn(() => pending);
    renderStage({
      config: proxyConfig,
      routingMode: "direct",
      onSetConnectMode,
      onSetRoutingMode: async () => ({ ok: true }),
    });

    openModeLayer();
    fireEvent.click(screen.getByRole("option", { name: "Tun 模式" }));
    fireEvent.click(screen.getByRole("button", { name: "继续" }));

    const busy = await screen.findByText("正在切换到 Tun 模式…");
    expect(busy.closest("[aria-busy=\"true\"]")).not.toBeNull();
    expect(screen.queryByRole("button", { name: /接管方式/ })).toBeNull();

    release({ ok: true });

    expect(await screen.findByText("已切到 Tun 模式")).toBeTruthy();
  });

  it("失败回退后标签仍是 Proxy，并说明已回到 Proxy 模式", async () => {
    renderStage({
      config: proxyConfig,
      routingMode: "direct",
      onSetConnectMode: async () => ({ ok: false, restored: true }),
      onSetRoutingMode: async () => ({ ok: true }),
    });

    openModeLayer();
    fireEvent.click(screen.getByRole("option", { name: "Tun 模式" }));
    fireEvent.click(screen.getByRole("button", { name: "继续" }));

    expect(
      await screen.findByText("没能切换到 Tun 模式，已回到 Proxy 模式。"),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "接管方式，当前 Proxy 模式" }),
    ).toBeTruthy();
  });

  it("回滚失败：说明连接已断开，不写「已回到」", async () => {
    renderStage({
      config: proxyConfig,
      routingMode: "direct",
      onSetConnectMode: async () => ({ ok: false, restored: false }),
      onSetRoutingMode: async () => ({ ok: true }),
    });

    openModeLayer();
    fireEvent.click(screen.getByRole("option", { name: "Tun 模式" }));
    fireEvent.click(screen.getByRole("button", { name: "继续" }));

    expect(
      await screen.findByText("没能切换到 Tun 模式，连接已断开。"),
    ).toBeTruthy();
    expect(screen.queryByText(/已回到 Proxy 模式/)).toBeNull();
  });

  it("回滚结果与库值都未知：只说连接状态未知", async () => {
    renderStage({
      config: proxyConfig,
      routingMode: "direct",
      onSetConnectMode: async () => ({
        ok: false,
        restored: null,
        actualMode: null,
      }),
      onSetRoutingMode: async () => ({ ok: true }),
    });

    openModeLayer();
    fireEvent.click(screen.getByRole("option", { name: "Tun 模式" }));
    fireEvent.click(screen.getByRole("button", { name: "继续" }));

    expect(
      await screen.findByText("没能切换到 Tun 模式，连接状态未知。"),
    ).toBeTruthy();
    expect(screen.queryByText(/已回到/)).toBeNull();
    expect(screen.queryByText(/连接已断开/)).toBeNull();
  });

  it("连接中接管方式禁用，流量范围仍可展开", () => {
    renderStage({
      config: proxyConfig,
      routingMode: "direct",
      connection: "starting",
      runtime: runtime({ state: "starting" }),
      onSetConnectMode: async () => ({ ok: true }),
      onSetRoutingMode: async () => ({ ok: true }),
    });

    expect(
      (
        screen.getByRole("button", {
          name: "接管方式，当前 Proxy 模式",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(
      (
        screen.getByRole("button", {
          name: "流量范围，当前 智能",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false);
  });

  it("旧数据的 proxy_selected：不渲染流量范围入口", () => {
    renderStage({
      config: proxyConfig,
      routingMode: "proxy_selected",
      onSetConnectMode: async () => ({ ok: true }),
      onSetRoutingMode: async () => ({ ok: true }),
    });

    expect(
      screen.getByRole("button", { name: "接管方式，当前 Proxy 模式" }),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: /流量范围/ })).toBeNull();
  });

  it("键盘：打开后焦点在当前值，↑↓ 移动，Enter 选定", () => {
    const onSetConnectMode = vi.fn(async () => ({ ok: true }));
    renderStage({
      config: proxyConfig,
      routingMode: "direct",
      onSetConnectMode,
      onSetRoutingMode: async () => ({ ok: true }),
    });

    openModeLayer();
    const current = screen.getByRole("option", { name: "Proxy 模式" });
    expect(document.activeElement).toBe(current);

    fireEvent.keyDown(current, { key: "ArrowDown" });
    const tun = screen.getByRole("option", { name: "Tun 模式" });
    expect(document.activeElement).toBe(tun);

    fireEvent.keyDown(tun, { key: "ArrowUp" });
    expect(document.activeElement).toBe(current);

    fireEvent.keyDown(current, { key: "ArrowDown" });
    fireEvent.keyDown(tun, { key: "Enter" });

    // 选定 Tun 先出确认条，还没有发命令。
    expect(
      screen.getByText("切到 Tun 模式？接管全部软件；首次使用需要系统授权。"),
    ).toBeTruthy();
    expect(onSetConnectMode).not.toHaveBeenCalled();
  });

  it("Tab 关闭选择层", () => {
    renderStage({
      config: proxyConfig,
      routingMode: "direct",
      onSetConnectMode: async () => ({ ok: true }),
      onSetRoutingMode: async () => ({ ok: true }),
    });

    openModeLayer();
    expect(screen.getByRole("listbox", { name: "接管方式" })).toBeTruthy();
    fireEvent.keyDown(document.activeElement ?? window, { key: "Tab" });
    expect(
      screen.queryByRole("listbox", { name: "接管方式" }),
    ).toBeNull();
  });

  it("选中当前值：焦点回到各自的 chip", () => {
    renderStage({
      config: proxyConfig,
      routingMode: "direct",
      onSetConnectMode: async () => ({ ok: true }),
      onSetRoutingMode: async () => ({ ok: true }),
    });

    openModeLayer();
    fireEvent.click(screen.getByRole("option", { name: "Proxy 模式" }));
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "接管方式，当前 Proxy 模式" }),
    );

    fireEvent.click(
      screen.getByRole("button", { name: "流量范围，当前 智能" }),
    );
    fireEvent.click(screen.getByRole("option", { name: "智能" }));
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "流量范围，当前 智能" }),
    );
  });

  it("流量范围切换生效后焦点回到 chip", async () => {
    renderStage({
      config: proxyConfig,
      routingMode: "direct",
      onSetConnectMode: async () => ({ ok: true }),
      onSetRoutingMode: async () => ({ ok: true }),
    });

    fireEvent.click(
      screen.getByRole("button", { name: "流量范围，当前 智能" }),
    );
    fireEvent.click(screen.getByRole("option", { name: "全局" }));

    await screen.findByText("已切到全局");
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "流量范围，当前 智能" }),
    );
  });

});

describe("报告问题入口", () => {
  it("正常状态不出现；failed 与 noTraffic 出现", async () => {
    const onReport = vi.fn();
    renderStage({ onReportProblem: onReport });
    expect(screen.queryByRole("button", { name: "报告问题" })).toBeNull();
    cleanup();

    renderStage({
      runtime: runtime({
        state: "failed",
        last_error: {
          contract_version: "2.15.0",
          code: "INTERNAL",
          message: "装环境超时。",
          retryable: true,
          details: null,
          request_id: "req_1",
        },
      }),
      onReportProblem: onReport,
    });
    expect(
      await screen.findByRole("button", { name: "报告问题" }),
    ).toBeTruthy();
    cleanup();

    // 连上了但没流量：同样是需要报告的失败态。
    renderStage({
      connection: "connected",
      runtime: runtime({
        state: "running",
        connected_since: new Date(Date.now() - 5000).toISOString(),
        health: {
          ...emptyRuntimeView().health,
          data_plane: false,
          checked_at: new Date().toISOString(),
        },
      }),
      onReportProblem: onReport,
    });
    expect(
      await screen.findByRole("button", { name: "报告问题" }),
    ).toBeTruthy();
  });

  it("失败态下切换接管方式失败：报告问题只留一处", async () => {
    const onReport = vi.fn();
    renderStage({
      runtime: runtime({ state: "failed" }),
      onReportProblem: onReport,
      onSetConnectMode: async () => ({ ok: false, restored: true }),
      onSetRoutingMode: async () => ({ ok: true }),
    });

    fireEvent.click(
      screen.getByRole("button", { name: "接管方式，当前 Tun 模式" }),
    );
    fireEvent.click(screen.getByRole("option", { name: "Proxy 模式" }));

    await screen.findByText("没能切换到 Proxy 模式，已回到 Tun 模式。");
    expect(screen.getAllByRole("button", { name: "报告问题" })).toHaveLength(1);
  });
});

describe("混池节点卡：试用 + 自建", () => {
  const OWNED: ConfigDetail["nodes"][number] = {
    node_id: "o1",
    name: "东京 1 号",
    server: "198.51.100.1",
    port: 8388,
    method: "aes-256-gcm",
    protocol: "shadowsocks",
    source: "owned",
    created_at: 0,
  };
  const FREE: ConfigDetail["nodes"][number] = {
    node_id: "f2",
    name: "洛杉矶 02",
    server: "203.0.113.9",
    port: 8388,
    method: "aes-256-gcm",
    protocol: "shadowsocks",
    source: "seed",
    created_at: 0,
  };
  const CUSTOM: ConfigDetail["nodes"][number] = {
    node_id: "c3",
    name: "自建 03",
    server: "192.0.2.30",
    port: 8388,
    method: "aes-256-gcm",
    protocol: "shadowsocks",
    source: "manual",
    created_at: 0,
  };

  function configWith(nodes: ConfigDetail["nodes"]): ConfigDetail {
    return {
      ...CONFIG,
      name: "免费节点",
      node_count: nodes.length,
      current_node_id: nodes[0]?.node_id ?? null,
      nodes,
    };
  }

  it("卡片标题固定为节点，不再用配置名", () => {
    renderStage({ config: configWith([OWNED, FREE]) });

    const card = document.querySelector(".stage-card");
    expect(card?.getAttribute("aria-label")).toBe("节点");
    expect(screen.getByRole("heading", { name: "节点" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "免费节点" })).toBeNull();
  });

  it("两类同池：自建组在前、免费组在后，副行只写数量", () => {
    renderStage({ config: configWith([FREE, OWNED]) });

    const groups = screen.getAllByRole("group");
    expect(groups.map((group) => group.getAttribute("aria-label"))).toEqual([
      "我的服务器",
      "免费节点",
    ]);
    expect(within(groups[0]).getByText("东京 1 号")).toBeTruthy();
    expect(within(groups[1]).getByText("洛杉矶 02")).toBeTruthy();
    expect(within(groups[1]).getByText("试用中")).toBeTruthy();
    expect(within(groups[0]).queryByText("试用中")).toBeNull();

    expect(screen.getByText("2 个节点")).toBeTruthy();
    expect(screen.queryByText(/7 天试用/)).toBeNull();
  });

  it("只有一类时只出现那一组的标题，组头不再重复试用 hint", () => {
    const { rerender } = renderStage();
    expect(
      screen.getAllByRole("group").map((group) => group.getAttribute("aria-label")),
    ).toEqual(["免费节点"]);
    expect(screen.getByText("2 个节点 · 7 天试用")).toBeTruthy();
    expect(screen.queryByText("试用中")).toBeNull();

    rerender(stageElement({ config: configWith([OWNED]) }));
    expect(
      screen.getAllByRole("group").map((group) => group.getAttribute("aria-label")),
    ).toEqual(["我的服务器"]);
    expect(screen.getByText("1 个节点")).toBeTruthy();
  });

  it("只有自定义节点时只出现「你自己的节点」一组，行内保留「自定义」小标", () => {
    renderStage({ config: configWith([CUSTOM]) });

    const groups = screen.getAllByRole("group");
    expect(groups.map((group) => group.getAttribute("aria-label"))).toEqual([
      "你自己的节点",
    ]);
    expect(within(groups[0]).getByText("自建 03")).toBeTruthy();
    expect(within(groups[0]).getByText("自定义")).toBeTruthy();
  });

  it("三类同池：服务器 → 自己的节点 → 免费，自定义小标只在第二组", () => {
    renderStage({ config: configWith([FREE, CUSTOM, OWNED]) });

    const groups = screen.getAllByRole("group");
    expect(groups.map((group) => group.getAttribute("aria-label"))).toEqual([
      "我的服务器",
      "你自己的节点",
      "免费节点",
    ]);
    expect(within(groups[0]).getByText("东京 1 号")).toBeTruthy();
    expect(within(groups[0]).queryByText("自定义")).toBeNull();
    expect(within(groups[1]).getByText("自建 03")).toBeTruthy();
    expect(within(groups[1]).getByText("自定义")).toBeTruthy();
    expect(within(groups[2]).getByText("洛杉矶 02")).toBeTruthy();
    expect(within(groups[2]).queryByText("自定义")).toBeNull();
  });

  it("三类 + 待接入行：待接入行排在「我的服务器」组末尾，另外两组不受影响", () => {
    renderStage({
      config: configWith([FREE, CUSTOM, OWNED]),
      pendingServerNodes: [{ nodeId: "local_pending", name: "待接入机器" }],
    });

    const groups = screen.getAllByRole("group");
    expect(groups.map((group) => group.getAttribute("aria-label"))).toEqual([
      "我的服务器",
      "你自己的节点",
      "免费节点",
    ]);
    const ownedOptions = groups[0].querySelectorAll('[role="option"]');
    expect(ownedOptions).toHaveLength(2);
    expect(ownedOptions[0].textContent).toContain("东京 1 号");
    expect(ownedOptions[ownedOptions.length - 1].textContent).toContain("待接入机器");
    expect(groups[1].querySelectorAll('[role="option"]')).toHaveLength(1);
    expect(within(groups[1]).getByText("自建 03")).toBeTruthy();
    expect(groups[2].querySelectorAll('[role="option"]')).toHaveLength(1);
    expect(within(groups[2]).getByText("洛杉矶 02")).toBeTruthy();
  });

  it("免费组节点被清理后只剩自建：免费组整组消失", () => {
    const { rerender } = renderStage({ config: configWith([OWNED, FREE]) });
    expect(screen.getAllByRole("group")).toHaveLength(2);

    rerender(stageElement({ config: configWith([OWNED]) }));
    expect(
      screen.getAllByRole("group").map((group) => group.getAttribute("aria-label")),
    ).toEqual(["我的服务器"]);
    expect(screen.queryByText("免费节点")).toBeNull();
    expect(screen.queryByText("试用中")).toBeNull();
    expect(screen.getByText("东京 1 号")).toBeTruthy();
    expect(screen.getByText("1 个节点")).toBeTruthy();
  });

  it("免费组标题接线共用口径：倒计时 / 试用中 / 已到期三态互斥", () => {
    const inDays = (days: number) =>
      new Date(Date.now() + days * 86_400_000).toISOString();
    const hintText = () =>
      document.querySelector(".stage-node-group__hint")?.textContent;

    // 取整与边界由 labels.test.ts 统一钉住，这里只验证组标题确实读那份口径。
    const { rerender } = renderStage({
      config: configWith([OWNED, FREE]),
      trialExpiresAt: inDays(3.2),
    });
    expect(hintText()).toBe("3 天后到期");
    expect(hintText()).not.toBe("试用中");
    expect(hintText()).not.toBe("已到期");

    rerender(
      stageElement({ config: configWith([OWNED, FREE]), trialExpiresAt: null }),
    );
    expect(hintText()).toBe("试用中");
    expect(hintText()).not.toContain("天后到期");

    rerender(
      stageElement({
        config: configWith([OWNED, FREE]),
        trialExpiresAt: "not-a-date",
      }),
    );
    expect(hintText()).toBe("试用中");

    rerender(
      stageElement({
        config: configWith([OWNED, FREE]),
        trialExpiresAt: inDays(-0.1),
      }),
    );
    expect(hintText()).toBe("已到期");
    expect(hintText()).not.toContain("天后到期");
  });

  it("最快标记仍在免费组的行内，不进组标题", () => {
    renderStage({
      config: configWith([OWNED, FREE]),
      nodeProbes: probes({
        results: { o1: probeResult("o1", 90), f2: probeResult("f2", 42) },
      }),
      preselect: { configId: "cfg_1", nodeId: "f2", nonce: 1, markFastest: true },
    });

    const groups = screen.getAllByRole("group");
    const freeGroup = groups[1];
    expect(freeGroup.querySelector(".stage-node-group__head .stage-node__fastest")).toBeNull();
    expect(
      within(freeGroup as HTMLElement)
        .getAllByRole("option")[0]
        .querySelector(".stage-node__fastest")?.textContent,
    ).toBe("最快");
  });

  it("选中的自建节点测不通：给线路提示；整批测完失败时两行并存", () => {
    const view = renderStage({
      config: configWith([OWNED]),
      nodeProbes: probes({ results: { o1: failedProbe("o1") } }),
    });

    expect(
      screen.getAllByText(/你当前的网络到那个地区的线路不通很常见/),
    ).toHaveLength(1);

    // 真实点完测速：整批失败提示与线路提示同时出现，文字可分辨。
    view.rerender(
      stageElement({
        config: configWith([OWNED]),
        nodeProbes: probes({
          finished: probeFinished({ ok: 0, failed: 1, total: 1 }),
          results: { o1: failedProbe("o1") },
        }),
      }),
    );
    expect(screen.getByText("这次都没测通。")).toBeTruthy();
    expect(screen.getAllByText(/线路不通很常见/)).toHaveLength(1);
    expect(document.querySelectorAll(".stage-card__probe-note")).toHaveLength(2);
  });

  it("免费节点测不通、或自建节点只是没测成：不给线路提示", () => {
    renderStage({
      config: configWith([FREE]),
      nodeProbes: probes({ results: { f2: failedProbe("f2") } }),
    });
    expect(screen.queryByText(/线路不通很常见/)).toBeNull();
    cleanup();

    renderStage({
      config: configWith([OWNED]),
      nodeProbes: probes({ results: { o1: untestedProbe("o1") } }),
    });
    expect(screen.queryByText(/线路不通很常见/)).toBeNull();
  });

  it("只按选中的那台判断：别的自建节点失败不算", () => {
    const OTHER: ConfigDetail["nodes"][number] = {
      ...OWNED,
      node_id: "o2",
      name: "大阪 2 号",
    };

    // 选中的是免费节点，另一台自建失败：不提示。
    renderStage({
      config: configWith([FREE, OTHER]),
      nodeProbes: probes({
        results: { f2: probeResult("f2", 50), o2: failedProbe("o2") },
      }),
    });
    expect(screen.queryByText(/线路不通很常见/)).toBeNull();
    cleanup();

    // 选中的自建没测成，另一台自建失败：不提示。
    renderStage({
      config: configWith([OWNED, OTHER]),
      nodeProbes: probes({
        results: { o1: untestedProbe("o1"), o2: failedProbe("o2") },
      }),
    });
    expect(screen.queryByText(/线路不通很常见/)).toBeNull();
    cleanup();

    // 反过来：选中的自建失败，另一台没测成：提示。
    renderStage({
      config: configWith([OWNED, OTHER]),
      nodeProbes: probes({
        results: { o1: failedProbe("o1"), o2: untestedProbe("o2") },
      }),
    });
    expect(screen.getAllByText(/线路不通很常见/)).toHaveLength(1);
  });
});

describe("免费节点到期后就地拒绝", () => {
  const OWNED: ConfigDetail["nodes"][number] = {
    node_id: "o1",
    name: "东京 1 号",
    server: "198.51.100.1",
    port: 8388,
    method: "aes-256-gcm",
    protocol: "shadowsocks",
    source: "owned",
    created_at: 0,
  };
  const FREE: ConfigDetail["nodes"][number] = {
    node_id: "f2",
    name: "洛杉矶 02",
    server: "203.0.113.9",
    port: 8388,
    method: "aes-256-gcm",
    protocol: "shadowsocks",
    source: "seed",
    created_at: 0,
  };

  function configWith(
    nodes: ConfigDetail["nodes"],
    current: string | null = nodes[0]?.node_id ?? null,
  ): ConfigDetail {
    return { ...CONFIG, node_count: nodes.length, current_node_id: current, nodes };
  }

  const inHours = (hours: number) =>
    new Date(Date.now() + hours * 3_600_000).toISOString();

  it("过期 seed 行禁用、副行写已到期，点了不发任何请求", () => {
    const onSwitchNode = vi.fn(async () => ({ ok: true as const }));
    const onStart = vi.fn();
    renderStage({
      config: configWith([OWNED, FREE], FREE.node_id),
      trialExpiresAt: inHours(-1),
      onSwitchNode,
      onStart,
    });

    const freeRow = screen.getAllByRole("option")[1] as HTMLElement;
    expect(freeRow.getAttribute("aria-disabled")).toBe("true");
    expect(freeRow.classList.contains("is-expired")).toBe(true);
    expect(freeRow.querySelector(".stage-node__sub")?.textContent).toBe("已到期");

    fireEvent.click(freeRow);
    expect(onSwitchNode).not.toHaveBeenCalled();
    expect(onStart).not.toHaveBeenCalled();
  });

  it("当前选中是过期行：主按钮禁用并给说明，换成自建后恢复", () => {
    renderStage({
      config: configWith([OWNED, FREE], FREE.node_id),
      trialExpiresAt: inHours(-1),
    });

    const blocked = screen.getByRole("button", {
      name: "连接节点",
    }) as HTMLButtonElement;
    expect(blocked.disabled).toBe(true);
    expect(
      screen.getByText("当前节点已到期，换一个节点再连接。"),
    ).toBeTruthy();

    fireEvent.click(screen.getAllByRole("option")[0]);
    expect(
      screen.queryByText("当前节点已到期，换一个节点再连接。"),
    ).toBeNull();
    expect(
      (
        screen.getByRole("button", {
          name: "连接节点",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false);
  });

  it("已连接时自建节点照旧可切换，断开按钮不受影响", () => {
    const onSwitchNode = vi.fn(async () => ({ ok: true as const }));
    renderStage({
      config: configWith([OWNED, FREE], OWNED.node_id),
      connection: "connected",
      runtime: runtime({
        state: "running",
        connected_since: new Date(Date.now() - 5000).toISOString(),
        health: {
          ...emptyRuntimeView().health,
          data_plane: true,
          checked_at: new Date().toISOString(),
        },
      }),
      trialExpiresAt: inHours(-1),
      onSwitchNode,
    });

    const [ownedRow, freeRow] = screen.getAllByRole("option") as HTMLElement[];
    expect(ownedRow.getAttribute("aria-disabled")).toBeNull();
    expect(freeRow.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(freeRow);
    expect(onSwitchNode).not.toHaveBeenCalled();
    expect(
      (screen.getByRole("button", { name: "断开连接" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
  });

  it("整池都过期：说明不指向不存在的替代节点", () => {
    renderStage({
      config: configWith([FREE], FREE.node_id),
      trialExpiresAt: inHours(-1),
    });

    expect(
      screen.getByText("试用已到期，免费节点已不可用。"),
    ).toBeTruthy();
    expect(
      screen.queryByText("当前节点已到期，换一个节点再连接。"),
    ).toBeNull();
  });

  it("已连接、当前正是过期 seed：主按钮仍是可点的断开", async () => {
    const onStop = vi.fn();
    renderStage({
      config: configWith([OWNED, FREE], FREE.node_id),
      connection: "connected",
      runtime: runtime({
        state: "running",
        connected_since: new Date(Date.now() - 5000).toISOString(),
        health: {
          ...emptyRuntimeView().health,
          data_plane: true,
          checked_at: new Date().toISOString(),
        },
      }),
      trialExpiresAt: inHours(-1),
      onStop,
    });

    await screen.findAllByText("已连接");
    const disconnect = screen.getByRole("button", {
      name: "断开连接",
    }) as HTMLButtonElement;
    expect(disconnect.disabled).toBe(false);
    fireEvent.click(disconnect);
    expect(onStop).toHaveBeenCalledTimes(1);
    expect(
      screen.queryByText("当前节点已到期，换一个节点再连接。"),
    ).toBeNull();
  });

  it("到期前 1 小时的种子节点仍可点", () => {
    const onSwitchNode = vi.fn(async () => ({ ok: true as const }));
    renderStage({
      config: configWith([OWNED, FREE], OWNED.node_id),
      trialExpiresAt: inHours(1),
      onSwitchNode,
    });

    const freeRow = screen.getAllByRole("option")[1] as HTMLElement;
    expect(freeRow.getAttribute("aria-disabled")).toBeNull();
    expect(freeRow.classList.contains("is-expired")).toBe(false);
    expect(freeRow.querySelector(".stage-node__sub")).toBeNull();

    fireEvent.click(freeRow);
    expect(freeRow.getAttribute("aria-selected")).toBe("true");
  });
});

describe("待接入的服务器节点", () => {
  const OWNED: ConfigDetail["nodes"][number] = {
    node_id: "o1",
    name: "东京 1 号",
    server: "198.51.100.1",
    port: 8388,
    method: "aes-256-gcm",
    protocol: "shadowsocks",
    source: "owned",
    created_at: 0,
  };
  const FREE: ConfigDetail["nodes"][number] = {
    node_id: "f2",
    name: "洛杉矶 02",
    server: "203.0.113.9",
    port: 8388,
    method: "aes-256-gcm",
    protocol: "shadowsocks",
    source: "seed",
    created_at: 0,
  };

  function configWith(
    nodes: ConfigDetail["nodes"],
    over: Partial<ConfigDetail> = {},
  ): ConfigDetail {
    return {
      ...CONFIG,
      node_count: nodes.length,
      current_node_id: nodes[0]?.node_id ?? null,
      nodes,
      ...over,
    };
  }

  it("渲染成禁用行，位于「我的服务器」组末尾且带「重新连接后可用」", () => {
    const onSwitchNode = vi.fn(async () => ({ ok: true as const }));
    renderStage({
      // node_count 故意写 3：顶部计数只能来自可用节点数，不能读这个字段。
      config: configWith([FREE, OWNED], { node_count: 3 }),
      pendingServerNodes: [{ nodeId: "local_pending", name: "你的服务器4gUQ" }],
      onSwitchNode,
    });

    const ownedGroup = screen.getByRole("group", { name: "我的服务器" });
    const pendingRow = within(ownedGroup)
      .getByText("你的服务器4gUQ")
      .closest(".stage-node") as HTMLElement;
    expect(pendingRow).toBeTruthy();
    // 灰显、不可点、不是按钮：选中态只看配置里的节点。
    expect(pendingRow.classList.contains("is-pending")).toBe(true);
    expect(pendingRow.getAttribute("aria-disabled")).toBe("true");
    // 键盘不可达：没有 tabindex，Tab 会跳过它。
    expect(pendingRow.getAttribute("tabindex")).toBeNull();
    expect(pendingRow.tagName).not.toBe("BUTTON");
    expect(within(pendingRow).getByText("重新连接后可用")).toBeTruthy();
    // 排在可用节点后面。
    const rows = within(ownedGroup).getAllByRole("option");
    expect(rows[rows.length - 1]).toBe(pendingRow);
    // 计数只算可用节点，待接入不计入。
    expect(screen.getByText("2 个节点")).toBeTruthy();

    fireEvent.click(pendingRow);
    expect(onSwitchNode).not.toHaveBeenCalled();
  });

  it("节点已在配置里时只保留正常行，同一 id 的待接入行不重复", () => {
    renderStage({
      config: configWith([FREE, OWNED]),
      pendingServerNodes: [
        { nodeId: OWNED.node_id, name: "已入池的服务器" },
        { nodeId: "local_dup", name: "同一台服务器" },
        { nodeId: "local_dup", name: "同一台服务器" },
      ],
    });

    expect(screen.queryByText("已入池的服务器")).toBeNull();
    expect(screen.getAllByText("东京 1 号")).toHaveLength(1);
    expect(screen.getAllByText("同一台服务器")).toHaveLength(1);
    // 去重后只剩一条待接入行。
    expect(screen.getAllByText("重新连接后可用")).toHaveLength(1);
    // 2 个可用节点 + 1 个待接入行。
    expect(screen.getAllByRole("option")).toHaveLength(3);
  });
});

describe("隧道在跑但没有可用节点", () => {
  const EMPTY: ConfigDetail = {
    ...CONFIG,
    nodes: [],
    node_count: 0,
    current_node_id: null,
  };

  it("running + 没有任何节点：主按钮是「断开」，点它停掉隧道", async () => {
    const onStop = vi.fn();
    const onReconnect = vi.fn();
    renderStage({
      config: EMPTY,
      connection: "connected",
      runtime: runtime({
        state: "running",
        connected_since: new Date(Date.now() - 5000).toISOString(),
        health: {
          ...emptyRuntimeView().health,
          data_plane: false,
          checked_at: new Date().toISOString(),
        },
      }),
      onStop,
      onReconnect,
    });

    await screen.findAllByText("已连接，不通");
    // 指路文案跟着按钮走：没有节点可换，就不再叫用户点不存在的「重新连接」。
    expect(
      screen.getByText("没有可用节点了，点「断开」停掉隧道，再去处理节点。"),
    ).toBeTruthy();
    expect(screen.queryByText(/点上面的「重新连接」/)).toBeNull();
    const primary = screen.getByRole("button", {
      name: "断开连接",
    }) as HTMLButtonElement;
    expect(primary.disabled).toBe(false);
    expect(screen.queryByRole("button", { name: "重新连接" })).toBeNull();

    fireEvent.click(primary);
    expect(onStop).toHaveBeenCalledTimes(1);
    expect(onReconnect).not.toHaveBeenCalled();
  });

  it("running + 有可用节点 + 不通：仍然是「重新连接」", async () => {
    const onStop = vi.fn();
    const onReconnect = vi.fn();
    renderStage({
      connection: "connected",
      runtime: runtime({
        state: "running",
        connected_since: new Date(Date.now() - 5000).toISOString(),
        health: {
          ...emptyRuntimeView().health,
          data_plane: false,
          checked_at: new Date().toISOString(),
        },
      }),
      onStop,
      onReconnect,
    });

    await screen.findAllByText("已连接，不通");
    // 有可用节点：指路文案保持原文案（sr-only 与可见段同句，段里查一次就够）。
    expect(
      document.querySelector(".stage-note")?.textContent,
    ).toContain("点上面的「重新连接」");
    fireEvent.click(screen.getByRole("button", { name: "重新连接" }));
    expect(onReconnect).toHaveBeenCalledTimes(1);
    expect(onStop).not.toHaveBeenCalled();
  });

  it("没有任何节点：主按钮是按规则禁用的「连接」", () => {
    const onStart = vi.fn();
    renderStage({ config: EMPTY, onStart });

    expect(screen.getByText("这条配置没有节点了")).toBeTruthy();
    const primary = screen.getByRole("button", {
      name: "连接节点",
    }) as HTMLButtonElement;
    expect(primary.disabled).toBe(true);
    fireEvent.click(primary);
    expect(onStart).not.toHaveBeenCalled();
  });

  it("目标不可用但池里还有别的节点：指路先说断开再选一个", async () => {
    const DEAD: ConfigDetail["nodes"][number] = {
      node_id: "local_9",
      name: "东京 9 号",
      server: "198.51.100.9",
      port: 8388,
      method: "aes-256-gcm",
      protocol: "shadowsocks",
      source: "owned",
      created_at: 0,
    };
    const ALIVE: ConfigDetail["nodes"][number] = {
      ...DEAD,
      node_id: "local_8",
      name: "大阪 8 号",
    };
    renderStage({
      config: {
        ...CONFIG,
        node_count: 2,
        current_node_id: DEAD.node_id,
        nodes: [DEAD, ALIVE],
      },
      connection: "connected",
      danglingNodeIds: new Set([DEAD.node_id]),
      runtime: runtime({
        state: "running",
        connected_since: new Date(Date.now() - 5000).toISOString(),
        health: {
          ...emptyRuntimeView().health,
          data_plane: false,
          checked_at: new Date().toISOString(),
        },
      }),
    });

    await screen.findAllByText("已连接，不通");
    expect(
      screen.getByText("先点「断开」停掉隧道，再选一个节点连接。"),
    ).toBeTruthy();
    expect(screen.queryByText(/没有可用节点了/)).toBeNull();
    expect(
      (screen.getByRole("button", { name: "断开连接" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
  });

  it("0 个节点但有待接入行：不写「这条配置没有节点了」", () => {
    renderStage({
      config: EMPTY,
      pendingServerNodes: [{ nodeId: "local_pending", name: "你的服务器4gUQ" }],
    });

    expect(screen.queryByText("这条配置没有节点了")).toBeNull();
    expect(screen.getByText("重新连接后可用")).toBeTruthy();
  });

  it("失败态：没有目标行时次级「重新连接」也禁用", () => {
    const onStart = vi.fn();
    renderStage({
      config: EMPTY,
      runtime: runtime({ state: "failed" }),
      onStart,
    });

    const again = document.querySelector(
      "button.stage-secondary",
    ) as HTMLButtonElement;
    expect(again.textContent).toBe("重新连接");
    expect(again.disabled).toBe(true);
    fireEvent.click(again);
    expect(onStart).not.toHaveBeenCalled();
  });
});

describe("停机删除的悬挂节点", () => {
  const DEAD: ConfigDetail["nodes"][number] = {
    node_id: "local_9",
    name: "东京 9 号",
    server: "198.51.100.9",
    port: 8388,
    method: "aes-256-gcm",
    protocol: "shadowsocks",
    source: "owned",
    created_at: 0,
  };
  const ALIVE: ConfigDetail["nodes"][number] = {
    ...DEAD,
    node_id: "local_8",
    name: "大阪 8 号",
  };
  const FREE: ConfigDetail["nodes"][number] = {
    node_id: "f2",
    name: "洛杉矶 02",
    server: "203.0.113.9",
    port: 8388,
    method: "aes-256-gcm",
    protocol: "shadowsocks",
    source: "seed",
    created_at: 0,
  };
  const withNodes = (nodes: ConfigDetail["nodes"], current: string | null = nodes[0]?.node_id ?? null): ConfigDetail => ({
    ...CONFIG,
    node_count: nodes.length,
    current_node_id: current,
    nodes,
  });

  it("那一行写「停机删除」、不可点、不显示时延", () => {
    const onSwitchNode = vi.fn(async () => ({ ok: true as const }));
    renderStage({
      config: withNodes([DEAD, ALIVE], DEAD.node_id),
      danglingNodeIds: new Set([DEAD.node_id]),
      onSwitchNode,
    });

    const deadRow = screen.getAllByRole("option")[0] as HTMLElement;
    expect(deadRow.getAttribute("aria-disabled")).toBe("true");
    expect(deadRow.classList.contains("is-dangling")).toBe(true);
    expect(deadRow.querySelector(".stage-node__sub")?.textContent).toBe("停机删除");
    // 不能测速：右侧时延位不出现。
    expect(deadRow.querySelector(".stage-node__ms")).toBeNull();

    fireEvent.click(deadRow);
    expect(onSwitchNode).not.toHaveBeenCalled();
    expect(deadRow.getAttribute("aria-selected")).toBe("true");

    // 另一台正常节点照旧能选：点一下就顶掉当前那台。
    const aliveRow = screen.getAllByRole("option")[1] as HTMLElement;
    expect(aliveRow.getAttribute("aria-disabled")).toBeNull();
    fireEvent.click(aliveRow);
    expect(aliveRow.getAttribute("aria-selected")).toBe("true");
    expect(deadRow.getAttribute("aria-selected")).toBe("false");
  });

  it("悬挂的自建行不算替代节点：只剩过期免费行时按「免费节点已不可用」说", () => {
    renderStage({
      config: withNodes([DEAD, FREE], FREE.node_id),
      danglingNodeIds: new Set([DEAD.node_id]),
      trialExpiresAt: new Date(Date.now() - 3_600_000).toISOString(),
    });

    expect(screen.getByText("试用已到期，免费节点已不可用。")).toBeTruthy();
    expect(screen.queryByText("当前节点已到期，换一个节点再连接。")).toBeNull();
  });

  it("当前选中的就是悬挂节点：主按钮禁用，提示换一个", () => {
    const onStart = vi.fn();
    renderStage({
      config: withNodes([DEAD, ALIVE], DEAD.node_id),
      danglingNodeIds: new Set([DEAD.node_id]),
      onStart,
    });

    const primary = screen.getByRole("button", { name: "连接节点" });
    expect((primary as HTMLButtonElement).disabled).toBe(true);
    expect(
      screen.getByText("当前节点已停机删除，换一个节点再连接。"),
    ).toBeTruthy();
    fireEvent.click(primary);
    expect(onStart).not.toHaveBeenCalled();
  });

  it("池里只剩悬挂节点：引导去删或新建，主按钮同样禁用", () => {
    renderStage({
      config: withNodes([DEAD], DEAD.node_id),
      danglingNodeIds: new Set([DEAD.node_id]),
    });

    expect(
      screen.getByText("节点已停机删除，去我的服务器删除它，或新建一个节点。"),
    ).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "连接节点" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it("失败态下面那个「重新连接」也不拿悬挂节点当目标", () => {
    const onStart = vi.fn();
    renderStage({
      config: withNodes([DEAD, ALIVE], DEAD.node_id),
      danglingNodeIds: new Set([DEAD.node_id]),
      runtime: runtime({ state: "failed" }),
      onStart,
    });

    const again = document.querySelector(
      "button.stage-secondary",
    ) as HTMLButtonElement;
    expect(again.textContent).toBe("重新连接");
    expect(again.disabled).toBe(true);
    fireEvent.click(again);
    expect(onStart).not.toHaveBeenCalled();
  });
});

describe("测不通时的智能诊断入口", () => {
  const OWNED: ConfigDetail["nodes"][number] = {
    ...CONFIG.nodes[1],
    node_id: "o1",
    name: "悉尼0.2u",
    source: "owned",
  };

  function withNodes(
    nodes: ConfigDetail["nodes"],
    current: string | null = nodes[0]?.node_id ?? null,
  ): ConfigDetail {
    return { ...CONFIG, node_count: nodes.length, current_node_id: current, nodes };
  }

  const mapServer = (nodeId: string) => (nodeId === "o1" ? "srv_o1" : null);

  it("自有坏行只给「智能诊断」：点击把服务器 id 与节点名交给 App，不切节点", () => {
    const onAnalyzeNode = vi.fn();
    const onAskAi = vi.fn();
    const onSwitchNode = vi.fn(async () => ({ ok: true as const }));
    renderStage({
      config: withNodes([OWNED, CONFIG.nodes[0]], OWNED.node_id),
      nodeProbes: probes({
        results: { o1: failedProbe("o1"), n1: probeResult("n1", 42) },
      }),
      onAskAi,
      onAnalyzeNode,
      serverIdForNode: mapServer,
      onSwitchNode,
    });

    const rows = screen.getAllByRole("option");
    expect(within(rows[0]).queryByRole("button", { name: /问 AI/ })).toBeNull();
    const analyze = within(rows[0]).getByRole("button", {
      name: "对悉尼0.2u进行智能诊断",
    });
    expect(
      within(rows[1]).queryByRole("button", { name: /智能诊断/ }),
    ).toBeNull();

    fireEvent.click(analyze);
    expect(onAnalyzeNode).toHaveBeenCalledWith({
      serverId: "srv_o1",
      nodeName: "悉尼0.2u",
    });
    expect(onAskAi).not.toHaveBeenCalled();
    expect(onSwitchNode).not.toHaveBeenCalled();
    expect(rows[0].getAttribute("aria-selected")).toBe("true");
  });

  it("手动导入节点测不通：没有任何诊断入口", () => {
    const MANUAL: ConfigDetail["nodes"][number] = {
      ...CONFIG.nodes[0],
      node_id: "m1",
      name: "订阅节点",
      source: "manual",
    };
    const onAskAi = vi.fn();
    renderStage({
      config: withNodes([MANUAL], MANUAL.node_id),
      nodeProbes: probes({ results: { m1: failedProbe("m1") } }),
      onAskAi,
      onAnalyzeNode: vi.fn(),
      serverIdForNode: () => null,
    });

    expect(screen.queryByRole("button", { name: /智能诊断/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /咨询 AI/ })).toBeNull();
    expect(onAskAi).not.toHaveBeenCalled();
  });

  it("免费节点测不通：只有「测不通」文字，没有任何按钮", () => {
    const onAskAi = vi.fn();
    renderStage({
      config: withNodes([CONFIG.nodes[0]], CONFIG.nodes[0].node_id),
      nodeProbes: probes({ results: { n1: failedProbe("n1") } }),
      onAskAi,
      onAnalyzeNode: vi.fn(),
      serverIdForNode: () => null,
    });

    const row = screen.getAllByRole("option")[0];
    expect(within(row).getByText("测不通")).toBeTruthy();
    expect(within(row).queryByRole("button")).toBeNull();
    expect(
      screen.queryByRole("button", { name: /智能诊断|咨询 AI|问 AI/ }),
    ).toBeNull();
  });

  it("未测、测速中、停机删除、查不到服务器都不出现智能诊断入口", () => {
    const base = {
      onAskAi: vi.fn(),
      onAnalyzeNode: vi.fn(),
      serverIdForNode: mapServer,
    };

    for (const result of [probeResult("o1", 42), untestedProbe("o1")]) {
      renderStage({
        config: withNodes([OWNED], OWNED.node_id),
        nodeProbes: probes({ results: { o1: result } }),
        ...base,
      });
      expect(screen.queryByRole("button", { name: /智能诊断/ })).toBeNull();
      cleanup();
    }

    renderStage({
      config: withNodes([OWNED], OWNED.node_id),
      nodeProbes: probes({
        probing: new Set(["o1"]),
        results: { o1: failedProbe("o1") },
      }),
      ...base,
    });
    expect(screen.queryByRole("button", { name: /智能诊断/ })).toBeNull();
    cleanup();

    renderStage({
      config: withNodes([OWNED], OWNED.node_id),
      danglingNodeIds: new Set(["o1"]),
      nodeProbes: probes({ results: { o1: failedProbe("o1") } }),
      ...base,
    });
    expect(screen.queryByRole("button", { name: /智能诊断/ })).toBeNull();
    cleanup();

    renderStage({
      config: withNodes([OWNED], OWNED.node_id),
      nodeProbes: probes({ results: { o1: failedProbe("o1") } }),
      onAskAi: vi.fn(),
      onAnalyzeNode: vi.fn(),
      serverIdForNode: () => null,
    });
    expect(screen.queryByRole("button", { name: /智能诊断/ })).toBeNull();
  });
});

describe("周期同步发现当前节点变更（hero 提示）", () => {
  it("已连接时在 hero 给出提示，主按钮切成「重新连接」，点击走重连再测", async () => {
    const start = vi.fn(async () => ({ ok: true }));
    const onStaleConfigRetry = vi.fn();
    const onReconnectAndTest = vi.fn(async () => true);
    renderStage({
      runtime: runtime({ state: "running" }),
      nodeProbes: probes({ results: { n1: probeResult("n1", 42) }, start }),
      staleConfigNode: true,
      onStaleConfigRetry,
      onReconnectAndTest,
    });

    expect(screen.getByText("配置已变更，请重新连接")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "重新连接" }));

    await waitFor(() => expect(onReconnectAndTest).toHaveBeenCalledTimes(1));
    expect(onStaleConfigRetry).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(start).toHaveBeenCalledWith("cfg_1", ["n1"]));
  });

  it("没标记时不出提示，主按钮保持原义", () => {
    renderStage({
      runtime: runtime({ state: "running" }),
      nodeProbes: probes({ results: { n1: probeResult("n1", 42) } }),
    });
    expect(screen.queryByText("配置已变更，请重新连接")).toBeNull();
    expect(screen.getByRole("button", { name: "断开连接" })).toBeTruthy();
  });
});

describe("节点卡添加节点入口", () => {
  it("点击只上报，由 App 打开弹层", () => {
    const onAddNode = vi.fn();
    renderStage({ onAddNode });

    fireEvent.click(screen.getByRole("button", { name: "添加节点" }));

    expect(onAddNode).toHaveBeenCalledTimes(1);
  });

  it("没有节点时入口仍然显示", () => {
    renderStage({
      config: { ...CONFIG, node_count: 0, nodes: [] },
      onAddNode: vi.fn(),
    });

    expect(screen.getByRole("button", { name: "添加节点" })).toBeTruthy();
  });

  it("没传 onAddNode 时不渲染入口", () => {
    renderStage();

    expect(screen.queryByRole("button", { name: "添加节点" })).toBeNull();
  });
});

describe("自定义节点标记", () => {
  function withSource(source: ConfigDetail["nodes"][number]["source"]) {
    return {
      ...CONFIG,
      node_count: 1,
      current_node_id: "n1",
      nodes: [{ ...CONFIG.nodes[0], source }],
    };
  }

  function customTag(): Element | null {
    const row = screen.getAllByRole("option")[0] as HTMLElement;
    return row.querySelector(".stage-node__custom");
  }

  it("订阅导入的节点显示「自定义」", () => {
    renderStage({ config: withSource("url") });

    expect(customTag()?.textContent).toBe("自定义");
  });

  it("手动填写的节点显示「自定义」", () => {
    renderStage({ config: withSource("manual") });

    expect(customTag()?.textContent).toBe("自定义");
  });

  it("托管服务器节点不显示「自定义」", () => {
    renderStage({ config: withSource("owned") });

    expect(customTag()).toBeNull();
  });

  it("免费节点不显示「自定义」", () => {
    renderStage({ config: withSource("seed") });

    expect(customTag()).toBeNull();
  });
});

describe("自定义节点移除", () => {
  const CUSTOM_CONFIG: ConfigDetail = {
    ...CONFIG,
    node_count: 3,
    current_node_id: "n3",
    nodes: [
      CONFIG.nodes[0],
      {
        node_id: "n2",
        name: "托管 01",
        server: "203.0.113.3",
        port: 8388,
        method: "aes-256-gcm",
        protocol: "shadowsocks",
        source: "owned",
        created_at: 0,
      },
      {
        node_id: "n3",
        name: "美国 01",
        server: "203.0.113.4",
        port: 8388,
        method: "aes-256-gcm",
        protocol: "shadowsocks",
        source: "url",
        created_at: 0,
      },
    ],
  };

  it("只有 url / manual 节点有「更多」入口", () => {
    renderStage({ config: CUSTOM_CONFIG, onRemoveNode: vi.fn() });

    expect(
      screen.getByRole("button", { name: "更多操作：美国 01" }),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "更多操作：托管 01" })).toBeNull();
    expect(screen.queryByRole("button", { name: "更多操作：东京 01" })).toBeNull();
  });

  it("传了编辑回调时菜单先给「编辑节点」，点了把节点交给调用方", () => {
    const onEditNode = vi.fn();
    const onRemoveNode = vi.fn(async () => ({ ok: true }));
    renderStage({ config: CUSTOM_CONFIG, onEditNode, onRemoveNode });

    fireEvent.click(screen.getByRole("button", { name: "更多操作：美国 01" }));
    expect(
      screen.getAllByRole("menuitem").map((item) => item.textContent),
    ).toEqual(["编辑节点", "移除节点"]);

    fireEvent.click(screen.getByRole("menuitem", { name: "编辑节点" }));

    expect(onEditNode).toHaveBeenCalledTimes(1);
    expect(onEditNode.mock.calls[0][0]).toMatchObject({
      node_id: "n3",
      name: "美国 01",
      source: "url",
    });
    expect(onRemoveNode).not.toHaveBeenCalled();
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("菜单 → 就地确认 → 移除成功", async () => {
    const onRemoveNode = vi.fn(async () => ({ ok: true, wasCurrent: true }));
    renderStage({ config: CUSTOM_CONFIG, onRemoveNode });

    fireEvent.click(screen.getByRole("button", { name: "更多操作：美国 01" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "移除节点" }));

    const dialog = screen.getByRole("alertdialog");
    expect(within(dialog).getByText("移除「美国 01」？")).toBeTruthy();
    expect(
      within(dialog).getByText(/只从这台电脑的节点池移除/),
    ).toBeTruthy();
    expect(
      within(dialog).getByText("当前正在使用，会先断开连接。"),
    ).toBeTruthy();

    fireEvent.click(within(dialog).getByRole("button", { name: "移除" }));

    await waitFor(() => expect(onRemoveNode).toHaveBeenCalledWith("n3"));
    expect(await screen.findByText("已移除「美国 01」")).toBeTruthy();
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("移除失败留在确认区，错误就地显示", async () => {
    const onRemoveNode = vi.fn(async () => ({
      ok: false,
      message: "没能移除，稍后再试。",
    }));
    renderStage({ config: CUSTOM_CONFIG, onRemoveNode });

    fireEvent.click(screen.getByRole("button", { name: "更多操作：美国 01" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "移除节点" }));
    fireEvent.click(screen.getByRole("button", { name: "移除" }));

    expect(await screen.findByText("没能移除，稍后再试。")).toBeTruthy();
    expect(screen.getByRole("alertdialog")).toBeTruthy();
  });

  it("取消不调用移除", () => {
    const onRemoveNode = vi.fn();
    renderStage({ config: CUSTOM_CONFIG, onRemoveNode });

    fireEvent.click(screen.getByRole("button", { name: "更多操作：美国 01" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "移除节点" }));
    fireEvent.click(screen.getByRole("button", { name: "取消" }));

    expect(onRemoveNode).not.toHaveBeenCalled();
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });
});
