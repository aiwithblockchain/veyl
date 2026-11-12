# 契约：事件（Host → UI）

> 契约版本：`2.12.0`
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
- **本文件里所有 `contract_version` 的字面量恒等于本文件版本**（当前 `2.12.0`），升版时全文替换。实现侧只允许有一个常量对应本文件（`EVENT_CONTRACT_VERSION`），不得按事件分别发不同版本号。字段是哪一版加的，记在 §10 变更记录里，不写进字面量。

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
| 23 | `node-probe-progress` | Host → UI | `NodeProbeProgressPayload` | **2.8 新增**：批量测速单个节点完成 |
| 24 | `node-probe-finished` | Host → UI | `NodeProbeFinishedPayload` | **2.8 新增**：批量测速结束（跑完或取消） |
| 25 | `region-changed` | Host → UI | `RegionChangedPayload` | **2.12 新增**：地区生效值变化（AI 写入） |

1–8 是 AI 会话事件，9–25 是应用事件。UI 必须同时订阅两组，否则会出现「AI 说已连接，状态面板还是未连接」。

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
  contract_version: "2.12.0";
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
  contract_version: "2.12.0";
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
  contract_version: "2.12.0";
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

`args_preview` 规则（见 `tools.md` §2.3）：

- **默认展示所有非敏感字段**。
- 命中 `sensitive: true` 的字段值替换为 `"***"`，**键名保留**。
- 兜底黑名单同样打码：`key` / `token` / `secret` / `password` / `uuid` / `private_key` / `short_id` / `auth` / `api_key`。
- **脱敏后没有任何可展示字段时**（全部被打码），整个 `args_preview` 省略，不要发一个只有 `"***"` 的对象。
- 上限：8 个字段，单值 200 字符。
- 凭据、API Key、完整配置一律不出现。

例：`VpnConnect({ node_id: "seed-jp-01" })` → `{ "node_id": "seed-jp-01" }`；`DeepseekSaveKey({ key: "sk-…" })` → 省略。

`source` 规则（见 `tools.md` §2.2）：由 Host 的调用通道决定，UI 不能伪造。UI 点击 `next_actions` 产生的调用其 `source` 仍是 `"agent"`——因为它是经 Agent 转发的。

UI 处理：插入工具卡，状态 `running`，开始计时。

---

### 3.4 `tool-call-end`

```ts
type ToolDisplay = {
  text: string;                              // 面向用户的一句话，≤24 字
  facts?: string[];                          // 可选：≤4 行，只放用户看得懂的名称与数值
  changed: "none" | "restored" | "unknown";  // 这次调用有没有改动用户的设置
  actions?: DisplayAction[];                 // 2.11.0：可直接点击的动作，≤2 个
};

/// 2.11.0。**只能由 Host 填，模型看不到也传不进**；只带不透明 id，不带路径。
type DisplayAction =
  | { kind: "reveal_report_dir"; report_id: string }
  | { kind: "compose_report_mail"; report_id: string };

type ToolCallEndPayload = {
  contract_version: "2.12.0";
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
  display?: ToolDisplay;        // 缺失 = 旧后端或未适配工具，UI 静默回落
  emitted_at: string;
};
```

来源：`QueryEvent::ToolEnd { tool_name, tool_id, result, is_error }`。

`error_code` 的取法：Host 从 `ToolResult.metadata["aivpn"]["error"]["code"]` 读取；没有 metadata 时为 `null`（说明是 Claurst 内置工具报错）。

`display` 规则（2.7.0）：

- **这是给用户看的唯一工具文案。** `result` 是给模型的，UI 不得直接渲染；缺 `display` 时用前端映射表（`tools.md` §2.4）的通用文案兜底，不报错、不丢事件。
- `text` ≤24 字，不含工具名、`cfg_…` / `nod_…` 等 id、路径、错误码、英文或原始 JSON。
- `facts` 可选，≤4 行；只放用户关心的名称与数值（配置名、节点名、出口 IP、延迟）。没有就省略，不要填空串。
- `changed` 必填（不是可选）：
  - 只读工具固定 `"none"`；
  - `VpnConnect` / `NetRepair` / `CoreUpgrade` / `ConfigDelete` 四个会改系统设置的工具**必须显式声明**；
  - `"none"` = **没有改动任何设置**；`"restored"` = **已经恢复原样**；`"unknown"` = **不确定，诊断日志里有记录**。
  - 这三句由界面统一渲染，面向全部工具，**不得出现「网络」二字**：`ConfigCreate` 校验失败、`ConfigDelete` 失败时根本不碰网络设置，写「网络设置」对它们是错的。
- `AskUserQuestion` **不产生展示行**（提问由 `ask-user-question` 的问答浮层承担），其 `tool-call-end` 省略 `display`；UI 不为它渲染工具行。
- 不得把 `display.text` 塞进 `result`：`result` 要留给模型，两者不能是同一根字符串。

**`display.actions` 规则（2.11.0）**：

- 只有 Host 能填；模型无法用工具入参产生动作，也看不到动作。
- 每个动作只带 `report_id`（不透明标识），**不得**出现路径、命令、URL。需要路径时由命令自行解析，且只解析到 Host 登记过的报告目录。
- UI 点击 = **调命令**（`issue_report_reveal` / `issue_report_mail`），**不是**发一条用户消息——这一点与 `next_actions` 相反，两者不得混用。
- 未识别的 `kind` 忽略，卡片按无动作渲染（前向兼容）。
- 动作失败（`NOT_FOUND`；邮件客户端调起失败时是 `opened: false, method: "copy_only"`）由 UI 就地提示，不自动重试、不发事件。

UI 处理：

- 更新卡片状态 `ok` / `error`。
- 渲染 `next_actions` 为一到两个按钮，点击等价于用户发出对应工具调用意图（**不直接执行工具**，要做成一条用户消息）。
- 渲染 `display.actions` 为独立按钮，点击**直接调命令**（见上）。两组按钮同时存在时，`display.actions` 排在 `next_actions` 之前。

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
  contract_version: "2.12.0";
  request_id: string;
  assistant_message_id: string;
  phase: AiStatusPhase;
  text: string;                 // 面向用户的一行状态，例 "正在检查连接状态"
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
正在检查连接状态
```

`text` 约束（2.7.0）：

- 面向用户的一行，**不得包含工具名**、字段名、错误码、`cfg_…` / `nod_…` 等 id；不得拼成「{tool} 正在运行」「正在执行 {tool}」。
- `running_tool` 的文案来自前端映射表（`tools.md` §2.4）；**未知工具固定「正在处理…」**，不得回落到原始工具名。
- 提示词只降低模型说错话的概率；文案的最终闸门在渲染层（`tool-call-end.display` + 映射表）。

UI 处理：更新顶部状态行；`waiting_permission` 时同时高亮权限卡。

**本地化（P1 决议）**：P1 由 Host 直接生成中文 `text`，前端原样展示，不做翻译。P2 若要多语言，改为 `text_key: string` + `params: Record<string, unknown>`，前端查表；届时 `text` 作为降级字段保留一版。

---

### 3.6 `ai-compact`

```ts
type AiCompactPayload = {
  contract_version: "2.12.0";
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
  contract_version: "2.12.0";
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
  contract_version: "2.12.0";
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
- `snapshot.contract_version` 跟 **`runtime.md`**（当前 `2.8.0`），与顶层的 `contract_version`（本文件 `2.12.0`）**可以不同**：一个声明快照形状的版本，一个声明事件形状的版本，两处都对。消费方不要拿其中一个去校验另一个。
- payload ≤ 64 KB；`RuntimeSnapshot` 本身远小于上限，不需要截断。

UI 处理：更新状态栏与顶部主按钮；`to = "failed"` 时显示诊断入口；用 `snapshot.mixed_port` 重渲染代理卡。

---

### 4.2 `runtime-health-changed`

```ts
type RuntimeHealthChangedPayload = {
  contract_version: "2.12.0";
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
  contract_version: "2.12.0";
  job_id: string;
  kind: "core_install" | "core_upgrade" | "diag" | "rules_update";
  origin: "ui" | "agent";       // 必填；第一帧也带，旧记录按 "ui"
  state: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  stage: string;
  progress: number;              // 0.0–1.0
  message: string | null;
  error: AivpnError | null;
  emitted_at: string;
};
```

触发：任务状态或 `stage` 变化，最多 4 次/秒。进度不足 1% 的变化不发。

- **第一帧也带 `origin`**（`state = "queued"` 时就必填）：设置页打开任务列表后，第一屏就能标注「用户发起 / AI 发起」。
- `origin` 由 Host 按调用路径写入，不是命令/工具入参；旧记录缺失时按 `"ui"` 处理。

UI 处理：进度条；`state = "failed"` 时显示错误与重试按钮。

---

### 4.4 已移除：`approval-requested`

> 2026-11-02 用户决定彻底移除审批机制，本事件随之删除。详见 `tools.md` §2.1。

---

### 4.5 `app-lifecycle-changed`（1.1.0 新增）

```ts
type AppLifecycleState = "foreground" | "background";

type AppLifecycleChangedPayload = {
  contract_version: "2.12.0";
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
  contract_version: "2.12.0";
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
  contract_version: "2.12.0";
  session_id: string;
  request_id: string;
  question_id: string;      // Host 生成，形如 q_<毫秒>_<8位十六进制>
  question: string;         // 问题正文
  options: string[];        // 单选选项；**数组非空，且每项都是非空字符串**
  kind?: string;            // Host 填充的结构化用途；模型提问时省略
  details?: Record<string, unknown>;  // 与 kind 配套的结构化数据；模型提问时省略
  created_at: number;       // Unix 毫秒，问题生成时刻
  expires_at: number;       // Unix 毫秒，= created_at + 900_000（15 分钟）
  emitted_at: string;       // ISO 8601 UTC
};
```

#### 4.8.0 `kind` / `details`（2.6 新增）

- 两个字段**只由 Host 填充**，用于结构化确认卡。当前唯一用途是 `kind: "core_upgrade_confirm"`（`commands.md` §7.10）。
- 模型调用 `AskUserQuestion` 时这两个字段一律省略；模型传入的任何值都被丢弃，**不得回显**。
- `kind` 是开放字符串：UI 只对认识的 kind 做专门渲染，其余按普通问题处理；**不得因为不认识的 kind 丢掉事件**。
- `details` 的结构随 `kind` 定义。UI 不得把它当作用户输入回传——回答仍走 `reply_user_question` 的 `answer`。
- 当前唯一的 kind 是 `"core_upgrade_confirm"`，`details` 形状见 `commands.md` §7.10：`{ current_version, target_version, size?, source: "official", restart_required }`。`restart_required` 为 `true` 时卡上说明「升级后需重启 App 才生效」；**字段缺失时 UI 默认按「下次连接生效」展示**，不得因此报错或丢卡。

#### 4.8.1 语义

- **回答**：普通提问接受**任何非空文本**，原样回给模型——提问不是选择题，用户想补充说明时不能只能点按钮。`kind: "core_upgrade_confirm"` 是装包授权，`answer` 必须逐字等于 `options` 之一（不做 trim、不做大小写归一）。规则与 `commands.md` 2.16.0 §9.6 一致。
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
  contract_version: "2.12.0";
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
  contract_version: "2.12.0";
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
  contract_version: "2.12.0";
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
  contract_version: "2.12.0";
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

### 4.13 `layout-updated`（2.0 新增；2.10.0 改为整份丢弃）

当前配置的中间区域编排布局落库。

```ts
type LayoutUpdatedPayload = {
  contract_version: "2.12.0";
  config_id: string;
  revision: number;            // 每配置单调递增，从 1 开始
  layout: Layout;              // 见 commands.md §3.0
  emitted_at: string;
};
```

触发：AI 产出的布局通过校验并写入 `layouts` 表之后（批 4 接线）。

规则：

- **`revision` 单调递增**。UI 收到 `revision <= 已渲染的 revision` 时丢弃——网络/线程调度可能导致旧布局后到，覆盖新布局会让中间区域闪回上一个版本。
- **`config_detail` 必须返回 `layout_revision`**（`commands.md` §3.0），与 `layout` 配套。UI 用它初始化「已渲染的 revision」；缺了它，同一配置内迟到的事件无法判断先后，中间区会闪回上一版。
- **AI 能写进布局的块只有 5 个**：`empty_hint` / `proxy_card` / `source_choice` / `reachability` / `update_hint`。`issue_card` 是本地规则的**叠加渲染**（§4.12），**不在布局词汇表内**——写进布局即整份非法，否则故障卡会渲染两次。
- **非法布局整份丢弃，不逐块过滤。** 出现未知块、`issue_card`、重复块类型、`props` 越界或字符串不合规，都按整份非法处理：不写库、不发本事件、保留上一版布局、记 `warn` 日志（只记原因码，不记内容）。首次就非法时 `layout` 仍是 `null`，走本地兜底。
  逐块过滤会让中间区呈现「模型没打算要的构成」：例如把 `issue_card` 滤掉，用户就少了自救入口，而界面上没有任何提示说明少了什么。整份丢弃则保留上一版布局，行为可预期。
- **长得像布局的东西永远不进正文。** 判定分两路：`layout` 围栏是模型明确表态「这是布局」，不必再靠形状猜；`json` / 无标记围栏 / 行首裸 JSON 可能是用户在讨论代码或模型在举例，靠形状兜底。

  | 来源 | 是否进正文 | 写库条件 |
  |---|---|---|
  | `layout` 围栏 | **一律不进正文**，内容不是合法 JSON 也一样 | 能解析且通过校验才写库；否则丢弃并记原因码（解析失败记 `bad_json`） |
  | `json` / 无标记围栏 / 行首裸 JSON | **形状像布局**（对象同时有 `version` 与 `blocks`，不校验字段类型）就吞掉；否则当普通内容原样放行 | 形状像 → 通过校验才写库，校验不过丢弃并记 `bare_invalid`；形状不像 → 不解析 |

  - 裸 JSON 只认行首（允许前导空白，第一个非空白字符是 `{`）；按 JSON 的字符串与转义规则配对到对应 `}`，**不是简单数括号**。嵌在句子中间的 `{` 原样输出，否则会吃掉用户讨论 JSON 的正文。
  - **`layout` 围栏未闭合 → 整段丢弃**，不补发；内容写坏也不把半截 JSON 显示给用户——这正是旧边界的问题。
  - 裸候选超过 **8 KiB** 仍未闭合 → 放弃候选、原样放行，记 `bare_too_large`（防止巨型 JSON 把内存吃住）。
  - `json` / 无标记围栏不再「校验不过就原样显示」：只要形状像布局就吞掉。
- **原因码**（只进日志，不进界面、不进事件载荷）：`bad_json`、`bad_version`、`unknown_block`、`duplicate_block`、`bad_props`、`too_many_blocks`、`unsafe_string`、`block_not_applicable`；识别阶段另有 `bare_invalid`（形状像布局但校验不过）与 `bare_too_large`（超限放行）。
- **语义校验只在写入时做。** `proxy_card` 只能用于 `connect_mode = "system_proxy"` 的配置，`source_choice` 只能用于节点集为空的配置；写入时违反任一条 → **整份丢弃**并记 `block_not_applicable`。已落库的布局在配置之后变化（如用户从本机代理切到 TUN）时**不做回溯校验、不整份丢弃**：渲染层只跳过不适用的块，不改库、不发事件、不消耗 revision。两处若都做整份丢弃，用户只是换了个接管方式，中间区就整体消失了。
- **块参数里没有数值。** 端口、地址、版本号、问题文案一律在渲染时从运行时 / 后端读，模型不能写进 `props`。模型只能给块类型，外加 `reachability` 的 `targets`：1–6 项、每项 trim 后 1–24 字符、去重；禁控制字符与 `://`，禁 `<` `>` `&` `"` `'`，禁以 `javascript:` / `data:` 开头，禁含 `/` 或 `:`。模型写错一个端口比不写更糟。
- **同一条消息出现多份布局时只认最后一份**，前面几份不写库、不发事件。**请求被取消或出错时不写入**任何一份——没有成功收尾的请求不改变中间区布局。
- **`config_id` 的归属：开始时优先，中途有激活则跟随请求结束。**
  - 请求开始时已有活动配置，且请求过程中没有配置被激活 → 归属开始时的那个。
  - 请求开始时**没有**活动配置（首启），**或**请求过程中有配置被激活（AI 新建并 `ConfigCreate` / `activate`）→ 归属**请求结束时**的活动配置。
  - 请求结束时没有活动配置 → 不写库、不发事件。
  按「一律取请求开始时」会把首启的布局整段跳过（kickoff 时还没有配置，`source_choice` 永远不出现）；反过来，AI 新建并激活一套配置时会把布局写到旧配置上。UI 收到事件后按 `config_id` 与当前激活配置比对，不匹配就丢弃。
- **测试口径**：首启无配置 → 布局落到 AI 新建的那套配置；请求中切换或新建并激活配置 → 布局不落到旧配置。
- AI 不能改样式：`props` 只承载内容与参数，样式永远由设计规范决定。
- **本地规则不写布局**（见 §4.12）。因此本事件只有 AI 编排一个来源，没有 `source` 字段。
- 切换配置时**不重发本事件**：`config-changed(activated)` 之后 UI 调 `config_detail`，布局与 `layout_revision` 随详情一起返回。

### 4.14 `routing-changed`（2.1 新增）

分流模式、目标分类或自定义规则发生变化。

```ts
type RoutingChangedPayload = {
  contract_version: "2.12.0";
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
  contract_version: "2.12.0";
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
  contract_version: "2.12.0";
  job_id: string;
  origin: "ui" | "agent";         // 必填
  phase: "downloading" | "verifying" | "unpacking" | "installing" | "activating";
  received: number;               // 已接收字节
  total: number | null;           // 总字节；源未给 Content-Length 时为 null
  emitted_at: string;
};
```

触发：`core_upgrade` 任务的阶段或已接收字节变化，最多 4 次/秒；1% 以下的字节变化不发。

- `origin` 每一帧都必填，从第一帧开始；由 Host 按调用路径写入（设置页 = `"ui"`，`CoreUpgrade` 工具 = `"agent"`）。

- `total = null` 表示总大小未知，UI 显示不确定进度条，**不要按 0 算百分比**。
- 阶段只前进不回退；`downloading` 期间 `received` 单调不减。
- **只在后台下载与安装，不改变当前运行中的进程**；升级完成后要等用户重启才生效。
- 任务失败或取消时，进度事件以最后一个阶段的最后一条结束，随后发 `core-upgrade-finished`。

### 4.18 `core-upgrade-finished`（2.5 新增）

```ts
type CoreUpgradeFinishedPayload = {
  contract_version: "2.12.0";
  job_id: string;
  origin: "ui" | "agent";   // 必填
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

### 4.19 `node-probe-progress`（2.8.0 新增；2.9.0 增 `phase` / `method`）

批量测速的阶段与逐节点结果。

```ts
type NodeProbeProgressPayload = {
  contract_version: "2.12.0";
  run_id: string;
  config_id: string;
  phase: "preparing" | "probing";
  method: "tcp" | "clash";       // clash = 真实可用性（「可用」）；tcp = 仅可达（「可达」）
  done: number;                  // 已完成节点数；preparing 阶段为 0
  total: number;
  result: NodeProbeData | null;  // preparing 阶段为 null；probing 的逐节点事件非空
  emitted_at: string;
};
```

触发：`node_probe_all` 启动的批次。

- **批次开始时先发一条 `phase = "preparing"`**（`done = 0`、`result = null`）：临时运行时尚未就绪。
- 进入探测后发一条 `phase = "probing"`（`done = 0`、`result = null`）；它的 `method` 是**最终**方式——如果运行时启动失败/8 秒未就绪，这里就是降级后的 `"tcp"`。
- 之后每测完一个节点发一条 `phase = "probing"`、`result` 非空的事件。
- `method` 术语固定，不得混用：**`clash` = 真实可用性（界面写「可用」）；`tcp` = 仅可达（界面写「可达」）**。
- 只在批次运行时出现；关闭面板不影响，批次继续在后台跑完（用户没点取消）。
- `done` 单调递增，按完成顺序发出，**不按节点顺序**。
- UI 按 `run_id` 匹配：忽略不是当前批次的事件；按 `done` 去重（重开面板可能先收到一条早于 `snapshot.run.done` 的迟到事件）。
- `config_id` 让 UI 能丢弃「已经切走的配置」的迟到事件。
- 单节点失败也照常发：`result.reachable = false` 是正常结果，不是错误事件。
- **不改变任何持久状态**：本事件与 `node-probe-finished` 都不对应 `*-changed`，不得据此刷新节点列表或运行状态。

### 4.20 `node-probe-finished`（2.8.0 新增；2.9.0 增 `method` / `reason`）

```ts
type NodeProbeFinishedPayload = {
  contract_version: "2.12.0";
  run_id: string;
  config_id: string;
  total: number;
  ok: number;
  failed: number;
  method: "tcp" | "clash";       // 整批实际使用的方式；降级时为 "tcp"
  cancelled: boolean;
  reason: "connected" | null;    // 用户中途启动 VPN 导致取消时为 "connected"
  network: "ok" | "offline";
  emitted_at: string;
};
```

触发：批次结束（跑完或取消）。每个 `run_id` **恰好一条**，且是该批次最后一条事件。

四个终态（UI 据此给汇总文案）：

| 终态 | 判据 | 界面 |
|---|---|---|
| 正常结束 | `cancelled = false`，`ok > 0` | `method = "clash"`：「18 个可用 · 5 个超时」；`method = "tcp"`：「18 个可达 · 5 个超时」+「没连上，只能确认服务器连得上，不验证密码和出口」 |
| 全部失败、本机有网 | `cancelled = false`，`ok = 0`，`network = "ok"` | 「都没测通」+「这些节点可能都不可用」 |
| 全部失败、本机离线 | `cancelled = false`，`ok = 0`，`network = "offline"` | 顶部提示「现在没有网络，测速结果不代表节点状态」 |
| 取消 | `cancelled = true` | 回到「上次测速：N 分钟前」，不加错误；`reason = "connected"` 时说明「启动 VPN 后测速已停止」 |

- **降级必须看得出来**：`method = "tcp"` 时界面只能写「可达」，不得写「可用」；两词不得混用或简写。
- 不取消时 `ok + failed = total`；取消时两者之和是**已测完**的数量，可能小于 `total`。
- `network` 只在**全部节点都失败**时才检查本机连通性（直连 204，不走 Veyl 代理）；否则固定 `"ok"`。
- 取消后不再有 `node-probe-progress`；已出的结果保留在内存缓存里（`node_probe_snapshot` 可见）。
- 批次不跨进程：应用退出直接丢弃，**不补发本事件**、不等待、不落库。
- 不发任何 `*-changed`；不登记问题。

### 4.21 `region-changed`（2.12 新增）

```ts
type RegionChangedPayload = {
  contract_version: "2.12.0";
  region: string | null;          // 生效地区的小写 ISO 3166-1 alpha-2；判不出为 null
  source: "system" | "ai";        // 当前生效值的来源
  emitted_at: string;
};
```

触发：AI 工具 `SetUserRegion` 写入 `settings.user_region` 成功后发一条。这是地区唯一的写路径——`commands.md` 没有 `region_preference` 命令，界面也没有地区控件。

- `region` 是写入后的**生效值**，不是系统原始推断；当前实现发出的 `source` 恒为 `"ai"`。
  `"system"` 预留给将来由系统侧刷新生效值的场景，消费方必须两种都接。
- **只影响下一次建连**：已连接时不断开、不重连，`RuntimeSnapshot.route_region` 与
  `route_get.applied_region` 保持建连时的值。UI 更新展示后，在说明行追加
  「地区已改，下次连接生效」（`docs/design/simplified-config-create.md` §8.4）。
- `region = null` 是合法值（写入值被外部改坏后按未知处理）。UI 按「未知」显示，
  **不得回落 `cn`**，也不得拿 `route_get.detected_region` 顶替已连接时的 `applied_region`。
- 不改变配置、不改分流模式，因此不发 `routing-changed`。
- 与 `system_region` 同源：事件里的 `region` / `source` 必须与随后调用 `system_region`
  的结果一致（`commands.md` §10.10）。

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
| 无 AI 模式的来源校验 | Host 边界注入 `source: "ui" \| "agent"`，不可由参数传入；**没有审批机制，破坏性操作无论来源都直接执行**（1.0.8 起） | §5、`tools.md` §2.2 |

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

### 2.12.0（2026-11-12，地区生效值事件）

| # | 变更 | 类型 | 决议来源 |
|---|---|---|---|
| 1 | `contract_version` 升到 `2.12.0`；全文 `contract_version` 字面量替换为 `2.12.0`（实现侧常量 `EVENT_CONTRACT_VERSION`） | 元数据 | 地区链路（`docs/design/simplified-config-create.md` §14） |
| 2 | 事件总表新增 #25 `region-changed`，载荷 `{ region: string \| null, source: "system" \| "ai", emitted_at }` | 新增事件 | 地区可以由 AI 在对话里写入；UI 需要一条事件同步所有地区展示 |
| 3 | 写明事件只影响下一次建连：已连接不断开、不重连，`route_region` / `applied_region` 保持建连时的值 | 约束 | 自动重连会打断用户正在进行的工作；界面要能说清「下次生效」 |
| 4 | 写明 `region = null` 合法且不得回落 `cn`；事件与 `system_region` 同源 | 约束 | 未知地区必须按未知显示，否则会把用户流量导进错误规则 |
| 5 | 文件内指向 `runtime.md` 的版本引用同步到 `2.8.0` | 元数据 | `RuntimeSnapshot` 版本跟随 `runtime.md` |

### 2.11.0（2026-11-12，`tool-call-end.display.actions`）

| # | 变更 | 类型 | 决议来源 |
|---|---|---|---|
| 1 | `contract_version` 升到 `2.11.0` | 元数据 | 问题报告功能 |
| 2 | §3.4 `ToolDisplay` 增可选 `actions: DisplayAction[]`（≤2 个），只有 `reveal_report_dir` / `compose_report_mail` 两种，只带 `report_id` | 字段扩展 | 会话里要出现「在文件夹中显示 / 打开发送邮件」，而 `next_actions` 的语义是「发一条用户消息」，不能用来开文件夹 |
| 3 | 明确动作只能由 Host 填、模型看不到也传不进；UI 点击是**调命令**而非发消息 | 安全约束 | 一旦允许模型生成动作，就能诱导 UI 打开任意路径 |
| 4 | 未识别的 `kind` 忽略并降级为无动作渲染 | 兼容 | 前向兼容 |
| 5 | 全文 `contract_version` 字面量替换为 `2.11.0`（实现侧常量 `EVENT_CONTRACT_VERSION`） | 元数据 | §0 版本约定 |

### 2.10.0（2026-11-06，非法布局整份丢弃）

| # | 变更 | 类型 | 决议来源 |
|---|---|---|---|
| 1 | `contract_version` 升到 `2.10.0` | 元数据 | 布局校验策略调整 |
| 2 | §4.13 由「非法块过滤掉、只保留合法块」改为**整份丢弃**：不写库、不发事件、保留上一版布局 | 语义变更 | 逐块过滤会让中间区呈现模型没打算要的构成；`issue_card` 被滤掉时用户少了自救入口且无任何提示 |
| 3 | §4.13 写明 AI 可写块只有 5 个（`empty_hint` / `proxy_card` / `source_choice` / `reachability` / `update_hint`），`issue_card` 是叠加层、不写进布局 | 澄清 | 文档原写「六个块」，与 §4.12 的叠加渲染矛盾 |
| 4 | §4.13 要求 `config_detail` 返回 `layout_revision`；`revision <= 当前` 的事件丢弃 | 约束 | 同配置内迟到事件无法判断先后时，中间区会闪回上一版 |
| 5 | §4.13 写明同一条消息出现多份布局只认最后一份；请求取消或出错不写入 | 约束 | 模型重试/多轮输出时，前面几份是废稿 |
| 6 | §4.13 写明块参数里没有数值：端口、地址、版本号渲染时读运行时；模型只能给块类型与 `reachability.targets`（1–6 项、每项 ≤24 字符、禁控制字符与 `://`） | 约束 | 模型写错端口比不写更糟 |
| 7 | 文件头、正文与全部载荷的 `contract_version` 字面量统一为 `2.10.0`；修正两处滞后的「当前版本」说明 | 元数据 | 版本字面量必须恒等于文件版本 |
| 8 | §4.13 更正布局归属：开始时已有活动配置且中途没有激活 → 归属它；开始时没有，或请求中有配置被激活 → 归属请求结束时的活动配置；结束时没有活动配置则不写 | 更正 | 一律取「请求开始时」会让首启布局整段跳过（`source_choice` 永不出现），AI 新建并激活配置时又会写到旧配置上 |
| 9 | §4.13 写入统一判定：按形状识别三种候选（`layout` 围栏 / `json` 或无标记围栏 / 行首裸 JSON），**长得像布局就永远不进正文**，合法性只决定写不写库；`json` 围栏不再「校验不过就原样显示」 | 语义变更 | 真机上模型把裸 JSON 写进正文；旧规则会把写错块名的布局整段显示给用户 |
| 10 | §4.13 增原因码 `bare_too_large`（裸候选超 8 KiB 放行）、`bare_invalid`（形状像但校验不过）、`block_not_applicable`（`proxy_card` 用于非 system_proxy、`source_choice` 用于已有节点的配置） | 字段扩展 | 日志要能区分「没识别成布局」与「识别了但不合法」 |
| 11 | §4.13 写明语义校验只在写入时做：配置之后变化不做回溯校验，渲染层只跳过不适用的块，不整份丢弃 | 约束 | 否则用户只换了接管方式，中间区就整体消失 |
| 12 | §4.13 区分 `layout` 围栏与 `json` / 裸候选：`layout` 无论内容一律不进正文，能解析且合法才写库，未闭合整段丢弃；`json` / 无标记围栏 / 行首裸 JSON 维持按形状（同时有 `version` 与 `blocks`）吞掉 | 语义变更 | 旧的形状兜底会让 ```layout 里写坏 JSON 时把半截 JSON 显示给用户 |

### 2.9.0（2026-11-06，未连接时的真实延迟与降级）

| # | 变更 | 类型 | 决议来源 |
|---|---|---|---|
| 1 | `contract_version` 升到 `2.9.0` | 元数据 | 未连接时临时起运行时测真实延迟 |
| 2 | `node-probe-progress` 增 `phase: "preparing" \| "probing"`、`method: "tcp" \| "clash"`；`result: NodeProbeData \| null`（preparing 阶段为空） | 字段扩展 | 重开面板要能恢复「正在准备」与测试方式 |
| 3 | 批次开始先发 `preparing`，进入探测发一条 `probing`（method 为最终方式），随后每个结果一条 `probing` | 约束 | 运行时启动失败降级 tcp 时，界面要能立即改词 |
| 4 | `node-probe-finished` 增 `method`（整批实际方式）与 `reason: "connected" \| null`（用户中途启动 VPN） | 字段扩展 | 降级时文案从「可用」变「可达」；中途连 VPN 要说明原因 |
| 5 | 术语固定：`clash` = 真实可用性（可用），`tcp` = 仅可达（可达）；两词不得混用 | 约束 | 用户按「可达」挑节点不会误以为密码与出口已验证 |

### 2.8.0（2026-11-06，批量测速）

| # | 变更 | 类型 | 决议来源 |
|---|---|---|---|
| 1 | `contract_version` 升到 `2.8.0`；事件总数 22 → 24 | 元数据 | 节点面板需要整表测速 |
| 2 | 新增 `node-probe-progress`（§4.19）：每完成一个节点一条，`done` 单调递增，按 `run_id` 匹配、按 `done` 去重 | 新增事件 | 进度要能恢复，迟到事件不能回退 |
| 3 | 新增 `node-probe-finished`（§4.20）：每个 `run_id` 恰好一条；`ok` / `failed` / `cancelled` / `network` 区分四个终态 | 新增事件 | 部分失败、全失败在线、全失败离线、取消要分开说 |
| 4 | 明确两事件都不发 `*-changed`、不登记问题；批次不跨进程，退出不补发完成事件 | 约束 | 延迟是快照，不是 Job |
| 5 | 本版同时包含 2.7.0 的 `tool-call-end.display`（两者尚未发版，合并进同一开发周期） | 说明 | 文件头统一为 2.8.0 |
| 6 | 失败第二行的三句定稿：`none` → 「没有改动任何设置」、`restored` → 「已经恢复原样」、`unknown` → 「不确定，诊断日志里有记录」；**三句都不得出现「网络」**，因为界面统一渲染、面向全部工具 | 措辞定稿 | `ConfigCreate` / `ConfigDelete` 失败时不碰网络设置 |

### 2.7.0（2026-11-06，对话过程展示）

| # | 变更 | 类型 | 决议来源 |
|---|---|---|---|
| 1 | `contract_version` 升到 `2.7.0` | 元数据 | 工具调用要按用户语言展示，而不是模型措辞 |
| 2 | `tool-call-end` 新增可选 `display: { text, facts?, changed }`：`text` ≤24 字；`facts` ≤4 行；`changed: "none" \| "restored" \| "unknown"` | 字段扩展 | 给模型的 `result` 不能直接展示给用户 |
| 3 | `display` 缺失不报错、不丢事件，UI 回落到前端映射表；`AskUserQuestion` 不产生展示行，可省略 `display` | 约束 | 旧后端与未适配工具必须可平滑降级 |
| 4 | 只读工具 `changed` 固定 `"none"`；`VpnConnect` / `NetRepair` / `CoreUpgrade` / `ConfigDelete` 必须显式声明 | 约束 | 失败时用户要知道网络设置有没有被改动 |
| 5 | `ai-status.text` 不得包含工具名、字段名、错误码与 id；`running_tool` 文案来自映射表，未知工具固定「正在处理…」 | 约束 | 状态行也是面向用户的正文 |

### 2.6.0（2026-11-05，确认卡结构化与任务来源）

| # | 变更 | 类型 | 决议来源 |
|---|---|---|---|
| 1 | `contract_version` 升到 `2.6.0` | 元数据 | AI 代劳升级需要结构化确认卡 |
| 2 | `ask-user-question` 载荷新增可选 `kind` / `details`：**只由 Host 填充**，模型传入的值一律丢弃；UI 对未知 kind 按普通问题处理。`core_upgrade_confirm` 的 `details` 含 `restart_required`（缺失时默认「下次连接生效」） | 字段扩展 | 确认卡不能靠模型自己声明 |
| 3 | `job-progress` 新增必填 `origin: "ui" \| "agent"`，第一帧也带；旧记录按 `"ui"` | 字段扩展 | 设置页首屏要标注任务来源 |
| 4 | `core-upgrade-progress` / `core-upgrade-finished` 新增必填 `origin`，每帧都带 | 字段扩展 | 同上 |
| 5 | 明确 `origin` 由 Host 按调用路径写入，不是命令/工具入参 | 约束 | 防止模型伪装成 UI 发起 |

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
