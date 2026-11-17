/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AssistantTab } from "./AssistantTab";

afterEach(cleanup);

describe("AssistantTab", () => {
  it("整个 tab 是一个按钮，竖排文字也在命中区内", () => {
    render(<AssistantTab unread={false} onOpen={() => {}} />);
    const button = screen.getByRole("button", { name: "展开助手" });
    expect(button.classList.contains("assistant-tab__open")).toBe(true);
    expect(button.textContent).toContain("助手");
    expect(button.querySelector(".assistant-tab__label")?.textContent).toBe(
      "助手",
    );
    expect(button.getAttribute("aria-expanded")).toBe("false");
  });

  it("点整块 tab 都会触发展开", () => {
    const onOpen = vi.fn();
    render(<AssistantTab unread={false} onOpen={onOpen} />);
    fireEvent.click(screen.getByText("助手"));
    expect(onOpen).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "展开助手" }));
    expect(onOpen).toHaveBeenCalledTimes(2);
  });

  it("有未读时 label 带上新消息，未读点在图标内", () => {
    const { container } = render(<AssistantTab unread onOpen={() => {}} />);
    const button = screen.getByRole("button", { name: "展开助手，有新消息" });
    const icon = button.querySelector(".assistant-tab__icon");
    expect(icon).not.toBeNull();
    expect(icon?.querySelector(".assistant-tab__dot")).not.toBeNull();
    expect(container.querySelector(".assistant-tab")).not.toBeNull();
  });

  it("没有未读时不出现未读点", () => {
    const { container } = render(<AssistantTab unread={false} onOpen={() => {}} />);
    expect(container.querySelector(".assistant-tab__dot")).toBeNull();
  });

  it("把 ref 交给按钮，Esc 收起后能还焦点", () => {
    const ref = createRef<HTMLButtonElement>();
    render(<AssistantTab unread={false} onOpen={() => {}} openButtonRef={ref} />);
    expect(ref.current).toBe(screen.getByRole("button", { name: "展开助手" }));
  });
});
