# 右侧状态面板用例（P1.5 wave1）

> 覆盖 `docs/phase-1-5-requirements.md` §9（F. 右侧状态面板）与 §11 的 F1–F4。
> 执行者：不需要懂代码；**应用一律由用户手动启动**。
> 所有点击都在应用界面里完成，命令只用于取证。

---

## 0. 准备

### 0.1 启动应用（由用户手动启动）

开发构建：`./scripts/dev/dev-with-log.sh`，或双击 `src-tauri/target/debug/veyl`。
打包版：双击 `Veyl.app`。

### 0.2 前置数据

- 至少**两个**可连接的节点（否则 F3 无法切换）
- 一个已知的「当前节点名」，后面每步都要对照

### 0.3 通用证据命令

```bash
DATA="$HOME/Library/Application Support/Veyl"
DB="$DATA/veyl.db"

# 系统代理三项（判断代理是否生效的唯一依据）
scutil --proxy | grep -E 'HTTPEnable|HTTPProxy|HTTPPort|HTTPSEnable|HTTPSPort|SOCKSEnable|SOCKSPort'

# 运行时进程与其监听端口
PID=$(pgrep -f 'sing-box run' | head -1)
echo "pid=$PID"
[ -n "$PID" ] && lsof -nP -iTCP -sTCP:LISTEN -a -p "$PID" | awk 'NR>1{print $9}'

# 明文配置（连接期间才应存在）
find "$DATA/config" -type f 2>/dev/null | wc -l   # 0 = 空
ls -A "$DATA/config/" 2>/dev/null || echo "config 目录不存在"

# 直连出口
curl -sS --max-time 10 --noproxy '*' https://ifconfig.me/ip
```

> `curl` **不读**系统代理。「代理是否生效」看 `scutil`；「出去是什么地址」必须显式加 `--proxy`。

---

## F1 面板点击「连接」

- **追溯**：R26/R27 / §9.2、§9.3；验收 F1
- **前置**：应用已启动；**未连接**；已有至少一个节点
- **步骤**：
  1. 看右侧面板：状态文字、当前节点、主按钮文案
  2. 点击主按钮「连接」
  3. **点完立即**观察按钮：是否马上变成 loading / 禁用（防止重复点击）
  4. 等状态变化（**不应弹 toast**，结果以面板变化体现）
  5. 连接成功后看面板：状态句、出口 IP、连接时长
  6. 执行取证命令
- **观察点**：
  - 未连接时主按钮是「连接」
  - 点击后按钮立即进入 loading / 禁用
  - 连接中主按钮变「取消」，已连接后变「断开」
  - 状态是「图标 + 文字 + 颜色」，文字为完整句子（如 `已连接 · 东京 01`）
  - 面板显示出口 IP 与直连 IP
- **通过标准**：
  1. 按钮文案顺序正确：连接 → 取消 → 断开
  2. 点击后立即不可重复提交
  3. 已连接状态句子完整
  4. **面板显示的出口 IP = 经代理实测出口**，且与直连出口不同
  5. 连接时长从连接成功时刻起算
- **失败时抓证据**：

```bash
scutil --proxy | grep -E 'HTTPEnable|HTTPPort'
pgrep -fl 'sing-box run'
PORT=$(scutil --proxy | awk '/HTTPPort/{print $3}')
[ -n "$PORT" ] && curl -sS --max-time 15 --proxy "http://127.0.0.1:$PORT" https://ifconfig.me/ip
curl -sS --max-time 10 --noproxy '*' https://ifconfig.me/ip
```

  外加：连接前 / 点击瞬间 / 已连接三张面板截图。

- **常见误判**：把直连出口当成代理出口。上面两条 `curl` 必须都跑，且地址不同才算真的走代理。

---

## F2 面板点击「断开」

- **追溯**：R27；验收 F2
- **前置**：F1 已通过（当前处于已连接）
- **步骤**：
  1. 点击主按钮「断开」
  2. 观察按钮是否立即进入 loading / 禁用
  3. 等状态变化
  4. 看面板：状态、出口 IP、连接时长
  5. 执行取证命令
- **观察点**：
  - 断开后状态回到「未连接」，连接时长归零
  - 出口 IP 显示为「未知」或直连
  - 系统代理全部关闭
- **通过标准**：
  1. `HTTPEnable` / `HTTPSEnable` / `SOCKSEnable` **全部 0**
  2. `pgrep -fl 'sing-box run'` 为空
  3. `config/` 为空
  4. 直连出口恢复正常（能上网）
  5. 面板状态与上述事实**一致**（不能显示已连接）
- **失败时抓证据**：同 F1 的三条命令 + 面板截图。

---

## F3 面板切换节点（**重点：不能出现「假已连接」**）

- **追溯**：R28 / §9.4；验收 F3
- **前置**：已连接节点 A；存在另一个可连接的节点 B
- **步骤**：
  1. 点击面板上的当前节点名，确认展开节点列表（应有名称 / 协议 / 地区 / 当前项标记）
  2. **先开一个采样窗口**（终端里执行，保持运行）：

```bash
( for i in $(seq 1 60); do
    printf '%s proxy=%s sb=%s\n' \
      "$(date +%H:%M:%S)" \
      "$(scutil --proxy | awk '/HTTPEnable/{print $3}')" \
      "$(pgrep -f 'sing-box run' | tr '\n' ',' | sed 's/,$//')"
    sleep 0.5
  done ) | tee /tmp/veyl-switch-sample.log
```

  3. 在采样进行中，在节点列表里**选择节点 B**
  4. 全程盯着面板：按钮是否显示进度？状态句有没有出现「已连接」但实际没连上的瞬间？
  5. 切换完成后停止采样（`Ctrl+C`）
  6. 执行取证命令
- **观察点**：
  - 切换过程有序：**先撤代理 → 停旧运行时 → 起新运行时 → 再设代理**
  - 采样日志里应能看到：`proxy=1` → 中间出现 `proxy=0` → 恢复 `proxy=1`
  - sing-box 的 pid 在切换中**发生变化**（新进程）
  - 面板状态与采样事实**一致**：凡是显示「已连接」，同一时刻 `proxy=1` 且 sing-box 存在
- **通过标准**（五条全部满足）：
  1. 切换后出口地址**与切换前不同**
  2. 新 sing-box 进程的 pid 与切换前不同
  3. **系统代理端口 = 新进程的 mixed 监听端口**
  4. 采样日志中**不存在**「`proxy=1` 但 sing-box 为空」的持续状态（单次 0.5 秒内的过渡采样允许，连续 ≥2 次即判失败）
     > 采样脚本只记录 proxy 与 pid，**不记录面板文字** —— 「面板显示已连接但 proxy=0」这一条只能靠肉眼 + 截图证明，不在本项内。
  5. 旧节点的渲染配置已被删除，`config/` 只剩新节点
- **失败判定**（任一即为阻断级）：
  - **肉眼**看到面板显示「已连接」，但同一时刻 `scutil` 的 `HTTPEnable=0` 或 `pgrep` 查不到 sing-box（截图 + 记下时间点）
  - 切换后出口没变（说明没真的换）
  - 代理端口与新进程监听不一致
- **证据**：

```bash
cat /tmp/veyl-switch-sample.log
cat "$DATA/runtime.pid" 2>/dev/null
find "$DATA/config" -type f 2>/dev/null | wc -l   # 应为 1 组 json + 1 个 meta = 2
ls -A "$DATA/config/"
scutil --proxy | grep -E 'HTTPEnable|HTTPPort'
PID=$(pgrep -f 'sing-box run' | head -1); lsof -nP -iTCP -sTCP:LISTEN -a -p "$PID" | awk 'NR>1{print $9}'
```

  外加：节点列表截图、切换中面板截图（含进度）、切换后面板截图。

- **为什么要采样**：切换是连续动作，肉眼只能看到「最后连上了」，看不到中间有没有掉。**采样日志是这条用例唯一的客观证据**，没有它就只能记「未验证」。

---

## F4 面板端口显示 = 真实 mixed 端口

- **追溯**：R30 / §9.6；验收 F4
- **前置**：已连接
- **步骤**：
  1. 在面板上找到「本地端口」显示（二级信息区），记下它显示的端口号
  2. 用命令读出**真实的** mixed 端口
  3. 对照两者
- **命令**：

```bash
# 1) 系统代理指向的端口（应用设置代理时用的就是 mixed 端口）
scutil --proxy | awk '/HTTPPort/{print "HTTPPort=" $3}'

# 2) sing-box 实际监听的两个端口（mixed + clash）
PID=$(pgrep -f 'sing-box run' | head -1)
echo "pid=$PID"
lsof -nP -iTCP -sTCP:LISTEN -a -p "$PID" | awk 'NR>1{print $9}'

# 3) 后端状态里的 mixed_port（若已实现该字段）
sqlite3 "$DB" "SELECT result_json FROM tool_calls WHERE tool_name='RuntimeStatus' ORDER BY created_at DESC LIMIT 1;" \
  | grep -o '"mixed_port":[0-9]*' || echo "RuntimeStatus 尚未返回 mixed_port"
```

- **观察点**：面板上的端口号与上面读到的 mixed 端口**完全一致**
- **通过标准**：
  1. 面板端口 = `scutil` 的 `HTTPPort`
  2. 面板端口出现在 `lsof` 的监听列表里
  3. 断开再连接一次，**面板端口 = 新的 `scutil` `HTTPPort`**
     > 不要求端口一定变化：随机分配完全可能再次选中同一个值，此时面板不变是**正确**的。
- **失败判定**：
  - 面板端口与 `scutil` / `lsof` 不一致（包括固定显示某个值、不随重连更新）
  - 重连后端口变了，面板仍显示旧值
- **证据**：面板端口截图 + 上述三条命令输出。

> 「端口显示真实值」看起来是个小细节，但它是面板可信度的试金石：一个连自己端口都显示错的界面，用户没有理由相信它显示的「已连接」。

---

## 附：执行记录模板

| 用例 | 时间 | 结果 | 证据位置 | 备注 |
|---|---|---|---|---|
| F1 | | | | |
| F2 | | | | |
| F3 | | | | 采样日志必须附上 |
| F4 | | | | 记录面板端口 / scutil 端口 / lsof 端口三个值 |
