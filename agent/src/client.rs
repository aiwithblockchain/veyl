//! The desktop side: an rmcp Streamable HTTP client with an injected reqwest
//! client, so a self-signed node certificate can be trusted by CA or pinned by
//! SHA-256 fingerprint. Mirrors `scripts/dev/tls-probe/` exactly.

use std::path::Path;
use std::sync::Arc;

use anyhow::{bail, Context, Result};
use rmcp::model::{CallToolRequestParams, ClientInfo};
use rmcp::transport::streamable_http_client::StreamableHttpClientTransportConfig;
use rmcp::transport::StreamableHttpClientTransport;
use rmcp::{ClientHandler, ServiceExt};
use rustls::pki_types::CertificateDer;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::cert;

pub fn default_client() -> reqwest::Client {
    reqwest::Client::new()
}

pub fn root_client(ca: &Path) -> Result<reqwest::Client> {
    let pem = std::fs::read(ca).with_context(|| format!("read {}", ca.display()))?;
    let cert = reqwest::Certificate::from_pem(&pem).context("parse CA certificate")?;
    reqwest::Client::builder()
        .add_root_certificate(cert)
        .build()
        .context("build reqwest client with extra root")
}

/// Normal webpki validation against the supplied CA, plus a hard SHA-256 pin on
/// the leaf certificate.
#[derive(Debug)]
struct PinnedVerifier {
    expected: [u8; 32],
    inner: Arc<rustls::client::WebPkiServerVerifier>,
}

impl rustls::client::danger::ServerCertVerifier for PinnedVerifier {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        intermediates: &[CertificateDer<'_>],
        server_name: &rustls::pki_types::ServerName<'_>,
        ocsp_response: &[u8],
        now: rustls::pki_types::UnixTime,
    ) -> Result<rustls::client::danger::ServerCertVerified, rustls::Error> {
        let got = Sha256::digest(end_entity.as_ref());
        if got.as_slice() != &self.expected[..] {
            return Err(rustls::Error::General(format!(
                "certificate pin mismatch: got {}, expected {}",
                cert::hex(got.as_slice()),
                cert::hex(&self.expected),
            )));
        }
        self.inner
            .verify_server_cert(end_entity, intermediates, server_name, ocsp_response, now)
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        self.inner.verify_tls12_signature(message, cert, dss)
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        self.inner.verify_tls13_signature(message, cert, dss)
    }

    fn supported_verify_schemes(&self) -> Vec<rustls::SignatureScheme> {
        self.inner.supported_verify_schemes()
    }
}

pub fn pinned_client(ca: &Path, expected: [u8; 32]) -> Result<reqwest::Client> {
    let mut roots = rustls::RootCertStore::empty();
    for cert in cert::load_certs(ca)? {
        roots.add(cert).context("add CA to root store")?;
    }
    let inner = rustls::client::WebPkiServerVerifier::builder(Arc::new(roots))
        .build()
        .map_err(|e| anyhow::anyhow!("build webpki verifier: {e}"))?;
    let verifier = Arc::new(PinnedVerifier { expected, inner });
    let cfg = rustls::ClientConfig::builder()
        .dangerous()
        .with_custom_certificate_verifier(verifier)
        .with_no_client_auth();
    reqwest::Client::builder()
        .use_preconfigured_tls(cfg)
        .build()
        .context("build reqwest client with pinned verifier")
}

#[derive(Clone, Default)]
struct AgentClient;

impl ClientHandler for AgentClient {
    fn get_info(&self) -> ClientInfo {
        ClientInfo::default()
    }
}

#[derive(Debug, Default)]
pub struct SessionOutcome {
    pub tools: Vec<String>,
    pub tool_result: Option<Value>,
}

/// Full MCP flow: `initialize -> tools/list -> (tools/call)`.
pub async fn run_session(
    url: &str,
    client: reqwest::Client,
    token: Option<&str>,
    call_tool: bool,
) -> Result<SessionOutcome> {
    let mut cfg = StreamableHttpClientTransportConfig::with_uri(url.to_string());
    if let Some(token) = token {
        cfg = cfg.auth_header(token);
    }
    let transport = StreamableHttpClientTransport::with_client(client, cfg);
    let running = AgentClient
        .serve(transport)
        .await
        .map_err(|e| anyhow::anyhow!("initialize failed: {e}"))?;

    let tools = running
        .peer()
        .list_all_tools()
        .await
        .map_err(|e| anyhow::anyhow!("tools/list failed: {e}"))?
        .into_iter()
        .map(|t| t.name.to_string())
        .collect::<Vec<_>>();

    let mut outcome = SessionOutcome {
        tools,
        tool_result: None,
    };

    if call_tool {
        let params = CallToolRequestParams::new("rotate_credentials")
            .with_arguments(json!({ "reason": "user" }).as_object().cloned().unwrap_or_default());
        let result = running
            .peer()
            .call_tool(params)
            .await
            .map_err(|e| anyhow::anyhow!("tools/call failed: {e}"))?;
        let text = result.content.iter().find_map(|c| c.as_text().map(|t| t.text.clone()));
        let parsed = text
            .as_deref()
            .and_then(|t| serde_json::from_str::<Value>(t).ok());
        if parsed.is_none() && result.is_error == Some(true) {
            bail!("tool returned is_error: {text:?}");
        }
        outcome.tool_result = parsed;
    }

    let _ = running.cancel().await;
    Ok(outcome)
}

/// Raw JSON-RPC POST, used only for diagnostics: rmcp swallows the HTTP status
/// and body, and the demo wants to print the 401 reason verbatim.
pub async fn raw_tool_call(
    client: &reqwest::Client,
    url: &str,
    token: Option<&str>,
) -> Result<(u16, String)> {
    let body = json!({
        "jsonrpc": "2.0",
        "id": 77,
        "method": "tools/call",
        "params": { "name": "rotate_credentials", "arguments": { "reason": "user" } }
    });
    let mut req = client
        .post(url)
        .header("content-type", "application/json")
        .header("accept", "application/json, text/event-stream");
    if let Some(token) = token {
        req = req.bearer_auth(token);
    }
    let resp = req.json(&body).send().await?;
    let status = resp.status().as_u16();
    let text = resp.text().await.unwrap_or_default();
    Ok((status, text))
}

/// A plain GET to surface the underlying TLS error text (rmcp hides it).
pub async fn tls_diag(client: &reqwest::Client, url: &str) -> String {
    match client.get(url).send().await {
        Ok(resp) => format!("HTTP {}", resp.status()),
        Err(e) => format!("{:#}", anyhow::Error::new(e)),
    }
}
