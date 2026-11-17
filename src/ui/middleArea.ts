/**
 * 中间区域共用的两句文案。
 *
 * 布局解析已随旧控制台删除：现在舞台只消费 action_card 与本地状态，
 * 这里只保留仍被 App 与连接舞台使用的纯函数。
 */
import type { RuntimeView } from "../agent/protocol";

/**
 * 失败是不是「本来连着，突然断了」。
 * 不能用 runtime.connected_since 判断：进终态时后端会把它清空，
 * 失败快照里永远是 null，只能看这次状态迁移是从哪来的。
 */
export function isDisconnectFailure(
  from: RuntimeView["state"],
  to: RuntimeView["state"],
): boolean {
  return to === "failed" && (from === "running" || from === "degraded");
}

/** 失败时 H1 下面那行小字：区分「没连上」与「连接断了」。只有这一处。 */
export function failureHeadline(wasConnected: boolean): string {
  return wasConnected ? "连接断了。" : "没有连上节点。";
}
