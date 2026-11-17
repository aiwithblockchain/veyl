import { useEffect, useRef, useState } from "react";
import type { ConfigConnectMode, ConfigRouteMode } from "../agent/protocol";

export interface ModeSwitchResult {
  ok: boolean;
  /** 后端回滚结果：true=已回到旧模式，false=库里已是新模式，null=未知（已按库值重读）。 */
  restored?: boolean | null;
  /** 失败时按库读到的真实接管方式。 */
  actualMode?: ConfigConnectMode | null;
  message?: string;
}

interface Props {
  connectMode: ConfigConnectMode;
  routingMode: ConfigRouteMode | null;
  /** 已连上：切换接管方式会断线，先就地确认。 */
  connected: boolean;
  /** 连接中/断开中：接管方式不可切。 */
  modeLocked: boolean;
  /** 运行时正在准备后台组件：模式行显示授权中。 */
  helperPreparing: boolean;
  onSetConnectMode: (
    mode: ConfigConnectMode,
    options?: { onRestoring?: () => void },
  ) => Promise<ModeSwitchResult>;
  onSetRoutingMode: (mode: "direct" | "proxy_all") => Promise<{ ok: boolean; message?: string }>;
  onReportProblem?: () => void;
  reportBusy?: boolean;
}

const ANNOUNCE_MS = 1500;

function modeLabel(mode: ConfigConnectMode): string {
  return mode === "tun" ? "Tun 模式" : "Proxy 模式";
}

function scopeLabel(mode: ConfigRouteMode | null): string {
  return mode === "proxy_all" ? "全局" : "智能";
}

/**
 * 主按钮下方一行：接管方式 · 流量范围。
 * 纯文字读数形态，点值切到另一个；接管方式会动到当前连接，按后果就地确认。
 */
export function StageQuickToggles({
  connectMode,
  routingMode,
  connected,
  modeLocked,
  helperPreparing,
  onSetConnectMode,
  onSetRoutingMode,
  onReportProblem,
  reportBusy = false,
}: Props) {
  const [pending, setPending] = useState<ConfigConnectMode | null>(null);
  const [switching, setSwitching] = useState<ConfigConnectMode | null>(null);
  const [restoring, setRestoring] = useState(false);
  const [scopeBusy, setScopeBusy] = useState(false);
  const [notice, setNotice] = useState<{ kind: "ok" | "error"; text: string } | null>(
    null,
  );
  const confirmRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const noticeTimer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (noticeTimer.current !== null) window.clearTimeout(noticeTimer.current);
    },
    [],
  );

  const announce = (text: string) => {
    if (noticeTimer.current !== null) window.clearTimeout(noticeTimer.current);
    setNotice({ kind: "ok", text });
    noticeTimer.current = window.setTimeout(() => setNotice(null), ANNOUNCE_MS);
  };

  const commitMode = async (target: ConfigConnectMode) => {
    setPending(null);
    setNotice(null);
    setSwitching(target);
    setRestoring(false);
    const result = await onSetConnectMode(target, {
      onRestoring: () => setRestoring(true),
    });
    setRestoring(false);
    setSwitching(null);
    if (result.ok) {
      announce(`已切到 ${modeLabel(target)}`);
      return;
    }
    const backLabel = modeLabel(connectMode);
    let text: string;
    if (result.restored === false) {
      text = `没能切换到 ${modeLabel(target)}，连接已断开。`;
    } else if (result.restored === true) {
      text = `没能切换到 ${modeLabel(target)}，已回到 ${backLabel}。`;
    } else if (result.actualMode === target) {
      text = `没能切换到 ${modeLabel(target)}，连接已断开。`;
    } else if (result.actualMode === connectMode) {
      text = `没能切换到 ${modeLabel(target)}，已回到 ${backLabel}。`;
    } else {
      // 回滚结果与库值都读不到：不猜「已回到」，也不断言断线。
      text = `没能切换到 ${modeLabel(target)}，连接状态未知。`;
    }
    setNotice({ kind: "error", text });
  };

  const requestMode = (target: ConfigConnectMode) => {
    if (modeLocked || switching !== null) return;
    // 切到 Tun 一定会动到接管方式；已连接时切回 Proxy 同样会断线。
    if (target === "tun" || connected) {
      setPending(target);
      return;
    }
    void commitMode(target);
  };

  const changeScope = async (next: "direct" | "proxy_all") => {
    if (scopeBusy) return;
    setNotice(null);
    setScopeBusy(true);
    const result = await onSetRoutingMode(next);
    setScopeBusy(false);
    if (result.ok) {
      announce(`已切到${scopeLabel(next)}`);
    } else {
      setNotice({
        kind: "error",
        text: result.message ?? "没切成功，还是原来的范围。",
      });
    }
  };

  // 确认条：焦点先落在取消；Esc 取消（助手面板内先归助手），点条外取消。
  useEffect(() => {
    if (!pending) return;
    cancelRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      const active = document.activeElement as HTMLElement | null;
      if (active?.closest(".ai-panel")) return;
      event.stopPropagation();
      setPending(null);
    };
    const onPointerDown = (event: PointerEvent) => {
      const bar = confirmRef.current;
      if (bar && !bar.contains(event.target as Node)) setPending(null);
    };
    window.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, [pending]);

  const busyText = restoring
    ? "正在恢复…"
    : helperPreparing
      ? "正在请求系统授权…"
      : switching !== null
        ? `正在切换到 ${modeLabel(switching)}…`
        : null;
  // 旧数据的 proxy_selected 没有智能/全局二选一（同 TrafficScopeSwitch）：不显示范围按钮。
  const scopeSwitchable = routingMode === "direct" || routingMode === "proxy_all";

  return (
    <div className="stage-quick">
      {busyText ? (
        <p className="stage-quick__busy" role="status" aria-live="polite">
          {busyText}
        </p>
      ) : (
        <div className="stage-quick__row">
          <button
            type="button"
            className="stage-quick__value"
            aria-label={`切换接管方式，当前 ${modeLabel(connectMode)}`}
            disabled={modeLocked}
            onClick={() =>
              requestMode(connectMode === "tun" ? "system_proxy" : "tun")
            }
          >
            {modeLabel(connectMode)}
          </button>
          {scopeSwitchable ? (
            <>
              <span className="stage-quick__sep" aria-hidden="true">
                ·
              </span>
              <button
                type="button"
                className="stage-quick__value"
                aria-label={`切换流量范围，当前 ${scopeLabel(routingMode)}`}
                disabled={scopeBusy}
                onClick={() =>
                  void changeScope(routingMode === "proxy_all" ? "direct" : "proxy_all")
                }
              >
                {scopeLabel(routingMode)}
              </button>
            </>
          ) : null}
        </div>
      )}

      {pending ? (
        <div className="stage-quick-confirm" ref={confirmRef}>
          <p className="stage-quick-confirm__text">
            {pending === "tun"
              ? connected
                ? "切到 Tun 模式？接管全部软件，会短暂断开当前连接。"
                : "切到 Tun 模式？接管全部软件；首次使用需要系统授权。"
              : "切回 Proxy 模式？会短暂断开当前连接。"}
          </p>
          <div className="stage-quick-confirm__actions">
            <button
              ref={cancelRef}
              type="button"
              className="stage-quick-confirm__cancel"
              onClick={() => setPending(null)}
            >
              取消
            </button>
            <button
              type="button"
              className="stage-quick-confirm__go"
              onClick={() => void commitMode(pending)}
            >
              继续
            </button>
          </div>
        </div>
      ) : null}

      {notice ? (
        <p
          className={`stage-quick__notice${
            notice.kind === "error" ? " is-error" : ""
          }`}
          role={notice.kind === "error" ? "alert" : "status"}
        >
          {notice.text}
          {notice.kind === "error" && onReportProblem ? (
            <button
              type="button"
              className="stage-note__link"
              onClick={onReportProblem}
              disabled={reportBusy}
            >
              报告问题
            </button>
          ) : null}
        </p>
      ) : null}
    </div>
  );
}
