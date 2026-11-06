# 特权助手的随 App 更新与生命周期

> 日期：2026-11-05
> 状态：设计定稿，未实现
> 上游：`docs/tun-privilege.md`、`docs/contracts/tun-backend.md`、`docs/windows-tun.md`
> 涉及：`src-tauri/src/tun/*`、`src-tauri/src/bin/veyl-helper/*`、
> `src-tauri/resources/launchd/com.veyl.helper.plist`、`src-tauri/src/lifecycle.rs`
>
> **这份文档存在的意义**：helper 是 root 进程，它的「更新」和「退出」都不能靠感觉。
> 下面每个决定都写明为什么，尤其是不做什么——不自动回滚、不按版本号判断、不改 `RunAtLoad`。

---

## 1. 现状与问题

### 1.1 现象

App 重装后，`Veyl.app/Contents/MacOS/veyl-helper` 已经是新文件，但**正在运行的进程仍是旧映像**，
必须手动执行 `sudo launchctl kickstart -k system/com.veyl.helper` 才会换成新代码。

### 1.2 根因

launchd 只在 **spawn 时** exec 一次路径。文件被替换后，已运行的进程继续持有旧 inode 的执行映像，
没有任何环节去比较「运行中的映像」与「磁盘上的文件」。`KeepAlive = { SuccessfulExit: false }`
只在进程退出后才会重新拉起——而它不会自己退出。

```
重装 App → 磁盘文件变了 → 运行中的 helper 不知道 → 直到有人踢它
```

### 1.3 顺带发现的缺陷

`lifecycle.rs` 的 `perform_shutdown` 只停止代理运行时（`parts.manager.stop()`），
**没有停 TUN 会话**。而退出对话框已经承诺「退出 Veyl 会断开当前连接并恢复网络」。
结果是：TUN 在跑时退出 App，隧道留在后台，且没有任何界面能关掉它。
本次一并修复，见 §6.2。

---

## 2. 判断依据：cdhash，不是版本号

### 2.1 期望值与实际值

| 值 | 来源 | 要求 |
|---|---|---|
| 期望 | `Veyl.app/Contents/MacOS/veyl-helper` 的 cdhash | 先验签通过才取 |
| 实际 | 运行中 helper 进程的 cdhash | 先验签通过才取 |

- 期望值：`SecStaticCodeCreateWithPath` + `SecStaticCodeCheckValidity`（requirement 见 §2.5），
  再 `SecCodeCopySigningInformation` 取 `kSecCodeInfoUnique`。
- 实际值：App 拿到 XPC 连接后取对端 pid，`SecCodeCopyGuestWithAttributes` 取动态代码，
  同样先按 requirement 校验，再取 cdhash。**不依赖 helper 自报**——旧 helper 没有这个字段也能被认出来。
- 两者按字节比较。相等即同一份代码；不等即「运行的不是磁盘上那份」。

### 2.2 为什么不用版本号

- 同一个营销版本可能重编多次，版本号相同、代码不同；
- 版本号来自被检查的文件本身，文件被替换时它同样可被伪造；
- cdhash 是对实际代码的摘要，重编、替换、换签名都会变，没有「看起来一样」的余地。

版本号仍然保留，但只用于日志和界面展示，**不参与任何判断**。

### 2.3 为什么 App 降级不会误判

比较的是「运行中的进程」与「当前 bundle 里的文件」，与谁新谁旧无关：

- App 升级 → 文件更新，运行的是旧的 → 重启到新文件，正确；
- App 降级 → 文件变旧，运行的是新的 → 重启到旧文件，同样正确——因为用户实际安装的就是旧版本。

如果按「远端版本是否更高」判断，降级就会被误判成「已是最新，不用动」，或者反过来把新 helper 换回旧的
却报告升级成功。方向无关的比较没有这个问题。

### 2.4 文件验签不过为什么不重启

helper 从 App 包里运行，而 App 包在用户可写的位置（per-user 安装，或 `/Applications` 的管理员可写目录）。
如果文件被替换、验签不通过，仍然让它退出、由 launchd 重新 exec，等于**把用户可写目录里的内容交给 root 执行**。

所以规则是：**先验签，再决定**。

| 磁盘文件状态 | 动作 |
|---|---|
| 验签通过，cdhash 与运行中不同 | 退出（`exit(75)`），让 launchd 换新映像 |
| 验签通过，cdhash 相同 | 什么都不做 |
| 验签不通过 | **不退出**，保持运行中的可信映像，记录日志，报 `file_invalid` |

App 侧同理：文件验签不通过时，不请求重启，界面提示「后台组件文件校验失败，重新安装 Veyl 可修复」。

### 2.5 身份参数

打包产物实测：

```
Identifier=veyl-helper
TeamIdentifier=2XYK8RBB6M
flags=0x10000(runtime)      # hardened runtime
```

helper 自身的 requirement：

```
anchor apple generic and identifier "veyl-helper" and certificate leaf[subject.OU] = "2XYK8RBB6M"
```

`anchor apple generic` 同时排除 ad-hoc 与自签名。这与仓库里既有的
`app_requirement()`（校验对端 App）是同一条思路：**信任根来自签名，不来自路径**。
打包脚本必须断言 helper 的 identifier 与 Team ID，否则这里会静默失配。

---

## 3. 升级时序

### 3.1 启动时（主路径，无手动步骤）

App 启动后在后台跑一次，不阻塞界面，正常情况不弹任何东西：

```
读包内 helper → 验签 → 取 cdhash（期望值）
  → XPC status
       （helper 若已空闲退出，这一步由 launchd 按需拉起，拉起的必然是当前文件）
  → 取对端 pid → 算运行中 cdhash（并验 requirement）
  ├ 相同 → 结束，无提示
  └ 不同 → 标记 stale
        ├ TUN 正在跑 → 记 pending，等断开（启动时几乎不会遇到）
        ├ 旧 helper（不认识 restart）→ 一次性管理员授权（§4）
        └ 新 helper → 静默 restart → exit(75) → launchd 换新映像
  → 轮询至 cdhash 一致（≤10 秒）
        ├ 成功 → 清除 stale
        └ 失败 → 标记 start_failed，本次运行不再重试
```

用户唯一可能看到授权的场景，就是「正在跑的 helper 还不认识 `restart`」这一次。此后每次 App 更新，
启动时自动完成。

### 3.2 连接前校验

启动检查之后，每次 TUN 连接前再比对一次（正常情况下是缓存命中，无网络、无副作用）。

如果这时发现 stale：**先重启，并让这次连接以「正在准备后台组件」结束**，不把「重启 + 重新拉起」塞进
5 秒的 `TUN_CONNECT_TIMEOUT` 预算。用户点重试时 helper 已经就绪。把两件事塞进同一个 5 秒预算，
只会得到一个随机失败的超时。

这一下可能弹管理员授权（旧 helper）。界面在发起连接前先显示「正在准备后台组件，系统会请求一次授权。」，
文案见 §4.3.2。

### 3.3 6 小时兜底（helper 自检）

helper 自己也做同样的比较，作为 App 不在场时的兜底：

- 启动时一次；
- 之后每 6 小时一次；
- **只在没有 sing-box 子进程、且距上次请求 ≥10 分钟时执行**；
- 采用「验签通过且 cdhash 不同 → `exit(75)`」的同一规则（§2.4）。

自检不能当主路径：helper 不知道 App 是否正在连接、用户是否走开，定时退出会踢断隧道。

### 3.4 TUN 运行中：pending until disconnect

App 检测到 stale 且 TUN 正在运行 → 不重启，只标记 pending。会话结束（`stop` 完成、或租约失效）后
等 5 秒，确认没有新会话，再执行重启。helper 的自检同样遵守这条。

### 3.5 版本协商

**不认识 `restart` 方法 = 旧 helper。** 这不新增版本号字段：旧 helper 对未知方法返回协议错误，
App 据此判定「需要一次性授权」。这样协商只依赖已经发生的事实，不依赖对方自报的版本。

---

## 4. 一次性管理员授权

### 4.1 什么时候发生

只在旧 helper 不认识 `restart` 时。这是从「没有自动更新能力」到「有」的唯一一次跨越。

### 4.2 执行方式

固定的 `osascript` 脚本，命令是**编译进二进制的常量**，不含任何用户输入：

```applescript
do shell script "/bin/launchctl kickstart -k system/com.veyl.helper" with prompt "Veyl 更新后台组件，它负责让「全部流量」走 VPN。不是新权限，只用于这个功能，这次之后不再需要手动授权；代理模式不需要授权。" with administrator privileges
```

- 正文作为常量编译进二进制，经 `applescript_quote` 转义（`"` 与 `\`）后再拼进脚本；「」是普通字符，不需要转义；
- 用绝对路径 `/bin/launchctl`，没有变量插值、没有 shell 元字符；
- 密码只进系统对话框，**不经过我们的进程**，不落盘、不进日志；
- 我们只记录结果（成功 / 用户取消 错误 -128）；
- 不用 `AuthorizationExecuteWithPrivileges`（10.7 起废弃）；
- 不走「注销再注册」：那会让用户重新去系统设置批准一次，体验更差。

`with prompt` 只改正文。**弹窗标题改不了**：从 Monterey 起经 osascript 调用固定显示
"osascript"，所以正文必须自己把「是谁、要做什么、为什么现在要」说清——第一句就写 Veyl。
正文控制在一到两行，不放路径、命令，也不出现 helper / daemon / osascript 这类词。

### 4.3 文案

#### 4.3.1 系统授权弹窗正文

> Veyl 更新后台组件，它负责让「全部流量」走 VPN。不是新权限，只用于这个功能，这次之后不再需要手动授权；代理模式不需要授权。

- 按钮是系统自带的「好」/「取消」，不能改文案；应用**不加**一层自己的确认弹窗——同一件事问两次只会让人更困惑。
- 说清四件事：谁（Veyl）、做什么（更新后台组件，让「全部流量」走 VPN）、顾虑（不是新权限、只用于这个功能、以后不再手动授权）、不影响什么（代理模式不需要授权）。
- 不出现 proxy / TUN / 分流 / 规则集 / helper / daemon / 提权 等内部名词。

#### 4.3.2 应用内的事前说明

用户不该在毫无预期时被系统弹窗打断，所以系统弹窗之前，应用里要先说过一次。

**设置页「后台组件」行**——条件是 `needs_admin_restart = true`（不是所有 `stale`：新 helper 的
`stale` 会静默换新，不会弹任何东西，这时说「会请求授权」就是假话）：

> 后台组件需要更新：连接「全部流量」时会请求一次系统授权。

- 这一句**替代**现有的「需要输入一次管理员密码」，两行不要同时出现；密码提示由系统弹窗本身给出。
- 已经连着的时候，保留现有的「连接结束后会自动更新。」作为补充；本句照常显示，不另写一版。
- 只有「检查并更新」按钮的忙碌态仍写「正在检查…」，不把授权说成检查。

**点「连接全部流量」之后**——后端会在连接流程里调管理员重启，osascript 会阻塞到用户处理完弹窗。
界面必须在发起连接**之前**先渲染出这一句，否则系统弹窗就是唯一的信息源：

> 正在准备后台组件，系统会请求一次授权。

- 中间区 44px 的状态大字放不下整句：大字写「正在准备后台组件」，下一行小字写「系统会请求一次授权。」；读屏仍合成完整一句。
- 替换同一时刻的「正在连接」，连接按钮在提示期间禁用；弹窗关闭后按原状态继续。
- 用户取消后按 §4.4 收尾：应用里照常给出失败说明，不重复弹窗。

### 4.4 失败与拒绝授权

| 情况 | 表现 |
|---|---|
| 用户取消授权 | 记一条 info 日志；不重试、不弹第二次；界面保留「检查并更新」 |
| 执行失败 | 同上，附带日志位置 |
| 拒绝之后的降级 | **TUN 不可用（`helper_missing`）；直连与代理模式照常**，连接按钮仍可用 |

界面不能说成网络故障，也不能显示「假的已连接」。

### 4.5 为什么之后不再需要

新 helper 支持 `restart`：后续每次更新都是 App 让它自己 `exit(75)`，launchd 重新 exec 新文件。
这一步不需要提权——helper 本来就是 root，`launchctl kickstart` 也不再需要。

---

## 5. 生命周期

### 5.1 空闲退出

**规则：没有 sing-box 子进程、没有会话租约、距上次请求 ≥10 分钟，且当前没有请求在处理 → `exit(0)`。**

用 `exit(0)` 是刻意的：`KeepAlive { SuccessfulExit: false }` 只认非零退出，0 正好不触发重启，
下一次 Mach 查询再由 launchd 按需拉起。

10 分钟而不是「App 一退就停」，是因为 helper 分不清「用户正常退出」和「App 崩了」——那需要租约（§6.1）；
而对「无隧道」的情形，多留 10 分钟不会带来实际风险，还能避开用户秒退秒开撞上 launchd 的 10 秒重启节流。

### 5.2 KeepAlive / RunAtLoad

**`KeepAlive` 不动。** 它是两条路径的基础：升级后 `exit(75)` 换新映像、崩溃后自动恢复。
空闲退出用 `exit(0)` 明确避开它。

**`RunAtLoad` 这一版也不动（保持 `true`）。** 它不是无害开关：

- SMAppService 注册的 daemon，改 plist 后是否被 launchd 重新读取，还是必须重新注册，
  我无法从代码断言；
- 重新注册可能让用户在系统设置里的那次批准失效。

保持 `true` + 空闲退出，稳态已经是「开机后最多驻留 10 分钟」。等真机确认 launchd 会重读 plist 之后，
再评估改成 `false`。

### 5.3 按需拉起

`MachServices` 里的 `com.veyl.helper` 让 launchd 在第一次 Mach 查询时拉起 job。所以空闲退出之后，
下一次连接**无提示、无密码**，代价是一次进程启动（约 50–200 ms）。

边界情形：如果用户恰好在 helper 退出后的 10 秒内发起连接，可能撞上 launchd 的重启节流，
表现为第一次连接失败。界面给「重试」，不做自动重试（与现有超时规矩一致）。

### 5.4 收益与代价

| 项 | 内容 |
|---|---|
| 安全收益 | root 进程只在 App 运行期间存在；空转的 root 守护进程是最大的静态暴露面——不驻留就没有可被长期观察的内存、没有可被长期触达的监听器 |
| 诚实的边界 | `MachServices` 是按需启动的，任何本机进程都能通过 Mach 查询让 launchd 把 helper 拉起来。减少的是**驻留时间**，不是**可达性**；真正的边界仍是「连上先验对端签名」 |
| 体验代价 | 下次连接多一次进程启动，无密码、无提示 |

---

## 6. 崩溃、会话租约与退出

### 6.1 会话租约

TUN 运行期间，App 持有一条**不传消息的长 XPC 连接**（会话租约）。helper 监听它的 invalidation：

```
App 崩溃 / 被强杀 / 正常退出
  → 内核关闭连接 → helper 收到 invalidation
  → 等 5 秒（App 可能在重启）
  → 仍没有新租约 → 停 sing-box
```

没有这条租约，App 崩溃后隧道会永远留着，而 helper 又因为「有隧道」永不空闲退出。

租约是 **presence 租约**：从 App 启动一直持到退出。租约断开 5 秒仍无新租约，helper 先停隧道
再 `exit(0)`；正常退出、崩溃、强杀都走这一条。10 分钟空闲只在**没有任何租约**（例如旧版客户端）
时兜底，不是主规则。

### 6.2 退出流程（缺陷修复）

沿用现有的退出对话框（「后台运行」/「退出」），默认倾向后台运行：

| 选择 | 行为 |
|---|---|
| 后台运行 | 进程还在，会话租约还在，隧道不断 |
| 退出 | **先停 TUN 会话，再走原有清理**（撤代理 → 停运行时 → 清明文配置），然后退出 |

`perform_shutdown` 增加停 TUN 这一步，与 E3 / 卸载清理共用同一段代码（`capabilities.md` §3.1）。
停 TUN / 撤代理 / 停运行时失败时**只记日志并继续退出**，不弹窗、不阻塞——以
`commands.md` §7.8.3 为准；用户点「退出」后进程必须结束。

### 6.3 崩溃循环

helper 启动时在 root 状态目录（`/Library/Application Support/Veyl/tun/`）记一条启动时间戳：

- 10 分钟内第 3 次启动 → 写 `degraded` 标记并 `exit(0)`；
- `exit(0)` 不触发 `KeepAlive`，崩溃循环被安全打断；
- App 看到 helper 不在运行、且存在 `degraded` 标记 → `start_failed`，本次运行不再重试。

---

## 7. 失败与回退

| 情况 | 表现 | 处理 |
|---|---|---|
| 重启后 10 秒内 cdhash 未收敛 | `start_failed` | 本次运行不再自动重试；提示重装或重启电脑 |
| 新 helper 崩溃循环 | `start_failed` | §6.3 的守卫打断循环 |
| 磁盘文件验签失败 | `file_invalid` | 不重启、不执行；提示重新安装 |
| 一次性授权被取消 | `helper_missing` | TUN 不可用，直连/代理照常；保留重试入口 |

**不做特权二进制的自动回滚。** 保留一份旧副本、在检测到崩溃后把它塞回包里，看起来体贴，
实际上是让一个启发式决定哪个 root 二进制该被执行：旧 helper 可能不认识新协议、旧版本的漏洞会回来，
而用户看到的却是「自动修好了」。更安全的做法是停下来，给出两条明确的路——重装当前版本，或下载上一版本。

---

## 8. Windows 对齐

Windows 不需要自更新，原因与 macOS 相反：

| 项 | macOS | Windows |
|---|---|---|
| 特权二进制位置 | `Veyl.app/Contents/MacOS/veyl-helper`，随 App 一起被替换 | `C:\Program Files\Veyl\veyl-service.exe`，per-user 的 App 更新碰不到 |
| 谁负责更新 | App（本设计） | **提权安装器**：stop → 替换 → start |
| 检测版本偏斜 | cdhash | 管道 `status` 带 `service_build` |

对齐策略：

- 不做会自停自启的 Windows 服务。SCM 恢复策略 + 安装器才是受支持的路径；
- App 与服务的版本偏斜是正常状态（服务只在提权更新时变），`status.service_build` 只用于提示
  「需要一次管理员更新」，并指向安装器；
- **不自己提权**。提权安装是用户显式动作，不是后台行为。

---

## 9. 契约影响与测试点

### 9.1 XPC（`tun-backend.md`）

- `status` 回复增加 `helper_build`（cdhash hex）与 `helper_version`（仅诊断）；
  Windows 同名位置为 `service_build`。
- 新增方法 `restart`（无参数）→ 回 `{ ok: true }` 后 `exit(75)`。
- **未知方法 = 旧 helper**，这就是版本协商，不新增版本号字段。
- 旧 helper 的 `status` 没有上述字段，App 不得依赖它存在。

### 9.2 命令与事件（`commands.md` / `events.md`）

| 项 | 内容 | 给谁 |
|---|---|---|
| `tun_helper_info {}` | `{ running_build, expected_build, stale, state, needs_admin_restart }`，`state` 取 `running \| not_running \| stale \| start_failed \| file_invalid` | 仅 UI |
| `tun_helper_restart {}` | `{ ok, restarted, needs_admin_restart }` | 仅 UI |
| `helper-update-required` 事件 | 让 UI 不必轮询即可提示 | UI |

退出流程的 TUN 清理写进 `commands.md` 的应用退出小节。

### 9.3 AI 边界

**全部不给 AI 工具。** 重启或安装 root 守护进程不能由模型发起：AI 只会看到 `helper_missing`，
提示用户去设置页处理。一次性授权更不可能由模型触发——那需要用户亲自输入密码。

### 9.4 测试点

| # | 场景 | 期望 |
|---|---|---|
| 1 | 包内文件与运行中 cdhash 不同 | 启动后静默重启，轮询到一致，全程无弹窗 |
| 2 | cdhash 相同 | 零动作，不发 restart |
| 3 | App 降级（包内文件变旧） | 仍然重启到磁盘文件，不因「版本更低」跳过 |
| 4 | 磁盘文件验签失败 | 不重启，`file_invalid`，给重装提示 |
| 5 | 旧 helper（restart 返回未知方法） | 走一次性授权；取消后 `helper_missing`，直连可用 |
| 6 | TUN 运行中检测到 stale | 不重启，会话结束后 5 秒才重启 |
| 7 | helper 已空闲退出后连接 | 按需拉起成功，无提示；延迟在预算内 |
| 8 | 重启后 10 秒不收敛 | `start_failed`，不自动重试 |
| 9 | 10 分钟内第 3 次启动 | `exit(0)` 打断循环，App 显示 `start_failed` |
| 10 | App 崩溃且隧道在跑 | 5 秒后 sing-box 被停，无孤儿隧道 |
| 11 | 退出时选「退出」且隧道在跑 | 先停隧道，再撤代理、停运行时 |
| 12 | 退出时选「后台运行」 | 隧道不断，helper 不空闲退出 |
| 13 | 无隧道、无请求满 10 分钟 | `exit(0)`，之后连接按需拉起 |
| 14 | Windows：服务文件被替换但未重启 | `status.service_build` 落后 → 提示一次管理员更新，不自启 |
| 15 | AI 尝试触发重启 | 无此工具；只能得到 `helper_missing` 并提示用户 |
| 16 | 待授权时点「连接全部流量」 | 应用内先出现「正在准备后台组件，系统会请求一次授权。」，再弹系统弹窗 |
| 17 | `needs_admin_restart = true` 的设置页 | 显示「后台组件需要更新：连接「全部流量」时会请求一次系统授权。」，不与「需要输入一次管理员密码」同时出现 |
