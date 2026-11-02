import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { AgentBridge } from "./bridge";
import { AGENT_EVENTS, APP_EVENT_NAMES, AI_EVENT_NAMES } from "./protocol";
import type { AgentEvent, ApprovalScope, RuntimeSnapshot } from "./protocol";

const EVENT_NAMES = [...AI_EVENT_NAMES, ...APP_EVENT_NAMES];

/** Host 侧 Tauri 通道。命令名与事件名均已冻结合同，见 docs/contracts/events.md §1、§5。 */
export class TauriAgentBridge implements AgentBridge {
  readonly mode = "tauri" as const;

  private listeners = new Set<(event: AgentEvent) => void>();
  private unlisten: UnlistenFn[] = [];

  constructor() {
    void this.bootstrap();
  }

  private async bootstrap() {
    for (const name of EVENT_NAMES) {
      const off = await listen<unknown>(name, (event) => {
        const payload = event.payload as AgentEvent["payload"];
        for (const listener of this.listeners) {
          listener({ name, payload } as AgentEvent);
        }
      });
      this.unlisten.push(off);
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
      return await invoke<RuntimeSnapshot>("runtime_status");
    } catch {
      return null;
    }
  }

  async sendMessage(sessionId: string, text: string): Promise<{ requestId: string }> {
    const response = await invoke<{ request_id: string }>("ai_send_message", {
      sessionId,
      text,
    });
    return { requestId: response.request_id };
  }

  async cancel(requestId: string): Promise<void> {
    await invoke("ai_cancel", { requestId });
  }

  async respondApproval(
    approvalId: string,
    decision: "allow" | "deny",
    scope: ApprovalScope,
  ): Promise<void> {
    await invoke("ai_approval_decision", { approvalId, decision, scope });
  }

  dispose(): void {
    for (const off of this.unlisten) off();
    this.unlisten = [];
    this.listeners.clear();
  }
}

/** 供调试面板展示：当前订阅的事件名。 */
export const SUBSCRIBED_EVENTS = EVENT_NAMES;
export { AGENT_EVENTS };
