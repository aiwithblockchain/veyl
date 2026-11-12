//! 生效地区写入工具（`docs/contracts/tools.md` 3.10.1）。

use std::sync::Arc;

use async_trait::async_trait;
use claurst_tools::{PermissionLevel, Tool, ToolContext, ToolResult};
use serde_json::{json, Value};

use super::display::Changed;
use super::envelope::{self, AivpnError, ToolOutcome};
use super::services::{ServiceError, VpnToolServices};

pub struct SetUserRegionTool {
    services: Arc<dyn VpnToolServices>,
}

impl SetUserRegionTool {
    pub fn new(services: Arc<dyn VpnToolServices>) -> Self {
        Self { services }
    }
}

fn service_error(error: anyhow::Error) -> AivpnError {
    if let Some(service) = error.downcast_ref::<ServiceError>() {
        let mut mapped = AivpnError::new(&service.code, &service.message);
        mapped.details = service.details.clone();
        return mapped;
    }
    AivpnError::new("INTERNAL", error.to_string())
}

#[async_trait]
impl Tool for SetUserRegionTool {
    fn name(&self) -> &str {
        "SetUserRegion"
    }

    fn description(&self) -> &str {
        "记下用户所在的地区（两字母国家/地区代码，如 cn、jp、us），写入后压过系统推断，\
         直到用户说出新的地区。\n\
         只有用户在这一轮明确说过自己所在/常用地区，或纠正了之前的地区时才调用；\
         不要为了确认地区而追问，也不要凭猜测写入。用户没说、系统也判不出时不要调用，\
         按未知处理（全部走 VPN）。\n\
         说「地区」「国家」，不出现 settings、KV、source。"
    }

    fn permission_level(&self) -> PermissionLevel {
        // 改的是持久化设置，不能声明成只读。
        PermissionLevel::Write
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "region": {
                    "type": "string",
                    "pattern": "^[A-Za-z]{2}$",
                    "description": "小写两字母国家/地区代码；写入时统一规范化成小写。"
                }
            },
            "required": ["region"],
            "additionalProperties": false
        })
    }

    async fn execute(&self, input: Value, ctx: &ToolContext) -> ToolResult {
        let Some(region) = input.get("region").and_then(Value::as_str) else {
            let error = AivpnError::new("INVALID_ARGUMENT", "缺少 region")
                .with_details(json!({ "reason": "invalid_region" }));
            return envelope::finish(
                ctx,
                "SetUserRegion",
                ToolOutcome::fail(error).with_changed(Changed::None),
            );
        };

        let outcome = match self.services.set_user_region(region).await {
            Ok(data) => {
                let label = crate::rules::Region::from_code(region).label();
                ToolOutcome::ok(format!("已记下地区：{label}"), data)
                    .with_display("地区已记下", vec![label], Changed::None)
            }
            Err(error) => ToolOutcome::fail(service_error(error))
                .with_display("没能记下地区", Vec::new(), Changed::Unknown),
        };
        envelope::finish(ctx, "SetUserRegion", outcome)
    }
}
