import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";
import {
  PANEL_DEFAULT,
  PANEL_MAX,
  PANEL_MIN,
  RAIL_DEFAULT,
  RAIL_MAX,
  RAIL_MIN,
  clampWidth,
  computePaneLayout,
  panelMaxFor,
  parseStoredWidth,
  railMaxFor,
} from "./layout";

const RAIL_KEY = "veyl.ui.railWidth";
const PANEL_KEY = "veyl.ui.panelWidth";

type Pane = "rail" | "panel";

interface DragState {
  pane: Pane;
  startX: number;
  /** 按下时的有效宽度；只用于拖拽中的视觉反馈。 */
  startWidth: number;
  /** 按下时的偏好宽度；持久化以它加位移为准。 */
  startPref: number;
  value: number;
  pref: number;
  pointerId: number;
  target: HTMLElement;
}

function readStored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStored(key: string, value: number): void {
  try {
    localStorage.setItem(key, String(Math.round(value)));
  } catch {
    // localStorage 不可用时退化为内存态。
  }
}

/** 三栏宽度：偏好值持久化，当前有效宽度由窗口与断点算出；拖拽按帧更新。 */
export function usePaneLayout({
  appRef,
  panelOpen,
  active,
}: {
  appRef: RefObject<HTMLElement | null>;
  panelOpen: boolean;
  /** 主界面是否已渲染；引导页期间 .app 不存在，需要等它挂载后再观察。 */
  active: boolean;
}) {
  const [railPref, setRailPref] = useState(() =>
    parseStoredWidth(readStored(RAIL_KEY), RAIL_DEFAULT, RAIL_MIN, RAIL_MAX),
  );
  const [panelPref, setPanelPref] = useState(() =>
    parseStoredWidth(readStored(PANEL_KEY), PANEL_DEFAULT, PANEL_MIN, PANEL_MAX),
  );
  const [appWidth, setAppWidth] = useState(() =>
    typeof window === "undefined" ? 1440 : window.innerWidth,
  );
  const [drag, setDrag] = useState<{ pane: Pane; value: number } | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const rafRef = useRef<number | null>(null);
  const saveTimers = useRef<{ rail: number | null; panel: number | null }>({
    rail: null,
    panel: null,
  });

  const layout = computePaneLayout({
    windowWidth: appWidth,
    railPref,
    panelPref,
    panelOpen,
  });
  const rail = drag?.pane === "rail" ? drag.value : layout.rail;
  const panel = drag?.pane === "panel" ? drag.value : layout.panel;
  const railMax = railMaxFor(appWidth, layout.panel);
  const panelMax = panelMaxFor(appWidth, layout.rail);

  const cancelDrag = useCallback(() => {
    const current = dragRef.current;
    if (current) {
      try {
        if (current.target.hasPointerCapture(current.pointerId)) {
          current.target.releasePointerCapture(current.pointerId);
        }
      } catch {
        // 指针已释放或元素已卸载。
      }
    }
    dragRef.current = null;
    setDrag(null);
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (!active) return;
    const node = appRef.current;
    if (!node) return;
    const observer = new ResizeObserver((entries) => {
      const width = Math.round(entries[0]?.contentRect.width ?? window.innerWidth);
      setAppWidth(width);
      // 拖拽中窗口变化会用到旧边界，直接取消。
      if (dragRef.current) cancelDrag();
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [appRef, active, cancelDrag]);

  useEffect(() => {
    if (!panelOpen && dragRef.current?.pane === "panel") cancelDrag();
  }, [panelOpen, cancelDrag]);

  useEffect(() => {
    if (!drag) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      cancelDrag();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [drag, cancelDrag]);

  useEffect(() => {
    if (!drag) return;
    document.body.dataset.resizing = "true";
    return () => {
      delete document.body.dataset.resizing;
    };
  }, [drag]);

  useEffect(
    () => () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      if (saveTimers.current.rail !== null) window.clearTimeout(saveTimers.current.rail);
      if (saveTimers.current.panel !== null) window.clearTimeout(saveTimers.current.panel);
      delete document.body.dataset.resizing;
    },
    [],
  );

  const persistNow = (pane: Pane, value: number) => {
    const existing = saveTimers.current[pane];
    if (existing !== null) {
      window.clearTimeout(existing);
      saveTimers.current[pane] = null;
    }
    writeStored(pane === "rail" ? RAIL_KEY : PANEL_KEY, value);
  };

  const persistSoon = (pane: Pane, value: number) => {
    const existing = saveTimers.current[pane];
    if (existing !== null) window.clearTimeout(existing);
    saveTimers.current[pane] = window.setTimeout(() => {
      saveTimers.current[pane] = null;
      persistNow(pane, value);
    }, 150);
  };

  const commit = (pane: Pane, value: number, immediate: boolean) => {
    const min = pane === "rail" ? RAIL_MIN : PANEL_MIN;
    // 偏好存名义范围；窗口变窄只是显示上压到有效范围。
    const max = pane === "rail" ? RAIL_MAX : PANEL_MAX;
    const next = clampWidth(value, min, max);
    if (pane === "rail") setRailPref(next);
    else setPanelPref(next);
    if (immediate) persistNow(pane, next);
    else persistSoon(pane, next);
  };

  /** 双击 / Home 的复位要瞬时完成：这一帧关掉宽度过渡。 */
  const snap = (pane: Pane, value: number) => {
    const node = appRef.current;
    node?.setAttribute("data-snapping", "true");
    commit(pane, value, true);
    requestAnimationFrame(() => {
      requestAnimationFrame(() => node?.removeAttribute("data-snapping"));
    });
  };

  const startDrag = (pane: Pane) => (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    if (pane === "panel" && (layout.floating || !panelOpen)) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const startWidth = pane === "rail" ? layout.rail : layout.panel;
    // 压缩时偏好大于可见宽度；基准取可见宽度，松手按它重算才不会回弹。
    const startPref = Math.min(pane === "rail" ? railPref : panelPref, startWidth);
    dragRef.current = {
      pane,
      startX: event.clientX,
      startWidth,
      startPref,
      value: startWidth,
      pref: startPref,
      pointerId: event.pointerId,
      target: event.currentTarget,
    };
    setDrag({ pane, value: startWidth });
  };

  const moveDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const current = dragRef.current;
    if (!current) return;
    const delta = event.clientX - current.startX;
    const signed = current.pane === "rail" ? delta : -delta;
    const min = current.pane === "rail" ? RAIL_MIN : PANEL_MIN;
    const max =
      current.pane === "rail"
        ? railMaxFor(appWidth, layout.panel)
        : panelMaxFor(appWidth, layout.rail);
    const nominalMax = current.pane === "rail" ? RAIL_MAX : PANEL_MAX;
    current.value = clampWidth(current.startWidth + signed, min, max);
    current.pref = clampWidth(current.startPref + signed, min, nominalMax);

    if (rafRef.current === null) {
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = null;
        const now = dragRef.current;
        if (now) setDrag({ pane: now.pane, value: now.value });
      });
    }
  };

  const finishDrag = (persist: boolean) => () => {
    const current = dragRef.current;
    if (!current) return;
    // 偏好没变就不写；单击手柄不应把有效宽度写成偏好。
    if (persist && current.pref !== current.startPref) {
      if (current.pane === "rail") setRailPref(current.pref);
      else setPanelPref(current.pref);
      persistNow(current.pane, current.pref);
    }
    cancelDrag();
  };

  const handleKeyDown =
    (pane: Pane) => (event: ReactKeyboardEvent<HTMLDivElement>) => {
      const pref = pane === "rail" ? railPref : panelPref;
      const current = pane === "rail" ? layout.rail : layout.panel;
      // 以用户看到的宽度为基准；偏好高于有效宽度时不会出现按键死区。
      const base = Math.min(pref, current);
      const min = pane === "rail" ? RAIL_MIN : PANEL_MIN;
      const max = pane === "rail" ? railMax : panelMax;
      if (event.key === "Home") {
        event.preventDefault();
        snap(pane, pane === "rail" ? RAIL_DEFAULT : PANEL_DEFAULT);
        return;
      }
      if (event.key === "End") {
        event.preventDefault();
        commit(pane, max, false);
        return;
      }
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault();
      const step = event.shiftKey ? 64 : 16;
      const direction = event.key === "ArrowRight" ? 1 : -1;
      // 左栏向右变宽；右栏手柄在左边界，向左变宽。
      const delta = pane === "rail" ? direction * step : -direction * step;
      const next = clampWidth(base + delta, min, max);
      if (next === base) return;
      commit(pane, next, false);
    };

  const resetPane = (pane: Pane) => () => {
    snap(pane, pane === "rail" ? RAIL_DEFAULT : PANEL_DEFAULT);
  };

  return {
    floating: layout.floating,
    rail,
    panel,
    panelWidth: layout.panelWidth,
    railMax,
    panelMax,
    draggingPane: drag?.pane ?? null,
    railHandlers: {
      onPointerDown: startDrag("rail"),
      onPointerMove: moveDrag,
      onPointerUp: finishDrag(true),
      onPointerCancel: finishDrag(false),
      onKeyDown: handleKeyDown("rail"),
      onDoubleClick: resetPane("rail"),
    },
    panelHandlers: {
      onPointerDown: startDrag("panel"),
      onPointerMove: moveDrag,
      onPointerUp: finishDrag(true),
      onPointerCancel: finishDrag(false),
      onKeyDown: handleKeyDown("panel"),
      onDoubleClick: resetPane("panel"),
    },
  };
}
