# 分发与发布检查

> 对应 `phase-1-requirements.md` 9.4 验收标准
> 层：M = 手工，D = 脚本检查
> 每个 RC 都必须跑一遍；证据归档到 `docs/test-cases/evidence/`

---

## 0. 当前口径（2026-11-02）

| 平台 | 签名状态 | P1 要求 |
|---|---|---|
| macOS | Developer ID + 公证 + staple | **必做**，对外发布前完成 |
| Windows | 默认不签名 | P1 只要求「能装、能跑、文档写清绕过提示」；**代码签名与分发是 P5 收尾任务**，不阻塞 P1 |

Windows 签名一旦启用，本文件 §3 的用例从 P2 升级为 P0。

---

## 1. 通用

| ID | 层 | 追溯 | 步骤 | 预期 | 优先级 |
|---|---|---|---|---|---|
| **TC-DIST-001** | D | 9.4 | 1) 解包安装包；2) 读取应用版本；3) 与 `tauri.conf.json` / `package.json` 比对 | 版本号完全一致；运行时清单里的 sing-box 版本与设置页显示一致 | P0 |
| **TC-DIST-002** | M | 9.4 | 1) 安装；2) 卸载；3) 检查残留 | 用户数据目录按设计保留或删除（二者择一，但必须与文档一致）；安装目录清空；无残留的 sing-box 子进程 | P1 |
| **TC-DIST-003** | D | GPL | 1) 检查安装包内容 | 含 `LICENSE`（GPL-3.0）；关于页含 sing-box 版本、许可证、源码地址；**不含**任何暗示官方关联的文案或图标 | P0 |
| **TC-DIST-004** | M | 隐私 | 1) 全新机器安装运行 10 分钟；2) 抓包 | 只与我们的目录服务与 DeepSeek 通信；无第三方遥测域名 | P1 |

---

## 2. macOS

| ID | 层 | 追溯 | 步骤 | 预期 | 优先级 |
|---|---|---|---|---|---|
| **TC-DIST-005** | D | 9.4 | `codesign --verify --deep --strict --verbose=2 Veyl.app` | 退出码 0；无 `code object is not signed at all` | P0 |
| **TC-DIST-006** | D | 9.4 | `spctl -a -vv Veyl.app` | 输出 `accepted`；`source=Notarized Developer ID` | P0 |
| **TC-DIST-007** | D | 9.4 | `codesign -dv --verbose=4 Veyl.app` | `Authority=Developer ID Application: <公司名>`；`Timestamp` 存在；`Runtime Version` 存在（hardened runtime 已开） | P0 |
| **TC-DIST-008** | D | 9.4 | `xcrun stapler validate Veyl.dmg` | 输出 `The validate action worked!` | P0 |
| **TC-DIST-009** | M | 9.4 | 1) 在一台**从未安装过**的 Mac 上从浏览器下载 DMG；2) 双击打开；3) 拖入 Applications；4) 首次启动 | 不出现「无法验证开发者」；不出现「已损坏」；首次启动不被 Gatekeeper 阻止 | P0 |
| **TC-DIST-010** | M | 9.4 | 上述机器**断网**后再启动一次 | 仍能启动（staple 生效，无需联网校验票据） | P0 |
| **TC-DIST-011** | D | 双架构 | `lipo -archs Veyl.app/Contents/MacOS/veyl` | 同时含 `arm64` 与 `x86_64` | P0 |
| **TC-DIST-012** | D | 嵌套二进制 | 1) 列出 `.app/Contents` 内所有 Mach-O；2) 逐个 `codesign --verify` | 全部已签名；无「未签名的嵌套二进制」 | P0 |
| **TC-DIST-013** | M | 9.4 | 在 x86_64 Mac 或 Rosetta 下运行 | 正常运行；`uname -m` 与运行时架构匹配；下载的是 `amd64` 版本的 sing-box | P1 |

> **可执行文件名以打包脚本为准**：`.app` 与安装包名跟随 `productName`（`Veyl`），但 `.app/Contents/MacOS/` 下的二进制名取决于 cargo crate 名，`veyl.exe` 同理取决于 Windows 的 crate 名。用例里写的是改名后的预期值；若 Bob 保留 `aivpn` 这个 crate 名，把命令里的 `veyl` / `veyl.exe` 换成 `aivpn` / `aivpn.exe` 即可——**这是唯一会随打包脚本变化的地方**。

---

## 3. Windows

| ID | 层 | 追溯 | 步骤 | 预期 | 优先级 |
|---|---|---|---|---|---|
| **TC-DIST-014** | M | 9.4 | 1) 干净 Win10 / Win11 从浏览器下载 MSI；2) 双击安装 | 安装可完成；出现 SmartScreen「Windows 已保护你的电脑」时，按文档步骤「更多信息 → 仍要运行」可继续 | P0 |
| **TC-DIST-015** | M | 9.4 | 检查发布文档 | 文档中**存在**「更多信息 → 仍要运行」的图文说明；存在 `SHA256SUMS` 并提供校验命令 | P0 |
| **TC-DIST-016** | M | 9.4 | 1) 安装后启动；2) 完成一次连接 | 功能与 macOS 一致（单测覆盖不到的路径在这里发现） | P0 |
| **TC-DIST-017** | D | 9.4 | `Get-FileHash Veyl-<ver>-x64.msi -Algorithm SHA256` 与 `SHA256SUMS` 比对 | 一致 | P0 |
| **TC-DIST-018** | M | 已知限制 | 1) 在启用 AppLocker/WDAC 策略的机器上安装 | 记录实际表现（预期：可能被拦截）。这是**已知限制**，需写进文档，不作为 P1 缺陷 | P2 |
| **TC-DIST-019** | M | P5（签名启用后） | `signtool verify /pa /v Veyl-<ver>-x64.msi` 及 `veyl.exe` | 均通过；安装时显示公司发布者名称 | P2 → 启用签名后升 P0 |

---

## 4. 发布前人工清单

按顺序执行，任一项不过即停止发布：

- [ ] 版本号三处一致（`tauri.conf.json` / `package.json` / 安装包文件名）
- [ ] `CHANGELOG` 与本次实际变更一致
- [ ] 运行时清单里的 `sha256` 与本机重新下载计算的值一致（**每次发版都要重算**，不要沿用旧值）
- [ ] 安装包在干净 macOS 与干净 Windows 各装一次
- [ ] 首次启动引导可走完
- [ ] 卸载后无残留进程
- [ ] 下载页提供 `SHA256SUMS` 与校验说明
- [ ] 关于页/GPL 声明存在
- [ ] 已知问题清单已更新（至少包含：系统代理不覆盖部分应用、Windows 未签名提示）
- [ ] 证据归档：`docs/test-cases/evidence/<YYYYMMDD>-release-<版本>/`
