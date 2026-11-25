# 三端客户端技术设计（veyl-cli / Android / iOS）

> 日期：2026-11-25
> 状态：**技术设计，待评审**。只出文档：不改代码、不改契约、不提交。
> 上游：[`client-apps.md`](client-apps.md)（需求）、`docs/tun-architecture-decision.md`、`docs/tun-alternatives-macos.md`、`docs/windows-tun.md`、`docs/design/mobile-export-technical.md`、`docs/design/environments.md`。
> 事实边界：libbox 构建命令取自 `SagerNet/sing-box` 的 `build.yml` 与 `experimental/libbox`（2026-11-25 读取）；Tauri 移动端插件能力取自 `v2.tauri.app/develop/plugins/`（2026-11-25 读取）；仓库内 TUN 常量取自 `src-tauri/src/tun/`。未核实项集中在 §13。

---

## 0. 结论先行

| # | 问题 | 结论 |
|---|---|---|
| 1 | 三个 APP 的关系 | **三个独立工程、三个独立安装包、三个独立数据目录**；不是主客户端的一个模式，也不是一个 Tauri 工程出三个 target |
| 2 | 代码复用方式 | 静态资源（logo / 图标 / 样式 token）直接复制；Rust 隧道层**抽取为仓库内 crate `veyl-tun`**，主客户端与本客户端同时依赖；UI 不复用主客户端的 App 壳（它和 agent / 存储深度耦合） |
| 3 | 每端能否单独跑 | 能。每个目录都有自己的 `package.json`、`src-tauri`、bundle id 与构建命令；共享 crate 在仓库内，属于「同一仓库的库」，不是「同一个应用」 |
| 4 | 配置来源 | 订阅：`GET /v1/mobile/profile`（现有）；本地文件：同形状 sing-box JSON |
| 5 | 配置装配 | 服务端 profile 原样保留 `outbounds` / `dns` / `route` / `rule_set` / `http_clients`；**PC** 重写平台相关的 `inbounds` 并注入自己的 `clash_api`，移动端原样使用（§6.0） |
| 6 | PC 隧道 | 沿用主客户端已跑通形态：随包 sing-box 子进程 + macOS helper / Windows LocalSystem 服务；**标识符全部参数化**，与主客户端并存不冲突 |
| 7 | Android 隧道 | VpnService（Kotlin）+ 自建 `libbox.aar`（`go run ./cmd/internal/build_libbox -target android`，官方 CI 同款命令） |
| 8 | iOS 隧道 | `NEPacketTunnelProvider` + 自建 `Libbox.xcframework`（`build_libbox -target apple`）；配置经 App Group 交给扩展 |
| 9 | 内核版本 | 三端锁定与桌面相同的 sing-box 版本（当前 1.14.4），libbox 必须由同一份源码打出 |
| 10 | 订阅更新 | 启动时、手动刷新、前台每 60 分钟；移动端后台不承诺定时（系统限制），扩展继续用最后一次配置 |
| 11 | 账号体系 | 无。APP 内不登录、不调账户端点，只消费一条带令牌的 URL |
| 12 | 遥测 | 无 |
| 13 | 窗口与后台 | 菜单栏常驻；关闭主界面只隐藏，进程与隧道继续；显式退出先断开再退出；主界面可以整块省略（§3.4） |

---

## 1. 工程形态与「独立」的定义

```
client/
  docs/
    client-apps.md              需求
    client-apps-technical.md    本文
  pc/                           veyl-cli：Windows + macOS
    package.json               独立前端工程
    src/                       React UI（只含轻量客户端需要的页面）
    src-tauri/                 独立 Tauri 工程（bundle id: …veyl.cli）
  Android/                     独立 Tauri 2 Android 工程（…veyl.android）
  iOS/                         独立 Tauri 2 iOS 工程（…veyl.ios）
crates/
  veyl-tun/                    由主客户端 tun/* 抽取，两个应用共用
```

「独立」的判定标准（每条都要满足）：

| 项 | 要求 |
|---|---|
| 构建 | 在各自目录执行 `npm install && npm run tauri build` 即可产出安装包，不需要先构建其它 APP |
| 标识 | 各自独立的 bundle id / applicationId / 应用名 / 数据目录 / 服务名 |
| 安装 | 可与主客户端同时安装、同时运行（§5.2 标识符参数化） |
| 发布 | 各自版本号、各自签名、各自发布渠道 |
| 代码 | 可共享仓库内 crate 与静态资源；**不共享运行时状态**（数据库、配置、令牌互不可见） |

> 共享 `crates/veyl-tun` 不破坏独立性：它是本仓库的库，不是另一个 APP 的进程或数据。若将来要拆仓，`veyl-tun` 可以整体搬走。

---

## 2. 复用清单

### 2.1 直接复制（静态资源，无构建依赖）

| 来源 | 去向 | 说明 |
|---|---|---|
| `src/assets/logo.png` | `client/pc/src/assets/`、`client/Android/src/assets/`、`client/iOS/src/assets/` | 三个 APP 共用同一 logo |
| `build/logo-variants/*` | 同目录 `assets/brand/` | 深色 / 浅色 / 透明底变体 |
| `src-tauri/icons/*` | 各端 `src-tauri/icons/` | 用 `npm run tauri icon <logo>` 重新出各平台尺寸，避免手抄 |
| `src/styles/app.css` 的 token 段 | 各端 `src/styles.css` | 只取颜色、间距、字号、圆角；骨架当前是复制后的硬编码值，不引用主客户端样式 |
| `src/i18n/` 的基建与公共词 | 各端 `src/i18n/` | 只复制轻量客户端用到的 key |
| `src/brand.ts` | `client/pc/src/brand.ts` | 产品名改为 `veyl-cli`，其余引用方式不变 |

**不复用**：`src/App.tsx`、`src/components/AiPanel*`、`src/agent/*`、`src/myservers/*`、`src/state/*`。这些组件依赖主客户端的 agent 协议、节点池与控制面，搬进轻量客户端会把一整套业务拖进来。

### 2.2 Rust 隧道层：抽取 `crates/veyl-tun`

主客户端 `src-tauri/src/tun/` 约 7.2k 行，是平台特权与 TUN 接管的核心，不能复制三份——三份必然漂移，且其中一份会先出安全 bug。

| 模块 | 处理 | 理由 |
|---|---|---|
| `tun/mod.rs`、`tun/backend.rs`、`tun/protocol.rs`、`tun/session.rs`、`tun/privilege.rs` | **移入 `crates/veyl-tun`** | 与平台无关的接管协议与状态机 |
| `tun/windows/*`、`tun/xpc.rs`、`tun/helper_update.rs`、`tun/trust.rs` | **移入**，并把硬编码标识改成配置 | 见 §2.3 |
| `src/bin/veyl-helper`、`src/bin/veyl-service` | **各留一份源码，产出各自的二进制名** | helper 的信任根绑定本 APP 的签名；不能共用同一个可执行文件 |
| `netcfg.rs`（487 行）、`cidr.rs` | **随 `tun` 移入**（tun/mod.rs 与 windows 模块直接引用它们） | 避免跨 crate 依赖 |
| `rules/*`（1.8k 行） | **不搬**：只有 `config/builder.rs` 使用（本地节点池的路由计划），veyl-cli 不生成规则 | 客户端继承服务端下发的规则 |
| `veyl_paths.rs`（39 行） | **不搬**：只被 `runtime/manager.rs` 使用；veyl-cli 自己算数据目录 | 路径是应用属性，不是隧道能力 |
| `runtime/process.rs`（346 行） | **复制后裁剪**（不抽取） | 进程启停逻辑简单；`runtime/manager.rs`（3.2k 行）与 agent / store / catalog 深耦合，不搬 |
| `runtime/health.rs` 的 `DataPlaneGate` 与 `ClashApi` | **移入 `veyl-tun`** | `tun/session.rs` 直接引用 `DataPlaneGate`；`ClashApi` 依赖 `runtime::error`，一并移入或改用 crate 内错误类型。它是节点热切与就绪判定的唯一通道（§3.2 / §3.3） |
| `runtime/manager.rs`、`health.rs` 的其余部分 | **不搬** | 管理器承担节点池、重启、事件与遥测；轻量客户端只要「启动、就绪、切换、停止」 |
| `config/builder.rs` | **不搬**；只复用 `tun::TUN_STACK` / `TUN_MTU` / `SNIFFERS` 等常量 | 输入不同：主客户端从本地节点生成，客户端从服务端 profile 改写 |

抽取方式（对主客户端零行为变化）：

1. 文件 `git mv` 到 `crates/veyl-tun/src/`；
2. 主客户端保留同名模块，内容为 `pub use veyl_tun::*;` 与必要的 `pub mod windows { pub use … }`，保证主客户端现有的 `crate::tun::…` 引用路径不变；
3. 主客户端 `runtime/health.rs` 保留 `pub use veyl_tun::health::{ClashApi, DataPlaneGate};`，原有 `crate::runtime::health::…` 引用同样不变；
4. 主客户端 `Cargo.toml` 加 `veyl-tun = { path = "../crates/veyl-tun" }`；
5. 抽取期间不调格式、不改实现；跑主客户端全量测试与桌面真机连接作为回归门禁。

### 2.3 必须参数化的硬编码（否则两个 APP 不能并存）

| 常量（现状） | 位置 | 参数化后 |
|---|---|---|
| `PIPE_NAME = \\.\pipe\veyl-helper` | `tun/windows/mod.rs:27` | 由 APP 传入，veyl-cli 用 `\\.\pipe\veyl-cli-helper` |
| `SERVICE_NAME = "VeylService"` | `tun/windows/mod.rs:28` | `VeylCliService` |
| `SERVICE_DISPLAY_NAME` | 同上 | `veyl-cli Privileged Service` |
| `INSTALL_DIR_NAME = "Veyl"` | 同上 | `veyl-cli`（主客户端保持 `Veyl`） |
| macOS launchd label `com.veyl.helper` | `src-tauri/resources/launchd/` | `com.veyl.cli.helper` |
| 信任根（build.rs 嵌入的主程序 sha256） | `src-tauri/build.rs` | 改为由各 APP 自己的 build script 注入 |
| `TUN_ADDRESS_MACOS = 172.19.0.1/30` | `tun/mod.rs:30` | veyl-cli 用独立网段（如 `172.20.0.1/30`），避免两个 APP 同时接管时地址冲突 |
| `TUN_ADDRESS_WINDOWS = 198.18.0.1/15` | `tun/mod.rs:35` | 同上，另选一段（如 `198.20.0.1/16`；不要用 `198.19.0.1/16`，它落在 /15 的范围内） |

> 端口 / 管道 / 服务名的冲突在 Windows 上是**硬失败**：两套 APP 抢同一个服务名时，第二套会认为服务已安装并连到错误的二进制。这不是体验问题，是安全边界问题，抽取时必须一并改掉。

---

## 3. veyl-cli（PC）

### 3.1 工程结构

```
client/pc/
  package.json            name: "veyl-cli"
  vite.config.ts
  src/
    main.tsx
    App.tsx               单窗口：配置列表 + 连接主按钮 + 状态
    components/           ProfileList / ImportDialog / ConnectStage / StatusBar
    i18n/                 复制主客户端基建，只留需要的 key
    styles.css
    assets/logo.png
  src-tauri/
    Cargo.toml            tauri, veyl-tun (path)
    tauri.conf.json       productName: "veyl-cli", identifier: "io.github.aiwithblockchain.veyl.cli"
    src/
      main.rs / lib.rs
      commands.rs         profile_*, connect, disconnect, status
      store.rs            配置持久化（§6.3）
      fetch.rs            订阅拉取（§6.2）
      assemble.rs         profile → 运行时配置（§3.2）
      runtime.rs          随包 sing-box 子进程（裁剪自 runtime/process.rs）
      bin/veyl-cli-helper、bin/veyl-cli-service
    binaries/             随包 sing-box 二进制（构建脚本放置）
```

### 3.2 运行时配置装配

输入是一份 sing-box JSON（订阅或文件）。装配规则：

| 字段 | 处理 |
|---|---|
| `outbounds` | 原样保留；空 / 只有 `direct` 视为零节点 |
| `dns` | 原样保留 |
| `route`（`rules` / `rule_set` / `final` / `auto_detect_interface`） | 原样保留 |
| `http_clients` | 原样保留 |
| `inbounds` | **重写**：只保留一个 TUN 入站，`address` 改成 veyl-cli 专属网段，`stack: "gvisor"`、`mtu: 9000`、`auto_route: true`、`dns_mode: "hijack"`、`dns_address` 由平台常量给出 |
| `experimental` | **重写**：丢弃服务端的值，注入客户端自己的 `clash_api`（`127.0.0.1` + 动态端口 + 随机 secret）。它是节点热切与就绪判定的唯一通道（主客户端同样依赖它，见 `tools/services.rs` 的 `node_switch` / `clash_selector_members`）；端口动态分配，避免与主客户端冲突 |
| `log` | 统一为 `{"level":"warn","timestamp":true}`，日志写应用私有目录 |
| 其它未知字段 | 保留并原样传给内核；由 `sing-box check` 判定 |

装配后必须通过两道校验才允许启动：

1. 结构校验：`outbounds` 非空且至少一个非 `direct`；`route.final` 指向存在的 outbound；`dns.servers[].detour` 指向存在的 outbound（零节点配置不得带 DNS）。
2. 内核校验：用随包 `sing-box check -c <file>`，失败即拒绝连接并显示内核原始错误。

> 为什么不自己拼一份新配置：服务端模板已经过真机验收（TUN、DNS 分流、规则集顺序都有踩坑记录）。客户端只改必须改的字段，其余原样，才能继承那份结论。

### 3.3 连接流程

```
profile 选中
   → assemble（§3.2）→ check
   → 确保特权通道（macOS 授权 helper / Windows 提权安装服务，沿用主客户端流程）
   → 启动 sing-box 子进程（传 runtime config 文件路径）
   → 等待就绪：进程存活 + Clash API `GET /version` 返回 200（≤15 秒）+ 日志无 FATAL；超时转 failed
   → connected
```

- 节点切换（已连接）：Clash API `PUT /proxies/proxy` 热切 selector，不重启进程、不断流；未连接时只改本地选择，下次启动生效。
- 断开：停止子进程、还原 DNS / 路由（沿用 `veyl-tun` 的清理流程），并校验还原结果。
- 退出应用：先走断开流程再退出；`SIGKILL` 场景靠下次启动的残留清理（沿用主客户端 `proxy-crash-cleanup` 的结论）。
- 进程异常退出：状态转 `failed`，保留日志入口。

### 3.4 UI 与窗口生命周期

主界面只保留三个页面/状态：配置列表（含导入入口）、连接主界面、设置（自启、日志、关于）。不做中间对话区、不做右栏、不做节点组。

**主界面可以整块省略**：允许只有菜单栏的形态。若省略，导入、刷新、连接 / 断开、退出必须全部在菜单栏菜单里可达（具体交互交由界面设计）。

窗口与进程规则：

- 关闭主界面 = 隐藏窗口，**不退出应用**；隧道与进程继续运行（`CloseRequested` 拦截后 `hide()`）。
- 菜单栏常驻：显示连接状态；菜单项至少包含「显示主界面 / 连接 / 断开 / 退出」。
- 再次启动应用（Dock、启动台、命令行）应唤回已有实例的窗口，而不是起第二个进程——需要单实例插件。
- 显式「退出」是唯一结束进程的入口：先断开隧道并等待清理完成，再退出；窗口关闭本身不触发断开。
- 菜单栏图标状态与连接状态同源（`connected` / `connecting` / `failed` / `idle`），不能一个显示已连接、另一个显示空闲。

- 配置列表支持重命名与删除；重名允许，用时间戳区分展示；
- 菜单栏：裁剪主客户端 `lifecycle.rs` 的实现（图标状态、显示窗口、退出），去掉节点池与服务器相关的菜单项；关闭窗口的处理与主客户端一致（隐藏而非退出）；
- 开机自启：单独实现（Tauri autostart 能力或平台原生机制），**不复用**主客户端 `proxy-guard` 的 LaunchAgent——那个是端口守卫，语义不同。

视觉沿用主客户端的 token 与 logo；主客户端「浅色为默认」的约束同样适用。

---

## 4. Android

### 4.1 工程形态

Tauri 2 Android 工程 + 一个仓库内插件 `veyl-tunnel`（Kotlin）：

- Rust / TS 侧：订阅拉取、装配、持久化、UI；
- Kotlin 侧：`VpnService` 生命周期、libbox 启动、通知、状态回传。

Tauri 官方文档（2026-11-25 读取）确认：插件可以用 Kotlin 写原生命令，命令默认在主线程执行，长操作必须切到 `Dispatchers.IO`；插件在 WebView 挂起时仍可通过 JNI 调 Rust。隧道启动因此放在 Kotlin 协程里，不占主线程。

### 4.2 libbox

官方构建路径（`SagerNet/sing-box` CI `build.yml`，2026-11-25 读取）：

```
make lib_install
export PATH="$PATH:$(go env GOPATH)/bin"
go run ./cmd/internal/build_libbox -target android -platform android/<abi>
# 产出 libbox.aar / libbox-legacy.aar，多 ABI 用 merge_aar 合并
```

- 版本锁定与桌面一致（当前 1.14.4），从同一 tag 的源码构建；
- AAR 由 CI 从锁定 tag 构建后放到 `client/Android/src-tauri/gen/android/app/libs/libbox.aar`（SFA 的 `build.gradle.kts` 同样以 `files("libs/libbox.aar")` 引用，二进制不随源码提交）；仓库只记录版本、构建命令与 sha256；
- NDK 版本、Go 版本写进构建脚本并在 CI 固定。

### 4.3 VpnService 生命周期

```
JS 点连接 → Tauri command → Kotlin plugin
  → 检查/请求 VpnService 授权（系统弹窗）
  → startForeground（常驻通知：状态 + 断开）
  → libbox 启动（配置字符串由 Rust 传入）
  → 状态事件回传 JS
断开 → libbox 停止 → stopForeground → 服务停止
```

- 配置以字符串传入，不落公共存储；
- 配置装配：**直接使用服务端 profile**（含 TUN 入站、DNS、分流），不重写；节点切换在 M1 采用「改写 selector 默认节点 + 重启 VpnService」，不做热切（libbox 的 command server 热切能力待核实，§13 #11）；
- 进程被杀后由 Android 重启策略决定；重启时没有用户配置上下文则保持断开，不自动重连（避免静默连上旧配置）；
- 前台服务类型与 Android 14+ 的声明要求**待核实**（§13 #4）。

### 4.4 UI

一个主界面 + 配置列表 + 设置。移动端不做桌面式的连接舞台，只保留状态、主按钮、节点名与入口。

---

## 5. iOS

### 5.1 工程形态

Tauri 2 iOS 主 App + 一个 `NEPacketTunnelProvider` 扩展 target：

```
主 App（Tauri + React）
  ├─ Rust：订阅拉取、装配、持久化
  ├─ 写配置到 App Group 容器
  └─ NEVPNManager：安装 / 启动 / 停止隧道
扩展（Swift）
  └─ NEPacketTunnelProvider + Libbox.xcframework
```

- 主 App 与扩展通过 App Group（共享 UserDefaults + 文件）交换配置与状态；
- 扩展**不跑 Tauri、不跑 Rust 业务层**：appex 内存与依赖都受限，只做 libbox 宿主；
- `NEVPNStatus` 是状态的唯一来源；主 App 订阅通知并转成前端事件。

### 5.2 Libbox.xcframework

官方构建路径（同上 `build.yml`）：

```
make lib_install
go run ./cmd/internal/build_libbox -target apple -platform <platform>
# 产出 Libbox.xcframework
```

- `platform` 取值按官方矩阵（iOS device / simulator），构建脚本里固定；
- 版本与桌面一致；xcframework 提交进仓库或由 CI 产出并带 sha256；
- 扩展 target 需 Network Extension entitlement（`packet-tunnel-provider`）。`tun-alternatives-macos.md` 记录的是 macOS 侧的自助能力；**iOS 侧需以 Apple 官方文档核实**，上架可行性仍未定（需求 §12 R1）。

### 5.3 配置交接

1. 主 App 拉取 → 装配 → 写 `config.json` 到 App Group；
2. `NEVPNManager` 保存的 provider configuration 里只放「配置在 App Group 的路径」这类非敏感引用；
3. 扩展启动 → 读配置 → libbox 启动 → 状态写回共享 UserDefaults；
4. 主 App 前台刷新订阅后，若隧道在运行，是否热更新由内核能力决定；**M1 采用「保存新配置，下次连接生效」**，不承诺运行中热切换。
5. 配置装配与 Android 相同：原样使用服务端 profile；节点切换 = 改写 selector 后重启隧道（M1）。

### 5.4 已知限制

- 扩展内存上限严格（具体数值按 Apple 当前文档核实），规则集与节点多时要注意；
- 后台刷新不可靠，自动更新只在前台发生；
- 主 App 被系统回收后扩展仍可维持隧道，但状态回传会延迟到下次打开。

---

## 6. 订阅、配置与存储（三端一致）

### 6.0 三端装配矩阵

| 端 | 输入 | `inbounds` | `experimental` | 节点切换 | 就绪判定 |
|---|---|---|---|---|---|
| veyl-cli | 订阅 / 文件 | 重写为 veyl-cli 专属网段（§3.2） | 注入自己的 `clash_api` | Clash API selector 热切 | 进程 + `GET /version` |
| Android | 订阅 / 文件 | **原样使用**服务端 TUN 入站（与官方客户端同构，已真机验收） | 丢弃（服务端 profile 本就没有） | M1：改写 selector 后重启 VpnService | VpnService + libbox 启动结果 |
| iOS | 订阅 / 文件 | **原样使用** | 丢弃 | M1：改写 selector 后重启隧道 | `NEVPNStatus` |

零节点（没有代理 outbound）三端一致：不建立 TUN、不允许连接。

> 文件来源没有 TUN 入站时（用户自备配置），客户端按服务端模板补一个最小 TUN 入站；不补就是「已连接但流量为 0」——这条是 `mobile-export-technical.md` §3.5 的真机结论，不是推测。
>
> 移动端节点切换的「改写 selector」= 把 `outbounds` 中 `type: "selector"` 的 `default` 改成目标节点 tag；不改节点集合。

### 6.1 数据模型

```ts
type Profile = {
  id: string;                 // uuid
  name: string;               // 默认取 URL 的 host 或文件名，可改
  source:
    | { kind: "subscription"; url: string }   // 含令牌，敏感
    | { kind: "file"; path: string };         // 导入时的本地副本路径
  node_count: number;         // 最近一次成功解析的代理节点数
  last_synced_at: number | null;
  sync_state: "ok" | "failed" | "unauthorized" | "never";
  sync_error: string | null;  // 只放可读原因，不放 URL
  created_at: number;
};
```

- 多条配置并存；同一时刻只有一条是「当前」；
- `file` 来源的 `sync_state` 固定为 `never`，不参与自动更新；
- `source.url` 是敏感字段，读取时解密，日志与事件里永久打码。

### 6.2 拉取规则

| 项 | 规则 |
|---|---|
| 方法 | `GET`，`Authorization: Basic base64("veyl:<token>")`（从 URL 的 userinfo 取；用户名固定 `veyl`） |
| 超时 | 连接 10s / 总 20s |
| 大小上限 | 512 KiB（当前 profile 约几 KB；超过视为异常） |
| 重定向 | 不跟随（服务端无重定向；跟随会把 Authorization 带到别的主机） |
| 状态映射 | 401 → `unauthorized`（停止更新，**保持当前隧道直到用户断开**）；403 → `sync_error`（账户停用）；429 → 按 `Retry-After` 退避；5xx / 网络 → `failed`，保留旧配置 |
| 解析 | JSON → 校验结构（§3.2 / §6.0）→ 记 `node_count` |
| 更新节奏 | 启动时；手动刷新；前台每 60 分钟；移动端后台不承诺 |
| 更新与连接 | 拉取成功后先保存，**下次连接生效**；运行中不热替换整份配置（PC 的节点热切只切 selector，不换配置）。PC 后续可做「重启并恢复」 |
| 文件来源 | 永不自动更新；只有「重新导入」才会换内容 |
| 桌面导出 | **已实现** `mobile_export_save_file`（`commands.md` §7.34）：取回与订阅同形的 profile 并写入用户选择的绝对路径；veyl-cli 侧的文件导入仍待实现 |
| 并发 | 同一配置同时只允许一个拉取；后到的请求复用进行中的结果 |

### 6.3 存储与密钥

| 平台 | 配置元数据 | 令牌（URL） |
|---|---|---|
| macOS | 应用支持目录 JSON | Keychain（`keyring` crate，service = bundle id） |
| Windows | `%APPDATA%\veyl-cli\` JSON | Windows Credential Manager（同一 crate） |
| Android | 应用私有目录 JSON | Android Keystore 加密后落盘（经 Kotlin 插件） |
| iOS | 应用沙盒 JSON | Keychain（App 与扩展共享访问组） |

- 本地文件导入：复制到应用私有目录，不引用原路径；导入成功提示可删除源文件；
- 配置与令牌互不共享：三个 APP 各自独立，主客户端看不到它们的配置。

---

## 7. 应用内命令与事件

每端内部接口一致（不作为对外契约）：

```
profiles_list() -> Profile[]
profile_import_url(url) -> Profile
profile_import_file(path) -> Profile
profile_refresh(id) -> Profile
profile_rename(id, name) -> Profile
profile_remove(id) -> void
profile_select(id) -> void
connect() -> void
disconnect() -> void
connection_status() -> { state, since, node, last_error }
logs_open() -> void
```

事件：`connection-changed`、`profiles-changed`、`sync-changed`。字段里不得出现完整 URL 或令牌。

---

## 8. 失败处理

| 情况 | 表现 | 允许的动作 |
|---|---|---|
| 401 / 令牌轮换 | 配置标记「链接已失效」，保留节点但不可更新；**当前隧道保持到用户断开** | 重新粘贴链接 / 删除配置 |
| 403 账户停用 | 同上，文案区分 | 同上 |
| 429 | 显示「稍后再试」并退避 | 等待 / 手动重试 |
| 网络失败 | 保留旧配置，标记「上次同步失败」 | 重试 / 继续用旧配置 |
| 配置格式错误 | 拒绝导入，显示内核或结构校验的第一条错误 | 重新导入 |
| 零节点 | 连接按钮禁用，说明「没有可用节点」 | 刷新 / 回桌面检查服务器 |
| 特权/服务未就绪 | 连接失败，给出「授权 / 安装服务」入口 | 重试授权 |
| VPN 授权被拒（移动端） | 说明是权限问题，不是网络故障 | 去系统设置 |
| 扩展启动失败（iOS） | 显示系统错误码 | 重试 / 查看日志 |

---

## 9. 安全

| 项 | 规则 |
|---|---|
| 令牌 | 只存在于 URL；落盘必须加密；不写日志、不进崩溃报告、不进界面文本 |
| 日志 | 只记事件、状态码、耗时；URL 统一打码为 `https://veyl:***@host/path` |
| 配置内容 | 含节点密码；只写应用私有目录，权限 0600 |
| 本地文件 | 导入后复制并提示删除源文件；不主动删除用户文件 |
| 特权 | 沿用主客户端的信任根模型；veyl-cli 的 helper 只认 veyl-cli 自己的签名 |
| 并存 | 两个 APP 的 TUN 同时开启时，地址段、路由与 DNS 的冲突由参数化隔离；不提供「同时连接」的保证 |
| GPL | sing-box 为 GPL-3.0；LICENSE 无 App Store 例外条款，另有「不得暗示与上游关联」的限制。内嵌 libbox / 随包二进制对外分发需履行源码义务；SFI 本身在 App Store 分发属既有先例，不等于我们无风险。**合规方式与 iOS 上架的法务结论待确认**（§13 #6） |

---

## 10. 测试

| 层 | 内容 |
|---|---|
| 单元 | URL userinfo 解析、令牌打码、装配规则（含零节点、缺 `route.final`、悬空 `detour`）、就绪判定、状态机 |
| Golden | 用随包 sing-box 对装配结果跑 `check`；样本覆盖：服务端真实形状、本地任意配置、零节点、中文节点名、无 TUN 入站的自备配置 |
| 前端 | vitest：导入弹层、状态渲染、错误文案 |
| 集成 | PC：真机连接、断开、退出、节点热切、DNS 还原、关窗后进程与隧道保持、从菜单栏唤回窗口；Android：授权、连接、杀进程、重启、节点切换；iOS：NE 安装、连接、扩展被回收、节点切换 |
| 验收 | 需求文档 CA-1…CA-13；三端各跑一遍；iOS 需签名版与 TestFlight 版各一次 |

---

## 11. 分发与签名

| 端 | 产物 | 要点 |
|---|---|---|
| veyl-cli / Windows | NSIS `currentUser` 安装包 | 不要求管理员；首次需要 TUN 时提权安装服务；Authenticode 签名 |
| veyl-cli / macOS | `.app` + `.dmg` | Developer ID + 公证；helper 单独签名并被信任根校验 |
| Android | APK / AAB | 应用签名；商店政策与资质待核实；包内含 libbox（GPL） |
| iOS | IPA | NE entitlement；商店上架可行性是前置（需求 §12 R1） |

安装包体积需实测（sing-box / libbox + 规则集 + Tauri 运行时）；移动端超过阈值时按 ABI / 架构裁剪。

---

## 12. 里程碑

| 阶段 | 内容 | 出口条件 |
|---|---|---|
| **M0** | 抽取 `crates/veyl-tun` + 标识符参数化 | 主客户端行为不变，全量测试与桌面真机连接通过；交叉 review |
| **M1** | `client/pc`（veyl-cli） | CA-1…CA-9、CA-11、CA-13 在 Windows + macOS 通过 |
| **M2** | `client/Android` | 授权、连接、重启、零节点、令牌轮换通过；商店材料就绪 |
| **M3** | `client/iOS` | 前置 R1 有结论；CA 全项通过 |

M0 是唯一会动主客户端的阶段，必须单独一批、单独 review、单独提交；不与任何功能改动混在一起。

---

## 13. 待确认 / 待核实

| # | 事项 | 现状 |
|---|---|---|
| 1 | `veyl-cli` 的形态 | **已定**：图形客户端，产品名 `veyl-cli`（2026-11-25）；若后续要纯命令行形态，去掉 React 层即可，Rust 侧不变 |
| 2 | 抽取 `veyl-tun` 的边界是否一次到位 | `netcfg` / `cidr` / `runtime::health` 的 `DataPlaneGate` 与 `ClashApi` 是 `tun` 的必需依赖，必须一起搬；`rules` 不搬。若 `health` 的耦合仍有意外，退路是在 `veyl-tun` 里定义最小 trait、由主客户端实现，而不是复制实现 |
| 3 | Tauri 2 移动端当前版本在 Android / iOS 的已知限制 | 已核实插件可写 Kotlin/Swift、命令默认主线程；**版本在 M0 前锁定并写入文档**，真机验证在 M2 / M3 |
| 4 | Android 前台服务类型（Android 14+）与 VpnService 的声明要求 | 按官方文档核实后再写 manifest |
| 5 | iOS 扩展内存上限与 NE 热更新能力 | 按 Apple 文档与真机实测；M1 不承诺运行中热切换 |
| 6 | GPL-3.0 合规方式（内嵌 libbox 与随包二进制） | 待法务确认；不凭印象下结论 |
| 7 | 两套 APP 同时开启 TUN 的行为 | 本文只保证标识符与地址段隔离；不保证双隧道并存可用，需真机验证并写入验收 |
| 8 | 安装包体积与启动耗时 | 构建后实测 |
| 9 | 主客户端与 veyl-cli 是否共享自动更新机制 | 本文不做自动更新；版本更新走手动下载 |
| 10 | Android 的 minSdk 与 ABI 清单 | libbox 的 ABI 覆盖与目标 minSdk 在 M2 前锁定；决定安装包体积与商店兼容范围 |
| 11 | 移动端节点热切（libbox command server） | M1 用「改写 selector + 重启」，不依赖该能力；M2 核实是否可用，可用再升级为热切 |
| 12 | 无主界面形态下的导入入口 | 菜单栏 + 系统文件对话框，还是保留一个最小窗口？M1 先保留主界面；是否整块去掉由界面设计定 |
