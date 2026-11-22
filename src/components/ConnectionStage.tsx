import { useEffect, useMemo, useRef, useState } from "react";
import type {
  ConfigConnectMode,
  ConfigDetail,
  ConfigRouteMode,
  RuntimeView,
} from "../agent/protocol";
import type { VpnConnectionState } from "../config/useVpnSession";
import type { NodeProbesController } from "../config/useNodeProbes";
import { dataPlaneDown } from "../ui/dataPlane";
import { formatClock } from "../ui/format";
import { failureHeadline } from "../ui/middleArea";
import { displayNodeNames, formatLatency } from "../ui/nodeList";
import { nodeTombstoneWord, trialGroupHint, trialPhase } from "../myservers/labels";
import type { PendingServerNode } from "../myservers/pendingServerNodes";
import { nodeUnreachableAsk } from "../ui/assistantPrompts";
import { rotateFailureReason } from "../myservers/rotateCredentials";
import { uiLog } from "../log/uiLog";
import type { ActionCard } from "../ui/actionCard";
import { useT } from "../i18n";
import type { MessageKey } from "../i18n";
import { StageQuickToggles, type ModeSwitchResult } from "./StageQuickToggles";
import { NodeRepairDialog } from "./NodeRepairDialog";

interface Props {
  config: ConfigDetail | null;
  connection: VpnConnectionState;
  runtime: RuntimeView;
  onStart: () => void;
  onStop: () => void;
  onReconnect: () => void;
  onSwitchNode: (nodeId: string) => Promise<{ ok: boolean; message?: string }>;
  nodeProbes: NodeProbesController;
  /** 最近一次失败是否来自已连接态：决定失败标题。 */
  failedAfterConnected: boolean;
  /** 连接全部流量前正在准备后台组件：按钮要说明在等授权。 */
  helperPreparing: boolean;
  onReportProblem?: () => void;
  reportBusy?: boolean;
  /** AI 编排的 action_card；点击只上报，不执行命令。 */
  actionCards?: ActionCard[];
  onActionCardAction?: (action: { id: string; label: string }) => void;
  /** 连接失败时交给 AI 检查（固定前缀，跑 DiagRun）。 */
  onDiagnose?: () => void;
  /** 服务器已停机删除、只剩本地节点行：灰显、不可点，等用户去「我的服务器」删。 */
  danglingNodeIds?: ReadonlySet<string>;
  /** 免费节点步骤流完成后的收敛句：已加入 N 个免费节点，最快 Xms。 */
  trialSummary?: { configId: string; count: number; fastestMs: number | null } | null;
  /** 试用截止时间（ISO）：免费组标题右侧按剩余天数写到期文案。 */
  trialExpiresAt?: string | null;
  /** 试用步骤流完成时的一次性预选；之后任何测速都不重新推导。 */
  preselect?: {
    configId: string;
    nodeId: string;
    nonce: number;
    /** 只有试用流程测过速、标「最快」是实话；其它来路默认不标。 */
    markFastest?: boolean;
  } | null;
  /** 预选应用后通知 Host 消费掉，避免切走再回来二次应用。 */
  onPreselectApplied?: (nonce: number) => void;
  /** 手动测速：只更新延迟，不改选中、不连接。 */
  onProbe?: () => void;
  /** 本会话已手动测过速：收尾句去掉数字。 */
  manualProbed?: boolean;
  /** 测速入口是否可点；Host 据此决定 context 里是否列 client.probe。 */
  onProbeAvailabilityChange?: (available: boolean) => void;
  /** 舞台快捷切换：与设置页共用同一份状态与同一条命令。 */
  routingMode?: ConfigRouteMode | null;
  onSetConnectMode?: (
    mode: ConfigConnectMode,
    options?: { onRestoring?: () => void },
  ) => Promise<ModeSwitchResult>;
  onSetRoutingMode?: (
    mode: "direct" | "proxy_all",
  ) => Promise<{ ok: boolean; message?: string }>;
  /** 接管方式、流量范围与「测不通」动作：交给 App 展开右栏并发送固定问题。 */
  onAskAi?: (prompt: string) => void;
  /** 行内「问 AI」：额外带上节点 id，App 用来记住本轮在聊哪台。 */
  onAskAiAboutNode?: (nodeId: string, prompt: string) => void;
  /** 节点 id → 服务器 id（自有节点才查得到）；查不到不显示修复入口。 */
  serverIdForNode?: (nodeId: string) => string | null;
  /** 智能修复：由 App 调 Host 的 node_rotate_credentials。 */
  onRepairCredentials?: (serverId: string) => Promise<{ port: number }>;
  /** 坏行先静默同步这一台的凭据，返回最新端口；失败返回 null。 */
  onSyncCredentials?: (serverId: string) => Promise<number | null>;
  /** 「重新连接并测试」：先重连让运行时读新配置，再测；返回重连是否成功。 */
  onReconnectAndTest?: () => Promise<boolean>;
  /** 周期同步发现当前连接节点的配置变了：hero 区提示重新连接。 */
  staleConfigNode?: boolean;
  /** 用户点了 hero 的「重新连接」：调用方清掉提示。 */
  onStaleConfigRetry?: () => void;
  /** 「去我的服务器」导航（失败去向，不做销毁入口）。 */
  onGoServers?: () => void;
  /** 修复成功且自动重测有结果：交给 App 决定是否在右栏补一条系统提示。 */
  onRepaired?: (info: {
    nodeId: string;
    name: string;
    latencyMs: number;
  }) => void;
  /** 服务器已就绪、节点还在等断开后 attach：灰显列出，告诉用户重新连接后可用。 */
  pendingServerNodes?: PendingServerNode[];
}

/** 待接入节点类型对外导出：调用方与测试都从这里取。 */
export type { PendingServerNode };

/**
 * 连接舞台：44px 状态带 + 400 居中卡片 + 整宽主按钮。
 * 旧 Console 的结构（大计时器 + 右侧小按钮 + 底部节点面板）不再使用。
 */
export function ConnectionStage({
  config,
  connection,
  runtime,
  onStart,
  onStop,
  onReconnect,
  onSwitchNode,
  nodeProbes,
  failedAfterConnected,
  helperPreparing,
  onReportProblem,
  reportBusy = false,
  actionCards = [],
  onActionCardAction,
  onDiagnose,
  danglingNodeIds = new Set<string>(),
  trialSummary = null,
  trialExpiresAt = null,
  preselect = null,
  onPreselectApplied,
  onProbe,
  manualProbed = false,
  onProbeAvailabilityChange,
  routingMode = null,
  onSetConnectMode,
  onSetRoutingMode,
  onAskAi,
  onAskAiAboutNode,
  serverIdForNode,
  onRepairCredentials,
  onSyncCredentials,
  onReconnectAndTest,
  staleConfigNode = false,
  onStaleConfigRetry,
  onGoServers,
  onRepaired,
  pendingServerNodes = [],
}: Props) {
  const t = useT();
  const [now, setNow] = useState(() => Date.now());
  const [switchError, setSwitchError] = useState<string | null>(null);
  const [switching, setSwitching] = useState<string | null>(null);
  /** 确认弹窗打开时记下目标；确认后才真正调 Host。 */
  const [repairTarget, setRepairTarget] = useState<{
    nodeId: string;
    serverId: string;
    name: string;
    port: number;
  } | null>(null);
  /** 一次只修一台：其它行的动作在这段时间禁用。 */
  const [repairingNode, setRepairingNode] = useState<string | null>(null);
  const [repairedNode, setRepairedNode] = useState<string | null>(null);
  const [repairNotice, setRepairNotice] = useState<{
    nodeId: string;
    text: string;
    tone: "success" | "failure";
    showServers: boolean;
  } | null>(null);
  /** 关闭确认后把焦点还给点下它的那个按钮。 */
  const repairAnchorRef = useRef<HTMLButtonElement | null>(null);
  const repairedTimer = useRef(0);
  /** 修复后自动测速：等这台节点的新结果回来。 */
  const repairProbeRef = useRef<{
    nodeId: string;
    name: string;
    since: number;
  } | null>(null);

  /** 坏行先静默同步凭据：syncing → 端口变了就等配置重载后 checking → needs-repair。 */
  type SyncPhase =
    | "syncing"
    | "checking"
    | "restart-needed"
    | "restarting"
    | "needs-repair";
  /** 单次请求 10 秒 + 全局锁排队最长 10 秒 + 余量：超过按「未完成」处理。 */
  const SYNC_WAIT_LIMIT_MS = 22_000;
  /** 端口变了之后等连接页读回新配置的时长。 */
  const CONFIG_RELOAD_WAIT_MS = 1_500;
  const [syncPhase, setSyncPhase] = useState<Record<string, SyncPhase>>({});
  /** 端口变了：等配置里这一行的 port 更新后再测。 */
  const pendingSyncRef = useRef<{
    nodeId: string;
    name: string;
    port: number;
    /** 端口变了才需要等配置读回新值；没变直接按定时重测。 */
    awaitConfig: boolean;
  } | null>(null);
  const syncWaitTimer = useRef(0);
  const syncNoticeTimer = useRef(0);
  const syncDeadlineTimer = useRef(0);
  const syncProbeRef = useRef<{
    nodeId: string;
    since: number;
    changed: boolean;
  } | null>(null);
  /** 同步后恢复：行内只写「已恢复」3 秒，随后回到延迟。 */
  const [recoveredNode, setRecoveredNode] = useState<string | null>(null);
  const recoveredTimer = useRef(0);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const connected = runtime.state === "running" || runtime.state === "degraded";
  const degraded = runtime.state === "degraded";
  const failed = runtime.state === "failed";
  const noTraffic = dataPlaneDown(runtime, now);
  const starting =
    connection === "starting" ||
    runtime.state === "starting" ||
    runtime.state === "restarting";
  const stopping = connection === "stopping" || runtime.state === "stopping";

  const connectedAt = runtime.connected_since
    ? Date.parse(runtime.connected_since)
    : Number.NaN;
  const seconds = Number.isFinite(connectedAt)
    ? Math.max(0, Math.floor((now - connectedAt) / 1000))
    : null;
  const showTimer = connected && !noTraffic && seconds !== null;

  const nodes = config?.nodes ?? [];
  const displayNames = displayNodeNames(nodes);
  /** 本地预选：只在试用步骤流完成时写入一次，点「连接」时才真正切换。 */
  const [pickedId, setPickedId] = useState<string | null>(null);
  const [fastestMarkId, setFastestMarkId] = useState<string | null>(null);
  const appliedPreselect = useRef<number | null>(null);
  /** 自己发起的切换目标：用于区分 current_node_id 的外部变化。 */
  const ownTargetRef = useRef<string | null>(null);
  const lastCurrentRef = useRef<string | null>(config?.current_node_id ?? null);
  const latencyOf = (nodeId: string, nodeLatency: number | null): number | null => {
    const probe = nodeProbes.results[nodeId];
    if (probe) {
      // 只有 status=ok 且真有数字才算可用；untested / unreachable 都不回落到旧延迟。
      return probe.status === "ok" && probe.latency_ms !== null
        ? probe.latency_ms
        : null;
    }
    if (runtime.node_id === nodeId && nodeLatency !== null) return nodeLatency;
    return null;
  };
  const latencies = nodes.map((node) => latencyOf(node.node_id, runtime.node_latency_ms));
  // 收尾句只属于本次会话的试用步骤流；重启后没有这个状态就不显示。
  const summary =
    trialSummary && trialSummary.configId === config?.config_id
      ? trialSummary
      : null;

  // 一次性预选：只认试用步骤流传来的那一次，自动测速与其他测速都不重新推导。
  // 应用后通知 Host 消费掉，切 destination 往返/重新挂载不会二次应用。
  useEffect(() => {
    if (!preselect || preselect.nonce === appliedPreselect.current) return;
    if (preselect.configId !== config?.config_id) return;
    if (!nodes.some((node) => node.node_id === preselect.nodeId)) return;
    appliedPreselect.current = preselect.nonce;
    setPickedId(preselect.nodeId);
    if (preselect.markFastest === true) setFastestMarkId(preselect.nodeId);
    onPreselectApplied?.(preselect.nonce);
  }, [preselect, config?.config_id, nodes, onPreselectApplied]);

  // current_node_id 被外部（例如 AI 的 NodeSwitch）改动时，丢掉本地预选让界面跟随；
  // 自己点连接/切换引起的变化不算外部。
  useEffect(() => {
    const current = config?.current_node_id ?? null;
    const previous = lastCurrentRef.current;
    lastCurrentRef.current = current;
    if (current === previous) return;
    const own = ownTargetRef.current;
    ownTargetRef.current = null;
    if (current !== null && current === own) return;
    setPickedId(null);
  }, [config?.current_node_id]);

  const probeRunning = nodeProbes.run !== null || nodeProbes.starting;
  /** 这一批的终态；换配置或没有批次时为 null。 */
  const probeFinishedForConfig =
    nodeProbes.finished && nodeProbes.finished.configId === config?.config_id
      ? nodeProbes.finished
      : null;
  /**
   * 整批未测是独立终态（method = "none"）：只说「这次没测成」，
   * 不得写成「都连不通」，也不把按钮换成「再试一次」。
   */
  const probeAllUntested =
    !probeRunning &&
    probeFinishedForConfig !== null &&
    probeFinishedForConfig.method === "none" &&
    probeFinishedForConfig.total > 0 &&
    probeFinishedForConfig.ok === 0 &&
    !probeFinishedForConfig.cancelled;
  /**
   * 只有真的测过且全失败才说「都没测通」。派生自本配置的终态，
   * 切配置时不会把上一套的结论带过来。failed === total 已等价于
   * 「ok = 0 且 untested = 0」。
   */
  const probeAllFailed =
    !probeRunning &&
    probeFinishedForConfig !== null &&
    !probeFinishedForConfig.cancelled &&
    probeFinishedForConfig.total > 0 &&
    probeFinishedForConfig.method !== "none" &&
    probeFinishedForConfig.failed === probeFinishedForConfig.total;
  /** 混合批里没测成的条数；控制层已归一，这里不再补算。 */
  const probeUntestedCount = probeFinishedForConfig ? probeFinishedForConfig.untested : 0;
  /** 混合批或部分未测：单独列没测成的数量，不写「都连不通」。 */
  const probeMixedUntested =
    !probeRunning &&
    probeFinishedForConfig !== null &&
    !probeFinishedForConfig.cancelled &&
    probeFinishedForConfig.method !== "none" &&
    probeUntestedCount > 0 &&
    !probeAllFailed;
  const canProbe =
    Boolean(onProbe) &&
    nodes.length > 0 &&
    !probeRunning &&
    switching === null &&
    !starting &&
    !stopping &&
    !helperPreparing;
  useEffect(() => {
    onProbeAvailabilityChange?.(canProbe);
  }, [canProbe, onProbeAvailabilityChange]);

  const manualProbeRef = useRef(false);
  const prevRunIdRef = useRef<string | null>(null);
  const lastFinishRef = useRef<NodeProbesController["finished"]>(null);

  // 新一批开始：手动测速等结果再重算标记；后台/自动测速只清标记，不移动。
  useEffect(() => {
    const runId = nodeProbes.run?.runId ?? null;
    if (runId && !prevRunIdRef.current) {
      if (!manualProbeRef.current) setFastestMarkId(null);
    }
    prevRunIdRef.current = runId;
  }, [nodeProbes.run?.runId]);

  // 一批结束：手动测速把「最快」移到本次最低的那台；并列保留原来那台。
  useEffect(() => {
    if (probeRunning) return;
    const finished = nodeProbes.finished;
    if (!finished || finished === lastFinishRef.current) return;
    lastFinishRef.current = finished;
    if (finished.configId !== config?.config_id) return;
    if (!manualProbeRef.current) return;
    manualProbeRef.current = false;
    if (finished.cancelled || finished.ok === 0) {
      setFastestMarkId(null);
      return;
    }
    let best = Number.POSITIVE_INFINITY;
    let candidates: string[] = [];
    for (const node of nodes) {
      const result = nodeProbes.results[node.node_id];
      // 只有 status=ok 的节点参与「最快」；untested / unreachable 都不算。
      if (!result || result.status !== "ok" || result.latency_ms === null) continue;
      if (result.latency_ms < best) {
        best = result.latency_ms;
        candidates = [node.node_id];
      } else if (result.latency_ms === best) {
        candidates.push(node.node_id);
      }
    }
    setFastestMarkId((current) => {
      if (candidates.length === 0) return null;
      if (current && candidates.includes(current)) return current;
      return candidates[0];
    });
  }, [
    probeRunning,
    nodeProbes.finished,
    nodeProbes.results,
    config?.config_id,
    nodes,
  ]);

  const localPick =
    pickedId !== null && nodes.some((node) => node.node_id === pickedId)
      ? pickedId
      : null;  // 已连接一律以实际当前节点为准；未连接本地预选优先，否则跟随当前节点。
  const selectedId = connected
    ? (config?.current_node_id ?? null)
    : (localPick ?? config?.current_node_id ?? null);
  const connectTargetId =
    selectedId ?? config?.current_node_id ?? nodes[0]?.node_id ?? null;

  const switchTo = async (nodeId: string) => {
    if (switching) return;
    // 用户换节点：旧的「最快」标记不再成立。
    setFastestMarkId(null);
    if (!connected) {
      // 未连接：只做本地选择，等点「连接」再发命令。
      setSwitchError(null);
      setPickedId(nodeId);
      return;
    }
    if (nodeId === selectedId) return;
    setSwitchError(null);
    // 已连接时选中态只看 current_node_id；失败不留本地选择，保证还能再点重试。
    setPickedId(null);
    ownTargetRef.current = nodeId;
    setSwitching(nodeId);
    const result = await onSwitchNode(nodeId);
    setSwitching(null);
    if (!result.ok) {
      ownTargetRef.current = null;
      setSwitchError(result.message ?? t("console.switchFailed"));
    }
  };

  const probeTitle = probeRunning
    ? t("console.probing")
    : switching !== null || starting || stopping || helperPreparing
      ? t("console.probeLocked")
      : undefined;

  const cancelRepair = () => {
    setRepairTarget(null);
    repairAnchorRef.current?.focus();
  };

  /** 七类 reason 并成详情页已有的五组文案；两组附「去我的服务器」。 */
  const repairFailureCopy = (
    reason: ReturnType<typeof rotateFailureReason>,
  ): { key: MessageKey; showServers: boolean } => {
    switch (reason) {
      case "agent_token_unavailable":
        return { key: "detail.repair.tokenUnavailable", showServers: false };
      case "agent_tls_untrusted":
      case "agent_token_rejected":
        // 去向已经由「去我的服务器」承担，不再重复写「可以销毁重建」。
        return { key: "connection.repair.auth", showServers: true };
      case "agent_timeout":
      case "agent_unreachable":
        return { key: "detail.repair.unreachable", showServers: false };
      case "agent_tool_failed":
      case "agent_bad_response":
        return { key: "connection.repair.agentFailed", showServers: true };
      default:
        return { key: "detail.repair.failed", showServers: false };
    }
  };

  const runRepair = async () => {
    const target = repairTarget;
    if (!target || !onRepairCredentials || repairingNode !== null) return;
    setRepairTarget(null);
    setRepairingNode(target.nodeId);
    setRepairNotice(null);
    setRepairedNode(null);
    window.clearTimeout(repairedTimer.current);
    try {
      const result = await onRepairCredentials(target.serverId);
      setRepairingNode(null);
      setRepairedNode(target.nodeId);
      repairedTimer.current = window.setTimeout(
        () => setRepairedNode(null),
        3000,
      );
      setRepairNotice({
        nodeId: target.nodeId,
        text: t("connection.repair.probing", { port: result.port }),
        tone: "success",
        showServers: false,
      });
      setNodeSyncPhase(target.nodeId, null);
      const configId = config?.config_id;
      if (!configId) {
        setRepairNotice(null);
        return;
      }
      // 用现有测速通道只补这一台的延迟；结果回来前底部那行一直挂着。
      const since = Date.now();
      repairProbeRef.current = { nodeId: target.nodeId, name: target.name, since };
      const started = await nodeProbes.start(configId, [target.nodeId]);
      if (!started.ok) {
        repairProbeRef.current = null;
        setRepairNotice((current) =>
          current && current.nodeId === target.nodeId ? null : current,
        );
      }
    } catch (error) {
      setRepairingNode(null);
      const copy = repairFailureCopy(rotateFailureReason(error));
      setRepairNotice({
        nodeId: target.nodeId,
        text: `${target.name}：${t(copy.key)}`,
        tone: "failure",
        showServers: copy.showServers,
      });
    }
  };

  // 修复后的自动测速：拿到这台的新结果就收起底部那行；有数值时通知 App。
  useEffect(() => {
    const pending = repairProbeRef.current;
    if (!pending) return;
    const probe = nodeProbes.results[pending.nodeId];
    if (
      !probe ||
      probe.checked_at < pending.since ||
      nodeProbes.probing.has(pending.nodeId)
    ) {
      return;
    }
    repairProbeRef.current = null;
    // 测速结果回来：行内立刻回到延迟读数，成功后那 3 秒的「已修复」到此为止。
    setRepairedNode(null);
    window.clearTimeout(repairedTimer.current);
    setRepairNotice((current) =>
      current && current.nodeId === pending.nodeId && current.tone === "success"
        ? null
        : current,
    );
    if (probe.reachable === true && probe.latency_ms !== null) {
      onRepaired?.({
        nodeId: pending.nodeId,
        name: pending.name,
        latencyMs: probe.latency_ms,
      });
    }
  }, [nodeProbes.results, nodeProbes.probing, onRepaired]);

  useEffect(
    () => () => {
      window.clearTimeout(repairedTimer.current);
      window.clearTimeout(syncWaitTimer.current);
      window.clearTimeout(syncDeadlineTimer.current);
      window.clearTimeout(syncNoticeTimer.current);
      window.clearTimeout(recoveredTimer.current);
    },
    [],
  );

  const setNodeSyncPhase = (nodeId: string, phase: SyncPhase | null) => {
    setSyncPhase((current) => {
      if (phase === null) {
        if (!(nodeId in current)) return current;
        const next = { ...current };
        delete next[nodeId];
        return next;
      }
      if (current[nodeId] === phase) return current;
      return { ...current, [nodeId]: phase };
    });
  };

  const probeIsBad = (nodeId: string): boolean => {
    const probe = nodeProbes.results[nodeId];
    return (
      probe !== undefined &&
      (probe.reachable === false ||
        (probe.reachable === true && probe.latency_ms === null))
    );
  };

  /** 同步拿到值后重测一次；changed 只影响「配置已更新」那句话。 */
  const beginSyncProbe = async (nodeId: string, changed: boolean) => {
    window.clearTimeout(syncWaitTimer.current);
    pendingSyncRef.current = null;
    setNodeSyncPhase(nodeId, "checking");
    const since = Date.now();
    syncProbeRef.current = { nodeId, since, changed };
    const configId = config?.config_id;
    const started = configId
      ? await nodeProbes.start(configId, [nodeId])
      : { ok: false };
    if (!started.ok) {
      window.clearTimeout(syncDeadlineTimer.current);
      syncProbeRef.current = null;
      uiLog("warn", `sync probe_start_failed node=${nodeId}`, "node-sync");
      setNodeSyncPhase(nodeId, "needs-repair");
    }
  };

  /** 第 1 步：静默同步这一台的凭据；端口相同、失败或 12 秒无果都回「仍不通」。 */
  const runSilentSync = async (
    nodeId: string,
    serverId: string,
    name: string,
    localPort: number,
    options: { force?: boolean } = {},
  ) => {
    if (!onSyncCredentials) return;
    window.clearTimeout(recoveredTimer.current);
    setRecoveredNode(null);
    setNodeSyncPhase(nodeId, "syncing");
    window.clearTimeout(syncDeadlineTimer.current);
    // 逾期按「无变化」处理：不再等，直接让修复入口可见。
    syncDeadlineTimer.current = window.setTimeout(() => {
      pendingSyncRef.current = null;
      syncProbeRef.current = null;
      window.clearTimeout(syncWaitTimer.current);
      setNodeSyncPhase(nodeId, "needs-repair");
      uiLog("warn", `sync timeout node=${nodeId}`, "node-sync");
    }, SYNC_WAIT_LIMIT_MS);
    try {
      const port = await onSyncCredentials(serverId);
      if (port === null) {
        window.clearTimeout(syncDeadlineTimer.current);
        uiLog("warn", `sync failed node=${nodeId}`, "node-sync");
        setNodeSyncPhase(nodeId, "needs-repair");
        return;
      }
      // 取回成功就重测一次：端口没变也可能只是密码变了。
      const changed = port !== localPort;
      if (connected && (changed || options.force === true)) {
        if (options.force !== true) {
          // 自动流程：隧道在跑，内存里还是旧配置；等用户点「重新连接并测试」。
          window.clearTimeout(syncDeadlineTimer.current);
          pendingSyncRef.current = null;
          setNodeSyncPhase(nodeId, "restart-needed");
          return;
        }
        // 手动「先更新配置」：只要隧道在跑就必须先 stop → start，再测。
        window.clearTimeout(syncDeadlineTimer.current);
        pendingSyncRef.current = null;
        setNodeSyncPhase(nodeId, "restarting");
        const reconnected = onReconnectAndTest
          ? await onReconnectAndTest()
          : false;
        if (!reconnected) {
          setNodeSyncPhase(nodeId, "needs-repair");
          return;
        }
        await beginSyncProbe(nodeId, changed);
        return;
      }
      pendingSyncRef.current = { nodeId, name, port, awaitConfig: changed };
      window.clearTimeout(syncWaitTimer.current);
      syncWaitTimer.current = window.setTimeout(() => {
        void beginSyncProbe(nodeId, changed);
      }, changed ? CONFIG_RELOAD_WAIT_MS : 0);
    } catch {
      // 控制面不可达：不弹错误，直接回「仍不通」，但要留下能区分原因的日志。
      window.clearTimeout(syncDeadlineTimer.current);
      uiLog("warn", `sync failed node=${nodeId}`, "node-sync");
      setNodeSyncPhase(nodeId, "needs-repair");
    }
  };

  /** 「重新连接并测试」：先重连，再测；重连失败直接进修复态。 */
  const restartAndTest = async (nodeId: string) => {
    if (!onReconnectAndTest) return;
    setNodeSyncPhase(nodeId, "restarting");
    const ok = await onReconnectAndTest();
    if (!ok) {
      setNodeSyncPhase(nodeId, "needs-repair");
      return;
    }
    await beginSyncProbe(nodeId, true);
  };

  // 自有节点确实测不通：先静默同步这一台，再决定是恢复还是给修复入口。
  useEffect(() => {
    if (!onSyncCredentials) return;
    for (const node of nodes) {
      if (node.source !== "owned" || danglingNodeIds.has(node.node_id)) continue;
      if (!probeIsBad(node.node_id) || nodeProbes.probing.has(node.node_id)) continue;
      if (switching === node.node_id) continue;
      const serverId = serverIdForNode?.(node.node_id) ?? null;
      if (!serverId || syncPhase[node.node_id]) continue;
      const index = nodes.findIndex((item) => item.node_id === node.node_id);
      void runSilentSync(
        node.node_id,
        serverId,
        displayNames[index] ?? node.name,
        node.port,
      );
    }
  }, [nodes, nodeProbes.results, nodeProbes.probing, switching, syncPhase]);

  // 配置里这一行的端口已经换成新值：开始重测。
  useEffect(() => {
    const pending = pendingSyncRef.current;
    if (!pending || !pending.awaitConfig) return;
    const node = nodes.find((item) => item.node_id === pending.nodeId);
    if (!node || node.port !== pending.port) return;
    void beginSyncProbe(pending.nodeId, true);
  }, [nodes]);

  // 重测回来：通过就只留「配置已更新，连接已恢复」；仍失败则给修复入口。
  useEffect(() => {
    const pending = syncProbeRef.current;
    if (!pending) return;
    const probe = nodeProbes.results[pending.nodeId];
    if (
      !probe ||
      probe.checked_at < pending.since ||
      nodeProbes.probing.has(pending.nodeId)
    ) {
      return;
    }
    syncProbeRef.current = null;
    window.clearTimeout(syncDeadlineTimer.current);
    if (probe.reachable === true && probe.latency_ms !== null) {
      setNodeSyncPhase(pending.nodeId, null);
      // 只在行内写「已恢复」3 秒；端口确实变了才在卡片底部补一句配置已更新。
      setRecoveredNode(pending.nodeId);
      window.clearTimeout(recoveredTimer.current);
      recoveredTimer.current = window.setTimeout(
        () => setRecoveredNode(null),
        3000,
      );
      if (pending.changed) {
        setRepairNotice({
          nodeId: pending.nodeId,
          text: t("connection.repair.updated"),
          tone: "success",
          showServers: false,
        });
        window.clearTimeout(syncNoticeTimer.current);
        syncNoticeTimer.current = window.setTimeout(() => {
          setRepairNotice((current) =>
            current &&
            current.nodeId === pending.nodeId &&
            current.tone === "success"
              ? null
              : current,
          );
        }, 5000);
      }
    } else {
      uiLog(
        "debug",
        `sync no_change node=${pending.nodeId} port_changed=${pending.changed}`,
        "node-sync",
      );
      setNodeSyncPhase(pending.nodeId, "needs-repair");
    }
  }, [nodeProbes.results, nodeProbes.probing, t]);

  // 节点恢复（或行消失）后清掉同步阶段；失败态保留，避免反复自动同步。
  useEffect(() => {
    setSyncPhase((current) => {
      let changed = false;
      const next = { ...current };
      for (const nodeId of Object.keys(next)) {
        const probe = nodeProbes.results[nodeId];
        const good = probe?.reachable === true && probe.latency_ms !== null;
        const gone = !nodes.some((node) => node.node_id === nodeId);
        if (good || gone) {
          delete next[nodeId];
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [nodes, nodeProbes.results]);

  /** hero 的「重新连接」：先清提示，再 stop → start → 重测当前节点。 */
  const retryStaleConfig = async () => {
    onStaleConfigRetry?.();
    const nodeId = config?.current_node_id ?? runtime.node_id ?? null;
    const ok = onReconnectAndTest ? await onReconnectAndTest() : false;
    if (!ok || !nodeId) return;
    setNodeSyncPhase(nodeId, "checking");
    await beginSyncProbe(nodeId, false);
  };

  const onPrimary = async () => {
    if (primaryDisabled) return;
    if (staleConfigNode && connected) {
      void retryStaleConfig();
      return;
    }
    // 隧道还在跑：只要没有能连的节点，主按钮就是唯一的出口——先断开。
    if (connected && (!noTraffic || !connectTargetUsable)) {
      onStop();
      return;
    }
    if (failed && onDiagnose) {
      onDiagnose();
      return;
    }
    if (noTraffic) {
      onReconnect();
      return;
    }
    // 连接前先把界面选中的节点切过去；切换失败就停下，不假装在连接。
    if (connectTargetId && connectTargetId !== config?.current_node_id) {
      setSwitchError(null);
      ownTargetRef.current = connectTargetId;
      setSwitching(connectTargetId);
      const result = await onSwitchNode(connectTargetId);
      setSwitching(null);
      if (!result.ok) {
        ownTargetRef.current = null;
        setSwitchError(
          t("console.switchNodeFailed", {
            message: result.message ?? t("console.switchRetryShort"),
          }),
        );
        return;
      }
      setPickedId(connectTargetId);
    }
    onStart();
  };

  const stateText = noTraffic
    ? t("console.state.noTraffic")
    : failed
      ? t("console.state.failed")
      : stopping
        ? t("console.state.stopping")
        : starting
          ? t("console.state.starting")
          : t("console.state.idle");
  const stateTone = noTraffic || degraded
    ? "is-warn"
    : failed
      ? "is-bad"
      : starting || stopping
        ? "is-busy"
        : "is-ok";

  const nodeEntries = nodes.map((node, index) => ({ node, index }));
  const freeEntries = nodeEntries.filter(({ node }) => node.source === "seed");
  const ownedEntries = nodeEntries.filter(({ node }) => node.source !== "seed");
  /**
   * 待接入行：与配置里的节点按 id 去重——attach 完成后同一节点只留正常行，
   * 不能既在「你的服务器」里可点、又灰显一份。
   */
  const pendingEntries = useMemo(() => {
    const configured = new Set((config?.nodes ?? []).map((node) => node.node_id));
    const seen = new Set<string>();
    const result: PendingServerNode[] = [];
    for (const pending of pendingServerNodes) {
      if (configured.has(pending.nodeId) || seen.has(pending.nodeId)) continue;
      seen.add(pending.nodeId);
      result.push(pending);
    }
    return result;
  }, [config?.nodes, pendingServerNodes]);
  /** 两类同池才分组；只有一类时与单来源的卡片完全一致。 */
  const mixedSources =
    freeEntries.length > 0 &&
    (ownedEntries.length > 0 || pendingEntries.length > 0);
  const allSeed = nodes.length > 0 && freeEntries.length === nodes.length;

  const trialEnded = trialPhase(null, trialExpiresAt, now).kind === "ended";

  /** 免费组标题右侧：与「我的服务器」空态共用同一条取整规则；已过期与无时间分开说。 */
  const trialHint = trialGroupHint(null, trialExpiresAt, now);

  /** 试用到期但 Host 还没清池（最多约 5 分钟）：免费行就地拒绝，避免先连上再被断开。 */
  const isExpiredSeed = (node: { source: string }) =>
    trialEnded && node.source === "seed";

  const connectTarget =
    nodes.find((node) => node.node_id === connectTargetId) ?? null;
  /** 选中的正是停机删除留下的节点：机器已经没了，不能拿它去连。 */
  const connectTargetDangling =
    connectTarget !== null && danglingNodeIds.has(connectTarget.node_id);
  /**
   * 当前目标能不能拿去连：没有目标行、已到期、已停机删除都不算。
   * 隧道还在跑而这个为 false 时，主按钮必须留「断开」——否则用户手上只有
   * 一个连不上的「重新连接」，就再也关不掉正在运行的隧道。
   */
  const connectTargetUsable =
    connectTarget !== null &&
    !isExpiredSeed(connectTarget) &&
    !connectTargetDangling;
  /** 池里还有真正点得动的行才允许说「换一个节点」：过期的、停机删除的都不算。 */
  const hasUsableNode = nodes.some(
    (node) => !isExpiredSeed(node) && !danglingNodeIds.has(node.node_id),
  );
  /**
   * 选中的自建节点这次真的测不通：没测成（untested / reachable 为 null）、
   * 免费节点、停机删除的悬挂节点都不算——它们各有自己的说法。
   */
  const selectedNode = nodes.find((node) => node.node_id === selectedId) ?? null;
  const selfOwnedUnreachable =
    selectedNode !== null &&
    selectedNode.source !== "seed" &&
    !danglingNodeIds.has(selectedNode.node_id) &&
    nodeProbes.results[selectedNode.node_id]?.reachable === false;
  /**
   * 不通时的指路：跟着页面上真能做的事走。目标可用就按原文案重连；
   * 目标不可用但池里还有别的节点，断完能换一个；一个都没有就别提换节点。
   */
  const noTrafficAction = connectTargetUsable
    ? t("console.noTrafficAction")
    : hasUsableNode
      ? t("console.noTrafficOtherNode")
      : t("console.noTrafficNoNode");

  const primaryKind:
    | "connecting"
    | "disconnecting"
    | "disconnect"
    | "diagnose"
    | "reconnect"
    | "connect" = helperPreparing || starting
    ? "connecting"
    : stopping
      ? "disconnecting"
      : connected && (!noTraffic || !connectTargetUsable)
        ? "disconnect"
        : failed && onDiagnose
          ? "diagnose"
          : failed || noTraffic
            ? "reconnect"
            : "connect";
  const primaryLabel = t(
    primaryKind === "connecting"
      ? "console.primary.connecting"
      : primaryKind === "disconnecting"
        ? "console.primary.disconnecting"
        : primaryKind === "disconnect"
          ? "console.primary.disconnect"
          : primaryKind === "diagnose"
            ? "console.primary.diagnose"
            : primaryKind === "reconnect"
              ? "console.primary.reconnect"
              : "console.primary.connect",
  );
  const connectBlocked =
    (primaryKind === "connect" || primaryKind === "reconnect") &&
    connectTarget !== null &&
    (isExpiredSeed(connectTarget) || connectTargetDangling);
  const primaryDisabled =
    starting ||
    stopping ||
    helperPreparing ||
    switching !== null ||
    connectBlocked ||
    // 没有任何节点行可当目标：「连接 / 重新连接」只会空转，按规则禁用。
    ((primaryKind === "connect" || primaryKind === "reconnect") &&
      connectTarget === null);

  /** 周期同步发现当前连接节点的配置变了：hero 主按钮切成「重新连接」。 */
  const showStaleConfig = staleConfigNode === true && connected;
  const heroKind = showStaleConfig ? "reconnect" : primaryKind;
  const heroLabel = showStaleConfig
    ? t("console.primary.reconnect")
    : primaryLabel;

  const renderNode = ({ node, index }: (typeof nodeEntries)[number]) => {
    const latency = latencies[index];
    const active = node.node_id === selectedId;
    const expired = isExpiredSeed(node);
    const dangling = danglingNodeIds.has(node.node_id);
    const probe = nodeProbes.results[node.node_id];
    /** 契约上可达必有数值；真遇到「可达却没数值」按测不通处理，别冒称「未测」。
        untested（reachable === null）保持「未测」，不能掉进失败态。 */
    const probeBad =
      probe !== undefined &&
      (probe.reachable === false ||
        (probe.reachable === true && probe.latency_ms === null));
    // 没测成也可能带原因（例如临时运行时起不来）：有就放 title，没有不编。
    const probeUntested = probe?.status === "untested";
    const probeError =
      probeBad || probeUntested ? probe?.error?.message ?? null : null;
    /** 未知状态用字符串枚举而不是比文案：英文界面下比较中文会失效。 */
    const msState =
      switching === node.node_id
        ? "switching"
        : nodeProbes.probing.has(node.node_id)
          ? "probing"
          : latency !== null
            ? "latency"
            : probeBad
              ? "bad"
              : "untested";
    const msText =
      msState === "switching"
        ? t("console.node.switching")
        : msState === "probing"
          ? t("console.probing")
          : msState === "latency" && latency !== null
            ? formatLatency(latency)
            : msState === "bad"
              ? t("console.node.unreachable")
              : t("console.node.untested");
    // 「测不通 / 未测」是文字不是读数：小一档，但右端仍对齐。
    const msMuted = msState === "bad" || msState === "untested";
    const serverId = serverIdForNode?.(node.node_id) ?? null;
    const isRepairing = repairingNode === node.node_id;
    const isRepaired = repairedNode === node.node_id;
    const isRecovered = recoveredNode === node.node_id;
    const syncing =
      onSyncCredentials !== undefined &&
      (syncPhase[node.node_id] === "syncing" ||
        syncPhase[node.node_id] === "checking");
    /** 只有自有节点、真的测不通、又能映射到服务器时给两个动作。 */
    const canRepair =
      msState === "bad" &&
      !expired &&
      !dangling &&
      node.source === "owned" &&
      serverId !== null &&
      onRepairCredentials !== undefined &&
      // 先静默同步：只有确认「端口没变 / 重测仍失败」后才给两个动作。
      (!onSyncCredentials || syncPhase[node.node_id] === "needs-repair");
    const canAskInRow = canRepair && Boolean(onAskAi || onAskAiAboutNode);
    /** 行内要放真按钮，容器不能再用 <button>（不能嵌套）；修复中的行不可切换。 */
    const rowLocked =
      switching !== null || expired || dangling || isRepairing;
    return (
      <div
        key={node.node_id}
        role="option"
        aria-selected={active}
        aria-disabled={rowLocked || undefined}
        tabIndex={rowLocked ? -1 : 0}
        className={`stage-node ${active ? "is-selected" : ""} ${
          expired ? "is-expired" : ""
        } ${dangling ? "is-dangling" : ""}`}
        onClick={() => {
          if (!rowLocked) void switchTo(node.node_id);
        }}
        onKeyDown={(event) => {
          // 内部真按钮自己处理 Enter/Space，别让它顺带选中这一行。
          if (event.target !== event.currentTarget) return;
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          if (!rowLocked) void switchTo(node.node_id);
        }}
      >
        <span
          className={`stage-node__name${expired || dangling ? " has-sub" : ""}`}
          title={node.name}
        >
          <span className="stage-node__name-text">
            {displayNames[index] ?? node.name}
          </span>
          {fastestMarkId === node.node_id ? (
            <span className="stage-node__fastest">{t("console.node.fastest")}</span>
          ) : null}
          {expired ? (
            <span className="stage-node__sub">{t("console.node.expired")}</span>
          ) : null}
          {dangling ? (
            <span className="stage-node__sub">{nodeTombstoneWord()}</span>
          ) : null}
        </span>
        {isRepaired ? (
          <span className="stage-node__actions">
            <span className="stage-node__ms is-done">
              {t("connection.repair.done")}
            </span>
          </span>
        ) : isRecovered ? (
          <span className="stage-node__actions">
            <span className="stage-node__ms is-done">
              {t("connection.repair.recovered")}
            </span>
          </span>
        ) : canRepair ? (
          <span className="stage-node__actions">
            <span
              className="stage-node__ms is-muted"
              aria-label={probeBad ? t("console.node.probeFailedAria") : undefined}
              title={probeError || undefined}
            >
              {t("console.node.unreachable")}
            </span>
            {isRepairing ? (
              <span className="stage-node__ms is-muted" role="status">
                {t("detail.repair.working")}
              </span>
            ) : (
              <>
                <button
                  ref={(element) => {
                    repairAnchorRef.current = element;
                  }}
                  type="button"
                  className="stage-node__repair"
                  aria-disabled={repairingNode !== null || undefined}
                  aria-label={t("connection.repair.ariaRepair", {
                    name: displayNames[index] ?? node.name,
                  })}
                  onClick={(event) => {
                    event.stopPropagation();
                    if (repairingNode !== null || !serverId) return;
                    setRepairTarget({
                      nodeId: node.node_id,
                      serverId,
                      name: displayNames[index] ?? node.name,
                      port: node.port,
                    });
                  }}
                >
                  {t("detail.repair")}
                </button>
                {canAskInRow ? (
                  <>
                    <span className="stage-node__sep" aria-hidden="true">
                      ·
                    </span>
                    <button
                      type="button"
                      className="stage-node__ask"
                      aria-disabled={repairingNode !== null || undefined}
                      aria-label={t("connection.repair.ariaAsk", {
                        name: displayNames[index] ?? node.name,
                      })}
                      onClick={(event) => {
                        event.stopPropagation();
                        if (repairingNode !== null) return;
                        const prompt = nodeUnreachableAsk(
                          displayNames[index] ?? node.name,
                        );
                        if (onAskAiAboutNode) {
                          onAskAiAboutNode(node.node_id, prompt);
                        } else {
                          onAskAi?.(prompt);
                        }
                      }}
                    >
                      {t("console.node.askAi")}
                    </button>
                  </>
                ) : null}
              </>
            )}
          </span>
        ) : syncPhase[node.node_id] === "restart-needed" ? (
          <span className="stage-node__actions">
            <span className="stage-node__ms is-muted">
              {t("console.node.unreachable")}
            </span>
            <span className="stage-node__ms is-muted">
              {t("connection.repair.changed")}
            </span>
            {onReconnectAndTest ? (
              <button
                type="button"
                className="stage-node__repair"
                onClick={(event) => {
                  event.stopPropagation();
                  void restartAndTest(node.node_id);
                }}
              >
                {t("connection.repair.restart")}
              </button>
            ) : null}
          </span>
        ) : syncPhase[node.node_id] === "restarting" ? (
          <span className="stage-node__actions">
            <span className="stage-node__ms is-muted">
              {t("console.node.unreachable")}
            </span>
            <span className="stage-node__ms is-muted" role="status">
              {t("connection.repair.restarting")}
            </span>
          </span>
        ) : syncing ? (
          <span className="stage-node__actions">
            <span className="stage-node__ms is-muted">
              {t("console.node.unreachable")}
            </span>
            <span className="stage-node__ms is-muted" role="status">
              {t("connection.repair.syncing")}
            </span>
          </span>
        ) : dangling ? null : (
          <span
            className={`stage-node__ms${msMuted ? " is-muted" : ""}`}
            aria-label={probeBad ? t("console.node.probeFailedAria") : undefined}
            title={probeError || undefined}
          >
            {msText}
          </span>
        )}
      </div>
    );
  };

  /** 待接入行：不是按钮，选不中；右侧的时延位置写清楚什么时候能用。 */
  const renderPendingNode = (pending: PendingServerNode) => (
    <div
      key={pending.nodeId}
      role="option"
      aria-selected={false}
      aria-disabled="true"
      className="stage-node is-pending"
      title={pending.name}
    >
      <span className="stage-node__name">
        <span className="stage-node__name-text">{pending.name}</span>
      </span>
      <span className="stage-node__note">{t("console.node.pendingNote")}</span>
    </div>
  );

  return (
    <main className="connection-stage" aria-label={t("console.aria.main")}>
      <div className="connection-stage__col">
        <section className="stage-band" aria-live="polite">
          <p className="sr-only" role="status">
            {connected
              ? noTraffic
                ? t("console.srNoTraffic", { action: noTrafficAction })
                : degraded
                  ? t("console.state.degraded")
                  : t("console.state.connected")
              : stateText}
          </p>
          {connected && !noTraffic ? (
            <span className="state-line">
              <span className={`state-line__label ${degraded ? "is-warn" : ""}`}>
                <span className={`led ${degraded ? "is-warn" : "is-ok"}`} aria-hidden />
                {degraded ? t("console.state.degraded") : t("console.state.connected")}
              </span>
              {showTimer ? (
                <span className="timecode num">{formatClock(seconds)}</span>
              ) : null}
            </span>
          ) : (
            <h1 className="state-word">
              <span className={`led ${stateTone}`} aria-hidden />
              {stateText}
            </h1>
          )}
        </section>

        {actionCards.map((card) => (
          <section className="action-card" key={card.id} aria-label={card.title}>
            <h3 className="action-card__title">{card.title}</h3>
            {card.detail ? <p className="action-card__detail">{card.detail}</p> : null}
            <div className="action-card__actions">
              {card.actions.map((action) => (
                <button
                  key={action.id}
                  type="button"
                  className={
                    action.kind === "primary"
                      ? "btn btn--primary action-card__btn"
                      : "btn btn--ghost action-card__btn"
                  }
                  onClick={() => onActionCardAction?.(action)}
                >
                  {action.label}
                </button>
              ))}
            </div>
          </section>
        ))}

        <section className="stage-card" aria-label={t("console.aria.nodes")}>
          <header className="stage-card__head">
            <h2 className="stage-card__title">{t("console.title.nodes")}</h2>
            <div className="stage-card__subrow">
              <p className="stage-card__sub">
                {allSeed
                  ? t("console.nodes.countTrial", { count: nodes.length })
                  : t("console.nodes.count", { count: nodes.length })}
              </p>
              {onProbe && nodes.length > 0 ? (
                <button
                  type="button"
                  className="stage-probe"
                  disabled={!canProbe}
                  title={probeTitle}
                  onClick={() => {
                    if (!canProbe) return;
                    manualProbeRef.current = true;
                    onProbe();
                  }}
                >
                  {probeRunning ? (
                    <>
                      <span className="stage-step__dots" aria-hidden="true">
                        <span />
                        <span />
                        <span />
                      </span>
                      {t("console.probing")}
                    </>
                  ) : probeAllFailed ? (
                    t("console.probe.again")
                  ) : (
                    t("console.probe.action")
                  )}
                </button>
              ) : null}
            </div>
            {probeAllFailed ? (
              <p className="stage-card__probe-note">{t("console.probe.allFailed")}</p>
            ) : probeAllUntested ? (
              <p className="stage-card__probe-note">{t("console.probe.allUntested")}</p>
            ) : probeMixedUntested ? (
              <p className="stage-card__probe-note">
                {t("console.probe.mixed", { count: probeUntestedCount })}
              </p>
            ) : null}
            {selfOwnedUnreachable ? (
              <p className="stage-card__probe-note">
                {t("console.selfOwnedUnreachable")}
              </p>
            ) : null}
          </header>
          <div className="stage-card__nodes" role="listbox" aria-label={t("console.aria.nodes")}>
            {mixedSources ? (
              <>
                <div
                  className="stage-node-group"
                  role="group"
                  aria-label={t("console.group.owned")}
                >
                  <div className="stage-node-group__head">
                    <span>{t("console.group.owned")}</span>
                  </div>
                  {ownedEntries.map(renderNode)}
                  {pendingEntries.map(renderPendingNode)}
                </div>
                <div
                  className="stage-node-group"
                  role="group"
                  aria-label={t("console.group.free")}
                >
                  <div className="stage-node-group__head">
                    <span>{t("console.group.free")}</span>
                    <span className="stage-node-group__hint">{trialHint}</span>
                  </div>
                  {freeEntries.map(renderNode)}
                </div>
              </>
            ) : ownedEntries.length === 0 && pendingEntries.length > 0 ? (
              <div
                className="stage-node-group"
                role="group"
                aria-label={t("console.group.owned")}
              >
                <div className="stage-node-group__head">
                  <span>{t("console.group.owned")}</span>
                </div>
                {pendingEntries.map(renderPendingNode)}
              </div>
            ) : (
              <>
                {nodeEntries.map(renderNode)}
                {pendingEntries.map(renderPendingNode)}
              </>
            )}
          </div>
          {repairNotice ? (
            <p
              className="stage-card__probe-note"
              role={repairNotice.tone === "success" ? "status" : undefined}
            >
              {repairNotice.text}
              {repairNotice.showServers && onGoServers ? (
                <>
                  {" "}
                  <button
                    type="button"
                    className="stage-card__repair-link"
                    onClick={onGoServers}
                  >
                    {t("connection.repair.goServers")}
                  </button>
                </>
              ) : null}
            </p>
          ) : null}
        </section>

        {config !== null && nodes.length === 0 && pendingEntries.length === 0 ? (
          <p className="stage-note">{t("console.empty")}</p>
        ) : null}

        {showStaleConfig ? (
          <p className="stage-note">{t("console.staleConfig")}</p>
        ) : null}

        <button
          type="button"
          className="stage-primary"
          onClick={onPrimary}
          disabled={primaryDisabled}
          aria-label={
            heroKind === "disconnect"
              ? t("console.primary.disconnectAria")
              : heroKind === "connect"
                ? t("console.primary.connectAria")
                : heroLabel
          }
        >
          {heroLabel}
        </button>

        {connectBlocked ? (
          <p className="stage-note">
            {connectTargetDangling
              ? hasUsableNode
                ? t("console.blocked.danglingHasOther")
                : t("console.blocked.danglingNoOther")
              : hasUsableNode
                ? t("console.blocked.expiredHasOther")
                : t("console.blocked.expiredNoOther")}
          </p>
        ) : null}

        {failed ? (
          <button
            type="button"
            className="stage-secondary"
            onClick={onStart}
            disabled={!connectTargetUsable}
          >
            {t("console.reconnect")}
          </button>
        ) : null}

        {/* 失败/无流量时下方已经有一个「报告问题」，这里不再重复。 */}
        {config && nodes.length > 0 && onSetConnectMode && onSetRoutingMode ? (
          <StageQuickToggles
            connectMode={config.connect_mode}
            routingMode={routingMode}
            connected={connected}
            modeLocked={starting || stopping}
            helperPreparing={helperPreparing}
            onSetConnectMode={onSetConnectMode}
            onSetRoutingMode={onSetRoutingMode}
            onReportProblem={failed || noTraffic ? undefined : onReportProblem}
            reportBusy={reportBusy}
            onAskAi={onAskAi}
          />
        ) : null}

        {failed ? (
          <p className="stage-note stage-note--error">
            {failureHeadline(failedAfterConnected)}
            {runtime.last_error ? ` ${runtime.last_error.message}` : ""}
            {onReportProblem ? (
              <button
                type="button"
                className="stage-note__link"
                onClick={onReportProblem}
                disabled={reportBusy}
              >
                {t("stage.reportProblem")}
              </button>
            ) : null}
          </p>
        ) : noTraffic ? (
          <p className="stage-note">
            {noTrafficAction}
            {onReportProblem ? (
              <button
                type="button"
                className="stage-note__link"
                onClick={onReportProblem}
                disabled={reportBusy}
              >
                {t("stage.reportProblem")}
              </button>
            ) : null}
          </p>
        ) : switchError || summary ? (
          <p
            className={`stage-note${switchError ? " stage-note--error" : ""}${
              !switchError && summary ? " stage-note--summary" : ""
            }`}
            role={switchError ? "alert" : undefined}
          >
            {switchError ??
              (summary
                ? manualProbed || summary.fastestMs === null
                  ? t("console.summary.joined", { count: summary.count })
                  : t("console.summary.fastest", {
                      base: t("console.summary.joined", { count: summary.count }),
                      ms: Math.round(summary.fastestMs),
                    })
                : null)}
          </p>
        ) : null}
      </div>
      {repairTarget ? (
        <NodeRepairDialog
          nodeName={repairTarget.name}
          onCancel={cancelRepair}
          onConfirm={() => void runRepair()}
          onSync={
            onSyncCredentials
              ? () => {
                  const target = repairTarget;
                  if (!target) return;
                  setRepairTarget(null);
                  setNodeSyncPhase(target.nodeId, null);
                  void runSilentSync(
                    target.nodeId,
                    target.serverId,
                    target.name,
                    target.port,
                    { force: true },
                  );
                }
              : undefined
          }
        />
      ) : null}
    </main>
  );
}
