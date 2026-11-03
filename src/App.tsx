import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import type { AgentEvent, NextAction, RuntimeView } from "./agent/protocol";
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
import { DiagnosisSheet } from "./components/DiagnosisSheet";
import { EmptyChat } from "./components/EmptyChat";
import { Onboarding } from "./components/Onboarding";
import { Settings, describeImportError } from "./components/Settings";
import { Sidebar, type RenameResult } from "./components/Sidebar";
import { StatusPanel } from "./components/StatusPanel";
import { activeSession, chatReducer, createInitialState, createSession, nextId } from "./state/chatStore";
import { primaryAction, statusSentence, statusTone, toLinkState, toneClass } from "./ui/status";
import { useFocusTrap } from "./ui/focus";
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

type SettingsSection = "ai" | "network" | "advanced" | "about";

const EVER_CONNECTED_KEY = "veyl.hasEverConnected";
const PANEL_KEY = "veyl.ui.panelOpen";
const NARROW_WIDTH = 1100;

function readEverConnected(): boolean {
  try {
    return localStorage.getItem(EVER_CONNECTED_KEY) === "1" ||
      localStorage.getItem("veyl.hasConnected") === "1";
  } catch {
    return false;
  }
}

export default function App() {
  const bridge = useMemo(() => getAgentBridge(), []);
  const [state, dispatch] = useReducer(chatReducer, undefined, createInitialState);
  const [panelPreferred, setPanelPreferred] = useState(() => {
    try {
      return localStorage.getItem(PANEL_KEY) === "1";
    } catch {
      return false;
    }
  });
  const [overlayOpen, setOverlayOpen] = useState(false);
  const overlayRef = useRef<HTMLDivElement>(null);
  const [narrow, setNarrow] = useState(
    () => typeof window !== "undefined" && window.innerWidth < NARROW_WIDTH,
  );
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState<SettingsSection>("ai");
  const [diagnosisOpen, setDiagnosisOpen] = useState(false);
  const [runtime, setRuntime] = useState<RuntimeView>(() => emptyRuntimeView());
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
  const [hasEverConnected, setHasEverConnected] = useState(readEverConnected);
  const [defaultProfile, setDefaultProfile] = useState<DefaultProfileStatus | null>(null);
  const [defaultBusy, setDefaultBusy] = useState(false);
  const [repairing, setRepairing] = useState(false);
  const importingRef = useRef(false);
  const runtimeActionRef = useRef(false);
  const connectTestRef = useRef(false);
  const endWaiters = useRef(new Map<string, () => void>());
  // 健康事件的版本号：防止发出去要的旧快照把刚收到的 exit_ip 覆盖回 null。
  const healthVersion = useRef(0);

  const session = activeSession(state);
  const hasKey = keyState.masked !== null;

  const openSettings = (section: SettingsSection = "ai") => {
    setSettingsSection(section);
    setSettingsOpen(true);
  };

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
      setKeyState(await bridge.getDeepSeekKey());
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
      // 后端命令未就绪时保持空列表，也不据此提示「没有节点」。
    }
  }, [bridge]);

  const refreshDefaultProfile = useCallback(async () => {
    try {
      setDefaultProfile(await bridge.defaultProfileStatus());
    } catch {
      // wave2 命令未接线时不显示默认配置信息，不影响主流程。
    }
  }, [bridge]);

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

  // 窗口级拖放：整个应用只此一处。
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
      if (event.name === AGENT_EVENTS.runtimeStateChanged) {
        refreshSnapshot();
      }
    });
  }, [bridge, refreshSnapshot]);

  useEffect(() => {
    refreshSnapshot();
  }, [refreshSnapshot]);

  useEffect(() => {
    let cancelled = false;
    void bridge.getChatHistory().then((history) => {
      if (!cancelled) dispatch({ type: "hydrate_history", history });
    });
    return () => {
      cancelled = true;
    };
  }, [bridge]);

  // 启动时确定是否要进首次引导。
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      await Promise.all([refreshKeyState(), refreshProfiles(), refreshDefaultProfile()]);
      try {
        const status = await bridge.onboardingStatus();
        if (cancelled) return;
        setShowOnboarding(!status.completed && (!status.hasKey || status.profileCount === 0));
      } catch {
        if (!cancelled) setShowOnboarding(false);
      } finally {
        if (!cancelled) setOnboardingLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [bridge, refreshKeyState, refreshProfiles, refreshDefaultProfile]);

  // 窗口宽度决定右栏是停靠还是浮层。
  useEffect(() => {
    const onResize = () => setNarrow(window.innerWidth < NARROW_WIDTH);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // 第一次成功连接后，界面不再出现任何引导。
  useEffect(() => {
    if (runtime.state !== "running" || hasEverConnected) return;
    setHasEverConnected(true);
    try {
      localStorage.setItem(EVER_CONNECTED_KEY, "1");
    } catch {
      // 存不了就只在本次会话里记住。
    }
  }, [runtime.state, hasEverConnected]);

  const completeOnboarding = async (skippedKey: boolean) => {
    try {
      await bridge.onboardingComplete(skippedKey);
    } catch {
      // 后端命令未就绪也允许继续用界面。
    }
    setShowOnboarding(false);
    setOnboardingLoaded(true);
    await Promise.all([refreshKeyState(), refreshProfiles(), refreshDefaultProfile()]);
  };

  const finishOnboarding = (skippedKey: boolean) => {
    void completeOnboarding(skippedKey);
  };

  const finishOnboardingWithImport = () => {
    setShowOnboarding(false);
    openSettings("network");
    void completeOnboarding(keyState.masked === null);
  };

  // 第一步：刷新默认包并直接连接；全部结束（成功或失败）后才进入主界面。
  const handleConnectTest = async () => {
    if (connectTestRef.current) return;
    connectTestRef.current = true;
    try {
      try {
        const next = await bridge.defaultProfileRefresh();
        setDefaultProfile(next);
      } catch (error) {
        setAppNotice({ level: "error", text: describeDefaultProfileError(error) });
      }
      await refreshProfiles();
      try {
        await bridge.onboardingComplete(keyState.masked === null);
      } catch {
        // 命令未就绪也允许继续。
      }
      await runRuntimeAction("start");
      await Promise.all([refreshKeyState(), refreshDefaultProfile()]);
      setShowOnboarding(false);
      setOnboardingLoaded(true);
    } finally {
      connectTestRef.current = false;
    }
  };

  const closeSettings = () => {
    setSettingsOpen(false);
    void Promise.all([refreshKeyState(), refreshProfiles()]);
  };

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

  const handleDeleteSession = async (
    sessionId: string,
  ): Promise<{ ok: boolean; message?: string }> => {
    const target = state.sessions.find((item) => item.id === sessionId);
    if (!target) {
      try {
        await bridge.deleteSession(sessionId);
      } catch {
        // NOT_FOUND 或命令未接入都不影响本地状态。
      }
      dispatch({ type: "session_removed", sessionId });
      return { ok: true };
    }

    if (!target.activeRequestId && target.requesting) {
      return { ok: false, message: "这条消息正在发出，请稍候再删除。" };
    }

    if (target.activeRequestId) {
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
    return { ok: true };
  };

  const handleSelectSession = (sessionId: string) => {
    dispatch({ type: "select_session", sessionId });
  };

  // 删除当前会话后会切到剩余的第一个：它可能还没拉过历史，这里统一补拉。
  useEffect(() => {
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
  }, [state, bridge]);

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
    if (!hasKey) {
      setAppNotice({ level: "error", text: "还没有配置 DeepSeek Key，先配置后再对话。" });
      openSettings("ai");
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

  const handleEmptySend = (text: string) => {
    let target = session;
    if (!target) {
      target = createSession();
      dispatch({ type: "add_session", session: target });
    }
    sendToSession(target.id, text);
  };

  const handleAskAi = (text: string) => {
    if (!hasKey) {
      setAppNotice({ level: "error", text: "还没有配置 DeepSeek Key，先配置后再对话。" });
      openSettings("ai");
      return;
    }
    const fresh = createSession();
    dispatch({ type: "add_session", session: fresh });
    sendToSession(fresh.id, text);
  };

  const handleStop = () => {
    const requestId = session?.activeRequestId ?? null;
    dispatch({ type: "cancel_request" });
    if (requestId) void bridge.cancel(requestId);
  };

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

  // 控制台/右栏的「使用测试节点」：刷新默认包后立即连接。
  // 离线时刷新会失败，但本地可能已有缓存包；不能因为刷新失败就放弃连接。
  const handleUseDefault = () => {
    if (defaultBusy) return;
    void (async () => {
      setDefaultBusy(true);
      try {
        const next = await bridge.defaultProfileRefresh();
        setDefaultProfile(next);
      } catch (error) {
        setAppNotice({ level: "error", text: describeDefaultProfileError(error) });
      } finally {
        setDefaultBusy(false);
      }
      await refreshProfiles();
      await runRuntimeAction("start");
    })();
  };

  // 恢复网络不依赖 AI：撤代理 → 停运行时 → 清明文配置。
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

  const handleAskAiDiagnosis = () => {
    handleEmptySend("诊断网络");
  };

  // 删除配置：后端拒绝删除当前激活/内置项，这里只做引导。
  const handleDeleteProfile = (profileId: string) => {
    const connectedToProfile =
      runtime.profile_id !== null && profileId === runtime.profile_id;
    const idleActive = runtime.state === "idle" && profileId === activeProfileId;
    if (connectedToProfile || idleActive) {
      setAppNotice({ level: "info", text: "这个配置仍在使用，先断开连接再删除。" });
      return;
    }
    void bridge.deleteProfile(profileId).then(
      () => {
        setAppNotice({ level: "info", text: "配置已删除。" });
        refreshSnapshot();
        void refreshProfiles();
      },
      (error: unknown) => {
        const bridgeError = toBridgeError(error);
        if (
          bridgeError.code === "PRECONDITION_FAILED" &&
          /ACTIVE_PROFILE_IN_USE/i.test(bridgeError.message)
        ) {
          setAppNotice({ level: "info", text: "这个配置仍在使用，先断开连接再删除。" });
          return;
        }
        setAppNotice({ level: "error", text: errorMessage(error) });
      },
    );
  };

  const link = toLinkState(runtime.state);
  const degraded = runtime.state === "degraded";
  const connected = runtime.state === "running" || runtime.state === "degraded";
  const stopping = runtime.state === "stopping";
  const tone = statusTone(link, degraded);
  const currentProfileId =
    runtime.profile_id ?? (connected ? null : activeProfileId);
  const topbarNode =
    runtime.profile_name ??
    profiles.find((profile) => profile.id === currentProfileId)?.name ??
    null;

  const showSetupHint =
    onboardingLoaded &&
    !showOnboarding &&
    !hasEverConnected &&
    !setupDismissed &&
    (!hasKey || (profilesLoaded && profiles.length === 0));

  const hasMessages = Boolean(session && session.messages.length > 0);
  const dockOpen = !narrow && panelPreferred;
  const overlayOpenNow = narrow && overlayOpen;
  const panelShown = dockOpen || overlayOpenNow;
  useFocusTrap(overlayOpenNow, overlayRef);

  // 跨 1100px 断点时复位浮层，避免宽度变化后面板突然重弹。
  useEffect(() => {
    setOverlayOpen(false);
  }, [narrow]);

  const quickAction = primaryAction({
    state: runtime.state,
    hasProfiles: profiles.length > 0,
    pending: runtimeAction,
    defaultBusy,
  });
  const runQuickAction = () => {
    if (quickAction.kind === "default") handleUseDefault();
    else if (quickAction.kind === "stop") handleDisconnect();
    else handleConnect();
  };
  const quickLabel = quickAction.kind === "default" ? "连接" : quickAction.label;

  useEffect(() => {
    if (!overlayOpenNow) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOverlayOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [overlayOpenNow]);

  const persistPanel = (open: boolean) => {
    setPanelPreferred(open);
    try {
      localStorage.setItem(PANEL_KEY, open ? "1" : "0");
    } catch {
      // 存不了就只在本次会话里记住。
    }
  };

  const openPanel = () => {
    if (narrow) setOverlayOpen(true);
    else persistPanel(true);
  };

  const closePanel = () => {
    if (narrow) setOverlayOpen(false);
    else persistPanel(false);
  };

  const togglePanel = () => {
    if (narrow) setOverlayOpen((open) => !open);
    else persistPanel(!panelPreferred);
  };

  const statusPanel = (compact: boolean) => (
    <StatusPanel
      status={runtime}
      profiles={profiles}
      activeProfileId={activeProfileId}
      pending={runtimeAction}
      showPrimary
      lightPrimary={!hasMessages}
      compact={compact}
      onCollapse={closePanel}
      onConnect={handleConnect}
      onDisconnect={handleDisconnect}
      onUseDefault={handleUseDefault}
      onSwitchProfile={handleSwitchProfile}
      onImport={() => openSettings("network")}
      onOpenLogs={handleOpenLogs}
      onOpenDiagnosis={() => setDiagnosisOpen(true)}
      onDeleteProfile={handleDeleteProfile}
    />
  );

  if (!onboardingLoaded) {
    return <div className="app-boot" aria-hidden />;
  }

  if (showOnboarding) {
    return (
      <Onboarding
        bridge={bridge}
        initialKey={keyState}
        onConnectTest={handleConnectTest}
        onImport={finishOnboardingWithImport}
        onDone={finishOnboarding}
      />
    );
  }

  return (
    <div className={`app ${dockOpen ? "app--panel-open" : ""}`}>
      <Sidebar
        sessions={state.sessions}
        activeSessionId={state.activeSessionId}
        onSelect={handleSelectSession}
        onNew={() => dispatch({ type: "new_session" })}
        onOpenSettings={() => openSettings("ai")}
        onRenameSession={handleRenameSession}
        onDeleteSession={handleDeleteSession}
      />

      <main className="main">
        <header className="topbar">
          <span className="topbar__title">{session?.title ?? "Veyl"}</span>
          <div className="topbar__right">
            <button
              type="button"
              className={`topbar__status ${toneClass(tone)}`}
              onClick={openPanel}
              title="连接状态"
            >
              <span className="topbar__status-dot" aria-hidden />
              <span className="topbar__status-text">
                {statusSentence(link, topbarNode, degraded, stopping)}
              </span>
            </button>
            {!panelShown && (hasMessages || hasEverConnected) ? (
              <button
                type="button"
                className="btn btn--ghost topbar__connect"
                onClick={runQuickAction}
                disabled={quickAction.disabled}
              >
                {quickLabel}
              </button>
            ) : null}
            <button
              type="button"
              className="topbar__panel-toggle"
              onClick={togglePanel}
              aria-label="状态面板"
              aria-expanded={narrow ? overlayOpen : dockOpen}
              title="状态面板"
            >
              ⧉
            </button>
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
                ? "还没有配置 DeepSeek Key；不配置也能连接。"
                : "还没有节点：导入配置文件或使用测试节点。"}
            </span>
            <button
              type="button"
              className="setup-bar__action"
              onClick={() => openSettings(hasKey ? "network" : "ai")}
            >
              {!hasKey ? "去配置" : "导入"}
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

        {hasMessages && session ? (
          <ChatView
            session={session}
            onSend={handleSend}
            onStop={handleStop}
            onNextAction={handleNextAction}
            hasKey={hasKey}
            onConfigureKey={() => openSettings("ai")}
          />
        ) : (
          <EmptyChat
            runtime={runtime}
            profiles={profiles}
            hasKey={hasKey}
            pending={runtimeAction}
            hasEverConnected={hasEverConnected}
            defaultBusy={defaultBusy}
            onConnect={handleConnect}
            onDisconnect={handleDisconnect}
            onUseDefault={handleUseDefault}
            onConfigureKey={() => openSettings("ai")}
            onSend={handleEmptySend}
          />
        )}
      </main>

      {dockOpen ? statusPanel(false) : null}

      {overlayOpenNow ? (
        <div
          className="panel-overlay"
          role="dialog"
          aria-modal="true"
          aria-label="连接状态"
          onMouseDown={() => setOverlayOpen(false)}
        >
          <div
            className="panel-overlay__inner"
            ref={overlayRef}
            onMouseDown={(event) => event.stopPropagation()}
          >
            {statusPanel(true)}
          </div>
        </div>
      ) : null}

      <DiagnosisSheet
        open={diagnosisOpen}
        runtime={runtime}
        profiles={profiles}
        activeProfileId={activeProfileId}
        hasKey={hasKey}
        pending={runtimeAction}
        defaultBusy={defaultBusy}
        repairing={repairing}
        onClose={() => setDiagnosisOpen(false)}
        onConnect={handleConnect}
        onSwitchProfile={handleSwitchProfile}
        onRefreshDefault={() => void handleRefreshDefault()}
        onRestoreNetwork={() => void handleRestoreNetwork()}
        onAskAi={handleAskAiDiagnosis}
      />

      <Settings
        open={settingsOpen}
        bridge={bridge}
        runtime={runtime}
        defaultProfile={defaultProfile}
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
        initialSection={settingsSection}
        onOpenLogs={handleOpenLogs}
        onOpenDiagnosis={() => {
          setSettingsOpen(false);
          setDiagnosisOpen(true);
        }}
        onRestoreNetwork={() => {
          setSettingsOpen(false);
          void handleRestoreNetwork();
        }}
        onAskAi={(text) => {
          setSettingsOpen(false);
          handleAskAi(text);
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
    return "还没有可用节点，请导入配置文件或使用测试节点。";
  }
  if (reason === "no_active_provider") {
    return "没有可用的 AI 服务，请到设置里选择一个。";
  }
  return bridgeError.message || "操作失败，请重试";
}

function describeDefaultProfileError(error: unknown): string {
  const bridgeError = toBridgeError(error);
  if (/not found|unknown command/i.test(bridgeError.message)) {
    return "默认配置命令还没有接入当前版本，可以先用「导入配置文件」导入本地节点。";
  }
  const offline = /network|offline|unreachable|timeout|dns|connect/i.test(bridgeError.message);
  if (offline || bridgeError.code === "TIMEOUT" || bridgeError.code === "UNSUPPORTED") {
    return "默认配置源暂时不可达（离线时属正常）。可以先用「导入配置文件」导入本地节点。";
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
