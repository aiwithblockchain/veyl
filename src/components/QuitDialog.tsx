import { Fragment, useEffect, useRef } from "react";
import type { QuitDecisionAction } from "../agent/bridge";
import { useFocusTrap } from "../ui/focus";
import { useT } from "../i18n";
import type { MessageKey } from "../i18n";
import { IconClose } from "./icons";

interface Props {
  /** 命令在途：挡住重复点击与所有取消入口。 */
  busy: boolean;
  /** 回传失败时的提示；有值时留在弹窗里让用户重试。 */
  error: string | null;
  /** 只有已连接时「退出」才真的断开网络；未连接时两行说的是另一件事。 */
  connected: boolean;
  onDecision: (action: QuitDecisionAction) => void;
}

/** 两行「按钮名 + 结果」按连接状态取词，不在 JSX 里拼字符串。 */
const ROWS: Record<"connected" | "disconnected", Array<{ label: MessageKey; value: MessageKey }>> = {
  connected: [
    { label: "quit.background.label", value: "quit.background.connected" },
    { label: "quit.quit.label", value: "quit.quit.connected" },
  ],
  disconnected: [
    { label: "quit.background.label", value: "quit.background.disconnected" },
    { label: "quit.quit.label", value: "quit.quit.disconnected" },
  ],
};

/**
 * Host 拦截到退出请求（`quit-requested`）时的确认弹窗。
 * 取消类操作一律回 `background`：用户没说退出，就别替他退出。
 */
export function QuitDialog({ busy, error, connected, onDecision }: Props) {
  const t = useT();
  const dialogRef = useRef<HTMLDivElement>(null);
  const primaryRef = useRef<HTMLButtonElement>(null);
  const rows = connected ? ROWS.connected : ROWS.disconnected;

  useFocusTrap(true, dialogRef);

  // 焦点陷阱默认落在第一个可聚焦元素（×）；这里按要求移到主按钮。
  useEffect(() => {
    primaryRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) onDecision("background");
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [busy, onDecision]);

  const decide = (action: QuitDecisionAction) => {
    if (!busy) onDecision(action);
  };

  return (
    <div
      className="quit-backdrop"
      onMouseDown={() => {
        if (!busy) onDecision("background");
      }}
    >
      <div
        ref={dialogRef}
        className="quit-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-busy={busy || undefined}
        aria-labelledby="quit-dialog-title"
        aria-describedby="quit-dialog-desc"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="quit-dialog__head">
          <h2 id="quit-dialog-title" className="quit-dialog__title">
            {t("quit.title")}
          </h2>
          <button
            type="button"
            className="quit-dialog__close"
            aria-label={t("common.close")}
            title={t("common.close")}
            disabled={busy}
            onClick={() => decide("background")}
          >
            <IconClose size={14} />
          </button>
        </header>

        <dl id="quit-dialog-desc" className="quit-dialog__body">
          {rows.map((row) => (
            <Fragment key={row.label}>
              <dt className="quit-dialog__label">{t(row.label)}</dt>
              <dd className="quit-dialog__value">{t(row.value)}</dd>
            </Fragment>
          ))}
        </dl>

        {error ? (
          <p className="quit-dialog__error" role="alert">
            {error}
          </p>
        ) : null}

        <div className="quit-dialog__actions">
          <button
            type="button"
            className={`btn quit-dialog__btn ${connected ? "btn--danger-ghost" : "btn--ghost"}`}
            disabled={busy}
            onClick={() => decide("quit")}
          >
            {t("quit.quit.label")}
          </button>
          <button
            ref={primaryRef}
            type="button"
            className="btn btn--primary quit-dialog__btn"
            disabled={busy}
            onClick={() => decide("background")}
          >
            {t("quit.background.label")}
          </button>
        </div>
      </div>
    </div>
  );
}
