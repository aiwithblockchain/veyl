# 界面重构方案（P1.5 UI Rework）

> 日期：2026-11-03
> 规范来源：`.claude/skills/veyl-ui/SKILL.md`（硬规则）+ `.claude/skills/frontend-design/SKILL.md`（方法）
> 本文是给实现者的改造清单：**先读那两份 skill，再按本文逐项改**。
> 底层命令与数据已经就绪，本次不新增、不修改任何 Tauri 命令与契约。

---

## 0. 现状问题（实测）

| # | 问题 | 证据 |
|---|---|---|
| 1 | **同一个主按钮出现两处** | `ConsoleView.tsx:151` 与 `StatusPanel.tsx:151` 同时渲染「连接」实心按钮 |
| 2 | **数据重复** | 出口 IP / 直连 IP / 时长 在 `ConsoleView.tsx:196-210` 和 `StatusPanel.tsx:197-214` 各显示一遍 |
| 3 | **右栏 9 个区块堆叠** | 状态头、主按钮、节点、4 项数据、健康 3 项、4 项数据、提示、最近错误、详情折叠 |
| 4 | **主区有三层横幅** | topbar 胶囊 + notice-bar + setup-bar 同时可能显示 |
| 5 | **控制台底部三个入口像按钮条** | `ConsoleView.tsx:347-366` 的诊断/恢复/导入与主按钮抢权重 |
| 6 | **诊断结果内联展开在主区** | `ConsoleView.tsx:227-318`，把控制台撑成一张长报告 |
| 7 | **首次引导顺序反了** | 先要求 DeepSeek Key，再谈配置；用户是来用网络的 |

---

## 1. 目标结构

三栏固定：`侧栏 232px | 主区 1fr | 右栏 288px`，右栏可收起，主区 < 720px 时右栏自动变浮层。

**同一屏幕只有一个实心主按钮**，位置随视图切换：

| 主区 | 主按钮位置 | 另一个位置渲染什么 |
|---|---|---|
| 控制台（总览） | 主区 | 右栏只显示状态，不渲染按钮 |
| 对话 | 右栏 | 对话区不渲染任何连接按钮 |
| 首次引导 | 引导页 | 主界面不渲染 |

---

## 2. 组件改造清单

### 2.1 `src/styles/app.css` — 重建 token 与样式

- 替换 `:root` 全部颜色变量为 skill §2.1 的值。
- 新增 `--r-sm: 8px` / `--r-lg: 14px`，删除散落各处的 `border-radius` 裸值。
- 新增 `.num` 工具类（mono + `font-variant-numeric: tabular-nums`），套在所有 IP/端口/时长/PID/版本上。
- 删除不再使用的区块 CSS（诊断内联、旧 status rows、旧 console facts 等），不留死样式。
- 保留现有 `notice-bar`、`modal`、`markdown`、`composer` 的骨架，只换 token 与间距。

### 2.2 `src/ui/status.ts`（新建）

把现在分散在 `ConsoleView`、`StatusPanel`、`App.tsx:796` 的状态文案与颜色映射集中到一处：

```ts
export type LinkState = "idle" | "connecting" | "connected" | "failed";
export function toLinkState(state: RuntimeView["state"]): LinkState
export function statusSentence(link: LinkState, nodeName: string | null): string
export function statusTone(link: LinkState): "ok" | "warn" | "err" | "muted"
```

`connected` 与 `degraded` 都映射到 `connected`，但 `degraded` 的 tone 为 `warn`，句子为 `连接异常 · {节点}`。

### 2.3 `src/components/Sidebar.tsx` — 收敛

- 品牌区：只留 `Veyl` 小字标记（logo 图缩到 18px 或改用文字），高度压到 48px。
- 顺序固定：`总览` → `新建对话`（改为图标 + 文字的轻量行，不再是强调按钮）→ `对话` 分组 → 底部 `设置`。
- 删除底部的 `MOCK 事件源 / 已连接 Host` 徽标 —— 这是给开发者看的，移到设置页「关于」。
- 会话行的删除按钮保持悬停出现，样式改为 `--ink-3`，不抢眼。
- 折叠状态沿用现有 `localStorage` 键。

### 2.4 `src/components/StatusPanel.tsx` — 重写（本次重点）

新的区块顺序，**只有 6 块**：

1. **状态头**：状态点 + 一句话（`已连接 · 东京 01`）+ 一行副文案（`出口 203.0.113.7`）。
2. **线路图**：签名元素，按 skill §2.4 实现四种状态。用纯 CSS/inline SVG，不引第三方库。
3. **主按钮**：只在 `view === "chat"` 时渲染。状态机与现有 `actionLabel` 逻辑一致。
4. **节点行**：一行 `节点  东京 01 ⌄`，点击展开 `ProfileList`。无节点时这一行变成 `还没有节点 · 去添加`。
5. **三个事实**：`出口` / `时长` / `延迟`，横向三列，值用 `.num`。无连接时整块灰掉显示 `—`。
6. **详情折叠**：`详情 ⌄` → 本地端口、系统代理、连接数、版本、PID、配置哈希、打开日志。

**删除**：健康三项列表（合并进状态头的 tone）、`最近错误` 独立区块（并入状态头副文案，失败时显示）、
`删除配置` 按钮（移到详情里）、`提示` 区块（删除结果改用顶部 notice）。

新增 props：`compact?: boolean`（浮层模式）、`showPrimary: boolean`。

### 2.5 `src/components/ConsoleView.tsx` — 重写（本次重点）

结构压到 5 段：

```
状态标题（28px）
一行说明（13px）
[主按钮] [次按钮]
建议问题（最多 3 条，仅在需要时）
──────────────────
默认配置 vX · N 个节点 · 检查更新
```

- **删除** `console__facts`（出口/直连/时长）—— 归右栏。
- **删除** 内联诊断区块 —— 改为 `DiagnosisSheet` 浮层组件（见 2.6）。
- **删除** 底部三个入口按钮条 —— 「诊断网络」「导入配置」降级为建议问题里的一条 + 设置页入口；「恢复网络」放进 `DiagnosisSheet` 与设置页「网络」区。
- 建议问题：`连接到最快节点` / `为什么我打不开某个网站？` / `检查我的网络配置`，点击调 `onSend(text)`。
  只在 `!hasEverConnected && sessionCount === 0` 时显示。
- 主按钮文案随状态：`连接` / `取消` / `断开` / `重新连接` / `使用测试节点`。

### 2.6 `src/components/DiagnosisSheet.tsx`（新建）

把 `ConsoleView.tsx:226-318` 与 `buildDiagnosis` / `buildConclusion` 整体搬过来，改成右侧滑出的 sheet：

- 结论一句话在顶部。
- 检查项一行一条，`ok` 用 `--ok` 点、失败用 `--err` 点，值为 `.num`。
- 底部动作：`重新连接` / `换节点` / `刷新配置` / `恢复网络` / `让 AI 解释`（无 Key 时最后一项隐藏）。
- 关闭方式：右上 ×、Esc、点遮罩。

### 2.7 `src/components/Onboarding.tsx` — 重排为两步

| 步骤 | 内容 | 主按钮 | 次按钮 |
|---|---|---|---|
| 1 | `先连上，再聊。` + 一句说明 + 线路/网络意象 | `连接测试节点` | `导入我的配置文件`、`跳过` |
| 2 | `配置 AI（可选）` + DeepSeek 说明 + 输入框 | `保存并验证` | `稍后再说` |

- 第 1 步的「连接测试节点」直接走 `defaultProfileRefresh()` + `runtimeStart()`，不再要求先配 Key。
- Key 平台链接改为一行文字链接，不做大按钮。
- 两步共用现有 `onDone(skippedKey)` 回调，签名不变，`App.tsx` 不必大改。

### 2.8 `src/components/Settings.tsx` — 分区

四个分区，用左侧二级导航或标题分组，默认只展开第一个：

| 分区 | 内容 |
|---|---|
| 账号与 AI | 基础（DeepSeek Key）/ 高级（provider 列表、新增编辑、设为当前、测试连接） |
| 网络 | 代理模式（系统代理 / TUN，TUN 标注「暂不支持」）、本地端口（只读，显示当前实际端口）、默认配置源 |
| 高级 | 默认配置源地址（只读）、日志级别、导出诊断信息；每项右侧一个 `问 AI` 链接 |
| 关于 | 版本、事件源模式、重新运行首次引导、打开日志目录 |

保留现有全部命令调用，只改布局与文案。`describeImportError` 等文案函数不动。

### 2.9 `src/App.tsx` — 接线

- `StatusPanel` 增加 `showPrimary={view === "chat"}`。
- `ConsoleView` 不再接收 `onOpenLogs`，新增 `onOpenDiagnosis`。
- 新增 `hasEverConnected` 状态：从 `runtime` 首次进入 `running` 时置真并写 `localStorage["veyl.hasConnected"]`，用于隐藏建议问题。
- 顶栏胶囊只读，点击展开右栏（主区窄时）。
- `setup-bar` 保留但改成一行细提示，且只在 `!hasKey || profiles.length === 0` 时出现。

### 2.10 `src/ai/advancedPrompts.ts`（新建）

按 skill §5 实现 `advancedPrompt(field, value)`，供设置页「问 AI」调用（开新会话发送）。

---

## 3. 不做的事

- 不新增后端命令、不改契约、不改事件。
- 不引入 UI 框架、图标库、外部字体。
- 不做明暗主题切换（只有深色）。
- 不做窗口自绘标题栏（继续用系统标题栏）。
- 不改 `ChatView` / `MessageItem` / `Markdown` / `ToolCallCard` 的消息渲染逻辑，只跟随 token 变化。

---

## 4. 验收（用户手工）

| # | 场景 | 通过条件 |
|---|---|---|
| U1 | 启动进入控制台 | 全屏只有**一个**实心按钮；右栏没有第二个连接按钮 |
| U2 | 切到任意对话 | 主区没有连接按钮；右栏出现主按钮 |
| U3 | 右栏内容 | 只有 6 个区块；出口/时长/延迟各出现一次；详情默认折叠 |
| U4 | 数据不重复 | 出口 IP 只在一处出现；端口只在详情里 |
| U5 | 会话为空 + 熟悉用户 | 不出现建议问题与引导条 |
| U6 | 首次引导 | 第一步就能连接，不需要先填 Key |
| U7 | 高级入口 | 设置页四个分区；每项高级设置旁有「问 AI」 |
| U8 | 窄窗口 | 宽度 < 720px 时右栏收起为胶囊，功能不丢 |
| U9 | 线路图 | 未连接断线、连接中生长、已连接流动、失败断点，四态可辨 |
| U10 | 离线 | 断网启动不白屏、不请求外部字体/图片 |
