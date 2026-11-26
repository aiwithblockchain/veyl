# 充值档位重新设计：固定快捷档 + 自定义整数美元

> 日期：2026-11-25（已定稿）
> 状态：**已定稿**；本文件不改代码、不部署
> **这是余额充值，不是服务期绑定。** 余额按天扣、余额不退、余额不足停机销毁的现有规则全部不变；充值面额只决定入账余额，不绑定机器、不引入天数或到期日。
> 已定稿：5 个固定快捷档（$6 / $10 / $25 / $50 / $100）+ 自定义整美元（$6–$300）；没有一次性新手档、没有年付/套餐、没有折扣、没有新增字段、没有迁移。
> 关联：`billing-notes.md`（计费模型）、`stripe-migration.md`（支付适配层）、`login-and-payment.md` §4（余额、按天扣、停机销毁）、`cloudflare/control-plane/src/topups.ts`、`src/components/MyServerTopUp.tsx`

## 0. 结论先行

| # | 项 | 结论 |
|---|---|---|
| 1 | 固定快捷档 | **`600 / 1000 / 2500 / 5000 / 10000` 分（$6 / $10 / $25 / $50 / $100）**，永久保留，不是一次性；只作为 UI 快捷按钮 |
| 2 | 自定义金额 | **整数美元，`600–30000` 分（$6–$300）**，`cents % 100 == 0`；服务端校验，不依赖快捷档列表 |
| 3 | 一次性新手档 | **不做**：$6 是普通固定档，没有新手资格、唯一索引、新字段或迁移 |
| 4 | 年付 / 套餐 | **不做**：没有年度档、套餐矩阵、时长、折扣或用户分层字段 |
| 5 | 入账 | 实收 = 入账；webhook 的 `amount_total == topups.denomination_cents`、账本、`payments` 完全不动 |
| 6 | 数据模型 | **`topups` 表一行不改**；没有迁移、没有新字段 |
| 7 | 风控 | 邮箱验证；每账号 5 单/小时；新客户 / 大额 3DS；最低测试成本 $6 |

一句话：**充值弹层给 5 个快捷金额，再加一个 $6–$300 的整美元输入框；任何通过校验的金额都能建 Stripe Checkout，现有入账链路不动。**

---

## 1. 已定事实（本设计不改变）

- 计费：预付余额 + 按天扣。日价 512MB `$0.30`、1GB `$0.40`、2GB `$0.80`；余额不足当场停机销毁，无宽限。
- **充值面额只决定入账余额**：不绑定机器、不绑定套餐、不引入天数或到期日；同一余额可跨机器使用，按各机器的日价扣。
- Stripe：`mode=payment`、一次性、USD、`price_data` 动态金额；webhook 只按本地 `topups.denomination_cents` 入账；不预建 Product / Price。
- 收款主体美国 LLC；卡 2.9% + $0.30；需要换汇时 +1%；支付宝只对中国大陆、仅一次性，且「云服务 / 储值」属受限类目；微信禁用类目含 VPS / 云服务器，不可依赖。
- 余额不退、不转让、不提现；服务器按天扣，销毁退未用完的整天（退回余额，不是现金）。
- 现有 `topups` 表：`denomination_cents` 存金额，`status` 为 `pending / paid / failed`；本设计不改表结构。

---

## 2. 固定快捷档与手续费

| 快捷档 | 金额 | Stripe 手续费 | 占比 |
|---|---|---|---|
| 1 | **$6.00**（600 分） | $0.47 | 7.9% |
| 2 | **$10.00**（1000 分） | $0.59 | 5.9% |
| 3 | **$25.00**（2500 分） | $1.03 | 4.1% |
| 4 | **$50.00**（5000 分） | $1.75 | 3.5% |
| 5 | **$100.00**（10000 分） | $3.20 | 3.2% |
| 自定义示例 | $36.00（3600 分） | $1.34 | 3.7% |
| 上限示例 | $300.00（30000 分） | $9.00 | 3.0% |

- 手续费按美国 LLC、USD 计价、美国境内卡 `2.9% + $0.30` 计算；支付宝 / 换汇另加约 1%。
- 余额按天扣，实际毛利取决于用户把余额花在哪种机器上；本表只列支付手续费，不再做「套餐 × 天数」矩阵。
- 最低测试成本是 $6：卡测试者每试一次至少付 $6，比 $0.50 的自定义下限高得多。
- 快捷档只是 UI 按钮，不是白名单；$36 这类不在快捷列表里的金额同样可以充。

---

## 3. 自定义金额

- **整数美元**：只接受 `cents % 100 == 0`；`$5.99`、`$36.50` 这类拒绝。
- **范围**：`600 <= cents <= 30000`（$6–$300）。
- **服务端校验**：`Number.isInteger(cents)`、整美元、范围三者同时满足才建会话；前端校验只是提前提示，Host / Worker 仍是最终裁判。
- **不依赖快捷档列表**：`POST /v1/topups { denomination_cents: 3600 }` 即使 3600 不在 `TOPUP_DENOMINATIONS_CENTS` 里，也必须接受。
- 拒绝原因统一用 `409 PRECONDITION_FAILED`、`details.reason="invalid_denomination"`，`details` 带 `min_cents`、`max_cents`、`whole_dollars: true`，客户端据此显示「$6–$300，整美元」。
- 单笔上限 `$300`；没有余额上限；余额仍按天扣、不退不转让。

---

## 4. 接口

### 4.1 `GET /v1/wallet`

```json
{
  "balance_cents": 1200,
  "currency": "USD",
  "denominations_cents": [600, 1000, 2500, 5000, 10000],
  "min_topup_cents": 600,
  "max_topup_cents": 30000
}
```

- `denominations_cents` 只是 **UI 快捷按钮**；不是可充值金额的全集。
- 不返回新手档、年付或用户分层字段。
- 旧客户端只读 `balance_cents` / `denominations_cents`，仍能显示 5 个快捷按钮并充值。

### 4.2 `POST /v1/topups`

请求体：

```json
{ "denomination_cents": 3600 }
```

校验顺序：

1. 合法 JSON，`denomination_cents` 可转成数字；
2. `Number.isInteger(cents)`；
3. `cents % 100 == 0`（整美元）；
4. `MIN_TOPUP_CENTS <= cents <= MAX_TOPUP_CENTS`。

任何一条不满足 → `409 PRECONDITION_FAILED`、`details.reason="invalid_denomination"`，不建会话、不扣钱。

- **不再命中 `TOPUP_DENOMINATIONS_CENTS` 白名单**；$36、$7、$123 等整美元金额都接受。
- 幂等：`requestHashOf({ cents })` 不变；同一 `Idempotency-Key` 重放不会建第二个会话。
- 频控：同一账号 1 小时内 `status IN ('pending','paid')` 的充值单超过 5 个 → `429`、`details.reason="topup_rate_limited"`；failed / expired 不计数，避免连续失败把用户锁死。
- `startTopupSession` 的 `allowed: number[]` 参数改为 `minCents` / `maxCents`（或在校验层先判），不再用 `allowed.includes(cents)`；`topups.denomination_cents` 存实际金额。
- `topups` 表不新增字段，`product_id` 继续为 `NULL`。

### 4.3 Webhook

**零改动**：

- `currency='usd'`；
- `amount_total == topups.denomination_cents`；
- `creditTopup` 按 `denomination_cents` 加余额；
- `wallet_ledger` 写 `stripe_payment` / `ref_id=topup.id`；
- `payments.amount_usd = denomination_cents / 100`。

异步支付宝 / 微信的 `completed(unpaid)` → `async_payment_succeeded` 逻辑不变。

### 4.4 客户端与命令层

- `src/agent/bridge.ts` 的 `MyServerWallet` 增加 `min_topup_cents?: number` / `max_topup_cents?: number`；旧响应缺省时新客户端按 `600` / `30000` 兜底，但以服务端返回为准。
- `src-tauri` 的 wallet 透传这两个可选字段；`my_server_topup` 不变（仍是 `{ denomination }`），不需要新增参数。
- 契约 `docs/contracts/commands.md` 的 `my_server_wallet` 返回加两个可选字段；旧客户端可缺省，`my_server_topup` 形状不变。

---

## 5. UI

- 充值弹层显示：
  - 5 个快捷按钮：`$6` / `$10` / `$25` / `$50` / `$100`（整美元，不带 `.00`）；
  - 一个自定义金额输入框：`$6–$300`，整美元，占位符 `36`；
  - 提交按钮：空输入时为 `充值`（禁用）；合法时为 `充值 $X`（整额不带 `.00`）。
- 没有分组、没有套餐 tab、没有划线价、没有「约一年」或天数文案。
- 自定义输入校验：
  - 只允许整数美元（`^\d+$`，不接受小数点、负号、空值）；
  - `6 <= 金额 <= 300`；
  - 输入过程中不报错；失焦后或点过提交且值非法才显示「请输入 $6–$300 的整美元金额」并置 `aria-invalid`；清空回到中性 hint；不发起请求。
- 快捷按钮和自定义金额走同一个 `onTopUp(cents)`；Checkout 在外部浏览器打开后**保留弹层**，原位 `role="status"` 显示「已在浏览器打开收款页。付完款后点「刷新」查看余额。」；等待期间快捷档、输入与提交都禁用，底部动作行只留 `刷新`（强制刷新，不受 30 秒门禁限制）与 `关闭`（避免重复建单吃掉频控额度）。
- 支付成功后由等待态的 `刷新` 强制刷新余额；窗口重新聚焦时也会补刷（受 30 秒门禁）。没有新手档卡片、没有年度组、没有「首次专享」。
- 旧客户端只显示 5 个快捷按钮，仍可正常充值；新客户端多一个自定义输入框。
- 文案 key（中英同批）：
  - `topup.custom.label`：自定义金额 / Custom amount
  - `topup.custom.placeholder`：36 / 36
  - `topup.custom.hint`：$6–$300，整美元 / $6–$300, whole dollars
  - `topup.custom.invalid`：请输入 $6–$300 的整美元金额 / Enter a whole-dollar amount from $6 to $300
  - `topup.custom.submit`：充值 {amount} / Top up {amount}
  - `topup.submit`：充值 / Top up
  - `topup.waiting`：已在浏览器打开收款页。付完款后点「刷新」查看余额。/ Checkout is open in your browser. After paying, click Refresh to update your balance.
- Checkout 侧：`product_data.name = "Veyl Service Credits"`，description 用现有的 `Prepaid credits for Veyl cloud servers. Use within Veyl only; non-refundable.`

---

## 6. 配置

| 变量 | 值 | 说明 |
|---|---|---|
| `TOPUP_DENOMINATIONS_CENTS` | `"[600,1000,2500,5000,10000]"` | **仅 UI 快捷按钮**；升序；不是支付白名单 |
| `MIN_TOPUP_CENTS` | `600` | 自定义最小金额（分） |
| `MAX_TOPUP_CENTS` | `30000` | 自定义最大金额（分） |

- `readTopupDenominations` 继续解析 `TOPUP_DENOMINATIONS_CENTS`，但只用于 `GET /v1/wallet` 的快捷按钮；解析失败 / 为空时返回空数组并记日志，**不阻断自定义充值**。`handleTopups` 不再因为快捷档配置失败返回 503；只有 `MIN_TOPUP_CENTS` / `MAX_TOPUP_CENTS` 缺失或非法才 503。
- `MIN_TOPUP_CENTS` / `MAX_TOPUP_CENTS` 是必需配置：必须是正整数、`MIN <= MAX`、`MIN >= 100`；缺失或非法 → `503 topup_config_unavailable`。
- 快捷档如果不在 `[MIN, MAX]` 或不是整美元，展示时过滤掉并记日志；支付校验只看 min/max/整美元。
- dev / prod 各写一份；不需要 secret。

---

## 7. 数据模型

- **没有迁移**：`topups` 表不改，`denomination_cents` 存实际金额，`status` 状态机不变。
- 不新增字段；不新增唯一索引。
- 历史充值单原样保留；现有 `wallet_ledger` / `payments` 不动。

---

## 8. 风控与合规

| 项 | 措施 |
|---|---|
| 卡测试 | 邮箱验证；每账号 5 单/小时（只算 `pending + paid`）；最低金额 $6；Radar 对新客户 / 小额要求 3DS；`risk_level=highest` 拒绝 |
| 大额拒付 | 卡支付 >$100 要求 3DS；首次大额人工复核；保留 ToS 同意、`topup_id`、开通与运行记录 |
| 自定义金额 | 服务端只接受整美元、$6–$300；单笔上限 $300；不做余额硬上限，按月统计未消费余额 |
| 储值类目 | 仍是 `Veyl Service Credits`；单笔 ≤$300；条款写明余额不退、不转让、不提现 |
| 地区 | EEA / UK 继续 Radar 阻断；大额档不例外 |
| 支付方式 | 支付宝可申请（受限类目）；微信不作为可依赖通道 |
| 税 | 预付额度的税务口径需会计确认；本期不接 Stripe Tax，收入按实际消费确认 |

### 8.1 Stripe Dashboard 配置（不是代码）

| 项 | 位置 | 配置 |
|---|---|---|
| 3DS | Radar → Rules | `Request 3D Secure` when `amount_in_usd > 100`（卡）；test / live 各配一次 |
| Highest risk | Radar → Rules | `Block` when `risk_level = 'highest'` |
| 首次大额 | Radar → Rules | `Review` when `amount_in_usd > 100` 且客户是新客户（字段以 Dashboard 当前版本为准） |
| 支付宝 | — | 不支持 3DS；>$100 的支付宝不能靠 3DS，靠 Radar risk + 人工复核 |
| 商品名 | 会话 `product_data.name` | 统一 `Veyl Service Credits` |
| 描述 | `product_data.description` | 现有 `Prepaid credits for Veyl cloud servers. Use within Veyl only; non-refundable.` |
| Statement descriptor | Dashboard → Public details | 仍为 `VEYL` |
| Webhook | Dashboard → Webhooks | live 与 test 各一个端点，订阅 `stripe-migration.md` §4.2 的四个事件 |
| ToS | Dashboard → Public details | 上线前必须填好；否则 `consent_collection[terms_of_service]=required` 建会话失败 |

---

## 9. 验收标准

1. `GET /v1/wallet` 返回 `denominations_cents = [600,1000,2500,5000,10000]`、`min_topup_cents=600`、`max_topup_cents=30000`；没有新手档、年付或用户分层字段。
2. `POST /v1/topups {denomination_cents:600}`、`1000`、`2500`、`5000`、`10000` 都能建出 `cs_…`；`topups.denomination_cents` 等于请求金额。
3. 用测试卡付 $6 / $10 / $25 / $50 / $100：余额分别增加对应金额；`wallet_ledger` 一条 `stripe_payment`；`payments.amount_usd` 等于实收；webhook 与现有链路完全一致。
4. `POST /v1/topups {denomination_cents:3600}`（$36，不在快捷列表）→ 建出会话；`$7`、`$123` 等整美元金额同样接受。
5. `POST /v1/topups {denomination_cents:599}`（$5.99）→ `409`、`invalid_denomination`，不建会话。
6. `POST /v1/topups {denomination_cents:30001}`（$300.01）→ `409`、`invalid_denomination`，不建会话。
7. `POST /v1/topups {denomination_cents:500}`（$5）、`30100`（$301）、`3650`（$36.50）→ 全部拒绝。
8. 旧客户端只拿到 5 个快捷金额，仍能正常建会话、支付、到账；不依赖新字段。
9. 新客户端：5 个快捷按钮 + 自定义输入框；输入 `36` 可充 $36；输入 `5.99` / `300.01` 被前端拦下，不发起请求；提交按钮文案为 `充值 $X`。
10. 同一账号 1 小时内第 6 个 `pending + paid` 充值单 → `429`、`topup_rate_limited`；failed / expired 不计数。
11. `TOPUP_DENOMINATIONS_CENTS` 配坏 / 为空 → `denominations_cents=[]`、自定义充值仍可用；`MIN_TOPUP_CENTS` / `MAX_TOPUP_CENTS` 配坏 → `503 topup_config_unavailable`。
12. 没有迁移；`topups` 表结构不变；现有充值单、账本、`payments`、异步支付、幂等测试全绿；`npm run typecheck` 通过。
13. 契约检查通过；`my_server_topup` 参数与返回不变（仍是 `{ denomination }`），不需要新增参数。
14. Dashboard 手工验收：test 模式下 >$100 卡支付命中 3DS、`risk_level=highest` 被拒、正常卡放行；收银台显示 `Veyl Service Credits`。

---

## 10. 已定稿

- 固定快捷档：`600 / 1000 / 2500 / 5000 / 10000` 分（$6 / $10 / $25 / $50 / $100），永久保留。
- 自定义：整数美元，`600–30000` 分（$6–$300），`cents % 100 == 0`。
- $6 不是一次性新手档；没有新手档 / 年付 / 套餐 / 折扣 / 新增字段 / 迁移。
- 入账沿用现有 webhook、账本与 `payments`；实收 = 入账。
- **没有待拍板项。** 实现方按本文直接落地。

---

## 11. 实施顺序

| 阶段 | 内容 | 依赖 |
|---|---|---|
| P0 | 配置 `TOPUP_DENOMINATIONS_CENTS` / `MIN_TOPUP_CENTS` / `MAX_TOPUP_CENTS`；`GET /v1/wallet` 新增 min/max；`POST /v1/topups` 改为整美元 + 范围校验；UI 5 个快捷按钮 + 自定义输入框；测试 | 无迁移、无 webhook 改动 |

单批实现即可；不需要数据库迁移，不需要改 `topups` 表或 webhook。实现完成后由另一个会话交叉 review 代码。
