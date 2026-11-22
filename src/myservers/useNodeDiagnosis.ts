import { useEffect, useRef, useState } from "react";
import { toBridgeError } from "../agent/errors";
import { uiLog } from "../log/uiLog";

/** ICMP 一项（Host `node_probe_reachability` 的原样结果）。 */
export interface IcmpProbe {
  ok: boolean;
  /** 平均往返耗时（毫秒）；解析不出为 null，但退出码为 0 仍然 ok。 */
  rtt_ms: number | null;
  /** 丢包百分比 0–100。 */
  loss: number;
}

/** TCP 控制端口一项（Host `node_probe_reachability` 的原样结果）。 */
export interface TcpProbe {
  ok: boolean;
  /** 建立连接耗时（毫秒）；失败为 null。 */
  ms: number | null;
  /** 失败短码：`timeout` / `refused` / `unreachable`。 */
  error: string | null;
}

/** Host 的可达性命令一次返回两项：ICMP 与 TCP 32100。 */
export interface ProbeReport {
  icmp: IcmpProbe;
  tcp: TcpProbe;
}

export interface SyncOutcome {
  /** 这台节点的本地端口或密码是否有变化（按本地 `nd_` id 判定）。 */
  changed: boolean;
  /** 同步请求本身失败（控制面不可达）时的稳定码。 */
  controlPlaneError?: string;
  /** 同步后本机节点的端口；Host 没给时省略。 */
  port?: number | null;
}

export type RotateOutcome =
  | { ok: true; port: number }
  | { ok: false; reason: string };

/**
 * 诊断面板需要的静态事实，全部由调用方注入。
 * **这里只能放非敏感字段**：密码、令牌、完整导出链接永远不进这个对象。
 */
export interface DiagnosisFacts {
  serverId: string;
  region: string;
  /** 建机时刻（ISO 8601）。 */
  createdAt: string;
  /** 服务器状态（active / error / …）。 */
  state: string;
  /** 本地节点 id（`nd_…`）；没有本地节点行为 null。 */
  localNodeId: string | null;
  /** 当前端口；不知道为 null。 */
  port: number | null;
  /** 这台节点是否正在被当前配置使用。 */
  nodeInUse: boolean;
  appVersion: string;
  platform: string;
  /** 本次会话的 UI 日志路径；只给 AI 看，不进日志正文。 */
  uiLogPath?: string | null;
  /** 打开面板时读这台服务器记录的控制面请求已经失败：先怀疑本机网络。 */
  controlPlaneError?: string | null;
}

/**
 * 交给 AI 的清单（`node-diagnosis-flow.md` §5）。
 * 任何密码、令牌、完整导出链接都不能进入这个对象。
 */
export interface DiagnosisContext {
  server: {
    id: string;
    region: string;
    created_at: string;
    state: string;
  };
  node: {
    local_id: string | null;
    port: number | null;
    in_use: boolean;
  };
  connectivity: {
    icmp: IcmpProbe | null;
    tcp: TcpProbe | null;
  };
  config_update: {
    changed: boolean | null;
    port_changed: boolean | null;
    reprobe: boolean | null;
    /** 配置变化后的 stop → start → 重测结果；没走这条分支为 null。 */
    reconnect: boolean | null;
  };
  rotate: {
    ok: boolean | null;
    reason: string | null;
  };
  client: {
    app_version: string;
    platform: string;
    ui_log_path: string | null;
  };
}

/** 全部依赖从参数注入，Hook 不直接碰 bridge。 */
export interface DiagnosisDeps {
  facts: DiagnosisFacts;
  /** 隧道正在运行，且跑的就是这台节点。 */
  tunnelRunning: boolean;
  /** ICMP + TCP 32100；Host 侧命令一次返回两项。 */
  probeReachability: () => Promise<ProbeReport>;
  /** 全量同步（`myServerSync`），判断这台是否有变化。 */
  syncConfig: () => Promise<SyncOutcome>;
  /** 只重测一次，不重启隧道。 */
  reprobe: () => Promise<boolean>;
  /** stop → start → 重测。 */
  reconnectAndProbe: () => Promise<boolean>;
  /** 重置这台节点的端口与密码（`node_rotate_credentials`）。 */
  rotateCredentials: () => Promise<RotateOutcome>;
  /** 打开右栏，把诊断清单作为一条系统消息交给 AI。 */
  openAi: (context: DiagnosisContext) => void;
  /** 「去销毁并重建」只做导航；销毁仍在服务器详情页确认。 */
  onGoToServers?: () => void;
}

export type DiagnosisStepId = "connectivity" | "config" | "rotate" | "ai";

export type DiagnosisConclusion =
  | { kind: "connectivity-pending" }
  | {
      kind: "connectivity-ok";
      /** 只有 ICMP 被屏蔽、靠 TCP 确认时是 true。 */
      viaTcp: boolean;
      icmpMs: number | null;
      tcpMs: number | null;
    }
  | { kind: "unreachable" }
  | { kind: "service-down" }
  | { kind: "probe-error"; code: string | null }
  | { kind: "local-network" }
  | { kind: "config-pending" }
  | { kind: "config-control-plane" }
  | { kind: "config-recovered"; changed: boolean }
  | { kind: "config-failed"; changed: boolean }
  | { kind: "rotate-pending" }
  | { kind: "rotate-recovered" }
  | { kind: "rotate-reconnect-failed" }
  | { kind: "rotate-failed"; reason: string | null }
  | { kind: "ai-handed" };

export interface DiagnosisStep {
  id: DiagnosisStepId;
  status: "running" | "passed" | "failed";
  conclusion: DiagnosisConclusion;
}

export type DiagnosisAction =
  | "start"
  | "updateConfig"
  | "resetPort"
  | "askAi"
  | "goServers";

export type DiagnosisPhase =
  | "idle"
  | "running"
  | "awaiting"
  | "confirming"
  | "done";

export interface NodeDiagnosis {
  steps: DiagnosisStep[];
  phase: DiagnosisPhase;
  /** 当前唯一可点的主按钮；没有下一步时为 null。 */
  action: DiagnosisAction | null;
  /** 已经收集到的诊断清单；「去问 AI」时原样交给调用方。 */
  context: DiagnosisContext;
  /** 执行当前主按钮（开始分析 / 更新配置 / 重置端口 / 去问 AI / 去销毁）。 */
  run: () => void;
  /** 重置的二次确认：确认后才真正调 rotateCredentials。 */
  confirmReset: () => void;
  cancelReset: () => void;
}

interface Collected {
  icmp: IcmpProbe | null;
  tcp: TcpProbe | null;
  syncChanged: boolean | null;
  syncPortAfter: number | null;
  reprobe: boolean | null;
  reconnect: boolean | null;
  rotateOk: boolean | null;
  rotateReason: string | null;
  rotatePort: number | null;
}

function emptyCollected(): Collected {
  return {
    icmp: null,
    tcp: null,
    syncChanged: null,
    syncPortAfter: null,
    reprobe: null,
    reconnect: null,
    rotateOk: null,
    rotateReason: null,
    rotatePort: null,
  };
}

/** 只由最后一条步骤决定下一步；不在前面预先摆未执行的步骤。 */
function deriveAction(
  steps: DiagnosisStep[],
  phase: DiagnosisPhase,
): DiagnosisAction | null {
  if (phase === "running" || phase === "confirming" || phase === "done") {
    return null;
  }
  const last = steps[steps.length - 1];
  if (!last) return "start";
  if (last.status === "running") return null;
  switch (last.conclusion.kind) {
    case "connectivity-ok":
      return "updateConfig";
    case "unreachable":
      return "goServers";
    case "service-down":
      return "askAi";
    case "probe-error":
      return "askAi";
    case "local-network":
      return "askAi";
    case "config-control-plane":
      return "askAi";
    case "config-failed":
      return "resetPort";
    case "rotate-failed":
    case "rotate-reconnect-failed":
      return "askAi";
    default:
      return null;
  }
}

function buildContext(
  facts: DiagnosisFacts,
  collected: Collected,
): DiagnosisContext {
  const port =
    collected.rotatePort ??
    collected.syncPortAfter ??
    facts.port ??
    null;
  const portChanged =
    collected.syncPortAfter !== null && facts.port !== null
      ? collected.syncPortAfter !== facts.port
      : null;
  return {
    server: {
      id: facts.serverId,
      region: facts.region,
      created_at: facts.createdAt,
      state: facts.state,
    },
    node: {
      local_id: facts.localNodeId,
      port,
      in_use: facts.nodeInUse,
    },
    connectivity: {
      icmp: collected.icmp,
      tcp: collected.tcp,
    },
    config_update: {
      changed: collected.syncChanged,
      port_changed: portChanged,
      reprobe: collected.reprobe,
      reconnect: collected.reconnect,
    },
    rotate: {
      ok: collected.rotateOk,
      reason: collected.rotateReason,
    },
    client: {
      app_version: facts.appVersion,
      platform: facts.platform,
      ui_log_path: facts.uiLogPath ?? null,
    },
  };
}

function boolCode(value: boolean | null): string {
  if (value === null) return "none";
  return value ? "ok" : "fail";
}

function triCode(value: boolean | null): string {
  if (value === null) return "none";
  return value ? "true" : "false";
}

/** 探测命令没跑起来时取一个稳定短码；取不到就返回 null。 */
function probeErrorCode(error: unknown): string | null {
  const problem = toBridgeError(error);
  const reason = problem.details?.reason;
  if (typeof reason === "string" && reason.trim() !== "") return reason;
  if (problem.code !== "" && problem.code !== "INTERNAL") return problem.code;
  return null;
}

/** 关闭时写一条固定模板日志；只含步骤名、布尔与错误码，不含任何凭据。 */
function logClosed(steps: DiagnosisStep[], collected: Collected): void {
  if (steps.length === 0) return;
  const codes = steps.map((step) => `${step.id}:${step.status}`).join(",");
  const rotate =
    collected.rotateOk === null
      ? "none"
      : collected.rotateOk
        ? "ok"
        : `fail:${collected.rotateReason ?? "unknown"}`;
  uiLog(
    "info",
    `diagnosis steps=${codes} icmp=${boolCode(collected.icmp?.ok ?? null)} tcp=${boolCode(collected.tcp?.ok ?? null)} changed=${triCode(collected.syncChanged)} reprobe=${triCode(collected.reprobe)} reconnect=${triCode(collected.reconnect)} rotate=${rotate}`,
    "node-diagnosis",
  );
}

export function useNodeDiagnosis(deps: DiagnosisDeps): NodeDiagnosis {
  const [steps, setSteps] = useState<DiagnosisStep[]>([]);
  const [phase, setPhase] = useState<DiagnosisPhase>("idle");

  const depsRef = useRef(deps);
  depsRef.current = deps;

  const stepsRef = useRef(steps);
  stepsRef.current = steps;

  const phaseRef = useRef(phase);
  const mountedRef = useRef(true);
  const busyRef = useRef(false);
  const collectedRef = useRef<Collected>(emptyCollected());

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      logClosed(stepsRef.current, collectedRef.current);
    };
  }, []);

  const updatePhase = (next: DiagnosisPhase) => {
    phaseRef.current = next;
    setPhase(next);
  };

  const replaceLast = (step: DiagnosisStep) => {
    setSteps((prev) => [...prev.slice(0, -1), step]);
  };

  const startConnectivity = async () => {
    busyRef.current = true;
    updatePhase("running");
    setSteps([
      { id: "connectivity", status: "running", conclusion: { kind: "connectivity-pending" } },
    ]);

    let report: ProbeReport | null = null;
    let probeError: string | null = null;
    try {
      report = await depsRef.current.probeReachability();
    } catch (error) {
      probeError = probeErrorCode(error);
    }

    busyRef.current = false;
    if (!mountedRef.current) return;

    if (report === null) {
      // 命令没跑起来（IP / 端口非法、Host 超时…）不等于机器死了：不给销毁。
      setSteps([
        {
          id: "connectivity",
          status: "failed",
          conclusion: { kind: "probe-error", code: probeError },
        },
      ]);
      updatePhase("awaiting");
      return;
    }

    collectedRef.current.icmp = report.icmp;
    collectedRef.current.tcp = report.tcp;

    if (report.icmp.ok || report.tcp.ok) {
      setSteps([
        {
          id: "connectivity",
          status: "passed",
          conclusion: {
            kind: "connectivity-ok",
            viaTcp: !report.icmp.ok,
            icmpMs: report.icmp.ok ? report.icmp.rtt_ms : null,
            tcpMs: report.tcp.ok ? report.tcp.ms : null,
          },
        },
      ]);
    } else if (report.tcp.error === "refused") {
      // 端口回了 RST：机器活着，只是控制服务没在听；重置也要 agent 在线，先交 AI。
      setSteps([
        { id: "connectivity", status: "failed", conclusion: { kind: "service-down" } },
      ]);
    } else if (depsRef.current.facts.controlPlaneError) {
      setSteps([
        { id: "connectivity", status: "failed", conclusion: { kind: "local-network" } },
      ]);
    } else {
      setSteps([
        { id: "connectivity", status: "failed", conclusion: { kind: "unreachable" } },
      ]);
    }
    updatePhase("awaiting");
  };

  const runConfig = async () => {
    busyRef.current = true;
    updatePhase("running");
    setSteps((prev) => [
      ...prev,
      { id: "config", status: "running", conclusion: { kind: "config-pending" } },
    ]);

    let outcome: SyncOutcome;
    try {
      outcome = await depsRef.current.syncConfig();
    } catch {
      outcome = { changed: false, controlPlaneError: "control_plane_unreachable" };
    }

    if (outcome.controlPlaneError) {
      busyRef.current = false;
      if (mountedRef.current) {
        replaceLast({
          id: "config",
          status: "failed",
          conclusion: { kind: "config-control-plane" },
        });
        updatePhase("awaiting");
      }
      return;
    }

    collectedRef.current.syncChanged = outcome.changed;
    if (outcome.port !== undefined && outcome.port !== null) {
      collectedRef.current.syncPortAfter = outcome.port;
    }

    // 面板关掉也把已经开始的同步收尾：配置变了就必须重启隧道，否则用户仍连着旧端口。
    let ok: boolean;
    if (outcome.changed && depsRef.current.tunnelRunning) {
      try {
        ok = await depsRef.current.reconnectAndProbe();
      } catch {
        ok = false;
      }
      collectedRef.current.reconnect = ok;
    } else {
      // 没变化（或隧道没在跑这台）也要重测一次，避免只比较端口漏掉「只改密码」。
      try {
        ok = await depsRef.current.reprobe();
      } catch {
        ok = false;
      }
      collectedRef.current.reprobe = ok;
    }

    busyRef.current = false;
    if (!mountedRef.current) return;

    if (ok) {
      replaceLast({
        id: "config",
        status: "passed",
        conclusion: { kind: "config-recovered", changed: outcome.changed },
      });
      updatePhase("done");
    } else {
      replaceLast({
        id: "config",
        status: "failed",
        conclusion: { kind: "config-failed", changed: outcome.changed },
      });
      updatePhase("awaiting");
    }
  };

  const runReset = async () => {
    if (phaseRef.current !== "confirming" || busyRef.current) return;
    busyRef.current = true;
    updatePhase("running");
    setSteps((prev) => [
      ...prev,
      { id: "rotate", status: "running", conclusion: { kind: "rotate-pending" } },
    ]);

    let outcome: RotateOutcome;
    try {
      outcome = await depsRef.current.rotateCredentials();
    } catch {
      outcome = { ok: false, reason: "" };
    }

    if (!outcome.ok) {
      const reason = outcome.reason.trim() === "" ? null : outcome.reason;
      collectedRef.current.rotateOk = false;
      collectedRef.current.rotateReason = reason;
      busyRef.current = false;
      if (mountedRef.current) {
        replaceLast({
          id: "rotate",
          status: "failed",
          conclusion: { kind: "rotate-failed", reason },
        });
        updatePhase("awaiting");
      }
      return;
    }

    collectedRef.current.rotateOk = true;
    collectedRef.current.rotatePort = outcome.port;

    // 端口和密码已经变了；面板关掉也要把重连跑完，否则隧道还连着旧凭据。
    let ok: boolean;
    try {
      ok = await depsRef.current.reconnectAndProbe();
    } catch {
      ok = false;
    }
    collectedRef.current.reconnect = ok;

    busyRef.current = false;
    if (!mountedRef.current) return;

    if (ok) {
      replaceLast({
        id: "rotate",
        status: "passed",
        conclusion: { kind: "rotate-recovered" },
      });
      updatePhase("done");
    } else {
      replaceLast({
        id: "rotate",
        status: "failed",
        conclusion: { kind: "rotate-reconnect-failed" },
      });
      updatePhase("awaiting");
    }
  };

  const handOffToAi = () => {
    depsRef.current.openAi(
      buildContext(depsRef.current.facts, collectedRef.current),
    );
    setSteps((prev) => [
      ...prev,
      { id: "ai", status: "passed", conclusion: { kind: "ai-handed" } },
    ]);
    updatePhase("done");
  };

  const run = () => {
    if (busyRef.current) return;
    const action = deriveAction(stepsRef.current, phaseRef.current);
    if (action === null) return;
    switch (action) {
      case "start":
        void startConnectivity();
        break;
      case "updateConfig":
        void runConfig();
        break;
      case "resetPort":
        updatePhase("confirming");
        break;
      case "askAi":
        handOffToAi();
        break;
      case "goServers":
        updatePhase("done");
        depsRef.current.onGoToServers?.();
        break;
    }
  };

  const confirmReset = () => {
    void runReset();
  };

  const cancelReset = () => {
    if (phaseRef.current !== "confirming") return;
    updatePhase("awaiting");
  };

  return {
    steps,
    phase,
    action: deriveAction(steps, phase),
    context: buildContext(depsRef.current.facts, collectedRef.current),
    run,
    confirmReset,
    cancelReset,
  };
}
