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
  /** ping 通后自动跑的 sing-box 可用性（Clash 延迟）；没走这一步为 null。 */
  proxy: {
    reachable: boolean | null;
    latency_ms: number | null;
    reason: string | null;
  } | null;
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
    /** 更换命令超时：可能仍在跑或已经成功。 */
    timed_out: boolean;
  };
  client: {
    app_version: string;
    platform: string;
    ui_log_path: string | null;
  };
}

/**
 * 连接失败链路的静态事实（node-diagnosis-flow.md §10.5）。
 * 只放非敏感字段：不含地址、端口、密码、令牌、uuid。
 */
export interface ConnectionFacts {
  /** 失败发生在哪一步：connect / starting / running / failed。 */
  failureStage: "connect" | "starting" | "running" | "failed";
  errorCode: string | null;
  errorReason: string | null;
  nodeName: string | null;
  nodeSource: "owned" | "manual" | null;
  /** 地区名（不含地址）。 */
  region: string | null;
  /** 接管方式：system_proxy / tun。 */
  connectMode: string | null;
  /** 打开诊断时读控制面失败：只有它和连通性同时失败才判「没有网络」。 */
  controlPlaneError: string | null;
  appVersion: string;
  platform: string;
}

/** connection 档的本地检查（runtime_status + config_detail + tun_helper_info，本地、不联网）。 */
export interface ConnectionLocalCheck {
  runtimeState: string;
  runtimeErrorCode: string | null;
  runtimeErrorReason: string | null;
  /** `tun_helper_info` 的 state 归类：unknown 不判 helper，继续往下。 */
  helperState: "ok" | "blocked" | "unknown";
  /** config_detail 读成功（配置存在且可解析）。 */
  configFound: boolean;
  /** 当前节点还在这套配置里。 */
  nodeInConfig: boolean;
}

/** 结论后的「重新测一次」（node_probe，Clash 延迟）：null = 没测成。 */
export interface ConnectionRetest {
  reachable: boolean | null;
  reason: string | null;
  latencyMs: number | null;
}

/** 交给 AI 的连接失败清单（§10.5）。任何敏感项都不得进入这个对象。 */
export interface ConnectionDiagnosisContext {
  failure: {
    stage: string;
    code: string | null;
    reason: string | null;
  };
  node: {
    name: string | null;
    source: "owned" | "manual" | null;
    region: string | null;
  };
  runtime: {
    state: string;
    helper: "ok" | "blocked" | "unknown";
    mode: string | null;
    /** 本地检查没跑完时失败的命令与短码，例如 `runtime_status:INTERNAL`。 */
    check_error: string | null;
  };
  /** 本地配置检查的结论：探测失败时也照常带进清单。 */
  config: {
    found: boolean;
    node_present: boolean;
  };
  steps: Array<{
    id: string;
    status: string;
    conclusion: string;
    code: string | null;
  }>;
  probe: {
    icmp: { ok: boolean; rtt_ms: number | null } | null;
    tcp: { ok: boolean; ms: number | null; error: string | null } | null;
    error: string | null;
    retest: { reachable: boolean | null; reason: string | null; latency_ms: number | null } | null;
  };
  attempted: Array<{ action: string; result: string }>;
  client: {
    app_version: string;
    platform: string;
  };
}

/** connection 档的依赖；node 档字段（同步 / 更换）在这一档不参与。 */
export interface ConnectionDiagnosisDeps {
  facts: ConnectionFacts;
  /** 本地检查：runtime_status + config_detail。 */
  check: () => Promise<ConnectionLocalCheck>;
  /** 结论后的「重新测一次」：node_probe，20 秒上限。 */
  retest: () => Promise<ConnectionRetest>;
  /** helper 未运行 / 未授权：打开设置。 */
  openSettings?: () => void;
  /** 配置里没有这个节点 / 配置失效：同步配置。 */
  updateConfig?: () => void;
  /** 节点地址不通：回到节点列表换一个。 */
  changeNode?: () => void;
  /** 结论是「节点现在能连通」：等同 hero 的重新连接。 */
  reconnect?: () => void;
  /** 把连接失败清单交给 AI；false = 被拦下（AI 未配置）。 */
  openAi: (context: ConnectionDiagnosisContext) => boolean;
}

/** 全部依赖从参数注入，Hook 不直接碰 bridge。 */
export interface DiagnosisDeps {
  /** "node"（默认）= 节点行 / 服务器详情链路；"connection" = 连接失败链路。 */
  profile?: "node" | "connection";
  /** profile === "connection" 时必须提供。 */
  connection?: ConnectionDiagnosisDeps;
  facts: DiagnosisFacts;
  /** 隧道正在运行，且跑的就是这台节点；每次判定时现读，避免旧快照。 */
  isTunnelRunning: () => boolean;
  /** 隧道正在运行任意节点；每次判定时现读。 */
  isRuntimeRunning: () => boolean;
  /** ICMP + TCP 32100；Host 侧命令一次返回两项。connection 档拿不到 IP 时不注入（记 skipped）。 */
  probeReachability?: () => Promise<ProbeReport>;
  /* 以下为 node 档专用；connection 档不传、也不会被调用。 */
  /** ping 通后自动确认代理是否可用（`node_probe`，Clash 延迟）；只读，不重启隧道。 */
  probeProxy?: () => Promise<ConnectionRetest>;
  /** 全量同步（`myServerSync`），判断这台是否有变化。 */
  syncConfig?: () => Promise<SyncOutcome>;
  /** 只重测一次，不重启隧道；null = 没测成（untested）。 */
  reprobe?: () => Promise<ProbeOutcome>;
  /** 最近一次 untested 的 Host 原因（connection_busy / node_not_in_config / node_not_in_running_config / clash_unavailable）；没有为 null。 */
  probeUntestedReason?: () => string | null;
  /** stop → start → 重测；重连失败与重连后测不通要分开。 */
  reconnectAndProbe?: () => Promise<ReconnectOutcome>;
  /** 更换这台节点的端口与密码（`node_rotate_credentials`）。 */
  rotateCredentials?: () => Promise<RotateOutcome>;
  /** 打开右栏，把诊断清单作为一条系统消息交给 AI。返回 false = 被拦下（AI 未配置）。 */
  openAi?: (context: DiagnosisContext) => boolean;
  /** 「去销毁并重建」只做导航；销毁仍在服务器详情页确认。 */
  onGoToServers?: () => void;
  /** 开始分析时把本次关联短码交给调用方，供 Hook 之外的日志复用。 */
  onRunStart?: (run: string) => void;
}

export type DiagnosisStepId =
  | "connectivity"
  | "probe"
  | "config"
  | "rotate"
  | "retest"
  | "ai";

export type DiagnosisConclusion =
  | { kind: "connectivity-pending" }
  | {
      kind: "connectivity-ok";
      /** 只有 ICMP 被屏蔽、靠 TCP 确认时是 true。 */
      viaTcp: boolean;
      icmpMs: number | null;
      tcpMs: number | null;
    }
  /** ping 通后自动跑的 sing-box 可用性（Clash 延迟）。 */
  | { kind: "proxy-pending" }
  | { kind: "proxy-ok"; latencyMs: number | null }
  | { kind: "proxy-failed" }
  | { kind: "proxy-untested"; reason: string | null }
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
  /** 配置没有变化，且隧道没在跑：结论中性，下一步给更换连接密码。 */
  | { kind: "config-unchanged" }
  | { kind: "rotate-pending" }
  | { kind: "rotate-recovered" }
  | { kind: "rotate-reconnect-failed" }
  /** 更换命令超时：可能仍在跑或已经成功，不按失败处理。 */
  | { kind: "rotate-timeout" }
  /** 更换成功，但重测没跑成（untested）：reason 是 Host 给的原因。 */
  | { kind: "rotate-untested"; reason: string | null }
  /** 更换成功，但跑的是别的节点、只重测仍不通。 */
  | { kind: "rotate-still-failed" }
  /** 更换成功，但隧道没在跑：不探测、不自动连接。 */
  | { kind: "rotate-applied-idle" }
  | { kind: "rotate-failed"; reason: string | null }
  | { kind: "ai-handed" }
  /** connection 档：helper 未运行 / 未授权。 */
  | { kind: "runtime-helper-blocked" }
  /** connection 档：配置里没有这个节点。 */
  | { kind: "config-node-missing" }
  /** connection 档：配置读不出来，可能已失效。 */
  | { kind: "config-invalid" }
  /** connection 档：节点地址不通。 */
  | { kind: "server-unreachable" }
  /** connection 档：重新测一次没测成（reason 是 Host 给的原因）。 */
  | { kind: "probe-untested"; reason: string | null }
  /** connection 档：运行时报错，本地没有对应修复动作。 */
  | { kind: "runtime-error" }
  /** connection 档：本地检查都过、仍连不上。 */
  | { kind: "connection-undetermined" }
  /** connection 档：重新测一次测通了。 */
  | { kind: "probe-ok" }
  /** connection 档：这一档不适用的检查（例如手动节点拿不到 IP）。 */
  | { kind: "skipped" };

export interface DiagnosisStep {
  id: DiagnosisStepId;
  /** unknown = 没测成 / 可能仍在进行：不是确定性失败，界面不画 ✕；skipped = 这一档不适用。 */
  status: "running" | "passed" | "failed" | "unknown" | "skipped";
  conclusion: DiagnosisConclusion;
}

export type DiagnosisAction =
  | "start"
  | "updateConfig"
  | "resetPort"
  | "retest"
  | "askAi"
  | "goServers"
  | "openSettings"
  | "changeNode"
  | "reconnect";

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
  /** 执行当前主按钮（开始分析 / 同步配置 / 更换连接密码 / 去问 AI / 去销毁）。 */
  run: () => void;
  /** 更换的二次确认：确认后才真正调 rotateCredentials。 */
  confirmReset: () => void;
  cancelReset: () => void;
  /** connection 档：结论后可以再测一次（node_probe）；其它情况为 null。 */
  retestProbe: (() => void) | null;
}

interface Collected {
  icmp: IcmpProbe | null;
  tcp: TcpProbe | null;
  probeError: string | null;
  proxy: ConnectionRetest | null;
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
    proxy: null,
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
    case "proxy-ok":
    case "proxy-untested":
      // 代理确认可用或这次没测成：只留关闭，不再推同步配置。
      return null;
    case "proxy-failed":
      // ping 通但代理不通：先同步配置，再走原来的重连/重测链路。
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
      // 没测成不是不通：同一轮最多试 3 次同步配置，之后交 AI。
      return configAttempts < 3 ? "updateConfig" : "askAi";
    case "config-unchanged":
      return "resetPort";
    case "config-failed":
      // 配置可能是别的设备改的：ICMP 通说明 IP 没被封，更换通常还能救回来。
      return "resetPort";
    case "rotate-untested":
      // 更换后最多再测 2 次，仍没测成才交 AI；更换本身不再给第二次。
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

/** 本地步骤的结论：helper → 配置 → 运行时错误 → 未定；连通性有自己的步骤。 */
function deriveLocalConclusion(
  connectivity: DiagnosisConclusion,
  local: ConnectionLocalCheck | null,
): DiagnosisConclusion {
  if (local === null) return { kind: "runtime-error" };
  if (local.helperState === "blocked") return { kind: "runtime-helper-blocked" };
  if (!local.configFound) return { kind: "config-invalid" };
  if (!local.nodeInConfig) return { kind: "config-node-missing" };
  const nodeFailure =
    connectivity.kind === "server-unreachable" || connectivity.kind === "service-down";
  if (
    !nodeFailure &&
    (local.runtimeErrorCode !== null || local.runtimeErrorReason !== null)
  ) {
    return { kind: "runtime-error" };
  }
  return { kind: "connection-undetermined" };
}

/** 10.3 的固定优先级：探测自身 / 网络 → helper → 配置 → 节点。 */
function deriveConnectionFinal(
  connectivity: DiagnosisConclusion,
  localConclusion: DiagnosisConclusion,
): DiagnosisConclusion {
  if (connectivity.kind === "probe-error") return connectivity;
  if (connectivity.kind === "local-network") return connectivity;
  if (localConclusion.kind === "runtime-helper-blocked") return localConclusion;
  if (localConclusion.kind === "config-invalid") return localConclusion;
  if (localConclusion.kind === "config-node-missing") return localConclusion;
  if (connectivity.kind === "service-down") return connectivity;
  if (localConclusion.kind === "runtime-error") return localConclusion;
  if (connectivity.kind === "server-unreachable") return connectivity;
  return localConclusion;
}

function connectionStatus(conclusion: DiagnosisConclusion): DiagnosisStep["status"] {
  switch (conclusion.kind) {
    case "probe-error":
    case "runtime-helper-blocked":
    case "config-node-missing":
    case "config-invalid":
    case "server-unreachable":
    case "service-down":
    case "runtime-error":
      return "failed";
    case "probe-untested":
    case "connection-undetermined":
      return "unknown";
    case "skipped":
      return "skipped";
    default:
      return "passed";
  }
}

function connectionActionFor(
  conclusion: DiagnosisConclusion | null,
  phase: DiagnosisPhase,
): DiagnosisAction | null {
  if (phase === "running" || phase === "confirming" || phase === "done") return null;
  if (conclusion === null) return "start";
  switch (conclusion.kind) {
    case "local-network":
      return "retest";
    case "runtime-helper-blocked":
      return "openSettings";
    case "config-invalid":
      return "updateConfig";
    case "config-node-missing":
    case "server-unreachable":
    case "service-down":
      return "changeNode";
    case "probe-ok":
      return "reconnect";
    case "probe-error":
    case "runtime-error":
    case "connection-undetermined":
      return "askAi";
    case "probe-untested":
      switch (conclusion.reason) {
        case "node_not_in_config":
          return "updateConfig";
        case "node_not_in_running_config":
        case "connection_busy":
        case "clash_unavailable":
          return "retest";
        case "no_credentials":
          return "changeNode";
        // runtime_missing / runtime_failed / runtime_timeout 与未知值：交 AI。
        default:
          return "askAi";
      }
    default:
      return null;
  }
}

function connectionStepCode(conclusion: DiagnosisConclusion): string | null {
  if (conclusion.kind === "probe-error") return conclusion.code;
  if (conclusion.kind === "probe-untested") return conclusion.reason;
  return null;
}

interface ConnCollected {
  icmp: IcmpProbe | null;
  tcp: TcpProbe | null;
  probeError: string | null;
  local: ConnectionLocalCheck | null;
  /** 本地检查本身没跑完：失败的命令与短码。 */
  localError: string | null;
  retest: ConnectionRetest | null;
  connectivity: DiagnosisConclusion | null;
  final: DiagnosisConclusion | null;
  attempted: Array<{ action: string; result: string }>;
}

function emptyConnCollected(): ConnCollected {
  return {
    icmp: null,
    tcp: null,
    probeError: null,
    local: null,
    localError: null,
    retest: null,
    connectivity: null,
    final: null,
    attempted: [],
  };
}

/** 交给 AI 的连接失败清单：只含事实与稳定短码，不含地址、端口、凭据。 */
function buildConnectionContext(
  facts: ConnectionFacts,
  collected: ConnCollected,
  steps: DiagnosisStep[],
): ConnectionDiagnosisContext {
  return {
    failure: {
      stage: facts.failureStage,
      code: facts.errorCode,
      reason: facts.errorReason,
    },
    node: {
      name: facts.nodeName,
      source: facts.nodeSource,
      region: facts.region,
    },
    runtime: {
      state: collected.local?.runtimeState ?? facts.failureStage,
      helper: collected.local?.helperState ?? "unknown",
      mode: facts.connectMode,
      check_error: collected.localError,
    },
    config: {
      found: collected.local?.configFound ?? false,
      node_present: collected.local?.nodeInConfig ?? false,
    },
    steps: steps.map((step) => ({
      id: step.id,
      status: step.status,
      conclusion: step.conclusion.kind,
      code: connectionStepCode(step.conclusion),
    })),
    probe: {
      icmp: collected.icmp
        ? { ok: collected.icmp.ok, rtt_ms: collected.icmp.rtt_ms }
        : null,
      tcp: collected.tcp
        ? { ok: collected.tcp.ok, ms: collected.tcp.ms, error: collected.tcp.error }
        : null,
      error: collected.probeError,
      retest: collected.retest
        ? {
            reachable: collected.retest.reachable,
            reason: collected.retest.reason,
            latency_ms: collected.retest.latencyMs,
          }
        : null,
    },
    attempted: [...collected.attempted],
    client: {
      app_version: facts.appVersion,
      platform: facts.platform,
    },
  };
}

function buildContext(
  facts: DiagnosisFacts,
  collected: Collected,
): DiagnosisContext {  const port =
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
    proxy: collected.proxy
      ? {
          reachable: collected.proxy.reachable,
          latency_ms: collected.proxy.latencyMs,
          reason: collected.proxy.reason,
        }
      : null,
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
    `diagnosis run=${run ?? "none"} steps=${codes} runtime=${runtime} icmp=${boolCode(collected.icmp?.ok ?? null)} tcp=${boolCode(collected.tcp?.ok ?? null)} probe_error=${collected.probeError ?? "none"} proxy=${collected.proxy ? (collected.proxy.reachable === null ? `untested:${collected.proxy.reason ?? "none"}` : collected.proxy.reachable ? "ok" : "fail") : "none"} changed=${triCode(collected.syncChanged)} reprobe=${triCode(collected.reprobe)} reconnect=${triCode(collected.reconnect)} control_plane_error=${collected.controlPlaneError ?? "none"} rotate=${rotate}`,
    "node-diagnosis",
  );
}

export function useNodeDiagnosis(deps: DiagnosisDeps): NodeDiagnosis {
  const [steps, setSteps] = useState<DiagnosisStep[]>([]);
  const [phase, setPhase] = useState<DiagnosisPhase>("idle");

  const depsRef = useRef(deps);
  depsRef.current = deps;

  /** node 档专用依赖在类型上是可选的（connection 档不传），实际到了这里一定存在。 */
  const nodeDeps = () =>
    depsRef.current as DiagnosisDeps & {
      probeReachability: () => Promise<ProbeReport>;
      probeProxy: () => Promise<ConnectionRetest>;
      syncConfig: () => Promise<SyncOutcome>;
      reprobe: () => Promise<ProbeOutcome>;
      reconnectAndProbe: () => Promise<ReconnectOutcome>;
      rotateCredentials: () => Promise<RotateOutcome>;
      openAi: (context: DiagnosisContext) => boolean;
    };

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
  /** connection 档：一次诊断内收集的连接快照。 */
  const connRef = useRef<ConnCollected>(emptyConnCollected());
  const connStartedRef = useRef(false);

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

  /**
   * ping 通后自动确认代理是否已经可用：只读 `node_probe`（Clash 延迟），
   * 不重启隧道。通或没测成都不再推修复动作，只有确定不通才回到同步配置。
   */
  const runProxyProbe = async () => {
    busyRef.current = true;
    updatePhase("running");
    setSteps((prev) => [
      ...prev,
      { id: "probe", status: "running", conclusion: { kind: "proxy-pending" } },
    ]);
    log("info", "action=probe-proxy");

    let outcome: ConnectionRetest;
    try {
      outcome = await withTimeout(nodeDeps().probeProxy(), 20_000, "timeout");
    } catch (error) {
      outcome = {
        reachable: null,
        reason: probeErrorCode(error) ?? "probe_error",
        latencyMs: null,
      };
    }
    collectedRef.current.proxy = outcome;
    busyRef.current = false;
    if (!mountedRef.current) return;

    log(
      "info",
      `proxy result=${outcome.reachable === null ? "untested" : outcome.reachable ? "ok" : "fail"} latency=${outcome.latencyMs ?? "none"} reason=${outcome.reason ?? "none"}`,
    );

    if (outcome.reachable === null) {
      replaceLast({
        id: "probe",
        status: "unknown",
        conclusion: { kind: "proxy-untested", reason: outcome.reason },
      });
      updatePhase("done");
    } else if (outcome.reachable) {
      replaceLast({
        id: "probe",
        status: "passed",
        conclusion: { kind: "proxy-ok", latencyMs: outcome.latencyMs },
      });
      updatePhase("done");
    } else {
      replaceLast({
        id: "probe",
        status: "failed",
        conclusion: { kind: "proxy-failed" },
      });
      updatePhase("awaiting");
    }
  };

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
        nodeDeps().probeReachability(),
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
      // ping 通不等于代理能用：先自动跑一次 Clash 延迟，确认是不是已经恢复。
      await runProxyProbe();
      return;
    } else if (report.tcp.error === "refused") {
      // 端口回了 RST：机器活着，只是控制服务没在听；更换也要 agent 在线，先交 AI。
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
        nodeDeps().syncConfig(),
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

    // 超时不是失败：命令可能仍在跑或已经成功，别让用户照着「失败」去更换。
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

    // 运行中的隧道可能拿着旧凭据（刚在别处更换过端口、另一台设备改了配置）：
    // 桌面端看不到运行配置里的端口，所以只要跑的就是这台，就先 stop → start 再测。
    // 端口没变也重连——「没变」只说明本机记录已是最新，不代表隧道里是新的。
    const reconnect = runtimeLabel() === "this";
    if (reconnect) {
      let result: ReconnectOutcome;
      try {
        result = await nodeDeps().reconnectAndProbe();
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
      ok = await nodeDeps().reprobe();
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
      // 没测成不是不通：给「同步配置」再测一次，不给更换密码。
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
        nodeDeps().rotateCredentials(),
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
        result = await nodeDeps().reconnectAndProbe();
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
      ok = await nodeDeps().reprobe();
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

  /** 更换后的重测：只 reprobe，不再 rotate；同一轮最多 2 次。 */
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
      ok = await nodeDeps().reprobe();
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

  /**
   * connection 档：自动只跑两项 —— ① `node_probe_reachability`（10 秒硬超时），
   * ② 本地 `runtime_status` + `config_detail`。`node_probe` 只在结论后由用户点。
   */
  const startConnection = async () => {
    const conn = depsRef.current.connection;
    if (!conn || busyRef.current) return;
    busyRef.current = true;
    updatePhase("running");
    connRef.current = emptyConnCollected();
    setSteps([
      {
        id: "connectivity",
        status: "running",
        conclusion: { kind: "connectivity-pending" },
      },
    ]);
    runRef.current = makeRunCode();
    depsRef.current.onRunStart?.(runRef.current);
    log(
      "info",
      `start profile=connection stage=${conn.facts.failureStage} node=${conn.facts.nodeName ?? "none"} source=${conn.facts.nodeSource ?? "none"} runtime=${runtimeLabel()}`,
    );

    let report: ProbeReport | null = null;
    let probeError: string | null = null;
    const reachability = depsRef.current.probeReachability;
    // 拿不到地址（手动导入节点）：这一档的连通性检查不适用，记 skipped。
    const skipped = reachability === undefined;
    if (reachability) {
      try {
        report = await withTimeout(reachability(), 10_000, "timeout");
      } catch (error) {
        probeError = probeErrorCode(error);
      }
    }
    if (!mountedRef.current) {
      busyRef.current = false;
      return;
    }
    connRef.current.probeError = probeError;

    let step: DiagnosisStep;
    if (skipped) {
      step = { id: "connectivity", status: "skipped", conclusion: { kind: "skipped" } };
    } else if (report === null) {
      // 探测本身没跑起来（含 10 秒硬超时）：不是节点不通，交给 AI。
      step = {
        id: "connectivity",
        status: "failed",
        conclusion: { kind: "probe-error", code: probeError },
      };
    } else {
      connRef.current.icmp = report.icmp;
      connRef.current.tcp = report.tcp;
      if (report.icmp.ok || report.tcp.ok) {
        step = {
          id: "connectivity",
          status: "passed",
          conclusion: {
            kind: "connectivity-ok",
            viaTcp: !report.icmp.ok,
            icmpMs: report.icmp.ok ? report.icmp.rtt_ms : null,
            tcpMs: report.tcp.ok ? report.tcp.ms : null,
          },
        };
      } else if (report.icmp.error) {
        // ICMP 命令自己没跑成（spawn_failed / timeout / io_error），与「不回包」分开。
        step = {
          id: "connectivity",
          status: "failed",
          conclusion: { kind: "probe-error", code: report.icmp.error },
        };
        connRef.current.probeError = report.icmp.error;
      } else if (conn.facts.controlPlaneError) {
        // 连通性失败 + 控制面也取不到 = 本机没网；只满足一个不算。
        step = {
          id: "connectivity",
          status: "failed",
          conclusion: { kind: "local-network" },
        };
      } else if (report.tcp.error === "refused") {
        // 机器在线、只是控制服务没有响应：与「地址不通」分开。
        step = {
          id: "connectivity",
          status: "failed",
          conclusion: { kind: "service-down" },
        };
      } else {
        step = {
          id: "connectivity",
          status: "failed",
          conclusion: { kind: "server-unreachable" },
        };
      }
    }
    connRef.current.connectivity = step.conclusion;
    connRef.current.attempted.push({
      action: "reachability",
      result: skipped
        ? "skipped"
        : report === null
          ? "error"
          : report.icmp.ok || report.tcp.ok
            ? "ok"
            : "fail",
    });
    log(
      "info",
      `connection connectivity=${step.conclusion.kind} icmp=${boolCode(connRef.current.icmp?.ok ?? null)} tcp=${boolCode(connRef.current.tcp?.ok ?? null)} probe_error=${connRef.current.probeError ?? "none"}`,
    );
    setSteps([step]);
    await runConnectionLocalCheck(step.conclusion);
  };

  /** 第二项：本地运行态与配置；步骤照常画出来，动作由 10.3 优先级决定。 */
  const runConnectionLocalCheck = async (connectivity: DiagnosisConclusion) => {
    const conn = depsRef.current.connection;
    if (!conn) return;
    busyRef.current = true;
    updatePhase("running");
    setSteps((prev) => [
      ...prev,
      { id: "config", status: "running", conclusion: { kind: "config-pending" } },
    ]);

    let local: ConnectionLocalCheck | null = null;
    let localError: string | null = null;
    try {
      local = await withTimeout(conn.check(), 5_000, "timeout");
    } catch (error) {
      const code = probeErrorCode(error) ?? "throw";
      // 本地命令没跑完不是「检查都通过」：带上失败的命令与短码进 facts。
      localError = code === "timeout" ? "local_check:timeout" : code;
      local = null;
    }
    if (!mountedRef.current) {
      busyRef.current = false;
      return;
    }
    connRef.current.local = local;
    connRef.current.localError = localError;

    const localConclusion = deriveLocalConclusion(connectivity, local);
    const final = deriveConnectionFinal(connectivity, localConclusion);
    connRef.current.final = final;
    connRef.current.attempted.push({
      action: "local_check",
      result: local === null ? localError ?? "failed" : localConclusion.kind,
    });
    log(
      "info",
      `connection local runtime=${local?.runtimeState ?? "none"} helper=${local?.helperState ?? "unknown"} config=${local?.configFound ? "ok" : "invalid"} node=${local?.nodeInConfig ? "in" : "missing"} error=${localError ?? "none"} step=${localConclusion.kind} final=${final.kind}`,
    );
    busyRef.current = false;

    replaceLast({
      id: "config",
      status: connectionStatus(localConclusion),
      conclusion: localConclusion,
    });
    updatePhase("awaiting");
  };

  /** 结论后的「重新测一次」：只跑 node_probe，不重跑整轮。 */
  const runConnectionRetest = async () => {
    const conn = depsRef.current.connection;
    if (!conn || busyRef.current) return;
    busyRef.current = true;
    updatePhase("running");
    connRef.current.attempted.push({ action: "retest", result: "requested" });
    setSteps((prev) => [
      ...prev,
      {
        id: "retest",
        status: "running",
        conclusion: { kind: "connectivity-pending" },
      },
    ]);

    let outcome: ConnectionRetest;
    try {
      outcome = await withTimeout(conn.retest(), 20_000, "timeout");
    } catch (error) {
      outcome = {
        reachable: null,
        reason: probeErrorCode(error) ?? "timeout",
        latencyMs: null,
      };
    }
    if (!mountedRef.current) {
      busyRef.current = false;
      return;
    }
    connRef.current.retest = outcome;

    const previous = connRef.current.final;
    let final: DiagnosisConclusion;
    if (outcome.reachable === null) {
      final = { kind: "probe-untested", reason: outcome.reason };
      // Clash 接口重测后仍读不到：运行时的问题，再点一次重测也是白点，交 AI。
      if (
        outcome.reason === "clash_unavailable" &&
        previous?.kind === "probe-untested" &&
        previous.reason === "clash_unavailable"
      ) {
        final = { kind: "runtime-error" };
      }
    } else if (outcome.reachable) {
      // 测通了就该去重连，不能落进 askAi 集合。
      final = { kind: "probe-ok" };
    } else {
      final = { kind: "server-unreachable" };
    }
    connRef.current.final = final;
    connRef.current.attempted.push({
      action: "retest",
      result:
        outcome.reachable === null
          ? `untested:${outcome.reason ?? "none"}`
          : outcome.reachable
            ? "ok"
            : "fail",
    });
    log(
      "info",
      `connection retest result=${outcome.reachable === null ? "untested" : outcome.reachable ? "ok" : "fail"} reason=${outcome.reason ?? "none"} final=${final.kind}`,
    );

    busyRef.current = false;
    replaceLast({
      id: "retest",
      status: connectionStatus(final),
      conclusion: final,
    });
    updatePhase("awaiting");
  };

  /** 配置问题：先让调用方刷新配置，再重读一次本地检查。 */
  const runConnectionUpdateConfig = () => {
    const conn = depsRef.current.connection;
    if (!conn || busyRef.current) return;
    log("info", "action=update-config profile=connection");
    connRef.current.attempted.push({ action: "update_config", result: "requested" });
    conn.updateConfig?.();
    const connectivity = connRef.current.connectivity;
    if (connectivity) void runConnectionLocalCheck(connectivity);
  };

  /** 只导航：打开设置 / 回到节点列表 / 重新连接，本版不调修复命令。 */
  const finishConnection = (
    action: "open_settings" | "change_node" | "reconnect",
    run: () => void,
  ) => {
    log("info", `action=${action}`);
    connRef.current.attempted.push({ action, result: "done" });
    updatePhase("done");
    run();
  };

  const handOffConnectionToAi = () => {
    const conn = depsRef.current.connection;
    if (!conn) return;
    const handed = conn.openAi(
      buildConnectionContext(
        conn.facts,
        connRef.current,
        stepsRef.current,
      ),
    );
    if (handed === false) {
      // AI 还没配置：结论留在面板上，用户配好后可以再点一次。
      log("warn", "ai blocked");
      connRef.current.attempted.push({ action: "ask_ai", result: "blocked" });
      return;
    }
    connRef.current.attempted.push({ action: "ask_ai", result: "handed" });
    log(
      "info",
      `ai handed profile=connection steps=${stepsRef.current.map((step) => `${step.id}:${step.status}`).join(",")}`,
    );
    setSteps((prev) => [
      ...prev,
      { id: "ai", status: "passed", conclusion: { kind: "ai-handed" } },
    ]);
    updatePhase("done");
  };

  const handOffToAi = () => {
    const handed = nodeDeps().openAi(
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

  const isConnectionProfile = () => depsRef.current.profile === "connection";

  const run = () => {
    if (busyRef.current) return;
    const action = isConnectionProfile()
      ? connectionActionFor(connRef.current.final, phaseRef.current)
      : deriveAction(
          stepsRef.current,
          phaseRef.current,
          configAttemptsRef.current,
          postRotateRetestsRef.current,
        );
    if (action === null) return;
    switch (action) {
      case "start":
        if (isConnectionProfile()) void startConnection();
        else void startConnectivity();
        break;
      case "updateConfig":
        if (isConnectionProfile()) {
          runConnectionUpdateConfig();
        } else {
          log("info", "action=update-config");
          void runConfig();
        }
        break;
      case "resetPort":
        log("info", "action=reset");
        updatePhase("confirming");
        break;
      case "retest":
        if (isConnectionProfile()) {
          // 本机没网：恢复网络后重新检查整轮；其余情况只重测一次 node_probe。
          if (connRef.current.final?.kind === "local-network") {
            log("info", "action=retest-checks");
            void startConnection();
          } else {
            void runConnectionRetest();
          }
        } else {
          void runPostRotateRetest();
        }
        break;
      case "openSettings":
        finishConnection("open_settings", () =>
          depsRef.current.connection?.openSettings?.(),
        );
        break;
      case "changeNode":
        finishConnection("change_node", () =>
          depsRef.current.connection?.changeNode?.(),
        );
        break;
      case "reconnect":
        finishConnection("reconnect", () =>
          depsRef.current.connection?.reconnect?.(),
        );
        break;
      case "askAi":
        if (isConnectionProfile()) handOffConnectionToAi();
        else handOffToAi();
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

  // connection 档：入口即自动开始，不等用户再点「开始分析」。
  useEffect(() => {
    if (depsRef.current.profile !== "connection" || connStartedRef.current) return;
    connStartedRef.current = true;
    void startConnection();
    // 只在挂载时启动一次；deps 通过 ref 现读，不在这里重建。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const connectionFinal = connRef.current.final;
  const retestProbe =
    isConnectionProfile() &&
    phase === "awaiting" &&
    connectionFinal !== null &&
    (connectionFinal.kind === "server-unreachable" ||
      connectionFinal.kind === "runtime-error" ||
      connectionFinal.kind === "connection-undetermined" ||
      connectionFinal.kind === "probe-untested")
      ? () => {
          if (!busyRef.current) void runConnectionRetest();
        }
      : null;

  return {
    steps,
    phase,
    action: isConnectionProfile()
      ? connectionActionFor(connRef.current.final, phase)
      : deriveAction(
          steps,
          phase,
          configAttemptsRef.current,
          postRotateRetestsRef.current,
        ),
    context: buildContext(depsRef.current.facts, collectedRef.current),
    run,
    confirmReset,
    cancelReset,
    retestProbe,
  };
}
