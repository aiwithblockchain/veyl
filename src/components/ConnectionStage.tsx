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
import { NODE_TOMBSTONE_WORD, trialGroupHint, trialPhase } from "../myservers/labels";
import type { PendingServerNode } from "../myservers/pendingServerNodes";
import type { ActionCard } from "../ui/actionCard";
import { StageQuickToggles, type ModeSwitchResult } from "./StageQuickToggles";

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
  /** 接管方式与流量范围的「问 AI」：交给 App 展开右栏并发送固定问题。 */
  onAskAi?: (prompt: string) => void;
  /** 服务器已就绪、节点还在等断开后 attach：灰显列出，告诉用户重新连接后可用。 */
  pendingServerNodes?: PendingServerNode[];
}

/** 待接入节点类型对外导出：调用方与测试都从这里取。 */
export type { PendingServerNode };

const NO_TRAFFIC_ACTION =
  "网页打不开时，点上面的「重新连接」；还是不行，就换一个节点再试。";
/** 隧道还在跑、当前目标不能连，但池里还有别的节点可换。 */
const NO_TRAFFIC_ACTION_OTHER_NODE =
  "先点「断开」停掉隧道，再选一个节点连接。";
/** 隧道还在跑但已经没有可用节点：页面上没有「重新连接」可点的目标，只能先断开。 */
const NO_TRAFFIC_ACTION_NO_NODE =
  "没有可用节点了，点「断开」停掉隧道，再去处理节点。";

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
  pendingServerNodes = [],
}: Props) {
  const [now, setNow] = useState(() => Date.now());
  const [switchError, setSwitchError] = useState<string | null>(null);
  const [switching, setSwitching] = useState<string | null>(null);

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
      setSwitchError(result.message ?? "没能切换节点，再试一次。");
    }
  };

  const probeTitle = probeRunning
    ? "测速中"
    : switching !== null || starting || stopping || helperPreparing
      ? "正在切换，稍后再试"
      : undefined;

  const onPrimary = async () => {
    if (primaryDisabled) return;
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
          `切换节点失败：${result.message ?? "没能切换，再试一次。"}这次没有发起连接。`,
        );
        return;
      }
      setPickedId(connectTargetId);
    }
    onStart();
  };

  const stateText = noTraffic
    ? "已连接，不通"
    : failed
      ? "连接失败"
      : stopping
        ? "正在断开"
        : starting
          ? "正在连接"
          : "未连接";
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
    ? NO_TRAFFIC_ACTION
    : hasUsableNode
      ? NO_TRAFFIC_ACTION_OTHER_NODE
      : NO_TRAFFIC_ACTION_NO_NODE;

  const primaryLabel = helperPreparing
    ? "连接中…"
    : starting
      ? "连接中…"
      : stopping
        ? "断开中…"
        : connected && (!noTraffic || !connectTargetUsable)
          ? "断开"
          : failed && onDiagnose
            ? "让 AI 检查"
            : failed || noTraffic
              ? "重新连接"
              : "连接";
  const connectBlocked =
    (primaryLabel === "连接" || primaryLabel === "重新连接") &&
    connectTarget !== null &&
    (isExpiredSeed(connectTarget) || connectTargetDangling);
  const primaryDisabled =
    starting ||
    stopping ||
    helperPreparing ||
    switching !== null ||
    connectBlocked ||
    // 没有任何节点行可当目标：「连接 / 重新连接」只会空转，按规则禁用。
    ((primaryLabel === "连接" || primaryLabel === "重新连接") &&
      connectTarget === null);

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
    const msText =
      switching === node.node_id
        ? "切换中"
        : nodeProbes.probing.has(node.node_id)
          ? "测速中"
          : latency !== null
            ? formatLatency(latency)
            : probeBad
              ? "测不通"
              : "未测";
    // 「测不通 / 未测」是文字不是读数：小一档，但右端仍对齐。
    const msMuted = msText === "测不通" || msText === "未测";
    return (
      <button
        key={node.node_id}
        type="button"
        role="option"
        aria-selected={active}
        aria-disabled={expired || dangling || undefined}
        className={`stage-node ${active ? "is-selected" : ""} ${
          expired ? "is-expired" : ""
        } ${dangling ? "is-dangling" : ""}`}
        onClick={() => {
          if (!expired && !dangling) void switchTo(node.node_id);
        }}
        disabled={switching !== null || expired || dangling}
      >
        <span
          className={`stage-node__name${expired || dangling ? " has-sub" : ""}`}
          title={node.name}
        >
          <span className="stage-node__name-text">
            {displayNames[index] ?? node.name}
          </span>
          {fastestMarkId === node.node_id ? (
            <span className="stage-node__fastest">最快</span>
          ) : null}
          {expired ? <span className="stage-node__sub">已到期</span> : null}
          {dangling ? (
            <span className="stage-node__sub">{NODE_TOMBSTONE_WORD}</span>
          ) : null}
        </span>
        {dangling ? null : (
          <span
            className={`stage-node__ms${msMuted ? " is-muted" : ""}`}
            aria-label={probeBad ? "这次没测通" : undefined}
            title={probeError || undefined}
          >
            {msText}
          </span>
        )}
      </button>
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
      <span className="stage-node__note">重新连接后可用</span>
    </div>
  );

  return (
    <main className="connection-stage" aria-label="连接">
      <div className="connection-stage__col">
        <section className="stage-band" aria-live="polite">
          <p className="sr-only" role="status">
            {connected
              ? noTraffic
                ? `已连接，不通。${noTrafficAction}`
                : degraded
                  ? "连接不稳定"
                  : "已连接"
              : stateText}
          </p>
          {connected && !noTraffic ? (
            <span className="state-line">
              <span className={`state-line__label ${degraded ? "is-warn" : ""}`}>
                <span className={`led ${degraded ? "is-warn" : "is-ok"}`} aria-hidden />
                {degraded ? "连接不稳定" : "已连接"}
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

        <section className="stage-card" aria-label="节点">
          <header className="stage-card__head">
            <h2 className="stage-card__title">节点</h2>
            <div className="stage-card__subrow">
              <p className="stage-card__sub">
                {`${nodes.length} 个节点${allSeed ? " · 7 天试用" : ""}`}
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
                      测速中
                    </>
                  ) : probeAllFailed ? (
                    "再试一次"
                  ) : (
                    "测速"
                  )}
                </button>
              ) : null}
            </div>
            {probeAllFailed ? (
              <p className="stage-card__probe-note">这次都没测通。</p>
            ) : probeAllUntested ? (
              <p className="stage-card__probe-note">这次没测成。</p>
            ) : probeMixedUntested ? (
              <p className="stage-card__probe-note">
                {probeUntestedCount} 个没测成。
              </p>
            ) : null}
            {selfOwnedUnreachable ? (
              <p className="stage-card__probe-note">
                连不上不一定是机器的问题，你当前的网络到那个地区的线路不通很常见。可以销毁重建，当天已扣的费用不退。
              </p>
            ) : null}
          </header>
          <div className="stage-card__nodes" role="listbox" aria-label="节点">
            {mixedSources ? (
              <>
                <div className="stage-node-group" role="group" aria-label="你的服务器">
                  <div className="stage-node-group__head">
                    <span>你的服务器</span>
                  </div>
                  {ownedEntries.map(renderNode)}
                  {pendingEntries.map(renderPendingNode)}
                </div>
                <div className="stage-node-group" role="group" aria-label="免费节点">
                  <div className="stage-node-group__head">
                    <span>免费节点</span>
                    <span className="stage-node-group__hint">{trialHint}</span>
                  </div>
                  {freeEntries.map(renderNode)}
                </div>
              </>
            ) : ownedEntries.length === 0 && pendingEntries.length > 0 ? (
              <div className="stage-node-group" role="group" aria-label="你的服务器">
                <div className="stage-node-group__head">
                  <span>你的服务器</span>
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
        </section>

        {config !== null && nodes.length === 0 && pendingEntries.length === 0 ? (
          <p className="stage-note">这条配置没有节点了</p>
        ) : null}

        <button
          type="button"
          className="stage-primary"
          onClick={onPrimary}
          disabled={primaryDisabled}
          aria-label={
            primaryLabel === "断开"
              ? "断开连接"
              : primaryLabel === "连接"
                ? "连接节点"
                : primaryLabel
          }
        >
          {primaryLabel}
        </button>

        {connectBlocked ? (
          <p className="stage-note">
            {connectTargetDangling
              ? hasUsableNode
                ? "当前节点已停机删除，换一个节点再连接。"
                : "节点已停机删除，去我的服务器删除它，或新建一个节点。"
              : hasUsableNode
                ? "当前节点已到期，换一个节点再连接。"
                : "试用已到期，免费节点已不可用。"}
          </p>
        ) : null}

        {failed ? (
          <button
            type="button"
            className="stage-secondary"
            onClick={onStart}
            disabled={!connectTargetUsable}
          >
            重新连接
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
                报告问题
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
                报告问题
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
                ? `已加入 ${summary.count} 个免费节点${
                    manualProbed
                      ? ""
                      : summary.fastestMs !== null
                        ? `，最快 ${Math.round(summary.fastestMs)}ms`
                        : ""
                  }`
                : null)}
          </p>
        ) : null}
      </div>
    </main>
  );
}
