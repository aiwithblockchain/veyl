import { useEffect, useRef, useState } from "react";

interface Props {
  streaming: boolean;
  statusText: string | null;
  onSend: (text: string) => void;
  onStop: () => void;
  placeholder?: string;
  /** 没有可用 AI 时禁用输入，并给出配置入口。 */
  disabled?: boolean;
  onConfigure?: () => void;
}

export function Composer({
  streaming,
  statusText,
  onSend,
  onStop,
  placeholder = "说「连到日本」，或者问我现在什么状态",
  disabled = false,
  onConfigure,
}: Props) {
  const [value, setValue] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const node = textareaRef.current;
    if (!node) return;
    node.style.height = "auto";
    node.style.height = `${Math.min(node.scrollHeight, 200)}px`;
  }, [value]);

  const submit = () => {
    const text = value.trim();
    if (!text || streaming || disabled) return;
    setValue("");
    onSend(text);
  };

  return (
    <div className={`composer ${disabled ? "is-disabled" : ""}`}>
      <div className="composer__box">
        <textarea
          ref={textareaRef}
          value={value}
          rows={1}
          placeholder={disabled ? "配置 AI 后可以直接对话" : placeholder}
          disabled={disabled}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              submit();
            }
          }}
        />
        <div className="composer__actions">
          {streaming ? (
            <button type="button" className="btn btn--ghost" onClick={onStop}>
              停止
            </button>
          ) : null}
          <button
            type="button"
            className="btn btn--primary btn--send"
            disabled={disabled || streaming || value.trim().length === 0}
            onClick={submit}
          >
            发送
          </button>
        </div>
      </div>
      <div className="composer__hint">
        {statusText ? <span className="composer__status">{statusText}</span> : null}
        {disabled && onConfigure ? (
          <button type="button" className="composer__configure" onClick={onConfigure}>
            去配置 Key
          </button>
        ) : (
          <span>Enter 发送 · Shift + Enter 换行</span>
        )}
      </div>
    </div>
  );
}
