# TUN 后端契约：三文交叉核对（冲突清单）

> 日期：2026-11-05
> 范围：`docs/tun-privilege.md`（macOS）、`docs/windows-tun.md`（Windows）、`docs/tun-privilege-implementation-plan.md`（计划）
> 产出契约：[`../contracts/tun-backend.md`](../contracts/tun-backend.md)
> 性质：**核对记录**。冲突的裁决已写进契约；本文留的是「当时看到了什么、依据哪一行、后来怎么定的」，供实现方与审查方复核。

状态：**已定** = 契约里已有对应条款；**待办** = 只剩文案/实现工作，契约不变。

| # | 冲突 | 状态 |
|---|---|---|
| 1 | 错误码三套并存 | 已定（契约 §4） |
| 2 | `already_running` / `not_running` 与实现相反 | 已定（契约 §4.2） |
| 3 | 「前端已按这些码分支」不成立 | 已定（契约 §4.1/§4.3） |
| 4 | Windows 客户端路径校验 vs per-user 安装 | 已定（契约 §5.4，`windows-tun.md` 2026-11-05 更正） |
| 5 | TUN 与 `RuntimeManager` 的关系说法不一 | 已定（契约 §2.1、§3.2） |
| 6 | 两个「快照」同名不同物 | 已定（契约 §3.2、§7） |
| 7 | `since` 的归属没有定 | 已定（契约 §3.1/§3.2） |
| 8 | 「起不来的原因只有一类」与 Windows 标准用户 | 待办（只改文案，契约不变） |

---

## 1. 错误码：计划、代码、`tun-mode.md` 三套

| 来源 | 码集合 |
|---|---|
| `tun-mode.md` §8 | `tun_denied` / `helper_missing` / `tun_start_failed` |
| 实现 `src-tauri/src/tun/protocol.rs:21-27` | `bad_request` / `config_too_large` / `config_invalid` / `config_forbidden` / `rule_set_missing` / `runtime_missing` / `tun_start_failed` |
| 计划 §1.1（原稿） | `tun_denied` / `helper_missing` / `runtime_missing` / `invalid_config` / `already_running` / `not_running` / `internal` |

计划原稿既发明了新码，又丢了已实现的安全相关码（`config_forbidden`、`rule_set_missing`），还把 `config_invalid` 改名成 `invalid_config`。

**裁决（契约 §4）**：拆两层。
- **wire 码**：特权侧 → App，保留现有 7 个 + 新增 `internal`。改名没收益，只会让两端和测试一起动。
- **UI 理由**：App → 前端，只有 `tun_denied` / `helper_missing` / `tun_start_failed` / `unsupported_platform` 四种；精确码放 `details.wire_code`。

计划 §1.1 已按此改写。

---

## 2. `already_running` / `not_running` 与实现相反

- `veyl-helper/macos.rs:364`：`start` 在 spawn 前先 `self.stop()` —— **替换语义**。
- `veyl-helper/macos.rs:455-473`：`stop` 取不到 child 就什么都不做 —— **幂等**。
- 另外，`not_running` 这个字符串在仓库里已被占用：`src-tauri/src/tools/routing.rs:458` 等处用它作为 `reconnect` 字段的值，语义完全不相干，共用会造成检索歧义。

**裁决**：不引入这两个码，改为契约 §8 第 4、5 条验收断言。

---

## 3. 「前端已按这些码分支，不改」不成立

计划原稿写「前端已按这些码分支，不改」。实际：全仓读 `details.reason` 的只有四处（`App.tsx:1141`、`useVpnSession.ts:250`、`Settings.tsx:1147`、`Settings.tsx:1211`），**没有一处与 TUN 相关**。连接失败时 UI 走的是 `actionMessage(err, "启动失败")`（`useVpnSession.ts:370`），用户看到的是后端 `message`。

**裁决**：约束落在后端——App 侧必须把 wire 码翻成用户能读的中文 `message`，并在 `details.reason` 里给四种理由之一（契约 §4.3）。顺带：`helper_missing` 与网络故障必须分开显示（B5-05）。

---

## 4. Windows 客户端路径校验与 per-user 安装直接冲突（最严重，已修）

- `windows-tun.md:229`（原稿）：要求客户端镜像路径在 `Program Files\Veyl\`。
- `windows-tun.md:247`：应用按 per-user 安装到 `%LOCALAPPDATA%\Programs\Veyl`。

按原规则，**我们自己的 App 会被自己的服务拒绝**。

**裁决（2026-11-05）**：客户端身份只看 Authenticode 签名（发布者 + 证书指纹）；路径只写日志。路径白名单只约束特权侧自己执行/加载的文件（服务二进制、`sing-box.exe`、`wintun.dll`、规则归档、staging/状态目录）。理由：签名校验在路径校验面前没有增量安全性——攻击者伪造不了我们的证书，而用户目录里的 App 本来就是我们设计的合法位置。macOS 侧的对端要求同样只有「签名锚定 + bundle id + Team ID」，两端因此真正一致。

已改：契约 §1.2 / §5.4 / §6 第 3 项；`windows-tun.md` §2.1（两行）、§3.2（服务设计表 + 命名管道约束），并在文首标注「2026-11-05 更正」。

---

## 5. TUN 与 `RuntimeManager` 的关系说法不一

- `tun-privilege.md:261`：TUN 不进 `RuntimeManager`，没有看门狗，`runtime_status` 返回精简快照。
- 计划 §1.2：TUN 的节点延迟、流量、连接数经 Clash API 读取，与 proxy 模式同源。

两者可以同时成立，但没写清是哪一层在采样，实现方会分叉。

**裁决**：拆两件事——
- **生命周期**：TUN 仍不进 `RuntimeManager`（替换/停止由 `TunSession` 管）。
- **采样**：复用 `runtime::health::ClashApi` 与同一套 `traffic` / `node_latency_ms` 计算，由一个独立的 TUN 采样循环驱动，**不复用** `RuntimeManager` 的状态机。

前提是 `status` 必须返回 `clash_api`（地址 + secret），否则 App 重启后拿不到采样通道。已写进契约 §3.2。I2（将来并入 `RuntimeManager`）保留，trait 形状的留口见契约 §2.1。

---

## 6. 两个「快照」同名不同物

- 计划 §1.2 的 `TunSnapshot`：特权后端 → App 的进程级快照（running / pid / clash_api / since / last_error）。
- `tun-privilege.md` §8 的「`runtime_status` 返回精简快照」：是 `RuntimeStatus::tun(...)`，App → UI 的界面快照。

名字一样、层级不同、字段也不同。

**裁决**：契约里固定叫 `TunSnapshot`（特权层），界面层继续叫 `RuntimeStatus`；文档里不再出现「精简快照」这种无主语的叫法。

---

## 7. `since` 的归属没有定

实现把连接时刻存在 App 内存里（`tun/session.rs` 的 `connected: Mutex<Option<(Instant, String)>>`），App 崩溃重启就丢。计划把它放进 `TunSnapshot`，等于要求特权侧持有。

**裁决**：由特权侧生成并返回。这样 App 崩溃接手后仍能显示连接时长（`runtime_status` 的 `connected_since` / `uptime_seconds` 才有来源）。已写进契约 §3.1 / §3.2。

---

## 8. 「起不来的原因只有一类」与 Windows 标准用户（待办）

`tun-mode.md:138-146` 把失败归为「本质是权限」的三类。`windows-tun.md:173` 补了一条：**标准用户根本无法完成提权**，不是「再试一次」能好的。

**裁决**：UI 理由仍是 `tun_denied`，但文案必须分岔——「你拒绝了授权（可重试）」vs「当前账户没有管理员权限（重试也没用）」。这条不改变码表，只改文案，验收前落地。
