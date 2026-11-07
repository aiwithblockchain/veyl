import { useEffect, useRef, useState } from "react";

interface Props {
  streaming: boolean;
  statusText: string | null;
  onSend: (text: string) => void | boolean | Promise<void | boolean>;
  onStop: () => void;
  /** 没有可用 AI 时禁用输入，并给出配置入口。 */
  disabled?: boolean;
  onConfigure?: () => void;
  /** 递增这个值会把焦点移到输入框。 */
  focusSignal?: number;
}

export function Composer({
  streaming,
  statusText,
  onSend,
  onStop,
  disabled = false,
  onConfigure,
  focusSignal = 0,
}: Props) {
  const [value, setValue] = useState("");
  const [blockedHint, setBlockedHint] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const submittingRef = useRef(false);
  const blockedTimerRef = useRef<number | null>(null);

  useEffect(() => {
    if (!focusSignal) return;
    textareaRef.current?.focus();
  }, [focusSignal]);

  const clearBlockedHint = () => {
    if (blockedTimerRef.current !== null) {
      window.clearTimeout(blockedTimerRef.current);
      blockedTimerRef.current = null;
    }
    setBlockedHint(false);
  };

  const notifyBlocked = () => {
    if (blockedTimerRef.current !== null) {
      window.clearTimeout(blockedTimerRef.current);
    }
    setBlockedHint(true);
    blockedTimerRef.current = window.setTimeout(() => {
      blockedTimerRef.current = null;
      setBlockedHint(false);
    }, 2500);
  };

  // 回复结束就收回提示，不让它留成常驻状态。
  useEffect(() => {
    if (!streaming) clearBlockedHint();
  }, [streaming]);

  useEffect(() => () => {
    if (blockedTimerRef.current !== null) window.clearTimeout(blockedTimerRef.current);
  }, []);

  useEffect(() => {
    const node = textareaRef.current;
    if (!node) return;
    node.style.height = "auto";
    node.style.height = `${Math.min(node.scrollHeight, 200)}px`;
  }, [value]);

  const submit = () => {
    if (submittingRef.current) return;
    if (streaming) {
      notifyBlocked();
      return;
    }
    const text = value.trim();
    if (!text || disabled) return;
    submittingRef.current = true;
    setValue("");
    void Promise.resolve(onSend(text))
      .then((accepted) => {
        // 被拦下（例如上一条还在回复）：把刚打的字放回去。
        if (accepted === false) setValue((current) => current || text);
      })
      .catch(() => {})
      .finally(() => {
        submittingRef.current = false;
      });
  };

  return (
    <div className={`composer ${disabled ? "is-disabled" : ""}`}>
      <div className="composer__box">
        <textarea
          ref={textareaRef}
          value={value}
          rows={1}
          // 只在禁用时说明原因；可用时不写例句——预设的话会替用户
          // 设想下一步，而这个助手要接的是用户自己说的话。
          placeholder={disabled ? "配置 AI 后可以直接对话" : undefined}
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
          <span
            className="composer__send-wrap"
            data-testid="composer-send-wrap"
            onClick={streaming ? notifyBlocked : undefined}
          >
            <button
              type="button"
              className="btn btn--primary btn--send"
              disabled={disabled || streaming || value.trim().length === 0}
              // 禁用按钮在部分浏览器里吞掉点击；让指针落到外层，才接得到这次点击。
              style={streaming ? { pointerEvents: "none" } : undefined}
              onClick={submit}
            >
              {streaming ? "等待回复" : "发送"}
            </button>
          </span>
        </div>
      </div>
      <div className="composer__hint">
        {statusText ? <span className="composer__status">{statusText}</span> : null}
        {blockedHint ? (
          <span className="composer__blocked" role="status">
            上一条还在回复，回完再发
          </span>
        ) : disabled && onConfigure ? (
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
