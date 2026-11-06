//! `docs/contracts/tools.md` §1：工具结果的信封、错误对象与下一步动作。

use std::collections::{HashMap, VecDeque};
use std::sync::OnceLock;

use claurst_tools::{ToolContext, ToolResult};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::display::{self, Changed, Display};

pub const CONTRACT_VERSION: &str = "3.6.1";

#[derive(Clone, Debug, Serialize)]
pub struct AivpnError {
    pub contract_version: String,
    pub code: String,
    pub message: String,
    pub retryable: bool,
    pub details: Option<Value>,
    pub request_id: String,
}

impl AivpnError {
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            contract_version: CONTRACT_VERSION.to_string(),
            code: code.to_string(),
            message: message.into(),
            retryable: false,
            details: None,
            request_id: String::new(),
        }
    }

    pub fn retryable(mut self) -> Self {
        self.retryable = true;
        self
    }

    pub fn with_details(mut self, details: Value) -> Self {
        self.details = Some(details);
        self
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct NextAction {
    pub label: String,
    pub tool: String,
    pub args: Value,
}

#[derive(Clone, Debug, Default)]
pub struct ToolOutcome {
    pub ok: bool,
    pub summary: String,
    pub data: Option<Value>,
    pub error: Option<AivpnError>,
    pub next_actions: Vec<NextAction>,
    /// 给用户看的完成/失败摘要；工具没填时由 `finish` 按工具名兜底。
    pub display: Display,
}

impl ToolOutcome {
    pub fn ok(summary: impl Into<String>, data: Value) -> Self {
        Self {
            ok: true,
            summary: summary.into(),
            data: Some(data),
            error: None,
            next_actions: Vec::new(),
            display: Display::default(),
        }
    }

    pub fn fail(error: AivpnError) -> Self {
        Self {
            ok: false,
            summary: error.message.clone(),
            data: None,
            error: Some(error),
            next_actions: Vec::new(),
            display: Display::default(),
        }
    }

    pub fn with_next(mut self, action: NextAction) -> Self {
        self.next_actions.push(action);
        self
    }

    /// 显式给出给用户看的文案与 changed（VpnConnect 等关键工具用）。
    pub fn with_display(
        mut self,
        text: impl Into<String>,
        facts: Vec<String>,
        changed: Changed,
    ) -> Self {
        self.display = Display::new(text, changed).with_facts(facts);
        self
    }

    /// 保留自动文案，只补充结构化事实。
    pub fn with_facts(mut self, facts: Vec<String>) -> Self {
        self.display.facts = facts;
        self
    }

    /// 显式声明改动状态；失败点在写入前 / 回滚后 / 真不确定时各写各的。
    pub fn with_changed(mut self, changed: Changed) -> Self {
        self.display.changed = changed;
        self
    }

    fn to_envelope(&self) -> Value {
        // 用户文案只给 UI，不进信封：信封是给模型看的上下文。
        json!({
            "contract_version": CONTRACT_VERSION,
            "ok": self.ok,
            "summary": self.summary,
            "data": self.data,
            "error": self.error,
            "next_actions": self.next_actions,
            "request_id": "",
            "duration_ms": 0,
        })
    }
}

/// 进程内最近一次工具结果，按 (session_id, tool_name) 排队。
///
/// Claurst 的 `QueryEvent::ToolEnd` 只带 `result: String`，不回传
/// `ToolResult.metadata`，所以 Host 在投影 `tool-call-end` 时从这里取
/// `error_code` / `next_actions`。P1 的工具调用基本串行，队列按序配对。
fn registry() -> &'static Mutex<HashMap<String, VecDeque<ToolOutcome>>> {
    static REGISTRY: OnceLock<Mutex<HashMap<String, VecDeque<ToolOutcome>>>> = OnceLock::new();
    REGISTRY.get_or_init(|| Mutex::new(HashMap::new()))
}

fn key(session_id: &str, tool: &str) -> String {
    format!("{session_id}::{tool}")
}

pub fn take_outcome(session_id: &str, tool: &str) -> Option<ToolOutcome> {
    let mut guard = registry().lock();
    let queue = guard.get_mut(&key(session_id, tool))?;
    let outcome = queue.pop_front();
    if queue.is_empty() {
        guard.remove(&key(session_id, tool));
    }
    outcome
}

/// 把结果登记进注册表，并转成 Claurst 的 `ToolResult`。
pub fn finish(ctx: &ToolContext, tool: &str, mut outcome: ToolOutcome) -> ToolResult {
    normalize_display(tool, &mut outcome);
    {
        let mut guard = registry().lock();
        guard
            .entry(key(&ctx.session_id, tool))
            .or_default()
            .push_back(outcome.clone());
    }

    let content = if outcome.ok {
        outcome.summary.clone()
    } else {
        let error = outcome.error.as_ref();
        match error {
            Some(error) => format!(
                "{}{}",
                outcome.summary,
                error
                    .details
                    .as_ref()
                    .and_then(|details| details.get("hint"))
                    .and_then(Value::as_str)
                    .map(|hint| format!(" 建议：{hint}"))
                    .unwrap_or_default()
            ),
            None => outcome.summary.clone(),
        }
    };

    let metadata = json!({ "aivpn": outcome.to_envelope() });

    if outcome.ok {
        ToolResult::success(content).with_metadata(metadata)
    } else {
        ToolResult::error(content).with_metadata(metadata)
    }
}

/// 补齐工具没写的 display，并压到契约上限。
fn normalize_display(tool: &str, outcome: &mut ToolOutcome) {
    let fallback = display::fallback(tool, outcome.ok);
    if outcome.display.text.trim().is_empty() {
        outcome.display.text = fallback.text;
        if outcome.display.facts.is_empty() {
            outcome.display.facts = fallback.facts;
        }
        // Unknown 是默认值；显式写过 `with_display` 的工具不会走到这里。
        if outcome.display.changed == Changed::Unknown && fallback.changed != Changed::Unknown {
            outcome.display.changed = fallback.changed;
        }
    }

    // 成功时界面不显示「有没有改动」；`restored` 的参照点是调用前，不能当「已生效」用。
    if outcome.ok {
        outcome.display.changed = Changed::None;
    }

    // 只读工具永远没有改动，避免调用点漏填时 UI 误报。
    if display::is_readonly(tool) {
        outcome.display.changed = Changed::None;
    }

    outcome.display.text = display::clamp_text(&outcome.display.text);
    outcome.display.facts.retain(|fact| !fact.trim().is_empty());
    outcome.display.facts.truncate(4);
}

/// `tools.md` §2.5：输入参数预览，敏感字段打码；全被打码时返回 None。
pub fn args_preview(schema: &Value, input: &Value) -> Option<Value> {
    const BLACKLIST: [&str; 10] = [
        "key",
        "token",
        "secret",
        "password",
        "uuid",
        "private_key",
        "short_id",
        "auth",
        "apikey",
        "api_key",
    ];

    let object = input.as_object()?;
    let properties = schema.get("properties").and_then(Value::as_object);

    let mut out = serde_json::Map::new();
    let mut masked_only = true;

    for (name, value) in object.iter().take(8) {
        let sensitive = properties
            .and_then(|props| props.get(name))
            .and_then(|prop| prop.get("sensitive"))
            .and_then(Value::as_bool)
            .unwrap_or(false)
            || BLACKLIST
                .iter()
                .any(|needle| name.to_lowercase().contains(needle));

        if sensitive {
            out.insert(name.clone(), Value::String("***".to_string()));
            continue;
        }

        masked_only = false;
        out.insert(name.clone(), truncate(value));
    }

    if masked_only || out.is_empty() {
        return None;
    }
    Some(Value::Object(out))
}

fn truncate(value: &Value) -> Value {
    match value {
        Value::String(text) if text.chars().count() > 200 => {
            Value::String(format!("{}…", text.chars().take(200).collect::<String>()))
        }
        other => other.clone(),
    }
}

#[cfg(test)]
mod display_projection_tests {
    use super::*;
    use serde_json::json;

    fn failed(tool: &str) -> ToolOutcome {
        let mut outcome = ToolOutcome::fail(AivpnError::new(
            "INTERNAL",
            "proxy failed at /Users/x/config.json (code INTERNAL)",
        ));
        normalize_display(tool, &mut outcome);
        outcome
    }

    /// 失败文案只描述「没做到什么」，错误码与内部路径留在 error.details。
    #[test]
    fn failure_display_never_leaks_the_error_code_or_internal_paths() {
        for tool in ["VpnConnect", "ConfigDelete", "NetRepair", "CoreUpgrade"] {
            let outcome = failed(tool);
            let text = &outcome.display.text;
            for needle in ["INTERNAL", "/Users", "config.json"] {
                assert!(!text.contains(needle), "{tool} 的展示文案泄露了 {needle}：{text}");
            }
            assert!(outcome.error.is_some(), "错误对象本身不能丢");
        }
    }

    /// 工具没给 display 时按工具名兜底，成功与失败各有文案。
    #[test]
    fn missing_display_is_filled_from_the_tool_table() {
        let mut ok = ToolOutcome::ok("internal model text", json!({}));
        normalize_display("ConfigCreate", &mut ok);
        assert_eq!(ok.display.text, "配置已创建");
        // 成功时 changed 固定 none；restored 只用于「改过又恢复」。
        assert_eq!(ok.display.changed, Changed::None);

        let failed = failed("VpnConnect");
        assert_eq!(failed.display.text, "没能连上");
        assert_eq!(failed.display.changed, Changed::Unknown);
    }

    /// 只读工具即使调用点漏填，也不能报「有改动」。
    #[test]
    fn read_only_tools_are_forced_to_changed_none() {
        let mut outcome =
            ToolOutcome::ok("x", json!({})).with_display("已读取", vec![], Changed::Restored);
        normalize_display("RuntimeStatus", &mut outcome);
        assert_eq!(outcome.display.changed, Changed::None);
    }

    #[test]
    fn explicit_display_is_kept_and_facts_are_capped_at_four() {
        let mut outcome = ToolOutcome::ok("x", json!({})).with_display(
            "已连接",
            ["a", "b", "c", "d", "e"]
                .iter()
                .map(|item| item.to_string())
                .collect(),
            Changed::Restored,
        );
        normalize_display("VpnConnect", &mut outcome);
        assert_eq!(outcome.display.text, "已连接");
        assert_eq!(outcome.display.facts.len(), 4);
        assert_eq!(outcome.display.changed, Changed::None);
    }

    /// `display` 只进 `tool-call-end`，不能写进给模型的信封。
    #[test]
    fn envelope_does_not_carry_display() {
        let mut outcome = ToolOutcome::ok("x", json!({}))
            .with_display("已断开", vec!["网络：已恢复直连".into()], Changed::None);
        normalize_display("VpnDisconnect", &mut outcome);
        let envelope = outcome.to_envelope();
        assert!(envelope.get("display").is_none(), "{envelope}");
        // 事件投影仍能从同一份 outcome 读到 display。
        assert_eq!(outcome.display.text, "已断开");
        assert_eq!(outcome.display.changed, Changed::None);
    }
}
