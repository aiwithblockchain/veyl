/**
 * 配置模型。字段名对齐 docs/contracts/commands.md §3 的 ConfigSummary / NodeSummary；
 * 批 2 只保留界面要用的字段，等 config_list / config_detail 接上后整层替换。
 */

export type ConnectMode = "tun" | "system_proxy";

export interface ConfigNode {
  node_id: string;
  name: string;
  /** 服务器地址。 */
  server: string;
  port: number;
  method: string;
  protocol: "shadowsocks";
  source: "seed" | "url" | "manual";
  created_at: number;
}

export interface VpnConfig {
  config_id: string;
  name: string;
  connect_mode: ConnectMode;
  /** 本机代理端口；接管全部（tun）恒为 null，界面显示「自动」。 */
  listen_port: number | null;
  current_node_id: string | null;
  nodes: ConfigNode[];
}

const MOCK_PROXY_PORT = 7890;

const SUGGESTED_NAMES: Record<ConnectMode, string> = {
  tun: "公司 · 接管全部",
  system_proxy: "公司 · 本机代理",
};

export function suggestedConfigName(mode: ConnectMode): string {
  return SUGGESTED_NAMES[mode];
}

export function portLabel(config: VpnConfig): string {
  if (config.connect_mode === "tun" || config.listen_port === null) return "自动";
  return String(config.listen_port);
}

export function nameTaken(name: string, configs: VpnConfig[]): boolean {
  const trimmed = name.trim();
  return configs.some((config) => config.name === trimmed);
}

export function uniqueConfigName(base: string, configs: VpnConfig[]): string {
  const names = new Set(configs.map((config) => config.name));
  if (!names.has(base)) return base;
  let index = 2;
  while (names.has(`${base} ${index}`)) index += 1;
  return `${base} ${index}`;
}

const MOCK_NODE_SEEDS = [
  { name: "东京 01", server: "203.0.113.21", port: 20343, method: "aes-256-gcm" },
  { name: "东京 02", server: "203.0.113.22", port: 20412, method: "aes-256-gcm" },
  { name: "新加坡 01", server: "203.0.113.41", port: 20888, method: "chacha20-ietf-poly1305" },
];

/** 批 2 的假数据：等 config_create 接上后由命令返回值替换。 */
export function createMockConfig(name: string, mode: ConnectMode): VpnConfig {
  const configId = `config_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  const now = Date.now();
  const nodes: ConfigNode[] = MOCK_NODE_SEEDS.map((node, index) => ({
    node_id: `${configId}_node_${index + 1}`,
    name: node.name,
    server: node.server,
    port: node.port,
    method: node.method,
    protocol: "shadowsocks",
    source: "seed",
    created_at: now,
  }));
  return {
    config_id: configId,
    name,
    connect_mode: mode,
    listen_port: mode === "system_proxy" ? MOCK_PROXY_PORT : null,
    current_node_id: nodes[0]?.node_id ?? null,
    nodes,
  };
}
