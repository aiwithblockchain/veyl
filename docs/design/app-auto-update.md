# App 自动升级任务书（静默下载 + 提示重启）

> 日期：2026-11-28
> 状态：**待实现**
> 决策：产品负责人 2026-11-28 拍板——启动后静默检查、后台静默下载，下载完成后提示用户重启；不自动重启。
> 参考实现：TweetPilot（已真机证明可用），见 §3。

---

## 0. 结论先行

要做四块：**Tauri updater 插件与签名**、**更新清单服务**、**Rust 端的检查 / 静默下载 / 安装**、**前端提示与手动检查**。

TweetPilot 的管线可以直接复用：更新包签名 → 上传到 GitHub Release → 由 Cloudflare Worker 返回 `latest.json` 清单 → 客户端按清单校验并安装。**但交互不要照搬**：它是在用户点「更新」之后调用 `download_and_install` 并立即重启；Veyl 要的是「后台先下完，再问用户要不要重启」。

提示位置已定（2026-11-28）：**左下角设置按钮的圆点 + 连接界面顶部的提示条**；下载完成前完全静默；不提供「跳过这个版本」；发布先在 dev 环境验证，成功后再发 prod。

**前置阻塞**：macOS 必须先解决签名与公证（1.1.0 公证失败、官网下载仍 404）。没有公证，更新包装不上，自动升级无从谈起。

---

## 1. 现状

- `src-tauri/Cargo.toml` 无 `tauri-plugin-updater`；`tauri.conf.json` 无 `plugins.updater`、无端点与公钥；前端无检查更新逻辑。
- `scripts/release/release.sh` 与 `scripts/release/release-windows.ps1` 只做 DMG / MSI 构建与 GitHub 草稿 release 上传，不产出也不签 updater 资产。
- 运行时（sing-box）升级与服务器 agent 升级是另外两条链路，**不在本任务内**。

---

## 2. 目标与验收

| # | 目标 |
|---|---|
| 1 | 应用启动约 10 秒后自动检查更新，不阻塞界面；无更新、无网络都不打扰用户 |
| 2 | 有新版本时后台静默下载（有新版本才下），下载过程不抢占焦点 |
| 3 | 下载完成后给出一次**非模态**提示：新版本已就绪，可重启更新；明确说明「重启会断开当前连接」 |
| 4 | 用户点「重启并更新」后才安装并重启；用户忽略时，下次启动仍可升级 |
| 5 | 设置 › 高级 的版本行可手动「检查更新」 |
| 6 | staging 构建只连 staging 清单，生产构建只连生产清单 |
| 7 | 签名校验失败必须拒绝安装并记录；私钥不进仓库、不进日志 |
| 8 | 下载地址只用自有域名，不出现 `workers.dev` |
| 9 | 提示只出现在两处：设置按钮的圆点 + 连接界面顶部的提示条；**下载完成前完全静默** |
| 10 | 不提供「跳过这个版本」；「稍后」只收起提示，圆点保留，下次启动仍提示 |
| 11 | 发布顺序固定：先在 dev 环境完成升级验证，成功后再发 prod |

---

## 3. 参考实现（TweetPilot）

| 文件 | 复用什么 | 注意 |
|---|---|---|
| `/Users/wesley/ai/TweetPilot/scripts/release.sh` | 版本号读取、`TAURI_SIGNING_PRIVATE_KEY(_PASSWORD)` 读取、`tauri build --bundles app,updater`、上传 GitHub Release、staging/prod 分流 | 它只上传资产；清单由另一个脚本组装 |
| `/Users/wesley/ai/TweetPilot/scripts/release-windows.ps1` | Windows 侧同样的签名与上传；NSIS 产物优先 | 私钥密码只在内存，退出时清理 |
| `/Users/wesley/ai/TweetPilot/scripts/assemble-update-manifest.py` | **双平台资产齐全才允许发 prod**；从 GitHub Release 读真实签名组装清单；部署 Worker | 这是防「占位签名上线」的关键规则 |
| `/Users/wesley/ai/TweetPilot/src-tauri/src/commands/updater.rs` | 启动 10 秒后检查、`app-update-available` / 进度事件、按 feature/环境切换端点 | **交互不同**：它 `download_and_install` 后立刻 `app.restart()`；我们要拆成「先下载、后安装」 |
| `/Users/wesley/ai/TweetPilot/src-tauri/tauri.conf.json` | `plugins.updater`：`endpoints`、`dialog: false`、`pubkey` | 公钥入库，私钥只在本机 keychain / CI secret |
| TweetPilot 的 license-worker updater 路由 | `/v1/update/latest` 返回清单、下载走 Worker 代理 | Veyl 用控制面 Worker，域名用自己的 |

**参考文件绝对路径与看哪里**（实现时逐个打开对照）：

| 绝对路径 | 看什么 |
|---|---|
| `/Users/wesley/ai/TweetPilot/scripts/release.sh` | `[1/3]` 构建签名包（`--bundles app,updater`）、`[3/3]` 上传 `.tar.gz` + `.sig` |
| `/Users/wesley/ai/TweetPilot/scripts/release-windows.ps1` | 同样的签名环境变量处理；NSIS 产物优先 |
| `/Users/wesley/ai/TweetPilot/scripts/assemble-update-manifest.py` | `--env prod` 时双平台资产缺一即中止；从 Release 读 `.sig` 组装清单 |
| `/Users/wesley/ai/TweetPilot/src-tauri/src/commands/updater.rs` | `start_update_check`（10 秒后检查）、`check_for_update`（事件）、`install_update`（下载+安装+重启，**我们要拆开**）、`update_endpoint()`（staging/prod 切换） |
| `/Users/wesley/ai/TweetPilot/src-tauri/tauri.conf.json` | `plugins.updater`：`endpoints` / `dialog: false` / `pubkey` |
| `/Users/wesley/ai/TweetPilot/cloudflare/license-worker/src/routes/updater.ts` | `latest.json` 的字段形状与下载路由；Veyl 照此在控制面 Worker 实现 |

**不复用**：TweetPilot 的 license / 会话类型 / 定时器体系；Veyl 只需要「启动检查 + 手动检查」两个触发点，不要引入整套 license 轮询。

---

## 4. 技术方案

### 4.1 插件与打包

- `src-tauri/Cargo.toml`：`tauri-plugin-updater = "2"`；`main.rs` 注册 `tauri_plugin_updater::Builder::new().build()`。
- `src-tauri/tauri.conf.json`：
  - `bundle.createUpdaterArtifacts: true`；
  - `plugins.updater = { endpoints: ["https://veyl.dessage.xyz/v1/update/latest"], dialog: false, pubkey: "<公钥>" }`。
- macOS：`--bundles app,updater` 产出 `Veyl.app.tar.gz` 与 `.sig`；**必须**先 `codesign` + `notarytool` 通过。
- Windows：**新增 NSIS 目标**（updater 官方形态，产物 `Veyl_<ver>_x64-setup.exe` 与 `.sig`）；现有 MSI 保留给手动安装，不参与自动更新。
- 签名密钥：`npm run tauri signer generate` 生成，私钥放本机 keychain 或 CI secret；公钥写进 `tauri.conf.json` 并入库。

### 4.2 更新清单服务

在控制面 Worker 增加两条**无鉴权**路由（与现有 `/v1/*` 同域）：

| 路由 | 作用 |
|---|---|
| `GET /v1/update/latest` | 返回 `latest.json`；按 `X-Veyl-Channel` 或路径区分 staging / prod（与构建环境一致） |
| `GET /v1/update/download/<asset>` | 可选：代理 GitHub Release 资产，避免客户端直连 GitHub、也便于统计 |

- 域名：生产 `veyl.dessage.xyz`，dev/staging `dev.veyl.dessage.xyz`；**不使用** `workers.dev`。
- 缓存：`Cache-Control: max-age=300` + ETag；发版后 5 分钟内全量可见。
- `latest.json` 形状（Tauri v2）：

```json
{
  "version": "1.2.0",
  "notes": "本次更新…",
  "pub_date": "2026-11-28T10:00:00Z",
  "platforms": {
    "darwin-aarch64": { "signature": "…", "url": "https://veyl.dessage.xyz/v1/update/download/Veyl.app.tar.gz" },
    "darwin-x86_64":  { "signature": "…", "url": "https://veyl.dessage.xyz/v1/update/download/Veyl.app.tar.gz" },
    "windows-x86_64": { "signature": "…", "url": "https://veyl.dessage.xyz/v1/update/download/Veyl_1.2.0_x64-setup.exe" }
  }
}
```

- **prod 清单必须三个平台键齐全**，缺一个就中止发版（照 TweetPilot 的 assemble 脚本规则）；staging 允许单平台，缺失项写占位并在日志里标注。

### 4.3 Rust 端流程（关键差异）

状态机：`idle → checking → downloading → ready → installing`

1. 启动后 **10 秒**触发一次检查（`std::thread`/async spawn，不阻塞 UI；失败只记日志，不弹窗）。
2. 检查到新版本 → 立刻后台 `update.download(...)` 下载，发 `app-update-progress` 事件（约每 100ms 一次或按百分比节流）。**下载完成之前，界面上不出现任何更新提示，设置按钮也不加圆点**——静默下载就是彻底静默。
3. 下载完成 → 把字节留在内存（或临时文件）→ 发 `app-update-ready { version, notes, size }`，此时才出现提示。
4. 用户在 UI 点「重启并更新」→ 调用 `app_update_install` 命令：`update.install(bytes)` → `app.restart()`。
5. 用户忽略 → 状态保持 `ready`，本次进程内不再重复下载；下次启动重新检查。

补充规则：

- 端点选择：production 构建连生产；`staging` feature 或 dev 下 `VEYL_ENV=staging` 连 dev。**dev 构建默认不连生产**。
- 失败：检查失败静默；下载失败静默（下次启动重试）；**签名校验失败**记录错误码并拒绝安装，UI 只在手动检查时显示失败原因。
- 不引入周期轮询：一次启动一次检查即可；手动检查复用同一函数。
- 命令名建议：`app_update_check`、`app_update_install`、`app_update_status`；事件：`app-update-progress`、`app-update-ready`、`app-update-failed`。

### 4.4 前端

- 全局状态：`{ status: idle|checking|downloading|ready|installing, version?, notes?, percent?, error? }`。
- **提示位置（2026-11-28 已定）**，只放两处：
  1. **左下角 activity bar 的设置按钮**（`aria-label = activity.settings`，齿轮）：下载就绪后在这里加一个圆点，复用现有 `activity__dot` 样式；点进设置后，设置 › 高级 › 版本行显示「新版本已就绪 · 重启并更新」。
  2. **连接界面的顶部**：在顶部状态区（主按钮那一行）下方给一条非模态提示条，文案说明新版本已下载完成，两个动作——`重启并更新`（主）与 `稍后`（次）；写明「重启会断开当前连接」。
- **不能跳过版本**：不提供「跳过这个版本」。「稍后」只收起提示条与连接页横幅，设置按钮的圆点保留；下次启动仍会检查并提示。
- 下载完成前，这两处都不出现任何提示。
- 提示出现后即使用户关掉，状态保留；再次打开应用若仍是同一版本，重新检查。
- 设置 › 高级 › 版本行：显示当前版本；「检查更新」按钮；已就绪时显示「重启并更新」。
- 下载完成后即使用户关掉提示，状态仍保留；再次打开应用若仍是同一版本，重新检查。
- AI **没有**升级入口：不在工具集里加任何「升级应用」工具，也不要在对话里承诺替用户升级。
- 日志：检查结果、下载开始/完成、安装失败写 `ui_log`；不写下载 URL 以外的东西，不写签名内容。

---

## 5. 发布流程

扩展现有脚本，不新建平行脚本：

1. `scripts/release/release.sh`
   - 增加 updater 构建：`npm run tauri -- build --bundles app,updater`（macOS），产出 `.app.tar.gz` + `.sig`；
   - 读取 `TAURI_SIGNING_PRIVATE_KEY` / `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`（本机 keychain 或 CI secret，不进仓库）；
   - 把 `.app.tar.gz`、`.sig` 一并传到同一草稿 release。
2. `scripts/release/release-windows.ps1`
   - 增加 NSIS 构建与签名产物 `.exe` + `.sig`；
   - 现有 MSI 照旧上传，供手动安装。
3. 新增 `scripts/release/assemble-update-manifest.mjs`（仓库偏 Node，不必照搬 Python）
   - 读 GitHub Release 资产里的 `.sig`；
   - 生产要求三平台齐全，staging 允许缺；
   - 生成 `latest.json`、部署 Worker（或写入 Pages）。
4. `scripts/release/update-site.mjs` 继续维护官网下载区，不动。
5. 版本号三处必须一致：`package.json`、`src-tauri/Cargo.toml`、`src-tauri/tauri.conf.json`（现有 release.sh 已检查，沿用）。
6. 发布顺序（2026-11-28 已定）：**先在 dev 环境做完整升级测试，成功后再发 prod**。具体为：staging 双平台资产 → 指 dev 清单真机升级验证（下载、提示、重启、版本变化）→ 通过后才组装 prod 清单并发布。prod 每次保留上一版安装包，便于回滚。

---

## 6. 验收清单

- macOS arm64：旧版本启动 → 约 10 秒后出现「已下载」提示 → 点重启 → 版本号更新；重启后连接需重连（提示里已说明）。
- Windows x64：同上（NSIS 安装路径）。
- 无更新：启动安静，无提示、无网络请求堆积。
- 断网启动：不阻塞、不报错；恢复网络后手动检查可正常工作。
- 篡改签名：拒绝安装，日志有记录，UI 不显示「已就绪」。
- 忽略提示后重启应用：若仍未升级，再次提示；不会重复下载第二个副本。
- staging 构建：只连 staging 清单；生产构建：只连生产清单。
- 私钥：`git grep` 不到；日志里没有；CI 里只以 secret 形式存在。
- 提示位置：只在设置按钮（圆点）与连接界面顶部（提示条）出现；下载过程中两处都没有提示。
- 点「稍后」：提示条收起、圆点保留；重启应用后仍会提示；界面里没有「跳过这个版本」。
- 发布流程：dev 清单升级验证通过后才允许发 prod（清单脚本对 prod 校验双平台齐全）。

---

## 7. 分阶段实施（建议按序，每段独立验收）

| 阶段 | 内容 | 验收 |
|---|---|---|
| A | 插件 + 签名 + 本地清单（伪造指向本机文件的 `latest.json`） | 开发机能完成一次「下载→重启→版本变化」 |
| B | Rust 检查 / 静默下载 / 安装命令 + 事件 | 单测 + 手动命令触发；失败路径（断网、错签名）正确 |
| C | 前端提示、设置行手动检查 | 真实界面走一遍：无更新 / 有更新 / 下载中 / 已就绪 / 忽略 |
| D | Worker `/v1/update/*` + manifest 组装脚本 | staging 清单可被客户端读取；prod 缺平台时脚本拒绝发版 |
| E | 发布脚本扩展 + 双平台真机验收 + 文档 | §6 全部通过 |

每阶段一个小 diff、一次评审、一次提交；不要合并成一个大批次。

---

## 8. 已定的产品口径（2026-11-28）

1. 提示只放两处：设置按钮圆点 + 连接界面的顶部提示条；下载完成前完全静默。
2. 不能跳过版本；只有「稍后」，圆点保留。
3. 先 dev 测试，成功后再 prod。
4. 更新期间正在连接：只提示「会断开」，不阻止更新。

仍待定（非产品口径，实现时处理）：Windows 代码签名是否购买、是否做差分更新（tauri 默认整包，建议先不做）。

---

## 9. 风险与前置

- **macOS 公证**：当前 1.1.0 公证失败；这是自动升级的硬前置，必须先解决。
- **Windows 未签名**：SmartScreen 会拦；是否购买代码签名另行决定。
- **更新会断开连接**：安装后应用重启，VPN 必须重连；文案必须写明。
- **整包下载**：Tauri 默认整包更新，不做差分；包体约 10–20 MB，需在清单与日志里控制频率。
- **旧版本兼容**：清单里的 URL 必须长期可用；不要覆盖旧版本资产。
