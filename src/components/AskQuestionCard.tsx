import { useCallback, useEffect, useRef, useState } from "react";
import type { PendingQuestion } from "../agent/bridge";
import { toBridgeError } from "../agent/errors";
import { EXPLAIN_ANSWER } from "../ui/askQuestion";

interface Props {
  question: PendingQuestion;
  onAnswer: (answer: string) => unknown;
  /** 后端 15 分钟超时后已自动作废：前端直接收起，不再调用回答命令。 */
  onExpire: () => void;
  /** 已过期：卡片留在原位显示「这个问题已过期。」，选项禁用。 */
  expired?: boolean;
}

const CANCEL_LABEL =
  /^(取消|关闭|不了|暂不|暂时不|不用|稍后|先不|不创建|不升级|不更新)$/;

/** 两选一且有一个是取消，就是确认卡：没有「设置」可解释，解释答案也最容易被当成同意。 */
function isConfirmCard(options: readonly string[]): boolean {
  return options.length === 2 && options.some((option) => CANCEL_LABEL.test(option.trim()));
}

function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

/** 普通提问的内联卡片：挂在消息流末尾，不挡输入框，也不加焦点陷阱。 */
export function AskQuestionCard({ question, onAnswer, onExpire, expired = false }: Props) {
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
      if (submittingRef.current || expired || remaining <= 0) return;
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
    [onAnswer, expired, remaining],
  );

  const skip = useCallback(() => {
    if (!submittingRef.current) void answer("");
  }, [answer]);

  // 模型可能把解释文案写进选项：界面固定行只留一个，尾随空格的变体也算。
  const options = question.options.filter((option) => option.trim() !== EXPLAIN_ANSWER);
  const hasOptions = options.length > 0;
  // 墙钟到点先按下状态渲染，等 Host 把 expired 传回来时两者一致。
  const isExpired = expired || remaining <= 0;
  const showExplain = hasOptions && !isConfirmCard(options) && !isExpired;

  return (
    <section className="ask-card" aria-label="需要你的回答">
      <div className="ask-card__head">
        <p className="ask-card__question">{question.question}</p>
        {isExpired ? null : (
          <span
            className="ask-card__countdown"
            aria-label={`还剩 ${formatCountdown(remaining)}`}
          >
            剩 {formatCountdown(remaining)}
          </span>
        )}
      </div>

      {hasOptions ? (
        <div className="ask-card__options">
          {options.map((option, index) => (
            <button
              key={index}
              type="button"
              className="ask-card__option"
              disabled={submitting || isExpired}
              onClick={() => void answer(option)}
            >
              {option}
            </button>
          ))}
        </div>
      ) : isExpired ? null : (
        <p className="ask-card__hint">直接在下面说你的想法。</p>
      )}

      {showExplain ? (
        <button
          type="button"
          className="ask-card__explain"
          disabled={submitting}
          onClick={() => void answer(EXPLAIN_ANSWER)}
        >
          {EXPLAIN_ANSWER}
        </button>
      ) : null}

      {isExpired ? (
        <p className="ask-card__expired">这个问题已过期。</p>
      ) : (
        <button
          type="button"
          className="ask-card__skip"
          disabled={submitting}
          onClick={skip}
        >
          跳过
        </button>
      )}

      {error ? <p className="ask-card__error">{error}</p> : null}
    </section>
  );
}

/**
 * 问题属于另一屏时的折叠行：整行可点，回到发起提问的屏幕；
 * 倒计时照走，过期后只留一句只读提示，不再提供返回。
 */
export function QuestionAwayLine({
  away,
  onReturn,
}: {
  away: { text: string; expiresAt: number };
  onReturn?: () => void;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  if (away.expiresAt <= now) {
    return <p className="ask-card-away is-expired">这个问题已过期。</p>;
  }
  return (
    <button type="button" className="ask-card-away" onClick={onReturn}>
      {away.text}
    </button>
  );
}
