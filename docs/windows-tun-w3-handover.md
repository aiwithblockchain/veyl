# Windows TUN · W3 真机交接与验证清单

> 日期：2026-11-05
> 范围：W3 —— `WinPipeBackend`、服务端真正拉起 sing-box、Windows 平台配置差异
> 契约：`docs/contracts/tun-backend.md` **1.0.6**
> 前置：`docs/windows-tun-w0-w2-handover.md`（服务、管道、对端认证）已按那份清单验证过
> 执行者：产品负责人（Windows 10/11 x64 真机）
> 说明：本文所有命令由产品负责人在真机执行；代码作者没有在 Windows 上运行过，**不假设已通过**。

---

## 0. 状态

| 项 | 状态 |
|---|---|
| `WinPipeBackend` | 代码完成；macOS 上以最小 crate 对 `x86_64-pc-windows-msvc` 做过类型检查 |
| 服务端 staging / spawn / stop / 孤儿回收 | 代码完成；未在真机运行 |
| Windows 平台配置（地址 / 排除段 / stack / strict_route） | 完成，见 §2 |
| CI `windows-latest` | **未跑**。跑通前 W3 只算「代码完成」 |
| commit | 无（共享 checkout，由 PM 统一集成） |

W2 的结论继续有效：对端校验只看签名、不看客户端路径；两侧读写都有超时；
客户端在发配置之前先验服务端。本轮没有改动这些规则，只在同一条管道上补齐了
`start` / `stop` / `status` 的真实语义。

> W0–W2 文档 §4.4 说 `tun-valid.json` 会返回 `runtime_missing`——**从 W3 起它会真的启动**。
> 那份文档描述的是当时的阶段，行为以本文为准。

---

## 1. 前置

- 已按 `docs/windows-tun-w0-w2-handover.md` 完成：服务安装、签名（或显式未签名开发开关）、
  管道与对端认证全部通过。
- 运行时已生成：
  ```powershell
  cd "$repo"
  node scripts\runtime\fetch-runtime.mjs --platform=windows
  ```
  应得到 `src-tauri\resources\runtime\sing-box.exe`、`wintun.dll`、`wintun-LICENSE.txt`。
- 管理员 PowerShell 与普通用户 PowerShell 各一个（验证「非管理员也能用」）。

---

## 2. Windows 平台配置差异（本轮决定）

| 项 | 值 | 理由 |
|---|---|---|
| TUN 地址 | `198.18.0.1/15` | Windows 侧不再用 macOS 的 `172.19.0.1/30`；两套地址不能互换。 |
| 排除段 | 固定表去掉覆盖 TUN 地址的段 | `198.18.0.0/15` 原本是 fakeip 排除段，而 TUN 自己也在这段里；留着会把隧道入口绕开。判据是 CIDR 覆盖，不是字面量匹配。 |
| DNS 策略 | `dns.strategy = "ipv4_only"` | TUN 只有 IPv4 地址。`prefer_ipv4` 仍会返回 AAAA，交给应用后要么被 `strict_route` 黑洞、要么绕开隧道。只改 TUN 模式；系统代理模式不受影响。**副作用**：节点域名也只解析 A 记录，IPv6-only 节点会连不上（见 §6）。配方见 `docs/tun-windows-notes.md` §5.1。 |
| `strict_route` | `true` | 用 WFP 挡住 TUN 之外的 DNS/流量泄漏。代价是与其它 VPN / 安全软件可能有冲突，见 §4.4 的共存测试。 |
| `stack` | `gvisor` | 纯用户态实现，不依赖 Windows 系统栈；这是与其它网络软件共存问题最少的选项。 |
| `interface_name` | 不设置 | 交给 Wintun 自己命名，不写死。 |

两处校验保证不会把 TUN 自己排除掉：

1. **生成阶段**（`config/builder.rs`）：排除表里只要有一段覆盖 `198.18.0.1/15`，直接报错，
   不生成配置。
2. **服务端**（`bin/veyl-service/server.rs`）：`prepare_config` 之后重新检查
   `address` 与 `route_exclude_address` 的关系，覆盖就返回 `config_forbidden`。
   服务端不假设调用方一定用了我们的生成器；两个字段的数组形态与单值字符串形态
   都会被归一化，裸 IPv4 按 `/32` 处理。

> macOS 的固定表里 `172.16.0.0/12` 同样覆盖 `172.19.0.1/30`。本轮按决定不改 macOS
> 地址与排除表，这项差异留到 macOS 侧单独评估。

**数据目录的 ACL 由服务自己负责**，不依赖安装脚本：服务启动时（以及每次 `start` 前）
用受保护 DACL（SYSTEM / Administrators 完全控制，不继承父目录）创建
`%ProgramData%\Veyl`、`runtime`、`tun`，`logs` 额外给 Users 只读；
已存在的目录会被逐条枚举 DACL，所有者不是 SYSTEM/Administrators、任何非这两者的
写权限、reparse point 或 NULL DACL 都让服务拒绝启动。W5 的提权安装器复用同一段
（`tun/windows/acl.rs` 的 `ensure_data_layout`）。

---

## 3. 服务端行为（验证时要对照日志）

| 步骤 | 行为 | 日志里应该看到 |
|---|---|---|
| 服务启动 | 先建/校验 `%ProgramData%\Veyl` 的 DACL，再做孤儿回收，最后报 RUNNING | 目录不合规时拒绝启动；SCM 会记录服务启动失败事件，详细原因用管理员 `--console` 复现（失败路径不打开日志文件，避免 logs 被预置软链） |
| `start` | 重验数据目录 → 运行时 staging → 写配置 → `sing-box check` → 确认端口 → spawn → 写 pid 记录 | `sing-box 已启动 pid=… clash=127.0.0.1:…` |
| `status` | 只读内存 + `try_wait`，不哈希、不遍历、不扫进程 | 无日志 |
| `stop` | 终止子进程并等待退出，删除配置与 pid 记录 | `sing-box pid=… 已停止` |
| 服务 STOP | 管道退出后停子进程 | `服务停止` |
| `start` 回复超时 / 客户端断开 | 回滚已 spawn 的进程 | `start 回复未能在期限内送达，回滚已启动的运行时` |
| pid 记录写失败 / 取不到创建时间 | 停掉刚 spawn 的进程并报错，不留无法回收的孤儿 | `写 pid 记录失败：…` 或 `取不到 sing-box pid=… 的启动时间` |

运行时落点：

- 来源：`C:\Program Files\Veyl\runtime\sing-box.exe`、`wintun.dll`（管理员 ACL）。
- staging：`%ProgramData%\Veyl\runtime\<sing-box 的 sha256>\`，两个文件同目录，旧哈希目录会被清理。
- 配置：`%ProgramData%\Veyl\tun\active.json`（含节点凭据，`stop` 与卸载都会删）。
- pid 记录：`%ProgramData%\Veyl\tun\sing-box.pid`（pid / 进程创建时间 / 镜像路径三行）。
- sing-box 日志：`%ProgramData%\Veyl\logs\sing-box.log`（5 MiB 轮转一份）。

---

## 4. 真机验证清单

### 4.1 构建与安装

管理员 PowerShell：

```powershell
cd "$repo\src-tauri"
cargo build --bin veyl-service
powershell -ExecutionPolicy Bypass -File "$repo\scripts\windows\dev-sign.ps1"
powershell -ExecutionPolicy Bypass -File "$repo\scripts\windows\dev-install-service.ps1"
```

**通过标准**：
- `(Get-Acl "$env:ProgramData\Veyl").Owner` 是 `BUILTIN\Administrators` 或
  `NT AUTHORITY\SYSTEM`（所有者隐含 WRITE_DAC，普通用户做所有者就能绕过 DACL）；
- 安装脚本输出 `复制运行时到 C:\Program Files\Veyl\runtime`；
- `Get-ChildItem "C:\Program Files\Veyl\runtime"` 有 `sing-box.exe`、`wintun.dll`；
- `sc.exe query VeylService` 是 `RUNNING`；
- `%ProgramData%\Veyl\logs\service.log` 里没有 `服务无法启动`。

### 4.2 首次 start：staging 与进程

普通用户 PowerShell：

```powershell
& "C:\Program Files\Veyl\veyl-service.exe" --client start "$repo\scripts\windows\samples\tun-direct.json"
echo "exit=$LASTEXITCODE"
```

> `tun-direct.json` 是**不带 `rule_set`** 的冒烟配置，不依赖规则包，可以直接用。
> 带分流的配置会返回 `rule_set_missing`：规则集要等 W5 的安装器投放到
> `%ProgramData%\Veyl\rules\`。也就是说 **W5 之前 Windows TUN 只有
> 「全部走节点」这一种可用配置**，按规则分流尚不可用（fail-closed，不是静默降级）。

**通过标准**：
- 输出 `"ok": true`，`result` 里有 `pid`、`clash_api.addr`（`127.0.0.1:49152–65535`）、`since`；
- `%ProgramData%\Veyl\runtime\<64 位十六进制>\sing-box.exe` 存在，且旁边有 `wintun.dll`；
- `Get-Process sing-box` 的 pid 与回复一致；
- 服务日志有 `sing-box 已启动 pid=…`。

失败时看哪里：
- `runtime_missing`：`C:\Program Files\Veyl\runtime` 缺文件，或文件哈希与构建时不一致
  （重新 `fetch-runtime.mjs` → 重新构建 → 重装）。
- `tun_start_failed` + `配置校验没过`：`sing-box check` 的 stderr，先看配置本身。

### 4.3 TUN 设备与接管

保持上一步的连接，另开普通用户 PowerShell：

```powershell
Get-Process sing-box | Select-Object Id, Path
Get-NetAdapter | Where-Object InterfaceDescription -like "*Wintun*"
Get-NetIPAddress -AddressFamily IPv4 | Where-Object IPAddress -eq "198.18.0.1"
Get-NetRoute -DestinationPrefix "0.0.0.0/0" | Sort-Object RouteMetric | Format-Table -AutoSize
```

**通过标准**：
- 出现 Wintun 适配器（接口名通常是 `sing-box`）；
- 该接口上有 `198.18.0.1/15`；
- 默认路由里 TUN 接口的 metric 最低（`strict_route` 生效时物理网卡的默认路由会被压住）；
- `Resolve-DnsName example.com` 正常返回。

### 4.4 出口 IP 与 DNS（需要真实节点）

上一步用的是 `direct` 出站：**出口 IP 不变是预期结果**，它只证明 TUN 建起来了。
验证「流量真的走了隧道」需要一份带真实节点的配置。不要把节点凭据提交进仓库；
用临时文件，测完删除。

```powershell
# 未连接时
curl.exe -s https://api.ipify.org; echo ""
& "C:\Program Files\Veyl\veyl-service.exe" --client start "$env:TEMP\veyl-node.json"
# 连接后
curl.exe -s https://api.ipify.org; echo ""
Resolve-DnsName example.com | Select-Object -First 3
```

**通过标准**：
- 连接后的出口 IP 与连接前不同，且与节点所在地一致；
- DNS 解析正常，没有超时；
- `Get-NetRoute` 里没有第二条「更具体」的默认路由把流量带回物理网卡。

失败时看哪里：
- 出口 IP 没变：`strict_route` 没生效，或配置里 `route_exclude_address` 覆盖了 TUN 地址
  （服务日志会拒绝这种配置）。
- 出口 IP 变了但网页打不开：MTU / 分片问题，先记录现象，不要自行改 `mtu`。

### 4.4b IPv6 行为（不能静默泄漏）

**先保持连接**（`--client status` 显示 `running: true`）再执行本节。
Windows 的 TUN 只有 IPv4 地址，DNS 策略固定为 `ipv4_only`（§2）。
IPv6 的预期是**明确失败**，不是「悄悄走物理网卡」：

```powershell
Resolve-DnsName example.com -Type AAAA
curl.exe -6 -s -m 10 https://api64.ipify.org
echo "exit=$LASTEXITCODE"
Get-NetRoute -DestinationPrefix "::/0" | Format-Table -AutoSize
```

**通过标准**：
- `Resolve-DnsName -Type AAAA` 返回 `No records found`（或空记录），
  **不是**一个真实的 AAAA 地址；
- `curl -6` 失败（超时 / 无法连接 / 被拒绝），退出码非 0；
- `::/0` 的默认路由要么不存在、要么不指向可用的物理网卡；
- **不允许**出现「AAAA 有地址且 `curl -6` 成功」——那说明 IPv6 绕过了隧道；
  出现即停止验证并回报，附上 `Get-NetRoute -DestinationPrefix "::/0"` 的输出。

### 4.5 替换语义：连两次

```powershell
& "C:\Program Files\Veyl\veyl-service.exe" --client status
& "C:\Program Files\Veyl\veyl-service.exe" --client start "$repo\scripts\windows\samples\tun-direct.json"
& "C:\Program Files\Veyl\veyl-service.exe" --client status
```

**通过标准**：两次 `status` 都是 `running: true`；`pid` 变化；旧的 `sing-box` 进程已退出
（`Get-Process sing-box` 只有一个）。不出现 `already_running` 这类的失败。

### 4.6 App 崩溃 / 重启后接手

1. 保持连接。
2. 停掉发起请求的客户端进程（或直接关掉 App）。
3. 重新执行：
   ```powershell
   & "C:\Program Files\Veyl\veyl-service.exe" --client status
   ```

**通过标准**：`running: true`，`pid`、`clash_api`、`since` 都还在（服务没有被重启）。
这是「删配置守卫」与流量采样的前提。

### 4.7 stop 与残留

```powershell
& "C:\Program Files\Veyl\veyl-service.exe" --client stop
& "C:\Program Files\Veyl\veyl-service.exe" --client stop     # 幂等
Get-Process sing-box -ErrorAction SilentlyContinue
Get-NetAdapter | Where-Object InterfaceDescription -like "*Wintun*"
Test-Path "$env:ProgramData\Veyl\tun\active.json"
Test-Path "$env:ProgramData\Veyl\tun\sing-box.pid"
```

**通过标准**：
- 两次 `stop` 都 `"ok": true`、`"result": null`；
- 没有 `sing-box` 进程；
- Wintun 适配器不再工作（接口消失，或至少没有 `198.18.0.1`）；
- `active.json` 与 `sing-box.pid` 都不存在（配置里有节点凭据）；
- 默认路由回到物理网卡，`curl.exe -s https://api.ipify.org` 恢复原出口。

> Wintun 适配器是否**彻底消失**取决于驱动；`sing-box` 被强制结束时不保证清理。
> 记录实际结果，作为 W5 安装器清理逻辑的输入。

### 4.8 服务崩溃后的孤儿回收

管理员 PowerShell，模拟服务被强杀（不走 STOP）：

```powershell
Stop-Process -Name veyl-service -Force
Get-Process sing-box -ErrorAction SilentlyContinue      # 此刻应当还活着
Test-Path "$env:ProgramData\Veyl\tun\sing-box.pid"      # 记录还在
Start-Service VeylService
Get-Content "$env:ProgramData\Veyl\logs\service.log" -Tail 10
Get-Process sing-box -ErrorAction SilentlyContinue      # 应当已经没了
```

**通过标准**：
- 重启后的日志出现 `收掉上次遗留的 sing-box pid=…`；
- 旧 `sing-box` 被结束；
- 记录里的 pid 被复用到别的进程时，日志是 `记录里的 pid=… 已不是我们起的进程，跳过`，
  且那个进程**没有被杀**。

### 4.9 对端认证回归（W2 不变）

```powershell
# 普通用户
& "$env:TEMP\veyl-unsigned.exe" --client status
echo "exit=$LASTEXITCODE"
```

**通过标准**：退出码 `4`，服务日志 `拒绝客户端：客户端签名校验失败…`。
W3 没有放宽任何准入条件。

### 4.10 超时与回滚（可选，难以稳定复现）

在**首次** `start`（需要复制约 78 MiB 运行时，耗时最明显）时，客户端发出请求后立即被结束：

```powershell
# 普通用户；看到 "Connection established" 之类的中间输出后立即 Ctrl+C
& "C:\Program Files\Veyl\veyl-service.exe" --client start "$env:TEMP\veyl-node.json"
Get-Process sing-box -ErrorAction SilentlyContinue
```

**通过标准**：服务日志出现 `start 回复未能在期限内送达，回滚已启动的运行时`，
且没有残留的 `sing-box`。这条依赖时序，无法稳定触发时以代码路径与日志记录为准，
不要把它当作阻塞项。

### 4.11 卸载清干净

```powershell
powershell -ExecutionPolicy Bypass -File "$repo\scripts\windows\dev-uninstall-service.ps1" -RemoveData
powershell -ExecutionPolicy Bypass -File "$repo\scripts\windows\dev-sign.ps1" -Remove
```

**通过标准**：
- 没有 `VeylService`，没有 `sing-box` 进程，没有 Wintun 适配器；
- `C:\Program Files\Veyl` 与 `%ProgramData%\Veyl` 都不存在；
- 开发证书从三个存储中移除（见 W0–W2 文档 §3.7 的复核命令）。

---

## 5. 失败时看哪里（W3 追加）

| 现象 | 位置 |
|---|---|
| `runtime_missing` | 安装目录 `runtime\` 缺文件；或文件被换过，哈希与编译进服务的不一致 |
| `config_forbidden` + 「覆盖了 TUN 地址」 | 配置的排除表包住了 `198.18.0.1/15`，服务端拒绝 |
| `tun_start_failed` + 「数据目录权限不合规」 | 所有者不是 SYSTEM/Administrators、DACL 允许普通用户写、同名文件、reparse point 或 NULL DACL；服务启动失败时 SCM 只有一条启动失败事件，详细原因用管理员 `--console` 复现 |
| `tun_start_failed` + 「配置校验没过」 | `sing-box check` 的 stderr（已截断、已去掉路径） |
| `tun_start_failed` + 「端口已被占用」 | 49152–65535 的临时端口在 pick 与 spawn 之间被抢走，重试即可 |
| `tun_start_failed` + 「启动运行时失败」 | 看 `%ProgramData%\Veyl\logs\sing-box.log` |
| `helper_missing` 且连接阶段失败 | 管道不存在 / 打不开：服务没运行或 ACL 拒绝；`local_code=helper_missing` |
| `timeout` 且连接阶段失败 | 管道一直被别人占着（单实例），`local_code=timeout` |
| 日志里 `sing-box 已退出，退出码 …` | 子进程自己退了；`sing-box.log` 里是原因 |
| 孤儿没被收掉 | pid 记录被删/截断，或进程启动时间、镜像路径对不上（设计如此，会跳过） |

---

## 6. 本轮未覆盖 / 残余风险

1. **CI `windows-latest` 未跑**：完整 crate 的 Windows 构建仍未在 CI 验证。
2. **真机未执行任何一条命令**：本文所有「通过标准」都还没有实际结果。
3. **规则集未 staging**：服务端只从 `%ProgramData%\Veyl\rules\*.srs` 取；W5 安装器负责投放。
   引用 `rule_set` 的配置在当前开发安装下会返回 `rule_set_missing`。
4. **Wintun 适配器清理**：`stop` 走 `TerminateProcess`，不保证删除适配器；需要在 §4.7 记录实测结果，
   由 W5 卸载器兜底。
5. **临时端口竞态**：pick → check → spawn 之间仍有窗口；已加「spawn 前再确认」，不是原子的。
6. **运行时哈希在每次 `start` 都重算**（约 78 MiB 读盘）：换来的是 staged 文件被换掉时能发现。
   慢盘上的耗时计入 30 秒回复预算。
7. **`strict_route` 与其它 VPN / 安全软件的共存**未验证；冲突时先记录，再决定是否降级。
8. **macOS 的排除表**里 `172.16.0.0/12` 覆盖 TUN 地址，与 Windows 的「不得覆盖」规则不一致；
   本轮按决定不动 macOS，后续单独评估。
9. **`tun::collect()` 在 Windows 上仍返回空**：应用连接后不再空等 1.5 秒，
   `tun_device_up` / `tun_default_route` 以 `null` 标记「未采集」（不再写
   「没看到 TUN 设备」的 warn）。AI 摘要与分流切换按「未采集」处理，不再判为失败；
   分流切换的回复里带 `runtime_state=tun_unknown`。接管是否成立仍用 §4.3 的命令确认；
   适配器枚举（`GetAdaptersAddresses`）与默认路由判定留到后续。
10. **服务安装/查询之外没有 `service_ctl`**：契约 §7 提到的新文件本轮没有新建，
    SCM 查询放在 `tun/windows/scm.rs`；安装仍归 W5。
11. **`ipv4_only` 同时作用于节点域名解析**：配置里节点写的是域名而不是 IP 时，
    只查询 A 记录；IPv6-only 的节点会解析不到并连接失败。这是 TUN 模式的取舍，
    系统代理模式不受影响；遇到 IPv6-only 节点先记录现象，不要自行改回 `prefer_ipv4`。
