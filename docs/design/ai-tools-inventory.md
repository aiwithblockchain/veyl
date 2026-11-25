# AI 工具盘点：现状、证据与问题

> 日期：2026-11-24
> 基准：`main` @ `8fbcd77`（工作区有 3 个未提交文档改动，与本次审计无关）
> 范围：`src-tauri/src/tools/mod.rs:157` 的 `vpn_tools()` 全部 43 项（42 个 Veyl 产品工具 + 1 个 `AskUserQuestionGuard` 包装），加 `src-tauri/src/claurst_session/mod.rs:106` 的 6 个基础文件工具。
> 方法：只读代码、契约与提示词；不运行应用、不改代码、不 commit。

---

## 0. 读法与口径

### 0.1 模型到底能看到什么

契约把结果分成两半（`docs/contracts/tools.md:43-50`）：

| 字段 | 用途 | 模型能否看到 |
|---|---|---|
| `ToolResult.content` | 人类可读摘要 | **能** |
| `ToolResult.metadata.aivpn` | 结构化信封（`summary` / `data` / `error` / `next_actions`） | 按契约 **不能**，只给 UI |

实现完全按这个切分：`src-tauri/src/tools/envelope.rs:163-188` 把 `content` 设为 `outcome.summary`，把 `data` 放进 `metadata`。claurst 自己的 `ToolResult` 注释也写明：`content` 是「Content to send back to the model as the tool result」，`metadata` 是「for the TUI to render diffs, etc.」（`claurst/src-rust/crates/tools/src/lib.rs:126-132`）；query loop 只把 `result.content` 写回消息（`claurst/src-rust/crates/query/src/lib.rs:1716-1724`、`:2377-2386`）。因此：

- 工具写进 `facts` 的内容只用于界面卡片，**不自动进入模型上下文**；
- 工具写进 `data` 的内容同样只给 UI，**不自动进入模型上下文**；
- 模型判断只能依赖 `content`（summary）。

这个口径是后面「横切问题」的根据。如果运行时实际上把 `metadata` 也喂给了模型，那么契约 §1.2 本身失真；两种情况下都需要拍板（见 §5）。

### 0.2 权限

`PermissionLevel` 由每个工具自己声明（`policy.rs:13-21` 映射成线上字符串）。审计时以实现为准，契约 §3 表为辅。

### 0.3 四个容易混淆的「目录」

代码里至少有四种「目录 / 清单」容易混：

1. `CatalogSearch` 查的是**远端共享节点目录**（`tools/catalog.rs:27-30`）。
2. `CatalogOptions` 读的是**建机目录**（地区 + 套餐，`tools/stage_select.rs:380-383`）。
3. `CatalogRefresh` 拉的是**Veyl 免费节点** `veyl_seed.json`（`tools/net.rs:203-207`）。
4. `ConfigDetail` 读的是**本地节点池 / 配置**（`tools/configs.rs:77-80`）。

`mod.rs:158` 自己写了注释区分 1 和 2；契约 §3.1 也有同样的提醒（`tools.md:398`）。

---

## 1. 总表

| # | 工具 | 域 | 权限 | 一句话职责 | 文档引用 |
|---|---|---|---|---|---|
| 1 | `RuntimeStatus` | 运行时 | ReadOnly | 读运行时快照（状态、版本、出口、流量） | 契约 §4.1；提示词未点名 |
| 2 | `RuntimeStart` | 运行时 | Write | 启动运行时，不设系统代理 | 契约 §4.2；提示词未点名 |
| 3 | `RuntimeStop` | 运行时 | Write | 停止运行时并恢复系统代理 | 契约 §4.3；提示词未点名 |
| 4 | `RuntimeRestart` | 运行时 | Write | 重启运行时 | 契约 §4.4；提示词未点名 |
| 5 | `RuntimeLogs` | 运行时 | ReadOnly | 读最近若干行脱敏日志 | 契约 §4.5；ai-docs 2.6 |
| 6 | `CoreListVersions` | 运行库 | ReadOnly | 列出已安装 / 可安装运行时版本 | 契约 §4.6；ai-docs 2.6 |
| 7 | `CoreUpgrade` | 运行库 | Execute | 检查更新并弹卡后升级 | 契约 §4.45；product §3.6 |
| 8 | `CatalogSearch` | 目录 | ReadOnly | 查远端共享节点目录 | 契约 §4.8；ai-docs 2.2 |
| 9 | `ConfigDetail` | 配置 | ReadOnly | 读一套配置的节点集、DNS、布局 | 契约 §4.23；product §3.2 |
| 10 | `ConfigUpdate` | 配置 | Write | 编辑配置（名称 / 分流 / DNS / 节点集） | 契约 §4.25；ai-docs 2.2 |
| 11 | `ConfigSetMode` | 配置 | Execute | 在线切换 Tun / Proxy 接管方式（有确认卡） | 契约 §4.49；kickoff:123 |
| 12 | `NodeImportUrl` | 节点 | Write | 从 HTTPS 订阅解析并导入 ss:// 节点 | 契约 §4.10；kickoff:80,121 |
| 13 | `NodeImportText` | 节点 | Write | 解析粘贴的 ss:// 并导入节点池 | 契约 §4.10.1；kickoff:79,121 |
| 14 | `NodeCreate` | 节点 | Write | 手动创建一个 Shadowsocks 节点 | 契约 §4.26；kickoff:81,121 |
| 15 | `NodeSwitch` | 节点 | Execute | 切换一套配置的当前节点 | 契约 §4.27；product §3.2 |
| 16 | `NodeProbe` | 节点 | Write | 测单个节点连通性与延迟 | 契约 §4.28；product §3.2（测速） |
| 17 | `RouteGet` | 分流 | ReadOnly | 读分流模式、目标分类与生效状态 | 契约 §4.36；提示词未点名 |
| 18 | `RouteSetMode` | 分流 | Execute | 切换 direct / proxy_all | 契约 §4.37；kickoff:122 |
| 19 | `RouteTargetsSet` | 分流 | Write | 整体替换「指定服务」分类集合 | 契约 §4.38；zh product:53（分类） |
| 20 | `CategoryList` | 分流 | ReadOnly | 列出可用于「指定服务」的分类 | 契约 §4.42；zh product:53（分类列表） |
| 21 | `RulesStatus` | 分流 | ReadOnly | 读规则数据版本与新鲜度 | 契约 §4.43；提示词未点名 |
| 22 | `VpnConnect` | 连接 | Execute | 连接并设置系统代理 / TUN | 契约 §4.11；kickoff:124 |
| 23 | `VpnDisconnect` | 连接 | Write | 断开并恢复系统代理 | 契约 §4.12；product §3.1（主按钮） |
| 24 | `DiagRun` | 诊断 | ReadOnly | 跑一次完整网络诊断 | 契约 §4.13；product §3.7、ai-docs #2 |
| 25 | `HttpCheck` | 诊断 | ReadOnly | 只读检查一个 https 地址能否打开 | 契约 §4.54；无用户入口（AI 自查） |
| 26 | `IssueReport` | 报告 | Write | 两阶段生成桌面问题报告 | 契约 §4.46；product #5 |
| 27 | `submit_issue_to_public_wall` | 问题墙 | Write | 发到公开问题墙（有确认卡） | 契约 §4.56；无 UI 入口 |
| 28 | `read_public_issue_wall` | 问题墙 | ReadOnly | 搜索 / 读取公开问题墙 | 契约 §4.57；无 UI 入口 |
| 29 | `DeepseekSetupKey` | AI | ReadOnly | 给出创建 DeepSeek Key 的步骤 | 契约 §4.14；product §3.6（AI） |
| 30 | `DeepseekSaveKey` | AI | Write | 保存 DeepSeek Key 并尽量验证 | 契约 §4.15；product §3.6（AI） |
| 31 | `JobGet` | 长任务 | ReadOnly | 查长任务状态、进度与发起方 | 契约 §4.16；ai-docs 2.6 |
| 32 | `NetConfigGet` | 网络 | ReadOnly | 读系统代理、DNS、路由、监听端口 | 契约 §4.18；ai-docs 2.6 |
| 33 | `NetRepair` | 网络 | Execute | 受限网络修复（恢复直连 / 刷 DNS / 改代理） | 契约 §4.19；product §3.6 |
| 34 | `CatalogRefresh` | 免费节点 | Write | 拉取并应用 Veyl 免费节点 | 契约 §4.20；kickoff:73,90,92,121 |
| 35 | `DefaultProfileStatus` | 免费节点 | ReadOnly | 读免费节点缓存状态（不联网） | 契约 §4.21；product §3.6 |
| 36 | `SetUserRegion` | 地区 | Write | 记录用户所在地区 | 契约 §4.47；系统环境段 mod.rs:205/225 |
| 37 | `MyServers` | 服务器 | ReadOnly | 列我的服务器与状态 | 契约 §4.48；product §3.3 |
| 38 | `MyServerFailure` | 服务器 | ReadOnly | 读某台服务器创建失败详情 | 契约 §4.51；product #7、ai-docs #7 |
| 39 | `NodeRotateCredentials` | 服务器 | Execute | 更换某台服务器的连接密码（有确认卡） | 契约 §4.55；product #10（未点名） |
| 40 | `OpenSettings` | 设置 | ReadOnly | 打开设置并指向某段 / 某行 | 契约 §4.50；product §3.6（咨询 AI） |
| 41 | `StageSelect` | 建机 | Write | 把地区 / 规格选进新建节点舞台 | 契约 §4.52；product #6、ai-docs #6 |
| 42 | `CatalogOptions` | 建机 | ReadOnly | 读建机可选地区与规格 | 契约 §4.53；product #6 |
| 43 | `AskUserQuestion` | 会话 | None（沿用内置） | 向用户提问并等待回答；Veyl 包装了参数校验 | 契约 §4.22；kickoff:10,40,113 |

> 计数：注册表 43 项 = 42 个产品工具 + 1 个 `AskUserQuestionGuard`；再加 6 个基础文件工具，共 49 个工具定义。`ai-docs-management.md:298` 的「42 个」不含 guard，口径一致。

---

## 2. 按域清单

### 2.1 运行时与运行库（7）

| 工具 | 权限 | 入参（* 必填） | content（模型可见） | facts | changed（成功 / 失败） |
|---|---|---|---|---|---|
| `RuntimeStatus` | ReadOnly | `include_traffic`（schema 有，实现忽略） | `运行状态 {state}，运行时 {v}（{source}），出口 {ip}。` / `未连接。` | `runtime.connected` / `runtime.disconnected`、`runtime.version`、`runtime.exit_ip` | none / none |
| `RuntimeStart` | Write | `{}` | `运行时已启动。` | — | none / unknown 或 restored |
| `RuntimeStop` | Write | `{}` | `运行时已停止，系统代理已恢复。` | — | none / unknown 或 restored |
| `RuntimeRestart` | Write | `{}` | `运行时已重启。` | — | none / unknown 或 restored |
| `RuntimeLogs` | ReadOnly | `lines`、`level` | `最近 N 行运行时日志：…` / `运行时日志为空…` | `runtime.logs_empty` / `runtime.logs_recent` | none / none |
| `CoreListVersions` | ReadOnly | `{}` | `已安装：… 可安装：…` + 「高级设置 → 运行库」 | `core.active_version` / `core.no_active`、`core.installed_count`、`core.latest_version` | none / none |
| `CoreUpgrade` | Execute | `version` | `已开始升级到 X（任务 job）。{生效时机}。` / `已是最新版本…` | `core.version_change` + `effect.reconnect` / `effect.next_connect`；失败 `core.current_version` | none / none |

实现位置：`runtime.rs:37-411`、`core.rs:21-146`、`core_upgrade.rs:38-730`。

要点：

- `RuntimeStatus` 的 `include_traffic` 只出现在 schema（`runtime.rs:53-61`），`execute` 参数是 `_input`（`runtime.rs:63`），服务层 `runtime_status()` 也不接这个参数。
- `RuntimeStart` 的 schema 是空的（`runtime.rs:211-213`），固定调用 `runtime_start(None)`（`runtime.rs:216`）；契约却写了可选 `config_id`（`tools.md:450-458`）。
- `RuntimeStop` / `RuntimeRestart` 通过宏生成，schema 也是空的（`runtime.rs:172-174`、`:224-240`）；契约分别写了 `force`（`tools.md:488-495`）和 `reason`（`tools.md:517-524`）。
- `CoreListVersions` 的 summary 指引「高级设置 → 运行库」（`core.rs:139-140`），当前产品里是「设置 › 高级 › 更新与诊断 › 连接程序 / 更新后台组件」（`product.md:131-134`）。

### 2.2 目录、免费节点与建机目录（5）

| 工具 | 权限 | 入参（* 必填） | content（模型可见） | facts | changed（成功 / 失败） |
|---|---|---|---|---|---|
| `CatalogSearch` | ReadOnly | `region`、`protocol`、`limit`、`cursor` | `找到 N 个节点：- id \| 地点 \| 协议 \| 延迟 \| 健康` | `catalog.node_count` | none / none |
| `CatalogRefresh` | Write | `force` | `Veyl 免费节点已检查（N 个）` | `net.free_node_count` | none / none |
| `DefaultProfileStatus` | ReadOnly | `{}` | `Veyl 免费节点 N 个 · 检查于 T` / `还没有缓存…` | `net.free_node_count` / `net.free_cache_missing` | none / none |
| `CatalogOptions` | ReadOnly | `{}` | 地区 `名称（id）` + 规格 `名称（id） 每天 $X · 每月 N GB · 可用地区：…` | `catalog.region_count`、`catalog.plan_count` | none / none |
| `StageSelect` | Write | `region` / `plan`（至少一个） | `已把「东京」…发给新建节点舞台。` | `region.name` / `plan.label` | none / none |

实现位置：`catalog.rs:21-186`、`net.rs:197-311`、`stage_select.rs:148-454`。

要点：

- `CatalogSearch` 查远端节点目录（`catalog.rs:27-30`），`CatalogOptions` 查建机目录（`stage_select.rs:380-383`）；两者都叫 catalog，但不是同一数据源。
- `CatalogRefresh` 写免费节点缓存（`net.rs:203-207`），`DefaultProfileStatus` 只读同一份缓存（`net.rs:261-263`），并共用同一个 fact `net.free_node_count`（`net.rs:232-235`、`:298-301`）。
- `CatalogRefresh` 的 summary 只有节点数（`net.rs:230`）；`changed` / `offline` / `version` 都在 `data` 里，模型看不到「这次是否真的更新、还是用了缓存」。
- `StageSelect` 只写界面选择：校验目录（`stage_select.rs:87-123`）、发 `stage-select` 事件（`stage_select.rs:197-203`），前端在舞台未打开或创建中时直接忽略（`src/App.tsx:1101-1115`）。
- `CatalogOptions` 的 `content` 已经带上完整可调用清单（`stage_select.rs:251-362`），这是少数「模型需要的事实就在 content 里」的工具。

### 2.3 配置、节点与接管方式（8）

| 工具 | 权限 | 入参（* 必填） | content（模型可见） | facts | changed（成功 / 失败） |
|---|---|---|---|---|---|
| `ConfigDetail` | ReadOnly | `config_id` | `配置「name」：N 个节点` + `- id \| 名称 \| server:port [\| 当前]` | `config.name`、`config.node_count`、`config.current_node` | none / none |
| `ConfigUpdate` | Write | `config_id`*、`name`、`routing_mode`、`dns`、`tun_excludes`、`node_ids`、`targets` | `配置已更新，下一次连接生效。` | `config.name` | none / unknown |
| `ConfigSetMode` | Execute | `mode`*、`config_id` | `已切换到「Tun 模式」，连接已恢复。` / `已经是…没有改动。` / `已换成…下次连接生效。` | `mode.current` + `connection.state` / `effect.next_connect` | none / restored 或 unknown |
| `NodeImportUrl` | Write | `url`*、`config_id` | `导入 N 个节点，跳过 M 个。请复述节点名、地址、端口与加密方式…` | `import.added` / `import.skipped` | none / unknown |
| `NodeImportText` | Write | `text`*、`config_id` | 同上 | `import.added` / `import.skipped` | none / unknown |
| `NodeCreate` | Write | `name`*、`server`*、`port`*、`method`*、`password`*、`config_id` | `节点「name」已创建。` | `node.name` | none / unknown |
| `NodeSwitch` | Execute | `config_id`*、`node_id`* | `已切换节点（热切，连接未中断）。` / `已切换当前节点（未连接，未启动 VPN）。` / `当前节点没有变化。` | `connection.state` 或 `effect.next_connect` | none / unknown |
| `NodeProbe` | Write | `node_id`* | `节点可达，延迟 N ms。` / `节点不可达。` / `暂时测不了…` | `probe.latency_ms` / `probe.unreachable` / `probe.untested` | none / unknown（超时报错） |

实现位置：`configs.rs:61-748`、`config_mode.rs:82-451`。

要点：

- `ConfigDetail` 的服务层确实算出了 `nodes[].source` 与 `unavailable_reason`（`services.rs:3932-3961`），但 summary 只打印 id / 名称 / `server:port`（`configs.rs:41-59`），**没有把 `source` / `unavailable_reason` 写进模型可见的 content**。契约却要求「回答哪个节点能不能用以本工具为准」（`tools.md:1325-1326`）。
- `ConfigUpdate` 的 description 明确写「没有 connect_mode」（`configs.rs:155-156`），schema 也没有它（`configs.rs:163-178`），但 `execute` 仍然读 `input.get("connect_mode")` 并传给服务层（`configs.rs:241-244`）。模型如果绕过 schema 传这个键，它会被静默接受。
- `ConfigUpdate` 仍暴露 `targets`（`configs.rs:173`、`:234-240`）；契约已把它标为「已废弃，不产生任何效果」（`tools.md:1388`）。
- `NodeImportUrl` / `NodeImportText` 的 summary 要求模型「复述节点名、地址、端口与加密方式」（`configs.rs:541`、`:633`），但解析结果只放在 `data` 里，content 只有计数。模型没有可复述的字段。
- `NodeProbe` 的权限是 `Write`，注释写明「探不通时会把已停机销毁的隧道停掉，不再是纯只读」（`configs.rs:372-376`）；但 `display.rs:233-255` 的 `is_readonly()` 仍把 `NodeProbe` 列为只读，失败时会强制 `changed=none`（`envelope.rs:205-208`）。这是同一份代码里的直接冲突。
- `NodeSwitch` 的 summary 不带节点名（`configs.rs:319-340`），但工具签名只有 `node_id`，模型可以用用户当轮说的名称转述；不算硬缺口。

### 2.4 分流与规则（5）

| 工具 | 权限 | 入参（* 必填） | content（模型可见） | facts | changed（成功 / 失败） |
|---|---|---|---|---|---|
| `RouteGet` | ReadOnly | `config_id` | `分流模式 {mode}，当前生效 {applied}。生效状态：{effective}。` | `routing.mode`、`routing.category_count`、`effect.next_connect` | none / none |
| `RouteSetMode` | Execute | `mode`*、`config_id`、`confirm_reconnect` | `分流模式已热切换为 {mode}…` / `已保存为…自动重连失败…` | `connection.state`、`routing.ownership`、`routing.reconnect_failed`、`routing.service_count` | none / restored 或 unknown |
| `RouteTargetsSet` | Write | `config_id`*、`categories`* | `指定服务已更新，下一次连接生效。` | `routing.service_count`、`effect.next_connect` | none / none |
| `CategoryList` | ReadOnly | `query`、`limit` | `找到 N 个分类。` | `routing.category_count` | none / none |
| `RulesStatus` | ReadOnly | `{}` | `规则数据版本 {v}，可能已过期。` | `rules.version`、`rules.status` | none / none |

实现位置：`routing.rs:230-585`。

要点：

- 这组工具是为旧的 `proxy_selected`（按服务分流）保留的。产品现在只有「智能 / 全局」两档，没有按服务挑选（`product.md:38`；`simplified-config-create.md:847-853`）。契约也写明 `RouteTargetsSet`「只对旧数据的 `proxy_selected` 有意义」（`tools.md:1590`）。
- `RouteGet` 的 summary 直接输出 `direct` / `proxy_all` / `next_connection`（`routing.rs:220-227`）；`RouteSetMode` 的 summary 输出 `分流模式已热切换为 {mode}`，失败分支甚至输出 `state={state}`（`routing.rs:58-103`）。这两个工具的 description 却要求「不出现分流、规则集、rule、category id」（`routing.rs:247`、`:321`）。
- `CategoryList` 的 summary 只有「找到 N 个分类」（`routing.rs:503`），真正的 `categories` 在 `data` 里。模型看不到分类 id，无法完成它被描述为「唯一入口」的映射工作。

### 2.5 连接（2）

| 工具 | 权限 | 入参（* 必填） | content（模型可见） | facts | changed（成功 / 失败） |
|---|---|---|---|---|---|
| `VpnConnect` | Execute | `config_id` | `已连接：配置「name」，节点「node」，代理地址 127.0.0.1:port，出口 IP …` / `已启动 TUN：…` | `config.name`、`node.name`、`runtime.exit_ip` | none / restored 或 unknown |
| `VpnDisconnect` | Write | `{}` | `已断开，系统代理已恢复。` | `connection.state` = restored | none / unknown |

实现位置：`vpn.rs:11-468`。

要点：

- `VpnConnect` 的 summary 明确包含代理地址与端口（`vpn.rs:107`），description 却写「只说「已经连上了」；不提代理端口、入站、selector、路由表」（`vpn.rs:32`）。模型拿到的 content 与它被要求说的内容相反。
- TUN 分支的 summary 使用 `已启动 TUN`、`TUN 设备已就绪、默认路由已指过来` 等词（`vpn.rs:167-218`），系统提示词把单独使用 `TUN` 指实现算实现词（`system.md:60`）。
- `VpnConnect` 的成功 `data` 按契约就是 `RuntimeSnapshot` + 顶层 `exit_ip`（`tools.md:743-751`），与 `RuntimeStatus` 的 `data` 高度重叠。
- `VpnDisconnect` 在代理未恢复时返回失败并给 `NetRepair` 的下一步（`vpn.rs:458-468`），这是少数「失败时模型拿得到完整下一步」的实现。

### 2.6 诊断与网络（4）

| 工具 | 权限 | 入参（* 必填） | content（模型可见） | facts | changed（成功 / 失败） |
|---|---|---|---|---|---|
| `DiagRun` | ReadOnly | `include_logs` | `诊断通过，没有发现异常。` / `诊断完成，有几项这次没检查。` / `诊断完成，有检查项未通过，详情见 data.checks。` | `diag.result`、`scope.no_http3` | none / none |
| `HttpCheck` | ReadOnly | `url`*、`timeout_ms` | `网页返回 {status}` / `没访问成功` | `http.status_code`、`http.elapsed_ms`、`http.redirects`、`http.server`、`http.captcha_required` / `http.error` | none / none |
| `NetConfigGet` | ReadOnly | `{}` | `读取到 N 个网络服务的代理设置；默认接口 {iface}。` | `net.service_count`、`net.default_interface` | none / none |
| `NetRepair` | Execute | `action`*、`port` | 服务层返回的一句 `detail` | — | none / unknown（校验失败时也失败） |

实现位置：`diag.rs:11-136`、`http_check.rs:492-732`、`net.rs:52-185`。

要点：

- `DiagRun` 的整个诊断明细在 `data.checks`（`diag.rs:86-120`），summary 在失败时直接写「详情见 data.checks」——但模型看不到 `data`。这是本次审计里最直接的「工具让模型去看它看不到的东西」。
- `HttpCheck` 的 summary 只有状态码 / 「没访问成功」（`http_check.rs:667-694`）；契约要求模型「先看 `via` 再解释结果」（`tools.md:2104`），`via` 只在 `data` 里。
- `NetConfigGet` 的 summary 只有网络服务数量与默认接口（`net.rs:90-95`）；系统代理、DNS、路由、监听端口都在 `data` 里。工具存在的主要目的（解释「为什么连不上」）在 content 里没有材料。
- `NetRepair` 的 summary 直接用 `data.detail`（`net.rs:160-168`），是少数把关键事实放进 content 的工具。

### 2.7 问题报告与问题墙（3）

| 工具 | 权限 | 入参（* 必填） | content（模型可见） | facts | changed（成功 / 失败） |
|---|---|---|---|---|---|
| `IssueReport` | Write | `log_lines`、`include_domains`、`report_markdown` | `问题报告已生成。` / `现场材料已收集，接下来把报告写进同一个文件夹。` | `report.location`、`report.log_count`；`actions` = reveal / mail | none / none |
| `submit_issue_to_public_wall` | Write | `title`*、`summary`*、`expected`*、`actual`*、`repro`*、`diagnosis`* | `已发到问题墙：{title}（{url}）` / `已经上报过…` | — | none / none 或 unknown |
| `read_public_issue_wall` | ReadOnly | `query`、`issue_id`、`platform`、`stage`、`limit` | 列表或单帖正文、答复（`render_list` / `render_thread`） | — | none / none |

实现位置：`issue_report.rs:22-181`、`issue_wall.rs:87-653`。

要点：

- `IssueReport` 的第一阶段把 `materials`（runtime、checks、logs 行号、domains）放在 `data`（契约 `tools.md:1752`），summary 只有一句「材料已收集」。第二阶段要求模型写 `report_markdown`，但模型既看不到 `materials`，也看不到 `report_dir`（只在 `data` / facts），无法按契约引用 `日志/<文件>:<行号>`。
- `IssueReport` 的两个 `actions` 由 Host 填并且只带 `report_id`（`issue_report.rs:150-155`），这部分是符合契约的。
- `submit_issue_to_public_wall` 的 summary 带标题与链接（`issue_wall.rs:336-350`），符合「发到问题墙」的可见结果；失败时给 `IssueReport` / `OpenSettings` 下一步（`issue_wall.rs:162-187`）。
- `read_public_issue_wall` 的 content 由 `render_list` / `render_thread` 生成（`issue_wall.rs:760-850`），是少数把完整结果放进 content 的工具。

### 2.8 AI 服务与设置（4）

| 工具 | 权限 | 入参（* 必填） | content（模型可见） | facts | changed（成功 / 失败） |
|---|---|---|---|---|---|
| `DeepseekSetupKey` | ReadOnly | `{}` | `已给出获取 Key 的步骤，拿到后直接粘贴到输入框即可。` | — | none / none |
| `DeepseekSaveKey` | Write | `key`* | `Key 已保存到系统钥匙串，并验证可用。` / `…验证失败…` / `…无法联网验证…` | `deepseek.verify` | none / unknown |
| `OpenSettings` | ReadOnly | `section`*、`row` | `已打开设置里的「连接」并定位到对应行。` / `已打开设置里的「连接」。` | — | none / none |
| `SetUserRegion` | Write | `region`* | `已记下地区：{label}` | `region.code` | none / unknown |

实现位置：`deepseek.rs:13-146`、`settings.rs:97-184`、`region.rs:13-102`。

要点：

- `DeepseekSetupKey` 的 url 与 steps 只在 `data`（`deepseek.rs:39-48`），summary 只说「已给出步骤」。模型看不到步骤。
- `DeepseekSaveKey` 的 summary 与 description 说「系统钥匙串」（`deepseek.rs:71`），契约 §3 表与 §4.15 说「本地加密文件」（`tools.md:305`、`:1037`）。契约还定义了 `validation_detail`（`tools.md:1029`、`:1048-1055`），实现只读 `validation`，不处理 `insufficient_balance`（`deepseek.rs:118-137`）。
- `OpenSettings` 的行 id 只有 12 个（`settings.rs:17-30`）；产品 §3.6 里的 `语言`、`生成问题报告`、`清除残留代理`、`复制诊断信息` 都没有对应 row id（`Settings.tsx` 中这些行没有 `pointAttrs`）。
- `SetUserRegion` 是唯一「写全局设置」的工具；它的调用指引不在提示词文件里，而在系统环境段（`mod.rs:205-206`、`:225-226`）。

### 2.9 服务器（3）

| 工具 | 权限 | 入参（* 必填） | content（模型可见） | facts | changed（成功 / 失败） |
|---|---|---|---|---|---|
| `MyServers` | ReadOnly | `{}` | 逐台 `id \| 名称 \| 地区 \| 状态 \| 地址 \| 每天 X 美元 [\| 可建配置]` | `servers.empty` 或 `server.row`（最多 8 行） | none / none |
| `MyServerFailure` | ReadOnly | `serverId`* | `{name}（状态）这次失败在「阶段」：{message}，是否可重试。…` / 记录不完整 / 无记录 | `server.failure_code`、`server.stage`、`server.retryable` / `server.record_incomplete` + `server.advice_rebuild` / `server.no_record` | none / none |
| `NodeRotateCredentials` | Execute | `server_id`* | `连接密码已更换（新端口 N）。当前连接仍在用旧端口，断开后重新连接才会生效。` | `node.new_port`、`node.credential_refresh_failed` | unknown / none |

实现位置：`my_servers.rs:141-575`、`node_rotate.rs:620-729`。

要点：

- `MyServers` 的 description 与英文描述写「月费 / monthly price」（`my_servers.rs:158`、`description.rs:33`），summary 实际打印「每天 X 美元」（`my_servers.rs:235-239`）。契约 §4.48 要求摘要按「每天价格」（`tools.md:1821`），所以是 description 与 summary 不一致。
- `MyServers` 的 summary 带 `server_id`，这是给模型调用 `NodeRotateCredentials` 用的；description 已写明不要念给用户（`my_servers.rs:162`）。
- `MyServerFailure` 的入参是 camelCase `serverId`（`my_servers.rs:489`），其余工具全部用 snake_case。契约也是 `serverId`（`tools.md:1960`），所以这是一处有意的例外，但与整体命名不一致。
- `NodeRotateCredentials` 的 `success_outcome` 把 `changed` 设为 `Unknown`（`node_rotate.rs:728`），随后被 `normalize_display` 的成功分支压成 `none`（`envelope.rs:200-203`）。契约也要求成功时 `display.changed = "none"`（`tools.md:2156`），所以运行时结果一致，但代码写法容易误读。

### 2.10 长任务与会话（2）

| 工具 | 权限 | 入参（* 必填） | content（模型可见） | facts | changed（成功 / 失败） |
|---|---|---|---|---|---|
| `JobGet` | ReadOnly | `job_id`* | `任务 {job_id} 当前状态 {state}。` | `job.state`、`job.progress` | none / none |
| `AskUserQuestion`（包装） | None（沿用内置） | 内置 schema | 由 claurst 返回 | — | — |

实现位置：`job.rs:21-76`、`mod.rs:51-98`。

要点：

- `JobGet` 的 summary 只给状态（`job.rs:70`），`stage` / `progress` / `message` / `origin` 都在 `data` 里；模型看不到进度，description 却要求「说进度和阶段白话名；不出现 job id」（`job.rs:28`），而 summary 恰好包含 job id。
- `AskUserQuestionGuard` 不是产品能力，只做三件事：把内置 description 加一行约束、校验 `options` 非空、其余委托（`mod.rs:53-98`）。契约 §4.22 写「Veyl 不重写这个工具，只负责接线」（`tools.md:1287`），与实现不一致。

### 2.11 基础文件工具（6）

| 工具 | 权限 | 说明 |
|---|---|---|
| `Read` | ReadOnly | 读本地文本文件；每行带行号；图片 / PDF 不解码（`claurst/.../file_read.rs:39-50`） |
| `Edit` | Write | 精确字符串替换（`file_edit.rs:29-48`） |
| `Write` | Write | 写文件（`file_write.rs:22-33`） |
| `Bash` | Execute | 真实 PTY 里跑 bash（`pty_bash.rs:1363-1380`） |
| `Glob` | ReadOnly | 文件模式匹配（`glob_tool.rs:24-36`） |
| `Grep` | ReadOnly | 内容搜索（`grep_tool.rs:74-86`） |

注册方式：`claurst_session/mod.rs:106-116`，`Bash` 等工具 `self_gates` 为 true，但会话权限模式是 `BypassPermissions`、handler 一律 Allow（`mod.rs:102-105`）。它们不在 `docs/contracts/tools.md` §3 的 43 个工具表里，也没有 Veyl 的英文描述包装。

### 2.12 入口与工具的对应

下表把入口 / 流程与相关工具对上；「点名」严格指文档里出现过工具名，分类见本节末尾。

| 入口 / 流程 | 文档 | 相关工具 |
|---|---|---|
| 首启引导 | `kickoff.md:10,40,73,79-81,113,121-124` | `AskUserQuestion`、`CatalogRefresh`、`NodeImportText`、`NodeImportUrl`、`NodeCreate`、`RouteSetMode`、`ConfigSetMode`、`VpnConnect` |
| 连接失败 hero | `product.md:140`、`ai-docs-management.md:33` | `DiagRun` |
| 设置页咨询 AI | `product.md:84`、`ai-docs-management.md:34` | `OpenSettings`（指路）；其余靠注入的事实 |
| 设置 › 连接 › 新建节点 | `product.md:156`、`ai-docs-management.md:35` | 不带文本；没有工具被点名 |
| 报告问题 | `product.md:157`、`ai-docs-management.md:36` | `IssueReport` |
| 建机向导「让 AI 帮我选」 | `product.md:158`、`ai-docs-management.md:37` | `StageSelect`、`CatalogOptions` |
| 服务器详情「AI 定位」 | `product.md:159`、`ai-docs-management.md:38` | `MyServerFailure` |
| 手机使用「不会操作？问 AI」 | `product.md:160`、`ai-docs-management.md:39` | 没有工具（见 G7） |
| 右栏空态预设问题 | `product.md:161`、`ai-docs-management.md:40` | 没有固定工具 |
| 节点测不通（自有 / 非自有） | `product.md:162`、`ai-docs-management.md:41` | `DiagRun`；非自有节点的「智能恢复」对应 `NodeRotateCredentials`（未点名） |
| 诊断面板「去问 AI」 | `product.md:163`、`ai-docs-management.md:42` | `DiagRun` 的输出作为上下文 |
| 环境段（每轮注入） | `mod.rs:205-206`、`:225-226` | `SetUserRegion` |

只有契约 + 设计文档、没有产品提示词或界面入口点名的工具：

- `submit_issue_to_public_wall`、`read_public_issue_wall`：契约 §4.56 / §4.57；`ai-docs-management.md:306` 只写了错误的大小写形式，产品提示词里没有。
- `RouteTargetsSet`、`RulesStatus`：契约 §4.38 / §4.43；`ai-docs-management.md` 附录列了名字，产品提示词里没有；`CategoryList` 只在中文 `product.md:53` 以「分类列表」出现。
- `CatalogSearch`、`ConfigUpdate`、`HttpCheck`、`JobGet`、`NetConfigGet`、`RuntimeLogs`、`CoreListVersions`、`CoreUpgrade`、`RuntimeStatus` / `Start` / `Stop` / `Restart`、`DeepseekSetupKey` / `DeepseekSaveKey`：只在 `ai-docs-management.md` 的 §2 / 附录里被列名，没有产品提示词或界面入口直接点名。
- `ConfigDetail`、`NodeSwitch`、`NodeProbe`、`DefaultProfileStatus`、`MyServers`：产品文档描述了对应功能（读配置详情、切节点、测速、更新免费节点、我的服务器），但没有写工具名；`ai-docs-management.md` 附录列了名字。

### 2.13 入参闭集与边界（按域汇总）

| 域 | 闭集 / 边界 |
|---|---|
| 运行时 | `RuntimeStatus.include_traffic`：boolean；`RuntimeLogs.lines`：1–500，`level` ∈ `debug` / `info` / `warn` / `error`；`CoreUpgrade.version`：`^\d+\.\d+\.\d+$`（可选） |
| 目录 / 建机 | `CatalogSearch.protocol` ∈ `vless_reality` / `hysteria2` / `shadowsocks`，`region` 匹配 `^[a-z]{2}$`，`limit` 1–50；`StageSelect.region` / `plan` 各 1–40 字符、至少给一个；`CatalogOptions` 无参数 |
| 配置 / 节点 | `ConfigUpdate.routing_mode` ∈ `direct` / `proxy_all`，`name` ≤40；`ConfigSetMode.mode` ∈ `system_proxy` / `tun`，不接受 `confirm`；`NodeCreate.port` 1–65535，`password` 标记 `sensitive` 且 ≤256；`NodeImportText.text` ≤65536；`NodeProbe.node_id` 必填 |
| 分流 | `RouteSetMode.mode` ∈ `direct` / `proxy_all`，`confirm_reconnect` boolean；`CategoryList.limit` 1–200；`RouteTargetsSet.categories` 为字符串数组，`config_id` 必填 |
| 连接 | `VpnConnect.config_id` 可选；`VpnDisconnect` 无参数 |
| 诊断 / 网络 | `HttpCheck.url` 1–2048 字符，`timeout_ms` 1000–15000；`NetRepair.action` ∈ `restore_direct` / `flush_dns` / `set_proxy` / `clear_proxy`，`port` 1024–65535；`DiagRun.include_logs` boolean |
| 报告 / 问题墙 | `IssueReport.log_lines` 40–400，`report_markdown` ≤131072，不接受 `path` / `file` / `dir`；`submit_issue_to_public_wall.title` 8–120、`summary` 30–2000、`expected` / `actual` / `repro` ≤500，`diagnosis.stage` ∈ `connectivity` / `config_update` / `rotate` / `ai`，`steps` ≤3；`read_public_issue_wall.query` ≤100、`issue_id` ≤32、`platform` ∈ `macos` / `windows` / `linux`、`stage` 同上、`limit` 1–20 |
| AI / 设置 | `DeepseekSaveKey.key` 20–200 且以 `sk-` 开头；`OpenSettings.section` ∈ `ai` / `connection` / `account` / `advanced`，`row` 只认 12 个登记行；`SetUserRegion.region` 匹配 `^[A-Za-z]{2}$` |
| 服务器 | `MyServers` 无参数；`MyServerFailure.serverId` 非空；`NodeRotateCredentials.server_id` 非空，只接受 `srv_` + base64url 字符 |
| 长任务 / 会话 | `JobGet.job_id` 必填；`AskUserQuestion` schema 来自 claurst，Veyl 额外要求 `options` 为非空字符串数组 |

---

## 3. 四类问题

### 3.1 重复 / 重叠

#### R1 `ConfigUpdate` 与 `RouteSetMode` 都能改 `routing_mode`

- `ConfigUpdate` description：「编辑一套配置（名称 / 分流 / DNS / 节点集）。分流只有 direct / proxy_all 两档。」（`configs.rs:155-156`）
- `ConfigUpdate` schema 有 `routing_mode`（`configs.rs:169`），并传给服务层（`configs.rs:211-220`）。
- `RouteSetMode` description：「切换分流模式，只有 direct / proxy_all 两档；已连接时热切不断流。」（`routing.rs:320-321`）
- `RouteSetMode` schema 有 `mode`（`routing.rs:333`）。
- 契约同时承认两条路径：§4.25 允许 `ConfigUpdate.routing_mode`（`tools.md:1373`），§4.37 允许 `RouteSetMode.mode`（`tools.md:1551`）。
- 差别只在副作用：`ConfigUpdate` 是「下一次连接生效」，`RouteSetMode` 可热切或重连。模型需要自己判断该用哪个。

#### R2 `ConfigUpdate.targets` 与 `RouteTargetsSet.categories` 做同一件事

- `ConfigUpdate` 仍暴露 `targets`（`configs.rs:173`、`:234-240`）。
- `RouteTargetsSet` 的职责就是整体替换分类集合（`routing.rs:392-394`、`:406`）。
- 契约已把 `ConfigUpdate.targets` 标成「已废弃，不产生任何效果」（`tools.md:1388`），但 schema 没有删。

#### R3 `ConfigDetail` 与 `MyServers` 都报节点 / 服务器状态

- `ConfigDetail` summary 逐条列节点 `id | 名称 | server:port | 当前`（`configs.rs:41-59`）。
- `MyServers` summary 逐台列 `id | 名称 | 地区 | 状态 | 地址 | 每天价格`（`my_servers.rs:211-249`）。
- 两者都能回答「这个节点 / 服务器能不能用」。契约自己写了分工：`ConfigDetail` 的 `unavailable_reason` 只能确定「服务器已销毁」，分不清停机删除与用户销毁，要看 `MyServers.destroyed_reason`（`tools.md:1325-1326`）。分工有文档，但模型必须同时知道两个工具。

#### R4 `CatalogRefresh` 与 `DefaultProfileStatus` 都描述免费节点

- `CatalogRefresh` 拉取并应用 `veyl_seed.json`（`net.rs:203-207`）。
- `DefaultProfileStatus` 读同一份缓存（`net.rs:261-263`）。
- 两者共用 `net.free_node_count`（`net.rs:232-235`、`:298-301`）。一个写、一个读，状态与动作没有合并入口。

#### R5 `DiagRun`、`HttpCheck`、`NodeProbe` 都涉及连通性

- `DiagRun` 覆盖「运行时 / 进程 / 控制面 / 数据面、系统代理、DNS、默认路由、出口 IP、免费节点源 / GitHub / DeepSeek 可达性」（`diag.rs:54-59`）。
- `HttpCheck` 只查一个 https 地址（`http_check.rs:636-640`）。
- `NodeProbe` 只测一个节点（`configs.rs:365-369`）。
- 三者都能回答「能不能访问某个目标」，但粒度、路径与结果形状完全不同；契约没有给「先 DiagRun 还是先 HttpCheck / NodeProbe」的统一规则。

#### R6 `RuntimeStatus` 与 `VpnConnect` / `VpnDisconnect` 反映同一状态

- `RuntimeStatus` 的 facts 是连接状态、版本、出口 IP（`runtime.rs:76-103`）。
- `VpnConnect` 返回的 `data` 按契约就是 `RuntimeSnapshot` + 顶层 `exit_ip`（`tools.md:743-751`），summary 也带配置、节点、出口（`vpn.rs:91-120`）。
- `VpnDisconnect` 返回 `connection.state = restored`（`vpn.rs:443-455`）。
- 三者的状态口径需要一致；目前 `VpnConnect` 还多了一层「TUN 是否确认接管」的文案（`vpn.rs:161-218`）。

#### R7 `NetConfigGet` 与 `RouteGet`：**不是重复**

- `NetConfigGet` 读的是操作系统层：逐网络服务的系统代理、DNS、默认路由、回环监听端口（`net.rs:68-71`）。
- `RouteGet` 读的是应用层配置：`routing_mode`、目标分类、是否生效（`routing.rs:246-247`）。
- 两者一个读系统、一个读配置，职责不重叠。此项是任务怀疑清单里的「排除项」。

#### R8 `CatalogSearch` 与 `CatalogOptions` 共用「catalog」一词

- `CatalogSearch` 查远端共享节点目录（`catalog.rs:27-30`）。
- `CatalogOptions` 查建机目录（地区 + 套餐，`stage_select.rs:380-383`）。
- 代码注释专门提醒过两者不是一个东西（`mod.rs:158`），契约也写了同一提醒（`tools.md:398`）。模型只看名字很容易选错。

#### R9 `NodeImportUrl` / `NodeImportText` / `NodeCreate` 是三条写节点的路径

- 三者都写同一个节点池，都返回 `import.added` / `import.skipped` 或 `node.name`（`configs.rs:527-538`、`:619-630`、`:740-742`）。
- 差别只在来源：订阅 URL、粘贴文本、手工四项。去重、跳过、密码处理都在服务层共用。
- 目前是三个工具，不是一个带 `source` 枚举的工具。

#### R10 `IssueReport` 与 `submit_issue_to_public_wall` 都生成问题报告

- `IssueReport` 把现场材料写成桌面报告（`issue_report.rs:47-55`）。
- `submit_issue_to_public_wall` 把问题发到公开问题墙，失败时下一步推荐 `IssueReport`（`issue_wall.rs:103-109`、`:167-171`）。
- 两者的诊断文本、脱敏规则、阶段划分有重叠，但输出介质不同（本地 vs 公开）。契约分别定义（`tools.md:1711-1774`、`:2159-2221`）。

#### R11 `MyServers` 与 `MyServerFailure` 都返回服务器状态

- `MyServers` 返回列表与 `state` / `failure` / `destroyed_reason`（`my_servers.rs:157-162`、`:78-95`）。
- `MyServerFailure` 返回单台的 `failure` / `order` / `recent_events`（`my_servers.rs:471-478`）。
- 设计上是「列表 → 详情」，但两个工具都能回答「这台为什么失败」，边界只写在 description 里。

### 3.2 过时

#### S1 工具描述仍按「多套配置」写，产品已收敛为单配置

- `ConfigDetail`：「读取一套配置…」（`configs.rs:78`）。
- `ConfigUpdate`：「编辑一套配置…」（`configs.rs:155`）。
- `NodeSwitch`：「切换一套配置的当前节点…」（`configs.rs:276`）。
- `RouteGet`：「读取一套配置的分流模式…」（`routing.rs:246-247`）。
- `VpnConnect`：「如果已经连着另一套配置，会先断开旧的再连新的」（`vpn.rs:28-30`）。
- 产品口径：「全局只有一个节点池、一套配置；没有新建配置、切换配置或配置列表」（`product.md:44`）。
- `ConfigList` / `ConfigCreate` / `ConfigDelete` 已从工具集移除（`mod.rs:171-172`、`tools.md:657-663`、`:1333-1361`、`:1105-1110`）。

#### S2 `ConfigUpdate` 描述说没有 `connect_mode`，实现仍接受

- 描述：`configs.rs:155-156`。
- 实现：`input.get("connect_mode")` 并传给服务层（`configs.rs:241-244`）。
- 契约要求带 `connect_mode` 时返回 `INVALID_ARGUMENT / connect_mode_immutable`（`tools.md:1386`）。工具层没有这个校验。

#### S3 `ConfigUpdate.targets` 已废弃但仍暴露

- schema：`configs.rs:173`；服务层透传：`configs.rs:234-240`。
- 契约：`tools.md:1388`「targets 已废弃，不产生任何效果」。
- 产品：没有按服务挑选（`product.md:38`）。

#### S4 `RouteTargetsSet` / `CategoryList` / `RulesStatus` 是旧 `proxy_selected` 时代的工具

- `RouteTargetsSet`：「整体替换「指定服务走 VPN」的分类集合」（`routing.rs:392-394`）。
- `CategoryList`：「列出可用于「指定服务走 VPN」的分类」（`routing.rs:466-467`）。
- `RulesStatus`：「读取规则数据版本与新鲜度」（`routing.rs:529-530`）。
- 产品：只有两档，没有按服务挑选（`product.md:38`；`kickoff.md:139`）。
- 契约：`RouteTargetsSet`「只对旧数据的 `proxy_selected` 有意义」（`tools.md:1590`）；`proxy_selected` 已不可写（`simplified-config-create.md:847-853`）。

#### S5 中文 `product.md` 仍让 AI 用「分类列表」写分类，英文版没有这一句

- 中文：`resources/prompts/zh/product.md:53`「写任何分类之前，先用分类列表取到合法分类名…」。
- 同文件 `:38`：「只有这两档，没有「按服务挑选」。」
- 英文版 `resources/prompts/en/product.md` 没有对应句子（只有 `:38` 的 no per-service selection）。
- 这是提示词内部的直接矛盾，也是与 S4 同一个旧能力。

#### S6 `RuntimeStart` / `RuntimeStop` / `RuntimeRestart` 的 schema 与契约不一致

- 契约 `RuntimeStart`：可选 `config_id`（`tools.md:450-458`）；实现 schema 为空、固定 `runtime_start(None)`（`runtime.rs:211-216`）。
- 契约 `RuntimeStop`：可选 `force`（`tools.md:488-495`）；实现 schema 为空、固定 `runtime_stop(false)`（`runtime.rs:224-231`）。
- 契约 `RuntimeRestart`：可选 `reason`（`tools.md:517-524`）；实现 schema 为空、固定 `runtime_restart(None)`（`runtime.rs:233-240`）。
- 结果：契约承诺的参数在模型侧不可用，模型无法指定 `force` 或 `reason`。

#### S7 `RuntimeStatus.include_traffic` 是死参数

- schema 有 `include_traffic`（`runtime.rs:53-61`）。
- `execute` 用 `_input`（`runtime.rs:63`），服务层 `runtime_status()` 不接参数。
- 契约 §4.1 把这个参数写进 schema（`tools.md:419-429`）。

#### S8 `CoreListVersions` 指引的「高级设置 → 运行库」已改名

- summary：`core.rs:139-140`「高级设置 → 运行库」。
- 产品：设置 › 高级 › `更新与诊断` › `连接程序` / `更新后台组件`（`product.md:131-134`）。

#### S9 `DeepseekSaveKey` 的存储说法与契约不一致

- 实现 description：「存进系统钥匙串」（`deepseek.rs:71`）。
- 契约 §3 表：「保存 Key 到本地加密文件」（`tools.md:305`）。
- 契约 §4.15：「已写入本地加密文件」（`tools.md:1037`）。
- 契约还定义了 `validation_detail`（`tools.md:1029`、`:1048-1055`），实现只读 `validation`（`deepseek.rs:118-137`），余额不足无法单独表达。

#### S10 契约 §2.4 仍引用已退役的 `first-run.md` 与已移除的 `capability_catalog`

- `tools.md:231` 把「怎么说话」指向 `resources/prompts/zh/first-run.md`。
- `ai-docs-management.md:268` 明确 `first-run.md` 已退役，拆成 `system.md` + `kickoff.md`。
- `tools.md:235`、`:262` 讨论 `capability_catalog` 只取 description 第一行；该能力清单已在渲染时删除（`mod.rs:133-135`；`ai-docs-management.md:139`）。

#### S11 契约 §3.1 的注册清单是旧代码

- `tools.md:341-395` 使用 `RuntimeStatusTool::new(rt.clone())` 等旧构造签名，并直接列 `AskUserQuestionTool::new()`。
- 实际注册是 `vpn_tools(Arc<dyn VpnToolServices>)`（`mod.rs:157-208`），`AskUserQuestion` 由 `AskUserQuestionGuard` 包装（`mod.rs:207`）。
- 这份清单不能照抄运行；它现在只是历史示意。

#### S12 `docs/design/tool-display.md` 仍列已删除工具，数量也对不上

- 文档头部写「工具集合为 42 个」（`tool-display.md:9`）。
- 映射表仍有 `ConfigList`、`ConfigCreate`、`ConfigDelete`（`tool-display.md:382-386`）。
- 末尾两个条目都编号 42（`CatalogOptions` 与 `submit_issue_to_public_wall`，`tool-display.md:415-416`）。
- 实际注册表 43 项，且 `ConfigList` / `ConfigCreate` / `ConfigDelete` 已移除（`mod.rs:171-172`）。

#### S13 `ai-docs-management.md` 附录的问题墙工具名写成了 PascalCase

- 附录：`SubmitIssueToPublicWall` / `ReadPublicIssueWall`（`ai-docs-management.md:306`）。
- 实际模型可见名：`submit_issue_to_public_wall` / `read_public_issue_wall`（`mod.rs:191-192`；`description.rs:30-31`；契约 `tools.md:282` 明确这两个是 snake_case 例外）。

#### S14 运行时工具描述里出现 `sing-box` / `runtime`，与系统提示词的禁词规则冲突

- `RuntimeStatus` description：「读取 sing-box 运行时的状态快照…」（`runtime.rs:44-46`）。
- `RuntimeStart`：「启动 sing-box 运行时进程…」（`runtime.rs:204`）。
- `RuntimeStop` / `RuntimeRestart`：同样含 `sing-box`（`runtime.rs:227`、`:236`）。
- 系统提示词：「不说实现词（… `sing-box` 这类）」；只有「Proxy 模式 / Tun 模式 / 智能 / 全局」可以原样说（`system.md:60`）。
- 同一段 description 末尾又要求模型「不出现 runtime、sing-box、进程名」（`runtime.rs:46`），形成自我矛盾。

#### S15 `VpnConnect` 的 content 包含它被要求绝口不提的代理端口

- description：「只说「已经连上了」；不提代理端口、入站、selector、路由表」（`vpn.rs:32`）。
- summary：`代理地址 127.0.0.1:{port}`（`vpn.rs:106-109`）。
- 模型看到 content 后可能直接复述，与 description 冲突。

#### S16 `RouteGet` / `RouteSetMode` 的 content 输出内部枚举值

- `RouteGet` summary：`分流模式 {mode}，当前生效 {applied}。生效状态：{effective}。`（`routing.rs:220-227`），mode 可能是 `direct` / `proxy_all` / `proxy_selected`，effective 可能是 `next_connection`。
- `RouteSetMode` summary：`分流模式已热切换为 {mode}`，失败分支还有 `state={state}`（`routing.rs:58-103`）。
- 两个 description 都要求「不出现分流、规则集、rule、category id」（`routing.rs:247`、`:321`）。

#### S17 `JobGet` 的 content 包含 job id，却没有进度

- description：「说进度和阶段白话名；不出现 job id、stage 字段名」（`job.rs:28`）。
- summary：`任务 {job_id} 当前状态 {state}。`（`job.rs:70`）。
- `progress` / `stage` / `message` / `origin` 都在 `data` 里（契约 `tools.md:1084-1098`），模型看不到。

#### S18 `MyServers` 说「月费」，摘要打印「每天价格」

- description：「名称、地区、状态、地址、是否可用、月费」（`my_servers.rs:158`）；英文：「monthly price」（`description.rs:33`）。
- summary：`每天 {:.2} 美元`（`my_servers.rs:235-239`）。
- 契约 §4.48 要求摘要按「每天价格」（`tools.md:1821`），所以 description 是过时的。

#### S19 契约 §4.6 的 `CoreListVersions` 字段名与实现不一致

- 契约类型用 `upstream_version`（`tools.md:581`、`:588`）。
- 实现与服务层用 `version`（`core.rs:93-116`；`services.rs:5104`、`:5118`）。
- 这是契约落后于实现，不影响运行时，但按契约写调用方会读不到版本。

#### S20 `HttpCheck` 的 schema 比契约多出长度限制

- 契约只写 `url: string`（`tools.md:2081`）。
- 实现加 `minLength: 1`、`maxLength: 2048`（`http_check.rs:650`）。
- 这是收紧而非放宽，但契约没有登记。

#### S21 `display::is_readonly()` 的名单已过时

- 名单仍包含 `NodeProbe`（`display.rs:233-255`），而 `NodeProbe` 已是 `PermissionLevel::Write`，探不通时会停运行时（`configs.rs:372-376`；`tools.md:300`、`:1483`）。
- 名单缺少 `HttpCheck`（只读、`permission_level` 为 ReadOnly，`http_check.rs:642-644`）。
- 名单缺少 `MyServers`（只读、`my_servers.rs:165`）；它的通用失败分支没有显式写 `changed`（`my_servers.rs:202`）。
- 后果：`normalize_display` 会把 `NodeProbe` 失败强制成 `changed=none`（`envelope.rs:205-208`）；`HttpCheck` 的参数错误（`http_check.rs:699`）与 `MyServers` 的服务错误（`my_servers.rs:202`）会落到 `unknown`，界面显示「不确定，诊断日志里有记录」，但它们其实什么都没改。

#### S22 `CatalogSearch` 说返回名称，summary 不打印名称

- description：「返回 id、名称、地区、协议、延迟与健康分」（`catalog.rs:28-30`）。
- summary：`- {id} | {place} | {protocol} | {latency} | {health}`（`catalog.rs:128-130`），`place` 取 `city` 或 `region`，没有 `name`。
- 契约 §4.8 的 `NodeSummary` 包含 `name`（`tools.md:640`），服务层也返回了它；模型在 content 里看不到。

#### S23 `MyServers` 构造最多 8 行 facts，但展示层只保留 4 行

- `MyServers` 取前 8 台服务器构造 `server.row`（`my_servers.rs:195`）。
- `display` 契约写「`facts` ≤ 4 行」（`display.rs:8`），`normalize_display` 实际截断到 4（`envelope.rs:210`）。
- 结果：第 5–8 台服务器不会出现在卡片 facts 里；content 仍列全部，所以模型能读到，但界面卡片会少。

#### S24 `ConfigDetail` 暴露节点端口，与 `MyServers` 的端口策略不一致

- `ConfigDetail` summary 逐条打印 `server:port`（`configs.rs:56`）。
- `MyServers` 的白名单不含 `port`（`my_servers.rs:64-75`），契约明确「端口不给：界面只显示 IP，AI 说端口会与界面不一致」（`tools.md:1817`）。
- 结果：同一个自建服务器，AI 从 `MyServers` 拿不到端口，却能从 `ConfigDetail` 的节点行读到端口；两个工具对「端口是否可说」的口径相反。

### 3.3 不通用

判断标准：入参是否绑死某个界面的状态；返回是否只对某条流程有意义。

#### N1 `StageSelect`：只对「新建节点」舞台有意义

- 文件头写明：「只把地区 / 规格选进「新建节点」舞台：不建机、不扣费、不写业务表。Host 没有舞台当前选择的镜像，所以只回本次请求的字段，未请求的为 `null`。」（`stage_select.rs:1-4`）
- 入参是 `region` / `plan`，返回 `{ screen: "new_node", region, plan }`（`stage_select.rs:225-233`）。
- 实现只发 `stage-select` 事件（`stage_select.rs:197-203`）；消费端在舞台未打开或创建中时直接忽略（`App.tsx:1101-1115`）。
- 换个场景（比如连接页、设置页）完全无法复用。

#### N2 `CatalogOptions`：只对建机目录有意义

- 返回 `regions` / `plans` 的建机字段（`stage_select.rs:407-448`）。
- 不返回节点目录，也不返回成本价（`stage_select.rs:380-383`）。
- 可以回答「有哪些地区 / 多少钱」这类通用问题，但无法用于节点选择。

#### N3 `AskUserQuestionGuard`：不是产品工具，只是内置工具的包装

- 它把 claurst 的 `AskUserQuestionTool` 包一层，加一行 description 约束、校验 `options` 非空，其余委托（`mod.rs:51-98`）。
- 契约 §4.22：「Veyl 不重写这个工具，只负责接线」（`tools.md:1287`）。
- 它不暴露给用户，也不带任何产品能力。

#### N4 `OpenSettings`：入参绑死设置页的段 / 行 id

- `section` 只能是 `ai` / `connection` / `account` / `advanced`（`settings.rs:32`、`:133-143`）。
- `row` 只认 12 个登记行（`settings.rs:17-30`）。
- 返回的 `settings-point` 事件由设置页消费（`App.tsx:1117-1125`）。
- 离开设置页没有任何意义。

#### N5 `SetUserRegion`：单字段写工具，不是界面绑定

- 入参只有 `region`（两字母代码，`region.rs:52-64`），不绑定任何界面状态。
- 调用指引在系统环境段（`mod.rs:205-206`、`:225-226`），不在提示词文件里。
- 它只做一件事，但换场景仍然成立，所以按「不通用」的严格标准**不算**；列为观察项。

#### N6 `MyServerFailure`：只对某台服务器的失败流程有意义

- description：「只在用户点了「AI 定位」或明确问「这次为什么失败」时调用」（`my_servers.rs:471-478`）。
- 入参 `serverId`，返回单台的 `failure` / `order` / `recent_events` / `log_available: false`（契约 `tools.md:1966-1982`）。
- 健康服务器返回 `failure: null`，对其它流程没有复用价值。

#### N7 `NodeRotateCredentials`：只对自建服务器的节点凭据有意义

- 入参 `server_id`（`node_rotate.rs:640-648`）。
- 只处理「服务器节点 agent」的端口 / 密码轮换（`node_rotate.rs:1-8`）。
- 对免费节点、导入节点、其它服务器流程都不适用。

#### N8 `DeepseekSetupKey` / `DeepseekSaveKey`：只覆盖 DeepSeek 一家

- URL 硬编码 `https://platform.deepseek.com/api_keys`（`deepseek.rs:11`）。
- 产品支持的 AI 服务包括 DeepSeek、OpenAI、Anthropic、Moonshot、Ollama 及任意兼容端点（`product.md:96-98`）。
- 这两个工具无法用于其它服务商；也没有通用的「列服务商 / 测连接 / 切换当前服务」工具。

#### N9 其余工具的通用性判断

- `HttpCheck`：只读、只接受 URL，不绑定界面，属通用工具；只是当前没有用户入口。
- `IssueReport`：两阶段协议是专用的，但不绑定某个界面；AI 可在任意故障对话里调用。
- `submit_issue_to_public_wall` / `read_public_issue_wall`：通用问题墙工具，不绑定界面。
- `MyServers` / `JobGet` / `NetRepair` / `NetConfigGet`：通用或跨流程。
- `DiagRun`：通用诊断入口。

### 3.4 缺口

#### G1 余额读不到

- 产品口径：「连接状态、节点列表、余额、服务器状态都通过工具读取，不猜、不编」（`product.md:23`）。
- 账户节：「余额是外部系统的快照，会过期…按界面显示回答，不要自行推算余额」（`product.md:118-119`）。
- 实际：没有任何工具返回余额。`OpenSettings` 只能把用户带到 `account.balance` 行（`settings.rs:24`）。
- 结果：用户在 AI 对话里问「我余额多少」时，模型只能让用户看界面，不能自己回答。

#### G2 试用状态读不到

- `trial_status` 有服务实现（`services.rs:139`、`:5044`）和命令入口（`agent/commands.rs:255`），但**没有注册成工具**。
- 契约 §3 明确把它列为「UI 专用命令不注册工具」：`trial_status`（`tools.md:334`）。
- 产品讲免费节点「仅供试用」（`product.md:46`），但 AI 无法读取试用阶段、剩余时间或是否已到期。

#### G3 节点 / 试用到期时间读不到

- 试用状态里有 `expires_at_ms` / `remaining_ms`（`trial.rs:36`、`:74`、`:85`）。
- `ConfigDetail` 的节点数据没有到期字段，summary 也不打印（`configs.rs:41-59`；`services.rs:3932-3961`）。
- `MyServers` 的可见字段里没有到期或下次扣费时间（`my_servers.rs:64-75`）。
- 结果：AI 无法回答「这个免费节点还能用到什么时候」「这台服务器下次什么时候扣费」。

#### G4 批量测速没有工具

- 产品：「节点可以测速（真实延迟）与切换」（`product.md:50`）。
- 契约：批量测速是 UI 专用；「没有对应工具；不要循环调用本工具模拟批量」（`tools.md:1481`）。
- `probe_batch.rs` 存在，但没有 `impl Tool`（全仓 `grep "impl Tool for"` 不含它）。
- 结果：AI 只能一次测一个节点，不能回答「帮我把所有节点测一遍」。

#### G5 服务器创建 / 销毁没有工具（设计上如此）

- 产品：「销毁与新建都没有 AI 工具入口，只告诉用户去「我的服务器」操作，不要代做」（`product.md:51`）。
- 契约：「建机、销毁、取凭据只能由用户点界面，没有对应的 AI 工具」（`tools.md:1804`）。
- 这是**有意缺口**，不是遗漏；列在这里是为了与「意外缺口」区分。

#### G6 供应商广场没有工具（本期设计如此）

- 产品：「供应商：本期只能预览，还不能选」（`product.md:48`）。
- 没有任何工具读取供应商列表或状态。属有意缺口。

#### G7 「在手机上使用」没有工具

- 产品：「只导出付费节点…给的是「手机 App 列表 + 一个二维码 / 链接」」（`product.md:77-80`）。
- 没有工具读取导出状态、节点数量或生成链接；`OpenSettings` 只能指到 `account.mobile` 行。
- 产品 §4 #8 的入口是「不会操作？问 AI」，AI 只能讲通用步骤，读不到「现在有哪些付费节点可导出」。

#### G8 AI 服务商配置没有通用工具

- 产品支持多种 AI 服务商，并能「测试连接」「设为当前」（`product.md:96-98`）。
- 只有 DeepSeek 的 setup / save 两个工具（`deepseek.rs:13-146`）。
- 没有工具列出当前服务商、读取 Base URL / 模型、测试连接或切换当前服务。属能力缺口。

#### G9 语言设置无法被 `OpenSettings` 指向

- 产品把 `语言` 列为设置 › 高级的一项（`product.md:127`）。
- `OpenSettings` 的 12 个 row id 没有 `advanced.language`（`settings.rs:17-30`）。
- `Settings.tsx` 的语言行没有 `pointAttrs`（`Settings.tsx:2728` 只有 `settings-row__label`，该区块没有 `data-point`）。
- 同类：`生成问题报告`（`Settings.tsx:2796`）、`清除残留代理`（`Settings.tsx:2780`）、`复制诊断信息`（`Settings.tsx:2899`）也没有 `pointAttrs`。

#### G10 问题报告的「包含域名」用户设置没有读取工具

- `IssueReport` 的 `include_domains` 省略时「遵循用户设置」（`issue_report.rs:69-71`），契约还专门定义了三态（`tools.md:1731-1740`）。
- 没有工具让模型读取这个设置；模型只能靠省略来尊重它。这不是硬缺口（省略即可），但模型无法回答「现在报告会不会带域名」。

#### G11 节点来源选择没有持久状态工具

- 首启必须让用户在「Veyl 免费节点 / 其它节点」之间选（`kickoff.md:64-86`）。
- `CatalogRefresh` 的门禁只写在 description 里（`net.rs:205-206`；测试 `mod.rs:1924-1928`）。
- 没有工具记录「用户已选来源」这个事实；每次会话只能靠提示词和对话历史判断。

#### G12 `ConfigDetail` 的「节点为什么不可用」在 content 里缺失

- 服务层算出了 `unavailable_reason`（`services.rs:3937-3945`）。
- summary 不打印它（`configs.rs:41-59`）。
- 契约要求「回答哪个节点能不能用以本工具为准」（`tools.md:1325-1326`）。
- 这是「数据有、模型看不到」的缺口，归入下一节的横切问题。

#### G13 `submit_issue_to_public_wall` 要求模型提供它拿不到的 `diagnosis.session_id`

- schema 把 `diagnosis.session_id` 列为必填（`issue_wall.rs:128`、`:147`；契约 `tools.md:2175`）。
- 设计文档写明这个值「客户端生成；只用于日志关联，不公开」（`docs/design/issue-report-api.md:279`）。
- 提示词、系统环境段与入口都没有把这个值交给模型；模型只能自己编一个，幂等键（`issue_wall.rs:219`）与日志关联因此失去意义。
- 同类：`diagnosis.stage` / `steps` 也要求模型自填，但它们可以从对话推断；`session_id` 不可推断。

#### G14 `config_id` 在模型可见的 content 里没有出口

- 服务层返回 `config_id`（`services.rs:3917`）。
- `ConfigDetail` 的 summary 只打印配置名与节点行，不打印 `config_id`（`configs.rs:41-59`）；facts 也只有 name / node count / current node（`configs.rs:107-129`）。
- `ConfigUpdate` 要求 `config_id`（`configs.rs:175`）；`NodeSwitch` 要求 `config_id` + `node_id`（`configs.rs:291`）；`RouteTargetsSet` 要求 `config_id`（`routing.rs:408`）。
- 契约说「返回值里的 `config_id` 保留供后续工具使用」（`tools.md:1320`），但它只在 `data` 里，模型看不到。模型没有可靠方式拿到调用这些工具所需的 id。

#### G15 `MyServerFailure` 的 `serverId` 可能不在模型可见的消息里

- 工具要求 `serverId`（`my_servers.rs:489`）。
- 「AI 定位」入口只把 `serverId` 放在会话的 `lastAction` 里，没有写进消息正文（`ai-docs-management.md:60`、`:223`）。
- 如果宿主没有把 `lastAction` 注入模型上下文，模型只能猜一个 `serverId`，或先调 `MyServers` 再匹配——但后者不一定能唯一对上是哪台。

### 3.5 按影响面排序（只排序，不含方案）

| 级别 | 问题 | 影响 | 证据 |
|---|---|---|---|
| P0 | content 与 data 断裂（11 个工具） | 模型拿不到工具声称要提供的事实；诊断、分类、导入、报告、网页检查等核心用途无法完成 | §4 表；`tools.md:47`；`envelope.rs:163-188` |
| P1 | 运行时三工具 schema 与契约不一致；`ConfigUpdate.connect_mode` 被静默接受 | 模型无法传 `config_id` / `force` / `reason`；契约承诺的 `connect_mode_immutable` 不存在 | S6、S2 |
| P1 | 旧 `proxy_selected` 的三个工具仍在工具集；中文提示词仍教 AI 用「分类列表」 | 产品宣称没有按服务分流，AI 却可能引导用户使用旧能力 | S4、S5 |
| P1 | `config_id` 只在 `data` 里，content 没有出口 | `ConfigUpdate` / `NodeSwitch` / `RouteTargetsSet` 要求 id，模型拿不到 | G14 |
| P2 | content 泄露实现词 / 内部值（代理端口、`direct`、`state=`、job id、`sing-box`） | 违反系统提示词与工具 description 自己的措辞规则 | S14–S17 |
| P2 | `ConfigDetail` 打印节点端口，`MyServers` 却明确不给端口 | 同一台服务器两个工具口径相反，AI 可能说出界面没有的端口 | S24 |
| P2 | `is_readonly` 把 `NodeProbe` 当只读、漏掉 `HttpCheck` / `MyServers` | `NodeProbe` 停运行时后界面仍报 `changed=none`；两个只读工具的失败可能误报 `unknown` | S21 |
| P2 | 余额 / 试用状态 / 到期时间没有工具 | AI 无法回答余额、试用剩余时间、下次扣费 | G1–G3 |
| P2 | `submit_issue_to_public_wall` 要求模型提供拿不到的 `diagnosis.session_id`；`MyServerFailure` 的 `serverId` 只在 `lastAction` | 模型只能编值，幂等键、日志关联或失败定位失效 | G13、G15 |
| P3 | 文档漂移（`tool-display.md` 数量与已删工具、`ai-docs-management.md` 工具名大小写、契约 §3.1 旧代码） | 维护者按文档实现会对不上 | S10–S13 |
| P3 | `MyServers` 构造 8 行 facts，展示层只保留 4 行 | 第 5–8 台服务器在卡片上不显示 | S23 |

---

## 4. 横切问题：content 与 data 的断裂

按契约 §1.2，模型只能看到 `content`（`tools.md:47`）；实现也把 `data` 放进 `metadata`（`envelope.rs:163-188`）。但以下工具的 `content` 不包含它声称要提供给模型的事实，事实只在 `data` 里：

| 工具 | content 实际内容 | 模型拿不到、但工具声称/需要的事实 | 证据 |
|---|---|---|---|
| `DiagRun` | 一句计数结论，失败时说「详情见 data.checks」 | 每项检查的 `name` / `status` / `detail` / `remediation` / `action` | `diag.rs:113-120`；契约 `tools.md:863-902` |
| `CategoryList` | `找到 N 个分类。` | 分类 id / 名称（工具存在的唯一目的） | `routing.rs:503`；契约 `tools.md:1627-1629` |
| `JobGet` | `任务 {job_id} 当前状态 {state}。` | `stage` / `progress` / `message` / `origin` | `job.rs:70`；契约 `tools.md:1084-1098` |
| `NodeImportUrl` | 两个计数 + 「请复述节点名、地址、端口与加密方式」 | 解析出的节点名 / 地址 / 端口 / 加密方式 | `configs.rs:540-543`；契约 `tools.md:686` |
| `NodeImportText` | 同上 | 同上 | `configs.rs:632-635`；契约 `tools.md:714` |
| `DeepseekSetupKey` | `已给出获取 Key 的步骤…` | `url` 与 `steps` | `deepseek.rs:38-48`；契约 `tools.md:994-1000` |
| `IssueReport`（第一阶段） | `现场材料已收集…` | `materials`（runtime / checks / logs 行号 / domains）、`report_dir` | `issue_report.rs:123-130`；契约 `tools.md:1752-1760` |
| `HttpCheck` | `网页返回 {status}` / `没访问成功` | `via`（模型必须先看它再解释）、`cf_mitigated`、`server`、`error.message` | `http_check.rs:667-694`；契约 `tools.md:2090-2104` |
| `NetConfigGet` | 网络服务数量 + 默认接口 | 逐服务的代理、DNS、路由、监听端口 | `net.rs:90-95`；契约 `tools.md:1127-1146` |
| `CatalogRefresh` | `Veyl 免费节点已检查（N 个）` | `changed` / `offline` / `version`（这次是否真更新） | `net.rs:230`；契约 `tools.md:1226-1231` |
| `ConfigDetail` | 节点 id / 名称 / `server:port` | `nodes[].source`、`unavailable_reason` | `configs.rs:41-59`；`services.rs:3937-3945`；契约 `tools.md:1325` |

这十一个工具的共同模式是：**事实在 `data`，句子在 `content`，而模型只读 `content`**。其中 `DiagRun` / `CategoryList` / `IssueReport` / `HttpCheck` / `NodeImport*` 属于「工具的核心用途无法完成」；`JobGet` / `NetConfigGet` / `CatalogRefresh` / `ConfigDetail` 属于「模型只能给结论，不能给依据」。

当前 claurst 的 query loop 没有把 `metadata` 写回模型（`claurst/src-rust/crates/query/src/lib.rs:1716-1724`、`:2377-2386`），所以这不是运行时歧义，而是 summary 的事实缺口。除非另行修改 runner 把 `metadata` 拼进上下文，否则模型始终只看到上表的 content。

---

## 5. 需要决策的问题

以下只列问题，不给方案。

1. **content / data 口径**：模型是否应该看到 `metadata`？如果只看 `content`，上面 11 个工具的 summary 是否需要补事实？如果看 `metadata`，契约 §1.2 是否要改？
2. **`ConfigUpdate` 与 `RouteSetMode` 的职责**：改 `routing_mode` 应该只有一条路径，还是两条都保留（一条「下次生效」、一条「热切」）？`ConfigUpdate.targets` 是否删除？
3. **`RouteTargetsSet` / `CategoryList` / `RulesStatus` 的去留**：产品已经没有按服务分流，这三个工具是保留给旧数据、移出工具集，还是改成别的用途？
4. **节点导入三工具**：`NodeImportUrl` / `NodeImportText` / `NodeCreate` 是否合并成一个带来源枚举的导入工具？
5. **`ConfigDetail` 与 `MyServers` 的边界**：节点 / 服务器「不可用」应该以哪个工具为准？`ConfigDetail` 的 summary 是否要带 `source` / `unavailable_reason`？
6. **`CatalogSearch` 与 `CatalogOptions` 的命名**：两个不同目录共用「catalog」，是否要改名或合并入口？
7. **UI 状态类工具**：`StageSelect`（写舞台选择）、`OpenSettings`（发设置定位事件）、`CatalogOptions`（只服务建机）是否应该留在 AI 工具集？还是改成 UI 专用命令 + 入口注入？
8. **`AskUserQuestionGuard` 的定性**：契约说 Veyl 不重写内置工具，实现却包了一层并改了 description / 校验 options。以契约还是实现为准？
9. **DeepSeek 的范围**：`DeepseekSetupKey` / `DeepseekSaveKey` 是否扩展为所有 AI 服务商，还是补一个通用服务商工具、把这两个降级为预设？
10. **缺口优先级**：余额、试用状态、节点到期、批量测速、手机导出、AI 服务商列表 / 测试，这些能力哪些必须给 AI 工具，哪些明确只给 UI？
11. **契约回填**：`RuntimeStart.config_id`、`RuntimeStop.force`、`RuntimeRestart.reason`、`RuntimeStatus.include_traffic`、`CoreListVersions.upstream_version`、`DeepseekSaveKey` 的存储与 `validation_detail`，以契约还是实现为准？何时回填？
12. **`is_readonly` 名单**：`NodeProbe` 应该算只读还是写？`HttpCheck` 为什么不在名单里？这份名单由谁维护、如何防漂移？
13. **工具名 / 数量同步**：`tool-display.md`（42 个、含已删除工具）、`ai-docs-management.md`（问题墙工具 PascalCase）与 `tools.md` §3（43 个）三份文档，以哪份为准、由谁同步？

---

## 6. 附：本次未覆盖的范围

- `services.rs` 的 16k 行服务实现只读了与工具返回形状相关的部分（`config_detail_json`、`core_list_versions`、`trial_status` 等），没有逐条审计业务逻辑。
- `probe_batch.rs` / `turn_guard.rs` / `policy.rs` / `display.rs` / `envelope.rs` 是工具基础设施或 UI 专用服务，不算注册工具；其中 `probe_batch.rs` 没有 `impl Tool`。
- 6 个基础文件工具只记录了名称、权限与注册方式；它们的完整 schema / 行为属于 vendored claurst，不在 Veyl 契约范围内。
- 未运行应用，未验证 UI 实际渲染；所有结论以代码与文档为准。

---

## 7. 建议的处理顺序（2026-11-24，PM）

只定顺序，不含实现细节。每一阶段结束后再开下一阶段。

| # | 阶段 | 内容 | 产出 | 门禁 |
|---|---|---|---|---|
| 0 | 决策 | 从 §5 的 13 条里先定**工具去留**：哪些删、哪些合并、哪些保留 | 工具面定稿清单 | PM 拍板 |
| 1 | 契约 | 改 `tools.md` §1.2：`content` 必须自足（模型唯一的通道）；同步 §3 清单、`tool-display.md`、`TOOL_COPY` | 契约与清单一致 | 契约评审 |
| 2 | 工具层实现 | 一次过完成 content 自足 + 工具收敛（同一批文件，避免改两遍） | 代码 + 测试 | 用户跑编译与测试 |
| 3 | 提示词 | 子模块开关 + 方案 B（见 `ai-docs-management.md` §8） | 代码 + 测试 | 用户跑编译与测试 |
| 4 | 评审与同步 | 交叉评审；文档与契约对齐 | 评审结论 + 文档 | PM 合入 |

**为什么是这个顺序**

- 阶段 0 先定去留：否则阶段 2 会把马上要删的工具再修一遍（`CategoryList`、`NodeImport*` 就在 P0 名单里）。
- 阶段 1 先改契约：`content` 口径是一条横切规则，11 个工具和之后所有新工具都按它写；先写代码再改契约，实现和契约会各说一套。
- 阶段 2 合并两件事：content 自足与工具收敛改的是同一批文件（`tools/*.rs` 与注册表），分两次做要动两遍，中间态还不可用。
- 阶段 3 放最后：提示词要描述的是收敛后的工具面；工具一变，提示词就得重写。

**不建议反过来做的两件事**

- 先改提示词再收敛工具：`system.md` / `product.md` 里点名要 AI 调的工具会消失。
- 只改 content 不动工具面：11 个工具里至少 3 个是收敛候选，修完就删等于白做。

**阶段 0 的输入**

§5 的 13 条不必逐条回答，按影响面合并成 5 组：

1. content / data 口径（第 1、12 条）
2. 分流旧能力：`RouteTargetsSet` / `CategoryList` / `RulesStatus` / `ConfigUpdate.targets`（第 2、3 条）
3. 节点写入路径：导入三工具是否合并（第 4、5 条）
4. UI 状态类工具：`StageSelect` / `CatalogOptions` / `OpenSettings` / `AskUserQuestionGuard`（第 7、8 条）
5. 缺口补齐：余额、试用、到期、批量测速、手机导出、服务商（第 9、10 条）

第 6、11、13 条（命名、契约回填、文档同步）在阶段 1 随契约一起处理。
