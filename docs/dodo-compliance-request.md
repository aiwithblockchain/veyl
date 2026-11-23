# Dodo 合规询问（软件订阅 · 新主体独立开户）

> 日期：2026-11-22（改写自同一文件的「主体迁移」版本）
> 状态：邮件待发送（未发送）；本文不含代码改动
> 关联：`docs/design/software-subscription.md`、`docs/design/byo-digitalocean.md`、`docs/design/login-and-payment.md` §4.8
> 来源分级：**[文档]** = Dodo 官方文档原文；**[仓库]** = 本仓库代码或设计文档；**[推断]** = 文档未写、按惯例推断；**[未核实]** = 尚无权威说法
> Dodo 依据页面：`docs.dodopayments.com/miscellaneous/merchant-acceptance.md`、`.../verification-process.md`、`.../accepted-countries-and-territories.md`

---

## 0. 一页结论

| 问题 | 结论 | 依据 |
|---|---|---|
| 现在问什么 | 不是「能不能迁主体」，而是「**卖软件、用户自带云账号**是否落入禁止清单里 "VPN, VPS or dedicated servers…" 那一条」 | 方案已改为软件订阅 [仓库] `software-subscription.md` |
| 还卖服务器吗 | 不卖。不代建、不转售 compute、不代收机器费 | [仓库] `byo-digitalocean.md` |
| 还有余额吗 | 没有。订阅是唯一交易，不存在 stored value | [仓库] |
| 新账户挂在哪 | 首选**同一账户下新增一个 business**（官方支持，最多 10 个）；是否允许不同法人持有、以及该 business 被拒是否波及同账户其他 business，文档未写明，必须问 | FAQ Q7/Q177 [文档] |
| 要不要提现有账户 | **要**，但表述为「不同法人、无共用产品与结算」 | 隐瞒关联账户是风控典型信号 [推断] |
| 类目能不能过 | 未知。「VPN 客户端」仍在灰区，必须书面确认 | 该条标题是 "Hosting, servers, and infrastructure services"，正文含 "VPN" [文档] |
| 最可能的答复 | 允许 / 要求增强尽调 / 以「VPN and Proxies」为由拒绝 | [推断] |

马来西亚在受理名单内（177 个辖区之一）[文档]，主体资质不是瓶颈；**类目**才是。

---

## 1. 合规邮件（定稿）

发送地址：`compliance@dodopayments.com`。正文用英文，原样粘贴。

```text
Subject: New merchant inquiry — Malaysian entity, desktop software subscription

Hi Dodo team,

We are preparing to apply for a merchant account for a new Malaysian company,
and we would like to confirm one point before we start, so that we do not
misdescribe the product on the application form.

What the product is
- Veyl is an open-source desktop application for macOS and Windows
  (Apache-2.0). It helps a user manage a server that they already own.
- The customer signs up with a cloud provider (currently DigitalOcean)
  directly, on their own account and their own payment method. They then
  authorize our application through the provider's OAuth flow. Veyl creates
  and configures one server inside the customer's own account, and the
  desktop app connects the customer's devices to that server.
- We do not supply, resell, or provide access to infrastructure. We never
  bill for compute, storage, or bandwidth, and we never hold customer funds.
  Our only revenue is a software subscription: USD 6 per month, or USD 39
  per year, for which Dodo would act as merchant of record.
- There is no stored balance, no top-up, and no credits of any kind. The
  subscription is the only transaction on the account.

Our questions
1. Under "Hosting, servers, and infrastructure services", the Merchant
   Acceptance Policy lists "VPN, VPS or dedicated servers, hosting plans,
   cloud compute credits, bandwidth reselling... any product that provides
   users with persistent infrastructure or server-level access." Our product
   is software that configures a server the customer already owns and pays
   for directly. Does that clause cover us, or is it aimed at parties that
   supply the infrastructure itself? If it does, is there an enhanced due
   diligence path?
2. If the above is acceptable, is a desktop client of this kind treated as a
   software product, or does it fall under the restricted "VPN and Proxies"
   category?
3. We would prefer to add a second business to our existing account rather
   than open a separate account. The new business would be a Malaysian legal
   entity, selling a different product, with its own bank account and tax
   details. Two questions: (a) can a business under an existing account be
   held by a different legal entity; and (b) if review of that new business
   ends in a negative decision, does it affect the other business already
   operating on the same account?
4. Which documents would you need beyond the certificate of incorporation,
   company registration number, and government IDs for all directors and
   every beneficial owner holding 10% or more?

If this is not a product you are able to support, we would rather know before
starting an application than after.

Kind regards,
[Signatory name]
[Title]
[Company legal name, registration no.]
[email] · [phone]
```

### 1.1 发送前必须做完的事

| # | 项 | 为什么必须先做 |
|---|---|---|
| 1 | **清掉共用账户里的 Veyl 产品** | 邮件说「无共用产品」；只要后台还挂着 Veyl 的 live 产品，这句就是假的。只删无交易的产品；有交易就改成如实描述，别删记录 |
| 2 | 马来西亚实体已注册，拿到法定全称 + 注册号 | 未注册就删掉注册号那一行，并把开头改成 `we intend to incorporate in Malaysia` |
| 3 | 发件邮箱用公司域名 | 公共邮箱会降低可信度；有已认证域名更好 |
| 4 | 署名人与职位、电话，与未来的 KYB 提交人一致 | 前后对不上会触发追问 |
| 5 | 站点口径已改成软件订阅 | **邮件本身不触发审核，但正式申请会看站点**。站点还写着「自建服务器 / 按天计费 / 余额充值」时提交，描述与站点不一致是最常见的 hold 原因 |

两条写作纪律不变：不要附截图；不要写「我们会改文案」——那读起来像找过审措辞。

### 1.2 问 Dodo AI 的版本（用户手动转发）

> AI 的答复是**参考**，不是合规结论。若它说「可以」，仍需按 §1 的邮件向 `compliance@dodopayments.com` 要一份书面确认，再提交 KYB。

```text
I'm evaluating Dodo Payments for a new Malaysian company and need a category
ruling before applying.

Product: an open-source desktop app (macOS/Windows) that manages a server the
customer already owns. The customer signs up with a cloud provider
(DigitalOcean) on their own account and own payment method, then authorizes
our app through the provider's OAuth flow. Our app creates and configures one
server inside the customer's own account. We never supply, resell, or bill for
compute, storage, or bandwidth.

Revenue: a software subscription only — USD 6/month or USD 39/year. No stored
balance, no top-ups, no credits. The subscription is the only transaction.

Questions:
1. Under "Hosting, servers, and infrastructure services", the Merchant
   Acceptance Policy lists "VPN, VPS or dedicated servers, hosting plans,
   cloud compute credits, bandwidth reselling... any product that provides
   users with persistent infrastructure or server-level access." Does software
   that configures a server the customer already owns and pays for fall within
   that clause?
2. Is this treated as a normal software subscription, or does it fall under
   "VPN and Proxies"?
3. Can I add a second business to my existing Dodo account, owned by a
   different legal entity (a Malaysian company) with its own bank account and
   tax details? And if that new business is rejected, does it affect the other
   business already operating on the same account?

If that clause applies, is there an enhanced due diligence process we can go
through?
```

如果它只回一句「请参考商户政策」，追问：

```text
Please answer for this specific case: does software that configures a server
the customer already owns and pays for fall under that clause? Please cite the
exact policy text your answer is based on.
```

---

## 2. 马来西亚 Sdn Bhd 走 Dodo KYB 的材料清单

标记：✅ 已有 ｜ ⚠️ 部分或有条件 ｜ ❌ 缺 ｜ ❓ 未确认

| # | 材料 | Dodo 要求 | 我方现状 | 下一步 |
|---|---|---|---|---|
| 1 | 公司注册证书（或等效文件） | "Certificate of Incorporation or equivalent" [文档] | ❓ | 向 SSM 取，核对名称与第 2 项一致 |
| 2 | Company Registration Number | 必填 [文档] | ❓ | 与证书同批取 |
| 3 | 全部董事的政府身份证件 | 全体董事 [文档] | ❓ | 确认每本证件签发国在受理名单 |
| 4 | ≥10% 实益拥有人的身份证件 | 都要 [文档] | ❓ | 列名单，别漏间接持股 |
| 5 | 证件签发国在受理名单 | 董事、UBO 均须 [文档] | ✅ 马来西亚、中国均在列 [文档] | 无 |
| 6 | 银行账户名与公司法定名称**逐字一致** | 不一致不能打款 [文档] | ❓ 需开新户 | 先开户；不得用个人或第三方账户 |
| 7 | W-8BEN-E 税表 | 英国实体明确要求 [文档]；马来西亚未写明 [未核实] | ❌ | 以表单提示为准，或直接问 |
| 8 | Tax ID | 可选，填了才印在结算发票上 [文档] | ❓ | 有就填 |
| 9 | 站点公开可访问 | 打不开是常见 hold 原因 [文档] | ✅ `https://veyl.dessage.xyz` 返回 200 | 无 |
| 10 | 定价，含计费周期 | 未登录访客可见 [文档] | ❌ 站点仍是按天价 | 改成 `$6/月`、`$39/年` 两档，与邮件和表单三处一致 |
| 11 | Terms of Service | 必须可见 [文档] | ❌ | 新写 |
| 12 | Privacy Policy | 必须可见 [文档] | ❌ | 新写；如实写控制面存了什么，**明确写「我们持有不到你的云凭据」** |
| 13 | 退款 / 取消政策 | 必须可见 [文档] | ❌ | 跟随 MoR 政策；**不要再提「未消耗余额」——没有余额了** |
| 14 | 可用联系方式 | 必须有 [文档] | ❌ 全站无邮箱 | 加 `mailto:` 或联系页 |
| 15 | 站点描述与表单一致 | 产品、定价、交付方式都要一致 [文档] | ⚠️ 站点明写 VPN / VPS / 自建服务器 | 与邮件同一句话：「桌面客户端，用户自带云账号」 |
| 16 | 英文版 | 文档未强制，但审核读不了中文 [推断] | ❌ 全站 `lang="zh-CN"` | 至少法务页与产品页英文 |
| 17 | 页脚运营主体 | KYB 常规项 [推断] | ❌ 只有 `© 2026 Veyl` | 法定全称 + 注册号 + 地址 + 邮箱 |

KYB **3 次尝试**，失败可申诉 1 次、结论终局 [文档]。别拿正式提交当试错。

---

## 3. 答复分支

### A. 允许（含「增强尽调后通过」）

1. **存档书面答复**，类目结论以后是唯一凭据。
2. **开独立商户账户**，绑新公司实体与银行账户；不与 TweetPilot 共用。
3. **补站点 P0**（§2 第 10–17 项）后再提交 KYB。
4. **接通道**：按 `software-subscription.md` §4 接托管收银台，事件从充值改为订阅生命周期。
5. **真实结算验证一次**：订阅 → 续费 → 结算到新银行账户，跑通再放量。

### B. 附条件（例如：可以，但不能是 VPN 客户端）

1. 让 Dodo 把条件写成具体条款，不接受「注意一下」这类口头限定。
2. 评估条件是否可满足：如果要求「不做连接类功能」，产品定位需要重做，属于新一轮产品评审，不在本文范围。
3. 不能满足就按 C 处理。

### C. 拒绝

1. **不提交 KYB**；书面确认 TweetPilot 现有账号不受影响（不同法人、不同账户，理论上不该受影响）。
2. **换通道**，顺序见 `software-subscription.md` §4.3：Polar（马来西亚已确认支持）→ Paddle（<$10 商品可谈 custom pricing）→ Stripe 直连（非 MoR，税务自担）。
3. 每一家都用本文同构的邮件问一次，**只认书面答复**，不接受销售口头承诺，也不凭印象判断。
4. 全部拒绝时的退路只有两条：Stripe 自扛税务，或彻底去掉连接类功能。两条都是产品级决策。

### D. 要求合并到现有账户

1. 先问清是他们**要求**还是**建议**；能独立开户就独立开。
2. 若只能合并：确认合并后复审范围（会覆盖 TweetPilot），并把「Veyl 类目问题会连带另一条收入」写进决策记录，由用户拍板。
3. 合并方案的站点与产品仍需按 §2 第 10–17 项补齐。

---

## 4. 待确认（需要用户回答）

1. 马来西亚实体是否已注册？法定全称、注册号、成立日期。
2. 董事与 ≥10% 实益拥有人名单，以及每人的证件签发国。
3. 马来西亚公司银行账户是否已开，户名是否与法定名称逐字一致。
4. 共用账户里的 Veyl 产品是否**完全没有交易**（决定是「删除」还是「保留并如实说明」）。
5. 站点改成软件订阅口径的时间点——它决定正式申请最早什么时候能交。

---

## 5. 下一步

1. 用户补齐 §1.1 的 1–4 项，然后发送邮件。
2. 并行准备 §2 的 ❓ 项；❌ 项等答复再动手，避免白做。
3. 站点改写（§2 第 10–17 项）与 `software-subscription.md` 的实现可以并行，但**正式提交 KYB 之前必须完成**。
4. 收到答复后按 §3 对应分支执行。

---

## 6. 附录：Dodo AI 答复（2026-11-22）与解读

用户通过 Dodo 站内 AI 提问，答复要点：

| # | 答复 | 解读 |
|---|---|---|
| 1 | 找不到「section 23」的原文或编号 | **编号很可能是抓取工具加的**；Dodo 文档本身未必有序号。正式沟通只引原句，不引编号 |
| 2 | 无法确认落入禁止的基础设施类目；产品更像固定软件，属于「常需审核」那一档 | 不是许可，是「没有定论」 |
| 3 | 文档没有把该场景标为「VPN and Proxies」 | 同上；不等于豁免 |
| 4 | 文档未明确覆盖第二账户；但 FAQ 说**不应通过开多个账户规避风险决定** | **唯一的新增实质信息**，直接影响开户策略 |
| 5 | 建议直接联系 compliance@dodopayments.com 拿定论 | 与本文 §1 一致 |

### 6.1 对方案的影响

1. **不能据此提交。** AI 明确说了「按文档无法确认」，等于没有答复。
2. **改用「同账户新增 business」，绕开多账户问题。** FAQ Q7/Q177 明确支持一个账户下最多 10 个 business，它警告的是「开多个账户规避风控」。所以首选同账户加 business；邮件改为只问文档没写的两件事：不同法人能否持有、被拒是否波及同账户其他 business。
3. **「productised service」被点名为常需审核**——我们的产品是固定软件、同一交付方式，更接近软件，这条应该写进邮件（§1 已写）。
4. 编号引用已全部改成原文引用（`dodo-compliance-request.md` 与 `software-subscription.md` 均已改）。

### 6.2 仍未解决

- 类目本身没有定论，只能等 compliance 的书面答复
- 若 compliance 也回「需审核」，那就是走 §3 的 A 分支（提交后等增强尽调），而不是拿到明确许可
- 第二账户是否被允许，仍是未知，只能靠邮件里的主动披露换取一个明确答复
