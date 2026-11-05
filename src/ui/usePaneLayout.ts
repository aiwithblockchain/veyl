import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { shellLayout, type ShellMode } from "./breakpoints";
import {
  ASSISTANT_MIN,
  RAIL_MIN,
  assistantMaxFor,
  clampWidth,
  railMaxFor,
  readPanePrefs,
  resolvePaneWidths,
  writePaneWidth,
  type Pane,
  type PanePrefs,
} from "./layout";

interface DragState {
  pane: Pane;
  startX: number;
  startWidth: number;
  value: number;
  pointerId: number;
}

export interface UsePaneLayoutInput {
  windowWidth: number;
  mode: ShellMode;
  docked: boolean;
  panelOpen: boolean;
}

const KEY_STEP = 16;
const KEY_STEP_FAST = 64;

function readInitialPrefs(): PanePrefs {
  if (typeof localStorage === "undefined") return { rail: null, assistant: null };
  return readPanePrefs(localStorage);
}

/** 三栏拖拽：宽度偏好持久化，当前有效宽度由窗口与断点算出。 */
export function usePaneLayout({
  windowWidth,
  mode,
  docked,
  panelOpen,
}: UsePaneLayoutInput) {
  const [prefs, setPrefs] = useState<PanePrefs>(readInitialPrefs);
  const [drag, setDrag] = useState<{ pane: Pane; value: number } | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const rafRef = useRef<number | null>(null);

  const canDragRail = mode !== "drawer";
  const canDragPanel = docked && panelOpen;

  const layout = resolvePaneWidths({
    windowWidth,
    mode,
    docked,
    panelOpen,
    prefs,
  });
  const rail = drag?.pane === "rail" ? drag.value : layout.rail;
  const assistant = drag?.pane === "assistant" ? drag.value : layout.assistant;
  const railMax = railMaxFor(windowWidth, assistant);
  const assistantMax = assistantMaxFor(windowWidth, rail);

  const cancelDrag = useCallback(() => {
    dragRef.current = null;
    setDrag(null);
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  }, []);

  const commit = useCallback((pane: Pane, value: number) => {
    setPrefs((current) => ({ ...current, [pane]: Math.round(value) }));
    if (typeof localStorage !== "undefined") {
      writePaneWidth(localStorage, pane, value);
    }
  }, []);

  // 窗口变化时旧边界不再成立，直接取消这次拖拽。
  useEffect(() => {
    if (dragRef.current) cancelDrag();
  }, [windowWidth, cancelDrag]);

  useEffect(() => {
    if (!canDragPanel && dragRef.current?.pane === "assistant") cancelDrag();
  }, [canDragPanel, cancelDrag]);

  useEffect(() => {
    if (!canDragRail && dragRef.current?.pane === "rail") cancelDrag();
  }, [canDragRail, cancelDrag]);

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
      delete document.body.dataset.resizing;
    },
    [],
  );

  const startDrag = (pane: Pane) => (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    if (pane === "rail" && !canDragRail) return;
    if (pane === "assistant" && !canDragPanel) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const startWidth = pane === "rail" ? rail : assistant;
    dragRef.current = {
      pane,
      startX: event.clientX,
      startWidth,
      value: startWidth,
      pointerId: event.pointerId,
    };
    setDrag({ pane, value: startWidth });
  };

  const moveDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const current = dragRef.current;
    if (!current) return;
    const delta = event.clientX - current.startX;
    const raw =
      current.pane === "rail"
        ? current.startWidth + delta
        : current.startWidth - delta;
    const min = current.pane === "rail" ? RAIL_MIN : ASSISTANT_MIN;
    const max = current.pane === "rail" ? railMax : assistantMax;
    current.value = clampWidth(raw, min, max);

    if (rafRef.current === null) {
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = null;
        const now = dragRef.current;
        if (now) setDrag({ pane: now.pane, value: now.value });
      });
    }
  };

  const finishDrag = (persist: boolean) => (event: ReactPointerEvent<HTMLDivElement>) => {
    const current = dragRef.current;
    if (!current) return;
    try {
      if (event.currentTarget.hasPointerCapture(current.pointerId)) {
        event.currentTarget.releasePointerCapture(current.pointerId);
      }
    } catch {
      // 指针已经释放时忽略。
    }
    // 没移动就不写偏好：单击手柄不该改变宽度记忆。
    if (persist && current.value !== current.startWidth) {
      commit(current.pane, current.value);
    }
    cancelDrag();
  };

  const adjust = (pane: Pane, next: number) => {
    const max = pane === "rail" ? railMax : assistantMax;
    const min = pane === "rail" ? RAIL_MIN : ASSISTANT_MIN;
    commit(pane, clampWidth(next, min, max));
  };

  const handleKeyDown =
    (pane: Pane) => (event: ReactKeyboardEvent<HTMLDivElement>) => {
      const current = pane === "rail" ? rail : assistant;
      const min = pane === "rail" ? RAIL_MIN : ASSISTANT_MIN;
      const max = pane === "rail" ? railMax : assistantMax;

      // ARIA Window Splitter 惯例：Home = 最小，End = 最大；复位走双击。
      if (event.key === "Home" || event.key === "End") {
        event.preventDefault();
        adjust(pane, event.key === "Home" ? min : max);
        return;
      }
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault();
      const step = event.shiftKey ? KEY_STEP_FAST : KEY_STEP;
      const direction = event.key === "ArrowRight" ? 1 : -1;
      // 左栏向右变宽；助手手柄在它的左边界，向左变宽。
      const delta = pane === "rail" ? direction * step : -direction * step;
      if ((delta > 0 && current >= max) || (delta < 0 && current <= min)) return;
      adjust(pane, current + delta);
    };

  const resetPane = (pane: Pane) => () => {
    const defaults = shellLayout(windowWidth);
    adjust(pane, pane === "rail" ? defaults.rail : defaults.assistant);
  };

  return {
    rail,
    assistant,
    railMax,
    assistantMax,
    canDragRail,
    canDragPanel,
    draggingPane: drag?.pane ?? null,
    railHandlers: {
      onPointerDown: startDrag("rail"),
      onPointerMove: moveDrag,
      onPointerUp: finishDrag(true),
      onPointerCancel: finishDrag(false),
      onLostPointerCapture: finishDrag(true),
      onKeyDown: handleKeyDown("rail"),
      onDoubleClick: resetPane("rail"),
    },
    assistantHandlers: {
      onPointerDown: startDrag("assistant"),
      onPointerMove: moveDrag,
      onPointerUp: finishDrag(true),
      onPointerCancel: finishDrag(false),
      onLostPointerCapture: finishDrag(true),
      onKeyDown: handleKeyDown("assistant"),
      onDoubleClick: resetPane("assistant"),
    },
  };
}
