import type { AgentBridge } from "./bridge";
import { isTauri } from "./bridge";
import { MockAgentBridge } from "./mockAgent";
import { TauriAgentBridge } from "./tauriBridge";

let bridge: AgentBridge | null = null;

/**
 * 单例 bridge。浏览器里跑 `npm run dev` 时用 mock 事件源，
 * 在 Tauri 窗口里跑时走真实的 Host 事件流。
 */
export function getAgentBridge(): AgentBridge {
  if (!bridge) {
    bridge = isTauri() ? new TauriAgentBridge() : new MockAgentBridge();
  }
  return bridge;
}

export { applyRuntimeEvent, emptyRuntimeView, snapshotToView } from "./bridge";
