import { useCallback, useState } from "react";
import type { GroupNode, NodeGroup } from "./mockGroups";
import {
  demoNode,
  persistGroups,
  readActiveGroupId,
  readGroups,
} from "./mockGroups";

/** 节点组：界面 + 本地 mock，没有后端持久化。 */
export function useNodeGroups() {
  const [groups, setGroups] = useState<NodeGroup[]>(() => readGroups());
  const [activeGroupId, setActiveGroupId] = useState(() => readActiveGroupId());
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const commit = useCallback((next: NodeGroup[], nextActive: string) => {
    setGroups(next);
    setActiveGroupId(nextActive);
    persistGroups(next, nextActive);
  }, []);

  const selected =
    groups.find((group) => group.group_id === selectedId) ??
    groups.find((group) => group.group_id === activeGroupId) ??
    groups[0] ??
    null;

  const select = (groupId: string) => setSelectedId(groupId);

  /** 回根：回到当前节点组。 */
  const resetToRoot = () => setSelectedId(null);

  const createGroup = () => {
    const used = new Set(groups.map((group) => group.name));
    let index = 1;
    while (used.has(`新组 ${index}`)) index += 1;
    const group: NodeGroup = {
      group_id: `grp_${Date.now()}`,
      name: `新组 ${index}`,
      read_only: false,
      nodes: [],
    };
    commit([...groups, group], activeGroupId);
    setSelectedId(group.group_id);
  };

  const copyGroup = (groupId: string) => {
    const source = groups.find((group) => group.group_id === groupId);
    if (!source) return;
    const group: NodeGroup = {
      group_id: `grp_${Date.now()}`,
      name: `${source.name} 副本`,
      read_only: false,
      nodes: source.nodes.map((item) => ({
        ...item,
        node_id: `${item.node_id}_copy_${Date.now()}`,
      })),
    };
    commit([...groups, group], activeGroupId);
    setSelectedId(group.group_id);
  };

  const renameGroup = (groupId: string, name: string) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    commit(
      groups.map((group) =>
        group.group_id === groupId ? { ...group, name: trimmed } : group,
      ),
      activeGroupId,
    );
  };

  const deleteGroup = (groupId: string) => {
    const target = groups.find((group) => group.group_id === groupId);
    if (!target || target.read_only) return;
    const next = groups.filter((group) => group.group_id !== groupId);
    if (next.length === 0) return;
    const nextActive = activeGroupId === groupId ? next[0].group_id : activeGroupId;
    commit(next, nextActive);
    setSelectedId(null);
  };

  const addNode = (groupId: string, source: "manual" | "paste" | "subscribe") => {
    const group = groups.find((item) => item.group_id === groupId);
    if (!group || group.read_only) return;
    const node: GroupNode = demoNode(source, group.nodes.length + 1);
    commit(
      groups.map((item) =>
        item.group_id === groupId
          ? { ...item, nodes: [...item.nodes, node] }
          : item,
      ),
      activeGroupId,
    );
  };

  const removeNode = (groupId: string, nodeId: string) => {
    const group = groups.find((item) => item.group_id === groupId);
    if (!group || group.read_only) return;
    commit(
      groups.map((item) =>
        item.group_id === groupId
          ? {
              ...item,
              nodes: item.nodes.filter((node) => node.node_id !== nodeId),
            }
          : item,
      ),
      activeGroupId,
    );
  };

  /** 从「我的服务器」把一台可用服务器变成组内节点。 */
  const addServerNode = (
    groupId: string,
    server: { serverName: string; host: string | null; port: number | null },
  ) => {
    const group = groups.find((item) => item.group_id === groupId);
    if (!group || group.read_only) return;
    const host = server.host ?? "127.0.0.1";
    const node: GroupNode = {
      node_id: `srv_node_${Date.now()}`,
      name: `${server.serverName.split(" · ")[0]} 01`,
      server: host,
      port: server.port ?? 8388,
      protocol: "ss",
      latency_ms: 62,
    };
    commit(
      groups.map((item) =>
        item.group_id === groupId
          ? { ...item, nodes: [...item.nodes, node] }
          : item,
      ),
      activeGroupId,
    );
  };

  const activate = (groupId: string) => {
    if (!groups.some((group) => group.group_id === groupId)) return;
    commit(groups, groupId);
  };

  const activeGroup =
    groups.find((group) => group.group_id === activeGroupId) ?? groups[0] ?? null;

  return {
    groups,
    activeGroupId,
    activeGroup,
    selected,
    select,
    resetToRoot,
    createGroup,
    copyGroup,
    renameGroup,
    deleteGroup,
    addNode,
    addServerNode,
    removeNode,
    activate,
  };
}
