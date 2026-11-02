# 契约：P1 工具清单

> 契约版本：`1.0.8`
> 状态：已冻结（PM 审核通过，2026-11-02）
> 上游：`docs/phase-1-technical-design.md` §4.3、§4.4、§5.1
> 实现方：Rust（Host，实现 Claurst `Tool` trait）
> 使用方：Agent（模型）与 UI（工具卡片渲染）
> 变更记录：见 §8

---

## 0. 本契约的地位

本文档是 **Agent 能做什么** 的唯一清单。任何不在此清单里的能力，Agent 都没有。

三条硬规则：

1. Agent 只能通过本文列出的工具操作应用，**不注册 shell、文件、网络抓取类工具**。
2. 模型看不到凭据。所有含 `uuid` / `password` / `private_key` / `token` 的字段不得出现在工具返回值里。
3. 工具入参一律按 JSON Schema 严格校验（`additionalProperties: false`），Host 在 `execute` 内再做一次业务校验。

统一约定：字段 **snake_case**、时间 **ISO 8601 UTC + `Z`**、错误码 **大写下划线**。

---

## 1. 工具结果的信封

### 1.1 真实类型

Claurst 的 `ToolResult` 定义在 `claurst-tools`：

```rust
pub struct ToolResult {
    pub content: String,                            // 回给模型的文本
    pub is_error: bool,
    pub metadata: Option<serde_json::Value>,        // 给 UI / TUI 的结构化数据
    pub images: Vec<claurst_core::types::ContentBlock>,
}
```

### 1.2 Veyl 的映射

| 字段 | 用法 |
|---|---|
| `content` | 人类可读摘要，**这是模型唯一能看到的内容** |
| `is_error` | 恒等于 `!envelope.ok` |
| `metadata` | `{ "aivpn": ToolEnvelope }` |
| `images` | 恒为空数组 |

`content` 的要求：

- 一句到两句话，说明发生了什么。
- 失败时必须包含**下一步可做的事**，而不是只报错误码。
- 不得包含凭据、完整配置、模型不需要的原始 JSON。

```
成功：已连接到 东京 01，出口 IP 203.0.113.7，延迟 42ms。
失败：节点 东京 01 连接超时。可以换一个同地区节点，或运行 DiagRun 诊断。
```

### 1.3 `ToolEnvelope`

```ts
type ToolEnvelope = {
  contract_version: "1.0.8";
  ok: boolean;
  summary: string;                       // 与 ToolResult.content 一致
  data: Record<string, unknown> | null;  // 成功时的结构化结果
  error: AivpnError | null;              // 失败时的错误对象
  next_actions: NextAction[];            // UI 渲染的下一步按钮，可为空
  request_id: string;                    // 本次工具调用 ID
  duration_ms: number;
};

type NextAction = {
  label: string;                          // 按钮文案，≤ 12 个汉字
  tool: string;                           // 模型可见的工具名，PascalCase
  args: Record<string, unknown>;
};
```

不变量：

- `ok = true` 时 `error` 必须为 `null`，`data` 可为 `null`。
- `ok = false` 时 `data` 必须为 `null`，`error` 不得为 `null`。
- `next_actions` 只用于 UI；模型通过 `content` 中的文字获得同样信息。

**`next_actions` 的点击语义（已定）**：

点击一个 `NextAction` **不等价于执行工具**，而是等价于用户把 `label` + `args` 作为一条消息发给 Agent：

```
用户点「换到东京 02」
  → 生成用户消息："换到东京 02"（args 作为结构化附注）
  → 交给 Agent，由它正常发起 VpnConnect 工具调用
  → 直接执行（P1 无审批）
```

- UI **不得**直接 invoke 工具、不得绕过 Agent。
- UI **可以**把 `label` 预填进输入框，由用户确认后发送。
- 目的：Agent 始终是唯一决策者，工具调用链路不被绕过。

### 1.4 错误对象

复用 `docs/contracts/runtime.md` §2.6 的 `AivpnError`。工具层只能使用 §6.1 通用码或各模块已定义的专属码，**不得新造**。

---

## 2. 权限与调用来源

### 2.1 没有审批机制（P1）

> **2026-11-02 用户决定：彻底移除权限卡，所有工具默认放行。** 不是「默认放行但可开启」，是没有开关。

这意味着：

| 工具 | 行为 | 风险 |
|---|---|---|
| `CoreInstall` | 直接下载并执行二进制 | 无拦截点 |
| `VpnConnect` | 直接修改系统代理 | 无拦截点 |
| `ProfileDelete` | 直接删除本地配置 | 无拦截点 |

**唯一的约束来自 `PermissionLevel`**：Claurst 用它区分「只读 / 非只读」，只读工具（`RuntimeStatus`、`CatalogSearch`、`ProfileList`、`JobGet`、`RuntimeLogs`、`CoreListVersions`、`DiagRun`、`DeepseekSetupKey`）在 `PermissionMode::Default` 下直接允许；其余工具由 Host 的 `PermissionHandler` 一律返回 `Allow`。

不再存在的东西：

- `ApprovalPolicy` / `ApprovalScope` / `ApprovalGrant`
- `approval_id`、审批卡、`APPROVAL_REQUIRED`
- 「本会话内首次确认」「每次确认」这类策略

`tool_calls.approved` 列**保留**，P1 恒为 `NULL`，表示「审批机制不适用」。保留原因是将来若要恢复审批，不需要再改 schema。

#### 2.1.1 已知产品风险（用户已知情并接受）

> 这一节记录的是**用户明确接受的取舍**，不是疏忽。后来者若要重新引入审批，从这里读起。

去掉拦截点后，以下情况没有任何保护：

1. **模型误判**：Agent 把「看看现在什么状态」理解成「连上节点」，`VpnConnect` 会直接改系统代理，用户来不及阻止。
2. **参数误传**：模型构造的 `node_id` / `profile_id` 有误时，`ProfileDelete` 会直接删掉配置，没有确认步骤。
3. **误触**：UI 上的删除按钮点错，立即生效，没有「确定要删除吗」。
4. **下载执行**：`CoreInstall` 直接下载并运行一个来自网络的二进制。虽然有 SHA256 校验与签名清单，但那防的是「内容被篡改」，不防「Agent 决定装了一个用户没想要的版本」。

P1 的定位是「早期内测、使用者是开发者本人」，这些风险在可接受范围内。**对外发布前需要重新评估**——尤其是 `CoreInstall` 与 `ProfileDelete`。

### 2.2 调用来源校验

```ts
type CallSource = "ui" | "agent";
```

`source` 由 **Host 的调用通道**决定，**绝不从工具入参读取**：

| 入口 | source | 说明 |
|---|---|---|
| Tauri `invoke("vpn_connect", …)` 等 UI 命令 | `"ui"` | 无 AI 模式的直连通道 |
| Claurst `Tool::execute(input, ctx)` | `"agent"` | Agent 发起的工具调用 |

实现要求：

1. `source` 由 Host 在构造 `ToolContext` 时写入，工具实现只读不改。
2. 工具 schema 里**没有** `source` 字段；如果模型传了，按 `INVALID_ARGUMENT` 拒绝（`additionalProperties: false` 已保证）。
3. P1 **不区分来源的业务后果** —— 两种来源走同一条执行路径，都不需要确认。
4. `source` 仍写入 `tool_calls` 审计表，用于事后排查「这个删除是 UI 点的还是 Agent 发起的」。

> 为什么不能从参数传：Agent 能构造任意参数，把 `source` 放进 schema 等于让模型自证身份。来源必须由不可伪造的调用通道给出。

### 2.3 `args_preview` 与 `sensitive` 字段

工具卡片要展示参数摘要，但不能泄露凭据。**默认展示，敏感字段打码**：

**input schema 的字段上标注 `"sensitive": true`**：

```json
{
  "type": "object",
  "properties": {
    "key":   { "type": "string", "sensitive": true },
    "region": { "type": "string" }
  }
}
```

生成规则（按顺序）：

1. 取工具的 `input` 对象，逐字段生成 preview。
2. 命中 `sensitive: true` 的字段 → 值替换为 `"***"`，**键名保留**（UI 显示 `key: ***`，让用户知道有该参数）。
3. 命中兜底黑名单（即使漏标）→ 同第 2 步处理。黑名单：`key` / `token` / `secret` / `password` / `uuid` / `private_key` / `short_id` / `auth` / `apikey` / `api_key`。
4. 嵌套对象递归处理；整段 `credentials` / `tls` 类字段直接替换为 `"***"`。
5. **脱敏后如果没有任何可展示字段**（全部被打码），省略整个 `args_preview`，不要发一个只有 `"***"` 的对象。
6. 上限：最多 8 个字段，单个值超过 200 字符截断并追加 `…`。

例子：

| 工具 | input | `args_preview` |
|---|---|---|
| `VpnConnect` | `{ "node_id": "seed-jp-01" }` | `{ "node_id": "seed-jp-01" }` |
| `VpnConnect` | `{ "profile_id": "prf_1", "strategy": "latency" }` | `{ "profile_id": "prf_1", "strategy": "latency" }` |
| `DeepseekSaveKey` | `{ "key": "sk-abc…" }` | **省略**（唯一字段被打码） |
| `CatalogSearch` | `{ "region": "jp", "limit": 10 }` | `{ "region": "jp", "limit": 10 }` |
| `ProfileDelete` | `{ "profile_id": "prf_1" }` | `{ "profile_id": "prf_1" }` |

其他要求：

- `sensitive: true` 是 Veyl 自有的 vendor 关键字，**Host 在把 schema 交给模型前必须剥离**，避免上游 provider 因未知关键字报错。
- 凭据、API Key、完整 sing-box 配置**一律不出现**在 `args_preview`，包括嵌套对象。

当前需要标注 `sensitive: true` 的字段：

| 工具 | 字段 |
|---|---|
| `DeepseekSaveKey` | `key` |
| 其余 17 个工具 | 无 |

所以 P1 只有 `DeepseekSaveKey` 会因为「全是敏感字段」而省略 preview，其余工具都正常展示参数。

---

## 3. P1 工具总表

模型可见名用 **PascalCase**（与 Claurst 内置工具一致），Rust 类型名加 `Tool` 后缀。

| # | 模型可见名 | Rust 类型 | 用途 | PermissionLevel | 风险 |
|---|---|---|---|---|---|
| 1 | `RuntimeStatus` | `RuntimeStatusTool` | 运行时状态快照 | `ReadOnly` | 只读 |
| 2 | `RuntimeStart` | `RuntimeStartTool` | 启动运行时进程 | `Write` | 中 |
| 3 | `RuntimeStop` | `RuntimeStopTool` | 停止运行时进程 | `Write` | 中 |
| 4 | `RuntimeRestart` | `RuntimeRestartTool` | 重启运行时进程 | `Write` | 中 |
| 5 | `RuntimeLogs` | `RuntimeLogsTool` | 拉取脱敏日志 | `ReadOnly` | 只读 |
| 6 | `CoreListVersions` | `CoreListVersionsTool` | 已安装/可安装版本 | `ReadOnly` | 只读 |
| 7 | `CoreInstall` | `CoreInstallTool` | 下载并安装运行时 | `Execute` | 高 |
| 8 | `CatalogSearch` | `CatalogSearchTool` | 查询节点目录 | `ReadOnly` | 只读 |
| 9 | `ProfileList` | `ProfileListTool` | 本地配置列表 | `ReadOnly` | 只读 |
| 10 | `ProfileImport` | `ProfileImportTool` | 把节点导入为本地配置 | `Write` | 低 |
| 11 | `VpnConnect` | `VpnConnectTool` | 连接 + 设置系统代理 | `Execute` | 高 |
| 12 | `VpnDisconnect` | `VpnDisconnectTool` | 断开 + 恢复系统代理 | `Write` | 中 |
| 13 | `DiagRun` | `DiagRunTool` | 一键诊断 | `ReadOnly` | 只读 |
| 14 | `DeepseekSetupKey` | `DeepseekSetupKeyTool` | 给出注册/取 Key 步骤 | `ReadOnly` | 低 |
| 15 | `DeepseekSaveKey` | `DeepseekSaveKeyTool` | 保存 Key 到本地加密文件 | `Write` | 中 |
| 16 | `JobGet` | `JobGetTool` | 查询长任务 | `ReadOnly` | 只读 |
| 17 | `AskUserQuestion` | （Claurst 内置） | 向用户提问 | `None` | 低 |
| 18 | `ProfileDelete` | `ProfileDeleteTool` | 删除本地配置 | `Write` | 中 |

> `AskUserQuestion` 由 `claurst-tools` 提供，Veyl 只负责注册与 UI 渲染，不重写。

**破坏性工具（destructive）**：`CoreInstall`、`ProfileDelete`、`VpnConnect`（会改系统代理）。P1 **对三者均无确认点**，直接执行；风险评估见 §2.1.1。

### 3.1 注册清单（照抄）

```rust
let tools: Vec<Box<dyn Tool>> = vec![
    Box::new(RuntimeStatusTool::new(rt.clone())),
    Box::new(RuntimeStartTool::new(rt.clone(), proxy.clone())),
    Box::new(RuntimeStopTool::new(rt.clone(), proxy.clone())),
    Box::new(RuntimeRestartTool::new(rt.clone(), proxy.clone())),
    Box::new(RuntimeLogsTool::new(rt.clone())),
    Box::new(CoreListVersionsTool::new(installer.clone())),
    Box::new(CoreInstallTool::new(installer.clone())),
    Box::new(CatalogSearchTool::new(catalog.clone())),
    Box::new(ProfileListTool::new(store.clone())),
    Box::new(ProfileImportTool::new(catalog.clone(), store.clone())),
    Box::new(ProfileDeleteTool::new(store.clone())),
    Box::new(VpnConnectTool::new(rt.clone(), catalog.clone(), store.clone(), proxy.clone())),
    Box::new(VpnDisconnectTool::new(rt.clone(), proxy.clone())),
    Box::new(DiagRunTool::new(rt.clone(), proxy.clone(), catalog.clone())),
    Box::new(DeepseekSetupKeyTool::new()),
    Box::new(DeepseekSaveKeyTool::new(keychain.clone())),
    Box::new(JobGetTool::new(jobs.clone())),
    Box::new(AskUserQuestionTool::new()),  // claurst-tools
];
```

### 3.2 `VpnConnect` 与 `CoreInstall` 没有确认点

P1 移除审批后，这两个工具直接执行：

- `VpnConnect` 会修改系统代理，不弹确认卡
- `CoreInstall` 会下载并执行二进制，不弹确认卡

它们仍然是**需要用户明确意图**的操作 —— 区别只在于这个意图由 Agent 的判断代替用户点击。风险记录见 §2.1.1。

---

## 4. 工具定义

### 4.1 `RuntimeStatus`

```json
{
  "type": "object",
  "properties": {
    "include_traffic": { "type": "boolean", "default": true }
  },
  "additionalProperties": false
}
```

`data`：`RuntimeSnapshot`（见 `runtime.md` §2.5）。

`next_actions`：

| 当前状态 | 建议动作 |
|---|---|
| `idle` | `VpnConnect`（若已有 profile）/ `CatalogSearch` |
| `running` | `VpnDisconnect` |
| `failed` | `DiagRun` |
| `starting` / `restarting` / `stopping` | 空 |

错误：`RUNTIME_*` 透传；`INTERNAL`。

---

### 4.2 `RuntimeStart`

```json
{
  "type": "object",
  "properties": {
    "profile_id": { "type": "string" },
    "mode": { "type": "string", "enum": ["system_proxy"], "default": "system_proxy" }
  },
  "additionalProperties": false
}
```

- `profile_id` 省略时用当前 active profile。
- 无 profile → `PRECONDITION_FAILED`，`details.hint = "先调用 CatalogSearch 与 ProfileImport"`。

`data`：

```ts
type RuntimeStartData = {
  state: RuntimeState;          // 期望 "running"
  pid: number;
  upstream_version: string;
  already_running: boolean;     // 幂等命中时为 true
};
```

错误：`RUNTIME_BUSY`（`starting`/`restarting` 中）、`RUNTIME_NOT_INSTALLED`、`RUNTIME_START_TIMEOUT`、`RUNTIME_CONFIG_INVALID`、`RUNTIME_PORT_UNAVAILABLE`。

> 注意：`RuntimeStart` **不设置系统代理**。需要代理请用 `VpnConnect`。

---

### 4.3 `RuntimeStop`

```json
{
  "type": "object",
  "properties": {
    "force": { "type": "boolean", "default": false }
  },
  "additionalProperties": false
}
```

`data`：

```ts
type RuntimeStopData = {
  state: "idle";
  system_proxy_restored: boolean;
  stopped_at: string;
};
```

- 已是 `idle` → `ok: true`，`system_proxy_restored` 反映实际恢复结果（幂等）。
- `force: true` 时若 5s 内未退出则强杀，`details.forced = true`。

错误：`RUNTIME_STOP_TIMEOUT`、`RUNTIME_EXITED`。

---

### 4.4 `RuntimeRestart`

```json
{
  "type": "object",
  "properties": {
    "reason": { "type": "string", "maxLength": 120 }
  },
  "additionalProperties": false
}
```

`data`：

```ts
type RuntimeRestartData = {
  state: RuntimeState;
  pid: number;
  restarted_at: string;
};
```

- `idle` 时等价于 `RuntimeStart`。
- `starting` / `restarting` 时返回 `RUNTIME_BUSY`。

---

### 4.5 `RuntimeLogs`

```json
{
  "type": "object",
  "properties": {
    "lines": { "type": "integer", "minimum": 1, "maximum": 500, "default": 200 },
    "level": { "type": "string", "enum": ["debug", "info", "warn", "error"] }
  },
  "additionalProperties": false
}
```

`data`：

```ts
type RuntimeLogsData = {
  lines: string[];              // 已脱敏，最新在末尾
  truncated: boolean;
  redacted_fields: string[];    // 被替换的键名，例 ["uuid","password"]
};
```

脱敏规则见 `runtime.md` §5.6。

---

### 4.6 `CoreListVersions`

```json
{ "type": "object", "properties": {}, "additionalProperties": false }
```

`data`：

```ts
type InstalledRuntime = {
  upstream_version: string;
  state: "active" | "standby" | "quarantined";
  installed_at: string;
  path_hint: string;             // 只给目录名，不给绝对路径
};

type AvailableRuntime = {
  upstream_version: string;
  platform: string;
  arch: string;
  size: number;
  published_at: string;
};

type CoreListVersionsData = {
  active_version: string | null;
  installed: InstalledRuntime[];
  available: AvailableRuntime[];
  manifest_source: "bundled" | "remote_cache";
  manifest_stale: boolean;
};
```

> P1 清单内置在应用里，`manifest_source` 恒为 `bundled`；远程清单是 P2。

---

### 4.7 `CoreInstall`

```json
{
  "type": "object",
  "properties": {
    "version": { "type": "string", "pattern": "^[0-9]+\\.[0-9]+\\.[0-9]+$" },
    "channel": { "type": "string", "enum": ["stable"], "default": "stable" }
  },
  "required": ["version"],
  "additionalProperties": false
}
```

`data`：

```ts
type CoreInstallData = {
  job_id: string;
  stage: "downloading";
};
```

异步：立即返回 `job_id`，进度经 `job-progress` 事件推送（`events.md` §3.2），也可用 `JobGet` 轮询。

错误：`UNSUPPORTED`（平台无该版本）、`RUNTIME_VERSION_UNSUPPORTED`。

**无确认点**：安装会直接下载并执行二进制，没有确认卡。见 §2.1.1 的风险记录。

安装阶段：`downloading → verifying → unpacking → probing → activating → done`。

---

### 4.8 `CatalogSearch`

```json
{
  "type": "object",
  "properties": {
    "region": { "type": "string", "pattern": "^[a-z]{2}$" },
    "protocol": { "type": "string", "enum": ["vless_reality", "hysteria2"] },
    "limit": { "type": "integer", "minimum": 1, "maximum": 50, "default": 10 },
    "cursor": { "type": "string" }
  },
  "additionalProperties": false
}
```

`data`：

```ts
type CatalogSearchData = {
  nodes: NodeSummary[];          // 见 catalog.md §3.2，无凭据
  next_cursor: string | null;
  fetched_at: string;
  stale: boolean;                // true 表示来自缓存
};
```

错误：`CATALOG_UNAVAILABLE`、`RATE_LIMITED`、`DEVICE_TOKEN_INVALID`。

**安全要求**：`NodeSummary.name` / `city` / `tags` 是外部数据，`content` 里引用时必须加引号并标注为节点名，不得作为指令解析。

---

### 4.9 `ProfileList`

```json
{ "type": "object", "properties": {}, "additionalProperties": false }
```

`data`：

```ts
type ProfileSummary = {
  profile_id: string;
  name: string;
  node_id: string | null;
  protocol: NodeProtocol | null;
  region: string | null;
  created_at: string;
  is_active: boolean;
};

type ProfileListData = {
  profiles: ProfileSummary[];
  active_profile_id: string | null;
};
```

不含任何凭据或配置原文。

---

### 4.10 `ProfileImport`

```json
{
  "type": "object",
  "properties": {
    "node_id": { "type": "string" },
    "name": { "type": "string", "maxLength": 60 }
  },
  "required": ["node_id"],
  "additionalProperties": false
}
```

`data`：

```ts
type ProfileImportData = {
  profile_id: string;
  name: string;
  protocol: NodeProtocol;
  region: string | null;
  already_existed: boolean;
};
```

- Host 内部调用 `GET /v1/catalog/nodes/{node_id}` 取完整描述；凭据只进内存与 `0600` 配置，**不进 `data`、不进 `content`**。
- 同名节点重复导入 → 返回已有 profile，`already_existed = true`。

错误：`NODE_NOT_FOUND`、`NODE_DISABLED`、`NODE_UNSUPPORTED_PROTOCOL`、`CATALOG_UNAVAILABLE`。

---

### 4.11 `VpnConnect`

```json
{
  "type": "object",
  "properties": {
    "node_id": { "type": "string" },
    "profile_id": { "type": "string" },
    "strategy": { "type": "string", "enum": ["latency"], "default": "latency" }
  },
  "additionalProperties": false
}
```

约束：`node_id` 与 `profile_id` **必须且只能提供一个**，否则 `INVALID_ARGUMENT`。

`data`：

```ts
type VpnConnectData = {
  state: "running";
  profile_id: string;
  exit_ip: string;
  latency_ms: number | null;
  upstream_version: string;
  system_proxy_enabled: boolean;
};
```

语义（按顺序）：

1. 确保运行时已安装；未安装 → `RUNTIME_NOT_INSTALLED`（**不自动安装**，安装是用户的显式决定；`next_actions` 给出 `CoreInstall`）。
2. 解析出 profile（`node_id` 时先导入或复用）。
3. 生成配置 → `sing-box check`。
4. 启动或热更新。
5. 设置系统代理（无确认点，直接执行）。
6. 通过代理查出口 IP。
7. 任一步失败：关闭系统代理，按 `docs/phase-1-technical-design.md` §6.5 分类返回。

错误：`PRECONDITION_FAILED`、`TIMEOUT`、`RUNTIME_CONFIG_INVALID`、`RUNTIME_PORT_UNAVAILABLE`、`UPSTREAM_ERROR`。

失败时的 `next_actions` 必须给出替代方案（同地区其他节点 / `DiagRun`）。

**无确认点**：直接修改系统代理，没有确认卡。见 §2.1.1 的风险记录。

---

### 4.12 `VpnDisconnect`

```json
{ "type": "object", "properties": {}, "additionalProperties": false }
```

`data`：

```ts
type VpnDisconnectData = {
  state: "idle";
  system_proxy_restored: boolean;
  disconnected_at: string;
};
```

已是 `idle` 时为幂等成功。

---

### 4.13 `DiagRun`

```json
{
  "type": "object",
  "properties": {
    "include_logs": { "type": "boolean", "default": true }
  },
  "additionalProperties": false
}
```

`data`：

```ts
type DiagCheck = {
  name: "runtime_installed" | "process_alive" | "clash_api" | "config_valid"
      | "system_proxy" | "catalog_reachable" | "exit_ip";
  ok: boolean;
  detail: string;            // 一句人类可读，已脱敏
};

type DiagReport = {
  contract_version: "1.0.8";
  generated_at: string;
  app_version: string;
  platform: "darwin" | "windows" | "linux";
  arch: string;
  runtime: RuntimeSnapshot;
  proxy: {
    backend: "macos_networksetup" | "windows_registry";
    enabled: boolean;
    server: string | null;
    backup_present: boolean;
  };
  catalog: {
    reachable: boolean;
    last_success_at: string | null;
    cache_stale: boolean;
  };
  checks: DiagCheck[];
  log_excerpt: string[];
};
```

`include_logs = false` 时 `log_excerpt` 为空数组。`log_excerpt` 同样脱敏。

---

### 4.14 `DeepseekSetupKey`

```json
{ "type": "object", "properties": {}, "additionalProperties": false }
```

`data`：

```ts
type DeepseekSetupKeyData = {
  url: string;               // 官方注册/取 Key 页
  steps: string[];           // 3–5 步，面向非技术用户
  key_prefix: "sk-";
};
```

只返回步骤，**不打开浏览器**（打开浏览器是 UI 行为，由用户点击）。

错误：`UNSUPPORTED`（离线时仍可返回步骤，不报错）。

---

### 4.15 `DeepseekSaveKey`

```json
{
  "type": "object",
  "properties": {
    "key": { "type": "string", "minLength": 20, "maxLength": 200, "sensitive": true }
  },
  "required": ["key"],
  "additionalProperties": false
}
```

`data`：

```ts
type KeyValidation = "ok" | "invalid" | "unverified";

type DeepseekSaveKeyData = {
  saved: true;
  validation: KeyValidation;          // 只回答「Key 是否有效」
  validation_detail: "insufficient_balance" | "network" | "timeout" | null;
};
```

**「存储成功」与「Key 有效性」是两件事**：

| `ok` | 含义 | `data` |
|---|---|---|
| `true` | Key 已写入本地加密文件（无论是否验证通过） | `saved: true` + `validation` |
| `false` | **只有**加密文件写入失败才为 `false` | 错误码 `SECRET_STORE` |

`validation` 三态（**只回答「Key 本身是否有效」**）：

| 值 | 含义 | Agent 必须做什么 |
|---|---|---|
| `ok` | Key 有效。验证请求返回 2xx，**或返回余额不足（Key 有效但没钱）** | 正常汇报已保存；有 `insufficient_balance` 时另行提示充值 |
| `invalid` | Key 无效：401 / 403 / 格式错误 | **必须把 invalid 作为警告明确告知用户**，不得说「已成功配置」 |
| `unverified` | 没能验证：网络不可达 / 超时 | 告知「已保存但未验证」，允许用户稍后重试验证 |

`validation_detail` 补充说明，取值与对应关系：

| `validation` | `validation_detail` | 场景 |
|---|---|---|
| `ok` | `null` | 正常 |
| `ok` | `insufficient_balance` | Key 有效，但账户余额不足 |
| `invalid` | `null` | Key 格式错或鉴权失败 |
| `unverified` | `network` / `timeout` | 没能发出验证请求 |

判定优先级：先判 Key 是否有效，再判余额；网络问题一律归 `unverified`，不猜 Key 好坏。

铁律：

- 返回的 `data`、`content`、日志、事件**一律不含 Key**。
- 验证失败**不**导致 `ok: false`，避免 Agent 反复重试导致多次写加密文件。
- `content` 必须与 `validation` **和** `validation_detail` 同时一致：
  - `invalid` → 要有「Key 无效」字样
  - `unverified` → 要有「未验证」字样
  - `insufficient_balance` → **即使 `validation = "ok"`，也要明确提示余额不足**，不能说「配置成功，可以直接用了」
- `validation` 与 `validation_detail` 不得自相矛盾：`validation = "invalid"` 时不得出现 `insufficient_balance`（余额问题说明 Key 是有效的）。

---

### 4.16 `JobGet`

```json
{
  "type": "object",
  "properties": { "job_id": { "type": "string" } },
  "required": ["job_id"],
  "additionalProperties": false
}
```

`data`：

```ts
type Job = {
  contract_version: "1.0.8";
  job_id: string;
  kind: "core_install" | "diag";
  state: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  stage: string;            // core_install: downloading|verifying|unpacking|probing|activating|done
  progress: number;         // 0.0–1.0
  message: string | null;
  result: Record<string, unknown> | null;
  error: AivpnError | null;
  created_at: string;
  updated_at: string;
};
```

错误：`NOT_FOUND`（job 不存在或已过期；job 保留 24 小时）。

---

### 4.17 `ProfileDelete`

```json
{
  "type": "object",
  "properties": {
    "profile_id": { "type": "string" }
  },
  "required": ["profile_id"],
  "additionalProperties": false
}
```

`data`：

```ts
type ProfileDeleteData = {
  profile_id: string;
  deleted: boolean;        // 实际是否发生了删除
  already_absent: boolean; // true 表示本次调用前就不存在
  active_profile_id: string | null;  // 删除完成后仍然有效的 active profile（不会被本次删除改变）
};
```

语义：

- **幂等**：profile 不存在 → `ok: true`，`deleted: false`，`already_absent: true`。
- **不允许删除 active profile**：`profile_id == active_profile_id` 时直接拒绝，返回：
  ```json
  {
    "code": "PRECONDITION_FAILED",
    "message": "当前正在使用该配置，请先断开或切换到其它节点",
    "retryable": false,
    "details": { "reason": "ACTIVE_PROFILE_IN_USE", "active_profile_id": "prf_1" }
  }
  ```
  **前置校验在执行之前完成**：命中直接返回错误，不产生任何副作用。
  
  测试断言：错误码看 `error.code == "PRECONDITION_FAILED"`，具体原因看 `error.details.reason == "ACTIVE_PROFILE_IN_USE"`。两者都要匹配。
- 删除成功后 `active_profile_id` **保持不变**（因为 active 的永远删不掉）。要换 active，走「先 `VpnDisconnect` 或 `VpnConnect` 到别的 profile」。
- 删除该 profile 关联的配置文件与 `profile-<id>.meta.json`；不删节点缓存。

实现注意：这个校验属于**业务前置条件**，必须在删除动作之前完成。

1. 给 `Tool` trait 增加可选 `precheck(input, ctx) -> Result<(), AivpnError>`，Handler 在返回 `Ask` 之前调用；
2. 在 Handler 内为 `ProfileDelete` 内联同一份检查逻辑。

必须保证：**校验失败 → 不产生任何删除副作用**。

无确认点：`PermissionLevel = Write`，直接执行。见 §2.1.1 的风险记录。

错误：`PRECONDITION_FAILED`（`details.reason = "ACTIVE_PROFILE_IN_USE"`）、`INVALID_ARGUMENT`（`profile_id` 为空）、`INTERNAL`（磁盘删除失败）。

---

## 5. 工具间协作约定

### 5.1 标准连接链路

```
CatalogSearch → ProfileImport → VpnConnect
```

`VpnConnect` **不隐式调用** `CoreInstall`：静默安装会让用户不知道自己的机器上多了一个二进制。

### 5.2 幂等矩阵

| 工具 | 重复调用行为 |
|---|---|
| `RuntimeStatus` / `CoreListVersions` / `CatalogSearch` / `ProfileList` / `JobGet` | 纯读取，天然幂等 |
| `RuntimeStart` | 已 `running` → `ok: true`，`already_running: true` |
| `RuntimeStop` / `VpnDisconnect` | 已 `idle` → `ok: true` |
| `ProfileImport` | 同节点 → 返回已有 profile，`already_existed: true` |
| `ProfileDelete` | 已不存在 → `ok: true`，`deleted: false`，`already_absent: true`；**active profile → `PRECONDITION_FAILED`** |
| `CoreInstall` | 同版本已在装或已装 → `CONFLICT`，`details.job_id` 指向进行中的任务 |
| `VpnConnect` | 已连同一节点 → `ok: true`，不重复设置代理 |

### 5.3 超时预算

| 工具 | 同步超时 |
|---|---|
| 只读工具 | 3s |
| `RuntimeStart` | 15s（含 10s 启动） |
| `VpnConnect` | 30s |
| `RuntimeStop` / `VpnDisconnect` | 10s |
| `CoreInstall` | 立即返回 `job_id` |

同步工具超过预算返回 `TIMEOUT` + `retryable: true`，不要无限等待。

---

## 6. 与现有文档的差异

| # | 位置 | 现有文档写法 | 本契约写法 | 理由 |
|---|---|---|---|---|
| 1 | `phase-1-technical-design.md` §4.4 | 自造 `ToolResult { ok, summary, data, next_actions }` | 真实 `ToolResult` 是 `{ content, is_error, metadata, images }`；我们的信封放 `metadata.aivpn` | 现有写法与实际 crate API 不符，按它实现无法编译 |
| 2 | 同上 §4.3 | `fn name(&self) -> &str { "VpnConnect" }` | 一致（PascalCase），但其他章节写 snake_case（`vpn_connect`） | 统一为 PascalCase，与 Claurst 内置工具（`AskUserQuestion`、`CronCreate`）一致 |
| 3 | `phase-1-requirements.md` §5 | 16 个工具，`core_install` / `vpn_connect` 均需确认 | 18 个（+`AskUserQuestion`、`ProfileDelete`）；**P1 全部无确认点** | 2026-11-02 用户决定彻底移除审批，见 §2.1 |
| 4 | `phase-1-requirements.md` §5 | 有 `profile_list`、`deepseek_setup_key`、`deepseek_save_key`、`job_get` | 保留 | 但 `phase-1-technical-design.md` §4.3 的注册清单漏了这 4 个，以本契约为准 |
| 5 | `architecture.md` §4.5 | 权限矩阵带审批列 | **P1 无审批矩阵** | 用户决定移除，见 §2.1 |
| 6 | `architecture.md` §4.7 | `vpn_connect` 入参是 `profile_id` | 允许 `node_id` 或 `profile_id` 二选一 | `phase-1-technical-design.md` §5.1 用的是 `node_id`；两者都出现，合并为二选一 |
| 7 | `architecture.md` §4.2 | 工具返回带 `ok/data/summary` 顶层字段 | 顶层是 `content`，信封在 `metadata` | 同 #1 |

---

## 7. 待 PM 拍板

### 7.1 已决议

| 议题 | 决议 | 落点 |
|---|---|---|
| 结构化信封放哪 | `metadata.aivpn`；模型只读 `content` | §1 |
| `CoreInstall` 是否需要审批 | ~~恒需审批~~ → **已移除审批，直接执行**（2026-11-02 用户决定） | §2.1、§4.7 |
| `VpnConnect` 入参 | `profile_id` / `node_id` 二选一 | §4.11 |
| `ProfileList` / `DeepseekSetupKey` / `DeepseekSaveKey` / `JobGet` 是否保留 | 保留 | §3 表 |
| `ProfileDelete` 是否加入 P1 | **加入**，`Write`、**无确认点**；不存在时幂等 `ok: true`；**不允许删 active profile**，命中直接 `PRECONDITION_FAILED` | §3 表第 18 行、§4.17 |
| `VpnConnect` 审批粒度 | ~~会话内首次~~ → **已移除审批，直接执行** | §2.1、§3.2 |
| `DeepseekSaveKey` 的 `ok` 语义 | **存储成功即 `ok: true`**；Key 有效性用 `data.validation` 表达，且 **`validation` 只回答 Key 是否有效**——余额不足归 `validation = "ok"` + `validation_detail = "insufficient_balance"` | §4.15 |
| `next_actions` 点击语义 | 等价于用户发一条消息给 Agent，**不由 UI 直接执行** | §1.3 |
| `args_preview` 是否保留 | 保留，**默认展示非敏感字段**；`sensitive` / 黑名单字段打码；脱敏后无可展示字段才省略 | §2.5 |
| 无 AI 模式的来源校验 | Host 边界注入 `source: "ui" \| "agent"`，不可由参数传入；P1 不因来源不同而改变执行路径 | §2.2 |

### 7.2 仍需 PM 决定

**无。** 工具层的开放问题已全部收敛。

其他三份的开放项也已关闭：`runtime.md` §10.2 只剩一个**待实测**项（`POST /close` 是否在 sing-box 1.14 可用，Bob W1 验证，不是待拍板）；`catalog.md` §11.2 为「无」；`events.md` §8.2 为「无」。

---

## 8. 变更记录

### 1.0.8（2026-11-02，用户决定移除审批）

> 本版本原计划为 D-13 / D-14 的审批流程重构（工具内阻塞等待 + `approval_state` 列），**未发布即撤回**。用户决定**彻底移除审批机制**，改为默认放行。
>
> 若将来恢复审批，有两条已验证的结论可以省时间：**(1)** 不能用 `CancellationToken` 终止 turn —— 它会被 UI 渲染成「用户主动取消」；**(2)** SQLite 不支持修改已存在的 CHECK 约束，想用 `-1` 表示 pending 必须重建表，加独立列则只需一行 `ALTER TABLE ADD COLUMN`。

| # | 变更 | 类型 | 决议来源 |
|---|---|---|---|
| 1 | `contract_version` 升到 `1.0.8` | 元数据 | PM |
| 2 | **移除全部审批机制**：删除 `ApprovalPolicy`、`ApprovalScope`、`ApprovalGrant`、`approval_id`、两阶段审批协议 | 移除 | 用户：「把权限卡的逻辑全部去掉，默认就是 bypass」 |
| 3 | 工具总表删除 `ApprovalPolicy` 列 | 表结构 | 同上 |
| 4 | `CoreInstall` / `ProfileDelete` / `VpnConnect` **不再有确认点** | 行为变更 | 同上 |
| 5 | `tool_calls.approved` 列**保留**，P1 恒为 `NULL`，含义改为「审批机制不适用」；将来恢复审批不必改 schema | 保留 | 同上 |
| 6 | 新增 §2.1.1「已知产品风险」，记录无拦截点下误判/误触/下载执行的后果 | 新增 | PM：风险要留痕 |

### 1.0.7（2026-11-02）

| # | 变更 | 类型 |
|---|---|---|
| 1 | `contract_version` 升到 `1.0.7` | 元数据 |
| 2 | 无接口变更；与 events / runtime / catalog 保持版本一致 | 同步 |

### 1.0.6（2026-11-02，用户要求）

| # | 变更 | 类型 | 决议来源 |
|---|---|---|---|
| 1 | `contract_version` 升到 `1.0.6` | 元数据 | 用户 |
| 2 | Key 存储从系统钥匙串改为本地加密文件 `<data_dir>/secrets.enc`（AES-256-GCM，机器绑定）。涉及 §3 表第 15 行、§4.15 的三处「钥匙串」表述 | 实现约束 | 用户：正式版不能弹系统密码框 |
| 3 | 「钥匙串写入失败」的错误码由 `INTERNAL` 改为 `SECRET_STORE` | 错误码 | 同上 |

### 1.0.5（2026-11-02，PM 定案）

| # | 变更 | 类型 | 决议来源 |
|---|---|---|---|
| 1 | `contract_version` 升到 `1.0.5` | 元数据 | PM |
| 2 | `ProfileDelete` **拒绝删除 active profile**：前置校验在审批之前执行，命中返回 `PRECONDITION_FAILED` + `details.reason = "ACTIVE_PROFILE_IN_USE"`，不产生 `approval_id`、不发 `approval-requested` | 语义定案 | PM 决议 1 |
| 3 | `ProfileDelete` 删除成功后 `active_profile_id` 保持不变（active 永远删不掉） | 澄清 | PM 决议 1 |
| 4 | `DeepseekSaveKey`：`insufficient_balance` 归入 `validation = "ok"`，语义为「Key 有效但余额不足」；补充 `validation` 与 `validation_detail` 的对应关系表与优先级 | 语义定案 | PM 决议 2 |
| 5 | 幂等矩阵同步更新 `ProfileDelete` 一行 | 同步 | PM 决议 1、2 |

### 1.0.4（2026-11-02，PM 定案）

| # | 变更 | 类型 | 决议来源 |
|---|---|---|---|
| 1 | `contract_version` 升到 `1.0.4` | 元数据 | PM |
| 2 | **`args_preview` 语义改正**：默认展示所有非敏感字段，命中 `sensitive` / 黑名单的字段打码，只有**脱敏后无任何可展示字段**时才省略整个 preview | 语义修正 | PM 修正 1 |
| 3 | `tool_calls.approved = 2` 明确覆盖「同会话内第二次及以后由 Grant 自动放行」的调用 | 审计语义 | PM 修正 2 |
| 4 | 补 4 组 `args_preview` 示例（`VpnConnect` / `DeepseekSaveKey` / `CatalogSearch` / `ProfileDelete`） | 澄清 | PM 修正 1 |

### 1.0.3（2026-11-02，PM 定案）

| # | 变更 | 类型 | 决议来源 |
|---|---|---|---|
| 1 | `contract_version` 升到 `1.0.3` | 元数据 | PM |
| 2 | 修正 1.0.1 变更记录第 1 条的笔误（「升到 1.0.2」→「升到 1.0.1」） | 笔误 | PM |
| 3 | 新增 `ProfileDelete`（第 18 个工具）：`Write` + `always`，不存在时幂等 `ok: true` | 新增工具 | PM 决议 2 |
| 4 | `DeepseekSaveKey` 输出改为 `saved` + `validation` 三态，`ok: false` 只用于存储失败 | 语义变更 | PM 决议 3 |
| 5 | `CoreInstall` 明确为 `always` + scope `call`，不做会话内放行 | 确认 | PM 决议 1 |
| 6 | `next_actions` 点击 = 用户发消息给 Agent，UI 不得直接执行工具 | 语义定案 | PM 决议 4 |
| 7 | 新增 §2.5：`args_preview` 按 `sensitive: true` 脱敏；未声明则省略；补兜底黑名单 | 新增约束 | PM 决议 5 |
| 8 | 新增 §2.4：调用来源 `source: "ui" \| "agent"` 由 Host 通道注入，不可由参数传入 | 新增约束 | PM 决议 6 |
| 9 | §3 工具表补「破坏性工具」说明；`Phase-1` 工具总数 17 → 18 | 澄清 | PM 决议 2、6 |

### 1.0.2（2026-11-02，用户拍板）

| # | 变更 | 类型 | 决议来源 |
|---|---|---|---|
| 1 | `contract_version` 升到 `1.0.2` | 元数据 | 用户 |
| 2 | 新增 `ApprovalScope`（`call` / `session`），明确 `ApprovalGrant` 与 `approval_id` 是两个层级 | 新增 | 用户决议 1 |
| 3 | `ApprovalGrant` 只存内存、按 `session_id` 隔离、会话结束清空；不使用 Claurst 的 allow-rule 持久化 | 新增约束 | 用户决议 1 |
| 4 | `VpnConnect` 审批由「待定」定格为 `first_time_per_session` | 定案 | 用户决议 1 |
| 5 | `APPROVAL_REQUIRED.details` 增加 `tool` / `scope` / `session_id` | 字段新增 | 用户决议 1 |
| 6 | `tool_calls.approved` 由布尔改为三值：`0` 拒绝 / `1` 允许一次 / `2` 允许本会话 | 字段变更 | 用户决议 1 |

### 1.0.1（2026-11-02，PM 审核通过）

| # | 变更 | 类型 | 决议来源 |
|---|---|---|---|
| 1 | `contract_version` 全量升到 `1.0.1` | 元数据 | PM |
| 2 | `VpnConnect` 的 `ApprovalPolicy` 由 `first_time_per_session` 改为 **待定**，新增 §3.2 说明如何在不写死的前提下实现 | 解冻 | PM 决议 5 |
| 3 | `ToolResult` 真实形状 + `metadata.aivpn` 映射维持 1.0.0 结论 | 确认 | PM 决议 1 |
| 4 | `CoreInstall` 恒需审批维持 1.0.0 结论 | 确认 | PM 决议 4 |

### 1.0.0（2026-11-02，初版）

首次冻结：17 个工具、信封、权限与审批、幂等矩阵、超时预算。
