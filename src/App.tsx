import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import type {
  AgentEvent,
  ConfigConnectMode,
  ConfigRouteMode,
  NextAction,
  NodeSummary,
  RuntimeSnapshot,
  RuntimeView,
  TrialStatusData,
} from "./agent/protocol";
import { AGENT_EVENTS } from "./agent/protocol";
import { applyRuntimeEvent, emptyRuntimeView, getAgentBridge, keepLiveHealth, snapshotToView } from "./agent";
import { DEFAULT_PROXY_PORT, isConfirmQuestionKind, isTauri, readQuestionDetail, shouldRefreshSnapshotOnHealth, viewAfterConnected, viewAfterStopped } from "./agent/bridge";
import type {
  AgentBridge,
  DefaultProfileStatus,
  MyServer,
  NodeProbeResult,
  PendingQuestion,
  QuitDecisionAction,
  SyncIntervalMinutes,
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
import { DiagnosisPanel } from "./components/DiagnosisPanel";
import { HelperPermissionDialog } from "./components/HelperPermissionDialog";
import { MyServersPage } from "./components/MyServersPage";
import { MyServersRail } from "./components/MyServersRail";
import { MyServerLogin } from "./components/MyServerLogin";
import { MyServerTopUp } from "./components/MyServerTopUp";
import { NodeImportDialog } from "./components/NodeImportDialog";
import { MobileExport, hasReadyServer } from "./components/MobileExport";
import { useMyServers } from "./myservers/useMyServers";
import { useServerNodePooling } from "./myservers/useServerNodePooling";
import { isProvisioning, trialAvailableHint } from "./myservers/labels";
import { collectPendingServerNodes } from "./myservers/pendingServerNodes";
import { collectDanglingNodeIds } from "./myservers/tombstones";
import { useServerSync } from "./myservers/useServerSync";
import { uiLog } from "./log/uiLog";
import { rotateFailureReason, rotateNodeCredentials } from "./myservers/rotateCredentials";
import { staleConfigNodeId } from "./myservers/staleConfig";
import { repairAvailableFor } from "./myservers/repairAvailability";
import type {
  ConnectionFacts,
  ConnectionLocalCheck,
  ConnectionRetest,
  DiagnosisDeps,
  DiagnosisFacts,
  ProbeOutcome,
  ReconnectOutcome,
} from "./myservers/useNodeDiagnosis";
import { Onboarding } from "./components/Onboarding";
import { AiRequiredDialog } from "./components/AiRequiredDialog";
import { PaneHandle } from "./components/PaneHandle";
import { MyServerWizard } from "./components/MyServerWizard";
import { QuitDialog } from "./components/QuitDialog";
import { Settings, describeImportError } from "./components/Settings";
import type { DisplayActionOutcome } from "./components/ToolCallCard";
import type { ToolDisplayAction } from "./components/toolDisplay";
import {
  isAiReady,
  ONBOARDING_SKIPPED_KEY,
  shouldShowOnboarding,
} from "./config/onboarding";
import { useVpnSession, isHelperPermissionReason } from "./config/useVpnSession";
import { createRuntimeAuthority } from "./config/runtimeAuthority";
import { actionCardControls, readActionCards } from "./ui/actionCard";
import { buildUiContext } from "./ui/controlIds";
import { connectDiagnosisAsk, nodeDiagnosisAsk, serverFailureAsk } from "./ui/assistantPrompts";
import { mobileExportPrompt } from "./ai/advancedPrompts";
import { useNodeProbes } from "./config/useNodeProbes";
import {
  assistantColumnWidth,
  shellLayout,
} from "./ui/breakpoints";
import { isDisconnectFailure } from "./ui/middleArea";
import { displayNodeNames } from "./ui/nodeList";
import { issueReportOpening } from "./ui/issueReport";
import { readPanelOpen, writePanelChoice } from "./ui/panelPreference";
import { ASSISTANT_MIN, RAIL_MIN } from "./ui/layout";
import { IconConsole, IconServer, IconSliders } from "./components/icons";
import { AccountAvatar } from "./components/AccountAvatar";
import { AccountMenu } from "./components/AccountMenu";
import { usePaneLayout } from "./ui/usePaneLayout";
import { activeSession, chatReducer, createInitialState, createSession, nextId } from "./state/chatStore";
import { t as translate, useT } from "./i18n";
import type { MessageKey } from "./i18n";
import { errorText } from "./i18n/errorText";
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

/** 外壳只有两个 destination：连接（舞台）与我的服务器（列表 + 详情）。 */
type Destination = "client" | "servers";

/** 免费节点试用到期：节点已被清走，只留「新建节点」。 */
function TrialExpired({
  onNewNode,
  onAddNode,
}: {
  onNewNode: () => void;
  onAddNode: () => void;
}) {
  const t = useT();
  return (
    <main className="start-choice" aria-label={t("trial.expired.aria")}>
      <section className="start-choice__col">
        <h1 className="start-choice__title">{t("trial.expired.title")}</h1>
        <p className="start-choice__note">{t("trial.expired.note")}</p>
        <button type="button" className="trial-expired__action" onClick={onNewNode}>
          {t("trial.expired.newNode")}
        </button>
        <button type="button" className="start-choice__add" onClick={onAddNode}>
          {t("trial.addOwnNode")}
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
  summary: { configId: string; count: number; fastestMs: number | null } | null;
}

const TRIAL_STEPS: Array<{ key: "fetch" | "join" | "probe"; title: MessageKey }> = [
  { key: "fetch", title: "trial.step.fetch" },
  { key: "join", title: "trial.step.join" },
  { key: "probe", title: "trial.step.probe" },
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
  const t = useT();
  return (
    <div className="stage-steps" aria-label={t("trial.flow.aria")}>
      <ol className="stage-steps__list">
        {TRIAL_STEPS.map(({ key, title }) => {
          const step = flow[key];
          return (
            <li key={key} className={`stage-step is-${step.status}`}>
              <span className="stage-step__title">{t(title)}</span>
              <span className="stage-step__state">
                {step.status === "running" ? <TrialDots /> : null}
                {step.status === "done" && step.ms !== null
                  ? t("trial.flow.seconds", { value: (step.ms / 1000).toFixed(1) })
                  : null}
                {step.status === "failed" ? t("trial.flow.notDone") : null}
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
            {t("trial.flow.retry")}
          </button>
          {flow.failedStep === "probe" ? (
            <button type="button" className="stage-secondary" onClick={onSkipProbe}>
              {t("trial.flow.skipProbe")}
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
  onAddNode,
  trial,
  onRetryTrial,
  onSkipProbe,
  accountLoaded,
  loggedIn,
  accountError,
  emptyConfig,
}: {
  busy: boolean;
  onUseFree: () => void;
  onNewNode: () => void;
  /** 手里已有自建节点：打开手动添加 / 导入弹层。 */
  onAddNode: () => void;
  trial: TrialFlow | null;
  onRetryTrial: () => void;
  onSkipProbe: () => void;
  /** 配置还在、只是节点被删光了：底部说明这一条配置已经没有节点。 */
  emptyConfig: boolean;
  /** 账户还没读到时按已登录的短句显示：不给已登录用户闪一下「要先登录」。 */
  accountLoaded: boolean;
  loggedIn: boolean;
  /** 账户读失败时也同样用短句：离线用户可能本来是登录的。 */
  accountError: boolean;
}) {
  const t = useT();
  if (trial && trial.phase !== "done") {
    return (
      <main className="start-choice">
        <section className="start-choice__col" aria-label={t("trial.starting.aria")}>
          <h1 className="start-choice__title">
            {trial.phase === "failed"
              ? t("trial.failed.title")
              : t("trial.starting.title")}
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
      <section className="start-choice__col" aria-label={t("trial.start.aria")}>
        <h1 className="start-choice__title">{t("trial.start.title")}</h1>
        <p className="start-choice__note">
          {accountLoaded && !loggedIn && !accountError
            ? t("trial.start.noteGuest")
            : t("trial.start.note")}
        </p>

        <div className="start-choice__picks">
          <button
            type="button"
            className="start-choice__pick start-choice__pick--primary"
            onClick={onNewNode}
          >
            <span className="start-choice__pick-title">{t("trial.start.newNode")}</span>
            <span className="start-choice__pick-sub">{t("trial.start.newNodeSub")}</span>
          </button>
          <button
            type="button"
            className="start-choice__pick start-choice__pick--secondary"
            onClick={onUseFree}
            disabled={busy}
          >
            <span className="start-choice__pick-title">
              {busy ? t("trial.start.busy") : t("trial.start.free")}
            </span>
            <span className="start-choice__pick-sub">{t("trial.start.freeSub")}</span>
          </button>
        </div>
        {emptyConfig ? (
          <p className="start-choice__empty">{t("trial.start.emptyConfig")}</p>
        ) : null}
        <button type="button" className="start-choice__add" onClick={onAddNode}>
          {t("trial.addOwnNode")}
        </button>
      </section>
    </main>
  );
}

const EVER_CONNECTED_KEY = "veyl.hasEverConnected";
const PANEL_CLOSED_BY_USER_KEY = "veyl.ui.panelClosedByUser";
const PANEL_AUTO_OPENED_KEY = "veyl.ui.panelAutoOpened";

/** 折叠行里的页面名：与发起提问的屏幕一一对应。 */
const QUESTION_SCREEN_LABEL: Record<UiScreen, MessageKey> = {
  onboarding: "app.screen.onboarding",
  client: "app.screen.client",
  no_nodes: "app.screen.client",
  trial_expired: "app.screen.client",
  new_node: "app.screen.new_node",
  servers: "app.screen.servers",
  settings: "app.screen.settings",
};

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
  const t = useT();
  const bridge = useMemo(() => getAgentBridge(), []);
  const [state, dispatch] = useReducer(chatReducer, undefined, createInitialState);
  // 输入框草稿存在 App：咨询模式切换会让助手搬进弹层并重挂载，草稿不能跟着丢。
  // 只存一份，和改动前单实例 Composer 的行为一致（切会话也保留）。
  const [composerDraft, setComposerDraft] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  /** 「在手机上使用」弹层：设置行与左栏行共用这一份开关。 */
  const [mobileExportOpen, setMobileExportOpen] = useState(false);
  /** 节点导入 / 手动填写弹层：入口在控制台节点卡。 */
  const [nodeImportOpen, setNodeImportOpen] = useState(false);
  /** 编辑态的节点；为空时弹层是「添加节点」。 */
  const [editingNode, setEditingNode] = useState<NodeSummary | null>(null);
  const mobileExportTriggerRef = useRef<HTMLElement | null>(null);
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
  /** 事件回调里判断「当前是否已连接、连的是哪台」用 ref，避免闭包过期。 */
  const runtimeRef = useRef(runtime);
  runtimeRef.current = runtime;
  /** 周期同步发现当前节点的配置变了：hero 区提示重新连接（本地节点 id）。 */
  const [staleConfigNode, setStaleConfigNode] = useState<string | null>(null);
  // 失败快照里 connected_since 已被后端清空，只能记住这次失败是不是从已连接态掉下来的。
  // 每次状态迁移都整体覆盖，非失败迁移自然复位。
  const [failedAfterConnected, setFailedAfterConnected] = useState(false);
  const [appNotice, setAppNotice] = useState<AppNotice | null>(null);
  // 连接失败但原因只是「系统还没允许后台助手」：弹引导，不用 toast。
  const [helperGuideOpen, setHelperGuideOpen] = useState(false);
  // 断开或换节点后，旧的「配置已变更」提示不再成立。
  useEffect(() => {
    if (!staleConfigNode) return;
    const running = runtime.state === "running" || runtime.state === "degraded";
    if (!running || runtime.node_id !== staleConfigNode) {
      setStaleConfigNode(null);
    }
  }, [runtime.state, runtime.node_id, staleConfigNode]);

  // 成功类提示 4 秒自动消失；错误提示留到用户手动关闭。
  useEffect(() => {
    if (!appNotice || appNotice.level !== "info") return;
    const timer = window.setTimeout(() => setAppNotice(null), 4000);
    return () => window.clearTimeout(timer);
  }, [appNotice]);
  const [aiReady, setAiReady] = useState(false);
  const [aiRequiredOpen, setAiRequiredOpen] = useState(false);
  const [syncInterval, setSyncInterval] = useState<SyncIntervalMinutes | null>(null);
  const [syncIntervalUnsaved, setSyncIntervalUnsaved] = useState(false);
  // 成功确认的当前档位 / 最后一次用户意图：迟到写入据此补发，保证最终落库是最新值。
  const syncIntervalConfirmedRef = useRef<SyncIntervalMinutes>(240);
  const syncIntervalTargetRef = useRef<SyncIntervalMinutes>(240);
  // 账户代次：登出/登录/换号时递增；同步的迟到结果据此丢弃。
  const [accountEpoch, setAccountEpoch] = useState(0);
  // 读/写的迟到响应不能覆盖用户刚选的档位：只认最新一次写入。
  const syncIntervalTouchedRef = useRef(false);
  const syncIntervalWriteSeqRef = useRef(0);
  // 当前服务商的显示名；未配置或读取失败时为空，由助手头部决定回退文案。
  const [aiProviderName, setAiProviderName] = useState<string | null>(null);
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [onboardingLoaded, setOnboardingLoaded] = useState(false);
  const [hasEverConnected, setHasEverConnected] = useState(readEverConnected);
  const [panelOpen, setPanelOpen] = useState(readInitialPanelOpen);
  // destination 决定左栏与中间区：客户端是配置列表 + 控制台，服务器是服务器列表 + 选中那台。
  // 冷启动一律落在连接页：不恢复上次停留，避免服务器页在未登录/零台时变成死胡同。
  const [destination, setDestination] = useState<Destination>("client");
  const changeDestination = (next: Destination) => {
    // 向导打开时切到另一侧：创建在途不切；否则先关向导并丢弃未提交的选择。
    if (next !== destinationRef.current && newNodeOpenRef.current) {
      if (newNodeBusyRef.current) return;
      setNewNodeOpen(false);
      setStageSelect(null);
      setNewNodeSelection({ region: null, plan: null });
    }
    setDestination(next);
  };
  /** 新建节点沿用入口所在的宿主：servers 留在服务器页，其余留在连接侧。 */
  const openNewNode = (origin: "client" | "servers" | "trial_expired") => {
    // 建机属于服务器账号：账号读到且未登录时直接弹登录，不打开向导。
    if (
      myServers.accountLoaded &&
      !myServers.loggedIn &&
      !myServers.accountError
    ) {
      myServers.openLogin();
      return;
    }
    setNewNodeOpen(true);
    setDestination(origin === "servers" ? "servers" : "client");
  };
  /** 关闭向导（返回 / Esc）：两个宿主都从未离开；清掉 AI 待选结果。 */
  const closeNewNode = () => {
    setNewNodeOpen(false);
    setStageSelect(null);
  };
  // 再点一次已激活的「我的服务器」图标：回到列表根（默认第一台）。
  const [serversRootSignal, setServersRootSignal] = useState(0);
  const [accountMenu, setAccountMenu] = useState<"nav" | null>(null);
  const myServers = useMyServers(bridge, {
    active: destination === "servers",
    rootSignal: serversRootSignal,
  });
  /**
   * 左栏快捷行：已登录（邮箱账户且会话未过期）、列表可读、且至少一台服务器节点已就绪。
   * 设备身份按未登录处理，不给「在手机上使用」（login-and-payment.md §11.3）。
   */
  const showRailMobileExport =
    myServers.loggedIn &&
    !myServers.loading &&
    !myServers.error &&
    hasReadyServer(myServers.servers);
  /**
   * 进入「我的服务器」时主动拉一次列表：后台轮询没了，空闲时左栏不会自己长出墓碑。
   * 同一 destination 连点只算一次（1 秒内去重），也不做定时轮询。
   */
  const serversEnteredAtRef = useRef(0);
  const refreshServersOnce = useCallback(() => {
    const now = Date.now();
    if (now - serversEnteredAtRef.current < 1000) return;
    serversEnteredAtRef.current = now;
    void myServers.refresh();
  }, [myServers.refresh]);
  useEffect(() => {
    if (destination === "servers") refreshServersOnce();
  }, [destination, refreshServersOnce]);

  const serverSync = useServerSync({
    bridge,
    intervalMinutes: syncInterval,
    enabled: myServers.loggedIn,
    accountEpoch,
    applyServers: (servers) => myServers.applyServers(servers),
    onChanged: (changed) => {
      if (changed.length === 1) {
        setAppNotice({
          level: "info",
          text: translate("app.sync.updatedOne", { name: changed[0].name }),
        });
      } else if (changed.length > 1) {
        setAppNotice({
          level: "info",
          text: translate("app.sync.updatedMany", { count: changed.length }),
        });
      }
    },
  });
  /** 账号菜单同一时刻只开一个：导航头像或左栏账号行。 */
  const userLogoutRef = useRef(false);
  const wasLoggedInRef = useRef(false);

  // 登出 / 登录 / 换号都推进账户代次，让在途同步的迟到结果作废。
  const accountIdentityRef = useRef<{
    loggedIn: boolean;
    id: string | null;
  } | null>(null);
  useEffect(() => {
    // 账户还没读回时不建立基线：首次读回不是「登录事件」，不该推进 epoch。
    if (!myServers.accountLoaded) return;
    const next = {
      loggedIn: myServers.loggedIn,
      id: myServers.account?.account_id ?? null,
    };
    const prev = accountIdentityRef.current;
    accountIdentityRef.current = next;
    if (
      prev &&
      (prev.loggedIn !== next.loggedIn || prev.id !== next.id)
    ) {
      setAccountEpoch((value) => value + 1);
    }
  }, [
    myServers.accountLoaded,
    myServers.loggedIn,
    myServers.account?.account_id,
  ]);
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
      text: translate("app.billsNotice"),
    });
  }, [myServers.loggedIn, myServers.loginOpen]);

  // 账号菜单：登出后收起。
  useEffect(() => {
    if (!myServers.loggedIn) setAccountMenu(null);
  }, [myServers.loggedIn]);
  // 登录过期：用户主动退出时不提示，其余掉线给一次 toast。
  useEffect(() => {
    const was = wasLoggedInRef.current;
    wasLoggedInRef.current = myServers.loggedIn;
    if (!was || myServers.loggedIn) return;
    if (userLogoutRef.current) {
      // 主动退出：操作方负责「已退出登录」；这里消费标志，不再报过期。
      userLogoutRef.current = false;
      return;
    }
    setAppNotice({ level: "info", text: translate("app.loginExpired") });
  }, [myServers.loggedIn]);
  /** 最近一次用户操作，随下一条消息的 context 上报。 */
  const lastActionRef = useRef<UiLastAction | null>(null);
  /** 节点诊断面板：deps 在打开时由 App 统一构造，关闭即丢弃。 */
  const [diagnosis, setDiagnosis] = useState<{
    nodeName: string;
    deps: DiagnosisDeps;
  } | null>(null);
  const [appVersion, setAppVersion] = useState("");
  useEffect(() => {
    let cancelled = false;
    void bridge
      .getAppVersion()
      .then((version) => {
        if (!cancelled) setAppVersion(version);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [bridge]);
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
  /** 提问与发起它的屏幕绑定：离开那一屏只折叠，不在别处提交答案。 */
  const [questionOrigins, setQuestionOrigins] = useState<Record<string, UiScreen>>({});
  /** 内联提问已过期：卡片留在原位显示「这个问题已过期。」，选项禁用。 */
  const [expiredQuestions, setExpiredQuestions] = useState<Set<string>>(
    () => new Set(),
  );
  /** 免费节点步骤流进行中：挡住重复点击。 */
  const [trialBusy, setTrialBusy] = useState(false);
  const trialBusyRef = useRef(false);
  /** 免费节点步骤流：拉取 → 加入 → 测速，全部挂在真实调用上。 */
  const [trialFlow, setTrialFlow] = useState<TrialFlow | null>(null);
  const trialFlowRef = useRef<TrialFlow | null>(null);
  const trialProbeStartedRef = useRef(false);
  /** 试用步骤流完成时的一次性预选：只在那一刻算最快，之后任何测速都不再推导。 */
  const [trialPreselect, setTrialPreselect] = useState<{
    configId: string;
    nodeId: string;
    nonce: number;
    /** 只有试用流程标的「最快」才算数；从服务器详情过来不标。 */
    markFastest?: boolean;
  } | null>(null);
  const trialPreselectNonceRef = useRef(0);
  /** 本次会话手动测过速的配置：收尾句去掉数字。 */
  const [manualProbedConfigs, setManualProbedConfigs] = useState<Set<string>>(
    () => new Set(),
  );
  /** 舞台的测速入口当前是否可点：不可点时从 context 里剔除。 */
  const probeControlHiddenRef = useRef(false);
  /** 免费节点试用状态；过期后只留「新建节点」。 */
  const [trial, setTrial] = useState<TrialStatusData | null>(null);
  const [trialLoaded, setTrialLoaded] = useState(false);
  /** 从两选一 / 到期屏进入「新建节点」舞台。 */
  const [newNodeOpen, setNewNodeOpen] = useState(false);
  /** 创建在途：导航禁用、Esc 与返回都不可用。 */
  const [newNodeBusy, setNewNodeBusy] = useState(false);
  /** 新建节点舞台上次选的地区/规格；返回后再进来要恢复。 */
  const [newNodeSelection, setNewNodeSelection] = useState<{
    region: string | null;
    plan: string | null;
  }>({ region: null, plan: null });
  /** AI 选好的地区 / 规格；交给新建节点舞台应用。 */
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
    if (newNodeOpen) return;
    newNodeBusyRef.current = false;
    setNewNodeBusy(false);
  }, [newNodeOpen]);
  useEffect(() => {
    if (!newNodeOpen) return;
    // Esc 与「返回」相同；登录弹窗在最上层时只关弹窗，一次按键只解一层。
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (myServers.loginOpen || newNodeBusyRef.current) return;
      closeNewNode();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [newNodeOpen, myServers.loginOpen]);
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
  // 就绪的服务器静默进全局池：详情页不再有连接入口，没人取凭据了。
  useServerNodePooling({
    servers: myServers.servers,
    connection: vpn.connection,
    credentials: (serverId) => bridge.myServerCredentials(serverId),
    attach: (nodeIds) => vpn.attachNodes({ nodeIds }),
  });
  const nodeProbes = useNodeProbes({ bridge });
  // 进入连接屏先读缓存，再把整池测一次速；每个配置只自动跑一次。
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
      // 当前节点也要测：未连接时没有运行时延迟，跳过它会让选中行一直显示「—」。
      void nodeProbes.start(config.config_id, nodeIds);
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
  /** 首启开场只发一次：onDone 可能被重复触发。 */
  const kickoffSentRef = useRef(false);
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
  // 全局只有一个节点池：只认全局配置里的节点，不再看隐藏的其它配置。
  const hasNodes = Boolean(
    vpn.activeConfig && vpn.activeConfig.node_count > 0,
  );
  // 与 Host 的 runtime_is_live（server_watch::state_is_live）同一口径：
  // 隧道还在跑（含启动中）时，即使节点已被删光也要留在连接页——否则用户
  // 手上连一个「断开」都没有，只能退出 App。
  const runtimeLive =
    runtime.state === "running" ||
    runtime.state === "degraded" ||
    runtime.state === "starting" ||
    runtime.state === "restarting";
  const showsStage = hasNodes || runtimeLive;
  // 已就绪的服务器节点要等断开才 node_attach（见 useServerNodePooling 的 flush 排队），
  // 这段时间它在配置里不存在；单独算出来交给连接页灰显，免得用户以为没生效。
  const pendingServerNodes = useMemo(() => {
    const configured = new Set(
      (vpn.activeConfig?.nodes ?? []).map((node) => node.node_id),
    );
    return collectPendingServerNodes(myServers.servers, configured);
  }, [myServers.servers, vpn.activeConfig]);

  // 停机删除的服务器留下的节点：连接页只留一行灰的，不能选、不能测速。
  const danglingNodeIds = useMemo(
    () =>
      collectDanglingNodeIds(
        myServers.servers,
        (vpn.activeConfig?.nodes ?? []).map((node) => node.node_id),
      ),
    [myServers.servers, vpn.activeConfig],
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
        : trial?.state === "expired" && !showsStage
          ? "trial_expired"
          : !showsStage
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
      ? t("app.label.connecting")
      : online
        ? t("console.primary.disconnect")
        : runtime.state === "failed"
          ? t("console.primary.reconnect")
          : t("console.primary.connect");
    const nodes = vpn.activeConfig?.nodes ?? [];
    const currentNodeIndex = nodes.findIndex(
      (node) => node.node_id === vpn.activeConfig?.current_node_id,
    );
    if (currentNodeIndex >= 0) {
      // 模型看到的控件文案要和舞台一致：同样走「国家 + 序号」。
      uiLabels["client.node_pick"] = displayNodeNames(nodes)[currentNodeIndex];
    }
  }
  if (uiScreen === "new_node") {
    uiLabels["new_node.create"] = t("app.label.create");
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
            text: translate("app.proxyRestored"),
          });
        } else if (report.recovery?.status === "failed") {
          setAppNotice({
            level: "error",
            text: translate("app.proxyRestoreFailed"),
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
      const providers = await bridge.llmProviderList().catch(() => null);
      const ready = isAiReady({ providers });
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
        showOnboarding: shouldShowOnboarding(
          { providers },
          readFlag(ONBOARDING_SKIPPED_KEY),
        ),
      };
    },
    [bridge, maybeAutoOpenPanel],
  );

  /** 所有「点一下让 AI 干活」的入口共用：未配置就弹告警，不做任何动作。 */
  const requireAi = (): boolean => {
    if (aiConfiguredRef.current) return true;
    setAiRequiredOpen(true);
    return false;
  };

  useEffect(() => {
    panelOpenRef.current = panelOpen;
  }, [panelOpen]);

  const importPath = useCallback(
    async (path: string) => {
      if (!/\.json$/i.test(path)) {
        setAppNotice({
          level: "error",
          text: translate("app.importJsonOnly"),
        });
        return;
      }
      if (importingRef.current) return;

      importingRef.current = true;
      try {
        const result = await bridge.importSeedFile(path);
        setAppNotice({
          level: "info",
          text: translate("app.imported", { count: result.imported }),
        });
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
            text: translate("app.dropOneFile", { count: payload.paths.length }),
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
      if (event.name === AGENT_EVENTS.stageSelect) {
        // 只改舞台选择；舞台没开或正在创建时忽略（契约允许的已知残余）。
        // 两个宿主的 screen 都是 new_node，不按 destination 区分。
        if (!newNodeOpenRef.current || newNodeBusyRef.current) {
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
      if (event.name === AGENT_EVENTS.nodeListChanged) {
        // 两边都用本地节点 id（nd_…）；拿 server_id 比会永远不命中。
        const stale = staleConfigNodeId(event.payload, runtimeRef.current);
        if (stale !== null) setStaleConfigNode(stale);
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
            defaultIndex: detail.defaultIndex,
            upgradeConfirm: detail.upgradeConfirm,
            configSetModeConfirm: detail.configSetModeConfirm,
            issueSubmitConfirm: detail.issueSubmitConfirm,
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

  // 节点配置同步间隔：启动读一次；读失败重试一次，仍失败按 240（不写库）。
  useEffect(() => {
    let cancelled = false;
    const load = (attempt: number): void => {
      void bridge
        .serverSyncIntervalGet()
        .then((data) => {
          if (cancelled || syncIntervalTouchedRef.current) return;
          syncIntervalConfirmedRef.current = data.minutes;
          syncIntervalTargetRef.current = data.minutes;
          setSyncInterval(data.minutes);
        })
        .catch(() => {
          if (cancelled || syncIntervalTouchedRef.current) return;
          if (attempt === 0) {
            load(1);
            return;
          }
          syncIntervalConfirmedRef.current = 240;
          syncIntervalTargetRef.current = 240;
          setSyncInterval(240);
        });
    };
    load(0);
    return () => {
      cancelled = true;
    };
  }, [bridge]);

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

  /**
   * 首启开场：打开右栏，把 Host 给的开场提示词当 hidden 消息发出去，
   * AI 的第一句就是它自己的话。命令缺失 / 空文本 / AI 未就绪都只开面板。
   */
  const startKickoff = async () => {
    if (kickoffSentRef.current) return;
    kickoffSentRef.current = true;
    panelOpenRef.current = true;
    setPanelOpen(true);
    setAiUnread(false);
    // 开场词的前提是「还没有任何配置」：删掉 AI 服务后重进首启时，
    // 用户可能已经有节点 / 服务器，不能再发一句「还没有可用的节点」。
    if (vpn.configs.length > 0) return;
    if (!aiConfiguredRef.current) return;
    const source = (bridge as AgentBridge & {
      aiSessionKickoff?: () => Promise<{ text: string }>;
    }).aiSessionKickoff;
    if (typeof source !== "function") return;
    let text = "";
    try {
      const raw = await source.call(bridge);
      text = typeof raw?.text === "string" ? raw.text.trim() : "";
    } catch {
      // Host 还没接这条命令：只开面板，不打扰用户。
      return;
    }
    if (!text) return;
    const fresh = createSession();
    dispatch({ type: "add_session", session: fresh });
    await sendToSession(fresh.id, text, { hidden: true });
  };

  const completeOnboarding = async () => {
    setShowOnboarding(false);
    setOnboardingLoaded(true);
    await Promise.all([refreshDefaultProfile(), refreshAiStatus()]);
    void startKickoff();
  };

  const finishOnboarding = () => {
    void completeOnboarding();
  };

  // 跳过 AI：只记「别再弹首启」，不展开右栏，也不发开场词。
  const skipOnboarding = () => {
    writeFlag(ONBOARDING_SKIPPED_KEY);
    setShowOnboarding(false);
    setOnboardingLoaded(true);
    void Promise.all([refreshDefaultProfile(), refreshAiStatus()]);
  };

  const closeSettings = () => {
    setSettingsOpen(false);
    setSettingsConsulting(false);
    void refreshAiStatus();
  };

  const changeSyncInterval = (minutes: SyncIntervalMinutes) => {
    syncIntervalTouchedRef.current = true;
    syncIntervalTargetRef.current = minutes;
    const previous = syncInterval;
    const seq = ++syncIntervalWriteSeqRef.current;
    void bridge
      .serverSyncIntervalSet(minutes)
      .then((data) => {
        // 只回写仍是当前档位的那次写入。
        if (seq === syncIntervalWriteSeqRef.current) {
          syncIntervalConfirmedRef.current = data.minutes;
          syncIntervalTargetRef.current = data.minutes;
          setSyncInterval(data.minutes);
          setSyncIntervalUnsaved(false);
          return;
        }
        // 旧写入迟到：界面不动，但把用户最新意图补发一次，保证最终落库是新档。
        const target = syncIntervalTargetRef.current;
        void bridge
          .serverSyncIntervalSet(target)
          .catch(() => {
            console.warn("[server-sync] resend failed", { minutes: target });
            uiLog(
              "warn",
              `server sync resend failed minutes=${target}`,
              "servers",
            );
          });
      })
      .catch(() => {
        if (seq !== syncIntervalWriteSeqRef.current) return;
        // 写库失败：回退到上一个有效值；首次设置失败则按 240。
        const fallback = previous ?? syncIntervalConfirmedRef.current ?? 240;
        syncIntervalTargetRef.current = fallback;
        setSyncInterval(fallback);
        setSyncIntervalUnsaved(true);
        setAppNotice({
          level: "error",
          text: translate("app.sync.intervalFailed"),
        });
      });
  };

  const openMobileExport = (trigger: HTMLElement) => {
    mobileExportTriggerRef.current = trigger;
    setMobileExportOpen(true);
  };
  const closeMobileExport = (returnFocus = true) => {
    setMobileExportOpen(false);
    if (!returnFocus) return;
    // 设置在弹层关闭后重新接管焦点陷阱（会先把焦点放到自己的 ×）：
    // 等这一轮提交结束后再把焦点还给触发行。
    window.setTimeout(() => mobileExportReturnFocus()?.focus(), 0);
  };
  /** 关闭后焦点：触发行还在就回它；左栏行已消失时回左栏标题行的 ＋。 */
  const mobileExportReturnFocus = () => {
    const trigger = mobileExportTriggerRef.current;
    if (trigger?.isConnected) return trigger;
    return (
      document.querySelector<HTMLElement>("#config-rail .rail__add") ??
      document.querySelector<HTMLElement>("#config-rail .rail__drawer-btn")
    );
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
          quitBusyRef.current = false;
          setQuitBusy(false);
          setQuitError(errorText(failure, translate("app.quitDeliverFailed")));
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
      return { ok: false, message: translate("app.deleteBusy") };
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
        return { ok: false, message: translate("app.deleteActive") };
      }
      // 这条匹配的是 Tauri 未注册命令时的字符串错误，不是我们的错误信封。
      if (/not found|unknown command/i.test(bridgeError.message)) {
        return { ok: false, message: translate("app.deleteUnsupported") };
      }
      return {
        ok: false,
        message: errorText(bridgeError, translate("app.deleteFailed")),
      };
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
        return { ok: false, removed: true, message: translate("app.sessionGone") };
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
      text: waiting ? translate("app.busyAnswer") : translate("app.busyReplying"),
    });
  };

  const sendToSession = async (
    sessionId: string,
    text: string | undefined,
    options: { hidden?: boolean; lastAction?: UiLastAction } = {},
  ): Promise<boolean> => {
    if (!requireAi()) return false;
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
        omitControls: probeControlHiddenRef.current ? ["client.probe"] : undefined,
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
        message: errorText(bridgeError, translate("app.sendFailed")),
      });
      return true;
    }
  };

  // 三处入口共用：打开右栏 + 新建会话 + 契约里的开场指令（hidden，不落用户气泡）。
  const handleReportProblem = () => {
    if (!requireAi() || reportOpeningRef.current) return;
    reportOpeningRef.current = true;
    setReportOpening(true);
    setSettingsOpen(false);
    const fresh = { ...createSession(), report: true };
    dispatch({ type: "add_session", session: fresh });
    panelOpenRef.current = true;
    setPanelOpen(true);
    setAiUnread(false);
    void sendToSession(fresh.id, issueReportOpening(), { hidden: true }).finally(() => {
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
          message: translate("app.displayMailCopyOnly"),
          copyBody: result.body ?? undefined,
        };
      }
      return {
        message:
          action.kind === "compose_report_mail"
            ? translate("app.displayMailFailed")
            : translate("app.displayRevealFailed"),
      };
    } catch (error: unknown) {
      const failure = toBridgeError(error);
      return {
        message:
          failure.code === "NOT_FOUND"
            ? translate("app.displayNotFound")
            : errorText(failure, translate("tool.action.openFailed")),
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
    if (!requireAi()) return;
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
    const args =
      Object.keys(action.args).length > 0
        ? translate("app.nextActionArgs", { args: JSON.stringify(action.args) })
        : "";
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
        text:
          result.detail ||
          (result.ok
            ? translate("app.netRestored")
            : translate("app.netRestoreFailed")),
      });
      refreshSnapshot();
    } catch (error) {
      setAppNotice({
        level: "error",
        text: describeCommandError(error, translate("app.action.restoreNetwork")),
      });
    } finally {
      setRepairing(false);
    }
  };

  const handleOpenLogs = () => {
    void bridge.openLogDir().catch((error: unknown) => {
      setAppNotice({
        level: "error",
        text: describeCommandError(error, translate("app.action.openLogs")),
      });
    });
  };

  const currentQuestion = session
    ? pendingQuestions.find((item) => item.sessionId === session.id) ?? null
    : null;

  // 第一次看到这个问题时记下屏幕；之后切走再回来不重记。
  useEffect(() => {
    const questionId = currentQuestion?.questionId;
    if (!questionId) return;
    setQuestionOrigins((current) =>
      current[questionId] ? current : { ...current, [questionId]: uiScreen },
    );
  }, [currentQuestion?.questionId, uiScreen]);

  const questionOrigin = currentQuestion
    ? questionOrigins[currentQuestion.questionId] ?? uiScreen
    : null;
  // 离开发起提问的屏幕：卡片折叠成一行只读提示，那里不能提交答案。
  const questionAway = Boolean(questionOrigin && questionOrigin !== uiScreen);
  const questionExpired = currentQuestion
    ? expiredQuestions.has(currentQuestion.questionId)
    : false;

  const returnToQuestion = () => {
    if (!questionOrigin) return;
    if (questionOrigin === "settings") {
      setSettingsOpen(true);
      return;
    }
    setSettingsOpen(false);
    if (questionOrigin === "new_node") {
      openNewNode("client");
      return;
    }
    setNewNodeOpen(false);
    changeDestination(questionOrigin === "servers" ? "servers" : "client");
  };

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

  // 内联卡片到期：卡片留在原位显示已过期，不再可答；后端照旧回空串解开。
  const handleInlineQuestionExpired = () => {
    if (!currentQuestion) return;
    const { sessionId, questionId } = currentQuestion;
    markQuestionSettled(questionId);
    setExpiredQuestions((current) => {
      if (current.has(questionId)) return current;
      const next = new Set(current);
      next.add(questionId);
      return next;
    });
    void bridge.replyUserQuestion(sessionId, questionId, "").catch(() => undefined);
  };

  const handleAnswerQuestion = async (answer: string): Promise<boolean> => {
    // 离屏或已过期时界面不提供答案入口；这里再挡一次，避免答案带上错的 screen。
    // 确认弹窗是模态：切屏不该让它卡在提交中，放宽离屏/过期拦截。
    if (!currentQuestion) return false;
    if (
      !isConfirmQuestionKind(currentQuestion.kind) &&
      (questionAway || questionExpired)
    ) {
      return false;
    }
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
        text: describeCommandError(error, translate("app.action.answer")),
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
    if (!config) return { ok: false, message: translate("app.needConfig") };
    try {
      const result = await bridge.routeSetMode(mode, config.config_id);
      setRoutingOverride({ configId: config.config_id, mode: result.routing_mode });
      // 热切不会断流；只有重连失败时才需要把 hero 切到失败态。
      if (result.reconnect === "reconnect_failed") refreshSnapshot();
      return { ok: true };
    } catch {
      // 行内说一次，不弹 toast；控件保持原值。
      return { ok: false, message: translate("stage.scopeFail") };
    }
  };

  const handleSetConnectMode = async (
    mode: ConfigConnectMode,
    options?: { onRestoring?: () => void },
  ): Promise<{
    ok: boolean;
    restored: boolean | null;
    actualMode: ConfigConnectMode | null;
    message?: string;
  }> => {
    const config = vpn.activeConfig;
    if (!config) {
      return {
        ok: false,
        restored: null,
        actualMode: null,
        message: translate("app.needConfig"),
      };
    }
    try {
      await bridge.configSetMode({ configId: config.config_id, mode });
      vpn.reload();
      return { ok: true, restored: true, actualMode: mode };
    } catch (error) {
      const bridgeError = toBridgeError(error);
      const restoredRaw = bridgeError.details?.restored;
      const restored = typeof restoredRaw === "boolean" ? restoredRaw : null;
      // 只有可能已回滚时才显示「正在恢复…」；回滚失败没有恢复过程。
      if (restored !== false) options?.onRestoring?.();
      let actualMode: ConfigConnectMode | null = null;
      try {
        actualMode = (await bridge.configDetail(config.config_id)).connect_mode;
      } catch {
        // 读不到就保持旧值；下一次 reload 会再对齐。
      }
      vpn.reload();
      return {
        ok: false,
        restored,
        actualMode,
        message: errorText(bridgeError, translate("app.modeSwitchFailed")),
      };
    }
  };

  const handleVpnStart = (): Promise<boolean> => {
    lastActionRef.current = { id: "client.primary" };
    stoppingRef.current = false;
    return vpn.start().then((result) => {
      if (!result.ok && isHelperPermissionReason(result.reason)) {
        setHelperGuideOpen(true);
        return false;
      }
      showActionResult(result, translate("app.startFailed"));
      if (!result.connected) return result.ok;
      // start 成功说明后端已经连上。事件/快照可能还停在 starting 或 failed，
      // 不校正的话中间区会继续显示未连接/失败。先按在线显示，再拉快照补细节。
      setFailedAfterConnected(false);
      // 权威先落，再刷新：否则滞后快照会把这个结果盖回去。
      runtimeAuthorityRef.current.markLocal("running");
      setRuntime((view) => viewAfterConnected(view));
      refreshSnapshot();
      // 试用从第一次连上开始算：连接成功后重读一次状态。
      setTrialNonce((value) => value + 1);
      return result.ok;
    });
  };

  /** 连接页「重新连接并测试」：等重连真正完成后再测，避免拿旧配置探测。 */
  const handleReconnectAndTest = async (): Promise<boolean> => {
    const stopped = await handleVpnStop();
    if (!stopped) return false;
    return handleVpnStart();
  };

  const handleVpnStop = (): Promise<boolean> => {
    lastActionRef.current = { id: "client.primary" };
    // 记下点断开这一刻是不是已连接：断开失败时只有原本在线才恢复在线。
    const wasConnected = runtime.state === "running" || runtime.state === "degraded";
    stoppingRef.current = true;
    return vpn.stop().then(
      (result) => {
        showActionResult(result, translate("app.stopFailed"));
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

  const openAssistant = () => {
    panelOpenRef.current = true;
    setPanelOpen(true);
    setAiUnread(false);
  };

  // 「新建节点」暂由 AI 接手：打开右栏并给输入框焦点，后续流程下一阶段接。
  const handleAskAiFromConsole = () => {
    openAssistant();
    setComposerFocusSignal((value) => value + 1);
  };

  // 三个「问 AI」入口共用：连接页两个 chip、设置页「咨询 AI」、新建节点向导的「让 AI 帮我选」。
  // 未配置时先弹告警；面板保持收起，取消后不留痕迹。返回 false = 被拦下。
  const askAiInPanel = (prompt: string): boolean => {
    if (!requireAi()) return false;
    openAssistant();
    handleAskAi(prompt);
    return true;
  };

  const handleSwitchNode = (nodeId: string) => {
    lastActionRef.current = { id: "client.node_pick", value: nodeId };
    return vpn.switchNode(nodeId);
  };

  /** 移除自定义节点：Host 先停当前隧道，成功后列表随 node-list-changed 重拉。 */
  const handleRemoveNode = async (
    nodeId: string,
  ): Promise<{ ok: boolean; message?: string; wasCurrent?: boolean }> => {
    lastActionRef.current = { id: "client.node_remove", value: nodeId };
    try {
      const result = await bridge.nodeRemove({ nodeId });
      // 事件会刷新列表；这里再拉一次，保证 demo / 事件迟到时也不留旧行。
      void vpn.reload();
      return { ok: true, wasCurrent: result.wasCurrent };
    } catch (error) {
      return {
        ok: false,
        message: errorText(error, translate("console.node.removeFailed")),
      };
    }
  };

  /** 打开「添加节点」：先清掉编辑态，避免复用上一次的节点。 */
  const openAddNode = () => {
    setEditingNode(null);
    setNodeImportOpen(true);
  };

  /** 编辑自定义节点：订阅节点只改名，手动节点可改连接参数。 */
  const handleEditNode = (node: NodeSummary) => {
    setEditingNode(node);
    setNodeImportOpen(true);
  };

  // 连接页行内「问 AI」（非自有节点）：只发固定提示，不做修复。
  const handleAskAiAboutNode = (_nodeId: string, prompt: string) => {
    askAiInPanel(prompt);
  };

  /** 诊断只对服务正常且已开通的自有服务器出现；到期 / 停机不给入口。 */
  const diagnosisEligibleServer = (server: MyServer): boolean =>
    (server.state === "healthy" || server.state === "active") &&
    server.billing_state !== "past_due" &&
    server.billing_state !== "expired";

  /** 交给诊断清单的平台名（不含任何设备标识）。 */
  const platformName = (): string =>
    typeof navigator !== "undefined" && /Win/i.test(navigator.userAgent)
      ? "windows"
      : typeof navigator !== "undefined" && /Linux/i.test(navigator.userAgent)
        ? "linux"
        : "macos";

  /** 自有节点测不通 / 服务器详情「智能诊断」：构造依赖并打开诊断面板。 */
  const handleAnalyzeNode = (target: {
    serverId: string;
    nodeName: string;
  }) => {
    const server = myServers.servers.find(
      (item) => item.server_id === target.serverId,
    );
    if (!server || !diagnosisEligibleServer(server)) return;
    const localNodeId = server.local_node_id;
    const configNode = localNodeId
      ? (vpn.activeConfig?.nodes.find(
          (node) => node.node_id === localNodeId,
        ) ?? null)
      : null;
    const initialPort = configNode?.port ?? server.port ?? null;
    const platform = platformName();
    const facts: DiagnosisFacts = {
      serverId: server.server_id,
      region: server.region,
      createdAt: server.created_at,
      state: server.state,
      localNodeId,
      port: initialPort,
      nodeInUse:
        localNodeId !== null &&
        (runtime.node_id === localNodeId ||
          vpn.activeConfig?.current_node_id === localNodeId),
      appVersion,
      platform,
      uiLogPath: null,
      controlPlaneError: myServers.error,
    };
    /** 本次诊断的关联短码，由面板在开始时回传，供探测/等待日志复用。 */
    let runCode: string | null = null;
    /** 最近一次 untested 的 Host 原因，供面板显示人话。 */
    let probeUntestedReason: string | null = null;
    const probeNodeDetail = async (): Promise<ConnectionRetest> => {
      probeUntestedReason = null;
      if (!localNodeId) {
        probeUntestedReason = "no_local_node";
        uiLog(
          "warn",
          `diagnosis run=${runCode ?? "none"} probe status=none reason=no_local_node`,
          "node-diagnosis",
        );
        return { reachable: null, reason: "no_local_node", latencyMs: null };
      }
      try {
        const result = await bridge.nodeProbe(localNodeId);
        nodeProbes.recordResults([result]);
        if (result.status === "untested") {
          // untested = 没测成（connection_busy / node_not_in_config / node_not_in_running_config / clash_unavailable），不是不通。
          probeUntestedReason =
            result.error?.reason ?? result.error?.code ?? null;
          uiLog(
            "warn",
            `diagnosis run=${runCode ?? "none"} probe node=${localNodeId} status=untested reason=${probeUntestedReason ?? "none"}`,
            "node-diagnosis",
          );
          return {
            reachable: null,
            reason: probeUntestedReason,
            latencyMs: null,
          };
        }
        if (result.reachable !== true) {
          uiLog(
            "warn",
            `diagnosis run=${runCode ?? "none"} probe node=${localNodeId} status=${result.status} reason=${result.error?.reason ?? result.error?.code ?? "none"}`,
            "node-diagnosis",
          );
          return {
            reachable: false,
            reason: result.error?.reason ?? result.error?.code ?? null,
            latencyMs: result.latency_ms,
          };
        }
        return { reachable: true, reason: null, latencyMs: result.latency_ms };
      } catch (error) {
        // 命令本身没跑成：不知道通不通，按「没测成」处理。
        const reason = toBridgeError(error).code || "throw";
        uiLog(
          "warn",
          `diagnosis run=${runCode ?? "none"} probe node=${localNodeId} status=none reason=${reason}`,
          "node-diagnosis",
        );
        return { reachable: null, reason, latencyMs: null };
      }
    };
    const probeNode = async (): Promise<ProbeOutcome> =>
      (await probeNodeDetail()).reachable;
    const isRuntimeUp = () => {
      const state = runtimeRef.current.state;
      return state === "running" || state === "degraded";
    };
    const isThisTunnelUp = () =>
      isRuntimeUp() &&
      localNodeId !== null &&
      runtimeRef.current.node_id === localNodeId;
    /** stop → start 返回 ok 不等于运行时已就绪：轮询快照，别在 starting 上测。 */
    const waitForRuntimeReady = async (): Promise<boolean> => {
      const startedAt = Date.now();
      const deadline = startedAt + 20_000;
      while (Date.now() < deadline) {
        try {
          const snapshot = await bridge.getRuntimeSnapshot();
          if (
            snapshot?.state === "running" ||
            snapshot?.state === "degraded"
          ) {
            // 只认跑在目标节点上的运行时：切到别的节点不算就绪。
            if (
              localNodeId !== null &&
              snapshot.node_id !== null &&
              snapshot.node_id !== localNodeId
            ) {
              await new Promise((resolve) => setTimeout(resolve, 500));
              continue;
            }
            uiLog(
              "info",
              `diagnosis run=${runCode ?? "none"} reconnect ready ms=${Date.now() - startedAt}`,
              "node-diagnosis",
            );
            return true;
          }
          if (snapshot?.state === "failed") return false;
        } catch {
          // 快照读不到就继续等到上限。
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      uiLog(
        "warn",
        `diagnosis run=${runCode ?? "none"} reconnect timeout ms=${Date.now() - startedAt}`,
        "node-diagnosis",
      );
      return false;
    };
    const deps: DiagnosisDeps = {
      facts,
      isTunnelRunning: isThisTunnelUp,
      isRuntimeRunning: isRuntimeUp,
      probeReachability: async () => {
        if (!server.ip) {
          throw {
            code: "INVALID_ARGUMENT",
            message: "",
            retryable: false,
            details: { reason: "invalid_ip" },
          };
        }
        return bridge.nodeProbeReachability(server.ip, 32100);
      },
      syncConfig: async () => {
        // 同步前现读本地配置里的端口做基准：面板打开时的快照可能已经过期。
        let baseline = initialPort;
        const configId = vpn.activeConfig?.config_id;
        if (configId && localNodeId) {
          try {
            const detail = await bridge.configDetail(configId);
            baseline =
              detail.nodes.find((node) => node.node_id === localNodeId)?.port ??
              initialPort;
          } catch {
            // 读不到当前配置就退回打开面板时的端口。
          }
        }
        // 单台凭据，只比端口；请求失败原样抛给 hook，按控制面不可达处理。
        const node = await bridge.myServerCredentials(server.server_id);
        vpn.reload();
        void myServers.refresh();
        return {
          changed: baseline === null || node.port !== baseline,
          port: node.port,
        };
      },
      reprobe: probeNode,
      probeProxy: probeNodeDetail,
      probeUntestedReason: () => probeUntestedReason,
      reconnectAndProbe: async (): Promise<ReconnectOutcome> => {
        const connected = await handleReconnectAndTest();
        if (!connected) return "reconnect-failed";
        const ready = await waitForRuntimeReady();
        if (!ready) return "reconnect-failed";
        const probed = await probeNode();
        if (probed === null) return "probe-untested";
        return probed ? "ok" : "probe-failed";
      },
      rotateCredentials: async () => {
        try {
          const result = await rotateNodeCredentials(bridge, server.server_id);
          vpn.reload();
          void myServers.refresh();
          return { ok: true as const, port: result.port };
        } catch (error) {
          return {
            ok: false as const,
            reason: rotateFailureReason(error) ?? "unknown",
          };
        }
      },
      openAi: (context) => {
        const handed = askAiInPanel(nodeDiagnosisAsk(context));
        if (handed) setDiagnosis(null);
        return handed;
      },
      onGoToServers: () => {
        setDiagnosis(null);
        changeDestination("servers");
        myServers.select(server.server_id);
      },
      onRunStart: (run) => {
        runCode = run;
      },
    };
    setDiagnosis({ nodeName: target.nodeName || server.name, deps });
  };

  /**
   * 连接失败「智能诊断」：自动只跑连通性 + 本地运行态/配置；
   * 定位不到才把清单交给 AI（node-diagnosis-flow.md §10）。
   */
  const handleDiagnoseConnection = () => {
    const config = vpn.activeConfig;
    const runtimeNow = runtimeRef.current;
    const currentId = config?.current_node_id ?? runtimeNow.node_id ?? null;
    const node = currentId
      ? (config?.nodes.find((item) => item.node_id === currentId) ?? null)
      : null;
    // 只有托管节点能诊断：其它来源的凭据不在我们手里（入口已拦，这里再兜一层）。
    if (node?.source !== "owned") return;
    const server = currentId
      ? (myServers.servers.find(
          (item) => item.local_node_id === currentId,
        ) ?? null)
      : null;
    const lastError = runtimeNow.last_error;
    const lastErrorReason = lastError?.details?.reason;
    const failureStage: ConnectionFacts["failureStage"] =
      runtimeNow.state === "failed"
        ? "failed"
        : runtimeNow.state === "starting" || runtimeNow.state === "restarting"
          ? "starting"
          : runtimeNow.state === "running" || runtimeNow.state === "degraded"
            ? "running"
            : "connect";
    const connectionFacts: ConnectionFacts = {
      failureStage,
      errorCode: lastError?.code ?? null,
      errorReason: typeof lastErrorReason === "string" ? lastErrorReason : null,
      nodeName: node?.name ?? runtimeNow.node_name ?? null,
      nodeSource:
        node?.source === "owned" || node?.source === "manual"
          ? node.source
          : null,
      region: server?.region ?? null,
      connectMode: config?.connect_mode ?? null,
      controlPlaneError: myServers.error,
      appVersion,
      platform: platformName(),
    };

    const checkConnection = async (): Promise<ConnectionLocalCheck> => {
      let snapshot: RuntimeSnapshot | null = null;
      try {
        snapshot = await bridge.getRuntimeSnapshot();
      } catch (error) {
        // 本地检查本身没跑完：带失败的命令与短码，结论走 runtime-error。
        const code = toBridgeError(error).code || "throw";
        throw {
          code,
          message: "",
          retryable: false,
          details: { reason: `runtime_status:${code}` },
        };
      }
      const configId = vpn.activeConfig?.config_id;
      let configFound = false;
      let nodeInConfig = false;
      if (configId) {
        try {
          const detail = await bridge.configDetail(configId);
          configFound = true;
          nodeInConfig =
            currentId !== null &&
            detail.nodes.some((item) => item.node_id === currentId);
        } catch {
          // 配置读不出来：这是表里的 config-invalid，不是检查本身失败。
          configFound = false;
        }
      }
      // helper 用现成的 tun_helper_info；unknown 不判 helper，继续往下。
      let helperState: ConnectionLocalCheck["helperState"] = "unknown";
      try {
        const info = await bridge.tunHelperInfo();
        helperState =
          info.state === "running"
            ? "ok"
            : info.state === "unknown"
              ? "unknown"
              : "blocked";
      } catch {
        helperState = "unknown";
      }
      const state = snapshot?.state ?? runtimeRef.current.state;
      const error =
        snapshot?.last_error ?? runtimeRef.current.last_error ?? null;
      const code = error?.code ?? null;
      const reasonValue = error?.details?.reason;
      const reason = typeof reasonValue === "string" ? reasonValue : null;
      // 错误只有运行时确实失败时才算「运行时错误」；成功后的旧 last_error 不误导。
      const runtimeFailed = state === "failed" || state === "degraded";
      return {
        runtimeState: state,
        runtimeErrorCode: runtimeFailed ? code : null,
        runtimeErrorReason: runtimeFailed ? reason : null,
        helperState,
        configFound,
        nodeInConfig,
      };
    };

    const retestConnection = async (): Promise<ConnectionRetest> => {
      if (!currentId) {
        return { reachable: null, reason: "node_not_in_config", latencyMs: null };
      }
      try {
        const result = await bridge.nodeProbe(currentId);
        nodeProbes.recordResults([result]);
        if (result.status === "untested") {
          return {
            reachable: null,
            reason: result.error?.reason ?? result.error?.code ?? null,
            latencyMs: null,
          };
        }
        return {
          reachable: result.reachable === true,
          reason: result.error?.reason ?? result.error?.code ?? null,
          latencyMs: result.latency_ms,
        };
      } catch (error) {
        return {
          reachable: null,
          reason: toBridgeError(error).code || "throw",
          latencyMs: null,
        };
      }
    };

    const deps: DiagnosisDeps = {
      profile: "connection",
      facts: {
        serverId: server?.server_id ?? "",
        region: server?.region ?? "",
        createdAt: server?.created_at ?? "",
        state: server?.state ?? runtimeNow.state,
        localNodeId: currentId,
        port: node?.port ?? null,
        nodeInUse: currentId !== null && runtimeNow.node_id === currentId,
        appVersion,
        platform: platformName(),
        uiLogPath: null,
        controlPlaneError: myServers.error,
      },
      isTunnelRunning: () =>
        currentId !== null && runtimeRef.current.node_id === currentId,
      isRuntimeRunning: () => {
        const state = runtimeRef.current.state;
        return state === "running" || state === "degraded";
      },
      // 手动导入的节点没有服务器记录、拿不到 IP：这一类检查不适用，记 skipped。
      ...(server?.ip
        ? {
            probeReachability: () =>
              bridge.nodeProbeReachability(server.ip as string, 32100),
          }
        : {}),
      connection: {
        facts: connectionFacts,
        check: checkConnection,
        retest: retestConnection,
        openSettings: () => {
          setDiagnosis(null);
          openSettings("advanced");
        },
        updateConfig: () => {
          vpn.reload();
          void myServers.refresh();
        },
        changeNode: () => {
          setDiagnosis(null);
        },
        reconnect: () => {
          setDiagnosis(null);
          handleVpnReconnect();
        },
        openAi: (context) => {
          const handed = askAiInPanel(connectDiagnosisAsk(context));
          if (handed) setDiagnosis(null);
          return handed;
        },
      },
    };
    setDiagnosis({ nodeName: connectionFacts.nodeName ?? "", deps });
  };

  // 手动测速：只更新延迟，不改选中/不连接；点击动作随下一条消息上报。
  const handleProbe = () => {
    lastActionRef.current = { id: "client.probe" };
    const config = vpn.activeConfig;
    if (!config || config.nodes.length === 0 || nodeProbes.run) return;
    // 停机删除的悬挂节点不测速：它连不上，测了只会亮一个「测不通」。
    const targets = config.nodes
      .map((node) => node.node_id)
      .filter((nodeId) => !danglingNodeIds.has(nodeId));
    if (targets.length === 0) return;
    setManualProbedConfigs((current) => {
      if (current.has(config.config_id)) return current;
      const next = new Set(current);
      next.add(config.config_id);
      return next;
    });
    void nodeProbes.start(
      config.config_id,
      targets,
    );
  };

  // action_card 的按钮只上报：hidden 消息 + context.last_action，不直接调命令。
  const handleActionCardAction = (action: { id: string }) => {
    if (!requireAi()) return;
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
    if (!requireAi()) return;
    lastActionRef.current = { id: "servers.ai_locate", value: serverId };
    let target = session;
    if (!target) {
      target = createSession();
      dispatch({ type: "add_session", session: target });
    }
    panelOpenRef.current = true;
    setPanelOpen(true);
    setAiUnread(false);
    void sendToSession(target.id, serverFailureAsk(), {
      hidden: true,
      lastAction: { id: "servers.ai_locate", value: serverId },
    });
  };

  const handleDiagnose = handleDiagnoseConnection;

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
      text: translate("app.billsNotice"),
    });
  };

  // 账号菜单里的退出登录：不二次确认，成功后给一次 toast。
  const handleAccountLogout = async () => {
    const wasLoggedIn = myServers.loggedIn;
    userLogoutRef.current = true;
    const result = await myServers.logout();
    if (result.ok) {
      setAccountMenu(null);
      setAppNotice({ level: "info", text: translate("app.loggedOut") });
      // 原本就没登录时不会触发过期 effect，这里自己把标志清掉。
      if (!wasLoggedIn) userLogoutRef.current = false;
    } else {
      // 退出失败仍在登录态：清掉标志，别影响之后真正的过期提示。
      userLogoutRef.current = false;
    }
    return result;
  };

  // 换一个账户：换新设备身份后再登录，避免旧设备绑在停用账户上重登失败。
  const handleSwitchAccount = async () => {
    const ok = await myServers.reRegister();
    if (ok) {
      myServers.openLogin();
      setAccountMenu(null);
    }
    return ok;
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
    setTrialPreselect(null);

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
      // 只按稳定错误码取句；映射不到用本地兜底，不拼后端文案。
      failTrial(
        trialFlowRef.current ?? start,
        "fetch",
        errorText(error, translate("trial.error.fetch")),
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
    const attached = await vpn.attachNodes({ source: "seed" });
    if (!attached.ok) {
      failTrial(
        trialFlowRef.current ?? afterFetch,
        "join",
        attached.message ?? translate("trial.error.join"),
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
  };

  // 测速步骤：逐个调用真实测速命令，全部返回后才算完成。
  useEffect(() => {
    if (!trialFlow || trialFlow.phase !== "probe") return;
    if (trialProbeStartedRef.current) return;
    if (vpn.loading) return;
    const config = vpn.activeConfig;
    if (!config) return;
    if (config.nodes.length === 0) {
      trialProbeStartedRef.current = true;
      // 全局配置不能删：attach 失败时池子没变，直接报错重试即可。
      failTrial(
        trialFlow,
        "probe",
        vpn.error ?? translate("trial.error.empty"),
      );
      return;
    }
    trialProbeStartedRef.current = true;
    // 这一步自己测，别让连接屏的自动测速再跑一批。
    probedConfigsRef.current.add(config.config_id);
    const startedAt = Date.now();
    const nodeIds = config.nodes.map((node) => node.node_id);
    void (async () => {
      const results: NodeProbeResult[] = [];
      for (const nodeId of nodeIds) {
        // 逐节点探测也要有行内反馈：正在测的那一行显示「测速中」。
        nodeProbes.markProbing([nodeId]);
        try {
          results.push(await bridge.nodeProbe(nodeId));
        } catch {
          // 单个节点失败不影响其余节点；全部失败才算这一步失败。
        } finally {
          nodeProbes.markProbing([]);
        }
      }
      // 单节点测速不写批次缓存，先读快照补运行态，再把结果并给控制器；
      // 节点行与收尾摘要都用这一份，数字才会一致。
      await nodeProbes
        .loadSnapshot(config.config_id, nodeIds)
        .catch(() => undefined);
      nodeProbes.recordResults(results);
      const current = trialFlowRef.current;
      if (!current || current.phase !== "probe") return;
      const elapsed = Date.now() - startedAt;
      // 按节点顺序取最快：并列时保留列表靠前的那一个。
      let fastestNodeId: string | null = null;
      let fastestMs: number | null = null;
      for (const node of config.nodes) {
        const result = results.find((item) => item.node_id === node.node_id);
        // 自动选最快只认真正测通的节点：untested 与 unreachable 都不能被选中。
        if (!result || result.status !== "ok" || result.latency_ms === null) continue;
        if (fastestMs === null || result.latency_ms < fastestMs) {
          fastestMs = result.latency_ms;
          fastestNodeId = node.node_id;
        }
      }
      if (fastestMs === null || fastestNodeId === null) {
        // 三态区分：没测成 / 连不上 / 混合。不把未测说成失败。
        // 只有每个节点都拿到结果，才配得上「全都…」；一抛错一正常按混合处理。
        const covered = results.length === nodeIds.length;
        const allUntested =
          covered &&
          results.length > 0 &&
          results.every((result) => result.status === "untested");
        const allUnreachable =
          covered &&
          results.length > 0 &&
          results.every((result) => result.status === "unreachable");
        failTrial(
          current,
          "probe",
          allUntested
            ? translate("trial.error.allUntested")
            : allUnreachable
              ? translate("trial.error.allUnreachable")
              : translate("trial.error.noResult"),
          elapsed,
        );
        return;
      }
      trialPreselectNonceRef.current += 1;
      setTrialPreselect({
        configId: config.config_id,
        nodeId: fastestNodeId,
        nonce: trialPreselectNonceRef.current,
        markFastest: true,
      });
      commitTrialFlow({
        ...current,
        phase: "done",
        probe: { status: "done", ms: elapsed },
        summary: {
          configId: config.config_id,
          count: nodeIds.length,
          fastestMs,
        },
      });
      trialBusyRef.current = false;
      setTrialBusy(false);
    })();
  }, [trialFlow, vpn.loading, vpn.activeConfig, bridge, nodeProbes, vpn.error]);

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
      composerDraft={composerDraft}
      onComposerDraftChange={setComposerDraft}
      aiReady={aiReady}
      aiProviderName={aiProviderName}
      hasEverConnected={hasEverConnected}
      hasConfigs={vpn.configs.length > 0}
      presetsVisible={uiScreen === "client" || uiScreen === "no_nodes"}
      focusSignal={composerFocusSignal}
      onSelectSession={handleSelectSession}
      onNewSession={() => dispatch({ type: "new_session" })}
      onRenameSession={handleRenameSession}
      onDeleteSession={handleDeleteSession}
      onSend={handleSend}
      onEmptySend={handleEmptySend}
      question={currentQuestion}
      questionAwayText={
        questionAway && questionOrigin
          ? t("app.questionAway", {
              screen: t(QUESTION_SCREEN_LABEL[questionOrigin]),
            })
          : null
      }
      questionExpired={questionExpired}
      onReturnToQuestion={returnToQuestion}
      onAnswerQuestion={handleAnswerQuestion}
      onAnswerFromComposer={answerQuestionFromComposer}
      onQuestionExpired={handleInlineQuestionExpired}
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
      <Onboarding bridge={bridge} onDone={finishOnboarding} onSkip={skipOnboarding} />
    );
  }

  // 配置与试用状态都读回来后再渲染，避免首屏闪一下「从哪里开始？」。
  if (!stageReady) {
    return <div className="app-boot" aria-hidden />;
  }

  return (
    <div style={appStyle} className={`app ${destination === "servers" ? "" : "app--solo"}`.trim()}>
      <nav className="activity" aria-label={t("activity.navAria")}>
        <button
          type="button"
          className={`activity__item ${destination === "client" ? "is-active" : ""}`}
          aria-pressed={destination === "client"}
          aria-label={t("activity.client")}
          title={t("activity.client")}
          disabled={newNodeBusy}
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
              ? t("activity.serversInstalling", { count: installingServerCount })
              : t("activity.servers")
          }
          title={t("activity.servers")}
          disabled={newNodeBusy}
          onClick={() => {
            if (destination === "servers") {
              setServersRootSignal((value) => value + 1);
              refreshServersOnce();
            } else {
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
            aria-label={t("activity.settings")}
            title={t("activity.settings")}
            onClick={() => openSettings()}
          >
            <IconSliders size={18} />
          </button>
          <button
            type="button"
            className="activity__item activity__account"
            aria-label={
              myServers.accountError && !myServers.account
                ? t("activity.accountError")
                : myServers.loggedIn
                  ? t("activity.accountEmail", {
                      email: myServers.account?.email ?? "",
                    })
                  : t("activity.accountLoggedOut")
            }
            title={
              myServers.accountError && !myServers.account
                ? t("activity.accountError")
                : t("activity.account")
            }
            aria-expanded={accountMenu === "nav"}
            onClick={() => {
              if (
                myServers.accountError &&
                !myServers.account
              ) {
                void myServers.refreshAccount();
                return;
              }
              if (!myServers.accountLoaded) return;
              if (!myServers.loggedIn) {
                myServers.openLogin();
                return;
              }
              setAccountMenu((current) => (current === "nav" ? null : "nav"));
            }}
          >
            <AccountAvatar
              email={myServers.account?.email ?? null}
              loading={!myServers.accountLoaded && !myServers.accountError}
              size="nav"
            />
            {myServers.accountError && !myServers.account ? (
              <span className="activity__dot" aria-hidden="true" />
            ) : null}
          </button>
          {accountMenu === "nav" && myServers.loggedIn ? (
            <AccountMenu
              email={myServers.account?.email ?? null}
              wallet={myServers.wallet}
              walletLoading={myServers.walletLoading}
              walletRefreshing={myServers.walletRefreshing}
              walletError={myServers.walletError}
              walletStale={myServers.walletStale}
              identityProblem={myServers.identityProblem}
              onTopUp={() => myServers.openTopUp()}
              onRefreshWallet={(trigger) =>
                void myServers.refreshWallet({ trigger })
              }
              onReRegister={() => myServers.identityAction()}
              onSwitchAccount={handleSwitchAccount}
              onLogout={handleAccountLogout}
              onClose={() => setAccountMenu(null)}
            />
          ) : null}
        </div>
      </nav>
      {destination === "servers" ? (
        <MyServersRail
          servers={myServers.servers}
          selectedId={myServers.selectedId}
          loading={myServers.loading}
          catalog={myServers.catalog}
          error={myServers.error}
          accountError={myServers.accountError}
          catalogError={myServers.catalogError}
          retryNotice={myServers.retryNotice}
          disabled={myServers.identityProblem !== null || newNodeOpen}
          compact={shell.mode === "drawer"}
          trialHint={
            trial
              ? trialAvailableHint(
                  trial.state,
                  trial.seed_node_count,
                  trial.expires_at,
                  Date.now(),
                )
              : null
          }
          onGoConnect={() => changeDestination("client")}
          signedIn={
            !myServers.accountLoaded || myServers.loggedIn
          }
          showMobile={showRailMobileExport}
          onMobile={openMobileExport}
          onSelect={myServers.select}
          onNew={() => openNewNode("servers")}
          onSync={() => void serverSync.syncNow()}
          syncBusy={serverSync.busy}
        />
      ) : null}
      {destination === "servers" && panes.canDragRail ? (
        <PaneHandle
          side="rail"
          label={t("pane.railWidth")}
          controls="config-rail"
          value={panes.rail}
          min={RAIL_MIN}
          max={panes.railMax}
          dragging={panes.draggingPane === "rail"}
          {...panes.railHandlers}
        />
      ) : null}
      {newNodeOpen ? (
        <main
          className="connection-stage connection-stage--new-node"
          aria-label={t("app.newNodeAria")}
        >
          <div className="connection-stage__col">
            <MyServerWizard
              bridge={bridge}
              catalog={myServers.catalog}
              onOrdered={(serverId) => {
                closeNewNode();
                // 认不出新机器时 ordered(null) 会让列表不选中任何一台并给一行提示。
                myServers.ordered(serverId);
                setDestination("servers");
              }}
              onEnsureIdentity={myServers.ensureIdentity}
              onTopUp={myServers.openTopUp}
              onAuthRequired={myServers.openLogin}
              onAskAi={
                aiReady
                  ? () => {
                      lastActionRef.current = { id: "new_node.ask_ai" };
                      askAiInPanel(t("assistant.prompt.pickRegion"));
                    }
                  : undefined
              }
              aiSelection={stageSelect}
              initialSelection={newNodeSelection}
              onBusyChange={(busy) => {
                newNodeBusyRef.current = busy;
                setNewNodeBusy(busy);
              }}
              onBack={closeNewNode}
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
          account={myServers.account}
          signedIn={myServers.loggedIn}
          accountLoaded={myServers.accountLoaded}
          accountError={myServers.accountError}
          catalogError={myServers.catalogError}
          loading={myServers.loading}
          error={myServers.error}
          retrying={myServers.retrying}
          detailError={myServers.detailError}
          detailRetrying={myServers.detailRetrying}
          readOnly={myServers.identityProblem !== null}
          onTopUp={myServers.openTopUp}
          onNew={() => openNewNode("servers")}
          onLogin={myServers.openLogin}
          onRefreshAccount={() => void myServers.refreshAccount()}
          onRetry={() => void myServers.retry()}
          onChanged={() => void myServers.refresh()}
          repairAvailable={
            myServers.selected !== null &&
            diagnosisEligibleServer(myServers.selected) &&
            repairAvailableFor(
              myServers.selected.local_node_id,
              vpn.activeConfig,
              nodeProbes.results,
              nodeProbes.probing,
            )
          }
          onDiagnose={handleAnalyzeNode}
          onGone={() => myServers.clearSelection()}
          onRebuilt={myServers.rebuilt}
          onRetryDetail={myServers.retryDetail}
          onAiLocate={handleAiLocate}
          trial={
            trial
              ? {
                  state: trial.state,
                  seedNodeCount: trial.seed_node_count,
                  expiresAt: trial.expires_at,
                }
              : null
          }
          onGoConnect={() => changeDestination("client")}
          pendingServer={myServers.pendingServer || myServers.awaitingSelected}
          onForget={async (serverId, nodeId) => {
            await myServers.forgetServer(serverId, nodeId);
            // 节点真的删掉了：连接页按新配置重读，悬挂行不会留到下次启动。
            vpn.reload();
          }}
          onRenamed={myServers.renamed}
        />
      ) : trial?.state === "expired" && !showsStage ? (
        <TrialExpired
          onNewNode={() => {
            lastActionRef.current = { id: "trial_expired.new_node" };
            openNewNode("trial_expired");
          }}
          onAddNode={openAddNode}
        />
      ) : showsStage && !(trialFlow && trialFlow.phase !== "done") ? (
        <ConnectionStage
          config={vpn.activeConfig}
          connection={vpn.connection}
          runtime={runtime}
          onStart={handleVpnStart}
          onStop={() => void handleVpnStop()}
          onReconnect={handleVpnReconnect}
          onSwitchNode={handleSwitchNode}
          onRemoveNode={handleRemoveNode}
          onEditNode={handleEditNode}
          nodeProbes={nodeProbes}
          failedAfterConnected={failedAfterConnected}
          helperPreparing={vpn.preparingHelper}
          onReportProblem={handleReportProblem}
          reportBusy={reportOpening}
          actionCards={actionCards}
          danglingNodeIds={danglingNodeIds}
          onActionCardAction={handleActionCardAction}
          onDiagnose={handleDiagnose}
          onAnalyzeNode={handleAnalyzeNode}
          trialSummary={trialFlow?.summary ?? null}
          trialExpiresAt={trial?.expires_at ?? null}
          pendingServerNodes={pendingServerNodes}
          preselect={trialPreselect}
          onPreselectApplied={(nonce) =>
            setTrialPreselect((current) =>
              current && current.nonce === nonce ? null : current,
            )
          }
          onProbe={handleProbe}
          onAddNode={openAddNode}
          manualProbed={
            vpn.activeConfig
              ? manualProbedConfigs.has(vpn.activeConfig.config_id)
              : false
          }
          onProbeAvailabilityChange={(available) => {
            probeControlHiddenRef.current = !available;
          }}
          routingMode={activeRoutingMode}
          onSetConnectMode={handleSetConnectMode}
          onSetRoutingMode={handleSetRoutingMode}
          onAskAi={askAiInPanel}
          onAskAiAboutNode={handleAskAiAboutNode}
          serverIdForNode={(nodeId) => {
            const server = myServers.servers.find(
              (item) => item.local_node_id === nodeId,
            );
            return server && diagnosisEligibleServer(server)
              ? server.server_id
              : null;
          }}
          onReconnectAndTest={handleReconnectAndTest}
          staleConfigNode={staleConfigNode !== null}
          onStaleConfigRetry={() => setStaleConfigNode(null)}
        />
      ) : (
        <StartChoice
          busy={trialBusy}
          onUseFree={() => void handleUseFreeNodes()}
          onNewNode={() => {
            lastActionRef.current = { id: "no_nodes.new_node" };
            openNewNode("client");
          }}
          onAddNode={openAddNode}
          trial={trialFlow}
          onRetryTrial={handleRetryTrial}
          onSkipProbe={handleSkipTrialProbe}
          accountLoaded={myServers.accountLoaded}
          loggedIn={myServers.loggedIn}
          accountError={myServers.accountError}
          emptyConfig={Boolean(vpn.activeConfig)}
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
          label={t("pane.assistantWidth")}
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
          onReRegister={myServers.reRegister}
          onCancel={myServers.closeLogin}
        />
      ) : null}

      {myServers.topupOpen ? (
        <MyServerTopUp
          wallet={myServers.wallet}
          loading={myServers.walletLoading}
          error={myServers.walletError}
          onRetry={() => void myServers.refreshWallet({ trigger: "retry" })}
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
            aria-label={t("app.toastClose")}
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

      <AiRequiredDialog
        open={aiRequiredOpen}
        onClose={() => setAiRequiredOpen(false)}
        onConfigure={() => {
          setAiRequiredOpen(false);
          openSettings("ai");
        }}
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
        onSetConnectMode={handleSetConnectMode}
        onNewConfig={() => {
          setSettingsOpen(false);
          handleAskAiFromConsole();
        }}
        onClose={closeSettings}
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
        onReportProblem={handleReportProblem}
        reportBusy={reportOpening}
        onAskAi={(text, section) => {
          if (!requireAi()) return;
          setSettingsSection(section);
          closeSettings();
          askAiInPanel(text);
        }}
        routingMode={activeRoutingMode}
        onSetRoutingMode={handleSetRoutingMode}
        onConnectModeChanged={() => vpn.reload()}
        assistant={aiPanel}
        onConsultingChange={setSettingsConsulting}
        onConsultAi={askAiInPanel}
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
        walletLoading={myServers.walletLoading}
        walletRefreshing={myServers.walletRefreshing}
        walletError={myServers.walletError}
        walletStale={myServers.walletStale}
        onRefreshWallet={(trigger) => void myServers.refreshWallet({ trigger })}
        onForceRefresh={() =>
          void myServers.refreshWallet({ force: true, trigger: "manual" })
        }
        onLogin={() => {
          closeSettings();
          myServers.openLogin();
        }}
        onTopUp={() => {
          closeSettings();
          myServers.openTopUp();
        }}
        onViewBills={() => void handleViewBills()}
        mobileExportOpen={mobileExportOpen}
        trapPaused={aiRequiredOpen}
        syncInterval={syncInterval ?? 240}
        syncIntervalUnsaved={syncIntervalUnsaved}
        onSyncIntervalChange={changeSyncInterval}
        onSyncNow={() => void serverSync.syncNow()}
        syncBusy={serverSync.busy}
        lastSyncedAt={serverSync.lastSyncedAt}
        syncResult={serverSync.lastResult}
        syncResultAt={serverSync.lastResultAt}
        onOpenMobileExport={openMobileExport}
      />

      {mobileExportOpen ? (
        <MobileExport
          bridge={bridge}
          nested={settingsOpen}
          trapPaused={aiRequiredOpen}
          onClose={closeMobileExport}
          onLogin={() => {
            // 登录弹层马上接管焦点：不要再把焦点还给弹层后面的左栏行。
            closeMobileExport(false);
            closeSettings();
            myServers.openLogin();
          }}
          onGoServers={() => {
            // 切 destination 由导航自己接管焦点：不要再还给已经离开的那一行。
            closeMobileExport(false);
            closeSettings();
            changeDestination("servers");
            refreshServersOnce();
          }}
          onAskAi={() => {
            if (!requireAi()) return;
            closeMobileExport(false);
            closeSettings();
            askAiInPanel(mobileExportPrompt());
          }}
        />
      ) : null}

      <ConnectionOverlay
        connection={vpn.connection}
        preparingHelper={vpn.preparingHelper}
        checkingHelper={vpn.checkingHelper}
        runtime={runtime}
        connectMode={vpn.activeConfig?.connect_mode ?? null}
      />

      {diagnosis ? (
        <DiagnosisPanel
          nodeName={diagnosis.nodeName}
          deps={diagnosis.deps}
          onClose={() => setDiagnosis(null)}
          trapPaused={aiRequiredOpen || settingsOpen || mobileExportOpen}
        />
      ) : null}

      <NodeImportDialog
        open={nodeImportOpen}
        bridge={bridge}
        editing={editingNode}
        onSaved={(result) => {
          if (result.paramsChanged && editingNode) {
            nodeProbes.forget(editingNode.node_id);
          }
          void vpn.reload();
        }}
        onClose={() => {
          setNodeImportOpen(false);
          setEditingNode(null);
        }}
        onNotice={setAppNotice}
      />

      {quitOpen ? (
        <QuitDialog
          busy={quitBusy}
          error={quitError}
          connected={
            vpn.connection === "connected" || vpn.connection === "starting"
          }
          onDecision={decideQuit}
        />
      ) : null}
    </div>
  );
}

function describeCommandError(error: unknown, label: string): string {
  const bridgeError = toBridgeError(error);
  // 这条匹配的是 Tauri 未注册命令时的字符串错误，不是我们的错误信封。
  if (/not found|unknown command/i.test(bridgeError.message)) {
    return translate("app.commandUnavailable", { label });
  }
  return errorText(bridgeError, translate("app.commandFailed", { label }));
}

interface AppNotice {
  level: "info" | "error";
  text: string;
}

function describeRenameError(error: BridgeError): string {
  if (error.code === "INVALID_ARGUMENT") {
    const reason = error.details?.reason;
    if (reason === "empty_title") return translate("app.renameEmpty");
    if (reason === "title_too_long") return translate("app.renameTooLong");
  }
  if (error.code === "NOT_FOUND") return translate("app.sessionGone");
  return translate("app.renameFailed");
}
