//! `node_upgrade_singbox`：详情页「检查升级」的 Host 侧实现（契约 §7.35）。
//!
//! 与 `node_rotate_credentials` 共用同一条通道（`tools::node_rotate::call_agent_tool`）：
//! 一次性门票 → agent 控制端口的 MCP。Host 不做版本判断，入参只有 server_id；
//! 目标版本由节点用自身令牌现拉一次 `desired-state` 决定，App 传什么都装不进去。

use std::time::Duration;

use serde_json::{json, Value};

use crate::tools::envelope::AivpnError;
use crate::tools::node_rotate::{
    call_agent_tool, failure_reason, tool_failure, valid_server_id, AgentFailure,
};

const AGENT_TOOL: &str = "upgrade_singbox";
/// 升级 = 下载 + 重启 + 自检，比轮换的 90 秒更长（任务文档 §3.1）。
const UPGRADE_TIMEOUT: Duration = Duration::from_secs(180);
/// 节点侧原文最多留这么多字符（契约 §7.35）。
const FAILURE_DETAIL_LIMIT: usize = 300;

#[derive(Debug, Clone, PartialEq)]
struct UpgradeReport {
    installed: String,
    target: String,
    upgraded: bool,
}

/// 界面命令入口：只校验 id、转发调用、把回包翻成三个字段。
///
/// 成功不刷新本地凭据（端口与密码不变）；控制面的 `singbox_version` 由节点随后
/// 上报的 `active` 刷新，界面自己就地显示返回的 `target`。
pub(crate) async fn upgrade_from_ui(server_id: Option<Value>) -> Result<Value, AivpnError> {
    let server_id = parse_server_id(server_id)?;
    let started = std::time::Instant::now();
    log::info!("[node_upgrade] start server_id={server_id}");
    let result = call_agent_tool(
        &server_id,
        AGENT_TOOL,
        json!({}),
        UPGRADE_TIMEOUT,
        "node_upgrade",
    )
    .await
    .map_err(upgrade_error)
    .and_then(|(value, is_error)| interpret_reply(is_error, &value).map_err(upgrade_error));
    match result {
        Ok(report) => {
            log::info!(
                "[node_upgrade] status=ok upgraded={} elapsed_ms={}",
                report.upgraded,
                started.elapsed().as_millis()
            );
            Ok(report_json(&report))
        }
        Err(error) => {
            let reason = error
                .details
                .as_ref()
                .and_then(|details| details.get("reason"))
                .and_then(Value::as_str)
                .unwrap_or("unknown")
                .to_string();
            log::info!(
                "[node_upgrade] status=failed code={} reason={reason} elapsed_ms={}",
                error.code,
                started.elapsed().as_millis()
            );
            Err(error)
        }
    }
}

fn report_json(report: &UpgradeReport) -> Value {
    json!({
        "installed": report.installed,
        "target": report.target,
        "upgraded": report.upgraded,
    })
}

fn parse_server_id(server_id: Option<Value>) -> Result<String, AivpnError> {
    let server_id = server_id
        .as_ref()
        .and_then(Value::as_str)
        .unwrap_or_default();
    if valid_server_id(server_id) {
        Ok(server_id.to_string())
    } else {
        log::warn!("[node_upgrade] code=INVALID_ARGUMENT reason=invalid_server_id");
        Err(
            AivpnError::new("INVALID_ARGUMENT", "server_id 不合法，这次没有升级")
                .with_details(json!({ "reason": "invalid_server_id" })),
        )
    }
}

/// 成功回包没有 `ok` 字段（契约 §7.35）：只有显式 `ok:false` 或 `is_error` 才算失败。
fn interpret_reply(is_error: bool, value: &Value) -> Result<UpgradeReport, AgentFailure> {
    let ok = value.get("ok").and_then(Value::as_bool).unwrap_or(true);
    if !ok || is_error {
        return Err(if failure_reason(value) == Some("agent_busy") {
            AgentFailure::Busy
        } else {
            tool_failure(value)
        });
    }
    let installed = value
        .get("installed")
        .and_then(Value::as_str)
        .ok_or_else(|| AgentFailure::BadResponse("agent 回包缺少 installed".into()))?;
    let target = value
        .get("target")
        .and_then(Value::as_str)
        .ok_or_else(|| AgentFailure::BadResponse("agent 回包缺少 target".into()))?;
    let upgraded = value
        .get("upgraded")
        .and_then(Value::as_bool)
        .ok_or_else(|| AgentFailure::BadResponse("agent 回包缺少 upgraded".into()))?;
    Ok(UpgradeReport {
        installed: installed.to_string(),
        target: target.to_string(),
        upgraded,
    })
}

/// 失败只换「升级」的说法与 180 秒预算：code / reason 仍与轮换同一套（外加 `agent_busy`）。
fn upgrade_error(failure: AgentFailure) -> AivpnError {
    match failure {
        AgentFailure::Timeout => {
            let mut error = AivpnError::new("TIMEOUT", "节点在 180 秒内没有完成升级");
            error.retryable = true;
            error.with_details(json!({ "reason": "agent_timeout" }))
        }
        AgentFailure::BadResponse(detail) => {
            AivpnError::new("INTERNAL", "节点代理返回的数据不完整，这次没有升级")
                .with_details(json!({ "reason": "agent_bad_response", "detail": detail }))
        }
        AgentFailure::ToolFailed { message, retryable } => {
            let detail = truncate_chars(&message, FAILURE_DETAIL_LIMIT);
            let mut error = AivpnError::new("INTERNAL", format!("节点没能完成升级：{detail}"));
            error.retryable = retryable;
            error.with_details(json!({
                "reason": "agent_tool_failed",
                "retryable": retryable,
                "detail": detail,
            }))
        }
        other => other.into_aivpn(),
    }
}

/// 按字符截断（不是字节）：节点原文最多留 300 个字符给界面与日志。
fn truncate_chars(value: &str, max_chars: usize) -> String {
    if value.chars().count() <= max_chars {
        return value.to_string();
    }
    let mut truncated: String = value.chars().take(max_chars.saturating_sub(1)).collect();
    truncated.push('…');
    truncated
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_reply_is_interpreted_by_shape() {
        assert_eq!(
            interpret_reply(
                false,
                &json!({ "installed": "1.14.4", "target": "1.15.0", "upgraded": true })
            )
            .unwrap(),
            UpgradeReport {
                installed: "1.14.4".into(),
                target: "1.15.0".into(),
                upgraded: true,
            }
        );
        // 已是最新也是成功：upgraded=false，回包里没有任何 URL / 哈希。
        let latest = interpret_reply(
            false,
            &json!({ "installed": "1.14.4", "target": "1.14.4", "upgraded": false }),
        )
        .unwrap();
        assert!(!latest.upgraded);

        match interpret_reply(
            true,
            &json!({ "ok": false, "error": { "kind": "retryable", "message": "忙" } }),
        ) {
            Err(AgentFailure::ToolFailed {
                message,
                retryable: true,
            }) => assert_eq!(message, "忙"),
            other => panic!("{other:?}"),
        }

        for broken in [
            json!({ "target": "1.15.0", "upgraded": true }),
            json!({ "installed": "1.14.4", "upgraded": true }),
            json!({ "installed": "1.14.4", "target": "1.15.0" }),
        ] {
            assert!(matches!(
                interpret_reply(false, &broken),
                Err(AgentFailure::BadResponse(_))
            ));
        }
    }

    #[test]
    fn the_busy_lock_keeps_its_own_reason() {
        let error = interpret_reply(
            true,
            &json!({
                "ok": false,
                "error": { "kind": "retryable", "message": "节点正忙", "reason": "agent_busy" }
            }),
        )
        .unwrap_err();
        assert!(matches!(error, AgentFailure::Busy));
        let mapped = upgrade_error(error);
        assert_eq!(mapped.code, "INTERNAL");
        assert!(mapped.retryable);
        assert_eq!(mapped.details.as_ref().unwrap()["reason"], "agent_busy");
    }

    #[test]
    fn upgrade_failures_keep_the_reason_and_truncate_the_node_message() {
        let long = "x".repeat(400);
        let error = upgrade_error(AgentFailure::ToolFailed {
            message: long,
            retryable: true,
        });
        assert_eq!(error.code, "INTERNAL");
        let details = error.details.as_ref().unwrap();
        assert_eq!(details["reason"], "agent_tool_failed");
        assert_eq!(details["retryable"], true);
        let detail = details["detail"].as_str().unwrap();
        assert_eq!(detail.chars().count(), FAILURE_DETAIL_LIMIT);
        assert!(detail.ends_with('…'));

        let timeout = upgrade_error(AgentFailure::Timeout);
        assert_eq!(timeout.code, "TIMEOUT");
        assert!(timeout.message.contains("180"));
        assert_eq!(timeout.details.as_ref().unwrap()["reason"], "agent_timeout");

        // 其余 reason 与轮换完全一致。
        assert_eq!(
            upgrade_error(AgentFailure::TlsUntrusted("x".into()))
                .details
                .as_ref()
                .unwrap()["reason"],
            "agent_tls_untrusted"
        );
    }

    #[test]
    fn the_ui_result_has_exactly_three_fields() {
        let value = report_json(&UpgradeReport {
            installed: "1.14.4".into(),
            target: "1.15.0".into(),
            upgraded: true,
        });
        assert_eq!(
            value,
            json!({ "installed": "1.14.4", "target": "1.15.0", "upgraded": true })
        );
        // 没有 URL / 哈希 / 令牌，也没有 ok。
        assert_eq!(value.as_object().unwrap().len(), 3);
    }

    #[test]
    fn invalid_server_ids_are_rejected_before_any_request() {
        for input in [
            None,
            Some(json!("")),
            Some(json!("srv_../../evil")),
            Some(json!(42)),
        ] {
            let error = parse_server_id(input.clone()).unwrap_err();
            assert_eq!(error.code, "INVALID_ARGUMENT", "{input:?}");
            assert_eq!(
                error.details.as_ref().unwrap()["reason"],
                "invalid_server_id",
                "{input:?}"
            );
        }
        assert_eq!(
            parse_server_id(Some(json!("srv_abc123"))).unwrap(),
            "srv_abc123"
        );
    }
}
