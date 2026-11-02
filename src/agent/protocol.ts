/**
 * 事件与 UI → Host 调用的前端契约。
 *
 * 唯一来源：`docs/contracts/events.md` v1.0.7（已冻结）。
 * 本文件是事件名常量的唯一来源——组件、store、bridge 只能引用
 * `AGENT_EVENTS.*`，不得出现事件名字符串字面量（契约 §9.1）。
 */

export const CONTRACT_VERSION = "1.0.7" as const;

export const AGENT_EVENTS = {
  messageChunk: "message-chunk",
  thinkingChunk: "thinking-chunk",
  toolCallStart: "tool-call-start",
  toolCallEnd: "tool-call-end",
  status: "ai-status",
  compact: "ai-compact",
  requestEnd: "ai-request-end",
  approvalRequested: "approval-requested",
  runtimeStateChanged: "runtime-state-changed",
  runtimeHealthChanged: "runtime-health-changed",
  jobProgress: "job-progress",
} as const;

export type AgentEventName = (typeof AGENT_EVENTS)[keyof typeof AGENT_EVENTS];

/** AI 会话事件（1–7）与应用事件（8–11）分开，UI 两组都要订阅。 */
export const AI_EVENT_NAMES = [
  AGENT_EVENTS.messageChunk,
  AGENT_EVENTS.thinkingChunk,
  AGENT_EVENTS.toolCallStart,
  AGENT_EVENTS.toolCallEnd,
  AGENT_EVENTS.status,
  AGENT_EVENTS.compact,
  AGENT_EVENTS.requestEnd,
  AGENT_EVENTS.approvalRequested,
] as const;

export const APP_EVENT_NAMES = [
  AGENT_EVENTS.runtimeStateChanged,
  AGENT_EVENTS.runtimeHealthChanged,
  AGENT_EVENTS.jobProgress,
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
  | "APPROVAL_REQUIRED"
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
  contract_version: typeof CONTRACT_VERSION;
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
export type ApprovalPolicy = "never" | "always" | "first_time_per_session";
export type CallSource = "ui" | "agent";

export interface ToolCallStartPayload {
  contract_version: typeof CONTRACT_VERSION;
  request_id: string;
  assistant_message_id: string;
  tool_call_id: string;
  tool: string;
  action: string;
  permission_level: ToolPermissionLevel;
  approval_policy: ApprovalPolicy;
  source: CallSource;
  args_preview?: Record<string, unknown>;
  emitted_at: string;
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

export type ApprovalScope = "call" | "session";
export type ApprovalRisk = "low" | "medium" | "high";
export type ApprovalDecision = "allow" | "deny";

export interface ApprovalRequestedPayload {
  contract_version: typeof CONTRACT_VERSION;
  approval_id: string;
  request_id: string | null;
  session_id: string;
  tool: string;
  args_preview?: Record<string, unknown>;
  summary: string;
  risk: ApprovalRisk;
  scope: ApprovalScope;
  expires_at: string;
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
  emitted_at: string;
}

export type JobState = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export interface JobProgressPayload {
  contract_version: typeof CONTRACT_VERSION;
  job_id: string;
  kind: "core_install" | "diag";
  state: JobState;
  stage: string;
  progress: number;
  message: string | null;
  error: AivpnError | null;
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
  [AGENT_EVENTS.approvalRequested]: ApprovalRequestedPayload;
  [AGENT_EVENTS.runtimeStateChanged]: RuntimeStateChangedPayload;
  [AGENT_EVENTS.runtimeHealthChanged]: RuntimeHealthChangedPayload;
  [AGENT_EVENTS.jobProgress]: JobProgressPayload;
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
  contract_version: typeof CONTRACT_VERSION;
  state: RuntimeState;
  mode: RuntimeMode | null;
  pid: number | null;
  upstream_version: string | null;
  uptime_seconds: number | null;
  profile_id: string | null;
  config_hash: string | null;
  system_proxy_enabled: boolean;
  health: HealthSnapshot;
  traffic: TrafficStats | null;
  connections: number | null;
  restart_count: number;
  last_error: AivpnError | null;
  last_transition_at: string;
}

/** 状态面板的合并视图：runtime_status 快照 + 实时应用事件。 */
export interface RuntimeView {
  state: RuntimeState;
  pid: number | null;
  upstream_version: string | null;
  uptime_seconds: number | null;
  profile_id: string | null;
  system_proxy_enabled: boolean;
  health: HealthSnapshot;
  connections: number | null;
  restart_count: number;
  last_error: AivpnError | null;
}
