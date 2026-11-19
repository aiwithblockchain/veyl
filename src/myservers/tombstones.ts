import type { MyServer } from "../agent/bridge";

/**
 * 停机删除的墓碑行：到期前扣费失败，后端停机销毁了机器，但行还留着等用户自己删。
 * 这种行不提供续费 / 恢复，只能删。
 */
export function isTombstone(server: Pick<MyServer, "state">): boolean {
  return server.state === "destroyed";
}

/**
 * 悬挂节点：配置里还挂着、但它对应的服务器已经停机删除的节点。
 *
 * 只认 `local_node_id`：控制面 `node_id` 不是本地节点行的 id。
 * 首次签发时两者同值，控制面重签发后才可能不同，所以不能拿 `node_id` 兜底。
 */
export function collectDanglingNodeIds(
  servers: readonly MyServer[],
  nodeIds: Iterable<string>,
): Set<string> {
  const dead = new Set<string>();
  for (const server of servers) {
    if (!isTombstone(server)) continue;
    if (server.local_node_id) dead.add(server.local_node_id);
  }
  const dangling = new Set<string>();
  for (const nodeId of nodeIds) {
    if (dead.has(nodeId)) dangling.add(nodeId);
  }
  return dangling;
}
