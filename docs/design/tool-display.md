# 对话里的过程展示：工具名 → 用户语言

> 日期：2026-11-06
> 状态：设计定稿，未实现
> 涉及：`src/components/ToolCallCard.tsx`、`src/state/chatStore.ts`、
> `src-tauri/src/tools/envelope.rs`、`src-tauri/src/claurst_session/mod.rs`、
> `docs/contracts/events.md` §3.3–3.4、`resources/prompts/zh/first-run.md`
>
> **这份文档解决什么**：真机截图里用户看到的是「RuntimeStatus 调用 RuntimeStatus 0ms 完成」
> 「ConfigList 调用 ConfigList 0ms 完成」。这不是文案不好，是**数据层把不该给用户看的东西
> 直接画出来了**。本文定义三层：工具结果里的用户文案、UI 的展示规则、模型自己的表达规则。

---

## 1. 现状：不是文案问题，是数据问题

`ToolCallCard` 默认渲染三样东西，全都不该给用户看：

| 渲染项 | 来源 | 问题 |
|---|---|---|
| `call.tool` | `tool-call-start.tool` | PascalCase 模型可见名，如 `RuntimeStatus` |
| `call.action` | 后端 `summarize(input)` | 多数工具没实现，退化为 `Using <tool>`；实现了也是面向模型的措辞 |
| `call.result` | `ToolResult.content` | **与给模型的 `summary` 是同一根字符串** |

`summarise_configs`（`src-tauri/src/tools/configs.rs:27`）末尾写着
「用户用名称指代配置时，先用本工具匹配出 config_id，不要猜 id。」——这句是给模型的指令。
把它展示给用户不是措辞不好，是事故。

结论：**换个标题治不了。面向用户的完成文案必须有独立字段。**

---

## 2. 数据层：`display { text, facts?, changed }`

### 2.1 定义

```rust
// `src-tauri/src/tools/envelope.rs`
pub struct Display {
    pub text: String,          // ≤24 字；不含 id、路径、字段名、错误码、英文
    pub facts: Vec<String>,    // ≤4 条，每条是一整行用户语言（「使用的配置：公司」）
    pub changed: Changed,      // None | Restored | Unknown
}

pub enum Changed {
    None,       // 没有任何改动
    Restored,   // 改过，但已恢复到调用前的状态
    Unknown,    // 改过，且无法确认是否恢复
}
```

- `display` 在 `ToolOutcome` 上是 **`Option`**：成功时建议给，失败时必须给 `text` 与 `changed`；
  缺失时前端回落（见 §6），不报错。
- `facts` 可为空数组，也可整体省略。
- `facts` 用整行字符串而不是 `{label, value}`：每行由后端拼好（`标签：值`），前端不做二次排版，
  避免同一行的标签在不同工具里叫法不一致。

**`changed` 三值语义**（不可混用）：

| 值 | 含义 | 界面第二行 |
|---|---|---|
| `none` | 没有改动用户的任何设置、文件或网络 | 没有改动任何设置 |
| `restored` | 改过，但已恢复到调用前的状态 | 已经恢复原样 |
| `unknown` | 改过，且无法确认是否恢复 | 不确定，诊断日志里有记录 |

**`changed` 只在失败时有意义。** 成功时界面不显示「有没有改动」这一行，工具固定填 `none`。
把它在成功时写成 `restored`（理解成「改动已生效」）是误读：`restored` 的参照点是**调用前**，
不是「期望状态」。实现里若已这样写，按本表改正。

- `ToolOutcome` 增 `display: Option<Display>`。
- 失败时 `display.text` 可与 `error.message` 不同：后者给模型，前者给用户。

### 2.2 为什么不复用 `call.result`

`tool-call-end.result` = `ToolResult.content` = `ToolOutcome.summary`。这一根字符串同时是：

- 模型在下一轮要读的上下文（含 id、字段名、甚至「不要猜 id」这类指令）；
- 诊断日志的原始记录。

一旦为了让用户看懂而改写它，模型的输入跟着变，工具行为也变。**展示层不能反向污染模型层。**
所以把「给用户的一句话」单独放进 `display`，两者各自演化。

### 2.3 契约位置

- `events.md` §3.4 `ToolCallEndPayload` 增 `display?: { text, facts, changed }`；缺失不报错。
- **不写进 `ToolEnvelope`**（`tools.md` §1.3）。信封是给模型看的，`display` 只给 UI。
- Host 投影 `tool-call-end` 时，本来就为了 `error_code` / `next_actions` 从注册表取出整个
  `ToolOutcome`（`envelope::take_outcome`），顺手带出 `display` 即可，**不新增管道、不改工具调用链**。

投影后的载荷（`events.md` §3.4）：

```ts
// 只增这一段，其余字段不变
type ToolCallEndPayload = {
  // ...原字段：request_id / tool / success / result / error_code / duration_ms / next_actions
  display?: {
    text: string;                                      // ≤24 字
    facts: string[];                                   // ≤4 条完整短句，可为空
    changed: "none" | "restored" | "unknown";
  };
};
```

- `text` 与 `changed` 必填，`facts` 可为空数组。后端漏填 `changed` 时前端按 `unknown` 处理（保守）；
  Host 不补默认值，避免把「没声明」伪装成「没改动」。
- `facts` 里的字符串已是用户语言，前端原样渲染，不做二次转义。

### 2.4 谁产出什么

| 状态 | 文案来源 | 后端改动 |
|---|---|---|
| 进行中 | 前端静态表，按工具名 | 无 |
| 完成 | `display.text`，回落到静态表的通用完成文案 | 有 |
| 失败 | `display.text`，回落到前端按 `error_code` + 工具族生成 | 有（`changed`） |
| 展开事实 | `display.facts`，缺失时只显示用时 | 有 |

---

## 3. 默认视图

一条工具调用 = 一行。没有卡片边框、没有工具名、没有「调用 / 完成」、没有 JSON。

```
○ 正在检查连接状态
✓ 已连接
! 没能连上
```

### 3.1 进行中

- **逐条出现**：只显示当前正在跑的那一条，上一条就地变完成态。
- **不预告**尚未开始的步骤——不知道后面几步就不要画进度条。
- 文案取静态表；没有条目时用「正在处理…」。

### 3.2 合并

| 情况 | 规则 |
|---|---|
| 连续成功 ≥3 条 | 合并为一行 `✓ 完成 3 步`，点击展开逐条 |
| 连续成功 1–2 条 | 不合并——合并反而多一次点击 |
| 失败 | **永不合并**，也不会被后面的成功行吞掉 |
| 需要用户回答 | `AskUserQuestion` 与升级确认不并入合并行，独立成块 |
| `AskUserQuestion` 工具行 | **完全不渲染**——提问由现有 `AskQuestionDialog` 承担，两处说同一件事是重复 |

合并只影响「已完成的连续段」，运行中的那一行始终单列在最后。

### 3.3 用时

- 默认行**只在 ≥3 秒**时显示「用时 3.2 秒」。
- 1–2 秒是噪声；3 秒起用户开始觉得卡，这时给出时间才是信息。
- 展开详情里**永远**显示精确值（即使 80 毫秒）。

### 3.4 默认视图禁止出现

工具名、`action`、JSON、错误码、`ms` 数、英文、id（`cfg_…` / `nod_…` / `job_…`）。
原始工具名**不是合法的兜底目标**，任何情况下都不画。

---

## 4. 展开详情

点这一行展开。排列按「用户会问什么」，不按返回结构：

| 顺序 | 内容 | 来源 | 缺失时 |
|---|---|---|---|
| 1 | 用了哪套配置、哪个节点（**只给名称，不给 id**） | `display.facts` 前几条 | 不显示 |
| 2 | 出口 IP、延迟（有才给） | `display.facts` | 不显示 |
| 3 | 用时 | `duration_ms` | 不显示 |
| 4 | 来源：**只在「从设置页发起」时显示** | `source === "ui"` | 对话发起不显示（默认即对话） |

- `facts` 的顺序由后端定（配置 → 节点 → 出口 → 延迟），前端按数组顺序渲染，不排序、不筛选。
- `facts` 的每条是一整行（`标签：值`），`--ink-3` 小字；不做表格、不对齐列。
- 底部一个弱化的 `技术细节` 文字按钮（`btn btn--link` 样式，12px）→ 就地展开：
  工具名、`args_preview`、`result`、`error_code`、耗时、来源通道。
- 放在这里的理由：三级用户需要，默认用户永远不会点到。**不做成设置开关**——设置项会腐烂，
  也没人记得自己开过。
- `args_preview` 与 `result` 都没有时，按钮不出现。
- 展开状态记在组件内，不持久化；重新渲染仍默认收起。

---

## 5. 失败三段式

默认行是标题（`没能连上`），展开后固定三行：

| 段 | 文案 | 来源 |
|---|---|---|
| 发生了什么 | 一句人话，不带原因链 | `display.text`，否则按 `error_code` 映射 |
| 有没有改动 | `没有改动任何设置` / `已经恢复原样` / `不确定，诊断日志里有记录` | `display.changed` |
| 现在能做什么 | **只给一个动作** | `next_actions[0].label`，否则一句通用建议 |

### 5.1 `changed` 声明表

| 工具族 | 失败时典型值 | 说明 |
|---|---|---|
| 只读 / `None` 级（`RuntimeStatus`、`RuntimeLogs`、`CoreListVersions`、`CatalogSearch`、`ConfigList`、`ConfigDetail`、`NodeProbe`、`ProxyParams`、`IssueList`、`IssueGet`、`DiagRun`、`DeepseekSetupKey`、`JobGet`、`NetConfigGet`、`DefaultProfileStatus`、`RouteGet`、`RuleCustomList`、`CategoryList`、`RulesStatus`、`AskUserQuestion`） | `none` | 可不填，Host 按 `none` 处理 |
| `VpnConnect` | `restored` 或 `none` | 启动前失败 = `none`；已改系统设置后失败 = `restored`（工具负责恢复再返回） |
| `VpnDisconnect` | `restored` 或 `none` | 断开失败时网络可能仍被接管 → 不允许填 `none` 除非确认未改 |
| `RuntimeStart` / `RuntimeStop` / `RuntimeRestart` | `none` 或 `unknown` | 进程未起来 = `none`；重启中途失败 = `unknown` |
| `ConfigCreate` / `ConfigUpdate` / `ConfigDelete` / `NodeCreate` / `NodeImportUrl` / `NodeSwitch` | `none` 或 `restored` | 校验失败 = `none`；部分写入后回滚 = `restored` |
| `RouteSetMode` / `RouteTargetsSet` / `RuleCustomAdd` / `RuleCustomDelete` / `CatalogRefresh` / `RulesUpdate` | `none` 或 `restored` | 同上 |
| `NetRepair` | `restored` 或 `unknown` | 尽力恢复；恢复不了必须 `unknown`，界面给诊断入口 |
| `CoreUpgrade` | `none` | 未安装即未改动；临时文件由启动清理，不算改动 |
| `DeepseekSaveKey` | `none` 或 `unknown` | 写入失败但无法确认落盘 = `unknown` |

规则：

- `permission_level` 为 `write` / `execute` 的工具，**失败时必须声明 `changed`**；
  未声明按 `unknown` 处理（保守），界面显示「不确定，诊断日志里有记录」。
- 只读工具缺省 `none`，界面显示「没有改动任何设置」。

**为什么三句话要泛化到所有工具**：`changed` 是一套统一渲染契约，界面不按工具分别写文案。
`ConfigCreate`、`ConfigDelete` 失败时根本不碰网络设置，第二行若写「没有改动你现在的网络设置」，
对它们就是假话。所以这三句只回答「有没有改动」本身；改了什么由第一行（发生了什么）负责。
不要为某个工具把这句话改具体。
- 第二行**不允许写「可能」**。要么 `none`，要么 `restored`，要么 `unknown`。

### 5.2 禁止

错误码、英文原文、堆栈、JSON、字段名、`重装`（除非文件校验失败）。
错误码只进诊断日志，复用现有「复制诊断信息」入口。

---

## 6. 兜底与集合断言

### 6.1 兜底文案

| 状态 | 未映射时 |
|---|---|
| 进行中 | `正在处理…` |
| 完成 | `已完成` |
| 失败 | `没成功` |

- **永远不渲染 `call.tool` 与 `call.action`**。
- 开发构建遇到未映射工具时 `console.warn` 一次，带工具名（仅开发构建）。

### 6.2 集合相等断言

`docs/contracts/tools.md` §3 的 44 个模型可见名，与前端 `toolDisplay.ts` 的映射表做
**集合相等**断言（双向：映射表不能多、不能少），缺一个测试就红。

这是唯一能保证「下次新增工具不再冒出 `FooBar 调用`」的机制。只靠兜底文案会退化成
「已完成」，用户不知道发生了什么；只有集合断言会逼着新增工具的人补一行。

建议测试形态：从 Rust 侧导出一份 44 个名字的列表（或直接在 TS 里抄一份并加注释指向 tools.md），
断言 `new Set(names)` 与 `new Set(Object.keys(TOOL_DISPLAY))` 相等。

---

## 7. 与现有规范一致

- 不出现 `proxy` / `TUN` / `分流` / `规则集`（`veyl-ui` §「界面里不出现这四个词」）。
  说「直连」「全部软件自动走 VPN」「后台运行库」「新版本」。
- 运行库沿用既有用户词「后台运行库」（`AskQuestionDialog.tsx:127` 已在用），不新造「连接组件」。
- **同一事实只有一个住处**：连接状态、出口、实时速率、延迟的**实时**展示归中间控制台；
  对话里的行只记「这一步做了什么」和当时的结论，不做会自己变的实时控件。
  出口 IP 只在展开详情出现，不在默认行重复。
- 完成文案只回答「做了什么」，不复述控制台的常驻字段；`RuntimeStatus` 给结论，
  不把出口地区、延迟、流量一并搬进对话。

---

## 8. 提示词与工具描述的表达规则

UI 卡片是最后一层。模型正文、`ai-status` 文案、工具 description 都会把内部词带到用户面前，
必须一起约束。

### 8.1 三个落点

| 落点 | 文件 | 管什么 |
|---|---|---|
| 系统提示正文 | `resources/prompts/zh/first-run.md` 新增「怎么说话」 | 全部规则（风格规则归这里，不塞进安全底线） |
| 安全底线 | `src-tauri/src/claurst_session/mod.rs` 的 `SAFETY_RULES` | 两句底线，不重复全文 |
| 工具 description | 各 `src-tauri/src/tools/*.rs` 的 `description()` | 只补该工具「结果怎么说、失败改没改」 |

机制事实：`capability_catalog`（`claurst_session/mod.rs:52`）只取 description 的**第一行**
进系统提示清单，完整 description 作为工具 schema 交给模型。所以「对用户说…」这句放 description
**末尾**：不污染能力清单，但模型调工具时一定看得到。

### 8.2 系统提示新增段（可直接粘贴）

```markdown
# 怎么说话

你说话的对象是用户，不是工程师。系统、工具、字段、日志是给你看的。

1. 只说结果和影响。说「已经连上了，浏览器会走这条线路」，不说「mixed 入站已监听」「代理已写入」。
2. 这些词和写法不出现在正文里：proxy、TUN、分流、规则集、selector、入站、出站、runtime、
   sing-box、节点 ID、配置 ID（`cfg_…`、`nod_…`）、字段名、错误码。
3. 不叙述你在调用什么。写「我先看一下现在的连接状态」，不写「我调用 RuntimeStatus」「RuntimeStatus 返回 ok」。
4. 长流程按阶段说，一个阶段一句：「正在检查网络」→「正在准备后台组件」→「已连接」。
   不要每一步都报，也不要提前报还没发生的阶段。
5. 失败固定三句：发生了什么（用户语言）→ 有没有改动（「没有改动任何设置」）→
   现在可以做什么（一个明确动作）。不知道有没有改动，就说「不确定，诊断日志里有记录」。
6. 需要技术细节时只说「技术细节在诊断日志里」，并告诉用户在哪里复制；不贴字段名、错误码、原始返回。
7. 不重复界面上已经显示的内容（状态、出口、流量、卡片里的数字）。界面负责实时状态，你负责解释下一步。
8. 只有用户主动问技术问题时才用术语；第一次出现时紧跟一句白话解释。
```

### 8.3 `SAFETY_RULES` 追加两条

```text
8. 面向用户的正文不出现工具名、字段名、错误码、节点/配置 ID 与内部名词；
   需要细节时说「技术细节在诊断日志里」。
9. 失败时说明有没有改动；不确定就说不确定，不要用「可能」蒙混。
```

### 8.4 工具 description 追加

只列需要改的，其余工具走系统提示的通用规则：

| 工具 | description 末尾追加 |
|---|---|
| `VpnConnect` | 对用户只说「已经连上了」；不提代理端口、入站、selector、路由表。失败时说明系统网络设置是否已恢复原样。 |
| `VpnDisconnect` | 说「已经断开，网络恢复直连」。 |
| `RuntimeStatus` / `RuntimeStart` / `RuntimeStop` / `RuntimeRestart` | 一律说「后台组件」，不出现 runtime、sing-box、进程名。 |
| `CoreUpgrade` | 说「新版本」「下次连接生效」，不出现清单、sha256、URL。 |
| `NodeSwitch` | 说节点名称，不说节点 ID。 |
| `ConfigList` / `ConfigDetail` / `ConfigCreate` / `ConfigUpdate` / `ConfigDelete` | 配置 ID 只用于你自己匹配，不要念给用户；用户用名称指代配置。 |
| `NodeProbe` | 说「能连上 / 连不上」和毫秒数，不说 TCP/TLS/握手。 |
| `DiagRun` / `ProbeRun` / `NetConfigGet` / `NetRepair` | 说检查结果；不出现 DNS 地址列表、路由表、字段名。`NetRepair` 失败必须说明是否已恢复。 |
| `RouteGet` / `RouteSetMode` / `RouteTargetsSet` | 说「哪些软件走 VPN」「直连」，不出现分流、规则集、rule、category id。 |
| `RuleCustomList` / `RuleCustomAdd` / `RuleCustomDelete` / `CategoryList` / `RulesStatus` / `RulesUpdate` | 用「直连名单」「分类」；不出现 rule id、分类 id、数据版本号。 |
| `IssueList` / `IssueGet` / `IssueHandoff` / `IssueResolve` / `IssueIgnore` | 说「问题」；不出现 issue id、状态机字段。 |
| `JobGet` | 说「进度」和阶段白话名；不出现 job id、stage 字段名。 |
| `DeepseekSaveKey` | 不复述密钥，不说保存路径。 |
| `AskUserQuestion` | 问题与选项是给人看的，不写工具名、字段名、配置 ID。 |

### 8.5 边界

- 提示词是**降低概率**，不是闸门。唯一的结构性闸门是 §3–§6 的渲染规则：
  模型说错话最多多一句废话，UI 永远不会把工具名、JSON、错误码画出来。
- **不做输出正则改写**：静默替换模型正文（例如抹掉 `cfg_` 开头的串）比漏一句更难排查，
  还会误伤用户自己粘贴的文本。要拦就拦在渲染层。

### 8.6 顺手要修的现有泄漏（与模型无关）

| 位置 | 现状 | 应改为 |
|---|---|---|
| `claurst_session/mod.rs:331` | `format!("{tool_name} 正在运行")` | 映射表的「进行中」文案，查不到用「正在处理…」 |
| `src/state/chatStore.ts:426` | `正在执行 ${tool}` | 同上 |

这两处在模型不说话的时候也会露出 `RuntimeStatus`，属于同一类问题。

---

## 9. 工具映射表

`AskUserQuestion` 不渲染工具行——提问由现有 `AskQuestionDialog` 承担，两处说同一件事是重复。

| # | 工具 | 进行中 | 完成 | 失败要点 | 失败时 `changed` |
|---|---|---|---|---|---|
| 1 | `RuntimeStatus` | 正在检查连接状态 | 还没连接 / 已经连上 | 读不到状态，什么都没改 | `none` |
| 2 | `RuntimeStart` | 正在启动后台运行库 | 后台运行库已启动 | 没启动起来，连接未建立 | `none`（起来一半用 `unknown`） |
| 3 | `RuntimeStop` | 正在停止后台运行库 | 后台运行库已停止 | 没停下来，可以再试一次 | `none` / `unknown` |
| 4 | `RuntimeRestart` | 正在重启后台运行库 | 后台运行库已重启 | 没重启成功，连接可能已断开 | `unknown` |
| 5 | `RuntimeLogs` | 正在取运行记录 | 已取到运行记录 | 记录取不到，不影响使用 | `none` |
| 6 | `CoreListVersions` | 正在查看运行库版本 | 运行库 1.15.0（随包 1.14.4） | 版本读不到 | `none` |
| 7 | `CoreUpgrade` | 正在看有没有新版本 | 已是最新版本 / 已安装 1.15.0，下次连接生效 | 什么都没装，现在还是旧版本 | `none` |
| 8 | `CatalogSearch` | 正在找可用节点 | 找到 12 个节点 | 没找到，可能是网络问题 | `none` |
| 9 | `ConfigList` | 正在看你的配置 | 你有 2 套配置 / 还没有配置 | 配置读不到 | `none` |
| 10 | `ConfigDetail` | 正在看这套配置 | 「公司」有 8 个节点，当前 东京 01 | 这套配置打不开 | `none` |
| 11 | `ConfigCreate` | 正在新建配置 | 已新建「公司」 | 没建成：同名或信息不全 | `none` / `restored` |
| 12 | `ConfigUpdate` | 正在修改配置 | 已更新「公司」 | 没改成，原设置不变 | `none` / `restored` |
| 13 | `ConfigDelete` | 正在删除配置 | 已删除「公司」 | 没删：这套正在使用 | `none` / `restored` |
| 14 | `NodeImportUrl` | 正在从订阅导入节点 | 导入 23 个节点（跳过 2 个） | 地址拿不到 / 内容解析不了 | `none` / `restored` |
| 15 | `NodeCreate` | 正在添加节点 | 已添加「洛杉矶」 | 没添上，检查地址和端口 | `none` / `restored` |
| 16 | `NodeSwitch` | 正在切换节点 | 已切到「东京 01」，下次连接生效 | 没切成功，还在原来节点 | `none` / `restored` |
| 17 | `NodeProbe` | 正在测试这个节点 | 能连上（38 毫秒） | 连不上：超时或被拒绝 | `none` |
| 18 | `VpnConnect` | 正在连接 | 已连接 | 没连上（+ 有没有改动） | `none` / `restored` |
| 19 | `VpnDisconnect` | 正在断开 | 已断开，已恢复直连 | 没断开，仍在连接 | `none` / `restored` |
| 20 | `ProxyParams` | 正在读本机代理设置 | 本机代理 127.0.0.1:7890 | 读不到，不影响连接 | `none` |
| 21 | `ProbeRun` | 正在检查连接质量 | 四项都通过 / 有 2 项没通过，已记录 | 检查没跑完，已记录 | `none` |
| 22 | `IssueList` | 正在看问题记录 | 有 2 个还没解决的问题 | 记录读不到 | `none` |
| 23 | `IssueGet` | 正在看这条问题 | 已拿到这条问题的信息 | 这条问题找不到 | `none` |
| 24 | `IssueHandoff` | 正在接手这个问题 | 已接过来，我们继续 | 没接上，可以再试一次 | `none` |
| 25 | `IssueResolve` | 正在复查 | 复查通过，已标记解决 | 复查没通过，先不标记 | `none` |
| 26 | `IssueIgnore` | 正在忽略这条问题 | 已忽略，以后可以恢复 | 没改成功 | `none` |
| 27 | `DiagRun` | 正在做诊断 | 诊断完成：3 项正常，1 项要处理 | 诊断没跑完 | `none` |
| 28 | `DeepseekSetupKey` | 正在准备开通步骤 | 开通步骤已给出 | — | `none` |
| 29 | `DeepseekSaveKey` | 正在保存密钥 | 密钥已保存（只在本机） | 没保存：密钥无效或写入失败 | `none` / `unknown` |
| 30 | `JobGet` | 正在查任务进度 | 任务 60%（正在下载）/ 任务已完成 | 任务找不到 | `none` |
| 31 | `AskUserQuestion` | 不显示工具行 | — | — | `none` |
| 32 | `NetConfigGet` | 正在检查系统网络设置 | 设置正常 / 发现 2 处异常 | 读不到系统设置 | `none` |
| 33 | `NetRepair` | 正在恢复网络 | 网络已恢复 | 没恢复，可以再试一次（+ 有没有改动） | `restored` / `unknown` |
| 34 | `CatalogRefresh` | 正在更新默认节点包 | 已更新，新增 30 个节点 | 没更新成功，原来的还在 | `none` / `restored` |
| 35 | `DefaultProfileStatus` | 正在看内置配置状态 | 内置配置是最新的 | 状态读不到 | `none` |
| 36 | `RouteGet` | 正在看哪些软件走 VPN | 全部软件自动走 VPN / 部分网站直连 | 读不到 | `none` |
| 37 | `RouteSetMode` | 正在切换走法 | 已切换：全部软件自动走 VPN（已生效） | 没切成，还是原来的走法 | `none` / `restored` |
| 38 | `RouteTargetsSet` | 正在调整直连范围 | 已更新：3 个服务直连 | 没改成功 | `none` / `restored` |
| 39 | `RuleCustomList` | 正在看自定义直连 | 有 3 条自定义直连 | 读不到 | `none` |
| 40 | `RuleCustomAdd` | 正在添加一条直连 | 已添加：example.com 直连 | 没添上：已存在或格式不对 | `none` / `restored` |
| 41 | `RuleCustomDelete` | 正在删除一条直连 | 已删除：example.com | 没删掉：这条不存在 | `none` / `restored` |
| 42 | `CategoryList` | 正在看服务分类 | 拿到 18 个分类 | 分类读不到 | `none` |
| 43 | `RulesStatus` | 正在检查直连数据 | 直连数据是 3 天前的，可以更新 | 状态读不到 | `none` |
| 44 | `RulesUpdate` | 正在更新直连数据 | 已更新，下次连接生效 / 已排队，连接后自动更新 | 没更新成功，旧数据继续用 | `none` / `restored` |

> `changed` 列给的是**失败路径的典型值**；同一工具可能因失败阶段不同取不同值（例如 `VpnConnect`
> 在校验阶段失败是 `none`，改过系统设置后又撤回是 `restored`）。工具必须按实际执行到哪一步声明。

> 表里的数字（2 套、12 个、38 毫秒、60%）是**格式示例**。实际值来自 `display.text` 或 `data`；
> 前端静态表只提供不带数据的通用文案（如「已查看你的配置」），数据版由后端 `display` 提供。

**为什么静态表还要留通用文案**：`display` 缺失（旧后端、未改的工具、失败回退）时，
进行中文案仍必须是人话。静态表是地板，`display` 是天花板。

---

## 10. 实现清单

顺序按依赖排，前两步可以并行。

| # | 文件 | 改动 |
|---|---|---|
| 1 | `src-tauri/src/tools/envelope.rs`（或 `tools/display.rs`） | `Display` / `Changed` 定义；`ToolOutcome` 增 `display`；`take_outcome` 已可用，无需改 |
| 2 | `src-tauri/src/tools/*.rs` | 各工具在成功/失败分支填 `display`；优先改 §9 表里用户最常问的 15 个，其余可分批 |
| 3 | `src-tauri/src/claurst_session/mod.rs` | `tool-call-end` 投影增 `display`（取值处已持有 `ToolOutcome`）；`ai-status` 的 running 文案改为映射表 |
| 4 | `docs/contracts/events.md` §3.4 | `ToolCallEndPayload` 增 `display`，写明「缺失不报错」 |
| 5 | `src/state/chatStore.ts` | `ToolCall` 增 `display?`；`toolCallEnd` 分支赋值；`status.text` 不再拼工具名 |
| 6 | `src/components/toolDisplay.ts`（新） | 44 条静态表 + 兜底 + 导出名字集合用于断言 |
| 7 | `src/components/ToolCallCard.tsx` | 重写为一行式；合并、用时阈值、展开详情、技术细节入口、失败三段式 |
| 8 | `resources/prompts/zh/first-run.md` | 新增「怎么说话」一节（§8.2） |
| 9 | `src-tauri/src/claurst_session/mod.rs` | `SAFETY_RULES` 追加第 8、9 条（§8.3） |
| 10 | 各工具 `description()` | 按 §8.4 追加一句（可与第 2 步同一批做） |
| 11 | 测试 | 见 §11 |

不做的事：

- 不改 `ToolEnvelope`（模型侧契约）；
- 不改 `summarize` / `summary` 的措辞——那是模型输入；
- 不做模型输出的正则改写；
- 不为「技术细节」加设置开关。

---

## 11. 测试清单

| # | 场景 | 期望 |
|---|---|---|
| 1 | 未映射的工具 | 显示「正在处理… / 已完成 / 没成功」，**不出现原始工具名** |
| 2 | 集合断言 | 44 个工具名与 `TOOL_DISPLAY` 键集合双向相等 |
| 3 | 连续 3 次成功 | 合并为「完成 3 步」，展开可见逐条 |
| 4 | 连续 2 次成功 | 不合并 |
| 5 | 中间夹一次失败 | 失败单独一行，前后成功段各自合并 |
| 6 | 工具耗时 900ms | 默认行不显示用时；展开显示 `900ms` |
| 7 | 工具耗时 4.2s | 默认行显示「用时 4.2 秒」 |
| 8 | `VpnConnect` 失败且 `changed = restored` | 第二行「已经恢复原样」 |
| 9 | 写类工具失败但未声明 `changed` | 第二行「不确定，诊断日志里有记录」 |
| 10 | 只读工具失败 | 第二行「没有改动任何设置」 |
| 11 | `display` 缺失、静态表有该工具 | 用静态表通用文案，不报错 |
| 12 | `display.facts` 为空 | 展开只有用时；「技术细节」按钮按 `args_preview`/`result` 有无决定 |
| 13 | `AskUserQuestion` | 不出现工具行，只有提问浮层 |
| 14 | `ai-status` running_tool | 文案不等于 `"{tool} 正在运行"`，不出现英文工具名 |
| 15 | 提示词渲染 | 「怎么说话」存在且含禁词表与失败三段式；`SAFETY_RULES` 含第 8、9 条 |
| 16 | description 快照 | §8.4 表内工具的描述包含表达约束；新增 `write`/`execute` 工具缺这句则失败 |
