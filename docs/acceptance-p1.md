# P1 验收用例（本轮可执行）

> 版本：v1.0
> 日期：2026-11-02
> 执行：Clerk（用户现场观察）
> 上游：`docs/smoke-p1-macos.md`（缺陷与未验证项以它为准）、`docs/test-cases/README.md`（202 条用例索引）
> 本文档定位：**本轮照着做的验收清单**，不是测试计划

---

## 0. 怎么用这份文档

### 0.1 执行纪律（先读这一条）

**测试人员不得自行拉起任何进程。**

需要启动应用、dev server、预览服务、selftest、代理开关或任何会占用端口的命令时，**一律由用户本人执行**，测试人员只负责：

- 告诉用户要跑哪条命令
- 读取用户执行后的输出
- 观察界面现象
- 采集证据并判定

原因：这些命令会占用端口、修改系统代理、写入用户数据目录。测试机同时也是用户的工作机，进程冲突的代价由用户承担。

### 0.2 验收对象只有一个

| 项 | 值 |
|---|---|
| 唯一启动方式 | `./scripts/dev/dev-with-log.sh`（**由用户执行**） |
| 验收对象 | **Tauri 桌面窗口** |
| 端口 | 1430 |
| 进程 | `target/debug/veyl` |
| 窗口标题 | `Veyl` |

**浏览器页面不是验收对象。** `http://localhost:1430` 走的是 `MockAgentBridge`，不经过 Rust Host；任何号称在浏览器里完成的验收结论一律无效。旧的 aivpn / 1420 预览环境已经废弃，不作为验收依据。

### 0.3 两条通道，能力不同

| 通道 | 入口 | 经过 Rust Host | 能测什么 |
|---|---|---|---|
| **A. Tauri 窗口** | 用户用 `dev-with-log.sh` 启动的应用 | ✅ | 工具调用、落库、重启一致性 —— **本轮主战场** |
| **C. CLI selftest** | `cargo run --manifest-path src-tauri/Cargo.toml --bin veyl-runtime-selftest -- <cmd>`（**由用户执行**） | 只到 Runtime Manager | 下载/校验/启停/崩溃/代理 |

**判定纪律**：只有通道 A 的结论算「真实验收」。通道 C 不经过工具层与 UI，只能证明运行时本身没问题。证据里必须写明是哪条通道。

> 通道 B（浏览器）已从验收体系中移除，见 §0.2。

### 与已有的 202 条用例是什么关系

`docs/test-cases/` 是**需求级全集**，覆盖 FR-1 到 FR-9，其中大量是 U/I 层、要开发补单测。本轮只做**用户能亲手验证的那部分**：

- **复用**（直接照 `test-cases/` 里的步骤执行）：标了对应 TC 编号的用例
- **收敛**：把多条目合并成一条可执行验收
- **不重复**：U/I 层的单测不列进来，它们由 `cargo test` 88 项覆盖

本轮 **16 条验收 + 4 条准入检查**（审批相关的 7 条已移除，新增 2 条），其中自动 8 条、手工 8 条。

---

## 1. 环境与前置

| 项 | 值 |
|---|---|
| 数据目录 | `~/Library/Application Support/Veyl/` |
| 数据库 | `~/Library/Application Support/Veyl/veyl.db`（WAL） |
| 应用日志 | `build/logs/dev-<时间戳>.log`（用 `dev-with-log.sh` 启动时） |
| 运行时日志 | `~/Library/Application Support/Veyl/logs/runtime-<版本>.log` |
| dev 端口 | 1430（HMR 1431） |
| 可执行文件 | `src-tauri/target/debug/veyl` |

**开工前确认**（以下命令均由**用户执行**，测试人员只读结果）：

```bash
# 1. 数据库在位、8 张表、user_version=1
sqlite3 "$HOME/Library/Application Support/Veyl/veyl.db" ".tables"
sqlite3 "$HOME/Library/Application Support/Veyl/veyl.db" "PRAGMA user_version;"

# 2. 基线全绿（不占端口，但会编译与跑测试）
bash scripts/ci.sh --quick
```

任一不满足 → 停止验收，先报缺陷。

> `sqlite3` 查询只读数据库文件，测试人员可以自己跑；`ci.sh` / selftest / dev 脚本会启动进程，必须由用户执行——见 §0.1。

### 准入检查（三条，第 0 分钟做完）

这三条不通，后面几十条用例全是白做。**先跑它们，别急着往下翻。**

| ID | 检查 | 做法 | 不通的后果 |
|---|---|---|---|
| **P-1** | DeepSeek Key 能存 | 用户执行：在设置页输入任意 Key 保存。若返回 `UNSUPPORTED` / 「尚未接线」→ **停** | AC-B2 / B4 / C1 / C2 / C3 / F1 全部无效 |
| **P-2** | 工具调用能落库 | 在窗口里说「现在什么状态」，然后查 `SELECT COUNT(*) FROM tool_calls;` 应 ≥ 1。若为 0 → **停** | AC-N1 / N2 无法判定，且无法区分「逻辑错」和「根本没写」 |
| **P-3** | 对话能落库 | 发一句话后查 `SELECT COUNT(*) FROM chat_messages;` 应 ≥ 1。若为 0 → **停** | AC-F1 必红 |
| **P-4** | **二进制是新的** | 见下方命令。若二进制早于最新源码 → **先重建，不能拿旧二进制下结论** | D/E 组的全部结论作废 |

三条都不通时的处置：不是测试失败，是**被测功能未实现**。写进报告「准入未通过，验收无法开始」，不要硬跑后面的用例假装有结论。

### P-4：二进制新鲜度（这条是被一次真实乌龙逼出来的）

**2026-11-02 实例**：Clerk 17:21 跑 E1，用的是 16:57 构建的 `veyl-runtime-selftest`，而源码在 17:24–17:27 改过。结论对旧二进制成立，对当前代码不成立 —— 一条 FAIL 白报，一轮 PASS 白跑。

**执行任何 selftest / e2e 之前先跑这条**（只读，测试人员可直接执行）：

```bash
BIN=src-tauri/target/debug/veyl-runtime-selftest
STALE=$(find src-tauri/src -name '*.rs' -newer "$BIN" 2>/dev/null | head -3)
if [ -n "$STALE" ]; then
  echo "❌ 二进制过期，以下源码比它新："
  echo "$STALE"
else
  echo "✅ 二进制不早于源码"
fi
```

不满足 → 请用户重建（`cargo build --manifest-path src-tauri/Cargo.toml --bin veyl-runtime-selftest`），然后重跑这条确认。

**报告里必须写明二进制时间**。等 build.rs 注入构建戳之后，改用打印出来的构建时间，不再靠 mtime 推断 —— mtime 会因为 checkout、rsync、时钟漂移而不准。

> **D-01 的定性**：它是 HEAD（465c047）上的**真实缺陷**，不是误报。17:24–17:27 修复，当前构建重测 PASS。报告里请这么写，不要写成「作废」——「作废」会让后来的人以为当初的判断错了。

> 2026-11-02 已知：P-1 与 P-2、P-3 目前大概率不通 —— `tools/services.rs` 里 `save_deepseek_key` 还是 `not_wired`，`store/tool_calls.rs` 与 `chat_*` 没有调用点。等接线后重跑准入。

### 一条必须遵守的纪律

**每轮操作前记下时间戳**，`date +%H:%M:%S`。后面所有 SQL 都靠它过滤出「刚才那次操作」的记录，否则会和历史数据混在一起。

**注意时间列的单位**：库里存的是**毫秒**，取证 SQL 要写 `datetime(created_at/1000,'unixepoch')`。写成不除 1000 会**静默返回空**——不报错，只有一列空值。详见 §2 开头的警示。

---

## 2. 证据采集速查

```bash
DB="$HOME/Library/Application Support/Veyl/veyl.db"
```

> ⚠️ **时间列的单位：库里存毫秒，不是秒。**
>
> `tool_calls` / `chat_sessions` / `chat_messages` / `proxy_backup` / `runtime_versions` 的时间列都是 **Unix 毫秒**（`store/db.rs` 的 `now_ms()`）。契约对外给的是 ISO 8601 字符串，由 `iso_from_ms()` 在出口转换，已经处理好了。
>
> 但**取证 SQL 必须自己除 1000**：
>
> ```sql
> datetime(created_at/1000, 'unixepoch', 'localtime')   -- ✅
> datetime(created_at,      'unixepoch', 'localtime')   -- ❌ 把毫秒当秒
> ```
>
> **写错的表现是「静默返回空」**：SQLite 不报错，只是算出一个公元 5 万年的日期或 NULL。看到时间列是空，先怀疑单位，不要第一反应认为「字段没写」。
>
> 下面所有 SQL 都已按毫秒修正。

**最近 20 条工具调用**

```bash
sqlite3 -header -column "$DB" "
SELECT tool_name, approved, is_error,
       datetime(created_at/1000,'unixepoch','localtime') AS at
FROM tool_calls ORDER BY created_at DESC LIMIT 20;"
```

**`approved` 分布**（AC-N2 的核心证据：应只有 NULL）

```bash
sqlite3 -header -column "$DB" "
SELECT tool_name, COALESCE(approved,'NULL') AS approved, COUNT(*) AS n
FROM tool_calls GROUP BY 1,2 ORDER BY 1,2;"
```

**凭据泄漏自查**（必须恒为空）

```bash
sqlite3 "$DB" "SELECT id,name FROM profiles
WHERE config_json LIKE '%\"uuid\"%' OR config_json LIKE '%\"password\"%'
   OR config_json LIKE '%public_key%';"
```

**配置 / 运行时 / 代理**

```bash
sqlite3 -header -column "$DB" "SELECT id,name,protocol,region,is_active FROM profiles;"
sqlite3 -header -column "$DB" "SELECT version,state,datetime(installed_at/1000,'unixepoch','localtime') FROM runtime_versions;"
sqlite3 -header -column "$DB" "SELECT platform,endpoint,datetime(created_at/1000,'unixepoch','localtime') FROM proxy_backup;"
```

**会话落库**

```bash
sqlite3 -header -column "$DB" "
SELECT s.id, s.title, COUNT(m.id) AS msgs
FROM chat_sessions s LEFT JOIN chat_messages m ON m.session_id=s.id GROUP BY s.id;"
```

---

## 3. 用例总览

| ID | 名称 | 通道 | 方式 | 阻断 | 对应 TC |
|---|---|---|---|---|---|
| AC-B1 | 应用启动与窗口 | A | 手工 | 是 | TC-MAIN-001 |
| AC-B2 | 对话流式输出 | A | 手工 | 是 | TC-CHAT-001 |
| AC-B3 | 事件到达且无 `ai-` 前缀 | 脚本 | 半自动 | 是 | TC-CHAT-010~012 |
| AC-B4 | 工具卡渲染 | A | 手工 | 是 | TC-CHAT-002/007 |
| ~~AC-C1 / C2 / C3 / C5a~d~~ | ~~审批相关七条~~ | — | — | — | **已移除，见 §4.0** |
| AC-N1 | 无弹窗直接连接 | A+SQL | 手工 | 是 | 新增 |
| AC-N2 | `approved` 恒为 NULL（无残留审批写入） | SQL | 半自动 | 是 | 新增 |
| AC-F1 | 对话落库并重启恢复 | A+SQL | 手工 | 是 | TC-SHELL-005 |
| AC-F2 | 重启后运行时状态一致 | A+SQL | 手工 | 否 | — |
| AC-D1 | 下载 + SHA256 校验 | C | 自动 | 是 | TC-RT-004 |
| AC-D2 | 解压路径穿越被拒 | C | 自动 | 是 | TC-RT-005~008 |
| AC-D3 | 启动 → 停止 → 重启 | C | 自动 | 是 | TC-RT-011~013 |
| AC-D4 | 崩溃 → 退避重启 → failed | C | 自动 | 是 | TC-EXC-020/021 |
| AC-D5 | 配置生成过 `sing-box check` | C | 自动 | 是 | TC-CFG-001 |
| AC-D6 | Clash API 只监听回环 + secret 生效 | C | 自动 | 是 | TC-SEC-007 |
| AC-E1 | 系统代理设置与还原 | C+A | 自动+手工 | 是 | TC-PXY-003/006 |
| AC-E2 | 代理残留恢复 | C | 自动 | 是 | TC-PXY-013~015 |

---

## 4. 详细步骤

### AC-B1 应用启动与窗口

- **方式**：手工 ｜ **阻断**：是
- **前置**：用户已用 `./scripts/dev/dev-with-log.sh` 启动应用（**测试人员不自己启动**）
- **步骤**：
  1. 看窗口标题是否为 `Veyl`
  2. 看左侧会话区、中间对话区、右侧状态面板是否都在
  3. 状态面板显示：进程状态、版本、端口、出口
- **预期**：窗口标题 `Veyl`；三栏布局完整；状态面板有内容而不是空白/占位符
- **失败判定**：白屏、标题是 `AIVPN`、面板停在 loading
- **证据**：截屏 + `build/logs/dev-*.log` 里有无 `panic` / `error`
- **补充确认**（用户执行）：`pgrep -fl "target/debug/veyl"` 有进程、端口是 1430

---

### AC-B2 对话流式输出

- **方式**：手工 ｜ **阻断**：是
- **前置**：**在 Tauri 窗口内**（不是浏览器）；已配置 DeepSeek Key（设置页显示「已保存」）
- **步骤**：
  1. 输入「你好，介绍一下你自己」
  2. 观察回答是**逐段出现**还是一次性出现
- **预期**：文本增量出现；期间顶部状态行显示思考/输出状态；结束后 loading 解除
- **失败判定**：一次性整段出现（流式失效）、卡在 loading、回答为空
- **证据**：截屏（过程中+结束）+ `tool_calls` 表无新行（这一轮不该有工具调用）

---

### AC-B3 事件到达且无 `ai-` 前缀

- **方式**：半自动 ｜ **阻断**：是
- **说明**：这是只读静态检查，不启动服务、不占端口，测试人员可以直接跑
- **步骤**：

```bash
node tests/contracts/check-contracts.mjs
```

- **预期**：**退出码 0，且输出里没有 `FAIL`**
- **允许存在**：`contract_version` 那条 advisory 会打 `WARN`，**WARN 不算失败**
- **失败判定**：退出码非 0；或出现 `FAIL`；或有 `ai-message-chunk` 这类带前缀的事件名残留
- **证据**：命令完整输出 + `echo $?`
- **说明**：这条替代了原来手工数事件的步骤，脚本比人眼可靠

---

### AC-B4 工具卡渲染

- **方式**：手工 ｜ **阻断**：是
- **前置**：同 AC-B2
- **步骤**：
  1. 说「连到日本」
  2. 观察是否出现工具卡（名称 + 状态 + 耗时），点开能否看到参数
- **预期**：
  - 工具卡显示 `VpnConnect` / `CoreInstall` 等名字，状态从「运行中」变「成功/失败」
  - 参数预览里 `node_id` / `region` 可见，**没有** `uuid`、`password`、`key`
  - **不应出现任何确认卡**（审批已移除）
- **失败判定**：卡片不出现；参数里出现凭据；出现任何确认卡
- **证据**：截屏（卡片展开态）+ 对照 `docs/contracts/tools.md` §2.5

---

### 4.0 审批相关用例已移除（2026-11-02）

> **产品决策：彻底移除审批机制，所有工具默认放行。** 不是「默认放行但可开启」，是没有开关。
>
> 以下用例**不再执行**，也不判 FAIL、不作为缺陷：
> AC-C1（首次弹卡）、AC-C2（拒绝后仍弹）、AC-C3（`CoreInstall` 每次都弹）、
> AC-C5a~d（`approved` 四态）。
>
> 契约依据：`docs/contracts/tools.md` §2.1；历史用例见 `docs/test-cases/02-exception.md` §8。

### AC-N1 无弹窗直接连接

- **方式**：手工 + SQL ｜ **阻断**：是
- **前置**：DeepSeek Key 已配置；运行时已安装
- **步骤**：
  1. 在 Tauri 窗口输入「连到日本」
  2. 全程观察界面
  3. 记录时间戳
- **预期**：
  - **从头到尾不出现任何确认卡/权限卡/弹窗**
  - 工具卡正常出现（`CatalogSearch` → `ProfileImport` → `VpnConnect`）
  - 最终连上，状态面板显示 running
- **失败判定**：
  - 出现任何形式的确认卡 → 残留
  - 卡在「等待你的确认」状态 → 残留（有地方还在等一个不会来的决定）
  - 连接成功但界面上有一步没反应 → 可能有代码在等 `approval-requested`
- **证据**：

```sql
SELECT tool_name, COALESCE(approved,'NULL') AS approved,
       datetime(created_at/1000,'unixepoch','localtime') AS at
FROM tool_calls ORDER BY created_at DESC LIMIT 10;
```

预期：`approved` 全部为 `NULL`；每个工具**只有一条**记录（模型不再重试）。

### AC-N2 `approved` 无残留写入

- **方式**：SQL ｜ **阻断**：是 ｜ **半自动**
- **步骤**：跑完 AC-N1 后执行
- **预期**：

```sql
SELECT tool_name, COALESCE(approved,'NULL') AS approved, COUNT(*) AS n
FROM tool_calls GROUP BY 1,2 ORDER BY 1,2;
```

`approved` 列**只应出现 `NULL`**。

- **失败判定**：出现 `0` / `1` / `2` → **有旧路径还在写审批值**，是残留缺陷
- **证据**：上述查询输出

---

### AC-F1 对话落库并重启恢复

- **方式**：手工 + SQL ｜ **阻断**：是
- **步骤**：
  1. 在一个会话里完成 AC-N1 的对话，记下会话标题
  2. 完全退出应用（Cmd+Q，不是关窗口）
  3. 重新启动
  4. 看左侧会话列表里是否还有这个会话，点开看消息是否还在
- **预期**：会话标题、消息内容、工具卡都在；顺序正确
- **失败判定**：会话列表空了；或消息还在但工具卡丢了
- **证据**：

```bash
sqlite3 -header -column "$DB" "
SELECT s.id, s.title, COUNT(m.id) AS msgs, COUNT(t.id) AS calls
FROM chat_sessions s
LEFT JOIN chat_messages m ON m.session_id=s.id
LEFT JOIN tool_calls t ON t.session_id=s.id
GROUP BY s.id;"
```

---

### AC-F2 重启后运行时状态一致

- **方式**：手工 + SQL ｜ **阻断**：否
- **步骤**：
  1. 连上节点，确认状态面板显示「运行中」
  2. 完全退出 → 重启
  3. 看状态面板
- **预期**：状态恢复为之前的连接状态；`runtime_versions` 里对应版本仍是 `active`；不会出现「界面说连上了但进程不存在」
- **失败判定**：界面显示运行中但 `pgrep -f target/debug/sing-box` 为空；或状态面板回到 idle 但代理仍被设置
- **证据**：

```bash
sqlite3 -header -column "$DB" "SELECT version,state FROM runtime_versions;"
pgrep -fl "sing-box" || echo "无 sing-box 进程"
```

---

### AC-D1 下载 + SHA256

- **方式**：自动（**由用户执行命令**）
- **命令**（请用户执行）：

```bash
cargo run --manifest-path src-tauri/Cargo.toml --bin veyl-runtime-selftest -- e2e --data-dir /tmp/veyl-accept
```

- **预期**：`[2] download → sha256 → extract → install` 打印通过，最后 `E2E PASSED`
- **失败判定**：sha256 不匹配却继续安装；或没校验就跳过
- **证据**：完整输出（保存到 `build/logs/ac-d1.log`）

---

### AC-D2 解压路径穿越被拒

- **方式**：自动（**由用户执行命令**）
- **命令**（请用户执行）：

```bash
cargo test --manifest-path src-tauri/Cargo.toml archive
```

- **预期**：`rejects_parent_traversal` 等负向用例通过
- **失败判定**：测试不存在，或只有正向用例
- **证据**：测试输出
- **说明**：恶意归档不需要真的投递，单测覆盖了 `..` 与绝对路径两条

---

### AC-D3 启动 → 停止 → 重启

- **方式**：自动（**由用户执行命令**）
- **命令**（请用户执行）：同 AC-D1（`e2e`）
- **预期**：`[5] starting` → `state: running` → `[7] stopping` → `state: idle`；进程在结束后被清理干净
- **失败判定**：结束后 `pgrep -fl sing-box` 仍有残留
- **证据**：输出 + 结束后的 `pgrep`

---

### AC-D4 崩溃 → 退避重启 → failed

- **方式**：自动（**由用户执行命令**）
- **命令**（请用户执行）：

```bash
cargo run --manifest-path src-tauri/Cargo.toml --bin veyl-runtime-selftest -- fault --data-dir /tmp/veyl-fault
```

- **预期**：假 sing-box 提供 `/version` 后自杀，观察到 `running → crash → 退避重启 → 重试耗尽 → failed`，最后 `FAULT INJECTION PASSED`
- **失败判定**：无限重启；或崩溃后直接卡住不动
- **证据**：完整输出

---

### AC-D5 配置生成过 `sing-box check`

- **方式**：自动（**由用户执行命令**）
- **命令**（请用户执行）：同 AC-D1
- **预期**：`[3] building` → `[4] sing-box check → activate` 通过
- **失败判定**：跳过 check 直接启动
- **证据**：输出

---

### AC-D6 Clash API 只监听回环 + secret 生效

- **方式**：自动（**由用户执行命令**）｜ **阻断**：是
- **重要**：**不能在 e2e 跑完后直接 lsof** —— e2e 的第 7 步会 stop sing-box，那时已经没有监听，`lsof` 必然是空的。必须用 e2e 装好的 runtime 手动起一个再采证。

**步骤 1 —— 用户先跑一次 e2e**（同 AC-D1），确认输出里有：

```
[6] probing the clash api
    /version → 1.14.4
```

这证明「带 secret 能通」。

**步骤 2 —— 用户手动启动 sing-box 并保持运行**：

```bash
BIN=$(find /tmp/veyl-accept/runtime -name sing-box -type f | head -1)
"$BIN" run -c /tmp/veyl-accept/config/active.json &
echo $! > /tmp/veyl-accept/singbox.pid
```

**步骤 3 —— 采证**（这两条只读端口与本地 HTTP，测试人员可以直接跑；若用户更愿意自己跑也行）：

```bash
CFG=/tmp/veyl-accept/config/active.json
PORT=$(python3 -c "import json;print(json.load(open('$CFG'))['experimental']['clash_api']['external_controller'].split(':')[1])")
SECRET=$(python3 -c "import json;print(json.load(open('$CFG'))['experimental']['clash_api']['secret'])")

lsof -nP -iTCP -sTCP:LISTEN | grep sing-box
curl -s -o /dev/null -w '无secret: %{http_code}\n' "http://127.0.0.1:$PORT/version"
curl -s -o /dev/null -w '有secret: %{http_code}\n' -H "Authorization: Bearer $SECRET" "http://127.0.0.1:$PORT/version"
```

**步骤 4 —— 用户收尾**：

```bash
kill "$(cat /tmp/veyl-accept/singbox.pid)"
```

- **预期**：
  - `lsof` 显示 `127.0.0.1:<port>`，**不是** `0.0.0.0` 或 `*`
  - 无 secret → `401`
  - 有 secret → `200`
- **失败判定**：监听在 `0.0.0.0`；或无 secret 也能拿到 200
- **证据**：`lsof` 输出 + 两行 curl 状态码 + 用户确认已 kill

---

### AC-E1 系统代理设置与还原

- **方式**：自动 + 手工确认（**由用户执行命令**）
- **前置**：先记下当前系统代理设置（系统设置 → 网络 → 高级 → 代理）
- **命令**（请用户执行）：

```bash
cargo run --manifest-path src-tauri/Cargo.toml --bin veyl-runtime-selftest -- proxy-enable --port 2080 --data-dir /tmp/veyl-proxy
# 手工：打开系统设置确认 HTTP/HTTPS 代理指向 127.0.0.1:2080
cargo run --manifest-path src-tauri/Cargo.toml --bin veyl-runtime-selftest -- proxy-status --data-dir /tmp/veyl-proxy
cargo run --manifest-path src-tauri/Cargo.toml --bin veyl-runtime-selftest -- proxy-disable --data-dir /tmp/veyl-proxy
# 手工：确认系统代理已恢复成原来的值
```

- **预期**：enable 后系统代理生效；disable 后**恢复成开测前的值**，不是简单关闭
- **必须逐项比对**（这是 D-01 的判定点）：系统设置里 **Enabled 勾选框、Server、Port 三个值都要和开测前一致**。只看勾选框变灰是不够的 —— 勾选框关了但 Server 还留着 `127.0.0.1:2080`，就是缺陷
- **失败判定**：
  - disable 后变成「全部关闭」而不是恢复原值
  - 或勾选框已关，但 Server/Port 仍是我们写进去的值
- **证据**：每一步的系统设置截屏 + `proxy-status` 输出

> **证据来自哪份库**：`--data-dir /tmp/veyl-proxy` 会另建一份数据目录，`proxy-backup.json`（**连字符**，见 `src-tauri/src/proxy/backup.rs:77`）写在 `/tmp/veyl-proxy/` 下，**不在 App 的 `~/Library/Application Support/Veyl/`**。去 App 库查 `proxy_backup` 表查不到东西是正常的，不要误判为「备份没写」。

> ⚠️ 这条会真的改动用户的系统代理。**执行前先确认用户知道**，测完必须还原。

---

### AC-E2 代理残留恢复

- **方式**：自动（**由用户执行命令**）
- **步骤**（请用户依次执行）：

```bash
# 1. 设置代理但不还原，模拟异常退出
cargo run --manifest-path src-tauri/Cargo.toml --bin veyl-runtime-selftest -- proxy-enable --port 2080 --data-dir /tmp/veyl-proxy
# 2. 模拟下次启动时的恢复
cargo run --manifest-path src-tauri/Cargo.toml --bin veyl-runtime-selftest -- proxy-recover --data-dir /tmp/veyl-proxy
```

- **预期**：输出 `recovered from ...`，系统代理回到原值
- **失败判定**：输出 `nothing to recover`（备份没写）；或 `left alone` 但当前代理确实是我们的
- **证据**：两段输出 + 系统设置截屏 + `/tmp/veyl-proxy/` 下的备份文件

> 同 AC-E1：备份文件在 `/tmp/veyl-proxy/`，不在 App 数据目录。

---

## 5. 本轮测不了，以及为什么

| 项 | 原因 | 谁能解锁 |
|---|---|---|
| **`ProfileDelete` 行为** | UI 没有删除按钮；mock 剧本也没写这个工具。命令存在但无入口可点，模型也不会主动删配置 | Alice 补 UI 入口；在那之前标「无入口，未验证」 |
| **F1 删除 active profile 被拒** | 需要先有一个 active profile（要走 CatalogSearch → ProfileImport），依赖真实 Key + 可用目录 | 有真实节点后 |
| **E3 出口 IP 真实值** | mock 环境无真实出口；契约 FR-7.2 要求显示真实 IP | 需要真实节点 |
| **Hysteria2 连通性** | 无本地 Hysteria2 服务端 | Bob 起一个自签 TLS 的本地节点 |
| **9.5 首次连接成功率 ≥90%** | 需要真实用户样本 | W5 dogfood |

### 和 PM 预设的三处差异（重要）

PM 派单时说「D2/D4 无故障注入入口」，但实际代码里已经有了，请按本文档执行：

| 项 | PM 预设 | 实际情况 |
|---|---|---|
| **D4 崩溃恢复** | 无入口 | ✅ `veyl-runtime-selftest fault` 已实现，假 sing-box 自杀后走完整条重试链 |
| **D2 恶意归档** | 无入口 | ✅ `archive.rs` 有 `rejects_parent_traversal` 等负向单测，`cargo test archive` 可验 |
| **E3 系统代理** | 无入口 | ⚠️ 部分可测：`proxy-enable/disable/recover` 能验控制器与备份恢复，但**不经过 UI**，UI 那一层仍需手工 |

D2 不需要真的投递恶意归档：单测已经覆盖 `..` 与绝对路径两条，比手工造包更可靠。

---

## 6. 放行标准

| 条件 | 要求 |
|---|---|
| 阻断级用例 | AC-B1~B4、AC-N1、AC-N2、AC-F1、AC-D1~D6、AC-E1/E2 **全部通过** |
| 条件级 | AC-F2 允许失败，但必须记录现象 |
| 数据完整性 | §2「凭据泄漏自查」恒为空 |
| 无残留审批 | `SELECT approved FROM tool_calls` 只能出现 `NULL`；出现 `0/1/2` 即为残留缺陷 |
| 证据 | 每条用例都有：时间戳 + SQL 输出或截屏 + 通道标注（A/C）；命令类用例注明「由用户执行」 |

任一条阻断级失败 → **不进下一阶段**，写缺陷单（现象 / 复现 / 归属 / 阻断等级）。

---

## 7. 执行时容易踩的三个坑

1. **不记时间戳**。所有 SQL 都是全表查询，不按时间过滤会看到历史数据，误判成 PASS。
2. **用浏览器页面当验收对象**。浏览器走 mock，Host 的 Grant 根本没参与，也不存在「1430 页面 = 验收对象」这回事。验收只认 Tauri 窗口。旧的 aivpn / 1420 环境更不能作为依据。
3. **测 E1/E2 忘了还原系统代理**。这两个用例真的会改用户的网络设置，测完不还原会影响用户正常上网。

另外：**任何进程都不要自己拉起来**。要跑命令就请用户执行，你只读输出、看现象、采证据。自己起的进程会和用户正在用的应用抢端口、抢数据目录，结论也不可信。
