# 双平台特权架构实施计划

> 日期：2026-11-05
> 状态：**macOS 与 Windows 均进入实施；Windows 真机验收后置**（2026-11-05）。
> 产品负责人确认目标形态为「界面普通权限 + 特权助手/服务」，
> macOS 与 Windows 同一原则，不采用整应用提权。
> 上游文档：[`tun-architecture-decision.md`](tun-architecture-decision.md)（选型）、
> [`tun-privilege.md`](tun-privilege.md)（macOS 设计与信任模型）、
> [`windows-tun.md`](windows-tun.md)（Windows 设计）、
> [`tun-test-readiness.md`](tun-test-readiness.md)（当前测试阻塞项）。

---

## 0. 决策

**界面进程永远是普通用户权限；只有独立的后台助手/服务持有特权。**

| | macOS（已有） | Windows（待建） |
|---|---|---|
| 界面进程 | 普通用户 | 普通用户 |
| 特权进程 | `veyl-helper`（root，LaunchDaemon） | `veyl-service`（LocalSystem，SCM 服务） |
| 通信 | XPC + 对端代码签名要求 | 命名管道 + 客户端进程校验 + Authenticode |
| 运行时 | 随包 `sing-box`，helper 复制到自己目录后执行 | 随包 `sing-box.exe` + `wintun.dll`，服务复制到 `ProgramData` 后执行 |
| 首次授权 | 首次 TUN 连接 → 系统设置里打开后台助手（一次） | 首次 TUN 连接 → 一次 UAC（安装服务） |
| 再次授权 | 仅在重装/换签名时 | 仅在服务被删除或升级时 |
| 安装时是否要管理员 | 否 | **否**（per-user 安装） |

**明确不做的**：整应用 `requireAdministrator`、启动时提权、把 WebView 跑成特权进程、
每次连接弹一次 UAC、在用户可写目录放服务二进制。

**开发机绕一步可接受**：`tauri dev` 无法测试 TUN，只能用签名包。这不改变最终用户的一次授权体验，
处理方式是补一条开发脚本（M2），不引入调试特权通道。

---

## 1. 平台无关契约

以下四条两端必须一致，由 `src-tauri/src/tun/protocol.rs` 与新的平台无关接口承载：

1. **请求里没有路径。** 只传配置 JSON 内容；运行时、规则、日志、pid 由特权侧决定。
2. **配置走 allowlist，多余键拒绝。** 复用 `protocol::enforce_allowlist()`，两个平台同一份实现。
3. **只接受 `type: "tun"` 入站；规则集不许远程引用；Clash API 只绑回环。**
4. **两端都先验证对端身份，再读写消息；任何校验失败都关闭，不降级。**

### 1.1 抽象接口（新增，避免两套会话逻辑分叉）

```rust
// src-tauri/src/tun/backend.rs —— 平台无关
pub trait TunBackend {
    fn availability(&self) -> Result<Availability, TunError>; // 未注册 / 待批准 / 就绪
    fn ensure_available(&self) -> Result<Availability, TunError>; // 触发一次授权流程（幂等）
    fn start(&self, config: &str) -> Result<StartReply, TunError>;
    fn stop(&self) -> Result<(), TunError>;
    fn status(&self) -> Result<TunSnapshot, TunError>;
}
```

- macOS 实现：`MacXpcBackend`，包装现有 `tun/xpc.rs` + `tun/privilege/smappservice.rs`。
- Windows 实现：`WinPipeBackend`，包装命名管道客户端。
- `tun/session.rs` 只依赖 trait，不再直接 `use super::xpc`。
- 错误码分两层（以 `docs/contracts/tun-backend.md` §4 为准）：wire 码由特权侧返回，界面进程翻译成四种
  UI 理由（`tun_denied` / `helper_missing` / `tun_start_failed` / `unsupported_platform`）。
  前端只认这四种 reason，不认 wire 码。`start` 是替换语义、`stop` 幂等，不存在
  `already_running` / `not_running`。

### 1.2 状态与可观测性

两端返回同一种 `TunSnapshot`：`running`、`pid`、`clash_api`（地址 + secret）、`since`、
`last_error`。TUN 的节点延迟、流量与连接数经 Clash API 读取，与 proxy 模式同源。

---

## 2. 工作分解

### 阶段 0 · 契约与平台门控（2–3 天）

| 编号 | 任务 | 负责 | 产出 |
|---|---|---|---|
| 0.1 | 实现 `tun/backend.rs` 抽象与统一错误码；`session.rs` 改依赖 trait | 网络开发（接口见 `docs/contracts/tun-backend.md`） | 平台无关接口、现有 macOS 行为不变 |
| 0.2 | Windows 构建门控：`tun::session` 不再无条件依赖 `xpc`；`veyl-helper` bin 加 `cfg(target_os = "macos")` | 网络开发 | `cargo check --target x86_64-pc-windows-msvc` 通过 TUN 模块 |
| 0.3 | 契约测试：同一组请求/响应在两端（模拟传输层）行为一致 | 测试与契约 | 不依赖真机的契约测试 |
| 0.4 | 文档对齐：`tun-privilege.md` / `windows-tun.md` 引用本计划 | 架构师 | 三份文档不互相矛盾 |

**验收**：macOS 现有 393 个测试全绿；Windows 目标能编译到 TUN 模块（不要求运行）。

### 阶段 M · macOS 收口（3–5 天）

macOS 不是从零开始，缺的是「可测、可验证、可维护」。

| 编号 | 任务 | 依据 | 验收 |
|---|---|---|---|
| M1 | **P0 运行时哈希**：helper 不再用编译期哈希比对包内文件；复制时计算哈希、以哈希命名，之后校验目录名与文件一致 | `tun-test-readiness.md` §3.1 | 签名包首次连接不再报 `runtime_missing` |
| M2 | `scripts/dev/tun-dev.sh`：`tauri build --debug` → 签名 → 装 `/Applications` → 启动；签名身份先试 Apple Development，失败退回 Developer ID | `tun-architecture-decision.md` §5.2 | 一条命令出可测包；文档写清前置条件 |
| M3 | 首次授权体验：`tun_denied` 时给出「去系统设置打开助手」的可点击入口；批准后允许原地重试，不必退出 App | `tun-test-readiness.md` §2.4 | 用户点两次连接即可完成，不出现假连接 |
| M4 | 生命周期收口：App 内注销助手的入口（`Registration::unregister` 已有实现、无调用点）；helper 日志轮转（GAP-02） | `tun-test-readiness.md` §3.3、GAP-02 | 可在界面里卸载助手；日志有上限 |
| M5 | 真机验证 `tun-privilege.md` §10 三条 + §8.1 验签前提 | 同上 | 三条结论写回文档，不成立则暂停并回到选型 |

**验收**：签名包在真机上完成「连接 → 系统设置授权 → 重试成功 → 断开 → 无残留」。

### 阶段 W · Windows（实施中，真机验收后置）

> 2026-11-05 决定：Windows 代码照常实现，按 W0 → W6 推进；每一步的真机验证由产品负责人
> 在 Windows 10/11 x64 真机上执行，开发侧只提供命令与判定标准。签名证书仍未确认，只阻塞 W6。

Windows 是重做，不是移植。顺序不可颠倒：先能编译，再有服务，再谈 TUN。

| 编号 | 任务 | 关键约束 | 验收 |
|---|---|---|---|
| W0 | 平台门控与构建：`Cargo.toml` 的 helper bin 仅在 macOS 构建；`build.rs` 识别 `sing-box.exe`；`fetch-runtime.mjs` 支持 Windows zip + `wintun.dll` | 见阶段 0.2 | Windows CI 能编译整个 crate |
| W1 | **服务骨架 + 命名管道**：`veyl-service.exe`，LocalSystem；`FILE_FLAG_FIRST_PIPE_INSTANCE`、`PIPE_REJECT_REMOTE_CLIENTS`、受限 ACL | `windows-tun.md` §3.2 | 非管理员客户端能连上并完成一次 ping；抢占管道失败；`status` 满足契约 §8 第 9 条（2s × 5min 无增长） |
| W2 | **双向对端认证**：服务端取客户端 PID → 持有句柄 → `WinVerifyTrust` 校验发布者与证书指纹；客户端连上后先查 SCM 服务 PID、与管道服务端 PID 比对，再发送配置 | 两端都先验后读；双向超时；路径白名单只约束服务执行/加载的文件 | 未签名或他签客户端被拒；抢占管道时客户端快速失败；服务端不回包不会永久挂起 |
| W3 | **TUN 竖切**：服务 staging `sing-box.exe` + `wintun.dll` 到 `%ProgramData%\Veyl\runtime\<sha256>\`，启动/停止、pid 管理、孤儿回收 | 服务不读任何用户可写路径 | 管理员安装后，界面以普通用户连上 TUN，出口 IP 改变 |
| W4 | **平台配置差异**：TUN 地址段改为不与 `172.16.0.0/12` 重叠（建议 `198.18.0.1/15` 并从 `FIXED_EXCLUDES` 移除）；新增「TUN 地址 ∩ 排除段」启动即失败校验；评估 `strict_route`、`stack`、IPv6 | `tun-windows-notes.md` §5.1 | 重叠配置被拒绝；DNS 不黑洞 |
| W5 | **安装/卸载**：per-user 应用安装器（NSIS currentUser，不弹 UAC）；首次 TUN 时启动已签名的提权安装器注册服务；卸载停服务 → 删适配器 → 清代理/DNS → 删目录；与 E3 共用清理代码 | `windows-tun.md` §3.4 | 安装不弹 UAC；首次连接弹一次；卸载无残留 |
| W6 | **签名与分发**：Authenticode + 时间戳；服务、提权安装器、主程序、安装包都签 | 外部依赖：证书 | `signtool verify /pa /v` 全通过 |

**Windows 前置条件**（不阻塞写代码，阻塞验收）：

1. ✅ **真机已确认可用**（2026-11-05，产品负责人确认有 Windows 10/11 x64 真机，可反复装卸）。
   验证命令由产品负责人执行，开发侧只提供步骤与判定标准，不远程操作。
2. 代码签名证书或 Azure Trusted Signing（未确认）；
3. Wintun / sing-box 许可证 notices 复核（未确认）。

### 阶段 I · 集成收口（macOS 完成后）

| 编号 | 任务 | 说明 |
|---|---|---|
| I1 | GAP-03：TUN 连接返回值补齐 `RuntimeStatus` 字段 | 先把「连接那一帧」修对，再谈接入 |
| I2 | TUN 接入 `RuntimeManager`：热切节点、看门狗、统一流量采样 | 与 proxy 模式同一套健康检查 |
| I3 | E3 清理与两平台卸载共用同一段代码 | 正常退出 / 异常退出 / 卸载三条路径 |

---

## 3. 文件归属（避免并发写同一文件）

| 工作流 | 独占文件 | 只读 |
|---|---|---|
| 架构师 | `docs/tun-privilege-implementation-plan.md`、`docs/contracts/*`、`docs/notes/*` | 其余全部 |
| 网络开发（macOS） | `src-tauri/src/bin/veyl-helper/**`、`tun/xpc.rs`、`tun/privilege/**`、`tun/trust.rs`、`tun/backend.rs`（实现；接口由 `docs/contracts/tun-backend.md` 定稿）、`scripts/dev/**`、`scripts/packaging/**` | `tun/protocol.rs` |
| Windows 开发 | 新增 `src-tauri/src/tun/windows/**`、`src-tauri/src/bin/veyl-service/**`、`tun/backend/windows.rs`、`installer/**`、`scripts/windows/**` | `tun/protocol.rs`、`config/builder.rs` |
| Windows 开发（共享改动） | `src-tauri/Cargo.toml`、`tun/mod.rs`、`tun/session.rs`、`build.rs`、`scripts/fetch-runtime.mjs` | — |
| 代码审查 | 不写 | 全部 |
| 测试与契约 | `src-tauri/tests/**`、`src-tauri/src/tun/*_tests.rs` | 全部 |

**规则**：Windows 工作流不得修改 `bin/veyl-helper/macos.rs`、`tun/privilege/smappservice.rs`、
`scripts/packaging/*`；macOS 工作流实现 `tun/backend.rs`，但不得修改其接口定义（见 `docs/contracts/tun-backend.md`，由架构师维护）。

---

## 4. 验收标准（总）

### 4.1 安全

- [ ] 界面进程非特权：macOS `id -u` ≠ 0；Windows `whoami /groups` 无 High/System 完整性。
- [ ] 特权进程不读用户可写路径：两平台代码审查逐条列出输入源并核对。
- [ ] 伪造客户端被拒：macOS 用非签名进程连 XPC；Windows 用未签名或他签 exe 连管道。
- [ ] 客户端不向未验证的服务端发送配置；管道被抢占时必须快速失败，不挂起。
- [ ] 配置 allowlist 两端同一份实现，多余键拒绝有测试。
- [ ] 请求里不存在路径字段（两端协议结构体一致）。

### 4.2 一次授权

- [ ] macOS：首次 TUN 连接 → 系统设置批准一次 → 之后不再提示。
- [ ] Windows：安装不弹 UAC；首次 TUN 连接弹一次 UAC → 之后不再提示。
- [ ] 拒绝授权后应用仍可用代理模式；用户可原地重试，不需重装。
- [ ] 界面不出现「假的已连接」；权限错误与网络错误分开显示。

### 4.3 功能

- [ ] 两端都能建隧道、改出口、断开恢复。
- [ ] 断开/崩溃/卸载后无残留接口、路由、DNS、进程、服务。
- [ ] TUN 的节点延迟与流量与 proxy 模式同源显示。

---

## 5. 排期

| 周 | macOS | Windows | 其他 |
|---|---|---|---|
| 1 | 阶段 0 + M1 + M2 | W0 平台门控（可与 macOS 并行） | 架构师定契约 |
| 1–2 | M3 + M4 + M5 真机验证 | W1 服务 + 管道 | 代码审查介入 |
| 2–3 | I1 GAP-03 | W2 对端认证 | — |
| 3–5 | I2 / I3 | W3 TUN 竖切 | 测试补契约用例 |
| 5–6 | — | W4 配置差异 + W5 安装卸载 | 验收清单 |
| 6+ | — | W6 签名与分发（等证书） | — |

**关键路径**：M1（不修则 macOS TUN 测不了）→ M5（验证信任链）→ W3（Windows 第一条竖切）。
**外部依赖**：Windows 真机已确认可用；Windows 签名证书未确认。
**排期说明**：Windows 与 macOS 并行推进；Windows 的真机验证安排在每个阶段交付之后。

---

## 6. 风险

| # | 风险 | 处理 |
|---|---|---|
| 1 | macOS 信任链前提（SMAppService 是否验签 helper）被证伪 | M5 先验；不成立则暂停 Windows 投入，回到选型 |
| 2 | Windows 服务提权面写错（管道 ACL / DLL 搜索 / ImagePath） | W1–W2 逐项代码审查，安全评审单独过一遍 |
| 3 | 并发修改共享文件 | §3 文件归属；共享改动只由 Windows 工作流做 |
| 4 | Windows 真机验证依赖产品负责人执行命令 | 每个 W 阶段交付时附「可直接复制」的验证步骤与判定标准；未验证项显式标注 |
| 5 | 签名证书缺失导致服务无法分发 | W6 独立；开发期本机可装未签名服务，不影响实现 |
| 6 | TUN 地址段改动波及 macOS | W4 改动需回归 macOS 真机（M5 之后） |

---

## 7. 给产品负责人的一句话

macOS 已经是你确认的那种形态，这轮把它「修到能测、能验、能卸载」；
Windows 是从零补一个同形态的服务端，界面永远不需要管理员。
两端都只在「第一次真的要用 TUN」时问一次权限，拒绝也不影响其它功能。
