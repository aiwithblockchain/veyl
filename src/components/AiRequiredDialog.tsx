import { useEffect, useRef } from "react";
import { useT } from "../i18n";
import { useFocusTrap } from "../ui/focus";
import { IconClose } from "./icons";

interface Props {
  open: boolean;
  onConfigure: () => void;
  onClose: () => void;
}

/** 所有「点一下让 AI 干活」的入口共用这一个告警；不重放被拦下的动作。 */
export function AiRequiredDialog({ open, onConfigure, onClose }: Props) {
  const t = useT();
  const dialogRef = useRef<HTMLDivElement>(null);
  const primaryRef = useRef<HTMLButtonElement>(null);
  useFocusTrap(open, dialogRef);

  // 排队在 trap 之后：Trap 先把焦点移入，这里再落到主按钮上。
  useEffect(() => {
    if (!open) return;
    primaryRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="modal-backdrop modal-backdrop--top" onMouseDown={onClose}>
      <div
        ref={dialogRef}
        className="modal modal--confirm"
        role="dialog"
        aria-modal="true"
        aria-labelledby="ai-required-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="modal__head">
          <h2 id="ai-required-title" className="modal__title">
            {t("aiRequired.title")}
          </h2>
          <button
            type="button"
            className="modal__close"
            onClick={onClose}
            aria-label={t("common.close")}
          >
            <IconClose size={14} />
          </button>
        </header>
        <p className="confirm__text">{t("aiRequired.body")}</p>
        <div className="confirm__actions">
          <button type="button" className="btn btn--ghost" onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button
            ref={primaryRef}
            type="button"
            className="btn btn--primary"
            onClick={onConfigure}
          >
            {t("aiRequired.configure")}
          </button>
        </div>
      </div>
    </div>
  );
}
