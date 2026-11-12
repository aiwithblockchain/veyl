import type {
  ConfigConnectMode,
  ConfigDetail,
  ConfigRouteMode,
  ConfigSummary,
} from "../agent/protocol";

/** 与协议里的 `connect_mode` 同义，界面层用它表示用户的选择。 */
export type ConnectMode = ConfigConnectMode;

/** 浏览器 mock 的配置库；useVpnSession 与 mock 桥读写同一份。 */
export const MOCK_CONFIG_STORAGE_KEY = "veyl.configs.mock.v1";

const MOCK_PROXY_PORT = 7890;

/** 新建配置的默认名：「配置 N」，N 取当前未被占用的最小整数。 */
export function nextConfigName(
  configs: readonly Pick<ConfigSummary, "name">[],
): string {
  const names = new Set(configs.map((config) => config.name.trim()));
  let index = 1;
  while (names.has(`配置 ${index}`)) index += 1;
  return `配置 ${index}`;
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
export function createMockConfig(
  name: string,
  mode: ConnectMode,
  options: {
    routingMode?: ConfigRouteMode;
    nodeIds?: string[];
  } = {},
): ConfigDetail {
  const configId = `config_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  const now = Date.now();
  const nodes = options.nodeIds?.length
    ? options.nodeIds.map((nodeId, index) => ({
        node_id: nodeId,
        name: `节点 ${index + 1}`,
        server: "203.0.113.50",
        port: 8388,
        method: "aes-256-gcm",
        protocol: "shadowsocks" as const,
        source: "manual" as const,
        created_at: now,
      }))
    : MOCK_NODE_SEEDS.map((node, index) => ({
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
    routing_mode: options.routingMode ?? "proxy_all",
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
    layout_revision: null,
  };
}
