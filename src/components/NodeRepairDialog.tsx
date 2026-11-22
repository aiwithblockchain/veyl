import { useEffect, useRef } from "react";
import { useFocusTrap } from "../ui/focus";
import { useT } from "../i18n";
import { IconClose } from "./icons";

interface Props {
  /** 弹窗说明里不带节点名；名称只用于 aria-label。 */
  nodeName: string;
  onCancel: () => void;
  onConfirm: () => void;
  /** 次按钮：先静默同步凭据并重测，不执行破坏性的端口轮换。 */
  onSync?: () => void;
}

/**
 * 连接页「智能修复」的破坏性确认：沿用 QuitDialog 的骨架与样式，
 * 默认焦点在「取消」，Esc / 关闭 / 点背景都按取消。
 */
export function NodeRepairDialog({ nodeName, onCancel, onConfirm, onSync }: Props) {
  const t = useT();
  const dialogRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

  useFocusTrap(true, dialogRef);

  useEffect(() => {
    cancelRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onCancel]);

  return (
    <div className="quit-backdrop" onMouseDown={onCancel}>
      <div
        ref={dialogRef}
        className="quit-dialog quit-dialog--repair"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="node-repair-title"
        aria-describedby="node-repair-desc"
        aria-label={t("connection.repair.ariaRepair", { name: nodeName })}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="quit-dialog__head">
          <h2 id="node-repair-title" className="quit-dialog__title">
            {t("connection.repair.title")}
          </h2>
          <button
            type="button"
            className="quit-dialog__close"
            aria-label={t("common.close")}
            title={t("common.close")}
            onClick={onCancel}
          >
            <IconClose size={14} />
          </button>
        </header>

        <p id="node-repair-desc" className="quit-dialog__text">
          {t("connection.repair.body")}
        </p>

        {onSync ? (
          <p className="quit-dialog__text quit-dialog__text--hint">
            {t("connection.repair.syncHint")}{" "}
            <button
              type="button"
              className="quit-dialog__link"
              onClick={onSync}
            >
              {t("connection.repair.sync")}
            </button>
          </p>
        ) : null}

        <div className="quit-dialog__actions">
          <button
            ref={cancelRef}
            type="button"
            className="btn btn--ghost quit-dialog__btn"
            onClick={onCancel}
          >
            {t("common.cancel")}
          </button>
          <button
            type="button"
            className="btn btn--danger-ghost quit-dialog__btn"
            onClick={onConfirm}
          >
            {t("detail.repair")}
          </button>
        </div>
      </div>
    </div>
  );
}
