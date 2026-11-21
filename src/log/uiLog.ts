import { invoke } from "@tauri-apps/api/core";

export type UiLogLevel = "debug" | "info" | "warn" | "error";

/**
 * Host 的 `ui_log` 命令：日志只是旁路，命令缺失、被拒或非 Tauri 环境都不能影响调用方。
 * `message` 只允许调用方拼的固定模板 + 数字 / 短枚举，绝不带响应原文、令牌、邮箱。
 */
export function uiLog(
  level: UiLogLevel,
  message: string,
  target = "wallet",
): void {
  try {
    void Promise.resolve(invoke("ui_log", { level, target, message })).catch(
      () => {},
    );
  } catch {
    // 非 Tauri 环境里 invoke 同步抛：吞掉，别让日志打断刷新。
  }
}
