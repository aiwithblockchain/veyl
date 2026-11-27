# 机器在 DO 后台被删掉之后：停计费与停额度

> 日期：2026-11-26
> 状态：控制面已实现（迁移 0017，已部署）。**未做**：自动销毁、通知。**界面文案（2026-11-27 落地）**：`state` 不动，展示态来自 `provider_gone`——列表与详情状态词「云服务商已删除」、状态点琥珀，费用行与左栏副行不报日价，详情提示「销毁后即可从列表移除」；账号面板的上限 / 每日增量 /「每天约」把这类机器排除。
> 相关：`traffic-billing.md`（§4.0 / §4.1 周期与额度）、`my-servers.md`（销毁流程）
> 事实来源：DigitalOcean API `GET /v2/droplets/{id}`（404 = 不存在）；agent 上报周期 `agent/src/traffic.rs:33` `REPORT_IDLE_SECS = 30 * 60`

---

## 0. 问题

用户在 DigitalOcean 后台直接删掉 droplet，不走我们的销毁。控制面没有任何痕迹：`state` 仍是 `active`，`destroyed_at` 为空，于是

- 按天续费继续扣（`settleServer` 的存活复查 `liveServerState` 只查我们自己的表）；
- `releasedBytes` 用 `destroyed_at ?? now`，额度每天继续涨，一直算在账号池里；
- 下个计费周期重置后再白送一份月额度；
- `pruneDestroyedServers` 只清 `destroyed` 行，这一行永远不会被清理。

## 1. 判定条件

只在「到期结算」这一步做，且必须**心跳静默 + DO 返回 404** 同时成立。

| 条件 | 动作 |
|---|---|
| `last_seen_at` 有值且 ≤ 2 小时 | 不查 DO，照常扣 |
| `last_seen_at` 为空（0010 之前的老机器） | 退到 `ready_at`，再退到 `billing_anchor_at` 当「最后一次已知存活」 |
| 静默超时 → `GET /v2/droplets/{provider_id}` 返回 **404** | 落 `provider_gone_at`，本轮不扣、不销毁，写审计 `server.provider_gone` |
| 同上返回 **200** | 照常扣（agent 挂了不是停计费的理由，见 §3） |
| 超时 / 5xx / 429 / 401 / 没配令牌 | 不下结论，照常扣，下一轮再查 |

为什么是 2 小时：agent 30 分钟必报一次（空闲也报 0 字节），2 小时 = 漏 4 次。查询只发生在「到期待扣 + 静默」的交集上，一次成功结算把 `paid_until` 推后一天，所以**同一台机器最多一天查一次**，落过标记的永不进入该路径。

为什么必须问 DO：心跳来自 droplet 上的 node agent。机器活着、agent 进程挂了或被挡住出站，心跳一样会停，而用户仍能连。纯心跳判「没了」会白送天费，正面违反已拍板的「计费不看在线」。

## 2. 状态怎么存

```sql
ALTER TABLE servers ADD COLUMN provider_gone_at INTEGER DEFAULT NULL;  -- 迁移 0017
```

存时间戳而不是布尔：额度封顶要用它，界面也能说「什么时候失联的」。

不复用已有的三个字段，各有硬理由：

- **`destroyed_at`**：那是「已销毁」的语义，会连带触发退款口径（`refundPlan`）、45 天清理（`pruneDestroyedServers`）、`/v1/agent/traffic` 的 409。而我们没有销毁任何东西。
- **`failure_code`**：`MyServer.failure` 把未知 code 一律显示成「这台服务器没有创建成功」，`billing_unpaid` / `traffic_overage` 又被 dismiss 与墓碑展示逻辑判读；加第三个码会污染这两处。
- **`billing_state`**：契约里它是 `active | past_due | expired`，界面按它算 `grace_ends_at`，加值要连带 App 端改。

`state` 保持原样（驱动建机、凭据签发、销毁流程）。界面不靠 `state` 表达这件事：状态词与状态点另外读 `provider_gone`（见 `my-servers.md` §7.4），`state` 只继续管那三条流程。

## 3. 三分语义

`markProviderGone` 严格返回 `gone | alive | unknown`：

- **`gone`（404）**：唯一正向的「不存在」信号。
- **`alive`（200 或心跳新鲜）**：照常扣。
- **`unknown`（超时 / 5xx / 429 / 401 / 没令牌）**：照常扣，下一轮再查。**绝不能「查不出来就免费」**——那会把一次 DO 抖动变成全站免单。

报告里并列记四个数：`providerProbed`（本轮真的打了 DO 的台数，含判「还在」与判「消失」）、`providerGone`（本轮判消失）、`providerUnknown`（没下结论）、`providerGoneActive`（**当前被冻结且未销毁的存量台数**）。前三个是当轮动作，事故过去后就看不出来；`providerGoneActive` 是存量，每小时那行 `[billing] done {...}` 能直接读出「现在冻了多少台」。

## 4. 额度封顶

`releasedBytes` 的截止点从 `destroyed_at ?? now` 改成：

```
end = min(destroyed_at ?? now, provider_gone_at ?? now)
end <= cycleStart → 0
```

周期内停掉的机器把已累计额度留在账号池里（与 DO 团队级按存在秒累计一致），之后不再增长；下个周期因为 `end <= cycleStart` 直接为 0，「重置后再白送一份」消失。用户之后点销毁时 `destroyed_at > provider_gone_at`，`min` 仍取更早的那个，池子不会因为销毁反而上涨。

`ReleasedRow.provider_gone_at` 是**必填**字段：两处投影（`accountTotals` 的 SELECT、`trafficFields` 的对象字面量）漏一处就编译不过，不靠注释约束。

## 5. 恢复路径

1. **agent 再上报即恢复**（主路径）：`POST /v1/agent/traffic` 对 `destroyed_at IS NULL` 的行照常接收，同一条 `UPDATE` 里写 `last_seen_at` 并清 `provider_gone_at`，另写审计 `billing.gone_recovered`。下一次结算照常扣费。标记从来不是终态。
2. **用户主动销毁**（止损路径）：`deleteDroplet` 对 404 已按成功处理，所以对一台「DO 里已经没了」的机器点销毁会直接走通：关单 + 退未开始的整天 + `destroyed_at` 落库 → 45 天后被 `pruneDestroyedServers` 清掉。「这一行永远不会被清理」由此有了合法出口，且不需要我们自动销毁。
3. **不自动清除**：没有「失联满 N 天自动销毁」。

## 6. 与「扣不动即销毁」的关系

判据独立，只约定顺序：**先判「不存在」，再去看钱**。

| 场景 | 结果 |
|---|---|
| 机器还在、余额不足 | 停机销毁（`billing_unpaid`），与现在一致 |
| 机器已不存在、余额充足 | 只停计费，不扣、不销毁 |
| 机器已不存在、余额为 0 | 先命中失联：不扣也不销毁（不存在的机器不该被打上「余额不足已停机」） |
| 失联后又收到 agent 上报 | 清标记，下一轮按正常机器结算 |

实现上：`collectDue` 的 WHERE 加 `provider_gone_at IS NULL`，`recoverExpiredServers` 同样加，循环里先 `markProviderGone` 再 `settleServer`。**`settleServer` 自己也短路**：`liveServerState` 带回 `provider_gone_at`，非空就返回 `reason: "gone"`，`runBilling` 按 `destroyed` 同样跳过（不销毁、不写 `billing_state`）。只靠账本守卫不够——守卫不成立会让 `recordLedgerEntry` 落到 `insufficient`，而 `runBilling` 对 `insufficient` 是停机销毁，那就会给一台已经不存在的机器走退款。

## 7. 顺带修掉的同类漏洞：从未结算就被销毁的机器

建机阶段就能销（`destroy` 只拦 `destroyed`），而额度公式里的 `+1` 是建机预付的那一天，所以 `days = 0` 的幽灵机也能拿到 `monthly/28`：造 28 台再立刻销毁 = 一个月的额度。按 100 GiB 机型、DO 每台不到一小时 ≈ $0.2 换 $2.00 的超支，是正收益的套利。

规则：`已销毁 && 没有 ready_at/billing_anchor_at（从未结算）→ 额度 0`。保留「待建机先给一天」的展示口径，已结算后正常销毁的行为逐字节不变。`created_at` 也跳过 0（真落成 0 时锚点退到 `end`，只剩一天份额）。

## 8. 两条「有意为之」

- **封顶用发现时刻（`provider_gone_at`）而不是最后一次心跳**：用户可能已经为那些天付过钱，按发现时刻截止对存量已付费的天更公平；多出来的一两天对用户有利，不会反向多收。
- **老行 `last_seen_at` 为空时用 `ready_at`（再退 `billing_anchor_at`）兜底**：`last_seen_at` 只有两个写入点（agent 登记、流量上报），为空基本等于「0010 之前建的、根本没有 agent」——恰恰是最可能早被删掉、又最会被永远扣费的那一类，不能让它们绕过检测。

## 9. 已知缺口

- **DO 查不到也不能免费**：令牌过期 / DO 抖动期间仍照扣。这是取舍：宁可多扣一台仍在的机器，也不把抖动变成免单。
- **假 404 的代价不对称**：额度封顶会让 `used − released` 提前进入超支区间，可能多收一笔超支费（超支没有自动退款路径）。两个信号同时成立才命中，概率低；恢复时写 `billing.gone_recovered` 留人工兜底。
- **检测延迟 ≤ 1 天**：判定挂在到期结算上，最晚一天后才发现；期间额度最多多涨一天（对用户有利），扣费最多多扣一天（2 小时阈值把窗口压到「删除发生在结算前 2 小时内」）。
- **界面仍显示「可用」**：~~要让用户看见，需要在 `MyServer` 上加字段~~ 已于 2026-11-27 落地（`c7c6f21`）：`MyServer` 增 `provider_gone`，列表与详情写「云服务商已删除」、状态点转琥珀，见 `my-servers.md` §7.4。

## 10. 部署

先 apply 迁移 0017、确认 `PRAGMA table_info(servers)` 里有 `provider_gone_at`，再 deploy 控制面：旧代码不读这列，但新代码在列缺失时会整轮结算失败。

## 11. 后续（本轮不做）

- 连续 K 次 `unknown` 的熔断：目前每轮都会重试，DO 长时间不可用时探测量会持续，靠 `providerProbed` 观测。
- `recoverExpiredServers` 的真实 SQL 用例：目前只有 FakeD1 覆盖，语义已对齐（`provider_gone_at IS NULL`）。
- `markProviderGone` 里 `provider_gone_at != null` 那条防御分支目前不可达（`collectDue` 已过滤），补一句注释说明即可。

## 12. 误判评审（2026-11-27）

两位工程师分别从白盒（穷举所有能写出 `provider_gone_at` 的路径）和外部事实（DO 文档语义 + dev/prod 实际数据）审了一轮，架构侧裁决。结论：**判定入口窄、无已知误判实例**（dev 仅 1 条真实记录、prod 0 条），但提出「单次 404 无交叉校验」与「事故不可见」两处。裁决如下：

| 提议 | 结论 | 理由 |
|---|---|---|
| 信 404 前先 `GET /v2/account` 比对账号 UUID（新增 secret） | **不做** | 风险前提是「合法但属于另一个团队」的 token = 部署事故，紧接着第一次建机/销毁就会响亮失败，不是静默风险；「文档没写 403 ⇒ 必回 404」是推演，不是事实 |
| 一轮探测 ≥3 台且全部 404 时熔断 | **不做** | 方向反了：用户一次在 DO 删多台会被永久压住（下一轮仍全 404），1–2 台时又完全无效 |
| 对冻结行每 7 天复查、DO 回 200 即恢复（需迁移） | **不做** | 自愈路径本就是 agent 上报：agent 活着会自己清，agent 死了复查也改变不了机器是否还在；无「存活 droplet 偶发 404」的已知实例，不值一次迁移 |
| 标记的 `UPDATE` 只在 `meta.changes === 1` 后写审计 | **做** | 并发双例会重复写审计、多计 `providerGone`；写失败时审计没有依据 |
| 报告加 `providerGoneActive` | **做** | 一行只读查询，成本近零；补上「事故过去后看不见」这个缺口 |

**残余风险（已知、可见、可人工处置）**：若真的出现批量误判，`[billing] done` 里的 `providerGoneActive` 会明显抬升；处置是直接清 `provider_gone_at`（agent 恢复上报也会清）。不做自动熔断是刻意的——它对「用户一次性删多台」的伤害大于对误配的保护。

**更划算的防护是部署纪律**：token 轮换后立刻跑一次建机，任何鉴权问题都会当场失败，而不是等一小时后由 Cron 静默发现。
