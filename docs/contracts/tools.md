# 契约：P1 工具清单

> 契约版本：`3.2.1`
> 状态：已定稿（批 0 + 批 3，2026-11-04）
> 上游：`docs/contracts/commands.md` 2.0.0、`docs/contracts/runtime.md` 2.0.0、`docs/capabilities.md`
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

统一约定：字段 **snake_case**、时间 **ISO 8601 UTC + `Z`**（落库实体的时间字段为 Unix 毫秒，见 `commands.md` §1.5）、错误码 **大写下划线**。

> **3.0.0 的模型变化**：`profile`（一个节点 = 一条配置）换成 `config`（一套方案）+ `node`（一台服务器）。工具名与入参同步改名，旧名**不保留别名**。命令与工具的对应关系见 `commands.md` §12。

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
  contract_version: "3.0.0";
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
| `VpnConnect` | 直接修改系统代理 / 路由 | 无拦截点 |
| `ConfigDelete` | 直接删除一套配置（含其节点关系与问题记录） | 无拦截点 |
| `RouteSetMode` | 跨家族切换会断开并重连（需显式确认） | 会短暂断网 |

**唯一的约束来自 `PermissionLevel`**：Claurst 用它区分「只读 / 非只读」，只读工具（`RuntimeStatus`、`CatalogSearch`、`ConfigList`、`ConfigDetail`、`NodeProbe`、`ProxyParams`、`IssueList`、`IssueGet`、`JobGet`、`RuntimeLogs`、`CoreListVersions`、`DiagRun`、`DeepseekSetupKey`、`NetConfigGet`、`DefaultProfileStatus`、`RouteGet`、`RuleCustomList`、`CategoryList`、`RulesStatus`）在 `PermissionMode::Default` 下直接允许；其余工具由 Host 的 `PermissionHandler` 一律返回 `Allow`。

不再存在的东西：

- `ApprovalPolicy` / `ApprovalScope` / `ApprovalGrant`
- `approval_id`、审批卡、`APPROVAL_REQUIRED`
- 「本会话内首次确认」「每次确认」这类策略

`tool_calls.approved` 列**保留**，P1 恒为 `NULL`，表示「审批机制不适用」。保留原因是将来若要恢复审批，不需要再改 schema。

#### 2.1.1 已知产品风险（用户已知情并接受）

> 这一节记录的是**用户明确接受的取舍**，不是疏忽。后来者若要重新引入审批，从这里读起。

去掉拦截点后，以下情况没有任何保护：

1. **模型误判**：Agent 把「看看现在什么状态」理解成「连上节点」，`VpnConnect` 会直接改系统代理，用户来不及阻止。
2. **参数误传**：模型构造的 `node_id` / `config_id` 有误时，`ConfigDelete` 会直接删掉一套配置，没有确认步骤。
3. **误触**：UI 上的删除按钮点错，立即生效，没有「确定要删除吗」。
4. **下载执行**：`CoreInstall` 直接下载并运行一个来自网络的二进制。虽然有 SHA256 校验与签名清单，但那防的是「内容被篡改」，不防「Agent 决定装了一个用户没想要的版本」。

P1 的定位是「早期内测、使用者是开发者本人」，这些风险在可接受范围内。**对外发布前需要重新评估**——尤其是 `CoreInstall` 与 `ConfigDelete`。

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
| `VpnConnect` | `{ "config_id": "cfg_1a2b" }` | `{ "config_id": "cfg_1a2b" }` |
| `NodeSwitch` | `{ "config_id": "cfg_1a2b", "node_id": "nod_3c4d" }` | `{ "config_id": "cfg_1a2b", "node_id": "nod_3c4d" }` |
| `DeepseekSaveKey` | `{ "key": "sk-abc…" }` | **省略**（唯一字段被打码） |
| `CatalogSearch` | `{ "region": "jp", "limit": 10 }` | `{ "region": "jp", "limit": 10 }` |
| `ConfigDelete` | `{ "config_id": "cfg_1a2b" }` | `{ "config_id": "cfg_1a2b" }` |
| `NodeCreate` | `{ "name": "洛杉矶", "server": "203.0.113.7", "port": 8388, "method": "aes-256-gcm", "password": "…" }` | 其余字段展示，`password` 显示为 `"***"` |

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
| 8 | `CatalogSearch` | `CatalogSearchTool` | 查询**远端**节点目录（不含本地导入） | `ReadOnly` | 只读 |
| 9 | `ConfigList` | `ConfigListTool` | 列**本地**全部配置 | `ReadOnly` | 只读 |
| 10 | `ConfigDetail` | `ConfigDetailTool` | 一套配置的节点集、DNS、端口、布局 | `ReadOnly` | 只读 |
| 11 | `ConfigCreate` | `ConfigCreateTool` | 新建一套配置（种子 / 空 / 指定节点） | `Write` | 中 |
| 12 | `ConfigUpdate` | `ConfigUpdateTool` | 编辑配置（名称 / 分流 / DNS / 端口 / 节点集） | `Write` | 中 |
| 13 | `ConfigDelete` | `ConfigDeleteTool` | 删除一套配置 | `Write` | 中 |
| 14 | `NodeImportUrl` | `NodeImportUrlTool` | 从订阅 URL 解析并导入节点 | `Write` | 中 |
| 15 | `NodeCreate` | `NodeCreateTool` | 手动创建一个节点 | `Write` | 中 |
| 16 | `NodeSwitch` | `NodeSwitchTool` | 切换某套配置的当前节点 | `Execute` | 中 |
| 17 | `NodeProbe` | `NodeProbeTool` | 测试单个节点连通性（D6） | `ReadOnly` | 只读 |
| 18 | `VpnConnect` | `VpnConnectTool` | 连接 + 设置系统代理 / TUN | `Execute` | 高 |
| 19 | `VpnDisconnect` | `VpnDisconnectTool` | 断开 + 恢复系统代理 | `Write` | 中 |
| 20 | `ProxyParams` | `ProxyParamsTool` | 本机代理地址与端口（A5） | `ReadOnly` | 只读 |
| 21 | `ProbeRun` | `ProbeRunTool` | 连接后四项探测，失败登记问题 | `Write` | 低 |
| 22 | `IssueList` | `IssueListTool` | 列出问题记录 | `ReadOnly` | 只读 |
| 23 | `IssueGet` | `IssueGetTool` | 单条问题的诊断包 | `ReadOnly` | 只读 |
| 24 | `IssueHandoff` | `IssueHandoffTool` | 把问题转交 AI 会话 | `Write` | 低 |
| 25 | `IssueResolve` | `IssueResolveTool` | 复测通过后标记已解决 | `Write` | 低 |
| 26 | `IssueIgnore` | `IssueIgnoreTool` | 忽略 / 恢复问题 | `Write` | 低 |
| 27 | `DiagRun` | `DiagRunTool` | 一键诊断 | `ReadOnly` | 只读 |
| 28 | `DeepseekSetupKey` | `DeepseekSetupKeyTool` | 给出注册/取 Key 步骤 | `ReadOnly` | 低 |
| 29 | `DeepseekSaveKey` | `DeepseekSaveKeyTool` | 保存 Key 到本地加密文件 | `Write` | 中 |
| 30 | `JobGet` | `JobGetTool` | 查询长任务 | `ReadOnly` | 只读 |
| 31 | `AskUserQuestion` | （Claurst 内置） | 向用户提问 | `None` | 低 |
| 32 | `NetConfigGet` | `NetConfigGetTool` | 读取系统代理 / DNS / 路由 / 监听端口 | `ReadOnly` | 只读 |
| 33 | `NetRepair` | `NetRepairTool` | 受限修复：恢复直连 / 刷 DNS / 只改 Veyl 自己的代理 | `Execute` | 高 |
| 34 | `CatalogRefresh` | `CatalogRefreshTool` | 拉取并应用默认配置包 | `Write` | 中 |
| 35 | `DefaultProfileStatus` | `DefaultProfileStatusTool` | 种子版本与状态 | `ReadOnly` | 只读 |
| 36 | `RouteGet` | `RouteGetTool` | 分流模式、目标、自定义规则、生效状态 | `ReadOnly` | 只读 |
| 37 | `RouteSetMode` | `RouteSetModeTool` | 切换分流模式（A↔B 热切） | `Execute` | 中 |
| 38 | `RouteTargetsSet` | `RouteTargetsSetTool` | 设置「指定服务」分类集合 | `Write` | 中 |
| 39 | `RuleCustomList` | `RuleCustomListTool` | 列自定义分流规则 | `ReadOnly` | 只读 |
| 40 | `RuleCustomAdd` | `RuleCustomAddTool` | 追加一条自定义规则 | `Write` | 中 |
| 41 | `RuleCustomDelete` | `RuleCustomDeleteTool` | 删除一条自定义规则 | `Write` | 中 |
| 42 | `CategoryList` | `CategoryListTool` | 分类目录（I1） | `ReadOnly` | 只读 |
| 43 | `RulesStatus` | `RulesStatusTool` | 规则数据版本与新鲜度 | `ReadOnly` | 只读 |
| 44 | `RulesUpdate` | `RulesUpdateTool` | 更新规则数据（未连接时排队） | `Write` | 中 |

> `AskUserQuestion` 由 `claurst-tools` 提供，Veyl 只负责注册与 UI 渲染，不重写。

**破坏性工具（destructive）**：`CoreInstall`、`ConfigDelete`、`VpnConnect`（会改系统代理或路由）、`NetRepair`（会改系统网络设置）。**均无确认点**，直接执行；风险评估见 §2.1.1。

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
    // 2.0：配置与节点
    Box::new(ConfigListTool::new(store.clone())),
    Box::new(ConfigDetailTool::new(store.clone())),
    Box::new(ConfigCreateTool::new(store.clone(), seed.clone())),
    Box::new(ConfigUpdateTool::new(store.clone())),
    Box::new(ConfigDeleteTool::new(store.clone())),
    Box::new(NodeImportUrlTool::new(store.clone(), secrets.clone())),
    Box::new(NodeCreateTool::new(store.clone(), secrets.clone())),
    Box::new(NodeSwitchTool::new(rt.clone(), store.clone())),
    Box::new(NodeProbeTool::new(rt.clone(), store.clone())),
    Box::new(VpnConnectTool::new(rt.clone(), store.clone(), proxy.clone())),
    Box::new(VpnDisconnectTool::new(rt.clone(), proxy.clone())),
    Box::new(ProxyParamsTool::new(rt.clone(), store.clone())),
    Box::new(ProbeRunTool::new(rt.clone(), store.clone())),
    // 2.0：问题管理
    Box::new(IssueListTool::new(store.clone())),
    Box::new(IssueGetTool::new(store.clone())),
    Box::new(IssueHandoffTool::new(store.clone(), agent.clone())),
    Box::new(IssueResolveTool::new(store.clone(), rt.clone())),
    Box::new(IssueIgnoreTool::new(store.clone())),
    // 诊断与其它
    Box::new(DiagRunTool::new(rt.clone(), proxy.clone(), store.clone())),
    Box::new(DeepseekSetupKeyTool::new()),
    Box::new(DeepseekSaveKeyTool::new(keychain.clone())),
    Box::new(JobGetTool::new(jobs.clone())),
    Box::new(AskUserQuestionTool::new()),  // claurst-tools
    Box::new(NetConfigGetTool::new(proxy.clone())),
    Box::new(NetRepairTool::new(proxy.clone(), rt.clone())),
    Box::new(CatalogRefreshTool::new(seed.clone(), store.clone(), secrets.clone())),
    Box::new(DefaultProfileStatusTool::new(store.clone())),
    // 批 3：分流与 DNS
    Box::new(RouteGetTool::new(store.clone(), rt.clone())),
    Box::new(RouteSetModeTool::new(store.clone(), rt.clone())),
    Box::new(RouteTargetsSetTool::new(store.clone())),
    Box::new(RuleCustomListTool::new(store.clone())),
    Box::new(RuleCustomAddTool::new(store.clone())),
    Box::new(RuleCustomDeleteTool::new(store.clone())),
    Box::new(CategoryListTool::new(rules.clone())),
    Box::new(RulesStatusTool::new(rules.clone())),
    Box::new(RulesUpdateTool::new(rules.clone(), rt.clone())),
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
| `idle` | `VpnConnect`（若已有配置）/ `ConfigCreate` |
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
    "config_id": { "type": "string" }
  },
  "additionalProperties": false
}
```

- `config_id` 省略时用当前 active 配置；没有任何配置 → `PRECONDITION_FAILED / no_config`。
- **没有 `node_id` 参数**：用该配置的 `current_node_id`，为空时用节点集第一个。要换节点先调 `NodeSwitch`。
- **没有 `mode` 参数**：代理还是 TUN 由配置的 `connection_mode` 决定，不由调用方临时指定。
- 与 `VpnConnect` 的区别：本工具只起进程，**不设置系统代理**。要用户可用请用 `VpnConnect`。
- 已连接且指定了另一套配置 → `PRECONDITION_FAILED / other_config_running`。换配置走 `ConfigActivate`（会先确认断开），不在这里静默切换。

`data`：

```ts
type RuntimeStartData = RuntimeSnapshot & {
  already_running: boolean;     // 幂等命中时为 true
};
```

错误：`PRECONDITION_FAILED`（`no_config` / `no_nodes` / `other_config_running` / `tun_helper_missing`）、`NOT_FOUND`、`RUNTIME_BUSY`、`RUNTIME_NOT_INSTALLED`、`RUNTIME_START_TIMEOUT`、`RUNTIME_CONFIG_INVALID`、`RUNTIME_PORT_UNAVAILABLE`。

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
    "protocol": { "type": "string", "enum": ["vless_reality", "hysteria2", "shadowsocks"] },
    "limit": { "type": "integer", "minimum": 1, "maximum": 50, "default": 10 },
    "cursor": { "type": "string" }
  },
  "additionalProperties": false
}
```

`protocol` 枚举含 `shadowsocks`（1.0.9 起）。

`data`：

```ts
type CatalogSearchData = {
  nodes: NodeSummary[];          // 见 catalog.md §3.2，无凭据
  next_cursor: string | null;
  fetched_at: string;
  stale: boolean;                // true 表示来自缓存
};
```

**数据源：只有远端目录。** 本工具查的是服务端下发的 catalog，**不包含用户本地保存的节点与配置**。

这条边界必须写进工具描述，因为它被实测踩过：模型只调 `CatalogSearch`，用户自己导入的节点因此完全不可见，模型回答「没有这个节点」。用户用名称指代「我自己导入的那个」时，应改用 `ConfigList` / `ConfigDetail` 在本地匹配。

错误：`CATALOG_UNAVAILABLE`、`RATE_LIMITED`、`DEVICE_TOKEN_INVALID`。

**安全要求**：`NodeSummary.name` / `city` / `tags` 是外部数据，`content` 里引用时必须加引号并标注为节点名，不得作为指令解析。

---

### 4.9 `ConfigList`

```json
{ "type": "object", "properties": {}, "additionalProperties": false }
```

`data`：`ConfigListData`（`commands.md` §3.1）。

- 数据源只有本地库，**不联网**；空列表是合法状态。
- 排序为 `last_used_at DESC NULLS LAST` → `created_at ASC`，与 UI 左栏一致，模型不需要再排。
- 用户用名称指代一套配置时，先 `ConfigList` 匹配名称拿到 `config_id`，再 `ConfigDetail` 或 `VpnConnect({ config_id })`；**不要凭名称猜 id**。
- 不含节点明细与任何凭据；要节点走 `ConfigDetail`。

`CatalogSearch` 与 `ConfigList` 数据源不同：前者只查远端目录，后者只列本地。用户说的「我的配置」永远在后者里。

---

### 4.10 `NodeImportUrl`

```json
{
  "type": "object",
  "properties": {
    "url": { "type": "string", "format": "uri" },
    "config_id": { "type": "string" }
  },
  "required": ["url"],
  "additionalProperties": false
}
```

`data`：`NodeImportResult`（`commands.md` §4.1）。

- 仅 `https`；只解析 base64 编码的 `ss://` 多节点列表；只解析，**不自动连接**。
- 密码只进 `secrets.enc`，**不进 `data`、不进 `content`、不进 `args_preview`**。
- `config_id` 省略时只把节点放进池子，不绑定任何配置。
- 解析结果必须**复述给用户确认**，尤其是 `method` 与 `port`——这两个错了连不上但看不出原因。

错误：`INVALID_ARGUMENT`（`insecure_url`、`invalid_url`、`not_subscription`）、`NOT_FOUND`、`UPSTREAM_ERROR`、`TIMEOUT`、`SECRET_STORE`。

---

### 4.11 `VpnConnect`

```json
{
  "type": "object",
  "properties": {
    "config_id": { "type": "string" }
  },
  "additionalProperties": false
}
```

约束：

- `config_id` 省略 → 用 active 配置；没有任何配置 → `PRECONDITION_FAILED / no_config`。
- **没有 `node_id` 参数**：用该配置的 `current_node_id`，为空时用节点集第一个。要指定节点先调 `NodeSwitch`（未连接时只改选择，连接中则热切），再调本工具。
- 节点集为空 → `PRECONDITION_FAILED / no_nodes`。

`data`：

```ts
type VpnConnectData = {
  state: "running";
  config_id: string;
  node_id: string;
  exit_ip: string | null;        // null = 已连接但出口尚未测到，不是失败
  latency_ms: number | null;
  upstream_version: string;
  system_proxy_enabled: boolean; // tun 模式恒为 false
};
```

语义（按顺序）：

1. 确保运行时已安装；未安装 → `RUNTIME_NOT_INSTALLED`（**不自动安装**；`next_actions` 给出 `CoreInstall`）。
2. 解析配置与节点。
3. 生成配置 → `sing-box check`；`connection_mode = "tun"` 时先确认特权助手可用，否则 `PRECONDITION_FAILED / tun_helper_missing`。
4. 启动或热更新。
5. 设置系统代理（`system_proxy` 模式；无确认点，直接执行）。
6. 异步探测出口 IP（**不阻塞返回**；未测到时 `exit_ip` 为 `null`，后台测到后经健康事件推给 UI）。
7. 任一步失败：关闭系统代理，按 `docs/phase-1-technical-design.md` §6.5 分类返回。

**连接是否成功只看 `state`，不看 `exit_ip`。**

> `latency_ms` 的语义固定为**出口 IP 探测的往返耗时**，与 `runtime.md` §2.5 的同名字段同源。
> 它不是「到节点的 ping / 握手延迟」——那个指标属于 `NodeProbe.latency_ms`，**不同的字段、不同的命令**。两个含义共用一个名字，会让状态面板的数字无法解释。

| 字段 | 含义 |
|---|---|
| `state = "running"` | 已连上。**这是唯一判定依据** |
| `exit_ip = null` | 已连接，出口 IP 还没测到。**不代表连接失败**，可用 `RuntimeStatus` 再查 |

把「出口未知」判成失败，会让模型在连接其实好着的时候反复重连、换节点，用户看到的是「明明能用却被反复断开」。因此工具描述里必须原句写明这条。

出口 IP 的探测方式：经本地 mixed 入站代理发一次 HTTP 请求，响应体必须是**合法 IP 字面量**才回填；门户页、错误串、`host:port`、多行内容一律丢弃，`exit_ip` 保持 `null`。探测失败只记日志，**不改运行时状态**。

错误：`PRECONDITION_FAILED`、`NOT_FOUND`、`TIMEOUT`、`RUNTIME_CONFIG_INVALID`、`RUNTIME_PORT_UNAVAILABLE`、`UPSTREAM_ERROR`。

失败时的 `next_actions` 必须给出替代方案（同配置的其他节点 / `DiagRun`）。

**无确认点**：直接修改系统代理或路由，没有确认卡。见 §2.1.1 的风险记录。

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
type DiagGroup = "app" | "system" | "network" | "config";

type DiagAction =
  | { kind: "reconnect" }
  | { kind: "refresh_seed" }
  | { kind: "restore_network" }
  | { kind: "switch_config" }
  | { kind: "flush_dns" }
  | { kind: "open_seed" };

type DiagCheck = {
  // 稳定标识：<group>.<check>，一旦发布不得改名
  name:
    // app
    | "app.runtime_installed" | "app.process_alive" | "app.version"
    | "app.config_valid" | "app.clash_api" | "app.data_plane"
    // system
    | "system.proxy_services" | "system.dns" | "system.default_route"
    // network
    | "network.exit_ip" | "network.reachable_default_source"
    | "network.reachable_github" | "network.reachable_deepseek"
    // config
    | "config.current_config" | "config.seed" | "config.seed_stale";
  group: DiagGroup;
  ok: boolean;
  detail: string;              // 实测值或失败原因，已脱敏
  remediation: string | null;  // 一句建议动作；无需动作时为 null
  action: DiagAction | null;   // 可直接渲染成按钮的动作
};

type DiagReport = {
  contract_version: "3.0.0";
  generated_at: string;
  app_version: string;
  platform: "darwin" | "windows" | "linux";
  arch: string;
  runtime: RuntimeSnapshot;
  summary: {
    total: number;
    ok: number;
    failed: number;
    verdict: string;           // 一句话结论，由 Host 生成，模型可改写
  };
  groups: Array<{ group: DiagGroup; label: string; checks: DiagCheck[] }>;
  checks: DiagCheck[];         // 扁平版，顺序与 groups 展开一致，便于模型读
  log_excerpt: string[];
};
```

`include_logs = false` 时 `log_excerpt` 为空数组。`log_excerpt` 同样脱敏。

**3.0.0 的改名**（因为这些标识从未对外发布，直接改，不保留旧值）：

| 2.0 之前 | 3.0.0 |
|---|---|
| `refresh_default_profile` | `refresh_seed` |
| `switch_profile` | `switch_config` |
| `open_default_profile` | `open_seed` |
| `config.current_profile` | `config.current_config` |
| `config.default_package` | `config.seed` |
| `config.package_stale` | `config.seed_stale` |

**相对 1.0.x 的扩展（1.1.0）**：

| 变化 | 说明 |
|---|---|
| `checks[].name` 从裸名改为 `<group>.<check>` | 旧值与新值的映射见下表；**旧值不再返回** |
| 新增 `group` / `remediation` / `action` | 需求 §8.3 要求「每项都有 ok / detail / remediation」 |
| 新增 `summary` | UI 直接渲染结论，不必自己数 |
| 新增 `groups` | 按分组渲染；`checks` 保留扁平版给模型 |
| **移除** `proxy` / `catalog` 两个子对象 | 它们的字段已并入 `system.proxy_services` / `network.reachable_default_source` 与 `config.*` 的 check 里。保两份会互相打架 |

旧名 → 新名映射：

| 1.0.x | 1.1.0 |
|---|---|
| `runtime_installed` | `app.runtime_installed` |
| `process_alive` | `app.process_alive` |
| `clash_api` | `app.clash_api` |
| `config_valid` | `app.config_valid` |
| `system_proxy` | `system.proxy_services` |
| `catalog_reachable` | `network.reachable_default_source` |
| `exit_ip` | `network.exit_ip` |

**`remediation` 的写法约束**：

- 一句祈使句，面向非技术用户，例：「点『恢复网络』撤掉代理后再试」。
- 不得包含凭据、完整路径、内网地址。
- 无动作可说时写 `null`，不要写「无」「N/A」这类占位。

**`action` 与 `remediation` 的关系**：`action` 是 `remediation` 的可点击形式，两者要么都为空，要么同时有值且语义一致。UI 只渲染 `action`，模型读 `remediation`。

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
  contract_version: "3.0.0";
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

### 4.17 `ConfigDelete`

```json
{
  "type": "object",
  "properties": {
    "config_id": { "type": "string" }
  },
  "required": ["config_id"],
  "additionalProperties": false
}
```

`data`：`ConfigDeleteData`（`commands.md` §3.4）。

- **幂等**：配置不存在 → `ok: true`，`deleted: false`，`already_absent: true`。
- **正在连接的配置不能删**：`PRECONDITION_FAILED`，`details.reason = "connected"`。Host 不替用户断网；模型应先用 `VpnDisconnect`，或换一套配置。
- **active 但未连接时可以删**：删除后 `active_config_id = null`，回到空态。这是「不设不可删除特例」的直接结果（`docs/configs-and-nav.md` §2.1）。
- 级联删除该配置的节点关系、布局与**配置范围内的问题记录**；节点本身留在共享池里，不删。
- 删除前**不做**任何磁盘清理之外的动作；错误码看 `error.code`，具体原因看 `error.details.reason`。

> 2.0 之前这里叫 `ProfileDelete`，且不允许删除 active。那条规则属于单节点模型：active 就是唯一配置，删了就没有任何东西可用。新模型允许空态，空态本身有「新建配置」的出口。

无确认点：`PermissionLevel = Write`，直接执行。见 §2.1.1 的风险记录。

错误：`PRECONDITION_FAILED`（`connected`）、`INVALID_ARGUMENT`（`config_id` 为空）、`INTERNAL`。

---

### 4.18 `NetConfigGet`（1.1.0 新增）

纯只读。用于解释「为什么连不上」，不修改任何系统设置。

```json
{ "type": "object", "properties": {}, "additionalProperties": false }
```

`data`：

```ts
type ProxyEntry = { enabled: boolean; server: string | null; port: number | null };

type NetConfigData = {
  platform: "darwin" | "windows" | "linux";
  proxies: Array<{
    service: string;                 // macOS 网络服务名 / Windows 连接名
    http: ProxyEntry;
    https: ProxyEntry;
    socks: ProxyEntry;
  }>;
  dns: {
    servers: string[];
    probe_domain: string;            // 固定 "platform.deepseek.com"
    resolvable: boolean;
  };
  route: {
    default_interface: string | null;
    default_gateway: string | null;
  };
  interfaces: Array<{ name: string; addresses: string[]; up: boolean }>;
  listeners: Array<{ port: number; loopback_only: boolean; process: string | null }>;
};
```

边界（**必须实现**，否则这个工具会变成「系统侦察器」）：

- `listeners` 只列**回环地址上处于 LISTEN 的端口**，最多 50 条，按端口升序。不列外网监听、不列已建立连接。
- `interfaces` 只给名称、地址与 up 状态，**不给 MAC、不给 DHCP 租约、不给 Wi-Fi SSID**。
- 所有地址可以原样返回——它们是本机地址，不是凭据；但不得写入日志。

错误：`UNSUPPORTED`（平台后端不支持时）、`INTERNAL`。

---

### 4.19 `NetRepair`（1.1.0 新增）

**受限写**。只允许四种动作，不做通用 shell。

```json
{
  "type": "object",
  "properties": {
    "action": {
      "type": "string",
      "enum": ["restore_direct", "flush_dns", "set_proxy", "clear_proxy"]
    },
    "port": { "type": "integer", "minimum": 1024, "maximum": 65535 }
  },
  "required": ["action"],
  "additionalProperties": false
}
```

| action | 行为 | 是否需要 `port` |
|---|---|---|
| `restore_direct` | 撤掉 Veyl 设置的系统代理并恢复备份 → 停运行时 → 删渲染配置 → 不带代理探测一次出口 IP | 否（给 `port` 按 `INVALID_ARGUMENT` 拒绝） |
| `flush_dns` | macOS：`dscacheutil -flushcache` + `killall -HUP mDNSResponder`；Windows：`ipconfig /flushdns`。**不动代理、不停运行时** | 否 |
| `set_proxy` | 把系统代理指向 **Veyl 自己的** mixed 端口 | **必填** |
| `clear_proxy` | 撤掉系统代理并恢复备份（不停运行时），等价于 `restore_direct` 的第 1 步 | 否 |

`data`：

```ts
type NetRepairData = {
  ok: boolean;
  action: "restore_direct" | "flush_dns" | "set_proxy" | "clear_proxy";
  detail: string;            // 一句完成说明，不含凭据
  exit_ip: string | null;    // 仅 restore_direct 后带直连出口；其余为 null
  verified: boolean;         // 动作后复读系统设置，是否与预期一致
};
```

**三条硬约束**：

1. **任何写动作前必须已有可回滚快照**。`set_proxy` 在动手前先 `capture()` 并落备份；没有备份就不许写。
2. **动作后必须复读校验**，`verified` 反映校验结果。`verified = false` 时 `ok` 也必须为 `false` —— 「命令返回成功但设置没生效」是最难排查的故障，不能算成功。
3. `set_proxy` 的 `port` **必须等于当前运行时的 mixed 端口**；不相等一律 `INVALID_ARGUMENT`（`details.reason = "port_not_owned"`）。这条防止工具被用来把用户流量导向任意本地服务。

**工具描述里必须原句包含**：`不要用本工具修改与 Veyl 无关的网络配置。`

权限：`Execute`。无确认点（见 §2.1.1）。

错误：`PRECONDITION_FAILED`（`details.reason = "no_rollback_snapshot"`）、`INVALID_ARGUMENT`（`port_not_owned` / `port_required`）、`UNSUPPORTED`、`INTERNAL`。

---

### 4.20 `CatalogRefresh`（1.1.0 新增）

拉取并应用默认配置包（需求 §6.2）。

```json
{
  "type": "object",
  "properties": { "force": { "type": "boolean", "default": false } },
  "additionalProperties": false
}
```

`data`：

```ts
type CatalogRefreshData = {
  changed: boolean;                // 本次是否真的应用了新包
  offline: boolean;                // true = 拉取失败但沿用了本地缓存
  package_id: string | null;
  version: string | null;          // source_updated_at 或 package_hash 前 8 位
  applied_at: string | null;       // ISO 8601
  node_count: number;
  new_version_available: boolean;
  detail: string;
};
```

语义：

- **不打断在线连接**（需求 §6.5）：新包只写库与加密文件，下一次连接才生效。正在连接时返回 `new_version_available = true`，`detail` 写明「下次连接生效」。
- **有可用缓存时，拉取失败不算错误**：返回 `ok`、`offline = true`、`changed = false`，`detail` 写成「离线，沿用本地缓存（上次更新 X 天前）」。这是需求 R13「不打扰用户」的落点。
- **无任何可用缓存且拉取失败** → 返回错误 `UPSTREAM_ERROR`，`retryable = true`，`details.hint` 必须用需求 R20 的话术：**「现在无法访问默认配置源，这在未连接时是正常的。请先导入本地配置文件并连接，再检查更新。」**
- `force = true` 时跳过「6 小时内不重复拉取」的节流。
- **`package_hash` 不是哈希**，实测是发布方的版本标签（如 `seed-dynamic-tag-test-20260313`）。**不要用它做校验，也不要在日志或返回值里写「哈希校验通过」**。完整性判断用客户端对**原始响应体**算的 `content_sha256`（只用于「与上次是否相同」，不可对外展示）。
- 结构校验：必填字段齐全；`status != "active"` 的包拒绝应用（需求 §6.4）。

权限：`Write`（改本地缓存与加密包，不改系统网络）。

错误：`UPSTREAM_ERROR`、`INVALID_ARGUMENT`（包结构不符，`details.reason = "package_invalid"`）、`SECRET_STORE`。

---

### 4.21 `DefaultProfileStatus`

纯只读，**不联网**。2.0 起数据源是 `veyl_seed.json`。

```json
{ "type": "object", "properties": {}, "additionalProperties": false }
```

`data`：`DefaultProfileResult`（`commands.md` §8.1）。要点：

```ts
type DefaultProfileStatusData = {
  seed_id: "veyl_seed";
  version: string | null;          // 文件里的 version，仅展示
  content_sha256: string | null;   // 判断是否变化的唯一依据
  node_count: number;
  applied_at: number | null;       // Unix 毫秒
  checked_at: number | null;       // Unix 毫秒
  new_version_available: boolean;
};
```

- `version` 是**给人看的**；变化判定永远看 `content_sha256`——`version` 要人手动改，「改了文件忘了改版本号」正是 TweetPilot 那次事故的根因。
- `stale` 概念取消：是否该刷新由 Host 的定时器与「连接失败且当前用种子节点」两条规则决定，不需要模型判断。
- `applied_at` 是「最近一次被用于建立配置的时刻」，不是拉取时刻；拉取时刻在 `checked_at`。
- 若 `version` 为 `null`（文件没写），照常工作。

权限：`ReadOnly`。

---

### 4.22 `AskUserQuestion`（Claurst 内置，1.2.0 起接通）

Veyl **不重写**这个工具，只负责接线。工具实现与 schema 由 `claurst-tools` 提供（`crates/tools/src/lib.rs:109-116`）。

行为：

| 项 | 内容 |
|---|---|
| 阻塞 | 调用后整个查询循环暂停，直到用户作答、超时或请求结束 |
| 通道 | `UserQuestionEvent { question, options, reply_tx }` → `ask-user-question` 事件（`events.md` §4.8） |
| 回答 | 用户通过 `reply_user_question` 回传；`answer` 必须是 `options` 之一，空串 = 跳过 |
| 超时 | 300 秒未答 → Host 代回空串（等同跳过） |
| 多选 | **不支持**（Claurst 通道本身不支持） |

**`options` 必须非空，且每一项都是非空字符串**：`options` 缺失、为空数组、或含全空白项时，**不发事件**，直接把这次工具调用以 `INVALID_ARGUMENT` 结束。

> 为什么：我们的回答校验是「空串，或必须是 `options` 之一」。空 `options` 配合这条规则，会让任何非空回答都被拒——问题实际上无法回答，只能跳过。与其把这种情况显示给用户，不如当场告诉模型"请带上选项再问"。

这与 `tools.md` §3 表格里「Veyl 只负责注册与 UI 渲染」一致；本节补充的是**接通之后的可观测行为**。

---

### 4.23 `ConfigDetail`

```json
{
  "type": "object",
  "properties": { "config_id": { "type": "string" } },
  "required": ["config_id"],
  "additionalProperties": false
}
```

`data`：`ConfigDetail`（`commands.md` §3.0），含 `nodes` / `dns` / `tun_excludes` / `layout`。

- 节点按配置内顺序返回，**不重排**。
- **不含密码**；要判断连通性用 `NodeProbe`，不要试图从详情里推断。
- 配置不存在 → `NOT_FOUND`。

权限：`ReadOnly`。

---

### 4.24 `ConfigCreate`

```json
{
  "type": "object",
  "properties": {
    "name": { "type": "string", "maxLength": 40 },
    "connect_mode": { "type": "string", "enum": ["system_proxy", "tun"] },
    "routing_mode": { "type": "string", "enum": ["direct", "proxy_all", "proxy_selected"] },
    "targets": { "type": "array", "items": { "type": "string" } },
    "source": { "type": "string", "enum": ["seed", "empty"] },
    "node_ids": { "type": "array", "items": { "type": "string" } },
    "listen_port": { "type": "integer", "minimum": 1000, "maximum": 65535 },
    "dns": { "type": "object" },
    "tun_excludes": { "type": "array", "items": { "type": "string" } }
  },
  "required": ["name", "connect_mode", "routing_mode"],
  "additionalProperties": false
}
```

`data`：`ConfigDetail`。

- `source = "seed"` 绑定**当前种子的全部节点**；种子为空 → `PRECONDITION_FAILED / seed_unavailable`。与 `node_ids` 互斥。
- `source = "empty"` 或不传 → 创建空节点集的配置；可以存在，但 `VpnConnect` 会报 `no_nodes`。
- `routing_mode = "proxy_selected"` 时必须传 `targets`（非空，分类 id 有效），否则 `PRECONDITION_FAILED / route_targets_empty`。
- `listen_port` 只允许 `system_proxy`；`tun` 传了 → `INVALID_ARGUMENT / listen_port_not_allowed`。
- **连接方式不给默认值**：`system_proxy` 与 `tun` 是两种接管方式，模型必须显式选。
- 未连接时新建的配置会自动成为 active；已连接时不自动切换（与 `commands.md` §3.2 一致）。

`next_actions`：创建成功后给出 `VpnConnect`（一级/二级）或 `ProxyParams`（三级）。

错误：`INVALID_ARGUMENT`、`CONFLICT`（`duplicate_name`）、`NOT_FOUND`、`PRECONDITION_FAILED`、`UNSUPPORTED`。

---

### 4.25 `ConfigUpdate`

```json
{
  "type": "object",
  "properties": {
    "config_id": { "type": "string" },
    "name": { "type": "string", "maxLength": 40 },
    "routing_mode": { "type": "string", "enum": ["direct", "proxy_all", "proxy_selected"] },
    "targets": { "type": "array", "items": { "type": "string" } },
    "listen_port": { "type": "integer", "minimum": 1000, "maximum": 65535 },
    "dns": { "type": "object" },
    "tun_excludes": { "type": "array", "items": { "type": "string" } },
    "node_ids": { "type": "array", "items": { "type": "string" } }
  },
  "required": ["config_id"],
  "additionalProperties": false
}
```

`data`：`ConfigDetail`。

- **没有 `connect_mode`**：改接管方式必须新建配置。带上 → `INVALID_ARGUMENT / connect_mode_immutable`。
- `node_ids` 是**整体替换**，不是增量追加；顺序即新顺序。
- 修改不打断当前连接，下一次连接生效。
- 意图是「换节点」而不是「换节点集」时，用 `NodeSwitch`，不要用本工具。

错误：`INVALID_ARGUMENT`、`NOT_FOUND`、`CONFLICT`、`UNSUPPORTED`。

---

### 4.26 `NodeCreate`

```json
{
  "type": "object",
  "properties": {
    "name": { "type": "string", "maxLength": 64 },
    "server": { "type": "string" },
    "port": { "type": "integer", "minimum": 1, "maximum": 65535 },
    "method": { "type": "string" },
    "password": { "type": "string", "sensitive": true, "maxLength": 256 },
    "config_id": { "type": "string" }
  },
  "required": ["name", "server", "port", "method", "password"],
  "additionalProperties": false
}
```

`data`：`NodeSummary`（`commands.md` §3.0）。

- `password` 标 `sensitive`，`args_preview` 里打码；返回值与 `content` 永不含密码。
- 手动模式允许私网地址（用户可能连自己的内网服务器）。
- `config_id` 指定时追加到该配置；不指定只进节点池。
- 不自动连接、不触发探测。

错误：`INVALID_ARGUMENT`（`invalid_name` / `invalid_server` / `invalid_port` / `unsupported_method` / `invalid_password`）、`NOT_FOUND`、`SECRET_STORE`。

---

### 4.27 `NodeSwitch`

```json
{
  "type": "object",
  "properties": {
    "config_id": { "type": "string" },
    "node_id": { "type": "string" }
  },
  "required": ["config_id", "node_id"],
  "additionalProperties": false
}
```

`data`：`NodeSwitchData`（`commands.md` §4.3）。

| 当前状态 | 行为 |
|---|---|
| 未连接 | 只改 `current_node_id`；**不启动 VPN** |
| 已连接、这套配置正在跑 | selector 热切换，进程不重启 |
| 已连接、但不是这套配置 | `PRECONDITION_FAILED / config_not_running` |
| 节点不属于该配置 | `NOT_FOUND / node_not_in_config` |

- **「选中」不是「切换」**：模型不要为了「看看别的节点」调用本工具——那会真的改出口。
- 热切换失败 → `PRECONDITION_FAILED / runtime_switch_failed`，`current_node_id` 不变。
- 不要用 `VpnConnect` 表达切换：它没有 `node_id` 参数；换节点只走 `NodeSwitch`，未连接时不会启动 VPN。

错误：`NOT_FOUND`、`PRECONDITION_FAILED`、`TIMEOUT`。

---

### 4.28 `NodeProbe`（D6）

```json
{
  "type": "object",
  "properties": { "node_id": { "type": "string" } },
  "required": ["node_id"],
  "additionalProperties": false
}
```

`data`：`NodeProbeData`（`commands.md` §4.4）。

- 已连接且测的是当前节点 → 走 Clash delay，测的是**真实可用性**（含密码与加密方式）。
- 其余情况 → TCP 握手，只能说明端口活着。
- **节点不可达不是工具错误**：返回 `ok: true` + `reachable: false` + `error`。只有 `node_id` 不存在才是 `Err`。
- 不登记问题（J1）：单节点手动测试失败不等于用户被阻断。

权限：`ReadOnly`。

---

### 4.29 `ProxyParams`（A5）

```json
{ "type": "object", "properties": {}, "additionalProperties": false }
```

`data`：`ProxyParams`（`commands.md` §4.5）。

- 三级用户问「填什么地址」时用它；`host` 恒为 `127.0.0.1`，`protocols` 恒为 HTTP + SOCKS5 同端口。
- `port_source = "runtime"` 时才是可用的实际端口；`pending` 时**不要编一个端口给用户**。
- `reason = "tun_mode"` 时说明当前配置不需要代理地址，不要引导用户去填。

权限：`ReadOnly`。

---

### 4.30 `ProbeRun`

```json
{
  "type": "object",
  "properties": {
    "config_id": { "type": "string" },
    "targets": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "label": { "type": "string" },
          "url": { "type": "string" }
        },
        "required": ["label", "url"],
        "additionalProperties": false
      }
    }
  },
  "additionalProperties": false
}
```

`data`：`ProbeReport`（`commands.md` §5.1）。

- 固定顺序：DNS → 出口 IP → 出口与直连不同 → 各 target 可达。
- `targets` 的服务名到 URL 的翻译由模型用分类目录（I1）完成，Host 不猜。
- 失败会登记/合并问题；`issue_ids` 给出对应记录，模型可以用 `IssueGet` 取证据。
- 未连接 → `PRECONDITION_FAILED / not_running`。这不是诊断工具，是连接后的验证。

---

### 4.31 `IssueList`（J2）

```json
{
  "type": "object",
  "properties": {
    "state": { "type": "string", "enum": ["open", "handed_off", "resolved", "ignored"] },
    "severity": { "type": "string", "enum": ["P0", "P1", "P2"] },
    "config_id": { "type": "string" },
    "limit": { "type": "integer", "minimum": 1, "maximum": 200, "default": 50 },
    "offset": { "type": "integer", "minimum": 0, "default": 0 }
  },
  "additionalProperties": false
}
```

`data`：`{ issues: IssueSummary[], total }`。

- 排序 `severity ASC`（P0 在前）→ `last_seen` 降序。
- 不返回证据；要证据用 `IssueGet`。
- 问题列表的展示**不依赖 AI**，模型只是读取者。

权限：`ReadOnly`。

---

### 4.32 `IssueGet`（J2）

```json
{
  "type": "object",
  "properties": { "issue_id": { "type": "string" } },
  "required": ["issue_id"],
  "additionalProperties": false
}
```

`data`：`IssueDetail`（`commands.md` §6.0），含脱敏后的 `evidence` 与 `actions`。

- 不存在 → `NOT_FOUND`。
- `evidence` 是采集时保存的，不是现在现采——它反映问题发生时的状态。

权限：`ReadOnly`。

---

### 4.33 `IssueHandoff`（J3）

```json
{
  "type": "object",
  "properties": {
    "issue_id": { "type": "string" },
    "session_id": { "type": "string" }
  },
  "required": ["issue_id"],
  "additionalProperties": false
}
```

`data`：`IssueHandoffData`（`commands.md` §6.3）。

- 一次性投喂诊断包，不做多轮追问。
- 没有可用 provider → `PRECONDITION_FAILED / no_provider`。
- 已有转交会话时复用；`session_id` 可显式指定。
- **投喂的不是凭据**：内容与 `IssueGet.evidence` 完全一致。

---

### 4.34 `IssueResolve`（J4）

```json
{
  "type": "object",
  "properties": { "issue_id": { "type": "string" } },
  "required": ["issue_id"],
  "additionalProperties": false
}
```

`data`：`IssueResolveData`（`commands.md` §6.4）。

- **模型说「修好了」不算数**：Host 自己复测，通过才 `resolved`。
- 复测失败返回 `ok: true` + `verified: false`，不是错误。
- 不可复测的权限类问题只校验前置条件。

---

### 4.35 `IssueIgnore`（J4）

```json
{
  "type": "object",
  "properties": {
    "issue_id": { "type": "string" },
    "ignored": { "type": "boolean", "default": true }
  },
  "required": ["issue_id"],
  "additionalProperties": false
}
```

`data`：`IssueIgnoreData`（`commands.md` §6.5）。

- `ignored = false` 表示恢复为 `open`，不是删除。
- 幂等。

---

### 4.36 `RouteGet`（G1）

```json
{ "type": "object", "properties": { "config_id": { "type": "string" } }, "additionalProperties": false }
```

`data`：`RouteState`（`commands.md` §10.0）。

- `applied_mode` / `applied_revision` 取自 `RuntimeSnapshot`，不是从库里推。
- 只读，不联网。用户问「我现在怎么分的」时用它，不要从 `ConfigDetail` 猜。

权限：`ReadOnly`。

---

### 4.37 `RouteSetMode`（G2）

```json
{
  "type": "object",
  "properties": {
    "config_id": { "type": "string" },
    "mode": { "type": "string", "enum": ["direct", "proxy_all", "proxy_selected"] },
    "confirm_reconnect": { "type": "boolean", "default": false }
  },
  "required": ["mode"],
  "additionalProperties": false
}
```

`data`：`RouteSetModeData`（`commands.md` §10.0）。

- `direct` ↔ `proxy_all` 且已连接 → selector 热切，不断流。
- 涉及 `proxy_selected` 的跨家族切换 → 未带 `confirm_reconnect` 时返回 `PRECONDITION_FAILED / will_disconnect`；**必须先问用户**，得到同意后再带 `true` 调一次。不得自行重试。
- 该工具会改网络；即使没有确认点，模型也应在调用前用一句话说明会断一下（§2.1.1）。
- 跨家族的确认一句话要包含两点：会断开并自动重连、**域名解析方式也会改变**（`routing.md` §6.4）。

---

### 4.38 `RouteTargetsSet`（G4）

```json
{
  "type": "object",
  "properties": {
    "config_id": { "type": "string" },
    "categories": { "type": "array", "items": { "type": "string" } }
  },
  "required": ["config_id", "categories"],
  "additionalProperties": false
}
```

`data`：`RouteState`。

- 分类 id 先用 `CategoryList` 查；**不要把用户说的服务名直接当 id**。
- `dns_classifiable = false` 的分类不能用（`UNSUPPORTED`）。
- 不热切，`effective = "next_connection"`。

---

### 4.39 `RuleCustomList`（G4）

```json
{ "type": "object", "properties": { "config_id": { "type": "string" } }, "required": ["config_id"], "additionalProperties": false }
```

`data`：`{ rules: CustomRule[] }`（`commands.md` §10.0）。

权限：`ReadOnly`。

---

### 4.40 `RuleCustomAdd`（G4）

```json
{
  "type": "object",
  "properties": {
    "config_id": { "type": "string" },
    "action": { "type": "string", "enum": ["proxy", "direct"] },
    "match_type": { "type": "string", "enum": ["domain", "domain_suffix", "domain_keyword", "ip_cidr", "category"] },
    "value": { "type": "string" },
    "note": { "type": "string" }
  },
  "required": ["config_id", "action", "match_type", "value"],
  "additionalProperties": false
}
```

`data`：`CustomRule`。

- 用户说「让某个站直连 / 走 VPN」时用它；**域名可能被用户写错，先复述再写**。
- `match_type = "category"` 时 `value` 是分类 id，仍然先 `CategoryList` 解析。
- 写入后 `effective = "next_connection"`；已连接时告诉用户「下次连接生效」。

---

### 4.41 `RuleCustomDelete`（G4）

```json
{
  "type": "object",
  "properties": { "config_id": { "type": "string" }, "rule_id": { "type": "string" } },
  "required": ["config_id", "rule_id"],
  "additionalProperties": false
}
```

`data`：`{ rule_id, deleted, already_absent }`。幂等。

---

### 4.42 `CategoryList`（I1）

```json
{
  "type": "object",
  "properties": {
    "query": { "type": "string" },
    "limit": { "type": "integer", "minimum": 1, "maximum": 200, "default": 50 }
  },
  "additionalProperties": false
}
```

`data`：`{ categories: Category[], total }`（`commands.md` §10.0）。

- 把用户说的服务名翻成分类 id 的唯一入口。
- 只读，不联网，读当前生效规则版本。

权限：`ReadOnly`。

---

### 4.43 `RulesStatus`

```json
{ "type": "object", "properties": {}, "additionalProperties": false }
```

`data`：`RulesStatus`（`commands.md` §10.0）。

- 只读。用户问「规则是不是旧了」时用它；`stale` 只提示，不阻断。

权限：`ReadOnly`。

---

### 4.44 `RulesUpdate`

```json
{ "type": "object", "properties": {}, "additionalProperties": false }
```

`data`：`{ queued: boolean, job_id: string | null }`。

- **先尝试直连**（每次重新解析 DNS）：直连成功 → 异步，返回 `job_id`；直连失败且已连接 → job 内改走代理重试；直连失败且未连接 → 排队，`queued: true`。
- 未连接且直连失败时，**不要告诉用户「更新失败」**，说「连上之后会自动更新」——直连时通时不通，排队不是错误。
- 已有任务 → `CONFLICT`，不要重复调用。

---

## 5. 工具间协作约定

### 5.1 标准连接链路

```
用测试节点：    ConfigCreate(source = "seed") → VpnConnect
用我自己的节点：NodeImportUrl / NodeCreate → ConfigCreate(node_ids) → VpnConnect
换节点：        NodeSwitch
换一套方案：    ConfigCreate → ConfigActivate（UI）/ VpnConnect({ config_id })
```

`VpnConnect` **不隐式调用** `CoreInstall`：静默安装会让用户不知道自己的机器上多了一个二进制。也不隐式创建配置——没有配置时报 `no_config`，由 AI 走 `source_choice` 询问。

### 5.2 幂等矩阵

| 工具 | 重复调用行为 |
|---|---|
| `RuntimeStatus` / `CoreListVersions` / `CatalogSearch` / `ConfigList` / `ConfigDetail` / `NodeProbe` / `ProxyParams` / `IssueList` / `IssueGet` / `JobGet` | 纯读取，天然幂等 |
| `RuntimeStart` | 已 `running` 且目标一致 → `ok: true`，`already_running: true` |
| `RuntimeStop` / `VpnDisconnect` | 已 `idle` → `ok: true` |
| `ConfigCreate` | **不幂等**：同名 → `CONFLICT / duplicate_name` |
| `ConfigUpdate` | 参数与现状一致 → `ok: true`，不发事件 |
| `ConfigDelete` | 已不存在 → `ok: true`，`deleted: false`，`already_absent: true`；**正在连接 → `PRECONDITION_FAILED`** |
| `RouteSetMode` | 目标模式与当前一致 → `ok: true`，不发事件 |
| `RouteTargetsSet` | 集合与现状一致 → `ok: true`，`route_revision` 不变 |
| `RuleCustomAdd` | 同一 `(action, match_type, value)` 已存在 → `CONFLICT / duplicate_rule` |
| `RuleCustomDelete` | 已不存在 → `ok: true`，`deleted: false`，`already_absent: true` |
| `RulesUpdate` | 已有任务 → `CONFLICT`，`details.job_id` |
| `NodeImportUrl` / `NodeCreate` | 同 `(source, source_key)` → 不新建，计入 `skipped`（`duplicate`）；`data` 仍返回已有节点 |
| `NodeSwitch` | 目标就是当前节点 → `ok: true`，不发事件 |
| `CoreInstall` | 同版本已在装或已装 → `CONFLICT`，`details.job_id` 指向进行中的任务 |
| `VpnConnect` | 已连同一配置同一节点 → `ok: true`，不重复设置代理 |
| `ProbeRun` | 每次都是真实探测，不缓存；会刷新 `last_seen` |
| `IssueHandoff` | 重复转交 → 复用会话，`last_handoff_at` 刷新，计数不变 |
| `IssueResolve` / `IssueIgnore` | 状态已是目标值 → `ok: true`，不发事件 |

### 5.3 超时预算

| 工具 | 同步超时 |
|---|---|
| 只读工具 | 3s |
| `NodeProbe` | 5s（TCP 3s + 余量） |
| `NodeImportUrl` | 15s（抓取 10s + 解析） |
| `RuntimeStart` | 15s（含 10s 启动） |
| `VpnConnect` | 30s |
| `ProbeRun` | 30s（四项顺序执行） |
| `RouteGet` / `RuleCustomList` / `CategoryList` / `RulesStatus` | 3s（本地读） |
| `RouteSetMode` | 15s（热切 5s；跨家族含断开重连） |
| `RouteTargetsSet` / `RuleCustomAdd` / `RuleCustomDelete` | 3s |
| `RulesUpdate` | 立即返回 `job_id` 或 `queued` |
| `RuntimeStop` / `VpnDisconnect` | 10s |
| `CoreInstall` | 立即返回 `job_id` |

同步工具超过预算返回 `TIMEOUT` + `retryable: true`，不要无限等待。

---

## 6. 与现有文档的差异

> 本表记录 **1.x 时代**与旧文档的差异，保留作历史依据。2.0 之后的改名（profile → config/node）以 §8 的 3.0.0 变更记录为准，不再逐条回填本表。

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
| `VpnConnect` 入参 | 只有 `config_id`（省略用 active）；节点由 `NodeSwitch` 决定 | §4.11 |
| 配置 / 节点 / 问题工具的保留 | 全部保留并新增；`ProfileList` → `ConfigList`，`ProfileImport` → `NodeImportUrl`，`ProfileDelete` → `ConfigDelete` | §3 表 |
| `ConfigDelete` 是否允许删 active | **允许**（未连接时），删后回到空态；只拦「正在连接」 | §4.17 |
| `VpnConnect` 审批粒度 | ~~会话内首次~~ → **已移除审批，直接执行** | §2.1、§3.2 |
| `DeepseekSaveKey` 的 `ok` 语义 | **存储成功即 `ok: true`**；Key 有效性用 `data.validation` 表达，且 **`validation` 只回答 Key 是否有效**——余额不足归 `validation = "ok"` + `validation_detail = "insufficient_balance"` | §4.15 |
| `next_actions` 点击语义 | 等价于用户发一条消息给 Agent，**不由 UI 直接执行** | §1.3 |
| `args_preview` 是否保留 | 保留，**默认展示非敏感字段**；`sensitive` / 黑名单字段打码；脱敏后无可展示字段才省略 | §2.5 |
| 无 AI 模式的来源校验 | Host 边界注入 `source: "ui" \| "agent"`，不可由参数传入；P1 不因来源不同而改变执行路径 | §2.2 |

### 7.2 仍需 PM 决定

**无。** 工具层的开放问题已全部收敛。

其他契约的开放项：`runtime.md` §10.2 只剩一个**待实测**项（`POST /close` 是否在 sing-box 1.14 可用，Bob W1 验证，不是待拍板）；`catalog.md` §11.2 为「无」；`commands.md` §13 还剩 `seed_id` 命名与 `import_seed_file` 保留两条建议。

---

## 8. 变更记录

### 3.2.1（2026-11-04，节点来源对外叫「测试节点」）

| # | 变更 | 类型 | 决议来源 |
|---|---|---|---|
| 1 | `contract_version` 升到 `3.2.1` | 元数据 | 产品口径统一 |
| 2 | §5.1 连接链路里「用我们提供的」改为「用测试节点」；`source: "seed"` 不变 | 措辞 | 产品负责人：我们提供的节点只供测试 |

### 3.2.0（2026-11-04，批 3 修订）

| # | 变更 | 类型 | 决议来源 |
|---|---|---|---|
| 1 | `RuntimeStart` 去掉 `node_id`：切换节点只走 `NodeSwitch` | 不兼容 | PM：两个入口做同一件事 |
| 2 | `VpnConnect` 去掉 `node_id`：同一理由，避免第三个入口 | 不兼容 | 同上 |
| 3 | `RouteSetMode` 的跨家族确认补充「域名解析方式也会改变」 | 约束 | 非中国 `direct` 改本地 DNS |
| 4 | `RulesUpdate` 改为先直连、代理兜底；未连接且直连失败才排队 | 语义 | GitHub 按 IP 封、时通时不通 |

### 3.1.0（2026-11-03，批 3 · 分流与 DNS）

| # | 变更 | 类型 | 决议来源 |
|---|---|---|---|
| 1 | `contract_version` 升到 `3.1.0` | 元数据 | 批 3 |
| 2 | 新增 9 个工具：`RouteGet` / `RouteSetMode` / `RouteTargetsSet` / `RuleCustomList` / `RuleCustomAdd` / `RuleCustomDelete` / `CategoryList` / `RulesStatus` / `RulesUpdate` | 新增工具 | `routing.md` 1.0.0 |
| 3 | 工具总数 35 → 44 | 计数 | — |
| 4 | `RouteSetMode` 明确：跨家族必须先问用户，带 `confirm_reconnect` 重调；不得自行重试 | 约束 | PM 裁定 1 |
| 5 | `RulesUpdate` 未连接时返回 `queued`，不报失败 | 语义 | PM 裁定 4 |
| 6 | 只读工具列表补 4 项 | 清单 | §2.1 |

### 3.0.0（2026-11-03，批 0 · 契约与数据模型）

| # | 变更 | 类型 | 决议来源 |
|---|---|---|---|
| 1 | `contract_version` 升到 `3.0.0` | 元数据 | 数据单位从 profile 换成 config + node |
| 2 | `ProfileList` → `ConfigList`，`ProfileImport` → `NodeImportUrl`，`ProfileDelete` → `ConfigDelete` | 改名 | `commands.md` 2.0.0 |
| 3 | 新增 `ConfigDetail` / `ConfigCreate` / `ConfigUpdate` / `NodeCreate` / `NodeSwitch` / `NodeProbe` / `ProxyParams` / `ProbeRun` | 新增工具 | 批 0 契约；`capabilities.md` A5 / B2 / B4 / D6 / K1–K5 |
| 4 | 新增 `IssueList` / `IssueGet` / `IssueHandoff` / `IssueResolve` / `IssueIgnore` | 新增工具 | `issue-management.md` J2–J4 |
| 5 | `VpnConnect` 入参 `profile_id` → `config_id`，新增 `node_id`；删除 `strategy`（没有第二种取值） | 不兼容 | 新模型 |
| 6 | `VpnConnect` 不再有「用默认配置包」的隐式回退；没有配置报 `no_config` | 行为变更 | 不静默替用户选线路 |
| 7 | `ConfigDelete` 允许删未连接的 active 配置 | 行为变更 | 新模型允许空态，且空态有新建出口 |
| 8 | `DefaultProfileStatus` 改为种子模型（`seed_id` / `content_sha256` / 毫秒时间） | 不兼容 | `veyl_seed.json` |
| 9 | 工具总数 22 → 35 | 计数 | — |
| 10 | 注册清单同步更新；破坏性工具改为 `CoreInstall` / `ConfigDelete` / `VpnConnect` / `NetRepair` | 清单 | §3.1 |

> 只读工具的判定以 §2.1 的列表为准；`NodeProbe` 与 `ProxyParams` 是只读，即使它们会发起网络请求。

### 1.2.0（2026-11-03，AskUserQuestion 接通）

| # | 变更 | 类型 | 决议来源 |
|---|---|---|---|
| 1 | `contract_version` 升到 `1.2.0` | 元数据 | PM |
| 2 | 新增 §4.22：`AskUserQuestion` 从「只注册」变为「可观测行为」，写明阻塞、超时、空选项处理 | 补充 | 产品负责人：AI 主动提问 |
| 3 | 工具形状未变（仍是 Claurst 内置），本文件只补行为说明 | 说明 | — |

### 1.1.0（2026-11-02，P1.5 wave1 → wave2 契约）

| # | 变更 | 类型 | 决议来源 |
|---|---|---|---|
| 1 | `contract_version` 升到 `1.1.0` | 元数据 | PM |
| 2 | 新增 `NetConfigGet`（只读）—— 系统代理逐服务、DNS、路由、接口、回环监听 | 新增工具 | 需求 §8.4 |
| 3 | 新增 `NetRepair`（受限写，四种动作）—— 每条写动作前必须有回滚快照，动作后必须复读校验 | 新增工具 | 需求 §8.4 |
| 4 | 新增 `CatalogRefresh` / `DefaultProfileStatus` —— 默认配置包的拉取与状态 | 新增工具 | 需求 §6.2、§6.6 |
| 5 | `DiagRun` 输出扩展：`checks[].name` 改为 `<group>.<check>`；新增 `group` / `remediation` / `action` / `summary` / `groups`；移除 `proxy` / `catalog` 子对象 | 结构变更 | 需求 §8.3 |
| 6 | 工具总数 18 → 22；破坏性工具增加 `NetRepair` | 计数 | 同上 |

**为什么 `DiagRun` 的输出是破坏性变更却只升 minor**：`checks[].name` 的取值改变了，但字段本身仍在，消费方是模型与尚未实现的 UI。旧值到新值的映射表已写在 §4.13，实现方按表迁移即可。若将来有外部消费方依赖旧值，届时再用 `schema` 字段做版本分流。

**与 `commands.md` 的对应**：`net_repair` 这条 invoke 与 `NetRepair` 工具**共用同一份实现**，动作集合也一致（四种）；UI 只用其中 `restore_direct` / `flush_dns` 两种。

### 1.0.10（2026-11-02）

| # | 变更 | 类型 |
|---|---|---|
| 1 | `contract_version` 升到 `1.0.10` | 元数据 |
| 2 | 无接口变更；与 events 的 `import_seed_file` 同步版本 | 同步 |
| 3 | `CatalogSearch` 描述明确「只查远端目录，不含本地导入配置」 | 语义澄清 |
| 4 | `ProfileList` 描述明确「列本地已保存配置（含种子导入）」；补充两工具数据源对照表 | 语义澄清 |
| 5 | `VpnConnectData.exit_ip` 由 `string` 改为 `string \| null` —— 实现早已可能返回 `null`，契约此前写窄了 | 类型修正 |
| 6 | `VpnConnect` 明确「`state = running` 即已连上；`exit_ip = null` 不代表失败」；补充出口 IP 探测方式 | 语义澄清 |

> 第 3–6 条是**文档追平已实现行为**，不是新增接口。1.0.10 尚未提交、尚未对外冻结，故不再单开 1.0.11；四个契约文件保持同版本号。若 1.0.10 在本次改动前已经被人拿去实现，则应升 1.0.11 —— 实际情况是四处改动都能在 `src-tauri/src/tools/` 里找到对应代码。

### 1.0.9（2026-11-02，N-03）

| # | 变更 | 类型 |
|---|---|---|
| 1 | `contract_version` 升到 `1.0.9` | 元数据 |
| 2 | `CatalogSearch` 入参的 `protocol` 枚举增加 `shadowsocks` | 枚举扩展 |

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
