# P1 验收报告（执行记录）

> 执行：Clerk ｜ 日期：2026-11-02 ｜ 依据：`docs/acceptance-p1.md` v1.0
> 通道标注：**A** = Tauri 窗口（唯一有效验收）｜ **C** = CLI selftest（只证明运行时本身）
> 执行方式说明：`acceptance-p1.md` §0.1 规定命令由用户执行。本轮 **2026-11-02 17:21 用户明确授权测试人员直接执行**，故 D/E 组由测试人员本地运行，证据为原始终端输出（存 `build/logs/`）。

> **判定变更记录**（时间为事件发生的实际时刻；未记到精确时间的按顺序描述）：
> 1. **17:21** 首跑 E1/E2，判 AC-E1 FAIL、D-01 成立（当时用的是 16:57 构建）。
> 2. 架构师随后收紧 AC-E1 判据 —— 必须逐项比对 **Enabled / Server / Port**，只看勾选框不够；D-01 升为阻断、AC-E2 降为待复测。
> 3. 架构师指出 **`src-tauri/src/proxy/macos.rs` 已于 17:24 重写**，而 17:21 那轮用的是 16:57 的旧二进制。经核实：旧版 `restore_one` 的三条件确实只在 `enabled=true` 时写回地址，**D-01 在当时的 HEAD 上是真实缺陷，不是误报**。17:24–17:27 Bob 修复后，当前构建不再复现。
> 4. **17:27** 用 17:26 构建复跑（中间轮，见 AC-E1 小节末），四主服务恢复正确，但 Thunderbolt Bridge 出现 `Yes→No`；随后 Bob 于 **17:27:40** 再改 D-01b 语义（新增 `incomplete` 分支）。
> 5. **17:29** 用当前构建（源码 17:27 / 二进制 17:28）最终重跑，**AC-E1 与 AC-E2 均判 PASS**。

---

## 1. 结论总表

| ID | 名称 | 通道 | 判定 | 说明 |
|---|---|---|---|---|
| AC-B1 | 应用启动与窗口 | A | **PASS** | 17:12:57，标题 `Veyl`，三栏完整 |
| P-1 | DeepSeek Key 能存（准入） | A | **PASS** | 新方案 `secrets.enc` 0600 + 全密文 + 热更新生效；UI 五项用户确认 |
| P-2 | 工具调用能落库（准入） | A | **PASS** | 18:39 `RuntimeStatus` 落 1 行，`approved=NULL`、`is_error=0`，与真实状态一致 |
| P-3 | 对话能落库（准入） | A | **PASS** | 18:54 会话含 user + assistant 两条、顺序正确；首轮曾漏 user 见 D-05 |
| N-01 | 会话标题可编辑（新增需求） | A | **PASS** | 改名 / 空标题拒绝 / 超 80 拒绝 / 重启保持，四条全过 |
| AC-D1 | 下载 + SHA256 校验 | C | **PASS** | e2e `[2]` |
| AC-D2 | 解压路径穿越被拒 | C | **PASS** | 6 条归档单测全绿 |
| AC-D3 | 启动 → 停止 → 重启 | C | **PASS** | e2e `[5]`→`[7]`，pid 53642，结束后无残留 |
| AC-D4 | 崩溃 → 退避重启 → failed | C | **PASS** | `restart_count=2` 后 `state=failed` |
| AC-D5 | 配置生成过 `sing-box check` | C | **PASS** | e2e `[3]`→`[4]` |
| AC-D6 | Clash API 只监听回环 + secret 生效 | C | **PASS** | `127.0.0.1:50986`，401 / 200 |
| AC-E1 | 系统代理设置与还原 | C | **PASS（HEAD `f4085cf`）** | 15 组合逐项回基线；17:41 用户执行、17:42 复核 |
| AC-E2 | 代理残留恢复 | C | **PASS（HEAD `f4085cf`）** | recover 前 2081 → 后 2080，可判别 |
| P-4 | 二进制不早于源码（新准入） | 静态 | **通过** | 17:31 一度 ❌（源码 17:30:34 晚于二进制 17:28:04），重建后 ✅ |
| AC-B3 | 事件到达且无 `ai-` 前缀 | 脚本 | **PASS** | `check-contracts.mjs` 5 项通过、退出码 0、无 FAIL（18:56） |
| AC-B2 | 对话流式输出 | A | **PASS** | 回复分三段落库（19:09:32 / :33 / :37），中间夹工具调用，非一次性整段 |
| AC-B4 | 工具卡渲染与脱敏 | A | **部分 PASS** | 脱敏 ✅、审批卡内联渲染 ✅；工具卡完整态待 D-12/D-13 修复后复验 |
| AC-C1 ~ C5d | 审批语义与四态落库 | A | **待测** | 准入已通，可开跑 |
| AC-F1 / F2 | 对话落库与重启一致 | A | **PASS**（F1，`2dc223e`） | 19:06 重启后侧边栏显示 2 个历史会话，消息成对、顺序正确 |

**放行结论：未通过（仍在进行中）。** 准入 P-1/P-2/P-3 全 PASS；C 通道 8 条全 PASS；AC-B3、AC-F1、N-01 均 PASS；D-07/D-08 已修复验证。**剩余待判：AC-B2、AC-B4、AC-C1~C5d、AC-F2。**

### 执行者标注

| 用例 | 执行者 | 说明 |
|---|---|---|
| AC-B1 | 用户启动应用，Clerk 观察判定 | 通道 A |
| AC-D2 | **Clerk** | 纯单测，`cargo test archive`，不启进程不占端口 |
| AC-D1/D3/D5（e2e）、D4（fault）、D6 | **Clerk**（用户 17:21 授权） | 会启动 sing-box 并占用端口。按 PM 口径，正式验收仍应注明「预检」性质 |
| AC-E1 | **用户执行**，Clerk 采基线/终态并判定 | 17:41 执行（HEAD `f4085cf`）。Clerk 的 `proxy-enable` 被权限策略拦截，未绕过 |
| AC-E2 | **用户执行**，Clerk 采基线/终态并判定 | 同上 |
| P-1 / P-2 / P-3 | 待定 | 需用户在设置页与对话框操作 |

> 写清执行者不是形式主义：E1 能重跑成功，恰恰因为能精确说出「17:21 那次跑的是 16:57 的二进制」。

---

## 2. 缺陷

### D-01 代理还原不写回 server/port —— **HEAD 上的真实缺陷，已修复（17:24–17:27）并在当前构建验证 PASS**（归属 Bob）

> **口径说明**：D-01 **不是误报**。旧代码 `restore_one` 的判据 `setting.enabled && !server.is_empty() && port != 0` 确实只在 `enabled=true` 时才写回地址，关闭态只关开关 —— 描述的现象完全成立。错的不是判断，是**用 16:57 的旧二进制去验证 17:24 之后的新代码**。这两件事必须分开记，否则后来的人会误读成「测试误报了一次」。

- **发现时间**：17:21，跑的是 **16:57 构建**（`target/debug/veyl-runtime-selftest` 16:57，源码当时也是旧版）。
- **当时现象**：`proxy-disable` 后 `Enabled` 回到 `No`，但 `Server:Port` 停在 `127.0.0.1:2081`，未回到 `127.0.0.1:2080`。
- **当时根因**：旧版 `restore_one` 在 `enabled=false` 时只执行 `-setwebproxystate off`，`else` 分支不写回 `server`/`port`。
- **修复**：Bob 于 17:24–17:27 改写为 `plan_restore` + 无条件 `set_endpoint`（先写地址，再切开关）。
- **验证**：17:29 用当前构建（源码 17:27 / 二进制 17:28）重跑 AC-E1，5 服务 × 3 代理类型 × Enabled/Server/Port 共 15 个组合逐项回基线，**Port 从 2081 正确回到 2080**；AC-E2 同样 PASS。
- **结论**：**已修复并验证**。留下的教训是：跑 selftest 前必须确认二进制比源码新（已上升为准入检查 P-4）。

#### D-01b「启用但地址无效」的还原（**设计如此，不记缺陷**）

`plan_restore` 里 `enable = setting.enabled && has_endpoint`。备份若存到 `enabled: true / server: "" / port: 0`，恢复结果是 `No / "" / 0`。架构师确认这是有意为之（无效地址无法「还原」，只能关闭），故不记缺陷，仅记录在此备查。

### D-02 验收文档的备份文件名写错（**已由架构师修正**）

- `acceptance-p1.md` 原写 `proxy_backup.json`，实际是 `proxy-backup.json`（连字符，`src-tauri/src/proxy/backup.rs:77`）。17:35 已改。

### D-03 保存 Key 后不热更新，必须重启应用才生效（**中**，归属 Bob）→ **已在 `ab76ef2` 修复，待运行时验证**

- **发现**：2026-11-02 18:02，针对 **`f4085cf`** 构建。用户在设置页保存**真实** Key（之后对话仍报 `API error: [openai] Authentication failed: Authentication Fails (governor)`）。
- **当时根因**：`AppState::new`（`agent/mod.rs:28-34`）在应用启动时把 Key 读进 `credentials: RwLock<...>` 常驻内存；当时提供的 `set_credentials` **全仓库无调用方**，`deepseek_save_key` 只写钥匙串、不通知内存。应用 17:43:58 启动时读到的是 17:43:36 写入的**假** Key，18:01:49 保存的真 Key 只进了钥匙串 → 对话鉴权失败。用户看到的是「刚存了 Key 却说鉴权失败」，极易误判成 Key 本身有问题。
- **修复（`ab76ef2`）**：新增 `apply_credentials`，并在 `deepseek_save_key`（`agent/commands.rs:176`）、工具路径（`tools/services.rs:528`）、清除路径（`commands.rs:209`）调用；`credential_generation: AtomicU64` 让已建会话在下次取用时按新代数重建，旧 Key 不会被继续使用。
- **遗留小问题**：`commands.rs:175` 的注释仍写「钥匙串写成功后」，与新的 `secrets.enc` 方案不符，属文档性笔误。
- **验证状态**：代码已具备，**尚未在运行时验证**（需在新方案下复测：保存真 Key 后**不重启**直接对话应成功）。

### D-04（观察项）运行时日志文件始终为 0 字节
- `~/Library/Application Support/Veyl/logs/app-2026-11-02.log` 在应用启动 18 分钟后仍为 **0 字节**；`build/logs/dev-*.log` 里也没有任何 `veyl=` 前缀的应用日志，只有一条 macOS 输入法警告。
- 说明 `logging.rs` 虽有实现，但实际没有产出可观测的日志。**这会让后续所有缺陷排查失去日志依据**，建议 Bob 核实初始化是否被执行、默认级别是什么。
- 目前只是观察，未确认根因。

### D-05 用户消息不落库，只落助手消息（**高**，归属 Bob）→ **已在工作区修复，待提交**

- **发现**：2026-11-02 18:39，针对 **`ab76ef2`**。用户问「现在什么状态」，`chat_sessions` 建了 1 条、`chat_messages` 落 1 条，但**该条 `role = 'assistant'`**，用户那句提问没有入库。
- **当时证据**：

```
chat_messages:
  msg_18e434379af69d18  session_mvz4luwa_1  assistant  「当前状态：运行时处于 **idle** 状态…」
  （无 role = 'user' 的行）
```

- **当时根因**：`persist_committed_message`（`claurst_session/mod.rs:461`）只在收到 `QueryEvent::MessageCommitted` 时写库。该事件由 claurst 查询循环发出，只覆盖 `assistant_msg` / `results_msg` / `feedback`，**用户的输入消息不会触发该事件**。后果是重启后聊天记录只剩助手回答，用户的问题消失 —— **AC-F1 必然失败**。
- **修复（工作区，未提交）**：`ai_send_message` 入口（`agent/commands.rs:24-34`）直接落库 user 消息，注释写明「claurst 只对 assistant/results 发 MessageCommitted，不依赖事件补写，避免重复」。应用在 18:44:51 重建（二进制 18:44:54）。
- **修复后验证（18:54）**：

```
session_mvz4tzg9_1  你好
  user       你好
  assistant  你好，我是 Veyl 的助手。我可以帮你：…
```

user 与 assistant 两条都在，顺序正确。
- **版本边界**：本次验证跑的是**工作区代码**（相对 `ab76ef2` 有 3 个文件未提交改动）。D-05 在 HEAD `ab76ef2` 上仍然存在，提交后需要重新确认。

### D-06 时间戳单位与验收文档不一致，文档里的 SQL 全部失效（**中**，文档/实现双方）
- `tool_calls` / `chat_sessions` / `chat_messages` 的 `created_at` 存的是**毫秒**（例：`1793615964078`）。
- 而 `docs/acceptance-p1.md` §2 的所有证据 SQL 都写成 `datetime(created_at,'unixepoch','localtime')`，按**秒**解析 —— 结果是时间列**静默显示为空**，不会报错。
- 实测对照：

```
datetime(created_at,'unixepoch')        → （空）
datetime(created_at/1000,'unixepoch')   → 2026-11-02 18:39:24  ✅
```

- **后果**：测试人员按文档取证据时会看到空时间列，轻则困惑、重则误判「没有数据」。
- **建议**：二选一定死 —— 要么库统一存秒，要么文档 SQL 改成 `created_at/1000`。文档里所有依赖时间过滤的用例（AC-C1/C2/F1/F2 等）都受影响。

### D-08 历史会话不显示：前端从未调用 `chat_history`（**高**，归属 Alice）→ **已修复并验证（`2dc223e`），AC-F1 转 PASS**

- **现象**：2026-11-02 18:58，用户重启后左侧会话列表里看不到任何历史会话，尽管数据库里已有 2 个会话 / 5 条消息。
- **证据（数据库确实有数据）**：

```
session_mvz4luwa_1  18:39  1 msg
session_mvz4tzg9_1  18:54  4 msgs（user/assistant 成对）
```

- **根因**：后端 `chat_history` 命令（`agent/commands.rs:140`）已实现，会返回 `sessions` / `active_session_id` / `messages`；但**前端从未调用它** ——
  - `src/agent/tauriBridge.ts` 暴露的命令只有 `runtime_status`、`ai_send_message`、`ai_send_approval`、`deepseek_key_status`、`deepseek_save_key`，**没有 `chat_history`**
  - `src/state/chatStore.ts:107` 的 `createInitialState()` 永远返回 `{ sessions: [createSession()] }`，即一个全新空会话
  - 全仓库 `grep -rn chat_history src/` 无命中
- **后果**：每次启动侧边栏只有一个新会话，历史对话永远不可见。**AC-F1「重启后会话列表里是否还有这个会话」直接失败**；AC-F2 也无法验证。
- **修复建议**：应用启动时调用一次 `chat_history`，用返回的 `sessions` 覆盖初始状态、用 `active_session_id` 选中最近会话、并加载该会话的 `messages`。

### N-02 复制 AI 输出按钮（**新增需求，待 PM 决策**）

- **提出**：2026-11-02，用户要求「增加一个复制当前 AI 输出的按钮，参考 TweetPilot 的复制按钮」。
- **现状**：前端完全没有复制能力 —— `grep -rni 'copy|复制|clipboard' src/` 零命中。
- **建议位置**：`MessageItem.tsx:37` 的 `msg__role` 行右侧，与 `msg__usage`（token 计数）同一行。这一行目前已有头像、流式指示、token 数，是天然的操作区。
- **建议规格**（供 Alice 参考，以架构师定稿为准）：
  - 只对 `role === "assistant"` 的消息显示
  - 复制内容为**该条消息的纯文本 / Markdown 原文**，不含工具卡与耗时
  - 点击后短暂显示「已复制」，约 1.5–2 秒恢复
  - `message.streaming === true` 时禁用，避免复制到半截内容
  - 系统消息（`msg--system`，含错误）不提供
- **待确认**：TweetPilot 的复制按钮具体交互（hover 显示 / 常驻图标 / tooltip 文案）需 Alice 参考原项目，测试人员无从判断视觉一致性。

### N-01 会话标题可编辑（**新增需求，已实现并验证**）

- **提出**：2026-11-02，用户提出「应该允许修改历史对话的标题」。
- **查证**：`docs/phase-1-requirements.md` 与 `docs/contracts/` 里原本**没有任何关于会话重命名的需求条目**，代码也无相关接口。经 PM 决策纳入，由 Alice 在 `2dc223e` 实现（`rename_session` 命令 + 侧边栏改名入口，契约升级到 1.0.7）。
- **验证（19:07，`2dc223e`）**：

| 用例 | 期望 | 结果 |
|---|---|---|
| 正常改名 | 成功 | ✅ 标题改为「测试」「测试二」 |
| 空标题 | 拒绝，`标题不能为空` | ✅ |
| 超过 80 字符 | 拒绝，`标题最多 80 个字符` | ✅ |
| 重启后新标题仍在 | 保持 | ✅ 库里 `title` 为「测试」「测试二」，重启后界面一致 |

- **实现校验**：`normalise_title`（`agent/commands.rs:239`）先 trim 再判空、再按 `MAX_TITLE_CHARS = 80`（`commands.rs:234`）判长度，超限返回 `INVALID_ARGUMENT` + `details.reason = "title_too_long"`。
- **附带发现（与 D-05 相关）**：`session_mvz4luwa_1` 原来自动标题是「当前状态：运行时处于 \*\*idle\*\* 状态（未连接），si…」—— 因为它建会话时用户消息还没落库（D-05），首条消息是助手回复，标题取到了助手的话。D-05 修复后新会话标题改取用户消息；已有历史可用改名入口自行修正。

### D-09 默认目录服务端口指向 18080，与 mock 的 catalog 端口 18090 不一致（**中**，归属 Bob）

- **现象**：2026-11-02 19:09 用户发「连到日本」，`CatalogSearch` 连续失败两次：

```
CatalogSearch is_error=1  UPSTREAM_ERROR: catalog transport: error sending request
  for url (http://127.0.0.1:18080/v1/catalog/nodes?region=jp&limit=10)
CatalogSearch is_error=1  ... (http://127.0.0.1:18080/v1/catalog/nodes?region=jp)
```

- **根因**：`DEFAULT_CATALOG_URL = "http://127.0.0.1:18080/v1"`（`src-tauri/src/lib.rs:24`），而 `tests/run-mocks.sh` 里 **catalog 跑在 18090**、**echo 才在 18080**。默认值指到了另一个服务的端口上。
- **覆盖链**：`VEYL_CATALOG_URL` 环境变量 > `settings.catalog_base_url` > 默认值（`lib.rs:26-38`）。所以可绕过，但默认值是错的。
- **后果**：不额外配置时，任何依赖目录的功能（`CatalogSearch`、以及后续 `ProfileImport`/`VpnConnect`）都会失败。**流程走不到 `CoreInstall`，也就走不到审批 —— AC-C1/C2/C3/C5 全部被卡住。**
- **建议**：默认值改成 18090，或让 `run-mocks.sh` 的 catalog 用 18080 并与 echo 分离端口。二者定一个，别让默认值和 mock 编排各说各话。

### D-10 目录服务设备注册未接线，`CatalogSearch` 必然 401（**阻断 AC-C 组**，归属 Bob）

- **现象**：把目录地址改到正确的 18090 后，mock catalog 仍拒绝请求：

```
GET /v1/catalog/nodes?region=jp&limit=10  →  401  {"error":"invalid_device_token"}
```

- **根因**：`CatalogClient` 需要 `Authorization: Bearer <device_token>`（`tests/mock-catalog/server.mjs:92` 校验），客户端也具备完整能力 —— `register_device`（`catalog/client.rs:158`）、`set_token`、`with_token`、`secrets::get_device_token`（`secrets/mod.rs:299`）都存在。但**全部没有调用方**：

```
grep -rn 'set_token\|with_token\|get_device_token' src-tauri/src/ | grep -v 'fn '
→ 空（除定义外零命中）
grep -rn 'register_device' src-tauri/src/ | grep -v 'fn register_device'
→ 空
```

- **后果**：应用永远不会去 `POST /v1/devices` 换取令牌，也不会把已存的令牌注入客户端，因此 `CatalogSearch` 恒为 401 → `ProfileImport` / `VpnConnect` 无从触发 → **`CoreInstall` 审批不出现 → AC-C1/C2/C3/C5a~d 全都无法执行**。
- **与 D-03/D-08 同一类问题**：能力已实现，但没有接到调用链上。
- **建议**：首次使用时若 `secrets::get_device_token()` 为空则调 `register_device` 并把 token 写入 `secrets.enc`；启动或首次请求时用 `set_token` 注入。

### D-11 mock catalog 返回字段与契约不一致，修好 D-10 也会失败（**中**，归属 Bob）

- **发现**：PM 复核 D-10 时发现，测试人员已核实。
- **证据**：`tests/mock-catalog/server.mjs:85` 返回 `{ device_id: id, token }`；而契约 §2.1 与客户端 `RegisterDeviceResponse`（`catalog/client.rs:79-88`）都要求 `device_token`。
- **后果**：即使把 D-10 的注册接线补上，`serde` 反序列化 `RegisterDeviceResponse` 时会因缺 `device_token` 而失败，**修复会白做**。
- **决定（PM）**：改 mock，不改客户端 —— 契约是准绳。
- **连带提醒**：D-10 + D-11 必须一起修，只修一个仍然无法取到令牌。

### D-12 `CatalogSearch` 只把「找到 N 个节点」交给模型，节点详情丢失（**高**，归属 Bob）

- **证据**：19:26 两次 `CatalogSearch` 的 `result_json` 都是 `"找到 5 个节点。"`，模型在 `AskUserQuestion` 里明确说：「查询结果没带回节点详情（id、延迟等只显示条数），我这边拿不到可以确认的节点 id」。
- **根因**：`src-tauri/src/tools/catalog.rs:73` —— `ToolOutcome::ok(format!("找到 {count} 个节点。"), data)`，结构化 `data` 没进模型可读的 content。
- **后果**：模型无法拿到真实 `node_id`，只能**凭空猜** `"jp-1"` 再调用 `VpnConnect`。后续 `VpnConnect` / `ProfileImport` 都会因节点不存在而失败，AC-B4 与整条连接链路无法成立。
- **建议**：content 里带上节点摘要（id、region、protocol、延迟），或至少列出 id 列表。

### D-13 模型收到 `APPROVAL_REQUIRED` 后立即用 `approval_id` 重试，导致重复审批卡（**高**，归属 Bob）

- **证据**：19:26:33 `VpnConnect` 被拦截（`APPROVAL_REQUIRED`）→ 1 秒后 19:26:35 模型又发了一次 `VpnConnect`，参数里带着 `{"approval_id":"6d2b3a5b-…"}`，结果**仍是同一个错误**。用户因此看到**两张一模一样的审批卡**，并反馈「有重复的内容出现」。
- **根因**：审批门在 `tools/policy.rs:225-239` 返回 `APPROVAL_REQUIRED` 并把 `approval_id` 放进 `details`，但**没有任何机制让模型知道「应当停下来等用户决定」**。模型把它当成可重试的普通错误，立刻带着 id 重放，而用户此时还没点任何按钮，`resolve()` 自然失败，于是再弹一次。
- **对照**：`policy.rs` 的测试（`approval.rs:381`）假设「先 resolve 再重试」，真实流程里模型抢先重试，这个假设不成立。
- **建议**：`APPROVAL_REQUIRED` 的 content 明确写「已向用户发出审批请求，请停止本轮，等待用户决定后再继续」；或在 Host 侧收到该错误时直接结束 turn，不把控制权交回模型。

### D-14 被审批拦截的工具调用落库为 `approved = NULL`，与契约语义冲突（**中**，归属 Bob）

- **证据**：两次 `VpnConnect` 都是 `approved = NULL`、`is_error = 1`，而 `VpnConnect` 的策略是 `first_time_per_session`，**属于需要审批的工具**。
- **冲突**：契约（`store/tool_calls.rs` 表注释、`docs/contracts/tools.md`）定义 `NULL = 该工具不需要审批（只读或策略为 never）`，且明确「不能用 1 冒充」。把「已拦截等待用户决定」也记成 `NULL`，会让 AC-C5 的四态判定失真 —— 与 `RuntimeStatus` 的 `NULL` 无法区分。
- **建议**：为「已拦截、用户尚未决定」引入明确表示（如 `approved` 保持 NULL 但 `is_error=1` 且 result 标注 `APPROVAL_REQUIRED`，并写入契约说明），或先落一行 `0` 再在放行后更新。**必须落到契约里**，否则验收无法判。

### D-07 发送消息后输入框消失（**阻断 AC-B2/B4/C/F**，归属 Alice）→ **已修复并验证（`2dc223e`）**

- **发现**：2026-11-02 19:00，用户在 Tauri 窗口发「你好，介绍一下你自己」后，**输入框不可见**，无法继续对话。
- **已排除**：`Composer` 在 `ChatView` 里是**无条件渲染**（`ChatView.tsx:83`），组件内部也没有按 `streaming` 隐藏 `textarea` 的分支（`streaming` 只影响「停止」按钮和「发送」按钮的 disabled）。所以不是逻辑隐藏。
- **可疑点（布局）**：

```css
.app    { display: grid; height: 100vh; overflow: hidden; }   /* 单隐式行，auto 高度 */
.sidebar{ min-height: 0; }        /* 有 */
.main   { min-width: 0; }         /* 只有 min-width，缺 min-height: 0 */
```

`.main` 是网格子项，缺 `min-height: 0` 时其最小高度按内容计算；一旦消息撑高内容，`.main` 会超出 `100vh`，而 `.app` 的 `overflow: hidden` 把底部（Composer 所在位置）裁掉。
- **待确认**：需要用户在窗口里观察——
  1. 输入框是彻底不见，还是被切掉一半？
  2. 窗口拉高后输入框是否重新出现？
  3. 消息区能否正常滚动？
- **状态**：**已修复并验证（`2dc223e`）**。2026-11-02 19:10 用户在 **1200×800** 与 **900×600** 两档窗口下各发消息，输入框始终可见。
- **修复**：`.app { grid-template-rows: minmax(0, 1fr); }` + `.main { min-height: 0; }`。
- **历史**：修复前（`f4085cf`~`ab76ef2`）发完消息输入框即不可见，重启可临时恢复，属运行期布局塌陷而非状态损坏。

---

## 3. 证据

### AC-B2 — 流式输出 → **PASS**

用户发「连到日本」后，助手的一条回答在库里被拆成**三段**，时间戳本身即证据：

```
assistant [19:09:32]  我先查看当前运行状态和可用的日本节点。
assistant [19:09:33]  节点目录查询失败了：本地目录服务（127.0.0.1:18080）没响应…
                      我重试一次目录查询，确认是不是偶发问题。
assistant [19:09:37]  目前还连不上日本节点，原因有两个，都与节点本身无关：…
```

三段之间夹着 4 次工具调用，说明文本是**随工具执行分段产出**的，不是结束时一次性整段返回。对照 AC-B2 的失败判定「一次性整段出现（流式失效）」，本条不成立。

**附带确认（诚实性）**：回复中明确写「没有目录数据，我就无法提供节点，**也不会自己编造节点**」，并区分了「`DiagRun` 报告通过但只覆盖控制面」与目录错误。没有把失败包装成成功，符合契约对错误汇报的要求。

> 说明：本条回答的内容受 D-10 影响（目录 401，流程未走完），但**流式这一维度是独立可判的**，不与 D-10 混为一谈。

### AC-B4 — 工具卡与脱敏 → **部分 PASS**（渲染与脱敏已判，工具卡细节待 D-12/D-13 修复后复验）

| 子项 | 结果 | 证据 |
|---|---|---|
| 参数脱敏 | **PASS** | 六次调用的 `args_json` 均无 `uuid` / `password` / `key`：`{"include_traffic":false}`、`{"region":"jp"}`、`{"limit":5,"region":"jp"}`、`{"node_id":"jp-1","strategy":"latency"}`、`{"include_logs":true}`、`{"lines":100}` |
| 审批卡渲染 | **PASS**（19:26） | 内联在对话流中，**不遮罩界面**；含 `需要你的确认` / `高风险` / 工具名 `VpnConnect` / 摘要「连接到节点 jp-1」/ 范围说明「仅对当前会话有效，新会话会重新确认」/ 两个按钮「允许（本会话内不再询问）」「拒绝」 |
| 工具卡渲染（名称/状态/耗时） | 待复验 | 已见 `CatalogSearch region=jp 1ms 失败` 形式的内联卡片；完整态需 D-12/D-13 修复后串起正常流程再判 |

> 按 PM 口径：D-13 修好后重测的是「只弹一张卡」和「模型不再自动重试」，**不重复验渲染**。

### AC-D1 / D3 / D5 — e2e

命令：`./src-tauri/target/debug/veyl-runtime-selftest e2e --data-dir /tmp/veyl-accept`
日志：`build/logs/ac-d1.log`

```
[2] download → sha256 → extract → install
    binary: /tmp/veyl-accept/runtime/1.14.4/sing-box-1.14.4-darwin-arm64/sing-box
[3] building the client config
[4] sing-box check → activate
[5] starting the runtime
    state: running            pid: 53642
[6] probing the clash api
    /version → sing-box 1.14.4
[7] stopping the runtime
    state: idle
[8] re-listing the install state
    active version: 1.14.4
E2E PASSED
```

紧随其后：`pgrep -fl sing-box` → 无进程（D3 的「结束后清理干净」成立）。

### AC-D2 — 归档路径穿越

命令：`cargo test --manifest-path src-tauri/Cargo.toml archive`

```
running 6 tests
test runtime::archive::tests::rejects_symlink_escaping_the_root ... ok
test runtime::archive::tests::rejects_absolute_entries ... ok
test runtime::archive::tests::rejects_parent_traversal ... ok
test runtime::archive::tests::accepts_a_flat_archive ... ok
test runtime::archive::tests::rejects_zip_traversal ... ok
test runtime::archive::tests::accepts_a_zip_with_nested_dir ... ok
test result: ok. 6 passed; 0 failed
```

`..`、绝对路径、symlink 逃逸、zip 穿越四条负向用例都在。

### AC-D4 — 故障注入

命令：`veyl-runtime-selftest fault --data-dir /tmp/veyl-fault`
日志：`build/logs/ac-d4.log`

```
[1] 启动假 sing-box（2 秒后自杀）
    state: running
[2] 等待重启预算耗尽
[3] 校验失败状态与重启次数
    state=failed restart_count=2 last_error=Some("process exited with exit status: 1")
    restarting events: 2
FAULT INJECTION PASSED
```

重试预算有限，退避后进入 `failed`，没有无限重启。

### AC-D6 — Clash API 监听面

手动用 e2e 装好的 runtime 起 sing-box（e2e 第 7 步会停掉，不能直接在 e2e 后 `lsof`）：

```
COMMAND    PID   USER   FD   TYPE   NAME
sing-box 53876 wesley   10u  IPv4   TCP 127.0.0.1:58080 (LISTEN)
sing-box 53876 wesley   11u  IPv4   TCP 127.0.0.1:50986 (LISTEN)

无secret: 401
有secret: 200

sing-box 日志：clash-api: restful api listening at 127.0.0.1:50986
```

两个监听都在 `127.0.0.1`，不是 `0.0.0.0`；无 secret 被拒。采集完已 `kill`，`pgrep -fl sing-box` 为空。

### AC-E1 — 代理设置与还原 → **PASS（HEAD `f4085cf`）**

**构建**：二进制 17:31:53（P-4 ✅，晚于全部 `src-tauri/src/**/*.rs`），HEAD `f4085cf`。

**执行**：17:41 由**用户**执行（测试人员的 `proxy-enable` 被本会话权限策略拦截，见 §4 第 4 条）。

**① 基线（17:40:47，测试人员采集）**

| 服务 | http | https | socks |
|---|---|---|---|
| USB 10/100/1000 LAN | `No / 127.0.0.1:2080` | 同左 | 同左 |
| Thunderbolt Bridge | `No / (空):0` | 同左 | 同左 |
| Wi-Fi | `No / 127.0.0.1:2080` | 同左 | 同左 |
| iPhone USB | `No / 127.0.0.1:2080` | 同左 | 同左 |
| MeshFlux | `No / 127.0.0.1:2080` | 同左 | 同左 |

**② `proxy-enable --port 2081`**（用户执行）

```
enabled on port 2081
{"platform":"macos","current":"127.0.0.1:2081","endpoint":"127.0.0.1:2081","has_backup":true}
```

`current` 字段成立的前提是有服务 `enabled && port != 0`，即 enable 确实生效。

**③ `proxy-disable`**（用户执行）

```
disabled
{"platform":"macos","current":null,"endpoint":null,"has_backup":false}
```

**④ disable 之后的系统状态（17:42:01，测试人员复核）**

```
USB 10/100/1000 LAN    webpr=No 127.0.0.1:2080  secur=No 127.0.0.1:2080  socks=No 127.0.0.1:2080
Thunderbolt Bridge     webpr=No (空):0          secur=No (空):0          socks=No (空):0
Wi-Fi                  webpr=No 127.0.0.1:2080  secur=No 127.0.0.1:2080  socks=No 127.0.0.1:2080
iPhone USB             webpr=No 127.0.0.1:2080  secur=No 127.0.0.1:2080  socks=No 127.0.0.1:2080
MeshFlux               webpr=No 127.0.0.1:2080  secur=No 127.0.0.1:2080  socks=No 127.0.0.1:2080
```

与 ① 逐项一致 —— 5 服务 × http/https/socks × Enabled/Server/Port，**15 个组合全部还原**，含此前的失败点 Port（2081 → 2080）。

> **关于「disable 后」这一状态的取法**：用户是把四条命令连续跑完的，17:42:01 采集到的已是 E2 recover 之后的状态。之所以仍能判定 E1，是因为存在一条可闭合的推理链 ——
> 基线 2080 → E1 enable 写 2081 → E1 disable 得到 **X** → E2 enable 时把 **X** 写进备份 → E2 recover 还原 **X** → 终态实测 2080。
> 终态是 2080，则 **X 必为 2080**，即 E1 的 disable 确实把地址写回了；否则 E2 的备份会记下 2081，recover 后终态就会是 2081。
> 这条链成立的前提是我在 17:40:47 独立采到了基线、在 17:42:01 独立采到了终态，两次都由测试人员执行、不依赖转述。

判 **PASS**。

**Thunderbolt Bridge 单列**：基线 `No / (空):0`，终态 `No / (空):0`，一致。

> **覆盖缺口（PM 已定：记录不补测）**：`incomplete` 分支（备份 `Enabled: Yes` 但无地址 → 保持开启 + `log::warn!`）本轮未端到端执行，因为 TB 基线是 `No`。见 §4 第 3 条。

#### 历史记录：17:29 的上一轮（构建 17:28:04）

同一套操作在 17:28:04 构建上也跑过一轮，结论相同（15 组合回基线）。但该轮跑完后源码又改了三次（`lib.rs` 17:29:04、`logging.rs` 17:30:43、`macos.rs` 17:30:34，即提交 `f0d232b`），由 P-4 检查发现，因此当时只记为「对 17:28 构建成立」。经核对，两版在 `restore_one` 上的差异只在 `incomplete` 分支的告警实现（`eprintln!` → `log::warn!`），而本轮 TB 走的是 `clear` 分支，两版行为一致。

17:27 还跑过一个更早的 17:26 构建版本，那时 TB 从 `Yes / (空):0` 变成 `No / (空):0`——那是该版 `enable = enabled && has_endpoint` 的设计行为，正是 D-01b 要改的点。

### AC-E2 — 代理残留恢复 → **PASS（HEAD `f4085cf`）**

**构建**：同 AC-E1（二进制 17:31:53，P-4 ✅，HEAD `f4085cf`）。
**执行**：17:41 由**用户**执行；备份与终态由测试人员独立采集。

**① `proxy-enable --port 2081`，不还原，模拟异常退出**

```
enabled on port 2081
{"platform":"macos","current":"127.0.0.1:2081","endpoint":"127.0.0.1:2081","has_backup":true}
```

此时系统停在 `127.0.0.1:2081`，`/tmp/veyl-proxy/proxy-backup.json` 已写入，等待下次启动恢复。

**② `proxy-recover`**

```
recovered from 127.0.0.1:2081
```

退出码 0，`/tmp/veyl-proxy/` 在 17:41 清空（备份已消费）。

**③ recover 后系统实际状态（17:42:01，测试人员采集）**

```
USB 10/100/1000 LAN    webpr=No 127.0.0.1:2080  secur=No 127.0.0.1:2080  socks=No 127.0.0.1:2080
Thunderbolt Bridge     webpr=No (空):0          secur=No (空):0          socks=No (空):0
Wi-Fi                  webpr=No 127.0.0.1:2080  secur=No 127.0.0.1:2080  socks=No 127.0.0.1:2080
iPhone USB             webpr=No 127.0.0.1:2080  secur=No 127.0.0.1:2080  socks=No 127.0.0.1:2080
MeshFlux               webpr=No 127.0.0.1:2080  secur=No 127.0.0.1:2080  socks=No 127.0.0.1:2080
```

与 17:40:47 的基线**逐项一致**：4 个服务 `No / 127.0.0.1:2080`，Thunderbolt Bridge `No / (空):0`。

关键是这条**可判别**：recover 之前系统是 `127.0.0.1:2081`（enable 刚写入），recover 之后是 `2080`。地址确实被写回了，不是「本来就没动」。若 recover 只是关掉开关而不写地址，终态会是 `2081`。

判 **PASS**。

#### 历史记录：17:29（构建 17:28:04）与 17:22（更早的旧构建）

17:29 在 17:28:04 构建上跑过同一流程，`recovered from 127.0.0.1:2081`，备份内容为 4 服务 `false/127.0.0.1/2080` + TB `false/''/0`，恢复后逐项一致，同样可判别。

17:22 那轮跑在更早的旧构建上，`recovered from` 同样成立，但当时系统已停在 2081（被 E1 的旧 D-01 残留污染），前后不可判别，故当时记为「待复测」。两轮均已由 HEAD 的这次重跑取代。

---

## 范围变更（2026-11-02 19:35，用户决定）

**用户决定：彻底移除审批机制，所有工具默认放行。**

### 作废的验收项

| 项 | 原状态 | 变更后 |
|---|---|---|
| AC-C1 首次弹卡、允许后放行 | 阻断级 | **作废** |
| AC-C2 拒绝后仍会弹 | 阻断级 | **作废** |
| AC-C3 `CoreInstall` 每次都弹 | 阻断级 | **作废** |
| AC-C5a 拒绝 → `approved=0` | 阻断级 | **作废** |
| AC-C5b 允许一次 → `approved=1` | 阻断级 | **作废** |
| AC-C5c 会话放行 → `approved=2` | 阻断级 | **作废** |
| AC-C5d 只读工具 → `approved IS NULL` | 阻断级 | **恒为真**（所有工具都不需审批，`NULL` 成为唯一取值） |
| D-13 模型收到 APPROVAL_REQUIRED 后重试 | 高 | **作废**（不再有该错误） |
| D-14 被拦截的调用落库 NULL | 中 | **作废** |

### 需要连带修改的资产

- `docs/contracts/tools.md`：34 处审批相关定义（`ApprovalPolicy`、`approval_id`、审批矩阵、§2.5 等）
- `docs/test-cases/02-exception.md`：11 条审批用例
- `src-tauri/src/tools/policy.rs`：策略判定与审批门
- `src/components/ApprovalCard.tsx` + `ai_approval_decision` 命令 + 前端协议
- `tool_calls.approved` 列：建议**保留列**（避免 schema 回退），但取值恒为 `NULL`

### 测试人员的意见（供 PM 参考，不构成决定）

1. **风险**：`ProfileDelete`（删除配置）、`VpnConnect`（改系统代理）、`CoreInstall`（下载可执行文件）都会变成无确认执行。用户误触或模型误判时没有拦截点。
2. **建议保留列与契约章节**：即使不做 UI，也建议在契约里保留 `approved` 字段定义并注明「P1 恒为 NULL」，否则将来恢复审批时要再改一次 schema。
3. **AC-C5d 可以保留**：它验的是「不需要审批的工具记 NULL」，移除审批后仍然成立，可作为回归项。
4. 本变更**缩小 P1 范围**，放行标准需要 PM 重新确认。

---

## 4. 遗留问题

0. **~~HEAD `f4085cf` 上重跑 E1/E2~~ —— 已闭环（17:41 用户执行，17:42 测试人员复核 PASS）**

   测试人员的 `proxy-enable` 在 17:31 与 17:40 两次被本会话权限策略拦截（`[Modify Shared Resources]`），按约定未重试试探、未改写命令绕过，改由用户执行四条命令。P-4（二进制 17:31:53 晚于全部源码）由测试人员先行确认，基线与终态均由测试人员独立采集，判定见 AC-E1 / AC-E2 小节。

1. **P-1 待运行时复测**：设置页与后端命令已接线（见 §5），但未做运行时验证。A 通道 B/C/F 组仍无法开始。
2. **C4 `ProfileDelete` 审批、F1 删除 active profile、E3 出口 IP、Hysteria2、9.5 连接成功率**：仍无入口/无环境，见 `acceptance-p1.md` §5。
3. **覆盖缺口（PM 已定：记录不补测）**：`restore_one` 的 `incomplete` 分支（备份 `Enabled: Yes` 但无地址 → 保持开启 + stderr 告警）本轮未端到端执行，因为 Thunderbolt Bridge 的基线已是 `No / (空):0`。要触发必须手工把该服务置为 `Yes / 空 / 0`，等于为测一个语义上就无效的边界去污染整机网络配置，收益不抵风险。**决定：保留单测 `an_enabled_backup_without_an_endpoint_is_kept_on_and_flagged` 覆盖，端到端留缺口并在本报告留痕；该段代码日后有改动时再补。**
4. **流程教训**：跑 selftest 前必须确认 `target/debug/veyl-runtime-selftest` 比源码新，否则测的是历史版本。17:21 那轮的 D-01 判定就是这么来的 —— 开发与测试并行改代码时极易再犯。
5. **系统代理当前已回到基线**，无需再手工还原。
6. **已知偏差（PM 已接受，不阻塞）：日志单次运行跨午夜不换文件**。Bob 的 logger 在进程持续运行跨过 00:00 后，仍写入启动当天那个文件，不会切到新日期的文件。影响：跨午夜的长跑会话日志归档会落在前一天。PM 按已知偏差接受，记录在案，以后修。

### Thunderbolt Bridge 备注

- 17:25 前后曾出现 `Enabled: Yes / Server 空 / Port 0` 的异常态，成因未定位。
- 17:27 起实测为 `No / (空):0`，17:29 两轮均以它为稳定基线。
- 在当前代码的三档语义下：`No + 无地址` → 清空地址 + 关闭，**保持 No**；若将来出现 `Yes + 无地址` → 保持开启 + 告警。
- **不影响 E1/E2 判定。**

---

## 5. P-1 复测> **⚠️ 方案已更换，17:43 那轮证据作废。** `ab76ef2` 把密钥存储从 macOS 钥匙串整体改为机器绑定的本地加密文件 `secrets.enc`（AES-256-GCM，PBKDF2 10 万次，`grep -r keyring src-tauri/` 已为空）。下面的 17:43 记录保留作历史，**新的判定要点见 §5.2**。

### 5.1 历史：17:43 旧方案（钥匙串）—— 已作废

17:12 判 P-1 为「功能未实现」时，设置页无入口、后端无命令。17:30 静态复核发现三项都已补齐，17:43 用户在 Tauri 窗口里完成运行时复测。

| 检查点 | 17:12 | 17:30 静态 | 17:43 运行时 |
|---|---|---|---|
| 设置入口 | 按钮无 `onClick` | `onClick={onOpenSettings}` | 点击可打开设置页 ✅ |
| 后端命令 | `invoke_handler` 无 Key 命令 | 已注册两条 | — |
| 前端调用 | 无 | `tauriBridge.ts:92,106` | — |
| 假 Key 保存 | — | — | 写入钥匙串 + 明确警告无效 ✅ |
| 重启后保持 | — | — | 仍存在 ✅ |

实现路径：`agent::commands::deepseek_save_key` → `secrets::save_deepseek_key`（`src-tauri/src/secrets/mod.rs:135`），工具路径 `tools/services.rs:517` 复用同一个函数。

### 证据

**① 假 Key（`sk-fakefakefakefakefake1234`）的界面提示原文**

> Key 已写入本机钥匙串，但 DeepSeek 鉴权失败（可能无效或已被吊销）。请重新输入一个有效的 Key。

逐条对齐 `docs/contracts/tools.md` §4.15：

| 契约要求 | 实际表现 |
|---|---|
| `saved: true`（Key 已写入钥匙串，无论验证是否通过） | 提示「已写入本机钥匙串」✅ |
| `validation: "invalid"` 时必须**明确告知**，不得说「已成功配置」 | 提示「鉴权失败（可能无效或已被吊销）」✅ 未出现「配置成功」字样 |
| `content` 与 `validation` 一致 | 一致 ✅ |

**② 钥匙串（只读查存在性，未读取 Key 内容）**

```
"acct" = "deepseek_api_key"
"svce" = "io.github.aiwithblockchain.veyl"
"cdat" = "2026-11-02T09:43:36Z"    ← 本地 17:43:36，与保存动作吻合
"mdat" = "2026-11-02T09:43:36Z"
```

重启后（17:43:58，新进程 PID 68604）再次查询：条目仍存在，`mdat` **未变化** —— 说明重启路径是读回，没有重新写入。

**③ 空值与格式非法**

用户确认两项均被拒绝、测试通过。**提示原文未逐字留存**，这是本次记录的证据缺口；按契约 §4.15 的 `minLength: 20`，`abc123` 应在 schema 层被拒。

### 5.2 现行方案：`ab76ef2` 本地加密存储 —— **待复测**

**代码核对（18:12，静态）**

| 检查点 | 状态 |
|---|---|
| `keyring` 依赖与调用 | ✅ 已完全移除（`grep -rn keyring src-tauri/` 为空） |
| 存储位置与格式 | `<data_dir>/secrets.enc`，0600，AES-256-GCM，PBKDF2-HMAC-SHA256 10 万次，写入走临时文件 + fsync + rename |
| `__verify` 双失败区分 | ✅ 单条损坏 → 删该条保留其余；`__verify` 解不开 → 保留文件仅报错 |
| 保存后热更新内存 | ✅ `apply_credentials` 在 `commands.rs:176`、`services.rs:528`；`credential_generation` 让旧会话失效 |

**判定要点（在原三态之外新增两条，PM 指定）**

| # | 要点 | 期望 |
|---|---|---|
| 1 | 保存/读取全程无 macOS 密码授权弹窗 | **不得出现任何系统密码框** |
| 2 | `~/Library/Application Support/Veyl/secrets.enc` | 存在、权限 `0600`、内容为密文（搜不到明文 Key） |
| 3 | 空值保存 | 拒绝 |
| 4 | `abc123`（<20 字符） | 拒绝 |
| 5 | 假 Key | 提示「校验失败」，**不得**出现「配置成功」 |
| 6 | 真 Key 保存后**不重启**直接对话 | **应成功**（验证 D-03 的修复） |
| 7 | 重启后打开设置 | 仍显示已保存 |

> 要点 6 是本次新增的关键项：它同时验证 D-03。旧方案下这一项是失败的。
>
> 17:43 旧方案下「空值 / 格式非法 被拒绝」当时由用户口头确认、未留存提示原文，本轮请留意原文。

**已知残留（建议收尾处理）**：迁移到 `secrets.enc` 后，**系统钥匙串里的旧条目没有被清理**。18:12 实测 `io.github.aiwithblockchain.veyl / deepseek_api_key` 仍存在，`mdat` = 2026-11-02 18:01:49Z —— 即 18:01 保存的**真实 Key** 仍留在钥匙串里。新方案不再读它，但任何能访问该钥匙串条目的进程仍可取到。
建议顺序：先确认新方案读写正常，再删除旧条目（`security delete-generic-password -s io.github.aiwithblockchain.veyl -a deepseek_api_key`），避免先删导致真 Key 丢失。

**18:43 实测（新方案已跑起来）**

```
-rw-------  211  Nov 2 18:39  ~/Library/Application Support/Veyl/secrets.enc
grep -a 'sk-' secrets.enc  → 未命中
文件结构: {"version": 0, "__verify": "<base64 密文>"}
应用进程启动时间: 18:38:30
```

| 判定要点 | 结果 | 证据来源 |
|---|---|---|
| 文件存在、权限 0600 | ✅ | 测试人员实测 |
| 内容为密文、无明文 Key | ✅（`sk-` 未命中；文件为 `version` + `__verify` 两项的密文 JSON） | 测试人员实测 |
| 保存后**不重启**即生效（D-03） | ✅ 应用 18:38:30 启动，`secrets.enc` 18:39 才创建，随后对话成功 | 测试人员实测 |
| 全程无 macOS 密码弹窗 | ✅ | **用户确认**（无截图） |
| 空值保存被拒 | ✅ | **用户确认**（提示原文未留存） |
| `abc123` 被拒 | ✅ | **用户确认**（提示原文未留存） |
| 假 Key 提示「校验失败」且不说「配置成功」 | ✅ | **用户确认**（提示原文未留存） |
| 重启后仍显示已保存 | ✅ | **用户确认** |

**结论：P-1 PASS。**

**证据质量说明**：文件层（权限、密文、热更新生效）由测试人员独立实测；UI 五项由用户口头确认，**提示原文未逐字留存**，属本次记录的证据缺口。若后续需要更严格的留痕，可重跑一次并截图。

> 旧钥匙串方案（17:43）曾判 PASS，因方案整体更换已作废；但那轮的提示原文「Key 已写入本机钥匙串，但 DeepSeek 鉴权失败…」仍可作为 `validation: invalid` 分支的参考，新方案下用户确认表现一致。

---

## 6. P-2 / P-3 复核（17:33，静态 + 只读 SQL）

17:12 判定「工具调用不落库、对话不落库」时，`store/tool_calls.rs` 与 `chat_*` 都没有调用点。17:33 复核，写入路径都已接上：

| 路径 | 调用点 |
|---|---|
| `tool_calls::begin` | `src-tauri/src/claurst_session/mod.rs:435` |
| `tool_calls::finish` | `src-tauri/src/claurst_session/mod.rs:453` |
| `tool_calls::record_approval_for` | `tools/policy.rs:303`、`agent/commands.rs:73` |
| `chat::append_message` | `src-tauri/src/claurst_session/mod.rs:491` |
| `store/chat.rs` 模块 | 存在，`ensure_session` / `append_message` / `list_sessions` / `messages` / `latest_session` / `delete_session` |

**数据库当前基线（17:33，只读）**：

```
tool_calls     0
chat_messages  0
chat_sessions  0
```

三项全为 0 —— 说明此前从未落过库，这也正好是一个干净的起点：走完 P-2/P-3 后，计数应变为 ≥ 1，无需按时间戳过滤历史数据。

**结论：P-2 / P-3 的阻塞点同样已从代码层面消除，但未做运行时验证。** 仍需在窗口里实际操作一次并查库确认。
