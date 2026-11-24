use std::sync::Arc;

use async_trait::async_trait;
use claurst_tools::{PermissionLevel, Tool, ToolContext, ToolResult};
use serde_json::{json, Value};

use super::display::{Changed, Fact, FactKey};
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

/// 检查项 id 到中文名的固定映射。映射里没有的保留原名——名字是事实，
/// 宁可露英文 id 也不编一个听起来像真的中文名。
fn check_label(name: &str) -> &str {
    match name {
        "app.runtime_installed" => "运行库",
        "app.process_alive" => "后台进程",
        "app.version" => "运行时版本",
        "app.config_valid" => "配置",
        "app.clash_api" => "控制面",
        "app.data_plane" => "数据面",
        "system.proxy_services" => "系统代理",
        "system.dns" => "DNS",
        "system.default_route" => "默认路由",
        "network.exit_ip" => "出口 IP",
        "network.coverage" => "接管范围",
        "network.reachable_seed_source" => "免费节点源",
        "network.reachable_github" => "GitHub 访问",
        "config.current_config" => "当前配置",
        "config.trial_state" => "免费节点试用",
        "config.seed_available" => "免费节点缓存",
        "config.seed_stale" => "免费节点更新",
        other => other,
    }
}

fn check_str<'a>(check: &'a Value, key: &str) -> &'a str {
    check.get(key).and_then(Value::as_str).unwrap_or("")
}

/// 把 `checks` 写成模型能直接读的清单。模型只看得到 `content`，
/// 所以每项的结论、原因与建议都必须落在这里，不能指去 `data`。
fn format_diag_summary(checks: &[Value]) -> String {
    if checks.is_empty() {
        return "诊断没有返回任何检查项。".into();
    }
    let failed = checks
        .iter()
        .filter(|check| check_str(check, "status") == "failed")
        .count();
    let skipped = checks
        .iter()
        .filter(|check| check_str(check, "status") == "skipped")
        .count();
    let mut lines = Vec::with_capacity(checks.len() + 2);
    // 两个计数都写出来：只给未通过数，模型会自己用总数减去它，
    // 把没检查的项算成正常。
    lines.push(if failed == 0 && skipped == 0 {
        format!("诊断完成：共 {} 项检查，全部正常。", checks.len())
    } else if failed == 0 {
        format!("诊断完成：共 {} 项检查，{skipped} 项没检查。", checks.len())
    } else if skipped == 0 {
        format!("诊断完成：共 {} 项检查，{failed} 项未通过。", checks.len())
    } else {
        format!(
            "诊断完成：共 {} 项检查，{failed} 项未通过，{skipped} 项没检查。",
            checks.len()
        )
    });
    for check in checks {
        let label = check_label(check_str(check, "name"));
        let detail = check_str(check, "detail").trim();
        let line = match check_str(check, "status") {
            "failed" => {
                let remediation = check_str(check, "remediation").trim();
                let mut line = format!("- {label}：失败");
                if !detail.is_empty() {
                    line.push_str(" —— ");
                    line.push_str(detail);
                }
                if !remediation.is_empty() {
                    line.push_str(" → ");
                    line.push_str(remediation);
                }
                line
            }
            // skipped 是「没检查」不是故障；括号里的 detail 说明为什么没查。
            "ok" => {
                if detail.is_empty() {
                    format!("- {label}：正常")
                } else {
                    format!("- {label}：正常 —— {detail}")
                }
            }
            _ => {
                if detail.is_empty() {
                    format!("- {label}：没检查")
                } else {
                    format!("- {label}：没检查（{detail}）")
                }
            }
        };
        lines.push(line);
    }
    let next = checks.iter().find_map(|check| {
        (check_str(check, "status") == "failed")
            .then(|| check_str(check, "remediation").trim())
            .filter(|remediation| !remediation.is_empty())
    });
    if let Some(remediation) = next {
        lines.push(format!("下一步：{remediation}。"));
    }
    lines.join("\n")
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

    fn check(name: &str, status: &str, detail: &str, remediation: Option<&str>) -> Value {
        json!({
            "name": name,
            "group": "app",
            "status": status,
            "ok": status == "ok",
            "detail": detail,
            "remediation": remediation,
            "action": null,
        })
    }

    #[test]
    fn an_all_ok_diagnosis_says_so_and_lists_each_check() {
        let checks = vec![
            check("app.process_alive", "ok", "进程在运行", None),
            check("system.proxy_services", "ok", "代理配置正常", None),
        ];
        let text = format_diag_summary(&checks);
        assert!(text.starts_with("诊断完成：共 2 项检查，全部正常。"));
        assert!(text.contains("- 后台进程：正常 —— 进程在运行"));
        assert!(text.contains("- 系统代理：正常 —— 代理配置正常"));
        assert!(!text.contains("下一步"));
    }

    #[test]
    fn an_ok_check_without_detail_shows_only_the_status() {
        let checks = vec![check("network.exit_ip", "ok", "", None)];
        let text = format_diag_summary(&checks);
        assert!(text.contains("- 出口 IP：正常"));
        assert!(!text.contains("——"));
    }

    #[test]
    fn a_failed_check_carries_detail_and_remediation_and_sets_the_next_step() {
        let checks = vec![
            check("app.process_alive", "ok", "进程在运行", None),
            check(
                "system.dns",
                "failed",
                "3 个解析器，example.com 无法解析",
                Some("刷新 DNS 缓存后重试"),
            ),
            check("system.default_route", "ok", "默认网关正常", None),
        ];
        let text = format_diag_summary(&checks);
        assert!(text.starts_with("诊断完成：共 3 项检查，1 项未通过。"));
        assert!(
            text.contains("- DNS：失败 —— 3 个解析器，example.com 无法解析 → 刷新 DNS 缓存后重试")
        );
        assert!(text.ends_with("下一步：刷新 DNS 缓存后重试。"));
        assert!(!text.contains("data"));
        assert!(!text.contains("checks"));
    }

    #[test]
    fn a_skipped_check_reads_as_not_checked_not_as_failure() {
        let checks = vec![
            check("app.clash_api", "skipped", "未连接", None),
            check("network.reachable_seed_source", "ok", "可达", None),
        ];
        let text = format_diag_summary(&checks);
        assert!(text.starts_with("诊断完成：共 2 项检查，1 项没检查。"));
        assert!(text.contains("- 控制面：没检查（未连接）"));
        assert!(!text.contains("未通过"));
        assert!(!text.contains("下一步"));
    }

    #[test]
    fn a_failed_and_a_skipped_check_are_both_counted_in_the_headline() {
        let checks = vec![
            check("system.dns", "failed", "无法解析", Some("重新连接后再试")),
            check("app.process_alive", "ok", "进程在运行", None),
            check("app.clash_api", "skipped", "未连接", None),
        ];
        let text = format_diag_summary(&checks);
        assert!(text.starts_with("诊断完成：共 3 项检查，1 项未通过，1 项没检查。"));
    }

    #[test]
    fn an_unknown_check_name_keeps_its_original_id() {
        let checks = vec![check("future.check", "failed", "出错了", None)];
        let text = format_diag_summary(&checks);
        assert!(text.contains("- future.check：失败 —— 出错了"));
    }

    #[test]
    fn an_empty_check_list_says_so_instead_of_inventing_one() {
        assert_eq!(format_diag_summary(&[]), "诊断没有返回任何检查项。");
    }

    /// 诊断发出的每个检查 id 都要有中文名，否则模型会看到英文 id。
    #[test]
    fn every_check_the_diagnosis_emits_has_a_chinese_label() {
        let ids = [
            "app.runtime_installed",
            "app.process_alive",
            "app.version",
            "app.config_valid",
            "app.clash_api",
            "app.data_plane",
            "system.proxy_services",
            "system.dns",
            "system.default_route",
            "network.exit_ip",
            "network.coverage",
            "network.reachable_seed_source",
            "network.reachable_github",
            "config.current_config",
            "config.trial_state",
            "config.seed_available",
            "config.seed_stale",
        ];
        for id in ids {
            assert_ne!(check_label(id), id, "{id} 缺少中文名");
        }
        assert_eq!(check_label("future.check"), "future.check");
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
                // 结论计数交给界面选句子；HTTP/3 覆盖范围单独一行。
                let mut facts = vec![Fact::with_params(
                    FactKey::DiagResult,
                    json!({ "failed": failed, "skipped": skipped }),
                )];
                if coverage_failed {
                    facts.push(Fact::new(FactKey::ScopeNoHttp3));
                }
                let outcome = ToolOutcome::ok(format_diag_summary(&checks), data)
                    .with_display(facts, Changed::None);
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
