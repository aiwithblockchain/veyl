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
  /** DO 侧确认已不存在（迁移 0017）：额度在失联时刻封顶，之后的周期不再释放。 */
  provider_gone_at: number | null;
  /** 已付到的时刻；0 / NULL = 未结算（待建机）。额度天数不能超过已付天数。 */
  paid_until: number | null;
}

/** 周期 = UTC 自然月，清零点在每个 1 日 00:00 UTC（§4.0）。 */
export function cycleIdOf(now: number): string {
  const date = new Date(now);
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

/**
 * 计费日边界 = UTC 自然日 00:00（§4.0），与周期同一个时钟。
 *
 * 扣费与额度释放共用这一个边界：`paid_until` 每次 +1 天、始终落在 00:00，
 * 额度也只在 00:00 涨一格。两台机器什么时候建的不再影响「几点涨额度」。
 */
export function dayStartOf(at: number): number {
  return Math.floor(at / DAY_MS) * DAY_MS;
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
 * 计算截止 `min(destroyed_at, provider_gone_at, now)`：
 * 周期开始前就已销毁 / 失联的机器不计；因此周期内停掉的机器会把已累计额度留在账号池里
 * （与 DO 团队级按存在秒累计一致），不按「未用额度作废」的字面读法反向多收用户。
 *
 * 额度天数再被**已付天数**封顶：付 1 天只给 1 份，零点到下一次扣费之间不能白拿。
 *
 * 额度未知（旧行 / 目录缺 transfer）返回 0：不释放额度，也不据此扣费。
 */
export function releasedBytes(server: ReleasedRow, cycleId: string, now: number): number {
  const monthly = Math.round(Math.max(0, Number(server.transfer_gib ?? 0)) * GIB);
  if (monthly <= 0) return 0;
  const cycleStart = cycleStartOf(cycleId);
  const destroyedAt = server.destroyed_at == null ? null : Number(server.destroyed_at);
  const goneAt = server.provider_gone_at == null ? null : Number(server.provider_gone_at);
  const end = Math.min(destroyedAt ?? now, goneAt ?? now);
  if (end <= cycleStart) return 0;
  // 起算点逐级回退，**0 也要当缺失**：结算前 `billing_anchor_at = 0`（orders.ts 建 pending 行），
  // 而 `??` 只跳过 null/undefined，会让尚未建机完成的机器从月初起算、凭空拿到整月份度。
  const pick = (value: number | null | undefined) =>
    typeof value === "number" && value > 0 ? value : null;
  const settled = pick(server.ready_at) ?? pick(server.billing_anchor_at);
  // 建机阶段就能销（destroy 只拦 destroyed），而 `+1` 的预付天会让每一台「从未结算就被销毁」的
  // 机器白拿 monthly/28：造 28 台再立刻销毁 = 一个月的额度。没有结算记录就不该有额度。
  if (destroyedAt !== null && settled === null) return 0;
  // `created_at` 同样要跳过 0：真落成 0 时锚点退到 end，只剩一天份额，不会变回整月。
  const anchor = settled ?? pick(server.created_at) ?? end;
  // 起算点对齐到 UTC 自然日：额度与扣费同一个边界（迁移 0018 之前的老行由它兜住）。
  const anchorDay = dayStartOf(anchor);
  const from = Math.max(cycleStart, anchorDay);
  const endedDays = Math.max(0, Math.floor((end - from) / DAY_MS));
  // **额度天数不能超过已付天数**：`+1` 是预付的那一天，付 1 天就只能拿 1 份。
  // 没有这道上限，00:00 到下一次计费 Cron 之间有一个窗口——机器 23:17 之后建（赶不上当天那轮）、
  // 00:05 销毁，会付 1 天拿 2 份，每天可重复，28 台就是一个月额度。
  const paidUntil = server.paid_until == null ? 0 : Number(server.paid_until);
  // 未结算（paid_until 为空 / 0）的机器按 1 份算：那是待建机的展示口径；
  // 「从未结算就被销毁」的机器已经在上面归零，不会走这里。
  const paidDays =
    paidUntil > 0 ? Math.max(0, Math.floor((paidUntil - anchorDay) / DAY_MS)) : 1;
  const quotaDays = Math.min(endedDays + 1, paidDays);
  return Math.min(monthly, Math.floor((monthly / RELEASE_DAYS) * quotaDays));
}
