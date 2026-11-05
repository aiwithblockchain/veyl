use std::sync::Arc;

use async_trait::async_trait;
use claurst_tools::{PermissionLevel, Tool, ToolContext, ToolResult};
use serde_json::{json, Value};

use super::envelope::{self, AivpnError, ToolOutcome};
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
/// 只写计数的话，模型连「现在用的是哪个版本」都不知道，诊断只能靠猜。
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
        // 升级只能在用户明确要求时发起：可以用 CoreUpgrade（会弹确认卡），
        // 也可以让用户到「高级设置 → 运行库」手动操作。
        lines.push(
            "用户明确要求更新运行库时，可用 CoreUpgrade（会先弹确认卡并等待用户选「升级」）；\
也可以提示用户到「高级设置 → 运行库」手动操作。"
                .to_string(),
        );
    }

    lines.join("\n")
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
        // 升级只能在用户明确要求时发起，且必须经过确认卡。
        assert!(text.contains("高级设置"), "{text}");
        assert!(text.contains("CoreUpgrade"), "{text}");
        assert!(!text.contains("CoreInstall"), "{text}");
    }

    #[test]
    fn shows_installed_versions_when_there_are_any() {
        let data = json!({
            "installed": [{ "version": "1.14.4", "state": "active" }],
            "available": [{ "version": "1.14.4", "channel": "stable" }]
        });
        let text = summarise_versions(&data);
        assert!(text.contains("已安装：1.14.4"), "{text}");
        assert!(text.contains("高级设置"), "{text}");
        assert!(!text.contains("CoreInstall"), "{text}");
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
