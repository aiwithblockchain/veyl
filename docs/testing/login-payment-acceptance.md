# 登录 · 充值 · 购买：主流程验收

> 日期：2026-11-16
> 范围：只验主流程（登录态是否成立、余额决定能否买机、按天扣费是否发生）。
> 说明：全面 UI 重构在即，本轮不覆盖异常、边界与门禁细节；那些等重构后按设计文档补齐。
> 原则：**全部在应用内点击完成**，数据只用于核对结果。

## 用例

| 编号 | 前置 | 操作 | 预期界面 | 我核对的数据 |
|---|---|---|---|---|
| L1 | 未登录 | 打开「我的服务器」→ 点登录 → 输入邮箱 → 收码 → 输入 6 位码 | 左栏底部显示邮箱与「已登录」；服务器列表出现 | 新建 `accounts(kind=email)`；`devices.account_id` 指向它 |
| L2 | L1 完成 | 完全退出应用，重新启动 | **仍然显示已登录**，不需要重新输验证码 | 刷新令牌轮换成功；旧的已作废 |
| B1 | 已登录，余额 $0 | 选地区与套餐 → 创建 | 提示余额不足，不开始创建 | `orders` 一行 `pending_payment`；无 `servers`；无扣费流水 |
| B2 | B1 之后 | 账号块 → 充值 → 选 $10 → 浏览器支付 → 回到应用 | 余额显示 **$10.00** | `topups.status=paid`；`payments` 一条 succeeded；`wallet_ledger` 一条 +1000 |
| B3 | 余额 $10 | 同样的地区与套餐 → 创建 | 显示扣了 **$0.20**（当天日价）、剩余 $9.80，并开始开通 | `wallet_ledger` 一条 `-20`；`orders.state=provisioning`；`servers` 一行，`daily_price_cents=20`、`billing_anchor_at≈created_at`、`paid_until≈created_at+1天` |
| M1 | 有一台已扣过费的服务器 | 我把它的 `paid_until` 改到昨天，触发每日任务 | 界面上服务器照常可用（不中断） | 新增一条 `server_day` 扣费（`ref=server_day:<id>:<bucket>`）；`paid_until` 顺延 **1 天**；余额相应减少 |
| M2 | 一台已扣过两三天的服务器 | 销毁它 | 确认后消失；余额比销毁前多 | `wallet_ledger` 一条正向 `adjustment`（`ref=server_refund:<id>`），金额 = 未开始的整天数 × 日价；同一服务器不会出现第二条 |

## 执行顺序

L1 → L2 → B1 → B2 → B3 → M1 → M2

## 失败时要给我三样

1. 用例编号；
2. 界面上的原话或截图；
3. 应用日志 `~/.veyl/logs` 同一时间段的几行。

数据侧我自己查 `topups` / `payments` / `wallet_ledger` / `orders` / `servers`，不再让你贴。
