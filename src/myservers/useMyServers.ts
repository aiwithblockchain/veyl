import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentBridge, MyServer, MyServerCatalog, MyServerState } from "../agent/bridge";
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
      if (identityLost(err)) {
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
  }, [bridge]);

  /** 列表失败后的手动重试；成功就地恢复列表，不跳页。 */
  const retry = useCallback(async () => {
    setRetrying(true);
    setRetryNotice(null);
    const ok = await refresh();
    setRetrying(false);
    if (ok) setRetryNotice("已重新读取服务器列表。");
  }, [refresh]);

  // 打开页面只读公开目录；身份是本地检查，没身份时不请求列表。
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

    const source = (bridge as IdentityCapable).myServerIdentity;
    if (!source) {
      // Host 还没接身份命令：保持现有行为，直接拉列表。
      setIdentityPresent(true);
      void refresh();
      return () => {
        alive = false;
      };
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

    return () => {
      alive = false;
    };
  }, [bridge, refresh]);

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
    if (!provisioning || eventsLive) {
      if (!provisioning) triesRef.current = 0;
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
  const selectedKey = selectedFromList?.server_id ?? null;

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

  /** 点「创建服务器」时才确认身份；没有身份就让 Host 在首次列表请求里懒注册。 */
  const ensureIdentity = useCallback(async (): Promise<boolean> => {
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
  }, [bridge, refresh]);

  /** 左栏底部的登录状态按钮：按身份状态做一次身份动作。 */
  const identityAction = async () => {
    if (identityLostState) {
      await reRegister();
      return;
    }
    const ok = await ensureIdentity();
    if (ok) setIdentityMissing(false);
  };

  const ordered = (serverId: string | null) => {
    setView("detail");
    setIdentityMissing(false);
    setIdentityPresent(true);
    if (serverId) setSelectedId(serverId);
    void refresh();
  };

  const viewRef = useRef(view);
  viewRef.current = view;
  useEffect(() => {
    if (!active) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (viewRef.current === "detail") {
        setSelectedId(null);
        setView("wizard");
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [active]);

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
  };
}
