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
| P-1 | DeepSeek Key 能存（准入） | A | **PASS** | 17:43 假 Key 写入钥匙串、明确警告无效、重启后仍在 |
| AC-D1 | 下载 + SHA256 校验 | C | **PASS** | e2e `[2]` |
| AC-D2 | 解压路径穿越被拒 | C | **PASS** | 6 条归档单测全绿 |
| AC-D3 | 启动 → 停止 → 重启 | C | **PASS** | e2e `[5]`→`[7]`，pid 53642，结束后无残留 |
| AC-D4 | 崩溃 → 退避重启 → failed | C | **PASS** | `restart_count=2` 后 `state=failed` |
| AC-D5 | 配置生成过 `sing-box check` | C | **PASS** | e2e `[3]`→`[4]` |
| AC-D6 | Clash API 只监听回环 + secret 生效 | C | **PASS** | `127.0.0.1:50986`，401 / 200 |
| AC-E1 | 系统代理设置与还原 | C | **PASS（HEAD `f4085cf`）** | 15 组合逐项回基线；17:41 用户执行、17:42 复核 |
| AC-E2 | 代理残留恢复 | C | **PASS（HEAD `f4085cf`）** | recover 前 2081 → 后 2080，可判别 |
| P-4 | 二进制不早于源码（新准入） | 静态 | **通过** | 17:31 一度 ❌（源码 17:30:34 晚于二进制 17:28:04），重建后 ✅ |
| AC-B2 / B4 | 对话流式 / 工具卡渲染 | A | **未能执行** | 依赖 P-1 |
| AC-C1 ~ C5d | 审批语义与四态落库 | A | **未能执行** | 依赖 P-1 |
| AC-F1 | 对话落库并重启恢复 | A | **未能执行** | 依赖 P-1 |

**放行结论：未通过（准入尚未全通）。** C 通道全部 PASS，**P-1 也已 PASS**。还差 P-2（工具调用落库）与 P-3（对话落库）的运行时验证 —— 两者代码层面已接线、数据库是干净起点（`0 / 0`），但还没在窗口里实际跑过一次。P-2/P-3 通过后 A 通道 B2/B4/C/F 组即可开跑。

### 执行者标注

| 用例 | 执行者 | 说明 |
|---|---|---|
| AC-B1 | 用户启动应用，Clerk 观察判定 | 通道 A |
| AC-D2 | **Clerk** | 纯单测，`cargo test archive`，不启进程不占端口 |
| AC-D1/D3/D5（e2e）、D4（fault）、D6 | **Clerk**（用户 17:21 授权） | 会启动 sing-box 并占用端口。按 PM 口径，正式验收仍应注明「预检」性质 |
| AC-E1 | **用户执行**，Clerk 采基线/终态并判定 | 17:41 执行（HEAD `f4085cf`）。Clerk 的 `proxy-enable` 被权限策略拦截，未绕过 |
| AC-E2 | **用户执行**，Clerk 采基线/终态并判定 | 同上 |
| P-1 / P-2 / P-3 | 待定 | 需用户在设置页与对话框操作 |

> 写清执行者不是形式主义：E1 能重跑成功，恰恰因为能精确说出「17:21 那次跑的是 16:57 的二进制」。

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

### D-03 保存 Key 后不热更新，必须重启应用才生效（**中**，归属 Bob）

- **发现**：2026-11-02 18:02。用户在设置页保存**真实** Key（钥匙串 `mdat` 更新到 18:01:49），随后在对话里收到 `API error: [openai] Authentication failed: Authentication Fails (governor)`。
- **根因**：`AppState::new`（`src-tauri/src/agent/mod.rs:28-34`）在**应用启动时**把 Key 读进 `credentials: RwLock<Option<DeepSeekCredentials>>` 并常驻内存。代码里提供了 `set_credentials`（`agent/mod.rs:45`），但**全仓库无任何调用方**（`grep -rn set_credentials src-tauri/src/` 除定义外为空）。`deepseek_save_key`（`agent/commands.rs:169`）只写钥匙串，不通知 `AppState`。
- **后果**：应用在 17:43:58 启动时读到的还是 17:43:36 写入的**假** Key；18:01:49 保存的真 Key 只进了钥匙串，内存里仍是假 Key，于是对话调用模型时鉴权失败。用户看到的是「刚存了 Key 却说鉴权失败」，极易误判成 Key 本身有问题。
- **临时规避**：保存 Key 后**重启应用**。
- **建议修复**：`deepseek_save_key` 注入 `State<AppState>`，保存成功后调用 `app_state.set_credentials(DeepSeekCredentials::new(key))`。注意此时 `validation == "invalid"` 应仍写入凭据（让用户能看到鉴权失败的具体反馈）还是回滚，需要产品确认——但无论哪种，都不该让内存与钥匙串长期不一致。

### D-04（观察项）运行时日志文件始终为 0 字节

- `~/Library/Application Support/Veyl/logs/app-2026-11-02.log` 在应用启动 18 分钟后仍为 **0 字节**；`build/logs/dev-*.log` 里也没有任何 `veyl=` 前缀的应用日志，只有一条 macOS 输入法警告。
- 说明 `logging.rs` 虽有实现，但实际没有产出可观测的日志。**这会让后续所有缺陷排查失去日志依据**，建议 Bob 核实初始化是否被执行、默认级别是什么。
- 目前只是观察，未确认根因。

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

### AC-E1 — 代理设置与还原 → **PASS（HEAD `f4085cf`）**

**构建**：二进制 17:31:53（P-4 ✅，晚于全部 `src-tauri/src/**/*.rs`），HEAD `f4085cf`。

**执行**：17:41 由**用户**执行（测试人员的 `proxy-enable` 被本会话权限策略拦截，见 §4 第 4 条）。

**① 基线（17:40:47，测试人员采集）**

| 服务 | http | https | socks |
|---|---|---|---|
| USB 10/100/1000 LAN | `No / 127.0.0.1:2080` | 同左 | 同左 |
| Thunderbolt Bridge | `No / (空):0` | 同左 | 同左 |
| Wi-Fi | `No / 127.0.0.1:2080` | 同左 | 同左 |
| iPhone USB | `No / 127.0.0.1:2080` | 同左 | 同左 |
| MeshFlux | `No / 127.0.0.1:2080` | 同左 | 同左 |

**② `proxy-enable --port 2081`**（用户执行）

```
enabled on port 2081
{"platform":"macos","current":"127.0.0.1:2081","endpoint":"127.0.0.1:2081","has_backup":true}
```

`current` 字段成立的前提是有服务 `enabled && port != 0`，即 enable 确实生效。

**③ `proxy-disable`**（用户执行）

```
disabled
{"platform":"macos","current":null,"endpoint":null,"has_backup":false}
```

**④ disable 之后的系统状态（17:42:01，测试人员复核）**

```
USB 10/100/1000 LAN    webpr=No 127.0.0.1:2080  secur=No 127.0.0.1:2080  socks=No 127.0.0.1:2080
Thunderbolt Bridge     webpr=No (空):0          secur=No (空):0          socks=No (空):0
Wi-Fi                  webpr=No 127.0.0.1:2080  secur=No 127.0.0.1:2080  socks=No 127.0.0.1:2080
iPhone USB             webpr=No 127.0.0.1:2080  secur=No 127.0.0.1:2080  socks=No 127.0.0.1:2080
MeshFlux               webpr=No 127.0.0.1:2080  secur=No 127.0.0.1:2080  socks=No 127.0.0.1:2080
```

与 ① 逐项一致 —— 5 服务 × http/https/socks × Enabled/Server/Port，**15 个组合全部还原**，含此前的失败点 Port（2081 → 2080）。

> **关于「disable 后」这一状态的取法**：用户是把四条命令连续跑完的，17:42:01 采集到的已是 E2 recover 之后的状态。之所以仍能判定 E1，是因为存在一条可闭合的推理链 ——
> 基线 2080 → E1 enable 写 2081 → E1 disable 得到 **X** → E2 enable 时把 **X** 写进备份 → E2 recover 还原 **X** → 终态实测 2080。
> 终态是 2080，则 **X 必为 2080**，即 E1 的 disable 确实把地址写回了；否则 E2 的备份会记下 2081，recover 后终态就会是 2081。
> 这条链成立的前提是我在 17:40:47 独立采到了基线、在 17:42:01 独立采到了终态，两次都由测试人员执行、不依赖转述。

判 **PASS**。

**Thunderbolt Bridge 单列**：基线 `No / (空):0`，终态 `No / (空):0`，一致。

> **覆盖缺口（PM 已定：记录不补测）**：`incomplete` 分支（备份 `Enabled: Yes` 但无地址 → 保持开启 + `log::warn!`）本轮未端到端执行，因为 TB 基线是 `No`。见 §4 第 3 条。

#### 历史记录：17:29 的上一轮（构建 17:28:04）

同一套操作在 17:28:04 构建上也跑过一轮，结论相同（15 组合回基线）。但该轮跑完后源码又改了三次（`lib.rs` 17:29:04、`logging.rs` 17:30:43、`macos.rs` 17:30:34，即提交 `f0d232b`），由 P-4 检查发现，因此当时只记为「对 17:28 构建成立」。经核对，两版在 `restore_one` 上的差异只在 `incomplete` 分支的告警实现（`eprintln!` → `log::warn!`），而本轮 TB 走的是 `clear` 分支，两版行为一致。

17:27 还跑过一个更早的 17:26 构建版本，那时 TB 从 `Yes / (空):0` 变成 `No / (空):0`——那是该版 `enable = enabled && has_endpoint` 的设计行为，正是 D-01b 要改的点。

### AC-E2 — 代理残留恢复 → **PASS（HEAD `f4085cf`）**

**构建**：同 AC-E1（二进制 17:31:53，P-4 ✅，HEAD `f4085cf`）。
**执行**：17:41 由**用户**执行；备份与终态由测试人员独立采集。

**① `proxy-enable --port 2081`，不还原，模拟异常退出**

```
enabled on port 2081
{"platform":"macos","current":"127.0.0.1:2081","endpoint":"127.0.0.1:2081","has_backup":true}
```

此时系统停在 `127.0.0.1:2081`，`/tmp/veyl-proxy/proxy-backup.json` 已写入，等待下次启动恢复。

**② `proxy-recover`**

```
recovered from 127.0.0.1:2081
```

退出码 0，`/tmp/veyl-proxy/` 在 17:41 清空（备份已消费）。

**③ recover 后系统实际状态（17:42:01，测试人员采集）**

```
USB 10/100/1000 LAN    webpr=No 127.0.0.1:2080  secur=No 127.0.0.1:2080  socks=No 127.0.0.1:2080
Thunderbolt Bridge     webpr=No (空):0          secur=No (空):0          socks=No (空):0
Wi-Fi                  webpr=No 127.0.0.1:2080  secur=No 127.0.0.1:2080  socks=No 127.0.0.1:2080
iPhone USB             webpr=No 127.0.0.1:2080  secur=No 127.0.0.1:2080  socks=No 127.0.0.1:2080
MeshFlux               webpr=No 127.0.0.1:2080  secur=No 127.0.0.1:2080  socks=No 127.0.0.1:2080
```

与 17:40:47 的基线**逐项一致**：4 个服务 `No / 127.0.0.1:2080`，Thunderbolt Bridge `No / (空):0`。

关键是这条**可判别**：recover 之前系统是 `127.0.0.1:2081`（enable 刚写入），recover 之后是 `2080`。地址确实被写回了，不是「本来就没动」。若 recover 只是关掉开关而不写地址，终态会是 `2081`。

判 **PASS**。

#### 历史记录：17:29（构建 17:28:04）与 17:22（更早的旧构建）

17:29 在 17:28:04 构建上跑过同一流程，`recovered from 127.0.0.1:2081`，备份内容为 4 服务 `false/127.0.0.1/2080` + TB `false/''/0`，恢复后逐项一致，同样可判别。

17:22 那轮跑在更早的旧构建上，`recovered from` 同样成立，但当时系统已停在 2081（被 E1 的旧 D-01 残留污染），前后不可判别，故当时记为「待复测」。两轮均已由 HEAD 的这次重跑取代。

---

## 4. 遗留问题

0. **~~HEAD `f4085cf` 上重跑 E1/E2~~ —— 已闭环（17:41 用户执行，17:42 测试人员复核 PASS）**

   测试人员的 `proxy-enable` 在 17:31 与 17:40 两次被本会话权限策略拦截（`[Modify Shared Resources]`），按约定未重试试探、未改写命令绕过，改由用户执行四条命令。P-4（二进制 17:31:53 晚于全部源码）由测试人员先行确认，基线与终态均由测试人员独立采集，判定见 AC-E1 / AC-E2 小节。

1. **P-1 待运行时复测**：设置页与后端命令已接线（见 §5），但未做运行时验证。A 通道 B/C/F 组仍无法开始。
2. **C4 `ProfileDelete` 审批、F1 删除 active profile、E3 出口 IP、Hysteria2、9.5 连接成功率**：仍无入口/无环境，见 `acceptance-p1.md` §5。
3. **覆盖缺口（PM 已定：记录不补测）**：`restore_one` 的 `incomplete` 分支（备份 `Enabled: Yes` 但无地址 → 保持开启 + stderr 告警）本轮未端到端执行，因为 Thunderbolt Bridge 的基线已是 `No / (空):0`。要触发必须手工把该服务置为 `Yes / 空 / 0`，等于为测一个语义上就无效的边界去污染整机网络配置，收益不抵风险。**决定：保留单测 `an_enabled_backup_without_an_endpoint_is_kept_on_and_flagged` 覆盖，端到端留缺口并在本报告留痕；该段代码日后有改动时再补。**
4. **流程教训**：跑 selftest 前必须确认 `target/debug/veyl-runtime-selftest` 比源码新，否则测的是历史版本。17:21 那轮的 D-01 判定就是这么来的 —— 开发与测试并行改代码时极易再犯。
5. **系统代理当前已回到基线**，无需再手工还原。
6. **已知偏差（PM 已接受，不阻塞）：日志单次运行跨午夜不换文件**。Bob 的 logger 在进程持续运行跨过 00:00 后，仍写入启动当天那个文件，不会切到新日期的文件。影响：跨午夜的长跑会话日志归档会落在前一天。PM 按已知偏差接受，记录在案，以后修。

### Thunderbolt Bridge 备注

- 17:25 前后曾出现 `Enabled: Yes / Server 空 / Port 0` 的异常态，成因未定位。
- 17:27 起实测为 `No / (空):0`，17:29 两轮均以它为稳定基线。
- 在当前代码的三档语义下：`No + 无地址` → 清空地址 + 关闭，**保持 No**；若将来出现 `Yes + 无地址` → 保持开启 + 告警。
- **不影响 E1/E2 判定。**

---

## 5. P-1 复测结果 → **PASS**（17:43，通道 A）

17:12 判 P-1 为「功能未实现」时，设置页无入口、后端无命令。17:30 静态复核发现三项都已补齐，17:43 用户在 Tauri 窗口里完成运行时复测。

| 检查点 | 17:12 | 17:30 静态 | 17:43 运行时 |
|---|---|---|---|
| 设置入口 | 按钮无 `onClick` | `onClick={onOpenSettings}` | 点击可打开设置页 ✅ |
| 后端命令 | `invoke_handler` 无 Key 命令 | 已注册两条 | — |
| 前端调用 | 无 | `tauriBridge.ts:92,106` | — |
| 假 Key 保存 | — | — | 写入钥匙串 + 明确警告无效 ✅ |
| 重启后保持 | — | — | 仍存在 ✅ |

实现路径：`agent::commands::deepseek_save_key` → `secrets::save_deepseek_key`（`src-tauri/src/secrets/mod.rs:135`），工具路径 `tools/services.rs:517` 复用同一个函数。

### 证据

**① 假 Key（`sk-fakefakefakefakefake1234`）的界面提示原文**

> Key 已写入本机钥匙串，但 DeepSeek 鉴权失败（可能无效或已被吊销）。请重新输入一个有效的 Key。

逐条对齐 `docs/contracts/tools.md` §4.15：

| 契约要求 | 实际表现 |
|---|---|
| `saved: true`（Key 已写入钥匙串，无论验证是否通过） | 提示「已写入本机钥匙串」✅ |
| `validation: "invalid"` 时必须**明确告知**，不得说「已成功配置」 | 提示「鉴权失败（可能无效或已被吊销）」✅ 未出现「配置成功」字样 |
| `content` 与 `validation` 一致 | 一致 ✅ |

**② 钥匙串（只读查存在性，未读取 Key 内容）**

```
"acct" = "deepseek_api_key"
"svce" = "io.github.aiwithblockchain.veyl"
"cdat" = "2026-11-02T09:43:36Z"    ← 本地 17:43:36，与保存动作吻合
"mdat" = "2026-11-02T09:43:36Z"
```

重启后（17:43:58，新进程 PID 68604）再次查询：条目仍存在，`mdat` **未变化** —— 说明重启路径是读回，没有重新写入。

**③ 空值与格式非法**

用户确认两项均被拒绝、测试通过。**提示原文未逐字留存**，这是本次记录的证据缺口；按契约 §4.15 的 `minLength: 20`，`abc123` 应在 schema 层被拒。

### 结论

P-1 **PASS**。存储路径、验证语义、重启持久化三条都成立，假 Key 只覆盖到 `invalid` 分支（真实有效 Key 返回 `ok` 的分支未测，需真实 Key，属 AC-B2 前置）。

---

## 6. P-2 / P-3 复核（17:33，静态 + 只读 SQL）

17:12 判定「工具调用不落库、对话不落库」时，`store/tool_calls.rs` 与 `chat_*` 都没有调用点。17:33 复核，写入路径都已接上：

| 路径 | 调用点 |
|---|---|
| `tool_calls::begin` | `src-tauri/src/claurst_session/mod.rs:435` |
| `tool_calls::finish` | `src-tauri/src/claurst_session/mod.rs:453` |
| `tool_calls::record_approval_for` | `tools/policy.rs:303`、`agent/commands.rs:73` |
| `chat::append_message` | `src-tauri/src/claurst_session/mod.rs:491` |
| `store/chat.rs` 模块 | 存在，`ensure_session` / `append_message` / `list_sessions` / `messages` / `latest_session` / `delete_session` |

**数据库当前基线（17:33，只读）**：

```
tool_calls     0
chat_messages  0
chat_sessions  0
```

三项全为 0 —— 说明此前从未落过库，这也正好是一个干净的起点：走完 P-2/P-3 后，计数应变为 ≥ 1，无需按时间戳过滤历史数据。

**结论：P-2 / P-3 的阻塞点同样已从代码层面消除，但未做运行时验证。** 仍需在窗口里实际操作一次并查库确认。
