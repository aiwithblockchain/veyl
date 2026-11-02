# P1 验收报告（执行记录）

> 执行：Clerk ｜ 日期：2026-11-02 ｜ 依据：`docs/acceptance-p1.md` v1.0
> 通道标注：**A** = Tauri 窗口（唯一有效验收）｜ **C** = CLI selftest（只证明运行时本身）
> 执行方式说明：`acceptance-p1.md` §0.1 规定命令由用户执行。本轮 **2026-11-02 17:21 用户明确授权测试人员直接执行**，故 D/E 组由测试人员本地运行，证据为原始终端输出（存 `build/logs/`）。

> **判定变更记录**（时间为事件发生的实际时刻；未记到精确时间的按顺序描述）：
> 1. **17:21** 首跑 E1/E2，判 AC-E1 FAIL、D-01 成立（当时用的是 16:57 构建）。
> 2. 架构师随后收紧 AC-E1 判据 —— 必须逐项比对 **Enabled / Server / Port**，只看勾选框不够；D-01 升为阻断、AC-E2 降为待复测。
> 3. 架构师指出 **`src-tauri/src/proxy/macos.rs` 已于 17:24 重写**，而 17:21 那轮用的是 16:57 的旧二进制。经核实：旧版 `restore_one` 的三条件确实只在 `enabled=true` 时写回地址，**D-01 在当时的 HEAD 上是真实缺陷，不是误报**。17:24–17:27 Bob 修复后，当前构建不再复现。
> 4. **17:27** 用 17:26 构建复跑（中间轮，见 AC-E1 小节末），四主服务恢复正确，但 Thunderbolt Bridge 出现 `Yes→No`；随后 Bob 于 **17:27:40** 再改 D-01b 语义（新增 `incomplete` 分支）。
> 5. **17:29** 用当前构建（源码 17:27 / 二进制 17:28）最终重跑，**AC-E1 与 AC-E2 均判 PASS**。

---

## 1. 结论总表

| ID | 名称 | 通道 | 判定 | 说明 |
|---|---|---|---|---|
| AC-B1 | 应用启动与窗口 | A | **PASS** | 17:12:57，标题 `Veyl`，三栏完整 |
| P-1 | DeepSeek Key 能存（准入） | A | **待运行时复测** | 17:12 判定「功能未实现」；17:30 静态复核发现已接线（见 §5） |
| AC-D1 | 下载 + SHA256 校验 | C | **PASS** | e2e `[2]` |
| AC-D2 | 解压路径穿越被拒 | C | **PASS** | 6 条归档单测全绿 |
| AC-D3 | 启动 → 停止 → 重启 | C | **PASS** | e2e `[5]`→`[7]`，pid 53642，结束后无残留 |
| AC-D4 | 崩溃 → 退避重启 → failed | C | **PASS** | `restart_count=2` 后 `state=failed` |
| AC-D5 | 配置生成过 `sing-box check` | C | **PASS** | e2e `[3]`→`[4]` |
| AC-D6 | Clash API 只监听回环 + secret 生效 | C | **PASS** | `127.0.0.1:50986`，401 / 200 |
| AC-E1 | 系统代理设置与还原 | C | **PASS** | 17:29 当前构建重跑，5×3×3 共 15 组合逐项回基线 |
| AC-E2 | 代理残留恢复 | C | **PASS** | 17:29 当前构建重跑，recover 后可判别地回到 2080 |
| AC-B2 / B4 | 对话流式 / 工具卡渲染 | A | **未能执行** | 依赖 P-1 |
| AC-C1 ~ C5d | 审批语义与四态落库 | A | **未能执行** | 依赖 P-1 |
| AC-F1 | 对话落库并重启恢复 | A | **未能执行** | 依赖 P-1 |

**放行结论：未通过。** C 通道全绿（AC-D1~D6、AC-E1、AC-E2 全部 PASS），**唯一剩下的阻断是准入 P-1** —— A 通道 B2/B4/C/F 组因此整体无法开始。

---

## 2. 缺陷

### D-01 代理还原不写回 server/port —— **HEAD 上的真实缺陷，已修复（17:24–17:27）并在当前构建验证 PASS**（归属 Bob）

> **口径说明**：D-01 **不是误报**。旧代码 `restore_one` 的判据 `setting.enabled && !server.is_empty() && port != 0` 确实只在 `enabled=true` 时才写回地址，关闭态只关开关 —— 描述的现象完全成立。错的不是判断，是**用 16:57 的旧二进制去验证 17:24 之后的新代码**。这两件事必须分开记，否则后来的人会误读成「测试误报了一次」。

- **发现时间**：17:21，跑的是 **16:57 构建**（`target/debug/veyl-runtime-selftest` 16:57，源码当时也是旧版）。
- **当时现象**：`proxy-disable` 后 `Enabled` 回到 `No`，但 `Server:Port` 停在 `127.0.0.1:2081`，未回到 `127.0.0.1:2080`。
- **当时根因**：旧版 `restore_one` 在 `enabled=false` 时只执行 `-setwebproxystate off`，`else` 分支不写回 `server`/`port`。
- **修复**：Bob 于 17:24–17:27 改写为 `plan_restore` + 无条件 `set_endpoint`（先写地址，再切开关）。
- **验证**：17:29 用当前构建（源码 17:27 / 二进制 17:28）重跑 AC-E1，5 服务 × 3 代理类型 × Enabled/Server/Port 共 15 个组合逐项回基线，**Port 从 2081 正确回到 2080**；AC-E2 同样 PASS。
- **结论**：**已修复并验证**。留下的教训是：跑 selftest 前必须确认二进制比源码新（已上升为准入检查 P-4）。

#### D-01b「启用但地址无效」的还原（**设计如此，不记缺陷**）

`plan_restore` 里 `enable = setting.enabled && has_endpoint`。备份若存到 `enabled: true / server: "" / port: 0`，恢复结果是 `No / "" / 0`。架构师确认这是有意为之（无效地址无法「还原」，只能关闭），故不记缺陷，仅记录在此备查。

### D-02 验收文档的备份文件名写错（**已由架构师修正**）

- `acceptance-p1.md` 原写 `proxy_backup.json`，实际是 `proxy-backup.json`（连字符，`src-tauri/src/proxy/backup.rs:77`）。17:35 已改。

---

## 3. 证据

### AC-D1 / D3 / D5 — e2e

命令：`./src-tauri/target/debug/veyl-runtime-selftest e2e --data-dir /tmp/veyl-accept`
日志：`build/logs/ac-d1.log`

```
[2] download → sha256 → extract → install
    binary: /tmp/veyl-accept/runtime/1.14.4/sing-box-1.14.4-darwin-arm64/sing-box
[3] building the client config
[4] sing-box check → activate
[5] starting the runtime
    state: running            pid: 53642
[6] probing the clash api
    /version → sing-box 1.14.4
[7] stopping the runtime
    state: idle
[8] re-listing the install state
    active version: 1.14.4
E2E PASSED
```

紧随其后：`pgrep -fl sing-box` → 无进程（D3 的「结束后清理干净」成立）。

### AC-D2 — 归档路径穿越

命令：`cargo test --manifest-path src-tauri/Cargo.toml archive`

```
running 6 tests
test runtime::archive::tests::rejects_symlink_escaping_the_root ... ok
test runtime::archive::tests::rejects_absolute_entries ... ok
test runtime::archive::tests::rejects_parent_traversal ... ok
test runtime::archive::tests::accepts_a_flat_archive ... ok
test runtime::archive::tests::rejects_zip_traversal ... ok
test runtime::archive::tests::accepts_a_zip_with_nested_dir ... ok
test result: ok. 6 passed; 0 failed
```

`..`、绝对路径、symlink 逃逸、zip 穿越四条负向用例都在。

### AC-D4 — 故障注入

命令：`veyl-runtime-selftest fault --data-dir /tmp/veyl-fault`
日志：`build/logs/ac-d4.log`

```
[1] 启动假 sing-box（2 秒后自杀）
    state: running
[2] 等待重启预算耗尽
[3] 校验失败状态与重启次数
    state=failed restart_count=2 last_error=Some("process exited with exit status: 1")
    restarting events: 2
FAULT INJECTION PASSED
```

重试预算有限，退避后进入 `failed`，没有无限重启。

### AC-D6 — Clash API 监听面

手动用 e2e 装好的 runtime 起 sing-box（e2e 第 7 步会停掉，不能直接在 e2e 后 `lsof`）：

```
COMMAND    PID   USER   FD   TYPE   NAME
sing-box 53876 wesley   10u  IPv4   TCP 127.0.0.1:58080 (LISTEN)
sing-box 53876 wesley   11u  IPv4   TCP 127.0.0.1:50986 (LISTEN)

无secret: 401
有secret: 200

sing-box 日志：clash-api: restful api listening at 127.0.0.1:50986
```

两个监听都在 `127.0.0.1`，不是 `0.0.0.0`；无 secret 被拒。采集完已 `kill`，`pgrep -fl sing-box` 为空。

### AC-E1 — 代理设置与还原 → **PASS**（17:29 最终重跑）

构建：源码 `macos.rs` 17:27、二进制 17:28（比源码新）。重跑前 `cargo test --lib` → **105 passed / 1 ignored**，确认构建为当前版本。

**① 基线（17:29:00）**

| 服务 | http | https | socks |
|---|---|---|---|
| USB 10/100/1000 LAN | `No / 127.0.0.1:2080` | 同左 | 同左 |
| Thunderbolt Bridge | `No / (空):0` | 同左 | 同左 |
| Wi-Fi | `No / 127.0.0.1:2080` | 同左 | 同左 |
| iPhone USB | `No / 127.0.0.1:2080` | 同左 | 同左 |
| MeshFlux | `No / 127.0.0.1:2080` | 同左 | 同左 |

**② `proxy-enable --port 2081`（17:29:10 → 17:29:13）**

5 个服务 × 3 种代理，**全部**变为 `Yes / 127.0.0.1:2081`：

```
USB 10/100/1000 LAN    webpr=Yes 127.0.0.1:2081  secur=Yes 127.0.0.1:2081  socks=Yes 127.0.0.1:2081
Thunderbolt Bridge     webpr=Yes 127.0.0.1:2081  secur=Yes 127.0.0.1:2081  socks=Yes 127.0.0.1:2081
Wi-Fi                  webpr=Yes 127.0.0.1:2081  secur=Yes 127.0.0.1:2081  socks=Yes 127.0.0.1:2081
iPhone USB             webpr=Yes 127.0.0.1:2081  secur=Yes 127.0.0.1:2081  socks=Yes 127.0.0.1:2081
MeshFlux               webpr=Yes 127.0.0.1:2081  secur=Yes 127.0.0.1:2081  socks=Yes 127.0.0.1:2081
```

`proxy-status` → `current: 127.0.0.1:2081 / has_backup: true`。

**③ `proxy-disable`（17:29:21 → 17:29:24）**

```
USB 10/100/1000 LAN    webpr=No 127.0.0.1:2080  secur=No 127.0.0.1:2080  socks=No 127.0.0.1:2080
Thunderbolt Bridge     webpr=No (空):0          secur=No (空):0          socks=No (空):0
Wi-Fi                  webpr=No 127.0.0.1:2080  secur=No 127.0.0.1:2080  socks=No 127.0.0.1:2080
iPhone USB             webpr=No 127.0.0.1:2080  secur=No 127.0.0.1:2080  socks=No 127.0.0.1:2080
MeshFlux               webpr=No 127.0.0.1:2080  secur=No 127.0.0.1:2080  socks=No 127.0.0.1:2080
```

**与 ① 逐项一致** —— 5 个服务 × http/https/socks × Enabled/Server/Port，**15 个组合全部还原**。含此前失败的 Port（2081 → 2080）。`proxy-status` → `current: null / has_backup: false`，备份文件被消费。

判 **PASS**。

**Thunderbolt Bridge 单列**：它的基线是 `No / (空):0`，断开后仍是 `No / (空):0`，**完全一致**。

> **覆盖缺口（已知，非失败）**：当前代码的三档语义里有「备份为 `Enabled: Yes / 无地址` 时保持开启并告警」一档（`incomplete`）。本轮 TB 的基线已经是 `No / (空):0`，因此**这一档没有被本轮执行覆盖**。要覆盖需先把 TB 手工置为 `Yes / (空):0` 再跑，本轮未做。单测 `an_enabled_backup_without_an_endpoint_is_kept_on_and_flagged` 覆盖该分支。

#### 历史记录：17:27 的中间轮（已被 17:29 取代）

17:21 首跑用的是 16:57 二进制（源码 17:24 已重写），那次对 D-01 的判定在**当时的 HEAD 上成立**，只是不适用于之后的新代码。17:27 用 17:26 构建复跑过一次，四个主服务全部正确回到 2080，但 Thunderbolt Bridge 从 `Yes / (空):0` 变成了 `No / (空):0` —— 那是 17:26 版 `enable = enabled && has_endpoint` 的设计行为，也正是 D-01b 要改的点。17:27:40 该语义已再改。17:29 的最终轮不受此影响。

**前置修正**：17:21 首跑用的是 16:57 二进制，源码 17:24 已重写。以下是重建二进制（源码 17:26 → 无改动直接复用）后的结果。

**① 基线（17:27:13）**

| 服务 | http | https | socks |
|---|---|---|---|
| USB 10/100/1000 LAN | `No / 127.0.0.1:2080` | 同左 | 同左 |
| Thunderbolt Bridge | `No / (空):0` | `No / (空):0` | `No / (空):0` |
| Wi-Fi | `No / 127.0.0.1:2080` | 同左 | 同左 |
| iPhone USB | `No / 127.0.0.1:2080` | 同左 | 同左 |
| MeshFlux | `No / 127.0.0.1:2080` | 同左 | 同左 |

**② `proxy-enable --port 2081`（17:27:15）** → 5 个服务全部被写成 `127.0.0.1:2081`，`proxy-status` 回报 `current: 127.0.0.1:2081 / has_backup: true`（该字段的成立条件是「有服务 enabled 且 port≠0」，即确实生效）。

> 说明：这一步我的表格脚本把 `Authenticated Proxy Enabled: 0` 误当成 `Enabled` 字段打印成 `0`，因此「启用态」以 `proxy-status` 的 `current=127.0.0.1:2081` 为准，不以表格里的 `0` 为准。

**③ `proxy-disable`（17:27:17）**

| 服务 | http | https | socks |
|---|---|---|---|
| USB 10/100/1000 LAN | `No / 127.0.0.1:2080` ✅ | 同左 ✅ | 同左 ✅ |
| Thunderbolt Bridge | `No / (空):0` ✅ | 同左 ✅ | 同左 ✅ |
| Wi-Fi | `No / 127.0.0.1:2080` ✅ | 同左 ✅ | 同左 ✅ |
| iPhone USB | `No / 127.0.0.1:2080` ✅ | 同左 ✅ | 同左 ✅ |
| MeshFlux | `No / 127.0.0.1:2080` ✅ | 同左 ✅ | 同左 ✅ |

**Enabled / Server / Port 三项与基线逐项一致，含此前失败的 Port。** 判 **PASS**。`proxy-status` 回报 `current: null / has_backup: false`，备份文件被消费。

（③ 这张表是在 disable 之后紧接着单独跑的一次只读采集，此时系统未被任何其他操作改动，等同于 disable 后的瞬时状态。）

### AC-E2 — 代理残留恢复 → **PASS**（17:29 当前构建重跑）

构建同 AC-E1（源码 17:27 / 二进制 17:28）。

**① `proxy-enable --port 2081`（17:29:35），不还原，模拟异常退出**

`/tmp/veyl-proxy/proxy-backup.json` 被写入。备份内容摘要：

```
USB 10/100/1000 LAN    http enabled=False server='127.0.0.1' port=2080
Thunderbolt Bridge     http enabled=False server=''          port=0
Wi-Fi                  http enabled=False server='127.0.0.1' port=2080
iPhone USB             http enabled=False server='127.0.0.1' port=2080
MeshFlux               http enabled=False server='127.0.0.1' port=2080
```

同时系统实际状态（17:29:38）：5 个服务全部 `Yes / 127.0.0.1:2081`。

**② `proxy-recover`（17:29:45）**

```
recovered from 127.0.0.1:2081
```

退出码 0，`/tmp/veyl-proxy/` 清空（备份已消费）。

**③ recover 后系统实际状态（17:29:48）**

```
USB 10/100/1000 LAN    webpr=No 127.0.0.1:2080  secur=No 127.0.0.1:2080  socks=No 127.0.0.1:2080
Thunderbolt Bridge     webpr=No (空):0          secur=No (空):0          socks=No (空):0
Wi-Fi                  webpr=No 127.0.0.1:2080  secur=No 127.0.0.1:2080  socks=No 127.0.0.1:2080
iPhone USB             webpr=No 127.0.0.1:2080  secur=No 127.0.0.1:2080  socks=No 127.0.0.1:2080
MeshFlux               webpr=No 127.0.0.1:2080  secur=No 127.0.0.1:2080  socks=No 127.0.0.1:2080
```

与 ① 的备份内容**逐项一致**，也与 E1 的基线一致：4 个服务回到 `No / 127.0.0.1:2080`，Thunderbolt Bridge 回到 `No / (空):0`。

关键是这次能**判别**「真写回」与「根本没动」：recover 前系统是 2081，recover 后是 2080 —— 地址确实被写回了，不是没动。

判 **PASS**。

#### 历史记录：17:22 旧构建那轮（已作废）

旧构建上跑出的 `recovered from 127.0.0.1:2081` 同样成立，但当时系统已停在 2081，前后不可判别，故当时记为「待复测」而非 PASS。本轮重跑取代它。

---

## 4. 遗留问题

1. **P-1 阻断（唯一剩下的放行阻断）**：设置页与 `deepseek_save_key` / `deepseek_key_status` 未实现，A 通道 B/C/F 组无法开始。等 Alice + Bob 补齐后重跑准入。
2. **C4 `ProfileDelete` 审批、F1 删除 active profile、E3 出口 IP、Hysteria2、9.5 连接成功率**：仍无入口/无环境，见 `acceptance-p1.md` §5。
3. **覆盖缺口**：`restore_one` 的 `incomplete` 分支（备份 `Enabled: Yes` 但无地址 → 保持开启 + stderr 告警）本轮未被执行，因为 Thunderbolt Bridge 的基线已是 `No / (空):0`。需手工把该服务置为 `Yes / (空):0` 才能做端到端覆盖；当前仅由单测 `an_enabled_backup_without_an_endpoint_is_kept_on_and_flagged` 覆盖。可选补测。
4. **流程教训**：跑 selftest 前必须确认 `target/debug/veyl-runtime-selftest` 比源码新，否则测的是历史版本。17:21 那轮的 D-01 判定就是这么来的 —— 开发与测试并行改代码时极易再犯。
5. **系统代理当前已回到基线**，无需再手工还原。

### Thunderbolt Bridge 备注

- 17:25 前后曾出现 `Enabled: Yes / Server 空 / Port 0` 的异常态，成因未定位。
- 17:27 起实测为 `No / (空):0`，17:29 两轮均以它为稳定基线。
- 在当前代码的三档语义下：`No + 无地址` → 清空地址 + 关闭，**保持 No**；若将来出现 `Yes + 无地址` → 保持开启 + 告警。
- **不影响 E1/E2 判定。**

---

## 5. P-1 复核（17:30，静态）

17:12 判 P-1 为「功能未实现」时，设置页无入口、后端无命令。17:30 静态复核发现三项都已补齐：

| 检查点 | 17:12 | 17:30 |
|---|---|---|
| 设置入口 | `src/components/Sidebar.tsx` 的按钮**无 `onClick`**，title 写「设置（P1 W3 接入）」 | `onClick={onOpenSettings}`，title 改为「设置」 |
| 后端命令 | `invoke_handler` 里没有 Key 相关命令 | 已注册 `deepseek_save_key`、`deepseek_key_status`（`src-tauri/src/lib.rs:96-97`） |
| 前端调用 | — | `src/agent/tauriBridge.ts:92,106` 调用上述两条 |
| 设置页组件 | 不存在 | `src/components/Settings.tsx` 存在 |

实现路径：`agent::commands::deepseek_save_key` → `secrets::save_deepseek_key`（`src-tauri/src/secrets/mod.rs:135`），工具路径 `tools/services.rs:517` 复用同一个函数，没有第二套逻辑。

**结论：P-1 的阻塞点已从代码层面消除，但尚未做运行时验证。** 静态度只能证明「接线了」，不能证明「按 `DeepSeekSaveKey.validation` 契约工作」（空值、格式非法、Keychain 写入失败三种返回）。需在 Tauri 窗口里用**假 Key** 走一遍：输入 → 保存 → 显示「已保存」→ 重启后仍显示已保存。

> 假 Key 足够覆盖 P-1，不需要真实 DeepSeek Key。真实 Key 只在 AC-B2 之后需要。
