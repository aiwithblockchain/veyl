import type {
  ConfigConnectMode,
  ConfigDetail,
  ConfigSummary,
} from "../agent/protocol";

/** 与协议里的 `connect_mode` 同义，界面层用它表示用户的选择。 */
export type ConnectMode = ConfigConnectMode;

const SUGGESTED_NAMES: Record<ConnectMode, string> = {
  tun: "公司 · 接管全部",
  system_proxy: "公司 · 本机代理",
};

const MOCK_PROXY_PORT = 7890;

export function suggestedConfigName(mode: ConnectMode): string {
  return SUGGESTED_NAMES[mode];
}

export function portLabel(
  config: Pick<ConfigSummary, "connect_mode" | "listen_port">,
): string {
  if (config.connect_mode === "tun" || config.listen_port === null) return "自动";
  return String(config.listen_port);
}

export function nameTaken(
  name: string,
  configs: readonly Pick<ConfigSummary, "name">[],
): boolean {
  const trimmed = name.trim();
  return configs.some((config) => config.name === trimmed);
}

export function uniqueConfigName(
  base: string,
  configs: readonly Pick<ConfigSummary, "name">[],
): string {
  const names = new Set(configs.map((config) => config.name));
  if (!names.has(base)) return base;
  let index = 2;
  while (names.has(`${base} ${index}`)) index += 1;
  return `${base} ${index}`;
}

/** 只保留左栏需要的字段，与 `config_list` 的返回同形。 */
export function summarizeConfig(
  detail: ConfigDetail,
  activeId: string | null,
): ConfigSummary {
  return {
    config_id: detail.config_id,
    name: detail.name,
    connect_mode: detail.connect_mode,
    routing_mode: detail.routing_mode,
    node_count: detail.node_count,
    listen_port: detail.listen_port,
    is_active: detail.config_id === activeId,
    current_node_id: detail.current_node_id,
    created_at: detail.created_at,
    updated_at: detail.updated_at,
    last_used_at: detail.last_used_at,
  };
}

const MOCK_NODE_SEEDS = [
  { name: "东京 01", server: "203.0.113.21", port: 20343, method: "aes-256-gcm" },
  { name: "东京 02", server: "203.0.113.22", port: 20412, method: "aes-256-gcm" },
  { name: "新加坡 01", server: "203.0.113.41", port: 20888, method: "chacha20-ietf-poly1305" },
];

/** VITE_MOCK=1 时的离线数据；真实模式下由 `config_create` 返回。 */
export function createMockConfig(name: string, mode: ConnectMode): ConfigDetail {
  const configId = `config_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  const now = Date.now();
  const nodes = MOCK_NODE_SEEDS.map((node, index) => ({
    node_id: `${configId}_node_${index + 1}`,
    name: node.name,
    server: node.server,
    port: node.port,
    method: node.method,
    protocol: "shadowsocks" as const,
    source: "seed" as const,
    created_at: now,
  }));
  return {
    config_id: configId,
    name,
    connect_mode: mode,
    routing_mode: "proxy_all",
    node_count: nodes.length,
    listen_port: mode === "system_proxy" ? MOCK_PROXY_PORT : null,
    is_active: false,
    current_node_id: nodes[0]?.node_id ?? null,
    created_at: now,
    updated_at: now,
    last_used_at: null,
    nodes,
    dns: { mode: "auto", local: [], remote: [] },
    tun_excludes: [],
    layout: null,
  };
}
