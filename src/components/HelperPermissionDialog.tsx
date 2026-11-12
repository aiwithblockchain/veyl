import { useEffect, useRef, useState } from "react";
import { IconClose } from "./icons";

interface Props {
  open: boolean;
  onClose: () => void;
  onOpenSettings: () => Promise<void>;
}

/** 后台助手没被系统允许时的引导：只说明去哪、怎么放行，不替用户重试。 */
export function HelperPermissionDialog({ open, onClose, onOpenSettings }: Props) {
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
      setError("没能打开系统设置，请手动打开「系统设置 › 通用 › 登录项与扩展」。");
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
            需要允许后台助手
          </h2>
          <button
            type="button"
            className="modal__close"
            onClick={onClose}
            aria-label="关闭"
            disabled={busy}
          >
            <IconClose size={14} />
          </button>
        </header>
        <p className="confirm__text">
          接管全部流量需要你在系统设置里允许 Veyl
          的后台助手：系统设置 › 通用 › 登录项与扩展。允许后回到这里，再点一次「启动
          VPN」。
        </p>
        {error ? (
          <p className="confirm__error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="confirm__actions">
          <button type="button" className="btn btn--ghost" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button
            ref={primaryRef}
            type="button"
            className="btn btn--primary"
            onClick={() => void openSettings()}
            disabled={busy}
          >
            打开系统设置
          </button>
        </div>
      </div>
    </div>
  );
}
