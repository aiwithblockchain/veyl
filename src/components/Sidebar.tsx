import { useEffect, useRef, useState } from "react";
import type { Session } from "../state/chatStore";
import logo from "../assets/logo.png";
import { PRODUCT_NAME } from "../brand";

export interface RenameResult {
  ok: boolean;
  message?: string;
  removed?: boolean;
}

interface Props {
  sessions: Session[];
  activeSessionId: string;
  onSelect: (sessionId: string) => void;
  onNew: () => void;
  onOpenSettings: () => void;
  onRenameSession: (sessionId: string, title: string) => Promise<RenameResult>;
  onDeleteSession: (sessionId: string) => Promise<{ ok: boolean; message?: string }>;
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
  onSelect,
  onNew,
  onOpenSettings,
  onRenameSession,
  onDeleteSession,
}: Props) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirming, setConfirming] = useState<Session | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [chatCollapsed, setChatCollapsed] = useState(() => {
    try {
      return localStorage.getItem("veyl.sidebar.chatCollapsed") === "1";
    } catch {
      return false;
    }
  });
  const inputRef = useRef<HTMLInputElement>(null);

  const toggleChat = () => {
    setChatCollapsed((current) => {
      const next = !current;
      try {
        localStorage.setItem("veyl.sidebar.chatCollapsed", next ? "1" : "0");
      } catch {
        // 存不了就只在本次会话里记住。
      }
      return next;
    });
  };

  useEffect(() => {
    if (!editingId) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [editingId]);

  useEffect(() => {
    if (editingId && !sessions.some((session) => session.id === editingId)) {
      setEditingId(null);
      setError(null);
    }
  }, [sessions, editingId]);

  useEffect(() => {
    if (confirming && !sessions.some((session) => session.id === confirming.id)) {
      setConfirming(null);
    }
  }, [sessions, confirming]);

  useEffect(() => {
    if (!confirming) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !deleting) setConfirming(null);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [confirming, deleting]);

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
    const result = await onRenameSession(editingId, draft);
    setSaving(false);
    if (result.ok) {
      setEditingId(null);
      return;
    }
    setError(result.message ?? "保存失败，请重试");
    if (result.removed) setEditingId(null);
  };

  const submitDelete = async () => {
    if (!confirming || deleting) return;
    setDeleting(true);
    setDeleteError(null);
    const result = await onDeleteSession(confirming.id);
    setDeleting(false);
    if (result.ok) setConfirming(null);
    else setDeleteError(result.message ?? "删除失败，请重试");
  };

  return (
    <aside className="sidebar">
      <div className="sidebar__brand">
        <img className="sidebar__mark" src={logo} alt="" />
        <span className="sidebar__wordmark">{PRODUCT_NAME}</span>
      </div>

      <button type="button" className="sidebar__new" onClick={onNew}>
        <span aria-hidden>＋</span>
        新建对话
      </button>

      <div className="sidebar__section-label">
        <button type="button" className="sidebar__section-toggle" onClick={toggleChat}>
          <span aria-hidden>{chatCollapsed ? "▸" : "▾"}</span> 对话 · {sessions.length}
        </button>
      </div>

      {chatCollapsed ? null : (
        <nav className="sidebar__list">
          {sessions.map((session) => {
            const editing = session.id === editingId;
            const active = session.id === activeSessionId;

            return (
              <div key={session.id} className="sidebar__item-wrap">
                {editing ? (
                  <div className={`sidebar__item is-editing ${active ? "is-active" : ""}`}>
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
                  <div className="sidebar__item-row">
                    <button
                      type="button"
                      className={`sidebar__item ${active ? "is-active" : ""}`}
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
                    <button
                      type="button"
                      className="sidebar__item-delete"
                      title={`删除「${session.title}」`}
                      aria-label={`删除会话 ${session.title}`}
                      onClick={() => {
                        setConfirming(session);
                        setDeleteError(null);
                      }}
                    >
                      ×
                    </button>
                  </div>
                )}

                {editing && error ? <p className="sidebar__edit-error">{error}</p> : null}
              </div>
            );
          })}
        </nav>
      )}

      <div className="sidebar__footer">
        <button type="button" className="sidebar__settings" onClick={onOpenSettings}>
          设置
        </button>
      </div>

      {confirming ? (
        <div
          className="modal-backdrop"
          onMouseDown={() => {
            if (!deleting) setConfirming(null);
          }}
        >
          <div
            className="modal modal--confirm"
            role="dialog"
            aria-modal="true"
            aria-labelledby="delete-session-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <header className="modal__head">
              <h2 id="delete-session-title" className="modal__title">
                删除对话
              </h2>
            </header>
            <p className="confirm__text">「{confirming.title}」删除后无法恢复。</p>
            {deleteError ? <p className="confirm__error">{deleteError}</p> : null}
            <div className="confirm__actions">
              <button
                type="button"
                className="btn btn--ghost"
                onClick={() => setConfirming(null)}
                disabled={deleting}
              >
                取消
              </button>
              <button
                type="button"
                className="btn btn--danger-ghost"
                onClick={() => void submitDelete()}
                disabled={deleting}
              >
                {deleting ? "删除中…" : "删除"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </aside>
  );
}
