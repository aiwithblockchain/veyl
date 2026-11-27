# veyl-cli（`client/pc`）

Veyl 的轻量级 PC 客户端：只做「导入配置 → 连节点 → 建隧道」。无登录、无支付、无创建节点、无 AI。

需求与技术设计见 [`../docs/client-apps.md`](../docs/client-apps.md) 与 [`../docs/client-apps-technical.md`](../docs/client-apps-technical.md)。

## 当前状态：M1-B（macOS 连接闭环）

这是一个**可独立构建、可独立启动**的 Tauri 2 应用。已实现：

- 独立工程：自己的 `package.json`、`src-tauri`、bundle id（`io.github.aiwithblockchain.veyl.cli`）、数据目录；
- 复用主客户端的 logo 与图标（`src/assets/logo.png`、`src-tauri/icons/`）；
- **订阅导入**：粘贴 `https://veyl:<令牌>@主机/v1/mobile/profile` 或选本地 sing-box JSON；拉取按 §6.2（Basic 认证、10s/20s 超时、512 KiB 上限、不跟随重定向），401/403/429/5xx 映射成同步状态；
- **配置装配**：按技术设计 §3.2 只改 `inbounds` / `experimental` / `log`，其余字段原样保留；结构校验 + 有内核时跑 `sing-box check`；
- **持久化**：`profiles.json` 存元数据（不含链接），原始配置与装配预览存 `profiles/<id>/`，均 0600 原子写；令牌进系统钥匙串（debug 默认本地加密文件，可用 `VEYL_CLI_SECRET_BACKEND` 切换）；
- **界面**：配置列表 + 导入弹层 + 详情（节点列表、同步状态、重命名/删除/刷新），沿用主客户端的 token 与字号。

- **连接（仅 macOS）**：随包 sing-box 与规则归档、特权 helper 与 LaunchDaemon、连接 / 断开 / 就绪判定 / 状态与计时器、节点热切；
- macOS 的 `dev.sh` / `release-dmg.sh` 会把 helper、`Contents/Library/LaunchDaemons/com.veyl.cli.helper.plist`、`Contents/Resources/runtime/sing-box` 与规则装进包，并按「嵌套 Mach-O → .app」签名。

**TUN 需要真实签名证书**：SMAppService 只认签名 `.app`；helper 验对端签名，随包 runtime 也必须由同一 Team 签过。脚本会按证书主体的 OU 选证书（默认 Team `2XYK8RBB6M`），没有匹配证书时退回 ad-hoc——那种构建能看界面，但连不上。

**尚未包含**（下一阶段）：

- 菜单栏常驻与后台运行：关闭主界面只隐藏、进程与隧道继续，从菜单栏唤回；显式退出才断开（技术设计 §3.4）；
- 开机自启、日志页；
- Windows 服务与安装包。

## 前置

- Node.js（`^22.22.2 || ^24.15.0 || >=26.0.0`）
- Rust 1.77+
- macOS：Xcode Command Line Tools；Windows：MSVC 工具链
- 首次使用先安装依赖：

```bash
cd client/pc && npm install
```

## 脚本

### 开发（macOS）

```bash
bash client/pc/scripts/dev.sh
```

构建 debug `.app` → 安装到 `/Applications` → 前台启动。可选 `--detach` / `--no-open` / `--kill-existing`。

- 默认 ad-hoc 签名；需要证书时设 `VEYL_CLI_SIGN_IDENTITY`。
- 日志：`client/pc/build/logs/dev-<时间戳>.log`。
- 安装目录可用 `VEYL_CLI_INSTALL_DIR` 覆盖。

### 开发（Windows）

```powershell
powershell -ExecutionPolicy Bypass -File client\pc\scripts\dev.ps1
```

构建 debug 版 → 前台启动。可选 `-Detach` / `-NoOpen` / `-KillExisting`。

### 发布 DMG（macOS）

```bash
bash client/pc/scripts/release-dmg.sh
```

默认 universal（arm64 + x86_64）；本机没装 x86_64 target 时加 `--current-arch`。

- 自动挑 `Developer ID Application` 证书；没有则 ad-hoc 并跳过公证。
- 公证需要 `VEYL_CLI_NOTARY_PROFILE`；只签名不公证用 `--skip-notarize`。
- 产物：`client/pc/build/packages/veyl-cli-<version>.dmg`。

## 目录

```
client/pc/
  src/                      React 界面（品牌页 + 版本）
  src-tauri/                Tauri 工程
    capabilities/           窗口权限（core:default）
    icons/                  从主客户端复制的图标
  scripts/dev.sh            macOS 开发包
  scripts/dev.ps1           Windows 开发包
  scripts/release-dmg.sh    macOS DMG
  build/                    脚本产物（日志、DMG；已被 .gitignore 忽略）
```

开发端口是 **1440**（主客户端是 1430），两个 dev server 可以同时开。

## 交接边界

1. **M0（先做，动主客户端）**：按技术设计 §2.2 抽取 `crates/veyl-tun`，参数化 §2.3 的标识符；主客户端行为不变。
2. **M1（本目录）**：
   - 订阅拉取与存储（技术设计 §6.2 / §6.3）；
   - 装配规则（§3.2）：保留 `outbounds` / `dns` / `route` / `http_clients`，重写 `inbounds`，注入自己的 `clash_api`；
   - 连接流程（§3.3）与失败处理（§8）；
   - 菜单栏常驻、关窗后台运行与显式退出（§3.4）；
   - 开机自启（§3.4）。
3. 接入 TUN 时同步补脚本里标注的 `TODO(TUN)`：dev.sh 的构建 helper 与安装服务步骤、release-dmg.sh 的包内组件步骤。

## 注意

- 本目录是独立应用：不要从仓库根目录的 `src/`、`src-tauri/` 直接 import；共享只通过仓库内 crate 与复制静态资源。
- **Windows 发布包（NSIS）脚本尚未提供**：当前只有 macOS 的 `release-dmg.sh`。
- **单实例插件尚未接入**：重复启动会起第二个进程；菜单栏 / 托盘接入时一并补。
- `node_modules/`、`dist/`、`src-tauri/target/`、`build/` 都不入库。
- 骨架已验证：debug 构建、`dev.sh` 的构建 / 签名 / 安装 / 启动冒烟、`release-dmg.sh` 的本机与 universal 两条路径、DMG 校验和均通过（2026-11-25）。首次构建如遇依赖版本问题，只改本目录的 `Cargo.toml` / `package.json`，不要改动主客户端。
