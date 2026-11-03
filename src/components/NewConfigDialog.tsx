import { useEffect, useRef, useState } from "react";
import type { ConnectMode, VpnConfig } from "../config/model";
import { nameTaken, suggestedConfigName, uniqueConfigName } from "../config/model";

interface Props {
  configs: VpnConfig[];
  onClose: () => void;
  onCreate: (name: string, mode: ConnectMode) => void;
}

export function NewConfigDialog({ configs, onClose, onCreate }: Props) {
  const [mode, setMode] = useState<ConnectMode>("tun");
  const [name, setName] = useState(() =>
    uniqueConfigName(suggestedConfigName("tun"), configs),
  );
  const [nameTouched, setNameTouched] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const chooseMode = (next: ConnectMode) => {
    setMode(next);
    if (!nameTouched) {
      setName(uniqueConfigName(suggestedConfigName(next), configs));
    }
  };

  const submit = () => {
    const trimmed = name.trim();
    if (!trimmed) {
      setError("名字不能为空。");
      return;
    }
    if (nameTaken(trimmed, configs)) {
      setError("已经有一套叫这个名字的配置了。");
      return;
    }
    onCreate(trimmed, mode);
  };

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <form
        className="modal new-config"
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-config-title"
        onMouseDown={(event) => event.stopPropagation()}
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <header className="modal__head">
          <h2 id="new-config-title" className="modal__title">
            新建一套配置
          </h2>
        </header>

        <div className="new-config__modes">
          <span className="new-config__label" id="new-config-mode-label">
            接管方式
          </span>
          <div
            className="new-config__mode-row"
            role="radiogroup"
            aria-labelledby="new-config-mode-label"
          >
            <button
              type="button"
              role="radio"
              aria-checked={mode === "tun"}
              className={`new-config__mode ${mode === "tun" ? "is-selected" : ""}`}
              onClick={() => chooseMode("tun")}
            >
              <span className="new-config__mode-title">接管全部流量</span>
              <span className="new-config__mode-text">所有软件都自动走这台服务器。</span>
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={mode === "system_proxy"}
              className={`new-config__mode ${
                mode === "system_proxy" ? "is-selected" : ""
              }`}
              onClick={() => chooseMode("system_proxy")}
            >
              <span className="new-config__mode-title">只给代理地址</span>
              <span className="new-config__mode-text">
                只有填了代理设置的软件才走。
              </span>
            </button>
          </div>
        </div>

        <label className="new-config__field">
          <span className="new-config__label">名字</span>
          <input
            ref={inputRef}
            className="new-config__input"
            value={name}
            aria-label="配置名字"
            onChange={(event) => {
              setName(event.target.value);
              setNameTouched(true);
              setError(null);
            }}
          />
        </label>

        <p className="new-config__note">
          {mode === "tun"
            ? "这套会接管全部流量。以后可以在左侧随时切回来。"
            : "这套只提供一个本机代理地址，需要填代理设置的软件才走。以后可以在左侧随时切回来。"}
        </p>

        {error ? <p className="new-config__error">{error}</p> : null}

        <div className="confirm__actions">
          <button type="button" className="btn btn--ghost" onClick={onClose}>
            取消
          </button>
          <button type="submit" className="btn btn--primary">
            创建
          </button>
        </div>
      </form>
    </div>
  );
}
