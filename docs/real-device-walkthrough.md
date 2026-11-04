# 真机走查手册（macOS · 系统代理模式）

> 日期：2026-11-04
> 目的：第一次在真机上跑通「首启 → 配 Key → AI 对话 → 生成配置 → 连接 → 断开」。
> 之前所有验证用的都是假二进制、假 Clash API、内存代理；**真的 sing-box 从 App 里拉起来、真的把流量导出去，一次都没跑过**。
> 本文只写怎么验、看到什么算过。不改代码。

---

## 0. 这一版验什么、不验什么

| 验 | 不验 |
|---|---|
| 首启页、DeepSeek Key 保存与验证 | TUN / 特权助手（另开工作项） |
| AI 对话、工具调用卡片 | Windows |
| 新建配置（种子节点） | 分流在线切换的完整语义（只验默认「全部走代理」） |
| 真实 sing-box 安装、启动、健康检查 | 问题管理、升级、卸载 |
| 系统代理的设置与撤销 | 多用户、多网络服务切换 |
| 断开与退出清理 | 性能与长时间稳定性 |

---

## 1. 前置检查（10 分钟，必须做完）

### 1.1 关掉机器上现有的 VPN

产品负责人机器上开着一个 VPN（`utun6`，占 `128.0/1` 与 `198.18.0.2` 做 DNS）。只要它还在，下面所有连接结果都不可信：`128.0/1` 会截走一半公网流量，出口 IP、延迟、连通性全部失真。

先确认它确实在：

```bash
ifconfig utun6
netstat -rn -f inet | grep -E '^(0/1|128\.0/1)'
scutil --dns | grep -m5 nameserver
```

三条里任意一条有输出且指向那个 VPN，就先把它按自己的方式断开/退出（菜单栏图标或它自己的界面）。**不要用 `kill -9`**，那会留下路由。

关掉之后再跑一遍，**全部为空才算过**：

```bash
ifconfig utun6 2>&1 | head -3
netstat -rn -f inet | grep -E '^(0/1|128\.0/1)' || echo "无 128.0/1 路由"
scutil --proxy
pgrep -fl 'sing-box|clash|mihomo' || echo "没有代理进程"
```

`scutil --proxy` 期望看到 `HTTPEnable : 0`（或整段为空），`pgrep` 期望没有输出。

### 1.2 确认 Veyl 自己没有残留

```bash
pgrep -fl sing-box || echo "没有 sing-box 在跑"
ls -la "$HOME/Library/Application Support/Veyl/config" 2>/dev/null || echo "没有明文配置目录"
scutil --proxy
```

`config` 目录里若有 `profile-*.json`，说明上次没清理干净，先记下来（这是缺陷），手动删掉再继续。

### 1.3 本机基线（2026-11-04 核查，开工前再跑一遍确认没变）

| 项 | 当前值 | 判断 |
|---|---|---|
| `configs` / `nodes` | 0 / 0 | 干净，首启应出现 |
| `llm_active_provider` | `deepseek`（内置） | 正常，内置不等于配过 |
| `secrets.enc` 里的 AI Key | **没有**（只有 `seed:<hash>` 缓存） | 首启会触发 |
| 种子缓存 | 2 个节点，version 1 | 建配置不需要立刻联网 |
| `runtime_versions` | 0 行 | **sing-box 未安装**，连接前必须先装 |
| 规则数据 | 已就绪（2233 个规则集） | 正常 |
| UI 跳过标记 | 没有 | 不会绕过首启 |

复核命令：

```bash
sqlite3 "file:$HOME/Library/Application Support/Veyl/veyl.db?mode=ro" \
  "select 'configs',count(*) from configs union all select 'nodes',count(*) from nodes union all select 'runtime',count(*) from runtime_versions;"

python3 -I -c "import json,os;d=json.load(open(os.path.expanduser('~/Library/Application Support/Veyl/secrets.enc')));print(sorted(k for k in d if k.startswith('provider:')) or '没有 AI Key')"

find "$HOME/Library/WebKit/veyl" -name localstorage.sqlite3 \
  -exec sqlite3 "file:{}?mode=ro" "select key from ItemTable;" \;
```

最后一条会列出几个 UI 标记；**出现 `veyl.onboarding.skipped` 就说明之前点过「不用 AI」**，首启页不会出现，先清掉（见 §3.3）。

### 1.4 准备好

- 一个可用的 DeepSeek Key（`sk-` 开头），或一个 OpenAI/Anthropic 兼容端点
- 网络能访问 `github.com`（装 sing-box，约 30MB）和 `meshnetprotocol.github.io`（种子）
- 关闭系统「低电量模式」之类会挂起网络的行为

---

## 2. 启动与看日志

```bash
cd /Users/wesley/ai/veyl
npm run app:dev
```

第一次会编译 Rust，几分钟；之后快。Vite 固定 1430 端口，被占用会直接失败——先 `lsof -nP -iTCP:1430 -sTCP:LISTEN` 确认没别的进程。

开两个终端，一个跑应用，一个跟日志：

```bash
tail -f "$HOME/Library/Application Support/Veyl/logs/app-$(date +%F).log"
```

需要更详细的后端日志时：

```bash
RUST_LOG=debug npm run app:dev
```

**过：** 日志出现「种子已更新」或「默认节点刷新」，窗口标题是 `Veyl`。
**不过：** 窗口没起来先看终端里的 Rust 编译/启动错误；窗口起来但日志是空的，检查 `~/Library/Application Support/Veyl/logs/` 下有没有当天的 `app-YYYY-MM-DD.log`。

> sing-box 的日志是另一个文件：`~/Library/Application Support/Veyl/logs/runtime-<版本>.log`，要等内核装好、第一次启动后才出现。

---

## 3. 步骤 1 · 首启页

### 3.1 做什么

应用启动，什么都不点，先停在首屏。

### 3.2 应该看到什么（逐项对）

整页只有一张居中的卡片，从上到下：

1. 品牌名 `Veyl`
2. 标题：**「配置 AI 后，我来帮你连上网络。」**
3. 说明：**「Key 只保存在本机。配好之后，我来找节点、建立连接。」**
4. 输入框，标签 **「DeepSeek API Key」**，占位符 `sk-...`，输入内容是圆点
5. 主按钮 **「保存并验证」**，输入框为空时是灰的
6. 两个链接：**「获取 DeepSeek API Key ↗」**、**「使用其他 AI 服务 →」**
7. 一条分隔线
8. 底部按钮：**「我懂网络，不用 AI」**

> **注意：这一版没有「使用 Google 登录」。** 第二入口是「使用其他 AI 服务」（OpenAI / Anthropic 兼容端点）。如果你按旧设计找 Google 登录，找不到是正常的，但**要把「设计与实现不一致」记下来**。

### 3.3 看不到怎么办

直接进了主界面（四列布局），说明下列之一成立：

| 原因 | 怎么确认 | 怎么恢复 |
|---|---|---|
| 本机已有可用 AI Key | §1.3 的 python 命令打印出 `provider:...` | 设置 → 账号与 AI → 清除 Key，重启应用 |
| 点过「我懂网络，不用 AI」 | §1.3 的 localStorage 查询里有 `veyl.onboarding.skipped` | 见下 |
| 服务商里存了别的 Key | 设置 → 账号与 AI 里能看到已配置 | 同上，清除 |

清除 UI 跳过标记（应用关闭后执行）：

```bash
rm -rf "$HOME/Library/WebKit/veyl/WebsiteData"
```

这只清 webview 的本地状态（面板开关、跳过标记、连接过的标记），**不动数据库和 Key**。不想删整个目录的话，开发版可右键 → 检查元素 → Console 里执行：

```js
localStorage.removeItem("veyl.onboarding.skipped")
```

然后重载窗口。

---

## 4. 步骤 2 · 配置 AI Key

### 4.1 做什么

1. 粘贴 DeepSeek Key（`sk-` 开头）
2. 点「保存并验证」

### 4.2 应该看到什么

- 按钮文字变成 **「验证中…」**，表单不可再提交
- 校验通过：首启页消失，进入主界面，**右侧 AI 面板自动展开**
- 若网络不通但格式正确：仍会进入主界面（Key 标记为未验证），此时对话可能失败

验证「Key 只在本机、且是密文」：

```bash
python3 -I -c "import json,os;d=json.load(open(os.path.expanduser('~/Library/Application Support/Veyl/secrets.enc')));print(sorted(k for k in d if k.startswith('provider:')))"
```

期望打印 `['provider:deepseek']`。

```bash
grep -a -c "sk-" "$HOME/Library/Application Support/Veyl/secrets.enc" || true
```

期望 `0`——密文里不应该出现 `sk-` 明文。

### 4.3 可能出现的错误（原文）

| 界面文字 | 含义 | 下一步 |
|---|---|---|
| 「Key 格式不对：应以 sk- 开头，长度至少 20 位。」 | 复制不全 | 重新复制 |
| 「Key 已保存在本机，但 DeepSeek 鉴权失败（可能无效或已被吊销）。请重新输入一个有效的 Key。」 | 401/403 | 换 Key |
| 「网络不通，没能验证 Key。稍后再试一次。」 | 5 秒内连不上 `api.deepseek.com` | 检查 §1 的 VPN 是否关干净、系统代理是否还指着旧端口 |
| 「本地加密凭据文件写入失败（secrets.enc），请检查磁盘权限或空间后重试。」 | 文件系统问题 | 看 `ls -l` 权限是否 600、磁盘是否满 |

> 无效 Key 会被后端直接判为失败，**不会**让人蒙混进主界面；网络不通则允许进入但标记未验证。

---

## 5. 步骤 3 · 主界面（AI 已配置、还没有配置方案）

### 5.1 应该看到什么

四列，从左到右：

1. **最左窄条**：品牌图标 + 一个「客户端」图标，没有别的图标
2. **左栏**：标题「配置」，右上角 `＋`；空态三行：
   - 「还没有配置」
   - 「自己新建一套，或在对话里让助手帮你配好第一套。」
   - 按钮「新建配置」
3. **中间控制台**：
   - 顶部：主按钮 **「启动 VPN」且是灰的**（没有配置不能点）；右边状态点 + **「还没有配置」**
   - 中部：**「没有需要你决定的事」** + 「AI 有需要你确认的步骤时，会出现在这里。」
   - 底部：「在左侧新建一套配置后，这里会显示节点。」
4. **右侧 AI 面板**：标题「新对话」，空态 **「先连上，再聊。」**，下面一行「连接在中间；需要我帮你配好，就在下面说。」，建议芯片「为什么我打不开某个网站？」「检查我的网络配置」，底部输入框占位「告诉我要去哪儿，或者让我诊断网络问题」

另外确认设置页数据：

- 点右栏右上角的设置图标 → 「网络」
- **「默认配置源」** 应显示 `v1 · 2 个节点 · 更新于 …`
- **「本地端口」** 显示 `—`（未连接）
- 「代理模式」显示「系统代理」

### 5.2 看不到怎么办

- 左栏不是空态 → 上一轮测试留下了配置，`configs` 不是 0，记录后先决定是否清库
- 左栏显示「配置读取失败」+ 一串错误 → 本地库打不开或迁移失败；看日志里的「本地数据库打开失败」，把错误原文记下来
- 右栏没自动展开 → 点中间顶部最右侧的对话图标；如果展开后显示「还没有配置 AI」，回 §4
- 中间主按钮可点 → 说明配置列表非空，同上

---

## 6. 步骤 4 · 用 AI 生成配置

### 6.1 做什么

在右栏输入一句明确的指令，例如：

```
用你们的测试节点，帮我建一套「只给代理地址」的配置并连上，尽量别问我太多。
```

### 6.2 应该看到什么

**这是本手册最不确定的一步**——之前只在 mock 上跑过。判据按下面几项，允许顺序不同：

1. 消息流式出现，能看到助手在「思考 / 调用工具」
2. 出现工具调用卡片，常见顺序：
   - `DefaultProfileStatus` 或 `CoreListVersions`
   - **`CoreInstall`**（下载 sing-box 1.14.4，约 30MB）
   - `ConfigCreate`
   - `VpnConnect`
3. 左栏出现一套配置，行内显示 **`2 个节点 · 自动`**（没指定端口时端口列显示「自动」）
4. 中间底部出现节点详情：节点名、地址、端口、加密方式
5. 中间顶部状态从「未连接」变为「正在连接…」再变为「已连接」，线路图开始流动

内核装好后的确认：

```bash
sqlite3 "file:$HOME/Library/Application Support/Veyl/veyl.db?mode=ro" \
  "select version,state from runtime_versions;"
ls -la "$HOME/Library/Application Support/Veyl/runtime"
```

期望有一条 `1.14.4|active`，且 `runtime/1.14.4/` 下有 `sing-box` 可执行文件。

### 6.3 看不到怎么办（按最可能的原因排）

| 现象 | 最可能的原因 | 怎么办 |
|---|---|---|
| AI 调 `CatalogSearch` 后报 `CATALOG_UNAVAILABLE` | **默认节点目录指向本地 mock**（`http://127.0.0.1:18090/v1`），真机上没有这个服务 | 这是已知问题，记录下来；改口说「不要用目录，直接用测试节点（seed）建配置」 |
| AI 直接调 `VpnConnect`，报「还没有安装 sing-box，先调用 CoreInstall」 | 没有任何 UI 能装内核，只有 AI 工具能装 | 明确说「先 CoreInstall 1.14.4，再建配置、再连接」 |
| `CoreInstall` 失败 | GitHub 下载被墙/被现有 VPN 干扰 | 先确认 §1 干净；看 `runtime-*.log` 和终端输出；换网络再试 |
| 配置建好了但中间没有节点 | `source` 不是 `seed`，建了空配置 | 让 AI 用 `ConfigCreate` 带 `source: "seed"` 重来 |
| AI 一直问问题、不落配置 | 系统提示词没有写死首次流程，模型自由发挥 | 直接给结论式指令；把「提示词缺少首次流程」记为问题 |
| 助手一直转圈不回 | DeepSeek Key 无效或网络不通 | 看右栏错误提示；回 §4 重配 Key |

> **已知：当前系统提示词只有 6 条规则，没有写死「两问 / 四问」的首次流程。** 所以「AI 主动提问」这一环在真机上大概率与 `docs/user-flows.md` 不一致，按实际看到的现象记录即可，不要为了对上文档反复重试。

### 6.4 不经过 AI 的备用路径（用于把「连接」单独验掉）

左栏 `＋` → 选「只给代理地址」→ 填名字 → 「创建」。

- 应该看到：左栏出现一行，中间底部出现两个种子节点
- 但**点「启动 VPN」会失败**，因为 sing-box 还没装；先让 AI 跑一次 `CoreInstall`，或先走 §6.2

---

## 7. 步骤 5 · 连接

### 7.1 做什么

如果 AI 已经连上，直接看状态；否则点中间顶部 **「启动 VPN」**。

### 7.2 应该看到什么

界面：

- 按钮变为 **「正在启动…」**（灰），随后 **「断开 VPN」**
- 状态点变绿，文字 **「已连接」**
- 线路图：从「本机」「出口」之间的断点变成一条流动的线（无障碍读屏标签是「线路：线路已连接」）
- 左栏该配置行右侧出现 **「已连接」** 小圆点
- 中间底部节点详情出现「当前使用」徽标

系统代理（关键）：

```bash
scutil --proxy
```

期望至少包含：

```
HTTPEnable : 1
HTTPProxy : 127.0.0.1
HTTPPort : <端口>
HTTPSEnable : 1
HTTPSProxy : 127.0.0.1
HTTPSPort : <端口>
```

逐服务确认（服务名先用 `networksetup -listallnetworkservices` 查，通常是 `Wi-Fi`）：

```bash
networksetup -getwebproxy "Wi-Fi"
networksetup -getsecurewebproxy "Wi-Fi"
```

期望 `Enabled: Yes`，`Server: 127.0.0.1`，`Port` 与上面一致。

真实流量（关键）：

```bash
# 连接前先记一次直连出口
curl -s --noproxy '*' --max-time 10 https://api.ipify.org; echo

# 连接后走代理测
curl -s --max-time 10 --proxy "http://127.0.0.1:<端口>" https://api.ipify.org; echo
```

**过：** 两次输出不同，且第二次等于节点所在地的 IP；`curl` 不超时。

设置页对照：设置 → 网络 → **「本地端口」** 应显示 `127.0.0.1:<端口>`，不再是 `—`。

### 7.3 看不到怎么办

| 现象 | 最可能的原因 | 怎么办 |
|---|---|---|
| 提示「还没有安装 sing-box，先调用 CoreInstall」 | 内核未装 | 回 §6 |
| 点了没反应、状态停在「正在启动…」超过 15 秒 | 内核启动失败 | 看 `runtime-1.14.4.log`，常见是配置校验失败、端口被占 |
| 状态变回「未连接」，线路显示「线路连接失败」 | 节点连不上 / 认证失败 | 底部出现红色提示条，读上面的原文；换另一个节点再试 |
| 已连接但 `scutil --proxy` 仍为 0 | 系统代理设置失败 | 日志搜「设置系统代理失败」；检查是否有管理员权限、是否有安全软件拦截 |
| 已连接、代理也设了，但 `curl --proxy` 超时 | 隧道本身不通 | 用「测试连通」；看 runtime 日志里的节点连接错误 |
| 出口 IP 与直连相同 | 流量没进隧道 | 记录为失败，收集日志与 `scutil --proxy` |

### 7.4 关于端口

本版新建配置时**不指定本机端口**，由后端从空闲端口里挑一个（配置行显示「自动」）。所以：

- 要验「端口被占用时顺延」，目前**没有 UI 入口**去固定端口，验不了，记为未覆盖
- 只要 `scutil --proxy`、设置页、`curl --proxy` 三处端口一致，就算这一环通过

---

## 8. 步骤 6 · 断开

### 8.1 做什么

点中间顶部 **「断开 VPN」**（或在右栏让 AI 断开）。

### 8.2 应该看到什么

- 按钮 **「正在断开…」** → **「启动 VPN」**（可点）
- 状态回到 **「未连接」**，线路图回到断点
- 左栏「已连接」小圆点消失

系统侧（三项都要过）：

```bash
scutil --proxy
networksetup -getwebproxy "Wi-Fi"
pgrep -fl sing-box || echo "没有 sing-box 进程"
ls -la "$HOME/Library/Application Support/Veyl/config" 2>/dev/null || echo "没有明文配置目录"
```

期望：`HTTPEnable : 0`；`Enabled: No`；没有进程；明文配置目录为空或不存在。

日志里应有：

```
系统代理已撤销
运行时已停止
```

### 8.3 看不到怎么办

| 现象 | 最可能的原因 | 怎么办 |
|---|---|---|
| 代理还在 | 撤销失败 | 设置 → 网络 → 「恢复网络」；仍不行看日志里的 `networksetup` 报错 |
| sing-box 还在跑 | 停止超时 | `pgrep -fl sing-box` 拿 PID，看 `runtime-*.log`；**先记录，不要直接 kill** |
| `config/profile-*.json` 还在 | 清理漏了（缺陷） | 复制该文件路径记录，**不要把它贴到公开地方**（里面有节点密码），验完删掉 |

---

## 9. 步骤 7 · 退出

在连接着的状态下按 `Cmd+Q`（或菜单栏 Veyl → 退出）。

**首先会弹一个系统对话框**：

- 标题「退出 Veyl」
- 正文「退出 Veyl 会断开当前连接并恢复网络。想让连接保持，请选择「后台运行」。」
- 两个按钮：「后台运行」/「退出」

选 **「退出」** 才会走清理。选「后台运行」窗口会隐藏，连接保持（这是设计行为，不是卡住）。

清理过程中日志应出现：

```
菜单退出被拦截
开始退出流程 confirm=true
进入退出流程：撤代理 → 停运行时 → 清明文配置
系统代理已撤销
运行时已停止
退出清理完成
```

退出后再跑一遍 §8.2 的系统侧三项，全部为干净状态。

---

## 10. 已知没验过的点（本轮的真正目的）

| # | 点 | 为什么没验过 | 本轮怎么算看到 |
|---|---|---|---|
| 1 | 真实 AI 服务商响应 | 一直用 mock LLM | 消息能流式回来、工具能真的执行 |
| 2 | 真实节点连接 | 之前用 `/usr/bin/false` 假二进制 | `curl --proxy` 拿到境外出口 IP |
| 3 | sing-box 真下载 + 校验 | 只在单测里验证 sha | `runtime_versions` 有 `1.14.4` 且 state 为 `active`，进程能起来 |
| 4 | 系统代理真的被设上 / 撤销 | 之前用内存代理 | `scutil --proxy` 前后对比 |
| 5 | 端口被占用时顺延 | 没有 UI 固定端口 | 本轮无法覆盖，记为缺口 |
| 6 | AI 是否会自己装内核 | 提示词没写 | 看工具卡片里有没有 `CoreInstall` |
| 7 | CatalogSearch 真机行为 | 默认指向本地 mock | 预期失败，确认失败文案是否人话 |
| 8 | TUN 整条路 | 未开工 | 不验 |

---

## 11. 出问题时收集什么

应用先别退，按下表收集，然后连同「第几步、看到什么」一起发回来。

| 内容 | 命令 / 位置 |
|---|---|
| 应用日志 | `cp "$HOME/Library/Application Support/Veyl/logs/app-$(date +%F).log" ~/Desktop/veyl-app.log` |
| 运行时日志 | `cp "$HOME/Library/Application Support/Veyl/logs/runtime-1.14.4.log" ~/Desktop/` |
| 系统代理现状 | `scutil --proxy > ~/Desktop/veyl-proxy.txt` |
| 网络服务与代理 | `networksetup -listallnetworkservices >> ~/Desktop/veyl-proxy.txt`；每个服务再跑 `-getwebproxy` 追加进去 |
| 路由与接口 | `netstat -rn -f inet > ~/Desktop/veyl-routes.txt`；`ifconfig > ~/Desktop/veyl-ifconfig.txt` |
| 数据库快照 | 退出应用后 `cp "$HOME/Library/Application Support/Veyl/veyl.db" ~/Desktop/` |
| 界面截图 | 首启页、错误提示条、AI 工具卡片、已连接状态、设置 → 网络 |
| 明文配置残留 | `ls -la "$HOME/Library/Application Support/Veyl/config"`（**只记录路径，不要外发文件内容**） |

**不要外发**：`secrets.enc`、`config/profile-*.json`（含节点密码）、任何含 `sk-` 的截图。

---

## 12. 失败原因速查

| 症状 | 先看 | 常见原因 |
|---|---|---|
| 首启页没出现 | §1.3 三项 | 已有 Key 或点过「不用 AI」 |
| Key 保存失败 | §4.3 文案 | 格式 / 401 / 网络 / 文件权限 |
| AI 不回话 | 右栏错误、app 日志 | Key 无效、`api.deepseek.com` 不通、模型名不对 |
| AI 调 `CatalogSearch` 失败 | 工具卡片 | 默认目录是本地 mock |
| 连接失败 | 红色提示条原文 + `runtime-*.log` | 内核未装、节点失效、端口占用、配置校验失败 |
| 连接成功但没网 | `scutil --proxy` + `curl --proxy` | 系统代理没设上 / 隧道不通 / DNS 被劫持 |
| 断开后仍有代理 | `scutil --proxy` | 撤销失败，走「恢复网络」 |
| 退出后进程还在 | `pgrep -fl sing-box` | 停止超时，收集日志 |

---

## 13. 收尾

1. 断开连接
2. 退出应用，确认 §8.2 三项干净
3. 若建了测试配置：可以留着（下次继续验），或在左栏删掉
4. 恢复机器上原来的 VPN（如果之前是开着的）
5. 把 §11 收集的文件和「哪一步不过、原文是什么」发回来

> 这一轮不改代码。所有问题按「现象 + 日志 + 复现步骤」记录，等结果出来再决定修哪里。
