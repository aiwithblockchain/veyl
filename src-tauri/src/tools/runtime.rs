use std::sync::Arc;

use async_trait::async_trait;
use claurst_tools::{PermissionLevel, Tool, ToolContext, ToolResult};
use serde_json::{json, Value};

use super::display::Changed;
use super::envelope::{self, AivpnError, ToolOutcome};
use super::services::{ServiceError, VpnToolServices};

fn failure(error: anyhow::Error) -> ToolOutcome {
    // 启动失败时服务会带 `connect_changed`；只读工具由 `finish` 统一压成 none。
    let changed = error
        .downcast_ref::<ServiceError>()
        .and_then(|service| service.details.as_ref())
        .and_then(|details| details.get("connect_changed"))
        .and_then(Value::as_str)
        .map(|value| match value {
            "restored" => Changed::Restored,
            "none" => Changed::None,
            _ => Changed::Unknown,
        })
        .unwrap_or(Changed::Unknown);
    ToolOutcome::fail(AivpnError::new("INTERNAL", error.to_string())).with_changed(changed)
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
        "读取 sing-box 运行时的状态快照（进程、版本、来源、健康、出口 IP、流量、连接数）。\
未连接时也会报告当前可用的运行时版本与来源；只有确实没有可用运行时时才会说不可用。\
运行时随安装包自带，AI 不需要也不能安装它。只读。\n一律说「后台组件」，不出现 runtime、sing-box、进程名。"
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
                let facts = status_facts(&snapshot);
                ToolOutcome::ok(summary(&snapshot), snapshot).with_facts(facts)
            }
            Err(error) => failure(error),
        };
        envelope::finish(ctx, "RuntimeStatus", outcome)
    }
}

/// 卡片上的短事实：连接状态、版本、出口。都是用户能看懂的值。
fn status_facts(snapshot: &Value) -> Vec<String> {
    let state = snapshot
        .get("state")
        .and_then(Value::as_str)
        .unwrap_or("unknown");
    let mut facts = vec![if matches!(state, "running" | "degraded") {
        "连接状态：已连接".to_string()
    } else {
        "连接状态：未连接".to_string()
    }];
    if let Some(version) = snapshot.get("upstream_version").and_then(Value::as_str) {
        facts.push(format!("版本：{version}"));
    }
    if let Some(ip) = snapshot
        .get("health")
        .and_then(|health| health.get("exit_ip"))
        .and_then(Value::as_str)
    {
        facts.push(format!("出口：{ip}"));
    }
    facts
}

fn source_label(source: &str) -> &'static str {
    match source {
        "bundled" => "随包",
        "installed" => "已安装",
        _ => "来源未知",
    }
}

/// 「未运行」与「未安装」是两件事：前者只说明没有连接，后者才代表运行时不可用。
fn summary(snapshot: &Value) -> String {
    let state = snapshot
        .get("state")
        .and_then(Value::as_str)
        .unwrap_or("unknown");
    let connected = matches!(state, "running" | "degraded");
    let version = snapshot.get("upstream_version").and_then(Value::as_str);
    let source = snapshot
        .get("runtime_source")
        .and_then(Value::as_str)
        .unwrap_or("none");

    let runtime = match version {
        Some(version) if source != "none" => {
            format!("运行时 {version}（{}）", source_label(source))
        }
        Some(version) => format!("运行时 {version}"),
        None => "运行时不可用".to_string(),
    };

    if connected {
        let exit_ip = snapshot
            .get("health")
            .and_then(|health| health.get("exit_ip"))
            .and_then(Value::as_str)
            .unwrap_or("未知");
        format!("运行状态 {state}，{runtime}，出口 {exit_ip}。")
    } else {
        format!("运行状态 {state}，{runtime}，未连接。")
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
        "启动 sing-box 运行时进程（使用当前激活配置）。不设置系统代理；需要代理请用 VpnConnect。\n一律说「后台组件」，不出现 runtime、sing-box、进程名。"
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
    "停止 sing-box 运行时并恢复系统代理。已是 idle 时为幂等成功。\n一律说「后台组件」，不出现 runtime、sing-box、进程名。",
    "运行时已停止，系统代理已恢复。",
    runtime_stop,
    false
);

lifecycle_tool!(
    RuntimeRestartTool,
    "RuntimeRestart",
    "重启 sing-box 运行时，用于应用新配置或恢复异常状态。\n一律说「后台组件」，不出现 runtime、sing-box、进程名。",
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
        let level = match super::optional_string(&input, "level") {
            Ok(value) => value,
            Err(error) => {
                return envelope::finish(ctx, "RuntimeLogs", ToolOutcome::fail(error))
            }
        };

        let outcome = match self.services.runtime_logs(lines, level).await {
            Ok(data) => {
                let count = data
                    .get("lines")
                    .and_then(Value::as_array)
                    .map(|items| items.len())
                    .unwrap_or(0);
                let facts = if count == 0 {
                    vec!["记录：空".to_string()]
                } else {
                    vec![format!("最近：{count} 行")]
                };
                ToolOutcome::ok(format_logs(&data), data).with_facts(facts)
            }
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

#[cfg(test)]
mod status_summary_tests {
    use super::*;
    use serde_json::json;

    /// 未连接但随包运行时可用：总结必须带版本与来源，且不能出现「未安装」。
    #[test]
    fn an_idle_snapshot_with_a_bundled_runtime_is_not_reported_as_uninstalled() {
        let text = summary(&json!({
            "state": "idle",
            "upstream_version": "1.14.4",
            "runtime_source": "bundled",
            "health": { "exit_ip": null }
        }));
        assert_eq!(text, "运行状态 idle，运行时 1.14.4（随包），未连接。");
        assert!(!text.contains("未安装"), "{text}");
        assert!(!text.contains("不可用"), "{text}");
    }

    #[test]
    fn an_installed_runtime_is_labelled_as_installed() {
        let text = summary(&json!({
            "state": "failed",
            "upstream_version": "1.15.0",
            "runtime_source": "installed",
            "health": { "exit_ip": null }
        }));
        assert_eq!(text, "运行状态 failed，运行时 1.15.0（已安装），未连接。");
    }

    /// 只有确实没有可用运行时（`runtime_source = none`）才可以说不可用。
    #[test]
    fn an_unavailable_runtime_is_reported_only_when_there_is_none() {
        let text = summary(&json!({
            "state": "idle",
            "upstream_version": null,
            "runtime_source": "none",
            "health": { "exit_ip": null }
        }));
        assert_eq!(text, "运行状态 idle，运行时不可用，未连接。");
        assert!(!text.contains("未安装"), "{text}");
    }

    #[test]
    fn a_connected_snapshot_keeps_the_exit_ip() {
        let text = summary(&json!({
            "state": "running",
            "upstream_version": "1.14.4",
            "runtime_source": "bundled",
            "health": { "exit_ip": "203.0.113.9" }
        }));
        assert_eq!(
            text,
            "运行状态 running，运行时 1.14.4（随包），出口 203.0.113.9。"
        );
    }
}
