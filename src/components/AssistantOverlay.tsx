import { useEffect, useRef, type ReactNode } from "react";
import { useFocusTrap } from "../ui/focus";

interface Props {
  onClose: () => void;
  children: ReactNode;
}

/**
 * 窄屏下的助手浮层：和其他对话框一样是「role=dialog + aria-modal + 焦点陷阱」，
 * Esc 与点遮罩都能收起。
 */
export function AssistantOverlay({ onClose, children }: Props) {
  const panelRef = useRef<HTMLDivElement>(null);
  useFocusTrap(true, panelRef);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div
      className="assistant-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="AI 对话"
      onMouseDown={onClose}
    >
      <div
        ref={panelRef}
        className="assistant-overlay__panel"
        onMouseDown={(event) => event.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}
