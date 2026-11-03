use std::sync::Arc;

use async_trait::async_trait;
use claurst_tools::{PermissionLevel, Tool, ToolContext, ToolResult};
use serde_json::{json, Value};

use super::envelope::{self, AivpnError, NextAction, ToolOutcome};
use super::services::VpnToolServices;

pub struct VpnConnectTool {
    services: Arc<dyn VpnToolServices>,
}

impl VpnConnectTool {
    pub fn new(services: Arc<dyn VpnToolServices>) -> Self {
        Self { services }
    }
}

#[async_trait]
impl Tool for VpnConnectTool {
    fn name(&self) -> &str {
        "VpnConnect"
    }

    fn description(&self) -> &str {
        "连接一套配置并设置系统代理。省略 config_id 时使用当前激活配置；\
         可选的 node_id 会同时切换当前节点。\
         state=running 即已连上；exit_ip 为 null 表示已连接但出口尚未测到，\
         不代表连接失败，可用 RuntimeStatus 再查。"
    }

    fn permission_level(&self) -> PermissionLevel {
        PermissionLevel::Execute
    }

    fn self_gates(&self) -> bool {
        true
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "config_id": { "type": "string" },
                "node_id": { "type": "string" }
            },
            "additionalProperties": false
        })
    }

    async fn execute(&self, input: Value, ctx: &ToolContext) -> ToolResult {
        let config_id = input
            .get("config_id")
            .and_then(Value::as_str)
            .map(str::to_string);
        let node_id = input
            .get("node_id")
            .and_then(Value::as_str)
            .map(str::to_string);

        let outcome = match self.services.vpn_connect(config_id, node_id).await {
            Ok(data) => {
                let summary = match data.get("exit_ip").and_then(Value::as_str) {
                    Some(ip) => format!("已连接，出口 IP {ip}。"),
                    None => "已连接，出口 IP 仍在探测中。".to_string(),
                };
                ToolOutcome::ok(summary, data).with_next(
                    NextAction {
                        label: "断开连接".to_string(),
                        tool: "VpnDisconnect".to_string(),
                        args: json!({}),
                    },
                )
            }
            Err(error) => ToolOutcome::fail(
                AivpnError::new("UPSTREAM_ERROR", error.to_string())
                    .with_details(json!({ "hint": "换一个同地区节点，或运行 DiagRun 诊断" })),
            )
            .with_next(NextAction {
                label: "诊断一下".to_string(),
                tool: "DiagRun".to_string(),
                args: json!({}),
            }),
        };
        envelope::finish(ctx, "VpnConnect", outcome)
    }
}

pub struct VpnDisconnectTool {
    services: Arc<dyn VpnToolServices>,
}

impl VpnDisconnectTool {
    pub fn new(services: Arc<dyn VpnToolServices>) -> Self {
        Self { services }
    }
}

#[async_trait]
impl Tool for VpnDisconnectTool {
    fn name(&self) -> &str {
        "VpnDisconnect"
    }

    fn description(&self) -> &str {
        "断开当前连接并恢复系统代理设置。已是未连接状态时为幂等成功。"
    }

    fn permission_level(&self) -> PermissionLevel {
        PermissionLevel::Write
    }

    fn input_schema(&self) -> Value {
        json!({ "type": "object", "properties": {}, "additionalProperties": false })
    }

    async fn execute(&self, _input: Value, ctx: &ToolContext) -> ToolResult {
        let outcome = match self.services.vpn_disconnect().await {
            Ok(data) => {
                let restored = data
                    .get("system_proxy_restored")
                    .and_then(Value::as_bool)
                    .unwrap_or(true);
                ToolOutcome::ok(
                    if restored {
                        "已断开，系统代理已恢复。"
                    } else {
                        "已断开，但系统代理未能恢复，请检查系统设置。"
                    },
                    data,
                )
            }
            Err(error) => ToolOutcome::fail(AivpnError::new("INTERNAL", error.to_string())),
        };
        envelope::finish(ctx, "VpnDisconnect", outcome)
    }
}
