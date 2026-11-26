// 计费周期与已释放额度的纯函数（traffic-billing.md §4.0 / §4.1）。
//
// 单独成模块是为了断开 `servers.ts ↔ traffic.ts` 的循环 import：
// servers.ts 只要这四个数（周期 id、单台已释放额度），不需要上报结算那一整套。

export const GIB = 1024 ** 3;
export const DAY_MS = 24 * 3600 * 1000;
/** 额度按天释放，单台每周期最多累计 28 天（§4.1）。 */
export const RELEASE_DAYS = 28;

export interface ReleasedRow {
  transfer_gib: number | null;
  ready_at: number | null;
  billing_anchor_at: number;
  created_at: number;
  destroyed_at: number | null;
}

/** 周期 = UTC 自然月，清零点在每个 1 日 00:00 UTC（§4.0）。 */
export function cycleIdOf(now: number): string {
  const date = new Date(now);
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function cycleStartOf(cycleId: string): number {
  const [year, month] = cycleId.split("-").map(Number);
  return Date.UTC(year, month - 1, 1);
}

/**
 * 单台机器在本周期的已释放额度（§4.1）：
 * `min(月额度, 日额度 × (本周期存活天数 + 1))`，`+1` 是建机预付的那一天。
 * 存活天数只算本周期内，按整天向下取整。
 *
 * 计算截止 `destroyed_at ?? now`，周期开始前就已销毁的机器不计；
 * 因此周期内销毁的机器会把已累计额度留在账号池里（与 DO 团队级按存在秒累计一致），
 * 不按「未用额度作废」的字面读法反向多收用户。
 *
 * 额度未知（旧行 / 目录缺 transfer）返回 0：不释放额度，也不据此扣费。
 */
export function releasedBytes(server: ReleasedRow, cycleId: string, now: number): number {
  const monthly = Math.round(Math.max(0, Number(server.transfer_gib ?? 0)) * GIB);
  if (monthly <= 0) return 0;
  const cycleStart = cycleStartOf(cycleId);
  const destroyedAt = server.destroyed_at == null ? null : Number(server.destroyed_at);
  if (destroyedAt !== null && destroyedAt <= cycleStart) return 0;
  const end = destroyedAt ?? now;
  const anchor = Number(server.ready_at ?? server.billing_anchor_at ?? server.created_at ?? end);
  const from = Math.max(cycleStart, anchor);
  const days = Math.max(0, Math.floor((end - from) / DAY_MS));
  return Math.min(monthly, Math.floor((monthly / RELEASE_DAYS) * (days + 1)));
}
