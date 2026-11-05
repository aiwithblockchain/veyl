import type { ReactNode } from "react";

interface IconProps {
  size?: number;
  className?: string;
}

function base(size: number, className: string | undefined, children: ReactNode) {
  return (
    <svg
      className={className}
      viewBox="0 0 16 16"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {children}
    </svg>
  );
}

export function IconClose({ size = 14, className }: IconProps) {
  return base(size, className, <path d="M4 4l8 8M12 4l-8 8" />);
}

export function IconPlus({ size = 16, className }: IconProps) {
  return base(size, className, <path d="M8 3.5v9M3.5 8h9" />);
}

export function IconChevronLeft({ size = 16, className }: IconProps) {
  return base(size, className, <path d="M9.5 4 5.5 8l4 4" />);
}

export function IconChevronRight({ size = 16, className }: IconProps) {
  return base(size, className, <path d="M6.5 4 10.5 8l-4 4" />);
}

export function IconList({ size = 16, className }: IconProps) {
  return base(
    size,
    className,
    <>
      <path d="M3 4.5h10M3 8h10M3 11.5h10" />
    </>,
  );
}

export function IconSliders({ size = 16, className }: IconProps) {
  return base(
    size,
    className,
    <>
      <path d="M3 5h10M3 11h10" />
      <circle cx="6" cy="5" r="1.6" />
      <circle cx="10" cy="11" r="1.6" />
    </>,
  );
}

export function IconPencil({ size = 14, className }: IconProps) {
  return base(
    size,
    className,
    <>
      <path d="M10.5 3.5 12.5 5.5 6 12H4v-2z" />
      <path d="M9.5 4.5 11.5 6.5" />
    </>,
  );
}

export function IconTrash({ size = 14, className }: IconProps) {
  return base(
    size,
    className,
    <>
      <path d="M3.5 4.5h9M6.5 4.5V3.5h3v1M5 4.5l.6 8h4.8l.6-8" />
      <path d="M7 7v3.5M9 7v3.5" />
    </>,
  );
}

export function IconKey({ size = 16, className }: IconProps) {
  return base(
    size,
    className,
    <>
      <circle cx="5.5" cy="6" r="2.5" />
      <path d="M7.4 8.2l5.1 5.1M10.4 11.2l1.6-1.6M12 12.8l1.6-1.6" />
    </>,
  );
}
