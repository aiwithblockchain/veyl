# 余额不足停机销毁 · 节点墓碑：验收

> 日期：2026-11-19
> 范围：提前续费（`e2fe0c2`）、停机销毁与墓碑（`cdd7f6a`）、停机删除界面（`a3b7fa3`）
> 状态：三笔改动已提交；dev 已应用迁移 0008、Worker 已部署（`schedule: 17 * * * *`）。
> **本文只记录尚未在真机上执行过的条目。** 已有自动化覆盖的见 §6，不要重复手测。

## 0. 前置

- 应用已重建：`bash scripts/dev/tun-dev.sh --kill-existing --no-open`
- 登录态有效，至少有一台自有节点
- **准备一台专用测试机**：下面的条目会真的销毁机器，不要拿在用的那台测
- dev 计费由每小时第 17 分的定时任务执行，不再提供手动触发接口；改完 `paid_until` 后等下一次定时任务，或用 `npx wrangler tail veyl-control-plane-dev` 观察日志

改库命令统一在 `cloudflare/control-plane` 目录下执行：

```bash
npx wrangler d1 execute veyl-control-plane-dev-4 --remote --env dev --command "<SQL>"
```

## 1. 提前续费（`e2fe0c2`）

| 编号 | 前置 | 操作 | 预期界面 | 核对的数据 |
|---|---|---|---|---|
| A1 | 测试机 `paid_until` 在 **59 分钟**后，余额足够 | 跑一轮计费 | 无变化，机器照常可用 | 新增一条 `server_day` 扣费，`ref = server_day:<id>:<原到期时刻>`；`paid_until` = **原值 + 24h**（不是 now + 24h） |
| A2 | 同上，但把 `paid_until` 改到 **61 分钟**后 | 再跑一轮 | 无变化 | **没有**新的 `wallet_ledger` 行；`paid_until` 不变 |
| A3 | 测试机在窗口内、余额不足 | 跑一轮计费 | 机器还没到期，**仍显示正常**，不出现「已欠费」 | `billing_state` 仍是 `active`；没有 `server_day` 行 |
| A4 | 一台 `paid_until` 落后 4 天的机器，余额足够 | 跑一轮计费 | 无变化 | 一次补 **4 天**（4 条独立 `bucket`），最终 `paid_until` 比 now 多约 1 天 |
| A5 | — | 真机等一次整点的 `:17` Cron | — | 日志里 `[billing] done` 每小时的 `:17` 出现一次；**这一条目前完全未验证** |

A1 / A2 的改库语句（`3540000` = 59 分钟，`3660000` = 61 分钟）：

```bash
npx wrangler d1 execute veyl-control-plane-dev-4 --remote --env dev --command "UPDATE servers SET paid_until = (strftime('%s','now')*1000 + 3540000) WHERE id = '<测试机 id>'"
```

## 2. 停机销毁（`cdd7f6a`）

| 编号 | 前置 | 操作 | 预期界面 | 核对的数据 |
|---|---|---|---|---|
| B1 | 测试机在窗口内，日价调到余额付不起 | 跑一轮计费（或等 `:17`） | 左栏出现「已停机删除」；连接页对应节点变「停机删除」 | 返回 `unpaidDestroyed: 1`；`servers.state='destroyed'`、`failure_code='billing_unpaid'`、`destroyed_at` 有值；`wallet_ledger` **没有**退款行 |
| B2 | 同 B1，但 `paid_until` 已经过去 | 同上 | 同上 | 退款仍为 **0**（过期后 nPaid ≤ nNow） |
| B3 | 构造一行 `daily_price_cents = 0` 且已进窗口的机器 | 跑一轮计费 | 机器**不受影响** | `unpaidDestroyed: 0`；`servers.state` 不变；日志有 `skip server=… reason=unbillable` |
| B4 | 已有一行 `billing_unpaid` 墓碑 | 连续调两次 `POST /v1/servers/<id>/dismiss` | 墓碑消失 | 两次都 204；列表不再返回该行 |
| B5 | 一台**手动销毁**的机器 | 查列表 | 不在列表里 | `failure_code` 为 `null`，不会被当成墓碑 |

B1 / B2 的改库语句（把日价调到余额付不起，不动钱包余额）：

```bash
npx wrangler d1 execute veyl-control-plane-dev-4 --remote --env dev --command "UPDATE servers SET paid_until = (strftime('%s','now')*1000 + 1800000), daily_price_cents = 100000 WHERE id = '<测试机 id>'"
```

> 测完这台机器就没了；`daily_price_cents` 不需要还原。
> **不要**用改 `accounts.balance_cents` 的方式制造余额不足——那会让账本的 `balance_after` 对不上，触发对账漂移告警。

## 3. 客户端感知（按需检查，2.45.2 起不再后台轮询）

| 编号 | 前置 | 操作 | 预期界面 | 核对的数据 |
|---|---|---|---|---|
| C1 | 机器在窗口内、余额不足；应用停在连接页 | 跑一轮计费后切到「我的服务器」 | 进入页面即刷新一次，左栏出现「已停机删除」 | 只有一次 `GET /v1/servers`，没有后台定时请求 |
| C2 | 正连着测试机的节点 | 跑一轮计费后**打开这台机器的详情** | 隧道断开，界面回到未连接，详情显示墓碑 | 日志顺序：详情落库并发 `my-server-changed` → 停运行时（相差几毫秒，属预期） |
| C3 | 正连着测试机的节点 | 跑一轮计费后做一次「测试连通」并失败 | 隧道断开 | 探测失败后有一次 `GET /v1/servers/<id>` |
| C4 | 应用空闲（未连接） | 什么都不做，放置 10 分钟 | **不会**自动刷新，也不会出现墓碑；期间没有控制面请求 | 日志里没有定时轮询 |

> C4 是 2.45.2 的**设计取舍**：常开应用不再每 60 秒打控制面；需要最新状态时由「进入服务器页 / 打开详情 / 连通检查」触发。

## 4. 界面（`a3b7fa3`）

| 编号 | 前置 | 操作 | 预期界面 |
|---|---|---|---|
| D1 | 有一台墓碑 | 看左栏 | 状态点 warn、状态词「已停机删除」、**不显示日价** |
| D2 | 同上 | 点进详情 | 只有一句说明 + 「删除」危险按钮；没有续费、重建、重命名、销毁 |
| D3 | 配置里引用了墓碑的节点 | 打开连接页 | 该行灰显、写「停机删除」、不可选中、右侧不显示时延 |
| D4 | 当前节点正是悬挂节点 | 看主按钮 | 禁用；还有别的可用节点时提示「当前节点已停机删除，换一个节点再连接。」；没有则提示「节点已停机删除，去我的服务器删除它，或新建一个节点。」 |
| D5 | 连接失败态 + 当前节点是悬挂节点 | 看下方次级按钮 | 「重新连接」也禁用 |
| D6 | 墓碑详情 | 点删除 → 取消 | 什么都不发生 |
| D7 | 墓碑详情 | 点删除 → 确认 | 墓碑行与连接页节点**同时**消失；余额不变 |
| D8 | 断网时删除 | 点删除 → 确认 | 行保留，就地报错，说明句与确认入口仍在 |
| D9 | 删光某一配置的最后一个节点 | 回连接页 | 出现「这条配置没有节点了」；没有配置时**不出现**这句 |
| D10 | 已经删除过墓碑 | 完全退出并重启应用 | 墓碑**不再回来**（依赖 `node_forget` 内部调 dismiss） |

## 5. 仍无法自动化的

| 编号 | 内容 | 为什么 |
|---|---|---|
| E1 | 真机 Cron 在每小时 `:17` 的真实触发 | Cloudflare 调度只能线上观察 |
| E2 | 系统休眠/唤醒后首次打开详情时的检查时机 | 依赖系统休眠/唤醒 |
| E3 | DO 删不掉时整轮的重试 | 需要构造上游 500；已有单测覆盖单台行为 |
| E4 | 迁移 0008 在既有数据上的兼容 | dev 已应用成功；prod 尚未部署 |
| E5 | 本地删节点失败（SQLite 写失败）后，如果当场没有重试 | 真机无法稳定构造本地写失败。**已知限制**：此时控制面墓碑已 dismiss，下次列表刷新后墓碑行会消失而节点行仍在，界面上不再有删除入口；出现报错时请**立刻再点一次删除**（dismiss 幂等，重试会继续删本地节点） |

## 6. 已有自动化证据

以下条目已有测试覆盖，手测时只做抽查：

- 窗口边界（59 分钟扣 / 61 分钟不扣）、同桶幂等、销毁中不扣：`cloudflare/control-plane/test/billing.test.ts`
- 只有 `insufficient` 才销毁、日价为 0 / 账户缺失不销毁：`billing.test.ts`
- 退款口径（窗口内 0、过期后 0、建机失败全额退）：`billing.test.ts`、`servers.test.ts`
- 墓碑列表、dismiss 鉴权与幂等：`servers.test.ts`
- 迁移列与 schema 守卫：`test/schema_guard.test.ts`
- 按需检查（当前节点判定、往返后重读、404 视为已销毁、网络失败不停、停运行时不受取消影响）：`src-tauri/src/agent/server_watch.rs`
- 墓碑判定、悬挂节点推导、删除后空态、删除失败保行：`src/myservers/tombstones.test.ts`、`src/myservers/useMyServers.test.tsx`、`src/components/MyServerDetail.test.tsx`、`src/App.servers.test.tsx`
- `node_forget` 删除顺序（dismiss 前置、失败时本地不动、`NOT_FOUND` 视为完成、`source_key` 兜底、删节点失败可重试、当前节点先停隧道）：`src-tauri/src/agent/commands.rs` 的 `node_forget_tests`
- 不可连接三处入口（主按钮、节点行、次级重连）：`src/components/ConnectionStage.test.tsx`

## 7. 失败时要给我三样

1. 用例编号；
2. 界面上的原话或截图；
3. `~/.veyl/logs/app-*.log` 同一时间段的几行。

数据侧我自己查 `servers` / `wallet_ledger` / `audit_log`，不再让你贴。

---

> 与既有文件的关系：`login-payment-acceptance.md` 覆盖登录、充值、建机、退款主流程；本文只覆盖本轮新增的续费时机、停机销毁与墓碑。那份文件的 M1 已按每小时 `:17` 与「落后 1 天补 2 天」的口径同步过，两处不冲突。
