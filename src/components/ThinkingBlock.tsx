import { useState } from "react";
import { useT } from "../i18n";

export function ThinkingBlock({ content, complete }: { content: string; complete: boolean }) {
  const t = useT();
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
        <span className="thinking-block__label">
          {complete ? t("thinking.complete") : t("thinking.working")}
        </span>
        <span className="thinking-block__hint">
          {open ? t("thinking.collapse") : t("thinking.expand")}
        </span>
      </button>
      {open ? <pre className="thinking-block__body">{content}</pre> : null}
    </div>
  );
}
