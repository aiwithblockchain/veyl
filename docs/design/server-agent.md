# 服务器上的更新代理（veyl-agent）

> 日期：2026-11-14
> 状态：协议定稿，M1 先做「安装 + 心跳 + 版本上报」；原地升级在 M1 末尾或 M2 实现
> 关联：`docs/design/my-servers.md` §6（安装）、§17（无 SSH）、`docs/design/remote-groups.md`

---

## 0. 结论先行

| # | 问题 | 结论 |
|---|---|---|
| 1 | 为什么需要它 | 云厂商 API 只能创建 / 销毁机器，**改不了机器里的软件**；SSH 已从产品撤掉；所以机器里需要一个**只外连、不监听**的更新代理 |
| 2 | 它能做什么 | 拉指令、原地升级 / 回滚 sing-box、配置变更、心跳与健康上报、未来的节点重建指令；**不能执行任意命令** |
| 3 | 它怎么部署 | 随 cloud-init 安装；systemd timer 定时跑（默认 60 分钟，失败退避）；二进制签名 + sha256 校验；配置 `/etc/veyl/agent.toml` |
| 4 | 协议方向 | **只有代理 → 控制面的 HTTPS 请求**；指令挂在心跳响应里，代理不监听任何端口 |
| 5 | 谁能触发升级 | 用户在界面上点「升级节点」，或控制面判定安全修复必须升级；**没有静默的例行自动升级** |
| 6 | 失败怎么办 | 校验不过不执行；升级失败自动回滚并上报；网络失败指数退避 |
| 7 | M1 做到哪 | M1：cloud-init 安装代理 + 心跳 + 版本 / 健康上报；原地升级与回滚在 M1 末尾或 M2 |
| 8 | 不做什么 | 不入站命令通道、不做 SSH、不做远程 shell、不做静默升级、不做灰度 |

一句话：**代理只做一件危险的事——按控制面签名过的指令换掉本机的 sing-box 二进制；除此之外它是只读的。**

---

## 1. 定位与约束

### 1.1 为什么需要

- 云厂商 API（DigitalOcean `/v2/droplets`）只覆盖**机器生命周期**：创建、查询、销毁、防火墙。它没有「在这个 Droplet 里执行一条命令」的能力。
- 产品已经撤掉 SSH（`my-servers.md` §17）：用户不登录服务器，平台也不保留常驻密钥。
- 没有代理时，sing-box 的安全更新只能靠**销毁重建**——代价是一台新机器、新 IP、新凭据，以及用户重新选择节点。
- 代理把「换一个二进制并重启服务」变成一次可审计、可回滚的远程动作，同时不打开任何入站通道。

### 1.2 硬约束

| 约束 | 说明 |
|---|---|
| 只外连 | 代理只发起出站 HTTPS；**不监听任何端口**，不开放 22，不接受入站连接 |
| 不执行任意命令 | 指令是固定枚举 + 结构化字段，没有 shell 字符串、没有脚本参数 |
| 一切可验证 | 二进制有签名与 sha256；指令本身有 Ed25519 签名、过期时间与 nonce |
| 最小权限 | 代理以 root 运行只因为要替换 `/usr/local/bin/sing-box` 与 `systemctl restart sing-box`；systemd 单元做沙箱限制 |
| 可回滚 | 任何升级失败自动回到上一个可用二进制并上报 |
| 可观察 | 每次心跳、每次升级、每次失败都留结构化记录 |

---

## 2. 职责边界

### 2.1 做

| 职责 | M1 | M2 |
|---|---|---|
| 心跳 + 版本 / 健康上报 | ✅ | ✅ |
| 原地升级 sing-box（下载、校验、替换、重启、健康检查、回滚） | 末尾或 M2 | ✅ |
| 配置变更（换端口等参数；加密方式固定 `aes-256-gcm`） | — | ✅ |
| 未来的节点重建指令（重新 enroll、换凭据） | — | 预留 |
| 代理自身原地升级 | — | ✅（同一套签名流程） |

### 2.2 不做

- 不提供远程 shell、不做任意命令执行、不接受脚本。
- 不接受入站连接、不做反向隧道、不做端口转发。
- 不做例行静默自动升级（见 §7）。
- 不做灰度发布（M1 单机全量；需要时再设计分批）。
- 不读取、不上报代理流量内容；健康检查只做端口与出网探测。

---

## 3. 部署

### 3.1 安装

- **代理与 sing-box 由同一份 cloud-init 安装**（`my-servers.md` §6.3 / §6.3.1），一次开机完成，不存在第二次远程安装：
  1. 从**我们自己的控制面 / R2** 下载 `veyl-agent`（版本固定）与其 sha256 / 签名，同时下载固定版本的 sing-box；
  2. 用内置公钥验签 + 校验 sha256，失败则安装失败（走销毁重建，不在原机修）；
  3. 写 `/etc/veyl/agent.toml`（`0600`，root）；
  4. 安装 `veyl-agent.service`（oneshot）与 `veyl-agent.timer`。
- **版本约束**：服务端 sing-box 固定为**与客户端随包运行时相同的版本（当前 `1.14.4`）**；两端升级时一起升，服务端不得高于客户端支持的版本（§5.1）。
- 目录约定：
  - 当前 sing-box：`/usr/local/bin/sing-box` → 符号链接到 `/var/lib/veyl/agent/bin/sing-box-<version>`；
  - 代理：`/usr/local/bin/veyl-agent`；
  - 代理状态与历史二进制：`/var/lib/veyl/agent/`；
  - sing-box 配置：`/usr/local/etc/sing-box/config.json`（`0600`）；
  - 服务名：`sing-box`（sing-box）、`veyl-agent`（代理）。

### 3.2 systemd

```ini
# veyl-agent.service（oneshot）
[Service]
Type=oneshot
ExecStart=/usr/local/bin/veyl-agent run
User=root
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
ReadWritePaths=/usr/local/bin /usr/local/etc/sing-box /var/lib/veyl /etc/veyl
```

```ini
# veyl-agent.timer
[Timer]
OnBootSec=5min
OnUnitActiveSec=60min
RandomizedDelaySec=120
```

- 默认每 60 分钟一次，加 0–120 秒随机抖动，避免同批机器同时打控制面。
- 失败退避由代理内部完成（§9），不靠 timer 频率。
- **timer 只负责唤醒**；是否真正升级由心跳响应里的指令决定。

### 3.3 配置 `/etc/veyl/agent.toml`

```toml
server_id = "srv_..."
control_plane = "https://veyl-control-plane.ribencong.workers.dev"
device_token = "..."          # 每台服务器一个；销毁即失效
interval_seconds = 3600
state_dir = "/var/lib/veyl/agent"
```

- `device_token` 与 `server_id` 绑定，由控制面在建机时生成并随 cloud-init 下发；**不落日志、不回显**。
- 控制面地址跟 `environments.md` 的判定结果一致；代理不自行推断环境。

---

## 4. 协议

### 4.1 心跳（代理 → 控制面）

```
POST /v1/agent/heartbeat
Authorization: Bearer <device_token>
Content-Type: application/json
```

```json
{
  "server_id": "srv_...",
  "agent_version": "0.1.0",
  "singbox_version": "1.14.4",
  "config_revision": 12,
  "health": {
    "process": "running",
    "port_listening": true,
    "egress_ok": true,
    "checked_at": "2026-11-14T08:00:00Z"
  },
  "ipv4": "203.0.113.10",
  "reported_at": "2026-11-14T08:00:00Z"
}
```

- 控制面校验 token 与 `server_id` 的绑定，记录 `last_heartbeat_at`、版本与健康。
- `ipv4` 只用于对账；控制面以云厂商 API 的实例信息为准。
- 响应里带指令（§4.2）；没有事时 `action = "none"`。

### 4.2 指令（控制面 → 代理，挂在心跳响应里）

```json
{
  "key_id": "cp-2026-11",
  "directive": {
    "action": "upgrade",
    "target_version": "1.14.5",
    "url": "https://.../sing-box-1.14.5-linux-amd64",
    "sha256": "…",
    "issued_at": "2026-11-14T08:00:00Z",
    "expires_at": "2026-11-14T08:30:00Z",
    "nonce": "b64u-16-bytes",
    "signature": "base64(ed25519)"
  }
}
```

**字段清单**

| 字段 | 类型 | 说明 |
|---|---|---|
| `action` | `"none" \| "upgrade" \| "reconfigure" \| "upgrade_agent"` | 固定枚举；未知值一律按 `none` 处理并上报 |
| `target_version` | `string?` | `upgrade`：目标 sing-box 版本；`upgrade_agent`：目标代理版本 |
| `config_revision` | `number?` | `reconfigure`：目标配置版本 |
| `url` | `string?` | 必须是 `https://`；二进制或配置的下载地址 |
| `sha256` | `string?` | 下载内容的 sha256（hex） |
| `issued_at` | ISO 8601 | 签发时间 |
| `expires_at` | ISO 8601 | 过期时间；过期指令一律拒绝 |
| `nonce` | string | 每次指令唯一；用于重放保护 |
| `signature` | string | Ed25519，对规范化载荷签名（下） |
| `key_id` | string | 公钥标识；代理内置一组公钥，按 id 选择 |

**签名载荷（逐字节固定，不要 JSON 序列化后签名）**

```
action \n target_version \n config_revision \n url \n sha256 \n issued_at \n expires_at \n nonce
```

- 空字段写空串；`\n` 为 LF；UTF-8。
- 代理用内置公钥验签（`key_id` 选择），失败即丢弃指令、上报 `invalid_signature`。
- 拒绝 `expires_at` 已过、`issued_at` 早于本机上次成功指令时间（时钟偏差 > 5 分钟也拒绝）、`nonce` 重复（保留最近 32 个）。
- **URL 只允许 https**，且 host 必须在控制面下发的白名单（对象存储域名）内；不接受任意域名。

### 4.3 上报（代理 → 控制面）

| 端点 | 用途 |
|---|---|
| `POST /v1/agent/heartbeat` | 心跳 + 取指令 |
| `POST /v1/agent/events` | 升级 / 配置变更 / 回滚结果（也可并入心跳的 `last_result`） |

事件体：

```json
{
  "server_id": "srv_...",
  "kind": "upgrade",
  "from_version": "1.14.4",
  "to_version": "1.14.5",
  "result": "success" | "failed" | "rolled_back",
  "stage": "download" | "verify" | "replace" | "restart" | "health_check",
  "detail": "…（脱敏，≤ 500 字符）",
  "at": "2026-11-14T08:05:00Z"
}
```

- `detail` 不含 token、密码、完整路径、配置内容。
- 控制面把结果写进服务器事件（§7.3），界面可显示「上次升级：成功 / 已回滚」。

---

## 5. 升级流程

```
心跳拿到 upgrade 指令
  └─ 验签 / 时间 / nonce
       └─ 下载到 /var/lib/veyl/agent/tmp/<nonce>
            └─ 校验 sha256
                 └─ 保留当前版本二进制（上一版不删）
                      └─ 原子替换符号链接 /usr/local/bin/sing-box
                           └─ systemctl restart sing-box
                                └─ 健康检查（≤ 60s）
                                     ├─ 成功 → 上报 success
                                     └─ 失败 → 回滚符号链接 + 重启 → 上报 rolled_back
```

- **原子性**：新二进制写到 `/var/lib/veyl/agent/bin/sing-box-<version>`，`rename` 到临时链接再 `rename` 覆盖 `/usr/local/bin/sing-box`；进程不会被写到一半的文件启动。
- **健康检查**：`systemctl is-active sing-box` + 本地端口在听（TCP/UDP）+ 可选出网探测（与安装脚本同一套，`my-servers.md` §6.3 第 8 步）。
- **回滚**：恢复上一版符号链接并重启，再健康检查一次；回滚失败上报 `failed` + `stage=health_check`，等控制面处理（不无限重试同一版本）。
- **拒绝降级**：`target_version` 低于当前版本时拒绝，除非指令显式带 `allow_downgrade: true`（默认不带，安全修复回滚场景才用）。
- 升级与配置变更**不同时下发**：一次心跳只有一个 action。

### 5.1 版本对齐（硬规则）

- 服务端 sing-box 固定为**与客户端随包运行时相同的版本**（当前 `1.14.4`）；安装脚本 pin 同一版本，不从上游追新。
- **服务端版本不得高于客户端支持的版本**：控制面签发 `upgrade` 前必须确认该版本已包含在客户端随包运行时里；`target_version > 客户端支持版本` 的指令不签发，代理收到也拒绝（`stage = "verify"`，上报 `failed`）。
- 升级顺序永远是：**先升客户端（随包运行时）→ 再升服务端**。两端不同版本时，服务端保持旧版可用，不强制追平。

---

## 6. 配置兼容

- 控制面在推送 `reconfigure` 前，用**目标 sing-box 版本**校验配置（本机离线校验或控制面侧的版本化校验器）；不兼容不推。
- `config_revision` 单调递增；代理只接受比本地新的 revision。
- 配置变更同样走签名 + sha256；下载后先写临时文件，校验通过再原子替换 `/usr/local/etc/sing-box/config.json` 并重启。
- 升级（换二进制）与配置变更（换 config）分开下发：先升级，健康后再推配置；避免「新二进制 + 旧配置」或「旧二进制 + 新配置」的中间态同时出现。

---

## 7. 触发策略

| 触发 | 谁发起 | 行为 |
|---|---|---|
| 用户点「升级节点」 | 用户在 `我的服务器` 详情 | 控制面生成 `upgrade` 指令；下次心跳执行；界面显示进度与结果 |
| 安全修复 | 控制面（运营 / 安全） | 标记为必须升级；下次心跳下发。**这不是例行静默升级**：它由一次明确的安全决定触发，并写审计日志；界面显示一条「安全更新已安装」的说明 |
| 配置变更 | 用户或控制面 | 同用户触发路径，走 `reconfigure` |
| 例行检查 | timer | **只心跳，不升级**：没有指令就什么都不做 |

- **没有「有新版本就自动升」**：默认 `action = "none"`，除非有人明确点了升级或安全事件要求。
- 每次升级在服务器事件表里留一条记录（`from` / `to` / `result` / `at` / `trigger`），与订单、销毁记录同一处可查。

---

## 8. 安全边界

| 项 | 约束 |
|---|---|
| 凭据 | 每台服务器一个 `device_token`，绑定 `server_id`；**销毁即失效**；重建生成新 token；不写日志、不进 AI 上下文 |
| 入站 | 代理**不监听端口**；防火墙不开放任何代理端口；只有出站 443 |
| 指令 | 固定枚举 + 结构化字段；**没有命令字符串**；未知 action 按 `none` |
| 签名 | Ed25519 私钥只在控制面（KMS / Secret Manager）；公钥内置在代理；`key_id` 支持轮换 |
| 下载 | 仅 https + 域名白名单 + sha256；校验失败不执行 |
| 重放 | `nonce` + `issued_at` / `expires_at` + 单调时间；重复或过期一律拒绝 |
| 提权 | 代理以 root 运行，但只做「替换二进制 + 重启服务」；systemd 沙箱限制写路径 |
| 日志 | 脱敏：不含 token、节点密码、配置内容、完整 URL 查询串 |
| 代理自身 | 与 sing-box 同一套签名 / sha256 / 回滚流程；不给自己开后门 |

---

## 9. 失败与可观测

- **网络失败**：指数退避（1m → 2m → 5m → 15m → 30m，上限 60m），不放弃、不弹窗。
- **连续失败**：控制面在 `last_heartbeat_at` 超过 3 个周期未更新时标记「失联」，界面提示；不自动销毁（失联不等于机器坏了）。
- **升级失败**：上报 `rolled_back` 或 `failed`；同一版本不自动重试，等控制面决定（重新签发或放弃）。
- **控制面展示**（服务器详情 / 运维视图）：`agent_version`、`singbox_version`、`config_revision`、`last_heartbeat_at`、`last_upgrade {from,to,result,at}`。
- **客户端界面**：服务器详情只多一行只读「版本」（如 `sing-box 1.14.4`）与「上次检查」；完整诊断在设置 › 关于/诊断或运维视图，不堆进主流程。
- 代理日志写 `/var/log/veyl-agent.log`（脱敏、轮转），**不上传全文**；只上报结构化事件。

---

## 10. M1 与 M2 的切分

### M1（先跑通「可观测」）

1. cloud-init 安装 `veyl-agent`（验签 + 校验）。
2. `agent.toml` 写入 `server_id` / `device_token` / 控制面地址。
3. systemd timer 每小时心跳。
4. 控制面上报：`agent_version`、`singbox_version`、`config_revision`、健康三态、`last_heartbeat_at`。
5. 控制面返回 `action = "none"`；**M1 不执行任何升级**。
6. 验收：新建服务器后 5 分钟内出现首次心跳；服务器详情能看到版本与最后心跳。

### M1 末尾 / M2（可执行升级）

7. 指令签名、nonce / 时间校验、下载 + sha256。
8. 原地升级 + 回滚 + 事件上报。
9. 界面「升级节点」入口。
10. 代理自身升级。
11. 配置变更（`reconfigure`）与版本兼容校验。

> 协议一次设计完（§4），M1 只实现「心跳 + 读指令但只接受 `none`」；这样 M2 不需要改协议，只加执行分支。

---

## 11. 不做

| 不做 | 原因 |
|---|---|
| 入站命令通道 / 反向隧道 | 等于重新开一条 SSH；攻击面比收益大 |
| 远程 shell / 任意命令 | 代理只需一件事；通用执行器迟早被滥用 |
| 静默例行自动升级 | 用户要知道软件什么时候变；安全修复除外，且留审计 |
| 灰度发布 | M1 规模小，先单机全量；需要时另设计分批与回滚 |
| 上传完整日志 / 配置内容 | 只上报结构化、脱敏事件 |
| 代理读取用户流量 | 健康检查只做进程、端口、出网探测 |

---

## 12. 验收

| # | 断言 |
|---|---|
| A1 | 新建服务器后 5 分钟内出现首次心跳；`agent_version` / `singbox_version` / `config_revision` 正确 |
| A2 | 代理不监听任何端口；`ss -lnt` 无代理相关监听；防火墙无代理端口 |
| A3 | 篡改指令签名、重复 nonce、过期 `expires_at`、低版本 `target_version` 均被拒绝并上报 |
| A4 | 升级成功路径：下载 → 校验 → 原子替换 → 重启 → 健康检查 → 上报 `success` |
| A5 | 升级失败路径：注入损坏二进制或让健康检查失败，自动回滚到上一版并上报 `rolled_back` |
| A6 | 网络断开时按退避重试；恢复后心跳继续，不重复执行已完成的指令 |
| A7 | 销毁服务器后 `device_token` 失效；重建服务器生成新 token |
| A8 | 代理日志、控制面事件、AI 上下文都不含 token、节点密码或配置内容 |
