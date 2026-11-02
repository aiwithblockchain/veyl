# 会话管理用例

> 覆盖 P1.5 会话相关能力。首批只有 G1（删除会话），后续重命名、批量清理可继续加在本文件。
> 执行者：不需要懂代码；**应用一律由用户手动启动**。
> 参考事实：`delete_session` 只删 `chat_sessions` 一行；`chat_messages` 有 `ON DELETE CASCADE`（应用启动时开了 `PRAGMA foreign_keys`），**`tool_calls` 没有外键，不会级联** —— 这正是本条要显式查它的原因。

---

## 0. 准备

### 0.1 启动应用（由用户手动启动）

开发构建：`./scripts/dev/dev-with-log.sh`，或双击 `src-tauri/target/debug/veyl`。
打包版：双击 `Veyl.app`。

### 0.2 准备数据

测试前需要**至少 3 个会话**，且其中一个包含工具调用（这样 `tool_calls` 才有行可查）：

1. 新建会话 A，发一条会触发工具的消息（例如「看一下运行状态」，会调 `RuntimeStatus`）
2. 新建会话 B，随便发一条
3. 新建会话 C，随便发一条

### 0.3 通用证据命令

```bash
DATA="$HOME/Library/Application Support/Veyl"
DB="$DATA/veyl.db"

# 当前所有会话
sqlite3 -header -column "$DB" "SELECT id,title,created_at FROM chat_sessions ORDER BY created_at;"

# 某个会话在**三张表**里的行数（把 <id> 换成真实 id）
sqlite3 -header -column "$DB" "SELECT
  (SELECT COUNT(*) FROM chat_sessions WHERE id='<id>')        AS sessions,
  (SELECT COUNT(*) FROM chat_messages WHERE session_id='<id>') AS messages,
  (SELECT COUNT(*) FROM tool_calls    WHERE session_id='<id>') AS tool_calls;"

# 配置与 Key（用来确认删除会话没有误伤它们）
sqlite3 "$DB" "SELECT COUNT(*) FROM profiles;"
ls -l "$DATA/secrets.enc" 2>/dev/null || echo "无 secrets.enc"
```

> 每条子场景开始前，先记下要删的那个 session 的 id，以及删除前的三表计数——**没有 before 就无法证明 after 是 0**。

---

## G1 删除会话（**阻断级：不允许半删除**）

- **追溯**：P1.5 会话管理；PM 2026-11-02 定案
- **前置**：§0.2 已完成；每个子场景前都先记录该 session id 与三表计数
- **失败判定（总原则）**：**删除后任一张表仍能查到该 session 的行 = 半删除 = 阻断级失败**，不管界面表现如何。

### 场景 1：删除非当前会话

1. 记下会话 A 的 id 与其三表计数
2. 在侧边栏切换到会话 B（保证当前不是 A）
3. 删除 A
4. 观察侧边栏：会话列表**少一项**，B 与 C 仍在
5. 执行三表计数查询（A 的 id）

**通过**：列表少一项；B/C 未受影响；A 的三个计数**全部为 0**。

### 场景 2：删除当前会话（还有其他会话）

1. 当前停在会话 B
2. 删除 B
3. 观察：是否**自动切到下一个会话**（C），而不是空白
4. 三表计数（B 的 id）

**通过**：自动切到 C；界面上不存在「已删除但标题还留着」的残留；B 的三个计数为 0。

### 场景 3：删除最后一个会话

1. 删除剩下的 C
2. 观察界面
3. 三表计数（C 的 id）

**通过**：
- 对话列表为空
- 界面回到**控制台空态**（不是空白页，也不是仍在 C 的对话里）
- C 的三个计数为 0

### 场景 4：重启后仍为空

1. 完全退出应用（`Cmd+Q` → 选「退出」；未连接时应直接退出）
2. **由用户重新启动应用**
3. 观察侧边栏

**通过**：侧边栏仍为空，直接进控制台 —— 证明删除落到了数据库，不是只改了前端状态。

### 场景 5：生成中删除

> 这一条最容易漏：流式请求还没结束就删会话，迟到的分片可能把 `chat_messages` 又写回来。

1. 新建会话 D，发一条会触发**较长输出**的消息
2. 输出开始后，点「停止」
3. **等待 `ai-request-end` 事件**（界面上表现为 loading 结束；若看不到事件，等 3 秒确认输入框恢复可用）
4. 删除 D
5. **等 5 秒**
6. 再查 D 的三表计数
7. 观察侧边栏是否又冒出 D

**通过**：
- 5 秒后 D 的三个计数仍全为 0
- 侧边栏没有重新出现 D
- 没有报错弹窗

**失败判定**：`chat_messages` 或 `tool_calls` 又出现该 id 的行 = 迟到的流式写入 = 阻断级。

### 场景 6：配置与 Key 不受影响

在任意一次删除之后执行：

```bash
sqlite3 "$DB" "SELECT COUNT(*) FROM profiles;"       # 与删除前一致
ls -l "$DATA/secrets.enc"                             # 仍存在、权限仍为 0600
```

**通过**：`profiles` 行数不变；`secrets.enc` 仍在且权限 `-rw-------`。

---

## 通过标准汇总

| # | 标准 |
|---|---|
| 1 | 删除非当前会话：列表少一项，其他会话不受影响 |
| 2 | 删除当前会话：自动切到下一个；无其他会话时回到**总览** |
| 3 | 删除最后一个会话：对话列表为空，界面为控制台空态 |
| 4 | **重启应用后仍为空** |
| 5 | `tool_calls` 中该 `session_id` 计数为 **0** |
| 6 | `chat_messages` 与 `chat_sessions` 同样查不到该 id |
| 7 | **生成中删除**：取消 → 等 `ai-request-end` → 删除 → 等 5 秒，无迟到分片写回 |
| 8 | 配置与 DeepSeek Key 完全不受影响 |

---

## 失败时抓证据

```bash
DATA="$HOME/Library/Application Support/Veyl"
DB="$DATA/veyl.db"

# 1) 残留行：任一条不为 0 就是半删除
sqlite3 -header -column "$DB" "SELECT
  (SELECT COUNT(*) FROM chat_sessions WHERE id='<id>')        AS sessions,
  (SELECT COUNT(*) FROM chat_messages WHERE session_id='<id>') AS messages,
  (SELECT COUNT(*) FROM tool_calls    WHERE session_id='<id>') AS tool_calls;"

# 2) 整库扫一遍有没有孤儿行（session_id 已不在 chat_sessions 里）
sqlite3 -header -column "$DB" "SELECT
  'messages' AS tbl, COUNT(*) AS orphans FROM chat_messages m
    WHERE NOT EXISTS (SELECT 1 FROM chat_sessions s WHERE s.id=m.session_id)
  UNION ALL
  SELECT 'tool_calls', COUNT(*) FROM tool_calls t
    WHERE t.session_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM chat_sessions s WHERE s.id=t.session_id);"

# 3) 该时段的日志
ls -t "$DATA/logs/" | head -3
```

外加：删除前后的侧边栏截图、重启后的首屏截图。

> **孤儿行查询是通用兜底**：它不依赖记得 session id，跑一遍就能看出库里有没有历史遗留的半删除。建议每轮验收结束都跑一次。

---

## 附：执行记录模板

| 场景 | 时间 | 结果 | 三表计数（删后） | 备注 |
|---|---|---|---|---|
| 1 非当前会话 | | | | |
| 2 当前会话 | | | | |
| 3 最后一个会话 | | | | |
| 4 重启后为空 | | | | |
| 5 生成中删除 | | | | 必须记录等待时长 |
| 6 配置与 Key | | | | |
