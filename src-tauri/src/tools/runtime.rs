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

pub struct RuntimeStartTool {
    services: Arc<dyn VpnToolServices>,
}

impl RuntimeStartTool {
    pub fn new(services: Arc<dyn VpnToolServices>) -> Self {
        Self { services }
    }
}

#[async_trait]
impl Tool for RuntimeStartTool {
    fn name(&self) -> &str {
        "RuntimeStart"
    }

    fn description(&self) -> &str {
        "启动 sing-box 运行时进程（使用当前激活配置）。不设置系统代理；需要代理请用 VpnConnect。"
    }

    fn permission_level(&self) -> PermissionLevel {
        PermissionLevel::Write
    }

    fn input_schema(&self) -> Value {
        json!({ "type": "object", "properties": {}, "additionalProperties": false })
    }

    async fn execute(&self, _input: Value, ctx: &ToolContext) -> ToolResult {
        let outcome = match self.services.runtime_start(None).await {
            Ok(data) => ToolOutcome::ok("运行时已启动。", data),
            Err(error) => failure(error),
        };
        envelope::finish(ctx, "RuntimeStart", outcome)
    }
}

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


/// 日志类工具只报行数没有意义——模型看不到内容就没法诊断。
fn format_logs(data: &Value) -> String {
    let lines: Vec<&str> = data
        .get("lines")
        .and_then(Value::as_array)
        .map(|items| items.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default();

    if lines.is_empty() {
        return "运行时日志为空（还没有启动过运行时，或日志文件已被清空）。".to_string();
    }

    let mut text = format!("最近 {} 行运行时日志：\n", lines.len());
    for line in &lines {
        text.push_str(line);
        text.push('\n');
    }
    text
}

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
            Ok(data) => ToolOutcome::ok(format_logs(&data), data),
            Err(error) => failure(error),
        };
        envelope::finish(ctx, "RuntimeLogs", outcome)
    }
}

#[cfg(test)]
mod log_format_tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn includes_the_actual_lines() {
        let data = json!({ "lines": ["sing-box started", "inbound mixed started"] });
        let text = format_logs(&data);
        assert!(text.contains("sing-box started"), "{text}");
        assert!(text.contains("inbound mixed started"), "{text}");
        assert!(text.contains("最近 2 行"), "{text}");
    }

    #[test]
    fn an_empty_log_says_so() {
        let text = format_logs(&json!({ "lines": [] }));
        assert!(text.contains("日志为空"), "{text}");
    }
}
