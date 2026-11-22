import { useCallback, useEffect, useRef, useState } from "react";
import type {
  AgentBridge,
  MyServer,
  MyServerAccount,
  MyServerCatalog,
  MyServerLoginTicket,
  MyServerState,
  MyServerTopup,
  MyServerWallet,
} from "../agent/bridge";
import { toBridgeError } from "../agent/errors";
import { errorText } from "../i18n/errorText";
import { AGENT_EVENTS } from "../agent/protocol";
import { uiLog } from "../log/uiLog";
import { isProvisioning } from "./labels";
import { t } from "../i18n";

export type ServersView = "detail" | "wizard";

interface Options {
  /** 停在「我的服务器」destination 时才听 Esc。 */
  active: boolean;
  /** 再点一次「我的服务器」图标时递增：回到列表根（默认第一台）。 */
  rootSignal: number;
}

/** 设备身份丢了：不是网络问题，重试同一个请求不会变好，只能重新注册。 */
/** 详情请求失败后的后台重试节奏：1s → 2s → 4s → 8s，之后封顶 8s。 */
const DETAIL_RETRY_DELAYS = [1000, 2000, 4000, 8000];
/** 没有任何可读数据时，连续失败累计这么久才给错误；首次失败不报。 */
const DETAIL_ERROR_AFTER_MS = 10_000;
/** 打开任一面时，距上次成功刷新不足这么久就直接用缓存。 */
export const WALLET_REFRESH_GATE_MS = 30_000;
/** 开通中的阶段在真机上可能只有几秒：列表轮询压到 2 秒，别让 5 秒一跳整段漏掉。 */
const PROVISIONING_POLL_MS = 2000;

/**
 * 谁触发了这次余额刷新。设计文档点名的来源之外，顺带刷新余额的用户动作
 * （登录、下单/重建/销毁之后、打开充值弹层、进入我的服务器）单独命名，不冒充 manual。
 */
export type WalletTrigger =
  | "open_menu"
  | "open_settings"
  | "open_servers"
  | "visible"
  | "focus"
  | "retry"
  | "manual"
  | "login"
  | "order"
  | "topup";

/** 进程内单调递增：并发/交错时按 seq 把触发行与结果行配成对。 */
let walletRefreshSeq = 0;

/** 日志字段只收短枚举：后端给的原文再短也不直接拼进日志。 */
const LOG_TOKEN = /^[a-z0-9_.-]{1,32}$/;

function walletFailReason(error: unknown): string {
  const { code, details } = toBridgeError(error);
  const raw = typeof details?.reason === "string" ? details.reason : code;
  const token = raw.toLowerCase();
  return LOG_TOKEN.test(token) ? token : "unknown";
}

/** 登录门禁：列表 / 下单都要求已登录时返回这个原因。 */
const AUTH_REASONS = new Set(["auth_required", "token_invalid"]);

function errorReason(error: unknown): string {
  const reason = toBridgeError(error).details?.reason;
  return typeof reason === "string" ? reason : "";
}

/** 身份不可用时 Host 用 auth_required 回落；keychain 丢失时可能带更具体的原因。 */
const IDENTITY_REASONS = new Set([
  "auth_required",
  "device_identity_lost",
  "device_missing",
  "device_mismatch",
]);

function identityLost(error: unknown): boolean {
  const reason = toBridgeError(error).details?.reason;
  return typeof reason === "string" && IDENTITY_REASONS.has(reason);
}

/** 事件不可用时的兜底节奏（§19.9.2）：2s → 5s → 10s。 */
const FALLBACK_DELAYS = [2000, 5000];

type RegisterCapable = AgentBridge & {
  myServerRegisterDevice?: () => Promise<unknown>;
};

interface ServerIdentity {
  has_identity: boolean;
  account_id: string | null;
}

/** Host 尚未接身份命令时，可选能力缺失，按「有身份」兜底。 */
type IdentityCapable = AgentBridge & {
  myServerIdentity?: () => Promise<ServerIdentity>;
};

/** 登录 / 钱包命令在旧 Host 上可能不存在；缺了就退回身份流程。 */
type AccountCapable = AgentBridge & {
  myServerAccount?: () => Promise<MyServerAccount>;
  myServerLoginStart?: (email: string) => Promise<MyServerLoginTicket>;
  myServerLoginVerify?: (email: string, code: string) => Promise<MyServerAccount>;
  myServerLogout?: () => Promise<MyServerAccount>;
  myServerWallet?: () => Promise<MyServerWallet>;
  myServerTopup?: (denominationCents: number) => Promise<MyServerTopup>;
};

export interface LogoutResult {
  ok: boolean;
  message?: string;
}

/** 「我的服务器」destination：左栏列表 + 中间选中那台。 */
export function useMyServers(bridge: AgentBridge, { active, rootSignal }: Options) {
  const [servers, setServers] = useState<MyServer[]>([]);
  const [catalog, setCatalog] = useState<MyServerCatalog | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [identityLostState, setIdentityLostState] = useState(false);
  /** 设备 / 账户被停用：永久状态，重试同一个请求不会变好，界面要给明确出路。 */
  const [blockedState, setBlockedState] = useState<
    "device_revoked" | "account_blocked" | null
  >(null);
  /** 还没有设备身份：列表区只给登录提示，不请求 /v1/servers。 */
  const [identityMissing, setIdentityMissing] = useState(false);
  const [identityPresent, setIdentityPresent] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [retryNotice, setRetryNotice] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  /** 显式选中的新机器：列表刷新前不允许默认选择 effect 覆盖它。 */
  const pinnedSelectionRef = useRef<string | null>(null);
  /** 已下单但还认不出是哪台：不自动选，等列表出现新行再认。 */
  const [pendingServer, setPendingServer] = useState(false);
  /** 下单前的服务器 id 集合：刷新时用它认出哪一行是新机器。 */
  const pendingBaselineRef = useRef<Set<string> | null>(null);
  /** 自己触发的登出：随后到来的 account-cleared 事件不要重复处理。 */
  const selfLogoutAtRef = useRef(0);
  /** 用户已删掉的停机删除墓碑：后端还在返回时也不再显示。 */
  const forgottenRef = useRef<Set<string>>(new Set());
  /** 最近一次拉到的列表：轮询按它决定节奏，不等下一次渲染。 */
  const fetchedServersRef = useRef<MyServer[]>([]);
  /** 上一次 refresh 是否成功：失败时列表是旧的，不能拿它当「还在开通中」压高频。 */
  const refreshOkRef = useRef(false);
  const [detail, setDetail] = useState<MyServer | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [detailRetrying, setDetailRetrying] = useState(false);
  const [revision, setRevision] = useState(0);
  /** 中间默认是创建页；点左栏某台才切到详情。 */
  const [view, setView] = useState<ServersView>("wizard");
  /** 已收到过 my-server-changed：事件在，就关掉兜底轮询。 */
  const [eventsLive, setEventsLive] = useState(false);
  const [account, setAccount] = useState<MyServerAccount | null>(null);
  const [accountLoaded, setAccountLoaded] = useState(false);
  /** 账户命令失败：界面显示「账户暂时读不到」，不冒充未登录。 */
  const [accountError, setAccountError] = useState(false);
  const [wallet, setWallet] = useState<MyServerWallet | null>(null);
  /** 请求在途；`walletLoading` 只表示「从未取到值 + 在途」，已有旧值时界面继续显示旧值。 */
  const [walletInFlight, setWalletInFlight] = useState(false);
  const [walletError, setWalletError] = useState<string | null>(null);
  /** 上次刷新是否失败：已有旧值时界面据此写「显示的是上次的余额」。 */
  const [walletFailed, setWalletFailed] = useState(false);
  const walletSuccessAtRef = useRef(0);
  const walletInFlightRef = useRef(false);
  /** 在途请求的令牌：只有仍持有令牌的请求才能清掉在途标记。 */
  const walletTokenRef = useRef(0);
  /** 账户代次：登出 / 换账号时 +1；晚到的旧账户响应据此丢弃。 */
  const walletEpochRef = useRef(0);
  /** 已经为这次隐藏记过日志：有些平台会连发多次 hidden 事件。 */
  const hiddenLoggedRef = useRef(false);
  /** 回调里判断「有没有旧值」不依赖闭包里的 wallet。 */
  const walletRef = useRef<MyServerWallet | null>(null);
  walletRef.current = wallet;
  const [loginOpen, setLoginOpen] = useState(false);
  const [topupOpen, setTopupOpen] = useState(false);

  const loggedIn = account?.logged_in === true;
  /** 回调里判断登录态用 ref：把 loggedIn 放进依赖会让 refreshWallet 换身份、连带重跑列表加载。 */
  const loggedInRef = useRef(loggedIn);
  loggedInRef.current = loggedIn;
  /** 账户重读后比较用：回调里拿不到最新的 account state。 */
  const accountIdRef = useRef<string | null>(null);
  accountIdRef.current = account?.account_id ?? null;

  /** 账户变了：余额、门禁时间、在途标记都属于上一个账户，整份清掉。 */
  const resetWallet = useCallback(() => {
    walletEpochRef.current += 1;
    walletSuccessAtRef.current = 0;
    walletInFlightRef.current = false;
    walletRef.current = null;
    setWallet(null);
    setWalletError(null);
    setWalletFailed(false);
    setWalletInFlight(false);
  }, []);

  const markLoggedOut = useCallback(() => {
    loggedInRef.current = false;
    resetWallet();
    setAccount((current) =>
      current
        ? { ...current, logged_in: false, email: null, account_kind: "device" }
        : null,
    );
    setIdentityMissing(true);
    setIdentityPresent(false);
    setBlockedState(null);
    setServers([]);
    setSelectedId(null);
    setDetail(null);
    setError(null);
    setLoading(false);
  }, [resetWallet]);

  const refreshWallet = useCallback(
    async (options: { force?: boolean; trigger?: WalletTrigger } = {}) => {
      const trigger = options.trigger ?? "manual";
      const seq = (walletRefreshSeq += 1);
      // 一次刷新只落「触发」和「结果」两行，中间态不打；两行同 seq。
      uiLog("debug", `refresh seq=${seq} trigger=${trigger}`);
      const source = (bridge as AccountCapable).myServerWallet;
      if (!source) {
        uiLog("debug", `refresh seq=${seq} skipped reason=unsupported`);
        return;
      }
      // 未登录不发：组件可能在登出后的下一拍才卸载。
      if (!loggedInRef.current) {
        uiLog("debug", `refresh seq=${seq} skipped reason=logged_out`);
        return;
      }
      // 并发请求没有意义；30 秒内刚成功过就直接用缓存（手动刷新传 force）。
      if (walletInFlightRef.current) {
        uiLog("debug", `refresh seq=${seq} skipped reason=inflight`);
        return;
      }
      // 显式动作不受门禁限制：手动刷新和失败后的「重试」都要立刻发。
      const forced = options.force === true || trigger === "retry";
      const sinceSuccess = Date.now() - walletSuccessAtRef.current;
      // 手上没有值时门禁毫无意义：拦下来只会把界面钉在「读取中」。
      if (
        !forced &&
        walletRef.current !== null &&
        sinceSuccess < WALLET_REFRESH_GATE_MS
      ) {
        uiLog(
          "debug",
          `refresh seq=${seq} skipped reason=gate elapsed_ms=${sinceSuccess}`,
        );
        return;
      }
      const startedAt = Date.now();
      const epoch = walletEpochRef.current;
      const token = (walletTokenRef.current += 1);
      walletInFlightRef.current = true;
      // 刷新期间保留旧值：不清空 wallet；读取中只属于「从来没有值」的情况。
      setWalletInFlight(true);
      setWalletError(null);
      try {
        const next = await source.call(bridge);
        if (epoch !== walletEpochRef.current) {
          // 等响应期间登出或换了账户：这是上一个账户的值，丢弃。
          uiLog("debug", `refresh seq=${seq} discarded reason=account_changed`);
          return;
        }
        setWallet(next);
        walletRef.current = next;
        walletSuccessAtRef.current = Date.now();
        setWalletFailed(false);
        uiLog(
          "debug",
          `refresh seq=${seq} done outcome=ok balance_cents=${next.balance_cents} elapsed_ms=${Date.now() - startedAt}`,
        );
      } catch (error) {
        if (epoch !== walletEpochRef.current) {
          uiLog("debug", `refresh seq=${seq} discarded reason=account_changed`);
          return;
        }
        setWalletFailed(true);
        // 失败只记错误码/短原因，不记错误原文。
        uiLog(
          "warn",
          `refresh seq=${seq} done outcome=failed elapsed_ms=${Date.now() - startedAt} reason=${walletFailReason(error)}`,
        );
        const reason = errorReason(error);
        if (AUTH_REASONS.has(reason)) {
          // 登录过期：切回未登录，别让旧邮箱和余额继续显示。
          markLoggedOut();
        } else if (
          reason === "device_revoked" ||
          reason === "account_blocked"
        ) {
          setBlockedState(reason);
          setWalletError(null);
        } else if (walletRef.current === null) {
          // 从未取到值：只能明说读不到。
          setWalletError(t("account.walletError"));
        }
        // 已有旧值：保留数字，由 walletStale 写「显示的是上次的余额」。
      } finally {
        // 只有仍持有令牌的请求才能清标记：别把后来那次请求的在途状态抹掉。
        if (walletTokenRef.current === token) {
          walletInFlightRef.current = false;
          setWalletInFlight(false);
        }
      }
    },
    [bridge, markLoggedOut],
  );

  /**
   * 拿到的服务器列表落到界面：墓碑过滤、待选基线、选中对齐与 revision。
   * 列表来自 my_server_list，或 my_server_sync 返回的 servers。
   */
  const applyServers = useCallback((input: MyServer[]) => {
    // 停机删除后本地节点已删、墓碑行不该再出现：等后端不再返回之前先自己滤掉。
    const list =
      forgottenRef.current.size === 0
        ? input
        : input.filter(
            (server) => !forgottenRef.current.has(server.server_id),
          );
    fetchedServersRef.current = list;
    setServers(list);
    // 认出新机器就解除「已下单」占位并选中它；还没出现就继续等，别乱选一台旧的。
    const baseline = pendingBaselineRef.current;
    if (baseline) {
      const appeared = list.find(
        (server) => !baseline.has(server.server_id),
      );
      if (appeared) {
        pendingBaselineRef.current = null;
        setPendingServer(false);
        pinnedSelectionRef.current = appeared.server_id;
        setSelectedId(appeared.server_id);
      }
    }
    setError(null);
    setRevision((value) => value + 1);
  }, []);

  const refresh = useCallback(async (): Promise<boolean> => {
    try {
      const result = await bridge.myServerList();
      refreshOkRef.current = true;
      applyServers(result.servers);
      setIdentityLostState(false);
      setBlockedState(null);
      setIdentityPresent(true);
      return true;
    } catch (err) {
      refreshOkRef.current = false;
      const reason = errorReason(err);
      if (AUTH_REASONS.has(reason)) {
        markLoggedOut();
      } else if (reason === "device_revoked" || reason === "account_blocked") {
        // 永久状态：不当成网络故障，也不显示「稍后再试」。
        setBlockedState(reason);
        setIdentityLostState(false);
        setIdentityPresent(false);
        setError(null);
      } else if (identityLost(err)) {
        setIdentityLostState(true);
        setIdentityPresent(false);
        setError(null);
      } else {
        setError(t("myservers.error.list"));
      }
      return false;
    } finally {
      setLoading(false);
    }
  }, [bridge, markLoggedOut, applyServers]);

  /** 账户读取失败后重试：只重读身份，不重登。 */
  const refreshAccount = useCallback(async () => {
    const source = (bridge as AccountCapable).myServerAccount;
    if (!source) return;
    setAccountLoaded(false);
    setAccountError(false);
    try {
      const info = await source.call(bridge);
      // 重读也可能换到另一个账户：同 id 不清缓存，id 变了走同一套重置。
      if (info.logged_in && info.account_id !== accountIdRef.current) {
        resetWallet();
      }
      // 同一拍里就要刷新：登录态先进 ref，不等下一次 render。
      loggedInRef.current = info.logged_in;
      setAccount(info);
      setAccountLoaded(true);
      if (info.logged_in) {
        setIdentityMissing(false);
        setIdentityPresent(true);
        void refresh();
        void refreshWallet({ trigger: "login" });
      } else {
        setIdentityMissing(true);
        setIdentityPresent(false);
        setLoading(false);
      }
    } catch {
      setAccountLoaded(true);
      setAccountError(true);
    }
  }, [bridge, refresh, refreshWallet, resetWallet]);

  /** 列表失败后的手动重试；成功就地恢复列表，不跳页。 */
  const retry = useCallback(async () => {
    setRetrying(true);
    setRetryNotice(null);
    const ok = await refresh();
    setRetrying(false);
    if (ok) setRetryNotice(t("myservers.notice.relisted"));
  }, [refresh]);

  // 打开页面先读公开目录与本地登录态；已登录才拉服务器列表。
  useEffect(() => {
    let alive = true;
    void bridge
      .myServerCatalog()
      .then((value) => {
        if (alive) setCatalog(value);
      })
      .catch(() => {
        // 目录失败由向导处理，列表不受影响。
      });

    const fallbackToIdentity = () => {
      const source = (bridge as IdentityCapable).myServerIdentity;
      if (!source) {
        // Host 还没接身份命令：保持现有行为，直接拉列表。
        setIdentityPresent(true);
        void refresh();
        return;
      }
      void source
        .call(bridge)
        .then((info) => {
          if (!alive) return;
          if (info.has_identity) {
            setIdentityPresent(true);
            void refresh();
          } else {
            setIdentityMissing(true);
            setIdentityPresent(false);
            setLoading(false);
          }
        })
        .catch(() => {
          if (!alive) return;
          setIdentityMissing(true);
          setIdentityPresent(false);
          setLoading(false);
        });
    };

    const accountSource = (bridge as AccountCapable).myServerAccount;
    if (!accountSource) {
      fallbackToIdentity();
      return () => {
        alive = false;
      };
    }
    void accountSource
      .call(bridge)
      .then((info) => {
        if (!alive) return;
        // 同一拍里就要刷新：登录态先进 ref，不等下一次 render。
        loggedInRef.current = info.logged_in;
        setAccount(info);
        setAccountLoaded(true);
        if (info.logged_in) {
          setIdentityMissing(false);
          setIdentityPresent(true);
          void refresh();
          void refreshWallet({ trigger: "login" });
        } else {
          setIdentityMissing(true);
          setIdentityPresent(false);
          setLoading(false);
        }
      })
      .catch(() => {
        if (!alive) return;
        setAccountLoaded(true);
        setAccountError(true);
        fallbackToIdentity();
      });

    return () => {
      alive = false;
    };
  }, [bridge, refresh, refreshWallet]);

  // 建机状态变化走事件；事件不可用时才用慢速兜底。
  useEffect(() => {
    return bridge.subscribe((event) => {
      if (event.name === AGENT_EVENTS.myServerChanged) {
        const { server_id, state, node_id, failure } = event.payload;
        setEventsLive(true);
        setServers((current) =>
          current.map((server) =>
            server.server_id === server_id
              ? {
                  ...server,
                  state: state as MyServerState,
                  node_id: node_id ?? server.node_id,
                  failure: (failure ?? null) as unknown as MyServer["failure"],
                }
              : server,
          ),
        );
        setRevision((value) => value + 1);
        void refresh();
      } else if (event.name === AGENT_EVENTS.myServerRenamed) {
        // 改名走两条路：本次调用的返回值，和这条事件；按 server_id 写同一份 state。
        setServers((current) =>
          current.map((server) =>
            server.server_id === event.payload.server_id
              ? { ...server, name: event.payload.name }
              : server,
          ),
        );
        setDetail((current) =>
          current && current.server_id === event.payload.server_id
            ? { ...current, name: event.payload.name }
            : current,
        );
      } else if (event.name === AGENT_EVENTS.myServerOrderChanged) {
        void refresh();
      } else if (event.name === AGENT_EVENTS.myServerAccountCleared) {
        // Host 在登出被 403 拒绝后已清本地令牌；自己刚登出的话不再重复处理。
        if (Date.now() - selfLogoutAtRef.current < 10_000) {
          selfLogoutAtRef.current = 0;
          return;
        }
        setTopupOpen(false);
        markLoggedOut();
      }
    });
  }, [bridge, refresh, markLoggedOut]);

  // 开通中与销毁中都要轮询：销毁完成后控制面列表会把 destroyed 过滤掉，
  // 只有再拉一次列表，左栏那一行才会自己消失。`isProvisioning` 的语义被进度块共用，不改它。
  const hasProvisioning = servers.some((server) => isProvisioning(server.state));
  const shouldPollList =
    hasProvisioning || servers.some((server) => server.state === "destroying");
  // 列表刷新本来就会顺带重取详情（refresh 撞 revision）；开通中把节奏压到 2 秒，
  // 一个周期仍是「列表 + 详情」两个请求，离开开通态回到原节奏。
  const triesRef = useRef(0);
  useEffect(() => {
    // 事件只是加速；只要还有机器在开通中或销毁中就必须轮询——事件可能漏。
    if (!shouldPollList) {
      triesRef.current = 0;
      return;
    }
    let cancelled = false;
    let timer = 0;
    const schedule = () => {
      const fallback =
        FALLBACK_DELAYS[Math.min(triesRef.current, FALLBACK_DELAYS.length - 1)];
      // 用刚拉到的列表判断：这一拍已经是就绪态就直接回落，不等下一次渲染。
      // 上一次拉取失败时列表是旧的，按兜底节奏退避；成功一次后自然回到 2 秒。
      const provisioning =
        refreshOkRef.current &&
        fetchedServersRef.current.some((server) =>
          isProvisioning(server.state),
        );
      const delay = provisioning ? PROVISIONING_POLL_MS : fallback;
      timer = window.setTimeout(async () => {
        await refresh();
        if (cancelled) return;
        triesRef.current += 1;
        schedule();
      }, delay);
    };
    schedule();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [shouldPollList, refresh, eventsLive]);

  const selectedFromList =
    servers.find((server) => server.server_id === selectedId) ?? null;
  // 重建后新机器还没进列表时也要能选中：详情以 selectedId 为准。
  const selectedKey = selectedId;
  /** 已选中但还不在列表里（刚下单的新机器）：中间区要显示「正在创建」，不能落空态。 */
  const awaitingSelected =
    selectedId !== null &&
    !servers.some((server) => server.server_id === selectedId);

  // 详情以 my_server_get 为准；列表快照只作首帧占位。
  // 切换节点会改网络路径，在飞的详情请求失败一次是正常的：有数据就保持数据后台重试，
  // 只有在完全没有数据且连续失败约 10 秒后才落到错误态。
  const lastDetailKeyRef = useRef<string | null>(null);
  const detailRetryRef = useRef<{
    key: string;
    attempt: number;
    firstFailedAt: number;
  } | null>(null);
  useEffect(() => {
    if (lastDetailKeyRef.current !== selectedKey) {
      lastDetailKeyRef.current = selectedKey;
      setDetailError(null);
      // 上一台的「正在重试」不能带到这一台：新机器的请求落地前按钮就该可点。
      setDetailRetrying(false);
      detailRetryRef.current = null;
    }
    if (!selectedKey) {
      setDetail(null);
      setDetailError(null);
      setDetailRetrying(false);
      detailRetryRef.current = null;
      return;
    }
    if (!active) return;
    let alive = true;
    let timer = 0;
    const record = detailRetryRef.current?.key === selectedKey
      ? detailRetryRef.current
      : { key: selectedKey, attempt: 0, firstFailedAt: 0 };
    detailRetryRef.current = record;

    const run = (): void => {
      bridge
        .myServerGet(selectedKey)
        .then((server) => {
          if (!alive) return;
          setDetail(server);
          setDetailError(null);
          setDetailRetrying(false);
          detailRetryRef.current = { key: selectedKey, attempt: 0, firstFailedAt: 0 };
        })
        .catch(() => {
          if (!alive) return;
          setDetailRetrying(false);
          const now = Date.now();
          if (!record.firstFailedAt) record.firstFailedAt = now;
          const elapsed = now - record.firstFailedAt;
          const hasData = selectedNowRef.current !== null;
          const gaveUp = !hasData && elapsed >= DETAIL_ERROR_AFTER_MS;
          if (hasData) {
            // 详情或列表快照还能读：保持现有数据，不打扰用户，后台退避重试。
            setDetailError(null);
          } else if (gaveUp) {
            // 错误态也继续重试（8s 封顶）：网络恢复后自动清错，手动重试只是兜底。
            setDetailError(t("myservers.error.detail"));
          }
          record.attempt += 1;
          const backoff =
            DETAIL_RETRY_DELAYS[
              Math.min(record.attempt - 1, DETAIL_RETRY_DELAYS.length - 1)
            ];
          // 没有可读数据时把下一次尝试对齐到 10 秒整点，别让退避拖后报错时间。
          const delay =
            hasData || gaveUp
              ? backoff
              : Math.min(backoff, DETAIL_ERROR_AFTER_MS - elapsed);
          timer = window.setTimeout(run, delay);
        });
    };
    run();
    return () => {
      alive = false;
      if (timer) window.clearTimeout(timer);
    };
  }, [active, bridge, selectedKey, revision]);

  const selected =
    detail && detail.server_id === selectedKey ? detail : selectedFromList;
  /** 失败时「还有没有可读数据」取最新渲染值；避免把详情状态放进请求依赖。 */
  const selectedNowRef = useRef<MyServer | null>(selected);
  useEffect(() => {
    selectedNowRef.current = selected;
  }, [selected]);

  const retryDetail = () => {
    setDetailRetrying(true);
    setRevision((value) => value + 1);
  };

  /** 改名成功：用返回的完整对象同时更新列表与详情，不二次拉取。 */
  const renamed = (server: MyServer) => {
    setServers((current) =>
      current.map((item) => (item.server_id === server.server_id ? server : item)),
    );
    setDetail((current) =>
      current && current.server_id === server.server_id ? server : current,
    );
  };

  const select = (serverId: string) => {
    setPendingServer(false);
    setSelectedId(serverId);
    setView("detail");
  };

  const resetToRoot = () => {
    pendingBaselineRef.current = null;
    setPendingServer(false);
    setSelectedId(null);
    setView("wizard");
  };

  const openWizard = () => {
    setView("wizard");
  };

  const reRegister = async (): Promise<boolean> => {
    const register = (bridge as RegisterCapable).myServerRegisterDevice;
    try {
      if (register) await register.call(bridge);
      setIdentityLostState(false);
      setBlockedState(null);
      const ok = await refresh();
      if (ok) setIdentityMissing(false);
      // 设备换了：账户态也要重读，别继续显示被停用账户的邮箱。
      void refreshAccount();
      return ok;
    } catch {
      setError(t("myservers.error.register"));
      return false;
    }
  };

  /** 点「创建服务器」时确认登录与身份；未登录先弹登录框，原选择不动。 */
  const ensureIdentity = useCallback(async (): Promise<boolean> => {
    if (account && !account.logged_in) {
      setLoginOpen(true);
      return false;
    }
    const source = (bridge as IdentityCapable).myServerIdentity;
    if (!source) {
      setIdentityPresent(true);
      return true;
    }
    let has = false;
    try {
      has = (await source.call(bridge)).has_identity;
    } catch {
      has = false;
    }
    if (has) {
      setIdentityPresent(true);
      return true;
    }
    // 保持创建表单在场；身份状态等下单成功后再放开（ordered）。
    return refresh();
  }, [account, bridge, refresh]);

  /** 左栏底部的登录状态按钮：按身份状态做一次身份动作。 */
  const identityAction = async (): Promise<boolean> => {
    if (identityLostState || blockedState) {
      return reRegister();
    }
    const ok = await ensureIdentity();
    if (ok) setIdentityMissing(false);
    return ok;
  };

  const loginStart = async (email: string): Promise<MyServerLoginTicket> => {
    const source = (bridge as AccountCapable).myServerLoginStart;
    if (!source) {
      throw { code: "UNSUPPORTED", message: t("myservers.error.loginUnsupported"), retryable: false };
    }
    return source.call(bridge, email);
  };

  const loginVerify = async (
    email: string,
    code: string,
  ): Promise<MyServerAccount> => {
    const source = (bridge as AccountCapable).myServerLoginVerify;
    if (!source) {
      throw { code: "UNSUPPORTED", message: t("myservers.error.loginUnsupported"), retryable: false };
    }
    const next = await source.call(bridge, email, code);
    // 换了账户：上一个账户的余额与门禁时间都不能留；同一账户重登沿用缓存。
    if (next.logged_in && next.account_id !== account?.account_id) resetWallet();
    loggedInRef.current = next.logged_in;
    setAccount(next);
    setAccountLoaded(true);
    setIdentityLostState(false);
    setIdentityMissing(!next.logged_in);
    setIdentityPresent(next.logged_in);
    setLoginOpen(false);
    if (next.logged_in) {
      void refresh();
      void refreshWallet({ trigger: "login" });
    }
    return next;
  };

  const logout = async (): Promise<LogoutResult> => {
    const source = (bridge as AccountCapable).myServerLogout;
    if (!source) return { ok: false, message: t("myservers.error.loginUnsupported") };
    // Host 可能先发 account-cleared 再返回；事件与这次调用是同一件事。
    selfLogoutAtRef.current = Date.now();
    try {
      const next = await source.call(bridge);
      setAccount(next);
      setAccountLoaded(true);
      setIdentityLostState(false);
      setTopupOpen(false);
      markLoggedOut();
      setView("wizard");
      return { ok: true };
    } catch (error) {
      selfLogoutAtRef.current = 0;
      const problem = toBridgeError(error);
      const reason = errorReason(error);
      const offline =
        AUTH_REASONS.has(reason) ||
        problem.code === "TIMEOUT" ||
        problem.code === "NETWORK";
      const message = offline
        ? t("myservers.error.logoutOffline")
        : errorText(error, t("myservers.error.logoutFailed"));
      return { ok: false, message };
    }
  };

  const topup = async (denominationCents: number): Promise<MyServerTopup> => {
    const source = (bridge as AccountCapable).myServerTopup;
    if (!source) {
      throw { code: "UNSUPPORTED", message: t("myservers.error.topupUnsupported"), retryable: false };
    }
    const result = await source.call(bridge, denominationCents);
    // 服务端一定返回 checkout_url，Host 已用系统浏览器打开。
    return result;
  };

  const openLogin = () => setLoginOpen(true);
  const closeLogin = () => setLoginOpen(false);

  /**
   * 查看账单前的登录校验：只在购买服务器和查看账单时需要登录。
   * Host 回 auth_required 时沿用同一套登录弹窗；返回值告诉调用方要不要继续。
   */
  const requestBills = useCallback(async (): Promise<boolean> => {
    if (!loggedIn) {
      setLoginOpen(true);
      return false;
    }
    const source = (bridge as AccountCapable).myServerWallet;
    if (!source) return true;
    try {
      await source.call(bridge);
      return true;
    } catch (error) {
      if (AUTH_REASONS.has(errorReason(error))) {
        setLoginOpen(true);
        return false;
      }
      // 余额读不到不影响账单入口；账单接口接入后按它自己的错误处理。
      return true;
    }
  }, [bridge, loggedIn]);
  const openTopUp = () => {
    setTopupOpen(true);
    void refreshWallet({ trigger: "topup" });
  };
  const closeTopUp = () => setTopupOpen(false);

  const ordered = (serverId: string | null) => {
    pinnedSelectionRef.current = serverId;
    pendingBaselineRef.current =
      serverId === null ? new Set(servers.map((server) => server.server_id)) : null;
    setPendingServer(serverId === null);
    setView(serverId ? "detail" : "wizard");
    setSelectedId(serverId);
    setIdentityMissing(false);
    setIdentityPresent(true);
    void refresh();
    void refreshWallet({ trigger: "order" });
  };

  /** 销毁一台服务器之后：没有选中，让默认选择落到剩下的第一台。 */
  const clearSelection = () => {
    pinnedSelectionRef.current = null;
    pendingBaselineRef.current = null;
    setPendingServer(false);
    setSelectedId(null);
    setView("wizard");
    void refresh();
    void refreshWallet({ trigger: "order" });
  };

  /**
   * 停机删除的墓碑：删掉本地节点，这一行立刻收起，不等列表刷新。
   * 节点删掉后 Host 会发 node-list-changed，连接页那边自己重拉配置。
   */
  const forgetServer = useCallback(
    async (serverId: string, nodeId: string) => {
      await bridge.nodeForget({ nodeId });
      forgottenRef.current.add(serverId);
      setServers((current) =>
        current.filter((server) => server.server_id !== serverId),
      );
      setSelectedId((current) => (current === serverId ? null : current));
      setDetail((current) => (current?.server_id === serverId ? null : current));
      void refresh();
    },
    [bridge, refresh],
  );

  /** 重建成功：立刻选中新机器，详情先按旧数据 + 新状态占位，随后由列表/详情刷新收敛。 */
  const rebuilt = (serverId: string, state: MyServerState) => {
    pinnedSelectionRef.current = serverId;
    setPendingServer(false);
    setView("detail");
    setSelectedId(serverId);
    setDetail((current) =>
      current
        ? {
            ...current,
            server_id: serverId,
            state,
            node_id: null,
            local_node_id: null,
            failure: null,
          }
        : current,
    );
    setDetailError(null);
    setIdentityMissing(false);
    setIdentityPresent(true);
    void refresh();
    void refreshWallet({ trigger: "order" });
  };

  /** 进入了「我的服务器」：建机向导要用余额判断日价 × 7 门槛。聚焦补刷由下面的 effect 统一管。 */
  useEffect(() => {
    if (!active || !loggedIn) return;
    void refreshWallet({ trigger: "open_servers" });
  }, [active, loggedIn, refreshWallet]);

  // 不做定时轮询：余额只因充值和每小时第 17 分的 cron 扣费变化，自主变化每天最多一次，
  // 为它定时发请求不划算。只在窗口重新可见 / 重新聚焦时补刷一次，补刷同走 30 秒门禁。
  useEffect(() => {
    if (!loggedIn) return;
    const onFocus = () => void refreshWallet({ trigger: "focus" });
    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        hiddenLoggedRef.current = false;
        void refreshWallet({ trigger: "visible" });
      } else if (!hiddenLoggedRef.current) {
        // 只在可见→隐藏的这一刻记一条；隐藏期间没有定时器，不会重复刷屏。
        hiddenLoggedRef.current = true;
        uiLog("debug", "refresh skipped reason=hidden");
      }
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [loggedIn, refreshWallet]);

  /**
   * 自动选中只跟列表快照走：`selectedId` 自己变成 null（例如刚销毁完清选中）
   * 时不能拿**旧列表**回填，否则会选中一台刷新后已经不存在的机器。
   */
  const selectedIdRef = useRef(selectedId);
  useEffect(() => {
    selectedIdRef.current = selectedId;
  }, [selectedId]);

  // 列表刷新后按刷新过的快照决定选中：选中的那台还在就保持；已经不在了就清掉，
  // 让中间区回到空态；没有选中时默认选第一台。
  // 下单/重建显式选中的新机器在列表刷新前要保住，不能被默认选择盖掉。
  useEffect(() => {
    if (!active) return;
    // 已下单但还认不出是哪台：别把用户扔进任意一台别人的机器。
    if (pendingServer) return;
    const current = selectedIdRef.current;
    const pinned = pinnedSelectionRef.current;
    const inList = (id: string) =>
      servers.some((server) => server.server_id === id);
    if (current !== null) {
      if (inList(current)) {
        pinnedSelectionRef.current = null;
        return;
      }
      // 刚下单/重建的新机器还没进列表：先等它，别当成消失了。
      if (pinned === current) return;
      // 列表已刷新且没有它：清掉选中，回空态，不落到别的机器上。
      pinnedSelectionRef.current = null;
      setSelectedId(null);
      return;
    }
    if (pinned) {
      if (!inList(pinned)) return;
      pinnedSelectionRef.current = null;
      setSelectedId(pinned);
      return;
    }
    if (servers.length === 0) return;
    setSelectedId(servers[0].server_id);
  }, [active, servers, pendingServer]);

  const lastRootSignalRef = useRef(rootSignal);
  useEffect(() => {
    if (rootSignal === lastRootSignalRef.current) return;
    lastRootSignalRef.current = rootSignal;
    setSelectedId(null);
    setView("wizard");
  }, [rootSignal]);

  const identityProblem: "lost" | "device_revoked" | "account_blocked" | null =
    blockedState ?? (identityLostState ? "lost" : null);
  /** 显示的是旧值：刷新失败且手上还有上次的余额（从没取到值走 walletError）。 */
  const walletStale = wallet !== null && walletFailed;
  /** 「读取中」只属于从未取到值的场景；已有值刷新时继续显示旧值。 */
  const walletLoading = walletInFlight && wallet === null;
  /** 陈旧只在翻转时落一条日志，别每拍刷。 */
  const staleLoggedRef = useRef(false);
  useEffect(() => {
    if (staleLoggedRef.current === walletStale) return;
    staleLoggedRef.current = walletStale;
    const idle = walletSuccessAtRef.current
      ? Date.now() - walletSuccessAtRef.current
      : 0;
    uiLog(
      walletStale ? "warn" : "debug",
      `stale changed value=${walletStale} idle_ms=${idle}`,
    );
  }, [walletStale]);

  return {
    servers,
    catalog,
    loading,
    error,
    refresh,
    applyServers,
    selected,
    selectedId: selected?.server_id ?? null,
    pendingServer,
    awaitingSelected,
    detailError,
    detailRetrying,
    retryDetail,
    identityLost: identityLostState,
    identityProblem,
    identityMissing,
    identityPresent,
    account,
    accountLoaded,
    accountError,
    refreshAccount,
    loggedIn,
    wallet,
    walletLoading,
    walletRefreshing: walletInFlight,
    walletError,
    walletStale,
    refreshWallet,
    loginOpen,
    openLogin,
    closeLogin,
    requestBills,
    loginStart,
    loginVerify,
    topupOpen,
    openTopUp,
    closeTopUp,
    topup,
    logout,
    retrying,
    retryNotice,
    retry,
    view,
    select,
    resetToRoot,
    clearSelection,
    forgetServer,
    renamed,
    openWizard,
    ensureIdentity,
    identityAction,
    reRegister,
    ordered,
    rebuilt,
  };
}
