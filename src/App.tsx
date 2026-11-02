import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import type {
  AgentEvent,
  NextAction,
  RuntimeView,
} from "./agent/protocol";
import { AGENT_EVENTS } from "./agent/protocol";
import { applyRuntimeEvent, emptyRuntimeView, getAgentBridge, snapshotToView } from "./agent";
import { isTauri } from "./agent/bridge";
import type { ImportSeedResult } from "./agent/bridge";
import { BridgeError, toBridgeError } from "./agent/errors";
import { ChatView } from "./components/ChatView";
import { Settings, describeImportError } from "./components/Settings";
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
]);

export default function App() {
  const bridge = useMemo(() => getAgentBridge(), []);
  const [state, dispatch] = useReducer(chatReducer, undefined, createInitialState);
  const [statusOpen, setStatusOpen] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [runtime, setRuntime] = useState<RuntimeView>(() => emptyRuntimeView());
  const [deleteNotice, setDeleteNotice] = useState<DeleteNotice | null>(null);
  const [appNotice, setAppNotice] = useState<AppNotice | null>(null);
  const [dragging, setDragging] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<ImportSeedResult | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const importingRef = useRef(false);
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

  // 全应用唯一的导入入口：拖放和「选择文件」都走这里，两条路径行为不分叉。
  const importPath = useCallback(
    async (path: string) => {
      if (!/\.json$/i.test(path)) {
        setAppNotice({ level: "error", text: "只支持 .json 格式的节点文件，请换一个文件。" });
        return;
      }
      if (importingRef.current) return;

      importingRef.current = true;
      setImporting(true);
      setImportError(null);
      setImportResult(null);
      try {
        const result = await bridge.importSeedFile(path);
        setImportResult(result);
        setAppNotice({ level: "info", text: `已导入 ${result.imported} 个节点` });
      } catch (error) {
        const message = describeImportError(error);
        setImportError(message);
        setAppNotice({ level: "error", text: message });
      } finally {
        importingRef.current = false;
        setImporting(false);
      }
    },
    [bridge],
  );

  // 窗口级拖放：注册在 App，设置页没开也能接收。全应用只此一处。
  useEffect(() => {
    if (!isTauri()) return;

    let disposed = false;
    let unlisten: (() => void) | undefined;

    void getCurrentWebview()
      .onDragDropEvent((event) => {
        const payload = event.payload;
        if (payload.type === "enter" || payload.type === "over") {
          setDragging(true);
        } else if (payload.type === "leave") {
          setDragging(false);
        } else if (payload.type === "drop") {
          setDragging(false);
          // 多文件不静默丢弃：明确拒绝，让用户知道只处理一个。
          if (payload.paths.length > 1) {
            setAppNotice({
              level: "error",
              text: `一次只能导入一个文件，你拖入了 ${payload.paths.length} 个，请逐个拖入。`,
            });
            return;
          }
          const path = payload.paths[0];
          if (path) void importPath(path);
        }
      })
      .then((off) => {
        if (disposed) off();
        else unlisten = off;
      });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [importPath]);

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

  const handleSelectSession = (sessionId: string) => {
    dispatch({ type: "select_session", sessionId });

    // DB 恢复出来的会话：首次选中时才拉消息，避免启动时把所有会话都读一遍。
    const target = state.sessions.find((item) => item.id === sessionId);
    if (!target || target.historyLoaded) return;

    void bridge.getChatHistory(sessionId).then((history) => {
      dispatch({ type: "session_messages_loaded", sessionId, messages: history.messages });
    });
  };

  // 重命名：不乐观更新，成功后才用后端返回的标题落库。
  const handleRenameSession = async (
    sessionId: string,
    title: string,
  ): Promise<RenameResult> => {
    try {
      const updated = await bridge.renameSession(sessionId, title);
      dispatch({ type: "session_renamed", sessionId: updated.id, title: updated.title });
      return { ok: true };
    } catch (error) {
      const bridgeError = toBridgeError(error);

      if (bridgeError.code === "NOT_FOUND") {
        dispatch({ type: "session_removed", sessionId });
        return { ok: false, removed: true, message: "这个会话已经不存在了" };
      }
      return { ok: false, message: describeRenameError(bridgeError) };
    }
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
        onRenameSession={handleRenameSession}
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

        {appNotice ? (
          <div className={`notice-bar notice-bar--${appNotice.level}`} role="status">
            <span className="notice-bar__text">{appNotice.text}</span>
            <button
              type="button"
              className="notice-bar__close"
              aria-label="关闭提示"
              onClick={() => setAppNotice(null)}
            >
              ×
            </button>
          </div>
        ) : null}

        <ChatView
          session={session}
          onSend={handleSend}
          onStop={handleStop}
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

      <Settings
        open={settingsOpen}
        bridge={bridge}
        onClose={() => setSettingsOpen(false)}
        onNotice={setAppNotice}
        importing={importing}
        dragging={settingsOpen && dragging}
        importResult={importResult}
        importError={importError}
        onImportPath={importPath}
      />
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

/** 顶栏下方的提示条：导入结果这类一次性反馈。 */
interface AppNotice {
  level: "info" | "error";
  text: string;
}

function describeRenameError(error: BridgeError): string {
  if (error.code === "INVALID_ARGUMENT") {
    const reason = error.details?.reason;
    if (reason === "empty_title") return "标题不能为空";
    if (reason === "title_too_long") return "标题最多 80 个字符";
  }
  if (error.code === "NOT_FOUND") return "这个会话已经不存在了";
  return "保存失败，请重试";
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
