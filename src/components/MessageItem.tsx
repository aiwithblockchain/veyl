import type { ApprovalDecision, ApprovalScope, NextAction } from "../agent/protocol";
import { PRODUCT_NAME } from "../brand";
import type { ApprovalEntry, ChatMessage, ToolCall } from "../state/chatStore";
import { ApprovalCard } from "./ApprovalCard";
import { Markdown } from "./Markdown";
import { ThinkingBlock } from "./ThinkingBlock";
import { ToolCallCard } from "./ToolCallCard";

interface Props {
  message: ChatMessage;
  toolCalls: Record<string, ToolCall>;
  approvals: Record<string, ApprovalEntry>;
  onDecide: (approvalId: string, decision: ApprovalDecision, scope: ApprovalScope) => void;
  onNextAction: (action: NextAction) => void;
}

export function MessageItem({ message, toolCalls, approvals, onDecide, onNextAction }: Props) {
  if (message.role === "user") {
    return (
      <div className="msg msg--user">
        <div className="msg__bubble">{message.text}</div>
      </div>
    );
  }

  if (message.role === "system") {
    return (
      <div className={`msg msg--system ${message.level === "error" ? "is-error" : ""}`}>
        <span className="msg__system-dot" aria-hidden />
        {message.text}
      </div>
    );
  }

  return (
    <div className="msg msg--assistant">
      <div className="msg__role">
        <span className="msg__avatar" aria-hidden />
        <span>{PRODUCT_NAME}</span>
        {message.streaming ? <span className="msg__streaming">输出中</span> : null}
        {message.usage?.output_tokens ? (
          <span className="msg__usage">{message.usage.output_tokens} tokens</span>
        ) : null}
      </div>

      <div className="msg__items">
        {message.items.map((item) => {
          switch (item.kind) {
            case "text":
              return (
                <div key={item.id} className="msg__text">
                  <Markdown text={item.content} />
                  {message.streaming && item === message.items[message.items.length - 1] ? (
                    <span className="msg__caret" aria-hidden />
                  ) : null}
                </div>
              );
            case "thinking":
              return <ThinkingBlock key={item.id} content={item.content} complete={item.complete} />;
            case "tool": {
              const call = toolCalls[item.callId];
              if (!call) return null;
              return <ToolCallCard key={item.id} call={call} onNextAction={onNextAction} />;
            }
            case "approval": {
              const request = approvals[item.approvalId];
              if (!request) return null;
              return (
                <ApprovalCard
                  key={item.id}
                  request={request}
                  decision={request.decision}
                  onDecide={(decision, scope) => onDecide(item.approvalId, decision, scope)}
                />
              );
            }
            case "notice":
              return (
                <div key={item.id} className="msg__notice">
                  {item.text}
                </div>
              );
            default:
              return null;
          }
        })}
      </div>
    </div>
  );
}
