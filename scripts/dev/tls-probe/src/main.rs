//! TLS trust probe for rmcp's Streamable HTTP client — the same transport
//! claurst uses (`claurst-mcp` -> `RmcpClientBackend::connect_http` ->
//! `StreamableHttpClientTransport::from_config`).
//!
//! The binary:
//!   1. generates a throwaway CA + server cert with `openssl`,
//!   2. serves a minimal MCP server (only `tools/list` / `tools/call`) over HTTPS,
//!   3. tries four trust modes against it, and
//!   4. reports which ones are possible without changing claurst.
//!
//! Run `cargo run -- run-all` for the full matrix.

use std::future::Future;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{bail, Context, Result};
use axum::Router;
use base64::Engine as _;
use clap::{Parser, Subcommand, ValueEnum};
use hyper_util::rt::{TokioExecutor, TokioIo};
use hyper_util::server::conn::auto;
use hyper_util::service::TowerToHyperService;
use rmcp::model::{
    CallToolRequestParams, CallToolResult, ClientInfo, Content, ErrorData, ListToolsResult,
    PaginatedRequestParams, ServerCapabilities, ServerInfo, Tool,
};
use rmcp::service::RequestContext;
use rmcp::transport::streamable_http_client::StreamableHttpClientTransportConfig;
use rmcp::transport::streamable_http_server::session::local::LocalSessionManager;
use rmcp::transport::streamable_http_server::{
    StreamableHttpServerConfig, StreamableHttpService,
};
use rmcp::transport::StreamableHttpClientTransport;
use rmcp::{ClientHandler, RoleServer, ServerHandler, ServiceExt};
use rustls::pki_types::{
    CertificateDer, PrivateKeyDer, PrivatePkcs1KeyDer, PrivatePkcs8KeyDer, PrivateSec1KeyDer,
};
use sha2::{Digest, Sha256};
use tokio::net::TcpListener;
use tokio_rustls::TlsAcceptor;
use tokio_util::sync::CancellationToken;

// ---------------------------------------------------------------------------
// Minimal MCP server: one tool, enough for initialize / tools/list / tools/call
// ---------------------------------------------------------------------------

#[derive(Clone, Default)]
struct ProbeServer;

impl ServerHandler for ProbeServer {
    fn get_info(&self) -> ServerInfo {
        ServerInfo::new(ServerCapabilities::builder().enable_tools().build())
            .with_instructions("Veyl TLS probe: one tool")
    }

    async fn list_tools(
        &self,
        _request: Option<PaginatedRequestParams>,
        _context: RequestContext<RoleServer>,
    ) -> Result<ListToolsResult, ErrorData> {
        let schema = serde_json::json!({
            "type": "object",
            "properties": { "server_id": { "type": "string" } },
            "required": ["server_id"]
        });
        let tool = Tool::new(
            "rotate_credentials",
            "Probe-only: pretend to rotate the Shadowsocks port and password.",
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
        let server_id = request
            .arguments
            .as_ref()
            .and_then(|a| a.get("server_id"))
            .cloned();
        let body = serde_json::json!({
            "server_id": server_id,
            "new_port": 28443,
            "new_password": "probe-secret",
        });
        Ok(CallToolResult::success(vec![Content::text(
            body.to_string(),
        )]))
    }
}

#[derive(Clone, Default)]
struct ProbeClient;

impl ClientHandler for ProbeClient {
    fn get_info(&self) -> ClientInfo {
        ClientInfo::default()
    }
}

// ---------------------------------------------------------------------------
// HTTPS server: axum Router (rmcp StreamableHttpService) behind tokio-rustls
// ---------------------------------------------------------------------------

async fn serve_tls(
    listener: TcpListener,
    cert: PathBuf,
    key: PathBuf,
    ct: CancellationToken,
) -> Result<()> {
    let certs = load_certs(&cert)?;
    let key = load_key(&key)?;
    let tls = rustls::ServerConfig::builder()
        .with_no_client_auth()
        .with_single_cert(certs, key)
        .context("build rustls server config")?;
    let acceptor = TlsAcceptor::from(Arc::new(tls));

    let addr = listener.local_addr()?;
    let service: StreamableHttpService<ProbeServer, LocalSessionManager> =
        StreamableHttpService::new(
            || Ok(ProbeServer),
            Default::default(),
            StreamableHttpServerConfig::default()
                // Stateless + JSON avoids SSE and session bookkeeping; both are
                // irrelevant to the TLS question.
                .with_stateful_mode(false)
                .with_json_response(true)
                .with_sse_keep_alive(None)
                .with_allowed_hosts(vec![
                    "127.0.0.1".to_string(),
                    "localhost".to_string(),
                    format!("127.0.0.1:{}", addr.port()),
                ])
                .with_cancellation_token(ct.child_token()),
        );
    let router = Router::new().nest_service("/mcp", service);

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

// ---------------------------------------------------------------------------
// Client probes
// ---------------------------------------------------------------------------

/// Reproduces claurst's exact HTTP transport construction:
/// `StreamableHttpClientTransport::from_config(cfg)` (no custom reqwest client).
/// With `Some(client)` it takes the injection path rmcp offers via
/// `StreamableHttpClientTransport::with_client`.
async fn probe(url: &str, client: Option<reqwest::Client>) -> Result<Vec<Tool>> {
    let cfg = StreamableHttpClientTransportConfig::with_uri(url.to_string());
    let transport: StreamableHttpClientTransport<reqwest::Client> = match client {
        Some(client) => StreamableHttpClientTransport::with_client(client, cfg),
        None => StreamableHttpClientTransport::from_config(cfg),
    };
    let running = ProbeClient
        .serve(transport)
        .await
        .map_err(|e| anyhow::Error::new(e).context("initialize failed"))?;
    let tools = running
        .peer()
        .list_all_tools()
        .await
        .map_err(|e| anyhow::Error::new(e).context("tools/list failed"))?;
    let _ = running.cancel().await;
    Ok(tools)
}

fn root_client(ca: &Path) -> Result<reqwest::Client> {
    let pem = std::fs::read(ca).with_context(|| format!("read {}", ca.display()))?;
    let cert = reqwest::Certificate::from_pem(&pem).context("parse CA certificate")?;
    reqwest::Client::builder()
        .add_root_certificate(cert)
        .build()
        .context("build reqwest client with extra root")
}

/// A verifier that checks the leaf certificate's SHA-256 before delegating to
/// the normal webpki path (which validates the chain against the supplied CA).
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
                hex(got.as_slice()),
                hex(&self.expected),
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

fn pinned_client(ca: &Path, expected: [u8; 32]) -> Result<reqwest::Client> {
    let mut roots = rustls::RootCertStore::empty();
    for cert in load_certs(ca)? {
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

// ---------------------------------------------------------------------------
// Throwaway certs (openssl CLI)
// ---------------------------------------------------------------------------

struct CertPaths {
    ca_cert: PathBuf,
    leaf_cert: PathBuf,
    leaf_key: PathBuf,
}

fn run_openssl(args: &[&str]) -> Result<()> {
    let bin = std::env::var("OPENSSL").unwrap_or_else(|_| "openssl".to_string());
    let out = std::process::Command::new(&bin)
        .args(args)
        .output()
        .with_context(|| format!("run `{bin} {}`", args.join(" ")))?;
    if !out.status.success() {
        bail!(
            "`{bin} {}` failed:\n{}",
            args.join(" "),
            String::from_utf8_lossy(&out.stderr)
        );
    }
    Ok(())
}

fn gen_certs(dir: &Path) -> Result<CertPaths> {
    std::fs::create_dir_all(dir)?;
    let ca_key = dir.join("ca-key.pem");
    let ca_cert = dir.join("ca-cert.pem");
    let leaf_key = dir.join("server-key.pem");
    let leaf_csr = dir.join("server.csr");
    let leaf_cert = dir.join("server-cert.pem");
    let ext = dir.join("server-ext.cnf");

    std::fs::write(
        &ext,
        "subjectAltName=IP:127.0.0.1,DNS:localhost\n\
         basicConstraints=critical,CA:FALSE\n\
         keyUsage=critical,digitalSignature,keyEncipherment\n\
         extendedKeyUsage=serverAuth\n",
    )?;

    let s = |p: &Path| p.to_string_lossy().to_string();

    run_openssl(&[
        "req", "-x509", "-newkey", "rsa:2048", "-sha256", "-days", "2", "-nodes",
        "-keyout", &s(&ca_key), "-out", &s(&ca_cert),
        "-subj", "/CN=Veyl TLS Probe CA",
        "-addext", "basicConstraints=critical,CA:TRUE",
        "-addext", "keyUsage=critical,keyCertSign,cRLSign",
    ])?;
    run_openssl(&[
        "req", "-newkey", "rsa:2048", "-sha256", "-nodes",
        "-keyout", &s(&leaf_key), "-out", &s(&leaf_csr),
        "-subj", "/CN=veyl-mcp-probe",
    ])?;
    run_openssl(&[
        "x509", "-req", "-in", &s(&leaf_csr),
        "-CA", &s(&ca_cert), "-CAkey", &s(&ca_key),
        "-CAcreateserial", "-days", "2", "-sha256",
        "-out", &s(&leaf_cert), "-extfile", &s(&ext),
    ])?;

    Ok(CertPaths {
        ca_cert,
        leaf_cert,
        leaf_key,
    })
}

// ---------------------------------------------------------------------------
// PEM / hex helpers
// ---------------------------------------------------------------------------

fn pem_blocks(text: &str, label: &str) -> Result<Vec<Vec<u8>>> {
    let begin = format!("-----BEGIN {label}-----");
    let end = format!("-----END {label}-----");
    let mut out = Vec::new();
    let mut rest = text;
    while let Some(i) = rest.find(&begin) {
        let after = &rest[i + begin.len()..];
        let Some(j) = after.find(&end) else { break };
        let b64: String = after[..j].chars().filter(|c| !c.is_whitespace()).collect();
        out.push(
            base64::engine::general_purpose::STANDARD
                .decode(b64)
                .context("decode PEM base64")?,
        );
        rest = &after[j + end.len()..];
    }
    Ok(out)
}

fn load_certs(path: &Path) -> Result<Vec<CertificateDer<'static>>> {
    let text =
        std::fs::read_to_string(path).with_context(|| format!("read {}", path.display()))?;
    let blocks = pem_blocks(&text, "CERTIFICATE")?;
    if blocks.is_empty() {
        bail!("no CERTIFICATE block in {}", path.display());
    }
    Ok(blocks.into_iter().map(CertificateDer::from).collect())
}

fn load_key(path: &Path) -> Result<PrivateKeyDer<'static>> {
    let text =
        std::fs::read_to_string(path).with_context(|| format!("read {}", path.display()))?;
    for (label, wrap) in [
        (
            "PRIVATE KEY",
            true, // PKCS#8, what `openssl req -newkey ... -nodes` writes
        ),
        ("RSA PRIVATE KEY", false),
        ("EC PRIVATE KEY", false),
    ] {
        if let Some(der) = pem_blocks(&text, label)?.into_iter().next() {
            return if wrap {
                Ok(PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(der)))
            } else if label == "RSA PRIVATE KEY" {
                Ok(PrivateKeyDer::Pkcs1(PrivatePkcs1KeyDer::from(der)))
            } else {
                Ok(PrivateKeyDer::Sec1(PrivateSec1KeyDer::from(der)))
            };
        }
    }
    bail!("no private key in {}", path.display())
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn sha256_hex(bytes: &[u8]) -> String {
    hex(Sha256::digest(bytes).as_slice())
}

fn parse_hex(s: &str) -> Result<[u8; 32]> {
    let clean: String = s.chars().filter(|c| c.is_ascii_hexdigit()).collect();
    if clean.len() != 64 {
        bail!("fingerprint must be 64 hex chars (32 bytes), got {}", clean.len());
    }
    let mut out = [0u8; 32];
    for (i, byte) in out.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&clean[i * 2..i * 2 + 2], 16)?;
    }
    Ok(out)
}

// ---------------------------------------------------------------------------
// run-all
// ---------------------------------------------------------------------------

struct Report {
    label: &'static str,
    ok: bool,
    detail: String,
}

fn report(label: &'static str, r: Result<Vec<Tool>>) -> Report {
    match r {
        Ok(tools) => Report {
            label,
            ok: true,
            detail: format!(
                "tools={:?}",
                tools.iter().map(|t| t.name.as_ref()).collect::<Vec<_>>()
            ),
        },
        Err(e) => Report {
            label,
            ok: false,
            detail: format!("{e:?}"),
        },
    }
}

/// A raw request through a given reqwest client, so the TLS cause is visible
/// (rmcp's ServiceError hides the underlying reqwest/rustls error).
async fn tls_diag(client: &reqwest::Client, url: &str) -> String {
    match client.get(url).send().await {
        Ok(resp) => format!("HTTP {}", resp.status()),
        Err(e) => format!("{:#}", anyhow::Error::new(e)),
    }
}

async fn timed(fut: impl Future<Output = Result<Vec<Tool>>>) -> Result<Vec<Tool>> {
    match tokio::time::timeout(Duration::from_secs(15), fut).await {
        Ok(r) => r,
        Err(_) => bail!("timed out after 15s"),
    }
}

async fn run_all(out: PathBuf) -> Result<()> {
    let paths = gen_certs(&out)?;
    let leaf_der = load_certs(&paths.leaf_cert)?
        .into_iter()
        .next()
        .context("leaf cert")?;
    let fingerprint = sha256_hex(leaf_der.as_ref());
    println!("cert dir: {}", out.display());
    println!("leaf SHA-256: {fingerprint}\n");

    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let addr = listener.local_addr()?;
    let ct = CancellationToken::new();
    let server = tokio::spawn(serve_tls(
        listener,
        paths.leaf_cert.clone(),
        paths.leaf_key.clone(),
        ct.clone(),
    ));
    let url = format!("https://{addr}/mcp");
    tokio::time::sleep(Duration::from_millis(150)).await;

    let default_reqwest = reqwest::Client::new();
    let root_reqwest = root_client(&paths.ca_cert)?;
    let pin_ok_reqwest = pinned_client(&paths.ca_cert, parse_hex(&fingerprint)?)?;
    let mut wrong = parse_hex(&fingerprint)?;
    wrong[0] ^= 0xff;
    let pin_bad_reqwest = pinned_client(&paths.ca_cert, wrong)?;

    // rmcp wraps the transport error and drops the cause; a raw request through
    // the same clients shows it. (The server also logs the TLS alert.)
    let diag_default = tls_diag(&default_reqwest, &url).await;
    let diag_pin_bad = tls_diag(&pin_bad_reqwest, &url).await;
    println!("TLS diagnostics (raw GET):");
    println!("  default:   {diag_default}");
    println!("  root:      {}", tls_diag(&root_reqwest, &url).await);
    println!("  pin ok:    {}", tls_diag(&pin_ok_reqwest, &url).await);
    println!("  pin wrong: {diag_pin_bad}\n");

    // 1. claurst's exact path: no way to add a root or pin.
    let default = report(
        "1. default (rmcp from_config, no custom trust)",
        timed(probe(&url, None)).await,
    );

    // 2. Custom root CA via reqwest.
    let root = report(
        "2. custom root CA (add_root_certificate)",
        timed(probe(&url, Some(root_reqwest.clone()))).await,
    );

    // 3. Fingerprint pin, correct.
    let pin_ok = report(
        "3. fingerprint pin (correct SHA-256)",
        timed(probe(&url, Some(pin_ok_reqwest.clone()))).await,
    );

    // 4. Fingerprint pin, wrong.
    let pin_bad = report(
        "4. fingerprint pin (wrong SHA-256)",
        timed(probe(&url, Some(pin_bad_reqwest.clone()))).await,
    );

    ct.cancel();
    let _ = server.await;

    let reports = [default, root, pin_ok, pin_bad];
    println!("\n=== results ===");
    for r in &reports {
        println!(
            "{:<50} {:<5} {}",
            r.label,
            if r.ok { "OK" } else { "FAIL" },
            r.detail
        );
    }

    let default_err = diag_default.to_ascii_lowercase();
    let default_is_cert_error = !reports[0].ok
        && (default_err.contains("certificate")
            || default_err.contains("unknownissuer")
            || default_err.contains("unknown ca")
            || default_err.contains("tls"));
    let wrong_pin_err = diag_pin_bad.to_ascii_lowercase();
    let wrong_pin_rejected = !reports[3].ok
        && (wrong_pin_err.contains("pin mismatch")
            || wrong_pin_err.contains("certificate")
            || wrong_pin_err.contains("handshake"));

    println!("\n=== assertions ===");
    println!("default fails on TLS:            {}", yes(default_is_cert_error));
    println!("custom root succeeds:            {}", yes(reports[1].ok));
    println!("correct pin succeeds:            {}", yes(reports[2].ok));
    println!("wrong pin rejected:              {}", yes(wrong_pin_rejected));

    if default_is_cert_error && reports[1].ok && reports[2].ok && wrong_pin_rejected {
        println!(
            "\nPASS: rmcp 1.8 exposes with_client; a Veyl-owned rmcp client can pin a \
             self-signed node agent. claurst's McpClient::connect uses from_config and cannot."
        );
        Ok(())
    } else {
        bail!("one or more expectations failed; see the table above");
    }
}

fn yes(b: bool) -> &'static str {
    if b {
        "yes"
    } else {
        "NO"
    }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

#[derive(Parser)]
#[command(
    about = "Probe TLS trust options for rmcp's Streamable HTTP client (the transport claurst uses)"
)]
struct Cli {
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// Generate a throwaway CA + server certificate with openssl.
    GenCerts {
        #[arg(long, default_value = "target/tls-probe-certs")]
        out: PathBuf,
    },
    /// Run an HTTPS MCP server (initialize / tools/list / tools/call only).
    Server {
        #[arg(long)]
        cert: PathBuf,
        #[arg(long)]
        key: PathBuf,
        #[arg(long, default_value = "127.0.0.1:8443")]
        addr: SocketAddr,
    },
    /// Connect once with the selected trust mode and print the tool list.
    Probe {
        #[arg(long)]
        url: String,
        #[arg(long, value_enum)]
        mode: Mode,
        /// CA certificate PEM (required for `root` and `pin`).
        #[arg(long)]
        ca: Option<PathBuf>,
        /// Leaf certificate SHA-256, hex (required for `pin`).
        #[arg(long)]
        fingerprint: Option<String>,
    },
    /// Generate certs, start the server, and run all four checks.
    RunAll {
        #[arg(long, default_value = "target/tls-probe-certs")]
        out: PathBuf,
    },
}

#[derive(Clone, Copy, ValueEnum)]
enum Mode {
    Default,
    Root,
    Pin,
}

#[tokio::main]
async fn main() -> Result<()> {
    // reqwest is compiled with `rustls-no-provider`; install a process provider
    // before building any client (reqwest panics otherwise).
    let _ = rustls::crypto::ring::default_provider().install_default();

    match Cli::parse().cmd {
        Cmd::GenCerts { out } => {
            let p = gen_certs(&out)?;
            println!("CA:     {}", p.ca_cert.display());
            println!("leaf:   {}", p.leaf_cert.display());
            println!("key:    {}", p.leaf_key.display());
            let der = load_certs(&p.leaf_cert)?
                .into_iter()
                .next()
                .context("leaf cert")?;
            println!("SHA-256: {}", sha256_hex(der.as_ref()));
            Ok(())
        }
        Cmd::Server { cert, key, addr } => {
            let listener = TcpListener::bind(addr).await?;
            serve_tls(listener, cert, key, CancellationToken::new()).await
        }
        Cmd::Probe {
            url,
            mode,
            ca,
            fingerprint,
        } => {
            let client = match mode {
                Mode::Default => None,
                Mode::Root => Some(root_client(ca.as_deref().context("--ca is required")?)?),
                Mode::Pin => {
                    let ca = ca.as_deref().context("--ca is required")?;
                    let fp = parse_hex(
                        fingerprint
                            .as_deref()
                            .context("--fingerprint is required")?,
                    )?;
                    Some(pinned_client(ca, fp)?)
                }
            };
            let tools = timed(probe(&url, client)).await?;
            println!(
                "OK: {} tool(s): {:?}",
                tools.len(),
                tools.iter().map(|t| t.name.as_ref()).collect::<Vec<_>>()
            );
            Ok(())
        }
        Cmd::RunAll { out } => run_all(out).await,
    }
}
