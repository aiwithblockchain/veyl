# 任务：删除期望状态轮询，升级改为界面触发

> 日期：2026-11-26
> 状态：已实现，评审批次二 delta 通过（2026-11-26），待协调会话按批提交
> 负责人：Soren（架构调度）｜实现：App 会话 + 服务端会话｜交叉评审：独立会话

---

## 0. 一句话

删掉 agent 定时拉 `desired-state` 的轮询；把 sing-box 升级改成「详情页显示当前版本 + 检查升级按钮」，经 agent 控制端口执行。

---

## 1. 为什么

- 轮询现在只服务两件事：把新的 sing-box 版本送到节点、以及服务器注销后返回 409 让 agent 停药。两件都不是实时需求。
- 升级本来就不该由平台定时推动：节点是一次性的，重建就是升级；真要升，让用户自己点。
- 轮询的代价是每台机器每天都在打控制面接口，收益接近于零。

**非目标（明确不做）**：不做强制升级、不做自动升级、不做在线检测/心跳/看门狗。

---

## 2. 现状（代码事实）

| 事实 | 位置 |
|---|---|
| agent 每 `poll_interval_secs` 拉一次 `GET /v1/agent/desired-state` | `agent/src/agent.rs` 的 interval 循环 |
| 响应含 `port` / `password` / `control_port` / `singbox{version,sha256,url}` | `cloudflare/control-plane/src/servers.ts` `agentDesiredState` |
| 拉到的期望状态与本地不同就应用（含升级） | `agent/src/rotation.rs` `apply_if_needed` |
| 服务器已注销返回 409，agent 收到后停掉轮询 | 同上，`ControlError::Status{409}` |
| 轮换**不走**轮询：App 直连 agent，agent 再上报 | `agent/src/rotation.rs` `rotate_inner` |
| `servers.singbox_version` 由每次 report 维护 | `servers.ts` `agentReport`；控制面行已有该列 |
| `MyServer` 类型**尚未**包含 `singbox_version`（控制面行有值、App bridge 类型已可选读取） | `commands.md` §7.15 `type MyServer`；`src/agent/bridge.ts:726`、`tauriBridge.ts:968` |
| 详情页已有 `singbox_version` 的测试夹具，`ServerProgress.tsx` 用它显示安装中文案 | `MyServerDetail.test.tsx:696`、`ServerProgress.tsx:123` |
| `commands.md` 当前版本 **2.74.0**，本批应升 **2.75.0**（任务初稿写的 2.65.0 已过期） | `commands.md` 文件头 / §15.5 |
| agent 的 MCP 目前只暴露 `rotate_credentials` | `agent/src/server.rs` |
| 默认轮询间隔工作树里已先改为 3600 秒（未提交）；本批会整体删除 `poll_interval_secs` 字段与配置校验 | `agent/src/config.rs` |

---

## 3. 目标

### 3.1 节点 agent（服务端会话）

1. **删除定时轮询**：只保留启动时的一次 `desired-state` 拉取（装机需要），之后不再周期请求。主循环仍要保留 `ctrl_c` 与 MCP 任务监督（`supervise_mcp`），不能因为删 interval 把进程保活/退出路径一起删掉。
2. **删除配套逻辑**：409 停药（`poll_paused_until`）、`pending_rotation` 追赶分支、以及只为轮询服务的日志（点名：启动横幅的 `poll_interval_secs`、每轮 `desired-state unchanged`、409 停药提示）。**启动时**遇到 409 记录后**继续用持久化状态服务、不再重试**（没有轮询就没有停药；不是退出）。`poll_interval_secs` 字段与 `config.rs` 的 `5..=3600` 校验一并删除（`AgentConfig` 没有 `deny_unknown_fields`，旧配置文件仍可加载）。
3. **`active_unconfirmed` 改为行为、不保留持久化标志**：现有字段与 `is_active_unconfirmed` / `set_active_unconfirmed` 一并删除。替代：**启动时若 `last_desired` 存在就先补报一次 `active`；每次 MCP 调用（轮换 / 升级）前再 best-effort 补报一次**。控制面对已 active 机器重复 `active` 是幂等的（`already_active`），调用方不因补报失败而失败。这仍能修复「`apply_desired` 成功但 `report active` 失败」导致控制面停在 installing 的情况，同时不留一个永远为 true 的脏标志。
4. **保留公网 IP 探测的启动重试（计次，不无限）**：现在它挂在轮询 tick 上（`agent.rs:271-289`），删轮询后会丢；启动时元数据探测失败的节点会永久缺公网 IP 的 SAN 与 Host 白名单，桌面端连 32100 会被 403。改为**启动后最多 3 次、间隔 60 秒重探，成功即停；3 次都失败就停止重试**，不要留一个永不退出的 60 秒循环。
5. **新增 MCP 工具 `upgrade_singbox`**：
   - 入参 `{}`，**不接受 URL / 版本号 / 哈希**（App 能传就等于能往节点装任意二进制）。
   - 执行：用自身 `server_token` 现场请求一次 `desired-state` → 拿到目标 `version/sha256/url` → 与**本地已安装二进制的实际版本**比较（不是只读 `state.json` 里的记录）→ 相同则返回 `upgraded:false`；不同则下载、校验 sha256、替换、重启、自检、上报 `active`。
   - **不调用 `apply_desired`、不重写 config**：升级只做 `ensure_binary` + `restart` + `verify` + `report active`。`apply_desired` 内部自己 `try_lock`，且会按 desired 重写端口与密码，不属于升级语义。
   - **旧二进制备份与回滚**：替换前把现有二进制备份为 `<binary_path>.bak`；restart / 自检失败时换回旧二进制并重启，返回 `fatal`，成功后再删除 `.bak`。否则新二进制起不来就是停机，旧版本已经没了。
   - **上报用重试**：`active` 上报复用 `report_with_retries`（现有 5 次指数退避），不是裸一次；仍失败则等下一次启动或 MCP 调用补报（不落持久化标志）。
   - **不产生 installing / verifying 上报**：升级只在结束时报 `active`（或失败时 `failed` 且带当前版本），避免控制面 `singbox_version` 提前跳到目标值。**`failed` 只对已经 active / healthy 的节点上报**；`booting` / `installing` / `verifying` 的机器即使被调用也**不报 `failed`**，只返回工具错误——否则一次误调用会触发控制面销毁。
   - 目标版本低于已装版本时仍按控制面的期望状态执行（允许降级）；这是「以控制面为准」的取舍，不做额外版本排序。
   - 返回 `{ installed, target, upgraded }`；失败不销毁机器、不清凭据；新二进制起不来时回滚旧二进制，节点继续按旧版本服务。
   - 与轮换互斥：busy 锁只在升级入口拿一次；另一件写操作在跑时立即返回 `agent_busy`（`kind = "retryable"`，失败信封的 `reason` 字段带 `agent_busy`，Host 透传到 `details.reason`）。
   - 整个升级（下载 + 重启 + 自检）上限 **180 秒**，超时按 `agent_timeout` 处理。

### 3.2 控制面（服务端会话）

1. `desired-state` 保留原样（启动与按需调用都用它）。
2. `MyServer` 暴露 `singbox_version`（该列已存在并有数据；**`servers.ts` 的 `toMyServer` 返回体当前没有带出该列，需补一行 `singbox_version: row.singbox_version ?? null`**）。口径：**= 节点最近一次上报的版本，不保证等于正在运行的版本**；升级不产生 `installing` / `verifying` 上报，失败时要上报 `failed` 且带当前版本，避免该列停在目标值。
3. 契约 `docs/contracts/commands.md` 升 **2.75.0**（当前 2.74.0）：`MyServer.singbox_version: string \| null`、新命令 `node_upgrade_singbox`、agent 工具 `upgrade_singbox`。**契约由服务端会话落笔，App 会话只读不写。**

### 3.3 App（App 会话）

1. 详情页事实区新增一行：`sing-box 1.14.4　[检查升级]`；取不到版本时显示 `未知`，按钮仍可点。**入口只对 `active` / `healthy` 展示**（与重置凭据同口径）；`destroying` / `destroyed` / 装机中都不显示。命令本身不做来源校验，鉴权由账户令牌与控制面完成。
2. 点击 → 复用重置凭据那条通道：向控制面取一次性 agent 门票 → 连 agent 控制端口 → 调新工具。
3. 结果就地反馈，三态：`已是最新（1.14.4）` / `已升级到 1.15.0` / 失败按错误码给文案。成功后用工具返回的 `target` 就地更新这一行，再触发一次 `my_server_get` 同步控制面（上报可能晚于结果）；版本列以「最近一次上报」为准。
4. 进行中按钮禁用并显示进行中文案；不弹窗、不跳页。**升级会重启节点，当前连接会短暂中断**——进行中文案要说清楚，不要写成无感操作。
5. 新增 Tauri 命令 `node_upgrade_singbox(server_id)`，返回 `{ installed, target, upgraded }`，失败走统一错误信封；超时 180 秒（下载 + 重启 + 自检），失败原因沿用 `agent_token_unavailable` / `agent_tls_untrusted` / `agent_token_rejected` / `agent_tool_failed` / `agent_busy` / `agent_timeout` / `agent_unreachable` / `agent_bad_response`。
6. 焦点与切服务器：完成后焦点回到升级按钮；请求在途时换服务器，结果丢弃、不解锁新面板（与轮换的 `serverIdRef` / `restoreRotateFocus` 同处理）。
7. 版本未知时只显示「未知」+ 按钮，不把「未知」当成事实渲染成常驻行；版本有值时才显示版本号。

---

## 4. 文件边界（防并发冲突）

| 会话 | 独占文件 |
|---|---|
| App | `src/components/MyServerDetail.tsx`、`src/components/MyServerDetail.test.tsx`、`src/myservers/upgradeSingbox.ts`（新建，可参照 `rotateCredentials.ts` 但不改它）、`src/i18n/zh.ts`、`src/i18n/en.ts`、`src/i18n/errorText.ts`、`src/agent/bridge.ts`、`src/agent/tauriBridge.ts`、`src/agent/tauriBridge.myServers.test.ts`、`src/agent/mockAgent.ts`、`src-tauri/src/control_plane/servers.rs`、`src-tauri/src/agent/commands.rs`、`src-tauri/src/agent/upgrade.rs`（新建）、`src-tauri/src/tools/node_rotate.rs`（**只允许抽出共享的 agent 门票 / TLS / MCP 调用**，不改轮换行为与错误 reason）、`src-tauri/src/tools/mod.rs`（仅新增 tools 模块时）、`src-tauri/src/lib.rs` |
| 服务端 | `agent/**`、`cloudflare/control-plane/**`、`docs/contracts/commands.md`、`docs/design/node-agent-mcp.md` §8 / §11（agent 工具面从 1 个变 2 个） |
| 协调（Soren） | 本文档、`docs/status.md`、提交 |

- 同一个文件不允许两个会话同时改。需要跨界改动的，先在会话里报告，由 Soren 决定归谁。
- 子会话**不提交**；由协调会话统一提交。

---

## 5. 依赖顺序

1. 服务端会话先定契约（`MyServer.singbox_version` 字段名 + 新命令签名），贴到本任务线程里。
2. App 会话按契约实现，可先用 mock bridge 推进，不阻塞。
3. 服务端会话完成 agent 侧后，App 联调走 dev 节点。
4. 交叉评审会话在两边都报「代码可看」之后开始，产出分级意见。

---

## 6. 验收

1. 节点上抓不到周期性请求：除启动时的一次 `desired-state` 与最多 3 次公网 IP 重试外，控制面日志无规律轮询。
2. 详情页显示 `sing-box <版本>`；版本缺失时显示 `未知` 且按钮可用；销毁中/已销毁/装机中不显示按钮。
3. 点「检查升级」：
   - 已是最新 → 显示「已是最新」；
   - 有新版本 → 节点完成升级，详情页就地显示新版本；再点一次读到同一版本，控制面 `singbox_version` 同步更新。
4. 升级失败：机器不销毁、凭据不变；新二进制起不来时回滚 `.bak` 并重启，节点继续按旧版本服务，界面给出失败原因。
5. 升级与轮换互斥，不会同时进行；后到的返回 `agent_busy`；升级不改端口与密码。
6. 无人操作 24 小时内，agent 对控制面的定时请求数为 0（只有启动那次与公网 IP 重试）；用 agent 日志或控制面日志计数。
7. 升级成功但 `active` 上报重试后仍失败：工具仍返回本地 `installed`，控制面版本在下一次成功上报后更新，界面不误报失败。
8. 装机中（booting/installing/verifying）不出现升级入口；该状态下调用命令不应触发 `activateServer` 或销毁。
9. 自动化锚点（引擎级，2026-11-26 与实现对齐）：`apply` / `rotate` / `reannounce` 全跑一遍后 `ControlApi::desired_state` 调用数为 0，只有 `upgrade_singbox` 拉一次；`agent::run` 暂无可注入 harness，不要求推进真实时间。
10. `apply_desired` 成功但 `report active` 重试仍失败时，重启 agent 或下一次 MCP 调用会补报 `active`；不依赖持久化标志，也不会让机器在服务却被 sweep 销毁。

---

## 7. 风险与已知取舍

- 删除轮询后，**老节点不会自动升级**，只能由用户点「检查升级」或重建机器。已拍板接受。
- sing-box 出安全漏洞时无法强制覆盖，只能靠用户操作或重建。
- 升级需要 App 与节点同时可达（用户在场）。
- 公网 IP 重试 3 次仍失败时放弃；该机器桌面端连 32100 会被 403，升级与重置凭据都不可用，直到 agent 重启后再试。
- `singbox_version` 是「最近一次上报的版本」，不保证等于正在运行的版本；升级失败会尽量上报 `failed` 纠正，控制面不可达时可能短暂滞后。

---

## 8. 评审批次二处理清单（2026-11-26）

所审指纹（批次二原文）：`HEAD e59416a`，`git diff` SHA-256 `6014ce35…8f6fe17a`；完整意见在共享笔记 `review-singbox-upgrade-batch2-2026-11-26.md`。
**最终指纹（delta 通过）**：全量 `5c76ceaca10c9a4f7a64c33493eb03031692c0c3fea15faea667ef1d068d1b49`；服务端子集 `ba329fdcbc70d0ad5cad0c64f73be39848a8743766f9fe5b51c00b8ebd63535a`；App 子集 `5b33a5b81028c9812604da7fcd0dfafea6f65298018b8c4d597431ffc6613d73`；`HEAD` 仍 `e59416a`，未提交。

| 级别 | 项 | 处理 |
|---|---|---|
| P1 | 回滚失败后仍无条件删 `.bak`，下次 backup 会用坏二进制覆盖 | 已闭合：restore 失败保留 `.bak`，backup 复用不覆盖；契约同步 |
| P2 | App `singbox_version` 注释旧语义 | 已闭合 |
| P2 | `agent_token_unavailable` 合并成「节点未准备好」 | 已闭合：App 单列「控制面不可达」 |
| P2 | 已是最新时 no-op 不上报，版本列无法自愈 | 已闭合：no-op 也 best-effort 报 `active` |
| P2 | 覆盖运行中二进制依赖 `install` 的 ETXTBSY 行为 | 已闭合：tmp + rename 原子替换 |
| P2 | `reannounce_active` 在 busy 锁外同步跑，最多耗 20 秒 | 已闭合：补报单独 5 秒超时 |
| P2 | `report_failed` 可能把字符串 `"unknown"` 写进版本列 | 已闭合：未知时不带该字段 |
| P3 | 测试标题 2.65.0、日志前缀、`onRenamed` 语义、README 限定、`last_desired` 端口密码、`after != current` 的 `None` 语义 | 已顺手修测试标题 / 日志前缀 / `onRenamed` 注释 / README / `None` 三分支；`last_desired` 端口密码漂移仍留待后续 |
| P3 | `(Some,Some 相同)` 分支会删掉「上次 restore 失败遗留的复用备份」 | 触发路径很窄（遗留备份 + 本次未换二进制 + 两次版本都可读）；记录，不为它再动指纹 |

---

## 9. 提交纪律

- 只在 `main` 上改，不建分支。
- 子会话不 commit；Soren 确认两边都完成后，由协调会话按批次提交（App 批、服务端批分开）。
