use std::sync::Arc;

use async_trait::async_trait;
use claurst_tools::{PermissionLevel, Tool, ToolContext, ToolResult};
use serde_json::{json, Value};

use super::display::{Fact, FactKey};
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
        "查询长任务（运行库升级、安装、诊断）的状态、进度与发起方（origin）。\n说「进度」和阶段白话名；不出现 job id、stage 字段名。"
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
                let mut facts = vec![Fact::with_params(
                    FactKey::JobState,
                    json!({ "state": state }),
                )];
                if let Some(progress) = data.get("progress").and_then(Value::as_f64) {
                    facts.push(Fact::with_params(
                        FactKey::JobProgress,
                        json!({ "percent": (progress * 100.0).round() as u64 }),
                    ));
                }
                ToolOutcome::ok(format!("任务 {job_id} 当前状态 {state}。"), data).with_facts(facts)
            }
            Err(error) => ToolOutcome::fail(AivpnError::new("NOT_FOUND", error.to_string())),
        };
        envelope::finish(ctx, "JobGet", outcome)
    }
}
