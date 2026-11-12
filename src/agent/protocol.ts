/**
 * 事件与 UI → Host 调用的前端契约。
 *
 * 唯一来源：`docs/contracts/events.md` v2.11.0。
 * 本文件是事件名常量的唯一来源——组件、store、bridge 只能引用
 * `AGENT_EVENTS.*`，不得出现事件名字符串字面量（契约 §9.1）。
 */

export const CONTRACT_VERSION = "2.11.0" as const;

export const AGENT_EVENTS = {
  messageChunk: "message-chunk",
  thinkingChunk: "thinking-chunk",
  toolCallStart: "tool-call-start",
  toolCallEnd: "tool-call-end",
  status: "ai-status",
  compact: "ai-compact",
  requestEnd: "ai-request-end",
  runtimeStateChanged: "runtime-state-changed",
  runtimeHealthChanged: "runtime-health-changed",
  jobProgress: "job-progress",
  appLifecycleChanged: "app-lifecycle-changed",
  defaultProfileUpdated: "default-profile-updated",
  askUserQuestion: "ask-user-question",
  configChanged: "config-changed",
  nodeListChanged: "node-list-changed",
  nodeSwitched: "node-switched",
  issueChanged: "issue-changed",
  layoutUpdated: "layout-updated",
  routingChanged: "routing-changed",
  rulesChanged: "rules-changed",
  coreUpgradeProgress: "core-upgrade-progress",
  coreUpgradeFinished: "core-upgrade-finished",
  nodeProbeProgress: "node-probe-progress",
  nodeProbeFinished: "node-probe-finished",
} as const;

export type AgentEventName = (typeof AGENT_EVENTS)[keyof typeof AGENT_EVENTS];

/** AI 会话事件（1–7）与应用事件（8–18）分开，UI 两组都要订阅。 */
export const AI_EVENT_NAMES = [
  AGENT_EVENTS.messageChunk,
  AGENT_EVENTS.thinkingChunk,
  AGENT_EVENTS.toolCallStart,
  AGENT_EVENTS.toolCallEnd,
  AGENT_EVENTS.status,
  AGENT_EVENTS.compact,
  AGENT_EVENTS.requestEnd,
] as const;

export const APP_EVENT_NAMES = [
  AGENT_EVENTS.runtimeStateChanged,
  AGENT_EVENTS.runtimeHealthChanged,
  AGENT_EVENTS.jobProgress,
  AGENT_EVENTS.appLifecycleChanged,
  AGENT_EVENTS.defaultProfileUpdated,
  AGENT_EVENTS.askUserQuestion,
  AGENT_EVENTS.configChanged,
  AGENT_EVENTS.nodeListChanged,
  AGENT_EVENTS.nodeSwitched,
  AGENT_EVENTS.issueChanged,
  AGENT_EVENTS.layoutUpdated,
  AGENT_EVENTS.routingChanged,
  AGENT_EVENTS.rulesChanged,
  AGENT_EVENTS.coreUpgradeProgress,
  AGENT_EVENTS.coreUpgradeFinished,
  AGENT_EVENTS.nodeProbeProgress,
  AGENT_EVENTS.nodeProbeFinished,
] as const;

/* ------------------------------------------------------------------ */
/* 共用类型（runtime.md §2.6 / tools.md §1.3）                          */
/* ------------------------------------------------------------------ */

export type AivpnErrorCode =
  | "INVALID_ARGUMENT"
  | "NOT_FOUND"
  | "CONFLICT"
  | "PRECONDITION_FAILED"
  | "PERMISSION_DENIED"
  | "UNSUPPORTED"
  | "TIMEOUT"
  | "CANCELLED"
  | "UPSTREAM_ERROR"
  | "RATE_LIMITED"
  | "INTERNAL"
  | "RUNTIME_NOT_INSTALLED"
  | "RUNTIME_ALREADY_RUNNING"
  | "RUNTIME_NOT_RUNNING"
  | "RUNTIME_BUSY"
  | "RUNTIME_START_TIMEOUT"
  | "RUNTIME_CRASH_LOOP"
  | "RUNTIME_PORT_UNAVAILABLE"
  | "RUNTIME_CONFIG_INVALID"
  | "RUNTIME_HEALTH_FAILED"
  | "RUNTIME_EXITED"
  | "RUNTIME_STOP_TIMEOUT";

export interface AivpnError {
  /** runtime.md 的版本，和事件契约不同步，不要拿 CONTRACT_VERSION 比。 */
  contract_version: string;
  code: AivpnErrorCode;
  message: string;
  retryable: boolean;
  details: Record<string, unknown> | null;
  request_id: string;
}

export interface NextAction {
  /** 按钮文案，≤ 12 个汉字 */
  label: string;
  /** 模型可见的工具名，PascalCase */
  tool: string;
  args: Record<string, unknown>;
}

/* ------------------------------------------------------------------ */
/* 1–7：AI 会话事件                                                    */
/* ------------------------------------------------------------------ */

export interface MessageChunkPayload {
  contract_version: typeof CONTRACT_VERSION;
  request_id: string;
  assistant_message_id: string;
  chunk: string;
  emitted_at: string;
}

export type ThinkingChunkPayload = MessageChunkPayload;

export type ToolPermissionLevel = "none" | "read_only" | "write" | "execute";
export type CallSource = "ui" | "agent";

export interface ToolCallStartPayload {
  contract_version: typeof CONTRACT_VERSION;
  request_id: string;
  assistant_message_id: string;
  tool_call_id: string;
  tool: string;
  action: string;
  permission_level: ToolPermissionLevel;
  source: CallSource;
  args_preview?: Record<string, unknown>;
  emitted_at: string;
}

/** events.md 2.11.0：Host 填的可直接点击动作，只带不透明 id，不带路径。 */
export interface DisplayActionPayload {
  kind: "reveal_report_dir" | "compose_report_mail" | string;
  report_id: string;
}

/** 面向用户的完成/失败文案；缺失时前端回落到本地静态表。 */
export interface ToolDisplayPayload {
  text?: string | null;
  facts?: string[] | null;
  changed?: "none" | "restored" | "unknown" | null;
  actions?: DisplayActionPayload[] | null;
}

export interface ToolCallEndPayload {
  contract_version: typeof CONTRACT_VERSION;
  request_id: string;
  assistant_message_id: string;
  tool_call_id: string;
  tool: string;
  success: boolean;
  result: string;
  result_truncated: boolean;
  error_code: AivpnErrorCode | null;
  duration_ms: number;
  next_actions: NextAction[];
  display?: ToolDisplayPayload | null;
  emitted_at: string;
}

export type AiStatusPhase =
  | "thinking"
  | "streaming_answer"
  | "preparing_tool"
  | "running_tool"
  | "waiting_permission"
  | "retrying"
  | "compacting"
  | "completed";

export interface AiStatusPayload {
  contract_version: typeof CONTRACT_VERSION;
  request_id: string;
  assistant_message_id: string;
  phase: AiStatusPhase;
  text: string;
  emitted_at: string;
}

export interface AiCompactPayload {
  contract_version: typeof CONTRACT_VERSION;
  request_id: string;
  assistant_message_id: string;
  phase: "compacting" | "completed";
  text: string;
  tokens_before: number | null;
  tokens_after: number | null;
  emitted_at: string;
}

export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
}

export type RequestResult = "success" | "error" | "cancelled";

export interface AiRequestEndPayload {
  contract_version: typeof CONTRACT_VERSION;
  request_id: string;
  assistant_message_id: string;
  result: RequestResult;
  final_text: string | null;
  error: AivpnError | null;
  usage: TokenUsage | null;
  duration_ms: number;
  emitted_at: string;
}

/* ------------------------------------------------------------------ */
/* 8–10：应用事件                                                      */
/* ------------------------------------------------------------------ */

export type RuntimeState =
  | "idle"
  | "starting"
  | "running"
  | "degraded"
  | "restarting"
  | "stopping"
  | "failed";

export type RuntimeMode = "system_proxy" | "tun";

/** 连接期系统解析器是否已指向隧道（runtime.md 2.6.0）。 */
export type SystemDns = "tunnel" | "unchanged";

export type RuntimeTransitionEvent =
  | "start_req"
  | "process_ready"
  | "health_ok"
  | "health_fail"
  | "crash"
  | "stop_req"
  | "restart_req"
  | "stopped"
  | "give_up";

export interface RuntimeStateChangedPayload {
  contract_version: typeof CONTRACT_VERSION;
  from: RuntimeState;
  to: RuntimeState;
  event: RuntimeTransitionEvent;
  pid: number | null;
  upstream_version: string | null;
  reason: string | null;
  error: AivpnError | null;
  /** 迁移后的完整快照；state 必须等于 to。 */
  snapshot: RuntimeSnapshot;
  emitted_at: string;
}

export interface HealthSnapshot {
  contract_version: typeof CONTRACT_VERSION;
  process: boolean;
  clash_api: boolean;
  data_plane: boolean;
  exit_ip: string | null;
  consecutive_failures: number;
  checked_at: string;
}

export interface RuntimeHealthChangedPayload {
  contract_version: typeof CONTRACT_VERSION;
  health: HealthSnapshot;
  /** 运行时流量统计；旧版后端不返回，UI 保留占位。 */
  traffic?: TrafficStats | null;
  /** 活跃连接数；旧版后端不返回。 */
  connections?: number | null;
  /** 出口 IP 探测耗时，界面不展示；旧版后端不返回。 */
  latency_ms?: number | null;
  /** 当前节点延迟（2.4.0 起界面只认这个）；旧版后端不返回。 */
  node_latency_ms?: number | null;
  emitted_at: string;
}

export type JobState = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export interface JobProgressPayload {
  contract_version: typeof CONTRACT_VERSION;
  job_id: string;
  kind: "core_install" | "core_upgrade" | "diag" | "rules_update";
  state: JobState;
  stage: string;
  progress: number;
  message: string | null;
  error: AivpnError | null;
  /** 任务发起方；旧记录按 "ui" 读。 */
  origin: "ui" | "agent";
  emitted_at: string;
}

/** 运行时升级进度；phase 由后端定义，前端按常见别名归一。 */
export interface CoreUpgradeProgressPayload {
  contract_version?: typeof CONTRACT_VERSION;
  job_id: string;
  phase: string;
  received: number;
  total: number | null;
  /** 任务发起方；agent 表示由对话发起，ui 表示设置页。 */
  origin?: "ui" | "agent" | null;
  emitted_at?: string;
}

export interface CoreUpgradeFinishedPayload {
  contract_version?: typeof CONTRACT_VERSION;
  job_id: string;
  ok: boolean;
  code?: string | null;
  version?: string | null;
  /** 任务发起方；agent 表示由对话发起，ui 表示设置页。 */
  origin?: "ui" | "agent" | null;
  emitted_at?: string;
}

/** `node_probe` / 批量测速共用的单节点结果（commands.md §4.4）。 */
export interface NodeProbeData {
  node_id: string;
  reachable: boolean;
  latency_ms: number | null;
  probe_method: "clash_delay" | "tcp";
  /** Unix 毫秒。 */
  checked_at: number;
  error: { code: string; message: string } | null;
}

/** 批量测速的阶段：preparing 时临时运行时尚未就绪，没有任何结果。 */
export type NodeProbePhase = "preparing" | "probing";

/** 批量测速的方式；clash = 真实可用性（可用），tcp = 仅可达（可达）。 */
export type NodeProbeMethod = "tcp" | "clash";

/** 批量测速单个节点完成；面板关闭后批次仍在后台跑（events.md §4.19）。 */
export interface NodeProbeProgressPayload {
  contract_version: typeof CONTRACT_VERSION;
  run_id: string;
  config_id: string;
  phase: NodeProbePhase;
  method: NodeProbeMethod;
  done: number;
  total: number;
  /** preparing 阶段为 null；逐节点完成事件非空。 */
  result: NodeProbeData | null;
  emitted_at: string;
}

/** 批次结束（跑完或取消），每个 run_id 恰好一条（events.md §4.20）。 */
export interface NodeProbeFinishedPayload {
  contract_version: typeof CONTRACT_VERSION;
  run_id: string;
  config_id: string;
  total: number;
  ok: number;
  failed: number;
  /** 整批实际使用的方式；降级时为 tcp（界面写「可达」）。 */
  method: NodeProbeMethod;
  cancelled: boolean;
  /** 用户中途启动 VPN 导致取消时为 connected。 */
  reason: "connected" | null;
  network: "ok" | "offline";
  emitted_at: string;
}

export type AppLifecycleState = "foreground" | "background";

export interface AppLifecycleChangedPayload {
  contract_version: typeof CONTRACT_VERSION;
  state: AppLifecycleState;
  /** 首次发出时为 null。 */
  previous: AppLifecycleState | null;
  emitted_at: string;
}

export interface DefaultProfileUpdatedPayload {
  contract_version: typeof CONTRACT_VERSION;
  seed_id: "veyl_seed";
  content_sha256: string;
  /** 文件里的 version，仅展示。 */
  version: string | null;
  node_count: number;
  new_version_available: boolean;
  /** Unix 毫秒。 */
  applied_at: number;
  emitted_at: string;
}

/** 模型向用户提问（1.2.0）：answer 必须是 options 之一，空串 = 跳过。 */
export interface AskUserQuestionPayload {
  contract_version: typeof CONTRACT_VERSION;
  session_id: string;
  request_id: string;
  question_id: string;
  question: string;
  options: string[];
  /** 结构化提问的类型；普通提问没有该字段。 */
  kind?: string | null;
  /** kind = "core_upgrade_confirm" 时的明细（线格式 snake_case）。 */
  details?: Record<string, unknown> | null;
  created_at: number;
  /** Unix 毫秒，= created_at + 900_000；前端只读这个值做倒计时。 */
  expires_at: number;
  emitted_at: string;
}

/* ------------------------------------------------------------------ */
/* 配置 / 节点 / 问题 / 布局事件（events.md §4.9–4.13）                 */
/* ------------------------------------------------------------------ */

export type ConfigConnectMode = "system_proxy" | "tun";
export type ConfigRouteMode = "direct" | "proxy_all" | "proxy_selected";

/** commands.md §3.0；不含节点明细与凭据。 */
export interface ConfigSummary {
  config_id: string;
  name: string;
  connect_mode: ConfigConnectMode;
  routing_mode: ConfigRouteMode;
  node_count: number;
  listen_port: number | null;
  is_active: boolean;
  current_node_id: string | null;
  created_at: number;
  updated_at: number;
  last_used_at: number | null;
}

export interface NodeSummary {
  node_id: string;
  name: string;
  server: string;
  port: number;
  method: string;
  protocol: "shadowsocks";
  source: "seed" | "url" | "manual";
  created_at: number;
}

/** `node_import_url` / `node_import_text` 的返回（commands.md §4.1）。 */
export interface NodeImportSkipped {
  name: string | null;
  reason:
    | "unsupported_scheme"
    | "unsupported_method"
    | "malformed"
    | "duplicate"
    | "subscription_empty";
}

export interface NodeImportResult {
  imported: number;
  skipped: NodeImportSkipped[];
  /** 本次新增的节点；已存在的不在这里。 */
  nodes: NodeSummary[];
}

export interface NodeCreateInput {
  name: string;
  server: string;
  port: number;
  method: string;
  password: string;
  configId?: string;
}

/** 服务分类（commands.md §10.7）。`proxy_selected` 的 targets 只能取这里的 id。 */
export interface Category {
  id: string;
  name_zh: string;
  name_en: string;
  description: string;
  item_count: number;
  rule_sets: string[];
  dns_classifiable: boolean;
}

export interface DnsConfig {
  mode: "auto" | "custom";
  local: string[];
  remote: string[];
}

export interface ConfigDetail extends ConfigSummary {
  nodes: NodeSummary[];
  dns: DnsConfig;
  tun_excludes: string[];
  layout: Layout | null;
  /** 与 layout 配套；从没编排过为 null。用来丢弃迟到的 layout-updated。 */
  layout_revision: number | null;
}

export interface ConfigChangedPayload {
  contract_version: typeof CONTRACT_VERSION;
  change: "created" | "updated" | "deleted" | "activated";
  config_id: string;
  /** deleted 时为 null。 */
  config: ConfigSummary | null;
  active_config_id: string | null;
  emitted_at: string;
}

export type NodeListChangedReason =
  | "seed_refreshed"
  | "url_import"
  | "manual_create"
  | "node_deleted"
  | "bindings_changed";

export interface NodeListChangedPayload {
  contract_version: typeof CONTRACT_VERSION;
  reason: NodeListChangedReason;
  /** 只有 bindings_changed 时非空。 */
  config_id: string | null;
  node_count_total: number;
  /** 超过 200 条时给空数组。 */
  changed_node_ids: string[];
  emitted_at: string;
}

export interface NodeSwitchedPayload {
  contract_version: typeof CONTRACT_VERSION;
  config_id: string;
  from_node_id: string | null;
  to_node_id: string;
  /** 是否同时做了在线热切换。 */
  connected: boolean;
  /** connected = false 时为 null。 */
  runtime: RuntimeSnapshot | null;
  emitted_at: string;
}

export type IssueSeverity = "P0" | "P1" | "P2";
export type IssueState = "open" | "handed_off" | "resolved" | "ignored";

/** commands.md §6.0。 */
export interface IssueSummary {
  issue_id: string;
  type: string;
  target: string;
  title: string;
  severity: IssueSeverity;
  mode: "system_proxy" | "tun";
  state: IssueState;
  count: number;
  first_seen: number;
  last_seen: number;
  config_id: string | null;
  session_id: string | null;
}

export interface IssueChangedPayload {
  contract_version: typeof CONTRACT_VERSION;
  change: "created" | "updated" | "handed_off" | "resolved" | "ignored" | "reopened";
  issue: IssueSummary;
  /** 当前应插卡的那一条；null = 中间不插卡。 */
  blocking_issue_id: string | null;
  open_counts: { P0: number; P1: number; P2: number };
  emitted_at: string;
}

export type BlockType =
  | "empty_hint"
  | "proxy_card"
  | "source_choice"
  | "reachability"
  | "issue_card"
  | "update_hint";

export interface Layout {
  version: 1;
  blocks: Array<{ type: BlockType; props?: Record<string, unknown> }>;
}

export interface LayoutUpdatedPayload {
  contract_version: typeof CONTRACT_VERSION;
  config_id: string;
  /** 每配置单调递增，从 1 开始。 */
  revision: number;
  layout: Layout;
  emitted_at: string;
}

/** `route_get` 的返回（commands.md §10.1）；前端暂未接线。 */
export interface RouteState {
  config_id: string;
  routing_mode: ConfigRouteMode;
  applied_mode: ConfigRouteMode | null;
  targets: string[];
  custom_rules: Array<Record<string, unknown>>;
  route_revision: number;
  applied_revision: number | null;
  effective: "current_connection" | "next_connection";
  reconnect_required: boolean;
  /** 本地直连层依据：CN = domain_and_ip，其它 = ip_only，未知 = none。 */
  local_direct_basis: "domain_and_ip" | "ip_only" | "none";
  /** 实时判定的小写 cc；未知为 null。 */
  detected_region: string | null;
  /** 运行配置实际使用的地区；未连接或当时未知为 null。 */
  applied_region: string | null;
}

export interface RoutingChangedPayload {
  contract_version: typeof CONTRACT_VERSION;
  config_id: string;
  routing_mode: ConfigRouteMode;
  applied_mode: ConfigRouteMode | null;
  targets: string[];
  route_revision: number;
  applied_revision: number | null;
  change: "mode" | "targets" | "custom_rule";
  hot_switched: boolean;
  reconnect_required: boolean;
  emitted_at: string;
}

export interface RulesChangedPayload {
  contract_version: typeof CONTRACT_VERSION;
  active_version: string;
  previous_version: string | null;
  geosite_tag: string | null;
  geoip_tag: string | null;
  item_count: number;
  effective: "next_connect";
  emitted_at: string;
}

/* ------------------------------------------------------------------ */
/* 事件联合类型                                                        */
/* ------------------------------------------------------------------ */

export interface AgentEventMap {
  [AGENT_EVENTS.messageChunk]: MessageChunkPayload;
  [AGENT_EVENTS.thinkingChunk]: ThinkingChunkPayload;
  [AGENT_EVENTS.toolCallStart]: ToolCallStartPayload;
  [AGENT_EVENTS.toolCallEnd]: ToolCallEndPayload;
  [AGENT_EVENTS.status]: AiStatusPayload;
  [AGENT_EVENTS.compact]: AiCompactPayload;
  [AGENT_EVENTS.requestEnd]: AiRequestEndPayload;
  [AGENT_EVENTS.runtimeStateChanged]: RuntimeStateChangedPayload;
  [AGENT_EVENTS.runtimeHealthChanged]: RuntimeHealthChangedPayload;
  [AGENT_EVENTS.jobProgress]: JobProgressPayload;
  [AGENT_EVENTS.appLifecycleChanged]: AppLifecycleChangedPayload;
  [AGENT_EVENTS.defaultProfileUpdated]: DefaultProfileUpdatedPayload;
  [AGENT_EVENTS.askUserQuestion]: AskUserQuestionPayload;
  [AGENT_EVENTS.configChanged]: ConfigChangedPayload;
  [AGENT_EVENTS.nodeListChanged]: NodeListChangedPayload;
  [AGENT_EVENTS.nodeSwitched]: NodeSwitchedPayload;
  [AGENT_EVENTS.issueChanged]: IssueChangedPayload;
  [AGENT_EVENTS.layoutUpdated]: LayoutUpdatedPayload;
  [AGENT_EVENTS.routingChanged]: RoutingChangedPayload;
  [AGENT_EVENTS.rulesChanged]: RulesChangedPayload;
  [AGENT_EVENTS.coreUpgradeProgress]: CoreUpgradeProgressPayload;
  [AGENT_EVENTS.coreUpgradeFinished]: CoreUpgradeFinishedPayload;
  [AGENT_EVENTS.nodeProbeProgress]: NodeProbeProgressPayload;
  [AGENT_EVENTS.nodeProbeFinished]: NodeProbeFinishedPayload;
}

export type AgentEvent = {
  [K in keyof AgentEventMap]: { name: K; payload: AgentEventMap[K] };
}[keyof AgentEventMap];

/* ------------------------------------------------------------------ */
/* runtime_status 命令返回（runtime.md §2.5）                           */
/* ------------------------------------------------------------------ */

export interface TrafficStats {
  up_bytes: number;
  down_bytes: number;
  up_rate: number;
  down_rate: number;
  sampled_at: string;
}

export interface RuntimeSnapshot {
  /** runtime.md 的版本，和事件契约不同步，不要拿 CONTRACT_VERSION 比。 */
  contract_version: string;
  state: RuntimeState;
  mode: RuntimeMode | null;
  pid: number | null;
  upstream_version: string | null;
  uptime_seconds: number | null;
  /** 当前配置与节点（runtime.md 2.0.0）。 */
  config_id: string | null;
  config_name: string | null;
  node_id: string | null;
  node_name: string | null;
  config_hash: string | null;
  system_proxy_enabled: boolean;
  health: HealthSnapshot;
  traffic: TrafficStats | null;
  connections: number | null;
  restart_count: number;
  last_error: AivpnError | null;
  last_transition_at: string;
  /** 本地 mixed 入口端口；每次连接可能不同，UI 不得硬编码。 */
  mixed_port: number | null;
  /** 用户设置的端口被占用、本次顺延时非空；正常连接、未连接、TUN 均为 null。 */
  port_fallback: {
    requested: number;
    actual: number;
    /** occupied = 被别的软件占用；unavailable = 低端口没权限等用不了。 */
    reason: "occupied" | "unavailable";
  } | null;
  /** 连接成功时刻（ISO 8601）；未连接为 null。 */
  connected_since: string | null;
  /** 出口 IP 探测耗时，界面不展示。 */
  latency_ms: number | null;
  /** 当前节点延迟（2.4.0）；界面只显示这个。 */
  node_latency_ms: number | null;
  /** 本次连接生成配置时的 route_revision；未连接为 null。 */
  applied_route_revision: number | null;
  /** 本次运行配置实际使用的地区（小写 cc）；断开为 null。 */
  route_region: string | null;
  /** 连接期系统解析器是否已指向隧道；未连接 / 代理模式 / failed 为 null。 */
  system_dns: SystemDns | null;
  /** 不经代理测得的直连出口 IP（1.1.0）；用于对照「是否真的走了代理」。 */
  direct_ip: string | null;
}

/** 状态面板的合并视图：runtime_status 快照 + 实时应用事件。 */
export interface RuntimeView {
  state: RuntimeState;
  pid: number | null;
  upstream_version: string | null;
  uptime_seconds: number | null;
  config_id: string | null;
  config_name: string | null;
  node_id: string | null;
  node_name: string | null;
  config_hash: string | null;
  system_proxy_enabled: boolean;
  health: HealthSnapshot;
  traffic: TrafficStats | null;
  connections: number | null;
  restart_count: number;
  last_error: AivpnError | null;
  mixed_port: number | null;
  /** 本次连接是否因端口降级而顺延；只有 system_proxy 且真降级时非空。 */
  port_fallback: {
    requested: number;
    actual: number;
    reason: "occupied" | "unavailable";
  } | null;
  connected_since: string | null;
  /** 出口 IP 探测耗时，界面不展示。 */
  latency_ms: number | null;
  /** 当前节点延迟（2.4.0）；界面只显示这个。 */
  node_latency_ms: number | null;
  applied_route_revision: number | null;
  /** 本次运行配置实际使用的地区（小写 cc）；断开为 null。 */
  route_region: string | null;
  /** 连接期系统解析器是否已指向隧道；未连接 / 代理模式 / failed 为 null。 */
  system_dns: SystemDns | null;
  direct_ip: string | null;
}
