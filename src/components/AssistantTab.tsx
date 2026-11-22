import type { Ref } from "react";
import { useT } from "../i18n";

interface Props {
  unread: boolean;
  onOpen: () => void;
  /** Esc 关闭浮层后要把焦点还到这个按钮。 */
  openButtonRef?: Ref<HTMLButtonElement>;
}

/** 助手收起后的右边缘 56px tab：整个 tab 是一个按钮，竖排「助手」+ 未读点。 */
export function AssistantTab({ unread, onOpen, openButtonRef }: Props) {
  const t = useT();
  return (
    <aside className="assistant-tab" aria-label={t("assistantTab.collapsedAria")}>
      <button
        ref={openButtonRef}
        type="button"
        className="assistant-tab__open"
        onClick={onOpen}
        aria-label={
          unread ? t("assistantTab.openUnreadAria") : t("assistantTab.openAria")
        }
        aria-expanded={false}
        title={t("assistantTab.open")}
      >
        <span className="assistant-tab__icon">
          <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden>
            <path
              d="M3.5 5.2A1.7 1.7 0 0 1 5.2 3.5h9.6a1.7 1.7 0 0 1 1.7 1.7v6.2a1.7 1.7 0 0 1-1.7 1.7H9.2L6 15.4v-2.3H5.2a1.7 1.7 0 0 1-1.7-1.7z"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.35"
              strokeLinejoin="round"
            />
          </svg>
          {unread ? <span className="assistant-tab__dot" aria-hidden /> : null}
        </span>
        <span className="assistant-tab__label">{t("assistant.name")}</span>
      </button>
    </aside>
  );
}
