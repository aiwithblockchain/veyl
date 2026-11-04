//! 分流与规则数据的 AI 工具（`docs/contracts/routing.md` / `tools.md` 3.2）。

use std::sync::Arc;

use async_trait::async_trait;
use claurst_tools::{PermissionLevel, Tool, ToolContext, ToolResult};
use serde_json::{json, Value};

use super::envelope::{self, AivpnError, ToolOutcome};
use super::services::VpnToolServices;

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

fn summarise_route(data: &Value) -> String {
    let mode = data
        .get("routing_mode")
        .and_then(Value::as_str)
        .unwrap_or("-");
    let applied = data
        .get("applied_mode")
        .and_then(Value::as_str)
        .unwrap_or("未生效");
    let targets = data
        .get("targets")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .collect::<Vec<_>>()
                .join("、")
        })
        .unwrap_or_default();
    let effective = data
        .get("effective")
        .and_then(Value::as_str)
        .unwrap_or("next_connection");
    format!(
        "分流模式 {mode}，当前生效 {applied}{}。生效状态：{effective}。",
        if targets.is_empty() {
            String::new()
        } else {
            format!("，目标分类：{targets}")
        }
    )
}

pub struct RouteGetTool {
    services: Arc<dyn VpnToolServices>,
}

impl RouteGetTool {
    pub fn new(services: Arc<dyn VpnToolServices>) -> Self {
        Self { services }
    }
}

#[async_trait]
impl Tool for RouteGetTool {
    fn name(&self) -> &str {
        "RouteGet"
    }

    fn description(&self) -> &str {
        "读取一套配置的分流模式、指定服务分类、当前是否已生效。只读，不联网。"
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
            Err(error) => return envelope::finish(ctx, "RouteGet", ToolOutcome::fail(error)),
        };
        let outcome = match self.services.route_get(config_id).await {
            Ok(data) => ToolOutcome::ok(summarise_route(&data), data),
            Err(error) => ToolOutcome::fail(failure(error)),
        };
        envelope::finish(ctx, "RouteGet", outcome)
    }
}

pub struct RouteSetModeTool {
    services: Arc<dyn VpnToolServices>,
}

impl RouteSetModeTool {
    pub fn new(services: Arc<dyn VpnToolServices>) -> Self {
        Self { services }
    }
}

#[async_trait]
impl Tool for RouteSetModeTool {
    fn name(&self) -> &str {
        "RouteSetMode"
    }

    fn description(&self) -> &str {
        "切换分流模式。direct ↔ proxy_all 且已连接时热切不断流；\
         涉及 proxy_selected 的跨家族切换会断开重连，必须先问用户再带 confirm_reconnect=true。"
    }

    fn permission_level(&self) -> PermissionLevel {
        PermissionLevel::Execute
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "config_id": { "type": "string" },
                "mode": { "type": "string", "enum": ["direct", "proxy_all", "proxy_selected"] },
                "confirm_reconnect": { "type": "boolean", "default": false }
            },
            "required": ["mode"],
            "additionalProperties": false
        })
    }

    async fn execute(&self, input: Value, ctx: &ToolContext) -> ToolResult {
        let Some(mode) = input.get("mode").and_then(Value::as_str) else {
            return envelope::finish(
                ctx,
                "RouteSetMode",
                ToolOutcome::fail(AivpnError::new("INVALID_ARGUMENT", "缺少 mode")),
            );
        };
        let config_id = match super::optional_string(&input, "config_id") {
            Ok(value) => value,
            Err(error) => {
                return envelope::finish(ctx, "RouteSetMode", ToolOutcome::fail(error))
            }
        };
        let confirm = input
            .get("confirm_reconnect")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let outcome = match self
            .services
            .route_set_mode(config_id, mode, confirm)
            .await
        {
            Ok(data) => {
                let hot = data.get("hot_switched").and_then(Value::as_bool).unwrap_or(false);
                ToolOutcome::ok(
                    if hot {
                        "分流模式已热切换，连接未中断。"
                    } else {
                        "分流模式已更新，下一次连接生效。"
                    },
                    data,
                )
            }
            Err(error) => ToolOutcome::fail(failure(error)),
        };
        envelope::finish(ctx, "RouteSetMode", outcome)
    }
}

pub struct RouteTargetsSetTool {
    services: Arc<dyn VpnToolServices>,
}

impl RouteTargetsSetTool {
    pub fn new(services: Arc<dyn VpnToolServices>) -> Self {
        Self { services }
    }
}

#[async_trait]
impl Tool for RouteTargetsSetTool {
    fn name(&self) -> &str {
        "RouteTargetsSet"
    }

    fn description(&self) -> &str {
        "整体替换「指定服务走 VPN」的分类集合。分类 id 必须先用 CategoryList 查，\
         不要把用户说的服务名直接当 id；不热切，下一次连接生效。"
    }

    fn permission_level(&self) -> PermissionLevel {
        PermissionLevel::Write
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "config_id": { "type": "string" },
                "categories": { "type": "array", "items": { "type": "string" } }
            },
            "required": ["config_id", "categories"],
            "additionalProperties": false
        })
    }

    async fn execute(&self, input: Value, ctx: &ToolContext) -> ToolResult {
        let (Some(config_id), Some(categories)) = (
            input.get("config_id").and_then(Value::as_str),
            input.get("categories").and_then(Value::as_array),
        ) else {
            return envelope::finish(
                ctx,
                "RouteTargetsSet",
                ToolOutcome::fail(AivpnError::new(
                    "INVALID_ARGUMENT",
                    "缺少 config_id 或 categories",
                )),
            );
        };
        let categories = categories
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_string)
            .collect::<Vec<_>>();
        let outcome = match self
            .services
            .route_targets_set(config_id, categories)
            .await
        {
            Ok(data) => ToolOutcome::ok("指定服务已更新，下一次连接生效。", data),
            Err(error) => ToolOutcome::fail(failure(error)),
        };
        envelope::finish(ctx, "RouteTargetsSet", outcome)
    }
}

pub struct CategoryListTool {
    services: Arc<dyn VpnToolServices>,
}

impl CategoryListTool {
    pub fn new(services: Arc<dyn VpnToolServices>) -> Self {
        Self { services }
    }
}

#[async_trait]
impl Tool for CategoryListTool {
    fn name(&self) -> &str {
        "CategoryList"
    }

    fn description(&self) -> &str {
        "列出可用于「指定服务走 VPN」的分类。用户说服务名时先用本工具翻成分类 id。"
    }

    fn permission_level(&self) -> PermissionLevel {
        PermissionLevel::ReadOnly
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "query": { "type": "string" },
                "limit": { "type": "integer", "minimum": 1, "maximum": 200, "default": 50 }
            },
            "additionalProperties": false
        })
    }

    async fn execute(&self, input: Value, ctx: &ToolContext) -> ToolResult {
        let query = match super::optional_string(&input, "query") {
            Ok(value) => value,
            Err(error) => {
                return envelope::finish(ctx, "CategoryList", ToolOutcome::fail(error))
            }
        };
        let limit = input
            .get("limit")
            .and_then(Value::as_u64)
            .map(|value| value as u32);
        let outcome = match self.services.category_list(query, limit).await {
            Ok(data) => {
                let count = data
                    .get("categories")
                    .and_then(Value::as_array)
                    .map(|items| items.len())
                    .unwrap_or(0);
                ToolOutcome::ok(format!("找到 {count} 个分类。"), data)
            }
            Err(error) => ToolOutcome::fail(failure(error)),
        };
        envelope::finish(ctx, "CategoryList", outcome)
    }
}

pub struct RulesStatusTool {
    services: Arc<dyn VpnToolServices>,
}

impl RulesStatusTool {
    pub fn new(services: Arc<dyn VpnToolServices>) -> Self {
        Self { services }
    }
}

#[async_trait]
impl Tool for RulesStatusTool {
    fn name(&self) -> &str {
        "RulesStatus"
    }

    fn description(&self) -> &str {
        "读取规则数据版本与新鲜度。只读；stale 只用于提示，不阻断连接。"
    }

    fn permission_level(&self) -> PermissionLevel {
        PermissionLevel::ReadOnly
    }

    fn input_schema(&self) -> Value {
        json!({ "type": "object", "properties": {}, "additionalProperties": false })
    }

    async fn execute(&self, _input: Value, ctx: &ToolContext) -> ToolResult {
        let outcome = match self.services.rules_status().await {
            Ok(data) => {
                let version = data
                    .get("active_version")
                    .and_then(Value::as_str)
                    .unwrap_or("");
                let stale = data.get("stale").and_then(Value::as_bool).unwrap_or(true);
                ToolOutcome::ok(
                    if version.is_empty() {
                        "规则数据尚未就绪。".to_string()
                    } else {
                        format!(
                            "规则数据版本 {version}{}。",
                            if stale { "，可能已过期" } else { "" }
                        )
                    },
                    data,
                )
            }
            Err(error) => ToolOutcome::fail(failure(error)),
        };
        envelope::finish(ctx, "RulesStatus", outcome)
    }
}
