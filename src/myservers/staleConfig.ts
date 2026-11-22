import type { NodeListChangedPayload } from "../agent/protocol";

/** 周期同步发现「当前连接的节点」配置变了：两边的 id 都是本地节点 id（nd_…）。 */
export function staleConfigNodeId(
  payload: Pick<NodeListChangedPayload, "reason" | "changed_node_ids">,
  runtime: { state: string; node_id: string | null },
): string | null {
  if (payload.reason !== "node_synced") return null;
  if (runtime.state !== "running" && runtime.state !== "degraded") return null;
  if (runtime.node_id === null) return null;
  return payload.changed_node_ids.includes(runtime.node_id)
    ? runtime.node_id
    : null;
}
