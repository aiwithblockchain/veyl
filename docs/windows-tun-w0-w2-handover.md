# Windows TUN · W0–W2 真机交接与验证清单

> 日期：2026-11-05
> 范围：W0 平台门控 / W1 服务骨架 + 命名管道 / W2 对端认证
> 契约：`docs/contracts/tun-backend.md` **1.0.2**（2026-11-05 更正：客户端路径不参与准入）
> 执行者：产品负责人（Windows 10/11 x64 真机）
> 说明：本文所有命令由产品负责人在真机执行；代码作者没有在 Windows 上运行过，**不假设已通过**。

---

## 0. 状态

| 项 | 状态 |
|---|---|
| W0 代码 | 完成；macOS 上交叉类型检查通过 |
| W0「已验证」 | **未达成**。必须在 CI `windows-latest` 跑通 `cargo check --target x86_64-pc-windows-msvc` 才算验证 |
| W1 代码 | 完成；未在真机运行 |
| W2 代码 | 完成（按契约 1.0.2：只验签名，不看客户端路径）；未在真机运行 |
| commit | 无（共享 checkout，由 PM 统一集成） |

W0 在本机的交叉检查限制：完整 crate 在 macOS 上交叉检查会停在依赖 `aws-lc-sys`
（需要 MSVC 头文件 `windows.h`），与本轮代码无关。替代证据是最小 crate 引入
真实 Windows 源码对 `x86_64-pc-windows-msvc` 做 `cargo check` / `cargo clippy`。
这只能证明代码可编译，**不能替代 Windows 原生构建与 CI**。

---

## 1. 前置条件

- Windows 10/11 x64。
- 已安装 Rust（MSVC toolchain）与 Visual Studio Build Tools（含 C++ 与 Windows SDK）。
- Node.js（`fetch-runtime.mjs` 需要）。
- 两个 PowerShell：
  - **管理员** PowerShell：签名、安装服务、启动/停止服务；
  - **普通用户** PowerShell：客户端请求（验证「非管理员也能用」）。
- 仓库路径先设一次：
  ```powershell
  $repo = "C:\path\to\veyl"
  ```

---

## 2. W0 · 平台门控与运行时

### 2.1 Windows 原生编译

```powershell
cd "$repo\src-tauri"
rustup target add x86_64-pc-windows-msvc
cargo check --target x86_64-pc-windows-msvc
```

**通过标准**：输出 `Finished`，无 error。

失败时看哪里：
- 第一个 error 在 `aws-lc-sys` / `windows.h`：本机缺少 VS Build Tools 的 C++ 组件或 Windows SDK，补装后重试。
- 第一个 error 在 `src/bin/veyl-helper`：macOS 门控被破坏。Windows 上它应是空壳（`main.rs` 的 `#[cfg(not(target_os = "macos"))]` 分支），不应引用 XPC/Security.framework。
- error 在 `src/tun/windows/*`：本轮代码问题，把完整 error 贴回会话。

### 2.2 运行时与 Wintun

```powershell
cd "$repo"
node scripts\runtime\fetch-runtime.mjs
```

**通过标准**：输出两行 sha256，且存在：
- `src-tauri\resources\runtime\sing-box.exe`
- `src-tauri\resources\runtime\wintun.dll`
- `src-tauri\resources\runtime\wintun-LICENSE.txt`

失败时看哪里：
- `manifest 里没有 windows/x86_64`：`src-tauri/assets/runtime-manifest.json` 缺条目。
- GitHub 下载失败：`api.github.com` / `release-assets.githubusercontent.com` 的可达性。
- `wintun-0.14.1.zip 哈希不符`：上游产物变了，不能继续，需人工核对后更新脚本里的固定哈希。

### 2.3 单元测试（Windows 上真正跑）

```powershell
cd "$repo\src-tauri"
cargo test --lib tun::windows
```

**通过标准**：`ipc` 信封测试与安装目录路径测试全绿。

> W0 的最终验收：CI `windows-latest` 上 `cargo check --target x86_64-pc-windows-msvc`
> 与 `cargo test --lib` 通过。在此之前 W0 只算「代码完成」，不算「已验证」。

---

## 3. W1 · 服务骨架 + 命名管道

### 3.1 构建与准备（两条路，二选一）

对端认证默认要求**可验证的 Authenticode 签名**；未签名一律断开。

#### A. 推荐：自签名开发证书（会真正走 WinVerifyTrust，能验 W2）

先构建，并把一份**未签名**副本留作 W2 反例（必须在签名之前复制）：

```powershell
cd "$repo\src-tauri"
cargo build --bin veyl-service
Copy-Item ".\target\debug\veyl-service.exe" "$env:TEMP\veyl-unsigned.exe" -Force
```

管理员 PowerShell 签名（自签名开发证书，导入本机受信任根）：

```powershell
powershell -ExecutionPolicy Bypass -File "$repo\scripts\windows\dev-sign.ps1"
```

**通过标准**：输出 `已签名：...` 与证书指纹。失败看 `Set-AuthenticodeSignature` 的 `StatusMessage`。
默认签名目标是 `target\debug\veyl-service.exe` 与 `target\debug\veyl.exe`；后者没构建时会跳过并提示，
W3 接 UI 时需要它也被签名。重建二进制后签名失效，重新运行本脚本即可。

#### B. 仅 W1 冒烟：显式未签名开发开关

本机暂时没有签名环境时，可用**编译期**开关跳过验签。它默认关闭、只在 debug 构建生效；
每次接受未签名客户端都会在服务日志里写一行 `对端校验放宽：未签名客户端按 VEYL_WIN_ALLOW_UNSIGNED_DEV 放行`。
发布构建即使设置该变量也不会放行（代码用 `cfg!(debug_assertions)` 双重限制）。

```powershell
cd "$repo\src-tauri"
$env:VEYL_WIN_ALLOW_UNSIGNED_DEV = "1"
cargo build --bin veyl-service
Remove-Item Env:\VEYL_WIN_ALLOW_UNSIGNED_DEV
```

> 这条路径**不验证 W2 的签名准入**。§4.2 必须换回不带该开关的构建（重新 `cargo build --bin veyl-service`）。
> 开关变化会触发重编译；用开关构建的二进制不要用于任何分发。

### 3.2 安装并启动服务

管理员 PowerShell：

```powershell
powershell -ExecutionPolicy Bypass -File "$repo\scripts\windows\dev-install-service.ps1"
sc.exe query VeylService
Get-Content "$env:ProgramData\Veyl\logs\service.log" -Tail 20
```

**通过标准**：
- `sc.exe query` 显示 `STATE : 4 RUNNING`；
- 日志含：
  - `服务镜像 C:\Program Files\Veyl\veyl-service.exe（位于安装目录：True）`
  - `工作目录固定为 C:\Program Files\Veyl`
  - `命名管道已就绪：\\.\pipe\veyl-helper`

失败时看哪里：
- 服务立刻停止：`sc.exe qc VeylService` 看 `BINARY_PATH_NAME`；事件查看器 → Windows 日志 → 系统（来源 `Service Control Manager`）；日志里的 `服务无法启动：...`。
- 日志不存在：`%ProgramData%\Veyl` 未创建或 ACL 不允许 SYSTEM 写（安装脚本负责创建）。

### 3.3 普通用户客户端 ping

**普通用户** PowerShell（不要管理员）：

```powershell
& "C:\Program Files\Veyl\veyl-service.exe" --client ping
& "C:\Program Files\Veyl\veyl-service.exe" --client status
& "C:\Program Files\Veyl\veyl-service.exe" --client stop
```

**通过标准**（三条退出码都是 0）：
- `ping`：`"ok": true`、`"pong": true`、`"protocol": 1`；
- `status`：`running`、`pid`、`clash_api`、`since`、`last_error` **五个键都存在**，值为 `false` / `null`；
- `stop`：`"ok": true`、`"result": null`（不是省略键）。

> `status` 只返回服务内存里的状态（本轮恒为未运行），不做文件哈希、目录遍历或进程扫描
> （契约 §8 第 9 条）。`ping` **只在 debug 构建存在**；release 构建会把 `ping` 当未知方法
> 返回 `bad_request`，探活请用 `--client status`。
> 另外，`--client` 这一组命令行工具**整体只在 debug 构建存在**，release 的
> `veyl-service.exe` 不接受 `--client`。

失败时看哪里：
- `Win32 5`：管道 ACL。确认执行客户端的登录用户就是当前控制台用户；RDP/切换用户不在 DACL 内。
- `Win32 2` / 超时：服务没起，或管道名不一致。
- `读回复失败` + 服务日志「拒绝客户端」：签名没过（见 §4.2），不是网络问题。

### 3.4 抢占测试 A：服务运行中再起一个

管理员 PowerShell：

```powershell
& "C:\Program Files\Veyl\veyl-service.exe" --console
```

**通过标准**：立即失败，退出码 1，提示
`创建命名管道 \\.\pipe\veyl-helper 失败（Win32 5）` 或 `（Win32 231）`。
说明同一时刻只允许一条实例（`nMaxInstances = 1`）；服务端没有降级、没有换名字。

### 3.5 抢占测试 B：服务启动前先占住管道

管理员 PowerShell：

```powershell
Stop-Service VeylService
powershell -ExecutionPolicy Bypass -File "$repo\scripts\windows\dev-squat-pipe.ps1"
```

另开一个管理员 PowerShell：

```powershell
Start-Service VeylService
sc.exe query VeylService
Get-Content "$env:ProgramData\Veyl\logs\service.log" -Tail 10
```

**通过标准**：
- `Start-Service` 失败（或服务立即停止），状态不是 RUNNING；
- 日志含 `同名管道可能已被其他进程占用`；
- 回到占位窗口按 Ctrl+C，再 `Start-Service VeylService` 应成功。

失败时看哪里：如果服务在管道被占时仍然 RUNNING，说明 `FILE_FLAG_FIRST_PIPE_INSTANCE` 没生效或错误被吞掉——这是安全缺陷，停止验证并回报。

### 3.6 停止 / 重启服务

管理员 PowerShell：

```powershell
Stop-Service VeylService
sc.exe query VeylService
Start-Service VeylService
sc.exe query VeylService
```

**通过标准**：两次查询分别是 `STOPPED` 与 `RUNNING`；停止在几秒内完成（控制回调会重复
`CancelIoEx` 打断阻塞的 `ConnectNamedPipe`）。

### 3.7 测试机用完即删（撤销开发证书）

`dev-sign.ps1` 把自签名公钥写进 `LocalMachine\Root`，测试结束后必须清掉。
**先卸载服务，再删证书**（否则服务会拒绝已签名的客户端）：

```powershell
powershell -ExecutionPolicy Bypass -File "$repo\scripts\windows\dev-uninstall-service.ps1" -RemoveData
powershell -ExecutionPolicy Bypass -File "$repo\scripts\windows\dev-sign.ps1" -Remove
```

**通过标准**：
- 脚本输出 `已移除 Cert:\CurrentUser\My\<指纹>`、`...LocalMachine\Root\<指纹>`；
- 复核无输出：
  ```powershell
  Get-ChildItem Cert:\LocalMachine\Root | Where-Object Subject -eq "CN=Veyl Dev Signing"
  Get-ChildItem Cert:\CurrentUser\My   | Where-Object Subject -eq "CN=Veyl Dev Signing"
  ```
- 如果做过 §4.3 的「他签」测试，再用另一个 Subject 清一次：
  ```powershell
  powershell -ExecutionPolicy Bypass -File "$repo\scripts\windows\dev-sign.ps1" `
    -Remove -Subject "CN=Other Vendor"
  ```

---

## 4. W2 · 对端认证

> 契约 1.0.2：**客户端路径只写日志，不参与准入**。信任根是 Authenticode 签名者。
> 下面 4.1 是这一点最容易看错的断言。

### 4.1 客户端放在用户目录也应被接受

普通用户 PowerShell：

```powershell
New-Item -ItemType Directory -Force "$env:TEMP\veyl-copy" | Out-Null
Copy-Item "C:\Program Files\Veyl\veyl-service.exe" "$env:TEMP\veyl-copy\" -Force
& "$env:TEMP\veyl-copy\veyl-service.exe" --client ping
```

**通过标准**：`"ok": true`（退出码 0）。服务日志里 `image=C:\Users\...\Temp\veyl-copy\veyl-service.exe`
只用于诊断，**不是**拒绝理由。

### 4.2 未签名客户端被拒

> 前提：服务是**没有**设置 `VEYL_WIN_ALLOW_UNSIGNED_DEV` 的构建（§3.1 A）。
> 如果用了 §3.1 B 的开关，这里会放行——那正是开关的效果，不能用于 W2 验收。

普通用户 PowerShell（`veyl-unsigned.exe` 是 §3.1 在签名前复制的）：

```powershell
& "$env:TEMP\veyl-unsigned.exe" --client ping
echo "exit=$LASTEXITCODE"
```

**通过标准**：
- 退出码 `4`（读回复失败：服务在验签失败后直接断开，不回错误明细）；
- 服务日志新增一行：
  `拒绝客户端：客户端签名校验失败：C:\Users\...\veyl-unsigned.exe：WinVerifyTrust 返回 0x800b0100`
  （`0x800b0100` = TRUST_E_NOSIGNATURE；若文件被改过则可能是 `0x80096010` = TRUST_E_BAD_DIGEST）。

### 4.3 他签被拒（可选，验证固定指纹）

发布构建必须固定签名者；debug 构建在没有固定指纹时接受任意「可信」签名。
要验证指纹策略，做一次 release 构建：

管理员 PowerShell：

```powershell
cd "$repo\src-tauri"
$devThumb = (Get-ChildItem Cert:\CurrentUser\My -CodeSigningCert |
  Where-Object { $_.Subject -eq "CN=Veyl Dev Signing" } |
  Select-Object -First 1).Thumbprint
$env:VEYL_WIN_CERT_THUMBPRINTS = $devThumb
cargo build --release --bin veyl-service
powershell -ExecutionPolicy Bypass -File "$repo\scripts\windows\dev-sign.ps1" `
  -Path "$repo\src-tauri\target\release\veyl-service.exe"
```

用另一张自签名证书签一份副本（会被导入本机受信任根，因此「可信但不是我们」）：

```powershell
Copy-Item "$repo\src-tauri\target\release\veyl-service.exe" "$env:TEMP\veyl-other.exe" -Force
powershell -ExecutionPolicy Bypass -File "$repo\scripts\windows\dev-sign.ps1" `
  -NewCertificate -Subject "CN=Other Vendor" -Path "$env:TEMP\veyl-other.exe"
```

> `VEYL_WIN_PUBLISHER` 填证书的 **CN 值**（如 `Veyl Dev Signing`）。代码也接受
> `CN=` 前缀，但匹配按 simple display name 精确比较，不做子串匹配。

把发布版装成服务：

```powershell
powershell -ExecutionPolicy Bypass -File "$repo\scripts\windows\dev-install-service.ps1" `
  -Binary "$repo\src-tauri\target\release\veyl-service.exe"
```

**通过标准**：用固定了 `CN=Veyl Dev Signing` 指纹的发布版服务时，
`& "$env:TEMP\veyl-other.exe" --client ping` 退出码 4，日志含 `证书指纹不在允许列表`。

> 验证完把服务换回 debug 版（重新运行不带 `-Binary` 的安装脚本），避免后续步骤看到旧策略。

### 4.4 allowlist 复用（与 macOS 同一份实现）

普通用户 PowerShell，从 `Program Files` 运行客户端：

```powershell
& "C:\Program Files\Veyl\veyl-service.exe" --client start "$repo\scripts\windows\samples\tun-valid.json"
& "C:\Program Files\Veyl\veyl-service.exe" --client start "$repo\scripts\windows\samples\tun-forbidden.json"
```

**通过标准**：
- 合法样例：`"ok": false`、`"code": "runtime_missing"`（本轮不拉 sing-box，明确不假装已连上）；
- 禁止样例：`"ok": false`、`"code": "config_forbidden"`、message 点名 `v2ray_api`。

### 4.5 信封严格性

```powershell
cd "$repo\src-tauri"
cargo test --lib tun::windows::ipc
cargo test --release --lib tun::windows::ipc
```

**通过标准**：多余键、未知 method、`config` 类型错误、超大帧全部被拒；
`stop` 允许缺省 `config`；release 构建里 `ping` 也按未知方法拒绝
（`bad_request`），debug 构建里可用。

### 4.6 客户端验证服务端（防管道抢占）

客户端在写任何数据之前，会先向 SCM 查询 `VeylService` 的状态与 pid，
再与 `GetNamedPipeServerProcessId` 比对；不一致或服务未运行 → 不发送配置，
直接返回 `helper_missing`。

超时按契约 1.0.4 §1.3 的四个最终值：

| 常量 | 值 | 谁等谁 |
|---|---|---|
| `TUN_CONNECT_TIMEOUT` | 5 s | 客户端等连接建立 |
| `TUN_FIRST_FRAME_TIMEOUT` | 5 s | 服务端等首帧 |
| `TUN_REPLY_DEADLINE_CONTROL` | 10 s | 客户端等 `status` / `stop` 回复 |
| `TUN_REPLY_DEADLINE_START` | 30 s | 客户端等 `start` 回复 |

写请求本身 5 s；`start` 慢是正常的（W3 要复制约 78 MB 的运行时），不要用 5 秒判断它失败。

这两个 deadline 都是**整条请求 / 整条回复共享**的：分块读写只等剩余时间，服务端慢速滴字节
不会把总时长拖过上限。服务端首帧超时到期后会每 50 ms 重复取消读线程，覆盖
「读完 header、body 还没开始读」的间隙，最多多等 2 秒。

真实场景测试：

```powershell
# 管理员
Stop-Service VeylService
powershell -ExecutionPolicy Bypass -File "$repo\scripts\windows\dev-squat-pipe.ps1"

# 普通用户（另开窗口）
& "C:\Program Files\Veyl\veyl-service.exe" --client status
echo "exit=$LASTEXITCODE"
```

**通过标准**：
- 客户端**快速**失败（远小于 5 秒），退出码 `4`，错误信息只写
  `服务没有正常启动`（契约 §4.4：`local_code = peer_unverified`，
  UI 理由 `helper_missing`；探测细节只进日志）；
- 服务根本没安装时走 `helper_missing`，信息是 `Veyl 特权服务不可用`；
- 占位进程收不到任何配置字节（它没有实现协议，也不会打印内容）；
- 客户端不会挂住。

然后按 Ctrl+C 结束占位进程，`Start-Service VeylService`，再跑一次 status 应成功。

失败时看哪里：如果客户端连上了占位进程并成功返回，说明 SCM/pid 校验没有生效——停止验证并回报。

---

## 5. 失败时看哪里（速查）

| 现象 | 位置 |
|---|---|
| 服务起不来 / 自动停止 | `sc.exe query VeylService`、`sc.exe qc VeylService`、事件查看器 → 系统（SCM）、`%ProgramData%\Veyl\logs\service.log` |
| 客户端连不上（Win32 5） | 管道 DACL；执行客户端的用户是否当前控制台用户；RDP 会话不在 DACL |
| 客户端连不上（Win32 2 / 231） | 服务没起；或已有实例占满（`nMaxInstances = 1`） |
| 客户端报 `服务没有正常启动` | `local_code=peer_unverified`：连上了但对端不是 SCM 起的服务，或服务不在 RUNNING（可能被抢占） |
| 客户端报 `Veyl 特权服务不可用` | `local_code=helper_missing`：服务未安装，或 SCM/状态查询失败 |
| 客户端报 `没有在期限内回复` | `local_code=timeout`：服务端没有在期限内回包；看服务日志是否卡在某一步 |
| 客户端连上但立刻断开 | 服务日志「拒绝客户端」：签名/会话问题 |
| 服务无日志 | `%ProgramData%\Veyl` 是否存在、ACL 是否允许 SYSTEM 写 |
| 签名不对 | `Get-AuthenticodeSignature <exe>` 看 Status；重建后必须重签 |

客户端退出码：

| 码 | 含义 |
|---|---|
| 0 | 成功（`ok:true`） |
| 2 | 用法错误 / 配置文件读取失败 |
| 3 | 服务回了 `ok:false`（业务错误，如 `config_forbidden`） |
| 4 | 连接失败或读回复失败（含对端被拒） |

WinVerifyTrust 常见返回值：

| 值 | 含义 |
|---|---|
| `0x800b0100` | TRUST_E_NOSIGNATURE：没有签名 |
| `0x800b0109` | CERT_E_UNTRUSTEDROOT：根证书不受信任（自签名证书没导入 LocalMachine\Root） |
| `0x80096010` | TRUST_E_BAD_DIGEST：文件被改动，签名失效 |
| `0x800b0101` | CERT_E_EXPIRED：证书过期 |
| `0x800b010c` | CERT_E_REVOKED / 策略拒绝 |

---

## 6. 本轮未覆盖 / 未验证

1. **CI `windows-latest` 未跑**：W0 在 CI 通过前不算已验证。
2. 真机未执行任何一条命令；本文所有「通过标准」都还没有实际结果。
3. `WinVerifyTrust` 只用自签名开发证书验证；**真实发布证书未验证**（W6）。
4. 服务早于用户登录启动时，管道 ACL 退回 `INTERACTIVE`；多用户 / 快速用户切换未验证。
5. arm64 Windows 无运行时 manifest，`fetch-runtime.mjs` 会明确失败。
6. `start` 只校验并返回 `runtime_missing`；sing-box / Wintun / 孤儿回收是 W3。
7. 安装/卸载是开发脚本，不是 W5 的 per-user 安装器与提权安装器（无 UAC 流程）。
8. `TunBackend` trait 与 App 侧会话层不在本轮；等 `tun/backend.rs` 落地后再接入。
9. 本轮实现把 Windows 通道放在 `tun/windows/`（契约 §7 表格写的是 `tun/pipe.rs`），
   职责相同；客户端与服务端共用同一份源码，服务二进制不链接 Tauri。

## 6.1 残余风险（评审记录，本轮不修）

| # | 项 | 说明 / 后续 |
|---|---|---|
| 1 | 镜像路径与运行映像的 TOCTOU | `QueryFullProcessImageNameW` 拿到路径后、`WinVerifyTrust` 重新打开文件之间，文件内容可能被替换。结果只用于日志，不参与准入；准入的签名由 WinVerifyTrust 对同一路径校验。仍需写进契约作为残余风险。 |
| 2 | `WTD_REVOKE_NONE` | 服务可能离线，验签不做吊销检查。证书被吊销后，在旧有效期路径上仍可能通过；分发侧负责短期证书与撤销策略。 |
| 3 | Wintun / sing-box 许可证 | `fetch-runtime.mjs` 缺少 `LICENSE.txt` 目前只 warn。W5 打包前改为缺失即失败，并纳入打包清单。 |
| 4 | JSON 重复键 | serde 对重复键取后者，不报错。契约 §1.1 未要求拒绝；记为 P3，后续若要严格化在 `parse_request` 里加扫描。 |
| 5 | IU ACL 兜底 | 服务早于登录启动时 DACL 退回 `INTERACTIVE`；运行时再用「客户端会话 == 当前控制台会话」拒绝其它会话。若评审要求 fail-closed，可改为登录前不创建管道。 |
| 6 | 服务端写回复时限 | 契约 §1.3 要求 `start` 在 30 s 内写不完回复时回滚已 spawn 的进程。本轮 `start` 只返回 `runtime_missing`，还没有进程；W3 真正拉起 sing-box 时补这条与对应测试。 |
| 7 | 临时端口抢用窗口 | `ephemeral_clash_port` bind 后立即释放，只用于校验允许的端口范围。W3 拉起 sing-box 前要重新确认端口可用，或让 sing-box 报告实际端口。 |

---

## 7. 代码位置

| 文件 | 职责 |
|---|---|
| `src-tauri/src/tun/windows/mod.rs` | 安装/数据目录、路径归属判断、宽字符工具 |
| `src-tauri/src/tun/windows/ipc.rs` | 信封（只允许 `method` + `config`）、长度前缀帧 |
| `src-tauri/src/tun/windows/pipe.rs` | 管道两端、SDDL、单实例、一次连接一问一答 |
| `src-tauri/src/tun/windows/peer.rs` | PID → 持有句柄 → 镜像路径（仅日志）→ Authenticode |
| `src-tauri/src/tun/windows/log.rs` | `%ProgramData%\Veyl\logs\service.log` |
| `src-tauri/src/bin/veyl-service/` | SCM 服务、控制台模式、命令行客户端 |
| `scripts/windows/` | 开发安装 / 卸载 / 签名 / 抢占测试 / allowlist 样例 |
