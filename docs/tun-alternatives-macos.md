# macOS TUN 两条路：root helper vs NetworkExtension

> 2026-11-05 · 只做事实核对与代价评估。
> 参照实现：`/Users/wesley/ai/openmesh-cli/openmesh-apple/`（下称 openmesh）。
> 本文**不下最终结论**；「要不要换」由架构师与 PM 裁决。
>
> 一句话：`docs/tun-mode.md` §4 里「NetworkExtension 需要 Apple 授权 entitlement，门槛过高」这个前提，
> 对 `packet-tunnel-provider` 来说**今天不成立**（是自助开通，不是审批）；
> 但换成 NetworkExtension 的代价不在授权，在**运行时架构和打包链路**，那是另一笔账。

---

## 1. openmesh 的两种模式分别是什么

### 1.1 模式 A：应用级 NetworkExtension（appex）

| 项 | 值 | 依据 |
|---|---|---|
| 产物 | `vpn_extension_macos.appex`，嵌在主 App 的 `Contents/PlugIns/` | `MeshFlux.xcodeproj/project.pbxproj:31`、`:190-198`（Embed Foundation Extensions） |
| 扩展点 | `com.apple.networkextension.packet-tunnel` | `vpn_extension_macos/Info.plist:25-28` |
| 实现 | `class ExtensionProvider: NEPacketTunnelProvider` | `vpn_extension_macos/PacketTunnelProvider.swift:11` |
| entitlement | `com.apple.developer.networking.networkextension = [packet-tunnel-provider]` + App Sandbox + App Group | `vpn_extension_macos/vpn_extension_macos.entitlements:5-12` |
| 宿主 App | `MeshFluxMac`（`com.meshnetprotocol.OpenMesh.mac`） | `project.pbxproj:1395` |
| 分发定位 | **Mac App Store 路线**（TN3134 把 app extension 与 system extension 都列为 packet tunnel 的合法包装；但 Developer ID 直接分发时，DTS 与社区一致的做法是必须走系统扩展，见 §3.5） | — |

### 1.2 模式 B：系统级 NetworkExtension（system extension）

| 项 | 值 | 依据 |
|---|---|---|
| 产物 | `com.meshnetprotocol.OpenMesh.macsys.vpn-extension.systemextension`，嵌在容器 App 的 `Contents/Library/SystemExtensions/` | `project.pbxproj:11`、`:113-121`（Embed System Extensions） |
| 包类型 | `CFBundlePackageType = SYSX`，`NetworkExtension.NEMachServiceName` | `vpn_extension_macx/Info.plist:13-26` |
| 入口 | `NEProvider.startSystemExtensionMode()` + `dispatchMain()` | `vpn_extension_macx/main.swift:4-8` |
| entitlement（扩展） | `packet-tunnel-provider-systemextension`、`com.apple.developer.team-identifier`、`com.apple.application-identifier`、App Group；`app-sandbox = false` | `vpn_extension_macx/OpenMesh_Sys_ext.entitlements:5-22` |
| entitlement（容器 App） | `packet-tunnel-provider-systemextension` + `com.apple.developer.system-extension.install` | `MeshFlux.sys/OpenMesh.Sys.entitlements:5-20` |
| 安装方式 | `OSSystemExtensionRequest.activationRequest(forExtensionWithIdentifier:queue:)`，用户批准后由系统装载 | `MeshFlux.sys/SystemExtensionManager.swift:117-127` |
| 分发定位 | **Developer ID / DMG 路线**（签名见 §2.2） | — |

### 1.3 提权路径：为什么不需要自建 root helper

关键在**谁做特权的那些事**：

- 创建 utun、装 IPv4/IPv6 地址、写路由、设 DNS，这些由 **NetworkExtension 框架**替我们做。扩展只需要构造一个 `NEPacketTunnelNetworkSettings`，调用 `setTunnelNetworkSettings(...)`。
  openmesh 的 `LibboxSupport.swift:154-240` 就是把这套设置填好：`NEIPv4Settings` / `includedRoutes` / `excludedRoutes` / `NEDNSSettings` / `mtu`。
- 内核交回一个**已经建好的 tun 文件描述符**，扩展通过 `NEPacketTunnelFlow` 把它交给 sing-box（openmesh 调 libbox 的 `openTun(options)` 拿 fd）。
- 扩展进程由系统（`nesessionmanager` / `containermanagerd`）按 entitlement 启动，**不是我们的 App 拉起来的**，所以 App 不需要 root，也不需要自建 XPC 通道。

两种模式的运行身份不同：

| | appex（模式 A） | sysext（模式 B） |
|---|---|---|
| 进程身份 | 用户会话内 | **root，但跑在受限沙箱里**（openmesh 在 `vpn_extension_macx/PacketTunnelProvider.swift:29-31` 的注释里明确写了这一点） |
| 生命周期 | 随用户会话 | 系统级，注销后仍可存活（取决于配置） |

也就是说：**「不需要 root helper」是真的，但不是「不需要特权」**——特权从「我们自己的 root 二进制」变成了「系统托管的 root 扩展进程」。信任根从我们的签名校验，换成了 Apple 的 entitlement 校验。

### 1.4 两种模式一览

```
模式 A（appex，App Store）
  MeshFluxMac.app
    └── Contents/PlugIns/vpn_extension_macos.appex   ← Apple Development 签名（开发时）
         ent: packet-tunnel-provider
         NEPacketTunnelProvider → libbox → sing-box

模式 B（sysext，Developer ID）
  MeshFlux.sys.app
    ├── Contents/Library/SystemExtensions/...systemextension   ← Developer ID 签名
    │    ent: packet-tunnel-provider-systemextension
    └── 用 OSSystemExtensionRequest 激活，用户在系统设置里批准
```

---

## 2. 为什么 Debug 能跑

### 2.1 具体配置（全部来自 pbxproj）

| Target | CODE_SIGN_IDENTITY | CODE_SIGN_STYLE | TEAM | PROVISIONING_PROFILE_SPECIFIER | Bundle ID |
|---|---|---|---|---|---|
| `MeshFluxMac`（模式 A 宿主） | `Apple Development` | Automatic | `2XYK8RBB6M` | 空（自动生成） | `com.meshnetprotocol.OpenMesh.mac` |
| `vpn_extension_macos`（模式 A 扩展） | `Apple Development` | Automatic | `2XYK8RBB6M` | 空（自动生成） | `…OpenMesh.mac.vpn-extension` |
| `MeshFlux.sys`（模式 B 宿主） | `Developer ID Application` | Manual | `2XYK8RBB6M` | `openmesh_mac_main_app` | `com.meshnetprotocol.OpenMesh.macsys` |
| `vpn_extension_macx`（模式 B 扩展） | `Developer ID Application` | Manual | `2XYK8RBB6M` | `openmesh_mac_extension` | `…macsys.vpn-extension` |

依据：`project.pbxproj:1365-1399`、`:1461-1495`（模式 A，Debug/Release 两段设置相同）、`:919-949`、`:1008-1036`（模式 B）。

本机钥匙串里能找到的实际 profile（只看名字，不导出内容）：

- 模式 A：`Mac Team Provisioning Profile: com.meshnetprotocol.OpenMesh.mac` 与 `…mac.vpn-extension`，**含 `ProvisionedDevices`**，2027-10 到期；
- 模式 B：`openmesh_mac_main_app` / `openmesh_mac_extension`（Developer ID profile，2044 到期），另有 `debug_openmesh_mac_app` / `debug_openmesh_mac_extension` 两份带 `ProvisionedDevices` 的调试版。

这几份 profile 的 `Entitlements` 里都有
`com.apple.developer.networking.networkextension`，模式 B 的两份还带 `com.apple.developer.system-extension.install`。

### 2.2 结论：Debug 不是「绕过签名」，而是「用开发证书签了一个真正的 bundle」

- **Debug 与 Release 的签名设置完全一样**（pbxproj 里两个 configuration 块的值逐项相同）。区别只在 `.app` 里的二进制是 debug 还是 release。
- 模式 A 用 `Apple Development` + 自动签名，Xcode 自动生成带 `ProvisionedDevices` 的开发 profile，**把 NetworkExtension 权限一起带进去**。所以它能跑，前提是这台 Mac 已注册在该团队下。
- 模式 B 用 Developer ID + 手写 profile。`xcodebuild -scheme MeshFlux.sys -configuration Debug build`（`MeshFlux.sys/功能对齐工作计划.md:486`）出来的是**同样用 Developer ID 签名、带 profile 的包**，Debug 只影响优化与调试符号。

### 2.3 这些都依赖 `com.apple.developer.networking.networkextension` 吗

**是。** 两种模式的扩展都靠这个 entitlement 才能启动。它不是一个可以绕开的开关：

- 没有它，`NEPacketTunnelProvider` 不会被系统装载；
- 它必须同时出现在 **entitlements 文件**与**签名用的 provisioning profile** 里，两边不一致会直接报
  `Provisioning profile doesn't match the entitlements file's value for com.apple.developer.networking.networkextension`。

**但这个权限对 `packet-tunnel-provider` 是自助开通的**：在开发者门户给 App ID 勾上 Network Extensions 能力（或让 Xcode 自动签名去做），不需要提交审批表。需要 Apple 人工审批的是 Hotspot Helper、NE app push 之类的类型，以及证书/描述文件本身出问题时的支持介入。

### 2.4 一个必须说清的边界

「Debug 能跑」**不等于**「`tauri dev` 能跑」。

openmesh 能跑，是因为它跑的是 **Xcode 产出的、已签名、内嵌扩展的 `.app`**。我们现在的 `tauri dev` 产出的是 `target/debug/veyl` 裸二进制，连 bundle 都不是，NetworkExtension 这条路一样不认。换成 NE 之后，本地要跑仍然得先出一个签名包（只是不再需要 SMAppService 的后台助手批准）。

---

## 3. 对照我们 `docs/tun-mode.md` §4 的判断

### 3.1 原文

`docs/tun-mode.md:59`：

> 不采用 NetworkExtension：需要 Apple 授权 entitlement，门槛过高

### 3.2 逐句复核

| 原判断 | 事实 | 结论 |
|---|---|---|
| 「需要 Apple 授权 entitlement」 | `packet-tunnel-provider` 是**自助能力**，门户勾选即可；openmesh 团队（与我们是**同一个 Team，2XYK8RBB6M**）已经拿到了这个能力，并已生成 Developer ID profile | **不成立（或已过时）** |
| 「门槛过高」 | 授权不是门槛；真正的门槛是下面 §3.4/§3.5 的工程与打包改造 | **表述不准，但结论未必错** |

补充一个容易被忽略的事实：**同一个 Team ID 下已经有可用的 Developer ID provisioning profile**（`openmesh_mac_main_app` / `openmesh_mac_extension`，2044 到期）。这意味着「团队能不能建出带 NE 权限的 Developer ID profile」这个问题已经有现成答案。给我们的新 bundle id 开能力、建 profile，属于同一套流程。

### 3.3 如果换成 NetworkExtension，我们的 entitlement 与流程

要申请/开启的是：

| 位置 | entitlement | 说明 |
|---|---|---|
| 容器 App | `com.apple.developer.system-extension.install` | 允许 App 安装系统扩展（模式 B） |
| 扩展 | `com.apple.developer.networking.networkextension = [packet-tunnel-provider-systemextension]` | 模式 B：Developer ID 分发 |
| 扩展 | `…= [packet-tunnel-provider]` | 模式 A：仅 App Store / 开发态 |
| 两者 | `com.apple.developer.team-identifier`、`com.apple.application-identifier`、App Group | 与 profile 对齐 |

流程大致是：

1. 在开发者门户给 `io.github.aiwithblockchain.veyl` 与 `io.github.aiwithblockchain.veyl.tun-extension` 建 App ID；
2. 给两个 App ID 勾上 **Network Extensions**（模式 B 还要勾 **System Extension**）能力；
3. 生成两份 **Developer ID** provisioning profile（容器 App + 扩展）；
4. 签名由内向外：先签扩展，再签 App，然后公证 + staple；
5. 首次运行时由 App 发起安装（模式 A：`NETunnelProviderManager` 保存配置；模式 B：`OSSystemExtensionRequest`），用户批准一次。

风险点：Developer ID + NE 权限的 profile 在门户里偶尔会建不出来，需要联系 Apple 支持（论坛上有多例）。我们团队既然已经有两份，概率不高，但这是外部依赖。

### 3.4 代码上要改什么

| 我们的模块 | 换成 NE 后的命运 | 说明 |
|---|---|---|
| `src-tauri/src/tun/mod.rs`（排除表、ifconfig 解析） | **可复用** | 排除网段仍要算，只是最后由 Swift 侧填进 `NEIPv4Settings.excludedRoutes`（对照 `LibboxSupport.swift:203-215`） |
| `src-tauri/src/config/builder.rs` 的 TUN inbound | **可复用（有前提）** | sing-box 仍然吃 `{"type":"tun","address":…,"auto_route":true,"route_exclude_address":[…]}`；libbox 的 `openTun` 会把这些选项翻译成 `NEPacketTunnelNetworkSettings`（`LibboxSupport.swift:150-240`）。前提是我们接受 libbox 的运行方式 |
| `src-tauri/src/rules/plan.rs` | **可复用** | 分流与 DNS 方案不变 |
| `src-tauri/src/tun/protocol.rs`（配置白名单/改写） | **大部分作废** | 信任边界从「我们验 App 的签名」变成「系统只装载已签名的扩展」；500+ 行白名单不再是必要的防线（但仍可作为纵深防御保留） |
| `src-tauri/src/tun/privilege*.rs`、`session.rs`、`xpc.rs`、`trust.rs` | **作废** | 由 `NETunnelProviderManager` / `OSSystemExtensionRequest` / `NEVPNStatus` 替代 |
| `src-tauri/src/bin/veyl-helper/` | **作废** | 约 1200 行 root 代码，连同 LaunchDaemon、验签、孤儿清理一起删 |
| `src-tauri/src/runtime/manager.rs` | **要改** | 现在管理「子进程 + Clash API」。NE 下没有我们自己的子进程；状态来自 `NEVPNStatus`，流量/延迟要么走 libbox 的 command server（openmesh 的做法），要么看 libbox 是否仍允许 `experimental.clash_api`（**未验证**） |
| `src-tauri/src/runtime/health.rs` | **可能可复用** | 如果 libbox 里 `experimental.clash_api` 仍能监听回环端口，`ClashApi` 客户端与 `connection_sample` 可原样保留；否则要换协议 |
| **新增：Swift provider** | **必须新写** | openmesh 的体量可作参考：appex 的 `PacketTunnelProvider.swift` 1057 行 + `LibboxSupport.swift` 418 行；sysext 版 1250 + 556 行（含各自的分流逻辑） |
| **新增：libbox 构建链** | **必须新写** | 我们目前分发的是 sing-box **二进制**；NE 扩展里不能 `exec` 它（appex 明确不支持，sysext 的沙箱也没有这个先例），openmesh 用的是 gomobile 打出来的 `OpenMeshGo.xcframework`。需要固定 sing-box 版本、Go 工具链、universal xcframework、许可证合规 |
| **打包** | **要改** | `scripts/packaging/build-dmg.sh` 需要新增：构建扩展 → 放进 `Contents/PlugIns/`（A）或 `Contents/Library/SystemExtensions/`（B）→ 由内向外签名 → 两套 profile → 公证。Tauri 不会替我们做这些 |

一个**没有验证过**的可能性：系统扩展（`app-sandbox=false`）是否允许 `posix_spawn` 随包的 sing-box 二进制。如果允许，`runtime/manager.rs`、`health.rs` 的改动会小很多。openmesh 没有走这条路，所以没有任何先例可依；这需要单独做一次原型验证，不能想当然。

### 3.5 平台限制（换成 NE 之后会出现的）

| 限制 | 影响 |
|---|---|
| **分发方式** | 模式 A（appex）只适用于 Mac App Store；我们发 DMG，只能用模式 B（系统扩展）。DTS 答复与 Tailscale / Firezone 的迁移实践一致：Developer ID 分发要用 `-systemextension` 那一套 |
| **沙箱** | appex 是 App Sandbox；sysext 虽 `app-sandbox=false`，仍是受限沙箱。扩展**读不到**用户目录里的任意文件——我们的 `~/.veyl/configs/*` 不能直接读，必须走 App Group 共享容器或 `providerConfiguration`（openmesh 两者都用：`FilePath.swift:17`、`VPNManager.swift:185-193`） |
| **不能起子进程** | 见上，必须 libbox 或另证 |
| **签名/公证** | 容器 App 与扩展各自需要 Developer ID profile，且要「由内向外」手工签（Xcode 不会自动用 `-systemextension` 的值）；公证是必须的，不再是可选 |
| **`includeAllNetworks`** | 开启后 sing-box 的 `tun.stack` 不能是 `system`/`mixed`，openmesh 在启动前直接拦截报错（`PacketTunnelProvider.swift:353-370`） |
| **DNS** | 由扩展把 `getDNSServerAddress()` 填进 `NEDNSSettings`，再交给 sing-box；与我们现在「靠 hijack-dns + 路由」的模型不完全一样，需要重新对齐 |
| **状态可见性** | 用户在系统设置 / 菜单栏能看到并停掉 VPN；`NEOnDemandRule` 可以做开机自动连，这是我们目前没有的能力 |
| **最低系统** | openmesh 设 `MACOSX_DEPLOYMENT_TARGET = 13.5`，与我们 SMAppService 的 13.0 接近 |
| **App Store 审核** | 如果将来上架，VPN 类应用有额外审核要求；当前不在范围内 |

---

## 4. 两条路线的事实对照

| 维度 | 现状：root helper + XPC | 换成：NetworkExtension（sysext） |
|---|---|---|
| 分发 | Developer ID，**不需要 provisioning profile** | Developer ID + **两份 profile** + 公证（本来就要公证） |
| 首次授权 | 「登录项与扩展」里打开后台助手 | 系统扩展批准 + VPN 配置 |
| 特权来源 | 我们自己签的 root 二进制 | Apple 的 entitlement 校验 |
| 我们写的特权代码 | ~3,900 行 Rust（`tun/*` + `veyl-helper`） | 0，换成 1,400–1,800 行 Swift（按 openmesh 体量）+ libbox |
| 运行时形态 | 子进程 + Clash API | 进程内 libbox（或未验证的 spawn） |
| 运行时来源 | 随包 sing-box 二进制（已是 universal） | 需要新打 libbox xcframework |
| 现有 Rust 核心复用 | — | `builder.rs` / `plan.rs` / `tun/mod.rs` 可复用；`health.rs` 取决于 Clash API 是否可用 |
| 开发态可测 | 否（必须签名包） | 否（同样必须签名包，但模式 A 的开发 profile 少一步系统设置批准） |
| 本次已发现的打包缺口（运行时重签导致哈希不一致） | 存在，需修 | 不存在（不再用编译期哈希校验包内文件） |
| 已知未验证项 | `MachServices` 命名、Tauri 资源落点 | libbox 是否支持 `experimental.clash_api`；sysext 能否 spawn；Developer ID profile 能否为我们的 App ID 生成 |

---

## 5. 风险清单

1. **授权不是主要风险，但仍是外部依赖**：Developer ID profile 偶尔需要联系 Apple 支持才能生成。
2. **运行时架构是主要工作量**：从「Rust 管子进程」变成「Swift 管 libbox」，`runtime/manager.rs` 的健康检查、流量采样、重连语义都要重写或大幅改写。
3. **两条实现会并存一段时间**：一旦开始迁移，`tun/*` 与 Swift provider 会同时存在，测试面和文档面都翻倍。
4. **libbox 版本与二进制版本必须同源**：我们现在锁定 sing-box 1.14.4 二进制；libbox 必须由同一份源码打出，否则「同版本不同行为」的问题会很难查。
5. **安全模型换了，但没变简单**：不再需要防「用户可写目录里的 root 执行」，但要把「扩展只从 App Group / providerConfiguration 取数据」这条边界守好；openmesh 的 `providerConfiguration` 里放的是 nonce 与 build 号，配置本体走 App Group。
6. **公证链路变复杂**：两套 profile、由内向外签名，任何一步错了都是「装上了但起不来」，且失败信息不如我们现在的错误码直观。

---

## 6. 待验证（真要评估时先做这三件）

1. 用我们的 bundle id 在门户里开 Network Extensions + System Extension，能否直接生成两份 Developer ID profile（不联系支持）。
2. libbox 里 `experimental.clash_api` 是否仍然监听回环端口——决定 `health.rs` 能不能原样复用。
3. 系统扩展（`app-sandbox=false`）能否 `posix_spawn` 随包的 sing-box；不能的话，libbox 就是唯一路径。

这三条不需要改我们的代码，一两天可以出结论。

---

## 7. 本文的事实来源

- openmesh 代码：`/Users/wesley/ai/openmesh-cli/openmesh-apple/`，逐处已在正文标注文件:行号。
- provisioning profile：只读取了本机钥匙串目录下的 `Name` / `Entitlements` / `ProvisionedDevices` 字段，**没有复制任何 `.provisionprofile` 或签名材料进本仓库**。
- Apple 侧：TN3134（Network Extension 提供商部署）与 Apple Developer Forums 的 DTS 答复；`packet-tunnel-provider` 为自助能力、Developer ID 分发需系统扩展并带 `-systemextension` 后缀，这两点多处来源一致。
