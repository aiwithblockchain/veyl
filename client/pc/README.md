# veyl-cli（`client/pc`）

Veyl 的轻量级 PC 客户端：只做「导入配置 → 连节点 → 建隧道」。无登录、无支付、无创建节点、无 AI。

需求与技术设计见 [`../docs/client-apps.md`](../docs/client-apps.md) 与 [`../docs/client-apps-technical.md`](../docs/client-apps-technical.md)。

## 当前状态：骨架

这是一个**可独立构建、可独立启动**的 Tauri 2 应用，界面只有品牌页与版本号。

已包含：

- 独立工程：自己的 `package.json`、`src-tauri`、bundle id（`io.github.aiwithblockchain.veyl.cli`）、数据目录；
- 复用主客户端的 logo 与图标（`src/assets/logo.png`、`src-tauri/icons/`）；
- `app_info` 命令：前端通过 `invoke` 取名称与版本，验证 Tauri 桥接可用；
- dev / release 脚本（见下）。

**尚未包含**（交接后按技术设计实现）：

- 订阅链接与本地配置导入、持久化；
- 配置装配与 `sing-box check`；
- 隧道层：`crates/veyl-tun`（M0 抽取）、随包 sing-box、privileged helper / Windows 服务；
- 菜单栏常驻与后台运行：关闭主界面只隐藏、进程与隧道继续，从菜单栏唤回；显式退出才断开（技术设计 §3.4）；
- 节点切换、开机自启、日志页。

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
- `node_modules/`、`dist/`、`src-tauri/target/`、`build/` 都不入库。
- 骨架尚未经过编译验证；首次构建如有依赖版本问题，按构建错误调整本目录的 `Cargo.toml` / `package.json`，不要改动主客户端。
