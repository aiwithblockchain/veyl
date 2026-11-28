//! MCP Streamable HTTP server behind tokio-rustls, with a bearer-token gate in
//! front of *every* request (including `initialize`) and three tools:
//! `rotate_credentials`, `upgrade_singbox` and the read-only `get_status`.

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
use crate::traffic::MeteringView;

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
    /// The metering module's read-only view, supplied at construction. `None`
    /// means it was never attached (the dev `serve` command); `get_status`
    /// reports that as `metering_attached: false`, never as "healthy".
    metering: Option<Arc<dyn MeteringView>>,
}

impl ServerState {
    pub fn new(
        auth: Arc<AuthState>,
        rotator: Arc<dyn Rotator>,
        identity: Arc<Identity>,
        metering: Option<Arc<dyn MeteringView>>,
    ) -> Arc<Self> {
        Arc::new(Self {
            auth,
            executions: AtomicU64::new(0),
            last_result: std::sync::Mutex::new(None),
            rotator,
            identity,
            metering,
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
            .with_instructions("Veyl node agent: rotate_credentials, upgrade_singbox, get_status")
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
        let status_schema = json!({
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
            Tool::new(
                "get_status",
                "Read this agent's metering state and in-memory error table. Takes no arguments and changes nothing.",
                status_schema.as_object().cloned().unwrap_or_default(),
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
        let name = request.name.as_ref();

        // A purely local read: no control-plane round trip, so it still answers
        // when the control plane is down, and it cannot be delayed by one.
        if name == "get_status" {
            let view = self.state.metering.as_deref();
            return Ok(self.success(status_payload(view, &self.state.identity)));
        }

        // Heal an `active` report that never landed before doing anything else.
        // Bounded: a control plane that accepts the connection and never answers
        // must not eat the tool call's own budget.
        if tokio::time::timeout(REANNOUNCE_BUDGET, self.state.rotator.reannounce_active())
            .await
            .is_err()
        {
            tracing::warn!("active re-announce timed out; continuing with the tool call");
        }

        match name {
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

/// Body of `get_status`. Takes the view directly so it can be exercised without
/// a live server (no auth, TLS or rotator).
///
/// `uptime_secs` is not optional: the health table is cleared by a restart, so
/// without it an empty table reads as "always healthy".
///
/// `cert` is null until the leaf came from the current root: a legacy
/// self-signed node must not advertise its own expiry (`agent-health.md` §3.3).
fn status_payload(metering: Option<&dyn MeteringView>, identity: &Identity) -> Value {
    let metering_json = match metering.and_then(|view| view.status()) {
        Some(status) => json!({
            "counter_last": status.state.counter_last,
            "pending_bytes": status.state.pending_bytes,
            "seq": status.state.seq,
            "last_read_at": status.state.last_read_at,
            // "Not reported at all" is an incident too; without this only a
            // counter read can be judged.
            "last_ok_at": status.state.last_ok_at,
            "consecutive_read_failures": status.state.consecutive_read_failures,
            // false = restored from the state file because no read succeeded
            // since this process started; the numbers are the last known ones.
            "observed": status.observed,
        }),
        None => Value::Null,
    };
    let mut health = serde_json::Map::new();
    if let Some(view) = metering {
        for (key, entry) in view.health().entries() {
            health.insert(
                key.as_str().to_string(),
                json!({
                    "count": entry.count,
                    "last_at": entry.last_at,
                    "last_error": entry.last_error,
                    "last_ok_at": entry.last_ok_at,
                }),
            );
        }
    }
    let cert_state = identity.cert_state();
    let cert = identity.cert_not_after().map(|not_after| {
        json!({
            "not_after": not_after,
            "renewal_failures": identity.renewal_failures(),
            "last_renewal_error": identity.last_renewal_error(),
        })
    });
    json!({
        "version": env!("CARGO_PKG_VERSION"),
        "uptime_secs": crate::uptime_secs(),
        // Absolute times are only meaningful next to the clock that produced
        // them; the ops platform must not have to guess the node's.
        "now": crate::auth::now_unix(),
        // Distinguishes "the module is not attached" (dev only) from "attached
        // but nothing read yet" (a cold node). Both have `metering: null`, and
        // without this flag the first would read as an all-green dashboard.
        "metering_attached": metering.is_some(),
        "metering": metering_json,
        // current / legacy / broken: `cert: null` alone cannot say which.
        "cert_state": cert_state.as_str(),
        "cert": cert,
        "health": health,
    })
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

    fn identity_for_status(name: &str) -> (std::path::PathBuf, Identity) {
        let dir = std::env::temp_dir().join(format!(
            "veyl-agent-status-{name}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .subsec_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let identity = Identity::load(&dir, &[], None).unwrap();
        (dir, identity)
    }

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
    async fn a_replaced_leaf_is_served_on_the_next_connection() {
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
        // Dev certs stand in for a control-plane install.
        cert::ensure_dev_certs(&dir, &[]).unwrap();
        let identity = std::sync::Arc::new(Identity::load(&dir, &[], None).unwrap());
        let mut cache = TlsAcceptorCache::new(identity.clone()).unwrap();

        let before = accept_once(&mut cache).await;
        cert::generate_with_hosts(&dir, &["203.0.113.7".to_string()]).unwrap();
        identity.reload().unwrap();
        let after = accept_once(&mut cache).await;

        assert_ne!(before, after, "the replaced leaf must be used");
        assert_eq!(after, identity.leaf_fingerprint());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn get_status_reports_metering_and_the_health_table() {
        use crate::config::TrafficConfig;
        use crate::control::{ControlApi, ControlError, DesiredState, ReportRequest};
        use crate::test_support::FakeHost;
        use crate::traffic::{MeteringView, TrafficMeter};
        use async_trait::async_trait;

        struct SilentControl;

        #[async_trait]
        impl ControlApi for SilentControl {
            async fn report(&self, _body: &ReportRequest) -> Result<(), ControlError> {
                Ok(())
            }

            async fn desired_state(&self) -> Result<DesiredState, ControlError> {
                Err(ControlError::Transport("not used in this test".into()))
            }

            async fn traffic(&self, _seq: u64, _delta_bytes: u64) -> Result<(), ControlError> {
                Ok(())
            }
        }

        let host = Arc::new(FakeHost::new());
        host.set_command_output(
            "ip",
            0,
            "default via 10.0.0.1 dev ens3 proto dhcp src 10.0.0.5 metric 100\n",
            "",
        );
        host.queue_command_outputs(
            "nft",
            &[
                (1, "", "Operation not permitted"),
                // The table exists, so the read is `Broken`, not `Missing`.
                (
                    0,
                    r#"{"nftables":[{"metainfo":{"version":"1.0.9"}},{"table":{"family":"inet","name":"veyl_meter"}}]}"#,
                    "",
                ),
                (
                    0,
                    r#"{"nftables":[{"metainfo":{"version":"1.0.9"}},{"rule":{"family":"inet","table":"veyl_meter","chain":"out","expr":[{"match":{"op":"==","left":{"meta":{"key":"oifname"}},"right":"ens3"}},{"counter":{"packets":7,"bytes":4096}}]}}]}"#,
                    "",
                ),
            ],
        );

        let meter = Arc::new(TrafficMeter::new(
            host.clone(),
            Arc::new(SilentControl),
            std::env::temp_dir().join(format!("veyl-agent-status-{}.json", std::process::id())),
            TrafficConfig::default(),
        ));
        let view: Arc<dyn MeteringView> = meter.clone();
        let (status_dir, identity) = identity_for_status("metering");

        // A cold node whose very first read fails has no state to report, but
        // the failure itself must be visible.
        meter.tick(1_000).await;
        let body = status_payload(Some(view.as_ref()), &identity);
        assert_eq!(body["version"], env!("CARGO_PKG_VERSION"));
        assert_eq!(body["metering_attached"], true);
        assert!(
            body["uptime_secs"].as_u64().is_some(),
            "the table is cleared by a restart; uptime says how long it covers"
        );
        assert!(body["metering"].is_null(), "nothing was read yet");
        assert_eq!(body["health"]["nft_read"]["count"], 1);
        assert_eq!(body["health"]["nft_read"]["last_at"], 1_000);
        assert!(body["health"]["nft_read"]["last_error"]
            .as_str()
            .unwrap()
            .contains("Operation not permitted"));
        assert_eq!(
            body["health"]["report"]["count"], 0,
            "a wired key is reported with count 0 when it has not failed"
        );
        assert!(
            body["health"].get("singbox_apply").is_none(),
            "an unwired key must be absent: a zeroed entry would be a false green light"
        );

        // The next window reads fine: the metering block appears and the run of
        // failures is cleared.
        meter.tick(1_030).await;
        let body = status_payload(Some(view.as_ref()), &identity);
        assert_eq!(body["metering"]["counter_last"], 4_096);
        assert_eq!(body["metering"]["pending_bytes"], 0);
        assert!(body["metering"]["seq"].as_u64().is_some());
        assert_eq!(body["metering"]["last_read_at"], 1_030);
        assert_eq!(body["metering"]["last_ok_at"], 1_030);
        assert_eq!(body["metering"]["observed"], true);
        assert_eq!(body["metering"]["consecutive_read_failures"], 0);
        // The recovery clears the failure evidence for that key.
        assert_eq!(body["health"]["nft_read"]["count"], 0);
        assert_eq!(body["health"]["nft_read"]["last_at"], 0);
        assert_eq!(body["health"]["nft_read"]["last_error"], "");
        assert_eq!(body["health"]["nft_read"]["last_ok_at"], 1_030);
        std::fs::remove_dir_all(&status_dir).ok();
    }

    #[test]
    fn get_status_distinguishes_an_unattached_meter() {
        let (dir, identity) = identity_for_status("unattached");
        let body = status_payload(None, &identity);
        assert_eq!(body["metering_attached"], false);
        assert!(body["metering"].is_null());
        assert_eq!(
            body["health"],
            json!({}),
            "no module means no health claims"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn get_status_reports_cert_state_after_the_root_signed_the_leaf() {
        let (dir, _) = identity_for_status("cert");
        cert::ensure_dev_certs(&dir, &[]).unwrap();
        let identity = Identity::load(&dir, &[], None).unwrap();

        let body = status_payload(None, &identity);
        assert_eq!(body["cert_state"], "current");
        let not_after = body["cert"]["not_after"]
            .as_i64()
            .expect("a signed leaf has an expiry");
        assert!(not_after > 0);
        assert_eq!(body["cert"]["renewal_failures"], 0);
        assert!(body["cert"]["last_renewal_error"].is_null());

        identity.record_renewal_failure("control plane unreachable");
        let body = status_payload(None, &identity);
        assert_eq!(body["cert"]["renewal_failures"], 1);
        assert_eq!(
            body["cert"]["last_renewal_error"],
            "control plane unreachable"
        );

        identity.record_renewal_success();
        let body = status_payload(None, &identity);
        assert_eq!(body["cert"]["renewal_failures"], 0);
        assert!(body["cert"]["last_renewal_error"].is_null());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_node_without_a_current_marker_reports_no_cert_block() {
        let (dir, _) = identity_for_status("no-marker");
        cert::ensure_dev_certs(&dir, &[]).unwrap();

        // A marker from another root is not this node's certificate.
        std::fs::write(
            cert::paths(&dir).leaf_meta,
            r#"{"root_fingerprint":"nope","not_after":1955000000}"#,
        )
        .unwrap();
        let identity = Identity::load(&dir, &[], None).unwrap();
        assert!(
            status_payload(None, &identity)["cert"].is_null(),
            "an expiry from an unknown root must not be advertised"
        );
        assert_eq!(status_payload(None, &identity)["cert_state"], "stale");

        std::fs::remove_file(cert::paths(&dir).leaf_meta).unwrap();
        assert!(
            status_payload(None, &identity)["cert"].is_null(),
            "a node without a current marker has no cert block"
        );
        assert_eq!(status_payload(None, &identity)["cert_state"], "stale");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn get_status_carries_the_node_clock() {
        let (dir, _) = identity_for_status("clock");
        let identity = Identity::load(&dir, &[], None).unwrap();
        let before = crate::auth::now_unix();
        let body = status_payload(None, &identity);
        let after = crate::auth::now_unix();

        let now = body["now"].as_u64().expect("now is always present");
        assert!(
            now >= before && now <= after,
            "absolute times must come with the clock that produced them"
        );
        std::fs::remove_dir_all(&dir).ok();
    }
}
