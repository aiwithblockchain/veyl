# veyl-admin 第一屏：配色与视觉规范

> 日期：2026-11-28
> 适用：`cloudflare/admin` 这个 Worker 服务端直出的 HTML（无前端框架、无构建步骤）。
> 定位：一张**体检表**，不是仪表盘。一屏看完所有机器，只关心「谁不正常」。
> 依据：`ui-ux-pro-max` 的 `typography` 命中 **Minimal Swiss（Inter 单字族）**，与本页目标一致；`color` 命中的中性浅色系只作参考，最终色值**全部取自 Veyl 客户端 `src/styles/app.css` 已有 token**，不引入第二套色板。

---

## 0. 被否掉的建议与原因

`--design-system` 对本查询返回的是 **Dark + Glassmorphism**（背景 `#0F172A`、毛玻璃、Z 轴层次）。它违反了三条硬约束：浅色、不要卡片墙、不要阴影堆叠，所以**不采用**。本页是浅色、无阴影、无色块、只有表格与一条横幅。

同理不采用状态页那套「大面积绿底」：整页彩色会让真正的告警淹没在色彩里。

---

## 1. 颜色 token

所有值都是 Veyl 客户端已有颜色的原值或其透明叠加，未新造色相。

### 1.1 背景与分隔

| Token | 值 | 用途 | 说明 |
|---|---|---|---|
| `--bg` | `#FAFAF8` | 页面底色 | 与客户端 `--canvas` 相同 |
| `--surface` | `#FFFFFF` | 表格纸面、签票结果块 | 表格是本页唯一的大面积白色 |
| `--surface-sunken` | `#F4F4F1` | 表头行底 | |
| `--surface-danger` | `#F4ECEA` | 失败行整行底色 | `--red` 7% 叠在 `--bg` 上 |
| `--border` | `rgba(20,22,28,.10)`（实心约 `#E8E8E8`） | 表格行分隔线 | 与客户端 `--hair` 相同 |
| `--border-strong` | `rgba(20,22,28,.18)`（实心约 `#D5D5D6`） | 表头下边线、按钮描边、结果块描边 | 与客户端 `--hair-strong` 相同 |

### 1.2 文字（三级 + 缺失）

| Token | 值 | 对比度 | 用途 |
|---|---|---|---|
| `--text-1` | `#14161C` | 17.3:1 / `--bg` | 机器名称、按钮文字、正文重点 |
| `--text-2` | `#5B5850` | 6.8:1 / `--bg` | 列头、次要数值、说明文字 |
| `--text-3` | `#6E6A62` | 5.15:1 / `--bg`；5.38:1 / 白 | 元信息、ID、时间戳 |
| `--text-missing` | `#6E6A62` | 同上 | **仅用于缺失值**，见 §6 |

三级之外**不再有第四级灰**。再淡就过不了 4.5:1，也会让「缺失」和「次要」混为一谈。

### 1.3 主色、链接与状态

| Token | 值 | 对比度 | 用途 |
|---|---|---|---|
| `--action-bg` | `#14161C` | 白字 18.1:1 | 主按钮底（墨色，不是品牌粉） |
| `--action-bg-hover` | `#2A2D36` | 白字 13.75:1 | 主按钮悬停 |
| `--action-text` | `#FFFFFF` | — | 主按钮文字 |
| `--link` | `#C2185B` | 5.62:1 / `--bg` | **只用于真正的链接**（如节点 ID 可跳转时） |
| `--focus` | `#E03A66` | 4.05:1 / `--bg` | 焦点环（非文本对比需 ≥3:1，通过） |
| `--state-ok-bg` | `#E6EEE9` | 文字 6.33:1 | 正常状态 chip 底 |
| `--state-ok-text` | `#14613D` | — | 正常状态文字 |
| `--state-warn-bg` | `#F2EEE4` | 文字 6.03:1 | 待处理状态 chip 底 / 横幅底 |
| `--state-warn-text` | `#7A5100` | — | 待处理文字 |
| `--state-danger-bg` | `#F4ECEA` | 文字 6.93:1 | 失败状态 chip 底 / 失败行底 |
| `--state-danger-text` | `#8F2F26` | — | 失败文字 |

**品牌粉 `#F6537B` 在本页完全不出现。** 客户端里它只做装饰；体检表上任何非语义的颜色都会稀释告警信号。

---

## 2. 排版

| Token | 字体与字号 | 用途 |
|---|---|---|
| `--font-sans` | `Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif` | 全页正文 |
| `--font-mono` | `"SF Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace` | 节点 ID、agent 版本、IP:port、JWT |
| `--text-title` | 15px / 22px，600 | 页面标题 |
| `--text-body` | 14px / 22px，400 | 横幅、按钮、说明 |
| `--text-cell` | 13px / 20px，400 | 表格数值 |
| `--text-meta` | 12px / 16px，500 | 列头、chip 文字、时间 |
| `--text-mono` | 12px / 18px，400 | ID / 版本 / 地址 / JWT |

规则：

- 13px 是**数据的最低字号**；12px 只给列头与元信息，绝不用于必须读准的值。
- 证书到期日、最后上报时间加 `font-variant-numeric: tabular-nums`，数字列上下对齐。
- mono 列不加 `letter-spacing`，等宽字本身已有字距。
- Inter 建议自托管 woff2，不从第三方 CDN 取：这是 Access 后面的管理页，少一个外部请求少一处依赖。

---

## 3. 表格规格

| 项 | 值 |
|---|---|
| 行高 | `44px`（内容垂直居中；行内按钮 30px，上下各留 7px） |
| 单元格内边距 | `12px 14px` |
| 表头高度 | `36px`，`background: var(--surface-sunken)` |
| 表头文字 | `--text-meta`、`--text-2`、`border-bottom: 1px solid var(--border-strong)` |
| 行分隔 | `border-bottom: 1px solid var(--border)`；最后一行不加 |
| 斑马纹 | **不用**。44px 行高 + 分隔线已经够扫读，斑马纹会与失败行底色打架 |
| 表格容器 | 直接铺在 `--bg` 上，**不要**外框、不要卡片、不要阴影、不要圆角 |
| 横向溢出 | 窄屏用 `overflow-x: auto` 包一层，不压缩列宽 |

列与字体的对应：

| 列 | 字体 / 颜色 |
|---|---|
| 名称 | `--text-cell` / `--text-1` / 500 |
| 节点 ID | `--text-mono` / `--text-3` |
| 环境 | chip（§4） |
| state | chip（§4） |
| agent 版本 | `--text-mono` / `--text-2` |
| IP:port | `--text-mono` / `--text-2` |
| 证书到期日 | `--text-cell` / tabular-nums；临近或已过按 §7 上色 |
| 最后上报 | `--text-cell` / tabular-nums；超时按 §7 上色 |
| 操作 | 次按钮（§5） |

---

## 4. 环境标签与状态：只用底色 + 文字色

统一 chip：`height 20px`、`padding 0 6px`、`border-radius 4px`、`font: var(--text-meta)`、`line-height: 20px`、无图标、无边框（danger 行内除外）。

| 标签 | 底色 | 文字色 | 说明 |
|---|---|---|---|
| `prod` | `rgba(20,22,28,.10)`（约 `#E3E3E2`，`--text-1` 对比 14.08:1） | `--text-1` | 底色更实：出错代价最高的一类，视觉上「更重」 |
| `dev` | `transparent` | `--text-2`，加 `1px solid var(--border)` 描边 | 描边而不是底色，保持轻 |
| `active` | `--state-ok-bg` | `--state-ok-text` | |
| `installing` | `--state-warn-bg` | `--state-warn-text` | |
| `failed` | `--state-danger-bg` | `--state-danger-text` | |

全部靠色相 + 明度区分，不引入第三种维度（不加图标、不加圆点、不加左侧色条）。

---

## 5. 按钮与焦点

| 类型 | 规格 |
|---|---|
| 主按钮 | `height 30px`、`padding 0 12px`、`border-radius 6px`、`background var(--action-bg)`、`color #FFF`、`font 13px/30px 500`；hover `--action-bg-hover` |
| 次按钮（签票、复制） | `height 30px`、`padding 0 12px`、`radius 6px`、`background var(--surface)`、`border 1px solid var(--border-strong)`、`color var(--text-1)`；hover 底色 `--surface-sunken` |
| 禁用 | 底色 `rgba(20,22,28,.06)`、文字 `--text-3`、`cursor: default`，不加透明度动画 |
| 焦点 | 所有可聚焦元素统一 `outline: 2px solid var(--focus); outline-offset: 2px`，**不移除默认焦点环** |
| 过渡 | 只过渡 `background-color 120ms`，不位移、不缩放 |

本页主按钮只有一个语义：签票永远是**次按钮**（它不改变节点状态）。主按钮留给「现在查」这类会发起外部请求的动作。

---

## 6. 缺失值：中性、明确、不像正常

缺失值必须一眼看出「这里没有数据」，但**不能**借用状态色——否则会变成假告警。

| 场景 | 渲染 |
|---|---|
| 没有上报时间 | `—`（U+2014） |
| 未签发过票 | `未签发` |
| 无证书 / 无版本 | `—` |
| 任何空单元格 | `—` |

统一规则：

- 一律 `color: var(--text-missing)`，即 `#6E6A62`。
- **禁止**用 `--text-1` 显示缺失值：那是「有数据」的颜色。
- **禁止**用任何 `--state-*` 颜色显示缺失值：缺失不是故障，是没查过。
- 不加斜体、不加删除线、不加问号图标。

---

## 7. 使用规则：颜色只出现在该出现的地方

1. `--state-warn-*` 与 `--state-danger-*` **只允许**出现在满足以下任一条件的行或某几个单元格上：
   - `state = failed`；
   - 证书已过期，或 7 天内到期；
   - 最后上报超过 24 小时；
   - agent 版本缺失。
2. **失败行**是唯一允许整行变底色的地方（`--surface-danger`），且每屏最多这样处理真正失败的行。
3. `--state-ok-*` 只出现在 `active` 的 chip 里；页面上**没有别的地方**可以是绿色。
4. `--link` 只给真正的 `<a>`；普通文字即使可点也不要染成链接色。
5. 时间戳与证书日期的「临近/超时」只染**文字**不染底，避免和状态 chip 抢注意力。
6. 任何一行最多一个彩色元素。如果一行既失败又超时，只保留失败（danger）那一处，其余用 `--text-2`。
7. 汇总横幅（§8）是页面上唯一允许整条变色的横条。

---

## 8. 汇总横幅

表格正上方一条，`height 40px`、`padding 0 2px`、无圆角、无卡片，只用一条底线与表格分隔。

| 情况 | 样式 |
|---|---|
| 待处理 0 台 | 文字 `待处理 0 台`，`--text-2`，底色透明，底线 `--border` |
| 有待处理 | `--state-warn-bg` 底 + `--state-warn-text` 字，底线 `--border-strong` |
| 有 failed | `--state-danger-bg` 底 + `--state-danger-text` 字 |

文案写数字，不写形容词：`待处理 3 台`，不写「有异常需要关注」。

---

## 9. 签票结果

签票是就地展开，不弹层、不跳页。

| 元素 | 规格 |
|---|---|
| 容器 | `background: var(--surface)`、`border: 1px solid var(--border-strong)`、`border-radius: 6px`、`padding: 12px 14px`；无阴影（它就是一块纸，不是卡片） |
| 标题行 | `只读票 · 有效期 1 小时`，`--text-meta`，`--text-2` |
| JWT 本体 | `<textarea readonly>`，`font: var(--text-mono)`、`line-height: 18px`、`word-break: break-all`、`resize: none`、`background: var(--surface-sunken)`、`border: 1px solid var(--border)`、`padding: 10px`、`min-height: 76px` |
| 复制 | 次按钮「复制」，紧贴 textarea 右上；复制成功把按钮文字临时换成「已复制」，1.5 秒后还原，**不弹 toast** |
| 失败 | 文字 `--state-danger-text`，底色 `--state-danger-bg`，只占一行，不复用结果容器 |

为什么用 `textarea` 而不是 `<pre>`：原生支持整段选中（点一次 + `⌘A` 全选），`<pre>` 遇到长 JWT 换行后选区容易带上行号或多余空白。`user-select: text` 必须显式保留。

---

## 10. 落地与自查

CSS 变量直接写进页面的 `<style>`（或一个 `admin.css`），无构建步骤。落地后逐条核对：

- [ ] 全页无 `box-shadow`、无 `backdrop-filter`、无渐变。
- [ ] 除失败行与状态 chip 外，没有任何彩色像素。
- [ ] 所有文字对比度 ≥ 4.5:1；焦点环 ≥ 3:1。
- [ ] 缺失值全部是 `—` 或「未签发」，颜色为 `--text-missing`。
- [ ] 一屏 1280×800 能看见全部列，无需横向滚动。
- [ ] 焦点可以用 Tab 走完：每个签票按钮 → JWT 框 → 复制按钮。
- [ ] 没有任何 emoji 与图标库引用。
