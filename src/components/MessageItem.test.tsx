/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage, TimelineItem, ToolCall } from "../state/chatStore";
import { MessageItem } from "./MessageItem";

afterEach(cleanup);

function makeCall(
  id: string,
  state: ToolCall["state"],
  text: string,
  tool = "RuntimeStatus",
): ToolCall {
  return {
    id,
    tool,
    action: "内部动作",
    permissionLevel: "read_only",
    source: "agent",
    state,
    nextActions: [],
    startedAt: 1,
    display: { text, facts: [], changed: null },
  };
}

function toolItem(id: string): TimelineItem {
  return { kind: "tool", id: `item_${id}`, callId: id };
}

function renderMessage(calls: ToolCall[]) {
  const toolCalls = Object.fromEntries(calls.map((call) => [call.id, call]));
  const items = calls.map((call) => toolItem(call.id));
  const message: ChatMessage = {
    id: "asst_1",
    role: "assistant",
    requestId: "req_1",
    items,
    streaming: false,
    at: 1,
  };
  render(<MessageItem message={message} toolCalls={toolCalls} onNextAction={vi.fn()} />);
}

describe("MessageItem：工具行合并", () => {
  it("连续 3 条成功合并成完成 3 步，展开后才逐条出现", () => {
    renderMessage([
      makeCall("a", "ok", "第一步"),
      makeCall("b", "ok", "第二步", "DiagRun"),
      makeCall("c", "ok", "第三步", "VpnConnect"),
    ]);

    expect(screen.getByText("完成 3 步")).toBeTruthy();
    expect(screen.queryByText("已查看连接状态")).toBeNull();
    expect(screen.queryByText("诊断已完成")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /完成 3 步/ }));
    expect(screen.getByText("已查看连接状态")).toBeTruthy();
    expect(screen.getByText("诊断已完成")).toBeTruthy();
    expect(screen.getByText("已连接")).toBeTruthy();
  });

  it("1–2 条成功不合并", () => {
    renderMessage([
      makeCall("a", "ok", "第一步"),
      makeCall("b", "ok", "第二步", "DiagRun"),
    ]);

    expect(screen.getByText("已查看连接状态")).toBeTruthy();
    expect(screen.getByText("诊断已完成")).toBeTruthy();
    expect(screen.queryByText(/完成 2 步/)).toBeNull();
  });

  it("失败断开合并，也不会被后续成功吞掉", () => {
    renderMessage([
      makeCall("a", "ok", "准备完成"),
      makeCall("b", "error", "没能连上", "VpnConnect"),
      makeCall("c", "ok", "第一步"),
      makeCall("d", "ok", "第二步"),
      makeCall("e", "ok", "第三步"),
    ]);

    expect(screen.getByText("已查看连接状态")).toBeTruthy();
    expect(screen.getByText("没能连上")).toBeTruthy();
    expect(screen.getByText("完成 3 步")).toBeTruthy();
    expect(screen.queryByText("已连接")).toBeNull();
  });

  it("进行中会断开合并，并单独成行", () => {
    renderMessage([
      makeCall("a", "ok", "第一步"),
      makeCall("b", "running", "正在连接"),
      makeCall("c", "ok", "第二步"),
      makeCall("d", "ok", "第三步"),
      makeCall("e", "ok", "第四步"),
    ]);

    expect(screen.getByText("已查看连接状态")).toBeTruthy();
    expect(screen.getByText("正在检查连接状态")).toBeTruthy();
    expect(screen.getByText("完成 3 步")).toBeTruthy();
  });

  it("AskUserQuestion 不渲染工具行，并断开合并", () => {
    renderMessage([
      makeCall("a", "ok", "第一步", "AskUserQuestion"),
      makeCall("b", "ok", "第二步"),
      makeCall("c", "ok", "第三步", "DiagRun"),
      makeCall("d", "error", "没能继续"),
      makeCall("e", "ok", "第四步", "VpnConnect"),
      makeCall("f", "ok", "第五步", "VpnConnect"),
      makeCall("g", "ok", "第六步", "VpnConnect"),
    ]);

    // AskUserQuestion 整行不渲染，也不参与合并。
    expect(screen.queryByText("已回答")).toBeNull();
    expect(screen.queryByText("AskUserQuestion")).toBeNull();
    expect(screen.getByText("已查看连接状态")).toBeTruthy();
    expect(screen.getByText("诊断已完成")).toBeTruthy();
    expect(screen.getByText("完成 3 步")).toBeTruthy();
    // 后面三条成功仍在合并组里，展开前不出现。
    expect(screen.queryByText("已连接")).toBeNull();
  });
});

describe("MessageItem：解释动作", () => {
  function renderUser(text: string) {
    const message: ChatMessage = { id: "user_1", role: "user", text, at: 1 };
    return render(
      <MessageItem message={message} toolCalls={{}} onNextAction={vi.fn()} />,
    );
  }

  it("解释文案渲染成动作记录，不是用户气泡", () => {
    const { container } = renderUser("解释这个设置的含义");

    expect(container.querySelector(".msg--action")?.textContent).toBe("已请求解释");
    expect(container.querySelector(".msg--user")).toBeNull();
    expect(screen.queryByText("你")).toBeNull();
  });

  it("英文界面的解释串也渲染成动作记录", () => {
    const { container } = renderUser("Explain what this setting means");

    expect(container.querySelector(".msg--action")?.textContent).toBe("已请求解释");
    expect(container.querySelector(".msg--user")).toBeNull();
  });

  it("普通用户消息仍是用户气泡", () => {
    const { container } = renderUser("帮我看看为什么连不上");

    expect(container.querySelector(".msg--user")).toBeTruthy();
    expect(container.querySelector(".msg--action")).toBeNull();
  });

  it("带前后空格的解释文案同样按动作处理", () => {
    const { container } = renderUser("  解释这个设置的含义  ");

    expect(container.querySelector(".msg--action")).toBeTruthy();
    expect(container.querySelector(".msg--user")).toBeNull();
  });
});
