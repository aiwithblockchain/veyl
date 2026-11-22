import { useEffect, useRef, useState } from "react";
import { toBridgeError } from "../agent/errors";
import { uiLog, type UiLogLevel } from "../log/uiLog";

/** ICMP 一项（Host `node_probe_reachability` 的原样结果）。 */
export interface IcmpProbe {
  ok: boolean;
  /** 平均往返耗时（毫秒）；解析不出为 null，但退出码为 0 仍然 ok。 */
  rtt_ms: number | null;
  /** 丢包百分比 0–100。 */
  loss: number;
  /** 命令没跑成时的短码（`spawn_failed` / `timeout` / `io_error`）；正常执行为 null。 */
  error?: string | null;
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

/** 重测结果：true 通 / false 不通 / null 这次没测成（untested，不能当成不通）。 */
export type ProbeOutcome = boolean | null;

/** 重连的结果：重连本身失败、重连成功但测不通、没测成，三者要分开。 */
export type ReconnectOutcome =
  | "ok"
  | "probe-failed"
  | "probe-untested"
  | "reconnect-failed";

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
    /** 探测命令本身没跑起来时的短码；正常为 null。 */
    probe_error: string | null;
  };
  config_update: {
    changed: boolean | null;
    port_changed: boolean | null;
    reprobe: boolean | null;
    /** 配置变化后的 stop → start → 重测结果；没走这条分支为 null。 */
    reconnect: boolean | null;
    /** 同步请求本身失败时的短码；成功为 null。 */
    control_plane_error: string | null;
    /** 同步命令超时：可能仍在跑或已经成功。 */
    timed_out: boolean;
  };
  rotate: {
    ok: boolean | null;
    reason: string | null;
    /** 重置命令超时：可能仍在跑或已经成功。 */
    timed_out: boolean;
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
  /** 隧道正在运行，且跑的就是这台节点；每次判定时现读，避免旧快照。 */
  isTunnelRunning: () => boolean;
  /** 隧道正在运行任意节点；每次判定时现读。 */
  isRuntimeRunning: () => boolean;
  /** ICMP + TCP 32100；Host 侧命令一次返回两项。 */
  probeReachability: () => Promise<ProbeReport>;
  /** 全量同步（`myServerSync`），判断这台是否有变化。 */
  syncConfig: () => Promise<SyncOutcome>;
  /** 只重测一次，不重启隧道；null = 没测成（untested）。 */
  reprobe: () => Promise<ProbeOutcome>;
  /** 最近一次 untested 的 Host 原因（connection_busy / node_not_in_config / node_not_in_running_config / clash_unavailable）；没有为 null。 */
  probeUntestedReason?: () => string | null;
  /** stop → start → 重测；重连失败与重连后测不通要分开。 */
  reconnectAndProbe: () => Promise<ReconnectOutcome>;
  /** 重置这台节点的端口与密码（`node_rotate_credentials`）。 */
  rotateCredentials: () => Promise<RotateOutcome>;
  /** 打开右栏，把诊断清单作为一条系统消息交给 AI。返回 false = 被拦下（AI 未配置）。 */
  openAi: (context: DiagnosisContext) => boolean;
  /** 「去销毁并重建」只做导航；销毁仍在服务器详情页确认。 */
  onGoToServers?: () => void;
  /** 开始分析时把本次关联短码交给调用方，供 Hook 之外的日志复用。 */
  onRunStart?: (run: string) => void;
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
  /** 同步命令超时：可能仍在跑或已经成功，不按失败处理。 */
  | { kind: "config-timeout" }
  /** 重测没跑成（untested）：reason 是 Host 给的原因，不能当成不通。 */
  | { kind: "config-untested"; reason: string | null }
  /** 配置已更新，但 stop → start 本身失败。 */
  | { kind: "config-reconnect-failed" }
  | { kind: "config-recovered"; changed: boolean }
  | { kind: "config-failed"; changed: boolean }
  /** 配置有变化，但隧道没在跑：不自动连接，提示重新连接后生效。 */
  | { kind: "config-applied-idle" }
  /** 配置没有变化，且隧道没在跑：结论中性，下一步给重置。 */
  | { kind: "config-unchanged" }
  | { kind: "rotate-pending" }
  | { kind: "rotate-recovered" }
  | { kind: "rotate-reconnect-failed" }
  /** 重置命令超时：可能仍在跑或已经成功，不按失败处理。 */
  | { kind: "rotate-timeout" }
  /** 重置成功，但重测没跑成（untested）：reason 是 Host 给的原因。 */
  | { kind: "rotate-untested"; reason: string | null }
  /** 重置成功，但跑的是别的节点、只重测仍不通。 */
  | { kind: "rotate-still-failed" }
  /** 重置成功，但隧道没在跑：不探测、不自动连接。 */
  | { kind: "rotate-applied-idle" }
  | { kind: "rotate-failed"; reason: string | null }
  | { kind: "ai-handed" };

export interface DiagnosisStep {
  id: DiagnosisStepId;
  /** unknown = 没测成 / 可能仍在进行：不是确定性失败，界面不画 ✕。 */
  status: "running" | "passed" | "failed" | "unknown";
  conclusion: DiagnosisConclusion;
}

export type DiagnosisAction =
  | "start"
  | "updateConfig"
  | "resetPort"
  | "retest"
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
  probeError: string | null;
  syncChanged: boolean | null;
  syncPortAfter: number | null;
  syncTimedOut: boolean;
  controlPlaneError: string | null;
  reprobe: boolean | null;
  reconnect: boolean | null;
  rotateOk: boolean | null;
  rotateReason: string | null;
  rotatePort: number | null;
  rotateTimedOut: boolean;
}

function emptyCollected(): Collected {
  return {
    icmp: null,
    tcp: null,
    probeError: null,
    syncChanged: null,
    syncPortAfter: null,
    syncTimedOut: false,
    controlPlaneError: null,
    reprobe: null,
    reconnect: null,
    rotateOk: null,
    rotateReason: null,
    rotatePort: null,
    rotateTimedOut: false,
  };
}

/** 只由最后一条步骤决定下一步；不在前面预先摆未执行的步骤。 */
function deriveAction(
  steps: DiagnosisStep[],
  phase: DiagnosisPhase,
  configAttempts: number,
  postRotateRetests: number,
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
    case "config-timeout":
      return "askAi";
    case "config-reconnect-failed":
      return "askAi";
    case "config-untested":
      // 没测成不是不通：同一轮最多试 3 次更新配置，之后交 AI。
      return configAttempts < 3 ? "updateConfig" : "askAi";
    case "config-unchanged":
      return "resetPort";
    case "config-failed":
      // 配置可能是别的设备改的：ICMP 通说明 IP 没被封，重置通常还能救回来。
      return "resetPort";
    case "rotate-untested":
      // 重置后最多再测 2 次，仍没测成才交 AI；重置本身不再给第二次。
      return postRotateRetests < 2 ? "retest" : "askAi";
    case "rotate-failed":
    case "rotate-reconnect-failed":
    case "rotate-timeout":
    case "rotate-still-failed":
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
      probe_error: collected.probeError,
    },
    config_update: {
      changed: collected.syncChanged,
      port_changed: portChanged,
      reprobe: collected.reprobe,
      reconnect: collected.reconnect,
      control_plane_error: collected.controlPlaneError,
      timed_out: collected.syncTimedOut,
    },
    rotate: {
      ok: collected.rotateOk,
      reason: collected.rotateReason,
      timed_out: collected.rotateTimedOut,
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

/** 给一次注入调用加硬超时；超时按稳定 reason 走失败分支，界面不会永远「进行中」。 */
function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  reason: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject({
        code: "TIMEOUT",
        message: "",
        retryable: true,
        details: { reason },
      });
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** 一次诊断的关联短码：时间戳后 6 位，短、可 grep，同一次运行内每行一致。 */
function makeRunCode(): string {
  return String(Date.now() % 1_000_000).padStart(6, "0");
}

/** 关闭时写一条固定模板日志；只含步骤名、布尔与错误码，不含任何凭据。 */
function logClosed(
  run: string | null,
  steps: DiagnosisStep[],
  collected: Collected,
  runtime: string,
): void {
  if (steps.length === 0) return;
  const codes = steps.map((step) => `${step.id}:${step.status}`).join(",");
  const rotate = collected.rotateTimedOut
    ? "timed_out"
    : collected.rotateOk === null
      ? "none"
      : collected.rotateOk
        ? "ok"
        : `fail:${collected.rotateReason ?? "unknown"}`;
  uiLog(
    "info",
    `diagnosis run=${run ?? "none"} steps=${codes} runtime=${runtime} icmp=${boolCode(collected.icmp?.ok ?? null)} tcp=${boolCode(collected.tcp?.ok ?? null)} probe_error=${collected.probeError ?? "none"} changed=${triCode(collected.syncChanged)} reprobe=${triCode(collected.reprobe)} reconnect=${triCode(collected.reconnect)} control_plane_error=${collected.controlPlaneError ?? "none"} rotate=${rotate}`,
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
  const runRef = useRef<string | null>(null);
  /** 同一轮的次数上限；mount 归零，关闭重开就是新的一轮。 */
  const configAttemptsRef = useRef(0);
  const postRotateRetestsRef = useRef(0);

  /** 每行都带本次诊断的 run 码，方便在 logs/ 里串起一次分析。 */
  const log = (level: UiLogLevel, body: string) => {
    uiLog(
      level,
      `diagnosis run=${runRef.current ?? "none"} ${body}`,
      "node-diagnosis",
    );
  };

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      logClosed(
        runRef.current,
        stepsRef.current,
        collectedRef.current,
        runtimeLabel(),
      );
    };
  }, []);

  const updatePhase = (next: DiagnosisPhase) => {
    phaseRef.current = next;
    setPhase(next);
  };

  const replaceLast = (step: DiagnosisStep) => {
    setSteps((prev) => [...prev.slice(0, -1), step]);
  };

  const runtimeLabel = (): "this" | "other" | "idle" =>
    depsRef.current.isTunnelRunning()
      ? "this"
      : depsRef.current.isRuntimeRunning()
        ? "other"
        : "idle";

  const untestedReason = (): string | null =>
    depsRef.current.probeUntestedReason?.() ?? null;

  const startConnectivity = async () => {
    busyRef.current = true;
    updatePhase("running");
    setSteps([
      { id: "connectivity", status: "running", conclusion: { kind: "connectivity-pending" } },
    ]);
    runRef.current = makeRunCode();
    depsRef.current.onRunStart?.(runRef.current);
    log(
      "info",
      `start server=${depsRef.current.facts.serverId} node=${depsRef.current.facts.localNodeId ?? "none"} runtime=${runtimeLabel()}`,
    );

    let report: ProbeReport | null = null;
    let probeError: string | null = null;
    try {
      report = await withTimeout(
        depsRef.current.probeReachability(),
        25_000,
        "timeout",
      );
    } catch (error) {
      probeError = probeErrorCode(error);
    }
    collectedRef.current.probeError = probeError;

    busyRef.current = false;
    if (!mountedRef.current) return;

    if (report === null) {
      // 命令没跑起来（IP / 端口非法、Host 超时…）不等于机器死了：不给销毁。
      log("warn", `connectivity probe-error code=${probeError ?? "none"}`);
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
    log(
      "info",
      `connectivity icmp=${report.icmp.ok ? "ok" : report.icmp.error ? `error:${report.icmp.error}` : "fail"} rtt=${report.icmp.rtt_ms ?? "none"} tcp=${report.tcp.ok ? "ok" : `fail:${report.tcp.error ?? "unknown"}`} ms=${report.tcp.ms ?? "none"}`,
    );

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
    } else if (report.icmp.error) {
      // ICMP 命令自己没跑成（spawn_failed / timeout / io_error）：不能判机器死了。
      collectedRef.current.probeError = report.icmp.error;
      setSteps([
        {
          id: "connectivity",
          status: "failed",
          conclusion: { kind: "probe-error", code: report.icmp.error },
        },
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
    const startedAt = Date.now();
    busyRef.current = true;
    configAttemptsRef.current += 1;
    updatePhase("running");
    setSteps((prev) => [
      ...prev,
      { id: "config", status: "running", conclusion: { kind: "config-pending" } },
    ]);

    let outcome: SyncOutcome | null = null;
    let timedOut = false;
    try {
      outcome = await withTimeout(
        depsRef.current.syncConfig(),
        30_000,
        "timeout",
      );
    } catch (error) {
      const code = probeErrorCode(error);
      if (code === "timeout") {
        timedOut = true;
      } else {
        outcome = {
          changed: false,
          controlPlaneError: code ?? "control_plane_unreachable",
        };
      }
    }

    // 超时不是失败：命令可能仍在跑或已经成功，别让用户照着「失败」去重置。
    if (timedOut) {
      collectedRef.current.syncTimedOut = true;
      log("warn", `config result=timeout elapsed_ms=${Date.now() - startedAt}`);
      busyRef.current = false;
      if (!mountedRef.current) return;
      replaceLast({
        id: "config",
        status: "unknown",
        conclusion: { kind: "config-timeout" },
      });
      updatePhase("awaiting");
      return;
    }

    const synced: SyncOutcome = outcome ?? { changed: false };
    if (synced.controlPlaneError) {
      collectedRef.current.controlPlaneError = synced.controlPlaneError;
      log(
        "warn",
        `config control-plane error=${synced.controlPlaneError} changed=${synced.changed} elapsed_ms=${Date.now() - startedAt}`,
      );
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

    collectedRef.current.syncChanged = synced.changed;
    if (synced.port !== undefined && synced.port !== null) {
      collectedRef.current.syncPortAfter = synced.port;
    }

    // 没在跑隧道：不自动连接、也不探测，只把配置结果说清楚。
    if (!depsRef.current.isRuntimeRunning()) {
      log(
        "info",
        `config changed=${synced.changed} port=${synced.port ?? "none"} runtime=idle result=${synced.changed ? "applied" : "unchanged"} elapsed_ms=${Date.now() - startedAt}`,
      );
      busyRef.current = false;
      if (!mountedRef.current) return;
      if (synced.changed) {
        replaceLast({
          id: "config",
          status: "passed",
          conclusion: { kind: "config-applied-idle" },
        });
        updatePhase("done");
      } else {
        replaceLast({
          id: "config",
          status: "passed",
          conclusion: { kind: "config-unchanged" },
        });
        updatePhase("awaiting");
      }
      return;
    }

    // 面板关掉也把已经开始的同步收尾：配置变了就必须重启隧道，否则用户仍连着旧端口。
    const reconnect = synced.changed && depsRef.current.isTunnelRunning();
    if (reconnect) {
      let result: ReconnectOutcome;
      try {
        result = await depsRef.current.reconnectAndProbe();
      } catch {
        result = "reconnect-failed";
      }
      collectedRef.current.reconnect =
        result === "ok" ? true : result === "probe-untested" ? null : false;

      log(
        "info",
        `config changed=${synced.changed} port=${synced.port ?? "none"} runtime=${runtimeLabel()} via=reconnect result=${result} elapsed_ms=${Date.now() - startedAt}`,
      );
      busyRef.current = false;
      if (!mountedRef.current) return;

      if (result === "ok") {
        replaceLast({
          id: "config",
          status: "passed",
          conclusion: { kind: "config-recovered", changed: synced.changed },
        });
        updatePhase("done");
      } else if (result === "reconnect-failed") {
        replaceLast({
          id: "config",
          status: "failed",
          conclusion: { kind: "config-reconnect-failed" },
        });
        updatePhase("awaiting");
      } else if (result === "probe-untested") {
        replaceLast({
          id: "config",
          status: "unknown",
          conclusion: { kind: "config-untested", reason: untestedReason() },
        });
        updatePhase("awaiting");
      } else {
        replaceLast({
          id: "config",
          status: "failed",
          conclusion: { kind: "config-failed", changed: synced.changed },
        });
        updatePhase("awaiting");
      }
      return;
    }

    // 没变化（或隧道没在跑这台）也要重测一次，避免只比较端口漏掉「只改密码」。
    let ok: ProbeOutcome;
    try {
      ok = await depsRef.current.reprobe();
    } catch {
      ok = null;
    }
    collectedRef.current.reprobe = ok;

    log(
      "info",
      `config changed=${synced.changed} port=${synced.port ?? "none"} runtime=${runtimeLabel()} via=reprobe result=${ok === null ? "untested" : ok ? "ok" : "fail"} elapsed_ms=${Date.now() - startedAt}`,
    );
    busyRef.current = false;
    if (!mountedRef.current) return;

    if (ok === null) {
      // 没测成不是不通：给「更新配置」再测一次，不给重置。
      replaceLast({
        id: "config",
        status: "unknown",
        conclusion: { kind: "config-untested", reason: untestedReason() },
      });
      updatePhase("awaiting");
    } else if (ok) {
      replaceLast({
        id: "config",
        status: "passed",
        conclusion: { kind: "config-recovered", changed: synced.changed },
      });
      updatePhase("done");
    } else {
      replaceLast({
        id: "config",
        status: "failed",
        conclusion: { kind: "config-failed", changed: synced.changed },
      });
      updatePhase("awaiting");
    }
  };

  const runReset = async () => {
    if (phaseRef.current !== "confirming" || busyRef.current) return;
    const startedAt = Date.now();
    busyRef.current = true;
    updatePhase("running");
    setSteps((prev) => [
      ...prev,
      { id: "rotate", status: "running", conclusion: { kind: "rotate-pending" } },
    ]);

    let outcome: RotateOutcome;
    try {
      outcome = await withTimeout(
        depsRef.current.rotateCredentials(),
        120_000,
        "agent_timeout",
      );
    } catch (error) {
      outcome = { ok: false, reason: probeErrorCode(error) ?? "" };
    }

    if (!outcome.ok) {
      const reason = outcome.reason.trim() === "" ? null : outcome.reason;
      // 超时不是失败：命令可能仍在跑或已经成功。
      const timedOut = reason === "agent_timeout";
      log(
        "warn",
        `rotate ok=false reason=${reason ?? "none"}${timedOut ? " result=timeout" : ""} runtime=${runtimeLabel()} elapsed_ms=${Date.now() - startedAt}`,
      );
      collectedRef.current.rotateOk = false;
      collectedRef.current.rotateReason = reason;
      collectedRef.current.rotateTimedOut = timedOut;
      busyRef.current = false;
      if (mountedRef.current) {
        replaceLast({
          id: "rotate",
          status: timedOut ? "unknown" : "failed",
          conclusion: timedOut
            ? { kind: "rotate-timeout" }
            : { kind: "rotate-failed", reason },
        });
        updatePhase("awaiting");
      }
      return;
    }

    collectedRef.current.rotateOk = true;
    collectedRef.current.rotatePort = outcome.port;

    // 没在跑隧道：端口已经换了，但不探测、也不替用户自动连接。
    if (!depsRef.current.isRuntimeRunning()) {
      log(
        "info",
        `rotate ok=true port=${outcome.port} runtime=idle result=applied elapsed_ms=${Date.now() - startedAt}`,
      );
      busyRef.current = false;
      if (!mountedRef.current) return;
      replaceLast({
        id: "rotate",
        status: "passed",
        conclusion: { kind: "rotate-applied-idle" },
      });
      updatePhase("done");
      return;
    }

    // 面板关掉也要把已确认的动作收尾；跑的是别的节点时只重测，不重启它。
    const reconnected = depsRef.current.isTunnelRunning();
    if (reconnected) {
      let result: ReconnectOutcome;
      try {
        result = await depsRef.current.reconnectAndProbe();
      } catch {
        result = "reconnect-failed";
      }
      collectedRef.current.reconnect =
        result === "ok" ? true : result === "probe-untested" ? null : false;

      log(
        "info",
        `rotate ok=true port=${outcome.port} runtime=this via=reconnect result=${result} elapsed_ms=${Date.now() - startedAt}`,
      );
      busyRef.current = false;
      if (!mountedRef.current) return;

      if (result === "ok") {
        replaceLast({
          id: "rotate",
          status: "passed",
          conclusion: { kind: "rotate-recovered" },
        });
        updatePhase("done");
      } else if (result === "reconnect-failed") {
        // 重连本身没成：别说「仍然不通」，给 AI。
        replaceLast({
          id: "rotate",
          status: "failed",
          conclusion: { kind: "rotate-reconnect-failed" },
        });
        updatePhase("awaiting");
      } else if (result === "probe-untested") {
        replaceLast({
          id: "rotate",
          status: "unknown",
          conclusion: { kind: "rotate-untested", reason: untestedReason() },
        });
        updatePhase("awaiting");
      } else {
        replaceLast({
          id: "rotate",
          status: "failed",
          conclusion: { kind: "rotate-still-failed" },
        });
        updatePhase("awaiting");
      }
      return;
    }

    let ok: ProbeOutcome;
    try {
      ok = await depsRef.current.reprobe();
    } catch {
      ok = null;
    }
    collectedRef.current.reprobe = ok;

    log(
      "info",
      `rotate ok=true port=${outcome.port} runtime=other via=reprobe result=${ok === null ? "untested" : ok ? "ok" : "fail"} elapsed_ms=${Date.now() - startedAt}`,
    );
    busyRef.current = false;
    if (!mountedRef.current) return;

    if (ok === null) {
      replaceLast({
        id: "rotate",
        status: "unknown",
        conclusion: { kind: "rotate-untested", reason: untestedReason() },
      });
      updatePhase("awaiting");
    } else if (ok) {
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
        conclusion: { kind: "rotate-still-failed" },
      });
      updatePhase("awaiting");
    }
  };

  /** 重置后的重测：只 reprobe，不再 rotate；同一轮最多 2 次。 */
  const runPostRotateRetest = async () => {
    const startedAt = Date.now();
    busyRef.current = true;
    postRotateRetestsRef.current += 1;
    updatePhase("running");
    replaceLast({
      id: "rotate",
      status: "running",
      conclusion: { kind: "rotate-pending" },
    });
    log("info", `action=retest n=${postRotateRetestsRef.current}`);

    let ok: ProbeOutcome;
    try {
      ok = await depsRef.current.reprobe();
    } catch {
      ok = null;
    }
    collectedRef.current.reprobe = ok;

    log(
      "info",
      `rotate retest n=${postRotateRetestsRef.current} result=${ok === null ? "untested" : ok ? "ok" : "fail"} elapsed_ms=${Date.now() - startedAt}`,
    );
    busyRef.current = false;
    if (!mountedRef.current) return;

    if (ok === null) {
      replaceLast({
        id: "rotate",
        status: "unknown",
        conclusion: { kind: "rotate-untested", reason: untestedReason() },
      });
      updatePhase("awaiting");
    } else if (ok) {
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
        conclusion: { kind: "rotate-still-failed" },
      });
      updatePhase("awaiting");
    }
  };

  const handOffToAi = () => {
    const handed = depsRef.current.openAi(
      buildContext(depsRef.current.facts, collectedRef.current),
    );
    if (handed === false) {
      // AI 还没配置：面板留着，用户配好后可以再点一次。
      log("warn", "ai blocked");
      return;
    }
    log(
      "info",
      `ai handed steps=${stepsRef.current.map((step) => `${step.id}:${step.status}`).join(",")}`,
    );
    setSteps((prev) => [
      ...prev,
      { id: "ai", status: "passed", conclusion: { kind: "ai-handed" } },
    ]);
    updatePhase("done");
  };

  const run = () => {
    if (busyRef.current) return;
    const action = deriveAction(
      stepsRef.current,
      phaseRef.current,
      configAttemptsRef.current,
      postRotateRetestsRef.current,
    );
    if (action === null) return;
    switch (action) {
      case "start":
        void startConnectivity();
        break;
      case "updateConfig":
        log("info", "action=update-config");
        void runConfig();
        break;
      case "resetPort":
        log("info", "action=reset");
        updatePhase("confirming");
        break;
      case "retest":
        void runPostRotateRetest();
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
    action: deriveAction(
      steps,
      phase,
      configAttemptsRef.current,
      postRotateRetestsRef.current,
    ),
    context: buildContext(depsRef.current.facts, collectedRef.current),
    run,
    confirmReset,
    cancelReset,
  };
}
