import type { RuntimeView } from "../agent/protocol";

export interface DeleteNotice {
  text: string;
  /** 有值时渲染「仍要删除」按钮（配置正在被连接使用）。 */
  confirmProfileId?: string;
}

const STATE_LABEL: Record<RuntimeView["state"], string> = {
  idle: "未连接",
  starting: "启动中",
  running: "已连接",
  degraded: "连接异常",
  restarting: "重启中",
  stopping: "停止中",
  failed: "已失败",
};

function formatUptime(seconds: number | null): string {
  if (seconds === null) return "—";
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

export function StatusPanel({
  status,
  onCollapse,
  onDeleteProfile,
  onConfirmDelete,
  deleteNotice,
}: {
  status: RuntimeView;
  onCollapse: () => void;
  onDeleteProfile: (profileId: string) => void;
  onConfirmDelete: (profileId: string) => void;
  deleteNotice: DeleteNotice | null;
}) {
  const checks = [
    { label: "进程", ok: status.health.process },
    { label: "控制面", ok: status.health.clash_api },
    { label: "数据面", ok: status.health.data_plane },
  ];

  // 空串也算「取不到」，统一显示「未知」，不要留空白。
  const exitIp = status.health.exit_ip?.trim() || null;

  return (
    <aside className="status-panel">
      <div className="status-panel__head">
        <span className="status-panel__title">连接状态</span>
        <button
          type="button"
          className="status-panel__collapse"
          onClick={onCollapse}
          title="收起面板"
        >
          ›
        </button>
      </div>

      <div className={`status-hero status-hero--${status.state}`}>
        <span className="status-hero__dot" aria-hidden />
        <div>
          <div className="status-hero__state">{STATE_LABEL[status.state]}</div>
          <div className="status-hero__detail">
            {status.state === "running"
              ? `出口 ${exitIp ?? "未知"}`
              : status.system_proxy_enabled
                ? "系统代理仍指向本地"
                : "系统代理未改动"}
          </div>
        </div>
      </div>

      <section className="status-section">
        <div className="status-section__label">运行时</div>
        <dl className="status-rows">
          <div>
            <dt>版本</dt>
            <dd>{status.upstream_version ?? "未安装"}</dd>
          </div>
          <div>
            <dt>PID</dt>
            <dd>{status.pid ?? "—"}</dd>
          </div>
          <div>
            <dt>运行时长</dt>
            <dd>{formatUptime(status.uptime_seconds)}</dd>
          </div>
          <div>
            <dt>重启次数</dt>
            <dd>{status.restart_count}</dd>
          </div>
        </dl>
      </section>

      <section className="status-section">
        <div className="status-section__label">健康</div>
        <ul className="health-list">
          {checks.map((item) => (
            <li key={item.label} className={item.ok ? "is-ok" : ""}>
              <span className="health-list__dot" aria-hidden />
              {item.label}
            </li>
          ))}
        </ul>
        {status.health.consecutive_failures > 0 ? (
          <p className="status-section__hint">
            连续失败 {status.health.consecutive_failures} 次
          </p>
        ) : null}
      </section>

      <section className="status-section">
        <div className="status-section__label">本地代理</div>
        <dl className="status-rows">
          <div>
            <dt>监听</dt>
            <dd>
              <code>127.0.0.1:2080</code>
            </dd>
          </div>
          <div>
            <dt>系统代理</dt>
            <dd>{status.system_proxy_enabled ? "已接管" : "未接管"}</dd>
          </div>
          <div>
            <dt>配置</dt>
            <dd className="status-rows__with-action">
              {status.profile_id ?? "—"}
              {status.profile_id ? (
                <button
                  type="button"
                  className="status-rows__danger"
                  onClick={() => onDeleteProfile(status.profile_id as string)}
                >
                  删除
                </button>
              ) : null}
            </dd>
          </div>
          <div>
            <dt>连接数</dt>
            <dd>{status.connections ?? "—"}</dd>
          </div>
        </dl>
      </section>

      {deleteNotice ? (
        <section className="status-section">
          <div className="status-section__label">提示</div>
          <p className="status-section__hint">{deleteNotice.text}</p>
          {deleteNotice.confirmProfileId ? (
            <button
              type="button"
              className="status-confirm"
              onClick={() => onConfirmDelete(deleteNotice.confirmProfileId as string)}
            >
              仍要删除
            </button>
          ) : null}
        </section>
      ) : null}

      {status.last_error ? (
        <section className="status-section status-section--error">
          <div className="status-section__label">最近错误</div>
          <p>
            <code>{status.last_error.code}</code> {status.last_error.message}
          </p>
        </section>
      ) : null}
    </aside>
  );
}
