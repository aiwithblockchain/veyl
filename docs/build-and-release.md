# Veyl 构建与发布脚本体系

> 版本：v1.0
> 日期：2026-11-02
> 参考：TweetPilot 工程的 `scripts/` 目录（只读审计，不复制产物与密钥）
> 适用：P1 双平台构建、本地验证、GitHub Release 发布；P5 补 Windows 签名

---

> ⚠️ **最高优先级约束：任何凭据都不能提交到 GitHub。**
> 脚本可以复用参考项目的实现，但 `notary-profile.key`、`.p12`、`.pfx`、`.pem`、Apple ID 专用密码、Windows 签名凭据**一律不复制、不记录、不提交**。仓库里只允许出现环境变量名，永远不出现值。详见 §5.2，以及 §5.3 的提交前检查。这条比本文档其余任何内容都重要。

---

## 0. 本文档解决什么

把「怎么构建、怎么测、怎么发」固化成可执行的脚本，让三个人各管一段、互不踩脚。三件事：

1. 参考项目哪些脚本能直接用、哪些要改、哪些不要（§2）。
2. Veyl 自己的目录结构与每个脚本的契约（§3–§6）。
3. 谁写哪个文件、验收标准是什么（§8）。

**不做**：本文档不写业务代码，不改 `src/**`、`src-tauri/src/**`。

---

## 1. 前提与硬约束

| 项 | 约束 |
|---|---|
| 应用名 | `Veyl`（`productName`），可执行文件 `veyl` / `veyl.exe` |
| Bundle identifier | `io.github.aiwithblockchain.veyl` —— **不用 `com.veyl.desktop`**，因为项目并不持有 `veyl.com` |
| 版本唯一来源 | `src-tauri/tauri.conf.json` 的 `version` |
| 技术栈 | Tauri 2 + Rust + TypeScript |
| macOS | universal（arm64 + x86_64），Developer ID + notarytool + staple |
| Windows | P1/P2 只构建 MSI **不签名**；脚本预留签名 hook，P5 启用 |
| 发布渠道 | GitHub Releases；P1 无 updater（批 7 再加，见 `docs/upgrade.md`）、无 Cloudflare Worker、无官网同步 |
| **构建期网络** | 规则数据走 `api.github.com` + `codeload.github.com`，运行时走 `api.github.com` + `release-assets.githubusercontent.com`。GitHub IP 时通时不通，脚本每次重试重新解析 DNS；不依赖 `github.com` / `raw.githubusercontent.com`。上游信任模型见 §4.10 |
| 密钥 | 一律从 keychain profile / 环境变量读，**不落仓库、不落文档、不落日志**；详见 §5.2（硬约束） |
| 路径 | 脚本内只用相对路径 + `$(dirname "$0")` 推导，**禁止写死本机绝对路径** |
| 破坏性操作 | 发布、删除、覆盖类脚本默认支持 `--dry-run`，正式执行要二次确认 |

---

## 2. 参考脚本审计

逐个看 TweetPilot 的 `scripts/`，给出 Veyl 的处置。

| 参考脚本 | 作用 | Veyl 处置 | 理由 |
|---|---|---|---|
| `packaging/build-dmg.sh` | macOS universal + 嵌套签名 + 公证 + staple + DMG | **改造采用** | 流程完全适用；改应用名、证书环境变量名、产物命名 |
| `packaging/build-msi.ps1` | 只构建 MSI，不签名 | **改造采用** | 结构可用；补签名 hook（默认关闭）、去掉「忽略签名失败」 |
| `release.sh` | 构建 + 上传 GitHub Release（含 updater 资产 + Worker URL） | **改造采用（砍掉 updater）** | P1 无 updater；只保留「构建 → 打 tag → 上传 DMG/MSI → 写 release notes」 |
| `release-windows.ps1` | Windows 构建 + 上传 | **改造采用** | 同上；Windows 侧只产 MSI |
| `publish-dmg.sh` / `publish-msi.ps1` | 复制产物到 `website/`、改 `index.html` 版本号 | **丢弃** | Veyl P1 没有官网目录，也不做静态站版本号 |
| `bump-version.sh` / `.ps1` | 同步 `package.json` / `Cargo.toml` / `tauri.conf.json` | **改造采用** | 逻辑照搬，改文件路径与错误提示；加 `--dry-run` |
| `assemble-update-manifest.py` | 双平台资产齐全后组装更新清单、部署 Worker | **丢弃** | 绑定 updater + license worker；Veyl P1 无此概念 |
| `dev-with-log.sh` / `.ps1` | 开发启动 + 统一日志 | **改造采用** | 保留日志聚合与 `--clean`；去掉 staging/prod 环境切换（Veyl 只有一种后端） |
| `dev-personal-with-log.sh` | 个人环境变体 | **丢弃** | 单人定制，无普适价值 |
| `generate_all_icons.js` / `gen_icons.sh` | 由一张源图生成各尺寸图标 | **不用，另写** | 它们的圆角画在自带 SVG 里，换 PNG 源图就失效；Veyl 用 `scripts/generate_icons.py` 自己切圆角并留 Apple Big Sur 边距 |
| `verify-license-key.mjs` | 授权码校验 | **丢弃** | Veyl 无 license 体系 |
| `license/` 目录 | 授权相关脚本 | **丢弃** | 同上 |
| `x_oauth2_*.py` | X/Twitter OAuth 调试 | **丢弃** | 与 Veyl 无关 |
| `test_icon.png` | 图标测试源图 | **不复制** | Veyl 用自有图标 |
| `notary-profile.key` | 公证凭据 | **绝对不复制** | 私钥不得进仓库；Veyl 用 keychain profile |
| `packaging/output/` | 88M 构建产物 | **不复制** | 产物不入库；`.gitignore` 覆盖 |

### 2.1 三个必须改掉的参考实现缺陷

1. **`build-msi.ps1` 里有「忽略退出码 —— 签名失败也能出 MSI」**。Veyl 接入签名后必须删掉这行，否则会出现「CI 绿了但产物没签」。
2. **`release.sh` 假设存在 updater 与 Worker URL**。Veyl P1 直接砍掉，不要留空壳变量。
3. **版本号三处同步没有校验回读**。`bump-version` 写完要重新读一遍三个文件确认一致，不一致就退出非零。

---

## 3. 目录结构

```
scripts/
  README.md                    # 一页纸：每个脚本干什么、给谁用
  check-secrets.sh             # 提交前密钥扫描（Clerk）★ CI 第一道门
  ci.sh                        # 本地跑一遍 CI（Clerk）
  test/
    unit.sh                    # cargo test + npm run typecheck（Clerk）
    contracts.sh               # 契约一致性（Clerk）
    smoke.sh                   # mock 服务 + 集成冒烟（Clerk）
    preflight.sh               # 发布前检查（Clerk，P1-后置）
  dev/
    dev-with-log.sh            # macOS/Linux 开发启动（Alice）
    dev-with-log.ps1           # Windows 开发启动（Alice）
  version/
    bump-version.sh            # 版本号同步（Bob）
    bump-version.ps1           # Windows 版（Bob）
  packaging/
    build-dmg.sh               # macOS 流水线（Bob）
    build-msi.ps1              # Windows MSI（Bob）
    lib/
      sign-macos.sh            # 签名 + 公证封装（Bob）
      sign-windows.ps1         # 签名 hook，P5 启用（Bob）
  release/
    release.sh                 # macOS 发布（Bob）
    release-windows.ps1        # Windows 发布（Bob）
  generate_icons.py            # 图标生成（已由 PM 写好，Bob 接入 npm script）

site/                          # GitHub Pages 站点（纯静态，无构建步骤）
  index.html                   # 落地页
  favicon.png

dist/                          # Vite 产物（已 gitignore）
src-tauri/target/              # Rust 产物（已 gitignore）
build/                         # 脚本自产出的中间物（gitignore）
  packages/                    # DMG / MSI
  logs/
  icons/                       # 图标母版，便于排障
```

规则：

- 每个脚本头部必须有一段 `# 用法：` 注释，写清参数与前置条件。
- 脚本只依赖：`bash 4+`、`node`、`npm`、`cargo`、`python3`、`hdiutil` / `codesign` / `xcrun`（macOS）、`signtool`（P5）。
- 缺依赖时必须**明确报出缺哪个**并退出，不要静默跳过。

---

## 4. 脚本契约

### 4.1 `scripts/ci.sh` — 本地 CI（Clerk）

按顺序跑，任一失败即停：

```bash
bash scripts/check-secrets.sh                # 0. 密钥扫描，跑不过后面全别跑
npm run typecheck
cargo test --manifest-path src-tauri/Cargo.toml
node tests/contracts/check-contracts.mjs
cargo run --manifest-path src-tauri/Cargo.toml --bin veyl-runtime-selftest
bash tests/run-mocks.sh --selftest
```

- 支持 `--quick`：只跑前 4 步（`check-secrets` / `typecheck` / `cargo test` / 契约检查）。
- 密钥扫描必须放在第一步：它是唯一能挡住「凭据进仓库」的自动检查，放在后面等于没放。
- 输出每步耗时；失败时打印该步的原始输出，不吞日志。
- 不清理 `target/`，速度优先。

### 4.2 `scripts/test/*.sh`

| 脚本 | 内容 | 验收 |
|---|---|---|
| `unit.sh` | `cargo test` + `npm run typecheck` | 退出码即结果，无网络依赖 |
| `contracts.sh` | 包一层 `node tests/contracts/check-contracts.mjs` | 失败时指出是哪个契约文件哪一条 |
| `smoke.sh` | 起 mock catalog/llm/echo → 跑一次「连接 → 状态 → 断开」 | 结束后必杀进程，异常退出也要清理 |

**`smoke.sh` 的清理要求**：用 `trap 'stop_all' EXIT`，不允许留残留端口。对应 Clerk 现有的 `tests/run-mocks.sh --stop`。

### 4.3 `scripts/dev/dev-with-log.sh`

```bash
bash scripts/dev/dev-with-log.sh              # 日常开发
bash scripts/dev/dev-with-log.sh --clean      # 清 Vite 缓存 + target 后启动
bash scripts/dev/dev-with-log.sh --no-open    # 不自动开 DevTools
```

行为：

1. 检查 `node_modules` 存在，否则提示 `npm install` 并退出。
2. `--clean` 时删除 `dist/`、`node_modules/.vite/`、`src-tauri/target/debug`。
3. 设置 `RUST_LOG=veyl=debug,tauri=info`（可被外部覆盖）。
4. 启动 `npm run app:dev`，stdout/stderr 同时写 `build/logs/dev-YYYYMMDD-HHMMSS.log`。
5. 退出时打印日志路径。

Windows 版 `.ps1` 行为一致，用 `Start-Transcript` 或 `Tee-Object` 落日志。

### 4.4 `scripts/version/bump-version.sh`

```bash
bash scripts/version/bump-version.sh 0.2.0
bash scripts/version/bump-version.sh --build   # 0.1.0 → 0.1.1
bash scripts/version/bump-version.sh --minor
bash scripts/version/bump-version.sh --major
bash scripts/version/bump-version.sh --build --dry-run
```

改动三处并回读校验：

| 文件 | 字段 |
|---|---|
| `package.json` | `.version` |
| `src-tauri/Cargo.toml` | `[package] version` |
| `src-tauri/tauri.conf.json` | `.version` |

要求：

- 非 semver 输入直接拒绝。
- 写完后重新读三处，不一致则 `exit 1`。
- `--dry-run` 只打印将要修改的内容，不落盘。
- **不改 `Cargo.lock`**；提醒用户下次构建会自行更新。

### 4.5 `scripts/packaging/build-dmg.sh`

```bash
bash scripts/packaging/build-dmg.sh              # 完整流程
bash scripts/packaging/build-dmg.sh --skip-notarize   # 本地快速出包（不公证）
```

流程（顺序不可变）：

0. 检查 `src-tauri/icons/icon.icns` 的修改时间是否早于 `aivpn.png`；是则**警告并提示跑 `npm run icons`**（不自动跑，避免脚本偷偷改仓库文件）。
1. 读版本号。
2. `npm run build`。
3. `tauri build --target universal-apple-darwin --bundles app`。
4. 校验 `.app` 内可执行文件是 universal（`lipo -archs` 含 `arm64` 与 `x86_64`）。
5. 签嵌套 Mach-O（两轮）。
6. `codesign --force --deep --options runtime --timestamp`。
7. 打 zip → `notarytool submit --wait` → `stapler staple`。
8. 制作 DMG → 签 DMG → 公证 → staple。
9. `codesign --verify --deep --strict` + `spctl -a -vv`。
10. 产物放 `build/packages/Veyl-<version>.dmg`。

凭据：

| 环境变量 | 说明 |
|---|---|
| `VEYL_DEV_ID_APP` | Developer ID Application 证书名 |
| `VEYL_NOTARY_PROFILE` | `notarytool store-credentials` 存的 profile 名 |

缺失时：**不报错退出在第一步**，而是明确提示「缺 X，可用 `--skip-notarize` 本地验证」。这一点与参考实现不同——参考实现是直接失败，但 Veyl P1 早期经常没有证书。

### 4.6 `scripts/packaging/build-msi.ps1`

```powershell
pwsh scripts/packaging/build-msi.ps1
pwsh scripts/packaging/build-msi.ps1 -Sign
```

- 默认：`tauri build --bundles msi`，产物复制到 `build\packages\Veyl-<version>.msi`。
- `-Sign`：调用 `sign-windows.ps1`；**签名失败必须让整个脚本失败**（`$ErrorActionPreference = "Stop"`，删除参考实现里的「忽略退出码」逻辑）。
- `-Sign` 但没配置凭据时：直接报错退出，不要静默出未签名包。

### 4.7 `scripts/packaging/lib/sign-windows.ps1`（P5 启用）

两种模式，二选一：

| 模式 | 触发 | 用途 |
|---|---|---|
| 云 HSM | 设置 `VEYL_WIN_SIGN_CMD` | Azure Trusted Signing / DigiCert KeyLocker / SSL.com eSigner 的 CLI |
| 本地证书 | 设置 `VEYL_WIN_CERT_THUMBPRINT` | 有硬件令牌的机器 |

顺序固定：**签 exe → 打包 MSI → 签 MSI**。时间戳必须加（`/tr http://timestamp.digicert.com /td SHA256`）。

只签 Veyl 自己构建的二进制，**不签 bundled 的 sing-box**。

### 4.8 `scripts/release/release.sh`

```bash
bash scripts/release/release.sh --dry-run
bash scripts/release/release.sh --version 0.1.0
```

流程：

1. 校验工作区干净（有未提交改动则拒绝，`--allow-dirty` 可跳过）。
2. 校验 `build/packages/` 里有对应版本的 DMG，且版本号三处一致。
3. 校验版本号没被用过。

三种模式，**默认不碰远端**：

| 调用 | 行为 | 远程操作 |
|---|---|---|
| `release.sh`（无参数） | 本地构建 + 打印后续要执行的全部命令 | **无** |
| `release.sh --dry-run` | 同上，显式声明 | **无** |
| `release.sh --upload --confirm 0.1.0` | 构建 → `gh release create --draft` → 上传产物 | 有，且必须人工确认 |

硬规则：

- **脚本自身绝不执行 `git push`**——不推分支、不推 tag。远程写入只发生在 `--upload` 分支里，且由 `gh` 完成。
- `--upload` 必须同时给 `--confirm <version>`，版本号要手打一致，防止复制粘贴误触。
- 上传一律用 `--draft`；**不自动发布**。正式发布由 PM 在 GitHub 上手动点。
- **P1 阶段的实际执行者是 PM**，不是脚本或 CI。脚本只负责把命令准备好。
- 任何模式都不会修改 `docs/`、不会改版本号、不会提交。

**关键差异**：Veyl 用 `--draft`，发布动作留给人在 GitHub 上点。这样误操作最多产生一个草稿，不会对用户可见。

### 4.9 `scripts/generate_icons.py`

```bash
python3 scripts/generate_icons.py
# 已接入 package.json：
npm run icons
```

**不要用 `tauri icon`**：它只做缩放，不会给 macOS 图标加圆角和边距，产出的图标在 Dock 和启动台里会顶满画布，与系统其他图标视觉不一致。

参考项目的 `generate_all_icons.js` / `gen_icons.sh` 也不能直接套用——它们的圆角是画在自己的 SVG 里的，换一张 PNG 源图就失效。

#### 输入

`aivpn.png`（仓库根目录），1024×1024 RGBA。

> 源图文件名暂时仍是 `aivpn.png`：`scripts/generate_icons.py` 里 `SOURCE = ROOT / "aivpn.png"` 是硬编码。改名提交时请连同文件一起重命名，否则脚本会报「missing source image」。

#### 两套母版

| 平台 | 处理 | 产物 |
|---|---|---|
| macOS | 824×824 圆角方块（`radius = 185`）居中放在 1024×1024 透明画布上，四周各 100px 边距（Apple Big Sur 网格） | `AppIcon.iconset/` 10 个尺寸 → `icon.icns` |
| Windows / Linux | 全出血方形，不切圆角 | `icon.ico`（16/32/48/256）、`StoreLogo.png`、`Square*Logo.png`、`32x32.png` / `64x64.png` / `128x128.png` / `128x128@2x.png` / `icon.png` |

中间母版落在 `build/icons/macos-1024.png` 与 `build/icons/square-1024.png`，便于排障时对比。

#### 依赖与行为

- Python 3 + Pillow（`PIL`）。缺 Pillow 时明确报错，不要静默降级。
- `.icns` 依赖 macOS 的 `iconutil`；非 macOS 或缺失时打印 warning 并跳过，**不失败**（Linux/Windows 构建不需要 icns）。
- 源图缺失时 `exit 1`。
- 每次运行会先删掉旧的 `AppIcon.iconset/`，避免残留尺寸。

#### 与其他脚本的关系

- **发布前必须重跑一次**，放在 `bump-version` 之后、`build-dmg` / `build-msi` 之前。
- `tauri.conf.json` 的 `bundle.icon` 已经指向 `icon.icns` / `icon.ico` / 多尺寸 png，重新生成后**不需要改配置**。
- 打包后要抽查产物里的图标是新的：macOS 解包 `.app` 看 `Contents/Resources/icon.icns` 的修改时间；Windows 直接看 MSI 安装后的快捷方式。

---

### 4.10 规则数据与运行时下载

```bash
npm run rules:fetch
npm run runtime:fetch
```

**网络路径**

- 规则：`api.github.com` 查 `rule-set` 分支头，`codeload.github.com` 按完整 commit 下载 tarball；不访问 `github.com`、`raw.githubusercontent.com`。
- 运行时：`api.github.com` 查 release asset，下载 302 到 `release-assets.githubusercontent.com`；不访问 `github.com`。
- GitHub 的 IP 会因网络策略时通时不通；重试会**重新解析 DNS 并轮换 A 记录**，错误信息带域名、实际 IP、状态码和耗时。脚本不要求代理，默认直连。

**上游信任模型（已拍板）**

规则 tarball **不做独立哈希校验**。信任根是 TLS + GitHub 官方域名（`api.github.com` / `codeload.github.com`），与原来的 `git clone https://` 是同一套信任模型；git 的 commit 哈希防的是传输损坏和中途篡改，这两点已由 TLS 覆盖。manifest 和 `SOURCE.txt` 记录完整 commit 只用于版本追溯，不构成独立的密码学校验。**不要以为这里对 tarball 做过哈希验证。**

**许可证**

sing-geosite / sing-geoip 是 GPL-3.0-or-later。`rules:fetch` 通过 `api.github.com/.../license` 取许可证，拉不到就整体失败；`LICENSE-geosite.txt`、`LICENSE-geoip.txt`、`LICENSE-GPL-3.0.txt` 会写进归档，`verify-rules.mjs` 会检查它们非空。

**runtime 产物**

`runtime:fetch` 先把 universal 写到临时文件，校验 `lipo -archs` 同时含 `x86_64`/`arm64`，实际执行 `<产物> version` 核对版本，流式计算 sha256，最后原子 `rename`；最终 `universal.sha256` 写入 `src-tauri/assets/runtime-manifest.json`。

---

## 5. 环境变量与密钥管理

### 5.1 变量表

| 变量 | 用于 | 是否进仓库 |
|---|---|---|
| `VEYL_DEV_ID_APP` | macOS 签名证书名 | 否（CI secret / 本地 shell） |
| `VEYL_NOTARY_PROFILE` | notarytool profile 名 | 否 |
| `VEYL_WIN_SIGN_CMD` | Windows 云 HSM 签名命令 | 否 |
| `VEYL_WIN_CERT_THUMBPRINT` | Windows 本地证书指纹 | 否 |
| `RUST_LOG` | 开发日志级别 | 可以有默认值 |
| `MOCK_CATALOG_PORT` / `MOCK_LLM_PORT` / `MOCK_ECHO_PORT` | 测试 mock 端口 | 有默认值即可 |

> 变量前缀已从 `AIVPN_` 改为 `VEYL_`。**改名提交落地前，脚本仍在读旧前缀**，此时以脚本实际读取的变量名为准。改名时 CI Secret 必须同时改名，否则签名步骤会报「未设置」。

### 5.2 密钥规则（硬约束，优先级高于本文档其余内容）

> 脚本可以复用 TweetPilot 的实现，但**任何凭据都不能提交到 GitHub**。这条比脚本本身更重要。

#### 5.2.1 绝对禁止

| 禁止 | 说明 |
|---|---|
| 复制 `scripts/notary-profile.key` | TweetPilot 仓库里那个文件是私钥，**任何情况下都不复制、不打开、不引用** |
| 复制 `.p12` / `.pfx` / `.pem` / `.cer` / `.mobileprovision` | 证书与描述文件一律不落仓库 |
| 记录 Apple ID 专用密码 | 只在 `notarytool store-credentials` 时交互输入一次 |
| 记录 Windows 签名凭据 | 云 HSM 用 OIDC/服务主体，本地证书用硬件令牌 |
| 把凭据写进文档、注释、示例、测试固件 | 包括「看起来是占位符」的真实值 |

#### 5.2.2 运行期规则

1. 证书/公证 profile **只从系统 keychain 或 CI secret 读取**。
2. 脚本源码里**只出现环境变量名，不出现值**。示例：`${VEYL_DEV_ID_APP:?未设置}`，而不是 `"Developer ID Application: XXX (TEAMID)"`。
3. 脚本打印环境时**必须脱敏**：只打印「已设置 / 未设置」，绝不打印值。等价于 `[ -n "$VAR" ] && echo "已设置" || echo "未设置"`。
4. 临时导出的 keychain、临时 `.p12` 用完立即删除，并用 `trap` 保证异常退出也删。
5. CI 日志里不得出现 `set -x` 展开后的变量值——凡涉及凭据的步骤关掉 trace。

#### 5.2.3 仓库卫生

- 不写死本机绝对路径（家目录展开后的具体值、`C:\Users\...` 的具体值），一律用 `$(dirname "$0")` 或 `$PROJECT_ROOT` 推导。
- **禁止 `git add -A` / `git add .`**：只按文件名添加，避免把未跟踪的密钥、产物、日志扫进去。
- `.gitignore` 只是兜底，**不是防线**；真正的防线是 §5.3 的提交前检查。

### 5.3 `scripts/check-secrets.sh` — 提交前检查

```bash
bash scripts/check-secrets.sh           # 扫描工作区
bash scripts/check-secrets.sh --staged  # 只扫已暂存文件（pre-commit 用）
```

扫描规则：

| 类型 | 匹配 |
|---|---|
| 文件名 | `*.key`、`*.p12`、`*.pfx`、`*.pem`、`*.cer`、`*.mobileprovision`、`notary-profile*`、`.env*`、`*.keystore` |
| 内容特征 | `BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY`、`-----BEGIN CERTIFICATE-----`、`Apple ID` 专用密码格式、`sk-` 开头的长串（DeepSeek/OpenAI Key） |

行为：

- 命中即 `exit 1` 并列出文件与行号；**默认拒绝**。
- `--staged` 模式供 `pre-commit` 钩子调用。
- 不联网、不上传、不修改任何文件。
- 安装钩子：`bash scripts/check-secrets.sh --install-hook`（写入 `.git/hooks/pre-commit`，不覆盖已有钩子，冲突时报错让用户手工合并）。

接入要求：

- **`scripts/ci.sh` 第一步就跑它**，跑不过后面全都别跑。
- 三人提交前都必须本地跑一次；PM 集成前也跑一次。

### 5.4 进程清理安全（所有启动类脚本）

脚本里清理子进程时，**禁止无路径限定的 `pkill -f`**。

反面例子（会误伤同机其他项目）：

```bash
pkill -f "tauri dev"          # 杀掉这台机器上所有 Tauri 项目的 dev 进程
pkill -f "node"               # 杀掉所有 node
```

正确做法——自己起的子进程，自己精确收：

```bash
set -m                                    # 打开 job control，让后台任务独占进程组
bash "$SCRIPT_DIR/dev-with-log.sh" --no-open >"$DEV_OUTPUT" 2>&1 &
SMOKE_PID=$!
SMOKE_PGID=$(ps -o pgid= -p "$SMOKE_PID" | tr -d ' ')

cleanup() {
  [ -n "${SMOKE_PGID:-}" ] && kill -TERM -"$SMOKE_PGID" 2>/dev/null
  sleep 1
  [ -n "${SMOKE_PGID:-}" ] && kill -KILL -"$SMOKE_PGID" 2>/dev/null
  lsof -ti:1430 2>/dev/null | xargs -r kill 2>/dev/null
}
trap cleanup EXIT INT TERM
```

规则：

1. **能按 PID / PGID 收的，就不要用 `pkill`**。已经存了 `$!` 却还全网 `pkill`，等于放弃了自己掌握的信息。
2. 必须用 `pkill` 兜底时，模式里要带项目绝对路径（`"$ROOT/src-tauri/target/debug/$APP_NAME"`），不能只写进程名或子命令名。
3. 按端口清理只对**本项目独占**的端口做（Veyl dev 是 1430、HMR 是 1431；mock 服务是 18080/18090/18091）。
4. `trap` 必须覆盖 `EXIT INT TERM`，正常结束和 Ctrl-C 都要清。

> 背景：`ui-smoke.sh` 初版在 cleanup 里写了 `pkill -f "tauri dev"`，任何人跑一次冒烟测试就会把同机所有 Tauri 项目的开发进程一起杀掉，包括别人正在调试的会话。

---

## 6. CI 建议

P1 阶段用一个 GitHub Actions workflow 就够。

```yaml
# .github/workflows/ci.yml（示意，由 Bob 落地）
jobs:
  test:
    strategy:
      matrix:
        os: [macos-14, windows-latest]
    steps:
      - npm ci
      - npm run typecheck
      - cargo test
      - node tests/contracts/check-contracts.mjs
  package-macos:
    if: startsWith(github.ref, 'refs/tags/v')
    runs-on: macos-14
    # build-dmg.sh，带签名与公证
  package-windows:
    if: startsWith(github.ref, 'refs/tags/v')
    runs-on: windows-latest
    # build-msi.ps1（P1 不签名）
```

要点：

- **CI 不做发布**，只产 artifact。发布走本地 `release.sh`（或后续再加 tag 触发的 release job）。
- macOS universal 必须在同一台机器上构建（`rustup target add x86_64-apple-darwin`），不能用两个 runner 拼接。
- 缓存 `~/.cargo` 与 `src-tauri/target`，但 tag 构建不缓存 `target`，避免增量构建混入旧产物。

### 6.1 介绍页与下载（GitHub Pages）

**不用自有域名。** 介绍页和下载入口都放在 GitHub Pages：

| 项 | 值 |
|---|---|
| 站点地址 | `https://aiwithblockchain.github.io/veyl/`（项目页，非组织首页） |
| 源目录 | `site/`（纯静态 HTML/CSS，**没有构建步骤**） |
| 部署 | `.github/workflows/pages.yml`，push 到 `main` 且 `site/**` 有变化时触发 |
| 启用方式 | 仓库 Settings → Pages → Source = GitHub Actions（已启用） |

为什么不做独立仓库 / 子模块：GitHub Pages 的**项目页** URL 由仓库名决定，`aiwithblockchain/veyl` 天然得到 `/veyl/`。再拆一个 `veyl-site` 仓库只会让地址变成 `/veyl-site/`，还得维护 submodule 指针。除非将来站点需要独立版本节奏或独立写入权限，否则不必拆。

> 组织的 `aiwithblockchain.github.io` 仓库已被占用（是其他产品的主站），**不要往里塞 Veyl 的内容**。

`pages.yml` 的约束：

- 只上传 `site/`，不把 `docs/`（内部设计文档）发布出去。
- 部署前检查 `site/` 里没有 `*.key` / `*.p12` / `*.pem` / `.env*`，命中即中止。
- `concurrency: pages` 且 `cancel-in-progress: false`，避免并发部署互相覆盖。
- 不做缓存，站点只有几百 KB，没必要。

**下载链接**指向 GitHub Releases，不在 Pages 上托管安装包：

- DMG / MSI 有几十 MB，占用 Pages 仓库配额。
- Releases 自带版本归档与校验和，更适合放二进制。
- 站点上的按钮在**有正式 release 之前显示「即将发布」**，不要放死链。

### 6.2 分发通道

**产物只通过 GitHub Releases 发布**，宣传页用 GitHub Pages，**不引入自有域名，也不引入对象存储**（S3 / R2 / OSS）。

| 项 | 做法 |
|---|---|
| 二进制分发 | `gh release create v<version> --draft`，上传 DMG / MSI |
| 版本标识 | 必须打 tag `v<version>`，与 `tauri.conf.json` 的 `version` 一致 |
| 宣传与下载入口 | GitHub Pages（`site/`），下载按钮指向 Releases |
| 域名 | 无。Pages 的 `github.io` 子路径就是正式地址 |
| 对象存储 | 无。不维护第二套分发链路 |

理由：Releases 自带版本归档、校验和与访问统计，再加一个对象存储等于多一份要维护的服务和一份账单。等真出现下载瓶颈（例如国内访问不稳定）再考虑镜像，而不是现在预设。

---

## 7. 明确不做

- 不做 updater / 自动更新（P1）。
- **不买自有域名、不引入对象存储**：宣传页走 GitHub Pages，二进制走 GitHub Releases（见 §6.1、§6.2）。
- 不做 license / 授权码体系。
- 不做 Linux 包（`.deb` / `.AppImage`）。
- 不在 CI 里保存 macOS 公证凭据之外的长期密钥。
- **脚本不自动 `git push`**：不推分支、不推 tag；远程操作只在人工确认后由 `gh` 执行。
- **脚本不自动发布**：只建 draft release，发布动作由 PM 在 GitHub 上点。

---

## 8. 任务拆解

优先级：**P1**（现在做）/ **P1-后置**（P1 末尾）/ **P5**（收尾）。

### 8.1 Clerk — 测试与环境

| # | 任务 | 文件白名单 | 验收 | 优先级 |
|---|---|---|---|---|
| **C0** | **`scripts/check-secrets.sh` 提交前密钥扫描** | `scripts/check-secrets.sh` | 扫描 §5.3 全部模式；命中 `exit 1` 并列出文件行号；`--staged` 与 `--install-hook` 可用 | **P1（最高）** |
| C1 | `scripts/ci.sh` 一键本地 CI | `scripts/ci.sh` | 六步顺序执行（`check-secrets` 第一）；任一失败即停并打印该步输出；`--quick` 只跑前 4 步 | P1 |
| C2 | 三个测试入口脚本 | `scripts/test/unit.sh`、`contracts.sh`、`smoke.sh` | `smoke.sh` 退出后无残留进程与端口（`trap EXIT`） | P1 |
| C3 | 把现有 `tests/` 接入 CI | `tests/**`（已存在，按需补） | `tests/run-mocks.sh --selftest` 在 CI 通过 | P1 |
| C4 | mock LLM 覆盖全部 18 个工具的错误路径 | `tests/mock-llm/**` | 每个工具至少 1 条失败剧本 | P1 |
| C5 | 加一个「发布前检查」脚本 | `scripts/test/preflight.sh` | 检查版本号三处一致、tag 不存在、产物存在、`SHA256SUMS` 生成、**图标未过期**（`icon.icns` 修改时间不早于 `aivpn.png`） | P1-后置 |

> **C0 优先于其他所有任务。** 在它落地之前，任何人提交前都要手工确认没有把凭据带进去。

### 8.2 Bob — 打包、发布、签名、版本号、图标

| # | 任务 | 文件白名单 | 验收 | 优先级 |
|---|---|---|---|---|
| B1 | `bump-version.sh` / `.ps1` | `scripts/version/**` | 三处同步 + 回读校验；`--dry-run` 不落盘；非 semver 拒绝 | P1 |
| B2 | `build-dmg.sh` | `scripts/packaging/build-dmg.sh`、`scripts/packaging/lib/sign-macos.sh` | 本地 `--skip-notarize` 能出 DMG；有证书时 `spctl -a -vv` 通过 | P1 |
| B3 | `build-msi.ps1` + 签名 hook | `scripts/packaging/build-msi.ps1`、`scripts/packaging/lib/sign-windows.ps1` | 默认出未签名 MSI；`-Sign` 无凭据时报错退出；签名失败阻断 | P1（hook 先空实现） |
| B4 | `release.sh` / `release-windows.ps1` | `scripts/release/**` | 无参数时**零远程操作**；`--upload` 必须配 `--confirm <version>`；**脚本内不出现 `git push`**；一律 `--draft`；工作区不干净时拒绝 | P1-后置 |
| B5 | 图标：接入 `npm run icons` | `package.json`（仅 `scripts.icons` 一行）、`scripts/generate_icons.py`（已存在，仅排障） | `npm run icons` 能重生成 `src-tauri/icons/`；发布流程里排在 `bump-version` 之后、打包之前；打包产物里是**新**图标 | P1 |
| B6 | `.github/workflows/ci.yml` | `.github/workflows/ci.yml` | 双平台 test job 通过 | P1-后置 |
| B7 | 正式签名流水线 | 同 B3 | `signtool verify /pa /v` 通过；SmartScreen 显示公司名 | P5 |

### 8.3 Alice — 开发启动与 UI 测试入口

| # | 任务 | 文件白名单 | 验收 | 优先级 |
|---|---|---|---|---|
| A1 | `dev-with-log.sh` | `scripts/dev/dev-with-log.sh` | 日志落 `build/logs/`；`--clean` 生效；退出打印路径 | P1 |
| A2 | `dev-with-log.ps1` | `scripts/dev/dev-with-log.ps1` | Windows 行为一致 | P1 |
| A3 | 按契约改造 `src/agent/protocol.ts` | `src/agent/**`、`src/state/chatStore.ts` | 事件名无前缀、`AGENT_EVENTS` 为唯一常量源、`source` / `args_preview` 字段到位 | P1 |
| A4 | 工具卡展示 `args_preview` 与 `next_actions` | `src/components/**` | 点击 `next_actions` 生成用户消息，不直接执行工具 | P1 |
| A5 | UI 冒烟入口 | `scripts/dev/ui-smoke.sh` | 启动应用 → 断言主窗口标题与状态栏可读 → 退出 | P1-后置 |

### 8.4 边界总表（谁不能碰什么）

| 角色 | 可写 | 禁止 |
|---|---|---|
| Clerk | `scripts/check-secrets.sh`、`scripts/ci.sh`、`scripts/test/**`、`tests/**` | `src/**`、`src-tauri/src/**`、`scripts/packaging/**` |
| Bob | `scripts/version/**`、`scripts/packaging/**`、`scripts/release/**`、`scripts/icons/**`、`.github/workflows/**` | `src/**`、`src/state/**`、`tests/**`、`scripts/check-secrets.sh` |
| Alice | `scripts/dev/**`、`src/**` | `src-tauri/src/**`、`scripts/packaging/**`、`tests/**` |
| 架构师 | `docs/**` | 全部业务代码与脚本 |

**共享文件**（`package.json`、`src-tauri/Cargo.toml`、`src-tauri/tauri.conf.json`）：只允许 `bump-version` 脚本写入，且由 PM 在发版时执行；三人都不手工改版本号。

**对所有人**：提交前跑 `bash scripts/check-secrets.sh`；不要 `git add -A`；不要提交任何 `*.key` / `*.p12` / `*.pfx` / `*.pem` / `notary-profile*` / `.env*`。

---

## 9. 开放问题

1. ~~**GitHub 仓库归属与 release 权限**~~：已确定——`aiwithblockchain/veyl`，Pages 站点为 `https://aiwithblockchain.github.io/veyl/`。`release.sh` 需要 `gh` 已登录且有 `contents: write`。
2. **Windows 构建机**：P1 是本地 Windows 机器还是 CI runner？影响 `build-msi.ps1` 的路径假设。
3. ~~**图标源文件**~~：已解决——`aivpn.png`（1024×1024 RGBA）在仓库根目录，`scripts/generate_icons.py` 已跑通。
4. **是否需要 `SHA256SUMS`**：未签名阶段对外分发时，至少提供校验和；建议 P1-后置随 `preflight.sh` 一起做。

---

## 10. 发布前固定顺序

任何一次对外构建都按这个顺序走，不要跳步：

```
1. bash scripts/check-secrets.sh          # 有凭据就停
2. bash scripts/version/bump-version.sh X.Y.Z
3. npm run icons                          # 重新生成，避免旧图标混进产物
4. bash scripts/ci.sh                     # 全绿再打包
5. bash scripts/packaging/build-dmg.sh    # macOS
   pwsh scripts/packaging/build-msi.ps1   # Windows
6. bash scripts/release/release.sh        # 默认只打印命令，不上传
7. 发布后在 GitHub 上更新 site/index.html 的下载按钮，指向新 release
```

第 3 步最容易被漏掉：改了源图但忘记重生成，打出来的包还是旧图标，而且因为 `tauri.conf.json` 没变，从配置上看不出任何异常。`preflight.sh` 落地后应加一条检查——`icon.icns` 的修改时间必须晚于 `aivpn.png`。

第 7 步目前是手工的。等 release 流程稳定后再考虑让 `release.sh` 自动改站点里的版本号与下载链接。
