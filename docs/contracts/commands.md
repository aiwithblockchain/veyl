# 契约：UI → Host 命令（invoke）

> 契约版本：`2.17.0`
> 状态：已定稿（批 0 + 批 3，2026-11-04）
> 上游：`docs/implementation-plan.md` 批 1、`docs/configs-and-nav.md`、`docs/config-execution.md`、`docs/center-panel.md` §2.5.1、`docs/issue-management.md`、`docs/capabilities.md`
> 相关：`events.md`（Host → UI 的反向通道）、`data-model.md`（SQLite 表与 `secrets.enc` 关系）、`runtime.md`、`tools.md`
> 变更记录：见 §16

> ⚠️ **本文件的版本号不代表整个契合同步升级。**
> 契约拆成多份之后，每份的版本各自独立：`catalog.md` 是**与服务端协商**的协议版本（改它会中断目录服务，见该文件变更记录），`tools.md` / `runtime.md` / `events.md` / 本文件是应用内部版本。
> **批量改版本号时不要顺手全改**——按文件改，一次只动真正变化的那个。

---

## 0. 本契约的地位

`invoke` 是 **UI → Host 的唯一请求通道**，事件是 Host → UI 的唯一推送通道。两者不互相替代：

- UI 需要「做一件事并拿到结果」→ 用 `invoke`，同步等返回值。
- Host 需要「告诉 UI 状态变了」→ 用事件，UI 不轮询。

**一个命令与一个 AI 工具如果语义相同，必须共用同一份 Host 实现**（`tools.md` §5）。UI 路径和模型路径出现两套逻辑，是本项目已经踩过的缺陷来源。

### 0.1 2.0.0 为什么是一次大版本

1.x 的数据单位是**一个节点 = 一条 profile**。2.0 换成**一套配置 = 一套完整的网络方案，挂多个节点**（`docs/configs-and-nav.md` §3）。这不是加字段能兼容的：

| 1.x | 2.0 |
|---|---|
| `profile` = 一个节点 | `config` = 一套方案；`node` = 一台服务器 |
| 一个节点只属于一条 profile | 一个节点可被多套配置引用 |
| `runtime_start(profileId)` | `runtime_start(configId)` |
| 没有任何「问题」实体 | `issue` 有状态、可计数、可转交 |
| 没有布局持久化 | `layout` 按配置存 |

产品还没有用户，**不做迁移、不留兼容层**（`docs/implementation-plan.md` §1）。所有旧命令直接删除，数据库整体重建，详见 §11 与 `data-model.md` §6。

### 0.2 跨文件一致性（批 0 已完成）

| 文件 | 状态 | 关键变化 |
|---|---|---|
| `events.md` | **2.0.0** | 配置 / 节点 / 问题 / 布局四类新事件 |
| `runtime.md` | **2.0.0** | `profile_*` → `config_*`，新增 `node_*`，`mode` 增加 `tun` |
| `tools.md` | **3.0.0** | 工具改名与新增，AI 侧与 UI 侧同源 |
| `data-model.md` | **1** | 6 张表 DDL、索引、`secrets.enc` 关系 |
| `catalog.md` | 1.x | 不动（与服务端协商的独立版本） |

**四份的应用侧契约现在是同一套词汇：`config` / `node` / `issue` / `layout`。** 任何一份出现 `profile` 都视为错误（历史变更记录除外）。

### 0.3 批 0 的 PM 裁定（2026-11-03）

| # | 裁定 | 落点 |
|---|---|---|
| OPEN-05 | 问题状态统一 `open` / `handed_off` / `resolved` / `ignored`；严重度统一 `P0` / `P1` / `P2` | §6、`data-model.md` §3.6 |
| OPEN-06 | `configs` 表必须承载 DNS 候选与 TUN 内网排除网段，用 JSON 列（一组值、无独立生命周期，不需要子表） | §3.0、`data-model.md` §3.2 |
| OPEN-03 | 命令名以本文件为准；`capabilities.md` 由 PM 维护，本文件只标注能力 ID | §12 |
| — | 「测试连通」新增能力 **D6 测试单个节点连通性** | §12.1 的 `node_probe` |
| — | 新增 **K 组「配置管理」K1–K5**（配置级能力，与 B 组节点级分开） | §12.1 |

---

## 1. 命名与参数约定

### 1.1 命令名用 snake_case，参数名用 camelCase

Tauri 2 的 `#[tauri::command]` 默认把 JS 侧的 **camelCase 参数**映射到 Rust 侧的 **snake_case 形参**。

| 侧 | 写法 | 例子 |
|---|---|---|
| 命令名（invoke 第一个参数） | snake_case | `config_create`、`node_import_url` |
| 参数键（args 对象的键） | **camelCase** | `configId`、`nodeId`、`sessionId`（各命令自己的参数，不代表 `runtime_start` 有 `nodeId`） |
| Rust 形参 | snake_case | `config_id: Option<String>` |
| 返回值字段 | snake_case | `config_id`、`node_count` |

**现存证据**（不要按旧文档改）：

```
src/agent/tauriBridge.ts:77   call("ai_send_message", { sessionId, text })
src-tauri/src/agent/commands.rs:14   session_id: String
```

> 1.0.10 及以前的 `events.md` §5 把参数写成 `{ profile_id }`、`{ session_id }`，与实际 wire 不符。以本节为准。

#### 1.1.1 不要用嵌套对象传参

**camelCase → snake_case 只对命令的顶层参数生效**，嵌套对象里的键按各自结构体的 serde 规则走。

```ts
// ❌ 不要这样
invoke("llm_provider_test", { draft: { baseUrl: "..." } })
```

Rust 侧从嵌套结构体里按什么名字取 `baseUrl`，取决于它有没有 `rename_all`。写错了**编译不报错、运行不报错**，只是那个字段永远是 `None`——表现是「参数传了但没生效」，排查成本极高。

要用可选字段就**平铺到顶层**（见 §9.4），要么在嵌套结构体上显式写 `#[serde(rename_all = "camelCase")]` 并在契约里注明。本项目选前者。

**例外**：数组元素里的对象（如 `probe_run.targets[]`、`layout.blocks[]`）是数据而非命令参数，字段名仍用 snake_case，由各自结构体显式声明。

### 1.2 返回值与错误

- 成功：返回该命令定义的 data 对象，**不含 `ok` 外层信封**（工具调用才有 `ToolEnvelope`）。
- 失败：`Err(AivpnError)`，结构见 `runtime.md` §2.6（`code` / `message` / `retryable` / `details` / `request_id`）。
- `details.reason` 用于细分同一错误码下的不同场景，取值在每条命令的表格里固定。

### 1.3 来源标记

Host 在每个命令入口自动注入 `source = "ui"`，UI **不能**在参数里传 `source`（传了按 `INVALID_ARGUMENT` 拒绝）。只读命令不做来源校验。

### 1.4 幂等

标了「幂等」的命令重复调用不产生额外副作用，返回值反映最终状态而非本次动作。

### 1.5 时间与标识（2.0 新增）

| 对象 | 规则 |
|---|---|
| **落库实体的时间戳** | **Unix 毫秒整数**（`number`）。配置、节点、问题、布局返回与事件里一律是毫秒，不做 ISO 转换 |
| **事件信封的 `emitted_at`** | 仍是 ISO 8601 UTC，见 `events.md` §2.3 |
| **运行时快照的时间**（`connected_since` / `last_transition_at` / `health.checked_at`） | 仍是 ISO 8601 UTC，由 `runtime.md` 定义。运行时状态是**实时观测值**，不是落库实体 |
| **id** | 不透明字符串，前缀区分类型：`cfg_` / `nod_` / `iss_` / `prb_` / `q_` / `p_`，后接 16 位小写十六进制。**UI 不得从 id 推导任何信息**，也不得跨类型混用 |

> 为什么实体时间用毫秒：这些值直接来自 SQLite 列，用 ISO 要在 Host 里做两次转换、在前端再做一次解析，且排序与「第几次出现」的算术都在毫秒上更直接。唯一需要人读的地方是 UI，由 UI 格式化。

---

## 2. 命令总表

| # | 命令 | 入参 | 返回 | 状态 |
|---|---|---|---|---|
| 1 | `config_list` | `{}` | `ConfigListData` | **2.0 新增** |
| 2 | `config_create` | `{ name, connectMode, routingMode, targets?, source?, nodeIds?, dns?, tunExcludes? }` | `ConfigDetail` | **2.0 新增；2.12.0 移除 `listenPort`** |
| 3 | `config_update` | `{ configId, name?, routingMode?, targets?, dns?, tunExcludes?, nodeIds? }` | `ConfigDetail` | **2.0 新增；2.12.0 移除 `listenPort`** |
| 4 | `config_delete` | `{ configId }` | `ConfigDeleteData` | **2.0 新增** |
| 5 | `config_activate` | `{ configId, confirmDisconnect? }` | `ConfigActivateData` | **2.0 新增** |
| 6 | `config_detail` | `{ configId }` | `ConfigDetail` | **2.0 新增** |
| 7 | `node_import_url` | `{ url, configId? }` | `NodeImportResult` | **2.0 新增** |
| 8 | `node_create` | `{ name, server, port, method, password, configId? }` | `NodeSummary` | **2.0 新增** |
| 9 | `node_switch` | `{ configId, nodeId }` | `NodeSwitchData` | **2.0 新增** |
| 10 | `node_probe` | `{ nodeId }` | `NodeProbeData` | **2.0 新增** |
| 11 | `proxy_params` | `{}` | `ProxyParams` | **2.0 新增** |
| 12 | `probe_run` | `{ configId?, targets? }` | `ProbeReport` | **2.0 新增** |
| 13 | `issue_list` | `{ state?, severity?, configId?, limit?, offset? }` | `{ issues, total }` | **2.0 新增** |
| 14 | `issue_get` | `{ issueId }` | `IssueDetail` | **2.0 新增** |
| 15 | `issue_handoff` | `{ issueId, sessionId? }` | `IssueHandoffData` | **2.0 新增** |
| 16 | `issue_resolve` | `{ issueId }` | `IssueResolveData` | **2.0 新增** |
| 17 | `issue_ignore` | `{ issueId, ignored? }` | `IssueIgnoreData` | **2.0 新增** |
| 18 | `runtime_status` | `{}` | `RuntimeSnapshot` | 保留（字段 2.0 改） |
| 19 | `runtime_start` | `{ configId? }` | `RuntimeSnapshot` | 保留（2.2 去掉 `nodeId`） |
| 20 | `runtime_stop` | `{}` | `RuntimeSnapshot` | 保留 |
| 21 | `net_repair` | `{ action, port? }` | `NetRepairResult` | 保留 |
| 22 | `default_profile_status` | `{}` | `DefaultProfileResult` | 保留（语义 2.0 改） |
| 23 | `default_profile_refresh` | `{}` | `DefaultProfileResult` | 保留（语义 2.0 改） |
| 24 | `import_seed_file` | `{ path }` | `SeedImportResult` | 保留；**目标状态：UI 不再使用**。设置页的粘贴 / 订阅 / 文件入口已改走 `node_import_text` / `node_import_url` / `node_import_file`。**当前唯一 UI 调用方：窗口级拖放**（只收种子 `.json`）；拖放**不随批 B 迁移**，等种子分发退场再定（§4.1.2、§8.3） |
| 25 | `ai_send_message` | `{ sessionId, text, hidden? }` | `{ request_id }` | 保留（2.3 增 `hidden`，删 `attachments`） |
| 26 | `ai_cancel` | `{ requestId }` | `{ cancelled: boolean }` | 保留 |
| 27 | `chat_history` | `{ sessionId? }` | `ChatHistory` | 保留 |
| 28 | `chat_delete` | `{ sessionId }` | `{ ok: true }` | 保留 |
| 29 | `rename_session` | `{ sessionId, title }` | `{ id, title, created_at }` | 保留 |
| 30 | `reply_user_question` | `{ sessionId, questionId, answer }` | `{ ok: true }` | 保留；**2.16.0 起普通提问接受自由文本，回答落库** |
| 31 | `list_pending_questions` | `{ sessionId }` | `{ questions: PendingQuestion[] }` | 保留 |
| 32 | `llm_provider_list` | `{}` | `LlmProviderList` | 保留 |
| 33 | `llm_provider_save` | `{ providerId?, name, protocol, baseUrl?, model, apiKey? }` | `LlmProvider` | 保留 |
| 34 | `llm_provider_delete` | `{ providerId }` | `{ ok: true }` | 保留 |
| 35 | `llm_provider_activate` | `{ providerId }` | `{ active_provider_id }` | 保留 |
| 36 | `llm_provider_test` | `{ providerId?, name?, protocol?, baseUrl?, model?, apiKey? }` | `LlmTestResult` | 保留 |
| 37 | `deepseek_key_status` | `{}` | `{ configured, masked }` | 保留 |
| 38 | `deepseek_save_key` | `{ key }` | `{ masked, verified }` | 保留 |
| 39 | `deepseek_clear_key` | `{}` | `{ ok: true }` | 保留 |
| 40 | `open_log_dir` | `{}` | `{ path: string }` | 保留 |
| 41 | `open_external` | `{ url }` | `{ ok: true }` | 保留（1.2.0 漏记，2.0 补录） |
| 42 | `route_get` | `{ configId? }` | `RouteState` | **2.1 新增** |
| 43 | `route_set_mode` | `{ configId?, mode, confirmReconnect? }` | `RouteSetModeData` | **2.1 新增** |
| 44 | `route_targets_set` | `{ configId, categories }` | `RouteState` | **2.1 新增** |
| 45 | `rule_custom_list` | `{ configId }` | `{ rules: CustomRule[] }` | **2.1 新增** |
| 46 | `rule_custom_add` | `{ configId, action, matchType, value, note? }` | `CustomRule` | **2.1 新增** |
| 47 | `rule_custom_delete` | `{ configId, ruleId }` | `{ rule_id, deleted, already_absent }` | **2.1 新增** |
| 48 | `category_list` | `{ query?, limit? }` | `{ categories: Category[], total }` | **2.1 新增** |
| 49 | `rules_status` | `{}` | `RulesStatus` | **2.1 新增** |
| 50 | `rules_update` | `{}` | `{ queued: boolean, job_id: string \| null }` | **2.1 新增** |
| 51 | `tun_helper_open_settings` | `{}` | `{ opened: true }` | **2.3.5 新增** |
| 52 | `tun_helper_uninstall` | `{}` | `{ ok: true }` | **2.3.5 新增** |
| 53 | `network_force_reset` | `{}` | `NetworkForceResetData`（`{ ok, verified, exit_ip, steps }`） | **2.4.0 新增** |
| 54 | `core_info` | `{}` | `CoreInfoData` | **2.5.0 新增（仅 UI）** |
| 55 | `core_check_updates` | `{}` | `CoreCheckUpdatesData` | **2.5.0 新增（仅 UI）** |
| 56 | `core_upgrade` | `{ version }` | `{ job_id, current_version, target_version }` | **2.5.0 新增（UI + `CoreUpgrade` 工具）** |
| 57 | `core_cancel_upgrade` | `{ jobId }` | `{ cancelled: boolean }` | **2.5.0 新增（仅 UI）** |
| 58 | `core_rollback` | `{}` | `{ ok: true }` | **2.5.0 新增（仅 UI）** |
| 59 | `tun_helper_info` | `{}` | `TunHelperInfoData` | **2.6.0 新增（仅 UI）** |
| 60 | `tun_helper_restart` | `{}` | `{ ok, restarted, needs_admin_restart }` | **2.6.0 新增（仅 UI）** |
| 61 | `tun_probe` | `{}` | `TunProbeData` | **仅 debug 构建注册；AI 不可调用** |
| 62 | `node_probe_all` | `{ configId?, nodeIds? }` | `NodeProbeAllData` | **2.8.0 新增（仅 UI）；2.10.0 增节点子集** |
| 63 | `node_probe_cancel` | `{ runId }` | `{ cancelled: boolean }` | **2.8.0 新增（仅 UI）** |
| 64 | `node_probe_snapshot` | `{ configId? }` | `NodeProbeSnapshotData` | **2.8.0 新增（仅 UI）** |
| 65 | `proxy_port_get` | `{}` | `{ port, default_port }` | **2.12.0 新增（仅 UI）** |
| 66 | `proxy_port_set` | `{ port }` | `{ port, availability }` | **2.12.0 新增（仅 UI）；可用性三态，保存始终成功** |
| 67 | `node_import_text` | `{ text, configId? }` | `NodeImportResult` | **2.14.0 新增（仅 UI；AI 走 `NodeImportText` 工具，共用实现）** |
| 68 | `system_region` | `{}` | `{ region: string \| null }` | **2.15.0 新增（仅 UI）** |
| 69 | `node_import_file` | `{ path, configId? }` | `NodeImportResult` | **2.16.14 新增（仅 UI）；与 `node_import_text` 共用解析；批 B 实现** |
| 70 | `issue_report_reveal` | `{ reportId }` | `ReportActionData` | **2.17.0 新增（仅 UI）；只认 Host 登记过的报告目录** |
| 71 | `issue_report_mail` | `{ reportId }` | `ReportActionData`（含 `body`，仅 `copy_only` 时非 null） | **2.17.0 新增（仅 UI）；调起系统邮件客户端，不发送** |
| 72 | `issue_report_preference` | `{ includeDomains? }` | `{ includeDomains }` | **2.17.0 新增（仅 UI）；省略参数为读取；脱敏开关的唯一写入路径** |

> 「状态」三列含义：**新增** = 2.0 / 2.1 才有；**改** = 名字不变但语义/形状变了；**保留** = 1.2.0 语义不变。
> `invoke_handler` 是唯一事实来源，文档与它对不上就是文档错。

---

## 3. 配置

一套配置 = 一套完整的网络方案：连接方式、分流策略、节点集、当前节点、DNS、端口、内网排除（`docs/configs-and-nav.md` §3）。这些是一整套，**不拆开单独切换**。

### 3.0 共用类型

```ts
type ConfigMode = "system_proxy" | "tun";
type RoutingMode = "direct" | "proxy_all" | "proxy_selected";

// DNS 候选：local 直连查询，remote 经代理查询。
// 空数组表示「由生成器按用户国家自动选」，落库时也是空数组，不预填常量——
// 常量会被当成用户的选择，从此不再跟随国家变化。
type DnsConfig = {
  mode: "auto" | "custom";
  local: string[];     // 0–3 条
  remote: string[];    // 0–2 条
};

type ConfigSummary = {
  config_id: string;
  name: string;
  connect_mode: ConfigMode;          // system_proxy = 只给代理地址；tun = 接管全部
  routing_mode: RoutingMode;
  node_count: number;
  listen_port: number | null;        // ⚠️ 废弃：仅回显旧数据；连接端口来自全局设置 proxy_port
  is_active: boolean;
  current_node_id: string | null;    // 节点集为空时为 null
  created_at: number;                // Unix 毫秒
  updated_at: number;                // Unix 毫秒
  last_used_at: number | null;       // 最近一次以它发起连接的时刻
};

type NodeSummary = {
  node_id: string;
  name: string;
  server: string;
  port: number;
  method: string;
  protocol: "shadowsocks";           // 本阶段唯一取值
  source: "seed" | "url" | "manual";
  created_at: number;                // Unix 毫秒
};

type Layout = {
  version: 1;
  blocks: Array<{ type: BlockType; props?: Record<string, unknown> }>;
};

type ConfigDetail = ConfigSummary & {
  nodes: NodeSummary[];              // 按配置内顺序，不是创建顺序
  dns: DnsConfig;                    // 本地 / 境外 DNS 候选
  tun_excludes: string[];            // 仅 tun；system_proxy 恒为空数组
  layout: Layout | null;             // null = 这个配置还没有编排布局
  layout_revision: number | null;    // 与 layout 同源：layout 为 null 时它也为 null
};
```

**任何返回值都不含节点密码。** `NodeSummary` 里没有密码字段，`config_detail` 也没有。密码只在 `secrets.enc` 里，键为 `node:<node_id>`（`data-model.md` §5）。

**不变量（必须实现）**

1. 同一时刻最多一个 `is_active = true` 的配置（数据库层用部分唯一索引兜底）。
2. `node_count` 是 `config_nodes` 的实时计数，不是缓存列。
3. `current_node_id` 必须是该配置节点集里的一个；节点被删时置 `null`。
4. `connect_mode = "tun"` 时 `listen_port` 恒为 `null`。**`listen_port` 已废弃**：列与返回值保留只为旧数据/回滚，连接不再读它；本地代理端口只有一个来源——全局设置 `proxy_port`（`proxy_port_get` §7.11）。`tun_excludes` 只在 `tun` 下允许非空。

### 3.1 `config_list {}` → `ConfigListData`

```ts
type ConfigListData = {
  configs: ConfigSummary[];
  active_config_id: string | null;
};
```

- 数据源只有本地库，**不联网**。
- 排序：`last_used_at DESC NULLS LAST`，再按 `created_at ASC`。后端给的就是这个顺序，UI 不另排。
- 空列表是合法状态，返回 `configs: []`，**不报错**。空态由 UI 渲染（`docs/configs-and-nav.md` §2.1）。
- 列表里**不返回节点明细**，避免左栏为 N 个配置各拉一遍；要节点看 `config_detail`。

### 3.2 `config_create { name, connectMode, routingMode, targets?, source?, nodeIds?, dns?, tunExcludes? }` → `ConfigDetail`

| 参数 | 必填 | 规则 |
|---|---|---|
| `name` | 是 | trim 后非空、≤ 40 字符；**不允许重名**（trim 后逐字节比较）。重复 → `CONFLICT`，`details.reason = "duplicate_name"` |
| `connectMode` | 是 | `"system_proxy"` / `"tun"`。**故意没有默认值**——连接方式是用户明确选的，见下 |
| `routingMode` | 是 | 三种取值都接受。`"proxy_selected"` 时 `targets` 必填且非空 |
| `targets` | 否 | 分类 id 数组，仅 `proxy_selected` 有意义；id 不在分类目录 → `NOT_FOUND / category_unknown` |
| `source` | 否 | `"seed"`：绑定当前种子里的全部节点；与 `nodeIds` **互斥** |
| `nodeIds` | 否 | 绑定已有节点，顺序即节点顺序 |
| `dns` | 否 | `DnsConfig`；省略 = `{ mode: "auto", local: [], remote: [] }`。`custom` 时 `local` 至少 1 条，地址必须是合法 IP |
| `tunExcludes` | 否 | 仅 `tun`；CIDR 字符串数组，≤ 32 项。格式非法 → `INVALID_ARGUMENT`，`details.reason = "invalid_cidr"` |

**`listenPort` 已移除**：本地代理端口是全局设置（`proxy_port_set`，§7.11），不属于配置。`ConfigDetail.listen_port` 只为旧数据回显保留并标注废弃，界面不读它。

规则：

- `source = "seed"` 且种子为空 → `PRECONDITION_FAILED`，`details.reason = "seed_unavailable"`，`details.hint = "先刷新默认配置或手动添加节点"`。
- `nodeIds` 里有不存在的 id → `NOT_FOUND`，`details.node_ids` 列出全部无效项（一次报全，不让用户试错）。
- **不传 `source` 也不传 `nodeIds`** → 允许，创建空节点集的配置。空配置可以存在、可以在左栏看到、可以激活，但**不能连接**（`runtime_start` 报 `no_nodes`）。这是给「先建壳子、稍后导入」用的。
- `current_node_id` 取节点集里的第一个。
- 新建后是否自动激活：

  | 当前状态 | 行为 |
  |---|---|
  | 没有 active 配置 | **自动成为 active**（全新安装的第一套必须能直接连） |
  | 有 active、当前**未连接** | **自动成为 active**（与左栏「未连接时直接切，无感」同一条规则） |
  | 有 active、当前**已连接** | **不自动激活**，返回 `is_active = false`；UI 提示「已创建，从左侧切换」 |

  > 已连接时静默改 active 等于静默换网络，和「节点连不上不得悄悄回退默认包」是同一条原则。

- 成功后发 `config-changed`（`change = "created"`，若自动激活再发一条 `"activated"`），见 `events.md` §4.9。

错误：`INVALID_ARGUMENT`、`CONFLICT`、`NOT_FOUND`、`PRECONDITION_FAILED`、`UNSUPPORTED`、`INTERNAL`。

### 3.3 `config_update { configId, name?, routingMode?, targets?, dns?, tunExcludes?, nodeIds? }` → `ConfigDetail`

| 字段 | 可改 | 说明 |
|---|---|---|
| `name` | ✅ | 同样的非空 / ≤ 40 / 不重名校验 |
| `routingMode` | ✅ | 只影响下一次生成配置；**不在线切换**（在线切换走 `route_set_mode`，G2） |
| `targets` | ✅ | 整套替换；切到 `proxy_selected` 时必须非空 |
| `dns` | ✅ | 整体替换；`custom` 的校验同 §3.2 |
| `tunExcludes` | ✅ | 仅 `tun` 配置 |
| `nodeIds` | ✅ | **整体替换**节点集，顺序即新顺序；`current_node_id` 不在新集合里时落到第一个 |
| `connectMode` | ❌ | **没有这个参数**。带上它 → `INVALID_ARGUMENT`，`details.reason = "connect_mode_immutable"` |

**`listenPort` 已移除**：`config_update` 不再接受它，端口只在设置里改（§7.11）。

- **改连接方式必须新建一套配置**（`docs/configs-and-nav.md` §4）：system_proxy 与 tun 是两种完全不同的接管方式，就地改会让「我刚才明明配好了」变成「它自己变了」。
- `routingMode = "proxy_selected"` 时 `targets` 必须非空（同 §3.2）。
- 修改**不打断当前连接**：新值只写库；下一次连接或下一次切换节点时生效。UI 需要提示「下次连接生效」时，用返回值与当前 `RuntimeSnapshot` 自行比较，Host 不额外发信号。
- 改的是 active 配置且当前已连接 → `runtime_status.config_hash` 与新配置不一致，但**不自动重连**。
- 幂等：参数与现状完全一致时仍返回同一份 `ConfigDetail`，不发事件。
- 成功后发 `config-changed`（`change = "updated"`）。

错误：`INVALID_ARGUMENT`、`NOT_FOUND`、`CONFLICT`、`UNSUPPORTED`、`INTERNAL`。

### 3.4 `config_delete { configId }` → `ConfigDeleteData`

```ts
type ConfigDeleteData = {
  config_id: string;
  deleted: boolean;              // true = 本次真的删掉了
  already_absent: boolean;       // true = 本来就不存在（幂等命中）
  active_config_id: string | null;
};
```

| 情况 | 结果 |
|---|---|
| 不存在 | 幂等：`deleted = false`、`already_absent = true`，不报错 |
| 是当前正在连接的配置 | `PRECONDITION_FAILED`，`details.reason = "connected"`。**UI 先断开再删**，Host 不替用户断网 |
| 是 active 但未连接 | 允许删除；`active_config_id` 变为 `null`（回到空态，空态可再新建） |
| 有配置引用的节点 | **不删节点**，只删 `config_nodes` 关系（节点是共享的） |

- 级联删除：该配置的 `config_nodes`、`layouts`、**该配置范围内的问题记录**（`issues.config_id` 外键级联）。问题记录的删除是刻意的：配置都没了，挂在它上面的诊断没有意义，留着会在问题列表里出现指向不存在配置的卡片。
- 成功后发 `config-changed`（`change = "deleted"`）。
- **不设「默认配置不可删除」的特例**（`docs/configs-and-nav.md` §2.1）：删光之后回到空态，从空态能重新生成。

错误：`PRECONDITION_FAILED`（`connected`）、`INTERNAL`。

### 3.5 `config_activate { configId, confirmDisconnect? }` → `ConfigActivateData`

```ts
type ConfigActivateData = {
  active_config_id: string;
  reconnect: "not_running" | "reconnected" | "reconnect_failed" | "skipped_no_nodes";
  runtime: RuntimeSnapshot | null;   // not_running / skipped_no_nodes 时为 null
};
```

| 当前状态 | 行为 |
|---|---|
| 未连接 | 直接切 active，无感；`reconnect = "not_running"` |
| 已连接、目标就是当前配置 | 幂等返回，不发事件 |
| 已连接、换到另一套、**没带 `confirmDisconnect`** | `PRECONDITION_FAILED`，`details.reason = "will_disconnect"`，`details.connected_config_id` 给出当前连接的是哪套。**不静默切换** |
| 已连接、带 `confirmDisconnect: true` | 先 `runtime_stop` → 改 active → 用新配置 `runtime_start`（自动重连），`reconnect = "reconnected"` 或 `"reconnect_failed"` |
| 目标配置节点集为空 | 允许激活，但不自动重连（`reconnect = "skipped_no_nodes"`）；UI 应在左栏标「无节点」 |

- **确认的粒度是「这一次切换」**：`confirmDisconnect` 不记忆、不复用。每次换配置都要重新确认。
- `reconnect_failed` **不抛错**：切换本身成功了，失败的是重连。`runtime` 里带失败后的快照，`last_error` 说明原因；这样 UI 能同时表达「已切到新配置」和「没连上」，而不是笼统报一个错误让用户不知道 active 变没变。
- 成功后发 `config-changed`（`change = "activated"`）。

错误：`NOT_FOUND`、`PRECONDITION_FAILED`（`will_disconnect`、`quitting`）、`INTERNAL`。

### 3.6 `config_detail { configId }` → `ConfigDetail`

- 中间底部节点详情与节点下拉的数据源（`docs/center-panel.md` §2.5.1：固定骨架「底部节点详情 / 下拉」→ B1）。
- `nodes` 按配置内顺序返回；UI **不重排、不按名字排序**——用户拖过的顺序就是顺序。
- `layout` 随配置一起返回：切配置后 UI 立即拿到该配置的布局，不需要再发一次请求。布局写入走 AI 编排（批 4），UI 没有写布局的命令。
- `layout_revision` 用于**丢弃迟到的 `layout-updated`**：UI 收到 `revision <= layout_revision` 的事件直接忽略。没有这个字段，同配置内「先发的事件后到」会让中间区闪回上一版——`config_id` 只能挡住跨配置的迟到事件。
- 不存在 → `NOT_FOUND`。
- 只读，不联网，不发事件。

---

## 4. 节点

节点是**全局池**里的服务器，一套配置通过 `config_nodes` 引用若干节点。同一个节点可以被多套配置引用（`docs/configs-and-nav.md` §7）。

### 4.1 `node_import_url { url, configId? }` → `NodeImportResult`

```ts
type NodeImportResult = {
  imported: number;
  skipped: Array<{ name: string | null; reason: ImportSkipReason }>;
  nodes: NodeSummary[];          // 本次新增的（已存在的不会出现在这里）
};

type ImportSkipReason =
  | "unsupported_scheme"         // 不是 ss://
  | "unsupported_method"         // method 不在白名单
  | "malformed"                  // 结构不合法
  | "duplicate"                  // 池里已有相同 server+port+method+name
  | "subscription_empty";        // 整段解码后没有任何有效行
```

| 边界 | 要求 |
|---|---|
| 协议 | **仅 `https`**。`http` 一律 `INVALID_ARGUMENT`，`details.reason = "insecure_url"`——订阅链接里通常直接含节点密码，明文传输等于把它交给链路上的每一个人 |
| 支持的格式 | base64 编码的 `ss://` 多行列表；或直接是换行的 `ss://` 列表。两种 SIP002 形态都要认：`ss://base64(method:password)@host:port#name` 与整段 base64 的 `ss://base64(method:password@host:port)#name` |
| SSRF | 只允许解析到**公网**地址；禁止重定向到内网；最多 3 次重定向；响应 ≤ 1 MB；超时 10 s。用户填的 URL 由我们发起请求，不设限就能访问本机与内网服务 |
| 拉不到 | `UPSTREAM_ERROR`，`details.reason = "fetch_failed"`，**不保存空配置、不创建节点** |
| 自动连接 | **不做**。拉下来的东西来自任何地方，用户确认之后才生效 |

- 节点去重键：`server` + `port` + `method` + `name`。命中已有节点时计入 `skipped`（`reason = "duplicate"`），**不新建记录**。
- 传了 `configId` → 新节点按解析顺序追加到该配置节点集末尾；配置已有 `current_node_id` 时不动它，没有时取第一个。发 `node-list-changed`（`reason = "url_import"`）+ `config-changed`（`change = "updated"`）。
- 不传 `configId` → 只进节点池，不绑定任何配置。
- 返回值与日志**永不含密码**，不回显订阅内容。
- 本阶段**只做 Shadowsocks**，method 白名单由 Host 常量维护（`nodes::SUPPORTED_METHODS`，覆盖 sing-box 支持的 Shadowsocks 方法）；白名单变化不要求改表结构。

错误：`INVALID_ARGUMENT`（`insecure_url`、`invalid_url`、`not_subscription`）、`NOT_FOUND`（`configId`）、`UPSTREAM_ERROR`、`TIMEOUT`、`SECRET_STORE`、`INTERNAL`。

### 4.1.1 `node_import_text { text, configId? }` → `NodeImportResult`

用户粘贴的节点文本（手工流程的「粘贴分享链接」）。**不发任何网络请求**——这是它与 §4.1 分成两条命令的原因：URL 那条的 SSRF / https 限制是为「我们替用户去拉」设计的，混用会把口子开大。

> AI 通道走 `NodeImportText` 工具（`tools.md` §4.10.1），与本命令**共用同一个服务层实现**；行为、返回形状、错误码一致，只是通道不同。

| 边界 | 要求 |
|---|---|
| 支持的格式 | 与 §4.1 同一套逐行解析：换行的 `ss://` 列表，或整段 base64 编码的 `ss://` 列表；两种 SIP002 形态都认 |
| 逐条解析 | 一行失败只影响该行：成功的进 `nodes`，失败的进 `skipped`（`unsupported_scheme` / `unsupported_method` / `malformed`），**不整批作废** |
| 一条都用不了 | `INVALID_ARGUMENT`，`details.reason = "not_node_text"`，可读消息「粘贴的内容里没有可用的节点（支持多行 ss:// 链接）」 |
| 去重 | 沿用 `source_key`（`server` + `port` + `method` + `name`）。重复不报错，计入 `skipped`（`reason = "duplicate"`），不新建记录 |
| 来源 | 落库为 `source = "manual"`（用户自己提供，不是订阅） |
| 自动连接 | **不做** |

- 传了 `configId` → 新节点按解析顺序追加到该配置；配置已有 `current_node_id` 时不动它，没有时取第一个。发 `node-list-changed`（`reason = "manual_create"`，沿用现有枚举）+ `config-changed`（`change = "updated"`）。
- 文本导入能出现的 `skipped.reason` 只有四种：`unsupported_scheme` / `unsupported_method` / `malformed` / `duplicate`。整段都解析不出时直接报 `not_node_text`，**不产生 `subscription_empty`**（那个值只属于 URL / 订阅路径）。
- 不传 `configId` → 只进节点池。
- 返回值与日志**永不含密码**，也不回显粘贴内容。
- 本阶段只做 Shadowsocks，方法白名单同 §4.1。

错误：`INVALID_ARGUMENT`（`not_node_text`）、`NOT_FOUND`（`configId`）、`SECRET_STORE`、`INTERNAL`。

### 4.1.2 `node_import_file { path, configId? }` → `NodeImportResult`

用户从本地文件导入节点（设置 › 连接 ›「添加节点」的文件入口）。**仅 UI，不注册为 AI 工具**——AI 侧继续走 `NodeImportText`，不给模型读本地文件的能力。

> **窗口级拖放不走本命令。** 它只收种子文件，当前仍由 `import_seed_file`（#24）承担，本批不迁移——理由见下方「为什么窗口拖放不迁移」。

> 与 §4.1.1 **共用同一个解析实现**：返回形状、跳过原因、去重键、来源、事件完全一致，只是输入从文本换成文件路径。

**为什么不复用 `import_seed_file`**：

1. **格式不同**：它只接受 `veyl_seed.json`（`{ version, updated_at, nodes[] }`）且扩展名必须是 `.json`；用户的普通节点列表（`.txt`、多行 `ss://`）会被直接拒绝。
2. **语义不同**：它把节点以 `source = "seed"` 并入种子池、发 `seed_refreshed`；用户文件应落 `source = "manual"`、走文本解析与 `manual_create`。复用等于同时改语义和调用方。
3. **它还有活路径**：窗口级拖放当前仍在调用（§8.3），拖进来的是种子文件（`{ version, updated_at, nodes[] }`），与本命令的逐行 `ss://` 是两种格式。不能标成废弃，也不该为了新格式去动它的返回与来源。
4. **新增的代价可控**：两处 handler 注册、一个版本位、一个契约条目；换来文本/文件两条通道共用解析，错误码 `not_node_text` 与四种 `skipped.reason` 全部复用，只新增路径相关的三个 reason。

**为什么窗口拖放不迁移（2026-11-11 决议）**

窗口拖放继续走 `import_seed_file`，只收 `.json` 种子文件；设置页的文件入口走本命令。两条入口**按用途分开**，不是两个半成品：

| 理由 | 说明 |
|---|---|
| 能力不能丢 | 种子文件是当前内测分发方式（`shadowsocks.md` §5.6）。把拖放切到逐行 `ss://`，等于让用户拖入一份可用文件却被判成「没有可用的节点」 |
| 不让临时格式塑造永久契约 | 种子随计费上线退场。若本命令按文件首字节分派（JSON → 种子、否则 → 节点文本），这个分支会留在一个长期命令里，且种子分支的 `configId` 无意义、事件是 `seed_refreshed` 而不是 `manual_create`——一条命令携带两套来源与事件 |
| 返回形状虽然同形，语义不同 | `import_seed_file` 也返回 `{ imported, skipped[], nodes[] }`，但 `skipped` 恒为空、来源写死 `source = "seed"`。同形不等于同义，不能靠形状判断 |
| 迁移成本没有变高 | 种子退场时把 `App.tsx` 的 `importPath` 从 `importSeedFile` 换成 `nodeImportFile` 即可，不需要分派分支；届时拖放才真正只需要一种格式 |

**两条入口的分工（用户可见）**：窗口拖入 = 种子文件（`.json`）；设置 › 添加节点 › 选择文件 = 节点文本。拖入非 `.json` 时的提示要指向设置页，例如「窗口拖入只支持 .json 种子文件；节点文本请到 设置 › 连接 › 添加节点导入」，**不要只说「请换一个文件」**——用户手里可能根本没有 `.json`。反过来，在设置页选中一份种子 `.json` 会落到 `not_node_text`，这是预期行为：错误文案已写明支持多行 `ss://` 链接，不再为它单独识别种子格式。

| 边界 | 要求 |
|---|---|
| `path` | **绝对路径**，只能来自设置页的系统文件对话框（`plugin-dialog open()`）。前端**不得**把文本框里的内容当路径传入；**不接受窗口拖放事件**（拖放走 #24） |
| 路径校验 | 空或非绝对 → `invalid_path`；不存在、不是普通文件、不可读、IO 错误 → `file_unreadable` |
| 编码 | 按 UTF-8 解码，非法字节替换为 U+FFFD，**不做编码猜测**。GBK 等文本里的 `ss://` 行是 ASCII，仍能解析；只有中文节点名可能变成替换字符。JSON 也按文本逐行处理，不要求是合法 JSON |
| 大小上限 | **1 MiB**（与 `import_seed_file`、URL 拉取一致）。先看 `metadata.len()`，超限不读全文 → `file_too_large`，`details.max_bytes = 1048576` |
| 扩展名 | **不按扩展名过滤**。`.txt` / `.json` / 无扩展名都收；对话框建议 `.txt,.json`，命令不据此拒绝——扩展名不代表内容 |
| 支持的格式 | 与 §4.1.1 同一套：多行 `ss://` 链接，或整段 base64 的 `ss://` 列表。**本轮不解析 Clash YAML**；YAML 或其它格式落到 `not_node_text`，不新增 `unsupported_format`——解析器无法可靠区分「格式不对」与「格式对但没有节点」 |
| 一条都用不了 | `INVALID_ARGUMENT`，`details.reason = "not_node_text"`，可读消息「这个文件里没有可用的节点（支持多行 ss:// 链接）」 |
| 去重 | 同 `source_key`。重复计入 `skipped`（`duplicate`），不新建记录 |
| 来源 | `source = "manual"`（用户自己提供） |
| 自动连接 | **不做** |

- 返回原样复用 `NodeImportResult`（§4.1）：`imported`、`skipped[]`（`unsupported_scheme` / `unsupported_method` / `malformed` / `duplicate`）、`nodes[]`。**不返回 `path`，不回显文件内容**；日志同样不写路径与内容。
- 传 `configId` → 按解析顺序追加，配置没有 `current_node_id` 时取第一个；发 `node-list-changed(reason = "manual_create")` + `config-changed(change = "updated")`。不传 → 只进节点池。
- 安全边界：**Host 无法验证路径是否真由用户选出**，保证来自四层约束——仅 UI 注册（不注册 AI 工具，模型不能传路径）+ 绝对路径 + 1 MiB 上限 + 不返回路径与内容。若需要密码学意义上的来源证明，要改成 Host 侧拉起文件对话框并直接导入（路径不经过前端），本轮不做。
- 联动：`runtime.md` **不涉及**（只写节点池 / 配置节点集，不经过 Runtime Manager，不改变 `RuntimeSnapshot`，不重启连接）；`events.md` **不涉及**（复用 `manual_create`；该枚举注释目前只写了 `node_create`，等下次 events 升版再补文本，不为此单独升版）；`tools.md` **不涉及**（无 AI 工具）；`data-model.md` **不涉及**（节点表与 `source` 已存在）。

**前端行为约定**：文件入口用**系统对话框**（`plugin-dialog open()`，复用现有 `dialog:allow-open`，不新增权限），不用应用内文件树，也**不接窗口拖放**。选完**不立刻导入**：先显示文件名并要一次「导入」确认，确认后调用本命令；**不把文件内容填进文本框**——那需要前端读文件（fs 权限）或命令返回全文，两者都会破坏「不回显内容」与最小权限。必须传当前配置的 `configId`；没有当前配置时不调用本命令，先让用户在左侧选或新建一套配置，避免节点只进池却在界面上看不见。

| 错误码 | `details.reason` | 场景 |
|---|---|---|
| `INVALID_ARGUMENT` | `invalid_path` | 空、非绝对路径 |
| `INVALID_ARGUMENT` | `file_unreadable` | 不存在、不是普通文件、不可读、IO 错误 |
| `INVALID_ARGUMENT` | `file_too_large` | 超过 1 MiB，`details.max_bytes` |
| `INVALID_ARGUMENT` | `not_node_text` | 解析后没有可用节点 |
| `NOT_FOUND` | — | `configId` 不存在 |
| `SECRET_STORE` | — | `secrets.enc` 写入失败 |
| `INTERNAL` | — | 内部错误 |

- 部分成功不算失败：与文本导入一致。
- **已知限制**：`not_node_text` 的 `details` 目前只有 `reason`——解析器在「全部失败」时不保留逐条跳过原因，所以界面只能说「这个文件里没有可用的节点」，无法区分「全是加密方式不支持」还是「全是格式错误」。若要区分，需要给 #67 / #69 的 `not_node_text` 增加 `details.skipped`（两条命令共用解析，必须一起改），本轮不做。
- 本阶段只做 Shadowsocks，方法白名单同 §4.1。

### 4.2 `node_create { name, server, port, method, password, configId? }` → `NodeSummary`

手动编辑一个节点。只有五个字段，与 `docs/config-execution.md` §6 一致。

| 字段 | 规则 |
|---|---|
| `name` | trim 后非空、≤ 64 字符 |
| `server` | 主机名或 IP，**不带 scheme、不带端口、不含空白**。手动模式**允许**私网地址（用户可能连自己的内网服务器），与 URL 抓取的 SSRF 限制不冲突 |
| `port` | 1–65535 |
| `method` | 白名单内（当前 `aes-256-gcm`） |
| `password` | 非空、≤ 256 字符。**只进 `secrets.enc`**，不落库、不进日志、不进错误信息 |

- 写入顺序：先写 `secrets.enc` 的 `node:<新 id>`，再在事务里写 `nodes` + 可选 `config_nodes`。行写入失败 → 删除刚写的密钥，不留孤儿。
- `configId` 指定时追加到该配置；语义与 §4.1 相同。
- 成功后发 `node-list-changed`（`reason = "manual_create"`），有 `configId` 再发 `config-changed`（`change = "updated"`）。
- **不自动连接**，不触发探测。

错误：`INVALID_ARGUMENT`（`invalid_argument`、`unsupported_method`）、`NOT_FOUND`、`SECRET_STORE`、`INTERNAL`。

- **具体校验由前端先做**：名字非空/≤64、地址不带 scheme 与端口、端口 1–65535、密码非空/≤256。Host 侧不区分具体原因，一律 `details.reason = "invalid_argument"`；只有 method 不在白名单时是 `unsupported_method`。
- **`port` 在 Host 侧是 `u16`**：`70000`、非整数或缺字段会**在反序列化阶段直接失败**，拿不到本契约的结构化错误——前端必须先校验，不要指望 Host 兜住。

### 4.3 `node_switch { configId, nodeId }` → `NodeSwitchData`

底部「切换到此节点」（B2）。**这是唯一改变当前节点的命令。**

```ts
type NodeSwitchData = {
  config_id: string;
  node_id: string;
  previous_node_id: string | null;
  connected: boolean;            // true = 同时做了在线热切换
  runtime: RuntimeSnapshot | null;
};
```

| 当前状态 | 行为 |
|---|---|
| 未连接 | 只改 `configs.current_node_id` → `connected = false`、`runtime = null`。**不启动 VPN** |
| 已连接、这套配置就是当前连接的配置 | 通过 selector 热切换（`runtime.md` §5.3 的 `PUT /configs?force=true` 或 Clash 选择器），不重启进程 → `connected = true` |
| 已连接、但这套配置不是当前连接的配置 | `PRECONDITION_FAILED`，`details.reason = "config_not_running"`。先切配置还是先切节点，是两个动作，不合并 |
| `nodeId` 不属于该配置 | `NOT_FOUND`，`details.reason = "node_not_in_config"` |

- 热切换失败 → `PRECONDITION_FAILED` / `runtime_switch_failed`，**`current_node_id` 不变**：库里记的必须是实际在跑的那个节点，否则重启后用户会连到另一台而不知道为什么。
- `nodeId` 就是当前节点 → 幂等返回，不发事件。
- 成功后发 `node-switched`（`events.md` §4.11）。

错误：`NOT_FOUND`、`PRECONDITION_FAILED`、`TIMEOUT`、`INTERNAL`。

### 4.4 `node_probe { nodeId }` → `NodeProbeData`

底部「测试连通」（A4 / D1 的界面入口）。

```ts
type NodeProbeData = {
  node_id: string;
  reachable: boolean;
  latency_ms: number | null;
  probe_method: "clash_delay" | "tcp";
  checked_at: number;            // Unix 毫秒
  error: { code: string; message: string } | null;
};
```

| 条件 | 方法 |
|---|---|
| 运行时在跑，且该节点属于当前连接的配置 | `clash_delay`：`GET /proxies/node-<id>/delay`，**真实可用性**（含密码与加密方式是否正确） |
| 其余情况 | `tcp`：对 `server:port` 做 TCP 握手，3 s 超时。只能说明端口活着，**不能说明握手能过** |

- **失败不是错误**：节点不可达返回 `reachable = false` + `error`，命令本身 `Ok`。与 `llm_provider_test` 同一条原则：测试失败是测试的正常输出，不该抛成异常让调用方分流。
- 只有入参非法（`nodeId` 不存在）才返回 `Err(NOT_FOUND)`。
- **不登记问题**（J1）：单节点手动测试失败不等于用户被阻断；登记问题会把它变成中间区域的打扰。连接链路上的失败才登记（§5.2）。

### 4.5 `proxy_params {}` → `ProxyParams`

三级用户要的代理地址与端口（A5），`proxy_card` 的数据源。

```ts
type ProxyParams = {
  available: boolean;            // 是否有可展示的代理端点
  host: "127.0.0.1";
  port: number | null;
  protocols: ["http", "socks5"]; // 单端口双协议，恒定
  port_source: "runtime" | "configured" | "pending";
  config_id: string | null;
  reason: "tun_mode" | "not_running" | "no_config" | null;
};
```

- `host` **恒为 `127.0.0.1`**，不给局域网开关（`docs/user-flows.md`「选只给我一个代理地址之后给什么」）。
- `port_source`：
  - `runtime`：运行时在跑，`port` 是**实际监听**的端口（`RuntimeSnapshot.mixed_port`）。这是唯一能拿去填软件的值。设置了端口但被占用顺延时，界面用 `RuntimeSnapshot.port_fallback` 说明「设置的是哪个」。
  - `configured`：未连接。`port` 是**用户设置值**（`proxy_port_get`，默认 7890）。这是用户自己填过的数，不是预测。
  - `pending`：**已废弃**，不再产生。端口只有一个来源（全局设置），未连接时也有确定值。
- `reason`：`tun_mode`（active 配置是接管全部，不需要代理地址）、`not_running`、`no_config`。
- **端口被占用时自动顺延，并如实回显**：候选链 `[设置值] → 7890–7899 → 系统分配`；`runtime` 来源必须是实际值，不得回显设置里的期望值。降级时 `RuntimeSnapshot.port_fallback = { requested, actual, reason }`，界面按 `reason` 说明「被占用」或「环境绑不上」。
- 成功后**不发事件**。端口变化由 `runtime-state-changed` 的 `snapshot.mixed_port` 推送，UI 收到后重渲染卡片，不再轮询本命令。

### 4.6 `node_probe_all { configId?, nodeIds? }` → `NodeProbeAllData`

节点面板的「全部测速」；带 `nodeIds` 时只测搜索过滤后的子集。**只读**：不改配置、不改当前节点、不登记问题、不发任何 `*-changed` 事件。

```ts
type NodeProbeAllData = {
  run_id: string;
  config_id: string;
  total: number;                 // 实际要测的节点数（nodeIds 过滤后）
  concurrency: number;           // 固定 6
  ignored_node_ids: string[];    // nodeIds 里不属于该配置、被忽略的 id
};
```

| 项 | 规则 |
|---|---|
| `configId` 省略 | 用 active 配置；**没有任何配置** → `PRECONDITION_FAILED`，`details.reason = "no_config"` |
| `nodeIds` 省略 | 测该配置**全部**节点 |
| `nodeIds` 提供 | 只测这些节点；**必须是该配置节点集里的 id**。不在集合里的 id **忽略并记入 `ignored_node_ids`**，不报错——一次搜索里有一个脏 id 不应让整批失败 |
| `nodeIds = []` | `PRECONDITION_FAILED`，`details.reason = "no_nodes"`（与无节点一致） |
| 节点集为空 | `PRECONDITION_FAILED`，`details.reason = "no_nodes"` |
| 已有批次在跑 | `BUSY`，`details.run_id` 指向进行中的批次。**全局同时只允许一个批次**，跨配置也一样 |
| 并发 | 固定 6；单个节点沿用 `node_probe` 的 3 秒超时，**不重试** |
| 探测方法 | 见下方「探测方式」；单节点探测复用同一个函数，不复制逻辑 |
| 单节点失败 | 不中断整批；失败也是一种结果（`reachable = false`），照常发进度 |
| 结果顺序 | 按完成顺序发 `node-probe-progress`，**不按节点顺序** |
| 生命周期 | 批次不跨进程、**不进 Job**、不落库；应用退出即结束，不发完成事件 |

- `total` = 实际要测的节点数；`node-probe-progress.total` 同值。**响应必须带 `ignored_node_ids`，即使为空数组**——漏掉它，前端就不知道「实际测的比按钮少」，提示永远不出现。
- 每测完一个节点发一条 `node-probe-progress`（`events.md` §4.19）；整批结束（含取消）发且只发一条 `node-probe-finished`（§4.20）。
- 关闭面板**不取消**批次；只有 `node_probe_cancel` 或进程退出会结束它。
- 错误：`PRECONDITION_FAILED`（`no_config` / `no_nodes`）、`BUSY`、`INTERNAL`。

> 前端「测这 N 个」文案依赖 `nodeIds`：**后端实现该参数之前，该文案不可用**，按钮按「全部测速」展示；否则过滤后点按钮会实际测全部节点。

**探测方式（`node-list.md` §6.5 定稿）**：

| 情形 | 方式 |
|---|---|
| 已连接，且是当前配置 | `clash_delay`，直接复用运行中的 Clash API |
| **完全未连接** | **临时起一次运行时**（探针槽：不写系统代理、不启 TUN、临时端口、只绑 `127.0.0.1`）→ `clash_delay`；启动失败或 **8 秒内未就绪 → 整批降级 `tcp`**，不报错、不中断 |
| 已连接**别的配置** | 不起第二个运行时，**整批降级 `tcp`** |

- 临时运行时**不能污染连接状态**：`runtime_status` 与 `runtime-state-changed` 在探针期间仍报「未连接」，顶部按钮不能变成「断开」。
- 批次结束或取消时停止**自己起的**运行时；期间用户点了「启动 VPN」→ 批次取消（`cancelled = true`、`reason = "connected"`），**先停探针运行时，再走正常连接流程**。
- 单节点「测这个节点」**不启动运行时**：未连接时仍走 `tcp` 并标「可达」。
- `method` 与文案口径不变：`clash` = 可用，`tcp` = 可达；降级时整批只能写「可达」。

### 4.7 `node_probe_cancel { runId }` → `{ cancelled: boolean }`

尽力而为地取消一个批次。

- `runId` 命中正在跑的批次 → 停止调度，在飞的探测丢弃，不再发新的 `node-probe-progress`；随后发一条 `node-probe-finished`，`cancelled = true`。已出的结果保留在内存缓存里。
- `runId` 不存在或已结束 → `{ cancelled: false }`，**不报错**（幂等；重复点「停止」不应变成失败）。
- 错误：`INTERNAL`。

### 4.8 `node_probe_snapshot { configId? }` → `NodeProbeSnapshotData`

打开面板时读取缓存与运行态；**不发网络请求**。

```ts
type NodeProbeSnapshotData = {
  config_id: string;
  results: NodeProbeData[];        // 该配置节点集在内存缓存里的结果
  run: null | {
    run_id: string;
    done: number;                  // 已完成的节点数
    total: number;
    started_at: number;            // Unix 毫秒
    phase: "preparing" | "probing";
    method: "tcp" | "clash";       // clash = 真实可用性（可用）；tcp = 仅可达（可达）
  };
};
```

- `run` **只在该 `configId` 有批次在跑时非空**。全局只有一个批次；别的配置在跑时，本配置拿到 `null`——不能据此认为「没有批次在跑」。
- **`run` 为空 ≠ 已测完；`results` 有内容也 ≠ 已测完。** 有缓存只说明以前测过，可能已经过期；判断是否在测只看 `run`。这条是契约，不是 UI 细节。
- `run` 非空时，UI 显示进度条与「停止测速」，并从 `snapshot.run.done` 之后继续接收进度事件。重开面板可能先收到一条 `done` 更小的迟到事件：按 `run_id` 匹配、按 `done` 去重。
- `run.phase` 让重开面板能恢复「正在准备」：`preparing` 时显示准备态、`done` 通常为 0；`probing` 时显示进度。`run.method` 让面板从第一帧就能标明测试方式，不必等结果事件。
- 术语固定，不得混用：**`clash` = 真实可用性（界面写「可用」）；`tcp` = 仅可达（界面写「可达」）**。降级发生在探测开始之后时，`run.method` 以最新值为准。
- `results` 只含该配置节点集里有缓存的节点，没有缓存的节点不出现在数组里；缓存键是 `node_id`，跨配置共用（延迟是节点属性）。
- `configId` 省略 → active 配置；没有任何配置 → `PRECONDITION_FAILED`，`details.reason = "no_config"`。节点集为空是合法状态：`results: []`、`run: null`。
- 错误：`PRECONDITION_FAILED`（`no_config`）、`INTERNAL`。

---

## 5. 探测

### 5.1 `probe_run { configId?, targets? }` → `ProbeReport`

连接后的连通性探测（D1 本地自检 / D4 结构化诊断包），`reachability` 块与问题采集的数据源。

```ts
type ProbeTarget = { label: string; url: string };

type ProbeCheck = {
  name: "dns" | "egress_ip" | "egress_differs" | "target";
  target: string | null;         // 仅 name = "target" 时非空
  ok: boolean;
  latency_ms: number | null;
  error_code: string | null;
  detail: string;                // 面向用户的一句话，已脱敏
};

type ProbeReport = {
  probe_id: string;
  config_id: string;
  checked_at: number;            // Unix 毫秒
  ok: boolean;                   // 全部通过
  checks: ProbeCheck[];
  issue_ids: string[];           // 本次触发或合并的问题记录
};
```

固定顺序（`docs/config-execution.md` §8）：

| # | `name` | 判定 |
|---|---|---|
| 1 | `dns` | 解析一个境外基准域名成功 |
| 2 | `egress_ip` | 通过代理拿到出口 IP |
| 3 | `egress_differs` | 出口 IP ≠ 直连 IP（分流真的生效了） |
| 4 | `target`（每个 target 一条） | 目标站点能打开 |

- 前两项决定「能不能用」，后两项决定「用得对不对」。四项都过才 `ok = true`。
- `targets` 省略 → 只跑前三项。`targets` 由 AI 用分类目录（I1）把用户说的服务名翻成域名后填入，Host **不做服务名解析**。
- 任意一项失败 → Host 按 J1 **登记或合并问题**（`docs/issue-management.md` §3），并发出 `issue-changed`。这就是 `issue_ids` 的来源。
- 运行时未在跑 → `PRECONDITION_FAILED`，`details.reason = "not_running"`（未连接时没有「连通性」可言）。
- `configId` 省略时用 active 配置；指定但不是当前连接的配置 → `PRECONDITION_FAILED / not_running`。
- **D2 完整诊断（14 项）不在本命令范围内**，仍由 AI 工具 `DiagRun` 承担。本命令只做连接后这四类，够插卡与诊断包用。
- 探测本身**不修改网络状态**、不重启运行时。

错误：`PRECONDITION_FAILED`、`NOT_FOUND`、`TIMEOUT`、`INTERNAL`。

---

## 6. 问题管理（J 组）

问题的生命周期见 `docs/issue-management.md`。**采集与展示不依赖 AI，转交才依赖。**

### 6.0 共用类型

```ts
type IssueSeverity = "P0" | "P1" | "P2";   // PM 裁定 OPEN-05
type IssueState = "open" | "handed_off" | "resolved" | "ignored";

type IssueSummary = {
  issue_id: string;
  type: string;                  // dns_fail / no_route / udp_blocked / auth_failed /
                                 // tun_denied / helper_missing / probe_timeout / rule_stale / ...
  target: string;                // 目标域名 / 节点 id / 空串
  title: string;                 // Host 按 type 从固定文案表取，**不接受外部传入**
  severity: IssueSeverity;
  mode: "system_proxy" | "tun";   // 文档里的 proxy 即 system_proxy
  state: IssueState;
  count: number;
  first_seen: number;            // Unix 毫秒
  last_seen: number;             // Unix 毫秒
  config_id: string | null;      // 全局问题（如 helper_missing）为 null
  session_id: string | null;     // 最近一次转交的 AI 会话
};

type IssueAction = "retry" | "handoff" | "reset_network" | "ignore";

type IssueDetail = IssueSummary & {
  evidence: DiagnosticBundle;
  actions: IssueAction[];        // 由 type 决定，见 docs/issue-management.md §6
  last_handoff_at: number | null;
  resolved_at: number | null;
};
```

`actions` 是给 UI 的按钮提示，不是命令：`retry` → 重试 `runtime_start`；`handoff` → `issue_handoff`；`reset_network` → E3，界面调 `network_force_reset`（§7.9）；`ignore` → `issue_ignore`。列表由 `type` 决定（`docs/issue-management.md` §6），Host 给的就是最终结果，UI 不再按类型自己判断。

**没有 `issue_create` 命令。** J1（登记）是 Host 内部行为，由 `probe_run`、运行时事件、启动自检触发。UI 与 AI 都不能凭空造一条问题——否则「问题列表」会变成第二个随便写文案的地方，而它存在的意义恰恰是不依赖 AI 也能说清发生了什么。

### 6.1 `issue_list { state?, severity?, configId?, limit?, offset? }` → `{ issues: IssueSummary[], total }`

- `state` / `severity` / `configId` 都是过滤条件，省略 = 不过滤。
- 排序：`severity ASC`（p0 在前）→ `last_seen DESC`。
- `limit` 默认 50、上限 200；`offset` 默认 0。`total` 是过滤后的总数，用于分页。
- 不返回 `evidence`（可能含大量日志），要明细走 `issue_get`。
- 只读，不发事件。

### 6.2 `issue_get { issueId }` → `IssueDetail`

- 不存在 → `NOT_FOUND`。
- `evidence` 在**采集时就已生成并保存**，这里只是读出来（`docs/issue-management.md` §5：问题发生时的情况事后往往复现不出来）。
- 返回值已脱敏：不含密码、订阅原文、完整配置。

### 6.3 `issue_handoff { issueId, sessionId? }` → `IssueHandoffData`

```ts
type IssueHandoffData = {
  issue_id: string;
  state: "handed_off";
  session_id: string;
  request_id: string;      // 本次投喂对应的 AI 请求
};
```

- 依赖 AI：没有可用 provider → `PRECONDITION_FAILED`，`details.reason = "no_provider"`。
- `sessionId` 省略时：该问题已有转交会话 → **复用**；没有 → 新建一个会话。
- **一次性投喂**：把 `evidence` 整包作为一条消息交给会话，不做多轮追问。投喂后状态置 `handed_off`，发 `issue-changed`。
- 同一问题可以重复转交（用户再点一次）：`count` 不变，`last_handoff_at` 刷新。
- 投喂内容**不包含凭据**，与 `issue_get` 返回的 `evidence` 完全相同。

错误：`NOT_FOUND`、`PRECONDITION_FAILED`（`no_provider`、`provider_unavailable`）、`INTERNAL`。

### 6.4 `issue_resolve { issueId }` → `IssueResolveData`

```ts
type IssueResolveData = {
  issue_id: string;
  state: IssueState;        // 通过 = "resolved"；没通过 = 维持原状态
  verified: boolean;
  probe: ProbeReport | null; // 复测结果；问题类型无法复测时为 null
};
```

- **AI 说「修好了」不算数**：本命令由 UI 在用户点「已解决 / 重试通过」后调用，Host **自己跑一次同样的探测**，通过才置 `resolved`（J4）。
- 复测失败 → `verified = false`，`state` 保持原值（不抛错），`probe` 里带失败原因。
- 可复测的类型（`dns_fail` / `no_route` / `probe_timeout` / `auth_failed`）→ 重跑 `probe_run` 的对应项；不可复测的类型（`tun_denied` / `helper_missing`，本质是权限）→ 只校验对应前置条件（helper 是否已安装、授权是否已给）。
- **resolved 不是删除**：记录保留；同类问题再次出现时由 J1 重开并计数。

### 6.5 `issue_ignore { issueId, ignored? }` → `IssueIgnoreData`

```ts
type IssueIgnoreData = { issue_id: string; state: IssueState };
```

- `ignored` 默认 `true` → `state = "ignored"`；传 `false` → 恢复到 `"open"`（列表里能找回并恢复，`docs/issue-management.md` §6）。
- 对 `resolved` 的记录调用 `ignored = true` 也允许，不影响历史。
- 幂等。
- 发 `issue-changed`（`change = "ignored"` 或 `"reopened"`）。

---

## 7. 运行时与系统

### 7.1 `runtime_start { configId? }` → `RuntimeSnapshot`

无 AI 模式的主行动（A1 建立连接）。与 AI 工具 `RuntimeStart` **共用同一份 Host 实现**。

| 项 | 规则 |
|---|---|
| `configId` 指定 | 解析该配置；不存在 → `NOT_FOUND` |
| `configId` 省略 | 用 active 配置；**没有任何配置** → `PRECONDITION_FAILED`，`details.reason = "no_config"` |
| 用哪个节点 | 一律用 `config.current_node_id`；为空时用节点集第一个。**本命令没有 `nodeId` 参数** |
| 节点集为空 | `PRECONDITION_FAILED`，`details.reason = "no_nodes"` |
| 连接方式为 `tun` 且特权助手不可用 | `PRECONDITION_FAILED`，`details.reason = "tun_helper_missing"`（批 5） |
| 已在连接中、同一套配置 | 幂等：返回当前快照 |
| 已在连接中、指定了另一套配置 | `PRECONDITION_FAILED`，`details.reason = "other_config_running"`。换配置走 `config_activate`（会先确认断开），**不在这里静默切换** |
| 成功后 | 系统代理已按连接方式设置、运行时 `state = running`；返回的 `RuntimeSnapshot` 必须满足 §7.3 |
| `last_used_at` | 成功后刷新为该配置的当前毫秒时间 |

**2.0 删掉了「没有 active 就用默认配置包」的第二级回退。**

> 旧回退存在的理由是「全新安装没有 profile，只有默认包」。新模型里测试节点也必须落成一套配置才会出现在左栏，全新安装的空态是「还没有配置」，此时**应该引导用户新建，而不是替他连一条他没选过的线路**。没有配置就报 `no_config`，由 UI 的空态与 AI 的 `source_choice` 接住。

**不变量（必须实现，不是行为描述）**

> **连接失败不得回退到任何其它配置或节点。** 有 active 配置但连不上（凭据缺失、节点下线、握手失败）时，错误如实返回。

理由不变：静默换成别的出口会让用户以为自己连的是选中的那台，而实际流量走了另一条线路——「悄悄换了出口」比连不上更危险。

**7.1.1 返回状态的不变量**

- `state` 只可能是 `running` 或 `degraded`；其它状态一律视为失败并返回错误。**不允许「返回成功但 state 不是 running」**（这是 1.0.10 的 D-36 缺陷）。
- `mixed_port` 必须是本次实际监听的端口，不得为常量或 `null`。
- `config_id` / `config_name` / `node_id` / `node_name` 与目标一致；**未连接时四者为 `null`**。
- `connected_since` 为本次进入 running 的时刻（ISO 8601）。
- `exit_ip` / `latency_ms` 允许为 `null`（探测是异步的），**不代表连接失败**。

错误码：`RUNTIME_NOT_INSTALLED`、`PRECONDITION_FAILED`（`no_config` / `no_nodes` / `other_config_running` / `tun_helper_missing`）、`NOT_FOUND`、`RUNTIME_CONFIG_INVALID`、`RUNTIME_PORT_UNAVAILABLE`、`TIMEOUT`、`UPSTREAM_ERROR`、`INTERNAL`。

### 7.2 `runtime_stop {}` → `RuntimeSnapshot`

| 项 | 规则 |
|---|---|
| 顺序 | **先撤系统代理，再停运行时**。顺序不可交换 |
| 代理撤销失败 | **中止断开**，运行时保持运行，返回 `PRECONDITION_FAILED`，`details.reason = "proxy_restore_failed"`。不可以在代理没撤掉的情况下停掉 sing-box——那等于把用户直接断网 |
| 已经断开 | 幂等：返回当前快照（`state = "idle"`），不报错 |
| 成功后 | `state = "idle"`，`mixed_port` / `config_id` / `node_id` / `connected_since` / `exit_ip` / `latency_ms` / `node_latency_ms` 全为 `null`，渲染配置已删除 |

> 这条规则与退出流程一致：**宁可断开失败，也不能留下指向死端口的系统代理**。

### 7.3 `runtime_status {}` → `RuntimeSnapshot`

2.0 的 `RuntimeSnapshot`（与 `runtime.md` §2.5 的 `2.7.0` 一致，**版本号跟 `runtime.md`，不跟本文件**）：

```ts
type RuntimeSnapshot = {
  contract_version: "2.7.0";
  state: RuntimeState;                // runtime.md §2.1，七态不变
  mode: "system_proxy" | "tun" | null;
  pid: number | null;
  upstream_version: string | null;
  uptime_seconds: number | null;
  config_id: string | null;           // 2.0：原 profile_id
  config_name: string | null;         // 2.0：原 profile_name
  node_id: string | null;             // 2.0 新增：当前实际连接的节点
  node_name: string | null;           // 2.0 新增
  connected_since: string | null;     // ISO 8601 UTC
  mixed_port: number | null;
  port_fallback: {                    // 用户设置的端口没用上、本次用了别的；其余为 null
    requested: number;                // 设置值
    actual: number;                   // 本次实际监听
    reason: "occupied" | "unavailable"; // 被占用 / 环境绑不上（如 <1024 无权限）
  } | null;
  latency_ms: number | null;          // 出口 IP 探测耗时，不是节点 ping
  node_latency_ms: number | null;     // 2.3：到节点的真实延迟（Clash API delay 测试）
  direct_ip: string | null;           // 不经代理测得的直连出口 IP
  config_hash: string | null;         // "sha256:<hex>"
  applied_route_revision: number | null; // runtime.md 2.1：建连时 configs.route_revision 的值
  route_region: string | null;        // 2.5：生成当前配置时判定的地区（小写 cc；未知为 null）
  system_proxy_enabled: boolean;
  system_dns: "tunnel" | "unchanged" | null; // runtime.md 2.6：连接期系统解析器是否已指向隧道
  health: HealthSnapshot;
  traffic: TrafficStats | null;
  connections: number | null;
  restart_count: number;
  last_error: AivpnError | null;
  last_transition_at: string;         // ISO 8601 UTC
};
```

- `mode` 在 2.0 扩展为 `"system_proxy" | "tun"`；`tun` 在批 5 接线前不会出现。
- `pid` / `upstream_version` / `uptime_seconds` 在 `idle` 与 `failed` 下**必须为 `null`**。
- `traffic` 为 `null` 表示**没有数据**（未连接 / 刚连上还没采到 / TUN 模式），不是 0 字节；采样失败保留上一次的值。数据源、频率与速率算法见 `runtime.md` §2.4。
- `config_id` / `node_id` 与 `connected_since` 同生同灭：只在 `running` / `degraded` 下非 `null`。
- 字段恒存在，无值写 `null`，**不得省略键**。
- `port_fallback` 只在 `system_proxy`、已连接（`running` / `degraded`）且 `actual != requested` 时非 `null`；TUN 与未连接恒为 `null`。`reason` 只有 `"occupied"`（被别的程序占着）与 `"unavailable"`（环境绑不上，如 <1024 无管理员权限）两个值，**写死**；界面按 `reason` 说不同的话，不能按文本猜。
- `route_region` 是建连时判定的地区（小写 cc），断开为 `null`。已连接时它反映**本次连接所用的地区**；`null` 只表示当时判不出地区，**不表示可以回退到实时值**——界面按「未知」显示，不得拿 `route_get.detected_region` 顶上。`route_get.applied_region` 与它同源。

### 7.4 `net_repair { action, port? }` → `NetRepairResult`

与 AI 工具 `NetRepair` **共用同一份实现、同一组动作**（`tools.md` §4.19）。UI 只用前两种。

```ts
type NetRepairAction = "restore_direct" | "flush_dns" | "set_proxy" | "clear_proxy";

type NetRepairResult = {
  ok: boolean;
  action: NetRepairAction;
  detail: string;             // 面向用户的完成说明，不含凭据
  exit_ip: string | null;     // 仅 restore_direct 后带直连出口 IP；其余为 null
  verified: boolean;          // 动作后复读系统设置，是否与预期一致
};
```

| action | 行为 | UI 是否使用 |
|---|---|---|
| `restore_direct` | 撤系统代理（含复核）→ 停运行时 → 删渲染配置 → 不带代理探测出口 IP | ✅ 设置 › 遇到问题 ›「清除残留代理」（E1） |
| `flush_dns` | macOS：`dscacheutil -flushcache` + `killall -HUP mDNSResponder`，**经特权助手以 root 执行**（普通用户 HUP 不动 mDNSResponder，退出码 0 不代表已刷新）；Windows：`ipconfig /flushdns` | ❌ 正式界面未使用；当前只有 AI 工具能调用（E2） |
| `set_proxy` | 把系统代理指向 Veyl 自己的 mixed 端口，`port` 必填且必须等于当前运行时的端口 | ❌ 留给模型 |
| `clear_proxy` | 撤代理并恢复备份，不停运行时 | ❌ 留给模型 |

**UI 实际调用**：只有 `restore_direct`（`App.tsx:941`）。`flush_dns` 没有正式界面入口，只能由 AI 工具 `NetRepair` 调用；本轮不补设置页入口，`settings-ia.md` §3.3 P17 已记录理由（与「重置网络」重叠，用户无法判断何时该用）。

- `exit_ip` / `verified` **恒存在**，没有值时写 `null` / `false`，不要省略键。
- `verified = false` 时 `ok` 必须为 `false`。
- `ok = false` 时 `detail` 必须说明卡在哪一步；可重试的操作不要把用户引向「重装」。
- 未知 `action` → `INVALID_ARGUMENT`，`details.supported` 列出四个取值。

> **E3 重置网络（高破坏性，需二次确认）已下发**，但**不是** `net_repair` 的一个 action，而是独立命令 `network_force_reset`（§7.9）：它要跑八个固定步骤并回逐项结果，塞进 `net_repair` 的四值 `action` 里会让返回形状分裂。`net_repair` 保持上面四个 action 不变。

### 7.5 `open_log_dir {}` → `{ path: string }`

定位当前日志文件，供「打开日志」使用（E4）。

- **不接受任何路径参数**。签名就是空对象，Host 自己决定打开哪里——防止被调用方指定任意目录，把「打开日志」变成「浏览文件系统」。
- 行为是**用系统文件管理器定位到日志文件**（macOS `open -R`，Windows `/select`），**不是**用编辑器打开、也不是 `open` 整个目录。
- 返回 `path` 便于 UI 把路径显示出来。
- 文件不存在 → `NOT_FOUND`，`details.hint = "还没有日志，先连接一次"`；不要临时创建一个空文件来「让它成功」。

### 7.6 `open_external { url }` → `{ ok: true }`

用系统浏览器打开一个外链。**不是通用 URL 打开器。**

- 只允许 **`https`**，且 host 命中 Host 侧白名单常量。当前白名单只有 DeepSeek 平台域名（用于「怎么拿 Key」的引导）。
- 不在白名单 → `INVALID_ARGUMENT`，`details.reason = "url_not_allowed"`。
- 不跟随、不代理、不预取；只把 URL 交给系统 opener。
- 加域名必须改 Host 常量并同步本节——**不允许由前端或模型传任意域名**。

### 7.7 `tun_helper_open_settings {}` → `{ opened: true }`

把用户送到「系统设置 › 登录项与扩展」，让他批准后台助手。

首次 TUN 连接以 `tun_denied` 失败、或助手停在 `requires_approval` 时，界面给一个可点击的入口；**用户批准后重新调用连接命令即可，不需要退出 App**（`tun-mode.md` §8、实施计划 M3）。

- 无参数、无副作用：只调用系统打开设置面板，**不改注册状态、不做任何提权、不弹我们自己的授权框**。
- macOS 走 `SMAppService.openSystemSettingsLoginItems()`。**非 macOS 是 no-op，仍返回 `{ opened: true }`**——这个值不表示「真的打开了」，UI 不应在非 macOS 暴露该入口，也不能据此判断结果。
- 它不检查助手当前状态；要不要显示这个入口，由连接失败时的 `details.reason` 决定。

### 7.8 `tun_helper_uninstall {}` → `{ ok: true }`

从 App 内卸载后台助手（macOS：注销 LaunchDaemon 注册）。设置页或诊断区调用。

- **幂等**：没注册过也返回成功，重复调用无副作用。**非 macOS 是 no-op**，返回 `{ ok: true }`——不存在的助手等于已经卸载。
- **不做任何提权**：注销由系统完成，不需要管理员密码，也不弹授权框。
- **不负责停 sing-box**：TUN 正在运行时应先 `runtime_stop` 再调本命令（清理顺序见 `capabilities.md` §3.1）。
- 失败返回 `{ code, message }`，`code` 取自权限层错误码（当前只会是 `helper_install_failed`）。**这是 §1.2 通用 `AivpnError` 的刻意例外**：本命令没有重试语义，也不需要 `request_id`；若将来要统一，以 `AivpnError` 为准，不要两套并存。

### 7.8.1 `tun_helper_info {}` → `TunHelperInfoData`

后台组件（TUN helper）的构建与运行状态。只读、无副作用、**不联网**。

```ts
type TunHelperInfoData = {
  running_build: string | null;   // 正在运行的构建；未运行时为 null
  expected_build: string;         // 随包/已安装的期望构建
  stale: boolean;                 // running_build 存在且 != expected_build
  state: "running" | "not_running" | "stale" | "start_failed" | "file_invalid";
  needs_admin_restart: boolean;   // 无法自助重启，需要管理员/系统授权
};
```

`state` 五值互斥，语义固定：

| 值 | 含义 | `needs_admin_restart` |
|---|---|---|
| `running` | helper 在运行，且构建与期望一致 | `false` |
| `not_running` | 未在运行（launchd 未加载），但磁盘文件有效 | `false`（可直接重启拉起） |
| `stale` | 在运行，但构建与期望不一致 | `false`（可自助 `restart` 换新映像） |
| `start_failed` | launchd 尝试拉起但失败（崩溃、退出码异常） | `true` |
| `file_invalid` | 磁盘上的 helper 缺失、不可执行或验签失败 | `true`（需重装） |

- `state = "running"` 时 `stale` 必须为 `false`；`state = "stale"` 时 `stale` 必须为 `true`。两者不得自相矛盾。
- **`needs_admin_restart = true` 时，`tun_helper_restart` 不应被 UI 当作可用操作**；界面应显示重新安装/授权的说明。
- 旧 helper 不返回 `helper_build` / `helper_version`（`tun-backend.md` §3.2）：此时 `running_build` 按 `null` 处理，**不是** `stale` 以外的新状态；是否旧版只看 `tun_helper_restart` 的结果（`tun-backend.md` §1.1.1）。

### 7.8.2 `tun_helper_restart {}` → `{ ok, restarted, needs_admin_restart }`

让 helper 换新映像：调用 `TunBackend::restart()`（`tun-backend.md` §2），helper 回 `ok` 后以 `exit(75)` 退出，由 launchd 拉起。

- **调用前必须先 `runtime_stop`**：重启会中断当前 TUN。命令本身不替调用方停连接——但它必须在检测到 TUN 正在运行时拒绝，`PRECONDITION_FAILED`，`details.reason = "tun_running"`。
- `restarted` 表示本次是否真的发生了进程替换（旧进程退出 + launchd 拉起新进程）；helper 原本未运行、本次直接拉起时为 `false`。
- `ok` 表示调用结束时 helper 处于可用状态且 `running_build == expected_build`；`restarted = true` 但新映像仍不一致时 `ok = false`。
- **旧 helper（`restart` 返回 `bad_request`）**：`ok = false`、`restarted = false`、`needs_admin_restart = true`。不重试、不报内部错误，界面提示需要管理员重装。
- 超时（10 s，`TUN_REPLY_DEADLINE_CONTROL`）按旧 helper 同样处理，但写日志区分 `timeout` 与 `bad_request`。
- 无参数。不接受构建号、路径或版本——换什么映像是 Host 的事。

### 7.8.3 应用退出流程（规范性）

退出流程（`quitting`）必须在进程结束前**先停 TUN、再停代理运行时**：

1. 若 TUN 在运行，调用 `TunBackend::stop()`；失败只记日志，**继续**下一步。
2. 调用与 `runtime_stop` **同一段实现**：先撤系统代理，再停 sing-box。失败只记日志，**继续**退出。
3. 进程结束。

约束：

- **当前实现只停了代理运行时、没停 TUN，是缺陷**；本节是修复目标。退出后不得留下 TUN 隧道、系统代理或孤儿 sing-box。
- 与 `network_force_reset`（§7.9）**共用清理代码**：`stop_tun` → `stop_runtime` 两步同源；退出流程**不**执行 DNS 刷新、路由恢复、临时文件清理——那些是重置专用步骤。
- 清理失败**不得阻塞退出**，也不得弹窗卡住用户；用户点「退出」后进程必须结束。失败信息写入日志。
- `quitting` 期间拒绝新的连接请求：`runtime_start` 返回 `PRECONDITION_FAILED`，`details.reason = "quitting"`（`events.md` §4.7.3）。

### 7.9 `network_force_reset {}` → `NetworkForceResetData`

E3：高破坏性。先断开当前连接，再按固定顺序把整台机器的网络恢复原状。**必须二次确认**，确认文案要说清「会发生什么 / 不会发生什么 / 现在做什么」。

```ts
type NetworkForceResetStep = {
  id: string;      // 八项固定，见下表
  ok: boolean;
  detail: string;  // 诊断文本
};

type NetworkForceResetData = {
  ok: boolean;
  verified: boolean;              // 复查是否通过；false 时 ok 必须为 false
  exit_ip: string | null;         // 不带代理探测到的出口 IP
  steps: NetworkForceResetStep[]; // 恒八项，顺序固定
};
```

| # | `id` | 做什么 |
|---|---|---|
| 1 | `stop_tun` | 关闭接管（先停 TUN，再停代理运行时） |
| 2 | `stop_runtime` | 停运行时 |
| 3 | `restore_proxy` | 撤销系统代理 |
| 4 | `sweep_processes` | 清理残留组件 |
| 5 | `clear_routes` | 恢复系统路由 |
| 6 | `flush_dns` | 恢复 DNS（特权刷新 + `scutil --dns` 点名本机解析器） |
| 7 | `clear_plaintext` | 删除临时配置 |
| 8 | `verify` | 复查用户视角能否上网：探针域名解析 + 一次直连 HTTPS + 出口 IP |

- **无参数**。尤其不接受路径——运行时、规则、日志、临时文件的位置全由 Host 决定。
- `steps` **恒为八项、顺序固定**。UI 按数组顺序渲染，不重排、不按 id 查找缺失项；`id` 不认识时按「其它检查」兜底显示，**不要丢行**。
- `detail` 是**诊断文本**，可能含系统信息。界面不得把它当作主文案直接展示（避免把内部路径、命令行甩给用户），只把它放进「复制诊断信息」；界面主文案按 `id` 用固定中文。
- **单步失败不算命令失败**：整体返回 `ok: false` 与逐项结果，由 UI 呈现下一步。只有命令本身起不来（内部错误、版本不支持）才 `Err`。
- **不给 AI 工具**：`tools/net.rs` 不注册对应工具，模型不能自行触发这条破坏性路径。这条命令只属于 UI（设置 › 高级 › 诊断 ›「强制重置网络」）。
- 与卸载清理共用同一段代码（`capabilities.md` §3.1）。

### 7.10 运行时核心版本管理（`core_*`，默认仅 UI，`core_upgrade` 例外）

这一组命令只服务于「设置 › 高级 › 运行时版本」页。**默认只属于 UI**：`tools.md` §3 不为 `core_info` / `core_check_updates` / `core_cancel_upgrade` / `core_rollback` 注册工具，删除的 `CoreInstall` 也不再补回。**唯一例外是 `core_upgrade`**：模型只能经 `CoreUpgrade` 工具调用它，且必须由用户逐字确认（见下）。原因是这组操作会下载并替换一个会以特权身份运行的二进制，必须由用户看见并显式点击。

四条行为约束（契约级，不是实现建议）：

1. **随包运行时用验签判定。** 启动时校验随包二进制的签名清单（macOS 为代码签名，Windows 为 Authenticode）；校验失败视为不可用，**报错而不是运行**。
2. **已安装版本校验失败自动回落随包。** 启动校验已安装版本失败时，隔离该版本并回落到随包版本，`core_info.active_source` 变为 `"bundled"`；不回落到「无运行时」。
3. **绝不静默下载。** 只有 `core_upgrade` 被用户显式触发（设置页）或经 `CoreUpgrade` 工具且用户在确认卡上同意后才允许下载。连接、诊断、启动、`core_list_versions`、`core_check_updates` 都不得触发下载。
4. **启动过程不联网。** App 启动不检查更新、不拉清单、不下载；`core_check_updates` 只能由设置页上的「检查更新」按钮调用。

#### `core_info {}` → `CoreInfoData`

```ts
type CoreInfoData = {
  bundled_version: string;                    // 随包运行时版本，恒定存在
  active_version: string;                     // 当前实际会启动的版本
  active_source: "bundled" | "installed";     // active_version 的来源
  restart_required: boolean;                  // 有已安装/回滚的版本需要重启 App 才生效
};
```

- 无参数、无副作用、**不联网**。UI 在打开设置页和收到 `core-upgrade-finished` 后各调用一次。
- `restart_required = true` 时界面必须提示「重启后生效」，**不自动重启 App**。

#### `core_check_updates {}` → `CoreCheckUpdatesData`

```ts
type CoreCandidate = {
  version: string;
  size: number;   // 字节
};

type CoreCheckUpdatesData = {
  network: "ok" | "unreachable" | "source_error";
  candidates: CoreCandidate[];   // 新于 active_version 的版本，按版本降序
  cached: boolean;               // true = 来自本地缓存（联网检查失败），不是实时结果
};
```

- 「检查不到」是**正常结果**，写在 `network` 里，不抛错误：`unreachable` = 网络不可达；`source_error` = 源返回了非 200 或格式非法。
- `network = "source_error"` 与下一节命令错误码 `SOURCE_UNAVAILABLE` 是同一件事的两个位置：**查询阶段**写在数据里，**下载阶段**才抛错误。
- `cached = false` 时 `network !== "ok"` → `candidates` 必须为空数组。
- `cached = true` 时允许带**上一次成功验签**的候选；界面必须标「可能已过期」，不得当成实时结果，也不得据此自动下载（`core_upgrade` 会重新联网验证）。
- **只查询，不下载。** 成功结果写 `~/.veyl/runtime/manifest-v1.json` + `.sig`（0600），失败时可回退这份缓存；缓存同样要过验签与有效期检查。

#### `core_upgrade { version }` → `{ job_id, current_version, target_version }`

- **命令自己完成全部检查，不假设调用方已经做过**：每次调用都重新拉取并验签清单（请求带 `Cache-Control: no-cache`，**本地缓存一律不得放行升级**），在**本次**清单的全部未 `yanked` 版本里按平台/架构查找 `version`；找不到 → `NOT_FOUND`。
- 目标版本必须**严格高于**当前生效版本（`active_version` 为空时按 `bundled_version`）：相等或更低 → `PRECONDITION_FAILED`，`details.reason = "not_newer"`、`details.current_version` 给出实际值；不建任务、不静默降级。
- 检查 + 建任务的同步阶段 ≤ 12 秒；单次清单请求 5 秒超时，仅对 `NETWORK_UNREACHABLE` 重试一次（`SOURCE_UNAVAILABLE` / 验签失败不重试）。断网时返回 `NETWORK_UNREACHABLE`，不退回缓存。
- 以上任一失败：不建任务、不写临时文件、不发下载请求。
- 成功返回 `job_id` 以及 `current_version` / `target_version`，供调用方原样转述；进度经 `core-upgrade-progress` 推送，结果经 `core-upgrade-finished` 推送。
- 同一时刻只允许一个升级任务：已有任务在跑 → `BUSY`，`details.job_id` 指向进行中的任务。
- 升级在**后台完成下载、验签、解包与安装**；不改当前正在运行的进程，`restart_required` 置 `true`，由用户重启生效。
- 错误码：`NETWORK_UNREACHABLE` / `SOURCE_UNAVAILABLE` / `HASH_MISMATCH` / `DISK_FULL` / `BUSY` / `NOT_FOUND` / `PRECONDITION_FAILED` / `INTERNAL`。（任务被取消时 `core-upgrade-finished.code = "CANCELLED"`，它是事件级的结束标记，不属于命令错误码。）

**AI 代劳路径（`CoreUpgrade` 工具）**

- 工具必须先完成一次 `core_check_updates`（网络检查）；网络不通时**不调用本命令**，本次 `core_upgrade` 调用次数为 0。仅 `NETWORK_UNREACHABLE` 允许重试一次；`SOURCE_UNAVAILABLE` / 验签失败不重试。
- 只有目标版本严格高于 `active_version`（为空按 `bundled_version`）时才弹确认卡；无新版本时确认卡出现 0 次。
- 确认卡复用 `AskUserQuestion` 阻塞通道（`events.md` §4.8）：Host 填 `kind: "core_upgrade_confirm"` 与 `details`，**模型无法伪造、无法代答**。

```ts
type CoreUpgradeConfirmDetails = {
  current_version: string;
  target_version: string;
  size?: number | null;        // 字节；清单未给时为 null
  source: "official";          // 当前只有官方清单；新增来源要先改契约
  restart_required: boolean;   // Host 弹卡时从 core_info 取
};
```

- `restart_required` 为 `true` 时，卡上要说明「升级后需重启 App 才生效」；UI 按「有则分支」处理，字段缺失时默认按「下次连接生效」展示。
- `source` 目前恒为 `"official"`；它不是 URL，不得把清单地址透给模型或 UI。

- 用户同意后，Host 才调用本命令。同意一次性绑定 `(session_id, request_id, target_version, artifact_sha256)`：换版本、或清单哈希变化，都必须重新确认；绑定只对本次请求有效。
- 用户拒绝 → 工具返回 `CANCELLED`，本命令不被调用。
- 由 Agent 触发时任务 `origin = "agent"`，设置页触发时为 `"ui"`。`origin` 由 Host 按调用路径写入，**不是入参**，模型与前端都不能指定。

#### `core_cancel_upgrade { jobId }` → `{ cancelled: boolean }`

- 排队中或进行中 → 取消并返回 `true`；已结束或未知 `jobId` → `false`，**不报错**（与 `ai_cancel` 一致，前端按「已结束」处理）。
- 取消只清理临时文件，**不回滚已经安装但未生效的版本**——那一步是 `core_rollback` 的职责。

#### `core_rollback {}` → `{ ok: true }`

- 回滚到随包版本：删除/隔离已安装版本，`active_source` 回到 `"bundled"`，`restart_required` 置 `true`。
- 没有已安装版本 → `NOT_FOUND`；升级任务进行中 → `BUSY`。
- 幂等：已经是随包版本时直接返回 `{ ok: true }`。
- 回滚**不改连接**：正在运行的进程仍用旧二进制，直到用户重启。

#### `tun_probe {}` → `TunProbeData`（仅 debug 构建）

```ts
type TunProbeData = {
  conclusion: string;      // 一句话结论
  report_path: string;     // ~/.veyl/diagnostics/tun-<时间>.txt
  utun: string[];          // 接口、地址、路由数、关键段覆盖
  node: string;            // 当前节点服务器 TCP 直连结果
  dns: string;             // 系统 DNS 解析结果
  https: string;           // 经隧道访问固定 HTTPS 的结果
  process: string;         // sing-box pid / 存活 / 建立时间
};
```

- **只在 debug 构建注册**到 `invoke_handler`；release 没有这条命令，也不在 `tools.md` 的工具总表里——AI 无法调用。
- TUN 未连接 → `PRECONDITION_FAILED`。只读：不改路由、不改连接。
- 用于「连上但网络不通」的二分：先看 `node` 与 `https`，再看 `utun` 的关键段覆盖；详见 `docs/tun-diagnostics.md`。

### 7.11 本地代理端口（仅 UI）

```ts
type ProxyPortGetData = { port: number; default_port: number };
type ProxyPortSetData = {
  port: number;
  availability: "free" | "occupied" | "unavailable";   // 保存那一刻的探测结果
};
```

| 命令 | 入参 | 返回 | 规则 |
|---|---|---|---|
| `proxy_port_get` | `{}` | `ProxyPortGetData` | 返回**用户设置值**；从未设置过返回默认 `7890`。`default_port` 恒为 `7890`，给界面画「恢复默认」。**读不写库**；不返回占用状态（打开设置那刻的占用会过期）。 |
| `proxy_port_set` | `{ port: number }` | `ProxyPortSetData` | 整数 1–65535；不满足 → `INVALID_ARGUMENT / invalid_port`。**<1024 不拒绝**；**当前被占用也不拒绝**，`availability` 是保存那一刻实测的三态结果，给界面决定显示哪句提示。 |

`availability` 只有三个取值，**写死，没有第四种**：

| 取值 | 含义 | 界面 |
|---|---|---|
| `"free"` | 保存那一刻可绑定 | 不提示，连接时大概率直接用它 |
| `"occupied"` | 端口被别的程序占着（`AddrInUse`，临时状态，允许保存） | 「这个端口现在被占用了，连接时会自动顺延」 |
| `"unavailable"` | 不是被占用，而是当前环境绑不上（如 <1024 无管理员权限、系统保留端口） | 「这个端口现在用不了，连接时会自动顺延」 |

- 出现契约外的取值按 `"unavailable"` 处理，不得自行扩出「其他」。
- 保存始终成功；三态只用于界面提示，不改变保存结果。
- 连接时 `RuntimeSnapshot.port_fallback.reason` 用同样两个原因值（`occupied` / `unavailable`），但那是**连接时的降级事实**，与保存时的探测是两件事。

- 存储：`settings` 表键 `proxy_port`，十进制字符串；全局一个，不按配置。键缺失或值损坏 → 读回 `7890`（`data-model.md` §3）。
- **端口只影响 `system_proxy` 连接**。TUN 的 mixed 入站继续随机、不上报（`runtime.md` §2.5.1）；探针运行时避开这个端口。
- 连接时的候选链：`[设置值] → 7890–7899 依次 → 系统分配`，去重保序；**不记忆**上一次降级的结果。设置值没用上时顺延，`RuntimeSnapshot.port_fallback` 回显 `{ requested, actual, reason }`（§7.3）。
- **运行时每次连接前自己重读 `settings.proxy_port`**，不依赖 UI 传值：设置值是 App 层状态，连接必须和库对齐。
- 竞态（预检查通过后 bind 前被抢）：顺延到下一个候选，最多试 3 个；全失败 → `RUNTIME_PORT_UNAVAILABLE`，`details.tried_ports` 是本轮试过的端口（`runtime.md` §6.2）。
- **不发事件**：设置值由前端 App 层持有，保存成功后回显返回值即可（与 `events.md` 保持一致，不新增事件）。
- AI 不可调用：不在任何工具 schema 里，模型不能改端口。

### 7.12 问题报告的动作（仅 UI，2.17.0）

材料由工具 `IssueReport`（`tools.md` §4.46）生成；这里两条命令只做「打开文件夹」和「打开发送邮件」。设计见 `docs/design/issue-report.md`。

```ts
type ReportActionData = {
  opened: boolean;
  method: "reveal" | "mail_client" | "copy_only";  // copy_only = 调不起邮件客户端
  report_dir: string;                              // `~/Desktop/Veyl 问题报告/<目录名>`；不返回绝对路径，也不含用户名
  body_chars: number;                              // 仅 mail：进入客户端的正文字符数（≤6000）
  body: string | null;                             // 仅 mail 且 opened:false 时非 null：与组装好的正文逐字相同
};

// `body_chars` 不是必填项：只有 `mail_client` / `copy_only` 时才有意义，
// `reveal` 返回时写 0 或省略即可——不要为了让字段「有值」去编一个数。
```

#### `issue_report_reveal { reportId }` → `ReportActionData`

- 在 Finder / 资源管理器中显示该报告目录。
- `reportId` 先查 Host 的内存登记，未命中再扫报告根目录下每个子目录的 `.report-id`（一行文本）。**不接受路径参数**；扫不到 → `NOT_FOUND`。
- **只认写完的目录**：`.report-id` 是「这份报告已完整」的提交标记。Host 必须先写临时目录（`.tmp-<reportId>/`），全部文件成功后再写 `.report-id`、rename 成最终目录并登记；中途失败要删掉临时目录。
  - 两个命令都**只解析带 `.report-id` 的目录**。半成品目录没有这个文件，扫不到，也就不会被打开或拿去发邮件——「文件写了一半却能被 lookup 命中」是必须排除的状态。
  - 重启后扫盘的实现同样只认 `.report-id`；不要用「目录存在」当完成标志。
- 只打开登记过的目录，不做「打开任意路径」。

#### `issue_report_mail { reportId }` → `ReportActionData`

- 调起系统邮件客户端（`mailto:` 或平台等价物），**预填收件人、标题、正文**；**不发送**，由用户自己按发送。
- 收件人是常量 `FEEDBACK_EMAIL`（`ribencong@gmail.com`），**不可由 UI 覆盖，也不出现在任何设置项里**。用户要发给别人，自己复制正文——应用不提供改收件人的入口，避免误投与钓鱼式改址。
- 标题：`[Veyl 问题报告] <yyyy-MM-dd HH:mm> <平台> · <错误码或一句话>`（≤ 80 字符）。
- 正文：`报告.md` 全文 + 末尾固定一段「请附上同目录的 现场.json 与 日志/」；**上限 6000 字符**，超限按 `design/issue-report.md` §9.1 的顺序裁剪，**永不删**标题、开头声明行（含「`***` 表示已打码」那一行）、`现象`、版本/平台/模式/状态、附件提示。`***` 是唯一的打码占位符，不得替换成别的写法。
- 打开失败（系统没有邮件客户端、被拒绝）→ **不报错甩给用户**：返回 `opened: false, method: "copy_only"`，并把**组装好的正文原样放进 `body`**，UI 用「复制正文」直接拷贝这一份。
  - `body` 的出现条件写死：`method = "copy_only"` 时必定非 `null`；`opened: true`（真的调起了客户端）时必须是 `null`——那时正文已经在邮件里，再回传一份只会让 UI 复制到旧内容。
  - `body` 与送进邮件客户端的正文**逐字相同**（同一根字符串，同一个裁剪结果），不允许为「复制」另生成一个更短或未脱敏的版本。
- 正文里不出现节点地址、密码、配置名、用户名路径（材料已脱敏，本命令不再二次拼装原始数据）。
- **任何返回值与展示都不出现绝对路径与用户名**：`report_dir` 统一写成 `~/Desktop/Veyl 问题报告/<目录名>`（Windows 同样以 `~` 开头，分隔符按平台渲染），`display.facts` 同样写 `~/…` 或只写目录名。**不得**出现 `/Users/<name>/…`、`/home/<name>/…`、`C:\Users\<name>\…`。
  - 命令响应、工具返回、界面、邮件正文四处同一口径。UI 要打开目录时用 `report_id` 走 `reveal`，不需要真实路径；模型也不需要——它只需要知道「报告放在桌面」，回填给用户的也应是 `~` 形式。

#### `issue_report_preference { includeDomains? }` → `{ includeDomains: boolean }`

读取或设置「报告里保留完整域名」。**仅 UI，不注册为 AI 工具。**

- 省略 `includeDomains` → 只读，返回当前值；默认 `false`（域名打码为 `***.<可注册域>`）。
- 传 `true` / `false` → 写入本地设置表 `issue_report_include_domains`，返回写入后的值；幂等。
- **这是用户放宽脱敏的唯一写入路径。** `IssueReport` 的 `include_domains` 入参只能收窄：`tools.md` §4.46 的实际值是 `设置值 && 入参`，模型既读不到也无权改这个设置。所以「模型把用户日志里的域名全放出去」在契约上不可能发生。
- 不发事件（值由 UI 自己持有并回显）；不改任何网络设置；不涉及运行时。
- 错误：`INTERNAL`（存储写入失败）。不校验多余字段——顶层的未知字段按 §1 统一规则拒绝。

---

## 8. 种子（官方默认配置，C 组）

`veyl_seed.json`（只含节点）是客户端唯一消费的种子格式（`docs/config-execution.md` §9）。种子是**运维资源**，分流是**用户偏好**，两者永远分开：种子更新只动节点层。

### 8.1 `default_profile_status {}` → `DefaultProfileResult`

```ts
type DefaultProfileResult = {
  seed_id: "veyl_seed";
  version: string | null;          // 文件里的 version 字段，**仅用于展示**
  content_sha256: string | null;   // 判断是否变化的唯一依据
  node_count: number;
  applied_at: number | null;       // Unix 毫秒
  checked_at: number | null;       // Unix 毫秒
  new_version_available: boolean;  // 只有 refresh 之后才可能为 true
  source: "network" | "cache";     // network = 本次拿到远端；cache = 用本地缓存
  changed: boolean;                // 本次是否真的换了内容
  reason: "offline" | "invalid_content" | "local_write" | null;  // 失败细分；成功时 null
  added: number | null;            // 新增节点数；拿不到时为 null
  removed: number | null;          // 移除节点数；拿不到时为 null
  removed_node_name: string | null;      // 原来在用、但已被新种子下架的节点名
  replacement_node_name: string | null;  // 自动落到的新节点名
};
```

- `source` / `changed` / `reason` / `added` / `removed` 是给 UI 出文案的，**不能从别的字段推**。
- `reason` 只在没换成远端内容时出现；三种取值必须分开，**不得合并**：
  - `offline`：拉不到（断网 / 超时）；
  - `invalid_content`：内容拉到了但解析 / 校验不过，是**我们的内容**有问题；
  - `local_write`：内容拉到了、解析成功，但**写入本机失败**（钥匙串 / 磁盘 / DB），是**用户环境**问题，可重试且缓存未变。
  没有它就分不出「离线」「内容异常」「本地写入失败」。
- `added` / `removed` 来自 `sync_seed_nodes` 的变更集；拿不到时返回 `null`，文案退回「已更新，共 M 个节点」。
- `removed_node_name` / `replacement_node_name` 只在种子刷新后当前节点消失时出现：后端把 `current_node_id` 改到剩余第一个节点，同时给出这两个名字，UI 据此显示「原来的 X 已下架，已切换到 Y」。
  - **剩余列表为空时**：`current_node_id` 置空，`removed_node_name` **仍返回被下架的那个节点名**，`replacement_node_name = null`。UI 显示「原来的 X 已下架，现在没有可用节点」——没有旧名字，这句话说不完整，用户不知道自己丢的是哪个。
  - **字段名固定为这两个**：前端已按此读取。旧的 `previous_node_name` / `new_node_name` 已作废；名字对不上时前端不报错，提示会静默消失。
- **离线且有缓存仍返回 `Ok`**（`source = "cache"`、`changed = false`、`reason = "offline"`）：用缓存是正常场景，不是失败。无缓存且拉取失败才返回 `UPSTREAM_ERROR`。
- `default_profile_status` 不联网：`source = "cache"`、`changed = false`、`reason = null`、`added = removed = null`。

- **只读，不联网**。
- 变化判定用**内容哈希**，不依赖 `version` 字段：`version` 要人手动改，「改了文件忘了改版本号」正是 TweetPilot 那次事故的根因（`docs/issues/tweetpilot-resource-version-gap.md`）。
- `seed_id` 是常量：上游的 provider 元数据我们不再消费（`bootstrap.json` 只作为我们的上游来源，不是客户端契约）。

### 8.2 `default_profile_refresh {}` → `DefaultProfileResult`

**本命令是用户显式触发，语义恒为强制检查**：实现必须固定以 `force = true` 调用服务层，不得复用「距上次检查不足 6 小时就返回 Unchanged」的短路逻辑。设置页按钮点下去什么都没发、只回「已是最新」，是假成功。

与 AI 工具 `CatalogRefresh` 的 `force` 参数不冲突：那条走服务层、参数由模型给；命令层保持无参、语义恒为强制。

- 拉取 `https://meshnetprotocol.github.io/veyl_seed.json`，**直接拉全文自己算哈希**；先带 `If-None-Match`，304 直接结束。
- **同一时刻只允许一个请求在飞**，避免并发写坏缓存（`docs/config-execution.md` §10）。
- 成功且哈希变化 → 原子替换种子节点层：按 `source_key` upsert，删掉新文件里不存在的 seed 节点。
- **同步失败整体回滚，不推进 hash**：任何一步失败都不写新的 `content_sha256`、不部分应用节点变更；下次刷新仍会重新拉取、重试。哈希只在同步成功后才推进——否则失败一次就会把「内容已是最新」写死。
- **不打断在线连接**：缓存照换；当前连接的进程不动；下一次连接生效。若正在连接，`new_version_available = true`，由 UI 提示「下次连接生效」。
- 新版本里没有当前正在用的节点 → 缓存照换；把这些配置的 `configs.current_node_id` **设为剩余列表的第一个节点**，剩余为空才置 `null`。**当前连接保持到用户主动断开。**
  - **不得静默替换**：必须通过 `config-changed(reason = "seed_refreshed")` 让 UI 提示「原来的『香港 01』已下架，已切换到『东京 02』」；已连接时加「下次连接生效」。名字取自 `DefaultProfileResult.removed_node_name` / `replacement_node_name`。没有替代节点时提示「原来的『香港 01』已下架，这套配置现在没有节点」。
  - 为什么不是留 `null`：节点卡与节点面板靠 `current_node_id` 画「当前」标记；置 `null` 会出现「卡片显示某个节点、却没有当前标记」，用户无法确认下次连哪个。落到第一个节点是确定行为，但仍须告知用户。
- 拉取失败 / 校验不过 → 保留旧缓存，返回 `UPSTREAM_ERROR` 或 `INVALID_ARGUMENT`，`new_version_available = false`。
- 发 `default-profile-updated` 与 `node-list-changed`（`reason = "seed_refreshed"`）。

### 8.3 `import_seed_file { path }` → `SeedImportResult`

**保留，但语义收窄：不再创建配置，只并节点。**

自 `2.16.12` 起，本命令的**目标状态是退出 UI**：设置页「添加节点」的粘贴 / 订阅入口在 A 批次迁到 `node_import_text` / `node_import_url`，文件入口由 `node_import_file`（2.16.14）接管。**当前唯一 UI 调用方：窗口级拖放**；拖放**不随批 B 迁移**（§4.1.2「为什么窗口拖放不迁移」），种子分发退场后再定去向。迁移完成后更新此段。

```ts
type SeedImportResult = {
  imported: number;
  skipped: Array<{ name: string | null; reason: string }>;
  nodes: NodeSummary[];
};
```

为什么仍然需要它：

1. **离线兜底**：`docs/config-execution.md` §9 写明「首次分发时如果某个用户拉不到，通过其它渠道把种子给他」——给的就是这个格式的文件。
2. **开发与测试**：CI 与本地没有稳定外网时，用文件注入同一份种子。

规则：

- 只接受 `veyl_seed.json` 结构（`{ version, updated_at, nodes[] }`），扩展名 `.json`、≤ 1 MB、存在且可读。
- 节点以 `source = "seed"` 合并进节点池，**只增不删**：手工导入不删除种子拉取层已有的节点，避免一次误操作把用户正在用的节点删掉。
- UI 入口现状：只剩**窗口级拖放**（`App.tsx:341-375` 的 `onDragDropEvent` → `importPath` → `importSeedFile`），只接受 `.json` 种子文件，前端先按扩展名拦截。设置页的粘贴 / 订阅入口在 A 批次接 `node_import_text` / `node_import_url`，文件入口接 `node_import_file`。窗口拖放**不随批 B 迁移**：种子是 `{ version, updated_at, nodes[] }`，与逐行 `ss://` 不同格式，迁过去等于让一份可用文件被判成「没有可用的节点」。拖入非 `.json` 时提示要指向设置页，不能只说「请换一个文件」。
- 只接受 shadowsocks 出站、method 白名单；部分成功不算失败；返回值与日志**永不含 password**；不回显文件内容。

| 错误码 | `details.reason` | 场景 |
|---|---|---|
| `INVALID_ARGUMENT` | `not_json_file` | 扩展名不是 `.json` |
| `INVALID_ARGUMENT` | `file_too_large` | 超过 1 MB，`details.max_bytes` |
| `INVALID_ARGUMENT` | `file_unreadable` | 路径不存在或不可读 |
| `INVALID_ARGUMENT` | `invalid_json` | 不是合法 JSON / 结构不符（不是 seed 格式） |
| `INVALID_ARGUMENT` | `no_importable_nodes` | 解析成功但无可导入节点，`details.skipped` |
| `UNSUPPORTED` | — | method 不在白名单，`details.method` |
| `SECRET_STORE` | — | `secrets.enc` 写入失败 |

---

## 9. AI、设置与系统（语义沿用 1.2.0）

以下命令在 2.0 **不变**，只在这里保留完整语义，避免实现方回到历史版本里翻。

### 9.1 `ai_send_message { sessionId, text, hidden? }` → `{ request_id }`

发送一条用户消息，返回本轮请求 id。事件见 `events.md` §3。

**同一会话同一时刻只处理一条请求，不做排队。** 已有请求在跑时直接拒绝：

- `code = BUSY`，`details = { "reason": "request_in_flight", "active_request_id": "<在跑的那条>" }`；
- **不写 `chat_messages`、不启动请求**——落库再失败会让用户看到一条永远不回的消息，比拒绝更糟；
- 前端应在发送入口就拦住（或把这条错误按「等上一条回完再发」展示），不要当普通失败重试。

| 参数 | 规则 |
|---|---|
| `sessionId` | 不存在时**随首条消息创建**，不是错误：前端 `createSession()` 本地生成 id，换会话不需要额外 IPC。本命令不返回 `NOT_FOUND` |
| `text` | trim 后非空；为空 → `INVALID_ARGUMENT`，`details.reason = "empty_text"`。**在占槽与落库之前拒绝** |
| `hidden` | 可选，默认 `false` |

**会话创建**：`sessionId` 由前端本地生成；首次发送时 Host 随用户消息一起创建会话记录（`chat_sessions`）。因此「不存在」是正常状态，不要为此加 `create_session` 前置命令，也不要按 `NOT_FOUND` 拒绝。

`hidden` 的语义：

- `false` / 缺省：与旧行为**逐字一致**，用户消息写入 `chat_messages`。
- `true`：**系统代发**的触发消息（引导页配好 Key 后自动发起第一轮对话），**不写 `chat_messages`**，文本仍照常送给模型。
- 只影响「用户消息是否落库」：助手回复、`message-chunk` / `tool-call-*` / `ai-request-end` 等事件、assistant 消息的落库、`request_id` 的生命周期都不变。
- 不影响来源标记：`source` 仍是 `ui`，UI 不能借 `hidden` 改变权限或绕过命令入口。
- 允许其它场景使用，但调用方应能解释为什么这条用户消息不该出现在历史里。

**历史回放的约束（将来）。** 当前 `AivpnSession::messages` 在新建时为空，模型**不从 `chat_messages` 回放上下文**（`src-tauri/src/claurst_session/mod.rs:188`、`:554-585`），所以 `hidden` 不落库不影响当前对话。**若将来实现历史回放**，必须在 `chat_messages` 里为 hidden 消息保留标记（例如新增 `hidden` 列），或从 assistant 消息反推重建；否则模型会看到一串没有对应提问的 assistant 消息，上下文直接错乱。这是一条实现前置约束，不是「以后再说」的备注。

> **`attachments` 已删除（2.3.0）。** 它自 1.0 起只在本命令里声明过：Rust 形参从未接收、前端从未传、`docs/` 里没有任何需求、UI 或存储设计。属于「声明了但从未实现、也没有计划」的字段，留着会让契约与实现永久对不上。将来要做附件，按新能力重新设计，不复用这个占位。

### 9.2 `ai_cancel { requestId }` → `{ cancelled: boolean }`

取消进行中的请求。**只取消 `requestId` 对应的那一轮**：请求已结束或它不是当前请求时返回 `cancelled: false`，不报错，也不误伤别的请求。

### 9.3 `chat_history { sessionId? }` / `chat_delete { sessionId }` / `rename_session { sessionId, title }`

- `chat_history`：省略 `sessionId` 返回最近会话；只读。
- `chat_delete`：**不可恢复**，Host 不做回收站。事务内三张表一起删：

  ```sql
  BEGIN;
  DELETE FROM tool_calls    WHERE session_id = ?1;
  DELETE FROM chat_sessions WHERE id = ?1;   -- chat_messages 由外键 ON DELETE CASCADE 带走
  COMMIT;
  ```

  **为什么必须显式删 `tool_calls`**：`chat_messages.session_id` 有外键级联，但 `tool_calls.session_id` **没有外键**（只有索引）。只删会话会留下孤儿，用户以为「对话删干净了」，参数与结果还在库里。
  该会话有进行中的 AI 请求 → `PRECONDITION_FAILED`，`details.reason = "active_request"`。**取消由 UI 先做**，Host 只保证「删的时候一定是静止的」。
- `rename_session`：trim → 非空 → ≤ 80 Unicode 标量；失败 `INVALID_ARGUMENT`，`details.reason ∈ {empty_title, title_too_long}`。

### 9.4 LLM Provider（F 组）

五个命令共用同一份校验，**不允许各写一套**。

```ts
type LlmProtocol = "openai" | "anthropic";

type LlmProvider = {
  provider_id: string;
  name: string;
  protocol: LlmProtocol;
  base_url: string | null;      // null = 用该协议的官方地址
  model: string;
  has_key: boolean;             // 只表示"有/没有"，永不返回值本身
  is_active: boolean;
  is_builtin: boolean;
};
```

**校验规则（顺序固定，命中即返回）**

| # | 规则 | 失败 |
|---|---|---|
| 1 | `protocol ∈ {"openai","anthropic"}` | `INVALID_ARGUMENT`，`details.reason = "unsupported_protocol"` |
| 2 | `name` trim 后非空，≤ 60 字符 | `INVALID_ARGUMENT`，`details.reason = "invalid_name"` |
| 3 | `model` trim 后非空，≤ 200 字符 | `INVALID_ARGUMENT`，`details.reason = "invalid_model"` |
| 4 | `base_url` 为空/null，或能解析为 `http` / `https` | `INVALID_ARGUMENT`，`details.reason = "invalid_base_url"` |
| 5 | `base_url` **含 userinfo（`user:pass@host`）一律拒绝** | `INVALID_ARGUMENT`，`details.reason = "base_url_has_credentials"` |
| 6 | `http` 的 host 必须是 `localhost` / `127.0.0.1` / `::1` | `INVALID_ARGUMENT`，`details.reason = "insecure_base_url"` |
| 7 | 非本机端点必须有 Key（见下「保留原 Key」） | `PRECONDITION_FAILED`，`details.reason = "api_key_required"` |

第 5 条的理由：`https://sk-xxx@api.example.com` 会把密钥写进日志、错误信息、以及任何打印 URL 的地方。

**「本机端点」的判定**：只看解析后的 host，不看字符串。`http://127.0.0.1:11434`、`http://localhost:11434`、`http://[::1]:11434` 是本机；`http://192.168.1.10:11434` 不是。

**`base_url` 的规范化**：存储保留用户输入原样（去掉首尾空白与末尾 `/`），拼接由 Host 负责；填了以 `/v1` 结尾的地址，Host 装配时去掉，避免拼出 `/v1/v1`。

**`llm_provider_save { providerId?, name, protocol, baseUrl?, model, apiKey? }`**

| 情况 | 行为 |
|---|---|
| `providerId` 省略 | **新建**，Host 生成 `p_` id，`is_builtin = false` |
| `providerId` 指定 | 更新；不存在 → `NOT_FOUND` |
| `apiKey` 省略或空串，且已有 Key | **保留原 Key**，不覆盖 |
| `apiKey` 省略或空串，且没有 Key | 仅当 base_url 是本机端点时允许；否则 `PRECONDITION_FAILED / api_key_required` |
| `apiKey` 非空 | 写入 `secrets.enc` 的 `provider:<provider_id>`，覆盖旧值 |

- 返回值**永远不含 Key**。
- **保存不改变当前 provider**。唯一例外：当前没有任何 active provider 时，保存的第一个自动成为 active。
- 编辑当前激活的 provider，保存后仍是 active；下一次请求生效，不打断进行中的请求。

**`llm_provider_delete { providerId }`**

- 同一个操作里删两样：条目 + `secrets.enc` 的 `provider:<provider_id>`，不留孤儿密钥。
- 不能删除内置 provider → `PRECONDITION_FAILED / builtin_provider`。
- 不存在 → `NOT_FOUND`。**这里有意不做幂等**：provider 是用户点名删除的对象，报「不存在」能暴露 UI 状态不同步。
- **允许删除当前激活项**：删后 active 置空，**不自动挑下一个**（自动挑选属于静默切换）。

**`llm_provider_activate { providerId }`**：目标必须有可用 Key（本机端点除外）；成功后新会话立即使用；已经是当前 → 幂等；不存在 → `NOT_FOUND`。

**`llm_provider_test { providerId?, name?, protocol?, baseUrl?, model?, apiKey? }`**（参数平铺，没有嵌套 `draft`）

```ts
type LlmTestResult = { ok: boolean; latency_ms: number | null; error?: string };
```

| 传入 | 行为 |
|---|---|
| 只有 `providerId` | 用已保存的配置与已存的 Key 测试 |
| 给了 `protocol` / `model` / `baseUrl` / `name` 任一 | 视为**草稿**，不落库；`apiKey` 省略且 `providerId` 存在时用已存的 Key |
| `providerId` 与草稿字段都缺，或草稿缺 `protocol` / `model` | `INVALID_ARGUMENT` |

- **只有入参非法才返回 `Err`**；端点不可达、Key 错误、模型不存在、超时一律 `ok: false` + `error`。
- `error` 必须**脱敏**：精确替换该 provider 的实际 Key；任何 `sk-[A-Za-z0-9_-]{8,}` 片段替换为 `<redacted>`（替换而非删除）；同样适用于日志与 `detail`。`describe_http_error` 这类把上游响应体转成文案的函数是主要泄漏点。

### 9.5 DeepSeek（F1 / F2）

`deepseek_key_status {}` → `{ configured: boolean, masked: string | null }`；
`deepseek_save_key { key }` → `{ masked: string, verified: boolean }`（**保存成功即成功**，Key 是否有效由 `verified` 表达）；
`deepseek_clear_key {}` → `{ ok: true }`。
密钥键固定 `provider:deepseek`，与多 provider 复用同一个内置项。

### 9.6 `reply_user_question { sessionId, questionId, answer }` → `{ ok: true }`

回答 `ask-user-question`（`events.md` §4.8）。**同步返回**：回答一旦送达模型，工具就从阻塞中恢复继续跑。

| 规则 | 说明 |
|---|---|
| `answer` 取值（普通提问） | 接受**任何非空文本**，原样作为回答回给模型；空字符串 = 跳过。用户不必被选项卡住，打字说清楚就行 |
| `answer` 取值（`core_upgrade_confirm`） | 装包授权**必须逐字等于该问题 `options` 之一**（不 trim、不归一大小写），否则 → `INVALID_ARGUMENT / answer_not_in_options`；空字符串仍是跳过 |
| 默认节点同意 | 只有逐字选中规范选项「用 Veyl 提供的测试节点（仅供试用）」才授予；用户自由作答不授予，模型重问一次是预期行为 |
| 回答落库 | 送达模型后写一条 `role = "user"` 的聊天记录（`content` 为回答原文）；只是历史，不会重复喂给模型。空字符串（跳过）不写 |
| 一个 `questionId` 只能回答一次 | 第二次及以后 → `NOT_FOUND / question_not_pending` |
| 超时后 | 同上（Host 已代答空串） |
| 会话不匹配 | **同样返回 `question_not_pending`**，不区分「不存在」与「属于别的会话」——否则这个命令会变成跨会话探测问题的工具 |

```ts
type PendingQuestion = {
  question_id: string;
  session_id: string;
  request_id: string;
  question: string;
  options: string[];
  created_at: number;   // Unix 毫秒
  expires_at: number;   // Unix 毫秒 = created_at + 900_000（15 分钟）
};
```

### 9.7 `list_pending_questions { sessionId }` → `{ questions: PendingQuestion[] }`

返回该会话**当前未回答**的问题，用于窗口重载、切走再切回时重建浮层。

- 返回值统一套 `{ questions: [...] }` 外壳。
- 只返回未答且未超时的；会话不存在时返回空数组，不报错。
- 顺序不保证；UI 需要稳定顺序时按 `created_at` 自己排。

### 9.8 面向用户的表达（规范性）

Host 必须在发给模型的两处写入**同一套**表达规则（全文见 `tools.md` §2.4）：

1. **系统提示正文**（`resources/prompts/zh/first-run.md`「怎么说话」）：不叙述工具调用、不出现内部术语与 ID、失败三段式、长流程分阶段、用户主动问技术才用术语且首次出现紧跟白话解释。
2. **工具 description**：只补该工具「结果怎么说、失败改没改」，通用规则不重复。`capability_catalog` 只取第一行进清单，完整 description 作为 schema 交给模型，所以这类句子放末尾。

UI 侧不依赖模型的措辞：

- `tool-call-end.display`（`events.md` §3.4）是完成 / 失败的唯一用户文案；缺失时回落到前端映射表，不报错、不丢事件。
- 前端映射表位于 `src/components/toolDisplay.ts`（`TOOL_COPY`，设计文档里也称 `TOOL_DISPLAY`），键集合必须与 `tools.md` §3 的 44 个工具名**双向相等**；`AskUserQuestion` 虽在表中，但渲染层必须跳过它的工具行（提问由问答浮层承担）。
- **不做输出正则改写**：静默替换模型正文（例如抹掉 `cfg_` 开头的串）比漏一句更难排查；拦截放在渲染层，不改写生成内容。
- 工具 description 的表达约束放 `\n` 之后的末尾：`capability_catalog` 只取第一行进系统提示清单，第一行出现约束句会污染能力清单。
- running 状态文案来自映射表，不得拼工具名；未知工具固定「正在处理…」（`events.md` §3.5）。
- 映射表以 `docs/design/tool-display.md` 为准；「怎么说话」八条与 `SAFETY_RULES` 新增两条由契约测试防回归，删任一条即红。

> 这是表达约束，不改变 §7.10 的 AI 边界：模型能调用什么仍只由 `tools.md` §3 决定。

---

## 10. 分流与 DNS（G / I 组）

> 生成器、规则资源布局与三条模式的具体 `route.rules` / `final` 见 **`routing.md`**。本节只定义 UI → Host 的命令与返回形状。

### 10.0 共用类型

```ts
type RoutingMode = "direct" | "proxy_all" | "proxy_selected";

type CustomRule = {
  rule_id: string;                 // rul_<16 hex>
  action: "proxy" | "direct";
  match_type: "domain" | "domain_suffix" | "domain_keyword" | "ip_cidr" | "category";
  value: string;
  note: string | null;
  position: number;
  created_at: number;              // Unix 毫秒
};

type RouteState = {
  config_id: string;
  routing_mode: RoutingMode;
  applied_mode: RoutingMode | null;   // 取自 RuntimeSnapshot；未连接为 null
  targets: string[];                  // 分类 id，仅 proxy_selected
  custom_rules: CustomRule[];
  route_revision: number;
  applied_revision: number | null;    // = RuntimeSnapshot.applied_route_revision
  effective: "current_connection" | "next_connection";
  reconnect_required: boolean;
  local_direct_basis: "domain_and_ip" | "ip_only" | "none";
  detected_region: string | null;     // 实时判定的小写 cc；未知为 null
  applied_region: string | null;      // 运行配置实际使用的地区；未连接或当时未知为 null
};

type RouteSetModeData = RouteState & {
  hot_switched: boolean;
  reconnect: "not_running" | "reconnected" | "reconnect_failed" | null;
};

type Category = {
  id: string;
  name_zh: string;
  name_en: string;
  description: string;
  item_count: number;
  rule_sets: string[];
  dns_classifiable: boolean;
};

type RulesStatus = {
  active_version: string;
  manifest_sha256: string;
  geosite_tag: string | null;
  geoip_tag: string | null;
  geosite_age_days: number | null;
  geoip_age_days: number | null;
  stale: boolean;
  item_count: number;
  total_bytes: number;
  checked_at: number | null;
  bundled_version: string;
  pending_update: boolean;
};
```

### 10.1 `route_get { configId? }` → `RouteState`

- **G1** 查看当前分流方式。`configId` 省略用 active 配置。
- `applied_mode` / `applied_revision` 一律取自 `RuntimeSnapshot`，不从库里推。
- `detected_region` 与 `system_region`（§10.10）**同源**：同一个判定函数、同一次进程内的结果必须一致。
- `applied_region` 是**运行配置实际使用的地区**（`RuntimeSnapshot.route_region`）：用户中途改系统时区，配置不会重算，已连接时界面以它为准；未连接为 `null`。
- **`applied_region = null` 表示建连时判不出地区，不是「回退到实时值」的开关。** 已连接时它即使是 `null` 也以它为准，按「未知」显示，**不得**用 `detected_region` 顶上——那会把一个实时重算值说成「正在生效的地区」。
- `local_direct_basis`：已连接时按 `applied_region` 报，未连接按实时地区报；`"domain_and_ip"` = 域名级 + IP 级本地层（CN），`"ip_only"` = 只有 IP 级本地层（其它已知地区），`"none"` = 未知地区，没有本地直连层。
- 只读，不联网，不发事件。

### 10.2 `route_set_mode { configId?, mode, confirmReconnect? }` → `RouteSetModeData`

- **G2** 切换分流方式。
- `direct` ↔ `proxy_all` 且已连接 → 走 Clash API selector 热切，`hot_switched = true`、`effective = "current_connection"`。
- 涉及 `proxy_selected` 的跨家族切换、且已连接、未带 `confirmReconnect` → `PRECONDITION_FAILED`，`details.reason = "will_disconnect"`，**不产生任何变更**。
- 带 `confirmReconnect: true` → 按「停运行时 → 写库 → 启运行时」执行，`reconnect` 给出结果。**重连失败不抛错**：切换本身已成功。
- 确认文案必须包含两点：会断开一次并自动重连；**域名解析方式也会改变**（`routing.md` §6.4）。
- 未连接 → 只写库，`effective = "next_connection"`、`reconnect = "not_running"`。
- `mode = "proxy_selected"` 且 `targets` 为空 → `PRECONDITION_FAILED / route_targets_empty`。
- 同一模式 → 幂等返回，不发事件。

### 10.3 `route_targets_set { configId, categories }` → `RouteState`

- **G4** 整体替换「指定服务」的分类集合。
- 任何一个 id 不在分类目录 → `NOT_FOUND / category_unknown`，`details.unknown` 一次列全。
- `dns_classifiable = false` 的分类 → `UNSUPPORTED / category_not_dns_classifiable`。
- 不热切：`effective = "next_connection"`。

### 10.4 `rule_custom_list { configId }` → `{ rules: CustomRule[] }`

- **G4** 按 `position` 升序返回；空数组合法。

### 10.5 `rule_custom_add { configId, action, matchType, value, note? }` → `CustomRule`

- **G4** 追加到末尾（`position = max + 1`）。
- 校验 `matchType` 与 `value`：域名语法、CIDR 合法性、分类存在且 `dns_classifiable`。
- 同一 `(config_id, action, match_type, value)` → `CONFLICT / duplicate_rule`。
- 写入后 `route_revision + 1`；`effective = "next_connection"`，发 `routing-changed`。

### 10.6 `rule_custom_delete { configId, ruleId }` → `{ rule_id, deleted, already_absent }`

- **G4** 幂等：不存在 → `deleted = false`、`already_absent = true`。
- 不重排 `position`（留空不影响顺序），`route_revision + 1`，发 `routing-changed`。

### 10.7 `category_list { query?, limit? }` → `{ categories: Category[], total }`

- **I1** 分类目录，AI 与 UI 共用。
- `query` 对 id 与中英文名做不区分大小写的子串匹配；`limit` 默认 50、上限 200。
- 只读，不联网，读当前生效规则版本的 `categories.json`。

### 10.8 `rules_status {}` → `RulesStatus`

- **G3 / I2** 当前规则数据版本与新鲜度。只读，不联网。
- `stale` 只用于提示，不阻断连接；`pending_update` 表示有排队任务（见 10.9）。

### 10.9 `rules_update {}` → `{ queued: boolean, job_id: string | null }`

- **G3 / I2** 更新规则数据。
- **先尝试直连**（每次重新解析 DNS，不复用上次 IP）：
  - 直连成功 → 异步执行：`queued = false`、返回 `job_id`；进度走 `job-progress`，`kind = "rules_update"`。
  - 直连失败且已连接 → 异步执行，job 内自动改走代理重试，仍返回 `job_id`。
  - 直连失败且未连接 → 排队：`queued = true`、`job_id = null`，下次连接成功后重新解析并重试，**不返回失败**。
- 已有任务在跑 → `CONFLICT`，`details.job_id` 指向进行中的任务。
- 成功后发 `rules-changed`，`effective = "next_connect"`。

### 10.10 `system_region {}` → `{ region: string | null }`

- **仅 UI**。给新建配置与中间区的「当前所在地区」用；AI 不调用——它拿的是系统提示词里注入的那句。
- `region`：小写 ISO 3166-1 alpha-2（`"cn"` / `"jp"`）；判不出为 `null`。
- 判定离线、不测 IP、不联网，顺序：`VEYL_REGION` → 系统时区 → 系统区域 → `LANG` → 未知。
- 不依赖配置：全新安装、一套配置都没有时也能返回（这正是它不并进 `route_get` 的原因）。
- 与 `route_get.detected_region` 同源，两处结果必须一致。
- 不落库、不发事件：地区随系统变，缓存只会制造「设置改了但没生效」。

---

## 11. 已删除与已作废

| 命令 | 处置 | 理由 |
|---|---|---|
| `profile_list` | **2.0 删除** | 单节点模型不存在；由 `config_list` + `config_detail` 取代 |
| `profile_delete` | **2.0 删除** | 由 `config_delete` 取代（删除的对象从「节点」变成「配置」） |
| `onboarding_status` | **2.0 删除** | 旧首次引导整体删除（`implementation-plan.md` §1）；首启由 AI 对话 + `source_choice` 承担 |
| `onboarding_complete` | **2.0 删除** | 同上 |
| `catalog_list_nodes` | **2.0 删除** | 从未接线；新模型不浏览远端目录 |
| `profile_import_node` | **2.0 删除** | 从未接线；节点导入走 `node_import_url` / `node_create` |
| `vpn_connect` / `vpn_disconnect` | 1.1.0 已作废 | 由 `runtime_start` / `runtime_stop` 取代 |

> **只作废 invoke 命令，不作废 AI 工具。** 聊天通道里的工具（`VpnConnect` 等）继续存在，见 `tools.md`。两条通道最终落到同一份 Host 实现，差别只在「谁发起」。
>
> `tools.md` 已升到 3.4.1，工具名与本表一一对应。

---

## 12. 能力 ↔ 命令 ↔ 块 映射

这是本文与 `docs/capabilities.md`、`docs/center-panel.md` §2.5.1 对齐的**唯一表格**。任何一行对不上，实现就是错的。

### 12.1 新增与变更的命令

| 命令 | 能力 ID | 界面元素 / 块 | 说明 |
|---|---|---|---|
| `config_list` | **K1** 列出与查看配置 | 左栏配置列表 | 配置级导航；节点级是 B1 |
| `config_create` | **K2** 新建配置（数据来源：C1 / B4） | `source_choice` | 块只负责「用测试节点 / 用我自己的节点」两个选项；落库是本命令 |
| `config_detail` | **K1** 列出与查看配置 / **B1** 列出节点 | 底部节点详情 + 节点下拉 | 固定骨架元素 |
| `config_update` | **K4** 编辑配置（分流持久化侧：G1） | 设置页 / 左栏编辑 | 在线切换是 G2，批 3 |
| `config_delete` | **K5** 删除配置（破坏性，需二次确认） | 左栏项操作 | |
| `config_activate` | **K3** 切换配置 | 左栏切换 | 与 B2「切换节点」是两个层级，不可混用 |
| `node_import_url` | **B4** 导入配置文件 | 导入按钮 / `source_choice` 后置 | |
| `node_import_text` | **B4** 导入配置文件 | 手工表单「粘贴分享链接」 | 只解析粘贴文本，不联网；与 `node_import_url` 分开（2.14.0） |
| `node_import_file` | **B4** 导入配置文件 | 设置 › 添加节点（文件） | 仅 UI；与 `node_import_text` 共用解析，不联网、不涉及运行时；**不含窗口拖放**（拖放仍走 #24，2.16.14） |
| `issue_report_reveal` | —（仅 UI，2.17.0） | 会话内报告卡「在文件夹中显示」 | 只认 Host 登记过的报告目录，不接受路径 |
| `issue_report_mail` | —（仅 UI，2.17.0） | 会话内报告卡「打开发送邮件」 | 调起系统邮件客户端，预填固定收件人；**不发送** |
| `issue_report_preference` | —（仅 UI，2.17.0） | 报告入口的「保留完整域名」勾选 | 读 / 写 `issue_report_include_domains`；模型无权改 |
| `node_create` | **B4** 导入配置文件 | 手动编辑表单 | |
| `node_switch` | **B2** 切换节点 | 底部「切换到此节点」 | ⚠️ 旧映射写 `runtime_start(profile_id)`，见表后说明 |
| `node_probe` | **D6** 测试单个节点连通性 | 底部「测试连通」 | D6 由 PM 在批 0 审查时新增 |
| `proxy_params` | **A5** 代理参数 | `proxy_card` | |
| `probe_run` | **D1** 本地基础自检 / **D4** 采集结构化诊断包 | `reachability` 块 + 诊断卡 | |
| `issue_list` / `issue_get` | **J2** 查看问题列表 | 问题列表 | |
| `issue_handoff` | **J3** 把问题转交 AI | `issue_card` 的「让 AI 定位」 | |
| `issue_resolve` / `issue_ignore` | **J4** 标记已解决 / 忽略 | 问题列表操作 | |
| `runtime_start` | **A1** 建立连接 / **A3** 取消重连 | 顶部主按钮 | |
| `runtime_stop` | **A2** 断开连接 / **A3** | 顶部主按钮 | |
| `runtime_status` | **A4** 连接状态 | 顶部状态文字 | 配合 `runtime-state-changed` |
| `net_repair` | **E1** 恢复直连 / **E2** 刷新 DNS | `issue_card`（E1/E2）；设置页（仅 E1「清除残留代理」） | E2 目前没有正式界面入口，只有 AI 工具调用 |
| `network_force_reset` | **E3** 强制重置网络（破坏性） | 设置 › 遇到问题 ›「重置网络」 | 二次确认；**不进 AI 工具**，见 §7.9 |
| `open_log_dir` | **E4** 打开日志目录 | 状态区链接 | |
| `default_profile_status` / `_refresh` | **C1** / **C2** / **C3** | `update_hint`、`source_choice` |
| `route_get` | **G1** 查看当前分流方式 | 设置页 / 分流文本 | |
| `route_set_mode` | **G2** 切换分流方式 | 分流选项 | A↔B 热切；跨家族需确认后重连 |
| `route_targets_set` | **G4** 用户自定义分流（目标服务） | 设置页 / 表单 | |
| `rule_custom_list` / `_add` / `_delete` | **G4** 用户自定义分流（逐条规则） | 设置页 / 对话 | |
| `category_list` | **I1** 读取分类目录 | 表单 / AI 工具 | |
| `system_region` | —（UI 展示用，无用户能力 ID） | 新建配置的地区提示 / 中间区直连口径行 | 与 `route_get.detected_region` 同源；AI 拿提示词里的注入句 |
| `rules_status` | **G3** 更新分流规则数据 / **I2** | `update_hint`、设置页 | |
| `rules_update` | **G3** / **I2** | 设置页按钮 | 未连接时排队 |

### 12.2 固定骨架与块的完整对应

| 骨架元素 / 块 | 依赖能力 | 命令 |
|---|---|---|
| 顶部 `启动 VPN` | A1 | `runtime_start` |
| 顶部 `断开 VPN` | A2 | `runtime_stop` |
| 顶部状态文字 | A4 | `runtime_status` + 状态事件 |
| 底部节点详情 / 下拉 | B1 | `config_detail` |
| `切换到此节点` | B2 | `node_switch` |
| `测试连通` | D6 | `node_probe` |
| `empty_hint` | 无（纯文本） | — |
| `proxy_card` | A5 | `proxy_params` |
| `source_choice` | C1 / B4 | `config_create`（选「用测试节点」带 `source: "seed"`） |
| `reachability` | D1 | `probe_run` |
| `issue_card` | J1–J4 / E1–E2 | `issue_*`、`net_repair`（**E3 不在其中**：重置网络是独立命令 `network_force_reset`，见 §7.9） |
| `update_hint` | C2 / C3 | `default_profile_status` |

### 12.3 对不上的地方（需要 PM 在 `capabilities.md` 增补或改口径）

| # | 缺口 | 建议 |
|---|---|---|
| 1 | ~~没有「列出配置」「切换配置」的能力 ID~~ | **已解决**：PM 新增 K 组「配置管理」K1–K5，已并入 §12.1 |
| 2 | **B2 的实现方式变了**。旧表写 `runtime_start(profile_id)`，2.0 拆出 `node_switch`。 | 把 B2 的「实现状态」改成 `node_switch`。拆分理由：未连接时「切换到此节点」只改选择、**不应启动 VPN**；用 `runtime_start` 会把「看」与「连」混成一个动作 |
| 3 | **J1 没有命令**。 | 保持现状：J1 是内部行为。若将来要让 UI 手动「重新检测」并登记，再加 `issue_collect`，不要暴露 `issue_create` |
| 4 | **布局写入没有能力 ID。** | 布局属于编排协议（`center-panel.md` §3），不是用户可点能力，不需要能力 ID。写入路径是 AI 工具（批 4），UI 只读 |
| 5 | **`config_update` 的「改分流」在 G 组没有对应 ID。** | G1 是「查看」、G2 是「切换（在线）」。持久化修改分流策略建议归入 G2 的配置侧，或新增 G5。本批先按 G1 的持久化侧登记 |
| 6 | **D2 完整诊断（14 项）没有独立命令。** | 仍由 AI 工具 `DiagRun` 承担；`probe_run` 只覆盖连接后的四项。若 UI 要独立按钮，批 6 再补 `diag_run` |
| 7 | 「测试连通」的能力 | **已解决**：PM 新增 **D6**，`node_probe` 已标 D6 |
| 8 | **B3「删除节点配置」在新模型里没有对应命令** | 删除的对象从「节点」变成了「配置」→ **K5**。本期不提供「从节点池删除单个节点」的能力；若需要，建议新增 B5「删除节点」，不要复用 K5 |

---

## 13. 与 AI 工具的对应关系

| 命令 | AI 工具 | 是否共用实现 |
|---|---|---|
| `runtime_start` | `RuntimeStart` | **必须** |
| `runtime_stop` | `RuntimeStop` | **必须** |
| `runtime_status` | `RuntimeStatus` | **必须** |
| `config_list` | `ConfigList`（2.0 新增） | **必须** |
| `config_detail` | `ConfigDetail`（2.0 新增） | **必须** |
| `config_create` | `ConfigCreate`（2.0 新增） | **必须** |
| `config_update` | `ConfigUpdate`（2.0 新增） | **必须** |
| `node_switch` | `NodeSwitch`（2.0 新增） | **必须** |
| `node_probe` | `NodeProbe`（2.0 新增） | **必须** |
| `node_probe_all` / `node_probe_cancel` / `node_probe_snapshot` | **无**（UI 专用，见 §4.6–§4.8） | — |
| `probe_run` | `ProbeRun`（2.0 新增） | **必须** |
| `proxy_params` | `ProxyParams`（2.0 新增） | **必须** |
| `node_import_url` | `NodeImportUrl`（2.0 新增，取代 `ProfileImport`） | **必须** |
| `node_import_text` | `NodeImportText`（3.8.0 新增，与 UI 命令共用实现） | **必须共用** |
| `node_create` | `NodeCreate`（2.0 新增） | **必须** |
| `config_delete` | `ConfigDelete`（2.0 改名） | **必须** |
| `issue_list` | `IssueList`（2.0 新增） | **必须** |
| `issue_get` | `IssueGet`（2.0 新增） | **必须** |
| `issue_handoff` / `issue_resolve` / `issue_ignore` | `IssueHandoff` / `IssueResolve` / `IssueIgnore`（2.0 新增） | **必须** |
| `route_get` | `RouteGet`（2.1 新增） | **必须** |
| `route_set_mode` | `RouteSetMode`（2.1 新增） | **必须** |
| `route_targets_set` | `RouteTargetsSet`（2.1 新增） | **必须** |
| `rule_custom_list` / `_add` / `_delete` | `RuleCustomList` / `RuleCustomAdd` / `RuleCustomDelete`（2.1 新增） | **必须** |
| `category_list` | `CategoryList`（2.1 新增） | **必须** |
| `system_region` | **无**（UI 专用，见 §10.10；AI 走系统提示词注入） | — |
| `rules_status` | `RulesStatus`（2.1 新增） | **必须** |
| `rules_update` | `RulesUpdate`（2.1 新增） | **必须** |
| `net_repair` | `NetRepair` | **必须** |
| `core_info` / `core_check_updates` / `core_cancel_upgrade` / `core_rollback` | **无**（UI 专用，见 §7.10） | — |
| `core_upgrade` | `CoreUpgrade`（**唯一有确认点的工具**，见 `tools.md` §4.45） | **必须共用**，且必须用户逐字确认 |
| `tun_helper_info` / `tun_helper_restart` | **无**（UI 专用，见 §7.8.1–§7.8.2） | — |
| `proxy_port_get` / `proxy_port_set` | **无**（UI 专用，见 §7.11；端口是用户自己的设置） | — |

> **没有 AI 工具的 UI 专用命令**：`core_info` / `core_check_updates` / `core_cancel_upgrade` / `core_rollback`、`tun_helper_info` / `tun_helper_restart`、`node_probe_all` / `node_probe_cancel` / `node_probe_snapshot`、`proxy_port_get` / `proxy_port_set`。`core_upgrade` 是唯一例外，只能经 `CoreUpgrade` 工具且必须确认。`core_list_versions` 是唯一保留的只读工具（查已安装/可安装版本），它不下载、不安装，也看不到用户没点过「检查更新」的远端清单。

「共用实现」的含义：命令层只做参数搬运，业务在 `VpnToolServices`。禁止在命令层写一套、在工具层再写一套。

`tools.md` 已升到 3.7.0，上表的工具名与它一一对应（§0.2）。

---

## 14. 待 PM / 产品确认

| # | 议题 | 我的建议 | 状态 |
|---|---|---|---|
| 1 | `node_import_url` 是否只接受 `https` | **只接受 https**。订阅链接含节点密码，明文 http 等于把凭据交给链路上的所有人。代价是少数只提供 http 的机场用不了 | **建议采纳** |
| 2 | 删除 active 配置是否允许 | **允许**（未连接时），删后回到空态。与「不设不可删除特例」一致；只拦「正在连接」 | **建议采纳** |
| 3 | `config_create` 自动激活的条件 | 未连接时自动激活；已连接时不自动切 | **建议采纳** |
| 4 | `config_activate` 的确认参数 | `confirmDisconnect: true`，每次都要重新确认，不记忆 | **建议采纳** |
| 5 | `node_switch` 是否新增（而不是复用 `runtime_start`） | **新增**。理由见 §12.3 缺口 2 | **已拍板**（2026-11-03） |
| 6 | 配置级能力 ID | **已拍板**：新增 K 组 K1–K5，见 §12.1 | **已解决** |
| 7 | `seed_id` 常量命名 | `"veyl_seed"` | 待确认 |
| 8 | `import_seed_file` 保留（语义收窄为「只并节点」） | **保留**，理由见 §8.3 | **建议采纳** |
| 9 | 删除配置的二次确认由谁做 | **UI**。`config_delete` 命中「正在连接」时拒绝；其余情况 Host 不再拦，确认框是界面职责（K5 标了破坏性） | 待确认 |

---

## 15. 破坏性变更清单（1.2.0 → 2.3.0）

### 15.1 删除

| 对象 | 类型 | 影响 |
|---|---|---|
| `profile_list` | 命令 | 前端左栏与对话侧全部改 `config_list` / `config_detail` |
| `profile_delete` | 命令 | 改 `config_delete`；参数 `profileId` → `configId` |
| `onboarding_status` / `onboarding_complete` | 命令 | 删除引导页后无调用方 |
| `catalog_list_nodes` / `profile_import_node` | 命令（从未接线） | 无运行时影响，仅文档清理 |
| `profiles` 表 | 数据库 | 整个库重建，见 `data-model.md` §6 |
| `settings.onboarding_completed` | 数据 | 不迁移 |

### 15.2 改名 / 改形状

| 对象 | 旧 | 新 | 兼容性 |
|---|---|---|---|
| `runtime_start` 参数 | `profileId` | `configId`（2.0 曾加 `nodeId`，2.2 已去掉） | **不兼容**，参数名变了 Tauri 侧会直接拿不到 |
| `RuntimeSnapshot` 字段 | `profile_id` / `profile_name` | `config_id` / `config_name`，新增 `node_id` / `node_name` | **不兼容**，`runtime.md` 2.0.0 已同步 |
| `RuntimeSnapshot.mode` | 只有 `"system_proxy"` | 增加 `"tun"` | 新增取值（旧值不变） |
| `DefaultProfileResult.package_id` | 上游包 id | `seed_id: "veyl_seed"` | **不兼容** |
| `DefaultProfileResult.applied_at` | ISO 8601 字符串 | Unix 毫秒 | **不兼容** |
| `import_seed_file` 返回 | `profiles[]` | `nodes[]`，且不再创建配置 | **不兼容** |
| `import_seed_file` 语义 | 创建 profile | 只并节点池 | **不兼容** |
| `runtime_start` 回退链 | active → 默认配置包 → 报错 | active → 报错（`no_config`） | 行为变更：全新安装不再能「直接连」 |

### 15.3 新增

17 个命令：

- 配置 6 条：`config_list` / `config_create` / `config_update` / `config_delete` / `config_activate` / `config_detail`
- 节点 4 条：`node_import_url` / `node_create` / `node_switch` / `node_probe`
- 代理与探测 2 条：`proxy_params` / `probe_run`
- 问题 5 条：`issue_list` / `issue_get` / `issue_handoff` / `issue_resolve` / `issue_ignore`

### 15.4 数据结构

- 数据库文件**整体重建**，`profiles` / `default_profile` 表删除，新增 `configs` / `nodes` / `config_nodes` / `layout` / `issues` / `seed_cache`（2.1 再加 `config_rules` / `rules_state`）。
- 旧库存在时：启动检测 schema 代际不一致 → **删除数据库文件并重建**（对话历史一并丢失）。产品还没有用户，这是刻意选择，不是缺陷。

### 15.5 连带的升级（已完成）

**契约版本矩阵**

| 文件 | 版本 | 状态 |
|---|---|---|
| `contracts/commands.md` | **2.17.0** | 批 0 + 批 3 + `ai_send_message.hidden` + 测试节点口径 + 流量口径 + 节点延迟字段 + 助手设置/卸载两条命令 + 强制重置网络 + 运行时核心版本管理（`core_*`，仅 UI）+ helper 状态/重启与退出流程 + 面向用户的表达 + 批量测速三命令（含节点子集）+ 测速阶段/方式与种子刷新字段 + `config_detail.layout_revision` + 本地代理端口两条命令与 `port_fallback` + 同会话单请求与按 requestId 取消 + 粘贴文本导入 + 系统地区命令 + 提问自由文本回答与回答落库 + TUN `stack`/`mtu`/`dns_mode` 与系统 DNS 接管 + `RuntimeSnapshot.system_dns` + 设置 IA 文档同步（`import_seed_file` / `flush_dns` 的 UI 使用标注）+ 节点文件导入命令 + 问题报告两条动作命令 + `tun-backend.md` 1.6.0 / 1.7.0 矩阵同步 + `runtime.md` 2.7.0 矩阵同步 + `tools.md` 3.9.0 / `events.md` 2.11.0 矩阵同步 |
| `contracts/events.md` | **2.11.0** | 批 0 + 批 3 + 流量 / 连接数 / 延迟进健康事件 + `node_latency_ms` + 核心升级进度/完成事件 + 确认卡 `kind`/`details` + 任务 `origin` + `tool-call-end.display` + 批量测速两事件 + 测速阶段/方式/降级 + 非法布局整份丢弃 + `display.actions`（问题报告两个动作） |
| `contracts/runtime.md` | **2.7.0** | 批 0 + `applied_route_revision` + 流量口径 + `node_latency_ms` + 本地代理端口候选链与 `RUNTIME_PORT_UNAVAILABLE` 落地 + `route_region` + `system_dns` + `data_plane` 连续两次失败才降级与 TUN 必须探测 |
| `contracts/tools.md` | **3.9.0** | 批 0 + 批 3 工具 + 批 3 修订 + 测试节点口径 + `VpnConnectData` 对齐快照 + 移除 `CoreInstall` + `CoreUpgrade`（AI 代劳升级）+ 面向用户的表达 + `NodeProbe` 单测边界 + `ConfigCreate`/`ConfigUpdate` 移除 `listen_port` + `NodeCreate` 错误原因与实际对齐 + `NodeImportText` + `IssueReport` 问题报告 |
| `data-model.md` | **4** | 批 0 + 批 3 表 + 种子排除表 + `settings.proxy_port` |
| `contracts/routing.md` | **1.4.0** | 批 3 设计依据 + `dns.strategy` 两个平台统一 `ipv4_only` + 地区判定统一与未知地区不回落 |
| `contracts/tun-backend.md` | **1.7.0** | TUN 特权后端（`TunBackend` / 错误码分层 / 超时 / 残余风险）+ helper 构建字段与 `restart` 协商 + TUN 显式 `stack` / `mtu` / `dns_mode` + 连接期系统 DNS（fail-open、`dns_hijack` / `system_dns`、指向公网 `223.5.5.5`、双向复核、还原写回可用值、整组恰好才清扫、命令时限）+ `start` 冷启动 90 s 与超时后核对 + 还原后用系统解析验证并在不可用时退公网兜底 |
| `contracts/catalog.md` | 1.x（与服务端协商） | 不动 |

### 15.6 2.1.0 新增（非破坏性）

- 9 条分流命令（§10）、2 个事件、2 列与 2 张表、1 个运行时快照字段。
- `config_create` / `config_update` 新增可选 `targets`；`routing_mode = "proxy_selected"` 时必填。
- 参数 `routeMode` 统一更名为 `routingMode`（与数据库列、AI 工具 schema 同名）。

---

## 16. 变更记录

### 2.17.0（2026-11-12，问题报告：开文件夹与开邮件）

| # | 变更 | 类型 | 决议来源 |
|---|---|---|---|
| 1 | 本文件版本升到 `2.17.0`；新增 #70 `issue_report_reveal { reportId }`、#71 `issue_report_mail { reportId }`（均仅 UI） | 新增命令 | 用户要能把自己发现的问题与关键日志整理后发给产品方；材料由工具 `IssueReport` 生成（`tools.md` 3.9.0） |
| 2 | 两条命令只接受 Host 登记的 `report_id`，**不接受路径**；`issue_report_mail` 只调起系统邮件客户端并预填，**不发送** | 安全约束 | 不内置凭据、不做后台上报；发送是用户动作 |
| 3 | 收件人为常量 `ribencong@gmail.com`，不可由 UI 覆盖、不设设置项 | 约束 | 改址入口等于把「发给谁」交给调用方，容易被诱导误投 |
| 4 | 正文 ≤ 6000 字符，裁剪顺序与「永不删」清单见 `docs/design/issue-report.md` §9.1；`***` 是唯一打码占位符，图例行不随裁剪删除；无邮件客户端时返回 `method = "copy_only"`，并**把同一根正文放进 `body`** 供界面复制（`opened: true` 时 `body` 为 `null`） | 边界 | 各客户端对长 `mailto:` 处理不一致，必须先定上限；缺 `body` 时「复制正文」无从实现 |
| 5 | §15.5 矩阵同步 `tools.md` 3.9.0、`events.md` 2.11.0 | 元数据 | 同批 |
| 6 | 新增 #72 `issue_report_preference { includeDomains? }`：省略即读取，写入 `issue_report_include_domains`。这是用户放宽脱敏的**唯一**写入路径，`IssueReport.include_domains` 只能收窄 | 新增命令 | 脱敏开关必须由用户掌握；模型传参不得放宽披露 |
| 7 | `report_dir` 统一返回 `~/Desktop/Veyl 问题报告/<目录名>`：**不返回绝对路径、不含用户名**；命令响应、工具返回、界面、邮件正文同一口径 | 语义澄清 | 绝对路径会把 `/Users/<name>` 带进界面与模型上下文；打开目录只靠 `report_id` |

### 2.16.16（2026-11-12，矩阵同步 tun-backend.md 1.7.0）

| # | 变更 | 类型 | 触发 |
|---|---|---|---|
| 1 | 本文件版本升到 `2.16.16`；§15.5 矩阵同步 `tun-backend.md` 1.7.0（还原后用系统解析验证、不可用时退公网兜底） | 元数据 | 真机停止后断网，所有者是 `tun-backend.md` §5.2.3 |

### 2.16.15（2026-11-12，矩阵同步 runtime.md 2.7.0）

| # | 变更 | 类型 | 触发 |
|---|---|---|---|
| 1 | 本文件版本升到 `2.16.15`；§7.3 的 `RuntimeSnapshot.contract_version` 与 §15.5 矩阵同步 `runtime.md` 2.7.0 | 元数据 | `data_plane` 判定收紧（连续两次失败才 `false`）与 TUN 必须探测，所有者是 `runtime.md` §2.3.1 / §4.3 |

### 2.16.14（2026-11-11，节点文件导入契约）

| # | 变更 | 类型 | 决议来源 |
|---|---|---|---|
| 1 | 本文件版本升到 `2.16.14`；新增 #69 `node_import_file { path, configId? } → NodeImportResult`（仅 UI） | 新增命令 | PM 2026-11-11；`settings-ia.md` 批 B |
| 2 | 明确与 `node_import_text` 共用解析、`source = "manual"`、复用 `manual_create` 事件；不涉及 runtime / events / tools / data-model | 约定 | 同上 |
| 3 | 安全边界：仅 UI 注册、绝对路径、1 MiB 上限、不返回路径与内容；不支持 Clash YAML | 安全 | 同上 |
| 4 | **同日修订**：窗口级拖放**不迁移**到本命令，继续调 #24 `import_seed_file`（种子 `.json` 与逐行 `ss://` 是两种格式，迁过去会让可用文件被判成「没有可用节点」）。`path` 只来自设置页对话框；不做内容分派。版本位不变 | 边界澄清 | PM 2026-11-11 提问；本文件 §4.1.2、§8.3、#24 |

### 2.16.13（2026-11-11，矩阵同步）

| # | 变更 | 类型 | 决议来源 |
|---|---|---|---|
| 1 | 本文件版本升到 `2.16.13`；§15.5 矩阵同步 `tun-backend.md` 1.6.0（macOS `start` 期限 30→90 s、超时后先核对 `status`） | 元数据 | 修复在 `tun-backend.md` §1.3 |

### 2.16.12（2026-11-11，设置 IA 文档同步）

| # | 变更 | 类型 | 决议来源 |
|---|---|---|---|
| 1 | 本文件版本升到 `2.16.12`；#24 `import_seed_file` 标注**目标状态：UI 不再使用**——设置页粘贴 / 订阅入口迁到 `node_import_text` / `node_import_url`，文件入口与窗口拖放待 `node_import_file`。当前两者仍调用本命令，迁移完成后更新 | 标注 | PM 2026-11-11；`settings-ia.md` P1 |
| 2 | §7.4 `net_repair` 的「UI 是否使用」改为实际状态：UI 只调 `restore_direct`；`flush_dns` 只有 AI 工具能调。§12.1 同步 | 更正 | PM 2026-11-11：该标注与真实行为不符，测试文档已按真实行为写 |
| 3 | §12.1 `network_force_reset` 的入口从「设置 › 高级 › 诊断」改为「设置 › 遇到问题 › 重置网络」 | 更正 | 设置分区名与重置入口的现状 |
| 4 | 接口未变：无新增 / 删除命令，无字段形状变化，无事件变化 | 元数据 | — |

### 2.16.11（2026-11-11，矩阵同步）

| # | 变更 | 类型 | 决议来源 |
|---|---|---|---|
| 1 | 本文件版本升到 `2.16.11`；§15.5 矩阵同步 `routing.md` 1.4.0（TUN 的 `dns.strategy` 两个平台统一 `ipv4_only`） | 元数据 | 修复在 `routing.md` §6.3 |

### 2.16.10（2026-11-11，矩阵同步）

| # | 变更 | 类型 | 决议来源 |
|---|---|---|---|
| 1 | 本文件版本升到 `2.16.10`；§15.5 矩阵同步 `tun-backend.md` 1.5.1（救援不复制自身地址、复核双向、退出预算真实生效） | 元数据 | 修复在 `tun-backend.md` §5.2.2/§5.2.3 |

### 2.16.9（2026-11-11，矩阵同步）

| # | 变更 | 类型 | 决议来源 |
|---|---|---|---|
| 1 | 本文件版本升到 `2.16.9`；§15.5 矩阵同步 `tun-backend.md` 1.5.0（连接期系统 DNS 由 TUN 对端改指公网 `223.5.5.5`；无快照清扫不碰该公网地址） | 元数据 | 修复在 `tun-backend.md` §5.2.2/§5.2.3 |

### 2.16.8（2026-11-11，矩阵同步）

| # | 变更 | 类型 | 决议来源 |
|---|---|---|---|
| 1 | 本文件版本升到 `2.16.8`；§15.5 矩阵同步 `tun-backend.md` 1.4.2（清扫只认整组相等、RemovePeer 保留搜索域、flush 命令时限） | 元数据 | 修复在 `tun-backend.md` §5.2.3 |

### 2.16.7（2026-11-11，矩阵同步）

| # | 变更 | 类型 | 决议来源 |
|---|---|---|---|
| 1 | 本文件版本升到 `2.16.7`；§15.5 矩阵同步 `tun-backend.md` 1.4.1（空键救援、部分命中、写后回读、多服务兜底、退出时限） | 元数据 | 修复在 `tun-backend.md` §5.2.3 |

### 2.16.6（2026-11-11，矩阵同步）

| # | 变更 | 类型 | 决议来源 |
|---|---|---|---|
| 1 | 本文件版本升到 `2.16.6`；§15.5 矩阵同步 `tun-backend.md` 1.4.0（还原改为写回可用地址、校验改看服务级 DNS 键） | 元数据 | 修复在 `tun-backend.md` §5.2.2/§5.2.3 |

### 2.16.5（2026-11-09，矩阵同步）

| # | 变更 | 类型 | 决议来源 |
|---|---|---|---|
| 1 | 本文件版本升到 `2.16.5`；§15.5 矩阵同步 `tun-backend.md` 1.3.1（连接期 5 秒复核与还原判定） | 元数据 | 修复在 `tun-backend.md` §5.2.3 |

### 2.16.4（2026-11-09，§7.3 同步 RuntimeSnapshot 2.6.0）

| # | 变更 | 类型 | 决议来源 |
|---|---|---|---|
| 1 | 本文件版本升到 `2.16.4`；§7.3 的 `RuntimeSnapshot` 同步 `runtime.md` 2.6.0 的 `system_dns: "tunnel" \| "unchanged" \| null` 与 `contract_version` 字面量；§15.5 矩阵同步 `runtime.md` 2.6.0 | 元数据 | `RuntimeSnapshot` 的所有者是 `runtime.md` §2.5，本文件只镜像 |

### 2.16.3（2026-11-09，矩阵同步）

| # | 变更 | 类型 | 决议来源 |
|---|---|---|---|
| 1 | 本文件版本升到 `2.16.3`；§15.5 矩阵同步 `tun-backend.md` 1.3.0（DNS 接管 fail-open、`dns_hijack` / `system_dns`） | 元数据 | 修复在 `tun-backend.md` |

### 2.16.2（2026-11-09，矩阵同步）

| # | 变更 | 类型 | 决议来源 |
|---|---|---|---|
| 1 | 本文件版本升到 `2.16.2`；§15.5 矩阵同步 `tun-backend.md` 1.2.0（`dns_mode: "hijack"` + 连接期系统 DNS） | 元数据 | 修复在 `tun-backend.md` |

### 2.16.1（2026-11-09，矩阵同步）

| # | 变更 | 类型 | 决议来源 |
|---|---|---|---|
| 1 | 本文件版本升到 `2.16.1`；§15.5 矩阵同步 `tun-backend.md` 1.1.0（TUN 显式 `stack: "gvisor"` / `mtu: 9000`） | 元数据 | TUN 能连不能通的修复在 `tun-backend.md` |

### 2.16.0（2026-11-07，提问接受自由文本）

| # | 变更 | 类型 | 决议来源 |
|---|---|---|---|
| 1 | 本文件版本升到 `2.16.0`；`reply_user_question` 的 `answer` 普通提问接受任何非空文本（自由作答原样回给模型），空串仍是跳过 | 语义变更 | 提问卡片一开就是整轮阻塞，只许点选项等于不让用户说话；用户想补充说明时只能干等 |
| 2 | `core_upgrade_confirm` 维持严格：`answer` 必须逐字等于 `options` 之一，否则 `INVALID_ARGUMENT / answer_not_in_options` | 约束 | 装包授权不能靠模型引导出来的自由文本确认 |
| 3 | 回答送达模型后写一条 `role = "user"` 聊天记录（跳过不写）；只作历史，不重复进上下文 | 行为新增 | 原来答案只存在内存 `tool_calls` 里，重启后只剩问题没有答案 |
| 4 | §15.5 矩阵同步本文件 2.16.0 | 元数据 | — |

### 2.15.0（2026-11-07，当前所在地区）

| # | 变更 | 类型 | 决议来源 |
|---|---|---|---|
| 1 | 本文件版本升到 `2.15.0`；新增 `system_region {}` → `{ region: string \| null }`（仅 UI） | 命令新增 | 新建配置要在没有配置时也知道用户所在地区；`route_get` 需要一套配置，盖不住全新安装 |
| 2 | `route_get.detected_region` 明确与 `system_region` 同源；未知地区不再回落 `cn`，改为无本地直连层 + 国际 DNS | 语义变更 | 给非中国用户套中国规则会让解析异常；宁可少优化，不要错优化 |
| 3 | §15.5 矩阵同步本文件 2.15.0 | 元数据 | — |
| 4 | §4.2 更正为实际行为：不再承诺 `invalid_name` / `invalid_server` / `invalid_port` / `invalid_password`，Host 统一 `invalid_argument`（method 白名单除外）；写明 `port` 是 `u16`，越界在反序列化阶段失败、返回不了结构化错误 | 更正 | 契约与实现不一致，且这些细分原因前端用不上；`tools.md` 同步 3.7.1 |
| 5 | `RouteState` 新增 `applied_region`（运行配置实际使用的地区）；`local_direct_basis` 增加 `"none"`（未知地区） | 字段/枚举新增 | 用户中途改时区时，界面不能把实时地区当成正在生效的地区；未知地区报 `ip_only` 与事实不符 |
| 6 | `RuntimeSnapshot.route_region` 同步进 `runtime.md` 2.5.0 | 元数据 | — |
| 7 | `node_import_text` 增加 AI 通道：`NodeImportText` 工具（`tools.md` 3.8.0）与本命令共用实现；命令本身仍是 UI 专用 | 工具新增 | 用户从「AI 协助」贴链接时不能被踢回手工表单 |

### 2.14.0（2026-11-07，粘贴文本导入节点）

| # | 变更 | 类型 | 决议来源 |
|---|---|---|---|
| 1 | 本文件版本升到 `2.14.0`；新增 `node_import_text { text, configId? }`（仅 UI），返回与 `NodeImportResult` 同形 | 命令新增 | 新建配置的手工流程要能接收用户粘贴的 `ss://`，而 `node_import_url` 的 SSRF 限制只适用于「我们替用户去拉」 |
| 2 | 逐条解析：一条失败不影响其余；整段都不可用时 `INVALID_ARGUMENT / not_node_text`；重复节点计 `skipped.duplicate`，不报错 | 语义 | 一次粘贴多行是常态，整批作废会让用户以为全部失败 |
| 3 | 落库 `source = "manual"`，事件 `node-list-changed.reason = "manual_create"`（沿用既有枚举，`events.md` 不变） | 实现约束 | 节点由用户提供，不是订阅来源 |
| 4 | §15.5 矩阵同步本文件 2.14.0 | 元数据 | — |

### 2.13.0（2026-11-07，同会话单请求）

| # | 变更 | 类型 | 决议来源 |
|---|---|---|---|
| 1 | 本文件版本升到 `2.13.0`；`ai_send_message` 在同一会话已有请求时返回 `BUSY / request_in_flight`（`details.active_request_id`），**不落库、不排队** | 语义变更 | 并发发送会让一条消息落库却没有回复，比拒绝更糟 |
| 2 | `ai_cancel` 只取消 `requestId` 匹配的那一轮；不匹配返回 `cancelled: false`，不误伤其它请求 | 语义变更 | 旧实现共享一个取消令牌，第二轮会顶掉第一轮 |
| 3 | §9.1 更正：`sessionId` 不存在时**随首条消息创建**，删掉「返回 `NOT_FOUND`」的旧写法（与前端本地生成 id、后端 `ensure_session` 的实现冲突）；`empty_text` 明确在**占槽与落库之前**拒绝 | 更正 | 强判 `NOT_FOUND` 会拒掉每个新会话的第一条消息 |
| 4 | §15.5 矩阵同步本文件 2.13.0 | 元数据 | — |

### 2.12.0（2026-11-06，本地代理端口设置）

| # | 变更 | 类型 | 决议来源 |
|---|---|---|---|
| 1 | 本文件版本升到 `2.12.0`；新增 `proxy_port_get` / `proxy_port_set`（仅 UI，AI 不可调用） | 命令新增 | 端口每次随机，用户填过的地址重连就失效 |
| 2 | `RuntimeSnapshot` 增 `port_fallback: { requested, actual, reason } \| null`；只在该端口没用上时非 null，`reason` 区分 `occupied` / `unavailable` | 字段扩展 | 降级时要说清「设置的是哪个、为什么没用上」 |
| 3 | §4.5 `proxy_params.port_source`：`configured` 改为全局设置值；`pending` 废弃 | 语义变更 | 端口只有一个来源，未连接时也有确定值 |
| 4 | `config_create` / `config_update` 移除 `listenPort` 入参；`ConfigDetail.listen_port` 保留回显并标注废弃，列不删 | 参数删除 | AI 还能写配置端口时，设置里的值会静默不生效 |
| 5 | §7.11 写明候选链、预检查、最多 3 个候选、`RUNTIME_PORT_UNAVAILABLE.details.tried_ports`、TUN 不使用该端口、探针避开该端口 | 说明 | — |
| 6 | §15.5 矩阵同步：本文件 2.12.0、`runtime.md` 2.4.0、`tools.md` 3.7.0、`data-model.md` 4 | 元数据 | — |
| 7 | §7.11 `ProxyPortSetData` 改为 `{ port, availability: "free" \| "occupied" \| "unavailable" }`，三个值写死；`occupied` 与 `port_fallback` 两个字段删除 | 字段调整 | 两个字段说同一件事，保留会漂；三态直接映射探测结果 |

### 2.11.0（2026-11-06，配置详情带布局版本）

| # | 变更 | 类型 | 决议来源 |
|---|---|---|---|
| 1 | 本文件版本升到 `2.11.0`；`ConfigDetail` 增 `layout_revision: number \| null`，与 `layout` 同源（`layout` 为 null 时它也恒为 null） | 字段扩展 | 同配置内迟到的 `layout-updated` 无法判断先后，中间区会闪回上一版 |
| 2 | §3.6 写明 `layout_revision` 的用途：UI 收到 `revision <= layout_revision` 的事件直接丢弃 | 说明 | — |
| 3 | 与 `events.md` 2.10.0 的「非法布局整份丢弃」配套；布局校验策略变化不影响本文件其它命令 | 关联 | — |
| 4 | §15.5 矩阵同步本文件 2.11.0、`events.md` 2.10.0 | 元数据 | — |

### 2.10.0（2026-11-06，测速支持节点子集）

| # | 变更 | 类型 | 决议来源 |
|---|---|---|---|
| 1 | 本文件版本升到 `2.10.0`；`node_probe_all` 入参增可选 `nodeIds`，返回增 `ignored_node_ids` | 字段扩展 | 搜索过滤后点「测这 N 个」实际测了全部节点 |
| 2 | `nodeIds` 省略测全部；提供时只测子集，非本配置的 id 忽略并记入 `ignored_node_ids`；空数组 → `PRECONDITION_FAILED / no_nodes`；`total` 为实际节点数 | 语义 | 一次搜索有脏 id 不应让整批失败 |
| 3 | 前端「测这 N 个」文案依赖该参数；后端实现前按「全部测速」展示 | 说明 | 避免文案与实际行为不符 |
| 4 | **响应必须带 `ignored_node_ids`，即使为空数组**；漏掉会让「实际测的比按钮少」没有解释 | 约束 | 前端提示依赖该字段 |
| 5 | §8.1 更正：剩余列表为空时 `removed_node_name` 仍返回被下架节点名，只有 `replacement_node_name` 为 null | 更正 | 界面要能说「原来的 X 已下架，现在没有可用节点」 |
| 6 | §8.2 写明种子同步失败整体回滚、**不推进 hash**，下次仍会重试 | 约束 | 失败一次不该把「内容已是最新」写死 |
| 7 | `reason` 增 `local_write`：内容拉到并解析成功、但写入本机失败；与 `invalid_content`（我们的内容有问题）必须分开，不得合并 | 字段扩展 | 用户环境问题与内容问题要能区分 |
| 8 | §15.5 矩阵同步本文件 2.10.0、`events.md` 2.9.0 | 元数据 | — |

### 2.9.0（2026-11-06，未连接时的真实延迟、种子刷新字段与节点回落）

| # | 变更 | 类型 | 决议来源 |
|---|---|---|---|
| 1 | 本文件版本升到 `2.9.0` | 元数据 | 三处设计增量同步 |
| 2 | `NodeProbeSnapshotData.run` 增 `phase: "preparing" \| "probing"` 与 `method: "tcp" \| "clash"`；术语固定 `clash` = 可用、`tcp` = 可达 | 字段扩展 | 未连接时临时起运行时测真实延迟，重开面板要能恢复准备态与方式 |
| 3 | `DefaultProfileResult` 增 `source` / `changed` / `reason` / `added` / `removed`；`reason` 区分 `offline` 与 `invalid_content`；离线有缓存仍返回 `Ok` | 字段扩展 | 没有这些字段分不出两种失败，也说不出「已更新 N 个节点」 |
| 4 | §8.2 新版本里当前节点消失：**落到剩余列表的第一个节点**，空列表才置 `null`；必须经 `config-changed(seed_refreshed)` 告知 UI「原来的 X 已下架，已切换到 Y」，不得静默替换 | 语义变更 | 置 null 会让节点卡有节点却没有当前标记 |
| 5 | §8.2 写明 `default_profile_refresh` 是用户显式触发，**命令层固定 `force = true`**，不得复用 6 小时短路；与 `CatalogRefresh` 的 `force` 参数不冲突 | 语义约束 | 按钮点下去没检查却回「已是最新」是假成功 |
| 6 | §4.6 探测方式改为：已连接本配置 → `clash_delay`；**完全未连接 → 临时起探针运行时**，失败/8 秒未就绪 → 整批降级 `tcp`；已连接别的配置 → 不起第二个运行时、整批降级 `tcp` | 语义变更 | 未连接时 TCP 只能证明端口活着，用户按「可达」挑节点会误判 |
| 7 | `DefaultProfileResult` 增 `removed_node_name` / `replacement_node_name`（均可空）；种子刷新当前节点消失时由后端填，UI 据此显示「原来的 X 已下架，已切换到 Y」；旧名 `previous_node_name` / `new_node_name` 作废 | 字段扩展 | 前端已按契约名读取，名字不一致会让提示静默消失 |
| 8 | §15.5 矩阵同步本文件 2.9.0、`events.md` 2.9.0 | 元数据 | — |

### 2.8.0（2026-11-06，批量测速）

| # | 变更 | 类型 | 决议来源 |
|---|---|---|---|
| 1 | 本文件版本升到 `2.8.0`；§2 新增 62–64 `node_probe_all` / `node_probe_cancel` / `node_probe_snapshot`，详解见 §4.6–§4.8 | 新增命令 | 节点面板需要一次测完整张表 |
| 2 | 三条命令均为 **UI 专用**：`tools.md` §3 不注册工具；§13 补行 | AI 边界 | 批量探测是界面尺度操作，不做成工具 |
| 3 | 全局同时只允许一个批次；已有批次 → `BUSY` + `details.run_id` | 约束 | 避免多批探测互相压端口/DNS |
| 4 | `node_probe_snapshot.run` 只在该配置有批次在跑时非空；**有缓存 ≠ 已测完，`results` 有内容 ≠ 已测完** | 约束 | 重开面板必须能恢复「正在测速」而不是显示成已完成 |
| 5 | 批次不跨进程、不进 Job、不发 `*-changed`；退出即结束。并发 6、单节点 3 秒超时、不重试、单点失败不中断 | 约束 | 延迟是快照，不是需要持久化的任务 |
| 6 | §15.5 矩阵同步本文件 2.8.0、`events.md` 2.8.0、`tools.md` 3.6.1 | 元数据 | — |

### 2.7.0（2026-11-06，面向用户的表达）

| # | 变更 | 类型 | 决议来源 |
|---|---|---|---|
| 1 | 本文件版本升到 `2.7.0`；新增 §9.8「面向用户的表达」：提示词规则同时落在系统提示正文与工具 description，全文见 `tools.md` §2.4 | 新增 | 产品负责人 2026-11-06：工具调用不能把模型措辞直接展示给用户 |
| 2 | UI 侧完成文案改为只认 `tool-call-end.display`（`events.md` §3.4），缺失时回落前端映射表 | 约束 | 给模型的 `result` 不是给用户的文案 |
| 3 | 前端映射表 `src/components/toolDisplay.ts`（`TOOL_COPY`）的键集合必须与 `tools.md` §3 的 44 个双向相等；`AskUserQuestion` 由渲染层跳过，不产生展示行 | 约束 | 新增工具若漏映射会露出原始名 |
| 4 | 明确不做输出正则改写，拦截在渲染层；running 文案不得拼工具名；description 约束放 `\n` 之后的末尾 | 约束 | 静默改写模型正文更难排查 |
| 5 | 「怎么说话」八条、`SAFETY_RULES` 新增两条、危险工具 description 正反位置、状态文案兜底纳入契约测试 | 测试 | 防回归 |
| 5 | §15.5 矩阵同步本文件 2.7.0、`events.md` 2.7.0、`tools.md` 3.6.0、`tun-backend.md` 1.0.7 | 元数据 | — |

### 2.6.0（2026-11-05，helper 状态/重启、退出流程与 AI 代劳升级）

| # | 变更 | 类型 | 决议来源 |
|---|---|---|---|
| 1 | 本文件版本升到 `2.6.0`；§2 新增 59 `tun_helper_info`、60 `tun_helper_restart`，详解见 §7.8.1 / §7.8.2 | 新增命令 | 后台组件需要可自助换新映像 |
| 2 | 两条命令均为 **UI 专用**：`tools.md` §3 不注册对应工具；§13 补行 | AI 边界 | 重启特权组件属于系统管理动作 |
| 3 | 新增 §7.8.3 应用退出流程：**先停 TUN、再停代理运行时**；与 `network_force_reset` 共用清理代码；清理失败不阻塞退出 | 缺陷修复约束 | 当前实现只停代理运行时 |
| 4 | §7.10 AI 边界改为「`core_upgrade` 只能经 `CoreUpgrade` 且必须用户逐字确认」；其余 `core_*` 仍无工具 | AI 边界 | 产品负责人 2026-11-05：AI 代劳升级定稿 |
| 5 | 确认卡复用 `AskUserQuestion` 阻塞通道：Host 填 `kind: "core_upgrade_confirm"` 与 `details`（含 `restart_required`，取自 `core_info`）；同意一次性绑定 `(session_id, request_id, target_version, artifact_sha256)`，换版本重新确认 | 约束 | 模型不能伪造确认 |
| 6 | `JobGet` 与 `core-upgrade-progress` / `core-upgrade-finished` 增必填 `origin: "ui" \| "agent"`（旧记录按 `"ui"`）；`origin` 由 Host 写入，不是入参 | 字段扩展 | 区分 UI 与 Agent 发起的任务 |
| 7 | §15.5 矩阵同步 `events.md` 2.6.0、`tools.md` 3.5.0 | 元数据 | — |

### 2.5.0（2026-11-05，运行时核心版本管理）

| # | 变更 | 类型 | 决议来源 |
|---|---|---|---|
| 1 | 本文件版本升到 `2.5.0`；§2 新增 54–58 `core_info` / `core_check_updates` / `core_upgrade` / `core_cancel_upgrade` / `core_rollback`，详解见 §7.10 | 新增命令 | PM：核心升级改为 UI 显式触发，模型不再参与 |
| 2 | 明确五条命令均为 **UI 专用**，`tools.md` §3 不注册对应工具；§13 补对应行 | AI 边界 | 下载并替换特权二进制不能交给模型 |
| 3 | 写入四条契约级约束：随包验签判定、已安装校验失败回落随包、绝不静默下载、启动过程不联网 | 约束 | PM 2026-11-05 |
| 4 | `core_install` 从 AI 工具集删除；`core_list_versions` 保留为只读工具 | AI 边界 | 同上；见 `tools.md` 3.4.0 |
| 5 | §15.5 矩阵同步本文件 2.5.0、`events.md` 2.5.0、`tools.md` 3.4.0 | 元数据 | — |

### 2.4.0（2026-11-05，强制重置网络下发）

| # | 变更 | 类型 | 决议来源 |
|---|---|---|---|
| 1 | 本文件版本升到 `2.4.0`；§2 新增 53 `network_force_reset`，详解见 §7.9（无参数、八步固定、`{ok, verified, exit_ip, steps}`）；明确它是 **UI 专用命令**，`tools/net.rs` 不注册对应工具 | 新增命令 | 强制重置网络落地；破坏性路径不交给模型 |
| 2 | §7.4 的 E3 说明由「本批不下发」改为「已下发为独立命令」——不并入 `net_repair` 的四个 action | 更正 | 返回形状不同，混进 action 会让同一命令有两种载荷 |
| 3 | §6 的 `reset_network` 动作、§12.1 / §12.2 的能力映射补上 E3 → `network_force_reset` | 映射 | 同上 |
| 4 | §15.5 矩阵同步本文件 2.4.0 | 元数据 | — |

### 2.3.5（2026-11-05，助手设置/卸载补录）

| # | 变更 | 类型 | 决议来源 |
|---|---|---|---|
| 1 | 本文件版本升到 `2.3.5`；§2 新增 51 `tun_helper_open_settings`、52 `tun_helper_uninstall`，详解见 §7.7 / §7.8 | 补录 | 实现已注册（`lib.rs:300-301`）、契约未写，检查器报 FAIL；产品负责人 2026-11-05 确认按实现签名补 |
| 2 | §15.5 矩阵同步本文件 2.3.5、`routing.md` 1.2.0，并新增 `tun-backend.md` 1.0.6 一行 | 元数据 | 矩阵滞后于各文件的真实版本 |

### 2.3.4（2026-11-05，节点延迟与出口延迟分开）

| # | 变更 | 类型 | 决议来源 |
|---|---|---|---|
| 1 | 本文件版本升到 `2.3.4` | 元数据 | 产品：「2098 毫秒」是出口 IP 探测，不是节点延迟 |
| 2 | §7.3 `RuntimeSnapshot` 新增 `node_latency_ms: number \| null`（归属 `runtime.md` 2.3.0） | 字段新增 | 同上 |
| 3 | §7.2 断开成功后置 `null` 的字段清单补上 `node_latency_ms` | 说明 | 避免断开后还显示上一个节点的延迟 |
| 4 | §15.5 版本矩阵同步 `events.md` 2.4.0、`runtime.md` 2.3.0 | 元数据 | 矩阵再次滞后于各文件的真实版本 |
| 5 | §7.3 明确其中的 `contract_version` 跟 `runtime.md`，不跟本文件 | 说明 | 全文只有这一处副本，容易误判 |

### 2.3.3（2026-11-04，流量口径）

| # | 变更 | 类型 | 决议来源 |
|---|---|---|---|
| 1 | `contract_version` 升到 `2.3.3` | 元数据 | 流量采样落地 |
| 2 | §7.3 里 `traffic` 的不变量改为与 `runtime.md` §2.4 一致：`null` = 没有数据（未连接 / 尚未采到 / TUN），不是 0 字节 | 语义修正 | 实现 `0576da4` |
| 3 | §16 版本矩阵同步 `events.md` 2.2.0、`runtime.md` 2.2.0、`routing.md` 1.1.0 | 元数据 | 矩阵滞后于各文件的真实版本 |

### 2.3.2（2026-11-04，节点来源对外叫「测试节点」）

| # | 变更 | 类型 | 决议来源 |
|---|---|---|---|
| 1 | `contract_version` 升到 `2.3.2` | 元数据 | 产品口径统一 |
| 2 | §7.1 说明里的「默认节点」改为「测试节点」；`source: "seed"` 等机制名不变 | 措辞 | 产品负责人：我们提供的节点只供测试，长期方向是用户自建与供应商接入 |

### 2.3.1（2026-11-04，`hidden` 与历史回放的约束）

| # | 变更 | 类型 | 决议来源 |
|---|---|---|---|
| 1 | `contract_version` 升到 `2.3.1` | 元数据 | 代码审查指出的将来坑 |
| 2 | §9.1 补约束：将来实现历史回放时，必须为 hidden 消息保留标记或从 assistant 消息反推重建 | 约束 | 当前不回放，故现在无影响 |

### 2.3.0（2026-11-04，`ai_send_message` 补 `hidden`）

| # | 变更 | 类型 | 决议来源 |
|---|---|---|---|
| 1 | `contract_version` 升到 `2.3.0` | 元数据 | 引导页自动开场需要系统代发消息 |
| 2 | `ai_send_message` 增加可选 `hidden`：为 true 时用户消息不写 `chat_messages`，文本仍送模型 | 字段新增 | 前端/后端已实现并测试 |
| 3 | 删除 `attachments`：自 1.0 声明以来从未实现、无需求/UI/存储设计 | 字段删除 | 契约检查器长期对不上；判定为死字段 |

### 2.2.0（2026-11-04，批 3 修订）

| # | 变更 | 类型 | 决议来源 |
|---|---|---|---|
| 1 | `runtime_start` **去掉 `nodeId` 参数**；切换当前节点只走 `node_switch` | 不兼容 | PM 2026-11-04：两个入口做同一件事，迟早有人用错 |
| 2 | `route_set_mode` 的跨家族确认文案补充「域名解析方式也会改变」 | 交互约束 | 非中国 `direct` 改用本地 DNS 后，跨家族必然改变 DNS 行为 |
| 3 | 非中国 `direct` / `proxy_all` 的 DNS 策略改为全本地解析（`routing.md` 1.1.0） | 语义 | 产品负责人 2026-11-04 |
| 4 | `rules_update` 改为先直连、代理兜底；未连接且直连失败才排队 | 语义 | GitHub 按 IP 封、时通时不通（2026-11-04 实测） |

### 2.1.0（2026-11-03，批 3 · 分流与 DNS）

| # | 变更 | 类型 | 决议来源 |
|---|---|---|---|
| 1 | `contract_version` 升到 `2.1.0` | 元数据 | 批 3 契约设计 |
| 2 | 新增 9 条命令：`route_get` / `route_set_mode` / `route_targets_set` / `rule_custom_list` / `_add` / `_delete` / `category_list` / `rules_status` / `rules_update` | 新增命令 | `routing.md` 1.0.0 |
| 3 | `config_create` / `config_update` 新增可选 `targets`；`proxy_selected` 时必填 | 字段新增 | 配置模型包含目标服务 |
| 4 | 参数 `routeMode` 统一更名为 `routingMode` | 改名 | 与 `configs.routing_mode`、AI 工具 schema 同名，消除中转 |
| 5 | `proxy_selected` 不再返回 `UNSUPPORTED`，改为正式支持 | 语义变更 | 批 3 落地 |
| 6 | `route_set_mode` 跨家族切换要求 `confirmReconnect`；未确认时 `will_disconnect` | 语义定案 | PM 裁定 1 |
| 7 | `rules_update` 未连接时排队（`queued: true`），不返回失败 | 语义定案 | PM 裁定 4 |
| 8 | 能力映射补 G1–G4 / I1 / I2，并新增 K 组 K1–K5（批 0 PM 裁定） | 映射 | `capabilities.md` |

### 2.0.0（2026-11-03，批 0 · 契约与数据模型）

| # | 变更 | 类型 | 决议来源 |
|---|---|---|---|
| 1 | `contract_version` 升到 `2.0.0` | 元数据 | 数据模型从「单节点 profile」换成「配置 + 节点池」 |
| 2 | 删除 `profile_list` / `profile_delete`，新增 `config_*` 六条 | 替换 | `implementation-plan.md` 批 1 |
| 3 | 新增节点命令 `node_import_url` / `node_create` / `node_switch` / `node_probe` | 新增 | `config-execution.md` §6、`center-panel.md` §2.5.1 |
| 4 | 新增 `proxy_params`（A5，单端口双协议） | 新增 | `capabilities.md` A5、`center-panel.md` `proxy_card` |
| 5 | 新增 `probe_run`（D1 / D4，连接后四项探测） | 新增 | `config-execution.md` §8、`issue-management.md` §5 |
| 6 | 新增 `issue_*` 五条（J2–J4）；**不提供 `issue_create`**，J1 只由 Host 内部触发 | 新增 | `issue-management.md` §2、§3 |
| 7 | `runtime_start` 参数 `profileId` → `configId`，新增 `nodeId`；删掉「默认配置包」二级回退 | 不兼容 | 新模型没有「没有配置也能连」的状态 |
| 8 | `RuntimeSnapshot` 的 `profile_*` 改名 `config_*`，新增 `node_*`，`mode` 增加 `tun` | 不兼容 | 同一实体只能有一个名字 |
| 9 | `default_profile_*` 语义改为 `veyl_seed.json`，`package_id` → `seed_id`，时间改毫秒 | 不兼容 | `config-execution.md` §9–§10 |
| 10 | `import_seed_file` 保留但收窄为「只并节点池」，不再创建配置 | 不兼容 | 离线兜底与开发注入仍需要它 |
| 11 | 新增 §1.5：落库实体时间统一 Unix 毫秒；事件信封 `emitted_at` 仍是 ISO | 约定 | 与 `data-model.md` 的列类型一致 |
| 12 | 新增 §11 能力 ↔ 命令 ↔ 块映射，并列出 6 处对不上的地方 | 新增 | 三条硬约束要求一一对应 |
| 13 | 补录 `open_external`（1.2.0 代码有、契约没有） | 补录 | 白名单实现已存在 |
| 14 | 明确「先撤代理再停运行时」「连接失败不回退」等旧不变量在新模型下继续有效 | 约束 | 不改原则，只改数据单位 |
| 15 | 同步升级 `runtime.md` 2.0.0 与 `tools.md` 3.0.0，四份应用侧契约统一为 config / node 词汇 | 同步 | 防止半迁移实现 |
