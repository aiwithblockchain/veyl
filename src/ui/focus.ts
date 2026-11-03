import { useEffect, type RefObject } from "react";

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "textarea:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

/**
 * 浮层焦点管理：打开时把焦点移入、Tab 在内部循环、关闭时归还给触发元素。
 * 只负责 Tab 与焦点，不处理 Esc（各组件自己处理）。
 */
export function useFocusTrap(open: boolean, ref: RefObject<HTMLElement | null>) {
  useEffect(() => {
    if (!open) return;
    const node = ref.current;
    if (!node) return;

    const previous =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;

    const focusables = () =>
      Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
        (element) => !element.hasAttribute("disabled"),
      );

    focusables()[0]?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const list = focusables();
      if (list.length === 0) {
        event.preventDefault();
        return;
      }
      const index = list.indexOf(document.activeElement as HTMLElement);
      if (event.shiftKey) {
        if (index <= 0) {
          event.preventDefault();
          list[list.length - 1].focus();
        }
      } else if (index === -1 || index === list.length - 1) {
        event.preventDefault();
        list[0].focus();
      }
    };

    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      previous?.focus();
    };
  }, [open, ref]);
}
