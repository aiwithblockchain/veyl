import { useEffect, useRef, useState } from "react";
import type { ConfigDetail, NodeSummary, RuntimeView } from "../agent/protocol";
import type { ProbeResult, VpnConnectionState } from "../config/useVpnSession";
import {
  runZeroConfigPrimaryAction,
  zeroConfigActions,
  zeroConfigContent,
  zeroConfigMode,
} from "../ui/consoleActions";
import { formatDuration, formatSampleTime, formatTraffic } from "../ui/format";
import { consolePrimary, consoleStatus } from "../ui/status";

interface Props {
  config: ConfigDetail | null;
  connection: VpnConnectionState;
  onStart: () => void;
  onStop: () => void;
  onSwitchNode: (nodeId: string) => void;
  onProbe: (nodeId: string) => Promise<ProbeResult>;
  nodeSwitchAvailable: boolean;
  nodeProbeAvailable: boolean;
  panelOpen: boolean;
  aiUnread: boolean;
  onTogglePanel: () => void;
  aiReady: boolean;
  justOnboarded: boolean;
  zeroConfigSettled: boolean;
  hasConfigs: boolean;
  onAskAi: () => void;
  onNewConfig: () => void;
  loading?: boolean;
  runtime: RuntimeView;
}

type Probe =
  | { nodeId: string; status: "testing" }
  | { nodeId: string; status: "ok"; latency: number | null }
  | { nodeId: string; status: "fail"; message: string | null; unreachable: boolean };

async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // 落到下面的 textarea 方案。
  }
  try {
    const el = document.createElement("textarea");
    el.value = text;
    el.style.position = "fixed";
    el.style.opacity = "0";
    document.body.appendChild(el);
    el.select();
    const ok = document.execCommand("copy");
    el.remove();
    return ok;
  } catch {
    return false;
  }
}

export function Console({
  config,
  connection,
  onStart,
  onStop,
  onSwitchNode,
  onProbe,
  nodeSwitchAvailable,
  nodeProbeAvailable,
  panelOpen,
  aiUnread,
  onTogglePanel,
  aiReady,
  justOnboarded,
  zeroConfigSettled,
  hasConfigs,
  onAskAi,
  onNewConfig,
  loading = false,
  runtime,
}: Props) {
  const [selectedId, setSelectedId] = useState<string | null>(
    config?.current_node_id ?? null,
  );
  const [pickerOpen, setPickerOpen] = useState(false);
  const [probe, setProbe] = useState<Probe | null>(null);
  const [exitCopy, setExitCopy] = useState<"idle" | "copied" | "failed">("idle");
  const [techCopy, setTechCopy] = useState<"idle" | "copied" | "failed">("idle");
  const [now, setNow] = useState(() => Date.now());
  const copyTimer = useRef<number | null>(null);
  const techCopyTimer = useRef<number | null>(null);
  const detailRef = useRef<HTMLDivElement>(null);
  const configId = config?.config_id ?? null;
  const currentNodeId = config?.current_node_id ?? null;
  const exitAddress = runtime.health.exit_ip?.trim() || null;
  const proxyAddress = runtime.mixed_port ? `127.0.0.1:${runtime.mixed_port}` : null;

  useEffect(() => {
    setExitCopy("idle");
  }, [exitAddress, connection]);

  useEffect(() => {
    setTechCopy("idle");
  }, [proxyAddress]);

  useEffect(
    () => () => {
      if (copyTimer.current !== null) window.clearTimeout(copyTimer.current);
      if (techCopyTimer.current !== null) window.clearTimeout(techCopyTimer.current);
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

  const selectedNode: NodeSummary | null =
    config?.nodes.find((node) => node.node_id === selectedId) ?? null;
  const currentNode: NodeSummary | null =
    config?.nodes.find((node) => node.node_id === config.current_node_id) ?? null;
  const canPick = (config?.nodes.length ?? 0) > 1;
  const switching = Boolean(
    selectedNode && config && selectedNode.node_id !== config.current_node_id,
  );
  const busy = connection === "starting" || connection === "stopping";

  const selectNode = (nodeId: string) => {
    setSelectedId(nodeId);
    setPickerOpen(false);
    setProbe(null);
  };

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

  const canConnect = Boolean(config && config.nodes.length > 0);
  const connected = connection === "connected";

  // 时长只在前端按 30 秒粒度刷新；连接时刻来自 runtime，不轮询快照。
  useEffect(() => {
    if (!connected) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, [connected]);

  const connectedAt = runtime.connected_since
    ? Date.parse(runtime.connected_since)
    : NaN;
  const durationSeconds = Number.isFinite(connectedAt)
    ? Math.max(0, Math.floor((now - connectedAt) / 1000))
    : null;
  const durationLabel =
    durationSeconds === null ? "刚刚" : formatDuration(durationSeconds);
  const usedBytes = runtime.traffic
    ? runtime.traffic.up_bytes + runtime.traffic.down_bytes
    : null;
  const trafficLabel = usedBytes === null ? "—" : formatTraffic(usedBytes);
  const latencyLabel =
    runtime.latency_ms === null ? "确认中…" : `${runtime.latency_ms} 毫秒`;
  const currentLineName = currentNode?.name ?? runtime.node_name ?? "当前节点";
  const currentLineText = connected
    ? [currentLineName, durationLabel, trafficLabel === "—" ? null : trafficLabel]
        .filter(Boolean)
        .join(" · ")
    : `${currentLineName} · 未连接`;
  const sampleTime = formatSampleTime(
    runtime.traffic?.sampled_at ?? runtime.health.checked_at,
  );

  const copyExit = async () => {
    if (!exitAddress) return;
    const ok = await copyText(exitAddress);
    setExitCopy(ok ? "copied" : "failed");
    if (copyTimer.current !== null) window.clearTimeout(copyTimer.current);
    copyTimer.current = window.setTimeout(() => setExitCopy("idle"), 2000);
  };

  const copyProxy = async () => {
    if (!proxyAddress) return;
    const ok = await copyText(proxyAddress);
    setTechCopy(ok ? "copied" : "failed");
    if (techCopyTimer.current !== null) window.clearTimeout(techCopyTimer.current);
    techCopyTimer.current = window.setTimeout(() => setTechCopy("idle"), 2000);
  };

  useEffect(() => {
    if (!connected) setProbe(null);
  }, [connected]);

  const primary = consolePrimary(connection, canConnect);
  const status = loading
    ? { text: "正在读取配置…", tone: "muted" as const }
    : consoleStatus(connection, Boolean(config), canConnect);

  let probeLabel: string | null = null;
  if (probe?.status === "testing") probeLabel = "检查中…";
  else if (probe?.status === "ok") {
    probeLabel = probe.latency === null ? "可达" : `延迟 ${probe.latency} 毫秒`;
  } else if (probe?.status === "fail") {
    probeLabel = probe.unreachable ? "连不上" : "检查失败";
  }

  let probeHint: string | null = null;
  if (!nodeProbeAvailable) probeHint = "这个版本还不能检查";
  else if (!connected) probeHint = "连接后可以检查";
  const probeText = nodeProbeAvailable && connected ? probeLabel : probeHint;

  const zeroMode = zeroConfigMode(aiReady, justOnboarded, zeroConfigSettled);
  const zeroContent = zeroConfigContent(zeroMode);
  const zeroActions = zeroConfigActions(zeroMode);

  return (
    <main className="console">
      <header className="console-top">
        <div className="console-top__bar">
          <button
            type="button"
            className="btn btn--primary console-top__primary"
            disabled={primary.disabled}
            onClick={primary.stop ? onStop : onStart}
          >
            {primary.label}
          </button>
          <div className={`console-status is-${status.tone}`} role="status">
            <span className="console-status__dot" aria-hidden />
            <span className="console-status__text">{status.text}</span>
          </div>
          <button
            type="button"
            className={`console-panel-toggle ${panelOpen ? "is-active" : ""}`}
            onClick={onTogglePanel}
            aria-label={
              panelOpen
                ? "收起 AI 对话"
                : aiUnread
                  ? "展开 AI 对话，有新消息"
                  : "展开 AI 对话"
            }
            aria-expanded={panelOpen}
            title="AI 对话"
          >
            <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden>
              <path
                d="M4 4.5A1.5 1.5 0 0 1 5.5 3h9A1.5 1.5 0 0 1 16 4.5v6a1.5 1.5 0 0 1-1.5 1.5H9l-3 2.5V12H5.5A1.5 1.5 0 0 1 4 10.5z"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinejoin="round"
              />
            </svg>
            {aiUnread && !panelOpen ? (
              <span className="console-panel-toggle__dot" aria-hidden />
            ) : null}
          </button>
        </div>

        {connected ? (
          <div className="console-summary">
            <span className="console-summary__item">{durationLabel}</span>
            <span className="console-summary__sep" aria-hidden>
              ·
            </span>
            <span className="console-summary__item">已用 {trafficLabel}</span>
            <span className="console-summary__sep" aria-hidden>
              ·
            </span>
            <span className="console-summary__item">
              {runtime.latency_ms === null ? "延迟确认中…" : `延迟 ${latencyLabel}`}
            </span>
            <span className="console-summary__sep" aria-hidden>
              ·
            </span>
            {exitAddress ? (
              <button
                type="button"
                className={`console-exit ${
                  exitCopy === "copied" ? "is-copied" : exitCopy === "failed" ? "is-failed" : ""
                }`}
                onClick={() => void copyExit()}
                title={`出口 ${exitAddress}，点击复制`}
                aria-label={`出口 ${exitAddress}，点击复制`}
              >
                <span className="console-exit__label">出口</span>
                <span className="console-exit__ip num" title={exitAddress}>
                  {exitAddress}
                </span>
                <span className="console-exit__action" aria-live="polite">
                  {exitCopy === "copied" ? "已复制" : exitCopy === "failed" ? "复制失败" : "复制"}
                </span>
              </button>
            ) : (
              <span className="console-summary__item">正在确认出口…</span>
            )}
          </div>
        ) : null}
      </header>

      <section className="console-mid">
        {!loading && !hasConfigs ? (
          <div className="console-empty-entry">
            <p className="console-empty-entry__title">{zeroContent.title}</p>
            {zeroContent.steps ? (
              <ol className="console-empty-entry__steps">
                {zeroContent.steps.map((step) => (
                  <li key={step}>{step}</li>
                ))}
              </ol>
            ) : zeroContent.body ? (
              <p className="console-empty-entry__text">{zeroContent.body}</p>
            ) : null}
            <div className="console-empty-entry__actions">
              {zeroActions.includes("ask-ai") ? (
                <button
                  type="button"
                  className="btn btn--primary console-empty-entry__primary"
                  onClick={() =>
                    runZeroConfigPrimaryAction(zeroMode, { onAskAi, onNewConfig })
                  }
                >
                  {zeroContent.primaryLabel ?? "让 AI 帮我配"}
                </button>
              ) : null}
              {zeroActions.includes("new-config") ? (
                zeroMode === "manual" ? (
                  <button
                    type="button"
                    className="btn btn--primary console-empty-entry__primary"
                    onClick={() =>
                      runZeroConfigPrimaryAction(zeroMode, { onAskAi, onNewConfig })
                    }
                  >
                    {zeroContent.primaryLabel ?? "我自己配置"}
                  </button>
                ) : (
                  <button type="button" className="btn btn--ghost" onClick={onNewConfig}>
                    我自己配置
                  </button>
                )
              ) : null}
            </div>
          </div>
        ) : null}
      </section>

      <footer className="console-node">
        {loading ? (
          <div
            className="console-node__skeleton"
            role="status"
            aria-busy="true"
            aria-label="正在读取配置"
          >
            <span className="skeleton skeleton--node" aria-hidden />
            <div className="console-node__skeleton-facts" aria-hidden>
              <span className="skeleton skeleton--fact" />
              <span className="skeleton skeleton--fact" />
            </div>
            <div className="console-node__skeleton-actions" aria-hidden>
              <span className="skeleton skeleton--button" />
              <span className="skeleton skeleton--button" />
            </div>
            <span className="skeleton skeleton--detail" aria-hidden />
          </div>
        ) : !hasConfigs ? null : !config ? (
          <p className="console-node__empty">在左侧选一套配置。</p>
        ) : !selectedNode ? (
          <p className="console-node__empty">这套配置还没有节点。</p>
        ) : (
          <div className="console-node__detail" ref={detailRef}>
            <div className="console-node__heading">
              {canPick ? (
                <button
                  type="button"
                  className="console-node__name"
                  aria-haspopup="listbox"
                  aria-expanded={pickerOpen}
                  onClick={() => setPickerOpen((open) => !open)}
                >
                  {selectedNode.name}
                  <svg
                    className={`console-node__chevron ${pickerOpen ? "is-open" : ""}`}
                    viewBox="0 0 12 12"
                    width="12"
                    height="12"
                    aria-hidden
                  >
                    <path
                      d="M3 4.5 6 7.5 9 4.5"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.4"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </button>
              ) : (
                <span className="console-node__name is-static">{selectedNode.name}</span>
              )}
              {selectedNode.node_id === config.current_node_id ? (
                <span className="console-node__badge">当前使用</span>
              ) : null}
            </div>

            {pickerOpen ? (
              <div className="node-picker" role="listbox" aria-label="这个配置里的节点">
                {config.nodes.map((node) => (
                  <button
                    key={node.node_id}
                    type="button"
                    role="option"
                    aria-selected={node.node_id === selectedId}
                    className={`node-picker__item ${
                      node.node_id === selectedId ? "is-selected" : ""
                    }`}
                    onClick={() => selectNode(node.node_id)}
                  >
                    <span className="node-picker__name">{node.name}</span>
                    {node.node_id === config.current_node_id ? (
                      <span className="node-picker__badge">当前</span>
                    ) : null}
                  </button>
                ))}
              </div>
            ) : null}

            {selectedNode.node_id === config.current_node_id ? (
              connected ? (
                <dl className="console-node__stats">
                  <div>
                    <dt>已用流量</dt>
                    <dd className="num">{trafficLabel}</dd>
                  </div>
                  <div>
                    <dt>延迟</dt>
                    <dd className="num">{latencyLabel}</dd>
                  </div>
                </dl>
              ) : (
                <p className="console-node__offline">未连接</p>
              )
            ) : (
              <p className="console-node__current">
                当前线路：<strong>{currentLineText}</strong>
              </p>
            )}

            <div className="console-node__actions">
              <button
                type="button"
                className="btn btn--ghost"
                disabled={!switching || busy || !nodeSwitchAvailable}
                onClick={() => onSwitchNode(selectedNode.node_id)}
              >
                用这个节点
              </button>
              <button
                type="button"
                className="btn btn--ghost"
                disabled={
                  !connected || !nodeProbeAvailable || probe?.status === "testing"
                }
                onClick={() => void runProbe()}
              >
                检查连接
              </button>
              {probeText ? (
                <span
                  className={`console-node__probe ${
                    nodeProbeAvailable && probe?.status === "ok"
                      ? "is-ok"
                      : nodeProbeAvailable && probe?.status === "fail"
                        ? "is-err"
                        : ""
                  }`}
                  title={
                    nodeProbeAvailable && probe?.status === "fail"
                      ? probe.message ?? undefined
                      : undefined
                  }
                >
                  {probeText}
                </span>
              ) : null}
            </div>

            {switching ? (
              <p className="console-node__hint">
                {nodeSwitchAvailable
                  ? "点上面的按钮才会真正切换。"
                  : "这个版本还不能切换节点。"}
              </p>
            ) : null}

            <details className="console-node__tech">
              <summary>技术详情</summary>
              <dl className="console-node__facts">
                <div>
                  <dt>服务器地址</dt>
                  <dd className="num">{selectedNode.server}</dd>
                </div>
                <div>
                  <dt>服务器端口</dt>
                  <dd className="num">{selectedNode.port}</dd>
                </div>
                <div>
                  <dt>加密方式</dt>
                  <dd className="num">{selectedNode.method}</dd>
                </div>
                <div>
                  <dt>本机代理地址</dt>
                  <dd className="console-node__copy-row">
                    <span className="num">{proxyAddress ?? "—"}</span>
                    {proxyAddress ? (
                      <button
                        type="button"
                        className="console-node__copy"
                        onClick={() => void copyProxy()}
                      >
                        {techCopy === "copied"
                          ? "已复制"
                          : techCopy === "failed"
                            ? "复制失败"
                            : "复制"}
                      </button>
                    ) : null}
                  </dd>
                </div>
                <div>
                  <dt>活跃连接数</dt>
                  <dd className="num">{runtime.connections ?? "—"}</dd>
                </div>
                <div>
                  <dt>直连 IP</dt>
                  <dd className="num">{runtime.direct_ip ?? "—"}</dd>
                </div>
                <div>
                  <dt>最近采样时间</dt>
                  <dd className="num">{sampleTime}</dd>
                </div>
              </dl>
            </details>
          </div>
        )}
      </footer>
    </main>
  );
}
