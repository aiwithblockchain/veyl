# Stripe 上线运维 runbook

> 日期：2026-11-23
> 状态：上线运维清单（未执行）。本文只写操作，不含控制面代码改动。
> 关联：`docs/design/stripe-migration.md`（实现与切换）、`docs/design/login-and-payment.md`（计费模型）、`docs/design/us-entity-payment-setup.md`（Stripe 账户与打款）、`docs/design/payment-facts.md`（Dodo 时期事实，历史）
> 适用范围：充值 → 余额 → 按天扣费的整条收款链路；包含上线冒烟、告警口径、对账补账、退款/拒付、回滚、Dodo 下线。

---

## 0. 一页结论

| 环节 | 要做什么 | 在哪一节 |
|---|---|---|
| 上线前 | Dashboard 逐项校验：模式/密钥、webhook 端点与 4 个事件、ToS、Radar、支付方式、statement descriptor、回跳、打款 | §2 |
| 上线冒烟 | test 卡 → webhook 200 → 账本 → 余额 → 建机扣费；再补失败路径 | §3 |
| 日常 | 每日巡检 + `scripts/stripe-reconcile.mjs`；当前**没有自动告警通道**，按本文阈值人工看 | §4、§5 |
| 退款/拒付 | 先冻结账户 → 留证 → 冲正余额（幂等 SQL）→ 记录；退款与冲正必须 PM 批准 | §6 |
| 回滚 | 先停新充值（`TOPUP_DENOMINATIONS_CENTS=[]`）→ 处理完 pending → 回滚部署；账本永不回滚 | §7 |
| Dodo | 停 webhook → 吊销 API key → 归档产品 → 删 secret；Stripe 稳定 30 天后再做 | §8 |
| 轮换 | webhook secret 可滚动（代码认多个 `v1`）；API key 轮换后先验证再吊销旧的 | §9 |

**三条硬前提**（代码已实现，运维必须知道）：

1. 生产 `STRIPE_SECRET_KEY` 必须是 `sk_live_…`；代码只认这个前缀，`rk_live_…` 会 fail closed，收银台直接返回 `no_api_key`。
2. `STRIPE_WEBHOOK_SECRET` **缺失**时，建充值单在落库前就被拒绝（宁可暂时不能充值，也不收钱不入账）。所以「充值不可用」有一个可解释的原因，先看 `/v1/wallet` 的报错。
3. 代码只能检查 secret **存在**，检查不了它**对不对**。配错（例如把 test 的 `whsec_` 配给 live 端点）时收银台照常扣款、回调全部 401。这就是 §2.2 的 Send test event 和 §3 冒烟不能跳过、上线首周 401 巡检是 P0 的原因。

---

## 1. 角色与批准

| 动作 | 谁执行 | 事先批准 | 留痕 |
|---|---|---|---|
| 只读巡检、`stripe-reconcile.mjs` dry-run | 控制面值班 | 不需要 | 巡检记录（日期 + 输出摘要） |
| 单笔 ≤ $48 的补账（`--apply`） | 控制面值班 | 不需要，事后 24h 内报告 PM | 脚本输出 + `audit_log`（`ops.reconcile.stripe`） |
| 批量补账、退款、冲正、冻结账户 | 控制面值班 | **PM（发起人）** | Stripe 操作记录 + 冲正 SQL + `audit_log`（`ops.refund` / `ops.chargeback`） |
| 生产部署、回滚、改 vars | 工程师 | **PM**，另一位工程师复核 | 部署版本号 + 变更说明 |
| Dodo 吊销、secret 轮换 | 工程师 | **PM** | Dashboard 操作时间 + 复核人 |

单人项目也按这张表走：批准可以是一句书面确认，但「谁在什么时候同意了什么」必须留在记录里。

---

## 2. 上线前 Dashboard 校验

逐项做完再上。任何一项不过，不进入 §3。

### 2.1 模式与密钥

| 检查 | 位置 | 期望 | 不过的后果 |
|---|---|---|---|
| 账户模式 | Dashboard 顶部 Test / Live 开关 | 先 Test 全流程，再切 Live | test 卡换真实额度 |
| 生产密钥 | Cloudflare secret `STRIPE_SECRET_KEY`（prod 环境） | `sk_live_…`，且不是只读 key | 代码 fail closed，充值是 503 |
| dev 密钥 | `wrangler secret put STRIPE_SECRET_KEY --env dev` | `sk_test_…` | dev 建单失败 |
| webhook secret | 每个端点、每种模式各一个 | live 端点配 live `whsec_…`，test 端点配 test `whsec_…` | 回调全部 401，用户被扣款但不入账 |

命令（只说明，不在此执行）：

```bash
npx wrangler secret list
npx wrangler secret list --env dev
```

只看到变量名，不显示值；值从 Dashboard 的 API keys 页面（密钥）与 Webhook 端点页面（`whsec_…`）拿。

### 2.2 Webhook 端点

| 项 | 生产 | dev |
|---|---|---|
| URL | `https://veyl.dessage.xyz/v1/webhooks/stripe` | `https://dev.veyl.dessage.xyz/v1/webhooks/stripe` |
| 事件 | `checkout.session.completed`、`checkout.session.async_payment_succeeded`、`checkout.session.async_payment_failed`、`checkout.session.expired` | 同生产 |
| 版本 | 端点 API 版本固定 `2026-11-18.endive`，与控制面 `src/payments/stripe.ts` 的 `STRIPE_VERSION` 一致 | 同生产 |
| 模式 | Live 端点只能指向生产 Worker；Test 端点只能指向 dev Worker | 禁止交叉 |

**必须订阅 4 个事件**，少 `checkout.session.expired` 会让 pending 单永久堆积。可选再加 `charge.refunded`、`charge.dispute.created` 作为退款/拒付的本地痕迹；代码对未知事件只记一行 `webhook_events`（`status=processed`），**不会自动改余额**，冲正仍按 §6 人工做。

> `stripe-migration.md` §9 第 4 步仍写「三个事件」，以本节 4 个为准。

上线前在端点页面点 **Send test event**，确认：

- Stripe 显示 200；
- Worker 日志出现 `processed`；
- D1 的 `webhook_events` 多一行。

> Stripe 的测试事件没有我们的 `metadata`，会顺带在 `unmatched_payments` 留一条 `no_metadata`。这是预期行为，巡检时标记忽略，不要当成故障。若返回 400 `livemode_mismatch`，说明端点模式或 Worker 环境配错了，先修 §2.1。

### 2.3 条款与同意

| 检查 | 期望 |
|---|---|
| Settings → Public details → Terms of service URL | `https://veyl.dessage.xyz/legal/terms.html` |
| 退款政策 | 站点页脚已挂 `https://veyl.dessage.xyz/legal/refunds.html`；收银台商品描述保留「预付额度，不退不转让」 |
| Checkout 同意项 | 代码传 `consent_collection[terms_of_service]=required`；Dashboard 没填 ToS URL 时建会话会直接报错 |
| EEA/UK | Radar 阻断 + 收银台 `custom_text` 告知；条款口径见 `stripe-migration.md` §3.2–3.3 |

> **2026-11-24 当前状态**：EIN 未到、账户未激活，Public details 填不了 ToS URL；dev 部署（`45470206`）临时去掉了 `consent_collection[terms_of_service]=required`，仓库仍是 `required`。EIN 后必须按 `stripe-migration.md` §3.2.1 补 ToS URL、在 test 模式回归一次带勾选的收银台，未完成不得上线。

### 2.4 支付方式

Settings → Payments → Payment methods：

- 卡、Apple Pay / Google Pay 默认开；
- 支付宝：Dashboard 打开即 **Instant provisional access**，仅中国大陆客户、仅一次性付款；「Cloud Service」与「储值」属 Alipay 受限类目，审核可能要求补充材料；
- 微信支付：Dashboard 也能打开，但其禁用清单明确含 VPS / 云服务器服务，与 Veyl 交付物冲突，不作为可依赖通道（`stripe-migration.md` §10.1）；
- **不要**在代码里传 `payment_method_types`；当前实现也没传，保持后台动态。启用微信时另传 `payment_method_options[wechat_pay][client]=web`。

### 2.5 Radar

- 先在 Test 模式建规则，验证两个方向：命中（EEA/UK 账单国家或卡国家）必须拒绝；正常卡必须放行。
- 规则表达式、优先级以 Radar 文档与实测为准，不在本文写死。
- Live 规则上线后，用一张真实卡做 §3 的 live 冒烟，确认没有被误杀。

### 2.6 账单描述与回跳

| 项 | 期望 |
|---|---|
| Statement descriptor | `VEYL`（≤22 字符，Dashboard 账户级设置） |
| `success_url` / `cancel_url` | 生产 `https://veyl.dessage.xyz/payment/return`；dev `https://dev.veyl.dessage.xyz/payment/return` |
| 回跳参数 | Stripe 会把 `{CHECKOUT_SESSION_ID}` 替换成真实 `cs_…`；上线冒烟时看地址栏确认，不能只看代码 |

### 2.7 打款与通知

- Settings → Bank accounts：Mercury 账户已绑定，打款周期为 Automatic；
- 首笔结算通常有观察期，首月按 Dashboard 实际到账核对；
- Account settings → Notifications：开启「webhook 连续失败」「dispute 创建」邮件，这是当前唯一免费的自动告警。

### 2.8 上线签署

| 项 | 操作人 | 日期 | 证据 |
|---|---|---|---|
| 2.1 密钥与模式 | | | |
| 2.2 webhook | | | |
| 2.3 条款 | | | |
| 2.4 支付方式 | | | |
| 2.5 Radar | | | |
| 2.6 描述/回跳 | | | |
| 2.7 打款/通知 | | | |

---

## 3. 上线冒烟

### 3.1 dev / Test 模式（每个新部署都跑）

前置：dev 已设 `sk_test_…` 与 test 端点 `whsec_…`；`TOPUP_DENOMINATIONS_CENTS=[1200,2400,3600,4800]`。

1. **建单**：登录客户端，选 $12 充值。查 D1：

   ```sql
   SELECT id, account_id, denomination_cents, status, checkout_session_id, checkout_url, created_at
   FROM topups ORDER BY created_at DESC LIMIT 1;
   ```

   期望：`status=pending`、`checkout_session_id` 以 `cs_test_` 开头、`checkout_url` 可打开。

2. **付款**：卡号 `4242 4242 4242 4242`，任意未来有效期与 CVC。回跳后地址栏应带 `session_id=cs_test_…`。

3. **回调与入账**：

   ```sql
   SELECT id, kind, status, payment_id, received_at, processed_at
   FROM webhook_events ORDER BY received_at DESC LIMIT 5;

   SELECT t.id, t.status, t.paid_at,
          w.amount_cents, w.balance_after_cents, w.ref_type, w.ref_id,
          a.balance_cents
   FROM topups t
   JOIN accounts a ON a.id = t.account_id
   LEFT JOIN wallet_ledger w ON w.ref_type = 'stripe_payment' AND w.ref_id = t.id
   WHERE t.id = '<上一步的 topup_id>';

   SELECT id, status, amount_usd, currency, received_at
   FROM payments WHERE account_id = '<account_id>'
   ORDER BY received_at DESC LIMIT 3;
   ```

   期望：事件 `processed`；topup `paid`；`wallet_ledger.ref_type='stripe_payment'`、`ref_id=topup.id`，金额等于面额；`accounts.balance_cents` 等于该账本行的 `balance_after_cents`。

4. **建机扣费**：用这笔余额建一台最低配。期望订单就绪后出现 `server_day` 扣费行，余额减少一个日价。查：

   ```sql
   SELECT ref_type, ref_id, amount_cents, balance_after_cents, created_at
   FROM wallet_ledger WHERE account_id = '<account_id>'
   ORDER BY created_at DESC LIMIT 5;
   ```

5. **失败路径**（各做一次）：

   - 改坏签名 `curl` 打 `/v1/webhooks/stripe` → 401，日志 `signature_invalid reason=mismatch`；
   - 同一个事件重投 → 200，余额不变（`webhook_events.status=processed` 直接返回）；
   - 打开收银台不付款，等 test 模式 24 小时过期（或用 Stripe 文档里的方式使会话过期）→ topup 变 `failed`，余额不变；
   - 把 dev 的 `STRIPE_WEBHOOK_SECRET` 删掉（`npx wrangler secret delete STRIPE_WEBHOOK_SECRET --env dev`）再重启 dev → 建单请求在落库前被拒（`no_webhook_secret`），不会出现「已扣款未入账」；测完重新 `secret put` 并再验一次建单。

6. **对账**：

   ```bash
   node scripts/stripe-reconcile.mjs --env dev --local
   ```

   期望退出码 0。

### 3.2 Live 冒烟（切生产当天）

1. 生产 secret 设为 live 值，部署生产；
2. 用真实卡充最小值 $12；
3. 重跑 §3.1 第 3、4 步的 SQL（把 `--env dev` 换成默认生产库）；
4. Dashboard → Payments 确认金额、币种、描述 `VEYL`、ToS 同意；
5. 等一个打款周期，确认净额进入 Mercury；
6. 如不想留这笔真实交易，按 §6.2 退款并冲正余额（退款政策允许重复/误扣；正常购买按政策是最终交易，别随意退）。

---

## 4. 最小告警清单

### 4.1 现状

控制面**没有告警通道**：unmatched、入账失败、billing 失败只写 `console` / `audit_log`；Workers Logs 保留期有限，没人盯就等于没有。自动告警（cron + 邮件）是后续代码任务，不在本期。在此之前，本文的告警 = **人工巡检 + 明确阈值**。

巡检频率：

- 上线首 14 天：每天 10:00（UTC+8）一次，上线当天每 2 小时一次；
- 稳定后：每天一次，每周一次外部对账（§4.4）。

### 4.2 告警项

| # | 信号 | 阈值 | 怎么查 | 处置 |
|---|---|---|---|---|
| 1 | webhook 401（验签失败） | 首 14 天：持续 > 30 分钟；之后：> 20 次/小时 | 日志筛 `signature_invalid`（`wrangler tail veyl-control-plane --format json` 或 Dashboard Logs） | `reason=missing_header/stale_timestamp/mismatch` 多半是 secret 或端点模式错；核对 §2.2，别先怪攻击 |
| 2 | webhook 500 / `failed` 事件 | 任意一条 | `webhook_events.status='failed'`；日志 `[stripe-webhook] failed` | Stripe 会自动重投 3 天；看事件 id 与错误，D1 故障恢复后确认重投成功。端点页若已被 Stripe 停用，先重新启用再补投 |
| 3 | 入账失败 `credit_failed` | 任意一条 | 日志 `topup_credit_failed`；同时看 `webhook_events.status='failed'` | 当天人工补账（§5），并把 `topup` 与事件 id 记进事故记录 |
| 4 | unmatched 激增 | 首 14 天：任意新增；之后：> 5 条/小时或出现新 reason | `unmatched_payments` 按 `reason` 聚合 | `unknown_topup/no_metadata` 查匹配字段；`amount_mismatch/currency_mismatch` 查代码面额；`missing_account` 走退款 |
| 5 | pending topup 超过 48h | 任意一条 | `topups.status='pending' AND created_at < now-48h` | 去 Stripe Dashboard 查该 session：已付 → `--paid-sessions` 补账；未付/过期 → 置 `failed` |
| 6 | 退款 / 拒付 | 任意一条 | Stripe 邮件 + Dashboard → Payments/Disputes；若订阅了事件，查 `webhook_events.kind` | 拒付按 §6.3 先冻结账户，当天处理 |
| 7 | 余额与账本漂移 | 任意一条 | `node scripts/stripe-reconcile.mjs`（默认生产库） | 停止补账类操作，先查最近账本行与并发；漂移未解释前不要开 `--apply` |
| 8 | billing 整轮失败 | 任意一条 | 日志 `billing_failed`；`audit_log.action='billing.failed'` | 计费停了会直接影响续费/停机；当天修，必要时手动重跑 |

### 4.3 巡检 SQL

```sql
-- 最近 1 小时失败事件
SELECT id, kind, received_at FROM webhook_events
WHERE status = 'failed' AND received_at > (strftime('%s','now') - 3600) * 1000;

-- 最近 1 小时 unmatched，按原因聚合
SELECT reason, COUNT(*) AS n, MIN(received_at) AS first_at, MAX(received_at) AS last_at
FROM unmatched_payments
WHERE received_at > (strftime('%s','now') - 3600) * 1000
GROUP BY reason;

-- pending 超过 48 小时
SELECT id, account_id, denomination_cents, checkout_session_id, created_at
FROM topups
WHERE status = 'pending' AND created_at < (strftime('%s','now') - 48 * 3600) * 1000
ORDER BY created_at;

-- 最近 24 小时回调总览
SELECT kind, status, COUNT(*) AS n
FROM webhook_events
WHERE received_at > (strftime('%s','now') - 24 * 3600) * 1000
GROUP BY kind, status;

-- 退款 / 拒付痕迹（订阅了对应事件才有）
SELECT id, kind, status, received_at FROM webhook_events
WHERE kind LIKE 'charge.%' OR kind LIKE 'refund.%'
ORDER BY received_at DESC LIMIT 20;

-- billing 失败
SELECT at, account_id, server_id, detail FROM audit_log
WHERE action = 'billing.failed' AND at > (strftime('%s','now') - 24 * 3600) * 1000;
```

执行方式（生产库）：

```bash
npx wrangler d1 execute veyl-control-plane --remote --command "<上面的 SQL>"
```

### 4.4 外部对账（每周一次）

本地账本只能证明「自己跟自己对得上」，不能证明「Stripe 真的收到了这么多」。每周一次人工版：

1. Stripe Dashboard → Payments → 导出本周 CSV（或 Balance → 下载报告）；
2. 汇总 `succeeded` 笔数与金额；
3. 与本地比：

   ```sql
   SELECT COUNT(*) AS n, ROUND(SUM(amount_usd), 2) AS usd
   FROM payments
   WHERE status = 'succeeded'
     AND received_at BETWEEN <start_ms> AND <end_ms>;

   SELECT COUNT(*) AS n, SUM(amount_cents) / 100.0 AS usd
   FROM wallet_ledger
   WHERE ref_type IN ('stripe_payment', 'manual')
     AND created_at BETWEEN <start_ms> AND <end_ms>
     AND (ref_type = 'stripe_payment' OR ref_id LIKE 'stripe-reconcile:%');
   ```

4. 差异处置：先按 session id 找具体单，再决定补账/退款。结论写进记录，可选落 `audit_log`：

   ```sql
   INSERT INTO audit_log (at, account_id, server_id, action, detail)
   VALUES (<now_ms>, NULL, NULL, 'ops.reconcile.stripe', '<笔数/金额/差异说明>');
   ```

### 4.5 误报与安全

- 不要把 `STRIPE_SECRET_KEY` / `whsec_…` 写进任何记录、工单或聊天；巡检输出里也不会有（脚本不读密钥）。
- 401 平时也会出现（扫描器、过期的事件重放），阈值区分「持续」与「偶发」；持续失败优先查配置。
- 告警记录只写计数、id、原因，不写客户邮箱与支付凭据。

---

## 5. 对账与补账脚本

脚本：`scripts/stripe-reconcile.mjs`（仓库根目录）。默认只读，经 wrangler 查 D1；不连 Stripe、不读 `.dev.vars`、不打印密钥。远端模式要求本机已 `npx wrangler login`（与部署同一账号）。

### 5.1 用法

```bash
# 只读 dry-run：生产库
node scripts/stripe-reconcile.mjs

# 开发库 / 本地 D1
node scripts/stripe-reconcile.mjs --env dev
node scripts/stripe-reconcile.mjs --env dev --local

# 在副本上演练（--persist-to 指定本地 D1 目录，不动日常状态）
node scripts/stripe-reconcile.mjs --local --persist-to /tmp/veyl-recon-drill

# 机器可读（接巡检）
node scripts/stripe-reconcile.mjs --json

# 补记「已支付但账本缺行」
node scripts/stripe-reconcile.mjs --apply

# 补记「Stripe 显示已付、本地仍 pending」
# 先把 Dashboard 里核对过的 session id 写进文件，每行一个
node scripts/stripe-reconcile.mjs --paid-sessions ~/stripe-paid-sessions.txt --apply
```

### 5.2 检查内容

| 组 | 断言 | 典型原因 |
|---|---|---|
| A1 | `paid` 且带 `cs_…` session 的 topup 必须有账本行（`stripe_payment` 或本脚本补的 `manual`） | webhook 入账中断、人工改过状态 |
| A2 | `stripe_payment` 账本行必须对应一个 `paid` topup，且金额等于面额 | 账本写了但状态没跟上、入账金额错 |
| A3 | 同一 topup 只能有一条入账 | 正常路径 + 人工补记造成双记 |
| B | `payments`（succeeded）必须能归户到 topup，且该 topup 有入账 | Stripe/渠道收了钱但本地没记 |
| C | `accounts.balance_cents` 必须等于该账户最新账本行的 `balance_after_cents` | 并发、部分写入、手工 SQL 出错 |

B 的归户规则：先按 `payments.id = topups.checkout_session_id` 强匹配；匹配不上时，按「同账户 + 同金额 + 24 小时窗口 + 该 topup 未被其它 payment 占用」弱匹配（因为 `payments.id` 在有 `payment_intent` 时是 `pi_…`，本地没有直接外键）。弱匹配只用于告警，不参与 `--apply`。

### 5.3 `--apply` 的语义

- 只补 A1 / D（Stripe 已付但本地未 paid）两类：必要时把 topup 置 `paid`，然后写一条：
  - `kind='topup'`、`amount_cents=topup.denomination_cents`；
  - `ref_type='manual'`、`ref_id='stripe-reconcile:<topup_id>'`；
  - 账本 id 固定 `led_reconcile_<topup_id>`，`balance_after_cents = 当前余额 + 面额`；
  - 再按 `balance_after` 修正 `accounts.balance_cents`。
- 幂等：三步都有守卫，重复执行不会重复加钱；中途失败后重跑会补齐。
- `--apply` 执行后会立刻重新查一遍，打印的是**补记后**的差异清单；退出码按复查结果算。补记后 24 小时内再人工抽查一次（A1/A3/C 应为空）。
- 不自动处理：A2/A3/B/C 一律只报不改。这些要么需要人判断（重复入账可能已在 Stripe 退款），要么可能有并发。
- 补记后 24 小时内必须复查：重跑一次 dry-run，确认 A1/A3/C 为空。同时留意同 session 的另一个事件会不会再入账一次（正常路径已 `processed`，不会再入账；若出现 A3 重复，按 §6.2 冲正多余的一笔）。

### 5.4 退出码与巡检

| 退出码 | 含义 | 巡检动作 |
|---|---|---|
| 0 | 无错误（警告仍可能打印） | 记录 |
| 1 | 有错误（含可补记项） | 当天处理；补账需按 §1 批准 |
| 2 | 脚本/环境错误（wrangler 不可用、SQL 失败） | 先修工具，不算业务结论 |

建议每日巡检命令：

```bash
node scripts/stripe-reconcile.mjs --json > /tmp/stripe-reconcile-$(date +%F).json; echo "exit=$?"
```

---

## 6. 退款与拒付

### 6.1 原则

1. **退款不自动冲正余额**；本地账本只在人工确认后改。
2. **先保护服务，再谈钱**：拒付/欺诈先冻结账户，余额冲正和服务器处置随后做。
3. 余额永不为负（`accounts.balance_cents` 是零下界的）；扣不动的部分记账为损失，不允许把余额写成负数。
4. 任何退款/冲正都要能回答三个问题：哪一笔 Stripe 收款、哪一条本地账本、谁批准的。
5. 退款政策口径以 `https://veyl.dessage.xyz/legal/refunds.html` 为准：正常购买是最终交易；只对重复扣款、法律要求、EEA/UK 订单、以及「完全未消耗」的个案审查退款。

### 6.2 我方发起退款

适用：重复扣款、Radar 拒绝但资金到账、EU/UK 订单、法律要求、零消耗个案审查。

1. 在 Stripe Dashboard → Payments 找到 `pi_…` / `ch_…`，确认金额与状态；对应本地：

   ```sql
   SELECT t.id, t.status, t.paid_at, t.checkout_session_id, t.denomination_cents
   FROM topups t WHERE t.checkout_session_id = '<cs_…>';

   SELECT id, status, amount_usd, currency, received_at
   FROM payments WHERE id IN ('<pi_…>', '<cs_…>');

   SELECT id, ref_type, ref_id, amount_cents, balance_after_cents, created_at
   FROM wallet_ledger
   WHERE account_id = '<account_id>'
     AND (ref_type = 'stripe_payment'
          OR (ref_type = 'manual' AND (ref_id LIKE 'refund:%' OR ref_id LIKE 'chargeback:%')));
   ```

   先确认**没有退过**（`refund:<pi>` 的账本行、Dashboard 的 Refunds 列表都看）。

2. Dashboard 发起退款（全额/部分）。支付宝/微信是异步退款，以 Dashboard 最终状态为准。
3. 若额度未被消耗：按 §6.4 冲正余额，`ref_id='refund:<pi_…>'`；若已消耗，只冲正剩余余额并在记录里写明差额与原因。
4. 记录：`audit_log.action='ops.refund'`，detail 写 `pi/金额/topup/批准人/原因`。
5. 通知客户（support@dessage.xyz 模板），附退款参考号。

### 6.3 拒付 / chargeback

时间线（Stripe 默认）：争议创建 → 有答复截止日（常见 7–21 天，以 Dashboard 为准）→ 提交证据或接受 → 结果。

**T+0（发现当天，最好 1 小时内）**

1. **冻结账户**（立即生效，所有 API 返回 `account_blocked`）：

   ```sql
   UPDATE accounts SET status = 'blocked' WHERE id = '<account_id>';
   ```

2. 在 Stripe Dashboard → Disputes 记下：dispute id、charge id、payment intent、金额、原因码、答复截止日。
3. 查本地证据链：`topups`、`payments`、`wallet_ledger`、`webhook_events`、`audit_log`（建机与扣费记录）。
4. 通知 PM；是否答辩由 PM 决定（金额小、证据弱可以接受争议，省时间）。

**T+1（批准后）**

5. 冲正余额（§6.4），`ref_id='chargeback:<dispute_id>'`。余额不足全额时，冲掉现有余额，剩余记损失。
6. 服务器处置：冻结账户后不再能操作；余额不足会在下一次计费轮次「扣不动 → 停机销毁」。如果金额大、需要立即下线，由工程师按服务器运维流程销毁，并记录在案。
7. 若要答辩：Dashboard → Disputes → Submit evidence，提交 §6.5 的材料。
8. 记录 `audit_log.action='ops.chargeback'`。

**T+n**

9. 争议结果出来后：won → 资金退回，是否恢复余额由 PM 决定（通常不恢复，账户保持 blocked 直到人工复核）；lost → 确认损失，账户维持冻结或按政策处理。

### 6.4 冲正 SQL（幂等模板）

把 `<...>` 换成实际值；两段放在**同一次** `wrangler d1 execute --command` 里执行（wrangler 支持 `;` 分隔多条语句）。执行前先跑 §6.2 第 1 步，确认没有同 ref 的旧记录。

```sql
-- 1) 账本冲正：余额足够才写；ref 唯一，重跑不重复
INSERT INTO wallet_ledger (id, account_id, kind, amount_cents, balance_after_cents, ref_type, ref_id, note, created_at)
SELECT 'led_refund_<ref_slug>', a.id, 'adjustment',
       -<amount_cents>, a.balance_cents - <amount_cents>,
       'manual', '<ref>', '<refund|chargeback> <stripe_id> / <reason>', <now_ms>
FROM accounts a
WHERE a.id = '<account_id>'
  AND a.balance_cents >= <amount_cents>
  AND NOT EXISTS (SELECT 1 FROM wallet_ledger w WHERE w.ref_type = 'manual' AND w.ref_id = '<ref>');

-- 2) 余额跟随账本：只在「当前余额 == 冲正前余额」时生效；重跑为 0 行
UPDATE accounts
SET balance_cents = (SELECT balance_after_cents FROM wallet_ledger WHERE id = 'led_refund_<ref_slug>')
WHERE id = '<account_id>'
  AND EXISTS (SELECT 1 FROM wallet_ledger WHERE id = 'led_refund_<ref_slug>')
  AND balance_cents = (SELECT balance_after_cents + <amount_cents> FROM wallet_ledger WHERE id = 'led_refund_<ref_slug>');
```

约定：

- `<ref>`：退款用 `refund:<pi_…>`；拒付用 `chargeback:<dp_…>`；重复扣款可加后缀区分，如 `refund:<pi_…>:dup`。
- `<ref_slug>`：把 `:` / 空格换成 `_`，保证账本 id 可读且唯一。
- 第 1 段 0 行 = 余额不足或已冲正过，不要手工改余额去凑；按 §6.1 第 3 条记录。
- 执行后立刻重跑 `node scripts/stripe-reconcile.mjs`，C 组必须为空。

### 6.5 证据清单

| 证据 | 从哪来 | 用途 |
|---|---|---|
| Stripe 收款与争议 | Dashboard → Payments / Disputes | 金额、时间、原因码、截止日 |
| ToS / 退款政策版本 | `https://veyl.dessage.xyz/legal/terms.html`、`/legal/refunds.html` | 证明条款已展示 |
| 收银台同意记录 | Stripe 会话对象的 `consent` 字段（Dashboard 可见） | 证明客户同意 |
| 本地订单链 | `topups` → `payments` → `wallet_ledger` | 充值、入账、扣费时间线 |
| 服务交付记录 | `servers`、`orders`、`audit_log` | 证明额度已用于真实服务器 |
| 客户沟通 | support@dessage.xyz 邮件 | 证明先行联系（退款政策 §5） |

证据只放 Stripe Dashboard 的争议材料和内部事故记录，不把密钥、完整卡号或密码写进去。

### 6.6 批准与记录

- 退款、冲正、解冻：PM 书面批准；
- 冻结账户：不需要事先批准，但必须当天报告；
- 每次动作在 `audit_log` 写一行，detail 至少包含：Stripe id、金额、topup、批准人、原因、执行人。
- 本地没有 `refunds` 表（本期不加代码 / 不加迁移）。退款与拒付的持久记录由三处组成：Stripe Dashboard 的 Refund/Dispute 记录、`wallet_ledger` 里 `refund:<pi>` / `chargeback:<dp>` 的冲正行、`audit_log` 的一行摘要。查「这单退过没有」时三处都要看。

---

## 7. 回滚

### 7.1 触发条件

满足任意一条就进入回滚流程：

- 生产密钥/模式错配，充值不可用且短时间修不好；
- webhook 持续 401/500，已出现「已扣款未入账」；
- unmatched 或 `credit_failed` 在修复后仍持续新增；
- Stripe 账户被限制/审核，无法继续收款；
- PM 判断继续收款的风险大于停收。

### 7.2 第一步永远是停新充值（不碰代码）

把面额白名单置空，`/v1/topups` 与 `/v1/wallet` 都会在访问 D1 前返回 503 `topup_config_unavailable`，**不会产生新的 Stripe 扣款**。代价是客户端同时读不到余额与面额（`/v1/wallet` 也走这份配置），这是已知的止血副作用：

```bash
# 从一个与线上版本一致的干净 checkout 执行，避免把未提交改动带上去
npx wrangler deploy --var TOPUP_DENOMINATIONS_CENTS:'[]'
```

- 已在收银台的会话仍可支付；所以停单后继续看 1 小时回调，把已付的入账、未付的标 failed（§7.4）。
- 恢复收款：重新部署为 `[1200,2400,3600,4800]` 或去掉该 `--var` 覆盖。

> 这一步是 vars-only 部署，不改代码；但部署本身是外部写操作，需要 §1 的批准。

### 7.3 完整回滚到 Dodo

前置（缺一项就不要走这条路，改用 §7.2 长期停收）：

- 上一版 Dodo 代码还在部署历史里；
- `DODO_API_KEY` / `DODO_WEBHOOK_SECRET` 尚未删除，且 Dodo 后台 webhook 与产品仍然有效；
- 没有未结算的 Stripe pending 单（或已按 §7.4 处理完）。

顺序：

1. 执行 §7.2 停新充值；
2. 观察 1 小时，确认没有新的 `checkout.session.completed`；
3. 处理完 pending（§7.4）；
4. 查部署历史并回滚（`rollback` 要的是 Worker version id，不是 deployment id）：

   ```bash
   npx wrangler deployments list
   npx wrangler rollback <上一个 Dodo 版本的 version id>
   ```

5. 回滚后验证：`/v1/wallet` 返回面额、建一次 Dodo 测试单、Dodo webhook 能打进来；
6. 在 Stripe Dashboard **停用** webhook 端点（避免持续重投到已无该路由的 Worker）；
7. 记录回滚版本、时间、原因、批准人。

注意：

- **Cloudflare secrets 不随代码版本回滚**。回滚后 Stripe 的 secret 仍在，Dodo 的 secret 如果之前没删也仍在；不要在这一步顺手删任何 secret。
- **账本不回滚**。已经写入的 `stripe_payment` 行、`payments` 行、`topups` 行全部保留只读；Dodo 与 Stripe 的 `ref_type` 不同，可以共存，不需要数据迁移。
- 回滚后客户端可能缓存了充值入口；提示用户/客服「暂时不能充值」，不要让人反复点。

### 7.4 回滚前后必须清掉的 pending

```sql
SELECT id, account_id, denomination_cents, checkout_session_id, created_at
FROM topups WHERE status = 'pending' ORDER BY created_at;
```

逐条去 Stripe Dashboard 查 session：

- **已付**：用 `--paid-sessions` 补账（§5），或按 §5.3 的补记逻辑处理；
- **未付 / 已过期**：置失败（等价于代码里的 `checkout.session.expired` 分支）：

  ```sql
  UPDATE topups SET status = 'failed' WHERE id = '<topup_id>' AND status = 'pending';
  ```

处理完再回滚部署。回滚后 Worker 不再处理 Stripe 回调，留下的 pending 不会被自动清理。

### 7.5 不可回滚的项

- 已经入账的余额与账本行；
- 已经发生的 Stripe 收款、退款、拒付；
- 已经提交给 Stripe 的 Radar/ToS/支付方式配置（回滚代码不影响 Dashboard）。

---

## 8. Dodo 吊销清单

**前置**：Stripe 上线并稳定运行 ≥ 30 天，无 pending 单、无未处理退款/拒付，PM 批准。

按顺序执行，每步留证据（Dashboard 操作时间 + 截图路径或页面记录）：

| # | 动作 | 位置 | 验证 |
|---|---|---|---|
| 1 | 停 Dodo webhook | Dodo Dashboard → Webhooks → 停用/删除 `/v1/webhooks/dodo` | Dodo 后台无新投递；`curl -X POST https://veyl.dessage.xyz/v1/webhooks/dodo` 返回 404 |
| 2 | 吊销 API key | Dodo Dashboard → Developer/API keys → 吊销 `DODO_API_KEY` | 用旧 key 调一次只读接口应 401；控制面不再调用 Dodo |
| 3 | 归档产品 | Dodo Dashboard → Products → 归档四档一次性产品（$10/$20/$50/$100） | 产品不可再购买；未完成结账的链接失效 |
| 4 | 删除 Cloudflare secret | `npx wrangler secret delete DODO_API_KEY`（prod 与 `--env dev` 各一次）、`DODO_WEBHOOK_SECRET` 同上 | `npx wrangler secret list` 不再出现 `DODO_*` |
| 5 | 清理配置残留 | 仓库里 `DODO_*` / `__DODO_API_BASE__` 应为 0 处（迁移已删；A13 验收项） | `rg -n "DODO_|__DODO_API_BASE__"` 只应命中历史文档 |
| 6 | 归档对账单 | Dodo 结算单、发票、退款记录 | 与 Stripe 月结单放同一目录，供账务核对 |
| 7 | 关客户门户 | Dodo 客户门户（如仍对客户可见）停止入口 | 客服口径：账单与退款统一走 support@dessage.xyz |

**顺序理由**：先停 webhook 再吊销 key，避免已签发的回调在 key 吊销后集中失败；产品归档放最后，确保没有漏单还能人工处理。第 4 步之前不要删 secret——那是完整回滚到 Dodo 的唯一退路。

---

## 9. Secret 轮换

### 9.1 Webhook secret（可滚动）

代码接受多个 `v1=`，任意一个匹配即通过，所以可以双密钥滚动：

1. Stripe Dashboard → Webhooks → 端点 → Roll secret：记下新 secret；Stripe 会在一段时间内同时接受新旧 secret（以 Dashboard 提示为准，通常 24 小时）；
2. `npx wrangler secret put STRIPE_WEBHOOK_SECRET`（prod；dev 加 `--env dev`）；
3. 点 Send test event，确认 200 且 `webhook_events` 有行；
4. 在 Dashboard 完成滚动（旧 secret 失效）；
5. 再发一次测试事件，确认仍 200。

任何一步失败就停在旧 secret 上，不要两把同时删。

### 9.2 API key

1. Dashboard → Developers → API keys：创建/滚动新 `sk_live_…`；
2. `wrangler secret put STRIPE_SECRET_KEY`；
3. 建一笔 $12 测试单，确认收银台可打开（不付款也可，建单成功即证明 key 可用）；
4. 确认后再吊销旧 key；
5. dev 环境同样轮换（`--env dev`，test key）。

### 9.3 轮换后检查

- `wrangler secret list` 只有变量名，确认没有把 key 写进仓库或文档；
- `node scripts/stripe-reconcile.mjs` 退出码 0；
- 日志里没有 `key_mode_mismatch` / `webhook_secret_missing`。

---

## 10. 事故记录模板

```text
时间：
发现方式：（巡检 / Stripe 邮件 / 用户反馈）
影响：（多少单、金额、是否已扣款未入账）
根因：
处置：（冻结 / 补账 / 退款 / 回滚，执行的 SQL 与脚本输出摘要）
Stripe 引用：（pi_ / ch_ / dp_）
本地引用：（topup / payment / ledger id）
批准人：
后续动作：
```

---

## 11. 与其他文档的口径差异

- `stripe-migration.md` §9 第 4 步写「三个事件」，实际必须是 **4 个**（含 `checkout.session.expired`），以本文 §2.2 为准；
- 旧 review 建议的「每日巡检 pending 超过 1 小时」在本项目是正常现象（用户打开收银台不付款），本文取 **48 小时** 作为人工介入阈值；
- 本文不引入自动告警代码；若后续要做 cron + 邮件告警，单独立项并补 `ops.alert.*` 的 `audit_log` 约定。
