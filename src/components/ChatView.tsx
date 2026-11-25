import { useEffect, useRef } from "react";
import type { NextAction } from "../agent/protocol";
import type { PendingQuestion } from "../agent/bridge";
import { isConfirmQuestionKind } from "../agent/bridge";
import type { Session } from "../state/chatStore";
import { AskQuestionCard, QuestionAwayLine } from "./AskQuestionCard";
import { Composer } from "./Composer";
import { MessageItem } from "./MessageItem";
import type { DisplayActionOutcome } from "./ToolCallCard";
import type { ToolDisplayAction } from "./toolDisplay";
import { useT } from "../i18n";

interface Props {
  session: Session;
  onSend: (text: string) => void | boolean | Promise<void | boolean>;
  /** 有提问待回答时，输入框发送走这里，不走 onSend（那条会被单飞挡掉）。 */
  onAnswerFromComposer?: (text: string) => void | boolean | Promise<void | boolean>;
  onAnswerQuestion?: (answer: string) => void | boolean | Promise<void | boolean>;
  onQuestionExpired?: () => void;
  question?: PendingQuestion | null;
  /** 提问不属于当前屏幕：折叠成一行只读提示。 */
  questionAway?: { text: string; expiresAt: number } | null;
  /** 提问已过期：选项禁用，不再接受回答。 */
  questionExpired?: boolean;
  onReturnToQuestion?: () => void;
  onStop: () => void;
  onNextAction: (action: NextAction) => void;
  /** 工具卡里的报告动作：直接调命令，不发消息。 */
  onDisplayAction?: (action: ToolDisplayAction) => Promise<DisplayActionOutcome>;
  hasKey: boolean;
  onConfigureKey: () => void;
  /** 递增这个值会把焦点移到消息流（空态点预制问题后）。 */
  focusMessagesSignal?: number;
  /** 输入框草稿由上层持有，重挂载不丢。 */
  composerDraft?: string;
  onComposerDraftChange?: (text: string) => void;
}

export function ChatView({
  session,
  onSend,
  onAnswerFromComposer,
  onAnswerQuestion,
  onQuestionExpired,
  question = null,
  questionAway = null,
  questionExpired = false,
  onReturnToQuestion,
  onStop,
  onNextAction,
  onDisplayAction,
  hasKey,
  onConfigureKey,
  focusMessagesSignal = 0,
  composerDraft,
  onComposerDraftChange,
}: Props) {
  const t = useT();
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);

  useEffect(() => {
    if (!focusMessagesSignal) return;
    scrollRef.current?.focus({ preventScroll: true });
  }, [focusMessagesSignal]);
  const inlineQuestion =
    question && !isConfirmQuestionKind(question.kind) ? question : null;
  const canAnswer = Boolean(inlineQuestion) && !questionExpired;

  useEffect(() => {
    const node = scrollRef.current;
    if (!node || !pinnedRef.current) return;
    node.scrollTop = node.scrollHeight;
  }, [session.messages, session.toolCalls, inlineQuestion?.questionId]);

  const streaming = session.activeRequestId !== null || session.requesting;
  const answerFromComposer = onAnswerFromComposer ?? onAnswerQuestion ?? onSend;

  return (
    <div className="chat">
      {session.report ? (
        <p className="chat__disclosure">
          {t("chat.reportDisclosure")}
        </p>
      ) : null}
      <div
        className="chat__scroll"
        ref={scrollRef}
        tabIndex={-1}
        onScroll={(event) => {
          const node = event.currentTarget;
          pinnedRef.current = node.scrollHeight - node.scrollTop - node.clientHeight < 120;
        }}
      >
        <div className="chat__list">
          {session.messages.map((message) => (
            <MessageItem
              key={message.id}
              message={message}
              toolCalls={session.toolCalls}
              onNextAction={onNextAction}
              onDisplayAction={onDisplayAction}
            />
          ))}
          {inlineQuestion ? (
            <AskQuestionCard
              question={inlineQuestion}
              expired={questionExpired}
              onAnswer={onAnswerQuestion ?? (async () => undefined)}
              onExpire={onQuestionExpired ?? (() => undefined)}
            />
          ) : questionAway ? (
            <QuestionAwayLine away={questionAway} onReturn={onReturnToQuestion} />
          ) : null}
        </div>
      </div>

      <Composer
        streaming={streaming}
        questionPending={canAnswer}
        statusText={canAnswer ? null : session.status?.text ?? null}
        onSend={canAnswer ? answerFromComposer : onSend}
        onStop={onStop}
        disabled={!hasKey}
        onConfigure={onConfigureKey}
        value={composerDraft}
        onValueChange={onComposerDraftChange}
      />
    </div>
  );
}
