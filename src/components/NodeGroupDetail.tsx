import { useEffect, useState } from "react";
import type { GroupNode, NodeGroup } from "../groups/mockGroups";

interface Props {
  groupName: string;
  onClose: () => void;
  onPickServers: () => void;
  onAddDemo: (source: "manual" | "paste" | "subscribe") => void;
}

const SOURCES: Array<{
  key: "servers" | "paste" | "manual";
  title: string;
  lead: string;
}> = [
  {
    key: "servers",
    title: "从我的服务器添加",
    lead: "买一台已经装好的机器，节点自动进来。",
  },
  {
    key: "paste",
    title: "粘贴或订阅",
    lead: "粘贴节点链接，或填一个订阅地址。",
  },
  {
    key: "manual",
    title: "手动填写",
    lead: "自己填地址、端口和密码。",
  },
];

export function AddNodeDialog({ groupName, onClose, onPickServers, onAddDemo }: Props) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div
        className="modal add-node"
        role="dialog"
        aria-modal="true"
        aria-labelledby="add-node-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="modal__head">
          <h2 id="add-node-title" className="modal__title">
            添加节点到「{groupName}」
          </h2>
          <button
            type="button"
            className="modal__close"
            onClick={onClose}
            aria-label="关闭"
          >
            ×
          </button>
        </header>
        <p className="add-node__lead">
          节点会进到这个组里，之后由这个组被激活。
        </p>
        <p className="add-node__demo">演示数据：点一个来源会加入一个示例节点。</p>
        <div className="add-node__sources">
          {SOURCES.map((source) => (
            <button
              key={source.key}
              type="button"
              className="add-node__source"
              onClick={() => {
                if (source.key === "servers") onPickServers();
                else onAddDemo(source.key === "paste" ? "paste" : "manual");
                onClose();
              }}
            >
              <span className="add-node__source-title">{source.title}</span>
              <span className="add-node__source-lead">{source.lead}</span>
            </button>
          ))}
        </div>
        <div className="add-node__actions">
          <button type="button" className="btn btn--ghost" onClick={onClose}>
            取消
          </button>
        </div>
      </div>
    </div>
  );
}

interface DetailProps {
  group: NodeGroup;
  active: boolean;
  activeConfigName: string | null;
  connection: "idle" | "starting" | "connected" | "stopping";
  onActivate: () => void;
  onAddNode: (source: "manual" | "paste" | "subscribe") => void;
  onCopy: () => void;
  onOpenServers: () => void;
  onRemoveNode: (nodeId: string) => void;
  onRename: (name: string) => void;
  onDelete: () => void;
}

const PROTOCOL_LABEL: Record<GroupNode["protocol"], string> = {
  ss: "SS",
  vmess: "VMess",
  trojan: "Trojan",
};

function latencyText(node: GroupNode): string {
  return node.latency_ms === null ? "这次测不通" : `${node.latency_ms} ms`;
}

export function NodeGroupDetail({
  group,
  active,
  activeConfigName,
  connection,
  onActivate,
  onAddNode,
  onCopy,
  onOpenServers,
  onRemoveNode,
  onRename,
  onDelete,
}: DetailProps) {
  const [addOpen, setAddOpen] = useState(false);
  const [testing, setTesting] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(group.name);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  useEffect(() => {
    setRenaming(false);
    setConfirmingDelete(false);
    setExpanded(null);
    setDraft(group.name);
  }, [group.group_id, group.name]);

  useEffect(() => {
    if (!testing) return;
    const timer = window.setTimeout(() => setTesting(false), 700);
    return () => window.clearTimeout(timer);
  }, [testing]);

  const busyConnection = connection === "starting" || connection === "stopping";
  const allUnreachable =
    group.nodes.length > 0 && group.nodes.every((node) => node.latency_ms === null);
  /** 这个组目前能不能被激活：自建、有节点、不是当前组。 */
  const activationRow = !active && !group.read_only && group.nodes.length > 0;
  const showPrimary = activationRow && Boolean(activeConfigName);

  return (
    <div className="group-detail">
      <header className="group-detail__head">
        <div className="group-detail__title-row">
          {renaming ? (
            <input
              className="group-detail__rename"
              value={draft}
              maxLength={40}
              aria-label="组名称"
              autoFocus
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  onRename(draft);
                  setRenaming(false);
                } else if (event.key === "Escape") {
                  setDraft(group.name);
                  setRenaming(false);
                }
              }}
            />
          ) : (
            <h3 className="group-detail__name">{group.name}</h3>
          )}
          {active ? <span className="group-detail__badge">当前节点组</span> : null}
          {!group.read_only && !renaming ? (
            <button
              type="button"
              className="group-detail__text-action"
              onClick={() => {
                setDraft(group.name);
                setRenaming(true);
              }}
            >
              改名
            </button>
          ) : null}
        </div>
        <p className="group-detail__lead">
          {group.read_only ? "由 Veyl 维护，不能修改 · " : ""}
          {group.nodes.length} 个节点
        </p>
      </header>

      {allUnreachable ? (
        <div className="group-detail__notice" role="status">
          <span>这个组的节点都连不上。换一组，或到组里重新测试。</span>
          <button type="button" className="btn btn--ghost" onClick={() => setTesting(true)}>
            测试全部
          </button>
        </div>
      ) : null}

      {group.nodes.length === 0 ? (
        <section className="group-detail__empty">
          <p className="group-detail__empty-title">这个组还没有节点</p>
          <p className="group-detail__empty-text">
            添加一个节点后，就能把它设为当前节点组。
          </p>
          <button type="button" className="btn btn--primary" onClick={() => setAddOpen(true)}>
            添加节点
          </button>
        </section>
      ) : (
        <>
          <ul className="group-nodes">
            {group.nodes.map((node) => (
              <li key={node.node_id}>
                <div className="group-node">
                  <button
                    type="button"
                    className="group-node__main"
                    aria-expanded={expanded === node.node_id}
                    onClick={() =>
                      setExpanded((current) =>
                        current === node.node_id ? null : node.node_id,
                      )
                    }
                  >
                    <span
                      className={`led is-${node.latency_ms === null ? "warn" : "ok"}`}
                      aria-hidden
                    />
                    <span className="group-node__name">{node.name}</span>
                    <span className="group-node__addr num">
                      {node.server}:{node.port}
                    </span>
                    <span className="group-node__protocol">
                      {PROTOCOL_LABEL[node.protocol]}
                    </span>
                    <span
                      className={`group-node__latency num ${
                        node.latency_ms === null ? "is-warn" : ""
                      }`}
                    >
                      {latencyText(node)}
                    </span>
                  </button>
                  {!group.read_only ? (
                    <button
                      type="button"
                      className="group-node__remove"
                      onClick={() => onRemoveNode(node.node_id)}
                    >
                      移除
                    </button>
                  ) : null}
                </div>
                {expanded === node.node_id && node.latency_ms === null ? (
                  <div className="group-node__explain" role="note">
                    <p>这个节点连不上。</p>
                    <p>可能节点已经下线，或本地网络挡住了连接。</p>
                    <p>先点「测试连通」；还是不行，换一个节点。</p>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
          {group.nodes.length === 1 ? (
            <p className="group-detail__hint">组里只有一个节点，连不上时没有别的可换。</p>
          ) : null}
        </>
      )}

      <div className="group-detail__foot">
        {activationRow ? (
          <p className="group-detail__context">
            {activeConfigName ? `将用于「${activeConfigName}」` : "先创建一套配置"}
          </p>
        ) : null}
        <div className="group-detail__actions">
          {group.read_only ? (
            <button type="button" className="btn btn--ghost" onClick={onCopy}>
              复制为我的组
            </button>
          ) : group.nodes.length > 0 ? (
            <button
              type="button"
              className="btn btn--ghost"
              onClick={() => setAddOpen(true)}
            >
              添加节点
            </button>
          ) : null}
          <button
            type="button"
            className="btn btn--ghost"
            disabled={testing}
            onClick={() => setTesting(true)}
          >
            {testing ? "正在测试…" : "测试全部"}
          </button>
          {showPrimary ? (
            <button
              type="button"
              className="btn btn--primary"
              disabled={!activeConfigName || busyConnection}
              onClick={onActivate}
            >
              设为当前节点组
            </button>
          ) : null}
        </div>
        {busyConnection && showPrimary ? (
          <p className="group-detail__hint">正在连接，等这次连完再改。</p>
        ) : null}
        {!group.read_only ? (
          <div className="group-detail__danger">
            {confirmingDelete ? (
              <div className="group-detail__confirm" role="alert">
                <p>删除后组里的节点不会保留。</p>
                <div className="group-detail__actions">
                  <button
                    type="button"
                    className="btn btn--ghost"
                    onClick={() => setConfirmingDelete(false)}
                  >
                    取消
                  </button>
                  <button type="button" className="btn btn--danger-ghost" onClick={onDelete}>
                    确认删除
                  </button>
                </div>
              </div>
            ) : (
              <button
                type="button"
                className="btn btn--danger-ghost"
                onClick={() => setConfirmingDelete(true)}
              >
                删除组
              </button>
            )}
          </div>
        ) : null}
      </div>

      {addOpen ? (
        <AddNodeDialog
          groupName={group.name}
          onClose={() => setAddOpen(false)}
          onPickServers={onOpenServers}
          onAddDemo={(source) => onAddNode(source)}
        />
      ) : null}
    </div>
  );
}
