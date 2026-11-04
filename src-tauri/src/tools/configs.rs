//! 配置与节点的 AI 工具（`docs/contracts/tools.md` 3.0.0）。

use std::sync::Arc;

use async_trait::async_trait;
use claurst_tools::{PermissionLevel, Tool, ToolContext, ToolResult};
use serde_json::{json, Value};

use super::envelope::{self, AivpnError, NextAction, ToolOutcome};
use super::services::{ConfigCreateInput, ConfigUpdateInput, NodeCreateInput, VpnToolServices};

fn failure(error: anyhow::Error) -> AivpnError {
    let text = error.to_string();
    match text.split_once(": ") {
        Some((code, message))
            if !code.is_empty()
                && code
                    .chars()
                    .all(|c| c.is_ascii_uppercase() || c == '_') =>
        {
            AivpnError::new(code, message)
        }
        _ => AivpnError::new("INTERNAL", text),
    }
}

fn summarise_configs(data: &Value) -> String {
    let configs: Vec<&Value> = data
        .get("configs")
        .and_then(Value::as_array)
        .map(|items| items.iter().collect())
        .unwrap_or_default();
    if configs.is_empty() {
        return "本地还没有配置。可以新建一套空配置，或选择用 Veyl 提供的测试节点。".to_string();
    }

    let mut lines = vec![format!("本地有 {} 套配置：", configs.len())];
    for config in configs {
        let id = config.get("config_id").and_then(Value::as_str).unwrap_or("-");
        let name = config.get("name").and_then(Value::as_str).unwrap_or("(未命名)");
        let nodes = config.get("node_count").and_then(Value::as_i64).unwrap_or(0);
        let route = config.get("routing_mode").and_then(Value::as_str).unwrap_or("-");
        let active = config.get("is_active").and_then(Value::as_bool).unwrap_or(false);
        lines.push(format!(
            "- {id} | {name} | {nodes} 个节点 | {route}{}",
            if active { " | 当前配置" } else { "" }
        ));
    }
    lines.push("用户用名称指代配置时，先用本工具匹配出 config_id，不要猜 id。".to_string());
    lines.join("\n")
}

/// 建配置的摘要必须带 `config_id`：模型拿不到 id 就只能再调一次 `ConfigList`
/// 去翻，白烧一轮。节点名也一并给出，下一步连上后要向用户报是哪条线路。
fn summarise_created(data: &Value) -> String {
    let id = data.get("config_id").and_then(Value::as_str).unwrap_or("-");
    let name = data.get("name").and_then(Value::as_str).unwrap_or("(未命名)");
    let nodes: Vec<&str> = data
        .get("nodes")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|node| node.get("name").and_then(Value::as_str))
                .collect()
        })
        .unwrap_or_default();
    if nodes.is_empty() {
        return format!("配置已创建：{id}，名称「{name}」，暂未添加节点。");
    }
    let shown = nodes.iter().take(3).copied().collect::<Vec<_>>().join("、");
    let list = if nodes.len() > 3 {
        format!("{shown} 等 {} 个", nodes.len())
    } else {
        shown
    };
    format!(
        "配置已创建：{id}，名称「{name}」，{} 个节点（{list}）。",
        nodes.len()
    )
}

fn summarise_detail(data: &Value) -> String {
    let name = data.get("name").and_then(Value::as_str).unwrap_or("(未命名)");
    let nodes: Vec<&Value> = data
        .get("nodes")
        .and_then(Value::as_array)
        .map(|items| items.iter().collect())
        .unwrap_or_default();
    let current = data.get("current_node_id").and_then(Value::as_str);
    let mut lines = vec![format!(
        "配置「{name}」：{} 个节点，监听 {}",
        nodes.len(),
        data.get("listen_port")
            .and_then(Value::as_u64)
            .map(|port| port.to_string())
            .unwrap_or_else(|| "自动".into())
    )];
    for node in nodes {
        let id = node.get("node_id").and_then(Value::as_str).unwrap_or("-");
        let node_name = node.get("name").and_then(Value::as_str).unwrap_or("-");
        let server = node.get("server").and_then(Value::as_str).unwrap_or("-");
        let port = node.get("port").and_then(Value::as_u64).unwrap_or(0);
        let mark = if current == Some(id) { " | 当前" } else { "" };
        lines.push(format!("- {id} | {node_name} | {server}:{port}{mark}"));
    }
    lines.join("\n")
}

pub struct ConfigListTool {
    services: Arc<dyn VpnToolServices>,
}

impl ConfigListTool {
    pub fn new(services: Arc<dyn VpnToolServices>) -> Self {
        Self { services }
    }
}

#[async_trait]
impl Tool for ConfigListTool {
    fn name(&self) -> &str {
        "ConfigList"
    }

    fn description(&self) -> &str {
        "列出本地全部配置（不联网）。返回 config_id、名称、节点数与分流策略；\
         不含节点明细与凭据。用户用名称指代配置时，先匹配出 config_id，不要猜。"
    }

    fn permission_level(&self) -> PermissionLevel {
        PermissionLevel::ReadOnly
    }

    fn input_schema(&self) -> Value {
        json!({ "type": "object", "properties": {}, "additionalProperties": false })
    }

    async fn execute(&self, _input: Value, ctx: &ToolContext) -> ToolResult {
        let outcome = match self.services.config_list().await {
            Ok(data) => ToolOutcome::ok(summarise_configs(&data), data),
            Err(error) => ToolOutcome::fail(failure(error)),
        };
        envelope::finish(ctx, "ConfigList", outcome)
    }
}

pub struct ConfigDetailTool {
    services: Arc<dyn VpnToolServices>,
}

impl ConfigDetailTool {
    pub fn new(services: Arc<dyn VpnToolServices>) -> Self {
        Self { services }
    }
}

#[async_trait]
impl Tool for ConfigDetailTool {
    fn name(&self) -> &str {
        "ConfigDetail"
    }

    fn description(&self) -> &str {
        "读取一套配置的节点集、DNS、端口与布局。不含密码；要测连通性用 NodeProbe。"
    }

    fn permission_level(&self) -> PermissionLevel {
        PermissionLevel::ReadOnly
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": { "config_id": { "type": "string" } },
            "required": ["config_id"],
            "additionalProperties": false
        })
    }

    async fn execute(&self, input: Value, ctx: &ToolContext) -> ToolResult {
        let Some(config_id) = input.get("config_id").and_then(Value::as_str) else {
            return envelope::finish(
                ctx,
                "ConfigDetail",
                ToolOutcome::fail(AivpnError::new("INVALID_ARGUMENT", "缺少 config_id")),
            );
        };
        let outcome = match self.services.config_detail(config_id).await {
            Ok(data) => ToolOutcome::ok(summarise_detail(&data), data),
            Err(error) => ToolOutcome::fail(failure(error)),
        };
        envelope::finish(ctx, "ConfigDetail", outcome)
    }
}

pub struct ConfigCreateTool {
    services: Arc<dyn VpnToolServices>,
}

impl ConfigCreateTool {
    pub fn new(services: Arc<dyn VpnToolServices>) -> Self {
        Self { services }
    }
}

#[async_trait]
impl Tool for ConfigCreateTool {
    fn name(&self) -> &str {
        "ConfigCreate"
    }

    fn description(&self) -> &str {
        "新建一套配置。source = seed 绑定当前种子的全部节点；不传 source 则创建空配置。\
         connect_mode 与 routing_mode 必须显式给出，没有默认值。"
    }

    fn permission_level(&self) -> PermissionLevel {
        PermissionLevel::Write
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "name": { "type": "string", "maxLength": 40 },
                "connect_mode": { "type": "string", "enum": ["system_proxy", "tun"] },
                "routing_mode": { "type": "string", "enum": ["direct", "proxy_all", "proxy_selected"] },
                "source": { "type": "string", "enum": ["seed", "empty"] },
                "node_ids": { "type": "array", "items": { "type": "string" } },
                "targets": { "type": "array", "items": { "type": "string" } },
                "listen_port": { "type": "integer", "minimum": 1000, "maximum": 65535 },
                "dns": { "type": "object" },
                "tun_excludes": { "type": "array", "items": { "type": "string" } }
            },
            "required": ["name", "connect_mode", "routing_mode"],
            "additionalProperties": false
        })
    }

    async fn execute(&self, input: Value, ctx: &ToolContext) -> ToolResult {
        let Some(name) = input.get("name").and_then(Value::as_str) else {
            return envelope::finish(
                ctx,
                "ConfigCreate",
                ToolOutcome::fail(AivpnError::new("INVALID_ARGUMENT", "缺少 name")),
            );
        };
        let Some(connect_mode) = input.get("connect_mode").and_then(Value::as_str) else {
            return envelope::finish(
                ctx,
                "ConfigCreate",
                ToolOutcome::fail(AivpnError::new("INVALID_ARGUMENT", "缺少 connect_mode")),
            );
        };
        let Some(routing_mode) = input.get("routing_mode").and_then(Value::as_str) else {
            return envelope::finish(
                ctx,
                "ConfigCreate",
                ToolOutcome::fail(AivpnError::new("INVALID_ARGUMENT", "缺少 routing_mode")),
            );
        };

        let source = match super::optional_string(&input, "source") {
            Ok(value) => value,
            Err(error) => return envelope::finish(ctx, "ConfigCreate", ToolOutcome::fail(error)),
        };
        // 唯一的硬门禁：`seed` 会把用户接到我们的服务器上，必须先问过并得到明确选择。
        // 空配置与 nodeIds 这两条目前只有提示词约束——它们不涉及我们的服务器，
        // 加门禁的成本大于收益（见 `SAFETY_RULES` 第 2 条）。
        if source.as_deref() == Some("seed") {
            let granted = crate::tools::policy::current_request_id(&ctx.session_id)
                .map(|request_id| {
                    crate::agent::questions::seed_consent_granted(&ctx.session_id, &request_id)
                })
                .unwrap_or(false);
            if !granted {
                return envelope::finish(
                    ctx,
                    "ConfigCreate",
                    ToolOutcome::fail(
                        AivpnError::new(
                            "PRECONDITION_FAILED",
                            "还没有确认节点来源：先用 AskUserQuestion 问用户「节点从哪来」，\
                             用户选了「用 Veyl 提供的测试节点（仅供试用）」之后才能用测试节点",
                        )
                        .with_details(json!({ "reason": "seed_source_not_confirmed" })),
                    ),
                );
            }
        }

        let node_ids = input.get("node_ids").and_then(Value::as_array).map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect::<Vec<_>>()
        });

        let outcome = match self
            .services
            .config_create(ConfigCreateInput {
                name: name.to_string(),
                connect_mode: connect_mode.to_string(),
                routing_mode: routing_mode.to_string(),
                source,
                node_ids,
                targets: input.get("targets").and_then(Value::as_array).map(|items| {
                    items
                        .iter()
                        .filter_map(Value::as_str)
                        .map(str::to_string)
                        .collect()
                }),
                listen_port: input
                    .get("listen_port")
                    .and_then(Value::as_u64)
                    .and_then(|port| u16::try_from(port).ok()),
                dns: input.get("dns").cloned(),
                tun_excludes: input.get("tun_excludes").and_then(Value::as_array).map(|items| {
                    items
                        .iter()
                        .filter_map(Value::as_str)
                        .map(str::to_string)
                        .collect()
                }),
            })
            .await
        {
            Ok(data) => {
                let config_id = data.get("config_id").cloned().unwrap_or(Value::Null);
                ToolOutcome::ok(summarise_created(&data), data).with_next(NextAction {
                    label: "连接".to_string(),
                    tool: "VpnConnect".to_string(),
                    args: json!({ "config_id": config_id }),
                })
            }
            Err(error) => ToolOutcome::fail(failure(error)),
        };
        envelope::finish(ctx, "ConfigCreate", outcome)
    }
}

pub struct ConfigUpdateTool {
    services: Arc<dyn VpnToolServices>,
}

impl ConfigUpdateTool {
    pub fn new(services: Arc<dyn VpnToolServices>) -> Self {
        Self { services }
    }
}

#[async_trait]
impl Tool for ConfigUpdateTool {
    fn name(&self) -> &str {
        "ConfigUpdate"
    }

    fn description(&self) -> &str {
        "编辑一套配置（名称 / 分流 / DNS / 端口 / 节点集）。\
         没有 connect_mode：改接管方式必须新建配置。node_ids 是整体替换。"
    }

    fn permission_level(&self) -> PermissionLevel {
        PermissionLevel::Write
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "config_id": { "type": "string" },
                "name": { "type": "string", "maxLength": 40 },
                "routing_mode": { "type": "string", "enum": ["direct", "proxy_all", "proxy_selected"] },
                "listen_port": { "type": "integer", "minimum": 1000, "maximum": 65535 },
                "dns": { "type": "object" },
                "tun_excludes": { "type": "array", "items": { "type": "string" } },
                "node_ids": { "type": "array", "items": { "type": "string" } },
                "targets": { "type": "array", "items": { "type": "string" } }
            },
            "required": ["config_id"],
            "additionalProperties": false
        })
    }

    async fn execute(&self, input: Value, ctx: &ToolContext) -> ToolResult {
        let Some(config_id) = input.get("config_id").and_then(Value::as_str) else {
            return envelope::finish(
                ctx,
                "ConfigUpdate",
                ToolOutcome::fail(AivpnError::new("INVALID_ARGUMENT", "缺少 config_id")),
            );
        };
        let node_ids = input.get("node_ids").and_then(Value::as_array).map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect::<Vec<_>>()
        });
        let outcome = match self
            .services
            .config_update(
                config_id,
                ConfigUpdateInput {
                    name: match super::optional_string(&input, "name") {
                        Ok(value) => value,
                        Err(error) => {
                            return envelope::finish(ctx, "ConfigUpdate", ToolOutcome::fail(error))
                        }
                    },
                    routing_mode: match super::optional_string(&input, "routing_mode") {
                        Ok(value) => value,
                        Err(error) => {
                            return envelope::finish(ctx, "ConfigUpdate", ToolOutcome::fail(error))
                        }
                    },
                    listen_port: input
                        .get("listen_port")
                        .and_then(Value::as_u64)
                        .and_then(|port| u16::try_from(port).ok())
                        .map(Some),
                    dns: input.get("dns").cloned(),
                    tun_excludes: input
                        .get("tun_excludes")
                        .and_then(Value::as_array)
                        .map(|items| {
                            items
                                .iter()
                                .filter_map(Value::as_str)
                                .map(str::to_string)
                                .collect()
                        }),
                    node_ids,
                    targets: input.get("targets").and_then(Value::as_array).map(|items| {
                        items
                            .iter()
                            .filter_map(Value::as_str)
                            .map(str::to_string)
                            .collect()
                    }),
                    connect_mode: input
                        .get("connect_mode")
                        .and_then(Value::as_str)
                        .map(str::to_string),
                },
            )
            .await
        {
            Ok(data) => ToolOutcome::ok("配置已更新，下一次连接生效。", data),
            Err(error) => ToolOutcome::fail(failure(error)),
        };
        envelope::finish(ctx, "ConfigUpdate", outcome)
    }
}

pub struct ConfigDeleteTool {
    services: Arc<dyn VpnToolServices>,
}

impl ConfigDeleteTool {
    pub fn new(services: Arc<dyn VpnToolServices>) -> Self {
        Self { services }
    }
}

#[async_trait]
impl Tool for ConfigDeleteTool {
    fn name(&self) -> &str {
        "ConfigDelete"
    }

    fn description(&self) -> &str {
        "删除一套配置。幂等；正在连接的配置不能删。节点与密码留在共享池里。"
    }

    fn permission_level(&self) -> PermissionLevel {
        PermissionLevel::Write
    }

    fn self_gates(&self) -> bool {
        true
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": { "config_id": { "type": "string" } },
            "required": ["config_id"],
            "additionalProperties": false
        })
    }

    async fn execute(&self, input: Value, ctx: &ToolContext) -> ToolResult {
        let Some(config_id) = input.get("config_id").and_then(Value::as_str) else {
            return envelope::finish(
                ctx,
                "ConfigDelete",
                ToolOutcome::fail(AivpnError::new("INVALID_ARGUMENT", "config_id 不能为空")),
            );
        };
        let outcome = match self.services.config_delete(config_id).await {
            Ok(data) => ToolOutcome::ok("配置已删除。", data),
            Err(error) => ToolOutcome::fail(failure(error)),
        };
        envelope::finish(ctx, "ConfigDelete", outcome)
    }
}

pub struct NodeSwitchTool {
    services: Arc<dyn VpnToolServices>,
}

impl NodeSwitchTool {
    pub fn new(services: Arc<dyn VpnToolServices>) -> Self {
        Self { services }
    }
}

#[async_trait]
impl Tool for NodeSwitchTool {
    fn name(&self) -> &str {
        "NodeSwitch"
    }

    fn description(&self) -> &str {
        "切换一套配置的当前节点。未连接只改选择，不启动 VPN；\
         已连接走 selector 热切，进程不重启、不断流。"
    }

    fn permission_level(&self) -> PermissionLevel {
        PermissionLevel::Execute
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "config_id": { "type": "string" },
                "node_id": { "type": "string" }
            },
            "required": ["config_id", "node_id"],
            "additionalProperties": false
        })
    }

    async fn execute(&self, input: Value, ctx: &ToolContext) -> ToolResult {
        let (Some(config_id), Some(node_id)) = (
            input.get("config_id").and_then(Value::as_str),
            input.get("node_id").and_then(Value::as_str),
        ) else {
            return envelope::finish(
                ctx,
                "NodeSwitch",
                ToolOutcome::fail(AivpnError::new(
                    "INVALID_ARGUMENT",
                    "缺少 config_id 或 node_id",
                )),
            );
        };
        let outcome = match self.services.node_switch(config_id, node_id).await {
            Ok(data) => {
                let connected = data.get("connected").and_then(Value::as_bool).unwrap_or(false);
                ToolOutcome::ok(
                    if connected {
                        "已切换节点并重连。"
                    } else {
                        "已切换当前节点（未连接，未启动 VPN）。"
                    },
                    data,
                )
            }
            Err(error) => ToolOutcome::fail(failure(error)),
        };
        envelope::finish(ctx, "NodeSwitch", outcome)
    }
}

pub struct NodeProbeTool {
    services: Arc<dyn VpnToolServices>,
}

impl NodeProbeTool {
    pub fn new(services: Arc<dyn VpnToolServices>) -> Self {
        Self { services }
    }
}

#[async_trait]
impl Tool for NodeProbeTool {
    fn name(&self) -> &str {
        "NodeProbe"
    }

    fn description(&self) -> &str {
        "测试单个节点连通性。已连接且是当前节点时走 Clash API 延迟；\
         其余情况对 server:port 做 3 秒 TCP 握手，不启动运行时。\
         节点不可达是正常结果，不算工具错误。"
    }

    fn permission_level(&self) -> PermissionLevel {
        PermissionLevel::ReadOnly
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "node_id": { "type": "string" }
            },
            "required": ["node_id"],
            "additionalProperties": false
        })
    }

    async fn execute(&self, input: Value, ctx: &ToolContext) -> ToolResult {
        let Some(node_id) = input.get("node_id").and_then(Value::as_str) else {
            return envelope::finish(
                ctx,
                "NodeProbe",
                ToolOutcome::fail(AivpnError::new("INVALID_ARGUMENT", "缺少 node_id")),
            );
        };
        let outcome = match self.services.node_probe(node_id).await {
            Ok(data) => {
                let reachable = data.get("reachable").and_then(Value::as_bool).unwrap_or(false);
                let summary = if reachable {
                    format!(
                        "节点可达，延迟 {} ms。",
                        data.get("latency_ms").and_then(Value::as_u64).unwrap_or(0)
                    )
                } else {
                    data.get("error")
                        .and_then(|error| error.get("message"))
                        .and_then(Value::as_str)
                        .unwrap_or("节点不可达。")
                        .to_string()
                };
                ToolOutcome::ok(summary, data)
            }
            Err(error) => ToolOutcome::fail(failure(error)),
        };
        envelope::finish(ctx, "NodeProbe", outcome)
    }
}

pub struct NodeImportUrlTool {
    services: Arc<dyn VpnToolServices>,
}

impl NodeImportUrlTool {
    pub fn new(services: Arc<dyn VpnToolServices>) -> Self {
        Self { services }
    }
}

#[async_trait]
impl Tool for NodeImportUrlTool {
    fn name(&self) -> &str {
        "NodeImportUrl"
    }

    fn description(&self) -> &str {
        "从 HTTPS 订阅 URL 解析 base64 编码的 ss:// 多节点列表并导入。\
         只解析、不连接；config_id 省略时只进节点池。\
         返回值不含密码；解析结果要复述给用户确认 method 与 port。"
    }

    fn permission_level(&self) -> PermissionLevel {
        PermissionLevel::Write
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "url": { "type": "string", "format": "uri" },
                "config_id": { "type": "string" }
            },
            "required": ["url"],
            "additionalProperties": false
        })
    }

    async fn execute(&self, input: Value, ctx: &ToolContext) -> ToolResult {
        let Some(url) = input.get("url").and_then(Value::as_str) else {
            return envelope::finish(
                ctx,
                "NodeImportUrl",
                ToolOutcome::fail(AivpnError::new("INVALID_ARGUMENT", "缺少 url")),
            );
        };
        let config_id = match super::optional_string(&input, "config_id") {
            Ok(value) => value,
            Err(error) => {
                return envelope::finish(ctx, "NodeImportUrl", ToolOutcome::fail(error))
            }
        };

        let outcome = match self.services.node_import_url(config_id, url).await {
            Ok(data) => {
                let imported = data.get("imported").and_then(Value::as_i64).unwrap_or(0);
                let skipped = data
                    .get("skipped")
                    .and_then(Value::as_array)
                    .map(|items| items.len())
                    .unwrap_or(0);
                ToolOutcome::ok(
                    format!("导入 {imported} 个节点，跳过 {skipped} 个。请复述节点名、地址、端口与加密方式给用户确认。"),
                    data,
                )
            }
            Err(error) => ToolOutcome::fail(failure(error)),
        };
        envelope::finish(ctx, "NodeImportUrl", outcome)
    }
}

pub struct NodeCreateTool {
    services: Arc<dyn VpnToolServices>,
}

impl NodeCreateTool {
    pub fn new(services: Arc<dyn VpnToolServices>) -> Self {
        Self { services }
    }
}

#[async_trait]
impl Tool for NodeCreateTool {
    fn name(&self) -> &str {
        "NodeCreate"
    }

    fn description(&self) -> &str {
        "手动创建一个 Shadowsocks 节点。密码只进本地加密文件，返回值不含密码。\
         config_id 指定时追加到该配置；不指定只进节点池。不自动连接。"
    }

    fn permission_level(&self) -> PermissionLevel {
        PermissionLevel::Write
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "name": { "type": "string", "maxLength": 64 },
                "server": { "type": "string" },
                "port": { "type": "integer", "minimum": 1, "maximum": 65535 },
                "method": { "type": "string" },
                "password": { "type": "string", "sensitive": true, "maxLength": 256 },
                "config_id": { "type": "string" }
            },
            "required": ["name", "server", "port", "method", "password"],
            "additionalProperties": false
        })
    }

    async fn execute(&self, input: Value, ctx: &ToolContext) -> ToolResult {
        let required = ["name", "server", "method", "password"];
        for field in required {
            if input.get(field).and_then(Value::as_str).is_none() {
                return envelope::finish(
                    ctx,
                    "NodeCreate",
                    ToolOutcome::fail(AivpnError::new(
                        "INVALID_ARGUMENT",
                        format!("缺少 {field}"),
                    )),
                );
            }
        }
        let Some(port) = input
            .get("port")
            .and_then(Value::as_u64)
            .and_then(|port| u16::try_from(port).ok())
        else {
            return envelope::finish(
                ctx,
                "NodeCreate",
                ToolOutcome::fail(AivpnError::new("INVALID_ARGUMENT", "port 不合法")),
            );
        };

        let outcome = match self
            .services
            .node_create(NodeCreateInput {
                config_id: match super::optional_string(&input, "config_id") {
                    Ok(value) => value,
                    Err(error) => {
                        return envelope::finish(ctx, "NodeCreate", ToolOutcome::fail(error))
                    }
                },
                name: input["name"].as_str().unwrap_or_default().to_string(),
                server: input["server"].as_str().unwrap_or_default().to_string(),
                port,
                password: input["password"].as_str().unwrap_or_default().to_string(),
                method: input["method"].as_str().unwrap_or_default().to_string(),
            })
            .await
        {
            Ok(data) => {
                let name = data.get("name").and_then(Value::as_str).unwrap_or("-");
                ToolOutcome::ok(format!("节点「{name}」已创建。"), data)
            }
            Err(error) => ToolOutcome::fail(failure(error)),
        };
        envelope::finish(ctx, "NodeCreate", outcome)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// seed：绑定当前种子的全部节点，摘要要给出 id 和节点名，
    /// 否则模型只能再调一次 `ConfigList` 去找 id。
    #[test]
    fn a_seed_configuration_summary_names_the_id_and_its_nodes() {
        let text = summarise_created(&json!({
            "config_id": "cfg_3f9a",
            "name": "浏览器代理",
            "nodes": [{ "name": "meshflux69" }, { "name": "meshflux10" }],
        }));
        assert!(text.contains("cfg_3f9a"), "{text}");
        assert!(text.contains("浏览器代理"), "{text}");
        assert!(text.contains("2 个节点"), "{text}");
        assert!(text.contains("meshflux69、meshflux10"), "{text}");
    }

    /// empty：先建空配置再加节点，摘要要说明还没有节点。
    #[test]
    fn an_empty_configuration_summary_says_it_has_no_nodes() {
        let text = summarise_created(&json!({
            "config_id": "cfg_empty",
            "name": "我的节点",
            "nodes": [],
        }));
        assert!(text.contains("cfg_empty"), "{text}");
        assert!(text.contains("暂未添加节点"), "{text}");
        assert!(!text.contains("个节点（"), "{text}");
    }

    /// nodeIds：用户自己挑了几个节点建配置。
    #[test]
    fn a_node_ids_configuration_summary_lists_the_picked_node() {
        let text = summarise_created(&json!({
            "config_id": "cfg_own",
            "name": "自己的",
            "nodes": [{ "name": "tokyo-1" }],
        }));
        assert!(text.contains("1 个节点（tokyo-1）"), "{text}");
    }

    #[test]
    fn a_long_seed_list_is_truncated_instead_of_flooding_the_summary() {
        let nodes: Vec<Value> = (0..6)
            .map(|index| json!({ "name": format!("node{index}") }))
            .collect();
        let text = summarise_created(&json!({
            "config_id": "cfg_many",
            "name": "C",
            "nodes": nodes,
        }));
        assert!(text.contains("6 个节点"), "{text}");
        assert!(text.contains("等 6 个"), "{text}");
        assert!(!text.contains("node5"), "超过 3 个就不该再点名：{text}");
    }
}
