# 契约：事件（Host → UI）

> 契约版本：`1.2.0`
> 状态：已冻结（P1.5 wave1，2026-11-02）
> 上游：`docs/phase-1-technical-design.md` §4.2、§4.3、`docs/phase-1-5-requirements.md` §4.1
> 反向通道：`docs/contracts/commands.md`（UI → Host 的 invoke，1.1.0 起独立成文）
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
| 11 | `app-lifecycle-changed` | Host → UI | `AppLifecycleChangedPayload` | 应用进程状态变化（1.1.0） |
| 12 | `default-profile-updated` | Host → UI | `DefaultProfileUpdatedPayload` | 默认配置包变化（1.1.0 定名，wave2 接线） |
| 13 | `ask-user-question` | Host → UI | `AskUserQuestionPayload` | 模型向用户提问，等待选择（1.2.0） |

1–7 与 13 是 AI 会话事件，8–12 是应用事件。UI 必须同时订阅两组，否则会出现「AI 说已连接，状态面板还是未连接」。

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

> **唯一例外**：`ask-user-question` 的 `created_at` / `expires_at` 用 Unix 毫秒（前端要做倒计时算术）。理由见 §4.8.5。

### 2.4 大小限制

- 单个事件 payload ≤ 64 KB。
- `tool-call-end.result` 超过 8 KB 时截断，追加 `…(truncated)`，并置 `result_truncated: true`。
- 完整结果在 `tool-calls` 表里，UI 可按 `tool_call_id` 拉取。

---

## 3. AI 会话事件

### 3.1 `message-chunk`

```ts
type MessageChunkPayload = {
  contract_version: "1.2.0";
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
  contract_version: "1.2.0";
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
  contract_version: "1.2.0";
  request_id: string;
  assistant_message_id: string;
  tool_call_id: string;
  tool: string;                 // 模型可见名，PascalCase，例 "VpnConnect"
  action: string;               // 人类可读的一行，例 "连接到 东京 01"
  permission_level: "none" | "read_only" | "write" | "execute";
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
  contract_version: "1.2.0";
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
- 渲染 `next_actions` 为一到两个按钮，点击等价于用户发出对应工具调用意图（**不直接执行工具**，要做成一条用户消息）。

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
  contract_version: "1.2.0";
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
  contract_version: "1.2.0";
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
  contract_version: "1.2.0";
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
  contract_version: "1.2.0";
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
  contract_version: "1.2.0";
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
  contract_version: "1.2.0";
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

### 4.4 已移除：`approval-requested`

> 2026-11-02 用户决定彻底移除审批机制，本事件随之删除。详见 `tools.md` §2.1。

---

### 4.5 `app-lifecycle-changed`（1.1.0 新增）

```ts
type AppLifecycleState = "foreground" | "background";

type AppLifecycleChangedPayload = {
  contract_version: "1.2.0";
  state: AppLifecycleState;
  previous: AppLifecycleState | null;   // 首次发出时为 null
  emitted_at: string;
};
```

触发：应用进程状态变化，**每次变化都发**，不去重。UI 用它决定是否收起/恢复自己的临时状态（例如正在打字的草稿、展开的面板）。

> **该事件不承载连接状态。** 连接状态仍由 `runtime-state-changed` + `runtime-health-changed` 表达——两者正交（需求 §4.1）。UI 不得用 `background` 推导「已断开」。

进程状态机与「事件 → 窗口 / 进程 / 连接」的完整对应表见 §4.7。

### 4.6 `default-profile-updated`（1.1.0 定名，wave2 接线）

```ts
type DefaultProfileUpdatedPayload = {
  contract_version: "1.2.0";
  package_id: string;
  version: string;                  // 本次应用的配置包版本
  applied_at: string;               // ISO 8601 UTC
  new_version_available: boolean;   // 应用后是否还有更新版本
  emitted_at: string;
};
```

触发：默认配置包被应用（首次拉取或刷新）之后。**不打断在线连接**（需求 §6.5）：事件只通知「有新版」，真正生效发生在下一次连接。

> wave2 实现。1.1.0 只冻结名字与载荷，不要求当前代码 emit。

### 4.7 应用生命周期（1.1.0 新增，规范性）

本节的表与需求文档 §4.1 一一对应，实现与验收都照这张表。

#### 4.7.1 进程状态

| 状态 | 含义 | 窗口 | 托盘 |
|---|---|---|---|
| `foreground` | 用户正在使用 | 显示 | 存在 |
| `background` | 用户关掉窗口，进程仍在跑 | 隐藏 | 存在 |
| `quitting` | 正在执行退出流程（需求 §4.6） | 任意 | 存在，直到进程结束 |

`quitting` **不是** `app-lifecycle-changed` 的取值：它是内部状态，UI 无从得知，也不该依赖。对外只发 `foreground` / `background`。

#### 4.7.2 事件 → 窗口 / 进程 / 连接

| 事件 | 窗口 | 进程 | 连接 | 是否提示 | 发出的事件 |
|---|---|---|---|---|---|
| 点窗口关闭按钮 / Cmd+W | 隐藏 | 存活 | 保持 | 否 | `app-lifecycle-changed{state:"background"}` |
| Cmd+Q / 菜单「退出 Veyl」 | 不变 | 等用户选择 | 保持 | **是，阻塞对话框** | 无（UI 状态不变） |
| 对话框选「后台运行」 | 隐藏 | 存活 | 保持 | — | `app-lifecycle-changed{state:"background"}` |
| 对话框选「退出」 | 关闭 | 结束 | 断开 | 仅断开失败时 | 无（进程即将结束） |
| 托盘「显示 Veyl」 | 显示并聚焦 | 存活 | 保持 | — | `app-lifecycle-changed{state:"foreground"}` |
| 托盘「退出」 | 关闭 | 结束 | 断开 | 仅断开失败时 | 无 |
| 再次启动（单实例唤起） | 显示并聚焦 | 存活 | 保持 | — | `app-lifecycle-changed{state:"foreground"}` |

#### 4.7.3 不变量

- **连接与进程正交**：进程进入 `background` 时连接必须保持；不得因为窗口隐藏而断开。
- **`quitting` 期间拒绝新的连接请求**：`runtime_start` 返回 `PRECONDITION_FAILED`，`details.reason = "quitting"`。
- **`foreground` / `background` 只在值变化时发**，重复设置不重复发。

### 4.8 `ask-user-question`（1.2.0 新增）

模型通过 `AskUserQuestion` 工具（`tools.md` §4.22）向用户提问时发出。**发出后该工具阻塞等待回答**，直到用户作答、超时或请求结束。

```ts
type AskUserQuestionPayload = {
  contract_version: "1.2.0";
  session_id: string;
  request_id: string;
  question_id: string;      // Host 生成，形如 q_<毫秒>_<8位十六进制>
  question: string;         // 问题正文
  options: string[];        // 单选选项；**数组非空，且每项都是非空字符串**
  created_at: number;       // Unix 毫秒，问题生成时刻
  expires_at: number;       // Unix 毫秒，= created_at + 300_000
  emitted_at: string;       // ISO 8601 UTC
};
```

#### 4.8.1 语义

- **单选**：`answer` 必须是 `options` 中的一个字符串，**逐字节相等**（不做 trim、不做大小写归一）。
- **跳过**：`answer` 为空字符串表示用户跳过，模型会收到"用户跳过了这个问题"。
- **没有多选**：Claurst 的通道不支持。需要多选时只能连续提问，或另立工具（本期不做）。
- **`options` 必须非空，且每一项都是非空字符串**：
  - `options` 缺失或为空数组 → **不发事件**，直接把这次工具调用以 `INVALID_ARGUMENT` 结束，模型据此改用带选项的方式重问。
  - `options` 里存在空字符串、或去掉首尾空白后为空的项 → **同样按无效提问处理**（同上，不发事件）。
  - 为什么必须挡住：空白项会渲染成一个空白按钮。用户点它，回传的 `answer` 是空串，**恰好等于「跳过」**——两种完全不同的意图撞在一起，用户只会看到自己的问题被莫名其妙地跳过。
  - `answer` 与选项的比对是逐字节的（见第一条），所以 Host **不做 trim**：要么选项本身就是干净的，要么这次提问不成立。在 Host 侧把空白项 trim 成有效选项，会让「用户选了什么」与「模型收到什么」不再逐字对应。

#### 4.8.2 与其它事件的顺序

```
tool-call-start  (tool = "AskUserQuestion")
      ↓
ask-user-question          ← 工具在此阻塞
      ↓  （用户作答 / 300s 超时 / 请求取消）
tool-call-end    (同一 request_id)
```

- `ask-user-question` **一定**在同一个 `request_id` 的 `tool-call-start` 之后、`tool-call-end` 之前。
- 同一个 `request_id` 下可能有多个问题（模型连续提问），它们**串行**出现：上一个 `tool-call-end` 之后才会开始下一个。
- **不带 `tool_call_id`**：事件与工具卡之间不建立显式关联。UI 按 `question_id` 独立渲染浮层，不要假设能嵌进工具卡。若将来要把问题嵌进卡片，再加该字段。

#### 4.8.3 超时

- Host 负责计时：`created_at + 300s`。
- 超时后 Host 以**空字符串**回复工具（等同用户跳过），`tool-call-end` 正常到达，对话继续。
- **不发额外事件**。理由：超时在界面上与"用户跳过"是同一状态——按钮都要消失；为此单开一个事件，UI 还得为它写和"跳过"完全一样的处理，属于重复。
- UI 用 `expires_at` **置灰或移除**按钮，不要自己按 `created_at + 300` 算——那等于把超时值在前后端各写一份，Host 改了 UI 不会跟着改（§4.8.5）。

#### 4.8.4 作废（必须有，否则 oneshot 永远挂着）

请求结束、请求取消、会话删除时，该范围内**未回答**的问题必须作废：

| 触发 | 范围 |
|---|---|
| `ai-request-end`（正常结束 / 取消） | 该 `request_id` 的全部未答问题 |
| `chat_delete` / 会话被删 | 该 `session_id` 的全部未答问题 |
| 应用退出 | 全部 |

**作废的动作是「回空字符串再移除」，不是直接丢弃 sender。** 直接丢弃会让工具侧收到 channel-closed，被当成"工具执行失败"，模型可能因此重试一个已经不存在的问题；回空串则是正常的"用户跳过"。

#### 4.8.5 时间字段为什么是毫秒而不是 ISO

本契约 §0 约定时间字段用 ISO 8601。这里的 `created_at` / `expires_at` 是**唯一例外**，因为它们唯一的用途是前端做倒计时算术（`expires_at - Date.now()`）。转成 ISO 只会让每个消费者各写一次 `Date.parse`，且更容易写错。

除这两个字段外，事件里的时间一律 ISO 8601。

#### 4.8.6 UI 处理

1. 收到事件 → 按 `question_id` 建浮层，渲染 `question` 与 `options` 按钮。
2. 用户点击 → `reply_user_question({ sessionId, questionId, answer })`。
3. 收到同一 `request_id` 的 `tool-call-end` 或 `ai-request-end` → **立即移除**该请求下所有未答浮层（此时 Host 已作废它们，再点只会得到 `question_not_pending`）。
4. 窗口重载 / 切换会话后回来 → 调 `list_pending_questions({ sessionId })` 重建浮层。

---

## 5. UI → Host 调用（invoke）

> **1.1.0 起全部迁到 `docs/contracts/commands.md`。** 本节只保留迁移说明，不再维护命令表。
>
> 原因：命令属于「UI → Host」方向，与本文档「Host → UI 的事件」是两个方向，混在一份文件里导致参数命名约定（camelCase）长期写错。
>
> 迁移时一并纠正的三处：
> 1. invoke 参数名是 **camelCase**（`profileId` / `sessionId`），不是 snake_case。
> 2. `catalog_list_nodes` / `profile_import_node` / `vpn_connect` / `vpn_disconnect` 从未在 `invoke_handler` 注册（「文档有、代码没有」）。
> 3. `chat_history` / `deepseek_key_status` / `deepseek_save_key` / `deepseek_clear_key` 已实现但从未入契约（「代码有、文档没有」）。
>
> `import_seed_file` 的完整语义（两条 UI 入口、错误分类、脱敏要求）见 `commands.md` §3.8。

---

## 6. 前端状态机（建议实现）

```
idle
 └─ ai_send_message ──► streaming
       ├─ message-chunk / thinking-chunk ──► streaming
       ├─ tool-call-start ──► tool_running
       │     └─ tool-call-end ──► streaming
       └─ ai-request-end ──► idle | error
```

> 1.0.8 起审批机制整体移除，原图里的 `ai-status(waiting_permission)` 分支已删除。`AiStatusPhase` 仍保留该取值以兼容历史事件，但**不应当再出现**；UI 收到时按 `thinking` 处理并记一条 warning。

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
| 审批事件 | ~~审批作用域~~ → **审批机制整体移除，`approval-requested` 与 `ai_approval_decision` 均删除**（2026-11-02） | §4.4、§5 |
| `next_actions` 点击语义 | 等价于用户发一条消息给 Agent（label + args），**UI 不得直接执行工具**，可预填输入框 | §3.4、`tools.md` §1.3 |
| `args_preview` 是否保留 | **保留**，默认展示非敏感字段；`sensitive` / 黑名单字段打码；脱敏后无可展示字段才省略整个字段 | §3.3、§4.4 |
| 无 AI 模式的来源校验 | Host 边界注入 `source: "ui" \| "agent"`，不可由参数传入；**没有审批机制，破坏性操作无论来源都直接执行**（1.0.8 起） | §5、`tools.md` §2.4 |

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
| `src/agent/protocol.ts` | 有 `permissionRequest: "ai-permission-request"` | **整条删除** —— 审批机制已移除，UI 不再有确认卡 |
| `src/agent/protocol.ts` | `ToolCallEndPayload.status: "success"\|"error"` + `summary` | `success: boolean` + `result` + `error_code` + `next_actions` |
| `src/agent/protocol.ts` | `RequestEndPayload.outcome`（5 值枚举） | `result: "success"\|"error"\|"cancelled"` + 结构化 `error: AivpnError` |
| `src/agent/protocol.ts` | `RuntimeStatus.version`、`last_error: string` | `upstream_version`、`last_error: AivpnError \| null`，并补 `contract_version` / `config_hash` / `traffic` / `connections` / `restart_count` / `last_transition_at` |
| `src/agent/protocol.ts` | `health` 为扁平三字段，`exit_ip` 在顶层 | `health` 为 `HealthSnapshot`（含 `exit_ip`、`consecutive_failures`、`checked_at`） |
| `src/agent/protocol.ts` | `ToolCallStartPayload` 只有 `action`，无来源与可选预览 | 增加 `source`；`args_preview` 改为可选（无 `sensitive` 声明时省略） |
| `src/agent/protocol.ts` | `PermissionRequestPayload` 类型 | **整条删除** |
| `src/state/chatStore.ts` | `switch` 的 `case` 用**字符串字面量**（如 `case "ai-request-end":`），只有 `chatStore.ts:278` 用了裸串 | 全部改用 `AGENT_EVENTS.*` 常量；否则改名后 `switch` 会**静默不匹配**，不报编译错 |

> 最后一行是真实的踩坑点：`AGENT_EVENTS` 改名不会导致 TypeScript 报错，因为 `switch` 分支是裸字符串。改名时必须同步搜索全仓字面量。

新增事件（`runtime-state-changed`、`runtime-health-changed`、`job-progress`）需要 `AgentEventMap` 扩项与 `bridge.ts` 的 `subscribe` 分发；`subscribeRuntimeStatus` 可以直接由 `runtime-state-changed` + `runtime-health-changed` 合成，不必单独开一条通道。

---

## 10. 变更记录

### 1.2.0（2026-11-03，P1.5 · AI 主动提问）

| # | 变更 | 类型 | 决议来源 |
|---|---|---|---|
| 1 | `contract_version` 升到 `1.2.0` | 元数据 | PM |
| 2 | 新增事件 `ask-user-question`（事件总数 12 → 13） | 新增事件 | 产品负责人：首启两问需要选项按钮 |
| 3 | 载荷补 `contract_version` / `emitted_at` / `expires_at`，与 §2.3 的既有约定对齐 | 字段补齐 | 初稿缺前两个，`expires_at` 用于避免前端重复写死 300 秒 |
| 4 | 明确「`options` 必须非空；空则不发事件、直接以 `INVALID_ARGUMENT` 结束工具调用」 | 语义定案 | 空选项会让任何非空回答都被拒，问题实际无法回答 |
| 5 | 明确作废动作为「回空字符串再移除」，不是丢弃 sender | 语义定案 | 丢弃会被工具侧当成执行失败，模型可能重试已不存在的问题 |
| 6 | 明确超时不发额外事件 | 语义定案 | 与「用户跳过」在界面上是同一状态 |
| 7 | `created_at` / `expires_at` 用 Unix 毫秒，作为 ISO 约定的**唯一例外**并在 §2.3 标注 | 例外 | 倒计时算术需要数值 |

### 1.1.0（2026-11-02，P1.5 wave1）

| # | 变更 | 类型 | 决议来源 |
|---|---|---|---|
| 1 | `contract_version` 升到 `1.1.0` | 元数据 | PM |
| 2 | 新增事件 `app-lifecycle-changed`（事件总数 10 → 12） | 新增事件 | 需求 §4.1 |
| 3 | 新增事件 `default-profile-updated`（wave2 实现，先冻结名字与载荷） | 预留 | 需求 §6、§10 |
| 4 | 新增 §4.7 应用生命周期（进程状态、事件→窗口/进程/连接对应表、不变量） | 新增 | 需求 §4.1 |
| 5 | **§5 的 invoke 全部迁到 `commands.md`**，本节只留迁移说明 | 结构调整 | 命令与事件分开维护 |
| 6 | 纠正「1–7 AI 事件 / 8–11 应用事件」的计数笔误（应为 8–12） | 修正 | 事件数已变化 |
| 7 | 新事件载荷均带 `contract_version` 与 `emitted_at`，与 §2.3 一致 | 约束 | 全契约统一 |
| 8 | 清理 1.0.8 遗留的审批残影：§6 前端状态机删除 `waiting_permission` 分支；§8.1「破坏性操作都要审批」改为「无审批机制」 | 修正 | 文档与已移除的机制自相矛盾 |

> **对实现的立即影响**：`src/agent/protocol.ts` 的 `AGENT_EVENTS` 尚未包含这两个事件，因此 `node tests/contracts/check-contracts.mjs` 的第 1 项会报「契约有、代码没有」。这是契约先行时的**预期红色**，由 Alice 补 `AGENT_EVENTS` + `chatStore` 的 `switch` 分支后转绿。不要为了让检查变绿而回退契约。

### 1.0.10（2026-11-02，N-03 导入通道最终定为拖拽）

> 本版本在定稿前改过三次（环境变量 → 开发版 CLI → 设置页 UI → 固定路径自动导入），均未发布。最终定为**拖拽导入**：用户把 JSON 拖进窗口，零额外界面。

| # | 变更 | 类型 | 决议来源 |
|---|---|---|---|
| 1 | `contract_version` 升到 `1.0.10` | 元数据 | PM |
| 2 | §5 新增 `import_seed_file({ path })` | 新增命令 | 用户：内测用户需自行加载节点文件 |
| 3 | 新增 §5.2 语义：四类校验、部分成功不算失败、返回值与日志不含 password | 新增 | 同上 |
| 4 | 自动化仍走 `veyl-runtime-selftest import-seeds`，不经过该命令 | 说明 | CI 与测试需要 |
| 5 | 移除 `settings_get` / `settings_set` —— 契约里列着但 Host 从未实现，且当前无调用方 | 移除 | 无实现、无调用方，留着会误导 |
| 6 | `ImportSeedResult.profiles[]` 增加 `server_port` —— UI 要显示 `server:port`，只有 `server` 时只能显示半截 | 字段新增 | 实现时发现，纯新增不破坏现有类型 |
| 7 | §5.2 明确两条 UI 入口（窗口拖放 + 设置页「选择文件」）**共用一个命令**；取消返回 `null` 时不调用本命令 | 语义澄清 | 用户追加要求从目录选文件 |

### 1.0.9（2026-11-02）

| # | 变更 | 类型 |
|---|---|---|
| 1 | `contract_version` 升到 `1.0.9` | 元数据 |
| 2 | 无接口变更；与 catalog / tools / runtime 保持版本一致 | 同步 |

### 1.0.8（2026-11-02，用户决定移除审批）

| # | 变更 | 类型 | 决议来源 |
|---|---|---|---|
| 1 | `contract_version` 升到 `1.0.8` | 元数据 | PM |
| 2 | **移除 `approval-requested` 事件**（事件总数 11 → 10） | 移除 | 用户：彻底移除审批 |
| 3 | **移除 `ai_approval_decision` invoke 命令**（命令总数 11 → 10） | 移除 | 同上 |
| 4 | `tool-call-start` / `tool-call-end` 的载荷不变 | 确认 | 同上 |

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
