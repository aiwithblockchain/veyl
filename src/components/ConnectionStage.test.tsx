/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ConfigConnectMode,
  ConfigDetail,
  ConfigRouteMode,
  RuntimeView,
} from "../agent/protocol";import { emptyRuntimeView } from "../agent/bridge";
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
    recordResults: () => {},
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
    reachable: true,
    latency_ms: latency,
    probe_method: "tcp" as const,
    checked_at: Date.now(),
    error: null,
  };
}

function failedProbe(nodeId: string) {
  return {
    node_id: nodeId,
    reachable: false,
    latency_ms: null,
    probe_method: "tcp" as const,
    checked_at: Date.now(),
    error: { code: "PROBE_TIMEOUT", message: "" },
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
    method: "tcp",
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
    method: "tcp",
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
  preselect?: { configId: string; nodeId: string; nonce: number } | null;
  trialSummary?: { configId: string; count: number; fastestMs: number | null } | null;
  onProbe?: () => void;
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
      nodeProbes={over.nodeProbes ?? probes()}
      failedAfterConnected={over.failedAfterConnected ?? false}
      helperPreparing={false}
      preselect={over.preselect ?? null}
      trialSummary={over.trialSummary ?? null}
      onProbe={over.onProbe}
      manualProbed={over.manualProbed ?? false}
      onProbeAvailabilityChange={over.onProbeAvailabilityChange}
      routingMode={over.routingMode ?? null}
      onSetConnectMode={over.onSetConnectMode}
      onSetRoutingMode={over.onSetRoutingMode}
      onReportProblem={over.onReportProblem}
      reportBusy={over.reportBusy}
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
    const preselect = { configId: "cfg_1", nodeId: "n2", nonce: 1 };
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

  it("本地预选不写任何本地存储", () => {
    localStorage.clear();
    sessionStorage.clear();
    renderStage({
      config: { ...CONFIG, current_node_id: null },
      nodeProbes: probes({
        results: { n1: probeResult("n1", 90), n2: probeResult("n2", 42) },
      }),
      preselect: { configId: "cfg_1", nodeId: "n2", nonce: 1 },
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
      preselect: { configId: "cfg_1", nodeId: "n1", nonce: 1 },
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
      preselect: { configId: "cfg_1", nodeId: "n1", nonce: 1 },
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

  it("全部失败：失败行显示破折号与无障碍名，卡内给再试一次", async () => {
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
    // 即使运行时对 n1 有旧延迟，测速失败仍显示破折号。
    expect(values).toEqual(["—", "—"]);
    expect(screen.getAllByLabelText("这次没测通").length).toBe(2);
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

  it("只在有节点时出现，当前值直接读配置", () => {
    renderStage({
      routingMode: "direct",
      onSetConnectMode: async () => ({ ok: true }),
      onSetRoutingMode: async () => ({ ok: true }),
    });
    expect(
      screen.getByRole("button", { name: "切换接管方式，当前 Tun 模式" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "切换流量范围，当前 智能" }),
    ).toBeTruthy();
    cleanup();

    // 没节点时整行不出现。
    renderStage({
      config: { ...proxyConfig, nodes: [], node_count: 0 },
      onSetConnectMode: async () => ({ ok: true }),
      onSetRoutingMode: async () => ({ ok: true }),
    });
    expect(screen.queryByText("Proxy 模式")).toBeNull();
    expect(
      screen.queryByRole("button", { name: /切换接管方式/ }),
    ).toBeNull();
  });

  it("智能 / 全局互切直接生效并播报", async () => {
    const onSetRoutingMode = vi.fn(async () => ({ ok: true }));
    renderStage({
      config: proxyConfig,
      routingMode: "direct",
      onSetConnectMode: async () => ({ ok: true }),
      onSetRoutingMode,
    });

    fireEvent.click(
      screen.getByRole("button", { name: "切换流量范围，当前 智能" }),
    );

    await waitFor(() => expect(onSetRoutingMode).toHaveBeenCalledWith("proxy_all"));
    expect(await screen.findByText("已切到全局")).toBeTruthy();
    // 没有任何确认条。
    expect(screen.queryByRole("button", { name: "继续" })).toBeNull();
  });

  it("切到 Tun 先就地确认；Esc 取消且不发命令", async () => {
    const onSetConnectMode = vi.fn(async () => ({ ok: true }));
    renderStage({
      config: proxyConfig,
      onSetConnectMode,
      onSetRoutingMode: async () => ({ ok: true }),
    });

    fireEvent.click(
      screen.getByRole("button", { name: "切换接管方式，当前 Proxy 模式" }),
    );

    expect(
      screen.getByText(
        "切到 Tun 模式？接管全部软件；首次使用需要系统授权。",
      ),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "取消" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "继续" })).toBeTruthy();

    fireEvent.keyDown(window, { key: "Escape" });

    expect(screen.queryByRole("button", { name: "继续" })).toBeNull();
    expect(onSetConnectMode).not.toHaveBeenCalled();
  });

  it("确认后进入进行中态，成功后播报", async () => {
    let release: (value: { ok: boolean }) => void = () => {};
    const pending = new Promise<{ ok: boolean }>((resolve) => {
      release = resolve;
    });
    const onSetConnectMode = vi.fn(() => pending);
    renderStage({
      config: proxyConfig,
      onSetConnectMode,
      onSetRoutingMode: async () => ({ ok: true }),
    });

    fireEvent.click(
      screen.getByRole("button", { name: "切换接管方式，当前 Proxy 模式" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "继续" }));

    expect(await screen.findByText("正在切换到 Tun 模式…")).toBeTruthy();
    expect(onSetConnectMode).toHaveBeenCalledWith(
      "tun",
      expect.objectContaining({ onRestoring: expect.any(Function) }),
    );
    expect(
      screen.queryByRole("button", { name: /切换接管方式/ }),
    ).toBeNull();

    release({ ok: true });

    expect(await screen.findByText("已切到 Tun 模式")).toBeTruthy();
  });

  it("失败回退后标签仍是 Proxy，并说明已回到 Proxy 模式", async () => {
    renderStage({
      config: proxyConfig,
      onSetConnectMode: async () => ({ ok: false, restored: true }),
      onSetRoutingMode: async () => ({ ok: true }),
    });

    fireEvent.click(
      screen.getByRole("button", { name: "切换接管方式，当前 Proxy 模式" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "继续" }));

    expect(
      await screen.findByText("没能切换到 Tun 模式，已回到 Proxy 模式。"),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "切换接管方式，当前 Proxy 模式" }),
    ).toBeTruthy();
  });

  it("连接中接管方式禁用，流量范围仍可切", () => {
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
          name: "切换接管方式，当前 Proxy 模式",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(
      (
        screen.getByRole("button", {
          name: "切换流量范围，当前 智能",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false);
  });

  it("回滚失败：说明连接已断开，不写「已回到」", async () => {
    renderStage({
      config: proxyConfig,
      onSetConnectMode: async () => ({ ok: false, restored: false }),
      onSetRoutingMode: async () => ({ ok: true }),
    });

    fireEvent.click(
      screen.getByRole("button", { name: "切换接管方式，当前 Proxy 模式" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "继续" }));

    expect(
      await screen.findByText("没能切换到 Tun 模式，连接已断开。"),
    ).toBeTruthy();
    expect(screen.queryByText(/已回到 Proxy 模式/)).toBeNull();
  });

  it("回滚结果与库值都未知：只说连接状态未知", async () => {
    renderStage({
      config: proxyConfig,
      onSetConnectMode: async () => ({
        ok: false,
        restored: null,
        actualMode: null,
      }),
      onSetRoutingMode: async () => ({ ok: true }),
    });

    fireEvent.click(
      screen.getByRole("button", { name: "切换接管方式，当前 Proxy 模式" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "继续" }));

    expect(
      await screen.findByText("没能切换到 Tun 模式，连接状态未知。"),
    ).toBeTruthy();
    expect(screen.queryByText(/已回到/)).toBeNull();
    expect(screen.queryByText(/连接已断开/)).toBeNull();
  });

  it("旧数据的 proxy_selected：不渲染流量范围按钮", () => {
    renderStage({
      config: proxyConfig,
      routingMode: "proxy_selected",
      onSetConnectMode: async () => ({ ok: true }),
      onSetRoutingMode: async () => ({ ok: true }),
    });

    expect(
      screen.getByRole("button", { name: "切换接管方式，当前 Proxy 模式" }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: /切换流量范围/ }),
    ).toBeNull();
    expect(screen.queryByText("智能")).toBeNull();
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
});
