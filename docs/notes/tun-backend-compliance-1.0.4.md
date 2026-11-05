# TUN 后端契约符合性核对（契约 1.0.4）

> 日期：2026-11-05
> 对象：`src-tauri/src/tun/backend.rs`、`session.rs`、`tun/windows/**`、`bin/veyl-service/**`、`bin/veyl-helper/macos.rs`
> 基准：[`../contracts/tun-backend.md`](../contracts/tun-backend.md) v1.0.4
> 性质：**只读核对**，未改代码、未 commit。结论只针对契约，不评价设计取舍。

## 汇总

| 契约条款 | 结论 | 一句话 |
|---|---|---|
| §1.3 超时 | **部分不符合 / 部分符合** | Windows 已齐；**macOS XPC 完全没有超时**；服务端 start 回滚待实现 |
| §4.4 本地错误分层 | **类型层符合，边界层不符合** | 枚举分得很干净，但 `ui_reason()` 没有调用点，`services.rs` 直接把权限层码当 `reason` 下发 |
| §5.4 两端先验后读 | **符合** | 两个平台、两个方向都对；客户端不再校验路径 |
| §8 第 10–12 条 | **待验证 / 待实现** | 逻辑在，但没有自动化测试；回滚尚无实现对象 |
| §3.1 / §3.2 `since` / `clash_api` | **不符合** | helper 不产生、不保存；客户端用本地时钟占位 |

---

## 1. §1.3 超时

| 位置 | 结论 | 证据 |
|---|---|---|
| Windows 客户端常量 | ✅ 符合 | `tun/windows/pipe.rs:49-56`：连接 5 s、首帧 5 s；回复 10 s / 30 s 按方法取（`:128-131`） |
| Windows 客户端连接超时 | ✅ 符合 | `pipe.rs:115` + `connect_client` 用 `Instant + timeout` 轮询（`:226-260`） |
| Windows 客户端读超时 | ✅ 符合 | `ClientIo` overlapped + `WaitForSingleObject`（`:305-355`），`TimedOut` → `IpcError::Timeout`（`:142-148`） |
| Windows 服务端首帧超时 | ✅ 符合 | `read_first_frame`（`:539-574`），到点 `CancelIoEx`，超时按断开处理（`:516-521`） |
| **macOS 客户端超时** | ❌ **不符合** | `tun/xpc.rs:167-210`：`xpc_connection_send_message_with_reply_sync`（`:200`）无期限阻塞；文件内无任何 timeout。契约 §1.3 明写「libxpc 调用没有内置超时，必须自己实现」 |
| 服务端 `start` 超时回滚 | ⬜ 待实现 | Windows `start` 目前只做 allowlist 校验后返回 `runtime_missing`（`bin/veyl-service/server.rs:38-53`），没有 spawn，所以没有可回滚对象；W3 拉起 sing-box 时必须补 |

备注：`CLIENT_WRITE_TIMEOUT = 5 s`（`pipe.rs:56`）是契约之外的内部实现常量，只约束写请求，不与 §1.3 冲突。

## 2. §4.4 本地错误与 wire 码分层

| 位置 | 结论 | 证据 |
|---|---|---|
| 枚举分层 | ✅ 符合 | `backend.rs:70-89`：wire 码 8 个、权限层 3 个、本地错误 3 个 + `unsupported_platform` |
| `is_wire()` 边界 | ✅ 符合 | `backend.rs:112-125`；有测试 `:369-394` |
| `ui_reason()` 只输出四种 | ✅ 符合 | `backend.rs:127-137`：`tun_denied` / `helper_missing` / `unsupported_platform` / 兜底 `tun_start_failed`；测试 `:396-414` |
| **`ui_reason()` 是否被调用** | ❌ **不符合** | 全仓除 `backend.rs` 自身与其测试外**零调用点**。翻译层写好了，但没接上 |
| **`details.reason` 实际取值** | ❌ **不符合** | `tools/services.rs:3472-3480` 下发 `"reason": error.code`，而 `error` 是 `PrivilegeError`（`session.rs:213-219` 映射），取值范围含 `helper_install_failed`（`privilege.rs:10`，由 `smappservice.rs:56`、`:101` 产出）——这是契约 §4.3 之外的**第五种理由** |
| `details.wire_code` | ❌ 缺失 | 同上处只下发 `"detail"`；wire 码被 `to_privilege` 压成权限层码后丢失（`session.rs:213-219`） |
| `details.local_code` | ❌ 缺失 | 全仓无此键；`TunErrorCode::Timeout / PeerUnverified / TransportError` 也**从未被构造**（Windows 侧 `verify_server` 失败返回 `IpcError::HelperMissing`，`pipe.rs:155-213`；`IpcError::Timeout` 在 `:142-148` 产生但无 `WinPipeBackend` 把它翻成 `TunErrorCode`） |

结论：**契约 §4.4 的两层结构在类型层成立、在边界层没有落地**。最小修法：`services.rs` 改用 `ui_reason()` 产出 `details.reason`，wire 码放 `details.wire_code`，本地错误放 `details.local_code`，三者互斥。

## 3. §5.4 两端先验后读

| 位置 | 结论 | 证据 |
|---|---|---|
| Windows 服务端顺序 | ✅ 符合 | `pipe.rs:470` `peer::verify` → `:472` `session()`（首帧读取在 `:516`）；失败直接 `DisconnectNamedPipe`（`:476-479`） |
| Windows 服务端对端内容 | ✅ 符合 | `peer.rs:125` 起：PID → 持有句柄 → `QueryFullProcessImageNameW` → `WinVerifyTrust`（`:294`） |
| Windows 客户端顺序 | ✅ 符合 | `pipe.rs:122-138`：connect → `verify_server`(`:125`) → 写(`:136`) → 读(`:138`)；PID 比对在 `:207` |
| 客户端不校验路径 | ✅ 符合 | `path_within` 只用于服务自身镜像 `bin/veyl-service/service.rs:303`；`peer.rs` 不比对客户端路径 |
| macOS 服务端 | ✅ 符合 | `bin/veyl-helper/macos.rs:104`（listener）、`:120`（connection）设 `set_peer_code_signing_requirement`，libxpc 在连接层强制 |
| macOS 客户端验服务端 | ✅ 符合（按契约的 macOS 口径） | 契约 §5.4 已写明由 launchd 服务命名空间保证，不要求额外实现 |

## 4. §8 第 10–12 条

| 条目 | 结论 | 说明 |
|---|---|---|
| #10 抢占管道时客户端拒发 | ⬜ **待验证** | 逻辑正确（`pipe.rs:123-125`、`:155-213`），但 `pipe.rs` 内 **0 个 `#[test]`**，且该模块只在 Windows 编译，本机无法跑 |
| #11 超时 | ⬜ **部分待验证** | Windows 两侧都有实现，无测试；**macOS 客户端无超时**（见 §1） |
| #12 start 超时回滚 | ⬜ 待实现 | 服务端尚无 spawn 路径 |
| §8 #3 未验对端不产生副作用 | ✅ 符合 | 服务端验签在读之前（`pipe.rs:470/516`）；`start` 在 allowlist 之前不落盘 |

## 5. §3.1 / §3.2 `since` 与 `clash_api`

| 位置 | 结论 | 证据 |
|---|---|---|
| `StartReply.since` 由特权侧生成 | ❌ **不符合** | `backend.rs:271-274` 用 `chrono::Utc::now()` 占位，注释自认「等 helper 补齐」；helper 的 start 回复只写 pid / clash_addr / clash_secret（`bin/veyl-helper/macos.rs:162-166`） |
| `TunSnapshot.clash_api` / `since` | ❌ **不符合** | `backend.rs:296-299` 恒 `None`；helper 的 status 只回 running / pid（`macos.rs:178-184`），且 `Supervisor` 只存 `child`（`macos.rs:211-214`），**没有保存 clash 地址/端口/secret/启动时刻** |
| 崩溃接手后拿回采样通道 | ❌ 不成立 | 由上一行直接导致：App 崩溃重启后 `status` 拿不回 `clash_api`，TUN 的流量/延迟采样无通道（契约 §3.2 最后一条） |
| 字段恒存在、无值写 null | ✅ 符合 | `backend.rs:51-59`；测试 `:425-440` |
| Windows `Status` 形状 | ⬜ 待实现 | `server.rs:25-31` 字段齐、值恒 null，因 W1 未起运行时（符合「不伪造 running」） |

## 其他（不属于五条，供参考）

1. `backend.rs:1` 的模块注释写「契约 v1.0.3」，当前是 **1.0.4**，实现方更新时顺手改。
2. Windows 目前**没有 `impl TunBackend`**（全仓只有 `MacXpcBackend`、`UnsupportedBackend`、测试用 `FakeBackend`）；`session.rs:64-70` 在非 macOS 一律装配 `UnsupportedBackend`。W3 之前 Windows 走不通是预期的，但这意味着 `tun/session.rs` 的「共享会话逻辑」在 Windows 上还没有被真正走到。
3. `pipe.rs` 没有任何 `#[test]`。契约 §8 的 10–12 只能靠真机验证，建议至少补信封解析与错误映射的纯函数测试（不依赖管道）。
