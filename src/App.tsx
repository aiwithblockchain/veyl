import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import type {
  AgentEvent,
  ConfigRouteMode,
  NextAction,
  RuntimeView,
  TrialStatusData,
} from "./agent/protocol";
import { AGENT_EVENTS } from "./agent/protocol";
import { applyRuntimeEvent, emptyRuntimeView, getAgentBridge, keepLiveHealth, snapshotToView } from "./agent";
import { DEFAULT_PROXY_PORT, isTauri, readQuestionDetail, shouldRefreshSnapshotOnHealth, viewAfterConnected, viewAfterStopped } from "./agent/bridge";
import type {
  DefaultProfileStatus,
  MyServer,
  PendingQuestion,
  QuitDecisionAction,
  UiControl,
  UiLastAction,
  UiScreen,
} from "./agent/bridge";
import { BridgeError, toBridgeError } from "./agent/errors";
import { AiPanel, type RenameResult } from "./components/AiPanel";
import { AskQuestionDialog } from "./components/AskQuestionDialog";
import { AssistantOverlay } from "./components/AssistantOverlay";
import { AssistantTab } from "./components/AssistantTab";
import { ConnectionStage } from "./components/ConnectionStage";
import { ConnectionOverlay } from "./components/ConnectionOverlay";
import { HelperPermissionDialog } from "./components/HelperPermissionDialog";
import { MyServersPage } from "./components/MyServersPage";
import { MyServersRail } from "./components/MyServersRail";
import { MyServerLogin } from "./components/MyServerLogin";
import { MyServerTopUp } from "./components/MyServerTopUp";
import { useMyServers } from "./myservers/useMyServers";
import { isProvisioning } from "./myservers/labels";
import { Onboarding } from "./components/Onboarding";
import { PaneHandle } from "./components/PaneHandle";
import { MyServerWizard } from "./components/MyServerWizard";
import { QuitDialog } from "./components/QuitDialog";
import { Settings, describeImportError } from "./components/Settings";
import type { DisplayActionOutcome } from "./components/ToolCallCard";
import type { ToolDisplayAction } from "./components/toolDisplay";
import {
  isAiReady,
  shouldShowOnboarding,
} from "./config/onboarding";
import { useVpnSession, isHelperPermissionReason } from "./config/useVpnSession";
import { createRuntimeAuthority } from "./config/runtimeAuthority";
import { actionCardControls, readActionCards } from "./ui/actionCard";
import { buildUiContext } from "./ui/controlIds";
import { CONNECT_DIAG_ASK, SERVER_FAILURE_ASK } from "./ui/assistantPrompts";
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
import { IconConsole, IconServer, IconSliders } from "./components/icons";
import { usePaneLayout } from "./ui/usePaneLayout";
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

type SettingsSection = "ai" | "network" | "account" | "advanced";

/** 免费节点试用到期：节点已被清走，只留「新建节点」。 */
function TrialExpired({ onNewNode }: { onNewNode: () => void }) {
  return (
    <main className="start-choice" aria-label="试用已到期">
      <section className="start-choice__col">
        <h1 className="start-choice__title">试用已到期</h1>
        <p className="start-choice__note">免费节点已从节点池移除。</p>
        <button type="button" className="trial-expired__action" onClick={onNewNode}>
          新建节点
        </button>
      </section>
    </main>
  );
}

type TrialStepStatus = "pending" | "running" | "done" | "failed";

interface TrialStep {
  status: TrialStepStatus;
  /** 真实耗时（毫秒）；没跑完为 null。 */
  ms: number | null;
}

/** 免费节点试用的三步；步骤推进全部挂在真实 bridge 调用上。 */
interface TrialFlow {
  phase: "fetch" | "join" | "probe" | "done" | "failed";
  fetch: TrialStep;
  join: TrialStep;
  probe: TrialStep;
  failedStep: "fetch" | "join" | "probe" | null;
  error: string | null;
  summary: { count: number; fastestMs: number | null } | null;
}

const TRIAL_STEPS: Array<{ key: "fetch" | "join" | "probe"; title: string }> = [
  { key: "fetch", title: "拉取预置配置" },
  { key: "join", title: "加入免费节点" },
  { key: "probe", title: "逐个测速" },
];

function TrialDots() {
  return (
    <span className="stage-step__dots" aria-hidden="true">
      <span />
      <span />
      <span />
    </span>
  );
}

function TrialFlowPanel({
  flow,
  onRetry,
  onSkipProbe,
}: {
  flow: TrialFlow;
  onRetry: () => void;
  onSkipProbe: () => void;
}) {
  return (
    <div className="stage-steps" aria-label="加入免费节点">
      <ol className="stage-steps__list">
        {TRIAL_STEPS.map(({ key, title }) => {
          const step = flow[key];
          return (
            <li key={key} className={`stage-step is-${step.status}`}>
              <span className="stage-step__title">{title}</span>
              <span className="stage-step__state">
                {step.status === "running" ? <TrialDots /> : null}
                {step.status === "done" && step.ms !== null
                  ? `${(step.ms / 1000).toFixed(1)} 秒`
                  : null}
                {step.status === "failed" ? "没完成" : null}
              </span>
            </li>
          );
        })}
      </ol>
      {flow.error ? (
        <p className="stage-steps__error" role="alert">
          {flow.error}
        </p>
      ) : null}
      {flow.phase === "failed" ? (
        <div className="stage-steps__actions">
          <button type="button" className="stage-primary" onClick={onRetry}>
            重试
          </button>
          {flow.failedStep === "probe" ? (
            <button type="button" className="stage-secondary" onClick={onSkipProbe}>
              先连接，不测速
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** 还没有任何节点时的两选一：新建节点为主，免费节点试用为次。 */
function StartChoice({
  busy,
  onUseFree,
  onNewNode,
  trial,
  onRetryTrial,
  onSkipProbe,
}: {
  busy: boolean;
  onUseFree: () => void;
  onNewNode: () => void;
  trial: TrialFlow | null;
  onRetryTrial: () => void;
  onSkipProbe: () => void;
}) {
  if (trial && trial.phase !== "done") {
    return (
      <main className="start-choice">
        <section className="start-choice__col" aria-label="正在加入免费节点">
          <h1 className="start-choice__title">
            {trial.phase === "failed" ? "免费节点没加完" : "正在加入免费节点"}
          </h1>
          <TrialFlowPanel
            flow={trial}
            onRetry={onRetryTrial}
            onSkipProbe={onSkipProbe}
          />
        </section>
      </main>
    );
  }
  return (
    <main className="start-choice">
      <section className="start-choice__col" aria-label="还没有节点">
        <h1 className="start-choice__title">从哪里开始？</h1>
        <p className="start-choice__note">免费节点不保证稳定，试用 7 天。</p>

        <div className="start-choice__picks">
          <button
            type="button"
            className="start-choice__pick start-choice__pick--primary"
            onClick={onNewNode}
          >
            <span className="start-choice__pick-title">新建节点</span>
            <span className="start-choice__pick-sub">用自己的服务器，更稳定</span>
          </button>
          <button
            type="button"
            className="start-choice__pick start-choice__pick--secondary"
            onClick={onUseFree}
            disabled={busy}
          >
            <span className="start-choice__pick-title">
              {busy ? "正在加入免费节点" : "先试用免费节点"}
            </span>
            <span className="start-choice__pick-sub">2 个节点，7 天试用</span>
          </button>
        </div>
      </section>
    </main>
  );
}

const EVER_CONNECTED_KEY = "veyl.hasEverConnected";
const PANEL_CLOSED_BY_USER_KEY = "veyl.ui.panelClosedByUser";
const PANEL_AUTO_OPENED_KEY = "veyl.ui.panelAutoOpened";

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

/** 取凭据失败的三段式：发生了什么 / 没改动什么 / 现在做什么。 */
function credentialErrorText(error: unknown): string {
  const problem = toBridgeError(error);
  const reason =
    typeof problem.details?.reason === "string" ? problem.details.reason : "";
  if (reason === "server_gone") {
    return "这台服务器已不存在。没有改动任何配置；重新建一台再试。";
  }
  if (reason === "auth_required" || reason === "device_identity_lost") {
    return "这台设备的身份需要重新确认。没有改动任何配置；到左下角的账户里重新登录后再试。";
  }
  if (!problem.retryable) {
    return "这台服务器现在取不了凭据。没有改动任何配置；换一台服务器，或重新建一台。";
  }
  const base =
    problem.message && problem.message !== "操作失败"
      ? problem.message
      : "没拿到这台服务器的节点。";
  return `${base}没有改动任何配置；稍后再试。`;
}

export default function App() {
  const bridge = useMemo(() => getAgentBridge(), []);
  const [state, dispatch] = useReducer(chatReducer, undefined, createInitialState);
  const [settingsOpen, setSettingsOpen] = useState(false);
  /** 设置在咨询 AI：右栏助手搬进弹层并排显示，原来的右栏不再渲染。 */
  const [settingsConsulting, setSettingsConsulting] = useState(false);
  /** AI 指路：打开对应段，并把 row 滚到可见、高亮 2 秒。 */
  const [settingsPoint, setSettingsPoint] = useState<{
    section: SettingsSection;
    row: string | null;
    nonce: number;
  } | null>(null);
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
  // 再点一次已激活的「我的服务器」图标：回到列表根（默认第一台）。
  const [serversRootSignal, setServersRootSignal] = useState(0);
  const myServers = useMyServers(bridge, {
    active: destination === "servers",
    rootSignal: serversRootSignal,
  });
  // 查看账单拉起的登录成功了：回到账户页，账单入口保持可见。
  useEffect(() => {
    const pending = pendingBillsRef.current;
    if (!pending) return;
    if (myServers.loginOpen) {
      pendingBillsRef.current = "seen";
      return;
    }
    if (pending !== "seen") return;
    pendingBillsRef.current = null;
    if (!myServers.loggedIn) return; // 登录框关了但没登录：用户取消
    openSettings("account");
    setAppNotice({
      level: "info",
      text: "账单明细下一版接入，当前余额可在充值里查看。",
    });
  }, [myServers.loggedIn, myServers.loginOpen]);
  /** 取凭据建配置在途：防止连点。 */
  const useServerInFlightRef = useRef(false);
  /** 最近一次用户操作，随下一条消息的 context 上报。 */
  const lastActionRef = useRef<UiLastAction | null>(null);
  /** 从「查看账单」拉起的登录：成功后回到账户页。 */
  const pendingBillsRef = useRef<"waiting" | "seen" | null>(null);
  const destinationRef = useRef(destination);
  destinationRef.current = destination;
  /** 正在为问题报告开会话并发送开场：期间禁用三处入口。 */
  const [reportOpening, setReportOpening] = useState(false);
  const reportOpeningRef = useRef(false);
  const [viewportWidth, setViewportWidth] = useState(() =>
    typeof window === "undefined" ? 1440 : window.innerWidth,
  );
  const [aiUnread, setAiUnread] = useState(false);
  const [defaultProfile, setDefaultProfile] = useState<DefaultProfileStatus | null>(null);
  // 本地代理端口是应用级设置：设置页写，控制台与设置行都读这一份。
  const [proxyPort, setProxyPort] = useState(DEFAULT_PROXY_PORT);
  const [repairing, setRepairing] = useState(false);
  const [pendingQuestions, setPendingQuestions] = useState<PendingQuestion[]>([]);
  /** 试用免费节点：先建配置，等状态刷新后在 effect 里发起连接。 */
  const [trialBusy, setTrialBusy] = useState(false);
  const trialBusyRef = useRef(false);
  const [trialPendingStart, setTrialPendingStart] = useState(false);
  /** 免费节点步骤流：拉取 → 加入 → 测速，全部挂在真实调用上。 */
  const [trialFlow, setTrialFlow] = useState<TrialFlow | null>(null);
  const trialFlowRef = useRef<TrialFlow | null>(null);
  const trialProbeStartedRef = useRef(false);
  /** 免费节点试用状态；过期后只留「新建节点」。 */
  const [trial, setTrial] = useState<TrialStatusData | null>(null);
  const [trialLoaded, setTrialLoaded] = useState(false);
  /** 从两选一 / 到期屏进入「新建节点」舞台。 */
  const [newNodeOpen, setNewNodeOpen] = useState(false);
  /** 新建节点舞台上次选的地区/规格；返回后再进来要恢复。 */
  const [newNodeSelection, setNewNodeSelection] = useState<{
    region: string | null;
    plan: string | null;
  }>({ region: null, plan: null });
  /** AI 选好的地区 / 规格；交给新建节点舞台应用。 */
  /** 已销毁服务器留下的节点：卡片标「已销毁」，不再发命令。 */
  const [destroyedNodeIds, setDestroyedNodeIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [stageSelect, setStageSelect] = useState<{
    region: string | null;
    plan: string | null;
    nonce: number;
  } | null>(null);
  const stageSelectNonceRef = useRef(0);
  /** 舞台是否打开 / 是否在创建中：事件处理走 ref，避免订阅闭包读到旧值。 */
  const newNodeOpenRef = useRef(false);
  const newNodeBusyRef = useRef(false);
  newNodeOpenRef.current = newNodeOpen;
  useEffect(() => {
    if (!newNodeOpen) newNodeBusyRef.current = false;
  }, [newNodeOpen]);
  const [trialNonce, setTrialNonce] = useState(0);
  /** 首屏等配置与试用状态都读回来再决定渲染，避免闪一下两选一。 */
  const [stageReady, setStageReady] = useState(false);
  const [quitOpen, setQuitOpen] = useState(false);
  const [quitBusy, setQuitBusy] = useState(false);
  const [quitError, setQuitError] = useState<string | null>(null);
  const quitBusyRef = useRef(false);
  /** AI 改地区时如果正连着：说明行要追加「地区已改，下次连接生效」。 */
  // route_set_mode / routing-changed 的权威值；只在活动配置上覆盖详情里的旧值。
  const [routingOverride, setRoutingOverride] = useState<{
    configId: string;
    mode: ConfigRouteMode;
  } | null>(null);
  const [composerFocusSignal, setComposerFocusSignal] = useState(0);
  // 运行时状态的唯一权威：App 与 useVpnSession 共用同一份，避免两个实例的时钟分叉。
  const runtimeAuthorityRef = useRef(createRuntimeAuthority());
  const vpn = useVpnSession(
    bridge,
    import.meta.env.VITE_MOCK === "1" || bridge.mode === "mock",
    runtimeAuthorityRef.current,
  );
  const nodeProbes = useNodeProbes({ bridge });
  // 进入连接屏先读缓存，再对非当前节点测一次速；每个配置只自动跑一次。
  const probedConfigsRef = useRef(new Set<string>());
  useEffect(() => {
    if (destination !== "client" || !stageReady) return;
    // 免费节点步骤流自己测速：别在它结束前再起一批。
    if (trialFlowRef.current && trialFlowRef.current.phase !== "done") return;
    const config = vpn.activeConfig;
    if (!config || config.nodes.length === 0) return;
    if (probedConfigsRef.current.has(config.config_id)) return;
    if (!vpn.nodeProbeAvailable) return;
    probedConfigsRef.current.add(config.config_id);
    const nodeIds = config.nodes.map((node) => node.node_id);
    void nodeProbes.loadSnapshot(config.config_id, nodeIds).then(() => {
      const others = nodeIds.filter((id) => id !== config.current_node_id);
      if (others.length > 0) void nodeProbes.start(config.config_id, others);
    });
    // nodeProbes 每次渲染都是新对象，只跟着配置与可用性走。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [destination, stageReady, vpn.activeConfig, vpn.nodeProbeAvailable]);
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
  const markQuestionSettled = (questionId: string) => {
    const settled = settledQuestionIds.current;
    settled.add(questionId);
    if (settled.size > 200) {
      const oldest = settled.values().next().value;
      if (oldest) settled.delete(oldest);
    }
  };

  // 我的服务器 → 用这台建配置：Host 验签落库后，直接把节点放进唯一配置。
  // 「新建节点」的完整流程（地区/规格/计费）下一阶段才接。
  const handleUseServer = async (server: MyServer) => {
    if (useServerInFlightRef.current) return;
    if (vpn.configs.some((config) => config.node_count > 0)) {
      setAppNotice({
        level: "info",
        text: "节点池里已经有节点了，换节点等下一版接入。",
      });
      return;
    }
    useServerInFlightRef.current = true;
    const startedDestination = destinationRef.current;
    try {
      const node = await bridge.myServerCredentials(server.server_id);
      if (destinationRef.current !== startedDestination) return;
      const created = await vpn.createConfig({
        name: server.name,
        connectMode: "tun",
        routingMode: "direct",
        nodeIds: [node.node_id],
      });
      if (!created.ok) {
        setAppNotice({
          level: "error",
          text: created.message ?? "没拿到这台服务器的节点。",
        });
        return;
      }
      changeDestination("client");
    } catch (error) {
      if (destinationRef.current === startedDestination) {
        setAppNotice({ level: "error", text: credentialErrorText(error) });
      }
    } finally {
      useServerInFlightRef.current = false;
    }
  };

  // 健康事件的版本号：防止发出去要的旧快照把刚收到的 exit_ip 覆盖回 null。
  const healthVersion = useRef(0);
  // 同一个 traffic 会被健康事件重复推送（出口探测、节点延迟都会触发 emit_health）；
  // 只按 sampled_at 推进时的第一条算一个速率样本。
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
  // 全局只有一个节点池：有节点才显示节点卡，没有就停在两选一。
  const hasNodes = Boolean(
    (vpn.activeConfig && vpn.activeConfig.nodes.length > 0) ||
      vpn.configs.some((config) => config.node_count > 0),
  );

  /** 当前屏幕：随每条消息带给 Host，是 UI 状态不是用户指令。 */
  const uiScreen: UiScreen = showOnboarding
    ? "onboarding"
    : settingsOpen
      ? "settings"
      : newNodeOpen
        ? "new_node"
        : !stageReady
        ? "client"
        : trial?.state === "expired"
          ? "trial_expired"
          : !hasNodes
            ? "no_nodes"
            : destination === "servers"
              ? "servers"
              : "client";

  const actionCards = useMemo(
    () => readActionCards(vpn.activeConfig?.layout ?? null),
    [vpn.activeConfig?.layout],
  );
  const actionControls: UiControl[] = useMemo(
    () => actionCardControls(actionCards),
    [actionCards],
  );

  const uiLabels: Record<string, string> = {};
  if (uiScreen === "client") {
    const online = runtime.state === "running" || runtime.state === "degraded";
    const starting =
      vpn.connection === "starting" || runtime.state === "starting";
    uiLabels["client.primary"] = starting
      ? "连接中"
      : online
        ? "断开"
        : runtime.state === "failed"
          ? "重新连接"
          : "连接";
    const currentNode = vpn.activeConfig?.nodes.find(
      (node) => node.node_id === vpn.activeConfig?.current_node_id,
    );
    if (currentNode) uiLabels["client.node_pick"] = currentNode.name;
  }
  if (uiScreen === "new_node") {
    uiLabels["new_node.create"] = "创建";
  }
  if (uiScreen === "servers" && myServers.selected) {
    uiLabels["servers.item"] = myServers.selected.name;
  }
  // 不带分区时沿用上次记住的 tab（问 AI 返回靠它）；诊断、导入、AI 未配置会显式指定。
  const openSettings = (section?: SettingsSection) => {
    if (section) setSettingsSection(section);
    setSettingsConsulting(false);
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
        showOnboarding: shouldShowOnboarding({ key, providers }),
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
      if (event.name === AGENT_EVENTS.quitRequested) {
        quitBusyRef.current = false;
        setQuitBusy(false);
        setQuitError(null);
        setQuitOpen(true);
      }
      if (event.name === AGENT_EVENTS.quitDismissed) {
        quitBusyRef.current = false;
        setQuitBusy(false);
        setQuitError(null);
        setQuitOpen(false);
      }
      if (event.name === AGENT_EVENTS.trialExpired) {
        // 到期清理已经提交：节点池、试用状态都要重读，不能只看这个事件。
        setTrial({
          state: "expired",
          started_at: null,
          expires_at: event.payload.ended_at,
          remaining_ms: 0,
          seed_node_count: 0,
        });
        setTrialNonce((value) => value + 1);
      }
      if (event.name === AGENT_EVENTS.myServerChanged) {
        const payload = event.payload as { state?: unknown; node_id?: unknown };
        if (payload.state === "destroyed" && typeof payload.node_id === "string" && payload.node_id) {
          const nodeId = payload.node_id;
          setDestroyedNodeIds((current) => {
            if (current.has(nodeId)) return current;
            const next = new Set(current);
            next.add(nodeId);
            return next;
          });
        }
      }
      if (event.name === AGENT_EVENTS.stageSelect) {
        // 只改舞台选择；舞台没开或正在创建时忽略（契约允许的已知残余）。
        if (
          !newNodeOpenRef.current ||
          newNodeBusyRef.current ||
          destinationRef.current !== "client"
        ) {
          return;
        }
        const { region, plan } = event.payload;
        // null = 这次没请求，不是清空；两个都为 null 就没什么可做的。
        if (region === null && plan === null) return;
        stageSelectNonceRef.current += 1;
        setStageSelect({
          region,
          plan,
          nonce: stageSelectNonceRef.current,
        });
      }
      if (event.name === AGENT_EVENTS.settingsPoint) {
        const { section, row } = event.payload;
        // 契约里叫 connection，界面内部叫 network。
        const target: SettingsSection = section === "connection" ? "network" : section;
        setSettingsSection(target);
        setSettingsConsulting(false);
        setSettingsPoint({ section: target, row: row ?? null, nonce: Date.now() });
        setSettingsOpen(true);
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
            configSetModeConfirm: detail.configSetModeConfirm,
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
      if (event.name === AGENT_EVENTS.routingChanged) {
        // AI 通过 RouteSetMode 改了分流：事件里的值就是权威值，不保留本地旧值。
        const payload = event.payload;
        setRoutingOverride({ configId: payload.config_id, mode: payload.routing_mode });
      }
      if (event.name === AGENT_EVENTS.runtimeStateChanged) {
        setFailedAfterConnected(
          isDisconnectFailure(event.payload.from, event.payload.to),
        );
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
      .catch(() => undefined);
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

  // 试用状态：启动时读一次；收到 trial-expired 或连接成功后重读。
  useEffect(() => {
    if (!onboardingLoaded || showOnboarding) return;
    let cancelled = false;
    if (trialNonce > 0) vpn.reload();
    void bridge
      .trialStatus()
      .then((status) => {
        if (!cancelled) setTrial(status);
      })
      .catch(() => {
        // 旧后端没有这条命令：按未开始处理，不挡界面。
        if (!cancelled) setTrial(null);
      })
      .finally(() => {
        if (!cancelled) setTrialLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [bridge, onboardingLoaded, showOnboarding, trialNonce, vpn.reload]);

  // 首屏只等一次：之后的 reload 不把已经显示的舞台藏起来。
  useEffect(() => {
    if (stageReady) return;
    if (!vpn.loading && trialLoaded) setStageReady(true);
  }, [stageReady, vpn.loading, trialLoaded]);

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

  const completeOnboarding = async () => {
    setShowOnboarding(false);
    setOnboardingLoaded(true);
    await Promise.all([refreshDefaultProfile(), refreshAiStatus()]);
  };

  const finishOnboarding = () => {
    void completeOnboarding();
  };

  const closeSettings = () => {
    setSettingsOpen(false);
    setSettingsConsulting(false);
    void refreshAiStatus();
  };

  // 退出确认：命令没回执前保持弹窗（后端会一直等这次决定），失败就留在原地重试。
  const decideQuit = useCallback(
    (action: QuitDecisionAction) => {
      if (quitBusyRef.current) return;
      quitBusyRef.current = true;
      setQuitBusy(true);
      setQuitError(null);
      void bridge
        .quitDecision(action)
        .then(() => {
          quitBusyRef.current = false;
          setQuitBusy(false);
          setQuitOpen(false);
        })
        .catch((failure) => {
          const error = toBridgeError(failure);
          quitBusyRef.current = false;
          setQuitBusy(false);
          setQuitError(error.message || "没能把选择交给后台，请再试一次。");
        });
    },
    [bridge],
  );

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
    text: string | undefined,
    options: { hidden?: boolean; lastAction?: UiLastAction } = {},
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
        : { type: "send_user_message", sessionId, text: text ?? "", localRequestId },
    );

    try {
      const context = buildUiContext({
        screen: uiScreen,
        labels: uiLabels,
        actionControls,
        lastAction: options.lastAction ?? lastActionRef.current,
      });
      // 上报一次就消费掉：下一条消息不重复说「用户刚刚点了」。
      lastActionRef.current = null;
      const { requestId } = await bridge.sendMessage(sessionId, text, {
        hidden: options.hidden,
        context,
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

  const handleVpnStart = () => {
    lastActionRef.current = { id: "client.primary" };
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

  // 「创建并连接」：配置列表刷新到新配置后再启动；失败不留空配置。
  useEffect(() => {
    if (!trialPendingStart) return;
    if (vpn.loading) return;
    // 步骤流还没跑完（例如测速中）：先等它结束，再连接。
    if (trialFlow && trialFlow.phase !== "done") return;
    const config = vpn.activeConfig;
    if (!config || config.nodes.length === 0) {
      trialBusyRef.current = false;
      setTrialPendingStart(false);
      setTrialBusy(false);
      const emptyId = config && config.nodes.length === 0 ? config.config_id : null;
      if (emptyId) void vpn.deleteConfig(emptyId);
      setAppNotice({
        level: "error",
        text: vpn.error ?? "免费节点没加进来，再试一次。",
      });
      return;
    }
    trialBusyRef.current = false;
    setTrialPendingStart(false);
    setTrialBusy(false);
    void vpn.start().then((result) => {
      if (!result.ok) {
        setAppNotice({
          level: "error",
          text: result.message ?? "免费节点加进来了，但没能连上，可以再点一次连接。",
        });
        return;
      }
      // 种子节点连上才写试用起算点，这里重读一次状态。
      setTrialNonce((value) => value + 1);
    });
  }, [
    trialPendingStart,
    trialFlow,
    vpn.loading,
    vpn.activeConfig,
    vpn.start,
    vpn.deleteConfig,
    vpn.error,
  ]);

  const handleVpnStop = (): Promise<boolean> => {
    lastActionRef.current = { id: "client.primary" };
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
    lastActionRef.current = { id: "client.primary" };
    void handleVpnStop().then((stopped) => {
      if (stopped) handleVpnStart();
    });
  };

  // 「新建节点」暂由 AI 接手：打开右栏并给输入框焦点，后续流程下一阶段接。
  const handleAskAiFromConsole = () => {
    panelOpenRef.current = true;
    setPanelOpen(true);
    setAiUnread(false);
    setComposerFocusSignal((value) => value + 1);
  };

  const handleSwitchNode = (nodeId: string) => {
    lastActionRef.current = { id: "client.node_pick", value: nodeId };
    return vpn.switchNode(nodeId);
  };

  // action_card 的按钮只上报：hidden 消息 + context.last_action，不直接调命令。
  const handleActionCardAction = (action: { id: string }) => {
    lastActionRef.current = { id: action.id };
    let target = session;
    if (!target) {
      target = createSession();
      dispatch({ type: "add_session", session: target });
    }
    panelOpenRef.current = true;
    setPanelOpen(true);
    setAiUnread(false);
    void sendToSession(target.id, undefined, {
      hidden: true,
      lastAction: { id: action.id },
    });
  };

  // 「AI 定位」：只上报这个动作并带上固定前缀，不直接调 MyServerFailure。
  const handleAiLocate = (serverId: string) => {
    lastActionRef.current = { id: "servers.ai_locate", value: serverId };
    let target = session;
    if (!target) {
      target = createSession();
      dispatch({ type: "add_session", session: target });
    }
    panelOpenRef.current = true;
    setPanelOpen(true);
    setAiUnread(false);
    void sendToSession(target.id, SERVER_FAILURE_ASK, {
      hidden: true,
      lastAction: { id: "servers.ai_locate", value: serverId },
    });
  };

  const handleDiagnose = () => {
    handleAskAi(CONNECT_DIAG_ASK);
  };

  // 查看账单：先确认登录；没登录就拉起登录，成功后回到账户页。
  const handleViewBills = async () => {
    pendingBillsRef.current = "waiting";
    const allowed = await myServers.requestBills();
    if (!allowed) {
      closeSettings();
      return;
    }
    pendingBillsRef.current = null;
    setAppNotice({
      level: "info",
      text: "账单明细下一版接入，当前余额可在充值里查看。",
    });
  };

  const commitTrialFlow = (next: TrialFlow) => {
    trialFlowRef.current = next;
    setTrialFlow(next);
  };

  const failTrial = (
    current: TrialFlow,
    step: "fetch" | "join" | "probe",
    message: string,
    ms: number | null = null,
  ) => {
    commitTrialFlow({
      ...current,
      phase: "failed",
      failedStep: step,
      error: message,
      [step]: { status: "failed", ms },
    });
    trialBusyRef.current = false;
    setTrialBusy(false);
  };

  // 先试用免费节点：拉取预置配置 → 建唯一配置（seed 节点、Tun、智能分流）→ 逐个测速。
  const handleUseFreeNodes = async () => {
    if (trialBusyRef.current || hasNodes) return;
    lastActionRef.current = { id: "no_nodes.trial" };
    trialBusyRef.current = true;
    setTrialBusy(true);
    setAppNotice(null);
    trialProbeStartedRef.current = false;

    const start: TrialFlow = {
      phase: "fetch",
      fetch: { status: "running", ms: null },
      join: { status: "pending", ms: null },
      probe: { status: "pending", ms: null },
      failedStep: null,
      error: null,
      summary: null,
    };
    commitTrialFlow(start);

    const fetchStartedAt = Date.now();
    try {
      // 本地已有预置节点就不动；没有才联网拉取。
      const status = await bridge.defaultProfileStatus();
      if (status.nodeCount === 0) await bridge.defaultProfileRefresh();
    } catch (error) {
      const message = toBridgeError(error).message;
      failTrial(
        trialFlowRef.current ?? start,
        "fetch",
        message && message !== "操作失败"
          ? `没拉到预置配置。${message}`
          : "没拉到预置配置，再试一次。",
      );
      return;
    }

    const afterFetch: TrialFlow = {
      ...(trialFlowRef.current ?? start),
      phase: "join",
      fetch: { status: "done", ms: Date.now() - fetchStartedAt },
      join: { status: "running", ms: null },
    };
    commitTrialFlow(afterFetch);

    const joinStartedAt = Date.now();
    const created = await vpn.createConfig({
      name: "免费节点",
      connectMode: "tun",
      routingMode: "direct",
      source: "seed",
    });
    if (!created.ok) {
      failTrial(
        trialFlowRef.current ?? afterFetch,
        "join",
        created.message ?? "没能加入免费节点，再试一次。",
        Date.now() - joinStartedAt,
      );
      return;
    }

    const afterJoin: TrialFlow = {
      ...(trialFlowRef.current ?? afterFetch),
      phase: "probe",
      join: { status: "done", ms: Date.now() - joinStartedAt },
      probe: { status: "running", ms: null },
    };
    commitTrialFlow(afterJoin);
    setTrialPendingStart(true);
  };

  // 测速步骤：逐个调用真实测速命令，全部返回后才算完成。
  useEffect(() => {
    if (!trialFlow || trialFlow.phase !== "probe") return;
    if (trialProbeStartedRef.current) return;
    if (vpn.loading) return;
    const config = vpn.activeConfig;
    if (!config || config.nodes.length === 0) return;
    trialProbeStartedRef.current = true;
    // 这一步自己测，别让连接屏的自动测速再跑一批。
    probedConfigsRef.current.add(config.config_id);
    const startedAt = Date.now();
    const nodeIds = config.nodes.map((node) => node.node_id);
    void (async () => {
      const latencies: number[] = [];
      for (const nodeId of nodeIds) {
        try {
          const result = await bridge.nodeProbe(nodeId);
          if (result.reachable && result.latency_ms !== null) {
            latencies.push(result.latency_ms);
          }
        } catch {
          // 单个节点失败不影响其余节点；全部失败才算这一步失败。
        }
      }
      // 结果推进测速状态，节点卡直接显示延迟。
      await nodeProbes
        .loadSnapshot(config.config_id, nodeIds)
        .catch(() => undefined);
      const current = trialFlowRef.current;
      if (!current || current.phase !== "probe") return;
      const elapsed = Date.now() - startedAt;
      if (latencies.length === 0) {
        failTrial(
          current,
          "probe",
          "两个节点都没测速成功，可以重试，或先连接。",
          elapsed,
        );
        return;
      }
      commitTrialFlow({
        ...current,
        phase: "done",
        probe: { status: "done", ms: elapsed },
        summary: {
          count: nodeIds.length,
          fastestMs: Math.min(...latencies),
        },
      });
      trialBusyRef.current = false;
      setTrialBusy(false);
    })();
  }, [trialFlow, vpn.loading, vpn.activeConfig, bridge, nodeProbes]);

  const handleRetryTrial = () => {
    const current = trialFlowRef.current;
    if (!current) return;
    // 节点已经加进来了：只重跑测速，不重建配置。
    if (current.failedStep === "probe" && hasNodes) {
      trialBusyRef.current = true;
      setTrialBusy(true);
      trialProbeStartedRef.current = false;
      commitTrialFlow({
        ...current,
        phase: "probe",
        failedStep: null,
        error: null,
        probe: { status: "running", ms: null },
      });
      return;
    }
    void handleUseFreeNodes();
  };

  // 测速失败时不再挡路：带着已加入的节点进入连接屏。
  const handleSkipTrialProbe = () => {
    const current = trialFlowRef.current;
    if (!current) return;
    commitTrialFlow({
      ...current,
      phase: "done",
      failedStep: null,
      error: null,
      probe: { status: "failed", ms: current.probe.ms },
      summary: null,
    });
    trialBusyRef.current = false;
    setTrialBusy(false);
  };

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

  // 配置与试用状态都读回来后再渲染，避免首屏闪一下「从哪里开始？」。
  if (!stageReady) {
    return <div className="app-boot" aria-hidden />;
  }

  return (
    <div style={appStyle} className={`app ${destination === "servers" ? "" : "app--solo"}`.trim()}>
      <nav className="activity" aria-label="切换主区">
        <button
          type="button"
          className={`activity__item ${destination === "client" ? "is-active" : ""}`}
          aria-pressed={destination === "client"}
          aria-label="连接"
          title="连接"
          onClick={() => changeDestination("client")}
        >
          <IconConsole size={18} />
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
              changeDestination("servers");
            }
          }}
        >
          <IconServer size={18} />
          {installingServerCount > 0 ? (
            <span className="activity__dot" aria-hidden />
          ) : null}
        </button>

        <div className="activity__foot">
          <button
            type="button"
            className="activity__item"
            aria-label="设置"
            title="设置"
            onClick={() => openSettings()}
          >
            <IconSliders size={18} />
          </button>
          <button
            type="button"
            className="activity__item"
            aria-label="账户"
            title="账户"
            onClick={() => changeDestination("servers")}
          >
            <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden>
              <circle
                cx="10"
                cy="7.2"
                r="2.6"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.35"
              />
              <path
                d="M4.6 16.2a5.4 5.4 0 0 1 10.8 0"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.35"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </div>
      </nav>
      {destination === "servers" ? (
        <MyServersRail
          servers={myServers.servers}
          selectedId={myServers.selectedId}
          loading={myServers.loading}
          identityMissing={myServers.identityMissing}
          account={myServers.account}
          accountLoaded={myServers.accountLoaded}
          wallet={myServers.wallet}
          walletLoading={myServers.walletLoading}
          walletError={myServers.walletError}
          error={myServers.error}
          retrying={myServers.retrying}
          retryNotice={myServers.retryNotice}
          disabled={myServers.identityLost}
          compact={shell.mode === "drawer"}
          onSelect={myServers.select}
          onNew={myServers.openWizard}
          onRetry={() => void myServers.retry()}
          onLogin={myServers.openLogin}
          onLogout={myServers.logout}
          onTopUp={myServers.openTopUp}
          onRefreshWallet={() => void myServers.refreshWallet()}
          onOpenSettings={() => openSettings()}
        />
      ) : null}
      {destination === "servers" && panes.canDragRail ? (
        <PaneHandle
          side="rail"
          label="调整列表宽度"
          controls="config-rail"
          value={panes.rail}
          min={RAIL_MIN}
          max={panes.railMax}
          dragging={panes.draggingPane === "rail"}
          {...panes.railHandlers}
        />
      ) : null}
      {destination === "client" && newNodeOpen ? (
        <main className="connection-stage" aria-label="新建节点">
          <div className="connection-stage__col">
            <MyServerWizard
              bridge={bridge}
              catalog={myServers.catalog}
              onOrdered={() => {
                setNewNodeOpen(false);
                changeDestination("servers");
                void myServers.refresh();
              }}
              onEnsureIdentity={myServers.ensureIdentity}
              onTopUp={myServers.openTopUp}
              onAuthRequired={myServers.openLogin}
              onAskAi={() => {
                lastActionRef.current = { id: "new_node.ask_ai" };
                handleAskAi("帮我选一个地区和规格。");
              }}
              onAiLocate={handleAiLocate}
              aiSelection={stageSelect}
              initialSelection={newNodeSelection}
              onBusyChange={(busy) => {
                newNodeBusyRef.current = busy;
              }}
              onBack={() => setNewNodeOpen(false)}
              onSelectionApplied={(pick) =>
                setNewNodeSelection({ region: pick.region, plan: pick.plan })
              }
              onSelect={(kind, id) => {
                lastActionRef.current = { id: `new_node.${kind}`, value: id };
                setNewNodeSelection((current) => ({ ...current, [kind]: id }));
              }}
            />
          </div>
        </main>
      ) : destination === "servers" ? (
        <MyServersPage
          bridge={bridge}
          catalog={myServers.catalog}
          selected={myServers.selected}
          view={myServers.view}
          detailError={myServers.detailError}
          detailRetrying={myServers.detailRetrying}
          readOnly={myServers.identityLost}
          sharedTransfer={myServers.sharedTransfer}
          onNew={myServers.openWizard}
          onEnsureIdentity={myServers.ensureIdentity}
          onUseServer={handleUseServer}
          onChanged={() => void myServers.refresh()}
          onOrdered={myServers.ordered}
          onRebuilt={myServers.rebuilt}
          onRetryDetail={myServers.retryDetail}
          onTopUp={myServers.openTopUp}
          onAiLocate={handleAiLocate}
          onAuthRequired={myServers.openLogin}
        />
      ) : trial?.state === "expired" ? (
        <TrialExpired
          onNewNode={() => {
            lastActionRef.current = { id: "trial_expired.new_node" };
            setNewNodeOpen(true);
          }}
        />
      ) : hasNodes && !(trialFlow && trialFlow.phase !== "done") ? (
        <ConnectionStage
          config={vpn.activeConfig}
          connection={vpn.connection}
          runtime={runtime}
          onStart={handleVpnStart}
          onStop={() => void handleVpnStop()}
          onReconnect={handleVpnReconnect}
          onSwitchNode={handleSwitchNode}
          nodeProbes={nodeProbes}
          failedAfterConnected={failedAfterConnected}
          helperPreparing={vpn.preparingHelper}
          onReportProblem={aiReady ? handleReportProblem : undefined}
          reportBusy={reportOpening}
          actionCards={actionCards}
          destroyedNodeIds={destroyedNodeIds}
          onActionCardAction={handleActionCardAction}
          onDiagnose={handleDiagnose}
          trialSummary={trialFlow?.summary ?? null}
        />
      ) : (
        <StartChoice
          busy={trialBusy}
          onUseFree={() => void handleUseFreeNodes()}
          onNewNode={() => {
            lastActionRef.current = { id: "no_nodes.new_node" };
            setNewNodeOpen(true);
          }}
          trial={trialFlow}
          onRetryTrial={handleRetryTrial}
          onSkipProbe={handleSkipTrialProbe}
        />
      )}
      {settingsOpen && settingsConsulting ? null : panelOpen && shell.docked ? (
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

      {myServers.loginOpen ? (
        <MyServerLogin
          onStart={myServers.loginStart}
          onVerify={myServers.loginVerify}
          onCancel={myServers.closeLogin}
        />
      ) : null}

      {myServers.topupOpen ? (
        <MyServerTopUp
          wallet={myServers.wallet}
          loading={myServers.walletLoading}
          error={myServers.walletError}
          onRetry={() => void myServers.refreshWallet()}
          onTopUp={myServers.topup}
          onClose={myServers.closeTopUp}
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
          setSettingsOpen(false);
          handleAskAiFromConsole();
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
        routingMode={activeRoutingMode}
        onSetRoutingMode={handleSetRoutingMode}
        onConnectModeChanged={() => vpn.reload()}
        assistant={aiPanel}
        onConsultingChange={setSettingsConsulting}
        onSectionChange={(section) => {
          setSettingsSection(section);
          lastActionRef.current = {
            id: `settings.${
              section === "network" ? "connection" : section
            }`,
          };
        }}
        point={settingsPoint}
        account={myServers.account}
        wallet={myServers.wallet}
        onLogin={() => {
          closeSettings();
          myServers.openLogin();
        }}
        onTopUp={() => {
          closeSettings();
          myServers.openTopUp();
        }}
        onViewBills={() => void handleViewBills()}
      />

      <ConnectionOverlay
        connection={vpn.connection}
        preparingHelper={vpn.preparingHelper}
        checkingHelper={vpn.checkingHelper}
        runtime={runtime}
        connectMode={vpn.activeConfig?.connect_mode ?? null}
      />

      {quitOpen ? (
        <QuitDialog
          busy={quitBusy}
          error={quitError}
          onDecision={decideQuit}
        />
      ) : null}
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
