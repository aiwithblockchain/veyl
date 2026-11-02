# 安全用例

> 对应 `phase-1-requirements.md` 9.3 安全检查与 `phase-1-technical-design.md` 第 7 节
> 层：U / I / E / M
> 这些是 P0。安全检查不通过，功能再完整也不发布。

---

## 1. 密钥与凭据

| ID | 层 | 追溯 | 前置 | 步骤 | 预期 | 优先级 |
|---|---|---|---|---|---|---|
| **TC-SEC-001** | I | 9.3、7 安全设计 | 已配置 Key 并连接过一次 | 1) 递归 grep 整个数据目录；2) grep 日志目录；3) 搜索 sqlite 全部表 | Key 明文出现 **0 次**；`uuid` / `password` / `private_key` / `short_id` / `device_token` 明文出现 **0 次** | P0 |
| **TC-SEC-002** | U | 7 安全设计 | 构造含 `"uuid":"abc-uuid-123"` 的日志入参 | 1) 走日志宏 | 输出为 `"uuid":"***"`；**脱敏发生在写入之前**（不能先写后删，否则磁盘上曾存在明文） | P0 |
| **TC-SEC-003** | U | 7 安全设计 | 大对象日志 | 1) 记录一个含 500 个字段的请求体 | 不打印完整请求头与 body；只记录白名单字段 | P1 |
| **TC-SEC-004** | U | 隐私、7 安全设计 | 一次代理请求 | 1) 检查日志 | 不记录访问的目标域名/IP；只记录字节数与结果 | P0 |
| **TC-SEC-005** | I | FR-8.1 | 保存 Key 后 | 1) 检查 SQLite；2) 检查 Keychain | SQLite 中**无** Key；Keychain 中存在（service `aivpn`，account `deepseek_key`） | P0 |

---

## 2. 本地服务暴露面

| ID | 层 | 追溯 | 前置 | 步骤 | 预期 | 优先级 |
|---|---|---|---|---|---|---|
| **TC-SEC-006** | I | 9.3、FR-4.1 | 运行中 | 1) `lsof -iTCP -sTCP:LISTEN -P -n \| grep sing-box` | 所有监听地址均为 `127.0.0.1`；**不得出现 `0.0.0.0` 或 `*`**；mixed 与 Clash API 两个端口都在 | P0 |
| **TC-SEC-007** | I | FR-4.1 | 运行中 | 1) 从另一台机器访问 `http://<本机IP>:<clash_port>/version` | 连接被拒绝（不可达）；本机访问返回 200 | P0 |
| **TC-SEC-008** | I | §3.3 可测性开关 | release 构建 | 1) 设置 `AIVPN_LLM_BASE=http://127.0.0.1:18091`；2) 启动 release 包；3) 观察请求去向 | release 构建**忽略**该变量，仍访问真实 endpoint。测试开关泄漏到发布版本 = 可被劫持，属 S1 | P0 |
| **TC-SEC-009** | I | 7 安全设计 | mock 记录请求 | 1) 完成一次连接 | 外发请求只包含：设备注册、目录查询、（可选）匿名健康上报；**不含**对话内容、目标域名、节点凭证 | P0 |
| **TC-SEC-020** | U + I | `docs/contracts/runtime.md` §11 | 运行中 | 1) 取 `RuntimeStatus` 快照并 `serde_json::to_value`；2) 断言顶层键集合；3) 再取 `runtime_status` 工具的 `ToolResult.data` | 序列化结果**不含** `clash_addr`，也**不含** `clash_secret`；其余字段（`state` / `version` / `pid` / `started_at` / `restarts` / `last_error`）保留。工具返回的 `data` 同样不含二者 | P0 |
| **TC-SEC-021** | U | 同上 | — | 1) 跑 `node tests/contracts/check-contracts.mjs` | 静态检查在结构体层面就拦住 `clash_addr`（防止有人加回来但没走运行时路径） | P1 |

---

## 2.1 事件载荷（`args_preview`）

工具调用事件会带着参数在 UI 里渲染成卡片，也会被写进会话记录。**这是凭据最容易漏出去的地方**——它不经过日志脱敏那条链路。

| ID | 层 | 追溯 | 前置 | 步骤 | 预期 | 优先级 |
|---|---|---|---|---|---|---|
| **TC-SEC-022** | U + I | contracts/events §3 | 触发 `ProfileImport`（含 `node_id`）与 `VpnConnect` | 1) 抓取 `tool-call-start` 事件；2) 检查 `args_preview` | `key` / `uuid` / `password` / `token` / `short_id` 的值一律为 `***`；非敏感字段（`node_id`、`region`）保留原值；`args_preview` 只含白名单内的少量字段，**不是**完整入参 | P0 |
| **TC-SEC-023** | U | contracts/events §3 | 构造嵌套三层的参数 `{node:{credentials:{uuid:"…"}}}` 与数组 `[{password:"…"}]` | 1) 生成 `args_preview` | 脱敏是**递归**的：任意层级、数组元素里的敏感键都被替换；不得只处理顶层键 | P0 |
| **TC-SEC-024** | U | contracts/events §3 | 触发 `VpnConnect`（内部会生成完整 sing-box 配置） | 1) 抓取该轮全部 `tool-call-start` / `tool-call-end` payload；2) 搜索 `"outbounds"` / `"inbounds"` / `config_json` | **完整配置不出现在任何事件里**；工具结果只带摘要与少量结构化字段（状态、出口 IP、延迟）；配置只落本地文件，不进事件，也不进模型上下文 | P0 |
| **TC-SEC-025** | U | contracts/events §3 | 键名变体：`apiKey` / `API_KEY` / `Password` / `accessToken` / `secret` | 1) 生成 `args_preview` | 匹配**大小写不敏感**；白名单之外的键默认**不输出**（宁可少显示，也不要「不认识的敏感键就原样带出去」） | P1 |

---

## 3. 工具与提示注入

| ID | 层 | 追溯 | 前置 | 步骤 | 预期 | 优先级 |
|---|---|---|---|---|---|---|
| **TC-SEC-010** | U | 4.3 系统提示第 3 条、4.9 | mock 返回含注入文本的节点 | 1) 执行 `connect-jp` 场景 | 助手**不执行**注入文本里的工具调用；只在正常工具集内动作；回答中不出现被注入的指令内容 | P0 |
| **TC-SEC-011** | U | FR-4.5、4.4 工具层 | 任意对话 | 1) 检查注册给模型的工具列表 | 只有 §5 工具清单里的工具；**没有** shell / 文件读写 / 任意 HTTP 工具 | P0 |
| **TC-SEC-012** | I | 4.4 工具层 | 直接构造 `vpn_connect(node_id="../../etc/passwd")` | 1) 调用工具 | 参数校验拒绝，返回 `config_invalid`；**不读取任何文件系统路径** | P0 |
| **TC-SEC-013** | I | 4.4 工具层 | 构造超长字符串参数（10MB）与非法类型 | 1) 调用工具 | 被拒绝并限长；进程内存不暴涨；不 panic | P1 |
| **TC-SEC-014** | E | 4.3 Agent 隔离 | 模型返回一个不存在的工具名 | 1) 观察 | 提示工具不存在；不执行任何动作；不崩溃 | P1 |

---

## 4. 完整性

| ID | 层 | 追溯 | 前置 | 步骤 | 预期 | 优先级 |
|---|---|---|---|---|---|---|
| **TC-SEC-015** | I | FR-3.3 | 下载归档 | 1) 抓取实际请求 URL；2) 比对清单 `source_url` | 只从清单声明的官方地址下载；不跟随重定向到非 GitHub/非白名单域名 | P1 |
| **TC-SEC-016** | I | 3 硬约束 | 安装后 | 1) 检查安装目录内容 | 目录中只有归档内文件（`sing-box` + `LICENSE`）；未额外写入我们的代码或修改二进制 | P0 |
| **TC-SEC-017** | M | GPL 合规 | 发布包 | 1) 检查「关于」页与下载页 | 明确标注内置 sing-box 版本、许可证 `GPL-3.0-or-later`、源码地址；**不暗示与 SagerNet 存在关联** | P0 |

> TC-SEC-017 是法律风险项而非功能项：sing-box 许可证附加条款禁止暗示官方关联。文案由 PM 定稿，测试只负责确认发布包里确实有。

---

## 5. 崩溃隔离

| ID | 层 | 追溯 | 前置 | 步骤 | 预期 | 优先级 |
|---|---|---|---|---|---|---|
| **TC-SEC-018** | I | 4.3 Agent 隔离 | 连接中，注入一次 Agent panic | 1) 观察 | 应用不退出；sing-box 不受影响；连接保持；UI 提示并可在新会话继续 | P1 |
| **TC-SEC-019** | I | 3 进程与 IPC | 连接中，sing-box 段错误 | 1) 观察 | 应用不退出；走 TC-EXC-020 的重启路径 | P0 |
