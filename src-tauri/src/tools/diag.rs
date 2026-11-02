use std::sync::Arc;

use async_trait::async_trait;
use claurst_tools::{PermissionLevel, Tool, ToolContext, ToolResult};
use serde_json::{json, Value};

use super::envelope::{self, AivpnError, ToolOutcome};
use super::services::VpnToolServices;

pub struct DiagRunTool {
    services: Arc<dyn VpnToolServices>,
}

impl DiagRunTool {
    pub fn new(services: Arc<dyn VpnToolServices>) -> Self {
        Self { services }
    }
}

#[async_trait]
impl Tool for DiagRunTool {
    fn name(&self) -> &str {
        "DiagRun"
    }

    fn description(&self) -> &str {
        "跑一次网络诊断：运行时/进程/控制面/数据面、系统代理逐服务、DNS、默认路由、\
         出口 IP、默认源/GitHub/DeepSeek 可达性、当前配置与默认配置版本。\
         每项带 ok、detail、remediation 与可点击 action。连接失败时用它定位原因。"
    }

    fn permission_level(&self) -> PermissionLevel {
        PermissionLevel::ReadOnly
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "include_logs": { "type": "boolean", "default": true }
            },
            "additionalProperties": false
        })
    }

    async fn execute(&self, input: Value, ctx: &ToolContext) -> ToolResult {
        let include_logs = input
            .get("include_logs")
            .and_then(Value::as_bool)
            .unwrap_or(true);

        let outcome = match self.services.diag_run(include_logs).await {
            Ok(data) => {
                let failed = data
                    .get("checks")
                    .and_then(Value::as_array)
                    .map(|checks| {
                        checks
                            .iter()
                            .filter(|check| {
                                !check.get("ok").and_then(Value::as_bool).unwrap_or(true)
                            })
                            .count()
                    })
                    .unwrap_or(0);
                ToolOutcome::ok(
                    if failed == 0 {
                        "诊断通过，没有发现异常。"
                    } else {
                        "诊断完成，有检查项未通过，详情见 data.checks。"
                    },
                    data,
                )
            }
            Err(error) => ToolOutcome::fail(AivpnError::new("INTERNAL", error.to_string())),
        };
        envelope::finish(ctx, "DiagRun", outcome)
    }
}
