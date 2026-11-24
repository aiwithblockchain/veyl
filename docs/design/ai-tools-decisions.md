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
| `RouteTargetsSet` | 是（`vpn_tools()` 注册；改动前在 `tools/mod.rs:183`） | `route_targets_set` | 否 | 产品已无「按服务分流」入口 |
| `CategoryList` | 是（`vpn_tools()` 注册；改动前在 `tools/mod.rs:184`） | `category_list` | **是**（`src/agent/tauriBridge.ts:1444`，`bridge.ts:107` 的分类 id 来源） | 分类仍被节点卡片使用 |
| `RulesStatus` | 是（`vpn_tools()` 注册；改动前在 `tools/mod.rs:185`） | `rules_status` | 否 | 规则集状态只给模型看 |

### 1.2 决定

1. **删 `RouteTargetsSet`、`CategoryList`、`RulesStatus` 三个 AI 工具**。
2. **保留 `category_list` / `route_targets_set` / `rules_status` 三条 Host 命令**——它们是 UI 通道，不属于工具面。删工具的 PR 里不得顺手删命令。
3. **`ConfigUpdate` 的 `targets` 参数一并删除**：它是「按分类设置分流目标」的写入口，没有分类选择就没有意义；保留会让模型写进一个不会生效的字段。

### 1.3 连带改动（同批，不可拆）

- `tools.md`：§3 清单减三项、§4 对应小节改为「已删除（3.27.0）」、版本升 3.27.0、变更表加一行。
- `tool-display.md`：工具数不再写死，三处引用同步。
- `TOOL_COPY`（`src/components/toolDisplay.ts`）：删三条文案；`toolDisplay.test.ts` 的 `arrayContaining` 断言不涉及这三项，无需改。
- 提示词：`docs/prompt-design.md` 里 `update_hint` 一栏提到 `RulesStatus`，改为「规则/种子有新版本」的说明，不点名工具。
- 运行期提示词：`resources/prompts/zh/product.md` 的「写分类前先查分类列表」改为事实——「分流只有智能 / 全局两档，没有按服务挑选」；英文版本来就写「Only these two — there is no per-service selection」，无需改。
- 契约自检：`commands.md` §10.3 / §10.7 / §10.8 的「命令 → 工具」映射行标注为「无 AI 工具」。

### 1.4 验收

- 工具数 43 → 40：本批**人工核对** `tools.md` §3 / §3.1 与 `vpn_tools()` 各为 40、名字逐条相同。**自动断言尚未建立**——`toolDisplay.test.ts` 只比对 `tools.md` 与 TS 的 `TOOL_COPY`，不读 Rust 注册表；Rust 侧目前只有 `tools.len() >= 20`。契约与注册表的自动一致性检查列入阶段 1 待补。
- 界面仍能正常显示分类（`category_list` 命令未动）。
- 提示词：中文 `resources/prompts/zh/product.md` 原有一句「先用分类列表取到合法分类名」，本批改为「分流只有智能 / 全局两档，没有按服务挑选」；英文 `resources/prompts/en/product.md` 本来就写「Only these two — there is no per-service selection」，无需改。删掉的三个工具名不再出现在提示词里。

---

### 1.5 落地记录（2026-11-24，本批）

本批只改文档，代码（`src-tauri/src/tools/*`、`src/components/toolDisplay.*`）由并行会话负责。契约落到 **3.27.0 / 40 个**工具。

| 文件 | 改动 |
|---|---|
| `docs/contracts/tools.md` | 版本 3.27.0、状态改「部分落地」；§3 / §3.1 按 43 − 3 = **40** 重写（恢复 `NodeImportUrl` / `NodeImportText` / `NodeCreate` 三条独立工具与 `CatalogOptions` 原名）；§4.38 / §4.42 / §4.43 为「已删除（3.27.0）」；§4.25 `ConfigUpdate` 入参无 `targets`；变更表写明本版只落第 2 条，合并 / 改名 / 新增标为后续批次 |
| `docs/design/tool-display.md` | 工具数 43 → **40**，映射表改为当前批次 40 行；合并 / 改名 / 新增标为后续批次 |
| `docs/contracts/commands.md` | §10.3 / §10.7 / §10.8 标注「命令保留，3.27.0 起无 AI 工具」；§12.1 能力映射与 §13 命令 → 工具映射同步；§9.8 的 44 → 40；版本升 `2.65.0` 并补 §16 变更记录，§15.5 矩阵同步 `tools.md` 3.27.0 |
| `resources/prompts/zh/product.md` | 删掉「先用分类列表」一句，改为「分流只有智能 / 全局两档，没有按服务挑选」；英文版无此句 |
| `docs/prompt-design.md` | `update_hint` 的数据来源改为「Host 注入的规则数据与种子版本状态」，不再点名 `RulesStatus` |
| `docs/design/ai-tools-decisions.md` | 本记录 |

---

## 2. 第 3 组：节点写入路径（2026-11-24）

### 2.1 事实

| 工具 | 入参 | 做什么 | 权限 |
|---|---|---|---|
| `NodeImportUrl` | `url`（必填）、`config_id?` | 拉 HTTPS 订阅，解析 base64 的 `ss://` 列表，逐条进节点池 | Write |
| `NodeImportText` | `text`（必填，≤64 KiB）、`config_id?` | 解析用户粘贴的 `ss://` 分享链接，坏行跳过 | Write |
| `NodeCreate` | `name` / `server` / `port` / `method` / `password` 必填，`config_id?` | 手动建一个节点 | Write |

三个都是「往节点池里写节点」，差别只在**节点从哪来**。中英文 `resources/prompts/*/kickoff.md:79-81` 点名了这三个工具，`:121` 也列了一次——合并必须同批改提示词，否则模型调到不存在的工具。

### 2.2 决定

**三条合成一个 `NodeImport`，用 `source` 区分来源**：

| `source` | 该带哪个字段 | 说明 |
|---|---|---|
| `url` | `url` | 订阅地址 |
| `text` | `text` | 粘贴的 `ss://` 链接，可多行 |
| `manual` | `name` / `server` / `port` / `method` / `password` | 逐项填写 |

- 公共可选 `config_id`；不传只进节点池（与现在一致）。
- schema 里只有 `source` 必填，其余按来源在 `execute` 里校验，缺字段回 `INVALID_ARGUMENT` 并指明缺哪个——JSON Schema 表达不了条件必填，写进 description 并在代码里兜住。
- 权限沿用 `Write`。
- **三条 Host 命令保留**（`node_import_url` / `node_import_text` / `node_create`），界面仍在调（`src/agent/tauriBridge.ts:1369/1407/1416`）。

### 2.3 连带改动

- 中英文 `kickoff.md`：`:79-81` 三行合成一行（按来源给 `source` 取值），`:121` 的工具名一起换。
- `tools.md`：§3 40 → **38**，版本 **3.28.0**；§4 三个小节合并为一节，旧小节标「已合并（3.28.0）」。
- `tool-display.md`、`TOOL_COPY`（三条文案 → 一条）、`toolDisplay.test.ts`。
- `commands.md`：命令 → 工具映射改指 `NodeImport`，命令本身不动；按文件惯例升版本并加变更记录。
- 描述与文案要写清「只解析、不连接、返回值不含密码」，与现在三条的措辞保持一致。

### 2.4 验收

- 工具数 40 → 38；`tools.md` §3 与 `TOOL_COPY` 逐名相等（自动）。
- 三种来源各有一条正常导入用例；缺字段报 `INVALID_ARGUMENT` 并指明缺哪个字段；另有代码侧本轮补的用例覆盖 `config_id` 透传与未知 `source` 拒绝。`additionalProperties` 由 schema 保证，当前**没有**单独发多余字段的用例。
- `grep -rn "NodeImportUrl\|NodeImportText\|NodeCreate" resources/prompts/` 为空。

---

## 3. 后续批次（未开始）

第 4、5 组各自单独出决策单。
