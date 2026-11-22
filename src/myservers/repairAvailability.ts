import type { ConfigDetail } from "../agent/protocol";

/**
 * 详情页「智能修复」只对「最近一次探测不可达」的节点显示。
 * 节点不在当前配置里、或正在测速时都算拿不到状态，不显示。
 */
export function repairAvailableFor(
  localNodeId: string | null,
  config: Pick<ConfigDetail, "nodes"> | null,
  results: Record<string, { reachable: boolean | null } | undefined>,
  probing: ReadonlySet<string>,
): boolean {
  if (localNodeId === null || config === null) return false;
  if (!config.nodes.some((node) => node.node_id === localNodeId)) return false;
  if (probing.has(localNodeId)) return false;
  return results[localNodeId]?.reachable === false;
}
