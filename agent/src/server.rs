//! MCP Streamable HTTP server behind tokio-rustls, with a bearer-token gate in
//! front of *every* request (including `initialize`) and two tools:
//! `rotate_credentials` and `upgrade_singbox`.

use std::net::SocketAddr;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result};
use axum::body::{Body, Bytes};
use axum::extract::State;
use axum::http::{header, Request, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::{Json, Router};
use hyper_util::rt::{TokioExecutor, TokioIo};
use hyper_util::server::conn::auto;
use hyper_util::service::TowerToHyperService;
use rmcp::model::{
    CallToolRequestParams, CallToolResult, Content, ErrorData, ListToolsResult,
    PaginatedRequestParams, ServerCapabilities, ServerInfo, Tool,
};
use rmcp::service::RequestContext;
use rmcp::transport::streamable_http_server::session::local::LocalSessionManager;
use rmcp::transport::streamable_http_server::{StreamableHttpServerConfig, StreamableHttpService};
use rmcp::{RoleServer, ServerHandler};
use rustls::pki_types::CertificateDer;
use serde_json::{json, Value};
use tokio::net::TcpListener;
use tokio_rustls::TlsAcceptor;
use tokio_util::sync::CancellationToken;

use crate::auth::{AuthError, AuthState};
use crate::cert;
use crate::identity::Identity;
use crate::rotation::{RotateError, Rotator};

/// Bound on the `active` re-announcement that runs before every tool call, so a
/// dead control plane cannot delay the call itself.
const REANNOUNCE_BUDGET: Duration = Duration::from_secs(5);

/// Everything the tool handler can observe, plus what the demo asserts on.
pub struct ServerState {
    pub auth: Arc<AuthState>,
    /// Number of times the tool body actually ran (auth passed).
    pub executions: AtomicU64,
    /// Last tool result returned, for the demo to print.
    pub last_result: std::sync::Mutex<Option<Value>>,
    pub rotator: Arc<dyn Rotator>,
    /// Leaf/CA and the dynamic Host allow-list.
    pub identity: Arc<Identity>,
}

impl ServerState {
    pub fn new(
        auth: Arc<AuthState>,
        rotator: Arc<dyn Rotator>,
        identity: Arc<Identity>,
    ) -> Arc<Self> {
        Arc::new(Self {
            auth,
            executions: AtomicU64::new(0),
            last_result: std::sync::Mutex::new(None),
            rotator,
            identity,
        })
    }
}

#[derive(Clone)]
struct NodeAgentServer {
    state: Arc<ServerState>,
}

impl ServerHandler for NodeAgentServer {
    fn get_info(&self) -> ServerInfo {
        ServerInfo::new(ServerCapabilities::builder().enable_tools().build())
            .with_instructions("Veyl node agent: rotate_credentials, upgrade_singbox")
    }

    async fn list_tools(
        &self,
        _request: Option<PaginatedRequestParams>,
        _context: RequestContext<RoleServer>,
    ) -> Result<ListToolsResult, ErrorData> {
        let rotate_schema = json!({
            "type": "object",
            "properties": {
                "reason": { "type": "string", "enum": ["blocked", "user"] }
            }
        });
        // No arguments on purpose: a caller that could name a version, URL or
        // checksum could install anything on the node.
        let upgrade_schema = json!({
            "type": "object",
            "properties": {},
            "additionalProperties": false
        });
        let tools = vec![
            Tool::new(
                "rotate_credentials",
                "Rotate this node's Shadowsocks port and password, then report the new values.",
                rotate_schema.as_object().cloned().unwrap_or_default(),
            ),
            Tool::new(
                "upgrade_singbox",
                "Install the sing-box version the control plane currently ships, then restart and self-check. Takes no arguments.",
                upgrade_schema.as_object().cloned().unwrap_or_default(),
            ),
        ];
        Ok(ListToolsResult {
            meta: None,
            next_cursor: None,
            tools,
        })
    }

    async fn call_tool(
        &self,
        request: CallToolRequestParams,
        _context: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        self.state.executions.fetch_add(1, Ordering::SeqCst);

        // Heal an `active` report that never landed before doing anything else.
        // Bounded: a control plane that accepts the connection and never answers
        // must not eat the tool call's own budget.
        if tokio::time::timeout(REANNOUNCE_BUDGET, self.state.rotator.reannounce_active())
            .await
            .is_err()
        {
            tracing::warn!("active re-announce timed out; continuing with the tool call");
        }

        match request.name.as_ref() {
            "rotate_credentials" => {
                let reason = request
                    .arguments
                    .as_ref()
                    .and_then(|a| a.get("reason"))
                    .and_then(|v| v.as_str())
                    .map(str::to_string);
                match self.state.rotator.rotate(reason).await {
                    Ok(port) => {
                        let body = json!({ "ok": true, "port": port });
                        Ok(self.success(body))
                    }
                    Err(e) => Ok(self.failure(&e)),
                }
            }
            // `request.arguments` is deliberately ignored: the target comes from
            // the agent's own server token, never from the caller.
            "upgrade_singbox" => match self.state.rotator.upgrade_singbox().await {
                Ok(outcome) => {
                    let body = json!({
                        "installed": outcome.installed,
                        "target": outcome.target,
                        "upgraded": outcome.upgraded,
                    });
                    Ok(self.success(body))
                }
                Err(e) => Ok(self.failure(&e)),
            },
            other => Err(ErrorData::invalid_params(
                format!("unknown tool: {other}"),
                None,
            )),
        }
    }
}

impl NodeAgentServer {
    fn success(&self, body: Value) -> CallToolResult {
        *self.state.last_result.lock().expect("last_result poisoned") = Some(body.clone());
        CallToolResult::success(vec![Content::text(body.to_string())])
    }

    fn failure(&self, e: &RotateError) -> CallToolResult {
        let mut error = json!({
            "kind": e.kind,
            "message": e.public_message(),
        });
        // Only `agent_busy` carries one today; the desktop needs it to tell
        // "another operation is running" from any other retryable failure.
        if let Some(reason) = e.reason {
            error["reason"] = json!(reason);
        }
        let body = json!({ "ok": false, "error": error });
        *self.state.last_result.lock().expect("last_result poisoned") = Some(body.clone());
        CallToolResult::error(vec![Content::text(body.to_string())])
    }
}

/// Number of `tools/call` messages in a JSON-RPC body. Batches are counted too,
/// so an array cannot smuggle a tool call past the jti gate. Non-JSON returns
/// `Err`, and the caller lets the MCP service produce the protocol error.
pub fn count_tool_calls(bytes: &[u8]) -> Result<usize, ()> {
    let value: Value = serde_json::from_slice(bytes).map_err(|_| ())?;
    let is_tool_call = |v: &Value| v.get("method").and_then(|m| m.as_str()) == Some("tools/call");
    Ok(match value {
        Value::Array(items) => items.iter().filter(|v| is_tool_call(v)).count(),
        Value::Object(obj) => usize::from(
            obj.get("method").and_then(|m| m.as_str()) == Some("tools/call"),
        ),
        _ => 0,
    })
}

fn reject_host() -> Response {
    (
        StatusCode::FORBIDDEN,
        Json(json!({ "error": "host_not_allowed" })),
    )
        .into_response()
}

fn reject_batch() -> Response {
    (
        StatusCode::BAD_REQUEST,
        Json(json!({ "error": "batch_tool_calls_rejected" })),
    )
        .into_response()
}

fn reject(err: AuthError) -> Response {
    let body = Json(json!({
        "error": "unauthorized",
        "reason": err.code(),
    }));
    let mut resp = (StatusCode::UNAUTHORIZED, body).into_response();
    resp.headers_mut().insert(
        header::WWW_AUTHENTICATE,
        "Bearer realm=\"veyl-node-agent\"".parse().unwrap(),
    );
    resp
}

/// Method and tool name of a JSON-RPC body, for request logging. Batches keep
/// every method; the tool is the first `params.name`.
fn jsonrpc_call_summary(bytes: &[u8]) -> (String, String) {
    let Ok(value) = serde_json::from_slice::<Value>(bytes) else {
        return ("<unparsed>".to_string(), String::new());
    };
    let method_of = |v: &Value| {
        v.get("method")
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_default()
    };
    let tool_of = |v: &Value| {
        v.get("params")
            .and_then(|p| p.get("name"))
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_default()
    };
    match value {
        Value::Array(items) => {
            let methods: Vec<String> = items.iter().map(method_of).filter(|m| !m.is_empty()).collect();
            let tool = items.iter().find_map(|v| {
                let t = tool_of(v);
                (!t.is_empty()).then_some(t)
            });
            (methods.join(","), tool.unwrap_or_default())
        }
        Value::Object(obj) => {
            let method = obj
                .get("method")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            let tool = obj
                .get("params")
                .and_then(|p| p.get("name"))
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            (method, tool)
        }
        _ => (String::new(), String::new()),
    }
}

/// Runs before the MCP service: verifies the token on every request, and
/// consumes the jti exactly when a `tools/call` is about to reach the handler.
async fn auth_gate(
    State(state): State<Arc<ServerState>>,
    req: Request<Body>,
    next: Next,
) -> Response {
    let started = std::time::Instant::now();
    let host = req
        .headers()
        .get(header::HOST)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();

    // rmcp's static Host check is disabled; this one follows the dynamic
    // allow-list (it can learn the public IP after startup).
    if !state.identity.host_allowed((!host.is_empty()).then_some(host.as_str())) {
        tracing::warn!(
            host = %host,
            method = "-",
            decision = "rejected",
            reason = "host_not_allowed",
            elapsed_ms = started.elapsed().as_millis(),
            "mcp request"
        );
        return reject_host();
    }

    let token = req
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "));
    let Some(token) = token else {
        tracing::warn!(
            method = "-",
            decision = "rejected",
            reason = AuthError::Missing.code(),
            elapsed_ms = started.elapsed().as_millis(),
            "mcp request"
        );
        return reject(AuthError::Missing);
    };
    let payload = match state.auth.verify(token) {
        Ok(p) => p,
        Err(e) => {
            let reason = e.code();
            tracing::warn!(
                method = "-",
                decision = "rejected",
                reason,
                elapsed_ms = started.elapsed().as_millis(),
                "mcp request"
            );
            return reject(e);
        }
    };

    let (parts, body) = req.into_parts();
    let bytes: Bytes = match axum::body::to_bytes(body, 1 << 20).await {
        Ok(b) => b,
        Err(_) => {
            tracing::warn!(
                method = "-",
                decision = "rejected",
                reason = "unreadable_body",
                elapsed_ms = started.elapsed().as_millis(),
                "mcp request"
            );
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({ "error": "unreadable request body" })),
            )
                .into_response();
        }
    };
    let (method, tool) = jsonrpc_call_summary(&bytes);
    let tool = if tool.is_empty() { "-".to_string() } else { tool };

    let tool_calls = count_tool_calls(&bytes).unwrap_or(0);
    if tool_calls > 1 {
        // One token authorizes at most one tool execution; a batch with several
        // tools/call would execute them all under a single jti.
        tracing::warn!(
            method = %method,
            tool = %tool,
            tool_calls,
            decision = "rejected",
            reason = "batch_tool_calls_rejected",
            elapsed_ms = started.elapsed().as_millis(),
            "mcp request"
        );
        return reject_batch();
    }
    if tool_calls == 1 {
        if let Err(e) = state.auth.consume_jti(&payload) {
            let reason = e.code();
            tracing::warn!(
                method = %method,
                tool = %tool,
                decision = "rejected",
                reason,
                elapsed_ms = started.elapsed().as_millis(),
                "mcp request"
            );
            return reject(e);
        }
    }

    let resp = next.run(Request::from_parts(parts, Body::from(bytes))).await;
    tracing::info!(
        method = %method,
        tool = %tool,
        decision = "allowed",
        status = resp.status().as_u16(),
        elapsed_ms = started.elapsed().as_millis(),
        "mcp request"
    );
    resp
}

pub fn mcp_router(state: Arc<ServerState>) -> Router {
    let factory_state = state.clone();
    let config = StreamableHttpServerConfig::default()
        // Stateless + JSON: one POST per JSON-RPC message, no SSE, no session
        // bookkeeping. Host checks live in `auth_gate` instead.
        .with_stateful_mode(false)
        .with_json_response(true)
        .with_sse_keep_alive(None)
        .disable_allowed_hosts();
    let service: StreamableHttpService<NodeAgentServer, LocalSessionManager> =
        StreamableHttpService::new(
            move || {
                Ok(NodeAgentServer {
                    state: factory_state.clone(),
                })
            },
            Default::default(),
            config,
        );

    Router::new()
        .nest_service("/mcp", service)
        .layer(middleware::from_fn_with_state(state, auth_gate))
}

pub async fn serve(
    listener: TcpListener,
    state: Arc<ServerState>,
    ct: CancellationToken,
) -> Result<()> {
    let mut acceptors = TlsAcceptorCache::new(state.identity.clone())?;
    let addr = listener.local_addr()?;
    let router = mcp_router(state);

    tracing::info!(addr = %addr, "TLS MCP server listening");
    loop {
        tokio::select! {
            _ = ct.cancelled() => break,
            accepted = listener.accept() => {
                let (tcp, _peer) = accepted?;
                // The poll loop can re-sign the leaf (public IP discovered
                // later). Pick up the new certificate before the next
                // handshake instead of serving the old one until restart.
                let acceptor = match acceptors.acceptor() {
                    Ok(acceptor) => acceptor,
                    Err(e) => {
                        tracing::error!(error = %e, "failed to reload the TLS certificate");
                        continue;
                    }
                };
                let router = router.clone();
                tokio::spawn(async move {
                    match acceptor.accept(tcp).await {
                        Ok(stream) => {
                            let io = TokioIo::new(stream);
                            let svc = TowerToHyperService::new(router);
                            if let Err(e) = auto::Builder::new(TokioExecutor::new())
                                .serve_connection_with_upgrades(io, svc)
                                .await
                            {
                                tracing::warn!(error = %e, "connection error");
                            }
                        }
                        Err(e) => tracing::warn!(error = %e, "TLS accept error"),
                    }
                });
            }
        }
    }
    Ok(())
}

/// Rebuilds the rustls acceptor when the identity's leaf fingerprint changes.
struct TlsAcceptorCache {
    identity: Arc<Identity>,
    cached: Option<(String, TlsAcceptor)>,
}

impl TlsAcceptorCache {
    fn new(identity: Arc<Identity>) -> Result<Self> {
        Ok(Self {
            identity,
            cached: None,
        })
    }

    fn acceptor(&mut self) -> Result<TlsAcceptor> {
        let fingerprint = self.identity.leaf_fingerprint();
        if let Some((cached_fp, acceptor)) = &self.cached {
            if *cached_fp == fingerprint {
                return Ok(acceptor.clone());
            }
        }
        let acceptor = build_acceptor(&self.identity)?;
        tracing::info!(fingerprint = %fingerprint, "serving the current TLS certificate");
        self.cached = Some((fingerprint, acceptor.clone()));
        Ok(acceptor)
    }
}

fn build_acceptor(identity: &Identity) -> Result<TlsAcceptor> {
    let certs = identity.certs().clone();
    let certs_der: Vec<CertificateDer<'static>> = cert::load_certs(&certs.leaf_cert)?;
    let key = cert::load_key(&certs.leaf_key)?;
    let tls = rustls::ServerConfig::builder()
        .with_no_client_auth()
        .with_single_cert(certs_der, key)
        .context("build rustls server config")?;
    Ok(TlsAcceptor::from(Arc::new(tls)))
}

pub async fn bind(addr: SocketAddr) -> Result<TcpListener> {
    TcpListener::bind(addr)
        .await
        .with_context(|| format!("bind {addr}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counts_tool_calls_in_single_and_batch_bodies() {
        assert_eq!(
            count_tool_calls(br#"{"jsonrpc":"2.0","id":1,"method":"tools/call"}"#).unwrap(),
            1
        );
        assert_eq!(
            count_tool_calls(br#"{"jsonrpc":"2.0","method":"tools/list"}"#).unwrap(),
            0
        );
        let batch = br#"[
            {"jsonrpc":"2.0","method":"tools/call"},
            {"jsonrpc":"2.0","method":"tools/call"}
        ]"#;
        assert_eq!(count_tool_calls(batch).unwrap(), 2);
        let mixed = br#"[
            {"jsonrpc":"2.0","method":"tools/call"},
            {"jsonrpc":"2.0","method":"initialize"}
        ]"#;
        assert_eq!(count_tool_calls(mixed).unwrap(), 1);
        assert_eq!(count_tool_calls(b"not json"), Err(()));
        assert_eq!(count_tool_calls(b"42").unwrap(), 0);
    }

    #[test]
    fn call_summary_reports_method_and_tool() {        let (method, tool) = jsonrpc_call_summary(
            br#"{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"rotate_credentials","arguments":{}}}"#,
        );
        assert_eq!(method, "tools/call");
        assert_eq!(tool, "rotate_credentials");

        let (method, tool) =
            jsonrpc_call_summary(br#"{"jsonrpc":"2.0","id":1,"method":"initialize"}"#);
        assert_eq!(method, "initialize");
        assert!(tool.is_empty());

        let (method, _) = jsonrpc_call_summary(br#"not json"#);
        assert_eq!(method, "<unparsed>");
    }

    #[derive(Debug)]
    struct CaptureCert(std::sync::Arc<std::sync::Mutex<Vec<Vec<u8>>>>);

    impl rustls::client::danger::ServerCertVerifier for CaptureCert {
        fn verify_server_cert(
            &self,
            end_entity: &rustls::pki_types::CertificateDer<'_>,
            _intermediates: &[rustls::pki_types::CertificateDer<'_>],
            _server_name: &rustls::pki_types::ServerName<'_>,
            _ocsp_response: &[u8],
            _now: rustls::pki_types::UnixTime,
        ) -> std::result::Result<
            rustls::client::danger::ServerCertVerified,
            rustls::Error,
        > {
            self.0.lock().unwrap().push(end_entity.as_ref().to_vec());
            Ok(rustls::client::danger::ServerCertVerified::assertion())
        }

        fn verify_tls12_signature(
            &self,
            _message: &[u8],
            _cert: &rustls::pki_types::CertificateDer<'_>,
            _dss: &rustls::DigitallySignedStruct,
        ) -> std::result::Result<
            rustls::client::danger::HandshakeSignatureValid,
            rustls::Error,
        > {
            Ok(rustls::client::danger::HandshakeSignatureValid::assertion())
        }

        fn verify_tls13_signature(
            &self,
            _message: &[u8],
            _cert: &rustls::pki_types::CertificateDer<'_>,
            _dss: &rustls::DigitallySignedStruct,
        ) -> std::result::Result<
            rustls::client::danger::HandshakeSignatureValid,
            rustls::Error,
        > {
            Ok(rustls::client::danger::HandshakeSignatureValid::assertion())
        }

        fn supported_verify_schemes(&self) -> Vec<rustls::SignatureScheme> {
            rustls::crypto::ring::default_provider()
                .signature_verification_algorithms
                .supported_schemes()
        }
    }

    /// One TLS handshake through the cache's current acceptor; returns the
    /// SHA-256 of the certificate the client saw.
    async fn accept_once(cache: &mut TlsAcceptorCache) -> String {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let acceptor = cache.acceptor().unwrap();
        let server = tokio::spawn(async move {
            let (tcp, _) = listener.accept().await.unwrap();
            let _ = acceptor.accept(tcp).await.unwrap();
        });

        let seen = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let config = rustls::ClientConfig::builder()
            .dangerous()
            .with_custom_certificate_verifier(std::sync::Arc::new(CaptureCert(seen.clone())))
            .with_no_client_auth();
        let connector = tokio_rustls::TlsConnector::from(std::sync::Arc::new(config));
        let tcp = tokio::net::TcpStream::connect(addr).await.unwrap();
        let name = rustls::pki_types::ServerName::try_from("localhost").unwrap();
        let _tls = connector.connect(name, tcp).await.unwrap();
        server.await.unwrap();
        let der = seen.lock().unwrap().pop().expect("client saw a certificate");
        cert::sha256_hex(&der)
    }

    #[tokio::test]
    async fn a_resigned_leaf_is_served_on_the_next_connection() {
        crate::init_crypto_provider();
        let dir = std::env::temp_dir().join(format!(
            "veyl-agent-tls-reload-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .subsec_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let identity = std::sync::Arc::new(Identity::load(&dir, &[], None).unwrap());
        let mut cache = TlsAcceptorCache::new(identity.clone()).unwrap();

        let before = accept_once(&mut cache).await;
        assert!(identity.set_public_host("203.0.113.7").unwrap());
        let after = accept_once(&mut cache).await;

        assert_ne!(before, after, "the re-signed leaf must be used");
        assert_eq!(after, identity.leaf_fingerprint());
        std::fs::remove_dir_all(&dir).ok();
    }
}
