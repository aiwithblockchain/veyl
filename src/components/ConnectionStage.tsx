import { useEffect, useRef, useState } from "react";
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
  /** 服务器已销毁但节点记录还在：只标记，不再发命令。 */
  destroyedNodeIds?: ReadonlySet<string>;
  /** 免费节点步骤流完成后的收敛句：已加入 N 个免费节点，最快 Xms。 */
  trialSummary?: { configId: string; count: number; fastestMs: number | null } | null;
  /** 试用截止时间（ISO）：免费组标题右侧按剩余天数写到期文案。 */
  trialExpiresAt?: string | null;
  /** 试用步骤流完成时的一次性预选；之后任何测速都不重新推导。 */
  preselect?: { configId: string; nodeId: string; nonce: number } | null;
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
}

const NO_TRAFFIC_ACTION =
  "网页打不开时，点上面的「重新连接」；还是不行，就换一个节点再试。";

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
  destroyedNodeIds = new Set<string>(),
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
      // 测过但没通就显示「—」，不要回落到运行时旧延迟。
      return probe.reachable && probe.latency_ms !== null
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
    setFastestMarkId(preselect.nodeId);
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

  const probeRunning = nodeProbes.run !== null;
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
  const [probeAllFailed, setProbeAllFailed] = useState(false);

  // 新一批开始：手动测速等结果再重算标记；后台/自动测速只清标记，不移动。
  useEffect(() => {
    const runId = nodeProbes.run?.runId ?? null;
    if (runId && !prevRunIdRef.current) {
      setProbeAllFailed(false);
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
    setProbeAllFailed(
      finished.total > 0 && finished.ok === 0 && !finished.cancelled,
    );
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
      if (!result?.reachable || result.latency_ms === null) continue;
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

  const primaryLabel = helperPreparing
    ? "连接中…"
    : starting
      ? "连接中…"
      : stopping
        ? "断开中…"
        : connected && !noTraffic
          ? "断开"
          : failed && onDiagnose
            ? "让 AI 检查"
            : failed || noTraffic
              ? "重新连接"
              : "连接";
  const primaryDisabled =
    starting || stopping || helperPreparing || switching !== null;
  const probeTitle = probeRunning
    ? "测速中"
    : switching !== null || starting || stopping || helperPreparing
      ? "正在切换，稍后再试"
      : undefined;

  const onPrimary = async () => {
    if (primaryDisabled) return;
    if (connected && !noTraffic) {
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
  /** 两类同池才分组；只有一类时与单来源的卡片完全一致。 */
  const mixedSources = freeEntries.length > 0 && ownedEntries.length > 0;
  const allSeed = nodes.length > 0 && freeEntries.length === nodes.length;

  /** 免费组标题右侧：按剩余天数向上取整；拿不到截止时间才退回「试用中」。 */
  const trialHint = (() => {
    if (!trialExpiresAt) return "试用中";
    const ends = Date.parse(trialExpiresAt);
    if (!Number.isFinite(ends)) return "试用中";
    const remaining = ends - now;
    if (remaining < 86_400_000) return "今天到期";
    return `${Math.ceil(remaining / 86_400_000)} 天后到期`;
  })();

  const renderNode = ({ node, index }: (typeof nodeEntries)[number]) => {
    const latency = latencies[index];
    const active = node.node_id === selectedId;
    const destroyed = destroyedNodeIds.has(node.node_id);
    const probeFailed = nodeProbes.results[node.node_id]?.reachable === false;
    return (
      <button
        key={node.node_id}
        type="button"
        role="option"
        aria-selected={active}
        className={`stage-node ${active ? "is-selected" : ""} ${
          destroyed ? "is-destroyed" : ""
        }`}
        onClick={() => {
          if (!destroyed) void switchTo(node.node_id);
        }}
        disabled={switching !== null || destroyed}
      >
        <span className="stage-node__name" title={node.name}>
          <span className="stage-node__name-text">
            {displayNames[index] ?? node.name}
          </span>
          {fastestMarkId === node.node_id ? (
            <span className="stage-node__fastest">最快</span>
          ) : null}
          {destroyed ? <span className="stage-node__badge">已销毁</span> : null}
        </span>
        <span
          className="stage-node__ms"
          aria-label={probeFailed ? "这次没测通" : undefined}
        >
          {switching === node.node_id
            ? "切换中"
            : nodeProbes.probing.has(node.node_id)
              ? "测速中"
              : latency !== null
                ? formatLatency(latency)
                : "—"}
        </span>
      </button>
    );
  };

  return (
    <main className="connection-stage" aria-label="连接">
      <div className="connection-stage__col">
        <section className="stage-band" aria-live="polite">
          <p className="sr-only" role="status">
            {connected
              ? noTraffic
                ? `已连接，不通。${NO_TRAFFIC_ACTION}`
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
            {probeAllFailed && !probeRunning ? (
              <p className="stage-card__probe-note">这次都没测通。</p>
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
                </div>
                <div className="stage-node-group" role="group" aria-label="免费节点">
                  <div className="stage-node-group__head">
                    <span>免费节点</span>
                    <span className="stage-node-group__hint">{trialHint}</span>
                  </div>
                  {freeEntries.map(renderNode)}
                </div>
              </>
            ) : (
              nodeEntries.map(renderNode)
            )}
          </div>
        </section>

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

        {failed ? (
          <button type="button" className="stage-secondary" onClick={onStart}>
            重新连接
          </button>
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
            onReportProblem={onReportProblem}
            reportBusy={reportBusy}
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
            {NO_TRAFFIC_ACTION}
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
