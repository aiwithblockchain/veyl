# 节点自救：端到端契约与运行时一致性核对（接缝）

> 日期：2026-11-22
> 基线：HEAD `b0b4141`（工作区干净）。只读核对；未改代码、未提交、未跑测试。
> 目的：三次模块评审各看一块，这里只对**模块之间的接缝**：A 发出的字段、B 到底认不认。
> 不重复已评审过的模块内部问题；涉及原子性/竞态的部分只在跨模块处提。

## 一句话结论

五条链路的字段名、类型、编码、状态字面量**逐项对得上**；三组常量与时间单位**全部一致**。
上线前必须处理的是**配置与部署**（`AGENT_SHA256` 仍是占位符、0010 迁移、签名密钥 secret），不是代码接缝。
代码侧发现 1 条应修（`rotated` 的「改端口」与「重封凭据」两步非原子）与 4 条低危可疑。

---

## 一、链路 × 字段对照表

### 链路 1：cloud-init → agent 配置

| 字段 / 约定 | 发出方 → 接收方 | 一致 | 证据 |
|---|---|---|---|
| `control_url` → `control_plane_url` | `cloud_init.ts` → `AgentConfig`（`#[serde(alias = "control_url")]`） | ✅ | `cloud_init.ts:39-43`；`agent/src/config.rs:174-176`；最小配置解析测试 `config.rs:421-447` |
| `enroll_url` | 同上 → `AgentConfig.enroll_url` | ✅ | `cloud_init.ts:41`；`config.rs:178-180`；`control.rs:267-271` 有值即原样使用 |
| `enroll_token` → `enrollment_token` | 同上（alias） | ✅ | `cloud_init.ts:42`；`config.rs:176-178` |
| 配置未出现的键 | 全部有 `#[serde(default)]`，缺省即默认值 | ✅ | `config.rs:187-231` |
| 控制端口缺省 32100 | 配置不写，agent 用默认；enroll 后改用 `desired.control_port` | ✅ | `config.rs:15-17`；`agent.rs:113-130` |
| 端口带缺省 30000–30999 | 配置不写，默认值 | ✅ | `config.rs:31-33` |
| state / cert / download 目录 | 配置不写，默认 `/var/lib/veyl-agent{,/certs,/downloads}`；均由 agent 自建 | ✅ | `config.rs:19-29`；`cert.rs`（`create_dir_all`）、`state.rs`（保存时建目录）、`singbox.rs`（下载目录） |
| 日志文件 `/var/log/veyl-agent/agent.log` | 缺省开启；`FileSink::open` 自建目录、文件 0600 | ✅ | `config.rs:51-53`；`logging.rs:148-160` |
| 配置文件权限 | `umask 077` + `install -m 600` + heredoc 覆盖 | ✅ | `cloud_init.ts:47-48,77-81` |
| 失败回传 URL | cloud-init → `POST /v1/agent/fail`（Bearer enrollment token） | ✅ | `cloud_init.ts:56-58`；`servers.ts:1912`；`agentFail` `servers.ts:1149-1195` |
| Ubuntu 依赖 | `curl` 缺失才 apt；`sha256sum`/`install`/`tar`/`systemctl` 均为基础镜像自带 | ✅（见可疑 5） | `cloud_init.ts:65-72,104-106`；agent 侧 `singbox.rs` 用 `tar`/`install`/`systemctl` |

### 链路 2：agent → 控制面（`POST /v1/agent/report`）

| 字段 / 约定 | 发出方 → 接收方 | 一致 | 证据 |
|---|---|---|---|
| `stage` 五个字面量 | `Stage` 枚举 `rename_all="lowercase"` → `servers.ts` 白名单 | ✅ 完全一致，无多无少 | `control.rs:75-83`；`servers.ts:1228` |
| 非法 stage | CP 返回 `400 invalid_stage`，不改状态 | ✅ | `servers.ts:1227-1230` |
| `port`（u16，每报必带） | active 比对、rotated 校验；installing/verifying/failed 忽略 | ✅ | `control.rs:88`；`servers.ts:1313-1321,1386-1395` |
| `password`（仅 rotated 必带） | CP 要求 `length ≥ 16`（agent 生成 32 hex） | ✅ | `control.rs:96-99`；`rotation.rs:355-357`；`servers.ts:1322-1325` |
| `error`（仅 failed） | agent 截 300 再脱敏；CP 再截 300 | ✅ | `control.rs:128-133`；`servers.ts:1278-1281` |
| `agent_version` | `env!("CARGO_PKG_VERSION")` = 0.1.1；CP 存列（不比对） | ✅ 字段一致；版本比对未实现（见可疑 6） | `control.rs:90,113`；`servers.ts:1238,1251` |
| `singbox_version` | 每次带上；active 时作为激活版本 | ✅ | `control.rs:91,123-126`；`servers.ts:1239,1406` |
| `control_port` | u16 → CP 整数；写入 `servers.control_port` | ✅ | `control.rs:92`；`servers.ts:1234-1237,1252` |
| `cert_fingerprint` | 64 位小写 hex；CP 存列（阈值 200 字符） | ✅ | `cert.rs`（sha256 hex）；`servers.ts:1240,1253` |
| `ca_pem` | CA 证书 PEM；CP 截 8000 字符 | ✅ | `control.rs:94`；`servers.ts:1242-1245` |
| rotated 请求体 | `{stage, port, password, cert_fingerprint, ca_pem, …}` | ✅ | `rotation.rs:353-357`；`servers.ts:1310-1381` |
| rotated 校验与回包 | 带内端口/密码长度/`port_taken`；`200 {ok,port}` | ✅ | `servers.ts:1313-1382` |

### 链路 3：控制面 → agent（enroll / desired-state）

| 字段 / 约定 | 发出方 → 接收方 | 一致 | 证据 |
|---|---|---|---|
| `server_id` / `server_token` | enroll（及 TTL 内 reEnroll）→ `Enrollment` | ✅ | `servers.ts:1131-1142,1027-1037`；`control.rs:53-61` |
| `desired.port` / `.password` | enroll 用 `node_port` 与本次生成的密码；desired-state 用解封后的 `secret.*` | ✅ | `servers.ts:1134-1139,1441-1446`；`control.rs:27-39` |
| `desired.control_port` | 两端都是 `AGENT_CONTROL_PORT` / `row.control_port`；agent 侧缺省 32100 | ✅ | `servers.ts:1137,1444`；`control.rs:32-38` |
| `desired.singbox` | `{version, sha256, url}` | ✅ | `servers.ts:894-910`；`control.rs:20-24` |
| 形状（包裹 vs 裸） | agent 同时接受 `{desired:{…}}` 与裸对象 | ✅ | `control.rs:320-327` |
| `token_public_key` 编码 | CP 发**字符串**形式的 JWK；agent 按 `Option<String>` 收再解析 | ✅ | `servers.ts:1141,1036`；`control.rs:60`；`agent.rs` `resolve_signer_pubkey` |
| 错误分支 | `unknown_token 401`、`no_credentials 409`、`credential_corrupt 500`、`503` 缺配置 | ✅ | `servers.ts:1414-1447`；agent `poll_once` 对 409 视为终止 |

### 链路 4：控制面 → 桌面端（`POST /v1/servers/{id}/agent-token`）

| 字段 / 约定 | 发出方 → 接收方 | 一致 | 证据 |
|---|---|---|---|
| `endpoint` 含 `/mcp` | CP 拼 `https://<ip>:<control_port>/mcp`；桌面原样使用、不补路径 | ✅ | `servers.ts:1495`；`node_rotate.rs:213-240`（注释与解析） |
| 明文 HTTP | 两端都拒绝（CP 只拼 https；桌面 `Url::parse` 后强制 https） | ✅ | `servers.ts:1495`；`node_rotate.rs:225-231` |
| `cert_fingerprint` | agent 64 hex → CP 原样 → 桌面按 32 字节解析（容忍 `AA:BB:`） | ✅ | `servers.ts:1496`；`node_rotate.rs:249-258,parse_fingerprint` |
| `ca_pem` | 可为 `null`；有则先走 CA，TLS 失败用同一张票回退指纹 | ✅ | `servers.ts:1498`；`node_rotate.rs:185-205,213-245` |
| `token` | 60 秒 Ed25519；桌面放 Bearer，agent 验签 | ✅ | `servers.ts:1474-1480`；`agent/src/auth.rs` |
| `key_id` | CP 返回；桌面**不读取**（agent 用 enroll 的公钥验签，无需 key_id） | ✅ 无需消费 | `servers.ts:1500`；`node_rotate.rs`（无 key_id 解析） |
| 指纹缺失 / 未登记 | CP 直接 409 `agent_not_registered`（不会发出空指纹） | ✅ | `servers.ts:1467-1472` |
| 非 active | CP 409 `not_ready` | ✅ | `servers.ts:1464-1466` |

### 链路 5：控制面 → 桌面端凭据（`POST /v1/servers/{id}/credentials`）

| 字段 / 约定 | 发出方 → 接收方 | 一致 | 证据 |
|---|---|---|---|
| 签名载荷 | `server_id, node_id, host, port, method, password, issued_at, expires_at`（JSON 字符串签名） | ✅ | `servers.ts:1854-1873`；`credentials.rs:88-98` |
| 必填与校验 | 桌面要求 host 非空、port≠0、method ∈ `["aes-256-gcm"]`、密码非空、未过期 | ✅ | `credentials.rs:106-140`；`catalog/types.rs:80` |
| `key_id` | CP 按环境发 `cp-2026-11/12`；桌面内置两把公钥 | ✅ | `wrangler.jsonc:46,87`；`credentials.rs:19-27` |
| 落库 | 按 `source_key=server_id` upsert 节点，端口/方法与密码引用一起更新；密码进 `secrets.enc` | ✅ | `credentials.rs:212-272` |
| 返回给前端 | 只回 `{server_id,node_id,name,host,port,method}`，密码不出 Host | ✅ | `src-tauri/src/control_plane/servers.rs:1038-1066`；`bridge.ts:677-684` |
| rotated 之后 | agent 上报 → CP 重封 `{host,row.ip 端口,password,aes-256-gcm}` → 下次取凭据即新值 | ✅ 正常路径 | `servers.ts:1329-1364`；见应修 1 的部分失败窗口 |
| 手机端 | mobile profile 读同一行 `credentials`，`method` 必须 `aes-256-gcm` | ✅ | `mobile.ts:441,687` |
| 两条修复入口的本地刷新 | UI 按钮：`credentials()` + `vpn.reload()`；AI 工具：`credentials()` + `my-server-changed`（不 reload 配置） | ⚠️ 不一致（低危，见可疑 2） | `MyServerDetail.tsx:247-256`；`App.tsx:2522`；`node_rotate.rs:508-527`；`useVpnSession.ts:413-465` |

---

## 二、常量与单位

| 项目 | 三处取值 | 一致 | 证据 |
|---|---|---|---|
| 端口带 | agent 默认 `[30000, 30999]`；CP `NODE_PORT_START/END` 30000/30999；共享防火墙规则由同一对常量拼区间 | ✅ | `config.rs:31-33`；`digitalocean.ts:151-152,173-180` |
| 轮换选端口 | `pick_port(cfg.port_band, exclude)`；CP 再校验一次带内 | ✅ 双重约束 | `rotation.rs:114-129,292-299`；`servers.ts:1313-1321` |
| 控制端口 | agent 默认 32100；CP `AGENT_CONTROL_PORT` 32100；防火墙入站 TCP 32100 | ✅ | `config.rs:15-17`；`digitalocean.ts:154,178` |
| `enrollment_expires_at` | 毫秒（`Date.now()+45min`）；CP 所有比较都用毫秒 | ✅ | `provision.ts:53,296-301`；`servers.ts:1060,1521-1522` |
| `last_seen_at` | 毫秒（`Date.now()`），目前无消费方 | ✅ | `servers.ts:1251` |
| jti `exp` | 秒（签名侧 `floor(ms/1000)`；agent 与 `now_unix()` 比较） | ✅ | `servers.ts:1475`；`agent/src/auth.rs` |
| 凭据 `issued_at/expires_at` | ISO 8601（由毫秒时间戳生成）；桌面按 RFC3339 解析 | ✅ | `servers.ts:1861-1862`；`credentials.rs:121-124` |
| `pending_rotation` 宽限 | 秒（`at_unix` + 120） | ✅（agent 内部） | `rotation.rs:22,560-580` |
| `active_unconfirmed` | **布尔标记，无时间值**；每轮 poll（30s）补报，CP 对重复 active 幂等 | ✅ | `state.rs:112-114`；`rotation.rs:727-740`；`servers.ts:1397-1404` |
| 限流窗口 | 毫秒（`bumpRateLimit(..., 5*60_000)`） | ✅ | `auth.ts:48-59`；`servers.ts:952` |

---

## 三、不一致 / 可疑（按严重度）

### P0 —— 第一次真机测试前必须处理（部署/配置，不是代码）

1. **`AGENT_SHA256` 仍是占位符，dev 与 prod 都是。**
   `usableBuild` 要求 64 位十六进制，占位符会让**每一单**在建 Droplet 前失败（`502 agent_unconfigured`）。
   证据：`wrangler.jsonc:57,95`；`provision.ts:31-37,235-237`。
   处理：把 `agent-v0.1.1` release 的 `veyl-agent-linux-amd64` 的 sha256 填进两处；确认 `AGENT_VERSION`=0.1.1、URL 指向 `agent-v0.1.1/veyl-agent-linux-amd64`（工作流产物名已对齐）。
2. **0010 迁移未应用**：`server_token_hash / control_port / cert_fingerprint / ca_pem / last_seen_at / last_error` 与唯一索引都来自它；未应用时 enroll/report 全部 SQL 失败。
   证据：`migrations/0010_node_agent.sql`；`schemaGuard.ts` 已纳入。
3. **`AGENT_TOKEN_SIGNING_JWK` 未设置**（dev）：enroll 会 503 `agent_key_missing`，`agent-token` 也拒绝签发。
   证据：`servers.ts:1066-1068,1458-1460`。
4. **Release 资产可匿名下载**：节点没有 GitHub 凭据，cloud-init 用裸 `curl`。仓库若为 private，资产下载必失败（会走 `/fail` 销毁）。这一条无法在仓库内验证，必须发布后实测一次 HEAD。

### P1 —— 上线前修；不阻塞首次 happy-path 建机，但真机上会留下不可见的数据分歧

1. **`rotated` 的「改端口」与「重封凭据」两步非原子。**
   `servers.node_port` 先更新，`credentials` 后写；第二步抛错时 CP 返回 500、agent 回滚到旧配置，于是：**桌面/手机读到的是旧凭据（仍能连上机器）**，而 `servers.node_port` 已是新端口，`serverView.port` 与真实监听不一致；直到下一次成功轮换或 reEnroll 才自愈。
   证据：`servers.ts:1333-1368`（两条独立语句）；桌面读取 `servers.ts:1842-1861` → `credentials.rs:212-272`。
   修法：把两条写回 `db.batch([...])`（D1 batch 原子），保留 `INSERT ... SELECT ... WHERE EXISTS(destroyed_at IS NULL)` 守卫；或第二个语句失败时把 `node_port` 改回旧值。
   补充：若机器在两步之间被并发销毁，第二步的 `INSERT ... SELECT` 会插 0 行且**不报错**，接口仍回 200；建议按 `changes` 判断。

### P2 —— 可疑（低危，记录后可上线）

2. **两条“智能修复”入口的本地刷新不一致。** UI 按钮路径 `credentials()` 后显式 `vpn.reload()`；AI 工具路径只 `credentials()` + `my-server-changed`，而 `useVpnSession` 不监听该事件、`upsert_node` 也不发配置事件。后果是内存里的配置快照可能保留旧端口，直到其它动作触发重载（连接若在 Host 侧按库重建则不受影响）。证据：`MyServerDetail.tsx:247-256`；`App.tsx:2522`；`node_rotate.rs:508-527`；`useVpnSession.ts:413-465`。建议 App 在 `my-server-changed` 时也 `vpn.reload()`。
3. **签名密钥轮换没有下发通道。** agent 只在 enroll 时拿到 `token_public_key` 并持久化；`desired-state` 不带该字段。轮换 `AGENT_TOKEN_SIGNING_JWK` 后，旧 agent 会一律 401 `bad_signature`，直到 state.json 被清掉并重新 enroll。证据：`control.rs:60,267-307`；`agent.rs` `ensure_identity`。建议把 `token_public_key` 也放进 desired-state，或把「轮换 = 删 state.json + 重启」写进运维文档。
4. **cloud-init 的失败 trap 依赖 curl 已存在。** trap 在下载步骤之前挂载；极简镜像上若 curl 缺失且 `apt-get` 失败，`/fail` 也发不出去，只能等 10/45 分钟兜底。证据：`cloud_init.ts:56-69`。
5. **`endpoint` 不对 IPv6 加方括号。** `https://${row.ip}:...` 对 IPv6 字面量会拼出非法 URL，桌面 `Url::parse` 直接判 `agent_bad_response`。当前 DO 路径只取 IPv4（`getDroplet` 的 `ipv4`），所以无现状影响。证据：`servers.ts:1495`；`node_rotate.rs:221-228`。
6. **`AGENT_VERSION` 不参与任何校验。** cloud-init 用它做注释/校验源，CP 不比对 agent 上报的 `agent_version`；设计里的「版本不一致即失败」仍未实现。证据：`wrangler.jsonc:56`；`servers.ts:1238`。
7. **`/v1/agent/fail` 未写进契约文档**（`node-agent-mcp.md` §5 表只有四条，`my-servers.md` §19.6 也是四条）。实现已接线，文档滞后。
8. **控制端口只会在启动时绑定一次**：desired-state 里 `control_port` 后续变化不会让 agent 重新 bind。当前常量固定 32100，无影响；将来改常量需要重建或重启 agent。证据：`agent.rs:113-130`。
9. **桌面端 MCP 超时 90 秒 > 令牌寿命 60 秒**：正常 initialize→list→call 远快于 60 秒，不构成问题；但如果握手因网络重试跨过 60 秒，`tools/call` 会被判 `expired`。记录即可。证据：`node_rotate.rs:39-41`；`servers.ts:1475`。

---

## 四、首次真机建机：上线前检查清单

按顺序执行；前四项任一不满足，建机必失败。

1. **迁移**：对 dev D1 执行 0010；回读 `PRAGMA table_info(servers)` 应出现六列，`sqlite_master` 应有 `servers_agent_token` 唯一索引。
2. **Secrets（dev）**：`wrangler secret put AGENT_TOKEN_SIGNING_JWK`（Ed25519 JWK，私钥形式）；确认 `AGENT_TOKEN_KEY_ID=agent-2026-11` 在 vars 里。
3. **构建信息**：把 release 的 `veyl-agent-linux-amd64` sha256 写入 dev/prod 的 `AGENT_SHA256`；核对 `AGENT_VERSION=0.1.1`、`AGENT_DOWNLOAD_URL` 资产名与 tag 完全一致；确认 `SING_BOX_*` 三个值非空且 sha 与 URL 对得上。
4. **资产可达性**：不带任何凭据 `curl -fsSI <AGENT_DOWNLOAD_URL>` 应 200/302；private 仓库必须先解决。
5. **防火墙**：确认共享防火墙 `veyl-shared-node-firewall` 存在，入站 TCP/UDP `30000-30999`、TCP `32100`、ICMP；新 Droplet 带 `veyl:node` 且出现在 Tagged Droplets；从公网 telnet 32100 应连通（agent 起来之前是拒绝连接，不是超时）。
6. **清 dev D1 的残留**（只删测试数据）：
   - `servers` 里 `destroyed_at IS NULL` 且 `state ∈ (booting, installing, verifying)` 的旧行（占端口、会被 sweep 销毁）；
   - `credentials` 中对应已销毁服务器的行（`destroyed_at IS NULL` 但 server 已 destroyed）；
   - `rate_limits` 里 `agent-reenroll:%` 的键（窗口 5 分钟，可不清）；
   - 确认测试账户 `balance_cents ≥ 7 × 日价`（建机门槛）。
7. **账号/设备**：dev 账户有 `kind=email, status=active` 与有效 device；桌面已登录（`agent-token` 走账户访问令牌）。
8. **建机后按序观察**：订单 → `booting`（有 `enrollment_hash/expires`）→ agent enroll（`server_token_hash` 非空、`node_id` 写入、`credentials` 出现）→ `installing` → `verifying` → `active`（订单 ready、扣第 0 天、`last_seen_at/agent_version=0.1.1/control_port=32100/cert_fingerprint/ca_pem` 齐全）。
9. **修复链路**：桌面取 `agent-token`（`endpoint` 带 `/mcp`）→ 轮换 → `servers.node_port` 与 `credentials.port` 同步变化 → 手机 profile 刷新后端口一致 → 桌面节点行端口一致。
10. **失败路径抽测一次**：故意把 dev 的 `AGENT_SHA256` 改错 → 下单应 `agent_unconfigured`（不下发 Droplet）；把代理不可达的情形用 `/fail` 模拟 → 服务器应被销毁并退款。
11. **不要在生产填占位符**：prod 的 `AGENT_SHA256` 在正式发布前保持占位（安全失败）；发布时与 dev 同时替换并部署。

---

## 五、已核对无问题（摘要）

- 五条链路的字段名/类型/编码全部对得上：`stage` 五字面量、`desired` 四字段、`token_public_key` 字符串 JWK、`endpoint` 含 `/mcp`、凭据载荷八字段。
- 端口带与控制端口三处（agent 默认、CP 常量、防火墙规则）完全一致；agent 只能在带内选端口，CP 再校验一次。
- 时间单位：enrollment/`last_seen` 毫秒、jti `exp` 秒、凭据 TTL ISO、限流窗口毫秒、`pending_rotation` 秒；`active_unconfirmed` 是布尔标记（无“宽限期”时间值），30 秒重报远小于 CP 的 10 分钟兜底。
- 错误语义跨模块一致：CP 的 `invalid_stage/port_out_of_band/password_too_short/port_taken/server_destroyed/not_ready/agent_not_registered` 与 agent/桌面的 reason 集合一一对应；agent 的 `retryable/fatal` 与桌面 `retryable` 映射一致。
- 屋漏路径已验证：CA 校验失败会回退同一张票的指纹 pin；public IP 探测失败会保留旧 SAN 并在轮询里重试；重复 `active` 幂等；stale-port 的 active 不再销毁。
