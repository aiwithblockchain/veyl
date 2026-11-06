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
      makeCall("b", "ok", "第二步"),
      makeCall("c", "ok", "第三步"),
    ]);

    expect(screen.getByText("完成 3 步")).toBeTruthy();
    expect(screen.queryByText("第一步")).toBeNull();
    expect(screen.queryByText("第二步")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /完成 3 步/ }));
    expect(screen.getByText("第一步")).toBeTruthy();
    expect(screen.getByText("第二步")).toBeTruthy();
    expect(screen.getByText("第三步")).toBeTruthy();
  });

  it("1–2 条成功不合并", () => {
    renderMessage([
      makeCall("a", "ok", "第一步"),
      makeCall("b", "ok", "第二步"),
    ]);

    expect(screen.getByText("第一步")).toBeTruthy();
    expect(screen.getByText("第二步")).toBeTruthy();
    expect(screen.queryByText(/完成 2 步/)).toBeNull();
  });

  it("失败断开合并，也不会被后续成功吞掉", () => {
    renderMessage([
      makeCall("a", "ok", "准备完成"),
      makeCall("b", "error", "没能连上"),
      makeCall("c", "ok", "第一步"),
      makeCall("d", "ok", "第二步"),
      makeCall("e", "ok", "第三步"),
    ]);

    expect(screen.getByText("准备完成")).toBeTruthy();
    expect(screen.getByText("没能连上")).toBeTruthy();
    expect(screen.getByText("完成 3 步")).toBeTruthy();
    expect(screen.queryByText("第一步")).toBeNull();
  });

  it("进行中会断开合并，并单独成行", () => {
    renderMessage([
      makeCall("a", "ok", "第一步"),
      makeCall("b", "running", "正在连接"),
      makeCall("c", "ok", "第二步"),
      makeCall("d", "ok", "第三步"),
      makeCall("e", "ok", "第四步"),
    ]);

    expect(screen.getByText("第一步")).toBeTruthy();
    expect(screen.getByText("正在检查连接状态")).toBeTruthy();
    expect(screen.getByText("完成 3 步")).toBeTruthy();
  });

  it("AskUserQuestion 不渲染工具行，并断开合并", () => {
    renderMessage([
      makeCall("a", "ok", "第一步", "AskUserQuestion"),
      makeCall("b", "ok", "第二步"),
      makeCall("c", "ok", "第三步"),
      makeCall("d", "error", "没能继续"),
      makeCall("e", "ok", "第四步"),
      makeCall("f", "ok", "第五步"),
      makeCall("g", "ok", "第六步"),
    ]);

    expect(screen.queryByText("第一步")).toBeNull();
    expect(screen.queryByText("AskUserQuestion")).toBeNull();
    expect(screen.getByText("第二步")).toBeTruthy();
    expect(screen.getByText("第三步")).toBeTruthy();
    expect(screen.getByText("完成 3 步")).toBeTruthy();
    expect(screen.queryByText("第四步")).toBeNull();
  });
});
