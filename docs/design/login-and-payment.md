# 登录门禁与支付（M1）

> 日期：2026-11-15
> 状态：设计定稿，待实现；替换现有的「设备静默身份 + 假支付直接放行」
> 关联：`docs/design/my-servers.md` §19（设备令牌、建机闭环）、`docs/design/environments.md`（dev/prod 控制面）
> 参考实现（只读）：`/Users/wesley/ai/TweetPilot/cloudflare/license-worker/` 的 `auth.ts` / `email.ts` / `dodo-checkout.ts` / `dodo-webhook.ts`
> 范围：`docs/` 设计稿与契约增量；不含实现代码

---

## 0. 结论先行

| # | 问题 | 结论 |
|---|---|---|
| 1 | 身份 | 邮箱 6 位验证码登录；设备令牌保留为「这台机器」的身份，邮箱账户是「这个人」的身份；登录即把设备并入邮箱账户 |
| 2 | 门禁 | 建机、我的服务器、支付、销毁、取凭据都要登录；**已有节点与配置的连接不需要登录**，离线照常可用 |
| 3 | 令牌 | 复用现有 `TOKEN_SIGNING_JWK`（Ed25519），只加 `kind` / `amr` claim；access 15 分钟、refresh 30 天滑动 |
| 4 | 收费 | **M1 只做预付费余额**（USD 分记整数）；Dodo 一次性充值产品，微信可付；订阅不上线（M2） |
| 4b | 商户 | 与 TweetPilot **同一个 Dodo 商户账号**；充值产品、webhook、回跳页、API key 都按 Veyl 自己的建（§4.8） |
| 5 | 建机时机 | 下单 → `checkout` **只确认下单、不扣费**（预检余额 ≥ 日价 × 7，不足返回 `insufficient_balance`，不建机）→ 服务器就绪（enroll 确认 sing-box 起成功）时扣第 0 天，之后每天由 Cron 扣一天（§4.14） |
| 6 | 幂等 | 充值 webhook 用 `webhook-id` + `payment_id` + 账本 ref 唯一；扣费用账本唯一键 + 原子守卫；同一订单 / 同一期只扣一次 |
| 7 | 价格 | 目录与扣费都用**售价**（成本 × 1.5），存 USD 分；Dodo 只负责把充值换成 USD 入账 |
| 8 | 到期 | 每日 Cron 扣费续期；扣不动进 **7 天宽限**，结束标 `expired`；不删机器、不删凭据，继续计费（§4.6、§4.11、§8） |

---

## 1. 现状与对不上的地方（先说清楚，不绕）

现有实现（`cloudflare/control-plane`）：

| 模块 | 现状 |
|---|---|
| `src/auth.ts` | 设备静默注册 / 刷新；`accounts.kind = 'device'`；access 15 分钟、refresh 30 天轮换 |
| `src/orders.ts` | `POST /orders` → `pending_payment`；`checkout` **直接写 `paid_at` 并同步建机** |
| `src/provision.ts` | 建 droplet、写 enrollment；失败销毁 |
| `src/servers.ts` | 列表 / 详情 / 销毁 / 凭据 |
| 客户端 `control_plane/auth.rs` | 令牌存本地加密凭据库（`secrets.enc`），**不是系统钥匙串**（实现说明已记录偏差） |
| 契约 | `commands.md` 2.26.0 / `events.md` 2.13.0 / `tools.md` 3.12.0 / `data-model.md` 6 |

**接了真实支付后，下面八处对不上，必须一起改：**

| # | 冲突 | 处理 |
|---|---|---|
| 1 | 目录展示 DigitalOcean 成本价（`$6/月`），实收必须按售价 | 目录改成展示**售价**；扣费按 `PLAN_PRICES_USD` 换算成分，不一致报 `price_mismatch`（§4.4） |
| 2 | `checkout` 同步建机，没有「余额从哪来」这一层 | 加入钱包：下单 → **余额扣费** → 建机；充值走 Dodo（§4.3、§4.4） |
| 3 | 订单状态被 2.27.0 加了 `awaiting_payment` / `payment_failed` / `expired`，但没有外部收银台可等 | 删除这三态，恢复 `pending_payment → paid → provisioning → ready`（§6.1） |
| 4 | `orders.expires_at` 10 分钟，充值后重试可能超时 | 订单 10 分钟有效；超时可重新下单，余额不受影响（§4.4） |
| 5 | 没有「一个订单只建一台服务器」的约束 | 加唯一索引 `servers(order_id)` |
| 6 | 设备注册是静默的，没有登录概念；设备也没有「登出」路径 | 登录 = 设备并入邮箱账户；新增 `logout` 把设备解绑到新的匿名账户（§2.4） |
| 7 | 只有一次性支付的模型，没有余额、流水与续费 | 新增 `wallet_ledger`、`topups`；`accounts.balance_cents`（§4.2、§4.9） |
| 8 | 没有到期 / 宽限的任何状态 | `servers.billing_state` + 每日 Cron + 7 天宽限（§4.6） |

> 另有一处已知偏差：客户端令牌存在 `secrets.enc`（机器绑定、0600），不读写系统钥匙串。本文沿用实现，不再要求改用钥匙串；`my-servers.md` §19.2.3 的 Keychain 描述视为实现偏差，以本文为准。

---

## 2. 账号模型

### 2.1 两种身份，各管一件事

| 身份 | 证明什么 | 存在哪 | 过期 |
|---|---|---|---|
| **设备身份** `device_id` + `device_secret` | 「这台机器是同一台」 | 客户端 `secrets.enc`；控制面只存 `sha256(secret)` | 不过期；用户点「重新注册设备」才换 |
| **邮箱账户** `accounts.kind = 'email'` | 「这些服务器和订单属于这个人」 | 控制面 D1 | 不适用 |

- **邮箱是账户唯一键，`account_id` 是内部主键**（对照参考实现的 `identity:email:{email}`）：`accounts.email` 已有唯一索引；并发首次登录时用唯一索引兜底——插入冲突就回读已有账户，不产生两个同邮箱账户。`account_id` 只在本系统内部使用，界面不展示。
- 设备身份仍然静默建立（首次打开「我的服务器」或下单时），**生产环境里它不再能建机**：`POST /orders` 等接口要求 `kind = 'email'`。
- **过渡规则（本轮，2026-11-15 补）**：`ENVIRONMENT !== "production"` 时，匿名设备账户（`kind = 'device'`）**允许下单并按 `fake` 通道建机**；生产环境才强制 `kind = 'email'`。理由：登录界面本轮不做，现有建机测试流程必须能继续跑；生产环境不受这条影响，匿名账户仍然只能看目录。
- 一个设备**同时只属于一个账户**。登录 = 把当前设备从匿名设备账户并入邮箱账户；登出 = 反过来。

### 2.2 邮箱验证码（常量照参考实现）

| 项 | 值 | 来源 |
|---|---|---|
| 码长 | 6 位数字（`crypto.getRandomValues`） | 参考 `auth.ts` |
| 有效期 | **300 秒** | `VERIFY_CODE_TTL_SECONDS` |
| 同邮箱冷却 | **60 秒** | `VERIFY_CODE_COOLDOWN_SECONDS` |
| 同 IP 发码上限 | **10 次/小时**（`CF-Connecting-IP`） | `SENDCODE_IP_RATE_LIMIT` |
| 同码失败上限 | **3 次**，超过即作废，回到第一步 | `VERIFY_CODE_MAX_ATTEMPTS` |
| 发信 | Resend：`POST https://api.resend.com/emails`，`Bearer RESEND_API_KEY`，`from = RESEND_FROM_EMAIL` | 参考 `email.ts` |

**两处比参考实现更严**（写清楚，不是照抄）：

1. **验证码存哈希不存明文**：D1 里只放 `sha256(code + ":" + email)`；参考实现存明文。
2. **验证接口按 IP 另限 20 次/小时**：否则换邮箱就能绕过「每码 3 次」的尝试上限。

发码接口**不区分邮箱是否已注册**，统一返回 `{ sent: true, cooldown_seconds: 60 }`（防枚举，沿用参考实现）。发信失败只记日志，不向调用方暴露。

### 2.3 登录流程（服务端）

```
POST /v1/auth/email/start   { email }
  └─ 冷却 / IP 限频 → 生成 6 位码 → 存 hash（300s）→ Resend 发信
       └─ 200 { sent: true, cooldown_seconds: 60 }   （无论邮箱是否存在）

POST /v1/auth/email/verify  { email, code, device_id, secret_hash }
  ├─ 校验码（hash、过期、尝试次数）
  ├─ 校验设备证明（device 存在、secret_hash 一致、未停用）
  ├─ 找邮箱账户：存在就复用，不存在就建（kind = 'email'）
  ├─ 合并：设备当前所在的匿名账户 → 邮箱账户
  └─ 200 TokenBundle + { account_kind: "email", email, merged: true|false }
```

**设备证明为什么必须带**：否则任何人只要知道 `device_id` 就能把别人的设备绑到自己邮箱下。`secret_hash` 只能由本机算出来，服务端只做等值比较。

**设备还没注册过也能登录**：`verify` 发现 `device_id` 不存在时，用提交的 `secret_hash` 建 `devices` 行并直接绑定到邮箱账户（等于「注册 + 登录」一步完成）。这样用户第一次点登录不必先触发一次匿名注册。

**合并规则**（沿用 `my-servers.md` §19.2.5，补充落点）：

1. 设备当前账户 `kind = 'device'` → 把 `devices` / `orders` / `servers` 的 `account_id` 改为邮箱账户；旧账户写 `merged_into` 并停用；撤掉旧账户的 refresh token；写 `audit_log(account.merge)`。
2. 设备当前账户已经是同一个邮箱账户 → 不动，只发新令牌。
3. 设备当前账户是**另一个邮箱账户** → 拒绝：`PRECONDITION_FAILED / account_conflict`，提示「先退出当前账户」。**不做隐式换绑**——否则 A 的服务器会被并进 B。
4. 合并后 `authenticate` 必须拒绝 `merged_into IS NOT NULL` 的账户（旧 access token 最多再活 15 分钟，但不该续命）。

### 2.4 登出与换账号

`POST /v1/auth/logout`（Bearer access token）：

1. 作废该设备的所有 refresh token。
2. 新建一个匿名设备账户，把 `devices.account_id` 指向它；邮箱账户原样保留（服务器继续在用户名下）。
3. 返回新的 `TokenBundle`（`account_kind = "device"`）；客户端据此切到未登录态。

- **为什么必须服务端做**：只清本地令牌的话，下次静默注册会拿回同一个邮箱账户（设备行还绑着），等于「登出无效」。
- **离线不能登出**：命令失败给 `auth_required`，界面说「需要联网才能退出登录」；不允许本地假装已退出。
- **换账号 = 先登出，再用另一个邮箱登录**。不做「直接切换」。
- 登出**不删本地节点、不删 `secrets.enc` 里的节点密码、不改配置**——这些是用户已经买到手的东西，登出后仍可连接。

### 2.5 令牌

| 项 | 值 | 与现状的关系 |
|---|---|---|
| 签名密钥 | 复用 `TOKEN_SIGNING_JWK`（Ed25519） | 不新增密钥、不新增用途；一个验签路径 |
| access TTL | 15 分钟 | 不变 |
| refresh TTL | 30 天滑动、每次轮换、重放整族作废 | 不变 |
| claims | `sub`（account_id）/ `did`（device_id）/ `iat` / `exp` / `jti` / **`kind`**（`device`\|`email`）/ **`amr`**（`device`\|`email`） | 新增两个 claim |
| 响应 | `TokenBundle` 增加 `account_kind` / `email` | 客户端不必解 JWT |

**与参考实现的「过期 3 天内可静默续签」区分**：TweetPilot 的 portal JWT 是 30 天有效期 + 过期后 3 天宽限续签；Veyl **不引入这套 token**。我们的口径只有一条：access 15 分钟自动刷新、refresh 30 天滑动轮换；**超过 30 天没有联网刷新，就必须重新收一次邮箱验证码**（设备身份与服务器都还在，登录后原样回来）。没有额外的宽限期，也不要按参考实现的 3 天去设计。

- **不新增第二套 JWT**：参考实现的 portal JWT（30 天、`sub = user_id`）不引入；它的用途和现有 access token 完全重叠，两套只会让「谁能做什么」变成两处判断。
- `kind` 进 claim 是为了让服务端能**在路由层直接拒绝**匿名账户的建机请求，不用每次查 D1；同时仍以 D1 的账户状态为准（`merged_into` / `status`）。

---

### 2.6 登录响应 = 账号摘要（`MyServerAccount`）

**`my_server_login_verify` 与 `my_server_account` 返回同一个 `MyServerAccount`**，登录成功那一次响应就够渲染账号块，不再打第二次接口（对照参考实现 `verify` 直接返回 `paid_until / devices_used / devices_limit / trial_used` 的思路）。

```ts
type MyServerAccount = {
  logged_in: boolean;
  email: string | null;          // 已登录必有；未登录 null
  account_id: string | null;     // 内部主键，界面不展示
  device_id: string | null;      // 「这台设备」的标识，界面不展示
  account_kind: "device" | "email" | null;  // null = 还没有设备身份
  // 余额 / 到期：口径已定为预付费余额（§4.2、§4.11）；字段留到整体 UI 重构时再定义
};
```

| 字段 | 谁能用 | 说明 |
|---|---|---|
| `logged_in` | 界面 | 唯一门禁开关；`account_kind === "email"` 时为真 |
| `email` | 界面 | 账号块主行；未登录为 `null` |
| `account_id` | Host / 诊断 | 内部主键，**不进界面**、不进 AI 上下文 |
| `device_id` | Host / 诊断 | 只用于「这台设备」的归属判断，**不进界面** |
| `account_kind` | Host | `device` = 匿名设备账户；`email` = 已登录；`null` = 连设备身份都还没有 |
| 余额 | 以后 | 口径已定为预付费余额（§4.2、§4.11）；**本轮不定义字段**，整体 UI 重构时按 §4.11 的文案补：`余额 $9.87` |

- 两个命令返回同一形状，前端只写一份渲染逻辑。
- `my_server_account` **只读本地**、不联网；离线时仍能返回上次登录的摘要（`logged_in` 沿用本地记录），并用 `email` 渲染账号块。
- 响应里没有 token、密码、`device_secret`；这些永远只在 Host 的 `secrets.enc`。

---

## 3. 客户端门禁

> **本轮不做界面**（2026-11-15 用户决定）：登录弹窗、账号块、余额 / 充值入口、到期提示条都留到整体 UI 重构时按本节实现。本轮只落 Host 命令层与门禁语义；界面未上线前，开发 / 测试环境靠 §2.1 的匿名建机过渡规则继续跑通。

### 3.1 哪些操作要登录

| 操作 | 未登录 | 说明 |
|---|---|---|
| 打开「我的服务器」destination | 左栏空态「登录后查看你的服务器」，底部账号块给唯一一个 `登录` 按钮（§3.6）；中间显示登录引导 | **不自动弹窗**，用户点按钮才弹 |
| 点「创建服务器」/「确认下单」 | 弹统一登录弹窗；登录成功后回到向导，已选地区与套餐不变 | 沿用 `my-servers.md` §4.3 |
| 服务器列表 / 详情 / 销毁 / 重建 / 取凭据 | 需要登录 | 未登录不发请求 |
| 充值（打开 Dodo 收银台） | 需要登录 | 下单与充值都要求登录 |
| 已有配置连接 / 切换节点 / 测速 | **不需要** | 节点凭据在本地，离线可用 |
| 粘贴 / 订阅 / 手填导入节点 | **不需要** | 纯本地操作 |

### 3.2 登录弹窗

- 全产品只有一个登录模态：第一步邮箱 + `发送验证码`；第二步 6 位码 + 60 秒重发倒计时。
- 错误按三段式：`发生了什么 / 为什么 / 现在做什么`；码错显示剩余次数（「还可以试 2 次」）。
- 超过 3 次：关闭码输入，回到第一步并说明「验证码已作废，重新发一次」。
- `Esc` / 点遮罩关闭，不改变向导里已选的内容。
- 登录成功后**回到触发它的原处**，不跳页、不刷新整个 destination。

### 3.3 令牌存哪、过期怎么办

| 项 | 实现 |
|---|---|
| 位置 | `secrets.enc` 的 `control-plane.device` / `control-plane.tokens`（机器绑定、AES-256-GCM、0600）；**前端 JS 拿不到** |
| access 过期 | Host 自动刷新（单飞锁，30 秒余量） |
| refresh 失效 | 401 → 清令牌、回到未登录态；界面给「登录已过期，重新登录」 |
| 设备被停用 | `FORBIDDEN / device_revoked` → 未登录态 + 说明「这台设备已被停用」 |
| 账户被停用 | `FORBIDDEN / account_blocked` → 只读本地缓存，写操作禁用 |

### 3.4 离线宽限

**没有离线写队列，也没有「离线也能买」**。具体口径：

- 已登录状态下，本地缓存的服务器列表**继续显示**，顶部标「上次同步：<时间>」；所有写操作按钮禁用，点了提示「需要联网」。
- access 15 分钟、refresh 30 天：30 天内恢复联网可静默续期；超过 30 天未联网，下次操作要求重新输入邮箱验证码（设备身份还在，登录后服务器原样回来）。
- **已连接的 VPN 不受任何影响**：节点凭据在本地，控制面不可达时照常连接、切换、建配置。
- 服务端建机不依赖客户端在线：webhook 到账后会继续跑完。

### 3.5 身份丢失与重新注册

- 设备秘密丢失（换机、抹盘）但服务器仍在计费：沿用 `my-servers.md` §19.2.4，界面明确提示，`my_server_register_device` 是唯一恢复入口。
- **登录不能解决身份丢失**：邮箱账户里能看到服务器，但设备绑定的是旧 `device_id`；登录时设备会以新 `device_id` 并入邮箱账户，服务器随之回到列表。这条是登录上线后新增的恢复路径，**优先于**重新注册设备。

### 3.6 账号块（「我的服务器」左栏底部）

**不给账号开第四个一级入口。** activity bar 仍是 `客户端` / `节点组` / `我的服务器` 三个；账号块挂在「我的服务器」destination 的左栏底部，和「设置」同一条底栏。

#### 3.6.1 位置与结构

```
┌──────────────────────────┐
│ 我的服务器           3  +│  ← rail__section
│ ├ 东京 01      ● 已就绪   │
│ ├ 新加坡 02    ● 安装中   │  ← 列表独立滚动（.configs 区 overflow-y:auto）
│ ├ 法兰克福 03  ● 未测试   │
│                          │
│ ──────────────────────── │  ← .rail__foot，固定不滚（border-top: hair）
│ ○ 未登录          [登录] │  ← .rail__identity（摘要行，可点）
│ 设置                     │  ← .rail__settings
└──────────────────────────┘
```

登录后：

```
│ ──────────────────────── │
│ ● user@example.com    ⌃  │  ← .rail__identity：LED + 邮箱（12px --ink-3）
│   这台设备 · 已登录        │  ← 第二行 11px --ink-3（摘要行内）
│   登出                    │  ← 展开区（.btn--ghost），默认收起
│   已有配置和节点不受影响。   │
│ 设置                     │
```

- **固定**：`.rail__foot` 已经 `flex: none; margin-top: auto`；只给列表区加 `overflow-y: auto` 与 `min-height: 0`，账号块不随列表滚动。
- **视觉权重低于服务器列表**：摘要行沿用 `.rail__identity`（12px、`--ink-3`、透明底、无边框）；`登录` 用文字按钮 / `.btn--ghost`，**不用实心按钮**，不抢任何主按钮的位置。
- **复用现有样式与间距，不新造组件**：`.rail__foot` / `.rail__identity` / `.rail__settings` / `.led` / `.rail__empty-text` / `.btn--ghost`；不引入新色值、新字号档位。展开区只是 `.rail__foot` 内的一个条件块，不另做弹层。

#### 3.6.2 内容

| 项 | 登录后 | 未登录 |
|---|---|---|
| 主行 | 邮箱（`text-overflow: ellipsis`，`title` 给全量） | `未登录` |
| 次行 | `这台设备 · 已登录` | 无 |
| 展开区 | `登出` + 「已有配置和节点不受影响。」+ 预留「余额 / 到期」位置 | 只有 `登录` |
| 绝不显示 | token、密码、`device_secret`、`account_id` | 同左 |

- **余额 / 到期位置先留空**：口径已定为预付费余额，宽限规则见 §4.11；本轮**不渲染、不编字段**，整体 UI 重构时按 §4.11 的文案补。
- 数据只来自 `MyServerAccount`（§2.6），渲染账号块**不再额外打接口**。

#### 3.6.3 交互

- 点摘要行展开 / 收起二级内容；`aria-expanded`、`aria-controls` 指向展开区。
- `Esc` 或点账号块外部收起；焦点回到摘要行。
- 展开区里 `登出` 是唯一动作；点击后先给一句确认（「退出后这台设备不再属于该账户；已有配置和节点不受影响。」），确认才调 `my_server_logout`。
- 登出成功后摘要行变 `未登录`，服务器列表清空为未登录空态；**本地配置、节点、密码不动**。
- 未登录时摘要行右侧的 `登录` 与展开区不并存——未登录不展开，点整行直接弹登录。

#### 3.6.4 四种状态各一句话

| 态 | 摘要行 | 一句说明（次行或展开区） |
|---|---|---|
| 未登录 | `未登录` + `登录` | 「登录后可以买服务器、管理你的机器。」 |
| 登录中 | `正在登录…`（无按钮） | 「验证码已发出，去邮箱收 6 位数字。」 |
| 登录失败 | `登录没成功` + `重试` | 按三段式给原因：验证码错（带剩余次数）/ 已过期 / 太频繁 / 连不上 |
| 离线 | 邮箱 + `离线 · 上次同步 14:02` | 「暂时连不上服务器；已有配置和节点不受影响。」 |

- 状态切换用 `aria-live="polite"` 播报一次，不重复播报列表变化。
- 登录中/失败时**不清空**已缓存列表与已选服务器；只改摘要行。
- 账号块与服务器列表读取失败（`rail__error`）是两件事：列表错误在列表区显示，账号块只反映身份状态。

#### 3.6.5 不做

| 不做 | 原因 |
|---|---|
| 第四个 activity bar 图标 / 独立账号页 | 账号是服务器模块的附属状态，不是并列目的地 |
| 头像、昵称、多设备列表 | 本轮没有这些数据，不编 |
| 在账号块里放主按钮（购买 / 连接） | 主按钮只在控制台 hero |
| 显示 `account_id`、token、设备秘密 | 内部标识与凭据，不进界面 |

---

## 4. 支付（Dodo Payments）

### 4.1 收费模型：预付费余额（M1）

**M1 只做预付费余额，订阅不上线。**（2026-11-16 拍板；订阅代码保留，M2 给国际卡用户。）

**为什么不是订阅**（核实结论）：

| 支付方式 | 订阅 | 一次性付款 |
|---|---|---|
| 微信 | ❌ 不支持 | ✅ |
| 大陆支付宝 | ❌ 不在 Dodo 支持列表 | ❌ |
| 国际卡 | ✅ | ✅ |

国内用户想用微信，就只能走预付费：**先充值、再扣费**。

**定价与换汇**：

- 产品价与钱包一律 **USD**；充值时用户可能付 CNY，由 Dodo 自动换汇。
- 用户看到的 CNY 金额由 Dodo 收银台给出，**我们自己不算汇率、不存 CNY**。
- 我们按 USD 面额入账；换汇成本（约 2–4%）由我们承担，写进风险（§8）。
- 账本只记 USD 分，**任何地方都不出现浮点金额**。

**计费单位：天**（2026-11-16 拍板，三案中选 C）。

- **日价是配置里的唯一真源**：`PLAN_DAILY_PRICE_CENTS` 直接给「分/天」（`$6 档 → 20`）。**月价不是配置，是派生值**：`monthlyCents = dailyPriceCents × 30`，仅供界面展示。这样「月价必须被 30 整除」的约束在数据源头就不存在了（§5.2）。
- 余额按天扣，**就绪时**扣第 0 天，之后每天扣一天；连扣 30 天合计**正好等于展示的月价**（§4.6、§4.14）。
- **建机看 7 天余额，扣费仍按天**（2026-11-18 产品拍板）：三条口径要一起读——
  1. **按天扣费**：建机只扣第 0 天，之后每天扣一天；连续扣满 30 天正好等于展示的月价。
  2. **创建门槛**：`checkout` 要求余额 ≥ 日价 × 7（$6 档 `$1.40`、$9 档 `$2.10`、$18 档 `$4.20`），不够就 `insufficient_balance`，不扣钱、不建机。
  3. **销毁退未用整天**：已扣但还没用到的整天按日价退回余额；销毁当天已经用掉，不退。
  门槛**不是预扣**：`paid_until` 仍是 `created_at + 1d`，余额也不会先冻结 7 天。它只保证建出来的机器至少能按天跑一周，不会第二天就进宽限。余额刚好 7 天费用的用户正常用约 7 天，然后进入既有的 7 天宽限（§4.6 / §4.11）。
- **不按小时**：`$6/月 ÷ 720` 是 0.833 分/小时，不是整数分，每小时一笔整数分账记不出来；退一步用「每小时扣 0 分 / 1 分」的望远镜取整，账本和界面都会出现「这小时没扣钱」。而且账本量是按天的 24 倍、Cron 要从每天一次改成每 10 分钟一次分批跑。
- **改粒度不改变我们的成本**：DO 按秒计费、到月度封顶（约 672 小时）、**关机不停止计费，只有销毁才停**。粒度只决定「用户没用满一个月能不能少付」，不决定我们付多少。
- 代价写在明处：按天扣意味着**中途销毁要退还未用完的天数**（§4.6），按月扣则没有这个动作。选择退，是因为不退等于让只想试几天的用户白付一个月。

### 4.2 钱包与账本

- 账户余额：`accounts.balance_cents INTEGER`，单位 **USD 分**；永远非负。
- 账本：`wallet_ledger` 只追加、**从不更新**；只有 `server_day` 明细会被裁剪（§4.12），钱类流水永久保留。每行都能追溯：

| 字段 | 说明 |
|---|---|
| `kind` | `topup`（充值）/ `charge`（扣费）/ `adjustment`（人工调整，必须带备注）/ `snapshot`（月末余额结转，`amount_cents = 0`，见 §4.12） |
| `amount_cents` | 正数入账、负数扣费；`snapshot` 恒为 `0` |
| `balance_after_cents` | 这一笔之后的余额；`snapshot` 用它把当时余额定格 |
| `ref_type` / `ref_id` | `dodo_payment:<payment_id>`、`order:<order_id>`、`server_day:<server_id>:<bucket>`、`server_refund:<server_id>`、`snapshot:<account_id>:<YYYY-MM>`、`manual:<uuid>`；组合唯一（§4.7） |
| `note` | 人工调整原因；自动流水为空 |

**定序规则（所有「最新一条 / 最后一条 / 链式校验」都按它）**：

- 排序键是 **`(created_at, rowid)`**：`wallet_ledger` 是普通 rowid 表，`id TEXT PRIMARY KEY` 只是唯一索引，隐藏 `rowid` 可直接用来定序，不需要再加 `seq` 列。同一毫秒写入的多行靠 `rowid` 分出先后。
- **除 `snapshot` 之外，任何行都不得回填 `created_at`**。业务时间只能来自写入时刻；`snapshot` 是唯一例外（它的 `created_at` 就是 `cutoff`，见 §4.12）。
- 为什么这条要写死：I1「最新一条 `balance_after_cents`」、I2「cutoff 前最后一条余额」、I3「逐行链」全都依赖"顺序"，一旦有人为了补历史数据回填时间戳，三条断言会一起失真，而且不会报错。

**不变式**（三条，取代原来的「余额 == 全表 SUM」）：

| # | 断言 | 频次 |
|---|---|---|
| I1 | `accounts.balance_cents == 该账户最新一条 wallet_ledger.balance_after_cents` | 每天 |
| I2 | `balance_cents == snapshot.balance_after_cents + SUM(amount_cents) WHERE created_at > snapshot.created_at` | 每月 |
| I3 | 快照之后逐行链式：`balance_after_n == balance_after_{n-1} + amount_n` | 每天（保留窗口内） |

- 为什么不再断言 `balance == SUM(全表)`：裁剪之后全表已经不含被删的明细，这条会永久为假。**I1+I2+I3 合起来是同一件事的分段版本**——快照定格一个起点，之后每一笔都仍然可逐行验算（§4.12）。
- 余额不足不允许扣成负数：扣费语句永远带 `balance_cents >= ?` 守卫。
- **充值流水与扣费流水分开记**：不合并成一条「净额」；流水是账，余额是结果。

### 4.3 充值（Dodo 一次性产品）

- **固定面额**，一档一个产品：`$10 / $20 / $50 / $100`。**面额不单独配置**——可充值面额直接由 `DODO_TOPUP_PRODUCT_IDS` 的键（美分）推导，没配产品 ID 的档位不可充。与 TweetPilot 的 `token-10/20` 同一套路。
- 流程：

```
POST /v1/topups { denomination_cents: 2000 }
  └─ 校验面额 → POST /checkouts（一次性产品，metadata: account_id + topup_id）
       └─ 201 { topup_id, checkout_url, denomination_cents }

用户浏览器支付 → Dodo webhook payment.succeeded
  └─ 幂等 → wallet_ledger(+2000, ref = dodo_payment:<payment_id>) → topups.status = paid
```

- **入账金额按产品映射**，不按 webhook 里的金额：微信可能以 CNY 结算，`settlement_amount` 只用于审计。
- 重复 webhook / 重投：`payments.id` 与 `wallet_ledger(ref_type='dodo_payment')` 双重唯一，**不会重复加钱**。
- `payment.failed`：`topups.status = failed`，不入账；用户重新发起一笔（新 topup）。
- 非生产可用 `channel: "fake"` 直接入账，方便本地跑通；生产拒绝。

### 4.4 买服务器（确认下单不扣费，就绪后结算）

- 下单 `POST /orders`：`orders.amount_cents` 写**下单日的日价**快照（不是月价）；`orders.amount_usd` 是**同一个数的美元表示**（`20 分 → 0.20`）。两个字段永远是同一个量，差 100 倍就是 bug——历史上最容易在这里把月价写进去，导致 30 倍扣费。
- 结账 `POST /orders/{id}/checkout`：**确认下单、不扣钱**，不创建 Dodo 会话；返回 `MyServerOrder`（`state = "provisioning"`）。第 0 天在就绪后结算（§4.14）。

**流程（2.39.0 起）**：

```
checkout
  ├─ 订单必须是 pending_payment
  ├─ 订单已过期（expires_at < now）
  │    └─ 转 cancelled → 409 / order_expired（不留永远结不了账的死状态）
  ├─ 预检余额 ≥ 日价 × 7（建机门槛；不扣钱）
  ├─ 校验目录里的地区 × 档位（region ∈ plan.regions）
  │    └─ 不满足 → 409 PRECONDITION_FAILED / plan_unavailable_in_region
  ├─ 成功 → orders = provisioning（charge_mode = 'at_ready'）
  │         建服务器行：billing_state = 'pending'、billing_anchor_at = 0、
  │         paid_until = NULL → 建机
  └─ 幂等键 + 订单唯一：双击 / 重试只建一台
```

- **第 0 天的扣款在「就绪后」发生**（§4.14）：服务器建好、enroll 确认 sing-box 起成功后，才在同一个 D1 batch 里扣第 0 天并写 `orders.ready`。`paid_until` / `billing_anchor_at` / `daily_price_cents` 都在结算 batch 写，不在建行时写；结算前详情页显示「创建中，开通后开始计费」，不渲染 `paid_until`。
- 存量 `charge_mode = 'upfront'` 订单（部署前已在办的）仍按旧口径激活：checkout 时已扣过费，enroll 只做激活、不再扣。
- **余额不足是明确原因，不是异常**：界面显示「余额不足，还差 $X。」+ 去充值入口；不建机、不扣钱。门槛是 **7 天费用**（2026-11-18 由「够一天」提高）：`X = 日价 × 7 − 余额`。例：余额 `$0`、$9 档（`$0.30/天`）→「余额不足，还差 $2.10。」；余额 `$1.00` →「余额不足，还差 $1.10。」
- **前端预检同一公式**：建机向导在 `placeOrder` 前用目录的 `daily_price_cents × 7` 与钱包余额比较，不足就不下单、原地给同一句提示与「去充值」；Host / Worker 仍是最终裁判，前端预检只省掉一次注定失败的请求。金额取值按字段独立兜底：**优先 `details.shortfall_cents`**；缺它才用 `required_cents − 本地余额` 补算；两个都没有才退纯文案「余额不足。」（Host 把 `required_cents` / `shortfall_cents` / `min_days` 逐字段独立透出，不保证同时存在）。
- 充值后可以重新点结账（同一订单，新 `Idempotency-Key`），订单在 10 分钟内有效；过期后订单转 `cancelled`，用户重新下单。
- 价格在「下单 → 结账」之间变化 → `price_mismatch`，让用户重新确认，不按旧价扣。
- 订单状态不再有 `awaiting_payment` / `payment_failed` / `expired`：没有外部收银台可等，失败就是余额不足或订单过期。
- **日价就是配置里的那个数，没有第二种算法**：`PLAN_DAILY_PRICE_CENTS` 直接给分/天（§5.2）；若仍沿用 `PLAN_PRICES_USD`（月价），则必须满足 `月价分 % 30 == 0`，否则该档不可售（`invalid_plan`）。**不允许取整兜底**——那会让「连扣 30 天 == 月价」变成谎言。
- **`servers.monthly_usd` 只是展示月估**：`= daily_price_cents × 30 / 100`，不参与任何扣费计算。`servers.hourly_usd` 同理只用于与 DO 成本核对。
- **rebuild 是一次新的计费生命周期**：新建订单、新的 `order:<new_order_id>` 第 0 天在就绪后结算、`billing_anchor_at` 重置为新机结算时刻、`paid_until = anchor + 1d`、`daily_price_cents` 按当时价格重写。**不复用旧的 `order:<id>`**——否则唯一键会挡住第二次首日扣费，等于重建免费。

### 4.5 Webhook（只处理充值）

`POST /v1/webhooks/dodo`（公开端点，无 Bearer）。

| 项 | 规则 |
|---|---|
| 验签 | Standard Webhooks：`HMAC-SHA256(id.timestamp.body)`，secret 形如 `whsec_…`，常量时间比较 |
| 时间窗 | `webhook-timestamp` 与服务器时间差 **≤ 5 分钟** |
| 失败响应 | `401 {"error":"invalid_signature"}`，不返回细节 |
| 消费事件 | 只处理 `payment.succeeded` / `payment.failed`；**M1 不订阅任何 subscription 事件** |
| 匹配 | 优先 `metadata.topup_id`；缺失时用 `data.checkout_session_id` 查 `topups`；都匹配不上 → `unmatched_payments`、返回 200、告警 |
| 处理失败 | `500` 让 Dodo 重投；处理必须幂等 |
| 建机 | webhook **不建机**；建机只发生在 `my_server_checkout` 之后的建机流程里，第 0 天由 enroll 回调结算（§4.14） |

### 4.6 续费、宽限与到期

**Cron 每天扫一次（03:17 UTC）**，做四件事：按天扣费续期、补建掉队订单、对账、账本归档（§4.12）。`wrangler.jsonc` 的 `triggers.crons = ["17 3 * * *"]` 已配好（dev 已验证；prod 部署时一并生效）——没有这一段，`scheduled()` 永远不会触发。

**计费锚点与日序**

```
anchor = servers.billing_anchor_at      # 2.39.0 起 = settle_at（存量 upfront = created_at）；rebuild 时重置
day_ms = 86_400_000
n      = (paid_until - anchor) / day_ms # 已扣满的天数，从 0 开始
day    = servers.daily_price_cents      # 日价快照，建机时写死，整段生命周期不变
```

**每天扣多少：就是 `day`，一个常数。**

日价是配置里的真源（§5.2），所以不存在「月价除不尽」的问题：连扣 30 天 = `30 × day`，**正好等于界面展示的月价**。旧稿里的望远镜公式（`floor(P(n+1)/30) − floor(Pn/30)`）是为「只有月价、要反推每天」准备的，换成日价配置后不再需要。

```
# A. 逐日续费（每轮分页，一行失败不阻塞其它行）
cursor = billing_cursor.cursor                       # 上一轮处理到的最后一个 server_id
batch  = SELECT * FROM servers
         WHERE paid_until <= :now
           AND destroyed_at IS NULL
           AND provider_id IS NOT NULL
           AND billing_state <> 'expired'            # 已停用的等充值后恢复，不再逐日扫
           AND state IN ('booting','installing','verifying','healthy','active')
           AND id > :cursor
         ORDER BY id LIMIT 200                       # 每轮上限
if batch 为空: billing_cursor.cursor = ''            # 回到队首，下一轮从头扫
for each server in batch:
  try:
    charged = 0
    while paid_until <= now and charged < 30:
      bucket = paid_until                            # 这一天的起点
      原子扣费（ref = server_day:<server_id>:<bucket>，§4.7）
        ├─ 成功 / 已扣过（重跑）→ paid_until = bucket + 1d；charged += 1；continue
        └─ 余额不足              → break
    # 状态迁移：三段，顺序写死，后面的覆盖前面的
    if paid_until > now:                     billing_state = 'active'
    else if now >= paid_until + 7d:          billing_state = 'expired'
    else:                                    billing_state = 'past_due'
    # 覆盖规则：补满 30 天仍追不上，直接停用
    if charged >= 30 and paid_until <= now:  billing_state = 'expired'
    # 写回：单调守卫，bucket 在同一次读里拿到，避免并发把 paid_until 写回去
    UPDATE servers
       SET paid_until = MAX(paid_until, :newPaidUntil), billing_state = :state, updated_at = :now
     WHERE id = :serverId AND paid_until = :bucket
  catch: 记 failure + audit_log，继续下一台
billing_cursor.cursor = batch 最后一个 id

# B. 补建（订单已扣费但没服务器）
for each order with state='paid' and paid_at < now - 5min and no servers row:
  n_now      = floor((now - order.paid_at) / 1d)          # 空档天数：扣费那一刻算第 0 天
  paidUntil  = max(order.paid_at + 1d, order.paid_at + (n_now + 1) * 1d)
  INSERT OR IGNORE INTO servers (
    id, account_id, order_id, provider, name, region, plan,
    hourly_usd, monthly_usd, daily_price_cents,
    state, billing_state, node_port,
    billing_anchor_at, paid_until, created_at, updated_at
  ) VALUES (
    :serverId, :order.account_id, :order.id, 'digitalocean', :name, :order.region, :order.plan,
    :doHourlyUsd, :daily * 30 / 100, :daily,          -- monthly_usd 只作展示月估
    'creating', 'active', :port,
    :order.paid_at, :paidUntil,                       -- 锚点取已扣费那一刻，不取 now
    :order.paid_at, :now
  );
  if n_now > 0:
    audit_log('billing.gap_waived', { server_id: :serverId, days: n_now })
  provisionServer(...)

# C. 对账（§4.7）

# D. 归档（§4.12）：写月界快照（created_at = cutoff）→ 裁剪 created_at <= cutoff 的 server_day 明细
```

- **B 段的锚点必须是 `order.paid_at`**：第 0 天就是用户付钱那一刻买下的那一天。用 `now` 会在「扣费成功 → 补建」之间平白多算一段时间，而且 `order:<id>` 那笔扣费的流水时间对不上 `billing_anchor_at`，账实不符。`created_at` 同样取 `paid_at`。
- **补建晚于扣费时，中间空档按「已付到 `now` 那一格」写，但不补扣**：订单 `paid` 后隔 N 天才补建成功（Cron 停摆、建机连续失败后重试），用户只付过一次钱（`order:<id>`，第 0 天的日价）。这时把 `paid_until` 写成 `anchor + (n_now + 1)d`，让机器落进 `active` 而不是一建出来就 `past_due`——空档是我们没建出来造成的，不该让用户的机器一上线就显示欠费。空档天数记 `audit_log('billing.gap_waived', { days })`，不写 `server_day`、不扣余额。
  - 与 `max(anchor + 1d, …)` 取大：`n_now = 0`（同一格内补建）时两者相等，落点仍是第 0 天结束；`n_now ≥ 1` 时取到 `now` 那一格的末尾，下一轮 Cron 才继续正常逐日扣。
  - 这条与「销毁不补扣」（§4.6 末）同源：系统自己造成的缺口，不让用户买单，也不在账本里留看不出来源的欠账。
- **状态迁移只有三种结果，顺序固定**：`active` → 否则 `expired`（已过宽限）→ 否则 `past_due`。不要再写「charged == 0 才是 past_due」这类分支——补了部分天但仍没追上，同样是 `past_due`。
- **`paid_until` 只能前进**：`MAX(paid_until, :new)` + `WHERE paid_until = :bucket` 是两个方向的保护。前者防「并发写入把值改小」，后者防「两个执行者基于同一个 bucket 各写一次」。`bucket` 必须在**同一次读取**里拿到并用于 WHERE，不能先读、再在别处重算。
- **分页游标按 `id`，不按 `paid_until`**：余额不足的机器会一直满足 `paid_until <= now`，按 `paid_until` 排序会让它永远占队首，后面的机器饿死。
- **单轮 200 台、每台最多补 30 天**：Cloudflare 的 Cron 是短请求，一轮跑不完不追求跑完；下一轮从游标继续，最坏情况下所有机器在一个扫描周期内都会被看到。
- **一行失败不阻塞其它行**：单台抛错就记 `failure` + `audit_log` 跳到下一台，不能因为一台的异常让整批停摆。

- **只对真正存在的机器扣费**：`state = 'error'`、`provider_id` 为空、从未建出来的服务器**一律跳过**——这是「为一台从未创建的机器每天扣费」的直接防线。这类行交给「建机失败 → 销毁 / 重建」流程，不进计费；如果它们停在 `paid` 且没有服务器，由 B 段补建或失败处置接手。
- **一天一扣，账本一天一行**：一台机器每月 30 行，1000 台每月 3 万行。这是选按天而不按小时的直接原因（按小时是 72 万行 + 每小时一个跑批器）。
- **一次补到 `paid_until > now`，最多 30 天**：Cron 停摆几天后重新上线，要能把欠的天数一次补齐；超过 30 天仍补不到 now → 转 `expired` + 告警，**不再自动扣**。
- **同一台服务器同一天只能扣一次**：账本 ref 唯一，`bucket` 就是那一天的时间戳；Cron 重跑、并发执行都只会有第一笔成功（§4.7 的重跑语义）。
- **「第几天」由锚点决定，不由 UTC 零点决定**：13:50 建机，它的每一天就是 13:50 → 次日 13:50；Cron 在 03:17 跑只是把「已经到期的那一天」补上，不会把用户的日均切到半夜。所以**不存在跨零点该算哪一天的问题**。
- 余额不足后进入 **7 天宽限**：宽限期内充值 → 下一次 Cron（或充值成功后的即时重试）补扣并顺延，状态回 `active`。
- `now >= grace_end`：`billing_state = expired`，**只标记停用**；机器与本地凭据都不删。**从这一刻起欠费不再累积**——`paid_until` 冻结、不再写 `server_day`、也就不会再出现一天一笔的欠账。机器照旧在跑，云成本继续由我们承担（§8），但**账面不涨**。
- **expired 之后充值怎么恢复**（口径写死）：

  ```
  owed = floor((now - paid_until) / 1d)
  if owed <= 30:
    正常逐日补扣 owed 天 → paid_until > now → billing_state = 'active'
  else:
    # 冻结期间没有累积欠费，但「从 paid_until 到现在」可能跨过很久
    # 用户最多只付 30 天；跳到的位置必须仍落在锚点的整天网格上，否则日序 n 会变成小数
    n_now      = floor((now - anchor) / 1d)
    paid_until = anchor + max(0, n_now - 30 + 1) * 1d
    #           = 跳到「now 所在那一格的前一格」，再补 30 天正好落在 anchor+(n_now+1)d > now
    audit_log('grace_waived', { owed, waived: owed + 1 - 30 })
    再按上面的正常路径补 30 天 → paid_until = anchor + (n_now+1)d > now → 'active'
  ```

  - **`+1` 不能省**：写成 `anchor + (n_now - 30)d` 再补 30 天，落点是 `anchor + n_now·d`，而 `now ≥ anchor + n_now·d`，所以 `paid_until ≤ now` 恒成立——机器永远回不到 `active`。这条是实现期发现的差一天错误（2026-11-16 修正）。

  - **默认豁免，不阻塞恢复**：用户充够 30 天的钱就能立刻拿回机器。豁免天数记 `audit_log` 并告警，人工可以事后复核。
  - **要追缴就走人工**：需要补记的部分用 `manual` 类型的 `adjustment` 单独记一笔，有备注、有痕迹；系统不自动追。
  - **为什么这样定**：停机期间的账已经不涨了，再让用户背一笔「看不到明细的旧账」既解释不清也收不回来；30 天的上限正好等于一个完整计费周期，用户能自己算清楚。
- **订单 `paid` 但没有服务器**：Cron 每轮补建（B），否则用户付了钱却没机器；`unique(servers.order_id)` 保证不会补出第二台。
- 到期/宽限的判定基准是 `servers.paid_until`，不是事件到达时间。
- **不自动销毁任何实例**，Cron 只改状态、记账、补建。

**销毁时退还未用完的整天天数**（2026-11-16 拍板）

```
n_paid = (paid_until - anchor) / day_ms     # 已付到第几天
n_now  = floor((now - anchor) / day_ms)     # 当前在第几天（这一天已经用掉）
refundTotal = max(0, (n_paid - (n_now + 1))) * day      # 未开始的整天 × 日价
```

- **三条硬规则**：
  1. **「标记 destroyed」与「写退款」必须在同一个 `db.batch()` 里**。先标后钱或先钱后标，中间崩一次就会留下「已销毁没退钱」或「退了钱还能再退」。
  2. **写的是差额，不是总额**：`refunded = SUM(amount) WHERE ref_type='server_refund' AND ref_id LIKE '<server_id>:%'`，`delta = refundTotal - refunded`；**`delta <= 0` 一行不写**。
  3. **自动销毁也退**：enroll 超时、装机失败、建机失败这些由我们发起的销毁，同样按这个公式退第 0 天剩余部分。失败是我们造成的，不退等于让用户替我们的故障买单。
- **ref 用 `server_refund:<server_id>:<refundTotal>`**：后缀是「应退总额」而不是固定 `<server_id>`。这样同一台机器重试只写一次（唯一键挡住），而「算出来的总额变了」会得到一个不同的 ref，靠第 2 条的差额规则处理，**不会被唯一键误挡**。
- **不按秒退**：DO 侧最小计费 60 秒，我们的单位是天。当天（`n_now` 这一天）已经用掉，不退。
- **销毁不补扣**：如果 `paid_until < now`（有已过去但 Cron 还没扣的天），销毁时**不补扣**、也不追欠费。销毁是用户唯一能让我们停止付钱的出口，它必须永远可执行、不被余额或欠费阻塞。这条对应 W12-b。
- 退款进**余额**，不出金、不走 Dodo：这是店内额度，不是现金退款（§8）。

### 4.7 幂等、并发与对账

**三层幂等**

1. `webhook_events.id` = `webhook-id`：同一投递只处理一次。
2. 业务唯一键：`payments.id`（充值支付）、`wallet_ledger(ref_type, ref_id)`（每笔钱只记一次）。
3. 行级守卫：订单状态白名单、服务器 `paid_until` 单调前进。

**唯一的记账原语**：充值（`topup`）、扣费（`charge`）、人工调整（`adjustment`）三条路径**共用同一个 `applyLedgerEntry()`**，顺序固定为「先账本、后余额」；调用方只传金额与 ref，不允许自己写余额。

```sql
-- 1) 写账本：唯一键挡重复；负数（扣费 / 负向调整）带余额守卫；
--    balance_after 在同一个 SELECT 里算出，事务外不再读余额表
INSERT INTO wallet_ledger (id, account_id, kind, amount_cents, balance_after_cents,
                           ref_type, ref_id, note, created_at)
SELECT :newLedgerId, a.id, :kind, :amount, a.balance_cents + :amount,
       :refType, :refId, :note, :now
FROM accounts a
WHERE a.id = :accountId
  AND (:amount >= 0 OR a.balance_cents >= -:amount)
  AND NOT EXISTS (SELECT 1 FROM wallet_ledger w
                  WHERE w.ref_type = :refType AND w.ref_id = :refId);

-- 2) 动余额：用「新流水 id 已存在」作守卫，只有第 1 步成功才扣/加
UPDATE accounts SET balance_cents = balance_cents + :amount
WHERE id = :accountId
  AND EXISTS (SELECT 1 FROM wallet_ledger WHERE id = :newLedgerId);

-- 3) 服务器续期：账本行守卫 + 单调守卫（只对 charge 执行）
UPDATE servers
SET paid_until = MAX(paid_until, :newPaidUntil),
    billing_state = 'active',
    updated_at = :now
WHERE id = :serverId
  AND paid_until = :bucket            -- 只推进「当前这一格」，:bucket 必须来自同一次读取
  AND EXISTS (SELECT 1 FROM wallet_ledger
              WHERE ref_type = :refType AND ref_id = :refId);

-- 4) 订单状态：只在首次购买（有订单）时执行
UPDATE orders SET state = 'paid', paid_at = :now
WHERE id = :orderId AND state = 'pending_payment'
  AND EXISTS (SELECT 1 FROM wallet_ledger
              WHERE ref_type = :refType AND ref_id = :refId);
```

**四句同批**，放在一个 `db.batch()` 里（D1 batch 的事务性**待核** §9；不成立就改用 DO 串行化或单条 `INSERT … SELECT`）。**绝不先扣余额再写账本**。

**重跑语义**（Cron 重跑、webhook 重投、双击都按这套读结果）：

| 第 2 步（扣余额） | 第 3 步（续期） | 结论 |
|---|---|---|
| 0 | 1 | **已扣过**：账本行早已存在，按已扣恢复（续期照做、不重复扣钱） |
| 1 | 1 | 本次扣费成功 |
| 0 | 0 | 余额不足（账本没写），进宽限 |
| 1 | 0 | 钱扣了但服务没续上（服务器已删等）：告警 + 写一条反向 `adjustment`，人工核对 |

- **`ref_id` 规则**：充值 `dodo_payment:<payment_id>`；首次购买 `order:<order_id>`（rebuild 用新订单 id）；每日续费 `server_day:<server_id>:<bucket>`（`bucket` = 那一天起点的毫秒时间戳，天然单调）；销毁退款 `server_refund:<server_id>:<refundTotal>`（后缀是应退总额，见 §4.6）；人工调整 `manual:<uuid>`（用 uuid，避免撞唯一键）。
- **一台机器同一天只有一个 `bucket`**：`bucket` 由 `paid_until` 推导而不是取 `now`，所以 Cron 在什么时候跑、跑几次，同一笔扣费都落在同一个唯一键上。
- **`adjustment` 可以为负**，但同样走上面的余额守卫，不允许扣成负数。
- 接口返回与后续判断都用**账本里写入的 `balance_after_cents`**（按 `newLedgerId` 读一行），不要在事务外再读一次 `accounts.balance_cents`——两次读之间可能又有一笔。

**对账自检**

按天扣费 + 30 天明细裁剪（§4.12）之后，`balance == SUM(全表)` 不再是可用的断言，改成分段版本：

- **每天 Cron**：
  1. **I1** 逐账户：`balance_cents == 该账户最新一条 wallet_ledger 的 balance_after_cents`（走 `wallet_ledger_account(account_id, created_at)` 索引，取一行）；
  2. **I3** 近 30 天窗口逐行链式：`balance_after_n == balance_after_{n-1} + amount_n`；
  3. 每一笔 `ref_type='server_day'` 的 `ref_id` 能拆出 `server_id` 与 `bucket`，且该服务器存在、`bucket` 是锚点 + 整数天（**只查保留期内的行**）。
- **每月一次（跨月那一刻）**：
  1. 写界尾快照（`kind='snapshot'`、`created_at = cutoff`、`ref_id='<account_id>:<YYYY-MM>'`，§4.12）；
  2. **I2** `balance_cents == snapshot.balance_after_cents + SUM(amount_cents WHERE created_at > snapshot.created_at)`；
  3. 每笔 `topup` 能对上 `payments.id`；每笔 `server_refund` 每台服务器最多一条——**这两类永久保留，所以可以全期核对**。
- 为什么日常不做全量 `SUM`：1000 台每月 3 万行，逐账户全量求和会把「每天一次」变成「每天一次全表扫」；而最新一条 `balance_after_cents` 是同一件事的 O(1) 版本——账本只追加，最后一条就是当前余额。
- **充值是永久流水**，所以「钱进来的总额」永远可以跟 Dodo 结算单算平；被裁掉的只是内部按天的扣费明细。
- 验收里把 I1 / I2 / I3 三条都做成测试（§7 W8、W13）。



### 4.8 商户与产品归属（2026-11-15 拍板）

**Veyl 与 TweetPilot 共用同一个 Dodo 商户账号**，不单开。

| 项 | 共用 | 必须独立 |
|---|---|---|
| 商户账号 / 结算主体 / 收款账户 | ✅ 同一个 | — |
| `DODO_API_KEY` | 视后台能力 | **优先给 Veyl 单开一把**（见 §5.1）；不支持再共用 |
| 产品（product） | ❌ | **必须是 Veyl 自己的**：同一后台新建，test / live 各一套；代码按 `ENVIRONMENT` 切表 |
| Webhook 端点 | ❌ | Veyl 自己的路径 `/v1/webhooks/dodo`，自己的 `DODO_WEBHOOK_SECRET` |
| 回跳页 | ❌ | Veyl 自己的 `APP_PAYMENT_RETURN_URL` |

- **不抄 TweetPilot 的 `pdt_…`**：参考实现里的产品 ID 属于另一个产品线，价格、结算币种、退款口径都不同。设计稿与代码里都不出现它们的值。
- 同一商户下两个项目各自配置 webhook secret：轮换 Veyl 的 secret 不影响 TweetPilot，反之亦然。
- 账单与结算在同一个商户后台，**对账时按 product_id 区分项目**；`topups.product_id` 记录渠道产品，账本只记 USD 面额。
- 共用商户的风险写清楚：Dodo 后台的权限是商户级的，任何能改商户设置的人都能看到两个项目的交易；这是运营层面的接受项，不在客户端设计里解决。

### 4.9 新增表与列（迁移 `0003_wallet.sql`）

```sql
-- 验证码：只存哈希；一个邮箱同时只有一条
CREATE TABLE email_codes (
  email      TEXT PRIMARY KEY,
  code_hash  TEXT NOT NULL,      -- sha256(code + ":" + email)
  expires_at INTEGER NOT NULL,
  attempts   INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  last_ip    TEXT
);

-- 充值单：一次充值一条；用于把 Dodo 会话 / 支付对上账户
CREATE TABLE topups (
  id                  TEXT PRIMARY KEY,   -- top_...
  account_id          TEXT NOT NULL,
  denomination_cents  INTEGER NOT NULL,   -- 1000 / 2000 / 5000 / 10000
  product_id          TEXT NOT NULL,      -- Dodo pdt_…，对账用
  status              TEXT NOT NULL,      -- pending | paid | failed | expired
  checkout_session_id TEXT,
  payment_id          TEXT,
  created_at          INTEGER NOT NULL,
  paid_at             INTEGER
);
CREATE UNIQUE INDEX topups_session ON topups(checkout_session_id);
CREATE UNIQUE INDEX topups_payment ON topups(payment_id) WHERE payment_id IS NOT NULL;

-- 钱包账本：只追加，不更新不删除；每笔钱只记一次
CREATE TABLE wallet_ledger (
  id                  TEXT PRIMARY KEY,
  account_id          TEXT NOT NULL,
  kind                TEXT NOT NULL,      -- topup | charge | adjustment | snapshot（snapshot 的 amount 恒为 0）
  amount_cents        INTEGER NOT NULL,   -- 正数入账、负数扣费
  balance_after_cents INTEGER NOT NULL,
  ref_type            TEXT NOT NULL,      -- dodo_payment | order | server_day | server_refund | snapshot | manual
  ref_id              TEXT NOT NULL,
  note                TEXT,
  created_at          INTEGER NOT NULL
);
CREATE UNIQUE INDEX wallet_ledger_ref ON wallet_ledger(ref_type, ref_id);
CREATE INDEX wallet_ledger_account ON wallet_ledger(account_id, created_at);
-- 裁剪专用（§4.12）：只索引会被删的那一类，DELETE 走它，不影响其它流水
CREATE INDEX wallet_ledger_prune ON wallet_ledger(created_at) WHERE ref_type = 'server_day';

-- 渠道支付流水：Dodo 的事实，与我们的记账分开
CREATE TABLE payments (
  id                  TEXT PRIMARY KEY,   -- Dodo payment id
  topup_id            TEXT,
  account_id          TEXT,
  amount_cents        INTEGER NOT NULL,   -- 按产品面额（USD 分）
  settlement_amount   INTEGER,            -- Dodo 原值（可能是 CNY 分），仅审计
  settlement_currency TEXT,
  status              TEXT NOT NULL,      -- succeeded | failed
  raw_digest          TEXT NOT NULL,
  received_at         INTEGER NOT NULL
);

-- webhook 事件：webhook-id 去重
CREATE TABLE webhook_events (
  id            TEXT PRIMARY KEY,
  kind          TEXT NOT NULL,     -- payment.succeeded | payment.failed | ignored
  received_at   INTEGER NOT NULL,
  processed_at  INTEGER,
  topup_id      TEXT,
  payment_id    TEXT,
  status        TEXT NOT NULL      -- received | processed | failed
);

-- 匹配不上的支付：返回 200，留证据等人工重放
CREATE TABLE unmatched_payments (
  payment_id     TEXT PRIMARY KEY,
  email_hash     TEXT,
  amount_cents   INTEGER,
  currency       TEXT,
  reason         TEXT NOT NULL,    -- no_metadata | unknown_topup | account_mismatch
  payload_hash   TEXT NOT NULL,
  received_at    INTEGER NOT NULL,
  replayed_at    INTEGER
);

ALTER TABLE accounts ADD COLUMN balance_cents INTEGER NOT NULL DEFAULT 0;

-- 没有真实用户：orders / servers 直接重建，新列一律 NOT NULL，避免 NULL 被当 0 免费建机
-- orders.amount_cents        INTEGER NOT NULL   -- 下单日的日价快照（USD 分），迁移时从 amount_usd 回填
-- orders.charge_ledger_id    TEXT               -- 扣费流水
-- servers.billing_anchor_at  INTEGER NOT NULL   -- 计费锚点（ms）：2.39.0 起 = settle_at（存量 upfront = created_at），一写定终身
-- servers.paid_until         INTEGER NULL       -- 已付到哪个时刻（ms）；结算时写 settle_at + 1d，结算前为 NULL
-- servers.daily_price_cents  INTEGER NOT NULL   -- 下单时**日价**快照（USD 分/天，来自 PLAN_DAILY_PRICE_CENTS），Cron 每天扣它
-- servers.billing_state      TEXT NOT NULL      -- active | pending | past_due | expired
CREATE UNIQUE INDEX servers_order ON servers(order_id);
```

- **`plan_price_cents`（月价快照）改名为 `daily_price_cents`（日价快照）**，并新增 `billing_anchor_at`。2.39.0 起这两列与 `paid_until` 在**结算那一句**写入（结算前 `billing_anchor_at = 0`、`paid_until = NULL`、`billing_state = 'pending'`）；存量 upfront 行仍在建行时写。缺任何一列都会让 §4.6 的日序算错或永久免单。
- `wallet_ledger.ref_type` 取值扩成 `dodo_payment | order | server_day | server_refund | manual`；列注释同步。
- `accounts.balance_cents` 的非负性靠应用层守卫（`balance_cents >= ?`）+ 每日对账；SQLite 的 `ALTER TABLE` 加不了 `CHECK`。
- `orders.amount_usd` 退役：新代码只用 `amount_cents`，且该列 **NOT NULL**；迁移时从 `amount_usd × 100` 回填（没有真实用户时直接重建为空表也可以）。
- `servers_order` 唯一索引保证一个订单最多一台机器；`rebuild` 接入时用新订单或先删旧行。
- **`snapshot` 用 `amount_cents = 0`**：它只改「对账起点」，不改余额。如果给它塞一个真实金额，I2 会重复计算。
- `wallet_ledger_prune` 是**部分索引**（`WHERE ref_type = 'server_day'`），只服务 §4.12 的裁剪，别拿它当常规查询索引。
- 表间不做外键（D1 不强制），靠应用层校验。

### 4.10 订阅方案（M2，代码保留）

订阅代码（12 个事件、`subscriptions` 表、托管 Portal、期末/立即失效判定）**保留在仓库里，但 M1 不启用**：不建 `subscriptions` 表、不订阅 subscription 事件、结账不创建订阅会话。M2 面向国际卡用户启用时，按本文历史版本（2026-11-15 订阅稿）恢复即可，钱包与订阅共用 `payments` 与账本，互不冲突。


### 4.11 到期、取消与 7 天宽限

见 §4.6：由每日 Cron 按 `servers.paid_until` 逐日扣费续期，扣不动进 7 天宽限，宽限结束只标记 `expired`，不删机器与凭据。**`paid_until` 是「已付到哪个时刻」，单位是天，不是月。**

| 时刻 | 状态 | 界面一句话 |
|---|---|---|
| `now < paid_until` | `active` | 详情显示「每天 $0.20 · **本期有效至** 11-17 13:50」 |
| `paid_until ≤ now`，且当天 Cron 还没跑到（`billing_state` 仍是 `active`） | `active` | 「每天 $0.20 · 本期已到期，下一轮扣费顺延」——**不显示那个已经过去的时间点** |
| `paid_until ≤ now` 且已扣不动 | `past_due` | 「余额不足，今天这次没扣上。7 天内充值可继续使用（还剩 N 天）。」 |
| `now ≥ paid_until + 7d` | `expired` | 「余额不足，服务已停用。服务器还在，**停机期间不再产生费用**；充值后最多补 30 天即可恢复。」 |

- **文案定稿：用「本期有效至」，不用「已付至」，也不用「下次扣费：…」**（2026-11-16 定）。
  - 「已付至」是过去时的记账口吻，用户读成「到这个点就停」，可机器其实还在跑；「本期有效至」说的是覆盖区间，语义对得上 `paid_until` 的定义。
  - 「下次扣费：<时间>」不采用：扣费发生在每日 Cron（03:17 UTC）而不是 `paid_until` 那一刻，报一个具体时刻等于给用户一个不准的承诺，而用户真正想知道的只是「会不会停」。所以第二行只写「本期已到期，下一轮扣费顺延」——**状态是「还正常」，不是「欠费」**，欠费的措辞留给 `past_due`。
  - 这个窗口最长 24 小时（Cron 每天一次），是瞬时态，不应被渲染成异常色；机器照常可用，`billing_state` 仍是 `active`。

- **「停机期间不产生费用」是实话，必须这么说**：expired 之后 `paid_until` 冻结、不再写 `server_day`（§4.6），所以用户看到的余额会一直停在那一刻，不会越拖越少。这条文案是消除「我不敢离开，怕一直扣钱」的直接手段。
- **恢复口径要在界面上说清**：`expired` 之后充值，抵扣的是「从停用到现在」最多 30 天，超出部分系统默认豁免；用户只需保证余额够 30 天的日价。**具体剩余天数用 `MyServer` 的 `paid_until` 与 `daily_price_cents` 现算，不在文案里写死数字。**
- 「服务已停用」目前只是状态标记（隧道凭据在本地，切不断）；等 M2 真停用上线后，这句文案才有对应的实际效果。

**状态迁移（与 §4.6 的三段判定同源，顺序不可换）**

| 从 | 条件 | 到 |
|---|---|---|
| `active` | `paid_until ≤ now < paid_until + 7d` | `past_due` |
| `active` / `past_due` | `now ≥ paid_until + 7d` | `expired` |
| `active` / `past_due` | 单轮补满 30 天仍 `paid_until ≤ now` | `expired` |
| `past_due` / `expired` | 充值后补扣成功、`paid_until > now` | `active` |

- **`expired` 只有一个出口：充值后补扣成功**。它不参与每日续费扫描（§4.6 的 `billing_state <> 'expired'`），所以「停机期间不再产生费用」是结构上成立的，不是靠文案。
- **`expired` 不会再回到 `past_due`**：欠费已经封顶 30 天，不存在「又欠了一点」的中间态。

- **账户块只显示余额**：`余额 $9.87`。**不显示「约可运行 N 天」**——多台机器、不同套餐时，「余额 ÷ 各机器日价合计」是个把不同消耗混在一起的聚合数，看着像能撑很久，实际任一单台都撑不到那么久；用户据此做的判断是错的。这是 2026-11-16 用户拍板撤掉的（曾设计过 `MyServerWallet.runway_days`，已从契约与各层删除，不留隐藏字段）。
- **核对到期只看机器详情**：`每天 $X · 本期有效至 …` 是每台机器自己的账，本来就按机器分开，不存在聚合误导。
- **账户块的三种话术**（欠费天数由 `paid_until` 现算，不写死）：
  | 状态 | 账户块 |
  |---|---|
  | `active` | `余额 $9.87` |
  | `past_due` | `余额不足 · 还欠 N 天 × $0.30/天，充值后自动补扣` |
  | `expired` | `已停用 · 需补 N 天 × $0.30/天（最多 30 天），充值后自动补扣` |

  - **`past_due` 的 N 是真实欠的天数**（`ceil((now - paid_until)/1d)`），因为这段还在宽限、账还在涨。
  - **`expired` 的 N 要封顶 30**：账已冻结，用户最多付 30 天就能恢复（§4.6）。写成「还欠 45 天」会误导——那 15 天系统不会再收。
  - 两种状态都**必须同时给「× 单价」和「充值后自动补扣」**：只写「还欠 N 天」用户不知道自己差多少钱，只写「余额不足」用户不知道补多少。
- 「停用」本期只做状态标记，不做真停用（节点凭据在本地，控制面无法即时切断）；M2 用短期凭据或 `veyl-agent` 指令实现。
- **成本风险**：宽限期与失效后机器继续计费（约 $6–18/月/台，售价档），由我们承担。
- **取消 = 销毁**：本期没有「取消下期」这种概念（那是订阅的语义）。不想用了就销毁，未用完的整天按 §4.6 退回余额。

### 4.12 账本保留期：30 天明细 + 月度快照（2026-11-16 拍板）

**需求**：每台机器只保留最近 30 天的扣款明细。**直接删旧行会破坏「余额 = 账本合计」**，所以删之前必须先结账。落地口径是「`cutoff` = **上上个月末**（UTC 当月 1 日 00:00 往回推到上上个月的最后一天 24:00，即 `<本月1日> − 2 个月`），实际保留 **31–60 天**——理由见下。

**只裁剪一种流水**：`ref_type = 'server_day'`。其余全部永久保留，因为它们是真钱或人工介入的痕迹：

| ref_type | 保留 | 理由 |
|---|---|---|
| `server_day` | **31–60 天**（`cutoff` = 上上个月末） | 唯一的量（一台机器每月 30 行）；明细过期即可，金额已被快照承接 |
| `order` / `server_refund` | 永久 | 每台机器 1–2 行，量可忽略；涉及真实收付 |
| `dodo_payment` | 永久 | 充值是真钱，必须能与 `payments` 全期对账 |
| `manual` | 永久 | 人工调整要留痕 |
| `snapshot` | 永久（只对有流水要删的账户写，量极小） | 每个账户每月最多 1 行 |

**快照记的是「边界那一刻的余额」，不是「现在的余额」**——这是这个设计的关键。拿当前余额当起点，被删的是快照之前的行，`SUM(created_at > 快照)` 就永远少一段。

**快照集合必须与删除集合完全相同**，否则会出现「有明细没快照」（余额无依据）或「有快照没明细要删」（白写一行）：

```sql
-- 1) 这一轮要处理的账户 = 存在过期明细的账户。快照与删除都只针对这个集合。
accountsToPrune = SELECT DISTINCT account_id
                  FROM wallet_ledger
                  WHERE ref_type = 'server_day' AND created_at <= :cutoff

-- 2) 逐账户写快照。唯一键兜底：同一个月重复跑只留一行，OR IGNORE 不报错。
INSERT OR IGNORE INTO wallet_ledger
  (id, account_id, kind, amount_cents, balance_after_cents, ref_type, ref_id, note, created_at)
SELECT :newId, :accountId, 'snapshot', 0,
       COALESCE((SELECT w.balance_after_cents FROM wallet_ledger w
                  WHERE w.account_id = :accountId AND w.created_at <= :cutoff
                  ORDER BY w.created_at DESC, w.rowid DESC LIMIT 1), 0),
       'snapshot', :'<accountId>:<YYYY-MM>', NULL, :cutoff;

-- 3) 删除：只删该账户 `created_at <= cutoff` 的 server_day，分片 5000
DELETE FROM wallet_ledger
WHERE id IN (
  SELECT id FROM wallet_ledger
  WHERE ref_type = 'server_day'
    AND account_id = :accountId
    AND created_at <= :cutoff
  LIMIT 5000
);
-- 读 meta.changes：等于 5000 就再来一轮，小于 5000 说明这个账户清完了
```

- `amount_cents = 0`：快照**不改变余额**，只把「对账起点」往前挪一段。
- `created_at = cutoff`（**不是插入时间**）：这是全表唯一允许回填时间的行（§4.2）；有了它，I2 可以直接写成 `created_at > snapshot.created_at`，不用再加一列。
- `ref_id = '<account_id>:<YYYY-MM>'`：同一个月只有一条，`(ref_type, ref_id)` 唯一索引让重跑天然幂等。
- **快照存在是删除的前提**：第 3 步只在第 2 步成功后才执行；第 2 步失败就跳过这个账户，绝不删。
- **只为 `accountsToPrune` 里的账户写**。闲置账户不写——否则快照行数会随「账户数 × 月数」增长，反而比被裁掉的明细还多。
- 截止余额取 `(created_at DESC, rowid DESC)` 的第一条（§4.2 的定序规则），不要只用 `created_at`。

**裁剪语句为什么长这样**：

- SQLite 的 `DELETE ... LIMIT` 需要编译开关 `SQLITE_ENABLE_UPDATE_DELETE_LIMIT`，**D1 不保证开启**，所以用 `id IN (SELECT ... LIMIT)` 分片，任何 SQLite 都能跑。
- `LIMIT` 必须放在子查询里；`DELETE ... LIMIT` 这种写法不要用。
- **用 `meta.changes` 判断是否继续**：等于 5000 说明还有，再来一轮；小于 5000 说明这个账户清完了。不要假设「一条 DELETE 会把该删的全删掉」。
- 一条 `DELETE` 只清一个账户的一片（≤5000 行）；账号多、明细多的时候，一轮 D 段最多处理若干账户，剩下的下一轮继续。
- **先写快照、再删明细**。快照写失败就这个账户这一轮不删——宁可多留，不能留下无依据的余额。
- 只删 `<= cutoff`：快照之后的每一行都留着，所以 I2 的 `SUM(created_at > snapshot.created_at)` 始终成立，I3 的链也完整。
- 因此**实际保留 31–60 天**：`cutoff` 取上上个月末，最老的一行至少 31 天、最多 60 天。不是严格的 30×24 小时——要严格 30 天就得每天写一条快照，快照量与被删明细同量级，不值得；也没有人会拿「第 31 天前某一天扣了几毛」来对账。
- 幂等：同一条件重跑第二次删 0 行。

**跑在哪个任务**：并入**每日 Cron** 的 D 段（§4.6 的 C 段对账之后），不单独开 trigger。

- Cloudflare 的 Cron 是「短请求 + 定时触发」，为一件绝大多数天是空操作的事多开一个频率不值得；现有 `17 3 * * *` 一天一次足够。
- 每天跑的成本：一次「本月快照是否已存在」的查（走唯一索引）+ 一条 `DELETE`（通常 0 行）。跨月那天才真正写一批快照、删一批明细。
- 一轮 D 段同样受执行时间约束：处理完若干账户就停，剩下的下一轮继续。

**删完之后怎么证明余额是对的**

| 层 | 证据 |
|---|---|
| 余额本身 | I1：`balance_cents == 最新一条 balance_after_cents`——最新一行永远没被删 |
| 分段结转 | I2：`balance == snapshot.balance_after + 快照之后所有金额之和` |
| 逐行可验 | I3：快照之后每一行都能用「前行 + 本行」验算，30 天窗口内可逐笔复查 |
| 对外对账 | `payments` / `topups` / `dodo_payment` 永久保留，随时能与 Dodo 结算单全期核对 |

- **销毁退款不依赖历史明细**：退款金额从 `paid_until` 与 `daily_price_cents` 现算（§4.6），不查账本；所以裁剪不会算错退款。
- 裁剪掉的是「已经被快照承接的明细」，不是「钱的去向」——每一笔钱都仍然能从快照 + 之后的行 + `payments` 推出来。

**最终保留多少行 / D1 成本**

| 项 | 1000 台规模 |
|---|---|
| 不裁剪 | 30k 行/月 → **360k 行/年**，5 年 180 万行（约 320MB） |
| 裁剪后 | **常驻 3–6 万行**（31–60 天 × 1000 台）+ 每月每活跃账户 1 条快照 + 少量钱类流水；**不随年限增长** |
| D1 写入配额 | 30k/月，占付费档 50M 行的 **0.06%** |
| D1 存储 | 付费档含 5GB；单库上限 10GB。裁剪前后都远未逼近 |

**结论：D1 没有成本压力，裁剪不是为了省容量。** 不裁剪的话 5 年也只有 320MB，连 5GB 的零头都不到。做保留期是**数据最小化**的诉求（少存个人相关的计费明细），代价只是多一个 `kind` 和一条 `DELETE`。如果哪一天觉得不值得，**把 D 段关掉即可**——快照留着无害，I1/I2/I3 依然成立。

### 4.13 建机门槛 7 天余额：落地清单（2026-11-18 拍板）

口径见 §4.1 / §4.4：余额 ≥ 日价 × 7 才允许建机；`checkout` 只做预检、不扣费，结算在建机就绪后（§4.14）。命令契约见 `commands.md` §7.18（2.39.0）。

| 侧 | 改哪里 | 做什么 |
|---|---|---|
| 控制面 | `src/orders.ts` 的 `checkout` | 余额判断 `available < row.amount_cents * 7`，不足时 `details` 带 `required_cents: row.amount_cents * 7`、`shortfall_cents: required − available`、`min_days: 7`；**checkout 不写账本**，只把订单置 `provisioning` 并建 `billing_state='pending'` 的服务器行；结算守卫在 §4.14 里只卡 1× |
| 控制面 | `src/billing.ts` | 不改：逐日 Cron 仍只扣 1 天，门槛只在建机时生效 |
| Rust Host | `src-tauri/src/control_plane/error.rs` | 从上游 `details` 额外透传 `required_cents`（i64）与 `min_days`（u64），与 `shortfall_cents` 同批；不吞不改 |
| React UI | `src/components/MyServerWizard.tsx` 的 `placeOrder` | 预检从 `daily_price_cents − balance > 0` 改为 `daily_price_cents * 7 − balance > 0`；提示文案不变，`shortfallCents` 继续驱动既有的「去充值」按钮；**错误回读按字段独立兜底**：优先 `details.shortfall_cents`，缺它才用 `required_cents − 本地余额` 补算，两个都没有才退纯文案「余额不足。」 |
| 旧文案 | `src-tauri/src/agent/commands.rs:350`、`src/agent/bridge.ts:827` | 注释里的「扣一个月」是 2.28.0 之前的旧话，改成「扣 1 天（门槛 7 天费用）」；注释不改用户可见，但会被下一个人当依据 |

**界面文案与示例**（产品负责人拍板原文：`余额不足，还差 $X。`）

| 余额 | 档位 | 结果 |
|---|---|---|
| `$0` | $9 档（`$0.30/天`） | `余额不足，还差 $2.10。` |
| `$1.00` | $18 档（`$0.60/天`） | `余额不足，还差 $3.20。` |
| `$5.00` | $6 档（`$0.20/天`） | 允许建机；扣 1 天后余额 `$4.80` |

**不做**：不把门槛写成「预扣 7 天」；不在界面显示「余额可运行 N 天」（§4.11 已撤）；不给逐日 Cron 加门槛。

### 4.14 就绪后扣款（2026-11-18 拍板；契约 2.39.0，**已实现并上线**）

> **现行口径**：迁移 `0007_at_ready_settlement` 已应用于 dev 与 prod，Worker 已部署。`src/orders.ts` 的 `checkout`、`src/servers.ts` 的 `settleOrder` / `failSettlement` / `sweepUnsettledSettlements`、`src/billing.ts` 的扫描与补建都按本节实现。

**规则：服务器建好、并且 enroll 确认 sing-box 起成功之后，才扣第一天。失败不再「先扣后退」。**

**状态机**

```
pending_payment ──checkout──▶ provisioning ──enroll + 结算──▶ ready
                                   │
                                   └─ 结算失败 → failed（服务器行 error / settle_insufficient）
```

- `ready` 只由结算 batch 写；它的定义是「已就绪且已扣首日」，**不新增 `ready_unpaid`**。
- `provisioning` 期间界面只显示建机进度；计费行显示「创建中，开通后开始计费」。

**结算批（enroll 回调）**

1. `recordLedgerEntry`：`kind = 'charge'`、`amountCents = -日价`、`refType = 'order'`、`refId = <order_id>`，守卫 `balance_cents >= 1× 日价`。
2. followUps **全部带 `EXISTS(ledger id)`**：
   - `UPDATE orders SET state = 'ready', paid_at = ?, paid_via = 'wallet' WHERE id = ? AND EXISTS (...)`
   - `UPDATE servers SET state = 'active', billing_state = 'active', daily_price_cents = ?, billing_anchor_at = ?, paid_until = ? WHERE id = ? AND EXISTS (...)`
   - 审计 `settle.ok`。
3. 结算前 `servers` 行：`billing_state = 'pending'`、`billing_anchor_at = 0`、`paid_until = NULL`。

**结算失败（就绪时余额不足）**

- 守卫失败返回 `ok:false`，**不是「batch 写 0 行」**；调用方显式 catch：
  - 调 DO 销毁实例；
  - `servers.state = 'error'`、`failure_code = 'settle_insufficient'`，**不写 `destroyed_at`**（列表保留错误行，用户能看到为什么）；
  - `orders.state = 'failed'`；
  - 审计 `settle_insufficient`，用来量真实频率。
- 文案：「没开通，本次没有扣费」+ 去充值 / 重新下单；不自动重开。
- Cron 兜底：`provisioning` + `enrollment_used_at` 非空 + 无 charge 流水 + 超过 10 分钟 → 同一处置（`sweepUnsettledSettlements`，排在 enrollment 超时清理之前），防 Worker 中途死掉留下永久 booting。

**门槛与预留**

- 7 天门槛只在 `checkout` 预检；**结算只卡 1 天**。
- 不预留。并发下先到先得；先看 `settle_insufficient` 审计的真实频率，再决定是否加冻结。

**新旧口径**

- `orders.charge_mode = 'upfront' | 'at_ready'`（新编号迁移，默认 `upfront`）。Cron 的补建与退款扫描只处理 `upfront`；`paid_via` 只在结算 batch 写。**不要用 `paid_at` 判断口径。**
- 建机失败自动退款只服务部署前的存量 `upfront` 订单；退款前必须确认存在 `kind = 'charge'` 流水，否则跳过并记 `refund_skipped_no_charge`。销毁退未用整天保留。

**计费锚点**

- `billing_anchor_at = settle_at`、`paid_until = settle_at + 1d`；逐日 Cron 从结算时刻起算。存量行不变。
- `billing_state = 'pending'` 或 `paid_until = null` 不得渲染成「本期有效至」或 1970 日期。

**契约**

`commands.md` 2.39.0：`my_server_checkout` 返回 `MyServerOrder`（不扣费）；`MyServerCharge` 不再由命令返回；`MyServer.paid_until` 为 `string | null`；`billing_state` 含 `"pending"`；结算失败经 `MyServerOrder.failure.code = "settle_insufficient"` 告知；events 不变。


---

## 5. Secrets 与配置

### 5.1 Worker Secrets（每个环境单独 `wrangler secret put`）

| 名字 | 用途 | 谁能读 |
|---|---|---|
| `RESEND_API_KEY` | 发验证码邮件 | Worker 运行时 |
| `RESEND_FROM_EMAIL` | 发件人（如 `Veyl <no-reply@dessage.xyz>`） | Worker |
| `DODO_API_KEY` | 创建充值 checkout session。**同一个 Dodo 商户账号**（与 TweetPilot 共用结算主体）；优先给 Veyl 单开一把，见下方说明 | Worker |
| `DODO_WEBHOOK_SECRET` | webhook 验签（`whsec_…`） | Worker |
| `TOKEN_SIGNING_JWK` | 现有 Ed25519 签名密钥 | Worker |

**`DODO_API_KEY` 的单开与共用**（2026-11-15 拍板：同一个商户，不单开账号）：

- **能单开就单开**：Dodo 后台若支持按用途 / 项目建多把 API key，Veyl 单独一把，TweetPilot 用原来的。
- 单开的好处：泄露或轮换只影响一个项目；后台审计能区分调用来源；权限可以分别收窄。
- 若后台只允许一把商户级 key，则共用，并接受这些影响（写清楚，不装作没有）：
  1. 轮换 key 会同时打断两个项目的收款，必须两个项目一起发版 / 改 secret；
  2. 日志与后台审计里两个项目的调用混在一起，只能靠 product_id 区分；
  3. 任一项目泄露 key，另一个项目同样暴露。
- 无论单开还是共用，**test / live 两套 key 不能混用**，dev 环境不得持有 live key。
- 是否支持多 key 列为待核（§9 第 8 项）。

### 5.2 非秘密配置（`wrangler.jsonc` 的 `vars`，dev / prod 各一份）

| 名字 | 示例 | 说明 |
|---|---|---|
| `DODO_TOPUP_PRODUCT_IDS` | `{"1000":"pdt_…","2000":"pdt_…","5000":"pdt_…","10000":"pdt_…"}` | 充值面额 → Dodo 一次性产品 ID；**键是美分字符串**；可充值面额由这张表的键推导（`topupDenominations`），**不另设面额白名单**；test / live 两套，不沿用 TweetPilot |
| `PLAN_DAILY_PRICE_CENTS` | `{"s-1vcpu-512mb-10gb":20,"s-1vcpu-1gb":30,"s-1vcpu-2gb":60}` | **日价（USD 分/天），唯一真源**。月价由它派生（`× 30`），只用于展示。**推荐用它替换 `PLAN_PRICES_USD`** |
| `PLAN_PRICES_USD` | `{"s-1vcpu-512mb-10gb":6,"s-1vcpu-1gb":9,"s-1vcpu-2gb":18}` | 旧口径（月价，美元）。若保留，**必须满足 `月价分 % 30 == 0`**，否则该档不可售（见下）。与 `PLAN_DAILY_PRICE_CENTS` 同时存在时以日价为准 |
| `DODO_API_BASE` | `https://test.dodopayments.com` / `https://live.dodopayments.com` | 由 `ENVIRONMENT` 决定，不手写 |
| `APP_PAYMENT_RETURN_URL` | `https://<control-plane>/payment/return` | 充值完成后的回跳页 |

### 5.3 必须由人手工创建 / 核对

| 项 | 在哪 | 产物 |
|---|---|---|
| Resend 域名与发件地址 | Resend 后台 | 已验证的 `RESEND_FROM_EMAIL` |
| 4 个 Dodo **一次性充值产品**（`$10 / $20 / $50 / $100`，USD，可调） | **同一个 Dodo 商户后台新建 Veyl 自己的产品**（Test 与 Live 各一套） | 8 个 `pdt_…`（不复用 TweetPilot 的） |
| Dodo webhook 端点 + secret，只订阅 **`payment.succeeded` / `payment.failed`** | Dodo 后台，**Veyl 自己的路径** | `https://<env>/v1/webhooks/dodo` + `whsec_…`（与 TweetPilot 各配各的） |
| Dodo API Key | Dodo 后台 | **优先 Veyl 单开一把**；不支持再共用商户 key（§5.1） |
| 微信支付在 Dodo 后台已启用（大陆支付宝不在支持列表） | Dodo 后台 | 国内用户可扫码充值 |
| `DODO_TOPUP_PRODUCT_IDS` 的键（美分）与 Dodo 充值产品价一致 | 人工核对 | 验收 W1 |
| `PLAN_PRICES_USD` 与目录展示价一致（成本 × 1.5） | 人工核对 | 验收 W2 |

- 所有 key **不进仓库**：本地开发从 keychain / `.dev.vars`（gitignored）读，CI 从 secret 读。
- dev 与 prod 的 Dodo 产品、webhook secret、API key **完全分开**；test 模式支付不得进生产账本。

**价目表校验（启动即拒，不能等到扣费那天）**

```ts
// 首选：日价直接配，月价是派生值
dailyPriceCents = PLAN_DAILY_PRICE_CENTS[plan.id]        // 20 / 30 / 60
if (!Number.isInteger(dailyPriceCents) || dailyPriceCents <= 0) reject("invalid_plan")
monthlyCents = dailyPriceCents * 30                      // 派生，仅展示

// 兼容旧配置：只有月价时才反推
if (!PLAN_DAILY_PRICE_CENTS[plan.id]) {
  monthlyCents = Math.round(PLAN_PRICES_USD[plan.id] * 100)
  if (monthlyCents <= 0 || monthlyCents % 30 !== 0) reject("invalid_plan")
  dailyPriceCents = monthlyCents / 30
}
```

- **日价是唯一真源**：配置里配的就是每天扣多少，月价 `= 日价 × 30`，不存在除不尽的问题。
- 若仍用旧口径 `PLAN_PRICES_USD`，**任何一档不满足 `monthlyCents % 30 == 0` 就不可售**：目录不返回它，`my_server_create` 报 `PRECONDITION_FAILED / invalid_plan`。
- **不允许兜底取整**。`Math.floor` 会让 30 天少收几分，`Math.round` 会让 30 天多收几分；两者都会破坏「连扣 30 天 == 月价」这条对用户的承诺。
- 校验在**读取配置时**做一次，失败打日志并让该档从目录里消失——不是等到用户点了创建才报错。
- 现值：`20 / 30 / 60` 分/天，`600 / 900 / 1800` 分/月，两种口径都整。
- **prod（顶层 `vars`）目前还没有充值相关键**（`DODO_TOPUP_PRODUCT_IDS` 等）：dev 已配 Test 产品键，prod 等 Live 产品 ID 到位再填。看到 prod 缺这些键是**预期状态**，不是漏配。
- 代码里另保留 `DODO_PRODUCT_IDS`（订阅路径用），M1 固定为 `{}`，不参与充值；不要误把它当充值产品表。

---

## 6. 契约增量

### 6.1 Tauri 命令（`commands.md` → 2.30.0）

| 命令 | 参数 | 返回 | 说明 |
|---|---|---|---|
| `my_server_login_start` | `{ email }` | `MyServerLoginTicket` `{ sent, cooldown_seconds, retry_after_seconds? }` | 发验证码 |
| `my_server_login_verify` | `{ email, code }` | `MyServerAccount` | 校验并登录 |
| `my_server_account` | `{}` | `MyServerAccount` | 只读本地登录态，不联网 |
| `my_server_logout` | `{}` | `MyServerAccount` | 服务端解绑设备，清本地令牌 |
| `my_server_wallet` | `{}` | `MyServerWallet` `{ balance_cents, currency, denominations_cents, updated_at }` | 读余额与可充值档位 |
| `my_server_topup` | `{ denomination, channel? }` | `MyServerTopup` `{ topup_id, checkout_url, denomination_cents }` | 创建充值会话 |
| `my_server_checkout` | `{ orderId }` | `MyServerOrder` | 余额 ≥ 日价 × 7 才放行，**实际不扣费**；不足 → `insufficient_balance` 带 `required_cents` / `shortfall_cents` / `min_days: 7`；返回 `state = "provisioning"`，扣费在就绪后（§4.14）；不再返回收银台 |
| `my_server_order_get` | `{ orderId }` | `MyServerOrder` | 订单状态 |

```ts
type MyServerAccount = {
  logged_in: boolean;
  email: string | null;
  account_id: string | null;
  device_id: string | null;
  account_kind: "device" | "email" | null;
};

type MyServerWallet = {
  balance_cents: number;          // USD 分；整数
  currency: "USD";
  denominations_cents: number[];  // 可充值档位（USD 分，升序），来自产品表键
  updated_at: string;             // Host 本地取的时间；控制面不提供
};

type MyServerCharge = {
  order_id: string;
  state: "paid" | "provisioning" | "ready";
  charged_cents: number;          // 实际扣费（USD 分）＝ 第 0 天的日价
  balance_after_cents: number;
};
```

- `MyServerOrder.state` 恢复为 `"pending_payment" | "paid" | "provisioning" | "ready" | "cancelled" | "failed"`；**2.27.0 的 `awaiting_payment` / `payment_failed` / `expired` 删除**（没有外部收银台可等）。
- 金额一律用 `*_cents` 整数；`amount_usd` / `monthly_usd` 若保留只为展示，不参与计算。
- **`MyServerWallet` 只有余额与档位**：`runway_days` 曾考虑过、已放弃（理由见 §4.11），契约里不留字段，Worker / Host / 前端都不算这份派生值。
- **`MyServer`（§7.15）同时增四个字段**：`paid_until: string`（**非空**）、`daily_price_cents: number`、`billing_state: "active" | "past_due" | "expired"`、`grace_ends_at: string | null`（**派生值 `paid_until + 7d`，不落库**）。界面靠它们渲染「每天 $X · 本期有效至 …」与欠费天数，不再自己拿 `monthly_usd` 推算。
- **`my_server_catalog.plans` 增 `daily_price_cents`**：按天扣之后，向导上「每天多少钱」才是用户能核对的口径；`hourly_usd` 仍保留（它是 DO 的成本口径，不是我们的售价）。

### 6.2 HTTP 路由（控制面）

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| POST | `/v1/auth/email/start` | 无 | 发码；冷却 / IP 限频 |
| POST | `/v1/auth/email/verify` | 无（带设备证明） | 校验 + 合并 + 发令牌 |
| POST | `/v1/auth/logout` | Bearer | 解绑设备、作废 refresh |
| GET | `/v1/wallet` | Bearer | 余额（USD 分）+ `denominations_cents`（由产品键推导） |
| POST | `/v1/topups` | Bearer（`kind=email`） | 创建 Dodo 充值会话 |
| POST | `/v1/orders/{id}/checkout` | Bearer（`kind=email`） | **确认下单、不扣费**，就绪后结算（§4.14） |
| POST | `/v1/webhooks/dodo` | 签名 | 充值支付结果 |

### 6.3 错误码（沿用通用码 + `details.reason`）

| 场景 | code | reason | retryable |
|---|---|---|---|
| 邮箱格式不对 | `PRECONDITION_FAILED` | `email_invalid` | 否 |
| 60 秒内重复发码 | `RATE_LIMITED` | `email_cooldown` | 是（带 `details.retry_after_seconds`） |
| 同 IP 发码过多 | `RATE_LIMITED` | `email_rate_limited` | 是 |
| 验证码错误 | `PRECONDITION_FAILED` | `code_invalid` | 是（带 `details.attempts_remaining`） |
| 验证码过期 / 不存在 | `PRECONDITION_FAILED` | `code_expired` | 否 |
| 同一验证码错 3 次 | `PRECONDITION_FAILED` | `too_many_attempts` | 否 |
| 设备已绑定另一个邮箱 | `PRECONDITION_FAILED` | `account_conflict` | 否 |
| 设备被停用 | `PERMISSION_DENIED` | `device_revoked` | 否 |
| 需要登录 | `UNAUTHENTICATED` | `auth_required` | 是（登录后重试） |
| 登录已过期 | `UNAUTHENTICATED` | `token_invalid` | 是（自动刷新） |
| **余额不足（不足 7 天费用）** | `PRECONDITION_FAILED` | `insufficient_balance`（`details`：`required_cents` / `shortfall_cents` / `min_days: 7`） | 是（充值后重试） |
| 充值面额不合法 | `PRECONDITION_FAILED` | `invalid_denomination` | 否 |
| 生产环境用了假充值 | `PRECONDITION_FAILED` | `channel_not_allowed` | 否 |
| 目录价与配置价不一致 | `PRECONDITION_FAILED` | `price_mismatch` | 否 |
| 套餐价不能被 30 整除，不可售 | `PRECONDITION_FAILED` | `invalid_plan` | 否 |
| Dodo 建会话失败 | `UPSTREAM_ERROR` | `checkout_unavailable` | 是 |
| 订单已过期 | `PRECONDITION_FAILED` | `order_expired` | 否 |
| webhook 验签失败 | —（只回 `401`） | — | 否 |

- **不新造错误码**，只用 `runtime.md` §6.1 的通用码；细分一律放 `details.reason`。
- 所有 `reason` 都是稳定的 ASCII 标识，前端按它分支，不解析 `message`。

### 6.4 其它契约

| 文件 | 版本 | 变化 |
|---|---|---|
| `events.md` | 2.13.0 不变 | 登录态由命令返回，不新增事件 |
| `tools.md` | 3.12.0 不变 | 不给模型登录 / 支付 / 下单能力 |
| `data-model.md` | 6 不变 | 本地无新表；`account_id` 标记仍存 `settings` |

---

## 7. 验收：什么算这一步真的通了

| # | 断言 |
|---|---|
| A1 | **Host 命令层**：生产环境未登录时 `my_server_account.logged_in = false`，`my_server_list` / `my_server_create` / `my_server_checkout` 返回 `UNAUTHENTICATED / auth_required`；`my_server_login_verify` 成功后 `logged_in = true` 且 `account_id` 已绑定；全程没有静默建机。界面部分留到整体 UI 重构 |
| A2 | 60 秒内重复发码返回 `email_cooldown` 且带剩余秒数；同 IP 第 11 次返回 `email_rate_limited` |
| A3 | 验证码错 3 次后作废；第 4 次即使输入正确也要求重新发码 |
| A4 | 登录后 `account_kind = email`；同一设备换第二个邮箱登录被拒绝 `account_conflict`；登出后设备回到匿名账户，原邮箱账户的服务器不再出现在列表 |
| **W1** | **充值入账**：`my_server_topup` 返回 `checkout_url`；测试支付成功 → webhook 200 → `accounts.balance_cents` 增加面额、`wallet_ledger` 新增一行（`kind=topup`、`ref=dodo_payment:<id>`）、`topups.status=paid`。CNY 结算时账本仍记 USD 面额 |
| **W2** | **重复 webhook 不加钱**：同一 `webhook-id` / 同一 `payment_id` 重投 10 次，余额只加一次，`wallet_ledger` 与 `payments` 各只有一行 |
| **W3** | **买机：下单不扣费**：余额 ≥ 日价 × 7 → checkout 只写账本 0 行、返回 `provisioning`；服务器行 `billing_state='pending'`、`paid_until=NULL`、`billing_anchor_at=0`、`daily_price_cents=0`；余额不足（包括够 1 天但不足 7 天）→ `insufficient_balance`，`details` 带 `required_cents`（= 日价 × 7）/ `shortfall_cents` / `min_days = 7`，**余额不变、无服务器**，订单仍 `pending_payment`；订单已过期 → 转 `cancelled` 并返回 `order_expired` |
| **W3-b** | **就绪后结算**：enroll 确认成功后同一 batch 写 `wallet_ledger`（`ref=order:<order_id>`、`-20`）、`orders.state='ready'` / `paid_at` / `paid_via='wallet'`、`servers.state='active'` 且 `billing_state='active'`、`billing_anchor_at = settle_at`、`paid_until = settle_at + 1d`、`daily_price_cents`；守卫失败（余额 < 1 天）→ 不写账本、订单 `failed`、服务器 `error / settle_insufficient`（不写 `destroyed_at`）、DO 实例销毁、审计 `settle_insufficient`；结算进程死掉超过 10 分钟由 Cron `sweepUnsettledSettlements` 同一处置。存量 `charge_mode='upfront'` 订单不进入本流程 |
| **W4** | **逐日续费与 Cron 幂等**：到期服务器被 Cron 扣当天、`paid_until` 顺延 1 天、账本 `ref=server_day:<id>:<bucket>`；**同一 Cron 重跑 3 次 / 并发执行，只扣一次**；重跑时「扣余额 0、续期 1」按已扣恢复；同一台机器连扣 30 天，账本合计**正好等于月价**（`600 / 900 / 1800` 分） |
| **W5** | **余额不足进宽限**：续费扣不动 → 不扣费、`billing_state=past_due`、`grace_end = paid_until + 7d`（用当前 paid_until，补齐过则用补齐后的值）、机器与凭据不动 |
| **W6** | **宽限内恢复**：宽限期内充值 → 下次 Cron（或即时重试）补扣成功 → `paid_until` 顺延、`billing_state=active`、停用标记清除 |
| **W7** | **到期冻结**：`now ≥ grace_end` → `billing_state=expired`；**服务器行、节点凭据都在**，Cron 没有 `DELETE` 动作，余额不因到期变化；**此后连续 3 天不再新增 `server_day`、`paid_until` 不动** |
| **W8** | **对账断言**：任意时刻逐账户 `balance_cents == 最新一条 ledger.balance_after_cents`（I1）；快照之后逐行链式成立（I3）；并发两笔扣费只有一笔成功、另一笔余额不足 |
| **W13** | **账本保留期**：构造一台机器跨两个自然月、共 90 天的 `server_day` 明细 → 每日任务跑完后：只剩 `cutoff` 之后的明细；新增一条 `snapshot`（`amount_cents = 0`、`created_at = cutoff`、`balance_after` = cutoff 时刻余额）；**I1 / I2 / I3 全部成立**；`dodo_payment` / `order` / `server_refund` **一行不少**；**同一任务重跑不重复写快照、不再删行**；快照写失败时该轮一行不删 |
| **W9** | **欠费补齐**：`paid_until = anchor+1.5d`、`now = anchor+4.5d`（落后 3 个整日）、余额足够 → Cron 一次补 **4 天**到 `paid_until = anchor+5.5d > now`，账本 4 行独立 `bucket`。**是 4 不是 3**：扫描条件是 `paid_until <= now`（含等号），补到第 3 天时 `paid_until = now` 仍满足条件，必须再补 `now` 所在那一格。余额只够 2 天 → 补 2 天后 `past_due`，`grace_end` 用补齐后的 paid_until；超过 30 天仍未补到 now → `expired` 并告警 |
| **W10** | **订单 provisioning 但无服务器**：确认下单后中断（未完成建机），Cron 5 分钟内补建恰好一台；重跑不产生第二台（`unique(servers.order_id)`） |
| **W11** | **负向调整**：人工 `adjustment` 为负且余额不足 → 账本不写、余额不变；`ref_id` 用 uuid，重复 uuid 被唯一键挡住 |
| **W12** | **销毁退款**：`n_paid = 5`（`paid_until = anchor+5d`）、`now` 落在 `n_now = 3` 中间 → `refundTotal = (5 − (3+1)) × 日价 = 1 天`（`$6` 档 = **20 分**）→ 销毁只退**第 4 天**（`n = 4`）的日价、写一条 `adjustment`（`ref=server_refund:<server_id>:20`）、余额增加；**同一 ref 重放不再加钱**；`n_now = 3` 这一天已经用掉、**不退**；**标记 `destroyed` 与退款在同一个 batch 里** |
| **W12-b** | **销毁不补扣**：`paid_until` 落后 2 天（Cron 还没跑）→ 直接销毁 → **不补扣那 2 天、不产生 `server_day`**、也不因欠费阻塞销毁；`refundTotal` 按 0 计（`n_paid <= n_now+1`），**不写退款行** |
| **W12-c** | **自动销毁也退**：注入装机失败 → 系统发起销毁 → 第 0 天剩余按 `refundTotal` 退回余额；退款失败重试时 `refunded` 已等于 `refundTotal`，`delta = 0`，不再写行 |
| **W14** | **超 30 天欠费的恢复**：`expired` 已 45 天 → 充值后恢复路径把 `paid_until` 设成 `anchor + floor((now-anchor)/1d - 30) * 1d`（**仍落在整天网格上**）、记一条 `audit_log('grace_waived')`、再补 30 天到 `paid_until > now`、状态回 `active`；`wallet_ledger` 里**只有 30 条** `server_day`，被豁免的 15 天没有任何流水 |
| **W15** | **跑批游标与饿死防护**：1200 台到期服务器、其中 30 台余额为 0 → 一轮只处理 200 台并写回游标；**余额不足的机器不会永远占队首**，后续轮次能推进到其余机器；游标走到末尾后回到队首；单台抛错不影响同批其它机器 |
| **W16** | **rebuild 计费**：重建一台机器 → 生成**新订单**、扣新的 `order:<new_order_id>` 第 0 天、`billing_anchor_at` 重置为新创建时刻、`paid_until = anchor + 1d`；**旧 `order:<id>` 不会被重放**，重建不会免费 |
| A11 | **Host 命令层**：未登录或登录过期时，`runtime_start` / `node_switch` / `node_probe` 以及本地已有配置不受影响；只有 `my_server_*` 管理命令返回 `auth_required`。界面部分留到整体 UI 重构 |
| A12 | Worker 日志、D1、客户端日志、`chat_messages` 均无验证码明文、无 Dodo key、无令牌 |
| A13 | 代码与配置里没有 TweetPilot 的 `pdt_…`；Veyl 充值产品在同一个商户后台新建、test / live 各一套；Veyl 的 webhook secret 轮换不影响 TweetPilot |

---

## 8. 非目标与到期策略

| 不做 | 说明 |
|---|---|
| Turnstile | 参考实现因国内访问不稳定已禁用，本期不启用；靠冷却 + IP 限频 + 每码 3 次 |
| **现金退款** | 没有出金入口：充值后未消费的余额不退、不能提现（§16 风险），也不走 Dodo 原路退回。**销毁时未用完的整天退回余额**（店内额度，§4.6），这不是退款 |
| **按小时计费** | 按天扣（§4.1）。小时粒度的取整、24× 账本量与每小时跑批都不划算 |
| 账本全量长期保存 | **`server_day` 明细只留 30 天**，更早的由月末 `snapshot` 承接（§4.12）；钱类流水（充值 / 首日扣费 / 退款 / 人工调整）永久保留 |
| 余额提现 / 转账 / 赠送 | 钱包只用于本人消费，不支持转出 |
| 订阅（自动续费） | M1 不上线；代码保留，M2 给国际卡用户（§4.10） |
| 多币种钱包 | 钱包只有 USD 分；CNY 只存在于 Dodo 收银台与结算流水，不入账本 |
| 发票 / 税务 / 对账报表 | M2；本期只做账本自洽（§4.7 W8） |
| 到期自动回收机器 | **不自动销毁**：7 天宽限后只标记停用，实例与凭据都保留 |
| 真实停用隧道 | 本期只做状态标记（§4.11）；M2 用短期凭据或 `veyl-agent` 指令实现真停用 |
| 多设备管理 / 改邮箱 / 注销账户 | M2 |

**到期策略（2026-11-16 定稿，2026-11-16 改按天 + 冻结欠费）**：`servers.paid_until + 7 天` 为宽限终点。宽限内充值并补扣成功立即恢复；宽限结束后状态标 `expired`，**不删机器、不删凭据**，同时**冻结账面**：`paid_until` 不再前进、不再写 `server_day`，用户不会因为停机时间变长而欠更多。恢复时最多补 30 天，超出部分默认豁免并记 `audit_log`。代价是机器继续在跑、云厂商费用照付（约 $6–18/月/台，售价档），这是为了不误删用户仍在使用的服务器而接受的成本；M2 引入短期凭据后才能做到「到期即断」。

**资金与换汇风险**（写清楚，不藏）：

1. 未消费余额是**我们的负债**，用户随时可能要求退款（本期不做，M2 必须给规则）；
2. 微信充值是 CNY → USD 换汇，Dodo 抽 2–4%，我们按 USD 面额入账，差额由我们承担；
3. 账本与 Dodo 结算流水的对账（汇率、手续费）留到 M2；本期只保证账本内部自洽。



---

## 9. 待核（实现前核实）

| # | 事项 | 影响 |
|---|---|---|
| 1 | Dodo webhook 是否原样回传 `metadata`（`topup_id`） | 决定匹配主路径；不回来就靠 `checkout_session_id`（当前按此设计） |
| 2 | **D1 `batch()` 是否严格事务**（两步扣费守卫依赖它） | 若否，改用单条 `INSERT … SELECT` 或 DO 串行化 |
| 3 | 微信支付在 Dodo 下对 **USD 产品**的实际换汇价、手续费与结算币种 | 影响换汇成本核算（2–4%）与 `settlement_amount` 字段 |
| 4 | `payment.succeeded` 载荷是否稳定包含 `product_id` / `settlement_amount` | 充值入账按产品映射，不依赖金额；但审计与对账需要 |
| 5 | Dodo 单笔最低金额与 CNY 取整规则 | 决定充值面额是否可行（$10 档最可能受最低额限制） |
| 6 | Dodo webhook 的重投策略与超时 | 决定是否必须 `waitUntil` 与 Cron 兜底 |
| 7 | Resend 发件域名在主要邮箱服务商的送达率 | 验证码到不了 = 登录不可用 |
| 8 | Workers `waitUntil` 内调用 DigitalOcean 建机的时长上限 | 超过则改为 Workflow / 队列 |
| 9 | 6 位码 + 3 次上限 + IP 20 次/小时是否足够防刷 | 不够再评估图形验证（不用 Turnstile） |
| 10 | Dodo 是否支持按用途建多个 API key（Veyl 单开一把） | 决定用单开还是共用商户 key；共用影响见 §5.1 |

---

## 10. 落地清单

| 侧 | 改动 |
|---|---|
| **控制面** | `src/auth_email.ts`（发码 / 校验 / 合并 / 登出）、`src/wallet.ts`（账本、原子扣费、对账自检、月末快照）、`src/topups.ts`（充值会话 + webhook 入账）、`src/billing.ts`（每日按天扣费 + 宽限状态机 + 销毁退款 + `server_day` 裁剪）、`src/webhooks/dodo.ts`（支付事件 + 三层幂等）、`src/orders.ts`（checkout 只确认下单不扣费；建机门槛日价 × 7；`charge_mode` 区分存量 upfront，§4.14）、`src/servers.ts`（enroll 回调里结算第 0 天、失败收尾与 10 分钟兜底）、`src/index.ts`（路由）、迁移 `0007_at_ready_settlement.sql`（`orders.charge_mode`、`servers.paid_until` 可空、`servers` 重建）、迁移 `0003_wallet.sql`（`email_codes` / `topups` / `wallet_ledger`（含 `snapshot` 与 `wallet_ledger_prune`）/ `payments` / `webhook_events` / `unmatched_payments` / `accounts.balance_cents` / `orders.amount_cents` / `servers.billing_anchor_at|paid_until|daily_price_cents|billing_state` / `unique(servers.order_id)`） |
| **Rust Host** | `control_plane/auth.rs`（登录 / 登出 / account_kind）、`control_plane/wallet.rs`（余额 / 充值）、`my_server_login_*` / `account` / `logout` / `wallet` / `topup` / `order_get` 命令、`my_server_checkout` 确认下单并触发建机（返回 `MyServerOrder`，不返回扣费结果）；**2.37.1 起 `control_plane/error.rs` 透传 `required_cents` / `min_days`**（§4.13）；充值由 Host 打开系统浏览器（界面未上线前不依赖前端）；余额与宽限文案在 UI 重构时接入 |
| **React UI** | **本轮不做，等整体 UI 重构**：统一登录弹窗、左栏底部账号块（§3.6）、`我的服务器` 未登录空态、余额与充值入口、`insufficient_balance` 与到期提示条。**建机向导的 7 天门槛预检见 §4.13** |
| **契约** | `commands.md` **2.30.0**（`MyServer` 增 `paid_until`（非空）/ `daily_price_cents` / `billing_state` / `grace_ends_at`（派生）；`my_server_catalog.plans` 增 `daily_price_cents`；`checkout` 语义改成扣 1 天；`MyServerWallet` 保持余额 + 档位，不含可运行天数）；**2.37.1 起 `checkout` 门槛改为日价 × 7、`insufficient_balance` 增 `required_cents` / `min_days`**。`check-contracts.mjs` 已全绿（76 项通过、2 项 advisory），`MyServerPlan.daily_price_cents` 的实现侧补齐后红项消失 |
