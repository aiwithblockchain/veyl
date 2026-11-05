# Windows TUN

> 日期：2026-11-04
> 性质：设计判断记录，不含实现。对照 `docs/tun-privilege.md`（macOS 特权通道）。
> 依据：当前工作树代码、`docs/tun-mode.md`、`docs/build-and-release.md`、`docs/capabilities.md` §3.1
> 结论：**现在不具备开工条件**，缺什么见 §5。
> **2026-11-05 更正**：对端校验改为**只看签名、不看客户端路径**（§2.1、§3.2）。应用按 per-user 安装，要求客户端在 `Program Files\Veyl` 会拒掉我们自己的 App。路径白名单从此只约束服务自己执行/加载的文件。同日 W0–W2 评审追加两条：对端校验是**双向**的（客户端也要验服务端），且两侧读取都要有超时（§3.2）。

---

## 0. 一句话

macOS 的特权模型（SMAppService + XPC + Security.framework）在 Windows 上没有对应物，**不是移植，是重做**。重做的核心不是 Wintun（那是最好办的一步），而是**特权服务不能被普通用户可写的位置影响**——macOS 第一版就栽在这里，Windows 会以 DLL 搜索顺序、服务 ImagePath、命名管道抢占、`%LOCALAPPDATA%` 等形式重演。

---

## 1. 现状（按代码，不凭印象）

### 1.1 已经有 `#[cfg(windows)]` 的部分

| 位置 | 实现 | 状态 |
|---|---|---|
| `proxy/windows.rs` | WinINet 系统代理：注册表 `Internet Settings` 的 `ProxyEnable` / `ProxyServer` / `ProxyOverride`，改完调 `InternetSetOptionW` 刷新 | **可用**，一级用户的本机代理模式走这条 |
| `netcfg.rs` | `flush_dns` 走 `ipconfig /flushdns`；`read()` 在非 macOS 返回 `UNSUPPORTED` | 刷新可用，完整网络读取没有 |
| `runtime/process.rs` | `tasklist` 判存活与取镜像名；**拿不到完整命令行**，`reclaim_stale` 会一律跳过 | 代理模式可用；孤儿进程回收是已知缺口 |
| `runtime/manager.rs` | 数据目录 `%USERPROFILE%\.veyl` | 代理模式可用；**特权服务不能沿用** |
| `runtime/archive.rs` | zip 解压时拒绝带盘符的路径段 | 可用 |
| `runtime/fsutil.rs` | Windows 文件权限/原子替换分支 | 可用 |
| `lifecycle.rs` | macOS 的 Dock 激活策略没有 Windows 分支 | 无影响 |
| `secrets/mod.rs` | 平台相关存储分支 | 已有 |
| `agent/commands.rs` | 平台标识 | 已有 |

结论：**代理模式（一级、三级）在 Windows 上基本成立**；系统代理、运行时启停、种子/配置/规则这些与平台无关的部分可以复用。

### 1.2 TUN 这条链在非 macOS 的状态

| 组件 | 门控 | 非 macOS 的结果 |
|---|---|---|
| `tun/xpc.rs` | `#[cfg(target_os = "macos")]` | 不存在 |
| `tun/trust.rs` | `#[cfg(unix)]` | 不存在 |
| `tun/privilege.rs` | `select()` 在非 macOS 返回 `Unsupported` | `ensure_registered()` 直接报 `helper_missing`：「这个平台上还不支持接管全部流量」 |
| `tun/mod.rs::collect()` | `#[cfg(target_os = "macos")]` | 返回空 vec，**拿不到本机网段**，确认页少一句、内网排除只能手填 |
| `tun/session.rs` | **无 cfg** | 无条件 `use super::xpc` —— 在 Windows 上这个模块找不到 `xpc`，**静态看会编译失败** |
| `src/bin/veyl-helper.rs` | **无 cfg，且 Cargo.toml 无条件声明 `[[bin]]`** | Windows 上会尝试链接 Security / CoreFoundation / XPC，失败 |
| `tun/protocol.rs` 的 `runtime_sha256` / `rules_archive_sha256` | `#[cfg(unix)]` | Windows 上返回 `None`，helper 逻辑也不存在 |
| `config/builder.rs` 的 TUN 入站 | 共用 | 生成的字段按 macOS 写：`interface_name` 留空、没有 `strict_route`；Windows 需要平台差异 |
| `build.rs` | 共用 | 只找 `resources/runtime/sing-box`，不找 `sing-box.exe`；Windows 构建拿不到运行时哈希 |
| `fetch-runtime.mjs` | 共用脚本 | 只处理 `darwin` + `lipo`；没有 Windows zip 与 `wintun.dll` |
| `build-msi.ps1` | Windows 打包 | 只准备规则与图标，**不安装运行时、不安装 helper、不注册服务** |

> **关于「能跑什么」的准确说法**：代理模式在 Windows 上可用；TUN 明确返回「不支持」。但当前工作树里的 TUN 代码（未提交）在 Windows 上**很可能连编译都过不了**（`tun::session` → `xpc`）。这一条是静态结论，尚未在 Windows 上实测——因为这份工作树没进过 Windows CI。

### 1.3 现在 Windows 上跑一次会发生什么

1. 启动 App → 代理模式正常（WinINet 注册表、运行时启停、配置/规则/种子都有 Windows 分支）。
2. 用户选「接管全部流量」→ `privilege::select()` 返回 `Unsupported` → 报 `helper_missing`。
3. 没有 Wintun、没有服务、没有 `sing-box.exe` 的随包路径；即使手动放一个，也没有特权进程去以管理员身份起它。

---

## 2. macOS 那套为什么一行都用不了

### 2.1 对应关系

| macOS | Windows | 是否可平移 |
|---|---|---|
| `SMAppService` 注册 LaunchDaemon | **SCM**（Service Control Manager）：`CreateServiceW` / `sc create`，服务账户 `LocalSystem`，启动类型 Automatic | 概念对应，代码全重写 |
| `Contents/Library/LaunchDaemons/*.plist` | 服务注册项（注册表 `HKLM\SYSTEM\CurrentControlSet\Services\...`）+ `binPath` | 重写 |
| XPC Mach service | **命名管道** `\\.\pipe\veyl-helper`（`CreateNamedPipeW`，带 security descriptor，`PIPE_REJECT_REMOTE_CLIENTS`） | 重写 |
| `xpc_connection_set_peer_code_signing_requirement` | 连接后取客户端 PID（`GetNamedPipeClientProcessId`），校验其 **Authenticode**（`WinVerifyTrust`）签名者 | 重写（校验内容对齐：都只看签名身份） |
| `SecStaticCodeCheckValidity` 验 bundle | `WinVerifyTrust` 验服务/客户端 exe；资源用编译进二进制的哈希固定 | 概念对应 |
| `SecCodeCheckValidity` + designated requirement | Authenticode 签名者（发布者 + 证书指纹） | 概念对应，代码重写 |
| `/Applications/Veyl.app` 作为安装根 | `C:\Program Files\Veyl\`（管理员可写、普通用户不可写） | 概念对应 |
| `Contents/Resources/...` 随包资源 | 安装目录下的 `runtime\` / `rules\`；**不是** `%LOCALAPPDATA%` | 重写路径 |
| `/Library/Application Support/Veyl`（root 信任根） | `C:\ProgramData\Veyl\`（ACL：SYSTEM + Administrators 完全控制，普通用户只读或不可读） | 概念对应，ACL 必须显式设 |
| launchd `KeepAlive` | 服务恢复策略（`sc failure` / `SERVICE_CONFIG_FAILURE_ACTIONS`） | 重写 |
| `codesign` + notarytool | `signtool` + 时间戳 + SmartScreen 信誉 | 重写 |
| `lipo` universal | x64 与 arm64 分开构建/分发；Wintun DLL 也要匹配架构 | 重做 |

### 2.2 可以平移的原则

这些与平台无关，Windows 必须继续遵守：

1. **特权进程不信任普通用户可写的位置。** 信任根来自签名，不来自文件夹权限。
2. **请求里不出现路径。** 只收配置内容；运行时、规则、日志、pid 由服务自己决定。
3. **配置走 allowlist，多余键拒绝而不是忽略。**
4. **只允许 `type: "tun"` 入站；Clash API 只绑回环；规则集不许远程引用。**
5. **先验对端，再读写消息——双向。**
6. **运行时与规则用编译进二进制的哈希固定；失败关闭，不降级。**
7. **停止/卸载与 E3 共用同一段清理代码。**

### 2.3 必须重做的部分

- IPC 与对端认证（命名管道 + Authenticode + 进程路径）。
- 服务注册、启动类型、恢复策略、服务控制权限。
- 安装器/卸载器（MSI custom action、服务创建/删除、Wintun 适配器清理）。
- 运行时与规则的落盘位置、ACL、哈希固定方式。
- 平台差异的 sing-box 配置（`strict_route`、`stack`、`interface_name`、`wintun.dll`）。
- 签名与发布流水线（证书、时间戳、SmartScreen、MSI 签名）。

### 2.4 「用户可写位置」在 Windows 上会以什么形态出现

macOS 第一版的错误是「root helper 读 `~/Library/Application Support` 里的 control.json」。Windows 的等价入口更多：

| 形态 | 后果 |
|---|---|
| **当前 `%USERPROFILE%\.veyl`** | 服务若从这里读 `sing-box.exe` / `wintun.dll` / 配置，任何用户进程都能替换二进制 → LocalSystem 执行 |
| **DLL 搜索顺序** | 服务从当前工作目录或 `%PATH%` 加载 `wintun.dll`，可被同名 DLL 劫持 |
| **服务 `ImagePath` 可写** | 服务二进制若放在用户可写目录，改文件即提权 |
| **命名管道抢占** | 服务启动前别人先创建同名管道，客户端连到假服务；必须 `FILE_FLAG_FIRST_PIPE_INSTANCE` + 严格 ACL |
| **临时目录 / `%TEMP%`** | 服务解压运行时或写配置到用户可写目录 |
| **更新路径** | App 以用户身份下载新二进制，再让服务执行；必须走签名安装器或由服务验签后原子替换 |
| **日志/配置目录** | 服务写 `%LOCALAPPDATA%`，用户可替换目录或符号链接（junction） |

**结论：Windows 服务的所有输入（可执行文件、DLL、配置、规则、日志、pid）都必须位于 `Program Files` 或 `ProgramData` 下、由管理员 ACL 保护；服务的工作目录不能是用户目录；加载 DLL 用绝对路径/受限搜索。**

---

## 3. Windows 上 TUN 具体需要什么

### 3.1 驱动层

sing-box 在 Windows 上的 TUN 入站依赖 **Wintun**，官方 Windows 发布 zip 里自带 `wintun.dll`，必须与 `sing-box.exe` 同目录、架构匹配（amd64 / arm64 分开）。

**许可证（需要法务复核，以下为公开资料结论）：**

- **Wintun 源码是 GPL-2.0**。
- **wintun.net 提供的预编译签名 DLL 不是 GPL-2.0**：它随 ZIP 附带一份单独的、更宽松但仍是专有的许可。允许随使用其公开 API 的软件一起分发**未修改的官方 DLL**；禁止反向工程、修改、去除版权声明，也不得单独转售。
- **因此：随包必须使用 wintun.net 官方 ZIP 里的原始 `wintun.dll`，不要自己从源码编译后分发**（那会落回 GPL-2.0），并附上它的许可文本。
- sing-box 本身是 **GPL-3.0-or-later**；分发 `sing-box.exe` 需要附许可证与源码获取声明（macOS 已有同类义务，Windows 需补齐）。
- 这是许可证合规判断，不是法律意见；发布前让法务确认。

另一个选择是不用 Wintun、自己写 WFP 驱动或换驱动层——那是更大的工程与签名/兼容性负担，不建议第一期做。

### 3.2 提权形态（已定）

**决定：安装不要求管理员权限；首次需要 TUN 时再提权安装常驻 LocalSystem 服务；之后不再每次弹 UAC。设计目标是「随时可以用，不用重装」。**

理由：

- 与 macOS「授权一次、之后不再提示」保持一致；`docs/tun-mode.md` §4 拒绝「每次弹管理员密码」是同一个判断。
- **不在安装时把 TUN 的路堵死。** 用户装的时候可能没有管理员权限，或者不愿意授权；不能因此装出一个「永远用不了 TUN」的版本。
- 提示时机是**AI 判定需要 TUN 之后**，不是一进门就弹。没有这个需求的人不会看到管理员提示。

#### 时序（不可颠倒）

1. **正常安装，不要求管理员权限。**
2. 用户走到需要 TUN 的那一步（例如 AI 判定必须接管全部流量）→ 这时才提示需要管理员权限。
3. 提权安装服务：明确要求管理员权限；用户拒绝则 TUN 不可用，但**应用本身照常可用**。
4. **之后随时可以再授权**：只重试提权安装服务，**不需要重新安装应用**。

#### 用户拒绝授权之后

| 能力 | 状态 |
|---|---|
| 代理模式（一级 / 三级） | 正常，不受影响 |
| TUN / 接管全部（二级） | 不可用；返回权限类错误（`tun_denied` / `helper_missing`） |
| 再次授权 | 随时可重试；不需要重装 |
| 已经建立的代理连接 | 不受影响（失败发生在启动 TUN 之前） |

界面不能显示「假的已连接」，也不能把「没有管理员权限」说成网络故障。这是权限问题，不是网络问题（`docs/tun-mode.md` §8）。

#### 运行中提权去安装服务：两条路

Windows 上从非管理员进程安装服务必须先提权。两种可行做法：

| 做法 | 用户看到什么 | 判断 |
|---|---|---|
| 用 `ShellExecuteW(..., "runas", ...)` 重新启动自身（带 `--install-service` 参数） | UAC 弹窗；主窗口可能闪一下或出现第二个实例；取消返回 `ERROR_CANCELLED`（1223） | 可行，但体验差；要处理单实例与焦点 |
| 启动一个小的、已签名的提权安装器（同一 exe 带参数，或独立的 `veyl-setup.exe`） | 只弹 UAC；主界面不动；取消无副作用 | **推荐** |

两种做法的共同前提：

- **当前用户必须有管理员权限，或能在 UAC 里提供管理员凭据。** 标准用户无法完成提权；这种情况下 TUN 就是不可用，不能说「再试一次」就能好。
- **服务安装本身需要管理员**：`CreateServiceW`、写 `Program Files` 与 `%ProgramData%` 都需要。
- **从用户可写目录启动提权进程是一条风险**：提权安装器必须签名，启动前校验自身；UAC 会显示发布者，用户据此判断。不要把「任意路径的 exe」直接 `runas`。

#### 安装器形态（这条决定能不能做到"安装不要求管理员"）

- Tauri 的 **MSI 是 perMachine**（安装到 `Program Files`，需要管理员）；**NSIS 默认 `currentUser`**，可以无管理员安装。
- 要满足本决定，**安装包必须是 per-user 形态**（NSIS `currentUser`，或自定义 per-user MSI）；应用本身装在用户目录。
- 服务、运行时、规则在**首次提权时**另行安装到 `C:\Program Files\Veyl\` 与 `%ProgramData%\Veyl\`。
- **服务绝不能从 per-user 安装目录读取任何东西**——那是用户可写的，见下一节。
- 自动更新只更新 per-user 的应用；服务与随包运行时的更新必须走提权安装器，并重新验签/验哈希。

#### 服务设计

| 项 | 设计 |
|---|---|
| 服务账户 | `LocalSystem`（需要创建 TUN 适配器、改路由/DNS） |
| 安装时机 | **首次需要 TUN 时**，由提权安装器注册；不在应用安装时 |
| 服务启动 | Automatic；崩溃恢复重启（有限次数） |
| App ↔ 服务 | 命名管道；**双向校验**：服务端验客户端签名，客户端用 SCM 的服务 PID 与管道服务端 PID 比对（见下方约束） |
| 服务二进制 | `C:\Program Files\Veyl\veyl-service.exe`，管理员 ACL（**名字定稿**：不与 macOS 的 `veyl-helper` 重名，避免日志、安装器与排障混淆） |
| 运行时 | `C:\Program Files\Veyl\runtime\sing-box.exe` + `wintun.dll`；只从安装目录复制到 `%ProgramData%\Veyl\runtime\<sha256>\` |
| 状态/配置/日志 | `%ProgramData%\Veyl\`，ACL：SYSTEM/Administrators 完全控制，普通用户不可写 |
| 请求内容 | 仍然只有配置 JSON 内容，无路径；沿用 allowlist |

#### 不可信位置（LocalSystem 绝不能读）

**服务以 LocalSystem 运行，所以回到那条不能丢的原则：特权进程绝不能从普通用户可写的位置读任何东西。** Windows 上具体不可信的位置比 macOS 更多：

| 不可信位置 | 为什么 | 服务若读取的后果 |
|---|---|---|
| `%APPDATA%` / `%LOCALAPPDATA%` | 当前用户可写 | 替换配置、运行时、DLL，LocalSystem 执行 |
| `%TEMP%` / `%TMP%` | 用户可写 | 解压目录或临时文件被替换 |
| `C:\Users\<user>\...`（桌面、下载、per-user 安装目录） | 用户可写 | 服务二进制或资源被替换 |
| 服务的工作目录 | 可能被启动方设为用户目录 | DLL 搜索顺序劫持 |
| `%PATH%` 中的用户目录 | 用户可写 | 同名 DLL/EXE 劫持 |
| 用户可创建的 junction / symlink 指向 | 可重定向 | 读写逃逸到别处 |

因此服务**只从 `C:\Program Files\Veyl\`（管理员 ACL）读**二进制、运行时、规则；**只写 `%ProgramData%\Veyl\`（SYSTEM/Administrators ACL）**；工作目录固定为安装目录；DLL 用绝对路径或受限搜索（`LOAD_LIBRARY_SEARCH_*`）。当前实现的 `%USERPROFILE%\.veyl` 是给用户态 App 的，**服务不能沿用**。

#### 卸载必须清干净

对照 `docs/capabilities.md` §3.1 的三条要求（正常使用、异常退出、卸载），卸载这一条必须做到：

1. **注销服务**：停止 + `DeleteService`，清除恢复策略。
2. **卸载驱动/适配器**：Wintun 适配器删除；正常退出由 sing-box 清理，异常退出由卸载器兜底。
3. **删除安装目录**：`C:\Program Files\Veyl\` 与 `%ProgramData%\Veyl\`（配置、日志、pid、staged runtime/rules）。
4. **恢复网络**：撤销系统代理、清除 Veyl 写入的 DNS 覆盖。
5. 复读校验：无服务、无 sing-box、无 Wintun 适配器、无代理指向。

**卸载清理与 E3 必须共用同一段代码**，不能各写一套（`docs/capabilities.md` §3.1）。具体执行顺序见 §3.4。

**命名管道的具体约束：**

- `CreateNamedPipeW` 用 `FILE_FLAG_FIRST_PIPE_INSTANCE`，防止抢占。
- Security descriptor 只允许 `SYSTEM`、`Administrators` 和「已认证用户」中的必要集合；`PIPE_REJECT_REMOTE_CLIENTS`。
- 连接后 `GetNamedPipeClientProcessId` → `OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION)` → `QueryFullProcessImageNameW`（路径**仅写入日志用于诊断**）→ 对镜像做 `WinVerifyTrust`，校验发布者与证书指纹。**不校验客户端路径**：应用按 per-user 安装，路径校验会拒掉我们自己的 App；而签名校验在路径校验面前没有损失——攻击者伪造不了我们的证书，用户目录里的 App 本来就是我们设计的合法位置。进程句柄保持到会话结束，防 pid 复用；连接用户身份由管道 ACL 保证。
- **路径白名单只约束服务自己执行或加载的文件**：服务二进制、`sing-box.exe`、`wintun.dll`、规则归档、staging/状态目录（见 §3.2「不可信位置」）。
- 校验失败直接断开，不读消息。**不要在验证前接受任何配置内容。**
- **客户端也要验服务端。** 服务没在运行时，同一用户的任意进程都可以先创建同名管道冒充服务端——它收到的将是**带节点凭据的完整配置**，还能伪造「已连接」的回复；这时服务端 ACL 帮不上忙，因为服务端根本不存在。所以 App 在连上之后、写第一个字节之前，必须 `OpenSCManager` / `OpenService` → `QueryServiceStatusEx` 取服务 PID，与 `GetNamedPipeServerProcessId` 比对；不一致或服务未运行 → 关闭并报 `peer_unverified`，一个字节都不发（契约 §5.4）。
- **两侧读取都要超时。** 服务端等首帧 5 s；客户端等回复按方法分：`status` / `stop` 10 s，`start` 30 s（首次 start 要复制约 78 MB 的 `sing-box.exe` 与 `wintun.dll`，慢盘与 Defender 扫描下 10 s 会误判）。超时即断开；服务端 `start` 在时限内写不完回复时必须回滚已 spawn 的进程，不留孤儿。数值以契约 §1.3 为准，不在本文另抄一份。

### 3.3 代码签名

**单独列，因为它是分发的前置条件。**

- 需要 **Windows 代码签名证书**：OV 或 EV。EV 对 SmartScreen 信誉更直接；OV 现在通常也需要硬件令牌/HSM。
- 替代方案：**Azure Trusted Signing**（云签名），CI 可用 service principal；或 DigiCert KeyLocker / SSL.com eSigner 等云 HSM。
- 必须带**时间戳**（`/tr` + `/td sha256`），否则证书到期后旧签名失效。
- 签名顺序：签 `veyl.exe` / 提权安装器 / 服务二进制 → 打 per-user 安装包 → 签安装包 → `signtool verify /pa /v`。
- 没有证书的后果：SmartScreen 显示「未知发布者」、企业环境可能直接拦截；**提权安装器与常驻服务都必须签名**——用户是在 UAC 弹窗里看发布者做决定的。
- Wintun 的驱动由 WireGuard 签名；不要改它。sing-box.exe 由上游发布，若我们重新签名要注意 GPL 与签名身份；通常保持上游签名并在安装器中校验哈希。

### 3.4 安装与卸载

#### 第一阶段：应用安装（per-user，不要求管理员）

1. 用户运行 per-user 安装器（NSIS `currentUser`，或自定义 per-user MSI），**不弹 UAC**。
2. 安装到用户目录（例如 `%LOCALAPPDATA%\Programs\Veyl`）。
3. **不安装服务、不写 `Program Files` / `%ProgramData%`、不创建 Wintun 适配器。**
4. 应用照常可用：代理模式（一级/三级）不受影响。

#### 第二阶段：首次需要 TUN 时提权安装服务

触发条件：**AI 判定需要 TUN，且用户确认**。不是安装时，也不是首启时。

1. 启动已签名的提权安装器（推荐独立小进程；UAC 弹窗）。
2. 校验自身签名，校验随包 runtime / `wintun.dll` / 规则归档的哈希。
3. 复制服务二进制、`sing-box.exe`、`wintun.dll`、规则归档到 `C:\Program Files\Veyl\`。
4. 创建 `%ProgramData%\Veyl\` 并设置 ACL。
5. 注册服务（`CreateServiceW`，LocalSystem，Automatic），设置恢复策略。
6. 启动服务；App 通过命名管道完成对端验签，开始 TUN。
7. 用户取消 UAC → `ERROR_CANCELLED`（1223），返回 `tun_denied`；应用保持代理模式，**之后可重试**。

**关键约束：服务与运行时来自提权安装器内嵌/校验过的副本，不能直接引用 per-user 的应用安装目录**——那是用户可写的。

#### 更新

- per-user 应用按自己的安装器更新，不需要管理员。
- 服务、运行时、规则的更新必须再次走提权安装器：验签 + 验哈希 + 原子替换；**不能由用户态进程直接替换 `Program Files` 下的文件**。
- 更新失败保留旧版本；不因为更新失败把用户踢回「重装」。

#### 卸载（与 E3 共用清理代码）

1. 停止并删除服务。
2. 停止 sing-box 子进程；删除 Wintun 适配器（正常退出时 sing-box 会清理；异常退出要兜底）。
3. 恢复系统代理备份、清除 Veyl 写入的 DNS 覆盖。
4. 删除 `%ProgramData%\Veyl\`（含配置、日志、pid、staged runtime/rules）。
5. 删除 `C:\Program Files\Veyl\`（服务与运行时）；per-user 应用目录由应用卸载器删除。
6. 复读校验：无服务、无 sing-box、无 Wintun 适配器、无代理指向。

对照 `docs/capabilities.md` §3.1：停止运行时 → 撤销代理 → 清 DNS → 删明文配置 → 复读校验。Windows 的差异是多了「删服务 + 删适配器」，以及服务目录与 per-user 应用目录分开清理。

### 3.5 平台差异的 sing-box 配置

| 项 | macOS 现状 | Windows 需要 |
|---|---|---|
| `interface_name` | 留空（`utunN`） | 可留空让 Wintun 自动命名；不得写死 macOS 风格 |
| `strict_route` | 未设 | **建议开启**：Windows 上它用 WFP 阻止 TUN 外的 DNS/流量泄漏 |
| `stack` | 默认 | 需实测 `gvisor` / `system` / `mixed`；Windows 的 `system` 栈与 WFP 行为不同 |
| `wintun.dll` | 不涉及 | 必须与 `sing-box.exe` 同目录、同架构 |
| DNS 劫持 | 已配 | 同样需要 `hijack-dns` + `default_domain_resolver`；`strict_route` 配合 |
| 内网排除 | `ifconfig` 反推 | 需要 `GetAdaptersAddresses` / `GetIpAddrTable` 反推；当前 `collect()` 返回空 |
| 路由/指标 | 系统路由表 | `auto_route` 走 WFP；需测接口 metric、IPv6、与其它 VPN 共存 |

---

## 4. 工作量与风险

### 4.1 粗估

假设：1 名熟悉 Windows 系统编程的工程师、有签名证书、有 Windows 测试机、x64 先行。

| 块 | 量级 |
|---|---|
| 服务 + 命名管道 + 对端验签 + ACL | 1–2 周 |
| Wintun/运行时/规则 staging + 平台配置差异 | 1–2 周 |
| MSI 安装/卸载、服务注册、适配器清理 | 1 周 |
| 签名、CI、真机联调（TUN/DNS/路由/卸载） | 1 周 |
| **合计** | **4–6 周** |

证书采购与身份验证（EV / Azure Trusted Signing）另计 1–3 周，且不受工程进度控制。

### 4.2 风险（按严重度）

| # | 风险 | 严重度 | 说明 |
|---|---|---|---|
| 1 | **没有 Windows 代码签名证书** | 阻塞 | 没有它，特权的常驻服务无法正常分发；SmartScreen/企业策略会拦 |
| 2 | **没有 Windows 测试机** | 阻塞 | CI 只能跑单元测试，不能验证 TUN 实际接管、DNS、路由、卸载干净 |
| 3 | **服务提权面写错** | 高 | 命名管道 ACL、DLL 搜索顺序、`%LOCALAPPDATA%`、ImagePath，任何一个都是本地提权 |
| 4 | **Wintun / sing-box 许可证合规** | 高 | Wintun 预编译 DLL 是专有许可；sing-box 是 GPL-3.0；发布前需法务确认与 notices |
| 5 | Windows 网络栈差异 | 中高 | WFP、接口 metric、IPv6、与其它 VPN 共存；uninstall 残留适配器/路由 |
| 6 | 孤儿进程回收 | 中 | 现有 Windows 实现拿不到命令行，`reclaim_stale` 一律跳过；服务模型下要重新设计 |
| 7 | CI 无法覆盖 TUN | 中 | 只能编译/单测；真机验证必须人工 |
| 8 | arm64 Windows | 低（可延后） | x64 先行；arm64 需要额外资产与 Wintun DLL |
| 9 | 验签 TOCTOU 与 `WTD_REVOKE_NONE` 吊销语义 | 低 | 属**已登记的残余风险**，不是待修缺陷：影响限于「未签名代码借签名身份连上服务」。取舍与可能的收口见契约 §9 的 R1 / R2 |

---

## 5. 前置条件：现在能开工吗

**结论：不能。** 缺的是两样外部条件，另有一个安装器形态要先定；提权时机已定，见下表。

| # | 条件 | 现状 | 缺口 |
|---|---|---|---|
| 1 | **Windows 代码签名证书 / 云签名账号** | 仓库只有 `sign-windows.ps1` 的 hook；本机没有 `VEYL_WIN_SIGN_CMD` / `VEYL_WIN_CERT_THUMBPRINT`；无证据表明公司持有 Windows 证书 | **无法确认是否已有**。没有证书就不能分发需要管理员权限的常驻服务 |
| 2 | **Windows 测试机** | 文档里的测试机指 macOS 工作机；CI 的 `windows-latest` 只跑 `typecheck` / `cargo test --lib`，不能验证 TUN | **没有证据表明有可用的 Windows 真机**（Win10/11 x64、管理员权限、可反复装卸） |
| 3 | **提权时机** | **已定（2026-11-04 修正）**：应用 per-user 安装、不要求管理员；**首次需要 TUN 时**才提权安装常驻 LocalSystem 服务；拒绝后可重试，不重装 | 不再是阻塞项；剩余是提权安装器与服务实现 |
| 4 | **Wintun / sing-box 许可证复核** | 公开资料结论已写入 §3.1 | 需要法务确认 notices 与分发方式 |
| 5 | **Windows 运行时流水线** | `fetch-runtime.mjs` 只支持 darwin + lipo；manifest 只有 windows x64 条目，没有 arm64 | 需要新增 Windows zip 下载/校验/解压与 `wintun.dll` 校验 |
| 6 | **安装器形态** | 现有 `build-msi.ps1` 出的是 MSI（perMachine，安装即要管理员）；Tauri MSI 没有 perUser 开关，NSIS 默认 `currentUser` | 需要改成 per-user 应用安装器 + **独立的提权服务安装器**；这是落实「安装不要求管理员」的前提 |
| 7 | **Windows 构建先能编译** | `tun::session` 无条件依赖 macOS `xpc`；`veyl-helper` bin 无条件声明 | 先做平台门控，否则 Windows 构建在 TUN 代码上直接失败（静态判断，未实测） |

**最短开工路径：**

1. 确认/采购 Windows 签名证书或 Azure Trusted Signing。
2. 准备一台 Windows 10/11 x64 真机（管理员、可重装）。
3. 法务确认 Wintun/sing-box 分发条款。
4. 定 per-user 应用安装器与提权服务安装器的形态（NSIS currentUser 起步）。
5. 给 TUN 模块补平台门控，保证 Windows 能编译。
6. 再做服务 + IPC + Wintun 的第一条竖切。

> 提权时机已定：安装不要求管理员，首次需要 TUN 时才提权安装服务；拒绝后可重试，不重装。

**在 1、2 未满足之前，写代码也无法验证，不建议开工。**
