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
    state = chatReducer(state, { type: "request_started", requestId: "req_2" });
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
});
