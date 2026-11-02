import { useState } from "react";
import type { NextAction } from "../agent/protocol";
import type { ToolCall } from "../state/chatStore";

const STATE_LABEL: Record<ToolCall["state"], string> = {
  running: "运行中",
  ok: "完成",
  error: "失败",
};

const SOURCE_LABEL: Record<ToolCall["source"], string> = {
  ui: "界面发起",
  agent: "Agent 发起",
};

function formatDuration(ms?: number): string | null {
  if (ms === undefined) return null;
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export function ToolCallCard({
  call,
  onNextAction,
}: {
  call: ToolCall;
  onNextAction: (action: NextAction) => void;
}) {
  const [open, setOpen] = useState(false);
  const duration = formatDuration(call.durationMs);
  const hasDetail =
    call.result !== undefined ||
    call.argsPreview !== undefined ||
    call.errorCode !== undefined;

  return (
    <div className={`tool-card tool-card--${call.state}`}>
      <button
        type="button"
        className="tool-card__row"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
      >
        <span className={`tool-card__chevron ${open ? "is-open" : ""}`} aria-hidden />
        <span className="tool-card__name">{call.tool}</span>
        <span className="tool-card__action">{call.action}</span>
        <span className="tool-card__meta">
          {duration ? <span className="tool-card__duration">{duration}</span> : null}
          <span className="tool-card__dot" aria-hidden />
          <span className="tool-card__status">{STATE_LABEL[call.state]}</span>
        </span>
      </button>

      {open && hasDetail ? (
        <div className="tool-card__body">
          {call.argsPreview ? (
            <div className="tool-card__field">
              <span className="tool-card__label">参数</span>
              <code>{JSON.stringify(call.argsPreview)}</code>
            </div>
          ) : null}
          <div className="tool-card__field">
            <span className="tool-card__label">结果</span>
            <code>{call.result ?? (call.state === "running" ? "等待返回…" : "无摘要")}</code>
          </div>
          {call.errorCode ? (
            <div className="tool-card__field">
              <span className="tool-card__label">错误码</span>
              <code>{call.errorCode}</code>
            </div>
          ) : null}
          <div className="tool-card__field">
            <span className="tool-card__label">来源</span>
            <code>{SOURCE_LABEL[call.source]}</code>
          </div>
        </div>
      ) : null}

      {call.nextActions.length > 0 ? (
        <div className="tool-card__actions">
          {call.nextActions.map((action) => (
            <button
              key={`${action.tool}-${action.label}`}
              type="button"
              className="chip chip--small"
              onClick={() => onNextAction(action)}
            >
              {action.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
