# 特权通道安全评审清单（macOS helper / Windows service）

> 日期：2026-11-05
> 性质：**评审清单，不评审具体代码**。Windows 侧代码尚未编写，W-* 条目是设计门槛，
> 落地后逐条打勾；macOS 侧对现有实现可直接执行。
> 依据：[`tun-privilege-implementation-plan.md`](tun-privilege-implementation-plan.md)、
> [`tun-privilege.md`](tun-privilege.md)（macOS 信任模型）、
> [`windows-tun.md`](windows-tun.md)（Windows 设计）、
> [`tun-test-readiness.md`](tun-test-readiness.md)（已知缺口）、
> [`tun-windows-notes.md`](tun-windows-notes.md)（参考实现调研）。
> 与 [`review-checklist.md`](review-checklist.md) B5 的分工：B5 验**用户行为**，
> 本文验**特权边界**；两边都要过。

---

## 0. 怎么用这份清单

- 每条都有：检查项 → **怎么验**（命令或代码位置）→ **通过标准** → 结果。
- 结论填：`通过` / `不通过（阻塞/P1/P2）` / `N/A（附原因）`。
- **不通过即不合入**的条目在编号后标 `【门禁】`。
- 证据要留：命令输出、日志片段、截图。口述「验过了」不算。
- **凭据纪律**：签名命令只用环境变量/钥匙串/云 HSM；不要把证书、私钥、密码或完整签名命令贴进本文件或评审记录。
- 执行人：
  - macOS 段：工程评审可执行（需要签名包的条目要 `/Applications/Veyl.app`）。
  - Windows 段：**真机命令由产品负责人执行**（与 `review-checklist.md` 冒烟清单同一原则），
    工程师只给命令与预期；不远程操作、不假设已通过。
  - 真机已确认可用（Windows 10/11 x64，可反复装卸）；签名证书仍未确认，只影响 W-6 与分发验收。

### 0.1 评审前必须知道的现状

| 事实 | 影响 |
|---|---|
| **M1 运行时哈希**：当前工作树已改为「按复制那一刻的内容哈希命名」（`macos.rs:555-592`），签名不再必然导致 `runtime_missing`；`tun-test-readiness.md` §3.1 描述的是修复前行为 | M-5 记为「待签名包真机确认」；要点从「能否启动」变成「篡改是否被拒、换包是否重新 staging」 |
| **helper 单测不被 CI 执行**：`macos.rs` 的测试属于 `veyl-helper` bin target，CI 只跑 `cargo test --lib`（`.github/workflows/ci.yml:52`） | M-5/M-7 的验法必须显式加 `--bin veyl-helper`；是否把 bin 测试纳入 CI 需要单独决定 |
| GAP-02：helper 的 sing-box 日志无轮转（`macos.rs:223-226`） | M-8 记录为已知缺口，不阻塞 |
| `kill_orphan` 没有单测（`macos.rs` 现有测试只覆盖规则归档、运行时 staging，`:1016-1256`） | M-7 需要新增测试，见条目 |
| Windows 服务/管道代码尚未编写 | W-* 是设计门槛；代码落地后按条目复核 |
| Windows 签名证书未确认 | W-6、C-1 中涉及签名分发的结论暂记为「待证书」 |

---

## 1. macOS（M-1 ~ M-8）

### M-1 【门禁】签名身份、Team ID 与 requirement 同源

**检查项**：App 与 helper 是同一个 Developer ID Team 的签名；编译进 helper 的
`VEYL_TEAM_ID` 与证书的 OU 一致；ad-hoc 签名的包不允许通过。

**怎么验**

```bash
# 1) 本机可用身份
security find-identity -v -p codesigning

# 2) App 与 helper 的签名主体
codesign -dv --verbose=4 /Applications/Veyl.app 2>&1 | grep -E 'Identifier|TeamIdentifier|Authority|flags'
codesign -dv --verbose=4 /Applications/Veyl.app/Contents/MacOS/veyl-helper 2>&1 | grep -E 'Identifier|TeamIdentifier|Authority|flags'

# 3) 深层校验 + Gatekeeper（正式包）
codesign --verify --deep --strict --verbose=2 /Applications/Veyl.app
spctl -a -vv --type exec /Applications/Veyl.app

# 4) 二进制里编进去的两个值（应与上面 TeamIdentifier / bundle id 一致）
strings /Applications/Veyl.app/Contents/MacOS/veyl-helper | grep -xE '2XYK8RBB6M|io.github.aiwithblockchain.veyl'
```

**通过标准**

- Authority 是 `Developer ID Application`（测试包可用 Apple Development，但必须在评审记录里注明，
  且这会影响 requirement 是否匹配），**不能是 ad-hoc**（`Signature=adhoc`）。
- `flags` 含 `runtime`（hardened runtime）。
- 第 4 步两个字符串与证书/bundle id 逐字一致。
- 代码位置：`build.rs:19-27`（Team ID 默认值与环境变量）、`tun/protocol.rs:31-40`
  （requirement 拼装；identifier 由 `build.rs:8-13` 从 `tauri.conf.json` 顶层读取）。
- 已知陷阱：换证书（如 `6A53CAFMZ9`）时必须**构建 helper 时**设 `VEYL_TEAM_ID`，
  签名时再设没用；错了的现象是所有 XPC 连接被拒且编译期无感（`tun-test-readiness.md` §3.2）。

---

### M-2 【门禁】SMAppService 注册状态机与拒绝行为

**检查项**：未注册 → 注册 → 待批准 → 已启用 的迁移正确；拒绝授权时返回 `tun_denied`，
打开「登录项与扩展」，不显示「已连接」，不降级成系统代理。

**怎么验**

```bash
# 干净状态：删掉 App 与注册记录后重装（或新机器）
sudo launchctl bootout system/com.veyl.helper 2>/dev/null || true
# 启动 App → 连接一套 TUN 配置
# 预期：失败、打开系统设置、日志出现 tun_denied
log show --last 2m --predicate 'process == "Veyl"' --style compact | grep -i 'tun\|helper'
```

- 批准后重试：再次连接应成功（当前不会自动重试，需要用户再点一次——见 M-3 的「原地重试」缺口）。
- 代码位置：`tun/privilege/smappservice.rs:35-110`（`ensure_registered`）、`:122-130`（状态映射）、
  `:133-138`（打开登录项）、`:88-110`（`unregister`）。

**通过标准**

- `enabled` 之外的状态全部返回权限类错误，且 `HelperStatus::is_ready()` 只对 `Enabled` 为真
  （`tun/privilege.rs:34-38`）。
- 拒绝后：`scutil --proxy` 保持全 0；`netstat -rn` 无 `0/1`、`128.0/1` 指向 utun；
  界面无「已连接」，无自动重试循环。

---

### M-3 【门禁】XPC 对端验签（先验后读）

**检查项**：监听器与每条连接都在**读取任何消息之前**设置代码签名要求；不使用
「取 pid 再 SecCodeCheckValidity」的两步方案；MachServices 名字与 plist 一致。

**怎么验（代码）**

- `bin/veyl-helper/macos.rs:88-130`：listener 先
  `xpc_connection_set_peer_code_signing_requirement(listener, app_requirement())`，
  失败直接 `exit(4)`；连接处理器里对 connection **再设一次**，失败 `xpc::cancel`。
- 确认没有任何基于 `xpc_connection_get_pid` 的授权判断：
  `grep -rn 'xpc_connection_get_pid\|connection_pid' src-tauri/src/tun src-tauri/src/bin/veyl-helper`
  ——当前只有 `tun/xpc.rs:307` 的一个无调用点封装（可顺手删）；不得出现在任何放行分支里。
- `resources/launchd/com.veyl.helper.plist` 的 `MachServices` = `com.veyl.helper`，与
  `tun/protocol.rs:16` 的 `MACH_SERVICE` 一致；该名字是否需要 Team ID 前缀仍属**未验证项**
  （`tun-test-readiness.md` §3.3），首次「注册成功但连不上」先查这里。

**怎么验（行为，未签名客户端必须被拒）**

```bash
# 临时探针，不入库；以普通用户运行，故意不带 Veyl 签名
cat >/tmp/xpc-probe.c <<'EOF'
#include <xpc/xpc.h>
#include <stdio.h>
#include <stdlib.h>
int main(void) {
  xpc_connection_t c = xpc_connection_create_mach_service("com.veyl.helper", NULL, 0);
  xpc_connection_set_event_handler(c, ^(xpc_object_t e) {});
  xpc_connection_resume(c);
  xpc_object_t m = xpc_dictionary_create(NULL, NULL, 0);
  xpc_dictionary_set_string(m, "method", "status");
  xpc_object_t r = xpc_connection_send_message_with_reply_sync(c, m);
  char *d = xpc_copy_description(r);
  printf("%s\n", d ? d : "(null)");
  free(d); xpc_release(r); xpc_release(m); xpc_release(c);
  return 0;
}
EOF
clang -fblocks -framework Foundation /tmp/xpc-probe.c -o /tmp/xpc-probe
/tmp/xpc-probe
```

- 预期：`/tmp/xpc-probe` 拿到连接无效/中断类错误，**不能**拿到 `{"ok":true,...}`；
  helper 侧日志出现「拒绝连接」。
- 反向验证：把探针放进一个与 Veyl 同签名但 bundle id 不同的 App 里，仍应被拒
  （requirement 同时校验 identifier 与 Team ID）。

**通过标准**：未签名/异签名/异 bundle id 的客户端 100% 被拒；拒绝发生在读取请求之前；
helper 不因非法连接崩溃。

---

### M-4 【门禁】信任根逐级校验（不修、不降级）

**检查项**：`/Library` 到 `/Library/Application Support/Veyl` 及其三个子目录逐级
lstat：真实目录、非软链、uid=0、无 group/other 写位；已有但属主不对时失败退出，不 chown 修复。

**怎么验（静态）**

```bash
stat -f '%Su:%Sg %Sp %N' /Library '/Library/Application Support' '/Library/Application Support/Veyl' \
  '/Library/Application Support/Veyl/runtime' \
  '/Library/Application Support/Veyl/tun' \
  '/Library/Application Support/Veyl/rules' 2>/dev/null
# 代码里不应出现 chown
grep -rn 'chown' src-tauri/src/bin/veyl-helper src-tauri/src/tun || echo '无 chown'
```

**怎么验（动态，篡改一次）**

```bash
# 把信任根改成当前用户所有，模拟「别人抢先建了目录」
sudo chown "$(id -u):$(id -g)" '/Library/Application Support/Veyl'
# 触发一次 TUN 启动（App 里连接，或 sudo launchctl kickstart -k system/com.veyl.helper）
# 预期：helper 退出/拒绝，错误码 tun_start_failed，日志「信任根校验失败」；不会自动 chown 回来
# 复原
sudo chown root:wheel '/Library/Application Support/Veyl'
```

- 代码位置：`tun/trust.rs:77-147`（`verify_chain_from`）、`:148-171`（bundle 只查位置/软链/写位）、
  `bin/veyl-helper/macos.rs:725-752`（`prepare_trust_root`）、`:516-535`（每次 start 重验）。
- 单测：`cargo test --manifest-path src-tauri/Cargo.toml --lib tun::trust`
  （含 symlink、属主、写位、前缀哈希等用例）。

**通过标准**：任一级不合规 → 拒绝启动；没有「自动修好」分支；每次 start 都重验，不是只在 helper 启动时验一次。

---

### M-5 【门禁】运行时 staging 与哈希绑定

**检查项**：helper 只从**自己的签名 bundle**取运行时；staged 到 root 目录后，
目录名 = **复制那一刻的内容哈希**；每次 start 复核 staged 文件；篡改 staged 文件会被拒；
bundle 只在真正需要复制时验签。

**当前状态**：工作树已按 M1 修复（见 `tun-test-readiness.md` §3.1 的「修法 B」）：
`stage_runtime()` 不再拿编译期哈希比对包内文件，而是对读到的字节算哈希并以它命名，
`resolve_runtime()` 每次 start 用 `verify_file` 复核。**待签名包真机确认首连不再报
`runtime_missing`。**

**怎么验（单测）**

```bash
# 注意：helper 是 bin target，--lib 跑不到
cargo test --manifest-path src-tauri/Cargo.toml --bin veyl-helper
# 关注：a_runtime_is_staged_under_the_hash_of_its_own_bytes
#       a_staged_runtime_that_no_longer_matches_its_hash_is_rejected
#       an_existing_staged_runtime_does_not_need_the_bundle_again
```

**怎么验（真机，签名包）**

```bash
# 1) 首次连接成功，staged 运行时出现
ls -l '/Library/Application Support/Veyl/runtime'
# 2) 目录名应等于文件内容的 sha256
DIR="$(ls '/Library/Application Support/Veyl/runtime' | head -1)"
shasum -a 256 "/Library/Application Support/Veyl/runtime/$DIR/sing-box"
# 3) 篡改 staged 文件 → 下一次 start 必须失败（runtime_missing），不能静默跑
sudo sh -c 'printf X >> "/Library/Application Support/Veyl/runtime/'"$DIR"'/sing-box"'
# 4) 删掉该目录 → 重新连接应重新 staging 成功
```

- 代码位置：`bin/veyl-helper/macos.rs:542-553`（`resolve_runtime`）、`:555-592`（`stage_runtime`）、
  `:602-620`（`sha256_hex` / `write_staged_runtime`）、`tun/trust.rs:190-228`（`verify_file`：
  uid、mode、完整 256 位哈希）。
- bundle 只在目标不存在时验：`stage_runtime` 的 `verify_bundle()` 闭包；校验内容包括
  路径在 `/Applications` 之下、非软链、无 group/other 写位、bundle 签名有效
  （`macos.rs:768-795`、`trust::verify_bundle`）。把 App 放到 `~/Downloads` 启动，
  首次 staging 必须拒绝。
- 编译期哈希（`build.rs:34-42`）现在只做「这份构建带没带运行时」的完整性检查，
  不再作为包内文件的信任依据——评审时确认没有第二处拿它比对包内文件。

**通过标准**：staged 文件与目录名一致；篡改即失败；安装包换掉后重新 staging 且不读取旧副本；
包外启动不能复制运行时。

---

### M-6 【门禁】allowlist、请求形状与 root 决定的路径

**检查项**：请求只含 `method` + `config` 内容，没有路径；配置过 allowlist（多余键拒绝，
不是忽略）；`log.output` 被改写、`rule_set.path` 被丢弃；只接受 `type: "tun"`；
Clash API 强制回环；规则集禁止远程引用。

**怎么验**

```bash
# 1) 请求结构（客户端只设 method / config 两个键）
sed -n '167,230p' src-tauri/src/tun/xpc.rs

# 2) 协议实现与错误码
sed -n '48,198p' src-tauri/src/tun/protocol.rs
cargo test --manifest-path src-tauri/Cargo.toml --lib tun::protocol
```

- 静态确认：`prepare_config()` 依次执行 `enforce_allowlist` → `force_log` →
  `reject_remote_rule_sets` → `force_clash_api` → `require_tun_only`（`protocol.rs:164-198`）。
- 确认 `MAX_CONFIG_BYTES = 512 * 1024`（`protocol.rs:19`）。
- 行为（单测覆盖，评审时抽查用例名）：未知键 → `config_forbidden`；超大 → `config_too_large`；
  非 tun 入站 → 拒绝；`log.output` 被覆写；远程 rule_set → 拒绝。

**通过标准**：任何来自 App 的路径/未知键都不能进入 root 的执行路径；两端（未来 Windows）
必须复用同一份 `protocol.rs`，不允许复制实现。

---

### M-7 【门禁】孤儿进程三重核对

**检查项**：helper 崩溃重启后，只杀「pid + 启动时间 + 可执行路径」都对得上的 sing-box；
记录文件缺失/任何一项不匹配 → 不杀。

**怎么验（行为）**

```bash
# 1) 建立连接，确认 sing-box 在跑
pgrep -fl 'sing-box run'
# 2) 强杀 helper（模拟崩溃），sing-box 应继续活着
sudo pkill -9 -x veyl-helper
pgrep -fl 'sing-box run'
# 3) 重新拉起 helper（重启 App 连接，或 sudo launchctl kickstart -k system/com.veyl.helper）
# 4) 预期：旧 sing-box 被收掉，新的一次启动成功；日志「收掉上次遗留的 sing-box pid=…」
```

- 代码位置：`bin/veyl-helper/macos.rs:435-452`（写 pid/启动时间/exe）、`:482-515`（`kill_orphan`）、
  `:455-478`（正常 stop 的 TERM→5s→KILL）。
- **测试缺口**：当前没有 `kill_orphan` 的单测。要求补两条（放在 `macos.rs` 的 `#[cfg(test)]`
  里，用 `cargo test --bin veyl-helper` 执行）：
  1) pid 文件指向另一个存活进程（启动时间/exe 不匹配）→ 不杀；
  2) 三项都匹配 → 杀掉。

**通过标准**：误杀测试不通过即为缺陷；孤儿必须在新的 start 之前被清掉，不能两份 sing-box 并存。

---

### M-8 【门禁】日志边界与卸载入口

**检查项**：helper 的日志只写自己的 root 目录；大小有上限（GAP-02）；
App 内有注销助手的入口（M4），且卸载后无残留。

**怎么验**

```bash
ls -lh "$HOME/.veyl/helper-logs/sing-box.log"
# 启动时按 5 MiB 轮转一份（GAP-02 已修）
```

- 卸载入口（M4 落地后）：在 App 内触发注销 →
  `launchctl print system/com.veyl.helper` 应返回找不到服务；再次连接可重新注册。
- 当前临时清理命令见 `tun-test-readiness.md` §6.2。
- 代码位置：`macos.rs:223-226`（日志路径）、`smappservice.rs:88-110`（`unregister`，
  **当前全仓无调用点**，M4 补 UI）。

**通过标准**：日志不出 root 目录；有上限（轮转或截断）；卸载入口可达，且与 E3 用同一段清理代码。

---

## 2. Windows（W-1 ~ W-8）

> 代码尚未编写。以下条目在 `windows-tun.md` §3.2 / `tun-privilege-implementation-plan.md`
> W1–W5 落地后逐条执行；命令由产品负责人在真机上运行。

### W-1 【门禁】服务账户与二进制位置

**检查项**：`veyl-service.exe` 位于管理员 ACL 的安装目录；服务账户 LocalSystem；
ImagePath 是绝对路径且加引号；启动类型与设计一致。

**怎么验**

```powershell
sc.exe qc veyl-service
sc.exe query veyl-service
sc.exe sdshow veyl-service
icacls 'C:\Program Files\Veyl'
```

**通过标准**

- `BINARY_PATH_NAME` 以 `"C:\Program Files\Veyl\` 开头且带引号；不得指向 `%LOCALAPPDATA%`、
  `%TEMP%`、用户目录或 per-user 安装目录。
- `SERVICE_START_NAME` = `LocalSystem`；`START_TYPE` = AUTO_START（按设计）。
- `C:\Program Files\Veyl`：Administrators/SYSTEM 完全控制，Users 只读/不可写。

---

### W-2 【门禁】命名管道 ACL、抢占与服务端身份

**检查项**：管道带受限 ACL、`FILE_FLAG_FIRST_PIPE_INSTANCE`、`PIPE_REJECT_REMOTE_CLIENTS`；
**客户端也必须验证服务端**——否则普通用户可以先建同名管道冒充 helper，骗走配置（含节点凭据）
并伪造「已连接」。

> 这一条容易被漏掉：`FILE_FLAG_FIRST_PIPE_INSTANCE` 只能让**服务**在名字被占时启动失败，
> 不能阻止攻击者建管道；管道的 ACL 管的是访问，不是命名。客户端侧必须做
> `GetNamedPipeServerProcessId` → 镜像路径在 `Program Files\Veyl\` → `WinVerifyTrust`。

**怎么验（ACL 与服务端）**

```powershell
# 需要 Sysinternals accesschk
accesschk64.exe -q "\pipe\veyl-helper"
# 期望：SYSTEM / Administrators 完全控制；包含「已认证用户」或交互用户的读写；无 Everyone 写、无匿名
```

**怎么验（抢占）**

```powershell
Stop-Service veyl-service
# 普通用户先占住管道名
$p = [System.IO.Pipes.NamedPipeServerStream]::new(
  'veyl-helper','In',1,
  [System.IO.Pipes.PipeTransmissionMode]::Byte,
  [System.IO.Pipes.PipeOptions]::Asynchronous)
Start-Service veyl-service   # 预期：服务启动失败（事件日志 7000/7009），不会成为第二个实例
```

**怎么验（客户端不信任假服务端）**

```powershell
# 保持上面的 $p 占位；启动 App 并尝试连接 TUN
# 在 $p 上读取：不应收到任何配置字节；App 侧应报 helper/permission 类错误，而不是「已连接」
$reader = [System.IO.StreamReader]::new($p)
$reader.ReadLine()   # 期望超时/空，而不是一段 JSON 配置
```

**通过标准**：服务抢不到被占用的名字；客户端连到假服务端时**不发送配置**、不显示已连接；
失败原因可诊断。

---

### W-3 【门禁】客户端身份校验顺序：PID → 镜像路径 → WinVerifyTrust

**检查项**：先验后读；顺序固定；校验失败直接断开，不读取任何请求字节；验证期间保持客户端
进程句柄，避免 PID 复用窗口。

**怎么验（代码评审）**

- 给定实现后逐行确认顺序：
  1. `GetNamedPipeClientProcessId`；
  2. `OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION)`（句柄保持到校验结束）；
  3. `QueryFullProcessImageNameW` → 必须在 `C:\Program Files\Veyl\` 之下；
  4. `WinVerifyTrust`（发布者/证书指纹，符合设计）；
  5. 以上全部通过后，才允许第一次 `ReadFile`。
- 静态检查：任何 `ReadFile`/`Read` 调用都必须在第 5 步之后；拒绝分支不读消息。

**怎么验（行为）**

```powershell
# a) 把签名过的 Veyl.exe 复制到用户目录再启动（签名有效、路径不对）
copy "C:\Program Files\Veyl\Veyl.exe" "$env:TEMP\Veyl.exe"
& "$env:TEMP\Veyl.exe"
# 预期：连管道被拒；服务日志记录「path not allowed」

# b) 用未签名的最小客户端连管道 → 被拒
# c) 正常安装目录的 App → 成功
```

**通过标准**：签名正确但路径不对 → 拒；路径正确但签名不对 → 拒；两者都对 → 通过；
拒绝时不消费请求内容。

---

### W-4 【门禁】DLL 搜索顺序与 wintun 加载

**检查项**：服务进程禁止从当前工作目录/`%PATH%` 搜 DLL；`wintun.dll` 从安装目录或
`%ProgramData%\Veyl\runtime\<sha256>\` 的**绝对路径**加载；服务工作目录是安装目录。

**怎么验**

```powershell
# 1) 服务进程实际加载的 wintun.dll 路径
Get-Process veyl-service | ForEach-Object { $_.Modules | Where-Object ModuleName -eq 'wintun.dll' } |
  Select-Object ModuleName, FileName
# 期望：C:\Program Files\Veyl\... 或 C:\ProgramData\Veyl\runtime\<sha256>\...，绝不是用户目录

# 2) 诱导测试：在用户可写目录放一个假的 wintun.dll
Copy-Item 'C:\Program Files\Veyl\wintun.dll' "$env:TEMP\wintun.dll"
# 从该目录启动服务（或把服务工作目录临时设为该目录）→ 假 DLL 不能被加载

# 3) 静态检查
# - SetDefaultDllDirectories(LOAD_LIBRARY_SEARCH_SYSTEM32|LOAD_LIBRARY_SEARCH_APPLICATION_DIR)
# - LoadLibraryExW 带绝对路径与 LOAD_LIBRARY_SEARCH_* 标志
```

- 反例（不要照抄）：参考项目 openmesh 把内嵌 wintun 解压到 `%LOCALAPPDATA%` 并把目录
  插到 `PATH` 最前，且搜索顺序包含当前工作目录（`tun-windows-notes.md` §5.4）。

**通过标准**：从用户可写目录加载不到任何 DLL；ProcMon 里 wintun.dll 的 LoadImage 路径可解释且固定。

---

### W-5 【门禁】ProgramData ACL 与 staged 运行时

**检查项**：服务只写 `C:\ProgramData\Veyl\`（SYSTEM/Administrators 完全控制，普通用户不可写）；
运行时/规则 staged 到 `programdata\Veyl\runtime\<sha256>\`；每次 start 复验哈希；
服务不读 `%LOCALAPPDATA%` 与 per-user 安装目录。

**怎么验**

```powershell
icacls 'C:\ProgramData\Veyl'
# 普通用户尝试写入 → 预期拒绝
New-Item 'C:\ProgramData\Veyl\runtime\probe.txt' -ItemType File   # 以普通用户执行，应 Access denied
# staged 内容
Get-ChildItem 'C:\ProgramData\Veyl\runtime' -Recurse | Select-Object FullName, Length
# 篡改测试：替换 staged sing-box.exe → 下次 start 必须失败（runtime_missing 类），不能静默跑
```

- 代码评审：所有路径常量的来源；`GetTempPath`/`GetEnvironmentVariable("LOCALAPPDATA")` 在服务
  代码里出现即视为缺陷（诊断日志除外）。

**通过标准**：普通用户不能写 ProgramData 下任何被服务读取的文件；篡改 staged 文件会失败；
服务的工作目录不在用户目录。

---

### W-6 【门禁】提权安装器自身校验与签名

**检查项**：安装器、服务二进制、主程序、安装包都有 Authenticode + 时间戳；
安装器在做任何事之前验证**自身**签名与载荷哈希；只写 Program Files / ProgramData；
不接受用户传入的目标路径；从 App 启动时用受保护路径的绝对路径 `runas`。

**怎么验**

```powershell
signtool verify /pa /v "C:\path\to\VeylSetup.exe"
signtool verify /pa /v "C:\Program Files\Veyl\veyl-service.exe"
signtool verify /pa /v "C:\path\to\Veyl-0.1.0.msi"
Get-AuthenticodeSignature "C:\path\to\VeylSetup.exe" | Format-List Status, SignerCertificate
```

- 篡改测试：改掉包内一个载荷文件 → 安装器必须拒绝（哈希不符）。
- UAC 弹窗显示真实发布者，不是「未知发布者」。
- 证书未就绪时：本条记为「待证书」，W1–W5 的开发与本地装服务不受影响
  （`tun-privilege-implementation-plan.md` §6 风险 5）。

**通过标准**：签名链可验、带时间戳；安装器自身校验失败即退出；不存在「忽略签名失败继续装」的分支。

---

### W-7 服务 DACL 与恢复策略

**检查项**：普通用户不能启停/改配置服务；崩溃恢复策略有限次；服务只被 SCM 启动。

**怎么验**

```powershell
sc.exe sdshow veyl-service
sc.exe qfailure veyl-service
# 普通用户尝试：
sc.exe stop veyl-service     # 预期 Access denied
sc.exe config veyl-service binPath= "C:\Users\me\evil.exe"   # 预期 Access denied
```

**通过标准**：服务 DACL 只给 Administrators/SYSTEM 修改权；恢复策略存在且有限；
没有「用户可直接启动服务」的宽松 ACE（除非设计明确需要）。

---

### W-8 【门禁】卸载残留

**检查项**：停服务 → 删除服务 → 停 sing-box → 删适配器 → 清代理/DNS → 删目录 → 复读校验；
异常退出（先杀进程再卸载）也要能兜底清适配器。

**怎么验**

```powershell
Get-Service veyl-service -ErrorAction SilentlyContinue
sc.exe query veyl-service
Get-NetAdapter | Where-Object InterfaceDescription -match 'Wintun'
route print -4 | Select-String '198\.18|172\.19'
Test-Path 'C:\Program Files\Veyl'
Test-Path 'C:\ProgramData\Veyl'
Get-Process veyl-service,sing-box -ErrorAction SilentlyContinue
Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Services\veyl-service' -ErrorAction SilentlyContinue
```

**通过标准**：以上全部为空/不存在；网络恢复（默认路由、DNS、系统代理）与卸载前一致；
「杀进程 → 卸载」与「正常卸载」结果一致。

---

## 3. 两端共同（C-1 ~ C-4）

### C-1 【门禁】界面进程确实是非特权

**检查项**：UI 进程不是 root/管理员；没有 `requireAdministrator`；没有特权 entitlement；
UI 不直接创建 TUN/改路由。

**macOS**

```bash
ps -o user=,uid=,comm= -p "$(pgrep -x Veyl)"
# 期望 uid = 501 之类的普通用户，不是 0
codesign -d --entitlements :- /Applications/Veyl.app 2>/dev/null
# 期望没有 com.apple.security.network.server 之外的特权相关陌生项；不得有 root 相关 entitlement
```

**Windows**

```powershell
# 1) 进程完整性级别（Sysinternals accesschk）
accesschk64.exe -p (Get-Process Veyl).Id
# 期望 Medium，不是 High/System

# 2) exe 内嵌 manifest 必须是 asInvoker
$bytes = [IO.File]::ReadAllBytes('C:\Program Files\Veyl\Veyl.exe')
[Text.Encoding]::UTF8.GetString($bytes) |
  Select-String -Pattern 'requestedExecutionLevel[^>]*level="([^"]+)"'
# 期望 level="asInvoker"；出现 requireAdministrator 即不通过
```

**通过标准**：两平台 UI 都是普通用户；提权只发生在 helper/service 与一次性的注册动作。

---

### C-2 【门禁】拒绝授权不降级、不假连接

**检查项**：拒绝/取消授权 → TUN 不可用但应用可用；不偷偷设系统代理；不显示已连接；
可原地重试，不需要重装。

**macOS**：拒绝后台助手 → 连 TUN → `tun_denied`；`scutil --proxy` 不变；改连一套
`system_proxy` 配置仍成功。
**Windows**：取消 UAC → `sc query veyl-service` 不存在；TUN 返回权限错误；代理模式正常；
再次点连接重新弹 UAC（不要求重装）。

**通过标准**：三条同时成立：无假连接、无静默降级、可重试。

---

### C-3 【门禁】权限错误与网络错误不混淆

**检查项**：权限类错误码（`tun_denied` / `helper_missing` / `helper_install_failed`）与
运行/网络类错误（`tun_start_failed` 等）在日志、返回值、界面文案上可区分；
权限错误不触发「检查网络/换节点」类建议。

**怎么验**：分别制造两种失败（拒绝授权 vs 节点不可达），对比：

```bash
# macOS 日志
log show --last 5m --predicate 'process == "Veyl"' --style compact | grep -E 'tun_denied|helper_missing|tun_start_failed'
```

界面：权限错误文案指向「授权/安装」，网络错误指向「重试/换节点」；不出现「请检查网络连接」
这类与权限无关的建议。

**通过标准**：错误码、日志、界面三者一致；没有把权限问题包装成网络问题的分支。

---

### C-4 协议同一份实现、两端同一组行为

**检查项**：allowlist、请求形状、错误码只存在于 `tun/protocol.rs` 一份；
Windows 服务链接同一模块，不复制实现；契约测试（计划 0.3）在两种传输上跑同一组用例。

**怎么验**

```bash
rg -n "enforce_allowlist|prepare_config|MAX_CONFIG_BYTES" src-tauri/src
# 期望只有 tun/protocol.rs 定义；Windows 侧引用它，没有第二份
```

**通过标准**：两端对同一请求给出同一结果码；改 allowlist 只改一处。

---

## 4. 已知缺口与阻塞项（评审时先看这里）

| 编号 | 缺口 | 级别 | 关联条目 |
|---|---|---|---|
| M1 | 运行时哈希：工作树已改为按内容哈希 staging（待签名包真机确认） | 待验 | M-5 |
| M4 | App 内没有注销助手入口（`unregister` 无调用点） | P2 | M-8 |
| GAP-02 | helper 的 sing-box 日志无轮转 | P2 | M-8 |
| TEST-1 | `kill_orphan` 无单测；且 helper 的 bin 测试不在 CI 里执行 | P1 | M-5、M-7 |
| WIN-SIGN | Windows 签名证书/Azure Trusted Signing 未确认 | 阻塞分发，不阻塞实现 | W-6 |
| WIN-CODE | Windows 服务/管道代码未编写 | — | W-1~W-8 |

---

## 5. 评审记录

> 每次评审复制一行；证据写路径或命令输出的摘要，不贴凭据。

| 日期 | 条目 | 结论 | 证据 | 评审人 |
|---|---|---|---|---|
| | | | | |
| | | | | |

---

## 附：快速回归命令（不产生副作用）

```bash
# macOS：静态与单测（helper 测试属于 bin target，必须单独跑）
cargo test --manifest-path src-tauri/Cargo.toml --lib tun::
cargo test --manifest-path src-tauri/Cargo.toml --bin veyl-helper
codesign --verify --deep --strict --verbose=2 /Applications/Veyl.app
stat -f '%Su:%Sg %Sp %N' '/Library/Application Support/Veyl'
```

```powershell
# Windows：只读检查（真机，产品负责人执行）
sc.exe qc veyl-service; sc.exe sdshow veyl-service
icacls 'C:\ProgramData\Veyl'; icacls 'C:\Program Files\Veyl'
Get-Process veyl-service | ForEach-Object { $_.Modules | Where-Object ModuleName -eq 'wintun.dll' }
```
