/**
 * 最近 60 秒速率条的数据：前端内存环形缓冲，进程重启即丢。
 * 样本来自 runtime-health-changed 的 traffic.up_rate / down_rate（字节/秒）。
 */
export interface RateSample {
  up: number;
  down: number;
}

export const RATE_CAPACITY = 30;

/** 追加一个样本，超出容量时丢最旧的。非有限值按 0 记，避免把 NaN 画进路径。 */
export function pushRateSample(
  samples: RateSample[],
  sample: RateSample,
  capacity = RATE_CAPACITY,
): RateSample[] {
  const next = [
    ...samples,
    {
      up: Number.isFinite(sample.up) ? Math.max(0, sample.up) : 0,
      down: Number.isFinite(sample.down) ? Math.max(0, sample.down) : 0,
    },
  ];
  return next.length > capacity ? next.slice(next.length - capacity) : next;
}

export interface RateChart {
  line: string;
  area: string;
}

/**
 * 把样本画成 SVG 路径。样本不足时左端留空：从右侧往左排，
 * 没有历史就只给一条贴底基线，不伪造波形。
 */
export function rateChart(
  samples: RateSample[],
  width = 700,
  height = 56,
): RateChart {
  const baseY = height - 2;
  if (samples.length === 0) {
    return {
      line: `M0,${baseY} L${width},${baseY}`,
      area: "",
    };
  }

  const totals = samples.map((sample) => sample.up + sample.down);
  const peak = Math.max(1, ...totals);
  const top = 4;
  const usable = baseY - top;
  const step = samples.length > 1 ? width / (samples.length - 1) : width;
  const startX = width - step * (samples.length - 1);

  const points = totals.map((total, index) => {
    const x = startX + step * index;
    const y = baseY - (total / peak) * usable;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });

  const line = `M${points.join(" L")}`;
  const firstX = startX.toFixed(1);
  const area = `${line} L${width},${baseY} L${firstX},${baseY} Z`;
  return { line, area };
}

/** 最新样本的即时速率文案；没有样本时返回 null。 */
export function rateLabel(samples: RateSample[]): { up: number; down: number } | null {
  const last = samples[samples.length - 1];
  return last ? { up: last.up, down: last.down } : null;
}

/**
 * 同一份 traffic 会被健康事件重复推送（出口探测、节点延迟测量都会触发 emit_health）。
 * 只有 sampled_at 推进时才记一个新样本，否则 60 秒窗口会被重复点压短。
 */
export function shouldPushRateSample(
  lastSampledAt: string | null,
  sampledAt: string | null | undefined,
): boolean {
  return Boolean(sampledAt) && sampledAt !== lastSampledAt;
}
