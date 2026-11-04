/** 时长按秒转成用户口径：<60 秒「刚刚」，<60 分钟按分钟，更长按小时 + 分钟。 */
export function formatDuration(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  if (seconds < 60) return "刚刚";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟`;
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return minutes === 0 ? `${hours} 小时` : `${hours} 小时 ${minutes} 分钟`;
}

/** 流量按字节转成用户口径：KB 取整，MB / GB 保留一位小数。 */
export function formatTraffic(bytes: number): string {
  if (!Number.isFinite(bytes)) return "—";
  const value = Math.max(0, Math.floor(bytes));
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`;
  if (value < 1024 * 1024 * 1024) {
    return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  }
  return `${(value / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/** 技术详情里的采样时间；缺失、无效或纪元值显示破折号。 */
export function formatSampleTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const at = Date.parse(iso);
  if (!Number.isFinite(at) || at <= 0) return "—";
  return new Date(at).toLocaleTimeString("zh-CN", { hour12: false });
}
