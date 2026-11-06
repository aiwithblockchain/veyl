import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { NextAction } from "../agent/protocol";
import { PRODUCT_NAME } from "../brand";
import type { ChatMessage, TimelineItem, ToolCall } from "../state/chatStore";
import { Markdown } from "./Markdown";
import { ThinkingBlock } from "./ThinkingBlock";
import { ToolCallCard, ToolCallGroup } from "./ToolCallCard";

interface Props {
  message: ChatMessage;
  toolCalls: Record<string, ToolCall>;
  onNextAction: (action: NextAction) => void;
}

export function MessageItem({ message, toolCalls, onNextAction }: Props) {
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

  // 只拼正文文本块：思考块、工具卡、token 计数都不进剪贴板。
  const bodyText = message.items
    .filter((item): item is Extract<TimelineItem, { kind: "text" }> => item.kind === "text")
    .map((item) => item.content)
    .join("\n\n");

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
        {renderTimeline(message, toolCalls, onNextAction)}
      </div>

      {!message.streaming ? <CopyAnswerButton text={bodyText} /> : null}
    </div>
  );
}

type CopyState = "idle" | "copied" | "failed";

/**
 * 工具行按连续成功合并：≥3 条变「完成 N 步」，失败与进行中永远单独成行。
 * AskUserQuestion 交给确认弹层，不渲染工具行，并断开合并。
 */
function renderTimeline(
  message: Extract<ChatMessage, { role: "assistant" }>,
  toolCalls: Record<string, ToolCall>,
  onNextAction: (action: NextAction) => void,
): ReactNode[] {
  const nodes: ReactNode[] = [];
  let run: ToolCall[] = [];
  let runKey = "";

  const flushRun = () => {
    if (run.length >= 3) {
      nodes.push(
        <ToolCallGroup key={`group-${runKey}`} calls={run} onNextAction={onNextAction} />,
      );
    } else {
      for (const call of run) {
        nodes.push(
          <ToolCallCard key={call.id} call={call} onNextAction={onNextAction} />,
        );
      }
    }
    run = [];
  };

  message.items.forEach((item, index) => {
    if (item.kind === "tool") {
      const call = toolCalls[item.callId];
      if (!call || call.tool === "AskUserQuestion") {
        flushRun();
        return;
      }
      if (call.state === "ok") {
        if (run.length === 0) runKey = item.id;
        run.push(call);
        return;
      }
      flushRun();
      nodes.push(
        <ToolCallCard key={item.id} call={call} onNextAction={onNextAction} />,
      );
      return;
    }

    flushRun();
    switch (item.kind) {
      case "text":
        nodes.push(
          <div key={item.id} className="msg__text">
            <Markdown text={item.content} />
            {message.streaming && index === message.items.length - 1 ? (
              <span className="msg__caret" aria-hidden />
            ) : null}
          </div>,
        );
        break;
      case "thinking":
        nodes.push(
          <ThinkingBlock key={item.id} content={item.content} complete={item.complete} />,
        );
        break;
      case "notice":
        nodes.push(
          <div key={item.id} className="msg__notice">
            {item.text}
          </div>,
        );
        break;
      default:
        break;
    }
  });

  flushRun();
  return nodes;
}

/** 整条回答一个按钮：拼接所有正文文本块，不含思考与工具卡。 */
function CopyAnswerButton({ text }: { text: string }) {
  const [state, setState] = useState<CopyState>("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  if (!text.trim()) return null;

  const resetLater = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setState("idle"), 2000);
  };

  const handleCopy = async () => {
    const ok = await copyToClipboard(text);
    setState(ok ? "copied" : "failed");
    resetLater();
  };

  const label = state === "copied" ? "已复制" : state === "failed" ? "复制失败" : "复制回答";

  return (
    <div className={`msg__actions ${state !== "idle" ? "is-active" : ""}`}>
      <button
        type="button"
        className={`msg__copy msg__copy--${state}`}
        title={label}
        aria-label={label}
        onClick={() => void handleCopy()}
      >
        {state === "copied" ? <CheckIcon /> : <CopyIcon />}
        {state !== "idle" ? <span className="msg__copy-label">{label}</span> : null}
      </button>
    </div>
  );
}

/** clipboard API 优先，不可用时退回 textarea + execCommand。 */
async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // 落到下面的兜底，不要把异常抛给界面。
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.top = "-9999px";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);

  try {
    textarea.select();
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    document.body.removeChild(textarea);
  }
}

function CopyIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="9" y="9" width="12" height="12" rx="2" />
      <path d="M5 15V5a2 2 0 0 1 2-2h10" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}
