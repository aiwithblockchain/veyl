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
import type {
  DeepSeekKeyState,
  DefaultProfileStatus,
  ImportSeedResult,
  RuntimeAction,
  RuntimeProfile,
} from "./agent/bridge";
import { BridgeError, toBridgeError } from "./agent/errors";
import { ChatView } from "./components/ChatView";
import { ConsoleView } from "./components/ConsoleView";
import { Onboarding } from "./components/Onboarding";
import { Settings, describeImportError } from "./components/Settings";
import { Sidebar, type RenameResult } from "./components/Sidebar";
import { StatusPanel, type DeleteNotice } from "./components/StatusPanel";
import { activeSession, chatReducer, createInitialState, createSession, nextId } from "./state/chatStore";
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

const EMPTY_KEY_STATE: DeepSeekKeyState = {
  masked: null,
  verified: false,
  validation: "unverified",
};

export default function App() {
  const bridge = useMemo(() => getAgentBridge(), []);
  const [state, dispatch] = useReducer(chatReducer, undefined, createInitialState);
  const [view, setView] = useState<"overview" | "chat">("overview");
  const [statusOpen, setStatusOpen] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [runtime, setRuntime] = useState<RuntimeView>(() => emptyRuntimeView());
  const [deleteNotice, setDeleteNotice] = useState<DeleteNotice | null>(null);
  const [appNotice, setAppNotice] = useState<AppNotice | null>(null);
  const [dragging, setDragging] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<ImportSeedResult | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [keyState, setKeyState] = useState<DeepSeekKeyState>(EMPTY_KEY_STATE);
  const [profiles, setProfiles] = useState<RuntimeProfile[]>([]);
  const [activeProfileId, setActiveProfileId] = useState<string | null>(null);
  const [profilesLoaded, setProfilesLoaded] = useState(false);
  const [runtimeAction, setRuntimeAction] = useState<RuntimeAction | null>(null);
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [onboardingLoaded, setOnboardingLoaded] = useState(false);
  const [setupDismissed, setSetupDismissed] = useState(false);
  const [defaultProfile, setDefaultProfile] = useState<DefaultProfileStatus | null>(null);
  const [defaultBusy, setDefaultBusy] = useState(false);
  const [repairing, setRepairing] = useState(false);
  const importingRef = useRef(false);
  const runtimeActionRef = useRef(false);
  // 删除会话要先 cancel、等 ai-request-end 到齐再删；这里按 request_id 挂等待者。
  const endWaiters = useRef(new Map<string, () => void>());
  const sessionRef = useRef(state.activeSessionId);
  sessionRef.current = state.activeSessionId;
  // 健康事件的版本号：防止发出去要的旧快照把刚收到的 exit_ip 覆盖回 null。
  const healthVersion = useRef(0);

  const session = activeSession(state);
  const hasKey = keyState.masked !== null;

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

  const refreshKeyState = useCallback(async () => {
    try {
      const next = await bridge.getDeepSeekKey();
      setKeyState(next);
    } catch {
      setKeyState(EMPTY_KEY_STATE);
    }
  }, [bridge]);

  const refreshProfiles = useCallback(async () => {
    try {
      const data = await bridge.profileList();
      setProfiles(data.profiles);
      setActiveProfileId(data.activeProfileId);
      setProfilesLoaded(true);
    } catch {
      // 后端还没落地 profile_list 时保持空列表，也不据此提示「没有节点」。
    }
  }, [bridge]);

  const refreshDefaultProfile = useCallback(async () => {
    try {
      setDefaultProfile(await bridge.defaultProfileStatus());
    } catch {
      // wave2 命令未接线时不显示默认配置信息，不影响主流程。
    }
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
        void refreshProfiles();
      } catch (error) {
        const message = describeImportError(error);
        setImportError(message);
        setAppNotice({ level: "error", text: message });
      } finally {
        importingRef.current = false;
        setImporting(false);
      }
    },
    [bridge, refreshProfiles],
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
      if (event.name === AGENT_EVENTS.requestEnd) {
        const finish = endWaiters.current.get(event.payload.request_id);
        if (finish) {
          endWaiters.current.delete(event.payload.request_id);
          finish();
        }
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

  // 启动时确定是否要进首次引导（需求 §5.1）。
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      await Promise.all([refreshKeyState(), refreshProfiles(), refreshDefaultProfile()]);
      try {
        const status = await bridge.onboardingStatus();
        if (cancelled) return;
        // completed 一票否决；缺 Key 或缺配置任一条就进引导。
        setShowOnboarding(!status.completed && (!status.hasKey || status.profileCount === 0));
      } catch {
        // 命令还没就绪时不要卡住界面，也不弹引导。
        if (!cancelled) setShowOnboarding(false);
      } finally {
        if (!cancelled) setOnboardingLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [bridge, refreshKeyState, refreshProfiles, refreshDefaultProfile]);

  const completeOnboarding = async (skippedKey: boolean) => {
    try {
      await bridge.onboardingComplete(skippedKey);
    } catch {
      // 后端命令未就绪也允许继续用界面。
    }
    setShowOnboarding(false);
    setOnboardingLoaded(true);
    await Promise.all([refreshKeyState(), refreshProfiles()]);
  };

  const finishOnboarding = (skippedKey: boolean) => {
    void completeOnboarding(skippedKey);
  };

  const finishOnboardingWithImport = (skippedKey: boolean) => {
    setShowOnboarding(false);
    setSettingsOpen(true);
    void completeOnboarding(skippedKey);
  };

  const closeSettings = () => {
    setSettingsOpen(false);
    void Promise.all([refreshKeyState(), refreshProfiles()]);
  };

  // 删除当前会话后会切到剩余的第一个：它可能还没拉过历史，这里统一补拉。
  useEffect(() => {
    if (view !== "chat") return;
    const current = activeSession(state);
    if (!current || current.historyLoaded || current.messages.length > 0) return;

    let cancelled = false;
    void bridge.getChatHistory(current.id).then((history) => {
      if (!cancelled) {
        dispatch({
          type: "session_messages_loaded",
          sessionId: current.id,
          messages: history.messages,
        });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [view, state.activeSessionId, state.sessions, bridge]);

  const handleSelectSession = (sessionId: string) => {
    setView("chat");
    dispatch({ type: "select_session", sessionId });
    // 历史由上面的 activeSession 变化 effect 统一补拉，避免两条路径重复请求。
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
    if (!session) return;
    sendToSession(session.id, text);
  };

  const sendToSession = (sessionId: string, text: string) => {
    // 没有 Key 时对话发不出去：直接给入口，不让请求以失败告终。
    if (!hasKey) {
      setAppNotice({ level: "error", text: "还没有配置 DeepSeek Key，先配置后再对话。" });
      setSettingsOpen(true);
      return;
    }
    const localRequestId = nextId("local");
    dispatch({ type: "send_user_message", sessionId, text, localRequestId });

    void bridge
      .sendMessage(sessionId, text)
      .then(({ requestId }) => dispatch({ type: "request_started", requestId }))
      .catch((error: unknown) => {
        dispatch({
          type: "request_failed",
          message: error instanceof Error ? error.message : String(error),
        });
      });
  };

  const handleConsoleSend = (text: string) => {
    let target = session;
    if (!target) {
      target = createSession();
      dispatch({ type: "add_session", session: target });
    }
    setView("chat");
    sendToSession(target.id, text);
  };

  const handleStop = () => {
    const requestId = session?.activeRequestId ?? null;
    dispatch({ type: "cancel_request" });
    if (requestId) void bridge.cancel(requestId);
  };

  // next_actions 点击 = 用户发一条消息给 Agent，UI 不直接执行工具（契约 §1.3）。
  const handleNextAction = (action: NextAction) => {
    const args = Object.keys(action.args).length > 0 ? `（参数：${JSON.stringify(action.args)}）` : "";
    handleSend(`${action.label}${args}`);
  };

  const runRuntimeAction = async (kind: RuntimeAction, profileId?: string) => {
    if (runtimeActionRef.current) return;
    runtimeActionRef.current = true;
    setRuntimeAction(kind);
    try {
      if (kind === "start") {
        await bridge.runtimeStart(profileId ?? runtime.profile_id ?? undefined);
      } else {
        await bridge.runtimeStop();
      }
      refreshSnapshot();
      void refreshProfiles();
    } catch (error) {
      setAppNotice({ level: "error", text: describeRuntimeError(error) });
    } finally {
      runtimeActionRef.current = false;
      setRuntimeAction(null);
    }
  };

  const handleConnect = () => {
    void runRuntimeAction("start");
  };

  const handleDisconnect = () => {
    void runRuntimeAction("stop");
  };

  const handleSwitchProfile = (profileId: string) => {
    void runRuntimeAction("start", profileId);
  };

  const handleDiagnose = () => {
    if (!hasKey) {
      setAppNotice({ level: "error", text: "诊断需要配置 DeepSeek Key，请先去设置。" });
      setSettingsOpen(true);
      return;
    }
    handleConsoleSend("诊断网络");
  };

  const handleRefreshDefault = async () => {
    if (defaultBusy) return;
    setDefaultBusy(true);
    try {
      const next = await bridge.defaultProfileRefresh();
      setDefaultProfile(next);
      setAppNotice({
        level: "info",
        text: next.newVersionAvailable
          ? "已获取新的默认配置，下次连接生效。"
          : `默认配置已是最新（${next.nodeCount} 个节点）。`,
      });
      void refreshProfiles();
    } catch (error) {
      setAppNotice({ level: "error", text: describeDefaultProfileError(error) });
    } finally {
      setDefaultBusy(false);
    }
  };

  const handleUseDefault = () => {
    void handleRefreshDefault();
  };

  // 恢复网络不依赖 AI：撤代理 → 停运行时 → 清明文配置（commands.md §3.6）。
  const handleRestoreNetwork = async () => {
    if (repairing) return;
    setRepairing(true);
    try {
      const result = await bridge.netRepair("restore_direct");
      setAppNotice({
        level: result.ok ? "info" : "error",
        text: result.detail || (result.ok ? "网络已恢复直连。" : "恢复网络失败，请重试。"),
      });
      refreshSnapshot();
      void refreshProfiles();
    } catch (error) {
      setAppNotice({ level: "error", text: describeCommandError(error, "恢复网络") });
    } finally {
      setRepairing(false);
    }
  };

  const handleOpenLogs = () => {
    void bridge.openLogDir().catch((error: unknown) => {
      setAppNotice({ level: "error", text: describeCommandError(error, "打开日志") });
    });
  };

  // 删除配置：后端拒绝删除活动配置，所以这里只做引导，不给「强制删除」的假出口。
  const handleDeleteProfile = (profileId: string) => {
    // 默认配置包连接时 runtime.profile_id 为 null，不能把 null 当成「匹配所有」。
    const connectedToProfile =
      runtime.profile_id !== null && profileId === runtime.profile_id;
    const idleActive = runtime.state === "idle" && profileId === activeProfileId;
    if (connectedToProfile || idleActive) {
      setDeleteNotice({ text: "这个配置仍在使用。先点主按钮「断开」，再回来删除。" });
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
        void refreshProfiles();
      },
      (error: unknown) => {
        const bridgeError = toBridgeError(error);
        if (
          bridgeError.code === "PRECONDITION_FAILED" &&
          /ACTIVE_PROFILE_IN_USE/i.test(bridgeError.message)
        ) {
          setDeleteNotice({ text: "这个配置仍在使用。先点主按钮「断开」，再回来删除。" });
          return;
        }
        setDeleteNotice({ text: errorMessage(error) });
      },
    );
  };

  // 等待某一轮请求真正结束（ai-request-end）；超时也放行，让后端用 active_request 明确拒绝。
  const waitForRequestEnd = (requestId: string, timeoutMs = 5000): Promise<void> =>
    new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        endWaiters.current.delete(requestId);
        resolve();
      };
      const timer = window.setTimeout(finish, timeoutMs);
      endWaiters.current.set(requestId, finish);
    });

  // R31：删除会话。有进行中的请求先取消，删完最后一个会话就回总览空态。
  const handleDeleteSession = async (
    sessionId: string,
  ): Promise<{ ok: boolean; message?: string }> => {
    const target = state.sessions.find((item) => item.id === sessionId);
    if (!target) {
      // UI 里已经没有这条：仍让后端删一次，避免「界面没了、库里还在」。
      try {
        await bridge.deleteSession(sessionId);
      } catch {
        // NOT_FOUND 或命令未接入都不影响本地状态。
      }
      dispatch({ type: "session_removed", sessionId });
      return { ok: true };
    }

    if (!target.activeRequestId && target.requesting) {
      // 请求刚发出、Host 还没回 request_id：此刻 cancel 无从下手，先拦住。
      return { ok: false, message: "这条消息正在发出，请稍候再删除。" };
    }

    if (target.activeRequestId) {
      // 先挂等待者再 cancel，避免 request-end 在两者之间到达。
      const ended = waitForRequestEnd(target.activeRequestId);
      try {
        await bridge.cancel(target.activeRequestId);
      } catch {
        // 取消失败也继续等/删；后端会用 active_request 明确拒绝。
      }
      await ended;
    }

    try {
      await bridge.deleteSession(sessionId);
    } catch (error) {
      const bridgeError = toBridgeError(error);
      if (bridgeError.code === "NOT_FOUND") {
        // 库里已经没了：本地也清掉，不能出现「界面还在、库里已删」。
        dispatch({ type: "session_removed", sessionId });
        return { ok: true };
      }
      if (bridgeError.code === "PRECONDITION_FAILED") {
        return { ok: false, message: "这个会话还有进行中的请求，先停止再删除。" };
      }
      if (/not found|unknown command/i.test(bridgeError.message)) {
        return { ok: false, message: "当前版本还没有接入删除会话命令，请稍后再试。" };
      }
      return { ok: false, message: bridgeError.message || "删除失败，请重试" };
    }

    dispatch({ type: "session_removed", sessionId });
    const remaining = state.sessions.filter((item) => item.id !== sessionId);
    if (state.activeSessionId === sessionId && remaining.length === 0) {
      setView("overview");
    }
    return { ok: true };
  };

  const showSetupHint =
    onboardingLoaded &&
    !showOnboarding &&
    !setupDismissed &&
    (!hasKey || (profilesLoaded && profiles.length === 0));

  if (!onboardingLoaded) {
    // 正在判断要不要进引导：先不渲染主界面，避免控制台闪一下。
    return <div className="app-boot" aria-hidden />;
  }

  if (showOnboarding) {
    return (
      <Onboarding
        bridge={bridge}
        initialKey={keyState}
        onDone={finishOnboarding}
        onImport={finishOnboardingWithImport}
      />
    );
  }

  return (
    <div className={`app ${statusOpen ? "" : "app--status-collapsed"}`}>
      <Sidebar
        sessions={state.sessions}
        activeSessionId={state.activeSessionId}
        view={view}
        mode={bridge.mode}
        onSelect={handleSelectSession}
        onSelectOverview={() => setView("overview")}
        onNew={() => {
          dispatch({ type: "new_session" });
          setView("chat");
        }}
        onOpenSettings={() => setSettingsOpen(true)}
        onRenameSession={handleRenameSession}
        onDeleteSession={handleDeleteSession}
      />

      <main className="main">
        <header className="topbar">
          <div className="topbar__left">
            <span className="topbar__title">
              {view === "overview" ? "总览" : session?.title ?? "新会话"}
            </span>
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

        {showSetupHint ? (
          <div className="setup-bar" role="status">
            <span className="setup-bar__text">
              {!hasKey
                ? "还没配置 DeepSeek Key：AI 对话与诊断不可用，不影响连接。"
                : "还没有节点：导入配置文件后就能连接。"}
            </span>
            <button
              type="button"
              className="setup-bar__action"
              onClick={() => setSettingsOpen(true)}
            >
              {!hasKey ? "去配置" : "导入配置"}
            </button>
            <button
              type="button"
              className="setup-bar__close"
              aria-label="关闭提示"
              onClick={() => setSetupDismissed(true)}
            >
              ×
            </button>
          </div>
        ) : null}

        {view === "overview" || !session ? (
          <ConsoleView
            runtime={runtime}
            profiles={profiles}
            activeProfileId={activeProfileId}
            hasKey={hasKey}
            pending={runtimeAction}
            streaming={Boolean(session?.activeRequestId) || session?.requesting === true}
            statusText={session?.status?.text ?? null}
            onConnect={handleConnect}
            onDisconnect={handleDisconnect}
            onSwitchProfile={handleSwitchProfile}
            onImport={() => setSettingsOpen(true)}
            onConfigureKey={() => setSettingsOpen(true)}
            onDiagnose={handleDiagnose}
            onSend={handleConsoleSend}
            onStop={handleStop}
            defaultProfile={defaultProfile}
            defaultBusy={defaultBusy}
            repairing={repairing}
            onUseDefault={handleUseDefault}
            onRefreshDefault={() => void handleRefreshDefault()}
            onRestoreNetwork={() => void handleRestoreNetwork()}
          />
        ) : (
          <ChatView
            session={session}
            onSend={handleSend}
            onStop={handleStop}
            onNextAction={handleNextAction}
            hasKey={hasKey}
            onConfigureKey={() => setSettingsOpen(true)}
          />
        )}
      </main>

      {statusOpen ? (
        <StatusPanel
          status={runtime}
          profiles={profiles}
          activeProfileId={activeProfileId}
          pending={runtimeAction}
          onCollapse={() => setStatusOpen(false)}
          onConnect={handleConnect}
          onDisconnect={handleDisconnect}
          onSwitchProfile={handleSwitchProfile}
          onImport={() => setSettingsOpen(true)}
          onOpenLogs={handleOpenLogs}
          onDeleteProfile={handleDeleteProfile}
          deleteNotice={deleteNotice}
        />
      ) : null}

      <Settings
        open={settingsOpen}
        bridge={bridge}
        onClose={closeSettings}
        onNotice={setAppNotice}
        importing={importing}
        dragging={settingsOpen && dragging}
        importResult={importResult}
        importError={importError}
        onImportPath={importPath}
        onRestartOnboarding={() => {
          setSettingsOpen(false);
          setShowOnboarding(true);
        }}
      />
    </div>
  );
}

function errorMessage(error: unknown): string {
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && "message" in error) {
    return String((error as { message: unknown }).message);
  }
  return "操作失败";
}

/** 连接/断开的失败说法：区分「代理没恢复」和「没有节点」这两种要用户动手的情况。 */
function describeRuntimeError(error: unknown): string {
  const bridgeError = toBridgeError(error);
  const reason = bridgeError.details?.reason;
  if (reason === "proxy_restore_failed") {
    return "系统代理没能恢复，为避免断网已保持连接。请重试，或重启应用。";
  }
  if (reason === "no_active_profile") {
    return "还没有可用的节点，先导入一份配置文件。";
  }
  return bridgeError.message || "操作失败，请重试";
}

/** 默认配置源不可达是离线场景的正常结果，不要显示成故障。 */
function describeDefaultProfileError(error: unknown): string {
  const bridgeError = toBridgeError(error);
  if (/not found|unknown command/i.test(bridgeError.message)) {
    return "默认配置命令还没有接入当前版本，可以先用「导入文件」导入本地节点。";
  }
  const offline = /network|offline|unreachable|timeout|dns|connect/i.test(bridgeError.message);
  if (offline || bridgeError.code === "TIMEOUT" || bridgeError.code === "UNSUPPORTED") {
    return "默认配置源暂时不可达（离线时属正常）。可以先用「导入文件」导入本地节点。";
  }
  return bridgeError.message || "获取默认配置失败，请稍后重试。";
}

function describeCommandError(error: unknown, label: string): string {
  const bridgeError = toBridgeError(error);
  if (/not found|unknown command/i.test(bridgeError.message)) {
    return `${label}还没有接入当前版本，请稍后再试。`;
  }
  return bridgeError.message || `${label}失败，请重试。`;
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
