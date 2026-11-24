# 支付迁移：Dodo → Stripe

> 日期：2026-11-23（定稿）；2026-11-24 补支付方式资格核实（§10.1）
> 状态：已实现，待 dev 实测
> 关联：`docs/design/billing-notes.md`（计费模型）、`docs/design/login-and-payment.md`（Dodo 时期的历史设计）、`docs/design/payment-facts.md`（Dodo 时期的事实记录）、`docs/design/us-entity-payment-setup.md`（主体与账户）
> 范围：只换支付适配层。业务模型、数据库形状、客户端计费逻辑都不变。

---

## 0. 一句话

**充值 → 余额 → 每天按档位扣减**这套不变，只把「建收银台」和「收款回调」从 Dodo 换成 Stripe。金额由控制面的面额白名单决定，用 Checkout 的 `price_data` 动态传，不在 Stripe 后台预建 Product / Price。

---

## 1. 已拍板

| # | 项 | 结论 |
|---|---|---|
| 1 | 充值档位 | **$12 / $24 / $36 / $48**（美分 `1200 / 2400 / 3600 / 4800`） |
| 2 | 商品名 | `Veyl SAAS服务额度` |
| 3 | 计价币种 | **USD**；一次性付款，不订阅 |
| 4 | 收款主体 | **美国 LLC 的 Stripe 账户**（test 模式已可用） |
| 5 | 金额来源 | 控制面代码里的档位白名单 + `price_data`，**不建 Product / Price ID** |
| 6 | 商品目录 | Stripe 后台不手工建商品；Dashboard 的 `Setup guide` 浮窗忽略 |
| 7 | 支付方式 | 卡、Apple Pay / Google Pay 默认；**支付宝**可申请（「Cloud Service」与「Prepaid cards and top-ups」属 Alipay 受限类目）；**微信支付**的禁用类目明确包含 VPS / 云服务器，不作为可依赖通道（§10.1） |
| 8 | 回跳 | 控制面 `GET /payment/return?session_id={CHECKOUT_SESSION_ID}`；只做提示，不写库 |
| 9 | 入账依据 | 本地 `topups.denomination_cents`；**不看** `amount_total` |
| 10 | 对账 | `metadata.topup_id` → `client_reference_id` → `topups.checkout_session_id` |
| 11 | 自定义金额 | **不做**。前端只能从服务端返回的档位里选 |

### 1.1 为什么用 `price_data`，不预建 Price ID

| 维度 | `price_data`（采用） | 预建 `price_…`（不采用） |
|---|---|---|
| 后台配置 | 零配置，test / live 代码一致 | 两套环境各建 4 个 Price，再维护映射 |
| 改档位 | 改控制面一行配置 | 去后台新建 Price，再换代码配置 |
| 金额安全 | 服务端白名单，前端只传 `denomination_cents` | 同样安全，但多一层 ID 映射 |
| 代价 | Stripe 后台没有策展过的商品目录；按商品的报表只能靠 metadata | 后台报表天然按 Product 分组 |

面额固定、只有四档、不做优惠券限定商品，这个代价可以接受。将来如果要做「优惠券只能用于某一档」、Stripe Tax 的 product tax code 或 Payment Links，再改成预建 Price 不迟。

---

## 2. 配置

| 现在（Dodo） | 改为（Stripe） | 说明 |
|---|---|---|
| `DODO_API_KEY` | `STRIPE_SECRET_KEY` | `sk_test_…` / `sk_live_…`；test 与 live 不混用 |
| `DODO_WEBHOOK_SECRET` | `STRIPE_WEBHOOK_SECRET` | `whsec_…`；**每个端点、每种模式各一个**，不能拿 test 的验 live |
| `DODO_TOPUP_PRODUCT_IDS` | `TOPUP_DENOMINATIONS_CENTS` | `"[1200,2400,3600,4800]"`，升序；这就是可充值面额的唯一真源 |
| `__DODO_API_BASE__`（编译期 define） | 删除 | Stripe test / live 用同一域名，靠 key 前缀区分 |
| `APP_PAYMENT_RETURN_URL` | 不变 | 必须是 https；生产当前是站点根，需改成控制面的 `/payment/return` |
| `PLAN_DAILY_PRICE_CENTS` | 同步为 `{"s-1vcpu-512mb-10gb":30,"s-1vcpu-1gb":40,"s-1vcpu-2gb":80}` | 2026-11-23 定；$12/24/36/48 在三种机器上都对应整天数 |

**wrangler**：

- 顶层与 `env.dev` 都删掉 `__DODO_API_BASE__`；`__WEBHOOK_SAMPLE__` 保留（dev 为 `"1"`）。
- 两套环境都写 `TOPUP_DENOMINATIONS_CENTS`，值相同；差别只在 secret。
- 生产与 dev 的 `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` 通过 `wrangler secret put` 设置，**不写进 `wrangler.jsonc`、不提交仓库**。

**客户端不需要新的环境变量**：`GET /v1/wallet` 继续返回 `denominations_cents`，前端按服务端给的档位渲染。

---

## 3. 建收银台

```
POST https://api.stripe.com/v1/checkout/sessions
Authorization: Bearer sk_test_… / sk_live_…
Content-Type: application/x-www-form-urlencoded
Stripe-Version: 2026-11-18.endive
```

`Stripe-Version` 固定写死，升级时单独改、单独测；不要跟随账户默认版本漂移。

### 3.1 请求参数

| 参数 | 值 | 说明 |
|---|---|---|
| `mode` | `payment` | 一次性付款 |
| `success_url` | `https://<控制面>/payment/return?session_id={CHECKOUT_SESSION_ID}` | `{CHECKOUT_SESSION_ID}` 是**字面占位符**，由 Stripe 替换；不要自己拼 |
| `cancel_url` | `https://<控制面>/payment/return?canceled=1` | 取消回跳带 `canceled=1`；页面据此显示「支付未完成」，不再与成功页混用 |
| `customer_email` | 账户邮箱 | 预填，用户仍可在收银台改 |
| `client_reference_id` | `topup_id` | 最长 200 字符；第二层匹配 |
| `metadata[topup_id]` | `top_…` | 第一层匹配 |
| `metadata[account_id]` | `acct_…` | 留证 |
| `line_items[0][quantity]` | `1` | 一档一件 |
| `line_items[0][price_data][currency]` | `usd` | |
| `line_items[0][price_data][unit_amount]` | `1200` / `2400` / `3600` / `4800` | 来自白名单，**不接受前端任意金额** |
| `line_items[0][price_data][product_data][name]` | `Veyl SAAS服务额度` | 收银台与收据上显示 |
| `line_items[0][price_data][product_data][description]` | `Veyl 云服务器管理服务的预付额度，仅限本服务消费，不退不转让。` | 可选，但建议保留 |
| `consent_collection[terms_of_service]` | `required` | 需要先在 Dashboard 配 ToS URL，见 §3.2 |

表单编码后的完整形状（值需按 UTF-8 百分号编码；中文商品名由 `URLSearchParams` / `encodeURIComponent` 处理）：

```
mode=payment
success_url=https://dev.veyl.dessage.xyz/payment/return?session_id={CHECKOUT_SESSION_ID}
cancel_url=https://dev.veyl.dessage.xyz/payment/return?canceled=1
customer_email=buyer@example.com
client_reference_id=top_...
metadata[topup_id]=top_...
metadata[account_id]=acct_...
line_items[0][quantity]=1
line_items[0][price_data][currency]=usd
line_items[0][price_data][unit_amount]=1200
line_items[0][price_data][product_data][name]=Veyl SAAS服务额度
line_items[0][price_data][product_data][description]=Veyl 云服务器管理服务的预付额度，仅限本服务消费，不退不转让。
consent_collection[terms_of_service]=required
payment_method_options[wechat_pay][client]=web
```

**不要传 `payment_method_types`。** 省略时 Stripe 按 Dashboard 里已启用的支付方式和客户地区动态给出；写死列表会漏掉后来在后台新开的方式。要收窄时用 `allowed_payment_method_types`（过滤器），不要用 `payment_method_types`（静态列表）。

**微信支付走 Checkout 时必须传 `payment_method_options[wechat_pay][client]=web`。** 代码对每次建会话都带上该字段；支付宝与卡不需要额外参数。**[待验证]** 未启用微信的账户是否接受该字段——若不接受，需要改成按环境开关。

### 3.2 结账同意

`consent_collection[terms_of_service] = "required"` 会在收银台显示 ToS 勾选框，**前提是 Dashboard → Settings → Public details 里已填 ToS URL**；没填时创建会话会报错。

法律口径（2026-11-23 定）：条款暂不受理 EEA / UK 订单，结账页展示并记录下面这段同意：

```
[ ] I agree to the Terms of Service and Refund Policy, and I confirm I am not located in the European Economic Area or the United Kingdom.
```

- 对应服务条款 §3 与退款政策 §3 的 EEA/UK 订单条款。
- 需留存：同意时间、订单号 / `topup_id`，以备争议时举证。Stripe 会话对象的 `consent` 字段会记录接受结果。
- 这句话不是 Stripe 原生的第二个勾选项。`consent_collection[terms_of_service]` 只能覆盖「同意条款」；「不在 EEA/UK」目前只能通过 `custom_text[submit][message]` 作为**告知**展示，或由 Radar 按账单国家 / 卡国家直接阻断。如果法律上必须有主动勾选，需要另做一步——见 §10。
- 结账页如做本地化，中文译文需与英文同源确认后再上，不要自行翻译。

#### 3.2.1 当前测试状态（2026-11-24）

EIN 未到，Stripe 账户未完成 Activate Payments，Dashboard 的 Public details 打不开，填不了 ToS URL；此时传 `required` 建会话会直接报错。当前做法：

- **仓库代码保持 `required`**，不提交任何「临时去掉」的改动，避免 dev / prod 出现两套逻辑。
- 需要部署 dev 时，在部署的工作树里临时删掉 `src/payments/stripe.ts` 的这一行，部署完成后立刻还原；dev 包因此不含它，仓库与生产代码仍是同一份。门禁仍按 `required` 跑，不因临时删除而改测试。
- 当前 dev 部署（`45470206`）就是这种临时包；**不要用「dev 能充值」推断 `required` 已验证**。
- **EIN 到位后必须补做，未完成不得上线**：Activate Payments → Public details 填 `https://veyl.dessage.xyz/en/legal/terms` → 在 test 模式用真实测试卡回归一次带 ToS 勾选的收银台（勾选后 `session.consent` 有记录）→ 再切 live。
- 这条临时状态是**部署动作，不是代码分支**；任何新会话都不应把删除后的文件提交。

### 3.3 地区限制

条款暂不受理 EEA/UK 订单，支付侧要做两层：

- **支付方式层**：支付宝 / 微信只对中国大陆客户可用（Stripe 侧限制），卡则是全球可用。微信支付还受其自有类目规则限制：VPS 与云服务器服务在禁用清单内，见 §10.1。
- **Radar 层**：按账单国家 / 卡国家阻断 EEA / UK。规则字段、优先级与误杀处理以 Radar 文档和实际测试为准，本文件不写死表达式。
- 先在 Test 模式验证「命中拒绝」与「正常放行」两个方向，再启用 Live 规则。
- 被拒订单不入账；资金仍到账的，按退款政策 §3 原路全额退款，不发放额度。

### 3.4 返回

Stripe 返回 `id`（`cs_…`）与 `url`（收银台地址）。现有代码里的 `sessionId` / `checkoutUrl` 两个字段名不用改，适配层把 `url` 映射成 `checkoutUrl`。**不是** `checkout_url`。

请求带 `Idempotency-Key: <topup_id>` 与 10 秒 `AbortSignal`：同一次充值的网络重试不会建出第二个 Session，上游挂住也不会拖死 Worker。

`success_url` 的占位符在表单编码后可能变成 `%7BCHECKOUT_SESSION_ID%7D`，Stripe 会按解码后的值替换；实现后必须用真实测试会话确认回跳 URL 里带上了 `session_id`，不能只看代码。

`/payment/return` 页面只做提示，不做任何写操作。入账只认 webhook（Stripe 官方也明确要求不能只靠成功页履约）。页面按四种状态展示：

- `canceled=1`：「支付未完成」，优先于 `session_id`；
- 有 `session_id` 且 Stripe 查询返回 `status=complete` 且 `payment_status=paid`：「支付完成」；
- 有 `session_id` 且 `status=complete` 但 `payment_status=unpaid`：「支付处理中」（微信 / 支付宝等异步方式，授权完成但尚未结算）；
- 没有 `session_id`，或 Stripe 查询失败 / 会话仍 `open` / 已 `expired` / 字段缺失 / 异常组合（如 `open`+`paid`）：中性的「支付流程已结束」。

回跳页只读查询 Stripe（`GET /v1/checkout/sessions/{id}`，5 秒超时），不写库、不回显 `session_id`、不打印 key。异步方式下 Stripe 会在授权完成后立即回跳，此时钱可能还没到账；页面必须如实显示处理中，不能仅凭 `session_id` 宣称完成。

---

## 4. 回调

路径：`POST /v1/webhooks/stripe`，公开端点，只认签名。

### 4.1 验签

| | Dodo（旧） | Stripe（新） |
|---|---|---|
| 头 | `webhook-id` / `webhook-signature` / `webhook-timestamp` | `Stripe-Signature: t=…,v1=…[,v1=…]` |
| 签名内容 | `${id}.${timestamp}.${body}` | `${t}.${rawBody}` |
| 算法 / 编码 | HMAC-SHA256，base64 | HMAC-SHA256，**hex** |
| 密钥 | `whsec_` 先 base64 解码 | `whsec_…` **原样作为字符串密钥**，不解码 |
| 容差 | 300 秒 | 默认 300 秒（5 分钟） |

实现要点：

- **raw body**：先 `await request.text()`，用原始字符串验签，再 `JSON.parse`；不要先解析再重新序列化。
- **体积上限**：`Content-Length` 或读到的 body 超过 256 KiB 直接 413，不读进内存。
- 头里可能有多个 `v1`（滚动密钥期间），**任意一个匹配即通过**。
- `v0`、`secret`、`destination`、`payload` 等条目可能与验签无关，**必须忽略**，且不能依赖条目数量或顺序。
- 常量时间比较；时间戳超出容差即拒绝。
- 事件 id 取自 payload 的 `id`（`evt_…`），不是请求头。

### 4.2 订阅的事件

只订阅四个：

```
checkout.session.completed
checkout.session.async_payment_succeeded
checkout.session.async_payment_failed
checkout.session.expired
```

**入账条件**：

| 事件 | 动作 |
|---|---|
| `checkout.session.completed` 且 `payment_status === "paid"` | 入账 |
| `checkout.session.completed` 且 `payment_status === "unpaid"` | 只记事件，不入账（异步方式还没到账） |
| `checkout.session.async_payment_succeeded` | 入账 |
| `checkout.session.async_payment_failed` | 把 `pending` 的 topup 标成 `failed` |
| `checkout.session.expired` | 把 `pending` 的 topup 标成 `failed` |
| 其它 | 记成 `processed`，返回 200 |

**入账前还要校验**：

- `event.livemode` 必须与 `ENVIRONMENT` 一致（production = true，其它 = false），不匹配返回 400，只记一条 error。
- `session.currency` 必须是 `usd`；否则写 `unmatched_payments`（`reason = "currency_mismatch"`），不入账。
- `session.amount_total` 存在且与本地 `topups.denomination_cents` 不一致时写 `unmatched_payments`（`reason = "amount_mismatch"`），不入账并告警；金额缺失时仍按本地面额入账。

### 4.3 卡与支付宝 / 微信的到账差异

- 卡：`checkout.session.completed` 到达时 `payment_status` 已经是 `paid`。
- 支付宝 / 微信：`completed` 可能先到、`payment_status` 是 `unpaid`；真正到账在 `async_payment_succeeded`。
- **所以不能在 `completed` 上无条件入账**，否则会出现「余额加了但钱没到」。

会话的计价币种由我们设为 USD，`amount_total` 也是 USD 分；支付宝客户看到的 CNY 金额是 Stripe 侧的展示换算。即便如此，入账仍以本地 `denomination_cents` 为准，不按 `amount_total` 重算。

### 4.4 匹配与幂等

1. `metadata.topup_id` 找本地 `topups` 行；
2. 再用 `client_reference_id`；
3. 最后用 `topups.checkout_session_id = session.id`。

- 事件去重：`webhook_events.id = event.id`；`processed` 的事件直接 200。
- 账本去重：`wallet_ledger` 的 `(ref_type, ref_id)` 唯一。`ref_type` 新增 `stripe_payment`，**`ref_id` 用本地 `topup.id`**（业务幂等键）；旧的 `dodo_payment` 行保留，不迁移。
- `payments.id` 取 `payment_intent`，没有就退回 `session.id`，再没有才用事件 id；重复投递靠 `INSERT OR IGNORE`。
- `webhook_events.payment_id` 用 payment_intent / session id（没有就 NULL），入账与不入账路径一致。
- `payments.id` 取 `payment_intent`，没有就退回事件 id；重复投递靠 `INSERT OR IGNORE`。
- 匹配不上：写 `unmatched_payments` 留证，返回 200，**不要让 Stripe 无限重投**。

### 4.5 返回码与重试

- 处理完成 / 忽略 / 匹配不上：**200**。
- 验签失败：**401**，`details.reason` 为 `missing_header` / `stale_timestamp` / `no_v1` / `mismatch`；只记原因码，不打印 secret。
- `event.livemode` 与环境不匹配：**400**。
- body 超过 256 KiB：**413**。
- 内部异常（D1 暂时不可用等）：**500**，让 Stripe 重投。Stripe 在 live 模式最多重试 3 天，sandbox 重试 3 次；与 Dodo 的「无限重投」不同，所以 `500` 可以留给真正的临时故障。

### 4.6 样本捕获

`lib/webhook_sample.ts` 的脱敏逻辑可以复用，但要做两处适配：

- 请求头 allowlist 增加 `stripe-signature`（值仍替换成 `***`）；
- id 占位前缀补 `evt_` / `cs_` / `pi_` 的形状，避免样本里出现真实 id。

捕获仍然只在 `__WEBHOOK_SAMPLE__ = "1"` 的包里存在，失败只 warn，不影响回调。

---

## 5. 代码落点

| 文件 | 改动 |
|---|---|
| `src/payments/stripe.ts` | **新增**：Checkout Session 创建 + Stripe 验签 |
| `src/webhooks/stripe.ts` | **新增**：四个事件的处理（含 `expired`）、匹配、入账、留证 |
| `src/topups.ts` | 注入从 `DodoEnv` 换成 `StripeEnv`；校验面额改为白名单；`product_id` 留 `NULL` |
| `src/lib/config.ts` | 删 `dodoProductId` / `topupProductId` / `dodoApiBase`；新增档位白名单读取 |
| `src/wallet.ts` | `refType` 联合类型增加 `"stripe_payment"`（保留 `"dodo_payment"` 供历史行） |
| `src/index.ts` | 路由改 `handleStripeWebhook`；`Env` 换 Stripe 字段；回跳页注释更新 |
| `src/env.d.ts` | 删除 `__DODO_API_BASE__` 声明 |
| `wrangler.jsonc` | 删 Dodo define / 产品映射；两套环境写 `TOPUP_DENOMINATIONS_CENTS`；secret 注释改 Stripe |
| `src/payments/dodo.ts` | **删除** |
| `src/webhooks/dodo.ts` | **删除** |
| `test/payments.test.ts` | 充值 / 回调段改 Stripe：`price_data` 请求体、Stripe 签名、四个事件、异步到账、重复投递 |
| `src/lib/webhook_sample.ts` | 头 allowlist 与 id 前缀适配 |
| `src/orders.ts` | 删掉未使用的 Dodo env 字段 |

`topups.product_id` 本来就允许为空（`migrations/0001_schema.sql`），**不需要新迁移**；迁移 0012 已应用到 dev 与 prod，与本轮无关。

---

## 6. 不需要改的东西

- `topups` 表结构与状态机（`pending / paid / failed`）。
- `wallet_ledger`、`recordLedgerEntry`、余额计算。
- `billing.ts` 的每日扣减、宽限、停机与销毁。
- 客户端「充值 → 余额」界面与轮询（`topup.opened` 文案已经是「付完回到这里，余额会自动刷新」）。
- `unmatched_payments` 的留证流程。
- `GET /v1/wallet` 的返回结构。

---

## 7. 退款与争议

| | 卡 | 支付宝 | 微信支付 |
|---|---|---|---|
| 退款窗口 | 按 Stripe 政策与发卡行 | 90 天 | 180 天 |
| 拒付 / 争议 | 可能有 chargeback | 无 | 无 |
| 退款速度 | 常规 | 约 5 分钟，异步 | 当日或次日批次，异步 |

- 退款用 Stripe Refunds API，人工发起；余额不退、不转让、不提现，退款政策另行约束。
- 支付宝 / 微信没有拒付，退款全部是人工发起，政策要写清楚。
- 本迁移只订阅 §4.2 三个 checkout 事件，**不处理退款事件**；退款状态在 Dashboard 或 Refunds API 查，不依赖 webhook 自动改余额。
- 被 Radar 拒绝但资金仍到账的订单，按退款政策 §3 原路全额退款，不发放额度。

## 8. 测试

1. **Test 模式建会话**：`TOPUP_DENOMINATIONS_CENTS` 四档都能建出 `cs_…` 与 `url`；5000 被拒。
2. **卡**：`4242 4242 4242 4242` 走通 `completed(paid)` → 入账 → 余额增加 → `topups.status = paid`。
3. **异步方式**（支付宝 / 微信，前提是 test 后台已启用）：`completed(unpaid)` 不入账；`async_payment_succeeded` 才入账。
4. **失败**：`async_payment_failed` 把 `pending` 的 topup 标成 `failed`。
5. **验签**：改坏签名 → 401；时间戳超出 5 分钟 → 401；`v0` 条目存在但 `v1` 正确 → 通过。
6. **幂等**：同一 `event.id` 重投不重复加钱；重复 `payment_intent` 不重复记账。
7. **匹配**：`metadata.topup_id` 缺失时退到 `client_reference_id`，再退到 `checkout_session_id`；都匹配不上写 `unmatched_payments` 并返回 200。
8. **充值后恢复**：`recoverExpiredServers` 仍生效。

本地联调：

```bash
stripe listen --forward-to localhost:8787/v1/webhooks/stripe
```

`stripe listen` 会打印本次的 `whsec_…`，把它设进本地 dev 的 `STRIPE_WEBHOOK_SECRET`。注意 `stripe trigger checkout.session.completed` 造出来的会话没有我们的 `metadata`，只会走到 `unmatched_payments`；验签路径可以用它测，完整入账要用真实创建的测试会话。

---

## 9. 切换步骤

1. 按 §5 落代码；`npm run typecheck`、`npm test`、契约检查全绿。
2. 在 dev 设置 secret：

   ```bash
   npx wrangler secret put STRIPE_SECRET_KEY --env dev
   npx wrangler secret put STRIPE_WEBHOOK_SECRET --env dev
   ```

3. 部署 dev；用真实测试卡完成一次充值 → 余额到账 → 建机扣费。
4. 在 Stripe 后台建 **live** webhook 端点 `/v1/webhooks/stripe`，订阅 §4.2 的 **4 个事件**；拿 live 的 `whsec_`。
5. 配 Radar 地区规则、ToS URL、支付方式；先用 test 模式验证命中与放行。
6. 换 live secret，部署生产；小额真实充值 → 余额到账 → 建机扣费 → 结算进入公司账户。
7. 确认 `payments/dodo.ts` / `webhooks/dodo.ts` 已删除，仓库与 wrangler 里没有 `DODO_*` / `__DODO_API_BASE__`。

现在没有真实交易，`topups` 里没有需要迁移的 pending 单。

### 9.1 上线前 Dashboard 校验

- **ToS URL**：Settings → Public details 填好；否则 `consent_collection[terms_of_service] = required` 建会话会失败（当前临时状态与 EIN 后的补做步骤见 §3.2.1）。
- **Radar**：按账单国家 / 卡国家拦截 EEA/UK 的规则，先在 test 验证「命中拒绝」与「正常放行」两个方向，再启用 live。
- **支付方式**：Dashboard 启用卡、Apple Pay / Google Pay；支付宝可申请（受限类目，审核可能要求补充材料）；微信支付可打开做技术验证，但其类目禁止 VPS / 云服务器，不作为可依赖通道（§10.1）。代码不传 `payment_method_types`，不要写死列表；启用微信时另传 `payment_method_options[wechat_pay][client]=web`。
- **Webhook 端点**：`https://<prod>/v1/webhooks/stripe`，只订阅 `checkout.session.completed` / `async_payment_succeeded` / `async_payment_failed` / `expired` 四个事件；每个端点用自己的 `whsec_`。
- **Live secret**：`STRIPE_SECRET_KEY` 必须是 `sk_live_`，`STRIPE_WEBHOOK_SECRET` 必须是 live 端点的 `whsec_`；`ENVIRONMENT=production` 时两者缺一不可（代码 fail closed，不建单）。
- **回跳 URL**：`APP_PAYMENT_RETURN_URL` 指向控制面 `/payment/return`，不是站点根。
- **商品与账单描述**：`product_data.name = Veyl SAAS服务额度`；statement descriptor 建议 `VEYL`（Dashboard 账户级设置，最多 22 字符）。

### 9.2 回滚与 Dodo 吊销

1. **停入账**：先把 Stripe live webhook 端点禁用或删掉订阅，停止新事件入账；保留 secret 与事件日志作为证据，不要先删。
2. **回代码**：把控制面回滚到上一版；确认新充值不再创建 Checkout 会话。已创建的 `pending` 充值单人工对账后再决定补账或退款。
3. **回 Dodo（仅必要时）**：恢复 Dodo 代码与 `DODO_*` secret，先处理 Stripe `pending` 单，再启用 Dodo webhook。**两套 webhook 不要同时启用**，否则同一笔可能被两个通道解释。
4. **Dodo 侧吊销**：停用 Dodo webhook 端点、吊销 API key、把 4 个一次性充值产品归档；确认没有再收到 Dodo 事件。
5. **Stripe 侧保留**：test 端点留给回归；live 端点在没有新代码前不要删除，避免 Stripe 重投堆积。

---

## 10. 支付方式资格与待确认

日价已在 2026-11-23 定为 **30 / 40 / 80** 美分/天，`wrangler.jsonc` 已同步。$12 / $24 / $36 / $48 在 512MB / 1GB / 2GB 上分别对应整天数：

| 档位 | 512MB（30/天） | 1GB（40/天） | 2GB（80/天） |
|---|---|---|---|
| $12 | 40 天 | 30 天 | 15 天 |
| $24 | 80 天 | 60 天 | 30 天 |
| $36 | 120 天 | 90 天 | 45 天 |
| $48 | 160 天 | 120 天 | 60 天 |

### 10.1 支付方式资格（2026-11-24 对照官方文档核实）

| 项 | 结论 | 来源 |
|---|---|---|
| 支付宝 · 账户资格 | 美国在支持国家列表；B2B / B2C 均可；仅一次性付款，不支持订阅 | [Stripe Alipay](https://docs.stripe.com/payments/alipay) |
| 支付宝 · 类目 | 「VPN and other illegal proxy services」禁止；「Cloud Service（含域名销售）」「Prepaid cards and top-ups」受限 | [Alipay 禁用与受限清单](https://stripe.com/legal/alipay) |
| 支付宝 · 币种与限额 | USD 计价可用，客户须在中国大陆；单笔 0.50–999,999.99 USD；退款 90 天内、异步、无拒付 | 同上 |
| 微信支付 · 账户资格 | 美国在支持国家列表；**仅 B2C**；仅一次性付款 | [Stripe WeChat Pay](https://docs.stripe.com/payments/wechat-pay) |
| 微信支付 · 类目 | 禁止清单明确包含「Virtual Private Network, Virtual Private Server」与「Cloud server service」；闭环预付 / 充值需预审 | [微信支付 Proper Use Rules](https://pay.weixin.qq.com/index.php/public/wechatpay_en/proper_rule) |
| 启用方式 | 两者都是 **Instant provisional access**：Dashboard 打开即临时可用，之后可能被审核调整 | Stripe 文档 |
| 费率 | 2.9% + 30¢；需要换汇时 +1%；$12 档约 6.4% | [本地支付方式费率](https://stripe.com/en-us/pricing/local-payment-methods) |
| 测试 | test 模式可模拟；微信扫码后跳到 Stripe 页面模拟授权 | [Checkout 接入](https://docs.stripe.com/payments/wechat-pay/accept-a-payment?payment-ui=checkout) |

**结论**：支付宝可申请，按「云服务 + 储值」受限类目准备补充材料；**微信支付与 Veyl 的交付物（VPS / 云服务器）直接冲突，不应作为可依赖的国内通道**。若微信是硬需求，只能走中国大陆主体 + 微信支付直连或服务商模式 + 对应类目资质，与美国 LLC 是另一套方案。

### 10.2 仍待确认

| # | 项 | 说明 |
|---|---|---|
| 1 | 支付宝审核结果 | 受限类目能否通过、需要哪些补充材料，以 Stripe / Alipay 实际答复为准 |
| 2 | 换汇成本 | 客户用 CNY 支付时的实际换汇价与费用，以首笔结算账单为准 |
| 3 | 预付额度与「转售基础设施」 | Stripe 把「卖家自发的虚拟额度 / 预付价值」列为受限类；「无增值的服务转售」列为禁止类。现在的模型是「充值 → 我们代建并卖机器天数」，Live 审核可能追问。如实描述，不要为了过审改写产品 |
| 4 | Radar 规则 | 按账单国家 / 卡国家拦截的具体字段、优先级、误杀处理，以 Radar 文档与实测为准 |
| 5 | 卡账单描述词 | 账户级 statement descriptor 在 Dashboard 设置，最多 22 字符，建议 `VEYL`；`product_data.name` 不影响这里 |
| 6 | EEA/UK 主动勾选 | 「不在 EEA/UK」目前没有 Stripe 原生勾选项；是否必须做主动勾选，需要法律口径确认。现方案是 `custom_text` 告知 + Radar 阻断 |
| 7 | 打款 | 美国账户首笔结算通常有观察期；具体天数以 Dashboard 为准，首月需垫资 |

---

## 11. 术语统一（面向用户叫「服务额度」）

> **单独一批，本批不做。** Stripe 迁移只换支付适配层；客户端「余额」文案、`orders.ts` / `servers.ts` 的展示文案仍保持现状，等术语批次统一改。不要做「余额 → 服务额度」的半批改动。

### 11.1 口径

| 场景 | 中文 | 英文 |
|---|---|---|
| 被购买的额度 | **服务额度** | **Service Credits** |
| 购买动作 | 充值 | Top up |
| 额度不够 | 服务额度不足 | Not enough Service Credits |

- **「充值」保留**：它描述购买动作，不是被购买的额度本身。
- **只改展示层**。API 字段、数据库列名、错误 `details.reason`、日志与内部文档继续用 `balance` / `余额` 指代同一个账本结果：`balance_cents`、`wallet_ledger.balance_after_cents`、`insufficient_balance` 都不改名。避免把一次文案调整扩大成数据迁移。
- 英文不逐字直译：`Balance` → `Service Credits`，`Balance is short` → `Not enough Service Credits`，句式按英文习惯调整。

### 11.2 改动位置

| 位置 | 具体 |
|---|---|
| 客户端 i18n（中文） | `src/i18n/zh.ts`：`account.balance`、`account.walletError`、`account.stale`、`topup.balance`、`topup.refreshBalance`、`topup.opened`、`serversPage.loginText`、`detail.destroyConfirm`、`wizard.billing`、`wizard.balanceShort`、`wizard.balanceShortBare`、`settings.account.balance`、`settings.account.billingNote`、`settings.consult.fact.balance`、`myservers.tombstone.text`、`myservers.billing.pastDueNoGrace`、`myservers.billing.pastDueGrace`、`myservers.billing.expired`、`app.billsNotice`、`tool.fact.server.destroyed.billingUnpaid`、`error.reason.insufficientBalance`、`error.reason.insufficientBalanceBare`、`error.reason.settleInsufficient`、`error.failure.billingUnpaid` |
| 客户端 i18n（英文） | `src/i18n/en.ts` 的**同名 key**；中英文必须同一批改，不能只改中文 |
| Host 固定串 | `src-tauri/src/tools/my_servers.rs`（`因余额不足停机删除`、`余额不足，已停机删除`，含工具描述）；`src-tauri/src/control_plane/error.rs`（`余额不足，服务器没有开通`）。这些会出现在界面与 AI 工具说明里，不能漏 |
| 控制面展示文案 | `cloudflare/control-plane/src/index.ts` 的 `/payment/return` 页：`余额变化` → `服务额度变化`；`orders.ts` 的 `余额不足，先充值`；`servers.ts` 的墓碑原因 `余额不足，已停机删除` |
| 支付页 / 收据 / 邮件 | Checkout 的 `product_data.name` 已是 `Veyl SAAS服务额度`，description 用「预付额度」措辞；Stripe 收据沿用产品名。邮件目前只有登录验证码，不含额度文案；将来加支付邮件时沿用本口径 |
| 法务页 / 定价页 | 已完成：中文「服务额度」、英文 Service Credits |

### 11.3 验收

1. 全站与客户端的**用户可见文案**不再出现「余额」/“Balance”；`rg` 只应命中代码注释、变量名、错误 reason 与内部文档。
2. 法务页、定价页、客户端、收据四处口径一致：中文「服务额度」，英文 Service Credits。
3. 接口字段与数据库列名无改动：`balance_cents`、`wallet_ledger`、`balance_after_cents` 原样。
4. 中英文两套文案同时改；`typecheck` 与现有测试全绿。

## 12. 与旧文档的关系

- `login-and-payment.md` §4 的 Dodo 实现细节**不再作为实现依据**，以本文件为准；该文件保留作历史设计记录。
- `payment-facts.md` 是 Dodo 时期的事实清单，Dodo 相关内容只作历史参考。
- `billing-notes.md` 的计费模型继续有效，支付通道一节已改为 Stripe。
- `us-entity-payment-setup.md` 的主体 / 银行 / 结算流程继续有效；Stripe 账户已开（美国 LLC，test 模式）。
