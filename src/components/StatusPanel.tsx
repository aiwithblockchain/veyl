import { useState } from "react";
import type { RuntimeProfile, RuntimeAction } from "../agent/bridge";
import type { RuntimeView } from "../agent/protocol";
import { formatDuration, formatPort } from "../format";
import { useElapsedSeconds } from "../hooks/useElapsedSeconds";
import { ProfileList } from "./ProfileList";

export interface DeleteNotice {
  text: string;
}

const ADVANCED_KEY = "veyl.statusPanel.advanced";

function readAdvanced(): boolean {
  try {
    return localStorage.getItem(ADVANCED_KEY) === "1";
  } catch {
    return false;
  }
}

const STATE_ICON: Record<RuntimeView["state"], string> = {
  idle: "○",
  starting: "↻",
  running: "✓",
  degraded: "!",
  restarting: "↻",
  stopping: "↻",
  failed: "×",
};

const CONNECTING_STATES = new Set<RuntimeView["state"]>(["starting", "restarting", "stopping"]);

export function StatusPanel({
  status,
  profiles,
  activeProfileId,
  pending,
  onCollapse,
  onConnect,
  onDisconnect,
  onSwitchProfile,
  onImport,
  onOpenLogs,
  onDeleteProfile,
  deleteNotice,
}: {
  status: RuntimeView;
  profiles: RuntimeProfile[];
  activeProfileId: string | null;
  pending: RuntimeAction | null;
  onCollapse: () => void;
  onConnect: () => void;
  onDisconnect: () => void;
  onSwitchProfile: (profileId: string) => void;
  onImport: () => void;
  onOpenLogs: () => void;
  onDeleteProfile: (profileId: string) => void;
  deleteNotice: DeleteNotice | null;
}) {
  const [nodeOpen, setNodeOpen] = useState(false);
  const [advanced, setAdvanced] = useState(readAdvanced);

  const connected = status.state === "running" || status.state === "degraded";
  const connecting = CONNECTING_STATES.has(status.state);
  const failed = status.state === "failed";
  const noProfiles = profiles.length === 0;

  const elapsed = useElapsedSeconds(connected ? status.connected_since : null);
  const exitIp = status.health.exit_ip?.trim() || null;
  // 默认配置包连接时 profile_id 为 null：此时不能回落到 activeProfileId 去高亮旧节点。
  const currentProfileId = status.profile_id ?? (connected ? null : activeProfileId);
  const nodeName =
    status.profile_name ??
    profiles.find((profile) => profile.id === currentProfileId)?.name ??
    null;

  const checks = [
    { label: "进程", ok: status.health.process },
    { label: "控制面", ok: status.health.clash_api },
    { label: "数据面", ok: status.health.data_plane },
  ];

  let sentence: string;
  if (failed) sentence = "连接失败";
  else if (connected) sentence = `已连接 · ${nodeName ?? "当前节点"}`;
  else if (connecting) sentence = status.state === "stopping" ? "正在断开…" : "正在连接…";
  else sentence = "未连接";

  let subline: string;
  if (failed) subline = status.last_error?.message ?? "运行时没有给出原因";
  else if (connected) subline = `出口 ${exitIp ?? "未知"}`;
  else if (status.system_proxy_enabled) subline = "系统代理仍指向本地";
  else subline = "系统代理未接管";

  const pendingLabel = pending === null ? null : pending === "stop" ? "正在断开…" : "正在连接…";

  let actionLabel = "连接";
  let action: () => void = onConnect;
  let actionDisabled = pending !== null || noProfiles;
  if (connecting) {
    actionLabel = pendingLabel ?? "取消";
    action = onDisconnect;
    actionDisabled = pending !== null;
  } else if (connected) {
    actionLabel = pendingLabel ?? "断开";
    action = onDisconnect;
    actionDisabled = pending !== null;
  } else if (failed) {
    actionLabel = pendingLabel ?? "重新连接";
    action = onConnect;
    actionDisabled = pending !== null || noProfiles;
  }

  const toggleAdvanced = () => {
    setAdvanced((current) => {
      const next = !current;
      try {
        localStorage.setItem(ADVANCED_KEY, next ? "1" : "0");
      } catch {
        // 存不了就只在本次会话里记住。
      }
      return next;
    });
  };

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
        <span className="status-hero__icon" aria-hidden>
          {STATE_ICON[status.state]}
        </span>
        <div className="status-hero__text">
          <div className="status-hero__state">{sentence}</div>
          <div className="status-hero__detail">{subline}</div>
        </div>
      </div>

      <button
        type="button"
        className="btn btn--primary status-panel__action"
        onClick={action}
        disabled={actionDisabled}
      >
        {actionLabel}
      </button>

      <section className="status-section">
        <button
          type="button"
          className="status-node"
          onClick={() => setNodeOpen((open) => !open)}
          aria-expanded={nodeOpen}
        >
          <span className="status-node__label">当前节点</span>
          <span className="status-node__name">
            {nodeName ?? (noProfiles ? "还没有节点" : "由后端选择")}
          </span>
          <span className={`status-node__chevron ${nodeOpen ? "is-open" : ""}`} aria-hidden>
            ⌄
          </span>
        </button>

        {nodeOpen ? (
          noProfiles ? (
            <div className="status-node__empty">
              <p>还没有节点，先导入一份配置文件。</p>
              <button type="button" className="btn btn--ghost" onClick={onImport}>
                导入配置
              </button>
            </div>
          ) : (
            <ProfileList
              profiles={profiles}
              currentId={currentProfileId}
              disabled={pending !== null}
              onSelect={(profileId) => {
                setNodeOpen(false);
                onSwitchProfile(profileId);
              }}
            />
          )
        ) : null}

        <dl className="status-rows">
          <div>
            <dt>出口 IP</dt>
            <dd>{exitIp ?? "—"}</dd>
          </div>
          <div>
            <dt>直连 IP</dt>
            <dd>{status.direct_ip ?? "—"}</dd>
          </div>
          <div>
            <dt>已连接</dt>
            <dd>{formatDuration(elapsed ?? status.uptime_seconds)}</dd>
          </div>
          <div>
            <dt>延迟</dt>
            <dd>{status.latency_ms === null ? "—" : `${status.latency_ms}ms`}</dd>
          </div>
        </dl>
      </section>

      <section className="status-section">
        <div className="status-section__label">运行状态</div>
        <ul className="health-list health-list--inline">
          {checks.map((item) => (
            <li key={item.label} className={item.ok ? "is-ok" : ""}>
              <span className="health-list__dot" aria-hidden />
              {item.label}
            </li>
          ))}
        </ul>
        {status.health.consecutive_failures > 0 ? (
          <p className="status-section__hint">连续失败 {status.health.consecutive_failures} 次</p>
        ) : null}
        <dl className="status-rows">
          <div>
            <dt>本地端口</dt>
            <dd>
              <code>{formatPort(status.mixed_port)}</code>
            </dd>
          </div>
          <div>
            <dt>系统代理</dt>
            <dd>{status.system_proxy_enabled ? "已接管" : "未接管"}</dd>
          </div>
          <div>
            <dt>连接数</dt>
            <dd>{status.connections ?? "—"}</dd>
          </div>
          <div>
            <dt>配置</dt>
            <dd className="status-rows__with-action">
              {nodeName ?? status.profile_id ?? "—"}
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
        </dl>
      </section>

      {deleteNotice ? (
        <section className="status-section">
          <div className="status-section__label">提示</div>
          <p className="status-section__hint">{deleteNotice.text}</p>
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

      <section className="status-section">
        <button
          type="button"
          className="status-section__toggle"
          onClick={toggleAdvanced}
          aria-expanded={advanced}
        >
          <span className={`status-section__chevron ${advanced ? "is-open" : ""}`} aria-hidden>
            ›
          </span>
          详细信息
          <span className="status-section__toggle-hint">版本 · PID · 日志</span>
        </button>

        {advanced ? (
          <dl className="status-rows status-rows--advanced">
            <div>
              <dt>版本</dt>
              <dd>{status.upstream_version ?? "未安装"}</dd>
            </div>
            <div>
              <dt>PID</dt>
              <dd>{status.pid ?? "—"}</dd>
            </div>
            <div>
              <dt>重启次数</dt>
              <dd>{status.restart_count}</dd>
            </div>
            <div>
              <dt>配置哈希</dt>
              <dd className="status-rows__hash">{status.config_hash ?? "—"}</dd>
            </div>
            <div>
              <dt>日志</dt>
              <dd className="status-rows__with-action">
                <button
                  type="button"
                  className="status-rows__action"
                  onClick={onOpenLogs}
                >
                  打开日志
                </button>
              </dd>
            </div>
          </dl>
        ) : null}
      </section>
    </aside>
  );
}
