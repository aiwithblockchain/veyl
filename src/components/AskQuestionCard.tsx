import { useCallback, useEffect, useRef, useState } from "react";
import type { PendingQuestion } from "../agent/bridge";
import { toBridgeError } from "../agent/errors";

interface Props {
  question: PendingQuestion;
  onAnswer: (answer: string) => unknown;
  /** 后端 15 分钟超时后已自动作废：前端直接收起，不再调用回答命令。 */
  onExpire: () => void;
}

function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

/** 普通提问的内联卡片：挂在消息流末尾，不挡输入框，也不加焦点陷阱。 */
export function AskQuestionCard({ question, onAnswer, onExpire }: Props) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [remaining, setRemaining] = useState(() =>
    Math.max(0, question.expiresAt - Date.now()),
  );
  const submittingRef = useRef(false);
  const firedRef = useRef(false);
  const expireRef = useRef(onExpire);
  expireRef.current = onExpire;

  useEffect(() => {
    submittingRef.current = false;
    firedRef.current = false;
    setSubmitting(false);
    setError(null);
  }, [question.questionId]);

  // 倒计时只读后端给的 expires_at；到点后只触发一次超时收起。
  useEffect(() => {
    const tick = () => {
      const left = question.expiresAt - Date.now();
      setRemaining(Math.max(0, left));
      if (left <= 0 && !firedRef.current) {
        firedRef.current = true;
        expireRef.current();
      }
    };
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [question.questionId, question.expiresAt]);

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

  return (
    <section className="ask-card" aria-label="需要你的回答">
      <div className="ask-card__head">
        <p className="ask-card__question">{question.question}</p>
        <span
          className="ask-card__countdown"
          aria-label={`还剩 ${formatCountdown(remaining)}`}
        >
          剩 {formatCountdown(remaining)}
        </span>
      </div>

      {question.options.length > 0 ? (
        <div className="ask-card__options">
          {question.options.map((option, index) => (
            <button
              key={index}
              type="button"
              className="ask-card__option"
              disabled={submitting}
              onClick={() => void answer(option)}
            >
              {option}
            </button>
          ))}
        </div>
      ) : (
        <p className="ask-card__hint">直接在下面说你的想法。</p>
      )}

      <button
        type="button"
        className="ask-card__skip"
        disabled={submitting}
        onClick={skip}
      >
        跳过
      </button>

      {error ? <p className="ask-card__error">{error}</p> : null}
    </section>
  );
}
