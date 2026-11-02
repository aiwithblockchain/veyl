import { useState } from "react";

export function ThinkingBlock({ content, complete }: { content: string; complete: boolean }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="thinking-block">
      <button
        type="button"
        className="thinking-block__row"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
      >
        <span className={`thinking-block__spinner ${complete ? "is-done" : ""}`} aria-hidden />
        <span className="thinking-block__label">{complete ? "已完成思考" : "正在思考"}</span>
        <span className="thinking-block__hint">{open ? "收起" : "展开"}</span>
      </button>
      {open ? <pre className="thinking-block__body">{content}</pre> : null}
    </div>
  );
}
