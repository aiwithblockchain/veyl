# TUN 提权架构选型备忘

> 日期：2026-11-05
> 状态：**评估结论，未实施**。本文不改任何代码，也不构成对现有实现的否决。
> 触发原因：产品负责人指出参考项目 `openmesh-cli` 在 macOS 上以 NetworkExtension 跑通 sing-box，且「Debug 模式就能跑」，怀疑我们选错了架构。
> 参考实现：`~/ai/openmesh-cli/openmesh-apple/`（下称「参考项目」）
> 姊妹文档：[`docs/tun-alternatives-macos.md`](tun-alternatives-macos.md)（两条路的事实核对，本文在其上做裁决）、[`docs/tun-test-readiness.md`](tun-test-readiness.md)（当前测试就绪度审计）
> 相关文档：`docs/tun-mode.md` §4、`docs/tun-privilege.md`、`docs/review-checklist.md` B5 组

---

## 0. 结论

**建议维持「root helper + XPC」，不迁移 NetworkExtension。**

理由不是「NE 不好」，而是：**这次的核心诉求（debug 能在 `tauri dev` 里测 TUN）换成 NE 也解决不了**——两条路都必须有签名过的 `.app` 包。真正的瓶颈是「我们没有一条命令产出可测的签名开发包」，那是一个脚本问题，不是架构问题。

NE 真实的收益是另外三件事：机器上不再有 root 守护进程、可以上 Mac App Store、系统级 on-demand。这三件目前都不是需求。

| | 维持现状 | 迁移 NE（sysext） |
|---|---|---|
| 解决「签名才能测」 | ❌ | ❌（同样要签名包） |
| 解决「root 进程」 | ❌ | ✅ |
| 上 Mac App Store | ❌（LaunchDaemon 被禁） | ✅（这是唯一硬条件） |
| 工作量 | 一个脚本（约 1–2 天） | 4–8 周，且要先给两个 App ID 开能力、建两份 Developer ID profile（自助，见 §4.4） |

**立即可做的一件事（方案 A+）**：补一条 `scripts/dev/tun-dev.sh`，`tauri build --debug` → 签名 → 装进 `/Applications` → 打开。把「签名测试」从人工流程变成一条命令（签名身份先用 Apple Development 试，不行退回 Developer ID）。详见 §5.2。

**什么情况下改主意**：见 §7.2 的五个触发条件，其中「要上 Mac App Store」和「`tun-privilege.md` §8.1 的验签前提被证伪」是硬触发。

---

## 1. 问题重述

现状（`docs/tun-privilege.md` §2）：

```
Veyl.app（Developer ID + hardened runtime，非沙盒）
  └── LaunchDaemon：/Applications/Veyl.app/Contents/Library/LaunchDaemons/com.veyl.helper.plist
        └── veyl-helper（root）
              └── spawn 随包的 sing-box 二进制（它自己建 utun、改路由表）
```

macOS 上建 utun、改路由表需要 root，这是硬约束，三条路都绕不开——区别只在**谁拿到那个特权**：我们自己的守护进程（现状）、还是系统的 network extension framework（NE）。

NS 侧的两种打包形态要先分清，二者**不是**同一种东西：

| 形态 | 产物 | 能用于 Developer ID 分发吗 |
|---|---|---|
| App Extension（`.appex`） | `Veyl.app/Contents/PlugIns/*.appex` | **不能**，只允许 Mac App Store |
| System Extension（`.systemextension`） | `Veyl.app/Contents/Library/SystemExtensions/*.systemextension` | **能**，这是 Developer ID 的唯一合法形态 |

Apple 的 TN3134 明确写了这一点；参考项目也因此维护了**两套 target**：`vpn_extension_macos`（`.appex`，给 Debug/App Store 用）与 `vpn_extension_macx`（`.systemextension`，给 Developer ID 用）。这是迁移成本里容易被低估的一项。

---

## 2. 逐维度对比

| 维度 | A. root helper + XPC（现状） | B. NE · App Extension | C. NE · System Extension |
|---|---|---|---|
| **用户授权体验** | 「系统设置 › 登录项与扩展」批准一次 + 一条「已添加后台项目」通知 | 首次连接弹「Veyl 想要添加 VPN 配置」→ 允许。**最轻** | sysext 激活时弹「系统扩展被阻止」→ 去隐私与安全性放行；VPN 配置可能再弹一次。**最重，两次** |
| **系统版本** | macOS 13+（`SMAppService`） | macOS 10.15+ | macOS 10.15+ |
| **Apple 审批** | 无 | **无人工审批**：门户给 App ID 勾 Network Extensions 即可；但要建两份 Developer ID profile（§4.4） | 同左，且 entitlement 值必须带 `-systemextension` 后缀 |
| **分发与公证** | Developer ID + 公证（已在做） | **不能用于 Developer ID** | Developer ID + 在 app 与 sysext 里各嵌一份 provisioning profile + 手工 codesign + 公证。比现状多两步 |
| **安全边界（谁能拿到 root）** | 机器上常驻一个 root 守护进程；信任根是 `/Library/Application Support/Veyl`；**未验证** SMAppService 是否验签 helper（`tun-privilege.md` §8.1） | 没有 root 进程；utun 由系统给 | 同左；sysext 由系统加载，签名由系统校验 |
| **debug / 测试迭代** | build → 签名 → 装 `/Applications` → 批准一次 | Xcode 里 Apple Development + 自动签名可以直接跑；**但 `tauri dev` 不行** | 同左，且每次替换 sysext 可能重新触发放行 |
| **代码改动量** | 0 | 新增 Swift target + Go 框架，删 ~4000 行 Rust | 同左 + 签名流水线重写 |
| **数据面能力** | sing-box 二进制自己建 utun：`auto_route` / `route_exclude_address` / `hijack-dns` 全按 `tun-mode.md` §2/§3/§6 的写法 | utun 由 NE 建；路由/DNS 改由 `NEPacketTunnelNetworkSettings` 表达；sing-box 必须以 **libbox** 形式内嵌 | 同左 |
| **能上 Mac App Store** | ❌（LaunchDaemon 被禁） | ✅ | ✅ |

### 2.1 「Debug 就能跑」到底指什么

参考项目里两个 Mac App 的签名配置（`MeshFlux.xcodeproj/project.pbxproj`）：

| target | 签名 | 打包形态 | 用途 |
|---|---|---|---|
| `MeshFluxMac`（`com.meshnetprotocol.OpenMesh.mac`） | `CODE_SIGN_IDENTITY = "Apple Development"` + 自动签名 | 内嵌 `vpn_extension_macos.appex` | 开发调试 |
| `MeshFlux.sys`（`…OpenMesh.macsys`） | `Developer ID Application` + 手动 + `openmesh_mac_main_app` profile | 内嵌 `vpn_extension_macx.systemextension` | 对外分发 |

所以「Debug 就能跑」的准确含义是：**在一个签名过的 Xcode target 里能跑**，不是「不用签名」。它省掉的是**公证**和**手动 entitlement 后缀**这两步，省不掉 `.app` 形态与 entitlement 本身。而且这套 Debug 配置之所以成立，是因为该项目**已经拿到了 Network Extension entitlement**——没有它，自动签名也生成不出带 `packet-tunnel-provider` 的 profile。

---

## 3. 数据面的实际变化（迁移最容易低估的部分）

换成 NE 之后，`docs/tun-mode.md` 里**大部分固定参数不再适用**：

| `tun-mode.md` 里的规定 | NE 下 |
|---|---|
| §2 差异 1：`type: "tun"`、`auto_route`、`auto_detect_interface` | 入站不再是我们写进配置的 `tun` inbound；libbox 通过 `PlatformInterface.openTun` 拿系统给的 utun。`auto_route` 由 libbox 翻译成 `includedRoutes`；`auto_detect_interface` 无意义 |
| §2 差异 3：`protocol: "dns" → action: "hijack-dns"` 必须显式写 | DNS 改由 `NEDNSSettings` 下发，系统解析器直接指向我们的地址。`hijack-dns` 不再是主路径 |
| §3 `interface_name` 留空 | 仍然成立（NE 也自己分配 utunN），但原因不同 |
| §6 内网排除：`route_exclude_address` + `ip_is_private` | `route_exclude_address` 翻译成 `excludedRoutes`；`ip_is_private` 规则不变。两层思路保留，参数位置变了 |
| §2 差异 2：sniff 规则顺序 | **不变**，这是 sing-box 内部路由，与 NE 无关 |

**sing-box 集成方式必须换**：NE 的 provider 自己就是数据面，不能像现在这样 spawn 一个二进制。要按参考项目那样把 sing-box 编成 Go 框架（`OpenMeshGo` / libbox），在 `NEPacketTunnelProvider` 里 `OMLibboxNewService(configContent, platform)`。这意味着：

- 新增 Go + gomobile 工具链，产出 XCFramework，进 CI；
- sing-box 版本从「下载二进制 + 跑 `sing-box check`」变成「编译期绑定」，升级要重新出框架；
- 现在的 `sing-box check` 预校验与 `tun/protocol.rs` 的配置校验要重写成 libbox 的启动错误路径。

参考项目为此专门写了一篇《sing-box 架构分析报告.md》，可见不是贴一层壳的工作量。

---

## 4. NetworkExtension 对我们的具体门槛

我们的 bundle id：`io.github.aiwithblockchain.veyl`，Team ID `2XYK8RBB6M`。

### 4.1 需要哪些 entitlement

| 对象 | entitlement | 值 |
|---|---|---|
| 主 App | `com.apple.developer.networking.networkextension` | `["packet-tunnel-provider-systemextension"]` |
| 主 App | `com.apple.developer.system-extension.install` | `true`（激活 sysext 用） |
| 主 App | `com.apple.developer.team-identifier` / `com.apple.application-identifier` | 激活校验必需 |
| sysext | `com.apple.developer.networking.networkextension` | `["packet-tunnel-provider-systemextension"]` |
| sysext | `com.apple.developer.team-identifier` / `com.apple.application-identifier` | 同上 |

**值必须带 `-systemextension` 后缀**。不带后缀的 `packet-tunnel-provider` 只给 `.appex` 用（参考项目里 `vpn_extension_macx/OpenMesh_Sys_ext.entitlements` 用的是带后缀的，`vpn_extension_macos/` 用的是不带后缀的，正好对照）。

### 4.2 对 App ID 与 profile 的要求

1. 两个 App ID 都要在 portal 里启用 Network Extensions 能力：主 App `io.github.aiwithblockchain.veyl`，扩展 `io.github.aiwithblockchain.veyl.network-extension`（**前缀必须与主 App 一致**）。
2. 主 App 还要启用 **System Extension** 能力（`com.apple.developer.system-extension.install` 同样是受限 entitlement）。
3. Developer ID 分发需要**两份 Developer ID 类型的 provisioning profile**，分别嵌到：
   - `Veyl.app/Contents/embedded.provisionprofile`
   - `Veyl.app/Contents/Library/SystemExtensions/<id>.systemextension/Contents/embedded.provisionprofile`
4. 没有嵌入 profile 时，amfid 会拒绝启动带受限 entitlement 的二进制，launchd 报 `error=162 (Codesigning issue)`。参考项目的 `scripts/release_macos_dev_id.sh:25-31` 把这条写进了注释，并强制要求 `app.provisionprofile` 与 `sysext.provisionprofile`。
5. 如果要用 App Group 共享配置，还要 `com.apple.security.application-groups` + 对应 profile。**这一项可以避免**：配置内容可以用 `NETunnelProviderProtocol.providerConfiguration` 传，控制通道用 `sendProviderMessage`。

### 4.3 Developer ID 分发可行吗，有哪些坑

可行，但**只有 sysext 一条路**（TN3134）。已知坑：

| 坑 | 表现 | 规避 |
|---|---|---|
| Xcode 不认 `-systemextension` 后缀 | 自动签名生成的 profile 与手写 entitlements 对不上 | 手工 `codesign --entitlements`，参考项目整个 release 脚本就是干这个的 |
| 签名顺序 | 先签内层再签外层，`--deep` 在这里不可靠 | 按路径深度从深到浅逐个签（参考脚本 §1/§2） |
| 漏嵌 profile | `error=162`，或激活时 `configurationInvalid` | 构建后断言两个 `embedded.provisionprofile` 都在 |
| 公证 | `.app` 与 `.dmg` 分别公证 + staple | 两条命令，脚本化 |
| 升级 | sysext 版本号不变时系统可能不替换 | 每次构建递增 `CFBundleVersion`，并在 `actionForReplacingExtension` 里返回 `.replace` |
| 干净的测试机 | 旧 sysext 残留会让新包「看起来没生效」 | 测试前 `systemextensionsctl uninstall`，这是 Apple DTS 的标准建议 |

### 4.4 需要先确认的三件事（未确认前不要承诺排期）

1. **给两个 App ID 开能力**。在 Certificates, Identifiers & Profiles › Identifiers 里勾 Network Extensions（主 App 还要勾 System Extension）。这是**自助操作**：据 `docs/tun-alternatives-macos.md` §3.2 的核对，`packet-tunnel-provider` 不需要提交审批表——需要人工审批的是 Hotspot Helper、NE app push 之类的类型。网上仍能搜到「要填申请表」的旧说法，属于 2020 年前的流程，不要据此估排期。
2. **建两份 Developer ID profile**。带受限 entitlement 的 Developer ID 二进制必须有匹配 profile，否则 amfid 报 `error=162`。同一 Team ID（`2XYK8RBB6M`）的参考项目已经有 `openmesh_mac_main_app` / `openmesh_mac_extension` 两份现成 profile，说明**这条路在我们团队手里走得通**。偶发风险是门户侧建不出来、需要找 Apple 支持（论坛有多例），这是迁移唯一的外部依赖。
3. **App Store 政策**。App Review 5.4 要求 VPN 类 App 由**组织**账号发布。我们走 Developer ID 不走 App Store，暂时不适用；一旦真要上 App Store，这条要一起过。

---

## 5. Debug 测试工作流（这次的核心诉求）

### 5.1 两条路都做不到「`tauri dev` 直接测 TUN」

原因与架构无关：`tauri dev` 跑的是 `target/debug/veyl` 裸二进制，**不在 `.app` bundle 里**。而：

- helper 方案：LaunchDaemon 的 plist 必须在 `Contents/Library/LaunchDaemons/`，`SMAppService` 只认 bundle 内的 plist；XPC 对端验签要求证书链锚定到 Apple（`anchor apple generic`），ad-hoc 签名过不了。
- NE 方案：sysext 必须嵌在签名过的 `.app` 里，`OSSystemExtensionRequest` 也只认 bundle。

所以 **「换 NE 就能在 `tauri dev` 里测 TUN」不成立**。能省的是公证与 Developer ID 证书，省不掉签名与 bundle。

### 5.2 现状可以立刻改进的部分（方案 A+）

现在测 TUN 的流程是「跑 `build-dmg.sh --skip-notarize` → 装上 → 批准」。它慢的原因不是必须这么慢，而是我们**只有出包脚本，没有开发脚本**：

| 步骤 | 现状 | A+ 方案 |
|---|---|---|
| 构建 | `tauri build`（release，universal） | `tauri build --debug`（单架构，快数倍） |
| 签名身份 | Developer ID | **先试 Apple Development**；`tun-test-readiness.md` §2.1 认为只有 Developer ID 才满足验签，这条**未实测**，见 §8 第 1 项。若不行就退回 Developer ID（`--skip-notarize`，不需要公证与 profile） |
| 公证 | 跳过 | 本来就不做 |
| 安装 | 手动拖进 `/Applications` | 脚本 `ditto` 过去 |
| 批准 | 每次都要去系统设置 | 同一 bundle id + 同一 Team ID 时，**批准状态通常保留**；换证书或换路径才需要重新批 |

产出：`scripts/dev/tun-dev.sh`，一条命令完成「构建 → 装 helper + plist → 签名 → 装 `/Applications` → 打开」。预计 1–2 天，且**不改变架构**。

> 待验证：Apple Development 签名的 helper 能否被 `SMAppService` 注册并满足 XPC 对端验签。`docs/tun-test-readiness.md` §2.1 的结论是「只有 Developer ID 才行」，但那是基于要求串的推断，没有实测；本条与 `tun-privilege.md` §10 的三条未验证项同源，做 A+ 时一起验掉。
>
> 另：`docs/tun-test-readiness.md` §3.1 指出打包路径里有一处「运行时哈希」缺口，会让 TUN 第一次 `start` **必然失败**。那是比签名身份更前置的阻塞项，做 A+ 时一并修。

### 5.3 如果真的迁到 NE，debug 会变成什么样

需要 Xcode 或等价的签名脚本，因为 sysext 是 Swift/ObjC 产物，`cargo` 构建不出来：

1. 首次：`OSSystemExtensionRequest` 激活 → 系统设置放行（一次）。
2. 之后每次改 Rust 侧：仍要重出签名的 `.app`；改 Swift 侧：Xcode build + 替换 sysext（可能再次放行）。
3. CI/日常都需要 Go + Xcode 两条工具链。

**结论：NE 的 debug 体验不比 A+ 好，只是「有 Xcode 一键 Run」这一条比我们现在的脚本强——而 A+ 补上脚本后差距基本消失。**

---

## 6. 迁移成本

### 6.1 代码地图

现有 TUN 相关代码 **3989 行**：

| 文件 | 行数 | 迁移后 |
|---|---|---|
| `src-tauri/src/bin/veyl-helper/macos.rs` | 1183 | **作废** |
| `src-tauri/src/bin/veyl-helper/main.rs` | 24 | **作废** |
| `src-tauri/src/tun/xpc.rs` | 423 | **作废**（改走 `NETunnelProviderSession`） |
| `src-tauri/src/tun/trust.rs` | 477 | **作废**（不再有 root 信任根） |
| `src-tauri/src/tun/privilege.rs` + `privilege/smappservice.rs` | 339 | **作废** |
| `src-tauri/src/tun/protocol.rs` | 689 | 大部分作废（XPC 报文 → provider message） |
| `src-tauri/src/tun/session.rs` | 376 | 重写为 NE 会话管理 |
| `src-tauri/src/tun/mod.rs` | 478 | 保留排除表计算、本机网段反推，其余重写 |
| `src-tauri/resources/launchd/com.veyl.helper.plist` | — | **删除** |
| `scripts/packaging/build-dmg.sh` 的 helper 安装与断言段 | ~40 | 换成 sysext 嵌入与两份 profile 断言 |

**可复用**：`vpn_config::build_routed_multi` 的配置生成、分流规则装配、`tun::collect()/subnets()/excludes()` 的网段计算、`RuntimeStatus::tun` 与 `TunSnapshotInput`、前端对 `mode: "tun"` 的全部处理。

**新增**：Swift `NEPacketTunnelProvider`。参考项目的实测量级：`.appex` 变体 `PacketTunnelProvider.swift` 1057 行 + `LibboxSupport.swift` 418 行；`.systemextension` 变体是**另一份** 1250 + 556 行。两套 target 各自维护，代码大量重复。再加 libbox XCFramework 构建、sysext 的 Info.plist / entitlements / 签名流水线。

综合：**4–8 周**（不含 entitlement 审批等待），且期间 TUN 不可用。

### 6.2 GAP-02 / GAP-03 会不会自然消掉

| 缺口 | 迁移后 |
|---|---|
| **GAP-02**（TUN 的 sing-box 日志无上限，helper 以 root 写） | **自然消失**。没有 helper、没有那份 root 写入的 `sing-box.log`；libbox 的日志走 `os_log` 或我们自己写的文件，天然可轮转 |
| **GAP-03**（TUN 不进 `RuntimeManager`，快照手拼） | **部分消失**。「没有 root 子进程」这个理由没了，但 TUN 仍是独立会话，仍需接入 `RuntimeManager` 才能自动重连。好处是：修它的最小版（返回完整快照）变得便宜得多 |

**注意**：GAP-02/03 都**不值得**作为迁移理由——单独修它们合计不到 2 天，迁移是 20 倍的成本。

---

## 7. 建议

### 7.1 推荐：维持现状 + 方案 A+

1. **现在**：补 `scripts/dev/tun-dev.sh`（§5.2），把签名测试变成一条命令。这是对产品诉求的直接回应，1–2 天。
2. **同一轮**：验掉 `tun-privilege.md` §10 的三条 + §8.1 的验签前提。其中 §8.1（SMAppService 是否验签 helper）是现有架构的**安全底座**，没验过就不能说这套方案「成立」。
3. **暂不迁移**：把 NE 作为一条已评估的备选记在本文，等触发条件出现。

### 7.2 触发条件（出现任一条再启动迁移评审）

| # | 触发条件 | 强度 |
|---|---|---|
| 1 | 产品决定上 **Mac App Store** | **硬**：LaunchDaemon 在 App Store 被禁，必须改成 NE |
| 2 | `tun-privilege.md` §8.1 被证伪：SMAppService **不**验签 helper | **硬**：现有信任链有洞，必须换架构或换信任模型 |
| 3 | 需要 **on-demand VPN**（开机自连、断线自动重连、按网络切换） | 中：NE 原生支持，helper 要自己 구현看门狗 |
| 4 | 需要**多用户**或非 `/Applications` 安装的正式支持 | 中：现状要求 App 在 `/Applications` |
| 5 | 两个 App ID 已开 Network Extensions 能力、两份 Developer ID profile 已建好 | 前置条件：**单独出现不构成理由** |

第 1 条一旦成立，迁移是**必须**而不是**可选**——这一点要写进路线图预期，不要等到要上架那天才发现。

---

## 8. 待验证清单（做 A+ 时一起做，不需要迁移也不需要 entitlement）

| # | 待验证 | 怎么验 |
|---|---|---|
| 1 | Apple Development 签名的 helper 能否被 `SMAppService` 注册成功 | 出 Apple Development 签名的包，装 `/Applications`，看登录项里有没有 Veyl |
| 2 | `MachServices` 名字是否需要 Team ID 前缀 | 同上，看 XPC 能否连上 |
| 3 | `BundleProgram` 与 `MachServices` 并存是否被 launchd 接受 | 同上，看 `launchctl print system/com.veyl.helper` |
| 4 | `xpc_connection_set_peer_code_signing_requirement` 在未公证的 Apple Development 包上的行为 | 用签名包连接，看是被接受还是被拒 |
| 5 | 同一 Team ID 重新构建后，是否保留已批准的登录项 | 重建两次，看是否再弹「后台项目已添加」 |

---

## 9. 参考项目给出的确定事实

（均可在 `~/ai/openmesh-cli/openmesh-apple/` 复核）

- `MeshFluxMac` = Apple Development + 自动签名，内嵌 `.appex`；`MeshFlux.sys` = Developer ID + 手动签名 + 手写 profile，内嵌 `.systemextension`。**两套 target 并存**，不是一套配置通吃。
- sysext 的 entitlements 用 `packet-tunnel-provider-systemextension`，app 用同名值；`.appex` 才用不带后缀的 `packet-tunnel-provider`。
- `scripts/release_macos_dev_id.sh` 的核心复杂度全部来自「Developer ID + 受限 entitlement」：嵌两份 profile、按深度手工签名、公证、staple，以及注释里那句 `error=162`。
- provider 内部不是 spawn 二进制，而是 libbox：`OMLibboxNewService(configContent, platform)` + `OpenMeshLibboxPlatformInterface`（`vpn_extension_macos/PacketTunnelProvider.swift`）。
- 首次安装是 `OSSystemExtensionRequest.activationRequest` + 用户去系统设置放行（`MeshFlux.sys/SystemExtensionManager.swift`）。

---

## 10. 来源

- Apple, [com.apple.developer.networking.networkextension（entitlement 文档）](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.developer.networking.networkextension.md)
- Apple Developer Forums, [On macOS Network Extension Deactivation](https://developer.apple.com/forums/thread/807223)
- Apple Developer Forums, [Network Extension Signed by Developer ID Not Activating](https://developer-apple-com.analytics-portals.com/forums/thread/756494)（镜像站）
- Apple Developer Forums, [Developer ID system extension rejected at activation: "Extension not found in App bundle"](https://developer.apple.com/forums/thread/854866)
- Apple Developer Forums, [Entitlement Request Support](https://developer.apple.com/forums/thread/786886)
- Stack Overflow, [Unable to create provisioning profile to distribute outside the Mac App Store](https://stackoverflow.com/feeds/question/71100475)
- Apple 技术说明 **TN3134「Network Extension provider deployment」**：Developer ID 分发必须用系统扩展，`.appex` 仅限 Mac App Store（本文据此，未附链接）
- 苹果 entitlement 是否自助、同 Team 是否已有 NE profile：见 [`docs/tun-alternatives-macos.md`](tun-alternatives-macos.md) §3.2 / §3.3（本文采纳其核对结果）
- 当前测试就绪度与打包阻塞项：见 [`docs/tun-test-readiness.md`](tun-test-readiness.md)
- 参考实现：`~/ai/openmesh-cli/openmesh-apple/scripts/release_macos_dev_id.sh`、`MeshFlux.xcodeproj/project.pbxproj`、`MeshFlux.sys/SystemExtensionManager.swift`、`vpn_extension_mac{x,os}/`
