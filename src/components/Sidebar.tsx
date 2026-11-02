import { useEffect, useRef, useState } from "react";
import type { Session } from "../state/chatStore";
import logo from "../assets/logo.png";
import { PRODUCT_NAME } from "../brand";

export interface RenameResult {
  ok: boolean;
  /** 失败时给用户看的文案。 */
  message?: string;
  /** 会话已不存在、可以从列表里移除。 */
  removed?: boolean;
}

interface Props {
  sessions: Session[];
  activeSessionId: string;
  mode: string;
  onSelect: (sessionId: string) => void;
  onNew: () => void;
  onOpenSettings: () => void;
  onRenameSession: (sessionId: string, title: string) => Promise<RenameResult>;
}

function relativeTime(at: number): string {
  const diff = Date.now() - at;
  const minute = 60_000;
  if (diff < minute) return "刚刚";
  if (diff < 60 * minute) return `${Math.floor(diff / minute)} 分钟前`;
  if (diff < 24 * 60 * minute) return `${Math.floor(diff / (60 * minute))} 小时前`;
  return new Date(at).toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });
}

export function Sidebar({
  sessions,
  activeSessionId,
  mode,
  onSelect,
  onNew,
  onOpenSettings,
  onRenameSession,
}: Props) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!editingId) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [editingId]);

  // 编辑中的会话被删掉/切走时，退出编辑态。
  useEffect(() => {
    if (editingId && !sessions.some((session) => session.id === editingId)) {
      setEditingId(null);
      setError(null);
    }
  }, [sessions, editingId]);

  const startEditing = (session: Session) => {
    setEditingId(session.id);
    setDraft(session.title);
    setError(null);
    setSaving(false);
  };

  const cancelEditing = () => {
    setEditingId(null);
    setError(null);
    setSaving(false);
  };

  const submit = async () => {
    if (!editingId || saving) return;

    setSaving(true);
    setError(null);
    // 标题原样交给后端：trim 与长度校验只在后端做一次。
    const result = await onRenameSession(editingId, draft);
    setSaving(false);

    if (result.ok) {
      setEditingId(null);
      return;
    }
    setError(result.message ?? "保存失败，请重试");
    if (result.removed) setEditingId(null);
  };

  return (
    <aside className="sidebar">
      <div className="sidebar__brand">
        <img className="sidebar__mark" src={logo} alt={PRODUCT_NAME} />
        <span className="sidebar__wordmark">{PRODUCT_NAME}</span>
      </div>

      <button type="button" className="sidebar__new" onClick={onNew}>
        <span aria-hidden>+</span>
        新会话
      </button>

      <div className="sidebar__section-label">会话</div>
      <nav className="sidebar__list">
        {sessions.map((session) => {
          const editing = session.id === editingId;

          return (
            <div key={session.id} className="sidebar__item-wrap">
              {editing ? (
                <div className={`sidebar__item is-editing ${session.id === activeSessionId ? "is-active" : ""}`}>
                  <input
                    ref={inputRef}
                    className="sidebar__edit-input"
                    value={draft}
                    aria-label="会话标题"
                    onChange={(event) => setDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        void submit();
                      } else if (event.key === "Escape") {
                        event.preventDefault();
                        cancelEditing();
                      }
                    }}
                    disabled={saving}
                  />
                </div>
              ) : (
                <button
                  type="button"
                  className={`sidebar__item ${session.id === activeSessionId ? "is-active" : ""}`}
                  title="双击重命名"
                  onClick={() => onSelect(session.id)}
                  onDoubleClick={() => startEditing(session)}
                >
                  <span className="sidebar__item-title">{session.title}</span>
                  <span className="sidebar__item-time">{relativeTime(session.updatedAt)}</span>
                  {session.activeRequestId ? (
                    <span className="sidebar__item-live" aria-hidden />
                  ) : null}
                </button>
              )}

              {editing && error ? <p className="sidebar__edit-error">{error}</p> : null}
            </div>
          );
        })}
      </nav>

      <div className="sidebar__footer">
        <span className={`sidebar__mode sidebar__mode--${mode}`}>{mode === "mock" ? "MOCK 事件源" : "已连接 Host"}</span>
        <button
          type="button"
          className="sidebar__settings"
          title="设置"
          onClick={onOpenSettings}
        >
          设置
        </button>
      </div>
    </aside>
  );
}
