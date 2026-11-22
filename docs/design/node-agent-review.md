# 交叉评审：节点自救（agent + MCP）

> 日期：2026-11-21
> 所审：工作区未提交改动，HEAD `7c311a3`（已提交的共享防火墙 `edd46c3` 作背景）。
> 范围：控制面 `cloudflare/control-plane/{src,test}`、新项目 `agent/`、桌面端 `src-tauri/src/tools/node_rotate.rs` 与注册/契约、前端四单相关 hunk。
> 依据：`docs/design/node-agent-mcp.md`（§5 契约、§6 TLS、§8 工具、§12 决策）、`shared-firewall.md`、`node-rotation-and-sync.md`、`docs/contracts/tools.md`。
> 方式：只读。未改代码、未提交、未运行编译与测试（项目规则）。Rust 侧 API 已对照 `~/.cargo/registry/.../rmcp-1.8.0` 源码逐条核对；编译期结论未经真编译验证。

## 结论

核心安全链路成立：令牌只存哈希、密码只经鉴权通道下发、`rotated` 不销毁、轮换失败回滚、日志脱敏、自签 CA/指纹两条信任路径都能构造。发现 **3 个阻塞**（1 个测试必红、1 个端到端不可用、1 个会误杀健康机器）与 8 条应修。

---

## 阻塞（合并前必须修）

### B1 [测试必红] 新工具没进 `TOOL_COPY`，`toolDisplay.test.ts` 集合相等断言必失败

- 位置：`src/components/toolDisplay.ts:81`（`TOOL_COPY`），校验在 `src/components/toolDisplay.test.ts:22-30`（`new Set(contractToolNames())` 必须与 `TOOL_NAMES` 相等）。
- 现状：`docs/contracts/tools.md` §3 已登记第 41 条 `NodeRotateCredentials`，`TOOL_COPY` 仍是 40 条；`TOOL_NAMES = Object.keys(TOOL_COPY)`，因此断言失败。同时该工具在界面上会走 `FALLBACK_COPY`，没有「进行中/完成/失败/建议」文案。
- 影响：前端测试必红；即使绕过测试，工具卡只显示「正在处理…/已完成」这类通用文案，与 §3「键集合必须与 §3 一致」冲突。
- 修法：在 `TOOL_COPY` 加 `NodeRotateCredentials` 四项（running / done / failed / advice），并补齐 `src/i18n/{zh,en}.ts` 同名键（两份字典当前各 1241 条且完全对齐，别破坏对齐）。

### B2 轮换成功后桌面永远拿不到新凭据（同步不在本批），真机验收第 3 条过不了

- 位置：`src/myservers/useServerNodePooling.ts:34-35`（`credentialedThisSession`）、`:92`、`:145-156`（「本地已有节点行就不再取凭据」）；入口 `src/App.tsx:562`；工具成功文案 `src-tauri/src/tools/node_rotate.rs:512-523`。
- 现状：agent 轮换成功 → 控制面 `node_port` 与 `credentials` 已更新 → 桌面这条节点仍持有旧端口/密码，且没有任何刷新入口：本地已有该 `node_id` 的节点行时 `useServerNodePooling` 不再取凭据，`credentialedThisSession` 还会阻止本会话重复取；`node-rotation-and-sync.md` §3 的「手动刷新 + 定时同步」不在本批四单里。
- 影响：手机上订阅刷新能恢复，**发起修复的桌面端自己恢复不了**；用户会看到「已重置」却仍测不通，然后反复点「测不通问AI」——每次成功轮换都让本地更旧。工具文案写「需要重新同步配置」但产品里没有同步动作。设计 §13 验收 3（桌面同步 → 手机刷新 → 两端可用）无法通过。
- 修法（择一，需 PM/架构定）：
  1. 本批内补最小同步：工具成功后（或 `MyServerFailure` 入口）调用 `myServerCredentials(server_id)` 并用返回的 `node_id/port/password` 覆盖本地节点行 + `node_attach`，界面给一次「节点已更新」提示；
  2. 或明确本批只交付「机器侧能力」，把工具成功文案降级为「节点端口已重置；本机需要刷新服务器数据后才生效」，并让 PM 接受验收 3 顺延。

### B3 `active` 上报失败后不再重试：健康机器在 10 分钟后被结算兜底销毁

- 位置：`agent/src/rotation.rs:352-373`（`report_with_retries`：5 次、约 7.5 秒）、`:511-523`（`report_active`）、`:527-548`（`apply_if_needed`：`report_when_unchanged=false` 时**不**上报）、`:550-583`（`poll_once` 走的就是 `false`）；启动入口 `agent/src/agent.rs:132`；销毁扫描 `cloudflare/control-plane/src/servers.ts:1331-1370`（`sweepUnsettledSettlements`，`enrollment_used_at < now-10min` 且无 charge 流水 → `failSettlement`）。
- 现状：agent 只在「启动时 desired 未变」和「apply 成功后」各报一次 `active`；这两次都失败（控制面 5xx / 网络抖动 8 秒即可）之后，轮询永远走 `Unchanged` 分支，不再补报。服务器停在 `installing/verifying`，10 分钟后被结算兜底销毁，45 分钟后还有 enrollment 兜底。机器其实已经在正常提供服务。
- 影响：真机上「开机时控制面抖一下」= 用户白扔一台机器（还会退款，但体验是建机失败）；`report_with_retries` 的 5 次重试窗口只有 ~7.5 秒，不够覆盖 boot 期网络未稳。
- 修法：
  1. agent 持久化「active 未被确认」标记（`state.rs`），`poll_once` 在该标记存在时每轮补报 `active`，收到 200 才清；
  2. 控制面把重复 `active` 做成幂等：`row.state === 'active'` 时直接 200（at_ready 已因账本 duplicate 幂等，存量 upfront 会走到 `activateServer` 的守卫 → 销毁，顺手补掉）；
  3. 可选：`sweepUnsettledSettlements` 加 `last_seen_at` 新鲜度条件，别把「agent 活着但汇报失败」当「结算进程死了」。

---

## 应修

### S1 `active` 的 `port_mismatch` 会销毁一台健康机器（乱序 / 竞态）

- 位置：`cloudflare/control-plane/src/servers.ts:1179-1183`。
- 触发：agent 启动时 `report_active` 的重试还在飞（最多 ~7.5s + 请求时间），用户同时点了「智能修复」，`rotated` 先把 `node_port` 改成新端口，随后到达的旧 `active` 报旧端口 → `port_mismatch` → `destroyInstance`。
- 影响：为一次排障把机器删掉（钱会退，节点没了）。概率低但后果是删除。
- 修法：`row.state === 'active'` 且 `body.port !== row.node_port` 时返回 200 `{ignored:true}`（或按 `credentials` 里端口判断是否只是滞后），只在进度阶段（booting/installing/verifying）才按 `port_mismatch` 销毁。

### S2 一次性令牌的 `jti` 只在「顶层 `method === "tools/call"`」时消费，批量 JSON-RPC 可绕过

- 位置：`agent/src/server.rs:176-185`。
- 现状：`serde_json::from_slice::<JsonRpcMethodProbe>` 对数组（JSON-RPC batch）解析失败 → `is_tool_call=false` → 不消费 `jti`；随后 rmcp 若接受批量请求，一个令牌可在 60 秒内驱动多次 `rotate_credentials`。
- 影响：与 §6「一次性令牌」不符；泄漏面主要是本机日志/抓包（TLS 下很难），但这是安全边界的实现偏差。
- 修法：探测逻辑覆盖数组（任一元素 `method==="tools/call"` 即消费）；更稳的做法是在 `initialize` 成功后就为本次连接登记令牌，之后同连接内允许，但**换连接/重放必须拒绝**。

### S3 CA 路径没有指纹回退，且公网 IP 探测失败后不重试 → 节点永久不可修

- 位置：`src-tauri/src/tools/node_rotate.rs:198-203`（有 `ca_pem` 就只走 CA）；`agent/src/agent.rs:43-50`（只在启动探测一次 DO metadata）、`:203-221`；`agent/src/config.rs:254-267`（`public_host` 缺失时 `allowed_hosts` 只有 localhost）。
- 现状：探测失败 → leaf 无公网 IP SAN、MCP `Host` 白名单也没有该 IP。桌面拿到 `ca_pem` 后只做链校验 → `agent_tls_untrusted`，**不会**退到同一张票里的指纹 pin；agent 也不会在轮询里重试探测。要等下次进程重启才可能恢复。
- 影响：开机瞬间 metadata 不可达的节点，agent 进程活着但控制端点永远拒绝桌面；UI 只能说「无法确认节点证书」，排障方向被带偏。
- 修法：agent 在轮询里重试 `detect_public_ip`（成功即重签 leaf 并上报新指纹）；桌面在 CA 校验失败时对同一 ticket 用指纹 pin 重试一次；`allowed_hosts` 为空时至少接受「控制面下发的 IP 字面量」或把 `/v1/agent/enroll` 返回的 host 写进配置。

### S4 20 秒 MCP 预算小于真实轮换耗时

- 位置：`src-tauri/src/tools/node_rotate.rs:41`（`MCP_TIMEOUT=20s`）；agent 侧 `agent/src/singbox.rs:365-404`（daemon-reload/enable/restart + `wait_active` 最长 15×2s）、`:430-516`（本地监听 50×1s + 出站 2×5s）。
- 现状：`systemctl restart` 失败重试一次后，最坏耗时 = 2×(重启等待 30s + 验活) ，远超 20s。超时后桌面报 `agent_timeout`（retryable），而 agent 很可能已经换号成功——用户再点一次会触发第二次轮换。
- 影响：真机上「总是超时但其实成功」；桌面又因 B2 拿不到新值，体验最差。
- 修法：把客户端 MCP 超时提到 60–90 秒（`tools.md` §2.6 预算表同步改），或让 agent 在「本地已生效」后先回包、把 `rotated` 上报改异步（失败再回滚的语义要重新设计，不推荐）。

### S5 cloud-init 没有失败回传，坏 agent/网络故障静默等 45 分钟

- 位置：`cloudflare/control-plane/src/cloud_init.ts:1-68`（整份重写，只有 `set -euo pipefail`，没有 `trap`）。
- 现状：旧脚本 `trap 'on_error ${LINENO}' ERR` + `report_final` 会在下载/校验/安装失败时立刻上报 `failed`，控制面销毁并退款。新脚本任何一步失败都只是退出：服务器停在 `booting`，10 分钟后结算兜底、45 分钟后 enrollment 兜底才处理；用户在这段时间里看到的是「正在创建」。
- 影响：`AGENT_SHA256` 配错（现在就是占位符）、Release 资产缺失、GitHub 不可达，都会变成「每单静默烧 10–45 分钟」。发布前这是必然发生的形态。
- 修法（最小）：cloud-init 加 `trap`，用**enrollment token** 调一个允许在 `enrollment_used_at IS NULL` 时上报 `failed` 的路径（控制面在 `agentReport` 里额外接受 enrollment token + 不消费它，或单开 `POST /v1/agent/fail`）；不行就至少把 `ENROLL_TTL_MS`（`provision.ts:52`，45 分钟）对 agent 形态缩短到 10 分钟。

### S6 cloud-init 不再关闭 SSH，与「机器无 SSH」的文档口径不一致

- 位置：`src/cloud_init.ts`（旧版第 2 步 `systemctl stop/disable ssh` 已删除）。
- 事实：`node-agent-mcp.md` §11、`shared-firewall.md` §3.2、`node-rotation-and-sync.md` §5.2 都写「机器没有 root 密码、没有 SSH」。
- 影响：sshd 仍在监听；公网 22 被共享防火墙挡住，暴露面为零，但 DO 控制台 Reset Root Password + 临时放行规则仍然能进——如果这是「给自己留运维口」的有意改动，应改文档；如果不是，这是安全姿态回退。
- 修法：二选一并写进文档。若恢复关闭，保留一行 `systemctl stop/disable ssh || true`（新脚本里 agent 不需要 SSH）。

### S7 破坏性工具的确认卡是内联卡片，`default_index` / Esc 不符合 §4.55

- 位置：`src/agent/bridge.ts:205`（`isConfirmQuestionKind` 只认两种 kind）；渲染 `src/components/AskQuestionCard.tsx:24-30, 127-141`；Host 侧 `src-tauri/src/tools/node_rotate.rs:526-555`（`kind: "node_rotate_confirm"`、`default_index: 1`）。
- 现状：`node_rotate_confirm` 不在确认 kind 集合里 → 走消息流内联卡；内联卡不设默认焦点、不处理 Esc、忽略 `default_index`。`tools.md` §4.55 写的是「有确认卡…默认焦点「取消」；Esc / 关闭 / 超时都按取消」。
- 影响：语义上仍安全（必须点「重置」，跳过=空串=取消），但与契约不符；用户预期「弹窗挡住」的场景变成一行可滚走的卡片。另外**不能只把 kind 加进集合**：`AskQuestionDialog` 只对 upgrade/set-mode 渲染，加了会导致卡片直接消失。
- 修法：给 `AskQuestionDialog` 加一条通用 confirm 分支（读 `default_index`，默认焦点取消，Esc=取消），再把 `node_rotate_confirm` 加进 `isConfirmQuestionKind`；或改 §4.55 承认这是内联确认卡。

### S8 `agentEnroll` / `agentDesiredState` 不校验 `destroyed_at`；`rotated` 的凭据写入可能复活已销毁服务器

- 位置：`cloudflare/control-plane/src/servers.ts:917-1005`（enroll 的消费 UPDATE 与凭据写都没有 `destroyed_at IS NULL`）、`:1193-1227`（desired-state）、`:1145-1153`（rotated 的 UPDATE 带守卫，但同一 batch 里的 `INSERT ... ON CONFLICT ... destroyed_at = NULL` 无条件执行）。
- 影响：已销毁行在「scan 到 batch 之间」被并发销毁时，`node_port` 不变但凭据行被复活（`destroyed_at = NULL`）；未用过的 enrollment token 对已销毁行仍能消费并拿到明文密码。都是脏数据/边界路径，不会让用户多付钱，但会让「服务器已删、凭据还在」的排障结论失真。
- 修法：enroll 的两条写语句都加 `AND destroyed_at IS NULL`（凭据用 `INSERT ... SELECT ... WHERE EXISTS (SELECT 1 FROM servers WHERE id=? AND destroyed_at IS NULL)`）；desired-state 与 rotated 的凭据写同样处理；rotated 改完后检查 UPDATE 的 `changes` 再决定是否写凭据。

---

## 建议

1. **`/v1/agent/{enroll,report,desired-state}` 的响应带明文密码，但没有 `Cache-Control: no-store`**（`cloudflare/control-plane/src/lib/http.ts:4-10` 只写 content-type）。POST 响应默认不缓存，风险低；建议对这三条统一加 `no-store` + `nosniff`。
2. **`last_error` 只写不清**（`servers.ts:1095-1110`）：后续成功上报不会清除，排查时容易把旧错误当现状。
3. **agent 端点没有任何限流**（`servers.ts:917-1227`）：256-bit 令牌不可爆破，但 `unknown_token`(404) 与 `already_used`(409) 的区分给了 token 探针一个判定信号；建议统一 401/404、或对同一 IP 的 enroll 失败计数。
4. **开发用子命令进了生产二进制**（`agent/src/main.rs:29-64`：`serve`（StubRotator）/`mint-token`）。项目规则是「生产与开发跑不同代码，不靠运行时变量隔离」；建议移到 `examples/` 或 `#[cfg(feature = "dev")]`。
5. **写入含密码的文件时先 `write` 再 `chmod 0600`**（`agent/src/host.rs:95-113`、`state.rs:131-147`、`cert.rs:38-48`）：中间有窗口期是 umask 权限；建议 `OpenOptions::mode(0o600)` 创建。
6. **amd64 单一产物**：`wrangler.jsonc` 的 `AGENT_DOWNLOAD_URL` / `SING_BOX_DOWNLOAD_URL` 都钉 amd64，设计 §3 要求 amd64+arm64。当前套餐都是 x86，先记录；若将来上 arm 规格会整单失败。缺 `scripts/agent/build-release.sh`（设计 §3 点名）。
7. **`singbox_version` 的空串回退**：`servers.ts:1185` 用 `?? ""`，缺值时会把空串写进 `servers.singbox_version`；建议保留原值或跳过。
8. **工具成功文案承诺了产品还没有的动作**（`node_rotate.rs:514`「重新同步配置」）。与 B2 一起决定措辞。

---

## 覆盖缺口

**控制面（`test/agent.test.ts`）**
- 没有「同时两次 enroll」用例（顺序重放有，原子消费只有 fakeD1 的同线程实现）。
- 没有「agent 重启后重复 `active`」用例——这正是 B3/S1 的形态。
- `rotated` 只测了成功与三种 409，没测「服务器已销毁（`destroyed_at` 非空）→ 409 且不写凭据」（S8）。
- `rotated` 之后 `desired-state` 是否返回新密码，没有串起来的用例。
- `agent-token` 只测了「指纹缺失 → 409」，没测 destroyed / 非 owner / 错误签名（部分在别处）。
- `failed` 时 DO 删除失败（`destroyInstance` 返回 !ok）的返回语义没有断言。

**agent**
- 没有「启动 `active` 上报失败 → 后续轮询补报」的测试（实现也没有，B3）。
- 没有「启动 `active` 与 `rotated` 乱序」的时序测试（S1 的控制面侧同理）。
- 没有 `ca_pem` 存在但 leaf 缺 SAN 的场景（S3）。
- 轮换耗时与 `MCP_TIMEOUT` 的关系没有测试（S4）。
- `report_with_retries` 的退避只测了成功路径。

**桌面端**
- `NodeRotateCredentialsTool::execute` 的确认/取消/超时路径没有测试（现有测试直接调 backend，绕过了 `confirm`）。
- 旋转成功后「本机凭据必须刷新」这一期望没有测试——因为功能不存在（B2）。
- `mockAgent` / `TauriAgentBridge` 对新工具没有接线用例。

**前端**
- 四单覆盖较好：测不通问AI（正常/种子/延迟/到期/键盘）、向导失败跳转三例、空态 en 字典、「正在创建」不落空态。

---

## 文档与实现不一致

1. `tools.md` §3 要求 `TOOL_COPY` 键集合与工具表一致；实现缺 `NodeRotateCredentials`（同时是 B1）。
2. `src-tauri/src/tools/envelope.rs:13` 的 `CONTRACT_VERSION = "3.18.0"`，`tools.md` 已到 `3.23.0`；§1 说「实现侧只允许有一个常量对应本文件」。不是本批引入，但本批又升了小版本，仍未同步。
3. `node-agent-mcp.md` §3 / §12 #3：控制面在期望状态里核对 agent 版本与 sha256，不一致即失败——实现里 `AGENT_VERSION` 只用于 `usableBuild` 的形状校验，从不下发给 agent、也没有任何版本比对；agent 上报的 `agent_version` 只落库。
4. 设计 §3 的 `scripts/agent/build-release.sh` 与 arm64 产物不存在（见建议 6）。
5. `node-rotation-and-sync.md` §3「手动刷新 + 定时同步」不在本批，但本批已经交付了依赖它的轮换工具（B2）。
6. §11 / `shared-firewall.md` §3.2 / `node-rotation-and-sync.md` §5.2 的「机器无 SSH」与 cloud-init 现状不符（S6）。
7. `tools.md` §4.55 的确认卡语义（阻塞、默认焦点取消、Esc 取消）与内联卡片实现不符（S7）。
8. `node-agent-mcp.md` §5 的 agent 端点未规定错误信封；实现用裸 `{ok:false, reason}`，与桌面其它接口的 `apiError` 信封不同（对 agent 端无影响，记录）。
9. `node-agent-mcp.md` §5 写 `port_mismatch` 一律销毁；实现照做，但与乱序上报相撞时会误杀（S1），建议改文档口径为「仅在进度阶段」。

---

## 已核对通过

**控制面**
- `server_token` 只返回一次，库里只存 `sha256B64u`；`servers_agent_token` 唯一索引对多 NULL 安全（SQLite 语义）。
- enroll 的原子消费：`UPDATE ... WHERE enrollment_used_at IS NULL` + `changes===1` 判定，并发只一次成功；遥测/审计不含 token 与密码。
- `node_id` 在 enroll 生成并落库，`activateServer` 沿用（`servers.ts:600-706`），与 legacy enroll 语义一致（同一函数抽取，参数不变）。
- `activateServer` 保留状态守卫、`activation_lost` 收尾、`order_ready_lost` 留证；`destroyInstance` 幂等（DO 404 当成功、退款撞唯一键不重复退）。
- `rotated`：端口带/密码长度/`port_taken`（`servers_account_port` 部分唯一索引）全查；失败一律 409 且不销毁；审计只记端口；密码重封后 `openSecret` 可解（测试断言）。
- `agentToken`：只对 `active/healthy` 且已登记指纹的服务器签发；60 秒、独立密钥、`jti` 随机；审计不含令牌明文。
- `agentDesiredState`：阈值与错误码（401/409/500/503）符合 §5；返回最新密码与 sing-box 版本。
- 路由挂载顺序（`servers.ts:1678-1705`）不影响旧 `/v1/enroll` 与 `/v1/servers/*`。
- 迁移 0010 只增列 + 唯一索引，可回滚友好；`schemaGuard` 已纳入 0009/0010。

**agent**
- 令牌验签完整：`alg` 固定 `EdDSA`、`verify_strict`、`server_id` 绑定、`exp`、`ed25519` 公钥解析（hex/JWK 两种）；无 `alg:none`、无篡改通过路径（有测试）。
- `jti` 只在工具执行前消费（除 S2 的批量绕过），进程内 Map + 过期清理。
- 日志脱敏：`password`/`server_token`/`enrollment_token`/`token` 字段与 `agt_`/`enr_` 前缀都被替换；`Debug` 实现全部打码；`Write`/`Read`/`glob` 类文件不存在于生产路径。
- TLS：服务端只加载 leaf，桌面按 CA 或指纹校验，明文 HTTP 在两端都被拒（`AgentTicket::parse`、`config.validate`）。
- 轮换：先 `sing-box check` 再替换配置；`apply` 任一步失败回滚旧配置并重启；控制面拒绝 `rotated` 时回滚；轮换**不**上报 `failed`（因此不会触发销毁）；`pending_rotation` 120 秒防“控制面没追上就回滚”；500 行内所有分支都有日志。
- 期望状态：`desired_matches` 同时看已装版本与写入的 port/password；`poll_once` 只在不一致时 apply。
- 安装：sha256 不匹配永不 install；tar.gz/ELF 两种产物都识别；`installed_version` 二次确认。
- 证书：CA 复用、host 变化只重签 leaf、incomplete CA 直接拒绝、文件 0600。

**桌面端**
- `server_id` 只收 `srv_` + base64url（挡路径穿越）；`endpoint` 必须 https；指纹必须恰好 32 字节（兼容 `AA:BB:` 写法）。
- 错误分类与 `tools.md` §4.55 的 reason 一一对应；`retryable` 取自 agent `kind`；超时与不可达都标 retryable。
- 密码与令牌不进返回值、日志、事件；回包只认 `{ok, port}`，端口做 1–65535 校验。
- 确认在取令牌之前发生；取消返回 `CANCELLED`，不触网。
- rmcp 1.8 API 逐条存在：`with_client`、`StreamableHttpClientTransportConfig::{with_uri, auth_header}`、`DynamicTransportError`、`ServiceError::{TransportSend, Timeout}`、`ClientInitializeError::TransportError`；`allow_stateless` 默认 `true`，与 agent 的 `with_stateful_mode(false)` 兼容。
- Cargo 依赖与 claurst 的 rmcp/reqwest 版本一致（独立 `reqwest13` 别名，不与运行期 reqwest 0.12 冲突）。

**前端四单**
- 测不通行：只在 `probeBad && 已拥有节点 && onAskAi` 时出现真按钮；种子节点/延迟/未测/测速中/到期/墓碑都不出现；点按钮 `stopPropagation`，不误切节点；行改成 `role="option"` + `tabIndex` + Enter/Space，内层原生按钮可达（有测试）。
- 向导：`create` 失败不跳；结账失败按订单反查，查到就跳该服务器详情，查不到就地报错；幂等键策略未变（有 3 条测试）。
- 空态：`awaitingSelected` 让「刚下单、列表还没回来」显示「正在创建」而不是空态；`pendingServer || awaitingSelected` 已接线。
- 文案：zh/en 两份字典各 1241 条、键完全对齐；新用到的 `console.node.askAi`、`assistant.prompt.nodeUnreachable`、`wizard.*` 均存在。
- CSS：内联「问AI」是真链接样式；禁用行用 `aria-disabled` 替代 `:disabled` 后仍保留 hover/选中/焦点样式。

**卫生**
- 新增文件无 secret、无私钥、无调试残留；`agent/target` 由 `agent/.gitignore` 覆盖；`scripts/dev/reseal-node-credential.mjs` 只从进程内存取密钥、输出 SQL 后提示删除。
- `wrangler.jsonc` 的 `AGENT_SHA256` 仍是占位符：这是有意让整单失败的守卫（`usableBuild`），发布前必须替换为真实值。
