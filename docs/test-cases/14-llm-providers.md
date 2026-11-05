# LLM Provider 设置用例（基础 / 高级）

> 覆盖 `docs/phase-1-5-requirements.md` §5.8（R32）与 §11 的 H1–H5，外加 5 条补充用例（HX1–HX5）。
> 执行者：不需要懂代码；**应用一律由用户手动启动**。
> **纪律**：`secrets.enc` 只读**键名**，绝不打印内容；任何截图与记录都不得出现完整 Key。

---

## 0. 准备

### 0.1 启动应用（由用户手动启动）

开发构建：`./scripts/dev/dev-with-log.sh`，或双击 `src-tauri/target/debug/veyl`。
打包版：双击 `Veyl.app`。

### 0.2 通用证据命令

```bash
DATA="$HOME/.veyl"
DB="$DATA/veyl.db"

# 1) secrets.enc 里的 provider 键名（只列名字，不读值）
python3 - <<'PY'
import json, os
p = os.path.expanduser("~/.veyl/secrets.enc")
try:
    d = json.load(open(p))
    print(sorted(k for k in d if k.startswith("provider:")))
except FileNotFoundError:
    print("[]  (secrets.enc 不存在)")
PY

# 2) settings 里与 provider 相关的行（非敏感字段应在这里）
sqlite3 -header -column "$DB" "SELECT key,value FROM settings WHERE key LIKE '%provider%';"

# 3) 当前进程与日志位置
pgrep -fl 'target/debug/veyl|Veyl.app/Contents/MacOS'
ls -t "$DATA/logs/" | head -3
```

> 上面第 1 段**只列键名**。不要 `cat secrets.enc`，也不要把它贴进任何报告。

### 0.3 准备一个可用的外部端点（H2/H3 需要）

任选其一，并在记录里写明用的是哪种：

- **真实的 OpenAI 兼容端点**（如 DeepSeek、Moonshot）
- **真实的 Anthropic 兼容端点**
- **本机 Ollama**：`ollama serve` 已在跑，`curl -s http://127.0.0.1:11434/api/tags` 有返回

没有可用端点时，H2/H3 记为「未验证」，**不要用「测试连接成功」代替「新会话真的走了该端点」**。

---

## H1 基础模式（全新安装只填 DeepSeek Key）

- **追溯**：R32 基础模式；验收 H1
- **前置**：全新安装（无 `secrets.enc`、无 provider 设置）
- **步骤**：
  1. 启动应用，走首次引导到「配置 DeepSeek Key」
  2. 只填 DeepSeek Key，保存并验证
  3. **不打开「高级设置」**，直接进入主界面
  4. 发一条普通消息（例如「你好」）
  5. 观察是否正常回复
- **观察点**：
  - 全新安装时**看不到** provider 列表，也不需要理解「Base URL / API 类型」这些概念
  - 保存后显示掩码，例如 `sk-••••1a2b`
  - 对话正常返回
- **通过标准**：
  1. 只有 DeepSeek Key 一个输入项
  2. 保存后生成的内置 provider 为：`openai` 兼容、`https://api.deepseek.com`、`deepseek-chat`
  3. 不进入高级设置也能完成一次对话
  4. `secrets.enc` 里出现 `provider:deepseek`，且 `provider:` 开头的键**恰好一个**
- **失败时抓证据**：

```bash
python3 - <<'PY'
import json, os
p = os.path.expanduser("~/.veyl/secrets.enc")
d = json.load(open(p)); print(sorted(k for k in d if k.startswith("provider:")))
PY
sqlite3 "$DATA/veyl.db" "SELECT key,value FROM settings WHERE key LIKE '%provider%';"
```

  外加：引导页与对话成功截图、掩码截图。

---

## H2 OpenAI 兼容自定义端点

- **追溯**：R32 高级模式；验收 H2
- **前置**：§0.3 已准备一个 OpenAI 兼容端点；应用已启动
- **步骤**：
  1. 打开「高级设置」→ Provider 列表 → 新增
  2. 填写：名称（如 `my-openai`）、API 类型 `openai`、Base URL、API Key、模型
  3. 点「测试连接」，等结果
  4. 保存，并在列表里把它**设为当前**
  5. 新建一个会话，发一条消息
  6. **到端点侧确认收到了请求**（二选一）：
     - 真实平台：到该平台后台看用量 / 请求记录，截图
     - 本机 Ollama：看 `ollama serve` 的终端输出，应出现对应请求
- **观察点**：
  - 测试连接显示成功与耗时（或可读的失败原因）
  - 设为当前后，列表里**只有一个**「当前」标记
  - 新会话使用的是该端点
- **通过标准**：
  1. Provider 保存成功，出现在列表
  2. 测试连接成功（有耗时或成功提示）
  3. 设为当前后，列表中「当前」标记只有一处
  4. **端点侧确有收到请求的记录**（截图；这是「真的走了该端点」的唯一硬证据）
  5. 对话内容正常返回
- **失败判定**：
  - 测试连接成功，但端点侧查不到任何请求 → 说明请求没走它
  - 列表出现两个「当前」
- **失败时抓证据**：测试连接结果截图 + provider 列表截图 + 端点侧记录截图 + `settings` 查询输出

> **不要用「设置里填的是这个 URL」代替「请求确实发到了这里」**。前者只证明配置写对了，后者才证明链路通了。

---

## H3 Anthropic 兼容端点

- **追溯**：R32 高级模式；验收 H3
- **前置**：§0.3 已准备 Anthropic 兼容端点
- **步骤**：
  1. 高级设置 → 新增 provider：API 类型选 `anthropic`，填 Base URL / Key / 模型
  2. 观察 Base URL 的提示文案：应提示 `/v1/messages` 兼容
  3. 点「测试连接」
  4. 设为当前，新建会话，发一条消息
  5. 端点侧确认请求（同 H2）
- **通过标准**：
  1. 保存成功；Base URL 提示为 `/v1/messages` 兼容
  2. 测试连接成功
  3. 能完成一次对话，且端点侧有请求记录
- **失败判定**：测试连接成功但对话失败（协议不兼容）——这是**严重**问题，记 FAIL 并附错误原文。
- **失败时抓证据**：同 H2 + 错误提示截图

---

## H4 删除 provider

- **追溯**：R32；验收 H4
- **前置**：列表里有至少 2 个 provider，且其中一个是当前
- **步骤**：
  1. 记下要删的 provider 名称与它的 `provider:<id>` 键（见 §0.2 第 1 条）
  2. 删除它
  3. 观察列表
  4. 查 `secrets.enc` 的键名
  5. 完全退出并**重启应用**
  6. 再看列表与键名
- **观察点**：列表少一项；对应 Key 的**键名**消失；重启后不复活
- **通过标准**：
  1. 列表中该 provider 消失
  2. `secrets.enc` 中对应的 `provider:<id>` **键名不存在**
  3. 重启后列表仍无该项目，键名仍不存在
  4. 其他 provider 与配置未受影响
- **失败判定**：列表删了但键名还在 = **半删除**（等同 G1 的口径），阻断级。
- **证据**：

```bash
python3 - <<'PY'
import json, os
p = os.path.expanduser("~/.veyl/secrets.enc")
d = json.load(open(p)); print(sorted(k for k in d if k.startswith("provider:")))
PY
sqlite3 -header -column "$DATA/veyl.db" "SELECT key,value FROM settings WHERE key LIKE '%provider%';"
```

  外加：删除前后列表截图。

---

## H5 旧 Key 迁移

- **追溯**：R32；验收 H5
- **设计前提（PM 定稿）**：密钥统一用 `provider:<provider_id>`；内置 DeepSeek 保持 **`provider:deepseek` 不搬移**；迁移**只补元数据，不动密钥**。
- **前置**：一个**升级前**的数据目录（只有 DeepSeek Key，没有 provider 元数据）
- **准备方法**（二选一）：
  - 用上一版构建启动一次并只填 DeepSeek Key，然后换成新构建
  - 若无旧构建：确认 `secrets.enc` 里已有 `provider:deepseek`、`settings` 里没有 provider 元数据（相当于升级前状态）
- **步骤**：
  1. 迁移前先拍快照（见下）
  2. 启动新构建
  3. 打开基础设置，看 Key 状态
  4. 直接发一条消息
  5. 完全退出并重启，再看一次
- **通过标准**（两条）：
  1. **`provider:deepseek` 仍然存在**，且 `provider:` 开头的键总数仍为 **1**（重复启动后也不增加）
     —— 迁移前查得到、迁移后也查得到，且没有多出第二条
  2. 设置里能看到内置 provider 的**元数据**（名称 / 类型 / Base URL / 模型）；基础模式显示**同一个 Key 的掩码**，**无需重填即可对话**
- **失败判定**：
  - 迁移后 `provider:deepseek` 查不到 → **Key 被搬走或丢失**，阻断级
  - 出现两个及以上 `provider:` 键 → 重复迁移，阻断级
  - 有 Key 但基础模式要求重填 → 迁移没把元数据补上
- **迁移前后快照**：

```bash
DATA="$HOME/.veyl"
DB="$DATA/veyl.db"

# 键名（不含值，只列 provider:）
python3 - <<'PY'
import json, os
p = os.path.expanduser("~/.veyl/secrets.enc")
d = json.load(open(p))
print(sorted(k for k in d if k.startswith("provider:")))
PY

# 非敏感设置（provider 元数据应出现在这里）
sqlite3 -header -column "$DB" "SELECT key,value FROM settings ORDER BY key;"
```

- **失败时抓证据**：迁移前后两份快照 + 基础设置页截图 + 重启后列表截图

---

## 补充用例（HX）

### HX1 Base URL 填 `http://` 非本机地址 → 拒绝

- **步骤**：新增 provider，Base URL 填 `http://example.com/v1`，保存
- **通过**：保存被拒绝，**给出原因**（`http` 仅允许本机），不是静默失败
- **失败判定**：接受保存 → 严重（Key 会以明文 HTTP 发出去）

### HX2 本机 Ollama 不填 Key 可保存

- **前置**：`ollama serve` 在跑
- **步骤**：新增 provider，Base URL `http://127.0.0.1:11434`，**API Key 留空**，模型填本地已有模型，保存
- **通过**：保存成功；不提示「缺少 Key」
- **对照**：把 Base URL 换成非本机地址、Key 留空 → **必须拒绝**

### HX3 同一时刻只有一个「当前」provider

- **步骤**：依次把 A、B、C 设为当前，每次设完看列表
- **通过**：任何时刻「当前」标记恰好一个；旧的那一个自动取消
- **证据**：三次列表截图

### HX4 切换 provider 不打断正在生成的回答

- **步骤**：
  1. 发一条会产生较长回答的消息
  2. 输出**进行中**时，到高级设置把当前 provider 切成另一个
  3. 回到对话，观察这段回答
- **通过**：正在生成的回答**继续完成**，不中断、不重来；下一条消息才使用新 provider
- **失败判定**：回答被打断 / 重新开始 / 报错 = 阻断级

### HX5 Key 不出现在任何可见位置

- **前置**：用一个**明显的测试 Key**（例如 `sk-hxtest-0000000000`）配置 provider
- **步骤**：
  1. 正常使用一次（保存、测试连接、对话、切换、删除）
  2. 检查界面、错误提示、日志、数据库
- **证据**：

```bash
DATA="$HOME/.veyl"
DB="$DATA/veyl.db"
KEY='sk-hxtest-0000000000'

# 日志与数据库里不得出现完整 Key
grep -rn "$KEY" "$DATA/logs/" 2>/dev/null && echo "⚠️ 日志命中" || echo "日志未命中"
sqlite3 "$DB" "SELECT COUNT(*) FROM settings WHERE value LIKE '%'||'$KEY'||'%';"
sqlite3 "$DB" "SELECT COUNT(*) FROM chat_messages WHERE content LIKE '%'||'$KEY'||'%';"
```

- **通过**：以上全部为 0；界面任何位置只显示掩码
- **失败判定**：任一处命中 → 阻断级，按凭据泄漏处理（轮换 Key 并报 PM）

---

## 附：执行记录模板

| 用例 | 时间 | 结果 | 证据位置 | 备注 |
|---|---|---|---|---|
| H1 基础模式 | | | | |
| H2 OpenAI 兼容 | | | | 端点侧记录必须附 |
| H3 Anthropic 兼容 | | | | 无端点时记「未验证」 |
| H4 删除 provider | | | | 附键名前后对比 |
| H5 旧 Key 迁移 | | | | 附迁移前后快照 |
| HX1 http 非本机 | | | | |
| HX2 本机免 Key | | | | |
| HX3 唯一当前 | | | | |
| HX4 切换不打断 | | | | |
| HX5 Key 不泄漏 | | | | 任一处命中即阻断 |
