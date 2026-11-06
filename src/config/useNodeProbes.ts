import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AgentBridge, NodeProbeRun } from "../agent/bridge";
import { toBridgeError } from "../agent/errors";
import { AGENT_EVENTS } from "../agent/protocol";
import type {
  NodeProbeData,
  NodeProbeFinishedPayload,
  NodeProbeProgressPayload,
} from "../agent/protocol";
import { nextProbing } from "../ui/nodeList";

const CONCURRENCY = 6;
const NOTICE_MS = 4000;

export interface ActiveProbeRun extends NodeProbeRun {
  configId: string;
  /** 本次 nodeIds 里被后端忽略的数量（已不存在的节点）。 */
  ignored: number;
}

export interface ProbeFinishedInfo {
  configId: string;
  total: number;
  ok: number;
  failed: number;
  method: "tcp" | "clash";
  cancelled: boolean;
  reason: "connected" | null;
  network: "ok" | "offline";
}

export interface NodeProbesController {
  results: Record<string, NodeProbeData>;
  run: ActiveProbeRun | null;
  /** 正在被这一批探测的节点，最多 6 个；行内据此显示「测速中」。 */
  probing: ReadonlySet<string>;
  finished: ProbeFinishedInfo | null;
  /** 取消后的短暂汇总；带 configId，切到别的配置时不会串台。 */
  notice: { configId: string; text: string } | null;
  /** false = 当前版本没有批量测速命令，界面隐藏批量入口。 */
  available: boolean;
  /** 打开面板时先渲染缓存与运行态，不发网络请求。 */
  loadSnapshot: (configId: string, nodeIds: string[]) => Promise<void>;
  /** nodeIds 省略 = 全部；提供时只测过滤后的子集。 */
  start: (
    configId: string,
    nodeIds?: string[],
  ) => Promise<{ ok: boolean; message?: string }>;
  cancel: () => Promise<void>;
  clearNotice: () => void;
}

function isMissingCommand(error: unknown): boolean {
  const message = toBridgeError(error).message;
  return /unknown command/i.test(message) || /command\s+\S+\s+not\s+found/i.test(message);
}

function messageOf(error: unknown, fallback: string): string {
  const bridgeError = toBridgeError(error);
  return bridgeError.message || fallback;
}

/**
 * 批量测速的前端状态机。批次属于配置，不属于面板：面板关闭、切走配置都
 * 只是不再渲染它；是否在跑只看 `run`（node-list.md §6.2）。
 */
export function useNodeProbes({
  bridge,
  enabled = true,
}: {
  bridge: AgentBridge;
  enabled?: boolean;
}): NodeProbesController {
  const [results, setResults] = useState<Record<string, NodeProbeData>>({});
  const [run, setRun] = useState<ActiveProbeRun | null>(null);
  const [probing, setProbing] = useState<ReadonlySet<string>>(() => new Set());
  const [finished, setFinished] = useState<ProbeFinishedInfo | null>(null);
  const [notice, setNotice] = useState<{ configId: string; text: string } | null>(
    null,
  );
  const [available, setAvailable] = useState(true);

  const runRef = useRef<ActiveProbeRun | null>(null);
  const probingRef = useRef<Set<string>>(new Set());
  const queueRef = useRef<string[]>([]);
  const resultsRef = useRef<Record<string, NodeProbeData>>({});
  const knownNodeIds = useRef<string[]>([]);
  /** 当前批次的节点范围；子集批次只在这批节点里轮转探测态。 */
  const runScope = useRef<string[]>([]);
  /** 本窗口内由面板发起的批次：从第一帧起就是「全部节点重测」。 */
  const freshRun = useRef<string | null>(null);
  const startingConfigRef = useRef<string | null>(null);
  const noticeTimer = useRef<number | null>(null);

  useEffect(() => {
    resultsRef.current = results;
  }, [results]);

  const applyRun = useCallback((next: ActiveProbeRun | null) => {
    runRef.current = next;
    setRun(next);
  }, []);

  const applyProbing = useCallback((next: Set<string>, queue: string[]) => {
    probingRef.current = next;
    queueRef.current = queue;
    setProbing(next);
  }, []);

  const clearNotice = useCallback(() => {
    if (noticeTimer.current !== null) {
      window.clearTimeout(noticeTimer.current);
      noticeTimer.current = null;
    }
    setNotice(null);
  }, []);

  const showNotice = useCallback(
    (configId: string, text: string) => {
      clearNotice();
      setNotice({ configId, text });
      noticeTimer.current = window.setTimeout(() => {
        noticeTimer.current = null;
        setNotice(null);
      }, NOTICE_MS);
    },
    [clearNotice],
  );

  const seedProbing = useCallback(
    (exclude: Record<string, unknown>) => {
      const scope =
        runScope.current.length > 0 ? runScope.current : knownNodeIds.current;
      const pending = scope.filter((id) => !exclude[id]);
      const seeded = nextProbing(new Set(), pending, CONCURRENCY);
      applyProbing(seeded.probing, seeded.queue);
    },
    [applyProbing],
  );

  useEffect(
    () => () => {
      if (noticeTimer.current !== null) window.clearTimeout(noticeTimer.current);
    },
    [],
  );

  const onProgress = useCallback(
    (payload: NodeProbeProgressPayload) => {
      let current = runRef.current;
      if (!current) {
        // 启动命令还没返回、事件先到：同一时刻只有一个批次，按 config 认领。
        if (startingConfigRef.current !== payload.config_id) return;
        current = {
          runId: payload.run_id,
          configId: payload.config_id,
          done: 0,
          total: payload.total,
          startedAt: Date.now(),
          phase: payload.phase,
          method: payload.method,
          ignored: 0,
        };
        freshRun.current = payload.run_id;
        applyRun(current);
      }
      if (payload.run_id !== current.runId) return;
      // 已切走的配置：事件仍在跑，但不属于当前界面。
      if (payload.config_id !== current.configId) return;

      const phase = payload.phase === "preparing" ? "preparing" : "probing";
      const method = payload.method === "clash" ? "clash" : "tcp";

      // phase 事件没有结果：只更新阶段与方式，不按 done 去重（preparing/probing 都是 0）。
      if (!payload.result) {
        applyRun({
          ...current,
          phase,
          method,
          total: payload.total || current.total,
        });
        if (phase === "probing" && probingRef.current.size === 0) {
          // 本窗口发起的批次全部重测，缓存行也要显示「测速中 + 上次」；
          // 重开面板恢复时只能从缓存里排除已完成的节点。
          seedProbing(
            freshRun.current === current.runId ? {} : resultsRef.current,
          );
        }
        return;
      }

      // 重开面板可能先收到一条更早的迟到事件：按 done 去重。
      if (payload.done <= current.done) {
        applyRun({ ...current, phase, method });
        return;
      }

      const result = payload.result;
      setResults((prev) => ({ ...prev, [result.node_id]: result }));
      applyRun({
        ...current,
        done: payload.done,
        total: payload.total,
        phase,
        method,
      });

      const next = new Set(probingRef.current);
      next.delete(result.node_id);
      let queue = queueRef.current.filter((id) => id !== result.node_id);
      if (next.size === 0 && queue.length === 0) {
        // 后端没有发阶段事件时，用第一个结果把探测队列补起来。
        const scope =
          runScope.current.length > 0 ? runScope.current : knownNodeIds.current;
        const pending = scope.filter(
          (id) => id !== result.node_id && !resultsRef.current[id],
        );
        queue = pending;
      }
      const filled = nextProbing(next, queue, CONCURRENCY);
      applyProbing(filled.probing, filled.queue);
    },
    [applyProbing, applyRun, seedProbing],
  );

  const onFinished = useCallback(
    (payload: NodeProbeFinishedPayload) => {
      const current = runRef.current;
      if (!current || current.runId !== payload.run_id) return;
      applyRun(null);
      applyProbing(new Set(), []);
      startingConfigRef.current = null;
      freshRun.current = null;
      runScope.current = [];
      setFinished({
        configId: payload.config_id,
        total: payload.total,
        ok: payload.ok,
        failed: payload.failed,
        method: payload.method === "clash" ? "clash" : "tcp",
        cancelled: payload.cancelled,
        reason: payload.reason === "connected" ? "connected" : null,
        network: payload.network,
      });
      if (payload.cancelled) {
        showNotice(
          payload.config_id,
          payload.reason === "connected"
            ? "启动 VPN 后测速已停止"
            : `已停止 · 已测 ${payload.ok + payload.failed}/${payload.total}`,
        );
      }
    },
    [applyProbing, applyRun, showNotice],
  );

  useEffect(() => {
    if (!enabled) return;
    return bridge.subscribe((event) => {
      if (event.name === AGENT_EVENTS.nodeProbeProgress) {
        onProgress(event.payload);
      } else if (event.name === AGENT_EVENTS.nodeProbeFinished) {
        onFinished(event.payload);
      }
    });
  }, [bridge, enabled, onFinished, onProgress]);

  const loadSnapshot = useCallback(
    async (configId: string, nodeIds: string[]) => {
      knownNodeIds.current = nodeIds;
      try {
        const snapshot = await bridge.nodeProbeSnapshot(configId);
        setAvailable(true);
        const merged: Record<string, NodeProbeData> = {};
        for (const result of snapshot.results) merged[result.node_id] = result;
        setResults((prev) => ({ ...prev, ...merged }));

        if (snapshot.run) {
          const current = runRef.current;
          const sameRun = current?.runId === snapshot.run.runId;
          // 事件可能比快照先到：同一个批次以已收到的进度为准，不让 done 倒退。
          const next: ActiveProbeRun = {
            runId: snapshot.run.runId,
            configId: snapshot.configId || configId,
            done: sameRun
              ? Math.max(current.done, snapshot.run.done)
              : snapshot.run.done,
            total: sameRun
              ? Math.max(current.total, snapshot.run.total)
              : snapshot.run.total,
            startedAt: snapshot.run.startedAt,
            phase: sameRun && current.phase === "probing" ? "probing" : snapshot.run.phase,
            method: sameRun ? current.method : snapshot.run.method,
            ignored: sameRun ? current.ignored : 0,
          };
          // 已在跟踪同一个批次时保留现有探测队列，避免把正在飞的行重置。
          if (!sameRun) {
            freshRun.current = null;
            runScope.current = [];
            if (next.phase === "probing") {
              seedProbing(merged);
            } else {
              // preparing：临时运行时尚未就绪，没有行在飞。
              applyProbing(new Set(), []);
            }
          }
          applyRun(next);
        } else if (
          runRef.current?.configId === configId &&
          startingConfigRef.current !== configId
        ) {
          // 契约：run 为空就是没有批次在跑，缓存内容不代表已测完。
          applyRun(null);
          applyProbing(new Set(), []);
          freshRun.current = null;
          runScope.current = [];
        }
      } catch (error) {
        if (isMissingCommand(error)) setAvailable(false);
      }
    },
    [applyProbing, applyRun, bridge, seedProbing],
  );

  const start = useCallback(
    async (configId: string, nodeIds?: string[]) => {
      if (nodeIds && nodeIds.length === 0) {
        return { ok: false, message: "没有可测的节点。" };
      }
      if (runRef.current) return { ok: false, message: "已经有测速在跑，等它结束再试。" };
      // 子集在启动这一刻固定，之后搜索变化不再影响批次分母。
      const scope = nodeIds ?? knownNodeIds.current;
      if (scope.length === 0) return { ok: false, message: "这套配置还没有节点。" };
      clearNotice();
      runScope.current = scope;
      startingConfigRef.current = configId;
      try {
        const data = await bridge.nodeProbeAll(configId, nodeIds);
        const ignoredIds = data.ignoredNodeIds ?? [];
        const ignored = new Set(ignoredIds);
        runScope.current = scope.filter((id) => !ignored.has(id));
        const adopted = runRef.current as ActiveProbeRun | null;
        if (adopted && adopted.runId === data.runId) {
          // 事件先到时已认领了同一个批次：保留已有进度，不重置探测队列。
          if (adopted.phase === "probing" && probingRef.current.size === 0) {
            seedProbing(resultsRef.current);
          }
          applyRun({
            ...adopted,
            total: data.total || adopted.total,
            ignored: ignoredIds.length,
          });
          startingConfigRef.current = null;
          return { ok: true };
        }
        applyProbing(new Set(), []);
        freshRun.current = data.runId;
        applyRun({
          runId: data.runId,
          configId: data.configId || configId,
          done: 0,
          total: data.total || scope.length,
          startedAt: Date.now(),
          // 命令本身不带阶段；后端会立刻发 preparing / probing 事件来修正。
          phase: "preparing",
          method: "tcp",
          ignored: ignoredIds.length,
        });
        startingConfigRef.current = null;
        setAvailable(true);
        return { ok: true };
      } catch (error) {
        startingConfigRef.current = null;
        applyProbing(new Set(), []);
        freshRun.current = null;
        runScope.current = [];
        if (isMissingCommand(error)) {
          setAvailable(false);
          return { ok: false, message: "这个版本还不能批量测速。" };
        }
        return { ok: false, message: messageOf(error, "没能开始测速，请稍后再试。") };
      }
    },
    [applyProbing, applyRun, bridge, clearNotice, seedProbing],
  );

  const cancel = useCallback(async () => {
    const current = runRef.current;
    if (!current) return;
    try {
      const result = await bridge.nodeProbeCancel(current.runId);
      if (!result.cancelled) {
        // 批次已经结束：本地收尾，等不等得到 finished 都不影响。
        applyRun(null);
        applyProbing(new Set(), []);
        startingConfigRef.current = null;
        runScope.current = [];
      }
    } catch {
      // 尽力而为：真正的结束以 node-probe-finished 为准。
    }
  }, [applyProbing, applyRun, bridge]);

  return useMemo(
    () => ({
      results,
      run,
      probing,
      finished,
      notice,
      available,
      loadSnapshot,
      start,
      cancel,
      clearNotice,
    }),
    [
      results,
      run,
      probing,
      finished,
      notice,
      available,
      loadSnapshot,
      start,
      cancel,
      clearNotice,
    ],
  );
}
