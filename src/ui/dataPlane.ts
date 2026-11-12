import type { RuntimeView } from "../agent/protocol";

/** 健康快照的有效期；超过就当作结论未知（runtime.md §4.3）。 */
export const DATA_PLANE_FRESH_MS = 30_000;

/**
 * 已连接但没有流量。判定只在这里做一次，组件里不各写 `!health.data_plane`。
 * `degraded` 不算：它有自己的「连接不稳定」与自动重启，两个词不叠加
 * （connected-no-traffic.md §1）。
 */
export function dataPlaneDown(runtime: RuntimeView, now = Date.now()): boolean {
  if (runtime.state !== "running") return false;
  if (runtime.health.data_plane !== false) return false;
  const at = Date.parse(runtime.health.checked_at);
  return Number.isFinite(at) && now - at <= DATA_PLANE_FRESH_MS;
}
