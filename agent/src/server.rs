//! MCP Streamable HTTP server behind tokio-rustls, with a bearer-token gate in
//! front of *every* request (including `initialize`) and one tool.

use std::net::SocketAddr;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

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
use crate::rotation::Rotator;

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
            .with_instructions("Veyl node agent: rotate_credentials only")
    }

    async fn list_tools(
        &self,
        _request: Option<PaginatedRequestParams>,
        _context: RequestContext<RoleServer>,
    ) -> Result<ListToolsResult, ErrorData> {
        let schema = json!({
            "type": "object",
            "properties": {
                "reason": { "type": "string", "enum": ["blocked", "user"] }
            }
        });
        let tool = Tool::new(
            "rotate_credentials",
            "Rotate this node's Shadowsocks port and password, then report the new values.",
            schema.as_object().cloned().unwrap_or_default(),
        );
        Ok(ListToolsResult {
            meta: None,
            next_cursor: None,
            tools: vec![tool],
        })
    }

    async fn call_tool(
        &self,
        request: CallToolRequestParams,
        _context: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        let reason = request
            .arguments
            .as_ref()
            .and_then(|a| a.get("reason"))
            .and_then(|v| v.as_str())
            .map(str::to_string);
        self.state.executions.fetch_add(1, Ordering::SeqCst);

        match self.state.rotator.rotate(reason).await {
            Ok(port) => {
                let body = json!({ "ok": true, "port": port });
                *self.state.last_result.lock().expect("last_result poisoned") = Some(body.clone());
                Ok(CallToolResult::success(vec![Content::text(body.to_string())]))
            }
            Err(e) => {
                let body = json!({
                    "ok": false,
                    "error": {
                        "kind": e.kind,
                        "message": e.public_message(),
                    }
                });
                *self.state.last_result.lock().expect("last_result poisoned") = Some(body.clone());
                Ok(CallToolResult::error(vec![Content::text(body.to_string())]))
            }
        }
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

/// Runs before the MCP service: verifies the token on every request, and
/// consumes the jti exactly when a `tools/call` is about to reach the handler.
async fn auth_gate(
    State(state): State<Arc<ServerState>>,
    req: Request<Body>,
    next: Next,
) -> Response {
    // rmcp's static Host check is disabled; this one follows the dynamic
    // allow-list (it can learn the public IP after startup).
    if !state
        .identity
        .host_allowed(req.headers().get(header::HOST).and_then(|v| v.to_str().ok()))
    {
        return reject_host();
    }

    let token = req
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "));
    let Some(token) = token else {
        return reject(AuthError::Missing);
    };
    let payload = match state.auth.verify(token) {
        Ok(p) => p,
        Err(e) => return reject(e),
    };

    let (parts, body) = req.into_parts();
    let bytes: Bytes = match axum::body::to_bytes(body, 1 << 20).await {
        Ok(b) => b,
        Err(_) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({ "error": "unreadable request body" })),
            )
                .into_response()
        }
    };

    let tool_calls = count_tool_calls(&bytes).unwrap_or(0);
    if tool_calls > 1 {
        // One token authorizes at most one tool execution; a batch with several
        // tools/call would execute them all under a single jti.
        return reject_batch();
    }
    if tool_calls == 1 {
        if let Err(e) = state.auth.consume_jti(&payload) {
            return reject(e);
        }
    }

    next.run(Request::from_parts(parts, Body::from(bytes))).await
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
    let certs = state.identity.certs().clone();
    let certs_der: Vec<CertificateDer<'static>> = cert::load_certs(&certs.leaf_cert)?;
    let key = cert::load_key(&certs.leaf_key)?;
    let tls = rustls::ServerConfig::builder()
        .with_no_client_auth()
        .with_single_cert(certs_der, key)
        .context("build rustls server config")?;
    let acceptor = TlsAcceptor::from(Arc::new(tls));

    let addr = listener.local_addr()?;
    let router = mcp_router(state);

    println!("TLS MCP server listening on https://{addr}/mcp");
    loop {
        tokio::select! {
            _ = ct.cancelled() => break,
            accepted = listener.accept() => {
                let (tcp, _peer) = accepted?;
                let acceptor = acceptor.clone();
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
                                eprintln!("connection error: {e}");
                            }
                        }
                        Err(e) => eprintln!("TLS accept error: {e}"),
                    }
                });
            }
        }
    }
    Ok(())
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
}
