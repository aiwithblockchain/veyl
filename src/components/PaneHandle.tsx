import type {
  KeyboardEventHandler,
  MouseEventHandler,
  PointerEventHandler,
} from "react";

interface Props {
  side: "rail" | "panel";
  label: string;
  controls: string;
  value: number;
  min: number;
  max: number;
  dragging: boolean;
  onPointerDown: PointerEventHandler<HTMLDivElement>;
  onPointerMove: PointerEventHandler<HTMLDivElement>;
  onPointerUp: PointerEventHandler<HTMLDivElement>;
  onPointerCancel: PointerEventHandler<HTMLDivElement>;
  onKeyDown: KeyboardEventHandler<HTMLDivElement>;
  onDoubleClick: MouseEventHandler<HTMLDivElement>;
}

export function PaneHandle({
  side,
  label,
  controls,
  value,
  min,
  max,
  dragging,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onPointerCancel,
  onKeyDown,
  onDoubleClick,
}: Props) {
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      tabIndex={0}
      aria-label={label}
      aria-controls={controls}
      aria-valuenow={Math.round(value)}
      aria-valuemin={Math.round(min)}
      aria-valuemax={Math.round(max)}
      aria-valuetext={`${Math.round(value)} 像素`}
      className={`pane-handle pane-handle--${side} ${dragging ? "is-dragging" : ""}`}
      data-dragging={dragging ? "true" : undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onKeyDown={onKeyDown}
      onDoubleClick={onDoubleClick}
    />
  );
}
