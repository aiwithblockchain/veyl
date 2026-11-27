import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import type {
  ConfigConnectMode,
  ConfigDetail,
  ConfigRouteMode,
  NodeSummary,
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
import type { ActionCard } from "../ui/actionCard";
import { useT } from "../i18n";
import { errorText } from "../i18n/errorText";
import { StageQuickToggles, type ModeSwitchResult } from "./StageQuickToggles";

interface Props {
  config: ConfigDetail | null;
  connection: VpnConnectionState;
  runtime: RuntimeView;
  onStart: () => void;
  onStop: () => void;
  onReconnect: () => void;
  onSwitchNode: (nodeId: string) => Promise<{ ok: boolean; message?: string }>;
  /** 移除自定义节点（url / manual）；结果由行内确认区展示。 */
  onRemoveNode?: (nodeId: string) => Promise<{
    ok: boolean;
    message?: string;
    wasCurrent?: boolean;
  }>;
  /** 编辑自定义节点：打开编辑弹层（订阅只改名，手动可改连接参数）。 */
  onEditNode?: (node: NodeSummary) => void;
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
  /** 自有节点测不通：打开节点诊断面板（App 统一构造依赖）。 */
  onAnalyzeNode?: (target: { serverId: string; nodeName: string }) => void;
  /** 服务器已停机删除、只剩本地节点行：灰显、不可点，等用户去「我的服务器」删。 */
  danglingNodeIds?: ReadonlySet<string>;
  /** 免费节点步骤流完成后的收敛句：已加入 N 个免费节点，最快 Xms。 */
  trialSummary?: { configId: string; count: number; fastestMs: number | null } | null;
  /** 试用截止时间（ISO）：免费组标题右侧按剩余天数写到期文案。 */
  trialExpiresAt?: string | null;
  /** 试用状态：expired 立即可判到期，不必等时间字段。 */
  trialState?: "available" | "active" | "expired" | null;
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
  /** 测速当前分组里的这些节点（只读，不改选中）。 */
  onProbe?: (nodeIds: string[]) => void;
  /** 批次在跑时把入口换成「停止测速」：点了就取消这一批。 */
  onProbeCancel?: () => void;
  /** 节点卡「添加节点」：打开导入 / 手动填写弹层。 */
  onAddNode?: () => void;
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
  /** 节点 id → 服务器 id（自有节点才查得到）；查不到不给诊断入口。 */
  serverIdForNode?: (nodeId: string) => string | null;
  /** 周期同步发现当前连接节点的配置变了：hero 点重连时 stop → start 后重测。 */
  onReconnectAndTest?: () => Promise<boolean>;
  /** 周期同步发现当前连接节点的配置变了：hero 区提示重新连接。 */
  staleConfigNode?: boolean;
  /** 用户点了 hero 的「重新连接」：调用方清掉提示。 */
  onStaleConfigRetry?: () => void;
  /** 服务器已就绪、节点还在等断开后 attach：灰显列出，告诉用户重新连接后可用。 */
  pendingServerNodes?: PendingServerNode[];
}

/** 待接入节点类型对外导出：调用方与测试都从这里取。 */
export type { PendingServerNode };

/** 节点来源三分：我的服务器 / 自定义节点 / 免费节点。 */
type NodeSourceGroup = "owned" | "custom" | "free";
/** 标签只覆盖前两类；免费试用是独立卡片，不参与切换。 */
type TabSource = "owned" | "custom";

/** 到期提醒点过「知道了」就记住，避免每次启动都再弹一次。 */
const TRIAL_EXPIRED_DISMISSED_KEY = "veyl.ui.trialExpiredDismissed.v1";

/** 测速入口的转速表图标：指针用聚焦紫红，表盘跟当前文字色（深灰）。 */
function SpeedIcon() {
  return (
    <svg
      className="stage-probe__icon"
      viewBox="-86 89 769 480"
      width="20"
      height="13"
      aria-hidden="true"
      focusable="false"
    >
      <g fill="currentColor">
        <path d="M-59.7,529.3c-14.6,0-27.3-12.7-27.3-27.3s12.7-27.3,27.3-27.3H-5.1c14.6,0,27.3,12.7,27.3,27.3s-12.7,27.3-27.3,27.3h-54.6ZM599.3,529.3c-14.6,0-27.3-12.7-27.3-27.3s12.7-27.3,27.3-27.3h54.6c14.6,0,27.3,12.7,27.3,27.3s-12.7,27.3-27.3,27.3h-54.6ZM31.3,247.1c-10.9-10.9-10.9-27.3,0-38.2,10.9-10.9,27.3-10.9,38.2,0l27.3,27.3c10.9,10.9,10.9,27.3,0,38.2-10.9,10.9-27.3,10.9-38.2,0l-27.3-27.3ZM524.7,208.9c10.9-10.9,27.3-10.9,38.2,0,10.9,10.9,10.9,27.3,0,38.2l-27.3,27.3c-10.9,10.9-27.3,10.9-38.2,0-10.9-10.9-10.9-27.3,0-38.2l27.3-27.3ZM269.8,147c0-14.6,12.7-27.3,27.3-27.3s27.3,12.7,27.3,27.3v54.6c0,14.6-12.7,27.3-27.3,27.3s-27.3-12.7-27.3-27.3v-54.6Z" />
        <path d="M-28.9,505.5c-1.1-10.8-1.6-21.7-1.6-32.6,0-182,145.6-329.5,327.7-329.5s329.5,147.5,329.5,329.5-.5,21.8-1.6,32.6h54.7c1-11.4,1.5-22.9,1.5-34.5-1.8-211.2-172.9-380.5-384.1-380.5S2.2,181.5-56.1,325.4c-24.4,58.4-33.5,120.1-28.4,180.1H-28.9Z" />
      </g>
      <path
        className="stage-probe__needle"
        d="M318.1,427l-187.7-52.7c-10.1-2.8-20.9,1.4-26.3,10.3h0c-5.5,8.9-4.4,20.4,2.7,28.2l131.9,143.6c35.5,38.6,98,32.6,125.5-12.1h0c27.4-44.7,4.5-103.2-46-117.4Z"
      />
    </svg>
  );
}

/**
 * 连接舞台：48px 状态带 + 400 居中卡片 + 整宽主按钮。
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
  onRemoveNode,
  onEditNode,
  nodeProbes,
  failedAfterConnected,
  helperPreparing,
  onReportProblem,
  reportBusy = false,
  actionCards = [],
  onActionCardAction,
  onDiagnose,
  onAnalyzeNode,
  danglingNodeIds = new Set<string>(),
  trialSummary = null,
  trialExpiresAt = null,
  trialState = null,
  preselect = null,
  onPreselectApplied,
  onProbe,
  onProbeCancel,
  onAddNode,
  manualProbed = false,
  onProbeAvailabilityChange,
  routingMode = null,
  onSetConnectMode,
  onSetRoutingMode,
  onAskAi,
  onAskAiAboutNode,
  serverIdForNode,
  onReconnectAndTest,
  staleConfigNode = false,
  onStaleConfigRetry,
  pendingServerNodes = [],
}: Props) {
  const t = useT();
  const [now, setNow] = useState(() => Date.now());
  const [switchError, setSwitchError] = useState<string | null>(null);
  const [switching, setSwitching] = useState<string | null>(null);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  /** 菜单放不下时向上展开：卡片 overflow:hidden，向下会被底边裁掉。 */
  const [menuUp, setMenuUp] = useState(false);
  const [confirmFor, setConfirmFor] = useState<{ id: string; name: string } | null>(
    null,
  );
  const [removeBusy, setRemoveBusy] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const [removedNotice, setRemovedNotice] = useState<string | null>(null);
  /** 用户手动选的来源标签；null 跟随当前节点所在的组。 */
  const [pickedSource, setPickedSource] = useState<TabSource | null>(null);
  const [nodeQuery, setNodeQuery] = useState("");
  /** 最近一次手动测速来自哪个栏目：反馈只落在发起的那一栏。 */
  const [probeScope, setProbeScope] = useState<TabSource | "free" | null>(null);
  const [trialExpiredDismissed, setTrialExpiredDismissed] = useState(() => {
    try {
      return localStorage.getItem(TRIAL_EXPIRED_DISMISSED_KEY) === "1";
    } catch {
      return false;
    }
  });
  const nodeListRef = useRef<HTMLDivElement | null>(null);
  const freeListRef = useRef<HTMLDivElement | null>(null);
  const menuWrapRef = useRef<HTMLSpanElement | null>(null);
  const moreButtonRef = useRef<HTMLButtonElement | null>(null);
  const removedTimerRef = useRef<number | null>(null);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  // 换配置等于换一批节点：来源标签与搜索都回到「跟随当前节点」。
  useEffect(() => {
    setPickedSource(null);
    setProbeScope(null);
    setNodeQuery("");
  }, [config?.config_id]);

  useEffect(() => {
    if (menuFor === null) return;
    const onDown = (event: MouseEvent) => {
      if (menuWrapRef.current?.contains(event.target as Node)) return;
      setMenuFor(null);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [menuFor]);

  useEffect(
    () => () => {
      if (removedTimerRef.current !== null) {
        window.clearTimeout(removedTimerRef.current);
      }
    },
    [],
  );

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
  /** 一批测速的收尾结论：落在发起测速的那张卡上，另一张卡不重复。 */
  const probeBatchNote = probeAllFailed ? (
    <p className="stage-card__probe-note stage-card__probe-note--error">
      {t("console.probe.allFailed")}
    </p>
  ) : probeAllUntested ? (
    <p className="stage-card__probe-note stage-card__probe-note--error">
      {t("console.probe.allUntested")}
    </p>
  ) : probeMixedUntested ? (
    <p className="stage-card__probe-note stage-card__probe-note--error">
      {t("console.probe.mixed", { count: probeUntestedCount })}
    </p>
  ) : null;
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
  /** 只有托管节点能诊断：其它来源的凭据不在我们手里，诊断给不出可执行的结论。 */
  const failedNode =
    nodes.find((node) => node.node_id === connectTargetId) ?? null;
  const canDiagnose =
    failed && onDiagnose !== undefined && failedNode?.source === "owned";

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

  const openRemoveConfirm = (node: NodeSummary, name: string) => {
    setMenuFor(null);
    setRemoveError(null);
    setConfirmFor({ id: node.node_id, name });
  };

  const closeRemoveConfirm = () => {
    setConfirmFor(null);
    setRemoveError(null);
    moreButtonRef.current?.focus();
  };

  const confirmRemove = async () => {
    if (!confirmFor || !onRemoveNode || removeBusy) return;
    const target = confirmFor;
    setRemoveBusy(true);
    setRemoveError(null);
    const result = await onRemoveNode(target.id);
    setRemoveBusy(false);
    if (!result.ok) {
      setRemoveError(result.message ?? t("console.node.removeFailed"));
      return;
    }
    setConfirmFor(null);
    if (removedTimerRef.current !== null) {
      window.clearTimeout(removedTimerRef.current);
    }
    setRemovedNotice(t("console.node.removed", { name: target.name }));
    removedTimerRef.current = window.setTimeout(
      () => setRemovedNotice(null),
      4000,
    );
  };

  /** 自定义节点的「⋯ → 编辑 / 移除」。托管 / 免费节点不给入口。 */
  const renderMore = (node: NodeSummary, name: string) => {
    if (onEditNode === undefined && onRemoveNode === undefined) return null;
    if (node.source !== "url" && node.source !== "manual") return null;
    const open = menuFor === node.node_id;
    return (
      <span
        className="stage-node__more-wrap"
        ref={open ? menuWrapRef : undefined}
      >
        <button
          type="button"
          className="stage-node__more"
          aria-label={t("console.node.more", { name })}
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={(event) => {
            event.stopPropagation();
            moreButtonRef.current = event.currentTarget;
            setConfirmFor(null);
            setRemoveError(null);
            if (open) {
              setMenuFor(null);
              return;
            }
            // 估计菜单高度（两项 + 分隔线 + 内边距）；放不下就向上开。
            const rect = event.currentTarget.getBoundingClientRect();
            const card = event.currentTarget
              .closest(".stage-card")
              ?.getBoundingClientRect();
            setMenuUp(card ? rect.bottom + 96 > card.bottom : false);
            setMenuFor(node.node_id);
          }}
          onKeyDown={(event) => {
            if (event.key !== "Escape") return;
            event.stopPropagation();
            setMenuFor(null);
          }}
        >
          ⋯
        </button>
        {open ? (
          <span
            className={`stage-node__menu${menuUp ? " stage-node__menu--up" : ""}`}
            role="menu"
            onMouseDown={(event) => event.stopPropagation()}
            onKeyDown={(event) => {
              if (event.key !== "Escape") return;
              event.stopPropagation();
              setMenuFor(null);
              moreButtonRef.current?.focus();
            }}
          >
            {onEditNode ? (
              <button
                type="button"
                role="menuitem"
                className="stage-node__menu-item"
                autoFocus
                onClick={(event) => {
                  event.stopPropagation();
                  setMenuFor(null);
                  onEditNode(node);
                }}
              >
                {t("console.node.edit")}
              </button>
            ) : null}
            {onEditNode && onRemoveNode ? (
              <span className="stage-node__menu-sep" role="separator" />
            ) : null}
            {onRemoveNode ? (
              <button
                type="button"
                role="menuitem"
                className="stage-node__menu-item"
                autoFocus={onEditNode === undefined}
                onClick={(event) => {
                  event.stopPropagation();
                  openRemoveConfirm(node, name);
                }}
              >
                {t("console.node.remove")}
              </button>
            ) : null}
          </span>
        ) : null}
      </span>
    );
  };

  const probeTitle = probeRunning
    ? t("console.probing")
    : switching !== null || starting || stopping || helperPreparing
      ? t("console.probeLocked")
      : undefined;

  /**
   * 测速入口的三种形态：空闲是「测速」；命令刚发出是禁用的「测速中」；
   * 批次在跑时换成「停止测速」——否则一批几十秒时用户只能干等。
   */
  const renderProbeControl = (nodeIds: string[], scope: "free" | TabSource) => {
    if (!onProbe || nodeIds.length === 0) return null;
    if (probeRunning) {
      if (nodeProbes.run !== null && onProbeCancel !== undefined) {
        return (
          <button
            type="button"
            className="stage-probe"
            onClick={() => {
              manualProbeRef.current = true;
              onProbeCancel();
            }}
          >
            {t("console.probe.stop")}
          </button>
        );
      }
      return (
        <button
          type="button"
          className="stage-probe"
          disabled
          title={probeTitle}
        >
          <span className="stage-step__dots" aria-hidden="true">
            <span />
            <span />
            <span />
          </span>
          {t("console.probing")}
        </button>
      );
    }
    return (
      <button
        type="button"
        className="stage-probe"
        disabled={!canProbe}
        title={probeTitle}
        onClick={() => {
          if (!canProbe) return;
          manualProbeRef.current = true;
          setProbeScope(scope);
          onProbe(nodeIds);
        }}
      >
        {noteHome === scope && probeAllFailed ? (
          t("console.probe.again")
        ) : (
          <>
            <SpeedIcon />
            <span className="sr-only">{t("console.probe.action")}</span>
          </>
        )}
      </button>
    );
  };

  /** hero 的「重新连接」：先清提示，再 stop → start，最后重测当前节点。 */
  const retryStaleConfig = async () => {
    onStaleConfigRetry?.();
    const nodeId = config?.current_node_id ?? runtime.node_id ?? null;
    const ok = onReconnectAndTest ? await onReconnectAndTest() : false;
    if (!ok || !nodeId) return;
    const configId = config?.config_id;
    if (configId) void nodeProbes.start(configId, [nodeId]);
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
    if (canDiagnose) {
      onDiagnose?.();
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
  const customEntries = nodeEntries.filter(
    ({ node }) => node.source === "url" || node.source === "manual",
  );
  const ownedEntries = nodeEntries.filter(({ node }) => node.source === "owned");
  /**
   * 待接入行：与配置里的节点按 id 去重——attach 完成后同一节点只留正常行，
   * 不能既在「我的服务器」里可点、又灰显一份。
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
  const trialEnded = trialPhase(trialState, trialExpiresAt, now).kind === "ended";

  /** 免费组标题右侧：与「我的服务器」空态共用同一条取整规则；已过期与无时间分开说。 */
  const trialHint = trialGroupHint(trialState, trialExpiresAt, now);

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

  const groupLabel = (key: NodeSourceGroup): string =>
    key === "owned"
      ? t("console.group.owned")
      : key === "custom"
        ? t("console.group.custom")
        : t("console.group.free");
  const sourceOfNode = (node: { source: string }): NodeSourceGroup =>
    node.source === "owned"
      ? "owned"
      : node.source === "seed"
        ? "free"
        : "custom";

  /** 节点卡只装「我的服务器 / 自定义节点」；免费试用是下面一张独立卡片。 */
  const sourceGroups = [
    {
      key: "owned" as const,
      label: groupLabel("owned"),
      nodes: ownedEntries,
      pending: pendingEntries,
    },
    {
      key: "custom" as const,
      label: groupLabel("custom"),
      nodes: customEntries,
      pending: [] as PendingServerNode[],
    },
  ];

  const selectedSource = selectedNode ? sourceOfNode(selectedNode) : null;
  /** 当前节点在免费试用卡里时，标签仍停在上一张卡（不跟着跳）。 */
  const selectedTabSource: TabSource | null =
    selectedSource === "owned" || selectedSource === "custom"
      ? selectedSource
      : null;
  const firstNonEmpty =
    sourceGroups.find(
      (group) => group.nodes.length + group.pending.length > 0,
    )?.key ?? "owned";
  const activeSource: TabSource =
    pickedSource ?? selectedTabSource ?? firstNonEmpty;
  const activeGroup =
    sourceGroups.find((group) => group.key === activeSource) ?? sourceGroups[0];
  /** 测速只覆盖当前标签里的节点：看到什么就测什么。 */
  const activeNodeIds = (activeGroup?.nodes ?? []).map(
    (entry) => entry.node.node_id,
  );
  const freeNodeIds = freeEntries.map((entry) => entry.node.node_id);
  /** 到期后即使 Host 已清空免费节点，也留一张提醒卡，确认后再消失。 */
  const showFreeCard = trialEnded
    ? !trialExpiredDismissed
    : freeEntries.length > 0;

  /** 当前组超过 12 个节点才值得给搜索；否则搜索框只是噪音。 */
  const activeRowCount =
    (activeGroup?.nodes.length ?? 0) + (activeGroup?.pending.length ?? 0);
  /**
   * 测速反馈归属：手动测速落在发起的那一栏；自动测速没有栏目，
   * 落在有可见行的卡片上（标签优先，其次免费卡）。
   */
  const noteHome: TabSource | "free" | null =
    probeScope ??
    (activeRowCount > 0
      ? activeSource
      : freeEntries.length > 0
        ? "free"
        : null);
  const tabProbeNote = noteHome === activeSource ? probeBatchNote : null;
  const freeProbeNote = noteHome === "free" ? probeBatchNote : null;
  const searchable = activeRowCount > 12;
  const normalizedQuery = nodeQuery.trim().toLocaleLowerCase();
  const matchesQuery = (name: string) =>
    normalizedQuery !== "" && name.toLocaleLowerCase().includes(normalizedQuery);
  const visibleNodes =
    normalizedQuery !== "" && activeGroup
      ? activeGroup.nodes.filter(
          ({ node, index }) =>
            matchesQuery(displayNames[index] ?? node.name) ||
            matchesQuery(node.name),
        )
      : (activeGroup?.nodes ?? []);
  const visiblePending =
    normalizedQuery !== "" && activeGroup
      ? activeGroup.pending.filter((pending) => matchesQuery(pending.name))
      : (activeGroup?.pending ?? []);
  const noMatches =
    normalizedQuery !== "" &&
    visibleNodes.length === 0 &&
    visiblePending.length === 0;
  const hasAnyNode = nodes.length > 0 || pendingEntries.length > 0;
  /** 空组：标签仍显示（让两个来源的边界稳定），列表里给一句空态。 */
  const emptyGroup =
    hasAnyNode && activeRowCount === 0 && normalizedQuery === "";
  const emptyGroupText = (key: TabSource): string =>
    key === "owned"
      ? t("console.group.empty.owned")
      : t("console.group.empty.custom");

  const selectedIndex = selectedNode
    ? nodes.findIndex((node) => node.node_id === selectedNode.node_id)
    : -1;
  const selectedName =
    selectedNode !== null
      ? (displayNames[selectedIndex] ?? selectedNode.name)
      : null;

  const selectSource = (key: TabSource) => {
    setPickedSource(key);
    setNodeQuery("");
  };

  const dismissTrialExpired = () => {
    setTrialExpiredDismissed(true);
    try {
      localStorage.setItem(TRIAL_EXPIRED_DISMISSED_KEY, "1");
    } catch {
      // 存不了就只在本次会话里隐藏。
    }
  };

  /** 当前节点：切回它所在的标签，或滚到免费试用卡，把那一行带进视野。 */
  const locateCurrent = () => {
    if (selectedNode === null) return;
    const source = sourceOfNode(selectedNode);
    const scrollToRow = () => {
      window.requestAnimationFrame(() => {
        const root =
          source === "free" ? freeListRef.current : nodeListRef.current;
        root
          ?.querySelector<HTMLElement>(
            `[data-node-id="${selectedNode.node_id}"]`,
          )
          ?.scrollIntoView?.({ block: "nearest" });
      });
    };
    if (source === "free") {
      scrollToRow();
      return;
    }
    if (source !== activeSource) selectSource(source);
    else setNodeQuery("");
    scrollToRow();
  };

  /** 当前节点名跟着状态词显示；点它回到所在分组。 */
  const stateNodeLabel =
    selectedNode !== null && selectedName !== null ? (
      <button
        type="button"
        className="state-line__node"
        onClick={locateCurrent}
        title={t("console.current.locateAria", { name: selectedName })}
        aria-label={t("console.current.locateAria", { name: selectedName })}
      >
        {selectedName}
      </button>
    ) : null;

  const onSourceKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (sourceGroups.length < 2 || activeSource === null) return;
    const index = sourceGroups.findIndex((group) => group.key === activeSource);
    if (index < 0) return;
    const last = sourceGroups.length - 1;
    let next = index;
    if (event.key === "ArrowRight") next = index === last ? 0 : index + 1;
    else if (event.key === "ArrowLeft") next = index === 0 ? last : index - 1;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = last;
    else return;
    event.preventDefault();
    const key = sourceGroups[next].key;
    selectSource(key);
    window.requestAnimationFrame(() => {
      document.getElementById(`stage-tab-${key}`)?.focus();
    });
  };

  /** 托管机器的线路提示只属于「我的服务器」；自定义节点不归我们修，不给这句。 */
  const selfOwnedUnreachable =
    selectedNode !== null &&
    selectedNode.source === "owned" &&
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
        : canDiagnose
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
    /** 自有节点测不通：只给一个「智能分析」。 */
    const canAnalyze =
      msState === "bad" &&
      !expired &&
      !dangling &&
      node.source === "owned" &&
      serverId !== null &&
      onAnalyzeNode !== undefined;
    /** 行内「问 AI」只留给托管节点；自定义与免费节点没有诊断入口。 */
    const canAskInRow =
      msState === "bad" &&
      !expired &&
      !dangling &&
      !canAnalyze &&
      node.source === "owned" &&
      Boolean(onAskAi || onAskAiAboutNode);
    /** 行内要放真按钮，容器不能再用 <button>（不能嵌套）。 */
    const rowLocked = switching !== null || expired || dangling;
    return (
      <div
        key={node.node_id}
        data-node-id={node.node_id}
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
          {node.source === "url" || node.source === "manual" ? (
            <span className="stage-node__custom">{t("console.node.custom")}</span>
          ) : null}
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
        {canAnalyze ? (
          <span className="stage-node__actions">
            <span
              className="stage-node__ms is-muted is-bad"
              aria-label={probeBad ? t("console.node.probeFailedAria") : undefined}
              title={probeError || undefined}
            >
              {t("console.node.unreachable")}
            </span>
            <button
              type="button"
              className="stage-node__repair"
              aria-label={t("diagnosis.entryAria", {
                name: displayNames[index] ?? node.name,
              })}
              onClick={(event) => {
                event.stopPropagation();
                if (!serverId) return;
                onAnalyzeNode?.({
                  serverId,
                  nodeName: displayNames[index] ?? node.name,
                });
              }}
            >
              {t("diagnosis.entry")}
            </button>
            {renderMore(node, displayNames[index] ?? node.name)}
          </span>
        ) : canAskInRow ? (
          <span className="stage-node__actions">
            <button
              type="button"
              className="stage-node__ask"
              aria-label={t("connection.repair.ariaAsk", {
                name: displayNames[index] ?? node.name,
              })}
              onClick={(event) => {
                event.stopPropagation();
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
            {renderMore(node, displayNames[index] ?? node.name)}
            <span
              className="stage-node__ms is-muted is-bad"
              aria-label={probeBad ? t("console.node.probeFailedAria") : undefined}
              title={probeError || undefined}
            >
              {t("console.node.unreachable")}
            </span>
          </span>
        ) : dangling ? null : (
          <span className="stage-node__tail">
            {renderMore(node, displayNames[index] ?? node.name)}
            <span
              className={`stage-node__ms${msMuted ? " is-muted" : ""}${
                msState === "bad" ? " is-bad" : ""
              }`}
              aria-label={probeBad ? t("console.node.probeFailedAria") : undefined}
              title={probeError || undefined}
            >
              {msText}
            </span>
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
        <div className="stage-hero">
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
                <span
                  className={`state-line__label ${degraded ? "is-warn" : ""}`}
                >
                  <span
                    className={`led ${degraded ? "is-warn" : "is-ok"}`}
                    aria-hidden
                  />
                  {degraded
                    ? t("console.state.degraded")
                    : t("console.state.connected")}
                </span>
                {stateNodeLabel}
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
            {connected && !noTraffic ? null : stateNodeLabel}
          </section>

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

          {showStaleConfig ? (
            <p className="stage-note">{t("console.staleConfig")}</p>
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

          {failed ? (
            <p className="stage-note stage-note--error">
              {failureHeadline(failedAfterConnected)}
              {runtime.last_error ? ` ${errorText(runtime.last_error, "")}` : ""}
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
          ) : null}

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
        </div>

        <div className="stage-content">
        <div className="stage-nodes">
          {switchError || summary ? (
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
                        base: t("console.summary.joined", {
                          count: summary.count,
                        }),
                        ms: Math.round(summary.fastestMs),
                      })
                  : null)}
            </p>
          ) : null}

          {removedNotice ? (
            <p className="stage-note" role="status">
              {removedNotice}
            </p>
          ) : null}

          {showFreeCard ? (
            <section
              className="stage-card stage-card--free"
              aria-label={t("console.trial.title")}
            >
              {trialEnded ? (
                <div className="stage-trial-expired">
                  <div className="stage-trial-expired__text">
                    <h2 className="stage-trial-expired__title">
                      {t("trial.expired.title")}
                    </h2>
                    <p className="stage-trial-expired__note">
                      {t("console.trial.expiredNote")}
                    </p>
                  </div>
                  <button
                    type="button"
                    className="btn btn--ghost"
                    onClick={dismissTrialExpired}
                  >
                    {t("console.trial.expiredConfirm")}
                  </button>
                </div>
              ) : (
                <>
              <header className="stage-card__head">
                <div className="stage-card__titlerow">
                  <h2 className="stage-card__title">
                    {t("console.trial.title")}
                  </h2>
                  <p className="stage-card__sub">
                    {t("console.nodes.count", { count: freeEntries.length })}
                  </p>
                  <div className="stage-card__actions">
                    {renderProbeControl(freeNodeIds, "free")}
                  </div>
                </div>
                <p className="stage-trial-note">
                  <span>{t("console.trial.note")}</span>
                  <span className="stage-trial-note__hint">{trialHint}</span>
                </p>
              </header>
              {freeProbeNote ? (
                <div className="stage-card__probe-row">{freeProbeNote}</div>
              ) : null}
              <div
                className="stage-card__nodes stage-card__nodes--free"
                role="listbox"
                aria-label={t("console.trial.title")}
                ref={freeListRef}
              >
                <div
                  className="stage-node-group"
                  role="group"
                  aria-label={t("console.group.free")}
                >
                  {freeEntries.map(renderNode)}
                </div>
              </div>
                </>
              )}
            </section>
          ) : null}

          <section className="stage-card" aria-label={t("console.aria.nodes")}>
            <header className="stage-card__head">
              <div className="stage-card__titlerow">
                <h2 className="stage-card__title">{t("console.title.nodes")}</h2>
                <p className="stage-card__sub">
                  {t("console.nodes.count", {
                    count: ownedEntries.length + customEntries.length,
                  })}
                </p>
                <div className="stage-card__actions">
                  {renderProbeControl(activeNodeIds, activeSource)}
                  {onAddNode ? (
                    <button
                      type="button"
                      className="stage-add"
                      onClick={onAddNode}
                      title={t("settings.import.title")}
                    >
                      <svg
                        className="stage-add__icon"
                        viewBox="0 0 16 16"
                        width="14"
                        height="14"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.5"
                        strokeLinecap="round"
                        aria-hidden="true"
                        focusable="false"
                      >
                        <path d="M8 3v10M3 8h10" />
                      </svg>
                      <span className="sr-only">
                        {t("settings.import.title")}
                      </span>
                    </button>
                  ) : null}
                </div>
              </div>
            </header>

            {hasAnyNode ? (
              <div
                className="stage-tabs"
                role="tablist"
                aria-label={t("console.sources.aria")}
                onKeyDown={onSourceKeyDown}
              >
                {sourceGroups.map((group) => (
                  <button
                    key={group.key}
                    type="button"
                    role="tab"
                    id={`stage-tab-${group.key}`}
                    aria-selected={group.key === activeSource}
                    aria-controls="stage-node-list"
                    tabIndex={group.key === activeSource ? 0 : -1}
                    className={`stage-tabs__tab ${
                      group.key === activeSource ? "is-selected" : ""
                    }`}
                    onClick={() => selectSource(group.key)}
                  >
                    {group.key === selectedTabSource ? (
                      <span
                        className="stage-tabs__inuse"
                        role="img"
                        aria-label={
                          connected
                            ? t("console.inUse")
                            : t("console.current.label")
                        }
                      />
                    ) : null}
                    <span className="stage-tabs__label">{group.label}</span>
                    <span className="stage-tabs__count num">
                      {group.nodes.length + group.pending.length}
                    </span>
                  </button>
                ))}
              </div>
            ) : null}

            {searchable ? (
              <div className="stage-search">
                <input
                  type="search"
                  className="stage-search__input"
                  value={nodeQuery}
                  onChange={(event) => setNodeQuery(event.target.value)}
                  placeholder={t("console.search.placeholder")}
                  aria-label={t("console.search.placeholder")}
                />
              </div>
            ) : null}

            {tabProbeNote ? (
              <div className="stage-card__probe-row">{tabProbeNote}</div>
            ) : null}

            {activeSource === "owned" && selfOwnedUnreachable ? (
              <div className="stage-card__probe-row">
                <p className="stage-card__probe-note">
                  {t("console.selfOwnedUnreachable")}
                </p>
              </div>
            ) : null}

            <div
              className="stage-card__nodes"
              id="stage-node-list"
              role="listbox"
              aria-label={t("console.aria.nodes")}
              ref={nodeListRef}
            >
              {activeGroup && activeRowCount > 0 ? (
                <div
                  className="stage-node-group"
                  role="group"
                  aria-label={activeGroup.label}
                >
                  {visibleNodes.map(renderNode)}
                  {visiblePending.map(renderPendingNode)}
                </div>
              ) : null}
            </div>

            {emptyGroup ? (
              <p className="stage-group-empty">
                <span>{emptyGroupText(activeSource)}</span>
                {activeSource === "custom" && onAddNode ? (
                  <button type="button" className="stage-add" onClick={onAddNode}>
                    {t("settings.import.title")}
                  </button>
                ) : null}
              </p>
            ) : null}

            {noMatches ? (
              <p className="stage-search__empty">
                <span>{t("console.search.empty")}</span>
                <button
                  type="button"
                  className="stage-note__link"
                  onClick={() => setNodeQuery("")}
                >
                  {t("console.search.clear")}
                </button>
              </p>
            ) : null}

            {config !== null &&
            nodes.length === 0 &&
            pendingEntries.length === 0 ? (
              <p className="stage-note stage-card__empty">{t("console.empty")}</p>
            ) : null}

            {confirmFor ? (
              <div
                className="stage-node-confirm"
                role="alertdialog"
                aria-labelledby="stage-node-remove-title"
                aria-describedby="stage-node-remove-body"
                onMouseDown={(event) => event.stopPropagation()}
                onKeyDown={(event) => {
                  if (event.key !== "Escape") return;
                  event.preventDefault();
                  closeRemoveConfirm();
                }}
              >
                <p
                  id="stage-node-remove-title"
                  className="stage-node-confirm__title"
                >
                  {t("console.node.removeTitle", { name: confirmFor.name })}
                </p>
                <p
                  id="stage-node-remove-body"
                  className="stage-node-confirm__body"
                >
                  {t("console.node.removeBody")}
                </p>
                {selectedId === confirmFor.id ? (
                  <p className="stage-node-confirm__body">
                    {t("console.node.removeCurrent")}
                  </p>
                ) : null}
                {removeError ? (
                  <p className="stage-node-confirm__error" role="alert">
                    {removeError}
                  </p>
                ) : null}
                <div className="stage-node-confirm__actions">
                  <button
                    type="button"
                    className="btn btn--ghost"
                    autoFocus
                    disabled={removeBusy}
                    onClick={closeRemoveConfirm}
                  >
                    {t("common.cancel")}
                  </button>
                  <button
                    type="button"
                    className="btn btn--danger-ghost"
                    disabled={removeBusy}
                    onClick={() => void confirmRemove()}
                  >
                    {removeBusy
                      ? t("console.node.removing")
                      : t("console.node.removeConfirm")}
                  </button>
                </div>
              </div>
            ) : null}
          </section>
        </div>

        <div className="stage-flow">
          {actionCards.map((card) => (
            <section className="action-card" key={card.id} aria-label={card.title}>
              <h3 className="action-card__title">{card.title}</h3>
              {card.detail ? (
                <p className="action-card__detail">{card.detail}</p>
              ) : null}
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
        </div>
        </div>
      </div>
    </main>
  );
}
