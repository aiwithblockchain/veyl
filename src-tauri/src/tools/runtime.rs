use std::sync::Arc;

use async_trait::async_trait;
use claurst_tools::{PermissionLevel, Tool, ToolContext, ToolResult};
use serde_json::{json, Value};

use super::envelope::{self, AivpnError, ToolOutcome};
use super::services::VpnToolServices;

fn failure(error: anyhow::Error) -> ToolOutcome {
    ToolOutcome::fail(AivpnError::new("INTERNAL", error.to_string()))
}

pub struct RuntimeStatusTool {
    services: Arc<dyn VpnToolServices>,
}

impl RuntimeStatusTool {
    pub fn new(services: Arc<dyn VpnToolServices>) -> Self {
        Self { services }
    }
}

#[async_trait]
impl Tool for RuntimeStatusTool {
    fn name(&self) -> &str {
        "RuntimeStatus"
    }

    fn description(&self) -> &str {
        "读取 sing-box 运行时的状态快照（进程、版本、健康、出口 IP、流量、连接数）。只读。"
    }

    fn permission_level(&self) -> PermissionLevel {
        PermissionLevel::ReadOnly
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "include_traffic": { "type": "boolean", "default": true }
            },
            "additionalProperties": false
        })
    }

    async fn execute(&self, _input: Value, ctx: &ToolContext) -> ToolResult {
        let outcome = match self.services.runtime_status().await {
            Ok(snapshot) => {
                let state = snapshot
                    .get("state")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown")
                    .to_string();
                let version = snapshot
                    .get("upstream_version")
                    .and_then(Value::as_str)
                    .unwrap_or("未安装")
                    .to_string();
                let exit_ip = snapshot
                    .get("health")
                    .and_then(|health| health.get("exit_ip"))
                    .and_then(Value::as_str)
                    .unwrap_or("未知")
                    .to_string();
                ToolOutcome::ok(
                    format!("运行状态 {state}，sing-box {version}，出口 {exit_ip}。"),
                    snapshot,
                )
            }
            Err(error) => failure(error),
        };
        envelope::finish(ctx, "RuntimeStatus", outcome)
    }
}

macro_rules! lifecycle_tool {
    ($ty:ident, $name:literal, $desc:literal, $summary:literal, $method:ident, $arg:expr) => {
        pub struct $ty {
            services: Arc<dyn VpnToolServices>,
        }

        impl $ty {
            pub fn new(services: Arc<dyn VpnToolServices>) -> Self {
                Self { services }
            }
        }

        #[async_trait]
        impl Tool for $ty {
            fn name(&self) -> &str {
                $name
            }

            fn description(&self) -> &str {
                $desc
            }

            fn permission_level(&self) -> PermissionLevel {
                PermissionLevel::Write
            }

            fn input_schema(&self) -> Value {
                json!({ "type": "object", "properties": {}, "additionalProperties": false })
            }

            async fn execute(&self, _input: Value, ctx: &ToolContext) -> ToolResult {
                let outcome = match self.services.$method($arg).await {
                    Ok(data) => ToolOutcome::ok($summary, data),
                    Err(error) => failure(error),
                };
                envelope::finish(ctx, $name, outcome)
            }
        }
    };
}

lifecycle_tool!(
    RuntimeStartTool,
    "RuntimeStart",
    "启动 sing-box 运行时进程。不设置系统代理；需要代理请用 VpnConnect。",
    "运行时已启动。",
    runtime_start,
    None
);

lifecycle_tool!(
    RuntimeStopTool,
    "RuntimeStop",
    "停止 sing-box 运行时并恢复系统代理。已是 idle 时为幂等成功。",
    "运行时已停止，系统代理已恢复。",
    runtime_stop,
    false
);

lifecycle_tool!(
    RuntimeRestartTool,
    "RuntimeRestart",
    "重启 sing-box 运行时，用于应用新配置或恢复异常状态。",
    "运行时已重启。",
    runtime_restart,
    None
);

pub struct RuntimeLogsTool {
    services: Arc<dyn VpnToolServices>,
}

impl RuntimeLogsTool {
    pub fn new(services: Arc<dyn VpnToolServices>) -> Self {
        Self { services }
    }
}

#[async_trait]
impl Tool for RuntimeLogsTool {
    fn name(&self) -> &str {
        "RuntimeLogs"
    }

    fn description(&self) -> &str {
        "读取最近若干行已脱敏的运行时日志。用于诊断连接失败。"
    }

    fn permission_level(&self) -> PermissionLevel {
        PermissionLevel::ReadOnly
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "lines": { "type": "integer", "minimum": 1, "maximum": 500, "default": 200 },
                "level": { "type": "string", "enum": ["debug", "info", "warn", "error"] }
            },
            "additionalProperties": false
        })
    }

    async fn execute(&self, input: Value, ctx: &ToolContext) -> ToolResult {
        let lines = input
            .get("lines")
            .and_then(Value::as_u64)
            .unwrap_or(200)
            .clamp(1, 500) as u32;
        let level = input
            .get("level")
            .and_then(Value::as_str)
            .map(str::to_string);

        let outcome = match self.services.runtime_logs(lines, level).await {
            Ok(data) => {
                let count = data
                    .get("lines")
                    .and_then(Value::as_array)
                    .map(Vec::len)
                    .unwrap_or(0);
                ToolOutcome::ok(format!("读取了 {count} 行日志。"), data)
            }
            Err(error) => failure(error),
        };
        envelope::finish(ctx, "RuntimeLogs", outcome)
    }
}
