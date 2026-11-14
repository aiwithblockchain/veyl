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
const IDENTITY_LOST =
  "这台设备的身份已丢失。已买的服务器仍在计费，这里无法管理。";

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

/** 「我的服务器」destination：左栏列表 + 中间选中那台。 */
export function useMyServers(bridge: AgentBridge, { active, rootSignal }: Options) {
  const [servers, setServers] = useState<MyServer[]>([]);
  const [catalog, setCatalog] = useState<MyServerCatalog | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [identity, setIdentity] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<MyServer | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [view, setView] = useState<ServersView>("detail");
  const [confirmLeave, setConfirmLeave] = useState(false);
  /** 已收到过 my-server-changed：事件在，就关掉兜底轮询。 */
  const [eventsLive, setEventsLive] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const result = await bridge.myServerList();
      setServers(result.servers);
      setError(null);
      setIdentity(false);
      setRevision((value) => value + 1);
    } catch (err) {
      if (identityLost(err)) {
        setIdentity(true);
        setError(null);
      } else {
        setError(LIST_ERROR);
      }
    } finally {
      setLoading(false);
    }
  }, [bridge]);

  // 目录给向导用；失败时向导自己显示读取失败与重试。
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
    void refresh();
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
    servers.find((server) => server.server_id === selectedId) ?? servers[0] ?? null;
  const selectedKey = selectedFromList?.server_id ?? null;

  // 详情以 my_server_get 为准；列表快照只作首帧占位。
  useEffect(() => {
    if (!selectedKey) {
      setDetail(null);
      setDetailError(null);
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
      });
    return () => {
      alive = false;
    };
  }, [active, bridge, selectedKey, revision]);

  const selected =
    detail && detail.server_id === selectedKey ? detail : selectedFromList;

  const select = (serverId: string) => {
    setSelectedId(serverId);
    setView("detail");
    setConfirmLeave(false);
  };

  const resetToRoot = () => {
    setSelectedId(null);
    setView("detail");
    setConfirmLeave(false);
  };

  const openWizard = () => {
    setConfirmLeave(false);
    setView("wizard");
  };

  const reRegister = async () => {
    const register = (bridge as RegisterCapable).myServerRegisterDevice;
    try {
      if (register) await register.call(bridge);
      setIdentity(false);
      await refresh();
    } catch {
      setError(LIST_ERROR);
    }
  };

  const leaveWizard = () => {
    setConfirmLeave(false);
    setView("detail");
  };

  const ordered = (serverId: string | null) => {
    setConfirmLeave(false);
    setView("detail");
    if (serverId) setSelectedId(serverId);
    void refresh();
  };

  const viewRef = useRef(view);
  viewRef.current = view;
  useEffect(() => {
    if (!active) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || confirmLeave) return;
      if (viewRef.current === "wizard") setConfirmLeave(true);
      else {
        setSelectedId(null);
        setView("detail");
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [active, confirmLeave]);

  const lastRootSignalRef = useRef(rootSignal);
  useEffect(() => {
    if (rootSignal === lastRootSignalRef.current) return;
    lastRootSignalRef.current = rootSignal;
    if (viewRef.current === "wizard") setConfirmLeave(true);
    else {
      setSelectedId(null);
      setView("detail");
    }
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
    identityLost: identity,
    identityMessage: IDENTITY_LOST,
    view,
    confirmLeave,
    select,
    resetToRoot,
    openWizard,
    reRegister,
    leaveWizard,
    requestLeaveWizard: () => setConfirmLeave(true),
    keepWizard: () => setConfirmLeave(false),
    ordered,
  };
}
