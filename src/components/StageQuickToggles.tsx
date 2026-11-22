import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import type { ConfigConnectMode, ConfigRouteMode } from "../agent/protocol";
import { modeScopePrompt } from "../ai/advancedPrompts";
import { t as translate, useT } from "../i18n";

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
  /** 两个 chip 的「问 AI」：把当前接管方式与流量范围交给 AI 解释。 */
  onAskAi?: (prompt: string) => void;
}

type Layer = "mode" | "scope";

const ANNOUNCE_MS = 1500;

function modeLabel(mode: ConfigConnectMode): string {
  return translate(mode === "tun" ? "stage.mode.tun" : "stage.mode.proxy");
}

function scopeLabel(mode: ConfigRouteMode | null): string {
  return translate(mode === "proxy_all" ? "stage.scope.global" : "stage.scope.smart");
}

/** 10×10 的展开箭头；展开时瞬时换成 ⌃，不做旋转动画。 */
function Chevron({ open }: { open: boolean }) {
  return (
    <span className="stage-quick__arrow" aria-hidden="true">
      <svg viewBox="0 0 10 10" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
        <path d={open ? "M2.5 6.5 5 4l2.5 2.5" : "M2.5 3.5 5 6l2.5-2.5"} />
      </svg>
    </span>
  );
}

/** 菜单关闭且焦点不在助手面板时才响应 Esc。 */
function escBelongsToAssistant(): boolean {
  const active = document.activeElement as HTMLElement | null;
  return Boolean(active?.closest(".ai-panel"));
}

/**
 * 主按钮下方的两个入口：接管方式 / 流量范围。
 * 两步交互：点 chip 只展开选择层，选定后才执行；接管方式的变更再插一道就地确认。
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
  onAskAi,
}: Props) {
  const t = useT();
  const [openLayer, setOpenLayer] = useState<Layer | null>(null);
  const [pending, setPending] = useState<ConfigConnectMode | null>(null);
  const [switching, setSwitching] = useState<ConfigConnectMode | null>(null);
  const [restoring, setRestoring] = useState(false);
  const [scopeBusy, setScopeBusy] = useState(false);
  const [notice, setNotice] = useState<{ kind: "ok" | "error"; text: string } | null>(
    null,
  );
  const chipsRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const modeChipRef = useRef<HTMLButtonElement>(null);
  const scopeChipRef = useRef<HTMLButtonElement>(null);
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

  const closeLayer = (focusChip: boolean) => {
    const layer = openLayer;
    setOpenLayer(null);
    if (!focusChip) return;
    if (layer === "mode") modeChipRef.current?.focus();
    else if (layer === "scope") scopeChipRef.current?.focus();
  };

  const commitMode = async (target: ConfigConnectMode) => {
    setPending(null);
    setOpenLayer(null);
    setNotice(null);
    setSwitching(target);
    setRestoring(false);
    const result = await onSetConnectMode(target, {
      onRestoring: () => setRestoring(true),
    });
    setRestoring(false);
    setSwitching(null);
    if (result.ok) {
      announce(t("stage.switched", { target: modeLabel(target) }));
      return;
    }
    const backLabel = modeLabel(connectMode);
    let text: string;
    if (result.restored === false) {
      text = t("stage.modeFail.disconnected", { target: modeLabel(target) });
    } else if (result.restored === true) {
      text = t("stage.modeFail.restored", {
        target: modeLabel(target),
        back: backLabel,
      });
    } else if (result.actualMode === target) {
      text = t("stage.modeFail.disconnected", { target: modeLabel(target) });
    } else if (result.actualMode === connectMode) {
      text = t("stage.modeFail.restored", {
        target: modeLabel(target),
        back: backLabel,
      });
    } else {
      // 回滚结果与库值都读不到：不猜「已回到」，也不断言断线。
      text = t("stage.modeFail.unknown", { target: modeLabel(target) });
    }
    setNotice({ kind: "error", text });
  };

  /** 选定接管方式：当前值只关层；其余先确认（未连接切回 Proxy 不动当前连接，直接切）。 */
  const selectMode = (target: ConfigConnectMode) => {
    setOpenLayer(null);
    if (target === connectMode || modeLocked || switching !== null) {
      modeChipRef.current?.focus();
      return;
    }
    if (target === "tun" || connected) {
      setPending(target);
      return;
    }
    void commitMode(target);
  };

  const changeScope = async (next: "direct" | "proxy_all") => {
    if (scopeBusy) return;
    setOpenLayer(null);
    // 关层后焦点所在的选项被卸载：把焦点还给 chip，不落到 body。
    scopeChipRef.current?.focus();
    setNotice(null);
    setScopeBusy(true);
    const result = await onSetRoutingMode(next);
    setScopeBusy(false);
    if (result.ok) {
      announce(t("stage.scopeSwitched", { target: scopeLabel(next) }));
    } else {
      setNotice({
        kind: "error",
        text: result.message ?? t("stage.scopeFail"),
      });
    }
  };

  const selectScope = (target: "direct" | "proxy_all") => {
    if (target === (routingMode === "proxy_all" ? "proxy_all" : "direct")) {
      setOpenLayer(null);
      scopeChipRef.current?.focus();
      return;
    }
    void changeScope(target);
  };

  // 选择层：Esc 关闭并还焦点给 chip；点层外关闭；Tab 关闭让焦点继续走。
  useEffect(() => {
    if (!openLayer) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (escBelongsToAssistant()) return;
      if (event.key === "Escape") {
        event.stopPropagation();
        closeLayer(true);
        return;
      }
      if (event.key === "Tab") setOpenLayer(null);
    };
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (chipsRef.current?.contains(target)) return;
      if (menuRef.current?.contains(target)) return;
      setOpenLayer(null);
    };
    window.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("pointerdown", onPointerDown, true);
    };
    // closeLayer 只依赖 openLayer，随本 effect 一起重建。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openLayer]);

  // 确认条：焦点先落在取消；Esc 取消（助手面板内先归助手），点条外取消。
  useEffect(() => {
    if (!pending) return;
    cancelRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (escBelongsToAssistant()) return;
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

  const onMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Enter" || event.key === " ") {
      const focused = document.activeElement as HTMLButtonElement | null;
      if (focused?.getAttribute("role") === "option") {
        event.preventDefault();
        focused.click();
      }
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const rows = Array.from(
      menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="option"]') ?? [],
    );
    const index = rows.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === "ArrowDown" ? index + 1 : index - 1;
    rows[Math.max(0, Math.min(rows.length - 1, next))]?.focus();
  };

  const toggleLayer = (layer: Layer) => {
    setNotice(null);
    setOpenLayer((current) => (current === layer ? null : layer));
  };

  const busyText = restoring
    ? t("stage.busy.restoring")
    : helperPreparing
      ? t("stage.busy.authorizing")
      : switching !== null
        ? t("stage.busy.switching", { mode: modeLabel(switching) })
        : null;
  // 旧数据的 proxy_selected 没有智能/全局二选一（同 TrafficScopeSwitch）：不显示范围入口。
  const scopeSwitchable = routingMode === "direct" || routingMode === "proxy_all";
  const confirming = pending !== null;

  const modeOptions: Array<{ value: ConfigConnectMode; label: string }> = [
    { value: "system_proxy", label: modeLabel("system_proxy") },
    { value: "tun", label: modeLabel("tun") },
  ];
  const scopeOptions: Array<{ value: "direct" | "proxy_all"; label: string }> = [
    { value: "direct", label: scopeLabel("direct") },
    { value: "proxy_all", label: scopeLabel("proxy_all") },
  ];
  const currentScope: "direct" | "proxy_all" =
    routingMode === "proxy_all" ? "proxy_all" : "direct";

  return (
    <div className="stage-quick">
      {busyText ? (
        <p
          className="stage-quick__busy"
          role="status"
          aria-live="polite"
          aria-busy="true"
        >
          {busyText}
        </p>
      ) : (
        <div className="stage-quick__row" ref={chipsRef}>
          <button
            ref={modeChipRef}
            type="button"
            className={`stage-quick__chip${openLayer === "mode" ? " is-open" : ""}`}
            aria-haspopup="listbox"
            aria-expanded={openLayer === "mode"}
            aria-label={t("stage.modeChipAria", { mode: modeLabel(connectMode) })}
            disabled={modeLocked || confirming}
            onClick={() => toggleLayer("mode")}
          >
            {modeLabel(connectMode)}
            <Chevron open={openLayer === "mode"} />
          </button>
          {scopeSwitchable ? (
            <button
              ref={scopeChipRef}
              type="button"
              className={`stage-quick__chip${openLayer === "scope" ? " is-open" : ""}`}
              aria-haspopup="listbox"
              aria-expanded={openLayer === "scope"}
              aria-label={t("stage.scopeChipAria", { scope: scopeLabel(routingMode) })}
              disabled={scopeBusy || confirming}
              onClick={() => toggleLayer("scope")}
            >
              {scopeLabel(routingMode)}
              <Chevron open={openLayer === "scope"} />
            </button>
          ) : null}
          {scopeSwitchable && onAskAi ? (
            <button
              type="button"
              className="stage-quick__ask"
              onClick={() => onAskAi(modeScopePrompt(connectMode, routingMode))}
            >
              {t("stage.askAi")}
            </button>
          ) : null}
        </div>
      )}

      {openLayer === "mode" ? (
        <div
          className="stage-quick__menu"
          role="listbox"
          aria-label={t("stage.modeAria")}
          ref={menuRef}
          onKeyDown={onMenuKeyDown}
        >
          {modeOptions.map((option) => (
            <button
              key={option.value}
              type="button"
              role="option"
              aria-selected={option.value === connectMode}
              className="stage-quick__option"
              autoFocus={option.value === connectMode}
              onClick={() => selectMode(option.value)}
            >
              {option.label}
              {option.value === connectMode ? (
                <span className="stage-quick__check" aria-hidden="true">
                  ✓
                </span>
              ) : null}
            </button>
          ))}
        </div>
      ) : null}

      {openLayer === "scope" ? (
        <div
          className="stage-quick__menu"
          role="listbox"
          aria-label={t("stage.scopeAria")}
          ref={menuRef}
          onKeyDown={onMenuKeyDown}
        >
          {scopeOptions.map((option) => (
            <button
              key={option.value}
              type="button"
              role="option"
              aria-selected={option.value === currentScope}
              className="stage-quick__option"
              autoFocus={option.value === currentScope}
              onClick={() => selectScope(option.value)}
            >
              {option.label}
              {option.value === currentScope ? (
                <span className="stage-quick__check" aria-hidden="true">
                  ✓
                </span>
              ) : null}
            </button>
          ))}
        </div>
      ) : null}

      {pending ? (
        <div className="stage-quick-confirm" ref={confirmRef}>
          <p className="stage-quick-confirm__text">
            {pending === "tun"
              ? connected
                ? t("stage.confirm.tunConnected")
                : t("stage.confirm.tunDisconnected")
              : t("stage.confirm.proxy")}
          </p>
          <div className="stage-quick-confirm__actions">
            <button
              ref={cancelRef}
              type="button"
              className="stage-quick-confirm__cancel"
              onClick={() => setPending(null)}
            >
              {t("common.cancel")}
            </button>
            <button
              type="button"
              className="stage-quick-confirm__go"
              onClick={() => void commitMode(pending)}
            >
              {t("stage.continue")}
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
              {t("stage.reportProblem")}
            </button>
          ) : null}
        </p>
      ) : null}
    </div>
  );
}
