# 契约：事件（Host → UI）

> 契约版本：`2.5.0`
> 状态：已定稿（批 0 + 批 3，2026-11-03）
> 上游：`docs/center-panel.md` §2.5.1、`docs/configs-and-nav.md` §9、`docs/issue-management.md` §4、`docs/config-execution.md` §10
> 反向通道：`docs/contracts/commands.md`（UI → Host 的 invoke，版本以该文件头为准）
> 实现方：Rust（Host 发送）、TypeScript（UI 订阅）
> 参考实现：`TweetPilot/src-tauri/src/claurst_session.rs`
> 变更记录：见 §10

---

## 0. 本契约的地位

本文档定义 **Tauri event 名称与 payload**。UI 只依赖这些事件渲染，不轮询内部状态。

统一约定：

- 事件名 **kebab-case**，与 TweetPilot 保持一致，便于复用前端经验。
- payload 字段 **snake_case**。
- 事件信封的 `emitted_at`：**ISO 8601 UTC + `Z`**。
- **落库实体字段的时间戳**（`created_at` / `first_seen` / `last_seen` / `checked_at` 等）：**Unix 毫秒整数**，与 `data-model.md` 的列类型一致。见 §2.3。
- 错误码 **大写下划线**。
- 所有 payload 带 `contract_version`。
- **本文件里所有 `contract_version` 的字面量恒等于本文件版本**（当前 `2.5.0`），升版时全文替换。实现侧只允许有一个常量对应本文件（`EVENT_CONTRACT_VERSION`），不得按事件分别发不同版本号。字段是哪一版加的，记在 §10 变更记录里，不写进字面量。

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
| 8 | `ask-user-question` | Host → UI | `AskUserQuestionPayload` | 模型向用户提问，等待选择 |
| 9 | `runtime-state-changed` | Host → UI | `RuntimeStateChangedPayload` | 运行时状态迁移 |
| 10 | `runtime-health-changed` | Host → UI | `RuntimeHealthChangedPayload` | 健康快照变化 |
| 11 | `job-progress` | Host → UI | `JobProgressPayload` | 长任务进度 |
| 12 | `app-lifecycle-changed` | Host → UI | `AppLifecycleChangedPayload` | 应用进程状态变化 |
| 13 | `default-profile-updated` | Host → UI | `DefaultProfileUpdatedPayload` | 种子节点层变化 |
| 14 | `config-changed` | Host → UI | `ConfigChangedPayload` | **2.0 新增**：配置增删改激活 |
| 15 | `node-list-changed` | Host → UI | `NodeListChangedPayload` | **2.0 新增**：节点池或配置节点集变化 |
| 16 | `node-switched` | Host → UI | `NodeSwitchedPayload` | **2.0 新增**：当前节点变化 |
| 17 | `issue-changed` | Host → UI | `IssueChangedPayload` | **2.0 新增**：问题新增或状态变化 |
| 18 | `layout-updated` | Host → UI | `LayoutUpdatedPayload` | **2.0 新增**：中间区域编排布局落库 |
| 19 | `routing-changed` | Host → UI | `RoutingChangedPayload` | **2.1 新增**：分流模式 / 目标 / 自定义规则变化 |
| 20 | `rules-changed` | Host → UI | `RulesChangedPayload` | **2.1 新增**：规则数据版本切换 |
| 21 | `core-upgrade-progress` | Host → UI | `CoreUpgradeProgressPayload` | **2.5 新增**：核心升级进度 |
| 22 | `core-upgrade-finished` | Host → UI | `CoreUpgradeFinishedPayload` | **2.5 新增**：核心升级结束 |

1–8 是 AI 会话事件，9–22 是应用事件。UI 必须同时订阅两组，否则会出现「AI 说已连接，状态面板还是未连接」。

> **事件与命令成对**：每个改变持久状态的命令都必须有一条对应事件。没有事件的变更只允许发生在「只读命令」上。例外是 `probe_run`——它不改状态，但探测失败的副作用（登记问题）由 `issue-changed` 表达。

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

> **两类例外**：
>
> 1. `ask-user-question` 的 `created_at` / `expires_at` 用 Unix 毫秒（前端要做倒计时算术）。理由见 §4.8.5。
> 2. **2.0 起，所有直接来自数据库实体的时间戳都用 Unix 毫秒**：`config.created_at` / `updated_at` / `last_used_at`、`issue.first_seen` / `last_seen`、`probe.checked_at` 等。这些字段的值就是 SQLite 列里的整数，转换成 ISO 只会在 Host 里多做一次反序列化、在 UI 里多做一次 `Date.parse`，而且会让「毫秒整数」与「ISO 字符串」两种格式在同一条 payload 里并存。
>
> 判据：**这个时间是要落库的实体字段，还是信封/实时观测值？** 实体字段用毫秒，`emitted_at` 与运行时快照时间（`connected_since` / `last_transition_at` / `health.checked_at`）用 ISO。`data-model.md` §1 有完整说明。

### 2.4 大小限制

- 单个事件 payload ≤ 64 KB。
- `tool-call-end.result` 超过 8 KB 时截断，追加 `…(truncated)`，并置 `result_truncated: true`。
- 完整结果在 `tool-calls` 表里，UI 可按 `tool_call_id` 拉取。

---

## 3. AI 会话事件

### 3.1 `message-chunk`

```ts
type MessageChunkPayload = {
  contract_version: "2.5.0";
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
  contract_version: "2.5.0";
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
  contract_version: "2.5.0";
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
  contract_version: "2.5.0";
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
  contract_version: "2.5.0";
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
  contract_version: "2.5.0";
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
  contract_version: "2.5.0";
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
  contract_version: "2.5.0";
  from: RuntimeState;
  to: RuntimeState;
  event: "start_req" | "process_ready" | "health_ok" | "health_fail"
       | "crash" | "stop_req" | "restart_req" | "stopped" | "give_up";
  pid: number | null;
  upstream_version: string | null;
  reason: string | null;         // 人类可读，例 "clash_api_timeout"
  error: AivpnError | null;
  snapshot: RuntimeSnapshot;     // 2.0 新增：迁移后的完整快照
  emitted_at: string;
};
```

触发：`runtime.md` §3.2 的每一条迁移，**每次都发**，不去重。

**为什么带 `snapshot`**：UI 需要的不只是「变成 running 了」，还需要「实际监听在哪个端口、连的是哪套配置、哪个节点」。不带快照的话，每个消费者都要在收到事件后再 `runtime_status()` 一次，而这两次调用之间状态可能又变了——代理卡片会短暂显示上一个端口。把快照挂在迁移事件上，顺序天然一致。

不变量：

- `snapshot.state === to`。不一致说明有人绕过了单写者，属于实现缺陷。
- `snapshot.mixed_port` 是 `to = "running" | "degraded"` 时 `proxy_card` 的唯一端口来源（`proxy_params` 的 `runtime` 来源）。
- `snapshot.contract_version` 跟 **`runtime.md`**（当前 `2.3.0`），与顶层的 `contract_version`（本文件 `2.5.0`）**可以不同**：一个声明快照形状的版本，一个声明事件形状的版本，两处都对。消费方不要拿其中一个去校验另一个。
- payload ≤ 64 KB；`RuntimeSnapshot` 本身远小于上限，不需要截断。

UI 处理：更新状态栏与顶部主按钮；`to = "failed"` 时显示诊断入口；用 `snapshot.mixed_port` 重渲染代理卡。

---

### 4.2 `runtime-health-changed`

```ts
type RuntimeHealthChangedPayload = {
  contract_version: "2.5.0";
  health: HealthSnapshot;
  // 2.2 新增：本次运行累计流量与速率。
  // 未连接（idle/failed）或还没采到时为 null——**不是 0**，
  // UI 要能区分「这次真的 0 字节」和「没有数据」。
  traffic: TrafficStats | null;   // 形状见 runtime.md §2.4
  // 2.3 新增：活跃连接数，与 traffic 同一次 /connections 采样。
  // 未连接、没采到、或响应里没有该数组时为 null（未知 ≠ 0 条）。
  connections: number | null;
  // 2.3 新增：出口 IP 探测往返耗时（毫秒）。
  // 未连接或尚未测到出口 IP 时为 null。放进事件后，前端刷新延迟不用再拉快照。
  latency_ms: number | null;
  // 2.4 新增：到节点的真实延迟——Clash API delay 测试（`/proxies/node-<id>/delay`）的毫秒数。
  // 未连接、还没测到、或当前没有选中节点时为 null。
  // **与 latency_ms 是两个指标，不得互相填充**：latency_ms 含 DNS + TLS，数值常在 2000 ms 量级；
  // 这个才是用户说的「节点延迟」。断开、失败、节点热切换后立即复位为 null。
  node_latency_ms: number | null;
  emitted_at: string;
};
```

触发：健康检查每 2s 一次，每次检查后发一条（`health_interval`）；健康快照变化时也会发，仍有 ≥ 1s 去抖。

刷新频率：**2 秒一条**。数据来自 `GET /connections` 的 `uploadTotal` / `downloadTotal` 累计值，
速率由相邻两次采样的差值除以间隔得到，所以 `up_rate` / `down_rate` 是约 2 秒的平均值，
**不是每秒精确值**。采样失败或缺字段时保留上一次的值，不会把流量清成 0；
进程退出、主动断开后立即变回 `null`。

UI 处理：更新延迟/出口 IP/健康灯/流量/连接数；面板上给用户看的「延迟」取 `node_latency_ms`，`latency_ms` 只用于诊断视图；`degraded` 时在状态栏加黄色标记。

---

### 4.3 `job-progress`

```ts
type JobProgressPayload = {
  contract_version: "2.5.0";
  job_id: string;
  kind: "core_install" | "core_upgrade" | "diag" | "rules_update";
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
  contract_version: "2.5.0";
  state: AppLifecycleState;
  previous: AppLifecycleState | null;   // 首次发出时为 null
  emitted_at: string;
};
```

触发：应用进程状态变化，**每次变化都发**，不去重。UI 用它决定是否收起/恢复自己的临时状态（例如正在打字的草稿、展开的面板）。

> **该事件不承载连接状态。** 连接状态仍由 `runtime-state-changed` + `runtime-health-changed` 表达——两者正交（需求 §4.1）。UI 不得用 `background` 推导「已断开」。

进程状态机与「事件 → 窗口 / 进程 / 连接」的完整对应表见 §4.7。

### 4.6 `default-profile-updated`

```ts
type DefaultProfileUpdatedPayload = {
  contract_version: "2.5.0";
  seed_id: "veyl_seed";
  content_sha256: string;           // 2.0：变化判定依据
  version: string | null;           // 文件里的 version，仅展示
  node_count: number;               // 2.0 新增：应用后的种子节点总数
  new_version_available: boolean;   // 应用后是否还有更新版本
  applied_at: number;               // Unix 毫秒
  emitted_at: string;
};
```

触发：`veyl_seed.json` 被应用（首次拉取、刷新、或 `import_seed_file` 合并）之后。**不打断在线连接**：事件只通知「节点层变了」，真正生效发生在下一次连接。

> 名称保留 `default-profile-*`：它对应能力 C 组的「官方默认配置」，与命令 `default_profile_*` 同名。2.0 只改载荷字段，不改事件名——事件名与命令名必须能互相找到。
>
> 节点增删同时会伴随一条 `node-list-changed`（`reason = "seed_refreshed"`）。两者不重复：本事件表达「种子版本层变了」，`node-list-changed` 表达「节点池的内容变了」，后者在 URL 导入、手动添加时也会发。

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
  contract_version: "2.5.0";
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

### 4.9 `config-changed`（2.0 新增）

配置的增、删、改、激活。**左栏列表、中间底部节点详情、顶部按钮可用性都靠它刷新。**

```ts
type ConfigChangedPayload = {
  contract_version: "2.5.0";
  change: "created" | "updated" | "deleted" | "activated";
  config_id: string;
  config: ConfigSummary | null;      // deleted 时为 null；类型见 commands.md §3.0
  active_config_id: string | null;   // 变更后的 active（可能为 null）
  emitted_at: string;
};
```

| `change` | 触发时机 | 额外说明 |
|---|---|---|
| `created` | `config_create` 事务提交后 | 若自动激活，紧跟一条 `activated` |
| `updated` | `config_update` 提交后；`node_import_url` / `node_create` 追加节点到配置后 | 同一秒内多次更新合并为一条（以最后一次为准） |
| `deleted` | `config_delete` 提交后 | `config = null`；`active_config_id` 可能变成 `null` |
| `activated` | `config_activate` 提交后（含自动激活） | 切换前若已连接，**先收到 `runtime-state-changed`（stopped）再收到本事件** |

规则：

- **事务提交后才发**。事件早于提交，UI 会拿着还没落库的状态去渲染，下一次读又弹回去。
- `config` 里**不含节点明细**。收到事件后 UI 若正在展示该配置，调 `config_detail` 取新节点集；否则只更新左栏那一行。
- 切换配置时 `active_config_id` 是最终值，不是「上一个」。
- 本事件**不承载连接状态**。连接状态只由 `runtime-state-changed` 表达（§4.7.3 的同一条原则）。

### 4.10 `node-list-changed`（2.0 新增）

节点池的内容，或某套配置的节点集发生变化。

```ts
type NodeListChangedReason =
  | "seed_refreshed"          // 种子重新拉取并应用
  | "url_import"              // node_import_url 新增节点
  | "manual_create"           // node_create 新增节点
  | "node_deleted"            // 种子刷新删掉了不再存在的节点
  | "bindings_changed";       // config_update 整体替换了节点集

type NodeListChangedPayload = {
  contract_version: "2.5.0";
  reason: NodeListChangedReason;
  config_id: string | null;        // 只有 bindings_changed 时非空
  node_count_total: number;        // 节点池总数
  changed_node_ids: string[];      // 本次新增或删除的节点；> 200 时给空数组
  emitted_at: string;
};
```

规则：

- **`changed_node_ids` 超过 200 条时返回空数组**，UI 收到空数组一律整表重拉。给一个被截断的列表比给空更糟——UI 会以为自己已经同步了。
- 节点池的变化不等于当前配置的变化：种子刷新添加了节点，不会自动把它们绑进任何配置。绑不绑由配置的 `source = "seed"` 决定（见 `commands.md` §3.2）。
- 当前节点的变化**不走本事件**，走 `node-switched`。
- 种子刷新删除节点时，若被删的是某套配置的 `current_node_id`，数据库外键把它置 `null`，随后该配置的 `config-changed(updated)` 也会发出——UI 应从 `config_detail` 重新取，而不是用旧 id。

### 4.11 `node-switched`（2.0 新增）

一套配置的当前节点变了。

```ts
type NodeSwitchedPayload = {
  contract_version: "2.5.0";
  config_id: string;
  from_node_id: string | null;
  to_node_id: string;
  connected: boolean;              // 是否同时做了在线热切换
  runtime: RuntimeSnapshot | null; // connected = false 时为 null；类型见 commands.md §7.3
  emitted_at: string;
};
```

触发：

| 场景 | `connected` | 说明 |
|---|---|---|
| `node_switch` 时未连接 | `false` | 只改了选择，网络没动 |
| `node_switch` 时已连接 | `true` | 通过 selector 热切换，进程不重启；`runtime` 里是切换后的快照 |
| `runtime_start` 带了 `nodeId` | `true` | 与连接同时发生 |

- **热切换不产生 `runtime-state-changed`**：进程没停、状态没迁移，只是出口换了。UI 不能靠运行时状态去推断节点变了。
- 切换失败不发本事件（`node_switch` 返回错误，`current_node_id` 保持不变）。
- 「选中」与「切换」是两件事（`docs/center-panel.md` §2.1）：底部下拉里点一下只是本地 UI 状态，**不产生任何事件**；按下「切换到此节点」才调用命令并收到本事件。

### 4.12 `issue-changed`（2.0 新增）

问题记录新增或状态变化。**中间区域的问题卡由它驱动，且不依赖 AI。**

```ts
type IssueChangedPayload = {
  contract_version: "2.5.0";
  change: "created" | "updated" | "handed_off" | "resolved" | "ignored" | "reopened";
  issue: IssueSummary;                  // 变更后的状态
  blocking_issue_id: string | null;     // 当前应插卡的那一条；null = 中间不插卡
  open_counts: { P0: number; P1: number; P2: number };
  emitted_at: string;
};
```

| `change` | 触发时机 |
|---|---|
| `created` | 新问题登记（`probe_run` 失败、运行时异常退出、启动自检） |
| `updated` | 同类问题再次出现：`count + 1`、`last_seen` 刷新、`severity` 可能升级 |
| `handed_off` | `issue_handoff` 成功投喂 AI |
| `resolved` | `issue_resolve` 复测通过 |
| `ignored` | `issue_ignore(ignored = true)` |
| `reopened` | 已 `resolved` / `ignored` 的同类问题再次出现，或 `issue_ignore(ignored = false)` |

**`blocking_issue_id` 的计算规则（Host 唯一实现，UI 不重算）**：

```
存在 P0 → 取 first_seen 最早的 P0
否则存在 P1 → 取 first_seen 最早的 P1
否则 → null
```

- 中间区域**同一时刻最多一张问题卡**（`docs/issue-management.md` §4），这张卡就是 `blocking_issue_id` 指向的那条。
- 多个 P0 同时存在时，其余收进「还有 N 个问题」——UI 用 `open_counts` 减去卡上那一条得到 N。
- `ignored` 与 `resolved` **都从候选里排除**；P2 永远不进候选。
- 本事件在**采集时**发出，不要求 AI 可用。AI 只是卡片上「让 AI 定位」按钮的处理者。
- 本地规则插卡不写 `layouts` 表：`issue_card` 是**叠加渲染**，不是布局的一部分。这样 AI 编排的布局与故障卡互不覆盖。

### 4.13 `layout-updated`（2.0 新增）

当前配置的中间区域编排布局落库。

```ts
type LayoutUpdatedPayload = {
  contract_version: "2.5.0";
  config_id: string;
  revision: number;            // 每配置单调递增，从 1 开始
  layout: Layout;              // 见 commands.md §3.0
  emitted_at: string;
};
```

触发：AI 产出的布局通过校验并写入 `layouts` 表之后（批 4 接线）。

规则：

- **`revision` 单调递增**。UI 收到 `revision <= 已渲染的 revision` 时丢弃——网络/线程调度可能导致旧布局后到，覆盖新布局会让中间区域闪回上一个版本。
- **块类型必须在封闭词汇表内**（`docs/center-panel.md` §2.5 的六个块 + 未来登记过的块）。不在表里的块由 Host **过滤掉并记日志**，不写库、不发事件里的那一项；整份布局全是非法块时**不覆盖旧布局**。
- AI 不能改样式：`props` 只承载内容与参数，样式永远由设计规范决定。
- **本地规则不写布局**（见 §4.12）。因此本事件只有 AI 编排一个来源，没有 `source` 字段。
- 切换配置时**不重发本事件**：`config-changed(activated)` 之后 UI 调 `config_detail`，布局随详情一起返回。

### 4.14 `routing-changed`（2.1 新增）

分流模式、目标分类或自定义规则发生变化。

```ts
type RoutingChangedPayload = {
  contract_version: "2.5.0";
  config_id: string;
  routing_mode: "direct" | "proxy_all" | "proxy_selected";
  applied_mode: "direct" | "proxy_all" | "proxy_selected" | null;
  targets: string[];
  route_revision: number;
  applied_revision: number | null;    // 取自 RuntimeSnapshot.applied_route_revision
  change: "mode" | "targets" | "custom_rule";
  hot_switched: boolean;
  reconnect_required: boolean;
  emitted_at: string;
};
```

触发：`route_set_mode` / `route_targets_set` / `rule_custom_add` / `rule_custom_delete` 事务提交后。

- `hot_switched = true` 时 `applied_mode === routing_mode`，当前连接已生效。
- `hot_switched = false` 时两者可以不同；`reconnect_required = true` 表示改了但当前连接还没用上，UI 必须显示「下次连接生效」。判断依据是 `route_revision` 与 `applied_revision` 是否相等。
- 模式热切**不触发** `runtime-state-changed`：进程没迁移，只是某类流量的出口变了。

### 4.15 `rules-changed`（2.1 新增）

规则数据目录切换成功。

```ts
type RulesChangedPayload = {
  contract_version: "2.5.0";
  active_version: string;
  previous_version: string | null;
  geosite_tag: string | null;
  geoip_tag: string | null;
  item_count: number;
  effective: "next_connect";
  emitted_at: string;
};
```

触发：`rules_update` 完成校验并原子切换目录之后。

- **不打断当前连接**：当前连接继续用旧规则，下次连接才生效；payload 里固定 `effective = "next_connect"`。
- 未连接时排队的更新在下一次连接成功后执行，执行完同样发本事件。
- 失败的更新不发本事件（`job-progress` 以 `failed` 结束，保留旧版本）。

### 4.16 应用事件的顺序约定

Tauri 不保证跨 `emit` 的顺序，因此对 2.0 新增事件规定：

1. **配置先于连接**：`config-changed(activated)` 一定在随之而来的 `runtime-state-changed(starting)` 之前。
2. **断开先于切换**：`config_activate` 带 `confirmDisconnect` 时，`runtime-state-changed(→ stopping/stopped)` 先于 `config-changed(activated)`。
3. **节点切换不发运行时事件**（§4.11）。
4. **问题事件与运行时事件互不阻塞**：一次崩溃可能同时产生 `runtime-state-changed(failed)` 与 `issue-changed(created)`，两者没有先后要求；UI 必须能处理任意顺序。
5. **布局按 `revision` 丢弃旧值**（§4.13），不依赖到达顺序。
6. **`routing-changed` 在 selector 写成功后发出**；`hot_switched = true` 时，其后到达的 `runtime-state-changed` 快照里 `applied_mode` 必须已经是新值，不得回退。UI 按 `route_revision` / `applied_revision` 判断，不以事件到达顺序为准。
7. **`rules-changed` 不改当前连接**（`effective = "next_connect"`），不得据此刷新运行中的代理卡或状态。

### 4.17 `core-upgrade-progress`（2.5 新增）

```ts
type CoreUpgradeProgressPayload = {
  contract_version: "2.5.0";
  job_id: string;
  phase: "downloading" | "verifying" | "unpacking" | "installing" | "activating";
  received: number;               // 已接收字节
  total: number | null;           // 总字节；源未给 Content-Length 时为 null
  emitted_at: string;
};
```

触发：`core_upgrade` 任务的阶段或已接收字节变化，最多 4 次/秒；1% 以下的字节变化不发。

- `total = null` 表示总大小未知，UI 显示不确定进度条，**不要按 0 算百分比**。
- 阶段只前进不回退；`downloading` 期间 `received` 单调不减。
- **只在后台下载与安装，不改变当前运行中的进程**；升级完成后要等用户重启才生效。
- 任务失败或取消时，进度事件以最后一个阶段的最后一条结束，随后发 `core-upgrade-finished`。

### 4.18 `core-upgrade-finished`（2.5 新增）

```ts
type CoreUpgradeFinishedPayload = {
  contract_version: "2.5.0";
  job_id: string;
  ok: boolean;
  code?: string;      // ok = false 时给错误码，取值见 commands.md §7.10
  version?: string;   // ok = true 时给已安装版本
  emitted_at: string;
};
```

触发：升级任务结束（成功、失败或取消），**每个 `job_id` 恰好一条**，且是该任务最后一条事件。

- `ok = true` 时 UI 重新调用 `core_info`，并按 `restart_required` 提示「重启后生效」；**不自动重启**。
- `ok = false` 时保留当前版本继续可用；`code` 用于区分网络 / 源 / 校验 / 磁盘 / 忙等失败。
- 取消的任务同样发本事件，`ok = false`、`code = "CANCELLED"`。

---

## 5. UI → Host 调用（invoke）

> **1.1.0 起全部迁到 `docs/contracts/commands.md`。** 本节只保留迁移说明，不再维护命令表。
>
> 原因：命令属于「UI → Host」方向，与本文档「Host → UI 的事件」是两个方向，混在一份文件里导致参数命名约定（camelCase）长期写错。
>
> 迁移时一并纠正的三处：
> 1. invoke 参数名是 **camelCase**（`configId` / `sessionId`），不是 snake_case。
> 2. `catalog_list_nodes` / `profile_import_node` / `vpn_connect` / `vpn_disconnect` 从未在 `invoke_handler` 注册（「文档有、代码没有」）。
> 3. `chat_history` / `deepseek_key_status` / `deepseek_save_key` / `deepseek_clear_key` 已实现但从未入契约（「代码有、文档没有」）。
>
> 2.0 起命令表以 `commands.md` 为唯一来源；`import_seed_file` 的完整语义见 `commands.md` §8.3。

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

| # | 议题 | 我的建议 | 状态 |
|---|---|---|---|
| 1 | `node-list-changed` 是否需要节流 | **不需要**。种子刷新一次一条、导入一次一条，量级远低于健康事件；给导入加节流反而会让「刚加的节点没出现」 | 待确认 |
| 2 | `issue-changed` 是否在 `ignored` 时也带 `blocking_issue_id` | **带**。忽略一条 P0 后，中间该出现下一条 P0 或不再插卡，这个计算必须由 Host 一次给出，UI 不重算 | 待确认 |
| 3 | `runtime-state-changed` 携带完整 `snapshot` 是否可接受 | **可接受**。payload 远小于 64 KB，换来的是端口/配置/节点三者的顺序一致性 | 待确认 |

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

### 2.5.0（2026-11-05，核心升级进度事件）

| # | 变更 | 类型 | 决议来源 |
|---|---|---|---|
| 1 | `contract_version` 升到 `2.5.0` | 元数据 | 运行时核心版本管理改为 UI 显式触发 |
| 2 | 新增 `core-upgrade-progress`（事件总数 20 → 22 之一），载荷含 `job_id` / `phase` / `received` / `total` | 新增事件 | 后台下载需要可见进度 |
| 3 | 新增 `core-upgrade-finished`，每个 `job_id` 恰好一条，`ok = false` 时带 `code` | 新增事件 | 升级结果必须能被 UI 收尾 |
| 4 | `job-progress.kind` 增加 `core_upgrade` | 字段扩展 | 升级是长任务，`JobGet` 也要能认 |
| 5 | 明确升级/回滚都不改当前运行中的进程，`restart_required` 由 `core_info` 表达 | 约束 | 不静默重启 |

### 2.4.0（2026-11-05，节点延迟与出口延迟分开）

| # | 变更 | 类型 | 决议来源 |
|---|---|---|---|
| 1 | `contract_version` 升到 `2.4.0` | 元数据 | 产品：面板上的「2098 毫秒」是出口 IP 探测，不是节点延迟 |
| 2 | `runtime-health-changed` 载荷新增 `node_latency_ms: number \| null`（Clash API delay 测试的毫秒数） | 字段扩展 | 用户要看的是节点本身快不快 |
| 3 | 明确 `latency_ms` 与 `node_latency_ms` **不得互相填充**，断开 / 失败 / 节点热切换后前者复位 | 不变量 | 防止把上一个节点的数字留在面板上 |
| 4 | `contract_version` 字面量统一为本文件当前版本（原先是「引入时的版本」，线上发出的一直是当前版本，两边对不上） | 修正 | 见 §0 的统一约定 |

### 2.3.0（2026-11-04，健康事件补齐连接数与延迟）

| # | 变更 | 类型 | 决议来源 |
|---|---|---|---|
| 1 | `contract_version` 升到 `2.3.0` | 元数据 | 连接期间这两个值不刷新 |
| 2 | `runtime-health-changed` 载荷新增 `connections: number \| null` | 字段扩展 | 活跃连接数只在快照里，UI 连上后一直显示「—」 |
| 3 | 同一载荷新增 `latency_ms: number \| null` | 字段扩展 | 延迟同理，避免每次拉快照 |
| 4 | 明确「采样与断开竞态」：事件中的流量/连接数/延迟只在 running/degraded 时给值，其余为 null | 约束 | 防止晚到的采样发出旧值 |

### 2.2.0（2026-11-04，运行时流量进健康事件）

| # | 变更 | 类型 | 决议来源 |
|---|---|---|---|
| 1 | `contract_version` 升到 `2.2.0` | 元数据 | UI 重构需要实时流量 |
| 2 | `runtime-health-changed` 载荷新增 `traffic: TrafficStats \| null` | 字段扩展 | 产品：连上后要一直看到用了多少流量 |
| 3 | 明确发送频率：每次健康检查后发一条（默认 2s），本次不改发送时机 | 说明 | 同上 |

### 2.1.0（2026-11-03，批 3 · 分流与 DNS）

| # | 变更 | 类型 | 决议来源 |
|---|---|---|---|
| 1 | `contract_version` 升到 `2.1.0` | 元数据 | 批 3 |
| 2 | 新增 `routing-changed`（事件总数 18 → 20 之一） | 新增事件 | `routing.md` 1.0.0 |
| 3 | 新增 `rules-changed` | 新增事件 | 同上 |
| 4 | `job-progress.kind` 增加 `rules_update` | 字段扩展 | 规则更新是长任务 |
| 5 | §4.16 补两条顺序约定：selector 热切后的快照一致性、`rules-changed` 不改当前连接 | 约束 | 防止 UI 误刷新 |

### 2.0.0（2026-11-03，批 0 · 契约与数据模型）

| # | 变更 | 类型 | 决议来源 |
|---|---|---|---|
| 1 | `contract_version` 升到 `2.0.0` | 元数据 | 数据模型换成「配置 + 节点池 + 问题」 |
| 2 | 新增 `config-changed`（事件总数 13 → 18 之一） | 新增事件 | 左栏与配置状态必须能推 |
| 3 | 新增 `node-list-changed` / `node-switched` | 新增事件 | 节点池与「切换到此节点」是两件事 |
| 4 | 新增 `issue-changed`，带 `blocking_issue_id` 与 `open_counts` | 新增事件 | 中间最多一张问题卡，计算放 Host |
| 5 | 新增 `layout-updated`，按 `revision` 丢弃旧值 | 新增事件 | AI 布局落库后要推给 UI |
| 6 | `runtime-state-changed` 增加 `snapshot` | 字段新增 | 端口/配置/节点必须与状态迁移同序到达 |
| 7 | `default-profile-updated` 改为种子模型：`seed_id` / `content_sha256` / `node_count`，`applied_at` 改毫秒 | 不兼容 | `veyl_seed.json` 取代 `bootstrap.json` |
| 8 | 时间约定：落库实体字段用 Unix 毫秒，信封与运行时观测值用 ISO | 约定 | 与 `data-model.md` 列类型一致 |
| 9 | 新增 §4.14 应用事件顺序约定 | 新增 | 新增事件之间必须有明确顺序 |
| 10 | §5 的命令迁移说明改指 2.0 的 `commands.md` | 文档 | 命令版本已升 |

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
