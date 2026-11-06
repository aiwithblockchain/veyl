import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import type { AgentEvent, NextAction, RuntimeView } from "./agent/protocol";
import { AGENT_EVENTS } from "./agent/protocol";
import { applyRuntimeEvent, emptyRuntimeView, getAgentBridge, keepLiveHealth, snapshotToView } from "./agent";
import { isTauri, readQuestionDetail } from "./agent/bridge";
import type {
  DefaultProfileStatus,
  ImportSeedResult,
  PendingQuestion,
} from "./agent/bridge";
import { BridgeError, toBridgeError } from "./agent/errors";
import { AiPanel, type RenameResult } from "./components/AiPanel";
import { AskQuestionDialog } from "./components/AskQuestionDialog";
import { AssistantOverlay } from "./components/AssistantOverlay";
import { AssistantTab } from "./components/AssistantTab";
import { ConfigRail } from "./components/ConfigRail";
import { Console } from "./components/Console";
import { ConnectionOverlay } from "./components/ConnectionOverlay";
import { IconClose } from "./components/icons";
import { NewConfigDialog } from "./components/NewConfigDialog";
import { Onboarding } from "./components/Onboarding";
import { PaneHandle } from "./components/PaneHandle";
import { Settings, describeImportError } from "./components/Settings";
import type { ConnectMode } from "./config/model";
import {
  FIRST_RUN_KICKOFF,
  isAiReady,
  shouldKickOffFirstRun,
  shouldOpenPanelForEmptyConfigs,
  shouldShowOnboarding,
} from "./config/onboarding";
import { useVpnSession } from "./config/useVpnSession";
import { useNodeProbes } from "./config/useNodeProbes";
import {
  assistantColumnWidth,
  shellLayout,
} from "./ui/breakpoints";
import { isDisconnectFailure } from "./ui/middleArea";
import { readPanelOpen, writePanelChoice } from "./ui/panelPreference";
import { ASSISTANT_MIN, RAIL_MIN } from "./ui/layout";
import { usePaneLayout } from "./ui/usePaneLayout";
import { pushRateSample, shouldPushRateSample, type RateSample } from "./ui/rateSeries";
import {
  isZeroConfigAskSuppressed,
  lastAssistantTextOf,
  shouldResetJustOnboarded,
  shouldSendZeroConfigAsk,
  shouldSettleZeroConfig,
} from "./ui/consoleActions";
import { activeSession, chatReducer, createInitialState, createSession, nextId } from "./state/chatStore";
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

type SettingsSection = "ai" | "network" | "advanced" | "about";

const EVER_CONNECTED_KEY = "veyl.hasEverConnected";
const PANEL_CLOSED_BY_USER_KEY = "veyl.ui.panelClosedByUser";
const PANEL_AUTO_OPENED_KEY = "veyl.ui.panelAutoOpened";
const ONBOARDING_SKIPPED_KEY = "veyl.onboarding.skipped";

function readFlag(key: string): boolean {
  try {
    return localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

function writeFlag(key: string): void {
  try {
    localStorage.setItem(key, "1");
  } catch {
    // 存不了就只在本次会话里记住。
  }
}

function readEverConnected(): boolean {
  try {
    return localStorage.getItem(EVER_CONNECTED_KEY) === "1" ||
      localStorage.getItem("veyl.hasConnected") === "1";
  } catch {
    return false;
  }
}

/** 用户手动开/关过就沿用；从没选过、或来自旧版本时宽屏展开、窄屏收成 tab。 */
function readInitialPanelOpen(): boolean {
  return readPanelOpen(localStorage, typeof window === "undefined" ? 1440 : window.innerWidth);
}

export default function App() {
  const bridge = useMemo(() => getAgentBridge(), []);
  const [state, dispatch] = useReducer(chatReducer, undefined, createInitialState);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState<SettingsSection>("ai");
  const [runtime, setRuntime] = useState<RuntimeView>(() => emptyRuntimeView());
  // 失败快照里 connected_since 已被后端清空，只能记住这次失败是不是从已连接态掉下来的。
  // 每次状态迁移都整体覆盖，非失败迁移自然复位。
  const [failedAfterConnected, setFailedAfterConnected] = useState(false);
  const [appNotice, setAppNotice] = useState<AppNotice | null>(null);
  const [dragging, setDragging] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<ImportSeedResult | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [aiReady, setAiReady] = useState(false);
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [onboardingLoaded, setOnboardingLoaded] = useState(false);
  const [historyReady, setHistoryReady] = useState(false);
  const [hasEverConnected, setHasEverConnected] = useState(readEverConnected);
  const [panelOpen, setPanelOpen] = useState(readInitialPanelOpen);
  const [viewportWidth, setViewportWidth] = useState(() =>
    typeof window === "undefined" ? 1440 : window.innerWidth,
  );
  const [rateSamples, setRateSamples] = useState<RateSample[]>([]);
  const [aiUnread, setAiUnread] = useState(false);
  const [defaultProfile, setDefaultProfile] = useState<DefaultProfileStatus | null>(null);
  const [repairing, setRepairing] = useState(false);
  const [pendingQuestions, setPendingQuestions] = useState<PendingQuestion[]>([]);
  const [pendingConfigId, setPendingConfigId] = useState<string | null>(null);
  const [newConfigOpen, setNewConfigOpen] = useState(false);
  const [nodeSheetSignal, setNodeSheetSignal] = useState(0);
  const [composerFocusSignal, setComposerFocusSignal] = useState(0);
  const [justOnboarded, setJustOnboarded] = useState(false);
  const vpn = useVpnSession(
    bridge,
    import.meta.env.VITE_MOCK === "1" || bridge.mode === "mock",
  );
  const nodeProbes = useNodeProbes({ bridge });
  // 断点只看窗口宽度：三栏宽度、助手停靠/浮层都由它决定。
  const dockedRef = useRef(true);
  useEffect(() => {
    const onResize = () => {
      const width = window.innerWidth;
      setViewportWidth(width);
      // 从停靠断点拖到窄屏时收回 tab，不让浮层突然盖住控制台；这次收起不算用户选择。
      if (dockedRef.current && !shellLayout(width).docked) {
        setPanelOpen(false);
        panelOpenRef.current = false;
      }
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  const importingRef = useRef(false);
  const endWaiters = useRef(new Map<string, () => void>());
  // 已经回答/超时/作废的问题 id：防止重连或重试路径把旧问题再插回来。
  const settledQuestionIds = useRef(new Set<string>());
  const panelOpenRef = useRef(panelOpen);
  const assistantTabRef = useRef<HTMLButtonElement>(null);
  // 用户主动关闭（Esc / 点遮罩 / 点收起）后把焦点还给 tab；自动收起不抢焦点。
  const returnFocusToTabRef = useRef(false);
  const panelClosedThisRunRef = useRef(false);
  const panelClosedByUserRef = useRef(readFlag(PANEL_CLOSED_BY_USER_KEY));
  const panelAutoOpenedRef = useRef(readFlag(PANEL_AUTO_OPENED_KEY));
  const aiConfiguredRef = useRef(false);
  const onboardingSkippedRef = useRef(readFlag(ONBOARDING_SKIPPED_KEY));
  const kickoffStartedRef = useRef(false);
  const kickoffSessionCreatedRef = useRef(false);
  const zeroConfigAskedRef = useRef(false);
  const askedMessageCountRef = useRef(0);
  const confirmConfigRef = useRef<HTMLDivElement>(null);
  useFocusTrap(Boolean(pendingConfigId), confirmConfigRef);

  const markQuestionSettled = (questionId: string) => {
    const settled = settledQuestionIds.current;
    settled.add(questionId);
    if (settled.size > 200) {
      const oldest = settled.values().next().value;
      if (oldest) settled.delete(oldest);
    }
  };
  // 健康事件的版本号：防止发出去要的旧快照把刚收到的 exit_ip 覆盖回 null。
  const healthVersion = useRef(0);
  // 同一个 traffic 会被健康事件重复推送（出口探测、节点延迟都会触发 emit_health）；
  // 只按 sampled_at 推进时的第一条算一个速率样本。
  const lastSampleAtRef = useRef<string | null>(null);
  // 快照请求的单调序号：只接受最新一次请求，避免旧快照晚到覆盖新状态。
  const snapshotSeq = useRef(0);

  const session = activeSession(state);

  const openSettings = (section: SettingsSection = "ai") => {
    setSettingsSection(section);
    setSettingsOpen(true);
  };

  const refreshSnapshot = useCallback(() => {
    const requestId = ++snapshotSeq.current;
    const versionAtRequest = healthVersion.current;
    void bridge.getRuntimeSnapshot().then((snapshot) => {
      if (!snapshot || requestId !== snapshotSeq.current) return;
      const base = snapshotToView(snapshot);
      setRuntime((current) =>
        versionAtRequest === healthVersion.current
          ? base
          : keepLiveHealth(base, current),
      );
    });
  }, [bridge]);

  const refreshDefaultProfile = useCallback(async () => {
    try {
      setDefaultProfile(await bridge.defaultProfileStatus());
    } catch {
      // wave2 命令未接线时不显示默认配置信息，不影响主流程。
    }
  }, [bridge]);

  // 右栏第一次配置 AI 成功后自动展开一次；用户手动关过就不再自动开。
  const maybeAutoOpenPanel = useCallback(() => {
    if (panelClosedByUserRef.current || panelAutoOpenedRef.current) return;
    panelAutoOpenedRef.current = true;
    writeFlag(PANEL_AUTO_OPENED_KEY);
    panelOpenRef.current = true;
    setPanelOpen(true);
    setAiUnread(false);
  }, []);

  const refreshAiStatus = useCallback(
    async (initial = false) => {
      const [key, providers] = await Promise.all([
        bridge.getDeepSeekKey().catch(() => null),
        bridge.llmProviderList().catch(() => null),
      ]);
      const ready = isAiReady({ key, providers });
      const wasReady = aiConfiguredRef.current;
      aiConfiguredRef.current = ready;
      setAiReady(ready);
      if (!initial && !wasReady && ready) maybeAutoOpenPanel();
      return {
        ready,
        showOnboarding: shouldShowOnboarding({
          key,
          providers,
          skipped: onboardingSkippedRef.current,
        }),
      };
    },
    [bridge, maybeAutoOpenPanel],
  );

  useEffect(() => {
    panelOpenRef.current = panelOpen;
  }, [panelOpen]);

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
      if (event.name === AGENT_EVENTS.runtimeHealthChanged) {
        healthVersion.current += 1;
        const traffic = event.payload.traffic;
        const sampledAt = traffic?.sampled_at ?? "";
        if (
          traffic &&
          shouldPushRateSample(lastSampleAtRef.current, sampledAt)
        ) {
          lastSampleAtRef.current = sampledAt;
          setRateSamples((samples) =>
            pushRateSample(samples, { up: traffic.up_rate, down: traffic.down_rate }),
          );
        }
      }
      setRuntime((view) => applyRuntimeEvent(view, event));
      if (
        (AI_EVENTS.has(event.name) || event.name === AGENT_EVENTS.askUserQuestion) &&
        !panelOpenRef.current
      ) {
        setAiUnread(true);
      }
      if (AI_EVENTS.has(event.name)) {
        dispatch({ type: "agent_event", event });
      }
      if (event.name === AGENT_EVENTS.askUserQuestion) {
        const payload = event.payload;
        if (settledQuestionIds.current.has(payload.question_id)) return;
        const detail = readQuestionDetail(payload as unknown as Record<string, unknown>);
        setPendingQuestions((current) => [
          ...current.filter((item) => item.questionId !== payload.question_id),
          {
            questionId: payload.question_id,
            sessionId: payload.session_id,
            requestId: payload.request_id,
            question: payload.question,
            options: payload.options ?? [],
            createdAt: payload.created_at,
            expiresAt: payload.expires_at,
            kind: detail.kind,
            upgradeConfirm: detail.upgradeConfirm,
          },
        ]);
      }
      if (event.name === AGENT_EVENTS.requestEnd) {
        const requestId = event.payload.request_id;
        setPendingQuestions((current) => {
          for (const item of current) {
            if (item.requestId === requestId) markQuestionSettled(item.questionId);
          }
          return current.filter((item) => item.requestId !== requestId);
        });
        const finish = endWaiters.current.get(requestId);
        if (finish) {
          endWaiters.current.delete(requestId);
          finish();
        }
      }
      if (event.name === AGENT_EVENTS.runtimeStateChanged) {
        setFailedAfterConnected(
          isDisconnectFailure(event.payload.from, event.payload.to),
        );
        const online =
          event.payload.to === "running" || event.payload.to === "degraded";
        if (!online) {
          lastSampleAtRef.current = null;
          setRateSamples([]);
        }
        refreshSnapshot();
      }
    });
  }, [bridge, refreshSnapshot]);

  useEffect(() => {
    refreshSnapshot();
  }, [refreshSnapshot]);

  useEffect(() => {
    let cancelled = false;
    void bridge
      .getChatHistory()
      .then((history) => {
        if (!cancelled) dispatch({ type: "hydrate_history", history });
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setHistoryReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, [bridge]);

  // 启动时确定是否要进首次引导：没有任何可用 AI 才显示。
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      await refreshDefaultProfile();
      const decision = await refreshAiStatus(true);
      if (cancelled) return;
      setShowOnboarding(decision.showOnboarding);
      setOnboardingLoaded(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [refreshDefaultProfile, refreshAiStatus]);

  // 切换 / 恢复会话时，把该会话未回答的问题拉回来。
  useEffect(() => {
    const sessionId = session?.id;
    if (!sessionId) return;
    let cancelled = false;
    void bridge
      .listPendingQuestions(sessionId)
      .then((items) => {
        if (cancelled) return;
        setPendingQuestions((current) => {
          const byId = new Map(current.map((item) => [item.questionId, item]));
          for (const item of items) {
            if (!settledQuestionIds.current.has(item.questionId)) {
              byId.set(item.questionId, item);
            }
          }
          return [...byId.values()];
        });
      })
      .catch(() => {
        // 命令未接线或网络问题：保持现有列表。
      });
    return () => {
      cancelled = true;
    };
  }, [bridge, session?.id]);

  // 第一次成功连接后，界面不再出现任何引导。
  const connectedOnce = runtime.state === "running" || vpn.connection === "connected";
  useEffect(() => {
    if (!connectedOnce || hasEverConnected) return;
    setHasEverConnected(true);
    try {
      localStorage.setItem(EVER_CONNECTED_KEY, "1");
    } catch {
      // 存不了就只在本次会话里记住。
    }
  }, [connectedOnce, hasEverConnected]);

  useEffect(() => {
    if (vpn.error) setAppNotice({ level: "error", text: vpn.error });
  }, [vpn.error]);

  // 本次运行内建出过配置后，A 的「刚引导完」文案就不再适用。
  useEffect(() => {
    if (!shouldResetJustOnboarded(justOnboarded, vpn.configs.length)) return;
    setJustOnboarded(false);
  }, [justOnboarded, vpn.configs.length]);

  // 零配置时右栏必须可见；kickoff 只管「AI 开不开口」，不管「用户看不看得到」。
  useEffect(() => {
    if (!onboardingLoaded || showOnboarding) return;
    if (
      !shouldOpenPanelForEmptyConfigs({
        aiReady,
        loading: vpn.loading,
        configCount: vpn.configs.length,
        closedThisRun: panelClosedThisRunRef.current,
      })
    ) {
      return;
    }
    panelOpenRef.current = true;
    setPanelOpen(true);
    setAiUnread(false);
  }, [onboardingLoaded, showOnboarding, aiReady, vpn.loading, vpn.configs.length]);

  // 首启自动发起第一轮；hidden 消息不显示成用户气泡，会话里只出现 AI 的回复。
  useEffect(() => {
    if (!onboardingLoaded || showOnboarding || !aiReady) return;
    if (!historyReady) return;
    if (vpn.loading || vpn.configs.length > 0) return;

    if (!session) {
      if (kickoffSessionCreatedRef.current) return;
      kickoffSessionCreatedRef.current = true;
      dispatch({ type: "add_session", session: createSession() });
      return;
    }

    if (!session.historyLoaded) return;
    if (kickoffStartedRef.current) return;
    if (
      !shouldKickOffFirstRun({
        aiReady,
        historyReady,
        sessionHistoryLoaded: session.historyLoaded,
        configCount: vpn.configs.length,
        messageCount: session.messages.length,
      })
    ) {
      return;
    }

    kickoffStartedRef.current = true;
    // 先标记 requestId 未知的 pending，删除保护与历史覆盖判断才会认为「有请求在跑」。
    dispatch({ type: "request_pending", sessionId: session.id });
    void bridge
      .sendMessage(session.id, FIRST_RUN_KICKOFF, { hidden: true })
      .then(({ requestId }) =>
        dispatch({ type: "request_started", sessionId: session.id, requestId }),
      )
      .catch((error: unknown) => {
        const message =
          toBridgeError(error).message || "AI 没能开始第一轮对话，请稍后重试。";
        dispatch({ type: "request_failed", sessionId: session.id, message });
        setAppNotice({ level: "error", text: message });
      });
  }, [
    onboardingLoaded,
    showOnboarding,
    aiReady,
    historyReady,
    vpn.loading,
    vpn.configs.length,
    session,
    bridge,
  ]);

  useEffect(() => {
    if (!pendingConfigId) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPendingConfigId(null);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [pendingConfigId]);

  const completeOnboarding = async () => {
    setShowOnboarding(false);
    setOnboardingLoaded(true);
    await Promise.all([refreshDefaultProfile(), refreshAiStatus()]);
  };

  const finishOnboarding = (skipped: boolean) => {
    // 只在本次运行内有效：刷新后回到「已配 AI、但不是刚引导完」的入口。
    setJustOnboarded(!skipped);
    if (skipped) {
      onboardingSkippedRef.current = true;
      writeFlag(ONBOARDING_SKIPPED_KEY);
    } else {
      // 首启成功无条件打开右栏，不受「只自动开一次」或「用户关过」影响。
      panelOpenRef.current = true;
      setPanelOpen(true);
      setAiUnread(false);
    }
    void completeOnboarding();
  };

  const closeSettings = () => {
    setSettingsOpen(false);
    void refreshAiStatus();
  };

  const togglePanel = () => {
    const next = !panelOpen;
    setPanelOpen(next);
    panelOpenRef.current = next;
    writePanelChoice(localStorage, next);
    if (!next) returnFocusToTabRef.current = true;
    if (next) {
      setAiUnread(false);
    } else {
      panelClosedThisRunRef.current = true;
      panelClosedByUserRef.current = true;
      writeFlag(PANEL_CLOSED_BY_USER_KEY);
    }
  };

  // tab 和浮层是互斥渲染：关闭后 tab 在本次 commit 才挂载，所以在这里补焦点。
  useEffect(() => {
    if (!returnFocusToTabRef.current) return;
    returnFocusToTabRef.current = false;
    assistantTabRef.current?.focus();
  });

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
      setPendingQuestions((current) =>
        current.filter((item) => item.sessionId !== sessionId),
      );
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
        setPendingQuestions((current) =>
          current.filter((item) => item.sessionId !== sessionId),
        );
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
    setPendingQuestions((current) =>
      current.filter((item) => item.sessionId !== sessionId),
    );
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
    if (!aiReady) {
      setAppNotice({ level: "error", text: "还没有配置 AI，先配置后再对话。" });
      openSettings("ai");
      return;
    }
    const localRequestId = nextId("local");
    dispatch({ type: "send_user_message", sessionId, text, localRequestId });

    void bridge
      .sendMessage(sessionId, text)
      .then(({ requestId }) =>
        dispatch({ type: "request_started", sessionId, requestId }),
      )
      .catch((error: unknown) => {
        dispatch({
          type: "request_failed",
          sessionId,
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
    if (!aiReady) {
      setAppNotice({ level: "error", text: "还没有配置 AI，先配置后再对话。" });
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

  const currentQuestion = session
    ? pendingQuestions.find((item) => item.sessionId === session.id) ?? null
    : null;

  const handleQuestionExpired = () => {
    if (!currentQuestion) return;
    const { sessionId, questionId } = currentQuestion;
    markQuestionSettled(questionId);
    setPendingQuestions((current) =>
      current.filter((item) => item.questionId !== questionId),
    );
    // 前端墙钟可能先于后端单调计时到期：回空串把后端也解开。
    // 正常情况后端已超时，会返回 NOT_FOUND，静默忽略。
    void bridge.replyUserQuestion(sessionId, questionId, "").catch(() => undefined);
  };

  const handleAnswerQuestion = async (answer: string) => {
    if (!currentQuestion) return;
    const { sessionId, questionId } = currentQuestion;
    try {
      await bridge.replyUserQuestion(sessionId, questionId, answer);
      markQuestionSettled(questionId);
      setPendingQuestions((current) =>
        current.filter((item) => item.questionId !== questionId),
      );
    } catch (error) {
      if (toBridgeError(error).code === "NOT_FOUND") {
        // 已经回答或随请求作废：本地关掉浮层即可，不弹错误。
        markQuestionSettled(questionId);
        setPendingQuestions((current) =>
          current.filter((item) => item.questionId !== questionId),
        );
        return;
      }
      throw error;
    }
  };

  const showActionResult = (
    result: { ok: boolean; message?: string },
    fallback: string,
  ) => {
    if (!result.ok) {
      setAppNotice({ level: "error", text: result.message ?? fallback });
    } else if (result.message) {
      setAppNotice({ level: "info", text: result.message });
    }
  };

  const handleCreateConfig = (name: string, mode: ConnectMode) => {
    void vpn.createConfig(name, mode).then((result) => {
      if (!result.ok) {
        setAppNotice({ level: "error", text: result.message ?? "创建配置失败" });
        return;
      }
      if (!result.activated) {
        setAppNotice({ level: "info", text: "已创建，从左侧切换过去。" });
      }
    });
  };

  // 已连接时换配置：先说清会断一次，确认后再切并重新连上。
  const handleSelectConfig = (configId: string) => {
    if (configId === vpn.activeConfigId) return;
    if (vpn.connection === "connected" || vpn.connection === "starting") {
      setPendingConfigId(configId);
      return;
    }
    void vpn
      .selectConfig(configId)
      .then((result) => showActionResult(result, "切换配置失败"));
  };

  const confirmConfigSwitch = () => {
    if (!pendingConfigId) return;
    const configId = pendingConfigId;
    setPendingConfigId(null);
    void vpn
      .selectConfig(configId, true)
      .then((result) => showActionResult(result, "切换配置失败"));
  };

  const handleVpnStart = () => {
    void vpn.start().then((result) => showActionResult(result, "启动失败"));
  };

  const handleVpnStop = () => {
    void vpn.stop().then((result) => showActionResult(result, "断开失败"));
  };

  // 用户主动点「让 AI 帮我配」：打开右栏、给焦点；会话空闲时直接发一条可见的用户消息。
  const handleAskAiFromConsole = () => {
    // 用户已经显式点名要 AI 配，自动 kickoff 不再另外发一条。
    kickoffStartedRef.current = true;
    kickoffSessionCreatedRef.current = true;
    panelOpenRef.current = true;
    setPanelOpen(true);
    setAiUnread(false);
    setComposerFocusSignal((value) => value + 1);

    const hasPendingQuestion = session
      ? pendingQuestions.some((item) => item.sessionId === session.id)
      : false;
    const messageCount = session?.messages.length ?? 0;
    const shouldSend = shouldSendZeroConfigAsk({
      requesting: session?.requesting ?? false,
      hasActiveRequest: Boolean(session?.activeRequestId),
      hasPendingQuestion,
      alreadyAsked: isZeroConfigAskSuppressed({
        asked: zeroConfigAskedRef.current,
        askedAtCount: askedMessageCountRef.current,
        messageCount,
      }),
    });
    if (shouldSend) {
      zeroConfigAskedRef.current = true;
      askedMessageCountRef.current = messageCount;
      handleEmptySend("帮我配一下网络");
    }
  };

  const handleSwitchNode = (nodeId: string) => vpn.switchNode(nodeId);

  const pendingConfig =
    vpn.configs.find((config) => config.config_id === pendingConfigId) ?? null;

  const zeroConfigSettled = shouldSettleZeroConfig({
    requesting: session?.requesting ?? false,
    hasActiveRequest: Boolean(session?.activeRequestId),
    hasPendingQuestion: session
      ? pendingQuestions.some((item) => item.sessionId === session.id)
      : false,
    messageCount: session?.messages.length ?? 0,
    lastAssistantText: lastAssistantTextOf(session?.messages ?? []),
  });

  const shell = shellLayout(viewportWidth);
  dockedRef.current = shell.docked;
  const panes = usePaneLayout({
    windowWidth: viewportWidth,
    mode: shell.mode,
    docked: shell.docked,
    panelOpen,
  });

  const appStyle = {
    "--rail-w": `${panes.rail}px`,
    "--assistant-w": `${assistantColumnWidth(
      { ...shell, assistant: panes.assistant },
      panelOpen,
    )}px`,
  } as CSSProperties;

  const aiPanel = (
    <AiPanel
      session={session ?? null}
      sessions={state.sessions}
      activeSessionId={state.activeSessionId}
      aiReady={aiReady}
      hasEverConnected={hasEverConnected}
      hasConfigs={vpn.configs.length > 0}
      focusSignal={composerFocusSignal}
      onSelectSession={handleSelectSession}
      onNewSession={() => dispatch({ type: "new_session" })}
      onRenameSession={handleRenameSession}
      onDeleteSession={handleDeleteSession}
      onSend={handleSend}
      onEmptySend={handleEmptySend}
      onStop={handleStop}
      onNextAction={handleNextAction}
      onOpenSettings={() => openSettings("ai")}
      onConfigureKey={() => openSettings("ai")}
      onCollapse={togglePanel}
    />
  );

  if (!onboardingLoaded) {
    return <div className="app-boot" aria-hidden />;
  }

  if (showOnboarding) {
    return (
      <Onboarding bridge={bridge} onDone={finishOnboarding} />
    );
  }

  return (
    <div style={appStyle} className="app">
      <ConfigRail
        configs={vpn.configs}
        activeConfigId={vpn.activeConfigId}
        connectedConfigId={vpn.connectedConfigId}
        loading={vpn.loading}
        error={vpn.error}
        onSelect={handleSelectConfig}
        onNewConfig={() => setNewConfigOpen(true)}
        onDelete={vpn.deleteConfig}
        onOpenSettings={() => openSettings()}
        compact={shell.mode === "drawer"}
      />
      {panes.canDragRail ? (
        <PaneHandle
          side="rail"
          label="调整配置列表宽度"
          controls="config-rail"
          value={panes.rail}
          min={RAIL_MIN}
          max={panes.railMax}
          dragging={panes.draggingPane === "rail"}
          {...panes.railHandlers}
        />
      ) : null}
      <Console
        config={vpn.activeConfig}
        onStart={handleVpnStart}
        onStop={handleVpnStop}
        onSwitchNode={handleSwitchNode}
        onProbe={vpn.probe}
        nodeProbes={nodeProbes}
        onOpenDiagnostics={() => openSettings("advanced")}
        nodeProbeAvailable={vpn.nodeProbeAvailable}
        aiReady={aiReady}
        justOnboarded={justOnboarded}
        zeroConfigSettled={zeroConfigSettled}
        hasConfigs={vpn.configs.length > 0}
        onAskAi={handleAskAiFromConsole}
        onNewConfig={() => setNewConfigOpen(true)}
        onImportNodes={() => openSettings("network")}
        seedUpdate={Boolean(defaultProfile?.newVersionAvailable)}
        openNodeSheetSignal={nodeSheetSignal}
        loading={vpn.loading}
        runtime={runtime}
        failedAfterConnected={failedAfterConnected}
        helperPreparing={vpn.preparingHelper}
        rateSamples={rateSamples}
      />
      {panelOpen && shell.docked ? (
        <div className="assistant-slot">{aiPanel}</div>
      ) : panelOpen ? (
        <AssistantOverlay onClose={togglePanel}>{aiPanel}</AssistantOverlay>
      ) : (
        <AssistantTab
          unread={aiUnread}
          onOpen={togglePanel}
          openButtonRef={assistantTabRef}
        />
      )}
      {panes.canDragPanel ? (
        <PaneHandle
          side="assistant"
          label="调整 AI 对话宽度"
          controls="ai-panel"
          value={panes.assistant}
          min={ASSISTANT_MIN}
          max={panes.assistantMax}
          dragging={panes.draggingPane === "assistant"}
          {...panes.assistantHandlers}
        />
      ) : null}

      {appNotice ? (
        <div className={`app-toast app-toast--${appNotice.level}`} role="status">
          <span className="app-toast__text">{appNotice.text}</span>
          <button
            type="button"
            className="app-toast__close"
            aria-label="关闭提示"
            onClick={() => setAppNotice(null)}
          >
            ×
          </button>
        </div>
      ) : null}

      {pendingConfig ? (
        <div className="modal-backdrop" onMouseDown={() => setPendingConfigId(null)}>
          <div
            ref={confirmConfigRef}
            className="modal modal--confirm"
            role="dialog"
            aria-modal="true"
            aria-labelledby="switch-config-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <header className="modal__head">
              <h2 id="switch-config-title" className="modal__title">
                切换配置
              </h2>
              <button
                type="button"
                className="modal__close"
                onClick={() => setPendingConfigId(null)}
                aria-label="关闭"
              >
                <IconClose size={14} />
              </button>
            </header>
            <p className="confirm__text">
              切到「{pendingConfig.name}」会先断开当前连接，再按新配置重新连上。
            </p>
            <div className="confirm__actions">
              <button
                type="button"
                className="btn btn--ghost"
                onClick={() => setPendingConfigId(null)}
              >
                取消
              </button>
              <button type="button" className="btn btn--primary" onClick={confirmConfigSwitch}>
                切换
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {newConfigOpen ? (
        <NewConfigDialog
          configs={vpn.configs}
          onClose={() => setNewConfigOpen(false)}
          onCreate={(name, mode) => {
            handleCreateConfig(name, mode);
            setNewConfigOpen(false);
          }}
        />
      ) : null}

      <AskQuestionDialog
        question={currentQuestion}
        onAnswer={handleAnswerQuestion}
        onExpire={handleQuestionExpired}
        connected={runtime.state === "running" || runtime.state === "degraded"}
      />

      <Settings
        open={settingsOpen}
        bridge={bridge}
        runtime={runtime}
        defaultProfile={defaultProfile}
        connectMode={vpn.activeConfig?.connect_mode ?? null}
        currentNodeName={
          vpn.activeConfig?.nodes.find(
            (node) => node.node_id === vpn.activeConfig?.current_node_id,
          )?.name ?? null
        }
        nodeCount={vpn.activeConfig?.nodes.length ?? 0}
        onOpenNodePanel={() => {
          setSettingsOpen(false);
          setNodeSheetSignal((current) => current + 1);
        }}
        onNewConfig={() => {
          setSettingsOpen(false);
          setNewConfigOpen(true);
        }}
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
        onRestoreNetwork={() => {
          setSettingsOpen(false);
          void handleRestoreNetwork();
        }}
        onAskAi={(text) => {
          setSettingsOpen(false);
          handleAskAi(text);
        }}
      />

      <ConnectionOverlay
        connection={vpn.connection}
        preparingHelper={vpn.preparingHelper}
        runtime={runtime}
        connectMode={vpn.activeConfig?.connect_mode ?? null}
      />
    </div>
  );
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
