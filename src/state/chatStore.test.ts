import { describe, expect, it } from "vitest";
import { AGENT_EVENTS, CONTRACT_VERSION } from "../agent/protocol";
import type { ChatState } from "./chatStore";
import {
  activeSession,
  chatReducer,
  createInitialState,
  createSession,
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
});
