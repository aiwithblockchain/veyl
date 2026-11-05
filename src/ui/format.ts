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

/** hero 计时器：HH:MM:SS。 */
export function formatClock(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) return "00:00:00";
  const seconds = Math.floor(totalSeconds);
  const pad = (value: number) => String(value).padStart(2, "0");
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds % 60)}`;
}

/** 延迟读数右侧的「刚刚检测 / N 秒前检测」。 */
export function formatCheckedAgo(iso: string | null, now: number): string {
  const at = iso ? Date.parse(iso) : Number.NaN;
  if (!Number.isFinite(at)) return "确认中…";
  const seconds = Math.max(0, Math.floor((now - at) / 1000));
  if (seconds < 5) return "刚刚检测";
  if (seconds < 60) return `${seconds} 秒前检测`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? `${minutes} 分钟前检测` : "很久没检测";
}
