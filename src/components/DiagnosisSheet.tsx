import { useEffect, useRef, useState } from "react";
import type { RuntimeProfile, RuntimeAction } from "../agent/bridge";
import type { RuntimeView } from "../agent/protocol";
import { useFocusTrap } from "../ui/focus";
import { ProfileList } from "./ProfileList";

interface Props {
  open: boolean;
  runtime: RuntimeView;
  profiles: RuntimeProfile[];
  activeProfileId: string | null;
  hasKey: boolean;
  pending: RuntimeAction | null;
  defaultBusy: boolean;
  repairing: boolean;
  onClose: () => void;
  onConnect: () => void;
  onSwitchProfile: (profileId: string) => void;
  onRefreshDefault: () => void;
  onRestoreNetwork: () => void;
  onAskAi: () => void;
}

interface DiagnosisItem {
  label: string;
  ok: boolean;
  detail: string;
}

const CONNECTING_STATES = new Set<RuntimeView["state"]>(["starting", "restarting", "stopping"]);

export function DiagnosisSheet({
  open,
  runtime,
  profiles,
  activeProfileId,
  hasKey,
  pending,
  defaultBusy,
  repairing,
  onClose,
  onConnect,
  onSwitchProfile,
  onRefreshDefault,
  onRestoreNetwork,
  onAskAi,
}: Props) {
  const [showProfiles, setShowProfiles] = useState(false);
  const sheetRef = useRef<HTMLElement>(null);
  useFocusTrap(open, sheetRef);

  useEffect(() => {
    if (!open) return;
    setShowProfiles(false);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  const connected = runtime.state === "running" || runtime.state === "degraded";
  const noProfiles = profiles.length === 0;
  const exitIp = runtime.health.exit_ip?.trim() || null;
  const directIp = runtime.direct_ip?.trim() || null;

  return (
    <div className="sheet-backdrop" onMouseDown={onClose}>
      <aside
        ref={sheetRef}
        className="sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="diagnosis-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="sheet__head">
          <h2 id="diagnosis-title" className="sheet__title">
            网络自检
          </h2>
          <button type="button" className="sheet__close" aria-label="关闭自检" onClick={onClose}>
            ×
          </button>
        </header>

        <p className="sheet__conclusion">
          {buildConclusion(runtime, noProfiles, exitIp, directIp)}
        </p>

        <div className="sheet__label">证据</div>
        <ul className="sheet__list">
          {buildDiagnosis(runtime, exitIp, directIp).map((item) => (
            <li key={item.label} className={item.ok ? "is-ok" : ""}>
              <span className="sheet__dot" aria-hidden />
              <span className="sheet__item-label">{item.label}</span>
              <span className="sheet__item-value num">{item.detail}</span>
            </li>
          ))}
        </ul>

        {showProfiles ? (
          <div className="sheet__profiles">
            <ProfileList
              profiles={profiles}
              currentId={runtime.profile_id ?? (connected ? null : activeProfileId)}
              disabled={pending !== null}
              onSelect={(profileId) => {
                setShowProfiles(false);
                onSwitchProfile(profileId);
                onClose();
              }}
            />
          </div>
        ) : null}

        <div className="sheet__actions">
          {noProfiles ? null : (
            <>
              {!connected ? (
                <button
                  type="button"
                  className="btn btn--primary"
                  onClick={() => {
                    onConnect();
                    onClose();
                  }}
                  disabled={pending !== null}
                >
                  重新连接
                </button>
              ) : null}
              <button
                type="button"
                className="btn btn--ghost"
                onClick={() => setShowProfiles((shown) => !shown)}
              >
                换节点
              </button>
            </>
          )}
          <button
            type="button"
            className="btn btn--ghost"
            onClick={() => {
              onRefreshDefault();
              onClose();
            }}
            disabled={defaultBusy}
          >
            刷新配置
          </button>
          <button
            type="button"
            className="btn btn--ghost"
            onClick={() => {
              onRestoreNetwork();
              onClose();
            }}
            disabled={repairing}
          >
            {repairing ? "恢复中…" : "恢复网络"}
          </button>
          {hasKey ? (
            <button
              type="button"
              className="btn btn--ghost"
              onClick={() => {
                onAskAi();
                onClose();
              }}
            >
              让 AI 解释
            </button>
          ) : null}
        </div>

        <p className="sheet__note">
          {hasKey
            ? "这些是本地检查结果；需要解释时可以让 AI 判断。"
            : "没有配置 DeepSeek Key：只显示本地检查结果，不影响连接。"}
        </p>
      </aside>
    </div>
  );
}

function buildDiagnosis(
  runtime: RuntimeView,
  exitIp: string | null,
  directIp: string | null,
): DiagnosisItem[] {
  return [
    {
      label: "sing-box 进程",
      ok: runtime.health.process,
      detail: runtime.health.process
        ? `运行中${runtime.pid === null ? "" : ` · PID ${runtime.pid}`}`
        : "未运行",
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
    return "还没有节点：先导入文件，或获取测试节点。";
  }
  return "当前没有连接。";
}
