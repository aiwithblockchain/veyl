export interface GroupNode {
  node_id: string;
  name: string;
  server: string;
  port: number;
  protocol: "ss" | "vmess" | "trojan";
  /** null = 这次测不通。 */
  latency_ms: number | null;
}

export interface NodeGroup {
  group_id: string;
  name: string;
  /** Veyl 免费节点：只读。 */
  read_only: boolean;
  nodes: GroupNode[];
}

interface Store {
  groups: NodeGroup[];
  active_group_id: string;
}

export const GROUPS_STORE_KEY = "veyl.mock.nodeGroups";

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function readStore(): Store {
  try {
    const raw = localStorage.getItem(GROUPS_STORE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<Store>;
      if (Array.isArray(parsed.groups)) {
        const active = parsed.groups.some(
          (group) => group.group_id === parsed.active_group_id,
        )
          ? (parsed.active_group_id as string)
          : parsed.groups[0]?.group_id ?? "";
        return { groups: parsed.groups as NodeGroup[], active_group_id: active };
      }
    }
  } catch {
    // 坏数据按空库处理，不造默认数据。
  }
  return { groups: [], active_group_id: "" };
}

function writeStore(store: Store): void {
  try {
    localStorage.setItem(GROUPS_STORE_KEY, JSON.stringify(store));
  } catch {
    // 存不了就只活在这次会话里。
  }
}

export function readGroups(): NodeGroup[] {
  return clone(readStore().groups);
}

export function readActiveGroupId(): string {
  return readStore().active_group_id;
}

export function persistGroups(groups: NodeGroup[], activeGroupId: string): void {
  writeStore({ groups: clone(groups), active_group_id: activeGroupId });
}
