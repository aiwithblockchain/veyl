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
            Ok(data) => ToolOutcome::ok(summarise_versions(&data), data),
            Err(error) => ToolOutcome::fail(AivpnError::new("INTERNAL", error.to_string())),
        };
        envelope::finish(ctx, "CoreListVersions", outcome)
    }
}


/// 把版本清单渲染成模型可直接引用的形式。
/// 只写计数的话，模型只能猜版本号，紧接着的 CoreInstall 必然 NOT_FOUND。
fn summarise_versions(data: &Value) -> String {
    let installed: Vec<&str> = data
        .get("installed")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.get("version").and_then(Value::as_str))
                .collect()
        })
        .unwrap_or_default();

    let available: Vec<(&str, &str)> = data
        .get("available")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    let version = item.get("version").and_then(Value::as_str)?;
                    let channel = item
                        .get("channel")
                        .and_then(Value::as_str)
                        .unwrap_or("stable");
                    Some((version, channel))
                })
                .collect()
        })
        .unwrap_or_default();

    let mut lines = Vec::new();
    if installed.is_empty() {
        lines.push("已安装：无".to_string());
    } else {
        lines.push(format!("已安装：{}", installed.join("、")));
    }

    if available.is_empty() {
        lines.push("可安装：无（内置清单里没有当前平台可用的版本）".to_string());
        if !installed.is_empty() {
            lines.push("已安装的版本可以直接调用 RuntimeStart。".to_string());
        }
    } else {
        lines.push("可安装：".to_string());
        for (version, channel) in &available {
            lines.push(format!("- {version} ({channel})"));
        }
        lines.push(format!(
            "使用版本号调用 CoreInstall，例如 CoreInstall(\"{}\")。",
            available[0].0
        ));
    }

    lines.join("\n")
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
        "安装指定版本的官方 sing-box。**优先用安装包内自带的运行时，不需要联网**；\
         自带的那份缺失、或版本与请求的不一致时才下载。安装后即可用于启动运行时。"
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

#[cfg(test)]
mod version_summary_tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn lists_versions_instead_of_counting_them() {
        let data = json!({
            "active_version": null,
            "installed": [],
            "available": [
                { "version": "1.14.4", "channel": "stable" },
                { "version": "1.13.0", "channel": "stable" }
            ]
        });

        let text = summarise_versions(&data);
        assert!(text.contains("已安装：无"), "{text}");
        assert!(text.contains("- 1.14.4 (stable)"), "{text}");
        assert!(text.contains("- 1.13.0 (stable)"), "{text}");
        // 引导语里必须出现模型下一步要用的标识符。
        assert!(text.contains("CoreInstall(\"1.14.4\")"), "{text}");
    }

    #[test]
    fn shows_installed_versions_when_there_are_any() {
        let data = json!({
            "installed": [{ "version": "1.14.4", "state": "active" }],
            "available": [{ "version": "1.14.4", "channel": "stable" }]
        });
        let text = summarise_versions(&data);
        assert!(text.contains("已安装：1.14.4"), "{text}");
        assert!(text.contains("CoreInstall(\"1.14.4\")"), "{text}");
    }

    #[test]
    fn an_empty_catalog_still_says_what_to_do_next() {
        let data = json!({
            "installed": [{ "version": "1.14.4", "state": "active" }],
            "available": []
        });
        let text = summarise_versions(&data);
        assert!(text.contains("可安装：无"), "{text}");
        assert!(text.contains("RuntimeStart"), "{text}");
    }
}
