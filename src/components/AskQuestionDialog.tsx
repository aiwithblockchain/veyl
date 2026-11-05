import { useCallback, useEffect, useRef, useState } from "react";
import type { CoreUpgradeConfirmData, PendingQuestion } from "../agent/bridge";
import { toBridgeError } from "../agent/errors";
import { formatByteSize, upgradeEffectText } from "../format";
import { useFocusTrap } from "../ui/focus";
import { IconClose } from "./icons";

const UNKNOWN_CONFIRM: CoreUpgradeConfirmData = {
  currentVersion: null,
  targetVersion: null,
  size: null,
  restartRequired: false,
};

interface Props {
  question: PendingQuestion | null;
  onAnswer: (answer: string) => Promise<void>;
  /** 后端 300 秒超时后已自动作废：前端直接收起，不再调用回答命令。 */
  onExpire: () => void;
  /** 当前是否有连接在跑；决定升级确认卡的生效时机文案。 */
  connected?: boolean;
}

/** 模型提问的居中模态：单选项；普通提问跳过回传空串，升级确认卡的跳过等于取消选项。 */
export function AskQuestionDialog({ question, onAnswer, onExpire, connected = false }: Props) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const firstOptionRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const submittingRef = useRef(false);
  const expireRef = useRef(onExpire);
  expireRef.current = onExpire;
  useFocusTrap(Boolean(question), dialogRef);

  const confirm =
    question?.kind === "core_upgrade_confirm"
      ? question.upgradeConfirm ?? UNKNOWN_CONFIRM
      : null;
  const options = question?.options ?? [];
  // 界面文案固定；回传值仍用 Host 给的选项原文，避免后端按字面量匹配失败。
  const upgradeAnswer =
    options.find(
      (option) => /升级|更新/.test(option) && !/不升|不更新|取消|暂不|稍后|不用/.test(option),
    ) ??
    options.find((option) => /升级|更新/.test(option)) ??
    "升级";
  const cancelAnswer =
    options.find((option) => /取消|暂不|稍后|不升|不更新|不用|以后/.test(option)) ?? "取消";
  const skipValue = confirm ? cancelAnswer : "";

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
    if (question.kind === "core_upgrade_confirm") {
      cancelRef.current?.focus();
    } else {
      firstOptionRef.current?.focus();
    }
  }, [question?.questionId, question?.kind]);

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
    if (!submittingRef.current) void answer(skipValue);
  }, [answer, skipValue]);

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
    <div
      className="ask-question-backdrop"
      onMouseDown={() => {
        if (!submittingRef.current) void answer("");
      }}
    >
      <div
        ref={dialogRef}
        className="ask-question"
        role="dialog"
        aria-modal="true"
        aria-labelledby="ask-question-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="ask-question__head">
          <h2 id="ask-question-title" className="ask-question__title">
            {confirm ? "更新后台运行库" : "需要你的确认"}
          </h2>
          <button
            type="button"
            className="ask-question__close"
            aria-label={confirm ? "关闭" : "稍后回答"}
            disabled={submitting}
            onClick={skip}
          >
            <IconClose size={14} />
          </button>
        </header>

        {confirm ? (
          <dl className="core-confirm">
            <div className="core-confirm__row">
              <dt>版本</dt>
              <dd>
                当前 {confirm.currentVersion ?? "未知"} → 目标{" "}
                {confirm.targetVersion ?? "未知"}
              </dd>
            </div>
            <div className="core-confirm__row">
              <dt>下载大小</dt>
              <dd>{formatByteSize(confirm.size) ?? "大小未知"}</dd>
            </div>
            <div className="core-confirm__row">
              <dt>来源</dt>
              <dd>官方更新</dd>
            </div>
            <div className="core-confirm__row">
              <dt>生效</dt>
              <dd>{upgradeEffectText(confirm.restartRequired, connected)}</dd>
            </div>
          </dl>
        ) : (
          <p className="ask-question__text">{question.question}</p>
        )}

        {confirm ? (
          <div className="core-confirm__actions">
            <button
              type="button"
              className="btn btn--ghost"
              disabled={submitting}
              onClick={() => void answer(upgradeAnswer)}
            >
              升级
            </button>
            <button
              ref={cancelRef}
              type="button"
              className="btn btn--primary"
              disabled={submitting}
              onClick={() => void answer(cancelAnswer)}
            >
              取消
            </button>
          </div>
        ) : question.options.length > 0 ? (
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

        {confirm ? null : (
          <button
            type="button"
            className="ask-question__skip"
            disabled={submitting}
            onClick={skip}
          >
            稍后回答
          </button>
        )}
      </div>
    </div>
  );
}
