import { describe, expect, it } from "vitest";
import { AGENT_EVENTS, CONTRACT_VERSION } from "../agent/protocol";
import type { ChatState } from "./chatStore";
import {
  activeSession,
  chatReducer,
  createInitialState,
  createSession,
  isReportSession,
} from "./chatStore";

function withOneSession(): ChatState {
  const session = createSession(1000);
  return chatReducer(createInitialState(), {
    type: "add_session",
    session,
  });
}

describe("chatReducer", () => {
  it("发送消息 → 流式回复 → 请求结束的主路径", () => {
    let state = withOneSession();
    const sessionId = state.activeSessionId;

    state = chatReducer(state, {
      type: "send_user_message",
      sessionId,
      text: "帮我连到日本",
      localRequestId: "local_1",
    });

    let session = activeSession(state)!;
    expect(session.title).toBe("帮我连到日本");
    expect(session.messages).toHaveLength(2);
    expect(session.messages[0]).toMatchObject({
      role: "user",
      text: "帮我连到日本",
    });
    expect(session.requesting).toBe(true);
    expect(session.status?.text).toBe("正在思考");

    state = chatReducer(state, {
      type: "request_started",
      sessionId,
      requestId: "req_1",
    });
    session = activeSession(state)!;
    expect(session.activeRequestId).toBe("req_1");
    // request_started 只代表后端已开始，忙碌态要等 request_end 才解除。
    expect(session.requesting).toBe(true);

    state = chatReducer(state, {
      type: "agent_event",
      event: {
        name: AGENT_EVENTS.messageChunk,
        payload: {
          contract_version: CONTRACT_VERSION,
          request_id: "req_1",
          assistant_message_id: "asst_1",
          chunk: "已连接到东京 01。",
          emitted_at: "2026-11-04T00:00:00Z",
        },
      },
    });

    session = activeSession(state)!;
    const streamed = session.messages[1];
    expect(streamed.role).toBe("assistant");
    if (streamed.role === "assistant") {
      expect(streamed.id).toBe("asst_1");
      expect(streamed.streaming).toBe(true);
      expect(streamed.items).toEqual([
        { kind: "text", id: expect.any(String), content: "已连接到东京 01。" },
      ]);
    }
    expect(session.status?.text).toBe("正在回复");

    state = chatReducer(state, {
      type: "agent_event",
      event: {
        name: AGENT_EVENTS.requestEnd,
        payload: {
          contract_version: CONTRACT_VERSION,
          request_id: "req_1",
          assistant_message_id: "asst_1",
          result: "success",
          final_text: "已连接到东京 01。",
          error: null,
          usage: null,
          duration_ms: 120,
          emitted_at: "2026-11-04T00:00:01Z",
        },
      },
    });

    session = activeSession(state)!;
    const done = session.messages[1];
    expect(done.role).toBe("assistant");
    if (done.role === "assistant") {
      expect(done.streaming).toBe(false);
      expect(done.durationMs).toBe(120);
    }
    expect(session.activeRequestId).toBeNull();
    expect(session.requesting).toBe(false);
    expect(session.status).toBeNull();
  });

  it("请求失败会追加一条系统错误消息", () => {
    let state = withOneSession();
    const sessionId = state.activeSessionId;

    state = chatReducer(state, {
      type: "send_user_message",
      sessionId,
      text: "连到日本",
      localRequestId: "local_2",
    });
    state = chatReducer(state, {
      type: "request_started",
      sessionId,
      requestId: "req_2",
    });
    state = chatReducer(state, {
      type: "agent_event",
      event: {
        name: AGENT_EVENTS.requestEnd,
        payload: {
          contract_version: CONTRACT_VERSION,
          request_id: "req_2",
          assistant_message_id: "asst_2",
          result: "error",
          final_text: null,
          error: {
            contract_version: CONTRACT_VERSION,
            code: "UPSTREAM_ERROR",
            message: "模型服务不可用",
            retryable: true,
            details: null,
            request_id: "req_2",
          },
          usage: null,
          duration_ms: 50,
          emitted_at: "2026-11-04T00:00:01Z",
        },
      },
    });

    const session = activeSession(state)!;
    expect(session.requesting).toBe(false);
    expect(session.activeRequestId).toBeNull();
    expect(session.messages[session.messages.length - 1]).toMatchObject({
      role: "system",
      level: "error",
      text: "模型服务不可用",
    });
  });

  it("切到别的会话后，request_started / request_failed 仍落到目标会话", () => {
    let state = withOneSession();
    const firstSessionId = state.activeSessionId;

    state = chatReducer(state, { type: "new_session" });
    const secondSessionId = state.activeSessionId;
    expect(secondSessionId).not.toBe(firstSessionId);

    state = chatReducer(state, {
      type: "request_started",
      sessionId: firstSessionId,
      requestId: "req_first",
    });
    const first = state.sessions.find((item) => item.id === firstSessionId)!;
    const second = state.sessions.find((item) => item.id === secondSessionId)!;
    expect(first.activeRequestId).toBe("req_first");
    expect(second.activeRequestId).toBeNull();

    state = chatReducer(state, {
      type: "request_failed",
      sessionId: firstSessionId,
      message: "第一轮失败了",
    });
    const afterFirst = state.sessions.find((item) => item.id === firstSessionId)!;
    const afterSecond = state.sessions.find((item) => item.id === secondSessionId)!;
    expect(afterFirst.messages[afterFirst.messages.length - 1]).toMatchObject({
      role: "system",
      level: "error",
      text: "第一轮失败了",
    });
    expect(afterSecond.messages).toHaveLength(0);
  });

  it("有请求在跑（requesting 为 true）时，历史不会覆盖现场", () => {
    const base = createSession(1);
    const busy = { ...base, requesting: true, messages: [] };
    const state: ChatState = {
      sessions: [busy],
      activeSessionId: busy.id,
    };
    const history = {
      sessions: [
        { id: "old", title: "旧会话", created_at: "2026-01-01T00:00:00Z" },
      ],
      activeSessionId: "old",
      messages: [],
    };

    expect(chatReducer(state, { type: "hydrate_history", history })).toBe(state);
  });

  it("流式过程中切到别的会话，chunk 与 requestEnd 仍落到原会话", () => {
    let state = withOneSession();
    const firstSessionId = state.activeSessionId;

    state = chatReducer(state, {
      type: "send_user_message",
      sessionId: firstSessionId,
      text: "连到日本",
      localRequestId: "local_stream",
    });
    state = chatReducer(state, {
      type: "request_started",
      sessionId: firstSessionId,
      requestId: "req_stream",
    });

    state = chatReducer(state, { type: "new_session" });
    const secondSessionId = state.activeSessionId;

    state = chatReducer(state, {
      type: "agent_event",
      event: {
        name: AGENT_EVENTS.messageChunk,
        payload: {
          contract_version: CONTRACT_VERSION,
          request_id: "req_stream",
          assistant_message_id: "asst_stream",
          chunk: "已连接到东京 01。",
          emitted_at: "2026-11-04T00:00:00Z",
        },
      },
    });
    state = chatReducer(state, {
      type: "agent_event",
      event: {
        name: AGENT_EVENTS.requestEnd,
        payload: {
          contract_version: CONTRACT_VERSION,
          request_id: "req_stream",
          assistant_message_id: "asst_stream",
          result: "success",
          final_text: "已连接到东京 01。",
          error: null,
          usage: null,
          duration_ms: 120,
          emitted_at: "2026-11-04T00:00:01Z",
        },
      },
    });

    const first = state.sessions.find((item) => item.id === firstSessionId)!;
    const second = state.sessions.find((item) => item.id === secondSessionId)!;

    const assistant = first.messages[1];
    expect(assistant.role).toBe("assistant");
    if (assistant.role === "assistant") {
      expect(assistant.id).toBe("asst_stream");
      expect(assistant.streaming).toBe(false);
      expect(assistant.durationMs).toBe(120);
      expect(assistant.items).toEqual([
        {
          kind: "text",
          id: expect.any(String),
          content: "已连接到东京 01。",
        },
      ]);
    }
    expect(first.activeRequestId).toBeNull();
    expect(second.messages).toHaveLength(0);
    expect(second.activeRequestId).toBeNull();
    expect(second.status).toBeNull();
  });

  it("kickoff 发出后、request_started 之前切会话，首个 chunk 落到 kickoff 会话", () => {
    let state = withOneSession();
    const kickoffSessionId = state.activeSessionId;
    state = chatReducer(state, {
      type: "request_pending",
      sessionId: kickoffSessionId,
    });

    state = chatReducer(state, { type: "new_session" });
    const otherSessionId = state.activeSessionId;

    state = chatReducer(state, {
      type: "agent_event",
      event: {
        name: AGENT_EVENTS.messageChunk,
        payload: {
          contract_version: CONTRACT_VERSION,
          request_id: "req_kickoff",
          assistant_message_id: "asst_kickoff",
          chunk: "我先了解一下你的使用场景。",
          emitted_at: "2026-11-04T00:00:00Z",
        },
      },
    });

    const kickoff = state.sessions.find((item) => item.id === kickoffSessionId)!;
    const other = state.sessions.find((item) => item.id === otherSessionId)!;

    expect(kickoff.messages[0]).toMatchObject({
      role: "assistant",
      id: "asst_kickoff",
      streaming: true,
    });
    expect(other.messages).toHaveLength(0);
    expect(other.status).toBeNull();
  });

  it("目标会话在 request_started 前被删，后续事件不写进任何会话", () => {
    let state = withOneSession();
    const goneSessionId = state.activeSessionId;
    state = chatReducer(state, {
      type: "request_pending",
      sessionId: goneSessionId,
    });

    state = chatReducer(state, { type: "new_session" });
    const currentSessionId = state.activeSessionId;
    state = chatReducer(state, {
      type: "session_removed",
      sessionId: goneSessionId,
    });

    state = chatReducer(state, {
      type: "agent_event",
      event: {
        name: AGENT_EVENTS.messageChunk,
        payload: {
          contract_version: CONTRACT_VERSION,
          request_id: "req_gone",
          assistant_message_id: "asst_gone",
          chunk: "这段不应该出现。",
          emitted_at: "2026-11-04T00:00:00Z",
        },
      },
    });
    state = chatReducer(state, {
      type: "agent_event",
      event: {
        name: AGENT_EVENTS.requestEnd,
        payload: {
          contract_version: CONTRACT_VERSION,
          request_id: "req_gone",
          assistant_message_id: "asst_gone",
          result: "error",
          final_text: null,
          error: {
            contract_version: CONTRACT_VERSION,
            code: "INTERNAL",
            message: "这段也不应该出现",
            retryable: false,
            details: null,
            request_id: "req_gone",
          },
          usage: null,
          duration_ms: 10,
          emitted_at: "2026-11-04T00:00:01Z",
        },
      },
    });

    const current = state.sessions.find((item) => item.id === currentSessionId)!;
    expect(state.sessions).toHaveLength(1);
    expect(current.messages).toHaveLength(0);
    expect(current.status).toBeNull();
    expect(current.requesting).toBe(false);
  });

  it("会话 A 的请求结束后，迟到事件仍按消息里的 requestId 落到 A，而不是 requesting 的 B", () => {
    let state = withOneSession();
    const firstSessionId = state.activeSessionId;

    state = chatReducer(state, {
      type: "send_user_message",
      sessionId: firstSessionId,
      text: "连到日本",
      localRequestId: "local_late",
    });
    state = chatReducer(state, {
      type: "request_started",
      sessionId: firstSessionId,
      requestId: "req_late",
    });
    state = chatReducer(state, {
      type: "agent_event",
      event: {
        name: AGENT_EVENTS.messageChunk,
        payload: {
          contract_version: CONTRACT_VERSION,
          request_id: "req_late",
          assistant_message_id: "asst_late",
          chunk: "已连接到东京 01。",
          emitted_at: "2026-11-04T00:00:00Z",
        },
      },
    });
    state = chatReducer(state, {
      type: "agent_event",
      event: {
        name: AGENT_EVENTS.requestEnd,
        payload: {
          contract_version: CONTRACT_VERSION,
          request_id: "req_late",
          assistant_message_id: "asst_late",
          result: "success",
          final_text: "已连接到东京 01。",
          error: null,
          usage: null,
          duration_ms: 100,
          emitted_at: "2026-11-04T00:00:01Z",
        },
      },
    });

    // B 正在发起新请求：requesting 为 true，但 request_started 还没回来。
    state = chatReducer(state, { type: "new_session" });
    const secondSessionId = state.activeSessionId;
    state = chatReducer(state, {
      type: "request_pending",
      sessionId: secondSessionId,
    });

    // 一条属于 A 的迟到事件到达。
    state = chatReducer(state, {
      type: "agent_event",
      event: {
        name: AGENT_EVENTS.messageChunk,
        payload: {
          contract_version: CONTRACT_VERSION,
          request_id: "req_late",
          assistant_message_id: "asst_late",
          chunk: "迟到的补充。",
          emitted_at: "2026-11-04T00:00:02Z",
        },
      },
    });

    const first = state.sessions.find((item) => item.id === firstSessionId)!;
    const second = state.sessions.find((item) => item.id === secondSessionId)!;

    const assistant = first.messages[1];
    expect(assistant.role).toBe("assistant");
    if (assistant.role === "assistant") {
      const text = assistant.items
        .map((item) => (item.kind === "text" ? item.content : ""))
        .join("");
      expect(text).toContain("迟到的补充。");
    }
    expect(second.messages).toHaveLength(0);
    expect(second.activeRequestId).toBeNull();
    expect(second.requesting).toBe(true);
  });

  it("运行时升级事件不进对话流，也不会结束当前请求", () => {
    let state = withOneSession();
    const sessionId = state.activeSessionId;
    state = chatReducer(state, {
      type: "send_user_message",
      sessionId,
      text: "帮我检查运行时",
      localRequestId: "local_1",
    });
    state = chatReducer(state, {
      type: "request_started",
      sessionId,
      requestId: "req_1",
    });

    const before = state;
    let next = chatReducer(state, {
      type: "agent_event",
      event: {
        name: AGENT_EVENTS.coreUpgradeProgress,
        payload: {
          job_id: "job_1",
          phase: "downloading",
          received: 1024,
          total: 2048,
        },
      },
    });
    expect(next).toBe(before);

    next = chatReducer(next, {
      type: "agent_event",
      event: {
        name: AGENT_EVENTS.coreUpgradeFinished,
        payload: { job_id: "job_1", ok: true, version: "1.15.0" },
      },
    });
    expect(next).toBe(before);

    const session = activeSession(next)!;
    expect(session.activeRequestId).toBe("req_1");
    expect(session.status?.text).toBe("正在思考");
  });

  it("tool-call-end 把 display 归一化到工具调用上", () => {
    let state = withOneSession();
    const sessionId = state.activeSessionId;
    state = chatReducer(state, {
      type: "send_user_message",
      sessionId,
      text: "连到日本",
      localRequestId: "local_display",
    });
    state = chatReducer(state, {
      type: "request_started",
      sessionId,
      requestId: "req_display",
    });
    state = chatReducer(state, {
      type: "agent_event",
      event: {
        name: AGENT_EVENTS.toolCallStart,
        payload: {
          contract_version: CONTRACT_VERSION,
          request_id: "req_display",
          assistant_message_id: "asst_display",
          tool_call_id: "call_display",
          tool: "VpnConnect",
          action: "连接 seed-jp-01",
          permission_level: "execute",
          source: "agent",
          emitted_at: "2026-11-06T00:00:00Z",
        },
      },
    });
    state = chatReducer(state, {
      type: "agent_event",
      event: {
        name: AGENT_EVENTS.toolCallEnd,
        payload: {
          contract_version: CONTRACT_VERSION,
          request_id: "req_display",
          assistant_message_id: "asst_display",
          tool_call_id: "call_display",
          tool: "VpnConnect",
          success: true,
          result: "已连接到 东京 01。",
          result_truncated: false,
          error_code: null,
          duration_ms: 3200,
          next_actions: [],
          display: {
            text: "已连接",
            facts: ["出口 203.0.113.7", "延迟 42 毫秒"],
            changed: "none",
          },
          emitted_at: "2026-11-06T00:00:05Z",
        },
      },
    });

    const call = activeSession(state)!.toolCalls.call_display;
    expect(call.state).toBe("ok");
    expect(call.display).toEqual({
      text: "已连接",
      facts: [
        { label: "", value: "出口 203.0.113.7" },
        { label: "", value: "延迟 42 毫秒" },
      ],
      changed: "none",
      actions: [],
    });
  });

  it("display 缺失时保持为空，界面走静态兜底", () => {
    let state = withOneSession();
    const sessionId = state.activeSessionId;
    state = chatReducer(state, {
      type: "send_user_message",
      sessionId,
      text: "查状态",
      localRequestId: "local_plain",
    });
    state = chatReducer(state, {
      type: "request_started",
      sessionId,
      requestId: "req_plain",
    });
    state = chatReducer(state, {
      type: "agent_event",
      event: {
        name: AGENT_EVENTS.toolCallEnd,
        payload: {
          contract_version: CONTRACT_VERSION,
          request_id: "req_plain",
          assistant_message_id: "asst_plain",
          tool_call_id: "call_plain",
          tool: "RuntimeStatus",
          success: true,
          result: "运行中。",
          result_truncated: false,
          error_code: null,
          duration_ms: 380,
          next_actions: [],
          emitted_at: "2026-11-06T00:00:05Z",
        },
      },
    });

    expect(activeSession(state)!.toolCalls.call_plain.display).toBeNull();
  });

  it("运行中的状态文案不暴露工具名", () => {
    let state = withOneSession();
    const sessionId = state.activeSessionId;
    state = chatReducer(state, {
      type: "send_user_message",
      sessionId,
      text: "查状态",
      localRequestId: "local_running",
    });
    state = chatReducer(state, {
      type: "request_started",
      sessionId,
      requestId: "req_running",
    });
    state = chatReducer(state, {
      type: "agent_event",
      event: {
        name: AGENT_EVENTS.toolCallStart,
        payload: {
          contract_version: CONTRACT_VERSION,
          request_id: "req_running",
          assistant_message_id: "asst_running",
          tool_call_id: "call_running",
          tool: "RuntimeStatus",
          action: "查询状态",
          permission_level: "read_only",
          source: "agent",
          emitted_at: "2026-11-06T00:00:00Z",
        },
      },
    });
    const status = activeSession(state)!.status!;
    expect(status.text).toBe("正在检查连接状态");
    expect(status.text).not.toContain("RuntimeStatus");
    expect(status.text).not.toBe("正在执行 RuntimeStatus");
    expect(status.text).not.toBe("RuntimeStatus 正在运行");

    state = chatReducer(state, {
      type: "agent_event",
      event: {
        name: AGENT_EVENTS.status,
        payload: {
          contract_version: CONTRACT_VERSION,
          request_id: "req_running",
          assistant_message_id: "asst_running",
          phase: "running_tool",
          text: "RuntimeStatus 正在运行",
          emitted_at: "2026-11-06T00:00:01Z",
        },
      },
    });

    expect(activeSession(state)!.status?.text).toBe("正在检查连接状态");
  });

  it("未映射工具的运行中状态走同一个兜底文案", () => {
    let state = withOneSession();
    const sessionId = state.activeSessionId;
    state = chatReducer(state, {
      type: "send_user_message",
      sessionId,
      text: "试试新工具",
      localRequestId: "local_unknown",
    });
    state = chatReducer(state, {
      type: "request_started",
      sessionId,
      requestId: "req_unknown",
    });
    state = chatReducer(state, {
      type: "agent_event",
      event: {
        name: AGENT_EVENTS.toolCallStart,
        payload: {
          contract_version: CONTRACT_VERSION,
          request_id: "req_unknown",
          assistant_message_id: "asst_unknown",
          tool_call_id: "call_unknown",
          tool: "FooBar",
          action: "Using FooBar",
          permission_level: "read_only",
          source: "agent",
          emitted_at: "2026-11-06T00:00:00Z",
        },
      },
    });

    expect(activeSession(state)!.status?.text).toBe("正在处理…");
  });
});


// 单飞回归：requesting 到 request_end、气泡按 localRequestId 认领、BUSY 撤回。
describe("单飞与 BUSY", () => {
  function requestEnd(requestId: string) {
    return {
      name: AGENT_EVENTS.requestEnd,
      payload: {
        contract_version: CONTRACT_VERSION,
        request_id: requestId,
        assistant_message_id: `asst_${requestId}`,
        result: "success" as const,
        final_text: "好了",
        error: null,
        usage: null,
        duration_ms: 10,
        emitted_at: "",
      },
    };
  }

  it("发送后保持 requesting，直到该请求的 request_end", () => {
    let state = withOneSession();
    const sessionId = state.activeSessionId;
    state = chatReducer(state, {
      type: "send_user_message",
      sessionId,
      text: "你好",
      localRequestId: "local_fly",
    });
    state = chatReducer(state, {
      type: "request_started",
      sessionId,
      requestId: "req_fly",
      localRequestId: "local_fly",
    });
    expect(activeSession(state)!.requesting).toBe(true);

    state = chatReducer(state, {
      type: "agent_event",
      event: requestEnd("req_fly"),
    });
    expect(activeSession(state)!.requesting).toBe(false);
    expect(activeSession(state)!.activeRequestId).toBeNull();
  });

  it("只把本次 localRequestId 的气泡绑到新 requestId", () => {
    let state = withOneSession();
    const sessionId = state.activeSessionId;
    state = chatReducer(state, {
      type: "send_user_message",
      sessionId,
      text: "第一条",
      localRequestId: "local_a",
    });
    state = chatReducer(state, {
      type: "send_user_message",
      sessionId,
      text: "第二条",
      localRequestId: "local_b",
    });
    state = chatReducer(state, {
      type: "request_started",
      sessionId,
      requestId: "req_b",
      localRequestId: "local_b",
    });

    const messages = activeSession(state)!.messages;
    const first = messages.find((message) => message.id === "pending_local_a");
    const second = messages.find((message) => message.id === "pending_local_b");
    expect(first?.role === "assistant" ? first.requestId : null).toBe("local_a");
    expect(second?.role === "assistant" ? second.requestId : null).toBe("req_b");
  });

  it("ai_cancel 返回 false 时本地立即收尾，不等 request_end", () => {
    let state = withOneSession();
    const sessionId = state.activeSessionId;
    state = chatReducer(state, {
      type: "send_user_message",
      sessionId,
      text: "连到日本",
      localRequestId: "local_gone",
    });
    state = chatReducer(state, {
      type: "request_started",
      sessionId,
      requestId: "req_gone",
      localRequestId: "local_gone",
    });
    state = chatReducer(state, {
      type: "agent_event",
      event: {
        name: AGENT_EVENTS.messageChunk,
        payload: {
          contract_version: CONTRACT_VERSION,
          request_id: "req_gone",
          assistant_message_id: "asst_gone",
          chunk: "说到一半。",
          emitted_at: "",
        },
      },
    });

    state = chatReducer(state, {
      type: "request_cancelled_locally",
      sessionId,
      requestId: "req_gone",
    });

    const session = activeSession(state)!;
    expect(session.requesting).toBe(false);
    expect(session.activeRequestId).toBeNull();
    expect(session.status).toBeNull();
    const assistant = session.messages[session.messages.length - 1];
    expect(assistant.role === "assistant" ? assistant.streaming : true).toBe(false);
  });

  it("BUSY 被拒：撤回这次乐观插入的两条消息，其它内容不动", () => {
    let state = withOneSession();
    const sessionId = state.activeSessionId;
    state = chatReducer(state, {
      type: "send_user_message",
      sessionId,
      text: "先前的",
      localRequestId: "local_old",
    });
    state = chatReducer(state, {
      type: "send_user_message",
      sessionId,
      text: "这次的",
      localRequestId: "local_reject",
    });
    state = chatReducer(state, {
      type: "send_rejected",
      sessionId,
      localRequestId: "local_reject",
    });

    expect(activeSession(state)!.messages.map((message) => message.id)).toEqual([
      "user_local_old",
      "pending_local_old",
    ]);
    expect(activeSession(state)!.requesting).toBe(false);
    expect(activeSession(state)!.activeRequestId).toBeNull();
  });
});

describe("追问回答追加", () => {
  it("只追加一条 user 消息，不动请求状态", () => {
    let state = withOneSession();
    const sessionId = state.activeSessionId;
    state = chatReducer(state, {
      type: "send_user_message",
      sessionId,
      text: "帮我配一下",
      localRequestId: "local_1",
    });
    state = chatReducer(state, {
      type: "request_started",
      sessionId,
      requestId: "req_1",
    });
    const before = activeSession(state)!;

    state = chatReducer(state, {
      type: "append_user_message",
      sessionId,
      text: "我想给手机用",
    });

    const after = activeSession(state)!;
    expect(after.messages).toHaveLength(before.messages.length + 1);
    expect(after.messages[after.messages.length - 1]).toMatchObject({
      role: "user",
      text: "我想给手机用",
    });
    expect(after.requesting).toBe(true);
    expect(after.activeRequestId).toBe("req_1");
    expect(after.status).toEqual(before.status);
  });

  it("跳过（空串）不追加", () => {
    let state = withOneSession();
    const sessionId = state.activeSessionId;
    const before = activeSession(state)!.messages.length;

    state = chatReducer(state, {
      type: "append_user_message",
      sessionId,
      text: "",
    });

    expect(activeSession(state)!.messages).toHaveLength(before);
  });
});

describe("hidden 开场（问题报告）", () => {
  it("只挂助手占位，不出现用户气泡；request_started 认领它", () => {
    let state = withOneSession();
    const sessionId = state.activeSessionId;
    state = chatReducer(state, {
      type: "start_hidden_request",
      sessionId,
      localRequestId: "local_h",
    });

    const session = activeSession(state)!;
    expect(session.messages).toHaveLength(1);
    expect(session.messages[0]).toMatchObject({
      role: "assistant",
      requestId: "local_h",
      streaming: true,
    });
    expect(session.requesting).toBe(true);

    state = chatReducer(state, {
      type: "request_started",
      sessionId,
      requestId: "req_h",
      localRequestId: "local_h",
    });
    expect(activeSession(state)!.messages[0]).toMatchObject({ requestId: "req_h" });
  });
});

describe("报告会话判定", () => {
  it("历史里出现过 IssueReport 工具调用即为报告会话", () => {
    const session = createSession(1000);
    session.toolCalls["call_1"] = {
      id: "call_1",
      tool: "IssueReport",
      action: "",
      permissionLevel: "write",
      source: "agent",
      state: "ok",
      nextActions: [],
      startedAt: 1000,
    };
    expect(isReportSession(session)).toBe(true);
  });

  it("只有普通工具调用不是报告会话", () => {
    const session = createSession(1000);
    session.toolCalls["call_1"] = {
      id: "call_1",
      tool: "RuntimeStatus",
      action: "",
      permissionLevel: "read_only",
      source: "agent",
      state: "ok",
      nextActions: [],
      startedAt: 1000,
    };
    expect(isReportSession(session)).toBe(false);
  });

  it("空会话不是报告会话", () => {
    expect(isReportSession(createSession(1000))).toBe(false);
  });

  it("从历史恢复时按工具名判定，并置上 report", () => {
    const state = chatReducer(createInitialState(), {
      type: "hydrate_history",
      history: {
        sessions: [{ id: "s_rep", title: "问题报告", created_at: "2026-11-12T08:00:00.000Z" }],
        activeSessionId: "s_rep",
        messages: [
          { id: "m1", role: "user", content: "打不开网页", created_at: "2026-11-12T08:00:00.000Z" },
          {
            id: "m2",
            role: "assistant",
            content: "已收集现场材料",
            created_at: "2026-11-12T08:00:01.000Z",
            tool: { tool: "IssueReport" },
          },
        ],
      },
    });
    expect(state.sessions[0]?.report).toBe(true);
  });
});
