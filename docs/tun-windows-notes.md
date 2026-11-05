# Windows TUN 调研笔记：openmesh-cli 是怎么跑起来的

> 日期：2026-11-05
> 性质：只做调研，不含实现，不改代码。
> 参考代码：`~/ai/openmesh-cli/openmesh-win/`、
> `go-cli-lib/cmd/openmesh-win-core-embedded/`（只读）
> 对照：`docs/windows-tun.md`（Veyl 的 Windows TUN 设计判断）、`docs/tun-privilege.md`（macOS 特权通道）
>
> 这份笔记只回答「openmesh 在 Windows 上是怎么做到的」，以及由此能得出什么结论；
> Veyl 自己怎么做，仍以 `docs/windows-tun.md` 为准。

---

## 0. 一句话结论

openmesh 的 Windows TUN 走的是**最省事的一条路**：整个 GUI 进程以管理员身份运行
（`app.manifest` 里 `requireAdministrator`），sing-box 以 **Go 库**的形式编进同一个进程，
`wintun.dll` 直接 `//go:embed` 进原生 DLL。**没有 Windows 服务、没有特权助手、没有 IPC**。
产品负责人说的「debug 模式能跑 TUN」对应的就是这件事：Debug 构建同样带管理员清单，
在开发机上点过 UAC 之后 TUN 就可用——不存在只属于 debug 的权限通道。

对 Veyl 来说，它证明了「Windows 上 TUN 本身不难」，但它的安全模型（整个界面进程是管理员）
是我们不能照抄的那一部分。

---

## 1. 权限是怎么拿到的（问题 1）

### 1.1 结论

| 机制 | 是否使用 | 证据 |
|---|---|---|
| 整应用管理员提权（UAC） | **是**，且是唯一的提权方式 | `openmesh-win/app.manifest`：`requestedExecutionLevel level="requireAdministrator"` |
| Windows 服务 `OpenMeshWin.Service` | **否**（不是 TUN 通道） | 服务只写心跳文件，见 §1.3 |
| wintun 驱动自带权限 | **否**。wintun 是用户态 DLL + 内核驱动，创建适配器/改路由仍要求调用者已提权 | `go-cli-lib/cmd/openmesh-win-core-embedded/main.go:53`：`if !isProcessElevated()` 直接拒绝 `start_vpn` |

`isProcessElevated()` 的实现是标准的令牌检查：
`OpenProcessToken` + `TOKEN_QUERY` + `token.IsElevated()`
（`admin_windows.go:7-18`；非 Windows 平台固定返回 true，`admin_other.go`）。

### 1.2 权限链路

```
meshflux.exe（WinForms，requireAdministrator）
  └─ 进程内 P/Invoke：openmesh_core.dll!om_request({"action":"start_vpn",...})
       └─ Go 核心（CGO 共享库）→ sing-box 库 → wintun.dll → wintun.sys
```

- GUI 用 `[DllImport("openmesh_core")] om_request` 直接调用原生核心
  （`EmbeddedCoreClient.cs:30-33`），核心与 UI **同进程、同令牌**。
- 核心启动前再次检查是否提权（`main.go:53-61`），未提权时返回
  `"start_vpn failed: administrator privileges required (run app from elevated shell)"`，
  并把 `engineError` 写进状态快照——UI 可以显示原因，但不会降级去跑。
- 只要进程是管理员，wintun 创建适配器、sing-box 改路由/DNS 都不再需要额外授权。

### 1.3 那个 Windows 服务到底是什么

`service/OpenMeshWin.Service/Program.cs` 是一个**骨架**：

- 参数：`--service`（跑 `ServiceBase`）、`--run-once`、`--status`（`Program.cs:10-59`）；
- `OnStart` 只起一个每 3 秒写 `service_heartbeat` 的循环（`:114-167`）；
- 不接触 sing-box、不碰 wintun、没有任何 IPC 接口；
- 安装是**可选项**：`Install-OpenMeshWin.ps1:198-215` 只有传 `-EnableService` 才注册；
  注册脚本要求管理员并直接 `sc create`（`Register-OpenMeshWin-Service.ps1:71-117`），
  默认账户是 LocalSystem。
- GUI 对它的唯一感知是 `sc query Wintun` 和设置页里的状态文字
  （`SystemIntegrationManager.cs:63-92`、`MeshFluxMainForm.cs:1284-1285`）——
  注意它查的是 **wintun 驱动自己的服务名 `Wintun`**，不是 OpenMeshWinService。

结论：**openmesh 没有解决「非特权 GUI + 特权服务」这个问题，它绕开了这个问题。**

### 1.4 为什么 macOS 侧没有对应物

macOS 版走的是 NetworkExtension/host 层（`WINDOWS-CROSS-PLATFORM-CONFIG-COMPATIBILITY-20260313.md`
里明确写了「Apple 平台依赖 NetworkExtension 的 tun 路由路径」），Windows 版则在应用进程内
直接用 sing-box 的 native tun。两边不是同一套代码路径，只是共用同一份 sing-box 配置。

---

## 2. debug 模式怎么跑（问题 2）

### 2.1 Debug 与 Release 的实际差异

openmesh 的 Debug/Release 差异**只有数据目录与显示名**，不涉及权限：

| 项 | Debug | Release | 证据 |
|---|---|---|---|
| 数据根目录 | `%LOCALAPPDATA%\OpenMeshWin` | `%LOCALAPPDATA%\MeshFlux` | `MeshFluxPaths.cs:7-13` |
| 显示名 / 单实例互斥名 | OpenMeshWin | MeshFlux | 同上 |
| 服务日志根 | `%LOCALAPPDATA%\OpenMeshWin` | `%LOCALAPPDATA%\MeshFlux` | `service/.../Program.cs:21-28` |
| 管理员清单 | **有** | **有** | `OpenMeshWin.csproj` 无条件引用 `app.manifest` |
| 驱动 / 引擎 | wintun + Go 核心 | 同左 | 无 `#if DEBUG` 分支 |

所以「debug 能跑 TUN」的真实含义是：**在开发机上，带管理员清单的 debug exe 点过 UAC、
且 wintun.dll 能被找到，TUN 就能起来**。它不是「debug 有特殊权限」。

一个容易踩的点：Visual Studio 本身要以管理员身份运行，否则调试器无法启动
`requireAdministrator` 的目标进程（或每次 F5 都弹 UAC）。

### 2.2 安装方式

- 源码运行：`OpenMeshWin.csproj` 直接引用 `libs/openmesh_core.dll` + `libs/libwinpthread-1.dll`，
  构建时复制到输出目录（csproj 的 `StaleNativeCoreCopies` 目标负责清理旧副本）。
- 打包：`installer/Install-OpenMeshWin.ps1`（可 `-SkipPublish`）或
  `installer/Build-P6-Wix-Msi.ps1`（WiX MSI，self-contained .NET，无需目标机装运行时）。
- 服务安装：只有 `-EnableService` 时才 `sc create`，且脚本自己检查管理员
  （`Register-OpenMeshWin-Service.ps1:71-73`）。TUN 不依赖这一步。

### 2.3 GUI ↔ 引擎的通信

**主路径没有 IPC**：`CoreClientFactory.CreateDefault()` 永远返回 `EmbeddedCoreClient`
（`CoreClientFactory.cs`），请求通过 `om_request` 在进程内完成；
`CoreProcessManager` 在 code 里明确写死「Embedded mode is required」，
不再支持拉起外部核心进程（`CoreProcessManager.cs:12-22`）。

**遗留路径**是命名管道 `openmesh-win-core`：`core/OpenMeshWin.Core/Program.cs` 是一个
「legacy/mock」的命名管道服务器（`:39-62`），带一个心跳看门狗——GUI 每 20 秒写
`%APPDATA%\<root>\app_heartbeat`（`AppHeartbeatWriter.cs`），核心若发现心跳超过 45 秒
就自动停 VPN（`core/.../Program.cs:1011-1055`）。这条路径当前不被默认使用，
但它的「GUI 死了就断开」思路值得记一笔。

**服务没有 IPC**：GUI 只读心跳文件/查服务状态，不存在「UI 请求服务起 sing-box」的通道。

### 2.4 调试时怎么看 sing-box 日志

三个日志位置，都是文件，没有实时日志窗口：

| 日志 | 位置 | 写入方 |
|---|---|---|
| 应用日志 | `%LOCALAPPDATA%\<root>\logs\app.log`（1 MB × 5 轮转） | `AppLogger.cs:5-20` |
| 核心调试日志 | `%LOCALAPPDATA%\<root>\runtime\logs\core_debug.log` | `main.go:2960-2985`（`debugLog`） |
| 服务日志 | `%LOCALAPPDATA%\<root>\logs\openmesh-win-service.log` | `service/.../Program.cs:169-194` |

- `debugLog` 会依次尝试 runtime 目录、`%LOCALAPPDATA%\OpenMeshWin\runtime\logs`、
  当前目录 `core_debug.log`、`%TEMP%\openmesh_core_debug.log`，第一个能打开的生效。
- GUI 设置页有「打开日志目录」按钮（`MeshFluxMainForm.cs:978-990`）。
- 核心还会把配置摘要（tun/DNS/route 关键字段）打进 `core_debug.log`
  （`logConfigDiagnostics`，`main.go:2651-2790`），这是排查 TUN/DNS 问题的主要手段。

---

## 3. 驱动与运行库（问题 3）

### 3.1 依赖清单

| 依赖 | 形态 | 说明 |
|---|---|---|
| `wintun.dll` | 用户态 DLL，内含 `wintun.sys` | 官方 WireGuard 构建，本仓库里是 **0.14.0.0**（`strings` 可见 `wintun.sys`、`WintunCreateAdapter` 等） |
| `wintun.sys` | 内核驱动 | 由 wintun.dll 在首次创建适配器时解出并注册服务 `Wintun`；**它必须是签名的**（Windows 内核驱动强制签名），WireGuard 的官方 DLL 就是已签名的 |
| sing-box | **不需要 `.exe`** | 以 Go 库形式编进 `openmesh_core.dll`（`main.go:31-35` 引 `github.com/sagernet/sing-box`，`:1759-1768` `box.New` + `instance.Start()`） |
| `libwinpthread-1.dll` | CGO 运行库 | 随包（`libs/`、`deps/`） |
| .NET | 10.0（`net10.0-windows`） | MSI 默认 self-contained，目标机不需要预装 |

### 3.2 wintun.dll 的加载方式（值得注意）

1. `main.go:240-241` 把 `wintun.dll` **`//go:embed` 进核心 DLL**，随二进制分发。
2. `findWintunPath()`（`main.go:3124-3155`）的搜索顺序：
   `OPENMESH_WIN_WINTUN_DLL` 环境变量 → `collectSearchRoots()`（仓库根、**当前工作目录**、
   `PWD`、exe 目录、…）下的 `wintun.dll` / `deps/wintun.dll` →
   `%WINDIR%\System32`、`SysWOW64` → **最后才把内嵌副本解压到 `<runtime>/working/wintun.dll`**。
3. `ensureWintunOnPath()`（`main.go:2630-2648`）把找到的目录插到进程 `PATH` 最前面，
   让 sing-box 的 wintun 包用默认搜索顺序能找到它。

**签名结论**：wintun.dll 本身是用户态 DLL，不需要签名才能被加载；但它释放的 `wintun.sys`
是内核驱动，**必须签名**——用官方预编译 DLL 就不需要自己处理驱动签名；自己从源码编译
则要自己解决驱动签名（测试签名模式或 EV 证书），这是不建议的路径。

### 3.3 运行时/安装器的配套

- `installer/Verify-Package-Contents.ps1` 与 `tests/Run-P6-Wintun-Guard.ps1` 会在打包时
  校验 `wintun.dll` 是否存在、是否被显式要求（`-RequireWintun`）；`-AutoCopyWintun`
  负责把它复制进包。
- 预检脚本 `tests/Run-P6-Release-Preflight.ps1:1510-1560` **只检查** `signtool.exe` 和
  本机是否存在代码签名证书，**不做签名**。也就是说 openmesh 的发布签名不是流水线自动完成的，
  依赖开发者机器上的证书与手工步骤。

---

## 4. 对 Veyl 的启示（问题 4）

### 4.1 openmesh 与 Veyl 是两种安全模型

| | openmesh（Windows） | Veyl（macOS，已设计） |
|---|---|---|
| 提权对象 | **整个 GUI**（含界面进程） | 独立的 root helper（`veyl-helper`） |
| GUI 权限 | 管理员 | 普通用户 |
| 引擎位置 | 与 GUI 同进程（Go 库） | helper 的子进程（`sing-box` 可执行文件） |
| IPC | 无（进程内 P/Invoke） | XPC + 对端代码签名要求 |
| 信任根 | 进程本身就是管理员（签名只用于 SmartScreen/AV） | 系统目录 + 签名 + allowlist |

**不能照抄的部分**：Veyl 的界面是 Tauri + WebView。把 WebView 跑成管理员意味着
一次前端注入/依赖投毒就是全机管理员——正是 `docs/tun-privilege.md` §1 反对的那类结构。
openmesh 用 WinForms 且没有远程内容，风险面小得多，但这不是 Veyl 可以接受的边界。

**可以复用的部分**（与平台无关的原则，`docs/windows-tun.md` §2.2 已列）：
请求里不放路径、配置走 allowlist、只接受 tun 入站、先验对端再读消息、失败关闭。

**可以参考的具体做法**：

1. **sing-box 以库形式嵌入**是可行的（Go 共享库 + CGO）。对 Veyl 是否值得，取决于我们是否愿意
   把 Go 工具链带进 Windows 构建；`docs/windows-tun.md` 目前的设计是随包 `sing-box.exe`，
   更贴近现有 macOS 运行时流水线，建议先保持不变。
2. **wintun.dll 随包**是标准做法：与 `sing-box.exe` 同目录、架构匹配即可；不要自己编译驱动。
3. **启动重试**：Windows 上 wintun 适配器销毁与下一次创建会竞态，openmesh 对
   `"Cannot create a file when that file already exists"` 做一次 900 ms 重试
   （`main.go:1786-1808`）。Veyl 的 Windows 会话层应预留同样的重试。
4. **心跳看门狗**：如果 Veyl 采用「服务 + 子进程」模型，GUI 崩溃后要不要断开是产品决定；
   openmesh 的 legacy 核心用 45 秒心跳文件实现自动断开，可作参考（Veyl 的 macOS 设计选择的是
   App 崩溃仍保持连接，二者不同，别混用）。

### 4.2 最省事的 Windows 路径（按成本排序）

| 方案 | 成本 | 安全 | 与 Veyl 现状的匹配 |
|---|---|---|---|
| A. 整应用提权 + 进程内 sing-box（openmesh 路线） | 最低 | **差**（WebView 管理员） | 与 macOS helper 设计冲突，不建议 |
| B. 安装时注册 LocalSystem 服务 + 命名管道（`docs/windows-tun.md` §3.2） | 中 | 好 | **与现有 macOS 信任模型最接近**，推荐 |
| C. 每次连接用 UAC 起一个管理员子进程 | 低 | 中 | 每次弹 UAC，二级用户不可接受 |

B 就是 `docs/windows-tun.md` 已经定的方向；openmesh 的调研不改变这个结论，只是证明
「Windows 侧的 TUN 驱动本身不是难点，难点在特权边界」。

### 4.3 哪些能复用、哪些不能

| macOS 现状 | Windows |
|---|---|
| SMAppService / launchd plist | 不能复用；换 SCM（`CreateServiceW` / `sc create`） |
| XPC + `set_peer_code_signing_requirement` | 不能复用；换命名管道 + `GetNamedPipeClientProcessId` + `WinVerifyTrust` |
| helper 的信任根（系统目录、逐级校验） | **原则复用**；路径换 `Program Files` / `%ProgramData%`，ACL 显式设置 |
| 配置 allowlist / 无路径请求 / 只收 tun 入站 | **直接复用**（与平台无关） |
| 随包 sing-box 二进制 | 复用形态；Windows 需要额外随包 `wintun.dll` 并做架构匹配 |
| 孤儿进程回收 | 不能复用；Windows 的 `tasklist` 拿不到命令行，需要按 pid/服务状态重新设计 |
| TUN 配置模板 | **不能直接复用**，见 §5.1 |

### 4.4 「debug 比正式分发更容易」在 Windows 上成立吗

成立，但原因和 macOS 不同：

- **权限**：不成立。openmesh 的 Debug/Release 都要求管理员；Veyl 的模型里 debug 与 release
  都走同一个服务，没有 debug 特权通道。
- **签名**：成立。debug 时代的 exe 可以完全不签名，在本机点过 UAC 就能跑；
  分发给用户时，未签名的管理员 exe 会被 SmartScreen 标「未知发布者」，
  企业策略可能直接拦，常驻服务更是如此（`docs/windows-tun.md` §3.3 已列为阻塞项）。
- **驱动**：不成立。wintun 驱动无论 debug 与否都必须有合法签名（内核态）；
  用官方 DLL 就没有差别。
- **打包**：成立。openmesh 用 `-RequireWintun` 和 wintun guard 测试防止「开发机有、
  安装包没有」；Veyl 的 Windows 打包脚本目前也还没有 Windows zip 与 wintun.dll 的流水线。

---

## 5. 风险与坑（问题 5）

### 5.1 最关键的一条：Veyl 现在的 macOS 配置在 Windows 上会坏

openmesh 的兼容性文档记录了一个真实故障
（`WINDOWS-CROSS-PLATFORM-CONFIG-COMPATIBILITY-20260313.md`）：

- 旧 tun 地址 `172.18.0.1/30`，`route_exclude_address` 里含 `172.16.0.0/12`；
- Windows 上 sing-box 推断 tun DNS peer 为 `172.18.0.2`，它落在排除段内；
- Windows 给这个地址装了一条走物理网卡的路由 → 发往 tun DNS 的查询永远不进隧道 → DNS 超时；
- macOS 走 NetworkExtension，不出这个故障，所以「Apple 上能跑」掩盖了问题。

**Veyl 现在的模板正是同一个形状**：

- `src-tauri/src/tun/mod.rs:18` `TUN_ADDRESS = "172.19.0.1/30"`
- `src-tauri/src/tun/mod.rs:90` 排除表含 `172.16.0.0/12`
- `docs/tun-mode.md` §3 也把 `172.19.0.1/30` 定死

也就是说：**如果直接把 macOS 模板用到 Windows，TUN 的 DNS 会静默失效。**
openmesh 的修法是改用 `198.18.0.1/15` + `dns.strategy = "ipv4_only"` +
`sniff` 排在 `hijack-dns` 之前，并在运行时**硬失败**于 tun 地址与排除段重叠。
Veyl 做 Windows 之前必须先做同样的事（改地址段 + 加 overlap 校验）。

两个跟改地址一起要处理的点：

1. 如果换成 `198.18.0.0/15`，必须把它从 Veyl 的 `FIXED_EXCLUDES` 里拿掉
   （`tun/mod.rs:90` 现在为了 fakeip 排除了这一段；Veyl 不用 fakeip，留着就又是重叠）。
2. openmesh 的可用配置同时给了 IPv4 `198.18.0.1/15` 与 IPv6 `fdfe:dcba::1/126`；
   Veyl 目前只设 IPv4（`builder.rs:200`），Windows 上 IPv6 的行为需要实测
   （Windows 的 tun 与 WFP 对 IPv6 的处理和 macOS 不同）。

### 5.2 驱动与签名

- `wintun.sys` 必须签名——用官方 DLL，不要自己编译；不要修改/重签官方 DLL。
- 服务二进制、提权安装器、主程序都要 Authenticode 签名（EV 更好，SmartScreen 信誉更快）。
- 时间戳必须加，否则证书到期后旧包签名失效。

### 5.3 杀软误报

- 「管理员进程 + 创建 TUN 适配器 + 改路由/DNS」是 AV 启发式的经典触发组合；
  Clash 类工具被误报是常态。openmesh 的缓解手段实际上是**签名 + 稳定构建**，
  仓库里没有额外的 AV 白名单流程。
- 对 Veyl：越晚签名、越频繁改二进制，误报越多；发布前应给 Microsoft 提交样本
  （Microsoft Defender 的误报提交入口）并保持稳定的签名主体。

### 5.4 服务权限与 DLL 劫持

- openmesh 的服务（如果启用）是 LocalSystem + 心跳骨架，本身可攻击面很小；
  真正的风险在「服务将来若解析任何用户输入」。
- openmesh 的 wintun 解析顺序里包含**当前工作目录**（`collectSearchRoots`），
  且 `ensureWintunOnPath` 把结果目录插到 `PATH` 最前。从用户可写目录启动时，
  同名 `wintun.dll` 有被优先加载的可能——这是 elevated 进程的 DLL 劫持面。
  它把内嵌副本只当「最后兜底」，没有把搜索限制在自己的安装目录。
  **Veyl 不要照抄这个顺序**：服务侧只从安装目录/`%ProgramData%` 的固定路径加载，
  并按 `docs/windows-tun.md` §2.4 使用受限搜索（`LOAD_LIBRARY_SEARCH_*`）。
- 同理，openmesh 把内嵌 wintun 解压到 `%LOCALAPPDATA%\<root>\runtime\working`——
  这是用户可写目录；对「整应用已提权」的模型问题不大，但对 Veyl 的服务模型是不可接受的。

### 5.5 卸载残留

openmesh 的 `Uninstall-OpenMeshWin.ps1` 存在两个可以直接记下来的坑：

1. **安装/卸载默认目录不一致**：`Install-OpenMeshWin.ps1` 默认
   `$env:ProgramFiles\meshflux`，`Uninstall-OpenMeshWin.ps1` 默认
   `$env:ProgramFiles\OpenMeshWin`；
2. **`-RemoveUserData` 删错了目录**：它删 `%APPDATA%\<root>`，而应用日志与核心运行时在
   `%LOCALAPPDATA%\<root>`；不传这个开关时用户数据一律留下。

其他 Windows 卸载要点（`docs/windows-tun.md` §3.4 已有）：
停服务 → `sc delete` → 停 sing-box → 删 wintun 适配器（正常退出由 sing-box 清理，
异常退出要兜底）→ 清代理/DNS → 删 `Program Files` 与 `%ProgramData%` → 复读校验。
Wintun 驱动服务（`Wintun`）通常在最后一个适配器删除后由驱动自行退出，
但卸载器仍应检查并不留悬空适配器。

### 5.6 许可证

openmesh 仓库本身是 GPL（`LICENSE.md`），**不要复制它的代码**。
驱动/运行时的许可证结论以 `docs/windows-tun.md` §3.1 为准（wintun 预编译 DLL 的专有许可、
sing-box 的 GPL-3.0），这里只确认：openmesh 的做法就是把官方 `wintun.dll` 原样随包。

---

## 6. 真机验证清单（将来做 Windows 时用）

1. 非管理员启动 → TUN 是否明确报权限错误（而不是卡住/假连接）。
2. 提权后首次连接：适配器名、IPv4/IPv6 地址、DNS 是否如配置。
3. tun 地址与 `route_exclude_address` 重叠时是否**启动即失败**（Veyl 需要补这个校验）。
4. 断开后：适配器删除、路由恢复、DNS 恢复、没有残留 `Wintun` 适配器。
5. 与其它 VPN / 公司 DNS / IPv6-only 环境共存。
6. 卸载后复读：无服务、无适配器、无 `Program Files`/`%ProgramData%` 残留。
7. 从用户可写目录启动时，wintun.dll 的解析路径是否仍指向安装目录（防劫持）。

---

## 附：关键代码索引

| 位置 | 内容 |
|---|---|
| `openmesh-win/app.manifest` | `requireAdministrator` |
| `openmesh-win/EmbeddedCoreClient.cs:30-33` | `om_request` P/Invoke |
| `openmesh-win/CoreClientFactory.cs` | 固定 embedded 后端 |
| `openmesh-win/service/OpenMeshWin.Service/Program.cs` | 心跳骨架服务 |
| `openmesh-win/installer/Register-OpenMeshWin-Service.ps1:71-117` | 管理员检查 + `sc create` |
| `go-cli-lib/cmd/openmesh-win-core-embedded/main.go:53-61` | 运行期提权检查 |
| 同上 `:240-241`、`:3124-3155`、`:2630-2648` | wintun 内嵌、查找、PATH |
| 同上 `:1759-1768`、`:1786-1808` | `box.New` / `Start`、创建竞态重试 |
| 同上 `:1912-2010` | Windows 配置兼容（auto_detect_interface、DNS、overlap 检查） |
| 同上 `:2960-2985` | `core_debug.log` |
| `WINDOWS-CROSS-PLATFORM-CONFIG-COMPATIBILITY-20260313.md` | tun 地址与排除段重叠的真实故障 |
| `docs/windows-tun.md` | Veyl 自己的 Windows TUN 设计与前置条件 |
