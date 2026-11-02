use std::sync::Arc;

use async_trait::async_trait;
use claurst_tools::{PermissionLevel, Tool, ToolContext, ToolResult};
use serde_json::{json, Value};

use super::envelope::{self, AivpnError, ToolOutcome};
use super::services::VpnToolServices;

pub struct JobGetTool {
    services: Arc<dyn VpnToolServices>,
}

impl JobGetTool {
    pub fn new(services: Arc<dyn VpnToolServices>) -> Self {
        Self { services }
    }
}

#[async_trait]
impl Tool for JobGetTool {
    fn name(&self) -> &str {
        "JobGet"
    }

    fn description(&self) -> &str {
        "查询长任务（安装、诊断）的状态与进度。"
    }

    fn permission_level(&self) -> PermissionLevel {
        PermissionLevel::ReadOnly
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": { "job_id": { "type": "string" } },
            "required": ["job_id"],
            "additionalProperties": false
        })
    }

    async fn execute(&self, input: Value, ctx: &ToolContext) -> ToolResult {
        let Some(job_id) = input.get("job_id").and_then(Value::as_str) else {
            return envelope::finish(
                ctx,
                "JobGet",
                ToolOutcome::fail(AivpnError::new("INVALID_ARGUMENT", "缺少 job_id 参数")),
            );
        };

        let outcome = match self.services.job_get(job_id).await {
            Ok(data) => {
                let state = data
                    .get("state")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown")
                    .to_string();
                ToolOutcome::ok(format!("任务 {job_id} 当前状态 {state}。"), data)
            }
            Err(error) => ToolOutcome::fail(AivpnError::new("NOT_FOUND", error.to_string())),
        };
        envelope::finish(ctx, "JobGet", outcome)
    }
}
