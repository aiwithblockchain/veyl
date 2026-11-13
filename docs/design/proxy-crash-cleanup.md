# App 异常退出后自动撤销系统代理

> 日期：2026-11-13
> 状态：设计稿（未实现）
> 依据：用户原话「APP 退出或者异常退出的时候，他修改的 wifi 的 proxies 不能清理掉，这个有方案吗？」
> 范围：**Proxy 模式**（写 Wi-Fi / 以太网服务的系统代理）的异常退出清理；TUN 模式由 helper 的 XPC 租约负责，不在本次范围
> 前置阅读：`src-tauri/src/proxy/mod.rs`、`src-tauri/src/proxy/macos.rs`、`src-tauri/src/lifecycle.rs`、`src-tauri/src/bin/veyl-helper/macos.rs`

---

## 0. 结论摘要

| 问题 | 结论 |
|---|---|
| 崩溃后靠什么 | 一个**用户级 LaunchAgent** 拉起一个很小的 `veyl-proxy-guard` 看门狗；看门狗发现 App 死掉后自己跑 `networksetup` 还原，**不需要重新打开 App** |
| 怎么判断 App 死了 | 不用 pid + 心跳，用 **flock 存活锁**：App 活着就独占锁，进程一死（含 `kill -9`）内核立刻释放，**pid 复用不可能误判** |
| 和现有 `recover_stale()` 的关系 | 看门狗管「崩溃后 2 秒内」；启动恢复管「看门狗没跑 / 关机 / 用户禁用了后台项」。两边读同一份备份、同一套判定，重复执行是幂等的 |
| 用户改过代理怎么办 | 任何自动还原前都先读当前系统代理：**只有当前值仍是我们写进去的端点才动**，否则原样保留并把备份作废 |
| 进程内兜底 | 做 `SIGTERM` / `SIGINT` 的优雅还原（独立线程，不阻塞退出）；**panic hook 里不做**（见 §5） |
| 要不要提示 | 还原成功给一条一次性 toast；还原失败给出「去强制重置」的指引；用户自己改过就静默 |
| 契约 | 新增一条只读命令 `proxy_recovery_report`，`commands.md` 升 **2.21.0**；**不新增事件** |
| 不做 | 不做 root LaunchDaemon / 系统级常驻提权进程；不碰网络服务定义；Windows 留到后续 |

---

## 1. 现状与缺口

已有三块能力，各自解决一段，但中间有洞：

| 现有 | 位置 | 覆盖什么 | 缺什么 |
|---|---|---|---|
| 备份 + 启动恢复 | `ProxyController::recover_stale()`（`proxy/mod.rs:173`） | 下次启动时把上次残留的代理改回去 | **崩溃后到下次启动之间，用户一直断网**；用户如果没有再打开 App，就一直断着 |
| 正常退出撤销 | `perform_shutdown()`（`lifecycle.rs:467`） | 撤代理 → 校验端点 → 失败弹「重试 / 强制退出 / 取消」 | 只在走退出流程时有效；崩溃、`kill -9`、断电、强制退出后 `disable()` 仍失败，都到不了这里 |
| 手动重置 | `network_force_reset`（`commands.md` §7.9） | 用户自己点「强制重置网络」 | 用户得先知道该点，且要能打开 App |

备份本身是完整的：`proxy_backup` 表里有原始 `payload` + 我们写进去的 `endpoint`，`macos.rs` 的 `restore()` 已经能逐服务复现「有地址 / 没地址 / 开启但无地址」三种情况。**缺的不是还原能力，是"有人来按这个按钮"**——App 死了就没人按。

helper 已经证明同构思路可行：App 与特权组件之间用 XPC 连接做**租约**，App 一死连接断开，helper 等 5 秒停隧道（`veyl-helper/macos.rs:52` `LEASE_LOSS_GRACE`）。但 Proxy 模式**不要求用户安装 helper**，不能把这条命脉挂在特权组件上。

---

## 2. 租约：两个文件 + 一把锁

目录沿用 `~/.veyl`（`prepare_app_data_dir` 已把它设成 **0700**）。

| 文件 | 权限 | 谁写 | 生命周期 |
|---|---|---|---|
| `~/.veyl/proxy-lease.json` | **0600**（`fsutil::write_atomic_private`） | App，`enable()` 里、**apply 之前** | 一次连接期内内容不变；正常断开 / 成功还原后删除 |
| `~/.veyl/proxy-lease.lock` | 0600 | 内核（App 只 open + flock） | App 启动时创建并**全程独占**，进程死亡由内核自动释放；文件本身可常驻 |
| `~/.veyl/proxy-recovery-report.json` | 0600 | 看门狗（或 App 启动恢复） | 每次自动还原写一份；App 启动时读一次后删除 |

### 2.1 内容

```json
{
  "schema": 1,
  "lease_id": "6f1c2a3e-…",
  "platform": "macos",
  "endpoint": "127.0.0.1:2080",
  "payload": { "services": [ … ] },
  "owner": { "pid": 40213, "started_at": 1763000000, "exe": "/Applications/Veyl.app/Contents/MacOS/veyl" },
  "created_at": 1763000000123
}
```

- `payload` **逐字复用** `ProxyBackup.payload` 的形状（macOS 是 `MacPayload`，Windows 是 `WinPayload`），`schema` / `platform` 字段与 `ProxyBackup` 同名同义。不另立一套结构，否则两端解析必然漂移。
- `lease_id` 每次 `enable()` 重新生成。看门狗读到它、做完判定、**落笔还原之前再读一次**，值变了就放弃——这是 App 重启与看门狗赛跑时的唯一仲裁。
- `owner.pid` / `owner.started_at` **只用于日志和报告**，不参与「死没死」的判定（见 §2.2）。`started_at` 是**租约写入时刻**，不是进程启动时刻：macOS 上没有稳定且无需额外系统调用的进程启动时刻来源，而这个值本来就只进日志。
- 不放心跳时间。**不做心跳**：心跳永远有「刚过心跳就崩」的陈旧窗口，而 flock 是内核事实。

### 2.2 为什么用 flock 而不是 pid + 心跳

| 方案 | `kill -9` 后 | pid 复用 | 陈旧窗口 |
|---|---|---|---|
| pid + 进程启动时刻比对 | 要等下一个心跳 | 靠启动时刻兜住，但取启动时刻本身有平台差异 | 有心跳间隔 |
| **flock 独占锁（选）** | 内核在进程退出的瞬间释放 | **不存在**：判据是锁不是号 | 无 |

App 在 `enable()` 之前：

```
open(~/.veyl/proxy-lease.lock, O_CREAT|O_RDWR)
flock(LOCK_EX)              // 拿不到 → 看门狗正在收尸，等它
写 proxy-lease.json（原子写 + fsync）
apply(port)
```

看门狗每秒 `flock(LOCK_EX|LOCK_NB)` 试一次：**成功 = 持有者已死**。它拿到锁之后再读 `proxy-lease.json`，此时不可能有并发写者。

### 2.3 与 `proxy_backup` 表的分工（不重复、不冲突）

`proxy_backup`（SQLite）仍是**应用侧的唯一事实源**；租约是它的**写穿副本**，只因为看门狗是一个几 MB 的独立进程，不该为了读一行备份去开 SQLite（schema 耦合、WAL 竞争、依赖膨胀）。

写入顺序固定，任一步崩溃都有兜底：

```
capture() → 写 proxy_backup 表 → flock(proxy-lease.lock) → 写 proxy-lease.json → apply()
```

- 死在「表已写、租约没写」：没有租约，看门狗不动；下次启动 `recover_stale()` 按表恢复（现状能力）。
- 死在「租约写了、apply 没做」：看门狗读到 `current != endpoint` 且 `current` 与 `payload` 的原始值一致 → 判定「本来就没写成」，删租约，并照常写一份 `already_restored` 报告（界面静默）。
- 死在「apply 之后」：这正是要救的情况。

`disable()` 的顺序是 **restore → 校验 → 清表 → 删租约**。删租约放最后：中途死掉时租约还在，看门狗重放一次还原（对同一份原始值重复还原是幂等的）。

---

## 3. 看门狗

### 3.1 方案取舍

| 方案 | 崩溃后多久还原 | 要提权 | 常驻 | 结论 |
|---|---|---|---|---|
| **用户 LaunchAgent + `veyl-proxy-guard` 二进制** | ≤ 2 秒 | 否（`networksetup` 写当前用户的服务本来就不需要 root） | 登录期，无租约时自行退出 | **选它** |
| 复用特权 helper 的 XPC 租约 | ≤ 5 秒 | 要装 helper | 与 TUN 相同 | 否：Proxy 模式不该因为「可能崩溃」就要求用户装系统级组件 |
| 纯 `launchd WatchPaths`（不常驻） | 不触发 | 否 | 否 | 否：崩溃时没有任何文件事件，launchd 不会被叫醒 |
| root LaunchDaemon | 快 | 是 | 是 | 否：为改一个用户代理常驻 root 进程，权限面远大于收益（§7） |

macOS 13+ 会在「登录项 › 允许在后台」里显示这一项，用户可以关掉。接受这个代价：关掉之后仍由启动恢复兜底（§4），只是失去「不用打开 App 就恢复」。

### 3.2 plist 与启动

`~/Library/LaunchAgents/com.veyl.proxyguard.plist`（App 首次启用代理时写入，运行时生成，不随包分发）：

```xml
Label            com.veyl.proxyguard
ProgramArguments [ <App>/Contents/MacOS/veyl-proxy-guard ]
WatchPaths       [ ~/.veyl/proxy-lease.lock, ~/.veyl/proxy-lease.json ]
RunAtLoad        true
KeepAlive        { SuccessfulExit: false }   <!-- 只在异常退出时被重启 -->
ProcessType      Background
ThrottleInterval 1
StandardOutPath  ~/.veyl/logs/proxy-guard.log
StandardErrorPath ~/.veyl/logs/proxy-guard.log
```

- App 在**第一次 `enable()`** 时 `launchctl bootstrap gui/$UID <plist>`（已加载则忽略 `EEXIST`）。
- 每次 `enable()` 再 `launchctl kickstart -k gui/$UID/com.veyl.proxyguard`：不依赖 `WatchPaths` 的触发时机，保证看门狗一定在看。
- 看门狗正常做完事 `exit(0)`；`KeepAlive.SuccessfulExit=false` 保证它不会因为正常退出被反复拉起；下次 `enable()` 由 `kickstart` / `WatchPaths` 再叫醒。
- 二进制随 App 包一起签名发布（`Contents/MacOS/` 下新增一个可执行文件，不是独立安装项）；它复用 App 自己的还原代码，不重复实现 `networksetup` 细节。
- Plist 里的路径取运行时 `std::env::current_exe()` 的同级目录：App 被移动 / 开发构建换路径后，**每次 `enable()` 都重写 plist 并 `bootout` + `bootstrap` 一次**，路径自动跟上；不依赖安装时的绝对路径。

### 3.3 单实例与争用

- 看门狗启动第一件事：`flock(LOCK_EX|LOCK_NB)` 拿 `~/.veyl/proxy-guard.lock`，拿不到直接 `exit(0)`。`WatchPaths` + `kickstart` 同时触发时只会有一个活下来。
- 还原期间它持有 `proxy-lease.lock`，新启动的 App 在 §2.2 那一步会等锁，最多等 3 秒。

### 3.4 看门狗主循环

```
立即检查一次，然后每 1s：
  if 租约存在:
      if flock(proxy-lease.lock, LOCK_EX|LOCK_NB) 失败 → App 还活着，继续
      else:
          lease = 读 proxy-lease.json        // 拿锁后读，内容稳定
          current = 读当前系统代理端点
          if current == lease.endpoint:
              restore(lease.payload); 校验 current 已变
              成功 → status = restored
              失败 → status = failed（保留租约，交给下次启动重试）
          else if current 与 lease.payload 的原始值一致:
              status = already_restored        // 我们已经还原过，或压根没写成功
          else:
              status = left_alone              // 用户自己改过，绝不动
          status ∈ {restored, already_restored, left_alone} → 删租约
          写 proxy-recovery-report.json
          释放锁; exit 0
  else 连续 3 次没租约 → exit 0
```

判定 `current 与 payload 一致` 用 `macos.rs` 已有的 `read()`：把 `payload.services` 的主服务取出来，和当前 `Setting{enabled, server, port}` 比。不做模糊匹配，不比字符串。

**报告文件的写入方**：只有**看门狗与信号清理**写 `proxy-recovery-report.json`。启动恢复（§4.1）**不写**这个文件，结果只在内存里交给界面——启动时 App 已经在跑，写下的文件会活过这次正常退出，下次启动就会拿一条过期报告误弹 toast。`failed` 时保留租约与备份表，交给下一次启动重试。

---

## 4. 与启动恢复 `recover_stale()` 的分工

| 场景 | 谁处理 |
|---|---|
| App 崩溃 / `kill -9`，看门狗在 | 看门狗（≤2s），用户**不用重开 App** |
| 看门狗没跑（用户禁用后台项、plist 丢失、装了个坏包） | 下次启动的 `recover_stale()` |
| 关机 / 重启（看门狗随登录会话一起没了） | 下次启动的 `recover_stale()` |
| 正常退出时还原失败、用户选「强制退出」 | 退出后租约还在 → 看门狗补位；看门狗也不在 → 下次启动 |
| 用户在我们崩溃后自己改过代理 | 两边都只报告，不覆盖 |

### 4.1 顺序与幂等

启动时固定三步，**先租约、后表**：

1. **拿锁**（第一轮 3s；拿不到说明看门狗正在收尸，再等一轮 3s）。看门狗还原要跑约 18 次 `networksetup`，可能超过 3 秒；两轮都拿不到才继续，并在本轮恢复收尾后清掉看门狗迟到的报告，避免它留到下一次正常启动误报。
2. **读 `proxy-recovery-report.json`**（如果存在）：
   - `restored` / `already_restored`：清掉 `proxy_backup` 表（看门狗修好了，表里的旧备份已经没有意义），把报告留在内存给界面；
   - `left_alone`：同样清表（**见 §4.2**），报告留给界面（静默，不提示）；
   - `failed`：不动表，继续走第 3 步；
   - 处理完删除报告文件。
3. **`recover_stale()`**：如果租约文件还在（看门狗没跑），优先用租约里的 `payload` 做同一套判定，成功后删租约；租约不在但表里有备份，走现有逻辑。**启动恢复不写 `proxy-recovery-report.json`**（见 §3.4 末尾），结果直接返回给界面。

实现上这三步收在 `ProxyController::recover_on_startup()` 里（返回报告给界面）；`recover_stale()` 保留为「只看 `proxy_backup` 表」的旧入口，供测试与 `recover_after_crash` 使用。

两边判定的代码**必须同一份**：抽成 `proxy::recovery::decide(current, original, endpoint) -> Restored | AlreadyRestored | LeftAlone`，`recover_stale()` 和看门狗都调它。`original` 是备份载荷里的原始状态在 `current()` 同一口径下的读数，由平台层的 `original_endpoint(payload)` 解析（macOS 是 `macos_wire::original_endpoint`，看门狗与 App 调同一个函数；Windows 各自实现）。`decide` 本身不解析载荷：它要同时服务 macOS 的真实载荷、Windows 载荷和测试里的假载荷，把解析塞进去会让判定依赖某个平台的结构，或复制一份载荷定义。看门狗不复制判定逻辑，只复制「跑 networksetup」这一步。

### 4.2 顺手修一个现有缺陷：`LeftAlone` 之后备份永久滞留

现状（`proxy/mod.rs:185`）：`LeftAlone` 只返回，**不清表**。后果是：崩溃后用户把系统代理改成了自己的值 → 下次启动判定「用户改过」→ 备份一直留着 → 用户下一次连接再断开时，`disable()` 会把**崩溃前那一份旧原始值**写回去，覆盖用户后来设置的值。

修正：`LeftAlone` 时把备份移到 `~/.veyl/proxy-backup-left-alone.json`（留证据、便于排查）后清表。用户的新设置从此是唯一事实，我们不再拥有它。

---

## 5. 进程内兜底

| 入口 | 做不做 | 怎么做 |
|---|---|---|
| 正常退出 / Cmd+Q / 菜单退出 | 已有 | `ExitRequested` → `perform_shutdown()`，不改 |
| `SIGTERM` / `SIGINT` / `SIGHUP` | **做** | 信号处理器只往 self-pipe 写一个字节（async-signal-safe），由启动时拉起的**独立清理线程**执行一次「按 §4.1 同一判定的还原」，硬超时 2 秒后 `_exit(0)`。覆盖 `kill`、开发期重启、部分更新器 |
| panic hook | **不做还原** | panic 时可能持有配置锁、数据库锁；在 hook 里跑 `networksetup`（阻塞 exec）风险大于收益。hook 只记日志、flush；进程随后死亡，看门狗接管 |
| `Drop for ProxyController` | 不做 | 正常路径已经显式 `disable()`；`Drop` 会在「已经还原过」之后再跑一次，制造第二条还原路径。租约 + 看门狗才是唯一兜底 |

清理线程与信号处理器只共享一个 `AtomicBool` + pipe fd，不共享 `ProxyController` 的锁。

---

## 6. 用户可见性

| 结果 | 界面 | 文案 |
|---|---|---|
| `restored`（看门狗或启动恢复修好了） | 主窗口 toast，每次启动最多一次，4 秒 | `上次没退出干净，网络设置已恢复。` |
| `already_restored` | 静默 | — |
| `left_alone`（用户自己改过） | 静默 | — |
| `failed`（还原失败） | 主窗口 toast，错误色，不自动消失 | `网络设置没能自动恢复。打开「设置 → 遇到问题 → 强制重置网络」。` |
| 看门狗根本没跑，用户又没开 App | 无提示（做不到） | — |

- 走现有 `app-toast`（`App.tsx:1520`），不引入系统通知：项目没有 notification 插件，且这条信息只在 App 可见时才有意义。
- 文案不含 `proxy` / `TUN` / `分流` / `规则集`；「网络设置」是用户能懂的说法。
- 恢复失败不自动打开设置页，只给指路：弹窗抢焦点比断网更烦。

---

## 7. 不做什么

1. **不做 root LaunchDaemon，也不为代理常驻任何提权进程。** 系统代理是当前用户的设置，`networksetup` 不需要 root；为它引入系统级常驻进程，权限面和被攻击面都不成比例。
2. **不改网络服务本身的定义**（不增删服务、不改顺序、不动 DHCP/DNS），只改代理四项值，和现有 `apply/restore` 一致。
3. **不在用户改过代理后「帮忙改回去」。** 只读、只报告。
4. **不做心跳、不做 pid 轮询判定**（§2.2）。
5. **不给 Proxy 模式强塞特权 helper。** 想要零延迟兜底可以装 helper，但那是 TUN 的事。
6. **M1 不做 Windows。** Windows 的代理在注册表 `HKCU\...\Internet Settings`，同一套租约文件可用（`LockFileEx` 代替 `flock`），但拉起看门狗要另做登录项，单独立项；本次先把 macOS 做对。
7. **不加密租约。** `payload` 只有服务名、地址、端口、开关，没有凭据；0600 足够。

---

## 8. 契约影响

### 8.1 新增命令（仅 UI）

`commands.md` 升 **2.21.0**，新增 §7.13：

```ts
proxy_recovery_report {} → {
  recovery: {
    status: "restored" | "already_restored" | "left_alone" | "failed";
    endpoint: string;            // 我们写进去的端点
    current: string | null;      // 还原后读到的当前代理（失败时为失败那刻的值）
    error: string | null;        // 仅 failed
    at: number;                  // epoch ms
    source: "watchdog" | "startup" | "signal";
  } | null
}
```

- 只读；返回 Host 启动时读到的**本次启动**恢复结果，`null` 表示这次启动没有任何恢复动作。
- 只由界面在首屏调用一次；不清除、不需要 ack（同一进程内重复调用返回同一个值）。
- 不进 AI 工具（和 `proxy_port_get` 同类，见 `commands.md` §13 的「无 AI 工具的 UI 专用命令」清单）。

### 8.2 不新增事件

恢复发生在 **Host `setup` 阶段，webview 还没注册监听**；此刻发事件必然丢。要做到「事件不丢」得加回放缓冲，只为一个一次性事实不值得。界面用一次性读取即可。

`events.md` **不升版**。

### 8.3 其他

- `tools.md` 不变（AI 不需要知道）。
- `runtime.md` 不变（代理状态不属于运行时快照）。
- `data-model.md` 不变（租约与报告是文件，不进库）。
- `docs/design/my-servers.md` 里计划中的 `commands.md` 版本让位到 **2.22.0**。

---

## 9. 验收（新增 5 条）

见 `docs/testing/e2e-acceptance.md` §7：**E7-05 ~ E7-09**。

| 用例 | 一句话 |
|---|---|
| E7-05 | 代理连接中 `kill -9`，5 秒内 Wi-Fi 代理自动还原，不重开 App |
| E7-06 | 崩溃前用户手动改过代理，看门狗不改写；报告 `left_alone`；下次启动备份被清掉 |
| E7-07 | 正常退出：租约删除、看门狗无动作、无 toast |
| E7-08 | 停掉 LaunchAgent 再崩溃：下次启动由 `recover_stale()` 还原，并弹恢复 toast |
| E7-09 | `kill -TERM`：进程内清理线程还原，退出码 0，租约删除 |

---

## 10. 待核

1. **LaunchAgent 里跑 `networksetup` 的权限**：预期与 App 内一致（同一用户 GUI 会话），需真机验证一次；若被 TCC 拦，退回「看门狗只标记 + 下次启动恢复」。
2. **macOS 13/14/15 的「允许在后台」开关**：用户关闭后如何可靠检测（`launchctl print` 退出码？`SMAppService.status`？），以及设置页是否需要一行「后台清理」状态。M1 先只记日志。
3. **`SMAppService.agent`（macOS 13+）** 是否比手写 plist 更稳：它要求组件在包内且签名注册，换来的是一等公民的后台项管理。M1 用手写 plist，后续可迁。
4. **`veyl-proxy-guard` 的打点**：二进制是同一 crate 的 `[[bin]]`，Tauri 打包默认不把 `[[bin]]` 放进 `Contents/MacOS/`，需要在 `tauri.conf.json` / 构建脚本里显式复制并签名。
5. **Windows 等价物**：`LockFileEx` + `HKCU\...\Run` 或计划任务；单独评估。

---

## 11. 需要改的实现位置（后端）

| 文件 | 改动 |
|---|---|
| `src-tauri/src/proxy/lease.rs`（新） | `ProxyLease` / `RecoveryReport` 结构、原子写、`flock` 封装、报告读写 |
| `src-tauri/src/proxy/recovery.rs`（新） | `decide(current, original, endpoint)` 纯判定，看门狗与启动恢复共用；载荷解析在 `original_endpoint()` |
| `src-tauri/src/proxy/mod.rs` | `enable()` 前写租约 + 拿锁；`disable()` 成功后删租约；`recover_stale()` 接 `decide()`、`LeftAlone` 清表并留证据 |
| `src-tauri/src/proxy/macos_wire.rs`（新，从 `macos.rs` 抽出） | `networksetup` 读写与 `MacPayload`，供 App 与看门狗二进制共用 |
| `src-tauri/src/proxy/macos.rs` | 改为调用 `macos_wire` |
| `src-tauri/src/bin/veyl-proxy-guard/`（新） | 看门狗主循环（§3.4），不依赖 Tauri |
| `src-tauri/src/lifecycle.rs` | 信号处理器 + 清理线程；`force_cleanup()` 后租约保留（交给看门狗） |
| `src-tauri/src/lib.rs` | 启动顺序（§4.1）；安装 / kickstart LaunchAgent；把报告塞进 `AppState` |
| `src-tauri/src/agent/commands.rs` | `proxy_recovery_report` |
| `src-tauri/tauri.conf.json` / 构建脚本 | 打包并签名 `veyl-proxy-guard` |
| 前端（另一批） | `src/agent/tauriBridge.ts` 加命令；`App.tsx` 首屏读一次并按 §6 弹 toast |

---

## 12. 变更记录

- 2026-11-13 初稿：flock 存活锁 + 用户 LaunchAgent 看门狗 + 启动恢复兜底；`LeftAlone` 清表修正；契约新增 `proxy_recovery_report`（`commands.md` 2.21.0）。
- 2026-11-13 实现对齐：`decide` 的实际入参是 `(current, original, endpoint)`，`payload → original` 由平台层 `original_endpoint(payload)` 解析（判定要服务多平台载荷与测试假载荷，不把解析塞进 `decide`）；统一报告写入口径——看门狗与信号清理写 `proxy-recovery-report.json`，启动恢复只在内存返回、不写文件（避免正常退出后残留过期 toast），`already_restored` 也照常写报告但界面静默；启动拿锁 3s 失败后再等一轮，两轮都失败时在恢复收尾后清掉看门狗迟到的报告。
