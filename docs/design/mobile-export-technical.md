# 手机端导出：技术设计与契约增量

> 日期：2026-11-19（§3.7 多格式增补于 2026-11-20）
> 状态：**技术设计，待评审**。只出文档：不改代码、不改共享契约文件、不改其它设计稿、不提交。
> 上游：`mobile-export.md`（需求）、`mobile-export-ui.md`（界面定稿）、`my-servers.md` §16 / §17（凭据模型、用户无 SSH）、`login-and-payment.md` §2.5（令牌模型）、`environments.md`
> 事实边界：sing-box 配置形状已于 2026-11-19 用随包 `sing-box 1.14.4` 的 `check` 在本地实测通过（§3.6，含最小 TUN 入站、最小 DNS 与零节点样张）；真机先后暴露「无 DNS 时 VPN 已连、无法上网」「无 TUN 入站时已连接但流量为 0」「有 TUN 但仍无法出网（出站未绑定物理网卡）」「有计数、能测速、仍打不开网页（缺 `stack` / 缺 `sniff`、多带 `strict_route`）」四种现象，据此依次改写模板；TUN 是否创建系统隧道由官方客户端源码确认（§3.5）。**2026-11-20：四项修复后在 iPhone 上确认可打开网页（Wi-Fi）；蜂窝网络复验尚未执行**（V12）。多格式（2026-11-20，§3.7）的客户端 Basic 支持已对 CMFA 主路径与 Hiddify 的 Dart 回退路径源码核实；Shadowrocket / Karing / Stash 未核实（Shadowrocket 由产品拍板先上界面，带撤下条件，§3.7.8）。客户端扫码、Basic 认证、自动更新等外部行为沿用需求文档的「待验证」，本文件 §8 给出可执行步骤，**不凭记忆断言**。
> 契约增量：全部写在本文件 §5 / §6，不直接改 `docs/contracts/*`，由 PM 统一集成。

---

## 0. 结论先行

| # | 问题 | 结论 |
|---|---|---|
| 1 | 谁生成配置 | **控制面**。节点凭据只在控制面，手机只认 URL；桌面不可达时也能更新 |
| 2 | 端点 | `GET /v1/mobile/profile`（sing-box，Basic）、`GET /v1/mobile/profile/clash`（Clash YAML，Basic）、`GET /v1/mobile/profile/ss`（ss:// 列表，Basic）；`POST /v1/mobile/token`（Bearer）建/取令牌；`POST /v1/mobile/token/rotate`（Bearer）重新生成 |
| 3 | profile 的认证 | **HTTP Basic**，用户名固定 `veyl`，密码是导出令牌。官方客户端必须支持 Basic，且这是它唯一能携带凭据的位置；bearer 需要客户端支持自定义头，客户端不提供这个入口 |
| 4 | 令牌存哪 | 控制面新表 `mobile_tokens`：**`token_hash` 做查找、AES-GCM 密文保存令牌本身以便回显**。哈希保证「库泄露拿不到令牌」，密文保证「弹层每次打开都能显示同一个二维码」；桌面不落盘 |
| 5 | 令牌生命周期 | 账户级一条，长期有效；「重新生成」= 覆盖同一行，旧值立即失效；不做设备数与到期时间；**不复用** access / refresh 令牌 |
| 6 | 导出内容 | 该账户名下的控制面服务器（对应桌面 `source = owned`），且 `state ∈ {active, healthy}`、`node_id` 非空、凭据未销毁；只出 shadowsocks 出站 + 一个 selector + direct + **最小 TUN 入站（含 `route.auto_detect_interface`）** + **最小 DNS（DoH 经代理 + `hijack-dns`）**；**不出**桌面 TUN 参数、系统代理、本地端口、Clash API |
| 7 | 零节点 | **200 + 只含 `direct`、不含 DNS 的合法配置**，不是 4xx。理由与验证见 §1.7 / §3.4 |
| 8 | 二维码在哪生成 | **Rust**：新增 `qrcode` crate，返回 `data:image/svg+xml;base64,…`。两个入口共用一条命令，前端不引入二维码库 |
| 9 | URL 的 origin | 桌面用 `control_plane::env::current().base_url` 拼，不写第二处常量；控制面只回令牌，不回 URL |
| 10 | 是否新增事件 | **不新增**。弹层是主动打开的同步请求，结果随命令返回；节点增减不会改变已生成的 URL |
| 11 | 是否给 AI 工具 | **不新增**。令牌与 URL 不得进入 AI 上下文；只把 `account.mobile` 加进 `OpenSettings` 行白名单（仍只是指路） |
| 12 | 桌面本地库 | **不改**。没有新表、没有新列，`data-model.md` 不升版 |
| 13 | 三种格式（2026-11-20 增补） | sing-box JSON、Clash/Mihomo YAML、ss:// 列表共用**同一枚令牌与 HTTP Basic**；路径 `/profile`、`/profile/clash`、`/profile/ss`；rotate 一次三种格式同时失效。详见 §3.7 |

一句话：**控制面发一条可吊销的账户级 URL，桌面只负责把它变成二维码；手机按自己的节奏来取，我们不连设备、不写移动端 App。**

---

## 1. 控制面端点

### 1.1 总览

| 方法 | 路径 | 认证 | 调用方 | 作用 |
|---|---|---|---|---|
| `POST` | `/v1/mobile/token` | **Bearer**（现有 access token） | 桌面 | 幂等：没有就建，有就回显同一个令牌 |
| `POST` | `/v1/mobile/token/rotate` | **Bearer** | 桌面 | 覆盖令牌，旧值立即失效 |
| `GET` | `/v1/mobile/profile` | **HTTP Basic** | sing-box 官方客户端 | 返回 sing-box 配置 JSON |
| `GET` | `/v1/mobile/profile/clash` | **HTTP Basic** | Clash / Mihomo 类客户端 | 返回最小 Clash YAML（§3.7.3） |
| `GET` | `/v1/mobile/profile/ss` | **HTTP Basic** | SS 客户端 / 桌面取文本 | 返回 SIP002 ss:// 列表（§3.7.4） |

挂载位置：`cloudflare/control-plane/src/index.ts` 的模块链里，放在 `handleServers` 之后新增 `handleMobile`；模块本体是新文件 `src/mobile.ts`。不复用 `/v1/servers/*` 路径：这是账户级能力，不是单台服务器能力。

> `/profile/clash` 与 `/profile/ss` 的**内容形状**见 §3.7；本节下面的认证、限流、缓存、401/429 与错误处理三者共用，不各写一套。

```
桌面  --POST /v1/mobile/token (Bearer)-->  控制面  → { token }
桌面   拼 https://veyl:<token>@<origin>/v1/mobile/profile
桌面   生成 sing-box://import-remote-profile?url=…#Veyl 二维码
手机  --扫码导入--> 官方客户端
手机  --GET profile (Basic)-->  控制面  → 200 sing-box JSON
手机  --每 ~60 分钟重复 GET-->  控制面  → 当前节点集合
```

### 1.2 为什么 profile 用 Basic，token 用 Bearer

| 端点 | 选择 | 理由 |
|---|---|---|
| `GET /v1/mobile/profile` | **Basic** | ① 官方客户端「必须支持 HTTP Basic」是既有事实（`mobile-export.md` §2.3）；② 手机端没有我们的代码，凭据只能随 URL 走（`https://veyl:<token>@host/...`）；③ bearer 需要客户端提供「自定义请求头」这一入口，官方文档只承诺 Basic，没有证据支持 bearer 可用 |
| `POST /v1/mobile/token*` | **Bearer** | 桌面已有 access token 与刷新链路（`control_plane/auth.rs`），直接复用 `authenticate()`；导出令牌不参与「建令牌」这个动作，避免自己授权自己 |

Basic 的解析约定：

- 请求头 `Authorization: Basic base64("veyl:<token>")`；
- 生成的 URL 里用户名固定 `veyl`；服务端解析时**只校验密码**（用户名忽略），客户端把用户名归一化也不影响结果；
- 令牌形态 `mp_` + 32 字节随机数的 base64url（共 46 字符），只含 `[A-Za-z0-9_-]`，放进 URL 不需要额外转义；
- **禁止**把令牌放 query（`?token=`）：query 会进访问日志与 Referer，Basic 的密码在 Authorization 头里，不进请求行。

> 若 V3 实测某个客户端不保留 URL 里的 userinfo，回退方案是 `GET /v1/mobile/profile/<token>`（令牌进路径）。这条回退只改 URL 构造与路由匹配，不改令牌表与配置生成；在 V3 结论出来前不实现第二套。

### 1.3 `POST /v1/mobile/token`

没有就创建，有就返回同一个。**不是**每次调用轮换——否则手机每被打开一次弹层就掉线。

请求：无 body。

```json
{
  "token": "mp_...",
  "created_at": 1763596800000,
  "rotated_at": null
}
```

- `created_at` / `rotated_at`：Unix 毫秒（与 D1 实体一致）。
- 只接受 `account.kind = "email"` 的账户；匿名设备账户 → `PRECONDITION_FAILED`，`details.reason = "login_required"`。这与产品门禁「必须邮箱登录」一致，且不依赖前端是否真的挡住了。
- 实现必须**并发安全**：先生成候选令牌 → `INSERT OR IGNORE` → 再 `SELECT` 并解密返回**库里实际存的那条**。两个桌面同时首次打开时，只能有一个令牌生效，两边拿到的必须是同一个。
- 既有行的密文解不开（密钥换过 / 数据损坏）：返回 `INTERNAL`，`details.reason = "mobile_token_corrupt"`，`retryable = false`，**不静默轮换**（静默轮换会把手机踢下线）；用户点「重新生成」即可覆盖，rotate 不依赖旧密文。
- 限流：每账户 10 次/小时（`rate_limits` 键 `mobile-token:<account_id>`）。
- 审计：`audit_log` 写 `mobile.token_create`，detail 只含 `{ "created": true|false }`。

### 1.4 `POST /v1/mobile/token/rotate`

请求：无 body（`confirm` 由桌面命令强制，控制面只需要收到已确认的调用）。

```json
{
  "token": "mp_...",
  "created_at": 1763596800000,
  "rotated_at": 1763600400000
}
```

- 生成新令牌，`UPDATE mobile_tokens SET token_hash = ?, iv = ?, ciphertext = ?, created_at = ?, rotated_at = ?, last_used_at = NULL WHERE account_id = ?`。单行原子更新，旧哈希在同一语句里消失。
- 旧 URL 在下一次拉取时得到 **401**（§1.5）。
- 不返回「旧令牌作废于何时」给客户端：桌面只需要新值。
- 限流：每账户 10 次/小时（防脚本刷）；产品文案已有确认步骤，限流只是兜底。
- 审计：`mobile.token_rotate`，detail `{ "previous_created_at": <ms> }`，**不记任何令牌片段**。

> M1 不提供「只吊销、不再生成」的独立入口。界面只有「重新生成」，多一个端点就是多一条没有入口的路径。

### 1.5 `GET /v1/mobile/profile`

成功：`200`，body 是**裸 sing-box 配置 JSON**（不是我们的 `{data:...}` 信封），因为 sing-box 客户端直接解析 body。

响应头：

```
Content-Type: application/json; charset=utf-8
Cache-Control: no-store
X-Content-Type-Options: nosniff
```

**不使用 CDN 缓存**：令牌轮换必须在下一次拉取立即生效；`no-store` 同时避免中间缓存把配置留在边缘。

失败：

| 情况 | 状态 | body | 备注 |
|---|---|---|---|
| 没有 `Authorization` / 不是 Basic / 令牌查不到 | `401` | 错误信封 `UNAUTHENTICATED` | 必须带 `WWW-Authenticate: Basic realm="veyl", charset="UTF-8"` |
| 账户 `status != active` 或 `merged_into` 非空 | `403` | `FORBIDDEN` | 与 `authenticate` 的账户检查同口径 |
| 超限 | `429` | `RATE_LIMITED` | 带 `Retry-After` |
| `MOBILE_TOKEN_ENC_KEY` 未配置 / D1 不可用 | `503` | `INTERNAL`，`retryable = true` | 与现有端点一致：配置缺失不崩 |
| 单台节点的凭据解不开 | — | — | **跳过这台**，不失败；日志只记数量 |
| 全部节点都跳过 / 账户没有可用节点 | `200` | 零节点配置 | 见 §1.7 |

认证流程：

1. 取 Basic 密码 → `sha256B64u(token)`；
2. `SELECT account_id FROM mobile_tokens WHERE token_hash = ?`（唯一索引）；
3. `JOIN accounts` 校验 `status = 'active'` 且 `merged_into IS NULL`；
4. 节流更新 `last_used_at`（`UPDATE ... WHERE last_used_at IS NULL OR last_used_at < now - 5min`），不写 audit（避免每条 60 分钟一次的请求都产生审计行）。

### 1.6 限流

| 键 | 上限 | 用途 |
|---|---|---|
| `mobile-profile:<account_id>` | 30 次/小时 | 正常每 60 分钟一次 + 用户手动刷新，30 足够；防止误配置成秒级轮询 |
| `mobile-profile-bad:<ip>` | 60 次/小时 | 令牌无效的请求。令牌是 256 bit 随机值，穷举不可行；这条只挡扫端点与刷日志 |
| `mobile-token:<account_id>` / `mobile-token-rotate:<account_id>` | 10 次/小时 | 防止脚本反复创建 / 轮换把手机踢下线 |

实现复用 `auth.ts` 的 `bumpRateLimit`（三条单语句守卫，无「读-判-写」竞态）。

### 1.7 零节点：为什么是 200 + 空配置，不是 4xx

| 方案 | 客户端会怎样 | 判断 |
|---|---|---|
| `404` / `410` / `503` | 更新失败，**通常保留上一次的配置**——旧节点还在，但机器已经销毁，用户看到的是「连不上」而不是「没有节点」 | 否 |
| `200` + 只含 `direct` 的合法配置 | 配置被替换成「没有代理节点」，下一次拉取仍然成功 | **采用** |

需求 §5 写的是「不允许继续返回旧节点」。4xx 只会让客户端留着旧配置，正好违反这一条；我们无法删除客户端缓存，只能**用一份新的合法配置覆盖它**。零节点样张已通过 `sing-box check`（§3.6），客户端是否接受「没有代理节点」的 profile 由 V9 验证。

---

## 2. 令牌模型

### 2.1 形态与用途

- 账户级、长期有效、可手动轮换；M1 不设到期时间、不设设备数上限。
- **只授予一个能力**：读取该账户的可用付费节点配置。不能读账户信息、钱包、订单，不能写任何东西。
- 与 access / refresh 令牌完全独立：`mobile_tokens` 与 `refresh_tokens` / `devices` 没有外键关系，吊销一边不影响另一边；导出令牌失效不会让桌面掉登录，桌面登出也不会让手机失效（§2.6）。

### 2.2 存储：哈希用于查找，密文用于回显

新表 `mobile_tokens`（§6.1）：

| 列 | 作用 |
|---|---|
| `account_id` | 主键。M1 一个账户一条 |
| `token_hash` | `sha256` 的 base64url，唯一索引；请求进来时用它 O(1) 找到账户 |
| `iv` / `ciphertext` | AES-256-GCM 密文；打开弹层时解密回显，保证同一个二维码可以被反复展示 |
| `key_version` | 加密密钥版本，预留给轮换 |
| `created_at` / `rotated_at` / `last_used_at` | 毫秒 |

**为什么不是「只存哈希」**：只存哈希就无法把令牌再交给桌面，弹层每次打开必须重新生成 → 手机每开一次弹层就被踢下线，或者桌面必须自己持久化一份明文。后者的后果是「换机 / 重装后旧链接再也看不到」，与「长期有效、重新生成才失效」的产品口径冲突。

**为什么不是「只存密文」**：认证请求只有令牌本身，没有 account_id；只存密文就得逐行解密所有账户，O(n) 且把解密暴露在认证热路径上。哈希做索引、密文做回显，两列各司其职。

**为什么风险可接受**：控制面本来就用 `CREDENTIAL_ENC_KEY` 可逆保存节点密码（`my-servers.md` §17.2 / §17.7）。令牌能读到的东西，就是同一张库里已经可逆保存的东西；拿到库 + 密钥的攻击者不需要再经令牌。导出令牌没有扩大「控制面整体失守」这个已登记的残余风险。

**密钥**：新增 Worker secret `MOBILE_TOKEN_ENC_KEY`（AES-256-GCM 的 base64 密钥），与 `CREDENTIAL_ENC_KEY` 分开。理由：两者的轮换周期与暴露面不同；分开后可以只轮换其中之一。代价是 dev / prod 各要多配一个 secret，缺失时端点返回 `503` 而不是偷偷复用别的键。

### 2.3 生成、幂等、轮换、吊销

| 动作 | 语义 |
|---|---|
| 生成 | `mp_` + 32 字节 `crypto.getRandomValues` → base64url |
| 幂等创建 | `INSERT OR IGNORE` 后读回；并发只产生一条 |
| 轮换 | 覆盖同一行；旧哈希立即不存在 |
| 吊销 | M1 的「吊销」= 轮换（旧值失效、新值可用）。数据库层删除一行也会让旧值失效，但界面没有这个入口，不实现 |
| 有效期 | 不设；账户被停用 / 合并后由 `accounts` 检查拦下（§1.5） |

### 2.4 与账号会话令牌的关系

- 不复用：`mobile_tokens` 不签发 JWT，不进入 `authenticate()` 的 access token 路径。
- 不互操作：导出令牌不能调用任何 `/v1/*` 账户端点；access token 也不能读 profile（profile 只认 Basic 密码）。
- 不共享存储：桌面令牌在 `secrets.enc` 的两个键里（`control-plane.device` / `control-plane.tokens`），导出令牌**不写桌面任何存储**。

### 2.5 与环境的关系

- 导出令牌与账户绑定，不与环境绑定；但**一个账户在两个环境里各是一条**——dev 库与 prod 库是两套 D1（`wrangler.jsonc`），令牌不会跨库。
- 同一个 release 账户换到 debug 构建：`env.rs` 让 debug 包连 `cp-dev`，那里没有这条令牌 → 首次打开会新建一条 dev 令牌；prod 的手机链接不受影响。这是构建属性带来的正常结果，不需要额外处理，界面上也不解释。
- 账户合并（匿名设备并入邮箱账户）：令牌只可能建在邮箱账户上（§1.3），合并后 `account_id` 不变，链接继续有效。

### 2.6 登出、换账号

- 桌面登出**不吊销**导出令牌：手机是另一台设备，用户没有要求断开它。吊销的唯一入口仍是「重新生成」。
- 登出后桌面是匿名设备账户，**看不到也轮换不了**这条链接（弹层回到「先登录」）；手机继续可用，重新登录同一邮箱即可恢复显示。这比「登出即踢掉手机」更符合「手机是独立设备」的直觉。
- 该账户被停用 / 合并 → profile 401/403，手机下一次更新失败（§1.5）。
- **待产品确认**：若希望「退出登录即让手机失效」，需要额外在 `logout` 里删行；默认不建议，因为用户退出桌面不等于不想在手机上用。

---

## 3. 配置生成

### 3.1 选节点

控制面 SQL（在 `servers` 与 `credentials` 上）：

```sql
SELECT s.id, s.name, s.created_at, s.ip,
       c.iv, c.ciphertext
FROM servers s
JOIN credentials c ON c.server_id = s.id AND c.destroyed_at IS NULL
WHERE s.account_id = ?
  AND s.state IN ('active', 'healthy')
  AND s.node_id IS NOT NULL
  AND s.destroyed_at IS NULL
ORDER BY s.created_at ASC, s.id ASC
```

- 判定与 `GET /v1/servers/{id}/credentials` 完全一致（那两态之外一律不取凭据），避免出现「桌面能连、手机没有」的两套口径。
- `billing_state` 不额外过滤：`past_due` 仍可能在线，真正的停机由 Cron 销毁；此时 `state` 会变，查询自然排除。加第二套判断只会和凭据端点分叉。
- 免费 / 试用节点在本地 `nodes`，不在控制面 `servers`；这个端点根本看不到它们。
- 每行解密 `ciphertext` → `{ host, port, password, method }`。`method` 不是 `aes-256-gcm` 的行跳过并计数（当前 enroll 固定写这个值，出现别的说明数据异常）。
- `host` 为空的行走 `row.ip` 兜底（与凭据端点同源）。

### 3.2 模板

```json
{
  "log": { "level": "warn" },
  "dns": {
    "servers": [
      { "type": "https", "tag": "dns", "server": "1.1.1.1", "detour": "proxy" }
    ],
    "final": "dns"
  },
  "inbounds": [
    {
      "type": "tun",
      "tag": "tun-in",
      "address": ["172.18.0.1/30", "fdfe:dcba:9876::1/126"],
      "stack": "gvisor",
      "mtu": 9000,
      "dns_mode": "hijack",
      "dns_address": ["172.18.0.2", "fdfe:dcba:9876::2"],
      "auto_route": true
    }
  ],
  "outbounds": [
    {
      "type": "shadowsocks",
      "tag": "<节点名>",
      "server": "<host>",
      "server_port": 8388,
      "method": "aes-256-gcm",
      "password": "<password>"
    },
    {
      "type": "selector",
      "tag": "proxy",
      "outbounds": ["<节点名>", "…"],
      "default": "<第一个节点名>"
    },
    { "type": "direct", "tag": "direct" }
  ],
  "route": {
    "final": "proxy",
    "auto_detect_interface": true,
    "rules": [
      { "action": "sniff", "sniffer": ["http", "tls", "quic", "dns"], "timeout": "300ms" },
      { "protocol": "dns", "action": "hijack-dns" }
    ]
  }
}
```

- 默认节点 = 按 `created_at ASC` 的第一台；手机端可以在客户端里手动切换，URL 不变。
- **必须导出最小 TUN 入站（真机现象 + 官方源码，覆盖了初版的「客户端自己建 TUN」假设）**：
  - 官方客户端**不会**替 profile 注入 TUN。sing-box-for-apple 的 `ExtensionPlatformInterface.openTun` 与 SFA 的 `VPNService.openTun` 都只在配置里存在 TUN 入站时才创建系统隧道；没有 `inbounds` 时客户端仍显示「已连接」，但流量计数为 0、任何地址都打不开。
  - `auto_route: true` 是让客户端设置 NetworkExtension / VpnService 路由与 MTU 的前提；缺了它同样会出现「连上但不接管流量」。
  - `dns_mode: "hijack"` + `dns_address` 成组出现：`dns_address` 声明隧道内使用的 DNS 地址，hijack 让 sing-box 在 TUN 上接管发往这些地址的查询，交给上方的 `dns` 模块处理。
  - `address` 用 IPv4 + IPv6 各一段（`172.18.0.1/30`、`fdfe:dcba:9876::1/126`），`mtu` 9000。
  - **`stack: "gvisor"` 必须显式写**：不写时 Apple 平台 TCP 走内核 NAT、握手不完成（桌面端 2026-11-09 同源实测）。这是 2026-11-20 真机修复的三项之一。
  - **不导出 `strict_route`**：桌面只在 Windows 上打开它（WFP 挡泄漏）；Apple 平台上它可能把代理自身的出站连接也纳入隧道，形成「有流量、出不去」。手机模板不再带这个字段。
  - 这里导出的是**最小移动端 TUN**；桌面的 TUN 参数（`route_exclude_address`、`interface_name`、平台专属字段）不导出（见下表）。
- **`route.auto_detect_interface` 必须为 `true`（TUN + 代理出站的必需组合）**：
  - 该字段默认 `false`，libbox 不会替 profile 打开它。
  - TUN 客户端的出站 socket 如果不绑定物理网卡，内核会把代理连接本身又按默认路由送回 TUN，形成回环——真机表现是隧道已建立、VPN 标志在，但任何外网地址都出不去。
  - 因此它和 TUN 入站必须成组出现；零节点没有 TUN，不需要也不应打开。
- **DNS 必须导出（真机实测覆盖了初版的「不导出 DNS」）**：
  - 手机的 DNS 通常指向所在 LAN 的路由器（`192.168.x.1` 之类）。没有 DNS 块时，`route.final = "proxy"` 会把这些 DNS 查询送进隧道，服务端再把它发往**自己的** LAN，自然解析失败——真机表现是「VPN 已连接、网页打不开」。
  - `dns.servers` 用 **DoH（`type: "https"`）+ `detour: "proxy"`**：解析请求经代理从服务端出网，不再依赖手机所在 LAN 的 DNS 服务器；也不依赖 UDP 53，减少部分网络对 UDP / 非标端口的拦截与劫持影响。
  - `route.rules` 的 **`hijack-dns`** 用于把客户端发出的 DNS 查询交给这份 `dns` 配置处理；没有它，查询可能仍按手机原设置走 LAN。
  - **`hijack-dns` 之前必须有 `sniff`（sniffer 含 `dns`），顺序不可颠倒**：`protocol: "dns"` 靠嗅探结果匹配，没有 `sniff` 时这条规则永不命中，`hijack-dns` 成为死代码，DNS 又被 `final = proxy` 送进隧道。**这种失效不报错、`sing-box check` 也通过**，只能靠真机发现（2026-11-20 真机根因）。
  - `dns.final = "dns"` 让未命中其它服务器的查询统一走 DoH；本配置不声明分流规则集，也没有其它 DNS 服务器。
  - `1.1.1.1` 是 IP，不需要 bootstrap；它的可达性由**服务端出口**决定，与手机所在网络无关（服务端侧已验证 DoH 可用，§3.6）。
- **只有 selector，不加 urltest**：urltest 需要一个探测 URL。sing-box 默认用 `https://www.gstatic.com/generate_204`，这个地址在大陆的可达性**未核实**（待验证，不凭印象断言）；一旦不可达，urltest 会把所有节点误判为不可用，反而制造「全部失效」。M1 用 selector 把选择权交给用户，等有了自己可验证的健康端点再评估自动切换，属 v2。
- **不导出**：

| 不导出 | 原因 |
|---|---|
| 桌面 TUN 参数（`route_exclude_address` / `interface_name` / 平台专属字段） | 手机客户端自己创建并命名接口；桌面的排除表是本机 LAN 的，带过去会漏掉手机所在网络。`stack` 例外：它以 `gvisor` 显式导出，理由见 §3.2 |
| `mixed` 入站 / `listen` / 本地端口 | 手机没有「本机代理端口」这个概念；只保留 TUN 入站 |
| Clash API / `experimental` | 客户端内部使用；导出会把桌面端的控制面暴露出去，且没有消费方 |
| 系统代理设置 | 那是桌面模式，不是配置内容 |
| 分流规则集 / 自定义 DNS 候选 | 只导出**最小 DNS**（DoH 经代理 + `final`）与 `hijack-dns`；不导出域名分流规则集，也不让用户配置 DNS 候选。M1 只保证「能解析、有代理可用」，不替客户端决定分流 |
| `route.default_domain_resolver` | 已声明 `dns.final`，且节点地址是 IP；不需要再单独指定域名解析器 |

### 3.3 节点命名

- `tag` 取 `servers.name`（trim 后）。重名允许（`rename` 不禁止重名），出现重名时按 `created_at` 顺序追加 ` (2)`、` (3)`，保证 JSON 里唯一。
- 名称原样保留中文、空格、emoji；`sing-box check` 对这类 tag 已实测通过（§3.6）。
- 不把 `server_id`、IP、端口拼进名称：手机端看到的就是用户在桌面端起的名字。

### 3.4 零节点配置

```json
{
  "log": { "level": "warn" },
  "outbounds": [{ "type": "direct", "tag": "direct" }],
  "route": { "final": "direct" }
}
```

不是空对象、不是 `null`、不是 204。空对象或空 outbounds 可能让客户端拒绝整份 profile；`direct` 是一个完整可解析的配置，至少能完成一次成功更新。客户端如何呈现「零节点」由 V9 定，不由我们猜。

**零节点分支不包含 `inbounds`，也不包含 `dns`**：

- **不建 TUN**：客户端只在配置里有 TUN 入站时才创建系统隧道。零节点如果也声明 TUN，手机会显示「VPN 已连接」并把全部流量按 `final = "direct"` 直连——这是一个假 VPN，比「没有节点」更容易误导用户（以为在用节点，实际没有）。
- **不带 DNS**：非零模板的 DoH 服务器带 `detour: "proxy"`，而零节点没有 `proxy` 这个 outbound；把 DNS 一起带过去就是一条指向不存在 outbound 的悬空引用。
- 规则：
  - 零节点：只有 `direct`，`route.final = "direct"`，**无 `inbounds`、无 `dns`、无 `route.rules`，也不设 `auto_detect_interface`**；
  - 非零节点：**TUN 入站（含 `stack: "gvisor"`）+ `auto_detect_interface: true` + `dns` + `sniff` 规则 + `hijack-dns` 必须同时出现**，`detour` 只能指向实际存在的 `proxy`，且 `sniff` 必须排在 `hijack-dns` 之前。

> 本地实测：`sing-box check` **不会**因为 `detour` 指向不存在的 tag 而失败（零节点 + DNS 样张退出码仍为 0），也不会因为缺少 TUN 入站而失败（非零但无 `inbounds` 的样张同样为 0）。所以这两条都不能靠 `check` 兜底，必须由控制面单测锁定：「零节点无 `inbounds` / 无 `dns`」「非零节点有且只有一个 TUN 入站」。

### 3.5 为什么在控制面生成，而不是桌面

| 方案 | 问题 |
|---|---|
| 桌面生成一份 JSON，上传到控制面托管 | 需要新的「上传配置」端点与存储；节点重建后桌面若没打开，手机拿到旧配置 |
| 桌面把 URL 指向本地 | 手机不可能访问用户的桌面 |
| **控制面按请求生成** | 节点变化在下一个周期自然生效；不需要额外存储；与凭据端点同源 |

**客户端源码依据（2026-11-19）**：`sing-box-for-apple` 的 `ExtensionPlatformInterface.openTun` 与 `SFA` 的 `VPNService.openTun` 都只在配置里存在 TUN 入站时才创建系统隧道。也就是说，配置内容必须包含 TUN 入站——这是**客户端行为**，与「配置在哪一侧生成」无关；它决定了 §3.2 必须导出最小 TUN，而不是沿用初版「客户端自己注入」的假设。

- 所审版本：`sing-box-for-apple` main、`SFA` main（2026-11-19 取源）。
- 源码确认的是「有 TUN 入站才建隧道」这一条件；字段的具体行为（`auto_route` / `stack` / `dns_mode` / `auto_detect_interface`）在客户端版本间的差异由 V8 真机覆盖。
- **第三轮真机（2026-11-19 夜 → 20 日晨）**：补上 TUN 入站后 VPN 标志出现，但 `1.1.1.1` 仍打不开；据此在非零模板补 `route.auto_detect_interface: true`。依据：该字段默认 `false`，libbox 不会替配置打开；TUN 客户端的出站 socket 不绑定物理网卡就会回环进隧道。
- **第四轮真机（2026-11-20）**：补 `auto_detect_interface` 后仍是「有入/出站计数、能测速、网页打不开」。与桌面端**正常工作的** TUN 配置逐项对比，发现手机模板缺两项桌面端明确要求的字段，并多一项 Apple 上不该带的字段（详见 §3.6 现象 D）。补齐后真机可正常打开网页。

### 3.6 实测记录（2026-11-19 至 11-20）

**配置形状（本地，随包 `sing-box 1.14.4`，darwin/arm64，`sing-box check -c`）**：

| # | 样张 | 退出码 | 说明 |
|---|---|---|---|
| 1 | 非零生产形状：最小 TUN 入站 + 最小 DNS（DoH `1.1.1.1`、`detour: "proxy"`、`dns.final = "dns"`）+ `route.final = "proxy"` + `auto_detect_interface: true` + `hijack-dns` | 0 | 进生产的非零形状 |
| 2 | 同上但**去掉 `auto_detect_interface`** | **0** | 反例：`check` **不校验出站回环**，只有真机 V8 才能发现 |
| 3 | 零节点（只有 `direct`，`final = "direct"`，无 `inbounds` / `dns`） | 0 | 进生产的零节点形状 |
| 4 | 零节点 + 指向 `proxy` 的 `dns` | **0** | 反例：`check` **不校验 `detour` 悬空**，必须由控制面单测锁定「零节点无 dns」 |
| 5 | 非零节点 + DNS，但**无 `inbounds`**（初版形状） | **0** | 反例：`check` **不校验「必须有 TUN 入站」**，旧形状也能通过；只有真机 V8 才能发现 |
| 6 | 含中文 tag 与 `urltest` 的变体 | 0 | 只证明 tag 合法；本设计不采用 urltest |

**真机（iPhone / SFI，2026-11-19 至 11-20）**：

- 现象 A：初版 profile（无 DNS）导入后 **「VPN 已连接、无法上网」**。定位：手机 DNS 通常指向所在 LAN 的路由器；`route.final = "proxy"` 把这些 DNS 查询送进隧道，服务端再发往自己的 LAN，解析失败。
- 现象 B：补上 DNS 后仍 **「已连接、流量计数 0、1.1.1.1 打不开」**。定位：profile 没有 `inbounds`，官方客户端不创建系统隧道——源码依据见 §3.5。
- 现象 C：补上 TUN 入站后 **VPN 标志出现，但 `1.1.1.1` 仍打不开**。定位：`route.auto_detect_interface` 默认 `false`，libbox 不替配置打开；出站 socket 不绑定物理网卡会回环进隧道。
- 现象 D（2026-11-20）：`auto_detect_interface` 之后仍是 **「入站/出站都有计数、节点测速 OK、网页打不开」**。三项对照后确认：
  - 缺 `stack: "gvisor"`：不写时 Apple 平台 TCP 走内核 NAT、握手不完成（桌面端 2026-11-09 同源实测）。
  - 缺 `sniff` 规则：`protocol: "dns"` 靠嗅探匹配，没有它 `hijack-dns` 永不命中，DNS 查询被 `final = proxy` 送进隧道——**静默失效，`check` 通过**。
  - 多带 `strict_route`：Apple 上可能把代理自身的出站连接也纳入隧道。
  - 三项一次性修掉后真机可正常打开网页。**三项各自的单独贡献未做拆测**：合并修复优先让用户能用，后续如要精简（例如确认 `strict_route` 无害而保留）需再做单变量真机对照。
- 旁证（排除节点与凭据）：对节点本身单独验证，**出口 IP 探测、访问 Google、DoH 应答均通过**；同一份凭据另用随包 sing-box 起本地代理复测，`api.ipify.org` 返回节点 IP、`1.1.1.1` 301、`www.google.com` 200、DoH 经代理解析 `api.ipify.org` / `www.youtube.com` 均 200。
- 具体节点地址、出口 IP 与 DoH 应答原文未随本组交接留存（交接只保留了「三项均通过」的结论）；本文不复述数字，避免凭记忆写错。原始记录在发起会话 `IOS_Android` 的真机记录里。
- 修复：非零模板加入 §3.2 的最小 TUN 入站（含 `stack: "gvisor"`）、`route.auto_detect_interface: true`、DNS 块、`sniff` → `hijack-dns` 规则组；去掉 `strict_route`；零节点保持无 TUN、无 DNS。
- 验证状态：控制面 `npm run typecheck` 通过、`npm test` **212/212 通过**（2026-11-20，含 sniff 顺序与 `stack` 断言）；真机（iPhone / MT）在补齐三项后确认可打开网页。**蜂窝网络下的复验仍未执行**（V12）。

**所审版本**：代码基线 `c1de5b3`（TUN + DNS + `auto_detect_interface` 已提交）；`stack: "gvisor"`、`sniff` 规则组与去掉 `strict_route` 的改动为工作区未提交（`cloudflare/control-plane/src/mobile.ts:444–476`、`test/mobile.test.ts`）。客户端源码依据：`sing-box-for-apple` main、`SFA` main（2026-11-19 取源）。

**以上证明「配置能被 1.14.x 解析」「节点侧可达」「iPhone 上补齐三项后可打开网页」。蜂窝网络下的复验由 V12 判定，尚未执行。**

---

### 3.7 多格式导出（2026-11-20 增补：sing-box JSON / Clash YAML / ss://）

> 产品负责人 2026-11-20 拍板：同一账户级令牌下提供三种格式。服务器侧不变——每台机器跑的是标准 Shadowsocks 入站（`aes-256-gcm`），协议层所有 SS 客户端都能连；新增工作量全部在**导出格式、认证方式与验收**。本节只增补，不推翻 §3.1–§3.6 的真机结论；sing-box JSON 仍以 §3.2 为准。

#### 3.7.1 三个路径

| 格式 | 路径 | `Content-Type` | 主要消费者 |
|---|---|---|---|
| sing-box JSON | **`GET /v1/mobile/profile`**（保持不变） | `application/json; charset=utf-8` | SFI / SFA |
| Clash / Mihomo YAML | **`GET /v1/mobile/profile/clash`** | `text/yaml; charset=utf-8` | CMFA（M1）、Hiddify（M1 备选）；Clash Verge 仅桌面验证 |
| ss:// 链接列表 | **`GET /v1/mobile/profile/ss`** | `text/plain; charset=utf-8` | Shadowrocket（M1，Basic 与 body 编码待真机）；v2rayNG（下期，已核实） |

- **三个路径共用同一枚导出令牌**。`POST /v1/mobile/token/rotate` 覆盖唯一一行，旧令牌在三个路径上**同时**失效；不存在「按格式分别轮换」。这里的「失效」指三个端点对旧令牌返回 401；**已经复制 / 保存在外部的 ss 文本不在此列**——它携带节点密码，不受令牌轮换影响。
- `/v1/mobile/profile` **不改名、不加 `/singbox` 后缀**：已经导入到手机上的旧 profile 永远指向这个路径，改名会让所有已部署的链接在下一次更新时 404。新格式只做**追加路径**。
- 认证仍以 **HTTP Basic** 为主（§3.7.5）；路径里不出现令牌。

#### 3.7.2 为什么用路径后缀，而不是 query 或 `Accept`

| 方案 | 问题 |
|---|---|
| `?format=clash` | 部分客户端/中间层会规范化、剥离或重写 query；缓存键也会把可选参数混在一起。路径是客户端唯一会原样保留的部分 |
| `Accept: application/yaml` | 客户端不保证发这个头，也不保证按它切换格式；无法作为主契约 |
| 请求体 / POST | Remote Profile 是 GET 更新源，客户端不支持 POST 取配置 |
| **路径后缀** | 客户端把 URL 当不透明字符串；三种格式各自独立缓存；令牌仍在 userinfo，不进路径 |

#### 3.7.3 Clash / Mihomo YAML

最小形状（节点数与名字随账户变化）：

```yaml
proxies:
  - name: "东京 1 号"
    type: ss
    server: "203.0.113.10"
    port: 20343
    cipher: aes-256-gcm
    password: "s3cret-password"
    udp: true
proxy-groups:
  - name: "Veyl"
    type: select
    proxies:
      - "东京 1 号"
rules:
  - "MATCH,Veyl"
```

规则：

| 项 | 规则 |
|---|---|
| 节点来源与筛选 | 与 §3.1 **完全同一查询**：账户名下 `state ∈ {active, healthy}`、`node_id` 非空、凭据未销毁；免费 / 试用永不出现 |
| 命名 | 与 §3.3 同一套名字与去重（` (2)` / ` (3)`） |
| `type` / `cipher` | 固定 `ss` / 服务端实际的 `aes-256-gcm`；`password` 原样 |
| `udp: true` | 服务端 SS 入站默认同时监听 TCP+UDP（`sing-box` 的 `NetworkList.Build()` 在空值时返回 `tcp`+`udp`，见 `option/types.go`）；DO 防火墙同时放行 tcp/udp（`providers/digitalocean.ts:168`）。M1 只承诺 TCP 可用，UDP 由客户端实际路径决定 |
| **不导出** | `mixed-port` / `port` / `socks-port` / `allow-lan` / `mode` / `dns` / `tun` / `sniffer` / 规则集：Clash 客户端的接管方式、端口、DNS、TUN 都由**客户端自己**管理。把桌面的模板塞进去会覆盖用户设置，且各家字段并不完全一致 |
| `proxy-groups` | 一个 `select` 组，名字固定 `Veyl`，列出全部节点；不引入 url-test / fallback（与 §3.2 不用 urltest 的理由相同） |
| `rules` | 只有一条 `MATCH,Veyl`。不做分流——分流规则是客户端的事 |
| YAML 生成 | 不引入 YAML 依赖：所有字符串用 `JSON.stringify` 产出双引号标量（JSON 字符串是合法的 YAML 双引号标量），数字与布尔原样；`JSON.stringify` 不转义 U+2028 / U+2029，需再手工把这两个字符替换成 `\u2028` / `\u2029`。必须用带 `:`、`#`、引号、前导 `-`、换行、emoji 的节点名做单测 |
| 空态 | `proxies: []`、`proxy-groups: []`、`rules: ["MATCH,DIRECT"]`；200，不是 4xx |
| 全部凭据不可用 | **503** `INTERNAL / mobile_profile_unavailable`，与 sing-box 一致：不能把「凭据坏了」伪装成「没有节点」 |
| 缓存 | `Cache-Control: no-store` + `X-Content-Type-Options: nosniff` |

> **与 sing-box JSON 的关键差异**：Clash YAML 里**没有**我们那份 TUN / DNS / `auto_detect_interface` 模板。Clash 类客户端的系统接管、DNS 与 TUN 由客户端自己决定；我们只提供节点、一个选择组和一条兜底规则。

> 这份最小 YAML 是否被各客户端直接接受（尤其 Stash 的 `#SUBSCRIBED`、CMFA 的远程 profile 导入）由 V13 验证；除 `proxies` / `proxy-groups` / `rules` 外不写任何字段。文件必须是 UTF-8。

> **不在 YAML body 里写 `#SUBSCRIBED <url>`**：那行会把含令牌的 URL 复制进配置文件（可能被 iCloud / 备份同步），违反 §7.1。URL 由客户端自己保存；Stash 若不写这行就不自动更新，记录在 V13，必要时改用「客户端里手动点更新」而非把令牌写进文件。

#### 3.7.4 ss:// 链接列表（SIP002）

每个节点一行，严格按 SIP002：

```
ss://<base64url-no-pad(UTF-8("method:password"))>@<host>:<port>#<percent-encoded name>
```

示例（假数据）：

```
ss://YWVzLTI1Ni1nY206czNjcmV0LXBhc3N3b3Jk@203.0.113.10:20343#%E4%B8%9C%E4%BA%AC%201%20%E5%8F%B7
```

| 项 | 规则 |
|---|---|
| Base64 | **URL-safe 字母表、无 `=` 填充**；编码的是 `method:password` 的 UTF-8 字节 |
| Host | 原样；IPv6 必须写成 `[addr]` 再拼 `:port`（当前 DO 节点是 IPv4，仍按规则处理） |
| Port | 十进制 |
| 名称 | `#` 后的 fragment，按 RFC 3986 percent-encode（空格 `%20`，不是 `+`）；名字与 §3.3 一致 |
| Plugin | **不输出** `/?plugin=`；当前没有插件 |
| 行分隔 | `\n`，末尾建议带一个换行 |
| 旧格式 | **不输出** `ss://base64(method:password@host:port)` 旧式整体编码；只发 SIP002。只认旧式、不认 SIP002 的客户端不在 M1 支持范围 |
| 空态 | **200 + 空 body（0 字节）**；不是 4xx。客户端是否把空列表当成「更新成功」由 V16 验证 |
| 全部凭据不可用 | **503**，与另两种格式一致 |
| 缓存 | `Cache-Control: no-store` + `X-Content-Type-Options: nosniff` |

> `ss://` 是**内容**，不是订阅协议。它作为 `/profile/ss` 的响应提供给能带 Basic 拉取的客户端；M1 只有 Shadowrocket 一个例外（Basic 未核实，待 V14，见 §3.7.8），桌面**不提供**「复制 ss 文本再粘贴」的特例。

> **端点返回的 ss 文本可被外部工具保存，轮换不影响它**：它携带的是节点密码，不是导出令牌。`rotate` 只让三个 URL 失效；要让已保存的 ss 链接失效，必须重建服务器（换密码）。M1 不提供桌面粘贴入口，但这是端点固有的残余风险，与「链接可被转发」同级。

#### 3.7.5 认证：Basic 是主路径，路径令牌不进 M1

**结论：三种格式全部使用 HTTP Basic，共用同一枚令牌；不新增路径令牌。M1 的四个 App 里，sing-box 官方 / CMFA / Hiddify 的 Basic 已核实；Shadowrocket 是唯一例外——Basic 与返回体编码均未核实，先上界面由产品负责人朋友真机验，失败按 §3.7.8 撤行。Karing / Stash 不列入。**

已核实：

| 客户端 | 依据 | 状态 |
|---|---|---|
| sing-box 官方（SFI / SFA） | 官方客户端要求「必须支持 HTTP Basic」（`mobile-export.md` §2.3） | **已核实** |
| Hiddify | `lib/core/http_client/dio_http_client.dart`：`uri.userInfo` → `Authorization: Basic …`（main 分支，约 165–184 行）；`profile_parser.dart` 在核心下载失败时回退到这条 Dart 下载路径。**核心下载路径是否透传 userinfo 未核实** | **已核实（回退路径）** |
| Clash Verge Rev | `src-tauri/src/utils/network.rs`：解析 URL 的 username/password → `Authorization: Basic …`，随后从 URL 去掉 userinfo（默认 `dev` 分支约 192–204 行；`main` 同实现约 168–183 行） | **已核实（源码）** |
| Clash Meta for Android | 其内核 mihomo `component/http/http.go`：URL 带 userinfo 时 `req.SetBasicAuth`（`Alpha` 分支，约 58–61 行）；CMFA 的 `native/config/fetch.go` 走这条 `clashHttp.HttpRequest` | **已核实（源码）** |
| Karing | 公开仓库树里没有 `lib/app/utils/http_utils.dart`，无法读下载实现；README 只列格式 | **未核实** |
| Shadowrocket | 闭源；App Store 页面是唯一官方说明，未提 Basic | **未核实** |
| Stash | 闭源；官方 wiki 的订阅页只写 `#SUBSCRIBED <url>` 与 `Subscription-Userinfo` 头，未提 Basic | **未核实** |

路径令牌（`/v1/mobile/profile/<token>/clash`）的代价，写清楚以便将来决策：

- 令牌进入**请求行与路径**，会进 Cloudflare 访问日志、客户端日志、截图、代理日志；与 §7.1「令牌不进日志」直接冲突。
- 需要**单独一套令牌**（路径令牌）或接受「同一枚令牌同时以 userinfo 和路径出现」，两种都比现在多一份状态与轮换语义。
- rotate 仍可一次让三种格式失效，但路径令牌的存在会让「令牌只进二维码」这条口径失效。
- **M1 不实现**。除 Shadowrocket（Basic 未核实，先上界面待 V14，§3.7.8）外，不支持 Basic 的客户端不进列表；也不做「仅 ss 文本粘贴」的特例（产品 2026-11-20 决定：粘贴整段链接对用户是断崖式体验，且不会自动更新）。若 Shadowrocket 验不过且它只给路径令牌，再单独设计，并在 §7.1 明确「路径令牌是另一种凭据，日志与审计规则不同」。

#### 3.7.6 限流、缓存、401 / 429

| 项 | 规则 |
|---|---|
| 限流 | 三种格式**共享** `mobile-profile:<account_id>` 的 30 次/小时预算；无效令牌仍按 `mobile-profile-bad:<ip>` 60 次/小时 |
| 缓存 | 三种格式全部 `Cache-Control: no-store`；`X-Content-Type-Options: nosniff` |
| 401 | 错误信封 `UNAUTHENTICATED` + `WWW-Authenticate: Basic realm="veyl", charset="UTF-8"`，三种格式一致 |
| 429 | `RATE_LIMITED`，`Retry-After: 3600`，三种格式一致 |
| 403 | 账户停用 / 合并，三种格式一致 |
| `last_used_at` | 三种格式共用同一节流写入（5 分钟） |
| 审计 | 不新增；令牌 create / rotate 已有审计 |

#### 3.7.7 桌面命令契约增量

`mobile_export_get` / `mobile_export_rotate` 的返回从「一条 URL」扩为「三种格式」，其余状态与错误码不变：

```ts
type MobileExportFormat =
  | {
      format: "singbox";
      url: string;                 // https://veyl:<token>@<origin>/v1/mobile/profile
      qr_data_url: string;         // sing-box://import-remote-profile?url=…#Veyl 的二维码
    }
  | {
      format: "clash";
      url: string;                 // …/v1/mobile/profile/clash
      qr_data_url: string;         // 二维码内容 = 上面的 URL；保留，V13 判定去留
    }
  | {
      format: "ss";
      url: string;                 // …/v1/mobile/profile/ss
      qr_data_url: string;         // 二维码内容 = 上面的 URL（Shadowrocket 扫码 / 粘贴一条订阅 URL）
    };

type MobileExportData =
  | {
      state: "ok";
      node_count: number;
      created_at: number;
      formats: MobileExportFormat[];
    }
  | { state: "login_required" }
  | { state: "no_ready_server" };
```

- **URL 仍由 Host 用 `env.rs` 的 origin 拼**（§4.1）；控制面只回令牌。
- 桌面**不取 ss 文本**：Shadowrocket 用「扫码 / 粘贴一条订阅 URL」导入，由它自己拉取；粘贴多行文本的特例不做（§3.7.5）。`ss` 返回 URL 与 URL 二维码。
- 二维码：sing-box 沿用 §4.2 的 scheme；Clash 与 ss 都用 URL 本身的二维码（Clash 的去留由 V13 判；ss 的可用性由 V14 判，扫不通则退回只给复制链接）。
- 敏感字段：三个 `url` 都含令牌；按 §7.1 处理，不得进日志、事件、AI 上下文或界面文本。
- **版本**：`commands.md` 2.46.1 已随 prod 上线；`mobile_export_get` 的返回从单值改为 `formats[]` 是线上可见变更，**必须升 `2.47.0`**（产品 2026-11-20 拍板，不并入 2.46.0）。

#### 3.7.8 客户端矩阵（M1 四个 App，2026-11-20 定稿）

> **证据等级**：真机 > 源码 > 官方文档 > 商店页。商店页只证明「在架 / 价格 / 协议列表」，**不能证明订阅格式或 Basic**；闭源客户端查不到就写「未核实」，不按「它应该支持」推断。
> 数字是 2026-11-20 的快照（`api.github.com` 与 `itunes.apple.com` 美国区），会变。

| App | 平台 | M1 格式 | 订阅 Basic | 状态 | 官方下载 | 依据 |
|---|---|---|---|---|---|---|
| **sing-box 官方**（iOS 商店名 `sing-box MT`，TestFlight 版即 SFI） | iOS / Android | sing-box JSON | **已核实** | **真机已验证**（iPhone，§3.6） | iOS <https://apps.apple.com/us/app/sing-box-mt/id6785326793>；Android <https://github.com/SagerNet/sing-box-for-android/releases> | 官方 `clients/apple/`、`clients/android/` 页；Remote Profile body 是 sing-box 配置（§3.7.5） |
| **Shadowrocket** | iOS | ss 列表 | **未核实** | **M1 列入，待真机**（产品负责人朋友） | <https://apps.apple.com/us/app/shadowrocket/id932747118>（美区） | 闭源；商店页与发行方 <https://shadowlaunch.com/> 都没有订阅格式 / Basic 说明；$2.99，4.48 / 12,402，v2.2.93（2026-10-29） |
| **Clash Meta for Android** | Android | Clash YAML | **已核实**（mihomo `SetBasicAuth`） | 源码核实，缺真机 | <https://github.com/MetaCubeX/ClashMetaForAndroid/releases> | `ProfileProcessor.kt:146` → `Clash.fetchAndValid`；`fetch.go` 的 `openUrl` → mihomo `component/http/http.go:58–60`；49,842 star，2026-11-20 推送 |
| **Hiddify** | iOS / Android | sing-box JSON（备选 Clash YAML） | **已核实（Dart 回退路径）** | 源码核实，缺真机 | <https://github.com/hiddify/hiddify-app/releases>、App Store `id6596777532` | `dio_http_client.dart:168–184` 显式拼 Basic；README + `link_parsers.dart`；**核心下载路径是否透传 userinfo 未核实**（§3.7.5）；34,196 star |

> **Hiddify 的 ss 仍然未核实**：`link_parsers.dart` 只认 `hiddify/v2ray/clash/clashmeta/sing-box`。它是列表里唯一两种格式都能吃的 App；Shadowrocket 若验不过，Hiddify 可以接 sing-box / Clash，但**接不了 ss**。

##### 为什么是这四个

- 不是「最流行的四个」，是「三种格式各至少一个 App，并且每条都有可执行的验证路径」：sing-box 已真机；CMFA 源码已核实、可补真机；Shadowrocket 由产品负责人的朋友真机测；Hiddify 双格式兜底。
- 四个 App 覆盖三种格式：sing-box JSON（sing-box 官方、Hiddify）、Clash YAML（CMFA、Hiddify）、ss（Shadowrocket 唯一）。
- Shadowrocket 是当前唯一能让 ss 行上界面的客户端，所以即使 Basic 未核实也先列入；这是 M1 唯一一个「未验证先上」的例外，风险与撤下条件见下。
- 其余 App 一律走界面兜底行；M1 只对这四个负责。

##### Shadowrocket：风险、撤下条件与返回体格式

**风险**

1. **Basic 未核实**：订阅 URL 把令牌放在 userinfo（`https://veyl:<token>@…`）。若 Shadowrocket 不把 userinfo 转成 `Authorization: Basic`，拉取会 401，表现为「订阅已添加、列表永远为空」。
2. **返回体格式未核实**：订阅内容是 `/profile/ss` 返回的纯文本 `ss://` 逐行列表；Shadowrocket 是否接受纯文本、还是必须 base64 包装，**没有官方依据**。

**返回体格式（重点）**

- 已知：Shadowrocket 的导入方式是「扫码 / 粘贴一条订阅 URL」（产品负责人提供），所以二维码内容 = 这条 URL，不是多行节点文本。
- 未知：URL 返回**纯文本 `ss://` 行**是否被接受，还是必须 **base64**。
- 查证范围：App Store 描述与版本说明、发行方站点 <https://shadowlaunch.com/> 均无订阅格式说明，也无官方 wiki。结论：**未核实**。
- **决策门（V14）**：先用现有 `/profile/ss`（`text/plain; charset=utf-8`，纯文本逐行）测。
  - 导入成功 → 不加变体，保持单一响应形状。
  - 报「格式错误 / 无法解析」→ 增加 base64 变体：**路径后缀** `/v1/mobile/profile/ss/base64`（沿用 §3.7.2 的路径后缀，不用 query），body = base64(纯文本)，同一枚令牌、同一限流、同一 `no-store`。不默认实现，避免多一条没有客户端消费的路径。
- **真机报格式错误时，先看这里**：不是令牌问题（那会是 401），是 body 编码问题。

**撤下条件**

- 真机确认**不支持 Basic**：若它提供自定义请求头入口，改实现（令牌改走头）；没有就撤掉这一行，ss 行同时退回「不展示」。ss 的下一步只有 Android 的 v2rayNG（下期，已核实 ss + Basic），**iOS 侧没有同格式替代**。
- 真机确认**订阅 URL 可用但两种 body 都不吃**：同样撤行。
- 撤行只改客户端列表与 `mobile_clients_qr` 枚举，不动 `/profile/ss` 端点与令牌。
- 界面文案：这一行必须带「待验证」；不得把「待验证」写成「可用」。

##### 下期（已核实可用，只差上界面）

- **v2rayNG**（Android）：ss 列表 + Basic 双核实（`AngConfigManager.kt` 解析表含 Shadowsocks；`HttpUtil.kt:214–224`），66,201 star。**Shadowrocket 验不过时，ss 格式的 Android 替代就是它**；iOS 侧没有同格式替代。
- **FlClash**（Android / 桌面）：Clash YAML + Basic 双核实（`core/config.go:83`；`request.dart:210`），64,260 star。CMFA 的备选。
- **Karing**：Clash / sing-box / ss 都能吃，但 Basic 未核实（仓库快照缺 `lib/app/utils/http_utils.dart`），16,255 star。
- **Stash / Loon / Quantumult X**：只有商店页，格式与 Basic 全未核实；均付费。
- 扩展流程：按本表同一口径补行（平台、格式、Basic 源码依据、官方下载、star / 评分 / 维护、证据等级）；未核实不进界面。

##### sing-box MT 的更正（保留被推翻的旧结论）

- **旧结论（已推翻）**：把 `sing-box MT` 当作第三方客户端，未列入 M1，理由是「sagernet 官方页不收录第三方」。
- **新证据**：官方 `clients/apple/` 页把 App Store `id6785326793` 直接列为 Apple 平台官方客户端；发行主体 Metamerism LLC 是官方 seller，商店记录的 `sellerUrl` 指向 `sing-box.sagernet.org`。
- **更正**：它是官方发行，M1 里的「sing-box 官方」在 iOS 上就是它（TestFlight 版是同一客户端的测试轨道）。官方页仍然不收录其他第三方；这条更正不能外推到别的 App。
- 影响范围：只改 iOS 行的归属，不改配置、令牌或二维码。

##### 界面兜底

M1 只对 **sing-box 官方 / Shadowrocket / CMFA / Hiddify** 四个 App 负责。用户用别的 App 时走界面兜底行（引导到官方客户端页）；正文不承诺「以后可能支持」，扩展名单统一放在上面的「下期」。

> **引用 mihomo 源码时的注意**：`https://github.com/MetaCubeX/mihomo` 的**默认分支 `main` 是一个无关的 Python 仓库**；代理核心在 **`Alpha` 分支**。看源码必须加 `?ref=Alpha` 或 `/tree/Alpha`。ClashMetaForAndroid 的 `.gitmodules` 也指向该仓库的 `Alpha` 分支。

**仓库 / 官方文档链接（矩阵依据）**：

- sing-box 官方客户端页：<https://sing-box.sagernet.org/clients/>、Apple 页 <https://sing-box.sagernet.org/clients/apple/>、Android 页 <https://sing-box.sagernet.org/clients/android/>
- sing-box MT（App Store）：<https://apps.apple.com/us/app/sing-box-mt/id6785326793>
- SFA：<https://github.com/SagerNet/sing-box-for-android>
- Hiddify：<https://github.com/hiddify/hiddify-app>
- Clash Meta for Android：<https://github.com/MetaCubeX/ClashMetaForAndroid>
- Shadowrocket：<https://apps.apple.com/us/app/shadowrocket/id932747118>、发行方 <https://shadowlaunch.com/>
- 下期：FlClash <https://github.com/chen08209/FlClash>、v2rayNG <https://github.com/2dust/v2rayNG>、Karing <https://github.com/KaringX/karing>、Stash <https://apps.apple.com/us/app/stash-rule-based-proxy/id1596063349>、Loon <https://apps.apple.com/us/app/loon/id1373567447>、Quantumult X <https://apps.apple.com/us/app/quantumult-x/id1443988620>


#### 3.7.9 三种格式的零节点 / 故障对照

| 情况 | sing-box JSON | Clash YAML | ss:// |
|---|---|---|---|
| 账户没有可用付费节点 | 200 + 只含 `direct` | 200 + `proxies: []`、`proxy-groups: []`、`rules: ["MATCH,DIRECT"]` | 200 + 空 body |
| 查到了服务器但全部凭据坏 / 解不开 | **503** | **503** | **503** |
| 令牌无效 / 已轮换 | 401 | 401 | 401 |
| 超限 | 429 | 429 | 429 |

#### 3.7.10 验证增补

多格式新增的 **V13–V17** 统一列在 §8 的检查单里（不在本节重复一张表）。

#### 3.7.11 实现边界（只列新增）

| 组 | 文件 | 改动 |
|---|---|---|
| be-cp | `cloudflare/control-plane/src/mobile.ts` | 路由增加 `/clash`、`/ss`；Clash YAML 生成器（手写标量引用）；SIP002 生成器；共用查询、限流、401/429；单测覆盖空态、坏凭据、特殊字符、IPv6、轮换 |
| be-desktop | `src-tauri/src/control_plane/mobile.rs` | 构建三个 URL；Clash URL 的二维码；命令返回 `formats[]`；单测（编码、origin、零门禁） |
| fe | 设计会话未定 | 弹层按 App 列表（sing-box / Shadowrocket / CMFA / Hiddify），每个 App 绑定一种格式，展示复制 + 二维码；无格式切换器；外加兜底行；本文件不规定版式 |

不新增事件、不新增 AI 工具、不动迁移；`mobile_tokens` 一行同时服务三种格式。

#### 3.7.12 界面按 App，格式内部映射（2026-11-20 定稿）

- **删掉格式切换器**：v4 设计里没有 `sing-box` / `Clash` 两段；用户只选 App，格式只存在于内部映射（§3.7.8）。`formats[]` 仍然三种都返回。
- 四个 App 的映射：
  - sing-box 官方 → `singbox`；二维码 = `sing-box://import-remote-profile?url=…#Veyl`（§4.2）；
  - Shadowrocket → `ss`；二维码 = `/profile/ss` 的 URL 本身（待真机，§3.7.8）；
  - CMFA → `clash`；二维码 = `/profile/clash` 的 URL 本身（V13 判去留）；
  - Hiddify → `singbox`（备选 `clash`；界面默认取 `singbox`）。
- 同一个弹层、同一枚令牌、同一个「重新生成」；切换 App 只换展示的 URL / 二维码，不重新请求。
- 每个 App 一个下载码：`mobile_clients_qr { client }`，四个枚举 `singbox` / `hiddify` / `cmfa` / `shadowrocket`，URL 固定映射、不接受任意 URL（§5.1 / `commands.md` §7.23）。`hiddify` 以不带尾斜杠的 `https://hiddify.com` 为准。
- `mobile_export_get` 的 `formats[]` 仍包含 `ss`；界面只取当前 App 对应的那一条，其余不渲染。
- **安全文案边界**：不得写「重新生成后旧配置全部失效」这类绝对表述。准确说法是「旧链接失效，手机上的配置下次更新时不再可用」；`/profile/ss` 返回的节点链接一旦被复制/保存，**收不回**，只有重建服务器（换密码）才能让它失效。技术依据见 §3.7.4 / §7.3。

---

## 4. 桌面 Host

### 4.1 URL 构造

```
https://veyl:<token>@<base_url 去掉末尾斜杠>/v1/mobile/profile        # sing-box JSON
https://veyl:<token>@<base_url 去掉末尾斜杠>/v1/mobile/profile/clash  # Clash YAML
https://veyl:<token>@<base_url 去掉末尾斜杠>/v1/mobile/profile/ss     # ss:// 列表
```

- `<base_url>` 只来自 `control_plane::env::current().base_url`（`env.rs` 的 `DEV_URL` / `PROD_URL`，或 debug 下的 `VEYL_CONTROL_PLANE_URL`）。**不在新模块里写任何域名常量**。
- 用 `reqwest::Url` 的 `set_username` / `set_password` 构造，转义交给库；令牌是 base64url，实际不会被转义。
- 语法检查：必须是 `https://`，host 不得以 `.workers.dev` 结尾。违反 → `PRECONDITION_FAILED`，`details.reason = "insecure_profile_origin"`，不生成二维码。这条兜住 debug 下把 `VEYL_CONTROL_PLANE_URL` 指向 `workers.dev` 的人为配置。
- 控制面**不返回 URL**：路径与 origin 由桌面决定，端点只回令牌。这样 origin 的唯一来源就是 `env.rs`，正好落实「不写第二处常量」。
- 唯一无法消除的重复是**路径字面量**（`/v1/mobile/profile`、`/clash`、`/ss`）：Rust 侧要拼 URL，Worker 侧要匹配路由，跨语言没有共享常量。它只影响可用性（写错就 404），不影响环境安全；用两侧各一条单测固定。

### 4.2 扫码内容

```
sing-box://import-remote-profile?url=<percent-encoded 上述 URL>#Veyl
```

- `url` 参数**整体** percent-encode（包括 `https://` 与 `@`）；不 encode 的 `&` / `#` 会把 query 截断。
- fragment（`#` 之后）是 profile 显示名，固定 `Veyl` 并做同样的 encode；界面不展示这个名字。
- 用 `url::form_urlencoded` 的序列化器生成 query 值，不手写 `encodeURIComponent` 的等价逻辑（Rust 侧没有现成函数，手写容易漏字符）。
- 这条字符串**只用于二维码**；复制按钮复制的是 §4.1 的 profile URL，不是 scheme URL（与 UI 稿「复制链接」的语义一致）。
- **只有 sing-box 用这个 scheme**：Clash 与 ss 的二维码内容都是各自订阅 URL 本身（不套 `clash://` / `ss://` 订阅 scheme，未核实）；见 §3.7.7。

### 4.3 二维码：Rust 出图

| 方案 | 取舍 |
|---|---|
| 前端库（如 `qrcode` npm） | 新依赖、多一套渲染路径；两处入口必须共用，否则会出现两份实现 |
| **Rust `qrcode` crate（采用）** | 与 URL 构造同一条命令返回，两个入口天然共用；矢量输出满足 UI「矢量或 2×」；不把二维码内容交给 DOM 文本 |
| Rust 生成图片文件 | **不做**：二维码不落盘（§7.2） |

实现约定：

- `Cargo.toml` 新增 `qrcode`（最新稳定版）与 `url = "2"`（`reqwest` 已在依赖树里，这里显式声明以便直接使用）。
- 输出 `data:image/svg+xml;base64,…`，`img` 直接引用；SVG 尺寸按 160 CSS px 的整数倍放大（例如 viewBox 640×640），保证高分屏清晰。
- 纠错级别 M；静区按 UI 稿的白边要求留足（静区是二维码规范的一部分，不能裁掉）。
- 生成失败 → `INTERNAL`，`details.reason = "qr_encode_failed"`；界面走「二维码暂时生成不了 / 重试」。
- QR 内容（含 URL 与令牌）**不写进** `alt`、`title`、`aria-label`、日志或事件。

### 4.4 两个入口共用同一状态

```
设置 › 账户  ── onOpenMobileExport ──┐
                                     ├─→ App: mobileExportOpen + 触发元素 ref
我的服务器左栏 ── onOpenMobileExport ─┘         │
                                               ▼
                                   <MobileExportDialog/>
                                   打开时调用 mobile_export_get
```

- 弹层组件只有一个（`src/components/MobileExport.tsx`），内部负责：五态渲染、复制、就地确认「重新生成」、焦点回触发元素。
- 两个入口只传 `onOpen` 与关闭后的焦点目标；不各写一套请求或状态。
- 左栏行的出现条件沿用界面稿：**已登录 && 至少一台服务器节点已就绪 && 列表非 loading/error**。判定用现有 `useMyServers` 的数据（`node_id` 非空且 `state ∈ active/healthy`），**不新增轮询**。
- 弹层打开时调用一次 `mobile_export_get`；关闭弹层即停止渲染，**不写任何本地存储**。默认每次打开重新取，拿到的是控制面回显的同一个令牌；同一会话内是否缓存最近一次结果见 §10 建议改 10（仍不落盘）。

### 4.5 Host 侧门禁

命令执行顺序：

1. `auth::account_state()` 不是邮箱登录 → `{ state: "login_required" }`；
2. 本地镜像没有任何「节点已就绪」的服务器 → `{ state: "no_ready_server" }`；
3. 调 `POST /v1/mobile/token` → 拿令牌；
4. 拼 URL、校验 origin、编码二维码；
5. 返回 `{ state: "ok", url, qr_data_url, node_count, created_at }`。

`node_count` 用本地就绪台数即可（只用于测试与日志，不显示）。

第 2 步是**本地乐观门禁**：控制面的节点集合可能因同步延迟与本地不同（例如刚销毁、列表还没刷新），此时仍可能生成一份零节点配置。这不是错误——下一次拉取与列表刷新会收敛；不为了消除这个窗口引入同步请求。

### 4.6 AI 边界

- 不注册任何 AI 工具；`OpenSettings` 只多了 `account.mobile` 这个可指路的行 id。
- 命令返回的 `url` 不进入 `ai_send_message.context`：界面上报只有 `id` / `label` / `kind`，复制与重新生成不登记为 AI 可点的 control。
- 聊天、工具调用、日志都不会看到令牌；如果将来有人要给 AI 加「帮我看看手机链接」，应拒绝——令牌不应进入模型上下文。

---

## 5. 命令与事件契约增量

> 只写增量；不直接改 `docs/contracts/commands.md`。由 PM 按批次合并。

### 5.1 新命令

`commands.md` 2.46.1 已随 prod 上线；**多格式修订**（§3.7）把返回从单 URL 改为 `formats[]`，并把 §7.23 下载码改为客户端枚举；两项都是线上可见变更，**统一按 `2.47.0` 合并**（产品 2026-11-20 拍板，不并入 2.46.x）。

- §7.21 `mobile_export_get {}` → `MobileExportData`（仅 UI）
- §7.22 `mobile_export_rotate { confirm: true }` → `MobileExportData`（仅 UI）
- §7.23 `mobile_clients_qr { client: "singbox" | "hiddify" | "cmfa" | "shadowrocket" }` → `{ url, qr_data_url }`（仅 UI）

```ts
type MobileExportFormat =
  | {
      format: "singbox";
      url: string;              // https://veyl:<token>@<origin>/v1/mobile/profile，敏感
      qr_data_url: string;      // sing-box://import-remote-profile?… 的二维码
    }
  | {
      format: "clash";
      url: string;              // …/v1/mobile/profile/clash，敏感
      qr_data_url: string;      // 二维码内容 = URL 本身；保留，V13 判定去留
    }
  | {
      format: "ss";
      url: string;              // …/v1/mobile/profile/ss，敏感
      qr_data_url: string;      // 二维码内容 = URL 本身（Shadowrocket 订阅入口；待 V14）
    };

type MobileExportData =
  | {
      state: "ok";
      node_count: number;       // 本地已就绪的付费节点数
      created_at: number;       // Unix 毫秒（控制面 mobile_tokens.created_at）
      formats: MobileExportFormat[];
    }
  | { state: "login_required" }
  | { state: "no_ready_server" };
```

规则：

| 项 | 规则 |
|---|---|
| 幂等 | `mobile_export_get` 幂等：没有令牌就建，有就回显同一个；重复调用不改任何 URL |
| `confirm` | `mobile_export_rotate` 必填且必须为 `true`；缺失 / `false` → `INVALID_ARGUMENT`，`details.reason = "confirmation_required"` |
| 返回的是状态而不是错误 | 「未登录」「没有就绪服务器」是**预期状态**，用 `state` 表达，UI 直接渲染三种态；真正的失败才走错误信封 |
| 无部分失败 | 三种格式的 URL 由同一枚令牌拼成；不需要再请求任何内容端点，因此没有「某一种取不到」的中间态 |
| 错误码 | `INVALID_ARGUMENT`（`confirmation_required`）、`PRECONDITION_FAILED`（`insecure_profile_origin`）、`RATE_LIMITED`（`retryable: true`）、`UPSTREAM_ERROR`（控制面 5xx / 网络）、`TIMEOUT`、`INTERNAL`（`qr_encode_failed` / `mobile_token_corrupt`） |
| 不落库 | 两个命令都不写本地 SQLite、不写 `secrets.enc` |
| 敏感返回 | 三个 `url` 都含令牌；UI 不得把它们渲染为文本、`alt`、`title`，不得放进事件或对话 |

`mobile_export_rotate` 的 `state` 也是三态：门禁在生成前会重新检查一次（期间账户可能登出、最后一台服务器可能销毁），三个状态都要可能返回。

三种格式的形状与零节点行为见 §3.7。

**`mobile_clients_qr`（2.47.0 改枚举）**：只接受 `client: "singbox" | "hiddify" | "cmfa" | "shadowrocket"`，Host 固定映射 URL 并出二维码：

| `client` | URL |
|---|---|
| `singbox` | `https://sing-box.sagernet.org/clients/` |
| `hiddify` | `https://hiddify.com` |
| `cmfa` | `https://github.com/MetaCubeX/ClashMetaForAndroid/releases` |
| `shadowrocket` | `https://apps.apple.com/us/app/shadowrocket/id932747118` |

> `hiddify` 以**不带尾斜杠**的写法为准（与 Rust 固定映射一致）；调用方不要依赖尾斜杠，Host 侧按归一化后比较。

未知 / 缺失 / 非枚举值 → `INVALID_ARGUMENT / unknown_client`，**不静默回退**；**不接受调用方传 URL**（否则命令变成通用字符串转二维码工具）。不登录、不调控制面、不涉及令牌。四个 id 对应 §3.7.8 的 M1 四行。

### 5.2 设置目录行 id

`commands.md` §9.1.1 与 `tools.md` §4.50 的行白名单同步新增：

```
account.mobile
```

- 对应界面：设置 › 账户余额行之后的 `在手机上使用` 行（`data-point="account.mobile"`）。
- 只是「指路」：AI 可以让设置滚到这一行并高亮，但不能打开弹层、不能读 URL。
- `SETTINGS_ROWS` 从 11 项变 12 项（`src-tauri/src/tools/settings.rs`）。

### 5.3 事件：不新增

| 候选事件 | 判断 |
|---|---|
| 令牌生成 / 轮换完成 | **不做**。弹层是用户点开的同步命令，结果已在返回值里；没有第二个订阅方 |
| 手机端拉取成功 | **不做**。控制面事件不该推给桌面；桌面也不展示「手机最近同步于」 |
| 节点增减导致 profile 变化 | **不做**。URL 不变，客户端下一个周期自己拉；桌面没有可渲染的中间状态 |

因此 `events.md` 不变。

### 5.4 版本建议

| 文件 | 建议 | 依据 |
|---|---|---|
| `docs/contracts/commands.md` | **`2.46.1` → `2.47.0`**（固定，不并入 2.46.x） | `mobile_export_get` / `mobile_export_rotate` 的返回从单 URL 改为 `formats[]`（§5.1 / §3.7.7）；`mobile_clients_qr` 改客户端枚举；2.46.1 已随 prod 上线，两项都是线上可见变更 |
| `docs/contracts/tools.md` | **保持 `3.22.1`，无需变更** | 三个命令都是仅 UI，不注册 AI 工具；`OpenSettings` 的 `account.mobile` 行已在 3.22.0 登记 |
| `docs/contracts/events.md` | **不变** | 无新事件 |
| `docs/contracts/catalog.md` | **不变** | 与服务端目录协议无关 |
| `docs/data-model.md` | **不变** | 桌面本地库无变化（控制面 D1 归 `cloudflare/control-plane/migrations/README.md` 管） |

> `commands.md` 的版本号只代表该文件；不要顺手改 `events.md` / `tools.md` 之外的版本。

---

## 6. 数据模型增量

### 6.1 控制面 D1：`0009_mobile_tokens.sql`

```sql
-- 手机端导出令牌：账户级一条，长期有效，轮换即失效。
-- token_hash 用于认证查找；iv/ciphertext 用于把同一个令牌回显给桌面。
-- 与其他控制面表一致，不声明外键（现有 D1 schema 全部用列关联）。
CREATE TABLE mobile_tokens (
  account_id   TEXT PRIMARY KEY,
  token_hash   TEXT NOT NULL,
  key_version  INTEGER NOT NULL DEFAULT 1,
  iv           TEXT NOT NULL,
  ciphertext   TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  rotated_at   INTEGER,
  last_used_at INTEGER
);

CREATE UNIQUE INDEX mobile_tokens_hash ON mobile_tokens(token_hash);
```

- 遵循迁移规则：只新增编号，不改 `0001`–`0008`；新表不需要 `ALTER COLUMN` 的 DEFAULT 处理。
- 不需要回填。
- `npm run schema:check` / `-- --env dev` / `-- --local` 三处都要过，合并门禁按现有流程。
- `rate_limits` 表复用，不新增列；键前缀见 §1.6。

### 6.2 桌面本地 SQLite

**无变化。** 不新增表、不新增列、不改 `SCHEMA_VERSION`。令牌不落本地，二维码不落盘。

### 6.3 Worker 环境变量

| 名称 | 类型 | dev | prod | 缺失时 |
|---|---|---|---|---|
| `MOBILE_TOKEN_ENC_KEY` | Worker secret（base64 的 32 字节 AES 密钥） | 需要 | 需要 | `POST /v1/mobile/token*` 与 `GET /v1/mobile/profile` 均 `503 INTERNAL / mobile_key_missing` |

`Env` 接口（`src/index.ts`）加可选字段；不要写进 `wrangler.jsonc` 的明文 vars。

---

## 7. 安全

### 7.1 令牌不进日志 / AI 上下文 / 界面文本

| 通道 | 规则 |
|---|---|
| Worker 日志 | 只记 `method`、`path`（不含 userinfo）、状态码、账户 id 前 8 位；**永不**记 `Authorization` 头、令牌、URL |
| 桌面日志 | `ControlPlane::send` 现有实现只记 path，不记完整 URL；新模块同样只记 path 与布尔结果。错误信息不得把 URL 拼进 `message` |
| 前端 | 不渲染为文本 / `alt` / `title` / `aria-label`；不进事件 payload；不进 `ai_send_message.context` |
| 审计 | `audit_log.detail` 只放时间戳与布尔值，不放令牌片段 |

### 7.2 二维码不落盘

- Rust 在内存里生成 SVG → base64 data URL → 前端 `<img src>`。
- 不写临时文件、不写 `secrets.enc`、不写 `my_servers` / `nodes`。
- 关闭弹层即停止渲染，默认不做任何持久化（React 状态随卸载释放）；是否在同一会话内保留见 §10 建议改 10，仍不落盘。

> 这不同于运行时的 sing-box 配置：后者按设计写临时文件（`data-model.md` §2），本路径不经过它。

### 7.3 转发风险与 M1 接受度

- 链接等于「该账户全部可用付费节点的读取权」。转发给他人 → 对方可在任意设备使用。
- M1 按产品定稿**不做设备数限制、不做技术对抗**；提供「重新生成」作为唯一止损：旧链接立即失效，新链接需重新扫码。注意这只覆盖两个展示中的 URL；`/profile/ss` 返回的节点密码不在轮换范围内（§3.7.4 / §7.3）。
- 链接不能写、不能查账户、不能动钱包；最坏情况是节点被他人使用，不是账户被接管。
- **三种格式的失效面不同**：sing-box / Clash URL 受令牌轮换控制；`/profile/ss` 返回的节点链接如果被外部工具保存，轮换不影响它——它携带节点密码，要让其失效必须重建服务器（换密码）。M1 不提供粘贴入口，这是端点固有的残余风险，与转发风险同级。
- **安全文案不得写绝对句**：「重新生成后旧配置全部失效」是错的。准确说法是「旧链接失效，手机上的配置下次更新时不再可用」；ss 文本的不可收回性见上一条。
- 界面已写「链接相当于密码，别转发」；技术侧不再加二次确认或水印，避免把可恢复动作做成高风险流程。

### 7.4 域名与 TLS

- profile URL 只用 `env.rs` 解析出的 origin；release 固定 `https://veyl.dessage.xyz`，debug 固定 `https://cp-dev.veyl.dessage.xyz`（或 debug 覆盖值）。
- 禁止 `*.workers.dev`：桌面构造后显式检查，命中即拒绝出图（§4.1）。控制面本身不需要额外判断。
- TLS 由 Cloudflare 终止；证书链与移动网络可达性由 V7 实测。Worker 不自行改 TLS 设置。
- 建议（运维项，不在本设计实现）：确认这两条路由不被 Cloudflare Bot Fight / Turnstile 拦截；`Cache-Control` 已由 Worker 给出 `no-store`，不需要额外 Page Rule。

### 7.5 残余风险（写明，不藏）

| 风险 | 状态 |
|---|---|
| 链接被转发 / 截图 | **接受**（产品定稿）。轮换是唯一止损 |
| `/profile/ss` 返回的节点链接被外部工具保存 | **接受**：它携带节点密码；失效只能重建服务器（换密码）。M1 不提供粘贴入口，见 §3.7.4 / §7.3 |
| 控制面整体失守（库 + 密钥） | 已登记（`my-servers.md` §17.7）。令牌不改变该结论 |
| 设备本地保存了链接（剪贴板、相册） | 我们无法控制；界面只提示 |
| sing-box 客户端把 Authorization 写进自己的日志 | 未知，客户端行为；V3 / V4 观察 |
| Cloudflare 访问日志记请求路径 | 路径不含令牌；userinfo 不进请求行。若 V3 回退到 path 方案，需要重新评估这一条 |

---

## 8. 实现前检查单（V1–V17）

> 每条都要有证据（截图 / 录屏 / 命令输出 / Worker 日志计数），不能只写「试过可以」。测试期间不改工作树（测量冻结）。

| # | 验证 | 步骤 | 判定 | 阻塞 |
|---|---|---|---|---|
| V1 | iOS 相机扫 scheme URL | 用 debug 包生成测试二维码；iPhone 系统相机扫码 | 直接唤起 SFI 并出现导入确认；导入后 profile 可见 | 是 |
| V2 | Android 扫码路径 | 分别用系统相机 / Google Lens / SFA 内置扫码试同一张码 | 至少一条路径能导入；若都不行，记录并确定「客户端内粘贴 / 从相册识别」的替代路径 | 是 |
| V3 | Basic 认证实际行为 | 起一个只校验 `Authorization` 的测试 Worker（日志只记「收到头 / 未收到」，不记值）；导入后观察首次拉取与自动更新 | 每次拉取都带 Basic，密码与令牌一致；URL 里的 userinfo 被保留 | 是 |
| V4 | 自动更新触发条件 | 改一台节点（重建或改名）后记录时间；观察 Worker 请求与客户端节点变化 | 前台约 60 分钟内至少拉取一次；后台/重开 App 后的行为记录在案（不要求后台每分钟） | 否（决定文案） |
| V5 | SFA 最低 Android 版本 | 从 GitHub Releases 取 APK，`aapt dump badging` 读 `sdkVersion` | 得到准确最低版本；与官方页面口径对照 | 否（只影响下载页文案） |
| V6 | SFI 收费与区域 | 用大陆以外 Apple 账号打开 App Store 页面 | 记录价格（免费 / 付费）与地区限制；与 `mobile-export.md` §2.1 对齐 | 否 |
| V7 | 两个自有域名在移动网络可达 | 手机关 Wi-Fi、蜂窝网络下直接打开 profile URL（可先要一个测试令牌） | 证书链完整、无 `workers.dev`、耗时可接受；记录运营商与时间 | 是 |
| V8 | 客户端接受本设计的配置 | 用 V1/V2 导入真实 profile；连接、切换节点、断开重连；打开网页 | **系统隧道建立（VPN 已连接且流量计数非 0）**；**出站绑定物理网卡、不出现回环**；**路由生效**（访问外网走节点出口）；**能解析域名并打开网页**；selector 中出现全部付费节点；免费 / 试用节点不在列表 | 是 |
| V9 | 零节点配置的客户端表现 | 销毁全部服务器（或用只含 `direct` 的测试 profile）后等一次更新 | 记录客户端是「更新成功但无节点」还是「更新失败」；**确认不会建立一条假 VPN 把全部流量直连**；据此决定保持 200 还是改为 4xx | 是 |
| V10 | 轮换后的旧链接行为 | 点「重新生成」，等客户端下一次拉取 | 旧链接 401 / 更新失败；新二维码导入可用；已导入的旧 profile 不会被静默改写成空 | 是 |
| V11 | URL Scheme 的 query 编码 | 用含 `@`、`:` 的完整 URL 生成二维码，扫码 | 客户端拿到的 URL 完整（不被 `&` / `#` 截断）；若失败，检查 encode 实现 | 是 |
| V12 | 蜂窝网络回归（DNS） | 关闭 Wi-Fi，用蜂窝网络重复 V8：手动刷新 profile → 打开网页 → 重启客户端再试一次 | 与 Wi-Fi 同样能解析并打开网页；记录运营商、手机 DNS 设置与客户端日志前 20 行 | 是 |
| V13 | Clash YAML 被客户端接受 | 在 CMFA 中导入 `/profile/clash`（Basic 写在 URL userinfo）；连接、打开网页；clash 二维码若展示，扫一次。Clash Verge 仅作桌面对照 | 节点出现在列表；能连上并打开网页；Basic 生效 | 是 |
| V14 | Shadowrocket：ss 订阅、Basic 与返回体编码 | 用 Shadowrocket 扫 `ss` 二维码（内容 = `/profile/ss` 的 URL，userinfo 带令牌）。**先测纯文本逐行**；若报「格式错误」，再临时构造 base64 包装的同一内容（路径后缀 `/profile/ss/base64`，§3.7.8）。区分 401（Basic 不支持）与格式错误（body 编码） | 能导入节点并连上；记录两种 body 的结果；两者都不行则按 §3.7.8 撤行或改实现 | 是 |
| V15 | 轮换的全局性 | 三种格式各导入一处，点「重新生成」，等各自下一次拉取 | 三个旧 URL 全部 401；新令牌在三种格式都可用 | 是 |
| V16 | 零节点表现 | 销毁全部服务器后等一次更新 | sing-box 不建隧道；Clash 是否接受空 `proxies`；Shadowrocket 是否把 ss 空 body 当作成功；记录客户端差异 | 是 |
| V17 | Clash 的 UDP | 用 Clash 类客户端连接后访问一个 UDP 服务（如 QUIC / DNS over UDP） | 记录 `udp: true` 是否实际可用；不可用则从 YAML 去掉，不影响 TCP | 否 |

**V9 的决策后果**：若客户端对「只有 direct」的 profile 报错并保留旧配置，需要改为 `410 Gone` + 明确的错误体（仍无法清除客户端缓存），并在 §1.7 更新；这一条必须在实现前定，不要两边都写一半。

---

## 9. 实现拆分建议（只给边界，不派活）

三组可以并行，互不修改同一文件。前提：本文件的 §1 / §5 / §6 先被 PM 接受为契约增量。

### 9.1 be-cp：控制面

| 文件 | 改动 |
|---|---|
| `cloudflare/control-plane/migrations/0009_mobile_tokens.sql` | 新表 + 唯一索引（§6.1） |
| `cloudflare/control-plane/src/mobile.ts` | 新模块：`/token`、`/token/rotate`、`/profile`、`/profile/clash`、`/profile/ss`；令牌生成/加解密、选节点、三种格式生成器、零节点分支、限流、审计 |
| `cloudflare/control-plane/src/index.ts` | 模块链加 `handleMobile`；`Env` 加 `MOBILE_TOKEN_ENC_KEY?: string` |
| `cloudflare/control-plane/test/mobile.test.ts` | 单测：幂等、并发创建、轮换、Basic 解析、三种格式形状、零节点、跳过坏凭据、限流、YAML 特殊字符、SIP002 编码 |
| `cloudflare/control-plane/scripts/schema-check.mjs` | 通常无需改（自动读 migrations）；跑三种库确认 |

不碰 `servers.ts`、`auth.ts`、`lib/crypto.ts` 的实现（复用导出即可）。

### 9.2 be-desktop：Rust Host

| 文件 | 改动 |
|---|---|
| `src-tauri/Cargo.toml` | `qrcode`、`url = "2"` |
| `src-tauri/src/control_plane/mobile.rs` | 新模块：调两个 token 端点、拼三个 URL、构造 sing-box scheme URL、Clash URL 二维码、三个下载码的固定映射、生成 SVG data URL、origin 校验、单测（固定环境、编码、未知 client、零门禁） |
| `src-tauri/src/control_plane/mod.rs` | 注册模块 |
| `src-tauri/src/agent/commands.rs` | `mobile_export_get` / `mobile_export_rotate` / `mobile_clients_qr` |
| `src-tauri/src/lib.rs` | 两个 handler 列表各加三条（debug / release 保持一致） |
| `src-tauri/src/tools/settings.rs` | `SETTINGS_ROWS` 加 `account.mobile`，长度 11 → 12 |

不碰 `config/builder.rs`：桌面运行时配置与手机配置是两份，不共用生成器。

### 9.3 fe：前端

| 文件 | 改动 |
|---|---|
| `src/components/MobileExport.tsx` | 新组件：480 弹层、五态、复制、就地确认、焦点回触发元素 |
| `src/components/icons.tsx` | 新增 `IconPhone`（同族 16 viewBox / stroke 1.4） |
| `src/components/Settings.tsx` | 账户余额行后加 `在手机上使用` 行（`data-point="account.mobile"`），`查看` 打开弹层 |
| `src/components/MyServersRail.tsx` | 左栏底部 `新建节点` 之后加一行；出现条件按 UI 稿；不随列表滚动 |
| `src/App.tsx` | 弹层 open 状态、两个入口回调、关闭后的焦点归属 |
| `src/agent/tauriBridge.ts` | 两命令的类型与调用封装 |
| `src/styles/app.css` | 弹层与左栏行的样式（复用 `.modal` / `.settings-row` / `.rail__action-row`） |
| `src/components/MobileExport.test.tsx` 等 | 五态、复制、确认、两个入口共用组件 |

### 9.4 依赖与顺序

```
本设计评审
   ├─ 契约增量合并（PM：commands.md / tools.md）
   ├─ be-cp（端点 + 迁移 + 测试）
   ├─ be-desktop（命令 + 二维码 + URL）
   └─ fe（弹层 + 两个入口）
        └─ 联调：fe 依赖 be-desktop 的命令形状；be-desktop 依赖 be-cp 的响应
```

- 三组之间没有文件重叠；`be-desktop` 与 `fe` 可以按本文件的类型先写，联调前不需要等控制面部署。
- 真机验收（V1–V17）在联调之后、由产品 / 同事执行；AI 只取证与核对（`aivpn-tests-started-by-user`）。

---

## 10. 必须改 / 建议改 / 不改

### 必须改（P1）

1. **新增控制面端点**（`/v1/mobile/token`、`/token/rotate`、`/profile`、`/profile/clash`、`/profile/ss`）与 `mobile_tokens` 迁移；所有 profile 响应必须 `no-store`，401 必须带 `WWW-Authenticate`。
2. **控制面按请求生成配置**：只筛 `source = owned` 对应的 `servers`，排除免费 / 试用；不导出桌面 TUN 参数 / `mixed` 入站 / 本地端口 / Clash API。**非零模板必须带最小 TUN 入站（`auto_route` 为真）、`route.auto_detect_interface: true` 与最小 DNS（DoH 经代理 + `hijack-dns`）；零节点模板不得带 `inbounds` 或 `dns`**。
3. **三种格式的边界**：`/profile` 路径保持不变；Clash YAML 只出 `proxies` / `proxy-groups` / `rules`，**不含** TUN、DNS、端口、`mode`；ss:// 严格按 SIP002（base64url 无填充）逐行输出；零节点按 §3.7.9 各给「合法空配置」，全部凭据不可用统一 503。**ss 行随 Shadowrocket 进 M1**，其二维码 = 订阅 URL 本身（待真机）；`/profile/ss` 与单测必须实现。
4. **桌面 Rust 生成 URL 与二维码**：origin 只取 `env.rs`，禁止 `workers.dev`；令牌不落本地；三种格式都返回 URL 与二维码，不取 ss 文本。下载码走 `mobile_clients_qr { client }` 的固定映射，不接受任意 URL。
5. **两个 UI 入口共用同一弹层与命令**；左栏行只在「已登录 + 至少一台节点就绪 + 列表非 loading/error」时出现。
6. **契约增量**合并：`commands.md` **固定 `2.47.0`**（`formats[]` + `mobile_clients_qr` 枚举）、`tools.md` 保持 `3.22.x`（这三个命令都是仅 UI，**不新增 AI 工具**；仅有的相关项是 `account.mobile` 行登记）。
7. **验签 / 解密失败不得泄露凭据**：单台凭据解不开就跳过，不返回错误详情到客户端。
8. **M1 只对四个 App 负责**：sing-box 官方 / Shadowrocket / CMFA / Hiddify（§3.7.8）。Shadowrocket 是唯一例外——Basic 与返回体编码未核实，界面标「待验证」并带撤下条件；Karing / Stash / Loon / Quantumult X / v2rayNG / FlClash 不列入；不做「仅 ss 文本粘贴」特例（§3.7.5）。

### 建议改（P2）

9. 轮换限流 10 次/小时、profile 30 次/小时（三种格式共享）；数值可按实测调整。
10. `last_used_at` 节流写（5 分钟一次），避免每条请求都写 D1。
11. 把 origin 校验、scheme 编码、SIP002 编码与 YAML 标量引用抽成纯函数单测，不靠真机回归；节点名要覆盖 `:`、`#`、引号、前导 `-`、emoji。
12. 同一会话内可在 `App` 内存里保留最近一次成功结果（三种 URL + 二维码），断网重开弹层不必重新请求；**只存内存，不落盘**，退出应用即丢弃。
13. `my-servers.md` §16.3 第 5 条改写为「不做一次性下载链接；提供账户级、可吊销的远程配置 URL（多格式）」。`mobile-export.md` §10 同步补三种格式。

### 不改

| 项 | 理由 |
|---|---|
| 不改桌面 `data-model.md` / 本地 schema | 令牌与二维码都不落本地 |
| 不新增事件 | 没有第二个订阅方，弹层同步返回即可 |
| 不新增 AI 工具 | 令牌不得进入模型上下文；只加指路行 id |
| 不复用 access / refresh 令牌 | 用途、生命周期、吊销面都不同 |
| 不做单台二维码 | 产品已定账户级一条 |
| 不在配置里加 `urltest` | 默认探测 URL 在大陆的可达性未核实；不可达会造成假故障切换 |
| 不做二维码「另存为」以外的交互 | 与 UI 稿一致 |
| 不改 `/v1/mobile/profile` 路径、不加 `/singbox` 后缀 | 已导入的旧 profile 永远指向它；改名会让所有手机下一次更新 404 |
| M1 不做路径令牌 | 令牌会进请求行与日志，违反 §7.1；不支持 Basic 的客户端不进列表，也不做 ss 文本粘贴特例 |
| 不预先砍 Clash 二维码 | 产品 2026-11-20 决定保留，码内容 = 带凭据的订阅 URL；能否扫通由 V13 判定，扫不通再退回只给复制链接 |
| 不把未核实 Basic 的客户端列进 M1（Shadowrocket 除外） | Karing / Stash / Loon / Quantumult X 核实后再进；Shadowrocket 由产品拍板先上，界面标「待验证」，带撤下条件（§3.7.8） |
| 不在 Clash YAML 里塞 TUN / DNS / 端口 / `mode` | 接管方式与 DNS 由 Clash 客户端自己管理；塞进去会覆盖用户设置 |

---

## 11. 待确认

| # | 事项 | 现状 / 建议 | 谁定 |
|---|---|---|---|
| 1 | 令牌在控制面「哈希 + 密文」双存（§2.2） | 为满足「同一二维码可反复显示」而必须可回显；风险与现有节点凭据同级。若坚持只存哈希，则桌面必须本地持久化明文，换机后旧链接不可见 | 架构师已定，PM 知会即可 |
| 2 | 登出是否吊销手机链接（§2.6） | **PM 已定（2026-11-19）：不吊销。** 登出只结束这台电脑的会话；吊销的唯一入口是「重新生成」。残余风险：账户被盗后登出不会断开手机，需用户主动重新生成 | PM |
| 3 | 零节点的客户端表现（V9） | 当前按「200 + direct-only」设计；V9 若证明客户端报错，改为 410（§1.7 / §8）。**PM 已定：按 V9 结论执行，不在结论出来前实现第二套** | 验证结论 + 架构师 |
| 4 | Windows 构建是否同样支持 | 代码路径与平台无关；真机验收需 Windows 测一台（调试包）。**PM 已定：排在联调之后，由产品负责人在 Windows 真机执行** | PM 安排 |
| 5 | 是否要在 M1 提供「吊销但不重建」 | **PM 已定：不做。** 界面只有「重新生成」；多一个端点就是多一条没有入口的路径 | PM |
| 6 | 下载页 Android 渠道文案 | 已定：只给官方客户端页一条 | 已定，不改 |
| 7 | 配置是否携带 DNS | **必须携带**：真机实测覆盖了初版「不导出 DNS」。非零模板固定 `1.1.1.1` DoH（`detour: "proxy"`）+ `hijack-dns`；零节点不带 DNS。已落地，不再是待确认项 | 已定（架构师），PM 知会 |
| 8 | 配置是否携带 TUN 入站 | **必须携带**：官方客户端源码确认只有声明 TUN 入站才创建系统隧道（§3.5）。非零用最小 TUN（`auto_route: true`、`dns_mode: "hijack"`、`dns_address`）+ `route.auto_detect_interface: true`；零节点不建 TUN，避免假 VPN 把全部流量直连 | 已定（架构师），PM 知会 |
| 9 | Shadowrocket / Karing / Stash 的 Basic | **已定（2026-11-20）：Shadowrocket 列入 M1，Basic 与返回体编码均未核实**，V14 由产品负责人朋友真机测；验不过按 §3.7.8 撤行或改实现。Karing / Stash 不列入（Basic 未核实） | PM 已定 |
| 10 | Clash 的二维码内容 | **已定（2026-11-20）：保留**，码内容 = 带凭据的订阅 URL；能否扫通由 V13 判定，扫不通再退回「只给复制链接」 | PM 已定 |
| 11 | ss 空 body 的客户端表现 | 零节点返回 200 + 0 字节；是否被客户端当作「更新成功」未核实（V16）。若被当作失败，可改为 204 或保留最后一份空列表 | 验证结论 + 架构师 |
| 12 | Clash 的 `udp: true` | 服务端 SS 入站与防火墙都支持 UDP，但客户端实际路径未验（V17）。不可用就去掉该字段，TCP 不受影响 | 验证结论 |
| 13 | ss 行是否进 M1 界面 | **已改（2026-11-20）：随 Shadowrocket 进 M1**；`formats[]` 的 `ss` 出 URL 二维码，端点与单测照做。真机失败按 §3.7.8 撤行 | PM 已定 |
| 14 | 是否保留格式切换器 | **已定（2026-11-20）：删除**。v4 设计按 App 分类，格式只做内部映射（§3.7.12） | PM 已定 |
| 15 | `mobile_clients_qr` 是否加 `shadowrocket` | **已定（2026-11-20）：加，四个 id**（`singbox` / `hiddify` / `cmfa` / `shadowrocket`），`shadowrocket` → App Store 链接；Rust 已实现、本机测试通过 | PM 已定 |

**所审版本（2026-11-19 至 11-20）**：本文件的 TUN + DNS + `auto_detect_interface` 改写对应代码基线 `c1de5b3`；`stack: "gvisor"`、`sniff` 规则组与去掉 `strict_route` 为工作区未提交改动（`cloudflare/control-plane/src/mobile.ts:444–476`、`test/mobile.test.ts`）。`npm run typecheck` 与 `npm test`（212/212）为 2026-11-20 含四项修复的版本。客户端源码依据：`sing-box-for-apple` main、`SFA` main（2026-11-19 取源）。真机已在 iPhone（Wi-Fi）确认可打开网页；**蜂窝网络复验尚未执行**（V12）。多格式部分（2026-11-20）的客户端依据与未核实项见 §3.7.5 / §3.7.8 与上表 9–15；多格式实现尚未开始。**矩阵与三条拍板（未核实 Basic 的客户端不列入、Clash 二维码保留、commands 2.47.0）来自产品 2026-11-20 的跨会话决定；同日改向「界面按 App」，§3.7.8 已收敛为四个 App（sing-box 官方 / Shadowrocket / CMFA / Hiddify），其余走下期与兜底行；两段格式切换器已删除（§11 #14）。**

---

## 12. 与现有文档的冲突登记（只登记，不改）

| 文档 | 影响 |
|---|---|
| `my-servers.md` §16.3 第 5 条「不做一次性订阅链接」 | 本次是其预留口子；形态是账户级、可吊销的远程配置 URL，不是一次性下载。需 PM 回写表述 |
| `my-servers.md` §16.2「不把凭据做成带购买者 id 的令牌」 | **不冲突**：导出令牌是**读取授权**，不是节点凭据；节点密码仍按 `server_id` 生成、不派生自账户、不绑定设备。轮换令牌不需要重建节点，也不影响将来 1:N |
| `my-servers.md` §17.3「界面不显示 IP / 端口 / 协议」 | 不冲突。导出内容含地址与密码，但界面文本仍不展示；二维码只含 URL |
| `login-and-payment.md` §2.5 | 需补一句：导出令牌与 access / refresh 完全独立，见本文 §2.4 |
| `environments.md` §1 / §4.1 | 仍有过期的 `*.workers.dev` 描述；以 `env.rs` 与 `wrangler.jsonc` 为准。本次不改 |
| `mobile-export.md` §9「端点 / 命令名称占位」 | 以本文为准：`GET /v1/mobile/profile`、`/profile/clash`、`/profile/ss`、`POST /v1/mobile/token`、`POST /v1/mobile/token/rotate`、`mobile_export_get`、`mobile_export_rotate`；`mobile_export_get` 返回 `formats[]` |
| `mobile-export.md` §4 / §9（只写 sing-box） | 2026-11-20 产品拍板扩为三种格式；需求稿需 PM 回写「三种格式 + 共用令牌 + Basic」，否则实现会按单格式做 |
| `docs/contracts/commands.md` §9.1.1 / `tools.md` §4.50 | 行 id `account.mobile` 需合并；本文已给增量 |
