import { AGENT_EVENTS } from "../agent/protocol";
import type {
  AiStatusPhase,
  CallSource,
  NextAction,
  RequestResult,
  TokenUsage,
  ToolPermissionLevel,
} from "../agent/protocol";
import { readToolDisplay, toolCopy } from "../components/toolDisplay";
import type { ToolDisplayInfo } from "../components/toolDisplay";

export type ToolCallState = "running" | "ok" | "error";

export interface ToolCall {
  id: string;
  tool: string;
  action: string;
  permissionLevel: ToolPermissionLevel;
  source: CallSource;
  argsPreview?: Record<string, unknown>;
  state: ToolCallState;
  result?: string;
  errorCode?: string | null;
  nextActions: NextAction[];
  durationMs?: number;
  display?: ToolDisplayInfo | null;
  startedAt: number;
}

export type TimelineItem =
  | { kind: "text"; id: string; content: string }
  | { kind: "thinking"; id: string; content: string; complete: boolean }
  | { kind: "tool"; id: string; callId: string }
  | { kind: "notice"; id: string; text: string };

export type ChatMessage =
  | { id: string; role: "user"; text: string; at: number }
  | {
      id: string;
      role: "assistant";
      requestId: string;
      items: TimelineItem[];
      streaming: boolean;
      at: number;
      usage?: TokenUsage | null;
      durationMs?: number;
    }
  | { id: string; role: "system"; level: "info" | "error"; text: string; at: number };

export interface Session {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  /** 问题报告会话：消息流顶部常驻隐私披露。仅本次运行内有效。 */
  report?: boolean;
  messages: ChatMessage[];
  toolCalls: Record<string, ToolCall>;
  status: { text: string; phase: AiStatusPhase } | null;
  activeRequestId: string | null;
  requesting: boolean;
  /** 消息是否已从本地库加载过；DB 里恢复出来的会话首次选中时才加载。 */
  historyLoaded: boolean;
}

export interface ChatState {
  sessions: Session[];
  activeSessionId: string;
}

export type ChatAction =
  | { type: "select_session"; sessionId: string }
  | { type: "new_session" }
  | { type: "add_session"; session: Session }
  | { type: "send_user_message"; sessionId: string; text: string; localRequestId: string }
  | { type: "start_hidden_request"; sessionId: string; localRequestId: string }
  | { type: "append_user_message"; sessionId: string; text: string }
  | { type: "request_pending"; sessionId: string }
  | {
      type: "request_started";
      sessionId: string;
      requestId: string;
      /** 这次发送的本地临时 id；只认领它对应的那条气泡。 */
      localRequestId?: string;
    }
  | { type: "send_rejected"; sessionId: string; localRequestId: string }
  | { type: "request_cancelled_locally"; sessionId: string; requestId: string }
  | { type: "request_failed"; sessionId: string; message: string }
  | { type: "agent_event"; event: import("../agent/protocol").AgentEvent }
  | { type: "cancel_request" }
  | { type: "hydrate_history"; history: import("../agent/bridge").ChatHistory }
  | {
      type: "session_messages_loaded";
      sessionId: string;
      messages: import("../agent/bridge").StoredChatMessage[];
    }
  | { type: "session_renamed"; sessionId: string; title: string }
  | { type: "session_removed"; sessionId: string };

let idSeq = 0;
export function nextId(prefix: string): string {
  idSeq += 1;
  return `${prefix}_${Date.now().toString(36)}_${idSeq}`;
}

export function createSession(now = Date.now()): Session {
  return {
    id: nextId("session"),
    title: "新会话",
    createdAt: now,
    updatedAt: now,
    messages: [],
    toolCalls: {},
    status: null,
    activeRequestId: null,
    requesting: false,
    historyLoaded: true,
  };
}

export function createInitialState(): ChatState {
  // 允许「没有任何会话」：删除最后一个会话后回到总览空态（R31）。
  return { sessions: [], activeSessionId: "" };
}

export function activeSession(state: ChatState): Session | undefined {
  return (
    state.sessions.find((s) => s.id === state.activeSessionId) ?? state.sessions[0]
  );
}

function patchSession(
  state: ChatState,
  sessionId: string,
  patch: (session: Session) => Session,
): ChatState {
  return {
    ...state,
    sessions: state.sessions.map((s) => (s.id === sessionId ? patch(s) : s)),
  };
}

/**
 * 事件按 `assistant_message_id` 定位消息。Host 的 id 可能比 UI 的占位消息晚到，
 * 所以这里做一次「认领」：把本轮占位消息改名为 Host 的 id，而不是新开一条。
 *
 * 只合并最近一条用户消息之后的助手消息：用户回答把同一请求切成两段时，
 * 续写不能追回回答之前那条气泡，要在末尾另起一条。
 */
function withAssistant(
  session: Session,
  assistantId: string,
  requestId: string,
  update: (message: Extract<ChatMessage, { role: "assistant" }>) => ChatMessage,
  create = true,
): Session {
  const messages = [...session.messages];

  let found = -1;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const candidate = messages[i];
    // 只有用户的回答真正切断请求；中途插入的系统消息不影响续写归位。
    if (candidate.role === "user") break;
    if (candidate.role !== "assistant") continue;
    if (candidate.id === assistantId || candidate.requestId === requestId) {
      found = i;
      break;
    }
  }

  if (found >= 0) {
    const candidate = messages[found] as Extract<ChatMessage, { role: "assistant" }>;
    // 续写气泡用了带后缀的 id：别改名，否则会和前一段气泡撞 id。
    const idTaken = messages.some((message, index) => index !== found && message.id === assistantId);
    const renamed = assistantId && !idTaken ? { ...candidate, id: assistantId, requestId } : candidate;
    messages[found] = update(renamed);
    return { ...session, messages, updatedAt: Date.now() };
  }

  // Host 的 request_id 比 UI 的占位消息晚确定：认领本轮的空白占位消息。
  const last = messages[messages.length - 1];
  if (
    last &&
    last.role === "assistant" &&
    last.streaming &&
    last.items.length === 0 &&
    last.id.startsWith("pending_")
  ) {
    messages[messages.length - 1] = update({ ...last, id: assistantId, requestId });
    return { ...session, messages, updatedAt: Date.now() };
  }

  // 同一请求被用户回答隔开：前一段到此为止，续写在末尾新开一条。
  for (let i = 0; i < messages.length; i += 1) {
    const message = messages[i];
    if (
      message.role === "assistant" &&
      message.streaming &&
      (message.id === assistantId || message.requestId === requestId)
    ) {
      messages[i] = {
        ...message,
        streaming: false,
        items: closeOpenThinking(message.items),
      };
    }
  }

  // request_end 只收尾，不新建：没有内容就不该多出一条空气泡。
  if (!create) return { ...session, messages, updatedAt: Date.now() };

  const taken = new Set(messages.map((message) => message.id));
  let createdId = assistantId;
  let suffix = 1;
  while (createdId && taken.has(createdId)) {
    suffix += 1;
    createdId = `${assistantId}#${suffix}`;
  }

  const created: ChatMessage = {
    id: createdId,
    role: "assistant",
    requestId,
    items: [],
    streaming: true,
    at: Date.now(),
  };
  messages.push(update(created));
  return { ...session, messages, updatedAt: Date.now() };
}

function appendText(items: TimelineItem[], content: string): TimelineItem[] {
  const last = items[items.length - 1];
  if (last && last.kind === "text") {
    return [...items.slice(0, -1), { ...last, content: last.content + content }];
  }
  return [...items, { kind: "text", id: nextId("text"), content }];
}

function appendThinking(items: TimelineItem[], content: string): TimelineItem[] {
  const last = items[items.length - 1];
  if (last && last.kind === "thinking" && !last.complete) {
    return [...items.slice(0, -1), { ...last, content: last.content + content }];
  }
  return [...items, { kind: "thinking", id: nextId("thinking"), content, complete: false }];
}

function closeOpenThinking(items: TimelineItem[]): TimelineItem[] {
  const last = items[items.length - 1];
  if (last && last.kind === "thinking" && !last.complete) {
    return [...items.slice(0, -1), { ...last, complete: true }];
  }
  return items;
}

function parseTime(iso: string): number {
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? parsed : Date.now();
}

/** 本地库只存 role + content，恢复成消息流：assistant 的正文包成一条文本块。 */
export function messagesFromStored(
  stored: import("../agent/bridge").StoredChatMessage[],
): ChatMessage[] {
  return stored.flatMap((message): ChatMessage[] => {
    const at = parseTime(message.created_at);
    const id = `db_${message.id}`;

    if (message.role === "user") {
      return [{ id, role: "user", text: message.content, at }];
    }
    if (message.role === "assistant") {
      return [
        {
          id,
          role: "assistant",
          requestId: "",
          items: message.content
            ? [{ kind: "text", id: `${id}_t`, content: message.content }]
            : [],
          streaming: false,
          at,
        },
      ];
    }
    return [{ id, role: "system", level: "info", text: message.content, at }];
  });
}

export function titleFromText(text: string): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > 22 ? `${clean.slice(0, 22)}…` : clean || "新会话";
}

/**
 * 报告会话：运行时标记，或历史里出现过 IssueReport 工具调用。
 * 历史没有工具信息时只能靠运行时的 `report`。
 */
export function isReportSession(session: Session): boolean {
  if (session.report) return true;
  return Object.values(session.toolCalls).some((call) => call.tool === "IssueReport");
}

/** 只恢复工具名（够判定会话类型）；历史不重建工具卡，timeline 里没有引用。 */
function toolCallsFromStored(
  stored: import("../agent/bridge").StoredChatMessage[],
): Record<string, ToolCall> {
  const calls: Record<string, ToolCall> = {};
  for (const message of stored) {
    const name = message.tool?.tool;
    if (!name) continue;
    const id = `db_tool_${message.id}`;
    calls[id] = {
      id,
      tool: name,
      action: "",
      permissionLevel: "read_only",
      source: "agent",
      state: "ok",
      nextActions: [],
      startedAt: parseTime(message.created_at),
    };
  }
  return calls;
}

const REQUEST_RESULTS: Record<RequestResult, boolean> = {
  success: true,
  error: false,
  cancelled: false,
};

/** 流式事件属于发起它的会话；找不到（无 requestId / 会话已删）时由调用方决定是否丢弃。 */
function sessionForRequest(
  state: ChatState,
  requestId: string | null,
): Session | undefined {
  if (!requestId) return undefined;

  const byActive = state.sessions.find(
    (session) => session.activeRequestId === requestId,
  );
  if (byActive) return byActive;

  // 精确匹配优先于「猜」：消息里留着 requestId 说明这条请求确实属于它。
  const byMessage = state.sessions.find((session) =>
    session.messages.some(
      (message) =>
        message.role === "assistant" && message.requestId === requestId,
    ),
  );
  if (byMessage) return byMessage;

  // 刚发出、requestId 还没回来的窗口：只有一个会话在跑时才归给它。
  const requesting = state.sessions.filter((session) => session.requesting);
  if (requesting.length === 1) return requesting[0];

  return undefined;
}

export function chatReducer(state: ChatState, action: ChatAction): ChatState {
  const current = activeSession(state);

  switch (action.type) {
    case "select_session":
      return { ...state, activeSessionId: action.sessionId };

    case "new_session": {
      const session = createSession();
      return { sessions: [session, ...state.sessions], activeSessionId: session.id };
    }

    case "add_session":
      return {
        sessions: [action.session, ...state.sessions],
        activeSessionId: action.session.id,
      };

    case "send_user_message": {
      const target =
        state.sessions.find((session) => session.id === action.sessionId) ?? current;
      if (!target) return state;

      const now = Date.now();
      const isFirst = target.messages.length === 0;
      const assistant: ChatMessage = {
        id: `pending_${action.localRequestId}`,
        role: "assistant",
        requestId: action.localRequestId,
        items: [],
        streaming: true,
        at: now,
      };
      return patchSession(state, target.id, (session) => ({
        ...session,
        title: isFirst ? titleFromText(action.text) : session.title,
        updatedAt: now,
        requesting: true,
        status: { text: "正在思考", phase: "thinking" },
        messages: [
          ...session.messages,
          {
            id: `user_${action.localRequestId}`,
            role: "user",
            text: action.text,
            at: now,
          },
          assistant,
        ],
      }));
    }

    // 系统触发的开场指令不落成用户气泡：只挂一条等待回复的助手消息。
    case "start_hidden_request": {
      const target = state.sessions.find((session) => session.id === action.sessionId);
      if (!target) return state;
      const now = Date.now();
      return patchSession(state, target.id, (session) => ({
        ...session,
        updatedAt: now,
        requesting: true,
        status: { text: "正在思考", phase: "thinking" },
        messages: [
          ...session.messages,
          {
            id: `pending_${action.localRequestId}`,
            role: "assistant",
            requestId: action.localRequestId,
            items: [],
            streaming: true,
            at: now,
          },
        ],
      }));
    }

    // 回答提问只追加一条历史消息，不动请求状态：这一轮本来就没结束。
    case "append_user_message": {
      const target = state.sessions.find((session) => session.id === action.sessionId);
      if (!target || action.text.length === 0) return state;
      const now = Date.now();
      return patchSession(state, target.id, (session) => ({
        ...session,
        updatedAt: now,
        messages: [
          ...session.messages,
          { id: nextId("user"), role: "user", text: action.text, at: now },
        ],
      }));
    }

    case "request_pending": {
      const target = state.sessions.find((session) => session.id === action.sessionId);
      if (!target) return state;
      return patchSession(state, target.id, (session) => ({
        ...session,
        requesting: true,
        status: { text: "正在思考", phase: "thinking" },
      }));
    }

    case "request_started": {
      const target = state.sessions.find((session) => session.id === action.sessionId);
      if (!target) return state;
      return patchSession(state, target.id, (session) => ({
        ...session,
        activeRequestId: action.requestId,
        // request_started 只表示「后端已经开始」，忙碌态要等 request_end 才解除。
        requesting: true,
        messages: action.localRequestId
          ? session.messages.map((message) =>
              message.role === "assistant" &&
              (message.id === `pending_${action.localRequestId}` ||
                message.requestId === action.localRequestId)
                ? { ...message, requestId: action.requestId }
                : message,
            )
          : session.messages,
      }));
    }

    case "request_cancelled_locally": {
      // 后端说这条请求已经不在了（ai_cancel 返回 false）：本地立即收尾，
      // 不再等一个可能永远不会到的 request_end。
      const target = state.sessions.find((session) => session.id === action.sessionId);
      if (!target) return state;
      return patchSession(state, target.id, (session) => {
        if (
          session.activeRequestId !== null &&
          session.activeRequestId !== action.requestId
        ) {
          return session;
        }
        return {
          ...session,
          requesting: false,
          activeRequestId: null,
          status: null,
          messages: session.messages.map((message) =>
            message.role === "assistant" &&
            message.requestId === action.requestId
              ? {
                  ...message,
                  streaming: false,
                  items: closeOpenThinking(message.items),
                }
              : message,
          ),
        };
      });
    }

    case "send_rejected": {
      // 发送被后端拒绝（例如 BUSY）：撤回这次乐观插入的用户气泡与等待气泡。
      const target = state.sessions.find((session) => session.id === action.sessionId);
      if (!target) return state;
      return patchSession(state, target.id, (session) => ({
        ...session,
        requesting: false,
        activeRequestId: null,
        status: null,
        messages: session.messages.filter(
          (message) =>
            message.id !== `user_${action.localRequestId}` &&
            message.id !== `pending_${action.localRequestId}`,
        ),
      }));
    }

    case "request_failed": {
      const target = state.sessions.find((session) => session.id === action.sessionId);
      if (!target) return state;
      return patchSession(state, target.id, (session) => ({
        ...session,
        requesting: false,
        activeRequestId: null,
        status: null,
        messages: [
          ...session.messages,
          {
            id: nextId("system"),
            role: "system",
            level: "error",
            text: action.message,
            at: Date.now(),
          },
        ],
      }));
    }

    case "agent_event": {
      const { event } = action;
      const payload = event.payload;
      let hasRequestId = false;
      let requestId: string | null = null;
      if ("request_id" in payload) {
        hasRequestId = true;
        requestId = payload.request_id;
      }
      // 有 requestId 却找不到归属 → 丢弃，绝不能写进别的会话；
      // 没有 requestId 的事件仍退回当前会话。
      const current =
        sessionForRequest(state, requestId) ??
        (hasRequestId ? undefined : activeSession(state));
      if (!current) return state;

      switch (event.name) {
        case AGENT_EVENTS.messageChunk:
          return patchSession(state, current.id, (session) => ({
            ...withAssistant(session, event.payload.assistant_message_id, event.payload.request_id, (message) => ({
              ...message,
              streaming: true,
              items: appendText(message.items, event.payload.chunk),
            })),
            status: { text: "正在回复", phase: "streaming_answer" },
          }));

        case AGENT_EVENTS.thinkingChunk:
          return patchSession(state, current.id, (session) =>
            withAssistant(session, event.payload.assistant_message_id, event.payload.request_id, (message) => ({
              ...message,
              streaming: true,
              items: appendThinking(message.items, event.payload.chunk),
            })),
          );

        case AGENT_EVENTS.toolCallStart: {
          const { tool_call_id, tool, action: label } = event.payload;
          return patchSession(state, current.id, (session) => ({
            ...withAssistant(session, event.payload.assistant_message_id, event.payload.request_id, (message) => ({
              ...message,
              items: [
                ...closeOpenThinking(message.items),
                { kind: "tool", id: nextId("tool"), callId: tool_call_id },
              ],
            })),
            toolCalls: {
              ...session.toolCalls,
              [tool_call_id]: {
                id: tool_call_id,
                tool,
                action: label,
                permissionLevel: event.payload.permission_level,
                source: event.payload.source,
                argsPreview: event.payload.args_preview,
                state: "running",
                nextActions: [],
                startedAt: Date.now(),
              },
            },
            status: { text: toolCopy(tool).running, phase: "running_tool" },
          }));
        }

        case AGENT_EVENTS.toolCallEnd: {
          const { tool_call_id, success, result, error_code, duration_ms, next_actions } =
            event.payload;
          return patchSession(state, current.id, (session) => {
            const existing = session.toolCalls[tool_call_id] ?? {
              id: tool_call_id,
              tool: event.payload.tool,
              action: "",
              permissionLevel: "read_only" as ToolPermissionLevel,
              source: "agent" as CallSource,
              state: "running" as ToolCallState,
              nextActions: [],
              startedAt: Date.now(),
            };
            return {
              ...session,
              toolCalls: {
                ...session.toolCalls,
                [tool_call_id]: {
                  ...existing,
                  state: success ? "ok" : "error",
                  result,
                  errorCode: error_code,
                  durationMs: duration_ms,
                  nextActions: next_actions ?? [],
                  display: readToolDisplay(event.payload.display),
                },
              },
              updatedAt: Date.now(),
            };
          });
        }

        case AGENT_EVENTS.status:
          return patchSession(state, current.id, (session) => ({
            ...session,
            // running_tool 的原始文案可能带工具名，保留 tool-call-start 写的用户语言。
            status: {
              text:
                event.payload.phase === "running_tool"
                  ? session.status?.phase === "running_tool"
                    ? session.status.text
                    : "正在处理…"
                  : event.payload.text,
              phase: event.payload.phase,
            },
          }));

        case AGENT_EVENTS.compact:
          return patchSession(state, current.id, (session) =>
            withAssistant(session, event.payload.assistant_message_id, event.payload.request_id, (message) => ({
              ...message,
              items: [
                ...message.items,
                { kind: "notice", id: nextId("notice"), text: event.payload.text || "上下文已压缩" },
              ],
            })),
          );

        case AGENT_EVENTS.requestEnd: {
          const { result, error, usage, duration_ms } = event.payload;
          return patchSession(state, current.id, (session) => {
            const patched = withAssistant(
              session,
              event.payload.assistant_message_id,
              event.payload.request_id,
              (message) => ({
                ...message,
                streaming: false,
                items: closeOpenThinking(message.items),
                usage,
                durationMs: duration_ms,
              }),
              false,
            );

            if (!REQUEST_RESULTS[result]) {
              const text =
                result === "cancelled"
                  ? "已停止"
                  : error?.message ?? "本轮请求失败";
              return {
                ...patched,
                activeRequestId: null,
                requesting: false,
                status: null,
                messages: [
                  ...patched.messages,
                  {
                    id: nextId("system"),
                    role: "system" as const,
                    level: (result === "cancelled" ? "info" : "error") as "info" | "error",
                    text,
                    at: Date.now(),
                  },
                ],
              };
            }

            return { ...patched, activeRequestId: null, requesting: false, status: null };
          });
        }

        // 应用事件由 runtime 视图消费，不进对话流。
        case AGENT_EVENTS.runtimeStateChanged:
        case AGENT_EVENTS.runtimeHealthChanged:
        case AGENT_EVENTS.jobProgress:
        case AGENT_EVENTS.appLifecycleChanged:
        case AGENT_EVENTS.defaultProfileUpdated:
        case AGENT_EVENTS.askUserQuestion:
        // 配置 / 节点 / 问题 / 布局事件由各自的视图消费，不进对话流。
        case AGENT_EVENTS.configChanged:
        case AGENT_EVENTS.nodeListChanged:
        case AGENT_EVENTS.nodeSwitched:
        case AGENT_EVENTS.issueChanged:
        case AGENT_EVENTS.layoutUpdated:
        case AGENT_EVENTS.routingChanged:
        case AGENT_EVENTS.regionChanged:
        case AGENT_EVENTS.rulesChanged:
        // 运行时升级由设置页的升级状态机消费，不进对话流。
        case AGENT_EVENTS.coreUpgradeProgress:
        case AGENT_EVENTS.coreUpgradeFinished:
        // 批量测速由节点面板消费，不进对话流。
        case AGENT_EVENTS.nodeProbeProgress:
        case AGENT_EVENTS.nodeProbeFinished:
          return state;

        default:
          return state;
      }
    }

    case "cancel_request":
      if (!current) return state;
      return patchSession(state, current.id, (session) => ({
        ...session,
        status: { text: "正在停止", phase: "thinking" },
      }));

    case "hydrate_history": {
      const { history } = action;
      // 空库：保持现在的「一个新建空会话」，不报错。
      if (history.sessions.length === 0) return state;
      // 已经有内容或有请求在跑：不拿历史覆盖，避免打断正在进行的对话。
      const busy = state.sessions.some(
        (session) =>
          session.activeRequestId !== null ||
          session.requesting ||
          session.messages.length > 0,
      );
      if (busy) return state;

      const sessions: Session[] = history.sessions.map((summary) => ({
        id: summary.id,
        title: summary.title || "未命名会话",
        createdAt: parseTime(summary.created_at),
        updatedAt: parseTime(summary.created_at),
        messages: [],
        toolCalls: {},
        status: null,
        activeRequestId: null,
        requesting: false,
        historyLoaded: false,
      }));

      const active =
        (history.activeSessionId
          ? sessions.find((session) => session.id === history.activeSessionId)
          : undefined) ?? sessions[0];

      const messages = messagesFromStored(history.messages);
      active.messages = messages;
      active.toolCalls = toolCallsFromStored(history.messages);
      active.historyLoaded = true;
      if (isReportSession(active)) active.report = true;
      const last = messages[messages.length - 1];
      if (last) active.updatedAt = Math.max(active.updatedAt, last.at);

      return { sessions, activeSessionId: active.id };
    }

    case "session_messages_loaded":
      return patchSession(state, action.sessionId, (session) => {
        // 加载期间用户已经发过消息：以现场为准，只标记已加载。
        if (session.historyLoaded || session.messages.length > 0) {
          return { ...session, historyLoaded: true };
        }
        const messages = messagesFromStored(action.messages);
        const last = messages[messages.length - 1];
        const next: Session = {
          ...session,
          messages,
          toolCalls: toolCallsFromStored(action.messages),
          historyLoaded: true,
          updatedAt: last ? Math.max(session.updatedAt, last.at) : session.updatedAt,
        };
        return isReportSession(next) ? { ...next, report: true } : next;
      });

    case "session_renamed":
      return patchSession(state, action.sessionId, (session) => ({
        ...session,
        title: action.title,
      }));

    case "session_removed": {
      const remaining = state.sessions.filter((session) => session.id !== action.sessionId);
      if (remaining.length === 0) {
        // 删光就回到「没有任何对话」的空态，不偷偷补一个空会话。
        return { sessions: [], activeSessionId: "" };
      }
      return {
        sessions: remaining,
        activeSessionId:
          state.activeSessionId === action.sessionId
            ? remaining[0].id
            : state.activeSessionId,
      };
    }

    default:
      return state;
  }
}
