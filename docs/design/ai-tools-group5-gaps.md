# AI 工具第 5 组：补缺口决策单

> 日期：2026-11-25
> 状态：**已落地**（第 5 组 = 3.31.0 `MyServerWallet` + 3.32.0 `LlmProviders`；后续修订 3.34.0 给 `MyServers` 补 `paid_until` / `billing_state`、3.35.0 `LlmProviders` 每行带 service provider id、3.37.0 `MyServers` 透出流量四字段与账号池 `traffic_pool`、3.38.0 修正 `MyServers` 的 content 计费与流量措辞并统一 GiB；工具面 38）。
> 依据：`docs/design/ai-tools-inventory.md` §3.4（G1 / G2 / G3 / G4 / G7 / G8）、§4 待定点第 9、10 条。
> 范围：只回答「该不该给 AI」，并写到能派活为止；实现细节留给工具实现。

---

## 0. 判断原则

沿用前四组的两条：

1. **给 AI = 用户在对话里问得出、模型必须能答**。只读数据优先；写入要有「用户明确点了才发生」的替代路径。
2. **只给 UI = 有安全、副作用或交互理由**，并且能一句话说清为什么。

工具数从 **36 → 38**，分**两片**落地，每片独立验收、独立提交，现在两片均已落地：**3.31.0 `MyServerWallet`（36 → 37）**、**3.32.0 `LlmProviders`（37 → 38）**。每片只加一个工具，版本按片升，不再「一批一次升」。`TrialStatus` 不新增（`DefaultProfileStatus` 已覆盖模型可见的试用状态，见 §2.2）。

---

## 1. 清点

| # | 能力 | 现有命令 | 现有 AI 工具 | 数据够不够 |
|---|---|---|---|---|
| 1 | 余额 | `my_server_wallet`（仅 UI） | 无 | 够（`balance_cents` / `currency` / `updated_at`） |
| 2 | 试用状态 | `trial_status`（仅 UI） | `DefaultProfileStatus` 的 content 已给 state + 剩余天数 + 池内节点数 | 够回答状态与剩余天数；`expires_at` / `started_at` 两个工具都没下发 |
| 3 | 节点 / 服务器到期 | `MyServers`（工具）缺字段；免费节点在 `trial_status` | `MyServers` 已注册，但**没有**到期与计费字段 | 服务器有 `paid_until` / `billing_state`，只是没下发；免费节点在试用数据里；自建 / 导入节点没有到期概念 |
| 4 | 批量测速 | `node_probe_all` / `node_probe_cancel` / `node_probe_snapshot`（仅 UI） | `NodeProbe` 单点；批量**明确禁止**用循环模拟（`tools.md`） | 够，但执行要起临时运行时 |
| 5 | 手机导出 | `mobile_export_get` / `mobile_export_rotate` / `mobile_clients_qr`（仅 UI） | 无 | 够，但返回里带导出令牌 |
| 6 | AI 服务商 | `llm_provider_list` / `_test` / `_save` / `_delete` / `_activate`（仅 UI） | 只有 DeepSeek 的 setup / save 两个 | 够（列表、测试连接都可复用命令） |

---

## 2. 逐项决定

### 2.1 余额：**给 AI**（新增 `MyServerWallet`，只读）

- 理由：产品口径明确要求「余额通过工具读取，不猜、不编」，用户问「我还剩多少钱」是最常见的账户问题；数据本就在本地控制面响应里，只读无副作用。
- 不给的后果：模型只能让用户自己去看设置页，等于把已有数据藏起来。
- 方案：`MyServerWallet {}` → `{ balance_cents, currency, updated_at }`。**不返回充值档位**（那是 UI 的收银台参数，模型用不到）；**不做充值工具**（支付属界面动作，与建机同一口径）。
- 权限：`ReadOnly`。

### 2.2 试用状态：**不新增 `TrialStatus`**

- 事实：`DefaultProfileStatus` 的 `content` 已经给「试用状态句 + 剩余天数 + 池内免费节点数」（`src-tauri/src/tools/net.rs:295-311`），只是 `data` 里没有试用字段，也没有 `expires_at` / `started_at`。
- 决定：**不新增工具**。模型已经能回答「试用还剩几天 / 是不是过期了」；再加 `TrialStatus` 只会让模型在两个工具之间选错。
- 若将来确实需要精确到期时间：先扩 `DefaultProfileStatus` 的 `content`（把 `expires_at` 写成一句人话），仍不拆工具。
- 权限：沿用 `DefaultProfileStatus` 的 `ReadOnly`。

### 2.3 节点 / 服务器到期：**不给新工具，扩 `MyServers` 字段**

- 理由：用户问的「到期」其实是三类东西——付费服务器的「已付至」（`paid_until` + `billing_state`）、免费节点试用到期（已由 2.2 覆盖）、自建 / 导入节点（没有到期概念）。前一类是 `MyServers` 的输出缺字段，不是缺工具。
- 方案（**已落地，3.34.0**）：`MyServers` 的每台服务器补 `paid_until`、`billing_state` 两个字段（`daily_price_cents` 已有；界面显示的就是这组值）；白名单 10 → 12，`tools.md` 的可见字段表与 `content` 要求同步（服务中时追加「已付至 {until}（每天自动续扣；扣不到即停机）」，3.38.0）。
- 不做：不给「到期提醒 / 账单预测」这类派生值——产品已拍板不推算「约可运行 N 天」。
- 流量（2026-11-26 补）：`traffic_used_bytes` / `traffic_limit_bytes` / `traffic_reset_at` / `traffic_state` 与账号池 `traffic_pool` 已随 3.37.0 透出给模型（不新增工具，同样不推算天数与金额，账号池不得由 `servers[]` 求和）。
- 权限：不变（`MyServers` 现有级别）。

### 2.4 批量测速：**只给 UI**（不做工具）

- 理由：
  1. 一次批量要起临时运行时、独占探针槽位，动辄几十秒，聊天里没有进度与取消的语义——这属于界面（面板里能看到进度、能取消）。
  2. 模型侧并非无路可走：`NodeProbe` 能逐个测；契约明确禁止「循环调用单点工具模拟批量」，所以不该再开一个让模型长跑的工具。
  3. 用户真正问的「哪个节点最快」，`RuntimeSnapshot.node_latency_ms` 与单点结果已经能答；批量结果只在面板里作为视觉排序用。
- 不做：不新增 `NodeProbeAll`；不把 `node_probe_snapshot` 注册成工具（缓存可能为空或过期，模型容易把「没测过」说成「都很快」）。

### 2.5 手机导出：**只给 UI**（不做工具）

- 理由：`mobile_export_get` 返回的链接里带导出令牌，令牌进模型上下文就等于进了日志与第三方服务；产品也定了「只导出付费节点」。让模型拿到令牌没有正当用途。
- 不给的替代：`OpenSettings` 已能指到 `account.mobile` 行，模型讲步骤即可。
- 不做：不新增导出工具，也不给「可导出节点数」之类的衍生读接口——那会把「能不能导出」变成模型判断，实际取决于付费状态，界面已有明确呈现。

### 2.6 AI 服务商：**部分给 AI**（新增 `LlmProviders`，只读 + 可选测试）

- 给：**列出服务商**与**测试连接**。
  - 理由：用户问「我现在用的是哪个模型 / 为什么连不上」时，模型必须能读；测试连接不修改任何配置，只复用 `llm_provider_test` 的既有判定。
  - 方案：`LlmProviders { test_provider_id? }` → `{ active_provider_id, providers: [{ id, name, protocol, model, base_url, has_key, last_result? }] }`；带 `test_provider_id` 时对该服务商跑一次测试，把结果放进对应项。
  - 返回值**永不包含 API Key**，只有 `has_key`；错误按 `tools.md` 统一码表。
- 不给：**保存 / 删除 / 切换当前服务商**。
  - 理由：这三件事都写配置，且要用户输入密钥；密钥经模型手抄进参数是最不该发生的路径。界面里已有完整表单。
  - `DeepseekSetupKey` / `DeepseekSaveKey` 维持现状（只覆盖 DeepSeek），在 `LlmProviders` 的描述里说明「配置请让用户到设置里改」。
- 权限：`ReadOnly`（测试连接不改状态）。

---

## 3. 工具数与契约（两片：3.31.0 / 3.32.0）

| 变化 | 工具数 | 契约 |
|---|---|---|
| 基线（3.30.0） | 36 | 3.30.0 |
| 第一片：+ `MyServerWallet` | **37** | 3.31.0 |
| 第二片：+ `LlmProviders` | **38** | 3.32.0 |

两片各自验收、各自提交；第二片在 37 的基础上再加一个。

**第一片（3.31.0，`MyServerWallet`）**

- `tools.md`：§3 注册清单加一行；§4.58 由原 `AccountBalance` 提案改写为正式小节；§1.2.1 验收清单加一行；变更表加 3.31.0。
- `commands.md`：`my_server_wallet` 的「无 AI 工具」标注改指 `MyServerWallet`；升小版本并加变更记录。
- `tool-display.md` / `TOOL_COPY`：`MyServerWallet` 的中文展示文案与事实行（金额 + 币种 + 快照时间）。

**第二片（3.32.0，`LlmProviders`）**

- `tools.md`：§3 加一行；§4.60 由 `AiProviders` 提案改写；变更表加 3.32.0。
- `commands.md`：`llm_provider_list` / `llm_provider_test` 两条命令的「无 AI 工具」标注改指 `LlmProviders`；`trial_status` **保持「无 AI 工具」**（`TrialStatus` 不新增，见 §2.2）；升小版本并加变更记录。
- `tool-display.md` / `TOOL_COPY`：`LlmProviders` 的展示文案与事实行（服务商名）。

`MyServers` 的可见字段表补两个字段（`paid_until` / `billing_state`）；§1.4 错误码表如无新码则不动。

---

## 4. 验收（能回答什么问题）

1. 「我余额还有多少」→ `MyServerWallet` 直接答，并说明是外部快照。
2. 「试用还剩几天 / 过期没有」→ `DefaultProfileStatus` 的 content 答 `state` + 剩余天数（没有精确 `expires_at`，不要编）。
3. 「我这台服务器什么时候扣费 / 本期到哪天」→ `MyServers` 的 `paid_until` + `billing_state`；`active` 且已过时间的口径仍按「本期已过，服务正常」。
4. 「帮我把所有节点测一遍」→ 模型明确拒绝长跑，引导到节点卡的测速入口；单点仍可用 `NodeProbe`。
5. 「手机上怎么用」→ 讲步骤并把用户带到「我的服务器」左栏的「在其它设备上使用」；**不出现任何令牌或链接**。
6. 「我现在用的哪个服务商 / 帮我测一下连接」→ `LlmProviders` 列出当前服务商并给测试结果；「换一个服务商」引导到设置。
7. 工具数 38（**两片已落地后的终值**：3.31.0 后为 37，3.32.0 后为 38）；`tools.md` §3 与 `TOOL_COPY` 逐名相等；`toolDisplay.test.ts` 绿。

---

## 5. 不做

- 不做充值、建机、销毁、手机导出、批量测速的工具（支付与长任务属界面）。
- 不做服务商保存 / 删除 / 切换（密钥输入不经模型）。
- 不做「约可运行 N 天」「下次扣费具体时刻」这类派生值。
- 不新增 `TrialStatus`（`DefaultProfileStatus` 已覆盖；见 §2.2）。
