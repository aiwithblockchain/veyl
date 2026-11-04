//! 系统网络只读 / 受限修复与默认配置包工具（1.1.0）。
//!
//! 不提供通用 shell：所有系统操作都收敛在固定动作里。

use std::sync::Arc;

use async_trait::async_trait;
use claurst_tools::{PermissionLevel, Tool, ToolContext, ToolResult};
use serde_json::{json, Value};

use super::envelope::{self, AivpnError, ToolOutcome};
use super::services::VpnToolServices;

fn tool_error(error: anyhow::Error) -> AivpnError {
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

pub struct NetConfigGetTool {
    services: Arc<dyn VpnToolServices>,
}

impl NetConfigGetTool {
    pub fn new(services: Arc<dyn VpnToolServices>) -> Self {
        Self { services }
    }
}

#[async_trait]
impl Tool for NetConfigGetTool {
    fn name(&self) -> &str {
        "NetConfigGet"
    }

    fn description(&self) -> &str {
        "读取本机网络配置：逐网络服务的系统代理、DNS、默认路由与接口、回环监听端口。\
         只读，不修改任何设置，不返回 MAC / Wi-Fi 名称。"
    }

    fn permission_level(&self) -> PermissionLevel {
        PermissionLevel::ReadOnly
    }

    fn input_schema(&self) -> Value {
        json!({ "type": "object", "properties": {}, "additionalProperties": false })
    }

    async fn execute(&self, _input: Value, ctx: &ToolContext) -> ToolResult {
        let outcome = match self.services.net_config_get().await {
            Ok(data) => {
                let services = data
                    .get("proxies")
                    .and_then(Value::as_array)
                    .map(|items| items.len())
                    .unwrap_or(0);
                let interface = data
                    .get("route")
                    .and_then(|route| route.get("default_interface"))
                    .and_then(Value::as_str)
                    .unwrap_or("未知");
                ToolOutcome::ok(
                    format!(
                        "读取到 {} 个网络服务的代理设置；默认接口 {interface}。",
                        services
                    ),
                    data,
                )
            }
            Err(error) => ToolOutcome::fail(tool_error(error)),
        };
        envelope::finish(ctx, "NetConfigGet", outcome)
    }
}

pub struct NetRepairTool {
    services: Arc<dyn VpnToolServices>,
}

impl NetRepairTool {
    pub fn new(services: Arc<dyn VpnToolServices>) -> Self {
        Self { services }
    }
}

#[async_trait]
impl Tool for NetRepairTool {
    fn name(&self) -> &str {
        "NetRepair"
    }

    fn description(&self) -> &str {
        "有限的网络修复：restore_direct（撤销 Veyl 的代理并停运行时）、flush_dns（刷新 DNS 缓存）、\
         set_proxy / clear_proxy（只改 Veyl 自己的代理端口）。\
         不要用本工具修改与 Veyl 无关的网络配置。"
    }

    fn permission_level(&self) -> PermissionLevel {
        PermissionLevel::Execute
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "action": {
                    "type": "string",
                    "enum": ["restore_direct", "flush_dns", "set_proxy", "clear_proxy"]
                },
                "port": { "type": "integer", "minimum": 1024, "maximum": 65535 }
            },
            "required": ["action"],
            "additionalProperties": false
        })
    }

    async fn execute(&self, input: Value, ctx: &ToolContext) -> ToolResult {
        let Some(action) = input.get("action").and_then(Value::as_str) else {
            return envelope::finish(
                ctx,
                "NetRepair",
                ToolOutcome::fail(AivpnError::new("INVALID_ARGUMENT", "缺少 action")),
            );
        };
        let port = input
            .get("port")
            .and_then(Value::as_u64)
            .and_then(|port| u16::try_from(port).ok());

        let outcome = match self.services.net_repair(action, port).await {
            Ok(data) => {
                let detail = data
                    .get("detail")
                    .and_then(Value::as_str)
                    .unwrap_or("已执行")
                    .to_string();
                let verified = data.get("verified").and_then(Value::as_bool).unwrap_or(false);
                if verified {
                    ToolOutcome::ok(detail, data)
                } else {
                    ToolOutcome::fail(
                        AivpnError::new("PRECONDITION_FAILED", detail).with_details(json!({
                            "reason": "verify_failed",
                            "action": action,
                        })),
                    )
                }
            }
            Err(error) => ToolOutcome::fail(tool_error(error)),
        };
        envelope::finish(ctx, "NetRepair", outcome)
    }
}

pub struct CatalogRefreshTool {
    services: Arc<dyn VpnToolServices>,
}

impl CatalogRefreshTool {
    pub fn new(services: Arc<dyn VpnToolServices>) -> Self {
        Self { services }
    }
}

#[async_trait]
impl Tool for CatalogRefreshTool {
    fn name(&self) -> &str {
        "CatalogRefresh"
    }

    fn description(&self) -> &str {
        "拉取并应用测试节点（veyl_seed.json）。有本地缓存时离线不算错误；\
         按内容哈希判断是否变化，不依赖 version 字段。"
    }

    fn permission_level(&self) -> PermissionLevel {
        PermissionLevel::Write
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": { "force": { "type": "boolean", "default": false } },
            "additionalProperties": false
        })
    }

    async fn execute(&self, input: Value, ctx: &ToolContext) -> ToolResult {
        let force = input.get("force").and_then(Value::as_bool).unwrap_or(false);
        let outcome = match self.services.default_profile_refresh(force).await {
            Ok(data) => {
                let node_count = data
                    .get("node_count")
                    .and_then(Value::as_i64)
                    .unwrap_or(0);
                ToolOutcome::ok(format!("测试节点已检查（{node_count} 个）"), data)
            }
            Err(error) => ToolOutcome::fail(tool_error(error)),
        };
        envelope::finish(ctx, "CatalogRefresh", outcome)
    }
}

pub struct DefaultProfileStatusTool {
    services: Arc<dyn VpnToolServices>,
}

impl DefaultProfileStatusTool {
    pub fn new(services: Arc<dyn VpnToolServices>) -> Self {
        Self { services }
    }
}

#[async_trait]
impl Tool for DefaultProfileStatusTool {
    fn name(&self) -> &str {
        "DefaultProfileStatus"
    }

    fn description(&self) -> &str {
        "读取测试节点缓存状态（不联网）：节点数、内容哈希、检查时间。"
    }

    fn permission_level(&self) -> PermissionLevel {
        PermissionLevel::ReadOnly
    }

    fn input_schema(&self) -> Value {
        json!({ "type": "object", "properties": {}, "additionalProperties": false })
    }

    async fn execute(&self, _input: Value, ctx: &ToolContext) -> ToolResult {
        let outcome = match self.services.default_profile_status().await {
            Ok(data) => {
                let available = data
                    .get("content_sha256")
                    .and_then(Value::as_str)
                    .is_some();
                let summary = if available {
                    format!(
                        "测试节点 {} 个{}",
                        data.get("node_count").and_then(Value::as_i64).unwrap_or(0),
                        data.get("checked_at")
                            .and_then(Value::as_i64)
                            .map(|at| format!(" · 检查于 {at}"))
                            .unwrap_or_default()
                    )
                } else {
                    "还没有测试节点缓存，先运行 CatalogRefresh。".to_string()
                };
                ToolOutcome::ok(summary, data)
            }
            Err(error) => ToolOutcome::fail(tool_error(error)),
        };
        envelope::finish(ctx, "DefaultProfileStatus", outcome)
    }
}
