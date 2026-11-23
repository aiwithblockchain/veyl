# 自带 DigitalOcean 账号（BYO）

> 日期：2026-11-22
> 状态：设计草案，待拍板；替换 `login-and-payment.md` 里「平台代建 + 按天计费」的建机链路
> 关联：`docs/design/software-subscription.md`、`docs/design/my-servers.md` §19、`docs/design/node-agent-mcp.md`、`docs/design/environments.md`
> 范围：设计稿与契约增量；不含实现代码

---

## 0. 结论先行

| # | 问题 | 结论 |
|---|---|---|
| 1 | 谁拥有机器 | **用户自己的 DigitalOcean 账号**。账单记在他头上，我们全程不碰钱 |
| 2 | 怎么授权 | DO OAuth（public client + PKCE）。用户在系统浏览器里点同意，回跳 `veyl://oauth/do/callback` |
| 3 | Token 存哪 | **只存本机系统钥匙串**。不上传控制面、不落库、不进日志 |
| 4 | 谁调用 DO API | **客户端直接调**。控制面不持有云凭据，也不代建 |
| 5 | 建机前检查 | `account.status` / `droplet_limit` / `prepayment_status` / `balance` 四项，全部只读 |
| 6 | 建机失败 | 按失败类型给**可执行指引**，不显示原始 API 报错 |
| 7 | 机器生命周期 | 归 DO 账单管。我们不主动销毁用户的 droplet，除非用户点了「销毁」 |
| 8 | 控制面剩下什么 | 节点注册（enroll）、凭据签名、节点组同步、订阅权益。**不再有 provision** |
| 9 | 兜底路径 | 粘贴 Personal Access Token；再兜底是「只填 SSH，手动建机」 |
| 10 | 现状影响 | `provision.ts`、`providers/digitalocean.ts`、`orders.ts` 退出主链路；enroll 机制原样复用 |

---

## 1. 为什么是 OAuth

DigitalOcean 的 OAuth 对公共客户端是开放的（文档更新于 2026-10-20）：

- 桌面应用按 **public client** 注册，**不需要 client secret**，走 Dynamic Client Registration（`POST /v1/oauth/register`，`token_endpoint_auth_method=none`）
- 授权用 `code + PKCE(S256)`，回跳 URI 可注册 1–5 个
- `scope` 可以省略，由用户在同意页自行勾选；**我们应当显式请求最小集合**，让用户一眼看清给了什么

对比粘贴 token：OAuth 的权限是用户当场确认的、可随时撤销、不需要在我们的界面里出现过一次明文密钥。它是默认路径，token 是兜底。

---

## 2. 请求的权限（最小集）

| 用途 | scope | 说明 |
|---|---|---|
| 建机 | `droplet:create` | 只建，不改规格 |
| 读机器 | `droplet:read` | 列表、状态、IP |
| 改机器 | `droplet:update` | 开关机（用于重启） |
| 删机器 | `droplet:delete` | 仅用户主动销毁时调用 |
| 上传公钥 | `ssh_key:create` / `ssh_key:read` / `ssh_key:delete` | 一次性密钥对，用完可删 |
| 选地区 / 规格 / 镜像 | `region:read`、`size:read`、`image:read` | 建机表单需要 |
| 预检 | `account:read`、`billing:read` | 见 §3 |

**不请求**：`account:write`、账单变更、VPC 写权限、数据库、Kubernetes、任何 `*:delete` 之外的管理权限。

> scope 名称以 DO 的 token scopes 参考页为准（`droplet:create`、`droplet:update` 这类 CRUD 形式已在文档中出现）。实现前逐项核对，缺一项就少一项能力，不能靠猜。

---

## 3. 授权后的预检

三个只读端点，决定「能不能建」：

| 端点 | 读什么 | 用途 |
|---|---|---|
| `GET /v2/account` | `status`（active / warning / locked）、`droplet_limit`、`status_message` | 账户是否被锁、还能建几台 |
| `GET /v2/customers/my/prepayment_status` | 预充值门槛是否被拦 | 部分账号必须先充值才能建资源 |
| `GET /v2/customers/my/balance` | `account_balance`、`month_to_date_balance` | **只做提示，不做硬门槛** |

判定顺序：

```
status == locked        → 阻止建机，原样展示 status_message
prepayment 被拦          → 引导去 DO 充值，附余额与所需金额
已达 droplet_limit      → 引导申请提额，链接到 DO 支持页
其余                     → 允许建机
```

**关于余额的一个误区**：DO 的常态是绑卡后按量扣费，不是预充值。`account_balance` 为 0 甚至为负，只要账户 active、卡有效，机器照样能建。拿 `balance > 0` 当门槛会把正常用户挡在外面。

---

## 4. 建机流程

```
选择地区 / 规格
      │
      ├─ 生成一次性 ed25519 密钥对（本机）
      ├─ POST /v2/account/keys            上传公钥
      ├─ POST /v2/droplets                建机 + user_data(cloud-init)
      ├─ 轮询 droplet.status 直到 active
      ├─ agent 回连控制面（复用现有 ENROLL_BASE_URL / 签名凭据）
      ├─ 写节点记录 → 可用
      └─ 失败 → 删除 droplet → 删除 key → 报可执行错误
```

要点：

- `user_data` 沿用现有 cloud-init（下载 agent、校验 sha256、安装），**ENROLL_BASE_URL 与凭据签名机制不变**
- 密钥对每台一套，不跨机复用；销毁时连同公钥一起删
- 建机请求带 `tags`（如 `veyl:<account_id>`），方便用户在 DO 面板里认领自己的机器
- 轮询有上限（例如 180 秒），超时按失败处理并回滚，不留半成品

---

## 5. 失败矩阵

| 现象 | 判定 | 给用户的话 |
|---|---|---|
| 401 / 403 | scope 不足或 token 被撤销 | 「授权已失效，请重新连接 DigitalOcean」 |
| 422 + limit 相关 | 达到 `droplet_limit` | 「DO 账号最多 N 台，去申请提额」+ 链接 |
| `status == locked` | 账户被 DO 锁 | 展示 `status_message` 原文 |
| prepayment 被拦 | 需先充值 | 「先充值 $X」+ 余额 |
| 建机成功但 agent 不回连 | 网络 / 镜像 / 启动失败 | 「机器已建好但没连上，重试或销毁」 |
| 机器后来被 DO 关机 | DO 账单失败 | 「DO 那边扣款失败，机器被停用」+ 账单链接 |

最后一条最容易被误判成我们的故障。监控和 UI 都要能区分「agent 断了」与「DO 把机器关了」——前者是我们的事，后者是用户和 DO 的事。

---

## 6. 生命周期与解绑

- **我们从不主动销毁用户的 droplet**；只有用户点「销毁」时才调 `droplet:delete`（并在界面上明确写「这会删除 DO 上的机器，费用停止」）
- DO 侧扣款失败导致停机，我们只做检测和解释，不做自动补救
- 解除绑定：删本机 token → 通知控制面把节点标记为「未托管」→ 可选：提示用户去 DO 删除残留机器
- 撤销授权也可以直接在 DO 控制台做；下次调用拿到 401 时按 §5 引导重新授权

---

## 7. 安全边界

- Token 不出本机：客户端直连 `api.digitalocean.com`，不经过控制面
- 日志与诊断包**永远不含 token**；报错信息里只出现 scope 名称和状态码
- 节点凭据（enroll 签名）与云 token 分开存储，互不复用
- 界面上要有一页「Veyl 能对你的 DigitalOcean 做什么」，逐条列出 §2 的 scope 与对应操作，并提供「解除授权」按钮——这是取得信任的成本，也是审核时能拿出来的材料

---

## 8. 控制面的变化

| 模块 | 现状 | 改后 |
|---|---|---|
| `provision.ts` | 用平台账号建 droplet、写 enrollment | **退出主链路**（可整体删除） |
| `providers/digitalocean.ts` | 平台侧 DO API 客户端 + 目录缓存 | 目录（地区/规格/价格）改为**只读取展示**，不再下单 |
| `orders.ts` | 下单 → 扣费 → 建机 | **删除**；建机不再经过控制面 |
| `servers.ts` | 平台视角的服务器列表 | 改为「已注册节点」列表，数据来自 agent 回连 |
| enroll | 建机后写入 | **保留**，是唯一入口 |
| 计费 | 按天扣余额 | 换成订阅权益（见 `software-subscription.md`） |

一句话：控制面从「代建 + 记账」变成「节点目录 + 权益」，机器相关的一切都回到用户自己的账号里。

---

## 9. 兜底路径

1. **粘贴 Personal Access Token**：DO 控制台 → Account → API → 生成 token，选 Custom Scopes（§2 同一组），设过期时间，粘进客户端。实现成本最低，用于 OAuth 回调失败或用户不想跳浏览器
2. **只填 SSH**：用户在 DO 面板手动建机，把 cloud-init 片段粘进 User Data；机器起来后自己回连 enroll。零 API 权限，但步骤最多，放在「高级」里
3. **完全不连 DO**：手动导入任意 sing-box 节点，free 档也能用

---

## 10. 验收

1. OAuth 授权全流程在 macOS / Windows 各跑通一次，回跳能正确落到客户端
2. 授权页展示的 scope 与 §2 一致，不多要
3. 预检四种情况各给一条正确的指引文案，不出现原始 JSON
4. 建机成功后 agent 回连、节点可用；销毁后 DO 上确实没有残留 droplet 和 key
5. 撤销授权后，客户端在 30 秒内检测到并提示重新连接
6. 诊断包导出后 grep 不到 token
7. 用户 DO 账户被锁 / 达到额度时的错误路径可复现

---

## 11. 未决

| # | 问题 | 影响 |
|---|---|---|
| 1 | 是否支持第二家云（Vultr / Hetzner） | 影响 `providers/` 抽象层是否现在就抽 |
| 2 | DO 推荐计划返利 | 用户注册环节可以带 referral，条款待确认 |
| 3 | 无 DO 账号用户的注册引导 | 需要一份「从注册到绑卡」的分步引导，否则转化断在这里 |
| 4 | 规格与价格展示口径 | 价格是 DO 的定价，我们只展示，不做加价 |
