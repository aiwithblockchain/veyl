# 节点诊断与自救流程（智能诊断）

> 2026-11-22 · **产品已确认，开工中**（用户原话：「开始实现」）
> 取代：`connection-repair-actions.md`（两个动作）、`node-actions-ui.md` §2–§4（入口矩阵与失败行三态）
> 保留：`node-actions-ui.md` §3.1（周期同步的 hero 提示）、§8（边界）、`node-agent-mcp.md`（agent 与 MCP 契约）

## 1. 原则

- 用户只做一个决定：**开始分析**。之后每一步由系统给出下一步动作，用户点按钮确认。
- 判断顺序从便宜到昂贵：**ping → sing-box 可用性 → 同步配置 → 更换连接密码 → 交给 AI**。
- 任何会改变状态的动作都必须用户确认；只读的 ping 也要点「开始」。
- **先同步、后更换，一次诊断只更换一次**：更换连接密码之前一定先看过最新配置（步骤 3 的同步配置），避免拿着过期端口就去换密码；更换后仍不通就交给 AI，不再循环——这就是从流程上杜绝多设备互踢的方式。

## 2. 入口

| 位置 | 形态 |
|---|---|
| 连接页 · 失败行 | `测不通　智能诊断`（单入口，取代「智能修复 · 问 AI」） |

- **服务器详情不提供诊断入口**（2026-11-26 定）：详情页是信息管理，不跟连接状态挂钩；原来按「本地节点最近一次探测不可达」显示的那个按钮已删除。要看节点通不通，去连接页。
- 只在**自有节点**、且**确实测不通**时出现；`untested`、测速中、建机阶段、到期、悬挂都不出现。
- 点击后打开**诊断面板**（独立界面），不在行内展开。

## 3. 诊断面板

```
┌ 诊断：东京 01 ──────────────────────────┐
│ ✓ 连通性       ICMP 通 · 32 ms           │
│ ✓/✕ 代理可用性 代理可用 · 86 ms / 代理不通│
│ → 同步配置     配置无变化                 │
│                [ 同步配置 ]              │
│                                          │
│              [ 关闭 ]                    │
└──────────────────────────────────────────┘
```

- 代理可用或没测成时，面板只留「关闭」；只有确定代理不通才追加「同步配置」。
- 逐条追加，**不预先展示未执行的步骤**——一堆灰按钮只会让人以为在等。
- 每一步都有：状态点（进行中 / 通过 / 失败）、一行结论、下一步的按钮。
- 面板可随时关闭；已完成步骤的结果写入日志，重新打开从第一步重新开始。

## 4. 流程与判定

### 步骤 1 · 连通性

- 用户点「开始分析」→ 自动做 ICMP（3 次，单次超时 2 秒）。
- **通** → 进入步骤 2。
- **不通** → 自动再试一次到控制端口 `32100` 的 TCP（5 秒），作为 ICMP 被屏蔽时的保险：
  - TCP 通 → 说明只是 ICMP 被屏蔽，继续步骤 2。
  - TCP 明确被拒（`refused`）→ 机器在线、只是控制端口没有服务在听：结论「机器在线，控制服务不可用」，下一步「去问 AI」——重置也要 agent 在线，此刻点了没用。
  - 两者都不通 → 先排除**本机断网**：本次读这台服务器记录的控制面请求也失败时，结论写成「本机网络可能不通」，不判定机器不可达，也就**不给销毁**。
  - 确认本机网络正常、只有这台不通 → 结论「这台机器整机不可达」，按钮 `去销毁并重建`：**只跳转「我的服务器」并定位到这台，不替用户销毁**，销毁仍在详情页确认。
- 探测命令自身失败（Host 返回错误，例如 IP 格式不对或系统 ping 不可用）→ 与「机器不可达」区分开：结论写「探测没能执行」，下一步只给「去问 AI」，**不判定不可达、不给销毁**。

### 步骤 2 · sing-box 可用性（自动）

- 连通性通过后**自动**跑一次 `node_probe`（Clash 延迟，20 秒上限），不需要用户点按钮；只读，不重启隧道。
- **通过** → 结论「代理可用 · <延迟> ms」，流程结束，面板只留「关闭」。
- **不通过** → 结论「代理不通」，下一步给「同步配置」。
- **没测成**（`untested`）→ 结论「这次没能测：<原因>」，面板只留「关闭」，不推修复动作。
- 这一步的意义：ping 通只说明机器可达，代理可能只是瞬时抖动、已经恢复；先测一次能避免让用户白走同步/更换流程。

### 步骤 3 · 同步配置

- 用户点「同步配置」→ 走已有的**单台凭据**路径（`my_server_credentials`）：取回这台的新端口。接口不回传密码，所以**只比端口**。
- 端口变了、且隧道在跑、跑的就是这台 → stop → start；否则直接重测。
- 重测：
  - 通过 → 结论「配置已同步，连接已恢复」，流程结束。
  - 不通过（**不论端口有没有变过**）→ 进入步骤 4，照样给一次更换的机会。配置若是另一台设备刚改的、自己只是同步过来，也允许更换：ICMP 通说明 IP 没被封，更换通常能把服务救回来。
- 步骤 4 的结果：更换成功但仍不通、或更换本身失败 → **一律交给 AI**，不再给第二次更换。ICMP 通说明 IP 可达，更换还救不回来就不是凭据问题；AI 可以建议销毁重建、检索问题墙，或继续推理。
- 凭据请求本身失败（控制面不可达）**不进入步骤 4**：更换也要经过控制面，此刻点了只会失败。结论写「控制面暂时不可达」，下一步给「去问 AI」。

### 步骤 4 · 更换连接密码

- 用户点「更换连接密码」→ 二次确认（会断线、端口会变、其它设备需要同步配置）。
- 成功 → 重连并重测 → 通过则结束。
- 失败或仍不通 → 进入步骤 5。

### 步骤 5 · 交给 AI

- 用户点「去问 AI」→ 打开右栏，把本次收集的信息作为一条系统消息交给 AI；AI 读产品说明书与 FAQ 后再推理。
- 这个分支通常意味着**我们的 App 或节点软件有 bug**，不是用户能自己解决的。

## 5. 交给 AI 的信息（核心指标，先按这套落地）

| 项 | 内容 |
|---|---|
| 机器 | 服务器 id、地区、创建时间、当前状态 |
| 节点 | 本地节点 id、端口（**不含密码**）、是否正在使用 |
| 连通性 | ICMP 结果与耗时、TCP 32100 的结果 |
| sing-box 可用性 | 是否可达、Clash 延迟、没测成原因 |
| 同步配置 | 是否有变化、端口是否变化、重测结果 |
| 更换连接密码 | 成功/失败、失败 reason 码 |
| 本机 | 应用版本、平台、本次会话的 UI 日志路径 |

后续再打磨：是否带 agent 日志摘要（在机器上，桌面拿不到，需要控制面转存或用户 console 拷贝）。

## 6. 与已有设计的关系

- `connection-repair-actions.md`：**作废**。
- `node-actions-ui.md`：§2–§4 被本文取代；§3.1（周期同步在 hero 的提示）与 §8（边界）继续有效。
- 服务器详情的「智能修复」按钮已撤销：确认弹窗与文案并入诊断面板，入口只留在连接页（2026-11-26，详情页不跟连接状态关联）。

## 7. 边界

- 非自有节点（种子 / 手动导入）：不出现「智能诊断」——诊断里的同步配置与更换连接密码都只对自有节点成立。
- **免费节点（种子）测不通连「问 AI」也不出现**（2026-11-22 定）：免费节点已明确提示不保证可用，用户也没有恢复手段。手动导入节点仍保留「问 AI」（沿用 `node-actions-ui.md` §8）。
- `untested`、测速中、建机阶段：不出现入口。
- 一次分析只按顺序走一遍；进入「交给 AI」后不再自动重试。
- 分析过程中关闭面板：不中断已完成的步骤，结果写日志。
- 隧道相关动作（stop / start、更换后的重连）沿用既有规则：只有隧道在跑且跑的是这台才操作运行时。

## 8. 实现增量（对已交付代码的处置）
`2889d02` 实现的是上一版设计，本文获批后按下面处置：

**删除**

- 连接页失败行的自动同步，以及「配置已变更，请重试」`重新连接并测试` 的内联三态（`node-actions-ui.md` §3）。
- `NodeRepairDialog` 与详情页行内 repair 按钮、`detail.repair.*` 的确认文案（错误码文案保留，复用进面板；`detail.repair.*` 键已删，确认文案改用 `diagnosis.rotate.*`；2026-11-26 起详情页连诊断入口也不再提供）。

**保留**

- hero 的周期同步提示（`node-actions-ui.md` §3.1）。
- `updateConfigAndReconnect` 的 stop → start 规则与 `changed_node_ids` 用本地 `nd_` id 比较。
- 轮换的 7 类失败 reason 映射。

**新增**

- Host 侧一个可达性命令：一次调用返回 ICMP 与 TCP `32100` 两项结果（实现方式写进契约，面板只读结果）。
- 诊断面板组件与步骤状态机；两个入口共用同一个面板。
- `commands.md` 契约增量。

**复用（不新增接口）**

- 步骤 3 = `my_server_credentials`；步骤 4 = `node_rotate_credentials`。

## 9. 重复发起与次数限制

- **跨流程不设限制**：每一次「确实测不通」都可以重新发起一轮完整分析——关闭重开、或下一次探测失败后再点，都是新的一轮，不继承上一轮的结论。网络环境一直在变，不能因为上次结论就拦住用户。
- **同一轮内限制次数**（2026-11-22 定）：

| 步骤 | 次数 | 说明 |
|---|---|---|
| 连通性 | 1 | 点一次「开始分析」只探一次 |
| sing-box 可用性 | 1 | ping 通后自动跑一次，不单独重试 |
| 同步配置 | 最多 3 次 | 只有在「没测成」（untested）时才允许重试；确定性失败直接进下一步 |
| 更换连接密码 | 1 | 一轮里只有一次，且必须先看过最新配置 |
| 更换后重测 | 最多 2 次 | 只重测，不再更换 |

- 任何一步用完次数、或出现确定性失败，一律交给 AI，不再自动推进。用户如果仍想再试，关掉面板重新发起即可，那是新的一轮。

## 10. 连接失败：先本地诊断，AI 兜底

> 2026-11-22 · **已定稿（2026-11-22）**。只出规格；实现归前端批次，Host 与契约不动。
> 同日修订：兜底条件落到现有结论模型；修正耗时承诺；离线不再进死路；统一「智能诊断」用词；退役 `connectDiag`。
> 二次修订（实现边界）：补 `service-down` / `probe-ok` 与动作 `reconnect`；B 步加 `tun_helper_info`；`config-node-missing` 改 `changeNode`；本地命令失败归 `runtime-error`；手动导入无 IP 记 `skipped`；`probe-untested` 八个 reason 逐一映射（`clash_unavailable` 走 `retest`）。

### 10.1 失败态

- **只有托管节点（`source = owned`）连接失败**：hero 主按钮改为 **`智能诊断`**（`console.primary.diagnose`），点击即开面板并自动开始；`重新连接` 仍为副按钮，`报告问题` 保留。
- **其余来源一律不诊断**（2026-11-25 用户拍板）：订阅（`url`）、手动（`manual`）与免费（`seed`）节点都没有诊断入口、也没有行内「问 AI」，主按钮仍是 `重新连接`；用户要问答时走右栏常驻对话。原因见 `node-diagnosis-by-source.md` §0.1。

### 10.2 跑什么、跑多久

- 复用 `DiagnosisPanel` + `useNodeDiagnosis`，新增 `profile: "connection"`；**自动只跑两项**：
  - A 连通性：`node_probe_reachability`（ICMP 3×2 秒 + TCP 5 秒，整体 10 秒硬超时，`commands.md` §7.30）；
  - B 运行态与配置：`runtime_status` + `config_detail` + `tun_helper_info`（本地，<100ms）。本地命令抛错或超时 → 结论 `runtime-error`（失败命令与短码进 facts），**不归 `connection-undetermined`**。
- `tun_helper_info` 按结构化 `state` 判定，**不维护码表**：`running` 通过；`not_running` / `start_failed` / `file_invalid` / `stale` → `runtime-helper-blocked` + `openSettings`（设置位置「高级」，`Settings.tsx:2841`）；`unknown` 不判。
- 手动导入节点且拿不到 IP → 该步记 `skipped`（本档不适用），**不记 `probe-error`**。
- **连接失败档不自动跑 `node_probe`**（Clash 延迟，超时 20 秒，`tools.md` 3.21.1）；它只作为结论后的「重新测一次」动作，由用户点、上限沿用 20 秒。节点诊断档不同：ping 通后会自动跑一次，见步骤 2。
- 承诺改为：**通常 2–5 秒出结论，最坏 10 秒**（连通性硬超时）。不适用的检查记 `skipped`；探测命令本身的超时是 `probe-error`（见 10.3），不记 `skipped`、不阻塞其余步骤结论。

### 10.3 结论与动作

固定优先级，命中即止：**网络 → helper → 配置 → 节点**。

| 结论 kind | 文案要点 | 唯一动作 |
|---|---|---|
| `local-network` | 当前没有网络 | `retest`（恢复网络后重新检查） |
| `runtime-helper-blocked` | helper 未运行 / 未授权 | `openSettings` |
| `config-node-missing` | 配置里没有这个节点 | `changeNode`（重读配置也变不出这个节点） |
| `config-invalid` | 配置失效 | `updateConfig` |
| `server-unreachable` | 节点地址不通 | `changeNode`（导航到节点列表） |
| `service-down` | 节点服务没有响应（TCP refused） | `changeNode` |
| `probe-untested`（带 reason） | `node_not_in_config`→`updateConfig`；`node_not_in_running_config`→`retest`（重连后生效）；`connection_busy`→`retest` | 见左 |
| `probe-ok` | 节点现在能连通 | `reconnect`（等价 hero 重新连接） |
| `runtime-error` | 运行时有错误，本地无对应修复动作 | `askAi` |
| `probe-error` | 探测本身没跑起来（不是节点不通） | `askAi` |
| `connection-undetermined` | 本地检查都过、仍连不上 | `askAi` |

- `DiagnosisAction` 新增 `openSettings` / `changeNode` / `reconnect`；`retest` 复用现有。
- `service-down` 与 `server-unreachable` 分开：前者机器在线、控制服务没监听，后者连地址都不通。
- `probe-ok` 只出现在用户点「重新测一次」之后，**不用 `connection-undetermined` 承接**（那属于 `askAi` 集合）。
- `probe-untested` 的 reason 映射覆盖 `commands.md` §4.4 的封闭集合（2.59.0），共八条：`node_not_in_config` → `updateConfig`；`node_not_in_running_config` / `connection_busy` / `clash_unavailable` → `retest`；`no_credentials` → `changeNode`；`runtime_missing` / `runtime_failed` / `runtime_timeout` → `askAi`（按 `runtime-error` 语义）。**契约新增 reason 时必须同步本表**。
- `clash_unavailable` 不映射 `changeNode`：节点可能是好的，问题在运行时接口；重测仍是该原因时，该次结果记 `runtime-error` 走 `askAi`，不再循环 `retest`。
- **`local-network` 的判定**：连通性失败 **且** 控制面同时取不到（现有 `facts.controlPlaneError` 非空）。两者同时成立才判「没有网络」，避免把「节点挂了」误报成「你没网」。

### 10.4 AI 兜底条件（只用现有数据判定）

- 判定输入是最后一步的 `DiagnosisStep.conclusion.kind`（`useNodeDiagnosis.ts:154-196` 的判别联合），**不引入 `remediation` 字段**。
- **可执行结论集合 A** = `{ local-network, runtime-helper-blocked, config-node-missing, config-invalid, server-unreachable, service-down, probe-untested, probe-ok }`（8 个）；`probe-untested` 只有 reason ∈ `{node_not_in_config, node_not_in_running_config, connection_busy, clash_unavailable, no_credentials}` 时才属于 A，命中 A 时主按钮一定是可执行动作、**不是 `askAi`**。动作按钮旁另有一个「问 AI」次要出口：跑出结论后就能点，把本次清单交给 AI，不改变主按钮（2026-11-26 改：原来只在给不出结论时才有，用户反馈「整机不可达」这种最常见的情况反而没有入口）。
- **`askAi` 判定**：`kind ∈ { runtime-error, probe-error, connection-undetermined }`，**或** `kind = probe-untested` 且 reason ∈ `{runtime_missing, runtime_failed, runtime_timeout}`；等价于 `action === "askAi"`。
- 「多个疑似原因」不触发 AI：按 10.3 优先级取第一个可执行动作，其余异常原样作为事实进提示词。
- 离线时命中 `local-network` ∈ A，**永不判 `askAi`**——离线用户不会被送进必然失败的远程请求。

### 10.5 兜底提示词带的事实（D6：事实进消息、规则进提示词）

固定句取 `assistant.prompt.connectDiagnosis`，附 JSON：

- 失败阶段（connect / starting / running / failed）、错误码与 `reason`；
- 节点名与来源（owned / url / manual；seed 不进入本链路）、地区（**不含地址**）；
- 运行态、helper 状态、接管方式；
- 各步检查的 `status` 与稳定短码、探测三态与延迟；
- 已尝试的动作与结果；`app_version`、`platform`。

排除：密码、令牌、私钥、uuid、完整服务器地址与端口、配置全文、日志内容。

### 10.6 与节点行链路的异同

- **用词统一为「智能诊断」**：hero 主按钮、节点行入口（`diagnosis.entry` =「智能诊断」）、面板标题都用这个词。
- **共用**：面板组件、步骤状态机、上下文 JSON 序列化、`去问 AI` 的呈现。
- **不共用**：入口（hero vs 行内）、步骤集（无 sing-box 自动探测、服务器同步与更换密码）、结论集（多 helper / 配置失效）、上下文主体（连接快照 vs 服务器记录）。用 `profile` 区分，不复制面板。

### 10.7 验收

1. 能定位 → 结论带动作，用户不经过 AI 就修好。
2. 定位不到（`connection-undetermined`）→ 出现 `问 AI`，发送内容含 10.5 全部字段且无敏感项。
3. 免费节点 → 无诊断、无 AI，主按钮 `重新连接`。
4. AI 未配置 → 点 `问 AI` 弹全局告警、不发消息，面板结论保留。
5. 离线 → 结论「当前没有网络」+ `retest`，**不出现 `问 AI`**。
6. 连通性触到 10 秒硬超时 → 结论 `probe-error`、动作 `askAi`；其余步骤的结论照常进提示词。
7. 手动导入节点拿不到 IP → 该步记 `skipped`，不误报探测失败。
8. 本地命令抛错或超时 → 结论 `runtime-error`，失败命令与短码进 facts。

### 10.8 改动范围

- 前端：`ConnectionStage.tsx`（主按钮与回调）、`App.tsx`（connection 档依赖装配）、`useNodeDiagnosis.ts`（profile、`DiagnosisConclusion` 新增 8 个 kind（`service-down` / `local-network` / `probe-error` 复用现有）、`DiagnosisAction` 增 `openSettings` / `changeNode` / `reconnect`）、`DiagnosisPanel.tsx`（标题）、`assistantPrompts.ts`（新增 `connectDiagnosis`）、zh/en 字典（主按钮与 `diagnosis.entry` 统一「智能诊断」、新增结论与动作键）。
- **退役**：`assistant.prompt.connectDiag` 的中英两键与 `connectDiagAsk()` 随新链路删除，避免下次审计把它当成漏项。
- Host / 契约：**不改**，全部复用现有 UI 命令；`换一个节点` 本版只做导航，不调 `node_switch`。

---

## 11. 自定义节点（`url` / `manual`）：只有只读诊断，没有修复动作

订阅导入与手动填写的节点，凭据在用户或服务商手里。本节约束这一类的诊断，**托管节点（`owned`）的 §1–§10 逐字不变**。

- **能做**：连接失败后的本地只读检查、节点行「问 AI」、连接诊断面板的只读结论、重新测速。
- **不能做**：更换连接密码、销毁重建、任何跳「我的服务器」的修复动作。这些流程要求 `source === "owned"` 且有 `server_id`，自定义节点两条都不满足。
- **行内动作**：只保留「问 AI」与「换个节点」，不加「智能诊断」、不加删除。
- **给 AI 的事实**：`ConnectionFacts.nodeSource` 必须放行 `url`，取值集合是 `owned | url | manual | null`；不得把 `url` 折成 `null`。
- **建议边界**：只能建议换一个节点、检查用户自己的服务商、或把只读诊断结论转给服务商。提示词与产品文档都写明这条，不靠模型自行推断。
- **验收**：订阅 / 手动节点失败 → 行内只有「问 AI」；模型上下文里 `source` 为 `url` / `manual`；回复里不出现「更换连接密码」「智能修复」「销毁重建」。
