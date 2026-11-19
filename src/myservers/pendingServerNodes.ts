import type { MyServer } from "../agent/bridge";

/** 服务器已就绪、节点还没进当前配置：连接页灰显一行，重新连接后才可用。 */
export interface PendingServerNode {
  /** 与配置节点同一个 id 空间：本地节点行 id 优先，没有时退回控制面 id。 */
  nodeId: string;
  name: string;
}

/**
 * 待接入的服务器节点。
 * 判据与入池一致：本地节点行 id 优先、退回控制面 id；两个 id 任一已在配置里都排除。
 * 这样 attach 完成后同一节点只剩正常行，不会既可选又灰显一份。
 */
export function collectPendingServerNodes(
  servers: readonly MyServer[],
  configuredNodeIds: ReadonlySet<string>,
): PendingServerNode[] {
  const seen = new Set<string>();
  const pending: PendingServerNode[] = [];
  for (const server of servers) {
    if (server.state !== "active" && server.state !== "healthy") continue;
    const nodeId = server.local_node_id ?? server.node_id;
    if (!nodeId || seen.has(nodeId)) continue;
    if (configuredNodeIds.has(nodeId)) continue;
    if (server.node_id !== null && configuredNodeIds.has(server.node_id)) continue;
    seen.add(nodeId);
    pending.push({ nodeId, name: server.name });
  }
  return pending;
}
