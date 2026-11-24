# AI 工具：阶段 0 决策单（分组进行）

> 日期：2026-11-24
> 范围：只记录**已拍板的去留决定**与连带改动；不写实现细节。
> 依据：`docs/design/ai-tools-inventory.md` §3 / §5 / §7；`docs/contracts/tools.md` 3.27.0 提案。
> 做法：一组一批，做完再开下一组。

---

## 0. 一条贯穿规则：契约按批升小版本

`tools.md` 3.27.0 提案把「删三个工具 + 合并节点导入 + 改名 + 新增两个」写成一个 41 的终态。
分组推进时这是做不到的：每批只落一部分，工具数就会停在中间值。

**因此：契约按批升小版本，不再为了对齐提案的 41 而一次改完。**

| 批次 | 变化 | 工具数 | 契约版本 |
|---|---|---|---|
| 基线 | — | 43 | 3.26.0 |
| 第 2 组 | 删 `RouteTargetsSet` / `CategoryList` / `RulesStatus` | 40 | 3.27.0 |
| 第 3 组 | 节点写入三工具合并为 `NodeImport` | 38 | 3.28.0 |
| 第 4 组 | UI 状态类工具去留 | 待定 | 3.29.0 |
| 第 5 组 | 补缺口（余额 / 试用 / 服务商等） | 待定 | 3.30.0 |

`tool-display.md` 里那句「工具集合为 41 个」不成立，改为「随批更新」，数字以 `tools.md` 为准。

---

## 1. 第 2 组：分流旧能力

### 1.1 事实

| 工具 | AI 工具注册 | Host 命令 | 界面是否还在调 | 产品现状 |
|---|---|---|---|---|
| `RouteTargetsSet` | 是（`tools/mod.rs:183`） | `route_targets_set` | 否 | 产品已无「按服务分流」入口 |
| `CategoryList` | 是（`tools/mod.rs:184`） | `category_list` | **是**（`src/agent/tauriBridge.ts:1444`，`bridge.ts:107` 的分类 id 来源） | 分类仍被节点卡片使用 |
| `RulesStatus` | 是（`tools/mod.rs:185`） | `rules_status` | 否 | 规则集状态只给模型看 |

### 1.2 决定

1. **删 `RouteTargetsSet`、`CategoryList`、`RulesStatus` 三个 AI 工具**。
2. **保留 `category_list` / `route_targets_set` / `rules_status` 三条 Host 命令**——它们是 UI 通道，不属于工具面。删工具的 PR 里不得顺手删命令。
3. **`ConfigUpdate` 的 `targets` 参数一并删除**：它是「按分类设置分流目标」的写入口，没有分类选择就没有意义；保留会让模型写进一个不会生效的字段。

### 1.3 连带改动（同批，不可拆）

- `tools.md`：§3 清单减三项、§4 对应小节改为「已删除（3.27.0）」、版本升 3.27.0、变更表加一行。
- `tool-display.md`：工具数不再写死，三处引用同步。
- `TOOL_COPY`（`src/components/toolDisplay.ts`）：删三条文案；`toolDisplay.test.ts` 的 `arrayContaining` 断言不涉及这三项，无需改。
- 提示词：`docs/prompt-design.md` 里 `update_hint` 一栏提到 `RulesStatus`，改为「规则/种子有新版本」的说明，不点名工具。
- 契约自检：`commands.md` §10.3 / §10.7 / §10.8 的「命令 → 工具」映射行标注为「无 AI 工具」。

### 1.4 验收

- 工具数 43 → 40，`tools.md` §3 与 `vpn_tools()` 逐条对上（`toolDisplay.test.ts` 的严格比对会兜住）。
- 界面仍能正常显示分类（`category_list` 命令未动）。
- 模型侧：删掉的三个工具不再出现在任何提示词点名里（当前提示词未点名，无需改）。

---

### 1.5 落地记录（2026-11-24，本批）

本批只改文档，代码（`src-tauri/src/tools/*`、`src/components/toolDisplay.*`）由并行会话负责。契约落到 **3.27.0 / 40 个**工具。

| 文件 | 改动 |
|---|---|
| `docs/contracts/tools.md` | 版本 3.27.0、状态改「部分落地」；§3 / §3.1 按 43 − 3 = **40** 重写（恢复 `NodeImportUrl` / `NodeImportText` / `NodeCreate` 三条独立工具与 `CatalogOptions` 原名）；§4.38 / §4.42 / §4.43 为「已删除（3.27.0）」；§4.25 `ConfigUpdate` 入参无 `targets`；变更表写明本版只落第 2 条，合并 / 改名 / 新增标为后续批次 |
| `docs/design/tool-display.md` | 工具数 43 → **40**，映射表改为当前批次 40 行；合并 / 改名 / 新增标为后续批次 |
| `docs/contracts/commands.md` | §10.3 / §10.7 / §10.8 标注「命令保留，3.27.0 起无 AI 工具」；§12.1 能力映射与 §13 命令 → 工具映射同步；§9.8 的 44 → 40 |
| `docs/prompt-design.md` | `update_hint` 的数据来源改为「Host 注入的规则数据与种子版本状态」，不再点名 `RulesStatus` |
| `docs/design/ai-tools-decisions.md` | 本记录 |

---

## 2. 后续批次（未开始）

第 3、4、5 组各自单独出决策单，不预先写死。
