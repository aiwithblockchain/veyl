# 生命周期与常驻用例（P1.5 wave1）

> 覆盖 `docs/phase-1-5-requirements.md` §4（A. 常驻与生命周期）与 §11 的 A1–A7。
> 执行者：不需要懂代码，照步骤点击与观察即可；**所有命令原样复制粘贴**。
> 应用**一律由用户手动启动**，不要用脚本代启。

---

## 0. 执行前准备

### 0.1 启动应用

**由用户手动启动**（二选一，按当前构建方式）：

- 开发构建：在项目目录执行 `./scripts/dev/dev-with-log.sh`，或在 Finder 里双击
  `src-tauri/target/debug/veyl`
- 打包版：双击 `Veyl.app`

启动后确认窗口出现、菜单栏（屏幕右上角）出现 Veyl 图标。

### 0.2 采集「干净基线」

**在连接任何节点之前**执行下面这一组，把输出贴进证据文件：

```bash
APP='target/debug/veyl|Veyl.app/Contents/MacOS'
pgrep -fl "$APP" || echo "应用未运行"
pgrep -fl 'sing-box run' || echo "无 sing-box 进程"
scutil --proxy | grep -E 'HTTPEnable|HTTPSEnable|SOCKSEnable'
find "$HOME/Library/Application Support/Veyl/config" -type f 2>/dev/null | wc -l   # 0 = 空
find "$HOME/Library/Application Support/Veyl/config" -type f >/dev/null 2>&1 || echo "config 目录不存在"
```

基线应当是：

- 应用有 1 个进程
- 无 sing-box
- 三个开关都是 `0`
- `config/` 为空或不存在

**这条基线后面每一步都要对照**：任何一次 `Enable=1` 都说明代理还开着，必须先处理，否则后面整轮测试都不可信。

### 0.3 通用证据命令

```bash
# 应用进程数（单实例用例用）
pgrep -f 'target/debug/veyl|Veyl.app/Contents/MacOS' | wc -l

# 运行时进程
pgrep -fl 'sing-box run'

# 系统代理三项
scutil --proxy | grep -E 'HTTPEnable|HTTPProxy|HTTPPort|HTTPSEnable|HTTPSProxy|HTTPSPort|SOCKSEnable|SOCKSProxy|SOCKSPort'

# 渲染出来的明文配置
find "$HOME/Library/Application Support/Veyl/config" -type f 2>/dev/null | wc -l
ls -A "$HOME/Library/Application Support/Veyl/config/" 2>/dev/null

# 运行时 pid 文件
cat "$HOME/Library/Application Support/Veyl/runtime.pid" 2>/dev/null || echo "runtime.pid 不存在"

# 直连出口（判断网络是否恢复）
curl -sS --max-time 10 --noproxy '*' https://ifconfig.me/ip
```

> `curl` **不读** macOS 系统代理。判断「代理是否生效」只看 `scutil --proxy`；
> 判断「能不能上网」用上面的 `--noproxy '*'` 直连命令，或用浏览器打开任意网站。

---

## A1 连接中关闭窗口 → 进入后台

- **追溯**：R2 / §4.3；验收 A1
- **前置**：应用已启动；已连接任一节点（状态面板显示「已连接」）
- **步骤**（用户在界面上操作）：
  1. 记下当前连接状态与出口 IP（面板上显示的）
  2. 点击窗口左上角**红色关闭按钮**（或按 `Cmd+W`）
  3. 观察：窗口是否消失？有没有弹出任何提示？
  4. 看菜单栏右上角 Veyl 图标：是否还在？图标是否仍显示「已连接」形态？
  5. 打开浏览器访问任意网站
- **观察点**：
  - 窗口消失、**没有任何对话框**
  - 菜单栏图标仍在，且形态是「已连接」
  - 浏览器能正常上网
- **通过标准**：
  1. 窗口消失且无提示
  2. 菜单栏图标存在
  3. 浏览器可访问
  4. 命令输出满足：应用进程仍是 1 个、sing-box 仍在、`HTTPEnable=1`
- **失败时抓证据**：

```bash
pgrep -fl 'target/debug/veyl|Veyl.app/Contents/MacOS'
pgrep -fl 'sing-box run'
scutil --proxy
```

  外加：屏幕右上角图标截图、关窗前后的窗口截图。

- **常见误判**：把「窗口没了」当成「应用退出了」。应用退出看进程，不看窗口。

---

## A2 连接中 Cmd+Q，选「后台运行」

- **追溯**：R3 / §4.4；验收 A2
- **前置**：应用已启动并处于**已连接**状态
- **步骤**：
  1. 按 `Cmd+Q`（或在应用菜单里点「退出 Veyl」）
  2. 观察：是否弹出**阻塞式**对话框？窗口是否还能操作？
  3. 读对话框文案：是否说明「退出会断开当前连接并恢复网络」「想保持请选后台运行」？
  4. 看按钮：主按钮是否为「后台运行」，次按钮是否为「退出」
  5. 点「后台运行」
- **观察点**：
  - 对话框出现，且挡住主窗口操作（阻塞）
  - 文案与按钮与需求一致
  - 点「后台运行」后：窗口消失、进程仍在、连接仍在
- **通过标准**：
  1. 弹出阻塞对话框
  2. 文案包含上述两条后果说明
  3. 按钮为「后台运行」（主）/「退出」（次）
  4. 选择后窗口消失，但应用进程仍为 1 个、sing-box 仍在、`HTTPEnable=1`
- **失败时抓证据**：

```bash
pgrep -fl 'target/debug/veyl|Veyl.app/Contents/MacOS'
pgrep -fl 'sing-box run'
scutil --proxy
```

  外加：对话框截图（要能看清按钮与文案）。

- **补充观察（不通过也要记录）**：对话框在窗口已隐藏或应用不在前台时，是否仍能出现在最前。

---

## A3 连接中 Cmd+Q，选「退出」

- **追溯**：R3 + R5 / §4.4、§4.6；验收 A3
- **前置**：已连接
- **步骤**：
  1. 按 `Cmd+Q`
  2. 在对话框里点**次按钮「退出」**
  3. 等应用完全结束（窗口消失、菜单栏图标消失）
  4. 依次执行证据命令
- **观察点**：应用结束、菜单栏图标消失、网络自动恢复
- **通过标准**（五条全部满足）：
  1. 应用进程数为 **0**
  2. `HTTPEnable` / `HTTPSEnable` / `SOCKSEnable` **全部为 0**
  3. `pgrep -fl 'sing-box run'` **为空**
  4. `config/` 目录**为空**
  5. 直连出口恢复正常（能上网）
- **失败时抓证据**：

```bash
pgrep -fl 'target/debug/veyl|Veyl.app/Contents/MacOS' || echo "应用已退出"
pgrep -fl 'sing-box run' || echo "无 sing-box"
scutil --proxy
find "$HOME/Library/Application Support/Veyl/config" -type f 2>/dev/null | wc -l
ls -A "$HOME/Library/Application Support/Veyl/config/" 2>/dev/null
curl -sS --max-time 10 --noproxy '*' https://ifconfig.me/ip
```

  外加：退出后浏览器访问截图。

> **这是本轮最关键的一条**：只要出现「应用退了、代理还指着本地端口」，用户就会断网。任何一项不满足都记为**阻断级失败**。

---

## A4 托盘「显示 Veyl」

- **追溯**：R1/R4 / §4.2、§4.5；验收 A4
- **前置**：应用在后台（窗口已关闭但进程仍在，见 A1/A2 的结果）
- **步骤**：
  1. 点击菜单栏右上角 Veyl 图标
  2. 观察菜单项：**可点击项应当只有两个**——「显示 Veyl」与「退出」
  3. 点「显示 Veyl」
- **观察点**：菜单两项可点；点击后窗口出现并拿到焦点（光标可直接在窗口里操作）
- **通过标准**：
  1. 可点击菜单项恰好 2 个（可有第三行状态文案，但不可点击）
  2. 点击后窗口显示且为前台窗口
  3. 连接状态保持不变
- **失败时抓证据**：菜单展开截图 + `pgrep -fl 'sing-box run'` + `scutil --proxy`

---

## A5 托盘「退出」

- **追溯**：R4 + R5；验收 A5
- **前置**：已连接；应用可在前台或后台
- **步骤**：
  1. 点菜单栏图标 → 点「退出」
  2. 观察**有没有弹确认框**：正常情况下**不应有任何确认框**（需求 §4.1：托盘退出只在**断开失败时**才提示）
  3. 等待进程结束
- **通过标准**：
  1. **全程无确认对话框**（出现即为规格违背，记 FAIL）
  2. 与 A3 完全一致：进程 0、三个开关 0、无 sing-box、`config/` 为空、网络恢复
- **失败时抓证据**：同 A3

---

## A6 退出时代理撤销失败（人为构造）

- **追溯**：R5 失败处理 / §4.6；验收 A6
- **优先级**：P1（需要故障注入；**只能在开发构建上跑**）
- **前置**：**先完成 A3**，确认正常路径没问题，再测本条
- **构造方法**（由用户手动执行）：
  1. 正常启动并**正常退出**应用，确认没有残留：

```bash
pgrep -fl 'sing-box run' || echo "无 sing-box，可以继续"
```

  2. 用故障注入重启应用：

```bash
# 在项目根目录（含 src-tauri/ 的那一层）执行；不写死本机绝对路径
PROJECT_ROOT="$(pwd)"
VEYL_FAULT_PROXY_DISABLE=1 "$PROJECT_ROOT/src-tauri/target/debug/veyl"
```

  3. 在应用里连接一个节点。此时代理**可以正常设置** —— 故障只在**撤销**时生效
  4. 按 `Cmd+Q`，在对话框里选「退出」
  5. 观察应用是否退出、是否给出提示

- **变量说明**：`VEYL_FAULT_PROXY_DISABLE=1` 让「撤销系统代理」这一步返回失败，其余流程不变。
  **只在 debug 构建生效，release 不认** —— 因此本条只能在开发构建（`src-tauri/target/debug/veyl`）上跑；
  在打包版上设置该变量会被忽略，测出来的结果无效。

- **观察点**：
  - 应用**没有退出**（进程仍在）
  - 出现提示：「网络尚未恢复，退出会导致断网」
  - 提供「重试」与「强制退出」两个选项
- **通过标准**：
  1. 应用仍在运行（进程数 ≥ 1）
  2. 提示文案说明「退出会导致断网」
  3. 有「重试」按钮，点击后重新尝试
  4. 有「强制退出」按钮，且点击它之前有**二次确认**
- **失败判定**：应用直接退出且代理仍开着 = 阻断级失败（用户断网）；或没有任何提示。
- **清理（必须做）**：
  1. 正常退出这个注入了故障的实例（若点「退出」无响应，点「强制退出」并完成二次确认）
  2. 确认没有残留：

```bash
pgrep -fl 'sing-box run' || echo "无 sing-box"
scutil --proxy | grep -E 'HTTPEnable|HTTPSEnable|SOCKSEnable'
```

  3. 若三个开关仍为 1，手动恢复。**不要写死 `Wi-Fi`** —— 网络服务名可能是别的：

```bash
networksetup -listallnetworkservices | tail -n +2 | while IFS= read -r svc; do
  case "$svc" in *"*"*) continue ;; esac   # 带 * 的是被停用的服务
  networksetup -setwebproxystate "$svc" off
  networksetup -setsecurewebproxystate "$svc" off
  networksetup -setsocksfirewallproxystate "$svc" off
done
scutil --proxy | grep -E 'HTTPEnable|HTTPSEnable|SOCKSEnable'
```

- **失败时抓证据**：提示框截图 + `pgrep -fl 'target/debug/veyl'` + `scutil --proxy`

> **如果构造不出来**：如实记录「无法构造，未验证」，不要记为通过。这条的价值在于证明应用会**拒绝在不安全状态下退出**。

---

## A7 单实例（**阻断级：第二次启动不得影响正在运行的连接**）

- **追溯**：R6 / §4.7；验收 A7
- **前置**：应用已启动并**已连接**（必须有运行时、系统代理与渲染配置可对比）
- **步骤**（第二次启动**由用户操作**：点 Dock 图标 / Finder 双击 / `open -a Veyl`）：
  1. 连接成功后，采集基线：

```bash
DATA="$HOME/Library/Application Support/Veyl"
snapshot() {
  echo "app=$(pgrep -f 'target/debug/veyl|Veyl.app/Contents/MacOS' | wc -l | tr -d ' ')"
  echo "singbox=$(pgrep -f 'sing-box run' | tr '\n' ',' | sed 's/,$//')"
  echo "proxy_enable=$(scutil --proxy | awk '/HTTPEnable/{print $3}')"
  echo "proxy_port=$(scutil --proxy | awk '/HTTPPort/{print $3}')"
  echo "config_files=$(find "$DATA/config" -type f 2>/dev/null | wc -l | tr -d ' ')"
}
snapshot | tee /tmp/veyl-a7-before.txt
```

  2. **由用户发起第二次启动**
  3. 等约 3 秒，再采集一次：

```bash
snapshot | tee /tmp/veyl-a7-after.txt
```

     > 新开终端时 `snapshot` 函数不存在，把上面函数定义再粘一次，或直接把第 1 步整段再执行一遍、只改输出文件名。

  4. 对比：

```bash
diff /tmp/veyl-a7-before.txt /tmp/veyl-a7-after.txt && echo "前后完全一致"
```

- **通过标准**（四条全部满足，**逐项对比，不靠主观判断**）：
  1. `singbox=` 的 **pid 前后相同**（都有值，且是同一个）
  2. `proxy_enable` 与 `proxy_port` **前后完全一致**（应为 `1` 与实际端口）
  3. `config_files` **前后相同且不为 0**（该 profile 的 json 与 meta 仍在）
  4. `app=1`，且窗口出现在前台
- **失败判定**（任一即为**阻断级**）：
  - sing-box pid 变了或消失了
  - 代理从 `1` 变成 `0`，或端口变了
  - `config_files` 变成 `0`
  - 应用进程数 > 1
- **为什么要这么严**：已知缺陷——**第二次启动会在单实例检测之前先跑崩溃恢复**，撤掉第一个实例的代理、杀掉它的 sing-box、删掉它的配置，然后才退出。用户的感受是「从 Dock 再点一次，后台连接就没了」，而**界面上没有任何提示**。
  这不是「顺手验一下」：它是用户日常最容易触发的操作。
- **失败时抓证据**：`/tmp/veyl-a7-before.txt`、`/tmp/veyl-a7-after.txt`、`diff` 输出、该时段的 `build/logs/` 日志、窗口截图

- **补充说明**：两个实例会争抢 `runtime.pid`、代理备份与配置文件，属于必然损坏 —— 即使第三条不满足，只要进程数为 1 也不能判通过。

---

## 附：本轮执行记录模板

| 用例 | 时间 | 结果（PASS / FAIL / 未执行） | 证据位置 | 备注 |
|---|---|---|---|---|
| A1 | | | | |
| A2 | | | | |
| A3 | | | | |
| A4 | | | | |
| A5 | | | | |
| A6 | | | | |
| A7 | | | | |

> 每个 FAIL 必须附：现象一句话、复现步骤、截图或命令输出、判断依据（对应上面哪条通过标准）。
