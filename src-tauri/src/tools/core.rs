use std::sync::Arc;

use async_trait::async_trait;
use claurst_tools::{PermissionLevel, Tool, ToolContext, ToolResult};
use serde_json::{json, Value};

use super::envelope::{self, AivpnError, NextAction, ToolOutcome};
use super::services::VpnToolServices;

pub struct CoreListVersionsTool {
    services: Arc<dyn VpnToolServices>,
}

impl CoreListVersionsTool {
    pub fn new(services: Arc<dyn VpnToolServices>) -> Self {
        Self { services }
    }
}

#[async_trait]
impl Tool for CoreListVersionsTool {
    fn name(&self) -> &str {
        "CoreListVersions"
    }

    fn description(&self) -> &str {
        "列出已安装和可安装的 sing-box 运行时版本。"
    }

    fn permission_level(&self) -> PermissionLevel {
        PermissionLevel::ReadOnly
    }

    fn input_schema(&self) -> Value {
        json!({ "type": "object", "properties": {}, "additionalProperties": false })
    }

    async fn execute(&self, _input: Value, ctx: &ToolContext) -> ToolResult {
        let outcome = match self.services.core_list_versions().await {
            Ok(data) => {
                let installed = data
                    .get("installed")
                    .and_then(Value::as_array)
                    .map(Vec::len)
                    .unwrap_or(0);
                let available = data
                    .get("available")
                    .and_then(Value::as_array)
                    .map(Vec::len)
                    .unwrap_or(0);
                ToolOutcome::ok(
                    format!("已安装 {installed} 个版本，可安装 {available} 个。"),
                    data,
                )
            }
            Err(error) => ToolOutcome::fail(AivpnError::new("INTERNAL", error.to_string())),
        };
        envelope::finish(ctx, "CoreListVersions", outcome)
    }
}

pub struct CoreInstallTool {
    services: Arc<dyn VpnToolServices>,
}

impl CoreInstallTool {
    pub fn new(services: Arc<dyn VpnToolServices>) -> Self {
        Self { services }
    }
}

#[async_trait]
impl Tool for CoreInstallTool {
    fn name(&self) -> &str {
        "CoreInstall"
    }

    fn description(&self) -> &str {
        "下载并安装指定版本的官方 sing-box。会引入一个可执行二进制。\
         安装后即可用于启动运行时。"
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
                "version": { "type": "string", "pattern": "^[0-9]+\\.[0-9]+\\.[0-9]+$" },
                "channel": { "type": "string", "enum": ["stable"], "default": "stable" }
            },
            "required": ["version"],
            "additionalProperties": false
        })
    }

    async fn execute(&self, input: Value, ctx: &ToolContext) -> ToolResult {
        let Some(version) = input.get("version").and_then(Value::as_str) else {
            return envelope::finish(
                ctx,
                "CoreInstall",
                ToolOutcome::fail(AivpnError::new("INVALID_ARGUMENT", "缺少 version 参数")),
            );
        };

        let outcome = match self.services.core_install(version).await {
            Ok(data) => {
                let job_id = data
                    .get("job_id")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string();
                ToolOutcome::ok(format!("已开始安装 sing-box {version}。"), data).with_next(
                    NextAction {
                        label: "查看进度".to_string(),
                        tool: "JobGet".to_string(),
                        args: json!({ "job_id": job_id }),
                    },
                )
            }
            Err(error) => ToolOutcome::fail(AivpnError::new("INTERNAL", error.to_string())),
        };
        envelope::finish(ctx, "CoreInstall", outcome)
    }
}
