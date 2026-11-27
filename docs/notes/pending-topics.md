# 待讨论事项

> 记录下来、但还没开始讨论的话题。讨论完把结论写进对应设计文档，并从本文件删掉。

## 1. 节点凭据的签发流程与原理

**要讨论的**：`CREDENTIAL_SIGNING_JWK` 这条链路完整走一遍——控制面什么时候签、payload 里有什么、客户端怎么验、验过之后写到哪、15 分钟有效期到了怎么办、为什么客户端要内置公钥而不是每次问服务端。

**为什么值得单独讲**：这是用户能连上自己服务器的唯一钥匙。现在它的设计散在 `docs/design/my-servers.md`、`docs/contracts/commands.md` 和源码里，没有一处从头讲到尾；出问题时不容易判断「是签发错了还是验签错了」。

**已定的事实（讨论时不用再定）**：
- 私钥只在 Cloudflare secret（`CREDENTIAL_SIGNING_JWK`），公钥内置在客户端 `src-tauri/src/control_plane/credentials.rs` 的 `CREDENTIAL_KEYS`
- dev = `cp-2026-11`，生产 = `cp-2026-12`，两把公钥都在客户端里，按响应中的 `key_id` 选择
- 凭据有效期 5 分钟，过期由客户端重新取
- 换私钥必须先发客户端、再切服务端，不能反过来

## 2. 界面与 AI 对话的中英文切换（待实施）

**要做**：系统设置里增加语言开关（中文 / English）。界面文案、AI 对话过程都要按这个设置展示；AI 的思考过程也用同一种语言。提示词已经按 `resources/prompts/zh/` 与 `resources/prompts/en/` 两套维护，切换时按设置选目录（参考 TweetPilot 的 `prompt_lang_dir()`：按语言前缀归一，`en-GB` / `en-AU` 都算 `en`，只支持 zh / en 两档）。

**状态**：2026-11-21 用户提出，尚未开发；**任务书见 `docs/design/i18n.md`**（含分批、验收与四个待拍问题）。两套提示词文件已建立占位（`product.md`、`faq.md`），`system.md` 待 `first-run.md` 退役时一并建。

**边界**：切换后已存在的会话是否跟着换语言、还是新会话才生效，实施前要先定（`i18n.md` §6 Q1）。

## 3. 计费与流量：在途工作

**已完成并验证**

- 幽灵机验证（2026-11-27 01:17 UTC）：DO 后台删机 → 落 `provider_gone_at`、停扣、额度冻结，真实 Cron 实测通过。
- `transfer_gib = 0` 的机器曾连累整个账号跳过超支结算 → 判据改成账号池（`c3fadad`）。
- 额度与扣费统一按 UTC 自然日 + 「付 N 天只给 N 天额度」封顶（`fe51a7a` / `197b9fc` / 迁移 0018）。
- 账户面板三段计量条、`+X/日（08:00）`、「还能用 N 天」、充值单层化。
- `provider_gone` 的三处错数（上限 1946→982、日增、每天约）与服务器展示态（`e5a8ffa` / `c7c6f21` / `8e44516`）。
- 误判评审（Felix 白盒 + Tess 外部事实 + Soren 裁决）后的两处收尾：审计只在真改到行时写、报告加 `providerGoneActive`（`0262634`）。
- AI 工具 content 与两份 product 提示词统一「已累计」（与界面同一个词）。
- `state='destroying' AND billing_state='pending'` 卡死行：改由计费 Cron 的 `recoverStuckDestroying` 在 30 分钟后补完销毁（非 pending 行仍恢复 `active`）；DO 删不掉时留在 `destroying` 保留下轮重试，落 `destroyed` 时同批关单、从不凭空退款。报告加 `pendingDestroyed` 计数。Felix 评审「过」（0 P0/P1/P2）；遗留 P3：`orders.failure_stage` 会写成 `destroying`（客户端不可见）、并发已销毁时计数多 1、失败告警不去重。

**未开始**

1. **余额三次提醒**（7/3/1 天）：要 `billing_warnings` 表 + App 弹框；「第三次后仍未充值 → 销毁」踩计费 Cron，最后做。
2. **DO 发票对账**：已写进 `admin-console.md` §8，归运维平台，与 agent 管控同期开发。

**纪律**：以上都只改 main、不建分支；控制面先 dev 后 prod；迁移先于引用它的代码。
