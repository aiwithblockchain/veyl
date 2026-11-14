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

function node(
  id: string,
  name: string,
  host: string,
  port: number,
  latency: number | null,
  protocol: GroupNode["protocol"] = "ss",
): GroupNode {
  return {
    node_id: id,
    name,
    server: host,
    port,
    protocol,
    latency_ms: latency,
  };
}

const DEFAULT_GROUPS: NodeGroup[] = [
  {
    group_id: "grp_free",
    name: "Veyl 免费节点",
    read_only: true,
    nodes: [
      node("free_sh", "上海 01", "1.2.3.4", 8388, 32),
      node("free_tk", "东京 02", "5.6.7.8", 8388, 58),
      node("free_sg", "新加坡 03", "9.9.9.9", 8388, null),
      node("free_la", "洛杉矶 04", "45.76.1.10", 8388, 141),
      node("free_sl", "首尔 05", "45.76.2.11", 8388, 47),
      node("free_fra", "法兰克福 06", "45.76.3.12", 8388, 189),
      node("free_syd", "悉尼 07", "45.76.4.13", 8388, 210),
      node("free_yyz", "多伦多 08", "45.76.5.14", 8388, 176),
    ],
  },
  {
    group_id: "grp_mine",
    name: "我的节点",
    read_only: false,
    nodes: [
      node("mine_tk", "东京 01", "45.76.20.100", 8388, 63),
      node("mine_la", "洛杉矶 01", "45.76.21.101", 8388, 152),
      node("mine_sg", "新加坡 01", "45.76.22.102", 8388, 88),
    ],
  },
  {
    group_id: "grp_sh1",
    name: "上海 1 号",
    read_only: false,
    nodes: [
      node("sh1_a", "上海 01", "203.0.113.11", 8388, 28),
      node("sh1_b", "上海 02", "203.0.113.12", 8388, 35),
      node("sh1_c", "上海 03", "203.0.113.13", 8388, 41),
    ],
  },
  {
    group_id: "grp_standby",
    name: "备用组",
    read_only: false,
    nodes: [],
  },
];

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function readStore(): Store {
  try {
    const raw = localStorage.getItem(GROUPS_STORE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<Store>;
      if (Array.isArray(parsed.groups) && parsed.groups.length > 0) {
        const active = parsed.groups.some(
          (group) => group.group_id === parsed.active_group_id,
        )
          ? (parsed.active_group_id as string)
          : parsed.groups[0].group_id;
        return { groups: parsed.groups as NodeGroup[], active_group_id: active };
      }
    }
  } catch {
    // 坏数据按默认数据演示。
  }
  return { groups: clone(DEFAULT_GROUPS), active_group_id: "grp_free" };
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

export function demoNode(source: "manual" | "paste" | "subscribe", index: number): GroupNode {
  const label =
    source === "manual" ? "手动节点" : source === "paste" ? "粘贴节点" : "订阅节点";
  return node(
    `demo_${source}_${index}`,
    `${label} ${String(index).padStart(2, "0")}`,
    `198.51.100.${10 + index}`,
    8388,
    40 + (index % 5) * 7,
  );
}
