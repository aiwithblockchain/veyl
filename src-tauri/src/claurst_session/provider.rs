//! 模型 provider 装配：openai 兼容 / anthropic 兼容。
//!
//! Claurst 在 `config.provider != "anthropic"` 时走 ProviderRegistry 分派，
//! 因此必须把 App 自己的 key 与 base_url 同时写进 `provider_configs`，
//! 否则 claurst 会用默认的 api.openai.com 重建一个空 key 的 provider。

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use claurst_api::{
    client::ClientConfig, AnthropicClient, AnthropicProvider, OpenAiProvider, ProviderRegistry,
};
use claurst_core::{ProviderConfig, ProviderId};

pub const DEEPSEEK_BASE_URL: &str = "https://api.deepseek.com";
pub const DEEPSEEK_MODEL: &str = "deepseek-chat";
pub const OPENAI_BASE_URL: &str = "https://api.openai.com";
pub const ANTHROPIC_BASE_URL: &str = "https://api.anthropic.com";

/// 当前 provider 的运行时凭据。`protocol` 决定走哪条装配路径。
#[derive(Debug, Clone)]
pub struct LlmCredentials {
    pub provider_id: String,
    pub protocol: String,
    pub api_key: String,
    pub base_url: String,
    pub model: String,
}

impl LlmCredentials {
    pub fn deepseek(api_key: impl Into<String>) -> Self {
        Self {
            provider_id: "deepseek".to_string(),
            protocol: "openai".to_string(),
            api_key: api_key.into(),
            base_url: DEEPSEEK_BASE_URL.to_string(),
            model: DEEPSEEK_MODEL.to_string(),
        }
    }
}

pub struct ProviderSetup {
    /// OpenAI 协议下只作占位，真正请求走 registry；Anthropic 协议下也供直接调用使用。
    pub client: AnthropicClient,
    pub registry: Arc<ProviderRegistry>,
    pub core_provider: Option<String>,
    pub provider_configs: HashMap<String, ProviderConfig>,
}

pub fn build(credentials: &LlmCredentials) -> anyhow::Result<ProviderSetup> {
    if credentials.protocol == "anthropic" {
        build_anthropic(credentials)
    } else {
        build_openai(credentials)
    }
}

fn build_openai(credentials: &LlmCredentials) -> anyhow::Result<ProviderSetup> {
    let base = normalize_openai_base(&credentials.base_url);

    let client = AnthropicClient::new(ClientConfig {
        api_key: credentials.api_key.clone(),
        api_base: ANTHROPIC_BASE_URL.to_string(),
        request_timeout: Duration::from_secs(120),
        ..Default::default()
    })
    .map_err(|error| anyhow::anyhow!("创建 AI 客户端失败: {error}"))?;

    let provider = OpenAiProvider::new(credentials.api_key.clone()).with_base_url(base.clone());
    let mut registry = ProviderRegistry::new();
    registry.register(Arc::new(provider));
    registry.set_default(ProviderId::new(ProviderId::OPENAI));

    let mut provider_configs = HashMap::new();
    provider_configs.insert(
        "openai".to_string(),
        ProviderConfig {
            api_key: Some(credentials.api_key.clone()),
            api_base: Some(base),
            ..Default::default()
        },
    );

    Ok(ProviderSetup {
        client,
        registry: Arc::new(registry),
        core_provider: Some("openai".to_string()),
        provider_configs,
    })
}

fn build_anthropic(credentials: &LlmCredentials) -> anyhow::Result<ProviderSetup> {
    let base = credentials.base_url.trim().trim_end_matches('/').to_string();
    let base = if base.is_empty() {
        ANTHROPIC_BASE_URL.to_string()
    } else {
        base
    };

    let config = ClientConfig {
        api_key: credentials.api_key.clone(),
        api_base: base.clone(),
        request_timeout: Duration::from_secs(120),
        ..Default::default()
    };
    let client = AnthropicClient::new(config.clone())
        .map_err(|error| anyhow::anyhow!("创建 AI 客户端失败: {error}"))?;

    let provider = AnthropicProvider::from_config(config);
    let mut registry = ProviderRegistry::new();
    registry.register(Arc::new(provider));
    registry.set_default(ProviderId::new("anthropic"));

    let mut provider_configs = HashMap::new();
    provider_configs.insert(
        "anthropic".to_string(),
        ProviderConfig {
            api_key: Some(credentials.api_key.clone()),
            api_base: Some(base),
            ..Default::default()
        },
    );

    Ok(ProviderSetup {
        client,
        registry: Arc::new(registry),
        core_provider: Some("anthropic".to_string()),
        provider_configs,
    })
}

/// 去掉末尾斜杠与 "/v1"，避免 OpenAiProvider 内部拼出 /v1/v1。
fn normalize_openai_base(base: &str) -> String {
    let trimmed = base.trim().trim_end_matches('/');
    truncated(trimmed)
}

fn truncated(base: &str) -> String {
    match base.strip_suffix("/v1") {
        Some(head) => head.to_string(),
        None => base.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_trailing_v1_for_openai_bases() {
        assert_eq!(
            normalize_openai_base("https://api.deepseek.com/v1/"),
            "https://api.deepseek.com"
        );
    }

    #[test]
    fn anthropic_credentials_are_built_with_the_custom_base() {
        let setup = build(&LlmCredentials {
            provider_id: "x".into(),
            protocol: "anthropic".into(),
            api_key: "sk-test".into(),
            base_url: "https://example.com".into(),
            model: "claude-test".into(),
        })
        .unwrap();
        assert_eq!(setup.core_provider.as_deref(), Some("anthropic"));
        assert_eq!(
            setup.provider_configs["anthropic"].api_base.as_deref(),
            Some("https://example.com")
        );
    }
}
