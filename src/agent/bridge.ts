import { AGENT_EVENTS, CONTRACT_VERSION } from "./protocol";
import type {
  AgentEvent,
  Category,
  ConfigConnectMode,
  ConfigDetail,
  ConfigRouteMode,
  ConfigSummary,
  NodeCreateInput,
  NodeImportResult,
  NodeProbeData,
  NodeProbeMethod,
  NodeProbePhase,
  NodeSummary,
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
  /** 仅 proxy_selected 有意义：分类 id，来自 `category_list`。 */
  targets?: string[];
  source?: "seed" | "empty";
  nodeIds?: string[];
  listenPort?: number;
}

export interface ConfigActivateResult {
  active_config_id: string;
  reconnect: "not_running" | "reconnected" | "reconnect_failed" | "skipped_no_nodes";
  runtime: RuntimeSnapshot | null;
}

export interface ConfigDeleteData {
  config_id: string;
  deleted: boolean;
  already_absent: boolean;
  active_config_id: string | null;
}

export interface NodeSwitchResult {
  config_id: string;
  node_id: string;
  previous_node_id: string | null;
  connected: boolean;
  runtime: RuntimeSnapshot | null;
}

/** `node_probe` 的单节点结果；线格式与 commands.md §4.4 完全一致。 */
export type NodeProbeResult = NodeProbeData;

/** 批量测速的运行态；`run` 非空才代表有批次在跑，缓存内容不代表已测完。 */
export interface NodeProbeRun {
  runId: string;
  done: number;
  total: number;
  /** Unix 毫秒。 */
  startedAt: number;
  phase: NodeProbePhase;
  method: NodeProbeMethod;
}

export interface NodeProbeAllData {
  runId: string;
  configId: string;
  /** 实际要测的节点数；带 nodeIds 时是过滤后的数量。 */
  total: number;
  concurrency: number;
  /** nodeIds 里不属于该配置、被忽略的 id。 */
  ignoredNodeIds: string[];
}

export interface NodeProbeSnapshotData {
  configId: string;
  results: NodeProbeData[];
  run: NodeProbeRun | null;
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
  /** 结构化提问的类型；普通提问为 null。 */
  kind?: string | null;
  /** kind = "core_upgrade_confirm" 时的升级明细。 */
  upgradeConfirm?: CoreUpgradeConfirmData | null;
}

export interface CoreUpgradeConfirmData {
  currentVersion: string | null;
  targetVersion: string | null;
  /** 安装包字节数；后端没给时为 null。 */
  size: number | null;
  restartRequired: boolean;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function readSize(...values: unknown[]): number | null {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  }
  return null;
}

/**
 * 从提问载荷里读结构化信息。明细可能在 `upgrade` / `confirm` / `data`
 * 下，也可能与 `kind` 同级；两种形状都认，避免前后端字段位置不同直接丢卡。
 */
export function readQuestionDetail(raw: Record<string, unknown>): {
  kind: string | null;
  upgradeConfirm: CoreUpgradeConfirmData | null;
} {
  const kind = readString(raw.kind);
  if (kind !== "core_upgrade_confirm") return { kind, upgradeConfirm: null };
  const merged = {
    ...(asRecord(raw.upgrade) ?? {}),
    ...(asRecord(raw.confirm) ?? {}),
    ...(asRecord(raw.data) ?? {}),
    ...(asRecord(raw.details) ?? {}),
    ...raw,
  };
  return {
    kind,
    upgradeConfirm: {
      currentVersion: readString(merged.current_version, merged.currentVersion),
      targetVersion: readString(merged.target_version, merged.targetVersion),
      size: readSize(merged.size, merged.download_size, merged.bytes),
      restartRequired:
        merged.restart_required === true || merged.restartRequired === true,
    },
  };
}

/** UI 发起的连接/断开正在进行中；按钮据此禁用，防止重复提交。 */
export type RuntimeAction = "start" | "stop";

/** 默认配置包状态（commands.md §8.1–8.2）。 */
export interface DefaultProfileStatus {
  packageId: string | null;
  version: string | null;
  appliedAt: string | null;
  newVersionAvailable: boolean;
  nodeCount: number;
  /** 上次检查时间（ISO 8601）；从未检查为 null。 */
  checkedAt: string | null;
  /** 这次结果来自网络还是缓存。 */
  source: "network" | "cache" | null;
  /** 本次是否真的更新了节点。 */
  changed: boolean;
  /** 没换成远端内容时的细分原因；local_write = 内容没问题，写到本机失败。 */
  reason: "offline" | "invalid_content" | "local_write" | null;
  /** 新增 / 移除节点数；后端拿不到时给 0。 */
  added: number;
  removed: number;
}

/** 全局本地代理端口（设置 → 连接）。命令只给 UI 用，AI 不可调用。 */
export const DEFAULT_PROXY_PORT = 7890;

export interface ProxyPortSettings {
  port: number;
  /** 后端常量默认值；「恢复默认」一类文案用它，不在界面写死 7890。 */
  defaultPort: number;
}

export type ProxyPortAvailability = "free" | "occupied" | "unavailable";

export interface ProxyPortSaveResult {
  port: number;
  /** 保存那一刻的探测结果：可用 / 被占用 / 这台机器上用不了。 */
  availability: ProxyPortAvailability;
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

/** 强制重置网络的单步状态；后端目前只回 ok 布尔，skipped 留给后续逐步事件。 */
export type NetworkResetStepStatus = "ok" | "failed" | "skipped";

export interface NetworkForceResetStep {
  id: string;
  ok: boolean;
  detail: string;
  status?: NetworkResetStepStatus;
}

/** `network_force_reset` 的返回：八步固定、顺序固定，UI 只按 steps 渲染。 */
export interface NetworkForceResetResult {
  ok: boolean;
  verified: boolean;
  exitIp: string | null;
  steps: NetworkForceResetStep[];
}

/** 运行时（建立连接时实际运行的程序）的版本来源。 */
export type CoreActiveSource = "bundled" | "installed";

export interface CoreInfo {
  bundledVersion: string;
  activeVersion: string;
  activeSource: CoreActiveSource;
  restartRequired: boolean;
}

export interface CoreUpdateCandidate {
  version: string;
  /** 安装包字节数；后端没给时为 0。 */
  size: number;
}

export type CoreUpdateNetwork = "ok" | "unreachable" | "source_error";

export interface CoreCheckUpdatesResult {
  network: CoreUpdateNetwork;
  candidates: CoreUpdateCandidate[];
  /** true = 本次联网失败，结果来自上次成功验签的缓存，不能当作实时结果。 */
  cached: boolean;
  /** 失败原因；后端可选返回。 */
  message?: string;
}

/** 仅 debug 构建的 TUN 诊断结果；只读，不改路由与连接。 */
export interface TunProbeData {
  /** 一句话结论。 */
  conclusion: string;
  /** 报告文件绝对路径，位于 ~/.veyl/diagnostics/。 */
  reportPath: string;
  /** 接口、地址、路由数与关键段覆盖，每项一行。 */
  utun: string[];
  /** 当前节点服务器 TCP 直连结果。 */
  node: string;
  /** 系统 DNS 解析结果。 */
  dns: string;
  /** 经隧道访问固定 HTTPS 的结果。 */
  https: string;
  /** sing-box pid / 存活 / 建立时间。 */
  process: string;
}

/** 后台组件（接管全部流量）的当前状态。 */
export type TunHelperState =
  | "running"
  | "not_running"
  | "stale"
  | "start_failed"
  | "file_invalid"
  /** 后端给了未知取值：只读展示，不提供动作。 */
  | "unknown";

export interface TunHelperInfo {
  runningBuild: string | null;
  /** 人读的版本号（旧 helper 不返回时为 null）；界面只显示这个，不显示构建哈希。 */
  helperVersion: string | null;
  expectedBuild: string | null;
  stale: boolean;
  state: TunHelperState;
  needsAdminRestart: boolean;
}

export interface TunHelperRestartResult {
  ok: boolean;
  restarted: boolean;
  needsAdminRestart: boolean;
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
  /** 取消一条请求；返回 false = 后端确认这条请求已经不在跑了。 */
  cancel(requestId: string): Promise<boolean>;
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
  /** 删除一套配置；正在连接的配置由 UI 先断开。 */
  configDelete(configId: string): Promise<ConfigDeleteData>;
  /** 切换 active 配置；已连接时需带 confirmDisconnect。 */
  configActivate(configId: string, confirmDisconnect?: boolean): Promise<ConfigActivateResult>;
  /** 切换某套配置的当前节点；已连接时由 Host 热切换，不断流。 */
  nodeSwitch(configId: string, nodeId: string): Promise<NodeSwitchResult>;
  /** 测试单个节点连通性。不可达是正常结果，不抛错。 */
  nodeProbe(nodeId: string): Promise<NodeProbeResult>;
  /** 批量测速：全局同时只允许一个批次；关闭面板不取消。nodeIds 省略 = 全部。 */
  nodeProbeAll(configId?: string, nodeIds?: string[]): Promise<NodeProbeAllData>;
  /** 取消批次；runId 不存在或已结束时 cancelled=false，不报错。 */
  nodeProbeCancel(runId: string): Promise<{ cancelled: boolean }>;
  /** 打开面板时读取缓存与运行态；不发网络请求。 */
  nodeProbeSnapshot(configId?: string): Promise<NodeProbeSnapshotData>;
  /** 手动建一个 Shadowsocks 节点；不自动连接。 */
  nodeCreate(input: NodeCreateInput): Promise<NodeSummary>;
  /** 从订阅地址导入节点；只接受 https，拉取失败整体失败。 */
  nodeImportUrl(url: string, configId?: string): Promise<NodeImportResult>;
  /** 导入用户粘贴的 ss:// 文本；不发网络请求。 */
  nodeImportText(text: string, configId?: string): Promise<NodeImportResult>;
  /** 服务分类目录（只读），「只指定服务」的 targets 从这里取 id。 */
  categoryList(query?: string, limit?: number): Promise<{ categories: Category[]; total: number }>;
  /** 系统时区 / 区域推断出的地区（小写 cc）；取不到为 null。 */
  systemRegion(): Promise<string | null>;
  /** 只读的默认配置包状态，不联网。 */
  defaultProfileStatus(): Promise<DefaultProfileStatus>;
  /** 拉取并应用默认配置包；不打断在线连接，下次连接生效。 */
  defaultProfileRefresh(): Promise<DefaultProfileStatus>;
  /** 读取「本地代理端口」设置；从未设置过时后端给默认值。 */
  proxyPortGet(): Promise<ProxyPortSettings>;
  /** 保存「本地代理端口」；端口被占用也允许保存，只在行内提示。 */
  proxyPortSet(port: number): Promise<ProxyPortSaveResult>;
  /** 恢复网络：撤代理 → 停运行时 → 清明文配置（不依赖 AI）。 */
  netRepair(action: NetRepairAction): Promise<NetRepairResult>;
  /** 强制重置网络：UI 专用，不注册为 AI 工具动作。 */
  networkForceReset(): Promise<NetworkForceResetResult>;
  /** 当前运行时版本与来源；命令不存在时抛错，由 UI 降级为只读。 */
  coreInfo(): Promise<CoreInfo>;
  /** 检查运行时更新；网络不可达是正常结果，不抛错。 */
  coreCheckUpdates(): Promise<CoreCheckUpdatesResult>;
  /** 开始升级；进度通过 core-upgrade-progress / finished 事件回流。 */
  coreUpgrade(version: string): Promise<{ jobId: string }>;
  coreCancelUpgrade(jobId: string): Promise<{ cancelled: boolean }>;
  /** 回到随包版本。 */
  coreRollback(): Promise<void>;
  /** 仅 debug 构建：TUN 已连接时采集一次诊断；未连接抛 PRECONDITION_FAILED。 */
  tunProbe(): Promise<TunProbeData>;
  /** 后台组件状态；命令缺失时抛错，由 UI 降级为只读。 */
  tunHelperInfo(): Promise<TunHelperInfo>;
  /** 检查并更新后台组件；可能需要一次管理员授权。 */
  tunHelperRestart(): Promise<TunHelperRestartResult>;
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
  /** 回答模型的提问：普通提问接受任何非空文本，空字符串表示跳过；升级确认卡仍只认 options 原文。 */
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
    system_dns: null,
    health: { ...EMPTY_HEALTH },
    connections: null,
    restart_count: 0,
    last_error: null,
    mixed_port: null,
    port_fallback: null,
    connected_since: null,
    latency_ms: null,
    node_latency_ms: null,
    traffic: null,
    applied_route_revision: null,
    route_region: null,
    direct_ip: null,
  };
}

/** start 返回成功即已经连上；事件/快照竞态可能还停在非在线态，先校正为在线。 */
export function viewAfterConnected(view: RuntimeView): RuntimeView {
  if (view.state === "running" || view.state === "degraded") return view;
  return { ...view, state: "running", last_error: null };
}

/** stop 返回成功即已经断开；清掉连接期字段，避免面板继续显示出口与计时。 */
export function viewAfterStopped(view: RuntimeView): RuntimeView {
  return {
    ...view,
    state: "idle",
    pid: null,
    connected_since: null,
    port_fallback: null,
    route_region: null,
    system_dns: null,
    latency_ms: null,
    node_latency_ms: null,
    traffic: null,
    connections: null,
    last_error: null,
  };
}

/** 健康事件逐条拉快照太贵；与 helper 侧 5 秒复核对齐。 */
export const HEALTH_SNAPSHOT_REFRESH_MS = 5_000;

/**
 * 健康事件要不要顺带刷新快照。只在连接态、且距上次刷新满 5 秒时才拉：
 * TUN 的系统 DNS 复核结果只出现在 runtime_status 里，不进事件快照。
 */
export function shouldRefreshSnapshotOnHealth(
  state: RuntimeView["state"],
  lastRefreshAt: number,
  now: number,
): boolean {
  if (state !== "running" && state !== "degraded") return false;
  return now - lastRefreshAt >= HEALTH_SNAPSHOT_REFRESH_MS;
}

/** 把快照与事件合并成状态面板的视图。 */
export function applyRuntimeEvent(view: RuntimeView, event: AgentEvent): RuntimeView {
  switch (event.name) {
    case AGENT_EVENTS.runtimeStateChanged: {
      const to = event.payload.to;
      // 离开在线态就清掉连接时刻，避免面板继续计时。
      const keepConnection = to === "running" || to === "degraded";
      // 新连接不继承旧连接：上一次离开在线态的事件可能没到，上线时先清掉，交给随后的快照。
      const fromOnline =
        event.payload.from === "running" || event.payload.from === "degraded";
      return {
        ...view,
        state: to,
        pid: event.payload.pid,
        upstream_version: event.payload.upstream_version ?? view.upstream_version,
        last_error: event.payload.error,
        connected_since: keepConnection ? view.connected_since : null,
        port_fallback: keepConnection ? view.port_fallback : null,
        route_region: keepConnection ? view.route_region : null,
        system_dns: keepConnection ? (fromOnline ? view.system_dns : null) : null,
        latency_ms: keepConnection ? view.latency_ms : null,
        node_latency_ms: keepConnection ? view.node_latency_ms : null,
        traffic: keepConnection ? view.traffic : null,
        connections: keepConnection ? view.connections : null,
      };
    }
    case AGENT_EVENTS.runtimeHealthChanged: {
      const online = view.state === "running" || view.state === "degraded";
      const payload = event.payload;
      const traffic = online
        ? "traffic" in payload
          ? payload.traffic ?? null
          : view.traffic
        : null;
      const connections = online
        ? "connections" in payload
          ? payload.connections ?? null
          : view.connections
        : null;
      const latency = online
        ? "latency_ms" in payload
          ? payload.latency_ms ?? null
          : view.latency_ms
        : null;
      const nodeLatency = online
        ? "node_latency_ms" in payload
          ? payload.node_latency_ms ?? null
          : view.node_latency_ms
        : null;
      return {
        ...view,
        health: payload.health
          ? { ...EMPTY_HEALTH, ...payload.health }
          : view.health,
        traffic,
        connections,
        latency_ms: latency,
        node_latency_ms: nodeLatency,
      };
    }
    default:
      return view;
  }
}

/**
 * 快照请求发出后如果又收到健康事件，快照回来时这些字段可能比事件里的值旧。
 * 只覆盖健康事件会写的字段（health / 流量 / 连接数 / 两种延迟），其余仍以快照为准。
 */
export function keepLiveHealth(base: RuntimeView, current: RuntimeView): RuntimeView {
  return {
    ...base,
    health: current.health,
    traffic: current.traffic,
    connections: current.connections,
    latency_ms: current.latency_ms,
    node_latency_ms: current.node_latency_ms,
  };
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
    system_dns: snapshot.system_dns ?? null,
    health: snapshot.health
      ? { ...EMPTY_HEALTH, ...snapshot.health }
      : { ...EMPTY_HEALTH },
    connections: snapshot.connections ?? null,
    restart_count: snapshot.restart_count,
    last_error: snapshot.last_error,
    mixed_port: snapshot.mixed_port ?? null,
    port_fallback: snapshot.port_fallback ?? null,
    connected_since: snapshot.connected_since ?? null,
    latency_ms: snapshot.latency_ms ?? null,
    node_latency_ms: snapshot.node_latency_ms ?? null,
    traffic: snapshot.traffic ?? null,
    applied_route_revision: snapshot.applied_route_revision ?? null,
    route_region: snapshot.route_region ?? null,
    direct_ip: snapshot.direct_ip ?? null,
  };
}
