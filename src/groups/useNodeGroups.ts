import { useCallback, useState } from "react";
import type { NodeGroup } from "./mockGroups";
import { readActiveGroupId, readGroups } from "./mockGroups";

/** 节点组：只读展示。节点组后端尚未接入，这里不造任何本地数据。 */
export function useNodeGroups() {
  const [groups] = useState<NodeGroup[]>(() => readGroups());
  const [activeGroupId] = useState(() => readActiveGroupId());
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const selected =
    groups.find((group) => group.group_id === selectedId) ??
    groups.find((group) => group.group_id === activeGroupId) ??
    groups[0] ??
    null;

  const select = useCallback((groupId: string) => setSelectedId(groupId), []);

  /** 回根：回到当前节点组。 */
  const resetToRoot = useCallback(() => setSelectedId(null), []);

  const activeGroup =
    groups.find((group) => group.group_id === activeGroupId) ?? groups[0] ?? null;

  return {
    groups,
    activeGroupId,
    activeGroup,
    selected,
    select,
    resetToRoot,
  };
}
