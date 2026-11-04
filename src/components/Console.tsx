import { useEffect, useRef, useState } from "react";
import type { ConfigDetail, NodeSummary } from "../agent/protocol";
import type { ProbeResult, VpnConnectionState } from "../config/useVpnSession";
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
  loading?: boolean;
}

type Probe =
  | { nodeId: string; status: "testing" }
  | { nodeId: string; status: "ok"; latency: number | null }
  | { nodeId: string; status: "fail"; message: string | null; unreachable: boolean };

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
  loading = false,
}: Props) {
  const [selectedId, setSelectedId] = useState<string | null>(
    config?.current_node_id ?? null,
  );
  const [pickerOpen, setPickerOpen] = useState(false);
  const [probe, setProbe] = useState<Probe | null>(null);
  const detailRef = useRef<HTMLDivElement>(null);
  const configId = config?.config_id ?? null;
  const currentNodeId = config?.current_node_id ?? null;

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

  useEffect(() => {
    if (!connected) setProbe(null);
  }, [connected]);

  const primary = consolePrimary(connection, canConnect);
  const status = loading
    ? { text: "正在读取配置…", tone: "muted" as const }
    : consoleStatus(connection, Boolean(config), canConnect);

  let probeLabel: string | null = null;
  if (probe?.status === "testing") probeLabel = "测试中…";
  else if (probe?.status === "ok") {
    probeLabel = probe.latency === null ? "可达" : `延迟 ${probe.latency}ms`;
  } else if (probe?.status === "fail") {
    probeLabel = probe.unreachable ? "连不上" : "测试失败";
  }

  let probeHint: string | null = null;
  if (!nodeProbeAvailable) probeHint = "这个版本还不能测试";
  else if (!connected) probeHint = "连接后可以测试";
  const probeText = nodeProbeAvailable && connected ? probeLabel : probeHint;

  return (
    <main className="console">
      <header className="console-top">
        <button
          type="button"
          className="btn btn--primary console-top__primary"
          disabled={primary.disabled}
          onClick={primary.stop ? onStop : onStart}
        >
          {primary.label}
        </button>
        <div className="console-top__right">
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
      </header>

      <section className="console-mid">
        <div className="console-mid__hint">
          <p className="console-mid__title">没有需要你决定的事</p>
          <p className="console-mid__text">
            连接在上面，节点在下面。要调整的话，在右侧告诉助手。
          </p>
        </div>
      </section>

      <footer className="console-node">
        {loading ? (
          <p className="console-node__empty">正在读取配置…</p>
        ) : !config ? (
          <p className="console-node__empty">在左侧新建一套配置后，这里会显示节点。</p>
        ) : !selectedNode ? (
          <p className="console-node__empty">这套配置还没有节点。</p>
        ) : (
          <>
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
                    <span
                      className={`console-node__chevron ${pickerOpen ? "is-open" : ""}`}
                      aria-hidden
                    >
                      ⌄
                    </span>
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
                      <span className="node-picker__meta num">
                        {node.server}:{node.port}
                      </span>
                      {node.node_id === config.current_node_id ? (
                        <span className="node-picker__badge">当前</span>
                      ) : null}
                    </button>
                  ))}
                </div>
              ) : null}

              <dl className="console-node__facts">
                <div>
                  <dt>地址</dt>
                  <dd className="num">{selectedNode.server}</dd>
                </div>
                <div>
                  <dt>端口</dt>
                  <dd className="num">{selectedNode.port}</dd>
                </div>
                <div>
                  <dt>加密方式</dt>
                  <dd className="num">{selectedNode.method}</dd>
                </div>
              </dl>
            </div>

            <div className="console-node__actions">
              <button
                type="button"
                className="btn btn--ghost"
                disabled={!switching || busy || !nodeSwitchAvailable}
                onClick={() => onSwitchNode(selectedNode.node_id)}
              >
                切换到此节点
              </button>
              <button
                type="button"
                className="btn btn--ghost"
                disabled={
                  !connected || !nodeProbeAvailable || probe?.status === "testing"
                }
                onClick={() => void runProbe()}
              >
                测试连通
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
                  ? "选中只会改这里的详情；按「切换到此节点」才会真正切换。"
                  : "这个版本还不能切换节点。"}
              </p>
            ) : null}
          </>
        )}
      </footer>
    </main>
  );
}
