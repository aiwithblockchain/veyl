/** 时长显示：面板与控制台共用，避免两处格式不一致。 */
export function formatDuration(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return "—";
  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${secs}s`;
  return `${secs}s`;
}

/** 本地端口显示，后端没给端口时不留一个假的 2080。 */
export function formatPort(port: number | null): string {
  return port === null ? "—" : `127.0.0.1:${port}`;
}

export function formatDate(iso: string | null): string {
  if (!iso) return "—";
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return "—";
  return new Date(at).toLocaleDateString("zh-CN", {
    year: "numeric",
    month: "numeric",
    day: "numeric",
  });
}

/** 安装包大小：未知或非正数返回 null，由调用方决定「大小未知」等文案。 */
export function formatByteSize(bytes: number | null): string | null {
  if (!bytes || bytes <= 0) return null;
  const mb = bytes / (1024 * 1024);
  if (mb >= 10) return `${Math.round(mb)} MB`;
  if (mb >= 1) return `${mb.toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/**
 * 升级生效时机：只有确实需要重启 App 时才提重启；
 * 否则按当前是否连接，选择「断开并重新连接」或「下次连接」。
 */
export function upgradeEffectText(restartRequired: boolean, connected: boolean): string {
  if (restartRequired) return "重启 Veyl 后生效";
  return connected ? "断开并重新连接后生效" : "下次连接时生效";
}
