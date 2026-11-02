import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import type {
  AgentEvent,
  ApprovalDecision,
  ApprovalScope,
  NextAction,
  RuntimeView,
} from "./agent/protocol";
import { AGENT_EVENTS } from "./agent/protocol";
import { applyRuntimeEvent, emptyRuntimeView, getAgentBridge, snapshotToView } from "./agent";
import { BridgeError, toBridgeError } from "./agent/errors";
import { ChatView } from "./components/ChatView";
import { Settings } from "./components/Settings";
import { Sidebar, type RenameResult } from "./components/Sidebar";
import { StatusPanel, type DeleteNotice } from "./components/StatusPanel";
import { activeSession, chatReducer, createInitialState, nextId } from "./state/chatStore";
import "./styles/app.css";

const AI_EVENTS = new Set<AgentEvent["name"]>([
  AGENT_EVENTS.messageChunk,
  AGENT_EVENTS.thinkingChunk,
  AGENT_EVENTS.toolCallStart,
  AGENT_EVENTS.toolCallEnd,
  AGENT_EVENTS.status,
  AGENT_EVENTS.compact,
  AGENT_EVENTS.requestEnd,
  AGENT_EVENTS.approvalRequested,
]);

export default function App() {
  const bridge = useMemo(() => getAgentBridge(), []);
  const [state, dispatch] = useReducer(chatReducer, undefined, createInitialState);
  const [statusOpen, setStatusOpen] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [runtime, setRuntime] = useState<RuntimeView>(() => emptyRuntimeView());
  const [deleteNotice, setDeleteNotice] = useState<DeleteNotice | null>(null);
  const sessionRef = useRef(state.activeSessionId);
  sessionRef.current = state.activeSessionId;
  // 健康事件的版本号：防止发出去要的旧快照把刚收到的 exit_ip 覆盖回 null。
  const healthVersion = useRef(0);

  const session = activeSession(state);

  const refreshSnapshot = useCallback(() => {
    const versionAtRequest = healthVersion.current;
    void bridge.getRuntimeSnapshot().then((snapshot) => {
      if (!snapshot) return;
      const base = snapshotToView(snapshot);
      setRuntime((current) =>
        versionAtRequest === healthVersion.current
          ? base
          : { ...base, health: current.health },
      );
    });
  }, [bridge]);

  useEffect(() => {
    return bridge.subscribe((event) => {
      if (event.name === AGENT_EVENTS.runtimeHealthChanged) healthVersion.current += 1;
      setRuntime((view) => applyRuntimeEvent(view, event));
      if (AI_EVENTS.has(event.name)) {
        dispatch({ type: "agent_event", event });
      }
      // profile_id / uptime / 连接数 只在快照里，状态迁移后补拉一次。
      if (event.name === AGENT_EVENTS.runtimeStateChanged) {
        refreshSnapshot();
      }
    });
  }, [bridge, refreshSnapshot]);

  useEffect(() => {
    refreshSnapshot();
  }, [refreshSnapshot]);

  // 重启后恢复会话：数据库为空时 hydrate 是空操作，保持「新建空会话」。
  useEffect(() => {
    let cancelled = false;
    void bridge.getChatHistory().then((history) => {
      if (!cancelled) dispatch({ type: "hydrate_history", history });
    });
    return () => {
      cancelled = true;
    };
  }, [bridge]);

  const handleSelectSession = (sessionId: string) => {    dispatch({ type: "select_session", sessionId });

    // DB 恢复出来的会话：首次选中时才拉消息，避免启动时把所有会话都读一遍。
    const target = state.sessions.find((item) => item.id === sessionId);
    if (!target || target.historyLoaded) return;

    void bridge.getChatHistory(sessionId).then((history) => {
      dispatch({ type: "session_messages_loaded", sessionId, messages: history.messages });
    });
  };

  const handleSend = (text: string) => {
    const localRequestId = nextId("local");
    dispatch({ type: "send_user_message", text, localRequestId });

    void bridge
      .sendMessage(session.id, text)
      .then(({ requestId }) => dispatch({ type: "request_started", requestId }))
      .catch((error: unknown) => {
        dispatch({
          type: "request_failed",
          message: error instanceof Error ? error.message : String(error),
        });
      });
  };

  const handleStop = () => {
    const requestId = session.activeRequestId;
    dispatch({ type: "cancel_request" });
    if (requestId) void bridge.cancel(requestId);
  };

  const handleDecide = (
    approvalId: string,
    decision: ApprovalDecision,
    scope: ApprovalScope,
  ) => {
    dispatch({ type: "approval_decision", approvalId, decision, scope });
    void bridge.respondApproval(approvalId, decision, scope);
  };

  // next_actions 点击 = 用户发一条消息给 Agent，UI 不直接执行工具（契约 §1.3）。
  const handleNextAction = (action: NextAction) => {
    const args = Object.keys(action.args).length > 0 ? `（参数：${JSON.stringify(action.args)}）` : "";
    handleSend(`${action.label}${args}`);
  };

  // 删除配置：正在使用的配置先给提示，确认后再删（不自动断开连接）。
  const handleDeleteProfile = (profileId: string) => {
    if (runtime.state === "running" && runtime.profile_id === profileId) {
      setDeleteNotice({
        text: "当前连接仍在使用这个配置，删除不会断开连接，断开后该配置将不再可用。",
        confirmProfileId: profileId,
      });
      return;
    }
    void removeProfile(profileId);
  };

  const removeProfile = (profileId: string) => {
    setDeleteNotice(null);
    void bridge.deleteProfile(profileId).then(
      () => {
        setDeleteNotice({ text: "配置已删除。" });
        refreshSnapshot();
      },
      (error: unknown) => setDeleteNotice({ text: errorMessage(error) }),
    );
  };

  return (
    <div className={`app ${statusOpen ? "" : "app--status-collapsed"}`}>
      <Sidebar
        sessions={state.sessions}
        activeSessionId={state.activeSessionId}
        mode={bridge.mode}
        onSelect={handleSelectSession}
        onNew={() => dispatch({ type: "new_session" })}
        onOpenSettings={() => setSettingsOpen(true)}
      />

      <main className="main">
        <header className="topbar">
          <div className="topbar__left">
            <span className="topbar__title">{session.title}</span>
          </div>
          <div className="topbar__right">
            <span className={`topbar__pill topbar__pill--${runtime.state}`}>
              <span className="topbar__pill-dot" aria-hidden />
              {pillText(runtime.state)}
            </span>
            {!statusOpen ? (
              <button type="button" className="topbar__toggle" onClick={() => setStatusOpen(true)}>
                状态面板
              </button>
            ) : null}
          </div>
        </header>

        <ChatView
          session={session}
          onSend={handleSend}
          onStop={handleStop}
          onDecide={handleDecide}
          onNextAction={handleNextAction}
        />
      </main>

      {statusOpen ? (
        <StatusPanel
          status={runtime}
          onCollapse={() => setStatusOpen(false)}
          onDeleteProfile={handleDeleteProfile}
          onConfirmDelete={removeProfile}
          deleteNotice={deleteNotice}
        />
      ) : null}

      <Settings open={settingsOpen} bridge={bridge} onClose={() => setSettingsOpen(false)} />
    </div>
  );
}

function errorMessage(error: unknown): string {
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && "message" in error) {
    return String((error as { message: unknown }).message);
  }
  return "删除失败";
}

function pillText(state: RuntimeView["state"]): string {
  switch (state) {
    case "running":
      return "已连接";
    case "idle":
      return "未连接";
    case "failed":
      return "连接失败";
    case "degraded":
      return "连接异常";
    default:
      return "处理中";
  }
}
