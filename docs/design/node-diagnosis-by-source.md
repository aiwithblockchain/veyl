# 节点诊断：按来源分流（第 B 组）

> 日期：2026-11-24
> 状态：**待实现**。本文给实现方当输入，含已核实的事实、三个缺口与要拍板的两个问题。
> 上游：`docs/design/node-import-ui.md` §7（两类节点的能力边界）；`docs/design/node-diagnosis-flow.md`。
> 范围：只改「自定义节点失败时给什么建议/动作」，不改托管节点的诊断链路。

---

## 0. 结论摘要

诊断**动作**层面已经是对的：带「更换连接密码」的完整诊断面板只对托管节点打开。缺口在**上下文与建议**：

1. AI 拿到的 `nodeSource` 只覆盖 `owned` / `manual`，**订阅导入的节点（`url`）被丢成 `null`**，模型分不清「这是用户从服务商买的」还是「我们卖的」。
2. 失败后的建议文案没有按来源分流，模型可能对自定义节点说「帮你更换连接密码」——那件事对它根本不成立。

---

## 1. 已核实的事实

| 事实 | 证据 |
|---|---|
| 连接失败的行内按钮：托管节点给「智能分析」，其余非免费节点给「问 AI」 | `src/components/ConnectionStage.tsx:595`、`:604` |
| 完整诊断面板（含 rotate 步骤，会调 `node_rotate_credentials`）只在托管节点上打开 | `src/App.tsx` 的 `setDiagnosis` 只在 `handleAnalyzeNode` 中调用，而它用 `server.server_id` 构造 deps；`useNodeDiagnosis.ts:1218` 的 `runReset` 依赖该 deps |
| 连接诊断（本地检查 + 交给 AI）对所有非免费节点可用 | `ConnectionStage.tsx:329` 的 `canDiagnose`；`App.tsx` 的 `handleDiagnoseConnection` |
| 交给 AI 的上下文里 `source` 只可能是 `owned` / `manual` / `null` | `src/myservers/useNodeDiagnosis.ts:141`；`App.tsx:2374` 的 `node?.source === "owned" \|\| node?.source === "manual" ? node.source : null` |
| `NodeSummary.source` 实际有四值 | `src-tauri/src/store/configs.rs:23-27`：`seed` / `url` / `manual` / `owned` |
| 免费节点不诊断 | `ConnectionStage.tsx:329` 的 `!failedOnSeed`；`App.tsx` 的 `if (node?.source === "seed") return` |

---

## 2. 三个缺口

### G1（代码，小）订阅节点在 AI 上下文里没有身份

`ConnectionFacts.nodeSource` 的类型是 `"owned" | "manual" | null`，赋值处把 `url` 归进 `null`。后果：模型无法区分「订阅节点」与「没有来源信息」，给出的建议只能保守。

修法：类型扩成 `"owned" | "url" | "manual" | null`，赋值处放行 `url`；上下文渲染（`useNodeDiagnosis.ts:620`）与日志（`:1438`）无需改。

### G2（文案 + 提示词，中）失败建议没有按来源分流

自定义节点（`url` / `manual`）失败时，正确建议只能落在三件事上：

- **换一个节点**（同一个订阅里通常还有别的）
- **检查自己的服务商/服务器**（我们看不到它的状态）
- **把诊断结论交给服务商**（把只读结论当材料）

不能出现的建议：更换连接密码、智能修复、去「我的服务器」销毁重建——这些动作对自定义节点要么不存在，要么作用在别的机器上。

要做：
1. 诊断结论的文案表按 `source` 选取，自定义节点不出「修复」类措辞。
2. 右栏交给 AI 的上下文里带上 `source`（G1 之后自然就有），并在系统提示或该条系统消息里写明：自定义节点的凭据不在我们手里，不要建议更换连接密码/修复。

### G3（文档，小）`node-diagnosis-flow.md` 的口径

那份文档写的是托管节点的诊断流程；需要补一节说明「自定义节点只有只读诊断，没有修复动作」，避免实现者按它给自定义节点接上 rotate。

---

## 3. 要拍板的问题

| # | 问题 | 选项 | 建议 |
|---|---|---|---|
| D1 | 自定义节点失败时，界面上给几个动作 | ①只给「问 AI」；②「问 AI」+「换个节点」；③再加「删除这台」 | ②。删除是节点管理的事，不该出现在诊断结论里 |
| D2 | 是否允许对自定义节点发起「重新测速」 | 允许 / 不允许 | 允许——重测是只读的，且换网络后常有变化 |
| D3 | AI 侧是否需要一个专门的「把结论交给服务商」动作 | 要（生成可复制的诊断摘要）/ 不要 | 先不要，让 AI 用现有 `DiagRun` 的结论直接说；真有需求再开 |

---

## 4. 验收

1. 订阅导入的节点连接失败 → 行内出现「问 AI」，**不出现**「智能分析」。
2. 问 AI 之后，模型知道这是用户自己的节点（上下文里 `source = "url"`），**不会**建议更换连接密码或去「我的服务器」操作。
3. 手动添加的节点同上（`source = "manual"`）。
4. 托管节点（`owned`）的失败路径与现在**逐字不变**：仍有「智能分析」，仍能进完整诊断面板并更换连接密码。
5. 免费节点（`seed`）仍然不诊断。
6. `grep -rn "nodeSource" src/` 的类型定义只剩四个取值。

---

## 5. 不做

- 不改 `node_rotate_credentials` 或任何 Host 命令。
- 不改托管节点的诊断步骤与文案。
- 不新增 AI 工具。
