/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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

  it("回复中回车发送给出即时反馈，回复结束后收回", async () => {
    const onSend = vi.fn(() => true);
    const { rerender } = render(
      <Composer streaming statusText={null} onSend={onSend} onStop={() => {}} />,
    );

    type("第二条");
    fireEvent.keyDown(textarea(), { key: "Enter" });

    expect(screen.getByText("上一条还在回复，回完再发")).toBeTruthy();
    expect(onSend).not.toHaveBeenCalled();
    expect(textarea().value).toBe("第二条");

    rerender(<Composer streaming={false} statusText={null} onSend={onSend} onStop={() => {}} />);
    await waitFor(() =>
      expect(screen.queryByText("上一条还在回复，回完再发")).toBeNull(),
    );
  });

  it("回复中点击发送按钮同样给提示，输入内容不清空", () => {
    render(<Composer streaming statusText={null} onSend={() => true} onStop={() => {}} />);

    type("第二条");
    fireEvent.click(screen.getByTestId("composer-send-wrap"));

    expect(screen.getByText("上一条还在回复，回完再发")).toBeTruthy();
    expect(textarea().value).toBe("第二条");
  });

  it("提示 2.5 秒后自动消失", () => {
    vi.useFakeTimers();
    try {
      render(<Composer streaming statusText={null} onSend={() => true} onStop={() => {}} />);
      type("第二条");
      fireEvent.keyDown(textarea(), { key: "Enter" });
      expect(screen.getByText("上一条还在回复，回完再发")).toBeTruthy();

      act(() => {
        vi.advanceTimersByTime(2600);
      });

      expect(screen.queryByText("上一条还在回复，回完再发")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
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
