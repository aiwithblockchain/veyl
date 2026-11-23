# 软件订阅（M2）

> 日期：2026-11-22
> 状态：设计草案，待拍板；替换 `login-and-payment.md` 的预付费余额模型
> 关联：`docs/design/login-and-payment.md`（§4 充值、§4.8 共用商户）、`docs/design/payment-facts.md`、`docs/design/byo-digitalocean.md`
> 范围：设计稿与契约增量；不含实现代码

---

## 0. 结论先行

| # | 问题 | 结论 |
|---|---|---|
| 1 | 卖什么 | **桌面客户端的使用权**（订阅制）。不卖服务器、不卖流量、不代收机器费 |
| 2 | 为什么改 | 现模型同时命中三家支付平台的禁止/受限清单：VPN、转售基础设施、预付余额。软件订阅去掉后两条 |
| 3 | 计费单位 | **账号级订阅**，与服务器台数解耦；用户建几台由他自己的云账号决定，我们不管 |
| 4 | 权益落点 | 落在**控制面服务**，不落在客户端二进制。客户端开源（Apache-2.0），纯本地 license 可被绕过，付费必须对应服务 |
| 5 | 两档 | `free` / `pro`。Pro 的核心价值是「一键把用户自己的服务器变成可用节点」（见 `byo-digitalocean.md`） |
| 6 | 试用 | 账号级 7 天试用，**不绑卡**；到期自动降 free，不删数据 |
| 7 | 支付 | 托管收银台 + **系统浏览器** + 深链回跳。不内嵌卡表单 |
| 8 | 通道 | 新主体独立开户：Dodo（若类目放行）→ Polar → Paddle → Stripe。**不与 TweetPilot 共用商户** |
| 9 | 数据 | 新增 `subscriptions` / `entitlements`；`topups` / `wallet_ledger` / 按天扣费 Cron 全部停用 |
| 10 | 停机责任 | 机器停机归 DO 账单；我们只按订阅状态限制**客户端云功能**，从不碰用户的 droplet |

---

## 1. 为什么必须换形态

三份政策的原文（2026-11-22 核对）：

| 平台 | 条款 | 状态 |
|---|---|---|
| Dodo | "VPN, VPS or dedicated servers, hosting plans, cloud compute credits, bandwidth reselling…"（Merchant Acceptance「Hosting, servers, and infrastructure services」） | **禁止** |
| Dodo | "anything involving stored value, lending, or managing funds"（§7） | **禁止** |
| Paddle | "VPN and Proxies (Restricted Category)"（AUP 第 19 项） | 受限，需增强尽调 |
| Polar | "VPN, VPS & VDS services" | 受限，需进一步审核 |

现模型三条全中：运行代理的客户端（VPN）、用我们的 DO 账号代建机器再按天卖（转售基础设施）、充值进余额再逐日扣（stored value）。

软件订阅之后：

- ❌ 不再代建、不再转售 compute → 该条的后半段不成立
- ❌ 不再持有用户余额 → 第 7 条不成立
- ⚠️ 「VPN 客户端」仍是一条灰区，见 §4.4

---

## 2. 卖什么，不卖什么

| | 卖 | 不卖 |
|---|---|---|
| 软件 | 客户端使用权、云编排功能、后续更新 | — |
| 服务器 | — | 不代建、不转售、不代收 |
| 流量 | — | 不中转、不计量、不分发 |
| 凭据 | — | 不持有用户的云 API token（见 `byo-digitalocean.md` §7） |

用户与云厂商（当前是 DigitalOcean）之间是独立的商业关系：他自己注册、自己绑卡、自己付账单。我们是**工具提供方**，不是基础设施提供方。这句话要同时出现在站点、表单描述和订阅页上，口径一致。

---

## 3. 订阅与权益

### 3.1 状态机

```
trialing ──(到期未订阅)──> expired
    │
    └──(付款成功)──> active ──(扣款失败)──> past_due ──(宽限 3 天)──> expired
                        │                      │
                        │                      └──(补款成功)──> active
                        └──(用户取消)──> canceled（到期失效，不立即断）
```

- `past_due` 期间**权益不降级**，但界面顶部提示「支付方式需要更新」
- `expired` 之后降为 `free`，**不删任何数据**（节点配置、AI 设置、历史都在）
- 续费失败的重试交给支付通道（Dodo / Polar 各自有 dunning），我们不自己重试扣款

### 3.2 两档权益

| 能力 | free | pro |
|---|---|---|
| 连接 / 切换 / 本地 AI（自带 Key） | ✅ | ✅ |
| 手动导入节点、编辑配置 | ✅ | ✅ |
| 连接自己的云账号、一键建机 | ❌ | ✅ |
| 节点组云同步 | ❌ | ✅ |
| 手机导出（导入码） | ❌ | ✅ |
| 诊断记录云端留存 | ❌ | ✅ |

分档原则：**凡是需要控制面持续存在的，放 pro；纯本机能力，free 到底。** 这样开源不伤商业，闭源部分也小。

### 3.3 权益签发与缓存

- 控制面签发 `entitlement`（含 `plan`、`expires_at`、`sub_id`），签名算法复用现有 Ed25519（`TOKEN_SIGNING_JWK`）
- 客户端缓存到本地，**离线宽限 7 天**：断网期间按缓存判定，超过 7 天未联网刷新则降 free
- 刷新时机：登录时、启动时、每次建机前

---

## 4. 支付

### 4.1 托管收银台，不内嵌

- 点击「订阅」→ 系统浏览器打开通道的托管收银台 → 支付完成 → 回跳 `veyl://billing/return`
- 内嵌卡表单不做：PCI 范围会从 SAQ A 升到 SAQ A-EP，且桌面 webview 里的支付表单容易被当成钓鱼
- 改卡、取消、开发票：跳通道的 customer portal，同样回跳

### 4.2 Webhook 驱动状态

- 只订阅必要事件：订阅创建 / 续费成功 / 支付失败 / 取消
- 幂等键：`subscription_id + period_start`，重复投递不重复入账
- 签名校验各自实现（Dodo 用 `webhook-id` + 签名；Polar 用其标准签名头）
- `past_due → active` 的恢复必须由 webhook 驱动，不靠客户端轮询

### 4.3 通道矩阵

| 通道 | 费率 | 类目风险 | 用途 |
|---|---|---|---|
| **Dodo** | 4% + 40¢（+1.5% 国际） | 已明确禁止 VPN/VPS；软件订阅是否放行**需书面确认** | 若放行，首选（最便宜） |
| **Polar** | 5% + 50¢（Starter） | VPN 属受限，需审核；马来西亚主体已确认支持 | 次选 |
| **Paddle** | 5% + 50¢ | Restricted Category，需增强尽调；单笔 <$10 可谈 custom pricing | 第三 |
| **Stripe** | 3% + RM1（马来西亚） | 未列 VPN；但**不是 MoR**，税务自担 | 兜底 |

### 4.4 类目风险不消失

软件订阅把「基础设施转售」和「预付余额」两条去掉了，但「VPN 客户端」仍在灰区：

- 该条的标题是 "Hosting, servers, and infrastructure services"，正文列的却是 "VPN, VPS or dedicated servers"——**卖的是软件还是服务，是有理由争议的**，但 Dodo 有权自己判断
- Paddle 和 Polar 的 "VPN and Proxies" 没有任何限定词，客户端软件大概率同样被归入

**结论：不能假设换形态就自动能过。** 申请时如实描述「桌面客户端，用户自带云账号」，由对方判断；被拒就换下一家。不要为了过审把产品描述写模糊——事后对不上比被拒更糟。

### 4.5 商户归属

- **新主体（马来西亚公司）单独开户，不与 TweetPilot 共用**
- 理由：共用账户时风控是账户级的，Veyl 的任何类目问题都会连带影响另一条收入
- 如果通道只允许「同一实体一个账户」，那就让 TweetPilot 留在旧账户、Veyl 用新账户，两边各自独立

---

## 5. 计费口径

| 项 | 口径 |
|---|---|
| 价格 | 月付 / 年付两档。按 Dodo 的 6% + 40¢（4% + 1.5% 国际 + 0.5% 订阅）测算：**$3/月 → 19%**、**$6/月 → 13%**、**$39/年 → 7%**。建议 **月付 $6、年付 $39，主推年付**；固定费用是 40¢，客单价越低越吃亏 |
| 试用 | 7 天，不绑卡；试用期内不限制 pro 功能 |
| 宽限 | `past_due` 3 天；3 天内权益不变 |
| 取消 | 立即取消续费，当前周期用完失效 |
| 退款 | 跟随通道的 MoR 政策；我们不承诺额外的「按天退」——那正是 stored value 的形状 |
| 年付转月付 | 到期切换，不退差价 |
| 币种 | USD 计价；通道负责本地化与税费 |

---

## 6. 数据模型与迁移

### 6.1 新增

```sql
CREATE TABLE subscriptions (
  id              TEXT PRIMARY KEY,        -- sub_…
  account_id      TEXT NOT NULL,
  provider        TEXT NOT NULL,           -- dodo / polar / paddle / stripe
  provider_sub_id TEXT NOT NULL,
  plan            TEXT NOT NULL,           -- pro
  interval        TEXT NOT NULL,           -- month / year
  status          TEXT NOT NULL,           -- trialing / active / past_due / canceled / expired
  current_period_end INTEGER NOT NULL,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE UNIQUE INDEX subscriptions_provider_sub ON subscriptions(provider, provider_sub_id);

CREATE TABLE entitlements (
  account_id  TEXT PRIMARY KEY,
  plan        TEXT NOT NULL,               -- free / pro
  source      TEXT NOT NULL,               -- subscription / trial / grant
  expires_at  INTEGER,                     -- NULL = 不过期（free）
  updated_at  INTEGER NOT NULL
);
```

### 6.2 停用（不删表）

`topups`、`wallet_ledger`、`orders` 的按天字段与扣费 Cron 全部停用。**已应用的迁移只追加、不改写**（见 `docs/design/*` 的迁移纪律），新迁移只新增表和索引。

### 6.3 客户端与契约

- 删除「余额 / 充值」界面与相关命令
- 新增：`GET /v1/subscription`、`POST /v1/subscription/checkout`、`GET /v1/entitlement`
- `commands.md` / `data-model.md` / `tools.md` 各自升版，变更点在实现前先落契约

---

## 7. 客户端界面

- 位置：设置 › 账户 › 订阅（与登录同页）
- 三种状态各一套文案：试用中（剩余天数）、生效中（下次续费日 + 管理入口）、已过期（升级入口 + 说明哪些功能被限制）
- 被限制的功能不隐藏，**显示为锁定态并给出升级入口**——隐藏会让人以为是 bug
- 离线时显示缓存状态 + 「上次校验时间」

---

## 8. 验收

1. 试用期内可以建机；到期后建机入口变为锁定态，其他功能不受影响
2. 支付成功 → webhook → `active` → 客户端 30 秒内刷新权益
3. 支付失败 → `past_due` → 界面提示 → 补款成功 → 恢复 `active`
4. 断网 7 天内按缓存判定；超过 7 天降 free
5. 取消后当前周期内权益不变，到期降 free，数据不丢
6. 重复 webhook 不产生重复状态或重复通知
7. 不支持「余额」「充值」的界面残留；代码里没有按天扣费的调度

---

## 9. 未决

| # | 问题 | 影响 |
|---|---|---|
| 1 | 免费节点池是否保留 | 保留就意味着我们仍在提供代理服务，与本次改形态的初衷冲突；建议取消，试用改为「软件试用」 |
| 2 | 定价 | $6/月、$39/年 是建议值，需要验证转化 |
| 3 | 试用是否要求邮箱验证 | 现在是邮箱验证码登录，默认已验证 |
| 4 | 是否有一次性买断档 | 开源客户端的买断很难防绕过，除非买断也只解锁控制面服务 |
| 5 | Dodo 对「VPN 客户端」的书面答复 | 决定首选通道是否成立 |
