# 创建中禁止销毁（服务端为唯一判据）

> 日期：2026-11-27
> 状态：设计，待评审；未落代码
> 关联：`my-servers.md` §7.4 / §19.6.4、`commands.md` §1.6 / §7.15、`servers.ts` 的 `destroy` / `destroyInstance`、`billing.ts` 的 `runBilling`
> 上游决定（2026-11-27，用户）：创建服务器过程中不显示销毁、不让人工介入；人工介入时机器要么已创建成功、要么已失败。方案不得依赖界面按钮状态。

---

## 0. 一句话

`creating / booting / installing / verifying` 四种「创建中」状态下，用户侧的 `POST /v1/servers/{id}/destroy` 一律拒绝（`PRECONDITION_FAILED / server_provisioning`）；拒绝在控制面入口做，界面只是不渲染入口。创建过程本来就有自动收敛，最长 80 分钟内一定落到成功或失败（每轮最多收 20 条，同时卡住的更多时按轮次顺延）。

---

## 1. 规则与边界

- **人工介入 = 用户经 App（或直接调 Host 命令）销毁**。系统路径不属于「人工介入」，不受本规则影响，而且**必须继续能销毁创建中的机器**：
  - `sweepExpiredEnrollments`（enroll 超时收尾）
  - `sweepUnsettledSettlements`（at_ready 结算兜底）
  - `failSettlement` / `activation_lost`（激活失败收尾）
  - 计费欠费销毁、流量超支销毁
- **判据只在服务端**。UI 隐藏按钮、轮询、空态、按钮 disabled 都不构成正确性前提；绕过 UI 直接调 `destroy` 必须得到同样的结果。
- 不新增错误码：沿用 `runtime.md` §6.1 通用码 + `details.reason`（`commands.md` §1.6）。

---

## 2. 现状（代码事实，2026-11-27）

| 事实 | 位置 |
|---|---|
| 用户销毁对状态**没有任何限制**：读到行就直接写 `destroying` 并调 `destroyInstance` | `servers.ts:2194` `destroy()` |
| `destroyInstance` 在 `provider_id` 为空时也能走完：删防火墙 → 标记 `destroyed`，不碰订单 | `servers.ts:341` 起 |
| 用户销毁（`reason = 'user'`）**不关订单**（只有非用户原因才把订单置 `failed`） | `servers.ts:425` |
| 补建扫描：`orders.state IN ('paid','provisioning') AND charge_mode='upfront' AND (s.id IS NULL OR s.provider_id IS NULL OR s.state='error')` | `billing.ts:192` |
| 补建复用同 `order_id` 的服务器行时**没有状态守卫**，会把行改回 `booting` 继续建 | `orders.ts:512-577`、`provision.ts:307` |
| 详情页对创建中的机器**照常渲染销毁**，二次确认用 `destroyConfirmProvisioning` | `MyServerDetail.tsx:850-910` |
| `my-servers.md` §7.4 现写「创建中也能销毁，这是用户取消卡住创建的唯一出口」 | 需**反转** |
| AI 工具层没有销毁工具（建机 / 销毁 / 凭据只能由用户点界面） | `commands.md` §10.5 |

**今天的真实风险（两条，同一个根因）**：
1. 用户在一台 `creating` 的行上销毁 → 行变 `destroyed` 且 `provider_id` 仍为空、订单仍是 `provisioning` → 5 分钟后补建扫描命中（`provider_id IS NULL`）→ 复用同一行重新建机并继续扣费。
2. 同一条补建条件也覆盖 `state='error'`：用户在失败态销毁 → 行 `destroyed`、订单仍 `paid` → 补建把它重新建出来。

也就是说服务端不拦、UI 收起来也没用；这正是本设计必须在服务端做、并顺手修掉补建守卫的理由（§4.4）。

---

## 3. 状态分类

| `servers.state` | 含义 | 用户可销毁 |
|---|---|---|
| `creating` | 订单已认领，DO 建机请求进行中（尚无 `provider_id`） | **否** |
| `booting` | DO 实例已建，等开机 / agent enroll | **否** |
| `installing` | agent 正在装 sing-box | **否** |
| `verifying` | 装完在验活 | **否** |
| `active` / `healthy` | 可用 | 是 |
| `error` | 创建失败或激活失败（实例可能已回收，也可能还在） | 是 |
| `destroying` | 销毁中（用户或系统发起） | 允许重试（不是「创建中」） |
| `destroyed` | 已销毁（含停机墓碑） | 幂等返回成功 |
| `gone` | 旧云厂商时期的界面态；当前控制面不写 | 若出现按可销毁处理 |
| `provider_gone_at != null` | DO 后台已删、`state` 仍 `active` | 是（走正常销毁收尾） |

判定用 **`state`**，不用 `billing_state`：`error` 行也可能是 `billing_state = 'pending'`（建机阶段失败），但它必须可销毁。`billing_state = 'pending'` 只用于「销毁卡住时是否恢复」的既有判断（§7）。

---

## 4. 服务端设计

### 4.1 拒绝条件与竞态安全

在 `destroy()` 里用**条件 UPDATE**代替「先读后写」，同时解决并发：

```sql
UPDATE servers SET state = 'destroying', updated_at = ?
WHERE id = ? AND account_id = ? AND destroyed_at IS NULL
  AND state NOT IN ('creating', 'booting', 'installing', 'verifying')
```

- `changes = 1` → 继续原有销毁流程（`destroyInstance` 会再写一次 `destroying`，幂等）。
- `changes = 0` → 重读该行，按最新状态返回：
  - 行不存在 / 不属于本账号 → `404`（保持现有不泄露口径）；
  - `destroyed` → `204`，并保留现有的「补删防火墙」重试分支；
  - 仍是四种创建中状态 → `409`，见 4.2；
  - `destroying` → 允许（用户重试销毁的既有语义），按原流程继续。

这样即使判断瞬间行被 sweep 改成 `destroyed`，用户得到的也是成功（`204`）而不是错误；反过来，行在判断瞬间从 `booting` 变成 `error` 的并发下也不会误拒。

### 4.2 错误形状与旧客户端兼容

```json
HTTP 409
{
  "code": "PRECONDITION_FAILED",
  "message": "",
  "retryable": false,
  "details": { "reason": "server_provisioning", "state": "installing" },
  "request_id": ""
}
```

- 形状与 `lib/http.ts` 的 `apiError` 一致；Host 只保留 `code` / `details`，`message` 不下发（`commands.md` §1.6）。
- `details.state` 可选，仅供诊断与文案；界面判定只认 `reason`。
- **旧版 App** 仍会显示按钮：点下去收到 409，`errorText` 落到调用点兜底句（「没有改动」+ 重试提示），状态不变。这是可接受的降级——服务端明确拒绝，不静默、不改状态。**不提供「旧版本放行」开关**，否则重新打开 §2 的复活风险。
- 新 App 增加 `server_provisioning` 词条（§8）。

### 4.3 为什么放在入口，不放在 `destroyInstance`

`destroyInstance` 是系统收尾的共用函数，欠费、enroll 超时、结算失败都必须能销毁创建中的机器。守卫放在用户入口 `destroy()`，语义明确，也不会误伤系统路径。代码约定同步写明：**用户路径不得直接调 `destroyInstance`**。

### 4.4 已失败（`error`）行销毁后不能被补建复活

现状：创建失败的可重试路径把行置 `error`、订单留在 `paid`；补建扫描条件含 `s.provider_id IS NULL OR s.state = 'error'`。用户在失败态点销毁后，行变 `destroyed` 但 `provider_id` 仍为空、订单仍是 `paid` → 下一轮补建**复用同一行重新建机**。这是今天就能复现的「删了又回来」，会直接破坏本设计承诺的「失败后可以销毁」。

本批一并修：

1. 补建扫描加守卫 `AND s.destroyed_at IS NULL`（`billing.ts:192` 的查询）；
   再补一条 `AND s.state <> 'destroying'`：正在销毁、`provider_id` 还没落库的行会被
   「`provider_id IS NULL`」误判成「已付款没机器」，补建等于把一台正在销毁的机器重新建出来
   （2026-11-27 本地 105 行压测复现：超过批量上限的 5 条被补建、落 `error`）；
2. 用户销毁 `error` 行时，若订单仍处于 `paid` / `provisioning`，同批把它置 `failed`（`failure_code = 'user_destroyed'`，`failure_stage` 保留原阶段），订单终态与机器终态一致，补建条件自然不命中；
3. 退款口径不变：仍按 `refundPlan` 的 `reason = 'user'` 计算未开始的整天；没有 charge 流水时照旧跳过退款并写审计。

---

## 5. 界面

| 入口 | 创建中（4 种状态）的行为 |
|---|---|
| 详情页底部操作行 | **不渲染销毁**（不是 disabled、不是隐藏文案占位）；保留现有四段进度块 |
| 详情页二次确认 | 不再出现；删除 `destroyConfirmProvisioning` 分支与词条 |
| 左栏列表行 | 本来没有销毁入口，维持不变 |
| 详情页 `destroying` | 保留「60 秒后重试销毁」（`DESTROY_RETRY_MS`）——它是销毁中，不是创建中 |
| 详情页 `error` | 保留销毁（实例可能还在，需要用户收尾） |
| 已销毁墓碑 / `gone` | 维持现状（删除 / 重新购买） |
| AI 工具 | 无销毁工具，不新增 |

文案口径：不再承诺「可以取消创建」。创建失败由错误块说明「已自动处理 / 已退款，重新建一台」；创建中只显示进度。

**连带文案**：`my_server_cancel_order` 对已支付订单现在返回 `cancel_after_paid`，契约里的界面动作写着「已开始创建，请到服务器详情销毁」（`commands.md` §7.15 错误表）。本规则落地后这条指引不再成立，要改成「已开始创建，不能取消；创建会自动完成或失败」，不给任何销毁入口。

---

## 6. 收敛保证（不依赖任何人工介入）

| 阶段 | 谁推进 / 兜底 | 上限 | 一定落到 |
|---|---|---|---|
| `creating`（正常） | `checkout` 请求内同步建 DO，成功即写 `provider_id` + `booting` | checkout 同步请求（秒级） | `booting` 或 `error` |
| `creating`（Worker 中途死亡） | **新增** `sweepStaleCreating`（每小时 Cron，`state='creating' AND updated_at < now − 10 分钟`） | 10 分钟 + 最多 60 分钟 Cron 间隔 | `error`；订单置 `failed`（关单后不再被补建），有已扣的 upfront 款则按 `failPermanently` 口径退回；在跑这一轮之前，5–10 分钟内的行仍由既有补建扫描重试一次 |
| `booting` / `installing` / `verifying` | `enrollment_expires_at`（建机成功时写入，+20 分钟）；`sweepExpiredEnrollments` 每小时；`refreshBooting` 在任意列表/详情时顺手收敛 | 20 分钟 + 最多 60 分钟 | `destroyed`（订单 `failed`、退未使用天数、按失败原因写墓碑/隐藏） |
| DO 建机慢 / 失败 | `createDroplet` 超时或报错 → `fail()` | 请求内 | `error`（可销毁） |
| Worker 在 DO 创建成功后、DB 写 `provider_id` 前死亡 | `sweepStaleCreating` 顺带按 tag `veyl:srv:<server id>` 反查一次并删（复用 `listDropletsByTag`） | 同上 | `error`，不留下付费孤儿 |

**最坏等待：约 80 分钟**（20 分钟 enroll TTL + 最多 60 分钟 Cron 间隔；`CREATING_REAP_BATCH = 20`，同一轮卡住超过 20 条时每多 20 条顺延一轮）；用户下次打开列表/详情时 `refreshBooting` 或 `sweep` 会让它立即收敛。

**`runBilling` 内的次序**：`sweepStaleCreating` 必须排在「已收款但没有机器」的补建扫描**之前**——否则一条超龄 `creating` 行会先被补建扫描重新建一次；关单之后补建条件（`orders.state IN ('paid','provisioning')`）自然不命中，不会复活。5–10 分钟之间的行由补建扫描照常重试一次，不冲突。

不存在「永远停在 installing」：四种创建中状态都有上限与终态。`destroying` 不在本规则的拒绝集合里，用户入口仍然可用；其中建机阶段卡住的行与其它 `destroying` 一样由计费 Cron 在 30 分钟后收尾（见 §7）。

---

## 7. 与在途待办（`destroying AND billing_state='pending'`）的关系（已实现）

- **用户路径不再产生**：创建中被拒，用户无法在 `pending` 阶段发起销毁。
- **系统路径仍可能产生**：`sweepExpiredEnrollments` / `failSettlement` / `activation_lost` 在 `destroyInstance` 中途 Worker 死亡，会留下 `destroying`。
- **已由计费 Cron 自动收尾**（`billing.ts` 的 `recoverStuckDestroying`，卡住 30 分钟后）：`billing_state <> 'pending'` 的恢复成 `active`（口径不变）；`billing_state='pending'` 的**补完销毁**（`destroyInstance(..., "destroy_stuck", { restoreOnFailure: "destroying" })`）——落 `destroyed` 并关单，DO 删不掉时留在 `destroying` 等下一轮。这类行从未扣过费，`refundPlan` 撞不到 charge 流水，只写 `refund_skipped_no_charge` 审计，不会凭空退款。报告里的 `pendingDestroyed` 计数每小时可见。
- 用户不再需要手动「重试销毁」才能收尾；入口保留只是兜底（`destroying` 不在拒绝集合内）。

---

## 8. 落地清单

| 项 | 改动 |
|---|---|
| `commands.md` | 升 **2.87.0**：§2 第 80 行（`my_server_destroy`）补拒绝语义；§7.15 补一段「创建中拒绝」，并把 `cancel_after_paid` 的界面动作从「请到服务器详情销毁」改为「不能取消，等待自动完成或失败」；§1.6 reason 表加 `server_provisioning`；§16 变更记录 |
| `tools.md` | 不变（无 AI 工具，工具面 38 不变） |
| `my-servers.md` | §7.4 状态表 `creating` 行改「不显示」；删除「创建中也能销毁」整段，改为「创建中不提供销毁，服务端拒绝并返回 `server_provisioning`；收敛见 `provisioning-lockout.md`」 |
| 控制面 | `servers.ts`：`destroy()` 条件 UPDATE + 重读分支；`error` 行用户销毁时同批关单（§4.4）；`billing.ts`：`runBilling` 接入 `sweepStaleCreating`（排在补建之前）、补建查询加 `destroyed_at IS NULL`；`providers/digitalocean.ts`：复用 `listDropletsByTag`（接线即可）；测试覆盖 §9 |
| Host（Rust） | **不改**：错误已按 `code` + `details.reason` 透传（`control_plane/error.rs`） |
| 界面 | `MyServerDetail.tsx`：创建中不渲染销毁；删除 `destroyConfirmProvisioning` 分支；`i18n/zh.ts` / `i18n/en.ts` 删除该词条、增加 `error.reason.serverProvisioning`；`i18n/errorText.ts` 登记 reason；补测试 |
| 迁移 | **无**（不新增列） |
| 部署顺序 | 控制面先 dev 后 prod，**先于** App 发版：服务端先拦，旧 App 点按钮只会收到 409；反过来（UI 先行而无服务端守卫）绕过 UI 仍能破坏。只改 `main`，不建分支。 |

---

## 9. 验收

1. **绕过 UI**：对 `creating` / `booting` / `installing` / `verifying` 四种行直接 `POST /v1/servers/{id}/destroy` → `409 PRECONDITION_FAILED / server_provisioning`；`state`、`destroyed_at`、订单、账本、审计均不变（无 `server.destroy` 审计、无退款）。
2. **失败态可销毁且不复活**：`error` 行 → `204`，按现有退款口径结算；订单若仍在 `paid` / `provisioning` 则同批置 `failed`；对这条行再跑一轮补建扫描不得重新建机。
3. **成功态可销毁**：`active` / `healthy` → `204`。
4. **界面无入口**：四种创建中状态详情页没有销毁（不是 disabled），进度块正常；`destroying` 60 秒后出现重试；`error` 有销毁。
5. **旧客户端**：模拟旧版直接调命令 → 收到错误并显示通用「没有改动」句，状态不变。
6. **收敛**：制造一条 `creating` 且 `updated_at` 15 分钟前的行 → 下一轮 Cron 落终态；若同时按 tag 造一个孤儿 droplet，应被删除。
7. **并发**：判断瞬间行被 sweep 改成 `destroyed` → 用户收到 `204` 而不是 409；行变成 `error` → 允许销毁。

---

## 10. 风险与取舍

- **用户不能在创建中取消**：这是用户明确要求的代价。误选地区/套餐只能等失败或成功后重建，最长约 80 分钟（同一轮卡住超过 20 条时按轮次顺延）。
- **旧 App 文案只有通用句**：`message` 不下发是既有契约；新 App 才有准确文案。服务端不静默失败，但要接受旧版本看起来「点了没反应/没有改动」。
- **`sweepStaleCreating` 的 10 分钟阈值**是按当前同步建机模型取的保守值（Host 超时 30 秒、Worker 请求上限远小于 10 分钟）。若以后改成异步建机 / Workflow，需要重估。
- **孤儿 droplet**：Worker 在 DO 创建成功后、DB 写入前死亡时，行仍是 `creating` 且 `provider_id` 为空；靠 tag 反查删除，依赖 `veyl:srv:<id>` tag 已写入（现已写入）与 `listDropletsByTag` 接线（当前仅定义未使用）。若 DO 删除失败，仍会留一台付费实例——按既有 DO 失败重试口径处理，不在这里猜。
- **不依赖 UI**：服务端条件 UPDATE 是唯一判据；界面只是减少误触。任何「按钮禁用 / 轮询 / 空态」都不承担正确性。
- **不做的事**：不改 `destroyInstance`、不动系统销毁路径、不加迁移、不新增错误码、不给 AI 增加销毁工具。
