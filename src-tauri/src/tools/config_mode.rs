//! `ConfigSetMode`：在线切换接管方式（`system_proxy` ↔ `tun`）。
//!
//! 结构性约束：这条命令会**短暂断开当前连接**，所以必须由 Host 弹确认卡；
//! 模型只能发起，不能传 `confirm`、也不能代答。卡走既有 `AskUserQuestion`
//! 阻塞通道，未连接时不弹卡。工具只在用户明确要求换接管方式时调用。

use std::sync::Arc;

use async_trait::async_trait;
use claurst_tools::{PermissionLevel, Tool, ToolContext, ToolResult, UserQuestionEvent};
use serde_json::{json, Value};

use super::display::Changed;
use super::envelope::{self, AivpnError, NextAction, ToolOutcome};
use super::services::{ServiceError, VpnToolServices};
use crate::agent::questions;
use crate::tools::policy;

const KIND: &str = "config_set_mode_confirm";
const CONFIRM_OPTION: &str = "切换";
const CANCEL_OPTION: &str = "取消";

/// 左栏词汇：`tun` = 全部软件，`system_proxy` = 本机代理。
fn mode_label(mode: &str) -> &'static str {
    match mode {
        "tun" => "全部软件",
        "system_proxy" => "本机代理",
        _ => "未识别",
    }
}

fn service_error(error: anyhow::Error) -> AivpnError {
    if let Some(service) = error.downcast_ref::<ServiceError>() {
        let mut mapped = AivpnError::new(&service.code, service.message.clone());
        mapped.retryable = service.retryable;
        if let Some(details) = service.details.clone() {
            mapped = mapped.with_details(details);
        }
        return mapped;
    }
    let text = error.to_string();
    match text.split_once(": ") {
        Some((code, message))
            if !code.is_empty()
                && code
                    .chars()
                    .all(|c| c.is_ascii_uppercase() || c == '_') =>
        {
            AivpnError::new(code, message)
        }
        _ => AivpnError::new("INTERNAL", text),
    }
}

fn invalid(reason: &str, message: &str) -> AivpnError {
    AivpnError::new("INVALID_ARGUMENT", message).with_details(json!({ "reason": reason }))
}

/// 服务层要求确认时带回的上下文（`details` 里）。
struct ConfirmationRequest {
    config_id: String,
    mode: String,
    previous_mode: String,
}

fn confirmation_request(error: &anyhow::Error) -> Option<ConfirmationRequest> {
    let service = error.downcast_ref::<ServiceError>()?;
    let details = service.details.as_ref()?;
    if details.get("reason").and_then(Value::as_str) != Some("confirmation_required") {
        return None;
    }
    Some(ConfirmationRequest {
        config_id: details.get("config_id").and_then(Value::as_str)?.to_string(),
        mode: details.get("mode").and_then(Value::as_str)?.to_string(),
        previous_mode: details
            .get("previous_mode")
            .and_then(Value::as_str)?
            .to_string(),
    })
}

pub struct ConfigSetModeTool {
    services: Arc<dyn VpnToolServices>,
}

impl ConfigSetModeTool {
    pub fn new(services: Arc<dyn VpnToolServices>) -> Self {
        Self { services }
    }
}

#[async_trait]
impl Tool for ConfigSetModeTool {
    fn name(&self) -> &str {
        "ConfigSetMode"
    }

    fn description(&self) -> &str {
        "只在用户明确要求更换接管方式时调用（例如「让所有软件都走 VPN」「改回只让设了代理的软件走」）。\
         不得为了优化网络、不得在排障时顺手切换、不得在用户没提这件事时主动建议后自行执行。\
         会把接管方式在「全部软件」与「本机代理」之间切换，可能短暂断开当前连接，Host 会弹确认卡。\n\
         说「全部软件」「本机代理」，不出现 tun、system_proxy、config id。"
    }

    fn permission_level(&self) -> PermissionLevel {
        PermissionLevel::Execute
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "config_id": { "type": "string" },
                "mode": { "type": "string", "enum": ["system_proxy", "tun"] }
            },
            "required": ["mode"],
            "additionalProperties": false
        })
    }

    async fn execute(&self, input: Value, ctx: &ToolContext) -> ToolResult {
        let outcome = match self.run(input, ctx).await {
            Ok(outcome) => outcome,
            Err(error) => {
                let (text, changed) = error_display(&error);
                let facts = error_facts(&error);
                let next = relink_action(&error);
                let mut outcome = ToolOutcome::fail(error).with_display(text, facts, changed);
                if let Some(action) = next {
                    outcome = outcome.with_next(action);
                }
                outcome
            }
        };
        envelope::finish(ctx, "ConfigSetMode", outcome)
    }
}

impl ConfigSetModeTool {
    async fn run(&self, input: Value, ctx: &ToolContext) -> Result<ToolOutcome, AivpnError> {
        let (config_id, mode) = parse_input(&input)?;

        // 第一次不带确认：未连接时服务层直接执行，正在连（含启动窗口）时回
        // `confirmation_required`。门禁与「会不会断线」的判断都在服务层，工具不先查状态。
        match self
            .services
            .config_set_mode(config_id, &mode, false)
            .await
        {
            Ok(data) => Ok(self.success_outcome(&data)),
            Err(error) => {
                let Some(request) = confirmation_request(&error) else {
                    return Err(service_error(error));
                };
                self.ask_for_confirmation(ctx, &request).await?;
                match self
                    .services
                    .config_set_mode(Some(request.config_id), &request.mode, true)
                    .await
                {
                    Ok(data) => Ok(self.success_outcome(&data)),
                    // 首次失败的错误码保留；回滚结果由 details.restored 表达。
                    Err(error) => Err(service_error(error)),
                }
            }
        }
    }

    async fn ask_for_confirmation(
        &self,
        ctx: &ToolContext,
        request: &ConfirmationRequest,
    ) -> Result<(), AivpnError> {
        let request_id = policy::current_request_id(&ctx.session_id).ok_or_else(|| {
            AivpnError::new("INTERNAL", "无法确定当前请求，接管方式没有切换")
        })?;

        let question = format!(
            "把接管方式从「{}」换成「{}」？会短暂断开当前连接，切换后自动重连。\n是否切换？",
            mode_label(&request.previous_mode),
            mode_label(&request.mode)
        );
        let details = json!({
            "config_id": request.config_id,
            "mode": request.mode,
            "previous_mode": request.previous_mode,
            "will_disconnect": true,
        });

        let (tx, rx) = tokio::sync::oneshot::channel();
        questions::register_with(
            &ctx.session_id,
            &request_id,
            UserQuestionEvent {
                question,
                options: Some(vec![CONFIRM_OPTION.to_string(), CANCEL_OPTION.to_string()]),
                reply_tx: tx,
            },
            Some(questions::QuestionExtras {
                kind: KIND,
                details,
                // 默认焦点必须是「取消」。
                default_index: 1,
                target_version: None,
                artifact_sha256: None,
            }),
        );

        // 确认等待不计入工具超时；questions 层 15 分钟后自动回空串。
        let answer = rx.await.unwrap_or_default();
        let approved = answer == CONFIRM_OPTION
            && questions::consume_mode_consent(
                &ctx.session_id,
                &request_id,
                &request.config_id,
                &request.mode,
            );
        if approved {
            return Ok(());
        }
        Err(AivpnError::new("CANCELLED", "用户取消了切换，接管方式没有改动")
            .with_details(json!({
                "config_id": request.config_id,
                "mode": request.mode,
                "previous_mode": request.previous_mode,
            })))
    }

    fn success_outcome(&self, data: &Value) -> ToolOutcome {
        let mode = data.get("mode").and_then(Value::as_str).unwrap_or("");
        let label = mode_label(mode);
        let changed = data.get("changed").and_then(Value::as_bool).unwrap_or(false);
        let connected = data
            .get("connected")
            .and_then(Value::as_bool)
            .unwrap_or(false);

        if !changed {
            return ToolOutcome::ok(
                format!("已经是「{label}」，没有改动。"),
                data.clone(),
            )
            .with_display(
                format!("已经是「{label}」，没有改动。"),
                vec![format!("当前：{label}")],
                Changed::None,
            );
        }

        // 切换会重新生成 plan，顺带应用这套配置其它待生效的改动；文案不能承诺「只改了接管方式」。
        let summary = if connected {
            format!(
                "已切换到「{label}」，连接已恢复。切换会顺带应用这套配置其它待生效的改动（DNS、分流、节点集）。"
            )
        } else {
            format!("已换成「{label}」，下次连接生效。")
        };
        let text = if connected {
            format!("已切换到「{label}」，连接已恢复。")
        } else {
            format!("已换成「{label}」，下次连接生效。")
        };
        let mut facts = vec![format!("方式：{label}")];
        if connected {
            facts.push("连接：已恢复".to_string());
        } else {
            facts.push("连接：未连接".to_string());
            facts.push("生效：下次连接".to_string());
        }
        ToolOutcome::ok(summary, data.clone()).with_display(text, facts, Changed::None)
    }
}

fn error_display(error: &AivpnError) -> (String, Changed) {
    if error.code == "CANCELLED" {
        return ("已取消，没有改动。".to_string(), Changed::None);
    }
    let details = error.details.as_ref();
    let restored = details
        .and_then(|details| details.get("restored"))
        .and_then(Value::as_bool);
    let mode = details
        .and_then(|details| details.get("mode"))
        .and_then(Value::as_str)
        .unwrap_or("");
    let previous = details
        .and_then(|details| details.get("previous_mode"))
        .and_then(Value::as_str)
        .unwrap_or("");
    match restored {
        Some(true) => (
            format!(
                "没能切到「{}」，已回到原来的「{}」。",
                mode_label(mode),
                mode_label(previous)
            ),
            Changed::Restored,
        ),
        Some(false) => (
            "没能切换，也没能恢复原来的方式".to_string(),
            Changed::Unknown,
        ),
        None => ("没能切换接管方式".to_string(), Changed::Unknown),
    }
}

/// 失败后界面上的两句事实：最终方式与连接状态（回滚失败时尤其不能只说「失败」）。
fn error_facts(error: &AivpnError) -> Vec<String> {
    let Some(details) = error.details.as_ref() else {
        return Vec::new();
    };
    let restored = details.get("restored").and_then(Value::as_bool);
    let mode = details.get("mode").and_then(Value::as_str).unwrap_or("");
    let previous = details
        .get("previous_mode")
        .and_then(Value::as_str)
        .unwrap_or("");
    match restored {
        Some(true) => vec![
            format!("方式：{}", mode_label(previous)),
            "连接：已恢复".to_string(),
        ],
        Some(false) => vec![
            format!("方式：{}", mode_label(mode)),
            "连接：未连接".to_string(),
        ],
        None => Vec::new(),
    }
}

fn relink_action(error: &AivpnError) -> Option<NextAction> {    let restored = error
        .details
        .as_ref()
        .and_then(|details| details.get("restored"))
        .and_then(Value::as_bool);
    if restored != Some(false) {
        return None;
    }
    let config_id = error
        .details
        .as_ref()
        .and_then(|details| details.get("config_id"))
        .and_then(Value::as_str);
    Some(NextAction {
        label: "重新连接".to_string(),
        tool: "VpnConnect".to_string(),
        args: config_id
            .map(|id| json!({ "config_id": id }))
            .unwrap_or_else(|| json!({})),
    })
}

fn parse_input(input: &Value) -> Result<(Option<String>, String), AivpnError> {
    let Some(object) = input.as_object() else {
        return Err(invalid("invalid_payload", "参数必须是一个对象"));
    };
    // 没有 confirm：确认只能由 Host 的卡片完成（tools.md §4.49）。
    for key in object.keys() {
        if key != "config_id" && key != "mode" {
            return Err(invalid(
                "unknown_argument",
                &format!("不支持的参数 {key}；确认由界面卡片完成"),
            ));
        }
    }
    let mode = object
        .get("mode")
        .and_then(Value::as_str)
        .ok_or_else(|| invalid("invalid_connect_mode", "缺少 mode"))?
        .to_string();
    if !matches!(mode.as_str(), "system_proxy" | "tun") {
        return Err(invalid("invalid_connect_mode", "只支持「全部软件」与「本机代理」两种方式"));
    }
    let config_id = match object.get("config_id") {
        None | Some(Value::Null) => None,
        Some(Value::String(value)) if !value.trim().is_empty() => {
            Some(value.trim().to_string())
        }
        Some(Value::String(_)) => None,
        Some(_) => return Err(invalid("invalid_config_id", "config_id 必须是字符串")),
    };
    Ok((config_id, mode))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn confirm_is_not_an_accepted_argument() {
        let error = parse_input(&json!({ "mode": "tun", "confirm": true })).unwrap_err();
        assert_eq!(error.code, "INVALID_ARGUMENT");
        assert_eq!(
            error.details.unwrap()["reason"],
            "unknown_argument"
        );
    }

    #[test]
    fn only_the_two_connection_modes_are_accepted() {
        for mode in ["vpn", "direct", ""] {
            let error = parse_input(&json!({ "mode": mode })).unwrap_err();
            assert_eq!(error.code, "INVALID_ARGUMENT", "{mode}");
        }
        assert_eq!(
            parse_input(&json!({ "mode": "tun" })).unwrap(),
            (None, "tun".to_string())
        );
    }

    #[test]
    fn mode_labels_use_the_left_panel_words() {
        assert_eq!(mode_label("tun"), "全部软件");
        assert_eq!(mode_label("system_proxy"), "本机代理");
        assert_eq!(mode_label("other"), "未识别");
    }

    #[test]
    fn a_cancelled_switch_reports_no_change() {
        let error = AivpnError::new("CANCELLED", "取消");
        assert_eq!(error_display(&error), ("已取消，没有改动。".to_string(), Changed::None));
    }

    #[test]
    fn a_failed_rollback_is_reported_as_unknown_not_restored() {
        let error = AivpnError::new("PRECONDITION_FAILED", "x").with_details(json!({
            "mode": "tun",
            "previous_mode": "system_proxy",
            "restored": false,
        }));
        let (text, changed) = error_display(&error);
        assert!(text.contains("没能恢复"), "{text}");
        assert_eq!(changed, Changed::Unknown);
        assert_eq!(relink_action(&error).unwrap().tool, "VpnConnect");
        let facts = error_facts(&error);
        assert!(
            facts.iter().any(|fact| fact == "方式：全部软件"),
            "{facts:?}"
        );
        assert!(facts.iter().any(|fact| fact == "连接：未连接"), "{facts:?}");
    }
}
