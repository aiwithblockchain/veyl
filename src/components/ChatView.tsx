import { useEffect, useRef } from "react";
import type { NextAction } from "../agent/protocol";
import type { Session } from "../state/chatStore";
import { Composer } from "./Composer";
import { MessageItem } from "./MessageItem";
import logo from "../assets/logo.png";

interface Props {
  session: Session;
  onSend: (text: string) => void;
  onStop: () => void;
  onNextAction: (action: NextAction) => void;
  hasKey: boolean;
  onConfigureKey: () => void;
}

const SUGGESTIONS = ["连到日本", "现在是什么状态", "断开连接"];

function hasEverConnected(): boolean {
  try {
    return (
      localStorage.getItem("veyl.hasEverConnected") === "1" ||
      localStorage.getItem("veyl.hasConnected") === "1"
    );
  } catch {
    return false;
  }
}

export function ChatView({
  session,
  onSend,
  onStop,
  onNextAction,
  hasKey,
  onConfigureKey,
}: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);

  useEffect(() => {
    const node = scrollRef.current;
    if (!node || !pinnedRef.current) return;
    node.scrollTop = node.scrollHeight;
  }, [session.messages, session.toolCalls]);

  const streaming = session.activeRequestId !== null || session.requesting;
  const learned = hasEverConnected();

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
        {session.messages.length === 0 ? (
          learned ? (
            <div className="empty empty--plain">
              <p className="empty__plain">问点什么，或者让我诊断网络</p>
            </div>
          ) : (
          <div className="empty">
            <div className="empty__mark">
              <img src={logo} alt="" />
            </div>
            <h1 className="empty__title">用一句话连上网络</h1>
            <p className="empty__sub">
              告诉我要去哪儿，剩下的交给它：下载运行时、挑选节点、连接、设置系统代理。
            </p>
            <div className="empty__chips">
              {SUGGESTIONS.map((suggestion) => (
                <button
                  key={suggestion}
                  type="button"
                  className="chip"
                  onClick={() => onSend(suggestion)}
                >
                  {suggestion}
                </button>
              ))}
            </div>
            <div className="empty__steps">
              <span>① 配置 DeepSeek Key</span>
              <span>② 选节点</span>
              <span>③ 连接</span>
            </div>
          </div>
          )
        ) : (
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
        )}
      </div>

      <Composer
        streaming={streaming}
        statusText={session.status?.text ?? null}
        onSend={onSend}
        onStop={onStop}
        disabled={!hasKey}
        onConfigure={onConfigureKey}
      />
    </div>
  );
}
