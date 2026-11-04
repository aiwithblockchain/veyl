# 验收清单（Review Checklist）

> 日期：2026-11-03（2026-11-04 增加交付门禁）
> 用途：每批开发完成、交叉 review 时逐条对照。**只验行为与契约，不替代 code review。**
> 依据：`implementation-plan.md`（分批）、`capabilities.md`（能力与三条硬规则）、`center-panel.md` §2.1 / §2.5.1、`configs-and-nav.md`、`config-execution.md`、`tun-mode.md`、`issue-management.md`
> **交付门禁在文首：冒烟清单（SM-1～SM-5）与两条交付规则优先于本文其余内容。**

---

## 冒烟清单（SM-1 ～ SM-5）｜每次改动后必过

> **这一节优先于本文所有其它内容。**
> 任何改动——代码、文案、样式、依赖、构建配置——之后，五条全过才能交付。
> 任一条不过：不许写「已完成」，不许以「已知问题」为由带病合入，不许只写「待验」。

### 为什么加这一节

2026-11-04 一天内漏出两个 bug，当时所有「实现层」指标都是绿的：

| 事故 | 当时的绿灯 |
|---|---|
| 应用启动即崩溃（XPC 客户端 resume 前没装事件处理器，libxpc `brk`，SIGTRAP，`tauri dev` 不停重启） | 324 个测试通过、零告警、契约 13 项通过、三轮交叉评审 |
| 首启页 API Key 输入框认不出来（用户不知道该在哪里打字） | `tsc` 通过、`build` 通过、22 个前端测试通过、截图评审「符合设计语言」 |

共同点不是「测试不够多」，而是**所有指标都在验「实现对不对」，没有一条在验「用户能不能用」**。三轮评审抓到了两个提权级 P0，也没有一个人启动过应用。

所以这五条只回答一个问题：**一个人坐在这台机器前，能不能把产品用起来。**

### 怎么执行

- **执行人：产品负责人。** 五条都要启动应用，按项目规矩由负责人执行；工程师只给命令和预期。
- 负责人不在场时，由能接触真机的另一人执行，并保存证据；**没人执行 = 没过**，不能记为「待验」后合入。
- 每条都要留证据：命令输出、日志片段，或本人真机确认的记录。口述「验过了」不算。
- 跑之前先做一次前置复位（应用关闭时执行）：

```bash
# 1) 关掉机器上其它 VPN —— 否则 SM-5 的出口 IP 不可信
ifconfig utun6 2>&1 | head -3
netstat -rn -f inet | grep -E '^(0/1|128\.0/1)' || echo "无 128.0/1 路由"

# 2) 清 webview 的 UI 状态（不动数据库和 Key）
rm -rf "$HOME/Library/WebKit/veyl/WebsiteData"

# 3) 确认没有可用 AI Key（要验首启就必须没有）
python3 -I -c "import json,os;d=json.load(open(os.path.expanduser('~/Library/Application Support/Veyl/secrets.enc')));print(sorted(k for k in d if k.startswith('provider:')) or '没有 AI Key')"
```

第 2 步会重置面板开关、「连接过」标记与「不用 AI」标记；**不会**动 `veyl.db` 和 `secrets.enc`。

### SM-1 应用能启动，并活过 30 秒

**执行**

```bash
cd /Users/wesley/ai/veyl
npm run app:dev
```

开另一个终端看日志：

```bash
tail -f "$HOME/Library/Application Support/Veyl/logs/app-$(date +%F).log"
```

**算过**

1. 30 秒内出现标题为 `Veyl` 的窗口
2. 第 30 秒时进程仍在：`pgrep -fl "target/debug/veyl" | head -1` 有输出
3. 终端里**没有**第二次出现 `Running \`target/debug/veyl\``（那是 tauri dev 自动重启的痕迹）
4. 日志干净：

```bash
grep -nE "panic|SIGTRAP|backtrace" "$HOME/Library/Application Support/Veyl/logs/app-$(date +%F).log" || echo 干净
```

**算不过**

- 窗口没出现，或 30 秒内退出
- 日志出现 `panic` / `SIGTRAP` / `backtrace`
- 终端出现自动重启

**不过时必收**：终端完整输出、当天的 `app-*.log`、`ls -t ~/Library/Logs/DiagnosticReports | head -3` 里的崩溃报告。

---

### SM-2 首启页一眼能操作

**前置**：SM-1 的前置复位已做，本机没有可用 AI Key。

**执行**：打开首启页，**先不读文档、不点、不悬停**，看 5 秒。

**算过**

1. 5 秒内能指出「在这里输入 Key」的位置
2. 用 `Tab` 键能进入该输入框；输入 `abc` 后屏幕上出现 **3 个圆点**（不是明文、不是看不见）
3. 页面元素数量对得上：**1 个输入框 + 1 个主按钮 + 2 个链接 + 1 个跳过按钮**

**算不过**

- 需要读 placeholder 或看说明才知道哪里能输入
- `Tab` 进不去输入框，或打字没反应，或没有圆点
- 元素数量对不上（记录实际看到的）

> 第 2 条是硬判据：**能 Tab 进去、能打出圆点**，比「看起来像输入框」可靠得多。第 1 条只作补充。

---

### SM-3 能配上 AI Key 并通过验证

**执行**：粘贴一个有效的 DeepSeek Key（`sk-` 开头）→ 点「保存并验证」。

**算过**

1. 按钮变成「验证中…」
2. 首启页消失，进入主界面，右侧 AI 面板自动展开
3. Key 确实存进了本机密文：

```bash
python3 -I -c "import json,os;d=json.load(open(os.path.expanduser('~/Library/Application Support/Veyl/secrets.enc')));print(sorted(k for k in d if k.startswith('provider:')))"
# 期望：['provider:deepseek']

grep -a -c "sk-" "$HOME/Library/Application Support/Veyl/secrets.enc" || true
# 期望：0
```

**算不过**

- 停在首启页，且错误文案不是这四类之一：格式不对 / 鉴权失败 / 网络不通 / 凭据文件写入失败
- 进了主界面，但 Key 未验证且界面没有任何提示

**环境问题**（`api.deepseek.com` 不可达）：记为「阻塞」，不算通过；报告里写清原因和补验时间。

---

### SM-4 AI 第一轮就开始提问

**执行**：在右栏输入一句：「帮我配一套能用的连接」。

**算过**

- 这一轮结束后，AI **提出了至少一个需要用户回答的问题**（地区、用途、连接方式三者之一即可）；先调用工具查状态、再提问也算
- 问题能用界面给的选项回答，或至少一句话能答上

**算不过**

- 回复「你好，我是 Veyl 的助手……」之类的自我介绍，整轮没有任何提问
- 不问任何信息直接给结论
- 工具调用失败但不解释

> 这条最不稳定：模型行为会漂。**同一提示词连续两次看到不同行为，记为「不稳定」，不算通过**，把两次原文都记下来。

---

### SM-5 能生成配置、连上、再断开

**执行**：按 AI 引导走完；或在左栏 `＋` 新建一套再点连接。

**算过（连接后四项全绿）**

1. 左栏出现一套配置，节点数 > 0
2. 中间状态显示「已连接」，线路在动
3. 系统代理真的设上了：

```bash
scutil --proxy
# 期望 HTTPEnable : 1，HTTPProxy : 127.0.0.1，HTTPPort : <端口>
```

4. 流量真的走了隧道：

```bash
# 连接前记一次直连
curl -s --noproxy '*' --max-time 10 https://api.ipify.org; echo
# 连接后走代理
curl -s --max-time 10 --proxy "http://127.0.0.1:<端口>" https://api.ipify.org; echo
# 期望：两次不同，第二次是节点所在地 IP
```

**算过（断开后三项全绿）**

5. `scutil --proxy` 回到 `HTTPEnable : 0`
6. `pgrep -fl sing-box || echo "没有 sing-box 进程"` 没有输出
7. 明文配置已清掉：

```bash
ls "$HOME/Library/Application Support/Veyl/config" 2>/dev/null | grep profile- || echo 干净
```

**算不过**：以上任一项不符。

**环境未就绪**（GitHub 下载失败 / 种子拉不到 / 没有可用节点）：记为「阻塞」，**不算通过**；报告写「阻塞 + 原因 + 下次补验时间」。

---

### 为什么是这五条

- 它们正好覆盖五个独立环节：**进程能活 → 首屏能用 → 凭据能存 → AI 能进入角色 → 核心链路能走通**。
- 没有加「单元测试全绿」：那是自动门禁（§1 G 条），回答的是「实现对不对」，不是「人能不能用」。
- 没有加「界面好看」：不可判定，见下面的交付规则 B。
- 没有加 TUN / Windows / 分流：当前版本没有这些路径。
- 五条都故意写成**外部可观察**（窗口还在、能打出圆点、`scutil` 的输出），不依赖执行人懂实现。

---

## 交付规则 A｜每个报告必须分栏

报告模板在原四段（做了什么 / 关键决定 / 没做完或卡住的 / 需要确认的）之外，**强制**增加一栏：

```
【验证状态】
真机验过：<条目>（怎么验：…；看到：…）
只跑过自动检查：<条目>（命令：…；结果：…）
完全没验：<条目>（原因：…；谁验、何时）
```

规则：

1. **每一条交付物必须落在三栏之一。** 三栏都空 = 报告无效，不接收。
2. 「真机验过」必须写**怎么验 + 看到什么**。只写「手动验过」「试了一下」不算。
3. 「只跑过自动检查」必须写**跑了哪条命令、结果是什么**。用「测试全绿」代替无效。
4. **没有真机验证时，禁用这些词**：已完成、可以了、没问题、应该可以、符合预期。
5. 「完全没验」不是免责：必须写**谁在什么时候补**。超过一个批次没补，该项按未交付处理。
6. **冒烟五条不折进这三栏**：冒烟不过 = 直接不交付，没有讨论空间。
7. 400 字简报仍然适用：**验证状态优先**，字数不够就压缩「做了什么」。

> 自动检查包括 `cargo test` / `npm run typecheck` / 契约检查 / `cargo check` / 构建。它们证明的是「实现与契约一致」，**不能**证明「进程能起来」或「控件能被发现」。2026-11-04 的两个事故就发生在这条缝里。

---

## 交付规则 B｜UI 验收：本人真机看一眼

旧标准（不再作为通过理由）：符合设计语言、与现有规格一致、截图评审通过。

新标准：

> **产品负责人本人在真机上打开那个界面，自己看一眼判断：这里该在哪里操作，能不能一眼看出来。** 能就是过，不能就退回改。

- 不要截图、不要录屏、不要第三个人。
- 只看一件事：第一次看到这个界面的人，能不能找到该操作的地方。找不到就退回改，不用辩论设计语言。
- 纯后端改动不适用，用 SM-1 / SM-5。

**为什么换**：

- **「协调」和「能用」是两件事。** 设计语言保证的是「看起来是一套」，不保证「知道点哪」。
- 首启页输入框就是例子：当时的截图评审通过了，因为它和设计完全一致；但在真机上第一眼就是看不出哪里能输入。
- 这条不需要外部背书。把「客观」包装成流程，执行成本最后落在执行人身上，不划算；本人看一眼就能分清。

---

## 0. 怎么用

### 0.1 验证方式

| 标记 | 含义 | 谁执行 |
|---|---|---|
| **自动** | 跑命令看退出码或输出 | 任何工程师 |
| **界面** | 需要启动应用才能观察 | **产品负责人**（项目规矩：启动应用、占端口的测试一律由负责人执行，工程师只给命令） |
| **读文件** | 读生成的 sing-box 配置、数据库、日志 | 任何工程师 |

界面项在清单里只写「做什么、看到什么算过」。工程师不代替负责人启动应用。

### 0.2 缺陷等级

| 级别 | 定义 | 处理 |
|---|---|---|
| **P0** | 违反 `capabilities.md` §5 三条硬规则之一；或界面出现映射表外的元素 | 不许合入 |
| **P1** | 文档明确写死的行为没做到（顺序、文案、二次确认、降级路径） | 不许合入 |
| **P2** | 体验/一致性瑕疵，不影响正确性 | 记录，可后续批修 |

### 0.3 放行标准

某批合入前必须同时满足：

0. **冒烟 SM-1～SM-5 全过**（见文首）。不过就直接不交付，不看下面三条；
1. §1 通用门禁（G）全部通过；
2. 该批条目中**没有 P0 / P1**；
3. 该批涉及的跨批专项（§2 的 S 条）通过。

> 反过来说：G / S 全绿也不代表能交付——2026-11-04 的两次事故就是 G 全绿、S 没覆盖到的例子。冒烟是独立的一层。

---

## 1. 通用门禁（每批合入前都跑）

| 编号 | 验证项 | 怎么验 | 通过标准 |
|---|---|---|---|
| G-01 | 现有 CI 全绿 | 自动：`bash scripts/ci.sh --quick` | 退出码 0；`build/logs/` 六步无 FAIL |
| G-02 | 类型与编译干净 | 自动：`cargo check --manifest-path src-tauri/Cargo.toml --all-targets` + `npm run typecheck` | 均退出 0。**若出现 `unused import` / `never used` 且指向本批删除的模块，算残留 P1**，不是可忽略的 warning |
| G-03 | 命令三方一致 | 自动：见命令块 G-03 | `contracts/commands.md` §2 = `generate_handler!` = 前端调用字面量，差集为空。例外只允许写在 `contracts/commands.md` §4 |
| G-04 | 能力 → 块 → 命令三层对得上 | 自动：见命令块 G-04 | `center-panel` §2.5.1 引用的能力 ID **全部**存在于 `capabilities.md`（反向不要求：H/I 组与非界面能力可以不在映射表里）；每个块依赖的后端命令要么已在契约 §2，要么在本批「新增命令」清单里且已补进契约 |
| G-05 | 块词汇表封闭 | 自动 + 读代码：见命令块 G-05 | 渲染入口恰好六种 `type`；没有第七种；未知 `type` 走「忽略 + 记日志」，界面不崩（center-panel §2.5 规则） |
| G-06 | 映射表外没有块或按钮 | 界面：进入任一状态（未连接 / 已连接 / 失败），逐个点开中间区所有可点元素 | 中间区只出现：固定骨架三件（顶部按钮+状态、中间块、底部节点区）+ 六种块。**出现第二个主按钮、常驻状态面板、自定义提示条 → P0**。「有问题问右侧的助手」属于 `empty_hint`，不单独算一个元素；问题列表是 `issue_card` 的二级页面，也不算新块（2026-11-03 裁定） |
| G-07 | 禁止词 | 自动扫描 + 人工过滤：见命令块 G-07 | 用户可见文本（JSX 文本节点、`title` / `placeholder` / `aria-label`、弹窗与空态文案）中**零命中** `proxy` / `TUN` / `分流` / `规则集`。代码标识符（`proxy_card`、`system_proxy`）、命令名、日志不算。**三级确认页同样适用**（2026-11-03 裁定）：技术细节只给数值与具体地址，规则集文件名之类不上界面 |
| G-08 | 破坏性操作二次确认 | 界面：逐项触发下方清单 + 读文案 | 每个都弹确认，且文案写清**具体后果**（会断连 / 会删掉哪套配置 / 会改系统网络设置）。只写「确定吗？」→ P1 |
| G-09 | 仓库无明文凭据 | 自动：`bash scripts/check-secrets.sh` + `bash scripts/test/secret-scan.sh` | 两者退出码均 0；`git ls-files` 无 `.env*` / `*.key` / `*.p12` / `*.pem` |
| G-10 | 删除完整性 | 自动：见命令块 G-10 | 旧符号在 `src/` 与 `src-tauri/src/` 中零引用；命中只允许出现在注释或 `docs/`、`tests/` |
| G-11 | 空态能看出「没什么要说的」 | 自动 + 界面：见命令块 G-11 | 三处空态（左栏无配置、中间首启 0–20s、种子拉不到）都有给定文案或同义文案；不出现「加载中 / 请稍候 / 暂无数据」这类分不清是空还是坏的词 |

**G-08 的破坏性操作清单**（来自 `capabilities.md` 的「破坏性」列 + `configs-and-nav.md` §2.1 / §6）：

- B3 删除节点配置
- 左栏删除一整套配置（含「默认配置」，明确允许删）
- E3 重置网络（高）
- E1 恢复直连（中）
- 已连接时切换配置（会断一次）

```bash
# G-03 命令三方一致
comm -3 \
  <(sed -n '/^## 2\. 命令总表/,/^## 3\./p' docs/contracts/commands.md \
    | sed -nE 's/^\| [0-9]+ \| `([a-z_]+)`.*/\1/p' | sort -u) \
  <(grep -oE "agent::commands::[a-z_]+" src-tauri/src/lib.rs \
    | sed 's/.*:://' | sort -u)

comm -3 \
  <(sed -n '/^## 2\. 命令总表/,/^## 3\./p' docs/contracts/commands.md \
    | sed -nE 's/^\| [0-9]+ \| `([a-z_]+)`.*/\1/p' | sort -u) \
  <(grep -rhoE '(call|invoke)\(\s*"[a-z_]+' src \
    --include="*.ts" --include="*.tsx" | sed -E 's/.*"//' | sort -u)
```

```bash
# G-04 能力 ↔ 块 ↔ 命令
# 映射表引用的能力 ID（左列有值、右列无值是缺陷）
sed -n '/### 2.5.1/,/### 2.6/p' docs/center-panel.md \
  | grep -oE '\b[A-J][0-9]\b' | sort -u > /tmp/panel-ids.txt
grep -oE '\*\*[A-J][0-9]\*\*' docs/capabilities.md \
  | tr -d '*' | sort -u > /tmp/cap-ids.txt
comm -23 /tmp/panel-ids.txt /tmp/cap-ids.txt   # 必须为空

# 映射表引用的后端命令（去掉六个块名）
sed -n '/### 2.5.1/,/### 2.6/p' docs/center-panel.md \
  | grep -oE '`[a-z_]+`' | tr -d '`' | sort -u \
  | grep -vxE 'empty_hint|proxy_card|source_choice|reachability|issue_card|update_hint'
```

```bash
# G-05 块词汇表
grep -rn "empty_hint" src --include="*.ts" --include="*.tsx"
# 期望：只有一处联合类型/常量表，恰六项；以及一个明确的分支处理未知 type
```

```bash
# G-07 禁止词（先扫，再人工判断命中是否用户可见）
grep -rnE "分流|规则集" src/components --include="*.tsx"
grep -rniE "\bproxy\b|\btun\b" src/components --include="*.tsx"
```

```bash
# G-10 删除完整性
grep -rnE "seed_import|bootstrap\.json|ProfileList|StatusPanel|Onboarding|profile_list|profile_delete|import_seed_file" \
  src src-tauri/src --include="*.rs" --include="*.ts" --include="*.tsx"
```

```bash
# G-11 空态用词
grep -rnE "加载中|请稍候|暂无数据|Loading\.\.\.|Loading…" src/components
```

> **G-03 当前基线**：`open_external` 已注册、前端在调，但不在契约 §2 总表。批 1 开工前先补契约或登记进 §4，否则这项从第一天就是红的。
> **G-07 当前基线**：`src/components/Settings.tsx:901` 有用户可见文案「TUN 暂不支持」，批 5 处理设置页时一并清掉。

---

## 2. 跨批专项

这些不属于某一批，但每批都可能碰，单列出来。

### 2.1 安全

| 编号 | 验证项 | 怎么验 | 通过标准 |
|---|---|---|---|
| S-01 | **种子缓存的密码不落明文** | 读文件：拉一次种子后，`grep -a "<种子里的密码>" "<data_dir>/veyl_seed*.json"`（先 `grep -rn "veyl_seed" src-tauri/src` 找落盘位置） | 缓存文件里**没有**明文密码：密码要么进 `secrets.enc`，要么缓存整体加密。`configs-and-nav.md` §8「明文密码永不落盘」对缓存同样成立 |
| S-02 | URL 导入的 SSRF 防护 | 自动 + 手工构造：见下方五条断言 | 五条全过，任一不过算 P0 |
| S-03 | 密码不进日志 | 自动：`grep -rniE -e password -e passwd src-tauri/src/logging.rs src-tauri/src/runtime` 后逐一确认；再跑一次失败连接，`grep` 日志目录找明文 | 日志中密码为 `***` 或完全缺失；找不到原始密码 |
| S-04 | 节点凭据不进 AI 上下文 | 自动：复用 `tests/mock-llm` 的 `GET /__last_request`（对应 TC-CAT-012） | 最近一次请求的消息数组里不含任何节点密码；含 `password_ref` 也算违规（引用键可接受，明文不行） |
| S-05 | 监听地址只在本机 | 读文件：生成配置的 inbound `listen` 字段 | 必须是 `127.0.0.1`，不允许 `0.0.0.0` / `::`（A5） |
| S-06 | 命令参数不嵌套对象 | 自动：`grep -rnE 'invoke\(\s*"[a-z_]+"\s*,\s*\{\s*[a-z_]+:\s*\{' src` | 零命中（`contracts/commands.md` §1.1.1）。嵌套参数会静默变 `None` |
| S-11 | 取用户 URL 时不跟随系统代理 | 自动：`grep -n "no_proxy" src-tauri/src/public_http.rs`；再设 `HTTPS_PROXY` 后做一次导入 | 命中且行为不变（2026-11-04 裁定：种子是最后的恢复手段，跟随代理会形成「代理坏了→种子拉不到→修不好」的死锁） |
| S-12 | IPv6 转换段也判为非公网 | 自动：单测覆盖 `64:ff9b::/96`（NAT64）与 `2002::/16`（6to4） | 两者都拒绝；否则可翻转到 v4 内网 |

**S-02 的五条断言**（每条都要单独构造，缺一不可）：

1. `http://127.0.0.1:18080/` → 拒绝（本机）
2. `http://192.168.1.1/` → 拒绝（内网）
3. 公网 URL 返回 302 到 `http://169.254.169.254/` → **不跟随**，报错（元数据地址）
4. 响应体超过上限（如 2 MB）→ 中止并报「太大」
5. 连接与读取都有超时（如 10 s），不可无限等

> 第 1、2 条不能只校验字面量：域名解析出的 IP 也必须校验，否则 DNS 重绑定可绕过。

### 2.2 降级

| 编号 | 验证项 | 怎么验 | 通过标准 |
|---|---|---|---|
| S-07 | 标「AI 不可用时可用」的能力真的不调 AI | 自动 + 界面：把 LLM 指向不可达地址（或清空 key）后，逐项操作 A1–A5、B1–B4、C1–C3、D1、E1–E4、G1–G4、J1–J2、J4 | 全部可用；mock-llm 请求计数为 0。**任何一项点了没反应或报 AI 相关错误 → P0** |
| S-08 | AI 挂掉、网断掉时仍能连上、换节点、恢复网络 | 界面：断网 + 清空 key，用已缓存的种子节点 → 连接 → 换另一个节点 → 停止 → 重置网络 | 四步都成功，且全程无 AI 请求 |

### 2.3 文案

| 编号 | 验证项 | 怎么验 | 通过标准 |
|---|---|---|---|
| S-09 | 失败文案三要素 | 界面：制造 4 种失败（DNS 失败 / 节点连不上 / TUN 权限拒绝 / 助手安装失败），逐个看卡片 | 每张都回答了：发生了什么、为什么、现在做什么。缺一项 P1 |
| S-10 | 术语分级 | 界面：用三级身份看确认页与代理卡 | 三级看到的是**具体数值与行为**：`7890`、DNS 的实际服务器地址、直连的国家名（`config-execution.md` §1）。仍不出现四个禁止词；一级/二级只见人话，不出现任何需要网络知识的词 |

---

## 3. 批 1 · 数据地基

| 编号 | 验证项 | 怎么验 | 通过标准 |
|---|---|---|---|
| B1-01 | 数据库从零重建 | 自动：`ls src-tauri/src/store/migrations/`；`grep -n "CREATE TABLE" src-tauri/src/store/migrations/001_init.sql` | 只有 `001_init.sql` 一份；无 `profiles` 表；有 `configs` / `nodes` / `config_nodes` |
| B1-02 | 一套配置的七项都有落点 | 自动 + 读文件：对照 `configs-and-nav.md` §3 七项（连接方式、分流策略、节点集、当前节点、DNS、内网排除、端口）逐项在 schema 或类型里找 | 七项都有落点。**DNS 与内网排除目前没有列**；若用 JSON 列承载，DDL 注释必须写明，并有 round-trip 测试 |
| B1-03 | 同一时刻只有一套激活配置 | 自动：读 `001_init.sql`；再写一条集成测试并发激活两套 | 有 `idx_configs_one_active` 唯一索引；连续两次 `config_activate` 后只有一套 `is_active = 1`，不抛 UNIQUE 冲突 |
| B1-04 | 节点与配置是多对多 | 读文件 + 自动：建一套配置引用两节点；同一节点挂到第二套配置 | 允许共用；删除节点不连带删除配置（`configs-and-nav.md` §7） |
| B1-05 | 批 1 七条命令齐全 | 自动：G-03 的三方 diff | `config_list` / `config_create` / `config_update` / `config_delete` / `config_activate` / `node_import_url` / `node_create` 均在契约 §2 且已注册 |
| B1-06 | 密码只进 `secrets.enc` | 自动（界面）：建一个节点，密码用唯一串 `TestPw-9f3k2`，关掉 App 后：`grep -a "TestPw-9f3k2" "<data_dir>/veyl.db"; echo $?` 与 `grep -a "TestPw-9f3k2" "<data_dir>/secrets.enc"; echo $?` | 两条 `echo $?` 都是 1（找不到）。库里只有 `password_ref`；`secrets.enc` 里是密文。**任一条回到 0 → P0** |
| B1-07 | 种子解析只取节点 | 自动：`grep -rnE -e selector -e urltest -e 'route\.' -e routing_rules src-tauri/src/default_profile.rs src-tauri/src/store/` | 无输出；解析结构只有 `version` / `updated_at` / `nodes`（`implementation-plan.md` §1） |
| B1-08 | 更新检测按内容哈希 | 自动：`grep -rnE -e sha256 -e If-None-Match -e 304 src-tauri/src/store/ src-tauri/src/default_profile.rs`；单测覆盖「同内容不同 version → 不更新」 | 命中存在且不依赖 `version` 字段（`config-execution.md` §10） |
| B1-09 | 同一时刻只有一个拉取在飞 | 自动：mock 服务计数的 `GET /__stats`；或单测并发调两次 | 请求数 = 1（`config-execution.md` §10） |
| B1-10 | URL 导入的格式边界 | 界面 + 自动：分别输入 base64 多节点订阅、`vmess://...`、单条 `ss://...`、乱码 | 只有 base64 多节点订阅成功；其余三类明确报「暂不支持」，**不猜着解析**（`config-execution.md` §6） |
| B1-11 | 拉不到不保存空配置 | 界面：把 URL 指向不可达地址导入 | 给出「这条现在拿不到，等能上网再试」；`config_list` 前后不一致 → P1 |
| B1-12 | 手动编辑五字段并复述确认 | 界面：手动填 Name/Server/Port/Password/Method | 保存前把结果复述给用户确认，Method 与 Port 必须在复述里（`config-execution.md` §6） |
| B1-13 | 删除完整性 | 自动：G-10 | 见 G-10 |
| B1-14 | 凭据不进 AI 上下文 | 自动：S-04 | 见 S-04 |

```bash
# B1-06 用的 data_dir 先定位（macOS）
grep -rn "app_data_dir\|veyl.db" src-tauri/src/store/db.rs | head
```

---

## 4. 批 2 · 界面骨架

| 编号 | 验证项 | 怎么验 | 通过标准 |
|---|---|---|---|
| B2-01 | activity bar 只有一个图标 | 界面：看最左侧 | 只有「客户端」；没有「服务商」「自建站」，连灰掉的占位也不许有（`configs-and-nav.md` §1） |
| B2-02 | 左栏行信息完整 | 界面：建两套配置，一套本机代理一套接管全部 | 每行显示 配置名 · 节点个数 · 端口；接管全部的端口处显示「自动」 |
| B2-03 | 左栏空态能自己走出去 | 界面：删光所有配置 | 出现 `configs-and-nav.md` §2.1 的空态文案与「新建配置」；按钮可点，能直接建一套 |
| B2-04 | 顶部只有一个按钮 | 界面：未连接 / 已连接 / 连接中各看一次 | 永远一个按钮，两态互斥，文案固定为「启动 VPN」/「断开 VPN」；没有第二个主操作 |
| B2-05 | 选中 ≠ 切换 | 界面：底部点开节点列表，选另一个 | 只有详情变；`runtime_status` 里当前节点不变；网络不中断。按「切换到此节点」后当前节点才变（`center-panel.md` §2.1） |
| B2-06 | 切换节点走独立命令 | 界面：选中当前节点；再选另一个并点「切换到此节点」 | 选中 = 当前时按钮禁用；切换走 `node_switch`，不是 `runtime_start(nodeId)`（2026-11-04 裁定：`runtime_start` 去掉 `nodeId`，只留 `configId`） |
| B2-07 | 测试连通始终可点 | 界面：未连接、已连接、断网三种情况各点一次 | 都能点并给出结果；走 D6 / `node_probe`，不启动运行时也能测；失败说清原因，不是「失败」两个字 |
| B2-08 | **全程不依赖 AI** | 界面：断网 + 清空 LLM key，用已缓存种子 | 新建配置 → 连接 → 换节点 → 断开，四步都成功（`implementation-plan.md` 批 2 完成标准） |
| B2-09 | 中间空态不是纯白 | 界面：首启 0–20s，AI 还没输出 | 有一行说明，不是空白（`center-panel.md` §4 末段） |
| B2-10 | 切配置不静默 | 界面：已连接时点左栏另一套配置 | 先提示会断开一次并自动重连，确认后才切（`configs-and-nav.md` §6） |
| B2-11 | 删配置有二次确认 | 界面：删一套配置（含默认配置） | 确认框写清会删掉什么；删完回空态且能重建 |
| B2-12 | 换配置后中间重新编排 | 界面：从「本机代理」切到「接管全部」 | 代理卡消失，不残留旧配置的块；AI 不可用时也不报错，只按本地规则渲染骨架（`configs-and-nav.md` §9） |
| B2-13 | 端口显示实际值 | 自动 + 界面：先占用默认端口再启动；`grep -rn "7890" src --include="*.tsx"` | 硬编码 0 处；端口被占用时自动顺延且界面显示真实端口（A5） |
| B2-14 | 骨架层无禁止词 | 自动：G-07 | 见 G-07 |
| B2-15 | **默认不启用 mock** | 自动 + 界面：不设 `VITE_MOCK` 启动，新建配置、点启动、换节点 | 全程走真实命令；`runtime_status` / `config_list` 有调用；`localStorage` 里没有 `veyl.configs.v1`；界面状态来自真实运行时（2026-11-04 裁定） |
| B2-16 | mock 只能显式开启 | 自动：`grep -rn "VITE_MOCK" src` | 只有一个开关读取点；未设置时假数据路径不可达 |
| B2-17 | 死路按钮已移除 | 自动 + 界面：`grep -rn "连接测试节点" src` | 零命中；首启不再出现点了必然失败的按钮（2026-11-04 裁定：Onboarding 留到批 4，但该按钮现在拆掉） |

> B2-08 是 M1 的核心。先缓存好种子再断网，否则首启拉种子会失败——那是 `config-execution.md` §9 已知的唯一网络依赖，不算缺陷。

---

## 5. 批 3 · 配置生成（分流与 DNS）

| 编号 | 验证项 | 怎么验 | 通过标准 |
|---|---|---|---|
| B3-01 | 三种分流模式生成正确 | 读文件 + 自动：各生成一次，`sing-box check -c <file>`；再 `jq '.route.final, .route.rules'` | 三种模式均 `check` 退出 0；`route.rules` 与 `final` 符合模式定义（`implementation-plan.md` 批 3） |
| B3-02 | 免重启切换不断流 | 界面 + 自动：连接后持续 `curl --max-time 1 https://<echo>` 30 秒，中途切分流 | 30 秒内失败 0 次；切换走 Clash API selector，不改配置文件 |
| B3-03 | 规则顺序正确 | 读文件 + 自动：按顺序断言 | `sniff` → `hijack-dns` → `ip_is_private` → 分流，索引严格递增（`tun-mode.md` §3）。顺序错是静默失效，必须脚本断言 |
| B3-04 | 自定义规则不被种子覆盖 | 界面：加一条自定义规则 → 强制刷新种子 → 再看 | 自定义规则仍在，且不被重新排序（`implementation-plan.md` 批 3） |
| B3-05 | DNS 配置完整 | 读文件 + 自动：`grep -c "default_domain_resolver" <file>`；`sing-box check` | 本地 2–3 候选直连、境外 2 候选经代理；配了多条 DNS 时必须有 `default_domain_resolver`，缺了是 FATAL 不是降级（`tun-mode.md` §5） |
| B3-06 | 分流文案无禁用词 | 自动 + 界面：G-07；再看分流选择的界面 | 界面上不出现「分流」「规则集」；用「哪些网站走 VPN / 直连」这类说法 |
| B3-07 | 规则集按需加载 | 读文件：看首启加载了哪些 `.srs` | 不全量加载；只加载用户国家 + 相关分类（`implementation-plan.md` 批 3） |
| B3-08 | 生成配置先过 `check` | 自动：构造一份非法配置（错误端口/加密方式） | `check` 非 0 时不启动，把报错翻译成人话（`config-execution.md` §7） |

---

## 6. 批 4 · 首次流程与 AI 编排

| 编号 | 验证项 | 怎么验 | 通过标准 |
|---|---|---|---|
| B4-01 | 提问次数按用户类型 | 界面：一级走一次、二级走一次、三级走合流追问 | 与 `implementation-plan.md` 批 4 一致；问题数不超 |
| B4-02 | `source_choice` 出现条件 | 界面：面板已生成但还没节点 | 出现「用我们提供的 / 用我自己的」；已有节点后不再出现 |
| B4-03 | 六个块都能渲染 | 界面：逐个触发六种块的显示条件 | 六种都渲染正确，样式来自设计规范（`center-panel.md` §2.5） |
| B4-04 | 未知块被忽略并记日志 | 自动：mock-llm 剧本返回 `{ "type": "banner" }` | 界面不崩、不渲染该块；日志有一行 ignore 记录（`center-panel.md` §3） |
| B4-05 | 布局持久化并还原 | 读文件 + 界面：`sqlite3 <db> "select * from layout"`；重启应用 | 布局已落库；重启后中间区与关闭前一致，不再走一遍提问（`center-panel.md` §3） |
| B4-06 | 提示词与文档同源 | 自动：见命令块 B4-06 | 提示词里的块清单 = 六项，一个不多一个不少；能力 ID 双向差集为空（`capabilities.md` 开头 + `center-panel.md` §2.5.1 第 5 步） |
| B4-07 | AI 不可用时本地规则兜底 | 界面：断网 + 清空 key + 制造一个 P0 | 中间出现 `issue_card`，带「重置网络」入口；无 AI 请求（`capabilities.md` §4） |
| B4-08 | `empty_hint` 不依赖 AI | 界面：清空 key，已配置未连接；再连上 | 未连接时 `empty_hint` 仍显示完整一句话，并包含那行「有问题问右侧的助手」；**连上之后这句不再出现**（2026-11-03 裁定：不常驻）。注意它的参数来自 H1（AI 工具），必须有静态回退，不能因为拿不到 H1 就空着 |
| B4-09 | 首次 0–20s 中间非空 | 界面：全新用户首次启动 | 有一句话说明，不是空白（`center-panel.md` §4） |
| B4-10 | 提问走 `AskUserQuestion` | 自动：`docs/contracts/tools.md` 里存在该工具；mock-llm 剧本走到它 | 提问经工具通道，不是让 AI 在正文里问 |
| B4-11 | AI 不能改样式 | 自动：mock-llm 返回带 `props.color` / `props.style` 的块 | 颜色/样式被忽略并记日志；渲染结果与设计规范一致（`center-panel.md` §3） |
| B4-12 | AI 不能发明块 | 自动 + 读代码：块 type 的入参校验 | 非法 type 在写入布局前就被拒，或渲染时忽略并日志；不写进库更佳 |
| B4-13 | 文案禁止词 | 自动：G-07 | 见 G-07 |

```bash
# B4-06 找到提示词文件后，两边各抽一次清单对比
grep -rl "empty_hint" src-tauri/assets src-tauri/src src/ai 2>/dev/null
# 块：应恰好 empty_hint proxy_card source_choice reachability issue_card update_hint
# 能力：提示词中出现的 A1..J4 应与 capabilities.md 双向一致
```

---

## 7. 批 5 · TUN 与特权助手

| 编号 | 验证项 | 怎么验 | 通过标准 |
|---|---|---|---|
| B5-01 | 六项固定参数逐条核对 | 读文件：`jq` 读取生成配置的 inbound 与 route | `interface_name` 空；`auto_route` / `auto_detect_interface` 为 true；`address` = `172.19.0.1/30`；sniffer 含 `dns`；规则顺序见 B3-03（`tun-mode.md` §3） |
| B5-02 | 授权前先解释 | 界面：首次连接 | 系统弹窗出现**之前**有一句人话解释；没有「稍后再说」按钮（`center-panel.md` §2.4） |
| B5-03 | 拒绝授权的完整行为 | 界面：拒绝一次，再看再连一次 | 不显示「已连接」；登记 `tun_denied`；卡片只有「重试」；再次点连接会**再次**请求授权（`tun-mode.md` §8） |
| B5-04 | 失败不回退 | 界面 + 自动：TUN 失败后 `networksetup -getwebproxy Wi-Fi` | 系统代理仍为直连，未被悄悄设上；界面明确说 TUN 启动失败（`tun-mode.md` §8） |
| B5-05 | helper 安装失败 | 界面：模拟安装失败 | 记录 `helper_missing`；文案说清是「安装问题」不是「网络问题」 |
| B5-06 | 起 TUN 前先判 euid | 自动：`grep -rnE -e euid -e geteuid src-tauri/src` | 非 root 时直接给「需要管理员权限」，不等失败再报（`tun-mode.md` §4 第 4 条） |
| B5-07 | 内网排除两层都在 | 读文件 + 自动：`jq '.route.rules'` 与 `route_exclude_address` | 固定 13 条全在（含 `100.64.0.0/10`）；`ip_is_private → direct` 也在；本机接口反推网段已自动加入（`tun-mode.md` §6） |
| B5-08 | 用户补充网段可持久化 | 界面：确认页填一个额外网段 → 断开重连 | 下次沿用；确认页有一句「我只绕开你当前所在的网段」提示 |
| B5-09 | 不检测其它 VPN（负向） | 界面：开着 Tailscale 起 TUN | **不提示**、不阻止、不规避。这是产品决定，实现里多加了检测反而是缺陷（`tun-mode.md` §7） |
| B5-10 | 桌面应用真的能用 | 界面：TUN 已连接，不设任何代理，用 `curl https://<echo>` 与一个原生 App 访问 | 都能通（`implementation-plan.md` 批 5 完成标准） |
| B5-11 | 卸载清 helper 且与 E3 共用代码 | 自动：`grep -rni "uninstall" src-tauri/src`，看结果里是否覆盖 helper 清理；确认只有一个清理入口 | 卸载与 E3 调同一函数，不是两份实现（`capabilities.md` §3.1） |
| B5-12 | 界面不出现 TUN | 自动：G-07 | 界面只说「接管全部」；系统弹窗自带的文字不算 |

---

## 8. 批 6 · 问题管理与恢复

| 编号 | 验证项 | 怎么验 | 通过标准 |
|---|---|---|---|
| B6-01 | 采集与展示不依赖 AI | 界面：断网 + 清空 key，触发一次 DNS 失败 | 问题被记录、列表可见；无 AI 请求（`issue-management.md` §2） |
| B6-02 | 同类合并计数 | 自动 + 界面：同一问题触发 3 次 | 一条记录，`count = 3`，`last_seen` 更新；resolved 后再出现会重开（§3） |
| B6-03 | 中间最多一张卡 | 界面：同时制造两个 P0 | 只显示最先出现的；另有「还有 N 个问题」（§4） |
| B6-04 | 卡片动作按类型 | 界面：`tun_denied` 与 `dns_fail` 各看一次 | 权限类只有「重试」；诊断类才有「让 AI 定位」（§6 表） |
| B6-05 | 诊断包采集时就保存 | 读文件：断网制造问题后查 issue 记录 | `evidence` 非空且含 §5 的六类信息，不是转交时现采 |
| B6-06 | 转交是一次性投喂 | 自动：mock-llm `__last_request` | 一次请求里带完整诊断包，不是逐条追问 |
| B6-07 | resolved 必须复测 | 界面：让 AI 说「修好了」但复测仍失败 | 状态停在 `handed_off`，不得置 resolved（§6） |
| B6-08 | 重复出现带历史 | 界面：同一问题第三次出现 | 卡片写「第 3 次出现，上次是 X 月 X 日」（§6） |
| B6-09 | 状态词汇与文档一致 | 自动：`grep -n "status" src-tauri/src/store/migrations/001_init.sql` | 必须覆盖 `open` / `handed_off` / `resolved` / `ignored` 四种语义。**当前 schema 是 `open/resolved/dismissed`，缺 `handed_off`**，需补 |
| B6-10 | 严重度映射明确 | 自动：同上 `severity` | `P0/P1/P2` 与库里的取值有一一对应表，且「P0/P1 才插卡」由代码体现 |
| B6-11 | E3 五步顺序不可变 | 自动 + 界面：执行一次并看日志 | 停运行时 → 撤销系统代理（按备份，不是关开关）→ 清 DNS 覆盖 → 删渲染配置 → 复读校验，五步顺序固定（`capabilities.md` §3） |
| B6-12 | E3 失败说清卡在哪 | 界面：人为让第 3 步失败 | 显示「卡在第 3 步：清除 DNS 覆盖」，并允许重试；不静默失败 |
| B6-13 | E3 二次确认且不在骨架 | 界面：找入口 | 入口只在问题卡 / 设置 / 托盘 / 右栏；中间固定骨架没有常驻的「重置网络」按钮 |
| B6-14 | 启动自检 | 界面：手工写回系统代理（`networksetup -setwebproxy`）后重启应用 | 主动提示「检测到上次没有正常关闭，要恢复网络吗？」（`capabilities.md` §3.1） |
| B6-15 | 卸载清理 = E3 同一实现 | 自动：同 B5-11 | 只有一个实现 |
| B6-16 | **断网 + AI 不可用仍能自救** | 界面：断网、清空 key、TUN 失败 | 看得见问题、一键恢复、恢复后能重新连接（`implementation-plan.md` 批 6 完成标准） |
| B6-17 | 问题列表入口 | 界面：制造一个 P1 → 点问题卡上的「查看全部」；再把问题全部处理掉 | 列表是中间区的二级页面，入口只在这一处；不占左栏、不进设置页；没有问题时没有任何入口（`issue-management.md` §7，2026-11-03 裁定） |

---

## 9. 批 7 · 升级

| 编号 | 验证项 | 怎么验 | 通过标准 |
|---|---|---|---|
| B7-01 | APP 升级走 `tauri-plugin-updater` | 读文件：`src-tauri/tauri.conf.json` 的 `plugins.updater` | endpoint 指向 GitHub Releases 的 `latest.json`；公钥已配置，签名校验开启 |
| B7-02 | 资源逐条版本 + sha256 | 读文件：`src-tauri/assets/runtime-manifest.json` | 每项都有 `version` 与 `sha256`；一条坏不影响其它（逐条隔离） |
| B7-03 | 构建期校验 | 自动：把资源目录里任一文件改一个字节，跑 `npm run app:build` | 构建失败并指出哪个文件 hash 不符 |
| B7-04 | 原子替换 | 自动：用坏包替换一次 | 现有安装不被破坏；旧版本保留到新版本校验通过 |
| B7-05 | 升级不打断连接 | 界面：已连接时触发资源更新 | 连接不断；新版本下次连接生效（`config-execution.md` §10 边界） |
| B7-06 | 签名密钥不在仓库 | 自动：`bash scripts/check-secrets.sh`；`grep -rnE -e TAURI_SIGNING -e APPLE_ID -e NOTARY .github scripts` | 只从 CI secret 读；仓库里没有任何密钥值 |

---

## 10. 待裁定（OPEN）

### 10.1 已裁定（2026-11-03）

| 编号 | 裁定 | 落到清单哪一条 |
|---|---|---|
| OPEN-01 | 「有问题问右侧的助手」并入 `empty_hint`，不新增块 | G-06、B4-08 |
| OPEN-02 | 三级看具体数值与行为，仍避开四个词；确认页必须与第三问用同一套说法 | G-07、S-10 |
| OPEN-04 | 新增能力 D6「测试单个节点连通性」，命令 `node_probe` | B2-07、G-04 |
| OPEN-07 | 问题列表放中间区的二级页面，入口是问题卡上的「查看全部」；没有问题时不显示任何入口 | B6-17、G-06 |
| OPEN-08 | 那行提示**不常驻**：只在未连接时随 `empty_hint` 出现，已连接后不再显示 | B4-08 |
| OPEN-09 | 确认页「展示内容」改为「具体数值与行为：连接方式、直连范围、DNS 候选、端口」，不再写「分流规则名」 | S-10、G-07 |
| OPEN-05 | 批 1 的 `001_init.sql` 已对齐：`severity` 为 `P0/P1/P2`，`status` 含 `handed_off` / `ignored` | B6-09、B6-10 |
| OPEN-06 | 批 1 的 `configs` 已有 `dns_json` / `tun_excludes_json` 两列 | B1-02 |
| OPEN-10 | 去掉 `runtime_start` 的 `nodeId`：只保留 `node_switch` 改选中、`runtime_start(configId)` 启动 | B2-06、G-04 |

### 10.2 仍待处理

**验收时遇到 OPEN 项按「未通过」处理，不要自己解释成通过。**

| 编号 | 冲突 | 两边说法 | 影响 | 建议 |
|---|---|---|---|---|
| OPEN-03 | `capabilities.md` 的 B 组命令名是旧的 | B1–B4 仍写 `profile_list` / `runtime_start(profile_id)` / `profile_delete` / `import_seed_file`；批 1 已有 `config_*` 与 K 组，但 B 组没改。这份表是系统提示词的来源 | G-03 / G-04 会把能力表判成不一致 | 已转架构师。把 B 组改成 `config_*` / `node_*`，或并入 K 组 |
| OPEN-10 | 契约把未实现命令标成「2.0 新增」 | `commands.md` §2 里 `node_probe` / `proxy_params` / `probe_run` / `issue_*` 未注册（Bob 交接确认属后续批次），但状态列写的是「2.0 新增」而不是「预留」 | G-03 差集非空，看的人分不清是漏做还是没到批次 | 未实现的统一标「预留」。`node_switch` 与 `runtime_start` 的取舍已裁定，见 §10.1 |

---

## 11. 一键跑（自动部分）

```bash
bash scripts/check-secrets.sh
bash scripts/test/secret-scan.sh
npm run typecheck
cargo check --manifest-path src-tauri/Cargo.toml --all-targets
node tests/contracts/check-contracts.mjs
bash scripts/test/wiring-check.sh --strict
```

`bash scripts/ci.sh --quick` 覆盖了其中大部分（用 `cargo test` 代替 `cargo check`）。日常跑它；改动模块结构或删了文件时，再单独补跑 `cargo check --all-targets`。

> 这一节只覆盖**自动检查**。冒烟 SM-1～SM-5 是人工项，不在任何一条命令里，必须由产品负责人按文首清单执行并留证据。

---

## 12. 需要产品负责人执行的界面项

冒烟 SM-1～SM-5（文首）**每批都跑**，不在这里重复。下表是该批特有的补充项。

工程师不代跑这些，只提供命令与观察点。`npm run app:dev` 后逐条对照：

| 批次 | 条目 |
|---|---|
| 批 2 | B2-01、B2-02、B2-03、B2-04、B2-05、B2-06、B2-07、B2-08、B2-09、B2-10、B2-11、B2-12、B2-15、B2-17 |
| 批 3 | B3-02、B3-04、B3-06 |
| 批 4 | B4-01、B4-02、B4-03、B4-05、B4-07、B4-08、B4-09 |
| 批 5 | B5-02、B5-03、B5-04、B5-05、B5-09、B5-10 |
| 批 6 | B6-01、B6-03、B6-04、B6-07、B6-08、B6-11、B6-12、B6-13、B6-14、B6-16、B6-17 |
| 批 7 | B7-05 |
| 跨批 | S-07、S-08、S-09、S-10 |

**S-08 和 B6-16 是同一件事的两个侧面**（一个验连接链路、一个验恢复链路）。这两条通过，才算真的「AI 挂了也能用」。

---

## 13. 范围声明

- 本清单**不审代码风格**，不替代交叉 review。
- 不覆盖性能、无障碍、打包签名细节（另有 `docs/build-and-release.md`）。
- 文档仍在演化。每批开工前先看当天的 `docs/README.md`，确认引用的文档不在「存档」表里。

---

## 14. 这套流程仍然会漏的地方

如实列出，不粉饰。

1. **冒烟只覆盖首启 happy path。** 第二次启动、已配置状态、已连接后切配置、删除配置、断网恢复都没进 SM。建议每批再指定 1 条状态路径，轮换进来。
2. **人工冒烟会被跳过。** 五条要 10 分钟左右，改一行 CSS 也要跑完。规则写了「没人执行 = 没过」，但执行压力真实存在；连续三次因超时跳过，就应该拆成「快速三条 + 合入前五条」，而不是硬扛或睁一只眼。
3. **视觉回归没有自动基线。** 现行标准是本人真机看一眼，够用；但改动量大时，同一屏的前后差异靠人眼容易漏。将来再接像素 diff，现在不为它加流程。
4. **依赖外网与真实服务。** GitHub（内核）、DeepSeek（AI）、种子域名、真实节点，任一变红都会让冒烟失败。必须把「环境未就绪」和「产品缺陷」分开记，且都不能算通过。
5. **AI 是非确定性的。** SM-4 每次都可能不一样。短期用「连续两次一致」压住；长期应把结构断言（工具调用序列）放进 mock 剧本的自动测试，真机只验交互形态。
6. **崩溃只覆盖启动时。** 运行中崩溃、断开时崩溃、退出时崩溃都没覆盖。SM-1 只能抓「一启动就挂」这一类。
7. **Windows 完全没覆盖。** 同一种崩溃在 Windows 上可能是另一种表现。
8. **自动化到不了的两层。** 单测 / 契约 / 类型检查证明不了「进程能起来」和「控件能被发现」。中期可以给浏览器模式（Vite）加 Playwright 冒烟：首启页可达、Tab 顺序、输入框可输入；但 Tauri 命令链路仍然只能靠真机。
9. **冒烟会污染本机。** 会改系统代理、写数据库、留 webview 状态。没有复位步骤，第二次跑的前置就不成立——所以冒烟一节开头放了复位命令。
10. **清单会腐化。** 没有 owner 和「最后通过日期」，三周后没人知道哪条还作数。建议每条记录最后通过的日期与执行人。
