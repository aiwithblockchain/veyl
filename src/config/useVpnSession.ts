import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentBridge } from "../agent/bridge";
import { toBridgeError } from "../agent/errors";
import { AGENT_EVENTS } from "../agent/protocol";
import type { ConfigDetail, ConfigSummary, RuntimeSnapshot } from "../agent/protocol";
import type { ConnectMode } from "./model";
import { createMockConfig, summarizeConfig } from "./model";
import { deleteConfigWithDisconnect, shouldDisconnectOnDelete, withoutConfig } from "./deleteConfig";

export type VpnConnectionState = "idle" | "starting" | "connected" | "stopping";

export interface ActionResult {
  ok: boolean;
  activated?: boolean;
  message?: string;
}

export interface ProbeResult {
  ok: boolean;
  latencyMs: number | null;
  message?: string;
  /** 命令成功但节点不可达；命令本身失败时为 false。 */
  unreachable: boolean;
}

export interface VpnSession {
  configs: ConfigSummary[];
  activeConfigId: string | null;
  activeConfig: ConfigDetail | null;
  connection: VpnConnectionState;
  connectedConfigId: string | null;
  loading: boolean;
  error: string | null;
  /** 后端还没实现命令时，界面不再让用户点到必然失败的按钮。 */
  nodeSwitchAvailable: boolean;
  nodeProbeAvailable: boolean;
  createConfig: (name: string, mode: ConnectMode) => Promise<ActionResult>;
  deleteConfig: (configId: string) => Promise<ActionResult>;
  selectConfig: (configId: string, confirmDisconnect?: boolean) => Promise<ActionResult>;
  switchNode: (nodeId: string) => Promise<ActionResult>;
  start: () => Promise<ActionResult>;
  stop: () => Promise<ActionResult>;
  probe: (nodeId: string) => Promise<ProbeResult>;
}

interface MockStore {
  configs: ConfigDetail[];
  activeId: string | null;
}

const MOCK_STORAGE_KEY = "veyl.configs.mock.v1";

function readMock(): MockStore {
  try {
    const raw = localStorage.getItem(MOCK_STORAGE_KEY);
    if (!raw) return { configs: [], activeId: null };
    const parsed = JSON.parse(raw) as Partial<MockStore>;
    if (!Array.isArray(parsed.configs)) return { configs: [], activeId: null };
    const configs = parsed.configs.filter(
      (config): config is ConfigDetail =>
        Boolean(config) && typeof config.config_id === "string" && Array.isArray(config.nodes),
    );
    const activeId = configs.some((config) => config.config_id === parsed.activeId)
      ? parsed.activeId ?? null
      : configs[0]?.config_id ?? null;
    return { configs, activeId };
  } catch {
    return { configs: [], activeId: null };
  }
}

function toConnectionState(state: RuntimeSnapshot["state"]): VpnConnectionState {
  if (state === "starting" || state === "restarting") return "starting";
  if (state === "stopping") return "stopping";
  if (state === "running" || state === "degraded") return "connected";
  return "idle";
}

function actionMessage(error: unknown, fallback: string): string {
  const bridgeError = toBridgeError(error);
  return bridgeError.message || fallback;
}

/** Tauri 对未注册命令的报错形如 `Command node_probe not found`。 */
function isMissingCommand(error: unknown): boolean {
  const message = toBridgeError(error).message;
  return /unknown command/i.test(message) || /command\s+\S+\s+not\s+found/i.test(message);
}

/**
 * 配置与连接状态。默认走真实命令；`mock` 只在 VITE_MOCK=1（或浏览器里的
 * mock 通道）时启用，供离线演示与测试用。
 */
export function useVpnSession(bridge: AgentBridge, mock: boolean): VpnSession {
  const [configs, setConfigs] = useState<ConfigSummary[]>([]);
  const [activeConfigId, setActiveConfigId] = useState<string | null>(null);
  const [activeConfig, setActiveConfig] = useState<ConfigDetail | null>(null);
  const [connection, setConnection] = useState<VpnConnectionState>("idle");
  const [connectedConfigId, setConnectedConfigId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nodeSwitchAvailable, setNodeSwitchAvailable] = useState(true);
  const [nodeProbeAvailable, setNodeProbeAvailable] = useState(true);

  const mockStore = useRef<MockStore>({ configs: [], activeId: null });
  const timer = useRef<number | null>(null);
  const pendingConfigIdRef = useRef<string | null>(null);
  const disposed = useRef(false);

  const clearTimer = () => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
  };

  useEffect(() => clearTimer, []);

  const applySnapshot = useCallback((snap: RuntimeSnapshot | null) => {
    if (!snap) {
      setConnection("idle");
      setConnectedConfigId(null);
      return;
    }
    setConnection(toConnectionState(snap.state));
    setConnectedConfigId(
      snap.state === "running" || snap.state === "degraded" ? snap.config_id : null,
    );
  }, []);

  const applyMock = useCallback((store: MockStore) => {
    setConfigs(store.configs.map((config) => summarizeConfig(config, store.activeId)));
    setActiveConfigId(store.activeId);
    setActiveConfig(
      store.configs.find((config) => config.config_id === store.activeId) ?? null,
    );
  }, []);

  const commitMock = useCallback(
    (store: MockStore) => {
      mockStore.current = store;
      try {
        localStorage.setItem(MOCK_STORAGE_KEY, JSON.stringify(store));
      } catch {
        // 存不了就只在本次会话里保留。
      }
      applyMock(store);
    },
    [applyMock],
  );

  const refreshReal = useCallback(async () => {
    try {
      const list = await bridge.configList();
      if (disposed.current) return;
      setConfigs(list.configs);
      setActiveConfigId(list.active_config_id);

      let detail: ConfigDetail | null = null;
      if (list.active_config_id) {
        try {
          detail = await bridge.configDetail(list.active_config_id);
        } catch {
          if (!disposed.current) setError("读取节点详情失败。");
        }
      }
      if (disposed.current) return;
      setActiveConfig(detail);

      const snap = await bridge.getRuntimeSnapshot();
      if (!disposed.current) applySnapshot(snap);
      if (detail !== null || list.active_config_id === null) setError(null);
    } catch (err) {
      if (!disposed.current) setError(actionMessage(err, "读取配置失败"));
    }
  }, [bridge, applySnapshot]);

  useEffect(() => {
    disposed.current = false;
    setLoading(true);
    if (mock) {
      const store = readMock();
      mockStore.current = store;
      applyMock(store);
      setLoading(false);
      return () => {
        disposed.current = true;
      };
    }

    void refreshReal().finally(() => {
      if (!disposed.current) setLoading(false);
    });
    return () => {
      disposed.current = true;
    };
  }, [mock, refreshReal, applyMock]);

  useEffect(() => {
    if (mock) return;
    return bridge.subscribe((event) => {
      if (event.name === AGENT_EVENTS.runtimeStateChanged) {
        // 先按事件把按钮状态切过去，别等快照：两者之间隔着一次 IPC，
        // 这期间中间区已经按新 state 渲染，顶部却还停在旧文案。
        setConnection(toConnectionState(event.payload.to));
        void bridge.getRuntimeSnapshot().then((snap) => {
          if (!disposed.current) applySnapshot(snap);
        });
        return;
      }
      if (
        event.name === AGENT_EVENTS.configChanged ||
        event.name === AGENT_EVENTS.nodeListChanged ||
        event.name === AGENT_EVENTS.nodeSwitched
      ) {
        void refreshReal();
      }
    });
  }, [bridge, mock, applySnapshot, refreshReal]);

  const createConfig = async (
    name: string,
    mode: ConnectMode,
  ): Promise<ActionResult> => {
    if (mock) {
      const detail = createMockConfig(name, mode);
      const store = mockStore.current;
      const connected = connection === "connected" || connection === "starting";
      const activate = !connected || store.activeId === null;
      commitMock({
        configs: [...store.configs, detail],
        activeId: activate ? detail.config_id : store.activeId,
      });
      return { ok: true, activated: activate };
    }

    const input = {
      name,
      connectMode: mode,
      routingMode: "proxy_all" as const,
      source: "seed" as const,
    };

    try {
      const created = await bridge.configCreate(input);
      await refreshReal();
      return { ok: true, activated: created.is_active };
    } catch (err) {
      // 全新安装时种子里还没有节点：先刷新一次种子再重试，避免「新建配置」直接撞墙。
      if (toBridgeError(err).details?.reason === "seed_unavailable") {
        try {
          await bridge.defaultProfileRefresh();
          const created = await bridge.configCreate(input);
          await refreshReal();
          return { ok: true, activated: created.is_active };
        } catch (retryErr) {
          return { ok: false, message: actionMessage(retryErr, "创建配置失败") };
        }
      }
      return { ok: false, message: actionMessage(err, "创建配置失败") };
    }
  };

  const selectConfig = async (
    configId: string,
    confirmDisconnect = false,
  ): Promise<ActionResult> => {
    if (mock) {
      const store = mockStore.current;
      if (store.activeId === configId) return { ok: true };
      if (!store.configs.some((config) => config.config_id === configId)) {
        return { ok: false, message: "这套配置已经不存在了。" };
      }

      clearTimer();
      commitMock({ ...store, activeId: configId });
      if (connection === "connected" || connection === "starting") {
        setConnection("starting");
        setConnectedConfigId(null);
        pendingConfigIdRef.current = configId;
        timer.current = window.setTimeout(() => {
          timer.current = null;
          pendingConfigIdRef.current = null;
          setConnection("connected");
          setConnectedConfigId(configId);
        }, 700);
      } else {
        setConnection("idle");
        setConnectedConfigId(null);
      }
      return { ok: true };
    }

    try {
      const result = await bridge.configActivate(configId, confirmDisconnect);
      await refreshReal();
      if (result.reconnect === "reconnect_failed") {
        return { ok: true, message: "已切换配置，但没能重新连上。" };
      }
      if (result.reconnect === "skipped_no_nodes") {
        return { ok: true, message: "已切换配置。这套还没有节点，没有自动连接。" };
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, message: actionMessage(err, "切换配置失败") };
    }
  };

  const switchNode = async (nodeId: string): Promise<ActionResult> => {
    if (mock) {
      const store = mockStore.current;
      if (!store.activeId) return { ok: false, message: "还没有配置。" };
      commitMock({
        ...store,
        configs: store.configs.map((config) =>
          config.config_id === store.activeId
            ? { ...config, current_node_id: nodeId }
            : config,
        ),
      });
      return { ok: true };
    }

    if (!activeConfigId) return { ok: false, message: "还没有配置。" };
    try {
      await bridge.nodeSwitch(activeConfigId, nodeId);
      await refreshReal();
      return { ok: true };
    } catch (err) {
      await refreshReal();
      if (isMissingCommand(err)) {
        setNodeSwitchAvailable(false);
        return { ok: false, message: "这个版本还不能切换节点。" };
      }
      return { ok: false, message: actionMessage(err, "切换节点失败") };
    }
  };

  const start = async (): Promise<ActionResult> => {
    if (!activeConfigId) return { ok: false, message: "还没有配置。" };
    if (!activeConfig || activeConfig.node_count === 0) {
      return { ok: false, message: "这套配置还没有节点。" };
    }

    if (mock) {
      clearTimer();
      setConnection("starting");
      setConnectedConfigId(null);
      const configId = activeConfigId;
      pendingConfigIdRef.current = configId;
      // 同时驱动 mock 运行时的状态事件，让面板按真实事件流更新。
      void bridge.runtimeStart(configId).catch(() => undefined);
      timer.current = window.setTimeout(() => {
        timer.current = null;
        pendingConfigIdRef.current = null;
        setConnection("connected");
        setConnectedConfigId(configId);
      }, 700);
      return { ok: true };
    }

    try {
      setConnection("starting");
      setConnectedConfigId(null);
      await bridge.runtimeStart(activeConfigId);
      await refreshReal();
      return { ok: true };
    } catch (err) {
      await refreshReal();
      return { ok: false, message: actionMessage(err, "启动失败") };
    }
  };

  const stop = async (): Promise<ActionResult> => {
    if (mock) {
      clearTimer();
      pendingConfigIdRef.current = null;
      setConnection("stopping");
      void bridge.runtimeStop().catch(() => undefined);
      timer.current = window.setTimeout(() => {
        timer.current = null;
        setConnection("idle");
        setConnectedConfigId(null);
      }, 400);
      return { ok: true };
    }

    try {
      setConnection("stopping");
      await bridge.runtimeStop();
      await refreshReal();
      return { ok: true };
    } catch (err) {
      await refreshReal();
      return { ok: false, message: actionMessage(err, "断开失败") };
    }
  };

  const deleteConfig = async (configId: string): Promise<ActionResult> => {
    if (mock) {
      const store = mockStore.current;
      if (!store.configs.some((config) => config.config_id === configId)) {
        return { ok: true };
      }
      if (
        shouldDisconnectOnDelete({
          configId,
          connectedConfigId,
          pendingConfigId: pendingConfigIdRef.current,
        })
      ) {
        clearTimer();
        pendingConfigIdRef.current = null;
        setConnection("idle");
        setConnectedConfigId(null);
      }
      const next = withoutConfig(store.configs, store.activeId, configId);
      commitMock({ configs: next.configs, activeId: next.activeId });
      return { ok: true };
    }

    return deleteConfigWithDisconnect({
      configId,
      connectedConfigId,
      disconnect: stop,
      remove: async () => {
        const result = await bridge.configDelete(configId);
        setActiveConfigId(result.active_config_id);
        if (result.active_config_id === null) setActiveConfig(null);
        await refreshReal();
        return result;
      },
    });
  };

  const probe = async (nodeId: string): Promise<ProbeResult> => {
    if (mock) {
      await new Promise((resolve) => window.setTimeout(resolve, 600));
      const node = activeConfig?.nodes.find((item) => item.node_id === nodeId);
      return { ok: true, latencyMs: 32 + ((node?.port ?? 80) % 41), unreachable: false };
    }

    try {
      const result = await bridge.nodeProbe(nodeId);
      return {
        ok: result.reachable,
        latencyMs: result.latency_ms,
        message: result.error?.message,
        unreachable: !result.reachable,
      };
    } catch (err) {
      if (isMissingCommand(err)) {
        setNodeProbeAvailable(false);
        return {
          ok: false,
          latencyMs: null,
          message: "这个版本还不能测试连通。",
          unreachable: false,
        };
      }
      return {
        ok: false,
        latencyMs: null,
        message: actionMessage(err, "测试失败"),
        unreachable: false,
      };
    }
  };

  return {
    configs,
    activeConfigId,
    activeConfig,
    connection,
    connectedConfigId,
    loading,
    error,
    nodeSwitchAvailable,
    nodeProbeAvailable,
    createConfig,
    deleteConfig,
    selectConfig,
    switchNode,
    start,
    stop,
    probe,
  };
}
