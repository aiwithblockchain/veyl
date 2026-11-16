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
import { AGENT_EVENTS } from "../agent/protocol";
import { isProvisioning } from "./labels";

export type ServersView = "detail" | "wizard";

interface Options {
  /** 停在「我的服务器」destination 时才听 Esc。 */
  active: boolean;
  /** 再点一次「我的服务器」图标时递增：回到列表根（默认第一台）。 */
  rootSignal: number;
}

const LIST_ERROR = "读不到你的服务器。已有服务器和节点不受影响；稍后再试。";
const DETAIL_ERROR = "读不到这台服务器。已有服务器和节点不受影响；稍后再试。";
const WALLET_ERROR = "读不到余额。稍后再试。";
const LOGOUT_OFFLINE = "没退出登录。需要联网才能退出；服务器没有变化。";
const LOGOUT_FAILED = "没退出登录。服务器没有变化，可以再试一次。";
const LOGIN_UNSUPPORTED = "这个版本还不支持登录。";

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
const FALLBACK_DELAYS = [2000, 5000, 10_000];

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
  /** 还没有设备身份：列表区只给登录提示，不请求 /v1/servers。 */
  const [identityMissing, setIdentityMissing] = useState(false);
  const [identityPresent, setIdentityPresent] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [retryNotice, setRetryNotice] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
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
  const [wallet, setWallet] = useState<MyServerWallet | null>(null);
  const [walletLoading, setWalletLoading] = useState(false);
  const [walletError, setWalletError] = useState<string | null>(null);
  const [loginOpen, setLoginOpen] = useState(false);
  const [topupOpen, setTopupOpen] = useState(false);

  const loggedIn = account?.logged_in === true;

  const refreshWallet = useCallback(async () => {
    const source = (bridge as AccountCapable).myServerWallet;
    if (!source) return;
    setWalletLoading(true);
    setWalletError(null);
    try {
      setWallet(await source.call(bridge));
    } catch (error) {
      const reason = errorReason(error);
      setWalletError(
        AUTH_REASONS.has(reason)
          ? "登录已过期。重新登录后才能看余额。"
          : WALLET_ERROR,
      );
    } finally {
      setWalletLoading(false);
    }
  }, [bridge]);

  const markLoggedOut = useCallback(() => {
    setAccount((current) =>
      current
        ? { ...current, logged_in: false, email: null, account_kind: "device" }
        : null,
    );
    setIdentityMissing(true);
    setIdentityPresent(false);
    setServers([]);
    setSelectedId(null);
    setDetail(null);
    setWallet(null);
    setWalletError(null);
    setError(null);
    setLoading(false);
  }, []);

  const refresh = useCallback(async (): Promise<boolean> => {
    try {
      const result = await bridge.myServerList();
      setServers(result.servers);
      setError(null);
      setIdentityLostState(false);
      setIdentityPresent(true);
      setRevision((value) => value + 1);
      return true;
    } catch (err) {
      if (AUTH_REASONS.has(errorReason(err))) {
        markLoggedOut();
      } else if (identityLost(err)) {
        setIdentityLostState(true);
        setIdentityPresent(false);
        setError(null);
      } else {
        setError(LIST_ERROR);
      }
      return false;
    } finally {
      setLoading(false);
    }
  }, [bridge, markLoggedOut]);

  /** 列表失败后的手动重试；成功就地恢复列表，不跳页。 */
  const retry = useCallback(async () => {
    setRetrying(true);
    setRetryNotice(null);
    const ok = await refresh();
    setRetrying(false);
    if (ok) setRetryNotice("已重新读取服务器列表。");
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
        setAccount(info);
        setAccountLoaded(true);
        if (info.logged_in) {
          setIdentityMissing(false);
          setIdentityPresent(true);
          void refresh();
          void refreshWallet();
        } else {
          setIdentityMissing(true);
          setIdentityPresent(false);
          setLoading(false);
        }
      })
      .catch(() => {
        if (!alive) return;
        setAccountLoaded(true);
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
      } else if (event.name === AGENT_EVENTS.myServerOrderChanged) {
        void refresh();
      }
    });
  }, [bridge, refresh]);

  const provisioning = servers.some((server) => isProvisioning(server.state));
  const triesRef = useRef(0);
  useEffect(() => {
    // 事件只是加速；只要还有机器在开通中就必须轮询——事件可能漏（例如建机失败被自动销毁）。
    if (!provisioning) {
      triesRef.current = 0;
      return;
    }
    let cancelled = false;
    let timer = 0;
    const schedule = () => {
      const delay = FALLBACK_DELAYS[Math.min(triesRef.current, FALLBACK_DELAYS.length - 1)];
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
  }, [provisioning, refresh, eventsLive]);

  const selectedFromList =
    servers.find((server) => server.server_id === selectedId) ?? null;
  // 重建后新机器还没进列表时也要能选中：详情以 selectedId 为准。
  const selectedKey = selectedId;

  // 详情以 my_server_get 为准；列表快照只作首帧占位。
  const lastDetailKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (lastDetailKeyRef.current !== selectedKey) {
      lastDetailKeyRef.current = selectedKey;
      setDetailError(null);
    }
    if (!selectedKey) {
      setDetail(null);
      setDetailError(null);
      setDetailRetrying(false);
      return;
    }
    if (!active) return;
    let alive = true;
    bridge
      .myServerGet(selectedKey)
      .then((server) => {
        if (!alive) return;
        setDetail(server);
        setDetailError(null);
      })
      .catch(() => {
        if (!alive) return;
        setDetailError(DETAIL_ERROR);
      })
      .finally(() => {
        if (alive) setDetailRetrying(false);
      });
    return () => {
      alive = false;
    };
  }, [active, bridge, selectedKey, revision]);

  const selected =
    detail && detail.server_id === selectedKey ? detail : selectedFromList;

  const retryDetail = () => {
    setDetailRetrying(true);
    setRevision((value) => value + 1);
  };

  const select = (serverId: string) => {
    setSelectedId(serverId);
    setView("detail");
  };

  const resetToRoot = () => {
    setSelectedId(null);
    setView("wizard");
  };

  const openWizard = () => {
    setView("wizard");
  };

  const reRegister = async () => {
    const register = (bridge as RegisterCapable).myServerRegisterDevice;
    try {
      if (register) await register.call(bridge);
      setIdentityLostState(false);
      const ok = await refresh();
      if (ok) setIdentityMissing(false);
    } catch {
      setError(LIST_ERROR);
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
  const identityAction = async () => {
    if (identityLostState) {
      await reRegister();
      return;
    }
    const ok = await ensureIdentity();
    if (ok) setIdentityMissing(false);
  };

  const loginStart = async (email: string): Promise<MyServerLoginTicket> => {
    const source = (bridge as AccountCapable).myServerLoginStart;
    if (!source) {
      throw { code: "UNSUPPORTED", message: LOGIN_UNSUPPORTED, retryable: false };
    }
    return source.call(bridge, email);
  };

  const loginVerify = async (
    email: string,
    code: string,
  ): Promise<MyServerAccount> => {
    const source = (bridge as AccountCapable).myServerLoginVerify;
    if (!source) {
      throw { code: "UNSUPPORTED", message: LOGIN_UNSUPPORTED, retryable: false };
    }
    const next = await source.call(bridge, email, code);
    setAccount(next);
    setAccountLoaded(true);
    setIdentityLostState(false);
    setIdentityMissing(!next.logged_in);
    setIdentityPresent(next.logged_in);
    setLoginOpen(false);
    if (next.logged_in) {
      void refresh();
      void refreshWallet();
    }
    return next;
  };

  const logout = async (): Promise<LogoutResult> => {
    const source = (bridge as AccountCapable).myServerLogout;
    if (!source) return { ok: false, message: LOGIN_UNSUPPORTED };
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
      const problem = toBridgeError(error);
      const reason = errorReason(error);
      const message = AUTH_REASONS.has(reason)
        ? LOGOUT_OFFLINE
        : problem.code === "TIMEOUT" || problem.code === "NETWORK"
          ? LOGOUT_OFFLINE
          : problem.message && problem.message !== "操作失败"
            ? `${problem.message}${problem.message.endsWith("。") ? "" : "。"}服务器没有变化，可以再试一次。`
            : LOGOUT_FAILED;
      return { ok: false, message };
    }
  };

  const topup = async (denominationCents: number): Promise<MyServerTopup> => {
    const source = (bridge as AccountCapable).myServerTopup;
    if (!source) {
      throw { code: "UNSUPPORTED", message: "这个版本还不支持充值。", retryable: false };
    }
    const result = await source.call(bridge, denominationCents);
    // fake 通道没有收银台，直接刷新余额；有 URL 时 Host 已打开浏览器。
    if (!result.checkout_url) await refreshWallet();
    return result;
  };

  const openLogin = () => setLoginOpen(true);
  const closeLogin = () => setLoginOpen(false);
  const openTopUp = () => {
    setTopupOpen(true);
    void refreshWallet();
  };
  const closeTopUp = () => setTopupOpen(false);

  const ordered = (serverId: string | null) => {
    setView(serverId ? "detail" : "wizard");
    setSelectedId(serverId);
    setIdentityMissing(false);
    setIdentityPresent(true);
    void refresh();
    void refreshWallet();
  };

  /** 重建成功：立刻选中新机器，详情先按旧数据 + 新状态占位，随后由列表/详情刷新收敛。 */
  const rebuilt = (serverId: string, state: MyServerState) => {
    setView("detail");
    setSelectedId(serverId);
    setDetail((current) =>
      current
        ? {
            ...current,
            server_id: serverId,
            state,
            node_id: null,
            failure: null,
          }
        : current,
    );
    setDetailError(null);
    setIdentityMissing(false);
    setIdentityPresent(true);
    void refresh();
    void refreshWallet();
  };

  // 回到这个 destination、或从浏览器付完款切回来时，刷新余额。
  useEffect(() => {
    if (!active || !loggedIn) return;
    void refreshWallet();
    const onFocus = () => void refreshWallet();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [active, loggedIn, refreshWallet]);

  const viewRef = useRef(view);
  viewRef.current = view;
  useEffect(() => {
    if (!active) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // 登录 / 充值弹窗自己处理 Esc，别顺带把详情退回创建页。
      if (loginOpen || topupOpen) return;
      if (viewRef.current === "detail") {
        setSelectedId(null);
        setView("wizard");
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [active, loginOpen, topupOpen]);

  const lastRootSignalRef = useRef(rootSignal);
  useEffect(() => {
    if (rootSignal === lastRootSignalRef.current) return;
    lastRootSignalRef.current = rootSignal;
    setSelectedId(null);
    setView("wizard");
  }, [rootSignal]);

  return {
    servers,
    catalog,
    loading,
    error,
    refresh,
    selected,
    selectedId: selected?.server_id ?? null,
    detailError,
    detailRetrying,
    retryDetail,
    identityLost: identityLostState,
    identityMissing,
    identityPresent,
    account,
    accountLoaded,
    loggedIn,
    wallet,
    walletLoading,
    walletError,
    refreshWallet,
    loginOpen,
    openLogin,
    closeLogin,
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
    openWizard,
    ensureIdentity,
    identityAction,
    ordered,
    rebuilt,
  };
}
