//! `docs/contracts/tools.md` §1：工具结果的信封、错误对象与下一步动作。

use std::collections::{HashMap, VecDeque};
use std::sync::OnceLock;

use claurst_tools::{ToolContext, ToolResult};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::display::{self, Changed, Display, Fact};

pub const CONTRACT_VERSION: &str = "3.39.0";

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

    /// 显式给出给用户看的事实与 changed（VpnConnect 等关键工具用）。
    /// 2.24.0：`display` 里没有自由文本，句子由前端按 `FactKey` 组装。
    pub fn with_display(mut self, facts: Vec<Fact>, changed: Changed) -> Self {
        self.display = Display::new(changed).with_facts(facts);
        self
    }

    /// 保留已声明的 changed，只补充结构化事实。
    pub fn with_facts(mut self, facts: Vec<Fact>) -> Self {
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

/// 补齐工具没写的 `changed`，并压到契约上限。
fn normalize_display(tool: &str, outcome: &mut ToolOutcome) {
    let fallback = display::fallback(tool, outcome.ok);
    // Unknown 是默认值；显式写过 `with_display` 的工具不会走到这里。
    if outcome.display.changed == Changed::Unknown && fallback.changed != Changed::Unknown {
        outcome.display.changed = fallback.changed;
    }

    // 成功时界面不显示「有没有改动」；`restored` 的参照点是调用前，不能当「已生效」用。
    if outcome.ok {
        outcome.display.changed = Changed::None;
    }

    // 只读工具永远没有改动，避免调用点漏填时 UI 误报。
    if display::is_readonly(tool) {
        outcome.display.changed = Changed::None;
    }

    outcome.display.facts.truncate(4);
}

/// `tools.md` §2.5：输入参数预览，敏感字段打码；全被打码时返回 None。
pub fn args_preview(schema: &Value, input: &Value) -> Option<Value> {
    let object = input.as_object()?;

    let mut out = serde_json::Map::new();
    let mut masked_only = true;

    for (name, value) in object.iter().take(8) {
        if is_sensitive_field(Some(schema), name) {
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

const SENSITIVE_KEY_NEEDLES: [&str; 10] = [
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

/// schema 标了 `sensitive: true`，或键名命中黑名单。展示与审计共用这一份规则。
fn is_sensitive_field(schema: Option<&Value>, name: &str) -> bool {
    let flagged = schema
        .and_then(|schema| schema.get("properties"))
        .and_then(Value::as_object)
        .and_then(|props| props.get(name))
        .and_then(|prop| prop.get("sensitive"))
        .and_then(Value::as_bool)
        .unwrap_or(false);

    flagged
        || SENSITIVE_KEY_NEEDLES
            .iter()
            .any(|needle| name.to_lowercase().contains(needle))
}

/// 审计落库用：只把敏感字段的值换成 `***`，其余字段原样保留（不截断、不丢键）。
/// 递归进嵌套对象与数组，避免 `target.password` 这类写法漏网。
pub fn redact_args(schema: Option<&Value>, input: &Value) -> Value {
    match input {
        Value::Object(object) => {
            let properties = schema
                .and_then(|schema| schema.get("properties"))
                .and_then(Value::as_object);
            let mut out = serde_json::Map::new();
            for (name, value) in object {
                if is_sensitive_field(schema, name) {
                    out.insert(name.clone(), Value::String("***".to_string()));
                    continue;
                }
                let child_schema = properties.and_then(|props| props.get(name));
                out.insert(name.clone(), redact_args(child_schema, value));
            }
            Value::Object(out)
        }
        Value::Array(items) => {
            let item_schema = schema.and_then(|schema| schema.get("items"));
            Value::Array(
                items
                    .iter()
                    .map(|item| redact_args(item_schema, item))
                    .collect(),
            )
        }
        other => other.clone(),
    }
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
    use crate::tools::display::FactKey;
    use serde_json::json;

    fn fact(i: u64) -> Fact {
        Fact::with_params(FactKey::CoreInstalledCount, json!({ "count": i }))
    }

    fn failed(tool: &str) -> ToolOutcome {
        let mut outcome = ToolOutcome::fail(AivpnError::new(
            "INTERNAL",
            "proxy failed at /Users/x/config.json (code INTERNAL)",
        ));
        normalize_display(tool, &mut outcome);
        outcome
    }

    /// 卡片里没有自由文本：错误码与内部路径只留在 error.details。
    #[test]
    fn failure_display_carries_no_free_text() {
        for tool in ["VpnConnect", "ConfigSetMode", "NetRepair", "CoreUpgrade"] {
            let outcome = failed(tool);
            assert!(outcome.display.facts.is_empty(), "{tool}");
            let serialized = serde_json::to_string(&outcome.display).unwrap();
            for needle in ["INTERNAL", "/Users", "config.json"] {
                assert!(
                    !serialized.contains(needle),
                    "{tool} 的展示数据泄露了 {needle}：{serialized}"
                );
            }
            assert!(outcome.error.is_some(), "错误对象本身不能丢");
        }
    }

    /// 工具没给 display 时只补 `changed`；完成/失败句子的兜底在前端映射表。
    #[test]
    fn missing_display_only_fills_the_change_flag() {
        let mut ok = ToolOutcome::ok("internal model text", json!({}));
        normalize_display("ConfigUpdate", &mut ok);
        assert!(ok.display.facts.is_empty());
        // 成功时 changed 固定 none；restored 只用于「改过又恢复」。
        assert_eq!(ok.display.changed, Changed::None);

        let failed = failed("VpnConnect");
        assert!(failed.display.facts.is_empty());
        assert_eq!(failed.display.changed, Changed::Unknown);
    }

    /// 只读工具即使调用点漏填，也不能报「有改动」。
    #[test]
    fn read_only_tools_are_forced_to_changed_none() {
        let mut outcome = ToolOutcome::ok("x", json!({})).with_display(vec![], Changed::Restored);
        normalize_display("RuntimeStatus", &mut outcome);
        assert_eq!(outcome.display.changed, Changed::None);
    }

    #[test]
    fn explicit_display_is_kept_and_facts_are_capped_at_four() {
        let mut outcome = ToolOutcome::ok("x", json!({}))
            .with_display((0..5).map(fact).collect(), Changed::Restored);
        normalize_display("VpnConnect", &mut outcome);
        assert_eq!(outcome.display.facts.len(), 4);
        assert_eq!(outcome.display.changed, Changed::None);
    }

    /// `display` 只进 `tool-call-end`，不能写进给模型的信封。
    #[test]
    fn envelope_does_not_carry_display() {
        let mut outcome =
            ToolOutcome::ok("x", json!({})).with_display(vec![fact(1)], Changed::None);
        normalize_display("VpnDisconnect", &mut outcome);
        let envelope = outcome.to_envelope();
        assert!(envelope.get("display").is_none(), "{envelope}");
        // 事件投影仍能从同一份 outcome 读到 display。
        assert_eq!(outcome.display.facts.len(), 1);
        assert_eq!(outcome.display.changed, Changed::None);
    }

    /// schema 的 `sensitive: true` 与键名黑名单都要生效，嵌套对象同样不能漏。
    #[test]
    fn redact_args_masks_schema_and_nested_blacklist_fields() {
        let schema = json!({
            "properties": {
                "password": { "type": "string", "sensitive": true },
                "target": {
                    "type": "object",
                    "properties": { "node_id": { "type": "string" } }
                }
            }
        });
        let redacted = redact_args(
            Some(&schema),
            &json!({
                "password": "pw",
                "target": { "node_id": "nd_1", "api_key": "sk-1" },
                "port": 8388,
            }),
        );

        assert_eq!(redacted["password"], "***");
        assert_eq!(redacted["target"]["node_id"], "nd_1");
        assert_eq!(redacted["target"]["api_key"], "***");
        assert_eq!(redacted["port"], 8388);
        assert!(!redacted.to_string().contains("pw\""));
        assert!(!redacted.to_string().contains("sk-1"));
    }

    /// 没有 schema 时黑名单仍然生效；普通字段保持原样。
    #[test]
    fn redact_args_without_schema_only_touches_known_keys() {
        let input = json!({ "server": "203.0.113.9", "token": "tkn" });
        let redacted = redact_args(None, &input);
        assert_eq!(redacted["server"], "203.0.113.9");
        assert_eq!(redacted["token"], "***");
    }
}
