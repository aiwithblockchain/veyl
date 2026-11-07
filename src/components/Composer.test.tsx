/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Composer } from "./Composer";

afterEach(cleanup);

function textarea(): HTMLTextAreaElement {
  return screen.getByRole("textbox") as HTMLTextAreaElement;
}

function type(text: string) {
  fireEvent.change(textarea(), { target: { value: text } });
}

describe("Composer 单飞", () => {
  it("同一 tick 连点两次只发一条", () => {
    const onSend = vi.fn(() => new Promise<boolean>(() => {}));
    render(<Composer streaming={false} statusText={null} onSend={onSend} onStop={() => {}} />);

    type("你好");
    const send = screen.getByRole("button", { name: "发送" });
    fireEvent.click(send);
    fireEvent.click(send);

    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it("回复中按钮写「等待回复」并禁用，Enter 不发送，文字留在输入框", () => {
    const onSend = vi.fn(() => true);
    render(<Composer streaming statusText="正在回复" onSend={onSend} onStop={() => {}} />);

    const button = screen.getByRole("button", { name: "等待回复" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);

    type("第二条");
    fireEvent.keyDown(textarea(), { key: "Enter" });

    expect(onSend).not.toHaveBeenCalled();
    expect(textarea().value).toBe("第二条");
  });

  it("发送被拦下时把文字放回输入框", async () => {
    const onSend = vi.fn(async () => false);
    render(<Composer streaming={false} statusText={null} onSend={onSend} onStop={() => {}} />);

    type("这条发不出去");
    fireEvent.click(screen.getByRole("button", { name: "发送" }));

    expect(onSend).toHaveBeenCalledWith("这条发不出去");
    await waitFor(() => expect(textarea().value).toBe("这条发不出去"));
  });

  it("发送成功时输入框清空", async () => {
    const onSend = vi.fn(async () => true);
    render(<Composer streaming={false} statusText={null} onSend={onSend} onStop={() => {}} />);

    type("能发出去");
    fireEvent.click(screen.getByRole("button", { name: "发送" }));

    await waitFor(() => expect(textarea().value).toBe(""));
  });
});
