# 支付事实核对：订阅 webhook 与 DO 调价

> 日期：2026-11-15
> 状态：事实核查结论，供设计与实现引用；不含代码改动
> 关联：`docs/design/login-and-payment.md`（§4.3 webhook、§4.4 售价、§5.1 secrets、§9 待核）
> 来源分级：**[文档]** = Dodo / DigitalOcean 官方文档写明；**[后台]** = 后台界面可见（本次未登录后台验证）；**[推断]** = 文档未写、按行业惯例推断；**[未核实]** = 查不到权威说法。

---

## 0. 一页结论

| 问题 | 结论 | 来源 |
|---|---|---|
| 订阅 webhook 事件名 | 12 个 `subscription.*`，见 §2.1 | [文档] |
| 首期付款发几个事件 | `subscription.active` 先到，`payment.succeeded` 随后（2–10 分钟），两条都发 | [文档] |
| 建机触发点选哪个 | **`payment.succeeded`**：只有它代表真收到钱；试用期只有 active 没有 payment | [文档]+[推断] |
| 续费有效期看哪个字段 | `payment.service_periods[].ends_at` 最权威；`subscription.renewed.next_billing_date` 是 ISO 8601 字符串 | [文档] |
| 扣款失败 | `payment.failed` → 有宽限期则 `subscription.past_due` → 宽限期结束 `subscription.on_hold` 或 `subscription.cancelled` | [文档] |
| 取消 | `subscription.cancelled`；立即 or 期末由后台两个开关控制，默认两个都允许 | [文档] |
| checkout 是否适用订阅 | 是，`POST /checkouts` 通用；`subscription_data` 可选 | [文档] |
| checkout metadata 是否回传 | 文档只写「存储」，回传未写明 | [未核实] |
| 客户自助取消入口 | 有托管 Customer Portal，默认允许立即取消 | [文档] |
| DO 调价是否影响已开机器 | **官方文档没有明文** | [未核实] |
| 建机计费口径 | **按天扣费；余额 ≥ 日价 × 7 才能建机；下单不扣费，就绪后扣第 1 天；销毁退未用整天** | 产品拍板 2026-11-18（§5.6） |

---

## 1. DigitalOcean 调价问题

### 1.1 查到的事实

- **[文档]** Droplet 按秒计费，最低 60 秒或 $0.01；月底按上一个计费周期出账；bundled CPU 每月封顶 672 小时（28 天）。（`docs.digitalocean.com/products/droplets/details/pricing/`、`digitalocean.com/pricing`）
- **[未核实]** 查了 `digitalocean.com/pricing`、`docs.digitalocean.com/products/billing/`、`docs.digitalocean.com/products/droplets/details/pricing/`、support FAQ，**都没有「价格调整是否作用于已存在 Droplet」的明文**。既不能假设老机器一定保价，也不能假设一定跟着涨。
- **[文档]** 计费只看资源「存在」，关机不停止计费；只有销毁才停止。

### 1.2 对 Veyl 意味着什么

- 成本是变量，售价 = 成本 × 1.5 是**策略**，不是常量。
- 现有实现里，DO 涨价**不会**自动改两样东西：
  1. 我们的售价 `PLAN_PRICES_USD`（目录展示 + 下单价）；
  2. Dodo 产品价（实收价）。
  两者都要人改，不改就静默吃毛利。
- **[推断]** 改 Dodo 产品价后，已存在的订阅大概率沿用创建时的价格（grandfathering）；文档没写，需实测。这意味着：**老用户付旧价、我们付新成本**，差价是商业决定。

### 1.3 建议机制（按优先级）

1. **成本监控（必做）**：定时任务每周拉一次 DO `/sizes`，与 `PLAN_PRICES_USD / 1.5` 比对；差异超过阈值就告警（邮件 / 日志），**不自动改价**。改价直接影响用户，必须人拍板。
2. **一键同步（推荐）**：脚本读 DO 成本 → 按倍率算售价 → `PATCH /products/{id}` 更新 Dodo 产品价 + 校验 `PLAN_PRICES_USD`。产品 ID 不变，不重建、不换 ID。
3. **不写死绝对价**：写死在代码里而不监控，等于把 DO 成本上涨的风险藏起来。售价放 vars 是对的，但要有监控兜底。
4. **老用户是否跟着涨**：技术上改产品价只影响新订阅（[推断]）；商业上建议老用户至少保价一个续费周期，避免投诉。

### 1.4 待办

- 向 DO 支持确认「调价是否影响已存在 Droplet」，或开一台低价测试机观察一次调价事件。
- 在 `PLAN_PRICES_USD` 旁注明倍率来源（成本 × 1.5），避免以后有人只改一个数。

### 1.5 计费粒度结论（2026-11-16 拍板：按天）

基于 §1.1 的三条事实，2026-11-16 的计费粒度评审结论：

| 结论 | 依据 |
|---|---|
| 计费粒度**不改变我们的成本** | DO 按秒计费、月度封顶 672 小时、关机不停止计费——只要机器在，我们付的就是封顶价。改粒度只改变「用户没用满一个月能不能少付」 |
| 所以改粒度是**让利**，不是省钱 | 用户用得短就少收，短的那部分由我们让出来 |
| 「余额扣穿就停机」与粒度**无关** | 只有 destroy 才让我们停止付钱；本期选择不删机器，代价写在 `login-and-payment.md` §8 |
| 选**按天**，不选按小时 | 月价 ÷ 720 不是整数分（$6 → 0.833 分/小时），每小时一笔整数分账记不出来；账本量也是按天的 24 倍（一台机每月 720 行 vs 30 行），且 Cron 要从每天一次改成每 10 分钟分批跑 |
| 「每小时只记差额」不采用 | `balance_after_cents` 会失去逐行可解释性，界面按小时变、账本按天记，出问题无法对账；而这个量级（1000 台 / 2.2M 行/月）根本不需要省 |

细则见 `docs/design/login-and-payment.md` §4.1、§4.6、§4.7。

---

## 2. 订阅 webhook 事实

### 2.1 事件名（[文档]，来自 Create Webhook 的 `EventType` 枚举，共 58 个）

订阅相关 12 个：

```
subscription.active
subscription.renewed
subscription.on_hold
subscription.past_due
subscription.paused
subscription.unpaused
subscription.cancelled
subscription.failed
subscription.expired
subscription.plan_changed
subscription.updated
subscription.update_payment_method
```

支付相关：`payment.succeeded` / `payment.failed` / `payment.processing` / `payment.cancelled`。
其它可能有用的：`refund.*`、`dispute.*`、`invoice.*`、`dunning.started` / `dunning.recovered`、`abandoned_checkout.detected` / `.recovered`。

订阅状态枚举（[文档]）：`pending` / `active` / `on_hold` / `paused` / `cancelled` / `failed` / `expired` / `past_due`。

### 2.2 首期付款：两条都发，用哪条建机

- **[文档]** 首次结账：客户授权支付方式后先发 `subscription.active`；真正的首笔扣款由 `payment.succeeded` 确认，结账后 **2–10 分钟**内到。
- **[文档]** 有试用期时，结账只产生 **$0 的授权（mandate），不发生扣款**，所以只有 `subscription.active`，没有 `payment.succeeded`。
- **结论：建机触发点用 `payment.succeeded`。** 它带金额、`payment_id`、`service_periods`，能直接落 `payments` 表；用 `subscription.active` 会在试用期误建机。
- `subscription.active` 的用途：记录 `subscription_id` 和 `next_billing_date`，别急着交付。授权失败会发 `subscription.failed`，这条是终态，不交付。

### 2.3 续费：事件与「本期有效到什么时候」

- **[文档]** 续费成功时 `payment.succeeded` 与 `subscription.renewed` **同时**到达。
- **[文档]** `subscription.renewed` 带更新后的 `next_billing_date` 和 `payment_id`（其它订阅事件的 `payment_id` 为 `null`）。
- **[文档]** `payment.service_periods[]` 里有 `subscription_id` / `starts_at` / `ends_at` / `proration_factor`，这是**权威有效期**；文档明确警告「renewal 不一定延长访问，先检查 `service_periods`」。
- **[文档]** 订阅对象字段：`next_billing_date` 是 **ISO 8601 date-time 字符串**（不是 Unix 整数），含义是「本期结束时间」；`previous_billing_date` 是「本期开始时间」。没有 `current_period_end` 这类字段。
- **结论**：`paid_until` 取 `service_periods[].ends_at`；缺失时退回 `subscription.renewed.next_billing_date`，按 ISO 8601 解析。

### 2.4 失败与取消

| 场景 | 事件 | 状态 | 访问 |
|---|---|---|---|
| 扣款失败 | `payment.failed`（文档称「检测失败最可靠的方式」） | payment `failed`，带 `error_code` / `retry_attempt` | 视订阅是否进入宽限 |
| 宽限期开始 | `subscription.past_due` | `past_due` | 继续，直到 `past_due_ends_at` |
| 宽限期结束未付 | `subscription.on_hold` 或 `subscription.cancelled`（后台可选） | `on_hold` / `cancelled` | 停止 |
| 恢复 | 更新支付方式后自动扣欠款并重新激活，发 `subscription.active` | `active` | 恢复 |
| 用户取消 | `subscription.cancelled` | `cancelled` | 立即或期末，见下 |
| 到期 | `subscription.expired` | `expired` | 不可恢复，需重新订阅 |

- **[文档]** 取消时机由后台 **Settings → Subscriptions** 两个开关决定：**Allow Immediate Cancellation**（默认开）、**Allow Cancellation at Next Billing Date**（默认开）。两个都可开。
- **[文档]** 订阅对象有 `cancel_at_next_billing_date: boolean`，表示已排期「期末取消」。
- **[推断]** 排期取消时，`subscription.cancelled` 在期末生效时发送；立即取消则立刻发送。文档没逐字说明，需实测。
- **对我们**：默认两个都允许，意味着用户可以在月中立即取消并失去访问，而服务器已交付。要么关掉「立即取消」，要么规定「取消后保留到 paid_until」。
- **[文档]** 宽限期默认关闭，开后在 1–30 天可选。扣款重试：每笔续费最多 3 次人工重试，间隔 1 小时 / 3 小时。

### 2.5 Checkout

- **[文档]** `POST /checkouts` 对订阅产品同样适用（「Unified endpoint for all types of billing requirements」）。
- **[文档]** 必填只有 `product_cart`（每项 `product_id` + `quantity`）；`customer`、`return_url`、`subscription_data`、`metadata` 都可选。
- **[文档]** `subscription_data.trial_period_days` 0–10000；`on_demand.mandate_only` 为必填子字段。付费试用只能在产品上配 `trial_amount`，不能按会话传。
- **[文档]** `return_url` 回跳时会附加 `subscription_id` 和 `status`（订阅场景必有）。
- **[文档]** `metadata` 只写「自定义键值对，存储在会话上」，**没有文档化回传路径**；官方建议「以 webhook 为交付真相来源」。
- **结论**：metadata 是否出现在 `payment.succeeded` 里仍是 [未核实]（`login-and-payment.md` §9.1 判定维持）。订单匹配继续以 `checkout_session_id` 为主路径。

### 2.6 客户自助管理（Customer Portal）

- **[文档]** 有托管门户，按商户品牌展示。
- **[文档]** 入口：
  - Live：`https://customer.dodopayments.com/login/{business_id}`
  - Test：`https://test.customer.dodopayments.com/login/{business_id}`
  - 邮箱魔法链接，24 小时有效；**测试模式不发登录邮件**，测的时候用动态链接或 API。
  - 也可服务端调 API 生成动态链接（可带 `return_url`），或在后台 Sales → Customers → Share Invite 生成。
- **[文档]** 客户能做：看订阅与发票、改支付方式（会扣欠款并恢复 on_hold）、重试失败扣款（需开 Payment Retries）、暂停/恢复（默认关）、取消（默认允许立即与期末两种）、同 Collection 内换套餐。
- **对我们**：取消入口在 Dodo 侧，我们只能通过 webhook 感知；界面不做也行，但文案要说「可在 Dodo 账单页面管理」。

---

## 3. 对现有设计与实现的影响（待办清单）

| # | 现状 | 需要改成 |
|---|---|---|
| 1 | webhook 只认 `payment.succeeded` / `payment.failed` | 增加 `subscription.*`（至少 active / renewed / past_due / on_hold / cancelled / expired） |
| 2 | 以订单状态机驱动，`paid` 即结束 | `paid` 只是本期开始；续费延长 `paid_until`，取消/到期是另一套状态 |
| 3 | `servers.paid_until = paid_at + 30 天` | 改为 `service_periods[].ends_at`，缺失时用 `next_billing_date` |
| 4 | 一个 order 只建一台（`unique(servers.order_id)`） | 续费不得建第二台；续费事件只更新有效期与 `payments` |
| 5 | 到期只提醒不销毁 | M1 已定（2026-11-19）：**扣费失败即停机销毁、不可恢复**（§5.6、`login-and-payment.md` §4.11）；订阅模式下 Dodo 的宽限 / 重试是否沿用，M2 启用前再定 |
| 6 | 取消无处理 | 立即取消 vs 期末取消；建议关闭「立即取消」或保留到 paid_until |
| 7 | 产品价写死在后台 | 部署时从配置同步（§1.3），运行时保留 `price_mismatch` |
| 8 | 订单匹配靠 metadata / session id | metadata 回传未核实，继续以 `checkout_session_id` 为主 |

---

## 4. 未核实项（需要实测或问支持）

1. **DO 调价是否影响已存在 Droplet** —— 官方文档无明文，问了才能定。
2. **Dodo 改产品价后已有订阅是否跟随** —— 文档没写，用测试订阅验证。
3. **metadata 是否回传** —— 用 test mode 真实支付一次，抓 webhook。
4. **排期取消的事件时机** —— 期末发还是立刻发。
5. **首期 `payment.succeeded` 的 2–10 分钟延迟** —— 客户端轮询要能等，不能按秒断。

---

## 5. 支付方式与国内用户（2026-11-16 补）

> 决定收费模型：订阅自动续费对国内用户是否可用。来源同 §0 分级。

### 5.1 订阅 vs 一次性，可用通道不同

| 支付方式 | 订阅（自动续费） | 一次性 | 备注 |
|---|---|---|---|
| 卡（Visa/MC/Amex/Discover/JCB/**UnionPay**） | ✅ [文档] | ✅ | UnionPay 只是卡组织，不是独立通道 |
| **WeChat Pay** | ❌ [文档] | ✅ [文档] | 全球可用，USD / CNY，**单笔上限 1000 CNY 或等值 USD** |
| **支付宝（大陆）** | ❌ | ❌ | 文档里没有大陆支付宝 |
| **Alipay HK** | ❌ [文档] | ✅（仅香港，HKD）[文档] | 不是大陆通道 |
| PayPal | ❌ | ❌ | 文档：新交易暂停 |
| Apple Pay / Google Pay | ✅ [文档] | ✅ | 底层仍是卡 |

- **结论（文档写明）**：**微信支付只支持一次性付款，不支持订阅**；大陆支付宝不在支持列表。想让国内用户用微信付，只能走一次性。
- **[推断]** UnionPay 卡的订阅续费在文面上受支持，但境内发卡行的代扣/3DS 成功率需实测，不能只看文档。
- 订阅自动续费的事实通道 = 卡（含 Apple/Google Pay 背后的卡）。

### 5.2 币种与语言

- **[文档]** 本地化定价：产品可按币种（`by_currency`）或国家（`by_country`）设固定价，CNY 在支持列表内；后台产品页勾选 Localized Pricing 即可。
- **[文档]** 没配本地价时走 Adaptive Currency：按账单国家自动换汇成当地币种，买家可切回基准币种；默认在标价外加 2–4% 换汇费，开 Fees Inclusive 则由商户承担。
- **[文档]** 收银台支持 24 种语言，含中文（`zh`），可用 `customization.force_language` 强制中文。
- **[推断]** 中文只有单一 `zh` 代码，简繁是否区分未写明。

### 5.3 扣款失败与重试

- **[文档]** 自动重试默认**关闭**，在 Settings → Recovery 开启；只覆盖**续费**，首期授权、一次性付款、按需扣款都不重试。
- **[文档]** 标准排期最多 8 次（12h/24h/48h/72h/96h/120h/7d/7d），默认 13 天恢复窗口覆盖前 5 次；可自定义 1–8 次、总等待 ≤30 天。
- **[文档]** 硬拒绝立即终止重试链；之后由 Dunning 邮件提醒客户更新支付方式。
- **[文档]** 重试期间**不给客户发邮件**；商家侧无单独通知，**以 webhook 为准**（`subscription.past_due` / `on_hold` / `active`）。
- **[文档]** 客户可在 Customer Portal 自己「Retry Payment」或更新支付方式。

### 5.4 预付费余额（一次性固定面额）可行性

- **[文档]** 完全可行：一个面额一个一次性产品（如 $10/$20/$50），与 TweetPilot 的 token 档位同款；一次性产品支持 WeChat Pay。
- **[文档]** 也可用 Pay-What-You-Want 一次性产品 + `product_cart[].amount` 传任意金额（分为单位），但仍受微信单笔 1000 CNY 上限。
- **限制**：一次性付款没有自动续费与重试链；余额扣减、到期、退款逻辑全归我们。

### 5.5 对收费模型的判断

**已拍板（2026-11-16，用户 + PM）：M1 只做预付费余额，订阅暂不上线。** 原因是微信支付不支持订阅，而国内用户是核心。

| 方案 | 国内用户 | 国际用户 | 代价 |
|---|---|---|---|
| 纯订阅 | ❌ 微信不可用，只剩 UnionPay 卡 | ✅ | 国内用户基本转化不了 |
| **纯预付费余额（已选）** | ✅ 微信可付 | ✅ 卡可付 | 续费/到期/余额逻辑自己做 |
| 两条并存 | ✅ | ✅ | 两套产品、两套状态机（M2 再评估） |

- **[推断]** 预付费余额是覆盖国内用户的唯一低门槛通道；订阅可作为 M2 的国际卡用户补充，不是现在的事。
- 产品形态：固定面额一次性产品，一档一个，USD 定价，微信结账时自适应换汇。
- webhook 只需要 `payment.succeeded` / `payment.failed`；§2.1 的 12 个 `subscription.*` 事件本阶段不订阅。
- 待实测：UnionPay 卡订阅续费成功率（M2 再关心）；WeChat Pay 的退款与对账口径。
- `DODO_PRODUCT_IDS` 的键从套餐 slug 改为面额，具体形状等架构师设计；在此之前 `wrangler.jsonc` 保持现状不动。

### 5.6 计费口径三条（2026-11-18 拍板）

预付费余额模型下，三条口径同时成立、互不替代：

| # | 口径 | 规则 | 界面上怎么读 |
|---|---|---|---|
| 1 | 按天扣费 | **就绪时**扣第 0 天（`charged_cents` = 日价）；之后由每小时 :17（UTC）的 Cron 在到期前 1 小时扣下一天；**扣不动即停机销毁**（无宽限、无恢复）；机器详情按 `每天 $X · 本期有效至 …` 显示 | 用户为「用到的每一天」付钱，不预付整月 |
| 2 | 创建门槛 | `checkout` 要求余额 ≥ **日价 × 7**（`$1.40 / $2.10 / $4.20`），不够返回 `insufficient_balance`（`required_cents` / `shortfall_cents` / `min_days: 7`）；够门槛只确认下单、不扣费 | `余额不足，还差 $X。` + 去充值；例：余额 `$0`、1 GB 档（`$0.30/天`）→ 还差 `$2.10` |
| 3 | 销毁退款 | 只退「已扣但还没用到的整天」；销毁当天已经用掉，不退 | 退款是一条 `adjustment`，不新增命令 |

三者关系：

- **门槛 ≠ 预扣**：余额不会被冻结 7 天，`paid_until` 只到结算时刻 `+ 1d`（结算前为 `NULL`）；门槛只保证建出来的机器至少能按天跑一周，不会第二天就被停机销毁。
- **门槛 ≠ 最低消费**：当天销毁只损失第 0 天（`$0.20–0.60`），其余 6 天费用仍留在余额里。
- **门槛只在建机 / rebuild 时校验**：续费不设门槛，余额扣不动即停机销毁（`login-and-payment.md` §4.11）。
- **结算失败不产生扣款**：就绪时余额不足（并发把余额花掉）→ 删机、订单 `failed`、服务器 `error / settle_insufficient`，账本 0 行。

设计口径见 `login-and-payment.md` §4.1 / §4.4 / §4.14；契约见 `commands.md` §7.18（2.39.0）。


