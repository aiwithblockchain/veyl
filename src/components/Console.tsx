import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { ConfigDetail, NodeSummary, RuntimeView } from "../agent/protocol";
import type { ProbeResult } from "../config/useVpnSession";
import { copyText } from "../ui/clipboard";
import { modeSummary, scopeSummary } from "../ui/configLabels";
import {
  runZeroConfigPrimaryAction,
  zeroConfigContent,
  zeroConfigMode,
} from "../ui/consoleActions";
import { formatCheckedAgo, formatClock, formatTraffic } from "../ui/format";
import { failureHeadline, middleBlocks, middleLevel } from "../ui/middleArea";
import { rateChart, rateLabel, type RateSample } from "../ui/rateSeries";
import { MiddleArea } from "./MiddleArea";

interface Props {
  config: ConfigDetail | null;
  onStart: () => void;
  onStop: () => void;
  onSwitchNode: (nodeId: string) => void;
  onProbe: (nodeId: string) => Promise<ProbeResult>;
  nodeSwitchAvailable: boolean;
  nodeProbeAvailable: boolean;
  aiReady: boolean;
  justOnboarded: boolean;
  zeroConfigSettled: boolean;
  hasConfigs: boolean;
  onAskAi: () => void;
  onNewConfig: () => void;
  loading?: boolean;
  runtime: RuntimeView;
  /** 最近一次失败是否来自已连接态；决定失败卡标题是「连接断了」还是「没有连上节点」。 */
  failedAfterConnected?: boolean;
  /** 健康事件累积的最近 60 秒速率（前端内存，重启即丢）。 */
  rateSamples?: RateSample[];
}

type Probe =
  | { nodeId: string; status: "testing" }
  | { nodeId: string; status: "ok"; latency: number | null }
  | { nodeId: string; status: "fail"; message: string | null; unreachable: boolean };

const NO_RATE: RateSample[] = [];

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
  onSwitchNode,
  onProbe,
  nodeSwitchAvailable,
  nodeProbeAvailable,
  aiReady,
  justOnboarded,
  zeroConfigSettled,
  hasConfigs,
  onAskAi,
  onNewConfig,
  loading = false,
  runtime,
  failedAfterConnected = false,
  rateSamples = NO_RATE,
}: Props) {
  const [selectedId, setSelectedId] = useState<string | null>(
    config?.current_node_id ?? null,
  );
  const [pickerOpen, setPickerOpen] = useState(false);
  const [probe, setProbe] = useState<Probe | null>(null);
  const [exitCopy, setExitCopy] = useState<"idle" | "copied" | "failed">("idle");
  const [now, setNow] = useState(() => Date.now());
  const copyTimer = useRef<number | null>(null);
  const detailRef = useRef<HTMLDivElement>(null);
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

  // 换配置或真正切换节点后，详情回到这套配置当前在用的节点。
  useEffect(() => {
    setSelectedId(currentNodeId);
    setPickerOpen(false);
    setProbe(null);
  }, [configId, currentNodeId]);

  useEffect(() => {
    if (!pickerOpen) return;
    const onMouseDown = (event: MouseEvent) => {
      if (detailRef.current && !detailRef.current.contains(event.target as Node)) {
        setPickerOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPickerOpen(false);
    };
    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [pickerOpen]);

  // 计时器每秒跳一次；连接时刻来自 runtime，不轮询快照。
  useEffect(() => {
    if (!connected) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [connected]);

  useEffect(() => {
    if (!connected) setProbe(null);
  }, [connected]);

  const selectedNode: NodeSummary | null =
    config?.nodes.find((node) => node.node_id === selectedId) ??
    config?.nodes.find((node) => node.node_id === config.current_node_id) ??
    config?.nodes[0] ??
    null;
  const selectedNodeId = selectedNode?.node_id ?? null;
  const canPick = (config?.nodes.length ?? 0) > 1;
  const switching = Boolean(
    selectedNode && config && selectedNode.node_id !== config.current_node_id,
  );

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

  const blocks =
    config && config.layout == null ? middleBlocks(runtime, config, aiReady) : [];

  const runProbe = async () => {
    if (!selectedNode || probe?.status === "testing") return;
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
  if (probe?.status === "testing") probeLabel = "检查中…";
  else if (probe?.status === "ok") {
    probeLabel = probe.latency === null ? "可达" : `延迟 ${probe.latency} ms`;
  } else if (probe?.status === "fail") {
    probeLabel = probe.unreachable ? "连不上" : "检查失败";
  }

  const zeroMode = zeroConfigMode(aiReady, justOnboarded, zeroConfigSettled);
  const zeroContent = zeroConfigContent(zeroMode);

  const showLedger = Boolean(config && hasNodes && !transitioning && level !== "failed");
  const showStrip = Boolean(connected && config && !isProxy(config));

  let hero: ReactNode;
  if (connected) {
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
        </div>
        <button type="button" className="btn btn--outline" onClick={onStop}>
          断开 VPN
        </button>
      </section>
    );
  } else {
    const word = stopping
      ? "正在断开"
      : transitioning
        ? "正在连接"
        : level === "failed"
          ? "连接失败"
          : "未连接";
    const led = stopping
      ? ""
      : transitioning
        ? "is-connecting"
        : level === "failed"
          ? "is-err"
          : null;
    const caption =
      level === "failed" ? failureHeadline(failedAfterConnected) : null;
    hero = (
      <section className="hero">
        <div className="hero__main">
          <h1 className="state-word">
            {led ? <span className={`led ${led}`} aria-hidden /> : null}
            <span>{word}</span>
          </h1>
          {caption ? <p className="hero__caption">{caption}</p> : null}
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
            disabled={!canConnect}
            onClick={onStart}
          >
            重新连接
          </button>
        ) : (
          <button
            type="button"
            className="btn btn--primary"
            disabled={!canConnect}
            onClick={onStart}
          >
            启动 VPN
          </button>
        )}
      </section>
    );
  }

  const srStatus = stopping
    ? "正在断开"
    : transitioning
      ? "正在连接"
      : level === "failed"
        ? "连接失败"
        : degraded
          ? "连接不稳定"
          : connected
            ? "已连接"
            : "未连接";

  return (
    <main className="console">
      <header className="console__head">
        <span className="console__crumb">控制台</span>
      </header>

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
                    <dt className="ledger__label">范围</dt>
                    <dd className="ledger__value ledger__value--text">
                      {scopeSummary(config).value}
                    </dd>
                    <dd className="ledger__sub">{scopeSummary(config).sub}</dd>
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

          <MiddleArea blocks={blocks} />

          {showStrip ? (
            <RateStrip samples={rateSamples} warn={degraded} current={rates} />
          ) : null}
        </div>

        {hasNodes && selectedNode ? (
            <footer className="node-card" ref={detailRef}>
              <div className="node-card__head">
                <div>
                  <span className="node-card__label">
                    {switching ? "选中的节点" : "当前节点"}
                  </span>
                  {canPick ? (
                    <button
                      type="button"
                      className="node-card__name node-card__name--button"
                      aria-haspopup="listbox"
                      aria-expanded={pickerOpen}
                      onClick={() => setPickerOpen((open) => !open)}
                    >
                      {selectedNode.name}
                    </button>
                  ) : (
                    <span className="node-card__name">{selectedNode.name}</span>
                  )}
                </div>
                <div className="node-card__actions">
                  {switching ? (
                    <button
                      type="button"
                      className="btn btn--ghost"
                      disabled={!nodeSwitchAvailable}
                      onClick={() => onSwitchNode(selectedNode.node_id)}
                    >
                      用这个节点
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="btn btn--ghost"
                    disabled={!canPick}
                    onClick={() => setPickerOpen((open) => !open)}
                  >
                    更换
                  </button>
                  {connected ? (
                    <button
                      type="button"
                      className="btn btn--ghost"
                      disabled={!nodeProbeAvailable || probe?.status === "testing"}
                      onClick={() => void runProbe()}
                    >
                      检查
                    </button>
                  ) : null}
                </div>
              </div>

              <div className="node-card__facts num">
                {selectedNode.server} : {selectedNode.port}
                <span className="sep">·</span>
                {selectedNode.method}
              </div>

              {probeLabel ? (
                <p
                  className={`node-card__probe ${
                    probe?.status === "ok" ? "is-ok" : probe?.status === "fail" ? "is-err" : ""
                  }`}
                  title={probe?.status === "fail" ? probe.message ?? undefined : undefined}
                >
                  {probeLabel}
                </p>
              ) : null}
              {switching ? (
                <p className="node-card__hint">
                  {nodeSwitchAvailable
                    ? "点「用这个节点」才会真正切换。"
                    : "这个版本还不能切换节点。"}
                </p>
              ) : null}

              {pickerOpen ? (
                <div className="node-picker" role="listbox" aria-label="这个配置里的节点">
                  {config.nodes.map((node) => (
                    <button
                      key={node.node_id}
                      type="button"
                      role="option"
                      aria-selected={node.node_id === selectedNodeId}
                      className={`node-picker__item ${
                        node.node_id === selectedNodeId ? "is-selected" : ""
                      }`}
                      onClick={() => {
                        setSelectedId(node.node_id);
                        setPickerOpen(false);
                        setProbe(null);
                      }}
                    >
                      <span className="node-picker__name">{node.name}</span>
                      {node.node_id === config.current_node_id ? (
                        <span className="node-picker__badge">当前</span>
                      ) : null}
                    </button>
                  ))}
                </div>
              ) : null}
            </footer>
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
