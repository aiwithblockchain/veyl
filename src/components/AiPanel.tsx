import { useEffect, useRef, useState } from "react";
import type { NextAction } from "../agent/protocol";
import type { Session } from "../state/chatStore";
import { useFocusTrap } from "../ui/focus";
import { ChatView } from "./ChatView";
import { Composer } from "./Composer";
import {
  IconChevronLeft,
  IconChevronRight,
  IconClose,
  IconList,
  IconPencil,
  IconPlus,
  IconTrash,
} from "./icons";

export interface RenameResult {
  ok: boolean;
  message?: string;
  removed?: boolean;
}

type View = "chat" | "history";

interface Props {
  session: Session | null;
  sessions: Session[];
  activeSessionId: string;
  aiReady: boolean;
  hasEverConnected: boolean;
  hasConfigs: boolean;
  /** 递增这个值会把焦点移到输入框，并切回对话页。 */
  focusSignal: number;
  onSelectSession: (sessionId: string) => void;
  onNewSession: () => void;
  onRenameSession: (sessionId: string, title: string) => Promise<RenameResult>;
  onDeleteSession: (sessionId: string) => Promise<{ ok: boolean; message?: string }>;
  onSend: (text: string) => void;
  onEmptySend: (text: string) => void;
  onStop: () => void;
  onNextAction: (action: NextAction) => void;
  onOpenSettings: () => void;
  onConfigureKey: () => void;
  /** 收起助手；宽屏停靠时收成右边缘 tab。 */
  onCollapse: () => void;
}

const SUGGESTIONS = ["为什么我打不开某个网站？", "检查我的网络配置"];

function relativeTime(at: number): string {
  const diff = Date.now() - at;
  const minute = 60_000;
  if (diff < minute) return "刚刚";
  if (diff < 60 * minute) return `${Math.floor(diff / minute)} 分钟前`;
  if (diff < 24 * 60 * minute) return `${Math.floor(diff / (60 * minute))} 小时前`;
  return new Date(at).toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });
}

/** 右栏：一级是对话，二级是历史会话。设置沿用现有设置页。 */
export function AiPanel({
  session,
  sessions,
  activeSessionId,
  aiReady,
  hasEverConnected,
  hasConfigs,
  focusSignal,
  onSelectSession,
  onNewSession,
  onRenameSession,
  onDeleteSession,
  onSend,
  onEmptySend,
  onStop,
  onNextAction,
  onOpenSettings,
  onConfigureKey,
  onCollapse,
}: Props) {
  const [view, setView] = useState<View>("chat");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [editError, setEditError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirming, setConfirming] = useState<Session | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const editRef = useRef<HTMLInputElement>(null);
  const confirmRef = useRef<HTMLDivElement>(null);
  useFocusTrap(Boolean(confirming), confirmRef);

  useEffect(() => {
    if (focusSignal > 0) setView("chat");
  }, [focusSignal]);

  useEffect(() => {
    if (!editingId) return;
    editRef.current?.focus();
    editRef.current?.select();
  }, [editingId]);

  useEffect(() => {
    if (editingId && !sessions.some((item) => item.id === editingId)) {
      setEditingId(null);
      setEditError(null);
    }
  }, [sessions, editingId]);

  useEffect(() => {
    if (confirming && !sessions.some((item) => item.id === confirming.id)) {
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

  const startEdit = (item: Session) => {
    setEditingId(item.id);
    setDraft(item.title);
    setEditError(null);
    setSaving(false);
  };

  const submitRename = async () => {
    if (!editingId || saving) return;
    setSaving(true);
    setEditError(null);
    const result = await onRenameSession(editingId, draft);
    setSaving(false);
    if (result.ok) {
      setEditingId(null);
      return;
    }
    setEditError(result.message ?? "保存失败，请重试");
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

  const hasMessages = Boolean(session && session.messages.length > 0);
  const needsFirstConfig = aiReady && !hasConfigs;

  return (
    <aside id="ai-panel" className="ai-panel" aria-label="AI 对话">
      <header className="ai-panel__head">
        {view === "history" ? (
          <div className="ai-panel__id">
            <button
              type="button"
              className="ai-panel__icon"
              onClick={() => setView("chat")}
              aria-label="返回对话"
              title="返回对话"
            >
              <IconChevronLeft size={16} />
            </button>
            <span className="ai-panel__name">历史会话</span>
          </div>
        ) : (
          <div className="ai-panel__id">
            <span className="ai-panel__name">助手</span>
            <span className="ai-panel__model">{aiReady ? "DeepSeek" : "未连接 AI"}</span>
          </div>
        )}
        <div className="ai-panel__head-right">
          <button
            type="button"
            className="ai-panel__icon"
            onClick={() => {
              onNewSession();
              setView("chat");
            }}
            aria-label="新对话"
            title="新对话"
          >
            <IconPlus size={16} />
          </button>
          {view === "chat" ? (
            <button
              type="button"
              className="ai-panel__icon"
              onClick={() => setView("history")}
              aria-label="历史会话"
              title="历史会话"
            >
              <IconList size={16} />
            </button>
          ) : null}
          <button
            type="button"
            className="ai-panel__icon"
            onClick={onCollapse}
            aria-label="收起助手"
            title="收起助手"
          >
            <IconChevronRight size={16} />
          </button>
        </div>
      </header>

      {!aiReady ? (
        <div className="ai-panel__banner">
          还没有配置 AI，现在只能手动操作网络。
          <button type="button" className="ai-panel__banner-action" onClick={onOpenSettings}>
            去配置
          </button>
        </div>
      ) : null}

      <div className="ai-panel__body">
        {view === "history" ? (
          <div className="ai-history">
            {sessions.length === 0 ? (
              <p className="ai-history__empty">还没有对话。新建一个，或者直接问我。</p>
            ) : (
              <ul className="ai-history__list">
                {sessions.map((item) => (
                  <li key={item.id}>
                    {editingId === item.id ? (
                      <div className="ai-history__edit">
                        <input
                          ref={editRef}
                          className="ai-history__input"
                          value={draft}
                          aria-label="会话标题"
                          disabled={saving}
                          onChange={(event) => {
                            setDraft(event.target.value);
                            setEditError(null);
                          }}
                          onKeyDown={(event) => {
                            if (event.key === "Enter") {
                              event.preventDefault();
                              void submitRename();
                            } else if (event.key === "Escape") {
                              event.preventDefault();
                              setEditingId(null);
                              setEditError(null);
                            }
                          }}
                        />
                        {editError ? (
                          <p className="ai-history__error">{editError}</p>
                        ) : null}
                      </div>
                    ) : (
                      <div className="ai-history__row">
                        <button
                          type="button"
                          className={`ai-history__item ${
                            item.id === activeSessionId ? "is-active" : ""
                          }`}
                          title="双击改名"
                          onClick={() => {
                            onSelectSession(item.id);
                            setView("chat");
                          }}
                          onDoubleClick={() => startEdit(item)}
                        >
                          <span className="ai-history__title">{item.title}</span>
                          <span className="ai-history__time">
                            {relativeTime(item.updatedAt)}
                          </span>
                        </button>
                        <div className="ai-history__actions">
                          <button
                            type="button"
                            className="ai-history__action"
                            aria-label={`重命名会话 ${item.title}`}
                            title={`重命名「${item.title}」`}
                            onClick={() => startEdit(item)}
                          >
                            <IconPencil size={13} />
                          </button>
                          <button
                            type="button"
                            className="ai-history__action ai-history__action--danger"
                            aria-label={`删除会话 ${item.title}`}
                            title={`删除「${item.title}」`}
                            onClick={() => {
                              setConfirming(item);
                              setDeleteError(null);
                            }}
                          >
                            <IconTrash size={13} />
                          </button>
                        </div>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : hasMessages && session ? (
          <ChatView
            session={session}
            onSend={onSend}
            onStop={onStop}
            onNextAction={onNextAction}
            hasKey={aiReady}
            onConfigureKey={onConfigureKey}
            focusSignal={focusSignal}
          />
        ) : (
          <>
            <div className="ai-empty">
              <p className="ai-empty__line">
                {needsFirstConfig
                  ? "还没有配置。直接跟我说你想怎么用，我来帮你建一套。"
                  : hasEverConnected
                    ? "问点什么，或者让我诊断网络"
                    : "先连上，再聊。"}
              </p>
              {!hasEverConnected && !needsFirstConfig ? (
                <p className="ai-empty__text">连接在中间；需要我帮你配好，就在下面说。</p>
              ) : null}
              {!hasEverConnected && aiReady ? (
                <div className="ai-empty__suggest">
                  <span className="ai-empty__suggest-label">或者问我：</span>
                  {SUGGESTIONS.map((suggestion) => (
                    <button
                      key={suggestion}
                      type="button"
                      onClick={() => onEmptySend(suggestion)}
                    >
                      · {suggestion}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
            <Composer
              streaming={false}
              statusText={null}
              onSend={onEmptySend}
              onStop={onStop}
              disabled={!aiReady}
              onConfigure={onConfigureKey}
              focusSignal={focusSignal}
            />
          </>
        )}
      </div>

      {confirming ? (
        <div
          className="modal-backdrop"
          onMouseDown={() => {
            if (!deleting) setConfirming(null);
          }}
        >
          <div
            ref={confirmRef}
            className="modal modal--confirm"
            role="dialog"
            aria-modal="true"
            aria-labelledby="ai-delete-session-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <header className="modal__head">
              <h2 id="ai-delete-session-title" className="modal__title">
                删除对话
              </h2>
              <button
                type="button"
                className="modal__close"
                onClick={() => setConfirming(null)}
                disabled={deleting}
                aria-label="关闭"
              >
                <IconClose size={14} />
              </button>
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
