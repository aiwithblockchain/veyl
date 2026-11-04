import { AGENT_EVENTS, CONTRACT_VERSION } from "./protocol";
import type {
  AgentEvent,
  ConfigConnectMode,
  ConfigDetail,
  ConfigRouteMode,
  ConfigSummary,
  RuntimeSnapshot,
  RuntimeView,
} from "./protocol";

export type BridgeMode = "tauri" | "mock";

/** DeepSeek Key 的保存结果。后端可能只回 `{saved, validation}`，由 bridge 归一化。 */
export interface DeepSeekKeyState {
  /** 打码后的 Key，形如 `sk-****abcd`；未配置为 null。 */
  masked: string | null;
  /** 后端明确验证通过才为 true；未验证 / 校验失败都是 false。 */
  verified: boolean;
  /** 三态校验结果，与 tools.md §4.15 对齐。 */
  validation: "ok" | "invalid" | "unverified";
}

/** `chat_history` 的返回：DB 里的会话摘要与消息（时间为 ISO 8601）。 */
export interface StoredSessionSummary {
  id: string;
  title: string;
  created_at: string;
}

export interface StoredChatMessage {
  id: string;
  role: string;
  content: string;
  created_at: string;
}

export interface ChatHistory {
  sessions: StoredSessionSummary[];
  activeSessionId: string | null;
  messages: StoredChatMessage[];
}

/** `rename_session` 的返回；标题以返回值给的内容为准，不做本地推测。 */
export interface RenamedSession {
  id: string;
  title: string;
  createdAt: number;
}

/** `import_seed_file` 的返回。**永远不含 password**。 */
export interface ImportedProfile {
  id: string;
  name: string;
  server: string;
  server_port?: number;
  method: string;
}

export interface ImportSeedResult {
  imported: number;
  skipped: { name: string; reason: string }[];
  profiles: ImportedProfile[];
}

export interface ConfigListData {
  configs: ConfigSummary[];
  active_config_id: string | null;
}

/** `config_create` 的命令参数（commands.md §3.2）。 */
export interface ConfigCreateInput {
  name: string;
  connectMode: ConfigConnectMode;
  routingMode: ConfigRouteMode;
  source?: "seed" | "empty";
  nodeIds?: string[];
  listenPort?: number;
}

export interface ConfigActivateResult {
  active_config_id: string;
  reconnect: "not_running" | "reconnected" | "reconnect_failed" | "skipped_no_nodes";
  runtime: RuntimeSnapshot | null;
}

export interface NodeSwitchResult {
  config_id: string;
  node_id: string;
  previous_node_id: string | null;
  connected: boolean;
  runtime: RuntimeSnapshot | null;
}

export interface NodeProbeResult {
  node_id: string;
  reachable: boolean;
  latency_ms: number | null;
  probe_method: "clash_delay" | "tcp";
  checked_at: number;
  error: { code: string; message: string } | null;
}

/** 模型提出、尚未回答的问题（1.2.0）。 */
export interface PendingQuestion {
  questionId: string;
  sessionId: string;
  requestId: string;
  question: string;
  options: string[];
  createdAt: number;
  expiresAt: number;
}

/** UI 发起的连接/断开正在进行中；按钮据此禁用，防止重复提交。 */
export type RuntimeAction = "start" | "stop";

/** 默认配置包状态（commands.md §3.7）。 */
export interface DefaultProfileStatus {
  packageId: string | null;
  version: string | null;
  appliedAt: string | null;
  newVersionAvailable: boolean;
  nodeCount: number;
}

/** UI 只用前两种；后两种留给 AI 工具，共用同一实现。 */
export type NetRepairAction = "restore_direct" | "flush_dns";

export interface NetRepairResult {
  ok: boolean;
  action: NetRepairAction;
  detail: string;
  exitIp: string | null;
  verified: boolean;
}

/** 模型端点配置（R32）。线格式 snake_case，由 bridge 转成 camelCase。 */
export type LlmProtocol = "openai" | "anthropic";

export interface LlmProvider {
  providerId: string;
  name: string;
  protocol: LlmProtocol;
  /** 空串表示使用该类型的官方地址。 */
  baseUrl: string;
  model: string;
  hasKey: boolean;
  isActive: boolean;
  isBuiltin: boolean;
}

export interface LlmProviderInput {
  /** 编辑时带；新增时不传。 */
  providerId?: string;
  name: string;
  protocol: LlmProtocol;
  baseUrl: string;
  model: string;
  /** 空串表示沿用已保存的 Key；新增且非本机端点时必须填写。 */
  apiKey: string;
}

export interface LlmProviderTestResult {
  ok: boolean;
  latencyMs: number | null;
  error?: string;
}

/** Base URL 是否指向本机：http 只对这些主机放行，且允许不填 Key。 */
export function isLocalEndpoint(url: string): boolean {
  const host = hostOf(url);
  if (!host) return false;
  return (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "::1" ||
    host === "[::1]" ||
    host.endsWith(".localhost")
  );
}

/** Base URL 只允许 http / https；空串表示用官方地址。 */
export function isHttpUrl(url: string): boolean {
  const trimmed = url.trim();
  if (!trimmed) return true;
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function hostOf(url: string): string | null {
  const trimmed = url.trim();
  if (!trimmed) return null;
  try {
    return new URL(trimmed).hostname;
  } catch {
    return null;
  }
}

export interface AgentBridge {
  readonly mode: BridgeMode;
  /** 订阅全部事件（AI 会话 + 应用事件）；返回取消订阅函数。 */
  subscribe(listener: (event: AgentEvent) => void): () => void;
  sendMessage(
    sessionId: string,
    text: string,
    options?: { hidden?: boolean },
  ): Promise<{ requestId: string }>;
  cancel(requestId: string): Promise<void>;
  /** 事件不可达时的兜底快照（契约 §5 `runtime_status`）。 */
  getRuntimeSnapshot(): Promise<RuntimeSnapshot | null>;
  /** UI 直连：发起连接；不传 configId 时用当前激活配置。 */
  runtimeStart(configId?: string): Promise<void>;
  /** UI 直连：断开连接并恢复系统代理。 */
  runtimeStop(): Promise<void>;
  /** 左栏配置列表。只读本地库，不联网。 */
  configList(): Promise<ConfigListData>;
  /** 中间底部节点详情的数据源。 */
  configDetail(configId: string): Promise<ConfigDetail>;
  configCreate(input: ConfigCreateInput): Promise<ConfigDetail>;
  /** 切换 active 配置；已连接时需带 confirmDisconnect。 */
  configActivate(configId: string, confirmDisconnect?: boolean): Promise<ConfigActivateResult>;
  /** 切换某套配置的当前节点；已连接时由 Host 热切换，不断流。 */
  nodeSwitch(configId: string, nodeId: string): Promise<NodeSwitchResult>;
  /** 测试单个节点连通性。不可达是正常结果，不抛错。 */
  nodeProbe(nodeId: string): Promise<NodeProbeResult>;
  /** 只读的默认配置包状态，不联网。 */
  defaultProfileStatus(): Promise<DefaultProfileStatus>;
  /** 拉取并应用默认配置包；不打断在线连接，下次连接生效。 */
  defaultProfileRefresh(): Promise<DefaultProfileStatus>;
  /** 恢复网络：撤代理 → 停运行时 → 清明文配置（不依赖 AI）。 */
  netRepair(action: NetRepairAction): Promise<NetRepairResult>;
  /** 用系统文件管理器定位日志文件。 */
  openLogDir(): Promise<void>;
  /** 用系统默认浏览器打开链接。tauri 侧等 Host 接 opener 后实现。 */
  openExternal(url: string): Promise<void>;
  /** 重启后恢复会话：不传 sessionId 时取最近一个会话。 */
  getChatHistory(sessionId?: string): Promise<ChatHistory>;
  /** 重命名会话；标题的 trim 与长度校验都由后端做。 */
  renameSession(sessionId: string, title: string): Promise<RenamedSession>;
  /** 删除会话（R31）：不可恢复；有进行中的请求时先 cancel 再调用。 */
  deleteSession(sessionId: string): Promise<void>;
  /** 拖拽导入：只传路径，文件内容由 Host 读，WebView 不碰明文密码。 */
  importSeedFile(path: string): Promise<ImportSeedResult>;
  /** 读取 Key 的配置状态（只返回打码值，永不返回明文）。 */
  getDeepSeekKey(): Promise<DeepSeekKeyState>;
  /** 保存 Key；只进本机加密存储。 */
  saveDeepSeekKey(key: string): Promise<DeepSeekKeyState>;
  /** 从本机存储删除 Key。 */
  clearDeepSeekKey(): Promise<void>;
  /** 回答模型的提问：answer 必须是选项之一，空字符串表示跳过。 */
  replyUserQuestion(sessionId: string, questionId: string, answer: string): Promise<void>;
  /** 会话里尚未回答的问题（重连恢复用）。 */
  listPendingQuestions(sessionId: string): Promise<PendingQuestion[]>;
  /** 模型端点列表与当前项（R32 高级模式）。 */
  llmProviderList(): Promise<{ providers: LlmProvider[]; activeProviderId: string | null }>;
  llmProviderSave(input: LlmProviderInput): Promise<LlmProvider>;
  llmProviderDelete(providerId: string): Promise<void>;
  llmProviderActivate(providerId: string): Promise<void>;
  /** 用表单里的值发一个最小请求；不落库。 */
  llmProviderTest(input: LlmProviderInput): Promise<LlmProviderTestResult>;
  dispose(): void;
}

/** 打码：只留前缀与末四位，永不回显明文。 */
export function maskKey(key: string): string {
  const trimmed = key.trim();
  const tail = trimmed.slice(-4);
  return `sk-****${tail}`;
}

export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export const EMPTY_HEALTH = {
  contract_version: CONTRACT_VERSION,
  process: false,
  clash_api: false,
  data_plane: false,
  exit_ip: null,
  consecutive_failures: 0,
  checked_at: new Date(0).toISOString(),
} as const;

export function emptyRuntimeView(): RuntimeView {
  return {
    state: "idle",
    pid: null,
    upstream_version: null,
    uptime_seconds: null,
    config_id: null,
    config_name: null,
    node_id: null,
    node_name: null,
    config_hash: null,
    system_proxy_enabled: false,
    health: { ...EMPTY_HEALTH },
    connections: null,
    restart_count: 0,
    last_error: null,
    mixed_port: null,
    connected_since: null,
    latency_ms: null,
    applied_route_revision: null,
    direct_ip: null,
  };
}

/** 把快照与事件合并成状态面板的视图。 */
export function applyRuntimeEvent(view: RuntimeView, event: AgentEvent): RuntimeView {
  switch (event.name) {
    case AGENT_EVENTS.runtimeStateChanged: {
      const to = event.payload.to;
      // 离开在线态就清掉连接时刻，避免面板继续计时。
      const keepConnection = to === "running" || to === "degraded";
      return {
        ...view,
        state: to,
        pid: event.payload.pid,
        upstream_version: event.payload.upstream_version ?? view.upstream_version,
        last_error: event.payload.error,
        connected_since: keepConnection ? view.connected_since : null,
        latency_ms: keepConnection ? view.latency_ms : null,
      };
    }
    case AGENT_EVENTS.runtimeHealthChanged:
      return { ...view, health: event.payload.health };
    default:
      return view;
  }
}

export function snapshotToView(snapshot: RuntimeSnapshot): RuntimeView {
  // 后端旧版本不会返回新字段；一律归一成 null，UI 不显示 undefined。
  return {
    state: snapshot.state,
    pid: snapshot.pid,
    upstream_version: snapshot.upstream_version,
    uptime_seconds: snapshot.uptime_seconds,
    config_id: snapshot.config_id,
    config_name: snapshot.config_name ?? null,
    node_id: snapshot.node_id ?? null,
    node_name: snapshot.node_name ?? null,
    config_hash: snapshot.config_hash ?? null,
    system_proxy_enabled: snapshot.system_proxy_enabled,
    health: snapshot.health,
    connections: snapshot.connections,
    restart_count: snapshot.restart_count,
    last_error: snapshot.last_error,
    mixed_port: snapshot.mixed_port ?? null,
    connected_since: snapshot.connected_since ?? null,
    latency_ms: snapshot.latency_ms ?? null,
    applied_route_revision: snapshot.applied_route_revision ?? null,
    direct_ip: snapshot.direct_ip ?? null,
  };
}
