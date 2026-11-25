import { useEffect, useRef, useState } from "react";
import type { PendingQuestion } from "../agent/bridge";
import { isConfirmQuestionKind } from "../agent/bridge";
import type { NextAction } from "../agent/protocol";
import type { Session } from "../state/chatStore";
import type { DisplayActionOutcome } from "./ToolCallCard";
import type { ToolDisplayAction } from "./toolDisplay";
import { useFocusTrap } from "../ui/focus";
import { isComposingEvent } from "../ui/ime";
import { getLanguage, t as translate, useT } from "../i18n";
import { AskQuestionCard, QuestionAwayLine } from "./AskQuestionCard";
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
  /** 当前服务商显示名；未知为 null，未配置时助手头部显示「未连接 AI」。 */
  aiProviderName: string | null;
  hasEverConnected: boolean;
  hasConfigs: boolean;
  /** 只有 client / no_nodes 屏展示预制问题；其它屏不显示。 */
  presetsVisible?: boolean;
  /** 当前会话待回答的提问；普通提问渲染在消息流末尾。 */
  question?: PendingQuestion | null;
  /** 非空 = 提问不属于当前屏幕：卡片折叠成这一行只读提示。 */
  questionAwayText?: string | null;
  /** 提问已过期：显示「这个问题已过期。」，选项禁用。 */
  questionExpired?: boolean;
  /** 点折叠行回到发起提问的屏幕。 */
  onReturnToQuestion?: () => void;
  onAnswerQuestion?: (answer: string) => void | boolean | Promise<void | boolean>;
  /** 输入框发送时走的回答路径；失败返回 false，让文字留在输入框。 */
  onAnswerFromComposer?: (text: string) => void | boolean | Promise<void | boolean>;
  onQuestionExpired?: () => void;
  onSelectSession: (sessionId: string) => void;
  onNewSession: () => void;
  onRenameSession: (sessionId: string, title: string) => Promise<RenameResult>;
  onDeleteSession: (sessionId: string) => Promise<{ ok: boolean; message?: string }>;
  onSend: (text: string) => void | boolean | Promise<void | boolean>;
  onEmptySend: (text: string) => void | boolean | Promise<void | boolean>;
  onStop: () => void;
  onNextAction: (action: NextAction) => void;
  onDisplayAction?: (action: ToolDisplayAction) => Promise<DisplayActionOutcome>;
  onOpenSettings: () => void;
  onConfigureKey: () => void;
  /** 收起助手；宽屏停靠时收成右边缘 tab。 */
  onCollapse: () => void;
  /** 输入框草稿由上层按会话持有，助手搬到弹层重挂载也不丢。 */
  composerDraft?: string;
  onComposerDraftChange?: (text: string) => void;
}

/** 对话空态的预制问题（assistant-empty-state.md §2）；它们是按钮文案，句末不加问号。 */
const PRESET_KEYS = [
  "assistant.preset.connectIssue",
  "assistant.preset.fasterNode",
  "assistant.preset.appBypass",
  "assistant.preset.siteBlocked",
  "assistant.preset.terminal",
] as const;

function relativeTime(at: number): string {
  const diff = Date.now() - at;
  const minute = 60_000;
  if (diff < minute) return translate("assistant.time.justNow");
  if (diff < 60 * minute) {
    return translate("assistant.time.minutesAgo", {
      count: Math.floor(diff / minute),
    });
  }
  if (diff < 24 * 60 * minute) {
    return translate("assistant.time.hoursAgo", {
      count: Math.floor(diff / (60 * minute)),
    });
  }
  return new Date(at).toLocaleDateString(
    getLanguage() === "en" ? "en-US" : "zh-CN",
    { month: "numeric", day: "numeric" },
  );
}

/** 右栏：一级是对话，二级是历史会话。设置沿用现有设置页。 */
export function AiPanel({
  session,
  sessions,
  activeSessionId,
  aiReady,
  aiProviderName,
  hasEverConnected,
  hasConfigs,
  presetsVisible = true,
  question = null,
  questionAwayText = null,
  questionExpired = false,
  onReturnToQuestion,
  onAnswerQuestion,
  onAnswerFromComposer,
  onQuestionExpired,
  onSelectSession,
  onNewSession,
  onRenameSession,
  onDeleteSession,
  onSend,
  onEmptySend,
  onStop,
  onNextAction,
  onDisplayAction,
  onOpenSettings,
  onConfigureKey,
  onCollapse,
  composerDraft,
  onComposerDraftChange,
}: Props) {
  const t = useT();
  const [view, setView] = useState<View>("chat");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [messagesFocusSignal, setMessagesFocusSignal] = useState(0);
  const [editError, setEditError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirming, setConfirming] = useState<Session | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const editRef = useRef<HTMLInputElement>(null);
  const confirmRef = useRef<HTMLDivElement>(null);
  useFocusTrap(Boolean(confirming), confirmRef);

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
    setEditError(result.message ?? t("assistant.error.rename"));
    if (result.removed) setEditingId(null);
  };

  const submitDelete = async () => {
    if (!confirming || deleting) return;
    setDeleting(true);
    setDeleteError(null);
    const result = await onDeleteSession(confirming.id);
    setDeleting(false);
    if (result.ok) setConfirming(null);
    else setDeleteError(result.message ?? t("assistant.error.delete"));
  };

  const hasMessages = Boolean(session && session.messages.length > 0);
  const needsFirstConfig = aiReady && !hasConfigs;
  const confirmKindOnly = Boolean(
    question && isConfirmQuestionKind(question.kind),
  );
  // 离屏：折叠成一行只读提示，这一屏不渲染可点选项，也不接输入框的回答。
  const awayQuestion =
    question && !confirmKindOnly && questionAwayText
      ? { text: questionAwayText, expiresAt: question.expiresAt }
      : null;
  const inlineQuestion =
    question && !confirmKindOnly && !awayQuestion ? question : null;
  const canAnswer = Boolean(inlineQuestion) && !questionExpired;
  const answerFromComposer =
    canAnswer && onAnswerFromComposer ? onAnswerFromComposer : undefined;

  return (
    <aside id="ai-panel" className="ai-panel" aria-label={t("assistant.panelAria")}>
      <header className="ai-panel__head">
        {view === "history" ? (
          <div className="ai-panel__id">
            <button
              type="button"
              className="ai-panel__icon"
              onClick={() => setView("chat")}
              aria-label={t("assistant.backToChat")}
              title={t("assistant.backToChat")}
            >
              <IconChevronLeft size={16} />
            </button>
            <span className="ai-panel__name">{t("assistant.history")}</span>
          </div>
        ) : (
          <div className="ai-panel__id">
            <span className="ai-panel__name">{t("assistant.name")}</span>
            <span className="ai-panel__model">
              {aiReady ? aiProviderName?.trim() || "AI" : t("assistant.notConnected")}
            </span>
          </div>
        )}
        <div className="ai-panel__head-right">
          {aiReady ? (
            <>
              <button
                type="button"
                className="ai-panel__icon"
                onClick={() => {
                  onNewSession();
                  setView("chat");
                }}
                aria-label={t("assistant.newChat")}
                title={t("assistant.newChat")}
              >
                <IconPlus size={16} />
              </button>
              {view === "chat" ? (
                <button
                  type="button"
                  className="ai-panel__icon"
                  onClick={() => setView("history")}
                  aria-label={t("assistant.history")}
                  title={t("assistant.history")}
                >
                  <IconList size={16} />
                </button>
              ) : null}
            </>
          ) : null}
          <button
            type="button"
            className="ai-panel__icon"
            onClick={onCollapse}
            aria-label={t("assistant.collapse")}
            title={t("assistant.collapse")}
          >
            <IconChevronRight size={16} />
          </button>
        </div>
      </header>

      <div className="ai-panel__body">
        {!aiReady ? (
          <div className="ai-empty ai-panel__setup">
            <p className="ai-empty__line">{t("assistant.setup.title")}</p>
            <p className="ai-empty__text">{t("assistant.setup.body")}</p>
            <div className="ai-panel__setup-action">
              <button type="button" className="btn btn--primary" onClick={onOpenSettings}>
                {t("assistant.setup.configure")}
              </button>
            </div>
          </div>
        ) : view === "history" ? (
          <div className="ai-history">
            {sessions.length === 0 ? (
              <p className="ai-history__empty">{t("assistant.historyEmpty")}</p>
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
                          aria-label={t("assistant.sessionTitle")}
                          disabled={saving}
                          onChange={(event) => {
                            setDraft(event.target.value);
                            setEditError(null);
                          }}
                          onKeyDown={(event) => {
                            if (isComposingEvent(event)) return;
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
                          title={t("assistant.renameHint")}
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
                            aria-label={t("assistant.renameSessionAria", { title: item.title })}
                            title={t("assistant.renameSessionTitle", { title: item.title })}
                            onClick={() => startEdit(item)}
                          >
                            <IconPencil size={13} />
                          </button>
                          <button
                            type="button"
                            className="ai-history__action ai-history__action--danger"
                            aria-label={t("assistant.deleteSessionAria", { title: item.title })}
                            title={t("assistant.deleteSessionTitle", { title: item.title })}
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
            question={awayQuestion ? null : question}
            questionAway={awayQuestion}
            questionExpired={questionExpired}
            onReturnToQuestion={onReturnToQuestion}
            onAnswerQuestion={onAnswerQuestion}
            onAnswerFromComposer={answerFromComposer}
            onQuestionExpired={onQuestionExpired}
            onStop={onStop}
            onNextAction={onNextAction}
            onDisplayAction={onDisplayAction}
            hasKey={aiReady}
            onConfigureKey={onConfigureKey}
            focusMessagesSignal={messagesFocusSignal}
            composerDraft={composerDraft}
            onComposerDraftChange={onComposerDraftChange}
          />
        ) : (
          <>
            <div className="ai-empty">
              <p className="ai-empty__line">
                {needsFirstConfig
                  ? t("assistant.empty.noConfig")
                  : hasEverConnected
                    ? t("assistant.empty.connected")
                    : t("assistant.empty.notConnected")}
              </p>
              {!hasEverConnected && !needsFirstConfig ? (
                <p className="ai-empty__text">{t("assistant.empty.connectHint")}</p>
              ) : null}
              {aiReady && !question && presetsVisible ? (
                <div
                  className="ai-empty__suggest"
                  role="group"
                  aria-label={t("assistant.presetsAria")}
                >
                  {PRESET_KEYS.map((preset) => (
                    <button
                      key={preset}
                      type="button"
                      onClick={() => {
                        void onEmptySend(t(preset));
                        setMessagesFocusSignal((value) => value + 1);
                      }}
                    >
                      {t(preset)}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
            {awayQuestion ? (
              <div className="ask-question-slot">
                <QuestionAwayLine
                  away={awayQuestion}
                  onReturn={onReturnToQuestion}
                />
              </div>
            ) : inlineQuestion ? (
              <div className="ask-question-slot">
                <AskQuestionCard
                  question={inlineQuestion}
                  expired={questionExpired}
                  onAnswer={onAnswerQuestion ?? (async () => undefined)}
                  onExpire={onQuestionExpired ?? (() => undefined)}
                />
              </div>
            ) : null}
            <Composer
              streaming={false}
              questionPending={canAnswer}
              statusText={null}
              onSend={
                canAnswer && onAnswerFromComposer
                  ? onAnswerFromComposer
                  : onEmptySend
              }
              onStop={onStop}
              disabled={!aiReady}
              onConfigure={onConfigureKey}
              value={composerDraft}
              onValueChange={onComposerDraftChange}
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
                {t("assistant.delete.title")}
              </h2>
              <button
                type="button"
                className="modal__close"
                onClick={() => setConfirming(null)}
                disabled={deleting}
                aria-label={t("common.close")}
              >
                <IconClose size={14} />
              </button>
            </header>
            <p className="confirm__text">
              {t("assistant.delete.body", { title: confirming.title })}
            </p>
            {deleteError ? <p className="confirm__error">{deleteError}</p> : null}
            <div className="confirm__actions">
              <button
                type="button"
                className="btn btn--ghost"
                onClick={() => setConfirming(null)}
                disabled={deleting}
              >
                {t("common.cancel")}
              </button>
              <button
                type="button"
                className="btn btn--danger-ghost"
                onClick={() => void submitDelete()}
                disabled={deleting}
              >
                {deleting ? t("assistant.delete.deleting") : t("assistant.delete.action")}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </aside>
  );
}
