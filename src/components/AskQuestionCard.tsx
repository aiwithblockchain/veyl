import { useCallback, useEffect, useRef, useState } from "react";
import type { IssueSubmitConfirmData, PendingQuestion } from "../agent/bridge";
import { errorText } from "../i18n/errorText";
import { isExplainAnswer } from "../ui/askQuestion";
import { useT } from "../i18n";

interface Props {
  question: PendingQuestion;
  onAnswer: (answer: string) => unknown;
  /** 后端 15 分钟超时后已自动作废：前端直接收起，不再调用回答命令。 */
  onExpire: () => void;
  /** 已过期：卡片留在原位显示「这个问题已过期。」，选项禁用。 */
  expired?: boolean;
}

const CANCEL_LABEL =
  /^(取消|关闭|不了|暂不|暂时不|不用|稍后|先不|不创建|不升级|不更新|cancel|no|not now|later|skip|don'?t)$/i;

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

const PLATFORM_LABELS: Record<string, string> = {
  macos: "macOS",
  windows: "Windows",
  linux: "Linux",
};

function platformLabel(value: string | null): string {
  if (!value) return "";
  return PLATFORM_LABELS[value] ?? value;
}

/**
 * 问题墙上报的确认明细：只列要公开的字段，不读也不显示原始 JSON。
 * 对话框与内联卡片共用同一份。
 */
export function IssueSubmitDetails({ details }: { details: IssueSubmitConfirmData }) {
  const t = useT();
  const unknown = t("dialog.issueSubmit.empty");
  const stepLabel = (step: string | null): string => {
    switch (step) {
      case "connectivity":
        return t("dialog.issueSubmit.step.connectivity");
      case "config_update":
        return t("dialog.issueSubmit.step.config_update");
      case "rotate":
        return t("dialog.issueSubmit.step.rotate");
      default:
        return step ?? unknown;
    }
  };
  const rows = [
    ["dialog.issueSubmit.titleField", details.title],
    ["dialog.issueSubmit.summary", details.summary],
    ["dialog.issueSubmit.expected", details.expected],
    ["dialog.issueSubmit.actual", details.actual],
    ["dialog.issueSubmit.repro", details.repro],
  ] as const;
  return (
    <div className="issue-submit-detail">
      <dl className="core-confirm">
        {rows.map(([key, value]) => (
          <div className="core-confirm__row" key={key}>
            <dt>{t(key)}</dt>
            <dd>{value ?? unknown}</dd>
          </div>
        ))}
        <div className="core-confirm__row">
          <dt>{t("dialog.issueSubmit.environment")}</dt>
          <dd>
            {platformLabel(details.platform)}
            {details.platform ? " · " : ""}
            {details.appVersion ?? unknown}
          </dd>
        </div>
        {details.steps.length > 0 ? (
          <div className="core-confirm__row">
            <dt>{t("dialog.issueSubmit.steps")}</dt>
            <dd>
              <ul className="issue-submit-detail__steps">
                {details.steps.map((step, index) => (
                  <li key={`${step.step ?? "step"}-${index}`}>
                    {stepLabel(step.step)}
                    {" · "}
                    {step.ok
                      ? t("dialog.issueSubmit.stepOk")
                      : t("dialog.issueSubmit.stepFailed")}
                    {step.durationMs === null
                      ? null
                      : ` · ${
                          step.durationMs < 1000
                            ? t("tool.time.ms", { value: Math.round(step.durationMs) })
                            : t("tool.time.seconds", {
                                value: (step.durationMs / 1000).toFixed(1),
                              })
                        }`}
                  </li>
                ))}
              </ul>
            </dd>
          </div>
        ) : null}
      </dl>
      <p className="ask-question__body">{t("dialog.issueSubmit.disclosure")}</p>
    </div>
  );
}

/** 普通提问的内联卡片：挂在消息流末尾，不挡输入框，也不加焦点陷阱。 */
export function AskQuestionCard({ question, onAnswer, onExpire, expired = false }: Props) {
  const t = useT();
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
        setError(errorText(failure, t("ask.error.answer")));
        submittingRef.current = false;
        setSubmitting(false);
      }
    },
    [onAnswer, expired, remaining, t],
  );

  const skip = useCallback(() => {
    if (!submittingRef.current) void answer("");
  }, [answer]);

  // 模型可能把解释文案写进选项：界面固定行只留一个，尾随空格的变体也算。
  // 中英两种文案都认（英文界面的回传值是英文）。
  const options = question.options.filter((option) => !isExplainAnswer(option));
  const hasOptions = options.length > 0;
  // 墙钟到点先按下状态渲染，等 Host 把 expired 传回来时两者一致。
  const isExpired = expired || remaining <= 0;
  const showExplain = hasOptions && !isConfirmCard(options) && !isExpired;
  const issueSubmit =
    question.kind === "issue_submit_confirm" ? question.issueSubmitConfirm ?? null : null;

  return (
    <section className="ask-card" aria-label={t("ask.cardAria")}>
      <div className="ask-card__head">
        <p className="ask-card__question">{question.question}</p>
        {isExpired ? null : (
          <span
            className="ask-card__countdown"
            aria-label={t("ask.countdownAria", { time: formatCountdown(remaining) })}
          >
            {t("ask.countdown", { time: formatCountdown(remaining) })}
          </span>
        )}
      </div>

      {issueSubmit ? <IssueSubmitDetails details={issueSubmit} /> : null}

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
        <p className="ask-card__hint">{t("ask.hint")}</p>
      )}

      {showExplain ? (
        <button
          type="button"
          className="ask-card__explain"
          disabled={submitting}
          onClick={() => void answer(t("ask.explain"))}
        >
          {t("ask.explain")}
        </button>
      ) : null}

      {isExpired ? (
        <p className="ask-card__expired">{t("ask.expired")}</p>
      ) : (
        <button
          type="button"
          className="ask-card__skip"
          disabled={submitting}
          onClick={skip}
        >
          {t("ask.skip")}
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
  const t = useT();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  if (away.expiresAt <= now) {
    return <p className="ask-card-away is-expired">{t("ask.expired")}</p>;
  }
  return (
    <button type="button" className="ask-card-away" onClick={onReturn}>
      {away.text}
    </button>
  );
}
