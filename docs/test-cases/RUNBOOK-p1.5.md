# P1.5 测试 RUNBOOK

> 每轮验收照着这一份走。用例正文在 `08` ~ `14` 号文件，这里只放**怎么开始、怎么收尾、按什么顺序**。
> **应用永远由用户手动启动**，任何脚本都不代启。

---

## 0. 一条纪律

> **没有取证记录的用例记「未验证」，不许记通过。**
>
> 「我点了，看起来是好的」不是证据。证据是命令输出、截图、DB 查询结果之一，并且带时间。

---

## 1. 启动应用

在**项目根目录**（含 `scripts/` 的那一层）执行：

```bash
cd "$(git rev-parse --show-toplevel)" && bash scripts/dev/dev-with-log.sh
```

- 日志：`build/logs/dev-<时间戳>.log`，出问题先看这里
- 不写死本机绝对路径 —— 换机器、换目录都要能用

启动后先跑一遍基线（见 `08-lifecycle.md` §0.2）：

```bash
pgrep -fl 'target/debug/veyl|Veyl.app/Contents/MacOS'
pgrep -fl 'sing-box run' || echo "无 sing-box"
scutil --proxy | grep -E 'HTTPEnable|HTTPSEnable|SOCKSEnable'
```

---

## 2. 退出应用

三种方式，行为不同，都要能走通：

| 方式 | 期望 |
|---|---|
| `Cmd+W` / 红色关闭按钮 | 窗口隐藏，进程存活，**不弹任何提示**，连接保持 |
| `Cmd+Q` → 「后台运行」 | 弹出阻塞对话框；选后窗口隐藏，连接保持 |
| `Cmd+Q` → 「退出」 | 按顺序：撤代理 → 停运行时 → 清配置 → 退出 |
| 托盘 → 「退出」 | 与「Cmd+Q → 退出」一致；**正常情况不应有确认框** |

退出后必须核对（见 `08-lifecycle.md` A3/A5）：

```bash
pgrep -fl 'target/debug/veyl|Veyl.app/Contents/MacOS' || echo "应用已退出"
pgrep -fl 'sing-box run' || echo "无 sing-box"
scutil --proxy | grep -E 'HTTPEnable|HTTPSEnable|SOCKSEnable'   # 三个都应为 0
find "$HOME/Library/Application Support/Veyl/config" -type f 2>/dev/null | wc -l   # 应为 0
```

---

## 3. 断网恢复（测试失败时的兜底）

任何一轮测试都可能把系统代理留在「指向死端口」的状态。**先恢复网络，再继续排查**。

```bash
# 1) 看当前状态
scutil --proxy | grep -E 'HTTPEnable|HTTPProxy|HTTPPort|HTTPSEnable|HTTPSPort|SOCKSEnable|SOCKSPort'

# 2) 逐个网络服务关闭代理（不要写死 Wi-Fi）
networksetup -listallnetworkservices | tail -n +2 | while IFS= read -r svc; do
  case "$svc" in *"*"*) continue ;; esac
  networksetup -setwebproxystate "$svc" off
  networksetup -setsecurewebproxystate "$svc" off
  networksetup -setsocksfirewallproxystate "$svc" off
done

# 3) 确认已恢复
scutil --proxy | grep -E 'HTTPEnable|HTTPSEnable|SOCKSEnable'
curl -sS --max-time 10 --noproxy '*' https://ifconfig.me/ip
```

补充：

- 若还有孤儿运行时：`pkill -f 'sing-box run'`
- 若 `runtime.pid` 残留：`rm -f "$HOME/Library/Application Support/Veyl/runtime.pid"`
- 恢复后**重新跑一遍基线**，再继续下一轮

> `curl` **不读** macOS 系统代理。判断「代理是否生效」只看 `scutil --proxy` + 显式 `--proxy` 的出网结果。

---

## 4. 批次表

| 批次 | 用例 | 对应文件 | 依赖 |
|---|---|---|---|
| **第一批** | A1–A7、B1–B5、F1–F4、G1 | `08-lifecycle.md`、`09-onboarding.md`、`10-console-panel.md`、`13-sessions.md` | 生命周期、引导、状态面板、会话删除 |
| **第二批** | C1–C4、D1–D2、E1–E4 | `11-default-profile.md`、`12-diagnostics.md`（待写） | 默认配置源、离线分发、诊断 |
| **第三批** | H1–H5、HX1–HX5 | `14-llm-providers.md` | Bob 的 provider 后端 |

### 批次选择原则

- **第一批先跑**：它是所有后续测试的地基 —— 起不来、退不干净、单实例会杀连接，后面测什么都会被污染。
- **第二批其次**：默认配置与诊断依赖网络环境，容易受代理状态影响，所以放在生命周期验证之后。
- **第三批最后**：依赖 provider 后端就绪，且需要外部端点或本机 Ollama。

### 第三批的前置

- 一个可用的 OpenAI 兼容端点，或本机 `ollama serve`
- 一个 Anthropic 兼容端点（H3 没有就记「未验证」）
- 一个**明显的测试 Key**（用于 HX5 扫泄漏），不要用真 Key

---

## 5. 每轮记录格式

每轮开一份记录，逐条填：

| 用例 | 时间 | 结果 | 证据位置 | 备注 |
|---|---|---|---|---|
| A1 | 21:10 | PASS | 截图 a1-close.png；before/after 输出 | |
| A7 | 21:20 | FAIL | /tmp/veyl-a7-before.txt、after.txt、diff | 第二次启动后 sing-box pid 变了 |

结果只有三种：`PASS` / `FAIL` / `未验证`。

- **FAIL** 必须附：现象一句话、复现步骤、对应哪条通过标准、证据
- **未验证** 必须写原因：没环境、没端点、构造不出来

### 每轮结束的通用体检

```bash
DATA="$HOME/Library/Application Support/Veyl"
DB="$DATA/veyl.db"

# 代理是否残留
scutil --proxy | grep -E 'HTTPEnable|HTTPSEnable|SOCKSEnable'

# 运行时与配置是否残留
pgrep -fl 'sing-box run' || echo "无 sing-box"
find "$DATA/config" -type f 2>/dev/null | wc -l

# 孤儿行（历史半删除）
sqlite3 -header -column "$DB" "SELECT
  'messages' AS tbl, COUNT(*) AS orphans FROM chat_messages m
    WHERE NOT EXISTS (SELECT 1 FROM chat_sessions s WHERE s.id=m.session_id)
  UNION ALL
  SELECT 'tool_calls', COUNT(*) FROM tool_calls t
    WHERE t.session_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM chat_sessions s WHERE s.id=t.session_id);"
```

---

## 6. 发给 PM 的四段式模板

```
【测试 Clerk】<这批测了什么>

1 状态：完成 / 阻塞 / 需决策
2 改了哪些文件：<本轮写了哪些记录或文档>
3 验收结果：<跑了什么、得到什么；FAIL 与未验证各几条，列 ID>
4 需要 PM 做什么：<没有就写「无」>
```

- 第一条消息 ≤400 字，细节放第二条或留在会话记录里
- 一遇到阻塞立刻发，不要硬撑到最后
- 报告里**绝不出现**密码、私钥、token、完整 Key、种子文件内容、真实节点地址

---

## 7. 收尾检查清单

一轮测完，交付前确认：

- [ ] 系统代理三项为 0
- [ ] 无孤儿 sing-box
- [ ] `config/` 为空（未连接时）
- [ ] 所有 FAIL 都有证据与对应通过标准
- [ ] 所有「未验证」都写了原因
- [ ] 报告里没有完整 Key / 节点地址 / 本机绝对路径
