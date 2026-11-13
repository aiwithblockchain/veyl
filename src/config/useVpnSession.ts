import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentBridge, ConfigCreateInput } from "../agent/bridge";
import { toBridgeError } from "../agent/errors";
import { AGENT_EVENTS } from "../agent/protocol";
import type {
  ConfigDetail,
  ConfigSummary,
  RuntimeSnapshot,
} from "../agent/protocol";
import { createMockConfig, MOCK_CONFIG_STORAGE_KEY, summarizeConfig } from "./model";
import { createRuntimeAuthority, runtimePhase } from "./runtimeAuthority";
import type { RuntimeAuthority } from "./runtimeAuthority";
import { deleteConfigWithDisconnect, shouldDisconnectOnDelete, withoutConfig } from "./deleteConfig";

export type VpnConnectionState = "idle" | "starting" | "connected" | "stopping";

export interface ActionResult {
  ok: boolean;
  activated?: boolean;
  message?: string;
  /** 这次 start 真的把运行时连上了（不是重入、取消或被作废的空返回）。 */
  connected?: boolean;
  /** 这次 stop 真的把运行时断开了（不是重入或失败的返回）。 */
  stopped?: boolean;
  /** 后端 `details.reason`；界面需要按原因分支时用，不解析 message。 */
  reason?: string;
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
  /** 正在启动的那套配置；starting 期间取，其余状态为 null。 */
  startingConfigId: string | null;
  loading: boolean;
  error: string | null;
  /** 重新读取配置列表与详情；左栏错误态就地重试用。 */
  reload: () => void;
  /** 后端还没实现命令时，界面不再让用户点到必然失败的按钮。 */
  nodeSwitchAvailable: boolean;
  nodeProbeAvailable: boolean;
  /** 连接「全部流量」前正在更新后台组件：系统即将请求一次授权。 */
  preparingHelper: boolean;
  /** 正在查后台组件状态（还没开始连接），遮罩据此说明当前阶段。 */
  checkingHelper: boolean;
  createConfig: (input: ConfigCreateInput) => Promise<ActionResult>;
  /** 只改名字；成功后左栏就地更新，不整表重载。 */
  renameConfig: (configId: string, name: string) => Promise<ActionResult>;
  deleteConfig: (configId: string) => Promise<ActionResult>;
  selectConfig: (configId: string) => Promise<ActionResult>;
  switchNode: (nodeId: string) => Promise<ActionResult>;
  start: () => Promise<ActionResult>;
  stop: () => Promise<ActionResult>;
  probe: (nodeId: string) => Promise<ProbeResult>;
}

interface MockStore {
  configs: ConfigDetail[];
  activeId: string | null;
}

const MOCK_STORAGE_KEY = MOCK_CONFIG_STORAGE_KEY;

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
  return runtimePhase(state);
}

function actionMessage(error: unknown, fallback: string): string {
  const bridgeError = toBridgeError(error);
  return bridgeError.message || fallback;
}

function actionReason(error: unknown): string | undefined {
  const reason = toBridgeError(error).details?.reason;
  return typeof reason === "string" ? reason : undefined;
}

/** Tauri 对未注册命令的报错形如 `Command node_probe not found`。 */
function isMissingCommand(error: unknown): boolean {
  const message = toBridgeError(error).message;
  return /unknown command/i.test(message) || /command\s+\S+\s+not\s+found/i.test(message);
}

/** 连接「全部流量」会先换后台组件；旧组件需要一次管理员授权。 */
async function helperNeedsAdmin(bridge: AgentBridge): Promise<boolean> {
  try {
    const info = await bridge.tunHelperInfo();
    // 文件校验失败只能重装，授权帮不上忙，不要许诺一个不会出现的弹窗。
    return info.needsAdminRestart && info.state !== "file_invalid";
  } catch {
    // 旧后端没有这条命令：按不需要授权处理，连接照旧。
    return false;
  }
}

/** 没有更细的 reason 时，权限类错误码按「这次没授权」处理。 */
function isHelperAdminFailure(error: unknown): boolean {
  return ["AUTH_DENIED", "PERMISSION_DENIED", "USER_CANCELLED", "CANCELLED"].includes(
    toBridgeError(error).code,
  );
}

/**
 * 权限类失败按 reason 决定怎么引导。
 * `settings`：去系统设置允许后台助手，界面弹引导，不用 toast；
 * `retry`：只是这次没授权，普通提示再试一次。
 * 新 reason 由后端给出后在这里加一行，不改下面的分支。
 * 缺组件、装不上、未打包的调试进程都不是「点允许」能解决的，不要加进来。
 */
type HelperPermissionOutcome = "settings" | "retry";

const HELPER_PERMISSION_REASONS: Record<string, HelperPermissionOutcome> = {
  tun_denied: "settings",
  helper_admin_cancelled: "retry",
};

function helperPermissionOutcome(
  reason: string | undefined,
): HelperPermissionOutcome | null {
  return reason === undefined ? null : HELPER_PERMISSION_REASONS[reason] ?? null;
}

export function isHelperPermissionReason(reason: string | undefined): boolean {
  return helperPermissionOutcome(reason) === "settings";
}

/**
 * 等浏览器把 React 这次更新画到屏幕上。
 * 系统弹窗会一直阻塞到用户处理完；如果先发请求，用户看到的就只有一个
 * 不知道是谁弹的密码框。窗口被切走时 rAF 可能停住，用 50ms 兜底，
 * 不能因为等一帧把连接挂起。
 */
function nextPaint(): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      resolve();
    };
    const timer = window.setTimeout(done, 50);
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(done);
    } else {
      done();
    }
  });
}

/**
 * 配置与连接状态。默认走真实命令；`mock` 只在 VITE_MOCK=1（或浏览器里的
 * mock 通道）时启用，供离线演示与测试用。
 */
export function useVpnSession(
  bridge: AgentBridge,
  mock: boolean,
  authority?: RuntimeAuthority,
): VpnSession {
  const [configs, setConfigs] = useState<ConfigSummary[]>([]);
  const [activeConfigId, setActiveConfigId] = useState<string | null>(null);
  const [activeConfig, setActiveConfig] = useState<ConfigDetail | null>(null);
  const [connection, setConnection] = useState<VpnConnectionState>("idle");
  const [connectedConfigId, setConnectedConfigId] = useState<string | null>(null);
  const [startingConfigId, setStartingConfigId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nodeSwitchAvailable, setNodeSwitchAvailable] = useState(true);
  const [nodeProbeAvailable, setNodeProbeAvailable] = useState(true);
  const [preparingHelper, setPreparingHelper] = useState(false);
  const [checkingHelper, setCheckingHelper] = useState(false);

  const mockStore = useRef<MockStore>({ configs: [], activeId: null });
  const timer = useRef<number | null>(null);
  const pendingConfigIdRef = useRef<string | null>(null);
  const disposed = useRef(false);
  // 同一帧里的第二次点击等不到按钮禁用，这里直接挡住重入。
  // 但目标是另一套配置时允许接管：用户在启动 A 的过程中点了「连接 B」。
  const startingRef = useRef(false);
  const startingTargetRef = useRef<string | null>(null);
  // start / stop 各推进一个序号：start 每次 await 回来先确认自己还是有效的。
  const startSeqRef = useRef(0);
  const cancelSeqRef = useRef(0);
  const stopSeqRef = useRef(0);
  // 断开命令返回前，迟到的 online 事件不能把连接态推回已连接。
  const stopPendingRef = useRef(false);
  // 已知的运行时状态与时刻：状态事件、stop()/start() 的本地结果共同维护。
  // 快照比它旧、或状态类别不同时只当陈旧数据，不覆盖连接态。
  // App 会传入与它共用的一份，避免两个实例的时钟分叉。
  const runtimeAuthority = useRef(authority ?? createRuntimeAuthority());

  const clearTimer = () => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
  };

  useEffect(() => clearTimer, []);

  const applySnapshot = useCallback(
    (snap: RuntimeSnapshot | null, options: { identity?: boolean } = {}) => {
      const identity = options.identity ?? true;
      if (!snap) {
        setConnection("idle");
        setConnectedConfigId(null);
        setStartingConfigId(null);
        return;
      }
      const online = snap.state === "running" || snap.state === "degraded";
      setConnection(toConnectionState(snap.state));
      if (identity) setConnectedConfigId(online ? snap.config_id : null);
      // starting / restarting 期间快照可能还不带 config_id：保留本地 start 记下的那套。
      setStartingConfigId((current) =>
        snap.state === "starting" || snap.state === "restarting"
          ? (snap.config_id ?? current)
          : null,
      );
    },
    [],
  );

  const applyMock = useCallback(
    (store: MockStore) => {
      setConfigs(store.configs.map((config) => summarizeConfig(config, store.activeId)));
      setActiveConfigId(store.activeId);
      const active =
        store.configs.find((config) => config.config_id === store.activeId) ?? null;
      setActiveConfig(active);
      // 浏览器 mock 没有配置库：把节点登记给 mock 桥，批量测速才有东西可测。
      if (mock) {
        (
          bridge as AgentBridge & {
            registerProbeNodes?: (configId: string | null, nodeIds: string[]) => void;
          }
        ).registerProbeNodes?.(
          active?.config_id ?? null,
          active?.nodes.map((node) => node.node_id) ?? [],
        );
      }
    },
    [bridge, mock],
  );

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
      if (!disposed.current) {
        const authority = runtimeAuthority.current;
        if (authority.current() === null) {
          // 首次挂载、还没收到任何状态事件：快照就是起点。
          if (snap) authority.markSnapshot(snap);
          else authority.markLocal("idle", 0);
          applySnapshot(snap);
        } else if (snap && authority.acceptsSnapshot(snap)) {
          authority.markSnapshot(snap);
          applySnapshot(snap);
        }
      }
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

  // 左栏「重新读取」：和首次加载走同一条路径。
  const reload = useCallback(() => {
    if (mock) {
      const store = readMock();
      mockStore.current = store;
      applyMock(store);
      return;
    }
    setLoading(true);
    setError(null);
    void refreshReal().finally(() => {
      if (!disposed.current) setLoading(false);
    });
  }, [mock, applyMock, refreshReal]);

  useEffect(() => {
    if (mock) return;
    return bridge.subscribe((event) => {
      if (event.name === AGENT_EVENTS.runtimeStateChanged) {
        if (
          stopPendingRef.current &&
          (event.payload.to === "running" || event.payload.to === "degraded")
        ) {
          // 断开还没结束：迟到的在线事件以 stop 的结果为准。
          return;
        }
        // 状态事件自带完整快照，直接落；不再拉 runtime_status（events.md §4.1）。
        // 比已知状态旧的事件（Tauri 不保证跨 emit 顺序）由共享权威判断丢弃。
        const fresh = runtimeAuthority.current.isNewer(event.payload);
        if (!runtimeAuthority.current.acceptEvent(event.payload)) return;
        applySnapshot(event.payload.snapshot, { identity: fresh });
        return;
      }
      if (event.name === AGENT_EVENTS.layoutUpdated) {
        // 事件带全量布局，不重拉 config_detail；只认当前配置、只认更新的 revision。
        const { config_id, revision, layout } = event.payload;
        setActiveConfig((current) => {
          if (!current || current.config_id !== config_id) return current;
          const known = current.layout_revision ?? 0;
          if (!Number.isFinite(revision) || revision <= known) return current;
          return { ...current, layout: layout ?? null, layout_revision: revision };
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

  const createConfig = async (input: ConfigCreateInput): Promise<ActionResult> => {
    if (mock) {
      const detail = createMockConfig(input.name, input.connectMode, {
        routingMode: input.routingMode,
        nodeIds: input.nodeIds,
      });
      const store = mockStore.current;
      const connected = connection === "connected" || connection === "starting";
      const activate = !connected || store.activeId === null;
      commitMock({
        configs: [...store.configs, detail],
        activeId: activate ? detail.config_id : store.activeId,
      });
      return { ok: true, activated: activate };
    }

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
          return {
            ok: false,
            message: actionMessage(retryErr, "创建配置失败"),
            reason: actionReason(retryErr),
          };
        }
      }
      return {
        ok: false,
        message: actionMessage(err, "创建配置失败"),
        reason: actionReason(err),
      };
    }
  };

  const selectConfig = async (configId: string): Promise<ActionResult> => {
    if (mock) {
      const store = mockStore.current;
      if (store.activeId === configId) return { ok: true };
      if (!store.configs.some((config) => config.config_id === configId)) {
        return { ok: false, message: "这套配置已经不存在了。" };
      }
      // 只换 active：模拟「连接保持原样」，断开只发生在下次启动。
      commitMock({ ...store, activeId: configId });
      return { ok: true };
    }

    try {
      await bridge.configActivate(configId);
      await refreshReal();
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
      const reason = actionReason(err);
      if (reason === "config_launching") {
        const another = startingConfigId !== null && startingConfigId !== activeConfigId;
        return {
          ok: false,
          message: another
            ? "另一套配置正在连接，等它连上或断开后再切换节点。"
            : "这套配置正在连接，等连上以后再切换节点。",
          reason,
        };
      }
      if (reason === "config_not_running") {
        // 连的是另一套：节点属于这套配置，等这套连上才能热切换。
        return {
          ok: false,
          message: "当前连着另一套配置，先连这套再换节点。",
          reason,
        };
      }
      return { ok: false, message: actionMessage(err, "切换节点失败") };
    }
  };

  const start = async (): Promise<ActionResult> => {
    if (!activeConfigId) return { ok: false, message: "还没有配置。" };
    if (!activeConfig || activeConfig.node_count === 0) {
      return { ok: false, message: "这套配置还没有节点。" };
    }
    // 同一意图的重复触发：首次还在跑，这里按成功返回，调用方不会弹错误。
    // 首次失败时自己会报错，重复这次不再重复报。
    if (startingRef.current && startingTargetRef.current === activeConfigId) {
      return { ok: true };
    }
    startingRef.current = true;
    startingTargetRef.current = activeConfigId;
    const startSeq = ++startSeqRef.current;
    const cancelSeq = cancelSeqRef.current;
    // 新一轮 start 接管：还没结束的 stop 不要再把界面按已断开收尾。
    stopSeqRef.current += 1;
    stopPendingRef.current = false;
    // 新一轮 start 或 stop 都会让这次 start 作废。
    const stale = () =>
      startSeqRef.current !== startSeq || cancelSeqRef.current !== cancelSeq;

    // 先把「点到了」画出来：下面查后台组件可能卡十秒以上，这段界面必须有反应。
    setConnection("starting");
    setConnectedConfigId(null);
    setStartingConfigId(activeConfigId);
    // 还没开始连，先查后台组件：遮罩要说明是检查阶段，不能拿残留的健康快照
    // 显示成「正在建立连接」或「正在确认出口」。
    const willCheckHelper = !mock && activeConfig.connect_mode === "tun";
    if (willCheckHelper) setCheckingHelper(true);

    try {
      if (mock) {
        clearTimer();
        const configId = activeConfigId;
        pendingConfigIdRef.current = configId;
        // 同时驱动 mock 运行时的状态事件，让面板按真实事件流更新。
        void bridge.runtimeStart(configId).catch(() => undefined);
        timer.current = window.setTimeout(() => {
          timer.current = null;
          pendingConfigIdRef.current = null;
          setConnection("connected");
          // startingConfigId 留给运行时事件收尾：mock 的 running 事件稍后才到，
          // 先清掉会让过渡态短暂说不清「正在连接的是哪套」。
          setConnectedConfigId(configId);
        }, 700);
        return { ok: true };
      }

      // 接管全部流量先换后台组件；旧组件会弹一次管理员授权。
      // 这一步只决定文案，不影响「已经在连接」这件事。
      let needsAdmin = false;
      if (willCheckHelper) {
        needsAdmin = await helperNeedsAdmin(bridge);
        // 查询期间被取消：不发起连接，状态由 stop() 负责收尾。
        if (stale()) return { ok: true };
        setCheckingHelper(false);
      }
      if (needsAdmin) {
        setPreparingHelper(true);
        // 系统弹窗会一直阻塞到用户处理完；先让这一句画出来，再发请求。
        await nextPaint();
        if (stale()) return { ok: true };
      }

      const started = await bridge.runtimeStart(activeConfigId);
      if (startSeqRef.current !== startSeq) {
        // 已被新一轮 start 接管：运行时交给新一轮处理，不能把它停掉。
        return { ok: true };
      }
      if (cancelSeqRef.current !== cancelSeq) {
        // runtimeStart 已经发出去了才被取消：补一次 stop，别留下跑着的运行时。
        await bridge.runtimeStop().catch(() => undefined);
        await refreshReal();
        return { ok: true };
      }
      await refreshReal();
      if (stale()) return { ok: true };
      // 后端幂等命中（同一套正在启动）：返回的是 starting 快照，不能当成已连接。
      if (started?.state === "starting" || started?.state === "restarting") {
        setConnection("starting");
        setStartingConfigId(started.config_id ?? activeConfigId);
        setConnectedConfigId(null);
        return { ok: true };
      }
      // runtimeStart 返回成功就是连上了。刷新快照可能晚一拍（甚至拿不到），
      // 不能再拿它的结果否定这次成功，否则界面会停在未连接。
      runtimeAuthority.current.markLocal("running");
      setConnection("connected");
      setStartingConfigId(null);
      setConnectedConfigId(activeConfigId);
      return { ok: true, connected: true };
    } catch (err) {
      // 主动取消或已被新一轮接管：不报错、也不改连接状态。
      if (stale()) return { ok: true };
      await refreshReal();
      setConnection((current) => (current === "starting" ? "idle" : current));
      setStartingConfigId(null);
      const reason = actionReason(err);
      // 后端把这代 start 作废（断开 / 换配置抢先）：静默收尾，不弹错误。
      if (reason === "cancelled") return { ok: true };
      const permission = helperPermissionOutcome(reason);
      if (permission === "settings") {
        // 需要用户去系统里允许后台助手：交给调用方弹引导，不用 toast。
        return { ok: false, reason };
      }
      if (permission === "retry" || isHelperAdminFailure(err)) {
        return { ok: false, message: "这次没有授权，可以再试一次。", reason };
      }
      return { ok: false, message: actionMessage(err, "启动失败"), reason };
    } finally {
      if (startSeqRef.current === startSeq) {
        startingRef.current = false;
        startingTargetRef.current = null;
        setCheckingHelper(false);
        setPreparingHelper(false);
      }
    }
  };

  const stop = async (): Promise<ActionResult> => {
    // 取消还在进行的 start：它后续 await 回来会发现序号失效，不再往下走。
    cancelSeqRef.current += 1;
    startingRef.current = false;
    startingTargetRef.current = null;
    setCheckingHelper(false);
    setPreparingHelper(false);
    const stopSeq = ++stopSeqRef.current;
    const wasConnected = connection === "connected";
    const wasConfigId = connectedConfigId;
    stopPendingRef.current = true;
    setStartingConfigId(null);

    if (mock) {
      clearTimer();
      pendingConfigIdRef.current = null;
      setConnection("stopping");
      void bridge.runtimeStop().catch(() => undefined);
      timer.current = window.setTimeout(() => {
        timer.current = null;
        stopPendingRef.current = false;
        setConnection("idle");
        setConnectedConfigId(null);
      }, 400);
      return { ok: true };
    }

    setConnection("stopping");
    try {
      await bridge.runtimeStop();
      await refreshReal();
      // 被新一轮 start 接管：停止结果不能覆盖新一轮。
      if (stopSeqRef.current !== stopSeq) return { ok: true };
      stopPendingRef.current = false;
      runtimeAuthority.current.markLocal("idle");
      // runtimeStop 成功就是断开了。快照可能还停在 running，不能让它否定这次结果。
      setConnection("idle");
      setConnectedConfigId(null);
      return { ok: true, stopped: true };
    } catch (err) {
      // 被接管时静默让位；否则断开失败必须保持原状态并报错。
      if (stopSeqRef.current !== stopSeq) return { ok: true };
      await refreshReal();
      stopPendingRef.current = false;
      runtimeAuthority.current.markLocal(wasConnected ? "running" : "idle");
      setConnection(wasConnected ? "connected" : "idle");
      setConnectedConfigId(wasConnected ? wasConfigId : null);
      return { ok: false, message: actionMessage(err, "断开失败") };
    }
  };

  const renameConfig = async (
    configId: string,
    name: string,
  ): Promise<ActionResult> => {
    if (mock) {
      const store = mockStore.current;
      if (!store.configs.some((config) => config.config_id === configId)) {
        return { ok: true };
      }
      commitMock({
        ...store,
        configs: store.configs.map((config) =>
          config.config_id === configId ? { ...config, name } : config,
        ),
      });
      return { ok: true };
    }

    try {
      const detail = await bridge.configUpdate({ configId, name });
      setConfigs((current) =>
        current.map((config) =>
          config.config_id === configId ? { ...config, name: detail.name } : config,
        ),
      );
      setActiveConfig((current) =>
        current && current.config_id === configId
          ? { ...current, name: detail.name }
          : current,
      );
      return { ok: true };
    } catch (err) {
      return { ok: false, message: actionMessage(err, "改名失败") };
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
    startingConfigId,
    loading,
    error,
    reload,
    nodeSwitchAvailable,
    nodeProbeAvailable,
    preparingHelper,
    checkingHelper,
    createConfig,
    renameConfig,
    deleteConfig,
    selectConfig,
    switchNode,
    start,
    stop,
    probe,
  };
}
