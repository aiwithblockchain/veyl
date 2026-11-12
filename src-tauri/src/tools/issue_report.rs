use std::sync::Arc;

use async_trait::async_trait;
use claurst_tools::{PermissionLevel, Tool, ToolContext, ToolResult};
use serde_json::{json, Value};

use super::display::{Changed, DisplayAction};
use super::envelope::{self, AivpnError, ToolOutcome};
use super::services::{ServiceError, VpnToolServices};

/// 卡片事实里的保存位置：折叠成 `~`；折叠不了就不显示这一行（绝不回退绝对路径）。
fn display_location(dir: &str) -> Option<String> {
    // `data.report_dir` 已经是折叠后的形式（`~/…` 或目录名），不要再折一次：
    // 对 `~/…` 再调 `fold_home` 既匹配不上绝对 home，也可能切在多字节字符中间。
    let shown = if dir.starts_with('~') || (!dir.contains('/') && !dir.contains('\\')) {
        dir.to_string()
    } else {
        crate::reports::fold_home(dir)?
    };
    Some(format!("保存位置：{shown}"))
}

pub struct IssueReportTool {
    services: Arc<dyn VpnToolServices>,
}

impl IssueReportTool {
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
impl Tool for IssueReportTool {
    fn name(&self) -> &str {
        "IssueReport"
    }

    fn description(&self) -> &str {
        "把当前现场整理成一份脱敏的问题报告，放在用户桌面上的文件夹里。\
两阶段：不带 report_markdown 是收集材料（返回脱敏摘要与日志行号）；\
带 report_markdown 是写入报告（只覆盖本会话目录里的 报告.md）。\
不改配置、不碰网络，只写这一个固定目录；没有、也不接受任何路径参数。\
日志行号用 materials.logs[].start_line + 下标引用，格式 日志/<文件名>:<行号>。\n\
写报告时第一句必须原样说出：「报告只保存在你的电脑上；生成时，脱敏后的日志会发给你配置的 AI 服务。要不要把它发出去，由你决定。」\
报告结构固定：# 问题报告 / ## 现象 / ## 环境 / ## 时间线 / ## 可疑点 / ## 下一步建议；\
每条可疑点至少引用一处 日志/<文件>:<行号> 或 现场.json:<字段>，没有证据的判断不写。"
    }

    fn permission_level(&self) -> PermissionLevel {
        // 会写盘：不能声明成只读，否则未来的只读快速通道会绕过检查。
        PermissionLevel::Write
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "log_lines": { "type": "integer", "minimum": 40, "maximum": 400, "default": 200 },
                "include_domains": {
                    "type": "boolean",
                    "description": "省略表示遵循用户的隐私设置；显式传 false 才是主动收窄。"
                },
                "report_markdown": { "type": "string", "maxLength": 131072 }
            },
            "additionalProperties": false
        })
    }

    async fn execute(&self, input: Value, ctx: &ToolContext) -> ToolResult {
        let parsed = match crate::reports::parse_input(&input) {
            Ok(parsed) => parsed,
            Err(reason) => {
                let error = AivpnError::new(
                    "INVALID_ARGUMENT",
                    "这次调用的参数不对（没有路径、日志行数 40–400）。",
                )
                .with_details(json!({ "reason": reason }));
                return envelope::finish(ctx, "IssueReport", ToolOutcome::fail(error));
            }
        };

        let outcome = match self
            .services
            .issue_report(&ctx.session_id, parsed)
            .await
        {
            Ok(data) => {
                let written = data.get("phase").and_then(Value::as_str) == Some("written");
                let report_id = data
                    .get("report_id")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string();
                let dir = data
                    .get("report_dir")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string();
                let log_count = data
                    .get("files")
                    .and_then(Value::as_array)
                    .map(|files| {
                        files
                            .iter()
                            .filter(|file| {
                                file.get("name")
                                    .and_then(Value::as_str)
                                    .is_some_and(|name| name.starts_with("日志/"))
                                    && file.get("missing") != Some(&Value::Bool(true))
                            })
                            .count()
                    })
                    .unwrap_or(0);
                let mut outcome = ToolOutcome::ok(
                    if written {
                        "问题报告已生成。"
                    } else {
                        "现场材料已收集，接下来把报告写进同一个文件夹。"
                    },
                    data,
                )
                .with_display(
                    if written {
                        "问题报告已生成"
                    } else {
                        "现场材料已收集"
                    },
                    {
                        let mut facts = Vec::new();
                        if let Some(location) = display_location(&dir) {
                            facts.push(location);
                        }
                        facts.push(format!("包含 {log_count} 份日志"));
                        facts
                    },
                    Changed::None,
                );
                // 收集阶段也带动作：AI 写报告失败时，用户仍要能打开文件夹 / 发邮件。
                let _ = written;
                outcome.display.actions = vec![
                    DisplayAction::RevealReportDir {
                        report_id: report_id.clone(),
                    },
                    DisplayAction::ComposeReportMail { report_id },
                ];
                outcome
            }
            Err(error) => ToolOutcome::fail(service_error(error)),
        };
        envelope::finish(ctx, "IssueReport", outcome)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn display_location_accepts_folded_and_bare_names() {
        assert_eq!(
            display_location("~/Desktop/Veyl 问题报告/2026-11-12-1530").as_deref(),
            Some("保存位置：~/Desktop/Veyl 问题报告/2026-11-12-1530")
        );
        assert_eq!(
            display_location("2026-11-12-1530").as_deref(),
            Some("保存位置：2026-11-12-1530")
        );
        // 不在主目录下的绝对路径：折叠不了就不显示，绝不再暴露绝对路径。
        assert!(display_location("/definitely/not/home/x").is_none());
    }
}
