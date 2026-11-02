import { useState } from "react";
import type { DefaultProfileStatus, RuntimeProfile, RuntimeAction } from "../agent/bridge";
import type { RuntimeView } from "../agent/protocol";
import { formatDate, formatDuration } from "../format";
import { useElapsedSeconds } from "../hooks/useElapsedSeconds";
import { Composer } from "./Composer";
import { ProfileList } from "./ProfileList";

interface Props {
  runtime: RuntimeView;
  profiles: RuntimeProfile[];
  /** 未连接时后端记录的上次使用节点。 */
  activeProfileId: string | null;
  hasKey: boolean;
  pending: RuntimeAction | null;
  streaming: boolean;
  statusText: string | null;
  onConnect: () => void;
  onDisconnect: () => void;
  onSwitchProfile: (profileId: string) => void;
  onImport: () => void;
  onConfigureKey: () => void;
  onDiagnose: () => void;
  onSend: (text: string) => void;
  onStop: () => void;
  defaultProfile: DefaultProfileStatus | null;
  defaultBusy: boolean;
  repairing: boolean;
  onUseDefault: () => void;
  onRefreshDefault: () => void;
  onRestoreNetwork: () => void;
}

const CONNECTING_STATES = new Set<RuntimeView["state"]>(["starting", "restarting", "stopping"]);

export function ConsoleView({
  runtime,
  profiles,
  activeProfileId,
  hasKey,
  pending,
  streaming,
  statusText,
  onConnect,
  onDisconnect,
  onSwitchProfile,
  onImport,
  onConfigureKey,
  onDiagnose,
  onSend,
  onStop,
  defaultProfile,
  defaultBusy,
  repairing,
  onUseDefault,
  onRefreshDefault,
  onRestoreNetwork,
}: Props) {
  const [showProfiles, setShowProfiles] = useState(false);
  const [diagnosisOpen, setDiagnosisOpen] = useState(false);

  const connected = runtime.state === "running" || runtime.state === "degraded";
  const connecting = CONNECTING_STATES.has(runtime.state);
  const failed = runtime.state === "failed";
  const noProfiles = profiles.length === 0;
  const elapsed = useElapsedSeconds(connected ? runtime.connected_since : null);

  const nodeName =
    runtime.profile_name ??
    profiles.find(
      (profile) => profile.id === (runtime.profile_id ?? (connected ? null : activeProfileId)),
    )?.name ??
    null;

  const exitIp = runtime.health.exit_ip?.trim() || null;
  const directIp = runtime.direct_ip?.trim() || null;

  let headline: string;
  let detail: string;
  if (failed) {
    headline = "连接失败";
    detail = runtime.last_error?.message ?? "运行时没有给出原因，可以重新连接或诊断一下。";
  } else if (connected) {
    headline = `已连接 · ${nodeName ?? "当前节点"}`;
    detail = `出口 ${exitIp ?? "未知"}${runtime.latency_ms !== null ? ` · ${runtime.latency_ms}ms` : ""}`;
  } else if (connecting) {
    headline = runtime.state === "stopping" ? "正在断开…" : `正在连接…${nodeName ? ` · ${nodeName}` : ""}`;
    detail = "正在建立安全通道，这段时间内不会改动系统代理。";
  } else if (noProfiles) {
    headline = "还没有可用的配置";
    detail = "导入一个节点文件后就能连接。官方默认配置会在下一个版本接入。";
  } else {
    headline = "未连接";
    detail = nodeName ? `上次使用：${nodeName}` : "选一个节点，或者直接告诉我要去哪儿。";
  }

  const pendingLabel = pending === null ? null : pending === "stop" ? "正在断开…" : "正在连接…";

  const primary = (() => {
    if (noProfiles) {
      return {
        label: defaultBusy ? "获取中…" : "使用官方默认配置",
        note: "需要联网；离线时可以直接导入本地文件。",
        onClick: onUseDefault,
        disabled: defaultBusy,
      };
    }
    if (connecting) {
      return {
        label: pendingLabel ?? "取消",
        note: null,
        onClick: onDisconnect,
        disabled: pending !== null,
      };
    }
    if (connected) {
      return {
        label: pendingLabel ?? "断开",
        note: null,
        onClick: onDisconnect,
        disabled: pending !== null,
      };
    }
    if (failed) {
      return {
        label: pendingLabel ?? "重新连接",
        note: null,
        onClick: onConnect,
        disabled: pending !== null,
      };
    }
    return {
      label: pendingLabel ?? "连接",
      note: null,
      onClick: onConnect,
      disabled: pending !== null,
    };
  })();

  return (
    <div className="console">
      <div className="console__scroll">
        <div className="console__card">
          <div className={`console__status console__status--${runtime.state}`}>
            <span className="console__status-dot" aria-hidden />
            <h1 className="console__headline">{headline}</h1>
            <p className="console__detail">{detail}</p>
          </div>

          <div className="console__actions">
            <button
              type="button"
              className="btn btn--primary console__primary"
              onClick={primary.onClick}
              disabled={primary.disabled}
            >
              {primary.label}
            </button>

            {noProfiles ? (
              <button type="button" className="btn btn--ghost console__secondary" onClick={onImport}>
                导入文件
              </button>
            ) : null}

            {!noProfiles && !connecting ? (
              <button
                type="button"
                className="btn btn--ghost console__secondary"
                onClick={() => setShowProfiles((open) => !open)}
              >
                换节点
              </button>
            ) : null}

            {failed ? (
              <button
                type="button"
                className="btn btn--ghost console__secondary"
                onClick={() => setDiagnosisOpen((open) => !open)}
              >
                诊断网络
              </button>
            ) : null}
          </div>

          {primary.note ? <p className="console__note">{primary.note}</p> : null}

          {connecting ? (
            <div className="console__progress" role="progressbar" aria-label="连接进度">
              <span />
            </div>
          ) : null}

          {connected ? (
            <dl className="console__facts">
              <div>
                <dt>出口 IP</dt>
                <dd>{exitIp ?? "未知"}</dd>
              </div>
              <div>
                <dt>直连 IP</dt>
                <dd>{directIp ?? "未知"}</dd>
              </div>
              <div>
                <dt>已连接</dt>
                <dd>{formatDuration(elapsed ?? runtime.uptime_seconds)}</dd>
              </div>
            </dl>
          ) : null}

          {showProfiles && !noProfiles ? (
            <div className="console__profiles">
              <ProfileList
                profiles={profiles}
                currentId={runtime.profile_id ?? (connected ? null : activeProfileId)}
                disabled={pending !== null}
                onSelect={(profileId) => {
                  setShowProfiles(false);
                  onSwitchProfile(profileId);
                }}
              />
            </div>
          ) : null}

          {diagnosisOpen ? (
            <section className="diagnosis">
              <header className="diagnosis__head">
                <h2 className="diagnosis__title">网络自检</h2>
                <button
                  type="button"
                  className="diagnosis__close"
                  aria-label="关闭自检"
                  onClick={() => setDiagnosisOpen(false)}
                >
                  ×
                </button>
              </header>
              <p className="diagnosis__conclusion">
                {buildConclusion(runtime, noProfiles, exitIp, directIp)}
              </p>
              <div className="diagnosis__evidence-label">证据</div>
              <ul className="diagnosis__list">
                {buildDiagnosis(runtime, exitIp, directIp).map((item) => (
                  <li key={item.label} className={item.ok ? "is-ok" : ""}>
                    <span className="diagnosis__dot" aria-hidden />
                    <span className="diagnosis__label">{item.label}</span>
                    <span className="diagnosis__detail">{item.detail}</span>
                  </li>
                ))}
              </ul>
              <div className="diagnosis__actions">
                {noProfiles ? (
                  <button
                    type="button"
                    className="btn btn--ghost diagnosis__action"
                    onClick={onUseDefault}
                    disabled={defaultBusy}
                  >
                    使用默认配置
                  </button>
                ) : (
                  <>
                    {!connected ? (
                      <button
                        type="button"
                        className="btn btn--ghost diagnosis__action"
                        onClick={onConnect}
                        disabled={pending !== null}
                      >
                        重新连接
                      </button>
                    ) : null}
                    <button
                      type="button"
                      className="btn btn--ghost diagnosis__action"
                      onClick={() => setShowProfiles(true)}
                    >
                      换节点
                    </button>
                  </>
                )}
                <button
                  type="button"
                  className="btn btn--ghost diagnosis__action"
                  onClick={onRefreshDefault}
                  disabled={defaultBusy}
                >
                  刷新配置
                </button>
                <button
                  type="button"
                  className="btn btn--ghost diagnosis__action"
                  onClick={onRestoreNetwork}
                  disabled={repairing}
                >
                  {repairing ? "恢复中…" : "恢复网络"}
                </button>
                {hasKey ? (
                  <button
                    type="button"
                    className="btn btn--ghost diagnosis__action"
                    onClick={() => {
                      setDiagnosisOpen(false);
                      onDiagnose();
                    }}
                  >
                    让 AI 解释
                  </button>
                ) : null}
              </div>
              <p className="diagnosis__note">
                {hasKey
                  ? "这些是本地检查结果。需要解释或下一步建议时，可以让 AI 帮你判断。"
                  : "没有配置 DeepSeek Key：这里只显示本地检查结果，不影响连接。"}
              </p>
            </section>
          ) : null}
        </div>
      </div>

      <div className="console__default">
        <span className="console__default-label">默认配置</span>
        {defaultProfile?.version ? (
          <>
            <code className="console__default-version">v{defaultProfile.version}</code>
            <span className="console__default-meta">
              {defaultProfile.nodeCount} 个节点 · 更新于 {formatDate(defaultProfile.appliedAt)}
            </span>
          </>
        ) : (
          <span className="console__default-meta">未启用（离线时属正常）</span>
        )}
        {defaultProfile?.newVersionAvailable ? (
          <span className="console__badge">有新版本</span>
        ) : null}
        <button
          type="button"
          className="console__default-refresh"
          onClick={onRefreshDefault}
          disabled={defaultBusy}
        >
          {defaultBusy ? "检查中…" : "检查更新"}
        </button>
      </div>

      <div className="console__entries">
        <button
          type="button"
          className="console__entry"
          onClick={() => setDiagnosisOpen((open) => !open)}
        >
          诊断网络
        </button>
        <button
          type="button"
          className="console__entry console__entry--warn"
          onClick={onRestoreNetwork}
          disabled={repairing}
        >
          {repairing ? "恢复中…" : "恢复网络"}
        </button>
        <button type="button" className="console__entry" onClick={onImport}>
          导入配置
        </button>
      </div>

      <Composer
        streaming={streaming}
        statusText={statusText}
        onSend={onSend}
        onStop={onStop}
        placeholder="告诉我要去哪儿，或者让我诊断网络问题"
        disabled={!hasKey}
        onConfigure={onConfigureKey}
      />
    </div>
  );
}

interface DiagnosisItem {
  label: string;
  ok: boolean;
  detail: string;
}

/** 本地自检：全部来自 RuntimeView，不依赖 AI，也不发网络请求。 */
function buildDiagnosis(
  runtime: RuntimeView,
  exitIp: string | null,
  directIp: string | null,
): DiagnosisItem[] {
  return [
    {
      label: "sing-box 进程",
      ok: runtime.health.process,
      detail: runtime.health.process ? `运行中${runtime.pid === null ? "" : ` · PID ${runtime.pid}`}` : "未运行",
    },
    {
      label: "控制面",
      ok: runtime.health.clash_api,
      detail: runtime.health.clash_api ? "可访问" : "不可访问",
    },
    {
      label: "数据面",
      ok: runtime.health.data_plane,
      detail: runtime.health.data_plane ? "通" : "不通",
    },
    {
      label: "本地端口",
      ok: runtime.mixed_port !== null,
      detail: runtime.mixed_port === null ? "没有监听端口" : `127.0.0.1:${runtime.mixed_port}`,
    },
    {
      label: "系统代理",
      ok: runtime.system_proxy_enabled,
      detail: runtime.system_proxy_enabled ? "已接管" : "未接管",
    },
    { label: "出口 IP", ok: exitIp !== null, detail: exitIp ?? "未测到" },
    { label: "直连 IP", ok: directIp !== null, detail: directIp ?? "未测到" },
  ];
}

/** 诊断结论：一句话说清「现在能不能上网、该找谁」。 */
function buildConclusion(
  runtime: RuntimeView,
  noProfiles: boolean,
  exitIp: string | null,
  directIp: string | null,
): string {
  if (runtime.state === "failed") {
    return `连接失败：${runtime.last_error?.message ?? "运行时没有给出原因"}`;
  }
  if (runtime.state === "running" || runtime.state === "degraded") {
    if (!runtime.health.clash_api || !runtime.health.data_plane) {
      return "连接存在，但健康检查没有通过。建议重新连接。";
    }
    if (exitIp && directIp && exitIp === directIp) {
      return "出口与直连 IP 相同：流量可能没有经过代理。建议重新连接或恢复网络。";
    }
    return `连接正常：出口 ${exitIp ?? "未知"}，与直连 ${directIp ?? "未知"} 不同。`;
  }
  if (CONNECTING_STATES.has(runtime.state)) {
    return "正在连接，等状态稳定后再判断。";
  }
  if (noProfiles) {
    return "还没有节点：先导入文件，或获取官方默认配置。";
  }
  return "当前没有连接。点击「重新连接」开始。";
}
