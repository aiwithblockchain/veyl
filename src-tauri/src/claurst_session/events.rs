//! 前端事件的构造与发送（`docs/contracts/events.md` 2.23.0）。
//!
//! 事件名是契约冻结值，不带 `ai-` 前缀；payload 一律带 `contract_version`
//! 与 `emitted_at`。

use serde_json::{json, Value};

use crate::agent::app_handle;
use crate::tools::{AivpnError, Display, NextAction};

pub const CONTRACT_VERSION: &str = "2.25.0";

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
pub const EV_LAYOUT_UPDATED: &str = "layout-updated";
pub const EV_MY_SERVER_CHANGED: &str = "my-server-changed";
pub const EV_MY_SERVER_ORDER_CHANGED: &str = "my-server-order-changed";
pub const EV_MY_SERVER_ACCOUNT_CLEARED: &str = "my-server-account-cleared";
pub const EV_MY_SERVER_RENAMED: &str = "my-server-renamed";
pub const EV_QUIT_REQUESTED: &str = "quit-requested";
pub const EV_QUIT_DISMISSED: &str = "quit-dismissed";
pub const EV_TRIAL_EXPIRED: &str = "trial-expired";
pub const EV_SETTINGS_POINT: &str = "settings-point";
pub const EV_STAGE_SELECT: &str = "stage-select";

const RESULT_LIMIT: usize = 8 * 1024;

pub fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

/// 重试等待的整秒数。claurst 首次 backoff 是 750–999ms，向下取整会得到 0；
/// 说「0 秒后重试」既怪又不准，所以至少 1 秒（1500ms → 1 不变）。
pub fn retry_delay_seconds(delay_ms: u64) -> u64 {
    (delay_ms / 1000).max(1)
}

/// `retrying` 的插值参数（`events.md` §3.5）：秒数取整，1500ms → 1、750ms → 1。
pub fn retry_params(attempt: u32, max_attempts: u32, delay_ms: u64, reason: &str) -> Value {
    json!({
        "attempt": attempt,
        "max_attempts": max_attempts,
        "delay_seconds": retry_delay_seconds(delay_ms),
        "reason": reason,
    })
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

    /// `ai-status` 的 payload。`text_key` 是界面唯一文案来源（`events.md` §3.5）；
    /// 2.24.0 起不再下发 `text`。
    fn status_payload(&self, phase: &str, text_key: &str, params: Option<Value>) -> Value {
        let mut payload = self.base();
        payload["phase"] = Value::String(phase.to_string());
        payload["text_key"] = Value::String(text_key.to_string());
        if let Some(params) = params {
            payload["params"] = params;
        }
        payload
    }

    pub fn status(&self, phase: &str, text_key: &str, params: Option<Value>) {
        self.emit(EV_STATUS, self.status_payload(phase, text_key, params));
    }

    /// `ai-compact` 的 payload。`text_key` 固定 `ai.compact.done`（`events.md` §3.6）。
    fn compact_payload(&self, phase: &str, before: Option<u64>, after: Option<u64>) -> Value {
        let mut payload = self.base();
        payload["phase"] = Value::String(phase.to_string());
        payload["text_key"] = Value::String("ai.compact.done".to_string());
        payload["tokens_before"] = json!(before);
        payload["tokens_after"] = json!(after);
        payload
    }

    pub fn compact(&self, phase: &str, before: Option<u64>, after: Option<u64>) {
        self.emit(EV_COMPACT, self.compact_payload(phase, before, after));
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
    fn request_end_payload(
        &self,
        result: &str,
        final_text: Option<String>,
        error: Option<AivpnError>,
        usage: Option<Value>,
        duration_ms: u64,
    ) -> Value {
        let mut payload = self.base();
        payload["result"] = Value::String(result.to_string());
        payload["final_text"] = json!(final_text);
        payload["error"] = serde_json::to_value(error).unwrap_or(Value::Null);
        // 嵌在事件里的错误对象跟事件契约版本走；工具通道的 `AivpnError`
        // 仍是 tools.md 的版本，这里只在出事件时覆写。
        if let Some(obj) = payload["error"].as_object_mut() {
            obj.insert(
                "contract_version".into(),
                Value::String(CONTRACT_VERSION.into()),
            );
        }
        payload["usage"] = usage.unwrap_or(Value::Null);
        payload["duration_ms"] = json!(duration_ms);
        payload
    }

    pub fn request_end(
        &self,
        result: &str,
        final_text: Option<String>,
        error: Option<AivpnError>,
        usage: Option<Value>,
        duration_ms: u64,
    ) {
        self.emit(
            EV_REQUEST_END,
            self.request_end_payload(result, final_text, error, usage, duration_ms),
        );
    }
}

/// 布局落库后通知中间区。`revision` 由 `store::layout::set` 返回，UI 用它丢弃迟到事件。
pub fn layout_updated(config_id: &str, revision: i64, layout: &Value) {
    app_handle::emit(
        EV_LAYOUT_UPDATED,
        json!({
            "contract_version": CONTRACT_VERSION,
            "config_id": config_id,
            "revision": revision,
            "layout": layout,
            "emitted_at": now(),
        }),
    );
}

fn truncate_result(text: &str) -> (String, bool) {    if text.len() <= RESULT_LIMIT {
        return (text.to_string(), false);
    }
    let mut cut = RESULT_LIMIT;
    while cut > 0 && !text.is_char_boundary(cut) {
        cut -= 1;
    }
    (format!("{}…(truncated)", &text[..cut]), true)
}

#[cfg(test)]
mod status_payload_tests {
    use super::*;

    fn status(phase: &str, key: &str, params: Option<Value>) -> Value {
        SessionEmitter::new("req_1", "msg_1").status_payload(phase, key, params)
    }

    /// 2.24.0：状态事件只带 `text_key`（+ 可选 `params`），不再下发自由文本。
    #[test]
    fn every_status_payload_carries_the_key_and_no_free_text() {
        let payload = status("thinking", "ai.status.thinking", None);
        assert_eq!(payload["phase"], json!("thinking"));
        assert_eq!(payload["text_key"], json!("ai.status.thinking"));
        assert!(
            payload.get("text").is_none(),
            "2.24.0 起状态事件不再带 text"
        );
        assert!(
            payload.get("params").is_none(),
            "没有插值参数时不出现 params"
        );
        assert_eq!(payload["contract_version"], json!(CONTRACT_VERSION));
        assert_eq!(CONTRACT_VERSION, "2.25.0");
    }

    /// retrying 的四个插值参数（`events.md` §3.5）；秒数取整且至少 1：
    /// 1500ms → 1，claurst 首次 backoff 750ms → 1（不能说「0 秒后重试」）。
    #[test]
    fn retry_params_carry_the_four_documented_values() {
        let params = retry_params(1, 3, 1500, "rate_limited");
        assert_eq!(
            params,
            json!({
                "attempt": 1,
                "max_attempts": 3,
                "delay_seconds": 1,
                "reason": "rate_limited",
            })
        );

        assert_eq!(retry_params(1, 3, 750, "rate_limited")["delay_seconds"], 1);
        assert_eq!(retry_delay_seconds(750), 1);
        assert_eq!(retry_delay_seconds(1500), 1);
        assert_eq!(retry_delay_seconds(3_200), 3);

        let payload = status("retrying", "ai.status.retrying", Some(params));
        assert_eq!(payload["params"]["delay_seconds"], 1);
        assert_eq!(payload["params"]["reason"], json!("rate_limited"));
    }

    /// 事件里的错误对象跟事件契约版本走；工具通道的
    /// `AivpnError` 仍取 tools.md 的当前版本，code / details 原样保留。
    #[test]
    fn request_end_error_carries_the_event_contract_version() {
        let error = AivpnError::new("UPSTREAM_ERROR", "上游原文")
            .with_details(json!({ "reason": "provider_unavailable" }));
        assert_eq!(error.contract_version, crate::tools::envelope::CONTRACT_VERSION);

        let payload = SessionEmitter::new("req_1", "msg_1").request_end_payload(
            "error",
            None,
            Some(error),
            None,
            12,
        );
        assert_eq!(payload["contract_version"], json!(CONTRACT_VERSION));
        assert_eq!(
            payload["error"]["contract_version"],
            json!(CONTRACT_VERSION)
        );
        assert_eq!(payload["error"]["code"], json!("UPSTREAM_ERROR"));
        assert_eq!(payload["error"]["message"], json!("上游原文"));
        assert_eq!(
            payload["error"]["details"]["reason"],
            json!("provider_unavailable")
        );
    }

    /// 压缩事件有自己的 key（`events.md` §3.6），tokens 两个字段不动。
    #[test]
    fn compact_payload_carries_its_key_and_no_free_text() {
        let payload = SessionEmitter::new("req_1", "msg_1").compact_payload(
            "completed",
            Some(1200),
            Some(400),
        );
        assert_eq!(payload["phase"], json!("completed"));
        assert_eq!(payload["text_key"], json!("ai.compact.done"));
        assert_eq!(payload["tokens_before"], json!(1200));
        assert_eq!(payload["tokens_after"], json!(400));
        assert!(
            payload.get("text").is_none(),
            "2.24.0 起压缩事件不再带 text"
        );
        assert_eq!(payload["contract_version"], json!(CONTRACT_VERSION));
    }
}

#[cfg(test)]
mod display_projection_tests {
    use super::*;
    use crate::tools::{Changed, DisplayAction};
    use crate::tools::{Fact, FactKey};

    fn payload(display: Option<Display>) -> Value {
        let emitter = SessionEmitter::new("req_1", "msg_1");
        emitter.tool_end_payload(
            "tool_1",
            "ConfigDetail",
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
        let display = Display::new(Changed::None).with_facts(vec![Fact::with_params(
            FactKey::ConfigNodeCount,
            json!({ "count": 3 }),
        )]);
        let payload = payload(Some(display));
        assert!(
            payload["display"].get("text").is_none(),
            "2.24.0 不再下发自由文本"
        );
        assert_eq!(
            payload["display"]["facts"],
            json!([{ "key": "config.node_count", "params": { "count": 3 } }])
        );
        assert_eq!(payload["display"]["changed"], json!("none"));
    }

    /// AskUserQuestion 这类没有 ToolOutcome 的调用不产生展示行。
    #[test]
    fn missing_display_is_null() {
        let payload = payload(None);
        assert_eq!(payload["display"], Value::Null);
    }

    /// `display.actions`（2.11.0）：只有两个 kind，只带不透明的 report_id，不带路径。
    #[test]
    fn report_actions_carry_only_the_report_id() {
        let display = Display::new(Changed::None).with_actions(vec![
            DisplayAction::RevealReportDir {
                report_id: "rpt-20261112-153012-a1b2c3".into(),
            },
            DisplayAction::ComposeReportMail {
                report_id: "rpt-20261112-153012-a1b2c3".into(),
            },
        ]);
        let payload = payload(Some(display));
        let actions = payload["display"]["actions"].as_array().unwrap();
        assert_eq!(actions.len(), 2);
        assert_eq!(actions[0]["kind"], json!("reveal_report_dir"));
        assert_eq!(actions[1]["kind"], json!("compose_report_mail"));
        assert_eq!(actions[0]["report_id"], json!("rpt-20261112-153012-a1b2c3"));
        assert!(
            !payload["display"]["actions"].to_string().contains('/'),
            "动作里不能出现路径：{}",
            payload["display"]["actions"]
        );
    }

    /// 没有动作时事件形状与旧版一致（不出现 actions 字段）。
    #[test]
    fn displays_without_actions_keep_the_old_shape() {
        let display = Display::new(Changed::None);
        let payload = payload(Some(display));
        assert!(payload["display"].get("actions").is_none());
    }

    /// 卡片数据与给模型的 result 是两条线：display 里没有自由文本，也不会带出指令。
    #[test]
    fn display_carries_no_free_text_from_the_result() {
        let display = Display::new(Changed::None);
        let payload = payload(Some(display));
        assert!(payload["result"].as_str().unwrap().contains("给模型看"));
        assert!(payload["display"].get("text").is_none());
    }
}
