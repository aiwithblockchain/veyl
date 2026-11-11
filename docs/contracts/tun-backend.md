# 契约：TUN 特权后端

> 契约版本：`1.6.0`
> 状态：**已定稿，待实现**（2026-11-05）
> 定位：`TunBackend` 抽象、请求/回复信封、错误码、快照形状、四条不变式。**只定契约，不含实现。**
> 上游：[`../tun-privilege-implementation-plan.md`](../tun-privilege-implementation-plan.md)（双平台计划）、[`../tun-privilege.md`](../tun-privilege.md)（macOS 信任模型）、[`../windows-tun.md`](../windows-tun.md)（Windows 设计）、[`../tun-mode.md`](../tun-mode.md)（连接语义与失败处理）
> 实现方：Rust `src-tauri/src/tun/`（平台无关）+ `MacXpcBackend`（macOS）+ `WinPipeBackend`（Windows）
> 变更记录：见 §10

---

## 0. 适用范围与约束

本文定义的**只有**界面进程与特权进程之间的那一层。以下内容不在本文范围：

- 特权进程怎么安装、怎么注册、怎么被系统拉起（见 `tun-privilege.md` / `windows-tun.md`）；
- sing-box 配置怎么生成（见 `config-execution.md` §7、`tun-mode.md` §2/§3）；
- 界面上怎么展示（见 `tun-mode.md` §8、`center-panel.md` §2.4）。

**一句话**：界面进程永远是普通用户权限；只有独立的后台助手/服务持有特权；两者之间的每一次交互都受本文约束。

---

## 1. 传输层与信封

### 1.1 语义信封（两端一致）

一次交互 = **一次连接 + 一条请求 + 一条回复 + 关闭**。没有长连接、没有请求 ID、没有服务端推送。

请求（逻辑形状，与承载无关）：

```ts
type TunRequest = {
  method: "start" | "stop" | "status" | "restart" | "restore_dns";
  config: string | null;   // UTF-8 的 sing-box 配置文本；仅 method = "start" 时非 null
};
```

回复（逻辑形状，与承载无关）：

```ts
type TunReply =
  | { ok: true;  result: StartReply }        // start 成功
  | { ok: true;  result: null }              // stop / restart 成功
  | { ok: true;  result: TunSnapshot }       // status 成功
  | { ok: false; code: TunErrorCode; message: string; detail?: unknown };
```

约束：

- **信封里除了 `method` 与 `config` 不允许有任何键**，出现即 `bad_request`。多余键就是拒绝，不是忽略。
- `config` 超过 512 KiB → `config_too_large`。上限是契约值（`MAX_CONFIG_BYTES`），两端同一个数。
- `config` 里**不得出现路径**。字段名以 `_path` / `_file` 结尾、或包含 `certificate` 的，一律 `config_forbidden`（§5.1 不变式 1）。
- `message` 是**给用户看的中文**，不含路径、不含凭据、不含内部错误栈。

#### 1.1.1 版本协商：`restart` 就是探针

`restart` 无参数（`config` 必须为 `null`）。helper 先回 `{ ok: true, result: null }`，再以退出码 **75**（`EX_TEMPFAIL`）退出；launchd 按 `KeepAlive` 拉起磁盘上的新映像。用 75 而不是 0：0 是正常退出，launchd 不会重启。

**判断 helper 新旧只看它认不认识 `restart`，不比较版本号：**

| helper 行为 | 含义 |
|---|---|
| `restart` 返回 `{ ok: true }` | 新版，且已触发换映像 |
| `restart` 返回 `bad_request`（未知方法） | **旧 helper**。调用方不重试、不崩溃，转入 `needs_admin_restart` 路径 |
| `restart` 超时（10 s） | 视同旧 helper / 卡死，走同一路径并记日志 |

`helper_build` / `helper_version` 只用于诊断展示，**不得**拿来做版本判断——否则就有了两套协商依据，旧 helper 恰恰不会返回这两个字段。

### 1.2 承载绑定

| | macOS | Windows |
|---|---|---|
| 承载 | XPC Mach service `com.veyl.helper` | 命名管道 `\\.\pipe\veyl-helper` |
| 请求编码 | XPC dictionary：`method`（string）、`config`（data，UTF-8 字节） | 长度前缀帧（u32 小端，不含自身 4 字节）+ 与 §1.1 同构的 JSON 对象 |
| 回复编码 | XPC dictionary：`ok`（bool）、`code` / `message`（string）、`result` 展开为 `pid` / `clash_addr` / `clash_secret` / `since` / `running` / `last_error` / `helper_build` / `helper_version` | 长度前缀帧 + 与 macOS **同名同值**的 JSON 对象 |
| 服务端验客户端 | 连接建立时由 libxpc 完成：`xpc_connection_set_peer_code_signing_requirement`（anchor + bundle id + Team ID） | 连接后、首次 `ReadFile` 之前：`GetNamedPipeClientProcessId` → 持有进程句柄 → `WinVerifyTrust` 校验发布者与证书指纹（**路径只写日志，不参与判定**） |
| 客户端验服务端 | 由 launchd 的 Mach 服务命名空间保证：未注册进程无法在系统命名空间占用该名字，连上的必是已注册 helper（可选 `SecCodeCheckValidity` 作纵深防御） | **连接后、发送任何字节之前**：`OpenSCManager` / `OpenService` → `QueryServiceStatusEx` 取 `dwProcessId` → 与 `GetNamedPipeServerProcessId` 比对；服务未运行或 PID 不一致 → 关闭，**不发送配置** |
| 管道/连接属性 | `MACH_SERVICE` 名字由 App 与 helper 各自常量引用 | `FILE_FLAG_FIRST_PIPE_INSTANCE` + 严格 ACL + `PIPE_REJECT_REMOTE_CLIENTS` |

**两端可以做到内容同形**：同一组 `method`、同一段配置文本、同一组回复键、同一套错误码。差异只在承载与对端校验方式，见 §6。

### 1.3 超时（两端都有，不可省；**最终值，2026-11-05 定稿**）

两侧都**不得**无限阻塞在 `read` 上。macOS 的 libxpc 调用没有内置超时，Windows 的 `ReadFile` 默认也没有——必须在两端自己实现。

| 常量 | 值 | 谁等谁 | 超时后 |
|---|---|---|---|
| `TUN_CONNECT_TIMEOUT` | 5 s | 客户端等连接建立 | 关闭，报本地错误 `timeout` |
| `TUN_FIRST_FRAME_TIMEOUT` | 5 s | **服务端**等首帧 | `DisconnectNamedPipe`，不读后续字节，不产生任何进程或写盘 |
| `TUN_REPLY_DEADLINE_CONTROL` | 10 s | **客户端**等 `status` / `stop` / `restart` 的完整回复 | 关闭，报本地错误 `timeout` |
| `TUN_REPLY_DEADLINE_START` | macOS `90 s`；Windows `30 s` | **客户端**等 `start` 的完整回复 | 关闭，报本地错误 `timeout`；**但必须先核对 `status`**（见下） |

`start` 单独给足时间，不是保守：Windows 首次 `start` 要把 `sing-box.exe`（约 78 MB）与 `wintun.dll` 复制到服务目录，在慢盘、Defender 实时扫描、企业终端的加密盘上都会显著变慢；macOS 首次 `start` 要验整个 `.app` 的签名、读取并哈希随包 `sing-box`（约 173 MB）、必要时写盘再过一次签名校验。2026-11-11 真机实测 macOS 冷启动 `runtime=33018ms`（验签 + 读取 + 哈希 + 写盘）+ `check=3626ms`，30 秒期限必然误报失败。

macOS 的 90 s 是算出来的，不是拍的：33 s（实测最慢 runtime）+ 15 s（`RULES_WAIT_DEADLINE`）+ 25 s（`START_PREPARE_DEADLINE`，含 check）+ IPC 与慢盘余量 ≈ 90 s。改这个值要重新核算这三段。

配套规则：

- **超时后必须核对**：客户端等 `start` 超时后，**不得直接判失败**——先查 `status`（最多 10 秒宽限，每秒一次）：隧道已经在跑就按成功接上（用 status 里的 pid / Clash API / since / DNS 状态），只有确认没起来才报 `timeout`。2026-11-11 真机就是「界面报失败、隧道其实已经起来」：用户看到的结论与事实相反。
- **超时必须可区分**：调用方拿到的是一条明确的 `timeout`，不是「回复解析失败」这种含混结果（§4.4）。
- **服务端超时要回滚**：`start` 若在 `TUN_REPLY_DEADLINE_START` 内没能把回复写完（客户端此时已断开），必须停掉已经 spawn 的进程并记 `last_error`。**不得**留下一个客户端不知道存在的 TUN。
- **超时不重试**：超时后不自动重发。重试由用户点「重试」触发，避免在服务卡死时反复 spawn。
- 这些值都是契约常量，**除 `TUN_REPLY_DEADLINE_START` 外两端同一个数**（macOS 90 s / Windows 30 s，Windows 侧另行评估），测试按这组值写。改值只改常量，不改变上面几条规则。

---

## 2. `TunBackend` trait

```rust
// src-tauri/src/tun/backend.rs —— 平台无关，不含任何平台 API
pub trait TunBackend: Send + Sync {
    /// 查特权组件的注册状态。纯查询，不触发任何系统弹窗。
    fn availability(&self) -> Result<HelperStatus, TunError>;

    /// 确保可用：必要时触发一次系统授权流程。**幂等**。
    fn ensure_available(&self) -> Result<HelperStatus, TunError>;

    /// 起 TUN。**替换语义**：已有实例先停再起，不返回「已在运行」。
    fn start(&self, config: &str) -> Result<StartReply, TunError>;

    /// 停 TUN。**幂等**：没在运行也返回成功。
    fn stop(&self) -> Result<(), TunError>;

    /// 读快照。随时可调，不改变状态。
    fn status(&self) -> Result<TunSnapshot, TunError>;

    /// 让特权组件换新映像：helper 回 ok 后以 exit(75) 退出，由 launchd 拉起。
    /// 旧 helper 不认识这个方法，返回 `bad_request` —— 这就是版本协商（§1.1.1）。
    fn restart(&self) -> Result<(), TunError>;
}
```

语义细节，逐条可测：

| 方法 | 规则 |
|---|---|
| `availability` | 不弹窗、不写盘、不启动进程。macOS 对应 `SMAppService.status()`；Windows 对应 `QueryServiceStatusEx` + `OpenSCManager`。 |
| `ensure_available` | 已 `Enabled` 时直接返回，不重复触发。用户拒绝 → `tun_denied`；注册/安装失败 → `helper_missing`。**允许反复调用**：`tun-mode.md` §8 要求「下次连接再次请求授权」。 |
| `start` | 先校验对端与配置（§5），再停旧实例、起新实例，**spawn 成功即返回**——不代表隧道已就绪（就绪由调用方探测出口 IP / 默认路由判定）。绝不因「已在运行」失败。 |
| `stop` | 现有实例存在则终止并等其退出；不存在也返回 `Ok`。不返回 `not_running`。 |
| `status` | 不依赖调用方缓存。App 崩溃重启后第一次 `status` 必须能拿回 `pid` 与 `clash_api`（§3.2）。 |
| `restart` | 无参。回 `{ ok: true }` 后 helper 自行 `exit(75)`，launchd 拉起新映像。**旧 helper 返回 `bad_request`**，调用方据此判定版本并转 `needs_admin_restart`，不重试、不比较版本号。重启会中断当前 TUN——调用前必须先 `stop`。 |
| `restore_dns` | 无参。还原连接期被改写的系统 DNS（§5.2.2）。幂等；没有原始快照时只清理**整组恰好等于旧隧道对端**（`172.19.0.2`）的残留；**不碰 `223.5.5.5`**，也不动用户自己的 DNS。**旧 helper 返回 `bad_request`**，调用方只记日志、不因此让重置失败。 |

### 2.1 给将来接入留的口子（I2）

本轮 TUN **不并入** `RuntimeManager`：生命周期仍由 `TunSession` 管，不设看门狗，采样只复用 `runtime::health::ClashApi`（实施计划 §1.2、`tun-privilege.md` §8）。实施计划里的 I2（TUN 接入 `RuntimeManager` 统一健康检查与热切）**保留**，所以 trait 的形状不能把那条路堵死：

- `trait` 是 **object-safe** 的（全部方法 `&self`、无泛型、无关联类型），将来可以 `Arc<dyn TunBackend>` 交给 `RuntimeManager`。
- `start` / `stop` 是**唯一的状态改变入口**；看门狗将来只需要 `status` + `start`，不需要新方法。
- `status` 必须**便宜且可高频调用**（一次 IPC，不读大文件、不 spawn 进程），将来放进 2s 健康循环时不用改契约。

不满足这三条就意味着将来接入要改 trait，等于让两个工作流返工。

**「便宜」怎么算达标**（可审查，不是形容词）：`status` 的实现里**不得**出现文件哈希校验、目录遍历、`tasklist` / `pgrep` 一类的进程扫描，也**不得** spawn 任何进程；只读特权侧自己内存里的子进程状态。这是 §8 第 9 条的验收项。

**`HelperStatus` 复用现有 5 态枚举**（`src-tauri/src/tun/privilege.rs`），不新造：

| 值 | macOS | Windows |
|---|---|---|
| `not_registered` | plist 未注册 | 服务不存在，或存在但被禁用 |
| `requires_approval` | 已注册、用户在「登录项与扩展」里还没批 | **不会出现**（UAC 拒绝 = 服务没装上 = `not_registered`） |
| `enabled` | 已批准并运行 | 服务存在且正在运行 |
| `not_found` | bundle 里没有 plist，或 App 不在 `/Applications` | 注册项在但 `binPath` 不可执行 |
| `unsupported` | 非 macOS | 非 Windows |

---

## 3. 数据结构

### 3.1 `StartReply`

```ts
type StartReply = {
  pid: number;                     // sing-box 子进程 pid
  clash_api: { addr: string; secret: string };  // addr = "127.0.0.1:<port>"
  since: string;                   // ISO 8601 UTC，进程启动时刻
};
```

- `clash_api.addr` **必须**是回环地址，端口范围 49152–65535（`runtime.md` §5.1 同一条规则）。
- `secret` 是本次进程生命周期内有效的随机串；**不得**写进日志、不得出现在错误 `message` 里。
- `since` 由特权侧生成，不是调用方时间。
- `dns_hijack`（1.3.0）：连接期系统 DNS 是否已指向隧道。**失败不影响 start 成功**——DNS 是优化项，隧道才是产品；失败时 `applied = false`，`reason` 说明原因，连接照常可用。

### 3.2 `TunSnapshot`

```ts
type TunSnapshot = {
  running: boolean;
  pid: number | null;              // running = false 时为 null
  clash_api: { addr: string; secret: string } | null;  // running = false 时为 null
  since: string | null;            // running = false 时为 null
  dns_hijack: { applied: boolean; reason: string | null };  // 未连接时 applied=false、reason=null
  last_error: { code: TunErrorCode; message: string; at: string } | null;
  helper_build: string | null;     // 特权组件构建标识，诊断用
  helper_version: string | null;   // 特权组件版本，诊断用
};
```

- **字段恒存在**，无值写 `null`，**不得省略键**——省略键会让 TS 消费方拿到 `undefined`，绕过类型检查静默失败（与 `runtime.md` §2.5 同一条规则）。
- `helper_build` / `helper_version` 由特权侧从自身编译期常量写入。**旧 helper 不会返回这两个键**，客户端按 `null` 解析，不得因此报错。
- 两者**只用于诊断展示**：版本协商以 `restart` 是否返回 `bad_request` 为准（§1.1.1），不要用这两个字段做新旧判断。
- `last_error` 只在「最近一次 start 失败且此后没有成功 start」时非 null；成功 start 后清空。
- `status` 在未运行时**不是错误**：返回 `running: false` 与 `pid: null`。
- App 崩溃重启后，`status` 必须仍能返回 `pid` 与 `clash_api`——这是 TUN 的流量/延迟采样与「删配置守卫」的前提（`review-checklist` GAP-03 的根因之一）。
- `dns_hijack` 随 `status` 一起返回：helper 重启后界面仍要能说清这次连接有没有接管 DNS。未运行时为 `{ applied: false, reason: null }`，不要拿它推断别的。

### 3.3 `TunError`

```ts
type TunError = {
  code: TunErrorCode;
  message: string;      // 给用户看的中文
  detail?: unknown;     // 结构化诊断，不含路径与凭据
};
```

---

## 4. 错误码

### 4.1 两层，别混用

错误码分**两层**，这是本文与实施计划 `§1.1` 最不一样的地方：

- **wire 码**：特权侧 → 界面进程。精细，用于诊断与日志。
- **UI 理由**：界面进程 → 前端（`AivpnError.details.reason`）。只有四种，与 `tun-mode.md` §8 的「起不来的原因只有一类（权限）」对齐。

前端**目前没有任何按码分支的逻辑**（全仓只有四处读 `details.reason`，分布在 `App.tsx`、`useVpnSession.ts`、`Settings.tsx`，都与 TUN 无关）。用户看到的是 `AivpnError.message`。因此：

> **界面进程必须负责翻译**：把 wire 码翻成用户能读的中文 `message`，并写 `details.reason`。不能把 `config_invalid` 直接甩给 UI。

### 4.2 wire 码（特权侧返回）

| 码 | 何时 | 现有实现 |
|---|---|---|
| `bad_request` | 缺 `method` / 未知 `method` / 信封有多余键 / `config` 不是 UTF-8 | ✅ 已有 |
| `config_too_large` | 配置 > 512 KiB | ✅ 已有 |
| `config_invalid` | 不是合法 JSON、顶层不是对象、某段结构类型不对 | ✅ 已有 |
| `config_forbidden` | allowlist 外的键、不支持的 outbound/dns 类型、非 `tun` 入站、远程 rule_set | ✅ 已有 |
| `rule_set_missing` | 配置引用了本地没有的 rule_set tag | ✅ 已有 |
| `runtime_missing` | 本构建没有随包运行时（哈希为空），或运行时校验不过 | ✅ 已有 |
| `tun_start_failed` | 进程起不来、立即退出、端口不可用、写盘失败 | ✅ 已有 |
| `internal` | 其余未分类错误。**不得**用来掩盖上面任何一类 | ⬜ 新增 |

**明确不存在 `already_running` 与 `not_running`**（实施计划里列了这两个，与实现不符）：

- `start` 是**替换语义**：helper 在 spawn 前会先停旧实例（`veyl-helper/macos.rs:364`）。返回 `already_running` 会让「换配置/换节点后重连」变成一次失败。
- `stop` 是**幂等**的（`veyl-helper/macos.rs:455-473`：取不到 child 就什么都不做）。返回 `not_running` 只会让调用方多写一个无意义的分支。

> **`restart` 在旧 helper 上返回 `bad_request` 不是故障。** 那是版本协商的正常结果（§1.1.1）：调用方把它翻译成「需要管理员重启」，而不是 `INTERNAL`。新增 `restart` 不新增 wire 错误码。

### 4.3 UI 理由（界面进程翻译后）

| `details.reason` | 由哪些 wire 码 / 情况映射 | 界面行为（`tun-mode.md` §8） |
|---|---|---|
| `tun_denied` | `ensure_available` 时用户拒绝（不在 wire 层产生）；或 `HelperStatus::requires_approval`——已注册、用户还没在「登录项与扩展」里批准（macOS 的中间态）。两者同一理由，**文案必须不同**：前者是「你拒绝了」，后者是「需要你允许后台助手」 | 说清原因，下次连接再次请求；卡片只有「重试」 |
| `helper_missing` | `ensure_available` 注册/安装失败（不在 wire 层产生）；本地码 `peer_unverified` 与本地码 `helper_missing`（服务在两查之间消失，§4.4）也归到这里 | 文案说清是安装问题、不是网络问题 |
| `tun_start_failed` | `bad_request` / `config_*` / `rule_set_missing` / `runtime_missing` / `tun_start_failed` / `internal` | 显示具体原因 + 重试 |
| `unsupported_platform` | `availability` = `unsupported` | 明确说这个平台还不行，不说网络故障 |

**`details.wire_code` 必须原样带上 wire 码**，用于日志与问题上报；UI 不展示它。

### 4.4 本地错误（不跨线）

还有四类错误是**界面进程自己产生的**，不从特权侧返回，因此不是 wire 码。它们放在 `details.local_code`，**不得**混进 `details.wire_code`：

| `local_code` | 何时 | 映射到 UI 理由 |
|---|---|---|
| `timeout` | §1.3 的任一超时到点 | `tun_start_failed` |
| `peer_unverified` | 连上之后发现对端不是我们的服务：Windows 的 PID 与 SCM 不一致，或服务根本没在运行 | `helper_missing` |
| `helper_missing` | **竞态**：`availability` 判定就绪之后、真正 `call` 之前，服务被卸载或停止。Windows 的 `IpcError::HelperMissing` 正是这个场景。**不是** `transport_error`——连接从未建立，谈不上中断 | `helper_missing` |
| `transport_error` | 管道断开、帧长度非法、XPC 中断、回复解析失败 | `tun_start_failed` |

`peer_unverified` 的 `message` 只说「服务没有正常启动」，**不说**发现了一个可疑进程——详细原因进日志，避免把探测结果回显给可能已经占了管道的进程。

`local_code` 与 UI 理由**同名不算冲突**：`helper_missing` 在两层都出现，但落在不同键上（`details.local_code` vs `details.reason`）。读的人只需记住：`local_code` 说的是「哪一步失败的」，`reason` 说的是「界面该显示哪一类」。

**绝不降级成系统代理**：以上任何一条都不允许调用 `proxy.enable()`（`tun-mode.md` §8）。这条是 B5-04 的验收点。

---

## 5. 四条不变式

前三条由**特权侧**强制执行，调用方违约不能让特权侧降级或猜测；第四条**两侧各自执行**——客户端不验服务端，前面三条再严，配置也可能被冒充的服务整段收走。

### 5.1 不变式 1：请求里没有路径

配置文本里不允许出现任何文件路径。按键名判定：以 `_path` / `_file` 结尾、或包含 `certificate` 的键直接拒绝（`config_forbidden`）。

被**覆盖**而不是采信的两处：

| 键 | 处理 |
|---|---|
| `log.output` | 删除。日志路径由特权侧决定 |
| `route.rule_set[].path` | 覆盖。按 `tag` 从特权侧自己的目录取，取不到 → `rule_set_missing` |

### 5.2 不变式 2：配置走 allowlist

只放行生成器真的会产出的字段；**多余键拒绝，不是忽略**——忽略等于让它静静地影响特权进程的行为。

allowlist 以 `src-tauri/src/tun/protocol.rs` 的常量为唯一来源，两端共用同一份实现（`protocol::prepare_config` 平台无关）。`INBOUND_KEYS` 已包含 `stack` / `mtu` / `strict_route` / `interface_name`；将来若新增键，**必须同时加到 allowlist 并在本文登记**，不允许某个平台另抄一份。

#### 5.2.1 `stack` / `mtu` / `dns_mode` 必须显式写（1.1.0 / 1.2.0）

| 字段 | 值 | 不写会怎样 |
|---|---|---|
| `stack` | `gvisor`（两个平台相同） | sing-box 1.14 在 Darwin 上（`WithGVisor && !GSO`）默认落到 `mixed`：UDP 走 gvisor、TCP 走**系统栈的内核 NAT**。2026-11-09 实测：mixed 的 TCP 握手永远不完成——SYN 进了 utun4 没有 SYN-ACK，sing-box 侧零 `inbound connection`，用户侧就是「已连接但网页打不开」 |
| `mtu` | `9000` | Darwin 在非 Network Extension 模式下默认 65535（`protocol/tun/inbound.go`），MSS 变成 65495；64KB 段在真实 1500 路径上只能靠分片兜底，UDP 大包容易被中间设备丢掉 |
| `dns_mode` | `hijack` | 没有它，进入 TUN 的 DNS 要在嗅探之后才可能命中 `hijack-dns`；显式 hijack 让判定发生在连接建立之前（`JudgeFlow`），不依赖嗅探能不能识别出 DNS |

两个字段都必须出现在生成的配置里，不能依赖 sing-box 的平台默认值——默认值是随版本和运行形态变的，不是契约。

#### 5.2.2 连接期系统 DNS（1.2.0）

**连接期间，helper 必须把当前网络服务的系统解析器指向公网 DNS `223.5.5.5`**，断开时原样还原。

为什么必须做：

- `hijack-dns` 只能截住**进入 TUN** 的查询。macOS 默认用当前服务的 DNS（家庭网络就是路由器），查询从 en0 直接出去，永远不经过 TUN——`routing.md` 里「境外域名走 DoH over proxy」那套规则在运行时是死代码。
- 后果不是「解析失败」而是「解析到污染 IP」：境外域名被运营商 DNS 返回劣质/污染地址，代理再逐字拿这些 IP 去连。1.14 的 `sniff` action **没有** `override_destination`（`sing-box check` 会报 unknown field），嗅到的域名只参与路由匹配，不改变拨号目标。实测 Facebook / TikTok 慢即由此而来。

为什么是「排除表之外、且本身可用」的公网地址，而不是 TUN 对端（1.5.0）：

- 2026-11-11 真机：`172.16.0.0/12` 在 `FIXED_EXCLUDES` 里（`tun/mod.rs`），TUN 对端 `172.19.0.2` 正在其中。发往对端的查询命中排除路由、从物理网卡出去后黑洞：`scutil --dns` 显示 `nameserver[0] = 172.19.0.2`、helper 日志 `dns=165ms` 无 warn，但 sing-box 侧 `inbound DNS packet` **0 条**，用户侧国内外全部 `Resolving timed out`，停掉 VPN 立刻恢复。
- 公网地址不在排除表里，`auto_route` 会把它收进隧道，`dns_mode: "hijack"` 在 `JudgeFlow` 阶段直接回答，不依赖嗅探。
- 附带两个好处：国内用户路由器 DNS 是私网地址、本来就被排除表放过的情形一并解决；隧道失效时查询直接走物理网卡到 `223.5.5.5`，机器仍有解析，不会因 VPN 故障断网。
- 选 `223.5.5.5`（阿里）而不是 `1.1.1.1` / `8.8.8.8`：用户主体在中国大陆，后两者常被阻断或污染；这个地址同时承担兜底 DNS 的角色。**标准是「目标用户所在网络能解析」，不是「国际公认」。**

为什么不能用 `172.19.0.1`：它是 utun 自己的地址，内核当成本机地址走 lo0，包根本不会进 TUN。

**不成环依赖（1.5.1）**：sing-box 自己的上游 DNS 也可能配的是 `223.5.5.5`。它不会成环的前提是 `route.auto_detect_interface = true`——出站被绑在物理网卡上，发往 `223.5.5.5` 的上游查询不会再回到 utun。**不要删这个字段**；删了之后上游查询命中 TUN 的 `hijack-dns`，解析会自己咬自己。

实现约束：

- 用 per-service 的 `State:/Network/Service/<uuid>/DNS`（scutil），**不要**用 `networksetup`：服务名随系统语言变，UUID 不会。
- **`scutil` 用 `show`，不能用 `get`。** `get` 只把值读进会话里的 `d` 字典、不打印任何输出；用它解析永远是空，表现为「读不到当前网络服务」。2026-11-09 就是这么把连接整个弄挂的——别改回去。
- **失败不阻断连接（fail-open）**：DNS 是优化项，隧道才是产品。设置失败时先重试一次（服务刚起来时可能读不到），仍失败就照常返回成功，回 `dns_hijack.applied = false` + `reason`，日志打 WARN。
- **降级必须可见**：App 的状态快照带 `system_dns: "tunnel" | "unchanged"`，界面常驻一行说明「DNS 未接管：国外网站可能较慢」。**不允许**静默降级——那正是「连上了但国外网站慢」的原始症状。
- **幂等**：原始值只在**第一次**改写前记录；重复 `start` 不能把「我们设的值」记成原始值，否则再也恢复不回去。上一次连接崩溃遗留的**旧对端 `172.19.0.2`** 同样不算原始值——**只要它出现在当前列表里就摘掉**（激活时我们还没接管，此刻出现的它一定是旧版本残留），摘完为空则按「本来没有自定义 DNS」处理；但 `223.5.5.5` 是用户可能自己设的可用 DNS，**不**按残留处理，照常记为原始值，断开时写回。
- **恢复原样**：用户本来有自定义 DNS 就写回他的值。**原本没有服务级 DNS 时绝不能删键**——2026-11-11 真机验证：`remove State:/Network/Service/<uuid>/DNS` **不会**回落到 DHCP，`scutil --dns` 会变成「没有 nameserver、Not Reachable」，只能关开 Wi-Fi 才恢复。此时要写回一组可用地址：优先激活时记下的全局 DNS（`State:/Network/Global/DNS`），没有则写兜底 DNS `223.5.5.5` / `119.29.29.29`（阿里 / 腾讯）并在日志 WARN。写回的前提见 §5.2.3。
- 覆盖四条路径：正常 `stop`、子进程退出、helper 重启（进程 `atexit`）、强制重置网络（`restore_dns` 兜底）。
- 设置后**回读服务级 DNS 键**校验：键里含我们写入的 `223.5.5.5` 即算成功；`scutil --dns` 的 `resolver #1` 会被系统重排，只作诊断日志。不生效就恢复原状并报 `applied = false`（连接继续）。
- 恢复后 flush 系统 DNS 缓存。
- **反方向的 fail-safe 不放松**：恢复失败绝不能让 DNS 留在死地址上——回滚 + 强制重置兜底，这条不随 fail-open 改变。

#### 5.2.3 连接期复核与还原判定（1.3.1）

**复核（可观察行为，界面依赖）：**

- helper 在 `status` 路径复核系统 DNS，同一连接内**两次复核至少间隔 5 秒**——`status` 是轮询热路径，`scutil` 每次都要起进程。
- 判定依据：回读当前主服务（`State:/Network/Global/IPv4` 的 `PrimaryService`）的 `ServerAddresses`，看它**是否仍含我们写入的 `223.5.5.5`**。
- 不一致 → `dns_hijack.applied = false`，`reason` 固定为 **`连接期间网络或 DNS 设置变了`**。前端可能直接展示这句话，改文案必须同步通知前端。
- **双向**：复核发现键里重新出现我们写入的地址（用户把 DNS 改回来、网络恢复）→ `dns_hijack.applied` 回到 `true` 且 `reason = null`。降级不是单向闩锁，不能要求用户重连才消失。
- 读不到系统 DNS **不**判定失效：保留上一次结论，下个周期再查。
- 用轮询而不是 SCDynamicStore 通知是**有意的取舍**：当前 helper 没有可挂的事件循环，5 秒滞后对「换网络后提示降级」够用。

**还原判定（防串网、防断网）：**

- 写回原始值之前必须先回读该服务当前 DNS：**只有它仍等于我们写入的 `223.5.5.5`**，才写回快照里的原始值。
- 不相等（网络换了、服务键被 DHCP 重建、用户手动改过 DNS）→ **什么都不写**，只丢弃快照。**空键例外**，见下条。
- **空键（`ServerAddresses` 为空）→ 必须救援**：机器此刻没有任何解析。救援候选只能用「现读的全局 DNS」与兜底 DNS，**不得用快照**——快照属于旧网络，用了就是串网。
- **部分命中**：当前值含 `223.5.5.5` 但还有其他条目（用户在连接期间手动加过 DNS）→ 摘掉 `223.5.5.5` **与旧对端 `172.19.0.2`**、保留其余条目写回，搜索域沿用快照；只剩这些地址时改走救援。
- **有快照**且原本没有服务级 DNS（`had_state = false`）→ **不删键**，写一组可用地址：全局 DNS 快照优先，其次现读的全局 DNS，最后兜底 DNS `223.5.5.5` / `119.29.29.29`。
- **救援候选里排除我们自己**：快照与现读的全局 DNS 都要滤掉我们写入的 `223.5.5.5` 和旧对端。全局 DNS 键此刻就是从我们的键派生的——读回来只有我们自己的地址时若照抄，等于「还原」成自己，用户的 DHCP / 自定义 DNS 永远回不来。滤空后继续往下一级候选走，最后才落到兜底 DNS。
- **没有快照**（崩溃后重启）的清扫：只处理**整组恰好等于旧对端**（配置推得的对端或常量 `172.19.0.2`）的服务。`172.19.0.2` 也是常用私有网段地址，用户真把内网 DNS 设成它也合法，不能因为「包含」就在每次启动时整组换掉。
- **没有快照时不清 `223.5.5.5`**：它是真实可用的公网 DNS，用户也可能自己就设它；我们没有可靠标记能证明这个值是我们写的。没有标记就不自动清，宁可留一组能用的 DNS——机器仍能正常解析。这是「不误伤用户配置」优先于「收回残留」的取舍。
- **已知边界**：没有快照时，**清空的服务键不会被救援**——我们无法证明那个空键和自己有关，贸然写入公共 DNS 会覆盖用户的配置。这类机器需要重连一次（有快照路径）或关开网络自愈。
- **已知边界**：helper 崩溃后系统 DNS 可能停在 `223.5.5.5`，用户原始的自定义 DNS 丢失；机器仍能正常解析，用户可在系统设置里改回。这是上一条取舍的代价，接受。
- **已知边界**：用户把 `223.5.5.0/24` 加进自己的排除段时，发往 `223.5.5.5` 的查询会出隧道直连（不经过 `hijack-dns`），但 `system_dns` 仍报 `"tunnel"`——我们只核对键里有没有写入的地址，不核对路由表。
- **已知边界**：用户如果原本就用 `172.19.0.2` 当内网 DNS，激活时会被当旧残留摘掉、无快照清扫时整组相等也会被替换。这是「旧版本的死地址必须清掉」与「不误伤」之间的取舍，取前者。
- **写后必须回读**：写回原值要求实际值等于期望值；救援要求实际值**命中候选之一**（只判「非空」会把旧对端当成功）。不一致就保留快照并报错，不得清空后放任。
- **崩溃兜底扫描所有服务**：用 `list State:/Network/Service/.*/DNS` 枚举全部服务，命中上述「整组恰好等于旧对端」条件的改写——残留可能留在连接中换下来的旧服务上。
- **退出路径有总时限**：`atexit` 的还原整体 2 秒；**这个预算真的覆盖整条路径**——每次 `scutil` 与 `dscacheutil` / `killall -HUP mDNSResponder` 的实际超时都被钳到「剩余预算」与各自上限（1.5 秒）中的较小值，预算耗尽后跳过该步并打 WARN。launchd 等着旧进程退出，宁可少还原一步也不能卡死。
- 兜底 DNS 选阿里 / 腾讯而不用 `1.1.1.1` / `8.8.8.8`：理由见 §5.2.2。
- 反例一：把 Wi-Fi A 的 DNS（如 `192.168.1.1`）写进 Wi-Fi B（`192.168.43.x`），断连后完全解析不了。
- 反例二：删键期望回到 DHCP——实测机器直接失去解析，用户必须关开 Wi-Fi。
- 反例三：把系统 DNS 指向 TUN 对端 `172.19.0.2`——它落在排除段 `172.16.0.0/12` 里，查询出物理网卡后黑洞，整台机器解析超时（2026-11-11 真机）。

### 5.3 不变式 3：只收 tun 入站

- `inbounds` 里**只允许 `type: "tun"`**；出现 `mixed` / `socks` / `http` 等 → `config_forbidden`。
- `route.rule_set` 里**只允许本地 `type`**，不许远程引用。
- `experimental.clash_api` 的监听地址与 secret **由特权侧写死并覆盖**：只听 `127.0.0.1:49152–65535`，不许 `0.0.0.0` / `::`，secret 每次进程重新生成。

### 5.4 不变式 4：两端都先验对端，再读写消息

顺序**不可交换**，且**双向**：

1. 建立连接；
2. **服务端**校验客户端身份——在首次 `ReadFile` 之前；
3. **客户端**校验服务端身份——在首次 `WriteFile` 之前；
4. 两侧都通过**才**传输配置与回复；
5. 任一侧失败 → 关闭。服务端**一个字节都不读**，客户端**一个字节都不写**；两侧都不回错误明细（避免变成探测信道）。

**为什么客户端也要验**：Windows 的命名管道名字空间是全局的。服务没在运行时，同一用户的任意进程都可以先创建 `\\.\pipe\veyl-helper` 并冒充服务端——它收到的将是**带节点凭据的完整配置**，还能伪造「已连接」的回复。只靠服务端 ACL 挡不住这种情况，因为那时服务端根本不存在。

| | macOS | Windows |
|---|---|---|
| 服务端验客户端 | 连接建立时由 libxpc 完成（代码签名要求：`anchor apple generic` + bundle id + Team ID） | 连接后、首次 `ReadFile` 之前：客户端 PID → 持有进程句柄 → Authenticode 发布者 + 证书指纹（**不看路径**） |
| 客户端验服务端 | 由 launchd 的 Mach 服务命名空间保证：未注册进程无法占用系统命名空间里的该名字 | **发送前**：`QueryServiceStatusEx` 的服务 PID 与 `GetNamedPipeServerProcessId` 比对；不一致或服务未运行 → `peer_unverified`，不发送配置 |
| 失败表现 | 连接被拒 | 服务端 `DisconnectNamedPipe`；客户端直接关闭 `peer_unverified` |

机制细节见 §1.2。

**信任根是「谁签名谁可信」，不是「谁在哪个目录」。** 客户端路径**不参与**身份判定：Windows 应用按 per-user 安装在 `%LOCALAPPDATA%\Programs\Veyl`，若要求客户端位于 `Program Files\Veyl`，我们自己的 App 会被自己的服务拒绝。客户端镜像路径只用于日志与诊断（`windows-tun.md` §3.2，2026-11-05 更正）。

**路径白名单只约束特权侧自己执行或加载的文件**：服务二进制、`sing-box.exe`、`wintun.dll`、规则归档、staging 与状态目录。一端是「进来的请求」（只看签名），另一端是「自己要读的文件」（必须锁路径），两者不是同一条规则，不要混用。

---

## 6. 平台差异集（最小）

回答「Windows 命名管道请求与 macOS XPC 请求能否完全同形」：**内容可以完全同形，承载不能**。下面六项是全部差异，多一项都算设计跑偏。

| # | 维度 | macOS | Windows | 能不能同形 |
|---|---|---|---|---|
| 1 | 帧 | XPC 自带消息边界 | 字节流，需要长度前缀（u32 小端） | 否（仅此一项涉及编码） |
| 2 | 连接生命周期 | create → call → release | connect → write → read → disconnect | **是**：都定成「一次连接一问一答」 |
| 3 | 对端校验（**双向**） | 两侧都由系统兜住：服务端由 libxpc 验签，客户端由 launchd 的服务命名空间保证 | 两侧都要自己写：服务端验客户端签名，客户端把 SCM 的服务 PID 与 `GetNamedPipeServerProcessId` 比对 | 否（机制不同，顺序不变量相同） |
| 4 | 请求内容 | `method` + `config` 文本 | 同左 | **是** |
| 5 | 回复内容 | 同一组键 | 同左 | **是** |
| 6 | 配置值 | `interface_name` 留空；`stack: "gvisor"` / `mtu: 9000` | `strict_route` 额外为 `true`，Wintun 由 sing-box 自带；`stack` / `mtu` 同值 | **是**（信封同形，值不同；都过同一份 allowlist） |

结论：**共享层只处理 `(method, config_text) → (ok, code, message, payload)`**，平台后端只负责把这三个值搬过承载并做对端校验。任何平台专属字段都不许进信封——需要平台差异时，写进配置文本，让 allowlist 管。

---

## 7. 实现边界

| 文件 | 职责 | 是否含平台 API |
|---|---|---|
| `tun/protocol.rs` | 信封解析、allowlist、四条不变式 | 否 |
| `tun/backend.rs` | `TunBackend` trait、`TunError`、`StartReply`、`TunSnapshot` | 否 |
| `tun/xpc.rs` | macOS 承载 + 对端验签 | 是 |
| `tun/privilege/smappservice.rs` | macOS 注册与状态 | 是 |
| `tun/pipe.rs`（新） | Windows 承载 + 对端校验 | 是 |
| `tun/service_ctl.rs`（新） | Windows 服务安装/查询/启动 | 是 |
| `tun/session.rs` | 会话状态、`TunLaunchMeta`、App 侧缓存 | 否（只依赖 trait） |

`tun/session.rs` **不得**再直接 `use super::xpc`（现状是直接依赖）。这是实施计划 `§1.1` 要求的「避免两套会话逻辑分叉」。

---

## 8. 验收要点

| # | 可测断言 |
|---|---|
| 1 | 两端对同一份配置文本给出**相同**的 `config_*` 判定（同一组测试向量跑两遍） |
| 2 | 配置里塞 `log.output` / `rule_set[].path` / `mixed` 入站 / `0.0.0.0` 的 clash_api，四种都被 `config_forbidden` |
| 3 | 未连任何对端时向管道/服务发送配置，**不产生任何副作用**（无进程、无写盘） |
| 4 | `start` 连调两次：第二次成功，pid 变化，第一次的子进程已退出 |
| 5 | `stop` 连调两次：两次都 `Ok` |
| 6 | App 崩溃后重启，第一次 `status` 返回 `running: true` 且 `clash_api` 非 null |
| 7 | 用户拒绝授权后再次连接，`ensure_available` 会**再次**触发系统弹窗（`tun-mode.md` §8） |
| 8 | 任何 TUN 失败路径都不调用 `proxy.enable()`（B5-04） |
| 9 | `status` 不做磁盘校验、不遍历目录、不扫进程、不 spawn 进程；以 2s 间隔连续调用 5 分钟，进程数与文件 I/O 无增长（§2.1） |
| 10 | 服务未运行时，同用户进程先占住 `\\.\pipe\veyl-helper`：App 连接后必须判 `peer_unverified` 并关闭，**该进程收不到任何配置字节**，也拿不到连接成功的回复 |
| 11 | 客户端等回复超时 → 断开并报 `timeout`：`status` / `stop` 按 10 s、`start` 按 30 s 各测一次；服务端等首帧超时 → 断开，不产生进程、不写盘（§1.3） |
| 12 | 服务端 `start` 在 `TUN_REPLY_DEADLINE_START`（30 s）内写不完回复时，已 spawn 的 sing-box 被停掉，无孤儿进程（§1.3） |
| 13 | `restart`：收到 `{ ok: true }` 后 helper 进程以**退出码 75** 退出，launchd 拉起新映像；再次 `status` 的 `helper_build` 与重启前不同 |
| 14 | 旧 helper 收到 `restart` 返回 `bad_request`；调用方不重试、不崩溃，UI 显示「需要管理员重启」；`status` 的 `helper_build` / `helper_version` 缺失时按 `null` 解析，不报错（§1.1.1、§3.2） |

第 10–12 条与 §1.3 的四个超时常量是**最终值（2026-11-05 定稿）**，实现按此验收；核对时以这两处为准，不要按其他文档里的旧数值。

---

## 9. 残余风险与已知局限

**登记，不假装已解决。** 三条里两条是 Windows 特有的，一条是威胁模型边界。

| # | 风险 | 影响 | 为什么不修 | 可能的收口 |
|---|---|---|---|---|
| R1 | **验签与运行镜像之间的 TOCTOU**：`WinVerifyTrust` 验的是路径**当下**的磁盘文件。同用户在进程启动后删掉/改名自己的镜像，换上与我们同一签名者的副本，验签就会对上一份并不在运行的文件通过 | 影响限于「未签名代码借用签名身份连上服务」。服务不向客户端回传任何凭据，配置仍受 allowlist 与固定路径约束，所以拿不到凭据、也读不到别的配置 | 这类攻击的前提是攻击者已能在该用户会话里执行代码，那时它能做的比这更多。根治要读进程内映射的镜像并自行算哈希，还要跨 x64/arm64 各写一遍，成本高于收益 | 从进程句柄读已映射的镜像区段再验；或用受保护进程（`PROTECTED_PROCESS_LIGHT`，需 EV 证书与微软流程）。M5 / W2 真机验证时一并评估 |
| R2 | **`WTD_REVOKE_NONE` 的吊销语义**：验签不查 CRL/OCSP，已吊销的证书在本地仍会通过 | 证书吊销后，用旧签名签出的副本仍能连上服务，直到我们换证书 | 有意为之：吊销检查要联网，离线时会让 TUN 直接不可用——而 TUN 恰恰常在网络异常时最需要 | 改 `WTD_REVOKE_WHOLECHAIN` 并配缓存式检查；或在服务里内置「接受的最早签名时间」下限 |
| R3 | **客户端验服务端只到进程粒度**：PID 比对挡得住「冒充服务」，挡不住服务进程本身被管理员侧替换 | 无额外暴露：能替换 LocalSystem 服务的本来就是管理员 | 接受。威胁模型里管理员不是防御对象 | — |

macOS 侧没有 R1 / R2：XPC 的对端校验由 libxpc 基于连接上的审计令牌完成，不读路径、不依赖磁盘状态；签名有效性由系统在加载时判定。这也是 §6 第 3 项「机制不同」的实际含义——Windows 自己实现的那一侧，把 macOS 由系统兜住的保证接管过来，也就接管了它的边界。

## 10. 变更记录

### 1.6.0（2026-11-11，start 超时覆盖冷启动）

| # | 变更 | 类型 | 决议来源 |
|---|---|---|---|
| 1 | §1.3：macOS 的 `TUN_REPLY_DEADLINE_START` 由 `30 s` 改为 `90 s`（33 s 实测 runtime + 15 s 规则等待 + 25 s 准备/check + 余量）；Windows 仍 30 s，注明另行评估 | 语义变更（破坏性） | 真机冷启动：helper 用 38 s 完成，客户端 30 s 先超时，界面报失败但隧道已起来 |
| 2 | §1.3：新增「超时后必须核对」——`start` 超时不得直接判失败，先查 `status`（最多 10 s 宽限），已在跑就按成功接上，确认没起来才报 `timeout` | 行为修正 | 同上 |
| 3 | §1.3 的「四个值两端同一个数」改为「除 start 外两端同一个数」 | 契约澄清 | 平台冷启动成本不同 |

### 1.5.1（2026-11-11，复查收口）

| # | 变更 | 类型 | 决议来源 |
|---|---|---|---|
| 1 | §5.2.3：救援候选（快照与现读全局 DNS）都排除我们写入的 `223.5.5.5` 与旧对端；滤空后继续往下一级走，不把自己当救援结果 | 行为修正 | 全局 DNS 读超时会让「还原」再写一遍 `223.5.5.5`，用户 DHCP 永远回不来 |
| 2 | §5.2.3：连接期复核改为**双向**——地址重新出现时 `applied` 回到 `true` 且清空 `reason` | 行为修正 | 降级是单向闩锁，用户改回来也要重连才消失 |
| 3 | §5.2.3：退出总预算真正覆盖整条路径（每次外部命令的超时钳到剩余预算，耗尽即跳过并 WARN） | 行为修正 | 契约写 2 秒，实际最坏约 7.5 秒 |
| 4 | §5.2.2：写明「上游也是 `223.5.5.5`，靠 `route.auto_detect_interface` 绑物理网卡才不成环」的依赖 | 约束澄清 | 复查指出缺了这条前提 |
| 5 | §5.2.3：新增两条已知边界（用户把 `223.5.5.0/24` 加进排除段时查询出隧道但界面仍报 `tunnel`；用户自己用 `172.19.0.2` 当内网 DNS 会被当残留替换） | 已知边界 | 复查要求写清 |
| 6 | §5.2.2：捕获原始值时**只要旧对端出现在列表里就摘掉**（不再要求整组相等），它排在 `nameserver[0]` 会让查询先等超时 | 行为修正 | 复查指出 `[172.19.0.2, x]` 永远清不掉 |
| 7 | 本文件版本升到 `1.5.1` | 元数据 | — |

### 1.5.0（2026-11-11，系统 DNS 改指公网地址）

| # | 变更 | 类型 | 决议来源 |
|---|---|---|---|
| 1 | §5.2.2：连接期系统解析器由 **TUN 对端 `172.19.0.2`** 改为 **公网 DNS `223.5.5.5`**。对端落在 `FIXED_EXCLUDES` 的 `172.16.0.0/12` 里，查询被排除路由送出 TUN 后黑洞 | 语义变更（破坏性） | 真机：`scutil --dns` 已指向对端，sing-box 侧 `inbound DNS packet` 0 条，国内外全部 `Resolving timed out` |
| 2 | §5.2.3：复核与还原判定改为核对 `223.5.5.5`；`RemovePeer` 同时摘掉旧对端；**无快照清扫只清旧对端，不清 `223.5.5.5`**（它是可用公网 DNS，也可能是用户自己设的，没有可靠标记就不动）；新增「崩溃后 DNS 停在 `223.5.5.5`」的已知边界 | 行为澄清 | 同一次真机；不误伤用户配置优先于收回残留 |
| 3 | §5.2.2：原始值捕获不再把 `223.5.5.5` 当残留（用户可能自己就设它），只把旧对端当残留 | 行为澄清 | 同上 |
| 4 | 本文件版本升到 `1.5.0` | 元数据 | — |

### 1.4.2（2026-11-11，清扫收窄与命令时限）

| # | 变更 | 类型 | 决议来源 |
|---|---|---|---|
| 1 | 本文件版本升到 `1.4.2`；§5.2.3 明确：`RemovePeer` 同时摘掉旧兜底常量、搜索域沿用快照；**无快照清扫只认整组恰好等于**（避免误伤把 `172.19.0.2` 当内网 DNS 的用户）；无快照时清空的服务键不救援，列为**已知边界**；`dscacheutil` / `killall` 也套 1.5 秒时限 | 行为澄清 | 复查指出会误伤用户 DNS、且 flush 无超时 |

### 1.4.1（2026-11-11，堵住剩余的空 DNS 路径）

| # | 变更 | 类型 | 决议来源 |
|---|---|---|---|
| 1 | 本文件版本升到 `1.4.1`；§5.2.3 增补：**空键也走救援**（且不得用快照）、**部分命中**只摘对端地址保留其余、**写后回读**（救援要求命中候选而非「非空」）、崩溃兜底**扫描所有服务**、退出还原**总时限 2 秒**（单次 scutil 1.5 秒） | 行为澄清 | 复查发现仍有路径能把机器留在「没有 nameserver」 |

### 1.4.0（2026-11-11，还原不再删键）

| # | 变更 | 类型 | 决议来源 |
|---|---|---|---|
| 1 | 本文件版本升到 `1.4.0`；§5.2.2/§5.2.3 的还原语义由「原本没有 DNS 就删键」改为**必须写回可用地址**（全局 DNS 快照优先，最后兜底 `223.5.5.5` / `119.29.29.29`） | 语义变更（破坏性） | 真机验证：删键不会回落 DHCP，机器直接失去解析，只能关开 Wi-Fi |
| 2 | 写入校验由「`scutil --dns` 的 resolver #1 是我们」改为「服务级 DNS 键含对端地址」；resolver #1 降级为诊断日志 | 行为澄清 | 解析器编号与顺序会被系统重排，旧判定会把成功当失败 |
| 3 | 激活时额外记录 `State:/Network/Global/DNS` 作为兜底快照 | 实现约束 | 断连时服务级没有原始值也要有东西可写 |

### 1.3.1（2026-11-09，连接期复核与还原判定）

| # | 变更 | 类型 | 决议来源 |
|---|---|---|---|
| 1 | 本文件版本升到 `1.3.1`；§5.2.3 新增连接期复核：`status` 路径节流 5 秒、以「当前主服务 DNS 是否仍等于对端地址」判定、不一致时 `applied=false` + 固定原因「连接期间网络或 DNS 设置变了」 | 行为澄清 | 换 Wi-Fi 后界面还显示已接管，前端需要一个可依赖的约定 |
| 2 | §5.2.3 写明还原判定：仅当前值仍等于对端地址才写回原始值，否则删键交给 DHCP | 行为澄清 | 防止把 A 网络的 DNS 写进 B 网络 |

### 1.3.0（2026-11-09，DNS 接管改为 fail-open）

| # | 变更 | 类型 | 决议来源 |
|---|---|---|---|
| 1 | 本文件版本升到 `1.3.0` | 元数据 | DNS 设置失败把整个 TUN 连接弄挂了 |
| 2 | `StartReply` / `TunSnapshot` 新增 `dns_hijack: { applied, reason }`；`status` 也回报，helper 重启后界面仍能说清有没有接管 | 字段新增 | 降级必须可见 |
| 3 | §5.2.2 改为 **fail-open**：激活失败先重试一次，仍失败就照常返回成功并回 `applied = false` + 原因；日志 WARN | 语义变更 | DNS 是优化项，隧道才是产品；一次 helper bug 不该让整个功能不可用 |
| 4 | 记录 `scutil` 必须用 `show` 不能用 `get`（`get` 不打印，解析恒为空） | 补充 | 2026-11-09 的实际故障根因 |
| 5 | App 侧状态新增 `system_dns: "tunnel" \| "unchanged"`，供界面常驻提示 | 字段新增 | 不允许静默降级 |

### 1.2.0（2026-11-09，连接期系统 DNS）

| # | 变更 | 类型 | 决议来源 |
|---|---|---|---|
| 1 | 本文件版本升到 `1.2.0` | 元数据 | Facebook / TikTok 经代理仍很慢 |
| 2 | 新增 §5.2.2：连接期系统解析器指向 TUN 对端 `172.19.0.2`，断开原样还原；写明为什么不能用 `.1`、为什么用 per-service scutil、幂等与四条恢复路径、回读校验 | 约束新增 | 实测 DNS 全程不进 TUN，系统解析器一直是路由器 |
| 3 | §5.2.1 新增 `dns_mode: "hijack"`：让 DNS 劫持发生在 `JudgeFlow`，不依赖嗅探 | 约束新增 | 同上 |
| 4 | 新增方法 `restore_dns`（无参，幂等）：强制重置的兜底，旧 helper 返回 `bad_request` 时只记日志 | 新增方法 | helper 崩溃重启后原始快照会丢 |
| 5 | `INBOUND_KEYS` 新增 `dns_mode` | 元数据 | 与 §5.2 的 allowlist 同步 |

### 1.1.0（2026-11-09，TUN 显式 gvisor 与 MTU）

| # | 变更 | 类型 | 决议来源 |
|---|---|---|---|
| 1 | 本文件版本升到 `1.1.0` | 元数据 | TUN 能连上但不通 |
| 2 | 新增 §5.2.1：`stack` 固定 `gvisor`、`mtu` 固定 `9000`，两个平台都显式写；写明不写时的默认值（Darwin 落 `mixed`、MTU 65535）与 2026-11-09 实测的 TCP 握手不完成 | 约束新增 | mixed 的 TCP 走内核 NAT，SYN 进 utun4 后没有 SYN-ACK，sing-box 零 `inbound connection` |
| 3 | §6 平台矩阵第 6 行改为「`stack` / `mtu` 两平台同值，Windows 另有 `strict_route`」 | 澄清 | 契约原来只把 `stack` 写成 Windows 专属 |
| 4 | `INBOUND_KEYS` 已含 `mtu` / `stack`，本次没有新增键 | 元数据 | — |

### 1.0.7（2026-11-05，helper 自更新与版本探针）

| # | 变更 | 类型 | 决议来源 |
|---|---|---|---|
| 1 | 本文件版本升到 `1.0.7` | 元数据 | 后台组件需要可自助换新映像 |
| 2 | `TunSnapshot` 新增 `helper_build` / `helper_version`（`string \| null`），仅供诊断；旧 helper 不返回时按 `null` 解析 | 字段扩展 | 排障时需要知道线上跑的是哪个构建 |
| 3 | 新增方法 `restart`（无参）：回 `{ ok: true }` 后 helper `exit(75)`，由 launchd 拉起新映像 | 新增方法 | 产品负责人 2026-11-05 |
| 4 | 版本协商定为「认不认识 `restart`」：旧 helper 返回 `bad_request` 即旧版，**不增加版本号比较** | 语义 | 避免两套协商依据 |
| 5 | `TUN_REPLY_DEADLINE_CONTROL` 覆盖 `restart`（10 s）；错误码表注明旧 helper 的 `bad_request` 不是故障 | 补充 | 同上 |
| 6 | §8 新增验收 13 / 14（退出码 75、旧 helper 路径） | 验收 | 同上 |

### 1.0.6（2026-11-05，本地码补第四项）

| # | 变更 | 类型 | 决议来源 |
|---|---|---|---|
| 1 | §4.4 新增本地码 `helper_missing`：`availability` 与 `call` 之间的竞态（服务被卸载/停止），Windows 的 `IpcError::HelperMissing` 即此场景；明确它**不是** `transport_error` | 补充 | 产品负责人 2026-11-05 |
| 2 | §4.3 注明该本地码仍映射 UI 理由 `helper_missing`，并说明 `local_code` 与 `reason` 同名不冲突（分属两个键） | 澄清 | 同上 |

### 1.0.5（2026-11-05，补一条映射）

| # | 变更 | 类型 | 决议来源 |
|---|---|---|---|
| 1 | §4.3 的 `tun_denied` 增补来源：`HelperStatus::requires_approval`（macOS 已注册未批准）也归到这里，文案区别于「用户拒绝」，不新造第五种理由 | 补充 | 产品负责人 2026-11-05 |

### 1.0.4（2026-11-05，超时按方法拆分）

| # | 变更 | 类型 | 决议来源 |
|---|---|---|---|
| 1 | `TUN_REPLY_DEADLINE` 拆为 `TUN_REPLY_DEADLINE_CONTROL`（`status` / `stop`，10 s）与 `TUN_REPLY_DEADLINE_START`（`start`，30 s）；连接 5 s、服务端等首帧 5 s 不变 | 修正 | 产品负责人 2026-11-05：Windows 首次 start 要复制约 78 MB 的 `sing-box.exe` 与 `wintun.dll`，10 s 会在慢盘、Defender 扫描、企业加密盘上误判超时 |
| 2 | §1.3 与 §8 第 10–12 条标注**最终值（2026-11-05 定稿）**，核对以此为准 | 标注 | 同上 |
| 3 | §8 第 11 条拆成 `status`/`stop`（10 s）与 `start`（30 s）两次超时测试 | 验收细化 | 同上 |

### 1.0.3（2026-11-05，W0–W2 评审补三处）

| # | 变更 | 类型 | 决议来源 |
|---|---|---|---|
| 1 | **客户端必须验服务端**：连接后、发送任何字节前，把 SCM 的服务 PID 与 `GetNamedPipeServerProcessId` 比对；不一致或服务未运行 → 关闭，不发送配置（§1.2、§5.4、§6 第 3 项、§8 第 10 条） | 新增不变式 | W0–W2 评审：服务未运行时同用户进程可抢占同名管道，收走含凭据的配置或伪造回复 |
| 2 | **两端读取都要超时**：新增 §1.3 三个契约常量与「超时即回滚」规则，落成 §8 第 11、12 条 | 新增约束 | 同上：无限阻塞会让界面卡死在一个不存在的回复上 |
| 3 | 新增 §4.4 本地错误 `timeout` / `peer_unverified` / `transport_error`，与 wire 码严格分开 | 新增 | 同上：超时与验端失败必须可区分 |
| 4 | 新增 §9「残余风险与已知局限」：验签 TOCTOU（R1）、`WTD_REVOKE_NONE` 吊销语义（R2）、验端粒度（R3） | 登记 | 同上，明确「不假装已解决」 |
| 5 | 变更记录从前一节顺延为 §10（新增 §9 不打断已有 §8 引用） | 结构调整 | — |

### 1.0.2（2026-11-05，验收项落地）

| # | 变更 | 类型 | 决议来源 |
|---|---|---|---|
| 1 | §2.1 把「`status` 便宜」落成可审查的判据（不哈希、不遍历、不扫进程、不 spawn），并新增 §8 第 9 条验收断言 | 约束 | 产品负责人 2026-11-05 |
| 2 | `windows-tun.md` §3.2 服务二进制名定稿为 `veyl-service.exe`，去掉 `veyl-helper.exe` 二选一 | 更正 | 同上（避免与 macOS helper 重名） |

### 1.0.1（2026-11-05，定向更正）

| # | 变更 | 类型 | 决议来源 |
|---|---|---|---|
| 1 | Windows 对端校验改为**只看签名、不看客户端路径**（§1.2、§5.4、§6 第 3 项）：路径只写日志；路径白名单只约束特权侧自己执行/加载的文件 | 修正 | 产品负责人 2026-11-05；原规则会拒掉 per-user 安装的自家 App |
| 2 | 新增 §2.1「给将来接入留的口子（I2）」：trait 必须 object-safe、`start`/`stop` 是唯一状态入口、`status` 便宜可高频调用 | 约束 | 产品负责人 2026-11-05（I2 保留） |
| 3 | `windows-tun.md` §2.1 / §3.2 同步更正，并标注「2026-11-05 更正」 | 同步 | 同上 |
| 4 | 三文交叉核对的冲突清单一并落到 `docs/notes/tun-backend-contract-conflicts.md` | 记录 | 产品负责人 2026-11-05 |

### 1.0.0（2026-11-05，首版）

| # | 变更 | 类型 | 决议来源 |
|---|---|---|---|
| 1 | 定义 `TunBackend` trait 与语义（含 `start` 替换、`stop` 幂等、`status` 无副作用） | 新增 | 双平台计划 §1.1 |
| 2 | 错误码拆成 wire 码与 UI 理由两层；`already_running` / `not_running` 不予采用 | 修正 | 与现有实现和 `tun-mode.md` §8 对齐 |
| 3 | `TunSnapshot` 增加 `since` / `last_error`，并要求 `status` 返回 `clash_api` | 字段扩展 | 支持 App 崩溃接手与流量/延迟采样 |
| 4 | 明确 Windows 与 macOS 的承载差异只有 §6 的六项 | 澄清 | 回答「两端能否同形」 |
| 5 | 四条不变式落成可测断言（§8） | 约束 | `tun-privilege.md` / `windows-tun.md` §2.2 |
