//! `docs/contracts/tools.md` §1：工具结果的信封、错误对象与下一步动作。

use std::collections::{HashMap, VecDeque};
use std::sync::OnceLock;

use claurst_tools::{ToolContext, ToolResult};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

pub const CONTRACT_VERSION: &str = "1.0.7";

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
}

impl ToolOutcome {
    pub fn ok(summary: impl Into<String>, data: Value) -> Self {
        Self {
            ok: true,
            summary: summary.into(),
            data: Some(data),
            error: None,
            next_actions: Vec::new(),
        }
    }

    pub fn fail(error: AivpnError) -> Self {
        Self {
            ok: false,
            summary: error.message.clone(),
            data: None,
            error: Some(error),
            next_actions: Vec::new(),
        }
    }

    pub fn with_next(mut self, action: NextAction) -> Self {
        self.next_actions.push(action);
        self
    }

    fn to_envelope(&self) -> Value {
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
pub fn finish(ctx: &ToolContext, tool: &str, outcome: ToolOutcome) -> ToolResult {
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
