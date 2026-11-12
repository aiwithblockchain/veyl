# Veyl 端到端验收手册（人机协作版）

> 版本：2026-11-11
> 适用：macOS 13 及以上；开发构建（`npm run app:dev`）或 DMG 发布构建
> 写作对象：会用 AI、但不需要懂网络的同事
> 分工：**人负责操作与判断，AI 负责只读取证与核对**
> 第 8 章：设置改版后的验收，依据 `docs/design/settings-ia.md`；改版前的现状对照见 §8.0

---

## 如何用 AI 执行本手册

> 面向：同事把这份文档交给 AI，由 AI 逐条执行并回填结论。
> 原则：**界面类断言读 DOM / 计算样式，系统类断言读日志 / 数据库 / 系统命令；不写「看起来是否舒服」。**

### 两种执行通道

| 通道 | 用在哪 | 谁启动 | AI 能拿到什么 |
|---|---|---|---|
| **M1 浏览器预览** | 第 6 章、第 8.2 节的 DOM / CSS / 键盘 / 提示类用例 | 测试者执行 `npm run dev -- --port 1440` | DOM、`getComputedStyle`、截图、Console |
| **M2 原生应用** | TUN、系统代理、授权、托盘、真实网络、版本号、重置网络 | 测试者启动 `.app` 或 `npm run app:dev` | 截图、`APP_LOG` / `HELPER_LOG` / `SINGBOX_LOG`、SQLite、`scutil` / `netstat` / `lsof` |

- **AI 不执行** `npm`、`cargo`、构建脚本，也不启动/停止/强杀应用；这些由测试者做。
- AI 可以在 M1 里点击、输入、执行 JS；M2 里的系统弹窗、断网、强杀由测试者操作，AI 负责取证。
- 两端是同一份前端代码；M1 的 mock bridge 不覆盖 TUN、真实授权和系统网络，所以这两类只走 M2。

### 每轮开始前的清场

**M1（浏览器预览）**：在 Console 执行，清掉上一轮的本地状态后刷新：

```js
(() => {
  for (const key of Object.keys(localStorage)) {
    if (key.startsWith("veyl.")) localStorage.removeItem(key);
  }
  location.reload();
})()
```

**M2（原生应用）**：

1. 断开 VPN，关闭设置与所有弹窗。
2. 窗口调到 **1440×900**（除用例另有说明）；系统主题浅色（除深色用例外）。
3. 确认前置里指定的配置存在且已选中。
4. 记录基线：应用版本、`sw_vers -productVersion`、`scutil --dns`、`scutil --proxy`、`netstat -rn -f inet | grep '^default'`。

### 证据怎么采

| 类型 | 怎么采 | 命名 |
|---|---|---|
| 截图 | 全窗口 + 用例指定的局部裁切 | `<用例号>-<序号>.png` |
| DOM | 把用例里的 JS 返回值原样保存 | `<用例号>.json` |
| 日志 | `tail` / `grep` 指定时间段 | `<用例号>-app.log` |
| 系统状态 | `scutil --dns` / `scutil --proxy` / `netstat` 原文 | `<用例号>-system.txt` |
| 数据库 | `sqlite3 -readonly` 的 SELECT 输出 | `<用例号>-db.txt` |

证据目录沿用 §0.5：`~/Desktop/veyl-e2e/<日期>/<用例号>/`。

### 结果怎么回填

每条用例结束后，在当天的 `summary.md` 追加一行：

```
E6-07 | 通过 | shots/E6-07-1.png, dom/E6-07.json | 首屏无眉标，padding-top=28px
```

| 结论 | 含义 |
|---|---|
| **通过** | 预期里的每一条都能从 DOM / 截图 / 日志 / 系统输出中二值确认 |
| **不通过** | 至少一条预期不满足；必须写清预期编号、期望值、实际值 |
| **阻塞** | 前置不满足、构造不出状态、需要人操作但没人、或工具读不到（例如原生 DOM）。**不能把阻塞写成通过。** |

---

## 0. 使用说明

### 0.1 两个角色

| 角色 | 做什么 | 不做什么 |
|---|---|---|
| 测试者（人） | 启动应用、点界面、授权、断网、强杀、看界面和体感 | 不替 AI 下结论 |
| 取证者（AI） | 执行本文「AI 取证」里的只读命令，贴原始输出，按「预期」逐条核对 | 不启动/停止应用、不编译、不执行 `sudo`、不改网络设置、不杀进程 |

一条用例由同一个人机组合完成。**一次只交一条用例**，不要连着跑。

### 0.2 判定口径

- **通过**：可观察预期里的每一条都能被证据或人眼观察到。
- **不通过**：任意一条可观察预期不满足（旧用例里写「失败」，含义相同）。
- **阻塞**：前置条件不满足、命令没有输出、证据不足、构造不出状态，或该条属于「只能人判断」而人没有确认（旧用例里写「无法判定」，含义相同）。不要用「应该没问题」代替证据。

### 0.3 环境与基线（开始前记录一次）

在仓库根目录（开发构建）或任意目录（发布构建）先执行：

```bash
# 开发构建：在仓库根执行
LOG_DIR="$PWD/logs"
# 发布构建（DMG）：把上一行换成
# LOG_DIR="$HOME/.veyl/logs"

APP_LOG="$LOG_DIR/app-$(date +%F).log"
HELPER_LOG="$HOME/.veyl/helper-logs/helper.log"
SINGBOX_LOG="$HOME/.veyl/helper-logs/sing-box.log"
RUNTIME_LOG="$(ls -t "$HOME"/.veyl/logs/runtime-*.log 2>/dev/null | head -1)"
```

> 这些变量只在当前终端会话有效。AI 每次取证时要么把这三行和命令一起执行，要么改用绝对路径；不要假设变量还在。

记录下列基线，后面每条用例都拿它对照：

| 项目 | 怎么取 | 本次记录 |
|---|---|---|
| 应用版本 | 设置 › 关于 › 版本（`v0.1.0` 这种格式） | |
| 运行时版本 | `grep '启动 运行时=' "$APP_LOG" \| tail -1` | |
| macOS 版本 | `sw_vers -productVersion` | |
| 直连出口 IP | `curl -s --max-time 8 https://ipinfo.io/ip; echo` | |
| 系统 DNS | `scutil --dns \| sed -n '1,14p'` | |
| 网络服务的 DNS | `networksetup -getdnsservers Wi-Fi`（服务不叫 Wi-Fi 时换成实际名称） | |
| 系统代理 | `scutil --proxy` | |
| 默认路由 | `netstat -rn -f inet \| grep '^default'` | |

网络服务名称可以用 `networksetup -listallnetworkservices` 查，只读。

### 0.4 命令约定（安全边界）

本节和每条用例里的「AI 取证」命令都满足：

- **只读**：只读取日志、进程、路由、DNS、代理、监听端口和本地数据库；不写文件、不改系统设置。
- **不需要 `sudo`**。
- **不启动、不停止、不杀任何进程**。需要这些动作时，写在「步骤（人做）」里，由测试者执行并回报结果。
- 命令输出可能包含节点地址、出口 IP 等敏感信息，只发给团队内部，不要贴到公开渠道。

AI 如果发现某条命令需要管理员权限、会修改网络、或输出与预期完全不同，**立刻停下，把原始输出交给测试者**，不要自行换命令绕过。

### 0.5 失败时怎么归档

在桌面建一个本次测试目录，例如 `~/Desktop/veyl-e2e/2026-11-11/`，每条失败用例一个子目录：

```
E4-03/
  evidence.txt     # 命令 + 原始输出（AI 生成）
  screen-1.png     # 界面截图（测试者提供）
  notes.md         # 一句话现象 + 版本 + 时间
```

失败条目统一写成一行：

```
E4-03 | 2026-11-11 15:20 | v0.1.0 | 预期「scutil 里出现 223.5.5.5」未出现，实际仍是 192.168.1.1 | 证据见 ...
```

**不要把测试证据提交到代码仓库。**

---

## 1. 首次启动与配置创建

本章验证：没有配置时用户被带到哪里、AI 按什么顺序问问题、节点从哪里来、配置什么时候落库、最后是否进入主控制台。

> 首次启动要求干净的本机数据。由测试者备份并移走 `~/.veyl`（本文不提供删除命令，避免误删）；更稳妥的做法是使用一个从未运行过 Veyl 的 macOS 用户账户。

### E1-01 首次启动的入口判定

- **目的**：验证「没有 AI」时进入配置引导，「有 AI 但没有配置」时直接打开助手并开始首启流程。
- **前置条件**：干净数据；开发构建；不需要管理员。
- **步骤（人做）**
  1. 启动应用，观察窗口。
  2. 如果出现 AI 配置页，记录标题、输入框、按钮和底部链接；先不要填。
  3. 关闭应用，换一个已经配好 AI 的账户或数据目录，再次启动，观察主界面。
- **AI 取证**
  ```bash
  grep '启动 AI provider=' "$APP_LOG" | tail -1
  grep '启动 种子节点=' "$APP_LOG" | tail -1
  sqlite3 -readonly "$HOME/.veyl/veyl.db" "select count(*) as configs from configs;"
  sqlite3 -readonly "$HOME/.veyl/veyl.db" "select role, substr(content,1,80) from chat_messages order by created_at desc limit 6;"
  ```
  看什么：`provider=` 后面是 `None` 还是具体服务、`可用=` 是 `true` 还是 `false`；`configs` 是否为 0；最后几条消息里有没有助手开场白。
- **可观察预期**
  - 没有可用 AI：整窗被 AI 配置页接管，标题「配置 AI 后，我来帮你连上网络。」，有「DeepSeek API Key」输入框、「保存并验证」、「使用其他 AI 服务」、「我懂网络，不用 AI」。此时主界面不可操作。
  - 有可用 AI 且配置数为 0：直接进入主界面，右侧助手栏自动展开，助手开始首启对话；日志里 `可用=true`、配置数为 0。
- **判定**
  - [ ] 通过
  - [ ] 失败
- **失败时收集**：窗口截图、`APP_LOG` 最后 50 行、上面两条 SQL 的输出。

### E1-02 首启第一问：主要用途

- **目的**：验证 AI 只问一个问题，选项固定，不出现「自建节点」。
- **前置条件**：E1-01 的有 AI 路径；干净数据；不需要管理员。
- **步骤（人做）**
  1. 等助手说完开场白。
  2. 看提问卡的问题和选项，先不要点。
  3. 截图后点「APP 也需要使用 VPN」。
- **AI 取证**
  ```bash
  sqlite3 -readonly "$HOME/.veyl/veyl.db" "select tool_name, substr(args_json,1,300) from tool_calls order by created_at desc limit 8;"
  sqlite3 -readonly "$HOME/.veyl/veyl.db" "select role, substr(content,1,120) from chat_messages order by created_at desc limit 8;"
  ```
  看什么：提问是否通过工具发出（工具名里通常含 `Question`）；如果工具表里没有，就以测试者转述的卡片文字为准，AI 不要推断没看见的选项。
- **可观察预期**
  - 问题文字是「你主要想用它做什么？」。
  - 选项恰好三项：「仅使用网页浏览网站」「APP 也需要使用 VPN」「其它服务」。
  - 没有「自建节点」，也没有一次问两个问题。
- **判定**
  - [ ] 通过
  - [ ] 失败
- **失败时收集**：提问卡截图、工具表 SQL 输出、当时时间。

### E1-03 首启第二问：能力与分流追问

- **目的**：验证第二问按第一问切换措辞；回答「会」之后才追问接管方式与分流范围。
- **前置条件**：E1-02 已选「APP 也需要使用 VPN」；干净数据。
- **步骤（人做）**
  1. 记录第二问的问题与选项。
  2. 选「会」。
  3. 记录后续两个问题；在「哪些流量走 VPN？」里选「只有我指定的服务走 VPN」。
  4. 记录「哪些服务？」这一步。
- **AI 取证**
  ```bash
  sqlite3 -readonly "$HOME/.veyl/veyl.db" "select tool_name, substr(args_json,1,300) from tool_calls order by created_at desc limit 12;"
  sqlite3 -readonly "$HOME/.veyl/veyl.db" "select role, substr(content,1,120) from chat_messages order by created_at desc limit 10;"
  ```
  看什么：第二问是否与第一问匹配；是否一次只问一个；是否出现「第一类 / 第二类 / 第三类」字样。
- **可观察预期**
  - APP 路径的第二问是「你会在软件里自己填代理地址吗？」；网页路径才是「你会自己设置网络代理吗？」。
  - 回答「不会」时不再追问接管方式和分流范围。
  - 回答「会」后才出现「网络怎么接管？」和「哪些流量走 VPN？」。
  - 选「只有我指定的服务走 VPN」后追问「哪些服务？」。
  - 全程不显示「第一类 / 第二类 / 第三类」。
- **判定**
  - [ ] 通过
  - [ ] 失败
- **失败时收集**：三张提问卡截图、工具表 SQL 输出。

### E1-04 节点来源：测试节点 → 确认 → 落库 → 主控制台

- **目的**：验证没有明确选来源前不建配置；确认后才写库；写库后进入主控制台并连上。
- **前置条件**：完成 E1-02 / E1-03；开发构建；TUN 路径可能需要管理员授权（见第 4 章）。
- **步骤（人做）**
  1. 等第五步的问题「节点从哪来？」。
  2. 记录两个选项和当前是否有默认选中（应当没有默认、没有推荐）。
  3. 选「用 Veyl 提供的测试节点（仅供试用）」。
  4. 读确认页，确认包含节点来源和数量；点「开始配置」或「确认并写入」（按用户类别不同而不同）。
  5. 等连接结束（成功或失败都记录）。
- **AI 取证**
  ```bash
  sqlite3 -readonly "$HOME/.veyl/veyl.db" "select name, connection_mode, routing_mode, is_active, created_at from configs order by created_at desc limit 3;"
  sqlite3 -readonly "$HOME/.veyl/veyl.db" "select source, count(*) from nodes group by source;"
  sqlite3 -readonly "$HOME/.veyl/veyl.db" "select config_id, count(*) from config_nodes group by config_id;"
  sqlite3 -readonly "$HOME/.veyl/veyl.db" "select role, substr(content,1,160), created_at from chat_messages order by created_at desc limit 6;"
  grep -E '连接开始|连接完成|连接失败 卡在' "$APP_LOG" | tail -5
  ```
  看什么：配置只有一套且 `is_active=1`；`nodes` 的 `source` 有 `seed`；`config_nodes` 至少有 1 条；确认消息的时间早于 `configs.created_at`；日志里有对应的连接开始/完成。
- **可观察预期**
  - 选来源之前，`configs` 数量仍是 0；没有「先建空配置再塞节点」。
  - 确认页明确写出「节点用 Veyl 提供的 {N} 个测试节点」。
  - 确认之后才有配置，节点来源为 `seed`，配置与节点已关联。
  - 界面进入主控制台，不是停在聊天页或设置页；连接流程有明确的结束状态。
- **判定**
  - [ ] 通过
  - [ ] 失败
- **失败时收集**：确认页截图、全部 SQL 输出、`APP_LOG` 对应时间段、连接失败时的界面截图。

### E1-05 节点来源：自带节点 → 落库 → 主控制台

- **目的**：验证「用我自己的节点」两条路径（订阅 / 手动四项）都能落库，且不替用户编造字段。
- **前置条件**：完成 E1-02 / E1-03；准备一个可用的 Shadowsocks 订阅链接或四项参数（地址、端口、加密方式、密码）。
- **步骤（人做）**
  1. 第五步选「用我自己的节点」。
  2. 有订阅链接时选「有」，粘贴 `https://` 开头的地址；没有时选「没有」，按提示逐项填写四项。
  3. 故意少填一项（例如先不填密码），观察 AI 是否追问而不是自己编。
  4. 补齐后走到确认页并确认。
- **AI 取证**
  ```bash
  sqlite3 -readonly "$HOME/.veyl/veyl.db" "select source, count(*) from nodes group by source;"
  sqlite3 -readonly "$HOME/.veyl/veyl.db" "select name, connection_mode, routing_mode, is_active from configs order by created_at desc limit 3;"
  sqlite3 -readonly "$HOME/.veyl/veyl.db" "select config_id, count(*) from config_nodes group by config_id;"
  sqlite3 -readonly "$HOME/.veyl/veyl.db" "select tool_name, is_error, substr(args_json,1,200) from tool_calls order by created_at desc limit 10;"
  ```
  看什么：`nodes.source` 是 `url` 还是 `manual`；节点数是否与确认页一致；缺字段时有没有产生半条节点或空配置。
- **可观察预期**
  - 缺任意一项时 AI 追问，不写节点、不建配置。
  - 订阅路径的节点来源为 `url`，手动路径为 `manual`。
  - 配置与节点已关联，界面进入主控制台。
  - 确认页写出「节点用你提供的 {节点名或地址}」。
- **判定**
  - [ ] 通过
  - [ ] 失败
- **失败时收集**：追问截图、确认页截图、全部 SQL 输出。

### E1-06 不用 AI 的手动路径仍然可用

- **目的**：验证跳过 AI 后，新建配置、连接、断开都不依赖在线服务。
- **前置条件**：干净数据；在 AI 配置页选择「我懂网络，不用 AI」。
- **步骤（人做）**
  1. 在配置页点「我懂网络，不用 AI」。
  2. 打开「新建配置」，确认仍有两张卡；选「我自己配置」。
  3. 不改默认值，直接点「创建」。
  4. 在主控制台点「启动 VPN」，随后断开。
- **AI 取证**
  ```bash
  grep '启动 AI provider=' "$APP_LOG" | tail -1
  sqlite3 -readonly "$HOME/.veyl/veyl.db" "select count(*) from configs;"
  sqlite3 -readonly "$HOME/.veyl/veyl.db" "select count(*) from chat_messages;"
  grep -E '连接开始|连接完成|连接失败 卡在' "$APP_LOG" | tail -4
  ```
  看什么：`可用=false`（或 provider 为空）；配置数 ≥ 1；没有 AI 首启消息；连接日志存在。
- **可观察预期**
  - 跳过 AI 后应用正常进入主界面；点右边缘的「助手」展开后，顶部显示「未连接 AI」和「还没有配置 AI，现在只能手动操作网络。」。
  - 新建配置入口仍然有「AI 协助」和「我自己配置」两张卡。
  - 默认值可以创建配置并连接；全程不依赖 AI。
- **判定**
  - [ ] 通过
  - [ ] 失败
- **失败时收集**：主界面截图、配置创建结果、连接日志。

---

## 2. 节点管理

本章验证三条入口：订阅导入、粘贴导入、测速与切换。前两条在「新建配置 › 我自己配置 › 节点来源」里；测速在节点面板或控制台节点卡里。

### E2-01 订阅导入

- **目的**：验证订阅地址只接受 `https://`，导入后节点落库并绑定到新配置。
- **前置条件**：已有可用 Shadowsocks 订阅链接；开发构建。
- **步骤（人做）**
  1. 新建配置 → 我自己配置 → 节点来源选「订阅地址」。
  2. 先输入 `http://example.com/sub`，点「创建」，观察是否停在字段旁报错。
  3. 改成真实的 `https://` 订阅地址，点「创建」。
- **AI 取证**
  ```bash
  sqlite3 -readonly "$HOME/.veyl/veyl.db" "select source, count(*) from nodes group by source;"
  sqlite3 -readonly "$HOME/.veyl/veyl.db" "select name, is_active from configs order by created_at desc limit 3;"
  sqlite3 -readonly "$HOME/.veyl/veyl.db" "select config_id, count(*) from config_nodes group by config_id;"
  tail -n 120 "$APP_LOG" | grep -E '连接|错误|error|warn' | tail -10
  ```
  看什么：`http://` 那次没有新增 `url` 节点；`https://` 那次新增了，且配置已关联。
- **可观察预期**
  - `http://` 时字段旁出现「订阅地址要以 https:// 开头。」，没有发请求、没有建配置。
  - `https://` 时节点导入成功，列表能看到节点，配置创建完成。
  - 节点来源为 `url`。
- **判定**
  - [ ] 通过
  - [ ] 失败
- **失败时收集**：两次提交后的界面截图、SQL 输出、订阅地址必须打码后再归档。

### E2-02 粘贴导入

- **目的**：验证多行 `ss://` 链接按顺序导入，且仍然只建一套配置。
- **前置条件**：准备两条可用的 `ss://` 分享链接（每行一条）。
- **步骤（人做）**
  1. 新建配置 → 我自己配置 → 节点来源选「粘贴分享链接」。
  2. 粘贴两条链接，点「创建」。
  3. 记录节点列表顺序。
- **AI 取证**
  ```bash
  sqlite3 -readonly "$HOME/.veyl/veyl.db" "select source, count(*) from nodes group by source;"
  sqlite3 -readonly "$HOME/.veyl/veyl.db" "select config_id, count(*) from config_nodes group by config_id;"
  sqlite3 -readonly "$HOME/.veyl/veyl.db" "select count(*) from configs;"
  ```
  看什么：新增节点数为 2；配置数只增加 1；`config_nodes` 对应 2 条。
- **可观察预期**
  - 两条链接都导入，顺序与粘贴顺序一致。
  - 只创建一套配置，不出现「一条链接一套配置」。
  - 粘错格式时停在字段旁报错，不建配置。
- **判定**
  - [ ] 通过
  - [ ] 失败
- **失败时收集**：节点列表截图、SQL 输出（链接打码）。

### E2-03 测试连通与切换节点

- **目的**：验证测速入口可用、结果可读、能按结果切换节点。
- **前置条件**：当前配置至少有 1 个节点；应用未连接或已连接均可（已连接时测速会受影响，以界面提示为准）。
- **步骤（人做）**
  1. 打开节点面板或控制台节点卡，点「全部测速」。
  2. 观察进度文字与每行延迟。
  3. 测速完成后，切换到另一个节点，观察当前节点名变化。
- **AI 取证**
  ```bash
  ps -Ao pid,comm,args | grep -E 'sing-box|veyl' | grep -v grep
  tail -n 200 "$APP_LOG" | grep -E '测速|延迟|节点|warn|error' | tail -10
  ```
  看什么：测速期间是否有临时的 sing-box 进程；结束后是否回收；日志里有没有批量测速的错误。
- **可观察预期**
  - 点「全部测速」后出现「正在准备测速…」，随后是「正在测速 {done}/{total}」。
  - 每行显示延迟数字或「连不上 / 测速失败」；没有结果的节点不显示 0 ms（控制台延迟显示「—」）。
  - 测速结束后临时进程消失；切换节点后节点名与当前节点标识同步更新。
  - 没有网络时显示「现在没有网络，测速结果不代表节点状态」。
- **判定**
  - [ ] 通过
  - [ ] 失败
- **失败时收集**：测速过程截图、进程输出、`APP_LOG` 对应时间段。

---

## 3. 代理模式

本章验证「只给一个代理地址」的连接方式：连接、状态、端口生效、断开后系统代理还原。代理模式**不需要管理员授权**。

### E3-01 连接与状态显示

- **目的**：验证代理模式能连上，界面显示已连接、时长、出口 IP 和延迟。
- **前置条件**：当前配置为「只给一个代理地址」；节点可用；记录基线直连 IP。
- **步骤（人做）**
  1. 点「启动 VPN」。
  2. 观察遮罩阶段与最终状态。
  3. 记录控制台里的已连接文案、时长、出口 IP、延迟。
- **AI 取证**
  ```bash
  grep -E '连接开始|连接完成|连接失败 卡在' "$APP_LOG" | tail -4
  ps -Ao pid,comm,args | grep -E 'sing-box' | grep -v grep
  curl -s --max-time 8 https://ipinfo.io/ip; echo
  ```
  看什么：日志里 `mode=system_proxy` 且 `连接完成`；出口 IP 与基线不同；sing-box 进程存在。
- **可观察预期**
  - 遮罩依次经过「正在启动后台组件 / 正在建立连接 / 正在确认出口」，失败时错误立刻让位给失败卡。
  - 最终顶部显示「已连接」，旁边有计时；出口 IP 与基线不同。
  - 日志有 `连接完成`，没有 `连接失败 卡在=`。
- **判定**
  - [ ] 通过
  - [ ] 失败
- **失败时收集**：遮罩/控制台截图、日志尾、出口 IP 输出。

### E3-02 端口生效

- **目的**：验证实际监听端口、系统代理指向和设置里的端口一致。
- **前置条件**：E3-01 已连接。
- **步骤（人做）**
  1. 打开设置 › 连接，记录「本机代理端口」显示值。
  2. 打开控制台代理卡，记录地址。
  3. 复制地址，确认复制内容与显示一致。
- **AI 取证**
  ```bash
  scutil --proxy
  lsof -nP -iTCP -sTCP:LISTEN | grep -E '789[0-9]|127\.0\.0\.1'
  ```
  看什么：`HTTPEnable : 1`、`HTTPProxy : 127.0.0.1`、`HTTPPort` 与实际监听端口一致；`SOCKSEnable` 同样指向同一端口。
- **可观察预期**
  - `scutil --proxy` 里 HTTP 与 SOCKS 都指向 `127.0.0.1`，端口等于控制台显示的地址端口。
  - `lsof` 里有 sing-box 监听该端口，地址是 `127.0.0.1`，不是 `0.0.0.0`。
  - 设置里显示、控制台显示、复制出来的地址三者一致。
- **判定**
  - [ ] 通过
  - [ ] 失败
- **失败时收集**：设置页截图、控制台截图、两条命令的完整输出。

### E3-03 断开与系统代理还原

- **目的**：验证断开后进程停止、端口释放、系统代理回到连接前的状态。
- **前置条件**：E3-01 已连接；已记录基线 `scutil --proxy`。
- **步骤（人做）**
  1. 点「断开 VPN」。
  2. 等遮罩结束，确认状态回到「未连接」。
  3. 用浏览器刷新一个页面，确认还能上网。
- **AI 取证**
  ```bash
  scutil --proxy
  lsof -nP -iTCP -sTCP:LISTEN | grep -E '789[0-9]|127\.0\.0\.1'
  ps -Ao pid,comm,args | grep -E 'sing-box' | grep -v grep
  curl -s --max-time 8 https://ipinfo.io/ip; echo
  ```
  看什么：`scutil --proxy` 与基线一致（没有 Veyl 写入的 `HTTPEnable/HTTPPort`）；没有监听残留；没有 sing-box；出口 IP 回到基线。
- **可观察预期**
  - 状态回到「未连接」，控制台不再显示代理卡。
  - 系统代理与基线一致；如果连接前本来没有代理，断开后也不应残留指向 Veyl 的代理。
  - 端口释放，sing-box 进程消失。
  - 出口 IP 回到基线，浏览器可正常上网。
- **判定**
  - [ ] 通过
  - [ ] 失败
- **失败时收集**：断开前后 `scutil --proxy` 两份输出、`lsof` 输出、浏览器截图。

---

## 4. TUN 模式

本章验证接管全部流量：首次授权、路由接管、系统 DNS、DNS 查询进隧道、国内直连/国外走节点、UDP 转发、正常断开还原、强杀 App 后自动收尾。

> 本章的 sing-box 日志证据（`hijack-dns`、`inbound packet connection`、`outbound/...`）只在**开发构建**里完整可见（debug 日志级别）。发布构建的 sing-box 日志级别是 `warn`，看不到这些行；发布构建用系统状态和实际访问结果判定，并在证据里注明「日志行不适用」。

### E4-01 首次授权

- **目的**：验证首次使用「全部流量」时的授权流程说清楚、只弹一次、失败可重试。
- **前置条件**：本机从未安装/启用过后台组件；macOS 13+；测试者准备好输入管理员密码（如果需要）。
- **步骤（人做）**
  1. 新建一套「全部流量」配置并点「启动 VPN」。
  2. 观察是否先出现「正在准备后台组件 / 系统会请求一次授权。」。
  3. 按系统提示完成授权；如果被带到「系统设置 › 登录项与扩展」，手动允许 Veyl 的后台助手，再回到应用点一次连接。
  4. 断开后再次连接，观察是否还需要授权。
- **AI 取证**
  ```bash
  grep -E 'helper|后台组件|授权|presence' "$APP_LOG" | tail -20
  ps -Ao pid,comm,args | grep -E 'veyl-helper|veyl-service' | grep -v grep
  ```
  看什么：授权前后 helper 进程是否出现；日志里有没有「待更新，需要管理员授权」或授权取消；第二次连接是否不再出现授权阶段。
- **可观察预期**
  - 授权前有明确说明，不是突兀弹窗。
  - 如果出现管理员密码弹窗（后台组件更新路径），文案应说明「后台组件」「只用于全部流量」「代理模式不需要授权」。
  - 如果出现的是「系统设置 › 登录项与扩展」审批，应用应先把用户带到那里，并说明允许的是 Veyl 的后台助手；允许后连接继续。
  - 授权成功后才继续连接；被拒绝时停在可重试状态，不反复弹窗。
  - 第二次连接不再要求授权。
- **判定**
  - [ ] 通过
  - [ ] 失败
- **失败时收集**：授权弹窗截图（不要拍密码）、日志尾、第二次连接截图。

### E4-02 TUN 连接与接管确认

- **目的**：验证 sing-box 以 TUN 模式启动，默认路由进入 utun，接管完整。
- **前置条件**：E4-01 已完成授权；记录基线默认路由。
- **步骤（人做）**
  1. 点「启动 VPN」，等状态变成「已连接」。
  2. 记录耗时（从点击到已连接）。
- **AI 取证**
  ```bash
  grep -E '连接开始|TUN 运行时已启动|TUN 已连接|TUN 接管已确认|连接失败 卡在' "$APP_LOG" | tail -8
  tail -n 80 "$HELPER_LOG" | grep -E '接管|spawn|start 完成|stop' | tail -12
  netstat -rn -f inet | grep '^default'
  ifconfig | grep -E '^utun[0-9]+:'
  ```
  看什么：`mode=tun`；`TUN 接管已确认 ... routes=完整`；默认路由接口从 `en0` 变成 `utunN`；helper 日志 `接管结束 tun=utunN`。
- **可观察预期**
  - 日志出现 `连接开始 ... mode=tun`、`TUN 已连接 pid=...`、`TUN 接管已确认 ... routes=完整`。
  - helper 日志出现 `接管结束 tun=utunN`，且 `stop` 行的 `残留utun路由=0`（这是断开时的检查，连接期可以先记录）。
  - `netstat -rn` 的 IPv4 默认路由指向 `utun`，不再是物理网卡。
  - 界面顶部显示「已连接」，不是「未连接」。
- **判定**
  - [ ] 通过
  - [ ] 失败
- **失败时收集**：日志三段、路由输出、`ifconfig` 输出、界面截图。

### E4-03 系统解析器指向 223.5.5.5

- **目的**：验证 TUN 连接期系统 DNS 被改为公网 `223.5.5.5`，不再指向会被排除表挡住的隧道对端 `172.19.0.2`。
- **前置条件**：E4-02 已连接；已记录基线 DNS。
- **步骤（人做）**
  1. 保持连接。
  2. 把当前上网的网络服务名称告诉 AI（通常是 Wi-Fi；在「系统设置 › 网络」里看）。
- **AI 取证**
  ```bash
  networksetup -getdnsservers Wi-Fi
  scutil --dns | sed -n '1,20p'
  ```
  看什么：服务级 DNS 是否包含 `223.5.5.5`；`scutil --dns` 的前 20 行里是否出现 `nameserver[0] : 223.5.5.5`；是否还残留 `172.19.0.2`。
- **可观察预期**
  - `networksetup -getdnsservers Wi-Fi` 输出 `223.5.5.5`（如果该服务是当前主服务）。
  - `scutil --dns` 前 20 行出现 `223.5.5.5`。
  - 不出现 `172.19.0.2`。
- **判定**
  - [ ] 通过
  - [ ] 失败
- **失败时收集**：两条命令完整输出、连接状态截图、`HELPER_LOG` 里 `dns` 阶段的日志。

### E4-04 DNS 查询确实进了隧道

- **目的**：验证系统解析器指向 `223.5.5.5` 后，查询被 TUN 的 `hijack-dns` 接住，而不是从物理网卡直接出去。
- **前置条件**：E4-02 已连接；开发构建（否则日志行不适用）。
- **步骤（人做）**
  1. 保持连接。
  2. 让 AI 执行查询；或者自己打开一个没访问过的网站。
- **AI 取证**
  ```bash
  date '+%F %T'
  dig +short www.apple.com
  tail -n 4000 "$SINGBOX_LOG" | grep -E 'hijack-dns|inbound DNS packet' | tail -6
  ```
  看什么：`dig` 有返回；sing-box 日志出现 `protocol=dns => hijack-dns` 和 `inbound/tun[tun-in]: inbound DNS packet from 172.19.0.1`。
- **可观察预期**
  - `dig +short www.apple.com` 返回至少一个 IP，不超时。
  - 日志里能看到 `hijack-dns` 与 `inbound DNS packet`，时间与查询时间对得上。
  - 发布构建没有这些日志行时，本条改判为「无法判定（日志级别限制）」，并由 E4-03 + 实际访问结果补证。
- **判定**
  - [ ] 通过
  - [ ] 失败
  - [ ] 无法判定（发布构建日志级别限制）
- **失败时收集**：`dig` 输出、sing-box 日志尾、查询时间。

### E4-05 国内直连 / 国外走节点

- **目的**：验证分流真正生效：国内域名走直连，国外域名走节点。
- **前置条件**：E4-02 已连接；开发构建（日志证据）；记录基线直连 IP。
- **步骤（人做）**
  1. 保持连接。
  2. 浏览器打开一个国内网站（例如 `https://www.baidu.com`）。
  3. 浏览器打开一个国外网站（例如 `https://github.com`）。
- **AI 取证**
  ```bash
  curl -s --max-time 8 https://ipinfo.io/ip; echo
  curl -s -o /dev/null -w '%{http_code}\n' --max-time 8 https://www.baidu.com
  curl -s -o /dev/null -w '%{http_code}\n' --max-time 10 https://github.com
  tail -n 4000 "$SINGBOX_LOG" | grep -E 'router: match|outbound/(direct|shadowsocks)' | tail -20
  ```
  看什么：国内连接是否命中 `rule_set=[geosite-cn geoip-cn] => route(route-local)` 且走 `outbound/direct[direct]`；国外连接是否走 `outbound/shadowsocks[node-...]`；出口 IP 是否与基线不同。
- **可观察预期**
  - 出口 IP 与基线不同。
  - 国内站点返回 `200`，日志里对应连接走 `route(route-local)` / `outbound/direct[direct]`。
  - 国外站点能打开，日志里对应连接走 `outbound/shadowsocks[node-...]`。
  - 浏览器没有出现「代理服务器拒绝连接」之类的错误。
- **判定**
  - [ ] 通过
  - [ ] 失败
- **失败时收集**：两个网站截图、出口 IP、sing-box 日志对应时间段。

### E4-06 UDP / QUIC 转发

- **目的**：验证 TUN 不只转 TCP，UDP 也进隧道并走节点。
- **前置条件**：E4-02 已连接；开发构建；浏览器支持 QUIC。
- **步骤（人做）**
  1. 保持连接。
  2. 用浏览器打开一个默认走 QUIC 的网站（例如 YouTube 或 Instagram），停留 10 秒。
  3. 如果页面明显走 TCP，换一个网站再试；记录用了哪个网站。
- **AI 取证**
  ```bash
  tail -n 6000 "$SINGBOX_LOG" | grep -E 'inbound packet connection|sniffed packet protocol: quic|outbound/(direct|shadowsocks)' | tail -20
  ```
  看什么：是否出现 `inbound/tun[tun-in]: inbound packet connection to ...:443`（UDP）以及 `sniffed packet protocol: quic`；对应出站是否走 `outbound/shadowsocks[...]`。
- **可观察预期**
  - 日志出现 `inbound packet connection`（区别于 TCP 的 `inbound connection`）。
  - 出现 `sniffed packet protocol: quic`，并且对应出站不是 `direct`（国外 QUIC 应走节点）。
  - 页面能正常播放/加载，没有长时间转圈。
  - 如果日志只有 TCP 连接，判为「无法判定（未触发 QUIC）」而不是失败；换网站重试一次。
- **判定**
  - [ ] 通过
  - [ ] 失败
  - [ ] 无法判定（未触发 QUIC）
- **失败时收集**：访问的网站名、页面截图、sing-box 日志尾。

### E4-07 正常断开后的还原

- **目的**：验证断开后系统 DNS、默认路由、utun 接口和进程都恢复干净。
- **前置条件**：E4-02 已连接；已记录基线 DNS、路由。
- **步骤（人做）**
  1. 点「断开 VPN」。
  2. 等状态回到「未连接」。
  3. 用浏览器刷新页面，确认能上网。
- **AI 取证**
  ```bash
  grep -E 'stop|presence|TUN 已停止' "$HELPER_LOG" "$APP_LOG" | tail -10
  networksetup -getdnsservers Wi-Fi
  scutil --dns | sed -n '1,14p'
  netstat -rn -f inet | grep '^default'
  ifconfig | grep -E '^utun[0-9]+:'
  ps -Ao pid,comm,args | grep -E 'sing-box' | grep -v grep
  ```
  看什么：helper 日志有 `stop ... 残留utun路由=0`；服务级 DNS 回到基线，或写回了一组可用地址（原本没有自定义 DNS 时不要出现空解析器）；默认路由回到物理网卡；utun 接口消失；sing-box 消失。
- **可观察预期**
  - 状态回到「未连接」，没有残留的失败卡。
  - helper 日志出现 `stop` 且 `残留utun路由=0`。
  - **DNS 还原分两种情况**：
    - 连接前有自定义 DNS：断开后写回原来的值。
    - 连接前没有自定义 DNS：断开后写回一组可用地址（路由器/全局 DNS 或 `223.5.5.5` / `119.29.29.29`），**不能出现没有 nameserver、无法解析的状态**。不要用「223.5.5.5 必须消失」作为判定条件。
  - 默认路由回到基线物理网卡，`utun` 接口消失。
  - 浏览器能正常上网。
- **判定**
  - [ ] 通过
  - [ ] 失败
- **失败时收集**：断开前后 DNS 与路由输出、helper 日志尾、浏览器截图。

### E4-08 强杀 App 后的自动停止与还原

- **目的**：验证 App 被强制结束后，后台组件在租约断开后自动停隧道并还原网络。
- **前置条件**：E4-02 已连接；测试者知道如何用「活动监视器」强制退出 Veyl。
- **步骤（人做）**
  1. 保持 TUN 连接。
  2. 用活动监视器强制退出 Veyl（不要用菜单里的正常退出）。
  3. 立刻告诉 AI「已强杀」并记录时间。
- **AI 取证**（强杀后 10 秒内执行一次，再在 20 秒时复查）
  ```bash
  date '+%F %T'
  ps -Ao pid,comm,args | grep -E 'veyl|sing-box|veyl-helper' | grep -v grep
  ifconfig | grep -E '^utun[0-9]+:'
  networksetup -getdnsservers Wi-Fi
  netstat -rn -f inet | grep '^default'
  tail -n 40 "$HELPER_LOG" | grep -E 'presence|stop|租约' | tail -8
  ```
  看什么：helper 日志有「presence 租约断开且无新租约，停止隧道后退出」和 `stop 原因=lease_lost`；sing-box 消失；utun 消失；DNS 不再是连接期的值（回到 E4-07 的两种还原口径）。
- **可观察预期**
  - 强杀后约 5 秒，后台组件确认 App 不会重连，开始停止隧道；10 秒内 sing-box 不再存在。
  - helper 日志出现 `stop 原因=lease_lost` 且 `残留utun路由=0`。
  - 20 秒内默认路由恢复物理网卡，系统 DNS 回到可用状态，浏览器能上网。
  - 不需要用户重新打开 App 才能恢复网络。
- **判定**
  - [ ] 通过
  - [ ] 失败
- **失败时收集**：强杀时间、两次命令输出、helper 日志尾、浏览器截图。

> 时间口径：后台组件的设计是「租约断开后等 5 秒确认没有新租约，再停隧道」。因此从强杀到完全停止通常需要 5–7 秒，判定以 **10 秒内停止、20 秒内网络恢复**为准；超过 20 秒仍未恢复才判失败。

### E4-09 断开后 DNS 还原值的可用性兜底

- **目的**：验证断开后系统停在一台**能解析**的 DNS 上——还原值可用就保留，不可用就自动退到公网，明确离线则不覆盖。对应 2026-11-12 真机事故：某台机器路由器下发的 DNS（`211.179.155.161`）在隧道关闭后连续 63 秒不答，旧实现把「验证超时」当成「跳过兜底」，断开后浏览器报 `DNS_PROBE_FINISHED_BAD_CONFIG`，只有重连 VPN 才能上网。
- **前置条件**：
  - M2 原生应用，**必须真实断开**；**不要**在 M1 浏览器预览里跑（mock 通道没有系统 DNS）。
  - E4-02 已连接，且已记录基线：`networksetup -getdnsservers "Wi-Fi"`、`scutil --dns | sed -n '1,16p'`。
  - 分支 B 的构造由测试者执行，命令可能要求输入管理员密码；构造前先把基线写下来。
  - 三个分支互相独立，每次开始前都回到「未连接 + 网络正常」。

- **步骤（人做）**

  **分支 A：还原值可用**
  1. 连接前，Wi-Fi 的自定义 DNS 是一个正常值（例如 `192.168.1.1` 或 `8.8.8.8`）。若原本用 DHCP 没有自定义 DNS，在「系统设置 › 网络 › Wi-Fi › 详细信息 › DNS」先加一个可用地址再连接。
  2. 连接 TUN，等「已连接」。
  3. 点「断开 VPN」，等状态回到「未连接」。
  4. 不要手动改任何设置，直接用浏览器打开一个网页。

  **分支 B：还原值不可用 → 自动兜底（事故场景）**
  1. 处于断开状态，把 Wi-Fi 的 DNS 手工改成一台不可达的地址（构造用 TEST-NET-3，不会真的响应）：
     ```bash
     sudo networksetup -setdnsservers "Wi-Fi" 203.0.113.1
     networksetup -getdnsservers "Wi-Fi"
     ```
  2. 连接 TUN，等「已连接」。此时快照里的「原值」就是这台不答的 DNS。
  3. 点「断开 VPN」，同时开始计时；等状态回到「未连接」。
  4. **不要**重连 VPN、**不要**手动改 DNS、**不要**刷新系统 DNS 缓存，直接用浏览器新开标签打开一个网页。
  5. 取证后清场：把 Wi-Fi 的 DNS 改回第 1 步之前记录的值；原来是 DHCP 的用 `sudo networksetup -setdnsservers "Wi-Fi" Empty`。

  **分支 C：离线不覆盖**
  1. 连接 TUN，等「已连接」（Wi-Fi 的 DNS 是正常值）。
  2. 关闭 Wi-Fi。
  3. 点「断开 VPN」，等状态回到「未连接」。
  4. 重新打开 Wi-Fi，等网络恢复，再用浏览器打开网页。

- **AI 取证**（只读命令；断开后 10 秒内执行一次）

  **分支 A**
  ```bash
  networksetup -getdnsservers "Wi-Fi"
  scutil --dns | sed -n '1,16p'
  grep -n "DNS 处理分支\|DNS 还原写入\|DNS 还原后验证\|fallback_public\|还原值不可用" "$HELPER_LOG" | tail -12
  ```

  **分支 B**
  ```bash
  networksetup -getdnsservers "Wi-Fi"
  scutil --dns | sed -n '1,16p'
  grep -n "DNS 处理分支\|DNS 还原写入\|DNS 还原后验证\|还原值不可用\|DNS 兜底" "$HELPER_LOG" | tail -14
  grep -n "\[diag\] stop" "$HELPER_LOG" | tail -2
  ```

  **分支 C**
  ```bash
  networksetup -getdnsservers "Wi-Fi"
  grep -n "DNS 处理分支\|DNS 还原后验证\|fallback_public\|还原值不可用" "$HELPER_LOG" | tail -12
  ```

- **可观察预期**

  **分支 A**
  - helper 日志有 `DNS 处理分支=write（还原原始值）`（或 `remove_peer`），并有 `DNS 还原后验证=可用`。
  - 这一段日志里**没有** `fallback_public`，也没有 `[warn] 还原值不可用 → 已退公网`。
  - `networksetup -getdnsservers "Wi-Fi"` 与连接前的基线一致；`scutil --dns` 前 16 行不再出现连接期的 `223.5.5.5`。
  - 浏览器直接打开网页成功。
  - **例外**：连接前系统没有任何自定义 DNS、且没有可摘掉的残留时，分支是 `nothing`，验证行不会出现——这是正常行为，记下实际分支即可，不判失败。

  **分支 B（本条核心）**
  - helper 日志依次出现：
    - `DNS 处理分支=fallback_public（还原值不可用，已退公网）`
    - `DNS 还原后验证=不可用（超时）→ 已退公网`（失败原因可能是超时 / 无输出 / 命令失败，以实际为准，前缀 `DNS 还原后验证=不可用（` 与结尾 `→ 已退公网` 必须都在）
    - `[warn] 还原值不可用 → 已退公网`
    - `DNS 兜底回读=一致`、`DNS 兜底后验证=可用的`
  - `networksetup -getdnsservers "Wi-Fi"` 返回 `223.5.5.5` 和 `119.29.29.29`（两行）；`scutil --dns` 前 16 行出现 `nameserver[0] : 223.5.5.5` 与 `nameserver[1] : 119.29.29.29`。
  - **浏览器不做任何手动操作就能打开网页**：新开标签打开站点首屏成功，不出现 `DNS_PROBE_FINISHED_BAD_CONFIG` / `ERR_NAME_NOT_RESOLVED`。这一条是本用例的核心，单独判。
  - `[diag] stop ... 总耗时=` ≤ `5000ms`（当前实测约 3.4 秒）；超过 5 秒判不通过，附带日志原文。
  - 日志里不应出现 `DNS 还原失败` 或 `退公网写入失败`。

  **分支 C**
  - helper 日志有 `DNS 还原后验证=本机离线，跳过`。
  - 这一段日志里**没有** `fallback_public`，也没有 `[warn] 还原值不可用 → 已退公网`。
  - `networksetup -getdnsservers "Wi-Fi"` 仍是基线值，没有被写成 `223.5.5.5` / `119.29.29.29`。
  - Wi-Fi 恢复后浏览器能打开网页。

- **判定**
  - 分支 A：[ ] 通过　[ ] 失败　[ ] 阻塞
  - 分支 B：[ ] 通过　[ ] 失败　[ ] 阻塞
  - 分支 C：[ ] 通过　[ ] 失败　[ ] 阻塞
- **失败时收集**：三个分支各自的 `networksetup` / `scutil --dns` 原文、helper 日志尾（`grep` 结果贴全）、`[diag] stop` 行、浏览器截图（分支 B 必须带地址栏与页面结果）。

### 4.1 已知取舍：DNS 兜底会覆盖路由器下发的原值

> 断开时若还原值不可用，helper 会把系统 DNS 永久改成 `223.5.5.5` / `119.29.29.29` 并清一次解析缓存。**不会**在之后自动改回路由器下发的值——原值只在下一次连接时才重新快照。用户如果有内网解析需求（`.lan`、公司内网域名等），需要自己在「系统设置 › 网络 › DNS」改回。这是为了不把用户留在「一台不答的 DNS」上所做的取舍，不是缺陷。

---

## 5. AI 对话

本章验证 AI 的问答、工具展示、布局渲染与降级。AI 的界面行为由人观察，AI 取证主要读本地对话库与日志，**不要根据截图猜测**。

### E5-01 提问卡的问答路径

- **目的**：验证 AI 提问以消息流内联卡片出现，点选项后继续对话，不挡输入框。
- **前置条件**：已配置可用 AI；有一次会触发提问的对话（例如「帮我看看为什么连不上」）。
- **步骤（人做）**
  1. 在右侧发一条会触发提问的消息。
  2. 观察提问卡：问题、选项、倒计时、跳过。
  3. 点一个选项，观察对话是否继续。
- **AI 取证**
  ```bash
  sqlite3 -readonly "$HOME/.veyl/veyl.db" "select role, substr(content,1,140), created_at from chat_messages order by created_at desc limit 8;"
  sqlite3 -readonly "$HOME/.veyl/veyl.db" "select tool_name, is_error, substr(args_json,1,200) from tool_calls order by created_at desc limit 8;"
  ```
  看什么：回答之后是否出现新的助手消息；问题是否只出现一次；回答是否被记为一次用户输入。
- **可观察预期**
  - 提问卡出现在消息流末尾，不覆盖输入框，不加焦点陷阱。
  - 卡片有「剩 mm:ss」倒计时和「跳过」。
  - 点选项后卡片收起，助手继续回复；点「跳过」也会继续，不报错。
  - 同一问题不会重复弹出。
- **判定**
  - [ ] 通过
  - [ ] 失败
- **失败时收集**：提问卡与回答后截图、SQL 输出。

### E5-02 工具调用展示

- **目的**：验证工具调用显示成用户语言，不把 PascalCase 工具名、参数或原始结果直接画出来。
- **前置条件**：已配置 AI；发一条会触发工具的消息（例如「看一下现在的连接状态」）。
- **步骤（人做）**
  1. 发送消息。
  2. 观察过程行文字；点开一行，看展开内容。
  3. 截图。
- **AI 取证**
  ```bash
  sqlite3 -readonly "$HOME/.veyl/veyl.db" "select tool_name, is_error, created_at from tool_calls order by created_at desc limit 10;"
  sqlite3 -readonly "$HOME/.veyl/veyl.db" "select role, substr(content,1,160) from chat_messages order by created_at desc limit 6;"
  ```
  看什么：`tool_calls` 里确实调用了工具；聊天正文里没有工具名、JSON、字段名。
- **可观察预期**
  - 过程行是「正在检查连接状态 / 已查看连接状态」这类用户语言。
  - 不出现 `RuntimeStatus`、`ToolResult`、`config_id` 之类的英文标识。
  - 点开后有「用时」和最多几条事实；失败时显示「发生了什么 / 有没有改动 / 现在能做什么」。
  - 聊天正文里没有 JSON。
- **判定**
  - [ ] 通过
  - [ ] 失败
- **失败时收集**：过程行展开截图、工具表 SQL、聊天正文截图。

### E5-03 布局渲染与持久化

- **目的**：验证 AI 输出的布局进入中间区，而不是出现在聊天正文；重启后仍然保留。
- **前置条件**：已配置 AI；当前配置有一套可用节点；开发构建便于看日志。
- **步骤（人做）**
  1. 在右侧请 AI 调整中间区（例如「中间区只保留连接状态和测速」）。
  2. 观察聊天正文与中间区。
  3. 重启应用，再看中间区。
- **AI 取证**
  ```bash
  sqlite3 -readonly "$HOME/.veyl/veyl.db" "select config_id, revision, layout_json from layout;"
  sqlite3 -readonly "$HOME/.veyl/veyl.db" "select role, substr(content,1,200) from chat_messages order by created_at desc limit 4;"
  grep -E 'layout' "$APP_LOG" | tail -10
  ```
  看什么：`layout` 表有新 revision；聊天正文里没有 `{"version":1,...}`；日志里有布局提交，没有 `layout.invalid`。
- **可观察预期**
  - 中间区按 AI 的选择变化；系统块（故障卡、DNS 降级说明）仍然保留。
  - 聊天正文不出现 JSON、围栏或布局对象。
  - 重启后同一套配置的中间区仍然按上次布局渲染。
  - `layout` 表有对应 `config_id` 与 revision。
- **判定**
  - [ ] 通过
  - [ ] 失败
- **失败时收集**：调整前后截图、`layout` 表 SQL、聊天正文截图、日志尾。

### E5-04 非法布局丢弃

- **目的**：验证不认识的块、坏 JSON 不会进中间区，也不会污染聊天正文。
- **前置条件**：已配置 AI；开发构建；最好由开发同事配合构造一次非法布局（对话触发不保证每次都能复现）。
- **步骤（人做）**
  1. 请 AI 使用一个不存在的块（例如「把中间区换成一个天气卡」）。
  2. 观察中间区是否保持原样或退回本地兜底。
  3. 观察聊天正文。
- **AI 取证**
  ```bash
  grep -E 'layout.invalid' "$APP_LOG" | tail -10
  sqlite3 -readonly "$HOME/.veyl/veyl.db" "select config_id, revision, substr(layout_json,1,120) from layout;"
  sqlite3 -readonly "$HOME/.veyl/veyl.db" "select role, substr(content,1,200) from chat_messages order by created_at desc limit 4;"
  ```
  看什么：是否出现 `layout.invalid reason=...`；`layout` 表没有被非法内容覆盖；聊天正文没有 JSON。
- **可观察预期**
  - 非法布局被丢弃，界面不出现空白区或坏块；至少退回本地兜底块。
  - 日志出现 `layout.invalid reason=...`（坏 JSON 是 `bad_json`，未知块是校验原因）。
  - `layout` 表保留上一份合法布局，不被坏内容覆盖。
  - 聊天正文没有 JSON。
  - 如果这次对话没有触发 AI 输出布局，判为「无法判定（未触发）」，不算失败。
- **判定**
  - [ ] 通过
  - [ ] 失败
  - [ ] 无法判定（未触发）
- **失败时收集**：中间区截图、`layout` 表 SQL、日志 `layout.invalid` 行、聊天正文截图。

### E5-05 AI 不可用时的降级

- **目的**：验证没有 AI 时界面明确说明，手动连接、断开、新建配置仍然可用。
- **前置条件**：跳过 AI 配置，或删除当前 AI 服务；已有一套配置。
- **步骤（人做）**
  1. 打开右侧助手。
  2. 记录顶部提示和模型名。
  3. 关闭右栏，手动连接、断开。
  4. 制造一次连接失败（例如把节点地址改错），观察失败卡里的引导。
- **AI 取证**
  ```bash
  grep '启动 AI provider=' "$APP_LOG" | tail -1
  grep -E '连接开始|连接完成|连接失败 卡在' "$APP_LOG" | tail -4
  ```
  看什么：`可用=false`；手动连接仍有日志；失败卡里的「现在能做什么」是否改成「新建一套配置」而不是「让助手定位」。
- **可观察预期**
  - 右栏顶部显示「未连接 AI」，并有「还没有配置 AI，现在只能手动操作网络。」和「去配置」。
  - 输入框不可用于 AI 对话，但手动连接/断开不受影响。
  - 失败卡步骤里不出现「让助手定位」，最后一步是「新建一套配置」。
- **判定**
  - [ ] 通过
  - [ ] 失败
- **失败时收集**：右栏截图、失败卡截图、连接日志。

---

## 6. 界面

> 本章按「同事驱动 AI 执行」写：E6-01…E6-06 是原场景的改写，E6-07…E6-14 是 P1 十一条里与界面直接相关的八条，E6-15…E6-22 是 P2 的八条，E6-23、E6-24 是打磨批的两条，E6-25…E6-31 是「已连接，不通」的一组。
> 执行通道：除 E6-02、E6-04 必须用原生应用外，其余优先用浏览器预览（M1）。DOM 断言的 JS 直接在 Console 执行，返回值保存为 JSON。

| P1 项 | 用例 |
|---|---|
| 去掉控制台眉标、首屏上边距 28px | E6-07 |
| 四个弹窗 + 设置页内联表单的壳统一（两档标题 / 关闭 / 宽度） | E6-08 |
| 用户消息改时间线、长文本不溢出 | E6-09 |
| 左栏空态 / 错误态的就地按钮 | E6-10 |
| 首启「其他 AI 服务」只剩一个保存按钮 | E6-11 |
| info 提示 4 秒消失、error 保留 | E6-12 |
| 关于页版本读构建版本 | E6-13 |
| 字号收敛、深色 `--ink-3`、`--ink-4` 不作文字色 | E6-14 |

| P2 项 | 用例 |
|---|---|
| 配置骨架行与真实行同为 64px | E6-15 |
| 提示条 top 96 / z-index 90 / 4 秒 / 不挡主按钮 | E6-16 |
| 节点名两种状态同为 15px/500、超长省略 | E6-17 |
| 发送按钮禁用态 `--bg-hover` | E6-18 |
| 消息不含 tokens、状态文字无动画 | E6-19 |
| 未配置 AI 横幅 2px 竖线 + 透明底 | E6-20 |
| 零配置自动展开、本次运行内关闭、重启再展开 | E6-21 |
| 全局间距：四个容器已归格，其余只记已知 | E6-22 |

| 打磨批项 | 用例 |
|---|---|
| 设置弹窗打开时提示条让到弹窗头下方 | E6-23 |
| 配置名单行省略、行高仍 64px、删除按钮不被挤 | E6-24 |

| 「已连接，不通」 | 用例 |
|---|---|
| 进入本状态的版式、文案与中间区 | E6-25 |
| 探测恢复后回到「已连接」 | E6-26 |
| 「重新连接」的过渡与按钮唯一性 | E6-27 |
| 与「连接不稳定」不叠加 | E6-28 |
| 健康快照过期后退出本状态 | E6-29 |
| 读屏只播报一次 | E6-30 |
| 真实断流的进入与恢复（M2，可选） | E6-31 |

### E6-01 中间控制台各块的出现条件

**前置**：M1；1440×900；浅色；清空 `veyl.*` 后新建两套配置——A「所有软件都走 VPN + 本地网站直连」，B「只让能填代理的软件走 + 只有我指定的服务走 VPN」并选中至少一个服务。

**步骤**：

1. 选中配置 A，未连接。执行 DOM 取证：

```js
(() => {
  const q = (s) => [...document.querySelectorAll(s)].map((e) => e.textContent.trim());
  return {
    state: document.querySelector(".state-word, .state-line")?.textContent.trim() ?? null,
    notes: q(".console .note"),
    proxyCard: Boolean(document.querySelector(".console .card--proxy")),
    issueCard: Boolean(document.querySelector(".console .card--err, .console .card--warn")),
    buttons: q("button").filter((t) => /启动 VPN|重新连接|取消|断开 VPN/.test(t)),
  };
})()
```

2. 点「启动 VPN」，等状态变成「已连接」后重复上面的 JS。
3. 点「断开 VPN」，等状态回到「未连接」。
4. 选中配置 B，重复未连接 / 连接两次取证。
5. 再连接一次配置 A，在点击后 200ms 内执行一次取证（此时应处于过渡态），1.5 秒后再执行一次。

**预期**：

1. 配置 A 未连接：`.console .note` 只有「点上面的「启动 VPN」，所有软件都会自动走节点。」；没有 `.card--proxy`；没有 `.card--err/--warn`。
2. 配置 A 已连接：主提示「所有软件现在都能用了。」，另有 `.note__detail` 文本「国内网站直连，其他走 VPN」；没有 `.card--proxy`。
3. 配置 B 已连接：主提示「浏览器现在能用了。」，且有 `.card--proxy`，地址为 `127.0.0.1:{端口}`。
4. 过渡态：`.console .note`、`.card--proxy`、`.card--err/--warn` 的数量都是 0；状态词是「正在连接」。
5. 全程不出现英文错误码、`proxy`、`TUN`、`分流`、`规则集`。

**不合格时记录什么**：

- 每次取证的完整 JSON（五次）。
- 对应状态的 `.console` 区域截图。
- 实际状态词与期望状态词的差异。
- `APP_LOG` 最后 50 行（M2 对照用）。

### E6-02 故障与降级时的块

**前置**：M2 原生应用；一套正常的 TUN 配置可用；另准备一个地址错误的节点（测试者创建）；能临时断网（降级分支）。

**步骤**：

1. 用错误节点连接，等遮罩结束，截失败卡；执行：

```bash
grep -E '连接失败|失败 code=|last_error' "$APP_LOG" | tail -8
```

2. 用正常节点连接，等「已连接」；由测试者关闭 Wi-Fi，等 15 秒，截降级卡 / 当前状态。
3. 恢复 Wi-Fi，等 30 秒，记录是否回到「已连接」；必要时手动断开重连。
4. 如果无法安全制造降级，只执行失败分支，并在结果里注明「降级分支阻塞」。
5. 如果断网后界面仍显示「已连接」（当前设计规定数据面失败不单独降级），把这一现象记为观察项；**不要**因此判本条失败，降级分支记「阻塞（未触发降级）」。

**预期**：

1. 首次连接失败标题是「没有连上节点。」；从已连接掉线是「连接断了。」。
2. 失败原因用用户语言（例如「节点一直没有响应。」），不出现英文错误码、字段名。
3. 失败卡最多三步：重新连接 → 换一个节点（多节点时）→ 让助手定位 / 新建一套配置。
4. 降级时标题「连接不稳定」，原因与「流量没有真正出去 / 最近的网络检查没有通过」对应；不是「连接失败」。
5. 失败时不再显示代理卡；降级时按配置决定是否保留代理卡。

**不合格时记录什么**：

- 失败卡 / 降级卡裁切截图。
- `APP_LOG` 对应时间段原始行。
- 当时的 `scutil --proxy`、`scutil --dns`、`netstat -rn -f inet | grep '^default'`。
- 标题、原因、步骤数分别与预期第几条不符。

### E6-03 右栏默认状态与开关

**前置**：M1；1440×900；清空 `veyl.*`；已有一套配置。另准备一次 1024×900 的窗口尺寸。

**步骤**：

1. 1440×900 载入，执行：

```js
(() => {
  const panel = document.querySelector("#ai-panel");
  const slot = document.querySelector(".assistant-slot");
  const tab = document.querySelector(".assistant-tab");
  const r = panel?.getBoundingClientRect();
  return {
    panel: Boolean(panel),
    panelWidth: r ? Math.round(r.width) : null,
    slotWidth: slot ? Math.round(slot.getBoundingClientRect().width) : null,
    tab: Boolean(tab),
    tabWidth: tab ? Math.round(tab.getBoundingClientRect().width) : null,
    assistantVar: getComputedStyle(document.documentElement).getPropertyValue("--assistant-w").trim(),
  };
})()
```

2. 点 `[aria-label="收起助手"]`，重复取证；再点 `.assistant-tab__open` 展开，重复取证。
3. 把窗口调到 1024×900 并刷新，重复取证；点右边缘「助手」tab，检查 `.assistant-overlay` 是否出现及其宽度。
4. 收起后刷新一次，确认收起状态是否保留。

**预期**：

1. 1440×900 首次进入：`#ai-panel` 存在，宽度 420（±1）；`.assistant-tab` 不存在；`--assistant-w` 为 `420px`。
2. 收起：`#ai-panel` 不存在；`.assistant-tab` 存在，宽度 56；标题/标签是「助手」。
3. 展开：`#ai-panel` 回来，宽度 420。
4. 1024×900：默认是 `.assistant-tab`（56），不是展开的第三栏；点开后 `.assistant-overlay` 出现，宽度 400（±1）。
5. 用户收起后刷新：仍保持收起；再展开后刷新：仍保持展开。
6. 展开/收起不触发连接或断开。

**不合格时记录什么**：

- 三次取证的 JSON。
- 1440 展开、1440 收起、1024 默认、1024 浮层四张截图。
- 实际宽度与期望宽度的差值。

### E6-04 托盘图标三态与菜单

**前置**：M2；macOS 菜单栏可见；能分别制造未连接 / 已连接 / 连接失败三种状态。

**步骤**：

1. 未连接时截菜单栏图标（裁 40×40）和打开后的菜单。
2. 连接后重复截图。
3. 用错误节点制造失败，重复截图；执行：

```bash
ps -Ao pid,comm,args | grep -E 'Veyl|veyl' | grep -v grep
```

4. 连接中关闭主窗口，确认进程还在、连接还在；点「显示 Veyl」，确认窗口回到前台。

**预期**：

1. 三种状态图标形状不同（盾 / 勾 / 三角），不只靠颜色区分。
2. 菜单只有两个可点击项：「显示 Veyl」「退出」。
3. 连接中关闭窗口后，进程仍在、连接仍在、图标仍是已连接态。
4. 「显示 Veyl」把窗口带回前台并聚焦。
5. 托盘创建失败不应导致应用无法启动（日志只告警）。

**不合格时记录什么**：

- 三种图标裁切图、两次菜单截图、关闭窗口后的状态截图。
- `ps` 输出。
- 图标是形状相同只换颜色，还是完全没变。

### E6-05 深色模式

**前置**：M1；1440×900；已有一套配置；能在浏览器里模拟 `prefers-color-scheme: dark`。

**步骤**：

1. 浅色下执行一次取证。
2. 切到深色（浏览器设备模拟或系统外观），刷新后执行：

```js
(() => {
  const root = getComputedStyle(document.documentElement);
  const pick = (sel, prop = "color") => {
    const el = document.querySelector(sel);
    return el ? getComputedStyle(el)[prop] : null;
  };
  return {
    dark: matchMedia("(prefers-color-scheme: dark)").matches,
    canvas: root.getPropertyValue("--canvas").trim(),
    ink: root.getPropertyValue("--ink").trim(),
    ink3: root.getPropertyValue("--ink-3").trim(),
    ink4: root.getPropertyValue("--ink-4").trim(),
    bodyBg: getComputedStyle(document.body).backgroundColor,
    bodyColor: getComputedStyle(document.body).color,
    consoleBg: pick(".console", "backgroundColor"),
    settingsBg: pick(".modal--settings", "backgroundColor"),
    aiBg: pick("#ai-panel", "backgroundColor"),
  };
})()
```

3. 依次打开设置、新建配置、右栏，记录三处背景与文字色。
4. 切回浅色，重复一次。

**预期**：

1. 深色：`--canvas` 为 `#16181b`，`--ink` 为 `#e9e9e7`，`--ink-3` 为 `#90908a`，`--ink-4` 为 `#77776f`。
2. `bodyBg` 为 `rgb(22, 24, 27)`；`bodyColor` 不是深色（不是 `rgb(23, 22, 20)`）。
3. 控制台、设置、右栏背景都来自深色 token，没有纯白 `rgb(255, 255, 255)` 大块。
4. 浅色恢复为 `--canvas: #EFEBE1`、`--ink: #171614`。
5. 切换不需要重启应用。

**不合格时记录什么**：

- 浅色 / 深色两次取证的 JSON。
- 控制台、设置、新建配置、右栏四张深色截图。
- 出现纯白块的元素选择器与计算样式。

### E6-06 空态文案

**前置**：M1；清空 `veyl.*`；跳过首启 AI（点「我懂网络，不用 AI」）；没有任何配置。

**步骤**：

1. 读取左栏空态：

```js
(() => ({
  title: document.querySelector(".rail__empty-title")?.textContent.trim() ?? null,
  text: document.querySelector(".rail__empty-text")?.textContent.trim() ?? null,
  action: document.querySelector(".rail__empty-action")?.textContent.trim() ?? null,
  actionClass: document.querySelector(".rail__empty-action")?.className ?? null,
}))()
```

2. 新建一套配置后，把它的节点数组改成空，刷新，读取控制台空态：

```js
(() => {
  const store = JSON.parse(localStorage.getItem("veyl.configs.mock.v1"));
  store.configs[0].nodes = [];
  store.configs[0].node_count = 0;
  localStorage.setItem("veyl.configs.mock.v1", JSON.stringify(store));
  location.reload();
})()
```

3. 打开右栏 › 历史会话，读取 `.ai-history__empty`。

**预期**：

1. 左栏：「还没有配置」+「让助手配一条，或自己新建一套。」+ 一个 `btn btn--ghost rail__empty-action` 按钮「新建配置」。
2. 没有节点时：控制台出现「这套配置还没有节点。」，不出现端口行。
3. 历史会话空态：「还没有对话。新建一个，或者直接问我。」。
4. 三处空态都不出现 `proxy`、`TUN`、`分流`、`规则集`。

**不合格时记录什么**：

- 三处空态的 DOM JSON 与截图。
- 缺失的文案或按钮。
- 是否出现禁用词。

### E6-07 控制台首屏没有「控制台」眉标

**前置**：M1；1440×900；已有一套配置；浅色；未连接。

**步骤**：

1. 载入主界面，执行：

```js
(() => {
  const consoleEl = document.querySelector(".console");
  const body = consoleEl?.querySelector(".console__body");
  const eyebrow = [...(consoleEl?.querySelectorAll("*") ?? [])]
    .filter((el) => el.children.length === 0 && el.textContent.trim() === "控制台")
    .map((el) => {
      const r = el.getBoundingClientRect();
      return { tag: el.tagName, cls: el.className, top: Math.round(r.top) };
    });
  return {
    consoleHead: Boolean(document.querySelector(".console__head")),
    crumb: Boolean(document.querySelector(".console__crumb")),
    firstChildClass: consoleEl?.firstElementChild?.className ?? null,
    bodyPaddingTop: body ? getComputedStyle(body).paddingTop : null,
    eyebrow,
  };
})()
```

2. 截控制台顶部 120px。

**预期**：

1. `consoleHead` 为 `false`，`crumb` 为 `false`。
2. `.console` 的第一个元素是 `.console__body`（或含 `console__body--welcome`），不是眉标。
3. `.console__body` 的 `paddingTop` 等于 `28px`。
4. `eyebrow` 为空数组；顶部 64px 内没有任何「控制台」文本。

**不合格时记录什么**：

- 上述 JSON 原样。
- `console-top.png`（裁切 120px）。
- 多出来的元素选择器与 `getBoundingClientRect()`。

### E6-08 四个弹窗 + 设置页内联表单的壳

**前置**：M1；1440×900；已有一套配置；能分别打开四个弹窗（新建配置、添加节点、重置网络、提问/授权）和设置页里的「添加 AI 服务」内联表单。设置弹窗本身是容器，不计入这四个。

**步骤**：

1. 逐个打开面，一次只开一个；每个面执行下面的 JS，记录返回对象：

```js
(() => {
  const surfaces = [
    ["新建配置", ".modal.new-config"],
    ["设置（容器）", ".modal.modal--settings"],
    ["添加节点", ".modal.modal--confirm:not(.reset-dialog)"],
    ["重置网络", ".modal.reset-dialog"],
    ["提问/授权", ".ask-question"],
    ["添加 AI 服务（内联）", ".provider-form"],
  ];
  return surfaces.map(([name, sel]) => {
    const el = document.querySelector(sel);
    if (!el) return { name, found: false };
    const title = el.querySelector(".modal__title, .ask-question__title, .provider-form__title");
    const close = el.querySelector(".modal__close, .ask-question__close");
    const head = el.querySelector(".modal__head, .ask-question__head");
    const r = el.getBoundingClientRect();
    const cr = close?.getBoundingClientRect();
    const ts = title ? getComputedStyle(title) : null;
    return {
      name,
      found: true,
      role: el.getAttribute("role"),
      width: Math.round(r.width),
      titleText: title?.textContent.trim() ?? null,
      titleSize: ts?.fontSize ?? null,
      titleWeight: ts?.fontWeight ?? null,
      close: close ? { w: Math.round(cr.width), h: Math.round(cr.height), rightGap: Math.round(r.right - cr.right) } : null,
      headPad: head ? `${getComputedStyle(head).paddingTop} ${getComputedStyle(head).paddingRight} ${getComputedStyle(head).paddingBottom} ${getComputedStyle(head).paddingLeft}` : null,
    };
  });
})()
```

2. 打开方式：新建配置点 `[aria-label="新建配置"]`；设置点左栏设置按钮；添加节点在设置 › 连接 ›「添加节点」行点「添加」；重置网络在设置 › 遇到问题点「重置网络」；提问/授权在右栏发「升级运行时」，等 `.ask-question` 出现；添加 AI 服务在设置 › AI 服务点「添加 AI 服务」。
3. 对每个面截全图，并记录关闭按钮距弹窗右边缘的距离。
4. 把四个弹窗分成两档：**确认类**（添加节点、重置网络、提问/授权）与**复杂类**（新建配置）。

**预期**：

1. **确认类三个弹窗内部一致**：标题都是 15px / 600；header padding 都是 `14px 20px`；关闭按钮都是 28×28，位于 header 最右侧，右间距都是 20px。添加节点宽度 400（±1），重置网络 480（±1），提问/授权 400（±1）。
2. **复杂类单独一档**：新建配置标题 17px / 600；header padding `16px 24px 14px`；关闭按钮 28×28，右间距 24px；宽度 480（±1）。
3. **设置弹窗是容器**：`.modal.modal--settings` 宽度 760（±1），标题「设置」15px / 600，关闭按钮 28×28，右间距 20px。它不是四个弹窗之一，只用于确认内联表单的宿主宽度。
4. **「添加 AI 服务」是内联表单**：`.provider-form`，不是 `role=dialog`，没有关闭按钮，不做宽度断言；标题 `.provider-form__title` 为 13px / 500。它只做「在 760 容器内展开」的断言。
5. **宽度只允许 400 / 480 / 760 三档**；没有 440 / 560 / 420 等旧值。
6. **不能断言四个弹窗标题同字号**：确认类 15/600、复杂类 17/600 是 `ui-refresh-plan.md` P1-4 规定的两档；只断言「同一档内部一致」。
7. 不出现 16 / 18 / 24 等第三种标题字号，也不出现 26px 旧关闭按钮。

**不合格时记录什么**：

- 六个面的 `getBoundingClientRect()` 与计算样式 JSON。
- 每个面的全图 + header 裁切图。
- 确认类内部哪一项不一致（标题 / padding / 关闭尺寸 / 右间距）。
- 复杂类与确认类是否被误当成同一档。
- 内联表单是否被误判成弹窗。

### E6-09 对话改成时间线

**前置**：M1；1440×900；AI 可用；右栏展开；至少已有一条用户消息和一条助手回复。

**步骤**：

1. 发送一条包含超长 URL 与超长无空格串的消息，例如 `https://example.com/` 加 200 个字符，再加 300 个 `A`；等助手回复结束。
2. 执行：

```js
(() => {
  const user = document.querySelector(".msg--user");
  const asst = document.querySelector(".msg--assistant");
  const roleText = (el) => el?.querySelector(".msg__role")?.textContent.replace("输出中", "").trim() ?? null;
  const text = user?.querySelector(".msg__text");
  const overflows = [...document.querySelectorAll(".msg__text")].map((el) => el.scrollWidth - el.clientWidth);
  return {
    bubbles: document.querySelectorAll(".msg__bubble").length,
    userRole: roleText(user),
    assistantRole: roleText(asst),
    roleSize: user ? getComputedStyle(user.querySelector(".msg__role")).fontSize : null,
    textSize: text ? getComputedStyle(text).fontSize : null,
    userAlign: user ? getComputedStyle(user).alignItems : null,
    userGap: user ? getComputedStyle(user).gap : null,
    docOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    textOverflow: overflows,
  };
})()
```

3. 截用户消息与助手消息各一张。

**预期**：

1. `bubbles` 为 0；DOM 里没有任何 `.msg__bubble`。
2. 用户消息署名是「你」，助手署名是「Veyl」。
3. `.msg__role` 字号 11px；`.msg__text` 字号 14.5px。
4. 用户消息不再右对齐：`userAlign` 不是 `flex-end`；`userGap` 为 `8px`。
5. `docOverflow` 为 0；`textOverflow` 每一项 ≤ 1px（没有横向溢出）。
6. 超长 URL 与无空格串在消息内换行，不撑破右栏。

**不合格时记录什么**：

- 上述 JSON。
- 用户 / 助手消息截图。
- 溢出的元素选择器与 `scrollWidth/clientWidth`。
- 是否仍存在 `.msg__bubble`。

### E6-10 左栏空态与错误态的 ghost 按钮

**前置**：空态用 M1（清空 `veyl.*`，没有配置）；错误态用 M2 原生应用构造。测试者能恢复被改动的权限 / 文件。

**步骤**：

1. 空态执行：

```js
(() => {
  const b = document.querySelector(".rail__empty-action");
  return {
    title: document.querySelector(".rail__empty-title")?.textContent.trim() ?? null,
    text: document.querySelector(".rail__empty-text")?.textContent.trim() ?? null,
    action: b?.textContent.trim() ?? null,
    classes: b?.className ?? null,
  };
})()
```

2. 点「新建配置」，确认 `.modal.new-config` 出现。
3. 创建一套配置后，确认左栏空态消失、列表至少 1 行。
4. 错误态构造（M2，由测试者执行；先退出应用）：
   - 方法 A：把配置目录改成不可读，再启动应用：

```bash
chmod 000 "$HOME/.veyl/config"
# 测完恢复
chmod 755 "$HOME/.veyl/config"
```

   - 方法 B：用一份非法 JSON 的配置文件启动（先把原文件备份）：

```bash
cp "$HOME/.veyl/config/active.json" "$HOME/.veyl/config/active.json.bak"
printf '{invalid' > "$HOME/.veyl/config/active.json"
# 测完恢复
mv "$HOME/.veyl/config/active.json.bak" "$HOME/.veyl/config/active.json"
```

   - 如果两种方法都没有让左栏进入错误态（当前 `config_list` 从 SQLite 读，可能不受配置目录权限影响），记「阻塞（未构造）」，并写明尝试过的方法；不要静默跳过。
5. 进入错误态后，读取左栏：

```js
(() => ({
  title: document.querySelector(".rail__empty-title")?.textContent.trim() ?? null,
  text: document.querySelector(".rail__empty-text")?.textContent.trim() ?? null,
  action: document.querySelector(".rail__empty-action")?.textContent.trim() ?? null,
  actionClass: document.querySelector(".rail__empty-action")?.className ?? null,
}))()
```

6. 恢复权限 / 文件，点「重新读取」，记录按钮是否消失、列表是否刷新。

**预期**：

1. 空态按钮文本「新建配置」，类名同时包含 `btn`、`btn--ghost`、`rail__empty-action`。
2. 点它打开新建配置弹窗；创建成功后空态和按钮消失，列表出现新配置。
3. 错误态标题「配置读取失败」，`.rail__empty-text` 显示具体错误；按钮文本「重新读取」，类名同样包含 `btn btn--ghost`。
4. 恢复权限后点「重新读取」：按钮消失，列表刷新出配置行。
5. 读取仍失败时按钮保留，不静默、不显示空列表冒充成功。
6. 错误态和空态都不出现两个以上同级按钮。

**不合格时记录什么**：

- 空态 / 错误态的 DOM JSON 与截图。
- 按钮的 `className`、点击前后的列表行数。
- 用过的构造方法（chmod / 非法 JSON）与恢复命令是否执行。
- 如果未构造成功，记录「阻塞（未构造）」及尝试过的方法。

**不合格时记录什么**：

- 空态 / 错误态的 DOM JSON 与截图。
- 按钮的 `className`、点击前后的列表行数。
- 如果错误态未构造，记录「阻塞（未构造）」及原因。

### E6-11 首启「使用其他 AI 服务」只有一个保存按钮

**前置**：M1；清空 `veyl.*`；刷新后出现首启页（没有可用 AI）。

**步骤**：

1. 点「使用其他 AI 服务」，执行：

```js
(() => {
  const save = [...document.querySelectorAll("button")].filter((b) => b.textContent.trim() === "保存并验证");
  return {
    saveButtons: save.length,
    deepseekInput: Boolean(document.querySelector("#onboarding-deepseek-key")),
    customForm: Boolean(document.querySelector("#onboarding-base-url")),
    submitInCustom: Boolean(document.querySelector(".onboarding__custom .onboarding__submit")),
  };
})()
```

2. 在可见的自定义表单里填一个会被拒绝的 Base URL（例如 `http://example.com`），点唯一的「保存并验证」。
3. 读取 `.onboarding__error` 文本，确认它属于自定义表单。

**预期**：

1. `saveButtons` 为 1；屏幕上只有一个「保存并验证」。
2. 展开自定义表单后，DeepSeek 表单被卸载：`deepseekInput` 为 `false`；`customForm` 为 `true`。
3. 唯一的提交按钮在 `.onboarding__custom` 内。
4. 提交后错误出现在 `.onboarding__custom .onboarding__error`（或自定义表单的错误节点），不是被卸载的 DeepSeek 表单。
5. 收起自定义表单后，DeepSeek 表单回来，仍只有一个「保存并验证」。

**不合格时记录什么**：

- 上述 JSON。
- 展开前后截图。
- 两个保存按钮各自的父表单选择器与错误文本。

### E6-12 成功提示与错误提示的消失行为

**前置**：M1；清空 `veyl.*`；跳过首启 AI；有一套可创建的配置流程。

**步骤**：

1. 用「新建配置 › 我自己配置」创建一个默认配置，触发 info 提示；记录首次出现的时刻 `t0`。
2. 每 200ms 检查 `.app-toast`，记录消失时刻 `t1`。
3. 在未配置 AI 的状态下，打开右栏发一条消息，触发 error 提示；等 6 秒。
4. 点 `.app-toast__close`（`aria-label="关闭提示"`）。

**预期**：

1. info 提示文本是「已创建，从左侧切换过去。」，类名含 `app-toast--info`。
2. `t1 - t0` 在 4 秒 ±1 秒（3.0–5.0 秒）内，元素从 DOM 移除。
3. error 提示类名含 `app-toast--error`；6 秒后仍在 DOM 中，不自动消失。
4. 点关闭按钮后 error 提示立即移除。
5. 替换提示时旧定时器不会把新提示提前清掉（连续触发 info → error，error 仍在 6 秒后存在）。

**不合格时记录什么**：

- 两次提示的文本、类名、`t0/t1`。
- 消失 / 保留的截图或 DOM 存在性。
- 是否出现提示被提前清掉、或 error 自动消失。

### E6-13 「关于」版本号等于构建版本

**前置**：M2 原生应用；能读到源码或安装包的版本。

**步骤**：

1. 打开设置 › 关于，截版本行。
2. 执行：
```bash
grep -n '"version"' src-tauri/tauri.conf.json
grep -n 'APP_VERSION\|getAppVersion' src/components/Settings.tsx
plutil -p /Applications/Veyl.app/Contents/Info.plist 2>/dev/null | grep -E 'CFBundleShortVersionString|CFBundleVersion'
```
   （安装包不在 `/Applications/Veyl.app` 时，把路径换成实际位置。）

3. 对比界面文本、`tauri.conf.json`（或 Info.plist）的值。

**预期**：

1. 关于页显示 `v{版本}`，与 `tauri.conf.json` 的 `version`（或安装包 Info.plist 的 `CFBundleShortVersionString`）完全一致。
2. 不是写死的占位：`Settings.tsx` 里没有 `const APP_VERSION = "..."`，版本来自 `getAppVersion()`（`grep APP_VERSION` 没有输出也算满足）。
3. 版本读取失败时显示 `v—`，不显示错误的旧版本号。
4. 诊断信息里的 `app` 字段、重置报告里的版本与关于页一致。

**不合格时记录什么**：

- 关于页截图与诊断信息文本。
- 三条命令的原始输出。
- 界面版本、构建版本、源码硬编码值三者对比。

### E6-14 字号与 `--ink-4` 用法

**前置**：M1；1440×900；首启页与主界面都要覆盖（先扫首启页，再进主界面）；浅色 + 深色各一次。

**步骤**：

1. 主界面 + 设置 + 新建配置 + 右栏 + 首启页都打开过一遍后，执行字号 / token 扫描：

```js
(() => {
  const allowed = new Set(["9.5px", "11px", "12px", "13px", "14px", "14.5px", "15px", "17px", "20px", "22px", "44px", "64px"]);
  const bad = [];
  const seen = new Set();
  for (const el of document.querySelectorAll("body *")) {
    if (["SCRIPT", "STYLE", "SVG", "PATH"].includes(el.tagName)) continue;
    if (el.closest(".sr-only")) continue;
    const hasText = [...el.childNodes].some((n) => n.nodeType === Node.TEXT_NODE && n.textContent.trim());
    if (!hasText) continue;
    const s = getComputedStyle(el);
    if (s.display === "none" || s.visibility === "hidden") continue;
    seen.add(s.fontSize);
    if (!allowed.has(s.fontSize)) {
      bad.push({ tag: el.tagName, cls: String(el.className), text: el.textContent.trim().slice(0, 40), size: s.fontSize });
    }
  }
  const probe = document.createElement("span");
  probe.style.color = "var(--ink-4)";
  document.body.appendChild(probe);
  const ink4 = getComputedStyle(probe).color;
  probe.style.color = "var(--ink-3)";
  const ink3 = getComputedStyle(probe).color;
  probe.remove();
  const ink4Text = [...document.querySelectorAll("body *")].filter((el) => {
    const hasText = [...el.childNodes].some((n) => n.nodeType === Node.TEXT_NODE && n.textContent.trim());
    return hasText && getComputedStyle(el).color === ink4;
  }).map((el) => ({ tag: el.tagName, cls: String(el.className), text: el.textContent.trim().slice(0, 40) }));
  return { seen: [...seen].sort(), bad, ink3, ink4, ink4Text };
})()
```

2. 深色下再执行一次，读取 `--ink-3`。

**预期**：

1. `bad` 为空数组；可见文字只使用 `{9.5, 11, 12, 13, 14, 14.5, 15, 17, 20, 22, 44, 64}px`。
2. 深色下 `--ink-3` 为 `#90908a`（计算值为 `rgb(144, 144, 138)`）。
3. `ink4Text` 为空数组；`--ink-4` 只出现在线条 / 点 / 焦点环（例如 `.led` 的背景、focus ring 的 `box-shadow`），不用于文字。
4. 没有 16 / 18 / 24 / 13.5 / 12.5 / 10px 的可见文字。
5. 首启页主标题使用 `--fs-display: 22px`，属于允许集合；扫描时必须包含首启页，不能把它排除后再判通过。

**不合格时记录什么**：

- 两次扫描的 JSON。
- `bad` 里每个元素的选择器、文本、计算字号。
- `ink4Text` 里的元素与颜色。
- 深色下 `--ink-3` 的实际值。

### E6-15 配置骨架行与真实配置行同为 64px

**前置**：M1；1440×900；至少有一套配置。骨架行在加载时出现；如果加载太快没抓到，用同父容器临时插入一个 `.skeleton-row` 测高度，并在备注里写「半合成」。

**步骤**：

1. 刷新列表，加载时（或抓不到时临时插入）执行：

```js
(() => {
  const list = document.querySelector(".configs");
  let sk = document.querySelector(".skeleton-row");
  let synthetic = false;
  if (!sk && list) {
    sk = document.createElement("div");
    sk.className = "skeleton-row";
    sk.innerHTML = '<span class="skeleton skeleton--name"></span><span class="skeleton skeleton--meta"></span>';
    list.prepend(sk);
    synthetic = true;
  }
  const real = document.querySelector(".config");
  const a = sk?.getBoundingClientRect().height ?? null;
  const b = real?.getBoundingClientRect().height ?? null;
  sk?.remove();
  return {
    skeletonHeight: a,
    realHeight: b,
    diff: a !== null && b !== null ? Math.abs(a - b) : null,
    synthetic,
  };
})()
```

2. 截左栏列表顶部，标出骨架行与真实行。

**预期**：

1. `skeletonHeight` 与 `realHeight` 都是 64（±0.5）。
2. `diff ≤ 0.5`。
3. 真实配置行的内容没有把行高撑到 64 以上。
4. 如果用了临时插入，`synthetic=true`，结论只证明样式规则一致；不能写成「真实加载过程也观察到」。

**不合格时记录什么**：

- 上述 JSON。
- 左栏截图。
- 两个元素的 `height / paddingTop / paddingBottom / lineHeight`。

### E6-16 提示条的位置、层级与遮挡

**前置**：M1；1440×900；未连接；没有任何配置（用于触发 info 提示），或未配置 AI（用于触发 error 提示）。

**步骤**：

1. 用「新建配置 › 我自己配置」创建一套配置，触发 info 提示；立即执行：

```js
(() => {
  const t = document.querySelector(".app-toast");
  const b = [...document.querySelectorAll("button")].find((x) => x.textContent.trim() === "启动 VPN");
  const tr = t?.getBoundingClientRect();
  const br = b?.getBoundingClientRect();
  const s = t ? getComputedStyle(t) : null;
  const overlap = tr && br ? !(tr.right <= br.left || tr.left >= br.right || tr.bottom <= br.top || tr.top >= br.bottom) : null;
  return {
    top: tr ? Math.round(tr.top) : null,
    zIndex: s?.zIndex ?? null,
    level: t?.className ?? null,
    overlap,
    toast: tr ? { w: Math.round(tr.width), h: Math.round(tr.height) } : null,
    button: br ? { x: Math.round(br.x), y: Math.round(br.y), w: Math.round(br.width), h: Math.round(br.height) } : null,
  };
})()
```

2. 记录 info 提示出现 / 消失时间，确认 4 秒 ±1 秒。
3. 在未配置 AI 的状态下发一条消息，触发 error 提示；等 6 秒后再查 `.app-toast` 是否还在。

**预期**：

1. `.app-toast` 的 `top` 为 96px（±1）；`zIndex` 为 `"90"`。
2. info 提示类名含 `app-toast--info`；`t1 - t0` 在 3.0–5.0 秒之间。
3. error 提示类名含 `app-toast--error`；6 秒后仍在 DOM 中。
4. `overlap` 为 `false`：提示条与未连接态的「启动 VPN」主按钮矩形不相交。
5. 提示条不覆盖主按钮、不改变主按钮的点击区域。

**不合格时记录什么**：

- 上述 JSON、info 的 `t0/t1`、error 的 6 秒后存在性。
- 提示条与主按钮的截图（带矩形标注）。
- `top / zIndex / overflow` 的计算值。

### E6-17 节点名字号与超长省略

**前置**：M1；1440×900；准备两套配置：A 两个节点、B 一个节点；节点名改成超过栏宽的长串。

**步骤**：

1. 用 localStorage 改两套配置的节点名并刷新：

```js
(() => {
  const store = JSON.parse(localStorage.getItem("veyl.configs.mock.v1"));
  const long = "这是一个非常非常长的节点名称用于测试省略号是否生效ABCDEFGHIJKLMN";
  store.configs.forEach((c, i) => {
    c.nodes = c.nodes.length ? c.nodes : [{
      node_id: `n_${i}`, name: long, server: "203.0.113.9", port: 8388,
      method: "aes-256-gcm", protocol: "shadowsocks", source: "manual", created_at: Date.now(),
    }];
    c.nodes[0].name = long;
    if (i === 0) c.nodes = [c.nodes[0], { ...c.nodes[0], node_id: "n_extra", name: long + "2" }];
  });
  store.activeId = store.configs[0].config_id;
  localStorage.setItem("veyl.configs.mock.v1", JSON.stringify(store));
  location.reload();
})()
```

2. 选中配置 A（多节点），执行：

```js
(() => {
  const read = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const s = getComputedStyle(el);
    return {
      text: el.textContent.trim().slice(0, 24),
      fontSize: s.fontSize,
      fontWeight: s.fontWeight,
      textOverflow: s.textOverflow,
      whiteSpace: s.whiteSpace,
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
      height: Math.round(el.getBoundingClientRect().height),
    };
  };
  return { select: read(".node-card__select .node-card__name"), static: read(".node-card__static .node-card__name") };
})()
```

3. 切到配置 B（单节点），再执行一次。

**预期**：

1. 多节点态 `.node-card__select .node-card__name`：`fontSize=15px`、`fontWeight=500`。
2. 单节点态 `.node-card__static .node-card__name`：同样是 `15px / 500`。
3. 两种状态都是 `textOverflow=ellipsis`、`whiteSpace=nowrap`。
4. 长名字下 `scrollWidth > clientWidth`，且 `height ≤ 21`（单行，没有换行撑高）。
5. 节点卡宽度不变，不因长名字横向溢出。

**不合格时记录什么**：

- 两次 JSON。
- 多节点 / 单节点截图。
- 长名字的 `scrollWidth / clientWidth / height`。

### E6-18 发送按钮禁用态的底色

**前置**：M1；AI 可用；输入框为空；浅色和深色各一次。

**步骤**：

1. 执行：

```js
(() => {
  const btn = document.querySelector(".btn--send");
  const probe = document.createElement("span");
  probe.style.background = "var(--bg-hover)";
  document.body.appendChild(probe);
  const expected = getComputedStyle(probe).backgroundColor;
  probe.remove();
  const s = getComputedStyle(btn);
  return {
    disabled: btn?.disabled ?? null,
    background: s.backgroundColor,
    expected,
    opacity: s.opacity,
    color: s.color,
  };
})()
```

2. 切深色后再执行一次。

**预期**：

1. 输入为空时 `disabled=true`。
2. `background` 等于 `--bg-hover` 的计算值：浅色 `rgba(255, 255, 255, 0.55)`，深色 `rgba(255, 255, 255, 0.06)`。
3. `opacity` 为 `"1"`（不是 0.38 的整块变淡）。
4. 按钮不是透明背景；浅色 / 深色都有可见底色。

**不合格时记录什么**：

- 两次 JSON。
- 浅色 / 深色按钮截图。
- `background / expected / opacity` 的差异。

### E6-19 消息不含 tokens、状态文字无动画

**前置**：M1；AI 可用；右栏展开。

**步骤**：

1. 发送「你好」，在流式回复期间执行：

```js
(() => {
  const a = document.querySelector(".msg__streaming");
  const c = document.querySelector(".composer__status");
  return {
    streaming: a ? { text: a.textContent.trim(), animationName: getComputedStyle(a).animationName } : null,
    status: c ? { text: c.textContent.trim(), animationName: getComputedStyle(c).animationName } : null,
  };
})()
```

2. 回复结束后执行：

```js
(() => {
  const text = document.querySelector(".msg--assistant")?.innerText ?? "";
  return { tokens: /\btokens?\b/i.test(text), sample: text.slice(0, 120) };
})()
```

**预期**：

1. 流式期间 `.msg__streaming` 存在，`animationName` 为 `"none"`。
2. `.composer__status` 渲染时 `animationName` 为 `"none"`；没有渲染时记 `null`，不判失败。
3. 回复结束后，助手消息里不出现 `tokens` / `token` 计数（大小写不敏感）。
4. 消息正文、工具行、思考块都不出现 token 计数。

**不合格时记录什么**：

- 两次 JSON。
- 流式期间与结束后的截图。
- 出现 `tokens` 的元素选择器与文本片段。

### E6-20 未配置 AI 横幅的左侧竖线与透明底

**前置**：M1；清空 `veyl.*`；跳过首启 AI（点「我懂网络，不用 AI」）；右栏展开。

**步骤**：

1. 执行：

```js
(() => {
  const b = document.querySelector(".ai-panel__banner");
  if (!b) return { found: false };
  const s = getComputedStyle(b);
  const probe = document.createElement("span");
  probe.style.color = "var(--cobalt)";
  document.body.appendChild(probe);
  const cobalt = getComputedStyle(probe).color;
  probe.remove();
  return {
    found: true,
    borderLeftWidth: s.borderLeftWidth,
    borderLeftColor: s.borderLeftColor,
    cobalt,
    background: s.backgroundColor,
    text: b.textContent.trim(),
  };
})()
```

2. 浅色、深色各执行一次。

**预期**：

1. `borderLeftWidth` 为 `2px`。
2. `borderLeftColor` 等于 `--cobalt` 的计算值（浅色 `rgb(31, 70, 184)`，深色 `rgb(91, 141, 239)`）。
3. `background` 为 `rgba(0, 0, 0, 0)`（透明），没有整条底色。
4. 文案包含「还没有配置 AI，现在只能手动操作网络。」与「去配置」。
5. 横幅高度由内容决定，不因透明底变成一块卡片。

**不合格时记录什么**：

- 两次 JSON。
- 横幅截图。
- `borderLeftWidth / borderLeftColor / background` 与期望的差异。

### E6-21 零配置时助手自动展开与本次运行内关闭

**前置**：M1；1440×900；清空 `veyl.*`；先在首启页保存一个 mock Key 使 AI 可用；保持零配置。

**步骤**：

1. 进入主界面后等 300ms，执行：

```js
(() => ({
  panel: Boolean(document.querySelector("#ai-panel")),
  tab: Boolean(document.querySelector(".assistant-tab")),
  configs: document.querySelectorAll(".config").length,
}))()
```

2. 点 `[aria-label="收起助手"]`，立即执行一次；等 1 秒再执行一次。
3. 刷新页面，等 300ms，再执行一次。

**预期**：

1. 零配置进入：`panel=true`、`tab=false`、`configs=0`（§1.2 自动展开）。
2. 手动收起后：`panel=false`、`tab=true`；1 秒后仍是收起，**本次运行内不再强制展开**。
3. 刷新后：`panel=true`、`tab=false`，按 §1.2 重新展开。
4. **不实现「记住上次关闭」**：不要断言「刷新后仍保持收起」；如果观察到刷新后仍收起，才是失败。
5. 自动展开不改变连接状态，不新建配置。

**不合格时记录什么**：

- 三次 JSON 与截图。
- `veyl.ui.panelOpen` / `veyl.ui.panelVersion` / `veyl.ui.panelClosedByUser` 的 localStorage 值。
- 刷新前后的面板状态。

### E6-22 全局间距：四个容器已归格，其余只记已知

> 打磨批把四处间距归到 4px 网格：`.config`、`.chat__scroll`、`.ledger__row`、`.app-toast`。这四处可以断言；其余容器仍有未归格的值，照旧只记录、不判失败。

**前置**：M1；1440×900；主界面、设置、新建配置、右栏都打开过一遍；对话里至少一轮回复（渲染出 `.ledger__row`）；触发过一次提示条（`.app-toast` 在 DOM 中）。

**步骤**：

1. 抽查四个已归格容器的 `padding`：

```js
(() => {
  const sels = [".config", ".chat__scroll", ".ledger__row", ".app-toast"];
  return sels.map((sel) => {
    const el = document.querySelector(sel);
    if (!el) return { sel, found: false };
    const s = getComputedStyle(el);
    return { sel, found: true, padding: [s.paddingTop, s.paddingRight, s.paddingBottom, s.paddingLeft] };
  });
})()
```

2. 再抽查其余容器的 `marginTop / marginBottom / paddingTop / paddingBottom / gap`，记录不是 4 或 8 的倍数的值：

```js
(() => {
  const sels = [".console", ".hero", ".settings-section", ".modal", ".rail", ".ai-panel"];
  return sels.map((sel) => {
    const el = document.querySelector(sel);
    if (!el) return { sel, found: false };
    const s = getComputedStyle(el);
    return {
      sel,
      found: true,
      margin: [s.marginTop, s.marginRight, s.marginBottom, s.marginLeft],
      padding: [s.paddingTop, s.paddingRight, s.paddingBottom, s.paddingLeft],
      gap: s.gap,
    };
  });
})()
```

3. 把两次结果写进当天的 `spacing-known.md`；发现元素重叠、裁切或点不到时，单独开缺陷。

**预期**：

1. 四个已归格容器的 `padding` 等于已知值（偏差 ≤0.5px，亚像素四舍五入可接受）：
   - `.config`：`["12px", "36px", "12px", "12px"]`
   - `.chat__scroll`：`["24px", "16px", "8px", "16px"]`
   - `.ledger__row`：`["16px", "0px", "16px", "0px"]`
   - `.app-toast`：`["8px", "12px", "8px", "16px"]`
2. 其余容器只写「已记录」，不写「间距合格」；未归格的值不能当失败依据。
3. `spacing-known.md` 至少包含步骤 2 六个容器的 margin / padding / gap 原值，以及步骤 1 四个容器的 padding 原值。
4. 发现重叠、裁切、不可点击时，另开缺陷并附截图；不在本条判失败。
5. 本手册其他用例不对未归格的间距做断言。

**不合格时记录什么**：

- 步骤 1、2 的完整 JSON。
- 四个已归格容器中偏差的那一个：选择器、实际值、期望值。
- 发现重叠 / 裁切 / 不可点击的元素与截图。
- `spacing-known.md` 的路径。

### E6-23 设置弹窗打开时提示条让到弹窗头下方

**前置**：M1；1440×900；已有一套配置；设置弹窗可打开。

**步骤**：

1. 打开设置（左栏底部「设置」），停在「连接」页。
2. 在设置里触发一次 info 提示：用「添加节点 › 文本导入」粘贴一条合法 `ss://` 链接并点「导入」，出现「已添加 N 个节点」提示；**立即**执行下面的脚本（提示条 4 秒后消失，超时就再触发一次）：

```js
(() => {
  const t = document.querySelector(".app-toast");
  const h = document.querySelector(".modal--settings .modal__head");
  if (!t || !h) return { found: { toast: !!t, head: !!h } };
  const tr = t.getBoundingClientRect();
  const hr = h.getBoundingClientRect();
  const s = getComputedStyle(t);
  const close = document.querySelector(".app-toast__close");
  const cr = close?.getBoundingClientRect();
  const hit = cr ? document.elementFromPoint(cr.left + cr.width / 2, cr.top + cr.height / 2) : null;
  const vh = window.innerHeight;
  const expected = Math.max(0.07 * vh, 0.5 * vh - 390, 24) + 64;
  return {
    viewport: [window.innerWidth, window.innerHeight],
    toastTop: Math.round(tr.top * 10) / 10,
    headTop: Math.round(hr.top * 10) / 10,
    headBottom: Math.round(hr.bottom * 10) / 10,
    zIndex: s.zIndex,
    expectedTop: Math.round(expected * 10) / 10,
    overlap: !(tr.bottom <= hr.top || tr.top >= hr.bottom || tr.right <= hr.left || tr.left >= hr.right),
    closeHit: close && hit ? close === hit || close.contains(hit) : null,
    hasSupport: CSS.supports("selector(:has(*))"),
  };
})()
```

3. 把窗口高度依次改为 720 和 1200（宽度保持 1440），每次重新触发 info 提示后执行同一段脚本，记录 `toastTop` 与 `expectedTop`。

**预期**：

1. 1440×900 时 `toastTop` 为 **127（±2）**，`expectedTop` 同为 127；`zIndex` 为 `"90"`。
2. `overlap` 为 `false`：提示条与 `.modal--settings .modal__head` 矩形不相交（900 高时头部底边约 120，提示条顶边约 127）。
3. `closeHit` 为 `true`：提示条完整可见，关闭按钮没有被弹窗遮住。
4. 720 高时 `toastTop` 约 114、1200 高时约 274，均与 `expectedTop` 相差 ≤2。规则是 `.app:has(.modal--settings) .app-toast { top: calc(max(7vh, 50vh - 390px, 24px) + 64px) }`，**窗口高度不同期望值不同**；127 只是 1440×900 的基准值，不要当固定值判。
5. 若 `hasSupport` 为 `false`，或 `toastTop` 约为 96 且 `overlap` 为 `true`：记为「环境不支持」并写入 `notes.md`（WebView 不支持 `:has()`），不算产品不通过。

**不合格时记录什么**：

- 三种窗口高度下的完整 JSON。
- 提示条与设置弹窗头部的截图（带矩形标注）。
- `CSS.supports("selector(:has(*))")` 的结果与实际生效的 `top` 值。

### E6-24 配置名超长时单行省略

**前置**：M1；1440×900；左栏为默认宽度；至少一套配置。

> 造数说明：配置名在界面上最长 40 个字符（`ManualConfigForm` 的 `maxLength={40}`，超出提示「名字最多 40 个字符。」），**通过界面造不出 60 个字符的名字**。40 个中文字符在默认栏宽下已远超可用宽度，足以验证省略。若确需更长的名字，只能由测试者直接改数据库（不属于本用例的必经步骤，也不代表产品路径）。

**步骤**：

1. 新建或编辑一套「我自己配置」的配置，名称填 40 个字符（例如「超长名称测试」重复 6 次再加 4 个字），保存。
2. 执行：

```js
(() => {
  const rows = [...document.querySelectorAll(".configs__row")];
  const row = rows.find((r) => {
    const n = r.querySelector(".config__name");
    return n && n.textContent.trim().length >= 30;
  });
  if (!row) return { found: false };
  const n = row.querySelector(".config__name");
  const d = row.querySelector(".config__delete");
  const s = getComputedStyle(n);
  const nr = n.getBoundingClientRect();
  const rr = row.getBoundingClientRect();
  const dr = d?.getBoundingClientRect();
  return {
    textLength: [...n.textContent.trim()].length,
    title: n.getAttribute("title"),
    titleEqualsText: n.getAttribute("title") === n.textContent.trim(),
    whiteSpace: s.whiteSpace,
    textOverflow: s.textOverflow,
    overflow: s.overflow,
    lineHeight: s.lineHeight,
    fontSize: s.fontSize,
    nameHeight: Math.round(nr.height * 10) / 10,
    rowHeight: Math.round(rr.height),
    scrollWidth: n.scrollWidth,
    clientWidth: n.clientWidth,
    truncated: n.scrollWidth > n.clientWidth,
    nameRight: Math.round(nr.right * 10) / 10,
    deleteLeft: dr ? Math.round(dr.left * 10) / 10 : null,
    deleteInsideRow: dr ? dr.left >= rr.left && dr.right <= rr.right && dr.top >= rr.top && dr.bottom <= rr.bottom : null,
    gapToDelete: dr ? Math.round((dr.left - nr.right) * 10) / 10 : null,
  };
})()
```

3. 把鼠标移到该行上，确认删除按钮出现且可点。

**预期**：

1. `whiteSpace` 为 `"nowrap"`，`textOverflow` 为 `"ellipsis"`，`overflow` 为 `"hidden"`。
2. `truncated` 为 `true`（`scrollWidth > clientWidth`），说明确实被截断而不是撑开。
3. 名称只有一行：`nameHeight` 约 19.5–20（15px × 1.3），与 `lineHeight` 一致；没有第二行。
4. `rowHeight` 为 64（±1），与 E6-15 的骨架行同高。
5. `titleEqualsText` 为 `true`：`title` 是完整名字，不是省略后的文本。
6. `deleteInsideRow` 为 `true`，且 `gapToDelete ≥ 0`：删除按钮完整落在行内，没有被挤出或被文字覆盖。

**不合格时记录什么**：

- 上述完整 JSON（含 `textLength` / `title` 原文）。
- 该行的截图：完整栏宽，能看出省略号与删除按钮位置。
- 若名称换行或行高被撑开：`nameHeight`、`lineHeight`、`rowHeight` 三个值与截图。

### E6-25 进入「已连接，不通」的版式与文案

依据：`docs/design/connected-no-traffic.md` §3–§6、§8；判定函数 `src/ui/dataPlane.ts`；hero 分支 `src/components/Console.tsx`。

**前置**：M1；1440×900；浅色；一套可连接的配置（默认「所有软件都走 VPN」，至少一个节点）；页面已重新加载。

**步骤**：

1. 连接成功，看到「已连接」与计时器后，先记录正常状态下的中间区块签名：

```js
(() => {
  const body = document.querySelector(".console__body");
  const status = body?.querySelector("p[role='status']");
  return body
    ? [...body.children]
        .filter((el) => el !== status && !el.classList.contains("hero"))
        .map((el) => el.tagName + "." + (el.className || ""))
    : null;
})()
```

2. 断开 VPN；执行 `localStorage.setItem("veyl.mock.dataPlaneDown", "1")`；再点「启动 VPN」。连接前先设这个开关也可以。
3. 等 2 秒，执行：

```js
(() => {
  const q = (s) => document.querySelector(s);
  const body = q(".console__body");
  const word = body?.querySelector(".state-word");
  const led = word?.querySelector(".led");
  const action = body?.querySelector(".hero__action");
  const ws = word ? getComputedStyle(word) : null;
  const as = action ? getComputedStyle(action) : null;
  const primary = [...(body?.querySelectorAll(".hero .btn--primary") ?? [])];

  const probeBg = document.createElement("span");
  probeBg.style.background = "var(--amber)";
  const probeInk = document.createElement("span");
  probeInk.style.color = "var(--ink-2)";
  const probeCh = document.createElement("span");
  probeCh.style.cssText = "position:absolute;visibility:hidden;white-space:nowrap;";
  if (as) {
    probeCh.style.fontSize = as.fontSize;
    probeCh.style.fontFamily = as.fontFamily;
    probeCh.style.fontWeight = as.fontWeight;
    probeCh.style.letterSpacing = as.letterSpacing;
  }
  probeCh.textContent = "0".repeat(46);
  document.body.append(probeBg, probeInk, probeCh);
  const amber = getComputedStyle(probeBg).backgroundColor;
  const ink2 = getComputedStyle(probeInk).color;
  const ch46 = probeCh.getBoundingClientRect().width;
  probeBg.remove();
  probeInk.remove();
  probeCh.remove();

  const status = body?.querySelector("p[role='status']");
  const blocks = body
    ? [...body.children]
        .filter((el) => el !== status && !el.classList.contains("hero"))
        .map((el) => el.tagName + "." + (el.className || ""))
    : [];

  return {
    stateWord: word ? word.textContent.trim() : null,
    fontSize: ws?.fontSize ?? null,
    timecode: !!body?.querySelector(".timecode"),
    ledClass: led?.className ?? null,
    ledBg: led ? getComputedStyle(led).backgroundColor : null,
    amber,
    primaryCount: primary.length,
    primaryText: primary.map((b) => b.textContent.trim()),
    primaryClass: primary[0]?.className ?? null,
    action: action ? action.textContent.trim() : null,
    actionFontSize: as?.fontSize ?? null,
    actionColor: as?.color ?? null,
    ink2,
    actionMaxWidth: as?.maxWidth ?? null,
    ch46: Math.round(ch46 * 10) / 10,
    blocks,
    visiblePhraseLeaves: body
      ? [...body.querySelectorAll("*")].filter(
          (el) =>
            el.children.length === 0 &&
            !el.closest(".sr-only") &&
            el.textContent.includes("已连接，不通"),
        ).length
      : null,
  };
})()
```

**预期**：

1. `stateWord` 为 `已连接，不通`；`fontSize` 为 `44px`。
2. `timecode` 为 `false`：本状态没有 64px 计时器。
3. `ledClass` 含 `is-warn`；`ledBg` 等于 `amber`（脚本用 `--amber` 现算，不写死色值）。
4. `primaryCount` 为 1；`primaryText[0]` 为 `重新连接`；`primaryClass` 含 `btn--primary`。
5. `action` 逐字等于 `网页打不开时，点上面的「重新连接」；还是不行，就换下面的节点再试。`；`actionFontSize` 为 `15px`；`actionColor` 等于 `ink2`；`actionMaxWidth` 与 `ch46` 相差 ≤1。
6. `blocks` 与步骤 1 的记录逐项相同：本状态**不新增中间区块**。
7. `visiblePhraseLeaves` 为 1：可见区域只有 hero 里那一处状态词，没有第二处重复。

**不合格时记录什么**：

- 步骤 1 与步骤 3 的两个数组。
- 上述 JSON 全文与截图（hero、行动句、按钮一起入画）。
- 字号 / 颜色 / 最大宽度不符时：计算值与期望值各写一遍。

### E6-26 探测恢复后回到「已连接」

**前置**：接 E6-25，界面处于「已连接，不通」。

**步骤**：

1. 执行 `localStorage.removeItem("veyl.mock.dataPlaneDown")`。
2. 立刻执行下面的脚本，每 500ms 轮询一次，最多等 10 秒：

```js
(async () => {
  const t0 = performance.now();
  const from = document.querySelector(".console__body .state-word")?.textContent.trim() ?? null;
  while (performance.now() - t0 < 10000) {
    if (document.querySelector(".console__body .timecode")) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  const body = document.querySelector(".console__body");
  return {
    from,
    elapsedMs: Math.round(performance.now() - t0),
    timecode: !!body?.querySelector(".timecode"),
    stateLine: body?.querySelector(".state-line__label")?.textContent.trim() ?? null,
    action: body?.querySelector(".hero__action")?.textContent.trim() ?? null,
    ledClass: body?.querySelector(".state-line .led")?.className ?? null,
  };
})()
```

**预期**：

1. `from` 为 `已连接，不通`；`elapsedMs ≤ 10000`（mock 通道下通常 ≤2500）。
2. `timecode` 为 `true`；`stateLine` 为 `已连接`；`ledClass` 含 `is-ok`。
3. `action` 为 `null`：行动句随状态消失。

**不合格时记录什么**：

- 上述 JSON；超时则附每 500ms 的状态词序列（在轮询里加 `samples.push(s)`）。
- 恢复前后的两张截图。

### E6-27 「重新连接」的过渡与按钮唯一性

**前置**：接 E6-25，界面处于「已连接，不通」；`veyl.mock.dataPlaneDown` 仍为 `1`。

**步骤**：

1. 用同一句脚本「先清开关、再点按钮」，保证点击发生在下一次 2 秒健康事件之前：

```js
(() => {
  localStorage.removeItem("veyl.mock.dataPlaneDown");
  const btn = [...document.querySelectorAll(".console__body .hero .btn--primary")].find(
    (b) => b.textContent.trim() === "重新连接",
  );
  btn?.click();
  return { clicked: !!btn };
})()
```

2. 执行下面的观察脚本（200ms 采样，最多 15 秒）：

```js
(async () => {
  const t0 = performance.now();
  const samples = [];
  let sawConnecting = false;
  const snap = () => {
    const body = document.querySelector(".console__body");
    const word = body?.querySelector(".state-word, .state-line__label")?.textContent.trim() ?? null;
    const buttons = [...(body?.querySelectorAll(".hero .btn") ?? [])].map((b) => b.textContent.trim());
    return {
      word,
      timecode: !!body?.querySelector(".timecode"),
      buttons,
      primaryCount: body?.querySelectorAll(".hero .btn--primary").length ?? null,
    };
  };
  while (performance.now() - t0 < 15000) {
    const s = snap();
    samples.push({ t: Math.round(performance.now() - t0), ...s });
    if (s.word === "正在连接") sawConnecting = true;
    if (sawConnecting && s.timecode) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  return { sawConnecting, elapsedMs: Math.round(performance.now() - t0), final: snap(), samples };
})()
```

**预期**：

1. `clicked` 为 `true`；`sawConnecting` 为 `true`：中间经过「正在连接」。
2. `final.word` 为 `已连接`；`final.timecode` 为 `true`；`elapsedMs ≤ 15000`（mock 下约 2.4–4 秒）。
3. 任一采样里 `primaryCount ≤ 1`；`buttons` 至多两个元素，且没有一项同时包含「重新连接」与「断开 VPN」——按钮文案不叠加。
4. 整个过程没有出现两个主按钮并排（`primaryCount` 没有 ≥2 的采样）。

**不合格时记录什么**：

- `clicked`、`samples` 全文。
- 「正在连接」与结束态两张截图。
- 出现两个主按钮的采样时间点。

### E6-28 与「连接不稳定」不叠加

**前置**：M2 原生应用；TUN 配置可连接；终端能 `pgrep -f sing-box`；测试者愿意暂停再恢复核心进程。

**步骤**（构造由测试者执行，AI 只读界面与日志）：

1. 连接成功，确认是普通「已连接」。
2. 取核心 pid：`pgrep -f "/sing-box" | head -1`。
3. `kill -STOP <pid>` 暂停核心（不是杀掉，进程仍在，能恢复）。
4. 等 8–12 秒：健康检查每 2 秒一次，连续 3 次失败进入降级。
5. 读取界面。能开 DevTools 就执行下面的脚本，否则按同样四点用截图核对：

```js
(() => {
  const body = document.querySelector(".console__body");
  return {
    stateLine: body?.querySelector(".state-line__label")?.textContent.trim() ?? null,
    stateWord: body?.querySelector(".state-word")?.textContent.trim() ?? null,
    timecode: !!body?.querySelector(".timecode"),
    action: body?.querySelector(".hero__action")?.textContent.trim() ?? null,
    textHasNoTraffic: body?.textContent.includes("已连接，不通") ?? null,
  };
})()
```

6. 恢复：`kill -CONT <pid>`；等 ≤10 秒，或断开后重连。

**预期**：

1. `stateLine` 为 `连接不稳定`；`stateWord` 为 `null`。
2. `textHasNoTraffic` 为 `false`：**不出现**「已连接，不通」。
3. `action` 为 `null`：不显示本状态的行动句。
4. `timecode` 为 `true`：降级仍显示计时器（与 E6-25 相反）。

> 降级 30 秒左右会触发自动重启；在 8–12 秒的窗口内读数即可，不要等到重启后。

**不合格时记录什么**：

- 上述 JSON 与降级前后两张截图。
- `pgrep -f "/sing-box"` 的原始输出。
- `grep -E '健康|degraded|clash|重启' "$APP_LOG" | tail -20`。

### E6-29 健康快照过期后退出本状态

依据：`DATA_PLANE_FRESH_MS = 30_000`（`src/ui/dataPlane.ts`）；`connected-no-traffic.md` §7「新鲜度」。

**前置**：M1；接 E6-25，界面处于「已连接，不通」。

**步骤**：

1. 停掉 mock 的健康源。它和界面在同一个页面里，所以界面自己的 1 秒时钟仍继续走，`checked_at` 却不再更新：

```js
(async () => {
  const mod = await import("/src/agent/index.ts");
  const bridge = mod.getAgentBridge();
  if (typeof bridge.stopTrafficTicker !== "function") {
    return { ok: false, reason: "bridge 上没有 stopTrafficTicker" };
  }
  bridge.stopTrafficTicker();
  return { ok: true, checkedAt: bridge.runtime?.health?.checked_at ?? null, now: Date.now() };
})()
```

2. 等 31–32 秒，执行：

```js
(() => {
  const body = document.querySelector(".console__body");
  return {
    stateWord: body?.querySelector(".state-word")?.textContent.trim() ?? null,
    stateLine: body?.querySelector(".state-line__label")?.textContent.trim() ?? null,
    timecode: !!body?.querySelector(".timecode"),
    action: body?.querySelector(".hero__action")?.textContent.trim() ?? null,
  };
})()
```

3. 刷新页面恢复（会重新建连）。

**预期**：

1. `stateWord` 为 `null`；`stateLine` 为 `已连接`；`timecode` 为 `true`；`action` 为 `null`。
2. 退出原因是「快照过期」，不是 `data_plane` 变 `true`（后者由 E6-26 覆盖）：本步骤里没有任何新快照进来。

**不合格时记录什么**：

- 步骤 1、2 的 JSON。
- `bridge.runtime.health.checked_at` 与读取时 `Date.now()` 的差值。
- 截图与当时的状态词。

**构造失败时**：动态 import 取不到 bridge（非 dev 构建、模块路径变了）就记「阻塞（M1 构造失败）」，改走 M2：应用主进程与界面所在 WebContent 是不同进程，`kill -STOP <应用主进程 pid>` 后界面仍继续渲染；35 秒后应看到「已连接」+ 计时器，用屏幕录制留证（主进程暂停期间 DevTools 可能不可用），随后 `kill -CONT` 恢复。拿不到可判读画面则记「阻塞（未取证）」。

### E6-30 读屏只播报一次

**前置**：M1；接 E6-25，界面处于「已连接，不通」。

**步骤**：

1. 执行下面的脚本，观察 12 秒（覆盖约 6 次健康事件）：

```js
(async () => {
  const region = document.querySelector(".console__body > p[role='status'][aria-live='polite']");
  if (!region) return { found: false };
  const initial = region.textContent;
  const changes = [];
  const mo = new MutationObserver(() => changes.push(region.textContent));
  mo.observe(region, { childList: true, characterData: true, subtree: true });
  await new Promise((r) => setTimeout(r, 12000));
  mo.disconnect();
  return {
    found: true,
    initial,
    mutations: changes.length,
    final: region.textContent,
    unchanged: region.textContent === initial,
    ariaLive: region.getAttribute("aria-live"),
  };
})()
```

**预期**：

1. `found` 为 `true`；`ariaLive` 为 `polite`。
2. `initial` 逐字等于 `已连接，不通。网页打不开时，点上面的「重新连接」；还是不行，就换下面的节点再试。`
3. 12 秒内 `mutations` 为 `0`，`unchanged` 为 `true`：健康事件重发、文本不变时不重复播报。

**不合格时记录什么**：

- 上述 JSON（含 `initial` 与 `mutations`）。
- 若反复变更：每次变更后的文本与时间。
- 录屏或截图。

### E6-31 真实断流的进入与恢复（M2，可选）

**前置**：M2 原生应用；真实 TUN 配置可连接；测试者能断开网络（关 Wi-Fi 或拔网线）并恢复。

**步骤**：

1. 连接成功，记下「已连接」与计时器。
2. 断开网络，开始计时。
3. 每 5 秒记录一次状态词与计时器是否存在，最多观察 40 秒。
4. 进入「已连接，不通」后恢复网络；继续每 2 秒记录一次，最多 15 秒。

**预期**：

1. 20–30 秒内状态词变为「已连接，不通」，计时器消失，状态点为琥珀色，出现行动句。
2. 恢复网络后 ≤10 秒回到「已连接」+ 计时器，行动句消失。
3. 本构造只断上行，Clash API 在本地仍然可达，预期不会进入「连接不稳定」；若出现，记录发生时刻与日志，不直接判失败。

**不合格时记录什么**：

- 状态序列（含时间戳）、三张截图（进入前 / 进入后 / 恢复后）。
- `grep -E '健康|data_plane|探测|degraded' "$APP_LOG" | tail -20`。

**做不到时**：无法制造真实数据面失败（探测目标不可达、或只有代理模式没有 TUN）就记「阻塞」，写明尝试过的构造与现象，不判产品不通过。本条标为可选，其余六条必做。

---

## 7. 异常路径

本章的「制造异常」都由测试者执行；AI 只读日志和系统状态，不参与制造。

### E7-01 拒绝管理员授权

- **目的**：验证用户取消授权后连接失败但可重试，系统状态没有被改坏。
- **前置条件**：需要一次管理员授权（首次安装/更新后台组件）；测试者愿意在弹窗里点「取消」。
- **步骤（人做）**
  1. 触发「全部流量」连接。
  2. 在系统授权弹窗里点「取消」。
  3. 记录界面提示，再点一次连接，这次允许授权。
- **AI 取证**
  ```bash
  grep -E '授权|管理员|helper|取消|denied' "$APP_LOG" | tail -20
  ps -Ao pid,comm,args | grep -E 'veyl-helper|sing-box' | grep -v grep
  ```
  看什么：日志有没有记录授权取消；有没有残留的 sing-box；第二次连接是否成功。
- **可观察预期**
  - 取消后界面给出可理解的提示（例如「这次没有授权，可以再试一次。」），不出现英文错误码。
  - 不反复自动弹授权；用户主动再点连接才会再尝试。
  - 取消后系统代理/DNS/路由没有被改坏，浏览器仍能上网。
  - 第二次允许授权后连接成功。
- **判定**
  - [ ] 通过
  - [ ] 失败
- **失败时收集**：取消后的界面截图、日志尾、`scutil --proxy` 与 `scutil --dns`。

### E7-02 端口被占用

- **目的**：验证设置端口被占用时自动顺延，并明确告诉用户实际用的是哪个端口。
- **前置条件**：代理模式；设置端口为 7890；测试者先占住 7890（例如在另一个终端跑 `python3 -m http.server 7890`）。
- **步骤（人做）**
  1. 确认 7890 已被占用（测试者自行启动一个临时服务）。
  2. 在应用里点「启动 VPN」。
  3. 记录控制台代理卡地址与提示。
  4. 断开，关掉临时服务。
- **AI 取证**
  ```bash
  lsof -nP -iTCP:7890 -sTCP:LISTEN
  lsof -nP -iTCP -sTCP:LISTEN | grep -E '789[0-9]'
  scutil --proxy
  grep -E '连接完成|端口|occupied' "$APP_LOG" | tail -6
  ```
  看什么：7890 被别的进程占用；应用改用了 7891–7899 中的另一个端口；`scutil --proxy` 指向新端口。
- **可观察预期**
  - 连接成功，不因为端口被占用而失败。
  - 代理卡显示实际端口，并有一行「你设置的 7890 被别的软件占用了，这次用的是 {实际端口}。」
  - 设置里的保存值仍然是 7890，不被悄悄改掉。
  - 系统代理指向实际端口。
- **判定**
  - [ ] 通过
  - [ ] 失败
- **失败时收集**：端口占用命令输出、代理卡截图、设置页截图、日志。

### E7-03 特权组件缺失

- **目的**：验证后台组件不可用时，用户看到可理解的失败与修复入口，代理模式不受影响。
- **前置条件**：一台没有安装过后台助手的机器；或由测试者在系统设置里移除 Veyl 的后台项（本文不提供命令）。
- **步骤（人做）**
  1. 尝试连接「全部流量」。
  2. 记录界面提示。
  3. 打开设置 › 遇到问题，看后台组件状态和可点的修复入口。
  4. 切换到代理配置，确认仍能连接。
- **AI 取证**
  ```bash
  grep -E 'helper|后台组件|tun_denied|helper_missing|连接失败' "$APP_LOG" | tail -20
  ps -Ao pid,comm,args | grep -E 'veyl-helper|sing-box' | grep -v grep
  ```
  看什么：失败原因是否归到「后台组件」而不是含糊的「未知错误」；代理模式连接是否有日志。
- **可观察预期**
  - TUN 连接失败时给出用户语言的原因和下一步，不出现 `helper_missing` 之类的内部码。
  - 设置里有后台组件状态和修复/重试入口。
  - 代理模式仍能正常连接和断开。
  - 不自动重试、不偷偷降级成代理模式。
- **判定**
  - [ ] 通过
  - [ ] 失败
- **失败时收集**：失败卡截图、设置页截图、代理连接结果、日志尾。

### E7-04 连接中途断网

- **目的**：验证已连接后断网不会让界面卡死，恢复网络后状态能回到正确值。
- **前置条件**：已连接（TUN 或代理均可，TUN 更能覆盖 DNS）；测试者能关闭/打开 Wi-Fi。
- **步骤（人做）**
  1. 已连接状态下关闭 Wi-Fi。
  2. 等 10 秒，记录界面状态。
  3. 重新打开 Wi-Fi，等 30 秒，记录状态。
  4. 如果仍未恢复，手动断开再连接一次。
- **AI 取证**
  ```bash
  date '+%F %T'
  curl -s --max-time 5 https://ipinfo.io/ip; echo
  netstat -rn -f inet | grep '^default'
  grep -E '健康|health|degraded|连接失败|重启' "$APP_LOG" | tail -12
  ```
  看什么：断网后健康检查是否连续失败；状态是否进入「连接不稳定」而不是直接卡在「已连接」；恢复网络后是否回到「已连接」或自动重启。
- **可观察预期**
  - 断网后应用不崩溃、不弹崩溃框；界面仍可操作，「断开 VPN」可以点。
  - 约 10 秒内 `curl` 与浏览器访问都会失败；这是预期内的断网结果。
  - **界面可能仍显示「已连接」**：当前设计规定「数据面探测失败只更新快照，不单独判降级」，所以不要用「必须变成连接不稳定」作为失败条件。把这当作观察项记录；如果一直显示已连接且没有任何提示，写进总结作为体验问题。
  - 重新打开 Wi-Fi 后 30 秒内，出口 IP 恢复正确，浏览器能上网；如果 30 秒后仍不行，手动断开再连接一次应能恢复。
  - 整个过程不出现「配置丢失」「无法断开」「应用卡死」。
- **判定**
  - [ ] 通过（不崩溃、可断开、恢复后可用）
  - [ ] 失败（卡死、无法断开、恢复后不可用）
- **失败时收集**：断网前/断网中/恢复后三张截图、时间点、日志尾、路由输出。如果界面在断网期间一直显示「已连接」，把它单独写在总结的「体验问题」里。

---

## 8. 设置（改版后）

> **本章用例在设置改版落地后执行；改版前的当前状态见 §8.0 现状对照。**
> 依据：`docs/design/settings-ia.md`（2026-11-11 定稿，627 行）。本章只按该方案的决策写，不新增方案里没有的行为。

### 8.0 现状对照（改版前 → 改版后）

先确认你面前的是哪一版。如果你看到的界面与下表「改版前」一致（例如 tab 还叫「AI 助手」、连接 tab 还有「用哪个节点」、导入还叫「导入节点文件」），说明改版尚未落地：**停止执行本章，把版本和截图报给 PM，不要按新用例判失败。**

| # | 项目 | 改版前（当前代码） | 改版后（本章验收） |
|---|---|---|---|
| 1 | 四个 tab 的名称 | AI 助手 / 连接 / 遇到问题 / 关于 | **AI 服务** / 连接 / 遇到问题 / 关于 |
| 2 | tab 语义与键盘 | 普通按钮 + `aria-current`，方向键不能切 | `tablist / tab / tabpanel`，左右方向键、Home / End 可切，焦点跟随 |
| 3 | 页内标题 | AI 助手、遇到问题、关于各有一行与 tab 同名的标题 | 三处页内标题删除，不与 tab 名重复 |
| 4 | 连接 tab 的节点行 | 有「用哪个节点」整行，可打开节点面板 | 删除；主界面底部是**唯一**节点切换入口 |
| 5 | 添加节点 | 「导入节点文件」，实际只收 Veyl 种子 JSON | 「添加节点」弹层：粘贴 `ss://`、https 订阅、从文件导入（已实现） |
| 6 | 无配置时的连接 tab | 仍显示端口行（条件只排除 tun） | 只留「还没有配置」+ 新建；端口与节点来源都不出现 |
| 7 | 端口行的出现条件 | 非 tun 就显示 | 仅 `system_proxy` 且有配置时显示；tun 与无配置都不显示 |
| 8 | 端口顺延说明 | 用 `mixed_port !== proxyPort` 推断，可能与「已保存，下次连接生效」叠成两句 | 用 `runtime.port_fallback`；同一时刻只显示一句，合成句不再叠加保存提示 |
| 9 | 重置网络 | 入口叫「强制重置网络」；成功也全量展开八步 | 入口与确认按钮都叫「重置网络」；成功一行 + 可展开八步，失败默认展开 |
| 10 | 关于页 | 只有版本 | 版本 + 开源与反馈（有 URL 才摆）+ 一句数据去向 |
| 11 | 问 AI 后返回 | 关闭设置，重开落回 AI 助手 tab | 重开设置回到刚才那个 tab |
| 12 | 导入跳过原因 | 显示英文枚举 `duplicate` / `malformed` | 中文原因：已有同名节点 / 不是 ss:// 链接 / 加密方式不支持 / 内容不完整 |
| 13 | 连接方式文案 | 「全部流量 / 接管全部 / 系统代理」等混用 | 全部软件走 VPN / 浏览器走 VPN / 只有填了地址的软件走 VPN |
| 14 | 文件通道 | 未实现，`node_import_file` 待派 | 已实现，随本批次验证 |

### 8.1 执行前提

- 设置改版已经落地到被测构建；构建版本记录在 `notes.md`。
- 至少准备三套配置：一套「全部软件走 VPN」（tun）、一套「浏览器走 VPN」（system_proxy + direct）、一套「只有填了地址的软件走 VPN」（system_proxy + proxy_selected）。
- 准备一份可用的 `ss://` 文本（两行）、一个 https 订阅地址、一个 http 订阅地址；E8-05 另需 .txt / .json / 超过 1 MB 的文件。
- 本章多数条目是界面与键盘判断。**§8.1 的 E8-01…E8-14 保留为改版基线（人工 + 截图/DB 取证）；本次 P1 设置改动一律执行 §8.2 的 E8-15…E8-20**，它们用 M1 的 DOM 断言，只有真实导入 / 真实端口 / 失败构造才用 M2 补证。两者冲突时以 §8.2 为准。

---

### E8-01 四个 tab 的名称与顺序

- **目的**：验证分区导航恰好四个 tab，第一个是「AI 服务」，顺序固定，且不再出现与 tab 同名的页内标题。依据 IA §2.3 / §3.1 A2 / §3.3 P1 / §3.4 U1。
- **前置条件**：改版已落地；应用已启动；不需要管理员。
- **步骤（人做）**
  1. 打开设置（左栏底部设置按钮）。
  2. 从左到右读四个 tab 的名称，记录哪个处于选中态。
  3. 依次点开四个 tab，看每个 tab 的内容区顶部是否还有重复的页内标题。
  4. 截图。
- **AI 取证**
  ```bash
  date '+%F %T'
  tail -n 30 "$APP_LOG"
  ```
  看什么：应用在跑、没有启动错误。tab 文案与顺序**不能**从日志判断，本条结论由人给出；AI 只记录时间与日志，不推断界面。
- **可观察预期**
  - 四个 tab 依次是「AI 服务」「连接」「遇到问题」「关于」，没有第五个。
  - 打开设置时默认选中「AI 服务」，且它是第一个。
  - 不再出现「AI 助手」这个 tab 名。
  - 「AI 服务」「遇到问题」「关于」三个内容区顶部没有与 tab 同名的页内标题（例如不出现两行「遇到问题」）。
  - 四个 tab 都能点开，设置弹窗不关闭。
- **判定**
  - [ ] 通过
  - [ ] 失败
- **失败时收集**：四个 tab 的截图、设置弹窗全图、构建版本。

### E8-02 节点切换只剩主界面底部

- **目的**：验证设置里不再有「用哪个节点」，主界面底部仍是唯一的切换入口，切换后状态同步。依据 IA §0.1 决议 1 / §2.2 / §3.2 C3。
- **前置条件**：至少一套配置有 2 个节点；应用未连接或已连接均可。
- **步骤（人做）**
  1. 打开设置 › 连接，找「用哪个节点」整行或类似入口，记录是否存在。
  2. 关闭设置，回到主界面，找到底部的当前节点卡。
  3. 用底部入口切换到另一个节点，记录切换前后的节点名。
  4. 再打开设置 › 连接，确认没有出现节点行。
- **AI 取证**
  ```bash
  sqlite3 -readonly "$HOME/.veyl/veyl.db" "select name, current_node_id from configs where is_active = 1;"
  ```
  在切换前后各执行一次；看什么：`current_node_id` 是否从旧节点变成新节点。
- **可观察预期**
  - 设置 › 连接里没有「用哪个节点」整行、按钮或 `›` 入口。
  - 主界面底部仍显示当前节点名，并且可以切换。
  - 切换后 `current_node_id` 变化，主界面节点名同步变化。
  - 设置里没有因为删除这一行留下空白、错位或孤立的「去哪切」说明。
- **判定**
  - [ ] 通过
  - [ ] 失败
- **失败时收集**：设置连接 tab 截图、主界面底部截图、切换前后的 SQL 输出。

### E8-03 添加节点：粘贴 ss:// 文本

- **目的**：验证「添加节点」能用粘贴的多行 `ss://` 链接导入，结果用中文说明。依据 IA §3.2 C12 / C13 / C14。
- **前置条件**：已有至少一套配置；准备两行可用的 `ss://` 链接。
- **步骤（人做）**
  1. 打开设置 › 连接，找到「添加节点」行，点「添加」。
  2. 记录弹层标题、文本框提示、初始按钮状态。
  3. 粘贴两行 `ss://`，点「添加」。
  4. 记录结果文案与节点列表变化。
- **AI 取证**
  ```bash
  sqlite3 -readonly "$HOME/.veyl/veyl.db" "select source, count(*) from nodes group by source;"
  sqlite3 -readonly "$HOME/.veyl/veyl.db" "select name, source, created_at from nodes order by created_at desc limit 5;"
  tail -n 60 "$APP_LOG" | grep -E '导入|节点|warn|error' | tail -10
  ```
  看什么：执行后 `nodes` 是否新增两条 `source='manual'`；没有新增 `configs`。
- **可观察预期**
  - 弹层标题是「添加节点」，不是「导入节点文件」。
  - 文本框提示包含「支持多行 `ss://` 链接或 https 订阅地址」。
  - 文本框为空时「添加」不可用；粘贴两行后可点。
  - 导入成功显示「已添加 2 个节点」；关闭设置后，在节点面板能看到这两条节点。
  - 跳过行用中文原因（已有同名节点 / 不是 ss:// 链接 / 加密方式不支持 / 内容不完整），不出现 `duplicate` / `malformed`。
  - 不因为添加节点而新建配置。
- **判定**
  - [ ] 通过
  - [ ] 失败
- **失败时收集**：弹层与结果截图、节点表 SQL、日志尾。

### E8-04 添加节点：https 订阅与 http 拒绝

- **目的**：验证 https 订阅走导入，http 订阅在本地被拒绝且不发请求。依据 IA §3.2 C13。
- **前置条件**：准备一个可用的 https 订阅地址和一个 http 地址；已有配置。
- **步骤（人做）**
  1. 打开「添加节点」弹层，粘贴 `http://example.com/sub`，点「添加」。
  2. 记录提示，确认没有出现「正在获取…」。
  3. 改成真实的 `https://` 订阅地址，点「添加」。
  4. 等结果，记录节点数。
- **AI 取证**
  ```bash
  sqlite3 -readonly "$HOME/.veyl/veyl.db" "select source, count(*) from nodes group by source;"
  sqlite3 -readonly "$HOME/.veyl/veyl.db" "select count(*) from configs;"
  ```
  在 http 与 https 两次操作后各执行一次；看什么：http 那次节点数不变；https 那次新增 `source='url'` 节点。
- **可观察预期**
  - http 地址直接提示「订阅地址要用 https」，不发请求、不新增节点。
  - https 地址点击后按钮变成「正在获取…」，完成后显示导入结果。
  - 订阅失败或订阅里没有节点时，不保存空配置，结果区给出中文原因。
  - 导入成功时节点来源为 `url`。
- **判定**
  - [ ] 通过
  - [ ] 失败
- **失败时收集**：两种地址的提示截图、节点/配置 SQL、订阅地址打码后的记录。

### E8-05 添加节点：从文件导入

- **目的**：验证文件通道的「选文件 → 确认 → 点导入」流程、1 MB 限制、空结果文案与文件名展示。依据 `node_import_file` 契约 §4.1.2 / IA §3.2 C13 / C15。
- **前置条件**：`node_import_file` 已实现（随本批次验证）；准备四个文件：
  - `nodes.txt`：两行 `ss://`。
  - `nodes.json`：内容同样是两行 `ss://`（命令按文本逐行解析，**不解析 Clash / 种子 JSON**）。
  - `big.txt`：超过 1 MB 的任意文本。
  - `clash.json`：一个真实的 Clash 配置 JSON（没有 `ss://` 行），用来验证空结果。
  - 可选：一个只含不支持加密方式的 `ss://` 文件，用来验证逐条跳过。

  可用的 `ss://` 样本（两行，直接复制）：

  ```
  ss://YWVzLTI1Ni1nY206cGFzc3dvcmQ@203.0.113.9:8388#测试节点一
  ss://YWVzLTI1Ni1nY206cGFzc3dvcmQ@203.0.113.10:8388#测试节点二
  ```

- **步骤（人做）**
  1. 打开设置 › 连接 ›「添加节点」弹层。底部同一排应有「从文件导入」「取消」「添加」。
  2. 点「从文件导入」，选择 `nodes.txt`。
  3. **先不要点导入**，记录弹层内容与按钮：应显示「将导入：nodes.txt」，文本框消失，出现「重新选择」「改用文本」「取消」「导入」。
  4. 点「导入」，等结果；记录按钮是否短暂变成「正在导入…」。
  5. 依次用 `nodes.json`、`big.txt`、`clash.json`、可选的不支持加密方式文件重复 2–4 步；每次记录结果**完整文本**与 `.settings-feedback--error` / `role="alert"`。
  6. 确认界面只显示文件名，不显示完整路径。
- **AI 取证**
  ```bash
  sqlite3 -readonly "$HOME/.veyl/veyl.db" "select source, count(*) from nodes group by source;"
  sqlite3 -readonly "$HOME/.veyl/veyl.db" "select config_id, count(*) from config_nodes group by config_id;"
  tail -n 100 "$APP_LOG" | grep -E '文件|导入|节点|warn|error' | tail -15
  grep -F "<本次选择的完整路径>" "$APP_LOG"
  ```
  看什么：合法文件导入后节点数增加；超限 / 空结果没有新增节点；完整路径不在日志里（最后一条应无输出）；日志没有 panic。
- **可观察预期**
  1. 入口按钮是「从文件导入」，与「取消」「添加」同一排；不是「选择文件」。
  2. 选完文件**不会立刻导入**：停在「将导入：<文件名>」，文本框隐藏，主按钮从「添加」变成「导入」；这时数据库节点数尚未变化。
  3. 点「导入」后才调用命令；导入中主按钮显示「正在导入…」。
  4. `nodes.txt` 与 `nodes.json`（内容为两行 `ss://`）都导入成功，显示「已添加 2 个节点」，节点数 +2。
  5. `big.txt` 提示 **「文件太大了，最大 1 MB。换一个小一点的文件。」**。
  6. `clash.json`（没有 `ss://` 行）提示 **「这个文件里没有可用的节点（支持多行 ss:// 链接）。换一个文件。」**；命令层的 message 是同一句去掉「换一个文件。」。
  7. 只有部分节点成功、其余被跳过时，才出现逐条中文原因；加密方式不支持的文案按 `IMPORT_SKIP_REASONS` 为 **「加密方式不支持」**。
  8. 界面显示文件名（`将导入：<文件名>`）是设计要求，用于确认；**完整路径不能显示，也不能写进日志**。
  9. `.json` 能导入的前提是文件里是逐行 `ss://`；拿真实的 Clash / 种子 JSON 会得到第 6 条的空结果，这是预期，不是失败。
- **判定**
  - [ ] 通过
  - [ ] 失败
- **失败时收集**：四个 / 五个文件的结果截图、节点与配置 SQL、日志尾、完整路径 grep 的结果；文件名可保留，路径打码。

### E8-06 端口的两种形态

- **目的**：验证「全部软件」配置没有端口行，「代理」配置有可复制的端口行。依据 IA §2.6 / §3.2 C4 / C5 / §6 验收 2–4。
- **前置条件**：三套配置：tun、system_proxy + direct、system_proxy + proxy_selected；至少代理配置已连接一次。
- **步骤（人做）**
  1. 切到 tun 配置，打开设置 › 连接，记录有没有「本地代理端口」行。
  2. 切到 system_proxy 配置，打开同一屏，记录端口行、地址与「复制」「编辑」。
  3. 点「复制」，粘贴到一个安全的地方，比较显示值与复制值。
  4. 切到没有配置的空态（或删除配置后）再看一次。
- **AI 取证**
  ```bash
  sqlite3 -readonly "$HOME/.veyl/veyl.db" "select name, connection_mode, routing_mode, is_active from configs;"
  sqlite3 -readonly "$HOME/.veyl/veyl.db" "select value from settings where key = 'proxy_port';"
  scutil --proxy
  ```
  看什么：tun 配置的 `connection_mode='tun'`；代理配置的 `connection_mode='system_proxy'`；`proxy_port` 是保存值；已连接时 `scutil --proxy` 指向实际端口。
- **可观察预期**
  - tun 配置：连接 tab 里**没有**「本地代理端口」整行。
  - system_proxy 配置：出现「本地代理端口」行，显示 `127.0.0.1:{端口}`，有「复制」和「编辑」。
  - 已连接时端口行显示本次实际端口；系统代理已设时另有一句「浏览器已经设好了；其它软件填这个地址。」；复制出来的内容与显示值完全一致。
  - 没有配置时：端口行不出现（与 E8-11 一起看）。
  - 界面不出现「监听」「proxy」等词。
- **判定**
  - [ ] 通过
  - [ ] 失败
- **失败时收集**：三种配置的连接 tab 截图、复制的文本、`scutil --proxy` 输出、SQL 输出。

### E8-07 端口顺延说明只出现一次

- **目的**：验证端口被占用时，顺延说明使用 `port_fallback`，且同一时刻只出现一句，不与「已保存，下次连接生效」叠成两句。依据 IA §3.2 C6 / C8 / §6 验收 5–6。
- **前置条件**：代理配置；保存端口为 7890；当前未连接；测试者先占住 7890（例如在另一个终端跑 `python3 -m http.server 7890`）。
- **步骤（人做）**
  1. 占住 7890，连接代理配置，记录端口行与它下面**所有**说明文字。
  2. 在已连接状态下，把保存端口改成 9000 并保存。
  3. 再记录端口行与说明文字，数一数一共几句。
  4. 断开，关掉临时服务。
- **AI 取证**
  ```bash
  lsof -nP -iTCP:7890 -sTCP:LISTEN
  lsof -nP -iTCP -sTCP:LISTEN | grep -E '789[0-9]|9000'
  scutil --proxy
  sqlite3 -readonly "$HOME/.veyl/veyl.db" "select value from settings where key = 'proxy_port';"
  grep -E '本地端口.*被占用|顺延' "$APP_LOG" | tail -4
  ```
  看什么：7890 被别的进程占用；应用改用了另一个端口；`proxy_port` 是保存值（9000）；日志有「本地端口 ... 被占用，顺延下一个候选」。
- **可观察预期**
  - 第一次连接：端口行显示**实际端口**，下面只有一条顺延说明，包含「被别的软件占用」和实际端口；**不出现**单独一句「已保存，下次连接生效」。
  - 已连接时保存 9000：只出现一条合成说明，例如「这次连接用的是 {实际端口}（7890 被占用）；保存的是 9000，下次连接生效。」；不再额外出现第二句保存提示。
  - 保存值仍然是 9000；地址显示仍是实际端口；复制出来的是实际端口。
  - 断开后重连，如果 7890 仍被占用，行为一致；如果释放了，使用保存值或候选链的第一个可用端口。
- **判定**
  - [ ] 通过
  - [ ] 失败
- **失败时收集**：两次端口行截图、`lsof` 输出、`scutil --proxy`、`proxy_port` SQL、日志。

### E8-08 重置网络的入口与确认

- **目的**：验证入口与最终按钮同词、危险区独立、取消为初始焦点、Esc 可退，且确认页不出现内部术语。依据 IA §3.3 P5 / P7 / P8 / §3.5 / §3.8。
- **前置条件**：设置已打开；本条**不执行**重置，只检查确认流程；连接状态不限。
- **步骤（人做）**
  1. 打开「遇到问题」tab，找到「重置网络」。
  2. 记录它是否在独立危险区、是否与其它按钮并排。
  3. 点入口，观察确认弹层：标题、正文、两个按钮、初始焦点。
  4. 按 Esc，确认弹层关闭且没有执行。
  5. 再打开一次，记录按钮文字。
- **AI 取证**
  ```bash
  date '+%F %T'
  scutil --proxy
  scutil --dns | sed -n '1,8p'
  ```
  在确认前后各执行一次；看什么：取消后系统代理与 DNS 没有变化（本条没有执行重置）。
- **可观察预期**
  - 入口叫「重置网络」，不是「强制重置网络」。
  - 入口在独立危险区，不与「清除残留代理」等按钮并排。
  - 确认标题「重置网络？」；正文包含「会立刻断开当前连接」和「不会删除配置和节点」。
  - 两个按钮是「取消」和「重置网络」，与入口同词。
  - 打开时焦点在「取消」；Esc 关闭且不执行。
  - 入口、确认页的首屏文字里不出现「接管」「系统代理」「系统路由」「DNS」（这些只允许出现在结果详情里）。
- **判定**
  - [ ] 通过
  - [ ] 失败
- **失败时收集**：危险区截图、确认弹层截图、Esc 前后系统状态输出。

### E8-09 重置成功的结果呈现

- **目的**：验证成功时只留一行结论，八步默认折叠，展开后能看到逐项结果。依据 IA §3.3 P9 / §6 验收 14。
- **前置条件**：网络当前正常；已记录配置数与节点数；设置 › 遇到问题。
- **步骤（人做）**
  1. 点「重置网络」，在确认弹层点「重置网络」。
  2. 等执行结束，记录结果区第一行与是否有「查看详情」。
  3. 不展开详情，先截图；再展开，记录八步。
  4. 关闭设置，确认能重新连接、浏览器能上网。
- **AI 取证**
  ```bash
  grep -E '强制重置|重置' "$APP_LOG" | tail -12
  scutil --proxy
  scutil --dns | sed -n '1,10p'
  netstat -rn -f inet | grep '^default'
  sqlite3 -readonly "$HOME/.veyl/veyl.db" "select count(*) from configs;"
  sqlite3 -readonly "$HOME/.veyl/veyl.db" "select count(*) from nodes;"
  ```
  看什么：日志有重置相关行；系统代理/DNS/路由恢复；配置数与节点数不变。
- **可观察预期**
  - 成功结果只显示一行「网络已恢复。可以重新连接了。」和「▸ 查看详情」。
  - 八步默认收起；展开后能看到每一步的结果。
  - 不出现红色失败样式，不出现「还有 N 项没完成」。
  - 配置与节点数量不变；关闭设置后能重新连接，浏览器能上网。
- **判定**
  - [ ] 通过
  - [ ] 失败
- **失败时收集**：结果区收起/展开截图、日志、系统状态、配置/节点计数。

### E8-10 重置失败的结果呈现

- **目的**：验证失败时八步默认展开，关键失败有原因与下一步。依据 IA §3.3 P10。
- **前置条件**：能安全构造一次重置失败（建议在可牺牲的测试机或测试账户上做）；**不要为了测试去破坏正在使用的网络**。如果无法安全构造，直接记「无法判定」。
- **步骤（人做）**
  1. 在测试环境制造一个重置步骤会失败的条件（由测试者判断并执行，本文不提供破坏性命令）。
  2. 执行「重置网络」，等结果。
  3. 记录是否默认展开八步、失败步骤的说明与下一步。
- **AI 取证**
  ```bash
  grep -E '强制重置|重置|失败' "$APP_LOG" | tail -15
  ```
  看什么：日志出现具体失败步骤；界面不应声称成功。
- **可观察预期**
  - 失败时八步**默认展开**，不需要用户再点。
  - 失败步骤写明原因与下一步；关键步骤失败时有「再试一次」。
  - 路由失败时保留手动清理的折叠说明。
  - 不把失败显示成「网络已恢复」。
  - 如果无法安全构造失败：本条记「无法判定（未构造）」，不作为失败。
- **判定**
  - [ ] 通过
  - [ ] 失败
  - [ ] 无法判定（未构造）
- **失败时收集**：结果区截图、日志失败行、构造条件说明。

### E8-11 无配置时的连接 tab 空态

- **目的**：验证没有配置时只给一个动作，不出现端口和节点来源。依据 IA §3.2 C16 / §3.9 / §6 验收 1。
- **前置条件**：本机没有任何配置（由测试者删除或使用干净账户）。
- **步骤（人做）**
  1. 打开设置 › 连接。
  2. 记录页面上的全部文字与按钮。
  3. 点「新建一套配置」或「先在左侧新建一套配置」，确认回到新建流程。
- **AI 取证**
  ```bash
  sqlite3 -readonly "$HOME/.veyl/veyl.db" "select count(*) from configs;"
  sqlite3 -readonly "$HOME/.veyl/veyl.db" "select value from settings where key = 'proxy_port';"
  ```
  看什么：配置数为 0；端口保存值即使存在，也不应该让界面显示端口行。
- **可观察预期**
  - 只有「还没有配置」和新建入口（「新建一套配置」或「先在左侧新建一套配置」）。
  - 没有「本地代理端口」行。
  - 没有「更新试用节点」「添加节点」行。
  - 没有连接方式、节点来源或空白占位。
  - 点新建入口能回到新建配置流程，不跳到别处。
- **判定**
  - [ ] 通过
  - [ ] 失败
- **失败时收集**：连接 tab 空态截图、配置计数 SQL。

### E8-12 关于页：开源入口与数据去向

- **目的**：验证关于页有版本、开源入口（有 URL 才摆）和一句数据去向。依据 IA §3.4 U2 / U3 / U4。
- **前置条件**：设置 › 关于；先确认构建里是否配置了开源 URL（由产品/开发告知；没有就按「无 URL」分支测）。
- **步骤（人做）**
  1. 记录版本号、是否有「开源与反馈」行、底部那句话。
  2. 有 URL 时点「打开仓库」，确认打开的是真实仓库页面。
  3. 没有 URL 时确认没有空链接、没有点了没反应的按钮。
- **AI 取证**
  ```bash
  date '+%F %T'
  tail -n 30 "$APP_LOG"
  ```
  看什么：应用无错误。外部链接是否打开、页面内容是否真实，由人确认；AI 不从日志推断。
- **可观察预期**
  - 版本以 `v0.1.0` 这种格式显示，使用等宽字体。
  - 有 URL 时：「开源与反馈」+「打开仓库」，点击后打开真实仓库页面。
  - 无 URL 时：不摆空链接、不摆禁用按钮、不出现「待补充」。
  - 底部有一句「AI 对话会发给你选的服务；配置、节点和日志都留在本机。」
  - 页面顶部没有与 tab 同名的「关于」页内标题。
- **判定**
  - [ ] 通过
  - [ ] 失败
- **失败时收集**：关于页截图、点击后的浏览器截图（有 URL 时）。

### E8-13 tab 的键盘可操作性

- **目的**：验证分区导航具备 tab 语义，方向键、Home / End 可切换，焦点跟随，关闭后回到入口。依据 IA §3.10 / §6 验收 16。
- **前置条件**：设置已打开；建议同时开 VoiceOver 检查读屏语义。
- **步骤（人做）**
  1. 打开设置，确认焦点落在当前 tab。
  2. 按右方向键、左方向键，记录 tab 是否切换、焦点是否跟随。
  3. 按 Home / End，确认到第一个 / 最后一个 tab。
  4. 关闭设置，确认焦点回到打开它的按钮。
  5. 用 VoiceOver 听一遍四个 tab 的角色与选中状态。
- **AI 取证**
  ```bash
  date '+%F %T'
  tail -n 20 "$APP_LOG"
  ```
  看什么：应用无错误。键盘与读屏结论由人给出；AI 不根据日志推断焦点。
- **可观察预期**
  - 读屏把导航读成 tab 列表与 tab 面板，而不是一组普通按钮。
  - 左右方向键切换 tab，焦点跟随；Home / End 到首尾。
  - 当前 tab 有可见选中态（下划线或等效样式）。
  - 关闭设置后焦点回到打开它的按钮（左栏设置按钮 / 右栏设置入口 / 控制台诊断 / 空态新建入口）。
  - 切换 tab 不会关闭设置，也不会触发连接/断开。
- **判定**
  - [ ] 通过
  - [ ] 失败
- **失败时收集**：每个 tab 的截图、VoiceOver 朗读记录（文字）、关闭后的焦点截图。

### E8-14 问 AI 后回到原 tab

- **目的**：验证「问 AI」跳到右侧面板发问，重开设置回到刚才那个 tab。依据 IA §3.6 / §3.10 / §6 验收 15。
- **前置条件**：AI 可用；设置 › 连接，当前有代理配置（端口行可见）。
- **步骤（人做）**
  1. 在端口行旁点「问 AI」。
  2. 观察设置是否关闭、右栏是否打开、是否出现以「我在 Veyl 的高级设置里调整「本地代理端口」…」开头的消息。
  3. 不回答，直接重新打开设置，记录落在哪个 tab。
  4. 再从「AI 服务」tab 的问 AI 入口试一次，确认回来落在「AI 服务」。
- **AI 取证**
  ```bash
  sqlite3 -readonly "$HOME/.veyl/veyl.db" "select role, substr(content,1,220), created_at from chat_messages order by created_at desc limit 4;"
  ```
  看什么：最近一条用户消息是否以「我在 Veyl 的高级设置里调整「本地代理端口」」开头；当前值是否与实际端口一致。
- **可观察预期**
  - 点「问 AI」后设置关闭，右栏打开，输入框获得焦点。
  - 发出的消息使用固定前缀，字段名是「本地代理端口」，当前值与界面显示一致；不出现「连接方式」「更新试用节点」的问 AI 入口。
  - 重新打开设置时回到**刚才那个 tab**（连接 → 连接，AI 服务 → AI 服务），不跳回 AI 服务。
  - 如果从 AI 服务 tab 提问，回来仍在 AI 服务。
- **判定**
  - [ ] 通过
  - [ ] 失败
- **失败时收集**：问 AI 前后的截图、`chat_messages` SQL、重开设置落在哪个 tab 的截图。

### 8.2 P1 设置改动（AI 执行）

> 本节对应 P1 十一条里的设置项。E8-15…E8-20 优先用浏览器预览（M1）执行；涉及真实导入 / 真实端口的步骤用原生应用（M2）补证。

| P1 设置项 | 用例 |
|---|---|
| tab 名称「AI 服务」、删除「用哪个节点」 | E8-15 |
| 添加节点：文本 / https / http 拒绝 | E8-16 |
| 端口复制值 = 运行时实际端口 | E8-17 |
| 重置网络标题中性、成功只有一个标题、步骤折叠 | E8-18 |
| tab 键盘与 `role` / `aria-selected` | E8-19 |
| 问 AI 后回到原 tab | E8-20 |

### E8-15 tab 名称与「用哪个节点」已删除

**前置**：M1；1440×900；已有一套带 2 个节点的配置；设置已打开。

**步骤**：

1. 执行：

```js
(() => {
  const tabs = [...document.querySelectorAll('[role="tab"]')];
  const panel = document.querySelector("#settings-panel-network");
  return {
    tabCount: tabs.length,
    tabs: tabs.map((t) => ({
      text: t.textContent.trim(),
      selected: t.getAttribute("aria-selected"),
      controls: t.getAttribute("aria-controls"),
      tabIndex: t.tabIndex,
    })),
    nodeRow: panel ? /用哪个节点/.test(panel.textContent) : null,
    panelRole: panel?.getAttribute("role") ?? null,
    panelLabelledBy: panel?.getAttribute("aria-labelledby") ?? null,
  };
})()
```

2. 关闭设置，确认主界面底部仍有 `.node-card`：

```js
(() => ({
  nodeCard: Boolean(document.querySelector(".node-card")),
  nodeName: document.querySelector(".node-card__name")?.textContent.trim() ?? null,
  canPick: Boolean(document.querySelector(".node-card__select")),
}))()
```

**预期**：

1. `tabCount` 为 4；依次是「AI 服务」「连接」「遇到问题」「关于」。
2. 第一个 tab 的 `aria-selected` 为 `"true"`，其余为 `"false"`。
3. 每个 tab 的 `controls` 都指向存在的 `role="tabpanel"`，且该面板的 `aria-labelledby` 指回 tab。
4. `#settings-panel-network` 的文本里没有「用哪个节点」；`nodeRow` 为 `false`。
5. 主界面底部仍有 `.node-card`，显示当前节点名；多节点时 `.node-card__select` 存在且可点。
6. 设置里没有残留节点行的空白或孤立说明。

**不合格时记录什么**：

- 上述两个 JSON。
- 设置导航与连接 tab 截图、主界面底部截图。
- 实际 tab 文案 / `aria-selected` / `aria-controls` 与期望的差异。

### E8-16 添加节点的三条输入路径

**前置**：M1（路径与错误样式）+ M2（落库与可连接）；M1 已有一套配置；准备 `ss://a`、`ss://b`、`https://example.com/sub`、`http://example.com/sub`。

**步骤**：

1. M1：设置 › 连接 ›「添加节点」行点「添加」，粘贴两行 `ss://`，点「添加」，执行：

```js
(() => ({
  title: document.querySelector("#import-dialog-title")?.textContent.trim() ?? null,
  result: document.querySelector(".settings-import .settings-feedback")?.textContent.trim() ?? null,
  resultClass: document.querySelector(".settings-import .settings-feedback")?.className ?? null,
  error: document.querySelector(".settings-feedback--error")?.textContent.trim() ?? null,
  addDisabled: [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "添加")?.disabled ?? null,
}))()
```

2. 输入 `http://example.com/sub`，点「添加」，记录错误文本与按钮是否短暂变成「正在获取…」。
3. 输入 `https://example.com/sub`，点「添加」，记录按钮文字变化与结果。
4. M2：用同样的 `ss://` 文本导入；执行：

```bash
sqlite3 -readonly "$HOME/.veyl/veyl.db" "select source, count(*) from nodes group by source;"
sqlite3 -readonly "$HOME/.veyl/veyl.db" "select config_id, count(*) from config_nodes group by config_id;"
grep -E '连接完成|连接失败 卡在' "$APP_LOG" | tail -3
```

5. M2：打开节点面板选中新导入的节点，连接一次。

**预期**：

1. 弹窗标题「添加节点」；文本框提示包含「支持多行 ss:// 链接或 https 订阅地址」。
2. `ss://` 文本走导入文本：结果「已添加 2 个节点」，类名含 `settings-feedback--ok`。
3. `http://` 在本地被拒绝：出现 `settings-feedback--error`，文本包含「订阅地址要用 https」，没有出现「正在获取…」。
4. `https://` 走订阅地址：按钮先变成「正在获取…」，成功后结果「已添加 2 个节点」。
5. M2：`nodes` 表新增节点，`config_nodes` 有对应绑定；新节点可在节点面板选中，连接日志出现 `连接完成`。
6. 空文本时「添加」按钮 `disabled=true`。

**不合格时记录什么**：

- 三次输入的结果文本、类名、按钮状态。
- M2 的 SQL 输出与连接日志。
- 哪条路径走错（文本 / 订阅 / http）、是否出现英文错误。

### E8-17 端口复制值等于实际端口

**前置**：M1；设置 `localStorage` 的 `veyl.mock.proxyPort=7890`、`veyl.mock.portFallback=occupied`；刷新；选中代理配置并连接。

**步骤**：

1. 打开设置 › 连接，执行：

```js
(() => {
  const addr = document.querySelector(".settings-port-address");
  const row = addr?.closest(".settings-row");
  return {
    settingsAddress: addr?.textContent.trim() ?? null,
    consoleAddress: document.querySelector(".proxy__addr")?.textContent.trim() ?? null,
    portNote: row?.querySelector(".settings-note")?.textContent.trim() ?? null,
  };
})()
```

2. 点端口行的复制按钮，执行 `await navigator.clipboard.readText()`（需要浏览器授予剪贴板读权限）；若被拒绝，记录「剪贴板读取阻塞」。
3. M2 可选：原生应用连接后，测试者点一次复制，AI 执行 `pbpaste` 与 `scutil --proxy` 对比。

**预期**：

1. 设置端口文本是 `127.0.0.1:7891`（7890 被占用后顺延），与 `.proxy__addr` 完全一致。
2. 剪贴板内容与设置文本完全一致；不是保存值 7890。
3. 顺延说明只有一条，包含「被别的软件占用」；不再额外出现「已保存，下次连接生效」。
4. M2 下 `pbpaste` 的端口与 `scutil --proxy` 的 `HTTPPort` / `SOCKSPort` 一致。

**不合格时记录什么**：

- 上述 JSON、剪贴板文本（如有）。
- 设置行与代理卡截图。
- `scutil --proxy` 原文。
- 保存值、显示值、复制值三者对照。

### E8-18 重置网络的标题与成功结果

**前置**：成功分支用 M1（mock 返回成功）；失败分支用 M2 原生应用，按下面任一方法构造。构造不出时记「阻塞」并写明尝试过的方法。

**步骤**：

1. 点「重置网络」，读取确认弹层：

```js
(() => ({
  entryText: document.querySelector(".danger-zone__title")?.textContent.trim() ?? null,
  dialogTitle: document.querySelector("#reset-dialog-title")?.textContent.trim() ?? null,
  buttons: [...document.querySelectorAll(".reset-confirm button")].map((b) => b.textContent.trim()),
  body: document.querySelector(".reset-confirm")?.textContent.trim() ?? null,
}))()
```

2. 点确认里的「重置网络」，等结果出现，执行：

```js
(() => ({
  titles: [...document.querySelectorAll(".reset-result__title")].map((e) => e.textContent.trim()),
  sub: document.querySelector(".reset-result__sub")?.textContent.trim() ?? null,
  detailsOpen: document.querySelector(".reset-result details.reset-route-help")?.hasAttribute("open") ?? null,
  steps: document.querySelectorAll(".reset-result .reset-step").length,
  summary: document.querySelector(".reset-result details.reset-route-help summary")?.textContent.trim() ?? null,
}))()
```

3. 点「查看详情」，再执行一次，记录步骤是否展开到 8 条。
4. **失败分支构造（M2，由测试者执行）**，二选一：
   - **方法 A（复查失败）**：先断开 Wi-Fi，再执行「重置网络」。`verify` 的 DNS/HTTPS 探测会失败，结果应为 `unverified`，标题「网络已重置，但复查没有通过」。
   - **方法 B（关键步骤失败）**：先连接 TUN，再到「系统设置 › 登录项与扩展」停用/移除 Veyl 的后台助手，然后执行「重置网络」。`stop_tun` 会失败，结果应为 `failed`，标题「重置没有完成」。
   - 如果两种方法都没有产生非成功结果，记「阻塞（未构造）」并写明尝试过的方法，不要静默跳过。

**预期**：

1. 入口是「重置网络」，不是「强制重置网络」。
2. 确认标题「重置网络？」；按钮「取消」「重置网络」；正文包含「会立刻断开当前连接」「不会删除配置和节点」。
3. 成功结果只有 **一个** `.reset-result__title`，文本「网络已恢复。可以重新连接了。」。
4. `sub` 为空或不存在，不重复第二句结论。
5. 步骤默认折叠：`detailsOpen=false`；点「查看详情」后 `steps=8`。
6. 入口、确认页不出现「强制重置」；结果详情里允许出现「关闭接管 / 系统代理 / 系统路由 / DNS」。
7. **失败分支**：八步默认展开（不再需要点「查看详情」）；标题是「网络已重置，但复查没有通过」或「重置没有完成」，不能是「网络已恢复」；失败步骤有原因与下一步；有「再试一次」。
8. 失败分支构造不出来时记「阻塞（未构造）」，不判通过。

**不合格时记录什么**：

- 两个 JSON、确认弹层与结果截图。
- 标题数量、`detailsOpen`、步骤数。
- 出现「强制重置」或重复标题的位置。

### E8-19 tab 的键盘与 ARIA

**前置**：M1；设置已打开；焦点在第一个 tab。

**步骤**：

1. 优先用浏览器自动化的真实按键：按 `ArrowRight`、`ArrowLeft`、`Home`、`End`。
2. 如果只能执行 JS，用下面的合成事件，并在备注里注明「合成事件」：

```js
(() => {
  const tabs = [...document.querySelectorAll('[role="tab"]')];
  const state = () => tabs.map((t) => ({
    text: t.textContent.trim(),
    selected: t.getAttribute("aria-selected"),
    tabIndex: t.tabIndex,
    focused: document.activeElement === t,
  }));
  tabs[0].focus();
  tabs[0].dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
  const afterRight = state();
  tabs[1].dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true }));
  const afterHome = state();
  tabs[0].dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }));
  const afterEnd = state();
  return {
    roles: tabs.map((t) => t.getAttribute("role")),
    tablist: document.querySelector(".settings-nav")?.getAttribute("role") ?? null,
    panels: [...document.querySelectorAll('[role="tabpanel"]')].map((p) => ({
      id: p.id,
      labelledBy: p.getAttribute("aria-labelledby"),
    })),
    afterRight,
    afterHome,
    afterEnd,
  };
})()
```

**预期**：

1. `.settings-nav` 的 `role` 为 `tablist`；四个子项 `role` 都是 `tab`。
2. 四个 `tabpanel` 存在，id 与对应 tab 的 `aria-controls` 一致，`aria-labelledby` 指回 tab。
3. `ArrowRight` 后第二个 tab `selected=true`、`tabIndex=0`、`focused=true`，其余 `selected=false`、`tabIndex=-1`。
4. `Home` 回到第一个；`End` 到最后一个；焦点跟随选中项。
5. 任一时刻只有一个 `aria-selected="true"`。
6. 切换 tab 不关闭设置，不触发连接/断开。

**不合格时记录什么**：

- 上述 JSON。
- 每次按键后的截图（可选）。
- 哪个 tab 的 `aria-selected` / `tabIndex` / 焦点不对。

### E8-20 「问 AI」后回到原 tab

**前置**：M1；AI 可用；设置 › 连接，当前有代理配置（端口行可见）；右栏收起或展开均可。

**步骤**：

1. 在「本地代理端口」行旁点 `.ask-ai`「问 AI」，执行：

```js
(() => ({
  settingsOpen: Boolean(document.querySelector(".modal--settings")),
  panel: Boolean(document.querySelector("#ai-panel")),
  lastUser: [...document.querySelectorAll(".msg--user .msg__text")].at(-1)?.textContent.trim().slice(0, 180) ?? null,
  askAiLabels: [...document.querySelectorAll(".ask-ai")].map((b) => b.textContent.trim()),
}))()
```

2. 重新打开设置，读取选中 tab：

```js
(() => ({
  selected: document.querySelector('[role="tab"][aria-selected="true"]')?.textContent.trim() ?? null,
}))()
```

3. 切到「AI 服务」tab，在「API 类型」或「模型」旁点一次「问 AI」，重开设置，再读选中 tab。

**预期**：

1. 点「问 AI」后设置关闭，右栏出现（或保持展开），输入框获得焦点。
2. 最近一条用户消息以「我在 Veyl 的高级设置里调整「本地代理端口」。当前值是 127.0.0.1:{端口}」开头；当前值与界面显示一致。
3. 重开设置后 `selected` 为「连接」，不跳回「AI 服务」。
4. 从「AI 服务」tab 提问，重开后 `selected` 为「AI 服务」。
5. 不出现「连接方式」「更新试用节点」的「问 AI」入口；在 AI 服务 tab 打开添加/编辑表单时，`.ask-ai` 只出现在 API 类型与模型两处，连接 tab 只出现在本地代理端口一处。

**不合格时记录什么**：

- 两次 JSON、问 AI 前后的截图。
- 最近用户消息原文（截前 180 字）。
- 重开设置落点与期望 tab 的差异。

---

## 9. 协作协议

> 第 6 章与 §8.2 按开头「如何用 AI 执行本手册」执行：AI 可以操作浏览器预览、读 DOM、执行 JS；第 1–5 章、第 7 章和 §8.1 的系统/基线用例仍按本节的人机分工（系统动作由人做，AI 读日志 / DB / 截图）。

### 9.1 一条用例怎么交给 AI

测试者把用例编号和当前进度说清楚，例如：

> 执行 E4-03。E4-02 已通过，当前 TUN 已连接，网络服务是 Wi-Fi。请按用例里的「AI 取证」取证，并按「可观察预期」逐条判定。

更短的版本：

> E4-03，已连接，Wi-Fi。取证并判定。

AI 收到后只做三件事：

1. 执行该用例里写出的「AI 取证」命令或步骤中的 JS，原样保存返回值。
2. 对照「预期 / 可观察预期」逐条写「满足 / 不满足 / 无法判定」，并引用输出来源。
3. 给结论：通过 / 不通过 / 阻塞。失败时按 §0.5 生成 `evidence.txt` 和一行摘要。

### 9.2 AI 可以执行什么

- **M1 浏览器预览**：可以点击、输入、执行用例里的 JS，读取 DOM / `getComputedStyle` / 截图；可以清空 `veyl.*` localStorage 做清场。
- **M2 原生应用**：只读日志、SQLite、系统状态和截图；系统弹窗、断网、强杀、授权由测试者操作。
- 只执行本文写出的命令；不自己发明删除、改权限、改网络的命令。
- 需要读数据库时，只用 `sqlite3 -readonly`，且只跑 `SELECT`。
- 需要读日志时，用 `tail` / `grep`，不要 `cat` 整个大文件。

### 9.3 什么情况必须停下来问人

出现任意一条，AI 停止并把原始输出交给测试者：

1. 命令需要 `sudo`、管理员密码或系统授权。
2. 命令会修改网络、代理、DNS、路由、防火墙或系统设置。
3. 需要启动/停止应用、编译、安装、删除文件、杀进程。
4. 需要修改 `src/` 或 `src-tauri/` 代码。
5. 命令输出为空，或与用例写的字段完全对不上（例如日志里没有当天的文件）。
6. 前置条件不满足（例如要求 TUN 已连接，但当前是代理模式）。
7. 同一条用例出现两个以上异常，或异常影响继续测试。
8. 日志里出现密码、订阅链接、私钥等敏感内容——停止转发，先让测试者脱敏。

### 9.4 失败怎么归档

1. 测试者建目录：`~/Desktop/veyl-e2e/<日期>/<用例编号>/`。
2. AI 写 `evidence.txt`：每条命令 + 原始输出 + 执行时间。
3. 测试者补界面截图。
4. 写 `notes.md`：一行现象、应用版本、macOS 版本、发生时间。
5. 汇总到当天的 `summary.md`，每条一行：

```
E4-03 | 2026-11-11 15:20 | v0.1.0 | scutil 里没有 223.5.5.5，仍是 192.168.1.1 | ./E4-03/
```

**不要提交到仓库，不要把证据贴到公开渠道。**

---

## 10. 仍需人判断的部分

第 6 章与 §8.2 已经把可量化的视觉项改成 DOM 断言：字号、颜色 token、宽度、DOM 层级、`aria-*`、文案是否存在，都能二值判定。下面这些仍然只能由人判断：

| 类别 | 具体项 | 为什么 AI 不能判 |
|---|---|---|
| 审美 | 是否「舒服」「协调」「好看」 | 主观，无法二值判定；本手册不写这类验收项 |
| 体感速度 | 连接快慢、页面加载快慢、动画是否卡顿 | 依赖机器、网络和人的感受 |
| 文案语气 | 措辞是否自然、是否让人误解 | 需要产品/语言判断 |
| 授权弹窗 | 用户是否理解为什么要授权 | 需要真实用户视角 |
| 真实网络 | 浏览器是否真的能打开网站、视频是否流畅 | AI 只能看日志、退出 IP 和截图 |
| 托盘图标 | 形状是否容易辨认 | 需要看菜单栏 |
| 读屏体验 | VoiceOver 朗读是否顺畅 | 需要人听 |

AI 可以把这些整理成观察记录（截图、录屏、日志），但**结论由人签字**；本手册的其他条目都应能从 DOM / 截图 / 日志 / 系统输出中二值判定。

---

## 11. 附：快速命令库

以下命令全部只读，可单独复制。

```bash
# 今天应用日志（开发构建在仓库根；发布构建换 LOG_DIR）
tail -n 200 "$LOG_DIR/app-$(date +%F).log"
```

```bash
# 后台组件日志
tail -n 200 "$HOME/.veyl/helper-logs/helper.log"
```

```bash
# TUN 的 sing-box 日志（开发构建）
tail -n 4000 "$HOME/.veyl/helper-logs/sing-box.log" | grep -E 'hijack-dns|inbound|outbound|router: match' | tail -30
```

```bash
# 代理模式的运行时日志
tail -n 200 "$(ls -t "$HOME"/.veyl/logs/runtime-*.log 2>/dev/null | head -1)"
```

```bash
# 系统 DNS / 代理 / 路由
scutil --dns | sed -n '1,20p'; echo ---; scutil --proxy; echo ---; netstat -rn -f inet | grep '^default'
```

```bash
# 进程与监听端口
ps -Ao pid,comm,args | grep -E 'Veyl|veyl|sing-box' | grep -v grep; echo ---; lsof -nP -iTCP -sTCP:LISTEN | grep -E '127\.0\.0\.1|789[0-9]'
```

```bash
# 本地数据库（只读）
sqlite3 -readonly "$HOME/.veyl/veyl.db" "select name, connection_mode, routing_mode, is_active from configs;"
```

```bash
# 最近对话与工具调用
sqlite3 -readonly "$HOME/.veyl/veyl.db" "select role, substr(content,1,160), created_at from chat_messages order by created_at desc limit 10;"
sqlite3 -readonly "$HOME/.veyl/veyl.db" "select tool_name, is_error, created_at from tool_calls order by created_at desc limit 10;"
```
