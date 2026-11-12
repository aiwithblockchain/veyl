import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { ConfigDetail, ConfigRouteMode, NodeSummary, RuntimeView } from "../agent/protocol";
import { DEFAULT_PROXY_PORT } from "../agent/bridge";
import type { ProbeResult } from "../config/useVpnSession";
import type { NodeProbesController } from "../config/useNodeProbes";
import { copyText } from "../ui/clipboard";
import { modeSummary } from "../ui/configLabels";
import {
  runZeroConfigPrimaryAction,
  zeroConfigContent,
  zeroConfigMode,
} from "../ui/consoleActions";
import { formatCheckedAgo, formatClock, formatTraffic } from "../ui/format";
import { dataPlaneDown } from "../ui/dataPlane";
import {
  DNS_NOTE_TEXT,
  failureHeadline,
  hasDnsDegradation,
  middleBlocks,
  middleLevel,
  resolveLayoutBlocks,
} from "../ui/middleArea";
import { probeBadge, formatLatency } from "../ui/nodeList";
import { rateChart, rateLabel, type RateSample } from "../ui/rateSeries";
import { MiddleArea } from "./MiddleArea";
import { NodeSheet } from "./NodeSheet";
import { TrafficScopeSwitch } from "./TrafficScopeSwitch";

interface Props {
  config: ConfigDetail | null;
  onStart: () => void;
  onStop: () => void;
  /** 已连接但不通时的「重新连接」：先停再连。 */
  onReconnect: () => void;
  /** 报告问题入口：与故障卡链接、设置行走同一个动作。 */
  onReportProblem?: () => void;
  /** 正在开会话发开场：期间禁用所有报告入口，防止连点。 */
  reportBusy?: boolean;
  onSwitchNode: (nodeId: string) => Promise<{ ok: boolean; message?: string }>;
  onProbe: (nodeId: string) => Promise<ProbeResult>;
  nodeProbes: NodeProbesController;
  nodeProbeAvailable: boolean;
  aiReady: boolean;
  justOnboarded: boolean;
  zeroConfigSettled: boolean;
  hasConfigs: boolean;
  onAskAi: () => void;
  onNewConfig: () => void;
  /** 中间块「用 Veyl 免费节点」：用户已定来源，直接开手动表单，不再让 AI 问一遍。 */
  onUseSeedNodes?: () => void;
  /** 「用我自己的节点」：去设置页导入节点文件。 */
  onImportNodes?: () => void;
  /** 种子包有新版本：决定 update_hint 是否有内容可渲染。 */
  seedUpdate?: boolean;
  /** 设置里的本地代理端口；未连接时代理卡显示它。 */
  proxyPort?: number;
  /** 系统地区；决定中间区那行本地直连口径，null = 未知。 */
  region?: string | null;
  /** 开关用的地区：已连接取本次快照，未连接取实时推断。 */
  scopeRegion?: string | null;
  /** 已连接时 AI 改了地区：说明行追加一次「下次连接生效」。 */
  regionChanged?: boolean;
  /** 当前配置的流量范围；proxy_selected 旧数据不显示开关。 */
  routingMode?: ConfigRouteMode | null;
  /** 切换流量范围；由 App 调 route_set_mode 并回写状态。 */
  onSetRoutingMode?: (
    mode: "direct" | "proxy_all",
  ) => Promise<{ ok: boolean; message?: string }>;
  onOpenDiagnostics?: () => void;
  loading?: boolean;
  runtime: RuntimeView;
  /** 最近一次失败是否来自已连接态；决定失败卡标题是「连接断了」还是「没有连上节点」。 */
  failedAfterConnected?: boolean;
  /** 连接「全部流量」前正在更新后台组件：先说明系统会请求授权，再弹窗。 */
  helperPreparing?: boolean;
  /** 健康事件累积的最近 60 秒速率（前端内存，重启即丢）。 */
  rateSamples?: RateSample[];
}

type Probe =
  | { nodeId: string; status: "testing" }
  | { nodeId: string; status: "ok"; latency: number | null }
  | { nodeId: string; status: "fail"; message: string | null; unreachable: boolean };

const NO_RATE: RateSample[] = [];

const NO_TRAFFIC_ACTION =
  "网页打不开时，点上面的「重新连接」；还是不行，就换下面的节点再试。";

function CopyIcon() {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden>
      <rect
        x="5.5"
        y="5.5"
        width="7.5"
        height="7.5"
        rx="1.2"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
      />
      <path
        d="M10.2 5.5V3.9a1.4 1.4 0 0 0-1.4-1.4H3.9a1.4 1.4 0 0 0-1.4 1.4v4.9a1.4 1.4 0 0 0 1.4 1.4h1.6"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
      />
    </svg>
  );
}

export function Console({
  config,
  onStart,
  onStop,
  onReconnect,
  onReportProblem,
  reportBusy = false,
  onSwitchNode,
  onProbe,
  nodeProbes,
  nodeProbeAvailable,
  aiReady,
  justOnboarded,
  zeroConfigSettled,
  hasConfigs,
  onAskAi,
  onNewConfig,
  onUseSeedNodes,
  onImportNodes,
  seedUpdate = false,
  proxyPort = DEFAULT_PROXY_PORT,
  region = null,
  scopeRegion,
  regionChanged = false,
  routingMode = null,
  onSetRoutingMode,
  onOpenDiagnostics,
  loading = false,
  runtime,
  failedAfterConnected = false,
  helperPreparing = false,
  rateSamples = NO_RATE,
}: Props) {
  const [sheetOpen, setSheetOpen] = useState(false);
  const [probe, setProbe] = useState<Probe | null>(null);
  const [exitCopy, setExitCopy] = useState<"idle" | "copied" | "failed">("idle");
  const [now, setNow] = useState(() => Date.now());
  const [cardNow, setCardNow] = useState(() => Date.now());
  const copyTimer = useRef<number | null>(null);
  const detailRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const returnFocusRef = useRef(false);
  const configId = config?.config_id ?? null;
  const currentNodeId = config?.current_node_id ?? null;
  const exitAddress = runtime.health.exit_ip?.trim() || null;

  const level = middleLevel(runtime.state);
  const connected = level === "running" || level === "degraded";
  const degraded = level === "degraded";
  const transitioning = level === "transition";
  const stopping = runtime.state === "stopping";

  const canConnect = Boolean(config && config.nodes.length > 0);
  const hasNodes = (config?.nodes.length ?? 0) > 0;

  useEffect(() => {
    setExitCopy("idle");
  }, [exitAddress, connected]);

  useEffect(
    () => () => {
      if (copyTimer.current !== null) window.clearTimeout(copyTimer.current);
    },
    [],
  );

  // 换配置时收起面板；同一配置内切换节点（面板里点一行）不关面板。
  useEffect(() => {
    setSheetOpen(false);
    setProbe(null);
  }, [configId]);

  // 当前节点变化后，旧的单测结果不再属于正在显示的节点。
  useEffect(() => {
    setProbe(null);
  }, [currentNodeId]);

  // 节点只剩 1 个（或没有）时不再有可选列表，面板随之关闭。
  useEffect(() => {
    if (sheetOpen && (config?.nodes.length ?? 0) <= 1) setSheetOpen(false);
  }, [sheetOpen, config?.nodes.length]);

  // 关闭面板后焦点回到节点行，不回到页面顶部。
  useEffect(() => {
    if (sheetOpen || !returnFocusRef.current) return;
    returnFocusRef.current = false;
    triggerRef.current?.focus();
  }, [sheetOpen]);

  // 计时器每秒跳一次；连接时刻来自 runtime，不轮询快照。
  useEffect(() => {
    if (!connected) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [connected]);

  // 延迟新鲜度按 30 秒刷新，未连接时也要走。
  useEffect(() => {
    setCardNow(Date.now());
    const timer = window.setInterval(() => setCardNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!connected) setProbe(null);
  }, [connected]);

  const selectedNode: NodeSummary | null =
    config?.nodes.find((node) => node.node_id === config.current_node_id) ??
    config?.nodes[0] ??
    null;
  const selectedNodeId = selectedNode?.node_id ?? null;
  const canPick = (config?.nodes.length ?? 0) > 1;
  const currentBatch =
    config && nodeProbes.run?.configId === config.config_id ? nodeProbes.run : null;

  const connectedAt = runtime.connected_since
    ? Date.parse(runtime.connected_since)
    : Number.NaN;
  const durationSeconds = Number.isFinite(connectedAt)
    ? Math.max(0, Math.floor((now - connectedAt) / 1000))
    : null;
  const clock = formatClock(durationSeconds ?? 0);

  const usedBytes = runtime.traffic
    ? runtime.traffic.up_bytes + runtime.traffic.down_bytes
    : null;
  const trafficLabel = usedBytes === null ? "—" : formatTraffic(usedBytes);
  const trafficSub = runtime.traffic
    ? `上行 ${formatTraffic(runtime.traffic.up_bytes)} · 下行 ${formatTraffic(runtime.traffic.down_bytes)}`
    : "还没开始统计";
  const latencyLabel =
    runtime.node_latency_ms === null ? "—" : `${runtime.node_latency_ms} ms`;
  const latencySub = formatCheckedAgo(runtime.health.checked_at, now);
  const rates = rateLabel(rateSamples);

  // null 走本地兜底；[] 是 AI 明确选择空白；非空但一块都渲染不出时退回本地。
  const localBlocks = config
    ? middleBlocks(runtime, config, aiReady, proxyPort, region)
    : [];
  const layout = config?.layout ?? null;
  const layoutBlocks =
    config && layout
      ? resolveLayoutBlocks(layout, runtime, config, {
          hasSeedUpdate: seedUpdate,
          proxyPort,
          region,
        })
      : [];
  const layoutHadBlocks =
    Array.isArray(layout?.blocks) && layout.blocks.length > 0;
  // 系统叠加块（故障卡、DNS 降级说明）在任何布局下都要在：先取出本地生成的系统块，
  // 再把布局里可能重复的同类块去掉，保证只渲染一份。
  const isSystemBlock = (block: (typeof localBlocks)[number]) =>
    block.kind === "issue_card" || block.kind === "dns_note";
  const systemBlocks = localBlocks.filter(isSystemBlock);
  let blocks: typeof localBlocks;
  if (!config || !layout) {
    blocks = localBlocks;
  } else {
    const base =
      layoutBlocks.length === 0 && layoutHadBlocks ? localBlocks : layoutBlocks;
    blocks = [...systemBlocks, ...base.filter((block) => !isSystemBlock(block))];
  }

  const runProbe = async () => {
    if (!selectedNode || probe?.status === "testing" || currentBatch) return;
    const node = selectedNode;
    setProbe({ nodeId: node.node_id, status: "testing" });
    const result = await onProbe(node.node_id);
    setProbe((current) => {
      if (!current || current.nodeId !== node.node_id) return current;
      return result.ok
        ? { nodeId: node.node_id, status: "ok", latency: result.latencyMs }
        : {
            nodeId: node.node_id,
            status: "fail",
            message: result.message ?? null,
            unreachable: result.unreachable,
          };
    });
  };

  const copyExit = async () => {
    if (!exitAddress) return;
    const ok = await copyText(exitAddress);
    setExitCopy(ok ? "copied" : "failed");
    if (copyTimer.current !== null) window.clearTimeout(copyTimer.current);
    copyTimer.current = window.setTimeout(() => setExitCopy("idle"), 2000);
  };

  let probeLabel: string | null = null;
  if (probe?.status === "testing") probeLabel = "测速中…";
  else if (probe?.status === "ok") {
    probeLabel = probe.latency === null ? "可达" : `延迟 ${probe.latency} 毫秒`;
  } else if (probe?.status === "fail") {
    probeLabel = probe.unreachable ? "连不上" : "测速失败";
  }

  const currentProbe = selectedNodeId ? nodeProbes.results[selectedNodeId] : undefined;
  const runtimeProbe =
    !currentProbe &&
    connected &&
    selectedNodeId &&
    runtime.node_id === selectedNodeId &&
    runtime.node_latency_ms !== null
      ? {
          node_id: selectedNodeId,
          reachable: true,
          latency_ms: runtime.node_latency_ms,
          probe_method: "tcp" as const,
          checked_at: Date.parse(runtime.health.checked_at) || 0,
          error: null,
        }
      : undefined;
  const cardBadge = selectedNodeId
    ? probeBadge(
        currentProbe ?? runtimeProbe,
        cardNow,
        nodeProbes.probing.has(selectedNodeId),
        currentBatch?.phase === "preparing",
      )
    : null;
  const cardLatency = cardBadge
    ? cardBadge.kind === "preparing" || cardBadge.kind === "probing"
      ? cardBadge.label
      : currentProbe?.reachable && currentProbe.latency_ms !== null
        ? formatLatency(currentProbe.latency_ms)
        : runtimeProbe?.reachable && runtimeProbe.latency_ms !== null
          ? formatLatency(runtimeProbe.latency_ms)
          : cardBadge.label
    : null;
  const cardAgo =
    !currentBatch && cardBadge?.time && cardBadge.kind !== "probing"
      ? `${cardBadge.time}测过`
      : null;

  const closeSheet = () => {
    returnFocusRef.current = true;
    setSheetOpen(false);
  };

  const zeroMode = zeroConfigMode(aiReady, justOnboarded, zeroConfigSettled);
  const zeroContent = zeroConfigContent(zeroMode);

  const showLedger = Boolean(config && hasNodes && !transitioning && level !== "failed");
  const showStrip = Boolean(connected && config && !isProxy(config));
  // 只有 running 且探测新鲜失败才算；degraded 仍走「连接不稳定」。
  const noTraffic = dataPlaneDown(runtime, now);

  const scopeSwitch =
    config && onSetRoutingMode ? (
      <TrafficScopeSwitch
        mode={routingMode}
        region={scopeRegion === undefined ? region : scopeRegion}
        regionChanged={regionChanged}
        connected={connected}
        disabled={transitioning || stopping || helperPreparing}
        onChange={onSetRoutingMode}
      />
    ) : null;

  let hero: ReactNode;
  if (connected && noTraffic) {
    // 连着但流量出不去：不显示计时器，边跑秒边说正常等于撒谎。
    hero = (
      <section className="hero">
        <div className="hero__main">
          <h1 className="state-word">
            <span className="led is-warn" aria-hidden />
            <span>已连接，不通</span>
          </h1>
          <p className="hero__action">{NO_TRAFFIC_ACTION}</p>
          {scopeSwitch}
        </div>
        <button type="button" className="btn btn--primary" onClick={onReconnect}>
          重新连接
        </button>
      </section>
    );
  } else if (connected) {
    hero = (
      <section className="hero">
        <div className="hero__main">
          <h1 className="state-line">
            <span className="state-line__label">
              <span className={`led ${degraded ? "is-warn" : "is-ok"}`} aria-hidden />
              {degraded ? "连接不稳定" : "已连接"}
            </span>
            <span className="timecode num">{clock}</span>
          </h1>
          <p className="hero__caption">本次连接</p>
          {scopeSwitch}
        </div>
        <button type="button" className="btn btn--outline" onClick={onStop}>
          断开 VPN
        </button>
      </section>
    );
  } else {
    const word = helperPreparing
      ? "正在准备后台组件"
      : stopping
        ? "正在断开"
        : transitioning
          ? "正在连接"
          : level === "failed"
            ? "连接失败"
            : "未连接";
    const led = helperPreparing
      ? "is-connecting"
      : stopping
        ? ""
        : transitioning
          ? "is-connecting"
          : level === "failed"
            ? "is-err"
            : null;
    const caption = helperPreparing
      ? "系统会请求一次授权。"
      : level === "failed"
        ? failureHeadline(failedAfterConnected)
        : null;
    hero = (
      <section className="hero">
        <div className="hero__main">
          <h1 className="state-word">
            {led ? <span className={`led ${led}`} aria-hidden /> : null}
            <span>{word}</span>
          </h1>
          {caption ? <p className="hero__caption">{caption}</p> : null}
          {scopeSwitch}
        </div>
        {transitioning ? (
          <button
            type="button"
            className="btn btn--outline"
            disabled={stopping}
            onClick={stopping ? undefined : onStop}
          >
            {stopping ? "正在断开…" : "取消"}
          </button>
        ) : level === "failed" ? (
          <button
            type="button"
            className="btn btn--primary"
            disabled={!canConnect || helperPreparing}
            onClick={onStart}
          >
            重新连接
          </button>
        ) : (
          <button
            type="button"
            className="btn btn--primary"
            disabled={!canConnect || helperPreparing}
            onClick={onStart}
          >
            启动 VPN
          </button>
        )}
      </section>
    );
  }

  const dnsDegraded = hasDnsDegradation(runtime);
  const srStatus = helperPreparing
    ? "正在准备后台组件，系统会请求一次授权"
    : stopping
      ? "正在断开"
      : transitioning
        ? "正在连接"
        : level === "failed"
          ? "连接失败"
          : degraded
            ? dnsDegraded
              ? `连接不稳定。${DNS_NOTE_TEXT}`
              : "连接不稳定"
            : connected
              ? noTraffic
                ? `已连接，不通。${NO_TRAFFIC_ACTION}`
                : dnsDegraded
                  ? `已连接。${DNS_NOTE_TEXT}`
                  : "已连接"
              : "未连接";

  return (
    <main className="console">
      {!loading && !hasConfigs ? (
        <div className="console__body console__body--welcome">
          <p className="sr-only" role="status" aria-live="polite">
            {srStatus}
          </p>
          <section className="hero">
            <div className="hero__main">
              <h1 className="state-word">
                <span>{zeroContent.title}</span>
              </h1>
              {zeroContent.body ? (
                <p className="hero__caption">{zeroContent.body}</p>
              ) : null}
            </div>
            {zeroContent.primaryLabel ? (
              <button
                type="button"
                className="btn btn--primary"
                onClick={() =>
                  runZeroConfigPrimaryAction(zeroMode, { onAskAi, onNewConfig })
                }
              >
                {zeroContent.primaryLabel}
              </button>
            ) : null}
          </section>
          {zeroContent.steps ? (
            <ol className="steps">
              {zeroContent.steps.map((step, index) => (
                <li key={step.title}>
                  <span className="steps__num">{String(index + 1).padStart(2, "0")}</span>
                  <span>
                    <strong>{step.title}</strong>
                    <small>{step.detail}</small>
                  </span>
                </li>
              ))}
            </ol>
          ) : null}
        </div>
      ) : loading ? (
        <div className="console__body" aria-busy="true" aria-label="正在读取配置">
          <span className="skeleton skeleton--hero" aria-hidden />
          <span className="skeleton skeleton--ledger" aria-hidden />
          <span className="skeleton skeleton--card" aria-hidden />
        </div>
      ) : !config ? (
        <div className="console__body">
          <p className="sr-only" role="status" aria-live="polite">
            未连接
          </p>
          <div className="one-thing">
            <p className="note note--idle">在左侧选一套配置。</p>
          </div>
        </div>
      ) : (
        <>
        <div className="console__body">
          <p className="sr-only" role="status" aria-live="polite">
            {srStatus}
          </p>

          {hero}

          {transitioning && !stopping ? (
            <div className="progress" aria-hidden />
          ) : null}

          {showLedger && config ? (
            <dl className="ledger">
              {connected ? (
                <>
                  <div className="ledger__row">
                    <dt className="ledger__label">流量</dt>
                    <dd className="ledger__value">{trafficLabel}</dd>
                    <dd className="ledger__sub">{trafficSub}</dd>
                  </div>
                  <div className="ledger__row">
                    <dt className="ledger__label">延迟</dt>
                    <dd className="ledger__value">{latencyLabel}</dd>
                    <dd className="ledger__sub">{latencySub}</dd>
                  </div>
                  <div className="ledger__row">
                    <dt className="ledger__label">出口</dt>
                    <dd className="ledger__value">{exitAddress ?? "—"}</dd>
                    <dd className="ledger__sub">
                      {exitAddress ? (
                        <button type="button" className="copy-btn" onClick={() => void copyExit()}>
                          <CopyIcon />
                          <span aria-live="polite">
                            {exitCopy === "copied"
                              ? "已复制"
                              : exitCopy === "failed"
                                ? "复制失败"
                                : "复制"}
                          </span>
                        </button>
                      ) : (
                        "正在确认出口…"
                      )}
                    </dd>
                  </div>
                </>
              ) : (
                <>
                  <div className="ledger__row">
                    <dt className="ledger__label">方式</dt>
                    <dd className="ledger__value ledger__value--text">
                      {modeSummary(config).value}
                    </dd>
                    <dd className="ledger__sub">{modeSummary(config).sub}</dd>
                  </div>
                  <div className="ledger__row">
                    <dt className="ledger__label">节点</dt>
                    <dd className="ledger__value ledger__value--text">
                      {config.nodes.length} 个可选
                    </dd>
                    <dd className="ledger__sub">
                      {config.nodes.length > 1 ? "可切换" : "先加一个节点"}
                    </dd>
                  </div>
                </>
              )}
            </dl>
          ) : null}

          <MiddleArea
            blocks={blocks}
            onUseSeedNodes={onUseSeedNodes ?? onNewConfig}
            onUseOwnNodes={onImportNodes}
            onReportProblem={aiReady ? onReportProblem : undefined}
            reportBusy={reportBusy}
          />

          {/* 连着但不通时没有故障卡：入口放在同一位置，不另造卡片。 */}
          {noTraffic && aiReady && onReportProblem ? (
            <button
              type="button"
              className="issue-report-link"
              disabled={reportBusy}
              onClick={onReportProblem}
            >
              报告这个问题
            </button>
          ) : null}

          {showStrip ? (
            <RateStrip samples={rateSamples} warn={degraded} current={rates} />
          ) : null}
        </div>

        {config ? (
          <div className="console__dock" ref={detailRef}>
            <NodeSheet
              open={sheetOpen}
              config={config}
              probes={nodeProbes}
              onClose={closeSheet}
              onSwitch={onSwitchNode}
              onOpenDiagnostics={
                onOpenDiagnostics
                  ? () => {
                      closeSheet();
                      onOpenDiagnostics();
                    }
                  : undefined
              }
            />
            {aiReady ? (
              <div className="console__report">
                <button
                  type="button"
                  className="btn btn--ghost"
                  disabled={!onReportProblem || reportBusy}
                  onClick={onReportProblem}
                >
                  报告问题
                </button>
              </div>
            ) : null}
            <footer className="node-card">
              {config.nodes.length > 0 ? (
                <span className="node-card__label">当前节点</span>
              ) : null}
              {selectedNode ? (
                canPick ? (
                  <button
                    ref={triggerRef}
                    type="button"
                    className="node-card__select"
                    aria-haspopup="dialog"
                    aria-expanded={sheetOpen}
                    aria-controls="node-sheet"
                    onClick={() => {
                      if (sheetOpen) closeSheet();
                      else setSheetOpen(true);
                    }}
                  >
                    <span className="node-card__name" title={selectedNode.name}>
                      {selectedNode.name}
                    </span>
                    <span className="node-card__chevron" aria-hidden>
                      ⌄
                    </span>
                    <span className="node-card__meta">
                      <span className="node-card__count">
                        {config.nodes.length} 个节点
                      </span>
                      {cardBadge && cardBadge.kind !== "untested" ? (
                        <span className={`node-card__latency tone-${cardBadge.tone}`}>
                          {cardLatency}
                        </span>
                      ) : null}
                    </span>
                  </button>
                ) : (
                  <div className="node-card__static">
                    <span className="node-card__name" title={selectedNode.name}>
                      {selectedNode.name}
                    </span>
                    {cardBadge && cardBadge.kind !== "untested" ? (
                      <span className={`node-card__latency tone-${cardBadge.tone}`}>
                        {cardLatency}
                      </span>
                    ) : null}
                  </div>
                )
              ) : (
                <p className="node-card__empty">还没有节点</p>
              )}

              {selectedNode ? (
                currentBatch ? (
                  <button
                    type="button"
                    className="node-card__progress"
                    onClick={() => setSheetOpen(true)}
                  >
                    {currentBatch.phase === "preparing"
                      ? "正在准备测速…"
                      : `正在测速 ${currentBatch.done}/${currentBatch.total} · 点开可停止`}
                  </button>
                ) : (
                  <>
                    <div className="node-card__facts num">
                      {selectedNode.server} : {selectedNode.port}
                      <span className="sep">·</span>
                      {selectedNode.method}
                    </div>
                    {cardAgo ? <p className="node-card__ago">{cardAgo}</p> : null}
                    {probeLabel ? (
                      <p
                        className={`node-card__probe ${
                          probe?.status === "ok"
                            ? "is-ok"
                            : probe?.status === "fail"
                              ? "is-err"
                              : ""
                        }`}
                        title={
                          probe?.status === "fail"
                            ? probe.message ?? undefined
                            : undefined
                        }
                      >
                        {probeLabel}
                      </p>
                    ) : null}
                  </>
                )
              ) : null}

              {config.nodes.length > 0 ? (
                <div className="node-card__actions">
                  <button
                    type="button"
                    className="btn btn--ghost"
                    disabled={
                      !nodeProbeAvailable ||
                      probe?.status === "testing" ||
                      Boolean(currentBatch)
                    }
                    onClick={() => void runProbe()}
                  >
                    测这个节点
                  </button>
                </div>
              ) : null}
            </footer>
          </div>
        ) : null}
        </>
      )}
    </main>
  );
}

function isProxy(config: ConfigDetail): boolean {
  return config.connect_mode === "system_proxy" && config.routing_mode === "proxy_selected";
}

function RateStrip({
  samples,
  warn,
  current,
}: {
  samples: RateSample[];
  warn: boolean;
  current: { up: number; down: number } | null;
}) {
  const chart = rateChart(samples);
  return (
    <section className={`strip ${warn ? "strip--warn" : ""}`} aria-label="最近 60 秒速率">
      <div className="strip__head">
        <span className="strip__label">最近 60 秒</span>
        <span className="strip__rates">
          {current
            ? `上行 ${formatTraffic(current.up)}/s · 下行 ${formatTraffic(current.down)}/s`
            : "等下一条采样"}
        </span>
      </div>
      <svg className="strip__chart" viewBox="0 0 700 56" preserveAspectRatio="none" aria-hidden>
        <line className="strip__base" x1="0" y1="53.5" x2="700" y2="53.5" />
        {chart.area ? <path className="strip__area" d={chart.area} /> : null}
        <path className="strip__line" d={chart.line} />
      </svg>
      <div className="strip__axis">
        <span>60 秒前</span>
        <span>现在</span>
      </div>
    </section>
  );
}
