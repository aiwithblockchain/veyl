# 契约：P1 工具清单

> 契约版本：`3.21.3`
> 状态：已定稿（批 0 + 批 3，2026-11-04）
> 上游：`docs/contracts/commands.md`、`docs/contracts/runtime.md`（版本以各自文件头为准）、`docs/capabilities.md`
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

统一约定：字段 **snake_case**、时间 **ISO 8601 UTC + `Z`**（落库实体的时间字段为 Unix 毫秒，见 `commands.md` §1.5）、错误码 **大写下划线**。本文件里所有 `contract_version` 的字面量恒等于本文件版本（当前 `3.21.0`）；实现侧只允许有一个常量对应本文件。

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
  contract_version: "3.20.1";
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
- **`ToolEnvelope` 不含 `display`**：用户文案只走 `tool-call-end.display`（`events.md` §3.4），不塞进模型可见的信封。

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
| `VpnConnect` | 直接修改系统代理 / 路由 | 无拦截点 |
| `ConfigDelete` | ~~直接删除一套配置~~ | **3.18.0 已移出工具集**，见 §4.17 |
| `RouteSetMode` | 跨家族切换会断开并重连（需显式确认） | 会短暂断网 |

**唯一的约束来自 `PermissionLevel`**：Claurst 用它区分「只读 / 非只读」，只读工具（`RuntimeStatus`、`CatalogSearch`、`ConfigDetail`、`JobGet`、`RuntimeLogs`、`CoreListVersions`、`DiagRun`、`DeepseekSetupKey`、`NetConfigGet`、`DefaultProfileStatus`、`RouteGet`、`CategoryList`、`RulesStatus`、`OpenSettings`、`MyServers`、`MyServerFailure`、`CatalogOptions`）在 `PermissionMode::Default` 下直接允许；其余工具（含 2.45.2 起的 `NodeProbe`：探不通时可能停隧道）由 Host 的 `PermissionHandler` 一律返回 `Allow`。

不再存在的东西：

- `ApprovalPolicy` / `ApprovalScope` / `ApprovalGrant`
- `approval_id`、审批卡、`APPROVAL_REQUIRED`
- 「本会话内首次确认」「每次确认」这类策略

`tool_calls.approved` 列**保留**，P1 恒为 `NULL`，表示「审批机制不适用」。保留原因是将来若要恢复审批，不需要再改 schema。

#### 2.1.1 已知产品风险（用户已知情并接受）

> 这一节记录的是**用户明确接受的取舍**，不是疏忽。后来者若要重新引入审批，从这里读起。

去掉拦截点后，以下情况没有任何保护：

1. **模型误判**：Agent 把「看看现在什么状态」理解成「连上节点」，`VpnConnect` 会直接改系统代理，用户来不及阻止。
2. **参数误传**：模型构造的 `node_id` / `config_id` 有误时，动作可能落到错误的节点上。`ConfigDelete` 这条路径已在 3.18.0 随工具一起移除。
3. **误触**：UI 上的删除按钮点错，立即生效，没有「确定要删除吗」。
4. **下载执行**：`CoreInstall` 直接下载并运行一个来自网络的二进制。虽然有 SHA256 校验与签名清单，但那防的是「内容被篡改」，不防「Agent 决定装了一个用户没想要的版本」。
   - **3.4.0 已消解**：`CoreInstall` 移出工具集，下载/升级/回滚只能由用户在设置页显式触发（`commands.md` §7.10）。模型不再有这条路径。

P1 的定位是「早期内测、使用者是开发者本人」，这些风险在可接受范围内。**对外发布前需要重新评估**——`ConfigDelete` 已于 3.18.0 移除，剩下最重的是 `VpnConnect` 与 `NetRepair`。

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

### 2.4 面向用户的表达

工具卡片、模型正文、`ai-status` 文案都会把内部词带到用户面前。规则**写死在系统提示与工具 description 两处**，且内容同一套：

| 落点 | 文件 | 管什么 |
|---|---|---|
| 系统提示正文 | `resources/prompts/zh/first-run.md`「怎么说话」 | 全部风格规则 |
| 安全底线 | `src-tauri/src/claurst_session/mod.rs` 的 `SAFETY_RULES` | 两句底线：正文不出现内部名词/标识符；失败必须说清有没有改动 |
| 工具 description | 各 `src-tauri/src/tools/*.rs` 的 `description()` | 只补该工具「结果怎么说、失败改没改」，通用规则不重复 |

`capability_catalog` 只取 description 的**第一行**进系统提示清单，完整 description 作为工具 schema 交给模型。所以「对用户说…」这类句子放 description **末尾**：不会污染能力清单，但模型调工具时一定看得到。

规则（系统提示与工具 description 必须同时体现）：

1. **不叙述工具调用**。只说结果和影响。写「我先看一下现在的连接状态」，不写「我调用 `RuntimeStatus`」「`RuntimeStatus` 返回 ok」。
2. **正文不出现内部术语与 ID**：`proxy`、`TUN`、`分流`、`规则集`、`selector`、`入站/出站`、`runtime`、`sing-box`、工具名、字段名、错误码、`cfg_…` / `nod_…` 等 id、路径。
3. **失败三段式**：发生了什么（用户语言）→ 有没有改动（`VpnConnect` / `NetRepair` / `CoreUpgrade` / `ConfigDelete` 必须说清）→ 现在能做什么（只给一个动作）。不确定有没有改动就说「不确定，诊断日志里有记录」。
4. **长流程分阶段**，一个阶段一句；不逐步骤报，也不提前报还没发生的阶段。
5. 需要技术细节时只说「技术细节在诊断日志里」并告诉用户在哪复制；不贴字段名、错误码、原始返回。
6. **用户主动问技术问题才用术语**；第一次出现时紧跟一句白话解释。
7. 不重复界面上已经显示的内容（连接状态、出口、流量、卡片里的数字）。界面负责实时状态，模型负责解释下一步。

前端展示契约（`commands.md` §9.8）：

```ts
// src/components/toolDisplay.ts（设计文档里也称 TOOL_DISPLAY）
export const TOOL_COPY: Record<string, ToolCopy>;   // 键集合必须与 §3 的 40 个工具名完全相等
```

进行中 / 兜底的静态文案来自这张表；完成与失败的具体文案、`changed` 来自 `tool-call-end.display`（`events.md` §3.4）。映射表必须**双向**相等：少一个名字，新工具就会露出原始名；多一个名字，说明工具已删除但文案还在。`AskUserQuestion` 是 40 个之一，但**渲染层必须跳过它的工具行**——提问由 `ask-user-question` 的问答浮层承担，两处说同一件事是重复。

**提示词只降低出错概率，最终闸门在渲染层**：UI 永远不渲染工具名、JSON、错误码；不做输出正则改写（静默替换模型正文比漏一句更难排查）。

边界与落点：

- **映射表以 `docs/design/tool-display.md` 为准**；本契约只锁「40 个名字必须都有」与「`AskUserQuestion` 不占行」。
- **running 状态文案**同样来自映射表（`events.md` §3.5）：不得拼工具名，未知工具固定「正在处理…」。
- **工具 description**：通用表达约束放 `\n` 之后的末尾。`capability_catalog` 只取第一行进系统提示清单，所以第一行**不得**出现「对用户说…」这类句子，否则会污染每次请求的能力清单。
- **「怎么说话」八条与 `SAFETY_RULES` 新增两条由契约测试防回归**：删任一条即红。
- **不做输出正则改写**：拦截在渲染层，不改写生成内容。

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
| 7 | `CoreUpgrade` | `CoreUpgradeTool` | 检查并安装运行时更新（有确认点） | `Execute` | 高 |
| 8 | `CatalogSearch` | `CatalogSearchTool` | 查询**远端**节点目录（不含本地导入） | `ReadOnly` | 只读 |
| 9 | `ConfigDetail` | `ConfigDetailTool` | 一套配置的节点集、DNS、布局 | `ReadOnly` | 只读 |
| 10 | `ConfigUpdate` | `ConfigUpdateTool` | 编辑配置（名称 / 分流 / DNS / 节点集） | `Write` | 中 |
| 11 | `NodeImportUrl` | `NodeImportUrlTool` | 从订阅 URL 解析并导入节点 | `Write` | 中 |
| 12 | `NodeImportText` | `NodeImportTextTool` | 解析用户粘贴的 `ss://`（不联网） | `Write` | 中 |
| 13 | `NodeCreate` | `NodeCreateTool` | 手动创建一个节点 | `Write` | 中 |
| 14 | `NodeSwitch` | `NodeSwitchTool` | 切换某套配置的当前节点 | `Execute` | 中 |
| 15 | `NodeProbe` | `NodeProbeTool` | 测试单个节点连通性（D6） | `Write` | 中（探测只读；探不通时会停已停机销毁的隧道，2.45.2） |
| 16 | `VpnConnect` | `VpnConnectTool` | 连接 + 设置系统代理 / TUN | `Execute` | 高 |
| 17 | `VpnDisconnect` | `VpnDisconnectTool` | 断开 + 恢复系统代理 | `Write` | 中 |
| 18 | `DiagRun` | `DiagRunTool` | 一键诊断 | `ReadOnly` | 只读 |
| 19 | `DeepseekSetupKey` | `DeepseekSetupKeyTool` | 给出注册/取 Key 步骤 | `ReadOnly` | 低 |
| 20 | `DeepseekSaveKey` | `DeepseekSaveKeyTool` | 保存 Key 到本地加密文件 | `Write` | 中 |
| 21 | `JobGet` | `JobGetTool` | 查询长任务 | `ReadOnly` | 只读 |
| 22 | `AskUserQuestion` | （Claurst 内置） | 向用户提问 | `None` | 低 |
| 23 | `NetConfigGet` | `NetConfigGetTool` | 读取系统代理 / DNS / 路由 / 监听端口 | `ReadOnly` | 只读 |
| 24 | `NetRepair` | `NetRepairTool` | 受限修复：恢复直连 / 刷 DNS / 只改 Veyl 自己的代理 | `Execute` | 高 |
| 25 | `CatalogRefresh` | `CatalogRefreshTool` | 拉取并应用默认配置包 | `Write` | 中 |
| 26 | `DefaultProfileStatus` | `DefaultProfileStatusTool` | 种子版本与状态 | `ReadOnly` | 只读 |
| 27 | `RouteGet` | `RouteGetTool` | 分流模式、目标、自定义规则、生效状态 | `ReadOnly` | 只读 |
| 28 | `RouteSetMode` | `RouteSetModeTool` | 切换分流模式（A↔B 热切） | `Execute` | 中 |
| 29 | `RouteTargetsSet` | `RouteTargetsSetTool` | 设置「指定服务」分类集合 | `Write` | 中 |
| 30 | `CategoryList` | `CategoryListTool` | 分类目录（I1） | `ReadOnly` | 只读 |
| 31 | `RulesStatus` | `RulesStatusTool` | 规则数据版本与新鲜度 | `ReadOnly` | 只读 |
| 32 | `IssueReport` | `IssueReportTool` | 生成问题报告文件夹（两阶段，仅写固定目录） | `Write` | 低（只写桌面报告目录） |
| 33 | `SetUserRegion` | `SetUserRegionTool` | 记录用户所在地区（AI 唯一写入路径） | `Write` | 低（只写本地设置） |
| 34 | `MyServers` | `MyServersTool` | 我的服务器列表与状态（只读） | `ReadOnly` | 只读 |
| 35 | `ConfigSetMode` | `ConfigSetModeTool` | 在线切换接管方式（全部软件 ↔ 本机代理，**会断开重连**） | `Execute` | 高 |
| 36 | `OpenSettings` | `OpenSettingsTool` | 打开设置并指向某段/某行（**不改值**） | `ReadOnly` | 只读 |
| 37 | `MyServerFailure` | `MyServerFailureTool` | 某台服务器创建失败的详情与订单事件 | `ReadOnly` | 只读 |
| 38 | `StageSelect` | `StageSelectTool` | 把地区/规格选进新建节点舞台（**只改界面选择**） | `Write` | 低（不建机、不扣费） |
| 39 | `CatalogOptions` | `CatalogOptionsTool` | 建机目录：地区与套餐的 id / 名称 / 日价（只读） | `ReadOnly` | 只读 |
| 40 | `HttpCheck` | `HttpCheckTool` | 访问一个网页地址，只读状态码与 Cloudflare 挑战标记 | `ReadOnly` | 只读 |

> `AskUserQuestion` 由 `claurst-tools` 提供，Veyl 只负责注册与 UI 渲染，不重写。

**破坏性工具（destructive）**：`CoreUpgrade`（下载并安装运行时，**有确认点**，见 §4.45）、`ConfigSetMode`（**有确认点**，会断开重连，见 §4.49）、`VpnConnect`（会改系统代理或路由）、`NetRepair`（会改系统网络设置）。除 `CoreUpgrade` / `ConfigSetMode` 外均无确认点，直接执行；风险评估见 §2.1.1。`CoreInstall` 已在 3.4.0、`ConfigDelete` 已在 3.18.0 从工具集移除，见 §4.7 / §4.17。

**UI 专用命令不注册工具**：`core_info` / `core_check_updates` / `core_cancel_upgrade` / `core_rollback`（`commands.md` §7.10）与 `tun_helper_info` / `tun_helper_restart`（§7.8.1–§7.8.2）、`trial_status`（§7.19）。**`core_upgrade` 是例外**：模型只能经 `CoreUpgrade` 工具调用，且必须由用户逐字确认（§4.45）；确认卡由 Host 生成，模型无法伪造。

### 3.1 注册清单（照抄）

```rust
// server_catalog 是「建机目录」（地区 + 套餐）；与上面的 catalog（共享节点目录客户端）不是一个东西。
let server_catalog = services.server_catalog();
let tools: Vec<Box<dyn Tool>> = vec![
    Box::new(RuntimeStatusTool::new(rt.clone())),
    Box::new(RuntimeStartTool::new(rt.clone(), proxy.clone())),
    Box::new(RuntimeStopTool::new(rt.clone(), proxy.clone())),
    Box::new(RuntimeRestartTool::new(rt.clone(), proxy.clone())),
    Box::new(RuntimeLogsTool::new(rt.clone())),
    Box::new(CoreListVersionsTool::new(installer.clone())),
    Box::new(CoreUpgradeTool::new(installer.clone())),
    Box::new(CatalogSearchTool::new(catalog.clone())),
    // 2.0：配置与节点
    Box::new(ConfigDetailTool::new(store.clone())),
    Box::new(ConfigUpdateTool::new(store.clone())),
    Box::new(NodeImportUrlTool::new(store.clone(), secrets.clone())),
    Box::new(NodeImportTextTool::new(store.clone(), secrets.clone())),
    Box::new(NodeCreateTool::new(store.clone(), secrets.clone())),
    Box::new(NodeSwitchTool::new(rt.clone(), store.clone())),
    Box::new(NodeProbeTool::new(rt.clone(), store.clone())),
    Box::new(VpnConnectTool::new(rt.clone(), store.clone(), proxy.clone())),
    Box::new(VpnDisconnectTool::new(rt.clone(), proxy.clone())),
    // 诊断与其它
    Box::new(DiagRunTool::new(rt.clone(), proxy.clone(), store.clone())),
    Box::new(IssueReportTool::new(rt.clone(), store.clone(), reports.clone())),
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
    Box::new(CategoryListTool::new(rules.clone())),
    Box::new(RulesStatusTool::new(rules.clone())),
    // 地区
    Box::new(SetUserRegionTool::new(store.clone())),
    // 我的服务器（只读）
    Box::new(MyServersTool::new(services.clone())),
    Box::new(MyServerFailureTool::new(services.clone())),
    // 在线切换接管方式（有确认点）
    Box::new(ConfigSetModeTool::new(store.clone(), rt.clone())),
    // 设置指路（只读）
    Box::new(OpenSettingsTool::new()),
    Box::new(StageSelectTool::new(server_catalog.clone())),
    Box::new(CatalogOptionsTool::new(server_catalog.clone())),
    // 只读网页可达性（AI 自查）
    Box::new(HttpCheckTool::new()),
];
```

> **两个目录，两个变量，别复用。** `catalog`（`CatalogSearchTool` 用）是**共享节点目录客户端** `crate::catalog::CatalogClient`；`server_catalog` 才是建机目录（地区 + 套餐）。把后者写成 `catalog` 会把节点列表工具换成错的目录源。
>
> `server_catalog` 与 `my_server_catalog`（`commands.md` §7.14）是**同一个取数入口**：`VpnToolServices::server_catalog()` → `control_plane::catalog::fetch_catalog`，`StageSelect` 的校验与 `CatalogOptions` 的读取都走它，不各自拼 URL。**不做本地缓存**（§7.14 明确「不做本地缓存、不返回假数据」）——Worker 侧已有 5 分钟服务端缓存，Host 每次现取，代价只是几十条 JSON；陈旧目录会让用户看到已下架的地区或旧价格，比多打一次请求更糟。目录只在 `commands.rs:285` 现取的写法**作废**：命令层与工具层都调 `VpnToolServices` 这一个方法。
```

### 3.2 `VpnConnect` 没有确认点

P1 移除审批后，`VpnConnect` 直接执行：它会修改系统代理，不弹确认卡。

它仍然是**需要用户明确意图**的操作 —— 区别只在于这个意图由 Agent 的判断代替用户点击。风险记录见 §2.1.1。

> `CoreInstall` 自 3.4.0 起**不在工具集里**：下载并替换特权二进制改为 UI 显式触发（`commands.md` §7.10），模型既不能安装、也不能升级或回滚。

> **`CoreUpgrade` 是 UI 专用命令注册成工具的唯一例外，也是最早有确认点的工具**（3.5.0 新增，§4.45）。它不恢复旧审批框架：`ApprovalPolicy` / `ApprovalScope` / `approval_id` 仍然全部删除；确认走的是既有的 `AskUserQuestion` 阻塞通道，由 Host 填 `kind: "core_upgrade_confirm"`。模型能发起「问用户要不要升级」，但不能自己回答，也不能跳过。

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

- 未连接时 `upstream_version` + `runtime_source` 仍报告当前**可用**的运行时（已安装 > 随包）。
- 返回文案必须区分「未运行」与「未安装」：可用但没连时写「运行状态 idle，运行时 1.14.4（随包），未连接」；只有 `runtime_source = "none"` 时才允许说「运行时不可用」。
- 运行时安装不由 AI 触发（`CoreInstall` 已移除）：**不得**建议用户「先安装运行时」；需要处理时指向「高级设置 → 运行库」。

`next_actions`：

| 当前状态 | 建议动作 |
|---|---|
| `idle` | `VpnConnect`（池里已有节点时）/ `NodeImportUrl` / `NodeCreate`（空池时） |
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
- 已有连接在跑（已连接或正在启动）、指定另一套配置 → **先停旧连接再启动**（`runtime_start` 自动收口）；不再报 `other_config_running`，也不需要调用方先断开。
- 单配置下没有「切配置」：`ConfigActivate` 已无工具入口。

`data`：

```ts
type RuntimeStartData = RuntimeSnapshot & {
  already_running: boolean;     // 幂等命中时为 true（同一套已连接，或同一套正在启动）
};
```

- 幂等命中时 `state` 可能是 `running`（已连接）或 `starting`（同一套正在启动，不重启在途连接）；后者是 `state != "running"` 的唯一成功情形（`commands.md` §7.1.1）。模型把 `already_running = true` 当作「已经在连 / 正在连」，不要再催促用户重试。
- `VpnConnect` 复用同一条连接路径，返回里也可能带 `already_running`；那是附加字段，按 `RuntimeStartData` 同样理解即可。

错误：`PRECONDITION_FAILED`（`no_config` / `no_nodes` / `tun_denied` / `helper_missing`）、`NOT_FOUND`、`RUNTIME_BUSY`、`RUNTIME_NOT_INSTALLED`、`RUNTIME_START_TIMEOUT`、`RUNTIME_CONFIG_INVALID`、`RUNTIME_PORT_UNAVAILABLE`、`TIMEOUT`（`details.reason = "runtime_busy"`：运行期操作锁等待超时，见 `commands.md` §7.1；不是连接失败，可重试）、`INTERNAL`（见下条）。

**被取代的启动**：启动在锁外拉起，返回后若已被新的连 / 断取代，会收尾停掉**自己拉起的那个连接**（本次调用以 `PRECONDITION_FAILED / cancelled` 结束：请求作废，不是故障，不要重试；`details.connect_changed = "restored"`——拉起的东西已收回，不会声称启动成功）；收尾失败时是 `INTERNAL` + `details.connect_changed = "unknown"`——按「不确定有没有改动」转述（§2.4 第 3 条），**不要说「已断开」**，让用户再试一次即可。

`tun` 连接换新后台组件失败时，`PRECONDITION_FAILED` 的 `details.reason` 取值见 `commands.md` §7.1：`tun_denied` / `helper_admin_cancelled` / `helper_start_failed` / `helper_missing` / `dev_unbundled` / `helper_busy` / `helper_lease_unavailable` / `helper_file_invalid`；连接被切配置 / 断开取代时是 `cancelled`（请求作废，不是故障，不要重试）。模型只按 `message` 转述，不暴露 code；`dev_unbundled` 表示当前是未打包的调试进程，需要引导用户用 `bash scripts/dev/tun-dev.sh` 启动打包后的 App；`helper_admin_cancelled` 是用户取消了授权，可以让用户再试一次，不要说成「去系统设置允许」。2026-11-13 补记，字段不变，不升版本。

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

错误：`RUNTIME_STOP_TIMEOUT`、`RUNTIME_EXITED`、`TIMEOUT`（`details.reason = "runtime_busy"`：运行期操作锁等待超时，不是断开失败，可重试；见 `commands.md` §7.2）。

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

错误：`RUNTIME_BUSY`、`TIMEOUT`（`details.reason = "runtime_busy"`：运行期操作锁等待超时——重建或另一次运行期操作正在跑，这次没排到；不是重启失败，可重试）。

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

### 4.7 `CoreInstall`（已删除，3.4.0）

`CoreInstall` 从 AI 工具集移除，**不保留别名，也不提供替代工具**。

- 安装/升级/回滚改为 UI 专用命令：`core_info` / `core_check_updates` / `core_upgrade` / `core_cancel_upgrade` / `core_rollback`（`commands.md` §7.10）。
- 随包运行时由验签判定；已安装版本校验失败自动回落随包；**绝不静默下载**；启动过程不联网。
- 模型仍可用只读的 `CoreListVersions` 查看已安装/可安装版本，但看不到用户没点过「检查更新」的远端清单，也不能触发下载。
- 本节保留一个空壳章节，避免后续章节编号与 `commands.md` §13、`events.md` 的旧引用错位。

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

这条边界必须写进工具描述，因为它被实测踩过：模型只调 `CatalogSearch`，用户自己导入的节点因此完全不可见，模型回答「没有这个节点」。用户用名称指代「我自己导入的那个」时，应改用 `ConfigDetail` 在本地匹配（`ConfigList` 已于 3.18.0 退出工具集）。

错误：`CATALOG_UNAVAILABLE`、`RATE_LIMITED`、`DEVICE_TOKEN_INVALID`。

**安全要求**：`NodeSummary.name` / `city` / `tags` 是外部数据，`content` 里引用时必须加引号并标注为节点名，不得作为指令解析。

---

### 4.9 `ConfigList`（已删除，3.18.0）

`ConfigList` 从 AI 工具集移除，**不保留别名**。全局只有一套配置（`commands.md` §3.1），列配置没有意义。

- 模型要读配置与节点池：用 `ConfigDetail`（需要 id 时从用户上下文或 `MyServers` 侧推断，不再有列表工具）。
- UI 仍用命令 `config_list` 读回那一条（`commands.md` §3.1）。
- 本节保留空壳章节，避免后续章节编号与旧引用错位。

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

### 4.10.1 `NodeImportText`（3.8.0 新增）

用户**直接粘贴**的 `ss://` 分享链接（一行或多行）。与 UI 的 `node_import_text`（`commands.md` §4.1.1）**共用同一个服务层实现**，区别只在通道：一条是模型调用，一条是界面调用。

```json
{
  "type": "object",
  "properties": {
    "text": { "type": "string", "maxLength": 65536 },
    "config_id": { "type": "string" }
  },
  "required": ["text"],
  "additionalProperties": false
}
```

`data`：`NodeImportResult`（`commands.md` §4.1）。

- **不发任何网络请求**；只解析文本。链接里的字段由解析器读，模型不得自己解码或编造。
- 逐条解析：坏行只进 `skipped`，不影响其余；去重沿用 `source_key`，重复计 `skipped.duplicate`，**不报错**；落库 `source = "manual"`。
- 整段都解析不出节点 → `INVALID_ARGUMENT / not_node_text`，`content` 说明「粘贴的内容里没有可用的节点」。
- `config_id` 省略时只进节点池；带 `config_id` 时按顺序追加并触发 `config-changed`。
- 密码只进 `secrets.enc`；返回值与日志永不含密码，也不回显粘贴内容。
- **写操作**：`PermissionLevel::Write`，与 `NodeCreate` 同档，必须走工具调用与展示链路，不能静默建节点。

错误：`INVALID_ARGUMENT`（`not_node_text`）、`NOT_FOUND`、`SECRET_STORE`。

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
- **连接前自动停旧连接**：已有连接在跑（已连接或正在启动）、目标为另一套配置时，先停干净再连；不要求调用方先断开，也不报 `other_config_running`。

`data`（**按 `mode` 分两种形状，返回类型是 `VpnConnectData | TunConnectData`，不要混用**）：

```ts
// mode = "system_proxy"：就是 `RuntimeSnapshot`（runtime.md §2.5）原样序列化，再插入一个顶层 `exit_ip`。
// 这里不另列字段表：快照新增字段时本类型自动跟随，避免又一次「契约比实现窄」。
type VpnConnectData = RuntimeSnapshot & {
  state: "running";              // Ok 只在这种状态下返回
  config_id: string;
  node_id: string;
  upstream_version: string;
  exit_ip: string | null;        // 顶层字段：等待最多 3s 后的出口 IP；null = 还没测到，不是失败
};
```

```ts
// mode = "tun"：目前是单独手拼的一份窄对象，只有下面这些字段。
// **它不是 RuntimeSnapshot**：health / traffic / connections / latency_ms / node_latency_ms /
// direct_ip / uptime_seconds 都不出现，读它们会拿到 undefined。
// 这是已知缺口，等 TUN 接进 RuntimeManager 后统一；在此之前要查这些值请调 RuntimeStatus。
type TunConnectData = {
  contract_version: string;
  state: "running";
  mode: "tun";
  pid: number;
  mixed_port: null;
  config_id: string;
  config_name: string;
  routing_mode: string;
  node_id: string;
  node_name: string;
  applied_route_revision: number | null;
  connected_since: string;
  system_proxy_enabled: false;
  tun_device_up: boolean;
  tun_default_route: boolean;
  exit_ip: null;
};
```

**`mode = "system_proxy"` 时，`data` 里的所有快照字段都要原样转述**，包括 `direct_ip`、`health`、`traffic`、`connections`、`restart_count`、`last_error`。连接刚建立时 `traffic` / `connections` 通常还是 `null`（2 秒后才采到第一份样本）——`null` 是「还没采到」，**不是 0**。

顶层 `exit_ip` 与 `health.exit_ip` 的关系（仅 `system_proxy`）：顶层是「等了最多 3 秒，仍没有就 `null`」的结果，`health.exit_ip` 是最近一次探测的值；两者不一致时以判定连接成功为准的那条规则为先——**只看 `state`**。

语义（按顺序）：

1. 确保运行时可用；不可用 → `RUNTIME_NOT_INSTALLED`（**不自动安装、不自动下载**；`next_actions` 提示用户到设置页检查运行时版本）。
2. 解析配置与节点。
3. 生成配置 → `sing-box check`；`connection_mode = "tun"` 时先确认特权助手可用，否则 `PRECONDITION_FAILED`，`details.reason` 为 `tun_denied`（未批准 / 用户拒绝）或 `helper_missing`（未安装 / 安装失败 / 平台不支持，完整取值见 `commands.md` §7.1）。
4. 启动或热更新。
5. 设置系统代理（`system_proxy` 模式；无确认点，直接执行）。
6. 异步探测出口 IP（**不阻塞返回**；未测到时 `exit_ip` 为 `null`，后台测到后经健康事件推给 UI）。
7. 任一步失败：关闭系统代理，按 `docs/phase-1-technical-design.md` §6.5 分类返回。

**连接是否成功只看 `state`，不看 `exit_ip`。**

> `latency_ms` 的语义固定为**出口 IP 探测的往返耗时**，与 `runtime.md` §2.5 的同名字段同源。它含 DNS + TLS，实测常在 2000 ms 量级。
> **节点延迟是另一个字段 `node_latency_ms`**：Clash API delay 测试（`GET /proxies/node-<id>/delay`）的毫秒数；未连接、还没测到、或当前没有选中节点时为 `null`。两个字段不同源，**不得互相填充**，更不要把 `latency_ms` 说成「节点快慢」。
> `NodeProbe.latency_ms` 同样是节点延迟（手动测单个节点），与 `node_latency_ms` 同源，只是触发方式不同。

| 字段 | 含义 |
|---|---|
| `state = "running"` | 已连上。**这是唯一判定依据** |
| `exit_ip = null` | 已连接，出口 IP 还没测到。**不代表连接失败**，可用 `RuntimeStatus` 再查 |
| `node_latency_ms = null` | （仅 `system_proxy`）已连接，节点延迟还没测到（进入 `running` 后才开始测）。**不代表节点不可用**；`tun` 模式没有这个字段 |

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
  | { kind: "open_seed" }
  | { kind: "switch_mode"; to: "tun" | "system_proxy" };

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
    | "network.coverage"
    // config
    | "config.current_config" | "config.seed" | "config.seed_stale";
  group: DiagGroup;
  status: "ok" | "failed" | "skipped";  // 该项的结论；skipped = 当前状态不适用，不是失败
  ok: boolean;              // 兼容字段：语义恒等于 status == "ok"
  detail: string;              // 实测值或失败原因，已脱敏
  remediation: string | null;  // 一句建议动作；无需动作时为 null
  action: DiagAction | null;   // 可直接渲染成按钮的动作
};

type DiagReport = {
  contract_version: "3.20.1";
  generated_at: string;
  app_version: string;
  platform: "darwin" | "windows" | "linux";
  arch: string;
  runtime: RuntimeSnapshot;
  summary: {
    total: number;
    ok: number;
    failed: number;
    skipped: number;
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

**`status` 与 `skipped` 的语义（3.21.0）**：

- `status` 三态：`ok` / `failed` / `skipped`。`ok` 字段保留，语义恒等于 `status == "ok"`（**兼容字段**，不要单独判定）。
- **`skipped` 不是错误**：这一项在当前连接状态下不适用、没有被检查。它**不计入 `failed`**；`summary` 单列 `skipped`，且 `ok + failed + skipped = total`。
- `skipped` 项的 `remediation` 与 `action` **必须为 `null`**；界面不得用失败色；模型不得据此说「坏了 / 不可用」，只能说「这项没检查」。

**各模式适用表**：

| 检查 | 代理模式已连接 | TUN 模式已连接 | 未连接 / 连接中 |
|---|---|---|---|
| `app.process_alive` | 适用 | 适用（真实 pid） | `skipped` |
| `app.clash_api` | 适用 | **不适用 → `skipped`**（控制面只有端点，没有探测通道） | `skipped` |
| `app.data_plane` | 适用 | 适用（TUN 侧真实探测） | `skipped` |
| `network.exit_ip` | 适用；**未探测到算 `skipped`，不算失败** | **不适用 → `skipped`**（出口 IP 不采集） | `skipped` |
| `system.proxy_services` | 适用：每个服务的代理必须指向本次混合端口，否则 `failed` | **不适用 → `skipped`**（「接管模式不用系统代理」）；**但残留设置仍要查**：指向未监听的本地端口 → `failed`，其它残留只进 `detail` | **适用**：不跳过，残留代理设置与死指针跟连不连接无关 |

未连接 / 连接中的 `detail`：「未连接，未检查」「正在连接，稍后再看」——仅限上表标 `skipped` 的项。`system.proxy_services` 在这两种状态下照常给实测结论（残留代理设置不依赖当前连接）。

- **文案禁区**：未连接与连接中不得出现「进程未运行」「控制面不可用」；TUN 下不得出现「sing-box 进程未运行」——这些项在这些状态下是 `skipped`，不是失败。

**`network.coverage`（3.20.2 新增，`group = "network"`）**——当前接管方式覆盖哪些流量：

| 实际状态 | `ok` | `detail` | `remediation` / `action` |
|---|---|---|---|
| 已连接且为全部接管（TUN） | `true` | 「现在接管全部流量，TCP / UDP / QUIC 都经过 VPN」 | 无 |
| 已连接且为本机代理 | `false` | 「覆盖范围不同：现在只为本机软件提供代理，浏览器 HTTP/3 不经过 VPN」 | 「要看全部流量的情况，点「切到全部接管」再测一次」 / `{ kind: "switch_mode", to: "tun" }` |
| 未连接 | `true` | 「未连接，先连接再检查覆盖」 | 无 |

- **判据只用 `(connected, tun)` 两个参数**：`connected && tun` = 全接管；`connected && !tun` = 覆盖范围不同（本机代理）；`!connected` = 先连接。不读 `mode` 参数，也**没有「读不到接管方式」这一档**——那种情况下的实际覆盖是知道的（本机代理），回「读不到」是说假话；留一个会说假话的分支，比少一个分支更糟。

- **本机代理是产品的默认选择，不是缺陷**：这张卡片只能读成「覆盖范围不同」，不能读成「当前配置有问题」；`detail` 与 `remediation` 都按这个口径写。
- **结论只用于「UDP / QUIC 应用不通」**：本机代理模式下浏览器 HTTP/3 不经过 VPN，这是覆盖范围问题。**不得把它当成反机器人挑战（Cloudflare 等）的解释**——四组对照实验已证伪，挑战与接管范围无关；遇到挑战应引导用户用 `HttpCheck` 看站点的 `cf_mitigated`，而不是断言「切到全部接管就能过」。
- **`remediation` 用用户语言**，写「切到全部接管」，不出现 `tun` / `system_proxy` 这些内部词；内部值只出现在 `action.to` 里。
- 不自动切换：`DiagRun` 仍是 `ReadOnly`；`action` 由 UI 渲染成按钮，点击后等价于用户发一条消息，由模型走 `ConfigSetMode`（有确认点）。
- 覆盖项不通过时，`DiagRun` 的 `next_actions` 给 `[{ label: "切到全部接管", tool: "ConfigSetMode", args: { "mode": "tun" } }]`；`display.facts` 加一行「接管范围：不覆盖浏览器 HTTP/3」。

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
  contract_version: "3.20.1";
  job_id: string;
  kind: "core_install" | "core_upgrade" | "diag";
  origin: "ui" | "agent";   // 任务发起方；旧记录按 "ui"
  state: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  stage: string;            // core_upgrade: downloading|verifying|unpacking|installing|activating
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

### 4.17 `ConfigDelete`（已删除，3.18.0）

`ConfigDelete` 从 AI 工具集移除，**不保留别名**。全局配置是节点池与连接参数的唯一载体，不能删（命令层恒 `PRECONDITION_FAILED / only_config`）；不需要的节点用 `ConfigUpdate.nodeIds` 或界面从池里移除。

- 旧行为（多配置时代允许删配置）见 3.17.x 及更早的变更记录，仅供回滚对照。
- 本节保留空壳章节，避免后续章节编号与旧引用错位。

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
| `flush_dns` | macOS：`dscacheutil -flushcache` + `killall -HUP mDNSResponder`，**经特权助手以 root 执行**（普通用户 HUP 不动 mDNSResponder）；Windows：`ipconfig /flushdns`。**不动代理、不停运行时**；`verified` 以探针域名能否解析为准 | 否 |
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
- **只是免费节点缓存，不是用户的节点总量**：回答「我有几个节点 / 当前用哪个」必须用 `ConfigDetail`（2.45.5 起节点的 `source` 与 `unavailable_reason` 都在那里）。

权限：`ReadOnly`。

---

### 4.22 `AskUserQuestion`（Claurst 内置，1.2.0 起接通）

Veyl **不重写**这个工具，只负责接线。工具实现与 schema 由 `claurst-tools` 提供（`crates/tools/src/lib.rs:109-116`）。

行为：

| 项 | 内容 |
|---|---|
| 阻塞 | 调用后整个查询循环暂停，直到用户作答、超时或请求结束 |
| 通道 | `UserQuestionEvent { question, options, reply_tx }` → `ask-user-question` 事件（`events.md` §4.8） |
| 回答 | 用户通过 `reply_user_question` 回传：普通提问接受任何非空文本，`core_upgrade_confirm` 必须逐字等于 `options` 之一；空串 = 跳过（`commands.md` §9.6） |
| 超时 | 15 分钟未答 → Host 代回空串（等同跳过） |
| 多选 | **不支持**（Claurst 通道本身不支持） |
| 解释行 | UI 在**带选项、且不是确认卡**的卡片底部加固定按钮 `解释这个设置的含义`；点击回传的就是这串字，工具层只当普通文本，语义由提示词约束（不当作答、不推进、不构成节点同意） |

**`options` 必须非空，且每一项都是非空字符串**：`options` 缺失、为空数组、或含全空白项时，**不发事件**，直接把这次工具调用以 `INVALID_ARGUMENT` 结束。

> 为什么：提问卡按 `options` 渲染按钮，空 `options` 等于没有可点的答案；全空白项更糟——点下去回传空串，与「跳过」的语义撞在一起。与其把坏卡显示给用户，不如当场告诉模型"请带上选项再问"。

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
- **`current_node_id` 可能为 `null`**：`source = "seed"` 的新建配置在用户点「连接」之前、或节点全部被删之后。这不等于「没有节点」——`nodes` 照实返回，`node_count` 照样准确；**不要把它说成「还没有节点」**，也不要替用户补一次 `NodeSwitch`。
- **不含密码**；要判断连通性用 `NodeProbe`，不要试图从详情里推断。
- **节点问题的唯一口径（2.45.5）**：`nodes[].source` 区分 `seed` / `url` / `manual` / `owned`；`unavailable_reason = "server_destroyed"` 表示这条对应的服务器已停机销毁。回答「有几个节点 / 哪个节点能不能用」以本工具为准，`DefaultProfileStatus` 只代表免费节点缓存。
- **`unavailable_reason` 的口径边界（3.21.3）**：它来自本地镜像，只能确定「服务器已销毁」，**分不清停机删除与用户自己销毁**——要说是哪一种，去看 `MyServers` 的 `destroyed_reason`。不要在这里猜。
- 配置不存在 → `NOT_FOUND`。

权限：`ReadOnly`。

---

### 4.24 `ConfigCreate`

**已删除（3.18.0）。** `ConfigCreate` 从 AI 工具集移除，**不保留别名**。全局只有一套配置，由服务层懒创建（`commands.md` §3.1 / §4.0）；模型不再有新建配置的路径。

- 加节点：`NodeCreate` / `NodeImportUrl` / `NodeImportText`，省略 `config_id` 即绑定全局配置（`commands.md` §4.0–§4.2）。
- 改连接参数：`ConfigUpdate`；改接管方式：`ConfigSetMode`。
- 旧规则随之移到命令层：`source = "seed"` 的新建 **`current_node_id` 留空**、界面预选不写库，连接时先 `NodeSwitch` 再 `RuntimeStart`（`commands.md` §3.2；`NodeAttach` 永不改当前节点）。
- 历史 schema（仅供回滚对照，**模型不可见**）：

```json
{
  "type": "object",
  "properties": {
    "name": { "type": "string", "maxLength": 40 },
    "connect_mode": { "type": "string", "enum": ["system_proxy", "tun"] },
    "routing_mode": { "type": "string", "enum": ["direct", "proxy_all"] },
    "targets": { "type": "array", "items": { "type": "string" } },
    "source": { "type": "string", "enum": ["seed"] },
    "node_ids": { "type": "array", "items": { "type": "string" }, "minItems": 1 },
    "dns": { "type": "object" },
    "tun_excludes": { "type": "array", "items": { "type": "string" } }
  },
  "required": ["name", "connect_mode", "routing_mode"],
  "anyOf": [{ "required": ["source"] }, { "required": ["node_ids"] }],
  "additionalProperties": false
}
```

- 本节保留空壳章节，避免后续章节编号与旧引用错位。

---

### 4.25 `ConfigUpdate`

```json
{
  "type": "object",
  "properties": {
    "config_id": { "type": "string" },
    "name": { "type": "string", "maxLength": 40 },
    "routing_mode": { "type": "string", "enum": ["direct", "proxy_all"] },
    "targets": { "type": "array", "items": { "type": "string" } },
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
- `routing_mode` **只有 `direct` / `proxy_all` 两档**：`"proxy_selected"` → `INVALID_ARGUMENT / routing_mode_not_supported`；未知值 → `invalid_routing_mode`。
- `targets` **已废弃**：不产生任何效果（同 §4.24）。
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

错误：`INVALID_ARGUMENT`（`invalid_argument` / `unsupported_method`）、`NOT_FOUND`、`SECRET_STORE`。

- 细分校验（名字、地址、端口、密码）由前端/调用方先做；Host 统一 `invalid_argument`，只有 method 不在白名单才是 `unsupported_method`。
- `port` 是 `u16`：越界或非整数在反序列化阶段就失败，不是本工具的结构化错误。

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
| **有连接正在启动**（还没起来，不论哪一套） | `PRECONDITION_FAILED / config_launching`；`current_node_id` 不变。这是正常拒绝，不是故障：等连接完成或断开后再切，**不要重试** |
| 已连接、这套配置正在跑 | selector 热切换，进程不重启 |
| 已连接、但这套配置不是当前配置 | `PRECONDITION_FAILED / config_not_running`（身份已知：连的是另一套） |
| 已连接（接手上次运行的 TUN）、但读不到连接属于哪套配置 | `PRECONDITION_FAILED / config_unknown`（身份未知，不能当成「另一套」）；提示用户先断开再切换节点，**不要重试** |
| 节点不属于该配置 | `NOT_FOUND / node_not_in_config` |

- **「选中」不是「切换」**：模型不要为了「看看别的节点」调用本工具——那会真的改出口。
- 热切换失败 → `PRECONDITION_FAILED / runtime_switch_failed`，`current_node_id` 不变。
- 不要用 `VpnConnect` 表达切换：它没有 `node_id` 参数；换节点只走 `NodeSwitch`，未连接时不会启动 VPN。

错误：`NOT_FOUND`、`PRECONDITION_FAILED`（`config_not_running` / `config_unknown` / `config_launching` / `runtime_switch_failed`）、`TIMEOUT`。

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

- **唯一测得口径**：Clash `GET /proxies/node-<id>/delay`，经 sing-box 真实发一次 HTTP。已连接且测的是当前配置 → 复用运行中的 Clash API；完全空闲 → 先起临时探针运行时（8 秒启动上限，测完保留 60 秒复用）。不再有 TCP 握手。
- `status` 三态：`ok` / `unreachable` / `untested`；`unreachable` 只在 Clash delay 真的失败时出现。
- **`untested` 不是工具错误，也不是「连不通」**：工具返回 `ok: true`，`status = "untested"`、`reachable = null`、`error.code = "PROBE_UNAVAILABLE"` + `reason`。模型只能说「这次没测成」并转述原因，**不得说成节点不可达**。
- **节点不可达也不是工具错误**：`ok: true` + `status = "unreachable"` + `reachable = false` + `error`。只有 `node_id` 不存在才是 `Err`；探测本身超过 15 秒（含探针运行时启动）返回 `TIMEOUT`，可重试。
- **探不通时顺手检查服务器（2.45.2）**：`status` 不是 `ok`（含超时与工具报错）且节点是当前连接的自建服务器时，Host 会 `GET /v1/servers/{id}` 一次；判定最多等 5 秒，超时不停；控制面说已销毁（或 404）就把 `runtime_stop` 丢到后台任务，工具立即返回。检查自身失败一律吞掉，不影响探测结果返回。**因此本工具会停止运行时，不再算纯只读。**
- 不登记问题（J1）：单节点手动测试失败不等于用户被阻断。
- **一次只测一个**：批量测速是 UI 专用（`commands.md` §4.6–§4.8），没有对应工具；不要循环调用本工具模拟批量。

权限：`Write`（探测只读，但探不通时可能停隧道，见上）。

---

### 4.29 `ProxyParams`（已移除，3.15.0）

> **3.15.0 从 AI 工具集移除**：本机代理地址与端口只在「设置 → 连接」出现；AI 需要读本机代理 / 监听端口时用 `NetConfigGet`。命令 `proxy_params` 保留给界面（`commands.md` §4.5）。

---

### 4.30 `ProbeRun`（已移除，3.15.0）

> **3.15.0 从 AI 工具集移除**：连接后的四项探测由运行时内部完成，失败项由 `DiagRun` 读出并渲染成卡片；不再让模型主动发起探测。命令 `probe_run` 保留（`commands.md` §5.1）。

---

### 4.31 `IssueList`（已移除，3.15.0）

> **3.15.0 从 AI 工具集移除**：新设计没有 issue 列表界面：故障只以 `issue_card` 叠加显示，诊断走 `DiagRun`。命令 `issue_list` 保留但不再有 AI 入口。

---

### 4.32 `IssueGet`（已移除，3.15.0）

> **3.15.0 从 AI 工具集移除**：同上：没有 issue 详情页，证据不单独开工具。命令 `issue_get` 保留。

---

### 4.33 `IssueHandoff`（已移除，3.15.0）

> **3.15.0 从 AI 工具集移除**：「让 AI 定位」改为把结构化失败（`MyServerFailure`）或诊断结果（`DiagRun`）直接给模型，不再有「把问题转交会话」这一步。命令 `issue_handoff` 保留但不再有 AI 入口。

---

### 4.34 `IssueResolve`（已移除，3.15.0）

> **3.15.0 从 AI 工具集移除**：没有 issue 界面后就没有「标记已解决」这个用户动作。命令 `issue_resolve` 保留。

---

### 4.35 `IssueIgnore`（已移除，3.15.0）

> **3.15.0 从 AI 工具集移除**：同上，没有忽略 / 恢复问题的入口。命令 `issue_ignore` 保留。

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
    "mode": { "type": "string", "enum": ["direct", "proxy_all"] },
    "confirm_reconnect": { "type": "boolean", "default": false }
  },
  "required": ["mode"],
  "additionalProperties": false
}
```

`data`：`RouteSetModeData`（`commands.md` §10.0）。

- **`mode` 只有 `direct` / `proxy_all` 两档**：`"proxy_selected"` → `INVALID_ARGUMENT / routing_mode_not_supported`；未知值 → `invalid_routing_mode`。
- `direct` ↔ `proxy_all` 且已连接 → selector 热切，不断流。
- 只有**旧配置仍是 `proxy_selected`** 时，切到两档才属于跨家族切换 → 未带 `confirm_reconnect` 时返回 `PRECONDITION_FAILED / will_disconnect`；**必须先问用户**，得到同意后再带 `true` 调一次。不得自行重试。
- 有连接在跑、但**读不到它属于哪套配置**（重启后接手 TUN）→ `PRECONDITION_FAILED / config_unknown`；
  这时不能写库、也不能说「下次生效」，用一句话请用户先重连再切换分流方式，**不得重试或改参数绕过**。
- 该工具会改网络；即使没有确认点，模型也应在调用前用一句话说明会断一下（§2.1.1）。
- 跨家族的确认一句话要包含两点：会断开并自动重连、**域名解析方式也会改变**（`routing.md` §6.4）。

错误：`INVALID_ARGUMENT`（`routing_mode_not_supported` / `invalid_routing_mode`）、`NOT_FOUND`、
`PRECONDITION_FAILED`（`will_disconnect` / `config_unknown`）、`INTERNAL`。

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
- **只对旧数据的 `proxy_selected` 有意义**：写入路径不再产生该模式，新配置的分类集合不影响生成。
- `dns_classifiable = false` 的分类不能用（`UNSUPPORTED`）。
- 不热切，`effective = "next_connection"`。

---

### 4.39 `RuleCustomList`（已移除，3.15.0）

> **3.15.0 从 AI 工具集移除**：新设计只有「智能 / 全局」两档流量范围，没有自定义直连规则。命令 `rule_custom_list` 保留但不再有 AI 入口。

---

### 4.40 `RuleCustomAdd`（已移除，3.15.0）

> **3.15.0 从 AI 工具集移除**：同上，没有自定义规则的添加入口。命令 `rule_custom_add` 保留。

---

### 4.41 `RuleCustomDelete`（已移除，3.15.0）

> **3.15.0 从 AI 工具集移除**：同上，没有自定义规则的删除入口。命令 `rule_custom_delete` 保留。

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

### 4.44 `RulesUpdate`（已移除，3.15.0）

> **3.15.0 从 AI 工具集移除**：规则数据随包预置，设置里没有「更新规则数据」入口；数据更新由运行时与随包资源负责，不交给模型。命令 `rules_update` 保留。

---

### 4.45 `CoreUpgrade`（AI 代劳升级，3.5.0 新增）

```json
{
  "type": "object",
  "properties": {
    "version": { "type": "string", "pattern": "^[0-9]+\\.[0-9]+\\.[0-9]+$" }
  },
  "additionalProperties": false
}
```

- 参数**只有可选 `version`**。出现 `url` / `sha256` / `size` / `force` 或任何其它键 → `INVALID_ARGUMENT`（`details.reason = "unknown_argument"`）。下载源、校验值、大小全部由 Host 决定，模型无权指定。
- 省略 `version` 表示「装最新可用版本」。

`data`：

```ts
type CoreUpgradeData = {
  job_id: string | null;                       // 开始下载时非 null
  current_version: string;                     // 调用前的实际版本（随包或已安装），与 core_upgrade 命令返回同名
  target_version: string;                      // 本次比较/安装的目标版本
  changed: boolean;                            // target_version != current_version
  confirmation: "accepted" | "not_needed";     // 成功回复里恒有
};
```

**调用顺序（验收句）**

1. **先查网络，再比较版本。** 未完成网络检查（`core_check_updates`）前不得比较版本、不得弹确认卡；网络不通时本次调用 `core_upgrade` 命令的次数必须为 **0**。
2. **只重试一次，且只对网络错误。** 仅 `NETWORK_UNREACHABLE` 允许重试一次；`SOURCE_UNAVAILABLE` 与 `SIGNATURE_INVALID` **不重试**，直接失败。
3. **只对更高版本弹卡。** 比较基准是 `core_info.active_version`（为空则用随包的 `bundled_version`）；没有更高版本时确认卡出现次数为 **0**，返回 `changed: false`。

**确认卡**

- 用户同意后 Host 才调用 `core_upgrade` 命令。确认走既有的 `AskUserQuestion` 阻塞通道（`events.md` §4.8），Host 填 `kind: "core_upgrade_confirm"` 与 `details`（`commands.md` §7.10），**模型无法伪造**。
- 同意一次性绑定 `(session_id, request_id, target_version, artifact_sha256)`；换版本必须重新确认，绑定只对本次请求有效。
- 用户拒绝 → `CANCELLED`，不启动下载。
- 没有新版本 → **不弹卡**，直接返回 `changed: false`。

**回复**

所有回复都带当前版本与「有没有改动」：

| 情况 | 结果 |
|---|---|
| 有新版本、用户同意 | `{ job_id, current_version, target_version, changed: true, confirmation: "accepted" }`，Job 的 `origin = "agent"` |
| 没有新版本 | `{ job_id: null, current_version, target_version: current_version, changed: false, confirmation: "not_needed" }` |
| 用户拒绝 | `CANCELLED`，`details.current_version` 必填 |
| 网络 / 源 / 签名失败 | 对应错误码，`details.current_version` 必填 |

错误：`NETWORK_UNREACHABLE`、`SOURCE_UNAVAILABLE`、`SIGNATURE_INVALID`、`HASH_MISMATCH`、`DISK_FULL`、`BUSY`、`NOT_FOUND`、`CANCELLED`、`INTERNAL`。

> 这是**有确认点的工具之一**（另一个是 §4.49 `ConfigSetMode`）。它不恢复旧审批框架：`ApprovalPolicy` / `ApprovalScope` / `approval_id` 仍然全部删除；确认只是借用 `AskUserQuestion` 的阻塞通道，Host 提供结构化 `kind` / `details`，模型只能发起、不能代答。

### 4.46 `IssueReport`（问题报告，3.9.0 新增）

把现场材料写成用户桌面上的一个报告文件夹。设计见 `docs/design/issue-report.md`。

```json
{
  "type": "object",
  "properties": {
    "log_lines": { "type": "integer", "minimum": 40, "maximum": 400, "default": 200 },
    "include_domains": { "type": "boolean" },
    "report_markdown": { "type": "string", "maxLength": 131072 }
  },
  "additionalProperties": false
}
```

- **一个工具、两阶段**：不带 `report_markdown` = 收集（建目录、写 `先看我.txt` / `现场.json` / `日志/` / 模板 `报告.md`）；带 `report_markdown` = 写入（只覆盖本会话目录里的 `报告.md`）。
- **每个会话一个目录**，按 `session_id` 绑定；重复调用复用，不新建、不改名。
- **只读的边界靠 schema 保证**：没有 `path` / `file` / `dir` 参数；`additionalProperties: false` 让「传路径」在调用层直接失败（`INVALID_ARGUMENT`，`details.reason = "unknown_argument"`），不创建任何文件。
- **`log_lines` 越界是拒绝，不是截断**：< 40 或 > 400 → `INVALID_ARGUMENT`，`details.reason = "log_lines_out_of_range"`，**一个文件都不写**。静默夹到 400 会让模型以为拿到了 400 行、实际更少，`报告.md` 里引用的行号会错位。
- **`include_domains` 是三态，省略不等于关闭**（**省略即遵循用户设置，不接受 `null`**：显式 `null` 按 schema 校验失败处理，不要为它留一条路径）：

  | 入参 | 用户设置 `true` | 用户设置 `false` |
  |---|---|---|
  | 省略 | **`true`（尊重用户）** | `false` |
  | `false` | `false`（模型主动收窄） | `false` |
  | `true` | `true` | **`false`（模型不能放宽）** |

  即：`true` 这个取值**只能来自用户设置**；模型能做的只有「保持」或「收窄成 `false`」。设置**只能**由用户经 `commands.md` §7.12 的 `issue_report_preference` 写入，模型没有写入口。实际取值回写在 `data.domains_included`。
  - **省略必须按用户设置执行**，不能默认 `false`：否则用户勾了开关，模型一次不传参就又全打码，等于开关失效。
- `report_markdown` 是**报告正文**：Host 写盘前校验一级标题、三行声明与五个二级小节（现象 / 环境 / 时间线 / 可疑点 / 下一步建议）。缺什么补什么——补标题与声明、缺的小节插 `## <名>` + 一行「模型未提供这一节。」；**不替模型编内容**，`ai_report` 仍为 `true`。
- `PermissionLevel::Write`：它会写盘。**不是 `ReadOnly`**——那会让未来的只读快速通道绕过检查。它不改配置、不碰网络，`display.changed = "none"`。

`data`（完整形状见设计文档 §3.2）：

```ts
{
  report_id: string;            // "rpt-…"，不透明，UI 用它调命令
  report_dir: string;           // `~/Desktop/Veyl 问题报告/<目录名>`；不返回绝对路径，不含用户名
  phase: "collected" | "written";
  files: Array<{ name, bytes, lines, truncated, missing }>;
  materials?: { runtime, checks, logs: Array<{ name, start_line, lines, total_lines }>, domains_included };
  redactions: { domains, public_ips, paths, urls, node_refs, config_refs, mode: "minimal" | "detailed" };
  ai_report: boolean;
}
```

- `materials` 只给收集阶段，**已是脱敏后的内容**；模型可见日志上限 4 份 × `log_lines`、合计 ≤ 400 行、每行 ≤ 500 字符，超出优先保留 `runtime` 与 `sing-box`，并置 `truncated`。
- 脱敏口径由 `docs/design/issue-report.md` §6 / §6.1 定义，契约只锁两条：**唯一占位符 `***`**；域名默认保留可注册域（`www.google.com` → `***.google.com`），只有用户开启开关才给完整域名。
- `logs[].start_line` 是写入文件里的绝对行号，供 `报告.md` 的证据引用（`日志/<文件名>:<行号>`）。
- `display`：**两个阶段都要给 `actions`**——收集成功时 `text`「材料已整理好」，写入成功后「问题报告已生成」；`actions` 一律由 Host 填 `reveal_report_dir` 与 `compose_report_mail`（`events.md` §3.4，2.11.0）。**动作不带路径，只带 `report_id`。**
  - **不要等到写入阶段才给动作**：AI 超时或失败时材料与模板 `报告.md` 已经落盘，用户仍要能打开文件夹、发出邮件。收集成功即给，是这条产品路径的兜底。
  - `facts` 最多两行（保存位置、包含几份日志）；保存位置**不得暴露用户名**：写 `~/Desktop/Veyl 问题报告/<目录名>` 或只写目录名，不得出现 `/Users/<name>/…`。
- 失败：`INVALID_ARGUMENT`（见下表）、`INTERNAL`。日志缺失**不是**失败（`missing: true`）。

**两个参数类 reason 必须分开，不许合并**：

| 情况 | `details.reason` | 是否落盘 | 为什么要分开 |
|---|---|---|---|
| 传了未知字段（含 `path` / `file` / `dir`） | `unknown_argument` | 否 | 字段名不对，模型要去掉或改名 |
| `log_lines` < 40 或 > 400 | `log_lines_out_of_range` | 否 | 字段名是对的、取值非法，模型只需换一个合法数字；合并成 `unknown_argument` 会让它以为字段名写错，去猜别的参数 |
| `report_markdown` 是空串或仅空白 | `empty_report` | 否 | 只写标题与声明的空报告没有价值，还会让 `written` 相位名不副实；收集阶段已经给过模板报告，不需要再写一份空的 |

其余错误：`INVALID_ARGUMENT`（`report_dir_unwritable`）、`INTERNAL`。

### 4.47 `SetUserRegion`（地区，3.10.0 新增）

记录用户所在 / 常用地区。设计见 `docs/design/simplified-config-create.md` §9。

```json
{
  "type": "object",
  "properties": {
    "region": { "type": "string", "pattern": "^[A-Za-z]{2}$" }
  },
  "required": ["region"],
  "additionalProperties": false
}
```

- **唯一写入路径**：写 `settings.user_region`。没有任何 UI 命令可以改地区——`commands.md` 没有 `region_preference`，界面也没有地区控件。模型必须结合系统推断与对话内容自行决定；用户明确说过国家 / 地区时以用户为准，判不出就不要调用，**不要为了确认地区追问用户**。
- 校验：两字母 ISO 3166-1 alpha-2，统一规范化为小写；`cn` 走 `Region::Cn`。非法值 → `INVALID_ARGUMENT`，`details.reason = "invalid_region"`，不写库。
- 写入成功后发 `region-changed`（`events.md` §4.21）。只影响下一次建连；已连接时不断开、不重连。
- 同一地区重复写入 → `ok: true`，不发事件。
- `PermissionLevel::Write`：只写本地设置，不改配置、不碰网络。
- `data`：`{ region: string, source: "ai" }`。
- `display`：成功 `text`「地区已记下」、`changed = "none"`、`facts` 放地区名（如「中国大陆」）；失败 `text`「没能记下地区」。**不把来源（系统 / AI）念给用户。**
- 没有清除动作：本批不提供「恢复系统推断」的工具；用户换地区时直接说新的，AI 覆盖即可。

---

### 4.48 `MyServers`（我的服务器，3.12.0 新增）

只读地列出「我的服务器」与状态。**建机、销毁、取凭据只能由用户点界面**，没有对应的 AI 工具。

```json
{
  "type": "object",
  "properties": {},
  "additionalProperties": false
}
```

- `PermissionLevel::ReadOnly`；不访问云厂商 API，只读 Host 已有的服务器列表（与 UI 同一份）。
- `data`：`{ servers: [{ server_id, name, region, state, node_ready, monthly_usd, failure, destroyed_reason }] }`。
  - `state` 取值见 `commands.md` §7.15；`node_ready` 表示是否已可用来建配置。
  - **已销毁的行带 `destroyed_reason`（3.21.3）**：`failure.code = "billing_unpaid"` → 「因余额不足停机删除」，其余 destroyed → 「已销毁」。同时把内部 `failure` 置 null，**不给模型原始 `failure_code`**。
  - **不返回 IP、端口、节点 id、密码**；凭据永不进 AI 上下文。
- 列表为空是合法结果（`ok: true`，`servers: []`）。
- 身份未就绪 / 控制面不可用 → 按通用错误上报（`UPSTREAM_ERROR` / `PRECONDITION_FAILED`），不编造数据。
- `display`：成功 `text`「共 N 台服务器」，`facts` 放「名称 · 地区 · 状态（· 人话原因）」；失败 `text`「没能读到服务器列表，稍后再试」。

---

### 4.49 `ConfigSetMode`（在线切换接管方式，3.13.0 新增）

把一套配置的接管方式在 **`system_proxy` ↔ `tun`** 之间切换。命令实现见 `commands.md` §3.7 `config_set_mode`。

```json
{
  "type": "object",
  "properties": {
    "config_id": { "type": "string" },
    "mode": { "type": "string", "enum": ["system_proxy", "tun"] }
  },
  "required": ["mode"],
  "additionalProperties": false
}
```

- **没有 `confirm` 参数**：确认由 Host 生成的卡片完成（§下），模型既不能传、也不能代答。多传任何键 → `INVALID_ARGUMENT / unknown_argument`。
- `config_id` 省略 = 当前 active 配置；**读不到连接属于哪套时按 `RouteSetMode` 的先例拒绝**（`PRECONDITION_FAILED / config_unknown`），不写库、不停起、不换参数绕过。
- **调用前提（写进工具描述，模型必须遵守）**：**只在用户明确要求更换接管方式时调用**（例如「让所有软件都走 VPN」「改回只让设了代理的软件走」）。**不得为了"优化"网络、不得在排障时顺手切换、不得在用户没提这件事时主动建议后自行执行**。

`data`：

```ts
type ConfigSetModeData = {
  config_id: string;
  mode: "system_proxy" | "tun";
  previous_mode: "system_proxy" | "tun";
  changed: boolean;      // mode !== previous_mode
  connected: boolean;    // 返回时这套配置是否在跑
  restored: boolean;     // false = 回滚失败，当前是断开状态
  confirmation: "accepted" | "not_needed";
};
```

**确认卡（必须）**

- 走既有 `AskUserQuestion` 阻塞通道，Host 填 `kind: "config_set_mode_confirm"` 与 `details { config_id, mode, previous_mode, will_disconnect: true }`；**模型无法伪造、无法代答**。
- 正文必须含：目标方式的人类可读名（**`Tun 模式` / `Proxy 模式`**，与界面同一套用词；不出现 `tun` / `system_proxy`，也不另造「全部软件 / 本机代理」这类别名）+ **「会短暂断开当前连接」**。选项逐字 `切换` / `取消`。
- **默认焦点「取消」**；`Esc`、15 分钟超时、空回答一律等同取消。
- 同意一次性绑定 `(session_id, request_id, config_id, mode)`。
- **未连接时不弹卡**（`confirmation: "not_needed"`），直接执行。
- 用户取消 → `CANCELLED`，`details { config_id, mode, previous_mode }`，**不执行、不改库、不断线**。
- **两段式调用**：工具先用 `confirmed = false` 调命令；命令在「已连接或处于启动窗口」时返回 `PRECONDITION_FAILED / confirmation_required`（不写库、不停连接），Host 据此弹卡；用户同意后再带 `confirmed = true` 重试。取消 / 超时不发第二次调用。

**边界（必须实现）**

| 情况 | 结果 |
|---|---|
| 目标配置**不是**正在连接的那套 | **只写库**，不停起、不断线；`connected: false`，`changed` 按实际 |
| `mode` 与库值相同 | **不停连接**，`changed: false`、`confirmation: "not_needed"`，直接返回 |
| 回滚也失败（`restored: false`） | 库里已是新 `mode`、连接停在断开态；**必须如实说**，不能只回第一次的错误码，也不能写「已恢复」 |
| 并发（同 `config_id` 已有切换在跑） | `CONFLICT / switch_in_progress`，`retryable: true`；**不得重试到成功为止** |

**`display`**

| 情况 | `text` | `changed` |
|---|---|---|
| 切换成功并连上 | 「已切换到「Tun 模式」，连接已恢复。」 | `true` |
| 本来就是该方式 | 「已经是「Tun 模式」，没有改动。」 | `false` |
| 启动失败、**回滚成功** | 「没能切到「Tun 模式」，已回到原来的「Proxy 模式」。」+ 首次失败原因 | `false` |
| **回滚失败** | 「没能切换，也没能恢复原来的方式，**现在是断开状态、方式已改为「Tun 模式」但未连上**。」+ `[重新连接]` | `true` |
| 取消 | 「已取消，没有改动。」 | `false` |

- **`restored: false` 时禁止出现「已恢复」「连接正常」字样**，也不许把 `changed` 写成 `false`。

**错误与重试**

- 错误码是**首次失败**那个（`tun_denied` / `helper_missing` / `helper_admin_cancelled` / `dev_unbundled` / `TIMEOUT` …），回滚结果只体现在 `restored`。
- 可重试**一次**：`TIMEOUT`、`helper_busy`。
- **不可重试**：`tun_denied`（要用户先去系统设置批准，再由用户发起）、`helper_admin_cancelled`（用户取消了授权框）、`restored: false`、`switch_in_progress`（等前一个结束后由用户重来）、`CANCELLED`。
- 已知副作用要写进失败/成功文案的判断里：切换会重新生成 plan，**顺带应用该配置其它待生效改动**（DNS / 分流 / 节点集），不能承诺「只改了接管方式」。

---

### 4.50 `OpenSettings`（打开设置并指路，3.14.0 新增）

把用户带到设置里正确的位置，**不改任何值**。事件见 `events.md` §4.25。

```json
{
  "type": "object",
  "properties": {
    "section": { "enum": ["ai", "connection", "account", "advanced"] },
    "row": { "type": "string", "minLength": 1, "maxLength": 40 }
  },
  "required": ["section"],
  "additionalProperties": false
}
```

```ts
type OpenSettingsData = {
  opened: true;
  section: "ai" | "connection" | "account" | "advanced";
  row: string | null;        // 实际高亮的行；没匹配上为 null
  row_matched: boolean;
};
```

- `PermissionLevel::ReadOnly`；不写库、不发命令、不打开系统窗口。
- **触发约束**：只在用户问「这个设置在哪里 / 怎么改」，或模型要边指边解释某个设置项时调用。**一轮对话最多一次**，不得为了「展示能力」连续调用，也不得在用户没问设置时顺手打开。
- **行 id 登记表**（唯一来源；与 `commands.md` §9.1.1 的 `controls` 同源）：

| `row` | 对应行 |
|---|---|
| `connection.mode` | 接管方式 |
| `connection.scope` | 流量范围 |
| `connection.port` | 本地代理端口（仅代理配置出现） |
| `ai.provider` | 默认 AI |
| `ai.other` | 其他 AI 服务 |
| `account.login` | 登录 / 退出登录 |
| `account.balance` | 余额与充值 |
| `advanced.core` | 运行时核心版本 |
| `advanced.helper` | 系统助手（helper） |
| `advanced.logs` | 日志目录 |
| `advanced.reset` | 重置网络 |

- **未知 `row` 不是错误**：降级为 `row: null`、`row_matched: false`，仍然打开 `section`。工具的目的是把用户带到地方，不是校验模型拼的字符串。
- 成功后 Host 发 `settings-point`；UI 负责打开、滚动、高亮 2 秒。
- **`display`**：成功「已打开设置 · 连接」（段名用中文：AI / 连接 / 账户 / 高级）；`row_matched: false` 时同一句，不提行名。
- 无确认点、不 destructive。它与 `ConfigSetMode` 的区别：只指路，什么都不改。

---

### 4.51 `MyServerFailure`（创建失败详情，3.14.0 新增）

某台服务器这次创建/开通为什么失败。给舞台上的 **`AI 定位`** 按钮用。

```json
{
  "type": "object",
  "properties": { "serverId": { "type": "string", "minLength": 1 } },
  "required": ["serverId"],
  "additionalProperties": false
}
```

```ts
type MyServerFailureData = {
  server_id: string;
  name: string;
  region: string;
  plan: string;
  state: string;                       // MyServerState，见 commands.md §7.15
  failure: {
    stage: string;                     // 失败发生在哪一步，取值同 MyServerState
    code: string;
    message: string;                   // 控制面给的用户可读文本，不是堆栈
    retryable: boolean;
  } | null;
  order: { order_id: string; state: string; failure: { code: string; message: string; retryable: boolean } | null } | null;
  recent_events: Array<{ at: string; state: string; detail: string | null }>;  // 最多 20 条，新的在前
  log_available: false;                // 恒为 false，见下
};
```

- `PermissionLevel::ReadOnly`；只读 Host 已有的本地镜像与订单事件，不访问云厂商 API。
- **触发约束**：只在用户点了 `AI 定位`，或明确问「这次为什么失败」时调用。不得轮询、不得在状态未失败时调用（健康服务器返回 `failure: null` 也是合法结果，但问了才知道）。
- **没有建机原始日志**：控制面不保存构建日志（Worker / 实例侧日志已过期且不落库），`log_available` **恒为 `false`**。模型**不得声称读过日志**，不得让用户「上传日志」；能说的只有 `failure.stage` / `code` / `message` / `retryable` 与事件序列。
- `message` 是控制面生成的中文短句，**不要改写事实**；模型可以解释，不许编造更具体的原因（如「端口被封」）。
- 不返回 IP、端口、节点 id、密码、令牌。
- 服务器不存在 → `NOT_FOUND / server_not_found`。
- **`display`**：成功「读到了这次失败的记录」+ `facts` 放「阶段 · 原因 · 能不能重试」；失败「没读到失败详情，稍后再试」。

---

### 4.52 `StageSelect`（新建节点舞台选择，3.17.0 修订）

把地区 / 规格选进「新建节点」舞台。这是**唯一**一个「AI 写界面状态」的工具，只改选择，不建机。

```json
{
  "type": "object",
  "properties": {
    "region": { "type": "string", "minLength": 1, "maxLength": 40 },
    "plan": { "type": "string", "minLength": 1, "maxLength": 40 }
  },
  "anyOf": [{ "required": ["region"] }, { "required": ["plan"] }],
  "additionalProperties": false
}
```

```ts
type StageSelectData = {
  screen: "new_node";
  region: string | null;   // 本次请求给了才回，否则 null
  plan: string | null;     // 同上
};
```

- `PermissionLevel::Write`；**只改界面选择**：不写业务表、不建机、不扣费、不调用任何命令。
  **注意**：参数会落进 `tool_calls.args_json`（`001_init.sql:241`），这是审计记录，不是业务状态——不要说「什么都不落库」。
- **Host 没有舞台当前选择的镜像**：选择只存在于界面，`context.last_action.value` 只在用户当轮点过才有、请求结束即丢。所以：
  - 工具**只处理请求里出现的字段**，没出现的字段不读、不回；`data` 里对应位置是 `null`；
  - **没有 `changed` 字段**——Host 算不出来。是否变化由 UI 合并时自己判断，只用于决定是否高亮。
- **触发约束（两层）**：
  - **Host 强制**：同一会话同一轮最多成功一次，按 **`(工具名, session_id, current_turn)`** 去重；第二次 → `PRECONDITION_FAILED / already_called_this_turn`。
    - **键里必须带工具名**：`OpenSettings` 的 `claim_turn`（`settings.rs:101-108`）用的是 `(session_id, turn)`，且集合是 `settings.rs` 内部的私有静态量。直接共用会让「一轮内先 `OpenSettings` 再 `StageSelect`」互相顶掉。实现应把它提取成 Host 公共的一轮一次闸门（存放在 `tools` 模块，key 含工具名），两个工具各自调用；**不要**让 `StageSelect` 去借用 `settings.rs` 的那个集合。
    - **先校验、后占名额**：目录校验不通过（`unknown_region` / `unknown_plan`）**不占用本轮名额**，模型可以用正确 id 在同一轮重试。反之若先 claim 再校验，模型把「东京」当 id 试错一次就再也改不了。
  - **仅 advisory（模型自守，Host 不校验）**：用户没有表达选择意图时不得预选；只在用户说「帮我选 / 换成东京 / 用标准档」，或点了 `action_card` 对应按钮之后调用。Host 无从判断「意图」，不要假装它在强制。
- **校验在 Host（唯一可信处）**：请求里出现的 `region` / `plan` 必须在目录里；不在目录即拒绝。
  - 未知值 → `INVALID_ARGUMENT / unknown_region` / `unknown_plan`，整次拒绝、不发事件；
  - **地区与规格同时出现时，还必须是目录里的真实组合**（`plan.regions` 含该地区，2.38.0）：不满足 → `INVALID_ARGUMENT / plan_unavailable_in_region`，`details` 带 `region`、`plan`，整次拒绝、不发事件。**不假设「每个地区都能开每一档」**——真实数据里 sgp1 就没有 `s-1vcpu-1gb`；
  - 目录取不到 → **与 `CatalogOptions` 用同一组码**（`commands.md` §7.14：`TIMEOUT`、`UPSTREAM_ERROR / network|upstream_status|invalid_response`、`RATE_LIMITED`），不新造 `catalog_unavailable`。
- **调之前先拿 id**：必须先调 `CatalogOptions`（§4.53）拿到真实 id，禁止凭印象拼。模型嘴上说「东京」不算数，`region` 必须是目录里的 id。
- 成功后 Host 发 `stage-select`（`events.md` §4.26），`region` / `plan` 里未请求的字段为 `null`。**舞台可见且不在创建中时**，UI 按字段合并、缺省保持当前值，合并后高亮 1.5 秒——**成功不等于「一定高亮」**：Host 没有屏幕状态，事件完全可能在用户停在连接屏时到达并被 UI 丢掉，这是正常结果，不是失败。
- **舞台没打开 / 正在创建**：UI 忽略事件，不排队重放，对话里仍留工具卡——与 `settings-point`（`events.md` §4.25）同一口径。此时 `display` 不承诺「屏幕上已经变了」。
- **越权边界**：schema 里没有 `screen`、没有 config、没有命令字段——它只能改「新建节点」这一处选择。设置、接管方式、连接、服务器、布局都碰不到。要扩到别的舞台必须升版本并单独评审。
- **并发**：用户在事件到达前手动改了同一个字段 → 事件覆盖（用户让 AI 选，就不该再弹确认）；只改另一个字段时两边互不影响（UI 按字段合并）。
- **`display`**：成功「已把「东京」发给新建节点舞台」+ `facts` 放本次请求的字段；只给一个字段时只说那一个。**不要写「点「创建」就开」**——舞台可能没打开（上一行已说明），点了没得点；创建永远是用户自己的动作，工具不替它招手。

---

### 4.53 `CatalogOptions`（可选地区与规格，3.17.0 新增）

只读的建机目录：给模型真实 id，让它能把 `StageSelect` 说对。

```json
{ "type": "object", "properties": {}, "additionalProperties": false }
```

```ts
type CatalogOptionsData = {
  regions: Array<{ id: string; name: string; continent: string }>;   // 目录里的全部地区
  plans: Array<{ id: string; label: string; daily_price_cents: number; transfer_gib: number; regions: string[] }>;
};
```

- `PermissionLevel::ReadOnly`；8s 超时；与 `my_server_catalog`（`commands.md` §7.14）**共用同一个取数入口**（`VpnToolServices::server_catalog()`），**不做本地缓存**——每次现取，Worker 侧已有 5 分钟缓存兜住重复请求。
- **失败码与 §7.14 同一组，不许自编**：
  - 网络失败 → `UPSTREAM_ERROR`（`details.reason = "network"`，`retryable = true`）
  - 超时 → `TIMEOUT`（`reason = "timeout"`，`retryable = true`）
  - 5xx → `UPSTREAM_ERROR`（`reason = "upstream_status"`，`retryable = true`）
  - 429 → `RATE_LIMITED`（`reason = "rate_limited"`，`retryable = true`）
  - 其余非 2xx → `UPSTREAM_ERROR`（`reason = "upstream_status"`，`retryable = false`）
  - 响应缺字段 / 非法值 → `UPSTREAM_ERROR`（`reason = "invalid_response"`，`retryable = false`）
  
  失败时**不要**给出地区名或价格——没读到就是没读到，不许拿印象补一份。
- **只回 id、名称、大洲与套餐的展示字段**：`hourly_usd` / `monthly_usd` 是内部成本口径，不返回；IP、端口、凭据永不出现在这里。
- **`content` 携带完整可选清单**：地区逐个写成 `名称（id）`（可按大洲分组），规格逐个写成 `名称（id） 每天 $X.XX · 每月 N GB · 可用地区：…`，日价由 `daily_price_cents` 换算；可用地区严格取自 `plans[].regions`。文本受 2000 字符上限兜底，超长时末尾标注「已截断」。不输出原始 JSON、成本口径或 IP/端口/凭据；失败时不给地区名或价格。
- **可用性只由 `plans[].regions` 表达（2.38.0）**：每个档位带它真实可用的地区 id（`commands.md` §7.14），严格按这份数据说话；没列出的组合就是不能开，不要推断「应该都行」，也不要自己补一份可用性表。
- 触发：用户问「有哪些地区 / 多少钱」，或准备调 `StageSelect` 之前。不做「一轮最多一次」限制（只读）。
- `display`：成功「读到了可选地区与规格」+ `facts` 放地区数 / 套餐数；失败「没读到可选地区，稍后再试」。

---

### 4.54 `HttpCheck`（只读网页可达性，3.20.2 新增）

```json
{
  "type": "object",
  "properties": {
    "url": { "type": "string" },
    "timeout_ms": { "type": "integer", "minimum": 1000, "maximum": 15000, "default": 8000 }
  },
  "required": ["url"],
  "additionalProperties": false
}
```

```ts
type HttpCheckData = {
  url: string;
  via: "tunnel" | "direct";     // 经当前连接（含 TUN 系统接管）/ 进程直连
  status: number | null;        // 最终一跳的 HTTP 状态码；网络 / TLS 失败为 null
  elapsed_ms: number;
  redirects: number;            // 实际跟随的跳数（0–5）
  server: string | null;        // `server` 响应头原样
  cf_mitigated: string | null;  // `cf-mitigated` 响应头原样，如 "challenge"
  tls_ok: boolean;
  error: { code: string; message: string } | null;
};
```

- `PermissionLevel::ReadOnly`；工具描述：「访问一个网页地址，只读状态码与 Cloudflare 挑战标记。仅用于验证某个站点当前能不能打开。」
- **`via` 必须如实报告测量路径**：本机代理模式连接中 → 显式指向本地混合端口，报 `tunnel`；全部接管模式连接中 → 进程直连、但流量由系统层捕获，**同样报 `tunnel`**；未连接 → 直连，报 `direct`；**本机代理连接中但拿不到混合端口 → 退回直连并如实报 `direct`，不假装走了隧道**。模型**先看 `via` 再解释结果**：`direct` 下的 200 只代表本机能打开，不代表用户经 VPN 的体验，不能拿它反驳用户「打不开」的反馈。
- **网络 / TLS / DNS 解析失败都是工具成功返回**：`status: null`、`error.code = "HTTP_CHECK_FAILED"`，`message` 可直接转述；`tls_ok` 说明握手是否成功。**DNS 解析失败（域名不存在、解析超时）属于这一类**；只有「解析成功但地址落在私网」才是 `INVALID_ARGUMENT / private_address`。
- 参数非法、非 `https`、非 443、解析到私网 → `INVALID_ARGUMENT`（`details.reason` 取 `invalid_url` / `insecure_scheme` / `unsupported_port` / `private_address`）。
- **SSRF 约束（必须实现）**：只允许 `https://` 且端口 443；解析全部 A/AAAA，任一落在 loopback / 私网 / 链路本地 / ULA / 组播 / unspecified 即拒绝；跟随重定向最多 5 次，**每一跳重新解析并重新校验**（代理路径同样拒绝首跳私网解析）；不发 Cookie / Authorization / 请求体，只发 `User-Agent: Veyl-Check/1.0`；**只读响应头，正文根本不读**（64 KiB 上限只用于响应头）；直连路径（未连接 / TUN）把已校验地址 pin 给连接层并显式 `no_proxy`，rebinding 无效。
- **经本机代理（Proxy 连接中）时，目标最终由 sing-box 再解析，我们无法 pin**：该路径仍在每跳做静态解析校验，但存在 TOCTOU 窗口。窗口内最多造成**一次到私网 443 的连接尝试**——**正常情况下 TLS 证书不可能匹配**所请求的域名，握手即失败，**不能被用来读取**本机或内网的内容。例外：装了企业 MITM 根证书、且 TLS 检查盒正好在被 rebound 的私网地址上时，握手可能成功，但请求落在企业代理上，仍读不到内网内容。本工具只读响应头、只允许 https/443。
- **「读不到响应内容」不等于「什么也学不到」**：失败文案会区分「连接被拒 / 超时 / TLS 失败」，模型据此能判断某个内网地址的 443 是否通。这是**已接受的残余信息泄露**，不得把它写成「无信息泄露」。
- **错误文案不携带地址**：失败文案只给粗分类——`等响应超时` / `TLS 握手失败` / `连接没有建立（被拒绝或不可达）` / `响应无法解析` / `请求失败`——**不拼接底层库的原始错误串**，也不回解析到的地址。因此可推断的信息止于「该地址的 443 通不通」，不包含「解析到了哪个内网 IP」。
- **已知边界与重审触发条件**：一旦将来支持 `http` 或非 443 端口、读正文（哪怕一段）、或允许自定义请求头 / 方法，上述残余风险即不再成立，必须改为「探针专用入站 + 置顶规则 `{inbound:["probe-in"], ip_is_private, action:"reject"}`」。
- 超时 `timeout_ms` 取 1000–15000（默认 8000）；超时按 `HTTP_CHECK_FAILED` 返回，不重试。
- **`cf_mitigated` 只转述、不下结论**：值为 `challenge` 说明站点要求人机验证，**不能**据此说 VPN 没生效；它也与 `DiagRun.network.coverage` 无关——接管范围解释不了反机器人挑战（四组对照实验证伪）。
- 不做 POST、自定义头、Cookie、认证、任意端口、返回正文；不做重试、不做批量、不做 UI。
- `display`：成功「网页返回 200」+ `facts` 放状态码 / 耗时 / 跳转数 / `server`；有 `cf_mitigated` 时加一条「站点要求人机验证」；失败「没访问成功」+ `error.message`。

---

## 5. 工具间协作约定

### 5.1 标准连接链路

```
用 Veyl 免费节点：DefaultProfileStatus（空时 CatalogRefresh）→ NodeImportUrl / NodeCreate（省略 config_id，自动绑进全局配置）→ VpnConnect
其它节点：      NodeImportUrl / NodeCreate（自动绑定）→ VpnConnect
换节点：        NodeSwitch
```

> **「链路」不等于「自动执行」**：免费节点首次加入之后，**UI 与模型都不得自动 `VpnConnect` 或 `NodeSwitch`**——测速完停在 `未连接`，由用户自己点「连接」（`ai-first-product.md` §选中免费节点之后）；**「设为当前节点」只能发生在用户点「连接」的那一刻**。模型也不得把这条链路当成一次性脚本从头跑到尾；每一步都要对应用户当轮的明确意图。

`VpnConnect` **不隐式安装或下载运行时**：静默下载会让用户不知道自己的机器上多了一个二进制。也不隐式建节点——池里没有节点时报 `no_nodes`，由模型引导用户加节点（`NodeImportUrl` / `NodeCreate`）或刷新免费节点。全局配置由服务层在第一次绑定节点时懒创建，模型不参与。

### 5.2 幂等矩阵

| 工具 | 重复调用行为 |
|---|---|
| `RuntimeStatus` / `CoreListVersions` / `CatalogSearch` / `ConfigDetail` / `JobGet` / `OpenSettings` / `MyServers` / `MyServerFailure` / `HttpCheck` | 纯读取，天然幂等 |
| `NodeProbe` | 探测本身幂等；探不通时可能顺手停一次运行时（已停 → `ok: true`），重复调用无副作用 |
| `RuntimeStart` | 已 `running` 且目标一致 → `ok: true`，`already_running: true` |
| `RuntimeStop` / `VpnDisconnect` | 已 `idle` → `ok: true` |
| ~~`ConfigCreate`~~ | **3.18.0 起无此工具**；全局配置由服务层懒创建（`commands.md` §3.1） |
| `ConfigUpdate` | 参数与现状一致 → `ok: true`，不发事件 |
| ~~`ConfigDelete`~~ | **3.18.0 起无此工具**；全局配置不可删（命令层 `only_config`） |
| `RouteSetMode` | 目标模式与当前一致 → `ok: true`，不发事件 |
| `SetUserRegion` | 地区与当前 `user_region` 一致 → `ok: true`，不发事件 |
| `RouteTargetsSet` | 集合与现状一致 → `ok: true`，`route_revision` 不变 |
| `NodeImportUrl` / `NodeCreate` | 同 `(source, source_key)` → 不新建，计入 `skipped`（`duplicate`）；`data` 仍返回已有节点 |
| `NodeSwitch` | 目标就是当前节点 → `ok: true`，不发事件 |
| `CoreUpgrade` | 同目标版本已有任务 → `BUSY`，`details.job_id`；无新版本 → 成功且 `changed: false`，不建任务 |
| `VpnConnect` | 已连同一配置同一节点 → `ok: true`，不重复设置代理 |
| `StageSelect` | 同一会话同一轮第二次 → `PRECONDITION_FAILED / already_called_this_turn`（键含工具名，且校验失败不占名额）；同值与否由界面判断，Host 不比较 |

### 5.3 超时预算

| 工具 | 同步超时 |
|---|---|
| 只读工具 | 3s |
| `NodeProbe` | 20s（15s 探测含 8s 探针运行时启动 + 最多 5s 判定；判为已销毁后的 `runtime_stop` 在后台，不计入；探通了不检查） |
| `NodeImportUrl` | 15s（抓取 10s + 解析） |
| `CatalogOptions` | 8s（走缓存，必要时取一次目录） |
| `HttpCheck` | `timeout_ms`（默认 8s，最大 15s） |
| `RuntimeStart` | 15s（含 10s 启动） |
| `VpnConnect` | 30s |
| `RouteGet` / `CategoryList` / `RulesStatus` | 3s（本地读） |
| `RouteSetMode` | 15s（热切 5s；跨家族含断开重连） |
| `RouteTargetsSet` | 3s |
| `RuntimeStop` / `VpnDisconnect` | 10s |
| `CoreUpgrade` | 网络检查 + 返回 `job_id`，≤10s |

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
| `CoreInstall` 是否需要审批 | ~~恒需审批~~ → **已移除审批，直接执行**（2026-11-02 用户决定）；**3.4.0 起该工具本身已移除**，改为 UI 专用 `core_*` 命令 | §2.1、§4.7 |
| `VpnConnect` 入参 | 只有 `config_id`（省略用 active）；节点由 `NodeSwitch` 决定 | §4.11 |
| 配置 / 节点 / 问题工具的保留 | ~~全部保留~~ → **3.18.0 起配置类工具退出**：`ConfigList` / `ConfigCreate` / `ConfigDelete` 删除，`ConfigDetail` / `ConfigUpdate` / `ConfigSetMode` 保留；节点与问题工具不变 | §3 表 |
| `ConfigDelete` 是否允许删 active | ~~允许~~ → **3.18.0 起全局配置不可删**（`commands.md` §3.4） | §4.17 |
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

### 3.21.3（未发布，2026-11-19：`MyServers` 给已销毁的人话原因）

| # | 变更 | 类型 | 决议来源 |
|---|---|---|---|
| 1 | 本文件版本升到 `3.21.3`；§4.48 `MyServers` 对已销毁的行补 `destroyed_reason`（`billing_unpaid` → 「因余额不足停机删除」，其余 → 「已销毁」），内部 `failure` 置 null，不把 `failure_code` 交给模型；§4.23 注明 `ConfigDetail.unavailable_reason` 只到「已销毁」，分不清停机删除还是用户销毁 | 语义补充 | AI 要能回答「这个节点是不是到期/停机被销毁了」；镜像层没有 `failure_code`，实时列表才有 |

### 3.21.2（未发布，2026-11-19：节点问题以 `ConfigDetail` 为准）

| # | 变更 | 类型 | 决议来源 |
|---|---|---|---|
| 1 | 本文件版本升到 `3.21.2`；§4.21 `DefaultProfileStatus` 与 §4.23 `ConfigDetail` 补口径：回答「有几个节点 / 当前用哪个 / 某个能不能用」以 `ConfigDetail` 的 `nodes`（含 `source`、`unavailable_reason`）为准，`DefaultProfileStatus` 只代表免费节点缓存 | 语义补充 | 2026-11-19 真机：AI 只看免费节点缓存，把 3 个节点（含 1 个自建）答成「2 个免费节点」 |

### 3.21.1（未发布，2026-11-19：`NodeProbe` 不再纯只读）

| # | 变更 | 类型 | 决议来源 |
|---|---|---|---|
| 1 | 本文件版本升到 `3.21.1`；§2.1 `NodeProbe` 由 `ReadOnly` 改为 `Write`（风险中），§0 的只读清单与 §2.1 列表同步移除；§4.28 增「探不通时顺手检查服务器、已销毁则停运行时」，权限改 `Write` | 权限 / 语义 | 2.45.2 起探测失败会给「已停机销毁」的服务器停隧道，不能再算纯只读 |
| 2 | §5.2 幂等矩阵：`NodeProbe` 从「纯读取」一行移出，单列「探测幂等；探不通时可能顺手停一次运行时，重复调用无副作用」 | 约束 | 同上 |
| 3 | §5.3 超时：`NodeProbe` 由 15s 改为 **20s（15s 探测 + 最多 5s 判定；判为已销毁后的 `runtime_stop` 丢后台，不计入）**；探测成功不检查，仍是 15s | 约束 | 同上 |

### 3.21.0（未发布：随 AI 自查第一批统一升版）

| # | 变更 | 类型 | 决议来源 |
|---|---|---|---|
| 1 | §4.13 `DiagCheck` 增 `status: "ok" \| "failed" \| "skipped"`；`ok` 保留为**兼容字段**（语义恒等于 `status == "ok"`）。`DiagReport.summary` 增 `skipped`，并写明 `ok + failed + skipped = total` | 字段扩展 | TUN 模式下部分检查不适用，不能记成失败 |
| 2 | 新增「`skipped` 的语义」：不是错误、**不计入 `failed`**、`remediation` 与 `action` 必须为 `null`；界面不得用失败色；模型只能说「这项没检查」，不得说「坏了 / 不可用」 | 语义澄清 | 不适用 ≠ 坏 |
| 3 | 新增各模式适用表：代理模式五项适用（`network.exit_ip` 未探测到算 `skipped`）；TUN 下 `app.process_alive` / `app.data_plane` 适用，`app.clash_api` 与 `network.exit_ip` 为 `skipped`（无探测通道 / 不采集出口 IP），`system.proxy_services` 为 `skipped` 但**残留指向未监听端口仍 `failed`**；未连接 / 连接中除 `system.proxy_services`（照常检查）外一律 `skipped` | 语义澄清 | 「不适用」必须有一个不撒谎的表示 |
| 4 | 新增文案禁区：未连接与连接中不得出现「进程未运行」「控制面不可用」；TUN 下不得出现「sing-box 进程未运行」 | 文案约束 | 这些是 `skipped`，不是失败；说成失败会让用户以为坏了 |
| 5 | §4.53 `CatalogOptions`：`content` 改为携带完整可选清单（地区 `名称（id）`、规格含日价与 `plans[].regions` 的可用地区），受 2000 字符上限截断并在末尾标注「已截断」；`display` 文案与 facts 不变 | 模型可见内容 | 模型此前只拿到数量，无法推荐或合法调用 `StageSelect`；§1.2 要求 `content` 自足 |

### 3.20.2（未发布：随 AI 自查第一批统一升版）

| # | 变更 | 类型 | 决议来源 |
|---|---|---|---|
| 1 | §4.13 `DiagRun` 新增 `network.coverage` 检查，`DiagAction` 增 `{ kind: "switch_mode"; to: "tun" \| "system_proxy" }`：全部接管 + running → `ok`；本机代理 + running → 不通过并给 `switch_mode`；未连接 → `ok` +「先连接」。结论**只用于「UDP / QUIC 应用不通」**，不得用来解释反机器人挑战；`remediation` 用「切到全部接管」，内部值只出现在 `action.to` | 字段扩展 | AI 自查第一批 T2；四组对照实验证伪「切全部接管就能过挑战」；判定收敛为 `(connected, tun)` 两参数——**接管方式由实际连接类型决定**，不再有「读不到模式」态；**删除不可达的「读不到接管方式」分支**——该分支在唯一触发场景里实际覆盖是已知的（本机代理），回「读不到」是错误结论；留一个会说假话的分支比少一个更糟 |
| 2 | §3 工具总表 39 → 40、§3.1 注册清单加 `HttpCheckTool`、新增 §4.54 `HttpCheck`（原计划 §4.53，因被 `CatalogOptions` 占用改为 §4.54）：返回 `url / via / status / elapsed_ms / redirects / server / cf_mitigated / tls_ok / error`；`via` 如实报告走隧道还是直连（全部接管下进程直连也算 `tunnel`；本机代理但拿不到混合端口则退回直连并报 `direct`）；直连的 200 不代表用户经 VPN 的体验；DNS 解析失败归 `HTTP_CHECK_FAILED`，只有解析成功落私网才是 `private_address`；只允许 `https` + 443，解析全部 A/AAAA 并拒私网，重定向逐跳复核，**只读响应头、正文不读**，直连时 pin 已校验 IP 并 `no_proxy`；**已知边界：经本机代理时不做 pin，rebinding 有 TOCTOU 窗口，重审触发条件见 §4.54**，`ReadOnly` | 新增工具 | AI 自查第一批 T4；在错误的路径上得到正确的数字会得出相反结论 |
| 3 | §5.2 / §5.3 同步：`HttpCheck` 计入纯读取幂等；超时按 `timeout_ms`（默认 8s，最大 15s） | 元数据 | 同 2 |

### 3.20.1（2026-11-18，`RuntimeStart` 补被取代启动的收尾）

| # | 变更 | 类型 | 决议来源 |
|---|---|---|---|
| 1 | `contract_version` 升到 `3.20.1`；§4.2 错误列表补 `INTERNAL`，并写明被取代启动的收尾：收尾成功是 `PRECONDITION_FAILED / cancelled`（不要重试），收尾失败带 `details.connect_changed = "unknown"`，按「不确定有没有改动」转述、不得说「已断开」 | 错误语义 | `commands.md` §7.1（2.43.1）新增的结局；模型侧此前没有对应说法 |

### 3.20.0（2026-11-18，`NodeProbe` 唯一 Clash 口径）

| # | 变更 | 类型 | 决议来源 |
|---|---|---|---|
| 1 | `contract_version` 升到 `3.20.0`；§4.28 `NodeProbe` 删除「其余情况走 TCP 握手」，改为唯一 Clash `/proxies/node-<id>/delay`（空闲时先起 8 秒上限的临时探针运行时） | 语义变更 | 产品否掉裸 TCP：端口活着不等于经代理能通 |
| 2 | §4.28 写明 `status` 三态：`untested` 时工具仍是 `ok: true`、`reachable = null`，模型不得说成不可达；`unreachable` 才是真的没通 | 语义澄清 | 没测成与连不通必须分开 |
| 3 | §7 超时表 `NodeProbe` 由 5s（TCP 3s + 余量）改为 **15s（含 8s 探针运行时启动）** | 约束 | 覆盖临时运行时冷启动 |

### 3.19.0（2026-11-18，地区 × 档位按目录真实数据）

| # | 变更 | 类型 | 决议来源 |
|---|---|---|---|
| 1 | `contract_version` 升到 `3.19.0`；`CatalogOptionsData.plans[]` 增 `regions: string[]`（该档位真实可用的地区 id，`commands.md` §7.14 同步）；删掉「目录没有可用性字段」的旧说法 | 数据结构 | 2026-11-18 建机 422：不能假设 DO 偏好处处一样 |
| 2 | §4.52 `StageSelect`：地区与规格同时出现时按 `plan.regions` 校验组合，不满足 → `INVALID_ARGUMENT / plan_unavailable_in_region`（`details` 带 `region`、`plan`），不占本轮名额 | 校验收紧 | 同上；与 Worker 的扣费前校验同一口径 |

### 3.18.0（2026-11-17，配置类工具退出 AI 工具集）

| # | 变更 | 类型 | 决议来源 |
|---|---|---|---|
| 1 | `contract_version` 升到 `3.18.0`；`ConfigList` / `ConfigCreate` / `ConfigDelete` 从 §3 工具总表与 §3.1 注册清单删除（`ConfigActivate` 本就无工具入口），工具总数 42 → 39；保留空壳章节 §4.9 / §4.17 / §4.24 避免编号错位 | 删除工具 | 全局单配置（`global-config-merge.md`）；PM 与后端对齐 |
| 2 | 模型不再有「列配置 / 新建配置 / 删配置」的路径；加节点走 `NodeCreate` / `NodeImportUrl` / `NodeImportText`，绑定由服务层完成；读唯一配置用 `ConfigDetail` | 语义收紧 | 同上 |

### 3.17.5（2026-11-17，接管方式用词统一）

| # | 变更 | 类型 | 决议来源 |
|---|---|---|---|
| 1 | `contract_version` 升到 `3.17.5`；§4.49 `ConfigSetMode` 的确认卡正文与 `display` 文案统一改成 **`Tun 模式` / `Proxy 模式`**，不再用「全部软件 / 本机代理」；理由是产品负责人同日定稿：界面与 AI 对同一个值只能有一个名字（`stage-quick-toggles.md` §3.1） | 文案统一 | 产品决定 |

### 3.17.4（2026-11-17，当前节点为空的读取口径）

| # | 变更 | 类型 | 决议来源 |
|---|---|---|---|
| 1 | `contract_version` 升到 `3.17.4`；§4.23 `ConfigDetail` 写明 `current_node_id` 可能为 `null`（seed 新建、节点全删），不代表没有节点；`nodes` / `node_count` 照实返回，模型不得说「还没有节点」，也不得自行补 `NodeSwitch` | 语义补全 | 评审：空值读取方要有一致表现 |

### 3.17.3（2026-11-17，预选不写库）

| # | 变更 | 类型 | 决议来源 |
|---|---|---|---|
| 1 | `contract_version` 升到 `3.17.3`；§5.1 的禁止扩到 **UI 与模型都不得自动 `VpnConnect` 或 `NodeSwitch`**，「设为当前」只能发生在用户点「连接」那一刻（原来只挡了 `VpnConnect`，且只约束模型） | 约束收紧 | 评审 ① |
| 2 | §4.24 `ConfigCreate` 补一条：`source = "seed"` 的新建 `current_node_id` 留空，最快的那台由界面预选、**预选不写库**；连接时先 `NodeSwitch` 再 `RuntimeStart`，模型不得自行补步骤 | 语义补全 | 评审 ②：与 `commands.md` §3.2「取第一个」冲突 |

### 3.17.2（2026-11-17，免费节点不自动连接）

| # | 变更 | 类型 | 决议来源 |
|---|---|---|---|
| 1 | `contract_version` 升到 `3.17.2`；§5.1 加一条「链路不等于自动执行」：`ConfigCreate(source = "seed")` 之后不得自动 `VpnConnect`，测速完停在未连接，由用户点「连接」 | 约束新增 | 产品负责人真机测试：免费服务器质量不保证，自动连上层会直接影响用户网络 |

### 3.17.1（2026-11-17，目录来源与名额口径收口）

| # | 变更 | 类型 | 决议来源 |
|---|---|---|---|
| 1 | `contract_version` 升到 `3.17.1`；§3.1 注册清单的目录变量改名 `server_catalog`，与共享节点目录的 `catalog`（`CatalogClient`）区分；删除「5 分钟 TTL 本地缓存实例」的说法，改为与 `my_server_catalog` 共用取数入口、不做本地缓存（与 `commands.md` §7.14 一致） | 约束修正 | 复审 P1 |
| 2 | §4.52 一轮一次的名额：键改为 `(工具名, session_id, current_turn)`，不得直接复用 `settings.rs` 里只带 session+turn 的集合；错误码 `already_selected` → `already_called_this_turn`；**先校验、后占名额**，校验失败不占名额 | 语义修正 | 复审 P2 |
| 3 | §4.53 补失败语义：与 `commands.md` §7.14 同一组码，不新造 `catalog_unavailable`；失败时不得凭印象补地区或价格 | 语义补全 | 复审 P2 |
| 4 | §4.52 `display` 去掉「点「创建」就开」 | 措辞修正 | 复审 P2 |
| 5 | §4.52 高亮改为条件行为：只有**舞台可见且不在创建中**时才合并并高亮 1.5 秒；成功不等于一定高亮（Host 没有屏幕状态，事件可能在用户停在连接屏时到达并被忽略），与 `events.md` §4.26（2.16.2）同一口径 | 语义澄清 | 复审 |

### 3.17.0（2026-11-17，让模型能说对地区与套餐）

| # | 变更 | 类型 | 决议来源 |
|---|---|---|---|
| 1 | 新增 §4.53 `CatalogOptions`（`ReadOnly`）：只回地区与套餐的 id / 名称 / 日价，与 `my_server_catalog` 共用目录来源；总数 41 → **42** | 新增工具 | 评审 P1-2：模型不知道目录里有哪些 id |
| 2 | §4.52 `StageSelect` 修订：输入与返回改为部分字段（未请求的为 `null`），**删除 `changed`**——Host 没有舞台当前选择的镜像，算不出来 | 语义修正 | 评审 P1-1 |
| 3 | 注册行写死依赖：`StageSelectTool::new(...)` / `CatalogOptionsTool::new(...)`，目录由 `VpnToolServices` 提供 | 约束 | 评审 P1-3 |
| 4 | 「一轮最多一次」改为 Host 强制，第二次 → `PRECONDITION_FAILED`（码名与名额口径在 3.17.1 修正）；「用户没表达意图不得预选」明确为 advisory，Host 不校验 | 约束澄清 | 评审附带项 |
| 5 | 目录没有「可用」字段：改写为「不在目录即拒绝」；「不落库」改写为「不写业务表」，参数会进 `tool_calls.args_json` | 措辞修正 | 同上 |

### 3.16.0（2026-11-17，AI 替用户选好地区与规格）

| # | 变更 | 类型 | 决议来源 |
|---|---|---|---|
| 1 | `contract_version` 升到 `3.16.0`；新增 §4.52 `StageSelect`（`Write`、低风险）：把地区 / 规格选进新建节点舞台，只改界面选择，不建机、不扣费、不落库 | 新增工具 | 设计文档要求「让 AI 帮我选」 |
| 2 | 校验在 Host：地区与套餐必须来自 `my_server_catalog` 且可用；未知值整次拒绝、一个字段都不改；同值幂等、不发事件 | 约束 | 模型不能凭空指定地区 |
| 3 | 越权边界：schema 没有 `screen` / config / 命令字段，只能改「新建节点」这一处选择；扩别的舞台要升版本单独评审 | 约束 | 唯一一条 AI→UI 写通道 |
| 4 | 成功后发 `stage-select`（`events.md` §4.26）；工具总数 40 → **41**，`TOOL_COPY` 同步 | 元数据 | 同批 |

### 3.15.0（2026-11-17，裁掉 11 个从未实现的工具）

| # | 变更 | 类型 | 决议来源 |
|---|---|---|---|
| 1 | `contract_version` 升到 `3.15.0`；工具总数 51 → **40**，`TOOL_COPY` 集合同步 | 元数据 | 设计对齐审计 |
| 2 | 移除 `ProxyParams`：代理地址只在设置里出现，AI 读本机代理用 `NetConfigGet` | 删除工具 | 新 IA 无第二处地址 |
| 3 | 移除 `ProbeRun`：连接后探测由运行时内部完成，失败项由 `DiagRun` 读出 | 删除工具 | 不让模型主动发起探测 |
| 4 | 移除 `IssueList` / `IssueGet` / `IssueHandoff` / `IssueResolve` / `IssueIgnore`：新设计没有 issue 列表界面，故障只以 `issue_card` 叠加，诊断走 `DiagRun` | 删除工具 | 无界面承载 |
| 5 | 移除 `RuleCustomList` / `RuleCustomAdd` / `RuleCustomDelete`：新设计只有「智能 / 全局」两档，没有自定义直连规则 | 删除工具 | 无界面承载 |
| 6 | 移除 `RulesUpdate`：规则数据随包预置，设置里没有更新入口，更新不交给模型 | 删除工具 | 离线预置 |
| 7 | 11 个命令全部保留（`proxy_params` / `probe_run` / `issue_*` / `rule_custom_*` / `rules_update`），只是不再有 AI 入口 | 说明 | 与 `commands.md` 不冲突 |

### 3.14.0（2026-11-16，设置指路与创建失败详情）

| # | 变更 | 类型 | 决议来源 |
|---|---|---|---|
| 1 | `contract_version` 升到 `3.14.0`；新增 §4.50 `OpenSettings`（`ReadOnly`）：打开设置并指向某段/某行，不改任何值；一轮最多一次；未知 `row` 降级为 `null` 不报错；成功后发 `settings-point` | 新增工具 | `ai-first-product.md` §全局配置与设置 |
| 2 | 新增 §4.51 `MyServerFailure`（`ReadOnly`）：返回某台服务器的结构化失败、订单失败与最近 20 条订单事件；`log_available` 恒为 `false`，模型不得声称读过日志 | 新增工具 | `ai-first-product.md` §新建节点 的 `AI 定位` |
| 3 | 布局词汇扩一种 `action_card`（`events.md` §4.13）：点击只上报 `action_id`，不执行命令 | 语义扩展 | UI 与 AI 共用操作面 |
| 4 | 工具总数 49 → **51**；§3.1 注册清单补上此前漏掉的 `ConfigSetModeTool`，并加入两个新工具；`TOOL_COPY` 键集合同步 51 | 元数据 | 同批 |
| 5 | `trial_status` 列入「UI 专用命令不注册工具」 | 说明 | `commands.md` §7.19 |

### 3.13.0（2026-11-16，在线切换接管方式）

| # | 变更 | 类型 | 决议来源 |
|---|---|---|---|
| 1 | `contract_version` 升到 `3.13.0`；新增 §4.49 `ConfigSetMode`（`Execute`、高风险、**有确认点**）：把配置的接管方式在 `system_proxy` ↔ `tun` 之间在线切换，会断开重连 | 新增工具 | `commands.md` §3.7、产品要求主界面一个开关 |
| 2 | 确认卡复用 `AskUserQuestion` 阻塞通道，`kind = "config_set_mode_confirm"`；默认焦点「取消」，`Esc`/超时=取消；未连接不弹卡；模型不能代答 | 约束 | 断线必须由用户明确同意 |
| 3 | 工具描述写死触发约束：**只在用户明确要求更换接管方式时调用**，不得为了「优化」或在排障时顺手切换 | 约束 | 模型不得自行改网络模式 |
| 4 | 边界：目标配置非当前连接 → 只写库；同值 → 不停连接；回滚失败 → `restored: false` 且 `display` 必须说「现在是断开状态」；并发 → `CONFLICT / switch_in_progress` | 约束 | 审阅员复核补充 |
| 5 | 工具总数 48 → **49**；`TOOL_COPY` 键集合与 §3 表同步；`tools/envelope.rs::CONTRACT_VERSION` 同步 3.13.0 | 元数据 | 同批 |

### 3.12.0（2026-11-14，我的服务器只读工具）

| # | 变更 | 类型 | 决议来源 |
|---|---|---|---|
| 1 | `contract_version` 升到 `3.12.0`；新增 §4.48 `MyServers`（`ReadOnly`）：列出我的服务器与状态，不返回 IP、端口、节点 id、密码 | 新增工具 | `docs/design/my-servers.md` §19.9 / §10.5 |
| 2 | **不新增**购买 / 销毁 / 凭据工具；这些只能由用户点界面 | 明确不做 | §10.5 |
| 3 | 实现侧常量 `tools/envelope.rs::CONTRACT_VERSION` 同步 3.12.0 | 元数据 | 同批 |

### 3.11.0（2026-11-13，连接前自动停旧连接）

| # | 变更 | 类型 | 决议来源 |
|---|---|---|---|
| 1 | `contract_version` 升到 `3.11.0` | 元数据 | `RuntimeStart` / `VpnConnect` 语义变更 |
| 2 | `RuntimeStart` 与 `VpnConnect` 在目标为另一套配置时**先停旧连接再启动**，删除 `PRECONDITION_FAILED / other_config_running`；模型不再需要先断开或调用 `ConfigActivate` 收口 | 语义变更 | 用户：切换配置不断开，点连接时才断旧连接 |
| 3 | `ConfigActivate` 只改 active、不重连（`commands.md` 2.20.0）；工具侧路径不受影响 | 说明 | 同批 |

### 3.10.1（2026-11-12，解释门禁）

| # | 变更 | 类型 | 决议来源 |
|---|---|---|---|
| 1 | `contract_version` 升到 `3.10.1` | 元数据 | `ConfigCreate` 增解释门禁 |
| 2 | §4.24 错误原因新增 `PRECONDITION_FAILED / explanation_pending`：本请求收到过解释串、用户尚未选择，禁止建配置；模型应把原问题重问，不得重试绕过 | 约束 | 评审：解释入口需要 Host 兜底 |
| 3 | §4.22 解释行明确只挂在设置类卡片，确认卡（`创建` / `取消`）不显示 | 说明 | 同一评审：确认卡没有设置可解释 |
| 4 | **本批新增**：§4.27 `NodeSwitch` 与 §4.37 `RouteSetMode` 新增 `PRECONDITION_FAILED / config_unknown`——连接在跑但读不到它属于哪套配置（重启后接手 TUN），与 `config_not_running`（身份已知）区分；`connected_config_id` 在 `will_disconnect` 上可为 null 的说明只属于 `config_activate`（`commands.md` §4.2），这两条工具的错误载荷没有该字段 | 错误细分 | 本批新增 reason（仅错误细分、不改协议字段、不升版本） |
| 5 | **文档更正**：删掉幽灵 reason `tun_helper_missing`（实现从不产出）；`RuntimeStart` 的助手不可用改用实际取值 `tun_denied` / `helper_missing`（`commands.md` §7.1 的完整取值表） | 文档更正 | 按实现对齐；协议不变、不升版本 |

### 3.10.0（2026-11-12，新增 `SetUserRegion` 地区写入）

| # | 变更 | 类型 | 决议来源 |
|---|---|---|---|
| 1 | `contract_version` 升到 `3.10.0`；工具总数 46 → 47 | 元数据 | 地区链路（`docs/design/simplified-config-create.md` §14） |
| 2 | 新增 §4.47 `SetUserRegion { region }`：写 `settings.user_region`，`PermissionLevel::Write`，是地区唯一的写入路径 | 工具新增 | 系统推断无法被用户修正；用户只能在对话里纠正，AI 负责写入 |
| 3 | 校验：两字母 ISO 码、规范化为小写，非法 → `INVALID_ARGUMENT / invalid_region`；同值重复写入不发事件 | 约束 | 地区取值直接决定本地直连层，不能接受模糊输入 |
| 4 | 写入成功发 `region-changed`（`events.md` 2.12.0）；只影响下次建连，不重连 | 联动 | 已连接时不能打断用户；界面必须说清「下次生效」 |
| 5 | `TOOL_COPY` 键集合要求同步到 47 个（实现侧待补 `SetUserRegion`） | 元数据 | 少一个名字，新工具就会露出原始名 |
| 6 | **不向后兼容**：`ConfigCreate` / `ConfigUpdate` / `RouteSetMode` 的 schema 只收 `direct \| proxy_all`；`proxy_selected` → `INVALID_ARGUMENT / routing_mode_not_supported`，未知值 → `invalid_routing_mode`；`targets` 参数保留但无效果 | 枚举收紧 | 产品拍板界面只有两档；数据层留旧值 |
| 7 | **不向后兼容**：`ConfigCreate` 的 `source` 或非空 `node_ids` 必须给一个（schema `anyOf` + `minItems: 1`）；都缺、`source = "empty"`、空数组 → `source_required`。AI 不再允许创建空配置 | 语义收紧 | 两问流程必有一个来源 |
| 8 | §4.22 补一行：带选项卡片底部的 `解释这个设置的含义` 由 UI 提供，回传文本原样透传，工具层不感知 | 说明 | 与 `commands.md` §9.6 同批；版本不变 |

### 3.9.0（2026-11-12，新增 `IssueReport` 问题报告）

| # | 变更 | 类型 | 决议来源 |
|---|---|---|---|
| 1 | `contract_version` 升到 `3.9.0`；工具总数 45 → 46 | 元数据 | — |
| 2 | 新增 §4.46 `IssueReport { log_lines?, include_domains?, report_markdown? }`：两阶段（收集 / 写入），只写固定报告目录，`PermissionLevel::Write`，不改配置、不碰网络。脱敏默认**保留可注册域**（`***.google.com`），唯一占位符 `***` | 工具新增 | 用户要把「发现的问题 + 关键日志」整理成可发出去的材料；设计见 `docs/design/issue-report.md` |
| 3 | `include_domains` 是 boolean，**省略 = 遵循本地设置 `issue_report_include_domains`**（不接受 `null`）；显式 `false` = 模型主动收窄；显式 `true` 不能放宽。设置唯一写入路径是 `commands.md` §7.12 的 `issue_report_preference` | 安全约束 | 模型不得自行放宽披露；省略若按 `false` 处理会让用户开关失效 |
| 4 | 工具不接受任何路径参数（`additionalProperties: false`）；越界调用在 schema 层失败，不落盘。`log_lines` 越界同样拒绝（`log_lines_out_of_range`），不静默夹取 | 安全约束 | 只读边界靠参数形状保证；夹取会让报告里的证据行号错位 |
| 5 | 新增 `display.actions` 两种动作（`reveal_report_dir` / `compose_report_mail`，只带 `report_id`）——定义在 `events.md` §3.4（2.11.0）；**收集阶段成功即给**，不等到写入阶段 | 联动 | 会话里要出现「在文件夹中显示 / 打开发送邮件」；AI 失败时材料已齐，用户仍要能发 |

### 3.8.0（2026-11-07，新增 `NodeImportText`）

| # | 变更 | 类型 | 决议来源 |
|---|---|---|---|
| 1 | `contract_version` 升到 `3.8.0`；工具总数 44 → 45 | 元数据 | — |
| 2 | 新增 §4.10.1 `NodeImportText { text, config_id? }`：解析用户直接粘贴的 `ss://`，与 UI 的 `node_import_text` 共用服务层实现；写操作，`PermissionLevel::Write`，与 `ConfigCreate` 同档 | 工具新增 | 用户从「AI 协助」进来贴链接，不能被踢回手工表单；AI 侧此前没有对应工具 |

### 3.7.1（2026-11-07，`NodeCreate` 错误原因对齐实现）

| # | 变更 | 类型 | 决议来源 |
|---|---|---|---|
| 1 | `contract_version` 升到 `3.7.1`；工具总数不变（仍 44 个） | 元数据 | — |
| 2 | §4.26 `NodeCreate` 的错误原因改为实际行为：`invalid_argument` / `unsupported_method`；细分校验交给调用方，并写明 `port` 越界在反序列化阶段失败 | 更正 | 契约承诺的 `invalid_name` / `invalid_server` / `invalid_port` / `invalid_password` 实现从未返回过 |

### 3.7.0（2026-11-06，端口改为用户设置）

| # | 变更 | 类型 | 决议来源 |
|---|---|---|---|
| 1 | `contract_version` 升到 `3.7.0`；工具总数不变（仍 44 个） | 元数据 | 端口设置只有 UI 命令，不加工具 |
| 2 | `ConfigCreate` / `ConfigUpdate` 的 schema 删除 `listen_port`；传了会被 `additionalProperties: false` 拒绝 | 参数删除 | 只要 AI 还能写配置端口，用户在设置里改的值就会静默不生效 |
| 3 | 端口只有一个来源：用户设置（`commands.md` §7.11）；工具不提供改端口的能力 | 约束 | — |

### 3.6.1（2026-11-06，`NodeProbe` 单测边界）

| # | 变更 | 类型 | 决议来源 |
|---|---|---|---|
| 1 | `contract_version` 升到 `3.6.1`；工具总数不变（仍 44 个） | 元数据 | 批量测速只有 UI 命令，不加工具 |
| 2 | §4.28 `NodeProbe` 补一句「一次只测一个；批量测速是 UI 专用，不要循环调用模拟批量」 | 约束 | 防止模型用单测循环代替批量，把界面尺度操作变成工具调用 |
| 3 | §1.3 明确 `ToolEnvelope` **不含 `display`**：用户文案只走 `tool-call-end.display` | 约束 | 信封是给模型的，卡片文案是给用户的 |

### 3.6.0（2026-11-06，面向用户的表达）

| # | 变更 | 类型 | 决议来源 |
|---|---|---|---|
| 1 | `contract_version` 升到 `3.6.0` | 元数据 | 工具调用要按用户语言展示，而不是模型措辞 |
| 2 | 新增 §2.4「面向用户的表达」：7 条提示词规则（不叙述工具调用、不出现内部术语与 ID、失败三段式、长流程分阶段、问技术才用术语），并明确规则同时落在系统提示与工具 description | 新增 | 产品负责人 2026-11-06 |
| 3 | 声明前端映射表 `src/components/toolDisplay.ts`（`TOOL_COPY`）的键集合必须与 §3 的 44 个工具名双向相等；`AskUserQuestion` 虽在表中，渲染层必须跳过它的工具行 | 约束 | 缺一个名字就意味着新工具会露出原始名 |
| 4 | 注明渲染层是最终闸门：UI 不渲染工具名、JSON、错误码；不做输出正则改写；running 文案不得拼工具名；description 约束必须放在 `\n` 之后，第一行保持能力清单可用 | 约束 | 提示词只降低概率 |
| 5 | 「怎么说话」八条、`SAFETY_RULES` 新增两条、危险工具 description 的正反位置、未知工具「正在处理…」纳入契约测试，删任一条即红 | 测试 | 防回归，不是防写错 |

### 3.5.0（2026-11-05，AI 代劳升级 `CoreUpgrade`）

| # | 变更 | 类型 | 决议来源 |
|---|---|---|---|
| 1 | `contract_version` 升到 `3.5.0`；工具总数 43 → 44 | 元数据 | AI 代劳升级定稿 |
| 2 | 新增 `CoreUpgrade`（`Execute`，高风险）：参数只有可选 `version`；`url` / `sha256` / `size` / `force` → `INVALID_ARGUMENT` | 新增工具 | 产品负责人 2026-11-05 |
| 3 | 新增 §4.45：调用顺序三段验收句（先查网络、只对 `NETWORK_UNREACHABLE` 重试一次、只对更高版本弹卡）、确认卡协议、所有回复带 `active_version` 与 `changed` | 新增 | 同上 |
| 4 | 声明它是**唯一有确认点的工具**：复用 `AskUserQuestion` 阻塞通道（Host 填 `kind: "core_upgrade_confirm"`），**不恢复** `ApprovalPolicy` 等旧审批框架 | 约束 | 同上 |
| 5 | 错误码补 `SIGNATURE_INVALID`、`CANCELLED` | 错误码 | 签名校验失败与用户拒绝是两条不同路径 |
| 6 | `JobGet.kind` 的 `Job` 增必填 `origin: "ui" \| "agent"`（旧记录按 `"ui"`）；§5.2 / §5.3 增 `CoreUpgrade` 行 | 字段扩展 | UI 与 Agent 发起的任务要能区分 |

### 3.4.1（2026-11-05，UI 专用命令说明）

| # | 变更 | 类型 | 决议来源 |
|---|---|---|---|
| 1 | `contract_version` 升到 `3.4.1` | 元数据 | 文档补充 |
| 2 | §3 明确 `core_*` 五条与 `tun_helper_info` / `tun_helper_restart` 为 UI 专用命令，不注册 AI 工具 | 说明 | 产品负责人 2026-11-05：替换运行时、重启特权组件都不能交给模型 |
| 3 | 工具集本身不变，仍是 43 个 | 确认 | 同上 |

### 3.4.0（2026-11-05，移除 `CoreInstall`）

| # | 变更 | 类型 | 决议来源 |
|---|---|---|---|
| 1 | `contract_version` 升到 `3.4.0` | 元数据 | AI 边界收紧 |
| 2 | 从 §3 工具总表与 §3.1 注册清单删除 `CoreInstall`；工具总数 44 → 43 | 删除工具 | PM 2026-11-05：下载并替换特权二进制必须由用户显式触发 |
| 3 | `CoreListVersions` 保留，仍是只读工具 | 确认 | 同上；它不下载、不安装 |
| 4 | §4.7 改为空壳章节，指向 UI 专用命令 `core_*`（`commands.md` §7.10） | 说明 | 保留编号，避免跨文件引用错位 |
| 5 | 同步移除 §2.1 风险表、§2.1.1、§3.2、§5.2 幂等矩阵、§5.3 超时表中的 `CoreInstall` | 一致性 | 工具不存在了，语义不能留在表里 |
| 6 | `JobGet.kind` 增加 `core_upgrade`；`core_install` 保留为历史任务的取值 | 字段扩展 | 升级是长任务，`JobGet` 要能认 |

### 3.3.0（2026-11-05，`VpnConnect` 的返回类型对齐真实快照）

| # | 变更 | 类型 | 决议来源 |
|---|---|---|---|
| 1 | `contract_version` 升到 `3.3.0` | 元数据 | 返回类型从 7 个字段扩到整份快照，属字段扩展 |
| 2 | §4.11 `VpnConnectData` 改为 `RuntimeSnapshot & { ... }`，不再手抄字段表 | 类型修正 | 实现返回的就是 `RuntimeStatus` 序列化 + 一个顶层 `exit_ip`，契约比实现窄，模型照契约写会漏读 `node_latency_ms` / `direct_ip` / `traffic` 等字段 |
| 3 | 单独写出 `tun` 分支的 `TunConnectData`，并注明它**不是**快照、缺 `health` / `traffic` / 延迟等字段 | 缺口登记 | TUN 走的是另一条手拼 JSON 的路径，不写清会让模型读到 `undefined` |
| 4 | 明确 `node_latency_ms`（Clash delay，节点延迟）与 `latency_ms`（出口探测耗时）不同源、不得互相填充 | 语义 | 产品：面板上的「2098 毫秒」不是节点快慢 |
| 5 | 补 `node_latency_ms = null` 的含义：还没测到，不代表节点不可用 | 说明 | 与 `exit_ip = null` 同一条原则 |
| 6 | 顶层 `exit_ip` 与 `health.exit_ip` 的区别写清：前者是「等 3s 仍没有就 null」，判定连接成功仍只看 `state` | 说明 | 防止模型把「出口未知」判成失败 |

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

> 只读工具的判定以 §2.1 的列表为准；`NodeProbe` 是只读，即使它会发起网络请求。

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
