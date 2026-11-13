import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentBridge, MyServer, MyServerCatalog } from "../agent/bridge";
import { toBridgeError } from "../agent/errors";
import { readAccount } from "./account";
import { isProvisioning } from "./labels";

export type MyServersView = "detail" | "wizard";

interface Options {
  /** 只有停在服务器 destination 时才读数据、听 Esc。 */
  active: boolean;
  /** 再点一次「服务器」图标时递增。 */
  rootSignal: number;
}

function errorText(error: unknown): string {
  const message = toBridgeError(error).message;
  return message && message !== "操作失败"
    ? message
    : "暂时连不上服务器服务，稍后再试；已有节点不受影响。";
}

/** 服务器 destination 的主从状态：左栏列表 + 中间选中那台。 */
export function useMyServers(bridge: AgentBridge, { active, rootSignal }: Options) {
  const [account, setAccount] = useState<string | null>(() => readAccount());
  const [servers, setServers] = useState<MyServer[]>([]);
  const [catalog, setCatalog] = useState<MyServerCatalog | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  /** null = 用第一台（根视图）；用户点过某一行才有值。 */
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [view, setView] = useState<MyServersView>("detail");
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [loginOpen, setLoginOpen] = useState(false);
  const afterLoginRef = useRef<"wizard" | null>(null);

  const refresh = useCallback(async () => {
    if (!readAccount()) {
      setServers([]);
      setLoading(false);
      return;
    }
    try {
      const result = await bridge.myServerList();
      setServers(result.servers);
      setError(null);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setLoading(false);
    }
  }, [bridge]);

  // 进服务器 destination 时读一次目录和列表。
  useEffect(() => {
    if (!active) return;
    let alive = true;
    void bridge
      .myServerCatalog()
      .then((value) => {
        if (alive) setCatalog(value);
      })
      .catch((err) => {
        if (alive) setError(errorText(err));
      });
    void refresh();
    return () => {
      alive = false;
    };
  }, [active, bridge, refresh]);

  // 有机器正在建时跟着进度轮询。
  const provisioning = servers.some((server) => isProvisioning(server.state));
  useEffect(() => {
    if (!active || !provisioning) return;
    const timer = window.setInterval(() => void refresh(), 350);
    return () => window.clearInterval(timer);
  }, [active, provisioning, refresh]);

  const selected =
    servers.find((server) => server.server_id === selectedId) ?? servers[0] ?? null;

  const select = (serverId: string) => {
    setSelectedId(serverId);
    setView("detail");
    setConfirmLeave(false);
  };

  /** 回根：不指定行，默认落到第一台。 */
  const resetToRoot = () => {
    setSelectedId(null);
    setView("detail");
    setConfirmLeave(false);
  };

  const openLogin = () => {
    afterLoginRef.current = null;
    setLoginOpen(true);
  };

  const openWizard = () => {
    if (!readAccount()) {
      afterLoginRef.current = "wizard";
      setLoginOpen(true);
      return;
    }
    setConfirmLeave(false);
    setView("wizard");
  };

  const closeLogin = () => {
    setLoginOpen(false);
    afterLoginRef.current = null;
  };

  const signedIn = (email: string) => {
    setAccount(email);
    setLoginOpen(false);
    void refresh();
    if (afterLoginRef.current === "wizard") {
      afterLoginRef.current = null;
      setConfirmLeave(false);
      setView("wizard");
    }
  };

  const requestLeaveWizard = () => setConfirmLeave(true);
  const keepWizard = () => setConfirmLeave(false);
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

  // Esc 只在服务器页层级内上移：向导先确认，详情回根。
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

  // 再点已激活的「服务器」图标：向导先确认，详情回根。
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
    account,
    servers,
    catalog,
    loading,
    error,
    selected,
    selectedId: selected?.server_id ?? null,
    view,
    confirmLeave,
    loginOpen,
    select,
    resetToRoot,
    openLogin,
    openWizard,
    closeLogin,
    signedIn,
    requestLeaveWizard,
    keepWizard,
    leaveWizard,
    ordered,
    refresh,
  };
}
