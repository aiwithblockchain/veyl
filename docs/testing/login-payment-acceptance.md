# 登录 · 充值 · 购买：主流程验收

> 日期：2026-11-16（2026-11-18 按账号菜单与「就绪后扣款」修订）
> 范围：只验主流程（登录态是否成立、余额决定能否买机、按天扣费是否发生）。
> 说明：全面 UI 重构在即，本轮不覆盖异常、边界与门禁细节；那些等重构后按设计文档补齐。
> 原则：**全部在应用内点击完成**，数据只用于核对结果（M1 例外，需要在 dev 库改一行）。
> **2.39.0「就绪后扣款」已上线**（dev 与 prod）：checkout 不扣费，扣费发生在服务器就绪后。本轮按此口径判。

## 条目可执行性（2026-11-18 复核）

| 条目 | 结论 | 改法 |
|---|---|---|
| L2 | 能力已实现，条目里的 UI 位置过时（左栏账号块已删） | 改成导航头像 + 账号菜单 |
| B1 | 条目与实现不符：余额预检发生在建单之前，不会留下 `pending_payment` 订单 | 改成「没有 `orders` 行」 |
| M1 | 依赖手工改库与 dev 调试端点，条目没写入口 | 写死命令与端点，标注仅 dev |
| B3 | 条目已过期：仍按旧的「下单即扣」写断言 | 改成「就绪后扣款」的断言 |

## 用例

| 编号 | 前置 | 操作 | 预期界面 | 我核对的数据 |
|---|---|---|---|---|
| L1 | 未登录 | 打开「我的服务器」→ 点登录 → 输入邮箱 → 收码 → 输入 6 位码 | 导航底部头像变为邮箱首字母；账号菜单显示邮箱与「已登录」；服务器列表出现 | 新建 `accounts(kind=email)`；`devices.account_id` 指向它 |
| L2 | L1 完成 | 完全退出应用，重新启动 | 导航头像仍是邮箱首字母，点开账号菜单是同一邮箱，**不弹登录** | 启动后若发生刷新：`refresh_tokens` 新增一条，旧行 `revoked_at` 非空（旧的已作废） |
| B1 | 已登录，余额 $0 | 选地区与套餐 → 点 `创建` | 提示「余额不足，还差 $2.10。」（按日价 × 7），**不开始创建** | **没有** `orders` 行、没有 `servers` 行、没有 `wallet_ledger` 行（预检在建单之前拦下） |
| B2 | B1 之后 | 导航头像 → 账号菜单 → 充值 → 选 $12 → 浏览器用 **Stripe Test 模式**支付 → 回到应用 | 账号菜单里余额显示 **$12.00**（webhook 到账通常数秒；未到账时点导航头像，账号菜单打开会自动刷新余额） | `topups.status=paid`；`payments` 一条 succeeded；`wallet_ledger` 一条 +1200 |
| B3 | 余额 $12 | 同样的地区与套餐 → 创建 | 先显示「创建中」，**不显示扣费**；开通成功后才显示扣了 **$0.30**（当天日价）、剩余 $11.70 | 刚点击后：**没有** `wallet_ledger` 行；`orders.state=provisioning`、`charge_mode=at_ready`；`servers` 一行 `billing_state='pending'`、`paid_until=NULL`、`billing_anchor_at=0`、`daily_price_cents=0`。开通后：一条 `-30` 扣费，`servers.state='active'`、`billing_state='active'`、`daily_price_cents=30`、`billing_anchor_at≈ready_at`、`paid_until≈ready_at+1天` |
| M1 | 有一台已扣过费、`state='active'` 的服务器，余额足够（仅 dev） | 把 `paid_until` 改到昨天，再手动跑一轮计费（命令见下方） | 服务器照常可用（不中断） | 落后 1 天会补 **2 天**：两条 `server_day` 扣费（每格一条，`ref=server_day:<id>:<bucket>`）；`paid_until` 补到「超出 now 1 小时」之后；余额相应减少。续费时机与窗口见 `unpaid-tombstone-acceptance.md` §1 |
| M2 | 一台已扣过两三天的服务器 | 销毁它 | 确认后消失；余额比销毁前多 | `wallet_ledger` 一条正向 `adjustment`（`ref=server_refund:<id>`），金额 = 未开始的整天数 × 日价；同一服务器不会出现第二条 |
| M3 | 一台**正在连接中**的服务器 | 销毁它并确认 | 隧道随即断开、状态栏回到未连接；节点从连接页消失；配置里还有别的节点时可直接选一个再连，一个都没有时显示「这条配置没有节点了」且主按钮是按规则禁用的「连接」 | `servers.state='destroyed'`；`configs.current_node_id` 变为 NULL；`nodes` / `config_nodes` 已清；应用日志有 `runtime_stop` 相关记录 |

**M1 的具体做法（仅 dev）**

```bash
wrangler d1 execute veyl-control-plane-dev-4 --remote --command "UPDATE servers SET paid_until = strftime('%s','now','-1 day') * 1000 WHERE id = '<server_id>'"
```

```bash
curl -s https://dev.veyl.dessage.xyz/health
```

第二条只用来确认 dev Worker 在线。改完库**等下一次定时任务**：计费每小时第 17 分跑一次（`wrangler.jsonc` 的 `crons`，UTC），dev 与生产同一套。等待期间可以先用 `npx wrangler tail veyl-control-plane-dev` 观察 `[billing]` 日志。

## 执行顺序

L1 → L2 → B1 → B2 → B3 → M1 → M2 → M3

## 失败时要给我三样

1. 用例编号；
2. 界面上的原话或截图；
3. 应用日志 `~/.veyl/logs` 同一时间段的几行。

数据侧我自己查 `topups` / `payments` / `wallet_ledger` / `orders` / `servers`，不再让你贴。
