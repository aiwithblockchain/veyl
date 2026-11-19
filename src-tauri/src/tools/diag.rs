use std::sync::Arc;

use async_trait::async_trait;
use claurst_tools::{PermissionLevel, Tool, ToolContext, ToolResult};
use serde_json::{json, Value};

use super::display::Changed;
use super::envelope::{self, AivpnError, NextAction, ToolOutcome};
use super::services::VpnToolServices;

pub struct DiagRunTool {
    services: Arc<dyn VpnToolServices>,
}

impl DiagRunTool {
    pub fn new(services: Arc<dyn VpnToolServices>) -> Self {
        Self { services }
    }
}

/// 覆盖项不通过时给用户一个可点的下一步。**不自动切换**：`DiagRun` 仍是只读。
fn coverage_next_action(coverage_failed: bool) -> Option<NextAction> {
    coverage_failed.then(|| NextAction {
        label: "切到全部接管".into(),
        tool: "ConfigSetMode".into(),
        args: json!({ "mode": "tun" }),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_failed_coverage_check_offers_the_switch_action() {
        let action = coverage_next_action(true).expect("必须有可点动作");
        assert_eq!(action.label, "切到全部接管");
        assert_eq!(action.tool, "ConfigSetMode");
        assert_eq!(action.args["mode"], "tun");
    }

    #[test]
    fn a_passing_coverage_check_offers_nothing() {
        assert!(coverage_next_action(false).is_none());
    }
}

#[async_trait]
impl Tool for DiagRunTool {
    fn name(&self) -> &str {
        "DiagRun"
    }

    fn description(&self) -> &str {
        "跑一次网络诊断：运行时/进程/控制面/数据面、系统代理逐服务、DNS、默认路由、\
         出口 IP、Veyl 免费节点源/GitHub/DeepSeek 可达性、当前配置与 Veyl 免费节点版本。\
         同时给出当前接管方式覆盖哪些流量。\
         每项带 status（ok / failed / skipped）、detail、remediation 与可点击 action。\
         skipped 表示当前状态不适用、这一项没有检查，不是故障。连接失败时用它定位原因。\n说检查结果；不出现 DNS 地址列表、路由表、字段名。"
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
                // 按 `status` 数，不按 `ok`：skipped 项 `ok` 是 false，但那是
                // 「没检查」而不是「坏了」——算进失败会让界面对不适用项报红。
                let checks = data
                    .get("checks")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default();
                let count = |wanted: &str| {
                    checks
                        .iter()
                        .filter(|check| {
                            check.get("status").and_then(Value::as_str) == Some(wanted)
                        })
                        .count()
                };
                let failed = count("failed");
                let skipped = count("skipped");
                let coverage_failed = checks.iter().any(|check| {
                    check.get("name").and_then(Value::as_str) == Some("network.coverage")
                        && check.get("status").and_then(Value::as_str) == Some("failed")
                });
                // 前端只渲染前 4 条 facts，超出的会被静默截掉——加新行前先数一下，
                // 不然用户看不到、模型也不会提，功能等于没做。
                let mut facts = vec![match (failed, skipped) {
                    (0, 0) => "结果：全部检查正常".to_string(),
                    (0, skipped_items) => format!("结果：{skipped_items} 项这次没检查"),
                    (failed_items, 0) => format!("结果：{failed_items} 项异常"),
                    (failed_items, skipped_items) => {
                        format!("结果：{failed_items} 项异常，{skipped_items} 项没检查")
                    }
                }];
                if coverage_failed {
                    facts.push("接管范围：不覆盖浏览器 HTTP/3".to_string());
                }
                let outcome = ToolOutcome::ok(
                    match (failed, skipped) {
                        (0, 0) => "诊断通过，没有发现异常。",
                        (0, _) => "诊断完成，有几项这次没检查。",
                        _ => "诊断完成，有检查项未通过，详情见 data.checks。",
                    },
                    data,
                )
                .with_display(
                    if failed > 0 {
                        "诊断发现问题"
                    } else if skipped > 0 {
                        // 没检查的项不能说「通过」：结论只覆盖实际检查过的部分。
                        "诊断完成"
                    } else {
                        "诊断通过"
                    },
                    facts,
                    Changed::None,
                );
                if coverage_failed {
                    // 不自动切换：DiagRun 仍是 ReadOnly，交给用户点。
                    match coverage_next_action(coverage_failed) {
                        Some(action) => outcome.with_next(action),
                        None => outcome,
                    }
                } else {
                    outcome
                }
            }
            Err(error) => ToolOutcome::fail(AivpnError::new("INTERNAL", error.to_string())),
        };
        envelope::finish(ctx, "DiagRun", outcome)
    }
}
