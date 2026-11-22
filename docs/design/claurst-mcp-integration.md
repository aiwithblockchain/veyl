# claurst MCP 接入方案（节点自救链路）

> 状态：调研完成，待决策。只读研究，未改任何代码。
> 研究对象：`src-tauri/claurst` 子模块（claurst 0.2.1），本地 path 依赖。
> 路径约定：文中 `crates/...`、`src-rust/crates/...` 均指 `src-tauri/claurst/src-rust/` 下；`src-tauri/src/...` 指 Veyl 主工程。
> 结论一句话：**claurst 自带完整 MCP 客户端（stdio / SSE / Streamable HTTP），无需自研协议；但 Veyl 当前没有接线，`mcp_manager: None` 是唯一断点。**

---

## 1. 结论摘要

1. **claurst 有完整 MCP 客户端**，就在 `claurst-mcp` crate（`src-rust/crates/mcp`，约 5,710 行）。后端是官方 `rmcp`（crate 声明 `1.4.0`，`src-tauri/Cargo.lock` 实际解析为 **1.8.0**），支持三种传输：`stdio`、legacy `sse`、Streamable HTTP `http`，并内置协议版本回退（2025-11-25 → 2025-06-18 → 2025-03-26 → 2024-11-05）。
2. `ToolContext.mcp_manager` 的类型是 `Option<Arc<claurst_mcp::McpManager>>`（`crates/tools/src/lib.rs:652`）。Veyl 在 `src-tauri/src/claurst_session/mod.rs:386` 传了 `None`，这是**唯一一处**没接线的地方。
3. **一旦接上，MCP 工具会自动变成原生工具**：`claurst_tools::mcp_tools(&manager)` 把每个 MCP 工具包成 `McpToolWrapper`，与 Veyl 自己的 `vpn_tools` 并列交给模型，命名 `mcp__<server>__<tool>`。
4. **但 Veyl 的会话工具列表是构造时冻结的**（`AivpnSession.tools: Vec<Box<dyn Tool>>`，`src-tauri/src/claurst_session/mod.rs:271/:345`），会话只在换 Key 时重建（`src-tauri/src/agent/mod.rs:147`）。`McpManager` 也没有 `add_server`，只有 `start` / `connect_all` / `reconnect` / `shutdown`。这意味着路线 A（接 manager）需要**在会话创建前把节点 agent 全部连好**，且节点增删要重建会话。
5. **推荐路线 B**：不改 `mcp_manager`，只加一个原生工具 `NodeRotateCredentials`，内部走 MCP 协议调用远端 `rotate_credentials`。协议仍是 MCP，但注册方式、权限、确认卡、超时、重试都在 Veyl 自己手里，且不受“会话工具冻结”影响。
6. **TLS 是新的硬约束**：rmcp 1.8 的 `StreamableHttpClientTransport::with_client` 可以注入自定义 `reqwest::Client`，从而信任自签 CA 或做指纹 pin；但 claurst 的 `connect_http` 写死 `from_config`，`McpServerConfig` 没有 TLS 字段。**因此 `claurst_mcp::McpClient` 无法连自签证书的节点 agent**：要么 Veyl 直接用 rmcp + `with_client`，要么给 claurst 加注入点。详见 §4.1。

---

## 2. 证据（逐条，文件:行号）

### Q1. `mcp_manager` 的完整类型、构造方

| 事实 | 证据 |
|---|---|
| 字段定义在 `claurst-tools` crate 的 `ToolContext` 里 | `src-rust/crates/tools/src/lib.rs:652` — `pub mcp_manager: Option<Arc<claurst_mcp::McpManager>>` |
| `McpManager` 定义在 `claurst-mcp` crate | `src-rust/crates/mcp/src/lib.rs:1099` |
| `McpManager` 的构造入口 | `src-rust/crates/mcp/src/lib.rs:1197` `start(&[McpServerConfig]) -> Arc<Self>`（同步，后台并发连接）；`:1245` `connect_all(...).await`（等全部连完/失败） |
| 运行时重连 / 关闭 | `:1382` `reconnect(name)`；`:1584` `shutdown()` |
| 配置结构 `McpServerConfig` | `src-rust/crates/core/src/lib.rs:1694`（字段：`name/command/args/env/url/type/headers/connect_timeout_ms/catalog_timeout_ms`） |
| 谁负责构造：CLI 的参考实现 | `src-rust/crates/cli/src/main.rs:1111` `start_mcp_manager()` → `McpManager::start(servers)` |
| ACP 运行时的参考实现 | `src-rust/crates/acp/src/runtime.rs:177` `build_mcp_manager()` → `McpManager::connect_all(&decision.allowed).await` |
| 会话工具如何并入 MCP 工具 | `src-rust/crates/cli/src/main.rs:1136` `build_tools_with_mcp()` 追加 `claurst_tools::mcp_tools(manager_arc)` |
| 运行时增删 server 的方式 | 无 `add_server`；CLI 的 `/mcp add` 是**整体重建 manager 再替换**：`src-rust/crates/cli/src/main.rs:4899-4953` |
| Veyl 唯一断点 | `src-tauri/src/claurst_session/mod.rs:386` — `mcp_manager: None` |

### Q2. claurst 是否自带 MCP 客户端、传输、动态发现

**是，自带完整客户端。** crate 头注释直接写明实现范围（`src-rust/crates/mcp/src/lib.rs:1-16`）：JSON-RPC 2.0、`initialize`、`tools/list`、`tools/call`、资源、prompts、stdio + HTTP/SSE。

| 能力 | 证据 |
|---|---|
| 依赖官方 `rmcp 1.4.0`（client + 两种 transport） | `src-rust/crates/mcp/Cargo.toml` — `features = ["client", "auth", "transport-child-process", "transport-streamable-http-client-reqwest", ...]` |
| 传输分发：`stdio` / `sse` / `http` | `src-rust/crates/mcp/src/lib.rs:848-929`（`McpClient::connect` → `match config.server_type.as_str()` 在 `:861`） |
| Streamable HTTP + 协议版本回退 | `src-rust/crates/mcp/src/lib.rs:636-645` 定义版本常量；`:881` 逐版本尝试 `connect_http` |
| `initialize` 握手 | `src-rust/crates/mcp/src/rmcp_backend.rs:193` `handler.serve(transport)`（rmcp 的 `ServiceExt::serve` 内含 initialize/initialized） |
| `tools/list` | `src-rust/crates/mcp/src/rmcp_backend.rs:551`；上层 `McpClient::list_tools` `lib.rs:948` |
| `tools/call` | `McpClient::call_tool` `lib.rs:952`；按 exposed name 路由 `McpManager::call_tool` `lib.rs:1693` |
| 运行时动态发现（`notifications/tools/list_changed`） | `lib.rs:1458` 监听通知；`:1483` `refresh_tools()` 重新 `tools/list` 并 `rebuild_tools()` |
| 远程 server 失败后自动重试 | `lib.rs:1252-1260` 注释与实现：每 60s 重试直到连上 |
| 三种传输的具体构��� | `stdio` `rmcp_backend.rs:115`；`http` `:135`；legacy `sse` `:158` |

结论：`initialize → tools/list → tools/call` 三条**全部现成**，且 HTTP 走的是官方 rmcp 的 Streamable HTTP 客户端，正是我们远端 agent 需要的形态。

### Q3. 现有原生工具如何注册给 AI、执行入口、确认卡

**注册链路（Veyl 侧）：**

1. `AivpnSession::new` 调 `session_tools(services)`：`src-tauri/src/claurst_session/mod.rs:345`
2. `session_tools` = `crate::tools::vpn_tools(services)` + `base_file_tools()`：`mod.rs:76-80`
3. `vpn_tools` 逐一手工 `Box::new(...)` 注册全部 Veyl 工具：`src-tauri/src/tools/mod.rs:154-203`
4. 工具列表存进 `AivpnSession.tools`（构造后不再变）：`mod.rs:271`
5. 发请求时传给 `run_query_loop(..., &self.tools, ...)`：`mod.rs:679`；签名 `tools: &[Box<dyn Tool>]` 在 `src-rust/crates/query/src/lib.rs:572`

**变成模型可见 schema：**

- query 循环把每个 `Tool` 转成 `ApiToolDefinition`：`src-rust/crates/query/src/lib.rs:1024-1031`
  ```rust
  tools.iter()
      .filter(|t| !tool_ctx.tool_is_disallowed(t.name()))
      .map(|t| ApiToolDefinition::from(&t.to_definition()))
  ```

**执行入口：**

- 模型返回 `tool_use` 后，由 query 循环按名字找到 `Box<dyn Tool>` 并调用 `tool.execute(input, ctx)`（`Tool` trait 定义在 `crates/tools/src/lib.rs`）。
- Veyl 侧在事件消费器里记录并上报 `tool-call-start`：`src-tauri/src/claurst_session/mod.rs:567`、`:903` `record_tool_call_start`。

**确认卡（UI 侧）机制：**

- **全局审批已移除**：`AivpnPermissionHandler::check_permission` 永远返回 `Allow`（`src-tauri/src/agent/permission_handler.rs:21-22`）。所以**不是**靠 permission handler弹卡。
- 真正的确认卡是**工具自己发起**的：工具在 `execute` 里调 `questions::register_with(session_id, request_id, UserQuestionEvent, Some(QuestionExtras { kind, details, default_index, ... }))`（`src-tauri/src/agent/questions.rs:242`），前端收到 `ask-user-question` 事件（`src-tauri/src/claurst_session/events.rs:25`，emit 在 `questions.rs:324`）后渲染成带按钮的卡片。
- 参考实现：`CoreUpgradeTool::ask_for_confirmation`（`src-tauri/src/tools/core_upgrade.rs:298-350`），默认焦点是「取消」，15 分钟超时按取消处理。
- 注意：**MCP 工具走的是 `McpToolWrapper`，它只调 `ctx.check_permission`**（`src-rust/crates/tools/src/mcp_tool.rs:67`），在 Veyl 里恒为 `Allow`，**不会**弹我们那张风格统一的确认卡。这是路线 A 的一个隐性 UX 债。

### Q4. 两条路线的最小改动

#### 路线 A：接 `mcp_manager`（MCP 工具与原生工具并列）

**做法：** 在会话创建时，为每个节点 agent 构造一个 `McpServerConfig { type: "http", url, headers: { Authorization: "Bearer …" } }`，`McpManager::connect_all(...)` 等待连接，把 manager 放进 `ToolContext.mcp_manager`，并把 `claurst_tools::mcp_tools(&manager)` 追加到 `session_tools`。

**文件级改动清单（预估）：**

| 文件 | 改动 | 量级 |
|---|---|---|
| `src-tauri/Cargo.toml` | 加 `rmcp`（自签 TLS 场景，见 §4.1）或 `claurst-mcp`（公共 CA 场景） | 1–3 行 |
| `src-tauri/src/agent/mod.rs` | `AivpnSession::new` 前先异步建 manager（`new` 目前是同步，需改成接收 `Option<Arc<McpManager>>` 或改 async） | ~30–60 行 |
| `src-tauri/src/claurst_session/mod.rs` | `session_tools(services, manager)` 追加 `mcp_tools`；`ToolContext.mcp_manager = Some(manager)`（替换 `:386`） | ~20–40 行 |
| `src-tauri/src/tools/services.rs` + 真实实现 | 新增 `node_agent_mcp_configs() -> Vec<McpServerConfig>`，暴露节点 agent 地址与 token | ~40–80 行 |
| 测试 | manager 构造/工具出现/断线行为 | ~60–120 行 |

**总预估：约 150–300 行。**

**风险：**

- **会话工具冻结**：`AivpnSession.tools` 构造后不变（`:271`）；`mcp_tools()` 是**快照**（`crates/tools/src/mcp_tool.rs:20` 遍历当前 `all_tool_definitions`）。所以必须先 `connect_all().await` 再建工具，否则一个工具都没有。
- **节点增删要重建会话**：`McpManager` 没有 `add_server`；只能重建 manager + 重建 Session（CLI 就是这么做的，`main.rs:4899-4953`）。
- **建会话被网络阻塞**：`connect_all` 会等每个 server 的连接/握手超时（默认 connect 10s，`lib.rs:126-140`），节点多时首条消息会明显变慢。
- **工具名爆炸 + 全局可见**：每个节点一个 server，模型看到 `mcp__node_<id>__rotate_credentials`，用户有多少节点就有多少条。
- **没有统一确认卡**：MCP 工具不会走 `questions::register_with`，旋转端口/密码这种动作没有 Veyl 风格的二次确认。
- **对现有工具链影响**：模型可见工具集变大；原生工具与 MCP 工具权限级别不同（MCP 固定 `Execute`，`mcp_tool.rs:43-45`）。

**收益：** 未来若要做“用户自定义 MCP server”（像 claurst CLI 的 `/mcp`），这条路是正解。

#### 路线 B：不改 `mcp_manager`，加一个原生工具内部走 MCP

**做法：** 新增 `NodeRotateCredentials` 原生工具；`execute` 内部：

1. 从 `VpnToolServices` 取目标节点的 agent 地址 + token；
2. 构造 `McpServerConfig { server_type: "http", url, headers: {Authorization: Bearer …} }`；
3. `claurst_mcp::McpClient::connect(&config, None, McpTimeouts::for_config(&config)).await`（内部即 rmcp 的 `initialize`）——**仅适用于公共 CA 证书**；节点 agent 自签时必须改用 rmcp 的 `with_client(custom_reqwest_client, cfg)`（见 §4.1）；
4. `client.list_tools().await` 校验 `rotate_credentials` 存在（可选但建议，便于诊断）；
5. `client.call_tool("rotate_credentials", Some(json!({...}))).await`；
6. `claurst_mcp::mcp_result_to_output(&result)` 转成工具结果；`client.close().await`；
7. 把新端口/密码写回节点记录，并按现有探测链路验证。

**文件级改动清单（预估）：**

| 文件 | 改动 | 量级 |
|---|---|---|
| `src-tauri/Cargo.toml` | 加 `rmcp`（自签 TLS 场景，见 §4.1）或 `claurst-mcp`（公共 CA 场景） | 1–3 行 |
| `src-tauri/src/tools/node_agent.rs`（新） | 工具实现：schema、确认卡、MCP 客户端调用、结果映射、错误码 | ~200–300 行 |
| `src-tauri/src/tools/mod.rs` | `mod node_agent;` + `vpn_tools` 里 `Box::new(...)` 注册 | ~3 行 |
| `src-tauri/src/tools/services.rs` + 真实实现 | `node_agent_endpoint(server_id)` / `apply_rotated_credentials(...)` | ~50–100 行 |
| `src-tauri/src/tools/boundary_tests.rs` | 输入边界用例 | ~60–100 行 |
| 集成测试 | 起一个本地最小 MCP server，验证 initialize/tools/call | ~80–150 行（可选，首版可先用真节点验收） |

**总预估：约 400–550 行（含服务接线与测试）。**

**风险：**

- 协议细节自己把控。公共 CA 场景可复用 `claurst_mcp::McpClient`；自签 TLS 场景必须直接用 rmcp 的 `with_client`（见 §4.1）。
- 每次旋转一次性连接，有握手延迟（通常 < 1s；可用 `connect_timeout_ms` 收紧）。
- 需要把节点 agent 的地址与 token 安全地下发到客户端（这本来就是手机导出/节点配置已有的信任边界）。
- 与路线 A 相比，模型只看到**一个**工具 `NodeRotateCredentials`，参数里带 `server_id`。

**收益：** 完全贴合 Veyl 现有工具链：确认卡、错误码、审计、超时、测试方式都能复用；不受会话工具冻结影响；节点增删零成本。

---

## 3. 两条路线对比表

| 维度 | 路线 A：接 `mcp_manager` | 路线 B：原生工具内走 MCP |
|---|---|---|
| 改动面 | Cargo + `agent/mod.rs` + `claurst_session` + services | Cargo + 新增 1 个工具 + services + 测试 |
| 预估代码量 | 150–300 行 | 400–550 行 |
| 模型可见形态 | 每个节点一个 `mcp__node_x__rotate_credentials` | 一个 `NodeRotateCredentials`，参数带 `server_id` |
| 动态发现 | 有（`tools/list` + `list_changed`） | 每次调用现连，天然最新 |
| 会话工具冻结 | **冲突**：必须建会话前连好，节点变更要重建会话 | 无影响 |
| 确认卡 | 无（`McpToolWrapper` 只走恒 Allow 的 permission） | 有（复用 `questions::register_with`） |
| 超时/重试策略 | claurst 统一策略（connect 10s / catalog 30s / call 60s；远程 60s 重试） | Veyl 自己定 |
| 节点增删成本 | 重建 manager + 重建 Session | 0 |
| 对现有工具链影响 | 工具集变大；权限级别固定 `Execute` | 只多一个工具，与现有工具一致 |
| 未来扩展（用户自定义 MCP） | 直接可用 | 需另做接入层 |
| 失败可观测性 | 依赖 manager 状态（Veyl 未接状态上报） | 工具错误码 + 审计，与现有链路一致 |
| 首版落地风险 | 中高（会话生命周期改造） | 中（单点新代码，边界清晰） |

---

## 4. 推荐方案

**推荐路线 B。** 理由按权重排序：

1. **会话工具冻结是硬约束**：Veyl 的 `Session.tools` 是构造时快照（`mod.rs:271/:345`），manager 又只支持整体 `start`/`connect_all`，没有 `add_server`。路线 A 要么把建会话变成“先连所有节点”，要么每加一个节点重建整个会话——这两条都侵入主流程。
2. **节点 agent 是“每台服务器一个临时端点”**，不是用户长期维护的 MCP server 列表。把它塞进全局 manager 会让模型工具表随节点数膨胀，且节点销毁后还要清理。
3. **旋转端口/密码是需要确认的高风险动作**，Veyl 已有成熟的确认卡机制（`core_upgrade` 是范例）。路线 B 可以直接复用；路线 A 的 MCP 工具在 Veyl 里会绕过确认卡。
4. **协议层不吃亏**：`claurst_mcp::McpClient` 本身就是 rmcp 后端，`connect()` 内含 `initialize`，`list_tools()` / `call_tool()` 就是 MCP 三条核心方法。route B 并没有“发明协议”，只是换了一种注册方式。
5. 路线 A 的价值在“用户自定义 MCP 工具”，与本需求（单一 `rotate_credentials`）不匹配，留作后续演进更合适。

**关于“只做 initialize / tools/list / tools/call 三条够不够”：**

- **够，而且我们不需要自己实现。** claurst 已提供全部三条；路线 B 复用 `McpClient` 即可。
- 若未来绕过 claurst 直接用裸 `rmcp`：`handler.serve(transport)` 已封装 `initialize` + `notifications/initialized`；Streamable HTTP 下 `tools/call` 即可用；`tools/list` 在“工具名由双方约定”时可省略，但建议保留作为握手后的自检（我们的场景只有一个固定工具，`tools/list` 成本极低，值得留）。
- 真正需要自己实现的边界（若完全不用 claurst 也不用 rmcp）：JSON-RPC 2.0 编解码 + SSE 解析 + `Mcp-Session-Id` 生命周期 + 协议版本协商 + 错误映射，约 600–900 行，**不建议**。

**落地建议（路线 B 的最小实现边界）：**

- 工具名：`NodeRotateCredentials`；输入 `{ server_id: string, reason?: string }`。
- 权限级别：与 `VpnConnect` 同级（写操作）；确认卡默认焦点「取消」。
- 连接参数：`connect_timeout_ms: 5_000`、`catalog_timeout_ms: 10_000`；工具整体超时与现有 `Job`/工具约定一致。
- 结果：结构化返回旧/新端口、旧/新密码是否已写回、是否需要重建配置；错误码沿用 `AivpnError`。
- 安全：token 只从服务层取，不写日志（现有 `redact_json` 已在 `mod.rs:567` 做脱敏）。

---

## 4.1 TLS 与证书信任（自签节点 agent）

> 验证脚本：`scripts/dev/tls-probe/`，一条命令 `cargo run -- run-all`。用与 `src-tauri/Cargo.lock` 相同的 `rmcp 1.8.0` / `reqwest 0.13.5` 复刻 claurst 的传输构造，并起真实 HTTPS MCP server 做四组对照。

### 结论

- **rmcp 支持注入**：`StreamableHttpClientTransport::with_client(client, config)` 接受任意实现 `StreamableHttpClient` 的 HTTP 客户端；`reqwest::Client` 已实现该 trait。因此自定义根证书、自定义 rustls verifier（指纹 pin）都可做。
- **claurst 目前不支持**：`RmcpClientBackend::connect_http` 写死 `StreamableHttpClientTransport::from_config(transport_config)`；`from_config` 内部自建默认 reqwest client，调用方无法替换。`McpServerConfig` 也没有证书/根/指纹字段。
- **可行路径（不改 claurst）**：Veyl 自己用 `rmcp` 直连，`with_client(reqwest_client_with_root_or_pin, cfg)`。这是对 §2 路线 B 的修正：自签 TLS 场景下工具内部**不能**用 `claurst_mcp::McpClient`。
- **若要保留 `claurst_mcp::McpClient`**：需改 claurst，给 `connect_http` 增加 `client: Option<reqwest::Client>` 或 `tls` 配置并用 `with_client`，约 20–40 行。当前约束禁止改子模块，所以首版走 Veyl 侧直连。
- **`headers` 不能替代 TLS 信任**：`McpServerConfig.headers` 只是普通 HTTP 头（可放 `Authorization`）。把指纹放在 header 里只是应用层自证，无法阻止主动 MITM 先用自己的证书截获 token。必须先完成 TLS 验证。
- **明文 HTTP 排除**：`danger_accept_invalid_certs(true)` 技术上能连，但等于放弃 TLS 校验；token 是 root 级操作凭据，不可接受。

### 证据

| 事实 | 证据 |
|---|---|
| claurst 写死 `from_config` | `src-rust/crates/mcp/src/rmcp_backend.rs:153` |
| rmcp 提供 `with_client` | `rmcp-1.8.0/src/transport/streamable_http_client.rs:1054` |
| `reqwest::Client` 实现 `StreamableHttpClient` | `rmcp-1.8.0/src/transport/common/reqwest/streamable_http_client.rs:46` |
| `from_config` 自建默认 client（无自定义根） | 同文件 `:293` → `default_http_client()` `:303` |
| `McpServerConfig` 无 TLS 字段 | `src-rust/crates/core/src/lib.rs:1694`（只有 `headers`） |
| reqwest 支持加根证书 | `reqwest-0.13.5/src/async_impl/client.rs:1911` `add_root_certificate` |
| reqwest 支持自定义 rustls 配置 | 同文件 `:2239` `use_preconfigured_tls` |
| reqwest 默认平台根，加根是“追加” | 同文件 `:758-770`（空根 → platform verifier；非空 → `new_with_extra_roots`） |

> 版本说明：`crates/mcp/Cargo.toml` 声明 `rmcp = "1.4.0"`，但 `src-tauri/Cargo.lock` 实际解析为 **1.8.0**；`with_client` 在 1.8.0 存在。rmcp 1.8 依赖 **reqwest 0.13**（不是 0.12），所以 Veyl 侧直连时也要用 0.13。

### 实测结果（`scripts/dev/tls-probe`，`cargo run -- run-all`）

```
TLS diagnostics (raw GET):
  default:   ... invalid peer certificate: UnknownIssuer
  root:      HTTP 405 Method Not Allowed
  pin ok:    HTTP 405 Method Not Allowed
  pin wrong: ... certificate pin mismatch: got 3300…d08f, expected cc00…d08f

1. default (rmcp from_config, no custom trust)     FAIL
2. custom root CA (add_root_certificate)           OK    tools=["rotate_credentials"]
3. fingerprint pin (correct SHA-256)               OK    tools=["rotate_credentials"]
4. fingerprint pin (wrong SHA-256)                 FAIL
```

服务端同时记录到 TLS alert：`UnknownCA`（默认）与 `HandshakeFailure`（错误指纹）。`HTTP 405` 是正常的：诊断用 GET 打 MCP 端点，TLS 已通过，只是 MCP 只接受 POST。

### 对节点 agent 的落地建议

1. agent 安装时生成 CA + server 证书（或一张自签 leaf），把 **CA PEM** 或 **leaf 指纹**通过 control plane 下发到客户端；不走明文 HTTP。
2. 首版用 `add_root_certificate(CA)`：代码最少；证书轮换时换 CA 即可。
3. 若要“证书可续期但信任不变”，pin **SPKI**（公钥哈希）而不是整张证书；实现方式相同，只是 verifier 里对 `SubjectPublicKeyInfo` 做 SHA-256。
4. Veyl 侧客户端建议放在 `src-tauri/src/tools/node_agent.rs`（或独立 `node_agent_client` 模块），用 `rmcp` 的 `with_client` + `ClientHandler::serve`，不要用 `claurst_mcp::McpClient`。
5. 若后续允许改 claurst：给 `McpServerConfig` 加 `tls`（root PEM / pin）并把 `connect_http` 改成 `with_client`，路线 A 也能支持自签。

---

## 5. 未解问题

1. **agent 的 HTTP 端点与 SS 端口是否同生共死？** 若“端口被封”连带 agent 控制端口也不可达，MCP over HTTP 就救不了，必须走 SSH 隧道或云厂商 API。需要先确认 agent 的监听端口与安全组策略。
2. **agent 的认证形态**：Bearer token 由谁签发、如何轮换？`McpServerConfig.headers` 支持 `${VAR}` 展开，但 Veyl 会话里没有 env 注入通道，需确认是走 header 还是 OAuth（claurst 的 `oauth.rs` 已有能力，但首版建议先用静态 Bearer）。
3. **旋转后谁负责写回**：agent 只返回新端口/密码，还是同时更新本机 Shadowsocks 配置？若只返回，桌面端写回节点记录后如何触发 sing-box 重载（现有 `NodeSwitch`/`ConfigUpdate` 路径是否复用）。
4. **旋转与退款/计费的关系**：现有口径是“不通可重建、当天不退费”（见 `aivpn-node-reachability`）。旋转失败是否等同不可用、要不要自动降级到重建，需要产品拍板。
5. **工具是否需要出现在首启/普通会话**：`NodeRotateCredentials` 可能只在“我的服务器”相关会话或诊断失败后才有意义；是全局注册还是按上下文裁剪（现有工具集没有裁剪机制）。
6. **MCP 客户端的测试替身**：`McpClientBackend` trait 是公开的，但 `McpClient` 的构造走具体 backend；首版集成测试建议起一个本地最小 Streamable HTTP server，而不是 mock。
7. **协议版本**：agent 侧用 rmcp 服务端时默认版本需与客户端回退列表对齐（客户端顺序 `2025-11-25 → 2025-06-18 → 2025-03-26 → 2024-11-05`，`lib.rs:636-645`）。
8. **agent 证书的签发与轮换**：CA/leaf 在安装时生成还是由 control plane 预置？轮换时如何把新 CA 或新指纹安全下发（下发失败会直接断连）？首版建议用 CA 文件而非整张证书指纹，降低轮换成本（见 §4.1）。

---

## 附：关键调用链（便于实现时对照）

```
AivpnSession::new                    src-tauri/src/claurst_session/mod.rs:325
  └─ session_tools(services)         :76-80
       ├─ vpn_tools(services)        src-tauri/src/tools/mod.rs:154
       └─ base_file_tools()          :86-96
  └─ ToolContext { mcp_manager }     :386
send_message
  └─ run_query_loop(&self.tools)     :679
       └─ ApiToolDefinition::from(t.to_definition())   crates/query/src/lib.rs:1024-1031
       └─ tool.execute(input, ctx)

（路线 A 需要在此处插入）
  McpManager::connect_all(configs)    crates/mcp/src/lib.rs:1245
  claurst_tools::mcp_tools(&manager)  crates/tools/src/mcp_tool.rs:20
  ToolContext.mcp_manager = Some(..)  src-tauri/src/claurst_session/mod.rs:386

（路线 B 在此处新增）
  McpClient::connect(&config, ..)     crates/mcp/src/lib.rs:848
    └─ RmcpClientBackend::connect_http  crates/mcp/src/rmcp_backend.rs:135
         └─ handler.serve(transport)    :193   // initialize
  McpClient::list_tools()             crates/mcp/src/lib.rs:948
  McpClient::call_tool("rotate…")     crates/mcp/src/lib.rs:952
  mcp_result_to_output(&result)       crates/mcp/src/lib.rs:2155
  McpClient::close()                  crates/mcp/src/lib.rs:1015
```
