# P1.5 技术设计：常驻、退出、节点切换

> 版本：v1.0
> 日期：2026-11-02
> 上游：`docs/phase-1-5-requirements.md` §4、§5、§9
> 契约：`docs/contracts/commands.md` 1.1.0、`docs/contracts/events.md` 1.1.0、`docs/contracts/runtime.md` 1.1.0
> 状态：待 PM 审核

---

## 0. 本文回答什么

只说三件事，其余（引导内容、默认配置源、诊断话术）在需求文档里已经写得足够细，不再复述：

1. **退出流程**怎么实现，为什么不能让 `ExitRequested` 里做阻塞操作。
2. **节点切换**怎么实现，为什么必须先撤代理再停旧运行时。
3. **模块边界**划在哪里，macOS 与 Windows 各自差什么。

---

## 1. 模块边界

### 1.1 依赖方向（单向，不允许回指）

```
        ┌──────────────────┐        ┌──────────────────┐
UI ────►│ commands（invoke）│        │ tools（模型通道） │◄─── Agent
        └────────┬─────────┘        └────────┬─────────┘
                 │                           │
                 └───────────┬───────────────┘
                             ▼
                    VpnToolServices  ← 唯一业务层
                             │
        ┌────────────┬───────┴────────┬──────────────┐
        ▼            ▼                ▼              ▼
  RuntimeManager  ProxyController   Store        Secrets
        │
        ▼
   AppLifecycle（只做退出编排，不承载业务）
        │
        └──► ProxyController + RuntimeManager + config
```

**硬规则**：

- 命令层与工具层**只做参数搬运**，业务一律在 `VpnToolServices`。同语义的命令与工具必须调用同一个方法（`commands.md` §5）。
- `AppLifecycle` 允许**直接**调用 `ProxyController` / `RuntimeManager`，因为它要做「先撤代理、再停运行时」这种跨模块的顺序编排；但它**不得**复制业务判断（例如 profile 解析）。
- `RuntimeManager` 不知道系统代理的存在。这条分层从 P1 就是这个形状，1.1.0 用 `set_terminal_failure_hook`（`manager.rs:346`）补上了反向通知，**不要**为了省事把 `ProxyController` 塞进 manager。

### 1.2 新增模块

| 模块 | 位置 | 职责 |
|---|---|---|
| `app/lifecycle` | `src-tauri/src/app/lifecycle.rs` | 进程状态机（`foreground`/`background`/`quitting`）、退出编排、`quitting` 标志 |
| `app/tray` | `src-tauri/src/app/tray.rs` | 托盘图标与菜单、三态图标、点击 → 显示窗口 |
| `app/single_instance` | 用 `tauri-plugin-single-instance` | 第二次启动唤起已有窗口 |
| `proxy` 扩展 | `src-tauri/src/proxy/mod.rs` | `verify_released()`：撤销后的复核 |

### 1.3 现有模块的改动

| 文件 | 改动 |
|---|---|
| `lib.rs` | `ExitRequested` 从「同步做清理」改为「`prevent_exit` + spawn 编排」；注册单实例插件与托盘 |
| `agent/commands.rs` | 新增 `runtime_start` / `runtime_stop` / `profile_list` / `onboarding_*` / `net_repair` |
| `tools/services.rs` | 抽出 `release_network()`（撤代理 + 复核），供 `runtime_stop`、退出流程、`net_repair` 共用 |
| `runtime/manager.rs` | 不改。`RuntimeStatus` 的四个新字段在 `snapshot()` 里补 |

---

## 2. 应用生命周期

### 2.1 进程状态机

```
                 ┌─────────────┐
   启动 ────────►│ foreground  │◄──── 托盘「显示」/ 单实例唤起
                 └──────┬──────┘
         关闭窗口/Cmd+W  │  ▲
                        ▼  │
                 ┌─────────────┐
                 │ background  │
                 └──────┬──────┘
                        │ Cmd+Q / 托盘「退出」
                        ▼
                 ┌─────────────┐
                 │  quitting   │──失败──► 回到 foreground（中止退出）
                 └──────┬──────┘
                        │ 全部步骤成功
                        ▼
                    app.exit(0)
```

`quitting` 是**内部状态**，不通过 `app-lifecycle-changed` 发给 UI（`events.md` §4.7.1）。UI 只看到 `foreground` / `background`。

### 2.2 关闭窗口 = 后台

```rust
window.on_window_event(|event| {
    if let WindowEvent::CloseRequested { api, .. } = event {
        api.prevent_close();
        let _ = window.hide();
        lifecycle.set_background();
    }
});
```

- **不弹任何提示**（需求 R2）。
- 连接保持不变：这条路径不碰 `RuntimeManager`。
- macOS 的 Cmd+W 与点红灯走同一个 `CloseRequested`，不需要额外处理。

### 2.3 Cmd+Q 拦截

`RunEvent::ExitRequested` 是 macOS Cmd+Q、菜单「退出」以及**所有**正常退出路径的共同入口。托盘「退出」是应用内自己发起，走同一个 `quit_flow()`，不经过 `ExitRequested`。

---

## 3. 退出流程

### 3.1 为什么不能在 `ExitRequested` 里 `block_on`

P1 的实现是：

```rust
// 现状（lib.rs:128-136）
app.run(move |_handle, event| {
    if let RunEvent::ExitRequested { .. } = event {
        tauri::async_runtime::block_on(async { exit_manager.stop().await });
        ...
    }
});
```

这段代码能跑，是因为它做的全是**不依赖 UI** 的事。一旦要在退出流程里弹对话框，它必然死锁：

```
主线程（事件循环）── block_on(quit_flow) ──┐
                                            │ 等待
quit_flow ── 需要显示对话框 ── run_on_main_thread ──┘
                                    主线程被 block_on 占着
```

**对话框永远弹不出来，应用永远退不掉。** 这不是理论风险，是 macOS 上 `dispatch_sync` 到主线程的标准死锁形态。

### 3.2 正确形状：prevent_exit + 异步编排

```rust
app.run(move |app, event| {
    if let RunEvent::ExitRequested { api, .. } = event {
        // ① 退出流程已经放行：第二次到这里不再拦截，直接让它退出
        if lifecycle.is_quitting_final() {
            return;
        }
        // ② 先拦住，主线程立刻回到事件循环
        api.prevent_exit();
        // ③ 异步编排；主线程不等待
        let app = app.clone();
        tauri::async_runtime::spawn(async move { quit_flow(app).await });
    }
});
```

### 3.3 `quit_flow` 时序（顺序不可变）

```
quit_flow
 │
 ├─1. lifecycle.begin_quitting()
 │      · state = quitting
 │      · runtime_start 从此返回 PRECONDITION_FAILED { reason: "quitting" }
 │      · 重复按 Cmd+Q：不启动第二个流程，只把已有对话框置前
 │
 ├─2. services.release_network()            ← 见 §3.4
 │      失败 ────────────────────────────► ABORT
 │
 ├─3. 复核：没有任何网络服务仍指向我们的端口
 │      失败 ────────────────────────────► ABORT
 │
 ├─4. manager.stop()
 │      失败 → log::warn，继续（需求 §4.6：第 3/4 步失败只记日志）
 │
 ├─5. config::remove_all_profile_configs()
 │      失败 → log::warn，继续
 │
 ├─6. lifecycle.finalize()
 │      · QUITTING_FINAL = true
 │
 └─7. app.exit(0)
            └─ 再次触发 ExitRequested → ① 分支放行 → 进程结束
```

### 3.4 `release_network()`：撤代理并复核

抽成一个方法，三个调用方共用，**不允许各写一份**：

| 调用方 | 用途 |
|---|---|
| `runtime_stop`（`commands.md` §3.2） | 用户点「断开」 |
| `quit_flow` 第 2 步 | 退出 |
| `net_repair{action:"restore_direct"}` | 一键恢复网络 |

```rust
/// 撤掉系统代理，并确认已经没有网络服务指向我们的端口。
fn release_network(&self) -> Result<(), ReleaseError> {
    self.proxy.disable().map_err(ReleaseError::Restore)?;
    self.proxy.verify_released().map_err(ReleaseError::StillApplied)
}
```

`verify_released()`（新增）：

- 遍历所有网络服务 × {HTTP, HTTPS, SOCKS}，读回当前设置。
- 断言：没有任何一项是「已启用 且 `server:port` == 我们备份里记录的 `applied`」。
- 不做「不允许任何回环代理」这种更强断言——用户可能自己就有一个 127.0.0.1 的代理，误判会让退出永远失败。

> **为什么必须有复核**：`disable()` 在 macOS 上是「逐个服务调 `networksetup`」，中途某个服务失败时它返回 `Err`，但**已经改过的那些不会回滚**。只看返回码会放过「一半撤掉、一半还指着我们」的状态。

### 3.5 ABORT：代理没撤掉就不退

```
ABORT:
  1. lifecycle.abort_quitting()   // 回到 foreground
  2. app.show() + window.show() + window.unminimize() + window.set_focus()
  3. 显示对话框（异步，见 §3.6）：
       标题：网络尚未恢复，退出会导致断网
       正文：系统代理仍然指向 Veyl 的本地端口，退出后这些设置会留在系统里。
       按钮：[重试]  [强制退出]
  4. 用户选：
       重试   → 回到 quit_flow 第 2 步
       强制   → 二次确认文案：「强制退出会导致你无法上网，需要手动到系统设置里关掉代理」→ [仍然退出] [取消]
                [仍然退出] → lifecycle.finalize() ; app.exit(0)
                [取消]     → 留在 foreground，不做任何事
```

需求 §4.6 的硬要求：**宁可退出失败，也不能带着一个指向死端口的系统代理退出**。所以第 2/3 步失败一律 ABORT，第 4/5 步失败才允许继续。

### 3.6 对话框必须能到最前（第三个坑）

**问题**：窗口可能是隐藏的（`background`），macOS 可能处于 `Accessory` 激活策略（Dock 无图标），此时弹窗可能出现在用户看不到的地方，或者干脆不出现。

**做法**（顺序不能省）：

```rust
// 1. 先把应用恢复成"能弹窗"的形态
app.set_activation_policy(ActivationPolicy::Regular);  // macOS：从 Accessory 切回
let _ = window.show();
let _ = window.unminimize();
// 2. 再置前
app.set_focus();            // 或 window.set_focus()
#[cfg(target_os = "macos")]
ns_app_activate_ignoring_other_apps();   // NSApp.activate(ignoringOtherApps: true)
// 3. 最后才显示对话框
```

**不要用阻塞式 API 在主线程上弹窗。** `tauri-plugin-dialog` 的 `blocking_*` 系列在 macOS 上会 `dispatch_sync` 到主线程；从主线程调用即死锁。正确用法是在 tokio 的 blocking 线程上调用，主线程保持跑事件循环：

```rust
let answer = tauri::async_runtime::spawn_blocking(move || {
    dialog.blocking_show(...)     // 内部会派发到主线程执行模态
}).await?;
```

**Windows 的已知限制**：`SetForegroundWindow` 可能被系统拒绝（前台锁定）。降级表现是「窗口出现在任务栏但不抢焦点」，用户可以点一下。**不要**用 `AttachThreadInput` 之类的 hack 去强抢焦点——它会让输入法状态错乱。

### 3.7 坑 1 的完整表述：`app.exit(0)` 会再次触发 `ExitRequested`

```
Cmd+Q
 └─ ExitRequested #1 → QUITTING_FINAL == false → prevent_exit + spawn quit_flow
      └─ quit_flow 走完 → QUITTING_FINAL = true → app.exit(0)
           └─ ExitRequested #2 → QUITTING_FINAL == true → return（不 prevent）
                └─ 进程退出
```

**没有这个标志就是死循环**：`app.exit(0)` → `ExitRequested` → `prevent_exit` → 流程再跑一遍 → `app.exit(0)` → …

实现要点：

- 用 `AtomicBool`，`compare_exchange` 保证只放行一次。
- 标志必须在 `app.exit(0)` **之前**置位，中间不能有 `await`。
- **不要**用「流程正在跑」的同一个标志兼任两个语义。需要两个：
  - `QUIT_IN_PROGRESS`：防重复启动流程（Cmd+Q 连按）。
  - `QUITTING_FINAL`：放行第二次 `ExitRequested`。

### 3.7.1 禁止做法（以后有人想「简化」时先读这段）

#### ❌ 禁止一：在 `RunEvent` 回调里 `block_on` 任何需要 UI 的流程

```rust
// 不要这样写
app.run(|app, event| {
    if let RunEvent::ExitRequested { .. } = event {
        tauri::async_runtime::block_on(async {
            let answer = ask_quit_confirmation(app).await;  // 需要弹窗
        });
    }
});
```

**死锁形态**：

```
主线程（事件循环）
  └─ block_on(ask_quit_confirmation)
       └─ 需要显示对话框
            └─ 派发到主线程执行模态
                 └─ 主线程正卡在 block_on 上
                      └─ 对话框永远不会出现，block_on 永远不返回
```

macOS 上这通常是 `dispatch_sync` 到主线程；Windows 上表现为消息泵被占住、窗口不重绘。**两种平台都会挂，只是表现不同。**

P1 的 `block_on(exit_manager.stop().await)` 之所以能跑，是因为它**不碰 UI**。一旦退出流程需要对话框，这个前提就不成立了。

#### ❌ 禁止二：用阻塞式 dialog API 在主线程上弹窗

`tauri-plugin-dialog` 的 `blocking_*` 系列会同步派发到主线程。**从主线程调用它 = 自己等自己。**

正确用法（保持主线程跑事件循环，弹窗在 blocking 线程上发起）：

```rust
let answer = tauri::async_runtime::spawn_blocking(move || {
    dialog.blocking_show(...)      // 内部派发到主线程执行模态，本线程等待结果
}).await?;
```

#### ❌ 禁止三：把「流程正在跑」和「已最终放行」合成一个标志

两者的生命周期不同：前者在流程开始时置位、结束时清除；后者一旦置位**永不回退**（否则第二次 `ExitRequested` 又被拦住，退回死循环）。

#### ❌ 禁止四：在退出流程里 `await` 一个依赖窗口可见的操作

退出时窗口可能已经隐藏、激活策略可能是 `Accessory`。任何「等用户看到提示再继续」的设计都必须先 `show` + `set_activation_policy(Regular)` + 置前，否则等待的条件永远不会被满足。

---

---

## 4. 节点切换流程

需求 §9.4 要求「平滑切换，不允许出现『界面说已连接、实际断网』的中间态」（D-36 的教训）。

### 4.1 关键洞察：切换与首次连接应该是同一条路径

P1 的 `connect` 是「起新运行时 → 设代理」，中间没有撤代理这一步。切节点时旧代理仍指向旧端口，而旧进程已经被 `start()` 杀掉——**这一段是真的断网，而且代理还指着它**。

把 `connect` 统一改成：

```
任何一次连接（首次 / 切换）
 ├─0. 标记 switching（UI 按钮进 loading）
 ├─1. release_network()          ← 幂等：首次连接时本来就没有代理，disable 直接返回
 │      失败 → 中止，返回 PRECONDITION_FAILED{proxy_restore_failed}
 ├─2. drop_previous_rendered_config()
 ├─3. 渲染新配置（RenderedConfigGuard armed）
 ├─4. manager.start(new_plan)
 │      失败 → guard 删配置；代理是关的 → 用户走直连，安全
 ├─5. require_running_state()
 │      失败 → guard 删配置；manager.stop()；代理仍然关着
 ├─6. proxy.enable(new.mixed_port)
 │      失败 → rollback：release_network()（幂等）+ stop()；返回错误
 ├─7. guard.disarm() → set_active(new)
 └─8. 返回快照
```

**第 1 步放在最前面是这个设计的核心。** 它保证「代理关着」覆盖了第 2–5 步的全部时间窗：任何一步失败，最坏的结果是**没有代理**（流量走直连，网络可用），而不是**代理指着死端口**（网络不可用）。

用户感受：切换期间有大约 `stop_grace`（sing-box 实测 0.02s 退出）加启动握手的时间没有代理，浏览器可能有一两个请求直接漏出去。**这是刻意的取舍**——漏出去一个请求，好过让用户断网。

### 4.2 失败时的中间态

| 失败步 | 运行时 | 系统代理 | UI 显示 |
|---|---|---|---|
| 1 | 仍是 A，运行中 | 关 | 「切换失败，网络已直连」+ 重试 |
| 4 | 无 | 关 | 「连接失败」+ 重新连接 / 诊断 |
| 5 | 已停 | 关 | 同上 |
| 6 | 已停 | 关 | 「连接失败」+ 重试 |

**没有任何一格是「代理指着一个不存在的进程」。** 这是本设计要保证的不变量，验收 F3 就查这个。

---

## 5. 首次引导（只写边界，不写界面）

需求 §5 已经把界面写得很细，这里只补三条实现约束：

1. **判定在 Host 侧**：`onboarding_status` 返回 `completed` / `has_key` / `profile_count`，UI 只做布尔组合：

   ```ts
   const needsOnboarding = !completed && (!has_key || profile_count === 0);
   ```

   **是「或」不是「与」**（需求 §5.1）：只配了 Key 没有配置、或有配置但没配 Key，都要进引导。`completed` 是唯一短路条件。

   不要在 UI 里直接读 `settings` 表。
2. **`onboarding_complete` 一定写 `settings.onboarding_completed`**，无论用户是否跳过 Key。漏写会导致每次启动都被拉进引导。
3. **重入（R12）不改数据**：只重新显示向导，不得清除 Key 或 profile。

---

## 6. 状态面板的数据来源

面板每个位置的数字必须有唯一定义，不允许 UI 自己算：

| 面板位置 | 数据来源 |
|---|---|
| 状态大卡「已连接 · 东京 01」 | `state` + `profile_name` |
| 主按钮 | `state` → idle/starting/running/failed 四态 |
| 出口 IP | `health.exit_ip` |
| **直连 IP** | `direct_ip`（1.1.0 新增，见 `runtime.md` §2.5.1） |
| 连接时长 | **前端**用 `connected_since` 每秒算 `now - connected_since`，后端不推送 |
| 健康三项 | `health.process` / `health.clash_api` / `health.data_plane` |
| 本地端口 | `mixed_port` —— **禁止再出现 `2080` 常量**（R30） |
| 系统代理状态 | `system_proxy_enabled` |
| 连接数 | `connections` |
| 版本 / PID / 重启次数 / 配置哈希 | `upstream_version` / `pid` / `restart_count` / `config_hash` |
| 最近错误 | `last_error`（常驻显示，不需要展开） |
| 打开日志 | **缺口**，见 §9 |

---

## 7. macOS / Windows 差异

| 项 | macOS | Windows |
|---|---|---|
| 托盘 | `NSStatusItem`（Tauri tray icon）。三态图标建议用 **template image + 不同字形**，不靠颜色区分（R1 的色盲要求） | `Shell_NotifyIcon`，同样三态 |
| Dock | `ActivationPolicy::Regular`（显示）/ `Accessory`（隐藏） | 无 Dock 概念，托盘是唯一入口 |
| 关闭窗口 | `CloseRequested` → `prevent_close` + `hide` | 同；Alt+F4 也走这条 |
| Cmd+Q / 退出 | `RunEvent::ExitRequested` + `prevent_exit` | `ExitRequested` 同样可用；但**任务管理器结束进程无法拦截** |
| 置顶对话框 | `NSApp.activate(ignoringOtherApps: true)` | `SetForegroundWindow` 可能被拒，降级为「任务栏闪烁」 |
| 系统代理撤销 | `networksetup -set*proxystate off` / 恢复备份 | `netsh winhttp` 或注册表（现有 `proxy/windows.rs`） |
| 代理复核 | 逐服务 × 三种协议读回 | 读回同一组键 |
| 单实例 | `tauri-plugin-single-instance`（LaunchServices 唤起） | 同名 mutex（插件内置） |
| 强制退出后兜底 | 下次启动 `recover_stale` + 遗留进程回收 + 配置清扫 | 同 |

**Windows 额外注意**：从托盘「退出」和从任务管理器结束是两条完全不同的路径。前者走完整 `quit_flow`，后者什么都拦不住，只能靠下次启动兜底。文档与验收都要写清这条边界，避免把「任务管理器强杀后代理残留」当成缺陷报。

---

## 8. 错误码与用户可见文案

| 场景 | 错误码 | `details.reason` | 用户看到 |
|---|---|---|---|
| `quitting` 期间点连接 | `PRECONDITION_FAILED` | `quitting` | 「正在退出，请稍候」 |
| 断开时撤代理失败 | `PRECONDITION_FAILED` | `proxy_restore_failed` | 「网络未能恢复，连接保持」+ 重试 |
| 退出时撤代理失败 | 不走错误码 | — | 阻塞对话框（§3.5） |
| 既无 active profile 也无默认配置包 | `PRECONDITION_FAILED` | `no_active_profile` | 「先获取默认配置或导入节点」 |
| 目标 profile 不存在 | `NOT_FOUND` | — | 「这个节点已被删除」 |

---

## 9. 已知缺口（需要 PM 决定）

| # | 缺口 | 影响 | 建议 |
|---|---|---|---|
| 1 | 「打开日志」需要一个 invoke 命令，而 1.1.0 的命令清单里没有 | 状态面板三级信息做不全（需求 §9.5） | 新增 `open_log_dir {} -> { path }`；或退化为「把日志路径显示在面板里，用户手动打开」 |
| 2 | 需求 §9.2 要求显示**直连 IP**，PM 的四字段清单里没有对应字段 | 无法判断「是否真的走了代理」 | 已在 `runtime.md` §2.5 补 `direct_ip`，**请确认** |
| 3 | 需求 §10 列出 4 个新 AI 工具（`NetConfigGet` / `NetRepair` / `CatalogRefresh` / `DefaultProfileStatus`），本轮未定形状 | wave2 才能实现 | 本轮 `tools.md` 不升版；wave2 前补形状 |
| 4 | 托盘三态图标缺设计稿 | R1 的「肉眼可辨、不靠颜色」无法验收 | 先用文字角标（●/○/!）占位，设计稿到位再换 |

---

## 10. 验收映射（对应需求 §11 全部 26 条）

Clerk 写用例时以此表为骨架。**「判定方式」一列必须能落到具体命令或字段**，否则这条用例就是恒真的——没有可观测的失败条件，跑多少次都是绿色。

### 10.1 生命周期（A 组）

| # | 判定方式 | 依赖 | 备注 |
|---|---|---|---|
| A1 关闭窗口不断连 | 关闭后 `pgrep -f sing-box` 仍非空；`runtime_status.state` 仍 `running`；托盘图标为已连接 | 托盘 | |
| A2 Cmd+Q 选后台 | 对话框出现 → 选「后台运行」→ 窗口消失、`state` 仍 `running` | — | |
| A3 Cmd+Q 选退出 | 进程结束后：`scutil --proxy` 三个开关均 0；无 sing-box；`config/` 为空 | — | 三条都要查，只查一条会漏 |
| A4 托盘显示 | 点「显示 Veyl」→ 窗口可见且获得焦点 | 托盘 | |
| A5 托盘退出 | 同 A3 | 托盘 | |
| A6 撤代理失败不退出 | **需要故障注入**，见 §10.4 | 故障注入开关 | 没有注入手段这条无法执行 |
| A7 单实例 | 连续 `open -a` 两次 → `pgrep -c` 为 1；第二次窗口到前台 | — | |

### 10.2 引导 / 默认配置 / 离线（B、C、D 组）

| # | 判定方式 | 依赖 | 备注 |
|---|---|---|---|
| B1 全新安装进引导 | 清空数据目录后启动 → 首屏是引导第 1 步 | — | 判定「不是空聊天」要看 DOM 结构，不看文案 |
| B2 打开平台 | 点按钮 → 系统浏览器打开 `https://platform.deepseek.com/` | — | 由**用户**执行并确认，测试人员不代点 |
| B3 无效 Key | 粘贴 `sk-invalid` → 明确提示无效；输入框内容**保留** | — | 断言「保留」，不能只断言「有错误提示」 |
| B4 跳过 Key 能连 | 跳过 Key → 导入文件 → 连接成功；`state = running` | 可用节点 | |
| B5 重启不再弹 | 完成引导 → 重启 → 首屏是控制台 | — | |
| C1 无配置自动拉取 | 无本地包 → 启动 → `DefaultProfileStatus.node_count > 0` | 网络 | |
| C2 刷新不中断 | 连接中点刷新 → `state` 始终 `running` → 徽标出现 | 网络 | |
| C3 断网启动不白屏 | 断网 + 清空缓存启动 → 不白屏，显示导入引导 | — | |
| C4 tun 包能连 | 用含 `tun` 入站的包连接 → 渲染结果 `inbounds[0].type == "mixed"` | — | 断言渲染结果，不靠"能连上"间接证明 |
| D1 断网导入 | 断网 → 拖入合法文件 → `imported >= 1` → 能连接 | — | |
| D2 默认源不可达话术 | 断网 → 诊断 → 结论文案包含「未连接时是正常的」 | — | 断言文案语义，不是只看 `ok=false` |

### 10.3 诊断 / 面板（E、F 组）

| # | 判定方式 | 依赖 | 备注 |
|---|---|---|---|
| E1 一键诊断 | 构造三种故障各一次，`DiagReport.summary.verdict` 指向正确原因；对应 check 的 `remediation` 非空 | 故障注入 | 见 §10.4 |
| E2 代理死端口 | 手工把代理指向 1024–65535 中无人监听的端口 → `system.proxy_services.ok == false`；点「恢复网络」后 `ok == true` | — | 恢复前后都要采证 |
| E3 无 Key 诊断 | 无 Key → 点诊断 → 有结构化结果，**不产生 AI 请求** | — | 断言方式：`tool_calls` 无新增且无 `ai_send_message` |
| E4 恢复网络 | 点击 → 代理撤销、运行时停止、渲染配置删除、`exit_ip` 为直连出口 | — | 四件事缺一不可 |
| F1 面板连接 | 点「连接」→ `state=running` 且 `mixed_port` 非空 且 `exit_ip` 非空（或允许 null 时另判） | — | `exit_ip` 探测可能慢，超时不算失败 |
| F2 面板断开 | 点「断开」→ `state=idle`、代理关闭 | — | |
| F3 切换无假已连接 | 切换全程每 200ms 采一次 `state` 与 `scutil --proxy`：**不存在「state=running 且代理指向死端口」的采样点** | — | 这是唯一能证伪"假已连接"的判定方式，不能只看切换后 |
| F4 端口显示正确 | 面板显示端口 == `runtime_status.mixed_port` == `lsof` 实际监听端口 | — | 三处必须相等 |

### 10.4 故障构造（不引入通用注入后门）

约定：**每多一个 debug 后门，就多一块要维护的攻击面。** 只有真的构造不出来的那一条才用开关，其余用操作手段。

| 用例 | 构造方式 | 需要注入吗 |
|---|---|---|
| **A6** 撤代理失败不退出 | 用 `VEYL_FAULT_PROXY_DISABLE=1` 启动应用（Bob 已实现，`proxy/mod.rs:135`）→ 连接 → Cmd+Q → 应弹「网络尚未恢复」且**不退出**；去掉环境变量重试 → 正常退出 | **是**，唯一一条 |
| **E1** 节点不可达 | 手工写一个 `server = 127.0.0.1`、`server_port = 1` 的种子文件，导入后连接 → 必然失败 | 否 |
| **E2** 代理指向死端口 | 先正常连接，再 `kill` 掉 sing-box 进程（不要退应用）→ 系统代理仍指向那个已无人监听的端口 | 否 |
| E1 的 DNS 分支 | **降级为单元测试**：给诊断项注入一个必失败解析器，断言 `system.dns.ok == false` 且 `remediation` 非空 | 否（也不做端到端） |

**为什么 DNS 故障不做端到端**：要制造它必须改系统 DNS，这会真的让测试机断网，而且可能影响用户其它正在运行的程序。风险高于收益，报告里明确写「DNS 分支未做端到端」。

**关于 `E3`**：E3 是「无 Key 点诊断」，它不需要任何故障构造——清掉 Key 即可。原先把 DNS 故障记在 E3 名下是笔误，DNS 属于 E1。

**明确否决的方案**：加一个通用的 `test_fault(kind)` 命令。理由：四条故障里三条能用普通操作构造，为一条造一个通用后门不划算；而且这类命令一旦存在，很容易被后续需求的「先临时加个开关」当成先例。

> 若 PM 以后要求把 A6 也改成无后门：唯一可行的替代是给 `ProxyController` 注入一个必定失败的 backend，用单元测试断言 `quit_flow` 返回 `Abort`。那样验的是逻辑不是集成，报告里必须写明「未做端到端验证」。

### 10.5 已知不可自动化

| 项 | 原因 | 处理 |
|---|---|---|
| A2 / A4 / A5 的托盘交互 | 需要真实点击菜单栏 | 由用户操作，测试人员记录现象 |
| B2 打开浏览器 | 会离开应用 | 用户确认 |
| R7 Dock 策略切换 | 依赖系统行为 | 只能人工观察 |

---

### 10.6 LLM Provider（H 组，需求 §11）

| # | 判定方式 | 依赖 | 备注 |
|---|---|---|---|
| H1 基础模式 | 全新安装只填 DeepSeek Key → 发一句话得到回复；设置里**不出现** provider 列表 | 网络 | 判「高级模式没露出来」看 DOM，不看文案 |
| H2 高级 · OpenAI 兼容 | 新增端点 → `llm_provider_test` 返回 `ok:true` → 设为当前 → 新会话的请求目标地址 = 该端点 | mock 端点 | 「走对端点」只能看服务端收到的 Host/Path，不能看界面 |
| H3 高级 · Anthropic 兼容 | 同上，但**断言命中 `/v1/messages` 而不是 `/v1/chat/completions`** | mock 端点 | 这是区分两种协议的唯一客观证据 |
| H4 删除 provider | 删除后：列表无该项、`secrets.enc` 里 `provider:<id>` 不存在、重启后不复活 | — | 只查列表会漏掉孤儿密钥 |
| H5 旧 Key 迁移 | 升级前只有 `provider:deepseek` → 升级后基础模式仍显示同一掩码，能直接对话；`settings.llm_providers` 里出现 `deepseek` 记录且 `is_builtin=true`；**`provider:deepseek` 的值在迁移前后逐字节相同** | — | 迁移只补元数据、不搬密钥。查「值没变」才能证明没有走搬移路径 |

**H5 的第三条判定要留退路**（PM 确认，2026-11-02）：

| 层级 | 判定 | 适用 |
|---|---|---|
| 主判定 | `provider:deepseek` 的**密文逐字节相同** | 正常情况。`secrets::set` 只替换被改的字段、其余条目保留原密文（`secrets/mod.rs:119-132`），所以这条成立 |
| 退路 | **解密后明文相同** + 迁移耗时 < 50 ms | 若将来有人把 `secrets.enc` 改成「整体重加密」，主判定会无原因地变红。耗时下限同时排除了「迁移里偷偷做了网络校验或重加密」 |
| 兜底（两种都要） | 迁移刚完成、用户尚未新增任何 provider 时，`provider:` 前缀的键**总数 = 1** | 防止迁移顺手多写一个键（例如同时留下 `provider:deepseek` 和一个新键），那是最坏的一种"看起来成功" |

**H2/H3 的 mock 要求**：起一个本地 mock，记录收到的 `Host`、`Path`、`Authorization`/`x-api-key` 请求头。断言依据是**服务端记录**，不是客户端日志——客户端日志可能被脱敏到看不出问题。

> H3 尤其重要：两种协议走错时，很多端点仍然返回 200（只是解析失败或返回了错误体）。只断言「请求成功」会把配错协议判成通过。

---

## 11. wave2 契约设计

本节只写**契约形状与不变式**，不写界面。

### 11.1 默认配置包：数据模型

#### 11.1.1 为什么不能复用 `profiles` 表

种子导入的节点是「一个出站 = 一个 profile」，可以拆开存。默认配置包不行：

- 包里的 `route` 规则引用了 `selector` 的 tag，拆散成独立 profile 后这些引用全部失效。
- 包里是**共享凭据**，按 profile 存会在 `secrets.enc` 里散成一堆副本。

所以默认包单独一张表，只存元数据；**包体整体加密存一份**。

#### 11.1.2 表结构

> ⚠️ **`package_hash` 不是哈希。**
> 实测值是 `seed-dynamic-tag-test-20260313` —— 30 个字符，不是十六进制，是一个**发布方的版本标签**。
> 所以：**不能拿它做完整性校验，也不要在任何地方写「哈希校验通过」**。
> 完整性判断由客户端自己对原始响应体算 sha256（下表 `content_sha256`）。

```sql
CREATE TABLE default_packages (
  provider_id       TEXT    NOT NULL,
  content_sha256    TEXT    NOT NULL,   -- 客户端对原始响应体算的 sha256；版本判定与完整性都看它
  package_hash      TEXT    NOT NULL,   -- 发布方给的版本标签（不是哈希），原样保存，仅供展示
  source_updated_at INTEGER NOT NULL,   -- 源端更新时间（毫秒），仅用于展示
  fetched_at        INTEGER NOT NULL,   -- 本地拉取时间（毫秒）
  status            TEXT    NOT NULL,   -- active | inactive | rejected
  selector_tag      TEXT,               -- 包内 selector 的 tag；没有则为 NULL
  outbound_tags     TEXT    NOT NULL,   -- JSON 数组：可连接的出站 tag
  node_count        INTEGER NOT NULL,
  is_current        INTEGER NOT NULL DEFAULT 0,  -- 同一 provider 只允许一行为 1
  applied_at        INTEGER,            -- 最近一次被用于连接的毫秒时刻
  failure_streak    INTEGER NOT NULL DEFAULT 0,  -- 连续连接失败次数（R15 回滚用）
  PRIMARY KEY (provider_id, content_sha256)
);
```

**主键是 `(provider_id, content_sha256)` 而不是 `provider_id`**：回滚需要新旧两版同时存在（需求 R15「回到上一版本」）。只保留一行就没法回滚，只能重新下载——而重新下载在离线场景下不可用。

**为什么主键不用 `package_hash`**：它是发布方随手写的标签，可能重复、可能被复用、可能格式变化。拿一个不受我们控制的标签当身份，等于把数据一致性交给别人。

#### 11.1.3 包体存放

| 位置 | 内容 |
|---|---|
| `default_packages` 表 | 元数据（上面那几列） |
| `secrets.enc` 的 `pkg:<provider_id>:<content_sha256>` | **完整包体**（含共享凭据） |
| `profiles.config_json` | ❌ 永不写入包体或凭据 |
| 日志 / 工具返回 / 模型上下文 | ❌ 永不出现包体内容 |

密钥里带 `content_sha256` 而不是只用 `provider_id`，是为了让新旧两版在回滚窗口期内共存；用 `content_sha256` 而不是 `package_hash`，理由同上——不拿发布方的标签当身份。

**保留策略**：成功切到新版本后，保留 `is_current = 1` 的那一行与它的前一版，其余行连同 `pkg:` 条目一并删除。只留两版，避免 `secrets.enc` 无限膨胀。

#### 11.1.4 版本判定

实测 `updated_at` 是 `1970-01-01`（源端没维护），**不能用**。

| 信号 | 用途 | 改动是否触发重新应用 |
|---|---|---|
| `content_sha256`（我们算的） | **唯一权威判据**：内容是否变了 | 变了 → 变了 |
| `source_updated_at` | 展示用（「上次更新 X 天前」） | 不变或变了都不单独触发 |
| `package_hash` | 展示用（发布方的版本标签） | **不触发** |

判定流程：拉取 → 算 `content_sha256` → 与 `is_current` 那行比对 → 不同才算新版本。

**未来若发布方真的提供 sha256 摘要字段**：以其为准（它能同时证明来源与完整性，我们自算的只能证明「与上次不同」），届时把 `content_sha256` 换成对摘要的验证，并保留自算值做二次比对。这条写在这里，避免以后有人以为我们忘了一般意义上的哈希校验。

展示用的「版本标识」：优先 `source_updated_at`（人可读），其次 `package_hash`（发布方标签）。**不要把 `content_sha256` 展示给用户**——它每次内容变化都会变，对用户没有意义。

### 11.2 拉取与校验

```
CatalogRefresh
 ├─1. 节流：距上次成功拉取 < 6 小时且 force=false → 返回 changed=false
 ├─2. 请求（仅 HTTPS，域名固定，跨域重定向一律拒绝）
 ├─3. 结构校验：必填字段齐全、status === "active"
 ├─4. 计算 content_sha256 = sha256(原始响应体)
 │      ——注意：对**原始字节**算，不是对反序列化后再序列化的结果算
 ├─5. 与本地 is_current 的 content_sha256 比对：
 │      相同 → changed=false，结束（不需要写库）
 │      不同 → 写新行（is_current=0）+ 写 pkg: 条目
 ├─6. 若当前**没有**在线连接 → 立刻切换 is_current 到新行
 │      若正在连接 → 只标记 new_version_available，不切换（R16）
 └─7. 发 default-profile-updated
```

**第 4 步的细节很重要**：必须对**原始响应字节**算哈希。若先反序列化成结构体再序列化回去，键顺序、空白、数字格式都会变，同一个包每次算出来都不同——「是否变化」的判断会永远为真，于是每次刷新都当成新版本。

失败分两种，行为不同：

| 情况 | 行为 |
|---|---|
| 拉取失败，但本地有可用包体 | 返回成功、`offline = true`、`changed = false`，`detail` 写「离线，沿用本地缓存（上次更新 X 天前）」 |
| 拉取失败，本地也没有可用包体 | 返回 `UPSTREAM_ERROR`，`retryable = true`，`details.hint` 用需求 R20 的规定话术 |

**「有缓存时失败不算失败」** 这条不是宽容，是需求 R13 的明确要求：用户在用移动网络、机场 Wi-Fi 时，每一次后台刷新都弹错误会把人逼疯。

**我们不做的校验**：`package_hash` 不参与任何判断（它不是哈希）。现在能证明的只有「走的是固定域名的 HTTPS」和「内容与上次不同」——**不能证明来源**。补签名是 §11.6 的退出条件之一。

### 11.3 适配到运行时

```
包体（sing-box 原生配置）
  ├── inbounds        → 丢弃，替换为 Veyl 的 mixed 入站 + Clash API
  ├── outbounds       → 保留；selector 的 default 指向目标出站 tag
  ├── route / dns / log → 保留结构与语义
  └── 渲染结果 → sing-box check → 0600 → 连接期间存在
```

| 不变式 | 含义 |
|---|---|
| 入站永远是 Veyl 的 mixed | 包里是 `tun`，我们用不了；**不得**为此引入 TUN 权限 |
| 选择节点 = 改 `selector.default` | 不拆包、不复制出站 |
| 不认识的出站类型跳过并告警 | 一个节点坏了不能让整个包不可用 |
| 渲染结果必须过 `sing-box check` | 与 P1 同一条规则 |
| 每次连接重新渲染，断开即删 | 与 P1 同一条不变式（`RenderedConfigGuard`） |

**与种子导入的关系**：两者都是「sing-box 配置包而非节点列表」，共享同一个认知，但**落库路径不同**——种子导入拆成 `profiles`（每个节点一条，可单独选），默认包整体进 `default_packages`（selector 必须保持完整）。不要为了「复用」把默认包也拆成 profiles。

### 11.4 与在线连接的关系

| 场景 | 行为 |
|---|---|
| 刷新到新版本时正在连接 | 不替换、不重连；`new_version_available = true` |
| 用户手动刷新 | 同上；UI 只显示徽标 |
| 新包连续 2 次连接失败 | `failure_streak >= 2` → 提示「默认配置可能有问题」，提供回到上一版（把 `is_current` 切回上一行） |
| 回滚 | 只翻 `is_current`，不重新下载 |

### 11.5 内测公开凭据的边界

当前默认源是公开托管的，包内凭据对所有人可见（需求 §6.7 已接受此风险）。**代码层面必须按「凭据是敏感数据」来写**，这样将来换成签发模式时只改取数来源：

- 包体只进 `secrets.enc`，不进数据库、不进日志、不进模型上下文。
- `DefaultProfileStatus` 返回的字段里**不含**任何出站地址或凭据。
- 切换 provider 或吊销时，`pkg:` 条目能按 `provider_id` 批量删除。

### 11.6 缺口与待定

| # | 项 | 状态 | 说明 |
|---|---|---|---|
| 1 | ~~`package_hash` 的算法~~ | **已澄清** | 它不是哈希，是发布方的版本标签（实测 `seed-dynamic-tag-test-20260313`）。完整性改用客户端自算的 `content_sha256`，见 §11.1.2 |
| 2 | 包的签名 / 来源认证 | **未解决，挂到需求 §6.7 退出条件** | 内测期接受「HTTPS + 固定域名」；对外发布前必须补签名，与「凭据不公开」同一档 |
| 3 | `default_packages` 的迁移编号 | **已定** | 下一条是 `004`（`002` 是 `timestamps_ms`，`003` 是 `default_profile`）。不重写 003，只补两列，见 §11.6.1 |
| 4 | 发布方将来若提供 sha256 摘要 | 待接入 | 以其为准（能同时证明来源与完整性）；自算的 `content_sha256` 保留做二次比对 |

#### 11.6.1 与已落地的 `003_default_profile.sql` 的对账

仓库里已经有了 `src-tauri/src/store/migrations/003_default_profile.sql`，结构与 §11.1.2 的草案不同。差异与处置：

| 项 | 003 现状 | 本契约要求 | 处置 |
|---|---|---|---|
| 行数 | 单行表（`CHECK id = 1`）+ `previous_*` 列做回滚 | 多行 `(provider_id, content_sha256)` | **保留 003 的单行结构**。R15 只要求回退一版，`previous_*` 够用，不值得为多版本重写 |
| 版本身份 | `package_hash`（以及 `previous_hash`） | `content_sha256` | **必须改**。`package_hash` 是发布方标签，标签不变而内容变了时识别不出来 |
| 内容判据 | 无 `content_sha256` 列 | 有 | 加一列，见下 |
| `source_updated_at` | `TEXT` | 毫秒整数 | 保持 `TEXT`（ISO 8601），展示用；不要和库里的毫秒整数混 |

**004 迁移（PM 已批准）**：

```sql
ALTER TABLE default_profile ADD COLUMN content_sha256          TEXT NOT NULL DEFAULT '';
ALTER TABLE default_profile ADD COLUMN previous_content_sha256 TEXT;
```

> ⚠️ **`content_sha256` 必须带 `DEFAULT ''`，否则迁移会让应用起不来。**
> SQLite 给**已有数据的表**加 `NOT NULL` 列时，如果没给默认值会直接报错：
> `Cannot add a NOT NULL column with default value NULL`。
> 实测：空表 + 无 DEFAULT 可以过；有 1 行数据 + 无 DEFAULT 就失败。
> `default_profile` 是单行表，任何拉取过一次默认配置的机器上都有一行 —— 部署到那样的机器上就是迁移失败、应用无法启动。
> `DEFAULT ''` 之后，「空串」本身就是「还没算过」的标记，语义正好对得上。

然后：

- 「是否是新版本」只比 `content_sha256`，**不比** `package_hash`。
- 回滚时 `content_sha256` / `previous_content_sha256` 一起翻。
- `package_hash` / `previous_hash` 继续展示，不参与任何判断。
- 迁移后 `content_sha256 = ''` → 下一次刷新视为「必须重新拉一次并计算」，这是预期行为，不要把它当成"没有变化"而跳过。

> 结论：**不推翻 003，只补两列 + 换判据**。重写表结构的代价远大于收益，而缺 `content_sha256` 会让「标签没变但内容换了」这种情况永远检测不到。


---

## 12. LLM Provider 装配（R32）

### 12.1 存储：为什么拆成三处

| 位置 | 内容 | 理由 |
|---|---|---|
| `settings.llm_providers` | provider 的非敏感字段（id / name / protocol / base_url / model）JSON 数组 | 明文可读，便于排查；不含任何密钥 |
| `settings.llm_active_provider` | 当前 provider_id | 单值，改它比改数组便宜 |
| `secrets.enc` 的 `provider:<provider_id>` | 该 provider 的 Key | **复用已有约定**：内置 DeepSeek 现在就是 `provider:deepseek`（`secrets/mod.rs:34`），不为新功能另起前缀 |

**不把 Key 放进 settings 的 JSON 里，哪怕「只是一个字段」**：settings 是明文 SQLite，一旦放了，前面所有关于 `secrets.enc` 的设计全部作废。

### 12.2 装配路径

两种协议的两条路，**都必须同时写 `provider_configs`**。

#### openai 兼容

```rust
let base = normalize_base(user_base.unwrap_or("https://api.openai.com"));
let provider = OpenAiProvider::new(key).with_base_url(base.clone());
registry.register(Arc::new(provider));
registry.set_default(ProviderId::OPENAI);

core_config.provider = Some("openai".into());
core_config.provider_configs.insert("openai", ProviderConfig {
    api_key: Some(key.clone()),
    api_base: Some(base),
    ..Default::default()
});
```

> **为什么两处都要写**：claurst 在 `provider != "anthropic"` 时走 `ProviderRegistry` 分派；如果 `provider_configs` 里没有对应条目，它会**用默认地址重建一个空 Key 的 provider**。现象是「配置看着都对，请求却打到了 api.openai.com 并 401」。这个坑在 `claurst_session/provider.rs:1-5` 的注释里已经记录过一次，不要再踩。

#### anthropic 兼容

```rust
let base = normalize_base(user_base.unwrap_or("https://api.anthropic.com"));
let client = AnthropicClient::new(ClientConfig {
    api_key: key,
    api_base: base.clone(),
    provider: Provider::Anthropic,
    request_timeout: Duration::from_secs(120),
    ..Default::default()
})?;
core_config.provider = Some("anthropic".into());
core_config.provider_configs.insert("anthropic", ProviderConfig { api_key: Some(key), api_base: Some(base), ..Default::default() });
```

> `core_config.provider` 的具体取值与 `provider_configs` 的键名需要在实现时对齐一次（现有代码只有 openai 一条路），**不要照抄猜的字符串**。

#### base 规范化（两种协议共用）

```
trim → 去掉末尾所有 '/' → 若以 "/v1" 结尾则去掉
```

理由：客户端自己会拼 `/v1/chat/completions`（openai）与 `/v1/messages`（anthropic）。用户填 `https://api.deepseek.com/v1` 时，不去掉就是 `/v1/v1/...`，现象是 404，而用户会以为是自己端点填错了。

### 12.3 本地端点（Ollama，可无 Key）

- `base_url` 必须是 `http://127.0.0.1:<port>` / `http://localhost:<port>` / `http://[::1]:<port>`（校验见 `commands.md` §3.12 第 6 条）。
- 无 Key 时如何装配**需要实测确定**：`OpenAiProvider::new("")` 是否接受空串、是否仍会发出 `Authorization: Bearer `。若不接受，用一个固定占位串（例如 `ollama-local`），并且**在日志与错误信息里不打印它**。
- 这一条不要凭猜实现——空 Key 的行为在 claurst 里没有明确契约，先写一个最小验证再定。

### 12.4 测试连接

**必须复用 §12.2 的装配函数产出 provider 对象**，用同一个对象发一个最小请求。另写一套 `reqwest` 直接打 HTTP 测出来的「通」，不能代表对话能通——它绕过了 registry 与 `provider_configs`，恰好绕过的是最容易错的那一步。

| 协议 | 请求 | 说明 |
|---|---|---|
| openai | `POST {base}/v1/chat/completions`，body `{model, messages:[{role:"user",content:"ping"}], max_tokens:1, stream:false}` | 非流式，免得测连接时还要处理 SSE |
| anthropic | `POST {base}/v1/messages`，body `{model, max_tokens:1, messages:[{role:"user",content:"ping"}]}` | 需带 `x-api-key` 与 `anthropic-version`，用 claurst 的 client 会自己处理 |

- `max_tokens: 1` 是刻意的：只为验证鉴权与路由，尽量不消耗用户额度。
- 超时 10 秒。
- `latency_ms` 取**整次请求**耗时（含 DNS/TLS），不是首字节——用户关心的是「要等多久」。

### 12.5 失败映射

`llm_provider_test` **不抛异常**，失败一律 `ok: false` + 脱敏后的 `error`。

| 上游表现 | `error` 文案 | 备注 |
|---|---|---|
| 连不上（DNS / 连接被拒） | 「无法连接到 <host>，检查 Base URL 与网络」 | host 可以显示；不含路径与凭据 |
| 401 / 403 | 「API Key 被拒绝（401）」 | **绝不回显 Key** |
| 404 | 「端点不存在，检查 Base URL 是否兼容 `/v1/chat/completions`」 | 用户最常见的错因 |
| 429 | 「触发了限流，稍后再试」 | |
| 5xx | 「服务端错误（<code>）」 | |
| 超时 | 「请求超时（10s）」 | |
| **200 但不是该协议的结构** | 「返回内容不是该协议的格式，确认『API 类型』选对了」 | 把 anthropic 端点配成 openai 时就是这样：HTTP 全绿，解析全崩 |

最后一行是本设计里最容易被漏掉的判定：**只看状态码会把这类型配置错误判成成功**。

**脱敏是这一节的一部分，不是附注。** 上面那些文案是我们自己写的，风险在上游返回的原文——`error.message` 里经常回显 `Authorization` 头或整个请求体。把上游响应转成文案的函数（例如 `describe_http_error`）必须走同一套规则：先替换该 provider 的实际 Key，再替换任何 `sk-[A-Za-z0-9_-]{8,}` 片段，替换而非整段删除（保留其余信息，用户才看得懂）。日志与 `detail` 字段同样适用。

### 12.6 迁移：只补元数据，密钥原地复用

**现有存储已经是 `provider:deepseek`**（`secrets/mod.rs:34` 的 `PROVIDER_DEEPSEEK`，`get_deepseek_key()` 读的就是它）。

所以这次迁移**一个字节都不碰密钥**。搬一次就多一次丢数据的机会，而这里根本不需要搬 —— 键名本来就对。

触发：启动时 `settings.llm_providers` 不存在或为空，**且** `secrets.enc` 里能读到 `provider:deepseek`。

```
1. 读 provider:deepseek，确认存在
2. settings.llm_providers := [{
     provider_id: "deepseek", name: "DeepSeek",
     protocol: "openai", base_url: "https://api.deepseek.com",
     model: "deepseek-chat", is_builtin: true
   }]
3. settings.llm_active_provider := "deepseek"
```

- **幂等判据是 `provider_id`**：`llm_providers` 里已经有 `deepseek` 就跳过。不重复追加，也不重置用户改过的名称/模型。
- **没有 Key 时不建记录**：基础模式在没有 Key 时本来就不该能用。等用户第一次存 Key 时由 §12.7 的 `deepseek_*` 路径补建，列表里不会凭空多一个永远 `has_key:false` 的内置项。
- **失败面很小**：整个过程只写 `settings`，密钥文件不动。写入失败就是没迁移，下次启动重跑。

> 之前的设计写的是「把 `deepseek_key` 搬到 `llm:deepseek` 再删旧键」，那是基于一个错误前提（以为存在独立的 `deepseek_key` 键）。现在按实际情况改正：**能复用就别新造，尤其是密钥。**

### 12.7 与现有 `deepseek_*` 命令的关系

现有的 `deepseek_save_key` / `deepseek_key_status` / `deepseek_clear_key` 三条命令**保留**，语义改为「操作内置 `deepseek` provider」：

- 内部继续直接读写 `provider:deepseek`（现状不变），并在首次保存时确保 `settings.llm_providers` 里有对应的 `deepseek` 记录（`is_builtin: true`）。
- 基础模式（需求 §5.8）复用这三条命令，界面上不出现 provider 概念。
- **不允许**同时维护两套存储——那必然出现「高级模式改了 Key、基础模式还显示旧的」这种状态。

### 12.8 待验证项（实现前先确认，别照猜写）

| # | 项 | 怎么验 |
|---|---|---|
| 1 | `OpenAiProvider::new("")` 是否接受空 Key | 本地起一个不需要鉴权的 mock，看请求头 |
| 2 | `core_config.provider = Some("anthropic")` 是否走对分支 | 打一个 anthropic 兼容 mock，确认命中 `/v1/messages` |
| 3 | 两种协议的 `provider_configs` 键名 | 同上，看实际请求的目标地址 |
| 4 | 空 Key 时是否会发出 `Authorization: Bearer ` | 抓请求头 |

### 12.9 UI 语义：保存 ≠ 设为当前

界面上「已保存」与「设为当前」必须是**两个独立的动作**，不能合成一个按钮，也不能保存后自动切换。

原因和 P1.5 的节点策略是同一条：**不静默改变请求的去向**。

| 用户操作 | 期望结果 |
|---|---|
| 编辑备用 provider（只改模型名）后点保存 | 该 provider 的配置更新；**当前 provider 不变**；正在进行的对话继续用原来的端点 |
| 想把某个 provider 设为当前 | 显式点「设为当前」→ `llm_provider_activate` |
| 全新安装，没有任何 provider | 保存第一个时自动成为当前（否则用户存了 Key 却没有可用 provider） |

这条在验收上也要能区分：H2 的判定是「设为当前之后**新会话**才走新端点」，而不是「保存之后就走」。

> 合成一个按钮的诱惑很大——「保存并设为当前」看起来省一次点击。但它把两个语义不同的操作合并了，用户在编辑备用项时会意外切换流量去向，而且是**没有任何提示的切换**。
