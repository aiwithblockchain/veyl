# P1 macOS 集成冒烟报告

> 日期：2026-11-02
> 执行：测试 Clerk
> 范围：macOS 本机，P1 脚手架（commit 465c047 提交后的工作区状态）
> 结论：**不建议进入下一阶段开发前不修复** —— 发现 2 个阻断级缺陷，根因是 Host 的工具服务层尚未实现

---

## 0. 结论摘要

| 分组 | PASS | FAIL | 未验证 | 说明 |
|---|---|---|---|---|
| A 基线 | 3 | 0 | 0 | 契约检查多出一项 advisory |
| B 启动与对话 | 4 | 0 | 0 | 浏览器 mock 通道已验证 |
| C 审批语义 | 1 | 1 | 3 | mock 不模拟会话授权；落库层不存在 |
| D 运行时 | 3 | 0 | 1 | 真实内核链路通，故障注入缺入口 |
| E 配置与代理 | 2 | 0 | 2 | 系统代理真实生效未驱动 |
| F 边界 | 0 | 1 | 1 | 服务层是 stub |

**阻断级 2 项**（见 §7）：无持久化层、工具服务层为 stub。
**影响体验 2 项**：mock 不模拟会话授权、出口 IP 显示「未知」。
**小问题 1 项**：8 处 `contract_version` 落后（已在本轮 C0 脚本里做成 advisory）。

---

## 1. 环境与方法

| 项 | 值 |
|---|---|
| 平台 | macOS（darwin 27.0.0，arm64） |
| Node | v26.13.0 |
| sing-box | 1.14.4（官方 release，darwin-arm64） |
| 应用启动 | `npm run app:dev`（Tauri dev，Vite 1420） |
| UI 驱动 | 浏览器通道 `http://localhost:1420`（`MockAgentBridge`） |
| 真实内核 | `cargo run --bin aivpn-runtime-selftest` |
| 日志 | `build/logs/smoke-dev.log`、`build/logs/*.log` |

**方法说明（重要）**：当前只有两条可自动化通道——
1. **浏览器通道**走 `MockAgentBridge`，**不经过 Rust Host**；
2. **runtime selftest** 直接驱动 Runtime Manager，**不经过工具层与 UI**。

因此「工具层 + 审批 + 落库」这一段没有任何自动化入口，只能靠 Tauri 窗口手工点击。我没有 GUI 自动化权限，这一段如实标为「未验证」，不冒充 PASS。

---

## 2. A 基线

| # | 检查 | 结果 | 证据 |
|---|---|---|---|
| A1 | `npx tsc --noEmit` | **PASS** | 退出码 0，无输出 |
| A2 | `cargo check`（src-tauri） | **PASS** | 退出码 0 |
| A3 | `node tests/contracts/check-contracts.mjs` | **PASS（口径有变）** | 见下 |

A3 说明：清单里写的是「4/4」，实际现在是 **5 项**——本轮新增了 `contract_version` 一致性检查。结果：4 项硬性全过，第 5 项 advisory 报 **8 处落后**：

```
src-tauri/src/catalog/client.rs:12,546        1.0.4
src-tauri/src/claurst_session/events.rs:11    1.0.4
src-tauri/src/runtime/manager.rs:15,16        1.0.2 / 1.0.3
src-tauri/src/tools/envelope.rs:11            1.0.4
src-tauri/src/tools/services.rs:65,75         1.0.4
```

契约是 1.0.5。这不只是元数据：`catalog.md` 定义了 `UNSUPPORTED_CONTRACT_VERSION` → 400，客户端带 1.0.4 打 1.0.5 的服务端会被直接拒绝。

---

## 3. B 启动与对话

| # | 检查 | 结果 | 证据 |
|---|---|---|---|
| B1 | `npm run app:dev` 起得来 | **PASS** | `build/logs/smoke-dev.log`：`VITE ready in 96 ms` → `Running target/debug/aivpn`；日志中无 `error` / `panic` / `warn` |
| B2 | mock agent 回话、流式分段 | **PASS** | 输入「连到日本」后，两次快照之间助手文本从 0 增长到「本地还没有安装 sing-box。我先装一个官方版本，再帮你连到日本。」 |
| B3 | 六类事件都能到 UI，且无 `ai-` 残留前缀 | **PASS** | 见下 |
| B4 | 审批事件带 request_id | **PASS（静态）** | `mockAgent.ts` 的 `base(requestId, assistantId)` 为每个 payload 注入 `request_id`；审批卡渲染时按该 id 关联占位消息 |

B3 证据：`src/agent/protocol.ts` 的 `AGENT_EVENTS` 实际值——

```ts
messageChunk: "message-chunk"      thinkingChunk: "thinking-chunk"
toolCallStart: "tool-call-start"   toolCallEnd: "tool-call-end"
status: "ai-status"                compact: "ai-compact"
requestEnd: "ai-request-end"       approvalRequested: "approval-requested"
runtimeStateChanged / runtimeHealthChanged / jobProgress
```

与 `docs/contracts/events.md` 1.0.5 完全一致；四个会话事件已去掉 `ai-` 前缀，另外三个按契约保留。运行时 UI 上确实依次出现了思考块、工具卡、状态行。

启动耗时：Vite 96 ms，Rust `Finished dev profile in 0.71s`（热缓存），冷启动约 14 s。

---

## 4. C 审批语义

| # | 检查 | 结果 | 说明 |
|---|---|---|---|
| C1 | `vpn.connect` 会话内首次弹卡、允许后不再弹 | **FAIL（mock 通道）** | 见下 |
| C2 | 拒绝后再次调用仍会弹 | **未验证** | mock 无授权状态；真实 Host 不可驱动 |
| C3 | `core.install` 每次都弹 | **PASS（UI 层）** | 第二次「连到日本」再次出现 CoreInstall 卡 |
| C4 | `profile.delete` 每次都弹 | **未验证** | UI 无入口暴露；服务层为 stub |
| C5 | `tool_calls.approved` 落库 0/1/2 | **FAIL（未实现）** | 无 SQLite 依赖 |

**C1 的现象**：同一会话内第二次连接，`VpnConnect` 再次弹出「允许（本会话内不再询问）」。

**根因判断**：这是 **mock 通道的保真度问题，不是 Host 缺陷**。
- `src/agent/mockAgent.ts` 里有 `approvals` 回调表，但**没有 Grant 集合**（`grep -c grants` = 0），所以 `first_time_per_session` 在 mock 里等价于 `always`；
- Rust 侧 `src-tauri/src/tools/policy.rs` **实现了** Grant（`grants: HashSet<(session_id, tool)>`、命中即放行、会话结束清理）。

所以真实链路大概率是对的，但**没有任何自动化证据**，且 `policy.rs` 里没有单元测试（`cargo test` 当前 0 个测试）。这一条建议列为「需要专测」而不是「PASS」。

**C5 的现象**：`src-tauri/Cargo.toml` 里**没有任何 SQLite 依赖**（`rusqlite` / `sqlx` 均无），`tool_calls` 表不存在。契约 §2.3 要求的 `approved` 三值没有落点。

---

## 5. D 运行时与 E 配置/代理

| # | 检查 | 结果 | 证据 |
|---|---|---|---|
| D1 | 下载 v1.14.4 + SHA256 校验 | **PASS** | selftest `[2] download → sha256 → extract → install` 通过 |
| D2 | 解压到版本目录、无路径穿越 | **部分 PASS** | 正常归档解压安装成功；**未做恶意归档注入**，负向未验证 |
| D3 | 启动 → 停止（SIGTERM）→ 重启 | **部分 PASS** | `[5] starting` → `state: running` → `[7] stopping` → `state: idle`；**重启未覆盖** |
| D4 | 启动失败/异常退出时状态机回滚 | **未验证** | 无故障注入入口 |
| E1 | 生成的客户端配置过 `sing-box check` | **PASS** | selftest `[3] building` → `[4] sing-box check → activate` |
| E2 | Clash API 只监听 127.0.0.1 + secret 生效 | **PASS** | selftest `[6] /version → sing-box 1.14.4`；另用本地节点自检确认无 secret 返回 401 |
| E3 | 系统代理设置与还原 | **未验证** | 浏览器通道不碰系统代理；Tauri 窗口未驱动 |
| E4 | 代理设置失败有提示 | **未验证** | 同 E3 |

D3 细节：selftest 是**它自己下载、安装、启动、停止**，跑完退出、进程清理干净。这条是本轮最扎实的一段。

---

## 6. F 边界

| # | 检查 | 结果 | 说明 |
|---|---|---|---|
| F1 | 删除活动配置被拒（`PRECONDITION_FAILED` / `ACTIVE_PROFILE_IN_USE`，不弹审批） | **未验证** | 见 §7 缺陷 2：服务层是 stub |
| F2 | 重启后运行时状态与配置一致 | **FAIL（未实现）** | 无持久化层 |

---

## 7. 缺陷清单

### 缺陷 1（阻断发布）：Host 没有持久化层

**现象**：`~/Library/Application Support/AIVPN` 从未被创建；`src-tauri/Cargo.toml` 无任何 SQLite 依赖。

**影响**：
- 契约 §2.3 的 `tool_calls.approved` 三值无处落库（C5）；
- 会话历史、设置、profiles、runtime 安装记录、代理备份全部只在内存里，重启即失忆（F2、FR-2.5、FR-6.4）；
- 「异常退出后恢复系统代理」这条核心承诺没有数据支撑。

**最小复现**：`npm run app:dev` 启动 → 观察 `~/Library/Application Support/AIVPN` 不存在。

**建议归属**：Bob（`src-tauri/src/store/**`）。

---

### 缺陷 2（阻断发布）：工具服务层是 stub

**现象**：`src-tauri/src/tools/services.rs` 的实现直接返回空数据——

```rust
async fn profile_list(&self) -> anyhow::Result<Value> {
    Ok(json!({ "profiles": [], "active_profile_id": null }))
}
async fn profile_delete(&self, _profile_id: &str) -> anyhow::Result<Value> { ... }
```

**影响**：`VpnConnect` 的前置校验（`PRECONDITION_FAILED`）、`ProfileDelete` 的 `ACTIVE_PROFILE_IN_USE` 判定（F1）、`ProfileImport` 的真实导入，全都建立在空数据上。工具能「跑通」，但什么也没做。

**最小复现**：调 `ProfileList` → 恒返回 `{"profiles": [], "active_profile_id": null}`。

**建议归属**：Bob（`tools/services.rs` 的真实实现）+ 依赖缺陷 1。

---

### 缺陷 3（影响体验 / 测试保真度）：mock agent 不模拟会话授权

**现象**：同一会话第二次 `VpnConnect` 仍弹卡（C1）。

**影响**：浏览器通道是唯一的 UI 自动化入口，它不模拟 Grant，就意味着 C1/C2 这两条核心审批语义永远无法在 CI 里回归；真实实现（`policy.rs`）也就没有任何测试保护。

**最小复现**：浏览器打开 `localhost:1420` → 连一次并允许 → 再连一次 → 第二次仍弹卡。

**建议归属**：Alice（`src/agent/mockAgent.ts` 增加 Grant 集合，按 `first_time_per_session` 判定）。

---

### 缺陷 4（小问题）：状态面板出口 IP 显示「未知」

**现象**：连接成功后状态面板「出口 未知」。

**影响**：mock 环境下没有真实出口，属预期；但契约 FR-7.2 要求连接后展示出口 IP，需要确认真实链路的取值路径存在。

**最小复现**：浏览器通道连一次 → 看状态面板。

**建议归属**：确认归属（Alice 的 mock 或 Bob 的出口探测）。

---

### 观察项（不是缺陷）：`policy.rs` 无单元测试

`cargo test` 当前 **0 个测试**。审批策略、配置生成、归档解压这些纯逻辑没有任何自动化保护。`scripts/ci.sh` 里的 `cargo-test` 步骤目前是空转——它绿，不代表任何东西被测过。

---

## 8. 未覆盖项与原因

| 项 | 原因 | 补测方式 |
|---|---|---|
| C1 / C2 / C5 | 无 GUI 自动化；mock 不模拟授权；无落库 | 补 Rust 单测（`policy.rs`）+ Alice 补 mock Grant |
| C4 / F1 | 服务层 stub | 等 Bob 实现后重测 |
| D4 / E4 | 无故障注入入口 | 需要 `AIVPN_*` 测试开关或假可执行文件入口 |
| D2 负向 | 未注入恶意归档 | 用 `tests/fixtures/manifest-traversal.json` 走一次安装 |
| E3 / E2 真机 | Tauri 窗口未驱动 | 手工：连一次，用浏览器看出口 IP，断开后看是否恢复 |
| B1 可视确认 | 无屏幕录制权限 | 需要人工看一眼窗口是否正常渲染 |

---

## 9. 复跑方式

```bash
bash scripts/ci.sh --quick                                  # 基线 + 契约 + 密钥扫描
cargo run --bin veyl-runtime-selftest                       # D/E 真实内核链路
npm run app:dev                                             # B1 启动
# 浏览器打开 http://localhost:1430 走 B2–C3
```

本报告的 D/E 证据可直接用 `cargo run --bin veyl-runtime-selftest` 复现；B/C 的 UI 证据需要人工点击。

> 本节按当前代码更新（Vite 端口 1430、crate 改名后 bin 为 `veyl-runtime-selftest`）。§1 的环境说明保持当时原样，不复改。
