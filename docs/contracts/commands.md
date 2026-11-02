# 契约：UI → Host 命令（invoke）

> 契约版本：`1.1.0`
> 状态：已冻结（P1.5 wave1，2026-11-02）
> 上游：`docs/phase-1-5-requirements.md` §4、§5、§9
> 相关：`events.md`（Host → UI 的反向通道）、`runtime.md` §2.5（`RuntimeStatus`）、`tools.md`（AI 工具）
> 变更记录：见 §7

> ⚠️ **本文件的版本号不代表整个契合同步升级。**
> 契约拆成多份之后，每份的版本各自独立：`catalog.md` 是**与服务端协商**的协议版本（改它会中断目录服务，见该文件变更记录），`tools.md` / `runtime.md` / `events.md` / 本文件是应用内部版本。
> **批量改版本号时不要顺手全改**——按文件改，一次只动真正变化的那个。

---

## 0. 本契约的地位

`invoke` 是 **UI → Host 的唯一请求通道**，事件是 Host → UI 的唯一推送通道。两者不互相替代：

- UI 需要「做一件事并拿到结果」→ 用 `invoke`，同步等返回值。
- Host 需要「告诉 UI 状态变了」→ 用事件，UI 不轮询。

**一个命令与一个 AI 工具如果语义相同，必须共用同一份 Host 实现**（`tools.md` §5）。UI 路径和模型路径出现两套逻辑，是本项目已经踩过的缺陷来源。

---

## 1. 命名与参数约定（**这一节是本节契约最容易被写错的地方**）

### 1.1 命令名用 snake_case，参数名用 camelCase

Tauri 2 的 `#[tauri::command]` 默认把 JS 侧的 **camelCase 参数**映射到 Rust 侧的 **snake_case 形参**。

| 侧 | 写法 | 例子 |
|---|---|---|
| 命令名（invoke 第一个参数） | snake_case | `runtime_start`、`import_seed_file` |
| 参数键（args 对象的键） | **camelCase** | `profileId`、`sessionId`、`text` |
| Rust 形参 | snake_case | `profile_id: Option<String>` |
| 返回值字段 | snake_case | `request_id`、`profile_id` |

**现存证据**（不要按旧文档改）：

```
src/agent/tauriBridge.ts:86   call("profile_delete", { profileId })
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

要用可选字段就**平铺到顶层**（见 §3.16），要么在嵌套结构体上显式写 `#[serde(rename_all = "camelCase")]` 并在契约里注明。本项目选前者。

### 1.2 返回值与错误

- 成功：返回该命令定义的 data 对象，**不含 `ok` 外层信封**（工具调用才有 `ToolEnvelope`）。
- 失败：`Err(AivpnError)`，结构见 `runtime.md` §2.6（`code` / `message` / `retryable` / `details` / `request_id`）。
- `details.reason` 用于细分同一错误码下的不同场景，取值在每条命令的表格里固定。

### 1.3 来源标记

Host 在每个命令入口自动注入 `source = "ui"`，UI **不能**在参数里传 `source`（传了按 `INVALID_ARGUMENT` 拒绝）。只读命令不做来源校验。

### 1.4 幂等

标了「幂等」的命令重复调用不产生额外副作用，返回值反映最终状态而非本次动作。

---

## 2. 命令总表

| # | 命令 | 入参 | 返回 | 状态 |
|---|---|---|---|---|
| 1 | `ai_send_message` | `{ sessionId, text, attachments? }` | `{ request_id }` | 已接线 |
| 2 | `ai_cancel` | `{ requestId }` | `{ cancelled: boolean }` | 已接线 |
| 3 | `runtime_status` | `{}` | `RuntimeStatus` | 已接线 |
| 4 | `runtime_start` | `{ profileId?: string }` | `RuntimeStatus` | **1.1.0 新增** |
| 5 | `runtime_stop` | `{}` | `RuntimeStatus` | **1.1.0 新增** |
| 6 | `profile_list` | `{}` | `ProfileListData` | **1.1.0 新增** |
| 7 | `profile_delete` | `{ profileId }` | `ProfileDeleteData` | 已接线 |
| 8 | `chat_history` | `{ sessionId? }` | `ChatHistory` | 已接线（此前未入契约，1.1.0 补录） |
| 9 | `rename_session` | `{ sessionId, title }` | `{ id, title, created_at }` | 已接线 |
| 10 | `import_seed_file` | `{ path }` | `ImportSeedResult` | 已接线 |
| 11 | `deepseek_key_status` | `{}` | `{ configured, masked }` | 已接线（补录） |
| 12 | `deepseek_save_key` | `{ key }` | `{ masked, verified }` | 已接线（补录） |
| 13 | `deepseek_clear_key` | `{}` | `{ ok: true }` | 已接线（补录） |
| 14 | `onboarding_status` | `{}` | `OnboardingStatus` | **1.1.0 新增** |
| 15 | `onboarding_complete` | `{ skippedKey: boolean }` | `{ ok: true }` | **1.1.0 新增** |
| 16 | `net_repair` | `{ action }` | `NetRepairResult` | **1.1.0 新增（wave2 实现）** |
| 17 | `default_profile_refresh` | `{}` | `DefaultProfileResult` | **1.1.0 预留（wave2 实现）** |
| 18 | `default_profile_status` | `{}` | `DefaultProfileResult` | **1.1.0 预留（wave2 实现）** |
| 19 | `open_log_dir` | `{}` | `{ path: string }` | **1.1.0 新增** |
| 20 | `chat_delete` | `{ sessionId }` | `{ ok: true }` | **1.1.0 新增** |
| 21 | `llm_provider_list` | `{}` | `LlmProviderList` | **1.1.0 新增** |
| 22 | `llm_provider_save` | `{ providerId?, name, protocol, baseUrl?, model, apiKey? }` | `LlmProvider` | **1.1.0 新增** |
| 23 | `llm_provider_delete` | `{ providerId }` | `{ ok: true }` | **1.1.0 新增** |
| 24 | `llm_provider_activate` | `{ providerId }` | `{ active_provider_id }` | **1.1.0 新增** |
| 25 | `llm_provider_test` | `{ providerId?, name?, protocol?, baseUrl?, model?, apiKey? }` | `LlmTestResult` | **1.1.0 新增** |
| — | `catalog_list_nodes` | — | — | **未接线**，见 §4 |
| — | `profile_import_node` | — | — | **未接线**，见 §4 |
| — | `vpn_connect` | — | — | **1.1.0 作废**，由 `runtime_start` 取代 |
| — | `vpn_disconnect` | — | — | **1.1.0 作废**，由 `runtime_stop` 取代 |

> 「已接线」= 当前 `invoke_handler` 里注册了。`invoke_handler` 是唯一事实来源，文档与它对不上就是文档错。

---

## 3. 逐条语义

### 3.1 `runtime_start { profileId?: string }` → `RuntimeStatus`

无 AI 模式的主行动。与 AI 工具 `RuntimeStart` **共用同一份 Host 实现**。

| 项 | 规则 |
|---|---|
| `profileId` 指定 | 解析该 profile；不存在 → `NOT_FOUND` |
| `profileId` 省略 | 按顺序三级回退（见下） |
| 已在连接中 | **不报错**：换到目标（平滑切换，见技术设计 §4）；目标就是当前连接 → 直接返回当前快照 |
| 成功后 | 系统代理已设置、运行时 `state = running`；返回的 `RuntimeStatus` 必须满足 §3.1.1 |

**`profileId` 省略时的三级回退**（PM 拍板）：

```
1. 有 active profile            → 用它
2. 否则有可用的默认配置包        → 用默认配置包连（profile_id 为 null）
3. 两者都没有                   → PRECONDITION_FAILED，details.reason = "no_active_profile"
```

- **第 2 级必须有**：全新安装的用户没有导入过任何节点，只有默认配置包。若这里直接报错，「装好就能连」的产品目标就不成立（需求 §6 的整个 C 组验收依赖它）。
**不变量（必须实现，不是行为描述）**

> **默认配置包只在「没有任何 active profile」时才被选中。连接失败不得触发回退。**

有 active profile 但连不上（凭据缺失、节点下线、握手失败）时，错误如实返回，**不得**改走默认配置包。理由：静默换成默认包会让用户以为自己连的是选中的那个节点，而实际流量走了另一条线路——「悄悄换了出口」比连不上更危险，用户会用错误的出口做敏感操作。

测试断言：让一个 active profile 必定失败（例如把它的 server 指向 `127.0.0.1:1`），同时保证默认包可用，点连接 → 必须是 `Err`，且 `diag`/日志里没有默认包的连接记录。
- 走第 2 级时渲染配置的键固定为 `"default"`，与 profile 的 `profile-<id>.json` 分开，断开时一并删除。

**3.1.1 返回状态的不变量**

- `state` 只可能是 `running` 或 `degraded`；其它状态一律视为失败并返回错误。**不允许「返回成功但 state 不是 running」**（这是 1.0.10 的 D-36 缺陷）。
- `mixed_port` 必须是本次实际监听的端口，不得为常量或 `null`。
- `profile_id` / `profile_name` 与目标一致；**用默认配置包连接时 `profile_id` 为 `null`**，`profile_name` 为包内节点名（当前实现固定为 `"默认配置"`）。
- `connected_since` 为本次进入 running 的时刻。
- `exit_ip` / `latency_ms` 允许为 `null`（探测是异步的），**不代表连接失败**。

错误码：`RUNTIME_NOT_INSTALLED`、`PRECONDITION_FAILED`、`NOT_FOUND`、`CATALOG_UNAVAILABLE`、`RUNTIME_CONFIG_INVALID`、`RUNTIME_PORT_UNAVAILABLE`、`TIMEOUT`、`UPSTREAM_ERROR`、`INTERNAL`。

### 3.2 `runtime_stop {}` → `RuntimeStatus`

| 项 | 规则 |
|---|---|
| 顺序 | **先撤系统代理，再停运行时**。顺序不可交换 |
| 代理撤销失败 | **中止断开**，运行时保持运行，返回 `PRECONDITION_FAILED`，`details.reason = "proxy_restore_failed"`。不可以在代理没撤掉的情况下停掉 sing-box——那等于把用户直接断网 |
| 已经断开 | 幂等：返回当前快照（`state = "idle"`），不报错 |
| 成功后 | `state = "idle"`，`mixed_port` / `profile_name` / `connected_since` / `exit_ip` / `latency_ms` 全为 `null`，渲染配置已删除 |

> 这条规则与退出流程（技术设计 §3）一致：**宁可断开失败，也不能留下指向死端口的系统代理**。

### 3.3 `profile_list {}` → `ProfileListData`

**与 AI 工具 `ProfileList` 逐字一致**（同一份实现、同一组字段、同一种排序）。命令层只做搬运。

```ts
type ProfileListData = {
  profiles: Array<{
    profile_id: string;
    node_id: string | null;  // null = 种子文件导入，没有远端节点 id
    name: string;
    protocol: string | null; // "vless_reality" | "hysteria2" | "shadowsocks"
    region: string | null;
    is_active: boolean;
    created_at: string;      // ISO 8601 UTC，毫秒精度
  }>;
  active_profile_id: string | null;
};
```

- 数据源是**本地已保存配置**（含种子导入），**不含远端目录**。
- 排序：`created_at ASC`（与 `store::profiles::list` 的 `ORDER BY` 一致）。要「最新在前」由 UI 自己排，**后端不另立一套排序**。
- `node_id` 保留，用于区分来源（目录导入 / 本地导入）；PM 拍板时的示例漏了它，但「逐字一致」要求包含。
- 不含任何凭据或配置原文。

### 3.4 `onboarding_status {}` → `OnboardingStatus`

```ts
type OnboardingStatus = {
  completed: boolean;     // settings.onboarding_completed 存在即 true
  has_key: boolean;       // 存在非空的 DeepSeek Key（**不要求已验证**）
  profile_count: number;  // 本地 profile 数量
};
```

判定「是否进入首次引导」由 UI 做（需求 §5.1）：

```ts
const needsOnboarding = !completed && (!has_key || profile_count === 0);
```

**是「或」不是「与」**：只配了 Key 没有配置、或有配置但没配 Key，都应该进引导。
`completed` 是唯一的短路条件——完成过一次之后，无论 Key 和配置处于什么状态，都不再自动弹引导。

> `has_key` 与 `deepseek_key_status` 的 `configured` 同义，**不得出现第三种叫法**。两者都由同一个 `secrets` 查询得出。

### 3.5 `onboarding_complete { skippedKey: boolean }` → `{ ok: true }`

- 写入 `settings.onboarding_completed`（值为完成时刻的 Unix 毫秒）。**无论是否跳过 Key 都写**，否则用户每次启动都会被再次拉进引导。
- `skippedKey` 仅用于记录，不影响判定；不得因为 `skippedKey = true` 而删除已有 Key。
- 幂等：重复调用只更新时间戳。

### 3.6 `net_repair { action, port? }` → `NetRepairResult`（wave2 实现）

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
| `restore_direct` | 撤系统代理（含复核）→ 停运行时 → 删渲染配置 → 不带代理探测出口 IP | ✅ 「恢复网络」 |
| `flush_dns` | macOS：`dscacheutil -flushcache` + `killall -HUP mDNSResponder`；Windows：`ipconfig /flushdns` | ✅ 诊断页 |
| `set_proxy` | 把系统代理指向 Veyl 自己的 mixed 端口，`port` 必填且必须等于当前运行时的端口 | ❌ 留给模型 |
| `clear_proxy` | 撤代理并恢复备份，不停运行时 | ❌ 留给模型 |

- `exit_ip` / `verified` **恒存在**，没有值时写 `null` / `false`，不要省略键。
- `verified = false` 时 `ok` 必须为 `false`。
- `ok = false` 时 `detail` 必须说明卡在哪一步；可重试的操作不要把用户引向「重装」。
- 未知 `action` → `INVALID_ARGUMENT`，`details.supported` 列出四个取值。

### 3.7 `default_profile_refresh {}` / `default_profile_status {}`（wave2 实现）```ts
type DefaultProfileResult = {
  package_id: string | null;
  version: string | null;             // 当前已应用的配置包版本
  applied_at: string | null;          // ISO 8601
  new_version_available: boolean;     // refresh 之后才可能为 true
  node_count: number;
};
```

- `status` **只读**，不联网；`refresh` 会拉取并应用新包。
- 刷新**不打断在线连接**（需求 §6.5）：新包只写库与文件，下一次连接才生效。若正在连接，`new_version_available = true`，由 UI 提示「下次连接生效」。

### 3.7.1 `open_log_dir {}` → `{ path: string }`

定位当前日志文件，供状态面板的「打开日志」使用（需求 §9.5）。

- **不接受任何路径参数**。签名就是空对象，Host 自己决定打开哪里——防止被调用方指定任意目录，把「打开日志」变成「浏览文件系统」。
- 行为是**用系统文件管理器定位到日志文件**（macOS `open -R`，Windows `/select`），**不是**用编辑器打开、也不是 `open` 整个目录。
- 返回 `path` 便于 UI 把路径显示出来（面板上的三级信息里会用到）。
- 文件不存在 → 返回 `NOT_FOUND`，`details.hint = "还没有日志，先连接一次"`；不要临时创建一个空文件来「让它成功」。

### 3.8 `import_seed_file { path }` → `ImportSeedResult`

（1.0.10 起不变，从 `events.md` §5.2 迁入本节。）

两条 UI 入口，**一个命令、一套实现**：窗口级拖放（`onDragDropEvent`）与设置页「选择文件」（`plugin-dialog` 的 `open()`，只授 `dialog:allow-open`）。用户取消时 `open()` 返回 `null`，前端直接返回，**不调用本命令**。

```ts
type ImportSeedResult = {
  imported: number;
  skipped: Array<{ name: string; reason: string }>;
  profiles: Array<{ id: string; name: string; server: string; server_port: number; method: string }>;
};
```

Host 侧顺序固定：扩展名 `.json` → 大小 ≤ 1 MB → 存在且可读 → 解析 → 落库。

| 错误码 | `details.reason` | 场景 |
|---|---|---|
| `INVALID_ARGUMENT` | `not_json_file` | 扩展名不是 `.json` |
| `INVALID_ARGUMENT` | `file_too_large` | 超过 1 MB，`details.max_bytes` |
| `INVALID_ARGUMENT` | `file_unreadable` | 路径不存在或不可读 |
| `INVALID_ARGUMENT` | `invalid_json` | 内容不是合法 JSON / 结构不符 |
| `INVALID_ARGUMENT` | `no_importable_nodes` | 解析成功但无可导入节点，`details.skipped` |
| `UNSUPPORTED` | — | method 不在白名单，`details.method` |
| `SECRET_STORE` | — | `secrets.enc` 写入失败 |

规则：只接受 shadowsocks 出站、method 白名单 `aes-256-gcm`；部分成功不算失败；返回值与日志**永不含 password**；不回显文件内容。

### 3.9 `rename_session { sessionId, title }` → `{ id, title, created_at }`

标题校验：trim → 非空 → ≤ 80 Unicode 标量。失败 `INVALID_ARGUMENT`，`details.reason ∈ {empty_title, title_too_long}`。

### 3.10 `profile_delete { profileId }` → `ProfileDeleteData`

```ts
type ProfileDeleteData = {
  profile_id: string;
  deleted: boolean;            // true = 本次真的删掉了
  already_absent: boolean;     // true = 本来就不存在（幂等命中）
  active_profile_id: string | null;
};
```

- **前置校验先于删除**：目标是 active profile → `PRECONDITION_FAILED`，不产生任何副作用。
- 删除时一并清掉该 profile 的渲染配置与 `node:<profile_id>` 凭据条目。

---

### 3.11 `chat_delete { sessionId }` → `{ ok: true }`

删除一个会话及其全部消息（需求 R31 / 验收 G1）。**不可恢复**，靠 UI 的二次确认兜底 —— Host 不做回收站。

```ts
type ChatDeleteResult = { ok: true };
```

| 情况 | 结果 |
|---|---|
| 会话不存在 | `NOT_FOUND` |
| 该会话有进行中的 AI 请求 | `PRECONDITION_FAILED`，`details.reason = "active_request"` |
| 正常删除 | `{ ok: true }` |

**事务内删除，三张表一起删：**

```sql
BEGIN;
DELETE FROM tool_calls    WHERE session_id = ?1;
DELETE FROM chat_sessions WHERE id = ?1;   -- chat_messages 由外键 ON DELETE CASCADE 带走
COMMIT;
```

**为什么必须显式删 `tool_calls`**：`chat_messages.session_id` 有外键 `ON DELETE CASCADE`，但 **`tool_calls.session_id` 没有外键**（`001_init.sql:79`，只有索引）。只删会话的话，工具调用记录会变成孤儿——用户以为「对话删干净了」，实际上参数与结果还留在库里，验收命令 `SELECT COUNT(*) FROM tool_calls` 也仍然数得到旧行。这是需求里「不得出现半删除状态」的直接后果。

**为什么 Host 拒绝而不是自动取消**：需求 §5.7 写的是「先取消请求，再删除」。这一步由 **UI** 完成：

```
点击删除 → 二次确认 → 若该会话正在生成：先 ai_cancel，等 ai-request-end
                     → 再调用 chat_delete
```

Host 侧硬拒绝是为了避免「取消信号还在路上、删除已经执行、迟到的 chunk 又把消息写回来」这种竞态。把取消留给 UI 做，Host 只需要保证「删的时候一定是静止的」。

**成功后 UI 的跳转**（需求 §5.7）：删的是当前会话 → 切到下一个；没有下一个 → 回**总览**（控制台空态）。跳转属于 UI 职责，Host 只返回 `{ ok: true }`。

错误：`NOT_FOUND`、`PRECONDITION_FAILED`（`active_request`）、`INTERNAL`（事务失败，此时**不得**留下部分删除）。

---

### 3.12 LLM Provider：共用类型与校验（R32）

五个命令共用同一份校验，**不允许各写一套**。

```ts
type LlmProtocol = "openai" | "anthropic";

type LlmProvider = {
  provider_id: string;          // 稳定 id，创建后不变
  name: string;                 // 用户可读
  protocol: LlmProtocol;
  base_url: string | null;      // null = 用该协议的官方地址
  model: string;
  has_key: boolean;             // 只表示"有/没有"，永不返回值本身
  is_active: boolean;
  is_builtin: boolean;          // 内置 provider（迁移产生的 deepseek）
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
| 7 | 非本机端点必须有 Key（见 §3.13 的"保留原 Key"规则） | `PRECONDITION_FAILED`，`details.reason = "api_key_required"` |

**第 5 条的理由**：`https://sk-xxx@api.example.com` 这种 URL 会把密钥放在 URL 里，它会被写进日志、错误信息、以及任何打印 URL 的地方。需求 §5.8 明确禁止"把 Key 拼进 URL"，校验层必须挡住，而不是靠 UI 不填。

**「本机端点」的判定**：只看解析后的 host，不看字符串。`http://127.0.0.1:11434`、`http://localhost:11434`、`http://[::1]:11434` 是本机；`http://192.168.1.10:11434` 不是——局域网里的 Ollama 也必须走 https 或者不接受。原因是 http 明文会把 Key 和对话内容暴露在网络上。

**`base_url` 的规范化**：存储保留用户输入的原样（去掉首尾空白与末尾 `/`），**拼接由 Host 负责**；用户如果填了以 `/v1` 结尾的地址，Host 在装配时去掉，避免拼出 `/v1/v1`（技术设计 §12.2）。

### 3.13 `llm_provider_save { providerId?, name, protocol, baseUrl?, model, apiKey? }` → `LlmProvider`

| 情况 | 行为 |
|---|---|
| `providerId` 省略 | **新建**，Host 生成 `provider_id`（`p_` + 随机十六进制），`is_builtin = false` |
| `providerId` 指定 | **更新**该 provider；不存在 → `NOT_FOUND` |
| `apiKey` 省略或空串，且该 provider 已有 Key | **保留原 Key**，不覆盖 |
| `apiKey` 省略或空串，且没有 Key | 仅当 base_url 是本机端点时允许（Ollama）；否则 `PRECONDITION_FAILED / api_key_required` |
| `apiKey` 非空 | 写入 `secrets.enc` 的 `provider:<provider_id>`，覆盖旧值 |

- 返回值**永远不含 Key**，`has_key` 只给布尔。
- 保存**不打断正在进行中的请求**（需求 §5.8）：进行中的会话仍用启动时的 provider，新的下一次请求才生效。

**不变量：保存不改变当前 provider。**

> **`llm_provider_save` 只保存，不改变 active。切换只能通过 `llm_provider_activate`。**
> 唯一例外：**当前没有任何 active provider 时**，保存的第一个自动成为 active（否则全新安装存完 Key 仍然没有可用 provider，用户会以为没保存成功）。

需要这条的理由：用户编辑一个**备用** provider（只改模型名）并保存，不应该让正在用的对话流量悄悄换到另一个端点。与「节点连不上不得悄悄回退默认包」是同一条原则——**不静默改变请求的去向**。

由此推出的两条约束：

- 编辑**当前激活的** provider 时，保存后仍是 active（值没变，但配置已更新，下一次请求即生效）。
- `llm_provider_activate` 是**唯一**能改 active 的命令；UI 上「保存」与「设为当前」必须是两个独立动作。

错误：`INVALID_ARGUMENT`（§3.12 的 1–6）、`PRECONDITION_FAILED`（`api_key_required`）、`NOT_FOUND`、`SECRET_STORE`。

### 3.14 `llm_provider_delete { providerId }` → `{ ok: true }`

- **同一个操作里删两样**：settings 里的条目 + `secrets.enc` 的 `provider:<provider_id>`。不允许留下孤儿密钥（需求 §5.8）。
- **不能删除内置 provider**：`PRECONDITION_FAILED`，`details.reason = "builtin_provider"`。内置的 `deepseek` 是基础模式的载体，删了基础模式就没有落点。用户可以改它的 Key 与模型，但删不掉。
- 不存在 → `NOT_FOUND`。**这里有意不做幂等**：与 `profile_delete` 不同，provider 是用户点名删除的对象，报"不存在"能暴露 UI 状态不同步；静默成功会掩盖问题。

**删除当前激活的 provider 是允许的**（2026-11-02 修订）：

- 删除后 `settings.llm_active_provider` **置空**，返回值仍是 `{ ok: true }`。
- **不自动挑选下一个**。自动挑一个属于「静默切换」——和「节点连不上不得悄悄回退默认包」是同一条原则：不静默改变请求去向。
- 删空后由 UI 提示「没有当前 provider，请选择一个」，引导用户显式调 `llm_provider_activate`。
- 此时若有进行中的对话，**不打断**；下一次请求会因为找不到 active provider 返回 `PRECONDITION_FAILED`，`details.reason = "no_active_provider"`。

错误：`NOT_FOUND`、`PRECONDITION_FAILED`（`builtin_provider`）、`INTERNAL`。

### 3.15 `llm_provider_activate { providerId }` → `{ active_provider_id: string }`

- 目标必须有可用 Key（本机端点除外）：没有 → `PRECONDITION_FAILED`，`details.reason = "api_key_required"`。
- 成功后写 `settings.llm_active_provider`，**新会话立即使用**；进行中的请求不打断。
- 已经是当前 provider → 幂等返回。
- 不存在 → `NOT_FOUND`。

### 3.16 `llm_provider_test { providerId?, name?, protocol?, baseUrl?, model?, apiKey? }` → `LlmTestResult`

**参数是扁平的，没有嵌套 `draft` 对象。**

> 为什么不能用嵌套：Tauri 只对**命令的顶层参数**做 camelCase → snake_case 转换，嵌套对象里的键按各自的 serde 规则走。写 `{ draft: { baseUrl } }` 时 Rust 侧拿到的字段名取决于嵌套结构体有没有 `rename_all`，`baseUrl` 与 `base_url` 会变成两个不同的东西——而这个错误在编译期和运行期都不会报，只是字段恒为 `None`。

```json
{
  "type": "object",
  "properties": {
    "providerId": { "type": "string" },
    "name": { "type": "string", "maxLength": 60 },
    "protocol": { "type": "string", "enum": ["openai", "anthropic"] },
    "baseUrl": { "type": "string" },
    "model": { "type": "string" },
    "apiKey": { "type": "string" }
  },
  "additionalProperties": false
}
```

```ts
type LlmTestResult = {
  ok: boolean;
  latency_ms: number | null;   // 成功时的往返耗时；失败为 null
  error?: string;              // 失败时的可读原因，**已脱敏**
};
```

**三种用法**（判据按顺序）：

| 传入 | 行为 |
|---|---|
| 只有 `providerId` | 用已保存的配置与已存的 Key 测试 |
| 给了 `protocol` / `model` / `baseUrl` / `name` 中任一 | 视为**草稿**，不落库；`apiKey` 省略且 `providerId` 存在时，**用已存的 Key** |
| `providerId` 与草稿字段都缺，或草稿缺 `protocol` / `model` | `INVALID_ARGUMENT` |

- 草稿校验与 `llm_provider_save` **共用 §3.12 的同一套规则**（含 base_url 拒绝 userinfo、http 仅限回环）。
- 草稿的 Key 只用于本次请求，**不写盘、不进日志**。
- **只有入参非法才返回 `Err`**；端点不可达、Key 错误、模型不存在、超时一律 `ok: false` + `error`。测试连接失败是它的正常输出，不该抛成异常让调用方分流。
- `error` 必须**脱敏**。上游报错原文里经常带着 Key（有的服务在 401 响应里回显），也可能带上完整请求信息。规则：

  | 要求 | 说明 |
  |---|---|
  | 剔除该 provider 的**实际 Key 值** | 精确串替换，不是模糊匹配 |
  | 任何形如 `sk-[A-Za-z0-9_-]{8,}` 的片段**一律替换** | 覆盖"不是本 provider 的 Key 但也是 Key"的情况 |
  | 替换而不是删除整段 | 把 Key 换成 `<redacted>`，保留其余信息，用户才看得懂错误 |
  | 同样适用于日志与 `detail` 字段 | 「不显示在界面上」不等于"不落到磁盘" |

  `describe_http_error` 这类把上游响应体转成文案的函数是**主要泄漏点**——响应体的 `error.message` 常常把 `Authorization` 头或请求体回显出来。它必须走同一套脱敏，不能因为「只是拼个字符串」就跳过。

**测试连接必须走与真实对话完全相同的装配路径**（技术设计 §12.4）——用另一套代码测出来的「通」，不能代表对话能通。

错误：`INVALID_ARGUMENT`（入参）、`NOT_FOUND`（`providerId` 不存在）、`PRECONDITION_FAILED`（非本机端点缺 Key）。

---

## 4. 未接线与已作废

| 命令 | 处置 | 理由 |
|---|---|---|
| `catalog_list_nodes` | **未接线**，1.1.0 暂留 | 需求 §5.5 的面板与引导走 `profile_list` + 默认配置源，不浏览远端目录。保留是因为「换节点」若将来要展示远端列表会用到。**若 P1.5 结束仍未实现，1.2.0 删除** |
| `profile_import_node` | **未接线**，1.1.0 暂留 | 同上。种子导入已覆盖离线分发（需求 D1） |
| `vpn_connect` | **作废** | 与 `runtime_start` 语义重复。两套入口必然分叉，删除 |
| `vpn_disconnect` | **作废** | 与 `runtime_stop` 语义重复，删除 |
| `chat_delete` | **未接线**（1.1.0 新增） | 契约已冻结，等实现。当前只能重命名会话，不能删（需求 §12.6 第 35 条） |
| `llm_provider_list` / `_save` / `_delete` / `_activate` / `_test` | **未接线**（1.1.0 新增） | 契约已冻结，等实现（需求 §12.6 第 38 条）。当前只有单一的 DeepSeek Key，没有 provider 概念 |
| `settings_get` / `settings_set` | 1.0.10 已删除 | 从未实现 |

> **只作废 invoke 命令，不作废 AI 工具。**
> 聊天通道里的 `VpnConnect` / `VpnDisconnect` 两个工具**继续存在**（`tools.md` §4.11、§4.12），模型仍然可以调用它们。作废的是「UI 直接 invoke」这条重复路径。
>
> 两个通道的关系：
>
> | 通道 | 入口 | 现状 |
> |---|---|---|
> | UI → Host | `runtime_start` / `runtime_stop` | 无 AI 主路径，面板与引导用它 |
> | 模型 → Host | `VpnConnect` / `VpnDisconnect` 工具 | 保留，聊天里说「连到日本」仍然走这条 |
>
> 两条通道最终都落到同一份 Host 实现（§5），差别只在「谁发起」。

> 作废命令的旧文档写法保留在 `events.md` §10 的 1.0.x 变更记录里，仅作历史参考。

---

## 5. 与 AI 工具的对应关系

| 命令 | AI 工具 | 是否共用实现 |
|---|---|---|
| `runtime_start` | `RuntimeStart` | **必须** |
| `runtime_stop` | `RuntimeStop` | **必须** |
| `profile_list` | `ProfileList` | **必须**（但返回字段名不同，见 §3.3 的已知不一致） |
| `profile_delete` | `ProfileDelete` | **必须** |
| `net_repair` | `NetRepair`（1.1.0 新增，wave2） | **必须** |

「共用实现」的含义：命令层只做参数搬运，业务在 `VpnToolServices`。禁止在命令层写一套、在工具层再写一套。

---

## 6. 待 PM 拍板

| # | 议题 | 我的建议 | 状态 |
|---|---|---|---|
| 1 | ~~`profile_list` 用 `id` 还是 `profile_id`~~ | 统一为 `profile_id`，与工具逐字一致 | **已定**：用 `profile_id`，见 §3.3 |
| 2 | `catalog_list_nodes` / `profile_import_node` 是否 1.2.0 删除 | 删除，减少「文档里有、代码里没有」的条目 | 待定 |
| 3 | `default_profile_*` 的返回形状是否为 wave2 定稿 | 先按 §3.7 冻结，wave2 若需扩展只加字段 | 待定 |

---

## 7. 变更记录

### 1.1.0（2026-11-02，P1.5 wave1）

| # | 变更 | 类型 | 决议来源 |
|---|---|---|---|
| 1 | 本文件新建，接管 `events.md` §5 的全部 invoke 定义 | 结构调整 | 命令与事件分开维护 |
| 2 | 参数名统一为 **camelCase**（Tauri 2 默认），纠正 1.0.10 写成 snake_case 的错误 | 修正 | 实测 `profileDelete`/`sessionId` |
| 3 | 新增 `runtime_start` / `runtime_stop` / `profile_list` | 新增命令 | 需求 §9.3、§9.4 |
| 4 | 新增 `onboarding_status` / `onboarding_complete` | 新增命令 | 需求 §5 |
| 5 | 新增 `net_repair`（wave2）、`default_profile_refresh` / `default_profile_status`（wave2） | 预留 | 需求 §10 |
| 5b | `net_repair` 的动作由 2 种扩到 4 种，与 AI 工具 `NetRepair` 齐平，避免两套动作集 | 修正 | 共用实现的前提是动作集一致 |
| 6 | 补录 `chat_history` / `deepseek_*` 三条已接线但从未入契约的命令 | 补录 | 实现早于文档 |
| 7 | `vpn_connect` / `vpn_disconnect` 作废，由 `runtime_start` / `runtime_stop` 取代 | 移除 | 语义重复 |
| 8 | `runtime_stop` 明确「代理撤销失败则中止断开」 | 语义定案 | 需求 §4.6 的同一条原则 |
| 9 | `profile_list` 的 `id` 改为 `profile_id`，补 `active_profile_id` 与 `node_id`，排序改为 `created_at ASC`，与 `ProfileList` 工具逐字一致 | 修正 | PM 拍板；`services.rs:1302` 的回归测试已钉住 `profile_id` |
| 10 | 新增 `open_log_dir {}`（不接受路径参数，用文件管理器定位而非打开编辑器） | 新增命令 | 需求 §9.5「打开日志」 |
| 11 | 明确「作废 invoke 命令 ≠ 作废 AI 工具」：`VpnConnect` / `VpnDisconnect` 工具保留 | 澄清 | PM 提醒 |
| 12 | 文件顶部加「各契约版本独立，不要批量改」的提醒 | 约束 | catalog 的版本协商不能跟着应用版本走 |
| 13 | 新增 `chat_delete { sessionId }`；明确事务内同时删 `tool_calls`（该表没有外键，不会级联）、Host 拒绝 `active_request` 而由 UI 先取消 | 新增命令 | 需求 R31 / 验收 G1 |
| 14 | 新增 `llm_provider_list` / `_save` / `_delete` / `_activate` / `_test` 五个命令与共用校验（§3.12–§3.16） | 新增命令 | 需求 R32 / 验收 H1–H5 |
| 15 | 明确 `base_url` 拒绝 userinfo（防止 Key 被拼进 URL）、http 仅限本机回环 | 安全约束 | 需求 §5.8 约束 |
| 16 | `llm_provider_test` 只在入参非法时返回 `Err`，连接失败一律 `ok:false` + 脱敏 `error` | 语义定案 | 失败是「测试」的正常输出 |
| 17 | `runtime_start` 省略 `profileId` 时改为三级回退：active profile → 默认配置包 → 报错；明确「有 active 但连不上时不回退」 | 语义修正 | PM 拍板；全新安装没有 profile，只有默认包 |
| 18 | 密钥键由 `llm:<provider_id>` 改为 `provider:<provider_id>`，复用已有的 `provider:deepseek`；迁移只补元数据、不搬密钥 | 修正 | 现有约定能复用就别新造 |
| 19 | 「有 active 但连不上不回退」由行为描述升级为不变量，并给出可执行的测试断言 | 约束强化 | PM 要求写成不变量 |
| 20 | `llm_provider_test` 去掉嵌套 `draft`，参数平铺到顶层；新增 §1.1.1「不要用嵌套对象传参」 | 修正 | Tauri 只对顶层参数做 camelCase 转换，嵌套键不会转 |
| 21 | `llm_provider_save` 明确「只保存、不改 active」，唯一例外是没有 active 时的第一个；切换只能走 `activate` | 不变量 | 不静默改变请求去向 |
| 22 | `llm_provider_delete`：**允许删除当前激活项**，删后 active 置空、不自动挑下一个 | 语义修订 | 删除是显式操作；自动挑选属于静默切换 |
| 23 | `llm_provider_test` 的 `error` 补脱敏细则（精确串 + `sk-` 片段 + 替换而非删除 + 同样适用日志） | 安全约束 | 上游响应体是主要泄漏点 |
