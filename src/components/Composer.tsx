import { useEffect, useRef, useState } from "react";
import { isComposingEvent } from "../ui/ime";
import { useT } from "../i18n";

interface Props {
  streaming: boolean;
  statusText: string | null;
  onSend: (text: string) => void | boolean | Promise<void | boolean>;
  onStop: () => void;
  /** 有普通提问待回答：输入框照常可用，发送即回答，不显示阻塞态。 */
  questionPending?: boolean;
  /** 没有可用 AI 时禁用输入，并给出配置入口。 */
  disabled?: boolean;
  onConfigure?: () => void;
  /** 递增这个值会把焦点移到输入框。 */
  focusSignal?: number;
  /** 受控草稿：传入时由上层持有，组件重挂载也不丢；不传则自己保存。 */
  value?: string;
  onValueChange?: (text: string) => void;
}

export function Composer({
  streaming,
  statusText,
  onSend,
  onStop,
  questionPending = false,
  disabled = false,
  onConfigure,
  focusSignal = 0,
  value: controlledValue,
  onValueChange,
}: Props) {
  const t = useT();
  const [innerValue, setInnerValue] = useState("");
  const value = controlledValue ?? innerValue;
  const valueRef = useRef(value);
  valueRef.current = value;
  const setValue = (next: string) => {
    if (onValueChange) onValueChange(next);
    else setInnerValue(next);
  };
  const [blockedHint, setBlockedHint] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const submittingRef = useRef(false);
  // 中文输入法选词时按 Enter 是上屏，不是发送。
  const isComposingRef = useRef(false);
  const blockedTimerRef = useRef<number | null>(null);
  // 提问待回答时请求仍挂着，但输入框是用来回答的，不能按「等待回复」挡住。
  const blocked = streaming && !questionPending;

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
    if (blocked) {
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
        if (accepted === false) setValue(valueRef.current || text);
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
          placeholder={disabled ? t("composer.placeholderNoAi") : undefined}
          disabled={disabled}
          onChange={(event) => setValue(event.target.value)}
          onCompositionStart={() => {
            isComposingRef.current = true;
          }}
          onCompositionEnd={() => {
            isComposingRef.current = false;
          }}
          // 失焦不一定先发 compositionend：不复位会让之后按 Enter 一直发不出去。
          onBlur={() => {
            isComposingRef.current = false;
          }}
          onKeyDown={(event) => {
            if (isComposingEvent(event, isComposingRef.current)) return;
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              submit();
            }
          }}
        />
        <div className="composer__actions">
          {streaming ? (
            <button type="button" className="btn btn--ghost" onClick={onStop}>
              {t("composer.stop")}
            </button>
          ) : null}
          <span
            className="composer__send-wrap"
            data-testid="composer-send-wrap"
            onClick={blocked ? notifyBlocked : undefined}
          >
            <button
              type="button"
              className="btn btn--send"
              disabled={disabled || blocked || value.trim().length === 0}
              // 禁用按钮在部分浏览器里吞掉点击；让指针落到外层，才接得到这次点击。
              style={blocked ? { pointerEvents: "none" } : undefined}
              onClick={submit}
            >
              {blocked ? t("composer.waiting") : t("composer.send")}
            </button>
          </span>
        </div>
      </div>
      <div className="composer__hint">
        {questionPending ? (
          <span className="composer__question-hint">
            {t("composer.answerHint")}
          </span>
        ) : statusText ? (
          <span className="composer__status">{statusText}</span>
        ) : null}
        {questionPending ? null : blockedHint ? (
          <span className="composer__blocked" role="status">
            {t("composer.blocked")}
          </span>
        ) : disabled && onConfigure ? (
          <button type="button" className="composer__configure" onClick={onConfigure}>
            {t("composer.configure")}
          </button>
        ) : (
          <span>{t("composer.enterHint")}</span>
        )}
      </div>
    </div>
  );
}
