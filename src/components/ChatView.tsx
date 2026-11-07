import { useEffect, useRef } from "react";
import type { NextAction } from "../agent/protocol";
import type { PendingQuestion } from "../agent/bridge";
import type { Session } from "../state/chatStore";
import { AskQuestionCard } from "./AskQuestionCard";
import { Composer } from "./Composer";
import { MessageItem } from "./MessageItem";

interface Props {
  session: Session;
  onSend: (text: string) => void | boolean | Promise<void | boolean>;
  /** 有提问待回答时，输入框发送走这里，不走 onSend（那条会被单飞挡掉）。 */
  onAnswerFromComposer?: (text: string) => void | boolean | Promise<void | boolean>;
  onAnswerQuestion?: (answer: string) => void | boolean | Promise<void | boolean>;
  onQuestionExpired?: () => void;
  question?: PendingQuestion | null;
  onStop: () => void;
  onNextAction: (action: NextAction) => void;
  hasKey: boolean;
  onConfigureKey: () => void;
  /** 递增这个值会把焦点移到输入框。 */
  focusSignal?: number;
}

export function ChatView({
  session,
  onSend,
  onAnswerFromComposer,
  onAnswerQuestion,
  onQuestionExpired,
  question = null,
  onStop,
  onNextAction,
  hasKey,
  onConfigureKey,
  focusSignal = 0,
}: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);
  const inlineQuestion =
    question && question.kind !== "core_upgrade_confirm" ? question : null;

  useEffect(() => {
    const node = scrollRef.current;
    if (!node || !pinnedRef.current) return;
    node.scrollTop = node.scrollHeight;
  }, [session.messages, session.toolCalls, inlineQuestion?.questionId]);

  const streaming = session.activeRequestId !== null || session.requesting;
  const answerFromComposer = onAnswerFromComposer ?? onAnswerQuestion ?? onSend;

  return (
    <div className="chat">
      <div
        className="chat__scroll"
        ref={scrollRef}
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
            />
          ))}
          {inlineQuestion ? (
            <AskQuestionCard
              question={inlineQuestion}
              onAnswer={onAnswerQuestion ?? (async () => undefined)}
              onExpire={onQuestionExpired ?? (() => undefined)}
            />
          ) : null}
        </div>
      </div>

      <Composer
        streaming={streaming}
        questionPending={Boolean(inlineQuestion)}
        statusText={inlineQuestion ? null : session.status?.text ?? null}
        onSend={inlineQuestion ? answerFromComposer : onSend}
        onStop={onStop}
        disabled={!hasKey}
        onConfigure={onConfigureKey}
        focusSignal={focusSignal}
      />
    </div>
  );
}
