import { useEffect, useRef, useState } from "react";
import { useT } from "../i18n";
import { IconClose } from "./icons";

interface Props {
  open: boolean;
  onClose: () => void;
  onOpenSettings: () => Promise<void>;
}

/** 后台助手没被系统允许时的引导：只说明去哪、怎么放行，不替用户重试。 */
export function HelperPermissionDialog({ open, onClose, onOpenSettings }: Props) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busyRef = useRef(false);
  const primaryRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    busyRef.current = false;
    setBusy(false);
    setError(null);
    primaryRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busyRef.current) onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  const openSettings = async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      await onOpenSettings();
      onClose();
    } catch {
      setError(t("helper.error"));
      busyRef.current = false;
      setBusy(false);
    }
  };

  return (
    <div
      className="modal-backdrop"
      onMouseDown={() => {
        if (!busyRef.current) onClose();
      }}
    >
      <div
        className="modal modal--confirm"
        role="dialog"
        aria-modal="true"
        aria-labelledby="helper-permission-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="modal__head">
          <h2 id="helper-permission-title" className="modal__title">
            {t("helper.title")}
          </h2>
          <button
            type="button"
            className="modal__close"
            onClick={onClose}
            aria-label={t("common.close")}
            disabled={busy}
          >
            <IconClose size={14} />
          </button>
        </header>
        <p className="confirm__text">{t("helper.body")}</p>
        {error ? (
          <p className="confirm__error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="confirm__actions">
          <button type="button" className="btn btn--ghost" onClick={onClose} disabled={busy}>
            {t("common.cancel")}
          </button>
          <button
            ref={primaryRef}
            type="button"
            className="btn btn--primary"
            onClick={() => void openSettings()}
            disabled={busy}
          >
            {t("helper.openSettings")}
          </button>
        </div>
      </div>
    </div>
  );
}
