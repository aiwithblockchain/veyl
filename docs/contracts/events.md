# 契约：事件与 UI ↔ Host 调用

> 契约版本：`1.0.7`
> 状态：已冻结（PM 审核通过，2026-11-02）
> 上游：`docs/phase-1-technical-design.md` §4.2、§4.3
> 实现方：Rust（Host 发送）、TypeScript（UI 订阅）
> 参考实现：`TweetPilot/src-tauri/src/claurst_session.rs`
> 变更记录：见 §10

---

## 0. 本契约的地位

本文档定义 **Tauri event 名称与 payload**。UI 只依赖这些事件渲染，不轮询内部状态。

统一约定：

- 事件名 **kebab-case**，与 TweetPilot 保持一致，便于复用前端经验。
- payload 字段 **snake_case**。
- 时间字段 **ISO 8601 UTC + `Z`**。
- 错误码 **大写下划线**。
- 所有 payload 带 `contract_version`。

> **命名决策**：事件名沿用 TweetPilot 的真实名称（`message-chunk`、`thinking-chunk`、`tool-call-start`、`tool-call-end`、`ai-status`、`ai-compact`、`ai-request-end`），**不**加 `ai-` 前缀。`docs/phase-1-technical-design.md` §4.2 写的 `agent://delta` / `agent://tool` 是笔误，以本契约为准。

---

## 1. 事件总表

| # | 事件名 | 方向 | 载荷类型 | 触发 |
|---|---|---|---|---|
| 1 | `message-chunk` | Host → UI | `MessageChunkPayload` | 模型文本增量 |
| 2 | `thinking-chunk` | Host → UI | `ThinkingChunkPayload` | 模型思考增量 |
| 3 | `tool-call-start` | Host → UI | `ToolCallStartPayload` | 工具开始执行 |
| 4 | `tool-call-end` | Host → UI | `ToolCallEndPayload` | 工具执行结束 |
| 5 | `ai-status` | Host → UI | `AiStatusPayload` | 阶段状态变化 |
| 6 | `ai-compact` | Host → UI | `AiCompactPayload` | 上下文压缩 |
| 7 | `ai-request-end` | Host → UI | `AiRequestEndPayload` | 本轮请求结束 |
| 8 | `runtime-state-changed` | Host → UI | `RuntimeStateChangedPayload` | 运行时状态迁移 |
| 9 | `runtime-health-changed` | Host → UI | `RuntimeHealthChangedPayload` | 健康快照变化 |
| 10 | `job-progress` | Host → UI | `JobProgressPayload` | 长任务进度 |
| 11 | `approval-requested` | Host → UI | `ApprovalRequestedPayload` | 需要用户确认 |

1–7 是 AI 会话事件，8–11 是应用事件。UI 必须同时订阅两组，否则会出现「AI 说已连接，状态面板还是未连接」。

---

## 2. 通用约定

### 2.1 关联键

- 所有 1–7 事件带 `request_id`：一次「用户发一条消息 → 助手回完」的全过程共用一个。
- `tool-call-start` / `tool-call-end` 额外带 `tool_call_id`，配对使用。
- UI 必须按 `request_id` 过滤，防止旧请求的迟到事件污染新会话（用户点「停止」后立刻重发时会发生）。

### 2.2 顺序保证

Tauri 不保证跨 `emit` 调用的顺序，因此约定：

- `message-chunk` 的增量顺序由前端按到达顺序拼接，Host 侧保证单 `request_id` 内串行发送。
- `tool-call-start` 一定先于同 `tool_call_id` 的 `tool-call-end`。
- `ai-request-end` 一定是该 `request_id` 的最后一个事件。

### 2.3 时间戳

每个 payload 都有 `emitted_at`（ISO 8601 UTC）。**这是相对 TweetPilot 的新增字段**，用于前端排查顺序问题；TweetPilot 的前端不读它，可以安全忽略。

### 2.4 大小限制

- 单个事件 payload ≤ 64 KB。
- `tool-call-end.result` 超过 8 KB 时截断，追加 `…(truncated)`，并置 `result_truncated: true`。
- 完整结果在 `tool-calls` 表里，UI 可按 `tool_call_id` 拉取。

---

## 3. AI 会话事件

### 3.1 `message-chunk`

```ts
type MessageChunkPayload = {
  contract_version: "1.0.7";
  request_id: string;
  assistant_message_id: string;
  chunk: string;            // 增量文本，非全量
  emitted_at: string;
};
```

来源：`QueryEvent::Stream(AnthropicStreamEvent::ContentBlockDelta { delta: ContentDelta::TextDelta })`。

UI 处理：

1. 按 `assistant_message_id` 找到或创建 assistant 气泡。
2. 追加 `chunk`。
3. 按 16 ms 合并重绘（`phase-1-technical-design.md` §4.2）。

---

### 3.2 `thinking-chunk`

```ts
type ThinkingChunkPayload = {
  contract_version: "1.0.7";
  request_id: string;
  assistant_message_id: string;
  chunk: string;
  emitted_at: string;
};
```

来源：`ContentDelta::ThinkingDelta`。

UI 处理：追加到折叠的思考区；若模型没有思考能力（DeepSeek 部分模型），此事件不会出现，UI 不得报错。

---

### 3.3 `tool-call-start`

```ts
type ToolCallStartPayload = {
  contract_version: "1.0.7";
  request_id: string;
  assistant_message_id: string;
  tool_call_id: string;
  tool: string;                 // 模型可见名，PascalCase，例 "VpnConnect"
  action: string;               // 人类可读的一行，例 "连接到 东京 01"
  permission_level: "none" | "read_only" | "write" | "execute";
  approval_policy: "never" | "always" | "first_time_per_session";
  source: "ui" | "agent";        // 调用来源，由 Host 通道注入
  args_preview?: Record<string, unknown>;  // 默认展示；全被脱敏时省略
  emitted_at: string;
};
```

来源：`QueryEvent::ToolStart { tool_name, tool_id, input_json }`。

`action` 生成规则：

- 由工具实现提供 `summarize(input) -> String`。
- 没有实现的工具退化为 `Using <tool>`。
- **不得包含凭据**。

`args_preview` 规则（见 `tools.md` §2.5）：

- **默认展示所有非敏感字段**。
- 命中 `sensitive: true` 的字段值替换为 `"***"`，**键名保留**。
- 兜底黑名单同样打码：`key` / `token` / `secret` / `password` / `uuid` / `private_key` / `short_id` / `auth` / `api_key`。
- **脱敏后没有任何可展示字段时**（全部被打码），整个 `args_preview` 省略，不要发一个只有 `"***"` 的对象。
- 上限：8 个字段，单值 200 字符。
- 凭据、API Key、完整配置一律不出现。

例：`VpnConnect({ node_id: "seed-jp-01" })` → `{ "node_id": "seed-jp-01" }`；`DeepseekSaveKey({ key: "sk-…" })` → 省略。

`source` 规则（见 `tools.md` §2.4）：由 Host 的调用通道决定，UI 不能伪造。UI 点击 `next_actions` 产生的调用其 `source` 仍是 `"agent"`——因为它是经 Agent 转发的。

UI 处理：插入工具卡，状态 `running`，开始计时。

---

### 3.4 `tool-call-end`

```ts
type ToolCallEndPayload = {
  contract_version: "1.0.7";
  request_id: string;
  assistant_message_id: string;
  tool_call_id: string;
  tool: string;
  success: boolean;
  result: string;               // 人类可读摘要，来自 ToolResult.content
  result_truncated: boolean;
  error_code: string | null;    // 失败时为 AivpnErrorCode
  duration_ms: number;
  next_actions: NextAction[];   // 来自 metadata.aivpn.next_actions
  emitted_at: string;
};
```

来源：`QueryEvent::ToolEnd { tool_name, tool_id, result, is_error }`。

`error_code` 的取法：Host 从 `ToolResult.metadata["aivpn"]["error"]["code"]` 读取；没有 metadata 时为 `null`（说明是 Claurst 内置工具报错）。

UI 处理：

- 更新卡片状态 `ok` / `error`。
- 渲染 `next_actions` 为一到两个按钮，点击等价于用户发出对应工具调用意图（**不直接执行工具**，要做成一条用户消息或一次授权确认，取决于该工具的 `approval_policy`）。

---

### 3.5 `ai-status`

```ts
type AiStatusPhase =
  | "thinking"
  | "streaming_answer"
  | "preparing_tool"
  | "running_tool"
  | "waiting_permission"
  | "retrying"
  | "compacting"
  | "completed";

type AiStatusPayload = {
  contract_version: "1.0.7";
  request_id: string;
  assistant_message_id: string;
  phase: AiStatusPhase;
  text: string;                 // 面向用户的一行状态，例 "VpnConnect 仍在运行"
  emitted_at: string;
};
```

来源：

| QueryEvent | phase |
|---|---|
| `Status(s)` 含 permission | `waiting_permission` |
| `Status(s)` 含 prepar + tool | `preparing_tool` |
| `Status(s)` 含 tool / bash / command | `running_tool` |
| `Status(s)` 含 stream / respond / answer | `streaming_answer` |
| `Status(s)` 含 compact | `compacting` |
| `Status(s)` 含 complete / finished / done | `completed` |
| `Status(s)` 其他 | `thinking` |
| `Retry { attempt, max_attempts, delay_ms, reason }` | `retrying` |

`text` 示例：

```
上游临时波动（429），正在重试 1/3，2 秒后重试…
VpnConnect 仍在运行
```

UI 处理：更新顶部状态行；`waiting_permission` 时同时高亮权限卡。

**本地化（P1 决议）**：P1 由 Host 直接生成中文 `text`，前端原样展示，不做翻译。P2 若要多语言，改为 `text_key: string` + `params: Record<string, unknown>`，前端查表；届时 `text` 作为降级字段保留一版。

---

### 3.6 `ai-compact`

```ts
type AiCompactPayload = {
  contract_version: "1.0.7";
  request_id: string;
  assistant_message_id: string;
  phase: "compacting" | "completed";
  text: string;
  tokens_before: number | null;
  tokens_after: number | null;
  emitted_at: string;
};
```

来源：`QueryEvent::Compacted(record)` 与含 compact 的 `Status`。

UI 处理：在对话流中插入一条分隔提示「上下文已压缩」，不清空已有消息。

---

### 3.7 `ai-request-end`

```ts
type TokenUsage = {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
};

type AiRequestEndPayload = {
  contract_version: "1.0.7";
  request_id: string;
  assistant_message_id: string;
  result: "success" | "error" | "cancelled";
  final_text: string | null;     // success 时为完整 assistant 文本
  error: AivpnError | null;      // error 时非空
  usage: TokenUsage | null;
  duration_ms: number;
  emitted_at: string;
};
```

来源：

| QueryOutcome | result | 其他字段 |
|---|---|---|
| 正常结束 | `success` | `final_text` + `usage` |
| `QueryOutcome::Error` | `error` | `error.code = "UPSTREAM_ERROR"` 或具体码 |
| `QueryOutcome::BudgetExceeded` | `error` | `error.code = "PRECONDITION_FAILED"`，`details.reason = "budget_exceeded"` |
| 用户停止 | `cancelled` | `error.code = "CANCELLED"` |

UI 处理：

1. 落库。
2. 解除 loading。
3. 显示 token / 耗时。
4. `cancelled` 时**不显示错误提示**，只显示「已停止」。

> 与 TweetPilot 的差异：TweetPilot 的 `cancelled` / `error` 只带字符串 `error`；本契约改为结构化 `AivpnError`，便于 UI 分流（例如 `DEVICE_TOKEN_EXPIRED` 要跳注册引导）。

---

## 4. 应用事件

### 4.1 `runtime-state-changed`

```ts
type RuntimeStateChangedPayload = {
  contract_version: "1.0.7";
  from: RuntimeState;
  to: RuntimeState;
  event: "start_req" | "process_ready" | "health_ok" | "health_fail"
       | "crash" | "stop_req" | "restart_req" | "stopped" | "give_up";
  pid: number | null;
  upstream_version: string | null;
  reason: string | null;         // 人类可读，例 "clash_api_timeout"
  error: AivpnError | null;
  emitted_at: string;
};
```

触发：`runtime.md` §3.2 的每一条迁移，**每次都发**，不去重。

UI 处理：更新状态栏；`to = "failed"` 时显示诊断入口。

---

### 4.2 `runtime-health-changed`

```ts
type RuntimeHealthChangedPayload = {
  contract_version: "1.0.7";
  health: HealthSnapshot;
  emitted_at: string;
};
```

触发：健康快照变化，**去抖 ≥ 1s**。同一秒内多次变化只发最后一条。

UI 处理：更新延迟/出口 IP/健康灯；`degraded` 时在状态栏加黄色标记。

---

### 4.3 `job-progress`

```ts
type JobProgressPayload = {
  contract_version: "1.0.7";
  job_id: string;
  kind: "core_install" | "diag";
  state: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  stage: string;
  progress: number;              // 0.0–1.0
  message: string | null;
  error: AivpnError | null;
  emitted_at: string;
};
```

触发：任务状态或 `stage` 变化，最多 4 次/秒。进度不足 1% 的变化不发。

UI 处理：进度条；`state = "failed"` 时显示错误与重试按钮。

---

### 4.4 `approval-requested`

```ts
type ApprovalRequestedPayload = {
  contract_version: "1.0.7";
  approval_id: string;
  request_id: string;            // 所属 AI 请求；UI 直连发起的为 null
  session_id: string;            // 会话作用域的隔离键
  tool: string;
  args_preview?: Record<string, unknown>;   // 规则同 §3.3：默认展示，全脱敏时省略
  summary: string;               // 例 "下载并安装 sing-box 1.14.4（约 28 MB）"
  risk: "low" | "medium" | "high";
  scope: "call" | "session";     // session = 用户这次允许后，本会话内该工具不再询问
  expires_at: string;            // approval_id 的有效期（call 级，5 分钟）
  emitted_at: string;
};
```

触发：`ApprovalPolicy` 判定为 `Ask`。

UI 处理：

- 渲染确认卡。
- `scope = "session"` 时，确认按钮文案为「允许（本会话内不再询问）」，并在卡片上标明「仅对当前会话有效」。
- `scope = "call"` 时，按钮为「允许 / 拒绝」。
- 结果通过 `invoke("ai_approval_decision", { approval_id, decision, scope })` 回传；`decision` 取 `"allow" | "deny"`。

> 与 TweetPilot 的差异：TweetPilot 的权限交互走 Claurst `ManagedInteractivePermissionHandler` 的回调；Veyl 增加一层显式事件，好处是 UI 不需要理解 Claurst 内部协议，代价是 Host 要做双向映射。**取舍理由**：UI 层不应依赖第三方 crate 的内部结构。

---

## 5. UI → Host 调用（invoke）

事件是 Host → UI 的单向流。UI 主动操作走 Tauri `invoke`。以下命令名冻结：

| 命令 | 入参 | 返回 | 说明 |
|---|---|---|---|
| `ai_send_message` | `{ session_id, text, attachments? }` | `{ request_id }` | 发起一轮对话 |
| `ai_cancel` | `{ request_id }` | `{ cancelled: boolean }` | 停止生成 |
| `ai_approval_decision` | `{ approval_id, decision: "allow"\|"deny", scope: "call"\|"session" }` | `{ ok: boolean }` | 审批结果；`allow` + `scope: "session"` 时 Host 写入会话级 Grant |
| `runtime_status` | `{}` | `RuntimeSnapshot` | 状态快照（含应用事件不可达时的兜底） |
| `catalog_list_nodes` | `{ region?, protocol?, limit?, cursor? }` | `CatalogSearchData` | 无 AI 模式下的手动选节点 |
| `profile_import_node` | `{ node_id }` | `ProfileImportData` | 无 AI 模式 |
| `profile_delete` | `{ profile_id }` | `ProfileDeleteData` | 无 AI 模式；**仍需审批** |
| `vpn_connect` | `{ profile_id }` | `VpnConnectData` | 无 AI 模式 |
| `vpn_disconnect` | `{}` | `VpnDisconnectData` | 无 AI 模式 |
| `settings_get` | `{}` | `SettingsSnapshot` | 设置页 |
| `settings_set` | `{ key, value }` | `{ ok: boolean }` | 设置页 |
| `rename_session` | `{ session_id, title }` | `{ id, title, created_at }` | 重命名历史会话；`created_at` 为 ISO 8601 |

> 无 AI 模式（`phase-1-requirements.md` FR-2.7）必须能在不经过 Agent 的情况下走完「选节点 → 连接 → 断开」。上表后半段就是为此存在的，行为与对应工具一致，**共用同一份 Host 实现**，不允许两套逻辑。

**来源标记**：每个 invoke 命令在 Host 侧自动带 `source = "ui"`，工具调用入口自动带 `source = "agent"`。UI **不能**在参数里传 `source`（传了按 `INVALID_ARGUMENT` 拒绝）。破坏性操作（`vpn_connect`、`profile_delete`、安装运行时）无论来源都必须审批——用户自己点的也要确认，审批不能因为「是他自己点的」而跳过。

例外：`settings_set` / `settings_get` 不涉及破坏性操作，不做来源校验。

`profile_delete` 的 **前置校验先于审批**：目标是 active profile 时，Host 直接返回 `PRECONDITION_FAILED`，**不生成 `approval_id`、也不发 `approval-requested` 事件**。UI 因此不会看到一张点了也没用的确认卡。

`ai_send_message` 的 `request_id` 由 Host 生成（UUID v4），UI 之后所有事件都按它过滤。

### 5.1 `rename_session` 的校验语义

| 输入 | 结果 |
|---|---|
| 两侧空白去掉后为空 | `INVALID_ARGUMENT`，`details.reason = "empty_title"` |
| 去掉空白后长度 > 80（Unicode 标量数） | `INVALID_ARGUMENT`，`details.reason = "title_too_long"`，`details.max = 80`、`details.actual = N` |
| `session_id` 不存在 | `NOT_FOUND` |
| 存储写入失败 | `INTERNAL` |

规则：

- **先 trim 再校验、再存**。存进去的是 trim 后的值，UI 不需要自己再处理。
- 长度按 **Unicode 标量数**（Rust `chars().count()`），**不是字节数** —— 80 个汉字和 80 个英文字母同样合法。
- 80 是**存储上限**，不是显示宽度。侧边栏怎么截断是 UI 的事，与本命令无关。
- **不新增专用错误码**。`INVALID_ARGUMENT` + `details.reason` 是本项目既有的模式（`ProfileDelete` 的 `ACTIVE_PROFILE_IN_USE` 同理），比为一个两值校验再发明一个 `INVALID_TITLE` 更省。
- 不触发事件、不写 `tool_calls`。这是纯 UI 操作，没有 Agent 参与。

---

## 6. 前端状态机（建议实现）

```
idle
 └─ ai_send_message ──► streaming
       ├─ message-chunk / thinking-chunk ──► streaming
       ├─ tool-call-start ──► tool_running
       │     └─ tool-call-end ──► streaming
       ├─ ai-status(waiting_permission) ──► waiting_permission
       │     └─ 用户决策 ──► streaming
       └─ ai-request-end ──► idle | error
```

规则：

- `ai_cancel` 后 UI **立即**进入 `cancelling`，等 `ai-request-end` 再回 `idle`；不要乐观清空。
- `ai-request-end` 之前收到的任何事件都必须有对应卡片承载，否则丢弃并记一条 warning。
- 会话切换时按 `session_id` 缓存未结束的 `request_id`；切回来时重新订阅并补拉历史。

---

## 7. 与现有文档的差异

| # | 位置 | 现有文档写法 | 本契约写法 | 理由 |
|---|---|---|---|---|
| 1 | `phase-1-technical-design.md` §4.2 | `agent://delta`、`agent://tool` | `message-chunk`、`tool-call-start` | 同文件 §4.3 的映射表用的是 TweetPilot 名称，两处自相矛盾；以映射表为准 |
| 2 | `phase-1-technical-design.md` §4.3 | `ai-message-chunk`、`ai-thinking-chunk`、`ai-tool-call-start`、`ai-tool-call-end` | 去掉 `ai-` 前缀 | TweetPilot 实际 emit 的是无前缀名称（`claurst_session.rs:657/691/737/767`）；带前缀会导致前端复用失效 |
| 3 | 同上 | `ai-request-end` 只带 `result` 与字符串 `error` | 增加 `assistant_message_id`、结构化 `AivpnError`、`usage`、`duration_ms` | UI 需要按消息落库、需要区分错误类型 |
| 4 | 同上 | 无 `runtime-state-changed` 等应用事件 | 新增 4 个应用事件 | 只有 AI 事件的话，非 AI 路径（崩溃重启、无 AI 模式）UI 拿不到状态 |
| 5 | 同上 | 无 UI → Host 命令清单 | 新增 §5 | Alice 与 Bob 需要一份命令名，否则各写各的 |
| 6 | `architecture.md` §4.8 | 通知用 JSON-RPC `notifications/veyl.runtime_state` | 应用内用 Tauri event，JSON-RPC 仅留给 P2 的外部 MCP 宿主 | 进程内不需要 JSON-RPC 包装 |

---

## 8. 待 PM 拍板

### 8.1 已决议

| 议题 | 决议 | 落点 |
|---|---|---|
| 事件名是否带 `ai-` 前缀 | **统一不带前缀**：`message-chunk` / `thinking-chunk` / `tool-call-start` / `tool-call-end` / `ai-status` / `ai-compact` / `ai-request-end` | §1、§9 |
| 事件名常量的唯一来源 | `src/agent/protocol.ts` 的 `AGENT_EVENTS` 是**唯一常量源**，组件与 store 不得出现裸字符串 | §9 |
| `ai-status.text` 是否本地化 | **P1 由 Host 生成中文 `text`**；`text_key` + `params` 留到 P2 | §3.5 |
| 审批作用域 | `ApprovalRequestedPayload` 增加 `scope` / `session_id` / `tool`；`ai_approval_decision` 用 `scope` 取代 `remember` | §4.4、§5 |
| `next_actions` 点击语义 | 等价于用户发一条消息给 Agent（label + args），**UI 不得直接执行工具**，可预填输入框 | §3.4、`tools.md` §1.3 |
| `args_preview` 是否保留 | **保留**，默认展示非敏感字段；`sensitive` / 黑名单字段打码；脱敏后无可展示字段才省略整个字段 | §3.3、§4.4 |
| 无 AI 模式的来源校验 | Host 边界注入 `source: "ui" \| "agent"`，不可由参数传入；破坏性操作无论来源都要审批 | §5、`tools.md` §2.4 |

### 8.2 仍需 PM 决定

**无。** 事件层的开放问题已全部收敛。

---

## 9. 对现有占位实现的迁移清单

### 9.1 硬规则：`AGENT_EVENTS` 是唯一常量源

PM 已决议：`src/agent/protocol.ts` 的 `AGENT_EVENTS` 是事件名的**唯一来源**。

- 组件、store、bridge 一律通过 `AGENT_EVENTS.xxx` 或 `AgentEvent` 联合类型引用，**不得出现事件名字符串字面量**。
- 新增事件时只改 `AGENT_EVENTS` + `AgentEventMap` + `AgentEvent` 三处，其余代码不需要动。
- code review 检查项：`grep -rn '"message-chunk"\|"ai-status"\|"ai-request-end"' src/` 的命中只允许出现在 `protocol.ts`。

> 背景：现在的 `chatStore.ts` 用裸字符串做 `switch`，`AGENT_EVENTS` 改名不会触发 TypeScript 编译错误，`switch` 会静默不匹配 —— 表现是事件到了但界面不动，排查成本很高。

### 9.2 迁移清单

`src/agent/protocol.ts` 当前是占位实现（文件头已注明「等契约文档到位后整体替换」）。按本契约落地需要改：

| 文件 | 现状 | 改为 |
|---|---|---|
| `src/agent/protocol.ts` | `AGENT_EVENTS.messageChunk = "ai-message-chunk"` 等 4 个带 `ai-` 前缀 | `"message-chunk"` / `"thinking-chunk"` / `"tool-call-start"` / `"tool-call-end"` |
| `src/agent/protocol.ts` | `permissionRequest: "ai-permission-request"` | `approvalRequested: "approval-requested"`，payload 换成 `ApprovalRequestedPayload` |
| `src/agent/protocol.ts` | `ToolCallEndPayload.status: "success"\|"error"` + `summary` | `success: boolean` + `result` + `error_code` + `next_actions` |
| `src/agent/protocol.ts` | `RequestEndPayload.outcome`（5 值枚举） | `result: "success"\|"error"\|"cancelled"` + 结构化 `error: AivpnError` |
| `src/agent/protocol.ts` | `RuntimeStatus.version`、`last_error: string` | `upstream_version`、`last_error: AivpnError \| null`，并补 `contract_version` / `config_hash` / `traffic` / `connections` / `restart_count` / `last_transition_at` |
| `src/agent/protocol.ts` | `health` 为扁平三字段，`exit_ip` 在顶层 | `health` 为 `HealthSnapshot`（含 `exit_ip`、`consecutive_failures`、`checked_at`） |
| `src/agent/protocol.ts` | `ToolCallStartPayload` 只有 `action`，无来源与可选预览 | 增加 `source`；`args_preview` 改为可选（无 `sensitive` 声明时省略） |
| `src/agent/protocol.ts` | `PermissionRequestPayload` 用 `permission_id` / `remember_options` | 换成 `approval-requested` 的 `approval_id` / `scope` / `session_id` |
| `src/state/chatStore.ts` | `switch` 的 `case` 用**字符串字面量**（如 `case "ai-request-end":`），只有 `chatStore.ts:278` 用了裸串 | 全部改用 `AGENT_EVENTS.*` 常量；否则改名后 `switch` 会**静默不匹配**，不报编译错 |

> 最后一行是真实的踩坑点：`AGENT_EVENTS` 改名不会导致 TypeScript 报错，因为 `switch` 分支是裸字符串。改名时必须同步搜索全仓字面量。

新增事件（`runtime-state-changed`、`runtime-health-changed`、`job-progress`、`approval-requested`）需要 `AgentEventMap` 扩项与 `bridge.ts` 的 `subscribe` 分发；`subscribeRuntimeStatus` 可以直接由 `runtime-state-changed` + `runtime-health-changed` 合成，不必单独开一条通道。

---

## 10. 变更记录

### 1.0.7（2026-11-02，新增需求 N-01）

| # | 变更 | 类型 | 决议来源 |
|---|---|---|---|
| 1 | `contract_version` 升到 `1.0.7` | 元数据 | PM |
| 2 | §5 的 invoke 清单新增 `rename_session({ session_id, title })` | 新增命令 | 用户：允许修改历史对话标题 |
| 3 | 新增 §5.1 校验语义：trim → 非空 → ≤80 Unicode 标量；`INVALID_ARGUMENT` + `details.reason` | 新增 | PM 派单，架构师定接口 |

### 1.0.6（2026-11-02）

| # | 变更 | 类型 |
|---|---|---|
| 1 | `contract_version` 升到 `1.0.6` | 元数据 |
| 2 | 无接口变更；与 tools / catalog / runtime 保持版本一致 | 同步 |

### 1.0.5（2026-11-02，PM 定案）

| # | 变更 | 类型 | 决议来源 |
|---|---|---|---|
| 1 | `contract_version` 升到 `1.0.5` | 元数据 | PM |
| 2 | §5 补注：`profile_delete` 命中 active profile 时不发 `approval-requested`，前置校验先于审批 | 澄清 | PM 决议 1 |

### 1.0.4（2026-11-02，PM 定案）

| # | 变更 | 类型 | 决议来源 |
|---|---|---|---|
| 1 | `contract_version` 升到 `1.0.4` | 元数据 | PM |
| 2 | `args_preview` 规则同步改正：默认展示非敏感字段，打码后无字段可展示才省略 | 语义修正 | PM 修正 1 |

### 1.0.3（2026-11-02，PM 定案）

| # | 变更 | 类型 | 决议来源 |
|---|---|---|---|
| 1 | `contract_version` 升到 `1.0.3` | 元数据 | PM |
| 2 | 修正 1.0.1 变更记录第 1 条的笔误（「升到 1.0.2」→「升到 1.0.1」） | 笔误 | PM |
| 3 | `ToolCallStartPayload` 新增 `source`；`args_preview` 改为可选，无 `sensitive` 声明时省略 | 字段变更 | PM 决议 5、6 |
| 4 | `ApprovalRequestedPayload.args_preview` 同样改为可选 | 字段变更 | PM 决议 5 |
| 5 | `next_actions` 点击定为「用户发消息给 Agent」，UI 不得直接执行 | 语义定案 | PM 决议 4 |
| 6 | §5 新增 `profile_delete` 命令与来源标记规则 | 新增 | PM 决议 6、2 |

### 1.0.2（2026-11-02，用户拍板）

| # | 变更 | 类型 | 决议来源 |
|---|---|---|---|
| 1 | `contract_version` 升到 `1.0.2` | 元数据 | 用户 |
| 2 | `ApprovalRequestedPayload` 增加 `session_id` / `tool` / `scope`（`call` \| `session`） | 字段新增 | 用户决议 1 |
| 3 | `ai_approval_decision` 的 `remember?: boolean` 改为 `scope: "call" \| "session"` | 字段变更 | 用户决议 1 |
| 4 | §4.4 补充 `scope = "session"` 时的按钮文案与「仅对当前会话有效」提示要求 | 交互约束 | 用户决议 1 |

### 1.0.1（2026-11-02，PM 审核通过）

| # | 变更 | 类型 | 决议来源 |
|---|---|---|---|
| 1 | `contract_version` 全量升到 `1.0.1` | 元数据 | PM |
| 2 | 事件名不带 `ai-` 前缀，正式冻结 | 确认 | PM 决议 2 |
| 3 | 新增 §9.1：`AGENT_EVENTS` 是唯一常量源，禁止裸字符串 | 新增约束 | PM 决议 2 |
| 4 | `ai-status.text` 明确 P1 用中文由 Host 生成，P2 再做 `text_key` | 确认 | PM 决议 7 |
| 5 | 文件头补「已冻结」状态与变更记录指针 | 元数据 | PM |

### 1.0.0（2026-11-02，初版）

首次冻结：7 个 AI 事件、4 个应用事件、10 个 invoke 命令、前端状态机、迁移清单。
