//! 前端事件的构造与发送（`docs/contracts/events.md` v1.0.4）。
//!
//! 事件名是契约冻结值，不带 `ai-` 前缀；payload 一律带 `contract_version`
//! 与 `emitted_at`。

use serde_json::{json, Value};

use crate::agent::app_handle;
use crate::tools::{AivpnError, Display, NextAction};

pub const CONTRACT_VERSION: &str = "2.9.0";

pub const EV_MESSAGE_CHUNK: &str = "message-chunk";
pub const EV_THINKING_CHUNK: &str = "thinking-chunk";
pub const EV_TOOL_CALL_START: &str = "tool-call-start";
pub const EV_TOOL_CALL_END: &str = "tool-call-end";
pub const EV_STATUS: &str = "ai-status";
pub const EV_COMPACT: &str = "ai-compact";
pub const EV_REQUEST_END: &str = "ai-request-end";
pub const EV_RUNTIME_STATE_CHANGED: &str = "runtime-state-changed";
pub const EV_RUNTIME_HEALTH_CHANGED: &str = "runtime-health-changed";
pub const EV_CORE_UPGRADE_PROGRESS: &str = "core-upgrade-progress";
pub const EV_CORE_UPGRADE_FINISHED: &str = "core-upgrade-finished";
pub const EV_JOB_PROGRESS: &str = "job-progress";
pub const EV_ASK_USER_QUESTION: &str = "ask-user-question";

const RESULT_LIMIT: usize = 8 * 1024;

pub fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

/// 一轮请求的事件发射器：把 request_id / assistant_message_id 绑在一起，
/// 调用点不用每次重复。
pub struct SessionEmitter {
    request_id: String,
    assistant_message_id: String,
}

impl SessionEmitter {
    pub fn new(request_id: impl Into<String>, assistant_message_id: impl Into<String>) -> Self {
        Self {
            request_id: request_id.into(),
            assistant_message_id: assistant_message_id.into(),
        }
    }

    fn base(&self) -> Value {
        json!({
            "contract_version": CONTRACT_VERSION,
            "request_id": self.request_id,
            "assistant_message_id": self.assistant_message_id,
        })
    }

    fn emit(&self, name: &str, mut payload: Value) {
        if let Some(object) = payload.as_object_mut() {
            object.insert("emitted_at".to_string(), Value::String(now()));
        }
        app_handle::emit(name, payload);
    }

    pub fn message_chunk(&self, chunk: &str) {
        let mut payload = self.base();
        payload["chunk"] = Value::String(chunk.to_string());
        self.emit(EV_MESSAGE_CHUNK, payload);
    }

    pub fn thinking_chunk(&self, chunk: &str) {
        let mut payload = self.base();
        payload["chunk"] = Value::String(chunk.to_string());
        self.emit(EV_THINKING_CHUNK, payload);
    }

    pub fn status(&self, phase: &str, text: &str) {
        let mut payload = self.base();
        payload["phase"] = Value::String(phase.to_string());
        payload["text"] = Value::String(text.to_string());
        self.emit(EV_STATUS, payload);
    }

    pub fn compact(&self, phase: &str, text: &str, before: Option<u64>, after: Option<u64>) {
        let mut payload = self.base();
        payload["phase"] = Value::String(phase.to_string());
        payload["text"] = Value::String(text.to_string());
        payload["tokens_before"] = json!(before);
        payload["tokens_after"] = json!(after);
        self.emit(EV_COMPACT, payload);
    }

    #[allow(clippy::too_many_arguments)]
    pub fn tool_start(
        &self,
        tool_call_id: &str,
        tool: &str,
        action: &str,
        permission_level: &str,
        args_preview: Option<Value>,
    ) {
        let mut payload = self.base();
        payload["tool_call_id"] = Value::String(tool_call_id.to_string());
        payload["tool"] = Value::String(tool.to_string());
        payload["action"] = Value::String(action.to_string());
        payload["permission_level"] = Value::String(permission_level.to_string());
        payload["source"] = Value::String("agent".to_string());
        if let Some(preview) = args_preview {
            payload["args_preview"] = preview;
        }
        self.emit(EV_TOOL_CALL_START, payload);
    }

    #[allow(clippy::too_many_arguments)]
    pub fn tool_end(
        &self,
        tool_call_id: &str,
        tool: &str,
        success: bool,
        result: &str,
        error_code: Option<String>,
        duration_ms: u64,
        next_actions: Vec<NextAction>,
        display: Option<Display>,
    ) {
        let payload = self.tool_end_payload(
            tool_call_id,
            tool,
            success,
            result,
            error_code,
            duration_ms,
            next_actions,
            display,
        );
        self.emit(EV_TOOL_CALL_END, payload);
    }

    #[allow(clippy::too_many_arguments)]
    fn tool_end_payload(
        &self,
        tool_call_id: &str,
        tool: &str,
        success: bool,
        result: &str,
        error_code: Option<String>,
        duration_ms: u64,
        next_actions: Vec<NextAction>,
        display: Option<Display>,
    ) -> Value {
        let (text, truncated) = truncate_result(result);
        let mut payload = self.base();
        payload["tool_call_id"] = Value::String(tool_call_id.to_string());
        payload["tool"] = Value::String(tool.to_string());
        payload["success"] = Value::Bool(success);
        payload["result"] = Value::String(text);
        payload["result_truncated"] = Value::Bool(truncated);
        payload["error_code"] = json!(error_code);
        payload["duration_ms"] = json!(duration_ms);
        payload["next_actions"] = serde_json::to_value(next_actions).unwrap_or(Value::Array(vec![]));
        // 卡片只读这份摘要；`result` 是给模型的，含操作指令，不能直接渲染。
        payload["display"] = serde_json::to_value(display).unwrap_or(Value::Null);
        payload
    }

    #[allow(clippy::too_many_arguments)]
    pub fn request_end(
        &self,
        result: &str,
        final_text: Option<String>,
        error: Option<AivpnError>,
        usage: Option<Value>,
        duration_ms: u64,
    ) {
        let mut payload = self.base();
        payload["result"] = Value::String(result.to_string());
        payload["final_text"] = json!(final_text);
        payload["error"] = serde_json::to_value(error).unwrap_or(Value::Null);
        payload["usage"] = usage.unwrap_or(Value::Null);
        payload["duration_ms"] = json!(duration_ms);
        self.emit(EV_REQUEST_END, payload);
    }
}

fn truncate_result(text: &str) -> (String, bool) {
    if text.len() <= RESULT_LIMIT {
        return (text.to_string(), false);
    }
    let mut cut = RESULT_LIMIT;
    while cut > 0 && !text.is_char_boundary(cut) {
        cut -= 1;
    }
    (format!("{}…(truncated)", &text[..cut]), true)
}

#[cfg(test)]
mod display_projection_tests {
    use super::*;
    use crate::tools::Changed;

    fn payload(display: Option<Display>) -> Value {
        let emitter = SessionEmitter::new("req_1", "msg_1");
        emitter.tool_end_payload(
            "tool_1",
            "ConfigList",
            true,
            "给模型看的正文",
            None,
            12,
            vec![],
            display,
        )
    }

    #[test]
    fn display_is_projected_into_tool_call_end() {
        let display = Display::new("已读取配置列表", Changed::None).with_facts(vec![
            "3 套配置".to_string(),
        ]);
        let payload = payload(Some(display));
        assert_eq!(payload["display"]["text"], json!("已读取配置列表"));
        assert_eq!(payload["display"]["facts"], json!(["3 套配置"]));
        assert_eq!(payload["display"]["changed"], json!("none"));
    }

    /// AskUserQuestion 这类没有 ToolOutcome 的调用不产生展示行。
    #[test]
    fn missing_display_is_null() {
        let payload = payload(None);
        assert_eq!(payload["display"], Value::Null);
    }

    /// 卡片数据与给模型的 result 是两条线，前者不能带出指令文本。
    #[test]
    fn display_text_is_independent_from_the_model_facing_result() {
        let display = Display::new("已读取配置列表", Changed::None);
        let payload = payload(Some(display));
        assert!(payload["result"].as_str().unwrap().contains("给模型看"));
        assert!(!payload["display"]["text"]
            .as_str()
            .unwrap()
            .contains("给模型看"));
    }
}
