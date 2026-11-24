//! 配置与节点的 AI 工具（`docs/contracts/tools.md` 3.0.0）。

use std::sync::Arc;

use async_trait::async_trait;
use claurst_tools::{PermissionLevel, Tool, ToolContext, ToolResult};
use serde_json::{json, Value};

use super::display::{Changed, Fact, FactKey};
use super::envelope::{self, AivpnError, ToolOutcome};
use super::services::{ConfigUpdateInput, NodeCreateInput, ServiceError, VpnToolServices};

fn failure(error: anyhow::Error) -> AivpnError {
    if let Some(service) = error.downcast_ref::<ServiceError>() {
        let mut mapped = AivpnError::new(&service.code, &service.message);
        mapped.details = service.details.clone();
        return mapped;
    }
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

/// 名称缺失或为空就不推这条 fact：不填中文兜底，句子由前端按语言组装。
fn config_name_fact(data: &Value) -> Option<Fact> {
    data.get("name")
        .and_then(Value::as_str)
        .filter(|name| !name.is_empty())
        .map(|name| Fact::with_params(FactKey::ConfigName, json!({ "name": name })))
}

fn summarise_detail(data: &Value) -> String {
    let name = data.get("name").and_then(Value::as_str).unwrap_or("(未命名)");
    let nodes: Vec<&Value> = data
        .get("nodes")
        .and_then(Value::as_array)
        .map(|items| items.iter().collect())
        .unwrap_or_default();
    let current = data.get("current_node_id").and_then(Value::as_str);
    let mut lines = vec![format!("配置「{name}」：{} 个节点", nodes.len())];
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
        "读取一套配置的节点集、DNS 与布局；不传 config_id 就是当前配置。\n\
         回答「我有几个节点」「当前用的是哪个」时直接不带 id 调用；要测连通性用 NodeProbe。\n\
         配置 ID 只用于你自己匹配，不要念给用户。"
    }

    fn permission_level(&self) -> PermissionLevel {
        PermissionLevel::ReadOnly
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": { "config_id": { "type": "string" } },
            "additionalProperties": false
        })
    }

    async fn execute(&self, input: Value, ctx: &ToolContext) -> ToolResult {
        let config_id = match super::optional_string(&input, "config_id") {
            Ok(value) => value,
            Err(error) => return envelope::finish(ctx, "ConfigDetail", ToolOutcome::fail(error)),
        };
        let outcome = match self.services.config_detail(config_id).await {
            Ok(data) => {
                let nodes = data
                    .get("nodes")
                    .and_then(Value::as_array)
                    .map(|items| items.len())
                    .unwrap_or(0);
                let mut facts: Vec<Fact> = config_name_fact(&data).into_iter().collect();
                facts.push(Fact::with_params(
                    FactKey::ConfigNodeCount,
                    json!({ "count": nodes }),
                ));
                let current = data.get("current_node_id").and_then(Value::as_str);
                if let Some(node_name) = data
                    .get("nodes")
                    .and_then(Value::as_array)
                    .and_then(|items| {
                        items.iter().find(|node| {
                            current.is_some()
                                && node.get("node_id").and_then(Value::as_str) == current
                        })
                    })
                    .and_then(|node| node.get("name"))
                    .and_then(Value::as_str)
                {
                    facts.push(Fact::with_params(
                        FactKey::ConfigCurrentNode,
                        json!({ "name": node_name }),
                    ));
                }
                ToolOutcome::ok(summarise_detail(&data), data).with_facts(facts)
            }
            Err(error) => ToolOutcome::fail(failure(error)),
        };
        envelope::finish(ctx, "ConfigDetail", outcome)
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
        "编辑一套配置（名称 / 分流 / DNS / 节点集）。分流只有 direct / proxy_all 两档。\
         没有 connect_mode：改接管方式必须新建配置。node_ids 是整体替换。\n配置 ID 只用于你自己匹配，不要念给用户。"
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
                "routing_mode": { "type": "string", "enum": ["direct", "proxy_all"] },
                "dns": { "type": "object" },
                "tun_excludes": { "type": "array", "items": { "type": "string" } },
                "node_ids": { "type": "array", "items": { "type": "string" } }
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
                ToolOutcome::fail(AivpnError::new("INVALID_ARGUMENT", "缺少 config_id"))
                    .with_changed(Changed::None),
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
                            return envelope::finish(
                                ctx,
                                "ConfigUpdate",
                                ToolOutcome::fail(error).with_changed(Changed::None),
                            )
                        }
                    },
                    routing_mode: match super::optional_string(&input, "routing_mode") {
                        Ok(value) => value,
                        Err(error) => {
                            return envelope::finish(
                                ctx,
                                "ConfigUpdate",
                                ToolOutcome::fail(error).with_changed(Changed::None),
                            )
                        }
                    },
                    listen_port: None,
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
                    // 分流分类已随 CategoryList / RouteTargetsSet 退出工具面（3.27.0）。
                    targets: None,
                    connect_mode: input
                        .get("connect_mode")
                        .and_then(Value::as_str)
                        .map(str::to_string),
                },
            )
            .await
        {
            Ok(data) => {
                let facts: Vec<Fact> = config_name_fact(&data).into_iter().collect();
                ToolOutcome::ok("配置已更新，下一次连接生效。", data).with_facts(facts)
            }
            Err(error) => ToolOutcome::fail(failure(error)).with_changed(Changed::Unknown),
        };
        envelope::finish(ctx, "ConfigUpdate", outcome)
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
         已连接走 selector 热切，进程不重启、不断流。\n说节点名称，不说节点 ID。"
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
                ))
                .with_changed(Changed::None),
            );
        };
        let outcome = match self.services.node_switch(config_id, node_id).await {
            Ok(data) => {
                let connected = data.get("connected").and_then(Value::as_bool).unwrap_or(false);
                // 幂等：点的就是当前节点，什么都没变。重建窗口里这一刻可能恰好没有连接，
                // 但那不是「改成了下次生效」——不要声称未连接，如实说没变化。
                let node = data.get("node_id").and_then(Value::as_str);
                let unchanged = node.is_some()
                    && node == data.get("previous_node_id").and_then(Value::as_str);
                let (summary, facts) = if unchanged {
                    (
                        "当前节点没有变化。",
                        vec![Fact::with_params(
                            FactKey::ConnectionState,
                            json!({ "state": "unchanged" }),
                        )],
                    )
                } else if connected {
                    (
                        "已切换节点（热切，连接未中断）。",
                        vec![Fact::with_params(
                            FactKey::ConnectionState,
                            json!({ "state": "intact" }),
                        )],
                    )
                } else {
                    (
                        "已切换当前节点（未连接，未启动 VPN）。",
                        vec![Fact::new(FactKey::EffectNextConnect)],
                    )
                };
                ToolOutcome::ok(summary, data).with_display(facts, Changed::None)
            }
            Err(error) => ToolOutcome::fail(failure(error)).with_changed(Changed::Unknown),
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
        "测试单个节点连通性：经运行时真实转发一次请求测延迟（已连接时用当前连接；\
         未连接时临时起一个测速运行时）。结果是三态：能连上、连不上、没测成。\
         节点不可达是正常结果，不算工具错误。\n\
         说「能连上 / 连不上 / 没测成」和毫秒数；没测成时说原因，不要说成连不上。不说 TCP/TLS/握手。"
    }

    fn permission_level(&self) -> PermissionLevel {
        // 探测本身只读，但探不通时会把「已停机销毁」的隧道停掉（2.45.2），
        // 不再是纯只读工具。
        PermissionLevel::Write
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
        // 未连接时要先起临时运行时（8s 上限），再经 Clash 发一次真实请求。
        let mut probed_ok = false;
        let outcome = match tokio::time::timeout(
            std::time::Duration::from_secs(15),
            self.services.node_probe(node_id),
        )
        .await
        {
            Ok(Ok(data)) => {
                let status = data
                    .get("status")
                    .and_then(Value::as_str)
                    .unwrap_or("untested");
                probed_ok = status == "ok";
                let message = data
                    .get("error")
                    .and_then(|error| error.get("message"))
                    .and_then(Value::as_str);
                let (summary, facts) = match status {
                    "ok" => {
                        let latency = data.get("latency_ms").and_then(Value::as_u64).unwrap_or(0);
                        (
                            format!("节点可达，延迟 {latency} ms。"),
                            vec![Fact::with_params(
                                FactKey::ProbeLatencyMs,
                                json!({ "ms": latency }),
                            )],
                        )
                    }
                    "unreachable" => (
                        message.unwrap_or("节点不可达。").to_string(),
                        vec![Fact::new(FactKey::ProbeUnreachable)],
                    ),
                    // 没测成不是「连不通」：ok 仍为 true，只说原因。
                    _ => (
                        message.unwrap_or("暂时测不了，稍后再试。").to_string(),
                        vec![Fact::new(FactKey::ProbeUntested)],
                    ),
                };
                ToolOutcome::ok(summary, data).with_display(facts, Changed::None)
            }
            Ok(Err(error)) => ToolOutcome::fail(failure(error)),
            Err(_) => ToolOutcome::fail(
                AivpnError::new("TIMEOUT", "测速超过 15 秒，稍后再试").retryable(),
            ),
        };
        // 探不通时顺手确认服务器是否已被停机销毁（AI 路径，用户原话：「顺便检查」）。
        // 这里拿不到 `AppState`，所以只依赖服务层；失败一律吞掉，绝不影响探测结果。
        if !probed_ok {
            if let Some(server_id) = crate::agent::server_watch::owned_server_of_node(node_id) {
                // 超时由 `ensure_current_server_alive` 自己包住「取详情 + 重读」；
                // 确定为已销毁后的 `runtime_stop` 丢到后台任务，既不进超时、也不让
                // 本次探测等它（被取消会把运行时卡在 stopping）。
                crate::agent::server_watch::ensure_current_server_alive(
                    Arc::clone(&self.services),
                    &server_id,
                )
                .await;
            }
        }
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
                ToolOutcome::fail(AivpnError::new("INVALID_ARGUMENT", "缺少 url"))
                    .with_changed(Changed::None),
            );
        };
        let config_id = match super::optional_string(&input, "config_id") {
            Ok(value) => value,
            Err(error) => {
                return envelope::finish(
                    ctx,
                    "NodeImportUrl",
                    ToolOutcome::fail(error).with_changed(Changed::None),
                )
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
                let mut facts = Vec::new();
                if imported > 0 {
                    facts.push(Fact::with_params(
                        FactKey::ImportAdded,
                        json!({ "count": imported }),
                    ));
                }
                if skipped > 0 {
                    facts.push(Fact::with_params(
                        FactKey::ImportSkipped,
                        json!({ "count": skipped }),
                    ));
                }
                ToolOutcome::ok(
                    format!("导入 {imported} 个节点，跳过 {skipped} 个。请复述节点名、地址、端口与加密方式给用户确认。"),
                    data,
                )
                .with_display(facts, Changed::None)
            }
            Err(error) => ToolOutcome::fail(failure(error)).with_changed(Changed::Unknown),
        };
        envelope::finish(ctx, "NodeImportUrl", outcome)
    }
}

/// 用户直接粘贴的 `ss://` 分享链接。与 UI 的 `node_import_text` 共用服务层实现。
pub struct NodeImportTextTool {
    services: Arc<dyn VpnToolServices>,
}

impl NodeImportTextTool {
    pub fn new(services: Arc<dyn VpnToolServices>) -> Self {
        Self { services }
    }
}

#[async_trait]
impl Tool for NodeImportTextTool {
    fn name(&self) -> &str {
        "NodeImportText"
    }

    fn description(&self) -> &str {
        "解析用户直接粘贴的 Shadowsocks 分享链接（一行或多行 ss://），导入节点池。\
         逐条解析：坏行只跳过，不影响其余；重复节点会标出来。只解析、不联网。\
         config_id 省略时只进节点池。返回值不含密码；导入成功后要复述节点名、地址、端口与加密方式。"
    }

    fn permission_level(&self) -> PermissionLevel {
        PermissionLevel::Write
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "text": { "type": "string", "maxLength": 65536 },
                "config_id": { "type": "string" }
            },
            "required": ["text"],
            "additionalProperties": false
        })
    }

    async fn execute(&self, input: Value, ctx: &ToolContext) -> ToolResult {
        let Some(text) = input.get("text").and_then(Value::as_str) else {
            return envelope::finish(
                ctx,
                "NodeImportText",
                ToolOutcome::fail(AivpnError::new("INVALID_ARGUMENT", "缺少 text"))
                    .with_changed(Changed::None),
            );
        };
        let config_id = match super::optional_string(&input, "config_id") {
            Ok(value) => value,
            Err(error) => {
                return envelope::finish(
                    ctx,
                    "NodeImportText",
                    ToolOutcome::fail(error).with_changed(Changed::None),
                )
            }
        };

        let outcome = match self.services.node_import_text(config_id, text).await {
            Ok(data) => {
                let imported = data.get("imported").and_then(Value::as_i64).unwrap_or(0);
                let skipped = data
                    .get("skipped")
                    .and_then(Value::as_array)
                    .map(|items| items.len())
                    .unwrap_or(0);
                let mut facts = Vec::new();
                if imported > 0 {
                    facts.push(Fact::with_params(
                        FactKey::ImportAdded,
                        json!({ "count": imported }),
                    ));
                }
                if skipped > 0 {
                    facts.push(Fact::with_params(
                        FactKey::ImportSkipped,
                        json!({ "count": skipped }),
                    ));
                }
                ToolOutcome::ok(
                    format!("导入 {imported} 个节点，跳过 {skipped} 个。请复述节点名、地址、端口与加密方式给用户确认。"),
                    data,
                )
                .with_display(facts, Changed::None)
            }
            Err(error) => ToolOutcome::fail(failure(error)).with_changed(Changed::Unknown),
        };
        envelope::finish(ctx, "NodeImportText", outcome)
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
                    ))
                    .with_changed(Changed::None),
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
                ToolOutcome::fail(AivpnError::new("INVALID_ARGUMENT", "port 不合法"))
                    .with_changed(Changed::None),
            );
        };

        let outcome = match self
            .services
            .node_create(NodeCreateInput {
                config_id: match super::optional_string(&input, "config_id") {
                    Ok(value) => value,
                    Err(error) => {
                        return envelope::finish(
                            ctx,
                            "NodeCreate",
                            ToolOutcome::fail(error).with_changed(Changed::None),
                        )
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
                let name = data
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or("-")
                    .to_string();
                ToolOutcome::ok(format!("节点「{name}」已创建。"), data).with_facts(vec![
                    Fact::with_params(FactKey::NodeName, json!({ "name": name })),
                ])
            }
            Err(error) => ToolOutcome::fail(failure(error)).with_changed(Changed::Unknown),
        };
        envelope::finish(ctx, "NodeCreate", outcome)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 缺字段不推 fact：英文界面不能收到「未命名」这样的中文兜底。
    #[test]
    fn a_missing_config_name_is_not_pushed_as_a_fact() {
        for data in [json!({}), json!({ "name": null }), json!({ "name": "" })] {
            assert!(
                config_name_fact(&data).is_none(),
                "缺名称时不能推 config.name：{data}"
            );
        }
        assert_eq!(
            config_name_fact(&json!({ "name": "东京" })),
            Some(Fact::with_params(
                FactKey::ConfigName,
                json!({ "name": "东京" })
            ))
        );
    }
}
