//! 模型 provider 装配：openai 兼容 / anthropic 兼容。
//!
//! Claurst 在 `config.provider != "anthropic"` 时走 ProviderRegistry 分派，
//! 因此必须把 App 自己的 key 与 base_url 同时写进 `provider_configs`，
//! 否则 claurst 会用默认的 api.openai.com 重建一个空 key 的 provider。

use std::collections::HashMap;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use claurst_api::{
    client::ClientConfig, AnthropicClient, AnthropicProvider, LlmProvider, ModelInfo,
    OpenAiProvider, ProviderCapabilities, ProviderError, ProviderRegistry, ProviderRequest,
    ProviderResponse, ProviderStatus, StreamEvent,
};
use claurst_core::{ProviderConfig, ProviderId};
use futures::Stream;

pub const DEEPSEEK_BASE_URL: &str = "https://api.deepseek.com";
pub const DEEPSEEK_MODEL: &str = "deepseek-flash";
pub const OPENAI_BASE_URL: &str = "https://api.openai.com";
pub const ANTHROPIC_BASE_URL: &str = "https://api.anthropic.com";

/// DeepSeek 路径注册的自定义 provider id。
///
/// 不能用 `deepseek`：claurst 的 `route.rs` 只要 `resolve_provider_api_base`
/// 有值就会用 `provider_from_config` 重建 provider，而 `deepseek` 有内置默认
/// base，重建出来的实例不带我们的「关思考」包装。这个 id 没有 provider_config
/// 的 api_base、没有环境变量、也没有内置默认，`resolve_provider_api_base` 返回
/// `None`，registry 里的包装层因此不会被替换。
pub const VEYL_DEEPSEEK_PROVIDER_ID: &str = "veyl-deepseek";

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
    let mut base = normalize_openai_base(&credentials.base_url);
    let deepseek = is_deepseek(credentials, &base);
    if deepseek && base.is_empty() {
        base = DEEPSEEK_BASE_URL.to_string();
    }

    let client = AnthropicClient::new(ClientConfig {
        api_key: credentials.api_key.clone(),
        api_base: ANTHROPIC_BASE_URL.to_string(),
        request_timeout: Duration::from_secs(120),
        ..Default::default()
    })
    .map_err(|error| anyhow::anyhow!("创建 AI 客户端失败: {error}"))?;

    // 走哪条装配路径由端点决定，不看 `protocol`：DeepSeek 的 OpenAI 兼容端点
    // 需要它自带的 DSML 工具调用与流式解析，通用 `OpenAiProvider` 两者都不认。
    // 其它端点保持原样，行为不动。
    let provider_id = if deepseek {
        VEYL_DEEPSEEK_PROVIDER_ID
    } else {
        "openai"
    };
    let mut registry = ProviderRegistry::new();
    let mut provider_configs = HashMap::new();
    if deepseek {
        // 复用 claurst 自带的 DeepSeek profile（quirk 只此一份，不另抄）。
        // 工厂会先读 DEEPSEEK_API_KEY，紧接着被我们自己的 key 覆盖；空 key 会被
        // 清成 None，因此环境变量里的 key 不会意外生效。
        let inner: Arc<dyn LlmProvider> = Arc::new(
            claurst_api::deepseek()
                .with_api_key(credentials.api_key.clone())
                .with_base_url(openai_compat_base(&base)),
        );
        registry.register(Arc::new(DeepSeekNoThinking::new(
            inner,
            ProviderId::new(VEYL_DEEPSEEK_PROVIDER_ID),
        )));

        // 只写 key，不写 api_base：有 api_base 就会触发 `provider_from_config`
        // 重建，包装层会被换成不带「关思考」的实例。
        provider_configs.insert(
            VEYL_DEEPSEEK_PROVIDER_ID.to_string(),
            ProviderConfig {
                api_key: Some(credentials.api_key.clone()),
                ..Default::default()
            },
        );
    } else {
        let provider = OpenAiProvider::new(credentials.api_key.clone()).with_base_url(base.clone());
        registry.register(Arc::new(provider));

        // claurst 在 `provider_from_config` 里会按 provider id 重建 provider；
        // key 与 base 必须写在同一个 id 下，否则重建出来的实例会落到默认端点。
        provider_configs.insert(
            "openai".to_string(),
            ProviderConfig {
                api_key: Some(credentials.api_key.clone()),
                api_base: Some(base),
                ..Default::default()
            },
        );
    }
    registry.set_default(ProviderId::new(provider_id));

    Ok(ProviderSetup {
        client,
        registry: Arc::new(registry),
        core_provider: Some(provider_id.to_string()),
        provider_configs,
    })
}

/// DeepSeek 的 OpenAI 兼容 profile 保留 DSML 工具调用与流式解析，但显式关掉思考。
///
/// 关掉后响应里不会出现 `reasoning_content`，也就不存在官方要求的「带 tools 的
/// 后续请求必须原样回传 reasoning_content」这一环。
struct DeepSeekNoThinking {
    inner: Arc<dyn LlmProvider>,
    id: ProviderId,
}

impl DeepSeekNoThinking {
    fn new(inner: Arc<dyn LlmProvider>, id: ProviderId) -> Self {
        Self { inner, id }
    }
}

/// `thinking` 是 DeepSeek 的开关位，会经 `merge_openai_compatible_options`
/// 的未知键分支原样写进请求体根；已有的其它 provider_options 键保持不动。
fn with_thinking_disabled(mut request: ProviderRequest) -> ProviderRequest {
    if !request.provider_options.is_object() {
        request.provider_options = serde_json::Value::Object(serde_json::Map::new());
    }
    if let Some(options) = request.provider_options.as_object_mut() {
        options.insert(
            "thinking".to_string(),
            serde_json::json!({ "type": "disabled" }),
        );
    }
    request
}

#[async_trait::async_trait]
impl LlmProvider for DeepSeekNoThinking {
    fn id(&self) -> &ProviderId {
        &self.id
    }

    fn name(&self) -> &str {
        self.inner.name()
    }

    async fn create_message(
        &self,
        request: ProviderRequest,
    ) -> Result<ProviderResponse, ProviderError> {
        self.inner
            .create_message(with_thinking_disabled(request))
            .await
    }

    async fn create_message_stream(
        &self,
        request: ProviderRequest,
    ) -> Result<Pin<Box<dyn Stream<Item = Result<StreamEvent, ProviderError>> + Send>>, ProviderError>
    {
        self.inner
            .create_message_stream(with_thinking_disabled(request))
            .await
    }

    async fn discover_models(&self) -> Result<Vec<ModelInfo>, ProviderError> {
        self.inner.discover_models().await
    }

    async fn health_check(&self) -> Result<ProviderStatus, ProviderError> {
        self.inner.health_check().await
    }

    fn capabilities(&self) -> ProviderCapabilities {
        self.inner.capabilities()
    }
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

/// OpenAI 兼容 provider 的 base 必须带 `/v1`（它直接拼 `/chat/completions`）。
fn openai_compat_base(base: &str) -> String {
    let trimmed = base.trim();
    let trimmed = trimmed.trim_end_matches('/');
    if trimmed.ends_with("/v1") {
        trimmed.to_string()
    } else {
        format!("{trimmed}/v1")
    }
}

/// DeepSeek 端点判定：provider id、模型名前缀，或 base 的 host 命中。
///
/// 自建/代理的 DeepSeek 既可能改 base（host 不再是 api.deepseek.com），也可能
/// 只填了 Key 而后端沿用其它 provider id；模型名以 `deepseek` 开头是可靠的兜底信号。
fn is_deepseek(credentials: &LlmCredentials, normalized_base: &str) -> bool {
    credentials
        .provider_id
        .trim()
        .eq_ignore_ascii_case("deepseek")
        || credentials
            .model
            .trim()
            .to_ascii_lowercase()
            .starts_with("deepseek")
        || base_host(normalized_base)
            .is_some_and(|host| host.eq_ignore_ascii_case("api.deepseek.com"))
}

/// 取 URL 的 host（不含 userinfo、端口、IPv6 方括号）。解析失败返回 `None`。
fn base_host(base: &str) -> Option<&str> {
    let trimmed = base.trim();
    let rest = trimmed.split_once("://").map_or(trimmed, |(_, rest)| rest);
    let authority = rest.split(['/', '?', '#']).next()?;
    let host_port = authority.rsplit('@').next()?;
    if let Some(stripped) = host_port.strip_prefix('[') {
        return stripped.split(']').next();
    }
    host_port.split(':').next()
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

    #[test]
    fn deepseek_credentials_use_the_reasoning_profile() {
        let setup = build(&LlmCredentials::deepseek("sk-test")).unwrap();

        assert_eq!(
            setup.core_provider.as_deref(),
            Some(VEYL_DEEPSEEK_PROVIDER_ID)
        );
        assert_eq!(
            setup.registry.default_provider_id().to_string(),
            VEYL_DEEPSEEK_PROVIDER_ID
        );
        assert_eq!(
            setup.provider_configs[VEYL_DEEPSEEK_PROVIDER_ID]
                .api_key
                .as_deref(),
            Some("sk-test")
        );
        // 有 api_base 就会触发 `provider_from_config` 重建，包装层会被丢掉。
        assert!(
            setup.provider_configs[VEYL_DEEPSEEK_PROVIDER_ID]
                .api_base
                .is_none(),
            "自定义 provider id 不能带 api_base"
        );

        let provider = setup
            .registry
            .get(&ProviderId::new(VEYL_DEEPSEEK_PROVIDER_ID))
            .expect("包装层必须注册在 registry 里");
        assert_eq!(provider.id().to_string(), VEYL_DEEPSEEK_PROVIDER_ID);
        // 内层仍是 DeepSeek profile：DSML 工具调用与流式解析都靠它。
        assert!(
            provider.capabilities().thinking,
            "内层必须是带 reasoning quirk 的 DeepSeek profile"
        );
        assert!(provider.capabilities().tool_calling);
    }

    #[test]
    fn a_deepseek_base_url_uses_the_reasoning_profile_even_without_the_provider_id() {
        let setup = build(&LlmCredentials {
            provider_id: "openai".into(),
            protocol: "openai".into(),
            api_key: "sk-test".into(),
            base_url: "https://api.deepseek.com/v1/".into(),
            model: "deepseek-flash".into(),
        })
        .unwrap();

        assert_eq!(
            setup.core_provider.as_deref(),
            Some(VEYL_DEEPSEEK_PROVIDER_ID)
        );
        assert_eq!(
            setup.provider_configs[VEYL_DEEPSEEK_PROVIDER_ID]
                .api_key
                .as_deref(),
            Some("sk-test")
        );
        assert!(setup.provider_configs[VEYL_DEEPSEEK_PROVIDER_ID]
            .api_base
            .is_none());
    }

    #[test]
    fn deepseek_host_matching_is_exact_case_insensitive_and_ignores_port() {
        let mut credentials = LlmCredentials::deepseek("sk-test");
        credentials.provider_id = "openai".into();
        // 只让 host 决定命中，避免模型名兜底把这条用例变成 tautology。
        credentials.model = "gpt-4o".into();

        for base in [
            "https://api.deepseek.com",
            "https://api.deepseek.com/v1",
            "https://API.DeepSeek.com:443/v1",
        ] {
            credentials.base_url = base.into();
            let setup = build(&credentials).unwrap();
            assert_eq!(
                setup.core_provider.as_deref(),
                Some(VEYL_DEEPSEEK_PROVIDER_ID),
                "{base}"
            );
        }

        // 只是前缀相同不算命中，避免把别人的域名当成 DeepSeek。
        credentials.base_url = "https://api.deepseek.com.evil.test/v1".into();
        let setup = build(&credentials).unwrap();
        assert_eq!(setup.core_provider.as_deref(), Some("openai"));
    }

    #[test]
    fn a_deepseek_model_uses_the_reasoning_profile_on_a_custom_base() {
        // 自建/代理：host 不是 api.deepseek.com、provider id 也不是 deepseek，
        // 但模型名是可靠信号，必须仍然走带 quirk 的 profile。
        let setup = build(&LlmCredentials {
            provider_id: "openai".into(),
            protocol: "openai".into(),
            api_key: "sk-test".into(),
            base_url: "https://llm-proxy.example.com/v1".into(),
            model: "deepseek-flash".into(),
        })
        .unwrap();

        assert_eq!(
            setup.core_provider.as_deref(),
            Some(VEYL_DEEPSEEK_PROVIDER_ID)
        );
        assert!(
            setup
                .registry
                .get(&ProviderId::new(VEYL_DEEPSEEK_PROVIDER_ID))
                .is_some(),
            "自定义 base 也必须走包装层"
        );
    }

    #[test]
    fn other_openai_compatible_endpoints_keep_the_generic_provider() {
        for base in [
            "https://api.openai.com/v1",
            "https://api.moonshot.cn/v1",
            "http://127.0.0.1:11434/v1",
        ] {
            let setup = build(&LlmCredentials {
                provider_id: "openai".into(),
                protocol: "openai".into(),
                api_key: "sk-test".into(),
                base_url: base.into(),
                model: "some-model".into(),
            })
            .unwrap();

            assert_eq!(setup.core_provider.as_deref(), Some("openai"), "{base}");
            assert!(
                setup.provider_configs.contains_key("openai"),
                "{base} 必须仍然写 openai 的 key/base"
            );
            assert!(
                !setup
                    .provider_configs
                    .contains_key(VEYL_DEEPSEEK_PROVIDER_ID),
                "{base} 不该命中 DeepSeek profile"
            );
            let provider = setup
                .registry
                .get(&ProviderId::new(ProviderId::OPENAI))
                .expect("通用 OpenAI provider 必须注册");
            assert!(!provider.capabilities().thinking, "{base}");
        }
    }

    #[test]
    fn the_custom_provider_id_never_triggers_a_provider_rebuild() {
        let setup = build(&LlmCredentials::deepseek("sk-test")).unwrap();
        let config = claurst_core::Config {
            provider_configs: setup.provider_configs.clone(),
            ..Default::default()
        };

        assert!(
            claurst_api::registry::resolve_provider_api_base(&config, VEYL_DEEPSEEK_PROVIDER_ID)
                .is_none(),
            "只要解析出 api_base 就会按 id 重建 provider，包装层会被丢掉"
        );
    }

    struct RecordingProvider {
        id: ProviderId,
        requests: std::sync::Mutex<Vec<ProviderRequest>>,
    }

    impl RecordingProvider {
        fn new() -> Self {
            Self {
                id: ProviderId::new("recording"),
                requests: std::sync::Mutex::new(Vec::new()),
            }
        }
    }

    #[async_trait::async_trait]
    impl LlmProvider for RecordingProvider {
        fn id(&self) -> &ProviderId {
            &self.id
        }

        fn name(&self) -> &str {
            "recording"
        }

        async fn create_message(
            &self,
            request: ProviderRequest,
        ) -> Result<ProviderResponse, ProviderError> {
            self.requests.lock().unwrap().push(request.clone());
            Ok(ProviderResponse {
                id: "rec".to_string(),
                content: Vec::new(),
                stop_reason: claurst_api::StopReason::EndTurn,
                usage: claurst_core::types::UsageInfo::default(),
                model: request.model,
                rate_limits: None,
            })
        }

        async fn create_message_stream(
            &self,
            request: ProviderRequest,
        ) -> Result<
            Pin<Box<dyn Stream<Item = Result<StreamEvent, ProviderError>> + Send>>,
            ProviderError,
        > {
            self.requests.lock().unwrap().push(request);
            Ok(Box::pin(futures::stream::empty::<
                Result<StreamEvent, ProviderError>,
            >()))
        }

        async fn health_check(&self) -> Result<ProviderStatus, ProviderError> {
            Ok(ProviderStatus::Healthy)
        }

        fn capabilities(&self) -> ProviderCapabilities {
            ProviderCapabilities {
                streaming: true,
                tool_calling: true,
                thinking: false,
                image_input: false,
                pdf_input: false,
                audio_input: false,
                video_input: false,
                caching: false,
                structured_output: false,
                system_prompt_style: claurst_api::SystemPromptStyle::SystemMessage,
            }
        }
    }

    fn recording_request() -> ProviderRequest {
        ProviderRequest {
            model: "deepseek-flash".to_string(),
            messages: Vec::new(),
            system_prompt: None,
            tools: Vec::new(),
            max_tokens: 64,
            temperature: None,
            top_p: None,
            top_k: None,
            stop_sequences: Vec::new(),
            thinking: None,
            provider_options: serde_json::json!({}),
        }
    }

    #[tokio::test]
    async fn the_deepseek_wrapper_disables_thinking_on_both_paths() {
        let inner = Arc::new(RecordingProvider::new());
        let wrapper =
            DeepSeekNoThinking::new(inner.clone(), ProviderId::new(VEYL_DEEPSEEK_PROVIDER_ID));

        let mut request = recording_request();
        request.provider_options = serde_json::json!({
            "reasoningEffort": "low",
            "custom": 1,
        });

        wrapper.create_message(request.clone()).await.unwrap();
        wrapper.create_message_stream(request).await.unwrap();

        let seen = inner.requests.lock().unwrap();
        assert_eq!(seen.len(), 2, "非流式与流式都必须经过包装层");
        for (index, request) in seen.iter().enumerate() {
            assert_eq!(
                request.provider_options["thinking"],
                serde_json::json!({ "type": "disabled" }),
                "第 {index} 次请求没关思考"
            );
            // 原有的 provider_options 键不能被整个覆盖掉。
            assert_eq!(request.provider_options["reasoningEffort"], "low");
            assert_eq!(request.provider_options["custom"], 1);
        }
    }

    #[tokio::test]
    async fn non_object_provider_options_still_get_thinking_disabled() {
        let inner = Arc::new(RecordingProvider::new());
        let wrapper =
            DeepSeekNoThinking::new(inner.clone(), ProviderId::new(VEYL_DEEPSEEK_PROVIDER_ID));

        let mut request = recording_request();
        request.provider_options = serde_json::Value::Null;
        wrapper.create_message(request).await.unwrap();

        let seen = inner.requests.lock().unwrap();
        assert_eq!(
            seen[0].provider_options["thinking"],
            serde_json::json!({ "type": "disabled" })
        );
    }

    #[test]
    fn the_wrapper_delegates_identity_and_capabilities_to_the_inner_provider() {
        let inner = Arc::new(RecordingProvider::new());
        let wrapper =
            DeepSeekNoThinking::new(inner.clone(), ProviderId::new(VEYL_DEEPSEEK_PROVIDER_ID));

        assert_eq!(wrapper.id().to_string(), VEYL_DEEPSEEK_PROVIDER_ID);
        assert_eq!(wrapper.name(), "recording");
        assert!(wrapper.capabilities().tool_calling);
    }
}
