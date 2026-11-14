//! `MyServers`：只读地列出「我的服务器」与状态（`tools.md` §4.x）。
//!
//! 建机 / 销毁 / 凭据只能由用户点界面；本工具不返回 IP、端口、密码或节点 id。

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

fn state_label(state: &str) -> &'static str {
    match state {
        "creating" | "booting" | "installing" | "verifying" => "安装中",
        "healthy" | "active" => "可用",
        "error" => "出错",
        "destroying" => "正在销毁",
        "gone" => "已失效",
        "destroyed" => "已销毁",
        _ => "状态未知",
    }
}

pub struct MyServersTool {
    services: Arc<dyn VpnToolServices>,
}

impl MyServersTool {
    pub fn new(services: Arc<dyn VpnToolServices>) -> Self {
        Self { services }
    }
}

#[async_trait]
impl Tool for MyServersTool {
    fn name(&self) -> &str {
        "MyServers"
    }

    fn description(&self) -> &str {
        "查看「我的服务器」列表：名称、地区、状态、是否可用、月费。只读；不返回地址、端口或密码。建机与销毁只能由用户在「我的服务器」页面操作。\n用「服务器」「地区」「安装中」这些词；不出现 server_id、node_id、IP、端口。"
    }

    fn permission_level(&self) -> PermissionLevel {
        PermissionLevel::ReadOnly
    }

    fn input_schema(&self) -> Value {
        json!({ "type": "object", "properties": {}, "additionalProperties": false })
    }

    async fn execute(&self, _input: Value, ctx: &ToolContext) -> ToolResult {
        let outcome = match self.services.my_servers().await {
            Ok(data) => {
                let servers = data
                    .get("servers")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default();
                let facts = if servers.is_empty() {
                    vec!["还没有服务器".to_string()]
                } else {
                    servers
                        .iter()
                        .take(8)
                        .map(|server| {
                            let name = server
                                .get("name")
                                .and_then(Value::as_str)
                                .unwrap_or("未命名");
                            let region = server
                                .get("region")
                                .and_then(Value::as_str)
                                .unwrap_or("");
                            let state = server
                                .get("state")
                                .and_then(Value::as_str)
                                .unwrap_or("");
                            format!("{name} · {region} · {}", state_label(state))
                        })
                        .collect()
                };
                ToolOutcome::ok(format!("共 {} 台服务器。", servers.len()), data).with_facts(facts)
            }
            Err(error) => ToolOutcome::fail(failure(error)),
        };
        envelope::finish(ctx, "MyServers", outcome)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn a_not_wired_registry_fails_instead_of_inventing_servers() {
        let services = crate::tools::NotWiredServices;
        assert!(
            services.my_servers().await.is_err(),
            "未接入时不能返回空列表冒充成功"
        );
    }

    #[test]
    fn states_are_rendered_in_user_words() {
        assert_eq!(state_label("installing"), "安装中");
        assert_eq!(state_label("healthy"), "可用");
        assert_eq!(state_label("destroying"), "正在销毁");
        assert_eq!(state_label("nonsense"), "状态未知");
    }
}
