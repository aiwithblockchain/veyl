# 服务器详情页：创建记录（时间线）

> 日期：2026-11-24
> 状态：**已定稿（2026-11-24）**；四条裁定见 §10。只出文档，不改代码。
> 范围：`MyServerDetail` 中间详情页新增一块「创建记录」；左栏、向导、连接页、墓碑视图不动。
> 依据：`veyl-ui` §2.2（一个事实一个住处）/ §3.1（状态色只用于点与文字）/ §3.2（只用字号阶梯）/ §3.3（4px 网格、边界靠留白）/ §6（错误三段式、按钮动词短语）；`ui-ux-pro-max` 命中 `Feedback · Empty States`（空态要有说明，不能留白）、`Feedback · Loading Indicators`（异步要 `aria-busy`，近即时结果不闪骨架）、`Content · Date Formatting`（用不会歧义的本地化时间）、`Layout · Content Jumping`（异步内容放在稳定容器里，不把下方元素顶走）；「activity timeline / history log」两次检索均无数据库命中，版式按 `veyl-ui` §3.3 留白与 §3.1 状态色处理，**明确标注为 fallback**。事实源：`servers-list-detail.md` §2.2–§2.4、`my-server-detail-layout.md` §1（三块与 48 间距）、`my-server-detail-states.md` §4（危险块永远最后）。

---

## 0. 结论摘要

1. **数据来自 `audit_log`，加上服务器行本身的 4 个阶段时间戳**：审计是主源；`created_at` / `installing_at` / `verifying_at` / `ready_at` 只用来补成功路径上审计没写的里程碑，不编造、不估算。理由见 §1.2。
2. **接口是独立的 `GET /v1/servers/{id}/events`**，不并进详情：详情在开通中每 2 秒重取，事件是懒加载的次要内容，合并会把开销压到每次轮询上。
3. **出网的不是 `detail` 原文**：Worker 只返回归一化后的 `code` + 白名单字段（`version` / `amount_cents` / `reason`）。原文里的 provider_id、错误文本、日志片段、token、order_id、端口一律不出网。
4. **UI 是详情页第四块**，位置在事实区与危险块之间（危险块仍最后）。失败机器默认展开，就绪机器默认收起。
5. 上限 50 条、无分页；相邻重复动作 10 分钟内折叠为一条并带次数。

---

## 1. 数据源

### 1.1 `audit_log` 的实际形状

```sql
CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,          -- Unix 毫秒
  account_id TEXT,
  server_id TEXT,
  action TEXT NOT NULL,
  detail TEXT NOT NULL          -- JSON 字符串，各动作字段不同
);
```

- **没有 `(server_id, at)` 索引**，也没有任何清理/归档任务。当前靠主键扫描，按 `server_id` 查会扫全表（表里混着所有账户的登录、目录刷新等行）。本设计**要求新增迁移 `0013`**：`CREATE INDEX IF NOT EXISTS idx_audit_log_server ON audit_log(server_id, at);`（只追加、不改已应用迁移）。
- `detail` 各动作字段不一致，且含内部信息：`provider_id`、`jti` / `exp`、provider 原始错误、agent 日志片段、`error` 文本、`password_length`、`order_id`。**永远不整段下发**（见 §2.3）。

### 1.2 两个必须说清的事实

**① `order.create` 不能进这条时间线。** `orders.ts:203` 写的是 `INSERT INTO audit_log (at, account_id, action, detail)`——**没有 `server_id`**：下单时服务器行还不存在（服务器行在 `checkout` 才创建，`orders.ts:255`），`detail` 里也只有 `{ region, plan }`，没有 order_id，无法安全关联。本期不展示它；「下单完成」这一条改用服务器行的 `created_at`（`MyServer.created_at`，就是建行时刻）作为里程碑，见 §1.3。

**② 成功路径上审计只留了首尾。** agent 上报 `installing` / `verifying` 成功时不写审计行，只有失败才写。所以只看 `audit_log`，一台正常机器只有 `provision.created` 与 `enroll.ok` 两条，用户会觉得「还是没记录」。`servers` 行本来就存着 `created_at` / `installing_at` / `verifying_at` / `ready_at` 四个真实时刻，用它们补三个里程碑即可，不需要改写入侧、老机器也能用（没有上报的列为 null，就不出那条）。

> 这两条是对 PM 给的动作用清单的修正，**均已拍板接受**（§10）。退回「审计单源」的代价是正常机器只有 2 条记录，已否决。

### 1.3 合并后的时间线来源

| 事件 | 来源 | 条件 |
|---|---|---|
| 已确认下单 | `servers.created_at` | 恒有 |
| 机器已创建 | `audit_log: provision.created` | 有审计行 |
| 开始安装服务端 | `servers.installing_at` | 非 null |
| 检查服务端 | `servers.verifying_at` | 非 null |
| 已开通 | `enroll.ok` > `settle.ok` > `servers.ready_at`（三选一） | 按优先级取第一个存在的 |
| 各类失败 / 销毁 / 退款 / 端口变更 / 重新接入 | `audit_log` 白名单 | 见 §3 |

**「已开通」三源只出一条**：`enroll.ok` 带 `version`，优先；没有它用 `settle.ok`；两个审计都没有才用 `ready_at` 里程碑。三者在同一次激活里发生，重复展示就是同一件事说三遍。

---

## 2. 控制面接口

### 2.1 形状

```
GET /v1/servers/{id}/events        → 200 { events: MyServerEvent[], has_more: boolean }
```

- **归属校验**：与 `getServer` 一致，`loadServer(db, identity.accountId, id)`；别人的服务器与不存在的服务器**一律 404**，不泄露是否存在。**审计查询只按 `server_id` 过滤，不再加 `AND account_id = ?`**：归属已经由 `loadServer` 校验；而账号合并（`auth_email.ts` 的 `account.merge`）只改 `devices` / `orders` / `servers`，**不重写 `audit_log` 的历史行**，再按 `account_id` 过滤会把合并之前的创建记录整段丢掉。
- **只读**，不需要幂等键；不写库、不发事件、不改变任何状态。
- **排序**：`at DESC`（审计行同毫秒时按 `id DESC` 兜底），里程碑参与同一次排序。
- **上限**：审计最多取 51 行，与里程碑合并、折叠后按时间排序，**返回前 50 条**。`has_more` 必须同时计入**原始截断**与折叠后超限：SQL 取满 51 行即说明还有更早的条目，哪怕折叠后只剩一两条也要为 `true`。无 `limit` 参数、无游标分页——一条建机链路的事件量是个位数，50 是给「长期端口轮换 + 反复失败」留的余量。
- **折叠**：相邻两条同 `code` 且时间差 ≤ 10 分钟合并为一条，`count` 记次数、`at` 取较晚那条。Cron 重试与 agent 重复上报产生的连续同动作是这里的主要来源；跨小时的同类动作（两次端口轮换）是两件事，不并。
- 错误码**不新增**，沿用 §7.15：`UNAUTHENTICATED / auth_required`（未登录）、`NOT_FOUND / server_gone`（不是自己的或已不存在）、`UPSTREAM_ERROR / provider_unavailable`、`TIMEOUT / timeout`、`UPSTREAM_ERROR / invalid_response`。没有审计行不是错误，返回空数组。

### 2.2 返回类型

```ts
type MyServerEventCode =
  | "order.confirmed"    // 已确认下单
  | "machine.created"    // 机器已创建
  | "install.started"    // 开始安装服务端
  | "verify.started"     // 检查服务端
  | "activated"          // 已开通，开始计费
  | "create.failed"      // 机器创建失败
  | "install.failed"     // 安装服务端失败
  | "check.failed"       // 服务端检查没通过
  | "settle.failed"      // 余额不足，未开通
  | "destroyed"          // 服务器已销毁（reason 细分）
  | "port.changed"       // 节点端口已更换
  | "agent.rejoined"     // 实例重新接入
  | "refunded"           // 已退回
  | "refund.pending";    // 退款还没完成

type MyServerEvent = {
  at: number;              // Unix 毫秒（契约 §1 的时间戳口径）
  code: MyServerEventCode;
  count?: number;          // 折叠次数；仅 > 1 时出现
  version?: string;        // 仅 activated：sing-box 版本，来自 enroll.ok
  amount_cents?: number;   // 仅 refunded / refund.pending
  reason?: string;         // 仅 destroyed：白名单枚举，见 §3.3
};

type MyServerEvents = { events: MyServerEvent[]; has_more: boolean };
```

- **时间戳是毫秒整数**，Host 原样透传、UI 格式化；不做 ISO 转换（`commands.md` §1「落库实体的时间戳」）。
- 没有 `source`、没有原始 `action`、没有 `detail`：前端只认 `code`，控制面以后改审计字段不动界面。

### 2.3 可出网字段白名单（安全边界）

| 可出网 | 说明 |
|---|---|
| `code` | 由 `action` + 白名单映射得到 |
| `at` | 毫秒 |
| `count` | 折叠次数 |
| `version` | `enroll.ok.detail.version`，形如 `1.14.4` |
| `amount_cents` | `provision.refunded` / `provision.refund_failed` 的退款金额 |
| `reason` | `server.destroy.detail.reason`，**过白名单后才出网**，未知值直接省略 |

**禁止出网**（无论出现在哪个 `detail` 里）：`detail` 原文、`provider_id`（DO droplet id）、`jti` / `exp` / 任何令牌、`error` 文本、`log_excerpt`、`password_length`、`order_id`、`account_id`、其他用户 id、`node_port` / 端口号、ED25519 公钥与指纹。**IP 也不进记录**：事实区已有唯一住处（`veyl-ui` §2.2），日志里再出现就是第二个住处，而且这张表跨账户共享。

### 2.4 实现要点

- 在 `handleServers` 里加 `parts.length === 4 && parts[3] === "events" && GET`。
- 先 `loadServer` 取行（拿到 4 个时间戳与 `ready_at`），再一次审计查询拿 51 行：**SQL 按 `server_id` + 动作白名单过滤**（只取 §3.1 的动作，`billing.failed` / `grace_waived` 这类运维行不得占用 50 条窗口），映射、合并、折叠、排序都在 Worker 内完成（D1 不做窗口函数折叠，保持简单可测）。`has_more = 原始查询取满 51 行 || 折叠后超过 50 条`。
- 时间戳列是毫秒；`created_at` / `ready_at` 在行里已是数字。

---

## 3. 动作白名单 → 用户文案

### 3.1 用户可见

| `audit_log.action` | `code` | 出网字段 | 中文 | English |
|---|---|---|---|---|
| `provision.created` | `machine.created` | — | 机器已创建 | Machine created |
| `enroll.ok` | `activated` | `version` | 已开通，开始计费 | Ready — billing started |
| `settle.ok` | `activated`（`enroll.ok` 缺席时） | — | 同上 | 同上 |
| `agent.install_failed` | `install.failed` | — | 安装服务端失败 | Server software installation failed |
| `agent.report.failed` | 按 `detail.failed_stage`：`installing` → `install.failed`，其余 → `check.failed` | — | 同名文案 | 同名文案 |
| `enroll.rejected`（旧 enroll 链路） | 按 `detail.failed_stage`：`installing` → `install.failed`，其余 → `check.failed` | — | 同名文案 | 同名文案 |
| `provision.failed` | `create.failed` | — | 机器创建失败 | Machine creation failed |
| `settle_insufficient` | `settle.failed` | — | 余额不足，未开通 | Not enough balance — not activated |
| `server.destroy` | `destroyed` | `reason`（§3.3） | 见 §3.3 | 见 §3.3 |
| `server.rotated` | `port.changed` | — | 节点端口已更换 | Node port changed |
| `agent.re_enrolled` | `agent.rejoined` | — | 实例重新接入 | Instance reconnected |
| `provision.refunded` | `refunded` | `amount_cents` | 已退回 {amount} | Refunded {amount} |
| `provision.refund_failed` | `refund.pending` | `amount_cents` | 退款还没完成，稍后自动重试 | Refund pending — we'll retry automatically |

**不展示端口号**：端口的事实住处在节点凭据，日志只说明「换过」。**不展示 provider_id / 订单号**：对用户无意义，且是内部标识。

### 3.2 只给运维（明确不进时间线）

`enroll.activation_lost`、`enroll.order_ready_lost`、`agent.token_issued`、`billing.failed`、`billing.gap_waived`、`grace_waived`、`wallet.drift`、`refund_skipped_no_charge`、`provision.refund_abandoned`、`provision.<reason>`（回收器）、`activate_failed`、`order.create`（见 §1.2 ①）、`account.*`、`device.register`、`mobile.token_create` / `mobile.token_rotate`、`catalog.*`。

- `agent.report.failed` 例外：它是**新链路**（agent 上报）里唯一的失败留证，必须进时间线，但只取 `failed_stage` 来决定 `code`，`error` 文本与 `log_excerpt` 一律不出网。旧链路的 `enroll.rejected` 同理只取 `stage` / `failed_stage`，`password_length` 与 `error` 不出网。

理由：这些行要么带原始错误与日志片段，要么描述的是控制面内部重试/补账，用户读了也无从行动。**失败机器能看到的「为什么」由详情页已有的失败说明承担**，记录块只提供「先后发生了什么」。

### 3.3 `destroyed` 的 `reason` 白名单

| `reason` | 中文 | English |
|---|---|---|
| `user` | 服务器已销毁 | Server destroyed |
| `billing_unpaid` | 余额不足，已停机销毁 | Destroyed — insufficient balance |
| `enrollment_expired` | 机器没有按时接入，已回收 | Reclaimed — instance never checked in |
| `activation_lost` / `activate_failed` / `agent_enroll_failed` | 开通时机器丢失，已销毁 | Destroyed — instance lost during setup |
| `port_mismatch` | 服务端端口不一致，已销毁 | Destroyed — port mismatch |
| `install_failed` / `agent_install_failed` / `verify_failed` / `service_inactive` | 服务器已销毁 | Server destroyed |
| 其它 / 未知 | 服务器已销毁 | Server destroyed |

- 安装类失败**不在 `destroyed` 里重复原因**：前一条 `install.failed` / `check.failed` 已经说过，失败说明区也会说；`destroyed` 只负责「结束了」。
- 白名单外的 `reason` 不下发，按通用句渲染。

---

## 4. 契约与 Host 命令

### 4.1 契约

- 文件：`docs/contracts/commands.md`，版本 **2.63.0**（2.62.0 仍未发布，新版本叠在它上面；按不对称版本规则，**只动这一份**）。
- 新增 **§7.31 `my_server_events { serverId }` → `MyServerEvents`（仅 UI）**，类型用 §2.2，并写清：毫秒口径、归属 404、50 条上限、折叠规则、不做 AI 工具。
- 命令总表新增 **第 110 行**（现有最后一行是 109 `node_probe_reachability`）。

### 4.2 Host

- 命令：`my_server_events(serverId: String) -> Result<Value, Value>`，放在 `src-tauri/src/agent/commands.rs` 的「我的服务器」一组，紧挨 `my_server_get`；点击后不需要 `check_server_alive_quietly`（只读历史）。
- 控制面客户端：`src-tauri/src/control_plane/servers.rs` 加 `events(server_id)`，`GET /v1/servers/{id}/events`，反序列化成 `MyServerEvents`。
- **不落本地库、不缓存**：这是控制面历史，本地镜像没有对应表；离线时如实报错。
- **不注册 AI 工具**（与 `my_server_get` 一致，详情与凭据不进 AI 上下文）；**不发事件**（没有状态变化）。
- 落库实体时间戳一律毫秒，Host 不做任何格式化。

---

## 5. UI

### 5.1 位置：第四块，在事实区与危险块之间

`my-server-detail-layout.md` 的三块顺序扩成四块：**状态 / 事实 / 创建记录 / 危险操作**。危险块仍是最后一块（该文 §4 的裁定不变），块间距仍统一 48，块内 ≤ 24，不加细线。

```
纽约                                      ● 已开通
                                          ← 48
地区    纽约              IP      203.0.113.7  [复制]
节点    已就绪            费用     每天 $0.30
流量    每月 1000 GB 出站
                                          ← 48
创建记录  5 条                              ⌄
  11-24 14:32   已开通，开始计费 · sing-box 1.14.4
  11-24 14:31   检查服务端
  11-24 14:30   开始安装服务端
  11-24 14:29   机器已创建
  11-24 14:29   已确认下单
                                          ← 48
[销毁]
```

失败机器（默认展开）：

```
创建记录  6 条                              ⌃
  11-24 14:35   已退回 $0.30
  11-24 14:35   服务器已销毁
  11-24 14:35   安装服务端失败（2 次）
  11-24 14:30   开始安装服务端
  11-24 14:29   机器已创建
  11-24 14:29   已确认下单
```

- **标题行是一个按钮**（不是分区标题）：整行可点、透明底、高 24，hover `--bg-hover`，focus 2px `--focus` 内描边；`aria-expanded` + `aria-controls`。这是全页唯一的折叠标题——折叠控件必须有名字，它不算该文 §1 反对的那种装饰性分区标题。
- **不给每条加卡片或细线**：时间列 + 文本，行间 8；这是 fallback 版式（无数据库命中），只靠留白分组。
- 列表最大宽 760，与事实区对齐。

### 5.2 默认展开 / 收起

| 状态 | 默认 | 理由 |
|---|---|---|
| `creating` / `booting` / `installing` / `verifying` | **展开** | 条目会实时增长，用户正在等结果 |
| `error` | **展开** | 失败机器是这一块的核心价值 |
| `destroying` | **展开** | 最后几条就是它为什么结束 |
| `active` / `healthy` / `past_due` / `expired` / `gone` | 收起 | 页面已经很长；标题行常驻（「创建记录 · N 条」），一眼可见、一次点击打开 |
| 墓碑（`destroyed`） | **不显示** | 墓碑视图按 `servers-list-detail.md` §2.4 只有一句说明与删除 |

### 5.3 排版数字

- 标题行：`13 / 1.6 / 500`，`--ink`；条数 `12 / 1.45`，`--ink-3`，前留 8；chevron 12px `--ink-3`，靠右。
- 列表：`<ol>`，行间 `8`；每行网格 `120px 6px minmax(0, 1fr)`，列间距 `12`；行高随内容增长，不裁剪。
  - 时间列定宽 **120** 是实测值（2026-11-24，12px mono）：同年中文 `11-24 14:32` 80.8px、英文 `Nov 24, 14:32` 95.5px、跨年 `2026-11-24 14:32` 117.5px。原稿估算的 64px 连中文同年都放不下，会让时间压到圆点上；取 120 让各行对齐且所有格式都不溢出。
- 时间：`12 / 1.45` mono（`.num`，tabular-nums），`--ink-3`，`white-space: nowrap`。
- 正文：`13 / 1.6`，`--ink`；次要片段（版本、金额、次数）同一行，`12`、`--ink-3`，用 ` · ` 分隔。
- 圆点：`6×6`、圆角 2、与首行基线对齐（`margin-top: 7px`）；失败类事件 `--red`，其余 `--ink-4`。**不用 --green 表示成功**，一屏最多两种彩色。
- 加载 / 空 / 失败行都占 `min-height: 20px`，避免展开时把下方危险块顶走（`Layout · Content Jumping`）。

### 5.4 时间格式

- 同年：`MM-DD HH:mm`（`11-24 14:32`）；英文 `Nov 24, 14:32`。
- 跨年：`YYYY-MM-DD HH:mm`。
- 每条 `<time dateTime={ISO}>`，`title` 写完整本地时间。
- **不用「3 分钟前」**：日志会跨天，相对时间需要定时重渲染且容易歧义；这是对 `Content · Date Formatting`「relative or locale-aware」的选择——取 locale-aware。

### 5.5 加载、空、失败

| 状态 | 文案（中 / 英） |
|---|---|
| 首次加载 | 正在读取创建记录… / Loading creation log…（`aria-busy="true"`，不闪骨架） |
| 空 | 这台服务器没有留下创建记录。 / No creation records for this server. |
| 读取失败 | 读不到创建记录。 / Couldn't load the creation log. + 「重试」/ Retry（`role="alert"`） |
| 超过 50 条 | 只显示最近 50 条。 / Showing the 50 most recent entries. |

- 空态**不给动作**：这条时间线由系统写，用户没有可做的事；`Empty States` 要求「说明 + 动作」，这里用说明 + 失败说明区已有的下一步代替，不放假按钮。
- 读取失败只影响这一块：状态、事实、危险操作照常可用。重试只重取事件。
- **已有数据时的后台刷新失败不替换列表**：保留列表，在旁边加同一行「读不到创建记录。重试」提示；只有从未取到数据才整块显示错误。已经看到的记录不该因为一次刷新失败而消失。

### 5.6 刷新节奏

- 展开时立即取一次；收起后停止计时。
- 开通中（`creating`…`verifying`）且展开：**每 5 秒**取一次。不跟列表的 2 秒轮询同频——审计事件是稀疏的，5 秒足够看到新条目，也避免详情页变成每 2 秒三个请求。
- **离开开通中的那一刻**（状态变为 healthy/active/error）：绕过节流立刻取一次，1 秒后再补一次——「已开通」或「失败 + 销毁 + 退款」必须马上出现，而审计行可能比状态变化晚落库。此后 5 秒轮询停止。
- 其余状态：不自动刷新；收到 `my-server-changed` 且距上次 ≥ 5 秒时取一次（覆盖端口轮换、余额停机）。
- 收起再展开：先用 30 秒内的缓存立即渲染，超过 30 秒后台重取，不闪 loading。
- 新条目出现**不加 `aria-live`**：每 5 秒播报一次会把屏幕阅读器吵死；只有加载状态用 `aria-busy`。

### 5.7 无障碍

- 标题按钮 `aria-expanded` / `aria-controls`；面板 `role="region"`、`aria-label="创建记录"`。
- 列表是 `<ol>`，每条 `<li>`；时间用 `<time dateTime>`。
- 圆点 `aria-hidden`，状态信息只由文本承担。

---

## 6. 文案（新增 key，中 / 英）

| key | 中文 | English |
|---|---|---|
| `events.title` | 创建记录 | Creation log |
| `events.count` | {count} 条 | {count} entries |
| `events.loading` | 正在读取创建记录… | Loading creation log… |
| `events.empty` | 这台服务器没有留下创建记录。 | No creation records for this server. |
| `events.error` | 读不到创建记录。 | Couldn't load the creation log. |
| `events.retry` | 重试 | Retry |
| `events.more` | 只显示最近 50 条。 | Showing the 50 most recent entries. |
| `events.orderConfirmed` | 已确认下单 | Order confirmed |
| `events.machineCreated` | 机器已创建 | Machine created |
| `events.installStarted` | 开始安装服务端 | Installing server software |
| `events.verifyStarted` | 检查服务端 | Checking server |
| `events.activated` | 已开通，开始计费 | Ready — billing started |
| `events.createFailed` | 机器创建失败 | Machine creation failed |
| `events.installFailed` | 安装服务端失败 | Server software installation failed |
| `events.checkFailed` | 服务端检查没通过 | Server check failed |
| `events.settleFailed` | 余额不足，未开通 | Not enough balance — not activated |
| `events.destroyed` | 服务器已销毁 | Server destroyed |
| `events.destroyed.user` | 服务器已销毁 | Server destroyed |
| `events.destroyed.billing` | 余额不足，已停机销毁 | Destroyed — insufficient balance |
| `events.destroyed.expired` | 机器没有按时接入，已回收 | Reclaimed — instance never checked in |
| `events.destroyed.lost` | 开通时机器丢失，已销毁 | Destroyed — instance lost during setup |
| `events.destroyed.portMismatch` | 服务端端口不一致，已销毁 | Destroyed — port mismatch |
| `events.portChanged` | 节点端口已更换 | Node port changed |
| `events.rejoined` | 实例重新接入 | Instance reconnected |
| `events.refunded` | 已退回 {amount} | Refunded {amount} |
| `events.refundPending` | 退款还没完成，稍后自动重试 | Refund pending — we'll retry automatically |
| `events.countTag` | （{count} 次） | ({count}×) |

- `amount` 用现有金额格式（`$0.30`）；`version` 套 `.num`。
- 折叠次数用 `events.countTag` 接在句子后：`安装服务端失败（2 次）` / `Server software installation failed (2×)`。

---

## 7. 验收点

1. **完整性**：正常机器至少 4 条（下单 / 机器创建 / 开始安装 / 已开通），失败机器能看到失败条目 + 销毁 + 退款；老机器缺列时只少对应里程碑，不出现空行或假时间。
2. **不重复**：「已开通」只出现一次；`destroyed` 不重复安装失败原因；端口号、IP、订单号、provider id、任何错误原文都不出现在记录里。
3. **归属与错误**：拿别人的服务器 id 调接口得到 404（不是空数组）；未登录得到 `auth_required`；读取失败只影响这一块。
4. **默认态**：开通中与失败默认展开，就绪默认收起且标题行显示条数；墓碑视图没有这一块。
5. **刷新**：开通中展开时新条目在 5 秒内出现；状态落定后停止轮询；重新展开不闪加载。
6. **中英文与无障碍**：两种语言下时间列不折行、长文案换行不截断；`aria-expanded` / `aria-controls` / `aria-busy` 齐全；`prefers-reduced-motion` 下无额外动效（本块本来没有动效）。
7. **性能**：`EXPLAIN QUERY PLAN` 走 `idx_audit_log_server`；单次请求 ≤ 51 行；50 条上限生效并显示「只显示最近 50 条」。

---

## 8. 不做

- 不做运行日志 / agent 日志 / 实时 tail：那是另一个数据源（agent 只把失败片段写进审计），且属于运维视图。
- 不做日志导出、复制、筛选、搜索、分页。
- 不给 `order.create` 补 server_id（写侧改动，见 §1.2 ①）。
- 不加每日扣费流水：审计里没有这类行，扣费事实住费用区与账户余额。
- 不改墓碑视图、左栏、向导、连接页。
- 不把这条时间线暴露给 AI。

---

## 9. 分批与工作量

四批**串行**：契约定形状 → 控制面上线并部署 dev → Host 能取到真数据 → 前端联调。任何一批都不能跳过前一批拿到真实数据（共享 checkout、禁止假数据）。

| 批 | 内容 | 主要文件 | 量级 | 依赖 |
|---|---|---|---|---|
| 0 契约 | §7.31 + 总表第 110 行 + 版本 2.63.0 | `docs/contracts/commands.md` | ~60 行 | 本文定稿 |
| 1 控制面 | 迁移 0013 索引；`GET …/events`；白名单映射 + 合并 + 折叠；单测 | `migrations/0013_*.sql`、`src/servers.ts`、`test/servers*.test.ts` | ~230 行 + 7–9 条测试 | 批 0；**需部署 dev** |
| 2 Host | `my_server_events` + client + 反序列化 + invoke 注册 | `control_plane/servers.rs`、`agent/commands.rs` | ~90 行 + 2 条测试 | 批 1 部署 |
| 3 前端 | 时间线块、展开状态、取数与 5 秒节奏、i18n、CSS、组件测试 | `MyServerDetail.tsx`、新组件、`useMyServers.ts` 或局部 hook、`zh.ts` / `en.ts`、`app.css` | ~300 行 + 5 条测试 | 批 2 |
| 4 验收手册 | 正常机器 / 失败机器 / 老机器 / 别人服务器 404 四组步骤 | `docs/` 验收文档 | 1 页 | 批 3 |

估算：控制面 0.5–1 人日，Host 0.5 人日，前端 1 人日，契约与验收 0.5 人日，合计约 **2.5 人日**（不含部署与真机验收）。

---

## 10. 拍板结果（2026-11-24）

| # | 事项 | 裁定 |
|---|---|---|
| 1 | 里程碑合并（用服务器行 4 个时间戳补成功路径） | **接受**；已核对 `0004_progress_stages.sql` 与 `serverView`，三列都在且已出网 |
| 2 | `order.create` 不进时间线，改用 `created_at` 当「已确认下单」；不改写入侧 | **接受** |
| 3 | 50 条上限、无分页 | **接受** |
| 4 | 默认展开：开通中 / 失败 / 销毁中展开，就绪与停机收起，墓碑不显示 | **接受** |

本批只做第 0 批（契约 2.63.0 §7.31 + 总表第 110 行），控制面、Host、前端另派。
