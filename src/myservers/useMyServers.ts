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
/** 设备身份丢了：不是网络问题，重试同一个请求不会变好，只能重新注册。 */
const REGISTER_ERROR = "没能重新注册设备。账户和服务器都还在，检查网络后再试一次。";
const DETAIL_ERROR = "这台服务器的详情暂时读不到。已有服务器和节点不受影响；稍后再试。";
/** 详情请求失败后的后台重试节奏：1s → 2s → 4s → 8s，之后封顶 8s。 */
const DETAIL_RETRY_DELAYS = [1000, 2000, 4000, 8000];
/** 没有任何可读数据时，连续失败累计这么久才给错误；首次失败不报。 */
const DETAIL_ERROR_AFTER_MS = 10_000;
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
  const [walletLoading, setWalletLoading] = useState(false);
  const [walletError, setWalletError] = useState<string | null>(null);
  const [loginOpen, setLoginOpen] = useState(false);
  const [topupOpen, setTopupOpen] = useState(false);

  const loggedIn = account?.logged_in === true;

  const markLoggedOut = useCallback(() => {
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
    setWallet(null);
    setWalletError(null);
    setError(null);
    setLoading(false);
  }, []);

  const refreshWallet = useCallback(async () => {
    const source = (bridge as AccountCapable).myServerWallet;
    if (!source) return;
    setWalletLoading(true);
    setWalletError(null);
    try {
      setWallet(await source.call(bridge));
    } catch (error) {
      const reason = errorReason(error);
      if (AUTH_REASONS.has(reason)) {
        // 登录过期：切回未登录，别让旧邮箱和余额继续显示。
        markLoggedOut();
      } else if (reason === "device_revoked" || reason === "account_blocked") {
        setBlockedState(reason);
        setWalletError(null);
      } else {
        setWalletError(WALLET_ERROR);
      }
    } finally {
      setWalletLoading(false);
    }
  }, [bridge, markLoggedOut]);

  const refresh = useCallback(async (): Promise<boolean> => {
    try {
      const result = await bridge.myServerList();
      setServers(result.servers);
      // 认出新机器就解除「已下单」占位并选中它；还没出现就继续等，别乱选一台旧的。
      const baseline = pendingBaselineRef.current;
      if (baseline) {
        const appeared = result.servers.find(
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
      setIdentityLostState(false);
      setBlockedState(null);
      setIdentityPresent(true);
      setRevision((value) => value + 1);
      return true;
    } catch (err) {
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
        setError(LIST_ERROR);
      }
      return false;
    } finally {
      setLoading(false);
    }
  }, [bridge, markLoggedOut]);

  /** 账户读取失败后重试：只重读身份，不重登。 */
  const refreshAccount = useCallback(async () => {
    const source = (bridge as AccountCapable).myServerAccount;
    if (!source) return;
    setAccountLoaded(false);
    setAccountError(false);
    try {
      const info = await source.call(bridge);
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
    } catch {
      setAccountLoaded(true);
      setAccountError(true);
    }
  }, [bridge, refresh, refreshWallet]);

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
            setDetailError(DETAIL_ERROR);
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
      setError(REGISTER_ERROR);
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
    void refreshWallet();
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
    void refreshWallet();
  };

  /** 销毁一台服务器之后：没有选中，让默认选择落到剩下的第一台。 */
  const clearSelection = () => {
    pinnedSelectionRef.current = null;
    pendingBaselineRef.current = null;
    setPendingServer(false);
    setSelectedId(null);
    setView("wizard");
    void refresh();
    void refreshWallet();
  };

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

  // 有服务器就没有「未选中」：进入或刷新后默认选第一台；消失时选下一台。
  // 下单/重建显式选中的新机器在列表刷新前要保住，不能被默认选择盖掉。
  useEffect(() => {
    if (!active) return;
    // 已下单但还认不出是哪台：别把用户扔进任意一台别人的机器。
    if (pendingServer) return;
    const pinned = pinnedSelectionRef.current;
    if (pinned) {
      if (pinned === selectedId) {
        if (!servers.some((server) => server.server_id === pinned)) return;
      }
      pinnedSelectionRef.current = null;
    }
    if (servers.length === 0) return;
    if (selectedId && servers.some((server) => server.server_id === selectedId)) {
      return;
    }
    setSelectedId(servers[0].server_id);
  }, [active, servers, selectedId, pendingServer]);

  const lastRootSignalRef = useRef(rootSignal);
  useEffect(() => {
    if (rootSignal === lastRootSignalRef.current) return;
    lastRootSignalRef.current = rootSignal;
    setSelectedId(null);
    setView("wizard");
  }, [rootSignal]);

  const identityProblem: "lost" | "device_revoked" | "account_blocked" | null =
    blockedState ?? (identityLostState ? "lost" : null);

  return {
    servers,
    catalog,
    loading,
    error,
    refresh,
    selected,
    selectedId: selected?.server_id ?? null,
    pendingServer,
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
    walletError,
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
    renamed,
    openWizard,
    ensureIdentity,
    identityAction,
    reRegister,
    ordered,
    rebuilt,
  };
}
