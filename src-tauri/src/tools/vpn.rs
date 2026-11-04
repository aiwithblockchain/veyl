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
        "连接一套配置并设置系统代理。省略 config_id 时使用当前激活配置。\
         切换当前节点请用 NodeSwitch，不要用本工具。\
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
                "config_id": { "type": "string" }
            },
            "additionalProperties": false
        })
    }

    async fn execute(&self, input: Value, ctx: &ToolContext) -> ToolResult {
        let config_id = match super::optional_string(&input, "config_id") {
            Ok(value) => value,
            Err(error) => return envelope::finish(ctx, "VpnConnect", ToolOutcome::fail(error)),
        };

        let outcome = match self.services.vpn_connect(config_id).await {
            Ok(data) => {
                let summary = connect_summary(&data);
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

/// 连接成功后的摘要：模型下一步就要向用户报「用的哪条线路、代理地址、出口 IP」。
/// 少给一样它就得再调一次 `RuntimeStatus`，首启的轮次预算经不起这么花。
fn connect_summary(data: &Value) -> String {
    let name = data
        .get("config_name")
        .and_then(Value::as_str)
        .unwrap_or("当前配置");
    let mut parts = vec![format!("已连接：配置「{name}」")];
    if let Some(node) = data.get("node_name").and_then(Value::as_str) {
        parts.push(format!("节点「{node}」"));
    }
    match data.get("mixed_port").and_then(Value::as_u64) {
        Some(port) => parts.push(format!("代理地址 127.0.0.1:{port}")),
        // TUN 模式不监听本机端口，接管靠路由表。
        None => parts.push("全部流量已接管".to_string()),
    }
    match data.get("exit_ip").and_then(Value::as_str) {
        Some(ip) => {
            parts.push(match data.get("latency_ms").and_then(Value::as_u64) {
                Some(ms) => format!("出口 IP {ip}（{ms}ms）"),
                None => format!("出口 IP {ip}"),
            });
        }
        None => parts.push("出口 IP 仍在探测中".to_string()),
    }
    format!("{}。", parts.join("，"))
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
