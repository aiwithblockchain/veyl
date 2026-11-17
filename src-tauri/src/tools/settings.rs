//! `OpenSettings`：把用户带到设置里正确的位置（`tools.md` §4.50）。
//!
//! 只指路，不改任何值；未知 `row` 降级为 null，不报错。一轮对话最多一次。

use std::sync::Arc;

use async_trait::async_trait;
use claurst_tools::{PermissionLevel, Tool, ToolContext, ToolResult};
use serde_json::{json, Value};

use super::display::Changed;
use super::envelope::{self, AivpnError, ToolOutcome};
use super::turn_guard;
use crate::claurst_session::events::{self, EV_SETTINGS_POINT};

/// 行 id 白名单（`tools.md` §4.50；与 `commands.md` §9.1.1 的 controls 同源）。
pub const SETTINGS_ROWS: [&str; 11] = [
    "connection.mode",
    "connection.scope",
    "connection.port",
    "ai.provider",
    "ai.other",
    "account.login",
    "account.balance",
    "advanced.core",
    "advanced.helper",
    "advanced.logs",
    "advanced.reset",
];

const SECTIONS: [&str; 4] = ["ai", "connection", "account", "advanced"];

fn section_label(section: &str) -> &'static str {
    match section {
        "ai" => "AI",
        "connection" => "连接",
        "account" => "账户",
        "advanced" => "高级",
        _ => "设置",
    }
}

fn invalid(reason: &str, message: &str) -> AivpnError {
    AivpnError::new("INVALID_ARGUMENT", message).with_details(json!({ "reason": reason }))
}

#[derive(Debug)]
struct Request {
    section: String,
    row: Option<String>,
}

fn parse_input(input: &Value) -> Result<Request, AivpnError> {
    let Some(object) = input.as_object() else {
        return Err(invalid("invalid_payload", "参数必须是一个对象"));
    };
    for key in object.keys() {
        if key != "section" && key != "row" {
            return Err(invalid("unknown_argument", &format!("不支持的参数 {key}")));
        }
    }

    let section = object
        .get("section")
        .and_then(Value::as_str)
        .ok_or_else(|| invalid("invalid_section", "缺少 section"))?;
    if !SECTIONS.contains(&section) {
        return Err(invalid(
            "invalid_section",
            "section 只能是 AI、连接、账户、高级之一",
        ));
    }

    let row = match object.get("row") {
        None | Some(Value::Null) => None,
        Some(Value::String(text)) => {
            let trimmed = text.trim();
            if SETTINGS_ROWS.contains(&trimmed) {
                Some(trimmed.to_string())
            } else {
                // 未知行不是错误：仍然打开 section，只是定位不到具体行。
                None
            }
        }
        Some(_) => return Err(invalid("invalid_row", "row 必须是字符串")),
    };

    Ok(Request {
        section: section.to_string(),
        row,
    })
}

type Emitter = Arc<dyn Fn(Value) + Send + Sync>;

pub struct OpenSettingsTool {
    emit: Emitter,
}

impl OpenSettingsTool {
    pub fn new() -> Self {
        Self {
            emit: Arc::new(|payload| {
                crate::agent::app_handle::emit(EV_SETTINGS_POINT, payload);
            }),
        }
    }

    #[cfg(test)]
    pub fn with_emitter(emit: Emitter) -> Self {
        Self { emit }
    }
}

#[async_trait]
impl Tool for OpenSettingsTool {
    fn name(&self) -> &str {
        "OpenSettings"
    }

    fn description(&self) -> &str {
        "只在用户问「这个设置在哪里 / 怎么改」，或需要边指边解释某个设置项时调用。\
         只打开设置并指向对应位置，不改任何值；一轮对话最多一次，用户没问设置时不要调用。\n\
         段只能是 ai / connection / account / advanced；row 是可选的具体行。\
         说「AI」「连接」「账户」「高级」，不出现内部 id。"
    }

    fn permission_level(&self) -> PermissionLevel {
        PermissionLevel::ReadOnly
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "section": { "enum": ["ai", "connection", "account", "advanced"] },
                "row": { "type": "string", "minLength": 1, "maxLength": 40 }
            },
            "required": ["section"],
            "additionalProperties": false
        })
    }

    async fn execute(&self, input: Value, ctx: &ToolContext) -> ToolResult {
        let outcome = match parse_input(&input) {
            Ok(request) => {
                if !turn_guard::claim("OpenSettings", ctx) {
                    ToolOutcome::fail(
                        AivpnError::new("PRECONDITION_FAILED", "这一轮已经打开过设置了")
                            .with_details(json!({ "reason": "already_opened" })),
                    )
                    .with_display(
                        "这一轮已经打开过设置了",
                        Vec::new(),
                        Changed::None,
                    )
                } else {
                    let row_matched = request.row.is_some();
                    (self.emit)(json!({
                        "contract_version": crate::runtime::EVENT_CONTRACT_VERSION,
                        "section": &request.section,
                        "row": &request.row,
                        "emitted_at": events::now(),
                    }));
                    let label = section_label(&request.section);
                    let summary = if row_matched {
                        format!("已打开设置里的「{label}」并定位到对应行。")
                    } else {
                        format!("已打开设置里的「{label}」。")
                    };
                    ToolOutcome::ok(
                        summary,
                        json!({
                            "opened": true,
                            "section": &request.section,
                            "row": &request.row,
                            "row_matched": row_matched,
                        }),
                    )
                    .with_display(
                        format!("已打开设置 · {label}"),
                        Vec::new(),
                        Changed::None,
                    )
                }
            }
            Err(error) => {
                ToolOutcome::fail(error).with_display("没能打开设置", Vec::new(), Changed::None)
            }
        };
        envelope::finish(ctx, "OpenSettings", outcome)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::permission_handler::AivpnPermissionHandler;
    use claurst_core::file_history::FileHistory;
    use claurst_core::{CostTracker, PermissionMode};
    use std::sync::atomic::AtomicUsize;
    use std::sync::Mutex;

    fn context(session: &str, turn: usize) -> ToolContext {
        let dir = std::env::temp_dir();
        ToolContext {
            working_dir: dir.clone(),
            permission_mode: PermissionMode::BypassPermissions,
            permission_handler: Arc::new(AivpnPermissionHandler::new(dir)),
            cost_tracker: CostTracker::with_model("test"),
            session_id: session.to_string(),
            file_history: Arc::new(parking_lot::Mutex::new(FileHistory::new())),
            current_turn: Arc::new(AtomicUsize::new(turn)),
            non_interactive: true,
            mcp_manager: None,
            config: Default::default(),
            managed_agent_config: None,
            completion_notifier: None,
            pending_permissions: None,
            permission_manager: None,
            user_question_tx: None,
            cancel_token: tokio_util::sync::CancellationToken::new(),
            batch_rejection: Default::default(),
        }
    }

    fn recorder() -> (Emitter, Arc<Mutex<Vec<Value>>>) {
        let events = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::clone(&events);
        (
            Arc::new(move |payload| sink.lock().unwrap().push(payload)),
            events,
        )
    }

    #[test]
    fn unknown_rows_downgrade_and_known_rows_match() {
        let request = parse_input(&json!({
            "section": "connection",
            "row": "connection.mode"
        }))
        .unwrap();
        assert_eq!(request.row.as_deref(), Some("connection.mode"));

        let request = parse_input(&json!({
            "section": "connection",
            "row": "connection.nope"
        }))
        .unwrap();
        assert_eq!(request.row, None, "未知 row 必须降级为 null");

        let request = parse_input(&json!({ "section": "ai" })).unwrap();
        assert_eq!(request.row, None, "row 是可选的");
    }

    #[test]
    fn unknown_section_and_extra_arguments_are_rejected() {
        assert_eq!(
            parse_input(&json!({ "section": "system" }))
                .unwrap_err()
                .code,
            "INVALID_ARGUMENT"
        );
        assert_eq!(
            parse_input(&json!({ "section": "ai", "value": 1 }))
                .unwrap_err()
                .code,
            "INVALID_ARGUMENT"
        );
    }

    #[tokio::test]
    async fn one_open_per_turn_and_event_only_on_success() {
        let (emit, events) = recorder();
        let tool = OpenSettingsTool::with_emitter(emit);
        let session = format!("settings-test-{:016x}", rand::random::<u64>());
        let ctx = context(&session, 7);

        let first = tool.execute(json!({ "section": "connection" }), &ctx).await;
        assert!(!first.is_error, "{}", first.content);
        assert_eq!(events.lock().unwrap().len(), 1);

        // 同一轮第二次：拒绝，且不能重复发事件。
        let second = tool.execute(json!({ "section": "ai" }), &ctx).await;
        assert!(second.is_error);
        assert_eq!(events.lock().unwrap().len(), 1);
        let meta = second.metadata.unwrap();
        assert_eq!(meta["aivpn"]["error"]["code"], "PRECONDITION_FAILED");

        // 下一轮可以再打开一次。
        let next_turn = context(&session, 8);
        let third = tool
            .execute(json!({ "section": "account" }), &next_turn)
            .await;
        assert!(!third.is_error, "{}", third.content);
        assert_eq!(events.lock().unwrap().len(), 2);
    }

    #[tokio::test]
    async fn invalid_input_never_emits() {
        let (emit, events) = recorder();
        let tool = OpenSettingsTool::with_emitter(emit);
        let ctx = context(&format!("settings-bad-{:016x}", rand::random::<u64>()), 1);
        let result = tool.execute(json!({ "section": "nope" }), &ctx).await;
        assert!(result.is_error);
        assert!(
            events.lock().unwrap().is_empty(),
            "失败不能发 settings-point"
        );
    }

    #[tokio::test]
    async fn unknown_row_still_emits_with_null_row() {
        let (emit, events) = recorder();
        let tool = OpenSettingsTool::with_emitter(emit);
        let ctx = context(&format!("settings-null-{:016x}", rand::random::<u64>()), 1);
        let result = tool
            .execute(json!({ "section": "advanced", "row": "nope" }), &ctx)
            .await;
        assert!(!result.is_error, "{}", result.content);
        let emitted = events.lock().unwrap();
        assert_eq!(emitted.len(), 1);
        assert_eq!(emitted[0]["row"], Value::Null);
        assert_eq!(emitted[0]["section"], "advanced");
    }
}
