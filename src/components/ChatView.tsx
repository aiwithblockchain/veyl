import { useEffect, useRef } from "react";
import type { NextAction } from "../agent/protocol";
import type { Session } from "../state/chatStore";
import { Composer } from "./Composer";
import { MessageItem } from "./MessageItem";

interface Props {
  session: Session;
  onSend: (text: string) => void | boolean | Promise<void | boolean>;
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
  onStop,
  onNextAction,
  hasKey,
  onConfigureKey,
  focusSignal = 0,
}: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);

  useEffect(() => {
    const node = scrollRef.current;
    if (!node || !pinnedRef.current) return;
    node.scrollTop = node.scrollHeight;
  }, [session.messages, session.toolCalls]);

  const streaming = session.activeRequestId !== null || session.requesting;

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
        </div>
      </div>

      <Composer
        streaming={streaming}
        statusText={session.status?.text ?? null}
        onSend={onSend}
        onStop={onStop}
        disabled={!hasKey}
        onConfigure={onConfigureKey}
        focusSignal={focusSignal}
      />
    </div>
  );
}
