import type { Session } from "../state/chatStore";

interface Props {
  sessions: Session[];
  activeSessionId: string;
  mode: string;
  onSelect: (sessionId: string) => void;
  onNew: () => void;
}

function relativeTime(at: number): string {
  const diff = Date.now() - at;
  const minute = 60_000;
  if (diff < minute) return "刚刚";
  if (diff < 60 * minute) return `${Math.floor(diff / minute)} 分钟前`;
  if (diff < 24 * 60 * minute) return `${Math.floor(diff / (60 * minute))} 小时前`;
  return new Date(at).toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });
}

export function Sidebar({ sessions, activeSessionId, mode, onSelect, onNew }: Props) {
  return (
    <aside className="sidebar">
      <div className="sidebar__brand">
        <span className="sidebar__mark" aria-hidden />
        <span className="sidebar__wordmark">AIVPN</span>
      </div>

      <button type="button" className="sidebar__new" onClick={onNew}>
        <span aria-hidden>+</span>
        新会话
      </button>

      <div className="sidebar__section-label">会话</div>
      <nav className="sidebar__list">
        {sessions.map((session) => (
          <button
            key={session.id}
            type="button"
            className={`sidebar__item ${session.id === activeSessionId ? "is-active" : ""}`}
            onClick={() => onSelect(session.id)}
          >
            <span className="sidebar__item-title">{session.title}</span>
            <span className="sidebar__item-time">{relativeTime(session.updatedAt)}</span>
            {session.activeRequestId ? <span className="sidebar__item-live" aria-hidden /> : null}
          </button>
        ))}
      </nav>

      <div className="sidebar__footer">
        <span className={`sidebar__mode sidebar__mode--${mode}`}>{mode === "mock" ? "MOCK 事件源" : "已连接 Host"}</span>
        <button type="button" className="sidebar__settings" title="设置（P1 W3 接入）">
          设置
        </button>
      </div>
    </aside>
  );
}
