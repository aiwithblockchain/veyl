import { useEffect, useState } from "react";
import type { ConfigDetail, RuntimeView } from "../agent/protocol";
import type { VpnConnectionState } from "../config/useVpnSession";
import type { NodeProbesController } from "../config/useNodeProbes";
import { dataPlaneDown } from "../ui/dataPlane";
import { formatClock } from "../ui/format";
import { failureHeadline } from "../ui/middleArea";
import { formatLatency } from "../ui/nodeList";
import type { ActionCard } from "../ui/actionCard";

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
  trialSummary?: { count: number; fastestMs: number | null } | null;
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
  const selectedId = config?.current_node_id ?? null;
  const latencyOf = (nodeId: string, nodeLatency: number | null): number | null => {
    const probe = nodeProbes.results[nodeId];
    if (probe?.reachable && probe.latency_ms !== null) return probe.latency_ms;
    if (runtime.node_id === nodeId && nodeLatency !== null) return nodeLatency;
    return null;
  };
  const latencies = nodes.map((node) => latencyOf(node.node_id, runtime.node_latency_ms));
  const known = latencies.filter((value): value is number => value !== null);
  const fastest = known.length > 0 ? Math.min(...known) : null;

  const switchTo = async (nodeId: string) => {
    if (nodeId === selectedId || switching) return;
    setSwitchError(null);
    setSwitching(nodeId);
    const result = await onSwitchNode(nodeId);
    setSwitching(null);
    if (!result.ok) setSwitchError(result.message ?? "没能切换节点，再试一次。");
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
  const primaryDisabled = starting || stopping || helperPreparing;

  const onPrimary = () => {
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

        <section className="stage-card" aria-label={config?.name ?? "节点"}>
          <header className="stage-card__head">
            <h2 className="stage-card__title">{config?.name ?? "节点"}</h2>
            <p className="stage-card__sub">
              {`${nodes.length} 个节点${
                nodes.some((node) => node.source === "seed") ? " · 7 天试用" : ""
              }`}
            </p>
          </header>
          <div className="stage-card__nodes" role="listbox" aria-label="节点">
            {nodes.map((node, index) => {
              const latency = latencies[index];
              const active = node.node_id === selectedId;
              const destroyed = destroyedNodeIds.has(node.node_id);
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
                  <span className="stage-node__name">
                    {node.name}
                    {destroyed ? (
                      <span className="stage-node__badge">已销毁</span>
                    ) : null}
                  </span>
                  <span className="stage-node__ms">
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
            })}
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
          <p className="stage-note">{NO_TRAFFIC_ACTION}</p>
        ) : (
          <p className="stage-note">
            {trialSummary
              ? `已加入 ${trialSummary.count} 个免费节点${
                  trialSummary.fastestMs !== null
                    ? `，最快 ${Math.round(trialSummary.fastestMs)}ms`
                    : ""
                }`
              : `${nodes.length > 0 ? `已加入 ${nodes.length} 个节点` : "还没有节点"}${
                  fastest !== null ? `，最快 ${formatLatency(fastest)}` : ""
                }`}
            {switchError ? ` · ${switchError}` : ""}
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
        )}
      </div>
    </main>
  );
}
