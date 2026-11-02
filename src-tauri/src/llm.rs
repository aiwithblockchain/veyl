//! 多 provider 的模型 API 配置：非敏感字段进 settings，Key 进 secrets.enc。
//!
//! 密钥前缀固定 `provider:<provider_id>`；内置 DeepSeek 复用已有的 `provider:deepseek`，
//! 迁移只补元数据，不搬移、不重写已有 Key。

use std::time::Instant;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::claurst_session::provider::LlmCredentials;
use crate::store::{self, Store};

pub const PROVIDER_DEEPSEEK: &str = "deepseek";
pub const DEEPSEEK_BASE_URL: &str = "https://api.deepseek.com";
pub const DEEPSEEK_MODEL: &str = "deepseek-chat";
pub const OPENAI_DEFAULT_BASE: &str = "https://api.openai.com";
pub const ANTHROPIC_DEFAULT_BASE: &str = "https://api.anthropic.com";

const SETTING_PROVIDERS: &str = "llm_providers";
const SETTING_ACTIVE: &str = "llm_active_provider";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ProviderRecord {
    pub provider_id: String,
    pub name: String,
    /// "openai" | "anthropic"
    pub protocol: String,
    #[serde(default)]
    pub base_url: Option<String>,
    pub model: String,
    #[serde(default)]
    pub is_builtin: bool,
}

pub fn secret_key(provider_id: &str) -> String {
    format!("provider:{provider_id}")
}

pub fn has_key(provider_id: &str) -> bool {
    crate::secrets::get_secret(&secret_key(provider_id))
        .ok()
        .flatten()
        .map(|value| !value.trim().is_empty())
        .unwrap_or(false)
}

/// 本机端点允许免 Key（Ollama 等）。
pub fn is_local_endpoint(url: &str) -> bool {
    let Ok(parsed) = reqwest::Url::parse(url.trim()) else {
        return false;
    };
    matches!(
        parsed.host_str(),
        Some("localhost") | Some("127.0.0.1") | Some("::1") | Some("[::1]")
    ) || parsed
        .host_str()
        .map(|host| host.ends_with(".localhost"))
        .unwrap_or(false)
}

/// 身份迁移：只在 `llm_providers` 还没写过时补内置 DeepSeek。
/// 重复启动不会建出第二条；用户删空列表后也不会被复活。
pub fn ensure_migrated(store: &Store) {
    let already = {
        let conn = store.conn();
        store::settings::get(&conn, SETTING_PROVIDERS)
            .ok()
            .flatten()
            .is_some()
    };
    if already {
        return;
    }

    let builtin = ProviderRecord {
        provider_id: PROVIDER_DEEPSEEK.to_string(),
        name: "DeepSeek".to_string(),
        protocol: "openai".to_string(),
        base_url: Some(DEEPSEEK_BASE_URL.to_string()),
        model: DEEPSEEK_MODEL.to_string(),
        is_builtin: true,
    };
    let _ = save_records(store, &[builtin]);
    let has_active = {
        let conn = store.conn();
        store::settings::get(&conn, SETTING_ACTIVE)
            .ok()
            .flatten()
            .is_some()
    };
    if !has_active {
        let _ = set_active_id(store, Some(PROVIDER_DEEPSEEK));
    }
}

pub fn records(store: &Store) -> Vec<ProviderRecord> {
    let conn = store.conn();
    store::settings::get(&conn, SETTING_PROVIDERS)
        .ok()
        .flatten()
        .and_then(|value| serde_json::from_str::<Vec<ProviderRecord>>(&value).ok())
        .unwrap_or_default()
}

pub fn active_id(store: &Store) -> Option<String> {
    let id = {
        let conn = store.conn();
        store::settings::get(&conn, SETTING_ACTIVE).ok().flatten()?
    };
    records(store)
        .iter()
        .any(|record| record.provider_id == id)
        .then_some(id)
}

pub fn set_active_id(store: &Store, provider_id: Option<&str>) -> Result<(), String> {
    let conn = store.conn();
    match provider_id {
        Some(id) => store::settings::set(&conn, SETTING_ACTIVE, id),
        None => store::settings::delete(&conn, SETTING_ACTIVE),
    }
    .map_err(|error| error.to_string())
}

fn save_records(store: &Store, records: &[ProviderRecord]) -> Result<(), String> {
    let payload = serde_json::to_string(records).map_err(|error| error.to_string())?;
    let conn = store.conn();
    store::settings::set(&conn, SETTING_PROVIDERS, &payload).map_err(|error| error.to_string())
}

fn usable(record: &ProviderRecord) -> bool {
    has_key(&record.provider_id)
        || record
            .base_url
            .as_deref()
            .map(is_local_endpoint)
            .unwrap_or(false)
}

/// 是否至少有一个可用 provider（用于引导判断，不要求它是 active）。
pub fn has_any_usable(store: &Store) -> bool {
    records(store).iter().any(usable)
}

pub fn public_json(store: &Store, record: &ProviderRecord) -> Value {
    let active = active_id(store).as_deref() == Some(record.provider_id.as_str());
    json!({
        "provider_id": record.provider_id,
        "name": record.name,
        "protocol": record.protocol,
        "base_url": effective_base(record),
        "model": record.model,
        "has_key": has_key(&record.provider_id),
        "is_active": active,
        "is_builtin": record.is_builtin,
    })
}

pub fn effective_base(record: &ProviderRecord) -> String {
    record
        .base_url
        .clone()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| {
            if record.protocol == "anthropic" {
                ANTHROPIC_DEFAULT_BASE.to_string()
            } else {
                OPENAI_DEFAULT_BASE.to_string()
            }
        })
}

pub fn list_json(store: &Store) -> Value {
    let list = records(store);
    json!({
        "providers": list.iter().map(|record| public_json(store, record)).collect::<Vec<_>>(),
        "active_provider_id": active_id(store),
    })
}

pub struct ProviderInput {
    pub provider_id: Option<String>,
    pub name: String,
    pub protocol: String,
    pub base_url: Option<String>,
    pub model: String,
    pub api_key: Option<String>,
}

pub fn validate(input: &ProviderInput, has_existing_key: bool) -> Result<(), (String, String)> {
    let invalid = |reason: &str, message: &str| (reason.to_string(), message.to_string());

    if input.name.trim().is_empty() {
        return Err(invalid("name_required", "名称不能为空"));
    }
    if input.model.trim().is_empty() {
        return Err(invalid("model_required", "模型不能为空"));
    }
    if !matches!(input.protocol.as_str(), "openai" | "anthropic") {
        return Err(invalid("protocol_unsupported", "只支持 openai / anthropic 兼容"));
    }

    let base = input.base_url.as_deref().unwrap_or("").trim();
    let effective = if base.is_empty() {
        if input.protocol == "anthropic" {
            ANTHROPIC_DEFAULT_BASE
        } else {
            OPENAI_DEFAULT_BASE
        }
    } else {
        base
    };
    let parsed = reqwest::Url::parse(effective)
        .map_err(|_| invalid("base_url_invalid", "Base URL 不是合法地址"))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err(invalid("base_url_invalid", "Base URL 只允许 http / https"));
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err(invalid(
            "base_url_credentials",
            "不要把 Key 拼进 URL，请填在 API Key 字段",
        ));
    }
    if parsed.scheme() == "http" && !is_local_endpoint(effective) {
        return Err(invalid(
            "base_url_http_local_only",
            "http 只允许 localhost / 127.0.0.1；其它端点请用 https",
        ));
    }

    let key_provided = input
        .api_key
        .as_deref()
        .map(|key| !key.trim().is_empty())
        .unwrap_or(false);
    if !key_provided && !has_existing_key && !is_local_endpoint(effective) {
        return Err(invalid(
            "key_required",
            "请填写 API Key；只有本机端点可以免 Key",
        ));
    }
    Ok(())
}

pub fn save(store: &Store, input: ProviderInput) -> Result<Value, (String, String)> {
    // 保存不改变当前：只有此前完全没有 active 时，第一个保存的才成为 active。
    let had_active = active_id(store).is_some();
    let mut list = records(store);
    let existing_index = input
        .provider_id
        .as_ref()
        .and_then(|id| list.iter().position(|record| &record.provider_id == id));

    if input.provider_id.is_some() && existing_index.is_none() {
        return Err(("not_found".into(), "provider 不存在".into()));
    }

    let provider_id = input
        .provider_id
        .clone()
        .unwrap_or_else(|| format!("provider-{:08x}", rand::random::<u32>()));
    let has_existing_key = has_key(&provider_id);
    validate(&input, has_existing_key)?;

    if let Some(api_key) = input.api_key.as_deref().map(str::trim) {
        if !api_key.is_empty() {
            crate::secrets::set_secret(&secret_key(&provider_id), api_key)
                .map_err(|error| ("SECRET_STORE".to_string(), error.to_string()))?;
        }
    }

    let is_builtin = existing_index
        .map(|index| list[index].is_builtin)
        .unwrap_or(provider_id == PROVIDER_DEEPSEEK);
    let record = ProviderRecord {
        provider_id: provider_id.clone(),
        name: input.name.trim().to_string(),
        protocol: input.protocol,
        base_url: input
            .base_url
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty()),
        model: input.model.trim().to_string(),
        is_builtin,
    };

    match existing_index {
        Some(index) => list[index] = record.clone(),
        None => list.push(record.clone()),
    }
    save_records(store, &list).map_err(|error| ("INTERNAL".to_string(), error))?;
    if !had_active {
        // 否则用户配完了还发不出消息。
        set_active_id(store, Some(&provider_id)).map_err(|error| ("INTERNAL".to_string(), error))?;
    }

    Ok(public_json(store, &record))
}

pub fn delete(store: &Store, provider_id: &str) -> Result<(), (String, String)> {
    let mut list = records(store);
    let Some(index) = list
        .iter()
        .position(|record| record.provider_id == provider_id)
    else {
        return Err(("not_found".into(), "provider 不存在".into()));
    };
    if list[index].is_builtin {
        return Err(("builtin_provider".into(), "内置 provider 不能删除".into()));
    }

    // 先删 Key：失败就中止，记录保持不动，避免留下孤儿密钥。
    crate::secrets::delete_secret(&secret_key(provider_id))
        .map_err(|error| ("SECRET_STORE".to_string(), error.to_string()))?;

    list.remove(index);
    save_records(store, &list).map_err(|error| ("INTERNAL".to_string(), error))?;

    if active_id(store).as_deref() == Some(provider_id) {
        // 切换只能显式发生：删掉当前 provider 后留空，不自动挑下一个。
        set_active_id(store, None).map_err(|error| ("INTERNAL".to_string(), error))?;
    }
    Ok(())
}

pub fn activate(store: &Store, provider_id: &str) -> Result<(), (String, String)> {
    let list = records(store);
    let Some(record) = list
        .iter()
        .find(|record| record.provider_id == provider_id)
    else {
        return Err(("not_found".into(), "provider 不存在".into()));
    };
    if !usable(record) {
        return Err((
            "no_key".into(),
            "这个 provider 还没有 Key；只有本机端点可以免 Key".into(),
        ));
    }
    set_active_id(store, Some(provider_id)).map_err(|error| ("INTERNAL".to_string(), error))
}

/// 当前 active provider 的运行时凭据；没有可用的 active provider 时为 None。
pub fn credentials(store: &Store) -> Option<LlmCredentials> {
    let id = active_id(store)?;
    let record = records(store)
        .into_iter()
        .find(|record| record.provider_id == id)?;
    if !usable(&record) {
        return None;
    }
    let api_key = crate::secrets::get_secret(&secret_key(&record.provider_id))
        .ok()
        .flatten()
        .unwrap_or_default();
    let base_url = effective_base(&record);
    Some(LlmCredentials {
        provider_id: record.provider_id,
        protocol: record.protocol,
        api_key,
        base_url,
        model: record.model,
    })
}

/// 某个 provider 的凭据（不要求它是 active）；旧 DeepSeek 命令用。
pub fn credentials_for(store: &Store, provider_id: &str) -> Option<LlmCredentials> {
    let record = records(store)
        .into_iter()
        .find(|record| record.provider_id == provider_id)?;
    let api_key = crate::secrets::get_secret(&secret_key(provider_id))
        .ok()
        .flatten()
        .unwrap_or_default();
    let base_url = effective_base(&record);
    Some(LlmCredentials {
        provider_id: record.provider_id,
        protocol: record.protocol,
        api_key,
        base_url,
        model: record.model,
    })
}

/// 测试连接：草稿优先，缺省字段回落到已存 provider。
pub async fn test(store: &Store, input: ProviderInput) -> Result<Value, (String, String)> {
    let stored = input
        .provider_id
        .as_ref()
        .and_then(|id| records(store).into_iter().find(|record| &record.provider_id == id));

    let protocol = if input.protocol.trim().is_empty() {
        stored
            .as_ref()
            .map(|record| record.protocol.clone())
            .unwrap_or_else(|| "openai".to_string())
    } else {
        input.protocol.clone()
    };
    let base_url = input
        .base_url
        .clone()
        .filter(|value| !value.trim().is_empty())
        .or_else(|| stored.as_ref().and_then(|record| record.base_url.clone()));
    let model = if input.model.trim().is_empty() {
        stored
            .as_ref()
            .map(|record| record.model.clone())
            .unwrap_or_default()
    } else {
        input.model.clone()
    };
    let api_key = input
        .api_key
        .clone()
        .filter(|value| !value.trim().is_empty())
        .or_else(|| {
            input
                .provider_id
                .as_ref()
                .and_then(|id| crate::secrets::get_secret(&secret_key(id)).ok().flatten())
        })
        .unwrap_or_default();

    let draft = ProviderInput {
        provider_id: input.provider_id.clone(),
        name: if input.name.trim().is_empty() {
            model.clone()
        } else {
            input.name.clone()
        },
        protocol: protocol.clone(),
        base_url: base_url.clone(),
        model: model.clone(),
        api_key: Some(api_key.clone()),
    };
    let has_existing_key = input
        .provider_id
        .as_ref()
        .map(|id| has_key(id))
        .unwrap_or(false);
    validate(&draft, has_existing_key)?;

    let effective = if let Some(base) = base_url.filter(|value| !value.trim().is_empty()) {
        base.trim().trim_end_matches('/').to_string()
    } else if protocol == "anthropic" {
        ANTHROPIC_DEFAULT_BASE.to_string()
    } else {
        OPENAI_DEFAULT_BASE.to_string()
    };
    let local = is_local_endpoint(&effective);

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|error| ("INTERNAL".to_string(), format!("创建测试客户端失败：{error}")))?;

    let started = Instant::now();
    let response = if protocol == "anthropic" {
        let url = if effective.ends_with("/v1") {
            format!("{effective}/messages")
        } else {
            format!("{effective}/v1/messages")
        };
        let mut request = client.post(url).header("anthropic-version", "2023-06-01").json(&json!({
            "model": model,
            "max_tokens": 1,
            "messages": [{ "role": "user", "content": "ping" }],
        }));
        if !api_key.is_empty() {
            request = request.header("x-api-key", api_key.clone());
        }
        request.send().await
    } else {
        let url = if effective.ends_with("/v1") {
            format!("{effective}/chat/completions")
        } else {
            format!("{effective}/v1/chat/completions")
        };
        let mut request = client.post(url).json(&json!({
            "model": model,
            "max_tokens": 1,
            "messages": [{ "role": "user", "content": "ping" }],
        }));
        if !api_key.is_empty() {
            request = request.bearer_auth(api_key.clone());
        }
        request.send().await
    };

    let latency = started.elapsed().as_millis() as u64;
    match response {
        Ok(response) => {
            let status = response.status();
            let body: Value = response.json().await.unwrap_or(Value::Null);
            if !status.is_success() {
                let detail = body
                    .get("error")
                    .and_then(|error| error.get("message"))
                    .and_then(Value::as_str)
                    .unwrap_or("");
                return Ok(json!({
                    "ok": false,
                    "latency_ms": latency,
                    "error": describe_http_error(status.as_u16(), detail),
                }));
            }
            let shaped = if protocol == "anthropic" {
                body.get("content").and_then(Value::as_array).is_some()
                    || body.get("type").and_then(Value::as_str) == Some("message")
            } else {
                body.get("choices").and_then(Value::as_array).is_some()
            };
            Ok(json!({
                "ok": shaped,
                "latency_ms": latency,
                "error": if shaped {
                    Value::Null
                } else {
                    Value::String("响应不是预期的协议格式，检查 API 类型与 Base URL".into())
                },
            }))
        }
        Err(error) if error.is_timeout() => Ok(json!({
            "ok": false,
            "latency_ms": latency,
            "error": "请求超时（10 秒）",
        })),
        Err(error) => Ok(json!({
            "ok": false,
            "latency_ms": latency,
            "error": if local {
                format!("无法连接本机端点：{error}")
            } else {
                format!("无法连接端点：{error}")
            },
        })),
    }
}

fn describe_http_error(status: u16, detail: &str) -> String {
    let base = match status {
        401 | 403 => "鉴权失败，检查 API Key",
        404 => "端点不存在（404），检查 Base URL 是否包含正确的路径",
        429 => "请求被限流（429）",
        _ => "请求失败",
    };
    let detail = redact_secrets(detail.trim());
    if detail.is_empty() {
        format!("{base}（HTTP {status}）")
    } else {
        format!("{base}（HTTP {status}）：{detail}")
    }
}

/// 响应体可能回显请求里的 Key（OpenAI 风格 401 常见），返回给 UI 前统一脱敏。
fn redact_secrets(text: &str) -> String {
    let mut out = String::new();
    let mut rest = text;
    while let Some(index) = rest.find("sk-") {
        out.push_str(&rest[..index]);
        let tail = &rest[index + 3..];
        let token: String = tail
            .chars()
            .take_while(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '-')
            .collect();
        if token.chars().count() >= 8 {
            out.push_str("sk-***");
        } else {
            out.push_str("sk-");
            out.push_str(&token);
        }
        rest = &tail[token.len()..];
    }
    out.push_str(rest);
    // 只给用户一句可读说明，不把整段响应体带出去。
    out.chars().take(200).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> Store {
        Store::open_in_memory().unwrap()
    }

    /// Key 相关用例需要全局 secrets 存储；同一进程只初始化一次。
    fn ensure_secrets() {
        use std::sync::OnceLock;
        static ONCE: OnceLock<()> = OnceLock::new();
        ONCE.get_or_init(|| {
            let dir = std::env::temp_dir().join("veyl-llm-secrets");
            let _ = std::fs::create_dir_all(&dir);
            crate::secrets::install(&dir);
        });
    }

    fn input(protocol: &str, base: Option<&str>, key: Option<&str>) -> ProviderInput {
        ProviderInput {
            provider_id: None,
            name: "测试".into(),
            protocol: protocol.into(),
            base_url: base.map(str::to_string),
            model: "test-model".into(),
            api_key: key.map(str::to_string),
        }
    }

    #[test]
    fn migration_is_idempotent_and_never_duplicates() {
        let store = store();
        ensure_migrated(&store);
        ensure_migrated(&store);
        let list = records(&store);
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].provider_id, PROVIDER_DEEPSEEK);
        assert!(list[0].is_builtin);
        assert_eq!(active_id(&store).as_deref(), Some(PROVIDER_DEEPSEEK));
    }

    #[test]
    fn deleting_the_builtin_does_not_resurrect_it() {
        ensure_secrets();
        let store = store();
        ensure_migrated(&store);
        let error = delete(&store, PROVIDER_DEEPSEEK).unwrap_err();
        assert_eq!(error.0, "builtin_provider");
        ensure_migrated(&store);
        assert_eq!(records(&store).len(), 1, "内置 provider 不能被删，也不会重复");
    }

    #[test]
    fn validation_rejects_remote_http_and_missing_key() {
        let error = validate(&input("openai", Some("http://example.com"), Some("k")), false)
            .unwrap_err();
        assert_eq!(error.0, "base_url_http_local_only");

        let error = validate(&input("openai", None, None), false).unwrap_err();
        assert_eq!(error.0, "key_required");

        // 本机端点免 Key。
        assert!(validate(&input("openai", Some("http://127.0.0.1:11434"), None), false).is_ok());
    }

    #[test]
    fn saving_never_switches_the_active_provider() {
        ensure_secrets();
        let store = store();
        ensure_migrated(&store); // active = deepseek

        let saved = save(
            &store,
            input("anthropic", Some("https://api.anthropic.com"), Some("sk-a")),
        )
        .unwrap();
        let id = saved["provider_id"].as_str().unwrap().to_string();
        assert_eq!(
            active_id(&store).as_deref(),
            Some(PROVIDER_DEEPSEEK),
            "保存第二个 provider 不能改变 active"
        );

        // 编辑非当前 provider：active 仍不变。
        let edit_other = ProviderInput {
            provider_id: Some(id),
            ..input("anthropic", Some("https://api.anthropic.com"), None)
        };
        save(&store, edit_other).unwrap();
        assert_eq!(active_id(&store).as_deref(), Some(PROVIDER_DEEPSEEK));

        // 编辑当前 provider：仍是当前。
        let edit_active = ProviderInput {
            provider_id: Some(PROVIDER_DEEPSEEK.to_string()),
            ..input("openai", Some(DEEPSEEK_BASE_URL), Some("sk-edit"))
        };
        save(&store, edit_active).unwrap();
        assert_eq!(active_id(&store).as_deref(), Some(PROVIDER_DEEPSEEK));
    }

    #[test]
    fn the_first_saved_provider_becomes_active_when_none_exists() {
        ensure_secrets();
        let store = store();
        ensure_migrated(&store);
        set_active_id(&store, None).unwrap();

        let saved = save(
            &store,
            input("openai", Some("https://api.openai.com"), Some("sk-first")),
        )
        .unwrap();
        let id = saved["provider_id"].as_str().unwrap().to_string();
        assert_eq!(active_id(&store).as_deref(), Some(id.as_str()));
    }

    #[test]
    fn deleting_the_active_provider_leaves_no_active() {
        ensure_secrets();
        let store = store();
        ensure_migrated(&store); // active = deepseek
        let saved = save(
            &store,
            input("openai", Some("https://api.openai.com"), Some("sk-custom")),
        )
        .unwrap();
        let id = saved["provider_id"].as_str().unwrap().to_string();
        activate(&store, &id).unwrap();
        assert_eq!(active_id(&store).as_deref(), Some(id.as_str()));

        delete(&store, &id).unwrap();
        assert!(
            active_id(&store).is_none(),
            "删除当前 provider 后必须留空，不能自动挑下一个"
        );
    }

    #[test]
    fn http_error_details_are_redacted() {
        let text = describe_http_error(401, "Incorrect API key provided: sk-abcdefgh12345678");
        assert!(!text.contains("abcdefgh12345678"), "{text}");
        assert!(text.contains("sk-***"), "{text}");
    }

    #[test]
    fn deleting_a_provider_removes_its_key() {
        ensure_secrets();
        let store = store();
        ensure_migrated(&store);
        let saved = save(&store, input("openai", Some("https://api.openai.com"), Some("sk-x"))).unwrap();
        let id = saved["provider_id"].as_str().unwrap().to_string();
        assert!(has_key(&id));
        delete(&store, &id).unwrap();
        assert!(!has_key(&id));
    }
}
