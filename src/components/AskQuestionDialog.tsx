import { useCallback, useEffect, useRef, useState } from "react";
import type { PendingQuestion } from "../agent/bridge";
import { toBridgeError } from "../agent/errors";
import { useFocusTrap } from "../ui/focus";

interface Props {
  question: PendingQuestion | null;
  onAnswer: (answer: string) => Promise<void>;
  /** 后端 300 秒超时后已自动作废：前端直接收起，不再调用回答命令。 */
  onExpire: () => void;
}

/** 模型提问的居中模态：单选通栏按钮；关闭/Esc/稍后回答都等于跳过（回传空串）。 */
export function AskQuestionDialog({ question, onAnswer, onExpire }: Props) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const firstOptionRef = useRef<HTMLButtonElement>(null);
  const submittingRef = useRef(false);
  const expireRef = useRef(onExpire);
  expireRef.current = onExpire;
  useFocusTrap(Boolean(question), dialogRef);

  // 后端 300 秒后静默回空串；倒计时只读后端给的 expires_at。
  // 回答或 request end 会把 question 置空，cleanup 会清掉这个定时器。
  useEffect(() => {
    if (!question) return;
    const remaining = question.expiresAt - Date.now();
    if (remaining <= 0) {
      expireRef.current();
      return;
    }
    const timer = window.setTimeout(() => expireRef.current(), remaining);
    return () => window.clearTimeout(timer);
  }, [question?.questionId, question?.expiresAt]);

  useEffect(() => {
    if (!question) return;
    submittingRef.current = false;
    setSubmitting(false);
    setError(null);
    firstOptionRef.current?.focus();
  }, [question?.questionId]);

  const answer = useCallback(
    async (value: string) => {
      if (submittingRef.current) return;
      submittingRef.current = true;
      setSubmitting(true);
      setError(null);
      try {
        await onAnswer(value);
      } catch (failure) {
        const bridgeError = toBridgeError(failure);
        setError(bridgeError.message || "回答失败，请重试");
        submittingRef.current = false;
        setSubmitting(false);
      }
    },
    [onAnswer],
  );

  const skip = useCallback(() => {
    if (!submittingRef.current) void answer("");
  }, [answer]);

  useEffect(() => {
    if (!question) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") skip();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [question, skip]);

  if (!question) return null;

  return (
    <div className="ask-question-backdrop">
      <div
        ref={dialogRef}
        className="ask-question"
        role="dialog"
        aria-modal="true"
        aria-labelledby="ask-question-title"
      >
        <header className="ask-question__head">
          <h2 id="ask-question-title" className="ask-question__title">
            需要你的确认
          </h2>
          <button
            type="button"
            className="ask-question__close"
            aria-label="稍后回答"
            disabled={submitting}
            onClick={skip}
          >
            ×
          </button>
        </header>

        <p className="ask-question__text">{question.question}</p>

        {question.options.length > 0 ? (
          <div className="ask-question__options">
            {question.options.map((option, index) => (
              <button
                key={index}
                ref={index === 0 ? firstOptionRef : undefined}
                type="button"
                className="ask-question__option"
                disabled={submitting}
                onClick={() => void answer(option)}
              >
                {option}
              </button>
            ))}
          </div>
        ) : (
          <p className="ask-question__empty">模型没有给出选项，可以直接跳过。</p>
        )}

        {error ? <p className="ask-question__error">{error}</p> : null}

        <button
          type="button"
          className="ask-question__skip"
          disabled={submitting}
          onClick={skip}
        >
          稍后回答
        </button>
      </div>
    </div>
  );
}
