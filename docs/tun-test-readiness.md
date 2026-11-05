# TUN 测试就绪报告

> 2026-11-05 · 只做审计，未构建、未启动应用、未改代码。
> 结论先说：**能测，但必须先设 `VEYL_DEV_ID_APP` 打签名包**；开发态无解。
> 打包路径里有一处会让 TUN **一定起不来**的缺口（运行时哈希），本文给出绕过它做这一轮测试的临时办法，以及正式修法。

---

## 0. 一句话结论

| 问题 | 结论 |
|---|---|
| `tauri dev` 能测 TUN 吗 | **不能**，而且没有安全的本地调试旁路（§1） |
| 怎么测 | 用 Developer ID 签名的 `.app`，装到 `/Applications`，`--skip-notarize` 即可（§2） |
| 代码层面通不通 | 除「运行时哈希」一处外都就绪；那一处不修，第一次 start 必失败（§3.1） |
| 用户要做几步 | 打包 1 步、安装 1 步、首次授权 1 步，之后点连接（§4） |
| 最可能卡在哪 | ①运行时哈希（§3.1）②证书 Team ID 用错（§3.2）③首次注册后没有重试（§2.4） |

---

## 1. 开发态为什么不行

### 1.1 判据链

`SMAppService.daemon(plistName:)` 不是「查一下进程状态」，它查的是 **launchd 里有没有这个 daemon 的注册记录**。这条记录只有在下面四项同时成立时才存在：

1. **调用方是一个 .app bundle**（不是 `target/debug/veyl` 这种裸二进制）；
2. bundle 里存在 `Contents/Library/LaunchDaemons/com.veyl.helper.plist`（`src-tauri/src/tun/privilege/smappservice.rs:18-19`）；
3. plist 里的 `BundleProgram` 指向 `Contents/MacOS/veyl-helper`（`src-tauri/resources/launchd/com.veyl.helper.plist:19-20`）；
4. App 与 helper **同一个 Team ID 的 Developer ID 签名**，helper 带 hardened runtime。

不满足时 `status()` 返回 `NotFound`（`smappservice.rs:76-80`，映射见 `:122-130`），启动日志里就是 `启动 TUN helper=not_found`（`src-tauri/src/lib.rs:126-131`）。

`tauri dev` 跑的是 `src-tauri/target/debug/veyl`——**连 bundle 都不是**，第 1 条就不成立，后面三条无从谈起。这不是"签名没配好"，是结构上不成立。

`smappservice.rs:162-173` 那条测试（`querying_status_outside_a_signed_bundle_is_safe`）已经把这个事实钉住了：在未打包二进制上永远不是 `Enabled`。

### 1.2 有没有安全的本地调试路径

**没有值得做的。** 理论上可以在本地手工拼一个 `.app` 包住 debug 二进制再签名，但那已经等价于走打包流程，只是多了一堆一次性的手工步骤，收益为零。

`docs/tun-privilege.md:8-9` 与 `src-tauri/src/tun/privilege.rs:1-4` 明确写过：**「用管理员弹窗直接拉进程」的调试通道被删除过，理由是它绕过验签**。这里不再把它列为可选项。

**结论：开发态不可测，必须出签名包。**

---

## 2. 打包测试的最小路径

### 2.1 命令

```bash
VEYL_DEV_ID_APP="Developer ID Application: Yushian (Beijing) Technology Co., Ltd. (2XYK8RBB6M)" \
  bash scripts/packaging/build-dmg.sh --skip-notarize
```

- `VEYL_DEV_ID_APP` 的完整名字必须与 `security find-identity -v -p codesigning` 的输出逐字一致。本机可用的是第 4 条：
  `Developer ID Application: Yushian (Beijing) Technology Co., Ltd. (2XYK8RBB6M)`
- **`--skip-notarize` 不需要 `VEYL_NOTARY_PROFILE`**；脚本只在非 skip 模式下检查它（`build-dmg.sh:78-92`）。
- 不要用 `Apple Distribution` 或 `Apple Development`：前者用于 App Store 分发，后者是开发证书，都不满足 `anchor apple generic` + Developer ID 的验签要求。

### 2.2 为什么必须设 `VEYL_DEV_ID_APP`

不设时 `sign-macos.sh:38-51` 走 `codesign --force --sign -`，即 **ad-hoc 签名**。ad-hoc 会失败两次：

1. **注册**：SMAppService 需要有效的签名身份，ad-hoc 拿不到 `Enabled`（Apple 的 Service Management 文档与多份实践记录一致：ad-hoc 不行）；
2. **验签**：即使注册侥幸成功，helper 的对端要求是
   `anchor apple generic and identifier "io.github.aiwithblockchain.veyl" and certificate leaf[subject.OU] = "2XYK8RBB6M"`
   （`src-tauri/src/tun/protocol.rs:35-39`）。ad-hoc 没有 Apple 锚点、没有证书链、没有 OU，**所有连接会被拒**（`macos.rs:91`、`:104-110`）。

所以：**`--skip-notarize` 可以用，但 `VEYL_DEV_ID_APP` 必须设。**

### 2.3 产物与安装

| 东西 | 位置 |
|---|---|
| `.app` | `src-tauri/target/universal-apple-darwin/release/bundle/macos/Veyl.app`（已签名） |
| DMG | `build/packages/Veyl-<version>.dmg`（`build-dmg.sh:269-279`） |

**必须装到 `/Applications`。** 两条独立的硬要求：

- 系统的 daemon 开机自举要求 App 在 `/Applications`（`docs/tun-privilege.md:85-88`）；
- helper 自己也校验：`ensure_bundle_trusted()` 要求 bundle 真实路径在 `/Applications` 之下（`macos.rs:749-770` → `trust.rs:148-170`）。

直接从构建目录拖也行，用 `ditto` 更像用户安装：

```bash
ditto "src-tauri/target/universal-apple-darwin/release/bundle/macos/Veyl.app" "/Applications/Veyl.app"
```

本机构建的包没有 quarantine 属性，Developer ID 签名 + 未公证在**本机**可以正常运行；Gatekeeper 那一步的警告正是预期（`build-dmg.sh:293-298`）。

### 2.4 首次连接的流程（会看到什么）

1. 新建配置时选 TUN（`src/components/NewConfigDialog.tsx:15`，默认就是 TUN），点连接；
2. 第一次会**失败**并返回 `tun_denied`，同时自动打开「系统设置 › 登录项与扩展」。
   调用链：`ensure_registered()` → `status() == NotRegistered` → `registerAndReturnError()` → 仍是 `RequiresApproval` → `open_login_items()` + 报错（`smappservice.rs:52-74`）；
3. 用户在系统设置里把 Veyl 的后台助手打开；
4. **再点一次连接**——App 不会自动重试，这是当前行为，不是 bug。

> 重装/换包后如果一直注册失败，是 SMAppService 的已知脾气：旧注册还在时需要先 `unregister`。目前 App 内**没有卸载入口**（`Registration::unregister` 已实现但全仓无调用点）。临时处理见 §6.2。

---

## 3. 代码层面逐项核对

### 3.1 【缺口 · P0】签名之后，包内运行时的哈希与 helper 里编译的值对不上

这是本轮审计最重要的发现。**不处理的话，签名包第一次连接也会失败**，报 `runtime_missing`。

链路：

1. `build.rs:34-42` 在 cargo 构建时对 `src-tauri/resources/runtime/sing-box` 算 sha256，编进 helper（`VEYL_RUNTIME_SHA256`）；
2. `build-dmg.sh:199-212` 把同一个文件**原样**复制进 `Contents/Resources/runtime/sing-box`；
3. `sign-macos.sh:54-74` 的 `sign_nested_files` 会遍历 `Contents` 下**所有 Mach-O 文件**并逐个签名——这个 sing-box 也是 Mach-O，所以会被 `codesign --force --sign …` **重签**；
4. 重签会改写文件字节。实测（本机，同一个文件，ad-hoc 重签）：

   ```
   签名前 sha256 = 2b956ab2…641e
   签名后 sha256 = e7c7128f…f9ec
   ```

5. helper 启动时 `stage_runtime()` 读的是**包内那份**，拿它去比对编译进来的哈希（`macos.rs:562-584`）→ 必然不等 → `runtime_missing`，「安装包内的运行时与编译进 helper 的哈希不一致，拒绝执行」。

规则归档不受影响：`.tar.zst` 不是 Mach-O，不会被重签（`build-dmg.sh:242-254` 的落点校验通过）。

**两个修法（本轮未改代码）：**

- **A. 只修打包脚本（适合 `--skip-notarize` 的测试包）**：
  `sign_nested_files` 跳过 `Contents/Resources/runtime/sing-box`，并在签名后断言「包内运行时 sha256 == 源文件 sha256」。已实测 `codesign --deep` **不会**回头给 Resources 下的裸 Mach-O 签名，所以跳过就真的不会变。缺点是正式发布要公证时，未签名的可执行文件可能被 notary 拒。
- **B. 改 helper（发布前必须）**：
  helper 不再用编译期哈希去比 bundle 里的文件；bundle 的完整性由已做的 `SecStaticCodeCheckValidity`（`macos.rs:642-700`，含 nested code 与 strict validate）保证，复制到 root 目录后以**复制那一刻**的哈希命名 `<root>/runtime/<sha>`，之后每次 start 校验 staged 文件与目录名一致。

**这一轮想先测起来、不想改代码的临时办法**（安全，且不削弱任何校验）：手工把**未签名的那份**预置到 helper 自己的目录，路径用 helper 里编译进去的哈希：

```bash
DIGEST="$(shasum -a 256 src-tauri/resources/runtime/sing-box | awk '{print $1}')"
sudo mkdir -p "/Library/Application Support/Veyl/runtime/$DIGEST"
sudo chmod 700 "/Library/Application Support/Veyl/runtime"
sudo install -m 0755 -o root -g wheel \
  src-tauri/resources/runtime/sing-box \
  "/Library/Application Support/Veyl/runtime/$DIGEST/sing-box"
```

`resolve_runtime()` 发现目标已存在就跳过复制，只做 `verify_file`（root、0755、完整哈希，`macos.rs:528-556` / `trust.rs:187-228`），这份预置文件正好满足。测完记得清理（§6.2）。

> 前提：构建之后 `resources/runtime/sing-box` 没换过。换过的话用
> `strings "/Applications/Veyl.app/Contents/MacOS/veyl-helper" | grep -E '^[0-9a-f]{64}$'`
> 从二进制里取出真正的值。

### 3.2 【缺口 · P1】Team ID 写死在 build.rs，证书必须对得上

`build.rs:19-27` 的默认 Team ID 是 `2XYK8RBB6M`（Yushian）。`protocol::app_requirement()` 用它拼验签要求。

- 用 **Yushian** 证书：不用动。
- 用 **Lendger, Inc (6A53CAFMZ9)**：必须在**构建 helper 时**（不是签名时）设 `VEYL_TEAM_ID=6A53CAFMZ9`，否则 requirement 与证书 OU 不一致，**所有 XPC 连接被拒，且编译期无感**。

这不是可以"试试看"的差异——症状和 §1 的 `not_found` 很像，但根因不同。

### 3.3 逐项检查表

| 项 | 状态 | 依据 |
|---|---|---|
| `veyl-helper` 真的被构建 | **已就绪** | `Cargo.toml:20-22` 显式 `[[bin]]`；`build-dmg.sh:134-165` 解析它并为两个架构分别 `cargo build --bin`，再 `lipo` 合成 |
| universal 合成 | **已就绪** | 同上；`lipo -create aarch64 + x86_64` → `target/universal-apple-darwin/release/veyl-helper` |
| helper 进包 | **已就绪** | `build-dmg.sh:180-190` 复制到 `Contents/MacOS/`，`chmod 755`；其它 `[[bin]]` 会被删掉 |
| LaunchDaemon plist 落点 | **已就绪** | `build-dmg.sh:192-197` → `Contents/Library/LaunchDaemons/com.veyl.helper.plist` |
| `MachServices` 名字 | **未验证** | plist 用 `com.veyl.helper`，没有 Team ID 前缀。`docs/tun-privilege.md:279-288` 已把它列为待验证项；社区样本两种写法都有。首次连接若注册成功但连不上，先怀疑这里 |
| XPC 客户端连接 | **已就绪** | `tun/xpc.rs:167-220`；`resume` 前先装 handler 的坑已修（`:180-186` 注释记录了一次真实崩溃）；服务不在时返回 `Unavailable` 而不是挂住 |
| 对端验签 | **已就绪（依赖证书）** | `macos.rs:91`、`:104-110` 对 listener 与每个 connection 各设一次 requirement；`protocol.rs:35-39` 的 identifier 由 `build.rs` 从 `tauri.conf.json` 读入，有测试比对 |
| 证书/Team ID | **见 §3.2** | — |
| euid 判断 | **已就绪** | `macos.rs:41-46` 非 root 直接 `exit(1)`；`is_root()` 在 `:982-985` |
| 信任根 | **已就绪** | 本机实测 `/Library` 与 `/Library/Application Support` 都是 root 且无 group/other 写位，`Veyl/` 尚不存在，helper 会在首启时以 root 创建；逐级 lstat 见 `macos.rs:706-745`、`trust.rs:75-145` |
| 配置形状（allowlist） | **已就绪** | 生成器实际会产出的键逐一比对过 `protocol.rs:48-190` 的白名单，无越界键；`protocol.rs:629-666` 有真实形状测试 |
| `sniff → hijack-dns` 顺序 | **已就绪** | `builder.rs:207-221` 固定前置；`:703-718` 有断言；helper 不改顺序（`protocol.rs:164-190`） |
| `route_exclude_address` | **已就绪** | `builder.rs:189-204`；`validate_input` 拒绝空表（`:310-320`）；真实 sing-box 1.14.4 的 `check` 覆盖了三种分流模式（`src-tauri/tests/generated_config_check.rs:185-208`） |
| 运行时从 `/Library/Application Support/Veyl` 读 | **有缺口** | 路径与校验本身就绪（`macos.rs:224-226`、`:537-584`），但见 §3.1 |
| 规则归档解包/校验 | **已就绪** | `macos.rs:235-320`；归档非 Mach-O，不被重签；`build.rs:44-66` 的哈希绑定成立 |
| 包内资源落点（Tauri 推断） | **构建期断言** | `build-dmg.sh:235-254`：`Contents/Resources/runtime/sing-box` 与 `Contents/Resources/resources/rules/*.tar.zst` 必须存在且哈希一致，否则打包失败。**注意：这条路径从未在真实产物上跑过**（`build/packages` 是空的，上一次打包日志是旧仓库 `aivpn` 的） |
| 退出时停 TUN | **设计如此，需告知** | `lifecycle.rs:340-379` 只停 `manager`，不调 `tun.stop()`；App 退出后隧道仍在（`docs/tun-privilege.md:186-215` 的产品决定）。测完要自己断开 |
| 卸载 helper 的入口 | **缺口 · P2** | `Registration::unregister` 实现了但无调用点，App 内无法注销 |

---

## 4. 测试步骤

> 需要 root/sudo、需要改系统设置。建议由产品负责人在自己机器上跑。

### 步骤 0 · 准备（2 分钟）

```bash
scutil --proxy                                              # 应该全是 0
netstat -rn -f inet | grep '^default'                       # 指向路由器，不是 utun
ifconfig | grep -c '^utun'                                  # 记下数量
curl -s --max-time 10 https://api.ipify.org; echo           # 记下「基线 IP」
```

顺手确认没有别的 VPN 在抢路由。

### 步骤 1 · 打包（一条命令，约 5–15 分钟）

```bash
VEYL_DEV_ID_APP="Developer ID Application: Yushian (Beijing) Technology Co., Ltd. (2XYK8RBB6M)" bash scripts/packaging/build-dmg.sh --skip-notarize
```

**打包前必须先决定 §3.1 怎么处理**：要么先按 A 改一行脚本，要么打包后按 §3.1 的临时办法预置运行时。

### 步骤 2 · 安装

```bash
ditto "src-tauri/target/universal-apple-darwin/release/bundle/macos/Veyl.app" "/Applications/Veyl.app"
```

先退出正在运行的旧实例（单实例插件会把第二个进程直接 `exit(0)`）。

### 步骤 3 · 首次连接与授权

1. 启动 `/Applications/Veyl.app`，新建一套 TUN 配置（对话框默认就是 TUN），连上节点；
2. 点「连接」→ 预期**失败**并弹出/打开「系统设置 › 登录项与扩展」；
3. 打开 Veyl 的后台助手开关；
4. 回到 App 再点一次「连接」。

### 步骤 4 · 判定 TUN 真的生效（四条独立证据）

| # | 检查 | 命令 | 通过的标准 |
|---|---|---|---|
| 1 | 接口 | `ifconfig \| grep -A3 utun` | 多出一个 `utunN`，地址含 `172.19.0.1` |
| 2 | 路由 | `netstat -rn -f inet \| grep -E '^(default\|0/1\|128.0/1)'` | 出现 `0.0.0.0/1`、`128.0.0.0/1` 指向 utun（`proxy_all`）；`direct` 模式默认路由应仍在物理网卡 |
| 3 | 出口 | `curl -s --max-time 15 https://api.ipify.org; echo` | 与基线 IP 不同（`direct` 模式下访问国内网站应仍走本地） |
| 4 | 进程 | `pgrep -fl 'sing-box run'`、`launchctl print system/com.veyl.helper \| head` | sing-box 的父进程是 `veyl-helper`，不是 Veyl |

App 内的 `tun_device_up` 只等 1.5 秒（`services.rs:3484-3496`）；**首连时它可能是 `false` 而实际很快就起来了**，以系统层证据为准。

### 步骤 5 · 停止

在 App 里断开。验证：

```bash
ifconfig | grep -c '^utun'          # 回到步骤 0 的数量
netstat -rn -f inet | grep '^default'
curl -s --max-time 10 https://api.ipify.org; echo   # 回到基线 IP
```

> **直接退出 App 不会断开 TUN**（§3.3 表最后几行）。要断开请在界面里断开，或按 §6.2 手工处理。

### 步骤 6 · 失败时退回 proxy 模式

TUN 失败不会降级成系统代理（`services.rs:3413-3420` 的设计说明与各类返回码）。手工退回：

1. App 里改选一套 `system_proxy` 配置并连接；或
2. 若 App 连不上，按 §6.3 清理后重开。

---

## 5. 已知缺口：测试时**不要**当 bug 报

| 编号 | 现象 | 原因 |
|---|---|---|
| GAP-03 | 连接瞬间返回的 `VpnConnect` 结果比 `RuntimeStatus` 少 12 个字段：`upstream_version`、`uptime_seconds`、`latency_ms`、`node_latency_ms`、`direct_ip`、`config_hash`、`health`、`traffic`、`connections`、`restart_count`、`last_error`、`last_transition_at`；其中 `health`/`traffic`/`node_latency_ms` 拿不到真值 | TUN 的连接返回值仍是手拼 JSON（`services.rs:3518-3532`）；后续 `RuntimeStatus` 查询已经复用结构体（`manager.rs:172-208`），但连接响应这条路径没改 |
| GAP-02 | helper 的 sing-box 日志无上限 | `macos.rs` → `~/.veyl/helper-logs/sing-box.log`，启动时按 5 MiB 轮转一份。测完 `ls -lh` 看一眼大小 |
| 面板延迟 | TUN 连接后节点延迟一直显示「确认中…」 | TUN 不经过 `RuntimeManager`，没有 Clash 延迟探测通道；`node_latency_ms` 恒为 null（`manager.rs:188-189`） |
| 首连 `tun_device_up=false` | 见 §4 步骤 4 | 1.5 秒固定等待，不是真实失败 |
| 改分流/切节点对已连接无效 | 连接中点其它节点或改路由，隧道行为不变 | TUN 不进 `RuntimeManager`，没有热切与看门狗（`docs/tun-privilege.md:262`、`session.rs:1-5`） |
| 退出 App 后仍在连接 | 见 §3.3 | 产品决定：App 崩溃不打断隧道 |

---

## 6. 风险与善后

### 6.1 签名会不会弹密码

`codesign` 需要访问 Developer ID 私钥。若登录钥匙串已解锁且该密钥的 ACL 允许 `codesign`，不会弹；否则会弹一次登录密码。想避免中途卡住，先在终端执行一次：

```bash
security unlock-keychain ~/Library/Keychains/login.keychain-db
```

另外 `--timestamp` 会联网向 Apple 的 timestamp 服务取值，**离线时 codesign 会失败**（`sign-macos.sh:45-48`）。

### 6.2 卸载干净

```bash
# 1) 先停掉 daemon 与隧道
sudo launchctl bootout system/com.veyl.helper 2>/dev/null || true
sudo pkill -f '/Library/Application Support/Veyl/runtime/.*/sing-box' 2>/dev/null || true

# 2) 删 App（helper 与 plist 都在 App 内，随 App 一起没了）
rm -rf /Applications/Veyl.app

# 3) 删 root 侧的信任根与运行数据
sudo rm -rf "/Library/Application Support/Veyl"

# 4) 确认没有残留
launchctl print system/com.veyl.helper 2>&1 | head -3
pgrep -fl 'sing-box|veyl-helper'
```

`SMAppService` 的注册记录会随 App 删除被系统回收；如果重装后一直注册失败，先做第 1、2 步再装。

### 6.3 测失败后确认没留下系统代理 / 残留进程

```bash
scutil --proxy                                  # HTTPEnable/HTTPSEnable/SOCKSEnable 应为 0
netstat -rn -f inet | grep '^default'           # 应回到物理网卡
ifconfig | grep -E '^utun'                      # 不该多出 172.19.0.1 的那个
pgrep -fl 'sing-box run|veyl-helper'
```

- 有残留 utun：`sudo pkill -f "sing-box run"`。路由绑在接口上，接口消失内核会一并删掉，一般不需要手工 `route delete`。
- 默认路由还指着不存在的接口：
  `sudo route -n delete -inet 0.0.0.0/1`、`sudo route -n delete -inet 128.0.0.0/1`。
- 系统代理没撤：`networksetup -setwebproxystate <服务名> off` / `-setsecurewebproxystate` / `-setsocksfirewallproxystate`，服务名用 `networksetup -listallnetworkservices` 查。

---

## 7. 给 PM 的验收清单

- [ ] `docs/tun-test-readiness.md` 六问全部回答，缺口有文件:行号
- [ ] §3.1 的哈希缺口被确认（不是误报）：签名会改写运行时字节，helper 比对的是包内文件
- [ ] §3.2 的 Team ID 与证书对应关系写清楚
- [ ] 打包命令可直接复制执行，`VEYL_DEV_ID_APP` 是完整证书名
- [ ] 测试步骤里包含「首次授权会先失败一次」这一预期
- [ ] 已知缺口列表可直接贴在测试单上，避免被当 bug 报
