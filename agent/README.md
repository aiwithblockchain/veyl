# agent/ — Veyl 节点 agent

独立 Rust 项目（不并进 `src-tauri` 的 workspace），现在是**可用形态**：

- 自签 TLS 的 MCP Streamable HTTP 端点，暴露 `rotate_credentials` 与 `upgrade_singbox` 两个工具；
- 一次性 Ed25519 Bearer 令牌，agent 内置公钥离线验签；
- enroll → 安装/校验 sing-box → 写配置 → systemd → 验活 → 上报的三阶段流程；
- agent 自己生成新端口与密码的真实轮换；
- 定期拉取期望状态并按差异应用；
- 自签证书持久化，按节点公网地址重签 leaf SAN。

设计依据：`docs/design/node-agent-mcp.md` §4–§8、`shared-firewall.md` §3。

## 结论

- **MCP 链路**：`cargo run --example demo` 本机 10/10 通过（TLS + 令牌 + tools/call）。
- **agent 主体**：`cargo test` 全部通过，覆盖令牌、证书持久化、端口选择、配置生成、安装校验、轮换失败路径、启动时的期望状态应用与按需升级。
- **未验收**：真实 Ubuntu 机器上的 systemd 行为、真实 GitHub 下载、与控制面会话的联调。这三项必须在真机上跑。

## 快速开始

### 1. MCP 链路 demo（本机，无 root）

```bash
cd agent
cargo run --features dev --example demo
```

退出码 0 = 全部场景符合预期。输出示例（端口/密钥每次不同）：

```
=== 1. happy path ===
[PASS] root CA trust + valid token          tools=["rotate_credentials"] result={"ok":true,"port":30919} executions=1
[PASS] fingerprint pin + valid token        tools=["rotate_credentials"] result={"ok":true,"port":30838} executions=2
=== 2. token gate ===
[PASS] no Authorization header              HTTP=401 reason=missing_token executions 2->2
[PASS] expired token                        HTTP=401 reason=expired executions 2->2
[PASS] replayed jti (second tools/call)     HTTP=401 reason=replayed executions=3
[PASS] wrong signature (attacker key)       HTTP=401 reason=bad_signature executions 3->3
[PASS] token for another server_id          HTTP=401 reason=wrong_server executions 3->3
=== 3. TLS trust ===
[PASS] default trust (no CA): handshake fails
[PASS] wrong CA: handshake fails
[PASS] wrong fingerprint pin: handshake fails
10/10 checks passed
```

### 2. 生产运行

cloud-init 写的配置是 `/etc/veyl-agent.json`，启动命令是**不带子命令**的：

```bash
veyl-agent --config /etc/veyl-agent.json
```

`veyl-agent run --config …` 也支持。配置样例见 [`config.example.json`](config.example.json)（与 cloud-init 写的最小配置一致；其余字段有默认值）。

cloud-init 实际写入的 unit（`cloudflare/control-plane/src/cloud_init.ts`）：

```ini
[Unit]
Description=Veyl node agent
After=network-online.target nss-lookup.target
Wants=network-online.target

[Service]
ExecStart=/usr/local/bin/veyl-agent --config /etc/veyl-agent.json
Restart=on-failure
RestartSec=10s

[Install]
WantedBy=multi-user.target
```

## 发版

发布物是**裸 ELF 二进制**（cloud-init 直接下载单个文件并用 `AGENT_SHA256` 校验），不是 tar.gz。

```bash
bash scripts/agent/build-release.sh          # 本地 cargo test + release 构建 + sha256
bash scripts/agent/build-release.sh --tag    # 交互确认后打 agent-v<版本> 并推送
```

- 工作流：`.github/workflows/agent-release.yml`，只在推送 `agent-v*` 标签时触发；发版前跑 `cargo test --features dev`，tag 与 `agent/Cargo.toml` 版本不一致直接失败。
- 构建：`x86_64-unknown-linux-musl` 与 `aarch64-unknown-linux-musl`（cross），产物 `veyl-agent-linux-amd64` / `veyl-agent-linux-arm64` 和 `SHA256SUMS`。
- `--tag` 只在 agent/ 已提交且干净、且是交互终端时执行；非交互环境直接拒绝。
- 控制面目前只有一组 `AGENT_DOWNLOAD_URL` / `AGENT_SHA256`，先填 amd64；arm64 需要按架构再加一组配置。

## 配置要点

生产配置由 cloud-init 写成最小形态（`control_url` / `enroll_url` / `enroll_token`），其余字段全部有默认值：

| 字段 | 说明 |
|---|---|
| `control_url` | 控制面根地址，必须 `https://`（别名 `control_plane_url`；`allow_insecure_control_plane` 只给本地测试） |
| `enroll_url` | 完整的 `POST /v1/agent/enroll` 地址；有就原样使用 |
| `enroll_token` | 一次性（别名 `enrollment_token`）；enroll 成功后已失效，可以留着 |
| `signer_pubkey` | 可选的 Ed25519 公钥（64 hex）后备；正常由 enroll 响应里的 `token_public_key`（JWK）提供 |
| `public_host` | 可选覆盖。默认启动时向 DO metadata 查询公网 IPv4，自动写进 leaf SAN 与 MCP `allowed_hosts` |
| `detect_public_ip` | 默认 `true`；关闭后必须自己配 `public_host` 或 `allowed_hosts` |
| `metadata_url` | 默认 `http://169.254.169.254/metadata/v1/interfaces/public/0/ipv4/address` |
| `allowed_hosts` | 额外接受的 `Host` 头；`localhost / 127.0.0.1 / ::1` 永远允许 |
| `control_port` | 回退值；期望状态里的 `control_port` 优先，且必须在 SS 端口带外 |
| `port_band` | 默认 `[30000, 30999]`，与共享防火墙规则一致 |
| `recent_ports_keep` | 记录最近用过的端口数，轮换时排除，避免立刻复用 |
| `egress_probe` | 轮换验活时的出站 TCP 目标，默认 `1.1.1.1:443` |
| `singbox.*` | 二进制、配置、unit、systemctl/tar/install/journalctl 路径 |
| `log_level` | `info`；`RUST_LOG` 优先 |
| `log.file` | 日志文件，默认 `/var/log/veyl-agent/agent.log`；设 `null` 关闭文件日志 |
| `log.max_bytes` | 单文件上限，默认 5242880（5 MiB） |
| `log.keep_files` | 轮转保留份数，默认 3（`agent.log.1`…`.3`） |

**公网 IP 为什么重要**：桌面端用 `https://<公网 IP>:32100` 连接。webpki 会校验证书 SAN，leaf 里没有这个 IP 时，即使信任了 CA 也会因 `NotValidForName` 失败；Host 校验也会拒绝。cloud-init 没有把 IP 传给 agent，所以默认查 DO metadata。**启动时查不到会保留上次的 SAN，并在后台每分钟重试探测（最多 3 次）**；成功后只重签 leaf（CA 不变）、更新指纹与 Host 白名单，并刷新一次登记信息（`verifying` 上报只刷新登记字段，不会把 active 机器改回 installing）。查不到且没有历史 SAN 时必须显式配 `public_host`。

## 控制面接口（按现有实现对齐）

`cloudflare/control-plane/src/servers.ts` 已经实现了三条接口，agent 按它们的真实行为对齐：

| 接口 | 方法 | 实现 |
|---|---|---|
| `/v1/agent/enroll` | POST | `Authorization: Bearer <enroll_token>`；响应 `{server_id, server_token, desired, token_public_key}` |
| `/v1/agent/report` | POST | Bearer `server_token`；body 见下 |
| `/v1/agent/desired-state` | GET | Bearer `server_token`；响应 `{server_id, desired:{…}}` |

`token_public_key` 是 Ed25519 公钥 JWK（`{"kty":"OKP","crv":"Ed25519","x":"…"}`）。agent 把它存进 state，重启后继续离线验桌面端令牌。

**阶段语义（按控制面实现）**：`installing / verifying` 只前进不回退；`active` 才真正激活（写 node_id 收尾、订单 ready、开始计费）；`failed` 对**尚未 active** 的机器会触发销毁，对已是 `active / healthy` 的机器只记录 `last_error` 并返回 `200 {ok:true,recorded:true}`，不销毁。所以 agent 只在「期望状态驱动」的 apply 内部重试一次后仍失败时才上报 `failed`，收到 200 也继续重试；轮换失败不上报 `failed`（见下文）；升级失败只在控制面已确认这台机器 active 时才上报 `failed`（见「按需升级」）。每次 report 都带证书指纹和 CA PEM，否则桌面端拿不到 `agent-token`。

**enroll 恢复语义**：enrollment token 已消费、但仍在 `enrollment_expires_at` 内且服务器未销毁时，再次 enroll 会返回**新的 `server_token`**（旧的立即失效），host/端口/密码沿用同一份。因此 `state.json` 损坏或丢失后的恢复路径就是备份坏文件、重新 enroll、用新 token 继续；不要假设第二次 enroll 一定 409。409 的 body 是 `destroyed` / `expired`（服务器已销毁 / token 过期），agent 会把 reason 原样写进日志并退避 10 分钟。

`desired.password` 只在 enroll 响应里保证出现，之后由 `desired-state` 返回最新值。agent 在 enroll 成功、每次 apply/轮换成功后都把完整的 `last_desired`（含密码）写入 0600 的 `state.json`，控制面短暂不可达时重启也能恢复；该字段永不进日志。

### 轮换契约（rotated）

`POST /v1/agent/report` 额外支持 `stage: "rotated"`，body `{stage:"rotated", port, password, cert_fingerprint?}`：

- 控制面校验端口在 `30000-30999`、密码 ≥16、同账户活服务器端口唯一；通过后更新 `servers.node_port` 并重封 credential，返回 `{ok:true, port}`。
- 失败一律 409（`port_out_of_band` / `password_too_short` / `port_taken` / `server_destroyed`），**不销毁**。
- agent 收尾：本地 apply + 验活成功 → 上报 `rotated`；200 才算完成；非 200 立即回滚旧配置并重启，把原因返回给调用方。

`active` 分支的 `port === node_port` 校验保留；`rotated` 已更新 `node_port`，所以之后的 active 不会再判漂移。

`failed` 阶段对未激活机器仍会销毁；对已 active/healthy 的机器只记录 `last_error`。agent 只在期望状态驱动的 apply 内部重试一次后仍失败时才上报，并带 `error`（控制面截断 300 字写入审计 / `last_error`）。轮换失败不上报 `failed`；升级失败只在控制面确认过 active 时上报（否则只回工具错误），读不到版本时不带 `singbox_version`，换回旧二进制失败时保留 `.bak` 供下次复用。

每条 report 都带 `ca_pem`（自签 CA 的 PEM）与 `cert_fingerprint`；桌面端优先用 CA 建立信任，指纹作为兜底。

## sing-box 安装

- 期望状态里的 `singbox.url` 可以是：
  - `.tar.gz`（与现有 cloud-init 相同，sha256 是压缩包的哈希）：校验 → `tar -tzf` 找到 `sing-box` → 解包 → `install -m 0755`；
  - 直接 ELF 二进制：校验 → `install`。
- 下载后先校验 sha256，不一致直接失败，不落盘安装。
- 配置：`aes-256-gcm`（与现存机器一致），`listen 0.0.0.0`、`listen_port = desired.port`，写 `/usr/local/etc/sing-box/config.json`，权限 0600。
- 写临时文件 → `sing-box check` → 原子 rename → 写 unit → `daemon-reload` → `enable` → `restart` → `systemctl is-active` 轮询。
- 任一步失败会尝试恢复旧配置并重启，然后返回 fatal。

## 轮换流程

`rotate_credentials`（AI 或界面触发）：

1. 从端口带里选一个未在 `recent_ports`、不等于当前端口与控制端口的端口；
2. 生成 16 字节随机密码（32 hex）；
3. 上报 `installing`；
4. 写配置 → check → restart → 等 active；
5. 上报 `verifying`；
6. 验活：本机 `127.0.0.1:<port>` 可连 + 一次宿主出站 TCP（默认 `1.1.1.1:443`）；
7. 上报 `rotated`（新端口 + 新密码 + 证书指纹 + CA PEM）；非 200 立即回滚旧配置并重启，返回错误；
8. 记录 `recent_ports` 与 `last_desired`，返回 `{ok:true, port}`。

apply/verify 遇到可重试错误（restart 失败、监听超时、出站失败、下载失败）会先在 agent 内部重试一次（间隔 2 秒）；仍失败才返回错误。`rotated` 被控制面拒绝时也会回滚旧配置，**不留半成功状态**。轮换失败不向控制面上报 `failed`——`apply` 已回滚，节点仍在服务，而控制面收到 `failed` 会直接销毁机器。失败以 `CallToolResult::error` 返回，内容 `{ok:false,error:{kind,message}}`，不含密码。只有「已有轮换在跑」返回 `retryable`，其余为 `fatal`。

**没有「轮换后控制面未追上」的窗口**：`rotated` 返回 200 就代表端口与凭据已经提交，没有 200 就回滚。agent 不再有后台 apply，也就不需要 pending 标记保护新端口。

## 按需升级（`upgrade_singbox`）

桌面端在服务器详情页点「检查升级」→ 控制面发一次性门票 → 直连 32100 调本工具。

- **入参是空对象**：不接受版本、URL、哈希。App 能传版本，就等于能往节点装任意二进制。
- 执行：用自身 `server_token` `GET /v1/agent/desired-state` 一次 → 读已安装版本 → 相同直接返回 `{installed, target, upgraded:false}`；不同则下载、校验 sha256、替换二进制、`systemctl restart`、验活（本机端口 + 出站），然后上报一次 `active`（带新版本，控制面据此刷新 `servers.singbox_version`）。
- 返回 `{installed, target, upgraded}`；失败沿用 `{ok:false,error:{kind,reason?,message}}`（`reason` 目前只有 `agent_busy`）。
- **替换前先把旧二进制拷成 `sing-box.bak`**：新版本重启/自检失败就换回去并重启；换回失败则保留 `.bak`（错误里带路径，下次升级直接复用它而不是覆盖）。升级全程不上报 `installing` / `verifying`，不改凭据与配置；失败只在控制面已确认这台机器 active 时才上报 `failed`（进程内标志、不落盘）并带当时实际装着的版本，装机中的机器只回工具错误、不会被一次误调用销毁。已是最新（`upgraded:false`）时也会补报一次 `active`，把丢失过的版本列修回来。
- 与轮换共用 busy 锁：同时发起时后到的那个返回 `kind=retryable` + `reason=agent_busy`。
- 每次工具调用前先 best-effort 补报一次 `active`（控制面对已 active 机器幂等），自愈「apply 成功但 active 上报丢了」这条路径，不需要持久化的脏标志。

## 启动时的期望状态

- **先监听，再 apply**：MCP 端点（32100）在首次安装/应用之前就 bind，下载慢或 systemd 卡住时桌面端仍能连上。
- **desired-state 只在启动时拉一次**（enroll 响应里已经带了就不重复拉）。与当前 config.json + 已装版本一致时先做一次 `systemctl is-active`，服务没跑就重启一次，仍失败则上报 `failed`；正常时只上报 `active`，**不重启 sing-box**；不一致才走安装/应用流程。之后不再有任何周期请求。
- **版本不再由平台定时推送**：桌面端点「检查升级」时经 MCP 调 `upgrade_singbox`（见上）。
- **启动后再补报一次 `active`**（`last_desired` 存在且本地确实在服务这组凭据时）：apply 成功但 `active` 上报丢了这类情况靠它自愈；没有持久化标志，也不会把没在服务的节点报成 active。
- 轮换、升级与启动 apply 共用一把异步锁，同一时刻只有一个写操作。
- 期望状态里的 `control_port` 与当前不同会告警；改控制端口需要重启 agent 才能重新绑定（本期不做热迁移）。
- **控制面 409 是终态**：enroll 返回 409（token 已消费/过期、服务器已销毁）时打一条 error 说明需要重建，然后退避 10 分钟再试，不退出进程（避免 systemd 每 10 秒重启刷屏）。启动时 desired-state 返回 409 只记日志并改用持久化的期望状态——没有轮询，也就没有「停药」这回事。

## 日志与脱敏

- `log_level` 或 `RUST_LOG` 控制；debug 会打印下载主机（不含完整 URL/查询串）、sha256、端口、命令名、验活结果。
- **同时落盘**：默认 `/var/log/veyl-agent/agent.log`（由 agent 自己创建，目录 0700、文件 0600），按 `log.max_bytes` 轮转、保留 `log.keep_files` 份。console 登录机器排查时直接 `tail -f /var/log/veyl-agent/agent.log`，不用翻 journald。文件打不开（例如非 root 本地调试）只降级为 stdout，不阻止启动。
- **启动横幅**（每次启动一行，`veyl-agent starting`）：版本、配置路径、state 文件、日志文件、控制面 host（只到 host:port，不含路径/查询串）、控制端口，以及 `mode="cold"`（首次 enroll）或 `mode="restored"`（从 `state.json` 恢复）。重置密码重启后先看这一行判断 agent 是否自己恢复。
- **关键流程**都有日志：enroll 结果（server_id/端口/sing-box 版本/sha 前 8 位）、期望状态、sha 校验、`sing-box check` 输出（截断）、`systemctl daemon-reload/enable/restart/is-active` 各步结果、监听 + 出站验活、每个 MCP 请求（method、tool、令牌校验结论、状态码、耗时）、轮换全过程（旧端口→新端口、`rotated` 上报状态、是否回滚）。
- 密码与令牌永不进日志：`DesiredState`/`Enrollment`/`ReportRequest`/`AgentState`/`AgentConfig`/`ControlError`/`RotateError` 的 `Debug` 手写脱敏；stdout 与文件两路用同一条 `redact_sensitive`（JSON 的 `password`/`server_token`/`token`/`authorization` 字段、`agt_`/`enr_` 前缀串、`Authorization:` 头、`Bearer <token>`、`password=`/`token=` 赋值），并截断。
- 状态文件 `state.json`（0600）保存 `server_id`、`server_token`、最近端口、证书指纹、`token_public_key` 与 `last_desired`（含密码，用于控制面不可达时重启恢复）；密码与令牌不会出现在日志里。解析失败时改名为 `state.json.corrupt.<时间戳>` 备份并重新 enroll，不会把进程拖进 systemd 重启循环。
- **jti 重放表落盘**：已用 jti + 过期时间写在 `state_dir/jtis.json`（0600、原子 rename、上限 512 条、过期清理），重启后 60 秒窗口内不能重放同一令牌；demo/serve 用内存表。
- **证书热重载**：公网 IP 后补探测导致 leaf 重签后，下一条 TLS 连接即使用新证书，不需要重启 agent。
- **命令超时**：`systemctl`/`journalctl`/`sing-box` 等系统命令 30 秒，`tar`/`install` 300 秒，超时按可重试处理并记录命令；下载只接受 https、重定向不允许降级到 http、上限 200 MiB。

## 测试

```bash
cargo test
```

当前 **80 个单元测试**，覆盖：

- 令牌：JWT 往返、过期、错误签名、错误 `server_id`、jti 一次性、JWK 解析、篡改 payload/alg=none、批量 `tools/call` 计数、**jti 跨重启重放**、过期 jti 清理、重放表上限；
- 证书：CA/leaf 持久化、leaf 缺失时只重签 leaf、公网地址变化时只重签 leaf、动态 Host 白名单、公网 IP 重签只发生一次、**重签后新连接实际拿到新证书（TLS 握手校验）**；
- 配置：HTTPS 强制、控制端口必须在带外、allowed_hosts 合并去重、cloud-init 最小配置解析、**release 策略拒绝 `allow_insecure_control_plane`**、`Debug` 不打印 enroll token；
- control：enroll 响应的 `token_public_key`、desired 两种包裹形态、report 字段、错误体 Display/Debug 脱敏；
- 端口：只在带内、排除已用、带耗尽返回空；
- sing-box：配置 JSON、unit 内容、版本解析、sha 不一致不安装、`check` 失败不 restart、**版本白名单**、**tar 路径穿越/绝对路径/反斜杠拒绝**、**symlink 条目拒绝**；
- 轮换：成功上报 `installing/verifying/rotated` 且 rotated 带新密码；`rotated` 被 409 拒绝时回滚旧配置、不落状态、不上报 `failed`；busy 返回 retryable；`Debug` 脱敏；
- 期望状态：一致时不重启；变化时应用；apply 失败内部重试一次；两次 restart 失败后才上报 `failed`；active 未确认时每轮补报、失败保留标记；轮换后控制面未追平时不覆盖新端口；**config 一致但服务死了：重启一次成功继续报 active，仍失败上报 failed**；
- 状态持久化：缺失文件、roundtrip、0600、端口去重、`last_desired`（含密码）落盘且 Debug 脱敏、**损坏文件备份后重置**；
- 脱敏：密码/令牌字段、未知键的 token 串、嵌套转义、`Authorization`/`Bearer`、`password=`/`token=` 赋值、截断；
- 日志文件：跨 write 分片仍按行脱敏（密码/`server_token`/`Authorization`/`Bearer` 不落盘）、0600 文件 + 0700 目录、按大小轮转并只保留配置份数、轮转后写新文件；`log.file: null` 可关闭，缺省配置可启动；
- host：**命令超时返回可标记错误**、tar/install 用 300 秒超时、下载拒绝 http；
- 进程守护：MCP 任务正常退出或报错都被视为致命（主循环退出码非 0，交给 systemd 重启）。

## 未完成 / 需要真机或控制面确认

1. **真机 systemd**：`systemctl`、`install`、`tar`、`journalctl` 的实际行为只在 FakeHost 上测过；需要在 Ubuntu 机器上跑一次完整 enroll + install + rotate。
2. **真实下载**：GitHub release 的 tar.gz 校验/解包尚未在真机跑；URL 由控制面 `SING_BOX_DOWNLOAD_URL` 下发。
3. **控制面联调**：`rotated`、`ca_pem`、`error` 已按最新契约实现，但尚未和线上 Worker 跑过一次真实轮换。
4. **穿隧道验活**：当前「出站探测」只证明宿主还能出网，不等于 SS 隧道可用。真正的穿隧道探测需要本地 SS 客户端，属于后续。
5. **enroll 崩溃窗口**：控制面先消费一次性 token 再返回；若 agent 在返回后、写 state 前崩溃，重启会收到 409。控制面已支持 TTL 内幂等换发新 `server_token`；agent 现在也会把 409 当终态、退避 10 分钟重试并明确提示重建，不再 10 秒重启一次。真机上仍需验证这条恢复路径。
6. DO metadata 公网 IP 查询是新增行为，只在 DO 上有效；其他环境要显式配 `public_host`。
7. 不做自更新；版本由重建决定（设计 §12）。
8. 只改 `agent/`；未提交、未部署。

## 目录结构

```
agent/
  Cargo.toml            standalone；rmcp =1.8.0、reqwest 0.13.5
  Cross.toml            musl 交叉构建配置（目标镜像里装 cmake/perl）
  config.example.json   生产配置样例
  src/cert.rs           rcgen 自签 CA/leaf、SAN、指纹、持久化
  src/identity.rs       动态 TLS 身份：指纹、CA PEM、Host 白名单、公网 IP 重签
  src/auth.rs           令牌签发/验签、exp/server_id、jti 重放表
  src/server.rs         MCP Streamable HTTP + TLS + 验签中间件 + 工具
  src/client.rs         rmcp client（CA / 指纹 pin / 裸诊断）
  src/config.rs         配置加载与校验
  src/state.rs          server_token / 端口历史 / last_desired
  src/control.rs        enroll / report / desired-state 客户端
  src/host.rs           命令、文件、网络、下载的 Host 抽象（可测试）
  src/singbox.rs        下载校验、配置、systemd、验活
  src/rotation.rs       端口/密码、轮换、期望状态应用、按需升级
  src/agent.rs          run 主循环
  src/logging.rs        日志初始化与脱敏
  src/main.rs           CLI：run / serve / gen-certs / mint-token
  examples/demo.rs      一条命令跑完 MCP 三组场景
```

## 令牌与 MCP 细节

令牌是控制面 `signAgentToken` 签的 JWT（与 `lib/crypto.ts` 的 WebCrypto Ed25519 互通）：

```
base64url({"alg":"EdDSA","typ":"JWT"}) . base64url({"server_id","jti","exp"}) . base64url(sig)
```

签名覆盖 `header.payload`。每次请求都验签、`server_id`、`exp`；`jti` 只在 `tools/call` 到达 handler 前原子消费。因此一张令牌最多授权一次工具执行（MCP 会话的 `initialize/initialized/tools/list` 不消费），重放第二次 `tools/call` 返回 401 `replayed`。

**批量请求**：请求体是 JSON-RPC 数组时，若包含多个 `tools/call`，直接返回 400 `batch_tool_calls_rejected`，避免一个 jti 下执行多次工具；只含一个 `tools/call` 的数组正常消费 jti。

**Host 校验**：rmcp 自带的静态 Host 白名单已关闭，改由 agent 的验签中间件检查动态白名单（`localhost / 127.0.0.1 / ::1` + 配置 + 公网 IP）。这样公网 IP 后补探测成功后无需重启服务。

内置公钥来源（按顺序）：

1. enroll 响应的 `token_public_key`（JWK），持久化在 `state.json`；
2. 配置里的 `signer_pubkey`（64 hex）；
3. 编译期 `VEYL_AGENT_SIGNER_PUBKEY=<64 hex>`；
4. 开发用 `veyl-agent serve --signer-pubkey <hex>`。

开发命令（都在 `dev` feature 下，不会编进生产二进制）：

```bash
cargo run --features dev -- gen-certs --dir demo-certs --host 203.0.113.7
cargo run --features dev -- mint-token --signing-key <64 hex> --server-id srv_local --ttl-secs 60
cargo run --features dev -- serve --addr 127.0.0.1:32100 --cert-dir demo-certs --host 203.0.113.7 \
  --server-id srv_local --signer-pubkey <64 hex>
```
