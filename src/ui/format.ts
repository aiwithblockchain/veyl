/** 时长按秒转成用户口径：<60 秒「刚刚」，<60 分钟按分钟，更长按小时 + 分钟。 */
export function formatDuration(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds)) return "—";
  const seconds = Math.max(0, Math.floor(totalSeconds));
  if (seconds < 60) return "刚刚";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟`;
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return minutes === 0 ? `${hours} 小时` : `${hours} 小时 ${minutes} 分钟`;
}

/** 两位小数精度，去掉末尾多余的 0：1.00 → 1.0，1.04 → 1.04。 */
function twoDecimals(value: number, unit: "MB" | "GB"): string {
  const fixed = value.toFixed(2);
  return `${fixed.endsWith("0") ? fixed.slice(0, -1) : fixed} ${unit}`;
}

/** 流量按字节转成用户口径：KB 上限 1023，MB / GB 保留两位小数精度。 */
export function formatTraffic(bytes: number): string {
  if (!Number.isFinite(bytes)) return "—";
  const value = Math.max(0, Math.floor(bytes));
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) {
    const kb = Math.round(value / 1024);
    if (kb < 1024) return `${kb} KB`;
  }
  if (value < 1024 * 1024 * 1024) {
    return twoDecimals(value / (1024 * 1024), "MB");
  }
  return twoDecimals(value / (1024 * 1024 * 1024), "GB");
}

/** 技术详情里的采样时间；缺失、无效或纪元值显示破折号。 */
export function formatSampleTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const at = Date.parse(iso);
  if (!Number.isFinite(at) || at <= 0) return "—";
  return new Date(at).toLocaleTimeString("zh-CN", { hour12: false });
}
