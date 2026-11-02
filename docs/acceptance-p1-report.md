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
| **AC-G0** | 环境与直连基线复核 | C | **PASS** | 20:39 独立复核：无 MeshFlux / 无 sing-box / 三项代理开关 0 / 直连两路一致（已脱敏） |
| **AC-G1** | 种子文件导入真实节点 | A+SQL | **PASS** | 导入 2 条 `shadowsocks`，`server` ≠ 127.0.0.1，`node_id` 为 NULL，`config_json` 无 `password`/`uuid` |
| **AC-G2** | 连接后系统代理生效 | A+C | **PASS** | HTTP / HTTPS / SOCKS 均 `127.0.0.1:53211`；`networksetup` 亦为 `Yes` |
| **AC-G3** | **真实出口 IP 变化** | C | **PASS** | 经代理出口 ≠ 直连基线；`cloudflare trace` 给出 `loc=US`；20:49 独立复测 |
| **AC-G4** | 断开后出口与代理还原 | A+C | **PASS（实机 21:31）** | sing-box 退出、代理三项归零、`config/` 为空、`runtime.pid` 清除、直连出口恢复 |
| **AC-G5** | 连接后返回真实 `exit_ip` | A+SQL | **PASS（实机 21:30）** | `VpnConnect` 返回实际出口；`RuntimeStatus` 的出口字段由「未知」变为有值 |
| **AC-G6** | 不断开直接切换节点 | A+C | **PASS（实机 21:40）** | 前后两次出口不同；新进程监听端口与系统代理一致；旧节点配置已删除 |
| **D-20** | 出口 IP 永远为 `null`（缺陷，非用例） | SQL+代码 | **已修复，实机 PASS** | 21:30 连接返回实际出口 —— 与 AC-G3 的 PASS 不冲突，见 §2 |
| **D-22** | 断开后明文凭据配置残留磁盘 | 代码+日志 | **启动清理 PASS / 断开删除 PASS；切换与退出未验证** | 见 §2 分层表 |
| **D-26~D-36** | 第二轮 6 条 + 第三轮根因 + 配套 3 条 + D-36 | 代码+实机 | **D-27 / D-36 实机 PASS；其余代码层已修复，切换/退出部分未验证** | D-32 是根因；实机五步已完成四步。见 §2 |
| P-4 | 二进制不早于源码（新准入） | 静态 | **通过** | 17:31 一度 ❌（源码 17:30:34 晚于二进制 17:28:04），重建后 ✅ |
| P-5 | 无其它 TUN VPN 在运行（环境前提） | 静态 | **重新满足（PM 实测）** | 20:20 时 MeshFlux 在跑；现环境干净，但历史证据另有根因 —— 见 §8 |
| AC-B3 | 事件到达且无 `ai-` 前缀 | 脚本 | **PASS** | `check-contracts.mjs` 5 项通过、退出码 0、无 FAIL（18:56） |
| AC-B2 | 对话流式输出 | A | **PASS** | 回复分三段落库（19:09:32 / :33 / :37），中间夹工具调用，非一次性整段 |
| AC-B4 | 工具卡渲染与脱敏 | A | **PASS** | 脱敏 ✅；20:15 全链路 10 次调用均渲染为工具卡（名称/状态/耗时） |
| AC-C1 | 首次弹卡、允许后放行 | A | **范围变更，不再适用** | 审批机制已移除 |
| AC-C2 | 拒绝后仍会弹 | A | **范围变更，不再适用** | 同上 |
| AC-C3 | `CoreInstall` 每次都弹 | A | **范围变更，不再适用** | 同上 |
| AC-C5a | 拒绝 → `approved = 0` | A+SQL | **范围变更，不再适用** | 同上 |
| AC-C5b | 允许一次 → `approved = 1` | A+SQL | **范围变更，不再适用** | 同上 |
| AC-C5c | 会话放行 → `approved = 2` | A+SQL | **范围变更，不再适用** | 同上 |
| AC-C5d | 审计字段仍写入 | A+SQL | **PASS** | 34 条调用每一条都有行、`approved` 为 `NULL`（与 AC-N2 同源证据） |
| **AC-N1** | 无弹窗直接连接（新增） | A+SQL | **PASS** | 20:15 全链路走通：装 1.14.4 → 导入 → 连接成功，全程无确认卡 |
| **AC-N2** | `approved` 无残留写入（新增） | SQL | **PASS** | 34 条调用全部 `approved IS NULL`，无 `1`/`2` 残留 |
| **AC-N3** | 种子导入的 SS 节点真实连通（待 N-03 落地） | C+SQL | **未开始** | 正向连通 + 4 条负向断言（指纹 grep、删凭据必失败、node_id 为空、config_json 无凭据） |
| AC-F1 | 对话落库并重启恢复 | A | **PASS**（`2dc223e`） | 19:06 重启后侧边栏 2 个历史会话，消息成对、顺序正确 |
| AC-F2 | 重启后运行时状态一致 | A+SQL | **FAIL（D-17，macOS）** | 代理被正确还原，但 sing-box 进程未回收 —— 两者不一致。**Windows 未修复**，见 §10 #6 |

**放行结论：仍未通过 —— AC-F2 失败（D-17）；D-26 ~ D-35 已修复（代码层）但切换与退出尚未实机验证。**

**实机验证推进（21:30–21:31）**：连接与主动断开两条主路径已由用户实际操作验证，D-20 / D-22 断开路径 / AC-G4 / AC-G5 全部 PASS。

**真实网络验证取得突破**：AC-G0~G3 全部 PASS，Veyl **第一次**被证明确实能把流量从美国出口送出去（`loc=US`，出口 ≠ 直连基线）。这解除了持续整轮的「真实出口从未验证」。

- **阻断项**：D-17 —— 重启后遗留 sing-box 进程未回收，而系统代理已被还原，两者不一致。**平台范围**：macOS 已修复、待 AC-F2 复测；**Windows 未修复**（§10 #6）。
- **已修复，实机 PASS**：D-20 —— 21:30 连接返回了实际出口（此前恒为「未知」）。
- **部分实机 PASS**：D-22 —— 启动清理 PASS、**断开删除 PASS**；切换与退出两条路径仍未验证。
- **已修复，实机 PASS**：D-27（切换后旧配置确实删除）、D-36（切换后报告与实际一致）。
- **已修复（代码层），部分实机**：D-26 ~ D-35 —— 实机五步已完成**连接 / 看 exit_ip / 断开 / 切换**四步，**只剩退出应用未做**（D-26 / D-32 的退出路径仍未验证）。
- **待复测**：AC-F2 / AC-H1~H4（用例组 H）。
- **已移出范围**：AC-C1/C2/C3/C5a/C5b/C5c（6 条，审批移除）。
- 改写：AC-C5d（审批四态 → 审计字段回归）。

原 21 条验收：**6 条移出、1 条改写、其余保留**。

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

### D-04（观察项）运行时日志文件始终为 0 字节 → **已恢复正常（20:15 复测），不记缺陷**
- `~/Library/Application Support/Veyl/logs/app-2026-11-02.log` 在应用启动 18 分钟后仍为 **0 字节**；`build/logs/dev-*.log` 里也没有任何 `veyl=` 前缀的应用日志，只有一条 macOS 输入法警告。
- **20:15 复测**：日志已有内容，且格式符合架构师要求：
  ```
  2026-11-02 19:26:31 INFO  veyl_lib::tools::services  目录服务设备已注册：dev_000003
  2026-11-02 20:15:38 INFO  veyl_lib::config::validate active_config path=…/profile-prf_seed-jp-01.json mode=0600
  ```
- **定性**：当时可能只是「尚无事件可记录」，而非 logger 未初始化。**不再作为缺陷**，保留记录备查。

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

### D-06 时间戳单位不一致（**中**，归属 Bob）→ **SQLite 与 `runtime.pid` 已是毫秒；`runtime-state.json` 仍是秒**

- **原问题**：`tool_calls.created_at` 存毫秒、`runtime_versions.installed_at` 存秒，同一数据库两种单位；且 `docs/acceptance-p1.md` §2 的证据 SQL 按秒解析，导致时间列静默显示为空。
- **修复**：提交 `02bd882 fix: 统一数据库时间戳为毫秒并迁移历史数据`。
- **验证（20:35）**：

```
tool_calls.created_at       1793621745976   （13 位，毫秒）
runtime_versions.installed_at 1793621735000  （13 位，毫秒，已迁移）
datetime(installed_at/1000,'unixepoch','localtime') → 2026-11-02 20:15:35  ✅
```

- **结论**：跨表单位已统一为毫秒。迁移脚本把历史秒值转成了毫秒（保留了原值语义）。**D-06 关闭。**
- **残留提醒**：`docs/acceptance-p1.md` §2 的证据 SQL 若仍写 `datetime(created_at,'unixepoch')`（按秒），现在会算错。文档侧需要同步改成 `/1000` —— 这属于架构师的文档，已告知。
- **20:45 复检：修复不完整**。SQLite 已统一为毫秒，但 `runtime-state.json` 仍是秒：

```
runtime-state.json → installs["1.14.4"]["installed_at"] = 1793621735   （10 位，秒）
```

  迁移只覆盖了数据库，没有覆盖状态文件。**若该值会通过工具返回给模型或显示到界面，D-06 仍算未修完**（已在 PM 处确认，Bob 一并处理）。

- **21:30 实机补充：`runtime.pid` 是毫秒，但 `runtime-state.json` 仍是秒**。

| 载体 | 时间戳 | 位数 | 状态 |
|---|---|---|---|
| SQLite `tool_calls.created_at` | — | 13 | ✅ 毫秒 |
| `runtime.pid` `started_at` | 20:49 / 21:30 两次均为 13 位 | 13 | ✅ 毫秒 |
| **`runtime-state.json` `installs["1.14.4"].installed_at`** | `1793621735`（21:33 复检） | **10** | ❌ **仍是秒** |

  **所以 D-06 只能部分关闭**：新引入的 `runtime.pid` 用毫秒是对的，但当初指出的 `runtime-state.json` 从未被改过。**不能据此把 D-06 整体标 PASS** —— 那会把一个仍然存在的单位不一致当成已解决。

  影响范围：该文件只在本地运行时状态里用，目前不通过工具返回、也不显示在界面，所以**没有用户可见后果**；但它是一个仍在的「同一批数据两种单位」样本，将来做跨文件时间比较就会踩到。

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

### N-03 支持 Shadowsocks 协议（**新增需求，用户已决定纳入**）

- **提出**：2026-11-02，用户希望用现成的真实服务器做连通性验证，提供了一份本地种子文件（2 个 shadowsocks 节点，`aes-256-gcm`）。**文件路径与内容不写入仓库**。
- **现状**：`NodeProtocol` 只枚举 `vless_reality` / `hysteria2`（`catalog/types.rs:9-14`），`config/builder.rs` 只构建这两种出站，契约未定义 shadowsocks。
- **底层不是障碍（已实测）**：sing-box 1.14.4 对三种协议都接受 —— 分别用带 `reality` 的 vless、`hysteria2`、`shadowsocks(aes-256-gcm)` 的配置跑 `sing-box check`，**三次均 exit 0**。构建标签含 `with_quic`（Hysteria2 依赖）与 `with_utls`（REALITY 指纹依赖），`generate reality-keypair` 可用。
- **需改动**：`NodeProtocol` 枚举、`config/builder.rs` 出站构建、`docs/contracts/catalog.md` + `tools.md` 的协议枚举与节点字段、契约版本号。
- **收益**：用户现有服务器可直接用于真实链路验证（出口 IP、延迟、真实 sing-box 启动），比纯 mock 更接近 P1 §9 的验收要求。
- **架构定稿（架构师 20:20，见 `docs/shadowsocks.md` §5.5）**：
  - **共用内部模型已存在**：`catalog/types.rs` 的 `NodeDescriptor` 与 seed 文件的 sing-box outbound 是两种 wire 格式，都映射到 `config/builder.rs` 的 `ProtocolConfig` + `Credentials`。将来切回目录服务只需**删掉 seed 适配器**，不动 builder / 存储 / connect 路径。
  - **导入通道用 `veyl-runtime-selftest import-seeds` 子命令**，不用 `VEYL_SEED_FILE` 环境变量 —— 后者会编进发布版，形成「设个环境变量就能注入任意节点」的路径；selftest 二进制不进安装包。
  - **不给模型文件读写能力**：那会拆掉「凭据只在 Host 内部流转」这条不变式，而审批已移除，最不该依赖模型判断来做访问控制。
  - `ProfileImport` 接受粘贴配置属于 P2，且**必须复用同一个适配层**，不得另写解析。
- **术语纠正（重要）**：
  - `device_token` = **访问目录服务的凭据**（证明这台机器是合法客户端）
  - 节点凭据（uuid / password）= **使用该节点的凭据**，存 `secrets.enc` 的 `node:<profile_id>` 键
  - 两者是不同东西。P1 里两者都存在，只是节点来自 seed 文件而非目录服务。
- **安全约束（硬性条款，必须遵守）**：
  1. `seeds.json` 及其中的**真实密码不得进入仓库**——不提交、不复制、不加进 `.gitignore` 之外的任何受版本控制的位置
  2. **不得出现在日志、报告、测试输出、截图或聊天记录中**；测试人员只允许读取字段名与 `method`，不得打印密码值
  3. **导入时只写入 `secrets.enc`**（或等价的加密凭据存储），不得硬编码进代码、契约示例、mock 数据或配置模板
  4. 需要示例值时一律用占位符（如 `dummy-password`），不得用真实值
  5. 违反上述任一条，按凭据泄漏处理：立即轮换该节点密码并上报 PM

**分发方式决策（2026-11-02 20:25，用户）**

用户决定：**用现有 seed JSON 让第一批内测用户用起来，逐个发放文件，不随安装包分发。**

已知并接受的特性：
- 密码在内测用户之间**共享**，一人泄漏即全部暴露
- **无法按用户吊销**，出事只能全体轮换
- 服务器带宽成本无法归因到具体用户

测试人员建议：内测期记录「哪台机器拿到哪份文件」，出事时能定位范围。

**与 `import-seeds` 方案的冲突（待 PM 与架构师决策）**

架构师否掉 `VEYL_SEED_FILE` 的理由是「会编进发布版」，改用 `veyl-runtime-selftest import-seeds` —— 但**该二进制不进安装包**。内测用户拿到正式安装包后没有任何导入入口，方案在内测场景下不成立。

待定选项：A. 设置页加「导入节点文件」；B. 发行版附带独立 CLI 助手；C. 手工放文件 + 隐藏入口。

**20:30 修正推荐（用户明确「第一阶段能跑起来才是最核心的」后）**

按「内测优先能跑」的口径，推荐改为 **C'：固定路径自动导入，零 UI**：

- 用户把 `seeds.json` 放到 `~/Library/Application Support/Veyl/seeds.json`
- 启动时若该文件存在**且 `profiles` 为空**，自动导入
- 文件不存在则正常启动，不报错

对比：A 需要 Alice 做界面与错误提示（多等约一天），B 要求内测用户跑命令行（不现实），C' 只需 Bob 加一段启动逻辑。

**三个待架构师确认的点**：
1. 触发条件建议「`profiles` 为空才导入」，避免覆盖用户后续操作
2. **解析失败必须可见**（状态面板或日志留一行原因），否则用户只看到「没有节点」而无从排查
3. 成功时也建议留一行「已从 seeds.json 导入 N 个节点」

`pw_fp` 指纹在内测阶段属加分项，不作为阻塞。

**20:35 再次修正（用户指出 `~/Library` 默认隐藏）**

零 UI 方案在真实分发下不成立：macOS 的 `~/Library` 默认不可见，让内测用户手动放入 `Application Support/Veyl/` 不现实。改为**拖拽导入**：

- 项目**未安装任何 Tauri 插件**（`grep tauri-plugin src-tauri/Cargo.toml` 为空），做「选择文件」按钮需引入 `tauri-plugin-dialog`
  - ⚠️ **该判断仅在 20:35 时成立。20:40 起已引入 `tauri-plugin-dialog`，见下方「修订记录」。**
- 但 **Tauri 2 的拖拽事件是内置的**（`@tauri-apps/api` 2.1.1，`getCurrentWebview().onDragDropEvent()`），零新增依赖
- 流程：用户把 JSON 拖到窗口 → 前端拿路径 → 调 `import_seed_file(path)` → 后端复用 seed 适配器解析 → 凭据进 `secrets.enc`

**明确否掉「让 AI 写文件」**：密码链路是「文件 → 适配器 → `secrets.enc`」，无外部出口；给模型文件写入权等于开一个由模型判断守的口子，而审批已移除。

**必须满足的三条**：只接受 `.json` 且限制大小；解析失败要说明「第几条、什么原因」；成功后显示导入了几个节点。

固定路径自动导入与 `import-seeds` 子命令保留，仅作开发与自动化测试通道。

**20:40 定稿（PM 以代码现状为准）**：最终方案**只有拖拽导入**。

- ✅ `import_seed_file` 已实现并注册（`agent/commands.rs:294`、`lib.rs:104`）
- ✅ 前端已在 `Settings.tsx` 使用 `onDragDropEvent`（20:40 时在 138 行，现为 152 行），并有「导入节点文件」区块
- ❌ `import_seed_json` / `startup_notice` / 固定路径自动导入 —— 均无残留
- 契约 1.0.10

流程：用户把 `.json` 拖进投放区 → 前端只传**路径** → `import_seed_file` 校验并复用 `seed_import` 适配器。

**修订记录：上一段「只有拖拽导入」的定稿已被推翻（保留原文，不删改）**

| 项 | 内容 |
|---|---|
| 原结论 | 20:40 定稿：最终方案**只有拖拽导入**，理由是零新增依赖 |
| 推翻时间 | 同日 **20:40–20:41**：`src-tauri/Cargo.toml`、`package.json`、`capabilities/default.json` 改于 20:40，`Settings.tsx` 改于 20:41 |
| 推翻原因 | **用户要求增加「选择文件」入口** —— 拖拽不是人人想得到，多数用户第一反应是找按钮 |
| 新结论 | **两条入口、一套实现**：窗口拖放 + 设置页「选择文件」，都调同一个 `import_seed_file(path)`，共用 `seed_import` 适配器 |
| 权限面 | 只授 **`dialog:allow-open`**；没有 `save` / `write` / `ask` / `message` 等任何其他 dialog 权限 |
| 取消行为 | 选择器返回 `null` 时**不触发导入**（`Settings.tsx:137-138` 用 `typeof path === "string"` 判定） |
| 验证 | 已实现并测试通过（PM 侧） |
| 现状位置 | 拖放 `Settings.tsx:152`、区块标题 `:283`、**「选择文件」按钮 `:302`**；两条入口共用 `handleDrop`（`:129` 注释写明） |

**为什么保留原文而不是直接改写**：验收报告的价值在于能看出结论怎么演变。改写成「一开始就是两条入口」会掩盖一次决策反复，也会让后来人误以为文件选择器从一开始就被考虑过 —— 而当时否掉它的理由（零依赖）是真实存在过的。

**AC-N3 的可证伪断言（架构师 20:25 补充）**

正向「连上了」证明不了「凭据没泄漏」，也证明不了「走的是 seed 路径而不是别处兜底」。因此 AC-N3 必须包含以下负向断言：

1. **指纹可 grep**：harness 摘要里打印 `pw_fp = sha256(profile_id ‖ password)[:8]`（按节点加盐，单向；同一密码在不同节点指纹不同，不能跨节点比对）。
   **密码出现在某些位置是正常的，不是泄漏** —— 必须分两组断言，否则检查永远红、然后就没人看了：

   | 组 | 位置 | 期望 |
   |---|---|---|
   | **允许出现** | 用户的 `seeds.json`、`secrets.enc`、sing-box 的 active 配置 | 命中指纹，**且文件权限 0600、父目录 0700** |
   | **不应出现** | 日志、`profiles.config_json`、DB 其他表、错误信息、报告 | 指纹**零命中** |

   ```bash
   # 不应出现 —— 应全空
   grep -rn "$FP" build/logs/ "$HOME/Library/Application Support/Veyl/logs/"
   sqlite3 "$DB" "SELECT id FROM profiles WHERE config_json LIKE '%$FP%';"

   # 允许出现 —— 应命中，且权限必须正确
   stat -f "%Sp %N" "$HOME/Library/Application Support/Veyl/secrets.enc"
   stat -f "%Sp %N" "$HOME/Library/Application Support/Veyl/config"
   ```

   > `stat -f "%Sp"` 比 `ls -l` 更稳（macOS 上 `ls -l` 显示 `-rw-------`，脚本化断言容易出错）。
   > **只验文件权限**，期望 `-rw-------`。**目录权限不作为断言** —— 实测 `~/Library` 与 `~/Library/Application Support` 均为 `0700`，`Veyl` 目录虽为 `0755` 但外层已隔离，不构成泄漏；若照抄「目录也要 0700」去查，会报出一条误报，反而削弱报告可信度。
   > 目录权限只作**可选观察项**记一句：「`Veyl` 目录 `0755`，父目录 `0700` 已隔离」。Windows 侧 `%LOCALAPPDATA%` 按用户 ACL 隔离，无需单独核对。
   > 架构师已要求 Bob 在 connect 阶段打结构化日志：`active_config path=<…> mode=0600` 与 `active_config removed`（只打路径与权限，不打内容），验收时核对这两行即可。
2. **删凭据必须失败** —— ✅ **D-22 已落地，本断言可以启用**（仍需用户实机执行）

   原写法「连上之后删 `node:<profile_id>` 再连接」曾是**恒真的假 PASS**：旧实现连接时优先用磁盘上已渲染的配置，连接根本不读 `secrets.enc`，删不删凭据结果一样。D-22 已改为每次连接重新渲染，前提消失。

   改写后的正确顺序（D-22 已落地，可执行；等用户实机）：

   1. 连接成功 → **断开**
   2. 确认 `config/profile-<id>.json` **已不存在**（这条本身就是 §6.1 的验收：断开后不留明文密码）
   3. 从 `secrets.enc` 删除 `node:<profile_id>`
   4. 再次连接 → **必须失败**，且错误码可辨认（不是超时、不是端口占用）
   5. 恢复条目后应恢复连通

   **顺序不能变**：不先确认磁盘配置已删，第 4 步测的仍然是缓存，结论同样无效。
   **若删了凭据还能连上，说明密码还藏在别处**（`config_json` 或内存缓存），违反 §5.5 第三条不变式。
3. **`profiles.node_id` 必须为空**：seed 导入的 profile 不应有 `node_id`，否则说明走了目录路径。
   ```sql
   SELECT id, name, node_id FROM profiles WHERE id LIKE 'seed-%';   -- 期望 node_id IS NULL
   ```
4. **`config_json` 无凭据字段**：
   ```sql
   SELECT id FROM profiles WHERE config_json LIKE '%"password"%' OR config_json LIKE '%"uuid"%';  -- 期望空
   ```

**已知盲区（如实标注，不写成已验证）**：「凭据未进入模型上下文」**无法用 grep 证明**，因为模型上下文不落盘。能做的只有：
- 验证 `ProfileList` 返回里没有 `password`/`uuid` 字段（那是 Agent 能看到的唯一入口）
- 人工阅读一次对话输出，确认模型没有复述任何凭据

此项在报告中只能记为「依赖人工观察」。

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

### D-12 `CatalogSearch` 只把「找到 N 个节点」交给模型，节点详情丢失（**高**，归属 Bob）→ **已修复并验证（`5084ae5`）**

- **原现象**：19:26 的 `result_json` 只有 `"找到 5 个节点。"`，模型在 `AskUserQuestion` 里明说「拿不到可以确认的节点 id」，只能猜 `jp-1`。
- **原根因**：`tools/catalog.rs:73` 把结构化 `data` 排除在 content 之外。
- **修复验证（19:57）**：`summarise_nodes` 生效，模型现在能拿到：

```
找到 5 个节点：
- seed-jp-01 | Tokyo | vless_reality | 42ms | 健康 98
- seed-jp-02 | Tokyo | vless_reality | 55ms | 健康 95
- seed-dead-01 | Tokyo | vless_reality | 999ms | 健康 70
- seed-hy2-01 | Osaka | hy…（截断）
```

  白名单只取 id / city / region / protocol / latency_ms / health_score，`server`/`credentials` 不出现。模型据此正确说出「最好的是 `seed-jp-01`（东京，42ms，健康 98）」。**D-12 关闭。**

### D-15 `CoreListVersions` 同样只给计数，不列版本号，导致核心装不上（**高**，归属 Bob）→ **已修复并验证（`8b79e8c`）**

- **原现象**：19:57 模型拿到 `"已安装 0 个版本，可安装 1 个。"`，没有版本号，猜 `1.10.0` / `1.9.0` 两次 `NOT_FOUND`。
- **原根因**：`tools/core.rs:52` 与 D-12 同一种写法。
- **修复验证（20:15）**：`summarise_versions` 生效，模型现在拿到：

```
已安装：无
可安装：
- 1.14.4 (stable)
使用版本号调用 CoreInstall，例如 CoreInstall("1.14.4")。
```

  随后 `CoreInstall {"version":"1.14.4"}` 一次成功。**D-15 关闭。**

- **连带修复**：PM 说同类排查又找到 `ProfileList` 与 `RuntimeLogs` 两处只给计数，已一并改为列出 id 与日志正文。本轮 `ProfileList` 返回正常。

### D-16（观察项）首轮两次 `CatalogSearch` 报设备注册 transport 错误，随后自愈

- 19:57 同一进程内，前两次 `CatalogSearch` 返回 `设备注册失败：catalog transport: error sending request for url (http://127.0.0.1:18090/v1/devices)`，此后 `CatalogSearch` 成功，`secrets.enc` 中出现了 `device_token`。
- 当时 mock 服务确认在监听（19:56 已核对 18090）。
- **推测**：两条 `CatalogSearch` 并发触发首次注册，存在竞态；或注册请求在某个瞬间被拒。仅出现一次，**未复现，不判缺陷**，记录待观察。

### D-17 重启后遗留 sing-box 进程未回收，代理却被还原（**高**，归属 Bob）→ AC-F2 FAIL

**平台完成度 —— 不能笼统写「D-17 已修复」**：

| 平台 | 状态 | 依据 |
|---|---|---|
| **macOS** | **已修复并验证** | `ps -ww -o command=` 能取到完整命令行，`matches_launch` 同时校验「二进制绝对路径 + 配置路径」 |
| **Windows** | **未修复** | `tasklist` 只给镜像名，拿不到命令行，严格校验必然不匹配 → **回收一律跳过**。详见 §10 #6 |

**这是本轮最有价值的一条：一个不对称。**

| 资源 | 重启后 | 结论 |
|---|---|---|
| 系统代理 | **被还原成 `No / 127.0.0.1:2080`** | ✅ 正确（契约 §8：idle/stopping 时恢复备份） |
| sing-box 进程 | **仍在运行**（PID 10621，20:15:40 启动，应用 20:19:55 重启） | ❌ 无人回收 |
| `runtime_versions` | `1.14.4 / active` | —— |
| 界面状态 | 预期显示「未连接」（`RuntimeManager::new` 的 pid 初始为 `None`、状态默认 `idle`） | 与进程不一致 |

**根因（PM 代码复核）**：
- 启动流程里只有 `proxy.recover_stale()` 恢复系统代理，**没有任何清理遗留 sing-box 进程的代码**
- `RuntimeManager::new` 不做接管，pid 初始为 `None`
- 因此「代理收回了，进程落下了」——用户看到一个既没连接、又有一个孤儿进程在跑的机器

**为什么比「两者都留下」更糟**：如果代理和进程都留着，至少行为是一致的；现在代理关了、进程还开着，用户既上不了代理，也不知道有个 sing-box 在后台占端口、跑流量。

**修复方向（PM 已派 Bob）**：持久化 pid，启动时回收遗留进程（SIGTERM → 超时 SIGKILL）；Cmd+Q 正常退出时调用 `kill_child()`。**选回收而不是接管** —— 接管要重建 child handle 与状态机，P1 不值；「退出即断开」也更符合桌面 VPN 的预期。

**即使界面显示「运行中」，本条仍然成立**：那说明接管不完整（进程有人管但状态机没恢复），是另一个问题。

### D-20 出口 IP 永远是 `null`，界面与工具都显示「未知」（**高**，归属 Bob）→ **已修复，实机 PASS（21:30）**

> 编号沿用 PM 缺陷单；**D-18 / D-19 / D-21 / D-23 ~ D-25 由 PM 侧维护，本报告未收录** —— 编号不连续是正常的。

**实机结论（2026-11-02 21:30）**：连接后 `VpnConnect` 返回**实际出口地址**，不再出现「未知」；同一时刻 `RuntimeStatus` 的出口字段也从「未知」变为有值。

| 时间 | 工具 | 出口字段 |
|---|---|---|
| 21:30:29 | `VpnConnect` | **已返回**（非「未知」） |
| 21:30:32 | `RuntimeStatus` | **已返回**（非「未知」） |
| 20:47:41 / :44（修复前） | 同上两者 | 均为「未知」 |

> 出口地址为美国节点地址，按纪律**不写字面值**；它与直连出口不同这一事实已由 AC-G3 独立验证。

**现象（修复前）**：真实连接成功后，`VpnConnect` 返回 `"已连接，出口 IP 未知。"`，`is_error=0`。

```
$ sqlite3 "$DB" "SELECT result_json FROM tool_calls WHERE tool_name='VpnConnect' ORDER BY created_at DESC LIMIT 1;"
"已连接，出口 IP 未知。"
```

此时隧道**实际是通的** —— AC-G3 已用显式 `--proxy` 独立验证出口变了。

**两个独立根因叠加，性质不同，必须分开记。**

#### D-20a 探测结果从未写回状态 —— `set_exit_ip` 零调用

```
$ grep -rn 'set_exit_ip' src-tauri/src/      # 20:49 实测
src-tauri/src/runtime/manager.rs:350:    pub async fn set_exit_ip(&self, exit_ip: Option<String>) {
```

当时全项目**只有定义、零调用**。`HealthSnapshot.exit_ip` 初值 `None`（`manager.rs:106`），此后没有任何路径写入。

#### D-20b `VpnConnect` 的返回里没有顶层 `exit_ip`，而 `vpn.rs` 只读顶层

`services.rs` 直接序列化 `RuntimeStatus`，出口在**嵌套**的 `health.exit_ip`（`manager.rs:93/123`）；而 `vpn.rs` 读的是 `data["exit_ip"]`（**顶层**）。

**所以即使 D-20a 修好、值写进了状态，D-20b 这一层仍然读不到** —— 两个缺陷串联，任修一个都不够。

HEAD 版本核对：

```
$ git show HEAD:src-tauri/src/tools/services.rs | grep -n 'exit_ip'
80:            "exit_ip": null,          # 仅字面量，从未写入真实值
$ git show HEAD:src-tauri/src/tools/vpn.rs | grep -n 'exit_ip'
77:            let exit_ip = data.get("exit_ip")   # 只读顶层
```

#### 修复现状（**实机验证通过**）

| 根因 | 修复 |
|---|---|
| D-20a | `manager.rs` 新增 `probe_exit_ip`（`:922`），启动后异步探测并调用 `set_exit_ip`（`:949`） |
| D-20b | `services.rs` 等待 `await_exit_ip(3s)` 后把结果写到顶层 `exit_ip`（`:890-898`）；`vpn.rs` 改为 `exit_ip` 为 null 时说「仍在探测中」而非报错 |

21:30 实机连接后，两个工具都返回了实际出口 → **两条根因都确认修复**（AC-G5 PASS）。

**影响**：
- 界面「出口 IP」永远为空/未知
- 工具返回值同样如此，模型无法回答「我现在从哪个 IP 出去」
- 用户失去**应用内唯一一个能自证「代理确实生效」的手段** —— 而这恰恰是 VPN 产品最该给的东西。目前只能靠外部 curl 才能看到出口，普通内测用户做不到

**必须与 AC-G3 分开写**：

| 结论 | 内容 |
|---|---|
| AC-G3 = **PASS** | 隧道确实通了，流量真的从美国出去了 |
| D-20 = **已修复（实机 21:30）** | 修复前应用**不会报告**这个出口；现在会 |

两条不冲突。**不能**用 D-20 推翻 AC-G3，也**不能**用 AC-G3 的 PASS 掩盖 D-20 —— 后者是用户体验缺陷，前者是网络功能验证。修复之后仍然分开记：它们是两个维度，不是同一件事的前后状态。

**这是「能力写好了但没有调用方」的第三次出现**：`set_credentials`（D-03）、`chat_history`（D-08）、现在是 `set_exit_ip`。`wiring-check.sh` 的固定清单应把它加进去。

**修复后复测**：用例组 G 新增 **AC-G5**（见 `docs/acceptance-p1.md`）。

### D-22 断开后明文凭据配置长期留在磁盘（**高**，归属 Bob）

**现象**：连接会把完整配置（**含明文密码**）渲染到 `config/profile-<id>.json`（0600）。`disconnect` **不删**它，只有 `profile_delete` 会删。于是断开之后、甚至退出应用之后，明文密码仍然留在磁盘上。

**与自己的契约冲突**：`docs/shadowsocks.md` §6.1 的白名单允许「sing-box 的 active 配置」出现凭据 —— 前提是它**只在连接期间存在**。断开后仍留着，就已经不在「active」的定义里。

**附带后果：一条验收断言失效**：`services.rs:810` 连接时优先读磁盘上的渲染配置，读不到才回落到 `secrets.enc`。所以「删掉 `node:<profile_id>` 后连接必须失败」在原实现下**恒真** —— 连接根本不看凭据源。按原样写进用例会得到假的 PASS（已在 AC-N3 断言 2 上标注并改写）。

**修复状态 —— 分三层，不能笼统写「已修复」**：

| 层 | 状态 | 依据 |
|---|---|---|
| 代码实现 | **已落地** | PM 通读四条路径：连接时每次重新渲染；失败路径由 `RenderedConfigGuard` 的 `Drop` 删除；断开时按 active profile 删除；启动与退出各扫一次 |
| 启动清理实测 | **PASS** | 21:05:45 启动日志：`active_config removed` × 4，随后提示「启动时清理了 4 个遗留的明文配置文件」；`config/` 已为空 |
| **断开删除实机** | **PASS（21:31）** | 用户主动断开后：sing-box 退出、系统代理三项归零、**`config/` 完全为空**、`runtime.pid` 清除；日志显示 21:30 写入、21:31:30 删除 json 与 meta |
| 切换删除实机 | **未验证** | 见下方四路径表 |
| 退出清理实机 | **未验证** | 同上 |

**当前口径**：D-22 = **启动清理与断开删除都已实机 PASS**；切换与退出两条路径仍未验证，不写成完全通过。AC-N3 五步断言中的「断开后配置文件不存在」这一步已具备实机证据。

**四路径验收表（更新后）**：

| 路径 | 状态 |
|---|---|
| 启动清理 | **PASS**（21:05 实机） |
| 断开删除 | **PASS**（21:31 实机） |
| **切换删除** | **待验**（D-27） |
| **退出清理** | **待验** |
| 写一半失败删除 | 待验（D-28），只能靠注入失败验证 |

**切换失败后的行为是设计内**：B 在启动前失败时，A 进程仍在但 A 的配置已删，A 崩溃后无法自动重启、需要手动重连。这是为「明文密码立即消失」付出的代价（§10 #9），实测时**不要记成缺陷**。

**为什么值得单列**：这是整轮唯一一条「密码在用户不知情的情况下长期驻留磁盘」的问题。单机读取风险有限，但它违反的是项目**自己写下的不变式** —— 而 §6.1 正是 AC-S1 扫描规则的基础。不变式一旦有例外，后面的判断就都不可靠了。

### D-26 ~ D-31 第二轮架构 review 的新发现（**已修复-代码层，未验证**）

> **同一批代码，第二轮又找出 6 条，其中 3 条 P1。** 这不是「代码变差了」，是 review 的覆盖面在扩大 —— 方法学见 §10.3。
>
> **其中 D-26 与 D-30 是 D-32 的实例**，不是彼此独立的问题。根因见本节末尾的 D-32。
>
> **状态口径**：D-26 ~ D-31 的代码修复均已在工作区落地（测试 Clerk 逐条复核代码位置），状态为 **已修复（代码层）、未验证**。
> **没有一条有运行时证据**，不得写成「已验证」或「已通过」。

**逐条落地情况**：

| ID | 代码证据 |
|---|---|
| D-26 | `lib.rs:131-135` 退出前先 `proxy.disable()` |
| D-27 | `drop_previous_rendered_config()`（`services.rs:851`），调用点 `:868` —— **21:40 实机 PASS**：切换后旧节点配置确实不在磁盘 |
| D-28 | guard 改到 `install_profile` **之前**建立（`services.rs:901-903`），注释写明「中途失败时明文可能已经落盘」 |
| D-29 | 由 D-35 覆盖：终态清 `plan` 后 `restart` 返回 `InvalidState`，不再拿死路径启动 |
| D-30 | `require_running_state(started.state)?`（`services.rs:918-921`），失败走 `abort_connection` |
| D-31 | `CatalogSearch` 返回体补 `"stale": false`（`services.rs:644`），契约 §4.8 的键存在 |

| ID | 问题 | 位置 | 后果 | 归属 | 复核 |
|---|---|---|---|---|---|
| **D-26** | **退出应用不解除系统代理** | `lib.rs:130-137` `ExitRequested` 只调 `stop()` + 清配置；`proxy.disable()` 全仓唯一调用点是工具层主动断开（`services.rs:488`） | **连接中退出 → 系统代理指向已死端口，用户断网到下次启动** | Bob | ✅ 代码复核 |
| **D-27** | 切换 profile 不清理上一个的明文配置 | `remove_profile_config` 只在断开（`:499`）、删除（`:710`）、Guard Drop（`:805`）调用；连接新 profile 时不清理旧的 | 连着 A 直接连 B，`profile-A.json` 含明文密码留在盘上直到退出 | Bob | ✅ 代码复核 |
| **D-28** | `RenderedConfigGuard` 比 `install_profile` 晚创建 | `services.rs`：先 `install_profile(...)`，成功后才 `RenderedConfigGuard::new(...)` | 写文件中途失败 → 留下一份**没有 guard 保护**的明文配置，之后无人删除 | Bob | ✅ 代码复核 |
| **D-29** | `restart` 用已删除的配置启动 | D-22 引入的回归 | 状态掉进 `Failed` | Bob | 架构师 review |
| **D-30** | `connect` 不校验 `start()` 是否真进了 `Running` | `services.rs:895-899`：`start().await?` 后直接 `proxy.enable` | 并发 stop 时可能返回「已连接」，但代理指向死端口 | Bob | ✅ 代码复核 |
| **D-31** | `CatalogSearch` 缺 `stale: boolean` | 全仓无 `stale` 字段；契约 §4.8 要求 | 缓存降级时模型与用户都无法知道数据可能过期 | Bob | ✅ 代码复核 |

**D-26 为什么是最严重的一条**：它把「退出应用」从「安全状态」变成了「破坏状态」。用户以为退出就断开了，实际系统代理还指着 `127.0.0.1:<已关闭端口>` —— **所有流量走一个死端口，等于断网**，而且用户没有任何提示，只能等下次启动才恢复。

这比 D-17（进程不回收）更直接：D-17 至少代理是还原的，网络还能用；D-26 是网络直接不可用。

### D-32 代理开启后的失败路径不撤销代理（**根因**，已修复-代码层，未验证）

> **先读这条再看 D-26 / D-30。** 它们不是三个并列的 bug，而是**同一个根因的三个观测面**。
> 把 D-26 修好，不会顺带修好 D-30 或 D-32 的其它实例 —— 这正是要单独记一条的原因。

**穷举结果（架构师专项复核）**：

| 类别 | 位置 | 说明 |
|---|---|---|
| **开启点** | `services.rs:923` | **全仓唯一一处** |
| 关闭点 1 | `services.rs:503`（`runtime_stop`） | 用户主动断开 |
| 关闭点 2 | `lib.rs:133`（`ExitRequested`） | 应用退出 —— D-26 修复新增 |
| 关闭点 3 | 启动 `recover_stale` | 处理上次残留 |
| **缺失** | —— | **代理已经开着之后，任何失败路径都不会去关它** |

**四个实例**：

| # | 实例 | 后果 |
|---|---|---|
| 1 | `proxy.enable` **部分成功**：macOS 逐条写 3 个 service，中途失败会半开着；失败分支只 `stop()`、不 `disable()` | 代理指向已停端口 |
| 2 | 切换节点时第二次 `enable` 失败 | 代理停在上一个已停进程的端口上 |
| 3 | 连接成功后 `RuntimeRestart` 失败 → `Failed` | 代理仍开着 |
| 4 | 崩溃重试耗尽 `give_up` → `Failed` | 代理仍开，而 UI（`App.tsx:349`）只把 pill 显示成「连接失败」，**不触发断开** |

**工作区当前状态（测试 Clerk 复核）**：

| 实例 | 状态 |
|---|---|
| 1 / 2 | **已修复（代码层）** —— 新增 `rollback_proxy_after_enable_failure()`（`services.rs:843`），`enable` 失败先 `disable` 再 `stop`；`abort_connection()`（`:832`）覆盖连接中止路径 |
| 3 / 4 | **已修复（代码层）** —— 新增 `terminal_failure_hook`（`manager.rs:330/346`），挂在 `transition()` 转入终态处（`:1074`），`lib.rs:66` 接线成 `proxy.disable()`。**所有进入 Failed 的路径必经** |
| D-26 的退出关闭点 | 已补：`lib.rs:131-135`（先 `proxy.disable()` 再 `stop()`） |
| D-30 的 Running 校验 | 已补：`services.rs:918-921` `require_running_state(...)` |

**修复方案与落地情况一致**：
- 实例 1 / 2 → `enable` 失败分支补 `proxy.disable()` ✅
- 实例 3 / 4 → 运行时加终态失败回调，`lib.rs` 接线，保持运行时层与代理层不互相依赖 ✅（运行时只持有一个 `Fn()`，不认识代理模块）

**状态**：**已修复（代码层）、未完全验证**。

> ⚠️ **代码层验证不等于端到端通过。**
> 实机五步的进度：
>
> | 步骤 | 状态 |
> |---|---|
> | 1. 连接 | ✅ 21:30 |
> | 2. 看 `exit_ip` | ✅ 21:30（D-20 / AC-G5 PASS） |
> | 3. 主动断开 | ✅ 21:31（AC-G4 PASS） |
> | 4. 切换节点 | ✅ 21:40（D-27 / D-36 PASS） |
> | 5. **退出应用** | ❌ 未做（D-26 / D-32 仍未实机验证） |

### D-33 / D-34 / D-35 根因修复的配套改动（**已修复-代码层，未验证**）

| ID | 改动 | 位置 | 解决什么 |
|---|---|---|---|
| **D-33** | 新增 `abort_connection()`：`require_running_state` 失败时先 `proxy.disable()`（失败记 `warn`，不吞掉原错误）再返回 | `services.rs:832`，调用点 `:943` | 连接中止时代理仍开着 |
| **D-34** | `runtime_stop` 的 `disable` 失败改为 `log::warn!`，**仍不阻断断开** | `services.rs:503` | 断开时撤销失败不再静默 |
| **D-35** | `transition()` 转入终态时 `inner.plan = None`；`restart` 返回 `InvalidState` | `manager.rs:1052` | D-22 / D-27 删除配置后，`restart` 不再拿死路径去启动、报一个用户看不懂的底层错误 |

### D-36 切换节点后报告「已连接」但实际断网（**高**，归属 Bob）→ **已修复，实机 PASS（21:40）**

**修复前**：不断开直接连第二个节点时，工具仍返回「已连接，出口 <旧节点地址>」，但运行时并没有真的换过去 —— **提示是成功的，网络是断的**。

**修复后（21:40 实机，测试 Clerk 独立复检）**：

| 检查项 | 结果 |
|---|---|
| 两次连接的出口 | **不同**（第一次为旧节点，第二次为新节点） |
| 运行进程 | pid 6141，启动时间 21:40:33，正是第二次连接的时刻 |
| 该进程监听端口 | `127.0.0.1:60655`（mixed）、`127.0.0.1:61525`（clash） |
| 系统代理端口 | **60655** —— 与新进程监听**一致** |
| 经代理实际出口 | 等于第二次连接返回的地址，与直连出口不同 |
| `config/` 目录 | **只剩第二个节点的配置**，第一个的已删除 |
| `runtime.pid` | pid 与运行进程一致，`started_at` 13 位毫秒 |

**为什么这条值得单列**：「报告已连接」和「实际连通」是两件事。修复前两者脱节，用户看到成功提示却上不了网 —— 和 D-20（应用不会报告出口）刚好相反：那是该说的没说，这是**说了但没说对**。

修复后的判据不是「返回值变了」，而是**代理端口与新进程监听一致**：这才能证明报告反映的是真实状态，而不是又一次乐观的假设。

**代码层验证证据**：

| 项 | 结果 | 来源 |
|---|---|---|
| `cargo test --lib` | **182 passed / 0 failed / 0 ignored**（2.00s） | 测试 Clerk 独立跑 |
| 契约检查 | 5 项通过 | PM 侧 |
| `tsc` | 通过 | PM 侧 |
| 接线检查 | 6/6 | PM 侧 |

> **这些只说明「代码自洽、单测通过」，不说明「功能在真机上对」。**
> 单测里的 proxy 是替身，真实的 `networksetup` 行为、真实 sing-box 的启动时序、真实的目录服务都不在其中。

**用户实机一项都还没做** —— 以下五步全部没有真人操作过的证据：

1. 连接（含经代理出口）
2. 看 `exit_ip`（D-20 / AC-G5）
3. 主动断开（AC-G4、D-22 断开路径）
4. 切换节点（D-27、§10 #9）
5. 退出应用（D-26 / D-32）

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
| 审批卡渲染 | **范围变更，不再适用** | 19:26 曾观测到内联渲染（高风险标记、两个按钮、不遮罩），随审批机制移除而作废 |
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

## 产品风险（用户明确接受的取舍）

移除审批机制后，以下操作**无任何确认提示直接执行**：

| 工具 | 风险 |
|---|---|
| `ProfileDelete` | 删除本地配置，无撤销 |
| `VpnConnect` | 改写系统代理设置，影响整机网络 |
| `CoreInstall` | 下载可执行文件并运行 |
| `RuntimeStop` / `RuntimeRestart` | 中断正在进行的连接 |

**这是有意为之，不是遗漏。** 记录在此是为了让后来者知道：
- 模型判断失误、或被提示词误导时，没有拦截点
- 用户误触同样没有拦截点
- 若将来恢复审批能力，需要重新引入 `ApprovalPolicy`、审批事件、`approved` 三态取值和对应 UI；契约与 schema 建议保留相关字段以免二次迁移

**测试人员的立场**：按用户决定执行，不将其计为缺陷。但若后续出现「误删配置」「代理被意外改写」这类问题，根因应回溯到本次决策，而不是当成新 bug 排查。

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

**① 假 Key（`sk-fakefakefakefakefake1234`）的界面提示原文**  <!-- check-secrets:allow 文档示例，非真实 Key（两个扫描器共用此标记） -->

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

---

## 7. AC-N1 / AC-N2 结果（20:15，`8b79e8c`）

### AC-N1 无弹窗直接连接 → **PASS**

一条「连到日本」走通了完整链路，全程**未出现任何确认卡**：

```
20:15:22  CatalogSearch     {"limit":10,"region":"jp"}   ok   找到 5 个节点（含 id/城市/协议/延迟/健康）
20:15:23  CoreListVersions  {}                            ok   可安装：- 1.14.4 (stable)
20:15:24  CoreInstall       {"version":"1.14.4"}          ok   已开始安装 sing-box 1.14.4
20:15:36  CoreListVersions  {}                            ok
20:15:37  VpnConnect        —                             FAIL 尚无 profile
20:15:38  ProfileImport     —                             ok
20:15:39  ProfileList       {}                            ok
20:15:40  VpnConnect        —                             ok   连接成功
20:15:43  RuntimeStatus     {}                            ok
20:15:43  DiagRun           {"include_logs":true}         ok
```

落地状态：

| 项 | 值 |
|---|---|
| `runtime_versions` | `1.14.4 / active` |
| sing-box 进程 | 运行中，配置 `config/profile-prf_seed-jp-01.json` |
| `profiles` | `prf_seed-jp-01` / `seed-jp-01` / `JP Tokyo 01` / `vless_reality` / `is_active=1` |
| 系统代理 | `Enabled: Yes / 127.0.0.1:60095` |
| `active_config` 权限 | 文件 `-rw-------`(0600)、目录 `drwx------`(0700) |
| 应用结构化日志 | `active_config path=…/profile-prf_seed-jp-01.json mode=0600` ✅（架构师要求的格式） |

`VpnConnect` 在 20:15:37 失败一次（此时还没有 profile），导入后 20:15:40 成功 —— 属正常重试，**不是审批重试**。

### AC-N2 `approved` 无残留写入 → **PASS**

`tool_calls` 共 **34 条，`approved` 全部为 `NULL`**，未出现 `1` 或 `2`。

### 凭据分离核对（部分完成）

| 检查 | 结果 |
|---|---|
| `profiles.config_json` 含 `"uuid"` | **0 条** ✅ |
| `profiles.config_json` 含 `"password"` | **0 条** ✅ |
| `config_json` 实际字段 | `flow / mux / server / server_port / tls{mode, reality_public_key, reality_short_id, server_name, utls_fingerprint}` |
| `active_config` 含 `uuid` | 有（36 位），**该文件 0600**，属「允许出现」组 |

> `reality_public_key` / `reality_short_id` 是**公开值**（要发给服务端），不算凭据。我最初的 SQL 用 `LIKE '%public_key%'` 会误命中，已改成精确匹配 `"uuid"` / `"password"`。

### 更正：所谓「凭据来源三级回退」并不存在

旧代码注释（`services.rs:820`）写着「凭据来源三级回退：目录服务 → 本地 `node:<profile_id>` → 明确报错」。**这句注释一直是错的**，本轮之前就被抄进了本报告，现更正。

实际代码只有两个分支：

| 分支 | 条件 | 凭据来源 | 本地回退 |
|---|---|---|---|
| 目录 | `profile.node_id` 为 `Some` | `catalog_detail(node_id)` | **没有** —— 目录不可用就直接失败 |
| 种子 | `profile.node_id` 为 `None` | `secrets.enc` 的 `node:<profile_id>`（`seed_build_input`） | 本身就是本地 |

所以不存在「目录失败再回退本地」这条路径。本轮 profile 带 `node_id = seed-jp-01`，`secrets.enc` 里没有对应条目，是**设计如此**，不是漏存。

**两个后果**：
1. 目录导入的 profile 在目录服务不可用时**无法重连**（见 §11 行为变化）。
2. AC-N3 的「删掉 `node:<profile_id>` 必须失败」断言**只对 seed 导入的 profile 有意义**；对目录导入的 profile，`node:<id>` 根本不在凭据链路上。

### 新发现：D-06 扩展到跨表不一致

`tool_calls.created_at` = `1793621743874`（**毫秒**），`runtime_versions.installed_at` = `1793621735`（**秒**）。同一数据库里两种单位并存，比文档不一致更严重 —— 任何跨表的时间比较都会错。建议统一，并在契约里写明单位。

---

## 8. 环境前提 P-5：无其它 TUN VPN 在运行

### 8.1 根因修正：应用里从来没有导入过真实节点

此前把「真实出口 IP 未验证」归因于 MeshFlux 抓着路由。这个归因**不完整**，而且掩盖了更根本的一条。测试 Clerk 已独立复核：

```
$ sqlite3 "$DB" "select id,name,protocol,
  json_extract(config_json,'$.server'),
  json_extract(config_json,'$.server_port'), node_id from profiles;"
prf_seed-jp-01|JP Tokyo 01|vless_reality|127.0.0.1|18443|seed-jp-01
```

`profiles` 表里**只有这一条**记录，`config_json.server` 是 `127.0.0.1`。含义：

- 之前所有「连上了东京节点」的证据，连的都是**本地 mock 地址**；
- `18443` 端口当时有没有服务在监听与结论无关 —— 就算有，也不是真实出口；
- **即使退出 MeshFlux，这条 profile 也不可能产生真实出口**。

所以历史所有「连接成功」的证据，只能证明**控制面**（进程起来了、代理设置写对了、工具链路通了），**不构成任何真实网络验证**。这不是新缺陷，是把原有结论的适用范围收窄到它真正能支撑的部分。

### 8.2 当前环境（已实测干净）

| 项 | 值 |
|---|---|
| MeshFlux 进程 | 无 |
| utun 接口 | 仅系统常驻 utun0–utun5 |
| IPv4 默认路由 | `en0` |
| 系统代理 HTTP/HTTPS/SOCKS | 全部 `Enable=0` |
| sing-box 进程 | 无（遗留 10621 已手工清理） |
| 直连出口基线 | **已脱敏**（20:39 独立复核：`ifconfig.me` 与 OpenDNS `myip` 两路一致） |

基线在 G 组执行前由测试 Clerk 独立复核过，不是转述。执行时若实测值与之不同，以现场为准。

基线由 `ifconfig.me` 与 OpenDNS `myip` 两条独立路径交叉确认。**`api.ipify.org` 在本网络不可用，不要用它做判据。**

### 8.3 真实节点来源

已从本地种子文件导入 **2 个美国 Shadowsocks 节点**。该文件不在仓库内；其 server、密码、method 一律**不写入本报告、日志或提交**。

### 8.4 受影响范围（重新表述）

| 用例 | 20:20 时受 TUN 影响 | 现在 |
|---|---|---|
| AC-D1~D6、AC-E1/E2、AC-F1/F2、AC-N1/N2 | ❌ 不受 TUN 影响 | 结论不变 |
| **真实出口 IP / 真实连通性 / 延迟** | ✅ 受影响 | 环境障碍已解除，但**从未验证过**；由用例组 G 首次验证 |

**必须写明的诚实结论**：P1 §9 的「首次连接成功率」「出口 IP 真实值」至今**仍未验证**。环境障碍（P-5）已经解除；证据障碍（`profiles` 里从未有过真实节点）由用例组 G 解除 —— 在此之前，任何关于「Veyl 真实可用」的说法都不成立。

### 8.5 方法学：curl 不受 macOS 系统代理影响

`curl` 只认 `http_proxy` / `https_proxy` 环境变量、`~/.curlrc` 的 `proxy=`、以及显式 `--proxy`。macOS 系统代理（`scutil --proxy` / `networksetup`）对它**完全无效**。

由此得出三条：

1. **裸 curl 不能用来证明「系统代理已生效」**。代理开或不开，裸 curl 都走直连、返回本机出口 —— 这种测法的结论恒为「没变」，与代理是否生效无关。
2. **「系统代理已生效」只能由两条证据合并支撑**：
   - 配置写入 —— `scutil --proxy` 的 `HTTPEnable` / `HTTPProxy` / `HTTPPort`；
   - 链路可用 —— `curl --proxy http://127.0.0.1:<port>` 的实际出网结果。
   缺任一条都不成立。
3. **本报告此前没有用裸 curl 得出过代理结论**（全文已核对，不含 curl 判据）。AC-E1/E2 的结论建立在 `networksetup` 的配置值上 —— 属于第 2 条里的第一项证据，本身成立，但**不覆盖流量走向**。流量走向从未验证，这与 §8.1 的结论一致，不构成新的撤回。

用例组 G 已按此改写：G2 只验配置、G3 用显式 `--proxy` 验流量，并加一步 `--noproxy '*'` 反向直连，两步 IP 不同才算通过。

---

## 9. 用例组 G 执行记录（2026-11-02）

### 9.1 环境与基线（AC-G0）→ **PASS**

20:39，测试 Clerk 独立复核（非转述）：

```
无 MeshFlux / 无 sing-box
HTTPEnable=0  HTTPSEnable=0  SOCKSEnable=0
curl --noproxy '*' ifconfig.me        → 直连基线（已脱敏）
dig +short myip.opendns.com           → 同一地址（已脱敏）
```

两条独立路径一致，作为本次真实网络验证的直连基线。

### 9.2 导入（AC-G1）→ **PASS**

用户把本地种子文件拖进设置页，界面提示导入成功。库中结果：

| id | name | protocol | server | node_id | is_active |
|---|---|---|---|---|---|
| `seed-<hash-1>` | 种子V83 · meshflux69 [美国] | shadowsocks | ≠ 127.0.0.1 | NULL | 1 |
| `seed-<hash-2>` | 种子V83 · meshflux10 [美国2] | shadowsocks | ≠ 127.0.0.1 | NULL | 0 |

断言全部满足：2 条新增、协议 `shadowsocks`、`server` 非回环、`node_id` 为空（种子导入不挂目录节点）。

凭据扫描：

```
SELECT COUNT(*) FROM profiles WHERE config_json LIKE '%"password"%';  → 0
SELECT COUNT(*) FROM profiles WHERE config_json LIKE '%"uuid"%';      → 0
```

### 9.3 连接序列 → 佐证 D-19 修复生效

`tool_calls` 实查（20:47:40–44）：

| 时间 | 工具 | 参数 | 结果 |
|---|---|---|---|
| 20:47:40 | `ProfileList` | `{}` | ok |
| 20:47:40 | `CatalogSearch` | `{"limit":50}` | ok |
| 20:47:41 | `VpnConnect` | `{"profile_id":"seed-<hash-1>"}` | ok |
| 20:47:44 | `RuntimeStatus` | `{}` | ok |

**关键点**：`ProfileList` 在 `VpnConnect` **之前**，且 `profile_id` 是真实存在的 id —— 模型没有凭空猜测。这证明 D-19 的修复在真实路径上生效。

### 9.4 系统代理（AC-G2）→ **PASS**

```
scutil --proxy:
  HTTPEnable=1   HTTPProxy=127.0.0.1   HTTPPort=53211
  HTTPSEnable=1  HTTPSProxy=127.0.0.1  HTTPSPort=53211
  SOCKSEnable=1  SOCKSProxy=127.0.0.1  SOCKSPort=53211

networksetup -getwebproxy "Wi-Fi":
  Enabled: Yes   Server: 127.0.0.1   Port: 53211
```

三者同端口。这一步只证明「配置写进了系统」，**不证明流量走向** —— 见 §8.5。

### 9.5 真实出口（AC-G3）→ **PASS**

20:49，测试 Clerk 在连接仍生效时独立复测：

| 项 | 结果 |
|---|---|
| 经代理正向 | `curl --proxy http://127.0.0.1:53211` → **出口变化** |
| 反向直连 | `curl --noproxy '*'` → 直连基线出口（已脱敏） |
| 地区标记 | `cloudflare trace` → **`loc=US`** |

**正反向 IP 不同**，且地区标记为美国 —— 这是本产品第一次被证明确实把流量从美国出口送出去。

> **脱敏说明**：Shadowsocks 直出时，出口 IP **就是节点服务器地址**。因此「出口 IP 可以写」与「不写节点服务器 IP」在这里冲突，本报告按**更严的那条**执行 —— 不写该字面值。完整值只存在于执行记录，不进入仓库。
>
> 两轮测量（PM 一轮、测试 Clerk 一轮）结论一致，不是单次偶然。

### 9.6 运行时（AC-H2 的先行证据）

`runtime.pid` 内容：

```json
{ "pid": 25915, "binary": ".../runtime/1.14.4/.../sing-box",
  "config": ".../config/profile-seed-<hash-1>.json",
  "started_at": 1793623661770 }
```

- pid 与 `pgrep -f 'sing-box run'` 一致（25915）
- **`started_at` 是 13 位毫秒** —— D-06 修复在真实连接路径上也生效了，不只是测试路径
- **21:30 第二次连接复现**：`started_at = 1793626229639`（13 位），pid 与进程一致 —— 两条独立连接都是毫秒
- 断开后该文件被清除（见 §9.7）

### 9.7 AC-G4（断开后还原）→ **PASS（实机 21:31）**

**21:31 用户主动在对话里断开**，机器侧证据（测试 Clerk 复检本机状态）：

| 检查项 | 结果 |
|---|---|
| sing-box 进程 | **已退出** |
| 系统代理 `HTTPEnable` / `HTTPSEnable` / `SOCKSEnable` | **全部 0** |
| `config/` 目录 | **完全为空**（0 个文件） |
| `runtime.pid` | **已清除** |
| 直连出口 | 恢复为直连基线 |
| 日志 | 21:30 写入 json 与 meta，**21:31:30 删除** |

**为什么这条此前判「未验证」**：20:49 时应用仍在连接状态；之后那次断开是 `tauri dev` 重建时**硬杀应用**导致的，走的是启动时 `recover_stale` 复原，属于「异常退出后恢复」路径，与用户主动断开**不是同一段代码**。

| 路径 | 触发方式 | 覆盖的用例 |
|---|---|---|
| `recover_stale` | 崩溃 / 强杀后重启 | AC-E2（PASS） |
| **用户主动 disconnect** | **对话里说断开（21:31 实际执行）** | **AC-G4（PASS）** |

这次是真的走了主动断开路径，所以 AC-G4 成立。

### 9.8 库内残留：历史 mock profile

`prf_seed-jp-01`（`127.0.0.1:18443`，`is_active=0`）仍留在 `profiles` 表里。

不影响本轮结论（它是 active 切换后的非活动项），但**交付给内测用户前应清理** —— 否则用户可能选中一个永远连不上的节点，且界面不会告诉他为什么连不上（叠加 D-20，连出口都不会显示）。

### 9.9 提交前阻断：节点地址被写进了测试代码

扫描工作区发现：

```
src-tauri/src/runtime/health.rs:181,182,190,191,202,203
```

`ExitIpProbe` 的 6 处单测断言用了**本次连接的真实出口 IP** 作为样例值 —— 而对 Shadowsocks 来说，这个值就是节点服务器地址。

**这是仓库卫生问题，不是 App 缺陷**，但后果比缺陷严重：一旦提交，节点基础设施地址就永久进入 Git 历史，且无法通过后续删除抹掉。

| 项 | 状态 |
|---|---|
| 是否已提交 | **否** —— `git show HEAD:src-tauri/src/runtime/health.rs` 中不存在这些行 |
| 是否仍可挽回 | **是** —— 现在改，历史干净 |
| 建议改法 | 换成 RFC 5737 文档地址（`203.0.113.10` / `198.51.100.7`），断言语义不变，测试等价 |

本报告按要求**不复述该字面值**；需要定位时按上面的文件与行号查工作区。

**处置（PM 本轮指示）**：已派 Bob 改为 RFC 5737 文档地址，并自查本轮改动里是否还有别的真实地址。测试 Clerk **不改代码**（`health.rs` 是 Bob 的文件，同时写会撞）。

**已转为强制门禁**：`docs/acceptance-p1.md` 新增 **AC-S1 提交前敏感信息扫描**，扫工作区 / 暂存区 / 未跟踪文件，接入 `ci.sh` 作为硬失败项。这条比修一次更重要 —— 它把「靠人记得」换成了「流程保证」。

### 9.10 文档脱敏：用户本机公网出口 IP

同一轮里发现第二处泄漏：验收文档正文写入了**用户本机直连公网出口 IP** —— 那是宽带运营商分配的真实地址，写进仓库等于公开用户的实际位置与运营商。

| 项 | 结果 |
|---|---|
| 出现位置 | 7 处（PM 复核；测试 Clerk 实扫为 8 处，含代码块内 2 行） |
| 处理 | **全部按语义脱敏**，不保留字面值 |
| 是否已提交 | **否** —— `git log -S` 全历史为空 |
| 保留的定性结论 | 「经代理出口与直连出口不同」「`loc=US`」**原样保留** —— 那才是验证证据 |

**脱敏不影响任何结论成立**：验证需要的是「两个出口不同、其中一个是美国」，不需要知道具体是哪两个地址。

**教训**：脱敏指令与「记死基线」曾经冲突过一轮 —— 前者是对的。凡是真实地址类信息，默认不落仓库，无论它在哪份文档里。

---

## 10. 已知问题 / P2 待办

> **这一节全部不在本轮修复范围。**
> 其中 **#9 是有意保留的取舍**（不是待修项，见下方说明）；其余是待办。
> 只写事实和后果，不评优先级 —— 判断留给后续排期的人。
> 这些**不是「已修复」**，也不代表「不影响发布」。它们是「这次不做，但要知道会发生什么」。

| # | 问题 | 位置 | 事实 | 后果 |
|---|---|---|---|---|
| 1 | 启动阻塞主线程 | `lib.rs:76` `block_on(manager.reclaim_stale())` | 回收遗留进程在主线程同步等待；SIGTERM 宽限 `stop_grace = 5s`（`manager.rs:187`） | 最坏约 **5 秒**后窗口才出现，期间没有任何进度提示，用户可能以为应用没启动 |
| 2 | 退出阻塞事件循环 | `lib.rs:123-124` `block_on(async { exit_manager.stop().await })` | 同上，同步等 sing-box 退出 | 退出时界面卡住，最坏约 5 秒；用户容易重复点击或强杀 |
| 3 | `runtime.pid` 永久残留 | `manager.rs:591-596` | `ps` 取不到命令行时只 `warn`，**不清除** pid 文件就返回 | 之后每次启动都重试同一个 pid，日志反复出现同一条警告，真正的回收问题会被噪音淹没 |
| 4 | 出口探测依赖第三方 | `health.rs` `DEFAULT_EXIT_IP_PROBE = "https://ifconfig.me/ip"` | 每次连接都**经代理**访问该地址 | 向第三方暴露「此用户在用 VPN」这一事实。**叠加 D-20**：值根本没被展示，请求照发 —— 当前收益为 0 |
| 5 | 导入非原子 | `seed_import.rs:211` 先 `upsert` profile，`:236` 再 `set_secret` | 凭据写入失败时 profile 行已经提交 | 库里出现「看得见但连不上」的节点；用户看不到原因，只会反复重试 |
| 6 | **Windows 上 D-17 的回收不生效** | `process.rs:118-127`（`tasklist`）、`process.rs:140-157`（`matches_launch`） | Windows 的 `command_line` 只返回 `tasklist /FO CSV` 的镜像名，**拿不到完整命令行**；而 `matches_launch` 要求命令行以二进制**绝对路径**开头、且包含**配置路径** → 必然不匹配 → 回收一律跳过 | Windows 用户重启后仍会留下孤儿 sing-box，占端口、需手动 kill。本轮只加明确 warn 让跳过不静默，完整回收列为 P2 |
| 7 | 部分成功不告诉用户一半结果 | `seed_import.rs:211-236` + 导入结果提示 | 凭据写入失败时，UI 只说「凭据保存失败，请重试」，**不说已经成功导入了几个** | 用户不知道处在什么状态：重试可能重复导入，不重试又担心漏了节点。错误信息只说「失败了」，不说「失败到哪一步」 |
| 8 | `remove_all_profile_configs` 漏掉 `active.json` | `config` 清理逻辑只匹配 `profile-*.json` | selftest 用独立 `--data-dir`，会写 `active.json`，清理时匹配不到 | 当前**无实际影响**（selftest 的 data-dir 是一次性的）。但这是一条「清理规则与命名约定不一致」的隐患，将来若 `active.json` 进入主数据目录就会漏清 |
| 9 | **切换节点失败后需要手动重连** | `services.rs` `connect`：渲染 B**之前**就删除 A 的明文配置 | 连着 A 不经断开直接连 B，若 B 在启动前失败（目录不可达等）：A 的 sing-box 仍在跑（配置已载入内存），但配置文件已不存在；A 若随后崩溃触发自动重启，会因配置缺失而重启失败 | 用户需要手动重连。**这是有意为之的取舍，不是待修缺陷** —— 理由见下 |

**#9 的取舍（也是有意的，不是待修问题）**：两种做法——

| 做法 | 好处 | 代价 |
|---|---|---|
| **先删 A 的配置，再渲染 B**（现方案） | A 的明文密码**立即消失** | B 启动前失败时，A 进程还在但配置已删；A 崩溃后无法自动重启，需手动重连 |
| 等 B 启动成功后再删 A | 切换失败不影响 A | B 失败时，A 的明文密码**继续留盘**到下次启动扫描 |

选前者：用「可恢复的重连麻烦」换「明文凭据少留一段时间」。后者正是 D-22 要消灭的情况。

**孤儿回收不受影响**：`matches_launch` 比对的是 `runtime.pid` 里记录的路径字符串与进程 argv，**不检查文件是否存在**。配置删了，遗留进程照样能被识别和回收。

**验收提示**：用户实测切换流程时，如果遇到「切换失败后需要重连」，那是**设计内行为**，不要记成缺陷。

**#6 的取舍（有意为之，不是遗漏）**：不改用「只匹配镜像名 `sing-box.exe`」来绕过 —— 用户机器上完全可能装着别的基于 sing-box 的 VPN 客户端（如 MeshFlux 一类），只按镜像名判断会**杀掉别人的进程**。

> 宁可留下一个孤儿（占端口、需要手动 kill），也不能杀错进程。这是「漏杀」与「误杀」之间的选择，选漏杀。

**顺带一处不一致**：`process.rs:120` 的注释仍写着「用 tasklist 取镜像名（`sing-box.exe` 足够确认身份）」，与现在 `matches_launch` 的严格校验矛盾。注释描述的是被否决的方案，容易误导后来人。

### 10.1 与其它缺陷的关系

- **#4 与 D-20**：D-20 让 `exit_ip` 显示不出来，所以这条探测**现在没有任何用户可见收益**，但第三方请求一次不少。修 D-20 之后收益才回来。
- **#3 与 D-17**：D-17 是「该杀的没杀」，#3 是「该清的文件没清」。两者都会让启动时的回收逻辑反复重试，排查时容易混。
- **#6 与 D-17**：D-17 的**平台完成度**由 #6 决定 —— macOS 已修复并验证，Windows 未修复。看到「D-17 已修复」这句话，必须追问是哪个平台。
- **#9 与 D-22 / D-27**：#9 是 D-27 的直接副作用 —— 为了让旧明文配置「立即消失」，就得在渲染新配置之前删它。同一个决定的两面：安全上更干净，可用上多一点麻烦。
- **#5 与 D-22**：都涉及「配置与凭据必须一致」。D-22 管连接后的残留，#5 管导入时的不一致。

### 10.2 记录口径

这几条**没有写入任何用例的失败判定**，也没有计入放行阻断项。原因是它们都不表现为「功能不可用」，而是性能、隐私或可维护性问题 —— 拿功能用例去判它们，只会得到一堆说不清的 FAIL。

如果后续要验，应该单独建一组性能 / 隐私用例，而不是塞进 P1 的功能验收里。

---

## 11. 行为变化：目录导入的 profile 依赖目录服务在线（D-22 的代价）

D-22 关闭了「渲染配置常驻磁盘」这条明文凭据路径。代价必须写清楚：

| profile 来源 | 凭据存在哪 | 连接时怎么拿 | 目录服务不可达时 |
|---|---|---|---|
| **种子导入**（`node_id` 为空） | 本地 `secrets.enc` 的 `node:<profile_id>` | 直接读本地 | **仍可连接** |
| **目录导入**（`node_id` 非空） | 只在目录服务 | 每次连接请求 `catalog_detail` | **无法重连** |

代码依据（`services.rs` `connect`）：`node_id` 为 `Some` 时只调目录、**没有本地回退**；为 `None` 时走 `seed_build_input` 读本地加密存储。

**这不是 bug，是必然结果**：本地没有副本可用了。之前能重连，靠的正是那份不该存在的明文缓存。

**影响范围不止 `VpnConnect`**：`RuntimeStart` 走的是同一个 `connect` 路径，所以同样受「每次连接必须请求目录」的约束。凡是触发启动运行时的入口，都在这条限制里。

**一个之前没注意到的推论**：节点在目录里**下线之后，连重连都不行了** —— 不是因为连不上，而是因为拿不到凭据。对安全是好事（下线即失效，不给旧凭据留后门），对可用性是新约束：**用户手里那个「昨天还能用」的节点，今天会突然报错，而错误看起来像故障**。

### 11.1 用户需要知道的差异

断网、目录服务故障、服务端限流时：

- **种子节点照常可用** —— 凭据在本地
- **目录节点连不上** —— 而且错误会表现为「目录不可用」，不是「节点坏了」

这个区别要在用户文档里讲清楚，否则用户会以为是节点质量问题，反复换节点、反复失败。

### 11.2 为什么不顺手把离线缓存做了

做离线缓存就得把凭据存到本地 —— 而「凭据存本地要不要加密」正是 D-22 撕开的问题。真要离线可用，需要一套**加密的目录凭据缓存**，属于 P2 的设计工作，不是补几行代码的事。

### 11.3 对验收的影响

- AC-G1 导入的节点属于**种子来源**，所以 G 组结论不受这条变化影响
- 目录来源的连接路径本轮从未验证过（D-10 那一轮 `CatalogSearch` 本身就无法通过）
- 以后设计目录 profile 的用例时，必须保证**目录服务在线**，否则测出来的是「目录挂了」而不是被测功能失败

### 9.11 历史记录里仍有用户名（**未解决**，待决策）

| 项 | 状态 |
|---|---|
| 历史提交 | `abce30c` 引入，`ab76ef2`、`8b79e8c` 仍含 —— 用 `git log -S` 搜家目录用户名可查到三处（本报告不复述该字面值） |
| 当前工作区 | **已清理**：全仓 grep 为 0（排除 `.git` / `target` / `node_modules`） |
| 是否重写历史 | **未做，待用户拍板** |

**涉及位置（已改写）**：`docs/build-and-release.md` 3 处、`docs/multi-provider.md` 1 处，原来写的是参考工程的真实用户路径。已改为只描述工程与目录，不带用户名。

**为什么没有顺手重写历史**：`filter-branch` / `filter-repo` 会重写所有 commit hash，所有克隆、分支、PR 都要重新对齐 —— 这是破坏性操作，必须由用户明确同意，不能在验收过程中替他们决定。

**所以这条不能写成「已解决」**：新提交是干净的，但历史里仍然查得到。是否可接受，取决于仓库将来会不会公开、以及有没有别人已经克隆过。

### 10.3 方法学：一次 review 不够

第二轮架构 review 在**同一批代码**里又找出 6 条问题（D-26 ~ D-31），其中 3 条 P1 —— 第一轮 review 已经看过这些文件。第三轮换了方法，把这批现象收敛成一个根因（D-32）。

这不是「第一轮不用心」，而是 review 的性质决定的：

| 轮次 | 看什么 | 能发现什么 |
|---|---|---|
| 第一轮 | **结构**：接口、职责、契约完整性 | 「有没有这个能力」 |
| 第二轮 | **时序与失败路径**：退出 / 切换 / 并发 / 写一半失败 | 「能力接没接对」 |
| 第三轮 | **穷举某个状态的全部进入 / 退出路径** | **根因** —— 多个现象背后的同一个缺口 |

D-26（退出不解代理）、D-27（切换不清旧配置）、D-28（guard 创建时机）都不在任何一条正常路径上。只看接口和调用关系发现不了，必须沿着「**如果这一步失败了会怎样**」走一遍。

**第三轮换的是方法，不是更努力。** 不再逐条读代码，而是穷举「系统代理」这一个状态的所有开启点与关闭点。此前看起来像一堆独立问题（D-26 退出不解、D-30 并发校验缺失，以及 D-32 的四个实例），穷举之后收敛成同一个缺口：**开启点只有一个，却没有与之对应的失败回滚**。

> **逐条看代码能发现现象，系统性穷举状态机才能发现根因。**
> 前两轮找到 7 个现象，第三轮把它们收成 1 个根因 —— 这个收敛本身就是第三轮最大的产出。

### 对后续的启示

1. **别把「review 过了」当成状态位。** 同一份代码，第二轮、第三轮还能找到东西。
2. **按失败路径 review 比按文件 review 有效。** 以「退出」「切换」「并发 stop」「写一半失败」为入口各走一遍，命中率远高于按模块顺序通读。
3. **每轮 review 必须有不同切入角度。** 否则只是把同样的东西再看一遍，产出接近 0。

**这条同样适用于验收**：本报告里多数 P1（D-17、D-20、D-22、D-26）都不是「功能没做」，而是「做完了，但某个边界没接上」。正常路径全绿，不代表可以放行。

### 9.12 新扫描器首次运行：又抓到 4 处节点 id

`scripts/test/secret-scan.sh` 第一次跑工作区时，除预期的 `/Users/x/` 夹具外，还抓到**本报告里的 4 处真实节点 id**（`seed-` + 16 位十六进制），来源是：

- AC-G1 的导入结果表（2 处）
- AC-G3 的 `tool_calls` 参数（1 处）
- `runtime.pid` 的配置文件名（1 处）

已全部替换为 `seed-<hash-1>` / `seed-<hash-2>`。

**这说明扫描器是有效的**：它抓到的不是我们事先想到要检查的东西。规则列得再全，也比不过「真跑一遍」—— 这轮已经证明过三次（节点 IP、本机出口 IP、节点 id）。

另：文中出现的 `sk-` 开头假 Key 是界面提示的原文示例，已按约定加 `check-secrets:allow` 行内标注。两个扫描器共用同一个标记，一次标注两边都认。

**CI 接入（已定稿）**：`scripts/ci.sh` 现为**八步**，第 1 步 `check-secrets.sh`（凭据文件形态）、第 2 步 `secret-scan.sh`（信息泄漏），两步都是硬失败；`--quick` 覆盖前 6 步。

两者**不合并**：失效模式不同（「不该进仓库的文件进来了」vs「该保密的值写进了正文」），合并会把两件事搅在一起，还会动到已接好的 git hook。两个脚本头部各写了职责边界，新规则加到哪里一目了然。

**规则调整原则：封闭清单，不要开放模式。**

为了让一个测试夹具（`clash_secret: "new-secret"`）通过，一度加过「整串都是小写连字符词组就放行」的规则 —— 那会把 `correct-horse-battery-staple` 这类**口令短语**整类放过，正是最典型的强密码形态。

已改为**封闭字面量清单**：只有与清单完全相同才放行，新增一条都要人工判断一次。

> 扫描器的价值在于「每一次放过都是有人决定的」，而不是「规则能自动覆盖当前树」。
> 前者会随着使用变强，后者会随着放宽变没有。

### 9.13 切换节点（AC-G6 / D-27 / D-36）→ **PASS（实机 21:40）**

用户**不先断开**，直接从第一个节点连第二个节点。测试 Clerk 独立复检本机状态：

| 检查项 | 结果 |
|---|---|
| 两次 `VpnConnect` 的出口 | 都有值，且**互不相同** |
| sing-box 进程 | pid 6141，启动时间 21:40:33，与第二次连接时刻一致 |
| 监听端口 | `127.0.0.1:60655`（mixed）、`127.0.0.1:61525`（clash） |
| 系统代理 | `HTTPEnable=1`，`HTTPPort=60655` —— **与新进程 mixed 端口一致** |
| `config/` | 只有 1 组 json + meta（第二个节点的），**第一个节点的已删除** |
| `runtime.pid` | pid 与运行进程一致；`started_at` 13 位毫秒 |

**三条结论**：

1. **AC-G6 PASS** —— 切换确实换了运行时，不是只改了界面状态
2. **D-27 PASS** —— 旧节点的明文配置在切换后不在磁盘上
3. **D-36 PASS** —— 报告与实际一致（判据是端口对得上，不是返回值变了）

> 出口地址按纪律不写字面值；「两次出口不同」这一事实来自数据库里两次 `VpnConnect` 返回值的比较，未复述具体地址。
