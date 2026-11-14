import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import type {
  AgentEvent,
  ConfigConnectMode,
  ConfigRouteMode,
  NextAction,
  RuntimeView,
} from "./agent/protocol";
import { AGENT_EVENTS } from "./agent/protocol";
import { applyRuntimeEvent, emptyRuntimeView, getAgentBridge, keepLiveHealth, snapshotToView } from "./agent";
import { DEFAULT_PROXY_PORT, isTauri, readQuestionDetail, shouldRefreshSnapshotOnHealth, viewAfterConnected, viewAfterStopped } from "./agent/bridge";
import type {
  ConfigCreateInput,
  DefaultProfileStatus,
  MyServer,
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
import { HelperPermissionDialog } from "./components/HelperPermissionDialog";
import { NewConfigDialog } from "./components/NewConfigDialog";
import { MyServersPage } from "./components/MyServersPage";
import { MyServersRail } from "./components/MyServersRail";
import { NodeGroupDetail } from "./components/NodeGroupDetail";
import { NodeGroupsRail } from "./components/NodeGroupsRail";
import { useMyServers } from "./myservers/useMyServers";
import { useNodeGroups } from "./groups/useNodeGroups";
import { isProvisioning } from "./myservers/labels";
import { Onboarding } from "./components/Onboarding";
import { PaneHandle } from "./components/PaneHandle";
import { Settings, describeImportError } from "./components/Settings";
import type { DisplayActionOutcome } from "./components/ToolCallCard";
import type { ToolDisplayAction } from "./components/toolDisplay";
import {
  FIRST_RUN_KICKOFF,
  isAiReady,
  shouldKickOffFirstRun,
  shouldOpenPanelForEmptyConfigs,
  shouldShowOnboarding,
} from "./config/onboarding";
import { useVpnSession, isHelperPermissionReason } from "./config/useVpnSession";
import { createRuntimeAuthority } from "./config/runtimeAuthority";
import { useNodeProbes } from "./config/useNodeProbes";
import {
  assistantColumnWidth,
  shellLayout,
} from "./ui/breakpoints";
import { isDisconnectFailure } from "./ui/middleArea";
import { ISSUE_REPORT_OPENING } from "./ui/issueReport";
import { readPanelOpen, writePanelChoice } from "./ui/panelPreference";
import { ASSISTANT_MIN, RAIL_MIN } from "./ui/layout";
import { readDestination, writeDestination, type Destination } from "./ui/destination";
import { IconConsole, IconGroups, IconServer } from "./components/icons";
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
/** 新建配置走 AI 协助时的开场消息：必须是用户可见的一条。 */
const NEW_CONFIG_AI_ASK = "帮我新建一套配置。";

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
  // 连接失败但原因只是「系统还没允许后台助手」：弹引导，不用 toast。
  const [helperGuideOpen, setHelperGuideOpen] = useState(false);
  // 成功类提示 4 秒自动消失；错误提示留到用户手动关闭。
  useEffect(() => {
    if (!appNotice || appNotice.level !== "info") return;
    const timer = window.setTimeout(() => setAppNotice(null), 4000);
    return () => window.clearTimeout(timer);
  }, [appNotice]);
  const [aiReady, setAiReady] = useState(false);
  // 当前服务商的显示名；未配置或读取失败时为空，由助手头部决定回退文案。
  const [aiProviderName, setAiProviderName] = useState<string | null>(null);
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [onboardingLoaded, setOnboardingLoaded] = useState(false);
  const [historyReady, setHistoryReady] = useState(false);
  const [hasEverConnected, setHasEverConnected] = useState(readEverConnected);
  const [panelOpen, setPanelOpen] = useState(readInitialPanelOpen);
  // destination 决定左栏与中间区：客户端是配置列表 + 控制台，服务器是服务器列表 + 选中那台。
  const [destination, setDestination] = useState<Destination>(() =>
    readDestination(localStorage),
  );
  const changeDestination = (next: Destination) => {
    setDestination(next);
    writeDestination(localStorage, next);
  };
  // 再点一次已激活的「节点组」图标：递增让节点组回到根（组列表 → 当前组详情）。
  const [groupsRootSignal, setGroupsRootSignal] = useState(0);
  // 再点一次已激活的「我的服务器」图标：回到列表根（默认第一台）。
  const [serversRootSignal, setServersRootSignal] = useState(0);
  const groupsApi = useNodeGroups();
  const myServers = useMyServers(bridge, {
    active: destination === "servers",
    rootSignal: serversRootSignal,
  });
  /** 从组详情「从我的服务器添加」进来时的目标组。 */
  const [serverJoinTarget, setServerJoinTarget] = useState<{
    groupId: string;
    name: string;
  } | null>(null);
  /** 从新建流程切到服务器时保留接管方式；回客户端时恢复新建流程。 */
  const [serverEntry, setServerEntry] = useState<{
    connectMode: ConfigConnectMode;
  } | null>(null);
  /** 从服务器「用来建配置」带回来的节点；dialog 挂在 review。 */
  const [ownedNodes, setOwnedNodes] = useState<{
    nodeIds: string[];
    label: string;
  } | null>(null);
  /** 正在为问题报告开会话并发送开场：期间禁用三处入口。 */
  const [reportOpening, setReportOpening] = useState(false);
  const reportOpeningRef = useRef(false);
  // 新建配置成功后要自动连接：等 activeConfig 刷新到新配置再启动。
  const connectAfterCreateRef = useRef(false);
  const [viewportWidth, setViewportWidth] = useState(() =>
    typeof window === "undefined" ? 1440 : window.innerWidth,
  );
  const [rateSamples, setRateSamples] = useState<RateSample[]>([]);
  const [aiUnread, setAiUnread] = useState(false);
  const [defaultProfile, setDefaultProfile] = useState<DefaultProfileStatus | null>(null);
  // 本地代理端口是应用级设置：设置页写，控制台与设置行都读这一份。
  const [proxyPort, setProxyPort] = useState(DEFAULT_PROXY_PORT);
  const [repairing, setRepairing] = useState(false);
  const [pendingQuestions, setPendingQuestions] = useState<PendingQuestion[]>([]);
  const [newConfigOpen, setNewConfigOpen] = useState(false);
  const [systemRegion, setSystemRegion] = useState<string | null>(null);
  /** AI 改地区时如果正连着：说明行要追加「地区已改，下次连接生效」。 */
  const [regionChangedWhileConnected, setRegionChangedWhileConnected] = useState(false);
  // route_set_mode / routing-changed 的权威值；只在活动配置上覆盖详情里的旧值。
  const [routingOverride, setRoutingOverride] = useState<{
    configId: string;
    mode: ConfigRouteMode;
  } | null>(null);
  const [justOnboarded, setJustOnboarded] = useState(false);
  const [composerFocusSignal, setComposerFocusSignal] = useState(0);
  // 运行时状态的唯一权威：App 与 useVpnSession 共用同一份，避免两个实例的时钟分叉。
  const runtimeAuthorityRef = useRef(createRuntimeAuthority());
  const vpn = useVpnSession(
    bridge,
    import.meta.env.VITE_MOCK === "1" || bridge.mode === "mock",
    runtimeAuthorityRef.current,
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
  // 同一会话同时只允许一条请求：ref 挡住在重渲染之前连点第二下。
  const sendBusyRef = useRef(new Set<string>());
  const requestSessionRef = useRef(new Map<string, string>());
  // 用户在这条请求的 requestId 回来之前就点了停止：拿到 id 后补一次 cancel。
  const pendingStopRef = useRef(new Set<string>());
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
  // 新建配置的 AI 流程：记下开场消息发给哪个会话，防止连点再开一条。
  const newConfigFlowRef = useRef<string | null>(null);

  const markQuestionSettled = (questionId: string) => {
    const settled = settledQuestionIds.current;
    settled.add(questionId);
    if (settled.size > 200) {
      const oldest = settled.values().next().value;
      if (oldest) settled.delete(oldest);
    }
  };

  // 请求结束 / 失败 / 取消后流程才算完；失败时把人送回手动表单，AI 不可用也能建配置。
  const endNewConfigFlow = (sessionId: string, fallbackToForm = true) => {
    if (newConfigFlowRef.current !== sessionId) return;
    newConfigFlowRef.current = null;
    if (!fallbackToForm) return;
    setAppNotice({ level: "error", text: "AI 没接上，先用表单建一套。" });
    openNewConfig();
  };

  const openNewConfig = () => {
    setOwnedNodes(null);
    setServerEntry(null);
    setNewConfigOpen(true);
  };

  // 第 2 问选「其它节点」：切到「我的服务器」，关掉表单并记住接管方式。
  const handleChooseServers = (connectMode: ConfigConnectMode) => {
    setServerEntry({ connectMode });
    setNewConfigOpen(false);
    changeDestination("servers");
  };

  // 回客户端只能点最左侧「客户端」图标：从新建流程来的顺带恢复表单。
  const handleServersBack = () => {
    setServerJoinTarget(null);
    changeDestination("client");
    if (serverEntry) setNewConfigOpen(true);
  };

  // 从服务器带一个节点回新建流程：客户端 + 审视页。
  const handleUseServer = (nodeId: string, serverName: string) => {
    setServerJoinTarget(null);
    setServerEntry(null);
    setOwnedNodes({ nodeIds: [nodeId], label: serverName });
    changeDestination("client");
    setNewConfigOpen(true);
  };

  // 组详情「添加节点 → 从我的服务器添加」：去服务器模块挑一台，带回目标组。
  const handlePickServersForGroup = (groupId: string) => {
    const target = groupsApi.groups.find((group) => group.group_id === groupId);
    if (!target) return;
    setServerJoinTarget({ groupId, name: target.name });
    myServers.resetToRoot();
    changeDestination("servers");
  };

  // 服务器详情里点「加入「X」」：变成组内节点并回到该组。
  const handleJoinServer = (server: MyServer) => {
    const target = serverJoinTarget;
    if (!target) return;
    groupsApi.addServerNode(target.groupId, {
      serverName: server.name,
      host: server.ip,
      port: server.port,
    });
    groupsApi.select(target.groupId);
    setServerJoinTarget(null);
    setAppNotice({ level: "info", text: `已加入「${target.name}」。` });
    changeDestination("groups");
  };

  // 控制台底部「组 · X」：跳到这个组的详情。
  const handleOpenActiveGroup = () => {
    if (!groupsApi.activeGroup) return;
    groupsApi.select(groupsApi.activeGroup.group_id);
    changeDestination("groups");
  };

  // 再点一次「节点组」图标：回根（当前节点组）。
  const lastGroupsRootSignal = useRef(0);
  useEffect(() => {
    if (groupsRootSignal === lastGroupsRootSignal.current) return;
    lastGroupsRootSignal.current = groupsRootSignal;
    groupsApi.resetToRoot();
    // groupsApi 每次渲染都是新对象，只跟着信号走。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groupsRootSignal]);

  // 激活组只登记、不重连：正在跑的那次连接不受影响，下次连接生效。
  const handleActivateGroup = (groupId: string) => {
    const target = groupsApi.groups.find((group) => group.group_id === groupId);
    const previous = groupsApi.activeGroup;
    groupsApi.activate(groupId);
    if (!target) return;
    if (vpn.connection === "connected") {
      setAppNotice({
        level: "info",
        text: `已切到「${target.name}」，当前仍连着「${
          previous?.name ?? "原来的节点"
        }」，下次连接生效。`,
      });
      return;
    }
    setAppNotice({ level: "info", text: "已设为当前节点组。" });
  };
  // 健康事件的版本号：防止发出去要的旧快照把刚收到的 exit_ip 覆盖回 null。
  const healthVersion = useRef(0);
  // 同一个 traffic 会被健康事件重复推送（出口探测、节点延迟都会触发 emit_health）；
  // 只按 sampled_at 推进时的第一条算一个速率样本。
  const lastSampleAtRef = useRef<string | null>(null);
  // 快照请求的单调序号：只接受最新一次请求，避免旧快照晚到覆盖新状态。
  const snapshotSeq = useRef(0);
  // 断开命令返回前，迟到的 online 事件/快照不能把界面推回已连接。
  const stoppingRef = useRef(false);
  // 健康事件里判断当前是不是连接态；用 ref 避免把 runtime.state 放进订阅依赖。
  const runtimeStateRef = useRef<RuntimeView["state"]>(runtime.state);
  // 上次拉快照的时刻：健康事件驱动的刷新最多 5 秒一次。
  const lastSnapshotAtRef = useRef(0);

  const session = activeSession(state);
  const installingServerCount = myServers.servers.filter((server) =>
    isProvisioning(server.state),
  ).length;
  const activeRoutingMode =
    vpn.activeConfig && routingOverride?.configId === vpn.activeConfig.config_id
      ? routingOverride.mode
      : vpn.activeConfig?.routing_mode ?? null;
  const connectedNow =
    vpn.connection === "connected" ||
    runtime.state === "running" ||
    runtime.state === "degraded";
  // 已连接用本次连接快照，未连接用实时推断，和中间区口径同源。
  const scopeRegion =
    runtime.state === "running" || runtime.state === "degraded"
      ? runtime.route_region
      : systemRegion;

  // 不带分区时沿用上次记住的 tab（问 AI 返回靠它）；诊断、导入、AI 未配置会显式指定。
  const openSettings = (section?: SettingsSection) => {
    if (section) setSettingsSection(section);
    setSettingsOpen(true);
  };

  const refreshSnapshot = useCallback(() => {
    lastSnapshotAtRef.current = Date.now();
    const requestId = ++snapshotSeq.current;
    const versionAtRequest = healthVersion.current;
    void bridge.getRuntimeSnapshot().then((snapshot) => {
      if (!snapshot || requestId !== snapshotSeq.current) return;
      const authority = runtimeAuthorityRef.current;
      // 滞后快照（典型是断开收尾时的 running）不能把界面状态写回去。
      if (!authority.acceptsSnapshot(snapshot)) return;
      authority.markSnapshot(snapshot);
      const base = snapshotToView(snapshot);
      setRuntime((current) =>
        versionAtRequest === healthVersion.current
          ? base
          : keepLiveHealth(base, current),
      );
    });
  }, [bridge]);

  useEffect(() => {
    runtimeStateRef.current = runtime.state;
  }, [runtime.state]);

  const refreshDefaultProfile = useCallback(async () => {
    try {
      setDefaultProfile(await bridge.defaultProfileStatus());
    } catch {
      // wave2 命令未接线时不显示默认配置信息，不影响主流程。
    }
  }, [bridge]);

  // 端口设置启动时读一次；读不到就保持默认值，不阻塞主流程。
  useEffect(() => {
    let alive = true;
    bridge
      .proxyPortGet()
      .then((state) => {
        if (alive) setProxyPort(state.port);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [bridge]);

  // 异常退出后的系统代理恢复结果：每次启动只读一次，按结果提示一次。
  useEffect(() => {
    let alive = true;
    bridge
      .proxyRecoveryReport()
      .then((report) => {
        if (!alive || !report) return;
        if (report.recovery?.status === "restored") {
          setAppNotice({
            level: "info",
            text: "上次没退出干净，网络设置已恢复。",
          });
        } else if (report.recovery?.status === "failed") {
          setAppNotice({
            level: "error",
            text: "网络设置没能自动恢复。打开「设置 → 遇到问题 → 强制重置网络」。",
          });
        }
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [bridge]);

  // 地区只决定新建配置的默认流量范围；读不到按未知处理。
  useEffect(() => {
    let alive = true;
    bridge
      .systemRegion()
      .then((result) => {
        if (alive) setSystemRegion(result.region);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
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
      const activeProvider =
        providers?.providers.find(
          (provider) => provider.providerId === providers?.activeProviderId,
        ) ?? null;
      const wasReady = aiConfiguredRef.current;
      aiConfiguredRef.current = ready;
      setAiReady(ready);
      setAiProviderName(activeProvider?.name?.trim() || null);
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
        setAppNotice({
          level: "error",
          text: "窗口拖入只支持 .json 种子文件；节点文本请到 设置 › 连接 › 添加节点导入。",
        });
        return;
      }
      if (importingRef.current) return;

      importingRef.current = true;
      try {
        const result = await bridge.importSeedFile(path);
        setAppNotice({ level: "info", text: `已导入 ${result.imported} 个节点` });
      } catch (error) {
        setAppNotice({ level: "error", text: describeImportError(error) });
      } finally {
        importingRef.current = false;
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
        if (payload.type !== "drop") return;
        if (payload.paths.length > 1) {
          setAppNotice({
            level: "error",
            text: `一次只能导入一个文件，你拖入了 ${payload.paths.length} 个，请逐个拖入。`,
          });
          return;
        }
        const path = payload.paths[0];
        if (path) void importPath(path);
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
      let identityFresh = true;
      if (
        event.name === AGENT_EVENTS.runtimeStateChanged &&
        stoppingRef.current &&
        (event.payload.to === "running" || event.payload.to === "degraded")
      ) {
        // 断开过程中迟到的在线事件：以 stop 的结果为准，不让界面翻回已连接。
        return;
      }
      if (event.name === AGENT_EVENTS.runtimeStateChanged) {
        // 乱序/迟到事件由共享权威判断挡掉，别让顶部状态倒退。
        // 重复事件的快照可能带回旧的连接身份：只有更新的时刻才允许改 config_id。
        const fresh = runtimeAuthorityRef.current.isNewer(event.payload);
        if (!runtimeAuthorityRef.current.acceptEvent(event.payload)) return;
        identityFresh = fresh;
      }
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
        // TUN 的系统 DNS 复核结果只在 runtime_status 里，连接态下节流补拉。
        if (
          shouldRefreshSnapshotOnHealth(
            runtimeStateRef.current,
            lastSnapshotAtRef.current,
            Date.now(),
          )
        ) {
          refreshSnapshot();
        }
      }
      setRuntime((view) => applyRuntimeEvent(view, event, { identity: identityFresh }));
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
        const sessionId = requestSessionRef.current.get(requestId);
        if (sessionId) {
          requestSessionRef.current.delete(requestId);
          sendBusyRef.current.delete(sessionId);
          pendingStopRef.current.delete(sessionId);
          endNewConfigFlow(sessionId, event.payload.result === "error");
        }
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
      if (event.name === AGENT_EVENTS.regionChanged) {
        setSystemRegion(event.payload.region);
        const online =
          runtimeStateRef.current === "running" || runtimeStateRef.current === "degraded";
        setRegionChangedWhileConnected(online);
      }
      if (event.name === AGENT_EVENTS.routingChanged) {
        // AI 通过 RouteSetMode 改了分流：事件里的值就是权威值，不保留本地旧值。
        const payload = event.payload;
        setRoutingOverride({ configId: payload.config_id, mode: payload.routing_mode });
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
          setRegionChangedWhileConnected(false);
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
      .then(({ requestId }) => {
        requestSessionRef.current.set(requestId, session.id);
        dispatch({ type: "request_started", sessionId: session.id, requestId });
        if (pendingStopRef.current.delete(session.id)) {
          void bridge
            .cancel(requestId)
            .then((cancelled) => {
              if (cancelled) return;
              requestSessionRef.current.delete(requestId);
              dispatch({
                type: "request_cancelled_locally",
                sessionId: session.id,
                requestId,
              });
            })
            .catch(() => {});
        }
      })
      .catch((error: unknown) => {
        pendingStopRef.current.delete(session.id);
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

  const handleSend = (text: string): Promise<boolean> => {
    if (!session) return Promise.resolve(false);
    return sendToSession(session.id, text);
  };

  // ai_cancel 返回 false = 后端确认这条请求已经不在跑了：本地立即收尾，不等 request_end。
  const cancelInFlight = (sessionId: string, requestId: string) => {
    void bridge
      .cancel(requestId)
      .then((cancelled) => {
        if (cancelled) return;
        sendBusyRef.current.delete(sessionId);
        requestSessionRef.current.delete(requestId);
        pendingStopRef.current.delete(sessionId);
        dispatch({ type: "request_cancelled_locally", sessionId, requestId });
        endNewConfigFlow(sessionId, false);
      })
      .catch(() => {});
  };

  // 请求占着槽位不一定是在回复：提问待答时 AI 其实在等回答。
  const busyNotice = (sessionId: string) => {
    const waiting = pendingQuestions.some((item) => item.sessionId === sessionId);
    setAppNotice({
      level: "info",
      text: waiting
        ? "先回答上面的问题，或者点跳过。"
        : "上一条还在回复，等它结束再发。",
    });
  };

  const sendToSession = async (
    sessionId: string,
    text: string,
    options: { hidden?: boolean } = {},
  ): Promise<boolean> => {
    if (!aiReady) {
      setAppNotice({ level: "error", text: "还没有配置 AI，先配置后再对话。" });
      openSettings("ai");
      return false;
    }
    const target = state.sessions.find((item) => item.id === sessionId);
    if (
      sendBusyRef.current.has(sessionId) ||
      target?.requesting ||
      target?.activeRequestId
    ) {
      busyNotice(sessionId);
      return false;
    }

    const localRequestId = nextId("local");
    sendBusyRef.current.add(sessionId);
    dispatch(
      options.hidden
        ? { type: "start_hidden_request", sessionId, localRequestId }
        : { type: "send_user_message", sessionId, text, localRequestId },
    );

    try {
      const { requestId } = await bridge.sendMessage(sessionId, text, {
        hidden: options.hidden,
      });
      requestSessionRef.current.set(requestId, sessionId);
      dispatch({ type: "request_started", sessionId, requestId, localRequestId });
      if (pendingStopRef.current.delete(sessionId)) {
        cancelInFlight(sessionId, requestId);
      }
      return true;
    } catch (error: unknown) {
      sendBusyRef.current.delete(sessionId);
      pendingStopRef.current.delete(sessionId);
      const bridgeError = toBridgeError(error);
      if (bridgeError.code === "BUSY") {
        dispatch({ type: "send_rejected", sessionId, localRequestId });
        busyNotice(sessionId);
        return false;
      }
      dispatch({
        type: "request_failed",
        sessionId,
        message: bridgeError.message || "这条没有发出去，再试一次。",
      });
      // 新建配置的开场没送出去（Key 失效、断网）：回退到手动表单。
      endNewConfigFlow(sessionId, true);
      return true;
    }
  };

  // 三处入口共用：打开右栏 + 新建会话 + 契约里的开场指令（hidden，不落用户气泡）。
  const handleReportProblem = () => {
    if (!aiReady || reportOpeningRef.current) return;
    reportOpeningRef.current = true;
    setReportOpening(true);
    setSettingsOpen(false);
    const fresh = { ...createSession(), report: true };
    dispatch({ type: "add_session", session: fresh });
    panelOpenRef.current = true;
    setPanelOpen(true);
    setAiUnread(false);
    void sendToSession(fresh.id, ISSUE_REPORT_OPENING, { hidden: true }).finally(() => {
      reportOpeningRef.current = false;
      setReportOpening(false);
    });
  };

  // 工具卡里的报告动作：直接调命令，不发用户消息（events.md §3.4）。
  const handleDisplayAction = async (
    action: ToolDisplayAction,
  ): Promise<DisplayActionOutcome> => {
    try {
      const result =
        action.kind === "reveal_report_dir"
          ? await bridge.issueReportReveal(action.reportId)
          : await bridge.issueReportMail(action.reportId);
      if (result.opened) return {};
      if (action.kind === "compose_report_mail" && result.method === "copy_only") {
        return {
          message: "没有打开邮件客户端。可以复制正文，或先打开报告文件夹。",
          copyBody: result.body ?? undefined,
        };
      }
      return {
        message:
          action.kind === "compose_report_mail"
            ? "没有打开邮件客户端。可以点「在文件夹中显示」，把报告附到邮件里。"
            : "没能打开文件夹。可以到桌面的「Veyl 问题报告」里找。",
      };
    } catch (error: unknown) {
      const failure = toBridgeError(error);
      return {
        message:
          failure.code === "NOT_FOUND"
            ? "没找到这个报告，可能已被删除；请重新生成一次。"
            : failure.message || "没打开成功，再试一次。",
      };
    }
  };

  const handleEmptySend = (text: string): Promise<boolean> => {
    let target = session;
    if (!target) {
      target = createSession();
      dispatch({ type: "add_session", session: target });
    }
    return sendToSession(target.id, text);
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
    if (!session) return;
    endNewConfigFlow(session.id, false);
    const requestId = session.activeRequestId;
    dispatch({ type: "cancel_request" });
    if (requestId) {
      cancelInFlight(session.id, requestId);
      return;
    }
    // requestId 还没回来（正在发送）：等它到了再取消这一条。
    if (session.requesting) pendingStopRef.current.add(session.id);
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

  const handleAnswerQuestion = async (answer: string): Promise<boolean> => {
    if (!currentQuestion) return false;
    const { sessionId, questionId } = currentQuestion;
    try {
      await bridge.replyUserQuestion(sessionId, questionId, answer);
      markQuestionSettled(questionId);
      setPendingQuestions((current) =>
        current.filter((item) => item.questionId !== questionId),
      );
      // 后端会把回答落成一条 user 消息；本地同步追加，实时和重启后看到的一致。
      // 跳过（空串）不落库，这里也不追加。
      if (answer.length > 0) {
        dispatch({ type: "append_user_message", sessionId, text: answer });
      }
      return true;
    } catch (error) {
      if (toBridgeError(error).code === "NOT_FOUND") {
        // 已经回答或随请求作废：本地关掉浮层即可，不弹错误。
        markQuestionSettled(questionId);
        setPendingQuestions((current) =>
          current.filter((item) => item.questionId !== questionId),
        );
        return false;
      }
      throw error;
    }
  };

  // 输入框里打的字也是对提问的回答：不能走 sendToSession，那条会被单飞拒掉。
  const answerQuestionFromComposer = async (text: string): Promise<boolean> => {
    try {
      // 问题刚好作废时返回 false：让 Composer 把文字放回输入框，不能悄悄清掉。
      return await handleAnswerQuestion(text);
    } catch (error) {
      setAppNotice({
        level: "error",
        text: describeCommandError(error, "回答失败"),
      });
      return false;
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

  const handleCreateConfig = async (
    input: ConfigCreateInput,
  ): Promise<{ ok: boolean; message?: string; reason?: string }> => {
    const result = await vpn.createConfig(input);
    // 失败只在表单里说一次：贴着字段，用户能直接改。
    if (!result.ok) {
      return { ok: false, message: result.message, reason: result.reason };
    }
    if (!result.activated) {
      setAppNotice({ level: "info", text: "已创建，从左侧切换过去。" });
    }
    return { ok: true };
  };

  const handleSetRoutingMode = async (
    mode: "direct" | "proxy_all",
  ): Promise<{ ok: boolean; message?: string }> => {
    const config = vpn.activeConfig;
    if (!config) return { ok: false, message: "先建一套配置。" };
    try {
      const result = await bridge.routeSetMode(mode, config.config_id);
      setRoutingOverride({ configId: config.config_id, mode: result.routing_mode });
      // 热切不会断流；只有重连失败时才需要把 hero 切到失败态。
      if (result.reconnect === "reconnect_failed") refreshSnapshot();
      return { ok: true };
    } catch {
      // 行内说一次，不弹 toast；控件保持原值。
      return { ok: false, message: "没切成功，还是原来的范围。" };
    }
  };

  // 点其它配置只切换「当前用哪套」：不断开、不重连，也不弹确认。
  const handleSelectConfig = (configId: string) => {
    if (configId === vpn.activeConfigId) return;
    const targetName =
      vpn.configs.find((config) => config.config_id === configId)?.name ?? "这套配置";
    // 连接/正在连接的那套在切换前取：切换只改 active，不会改这两个 id。
    // starting 必须用真正的启动配置，不能拿 active 代替（切几次之后 active 已经不是它了）。
    const connection = vpn.connection;
    const launchId =
      connection === "connected"
        ? vpn.connectedConfigId
        : connection === "starting"
          ? vpn.startingConfigId
          : null;
    const launchName = launchId
      ? (vpn.configs.find((config) => config.config_id === launchId)?.name ?? null)
      : null;
    const sameAsTarget = launchId !== null && launchId === configId;

    void vpn.selectConfig(configId).then((result) => {
      if (!result.ok) {
        showActionResult(result, "切换配置失败");
        return;
      }
      // 切回正在连着/正在连的那套：没有变化，不用提示。
      if (sameAsTarget) return;
      if (connection === "connected") {
        setAppNotice({
          level: "info",
          text: launchName
            ? `已切到「${targetName}」，当前仍连着「${launchName}」。点连接会先断开再连。`
            : `已切到「${targetName}」，当前仍有一条连接。点连接会先断开再连。`,
        });
      } else if (connection === "starting") {
        setAppNotice({
          level: "info",
          text: launchName
            ? `已切到「${targetName}」，正在连接的是「${launchName}」。`
            : `已切到「${targetName}」，还有一条连接正在建立。`,
        });
      }
    });
  };

  const handleVpnStart = () => {
    stoppingRef.current = false;
    void vpn.start().then((result) => {
      if (!result.ok && isHelperPermissionReason(result.reason)) {
        setHelperGuideOpen(true);
        return;
      }
      showActionResult(result, "启动失败");
      if (!result.connected) return;
      // start 成功说明后端已经连上。事件/快照可能还停在 starting 或 failed，
      // 不校正的话中间区会继续显示未连接/失败。先按在线显示，再拉快照补细节。
      setFailedAfterConnected(false);
      // 权威先落，再刷新：否则滞后快照会把这个结果盖回去。
      runtimeAuthorityRef.current.markLocal("running");
      setRuntime((view) => viewAfterConnected(view));
      refreshSnapshot();
    });
  };

  // 「创建并连接」：配置列表刷新到新配置后再启动，避免用到旧的 activeConfig。
  useEffect(() => {
    if (!connectAfterCreateRef.current) return;
    if (vpn.loading) return;
    if (!vpn.activeConfig) {
      connectAfterCreateRef.current = false;
      setAppNotice({
        level: "error",
        text: vpn.error ?? "新建的配置没读出来，请在左侧重新选择。",
      });
      return;
    }
    connectAfterCreateRef.current = false;
    handleVpnStart();
  }, [vpn.loading, vpn.activeConfig, vpn.start, vpn.error]);

  const handleVpnStop = (): Promise<boolean> => {
    // 记下点断开这一刻是不是已连接：断开失败时只有原本在线才恢复在线。
    const wasConnected = runtime.state === "running" || runtime.state === "degraded";
    stoppingRef.current = true;
    return vpn.stop().then(
      (result) => {
        showActionResult(result, "断开失败");
        stoppingRef.current = false;
        if (result.stopped) {
          // stop 成功说明已经断开；清掉连接期字段，别让界面停在已连接。
          setFailedAfterConnected(false);
          // 权威先落 idle，再刷新：否则收尾滞后的 running 快照会把界面翻回已连接。
          runtimeAuthorityRef.current.markLocal("idle");
          setRuntime((view) => viewAfterStopped(view));
          refreshSnapshot();
          return true;
        }
        if (!result.ok) {
          // 断开失败：原本在线就回到已连接并报错，不能显示成断开成功。
          runtimeAuthorityRef.current.markLocal(wasConnected ? "running" : "idle");
          if (wasConnected) setRuntime((view) => viewAfterConnected(view));
          refreshSnapshot();
          return false;
        }
        // 被新一轮 start 接管等空返回：只把快照补回来。
        refreshSnapshot();
        return false;
      },
      () => {
        stoppingRef.current = false;
        return false;
      },
    );
  };

  // 已连接但不通：先停稳再起；不先等 stop 回来，stop 命令可能落在新连接上把它关掉。
  const handleVpnReconnect = () => {
    void handleVpnStop().then((stopped) => {
      if (stopped) handleVpnStart();
    });
  };

  // 新建配置走 AI 对话：关掉兜底表单 → 新会话 → 打开右栏 → 发一条用户可见的开场。
  const startNewConfigAiFlow = () => {
    setNewConfigOpen(false);
    if (newConfigFlowRef.current) {
      // 同一流程里再点入口：只把右栏亮出来并给焦点，不重复开会话和发消息。
      kickoffStartedRef.current = true;
      kickoffSessionCreatedRef.current = true;
      panelOpenRef.current = true;
      setPanelOpen(true);
      setAiUnread(false);
      setComposerFocusSignal((value) => value + 1);
      return;
    }
    // 用户已经显式点名要 AI 配，零配置的自动 kickoff 不再另外发一条。
    kickoffStartedRef.current = true;
    kickoffSessionCreatedRef.current = true;
    const fresh = createSession();
    dispatch({ type: "add_session", session: fresh });
    newConfigFlowRef.current = fresh.id;
    panelOpenRef.current = true;
    setPanelOpen(true);
    setAiUnread(false);
    setComposerFocusSignal((value) => value + 1);
    void sendToSession(fresh.id, NEW_CONFIG_AI_ASK)
      .then((ok) => {
        if (!ok) endNewConfigFlow(fresh.id, true);
      })
      .catch(() => endNewConfigFlow(fresh.id, true));
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
      aiProviderName={aiProviderName}
      hasEverConnected={hasEverConnected}
      hasConfigs={vpn.configs.length > 0}
      focusSignal={composerFocusSignal}
      onSelectSession={handleSelectSession}
      onNewSession={() => dispatch({ type: "new_session" })}
      onRenameSession={handleRenameSession}
      onDeleteSession={handleDeleteSession}
      onSend={handleSend}
      onEmptySend={handleEmptySend}
      question={currentQuestion}
      onAnswerQuestion={handleAnswerQuestion}
      onAnswerFromComposer={answerQuestionFromComposer}
      onQuestionExpired={handleQuestionExpired}
      onStop={handleStop}
      onNextAction={handleNextAction}
      onDisplayAction={handleDisplayAction}
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
      <nav className="activity" aria-label="切换主区">
        <button
          type="button"
          className={`activity__item ${destination === "client" ? "is-active" : ""}`}
          aria-pressed={destination === "client"}
          aria-label="客户端"
          title="客户端"
          onClick={handleServersBack}
        >
          <IconConsole size={18} />
        </button>
        <button
          type="button"
          className={`activity__item ${destination === "groups" ? "is-active" : ""}`}
          aria-pressed={destination === "groups"}
          aria-label="节点组"
          title="节点组"
          onClick={() => {
            setServerJoinTarget(null);
            if (destination === "groups") setGroupsRootSignal((value) => value + 1);
            else changeDestination("groups");
          }}
        >
          <IconGroups size={18} />
        </button>
        <button
          type="button"
          className={`activity__item ${destination === "servers" ? "is-active" : ""}`}
          aria-pressed={destination === "servers"}
          aria-label={
            installingServerCount > 0
              ? `我的服务器，${installingServerCount} 台安装中`
              : "我的服务器"
          }
          title="我的服务器"
          onClick={() => {
            if (destination === "servers") setServersRootSignal((value) => value + 1);
            else {
              setServerJoinTarget(null);
              changeDestination("servers");
            }
          }}
        >
          <IconServer size={18} />
          {installingServerCount > 0 ? (
            <span className="activity__dot" aria-hidden />
          ) : null}
        </button>
      </nav>
      {destination === "servers" ? (
        <MyServersRail
          servers={myServers.servers}
          selectedId={myServers.selectedId}
          loading={myServers.loading}
          disabled={myServers.view === "wizard" || myServers.identityLost}
          compact={shell.mode === "drawer"}
          onSelect={myServers.select}
          onNew={myServers.openWizard}
          onOpenSettings={() => openSettings()}
        />
      ) : destination === "groups" ? (
        <NodeGroupsRail
          groups={groupsApi.groups}
          selectedId={groupsApi.selected?.group_id ?? null}
          activeGroupId={groupsApi.activeGroupId}
          compact={shell.mode === "drawer"}
          onSelect={groupsApi.select}
          onCreate={groupsApi.createGroup}
          onOpenSettings={() => openSettings()}
        />
      ) : (
        <ConfigRail
          configs={vpn.configs}
          activeConfigId={vpn.activeConfigId}
          connectedConfigId={vpn.connectedConfigId}
          loading={vpn.loading}
          error={vpn.error}
          onSelect={handleSelectConfig}
          onNewConfig={aiReady ? startNewConfigAiFlow : openNewConfig}
          onRetry={vpn.reload}
          onDelete={vpn.deleteConfig}
          onRename={vpn.renameConfig}
          onOpenSettings={() => openSettings()}
          compact={shell.mode === "drawer"}
        />
      )}
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
      {destination === "servers" ? (
        <MyServersPage
          bridge={bridge}
          catalog={myServers.catalog}
          servers={myServers.servers}
          loading={myServers.loading}
          error={myServers.error}
          detailError={myServers.detailError}
          selected={myServers.selected}
          view={myServers.view}
          confirmLeave={myServers.confirmLeave}
          identityLost={myServers.identityLost}
          identityMessage={myServers.identityMessage}
          joinGroupName={serverJoinTarget?.name ?? null}
          onNew={myServers.openWizard}
          onUseServer={handleUseServer}
          onJoinServer={handleJoinServer}
          onChanged={() => void myServers.refresh()}
          onLeaveWizard={myServers.leaveWizard}
          onKeepWizard={myServers.keepWizard}
          onOrdered={myServers.ordered}
          onReRegister={() => void myServers.reRegister()}
        />
      ) : destination === "groups" ? (
        groupsApi.selected ? (
          <NodeGroupDetail
            group={groupsApi.selected}
            active={groupsApi.selected.group_id === groupsApi.activeGroupId}
            activeConfigName={vpn.activeConfig?.name ?? null}
            connection={vpn.connection}
            onActivate={() => handleActivateGroup(groupsApi.selected!.group_id)}
            onAddNode={(source) =>
              groupsApi.addNode(groupsApi.selected!.group_id, source)
            }
            onCopy={() => groupsApi.copyGroup(groupsApi.selected!.group_id)}
            onOpenServers={() =>
              handlePickServersForGroup(groupsApi.selected!.group_id)
            }
            onRemoveNode={(nodeId) =>
              groupsApi.removeNode(groupsApi.selected!.group_id, nodeId)
            }
            onRename={(name) => groupsApi.renameGroup(groupsApi.selected!.group_id, name)}
            onDelete={() => groupsApi.deleteGroup(groupsApi.selected!.group_id)}
          />
        ) : null
      ) : (
      <Console
        config={vpn.activeConfig}
        connectedConfigId={vpn.connectedConfigId}
        groupName={groupsApi.activeGroup?.name ?? null}
        onOpenGroup={handleOpenActiveGroup}
        connectedConfigName={
          (runtime.config_id ?? vpn.connectedConfigId)
            ? (vpn.configs.find(
                (config) =>
                  config.config_id === (runtime.config_id ?? vpn.connectedConfigId),
              )?.name ?? runtime.config_name)
            : runtime.config_name
        }
        startingConfigId={vpn.startingConfigId}
        startingConfigName={
          vpn.startingConfigId
            ? (vpn.configs.find((config) => config.config_id === vpn.startingConfigId)
                ?.name ?? null)
            : null
        }
        onStart={handleVpnStart}
        onStop={handleVpnStop}
        onReconnect={handleVpnReconnect}
        onReportProblem={aiReady ? handleReportProblem : undefined}
        reportBusy={reportOpening}
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
        onNewConfig={aiReady ? startNewConfigAiFlow : openNewConfig}
        onUseSeedNodes={openNewConfig}
        onImportNodes={() => openSettings("network")}
        seedUpdate={Boolean(defaultProfile?.newVersionAvailable)}
        proxyPort={proxyPort}
        region={systemRegion}
        scopeRegion={scopeRegion}
        regionChanged={regionChangedWhileConnected}
        routingMode={activeRoutingMode}
        onSetRoutingMode={handleSetRoutingMode}
        loading={vpn.loading}
        runtime={runtime}
        failedAfterConnected={failedAfterConnected}
        helperPreparing={vpn.preparingHelper}
        rateSamples={rateSamples}
      />
      )}
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

      {newConfigOpen ? (
        <NewConfigDialog
          bridge={bridge}
          configs={vpn.configs}
          region={systemRegion}
          defaultNodeCount={defaultProfile?.nodeCount ?? null}
          connected={connectedNow}
          initialConnectMode={serverEntry?.connectMode}
          ownedNodes={ownedNodes}
          onChooseServers={handleChooseServers}
          onClose={() => {
            setNewConfigOpen(false);
            setOwnedNodes(null);
            setServerEntry(null);
          }}
          onCreate={handleCreateConfig}
          onCreated={(connect) => {
            setNewConfigOpen(false);
            setOwnedNodes(null);
            setServerEntry(null);
            if (connect) connectAfterCreateRef.current = true;
          }}
        />
      ) : null}

      <AskQuestionDialog
        question={currentQuestion}
        onAnswer={handleAnswerQuestion}
        onExpire={handleQuestionExpired}
        connected={runtime.state === "running" || runtime.state === "degraded"}
      />

      <HelperPermissionDialog
        open={helperGuideOpen}
        onClose={() => setHelperGuideOpen(false)}
        onOpenSettings={() => bridge.tunHelperOpenSettings()}
      />

      <Settings
        open={settingsOpen}
        bridge={bridge}
        runtime={runtime}
        defaultProfile={defaultProfile}
        proxyPort={proxyPort}
        onProxyPortSaved={setProxyPort}
        connectMode={vpn.activeConfig?.connect_mode ?? null}
        configId={vpn.activeConfig?.config_id ?? null}
        onNewConfig={() => {
          // 先关设置页，再走 AI 流程：后者会打开右栏，不能被设置页盖住。
          setSettingsOpen(false);
          if (aiReady) startNewConfigAiFlow();
          else openNewConfig();
        }}
        onClose={closeSettings}
        onNotice={setAppNotice}
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
        onReportProblem={aiReady ? handleReportProblem : undefined}
        reportBusy={reportOpening}
        onAskAi={(text, section) => {
          setSettingsSection(section);
          closeSettings();
          handleAskAi(text);
        }}
      />

      <ConnectionOverlay
        connection={vpn.connection}
        preparingHelper={vpn.preparingHelper}
        checkingHelper={vpn.checkingHelper}
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
