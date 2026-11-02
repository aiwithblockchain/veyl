//! DeepSeek（OpenAI 兼容协议）的 provider 装配。
//!
//! Claurst 在 `config.provider != "anthropic"` 时走 ProviderRegistry 分派，
//! 因此必须把 App 自己的 key 与 base_url 同时写进 `provider_configs`，
//! 否则 claurst 会用默认的 api.openai.com 重建一个空 key 的 provider。

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use claurst_api::{client::ClientConfig, AnthropicClient, OpenAiProvider, ProviderRegistry};
use claurst_core::{ProviderConfig, ProviderId};

pub const DEEPSEEK_BASE_URL: &str = "https://api.deepseek.com";
pub const DEEPSEEK_MODEL: &str = "deepseek-chat";

#[derive(Debug, Clone)]
pub struct DeepSeekCredentials {
    pub api_key: String,
    pub base_url: String,
    pub model: String,
}

impl DeepSeekCredentials {
    pub fn new(api_key: impl Into<String>) -> Self {
        Self {
            api_key: api_key.into(),
            base_url: DEEPSEEK_BASE_URL.to_string(),
            model: DEEPSEEK_MODEL.to_string(),
        }
    }
}

pub struct ProviderSetup {
    /// OpenAI 协议下只作占位，真正请求走 registry。
    pub client: AnthropicClient,
    pub registry: Arc<ProviderRegistry>,
    pub core_provider: Option<String>,
    pub provider_configs: HashMap<String, ProviderConfig>,
}

pub fn build(credentials: &DeepSeekCredentials) -> anyhow::Result<ProviderSetup> {
    let base = normalize_openai_base(&credentials.base_url);

    let client = AnthropicClient::new(ClientConfig {
        api_key: credentials.api_key.clone(),
        api_base: "https://api.anthropic.com".to_string(),
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
