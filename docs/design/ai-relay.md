# AI 中转 + 双轨 Key（M1）

> 日期：2026-11-16
> 状态：设计定稿，**实现排在「按天计费」之后**，本文不含代码改动
> 关联：`docs/design/login-and-payment.md`（钱包与账本原语 §4.2/§4.7）、`docs/design/settings-ia.md`（AI 服务页）、`docs/contracts/commands.md`（§7.19 新增）
> 上游参考：`/Users/wesley/ai/TweetPilot/cloudflare/license-worker`（MIT，Copyright 2026 aiwithblockchain），复用清单与声明见 §10

---

## 0. 结论

| # | 决定 |
|---|---|
| 1 | 首次启动**不再强制填 Key**；设置里「AI 服务」两条**并列**：`Veyl 中转（余额扣费）` / `自带 DeepSeek Key（本地直连）` |
| 2 | 中转只接 **DeepSeek 官方 API**，只放行一个模型；供应商走可替换适配层 |
| 3 | 计费用**预扣 + 结算**两条账本流水，ref 都带 `request_id`，天然幂等 |
| 4 | **客户端中断按已生成内容结算**，不再全退（修参考实现的缺陷 1） |
| 5 | 结算补扣**封顶到余额**，差额由平台吸收并记账**（修参考实现的缺陷 2），且单请求有硬上限 |
| 6 | 赠送 **14 美分**（≈ ¥1）试用额度：**独立子余额、仅 AI 可用、30 天过期**，不进钱包账本 |
| 7 | 中转**不落对话正文**，只记 token 数与耗时 |
| 8 | 新增 2 条命令（`ai_relay_status` / `ai_usage_summary`），契约 `commands.md` → **2.31.0** |

---

## 1. 形态：两条并列，不是二选一

现有 `llm_provider_*`（list / save / delete / activate / test）已经是一个通用 provider 机制：`protocol`（openai / anthropic）+ `base_url` + `model` + `api_key`。**中转不需要新机制，它就是一条内置 provider**：

| | Veyl 中转 | 自带 Key |
|---|---|---|
| `provider_id` | `veyl-relay`（保留 id） | 用户自建 |
| `is_builtin` | `true` | `false` |
| `protocol` | `openai` | 用户选 |
| `base_url` | `https://<env>/v1/ai` | 用户填（默认 DeepSeek 官方） |
| `model` | `deepseek-chat` | 用户填 |
| `api_key` | **relay key**（§2） | 用户自己的 key |
| 费用 | 余额 / 试用额度扣 | 用户直接付给 DeepSeek |
| 可删除 | **否**（只能停用） | 是 |

**两条并列，但只有一条 active。** `settings-ia.md` 的「AI 服务」页给两张卡，卡上各自一个 `设为当前`；切换走已有的 `llm_provider_activate`，不新增命令。

- 内置中转**不出现在可删除列表里**：`llm_provider_delete` 对它返回 `PRECONDITION_FAILED / builtin_not_deletable`。
- 用户改「模型」不影响中转：中转只有一个模型，`llm_provider_save` 对 `veyl-relay` 只允许改 name，其余字段忽略并回原值。

---

## 2. 身份与 relay key

**中转的数据面凭据不能复用控制面的 access token**：access 只有 15 分钟，而一次对话会话远长于它；把 refresh token 交给 SDK 形态的调用方也是放大爆炸半径。

**relay key**：

| 项 | 规则 |
|---|---|
| 形态 | `vrelay_` + 32 字节 base64url |
| 存储 | 服务端只存 `sha256(key)`；Host 存密文（与 `TOKEN_SIGNING_JWK` 同处 `secrets.enc`，机器绑定 0600） |
| 有效期 | 30 天滑动：每次成功调用刷新 `last_used_at`，30 天不用即失效 |
| 签发 | 邮箱登录成功后由 Host 调 `POST /v1/ai/key` 签发（同一账户重复登录复用已有 key，不重签） |
| 吊销 | `my_server_logout` 时一并吊销；用途是「登出后这台设备不能再烧我的余额」 |
| 传输 | 只走 `Authorization: Bearer vrelay_…`，不落 URL |

- **为什么不是 access token**：需要 Host 每 15 分钟刷新一次 provider 凭据，而 `llm_provider` 的 key 是静态字符串；改造成本高于新签一个专用 key。
- **为什么不用设备身份**：设备是匿名账户的概念，登录后账户才是付费主体；中转必须绑账户。

---

## 3. 计费模型

> 本节按参考实现源码逐行核对后写：`license-worker/src/routes/metering.ts`（557 行）与 `src/lib/metering.ts`（524 行）。行号指该版本。

### 3.1 源码里的状态机（照抄并标注差异）

`handleChatCompletions`（`routes/metering.ts:369-557`）是**一条直线**，没有重试、没有状态回滚，只有「进到哪一步就退到哪一步」：

| # | 检查/动作 | 源码位置 | 失败行为 | Veyl 是否照抄 |
|---|---|---|---|---|
| 1 | 上游 secret 是否存在 | `:375` | `503 upstream_not_configured` | 照抄；**但挪到鉴权之后**（不向未登录者暴露部署状态） |
| 2 | 验 JWT → `account_key = email` | `:381`、`:75-93` | `401 unauthorized` / `invalid_token` / `account_email_missing` | 改成 **relay key → `account_id`**（§2） |
| 3 | `content-length > 1 MiB` | `:30`、`:386-389` | `413 request_too_large` | 照抄结构，阈值降到 **256 KiB** |
| 4 | JSON 解析 | `:392-397` | `400 invalid_json` | 照抄 |
| 5 | `model` 必须是非空字符串 | `:398-399` | `400 missing_model` | 照抄 |
| 6 | 定价行存在且 `in`、`out` 不全为 0 | `:415-419` | `503 model_not_priced`，**不扣费** | 改成 `UPSTREAM_ERROR / relay_not_configured`（§6） |
| 7 | 懒建账户 + **原子预扣** | `:422-432` | `402 insufficient_balance`，**不转发** | 改成 `recordLedgerEntry(ai_hold)`（§3.2） |
| 8 | `fetch` 上游（非流式带 60s 超时） | `:477-498` | 超时 `504` / 其它 `502`，**全额退预扣** | 照抄 |
| 9 | 上游非 2xx | `:501-507` | **原样透传上游响应** + 全额退预扣 | **改成映射到我们的 reason**（§6），不透传上游 body |
| 10 | 流式：`teeStream` + `waitUntil(settle)` | `:510-524` | 空 body → `502 upstream_empty_body` + 全额退 | 照抄结构 |
| 11 | 非流式：读 body → 解析 `usage` → **同步** `settle` | `:527-556` | 读失败 → `502 upstream_read_failed` + 全额退 | 照抄（同步结算保证客户端拿到响应时余额已更新） |

**四个常量**（`:29-38`）与 Veyl 的取值：

| 常量 | 参考实现 | Veyl | 理由 |
|---|---|---|---|
| `MAX_REQUEST_BODY_BYTES` | `1 MiB` | **256 KiB** | 对话请求远小于此；body 越大越容易烧上游 |
| `PRE_CONSUME_BUFFER` | `1000` credits | **2 分**（`PRE_HOLD_BUFFER_CENTS`） | 单位变了，缓冲也按分给；保留「估算 ≥ 实际」的安全垫 |
| `DEFAULT_MAX_TOKENS` | `8192` | **8192** | 照抄 |
| `UPSTREAM_TIMEOUT_MS` | `60_000`（**只对非流式**） | **60_000**，同样只对非流式 | 流式不加整段超时：长生成合法超过 60s，中途 abort 会杀掉健康流 |

**`max_tokens` 的两处上限不对称（源码里的坑，Veyl 必须修）**：

- 估算用 `min(body.max_tokens, DEFAULT_MAX_TOKENS × 2)` = **≤ 16384**（`:423-426`）；
- 发给上游用 `body.max_tokens ?? DEFAULT_MAX_TOKENS` = **没有上限**（`:456-457`）。

也就是说客户端传 `max_tokens: 100000` 时，**估算按 16384 扣，上游按 100000 生成**——预扣覆盖不住，只能靠结算补扣，而补扣又被钳到余额。这是缺陷 2 的放大器。

**Veyl 的修法**：估算与发送**用同一个值** `maxTokens = min(body.max_tokens ?? 8192, 8192)`，超出部分截断并在 `ai-request-end` 上带 `max_tokens_clamped: true`。

### 3.2 预扣 → 结算：每一段怎么改成 `recordLedgerEntry`

参考实现的余额三函数（`lib/metering.ts:203-300`）全部弃用，**只保留金额计算**。映射如下：

| 参考实现 | Veyl | 说明 |
|---|---|---|
| `ensureTokenAccount`（`:203`，懒建 `token_accounts`） | **删掉** | 账户由登录创建；余额就是 `accounts.balance_cents` |
| `atomicDeduct`（`:224`，`UPDATE … WHERE balance >= ?`） | `recordLedgerEntry({ kind:'charge', refType:'ai_hold', refId:request_id, amountCents:-estimate })` | 余额守卫由原语自带（`login-and-payment.md` §4.7 第 1 句的 `balance_cents >= -:amount`）；`changes === 0` 即余额不足 |
| `adjustBalance`（`:240`，退款/加钱） | 同一条原语的 `ai_settle`，金额取正负 | 退还 = `delta < 0`，余额自动加回 |
| `settleBalance`（`:268`，**补扣钳制**） | `recordLedgerEntry` + 余额守卫，差额记 `absorbed_cents` | 见 §3.5：封顶不再是无上限吸收 |
| `addBalance`（`:293`，充值） | 已有 `dodo_payment` 路径 | 不需要第二套充值 |
| `insertUsageLog`（`:416`，`request_id` 唯一） | `ai_usage_log`，**余额快照不再存** | 账本已有 `balance_after_cents`；只记 token 与金额 |

**两条 ref，不是三条**：

| 步骤 | kind | ref_type | ref_id | 金额 |
|---|---|---|---|---|
| 预扣 | `charge` | `ai_hold` | `<request_id>` | `-estimate` |
| 结算 | `charge` / `adjustment` | `ai_settle` | `<request_id>` | `∓delta`（正=补扣，负=退还） |

- `(ref_type, ref_id)` 唯一索引直接保证「重放不加钱、不重复退」——参考实现靠 `usage_log.request_id` 唯一索引做同一件事，但它**先动余额再写流水**，流水冲突时余额已经变了（`:322-327` 吞掉异常只打日志）。Veyl 的顺序反过来：**账本是余额的唯一来源**，不存在"余额改了流水没写"。
- **不要第三条 `refund` ref**：结算差额自带正负号。三条 ref 会让「哪条才是最终状态」变成三选一。
- `delta == 0` 时**不写结算行**；`ai_settle` 缺失是合法终态。

### 3.3 结算分支（`settle()`，`routes/metering.ts:260-333`）

| 输入 | 参考实现 | Veyl |
|---|---|---|
| `usage` 缺失，或 `prompt + completion === 0` | **全额退预扣** + 写 `amount = 0` 留痕流水 | 保留「全退」语义，但**只在上游确实没产出时**（见 §3.4）；留痕由 `ai_settle` 负向行承担，不再需要 `amount=0` 的假流水 |
| 有 `usage` | `amount = computeCost(...)`；`delta = amount - estimate`；`settleBalance(delta)` | 同公式，改走原语；`charged = estimate + actualDeduct` |
| 带 `prompt_tokens_details.cached_tokens` | 缓存价钳制在输入价以内（`lib/metering.ts:352-357`） | **照抄**这个钳制，防「命中比不命中还贵」 |

`computeCost` 的取整是 **round half up**（`:358-363`），`estimateCost` 是 **向上取整**（`:365-374`）。两者都要保留：估算向上保证覆盖，结算四舍五入保证公平。

### 3.4 中断结算：修缺陷 1（源码 `:247-252` 与 `:274-282`）

**参考实现的行为**：`teeStream` 的 `cancel()` 只做 `reader.cancel()` + `resolveDone()`，`usage` 保持 `null`；`settle()` 见到 `usage === null` 就**全额退预扣**。用户读完 3000 token 后断开，等于免费。

**Veyl 改成按已生成内容结算**：

| 情形 | 结算依据 |
|---|---|
| 正常结束 + 上游给了 `usage` | 真实 `prompt_tokens` / `completion_tokens` / `cached_tokens` |
| 中断，且已收到若干 chunk | **按已透传内容估算** `completion_tokens`（CJK 1.5 字符/token、其它 3.5，与 `estimateInputTokens` 同一套系数 `:317-342`）；`prompt_tokens` 用预扣时的估算值 |
| 一个 chunk 都没收到（上游 4xx/5xx/超时/空 body） | **全额退回**（`delta = -estimate`）——这是我们或上游的故障 |

- 实现落点：`teeStream`（`:192-257`）的 `pull()` 里已经在逐行 `JSON.parse` SSE，**顺手累加** `choices[0].delta.content` 与 `.reasoning_content` 的字符数即可，不新增解析。
- **`reasoning_content` 必须计入 completion**：深度思考模型靠它烧 token，不计等于纵容白用。
- 估算为 0 但确实收到过内容 → 按 1 token 计，避免「中断即免费」。
- 参考实现的 `cancel()` 里 `reader.cancel(reason).catch(() => {})` 保留：中断时必须停掉上游，否则我们继续为它付钱。

### 3.5 补扣封顶：修缺陷 2（源码 `lib/metering.ts:261-290`）

参考实现的 `settleBalance` 在 `delta > 0` 时执行 `UPDATE … SET balance = MAX(balance - ?, 0)`，**超过余额的部分静默消失**，没有上限、没有记账、没有告警（`:290-294` 只 `console.warn`）。

Veyl 的两条硬规则：

1. **单请求补扣封顶 = 预扣额本身**（`settleDebit ≤ estimate`）。预扣已按 `max_tokens` 估过，真超 2× 说明估算或上游计费有问题——该告警，不该继续扣。
2. **补扣只走可用余额，扣不动的部分记 `absorbed_cents`**，余额永不为负。

- `absorbed_cents > 0` → 写 `audit_log('ai_settle_absorbed')` + 计数告警。
- **不产生欠费、不冻结账户**：下一次请求会在预扣阶段被正常拒绝（`insufficient_balance`），这才是该有的收尾。
- 配 §3.1 的 `max_tokens` 修正后，补扣本应极少发生；它出现就意味着有 bug，所以宁可告警也不要"顺利扣完"。

### 3.6 单请求上限

| 项 | 值 | 对应源码 |
|---|---|---|
| 请求体 | 256 KiB | `:30`（参考 1 MiB） |
| `max_tokens` | ≤ 8192，估算与发送**同一个值** | `:423-426` 与 `:456-457` 的不对称（§3.1） |
| 单请求预扣 | ≤ `AI_REQUEST_MAX_CENTS = 100`（$1） | 参考实现没有这一项 |
| 并发 | 每账户 2 | 参考实现没有这一项 |

预扣超过 100 分时**不拒绝**，而是压低 `maxTokens` 使估算 ≤ 100 分，并在事件上带 `max_tokens_clamped`。直接报错对用户毫无用处。

### 3.7 余额扣穿

- **预扣阶段扣穿** → `402 insufficient_balance`，**不请求上游、不写任何流水**（与参考实现 `:429-432` 一致）。
- **结算阶段扣穿** → §3.5 的吸收路径，不阻塞下一次请求。
- **试用额度优先于充值余额**（§4）：先扣 `ai_trial_cents`，扣完再扣 `balance_cents`；两者都参与预扣校验。

---

## 4. 试用额度

| 项 | 决定 |
|---|---|
| 金额 | **14 美分**（≈ ¥1）。按 ¥1 ÷ 7.1 ≈ $0.1408 向下取整，永不超发；值放配置 `AI_TRIAL_CREDIT_CENTS`，可调 |
| 条件 | **邮箱账户首次登录成功后**发放，每个账户一次 |
| 有效期 | **30 天**，从发放时刻起算；过期由每日 Cron 清零 |
| 形态 | `accounts.ai_trial_cents` + `ai_trial_expires_at`，**不进 `wallet_ledger`** |
| 用途 | **只能用于 AI 调用**，不能买服务器、不能转成余额、不能退 |
| 混用 | 扣费顺序「先试用、后余额」；**但试用额度不会变成余额** |

- **为什么不走账本**：钱包账本的每一分钱都是「用户付的或我们承诺可退的」，试用额度两者都不是。塞进 `wallet_ledger` 会污染「余额 = 账本合计」这条不变量，还会让 §4.12 的快照/裁剪多一类要特殊对待的行。
- 因此**「余额 = 账本合计」依然成立**，`balance_cents` 不含试用额度；界面分别展示（§9）。
- 过期清零：`UPDATE accounts SET ai_trial_cents = 0 WHERE ai_trial_expires_at <= now AND ai_trial_cents > 0`，幂等，并入每日 Cron。
- 发放幂等靠 `accounts.trial_granted_at IS NOT NULL`，不需要账本 ref。

**防刷**

| 层 | 做法 |
|---|---|
| 账号 | 必须邮箱验证过（发码本身有冷却 + IP 限频，见 `login-and-payment.md` §2.3）；一账户一次 |
| 设备 | 同一 `device_id` 换邮箱登录会生成新账户 → **同一设备 90 天内最多 3 个账户获得试用**，超过的只发余额不足提示 |
| IP | 同一 IP 24h 内发放 > 10 次 → 记录并告警，**不自动拒绝**（大陆共享出口很常见，自动拒绝会误伤大量真实用户） |

- 试用额度是**约 ¥1**，刷它的收益远低于刷服务器；所以防刷以「留痕 + 告警 + 设备上限」为主，不做硬阻断，避免误伤。

---

## 5. 隐私

**默认不落对话正文。** 中转侧只保存这些字段：

| 字段 | 说明 |
|---|---|
| `request_id` | uuid，日志与账本的唯一关联 |
| `account_id` | 计费主体 |
| `model` / `upstream` | 计费与排障 |
| `prompt_tokens` / `completion_tokens` / `cached_tokens` | 计量 |
| `held_cents` / `charged_cents` / `absorbed_cents` | 账 |
| `status` | `ok` / `aborted` / `upstream_error` / `timeout` |
| `elapsed_ms` | 性能 |
| `created_at` | 时间 |

- **没有 `content`、没有 `messages`、没有 `response_text`** —— 不是「默认不存、可以打开」，而是表里根本不建这些列。
- **Worker 日志只打 `request_id` + 计数**：不打 body、不打 prompt、不打响应文本。上游的 4xx 原文也不整段落到日志（可能回显用户输入），只记 `status` 与 `error.type`。
- **界面必须写明**：设置 → AI 服务 → 中转卡片下一行小字「Veyl 只记录 token 数与耗时，不保存你的对话内容。」这一行不可省略——用户把整段对话交给第三方中转，有权知道留下了什么。
- 保留期：明细 **30 天**（与账本 `server_day` 一致的口径），过期聚合进 `ai_usage_daily` 后删除明细。

---

## 6. 契约增量（`commands.md` → 2.31.0）

**新增 2 条命令**（都不注册为 AI 工具）：

```ts
type AiRelayStatus = {
  available: boolean;              // 内置 provider 存在且 relay key 有效
  balance_cents: number;           // 钱包余额（不含试用）
  trial_cents: number;             // 试用剩余
  trial_expires_at: string | null; // ISO 8601；没有试用时为 null
  today_used_cents: number;        // 今日 AI 消耗（试用 + 余额合计）
  daily_limit_cents: number;       // 今日上限（§8），0 = 不限
  key_expires_at: string | null;   // relay key 到期时间
};

type AiUsageSummary = {
  days: number;                    // 1–30
  totals: { requests: number; prompt_tokens: number; completion_tokens: number; charged_cents: number; absorbed_cents: number };
  daily: Array<{ day: string; requests: number; prompt_tokens: number; completion_tokens: number; charged_cents: number }>;
};
```

| 命令 | 参数 | 返回 | 说明 |
|---|---|---|---|
| `ai_relay_status` | `{}` | `AiRelayStatus` | 设置页两张卡与首次启动判断用；只读，联网 |
| `ai_usage_summary` | `{ days?: number }` | `AiUsageSummary` | 最近 N 天（默认 7，上限 30）按天聚合 |

**已有命令的语义收紧**：

- `llm_provider_delete { provider_id: "veyl-relay" }` → `PRECONDITION_FAILED / builtin_not_deletable`。
- `llm_provider_save` 对 `veyl-relay` 只接受 `name`，其余字段原样返回旧值（不报错，避免前端表单整体失败）。
- `llm_provider_list` 的第一项固定是 `veyl-relay`（`is_builtin: true`），排序稳定。

**错误码**（沿用通用码 + `details.reason`，中转 HTTP 层与 Host 层同一套）：

| 场景 | HTTP | code | reason | retryable |
|---|---|---|---|---|
| 余额与试用都不够 | 402 | `PRECONDITION_FAILED` | `insufficient_balance`（带 `shortfall_cents`） | 是（充值后重试） |
| 今日用量超限 | 429 | `RATE_LIMITED` | `daily_quota_exceeded` | 是（次日） |
| 每分钟/并发超限 | 429 | `RATE_LIMITED` | `rate_limited` | 是 |
| 上游限流 | 429 | `UPSTREAM_ERROR` | `upstream_rate_limited` | 是 |
| 上游内容审核拒绝 | 400 | `PRECONDITION_FAILED` | `content_rejected` | 否 |
| 上游超时 | 504 | `TIMEOUT` | `upstream_timeout` | 是 |
| 上游不可达 / 5xx | 502 | `UPSTREAM_ERROR` | `upstream_unreachable` | 是 |
| 上游未配置或定价缺失 | 503 | `UPSTREAM_ERROR` | `relay_not_configured` | 否 |
| 模型不在白名单 | 400 | `PRECONDITION_FAILED` | `model_not_allowed` | 否 |
| relay key 失效 | 401 | `UNAUTHENTICATED` | `token_invalid` | 是（Host 自动重签后重试） |

- **事件不需要新增**：`ai-request-end` 已经带 `usage` 与 `result`（`events.md` §3.x）。中转只影响 Host 发出的 HTTP 请求，不上报新事件。
- 因此 `events.md` / `tools.md` / `runtime.md` / `data-model.md` **不变**。

---

## 7. 上游与配置

### 7.1 供应商适配层

```
src/ai/providers/types.ts        <- AiProvider: { id, chat(req, key, signal), mapUsage(raw) }
src/ai/providers/deepseek.ts     <- 唯一的实现（M1）
src/ai/relay.ts                  <- 与供应商无关：鉴权 / 限流 / 预扣 / 结算 / tee
```

- `relay.ts` **不认识 DeepSeek**：base URL、模型名映射、usage 字段形状全部由 `AiProvider` 给出。
- 换供应商（将来接第二家）只加一个 `providers/*.ts` + 一行配置，不改计费与鉴权。
- 参考实现的 `UPSTREAM_MODEL_ID_MAP`（计费键 → 数据面模型 ID）保留这个形状：计费键稳定，上游换版本只改映射。

### 7.2 配置

| 名字 | 位置 | 值 / 说明 |
|---|---|---|
| `DEEPSEEK_API_KEY` | **Worker secret** | 只服务端持有；不进仓库、不下发客户端 |
| `AI_RELAY_ENABLED` | vars | `"true"` / `"false"`，开关；false 时 `ai_relay_status.available = false` |
| `AI_RELAY_BASE_URL` | vars | `https://api.deepseek.com/v1` |
| `AI_RELAY_MODELS` | vars | `{"deepseek-chat":"deepseek-chat"}`（计费键 → 上游模型名） |
| `AI_RELAY_PRICING` | vars | `{"deepseek-chat":{"in":2,"out":8,"cache":0}}`，单位**美分 / 1M tokens**，整数 |
| `AI_TRIAL_CREDIT_CENTS` | vars | `14` |
| `AI_TRIAL_DAYS` | vars | `30` |
| `AI_REQUEST_MAX_CENTS` | vars | `100`（$1） |
| `AI_DAILY_LIMIT_CENTS` | vars | `500`（$5/天/账户），0 = 不限 |

**启动校验（fail closed，不能等到第一个请求）**：

1. `AI_RELAY_MODELS` 的键集合必须等于 `AI_RELAY_PRICING` 的键集合——不一致时**整个中转不可用**（`relay_not_configured`），并打一条明确日志，指出缺哪一边。
2. 每个价格必须是**正整数**美分；`in` 与 `out` 任一为 0 视为未定价。
3. `AI_RELAY_ENABLED=true` 但 `DEEPSEEK_API_KEY` 缺失 → 同上，不可用。
4. 校验结果缓存 60 秒，不必每请求重算。

- **定价单位用「美分 / 1M tokens」而不是美元浮点**：全链路整数，与钱包一致，避免 `0.27` 这种浮点在 1e6 量级上丢精度。
- **DeepSeek 调价**：改 `AI_RELAY_PRICING` 即可，**不影响已发生的扣费**（扣费按发生时读到的价格算，`ai_usage_log` 里有 `price_snapshot` 字段留痕）。

### 7.3 BYO Key 的存放

- 用户自带的 DeepSeek key 存在**本地加密存储**（`secrets.enc`，机器绑定、0600），**不上云、不进中转**。
- 与既有实现一致：`control_plane/auth.rs` 已明确「不读写系统钥匙串」，登录令牌也走 `secrets.enc`；BYO key 沿用同一个存储层，**不在本期引入 keychain**（换了只改这一处，不影响契约）。
- `llm_provider_list` 只回 `has_key: boolean`，**永不回 key 本身**（现有实现已如此）。

---

## 8. 限流与防刷

| 维度 | 阈值 | 触发后 |
|---|---|---|
| 每分钟请求数 | 20 / 账户 | `429 rate_limited` |
| 并发 | 2 / 账户 | 第 3 个直接 `429 rate_limited`，不排队 |
| 单请求 `max_tokens` | 8192 | 截断 + `max_tokens_clamped` |
| 单请求预扣 | 100 分 | 压低 `maxTokens` 使估算 ≤ 100 分 |
| 每日消耗 | 500 分 / 账户 | `429 daily_quota_exceeded` |
| 异常熔断 | 单账户 1 小时内 `absorbed_cents > 0` 出现 ≥ 3 次 | 告警 + 标记该账户待人工复核（**不自动封禁**） |

- 计数放 D1 的 `rate_limits` 表（已有），窗口用「账户 + 分钟」主键，`INSERT … ON CONFLICT DO UPDATE SET n = n + 1` 一条语句完成。
- **并发用已有的 request 表**（`pending_requests` 风格）：插入成功才放行，请求结束删除；崩溃残留由每日 Cron 清理 15 分钟以上的行。
- **不按 token 数限流**：token 是结算后才知道的，限流要发生在预扣之前。

---

## 9. 界面

### 9.1 设置 → AI 服务（分区 id 仍是 `ai`）

现有页面在 `settings-ia.md` §1.2 里已经改成「服务与模型」。本期加**两张并列的卡**：

```
┌─ Veyl 中转 ──────────────────────── ● 当前 ─┐
│ 余额 $9.87 · 试用 $0.12（28 天后过期）        │
│ 今日已用 $0.03 / $5.00                       │
│ Veyl 只记录 token 数与耗时，不保存对话内容。   │
│                          [ 充值 ]  [ 查看用量 ] │
└──────────────────────────────────────────┘
┌─ 自带 DeepSeek Key ─────────────────────────┐
│ 直接连 DeepSeek，费用由你自己的账户结算       │
│                          [ 设为当前 ]        │
└──────────────────────────────────────────┘
```

- 两张卡**同一视觉权重**，不做「推荐」角标压另一张（用户已经明确要两条并列）。
- 中转卡只在 `available = true` 时出现；不可用时整张卡换成一行「中转暂不可用」+ `重试`，**不展示假余额**。
- 「查看用量」打开一个**只读**小结（今日/7 天/30 天：请求数、token、花费），复用 `ai_usage_summary`。**不展示每次请求的明细**——明细里有时间戳，配上对话历史就等于行为画像，收益不抵风险。
- 「余额」与「试用」**分两行显示**：合成一个数字会让用户以为试用额度能买服务器。

### 9.2 首次启动

现在：`DeepSeek API Key + 保存并验证` 是视觉重点，不填就用不了助手。

改成三入口，**都不阻塞**：

| 顺序 | 内容 | 说明 |
|---|---|---|
| 1 | `用 Veyl 中转`（主按钮） | 登录后自动用试用额度；不需要任何 Key。未登录则先弹统一登录弹窗 |
| 2 | `使用我自己的 Key`（次按钮） | 展开现有表单；文案保留「我已有 DeepSeek Key」 |
| 3 | `我懂网络，不用 AI`（文字链接） | 不变 |

- **不在首次启动展示余额与价格**：还没用就想收费，转化最差。试用额度那一句只在设置页出现。
- 选 1 之后照常进入第一问「怎么接管」，助手立刻可用。
- 已有用户（`hasEverConnected` 或已有 provider）**不再走这个页面**，`veyl-ui` §2.3 的规则不变。

### 9.3 对话里的错误

中转错误进 `ai-request-end` 的 `error`，界面按三段式：

| 场景 | 文案 |
|---|---|
| 余额不足 | 「中转余额不足（还差 $0.03），充值后可以继续。」+ 充值入口 |
| 每日上限 | 「今天的中转额度用完了，明天恢复；也可以换成自己的 Key。」 |
| 上游限流 | 「中转有点忙，几秒后重试。」+ `重试` |
| 内容被拒 | 「这次请求被上游拒绝了。换个说法再试，或换成自己的 Key。」 |

---

## 10. 复用清单与 MIT 声明

参考实现：`/Users/wesley/ai/TweetPilot`，LICENSE 在**仓库根**（`license-worker/` 下没有单独 LICENSE）。

### 10.1 声明放哪（按 LICENSE 原文抄，不要改写）

**新建 `/Users/wesley/ai/veyl/THIRD-PARTY-NOTICES.md`**，内容分两段：

```
# Third-Party Notices

## TweetPilot (AI relay metering)

The AI relay billing module under `cloudflare/control-plane/src/ai/` is derived
from TweetPilot's license-worker (`cloudflare/license-worker`), used under the
MIT License. Files derived from it carry a header comment pointing here.

MIT License

Copyright (c) 2026 aiwithblockchain

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

**每个派生文件头部两行**：

```
// Derived from TweetPilot license-worker (cloudflare/license-worker).
// MIT License, Copyright (c) 2026 aiwithblockchain. See THIRD-PARTY-NOTICES.md.
```

- 这两行是 **MIT 原文第二段「shall be included in all copies or substantial portions」的直接要求**，不是礼节。
- 判断标准：只要文件里**实质性包含**了对方代码（搬了函数体、搬了表结构、搬了测试用例），就必须带；只是参考了思路、自己重写的，可以不带，但**表结构和测试用例算实质部分**。

### 10.2 逐文件（按源码核对）

| 参考文件（行数） | Veyl 落点 | 搬哪些 / 改哪些 |
|---|---|---|
| `src/lib/metering.ts`（524 行） | `src/ai/estimate.ts` | **搬**：`estimateInputTokens`（`:325-342`，CJK 1.5 / 其它 3.5 字符每 token + 每消息 4 token）、`computeCost`（`:346-363`，round half up + 缓存价钳制在输入价内）、`estimateCost`（`:365-374`，向上取整）。**弃**：`ensureTokenAccount` / `atomicDeduct` / `adjustBalance` / `settleBalance` / `addBalance`（`:203-300`）、`getPricing` 的 D1 读取（`:304-313`）、`cleanupOldUsageLogs`（`:474-524`） |
| `src/routes/metering.ts`（557 行） | `src/ai/relay.ts` | **搬**：`teeStream`（`:192-257`，pull/cancel 结构、`[DONE]` 补发、逐行 SSE 解析）、请求直线（`:369-557`）、「非流式同步结算、流式 `waitUntil` 结算」的分流。**改**：鉴权换 relay key（§2）、上游换 `AiProvider`、结算走 `recordLedgerEntry`（§3.2）、中断按已生成内容结算（§3.4）、补扣封顶（§3.5）、上游非 2xx 映射成我们的 reason 而不透传 body |
| `src/lib/volcengine.ts`（248 行） | `src/ai/providers/deepseek.ts` | **只参考形状、不搬代码**：计费键 → 数据面模型 ID 的映射表（`UPSTREAM_MODEL_ID_MAP` 的形状值得保留：计费键稳定、上游换版本只改映射）、请求体构造、超时策略 |
| `src/lib/pricing-basis.ts`（186 行） | — | **不搬**。它服务 `price-monitor` 的「滚动峰值基准 + 倍率」算法（取 7 天窗口内 `max(现价, 原价)` 的峰值），目的是让售价在上游频繁调价时保持稳定。Veyl M1 只有一个上游、一个模型、价格由我们手配，不需要滚动基准；等真接第二家再回来看 |
| `migrations/0001_init.sql` 的 `usage_log` | `cloudflare/control-plane/migrations/0004_ai_relay.sql` | **搬表结构、改名 `ai_usage_log`**：保留 `id` 自增、`request_id` 部分唯一索引（`WHERE request_id IS NOT NULL`）、`(account_key, ts)` 索引改成 `(account_id, created_at)`、token 三列。**删**：`account_key`（换 `account_id`）、`balance_after`（账本已有）、`ratio_note`。**不搬** `0005_daily_usage_agg.sql` 的 `cost` / `cost_original` 双口径。**加**：`held_cents` / `charged_cents` / `absorbed_cents` / `status` / `elapsed_ms` / `price_snapshot` |
| `src/lib/metering.test.ts` | `test/ai-estimate.test.ts` | **整组搬**（纯函数，不需要改断言）：`computeCost` 四条（整百万折算、单/零 token、round half up、缓存价回退）、`estimateCost` 两条（估 ≥ 实、向上取整）、`estimateInputTokens` 四条（非数组、固定开销 + CJK 折算、CJK 高于英文、多语言）、`upstreamPriceToCredits` 四条（系数、换算、取整） |
| `src/routes/metering-flow.test.ts` | `test/ai-relay.test.ts` | **搬 15 条用例的骨架，重写断言**：无效 JWT→401、未配置→503、未定价→503、余额 0→402、非流式成功、缓存命中分包计价、流式成功 + `[DONE]`、上游 500 全退、网络错误全退、usage 缺失全退、余额恰好一次预扣（第二次 402）、补扣钳制、补扣足额无 absorbed。**不搬**：思考档位后缀（`:248`、`:296`，那是火山 `thinking`/`reasoning_effort` 的参数，DeepSeek 不同）、支出双口径（`:63`、`:117`）。**新增**：中断按已用结算、两条 ref 幂等、试用额度优先扣、`max_tokens` 截断 |
| `src/routes/trial.ts`（81 行） | — | **不搬**。它是「30 天免费订阅」（写 `paid_until`），与「14 分 AI 额度」不是一回事；只借「一账户一次」的幂等思路 |
| `price-monitor` / `finance` / `admin*` / `images` / `videos` / `voices` / `tts` / `enterprise-*` / `updater` | — | **不搬、不参考**。定价监控、财务汇总、多媒体路由、管理后台全部超出 M1 范围 |

### 10.3 不搬的东西，以及为什么

- **`token_accounts` 独立余额表**（`0001_init.sql:10`）：Veyl 已有 `accounts.balance_cents` + `wallet_ledger`，再来一张余额表就是两个真相。余额函数全部换成 `recordLedgerEntry`。
- **`settleBalance` 的无上限钳制**（`lib/metering.ts:261-290`）：缺陷 2 的源头（§3.5）。
- **`usage_log.balance_after`**（`:28`）：账本已有 `balance_after_cents`，不再存第二份余额快照，否则两处会对不上。
- **`daily_usage_agg` + 7 天清理**（`:447-524`）：Veyl 的保留期口径是 30 天（§5），聚合表另建，不沿用它的 7 天。

---

## 11. 验收（W17–W26）

W1–W16 见 `login-and-payment.md` §7；本节从中断处继续编号。

| # | 断言 |
|---|---|
| **W17** | **首次启动不填 Key 可用**：全新账户 → 选「用 Veyl 中转」→ 登录 → 发一句话 → 拿到回复；`ai_relay_status.trial_cents` 从 14 减少，`balance_cents` 不变 |
| **W18** | **试用额度只发一次**：同一账户重复登录 3 次，`accounts.trial_granted_at` 不变、`ai_trial_cents` 不叠加 |
| **W19** | **余额扣费正确**：试用额度耗尽后再调一次 → 扣 `balance_cents`；账本两条（`ai_hold` / `ai_settle`），金额之和等于 `computeCost` 的结果 |
| **W20** | **流式中断按已用结算**：发一条长回答，收到约 1/3 后断开 → 只退 `estimate - 已生成部分`；**不是全退**；`ai_usage_log.status = 'aborted'` 且 `completion_tokens > 0` |
| **W21** | **一个 chunk 都没收到时全退**：上游 500 / 超时 → `ai_settle` 金额等于 `+estimate`，用户净支出 0 |
| **W22** | **补扣封顶**：构造 `actual > estimate` 且余额只够一半 → 实扣 = 余额可扣部分，`absorbed_cents > 0`，**余额恰好为 0 不为负**，下一次请求 `insufficient_balance` |
| **W23** | **幂等**：同一 `request_id` 重放整套结算 3 次 → 账本仍是那两行，余额不变；`ai_settle` 缺失时（`delta = 0`）重放仍不写行 |
| **W24** | **自带 Key 不受影响**：切到「自带 DeepSeek Key」→ 对话走本地直连，`ai_usage_log` 无新行、余额不变；切断网络对中转的访问也不影响自带 Key |
| **W25** | **上游故障提示**：模拟 DeepSeek 429 / 内容拒绝 / 超时 → 界面分别是「有点忙，几秒后重试」/「这次请求被上游拒绝了」/「超时」，**都不报「余额不足」**，且 `details.reason` 与 §6 的表一致 |
| **W26** | **`max_tokens` 上下限一致**：客户端传 `max_tokens: 100000` → 实际发给上游的是 8192（不是 100000），事件带 `max_tokens_clamped: true`，估算与发送用同一个值；**不允许出现「按 8192 估、按 100000 生成」**（参考实现的缺陷，见 §3.1） |

---

## 12. 非目标与待核

| 不做 | 说明 |
|---|---|
| 多模型 / 多供应商同时在线 | M1 只有 DeepSeek 一个模型；适配层已经留好，加第二家只加一个文件 |
| 对话正文留存 / 回放 | 表里没有正文列（§5），不是开关 |
| 按 token 购买套餐 | 只做余额按量扣 |
| 试用额度转余额 / 退款 | 只能用于 AI 调用（§4） |
| 中转的计费明细页 | 只给按天聚合，不给逐笔（§9.1） |
| 管理后台 / 定价监控 | 价格改配置，不给后台 |
| 多模态（图片 / 视频 / TTS） | 参考实现里这些全部不搬 |

**待核**

| # | 事项 | 影响 |
|---|---|---|
| 1 | DeepSeek 官方现价（in/out/cache 各是多少美分/1M） | 填 `AI_RELAY_PRICING` 的真实值；本文示例值仅占位 |
| 2 | DeepSeek 流式是否在最后一个 chunk 返回 `usage`（需 `stream_options.include_usage`） | 若不返回，中断与正常结束都只能靠估算 |
| 3 | DeepSeek 的内容审核错误码形状 | 决定 `content_rejected` 的判定条件 |
| 4 | Workers 对「流式响应 + `waitUntil` 后台结算」的时限 | 结算必须在 `waitUntil` 内完成；若超时需改由 Cron 兜底对账 |
