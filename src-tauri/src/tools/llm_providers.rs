//! `LlmProviders`：只读地列出 AI 服务商与当前项，可选测一次连接。
//!
//! 密钥永远不出工具面（只有 `has_key`）；保存 / 删除 / 切换只能由用户在设置里做。

use std::sync::Arc;

use async_trait::async_trait;
use claurst_tools::{PermissionLevel, Tool, ToolContext, ToolResult};
use serde_json::{json, Value};

use super::display::Changed;
use super::envelope::{self, AivpnError, ToolOutcome};
use super::services::VpnToolServices;

/// 用名称当 id 时模型只能靠这句话自纠：让它不带参数再取一次真正的 id。
pub(crate) const PROVIDER_NOT_FOUND_MESSAGE: &str =
    "没有这个 id 的服务商；先不带参数调用，用 providers[].id 里的值";

/// 契约里服务商只露这些字段；`provider_id` 改名为 `id`，其余内部字段一律不出。
fn visible_provider(provider: &Value) -> Option<Value> {
    let id = provider
        .get("provider_id")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())?;
    let mut visible = serde_json::Map::new();
    visible.insert("id".into(), json!(id));
    for field in ["name", "protocol", "model"] {
        if let Some(value) = provider.get(field).and_then(Value::as_str) {
            visible.insert(field.into(), json!(value));
        }
    }
    visible.insert(
        "base_url".into(),
        json!(provider
            .get("base_url")
            .and_then(Value::as_str)
            .map(strip_userinfo)),
    );
    visible.insert(
        "has_key".into(),
        json!(provider
            .get("has_key")
            .and_then(Value::as_bool)
            .unwrap_or(false)),
    );
    Some(Value::Object(visible))
}

/// `https://user:pass@host` 这种地址 Host 本来就拒绝，投影时再剥一次，
/// 防止旧数据或服务层换实现后把凭据带进 AI 上下文。
fn strip_userinfo(url: &str) -> String {
    let Ok(mut parsed) = reqwest::Url::parse(url) else {
        return url.to_string();
    };
    if parsed.username().is_empty() && parsed.password().is_none() {
        return url.to_string();
    }
    let _ = parsed.set_username("");
    let _ = parsed.set_password(None);
    parsed.to_string()
}

/// 测试结果只留契约里的三项；响应文本已由 Host 侧脱敏。
fn visible_result(result: &Value) -> Value {
    json!({
        "ok": result.get("ok").and_then(Value::as_bool).unwrap_or(false),
        "latency_ms": result.get("latency_ms").and_then(Value::as_u64),
        "error": result
            .get("error")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|error| !error.is_empty()),
    })
}

fn summarise(data: &Value) -> String {
    let providers = data
        .get("providers")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if providers.is_empty() {
        return "还没有保存的 AI 服务商；要添加请到设置里操作。".to_string();
    }
    let mut lines = vec![format!("共 {} 个 AI 服务商：", providers.len())];
    let active = data.get("active_provider_id").and_then(Value::as_str);
    for provider in &providers {
        let name = provider
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or("(未命名)");
        let model = provider.get("model").and_then(Value::as_str).unwrap_or("-");
        let has_key = provider
            .get("has_key")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let key = if has_key { "已保存密钥" } else { "未保存密钥" };
        let id = provider.get("id").and_then(Value::as_str).unwrap_or("-");
        let mark = if active.is_some()
            && active == provider.get("id").and_then(Value::as_str)
        {
            "（当前）"
        } else {
            ""
        };
        // 模型只读得到 content：id 必须出现在这里，它才有办法去测连接。
        lines.push(format!("- {name}{mark} [id: {id}] | 模型 {model} | {key}"));
    }
    if let Some(result) = data.get("last_result") {
        let name = data
            .get("tested_provider_id")
            .and_then(Value::as_str)
            .and_then(|id| {
                providers
                    .iter()
                    .find(|provider| provider.get("id").and_then(Value::as_str) == Some(id))
            })
            .and_then(|provider| provider.get("name").and_then(Value::as_str))
            .unwrap_or("该服务商");
        let ok = result.get("ok").and_then(Value::as_bool).unwrap_or(false);
        let latency = result.get("latency_ms").and_then(Value::as_u64);
        if ok {
            match latency {
                Some(latency) => {
                    lines.push(format!("测试结果：{name} 连接正常，耗时 {latency} 毫秒。"))
                }
                None => lines.push(format!("测试结果：{name} 连接正常。")),
            }
        } else {
            let reason = result
                .get("error")
                .and_then(Value::as_str)
                .unwrap_or("没有说明原因");
            lines.push(format!("测试结果：{name} 连不上：{reason}。"));
        }
    }
    lines.join("\n")
}

pub struct LlmProvidersTool {
    services: Arc<dyn VpnToolServices>,
}

impl LlmProvidersTool {
    pub fn new(services: Arc<dyn VpnToolServices>) -> Self {
        Self { services }
    }
}

#[async_trait]
impl Tool for LlmProvidersTool {
    fn name(&self) -> &str {
        "LlmProviders"
    }

    fn description(&self) -> &str {
        "列出已保存的 AI 服务商与当前项，可选测一次连接。只读，不改任何配置。\
         传 test_provider_id 会对该服务商发一次真实请求，结果放进它的 last_result；\
         id 不存在回 NOT_FOUND。要测某一项时，先不带参数调用拿到 providers 里的 id，\
         再用这个 id 去测；不要凭名字猜 id。id 形如 deepseek 或 p_xxx，是调用用的，\
         不要念给用户。永远不返回 API Key，只有 has_key。\
         保存、删除、切换服务商只能由用户在设置里操作，不要替用户改；\
         DeepseekSaveKey 只覆盖 DeepSeek。\n\
         说服务商名称与模型；不出现 base_url 或任何密钥。"
    }

    fn permission_level(&self) -> PermissionLevel {
        PermissionLevel::ReadOnly
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "test_provider_id": { "type": "string", "minLength": 1 }
            },
            "additionalProperties": false
        })
    }

    async fn execute(&self, input: Value, ctx: &ToolContext) -> ToolResult {
        let outcome = match parse_input(&input) {
            Ok(test_provider_id) => match self.services.llm_providers(test_provider_id).await {
                Ok(data) => success_outcome(&data),
                Err(error) => ToolOutcome::fail(failure(error)).with_changed(Changed::None),
            },
            Err(error) => ToolOutcome::fail(error).with_changed(Changed::None),
        };
        envelope::finish(ctx, "LlmProviders", outcome)
    }
}

fn parse_input(input: &Value) -> Result<Option<String>, AivpnError> {
    let Some(object) = input.as_object() else {
        return Err(AivpnError::new("INVALID_ARGUMENT", "参数必须是一个对象")
            .with_details(json!({ "reason": "invalid_payload" })));
    };
    for key in object.keys() {
        if key != "test_provider_id" {
            return Err(
                AivpnError::new("INVALID_ARGUMENT", format!("不支持的参数 {key}"))
                    .with_details(json!({ "reason": "unknown_argument" })),
            );
        }
    }
    Ok(super::optional_string(input, "test_provider_id")?
        .map(|id| id.trim().to_string())
        .filter(|id| !id.is_empty()))
}

/// 数据里只留契约字段：`providers[]` 投影 + 只给被测项的 `last_result`。
fn success_outcome(data: &Value) -> ToolOutcome {
    let active = data.get("active_provider_id").and_then(Value::as_str);
    let tested = data.get("tested_provider_id").and_then(Value::as_str);
    let tested_result = data
        .get("last_result")
        .filter(|result| result.is_object());
    let providers: Vec<Value> = data
        .get("providers")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|provider| {
                    let mut visible = visible_provider(provider)?;
                    if tested.is_some()
                        && visible.get("id").and_then(Value::as_str) == tested
                    {
                        if let Some(result) = tested_result {
                            visible["last_result"] = visible_result(result);
                        }
                    }
                    Some(visible)
                })
                .collect()
        })
        .unwrap_or_default();
    let visible = json!({
        "active_provider_id": active,
        "providers": providers,
    });
    let mut summary_data = visible.clone();
    if let Some(id) = tested {
        summary_data["tested_provider_id"] = json!(id);
    }
    if let Some(result) = tested_result {
        summary_data["last_result"] = result.clone();
    }
    ToolOutcome::ok(summarise(&summary_data), visible).with_changed(Changed::None)
}

fn failure(error: anyhow::Error) -> AivpnError {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base_url_loses_userinfo() {
        assert_eq!(
            strip_userinfo("https://api.example.com/v1"),
            "https://api.example.com/v1"
        );
        let stripped = strip_userinfo("https://user:pw@api.example.com/v1");
        assert!(!stripped.contains("user"), "{stripped}");
        assert!(!stripped.contains("pw"), "{stripped}");
        assert!(stripped.contains("api.example.com"), "{stripped}");
    }

    #[test]
    fn projection_drops_ids_keys_and_internal_flags() {
        let data = json!({
            "active_provider_id": "p1",
            "providers": [{
                "provider_id": "p1",
                "name": "DeepSeek",
                "protocol": "openai",
                "model": "deepseek-flash",
                "base_url": "https://api.deepseek.com",
                "has_key": true,
                "is_active": true,
                "is_builtin": true,
                "api_key": "sk-secret",
                "masked": "sk-***",
            }],
        });
        let outcome = success_outcome(&data);
        let provider = &outcome.data.as_ref().unwrap()["providers"][0];
        assert_eq!(provider["id"], "p1");
        assert!(provider.get("active").is_none(), "{provider}");
        assert!(provider.get("provider_id").is_none(), "{provider}");
        assert!(provider.get("is_builtin").is_none(), "{provider}");
        assert!(provider.get("api_key").is_none(), "{provider}");
        assert!(provider.get("masked").is_none(), "{provider}");
    }

    #[test]
    fn the_summary_lists_each_id_for_calling() {
        let data = json!({
            "active_provider_id": "deepseek",
            "providers": [
                {
                    "provider_id": "deepseek", "name": "DeepSeek",
                    "model": "deepseek-flash", "has_key": true,
                },
                {
                    "provider_id": "p_1a2b", "name": "Ollama", "model": "qwen", "has_key": false,
                },
            ],
        });
        let summary = success_outcome(&data).summary;
        assert!(
            summary.contains("- DeepSeek（当前） [id: deepseek]"),
            "{summary}"
        );
        assert!(summary.contains("- Ollama [id: p_1a2b]"), "{summary}");
    }

    #[test]
    fn last_result_only_lands_on_the_tested_provider() {
        let data = json!({
            "active_provider_id": "p1",
            "tested_provider_id": "p2",
            "last_result": { "ok": false, "latency_ms": 12, "error": "鉴权失败" },
            "providers": [
                { "provider_id": "p1", "name": "A", "model": "m", "has_key": true },
                { "provider_id": "p2", "name": "B", "model": "m", "has_key": true },
            ],
        });
        let outcome = success_outcome(&data);
        let providers = outcome.data.as_ref().unwrap()["providers"].as_array().unwrap();
        assert!(providers[0].get("last_result").is_none(), "{providers:?}");
        assert_eq!(providers[1]["last_result"]["ok"], false);
        assert!(outcome.summary.contains("B"), "{}", outcome.summary);
    }
}
