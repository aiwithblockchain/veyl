import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import type { ConfigDetail, NodeSummary } from "../agent/protocol";
import type { NodeProbesController } from "../config/useNodeProbes";
import {
  ageLabel,
  filterNodes,
  formatLatency,
  hasMixedProbeMethods,
  probeBadge,
  probeMethodOf,
  probeSummary,
  readNodeSort,
  sortNodeRows,
  toggleNodeSort,
  writeNodeSort,
  type NodeSort,
} from "../ui/nodeList";
import { IconClose } from "./icons";

const ROW_H = 44;
const VIRTUAL_THRESHOLD = 60;
const OVERSCAN = 6;
const SWITCH_MIN_MS = 400;
const REORDER_MS = 180;
const REORDER_SETTLE_MS = 600;
const REORDER_CAP_MS = 800;
const SWITCH_ERROR_MS = 4000;

interface Props {
  open: boolean;
  config: ConfigDetail;
  probes: NodeProbesController;
  onClose: () => void;
  onSwitch: (nodeId: string) => Promise<{ ok: boolean; message?: string }>;
  onOpenDiagnostics?: () => void;
}

const sleep = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));

function reduceMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

function prefersStorage(): Pick<Storage, "getItem" | "setItem"> | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

export function NodeSheet({
  open,
  config,
  probes,
  onClose,
  onSwitch,
  onOpenDiagnostics,
}: Props) {
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<NodeSort>(() => readNodeSort(prefersStorage()));
  const [activeId, setActiveId] = useState<string | null>(config.current_node_id);
  const [switchingId, setSwitchingId] = useState<string | null>(null);
  const [switchErrorId, setSwitchErrorId] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [batchError, setBatchError] = useState<string | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportH, setViewportH] = useState(420);
  const [reorderPending, setReorderPending] = useState(false);
  const [reordering, setReordering] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  const sheetRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const rowRefs = useRef(new Map<string, HTMLDivElement>());
  const prevRects = useRef(new Map<string, DOMRect>());
  const animateNext = useRef(false);
  const switchingRef = useRef(false);
  const reorderingRef = useRef(false);
  const reorderPendingRef = useRef(false);
  const pendingSince = useRef(0);
  const reorderTimer = useRef<number | null>(null);
  const reorderDoneTimer = useRef<number | null>(null);
  const pointerInside = useRef(false);
  const errorTimer = useRef<number | null>(null);
  const rowsRef = useRef<NodeSummary[]>([]);
  const frozenRunId = useRef<string | null>(null);
  const frozenOrder = useRef<string[] | null>(null);
  const openRef = useRef(open);
  const sortRef = useRef(sort);
  openRef.current = open;
  sortRef.current = sort;

  const run =
    probes.run && probes.run.configId === config.config_id ? probes.run : null;
  const runActive = run !== null;
  const locked = runActive || reorderPending;
  const nodeCount = config.nodes.length;
  const canSearch = nodeCount > 8;
  const searching = canSearch && search.trim().length > 0;

  useEffect(() => {
    setNow(Date.now());
    if (!open) return;
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, [open]);

  // 打开时把当前节点设为键盘焦点行，并按节点数把焦点放到搜索框或列表。
  useEffect(() => {
    if (!open) return;
    setSearch("");
    setBatchError(null);
    // 关闭前发起的切换可能还在飞：重开时不能把锁清掉，否则会发出第二次切换。
    if (!switchingRef.current) {
      setSwitchingId(null);
      setSwitchErrorId(null);
    }
    setActiveId(config.current_node_id ?? config.nodes[0]?.node_id ?? null);
    const timer = window.setTimeout(() => {
      if (config.nodes.length > 8) searchRef.current?.focus();
      else listRef.current?.focus();
    }, 0);
    return () => window.clearTimeout(timer);
    // 只在打开瞬间执行；配置、节点变化由后续 effect 处理。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // 打开面板时先渲染缓存与运行态，再继续接收进度事件。
  const probeNodeIds = config.nodes.map((node) => node.node_id).join(",");
  useEffect(() => {
    if (!open) return;
    void probes.loadSnapshot(
      config.config_id,
      probeNodeIds ? probeNodeIds.split(",") : [],
    );
  }, [open, config.config_id, probeNodeIds, probes.loadSnapshot]);

  // 批次开始时冻结行顺序；结束后按偏好重排一次。
  useEffect(() => {
    const runId = run?.runId ?? null;
    if (runId) {
      if (frozenRunId.current !== runId) {
        frozenRunId.current = runId;
        frozenOrder.current = config.nodes.map((node) => node.node_id);
      }
      return;
    }
    frozenRunId.current = null;
    if (reorderPending) return;
    frozenOrder.current = null;
  }, [run?.runId, config.nodes, reorderPending]);

  // 复位只由这个独立 timer 负责，不挂在某一次 layout effect 的生命周期上：
  // effect 因滚动 / 搜索重新执行时不会把「解除 busy」清掉。
  const finishReorder = useCallback(() => {
    if (reorderDoneTimer.current !== null) {
      window.clearTimeout(reorderDoneTimer.current);
      reorderDoneTimer.current = null;
    }
    for (const el of rowRefs.current.values()) {
      el.style.transition = "";
      el.style.transform = "";
    }
    reorderingRef.current = false;
    setReordering(false);
  }, []);

  const applyReorder = useCallback(() => {
    if (reorderTimer.current !== null) {
      window.clearTimeout(reorderTimer.current);
      reorderTimer.current = null;
    }
    if (!reorderPendingRef.current) return;
    // 切换请求在飞时不重排；切换结束后重新按指针与上限排队（视觉 §6.4.3）。
    if (switchingRef.current) {
      reorderTimer.current = window.setTimeout(() => {
        if (reorderPendingRef.current) scheduleReorder();
      }, 120);
      return;
    }
    reorderPendingRef.current = false;
    setReorderPending(false);
    frozenOrder.current = null;
    animateNext.current = true;
    reorderingRef.current = true;
    setReordering(true);
    if (reduceMotion()) {
      finishReorder();
      return;
    }
    if (reorderDoneTimer.current !== null) window.clearTimeout(reorderDoneTimer.current);
    reorderDoneTimer.current = window.setTimeout(finishReorder, REORDER_MS + 20);
  }, [finishReorder]);

  const scheduleReorder = useCallback(() => {
    if (reorderTimer.current !== null) window.clearTimeout(reorderTimer.current);
    const cap = Math.max(0, REORDER_CAP_MS - (Date.now() - pendingSince.current));
    const wait = pointerInside.current
      ? Math.min(REORDER_SETTLE_MS, cap)
      : 0;
    reorderTimer.current = window.setTimeout(applyReorder, wait);
  }, [applyReorder]);

  const noteReorderPending = useCallback(() => {
    pendingSince.current = Date.now();
    reorderPendingRef.current = true;
    setReorderPending(true);
    scheduleReorder();
  }, [scheduleReorder]);

  // 运行中锁定顺序；结束后（跑完或取消）延迟到指针安全时重排一次。
  const prevRunning = useRef(false);
  useEffect(() => {
    const was = prevRunning.current;
    prevRunning.current = runActive;
    if (was && !runActive && sortRef.current === "latency") {
      noteReorderPending();
    }
  }, [runActive, noteReorderPending]);

  // 指针在列表上时推迟重排，避免行在指针下移动导致误点。
  const onListPointerMove = useCallback(() => {
    if (!pointerInside.current) pointerInside.current = true;
    if (reorderPendingRef.current) scheduleReorder();
  }, [scheduleReorder]);

  const onListPointerLeave = useCallback(() => {
    pointerInside.current = false;
    if (reorderPendingRef.current) applyReorder();
  }, [applyReorder]);

  // FLIP：重排后 180ms 位移；焦点按 node_id 跟随（activeId 不变）。
  // 这里只负责首帧位移，解除 busy 由 finishReorder 的独立 timer 负责。
  useLayoutEffect(() => {
    if (!open) return;
    const next = new Map<string, DOMRect>();
    for (const [id, el] of rowRefs.current) next.set(id, el.getBoundingClientRect());
    if (animateNext.current) {
      animateNext.current = false;
      if (!reduceMotion()) {
        for (const [id, el] of rowRefs.current) {
          const before = prevRects.current.get(id);
          const after = next.get(id);
          if (!before || !after) continue;
          const dy = before.top - after.top;
          if (!dy) continue;
          el.style.transition = "none";
          el.style.transform = `translateY(${dy}px)`;
        }
        requestAnimationFrame(() => {
          for (const el of rowRefs.current.values()) {
            el.style.transition = `transform ${REORDER_MS}ms ease`;
            el.style.transform = "";
          }
        });
      }
    }
    prevRects.current = next;
  }, [open, config.config_id, sort, reorderPending, activeId, scrollTop, search]);

  useEffect(
    () => () => {
      if (reorderTimer.current !== null) window.clearTimeout(reorderTimer.current);
      if (reorderDoneTimer.current !== null) {
        window.clearTimeout(reorderDoneTimer.current);
      }
      if (errorTimer.current !== null) window.clearTimeout(errorTimer.current);
    },
    [],
  );

  // Esc 关闭；点击面板外关闭（点节点卡交给它自己的按钮切换）。
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing || event.keyCode === 229) return;
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
      }
    };
    const onMouseDown = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (!target) return;
      if (sheetRef.current?.contains(target)) return;
      if (target.closest(".node-card")) return;
      onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("mousedown", onMouseDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("mousedown", onMouseDown);
    };
  }, [open, onClose]);

  const baseNodes = useMemo(() => {
    if (!locked || !frozenOrder.current) return config.nodes;
    const byId = new Map(config.nodes.map((node) => [node.node_id, node]));
    return frozenOrder.current
      .map((id) => byId.get(id))
      .filter((node): node is NodeSummary => Boolean(node));
  }, [config.nodes, locked]);

  const rows = useMemo(() => {
    const filtered = filterNodes(baseNodes, canSearch ? search : "");
    return locked ? filtered : sortNodeRows(filtered, probes.results, sort, now);
  }, [baseNodes, canSearch, search, locked, probes.results, sort, now]);
  rowsRef.current = rows;

  useEffect(() => {
    if (rows.length === 0) {
      setActiveId(null);
      return;
    }
    if (!activeId || !rows.some((node) => node.node_id === activeId)) {
      setActiveId(
        rows.some((node) => node.node_id === config.current_node_id)
          ? config.current_node_id
          : rows[0].node_id,
      );
    }
  }, [rows, activeId, config.current_node_id]);

  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    setViewportH(list.clientHeight || 420);
  }, [open, rows.length]);

  const scrollToNode = useCallback((nodeId: string) => {
    const list = listRef.current;
    const index = rowsRef.current.findIndex((node) => node.node_id === nodeId);
    if (!list || index < 0) return;
    const top = index * ROW_H;
    const viewH = list.clientHeight || 420;
    if (top < list.scrollTop || top + ROW_H > list.scrollTop + viewH) {
      list.scrollTop = Math.max(0, top - Math.round(viewH / 2) + ROW_H / 2);
    }
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    const current = config.current_node_id ?? rows[0]?.node_id ?? null;
    if (current) scrollToNode(current);
    // 只在打开时滚到当前节点，之后不强制跟随。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const moveActive = (delta: number) => {
    if (rows.length === 0) return;
    const current = activeId ? rows.findIndex((node) => node.node_id === activeId) : -1;
    const nextIndex = Math.max(0, Math.min(rows.length - 1, current + delta));
    const next = rows[nextIndex];
    if (!next) return;
    setActiveId(next.node_id);
    scrollToNode(next.node_id);
  };

  const activate = useCallback(
    async (node: NodeSummary) => {
      if (!openRef.current) return;
      // 焦点跟着用户点的行：即使这次切不动，重试也还在原地。
      setActiveId(node.node_id);
      if (switchingRef.current || reorderingRef.current) return;
      if (node.node_id === config.current_node_id) return;
      setBatchError(null);
      switchingRef.current = true;
      setSwitchingId(node.node_id);
      if (errorTimer.current !== null) {
        window.clearTimeout(errorTimer.current);
        errorTimer.current = null;
      }
      setSwitchErrorId(null);
      const started = Date.now();
      let ok = false;
      try {
        const result = await onSwitch(node.node_id);
        ok = result.ok;
        const remaining = SWITCH_MIN_MS - (Date.now() - started);
        if (remaining > 0) await sleep(remaining);
        if (ok) {
          setAnnouncement(`已切换到 ${node.name}`);
        } else {
          setSwitchErrorId(node.node_id);
          setAnnouncement("没切成，还在原来的节点");
          errorTimer.current = window.setTimeout(() => {
            errorTimer.current = null;
            setSwitchErrorId(null);
          }, SWITCH_ERROR_MS);
        }
      } catch {
        setSwitchErrorId(node.node_id);
        setAnnouncement("没切成，还在原来的节点");
      } finally {
        switchingRef.current = false;
        setSwitchingId(null);
        // 切换期间推迟的重排，在切换结束后按指针位置重新排队。
        if (reorderPendingRef.current) scheduleReorder();
      }
    },
    [config.current_node_id, onSwitch, scheduleReorder],
  );

  const onListKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      moveActive(event.key === "ArrowDown" ? 1 : -1);
      return;
    }
    if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      const next = event.key === "Home" ? rows[0] : rows[rows.length - 1];
      if (next) {
        setActiveId(next.node_id);
        scrollToNode(next.node_id);
      }
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      const node = rows.find((item) => item.node_id === activeId);
      if (node) void activate(node);
    }
  };

  const toggleSort = () => {
    if (locked) return;
    const next = toggleNodeSort(sort);
    setSort(next);
    writeNodeSort(prefersStorage(), next);
  };

  const startOrCancel = async () => {
    setBatchError(null);
    if (run) {
      await probes.cancel();
      return;
    }
    // 以点击这一刻的过滤结果为准；批次跑起来后搜索变化不再改分母。
    const scope = searching ? rows.map((node) => node.node_id) : undefined;
    const result = await probes.start(config.config_id, scope);
    if (!result.ok) setBatchError(result.message ?? "没能开始测速，请稍后再试。");
  };

  if (!open) return null;

  const total = run?.total ?? nodeCount;
  // 后端数值异常时不把进度画到负数或超过总数。
  const done = run ? Math.max(0, Math.min(run.done, total)) : 0;
  const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
  const lastFinished =
    probes.finished && probes.finished.configId === config.config_id
      ? probes.finished
      : null;
  const batchMethod = run?.method ?? lastFinished?.method;
  const notice =
    probes.notice && probes.notice.configId === config.config_id
      ? probes.notice.text
      : null;
  const mixedMethods = hasMixedProbeMethods(rows, probes.results);
  const hasReachable = rows.some(
    (node) => probes.results[node.node_id]?.reachable,
  );
  const showTcpHint = !run && batchMethod === "tcp" && hasReachable;
  const allFailed =
    !run &&
    lastFinished !== null &&
    !lastFinished.cancelled &&
    lastFinished.ok === 0 &&
    lastFinished.network === "ok";
  const summary = run
    ? run.phase === "preparing"
      ? "正在准备测速…"
      : `正在测速 ${done}/${total}`
    : notice ?? probeSummary(rows, probes.results, now, batchMethod);
  const offline =
    !run && lastFinished !== null && lastFinished.network === "offline" && !lastFinished.cancelled;

  const virtual = rows.length > VIRTUAL_THRESHOLD;
  const start = virtual ? Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN) : 0;
  const end = virtual
    ? Math.min(rows.length, start + Math.ceil(viewportH / ROW_H) + OVERSCAN * 2)
    : rows.length;
  const visible = virtual ? rows.slice(start, end) : rows;

  // 有搜索时只测当前过滤结果；无搜索时不传 nodeIds，保持「全部」语义。
  const batchLabel = run
    ? "停止测速"
    : searching
      ? `测这 ${rows.length} 个`
      : "全部测速";
  const showBatch =
    run !== null || (probes.available && nodeCount > 1 && rows.length > 0);
  const ignoredNote =
    run && run.ignored > 0 ? `已跳过 ${run.ignored} 个已不存在的节点` : "";

  return (
    <div
      ref={sheetRef}
      id="node-sheet"
      className="node-sheet"
      role="dialog"
      aria-label={`节点 · ${config.name}`}
    >
      <header className="node-sheet__head">
        <h2 className="node-sheet__title">节点 · {config.name}</h2>
        <button
          type="button"
          className="node-sheet__close"
          aria-label="关闭"
          onClick={onClose}
        >
          <IconClose size={14} />
        </button>
      </header>

      {canSearch ? (
        <div className="node-sheet__search">
          <span className="node-sheet__search-icon" aria-hidden>
            <svg viewBox="0 0 16 16" width="14" height="14">
              <circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.3" />
              <path d="M10.5 10.5 14 14" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
            </svg>
          </span>
          <input
            ref={searchRef}
            type="search"
            className="node-sheet__input"
            placeholder="搜索节点"
            aria-label="搜索节点"
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              const list = listRef.current;
              if (list) list.scrollTop = 0;
              setScrollTop(0);
            }}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing || event.keyCode === 229) return;
              if (event.key === "ArrowDown") {
                event.preventDefault();
                listRef.current?.focus();
                moveActive(1);
              }
            }}
          />
          {search ? (
            <button
              type="button"
              className="node-sheet__clear"
              aria-label="清除搜索"
              onClick={() => {
                setSearch("");
                searchRef.current?.focus();
              }}
            >
              <IconClose size={12} />
            </button>
          ) : null}
        </div>
      ) : null}

      <div className="node-sheet__summary">
        <span className="node-sheet__summary-text">{summary}</span>
        <button
          type="button"
          className="node-sheet__sort"
          aria-label={`排序：${sort === "latency" ? "延迟" : "手动"}`}
          title={locked ? "测速结束后可排序" : "切换排序"}
          disabled={locked}
          onClick={toggleSort}
        >
          排序：{sort === "latency" ? "延迟" : "手动"}
        </button>
      </div>

      {showTcpHint ? (
        <p className="node-sheet__hint">
          没连上，只能确认服务器连得上，不验证密码和出口
        </p>
      ) : null}
      {allFailed ? (
        <p className="node-sheet__hint">这些节点可能都不可用</p>
      ) : null}

      {run && run.phase === "probing" ? (
        <div
          className="node-sheet__progress"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={total}
          aria-valuenow={done}
          aria-label={`正在测速 ${done}/${total}`}
        >
          <span style={{ width: `${pct}%` }} />
        </div>
      ) : null}

      {offline ? (
        <div className="node-sheet__banner" role="status">
          <span>现在没有网络，测速结果不代表节点状态</span>
          {onOpenDiagnostics ? (
            <button type="button" className="btn btn--ghost" onClick={onOpenDiagnostics}>
              检查网络
            </button>
          ) : null}
        </div>
      ) : null}

      <div
        ref={listRef}
        className={`node-sheet__list ${virtual ? "is-virtual" : ""}`}
        role="listbox"
        aria-label="这个配置里的节点"
        aria-busy={Boolean(switchingId) || reordering}
        aria-activedescendant={
          activeId && visible.some((node) => node.node_id === activeId)
            ? `node-option-${activeId}`
            : undefined
        }
        tabIndex={0}
        onKeyDown={onListKeyDown}
        onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
        onPointerEnter={() => {
          pointerInside.current = true;
        }}
        onPointerMove={onListPointerMove}
        onPointerLeave={onListPointerLeave}
      >
        {rows.length === 0 ? (
          <p className="node-sheet__empty">没有匹配的节点</p>
        ) : (
          <div
            className="node-sheet__rows"
            style={virtual ? { height: rows.length * ROW_H, position: "relative" } : undefined}
          >
            {visible.map((node, offset) => {
              const index = virtual ? start + offset : offset;
              const isCurrent = node.node_id === config.current_node_id;
              const entry = probes.results[node.node_id];
              const badge = probeBadge(
                entry,
                now,
                probes.probing.has(node.node_id),
                run?.phase === "preparing",
              );
              // 可见集合里两种方式混合时，行内才补「可用 / 可达」前缀。
              const methodPrefix =
                mixedMethods &&
                (badge.kind === "ok" || badge.kind === "stale") &&
                entry?.latency_ms !== null
                  ? probeMethodOf(entry) === "clash"
                    ? "可用 "
                    : "可达 "
                  : "";
              const isSwitching = switchingId === node.node_id;
              const hasError = switchErrorId === node.node_id;
              return (
                <div
                  key={node.node_id}
                  id={`node-option-${node.node_id}`}
                  ref={(el) => {
                    if (el) rowRefs.current.set(node.node_id, el);
                    else rowRefs.current.delete(node.node_id);
                  }}
                  role="option"
                  aria-selected={isCurrent}
                  aria-current={isCurrent ? "true" : undefined}
                  aria-busy={isSwitching || undefined}
                  data-node-id={node.node_id}
                  className={[
                    "node-row",
                    isCurrent ? "is-current" : "",
                    activeId === node.node_id ? "is-active" : "",
                    isSwitching ? "is-switching" : "",
                    virtual ? "is-virtual" : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  style={
                    virtual
                      ? {
                          position: "absolute",
                          top: index * ROW_H,
                          left: 0,
                          right: 0,
                          height: ROW_H,
                        }
                      : undefined
                  }
                  onClick={() => void activate(node)}
                >
                  <span className="node-row__bar" aria-hidden />
                  <span className={`node-row__dot is-${badge.kind}`} aria-hidden />
                  <span className="node-row__name" title={node.name}>
                    {node.name}
                  </span>
                  {isCurrent ? <span className="node-row__current">当前</span> : null}
                  <span className="node-row__right">
                    {isSwitching ? (
                      <span className="node-row__switching">
                        <span className="node-row__pulse" aria-hidden />
                        切换中…
                      </span>
                    ) : hasError ? (
                      <span className="node-row__error">没切成，还在原来的节点</span>
                    ) : (
                      <>
                        {badge.previous ? (
                          <span className="node-row__previous">{badge.previous}</span>
                        ) : null}
                        <span className={`node-badge tone-${badge.tone}`}>
                          {methodPrefix}
                          {badge.label}
                        </span>
                      </>
                    )}
                  </span>
                  <span className="node-row__time">
                    {isSwitching || hasError ? "" : badge.time ?? ""}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <footer className="node-sheet__foot">
        <span className="node-sheet__foot-note">
          {reordering ? "正在按延迟排序…" : batchError ?? ignoredNote}
        </span>
        <span className="sr-only" role="status" aria-live="polite">
          {announcement}
        </span>
        {showBatch ? (
          <button
            type="button"
            className="btn btn--ghost"
            onClick={() => void startOrCancel()}
          >
            {batchLabel}
          </button>
        ) : null}
      </footer>
    </div>
  );
}

/** 节点卡上的紧凑延迟文字；没有结果时不占位。 */
export function currentNodeLatency(
  config: ConfigDetail,
  probes: NodeProbesController,
  now: number,
): { label: string; tone: string; age: string | null } | null {
  const nodeId = config.current_node_id;
  if (!nodeId) return null;
  const entry = probes.results[nodeId];
  if (!entry) return null;
  const badge = probeBadge(entry, now, false);
  if (badge.kind === "untested") return null;
  return {
    label: entry.reachable && entry.latency_ms !== null ? formatLatency(entry.latency_ms) : badge.label,
    tone: badge.tone,
    age: entry.checked_at ? ageLabel(entry.checked_at, now) : null,
  };
}
