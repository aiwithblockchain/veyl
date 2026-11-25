# AI 工具边界审计

> 日期：2026-11-25
> 范围：`tools.md` 3.29.0 的 38 个工具；只读代码与契约，不改任何文件。
> 依据：各工具的实际 `description()`、`input_schema()`、`content` / `data` 构造（文件:行见 §2）；`docs/contracts/tools.md` 只用来核对名字与顺序。
> 目的：回答「哪个工具还会诱发参数语义、内容无标签、想答却无工具这三类误用」，并给第 5 组「要不要照原计划加三个工具」提供证据。

---

## 1. 逐工具表

| 名称 | 它只负责什么（一句话） | 最容易被哪个工具混淆 | 用户会怎么问而误落到它头上 | 建议 |
|---|---|---|---|---|
| `RuntimeStatus` | 连接状态、运行库版本与来源、出口 IP（content 只到这些；流量/连接数只在 `data`） | `RouteGet`（当前分流模式）、`NetConfigGet`（系统网络设置） | 「我现在用的是智能还是全局？」——content 里没有流量范围 | 改描述：分流模式看 `RouteGet` |
| `RuntimeStart` | 启动运行时连接**并设置系统代理**（与 `VpnConnect` 同一服务方法） | `VpnConnect`（同一件事的另一个名字） | 「帮我连上 VPN」——两个工具都能接，模型选哪个都「对」 | **合并候选**：并到 `VpnConnect`；现描述「不设置系统代理」与实现不符 |
| `RuntimeStop` | 停止运行库并恢复系统代理；idle 幂等 | `VpnDisconnect`（同样是断开并恢复代理） | 「断开 VPN / 恢复直连」——两个工具用户可见效果相同 | **合并候选**：并到 `VpnDisconnect`，或限定为排障内部 |
| `RuntimeRestart` | 重启运行库以应用配置或恢复异常 | `VpnDisconnect` + `VpnConnect`（用户说「重连」） | 「断一下再连上」——会重启进程而不是重连 | 改描述：重连＝断开＋连接 |
| `RuntimeLogs` | 最近若干行脱敏运行日志 | `IssueReport`（把日志打成报告） | 「把日志给我看看」——临时排障和打包外发是两件事 | 改描述：临时看用本工具，打包用 `IssueReport` |
| `CoreListVersions` | 已安装与可安装的运行库版本清单 | `RuntimeStatus`（当前版本）、`CoreUpgrade`（检查远端更新） | 「有没有新版本？」——本工具只读本地清单 | 改描述：远端检查/升级走 `CoreUpgrade` |
| `CoreUpgrade` | 用户明确要求时才检查更新并弹确认卡 | `CoreListVersions`（只读版本） | 「运行库旧不旧」——不应触发下载与确认卡 | 保留（描述已禁止） |
| `CatalogSearch` | 查询远端**共享节点**目录（按地区/协议） | `ServerOptions`（建机地区/价格）、`ConfigDetail`（本地节点） | 「有哪些节点可选 / 多少钱」——价格只来自建机目录 | 改描述：价格只来自 `ServerOptions` |
| `ConfigDetail` | 一套配置的节点集、DNS、布局；无凭据 | `DefaultProfileStatus`（免费节点缓存）、`MyServers`（服务器列表） | 「我有几个节点」——缓存数不等于节点总数 | 保留（描述已写明以本工具为准） |
| `ConfigUpdate` | 编辑配置名称 / 分流 / DNS / 节点集（整体替换） | `RouteSetMode`（分流开关）、`NodeSwitch`（换当前节点） | 「改成全局」有两个写入口；「换个节点」可能整体替换 `node_ids` | **合并候选**：`routing_mode` 只留 `RouteSetMode` |
| `NodeImport` | 三种来源往节点池写节点，不连接 | `NodeSwitch`（切当前节点）、`VpnConnect`（连上） | 「加个节点并连上」——只导入不连接；「换成这个节点」用错 | 改描述：导入 ≠ 切换 ≠ 连接 |
| `NodeSwitch` | 切换某套配置的当前节点；未连接只改选择 | `VpnConnect`（连接）、`ConfigUpdate`（改节点集） | 「连这个节点」——只改选择，不启动 VPN | 保留（描述已写明） |
| `NodeProbe` | 单节点 Clash 延迟三态（ok / unreachable / untested） | 批量测速（仅 UI 命令）、`HttpCheck`（网页可达） | 「把所有节点测一遍」——可能循环本工具 | 改描述：批量在界面，禁止循环 |
| `VpnConnect` | 连接并设置系统代理 | `RuntimeStart`（只起进程）、`ConfigSetMode`（接管方式）、`RouteSetMode`（流量范围） | 「让所有软件走 VPN」——可能是改接管方式，不是连接 | 改描述：连接 / 接管方式 / 流量范围是三件事 |
| `VpnDisconnect` | 断开并恢复系统代理；idle 幂等 | `RuntimeStop`（同样停进程）、`NetRepair.restore_direct`（恢复直连） | 「恢复直连 / 关掉 VPN」——三个工具都像 | **合并候选**：接收 `RuntimeStop`；`NetRepair` 动作改描述 |
| `DiagRun` | 一键诊断，逐项 status / detail / action | `NetConfigGet`（只读系统设置）、`HttpCheck`（单站） | 「网络哪里有问题」——可能手工拼只读工具而不跑诊断 | 改描述：先诊断，再细查 |
| `DeepseekSetupKey` | 给出取 DeepSeek Key 的步骤与地址 | 计划中的 `LlmProviders`（列服务商/测连接）、`OpenSettings` ai 段 | 「怎么配置 AI / 怎么拿 Key」——步骤、保存、换服务商是三处 | 改描述：步骤=本工具，保存=`DeepseekSaveKey`，换服务商=设置 |
| `DeepseekSaveKey` | 保存 Key 到本地加密文件，不回显 | 计划中的 `LlmProviders`（只列表/测试，不写 Key）、`DeepseekSetupKey` | 「我换个 Key」——若被指到 `LlmProviders`，它不保存 | 保留；`LlmProviders` 描述必须指回本工具 |
| `JobGet` | 按 `job_id` 查长任务进度 | `CoreUpgrade`（发起升级，返回 `job_id`） | 「升级好了吗」——手里没有 `job_id` 时容易误调或编进度 | 改描述：只有拿到 id 才查 |
| `NetConfigGet` | 只读系统代理 / DNS / 路由 / 回环监听 | `DiagRun`（诊断结论）、`NetRepair`（修复） | 「为什么代理没生效」——停在读数，没有结论 | 改描述：读数→诊断→修复的层次 |
| `NetRepair` | 四种受限修复（恢复直连 / 刷 DNS / 设/清代理） | `VpnDisconnect`（断开恢复）、`network_force_reset`（UI 专用，非工具） | 「重置网络」——本工具不能全量重置 | 改描述；评估移除 `restore_direct` |
| `CatalogRefresh` | 拉取并应用 Veyl 免费节点种子包 | `DefaultProfileStatus`（只读状态）、`CatalogSearch`（其它节点目录） | 「更新一下免费节点」——可能只读了状态 | 改描述：拉取=本工具，看状态=Status |
| `DefaultProfileStatus` | 免费节点缓存 + 试用状态，不联网 | 计划中的 `TrialStatus`（模型可见答案重叠：state + 剩余天数）、`ConfigDetail`（节点总数） | 「试用还剩几天」——两个工具都能答；「规则最新吗」曾被误用 | **不要新增 `TrialStatus`**；需要精确到期时间先扩本工具 content |
| `RouteGet` | 读设定值与生效值的分流模式、targets | `RuntimeStatus`（连接快照）、`RouteSetMode`（写） | 「现在是智能还是全局」——可能先去 `RuntimeStatus` | 改描述：删掉过时的「指定服务分类」，明说它就是流量范围读取 |
| `RouteSetMode` | 切分流模式（direct / proxy_all，热切） | `ConfigUpdate.routing_mode`（第二写入口）、`ConfigSetMode`（接管方式） | 「让所有软件走 VPN」——可能改了接管方式或代理范围 | 保留为唯一分流写入口；与 `ConfigUpdate` 去重 |
| `IssueReport` | 两阶段生成本地脱敏问题报告 | `submit_issue_to_public_wall`（公开）、`RuntimeLogs`（看日志） | 「报告一个问题」——可能发到公开墙 | 改描述：本地 vs 公开一句话说清 |
| `SetUserRegion` | **只写**用户所在地区；没有读取工具 | `RouteGet`（`detected_region` / `applied_region` 可读） | 「我在哪个地区 / 我设的是哪里」——可能误触发写入 | 改描述：只写；读地区用 `RouteGet` |
| `MyServers` | 服务器列表、状态、地址、日价、已销毁原因；建机/销毁仅 UI | `MyServerFailure`（单台**建机**失败）、`ServerOptions`（可选地区价格） | 「我这台为什么建机失败」——列表只有状态与已销毁原因，没有失败阶段 | 改描述：建机失败详情用 `MyServerFailure` |
| `ConfigSetMode` | 切接管方式 Tun ↔ Proxy（确认卡） | `RouteSetMode`（流量范围）、`VpnConnect`（连接） | 「让所有软件都走 VPN」——触发例句同时能被这三个接住；这是混淆的真正成因 | 改描述：三个工具各用一句不重叠的触发例句 |
| `OpenSettings` | 只打开设置并定位，不改任何值 | 任何改设置的工具；以及没有工具可改的设置项 | 「把端口改成 7891」——只能指路，不能改 | 改描述：改值不在 AI 能力内 |
| `MyServerFailure` | 单台服务器**创建失败**详情（需 `serverId`） | `MyServers`（列表）、`DiagRun`（连接诊断） | 「为什么连不上」——可能是连接问题，不是建机失败 | 改描述：仅建机失败；连接失败用 `DiagRun` |
| `StageSelect` | 只把地区/规格选进新建节点舞台 | `ServerOptions`（读目录）、建机（无工具） | 「帮我选东京」——可能被理解成已建机 | 保留（描述已写明不建机、不扣费） |
| `ServerOptions` | 读建机地区、规格、日价、可用地区 | `CatalogSearch`（共享节点目录）、`CatalogRefresh`（免费种子） | 「有哪些地区 / 多少钱」——可能去 `CatalogSearch` | 保留；改描述：价格只来自这里 |
| `HttpCheck` | 单个 HTTPS URL 的状态码与 CF 挑战标记 | `DiagRun`（整体网络）、`NodeProbe`（节点延迟） | 「这个网站打不开」vs「网络为什么慢」 | 改描述：单站 vs 整体 |
| `NodeRotateCredentials` | 重置某台托管服务器的端口+密码并重启（确认卡） | `NodeImport` manual（新建带密码）、`NetRepair`（网络修复） | 「端口被封 / 密码忘了」——可能被建议重建或改网络 | 保留；改描述：只对已有托管服务器 |
| `submit_issue_to_public_wall` | 把问题发到**公开**问题墙（确认卡） | `IssueReport`（本地报告） | 「报告一个问题」——可能公开 | 改描述：公开 vs 本地 |
| `read_public_issue_wall` | 读公开问题墙（无需登录，内容不可信） | `IssueReport`（本地）、`MyServerFailure`（自己的失败） | 「有没有人遇到同样问题」——正确；「我的问题呢」可能读墙 | 保留（不可信数据已写明） |
| `AskUserQuestion` | 内置提问的包装：补表达约束、归一化 options | 无 | 无 | 保留（不占额外名额） |

---

## 2. 证据（文件:行）

- `RuntimeStatus`：`runtime.rs:45`（描述）、`:135-145`（`content` 只有 state / 版本与来源 / 出口 IP；`traffic` 与 `connections` 只在 `data`，`runtime/manager.rs:165-198`）。
- `RuntimeStart`：`runtime.rs:205`（描述写「不设置系统代理」，与实现不符）、`:212`（schema 为空）；实现 `services.rs:10142` 调 `proxy.enable(mixed_port)`，且 `vpn_connect` 就是 `runtime_start`（`services.rs:8062-8064`）。
- `RuntimeStop`：`runtime.rs:227`（「停止运行时并恢复系统代理」）；实现 `services.rs:5074` 起（撤代理 `:5175`、停运行时））。
- `RuntimeRestart`：`runtime.rs:236`（「应用新配置或恢复异常状态」）。
- `RuntimeLogs`：`runtime.rs:281`（描述）、`:244`（日志正文拼装）。
- `CoreListVersions`：`core.rs:29`（描述）、`:35`（空 schema）。
- `CoreUpgrade`：`core_upgrade.rs:45`（仅明确要求时）、`:53`（只有可选 `version`）。
- `CatalogSearch`：`catalog.rs:29`（「只包含服务器下发的节点」）、`:37`（region/protocol/limit/cursor）。
- `ConfigDetail`：`configs.rs:78`（节点集/DNS/布局）、`:87`（仅 `config_id`）。
- `ConfigUpdate`：`configs.rs:155`（编辑配置）、`:169`（含 `routing_mode`）、`:219`（读取并写库）。
- `NodeImport`：`configs.rs:604`（三种 `source`）、`:616`（schema 唯一必填 `source`）。
- `NodeSwitch`：`configs.rs:276`（未连接只改选择）、`:284`（`config_id`+`node_id`）。
- `NodeProbe`：`configs.rs:366`（单节点三态）、`:378`（仅 `node_id`）。
- `VpnConnect`：`vpn.rs:32`（连接+系统代理）、`:40`（仅 `config_id`）。
- `VpnDisconnect`：`vpn.rs:421`（断开+恢复代理，idle 幂等）；实现 `services.rs:8069` 直接调用 `self.runtime_stop(false)`。
- `DiagRun`：`diag.rs:283`（逐项 status/action）、`:291`（仅 `include_logs`）。
- `DeepseekSetupKey`：`deepseek.rs:22`（只给步骤）、`:28`（空 schema）。
- `DeepseekSaveKey`：`deepseek.rs:71`（保存+验证）、`:77`（仅 `key`，sensitive）。
- `JobGet`：`job.rs:28`（按 id 查进度）、`:34`（`job_id` 必填）。
- `NetConfigGet`：`net.rs:69`（只读系统网络）、`:75`（空 schema）。
- `NetRepair`：`net.rs:122`（四种动作含 `restore_direct`）、`:137`（action enum）；`restore_direct` 实现在 `services.rs:10165-10208`（`repair_restore_direct`），不是 `services.rs:9435`（那是 `stop_for_rebuild`）。
- `CatalogRefresh`：`net.rs:204`（拉取并应用免费节点）、`:212`（仅 `force`）。
- `DefaultProfileStatus`：`net.rs:329`（描述含试用状态）、`:350`（内部调用 `trial_status()`）。
- `RouteGet`：`routing.rs:259`（描述仍写「指定服务分类」）、`:206-240`（content 已把 `direct` 标成「智能」、给 `applied_mode`）。
- `RouteSetMode`：`routing.rs:336`（只有两档、热切）、`:344`（`confirm_reconnect`）。
- `IssueReport`：`issue_report.rs:52`（两阶段、只写固定目录）、`:60`（无路径参数）。
- `SetUserRegion`：`region.rs:39`（只写、不读）、`:45`（两字母代码）。
- `MyServers`：`my_servers.rs:158-162`（列表/地址/日价 + 已销毁原因 `destroyed_reason`）、`:78`（白名单重建，10 个字段，无 `paid_until`/`billing_state`）、`:211`（逐台摘要）。
- `ConfigSetMode`：`config_mode.rs:99`（仅明确要求时）、`:107`（Tun/Proxy）。
- `OpenSettings`：`settings.rs:123`（只打开、不改值）、`:131`（section/row）。
- `MyServerFailure`：`my_servers.rs:472`（单台创建失败）、`:485`（`serverId` 必填）。
- `StageSelect`：`stage_select.rs:155`（只改选择、不建机）、`:165`（region/plan）。
- `ServerOptions`：`stage_select.rs:381`（读建机目录、不答规则）、`:391`（空 schema）。
- `HttpCheck`：`http_check.rs:637`（单 URL、只读状态码）、`:646`（url/timeout）。
- `NodeRotateCredentials`：`description.rs:50`（只在明确要求时、确认卡）、`node_rotate.rs:640`（`server_id`）。
- `submit_issue_to_public_wall`：`issue_wall.rs:22`（常量名）、`:103`（描述）、`:116`（schema）。
- `read_public_issue_wall`：`issue_wall.rs:23`（常量名）、`description.rs:29`（不可信数据）、`:577`（schema）。
- `AskUserQuestion`：`mod.rs:71-98`（包装）、`:101-124`（options 归一化）。

---

## 3. 候选清单（合并 / 删除）

### 3.1 强候选：`RuntimeStop` → `VpnDisconnect`

- **现在**：`vpn_disconnect` 的实现就是 `self.runtime_stop(false)`（`services.rs:8069-8071`），两者都「停运行库 + 恢复系统代理 + idle 幂等」（`runtime.rs:227`、`vpn.rs:421`），用户可见效果相同。
- **三点差异（合并时要定保留哪个）**：
  1. `VpnDisconnect` 的 `proxy_not_restored` 分支实际是死代码：`disconnect_outcome` 读 `system_proxy_restored`（`vpn.rs:445`），而 `runtime_stop` 返回的是 `RuntimeStatus`，没有这个字段（`runtime/manager.rs:161-198`），所以永远走 `unwrap_or(true)`。
  2. 失败时的 `Changed` 不同：`RuntimeStop` 从 `details.connect_changed` 推导（`runtime.rs:12-18`），`VpnDisconnect` 一律 `Unknown`（`vpn.rs:434-445`）。
  3. 权限级别**相同**（都是 `Write`；复核所说的 Write vs Execute 与代码不符）。
- **并到哪**：`VpnDisconnect`（用户语言的动作）；`RuntimeStop` 若要保留，只能定位成排障内部工具，不注册给模型。
- **谁受影响**：`tools.md` §3/§4.3、`tool-display.md`/`TOOL_COPY`、`commands.md` 的 `runtime_stop` 映射（命令保留，AI 列改「无」）、冒烟清单。
- **AI 会失去什么**：「只停后台组件、不声称断开」这个区别；但 `VpnDisconnect` 在 idle 时也幂等，实际没有用户可见损失。
- **代价**：工具数 38 → 37；契约升小版本；命令不动。

### 3.1b 强候选：`RuntimeStart` → `VpnConnect`

- **现在**：`vpn_connect` 的实现就是 `self.runtime_start(config_id)`（`services.rs:8062-8064`）；`runtime_start` 内部会 `proxy.enable(mixed_port)`（`services.rs:10142`）并打开系统代理。两个工具是同一服务方法的两个名字。
- **描述与实现不符**：`RuntimeStart` 说「不设置系统代理；需要代理请用 `VpnConnect`」（`runtime.rs:205`），但现状已经设置代理；这句会直接误导模型。
- **并到哪**：`VpnConnect`（用户语言的动作）。`RuntimeStart` 不再注册给模型；`runtime_start` 命令保留给界面。
- **谁受影响**：`tools.md` §3/§4.2、`tool-display.md`/`TOOL_COPY`、`commands.md` 的 `runtime_start` 映射（命令保留，AI 列改「无」）、冒烟清单。
- **AI 会失去什么**：没有真实能力损失——「只起进程、不设代理」在实现里不存在。
- **代价**：与 §3.1 是同一对服务方法的两个方向，**建议同一批做**：一次契约小版本、一次命令映射与展示文案同步；两对都做则 38 → 36。
- **权限**：`VpnConnect` 是 `Execute`、`RuntimeStart` 是 `Write`；合并后保留 `Execute`。

### 3.2 强候选：`ConfigUpdate.routing_mode` → `RouteSetMode`

- **现在**：`ConfigUpdate` 收 `routing_mode`（`configs.rs:169`、`:219`），`RouteSetMode` 也写同一字段（`routing.rs:344`）；两条写路径，行为不同（`ConfigUpdate` 只写库，`RouteSetMode` 有连接中热切分支）。
- **并到哪**：只留 `RouteSetMode` 作为分流写入口；`ConfigUpdate` 只改名称 / DNS / 节点集。
- **谁受影响**：`tools.md` §4.25 的 schema、`ConfigUpdate` 自己的描述（`configs.rs:153-156` 仍写着「编辑配置（名称 / 分流 / DNS / 节点集）」）、`boundary_tests` 的输入用例。提示词没有教模型用 `ConfigUpdate` 改分流（`product.md:116`、`kickoff.md:120` 都是 `RouteSetMode`）；FAQ 没有涉及「改分流」的问答。这部分不需要改。
- **AI 会失去什么**：一次调用同时改分流和别的字段；可以拆成两次调用，没有能力缺口。
- **代价**：schema 收缩（破坏性），需要一次小版本；工具数不变。

### 3.3 第 5 组结论：不要新增 `TrialStatus`

- **现在**：`DefaultProfileStatus` 的 **`data` 里没有试用字段**（`net.rs:346-369` 返回的是缓存 `data`）；试用只拼进 `content`：状态句 + 剩余天数 + 池内免费节点数（`net.rs:295-311`）。`expires_at` / `started_at` 两个工具都没给（`trial_status()` 的完整返回没有下发）。
- **第 5 组计划**：再加一个 `TrialStatus`（`ai-tools-group5-gaps.md` §2.2），模型可见答案会与 `DefaultProfileStatus` 的 content 重叠（state + 剩余天数），不是「完全重叠」——但足以让模型在两个工具之间选错。
- **建议**：暂不新增。若产品需要精确到期时间（`expires_at`），先扩 `DefaultProfileStatus` 的 content；确实要拆时再拆干净：`DefaultProfileStatus` 只回缓存，`TrialStatus` 只回试用，同批改描述并改名（如 `FreeNodesStatus`）。
- **谁受影响**：`tools.md` 3.30.0 计划、`tool-display`、提示词里的「试用还剩几天」；`ai-tools-group5-gaps.md` §2.2 / §3 / §4 已按「不新增」改。
- **代价**：0 个新工具；工具总数从 41 降为 40。

### 3.4 不建议合并：`NetRepair.restore_direct` 与 `VpnDisconnect` 是不同动作

- **更正证据**：`services.rs:9435` 是 `stop_for_rebuild`，不是 `restore_direct`。真正的实现是 `services.rs:10165-10208` 的 `repair_restore_direct`，**全程不经过 `runtime_stop_inner`**。
- **实际差异**：
  1. 它不停 TUN——`manager.stop()` 只管 manager 自己的子进程，TUN 是 helper 的子进程，manager 看不见；
  2. 它会删**全部**明文渲染配置（`remove_all_profile_configs`）；
  3. 它验证 `applied_endpoint` 不再被使用 + manager 处于 `Idle`，才报 `verified = true`。
- **结论**：不同动作，不建议合并；`NetRepair` 的 `restore_direct` 是「连接状态不明时的兜底」，`VpnDisconnect` 是正常断开。
- **疑似 bug（另派代码排查）**：TUN 在跑时，`verified` 只检查 manager idle 与代理端点为空，可能返回「已恢复直连」而实际仍走隧道（`services.rs:10165-10208`）。

### 3.5 弱候选（只改描述，不建议合并）

- `DeepseekSetupKey` / `DeepseekSaveKey` × 计划中的 `LlmProviders`：职责不同（步骤 / 保存 / 列表+测试）。第 5 组照原计划加 `LlmProviders`，但描述必须写「保存 Key 用 `DeepseekSaveKey`，换服务商去设置」。
- `CatalogSearch` / `CatalogRefresh` / `ServerOptions`：三个「目录」来源不同（共享节点 / 免费种子 / 建机地区），不建议合并；`CatalogRefresh` 与 `DefaultProfileStatus` 的「刷新 vs 看状态」用描述区分。
- `MyServers` × `MyServerFailure`：列表 vs 单台失败详情，不合并；`MyServers` 补一句指路即可。
- `RouteGet` × `RuntimeStatus`：读分流 vs 连接快照，不合并；修 `RouteGet` 的过时描述（「指定服务分类」）。
- `NodeProbe` × 批量测速：批量是 UI 专用，不注册工具；`NodeProbe` 补一句「不要循环模拟批量」。
- `SetUserRegion`：只写不读，容易在「我在哪个地区」时误写；改描述指向 `RouteGet.detected_region`，不新增读取工具。
- `OpenSettings`：只指路，不改值；描述补「改值不在 AI 能力内」。
- `HttpCheck` × `DiagRun`：单站可达 vs 整体诊断，不合并。
- `CoreListVersions` × `CoreUpgrade`：本地清单 vs 远端检查+确认升级，不合并。

---

## 4. 对第 5 组的结论

- **`MyServerWallet`**：加。与现有工具无重叠；只读、无副作用。
- **`LlmProviders`**：加，但只做「列表 + 测试连接」；保存 / 删除 / 切换仍只在界面，描述里指回 `DeepseekSetupKey` / `DeepseekSaveKey`。
- **`TrialStatus`**：**不新增**。`DefaultProfileStatus` 的 content 已经在答 state + 剩余天数 + 池内节点数（`net.rs:295-311`），只是 `data` 没有试用字段、也没有 `expires_at` / `started_at`。若需要精确到期时间，先扩 `DefaultProfileStatus` 的 content。工具总数因此是 **40**（38 + `MyServerWallet` + `LlmProviders`），不是 41。
- **`MyServers` 补字段**：加 `paid_until` / `billing_state`，与 `MyServerFailure` 无重叠。
