import { useState } from "react";
import type { RuntimeProfile, RuntimeAction } from "../agent/bridge";
import type { RuntimeView } from "../agent/protocol";
import { formatDuration, formatPort } from "../format";
import { useElapsedSeconds } from "../hooks/useElapsedSeconds";
import {
  primaryAction,
  statusSentence,
  statusTone,
  toLinkState,
  toneClass,
} from "../ui/status";
import { ProfileList } from "./ProfileList";

const DETAILS_KEY = "veyl.statusPanel.details";

function readDetails(): boolean {
  try {
    return localStorage.getItem(DETAILS_KEY) === "1";
  } catch {
    return false;
  }
}

interface Props {
  status: RuntimeView;
  profiles: RuntimeProfile[];
  activeProfileId: string | null;
  pending: RuntimeAction | null;
  showPrimary: boolean;
  /** 空对话时右栏只用描边按钮，实心主按钮留给中间区域。 */
  lightPrimary?: boolean;
  compact?: boolean;
  onCollapse: () => void;
  onConnect: () => void;
  onDisconnect: () => void;
  onUseDefault: () => void;
  onSwitchProfile: (profileId: string) => void;
  onImport: () => void;
  onOpenLogs: () => void;
  onOpenDiagnosis: () => void;
  onDeleteProfile: (profileId: string) => void;
}

export function StatusPanel({
  status,
  profiles,
  activeProfileId,
  pending,
  showPrimary,
  lightPrimary = false,
  compact = false,
  onCollapse,
  onConnect,
  onDisconnect,
  onUseDefault,
  onSwitchProfile,
  onImport,
  onOpenLogs,
  onOpenDiagnosis,
  onDeleteProfile,
}: Props) {
  const [nodeOpen, setNodeOpen] = useState(false);
  const [details, setDetails] = useState(readDetails);

  const connected = status.state === "running" || status.state === "degraded";
  const degraded = status.state === "degraded";
  const link = toLinkState(status.state);
  const tone = statusTone(link, degraded);
  const noProfiles = profiles.length === 0;

  const elapsed = useElapsedSeconds(connected ? status.connected_since : null);
  const exitIp = status.health.exit_ip?.trim() || null;
  const directIp = status.direct_ip?.trim() || null;
  const currentProfileId =
    status.profile_id ?? (connected ? null : activeProfileId);
  const nodeName =
    status.profile_name ??
    profiles.find((profile) => profile.id === currentProfileId)?.name ??
    null;

  const action = primaryAction({
    state: status.state,
    hasProfiles: !noProfiles,
    pending,
    defaultBusy: false,
  });

  const subline =
    status.state === "stopping"
      ? null
      : link === "failed"
        ? status.last_error?.message ?? "运行时没有给出原因"
        : link === "connecting"
          ? "正在建立安全通道"
          : null;

  const toggleDetails = () => {
    setDetails((current) => {
      const next = !current;
      try {
        localStorage.setItem(DETAILS_KEY, next ? "1" : "0");
      } catch {
        // 存不了就只在本次会话里记住。
      }
      return next;
    });
  };

  const runPrimary = () => {
    if (action.kind === "default") onUseDefault();
    else if (action.kind === "stop") onDisconnect();
    else onConnect();
  };

  return (
    <aside className={`status-panel ${compact ? "status-panel--compact" : ""}`}>
      <div className="status-panel__head">
        <span className="status-panel__title">状态</span>
        <button
          type="button"
          className="status-panel__collapse"
          onClick={onCollapse}
          title={compact ? "关闭" : "收起面板"}
          aria-label={compact ? "关闭状态面板" : "收起状态面板"}
        >
          {compact ? "×" : "›"}
        </button>
      </div>

      <section className="panel-state">
        <div className={`panel-state__head ${toneClass(tone)}`}>
          <span className="panel-state__dot" aria-hidden />
          <span className="panel-state__sentence">
            {statusSentence(link, nodeName, degraded, status.state === "stopping")}
          </span>
        </div>
        {subline ? <p className="panel-state__sub">{subline}</p> : null}

        <div className={`link-line link-line--${link}`} aria-hidden>
          <span className="link-line__dot" />
          <span className="link-line__rail" />
          <span className="link-line__dot" />
        </div>
        <div className="link-line__labels" aria-hidden>
          <span>本机</span>
          <span>出口</span>
        </div>
      </section>

      {showPrimary ? (
        <button
          type="button"
          className={`btn ${lightPrimary ? "btn--ghost" : "btn--primary"} panel-primary`}
          onClick={runPrimary}
          disabled={action.disabled}
        >
          {action.label}
        </button>
      ) : null}

      <section className="panel-node">
        {noProfiles ? (
          <button type="button" className="panel-node__empty" onClick={onImport}>
            还没有节点 · 去添加
          </button>
        ) : (
          <>
            <button
              type="button"
              className="panel-node__row"
              aria-expanded={nodeOpen}
              onClick={() => setNodeOpen((open) => !open)}
            >
              <span className="panel-node__label">节点</span>
              <span className="panel-node__name">{nodeName ?? "由后端选择"}</span>
              <span className={`panel-node__chevron ${nodeOpen ? "is-open" : ""}`} aria-hidden>
                ⌄
              </span>
            </button>
            {nodeOpen ? (
              <ProfileList
                profiles={profiles}
                currentId={currentProfileId}
                disabled={pending !== null}
                onSelect={(profileId) => {
                  setNodeOpen(false);
                  onSwitchProfile(profileId);
                }}
              />
            ) : null}
          </>
        )}
      </section>

      <section className={`panel-facts ${connected ? "" : "is-muted"}`}>
        <div>
          <span className="panel-facts__label">出口</span>
          <span className="panel-facts__value num">{connected ? exitIp ?? "—" : "—"}</span>
        </div>
        <div>
          <span className="panel-facts__label">直连</span>
          <span className="panel-facts__value num">{connected ? directIp ?? "—" : "—"}</span>
        </div>
        <div>
          <span className="panel-facts__label">时长</span>
          <span className="panel-facts__value num">
            {formatDuration(connected ? elapsed ?? status.uptime_seconds : null)}
          </span>
        </div>
        <div>
          <span className="panel-facts__label">延迟</span>
          <span className="panel-facts__value num">
            {connected && status.latency_ms !== null ? `${status.latency_ms}ms` : "—"}
          </span>
        </div>
      </section>

      <section className="panel-details">
        <button
          type="button"
          className="panel-details__toggle"
          aria-expanded={details}
          onClick={toggleDetails}
        >
          <span className={`panel-details__chevron ${details ? "is-open" : ""}`} aria-hidden>
            ›
          </span>
          详情
        </button>

        {details ? (
          <dl className="panel-details__rows">
            <div>
              <dt>本地端口</dt>
              <dd className="num">{formatPort(status.mixed_port)}</dd>
            </div>
            <div>
              <dt>系统代理</dt>
              <dd>{status.system_proxy_enabled ? "已接管" : "未接管"}</dd>
            </div>
            <div>
              <dt>连接数</dt>
              <dd className="num">{status.connections ?? "—"}</dd>
            </div>
            <div>
              <dt>版本</dt>
              <dd className="num">{status.upstream_version ?? "未安装"}</dd>
            </div>
            <div>
              <dt>PID</dt>
              <dd className="num">{status.pid ?? "—"}</dd>
            </div>
            <div>
              <dt>配置哈希</dt>
              <dd className="num panel-details__hash">{status.config_hash ?? "—"}</dd>
            </div>
            {status.last_error ? (
              <div>
                <dt>最近错误</dt>
                <dd>
                  <code>{status.last_error.code}</code> {status.last_error.message}
                </dd>
              </div>
            ) : null}
            <div className="panel-details__actions">
              <button
                type="button"
                className="panel-details__action"
                onClick={onOpenDiagnosis}
              >
                网络自检
              </button>
              <button type="button" className="panel-details__action" onClick={onOpenLogs}>
                打开日志
              </button>
              {status.profile_id ? (
                <button
                  type="button"
                  className="panel-details__action is-danger"
                  onClick={() => onDeleteProfile(status.profile_id as string)}
                >
                  删除配置
                </button>
              ) : null}
            </div>
          </dl>
        ) : null}
      </section>
    </aside>
  );
}
