import { AGENT_EVENTS, CONTRACT_VERSION } from "./protocol";
import type { AgentEvent, RuntimeSnapshot, RuntimeView } from "./protocol";

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

export interface AgentBridge {
  readonly mode: BridgeMode;
  /** 订阅全部事件（AI 会话 + 应用事件）；返回取消订阅函数。 */
  subscribe(listener: (event: AgentEvent) => void): () => void;
  sendMessage(sessionId: string, text: string): Promise<{ requestId: string }>;
  cancel(requestId: string): Promise<void>;
  respondApproval(
    approvalId: string,
    decision: "allow" | "deny",
    scope: "call" | "session",
  ): Promise<void>;
  /** 事件不可达时的兜底快照（契约 §5 `runtime_status`）。 */
  getRuntimeSnapshot(): Promise<RuntimeSnapshot | null>;
  /** 无 AI 模式的删除配置入口（契约 §5 `profile_delete`）。 */
  deleteProfile(profileId: string): Promise<void>;
  /** 重启后恢复会话：不传 sessionId 时取最近一个会话。 */
  getChatHistory(sessionId?: string): Promise<ChatHistory>;
  /** 重命名会话；标题的 trim 与长度校验都由后端做。 */
  renameSession(sessionId: string, title: string): Promise<RenamedSession>;
  /** 读取 Key 的配置状态（只返回打码值，永不返回明文）。 */
  getDeepSeekKey(): Promise<DeepSeekKeyState>;
  /** 保存 Key；只进本机加密存储。 */
  saveDeepSeekKey(key: string): Promise<DeepSeekKeyState>;
  /** 从本机存储删除 Key。 */
  clearDeepSeekKey(): Promise<void>;
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
    profile_id: null,
    system_proxy_enabled: false,
    health: { ...EMPTY_HEALTH },
    connections: null,
    restart_count: 0,
    last_error: null,
  };
}

/** 把快照与事件合并成状态面板的视图。 */
export function applyRuntimeEvent(view: RuntimeView, event: AgentEvent): RuntimeView {
  switch (event.name) {
    case AGENT_EVENTS.runtimeStateChanged:
      return {
        ...view,
        state: event.payload.to,
        pid: event.payload.pid,
        upstream_version: event.payload.upstream_version ?? view.upstream_version,
        last_error: event.payload.error,
      };
    case AGENT_EVENTS.runtimeHealthChanged:
      return { ...view, health: event.payload.health };
    default:
      return view;
  }
}

export function snapshotToView(snapshot: RuntimeSnapshot): RuntimeView {
  return {
    state: snapshot.state,
    pid: snapshot.pid,
    upstream_version: snapshot.upstream_version,
    uptime_seconds: snapshot.uptime_seconds,
    profile_id: snapshot.profile_id,
    system_proxy_enabled: snapshot.system_proxy_enabled,
    health: snapshot.health,
    connections: snapshot.connections,
    restart_count: snapshot.restart_count,
    last_error: snapshot.last_error,
  };
}
