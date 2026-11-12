# 问题报告（本地生成 + 用户自己发邮件）

> 日期：2026-11-12
> 状态：设计定稿，待实现；本文只出设计与契约
> 涉及：`tools.md`（新工具）、`commands.md`（两个命令）、`events.md`（`display.actions`）、`design/tool-display.md`（映射行）
> 不涉及：`runtime.md`、`tun-backend.md`、`routing.md`——本功能没有任何网络层改动

---

## 0. 一句话

用户在会话里描述问题，AI 调一个工具把**脱敏后的现场材料**写到桌面上的一个文件夹，并在同一文件夹里写一份带证据引用的 `报告.md`；发不发、怎么发，由用户拿文件夹里的东西自己决定。

**Veyl 不发邮件、不联网上报、不内置任何凭据。** 邮件只是「打开发送邮件」时调起系统邮件客户端并预填收件人、标题、正文。

---

## 1. 与现有规范的三处冲突（已给取舍）

| # | 冲突 | 取舍 |
|---|---|---|
| 1 | PM 要求「只读的 AI 工具」，但工具要建目录、写 4 个文件 | **声明 `PermissionLevel::Write`**。`ReadOnly` 是事实错误：它会写盘，一旦将来给只读工具开快速通道，它就会绕过检查。工具的「只读」体现在**它不改用户任何配置、不碰网络、只写一个固定目录**，而不是权限枚举 |
| 2 | 参数里有「是否包含网站域名」= 模型可以决定放宽脱敏 | **保留参数，但 Host 只能收窄、不能放宽**：`effective = 用户在入口处的选择 && 参数`。模型传 `true` 而用户没开启时，按 `false` 执行并在返回里写明。脱敏开关是用户的，不是模型的 |
| 3 | 需求原文把材料说成「只在本机」 | 这在「让 AI 写报告」的前提下**不成立**：工具返回的日志会进模型上下文。统一改成**已批准的表述**：「报告只保存在你的电脑上；生成时，脱敏后的日志会发给你配置的 AI 服务。要不要把它发出去，由你决定。」任何位置都不得再出现「材料不出本机」一类的变体（见 §8） |

---

## 2. 入口与会话流程

三处入口，同一个动作：新建会话 → 发送开场指令。

| 入口 | 位置 | 显示条件 |
|---|---|---|
| ① | 中间底部节点卡上方右侧「报告问题」 | **仅 AI 已配置** |
| ② | 故障卡（`failed` / `degraded` / 已连接但 `data_plane = false`）上的「报告这个问题」 | 同上 |
| ③ | 设置 › 遇到问题 tab 的文字入口 | 同上 |

前端本地生成 `sessionId` → `ai_send_message { sessionId, text: <开场指令>, hidden: true }` → Host 随首条消息创建会话（沿用 `commands.md` §9.1，不新增 `create_session`）。

流程：

```
用户点入口
  → 右栏打开，新建会话
  → AI（按开场指令）问两句：遇到了什么问题；刚连上就有还是用着用着断的
  → 用户回答（本批不提供「跳过」入口）
  → AI 调 IssueReport（收集阶段）→ 材料落盘，返回脱敏摘要与统计
  → AI 写报告，调 IssueReport（写入阶段，带 report_markdown）
  → 会话里出现两个按钮：在文件夹中显示 / 打开发送邮件
```

---

## 3. 工具 `IssueReport`

- 模型可见名 `IssueReport`，Rust `IssueReportTool`，**一个工具、两阶段**：不带 `report_markdown` 是收集，带它是写入。
- `PermissionLevel::Write`（理由见 §1.1）。`changed = "none"`：不改任何配置、不碰网络（文件写入不属于 `changed` 的三种语义，见 `tool-display.md` §2.1）。
- **每个会话只对应一个目录**：按 `session_id` 绑定；重复调用复用同一目录，绝不生成 `<dir>-2`。换会话才会新建目录。

### 3.1 入参

```ts
type IssueReportInput = {
  log_lines?: number;        // 每份日志取多少行，40–400，默认 200；越界直接拒绝，不夹取（§3.1.1）
  include_domains?: boolean; // 三态：省略 = 按用户设置；false = 模型主动收窄；true 不能放宽（§1.2）
  report_markdown?: string;  // 省略 = 收集阶段；提供 = 写入阶段（≤ 128 KiB）
};
```

- `additionalProperties: false`。**没有 `path`、没有文件名、没有目录名**。
- 模型传了未知字段 → 工具层拒绝：`INVALID_ARGUMENT`，`details.reason = "unknown_argument"`，不产生任何文件。
- **`log_lines` 越界同样是拒绝，不是截断**：`< 40` 或 `> 400` → `INVALID_ARGUMENT`，`details.reason = "log_lines_out_of_range"`，一个文件都不写。静默夹到 400 会让模型以为拿到了 400 行、实际更少，`报告.md` 里引用的行号随之错位——这种错误在收件人那边看不出来，所以宁可让调用失败。

### 3.2 返回

```ts
type IssueReportData = {
  report_id: string;          // "rpt-20261112-153012-a1b2c3"，全局唯一，Host 登记
  report_dir: string;         // `~/Desktop/Veyl 问题报告/<目录名>`；不返回绝对路径，不含用户名
  phase: "collected" | "written";
  files: Array<{
    name: string;             // "先看我.txt" / "报告.md" / "现场.json" / "日志/runtime-1.14.4.log"
    bytes: number;
    lines: number | null;     // 文本日志有；json 为 null
    truncated: boolean;
    missing: boolean;         // 源日志不存在
  }>;
  materials?: {               // 仅收集阶段
    runtime: object;           // 已脱敏的 RuntimeSnapshot 子集（§5）
    checks: DiagCheck[];       // 复用 diag_run 的检查项
    logs: Array<{ name: string; start_line: number; lines: string[]; total_lines: number }>;
    domains_included: boolean; // 实际是否包含完整域名（受用户选择约束）
  };
  redactions: {
    domains: number; public_ips: number; paths: number;
    urls: number; node_refs: number; config_refs: number;
  };
  ai_report: boolean;         // 写入阶段：true；收集阶段先写模板，false
};
```

- `lines[].start_line` 是这份日志在**写入文件里的第一行的绝对行号**，模型据此写 `[日志/runtime-1.14.4.log:812]` 这类引用。
- 模型可见的日志总量上限：**4 份 × `log_lines`，且合计 ≤ 400 行、每行 ≤ 500 字符**。超了优先保留 `runtime` 与 `sing-box`，并在返回里给 `truncated`。返回里的路径一律是 `~` 形式，**不含用户名、不含其它文件系统信息**。

### 3.3 两个按钮从哪来

`ToolDisplay` 增可选的 `actions`（`events.md` §3.4，2.11.0）：

```ts
type DisplayAction =
  | { kind: "reveal_report_dir"; report_id: string }
  | { kind: "compose_report_mail"; report_id: string };
```

- 按钮由 **Host** 在写入阶段填进 `display.actions`，**不由模型生成**；模型看不到、也传不进任何路径。
- 点击不是 `next_actions`（那个等价于用户发一条消息），而是直接调命令（§9）。
- 没有 `kind: "open_path"` 这种通用动作：一旦有，模型就能诱导 UI 打开任意路径。

---

## 4. 可读范围

**只读这些，别的一个都不读**：

| 来源 | 路径规则 | 取法 |
|---|---|---|
| 应用日志 | `<log_dir>/app-YYYY-MM-DD.log`（当日），debug 构建为仓库根 `logs/` | 尾 `log_lines` 行 |
| 运行时日志 | `<log_dir>/runtime-<version>.log`，`<log_dir>` = `<data_dir>/logs` | 尾 `log_lines` 行 |
| helper 日志（macOS） | `~/.veyl/helper-logs/helper.log` | 尾 `log_lines` 行 |
| sing-box 日志（macOS） | `~/.veyl/helper-logs/sing-box.log` | 尾 `log_lines` 行 |
| 服务日志（Windows） | `%ProgramData%\Veyl\logs\service.log` | 尾 `log_lines` 行 |
| 运行时快照 | 内存中的 `RuntimeSnapshot`（`runtime.md` §2.5） | 直接读，不落盘 |
| 诊断检查项 | `diag_run(false)` 的结果（`tools.md` §3 `DiagRun`） | 直接复用 |
| 最近错误 | 快照里的 `last_error` | 直接复用 |

**明确禁止**（实现里不得出现这些读操作，代码评审按此驳回）：

- `secrets.enc`、`veyl.db` 的任何表、`chat_messages` / `chat_sessions` 的内容；
- 渲染出来的 sing-box 运行配置（**里面含节点密码**）；
- 用户粘贴过的节点文本、订阅原文；
- 任何参数给出的路径、任何 `~/Documents`、`~/Downloads`、浏览器数据；
- 配置文件（`config.json` 之类）——现场信息只走快照，不走文件。

**违规时的失败方式**：工具 schema 不接受路径，所以「读任意文件」在调用层就失败（`unknown_argument` / schema 校验错误），请求不入队、不落盘。日志文件本身不可读时**不是错误**：该份日志标记 `missing: true`，`先看我.txt` 里写「没有找到这份日志」，报告照常生成。

---

## 5. 可写范围

| 项 | 规则 |
|---|---|
| 根目录 | `<Desktop>/Veyl 问题报告/`。`Desktop` 取系统桌面目录；取不到（被重定向、无桌面）→ `<data_dir>/reports/`，并在返回与 `先看我.txt` 里写明位置——**同样用 `~` 形式**（`~/Library/Application Support/Veyl/reports/<目录名>` 或 `~/AppData/…`），不写用户名 |
| 子目录 | `<yyyy-MM-dd-HHmm>`（本地时区）。**同分钟已存在 → `-2`、`-3`**，最多 `-9`，绝不覆盖已有报告——用户可能已经改过或已经发出去 |
| 目录权限 | `0700`；文件 `0600`。Windows 走 ACL 等价设置，失败不阻断 |
| 文件 | `先看我.txt`、`报告.md`、`现场.json`、`日志/` 下的原样日志副本（保留原文件名） |
| 单文件上限 | 日志每份 ≤ 2 MiB（只写尾部）；`报告.md` ≤ 256 KiB；`现场.json` ≤ 64 KiB |
| 总量上限 | 单次 ≤ 8 MiB |
| 覆盖策略 | **只允许覆盖本目录内的同名文件**（同一会话的第二阶段写 `报告.md`）；不删除、不移动目录内其它文件 |
| 登记 | `report_id` 与目录的对应关系由 Host 内存登记，同时在该目录写 `.report-id`（一行纯文本），供重启后按 id 找回（§9） |
| 原子性 | **先写临时目录 `.tmp-<report_id>/`，全部文件成功后再写 `.report-id`、rename 成最终目录并登记**。中途失败删掉临时目录。`.report-id` 是「这份报告完整」的唯一提交标记：没有它的目录，两个动作命令都扫不到、打不开、发不了 |

---

## 6. 脱敏规则

处理顺序固定：**先按字段整值替换 → 再对自由文本跑 `logging::mask_secrets` → 再跑下面的模式规则**。顺序反了会让 `mask_secrets` 看不到原始形态。

| 对象 | 默认（`include_domains = false`） | 用户开启「包含网站域名」后 |
|---|---|---|
| 节点服务器地址 | 整值 `***`，**任何模式都不出现** | 同左（不可开启） |
| 节点端口 | 保留（单独一个端口不指向任何主机） | 同左 |
| 节点名 | `节点 1`、`节点 2`（按出现顺序） | 同左 |
| 配置名 | `配置 1` | 同左 |
| 用户名 / 主目录 | `/Users/<x>`、`/home/<x>`、`C:\Users\<x>` → `~`；其余路径保留结构 | 同左 |
| 域名 | `***.<可注册域>`：`www.google.com` → `***.google.com`；`a.b.example.co.uk` → `***.example.co.uk`。**可注册域按公共后缀表（PSL）取 eTLD+1**；取不到时退化为「保留最后两段」，`a.b.example.co.uk` 会变成 `***.co.uk`——这是已知局限，报告里不额外声明，但实现必须优先用 PSL | **保留完整域名**（仅主机名） |
| 公网 IP（v4） | `*.*.*.*`，附带一个布尔「出口 IP 与直连 IP 是否相同」 | `a.b.*.*`（保留前两段） |
| 公网 IP（v6） | `*:*:*:*:*:*:*:*` | 前 3 组保留，其余 `*` |
| 私网地址 | **原样保留**：`10/8`、`172.16/12`、`192.168/16`、`127/8`、`169.254/16`、`100.64/10`、`fe80::/10`、`fc00::/7`、`::1` | 同左 |
| URL | `scheme://***.<tld>/` + 路径段数；**查询串整段丢弃**（可能带 token） | 主机保留，查询串仍丢弃 |
| 邮箱 / 手机号 | `***@***` / `***`（11 位、`1` 开头） | 同左 |
| 凭据形态 | `logging::mask_secrets`：`sk-` 前缀、≥16 位 base64/hex、URL 里的 `user:pass@` | 同左 |

**不随开关放松的**：路径、URL 查询串、邮箱、手机号、凭据、节点地址。它们对定位没有价值，只有风险。

开关本身存在本地设置 `issue_report_include_domains`，**只能由用户在报告入口勾选**（`commands.md` §7.12 `issue_report_preference`），模型既读不到也改不了。工具入参是三态：**省略 = 按用户设置；显式 `false` = 模型主动收窄；显式 `true` 不能放宽**。

`现场.json` 与 `报告.md` 都按本规则生成；`materials` 返回给模型的也是同一份脱敏结果——**不存在「只对文件脱敏、对模型不脱敏」的分支**。

### 6.1 脱敏标记口径（收件人必须能看出哪里被打码）

**唯一占位符是 `***`。** 不允许 `[redacted]`、`xxxx`、`…`、`<hidden>`、空串或直接删字段——收件人看到 `***.google.com` 要知道「这里有个子域被打码了」，而不是去猜一个真实域名。

| 位置 | 写法 | 例 |
|---|---|---|
| 域名（默认） | `***.<可注册域>` | `***.google.com` |
| 域名（开关开启） | 原样，不打码 | `www.google.com` |
| 节点地址 | `***`（单独一个 token，不带点） | `***` |
| 公网 IPv4（默认） | `*.*.*.*` | `*.*.*.*` |
| 公网 IPv4（开关开启） | `a.b.*.*` | `203.0.*.*` |
| 公网 IPv6 | `*:*:*:*:*:*:*:*` / 开关后前 3 组保留 | `2001:db8:*:*:*:*:*:*` |
| 主目录 | `~`，后面保留原结构 | `~/Library/Application Support/Veyl/logs/app-….log` |
| 凭据 / 邮箱 / 手机号 | `***` / `***@***` | `***@***` |

统一约束：

1. **`现场.json` 里凡是打过码的字段，字符串里必须含 `***`**。不要用 `null` 表示「打了码」——`null` 在本契约里只表示「没有数据」。机器可据此判断漏脱敏：`domains_included = false` 时，输出里出现任何不带 `***` 的域名就是 bug（验收断言 §12.6）。
2. **日志不做逐行标记**：日志是原样尾部拷贝，行号必须与源文件一致，加标记会破坏引用。打码只发生在 token 级（`***`），并在两处给图例：`先看我.txt` 首段、`报告.md` 开头声明。
3. `现场.json` 顶层带 `"redaction_marker": "***"` 与 `"redactions": { … }`（计数）；`log_files[]` 每项带 `redacted: true`。收件人据此知道这四份日志都动过。
4. **不得局部打码**：要么整个值替换成 `***`，要么原样保留。`goo***.com`、`203.***.*.*` 这类半掩码既不能读也不能查，一律禁止。

---

## 7. `报告.md` 与 `现场.json`

### 7.1 `报告.md` 固定结构

```markdown
# 问题报告

> 本报告由 Veyl 与用户配置的模型生成，可能不准确。
> 报告中的 `***` 表示已打码（域名子域、节点地址、公网 IP 等）。
> 报告文件只保存在本机；是否发送由你决定。

## 现象
（用户原话 + 观察到的状态，2–5 行）

## 环境
（应用版本、系统、连接模式、配置摘要；不含节点地址）

## 时间线
- 15:12:03 连接开始
- 15:12:09 控制面就绪
- 15:12:31 数据面探测连续失败
（每条必须带时间，来自日志或快照）

## 可疑点
1. 出站握手超时
   证据：日志/runtime-1.14.4.log:812、现场.json:health.data_plane
2. …
（每条必须至少一处证据；**没有证据的判断不写**）

## 下一步建议
1. 换一个节点再试（对应可疑点 1）
2. …
```

- **每条判断必须引用具体日志行或字段**，格式 `日志/<文件名>:<行号>` 或 `现场.json:<字段路径>`。没有证据的不写——宁可少写。
- 不写「视情况」「可能吧」这类无信息量的话；不使用 `proxy` / `TUN` / `分流` / `规则集` 以外的内部术语（面向用户的口径按 `veyl-ui`）。
- **AI 未产出时的模板兜底**：收集阶段先写一份只含「现象 / 环境 / 下一步建议（重新连接、换节点、让助手继续看）」的 `报告.md`；写入阶段才用模型版本覆盖它。AI 超时或失败时，用户拿到的仍是完整材料 + 模板报告，会话里说明「报告没写成，材料已生成」。

**结构是规范性要求，不是建议。** `报告.md` 必须包含：一个一级标题、开头三行声明（生成方式、`***` 图例、发送由你决定）、以及 `现象` / `环境` / `时间线` / `可疑点` / `下一步建议` 五个二级小节。

- 模型产出的 `report_markdown` 缺标题、缺声明行或缺小节时，**Host 兜底补写**：补一级标题与三行声明；缺的小节按顺序插入 `## <小节名>` + 一行「模型未提供这一节。」；不做其它改写（不替模型编内容）。
- 兜底补写发生在写盘前，所以磁盘上的 `报告.md` 永远满足结构；`ai_report` 仍为 `true`，补写痕迹只体现在那行占位文字里。

### 7.2 `现场.json` 字段

| 字段 | 说明 |
|---|---|
| `schema_version` | 固定 `1` |
| `report_id` | 与目录同名标识 |
| `generated_at` | ISO 8601 UTC |
| `tool_version` | 报告工具版本，等于 `tools.md` 契约版本 |
| `app_version` / `platform` / `os_version` / `arch` | `platform` ∈ `darwin` / `windows` / `linux` |
| `locale` / `timezone` | 系统地区与时区 |
| `mode` | `system_proxy` / `tun` |
| `state` | `RuntimeState` |
| `routing_mode` | `direct` / `proxy_all` / `proxy_selected` |
| `mixed_port` / `port_fallback` | 来自快照；`port_fallback.reason` 只有两个值 |
| `health` | `{ process, clash_api, data_plane, consecutive_failures, checked_at }` |
| `system_dns` | `tunnel` / `unchanged` / `null` |
| `connected_since` / `uptime_seconds` | 来自快照 |
| `node_count` / `config_count` | 只给数量 |
| `node_protocols` | 去重后的协议名数组（`shadowsocks` / `hysteria2`…），**不含地址** |
| `runtime_version` / `runtime_source` | 来自快照 |
| `last_error` | `{ code, message(脱敏), reason }`；`reason` 取 `details.reason`，没有就 `null` |
| `log_files` | `[{ name, lines, truncated, missing, redacted: true }]` |
| `redaction_marker` | 固定字符串 `"***"`：报告里被打码的地方都用它 |
| `redactions` | 与 `IssueReportData.redactions` 同形；另含 `mode: "minimal" \| "detailed"` |
| `domains_included` | 布尔 |

**不含**：节点地址、节点端口、密码、uuid、配置名、用户名、任何域名（除非用户开启）。

**`先看我.txt` 的内容**（固定模板，10 行以内）：首段逐字使用 §8 那句已批准声明（「报告只保存在你的电脑上；生成时，脱敏后的日志会发给你配置的 AI 服务。要不要把它发出去，由你决定。」）；然后一行 `***` 图例；再列里面有什么文件、发邮件时别忘了附上 `现场.json` 与 `日志/`、实际保存位置。

---

## 8. 会话开场

- **开场指令由 Host 生成、前端以 `hidden: true` 发送**（`commands.md` §9.1）。**不作为 user 消息落库**：那是系统触发，不是用户说的话，落库会让历史里出现用户没打过的句子。
- AI 的第一条回复必须是固定结构（提示词约束）：

  > 我会把现在的现场情况整理成一个报告文件夹，放在你的桌面上。**报告只保存在你的电脑上；生成时，脱敏后的日志会发给你配置的 AI 服务。要不要把它发出去，由你决定。**
  > 先问两句：你遇到了什么问题？是刚连上就有，还是用着用着断的？

- 上面那句声明**只出现在两处**：① 开场消息；② `先看我.txt` 首段（同一句，逐字）。**不在工具卡片里重复**——卡片只给结果。任何位置都不得把它改写成「材料只在本机」一类的保证：日志要进模型上下文，那样说就是假话。
- **开场首条回复必须原样包含该句**（规范性要求）：提示词要求模型说，但**不能只靠模型**。Host 在该次请求的首条助手消息完成后校验：不含该句时，追加一条固定声明消息（标记为系统提示，不算 AI 输出）。校验按子串匹配整句，缺字、改写都算缺失。
- **本批不实现「跳过提问」（后续批次考虑）**：用户主动点进来就是为了说两句，多一个「跳过」按钮反而增加一次决策。没有跳过入口时，用户不回答就不生成——这不是缺陷，是刻意留空。

**开场指令原文（`hidden: true` 发送，不落库）**：

```
请帮我整理一份问题报告。先问我两句：你遇到了什么问题；是刚连上就有，还是用着用着断的。
我回答后，调用 IssueReport 收集材料，再把报告写进去（第二次调用带 report_markdown）。
不要先解释流程，不要在提问前调用工具。
```

- 末尾两句是给模型的硬约束：先问再收集，避免它一上来就生成一份没有现象描述的报告。
- **本批不实现「跳过提问」变体（后续批次考虑）**：不加「用户已跳过提问」这类指令，也不做「生成报告」旁路按钮；用户必须回答后才会触发收集。

---

## 9. 两个动作命令

| 命令 | 参数 | 作用 | 失败 |
|---|---|---|---|
| `issue_report_reveal` | `{ reportId }` | 在 Finder / 资源管理器中显示该报告目录 | `NOT_FOUND`：`report_id` 未登记且磁盘上找不到 |
| `issue_report_mail` | `{ reportId }` | 调起系统邮件客户端，预填收件人、标题、正文 | `NOT_FOUND`；调不起客户端**不报错**，返回 `opened: false, method: "copy_only"` |

- **收件人写死常量** `FEEDBACK_EMAIL = "ribencong@gmail.com"`，用户不可改（理由见 §10）。
- 正文 = `报告.md` 全文 + 末尾固定一段「附件请附上同目录的 `现场.json` 与 `日志/`」。正文超过 **6 KB** 时按 §9.1 的顺序裁剪。
- `report_id` 解析：先查内存登记，未命中再扫 `<Desktop>/Veyl 问题报告/*/.report-id`；**不接受任何路径参数**。
- **只认写完的目录**：`.report-id` 是提交标记。写盘必须先落到 `.tmp-<report_id>/`，全部成功后写 `.report-id`、rename、登记；失败则删掉临时目录。两个命令都只解析带 `.report-id` 的目录——半成品既打不开也发不出去，避免用户拿到一份缺日志的报告却以为是完整的。
- 打开失败（无邮件客户端、被系统拒绝）→ 返回 `opened: false, method: "copy_only"`，UI 给出「复制正文 / 打开报告文件夹」两个兜底，不静默失败。

### 9.1 正文裁剪顺序（超 6 KB 时）

1. 时间线只留与可疑点相关的行；
2. 「下一步建议」只留第 1 条；
3. 每条可疑点的证据只留第一条；
4. 仍超限 → 截断到 6 KB 并加一行「正文已截断，完整内容见附件里的 报告.md」。

**永不删**：报告标题、开头三行声明（含 `***` 图例）、`现象`、`环境` 的版本/平台/模式/状态、收件人与附件提示。这几项是「还能不能定位」的下限。

---

## 10. 失败路径

| 情况 | 行为 |
|---|---|
| AI 未配置 | 三处入口都不显示（已定） |
| 生成中取消 | 收集阶段之前取消：不落盘；之后取消：已有材料保留，报告为模板版 |
| 磁盘不可写（桌面权限、只读卷） | 工具返回 `INVALID_ARGUMENT`，`details.reason = "report_dir_unwritable"`；会话说明「没写成，检查桌面权限」，不重试 |
| 桌面被重定向 / 取不到 | 落到 `<data_dir>/reports/`，返回与 `先看我.txt` 用 `~` 形式写明位置 |
| 某份日志不存在 | `missing: true` + `先看我.txt` 注明；不报错 |
| 日志过大 | 只取尾部，`truncated: true` 并记 `omitted_lines` |
| 同名目录已存在 | `-2`…`-9`；`-9` 也占用时用 `-<HHmmss>` |
| AI 生成超时 / 失败，但材料已齐 | 材料与模板报告照常产出；工具写入阶段不调用，会话说明原因；按钮仍可用 |
| 用户删掉报告目录后再点按钮 | `NOT_FOUND`，提示重新生成 |
| 无邮件客户端 | 返回 `opened: false, method: "copy_only"`，UI 给「复制正文 / 打开文件夹」两个兜底 |

---

## 11. 契约变更

| 契约 | 变更 | 版本 |
|---|---|---|
| `tools.md` | 新增 #46 `IssueReport`（`Write`，两阶段，schema 见 §3.1）；§2.4 映射表与「45 个名字」的断言改为 46 | **3.8.0 → 3.9.0** |
| `events.md` | `ToolDisplay` 增可选 `actions: DisplayAction[]`（只有两个 kind，`report_id` 不透明） | **2.10.0 → 2.11.0** |
| `commands.md` | 新增 `issue_report_reveal` / `issue_report_mail` / `issue_report_preference`；§12.1 补三行 | **2.16.16 → 2.17.0** |
| `design/tool-display.md` | §9 映射表加一行；「44 个」与 `tools.md` 的「45 个」本来就不一致，这次一并改齐 | 文档 |
| `runtime.md` / `tun-backend.md` / `routing.md` / `data-model.md` | **不涉及**：只读快照，不新增表，不碰网络层与分流 | — |

---

## 12. 验收断言（可落成测试）

1. `IssueReportInput` 传 `{"path":"/etc/passwd"}` → `unknown_argument`，目录未创建。
2. 同一会话连续两次收集 → 只有一个目录，`report_id` 不变。
3. 同分钟两个会话 → 两个目录，第二个是 `-2`，第一个内容未被改动。
4. 目录权限 `0700`，文件 `0600`（Windows 验证 ACL 等价）。
5. `现场.json` 里不出现：节点地址、`password`、`uuid`、配置名、`/Users/<name>`。
6. 默认模式下域名输出为 `***.<可注册域>`：`www.google.com` → `***.google.com`，`a.b.example.co.uk` → `***.example.co.uk`（PSL）；开启开关后域名原样，其它字段与默认模式逐字节相同（除 `domains_included`）。
6a. `domains_included = false` 时，`报告.md` / `现场.json` / 四份日志里**不得出现任何不带 `***` 的域名**；`现场.json` 中所有打码字符串都含 `***`，且只使用 `***` 这一种占位符（出现 `[redacted]` / `xxxx` / 半掩码即失败）。
6b. `现场.json.log_files[]` 每项 `redacted = true`；`redaction_marker = "***"`；`redactions` 计数与日志中 `***` 的实际出现次数关系可解释（前者是字段级计数，不做逐 token 对账，但不得为 0 而输出里有 `***`）。
7. 模型传 `include_domains: true` 而用户未开启 → 输出仍为 `false`，`domains_included = false`。
7a. `issue_report_preference` 默认返回 `false`；写成 `true` 后，同样的收集调用才输出完整域名。模型无法通过任何工具入参改变这个值。
7b. `log_lines` 传 `20` 或 `500` → `INVALID_ARGUMENT`，`details.reason = "log_lines_out_of_range"`，目录未创建。
8. 日志不存在时 `missing = true`，工具仍成功。
9. `报告.md` 的「可疑点」每条都含 `日志/` 或 `现场.json:` 引用（模板兜底版可以没有可疑点）。
10. `display.actions` 只有 `report_id`，不含路径；伪造的 `report_id` 调 `issue_report_mail` → `NOT_FOUND`。
11. 邮件正文 ≤ 6 KB，且始终含收件人提示与附件提示。
12. AI 超时：材料与模板报告存在，`ai_report = false`，且 `display.actions` 仍有「在文件夹中显示 / 打开发送邮件」。
13. 收集阶段成功后 `display.actions` 就有两个动作，不必等写入阶段。
14. 写盘中途失败：只剩 `.tmp-<report_id>/`，没有 `.report-id`；`issue_report_reveal` / `issue_report_mail` 都返回 `NOT_FOUND`。
15. `report_markdown` 缺「时间线」小节 → 写盘后的 `报告.md` 仍含五个小节，缺的那节是「模型未提供这一节。」，标题与三行声明齐全。
16. 开场首条助手回复不含披露句 → Host 追加一条固定声明消息（标记为系统提示），会话里一定能看到该句。

---

## 13. 明确不做

- 不发邮件、不接 SMTP、不内置任何凭据、不做后台上报。
- 不新增设置项；收件人是常量。
- 不读数据库消息内容、不读 `secrets.enc`、不读渲染配置。
- 不提供通用「打开任意路径」的工具或动作。

---

## 14. 已知限制

**重启后从历史恢复的报告会话不显示界面披露条。**

- 原因：`chat_history` 目前只返回 `id` / `role` / `content` / `created_at`，不含工具信息；DB 的 `tool_json` 列实际几乎恒为 `null`。因此「这轮会话里出现过 `IssueReport` 调用」这一推断在真实重启后不会命中，界面无法据此重现披露条。
- 现状：前端已实现该推断逻辑，**将来后端在历史里补 `tool` 字段就会自动生效**；本批不为它改动聊天持久化。
- 缓解：**报告文件本身仍带披露**——`先看我.txt` 首段与 `报告.md` 的三行声明都在；且该会话在**本次运行内**始终显示界面披露条。
- 影响范围：仅「重启后回看旧报告会话时看不到这条界面说明」，**不涉及任何新的数据外发**。

**报告结构与披露句由 Host 兜底（§7.1、§8）。** 即使模型把声明改写成近义句、或漏写小节，写盘前 Host 会补齐标题、三行声明与五个小节，`先看我.txt` 也逐字使用规定的那句。因此「模型这次没照做」不会让文件里的声明消失——它只会让界面要追加一条系统声明（§8）。
