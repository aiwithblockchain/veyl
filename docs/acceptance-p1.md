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
| 数据目录 | `~/.veyl/` |
| 数据库 | `~/.veyl/veyl.db`（WAL） |
| 应用日志 | `build/logs/dev-<时间戳>.log`（用 `dev-with-log.sh` 启动时） |
| 运行时日志 | `~/.veyl/logs/runtime-<版本>.log` |
| dev 端口 | 1430（HMR 1431） |
| 可执行文件 | `src-tauri/target/debug/veyl` |

**开工前确认**（以下命令均由**用户执行**，测试人员只读结果）：

```bash
# 1. 数据库在位、8 张表、user_version=1
sqlite3 "$HOME/.veyl/veyl.db" ".tables"
sqlite3 "$HOME/.veyl/veyl.db" "PRAGMA user_version;"

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
DB="$HOME/.veyl/veyl.db"
```

> ⚠️ **时间列的单位：库里存毫秒，不是秒。**
>
> `tool_calls` / `chat_sessions` / `chat_messages` / `proxy_backup` / `runtime_versions` 的时间列都是 **Unix 毫秒**（`store/db.rs` 的 `now_ms()`）。契约对外给的是 ISO 8601 字符串，由 `iso_from_ms()` 在出口转换，已经处理好了。
>
> 历史提示：`runtime_versions.installed_at` 在 2026-11-02 之前用的是**秒**，与其它表不一致，已由迁移统一为毫秒。**如果你的数据目录是迁移前创建的**，跑验收前先确认迁移跑过（`PRAGMA user_version`），否则那一列除 1000 会算成 1970 年。
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
| **AC-G1** | 导入真实节点（拖放 / 选择文件） | A+SQL | 手工 | 是 | 新增（N-03） |
| AC-G2 | 连接后系统代理生效 | A+C | 手工+命令 | 是 | TC-PXY-003 |
| AC-G3 | **真实出口 IP 变化** | C | 手工+命令 | 是 | FR-7.2 / 新增 |
| AC-G4 | 断开后出口与代理还原 | A+C | 手工+命令 | 是 | TC-PXY-006 |
| AC-G5 | 连接后返回真实 `exit_ip`（D-20 复测） | A+SQL | 手工 | 是 | 新增（D-20） |
| AC-G6 | 不断开直接切换节点 | A+C | 手工+命令 | 是 | 新增（D-36） |
| AC-H1 | 二进制来源记录（含未提交改动） | 静态 | 半自动 | 是 | P-4 |
| AC-H2 | `runtime.pid` 落盘且与进程一致 | C | 手工 | 是 | 新增（D-17） |
| AC-H3 | 强杀重启后回收遗留进程 | A+C | 手工 | 是 | TC-EXC-019 / D-17 |
| AC-H4 | 回收后可再次连接 | A | 手工 | 否 | — |
| AC-S1 | 提交前敏感信息扫描 | 脚本 | 自动 | 是 | 新增（发布门禁） |

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

> **证据来自哪份库**：`--data-dir /tmp/veyl-proxy` 会另建一份数据目录，`proxy-backup.json`（**连字符**，见 `src-tauri/src/proxy/backup.rs:77`）写在 `/tmp/veyl-proxy/` 下，**不在 App 的 `~/.veyl/`**。去 App 库查 `proxy_backup` 表查不到东西是正常的，不要误判为「备份没写」。

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
| **F1 删除 active profile 被拒** | 需要先有一个 active profile（要走 CatalogSearch → ProfileImport），依赖真实 Key + 可用目录 | **AC-G1 之后可测**（种子导入会生成 2 个真实 profile） |
| **E3 出口 IP 真实值** | mock 环境无真实出口；契约 FR-7.2 要求显示真实 IP | **由用例组 G 覆盖**（AC-G3） |
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
| 阻断级用例 | AC-B1~B4、AC-N1、AC-N2、AC-F1、AC-D1~D6、AC-E1/E2、**AC-G0~G3、AC-G5、AC-S1** **全部通过** |
| 条件级 | AC-F2 允许失败，但必须记录现象（D-17 属此类） |
| 数据完整性 | §2「凭据泄漏自查」恒为空 |
| 无残留审批 | `SELECT approved FROM tool_calls` 只能出现 `NULL`；出现 `0/1/2` 即为残留缺陷 |
| **仓库卫生** | **AC-S1 扫描通过，且自检能报错** —— 与功能验收同等强制 |
| 证据 | 每条用例都有：时间戳 + SQL 输出或截屏 + 通道标注（A/C）；命令类用例注明「由用户执行」 |

任一条阻断级失败 → **不进下一阶段**，写缺陷单（现象 / 复现 / 归属 / 阻断等级）。

---

## 7. 执行时容易踩的三个坑

1. **不记时间戳**。所有 SQL 都是全表查询，不按时间过滤会看到历史数据，误判成 PASS。
2. **用浏览器页面当验收对象**。浏览器走 mock，Host 的 Grant 根本没参与，也不存在「1430 页面 = 验收对象」这回事。验收只认 Tauri 窗口。旧的 aivpn / 1420 环境更不能作为依据。
3. **测 E1/E2 忘了还原系统代理**。这两个用例真的会改用户的网络设置，测完不还原会影响用户正常上网。

另外：**UI 操作由用户完成**（拖拽、点按钮、在对话里下指令）。命令由测试人员执行 —— 2026-11-02 用户已明确授权「这些命令你都能执行」，不再需要逐条转交。**破坏性命令**（`kill -9`、改系统代理、删配置）仍须用户确认后再执行。

---

## 8. 用例组 G：真实网络验证

> **这一组是 P1 唯一一次「真上网」的验证。**
> 此前所有「连接成功」的证据，节点 `server` 都是 `127.0.0.1`（见 `acceptance-p1-report.md` §8.1），只能证明控制面通，不能证明流量真的出去了。
>
> **前置（缺一不可）**：
> 1. P-5 满足：无 MeshFlux、无遗留 sing-box、系统代理三项 `Enable=0`
> 2. 已现场采集**直连基线 IP**（双路径交叉确认，见 AC-G0）
> 3. 种子文件在本地、不在仓库内
>
> **安全纪律**：种子文件的 server / 密码 / method **不得**出现在报告、日志、截图、聊天或提交里。所有 SQL 只 `json_extract` 指定字段，**禁止 `select config_json`**。

### AC-G0 环境前置与基线（在任何连接之前做）

- **方式**：手工 + 命令 ｜ **阻断**：是
- **命令**：

```bash
pgrep -fl -i meshflux || echo "无 MeshFlux"
pgrep -fl 'sing-box run' || echo "无 sing-box"
scutil --proxy | grep -E 'Enable|Proxy|Port'
```

- **预期**：无 MeshFlux、无 sing-box；`HTTPEnable=0`、`HTTPSEnable=0`、`SOCKSEnable=0`（`scutil --proxy` 的实际字段名）
- **采集基线**（两条独立路径，必须一致）：

```bash
curl -s --noproxy '*' https://ifconfig.me/ip
dig +short myip.opendns.com @resolver1.opendns.com
```

- **预期**：两条输出同一个公网 IP
- **禁止**：用 `api.ipify.org` 做判据 —— 本网络下不可用，会得到超时并误判成「出口变了」
- **基线（已记死，2026-11-02 20:39 测试 Clerk 独立复核）**：
  - 无 MeshFlux、无 sing-box
  - 系统代理 `HTTPEnable=0` / `HTTPSEnable=0` / `SOCKSEnable=0`
  - 直连出口 **（已脱敏，两路一致）**
  - **任何一步看到出口 IP 等于这个值，就是没走代理**
- **证据**：时间戳 + 两条命令的原始输出

> 该 IP 是**采集时点**的公网出口，可能随网络环境变化。执行 G 组时若实测基线与之不同，以**现场实测值**为准，并在执行记录里注明差异。

> ⚠️ **方法学：curl 不读 macOS 系统代理。**
> `curl` 只认 `http_proxy` / `https_proxy` 环境变量、`~/.curlrc` 的 `proxy=`，或显式 `--proxy`；`scutil --proxy` 里写什么都不影响它。
> 因此「连上后裸 curl 看 IP 变没变」**永远是假的** —— 不管代理是否生效，裸 curl 都走直连。
>
> **「系统代理已生效」只能由两条证据合并支撑**：
> 1. `scutil --proxy` / `networksetup` 的配置值（证明写进去了）
> 2. 显式 `--proxy` 的出网结果（证明链路通）
>
> 缺任何一条都不成立。若历史上曾用裸 curl 得出过「代理生效」，那个结论**无效**，需一并标注。

---

### AC-G1 导入种子文件（拖放 / 选择文件，两条入口）

- **方式**：手工（用户操作 UI） ｜ **阻断**：是
- **两条入口都要验**（同一实现，缺一条不判通过）：
  - **A 拖放**：把种子 JSON **拖进**设置页投放区
  - **B 选择文件**：点「选择文件」按钮，在系统文件选择器里选中同一个 JSON
- **步骤**：
  1. 打开设置页
  2. 走入口 A，读界面提示
  3. 清空或换一份数据，再走入口 B，读界面提示
  4. 再点一次「选择文件」，**在系统对话框里点取消**
  5. 确认取消后**没有任何变化**（不弹错误、不新增记录）
- **预期**：
  - A、B 都提示「已导入 2 个节点」（或等义文案），不是失败提示；界面不崩溃；页面不刷新丢状态
  - **取消返回 `null` 时不触发导入** —— 不能把 `null` 当路径传下去
- **失败判定**：无任何反馈；或提示成功但库中无新增；或整页卡死；**或取消后仍触发了一次导入 / 弹出一条报错**
- **证据**：

```bash
sqlite3 -header -column "$DB" "
SELECT id, name, protocol,
       json_extract(config_json,'$.server')      AS server,
       json_extract(config_json,'$.server_port') AS port,
       node_id
FROM profiles;"
```

- **断言**：
  - 新增 **2 条** 记录，`protocol = shadowsocks`
  - 两条 `server` 均 **不等于** `127.0.0.1`
  - 两条 `node_id` 为 `NULL`（种子导入不挂目录节点）
- **同时记录**（不打印值）：`config_json` 中**不得**出现 `"password"` 字段

```bash
sqlite3 "$DB" "SELECT COUNT(*) FROM profiles WHERE config_json LIKE '%\"password\"%';"
```

> 预期 `0`。若大于 0，立刻停止并上报 —— 凭据落进了配置文件。

---

### AC-G2 连接后系统代理生效

- **方式**：手工 + 命令 ｜ **阻断**：是
- **步骤**：
  1. 在对话里让它连接 **美国主节点**（用节点名或 `ProfileList` 拿到的 id）
  2. 观察是否直接执行、无确认卡
  3. 立即读系统代理
- **预期**：对话区显示连接成功；状态面板「运行中」
- **证据**：

```bash
scutil --proxy
networksetup -getwebproxy Wi-Fi
networksetup -getsecurewebproxy Wi-Fi
networksetup -getsocksfirewallproxy Wi-Fi
```

- **断言**（这一步验的是「应用有没有把配置写进系统」）：
  - `HTTPEnable=1`，`HTTPProxy=127.0.0.1`，`HTTPPort` 在 1024–65535 之间（随机端口）
  - `HTTPSEnable=1`，指向**同一个端口**
  - SOCKS：**记录实际值**。当前实现（`src-tauri/src/proxy/macos.rs`）对 HTTP / HTTPS / SOCKS 三种都设置与还原，预期同为 `Yes`；但以实测为准，不一致时先记录、不直接判失败
- **失败判定**：HTTP 或 HTTPS 开关仍为 0；或两者端口不一致
- **注意**：本用例**只验配置写入**，不验流量。流量由 AC-G3 单独验证 —— 这两件事不能互相替代
- **记下端口**，AC-G3 要用

> `awk` 解析 `scutil --proxy` 容易误命中 `Authenticated Proxy Enabled`。用 `grep` 定位字段名，不要用宽泛的 `Enabled` 匹配。

---

### AC-G3 真实出口 IP 变化（本组核心）

- **方式**：命令 ｜ **阻断**：是
- **前置**：AC-G2 已确认代理配置写入系统
- **正向（走代理出网）**：

```bash
PORT=$(scutil --proxy | awk '/HTTPPort/{print $3}')
echo "代理端口=${PORT}"
curl -sS --max-time 15 --proxy "http://127.0.0.1:${PORT}" https://ifconfig.me/ip
curl -sS --max-time 15 --proxy "http://127.0.0.1:${PORT}" https://www.cloudflare.com/cdn-cgi/trace | grep '^ip='
```

- **反向（强制直连）**：

```bash
curl -sS --max-time 15 --noproxy '*' https://ifconfig.me/ip
```

- **预期**：
  - 正向两条路径得到**同一个**出口 IP
  - 该 IP **不等于直连基线出口**
  - 反向直连仍得到直连基线出口
  - **两步 IP 不同，才算「代理改变了出口」** —— 只做正向不足以排除「直连返回了同一个 IP」的巧合
- **追加断言（地区）**：若需确认是「美国」，用 `curl -sS --proxy "http://127.0.0.1:${PORT}" https://ipinfo.io/json` 读 `country`。**该服务不可达时，地区断言降级为「未验证」，不得用「IP 变了」代替「是美国的 IP」**。
- **失败判定**：
  - 正向 IP 等于基线 → **流量没走代理**。先按 AC-G2 复查端口，再查 sing-box 日志
  - 正向出口是 `127.0.0.1` / 内网地址 → 配置错误
  - 正反向 IP 相同 → 代理未生效，或 `--proxy` 端口取错
  - 通过代理 curl 超时 → 节点不可达，记 `node_unreachable`，换第二节点重试一次
- **必须区分**：不带 `--proxy` 的 `curl` 拿到的是**本机出口**，不是隧道出口。用它当「代理生效」的证据是错的，见 AC-G0 的方法学说明。

---

### AC-G4 断开后出口与代理还原

- **方式**：手工 + 命令 ｜ **阻断**：是
- **步骤**：
  1. 对话里断开
  2. 立刻读代理与出口
- **证据**：

```bash
scutil --proxy | grep -E 'Enable|Proxy|Port'
curl -s --noproxy '*' https://ifconfig.me/ip
pgrep -fl 'sing-box run' || echo "无 sing-box"
```

- **断言**：
  - 三项 `Enable=0`
  - 出口 IP 回到 AC-G0 基线
  - sing-box 进程已退出
  - **三者一致**：不能出现「代理关了、进程还在」或「代理还开着、进程没了」
- **清理**：若本用例失败且代理仍指向本地端口，**先手工还原**再继续，否则用户会断网：

```bash
networksetup -setwebproxystate Wi-Fi off
networksetup -setsecurewebproxystate Wi-Fi off
networksetup -setsocksfirewallproxystate Wi-Fi off
```

---

### AC-G5 连接后返回真实 `exit_ip`（D-20 复测）

- **方式**：手工 + SQL ｜ **阻断**：是（交付内测前必须修好）
- **背景**：D-20 —— `set_exit_ip` 全项目零调用，`HealthSnapshot.exit_ip` 恒为 `None`，`VpnConnect` 返回「已连接，出口 IP 未知。」。隧道实际是通的，但应用不会报告出口。
- **前置**：已修复合入，且应用已重新构建启动（按 AC-H1 记录二进制来源）；已连上真实节点
- **步骤**：
  1. 连接后，在对话里让它报告当前出口 IP（触发 `RuntimeStatus`）
  2. 记录 `VpnConnect` 与 `RuntimeStatus` 的返回
  3. 用命令独立测一次真实出口作为对照
  4. 断开，再查一次
- **命令**：

```bash
DB="$HOME/.veyl/veyl.db"
sqlite3 "$DB" "SELECT result_json FROM tool_calls WHERE tool_name='VpnConnect'     ORDER BY created_at DESC LIMIT 1;"
sqlite3 "$DB" "SELECT result_json FROM tool_calls WHERE tool_name='RuntimeStatus'  ORDER BY created_at DESC LIMIT 1;"

PORT=$(scutil --proxy | awk '/HTTPPort/{print $3}')
curl -sS --max-time 15 --proxy "http://127.0.0.1:${PORT}" https://ifconfig.me/ip
```

- **断言**：
  - `VpnConnect` 的 `content` **不再含**「出口 IP 未知」
  - `RuntimeStatus` 返回的 `exit_ip` **非 null**，是一个公网 IPv4
  - 该值与 `curl --proxy` 实测出口**完全一致**
  - **断开后** `exit_ip` 回到 `null` —— 不得残留上一次连接的地址（否则用户断网后仍看到旧出口，等于说谎）
- **失败判定**：
  - 仍显示「未知」→ D-20 未修复
  - 显示了 IP 但与 `curl --proxy` 不一致 → 更严重：显示的是**猜的**或**错的**地址，比不显示更有害
  - 断开后仍显示旧 IP → 状态未清理
- **证据**：三条 SQL/命令输出 + 对话截图

> **报告写法**：结论里只写「与经代理出口一致」，**不写 IP 字面值** —— Shadowsocks 的出口 IP 就是节点服务器地址，写进仓库等于公开节点地址。

> **为什么这条是阻断**：出口 IP 是用户唯一能在应用内自证「代理确实生效」的手段。没有它，用户只能相信界面上的「已连接」四个字 —— 而 D-17 已经证明过，「已连接」和后台真实状态可能不一致。

---

### AC-G6 不断开直接切换节点

- **方式**：手工 + 命令 ｜ **阻断**：是
- **背景**：D-36 —— 修复前，切换后工具仍报告「已连接」，但运行时没真的换过去，**提示成功、网络是断的**。
- **前置**：已连接节点 A，系统代理生效
- **步骤**：
  1. 在对话里**直接**让它连节点 B（不先说断开）
  2. 等返回后立即检查进程、端口、代理与配置目录
- **命令**：

```bash
PID=$(pgrep -f 'sing-box run' | head -1)
echo "pid=$PID"; ps -o lstart= -p "$PID"
lsof -nP -iTCP -sTCP:LISTEN -a -p "$PID" | awk 'NR>1{print $9}'
scutil --proxy | grep -E 'HTTPEnable|HTTPPort'
ls -1 "$HOME/.veyl/config"
python3 -c "import json,os;print(json.load(open(os.path.expanduser('~/.veyl/runtime.pid'))))"
```

- **断言**：
  - 两次 `VpnConnect` 返回的出口**不同**（比较返回值，不必记录地址）
  - sing-box **pid 变了**，启动时间对应第二次连接
  - **系统代理端口 = 新进程 `mixed` 监听端口** —— 这是最关键的一条
  - `config/` 只剩 B 的 json 与 meta，**A 的已删除**
  - `runtime.pid` 的 pid 与运行进程一致，`started_at` 为 13 位
- **失败判定**：
  - 出口没变 → 没真的换
  - **代理端口与新进程监听不一致** → 报告与现实脱节，等于 D-36 复发
  - A 的配置仍在 → D-27 复发
- **证据**：上述命令输出 + 两次 `VpnConnect` 的返回（不含地址字面值）

---

### 注意：切换失败的预期行为（不要记成缺陷）

不经断开、直接从 A 连 B 时，A 的明文配置会在渲染 B **之前**被删除。若 B 在启动前失败（目录不可达等）：

- A 的 sing-box 可能**仍在运行**（配置已载入内存），但磁盘上的配置已不存在
- A 若随后崩溃触发自动重启，会因配置缺失而失败
- **用户需要手动重连 A**

这是为「明文密码立即消失」付出的代价，属于**设计内行为**（报告 §10 #9）。实测时按「预期行为」记录，不要写成缺陷。

判断依据：`matches_launch` 只比对 `runtime.pid` 里的路径字符串与进程 argv，不检查文件是否存在 —— 所以即使配置已删，遗留进程仍能被正常回收。

---

## 9. 用例组 H：AC-F2 复测（重启后进程回收）

> 背景：D-17 —— 重启后系统代理被正确还原，但 sing-box 进程仍在跑。两者不一致，用户既上不了代理，后台还占着端口。
> 修好之前 AC-F2 判 FAIL。本组重跑该判定。
>
> **平台范围**：本组**只在 macOS 上判定**。Windows 上 `reclaim_stale` 取不到完整命令行，会一律跳过回收（报告 §10 #6），AC-H3 在 Windows 上必然失败 —— 那是**已知未实现**，不计为本轮新缺陷，完整回收列为 P2。

### AC-H1 二进制来源记录

- **方式**：静态 ｜ **阻断**：是
- **命令**：

```bash
git rev-parse --short HEAD
git status --porcelain | wc -l
stat -f '%Sm' -t '%F %T' src-tauri/target/debug/veyl
```

- **记录格式**：`HEAD=<sha> + 未提交改动 <n> 个，二进制构建于 <时间>`
- **规则**：二进制可以**新于** HEAD（从工作区构建），但必须写明「包含未提交改动」。结论只对**该工作区**成立，**不能**写成「HEAD 通过」。
- **证据**：三行原始输出

---

### AC-H2 `runtime.pid` 落盘且与真实进程一致

- **方式**：手工 + 命令 ｜ **阻断**：是
- **步骤**：连上节点，等状态显示「运行中」
- **命令**：

```bash
PIDFILE="$HOME/.veyl/runtime.pid"
cat "$PIDFILE" 2>/dev/null || echo "runtime.pid 不存在"
pgrep -fl 'sing-box run'
ps -o pid=,comm= -p "$(cat "$PIDFILE")" 2>/dev/null
```

- **断言**：
  - `runtime.pid` **存在**
  - 文件里的 pid **等于** `pgrep -f 'sing-box run'` 的 pid
  - `ps` 能查到该进程，且 `comm` 是 `sing-box`
- **失败判定**：文件不存在；或两处 pid 不一致
- **为什么必须先验这条**：没有持久化 pid，重启后**根本无法**知道该回收谁。H3 若失败，先回来看这里。

---

### AC-H3 强杀 → 重启 → 遗留进程被回收

- **方式**：手工 + 命令 ｜ **阻断**：是
- **步骤**：
  1. 记下应用 pid 与 sing-box pid
  2. **`kill -9` 应用**（模拟崩溃）
  3. 确认 sing-box **仍活着**（这是正常现象，孤儿进程）
  4. 用户重新启动应用
  5. 立刻检查
- **命令**：

```bash
pgrep -fl 'target/debug/veyl'            # 应用 pid
pgrep -fl 'sing-box run'                 # 记下，记作 SB
kill -9 <应用 pid>
sleep 2
pgrep -fl 'sing-box run'                 # 应为 SB —— 孤儿
```

- **重启后**：

```bash
pgrep -fl 'sing-box run' || echo "无 sing-box 进程"
cat "$HOME/.veyl/runtime.pid" 2>/dev/null || echo "runtime.pid 已清"
scutil --proxy | grep -E 'HTTPEnable|HTTPProxy|HTTPPort'
```

- **断言**：
  - `pgrep` **为空** —— 遗留进程已被回收
  - `runtime.pid` **已被清除**
  - 系统代理**已回到关闭**
  - 应用日志中有一条回收记录（写明被回收的 pid）
- **失败判定**：
  - 进程还在 → **D-17 未修复**，AC-F2 继续 FAIL
  - （Windows：即便代码正确也会因取不到命令行而跳过回收，属已知未实现，按平台范围说明处理）
  - 进程没了但端口仍被占用 → 换了进程占用，另记缺陷
- **⚠️ 不要用 Cmd+Q**：优雅退出会走 `kill_child()`，测不到「崩溃后回收」这条路径。要测的是**进程没有机会清理自己**的情况。

#### 附：PID 复用风险（建议断言，非 P1 阻断）

重启时若 `runtime.pid` 里的 pid 已被系统分配给**别的**进程，盲杀会杀掉无关程序。正确做法是先校验进程身份（`comm` 是否为 `sing-box`、是否带我们的配置路径）再终止；校验不过就只清 pid 文件、不动进程。

验证方式：手工把 `runtime.pid` 写成一个现存无关进程（如当前 shell）的 pid，重启应用，确认该进程**没有被杀**。这一条不影响 P1 放行，但属于「回收」功能的安全边界，建议一并验。

---

### AC-H4 回收之后能再次连接

- **方式**：手工 ｜ **阻断**：否
- **步骤**：在 AC-H3 重启后的应用里，再让它连一次同一节点
- **预期**：连接成功；新的 sing-box pid 与旧的**不同**；系统代理重新生效；`runtime.pid` 写回新 pid
- **失败判定**：报端口占用 / `port_in_use` —— 说明回收只杀了进程、没释放端口，或回收发生在端口探测之后
- **证据**：连接结果截图 + `pgrep -fl 'sing-box run'` + `runtime.pid` 内容

---

## 10. 这一组的执行纪律

1. **UI 操作由用户完成**，命令由测试人员执行，只读输出、看现象、采证据。H3 的 `kill -9` 属于破坏性操作，**用户确认后**再执行 —— 强杀会丢掉当前会话的未保存状态。
2. **每次改网络设置的用例，测完必须核对已还原**。G4 结束前不要离开。
3. **不要 `select config_json`**。要验证凭据不在配置里，用字段存在性查询（见 AC-G1）。
4. **每步都记时间戳**。这一组涉及进程与代理，事后无法从最终状态反推中间过程。

---

## 11. 发布门禁：AC-S1 提交前敏感信息扫描

- **方式**：脚本 ｜ **阻断**：是（**发布前强制门禁**，不是建议项）
- **实现状态**：`scripts/test/secret-scan.sh` 已创建并跑通（2026-11-02）。当前工作区扫描 **0 命中**；自检失败时 `exit 2` 已实测验证。

> **与 `scripts/check-secrets.sh` 的分工（已定稿，不合并）**：
>
> | 脚本 | 查什么 | 对应的失效模式 |
> |---|---|---|
> | `scripts/check-secrets.sh` | **凭据文件形态**：`*.key` / `*.p12` / `*.env` 文件名、私钥块、`sk-` 令牌、许可证密钥串 | 「不该进仓库的文件进来了」 |
> | `scripts/test/secret-scan.sh` | **信息泄漏**：公网 IP、用户绝对路径、节点 id、凭据指纹 | 「该保密的值写进了正文」 |
>
> 两者在 `scripts/ci.sh` 中**各自独占一步**（第 1、第 2 步），都是硬失败。
> 不合并的理由：合并会把两种不同的失效模式搅进一个四百行的脚本，还会动到已经接好的 git hook。
> **新规则请加到对应脚本，不要两边都写。**
- **为什么有这条**：同一轮里出现了两次同类问题 ——
  1. D-20 修复过程中，`src-tauri/src/runtime/health.rs` 的 6 处单测断言直接用真实验证时拿到的出口 IP。对 Shadowsocks 来说，那就是**节点服务器地址**。
  2. 验收文档里把用户**本机直连公网出口 IP** 写进了正文（8 处，已全部脱敏），那等于公开用户的实际位置与宽带运营商。
  3. 两份设计文档把参考工程的**真实用户目录**写死了（4 处，工作区已改写；**历史提交里仍然存在，未重写**）。

  前两次都**没有提交**，但那是运气，不是流程保证；第三次已经提交了，只是还没公开。
  > **测试数据本身也是提交物。** 「测试写完就算完」不够；「文档不是代码」也不成立 —— 文档同样进仓库。

### 扫描范围

| 范围 | 取的命令 |
|---|---|
| 受版本控制的文件 | `git ls-files` |
| 暂存区 | `git diff --cached --name-only` |
| **未跟踪文件** | `git status --porcelain \| grep '^??'` —— 新文件最容易漏 |
| 排除 | `target/`、`node_modules/`、`.git/`、`*.enc`、**`src-tauri/claurst/`**（上游子模块自带的测试夹具，改了下次同步会回来）、**本用例文档自身**（规则文本里会出现样例行，见下） |

### 必查项

| # | 项 | 匹配方式 | 注意 |
|---|---|---|---|
| 1 | **非文档用公网 IP（v4 / v6）** | 通用 IPv4/IPv6 字面量正则 + 白名单 | 白名单：`203.0.113.0/24`、`198.51.100.0/24`、`192.0.2.0/24`、`2001:db8::/32`（RFC 5737 / 3849 文档地址）、`127.0.0.0/8`、`0.0.0.0`、`10/8`、`172.16/12`、`192.168/16`。**这一条同时能抓节点地址和用户本机出口** |
| 2 | 节点地址增补 | 从环境变量 `VEYL_DENY_IPS` 读取 | **脚本内不得写死** —— 节点地址每轮不同，写进去就是新的泄漏 |
| 3 | 节点 id / 种子文件名与路径 | `seed-[0-9a-f]{16}`、`seeds\.json` | 格式固定，可安全内建 |
| 4 | 密码 / 密钥 / token | `"password"\s*:`、`sk-[A-Za-z0-9]{20,}`、`BEGIN [A-Z ]*PRIVATE KEY`、`AKIA[0-9A-Z]{16}`、`ghp_[A-Za-z0-9]{36}` | 通用模式，不含真实值 |
| 5 | 凭据指纹 / 派生值 | `pw_fp`、`fingerprint\s*[:=]\s*[0-9a-f]{8,}`、裸 32/40/64 位十六进制串 | 派生值同样可反查，不能只看明文 |
| 6 | macOS 用户绝对路径 | 家目录前缀 + 用户名 + `/`（**不在此处写出可直接匹配的字面正则**） | 泄漏用户名与目录结构。**占位名不算命中**：单字母、`test`、`user`、`username`、`example`、`foo`、`bar` 等明显非真实用户名的值，以及 `src-tauri/claurst/` 下的上游夹具 |

### 排除集的边界（重要）

排除只有四项：`src-tauri/claurst/`、`target/`、`node_modules/`、`.git/`，外加本用例文档自身（避免规则文本自我命中）。

**除此之外不设白名单。** 白名单是这类检查最常见的失效方式 —— 为了「先让 CI 绿」而加例外，最后例外比被检查的东西还多。

遇到真实命中，正确做法是**改掉源码里的值**，不是加白名单。
| 7 | 种子文件内容 | 同文件同时出现 `"outbounds"` 与 `"password"` | —— |

### 判定

命中任何一项 → **退出码非 0，阻断提交**。不是警告，不是「建议修复」。

### 自检（比扫描本身更重要）

脚本必须先做一次自测：把一段**假**密钥写进临时文件并纳入扫描范围，确认**能报出错误**，然后删除。

> 没有自检的扫描器永远返回 0，等于没有。这一条不通过，AC-S1 直接判 FAIL，不看扫描结果。

### 命令与预期

```bash
scripts/test/secret-scan.sh
echo "exit=$?"
```

```bash
VEYL_DENY_IPS="<本轮节点地址，从执行记录取>" scripts/test/secret-scan.sh
```

- **预期**：两次都 `exit=0`
- **若命中**：输出 `文件:行号: 命中项`，**但不打印命中的原文**

### 失败判定

| 现象 | 结论 |
|---|---|
| `exit=0` 但仓库里确有真实值 | 扫描器无效 |
| 输出里打印了命中的原文 | **扫描器自己成了泄漏源** |
| 真实值被写进脚本 | 最严重：把泄漏固化进了工具 |
| 自检那步报不出错 | 扫描器无效（见上） |

### 实现（已完成）

`scripts/test/secret-scan.sh` 已创建，并接入 `scripts/ci.sh` 第 2 步作为**硬失败项**（第 1 步是 `check-secrets.sh`，见上面的分工表）。

- 当前工作区扫描：**exit 0**
- 自检失败：**exit 2**（已实测）
- `--quick` 现在覆盖前 6 步，包含本扫描

### 证据

脚本运行输出 + 退出码；**自检那次故意失败的输出也要留** —— 它证明扫描器真的会失败。

---

## 12. 门禁在放行条件里的位置

AC-S1 与 §6 的用例不同：它不验功能，验的是**「即将提交的东西里有没有不该有的东西」**。因此它有两个触发点：

1. **每次提交前** —— 由 `ci.sh` 强制，不通过不许合
2. **发布前** —— 独立再跑一次，作为最后一道闸

任一次命中，都按阻断处理。
