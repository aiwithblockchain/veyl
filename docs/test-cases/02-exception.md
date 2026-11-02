# 异常路径用例

> 对应 `phase-1-requirements.md` 9.2 验收标准与 FR-3.9 / FR-4.3 / FR-5.6 / FR-6.5 / FR-7.4
> 层：U / I / E / M
> 这些用例的共同要求：**必须给出可执行的原因，而不是「失败了」**。

---

## 错误分类枚举（断言基准）

所有失败必须落到以下枚举之一（FR-7.4）。自由文本不算通过。

| 枚举 | 中文提示要求 | 必须给出的下一步 |
|---|---|---|
| `key_invalid` | Key 无效 / 已过期 | 重新配置 Key，并说明可切无 AI 模式 |
| `node_unreachable` | 节点不可达 | 推荐同地区其他节点 |
| `auth_failed` | 节点认证失败 | 换节点（凭证失效） |
| `config_invalid` | 配置不合法 | 指出具体字段 |
| `port_in_use` | 本地端口被占用 | 指出端口号，给出换端口入口 |
| `runtime_not_ready` | 运行时未就绪 | 启动或重装运行时 |
| `download_failed` | 下载失败 | 显示 HTTP 状态或网络原因，可重试 |
| `checksum_mismatch` | 文件校验失败 | 说明已删除文件，可重试 |

---

## 用例表

### 1. Key 无效

| ID | 层 | 追溯 | 前置 | 步骤 | 预期 | 优先级 |
|---|---|---|---|---|---|---|
| **TC-EXC-001** | E | FR-2.7、FR-8.1、9.2 | 引导页；mock LLM 对 `sk-test-invalid` 返回 401 | 1) 输入 `sk-test-invalid`；2) 提交；3) 观察提示；4) 查看是否仍可继续 | 提示**「Key 无效」**并区分 401（鉴权）与网络不可达两种原因；不进入正常对话；**引导保留可跳过入口**；出现「使用无 AI 模式」按钮且可点；Key 不写入 Keychain | P0 |
| **TC-EXC-002** | E | FR-2.7、U8 | 已保存无效 Key；已进入主界面 | 1) 直接输入「连到日本」；2) 观察行为 | 对话区提示 Key 无效并给出重新配置入口；同时**状态面板仍显示手动节点列表**，可直接点连接；不得卡在 loading | P0 |
| **TC-EXC-003** | U | FR-8.1、9.3 | — | 1) 保存无效 Key；2) grep 数据目录与日志 | 无效 Key 与有效 Key 一样**绝不落盘到数据目录**；日志中该字符串出现 0 次 | P0 |

### 2. 节点不可达

| ID | 层 | 追溯 | 前置 | 步骤 | 预期 | 优先级 |
|---|---|---|---|---|---|---|
| **TC-EXC-004** | I | FR-7.4、9.2 | mock 目录返回 `seed-dead-01`（指向 `127.0.0.1:1`） | 1) `vpn_connect(seed-dead-01)`；2) 观察返回值与日志 | 返回 `ok=false`，`error_code=node_unreachable`；**系统代理已回滚**（不得停留在指向我们端口的设置）；`next_actions` 非空且包含同地区节点 | P0 |
| **TC-EXC-005** | I | FR-7.3、FR-7.4 | 本地节点已停止，客户端已连上（出站不可达） | 1) 调 Clash API `/proxies/proxy/delay`；2) 观察分类结果 | 延迟测试返回非 200（实测为 `{"message":"An error occurred in the delay test"}`）；Host 将其归类为 `node_unreachable`，**不得**归类为 `runtime_not_ready` | P0 |
| **TC-EXC-006** | E | 6.5 流程 | 首选节点为 `seed-dead-01`，同地区存在 `seed-jp-01` | 1) 输入「连到日本」；2) 观察工具序列 | 第一次 `vpn_connect` 失败 → 助手**自动重试 ≤ 1 个**同地区节点 → 成功则汇报已连到备选节点并说明原节点不可用；若备选也失败，停止重试并给出建议（不得连续重试 3 次以上） | P1 |
| **TC-EXC-007** | I | FR-7.4 | mock 目录返回 `seed-bad-tls-01`（Reality 公钥错误） | 1) `vpn_connect`；2) 观察分类 | `error_code=auth_failed`（而非 `node_unreachable`）；提示「认证失败」；系统代理已回滚 | P1 |

### 3. 下载失败

| ID | 层 | 追溯 | 前置 | 步骤 | 预期 | 优先级 |
|---|---|---|---|---|---|---|
| **TC-EXC-008** | I | FR-3.2、9.2 | `AIVPN_MANIFEST_PATH=manifest-bad-url.json`（URL 返回 404） | 1) `core_install("1.14.4")`；2) 轮询 `job_id` 至结束 | 返回 `error_code=download_failed`；消息中**包含 HTTP 404**；`runtime_installs` 中该版本仍为未安装；临时文件被删除；可再次调用 `core_install` 重试 | P0 |
| **TC-EXC-009** | I | FR-3.2 | 清单 URL 指向一个连接后立即断开的地址 | 1) 安装；2) 观察 | 归类为 `download_failed`，消息含「网络中断」类原因；**不产生半截文件**留在版本目录 | P1 |
| **TC-EXC-010** | I | FR-3.2 | mock 服务对下载限速并延迟 30 秒 | 1) 安装；2) 观察阶段与取消 | 阶段依次为 `downloading` → `verifying` → `extracting` → `installing`；取消后进程与临时文件被清理；不留下锁死的后续任务 | P1 |

### 4. SHA256 不匹配

| ID | 层 | 追溯 | 前置 | 步骤 | 预期 | 优先级 |
|---|---|---|---|---|---|---|
| **TC-EXC-011** | I | FR-3.3、9.2 | `AIVPN_MANIFEST_PATH=manifest-bad-sha.json` | 1) `core_install("1.14.4")`；2) 观察结果与磁盘 | `ok=false`，`error_code=checksum_mismatch`；**下载文件已被删除**（断言版本目录为空）；`sing-box` **从未被执行**（即使是个可执行文件也不得运行）；状态回到 `not_installed` | P0 |
| **TC-EXC-012** | U | FR-3.3 | 大小正确但内容被篡改的归档 | 1) 跑校验函数 | 校验失败；错误信息包含期望值与实际值的前 8 位（便于排查），但**不得**包含完整清单内容 | P1 |

### 5. 端口占用

| ID | 层 | 追溯 | 前置 | 步骤 | 预期 | 优先级 |
|---|---|---|---|---|---|---|
| **TC-EXC-013** | I | FR-7.4、FR-6.5、9.2 | 先用一个进程占用 `12080`；`AIVPN_MIXED_PORT=12080` | 1) `vpn_connect`；2) 观察 | `error_code=port_in_use`；提示中**包含端口号 12080**；**应用不崩溃**；系统代理未被设置；提供「换端口」的下一步 | P0 |
| **TC-EXC-014** | I | FR-4.1、FR-7.4 | 占用 Clash API 端口 `19090` | 1) 连接 | 启动前探测到占用 → 换一个空闲端口重试（Clash 端口本就随机）；若两次均失败才归类为 `port_in_use`；**不出现** sing-box 直接 FATAL 退出后无人处理 | P1 |
| **TC-EXC-015** | I | FR-3.9 | 端口冲突导致的启动失败 | 1) 观察 Runtime Manager 状态机 | 日志应出现 sing-box 原文 `bind: address already in use` 且被识别；状态从 `starting` → `failed`（**不得**在 10 秒超时后才判失败） | P1 |

### 6. 应用被强杀

| ID | 层 | 追溯 | 前置 | 步骤 | 预期 | 优先级 |
|---|---|---|---|---|---|---|
| **TC-EXC-016** | E + M | FR-1.4、FR-6.4、9.2 | 已连接；系统代理指向 `127.0.0.1:12080` | 1) `kill -9 <app_pid>`（Windows：任务管理器结束进程）；2) 确认系统代理**仍是** `127.0.0.1:12080`；3) 重新启动应用 | 启动时检测到 `proxy_backup` 残留且当前代理等于我们的地址 → **自动恢复**原代理；界面提示「上次异常退出，已恢复系统代理」；恢复后 `proxy_backup` 记录被清除 | P0 |
| **TC-EXC-017** | E + M | FR-6.4 | 已连接；强杀应用 | 1) 强杀后**不重启应用**；2) 用浏览器访问网页 | 记录实际表现（预期：浏览器断网或走直连失败）。这是已知代价，不作为缺陷，但必须写进用户文档与重启提示 | P1 |
| **TC-EXC-018** | E | FR-6.4 | 用户自己把系统代理改成了别的地址；`proxy_backup` 仍有残留 | 1) 启动应用 | **不覆盖**用户的新设置；只提示「检测到代理备份但当前代理已被修改，未自动恢复」；提供手动「恢复系统代理」按钮（FR-8.4） | P1 |
| **TC-EXC-019** | E | FR-3.8、6.6 | 强杀应用后，sing-box 子进程仍存活（孤儿） | 1) 重启应用；2) 观察 | 启动时检测到孤儿 sing-box 并终止它（或接管），**不得**出现两个 sing-box 抢同一端口；日志有明确记录 | P1 |

### 7. sing-box 崩溃

| ID | 层 | 追溯 | 前置 | 步骤 | 预期 | 优先级 |
|---|---|---|---|---|---|---|
| **TC-EXC-020** | I + M | FR-3.8、9.2 | 已连接 running | 1) `kill -9 <sing-box_pid>`；2) 观察 10 秒内状态 | **应用不退出**；状态短暂变为 `restarting` 后回到 `running`；新 pid ≠ 旧 pid；系统代理保持有效；用户看到一条「运行时已自动重启」提示 | P0 |
| **TC-EXC-021** | I | FR-3.8 | 让 sing-box 每次启动后 1 秒内崩溃（替换为立即退出的可执行文件） | 1) 触发连接；2) 观察重启节奏与最终状态 | 重启恰好 3 次，间隔近似 1s / 2s / 4s；之后进入 `failed`；**自动关闭系统代理**（避免用户断网）；提示需人工处理；日志可数出 3 次重启 | P0 |
| **TC-EXC-022** | I | FR-3.9 | 启动一个不响应 Clash API 的进程 | 1) 连接 | 10 秒后判为 `runtime_not_ready`；进程被终止；系统代理未设置 | P1 |
| **TC-EXC-023** | E | 4.3 设计 | Agent 运行中构造一次 panic（测试构建注入） | 1) 触发 panic；2) 观察应用与连接 | **应用不退出**；sing-box 连接不受影响（状态仍 running）；UI 提示「助手已重启」；可以继续发消息 | P1 |

### 8. 权限审批

依据 `docs/contracts/tools.md` §2.2，审批有两层，**作用域不同，不要混用**：

| 概念 | 作用域 | 绑定对象 | 生命周期 | 存在哪 |
|---|---|---|---|---|
| `ApprovalGrant` | 会话 | `(session_id, tool)` | 会话结束即失效 | 内存 |
| `approval_id` | 单次调用 | `(tool, sha256(canonical_args))` | 5 分钟 | 内存 |

| 工具 | `ApprovalPolicy` | 何时弹 | `tool_calls.approved` |
|---|---|---|---|
| `CoreInstall` | `always` | **每次** | `0` 拒绝 / `1` 允许一次 |
| `VpnConnect` | `first_time_per_session` | **每会话首次** | `0` 拒绝 / `2` 允许本会话 |
| `VpnDisconnect` | `never` | 不弹 | — |
| 只读工具（`RuntimeStatus` / `CatalogSearch` / `RuntimeLogs` / `CoreListVersions` / `DiagnosticRun`） | `never` | 不弹 | — |

判据不是「工具名」，而是「失败后用户能不能自己收拾干净」：装错版本会留下来源不明的可执行文件，用户无法自行判断；连错节点只需要断开。

#### 8.1 `CoreInstall`（恒需审批）

`CoreInstall` 的 policy 是 `always`，scope 恒为 `call`：**不存在「记住选择」**，同一次会话里第二次安装仍然要弹卡。

| ID | 层 | 追溯 | 前置 | 步骤 | 预期 | 优先级 |
|---|---|---|---|---|---|---|
| **TC-EXC-031** | I | FR-2.4、contracts/tools §2.3 | 运行时未安装；**绕过 UI** 直接走工具分发层调用 `CoreInstall`（无 Grant、无 `approval_id`） | 1) 发起调用；2) 观察结果；3) 查看 mock 下载请求计数 | 返回 `ok=false`，`error.code == "APPROVAL_REQUIRED"`；`details` 含 `approval_id` / `tool` / `summary` / `risk` / `scope:"call"` / `session_id` / `expires_at`；**下载请求计数为 0**；版本目录未创建；不留下半截文件 | P0 |
| **TC-EXC-032** | E | FR-2.4 | 运行时未安装 | 1) 触发 `CoreInstall`；2) 卡上点「允许」；3) 等待完成 | 允许后 Host 记录 `approval_id`（绑定参数哈希）；工具带 `approval_id` 重试成功；`runtime_installs` 有记录；`tool_calls.approved == 1`；工具卡 waiting → running → ok | P0 |
| **TC-EXC-033** | E | FR-2.4 | 已安装 1.14.4，再次触发安装 | 1) 再次调用 `CoreInstall`；2) 观察是否弹卡 | **仍然弹卡**（`always` 不产生 Grant）；本次授权不影响下一次 | P0 |
| **TC-EXC-039** | I | contracts/tools §2.3 | 已拿到一次合法 `approval_id`（参数为 `{"version":"1.14.4"}`） | 1) 用同一 `approval_id` 调用 `{"version":"1.15.0"}`；2) 观察 | 被拒绝（`APPROVAL_REQUIRED` 或 `PERMISSION_DENIED`），**不得执行**：`approval_id` 绑定参数哈希，参数变了就不认；下载计数不增加 | P0 |

#### 8.2 `VpnConnect`（会话内首次审批）

连接会改系统代理，policy 是 `first_time_per_session`：第一次要问；批准后本会话内换节点、重连都不再打断。

| ID | 层 | 追溯 | 前置 | 步骤 | 预期 | 优先级 |
|---|---|---|---|---|---|---|
| **TC-EXC-034** | E | FR-2.4、contracts/tools §3.2 | 新会话；运行时已装；从未连接过 | 1) 输入「连到日本」；2) 观察卡片 | 弹出 `VpnConnect` 确认卡：显示目标节点、「将修改系统代理」、风险等级；`scope == "session"`，按钮文案为**「允许（本会话内不再询问）」**；卡片出现前不得启动 sing-box、不得改代理（断言进程与代理值为空） | P0 |
| **TC-EXC-035** | E | FR-2.4 | 同会话已批准过一次，随后断开 | 1) 输入「连到新加坡」；2) 观察 | **不弹卡**，直接执行（Grant 命中，与参数无关）；调用**不需要带 `approval_id`**；`tool_calls.approved == 2`；切换成功 | P0 |
| **TC-EXC-036** | E | FR-2.4 | 同会话已批准过 | 1) 新建会话；2) 输入「连到日本」 | **重新弹卡**：Grant 按 `session_id` 存，不跨会话继承；批准后正常连接 | P0 |

#### 8.3 拒绝与授权失效

| ID | 层 | 追溯 | 前置 | 步骤 | 预期 | 优先级 |
|---|---|---|---|---|---|---|
| **TC-EXC-030** | E | FR-2.4、contracts/tools §2.3 | 新会话；`CoreInstall` 弹卡 | 1) 点「拒绝」；2) 观察 | 返回 `PERMISSION_DENIED`；下载计数为 0；进程与代理均未变动；**写入否定缓存**；`tool_calls.approved == 0` | P0 |
| **TC-EXC-037** | E | contracts/tools §2.3 | 同会话刚拒绝过 `CoreInstall`（或 `VpnConnect`） | 1) 再次发起同一工具；2) 观察 | 同会话内**不再弹卡**，直接返回 `PERMISSION_DENIED`（否定缓存生效）；不执行任何动作 | P0 |
| **TC-EXC-038** | E | contracts/tools §2.2、FR-2.5 | 同会话已批准过；随后退出应用 | 1) 重启并恢复该会话；2) 再连接 | **重新弹卡**：Grant **只存内存**，不落 SQLite、不随会话历史持久化；会话恢复的是消息记录，不是权限 | P0 |

> **否定缓存与 Grant 的区别**：Grant 是「本会话允许」，否定缓存是「本会话别再问」。两者都只在内存、都随会话结束清空；新会话里一切重来。
>
> **批准不跳过校验**：批准的是「这个工具可以在本会话自动跑」，不是「跳过配置校验」。每次连接仍要生成配置、跑 `sing-box check`、验证出口 IP。
>
> **实现提醒**：所有审批判定必须在工具分发层完成，不能只靠 UI 隐藏按钮——否则绕过 UI 直接调用工具就能免审批（TC-EXC-031 测的就是这条）。

#### 8.4 `tool_calls.approved` 落库三值

契约 1.0.2 把这一列从布尔改成三值。它不只是审计字段——**事后判断「用户到底同意到什么程度」只能靠它**，写错了就无法复盘。

| 值 | 含义 | 何时写入 |
|---|---|---|
| `0` | 拒绝 | 用户点「拒绝」 |
| `1` | 允许一次（`scope = "call"`） | `CoreInstall` 每次批准 |
| `2` | 允许本会话（`scope = "session"`） | `VpnConnect` 首次批准 |

| ID | 层 | 追溯 | 前置 | 步骤 | 预期 | 优先级 |
|---|---|---|---|---|---|---|
| **TC-EXC-040** | I | contracts/tools §2.3 | 新会话；`CoreInstall` 弹卡后点「拒绝」 | 1) 查询 `tool_calls` 表该行 | `approved == 0`；同一行的 `tool` 为 `CoreInstall`；`created_at` 与该次调用一致 | P0 |
| **TC-EXC-041** | I | contracts/tools §2.3 | 新会话；`CoreInstall` 弹卡后点「允许」 | 1) 查询 `tool_calls` 表 | `approved == 1`（**不是** 2）：`always` + `scope:"call"` 只授权这一次 | P0 |
| **TC-EXC-042** | I | contracts/tools §2.3 | 新会话；`VpnConnect` 首次弹卡后点「允许」；随后同会话再连接一次 | 1) 查第一次与第二次的 `tool_calls` 行 | 第一次 `approved == 2`；第二次同样为 `2`（表示「在会话授权下执行」）。两次都不得为 `1`——把会话授权记成一次性会让复盘误判用户只同意了一次 | P0 |
| **TC-EXC-043** | I | contracts/tools §2.3 | 无审批路径的只读工具（如 `RuntimeStatus`） | 1) 调用一次；2) 查 `tool_calls` | 不产生审批记录（`approved` 为 `NULL` 或该行不写审批语义），不得凭空写 `1` | P1 |

> **TC-EXC-042 的口径已定**：PM 决定「后续自动放行同样记 `2`」，并写入 `docs/contracts/tools.md` §2.3。架构师落笔后本用例不需要再改——它的作用就是把这句决定变成可执行的断言。

### 9. 其他失败路径

| ID | 层 | 追溯 | 前置 | 步骤 | 预期 | 优先级 |
|---|---|---|---|---|---|---|
| **TC-EXC-024** | I | FR-4.3 | 构造缺失 `uuid` 的 VLESS 出站 | 1) 生成配置并校验 | **必须被 Config Builder 自己拒绝**（`config_invalid`）。注意：实测 `sing-box check` 对这类语义缺失**返回 0**，不能依赖它兜底 | P0 |
| **TC-EXC-025** | I | FR-4.3 | 构造 `server_port` 为字符串的配置 | 1) 校验 | 拒绝并指出字段路径（如 `outbounds[0].server_port`） | P1 |
| **TC-EXC-026** | I | FR-5.5、FR-5.6 | 停掉 mock 目录服务；本地已有缓存 | 1) 启动应用；2) 查询节点 | 使用缓存并标注「可能过期」；不阻塞手动导入；请求超时 5 秒后降级，不无限等待 | P1 |
| **TC-EXC-027** | I | FR-5.6 | 目录服务返回 500 | 1) 查询节点 | 提示服务不可用；可重试；缓存仍可用 | P1 |
| **TC-EXC-028** | M | FR-6.5 | macOS：拒绝 `networksetup` 的授权弹窗 | 1) 连接 | 不静默失败；给出「系统设置 → 网络 → 代理」的手动指引；sing-box 可保持运行或回滚，二者择一但必须**状态一致** | P1 |
| **TC-EXC-029** | E | FR-2.6 | Agent 正在流式输出 | 1) 点停止；2) 再发一条新消息 | 停止后 loading 解除；**下一轮请求不被模型 API 以 400 拒绝**（悬空 `tool_use` 已被清理）；新消息正常响应 | P1 |

---

### 10. `ProfileDelete`：幂等与删除正在使用的配置

契约 §4.17（1.0.4 起纳入；1.0.5 调整了「正在使用」时的行为）：`Write` + `always`（scope `call`），**每次删除都要确认**，不做会话内放行。

`data` 字段：`profile_id` / `deleted` / `already_absent` / `active_profile_id`。

| ID | 层 | 追溯 | 前置 | 步骤 | 预期 | 优先级 |
|---|---|---|---|---|---|---|
| **TC-EXC-044** | I | contracts/tools §4.17 | 本地 0 个 profile；新会话 | 1) 直接调 `ProfileDelete({"profile_id":"prf_not_exist"})`（无 `approval_id`）；2) 批准后再调一次 | 第一次返回 `APPROVAL_REQUIRED`——`always` 对任何 id 都先问，**包括不存在的**；批准后 `ok=true`、`deleted=false`、`already_absent=true`；`tool_calls.approved == 1`；日志为 info，不得 error | P1 |
| **TC-EXC-045** | I | 同上 | 有 1 个 profile `prf_1`；本会话此前已批准过一次删除 | 1) 删除 `prf_1`；2) 再删一次 `prf_1` | 两次都 `ok=true`；第一次 `deleted=true`、`already_absent=false`；第二次 `deleted=false`、`already_absent=true`；**第二次仍弹审批**（`always` 不放行）；`profiles` 表最终无该行 | P1 |
| **TC-EXC-046** | I | 同上、FR-6.4 | 已连接到 `prf_1` 的节点 | 1) 删除 `prf_1`；2) 立刻检查系统代理、sing-box 进程、浏览器能否上网 | **不变式**：系统代理与实际连通性必须一致——要么都断（代理已恢复、进程已停），要么都保持（代理仍有效、流量仍能出去）。**不得**出现「配置已删、代理指向已失效端口、用户断网」 | P0 |
| **TC-EXC-047** | I + E | contracts/tools §4.17（1.0.5 定案） | 已连接到 `prf_1` 的节点 | 1) 调 `ProfileDelete({"profile_id":"prf_1"})`；2) 观察是否弹审批卡；3) 查库与连接状态 | 返回 `ok=false`，`error.code == "PRECONDITION_FAILED"`，`details` 指明 `ACTIVE_PROFILE_IN_USE`；**不弹审批卡**——Host 在审批网关之前就拦截；`tool_calls.approved` 不写值；连接不受影响（进程仍在、代理仍有效）；`profiles` 表仍有该行；`content` 提示「请先断开或切换到其他配置」 | P1 |
| **TC-EXC-048** | I | contracts/tools §4.17 | 有 `prf_1`（active）与 `prf_2`，**当前未连接**（与 TC-EXC-047 的区别就在这里） | 1) 删除 `prf_1`；2) 查 `active_profile_id`；3) 观察是否改用 `prf_2` | 删除成功；`active_profile_id == null`；**不自动切换**到 `prf_2`，也不发起连接（避免用户没要求的重连） | P1 |
| **TC-EXC-049** | I | contracts/tools §4.17 | — | 1) 调 `ProfileDelete({"profile_id":""})` | 返回 `INVALID_ARGUMENT`；**不触发审批**（参数非法不必打扰用户）；不产生删除 | P2 |

> **已定案（契约 1.0.5）**：删除正在使用的配置走**拒绝**路径——`PRECONDITION_FAILED` / `ACTIVE_PROFILE_IN_USE`，Host 在审批前拦截、不弹卡。TC-EXC-046 的不变式保留：拒绝同样满足「不能出现配置已删、代理指向失效端口」。
>
> **这条同时钉住了实现顺序**：前置条件检查必须在审批网关**之前**。反过来的话，用户先被问「是否删除」、点了允许才被告知「删不了」，白打扰一次，`approved` 也会被写脏。
