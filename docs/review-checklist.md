# 验收清单（Review Checklist）

> 日期：2026-11-03
> 用途：每批开发完成、交叉 review 时逐条对照。**只验行为与契约，不替代 code review。**
> 依据：`implementation-plan.md`（分批）、`capabilities.md`（能力与三条硬规则）、`center-panel.md` §2.1 / §2.5.1、`configs-and-nav.md`、`config-execution.md`、`tun-mode.md`、`issue-management.md`
> 状态：清单先于代码。代码还没写，所以这里给的全是**可观察的判定条件**，不是对现有实现的结论。

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

1. §1 通用门禁（G）全部通过；
2. 该批条目中**没有 P0 / P1**；
3. 该批涉及的跨批专项（§2 的 S 条）通过。

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
| B2-06 | 切换按钮的禁用条件 | 界面：选中当前节点；再选另一个 | 选中 = 当前时禁用；不同时可用 |
| B2-07 | 测试连通始终可点 | 界面：未连接、已连接、断网三种情况各点一次 | 都能点并给出结果；走 D6 / `node_probe`，不启动运行时也能测；失败说清原因，不是「失败」两个字 |
| B2-08 | **全程不依赖 AI** | 界面：断网 + 清空 LLM key，用已缓存种子 | 新建配置 → 连接 → 换节点 → 断开，四步都成功（`implementation-plan.md` 批 2 完成标准） |
| B2-09 | 中间空态不是纯白 | 界面：首启 0–20s，AI 还没输出 | 有一行说明，不是空白（`center-panel.md` §4 末段） |
| B2-10 | 切配置不静默 | 界面：已连接时点左栏另一套配置 | 先提示会断开一次并自动重连，确认后才切（`configs-and-nav.md` §6） |
| B2-11 | 删配置有二次确认 | 界面：删一套配置（含默认配置） | 确认框写清会删掉什么；删完回空态且能重建 |
| B2-12 | 换配置后中间重新编排 | 界面：从「本机代理」切到「接管全部」 | 代理卡消失，不残留旧配置的块；AI 不可用时也不报错，只按本地规则渲染骨架（`configs-and-nav.md` §9） |
| B2-13 | 端口显示实际值 | 自动 + 界面：先占用默认端口再启动；`grep -rn "7890" src --include="*.tsx"` | 硬编码 0 处；端口被占用时自动顺延且界面显示真实端口（A5） |
| B2-14 | 骨架层无禁止词 | 自动：G-07 | 见 G-07 |

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

### 10.2 仍待处理

**验收时遇到 OPEN 项按「未通过」处理，不要自己解释成通过。**

| 编号 | 冲突 | 两边说法 | 影响 | 建议 |
|---|---|---|---|---|
| OPEN-03 | `capabilities.md` 的命令名是旧的 | B2 写 `runtime_start(profile_id)`、B3 `profile_delete`、B4 `import_seed_file`、C1/C2 `default_profile_refresh`；批 1 换成了 `config_*` / `node_*` | G-03 / G-04 会把能力表判成不一致 | 已转架构师，批 0 处理。`contracts/commands.md` §2 已声明「`invoke_handler` 是唯一事实来源」，按它为准 |
| OPEN-05 | 问题状态与严重度词汇不一致 | 文档：`open/handed_off/resolved/ignored`、`P0/P1/P2`；当前 schema：`open/resolved/dismissed`、`info/warning/error` | 转交后回看、卡片分级都可能错 | 已转架构师，批 0 处理；库以文档为准 |
| OPEN-06 | 配置模型缺 DNS 与内网排除 | `configs-and-nav.md` §3 把 DNS、内网排除列为一套配置的组成部分；`001_init.sql` 的 `configs` 没有对应列/表 | B1-02 判失败 | 已转架构师，批 0 处理；明确用 JSON 列还是子表承载，并写进 DDL 注释 |

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

---

## 12. 需要产品负责人执行的界面项

工程师不代跑这些，只提供命令与观察点。`npm run app:dev` 后逐条对照：

| 批次 | 条目 |
|---|---|
| 批 2 | B2-01、B2-02、B2-03、B2-04、B2-05、B2-06、B2-07、B2-08、B2-09、B2-10、B2-11、B2-12 |
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
