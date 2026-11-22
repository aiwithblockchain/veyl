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
pub const DEEPSEEK_MODEL: &str = "deepseek-flash";
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
    let mut list = store::settings::get(&conn, SETTING_PROVIDERS)
        .ok()
        .flatten()
        .and_then(|value| serde_json::from_str::<Vec<ProviderRecord>>(&value).ok())
        .unwrap_or_default();
    for record in &mut list {
        normalize_builtin(record);
    }
    list
}

/// 已下线的内置 DeepSeek 模型；读取时替换成当前默认。
const RETIRED_DEEPSEEK_MODEL: &str = "deepseek-chat";

/// 官方 DeepSeek 端点；只有指向它的内置记录才替换已下线模型。
const DEEPSEEK_API_HOST: &str = "api.deepseek.com";

/// 发布前不做数据迁移：老安装里的内置 DeepSeek 记录可能还留着已下线的模型。
/// 读取时只补正真正过期的字段，其它值（用户自己改过的模型/base/协议）保持不动。
/// 归一只发生在读取时；任何一次保存/删除都会把归一后的整表写回
/// （那是用户动作，不是迁移）。
fn normalize_builtin(record: &mut ProviderRecord) {
    if !record.is_builtin || record.provider_id != PROVIDER_DEEPSEEK {
        return;
    }
    let base = record.base_url.as_deref().map(str::trim).unwrap_or("");
    // 空 base 会被补成官方默认；指向自建/代理的记录可能仍提供旧模型，不改。
    let official_base = base.is_empty() || is_official_deepseek_base(base);
    let retired_model = record
        .model
        .trim()
        .eq_ignore_ascii_case(RETIRED_DEEPSEEK_MODEL);
    if official_base && retired_model {
        record.model = DEEPSEEK_MODEL.to_string();
    }
    if base.is_empty() {
        record.base_url = Some(DEEPSEEK_BASE_URL.to_string());
    }
    if record.protocol.trim().is_empty() {
        record.protocol = "openai".to_string();
    }
}

fn is_official_deepseek_base(base: &str) -> bool {
    reqwest::Url::parse(base)
        .ok()
        .and_then(|url| url.host_str().map(str::to_string))
        .is_some_and(|host| host.eq_ignore_ascii_case(DEEPSEEK_API_HOST))
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
        return Err(invalid("base_url_scheme", "Base URL 只允许 http / https"));
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

/// 保存 DeepSeek Key 后：当前没有可用凭据时激活内置 DeepSeek，保证保存即已配置。
pub fn activate_builtin_if_unconfigured(store: &Store) {
    if credentials(store).is_none() {
        let _ = set_active_id(store, Some(PROVIDER_DEEPSEEK));
    }
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
    /// 走共享安装（每个测试进程一个目录，永不删除），避免与其它用例抢进程级根。
    fn ensure_secrets() {
        crate::test_support::install_test_secrets();
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

    fn builtin_record(model: &str, base: Option<&str>) -> ProviderRecord {
        ProviderRecord {
            provider_id: PROVIDER_DEEPSEEK.to_string(),
            name: "DeepSeek".to_string(),
            protocol: "openai".to_string(),
            base_url: base.map(str::to_string),
            model: model.to_string(),
            is_builtin: true,
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
    fn an_old_builtin_deepseek_record_reads_as_the_current_model() {
        let store = store();
        save_records(
            &store,
            &[builtin_record("deepseek-chat", Some(DEEPSEEK_BASE_URL))],
        )
        .unwrap();

        let list = records(&store);
        assert_eq!(list[0].model, DEEPSEEK_MODEL);
        assert_eq!(list[0].base_url.as_deref(), Some(DEEPSEEK_BASE_URL));
        assert_eq!(list[0].protocol, "openai");

        // 归一只发生在读取时：库里的旧值保持不动，不是数据迁移。
        let raw = {
            let conn = store.conn();
            store::settings::get(&conn, SETTING_PROVIDERS)
                .unwrap()
                .unwrap()
        };
        assert!(raw.contains("deepseek-chat"), "读取归一刻意不写库：{raw}");
    }

    #[test]
    fn the_retired_model_match_ignores_ascii_case() {
        for model in ["DeepSeek-Chat", "DEEPSEEK-CHAT", " deepseek-chat "] {
            let store = store();
            save_records(&store, &[builtin_record(model, Some(DEEPSEEK_BASE_URL))]).unwrap();
            assert_eq!(records(&store)[0].model, DEEPSEEK_MODEL, "{model}");
        }

        // 非内置记录不受影响。
        let store = store();
        save_records(
            &store,
            &[ProviderRecord {
                provider_id: "provider-0000beef".to_string(),
                name: "自建 DeepSeek".to_string(),
                protocol: "openai".to_string(),
                base_url: Some("https://proxy.example.com".to_string()),
                model: "DeepSeek-Chat".to_string(),
                is_builtin: false,
            }],
        )
        .unwrap();
        assert_eq!(records(&store)[0].model, "DeepSeek-Chat");
    }

    #[test]
    fn a_builtin_record_on_a_custom_base_keeps_the_retired_model() {
        // 自建/代理仍可能提供 deepseek-chat，不能替用户改模型。
        let store = store();
        save_records(
            &store,
            &[builtin_record(
                "deepseek-chat",
                Some("https://llm-proxy.example.com/v1"),
            )],
        )
        .unwrap();

        let list = records(&store);
        assert_eq!(list[0].model, "deepseek-chat");
        assert_eq!(
            list[0].base_url.as_deref(),
            Some("https://llm-proxy.example.com/v1")
        );
    }

    #[test]
    fn an_empty_base_counts_as_the_official_endpoint() {
        let store = store();
        save_records(&store, &[builtin_record("deepseek-chat", None)]).unwrap();

        let list = records(&store);
        assert_eq!(list[0].model, DEEPSEEK_MODEL);
        assert_eq!(list[0].base_url.as_deref(), Some(DEEPSEEK_BASE_URL));
    }

    #[test]
    fn a_builtin_record_keeps_a_deliberately_chosen_model() {
        // 设置页允许编辑内置项；用户主动选的模型不能被读回旧值。
        let store = store();
        save_records(
            &store,
            &[builtin_record("deepseek-v4-pro", Some(DEEPSEEK_BASE_URL))],
        )
        .unwrap();

        let list = records(&store);
        assert_eq!(list[0].model, "deepseek-v4-pro");
        assert_eq!(list[0].base_url.as_deref(), Some(DEEPSEEK_BASE_URL));
        assert_eq!(list[0].protocol, "openai");
    }

    #[test]
    fn a_builtin_record_fills_only_missing_base_and_protocol() {
        for base in [None, Some(""), Some("   ")] {
            let store = store();
            save_records(
                &store,
                &[ProviderRecord {
                    provider_id: PROVIDER_DEEPSEEK.to_string(),
                    name: "DeepSeek".to_string(),
                    protocol: String::new(),
                    base_url: base.map(str::to_string),
                    model: "deepseek-v4-pro".to_string(),
                    is_builtin: true,
                }],
            )
            .unwrap();

            let list = records(&store);
            assert_eq!(
                list[0].base_url.as_deref(),
                Some(DEEPSEEK_BASE_URL),
                "base 为 {base:?} 时要补默认值"
            );
            assert_eq!(list[0].protocol, "openai", "空协议要补 openai");
            assert_eq!(list[0].model, "deepseek-v4-pro", "补默认值不能动模型");
        }
    }

    #[test]
    fn credentials_see_the_normalized_builtin_model() {
        ensure_secrets();
        let store = store();
        save_records(
            &store,
            &[builtin_record("deepseek-chat", Some(DEEPSEEK_BASE_URL))],
        )
        .unwrap();
        crate::secrets::set_secret(&secret_key(PROVIDER_DEEPSEEK), "sk-test").unwrap();
        set_active_id(&store, Some(PROVIDER_DEEPSEEK)).unwrap();

        let credentials = credentials(&store).expect("内置 DeepSeek 有 Key 就必须可用");
        assert_eq!(credentials.model, DEEPSEEK_MODEL);
        assert_eq!(credentials.base_url, DEEPSEEK_BASE_URL);
        assert_eq!(credentials.provider_id, PROVIDER_DEEPSEEK);
    }

    #[test]
    fn a_user_owned_deepseek_record_is_left_alone() {
        let store = store();
        save_records(
            &store,
            &[ProviderRecord {
                provider_id: "provider-0000dead".to_string(),
                name: "自建 DeepSeek".to_string(),
                protocol: "openai".to_string(),
                base_url: Some("https://proxy.example.com".to_string()),
                model: "deepseek-chat".to_string(),
                is_builtin: false,
            }],
        )
        .unwrap();

        let list = records(&store);
        assert_eq!(list[0].model, "deepseek-chat");
        assert_eq!(
            list[0].base_url.as_deref(),
            Some("https://proxy.example.com")
        );
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
    fn a_non_http_scheme_has_its_own_reason() {
        // 与「不是合法地址」分开（commands.md §1.6）：界面按 reason 给不同提示。
        let error = validate(&input("openai", Some("ftp://example.com"), Some("k")), false)
            .unwrap_err();
        assert_eq!(error.0, "base_url_scheme");
        // 文案只给测试与日志，不随错误出网。
        assert!(error.1.contains("http / https"));

        let error = validate(&input("openai", Some("not a url"), Some("k")), false).unwrap_err();
        assert_eq!(error.0, "base_url_invalid");
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

    /// 保存 DeepSeek Key 后，没有可用凭据时激活内置 DeepSeek（保存即已配置）。
    #[test]
    fn saving_a_deepseek_key_activates_it_when_nothing_is_usable() {
        ensure_secrets();
        let store = store();
        ensure_migrated(&store);
        set_active_id(&store, None).unwrap();

        activate_builtin_if_unconfigured(&store);
        assert_eq!(active_id(&store).as_deref(), Some(PROVIDER_DEEPSEEK));
    }

    /// 已有可用的 active（例如自定义服务商）时，保存 DeepSeek Key 不得抢 active。
    #[test]
    fn saving_a_deepseek_key_keeps_a_usable_active_provider() {
        ensure_secrets();
        let store = store();
        let saved = save(
            &store,
            input(
                "anthropic",
                Some("https://api.anthropic.com"),
                Some("sk-custom"),
            ),
        )
        .unwrap();
        let id = saved["provider_id"].as_str().unwrap().to_string();
        assert_eq!(active_id(&store).as_deref(), Some(id.as_str()));

        activate_builtin_if_unconfigured(&store);
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
