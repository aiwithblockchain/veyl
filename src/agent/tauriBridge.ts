import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type {
  AgentBridge,
  ChatHistory,
  DeepSeekKeyState,
  RenamedSession,
  StoredChatMessage,
  StoredSessionSummary,
} from "./bridge";
import { toBridgeError } from "./errors";
import { createListenerManager } from "./listeners";
import { AGENT_EVENTS, APP_EVENT_NAMES, AI_EVENT_NAMES } from "./protocol";
import type { AgentEvent, RuntimeSnapshot } from "./protocol";

const EVENT_NAMES = [...AI_EVENT_NAMES, ...APP_EVENT_NAMES];

/** 统一的 invoke 包装：失败一律抛 `BridgeError`，调用方只需要看 code / message。 */
async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(command, args);
  } catch (error) {
    throw toBridgeError(error);
  }
}

/**
 * Host 侧 Tauri 通道。命令名与事件名以 `docs/contracts/events.md` 为准（已冻结）；
 * 监听器生命周期与错误归一化的写法对齐 TweetPilot 的 `services/ai/tauri.ts`。
 */
export class TauriAgentBridge implements AgentBridge {
  readonly mode = "tauri" as const;

  private listeners = new Set<(event: AgentEvent) => void>();
  private manager = createListenerManager();
  private bootstrapped = false;

  constructor() {
    void this.bootstrap();
  }

  private async bootstrap() {
    if (this.bootstrapped) return;
    this.bootstrapped = true;

    for (const name of EVENT_NAMES) {
      await this.manager.listen(
        name,
        listen<unknown>(name, (event) => {
          const payload = event.payload as AgentEvent["payload"];
          for (const listener of this.listeners) {
            listener({ name, payload } as AgentEvent);
          }
        }),
      );
    }
  }

  subscribe(listener: (event: AgentEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async getRuntimeSnapshot(): Promise<RuntimeSnapshot | null> {
    try {
      return await call<RuntimeSnapshot>("runtime_status");
    } catch {
      // 状态面板拿不到快照时保持 idle，不打断对话。
      return null;
    }
  }

  async sendMessage(sessionId: string, text: string): Promise<{ requestId: string }> {
    const response = await call<{ request_id: string }>("ai_send_message", { sessionId, text });
    return { requestId: response.request_id };
  }

  async cancel(requestId: string): Promise<void> {
    await call("ai_cancel", { requestId });
  }

  async deleteProfile(profileId: string): Promise<void> {
    await call("profile_delete", { profileId });
  }

  async getChatHistory(sessionId?: string): Promise<ChatHistory> {
    try {
      const raw = await call<{
        sessions: StoredSessionSummary[];
        active_session_id: string | null;
        messages: StoredChatMessage[];
      }>("chat_history", sessionId ? { sessionId } : undefined);

      return {
        sessions: raw.sessions ?? [],
        activeSessionId: raw.active_session_id ?? null,
        messages: raw.messages ?? [],
      };
    } catch {
      // 读历史失败不该拦住应用启动，降级成「没有历史」。
      return { sessions: [], activeSessionId: null, messages: [] };
    }
  }

  async renameSession(sessionId: string, title: string): Promise<RenamedSession> {
    const raw = await call<{ id: string; title: string; created_at: string }>("rename_session", {
      sessionId,
      title,
    });
    const parsed = Date.parse(raw.created_at);
    return {
      id: raw.id,
      title: raw.title,
      createdAt: Number.isFinite(parsed) ? parsed : Date.now(),
    };
  }

  async getDeepSeekKey(): Promise<DeepSeekKeyState> {
    try {
      const raw = await call<{ configured: boolean; masked: string | null }>(
        "deepseek_key_status",
      );
      return {
        masked: raw.configured ? raw.masked ?? null : null,
        // 本机存着只能说明「配置过」，是否仍然有效要再验一次才知道。
        verified: false,
        validation: "unverified",
      };
    } catch {
      return { masked: null, verified: false, validation: "unverified" };
    }
  }

  async saveDeepSeekKey(key: string): Promise<DeepSeekKeyState> {
    const raw = await call<{ masked?: string; verified?: boolean }>("deepseek_save_key", { key });
    const verified = raw.verified === true;
    // 只用后端给的 masked，不在前端拼 Key。
    return {
      masked: raw.masked ?? null,
      verified,
      validation: verified ? "ok" : "unverified",
    };
  }

  async clearDeepSeekKey(): Promise<void> {
    await call("deepseek_clear_key");
  }

  dispose(): void {
    this.manager.dispose();
    this.listeners.clear();
  }
}

/** 供调试面板展示：当前订阅的事件名。 */
export const SUBSCRIBED_EVENTS = EVENT_NAMES;
export { AGENT_EVENTS };
