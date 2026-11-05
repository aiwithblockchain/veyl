/** @vitest-environment jsdom */
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AssistantOverlay } from "./AssistantOverlay";

afterEach(cleanup);

describe("AssistantOverlay", () => {
  it("打开时焦点进入面板，Tab 在内部循环", () => {
    const { getByText } = render(
      <AssistantOverlay onClose={() => {}}>
        <button type="button">第一个</button>
        <button type="button">第二个</button>
      </AssistantOverlay>,
    );
    const first = getByText("第一个");
    const second = getByText("第二个");

    expect(document.activeElement).toBe(first);

    second.focus();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(document.activeElement).toBe(first);

    first.focus();
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(second);
  });

  it("Esc 收起，并且是带 aria-modal 的 dialog", () => {
    const onClose = vi.fn();
    const { container } = render(
      <AssistantOverlay onClose={onClose}>
        <button type="button">唯一</button>
      </AssistantOverlay>,
    );
    const dialog = container.querySelector(".assistant-overlay");
    expect(dialog?.getAttribute("role")).toBe("dialog");
    expect(dialog?.getAttribute("aria-modal")).toBe("true");

    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
