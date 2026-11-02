import { AGENT_EVENTS, CONTRACT_VERSION } from "./protocol";
import type { AgentEvent, RuntimeSnapshot, RuntimeView } from "./protocol";

export type BridgeMode = "tauri" | "mock";

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
  dispose(): void;
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
