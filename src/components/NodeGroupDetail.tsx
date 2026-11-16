import { useEffect, useState } from "react";
import type { GroupNode, NodeGroup } from "../groups/mockGroups";

interface Props {
  group: NodeGroup;
  active: boolean;
}

const PROTOCOL_LABEL: Record<GroupNode["protocol"], string> = {
  ss: "SS",
  vmess: "VMess",
  trojan: "Trojan",
};

function latencyText(node: GroupNode): string {
  return node.latency_ms === null ? "这次测不通" : `${node.latency_ms} ms`;
}

/** 节点组详情：只读展示。节点组后端尚未接入，这里不提供任何本地写入口。 */
export function NodeGroupDetail({ group, active }: Props) {
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    setExpanded(null);
  }, [group.group_id]);

  return (
    <div className="group-detail">
      <header className="group-detail__head">
        <div className="group-detail__title-row">
          <h3 className="group-detail__name">{group.name}</h3>
          {active ? <span className="group-detail__badge">当前节点组</span> : null}
        </div>
        <p className="group-detail__lead">
          {group.read_only ? "由 Veyl 维护，不能修改 · " : ""}
          {group.nodes.length} 个节点
        </p>
      </header>

      {group.nodes.length === 0 ? (
        <section className="group-detail__empty">
          <p className="group-detail__empty-title">这个组还没有节点</p>
          <p className="group-detail__empty-text">
            节点组尚未接入，暂时只能查看。
          </p>
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
                </div>
                {expanded === node.node_id && node.latency_ms === null ? (
                  <div className="group-node__explain" role="note">
                    <p>这个节点连不上。</p>
                    <p>可能节点已经下线，或本地网络挡住了连接。</p>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
          <p className="group-detail__hint">节点组尚未接入，暂时只能查看。</p>
        </>
      )}
    </div>
  );
}
