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
| 4 | 支付 | Dodo Payments **订阅**产品 + 托管收银台 + webhook 确认；订单新增 `awaiting_payment` / `payment_failed` / `expired` 三态 |
| 4b | 商户 | 与 TweetPilot **同一个 Dodo 商户账号**；产品、webhook、回跳页、API key 都按 Veyl 自己的建（§4.7） |
| 5 | 建机时机 | **只有首期 `payment.succeeded` 才建机**；`subscription.active` 先到也不建（试用期可能无扣款）；结账只创建会话 |
| 6 | 幂等 | 结账用 `Idempotency-Key`；webhook 用 `webhook-id` + `payment_id` + 行级状态守卫；同一订单只允许一台服务器 |
| 7 | 价格 | 目录展示的必须是**售价**（Dodo 订阅产品价），不是 DigitalOcean 成本价；不一致拒绝结账 |
| 8 | 到期 | 宽限 **7 天**；到期/取消都不删机器、不删凭据；宽限后只标记停用（真停用留 M2）；机器继续计费（§4.9、§8） |

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
| 1 | 目录展示 DigitalOcean 成本价（`$6/月`），Dodo 产品按自己的价格收款 | 目录改成展示**售价**；结账前校验订单金额 = 产品价，不一致报 `price_mismatch`（§4.4） |
| 2 | `checkout` 同步建机，没有「等待支付」这一段时间 | 拆成「创建会话 → 浏览器支付 → webhook 确认 → 建机」（§4.1） |
| 3 | 订单状态没有 `awaiting_payment` / `payment_failed` / `expired` | 状态机加三态（§4.2） |
| 4 | `orders.expires_at` 10 分钟，用户跳转支付、3DS 很容易超时 | 会话 30 分钟；**过期后到账仍认**，照常建机（§4.5） |
| 5 | 没有「一个订单只建一台服务器」的约束 | 加唯一索引 `servers(order_id)`，webhook 重放不会建第二台 |
| 6 | 设备注册是静默的，没有登录概念；设备也没有「登出」路径 | 登录 = 设备并入邮箱账户；新增 `logout` 把设备解绑到新的匿名账户（§2.4） |
| 7 | 只有一次性支付的模型，没有订阅、周期与续费 | 新增 `subscriptions` 表；`current_period_end` 由 `service_periods[].ends_at` 写入（§4.3、§4.8） |
| 8 | 没有到期 / 取消 / 宽限的任何状态 | 订阅状态机 + 7 天宽限；到期不删机器（§4.9） |

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
  // 订阅 / 到期：口径已定为订阅（§4.9）；字段留到整体 UI 重构时再定义
};
```

| 字段 | 谁能用 | 说明 |
|---|---|---|
| `logged_in` | 界面 | 唯一门禁开关；`account_kind === "email"` 时为真 |
| `email` | 界面 | 账号块主行；未登录为 `null` |
| `account_id` | Host / 诊断 | 内部主键，**不进界面**、不进 AI 上下文 |
| `device_id` | Host / 诊断 | 只用于「这台设备」的归属判断，**不进界面** |
| `account_kind` | Host | `device` = 匿名设备账户；`email` = 已登录；`null` = 连设备身份都还没有 |
| 订阅 / 到期 | 以后 | 口径已定为订阅（§4.9）；**本轮不定义字段**，整体 UI 重构时按 §4.9 的文案补 |

- 两个命令返回同一形状，前端只写一份渲染逻辑。
- `my_server_account` **只读本地**、不联网；离线时仍能返回上次登录的摘要（`logged_in` 沿用本地记录），并用 `email` 渲染账号块。
- 响应里没有 token、密码、`device_secret`；这些永远只在 Host 的 `secrets.enc`。

---

## 3. 客户端门禁

> **本轮不做界面**（2026-11-15 用户决定）：登录弹窗、账号块、支付等待页、到期提示条都留到整体 UI 重构时按本节实现。本轮只落 Host 命令层与门禁语义；界面未上线前，开发 / 测试环境靠 §2.1 的匿名建机过渡规则继续跑通。

### 3.1 哪些操作要登录

| 操作 | 未登录 | 说明 |
|---|---|---|
| 打开「我的服务器」destination | 左栏空态「登录后查看你的服务器」，底部账号块给唯一一个 `登录` 按钮（§3.6）；中间显示登录引导 | **不自动弹窗**，用户点按钮才弹 |
| 点「创建服务器」/「确认下单」 | 弹统一登录弹窗；登录成功后回到向导，已选地区与套餐不变 | 沿用 `my-servers.md` §4.3 |
| 服务器列表 / 详情 / 销毁 / 重建 / 取凭据 | 需要登录 | 未登录不发请求 |
| 支付（打开收银台） | 需要登录 | 下单本身已要求登录 |
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
| 展开区 | `登出` + 「已有配置和节点不受影响。」+ 预留「订阅 / 到期」位置 | 只有 `登录` |
| 绝不显示 | token、密码、`device_secret`、`account_id` | 同左 |

- **订阅 / 到期位置先留空**：口径已定为订阅，宽限规则见 §4.9；本轮**不渲染、不编字段**，整体 UI 重构时按 §4.9 的三段文案补。
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

### 4.1 结账流程（替换「结账即建机」）

**支付按订阅做**（2026-11-15 定稿）：Dodo 产品是**订阅产品**，不是一次性付款。

```
客户端                        控制面                            Dodo
  │  POST /orders               │                                │
  │ ──────────────────────────▶ │ pending_payment（10 分钟）     │
  │  POST /orders/{id}/checkout │                                │
  │ ──────────────────────────▶ │ 校验售价 → POST /checkouts ───▶│ 订阅产品
  │ ◀── { checkout_url, ... } ─ │ awaiting_payment               │
  │  系统浏览器打开 checkout_url ───────────────────────────────▶ │ 用户订阅
  │                             │ ◀── subscription.active        │ 先到（2–10 分钟内无扣款）
  │                             │ ◀── payment.succeeded          │ 首期扣款成功
  │                             │ 幂等 → paid → 建机             │
  │  GET /orders/{id}（轮询）    │                                │
  │ ◀── state = paid/provisioning│                                │
```

- **建机触发点只认 `payment.succeeded`**：首期事件顺序是 `subscription.active` 先到，2–10 分钟后才有 `payment.succeeded`；试用期可能只有 active、没有扣款，**不能凭 active 建机**。
- **打开方式**：宿主用系统默认浏览器打开 `checkout_url`（不内嵌 WebView）。`return_url` 指向控制面的静态回跳页「订阅完成，请回到 Veyl」，不依赖自定义 URL scheme。
- **客户端轮询**：`awaiting_payment` 期间 2 秒轮询 `my_server_order_get`，最多 30 分钟；切走窗口暂停，回到前台立即查一次。
- **假支付保留在非生产**：`channel: "fake"` 只在 `ENVIRONMENT !== "production"` 时可用，行为等于「直接 paid + 建机」；生产传 `fake` 一律 `channel_not_allowed`。本地开发与 E2E 的唯一后门。
- **取消与改支付方式**：用户去 Dodo 托管 Customer Portal 自助完成，本期不在应用内做订阅管理入口。


### 4.2 订单状态机

```
pending_payment ──checkout──▶ awaiting_payment ──webhook 成功──▶ paid ──▶ provisioning ──▶ ready
      │                            │                                 │
      │                            ├── webhook 失败 ──▶ payment_failed ──checkout──┐
      │                            └── 会话过期 ──────▶ expired ──────checkout──┤
      └── 用户取消 / 10 分钟 ─────▶ cancelled                                   │
                                                                                └──▶ awaiting_payment
paid ──建机失败──▶ failed（实例已销毁，订单结束）
```

- `awaiting_payment`：已创建收银台会话，带 `checkout_session_id`、`expires_at = 创建 + 30 分钟`。**`subscription.active` 不会推进订单状态**——首期扣款确认前一直停在这里。
- `paid`：**首期 `payment.succeeded`** 到达，订单进入开通；续费的 `payment.succeeded` 只更新订阅与 `paid_until`，**不再改订单状态、不再建机**。
- `payment_failed`：Dodo 明确告知失败（首期扣款失败）；用户可重新结账（新 `Idempotency-Key`）。
- `expired`：收银台会话过期且未支付；订单**不删**，用户可重新结账。
- `cancelled`：用户在支付前主动取消；已支付订单不能取消，只能销毁服务器（沿用 `cancel_after_paid`）。
- **`failed` 只在建机失败时出现**；支付失败用 `payment_failed`，两者文案不同。
- 不变式：`paid` 之后一定会有结果——要么服务器，要么 `failed` + 已销毁 + 告警。**不存在「收了钱什么也没发生」**。

### 4.3 Webhook

`POST /v1/webhooks/dodo`（公开端点，无 Bearer）

```ts
// 验签：Standard Webhooks
const signed = `${webhookId}.${webhookTimestamp}.${rawBody}`;
// secret 形如 whsec_<base64>；HMAC-SHA256 → base64 → 与 webhook-signature 里的 v1,<sig> 比较
```

| 项 | 规则 |
|---|---|
| 必需头 | `webhook-id` / `webhook-timestamp` / `webhook-signature` |
| 时间窗 | `webhook-timestamp` 与服务器时间差 **≤ 5 分钟**，超出按重放拒绝（参考实现未校验，我们补上） |
| 签名比较 | 常量时间比较；支持多签名（空格分隔），任意一个匹配即通过 |
| 失败响应 | `401 {"error":"invalid_signature"}`，不返回细节；**不重试**（Dodo 会按自己的策略重投） |
| 无关事件 | 消费下表 12 个订阅事件 + 2 个支付事件，其余一律 `200 {ok:true}` 忽略 |
| 处理失败 | `500`，让 Dodo 重投；处理逻辑必须幂等 |

#### 4.3.1 事件 → 状态映射

Dodo 订阅共 12 个事件；本期消费下面这些，其余只记 `webhook_events` 不动作。

| 事件 | `subscriptions` | `servers` / `orders` | 幂等键 |
|---|---|---|---|
| `subscription.active` | upsert：`status = 'active'`；`current_period_end = next_billing_date`（缺失时用 `data.current_period_end`）；`cancel_at_period_end = 0` | **不动服务器、不推进订单**（试用期只有 active、无扣款） | `webhook-id` |
| `payment.succeeded`（首期） | upsert：`status = 'active'`；period_end 取 `service_periods[].ends_at` 的最大值 | **订单 `paid → provisioning`，插服务器并建机**；`servers.paid_until = period_end` | `payments.id` = payment id |
| `payment.succeeded`（续费） | 更新 `current_period_end = 新的 ends_at`；`status = 'active'` | `servers.paid_until = max(旧值, 新 period_end)`；**不建机、不改订单** | `payments.id` |
| `subscription.renewed` | `status = 'active'`；period_end 取 `next_billing_date`（若比现值新） | 不写 `paid_until`（以 `payment.succeeded` 为准） | `webhook-id` + 事件时间 |
| `payment.failed` | `status = 'past_due'`（仅为兼容，随后的事件会覆盖） | 首期失败：订单 `payment_failed`；续费失败：不动服务器 | `payments.id` |
| `subscription.past_due` | `status = 'past_due'` | 不改 `paid_until`（宽限从 period_end 起算） | `webhook-id` + 时间 |
| `subscription.on_hold` | `status = 'on_hold'` | 同上 | 同上 |
| `subscription.paused` | `status = 'paused'`；保留 period_end | 同上 | 同上 |
| `subscription.unpaused` | `status = 'active'` | 同上 | 同上 |
| `subscription.cancelled` | `status = 'cancelled'`；`cancel_at_period_end` 按 §4.3.2 判定；立即失效时 `current_period_end = min(现值, 事件时间)` | 不删机器、不删凭据 | 同上 |
| `subscription.expired` | `status = 'expired'` | 同上 | 同上 |
| `subscription.failed` | `status = 'failed'` | 同上 | 同上 |
| `subscription.plan_changed` | 记录并告警，**本期不支持套餐变更**，不改状态 | 不动 | 同上 |
| `subscription.updated` | 仅当事件带更新的 period_end / cancel 标记时更新；否则只记录 | 不动 | 同上 |
| `subscription.update_payment_method` | 忽略（托管 Portal 行为） | 不动 | 同上 |

**取消是立即失效还是期末失效**：Dodo 后台有两个默认开启的开关决定。设计**两个都要能处理**：

1. 优先读订阅对象上的 `cancel_at_next_billing_date`（字段名**待核**，见 §9）：`true` → 期末失效，`false` → 立即失效。
2. 字段缺失时用时间兜底：事件到达时间 < `current_period_end` → 视为期末失效；否则立即失效。
3. 期末失效：`status = 'cancelled'`、`cancel_at_period_end = 1`，宽限从 `current_period_end` 起算；立即失效：`current_period_end` 截到事件时间，宽限从此刻起算。
4. **人工核对项**：把后台两个开关调成**期末失效**（用户已经付过这一期），并记录后台实际状态；若被改成立即失效，我们的时间兜底仍成立，但用户会在当期未用完时失去服务。

#### 4.3.2 幂等三层（沿用，扩展到订阅）

1. `webhook_events.id` 主键 = `webhook-id`：重复投递直接 200，不处理。
2. 业务主键：
   - 支付事件 → `payments.id` = Dodo `payment_id`；
   - 订阅事件 → `subscriptions.last_event_id` + `last_event_at`（见下）；
   - 同一 `subscription.active` 重复到达 → `status` 已是 active、period_end 不变，天然幂等。
3. 行级状态守卫：写 `subscriptions` / `orders` 时带 `WHERE last_event_at <= ?` 或订单状态白名单，影响 0 行就当作已处理。

#### 4.3.3 乱序

- 每个订阅事件带事件时间（`occurred_at` / `created_at`，取 Dodo 载荷中的时间字段）；**比 `subscriptions.last_event_at` 旧的事件只记录、不改状态**（同时间戳按 `event_id` 字典序去重）。
- 允许的例外（必须能自愈）：
  - `payment.succeeded` 比 `subscription.active` 先到：先 upsert 订阅为 active，稍后旧 active 事件因时间更旧被忽略。
  - `payment.succeeded` 比 `subscription.cancelled` 晚到：钱已收，`paid_until` 照常顺延；**状态不回滚成 active**（取消仍然有效）。
  - `subscription.expired` 后收到更旧的 `renewed`：忽略；收到**更新**的 `payment.succeeded`：允许复活为 active 并顺延。
- `subscription.updated` / `renewed` 只推进 `current_period_end`，**永不回退**（取 `max(现值, 新值)`）。


**订单匹配顺序**（Dodo 的 metadata 是否原样回传**待核**，所以按优先级三选一）：

1. `data.metadata.order_id` → 校验该订单的 `account_id` 与 metadata 一致。
2. `data.checkout_session_id` → 查 `orders.checkout_session_id`。
3. 都匹配不上 → 写 `unmatched_payments`（含完整脱敏事件、`payment_id`、金额、邮箱哈希），返回 **200** 并告警。**绝不因为匹配不上就让 Dodo 无限重投**；补映射后由人工 / Cron 重放。

### 4.4 金额与售价

| 项 | 规则 |
|---|---|
| 售价来源 | 控制面配置 `PLAN_PRICES_USD`（`vars`，非 secret），与 Dodo 产品价**逐一对齐**；规则是 **成本 × 1.5**（2026-11-15 用户决定） |
| 目录 | `GET /v1/catalog` 的 `monthly_usd` / `hourly_usd` 改为**售价**；成本价只在控制面内部保留，不下发 |
| 下单 | `orders.amount_usd` 写售价快照；`servers.monthly_usd` 沿用该快照 |
| 结账前校验 | 订单金额 ≠ `PLAN_PRICES_USD[plan]` → `PRECONDITION_FAILED / price_mismatch`，**不创建会话** |
| webhook 金额 | 每期 `payment.succeeded` 记录 `settlement_amount` 到 `payments.amount_usd`；与订阅产品价不一致 → 记录并告警，但**照常开通 / 顺延**（钱已收，差额人工处理） |
| 订阅周期 | 每期金额就是套餐月价；`service_periods[].ends_at` 决定本期结束，不用 `payment.succeeded` 的到达时间推算 |

- 为什么不能继续用 DO 成本价：Dodo 按产品价收款，用户看到 `$6`（成本）却付 `$9`（售价）是欺骗；反过来显示 `$9` 却只收 `$6` 是我们亏。
- **30% 加价作废，改为成本 × 1.5**，从此刻起必须落到配置里，不再是「只写文档」。当前三个在售套餐（`cloudflare/control-plane/src/index.ts` 的 `PLAN_SLUGS`）：

| 套餐 slug | DO 成本（月） | 售价（月） | 时价（售价 / 730） |
|---|---|---|---|
| `s-1vcpu-512mb-10gb` | $4 | **$6.00** | $0.00822 |
| `s-1vcpu-1gb` | $6 | **$9.00** | $0.01233 |
| `s-1vcpu-2gb` | $12 | **$18.00** | $0.02466 |

- 这三个值必须与 Dodo 后台的 Veyl 产品价逐分一致；Dodo 后台改价而不改配置（或反之）→ 结账直接 `price_mismatch`，不会出现「看到 $9、扣了 $8」。`hourly_usd` 只用于展示，按 `monthly_usd / 730` 计算，不单独定价。
- 价格取整到分；`hourly_usd = monthly_usd / 730`，只用于展示。

### 4.5 重复、乱序、重试的处置

| 场景 | 处理 |
|---|---|
| 同一 webhook 重投 | `webhook_events.id` 命中 → 200，不重复处理 |
| 同一 payment 的不同事件 | `payments.id` 命中 → 200 |
| 重复 `payment.succeeded`（首期） | 订单已是 `paid/provisioning/ready` → 只补记 `payments`，不建第二台 |
| 重复 `payment.succeeded`（续费） | `payments.id` 命中 → 200；`paid_until` 取 `max`，不会重复顺延 |
| 同一订阅的 `active` / `renewed` 重复 | `last_event_at` 不前进，状态与 period_end 不变 |
| `payment.succeeded` 先到、`subscription.active` 后到 | 先按支付建订阅并开通；旧 active 事件因时间更旧被忽略 |
| `subscription.cancelled` 后到账 | 钱照收，`paid_until` 顺延，**状态保持 cancelled**，宽限仍从 `current_period_end` 起算 |
| `payment.failed` 先到、`succeeded` 后到 | 允许 `payment_failed → paid`（首期）或 `past_due → active`（续费） |
| 订单已 `expired` / `cancelled` 后才到首期款 | **仍然认**：转 `paid` 并建机（无退款能力，收了钱必须交付） |
| 订单已 `failed`（建机失败、机器已销毁）后补到账 | 建新服务器（新 `server_id`）并开通；订阅挂到新服务器 |
| webhook 处理中途失败 | 返回 500，Dodo 重投；已写入的部分由状态守卫兜住 |
| 建机失败 | **不要让 webhook 500**：先把 `paid` 落库并返回 200，建机失败由订单 / 服务器状态机处理并告警 |
| `paid` 但 5 分钟没有服务器 | Cron 每 5 分钟补建（`unique(servers.order_id)` 保证最多一台） |

### 4.6 建机触发点

- webhook 确认**首期** `payment.succeeded` 后：插入 `servers` 行（`INSERT OR IGNORE`，靠唯一索引）→ `ctx.waitUntil(provisionServer(...))`。
- 续费的 `payment.succeeded` **不建机**，只更新 `subscriptions.current_period_end` 与 `servers.paid_until`。
- webhook 响应不等待建机完成（Dodo 的超时很短）；建机结果写订单 / 服务器状态。
- Cron 兜底：`orders.state = 'paid'` 且 `created_at < now - 5min` 且没有服务器的订单 → 重新触发。
- **不在 checkout 里建机**，也不在客户端轮询里触发建机。

### 4.7 商户与产品归属（2026-11-15 拍板）

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
- 账单与结算在同一个商户后台，**对账时按 product_id 区分项目**；`payments` 表记录 `product_id`，不只记金额。
- 共用商户的风险写清楚：Dodo 后台的权限是商户级的，任何能改商户设置的人都能看到两个项目的交易；这是运营层面的接受项，不在客户端设计里解决。

### 4.8 新增表与列（迁移 `0003_login_payment.sql`）

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

-- 支付流水：payment_id 唯一，webhook 重放不能重复记账
CREATE TABLE payments (
  id              TEXT PRIMARY KEY,   -- Dodo payment id
  order_id        TEXT,               -- 首期时有；续费时为 NULL
  subscription_id TEXT,               -- 续费与首期都写
  account_id      TEXT,
  amount_usd      REAL NOT NULL,
  currency        TEXT NOT NULL,
  status          TEXT NOT NULL,      -- succeeded | failed
  period_end      INTEGER,            -- service_periods[].ends_at 的最大值
  raw_digest      TEXT NOT NULL,
  received_at     INTEGER NOT NULL
);

-- 订阅：一个账户可有多条历史；同一 server 同一时间只有一条有效
CREATE TABLE subscriptions (
  id                  TEXT PRIMARY KEY,   -- Dodo subscription id
  account_id          TEXT NOT NULL,
  order_id            TEXT,               -- 首期订单
  server_id           TEXT,               -- 开通后回填
  status              TEXT NOT NULL,      -- active|past_due|on_hold|paused|cancelled|expired|failed
  current_period_end  INTEGER,            -- 本期结束（ms）；宽限基准
  cancel_at_period_end INTEGER NOT NULL DEFAULT 0,
  last_event_at       INTEGER NOT NULL,   -- 乱序判定
  last_event_id       TEXT,               -- 同时间戳去重
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL
);
CREATE INDEX subscriptions_account ON subscriptions(account_id);
CREATE INDEX subscriptions_server ON subscriptions(server_id);

-- webhook 事件：webhook-id 去重
CREATE TABLE webhook_events (
  id            TEXT PRIMARY KEY,  -- webhook-id
  kind          TEXT NOT NULL,     -- payment.succeeded | payment.failed | ignored
  received_at   INTEGER NOT NULL,
  processed_at  INTEGER,
  order_id      TEXT,
  payment_id    TEXT,
  status        TEXT NOT NULL      -- received | processed | failed
);

-- 匹配不上的支付：返回 200，留证据等人工重放
CREATE TABLE unmatched_payments (
  payment_id   TEXT PRIMARY KEY,
  email_hash   TEXT,
  amount_usd   REAL NOT NULL,
  currency     TEXT NOT NULL,
  reason       TEXT NOT NULL,      -- no_metadata | unknown_order | account_mismatch
  payload_hash TEXT NOT NULL,
  received_at  INTEGER NOT NULL,
  replayed_at  INTEGER
);

ALTER TABLE orders ADD COLUMN checkout_session_id TEXT;
ALTER TABLE orders ADD COLUMN checkout_url TEXT;
ALTER TABLE orders ADD COLUMN paid_via TEXT;          -- dodo | fake
ALTER TABLE orders ADD COLUMN subscription_id TEXT;   -- 首期确认后回填
ALTER TABLE servers ADD COLUMN paid_until INTEGER;    -- 每期 payment.succeeded 的 period_end；只增不减
CREATE UNIQUE INDEX servers_order ON servers(order_id);
```

- `servers_order` 唯一索引是「webhook 重放不建第二台」的最后一道保险；`rebuild` 接入时要用**新订单**或先删旧行，不能复用同一 `order_id`。
- `payments` 与 `orders` 不做外键（D1 不强制），靠应用层校验。

### 4.9 到期、取消与 7 天宽限（2026-11-15 拍板）

**时间基准**：`subscriptions.current_period_end`（缺失时回落 `servers.paid_until`）。`current_period_end` 只由事件里的 `service_periods[].ends_at` / `next_billing_date` 写入，**不用事件到达时间推算**；`servers.paid_until` 在每次 `payment.succeeded` 时写 `max(旧值, 新 period_end)`，只增不减。

| 时刻 | 订阅状态 | 隧道 | 机器与凭据 | 界面一句话 |
|---|---|---|---|---|
| `now < current_period_end` | `active` | 正常 | 保留 | —（账号块只显示到期日） |
| `end ≤ now < end + 7d` | `active` / `past_due` / `cancelled` | **正常（宽限）** | **保留** | 「订阅已到期，7 天内续费可继续使用（还剩 N 天）。」 |
| `now ≥ end + 7d` | `expired` / `cancelled` / `failed` | 标记停用 | **保留** | 「订阅已失效。服务器还在，续费后可恢复。」 |

- **宽限内续费立即恢复**：收到续费 `payment.succeeded` → `current_period_end` 顺延 → 状态回 `active`、清除停用标记；`paid_until` 同步顺延。
- **取消**：期末失效时 `cancel_at_period_end = 1`，用户可用完本期，之后进入同一套 7 天宽限；立即失效时从取消时刻起算。
- **不删机器、不删凭据**：宽限期与之后都**不销毁实例**、不删本机节点密码。原因是本轮没有退款、也没有迁移方案，删机器是不可逆动作。
- **停用隧道本期只做状态标记，不做真停用**：节点凭据在本地，客户端直连服务器端口，控制面无法即时切断。到期后用户仍能连接——这是已知限制，不是 bug。
  - M2 补救方向（二选一或并用）：① 节点凭据改为短期、由控制面续签，过期即失效；② 由 `veyl-agent` 按签名指令停 `sing-box`（`server-agent.md` §4.2 增加 `stop` / `reconfigure` 动作）。
- **成本风险**：宽限期与失效后机器继续计费（约 $4–12/月/台），由我们承担。Cron **不**因到期销毁实例；只在账号块与服务器详情显示状态。
- 到期后用户仍可：登录、查看服务器、续费、销毁；**不能新建**。

---

## 5. Secrets 与配置

### 5.1 Worker Secrets（每个环境单独 `wrangler secret put`）

| 名字 | 用途 | 谁能读 |
|---|---|---|
| `RESEND_API_KEY` | 发验证码邮件 | Worker 运行时 |
| `RESEND_FROM_EMAIL` | 发件人（如 `Veyl <no-reply@dessage.xyz>`） | Worker |
| `DODO_API_KEY` | 创建 checkout session。**同一个 Dodo 商户账号**（与 TweetPilot 共用结算主体）；优先给 Veyl 单开一把，见下方说明 | Worker |
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
| `DODO_PRODUCT_IDS` | `{"s-1vcpu-1gb":"pdt_…"}` | **Veyl 自建**的**订阅产品** ID JSON（月付），不沿用 TweetPilot；test / live 两套 |
| `PLAN_PRICES_USD` | `{"s-1vcpu-512mb-10gb":6.0,"s-1vcpu-1gb":9.0,"s-1vcpu-2gb":18.0}` | 售价（成本 × 1.5），必须与 Dodo 产品一致 |
| `DODO_API_BASE` | `https://test.dodopayments.com` / `https://live.dodopayments.com` | 由 `ENVIRONMENT` 决定，不手写 |
| `APP_PAYMENT_RETURN_URL` | `https://<control-plane>/payment/return` | 回跳页 |

### 5.3 必须由人手工创建 / 核对

| 项 | 在哪 | 产物 |
|---|---|---|
| Resend 域名与发件地址 | Resend 后台 | 已验证的 `RESEND_FROM_EMAIL` |
| 3 个 Dodo **订阅产品**（每个套餐一个，月付、USD、无试用期） | **同一个 Dodo 商户后台新建 Veyl 自己的产品**（Test 与 Live 各一套） | 6 个 `pdt_…`（不复用 TweetPilot 的） |
| Dodo webhook 端点 + secret，并订阅**全部 12 个订阅事件 + 2 个支付事件** | Dodo 后台，**Veyl 自己的路径** | `https://<env>/v1/webhooks/dodo` + `whsec_…`（与 TweetPilot 各配各的） |
| Dodo API Key | Dodo 后台 | **优先 Veyl 单开一把**；不支持再共用商户 key（§5.1） |
| **取消行为两个开关调成「期末失效」** | Dodo 后台（默认开启，状态需核对） | 记录实际值；设计同时兼容立即失效（§4.3.1） |
| 托管 Customer Portal 已开启 | Dodo 后台 | 用户自助取消 / 改支付方式 |
| `PLAN_PRICES_USD` 与 Dodo 订阅产品价一致（成本 × 1.5） | 人工核对 | 验收 A10 |

- 所有 key **不进仓库**：本地开发从 keychain / `.dev.vars`（gitignored）读，CI 从 secret 读。
- dev 与 prod 的 Dodo 产品、webhook secret、API key **完全分开**；test 模式支付不得进生产账本。

---

## 6. 契约增量

### 6.1 Tauri 命令（`commands.md` → 2.27.1）

| 命令 | 参数 | 返回 | 说明 |
|---|---|---|---|
| `my_server_login_start` | `{ email }` | `MyServerLoginTicket` `{ sent, cooldown_seconds, retry_after_seconds? }` | 发验证码；60 秒冷却由服务端决定 |
| `my_server_login_verify` | `{ email, code }` | `MyServerAccount` | 校验并登录；设备证明由 Host 自动带 |
| `my_server_account` | `{}` | `MyServerAccount` | 只读本地登录态，不联网 |
| `my_server_logout` | `{}` | `MyServerAccount` | 服务端解绑设备，清本地令牌 |
| `my_server_order_get` | `{ orderId }` | `MyServerOrder` | 支付 / 开通轮询 |
| `my_server_checkout`（改） | `{ orderId, channel? }` | `MyServerCheckout` | 返回 `checkout_url`；不再同步建机 |

```ts
type MyServerAccount = {
  logged_in: boolean;
  email: string | null;
  account_id: string | null;
  device_id: string | null;
  account_kind: "device" | "email" | null;
};

type MyServerCheckout = {
  order_id: string;
  state: "awaiting_payment" | "paid" | "provisioning";   // fake 通道直接 paid / provisioning
  checkout_url: string | null;                            // fake 时为 null
  session_id: string | null;
  expires_at: string | null;
};
```

`MyServerOrder.state` 增加 `"awaiting_payment" | "payment_failed" | "expired"`；`MyServerOrder` 增加 `checkout_url?: string | null`（未支付时给「继续支付」用）。

### 6.2 HTTP 路由（控制面）

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| POST | `/v1/auth/email/start` | 无 | 发码；冷却 / IP 限频 |
| POST | `/v1/auth/email/verify` | 无（带设备证明） | 校验 + 合并 + 发令牌 |
| POST | `/v1/auth/logout` | Bearer | 解绑设备、作废 refresh |
| POST | `/v1/orders/{id}/checkout` | Bearer（`kind=email`） | 创建 Dodo 会话 |
| POST | `/v1/webhooks/dodo` | 签名 | 支付结果 |

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
| 生产环境用了假支付 | `PRECONDITION_FAILED` | `channel_not_allowed` | 否 |
| 目录价与产品价不一致 | `PRECONDITION_FAILED` | `price_mismatch` | 否 |
| Dodo 建会话失败 | `UPSTREAM_ERROR` | `checkout_unavailable` | 是 |
| 订单已过期 | `PRECONDITION_FAILED` | `order_expired` | 否 |
| 支付尚未到账 | `PRECONDITION_FAILED` | `payment_pending` | 是（继续轮询） |
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
| A5 | 结账返回 `checkout_url`，浏览器能打开 Dodo 订阅收银台；**此时没有服务器行**、订单是 `awaiting_payment`；随后到达的 `subscription.active` **不建机** |
| A6 | 首期 `payment.succeeded` → webhook 200 → 订单 `paid` → **恰好一台**服务器 → `ready`；重复投递同一 payment / 同一 webhook 不产生第二台，`payments` 只有一行 |
| A7 | 篡改 body / 过期时间戳 / 错误签名一律 401，订单与订阅都不变 |
| A8 | 首期 `payment.failed` → 订单 `payment_failed`、无服务器；之后的 `payment.succeeded` 仍转 `paid` 并建机 |
| A9 | 订单过期或已取消后首期款到账：**仍然建机**（无退款能力，收了钱必须交付） |
| A10 | 目录展示价 = Dodo 订阅产品价；把 `PLAN_PRICES_USD` 改错后结账报 `price_mismatch`，不建会话 |
| A11 | **Host 命令层**：未登录或登录过期时，`runtime_start` / `node_switch` / `node_probe` 以及本地已有配置不受影响；只有 `my_server_*` 管理命令返回 `auth_required`。界面部分留到整体 UI 重构 |
| A12 | Worker 日志、D1、客户端日志、`chat_messages` 均无验证码明文、无 Dodo key、无令牌 |
| A13 | 代码与配置里没有 TweetPilot 的 `pdt_…`；Veyl 订阅产品在同一个商户后台新建、test / live 各一套；Veyl 的 webhook secret 轮换不影响 TweetPilot |
| A14 | **续费顺延**：续费 `payment.succeeded` 的 `service_periods[].ends_at` 更新 `subscriptions.current_period_end` 与 `servers.paid_until`（只增不减）；**不建第二台、不改订单状态** |
| A15 | **取消**：`subscription.cancelled` 且期末失效 → `cancel_at_period_end = 1`；到 `current_period_end` 后进入 7 天宽限；`+7d` 后 `subscriptions.status = expired`，**服务器与本地凭据都还在**，`Cron` 没有销毁动作 |
| A16 | **宽限内恢复**：宽限期内收到续费 `payment.succeeded` → 状态回 `active`、停用标记清除、`current_period_end` 顺延 |
| A17 | **乱序**：先发 `renewed` 再发更旧的 `active`，`current_period_end` 不回退；先发 `cancelled` 再发更晚的 `payment.succeeded`，状态保持 `cancelled` 但 `paid_until` 顺延 |

---

## 8. 非目标与到期策略

| 不做 | 说明 |
|---|---|
| Turnstile | 参考实现因国内访问不稳定已禁用，本期不启用；靠冷却 + IP 限频 + 每码 3 次 |
| 退款 | 本期无退款入口；支付成功但建机失败 → 重试 / 补建，不退款（已知风险，M2 补） |
| 自动扣款重试策略（dunning） | 交给 Dodo 自身的重试与事件链（`payment.failed → past_due → on_hold / cancelled`），我们只按事件改状态，不自建重试 |
| 发票 / 税务 / 对账 | M2 |
| 订阅套餐变更（升级 / 降级） | `subscription.plan_changed` 只记录并告警，不改状态 |
| 应用内订阅管理 | 取消、改支付方式走 Dodo 托管 Customer Portal，不在应用里做入口 |
| 到期自动回收机器 | **不自动销毁**：7 天宽限后只标记停用，实例与凭据都保留 |
| 真实停用隧道 | 本期只做状态标记（§4.9）；M2 用短期凭据或 `veyl-agent` 指令实现真停用 |
| 多设备管理 / 改邮箱 / 注销账户 | M2 |

**到期策略（2026-11-15 拍板）**：`current_period_end + 7 天` 为宽限终点。宽限内续费立即恢复；宽限结束后状态标为失效，**不删机器、不删凭据、不停止计费**。代价是我们继续为到期用户付云厂商费用（约 $4–12/月/台），这是为了不误删用户仍在使用的服务器而接受的成本；M2 引入短期凭据后才能做到「到期即断」。



---

## 9. 待核（实现前核实）

| # | 事项 | 影响 |
|---|---|---|
| 1 | Dodo webhook 是否原样回传 `metadata`（`order_id`） | 决定匹配主路径；不回来就靠 `checkout_session_id`（当前按此设计） |
| 2 | 取消行为两个后台开关的**实际字段名与默认值**（`cancel_at_next_billing_date`？） | 决定「立即失效 / 期末失效」的判定；已有时间兜底（§4.3.1） |
| 3 | 订阅产品是否必须配置试用期；我们要求**无试用** | 有试用会出现「active 但无扣款」，当前不建机 |
| 4 | `payment.succeeded` 载荷是否稳定包含 `service_periods[].ends_at` | 周期基准；缺失就回落到 `subscription.next_billing_date` |
| 5 | `subscription.updated` / `renewed` 里 period_end 的字段名 | 乱序时能否正确推进（只增不减） |
| 6 | Dodo webhook 的重投策略与超时 | 决定是否必须 `waitUntil` 与 Cron 兜底 |
| 7 | Resend 发件域名在主要邮箱服务商的送达率 | 验证码到不了 = 登录不可用 |
| 8 | Workers `waitUntil` 内调用 DigitalOcean 建机的时长上限 | 超过则改为 Workflow / 队列 |
| 9 | 6 位码 + 3 次上限 + IP 20 次/小时是否足够防刷 | 不够再评估图形验证（不用 Turnstile） |
| 10 | Dodo 是否支持按用途建多个 API key（Veyl 单开一把） | 决定用单开还是共用商户 key；共用影响见 §5.1 |

---

## 10. 落地清单

| 侧 | 改动 |
|---|---|
| **控制面** | `src/auth_email.ts`（发码 / 校验 / 合并 / 登出）、`src/payments/dodo.ts`（订阅会话 / 验签；产品表按 `ENVIRONMENT` 切）、`src/webhooks/dodo.ts`（14 个事件映射 + 三层幂等）、`src/subscriptions.ts`（状态机 + 宽限判定）、`src/orders.ts`（状态机 + 售价校验 + 去掉同步建机）、`src/index.ts`（路由）、迁移 `0003_login_payment.sql`（`email_codes` / `payments` / `subscriptions` / `webhook_events` / `unmatched_payments` / `orders.checkout_session_id` / `orders.subscription_id` / `servers.paid_until` / `unique(servers.order_id)`） |
| **Rust Host** | `control_plane/auth.rs`（登录 / 登出 / account_kind）、`control_plane/orders` 轮询、`my_server_login_*` / `account` / `logout` / `order_get` 命令、`my_server_checkout` 返回 `checkout_url` 并由 Host 打开系统浏览器（界面未上线前不依赖前端）；订阅状态与宽限文案在 UI 重构时接入 |
| **React UI** | **本轮不做，等整体 UI 重构**：统一登录弹窗、左栏底部账号块（§3.6）、`我的服务器` 未登录空态、支付等待页（打开收银台 / 继续支付 / 取消）、`payment_failed` 与 `expired` 文案、到期提示条 |
| **契约** | `commands.md` 2.27.0（5 新增 + 1 改）；`check-contracts.mjs` 会以 advisory 形式提示「文档有、实现没有」，实现落地后转绿 |
