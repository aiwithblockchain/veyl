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
        // claurst 不做 schema 校验：schema 外的键必须在这里拒绝，
        // 否则会被静默忽略却回「配置已更新」。
        if let Some(error) = unknown_update_argument(&input) {
            return envelope::finish(
                ctx,
                "ConfigUpdate",
                ToolOutcome::fail(error).with_changed(Changed::None),
            );
        }
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
                    connect_mode: None,
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

/// content 里逐节点明细的上限：订阅可达 1 MB，不能把模型上下文吃满。
const IMPORT_CONTENT_MAX_NODES: usize = 20;

/// 逐节点一行 + 跳过原因汇总 + 末尾计数：模型只看得到 content（`tools.md` §4.10）。
fn import_outcome(data: Value) -> ToolOutcome {
    let imported = data.get("imported").and_then(Value::as_i64).unwrap_or(0);
    let skipped_items = data
        .get("skipped")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let skipped = skipped_items.len() as i64;

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

    let mut lines = Vec::new();
    if let Some(nodes) = data.get("nodes").and_then(Value::as_array) {
        for node in nodes.iter().take(IMPORT_CONTENT_MAX_NODES) {
            lines.push(imported_node_line(node));
        }
        if nodes.len() > IMPORT_CONTENT_MAX_NODES {
            lines.push(format!(
                "…还有 {} 个未列出",
                nodes.len() - IMPORT_CONTENT_MAX_NODES
            ));
        }
    }
    if skipped > 0 {
        let mut counts: std::collections::BTreeMap<String, usize> =
            std::collections::BTreeMap::new();
        for item in &skipped_items {
            let reason = item
                .get("reason")
                .and_then(Value::as_str)
                .unwrap_or("unknown");
            *counts.entry(reason.to_string()).or_default() += 1;
        }
        let summary = counts
            .iter()
            .map(|(reason, count)| format!("{reason} × {count}"))
            .collect::<Vec<_>>()
            .join("、");
        lines.push(format!("跳过原因：{summary}。"));
    }
    lines.push(format!("共导入 {imported} 个节点，跳过 {skipped} 个。"));
    ToolOutcome::ok(lines.join("\n"), data).with_display(facts, Changed::None)
}

/// 节点名来自订阅的 `#fragment`：换行 / 控制字符 / 竖线会破坏行结构，统一折叠。
fn content_text(value: &str) -> String {
    let folded: String = value
        .chars()
        .map(|c| if c.is_control() || c == '|' { ' ' } else { c })
        .collect();
    let trimmed = folded.split_whitespace().collect::<Vec<_>>().join(" ");
    if trimmed.is_empty() {
        "-".to_string()
    } else {
        trimmed
    }
}

/// 新节点一行：名称 | server:port | 加密方式（不含密码）。
fn imported_node_line(node: &Value) -> String {
    let name = content_text(node.get("name").and_then(Value::as_str).unwrap_or("-"));
    let server = content_text(node.get("server").and_then(Value::as_str).unwrap_or("-"));
    let port = node
        .get("port")
        .and_then(Value::as_u64)
        .map(|value| value.to_string())
        .unwrap_or_else(|| "-".to_string());
    let method = content_text(node.get("method").and_then(Value::as_str).unwrap_or("-"));
    format!("- {name} | {server}:{port} | {method}")
}

fn invalid(reason: &str, message: &str) -> AivpnError {
    AivpnError::new("INVALID_ARGUMENT", message).with_details(json!({ "reason": reason }))
}

/// `ConfigUpdate` 的白名单：只认 schema 里的六个键。
const CONFIG_UPDATE_KEYS: [&str; 6] = [
    "config_id",
    "name",
    "routing_mode",
    "dns",
    "tun_excludes",
    "node_ids",
];

/// 返回第一个 schema 之外的键；不是对象也算无效参数。
fn unknown_update_argument(input: &Value) -> Option<AivpnError> {
    let Some(object) = input.as_object() else {
        return Some(invalid("invalid_argument", "参数必须是一个对象"));
    };
    // 契约给了专用错误码：字段名没写错，是这个改动必须新建配置。
    if object.contains_key("connect_mode") {
        return Some(invalid("connect_mode_immutable", "改接管方式需要新建配置"));
    }
    object
        .keys()
        .find(|key| !CONFIG_UPDATE_KEYS.contains(&key.as_str()))
        .map(|key| invalid("unknown_argument", &format!("不支持的参数 {key}")))
}

/// 缺来源必填字段：指名道姓，并把来源带上（`tools.md` §4.10）。
fn missing_source_field(source: Option<&str>, field: &str) -> AivpnError {
    AivpnError::new("INVALID_ARGUMENT", format!("缺少 {field}")).with_details(json!({
        "reason": "missing_source_field",
        "source": source,
        "field": field,
    }))
}

/// 节点写入的三条路径合成一个工具（tools.md 3.28.0）：`source` 决定节点从哪来。
pub struct NodeImportTool {
    services: Arc<dyn VpnToolServices>,
}

impl NodeImportTool {
    pub fn new(services: Arc<dyn VpnToolServices>) -> Self {
        Self { services }
    }
}

#[async_trait]
impl Tool for NodeImportTool {
    fn name(&self) -> &str {
        "NodeImport"
    }

    fn description(&self) -> &str {
        "把节点导入节点池，用 source 区分来源：\
         url = HTTPS 订阅（base64 的 ss:// 列表，必填 url）；\
         text = 粘贴的 ss:// 多行文本（必填 text，最多 64 KiB），坏行只跳过、不影响其余，重复节点会标出来；\
         manual = 逐项填写一个节点（必填 name / server / port / method / password），密码只进本地加密文件。\
         只解析、不连接；config_id 省略时只进节点池。返回值不含密码；\
         导入成功后要复述节点名、地址、端口与加密方式。"
    }

    fn permission_level(&self) -> PermissionLevel {
        PermissionLevel::Write
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "source": { "type": "string", "enum": ["url", "text", "manual"] },
                "url": { "type": "string", "format": "uri" },
                "text": { "type": "string", "maxLength": 65536 },
                "name": { "type": "string", "maxLength": 64 },
                "server": { "type": "string" },
                "port": { "type": "integer", "minimum": 1, "maximum": 65535 },
                "method": { "type": "string" },
                "password": { "type": "string", "sensitive": true, "maxLength": 256 },
                "config_id": { "type": "string" }
            },
            "required": ["source"],
            "additionalProperties": false
        })
    }

    async fn execute(&self, input: Value, ctx: &ToolContext) -> ToolResult {
        let reject = |error: AivpnError| {
            envelope::finish(
                ctx,
                "NodeImport",
                ToolOutcome::fail(error).with_changed(Changed::None),
            )
        };
        let Some(object) = input.as_object() else {
            return reject(invalid("invalid_argument", "参数必须是一个对象"));
        };

        // source 单独判类型：数字 / null / 数组都要和「没给」区分开。
        let source = match object.get("source") {
            None | Some(Value::Null) => {
                return reject(missing_source_field(None, "source"));
            }
            Some(Value::String(value))
                if matches!(value.as_str(), "url" | "text" | "manual") =>
            {
                value.clone()
            }
            Some(Value::String(_)) => {
                return reject(invalid(
                    "invalid_argument",
                    "source 只能是 url / text / manual",
                ));
            }
            Some(_) => return reject(invalid("invalid_argument", "source 必须是字符串")),
        };

        // schema 里这些字段都是合法属性，additionalProperties 管不到：
        // 按来源白名单拒绝不属于当前来源的字段（`tools.md` §4.10）。
        let allowed: &[&str] = match source.as_str() {
            "url" => &["source", "url", "config_id"],
            "text" => &["source", "text", "config_id"],
            _ => &[
                "source",
                "name",
                "server",
                "port",
                "method",
                "password",
                "config_id",
            ],
        };
        for key in object.keys() {
            if !allowed.contains(&key.as_str()) {
                return reject(invalid("unknown_argument", &format!("不支持的参数 {key}")));
            }
        }

        // 错类型不能被当成「没给」：本来源的字符串字段先做一次类型校验。
        for field in allowed.iter().copied().filter(|field| {
            *field != "source" && *field != "config_id" && *field != "port"
        }) {
            if object.get(field).is_some() {
                if let Err(error) = super::optional_string(&input, field) {
                    return reject(error);
                }
            }
        }
        let config_id = match super::optional_string(&input, "config_id") {
            Ok(value) => value,
            Err(error) => return reject(error),
        };

        let outcome = match source.as_str() {
            "url" => {
                let Some(url) = input.get("url").and_then(Value::as_str) else {
                    return reject(missing_source_field(Some("url"), "url"));
                };
                match self.services.node_import_url(config_id, url).await {
                    Ok(data) => import_outcome(data),
                    Err(error) => ToolOutcome::fail(failure(error)).with_changed(Changed::Unknown),
                }
            }
            "text" => {
                let Some(text) = input.get("text").and_then(Value::as_str) else {
                    return reject(missing_source_field(Some("text"), "text"));
                };
                match self.services.node_import_text(config_id, text).await {
                    Ok(data) => import_outcome(data),
                    Err(error) => ToolOutcome::fail(failure(error)).with_changed(Changed::Unknown),
                }
            }
            _ => {
                for field in ["name", "server", "method", "password"] {
                    if input.get(field).and_then(Value::as_str).is_none() {
                        return reject(missing_source_field(Some("manual"), field));
                    }
                }
                let Some(port) = input
                    .get("port")
                    .and_then(Value::as_u64)
                    .and_then(|port| u16::try_from(port).ok())
                else {
                    return reject(if input.get("port").is_none() {
                        missing_source_field(Some("manual"), "port")
                    } else {
                        invalid("invalid_argument", "port 不合法")
                    });
                };
                let name = input["name"].as_str().unwrap_or_default().to_string();
                let server = input["server"].as_str().unwrap_or_default().to_string();
                let method = input["method"].as_str().unwrap_or_default().to_string();
                match self
                    .services
                    .node_create(NodeCreateInput {
                        config_id,
                        name: name.clone(),
                        server: server.clone(),
                        port,
                        password: input["password"].as_str().unwrap_or_default().to_string(),
                        method: method.clone(),
                    })
                    .await
                {
                    Ok(data) => {
                        // 服务层会 trim 名字 / 地址并把 method 转小写：以返回值为准，拿不到再退回入参。
                        let shown_name = data
                            .get("name")
                            .and_then(Value::as_str)
                            .unwrap_or(&name)
                            .to_string();
                        let shown_server = data
                            .get("server")
                            .and_then(Value::as_str)
                            .unwrap_or(&server)
                            .to_string();
                        let shown_port = data
                            .get("port")
                            .and_then(Value::as_u64)
                            .map(|value| value.to_string())
                            .unwrap_or_else(|| port.to_string());
                        let shown_method = data
                            .get("method")
                            .and_then(Value::as_str)
                            .unwrap_or(&method)
                            .to_string();
                        ToolOutcome::ok(
                            format!(
                                "节点「{}」已创建：{}:{} | {}。密码只进本地加密文件，未回显。",
                                content_text(&shown_name),
                                content_text(&shown_server),
                                shown_port,
                                content_text(&shown_method)
                            ),
                            data,
                        )
                        .with_facts(vec![Fact::with_params(
                            FactKey::NodeName,
                            json!({ "name": shown_name }),
                        )])
                    }
                    Err(error) => {
                        ToolOutcome::fail(failure(error)).with_changed(Changed::Unknown)
                    }
                }
            }
        };
        envelope::finish(ctx, "NodeImport", outcome)
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

    fn context() -> ToolContext {
        let dir = std::env::temp_dir();
        ToolContext {
            working_dir: dir.clone(),
            permission_mode: claurst_core::PermissionMode::BypassPermissions,
            permission_handler: Arc::new(
                crate::agent::permission_handler::AivpnPermissionHandler::new(dir.clone()),
            ),
            cost_tracker: claurst_core::CostTracker::with_model("test"),
            session_id: "config-update-test".to_string(),
            file_history: Arc::new(parking_lot::Mutex::new(
                claurst_core::file_history::FileHistory::new(),
            )),
            current_turn: Arc::new(std::sync::atomic::AtomicUsize::new(0)),
            non_interactive: true,
            mcp_manager: None,
            config: Default::default(),
            managed_agent_config: None,
            completion_notifier: None,
            pending_permissions: None,
            permission_manager: None,
            user_question_tx: None,
            cancel_token: tokio_util::sync::CancellationToken::new(),
            batch_rejection: Default::default(),
        }
    }

    fn envelope_of(result: &ToolResult) -> Value {
        result
            .metadata
            .as_ref()
            .and_then(|meta| meta.get("aivpn").cloned())
            .unwrap_or_else(|| panic!("工具结果必须带 aivpn 信封"))
    }

    fn not_wired_update() -> ConfigUpdateTool {
        ConfigUpdateTool::new(Arc::new(crate::tools::services::NotWiredServices))
    }

    #[tokio::test]
    async fn targets_is_rejected_as_an_unknown_argument() {
        let result = not_wired_update()
            .execute(
                json!({ "config_id": "cfg_1", "targets": ["ai"] }),
                &context(),
            )
            .await;
        assert!(result.is_error);
        let env = envelope_of(&result);
        assert_eq!(env["error"]["code"], "INVALID_ARGUMENT", "{env}");
        assert_eq!(
            env["error"]["details"]["reason"], "unknown_argument",
            "{env}"
        );
        assert_eq!(env["summary"], "不支持的参数 targets", "{env}");
    }

    #[tokio::test]
    async fn connect_mode_is_rejected_as_immutable() {
        let result = not_wired_update()
            .execute(
                json!({ "config_id": "cfg_1", "connect_mode": "tun" }),
                &context(),
            )
            .await;
        assert!(result.is_error);
        let env = envelope_of(&result);
        assert_eq!(env["error"]["code"], "INVALID_ARGUMENT", "{env}");
        assert_eq!(
            env["error"]["details"]["reason"], "connect_mode_immutable",
            "{env}"
        );
        assert_eq!(env["summary"], "改接管方式需要新建配置", "{env}");
    }

    #[test]
    fn schema_keys_pass_the_key_check() {
        assert!(unknown_update_argument(&json!({
            "config_id": "cfg_1",
            "name": "新名字",
            "routing_mode": "direct",
            "dns": {},
            "tun_excludes": [],
            "node_ids": []
        }))
        .is_none());
    }

    #[tokio::test]
    async fn a_known_argument_is_not_rejected_by_the_key_check() {
        // 服务层未接线：这里只证明键校验没有误伤合法输入。
        let result = not_wired_update()
            .execute(
                json!({ "config_id": "cfg_1", "name": "新名字" }),
                &context(),
            )
            .await;
        let env = envelope_of(&result);
        assert_ne!(env["error"]["code"], "INVALID_ARGUMENT", "{env}");
    }
}
