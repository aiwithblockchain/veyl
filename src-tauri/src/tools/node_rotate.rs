//! `NodeRotateCredentials`：AI 经确认卡触发节点端口 / 密码轮换（`node-agent-mcp.md` §8 / §10）。
//!
//! 节点上的 agent 是一个只暴露 `rotate_credentials` 的 MCP server，证书自签。
//! 这里直连 rmcp 的 streamable HTTP client，并注入自建的 reqwest 0.13 客户端承担信任：
//! 控制面给了 CA 就加根证书，没有才退回按叶子证书指纹 pin。不走 claurst 的
//! `McpClient`——它写死 `from_config`，注入不了自签信任（§10）。
//!
//! 令牌与密码都不进日志、事件与工具返回值；agent 只回 `{ok, port}`。

use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use claurst_tools::{PermissionLevel, Tool, ToolContext, ToolResult, UserQuestionEvent};
use rmcp::model::{CallToolRequestParams, ClientInfo};
use rmcp::service::{ClientInitializeError, ServiceError};
use rmcp::transport::streamable_http_client::{
    StreamableHttpClientTransportConfig, StreamableHttpError,
};
use rmcp::transport::{DynamicTransportError, StreamableHttpClientTransport};
use rmcp::{ClientHandler, ServiceExt};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use url::Url;

use super::display::Changed;
use super::envelope::{self, AivpnError, ToolOutcome};
use crate::agent::questions;
use crate::control_plane::client::ControlPlane;
use crate::control_plane::error::CpError;
use crate::tools::policy;

const TOOL_NAME: &str = "NodeRotateCredentials";
const AGENT_TOOL: &str = "rotate_credentials";
const CONFIRM_KIND: &str = "node_rotate_confirm";
const CONFIRM_OPTION: &str = "重置";
const CANCEL_OPTION: &str = "取消";
/// 控制面令牌本身只有 60 秒寿命，取令牌再慢就没有意义了。
const TOKEN_TIMEOUT: Duration = Duration::from_secs(10);
/// 设计 §10 的 20 秒只够握手；真实轮换要等重启与验活，最坏 60 秒以上。
const MCP_TIMEOUT: Duration = Duration::from_secs(90);
/// 轮换由用户在界面上确认过，agent 只需要知道不是自动排障。
const AGENT_REASON: &str = "user";

#[derive(Debug, Clone, PartialEq)]
struct RotateReport {
    port: u16,
}

/// 失败分类就是给模型看的四类原因（外加协议 / 网络细分），`details.reason` 落在信封里。
#[derive(Debug, Clone)]
enum AgentFailure {
    /// 控制面没给令牌：码与 reason 原样保留（`not_ready` / `agent_not_registered` / ...）。
    ControlPlane(CpError),
    /// 控制面或 agent 回了结构不对的数据（不是用户能修的问题）。
    BadResponse(String),
    /// 证书没通过 CA / 指纹校验，请求在 TLS 阶段就停了。
    TlsUntrusted(String),
    /// agent 不认这次令牌（401 / 403）。
    TokenRejected,
    /// 90 秒内没跑完。
    Timeout,
    /// 连不上或连接中断。
    Transport(String),
    /// agent 明确回了 `{ok:false}`。
    ToolFailed { message: String, retryable: bool },
}

impl AgentFailure {
    fn into_aivpn(self) -> AivpnError {
        match self {
            Self::ControlPlane(error) => {
                let reason = error
                    .reason()
                    .unwrap_or("agent_token_unavailable")
                    .to_string();
                let mut mapped = AivpnError::new(&error.code, error.message);
                mapped.retryable = error.retryable;
                mapped.with_details(json!({ "reason": reason }))
            }
            Self::BadResponse(detail) => {
                AivpnError::new("INTERNAL", "节点代理返回的数据不完整，这次没有重置")
                    .with_details(json!({ "reason": "agent_bad_response", "detail": detail }))
            }
            Self::TlsUntrusted(detail) => AivpnError::new(
                "UPSTREAM_ERROR",
                "无法确认节点证书，操作已停止（令牌没有发出）",
            )
            .with_details(json!({ "reason": "agent_tls_untrusted", "detail": detail })),
            Self::TokenRejected => {
                AivpnError::new("UPSTREAM_ERROR", "节点拒绝了这次操作令牌，请重新获取后重试")
                    .with_details(json!({ "reason": "agent_token_rejected" }))
            }
            Self::Timeout => {
                let mut error = AivpnError::new("TIMEOUT", "节点在 90 秒内没有完成重置");
                error.retryable = true;
                error.with_details(json!({ "reason": "agent_timeout" }))
            }
            Self::Transport(detail) => {
                let mut error = AivpnError::new(
                    "UPSTREAM_ERROR",
                    "连不上节点代理，请确认这台服务器还在正常运行",
                );
                error.retryable = true;
                error.with_details(json!({ "reason": "agent_unreachable", "detail": detail }))
            }
            Self::ToolFailed { message, retryable } => {
                let mut error = AivpnError::new("INTERNAL", format!("节点没能完成重置：{message}"));
                error.retryable = retryable;
                error.with_details(json!({
                    "reason": "agent_tool_failed",
                    "retryable": retryable,
                }))
            }
        }
    }
}

#[async_trait]
trait RotateBackend: Send + Sync {
    async fn rotate(&self, server_id: &str) -> Result<RotateReport, AgentFailure>;
}

/// 同一张票里同时有 CA 与指纹；先用 CA，链校验失败才回退指纹。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum TrustMode {
    Ca,
    Fingerprint,
}

#[async_trait]
trait TicketSource: Send + Sync {
    async fn fetch(&self, server_id: &str) -> Result<AgentTicket, AgentFailure>;
}

#[async_trait]
trait McpRunner: Send + Sync {
    async fn rotate(
        &self,
        ticket: &AgentTicket,
        trust: TrustMode,
    ) -> Result<RotateReport, AgentFailure>;
}

struct ControlPlaneTickets;

#[async_trait]
impl TicketSource for ControlPlaneTickets {
    async fn fetch(&self, server_id: &str) -> Result<AgentTicket, AgentFailure> {
        fetch_ticket(server_id).await
    }
}

struct HttpMcpRunner;

#[async_trait]
impl McpRunner for HttpMcpRunner {
    async fn rotate(
        &self,
        ticket: &AgentTicket,
        trust: TrustMode,
    ) -> Result<RotateReport, AgentFailure> {
        let client = match trust {
            TrustMode::Ca => ca_client(ticket.ca_pem.as_deref().unwrap_or_default())?,
            TrustMode::Fingerprint => pinned_client(ticket.fingerprint)?,
        };
        run_mcp(ticket, client).await
    }
}

struct LiveBackend {
    tickets: Arc<dyn TicketSource>,
    runner: Arc<dyn McpRunner>,
}

impl LiveBackend {
    fn new() -> Self {
        Self {
            tickets: Arc::new(ControlPlaneTickets),
            runner: Arc::new(HttpMcpRunner),
        }
    }
}

#[async_trait]
impl RotateBackend for LiveBackend {
    async fn rotate(&self, server_id: &str) -> Result<RotateReport, AgentFailure> {
        let ticket = self.tickets.fetch(server_id).await?;
        let first_trust = if ticket.ca_pem.is_some() {
            TrustMode::Ca
        } else {
            TrustMode::Fingerprint
        };
        let attempt = async {
            match self.runner.rotate(&ticket, first_trust).await {
                // CA 链校验失败（证书链不完整、CA 换过）时，用同一张票的指纹再试一次：
                // 令牌是一次性的，重新开票换不来第二次机会。
                Err(AgentFailure::TlsUntrusted(_)) if first_trust == TrustMode::Ca => {
                    log::warn!("节点 CA 校验失败，改用同一张票的指纹 pin 重试");
                    self.runner.rotate(&ticket, TrustMode::Fingerprint).await
                }
                other => other,
            }
        };
        match tokio::time::timeout(MCP_TIMEOUT, attempt).await {
            Ok(result) => result,
            Err(_) => Err(AgentFailure::Timeout),
        }
    }
}

#[derive(Clone)]
struct AgentTicket {
    endpoint: String,
    token: String,
    ca_pem: Option<String>,
    fingerprint: [u8; 32],
}

impl AgentTicket {
    fn parse(value: &Value) -> Result<Self, AgentFailure> {
        let endpoint = value
            .get("endpoint")
            .and_then(Value::as_str)
            .ok_or_else(|| AgentFailure::BadResponse("endpoint".into()))?;
        let parsed =
            Url::parse(endpoint).map_err(|_| AgentFailure::BadResponse("endpoint".into()))?;
        // 明文 HTTP 的令牌不接受（设计 §7）。
        if parsed.scheme() != "https" || parsed.host_str().is_none() {
            return Err(AgentFailure::BadResponse("endpoint".into()));
        }
        // endpoint 是控制面下发的完整 MCP URL（带 `/mcp`），Host 不拼路径：
        // 端点语义只在一处定义。这里只保留原值。
        let endpoint = endpoint.to_string();
        let token = value
            .get("token")
            .and_then(Value::as_str)
            .filter(|token| !token.is_empty())
            .ok_or_else(|| AgentFailure::BadResponse("token".into()))?;
        let raw_fingerprint = value
            .get("cert_fingerprint")
            .and_then(Value::as_str)
            .ok_or_else(|| AgentFailure::BadResponse("cert_fingerprint".into()))?;
        let fingerprint = parse_fingerprint(raw_fingerprint)
            .ok_or_else(|| AgentFailure::BadResponse("cert_fingerprint".into()))?;
        let ca_pem = value
            .get("ca_pem")
            .and_then(Value::as_str)
            .filter(|pem| !pem.trim().is_empty())
            .map(str::to_string);
        Ok(Self {
            endpoint,
            token: token.to_string(),
            ca_pem,
            fingerprint,
        })
    }
}

async fn fetch_ticket(server_id: &str) -> Result<AgentTicket, AgentFailure> {
    let control_plane = ControlPlane::new().map_err(AgentFailure::ControlPlane)?;
    let path = format!("/v1/servers/{server_id}/agent-token");
    let value = control_plane
        .post_with_timeout(&path, None, None, TOKEN_TIMEOUT)
        .await
        .map_err(AgentFailure::ControlPlane)?;
    AgentTicket::parse(&value)
}

/// 信任链只有两条：有 CA 就加根证书交给正常校验；没有 CA 才按叶子指纹 pin。
fn ca_client(ca_pem: &str) -> Result<reqwest13::Client, AgentFailure> {
    let certificate = reqwest13::Certificate::from_pem(ca_pem.as_bytes())
        .map_err(|_| AgentFailure::BadResponse("ca_pem".into()))?;
    reqwest13::Client::builder()
        .add_root_certificate(certificate)
        .build()
        // 构造阶段不联网：失败只能是 CA 不可用（或本机 TLS 后端起不来），不是节点证书的问题。
        .map_err(|_| AgentFailure::BadResponse("ca_pem".into()))
}

/// 指纹 pin：先比叶子证书的 SHA-256，再让 rustls 用证书自己的公钥验握手签名。
///
/// 没有 CA 时不做链校验——指纹就是信任锚；签名仍必须验，否则等于接受任意证书。
#[derive(Debug)]
struct FingerprintPin {
    expected: [u8; 32],
    algorithms: rustls::crypto::WebPkiSupportedAlgorithms,
}

impl rustls::client::danger::ServerCertVerifier for FingerprintPin {
    fn verify_server_cert(
        &self,
        end_entity: &rustls::pki_types::CertificateDer<'_>,
        _intermediates: &[rustls::pki_types::CertificateDer<'_>],
        _server_name: &rustls::pki_types::ServerName<'_>,
        _ocsp_response: &[u8],
        _now: rustls::pki_types::UnixTime,
    ) -> Result<rustls::client::danger::ServerCertVerified, rustls::Error> {
        let actual = Sha256::digest(end_entity.as_ref());
        if actual.as_slice() != self.expected {
            return Err(rustls::Error::General(
                "agent 证书指纹与控制面不一致".into(),
            ));
        }
        Ok(rustls::client::danger::ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &rustls::pki_types::CertificateDer<'_>,
        dss: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls12_signature(message, cert, dss, &self.algorithms)
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &rustls::pki_types::CertificateDer<'_>,
        dss: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls13_signature(message, cert, dss, &self.algorithms)
    }

    fn supported_verify_schemes(&self) -> Vec<rustls::SignatureScheme> {
        self.algorithms.supported_schemes()
    }
}

fn pinned_client(expected: [u8; 32]) -> Result<reqwest13::Client, AgentFailure> {
    let provider = rustls::crypto::CryptoProvider::get_default()
        .cloned()
        .unwrap_or_else(|| Arc::new(rustls::crypto::ring::default_provider()));
    let algorithms = provider.signature_verification_algorithms;
    let verifier = Arc::new(FingerprintPin {
        expected,
        algorithms,
    });
    let config = rustls::ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .map_err(|_| AgentFailure::BadResponse("tls_client".into()))?
        .dangerous()
        .with_custom_certificate_verifier(verifier)
        .with_no_client_auth();
    reqwest13::Client::builder()
        .use_preconfigured_tls(config)
        .build()
        .map_err(|_| AgentFailure::BadResponse("tls_client".into()))
}

#[derive(Clone, Default)]
struct NodeClient;

impl ClientHandler for NodeClient {
    fn get_info(&self) -> ClientInfo {
        let mut info = ClientInfo::default();
        info.client_info.name = "veyl".into();
        info.client_info.version = env!("CARGO_PKG_VERSION").into();
        info
    }
}

/// `initialize → tools/list → tools/call`，与 `agent/src/client.rs` 的验证路径一致。
async fn run_mcp(
    ticket: &AgentTicket,
    client: reqwest13::Client,
) -> Result<RotateReport, AgentFailure> {
    let config = StreamableHttpClientTransportConfig::with_uri(ticket.endpoint.clone())
        .auth_header(ticket.token.clone());
    let transport = StreamableHttpClientTransport::with_client(client, config);
    let running = NodeClient
        .serve(transport)
        .await
        .map_err(classify_init_error)?;

    let tools = running
        .peer()
        .list_all_tools()
        .await
        .map_err(classify_service_error)?;
    if !tools.iter().any(|tool| tool.name.as_ref() == AGENT_TOOL) {
        let _ = running.cancel().await;
        return Err(AgentFailure::BadResponse(
            "agent 没有暴露 rotate_credentials".into(),
        ));
    }

    let arguments = json!({ "reason": AGENT_REASON })
        .as_object()
        .cloned()
        .unwrap_or_default();
    let call = running
        .peer()
        .call_tool(CallToolRequestParams::new(AGENT_TOOL).with_arguments(arguments))
        .await
        .map_err(classify_service_error);
    let _ = running.cancel().await;
    let result = call?;

    let text = result
        .content
        .iter()
        .find_map(|content| content.as_text().map(|text| text.text.as_str()));
    interpret_tool_output(result.is_error.unwrap_or(false), text)
}

/// agent 的回包只有两种形状（`agent/src/server.rs`）：
/// `{ok:true, port}` 与 `{ok:false, error:{kind, message}}`。
fn interpret_tool_output(is_error: bool, text: Option<&str>) -> Result<RotateReport, AgentFailure> {
    let value: Value = text
        .and_then(|text| serde_json::from_str(text).ok())
        .ok_or_else(|| AgentFailure::BadResponse("agent 回包不是 JSON".into()))?;
    let ok = value.get("ok").and_then(Value::as_bool).unwrap_or(false);
    if !ok || is_error {
        let message = value
            .get("error")
            .and_then(|error| error.get("message"))
            .and_then(Value::as_str)
            .unwrap_or("节点没有说明原因")
            .to_string();
        let retryable = value
            .get("error")
            .and_then(|error| error.get("kind"))
            .and_then(Value::as_str)
            == Some("retryable");
        return Err(AgentFailure::ToolFailed { message, retryable });
    }
    let port = value
        .get("port")
        .and_then(Value::as_u64)
        .filter(|port| (1..=65_535).contains(port))
        .ok_or_else(|| AgentFailure::BadResponse("agent 回包缺少 port".into()))?;
    Ok(RotateReport { port: port as u16 })
}

fn classify_service_error(error: ServiceError) -> AgentFailure {
    if matches!(error, ServiceError::Timeout { .. }) {
        return AgentFailure::Timeout;
    }
    match &error {
        ServiceError::TransportSend(dynamic) => classify_transport_error(dynamic),
        _ => AgentFailure::Transport(error.to_string()),
    }
}

fn classify_init_error(error: ClientInitializeError) -> AgentFailure {
    match &error {
        ClientInitializeError::TransportError { error: dynamic, .. } => {
            classify_transport_error(dynamic)
        }
        ClientInitializeError::JsonRpcError(data) => {
            AgentFailure::Transport(format!("initialize 被拒绝：{}", data.message))
        }
        _ => AgentFailure::Transport(error.to_string()),
    }
}

/// rmcp 会把底层 `StreamableHttpError` 装箱放在 `TransportSend` 里；能下转就沿
/// `source()` 找 rustls 错误（证书校验失败），不能下转时退回提示词匹配。
fn classify_transport_error(dynamic: &DynamicTransportError) -> AgentFailure {
    let chain_has_rustls = dynamic
        .error
        .downcast_ref::<StreamableHttpError<reqwest13::Error>>()
        .is_some_and(|stream_error| match stream_error {
            StreamableHttpError::Client(inner) => {
                error_chain_has_rustls(inner as &(dyn std::error::Error + 'static))
            }
            _ => false,
        });
    if chain_has_rustls
        || dynamic
            .to_string()
            .to_ascii_lowercase()
            .contains("certificate")
    {
        return AgentFailure::TlsUntrusted(dynamic.to_string());
    }

    let text = dynamic.to_string();
    if text.contains("Auth required")
        || text.contains("Insufficient scope")
        || text.contains("HTTP 401")
        || text.contains("HTTP 403")
    {
        return AgentFailure::TokenRejected;
    }
    AgentFailure::Transport(text)
}

fn error_chain_has_rustls(error: &(dyn std::error::Error + 'static)) -> bool {
    let mut current = Some(error);
    while let Some(error) = current {
        if error.downcast_ref::<rustls::Error>().is_some() {
            return true;
        }
        current = error.source();
    }
    false
}

/// 轮换成功后把新端口与密码取回本地。
///
/// 节点池只在「本地没有这台服务器的节点」时才会取凭据，轮换后行还在，
/// 自动同步不会发生；这里必须主动拉一次，否则用户要等下一次凭据同步。
#[async_trait]
trait CredentialRefresher: Send + Sync {
    async fn refresh(&self, server_id: &str) -> bool;
}

struct LiveRefresher;

#[async_trait]
impl CredentialRefresher for LiveRefresher {
    async fn refresh(&self, server_id: &str) -> bool {
        if crate::control_plane::servers::credentials(server_id)
            .await
            .is_err()
        {
            return false;
        }
        // `credentials` 已按 server_id upsert 本地节点行；这里补一次事件让界面重读。
        if let Some(server) = crate::control_plane::servers::local_server(server_id) {
            crate::control_plane::events::emit_server_changed(&server);
        }
        true
    }
}

pub struct NodeRotateCredentialsTool {
    backend: Arc<dyn RotateBackend>,
    refresher: Arc<dyn CredentialRefresher>,
}

impl NodeRotateCredentialsTool {
    pub fn new() -> Self {
        Self {
            backend: Arc::new(LiveBackend::new()),
            refresher: Arc::new(LiveRefresher),
        }
    }

    #[cfg(test)]
    fn with_parts(
        backend: Arc<dyn RotateBackend>,
        refresher: Arc<dyn CredentialRefresher>,
    ) -> Self {
        Self { backend, refresher }
    }
}

impl Default for NodeRotateCredentialsTool {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl Tool for NodeRotateCredentialsTool {
    fn name(&self) -> &str {
        TOOL_NAME
    }

    fn description(&self) -> &str {
        "只在用户明确要求重置这台服务器的节点端口或密码（例如「端口被封了，换一个」「重置节点凭据」）时调用。\
         会先弹确认卡；用户逐字选「重置」后才会让节点换端口与密码并重启，本机与手机会在下次同步后使用新值。\
         不得为了排障、提速或推测性的原因自行调用，也不要在用户没提这件事时主动建议后自己执行。\n\
         说「节点端口」「节点密码」「下次同步」，不出现 server_id、MCP、agent、令牌这些词。"
    }

    fn permission_level(&self) -> PermissionLevel {
        PermissionLevel::Execute
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "server_id": {
                    "type": "string",
                    "description": "要重置的服务器 id，取自 MyServers 的 server_id"
                }
            },
            "required": ["server_id"],
            "additionalProperties": false
        })
    }

    async fn execute(&self, input: Value, ctx: &ToolContext) -> ToolResult {
        let outcome = match self.run(input, ctx).await {
            Ok(outcome) => outcome,
            Err(error) => {
                let text = if error.code == "CANCELLED" {
                    "已取消重置"
                } else {
                    "这次没能重置节点端口"
                };
                ToolOutcome::fail(error).with_display(text, Vec::new(), Changed::None)
            }
        };
        envelope::finish(ctx, TOOL_NAME, outcome)
    }
}

impl NodeRotateCredentialsTool {
    async fn run(&self, input: Value, ctx: &ToolContext) -> Result<ToolOutcome, AivpnError> {
        let server_id = parse_server_id(&input)?;
        self.confirm(ctx).await?;
        let (report, refreshed) = self.execute_rotation(&server_id).await?;
        Ok(self.success_outcome(report, refreshed))
    }

    /// 确认之后的动作：先轮换，再主动把新凭据取回本地。
    async fn execute_rotation(&self, server_id: &str) -> Result<(RotateReport, bool), AivpnError> {
        let report = self
            .backend
            .rotate(server_id)
            .await
            .map_err(AgentFailure::into_aivpn)?;
        // 节点池不会为已存在的本地行再取凭据，所以这里主动刷一次。
        let refreshed = self.refresher.refresh(server_id).await;
        Ok((report, refreshed))
    }

    fn success_outcome(&self, report: RotateReport, refreshed: bool) -> ToolOutcome {
        let base = "节点端口与密码已重置，本机与手机将在下次同步后使用新值。";
        let summary = if refreshed {
            base.to_string()
        } else {
            format!("{base}本机凭据刷新失败，请手动刷新服务器数据。")
        };
        let mut facts = vec![format!("新端口：{}", report.port)];
        if !refreshed {
            facts.push("本机凭据刷新失败，请手动刷新服务器数据".to_string());
        }
        ToolOutcome::ok(
            summary,
            json!({ "ok": true, "port": report.port, "refreshed": refreshed }),
        )
        .with_display("节点端口与密码已重置", facts, Changed::Unknown)
    }

    /// 确认卡：默认焦点是「取消」，Esc / 关闭 / 超时都按取消处理。
    async fn confirm(&self, ctx: &ToolContext) -> Result<(), AivpnError> {
        let request_id = policy::current_request_id(&ctx.session_id)
            .ok_or_else(|| AivpnError::new("INTERNAL", "无法确定当前请求，节点没有重置"))?;
        let (tx, rx) = tokio::sync::oneshot::channel();
        questions::register_with(
            &ctx.session_id,
            &request_id,
            UserQuestionEvent {
                question: "重置这台服务器的节点端口与密码？重置会重启节点，本机与手机会在下次同步后使用新值。\n是否重置？"
                    .to_string(),
                options: Some(vec![CONFIRM_OPTION.to_string(), CANCEL_OPTION.to_string()]),
                reply_tx: tx,
            },
            Some(questions::QuestionExtras {
                kind: CONFIRM_KIND,
                details: json!({ "will_disconnect": true }),
                default_index: 1,
                target_version: None,
                artifact_sha256: None,
            }),
        );
        // 确认等待不计入 90 秒的 MCP 超时；questions 层超时后回空串。
        let answer = rx.await.unwrap_or_default();
        if answer == CONFIRM_OPTION {
            Ok(())
        } else {
            Err(AivpnError::new("CANCELLED", "用户取消了节点重置"))
        }
    }
}

/// 界面「智能修复」的执行入口：与 AI 工具共用 `execute_rotation`（含 90 秒超时与凭据刷新）。
///
/// 按钮本身就是用户确认，所以不再走确认卡；参数校验与失败 reason 与工具保持一致。
pub(crate) async fn rotate_from_ui(server_id: Option<Value>) -> Result<Value, AivpnError> {
    rotate_value(&NodeRotateCredentialsTool::new(), server_id).await
}

async fn rotate_value(
    tool: &NodeRotateCredentialsTool,
    server_id: Option<Value>,
) -> Result<Value, AivpnError> {
    let server_id = parse_server_id(&json!({ "server_id": server_id }))?;
    let (report, refreshed) = tool.execute_rotation(&server_id).await?;
    Ok(json!({ "ok": true, "port": report.port, "refreshed": refreshed }))
}

fn parse_server_id(input: &Value) -> Result<String, AivpnError> {
    let server_id = input
        .get("server_id")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if valid_server_id(server_id) {
        Ok(server_id.to_string())
    } else {
        Err(
            AivpnError::new("INVALID_ARGUMENT", "server_id 不合法，这次没有重置")
                .with_details(json!({ "reason": "invalid_server_id" })),
        )
    }
}

/// id 要拼进控制面路径：只接受 `srv_` + base64url 字符，挡住 `/` 与 `..`。
fn valid_server_id(value: &str) -> bool {
    value.len() > 4
        && value.len() <= 64
        && value.starts_with("srv_")
        && value[4..]
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}

/// 允许 `aa:bb:...` 这类分隔写法，但必须恰好 64 个十六进制字符（与 agent 同口径）。
fn parse_fingerprint(value: &str) -> Option<[u8; 32]> {
    let clean: String = value.chars().filter(|ch| ch.is_ascii_hexdigit()).collect();
    let bytes = hex::decode(clean).ok()?;
    bytes.as_slice().try_into().ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use rmcp::transport::streamable_http_client::{AuthRequiredError, InsufficientScopeError};
    use rustls::client::danger::ServerCertVerifier;

    use base64::engine::general_purpose::STANDARD as BASE64;
    use base64::Engine;

    const TEST_TOKEN: &str = "eyJhbGciOiJFZERTQSJ9.test.signature";

    /// 测试用自签 CA（EC P-256，仅用于构造客户端，不做任何真实连接）。
    const TEST_CA_PEM: &str = "-----BEGIN CERTIFICATE-----
MIIBYjCCAQigAwIBAgIUVpWV7iHzJQwd5ja53+QV7/IA350wCgYIKoZIzj0EAwIw
FzEVMBMGA1UEAwwMdmV5bC10ZXN0LWNhMB4XDTI2MTEyMTA5NTgzN1oXDTM2MTEx
ODA5NTgzN1owFzEVMBMGA1UEAwwMdmV5bC10ZXN0LWNhMFkwEwYHKoZIzj0CAQYI
KoZIzj0DAQcDQgAEQ3YISNOMWobFs5R4WJufiOOvhmJtYI/H8XjsMjldUDlgpIMF
bFOnQi86hyZXN4XFp/LznUMKGEF42IHygmYCjaMyMDAwHQYDVR0OBBYEFIVdedYX
T76/sdRMcK0rYNIaWyPPMA8GA1UdEwEB/wQFMAMBAf8wCgYIKoZIzj0EAwIDSAAw
RQIgKRu7fnqRYfmbbDwQTMY55uP7fqGikGtELEYkQqfKk0gCIQDaf+68TPGDnsFU
+oauSqq9LrOKJ2246LKGO9roDeEhbA==
-----END CERTIFICATE-----";

    fn ticket_json() -> Value {
        json!({
            "endpoint": "https://203.0.113.10:32100/mcp",
            "cert_fingerprint": "ab".repeat(32),
            "ca_pem": TEST_CA_PEM,
            "token": TEST_TOKEN,
            "key_id": "agent-2026-11",
        })
    }

    #[test]
    fn ticket_requires_https_and_a_well_formed_fingerprint() {
        let ticket = AgentTicket::parse(&ticket_json()).unwrap();
        // 端点由控制面下发（完整 MCP URL），Host 原样使用。
        assert_eq!(ticket.endpoint, "https://203.0.113.10:32100/mcp");
        assert!(ticket.ca_pem.is_some());

        // 不拼路径：不带路径的端点也不会被补成 /mcp，避免端点语义有两处定义。
        let mut origin_only = ticket_json();
        origin_only["endpoint"] = json!("https://203.0.113.10:32100");
        assert_eq!(
            AgentTicket::parse(&origin_only).unwrap().endpoint,
            "https://203.0.113.10:32100"
        );

        for (field, bad) in [
            ("endpoint", json!("http://203.0.113.10:32100")),
            ("endpoint", json!("not a url")),
            ("cert_fingerprint", json!("abc")),
            ("cert_fingerprint", json!("zz".repeat(32))),
            ("token", json!("")),
        ] {
            let mut value = ticket_json();
            value[field] = bad;
            let error = AgentTicket::parse(&value).err().expect(field);
            assert!(
                matches!(error, AgentFailure::BadResponse(ref detail) if detail == field),
                "{field}"
            );
        }
    }

    #[test]
    fn both_trust_paths_build_a_client() {
        let with_ca = AgentTicket::parse(&ticket_json()).unwrap();
        assert!(ca_client(with_ca.ca_pem.as_deref().unwrap()).is_ok());

        let mut value = ticket_json();
        value["ca_pem"] = Value::Null;
        let no_ca = AgentTicket::parse(&value).unwrap();
        assert!(no_ca.ca_pem.is_none());
        assert!(pinned_client(no_ca.fingerprint).is_ok());
    }

    #[test]
    fn a_malformed_ca_is_an_invalid_response_not_a_tls_failure() {
        match ca_client("-----BEGIN CERTIFICATE-----\nnot base64\n-----END CERTIFICATE-----") {
            Err(AgentFailure::BadResponse(detail)) => assert_eq!(detail, "ca_pem"),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn the_pin_rejects_a_certificate_with_the_wrong_fingerprint() {
        let der = BASE64
            .decode(
                TEST_CA_PEM
                    .lines()
                    .filter(|line| !line.starts_with("-----"))
                    .collect::<String>(),
            )
            .unwrap();
        let certificate = rustls::pki_types::CertificateDer::from(der);
        let actual: [u8; 32] = Sha256::digest(certificate.as_ref()).into();

        let provider = rustls::crypto::CryptoProvider::get_default()
            .cloned()
            .unwrap_or_else(|| Arc::new(rustls::crypto::ring::default_provider()));
        let server_name = rustls::pki_types::ServerName::try_from("example.test").unwrap();

        let accepted = FingerprintPin {
            expected: actual,
            algorithms: provider.signature_verification_algorithms,
        };
        assert!(accepted
            .verify_server_cert(
                &certificate,
                &[],
                &server_name,
                &[],
                rustls::pki_types::UnixTime::now(),
            )
            .is_ok());

        let mut wrong = actual;
        wrong[0] ^= 0xff;
        let rejected = FingerprintPin {
            expected: wrong,
            algorithms: provider.signature_verification_algorithms,
        };
        assert!(rejected
            .verify_server_cert(
                &certificate,
                &[],
                &server_name,
                &[],
                rustls::pki_types::UnixTime::now(),
            )
            .is_err());
    }

    fn transport_error(error: impl std::error::Error + Send + Sync + 'static) -> ServiceError {
        ServiceError::TransportSend(dynamic_error(error))
    }

    fn dynamic_error(
        error: impl std::error::Error + Send + Sync + 'static,
    ) -> DynamicTransportError {
        DynamicTransportError::from_parts("test", std::any::TypeId::of::<()>(), Box::new(error))
    }

    #[test]
    fn auth_failures_from_the_agent_map_to_token_rejected() {
        let bearer = transport_error(StreamableHttpError::<reqwest13::Error>::AuthRequired(
            AuthRequiredError::new("Bearer realm=\"veyl-node-agent\"".into()),
        ));
        assert!(matches!(
            classify_service_error(bearer),
            AgentFailure::TokenRejected
        ));

        let scope = transport_error(StreamableHttpError::<reqwest13::Error>::InsufficientScope(
            InsufficientScopeError::new("Bearer".into(), None),
        ));
        assert!(matches!(
            classify_service_error(scope),
            AgentFailure::TokenRejected
        ));

        // 没有 WWW-Authenticate 的 401 走 UnexpectedServerResponse。
        let bare = transport_error(
            StreamableHttpError::<reqwest13::Error>::UnexpectedServerResponse(
                "HTTP 401 Unauthorized: unauthorized".into(),
            ),
        );
        assert!(matches!(
            classify_service_error(bare),
            AgentFailure::TokenRejected
        ));
    }

    #[test]
    fn other_transport_failures_stay_generic() {
        let closed = transport_error(
            StreamableHttpError::<reqwest13::Error>::UnexpectedServerResponse(
                "HTTP 500: boom".into(),
            ),
        );
        match classify_service_error(closed) {
            AgentFailure::Transport(detail) => assert!(detail.contains("HTTP 500")),
            other => panic!("{other:?}"),
        }
        assert!(matches!(
            classify_service_error(ServiceError::TransportClosed),
            AgentFailure::Transport(_)
        ));
        assert!(matches!(
            classify_service_error(ServiceError::Timeout {
                // 构造用的任意值：这里只验证 `Timeout` 变体的映射，不是另一套预算。
                timeout: MCP_TIMEOUT
            }),
            AgentFailure::Timeout
        ));
    }

    #[test]
    fn a_rustls_error_in_the_chain_is_reported_as_untrusted() {
        #[derive(Debug)]
        struct Wrapped(rustls::Error);
        impl std::fmt::Display for Wrapped {
            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                self.0.fmt(f)
            }
        }
        impl std::error::Error for Wrapped {
            fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
                Some(&self.0)
            }
        }

        let untrusted = transport_error(Wrapped(rustls::Error::General(
            "invalid peer certificate".into(),
        )));
        assert!(matches!(
            classify_service_error(untrusted),
            AgentFailure::TlsUntrusted(_)
        ));
        // 无法下转时，Display 里的 certificate 字样兜底。
        let textual = transport_error(
            StreamableHttpError::<reqwest13::Error>::UnexpectedServerResponse(
                "certificate verify failed".into(),
            ),
        );
        assert!(matches!(
            classify_service_error(textual),
            AgentFailure::TlsUntrusted(_)
        ));
        assert!(!matches!(
            classify_service_error(transport_error(ServiceError::TransportClosed)),
            AgentFailure::TlsUntrusted(_)
        ));
        assert!(error_chain_has_rustls(
            &Wrapped(rustls::Error::General("chain".into())) as &(dyn std::error::Error + 'static)
        ));
        assert!(!error_chain_has_rustls(
            &std::io::Error::other("plain") as &(dyn std::error::Error + 'static)
        ));
    }

    #[test]
    fn the_agent_tool_output_is_interpreted_by_shape() {
        assert_eq!(
            interpret_tool_output(false, Some(r#"{"ok":true,"port":32101}"#)).unwrap(),
            RotateReport { port: 32101 }
        );

        match interpret_tool_output(
            true,
            Some(r#"{"ok":false,"error":{"kind":"retryable","message":"重启失败"}}"#),
        ) {
            Err(AgentFailure::ToolFailed {
                message,
                retryable: true,
            }) => assert_eq!(message, "重启失败"),
            other => panic!("{other:?}"),
        }
        match interpret_tool_output(
            true,
            Some(r#"{"ok":false,"error":{"kind":"fatal","message":"sing-box 起不来"}}"#),
        ) {
            Err(AgentFailure::ToolFailed {
                message,
                retryable: false,
            }) => assert!(message.contains("sing-box")),
            other => panic!("{other:?}"),
        }

        // is_error 为真但内容是错的：仍按工具失败处理，不当成成功。
        assert!(matches!(
            interpret_tool_output(true, Some("not json")),
            Err(AgentFailure::BadResponse(_))
        ));
        assert!(matches!(
            interpret_tool_output(false, Some(r#"{"ok":true}"#)),
            Err(AgentFailure::BadResponse(_))
        ));
        assert!(matches!(
            interpret_tool_output(false, None),
            Err(AgentFailure::BadResponse(_))
        ));
    }

    #[test]
    fn control_plane_failures_keep_their_own_code_and_reason() {
        for (code, reason, retryable) in [
            ("PRECONDITION_FAILED", "not_ready", false),
            ("PRECONDITION_FAILED", "agent_not_registered", false),
            ("INTERNAL", "agent_key_missing", false),
            ("UPSTREAM_ERROR", "network", true),
        ] {
            let error = AgentFailure::ControlPlane(CpError::new(
                code,
                "控制面拒绝了这次请求",
                retryable,
                json!({ "reason": reason }),
            ))
            .into_aivpn();
            assert_eq!(error.code, code);
            assert_eq!(error.details.as_ref().unwrap()["reason"], reason);
            assert_eq!(error.retryable, retryable);
        }

        // 没有 reason 时补一个可读的分类。
        let bare = AgentFailure::ControlPlane(CpError::new(
            "UPSTREAM_ERROR",
            "控制面暂时不可用",
            true,
            Value::Null,
        ))
        .into_aivpn();
        assert_eq!(
            bare.details.as_ref().unwrap()["reason"],
            "agent_token_unavailable"
        );
    }

    #[test]
    fn every_failure_maps_to_a_reason_the_model_can_use() {
        let cases = [
            (
                AgentFailure::TokenRejected,
                "UPSTREAM_ERROR",
                "agent_token_rejected",
            ),
            (
                AgentFailure::TlsUntrusted("bad".into()),
                "UPSTREAM_ERROR",
                "agent_tls_untrusted",
            ),
            (AgentFailure::Timeout, "TIMEOUT", "agent_timeout"),
            (
                AgentFailure::Transport("closed".into()),
                "UPSTREAM_ERROR",
                "agent_unreachable",
            ),
            (
                AgentFailure::ToolFailed {
                    message: "x".into(),
                    retryable: false,
                },
                "INTERNAL",
                "agent_tool_failed",
            ),
        ];
        for (failure, code, reason) in cases {
            let error = failure.into_aivpn();
            assert_eq!(error.code, code);
            assert_eq!(error.details.as_ref().unwrap()["reason"], reason);
        }
    }

    #[test]
    fn server_ids_that_could_escape_the_path_are_rejected() {
        for good in ["srv_abc123", "srv_A-B_c", "srv_aaaaaaaaaaaaaaaaaaaaaa"] {
            assert!(valid_server_id(good), "{good}");
        }
        for bad in [
            "",
            "srv_",
            "srv_../../evil",
            "srv_a/b",
            "srv_a.b",
            "abc123",
            "srv_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        ] {
            assert!(!valid_server_id(bad), "{bad}");
        }
        assert_eq!(
            parse_server_id(&json!({ "server_id": "srv_../../evil" }))
                .unwrap_err()
                .code,
            "INVALID_ARGUMENT"
        );
        assert_eq!(
            parse_server_id(&json!({}))
                .unwrap_err()
                .details
                .as_ref()
                .unwrap()["reason"],
            "invalid_server_id"
        );
    }

    struct FixedBackend(Result<RotateReport, AgentFailure>);

    #[async_trait]
    impl RotateBackend for FixedBackend {
        async fn rotate(&self, _server_id: &str) -> Result<RotateReport, AgentFailure> {
            match &self.0 {
                Ok(report) => Ok(report.clone()),
                Err(failure) => Err((*failure).clone()),
            }
        }
    }

    #[derive(Default)]
    struct RecordingRefresher {
        calls: std::sync::Mutex<Vec<String>>,
        result: bool,
    }

    #[async_trait]
    impl CredentialRefresher for RecordingRefresher {
        async fn refresh(&self, server_id: &str) -> bool {
            self.calls.lock().unwrap().push(server_id.to_string());
            self.result
        }
    }

    fn tool_with(
        outcome: Result<RotateReport, AgentFailure>,
        refresh: bool,
    ) -> (NodeRotateCredentialsTool, Arc<RecordingRefresher>) {
        let refresher = Arc::new(RecordingRefresher {
            result: refresh,
            ..Default::default()
        });
        let tool = NodeRotateCredentialsTool::with_parts(
            Arc::new(FixedBackend(outcome)),
            refresher.clone(),
        );
        (tool, refresher)
    }

    #[tokio::test]
    async fn a_successful_rotation_refreshes_the_credentials_once() {
        let (tool, refresher) = tool_with(Ok(RotateReport { port: 32101 }), true);
        // 确认卡由 questions 注册表驱动，这里直接测确认之后的动作。
        let (report, refreshed) = tool.execute_rotation("srv_abc123").await.unwrap();
        assert_eq!(report.port, 32101);
        assert!(refreshed);
        assert_eq!(*refresher.calls.lock().unwrap(), vec!["srv_abc123"]);

        let outcome = tool.success_outcome(report, refreshed);
        assert_eq!(
            outcome.data.unwrap(),
            json!({ "ok": true, "port": 32101, "refreshed": true })
        );
        assert!(outcome.summary.contains("下次同步"));
        assert!(
            !outcome.summary.contains("重新导入") && !outcome.summary.contains("重新同步配置"),
            "成功文案不能引用产品里不存在的动作：{}",
            outcome.summary
        );
    }

    #[tokio::test]
    async fn a_failed_local_refresh_is_reported_without_hiding_success() {
        let (tool, refresher) = tool_with(Ok(RotateReport { port: 32101 }), false);
        let (report, refreshed) = tool.execute_rotation("srv_abc123").await.unwrap();
        assert!(!refreshed);
        assert_eq!(refresher.calls.lock().unwrap().len(), 1);

        let outcome = tool.success_outcome(report, refreshed);
        assert_eq!(outcome.data.unwrap()["refreshed"], false);
        assert!(outcome
            .summary
            .contains("本机凭据刷新失败，请手动刷新服务器数据"));
        assert!(outcome
            .display
            .facts
            .iter()
            .any(|fact| fact.contains("本机凭据刷新失败")));
    }

    #[tokio::test]
    async fn a_failed_rotation_does_not_touch_the_local_credentials() {
        let (tool, refresher) = tool_with(Err(AgentFailure::Timeout), true);
        let error = tool.execute_rotation("srv_abc123").await.unwrap_err();
        assert_eq!(error.code, "TIMEOUT");
        assert!(refresher.calls.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn the_ui_entry_returns_port_and_refresh_flag() {
        let (tool, refresher) = tool_with(Ok(RotateReport { port: 32101 }), true);
        let value = rotate_value(&tool, Some(json!("srv_abc123")))
            .await
            .unwrap();
        assert_eq!(
            value,
            json!({ "ok": true, "port": 32101, "refreshed": true })
        );
        // 返回体只有这三个字段：没有令牌、没有密码。
        assert_eq!(value.as_object().unwrap().len(), 3);
        assert_eq!(*refresher.calls.lock().unwrap(), vec!["srv_abc123"]);
    }

    #[tokio::test]
    async fn the_ui_entry_passes_every_failure_reason_through() {
        let cases = [
            (
                AgentFailure::ControlPlane(CpError::new(
                    "PRECONDITION_FAILED",
                    "还没准备好",
                    false,
                    json!({ "reason": "not_ready" }),
                )),
                "PRECONDITION_FAILED",
                "not_ready",
            ),
            (
                AgentFailure::TlsUntrusted("x".into()),
                "UPSTREAM_ERROR",
                "agent_tls_untrusted",
            ),
            (
                AgentFailure::TokenRejected,
                "UPSTREAM_ERROR",
                "agent_token_rejected",
            ),
            (AgentFailure::Timeout, "TIMEOUT", "agent_timeout"),
            (
                AgentFailure::Transport("closed".into()),
                "UPSTREAM_ERROR",
                "agent_unreachable",
            ),
            (
                AgentFailure::ToolFailed {
                    message: "重启失败".into(),
                    retryable: true,
                },
                "INTERNAL",
                "agent_tool_failed",
            ),
            (
                AgentFailure::BadResponse("x".into()),
                "INTERNAL",
                "agent_bad_response",
            ),
        ];
        for (failure, code, reason) in cases {
            let (tool, refresher) = tool_with(Err(failure), true);
            let error = rotate_value(&tool, Some(json!("srv_abc123")))
                .await
                .unwrap_err();
            assert_eq!(error.code, code, "{reason}");
            assert_eq!(
                error.details.as_ref().unwrap()["reason"],
                reason,
                "{reason}"
            );
            assert!(
                refresher.calls.lock().unwrap().is_empty(),
                "{reason}：失败时不刷新本地凭据"
            );
        }
    }

    #[tokio::test]
    async fn an_invalid_server_id_never_reaches_the_backend() {
        let (tool, refresher) = tool_with(Ok(RotateReport { port: 32101 }), true);
        for input in [
            None,
            Some(json!("")),
            Some(json!("srv_../../evil")),
            Some(json!("srv_a/b")),
            Some(json!(42)),
        ] {
            let error = rotate_value(&tool, input.clone()).await.unwrap_err();
            assert_eq!(error.code, "INVALID_ARGUMENT", "{input:?}");
            assert_eq!(
                error.details.as_ref().unwrap()["reason"],
                "invalid_server_id",
                "{input:?}"
            );
        }
        // 非法参数在发请求之前就被拒：轮换与刷新一次都没发生。
        assert!(refresher.calls.lock().unwrap().is_empty());
    }

    #[derive(Default)]
    struct RecordingRunner {
        calls: std::sync::Mutex<Vec<(String, TrustMode)>>,
        fail: Option<TrustMode>,
    }

    #[async_trait]
    impl McpRunner for RecordingRunner {
        async fn rotate(
            &self,
            ticket: &AgentTicket,
            trust: TrustMode,
        ) -> Result<RotateReport, AgentFailure> {
            self.calls
                .lock()
                .unwrap()
                .push((ticket.endpoint.clone(), trust));
            if self.fail == Some(trust) {
                return Err(AgentFailure::TlsUntrusted("证书校验失败".into()));
            }
            Ok(RotateReport { port: 32101 })
        }
    }

    struct FixedTickets(AgentTicket);

    #[async_trait]
    impl TicketSource for FixedTickets {
        async fn fetch(&self, _server_id: &str) -> Result<AgentTicket, AgentFailure> {
            Ok(self.0.clone())
        }
    }

    async fn run_live_with(
        ticket: AgentTicket,
        runner: Arc<RecordingRunner>,
    ) -> Result<RotateReport, AgentFailure> {
        LiveBackend {
            tickets: Arc::new(FixedTickets(ticket)),
            runner,
        }
        .rotate("srv_abc123")
        .await
    }

    #[tokio::test]
    async fn a_ca_failure_retries_the_same_ticket_with_the_fingerprint() {
        let ticket = AgentTicket::parse(&ticket_json()).unwrap();
        let runner = Arc::new(RecordingRunner {
            fail: Some(TrustMode::Ca),
            ..Default::default()
        });
        let report = run_live_with(ticket, runner.clone()).await.unwrap();
        assert_eq!(report.port, 32101);

        let calls = runner.calls.lock().unwrap();
        assert_eq!(calls.len(), 2, "CA 失败后必须再试一次");
        assert_eq!(calls[0].0, calls[1].0, "两次必须用同一张票（令牌一次性）");
        assert_eq!(calls[0].1, TrustMode::Ca);
        assert_eq!(calls[1].1, TrustMode::Fingerprint);
    }

    #[tokio::test]
    async fn without_a_ca_the_fingerprint_failure_is_final() {
        let mut value = ticket_json();
        value["ca_pem"] = Value::Null;
        let ticket = AgentTicket::parse(&value).unwrap();
        let runner = Arc::new(RecordingRunner {
            fail: Some(TrustMode::Fingerprint),
            ..Default::default()
        });
        let error = run_live_with(ticket, runner.clone()).await.unwrap_err();
        assert!(matches!(error, AgentFailure::TlsUntrusted(_)));
        let calls = runner.calls.lock().unwrap();
        assert_eq!(calls.len(), 1, "没有 CA 时没有可回退的路径");
        assert_eq!(calls[0].1, TrustMode::Fingerprint);
    }

    #[tokio::test(start_paused = true)]
    async fn the_mcp_flow_times_out_after_ninety_seconds() {
        // start_paused 下虚拟时间自动前进：90 秒超时必须先于 120 秒的慢任务触发。
        let slow = async {
            tokio::time::sleep(Duration::from_secs(120)).await;
            Ok::<_, AgentFailure>(RotateReport { port: 32101 })
        };
        let outcome = tokio::time::timeout(MCP_TIMEOUT, slow).await;
        assert!(matches!(outcome, Err(_)));
        assert_eq!(MCP_TIMEOUT, Duration::from_secs(90));
        assert!(matches!(
            AgentFailure::Timeout.into_aivpn().code.as_str(),
            "TIMEOUT"
        ));
    }
}
