import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import type {
  AgentEvent,
  ApprovalDecision,
  ApprovalScope,
  NextAction,
  RuntimeView,
} from "./agent/protocol";
import { AGENT_EVENTS } from "./agent/protocol";
import { applyRuntimeEvent, emptyRuntimeView, getAgentBridge, snapshotToView } from "./agent";
import { ChatView } from "./components/ChatView";
import { Sidebar } from "./components/Sidebar";
import { StatusPanel } from "./components/StatusPanel";
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
  const [runtime, setRuntime] = useState<RuntimeView>(() => emptyRuntimeView());
  const sessionRef = useRef(state.activeSessionId);
  sessionRef.current = state.activeSessionId;

  const session = activeSession(state);

  useEffect(() => {
    return bridge.subscribe((event) => {
      setRuntime((view) => applyRuntimeEvent(view, event));
      if (AI_EVENTS.has(event.name)) {
        dispatch({ type: "agent_event", event });
      }
    });
  }, [bridge]);

  useEffect(() => {
    void bridge.getRuntimeSnapshot().then((snapshot) => {
      if (snapshot) setRuntime(snapshotToView(snapshot));
    });
  }, [bridge]);

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

  return (
    <div className={`app ${statusOpen ? "" : "app--status-collapsed"}`}>
      <Sidebar
        sessions={state.sessions}
        activeSessionId={state.activeSessionId}
        mode={bridge.mode}
        onSelect={(sessionId) => dispatch({ type: "select_session", sessionId })}
        onNew={() => dispatch({ type: "new_session" })}
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
        <StatusPanel status={runtime} onCollapse={() => setStatusOpen(false)} />
      ) : null}
    </div>
  );
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
