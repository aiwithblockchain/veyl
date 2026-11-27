//! Control-plane client: enroll, report, desired state.
//!
//! Contract: `docs/design/node-agent-mcp.md` §5. Three details the doc leaves
//! implicit are marked `CONTRACT:` below; they are the only places this client
//! extends the written shape.

use std::fmt;
use std::time::Duration;

use anyhow::Result;
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::logging::{redact_sensitive, truncate};

pub const USER_AGENT: &str = concat!("veyl-agent/", env!("CARGO_PKG_VERSION"));

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SingBoxDesired {
    pub version: String,
    pub sha256: String,
    pub url: String,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DesiredState {
    pub port: u16,
    pub password: String,
    /// The desired-state endpoint's written shape omits this field; fall back
    /// to the fixed control port when it is missing.
    #[serde(default = "default_control_port")]
    pub control_port: u16,
    pub singbox: SingBoxDesired,
}

fn default_control_port() -> u16 {
    32100
}

impl fmt::Debug for DesiredState {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("DesiredState")
            .field("port", &self.port)
            .field("password", &"***")
            .field("control_port", &self.control_port)
            .field("singbox", &self.singbox)
            .finish()
    }
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Enrollment {
    pub server_id: String,
    pub server_token: String,
    pub desired: DesiredState,
    /// Public JWK for the MCP one-time token signer. The agent persists it and
    /// uses it for offline verification.
    #[serde(default)]
    pub token_public_key: Option<String>,
    /// Leaf signed by the shared root; absent when enroll carried no CSR.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cert_pem: Option<String>,
    /// The control plane's root certificate, not a node-local CA.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ca_pem: Option<String>,
}

impl fmt::Debug for Enrollment {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Enrollment")
            .field("server_id", &self.server_id)
            .field("server_token", &"***")
            .field("desired", &self.desired)
            .field("cert_pem", &self.cert_pem.as_ref().map(|_| "***"))
            .field("ca_pem", &self.ca_pem.as_ref().map(|_| "***"))
            .finish()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Stage {
    Installing,
    Verifying,
    Active,
    Failed,
    /// A successful local rotation: the control plane updates `node_port`,
    /// re-seals the credential, and must not destroy the machine.
    Rotated,
}

#[derive(Clone, Serialize)]
pub struct ReportRequest {
    pub stage: Stage,
    pub port: u16,
    pub agent_version: String,
    pub singbox_version: String,
    pub control_port: u16,
    pub cert_fingerprint: String,
    /// Self-signed CA PEM; the desktop prefers CA trust, fingerprint as backup.
    pub ca_pem: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// Sent only with `failed`: the last few log lines. The instance is
    /// destroyed right after, so this is the only surviving copy of them.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub log_excerpt: Option<String>,
    /// Sent only on a successful rotation; `None` for every other report.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub password: Option<String>,
}

/// Cap for the attached log excerpt; the control plane stores it in the audit
/// detail and must not be able to grow unbounded.
pub const LOG_EXCERPT_MAX: usize = 2000;

impl ReportRequest {
    pub fn new(
        stage: Stage,
        port: u16,
        control_port: u16,
        cert_fingerprint: &str,
        ca_pem: &str,
    ) -> Self {
        Self {
            stage,
            port,
            agent_version: env!("CARGO_PKG_VERSION").to_string(),
            singbox_version: String::new(),
            control_port,
            cert_fingerprint: cert_fingerprint.to_string(),
            ca_pem: ca_pem.to_string(),
            error: None,
            log_excerpt: None,
            password: None,
        }
    }

    pub fn with_singbox_version(mut self, version: impl Into<String>) -> Self {
        self.singbox_version = version.into();
        self
    }

    pub fn with_error(mut self, error: impl Into<String>) -> Self {
        let error: String = error.into();
        // The control plane truncates to 300 for the audit log / last_error.
        self.error = Some(truncate(&redact_sensitive(&error), 300));
        self
    }

    pub fn with_password(mut self, password: impl Into<String>) -> Self {
        self.password = Some(password.into());
        self
    }

    /// Attach the tail of the local log to a `failed` report. Redacted here so
    /// no credential can reach the control plane through the log sink.
    pub fn with_log_excerpt(mut self, excerpt: impl Into<String>) -> Self {
        let excerpt: String = excerpt.into();
        // Hard char cap (no ellipsis) so the body never exceeds what the
        // control plane stores.
        let excerpt: String = redact_sensitive(&excerpt)
            .chars()
            .take(LOG_EXCERPT_MAX)
            .collect();
        self.log_excerpt = if excerpt.trim().is_empty() {
            None
        } else {
            Some(excerpt)
        };
        self
    }
}

impl fmt::Debug for ReportRequest {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ReportRequest")
            .field("stage", &self.stage)
            .field("port", &self.port)
            .field("agent_version", &self.agent_version)
            .field("singbox_version", &self.singbox_version)
            .field("control_port", &self.control_port)
            .field("cert_fingerprint", &self.cert_fingerprint)
            .field("error", &self.error)
            .field(
                "log_excerpt_len",
                &self.log_excerpt.as_ref().map(|e| e.chars().count()),
            )
            .field("password", &self.password.as_ref().map(|_| "***"))
            .finish()
    }
}

#[derive(Clone, PartialEq, Eq)]
pub enum ControlError {
    Transport(String),
    Status { status: u16, body: String },
    Decode(String),
}

/// `{:?}` redacts a response body: it can echo a desired state with the
/// password.
impl std::fmt::Debug for ControlError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ControlError::Transport(e) => f.debug_tuple("Transport").field(e).finish(),
            ControlError::Status { status, body } => f
                .debug_struct("Status")
                .field("status", status)
                .field("body", &truncate(&redact_sensitive(body), 300))
                .finish(),
            ControlError::Decode(e) => f.debug_tuple("Decode").field(e).finish(),
        }
    }
}

impl fmt::Display for ControlError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ControlError::Transport(e) => write!(f, "control-plane transport error: {e}"),
            ControlError::Status { status, body } => write!(
                f,
                "control-plane HTTP {status}: {}",
                truncate(&redact_sensitive(body), 300)
            ),
            ControlError::Decode(e) => write!(f, "control-plane response decode error: {e}"),
        }
    }
}

impl std::error::Error for ControlError {}

/// A leaf the control plane issued (`POST /v1/agent/cert`, contract §2).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IssuedCert {
    pub cert_pem: String,
    pub ca_pem: String,
    /// Unix seconds; the certificate's own validity when the response omits it.
    pub not_after: Option<i64>,
}

/// Why a certificate request failed. The distinction matters: a rejected CSR
/// or a bad token cannot be fixed by asking again, a 5xx can.
#[derive(Clone, PartialEq, Eq)]
pub enum CertError {
    Transport(String),
    Rejected { status: u16, reason: String },
    Decode(String),
}

impl CertError {
    /// True when the same request could succeed later. `403 san_rejected`, a
    /// bad token, or a destroyed server are permanent; the caller must not loop
    /// on them at the normal retry cadence.
    pub fn retryable(&self) -> bool {
        match self {
            CertError::Rejected { status, .. } => {
                matches!(status, 408 | 425 | 429) || *status >= 500
            }
            CertError::Transport(_) | CertError::Decode(_) => true,
        }
    }
}

impl std::fmt::Debug for CertError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CertError::Transport(e) => f.debug_tuple("Transport").field(e).finish(),
            CertError::Rejected { status, reason } => f
                .debug_struct("Rejected")
                .field("status", status)
                .field("reason", &truncate(&redact_sensitive(reason), 300))
                .finish(),
            CertError::Decode(e) => f.debug_tuple("Decode").field(e).finish(),
        }
    }
}

impl fmt::Display for CertError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            CertError::Transport(e) => write!(f, "certificate request transport error: {e}"),
            CertError::Rejected { status: 404, reason } => write!(
                f,
                "certificate request rejected: HTTP 404 {} — the control plane has no /v1/agent/cert (it is older than this agent)",
                truncate(&redact_sensitive(reason), 120)
            ),
            CertError::Rejected { status, reason } => write!(
                f,
                "certificate request rejected: HTTP {status} {}",
                truncate(&redact_sensitive(reason), 120)
            ),
            CertError::Decode(e) => write!(f, "certificate response decode error: {e}"),
        }
    }
}

impl std::error::Error for CertError {}

fn rejected_cert(status: u16, body: &str) -> CertError {
    // The control plane sends `{ ok: false, reason }`; anything else is kept as
    // a truncated body so a proxy's HTML page still says something useful.
    let reason = serde_json::from_str::<Value>(body)
        .ok()
        .and_then(|value| value.get("reason")?.as_str().map(str::to_string))
        .unwrap_or_else(|| truncate(&redact_sensitive(body.trim()), 120));
    CertError::Rejected { status, reason }
}

fn issued_cert_from_text(text: &str) -> Result<IssuedCert, CertError> {
    let value: Value = serde_json::from_str(text).map_err(|e| {
        CertError::Decode(format!("{e}: {}", truncate(&redact_sensitive(text), 200)))
    })?;
    let cert_pem = value
        .get("cert_pem")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_string();
    let ca_pem = value
        .get("ca_pem")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_string();
    if cert_pem.is_empty() || ca_pem.is_empty() {
        return Err(CertError::Decode(
            "certificate response is missing cert_pem or ca_pem".to_string(),
        ));
    }
    Ok(IssuedCert {
        cert_pem,
        ca_pem,
        not_after: value.get("not_after").and_then(Value::as_i64),
    })
}

#[derive(Clone)]
pub struct ControlPlane {
    http: reqwest::Client,
    base: String,
    enroll_url: Option<String>,
    fail_url: Option<String>,
}

impl ControlPlane {
    pub fn new(base_url: &str) -> Result<Self> {
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(20))
            .user_agent(USER_AGENT)
            .build()?;
        Ok(Self {
            http,
            base: base_url.trim_end_matches('/').to_string(),
            enroll_url: None,
            fail_url: None,
        })
    }

    /// cloud-init writes the full enroll URL; use it verbatim when present.
    pub fn with_enroll_url(mut self, enroll_url: Option<String>) -> Self {
        self.enroll_url = enroll_url;
        self
    }

    /// Full `POST /v1/agent/fail` URL; derived from the base when absent.
    pub fn with_fail_url(mut self, fail_url: Option<String>) -> Self {
        self.fail_url = fail_url;
        self
    }

    fn url(&self, path: &str) -> String {
        format!("{}{}", self.base, path)
    }

    async fn call(
        &self,
        method: reqwest::Method,
        path: &str,
        token: &str,
        body: Option<&Value>,
    ) -> Result<Value, ControlError> {
        let mut req = self
            .http
            .request(method, self.url(path))
            .bearer_auth(token)
            .header("accept", "application/json");
        if let Some(body) = body {
            req = req.json(body);
        }
        let resp = req
            .send()
            .await
            .map_err(|e| ControlError::Transport(e.to_string()))?;
        let status = resp.status();
        let text = resp
            .text()
            .await
            .map_err(|e| ControlError::Transport(e.to_string()))?;
        if !status.is_success() {
            return Err(ControlError::Status {
                status: status.as_u16(),
                body: truncate(&text, 1024),
            });
        }
        if text.trim().is_empty() {
            return Ok(Value::Null);
        }
        serde_json::from_str(&text).map_err(|e| {
            ControlError::Decode(format!(
                "{e}: {}",
                truncate(&redact_sensitive(&text), 200)
            ))
        })
    }

    /// CONTRACT: the one-time token is sent as `Authorization: Bearer <token>`.
    /// With a CSR the body is `{ "csr": "<base64(DER)>" }`; without one it stays
    /// `{}`, exactly what an older control plane expects (contract §1).
    pub async fn enroll(
        &self,
        enrollment_token: &str,
        csr_b64: Option<&str>,
    ) -> Result<Enrollment, ControlError> {
        let url = self
            .enroll_url
            .clone()
            .unwrap_or_else(|| self.url("/v1/agent/enroll"));
        let body = match csr_b64 {
            Some(csr) => json!({ "csr": csr }),
            None => json!({}),
        };
        let resp = self
            .http
            .post(url)
            .bearer_auth(enrollment_token)
            .header("accept", "application/json")
            .json(&body)
            .send()
            .await
            .map_err(|e| ControlError::Transport(e.to_string()))?;
        let status = resp.status();
        let text = resp
            .text()
            .await
            .map_err(|e| ControlError::Transport(e.to_string()))?;
        if !status.is_success() {
            return Err(ControlError::Status {
                status: status.as_u16(),
                body: truncate(&text, 1024),
            });
        }
        let value: Value = serde_json::from_str(&text).map_err(|e| {
            ControlError::Decode(format!("{e}: {}", truncate(&redact_sensitive(&text), 200)))
        })?;
        serde_json::from_value(value)
            .map_err(|e| ControlError::Decode(format!("enroll response: {e}")))
    }

    /// `POST /v1/agent/cert` with the long-lived server token: renewal, root
    /// rotation, or replacing a lost/corrupt leaf (contract §2).
    pub async fn request_cert(
        &self,
        server_token: &str,
        csr_b64: &str,
    ) -> Result<IssuedCert, CertError> {
        let resp = self
            .http
            .post(self.url("/v1/agent/cert"))
            .bearer_auth(server_token)
            .header("accept", "application/json")
            .json(&json!({ "csr": csr_b64 }))
            .send()
            .await
            .map_err(|e| CertError::Transport(e.to_string()))?;
        let status = resp.status();
        let text = resp
            .text()
            .await
            .map_err(|e| CertError::Transport(e.to_string()))?;
        if !status.is_success() {
            return Err(rejected_cert(status.as_u16(), &text));
        }
        issued_cert_from_text(&text)
    }

    /// Tell the control plane that this build cannot meter. It uses the one-time
    /// enrollment token, so it must run **before** `enroll`: `/v1/agent/fail`
    /// only accepts a token that has not been consumed yet.
    ///
    /// The control plane destroys the instance in response, so nothing here is
    /// actionable — a failed report is logged and the caller exits anyway.
    pub async fn report_install_failure(
        &self,
        enrollment_token: Option<&str>,
        error: anyhow::Error,
    ) {
        let Some(token) = enrollment_token else {
            tracing::warn!(
                "cannot report the metering failure: the config has no enrollment token"
            );
            return;
        };
        let url = self
            .fail_url
            .clone()
            .unwrap_or_else(|| self.url("/v1/agent/fail"));
        // `{:#}` keeps the whole anyhow chain: the outer message alone is often
        // just a context line ("creating the counter table").
        let body = json!({
            "stage": "metering",
            "line": 1,
            "error": truncate(&redact_sensitive(&format!("{error:#}")), 300),
        });
        match self
            .http
            .post(url)
            .bearer_auth(token)
            .header("accept", "application/json")
            .json(&body)
            .send()
            .await
        {
            Ok(resp) if resp.status().is_success() => {
                tracing::info!(stage = "metering", "reported the install failure")
            }
            Ok(resp) => tracing::warn!(
                status = resp.status().as_u16(),
                "the control plane rejected the install-failure report"
            ),
            Err(e) => tracing::warn!(error = %e, "could not report the install failure"),
        }
    }

    pub async fn report(
        &self,
        server_token: &str,
        body: &ReportRequest,
    ) -> Result<(), ControlError> {
        let value = serde_json::to_value(body)
            .map_err(|e| ControlError::Decode(format!("report serialize: {e}")))?;
        self.call(reqwest::Method::POST, "/v1/agent/report", server_token, Some(&value))
            .await
            .map(|_| ())
    }

    pub async fn desired_state(&self, server_token: &str) -> Result<DesiredState, ControlError> {
        let value = self
            .call(reqwest::Method::GET, "/v1/agent/desired-state", server_token, None)
            .await?;
        desired_from_value(value)
    }

    /// `POST /v1/agent/traffic { seq, delta_bytes }`. The agent never sends a
    /// billing cycle; the control plane assigns the report to its own month.
    pub async fn traffic(
        &self,
        server_token: &str,
        seq: u64,
        delta_bytes: u64,
    ) -> Result<(), ControlError> {
        let body = json!({ "seq": seq, "delta_bytes": delta_bytes });
        self.call(
            reqwest::Method::POST,
            "/v1/agent/traffic",
            server_token,
            Some(&body),
        )
        .await
        .map(|_| ())
    }
}

/// Accept either the bare desired object or `{ "desired": { ... } }`.
pub fn desired_from_value(value: Value) -> Result<DesiredState, ControlError> {
    let inner = match value.get("desired") {
        Some(desired) => desired.clone(),
        None => value,
    };
    serde_json::from_value(inner)
        .map_err(|e| ControlError::Decode(format!("desired-state response: {e}")))
}

#[async_trait]
pub trait ControlApi: Send + Sync {
    async fn report(&self, body: &ReportRequest) -> Result<(), ControlError>;
    async fn desired_state(&self) -> Result<DesiredState, ControlError>;
    async fn traffic(&self, seq: u64, delta_bytes: u64) -> Result<(), ControlError>;
}

/// A control plane bound to one server token.
pub struct ControlSession {
    plane: ControlPlane,
    server_token: String,
}

impl ControlSession {
    pub fn new(plane: ControlPlane, server_token: impl Into<String>) -> Self {
        Self {
            plane,
            server_token: server_token.into(),
        }
    }
}

#[async_trait]
impl ControlApi for ControlSession {
    async fn report(&self, body: &ReportRequest) -> Result<(), ControlError> {
        self.plane.report(&self.server_token, body).await
    }

    async fn desired_state(&self) -> Result<DesiredState, ControlError> {
        self.plane.desired_state(&self.server_token).await
    }

    async fn traffic(&self, seq: u64, delta_bytes: u64) -> Result<(), ControlError> {
        self.plane
            .traffic(&self.server_token, seq, delta_bytes)
            .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn desired() -> DesiredState {
        DesiredState {
            port: 30412,
            password: "secret-password".into(),
            control_port: 32100,
            singbox: SingBoxDesired {
                version: "1.14.4".into(),
                sha256: "abc".into(),
                url: "https://example.com/sing-box.tar.gz".into(),
            },
        }
    }

    #[test]
    fn desired_accepts_bare_and_wrapped_shapes() {
        let bare = serde_json::to_value(desired()).unwrap();
        assert_eq!(desired_from_value(bare).unwrap(), desired());
        let wrapped = json!({ "server_id": "srv_1", "desired": desired() });
        assert_eq!(desired_from_value(wrapped).unwrap(), desired());
    }

    #[test]
    fn enroll_response_parses_token_public_key() {
        let value = json!({
            "server_id": "srv_1",
            "server_token": "agt_abc",
            "desired": desired(),
            "token_public_key": "{\"kty\":\"OKP\",\"crv\":\"Ed25519\",\"x\":\"abc\"}"
        });
        let enrollment: Enrollment = serde_json::from_value(value).unwrap();
        assert_eq!(enrollment.server_id, "srv_1");
        assert!(enrollment.token_public_key.unwrap().contains("Ed25519"));
        assert_eq!(enrollment.cert_pem, None);
        assert_eq!(enrollment.ca_pem, None);
    }

    #[test]
    fn enroll_response_parses_the_issued_certificate() {
        let value = json!({
            "server_id": "srv_1",
            "server_token": "agt_abc",
            "desired": desired(),
            "cert_pem": "-----BEGIN CERTIFICATE-----\nleaf\n-----END CERTIFICATE-----",
            "ca_pem": "-----BEGIN CERTIFICATE-----\nroot\n-----END CERTIFICATE-----"
        });
        let enrollment: Enrollment = serde_json::from_value(value).unwrap();
        assert_eq!(
            enrollment.cert_pem.as_deref(),
            Some("-----BEGIN CERTIFICATE-----\nleaf\n-----END CERTIFICATE-----")
        );
        assert!(enrollment.ca_pem.as_deref().unwrap().contains("root"));
    }

    #[test]
    fn a_cert_response_needs_both_pem_blocks() {
        let issued = issued_cert_from_text(
            r#"{"ok":true,"cert_pem":"leaf","ca_pem":"root","not_after":1955000000}"#,
        )
        .unwrap();
        assert_eq!(issued.cert_pem, "leaf");
        assert_eq!(issued.ca_pem, "root");
        assert_eq!(issued.not_after, Some(1_955_000_000));

        let missing = issued_cert_from_text(r#"{"ok":true,"cert_pem":"leaf"}"#).unwrap_err();
        assert!(matches!(missing, CertError::Decode(_)));
        assert!(missing.retryable());
    }

    #[test]
    fn certificate_error_codes_decide_whether_to_retry() {
        let rejected = rejected_cert(403, r#"{"ok":false,"reason":"san_rejected"}"#);
        assert_eq!(
            rejected,
            CertError::Rejected {
                status: 403,
                reason: "san_rejected".into()
            }
        );
        assert!(!rejected.retryable(), "403 san_rejected must not loop");

        assert!(!rejected_cert(401, r#"{"reason":"unknown_token"}"#).retryable());
        assert!(!rejected_cert(409, r#"{"reason":"destroyed"}"#).retryable());
        assert!(!rejected_cert(400, r#"{"reason":"csr_invalid"}"#).retryable());
        let missing = rejected_cert(404, "not found");
        assert!(!missing.retryable());
        assert!(missing.to_string().contains("/v1/agent/cert"));
        assert!(rejected_cert(429, r#"{"reason":"rate_limited"}"#).retryable());
        assert!(rejected_cert(503, r#"{"reason":"host_unavailable"}"#).retryable());
        assert!(CertError::Transport("timeout".into()).retryable());

        // A proxy's non-JSON body still carries the status.
        let html = rejected_cert(502, "<html>bad gateway</html>");
        assert!(html.retryable());
        assert!(format!("{html}").contains("502"));
    }

    #[test]
    fn failed_report_carries_a_redacted_log_excerpt() {
        let body = ReportRequest::new(Stage::Failed, 30412, 32100, "fp", "ca-pem")
            .with_error("boom")
            .with_log_excerpt("INFO started\nDEBUG password=super-secret\nagent agt_ABC123");
        let json = serde_json::to_value(&body).unwrap();
        let excerpt = json["log_excerpt"].as_str().unwrap();
        assert!(excerpt.contains("INFO started"));
        assert!(!excerpt.contains("super-secret"));
        assert!(!excerpt.contains("agt_ABC123"));
    }

    #[test]
    fn log_excerpt_is_capped_and_omitted_when_empty() {
        let body = ReportRequest::new(Stage::Failed, 30412, 32100, "fp", "ca")
            .with_log_excerpt("x".repeat(5000));
        let json = serde_json::to_value(&body).unwrap();
        assert!(json["log_excerpt"].as_str().unwrap().chars().count() <= LOG_EXCERPT_MAX);

        let empty = ReportRequest::new(Stage::Failed, 30412, 32100, "fp", "ca")
            .with_log_excerpt("   \n");
        assert!(serde_json::to_value(&empty)
            .unwrap()
            .get("log_excerpt")
            .is_none());
    }

    #[test]
    fn report_omits_password_except_on_rotation() {
        let plain = ReportRequest::new(Stage::Active, 30412, 32100, "fp", "ca-pem")
            .with_singbox_version("1.14.4");
        let json = serde_json::to_value(&plain).unwrap();
        assert!(json.get("password").is_none());
        assert!(json.get("error").is_none());
        assert_eq!(json["ca_pem"], "ca-pem");

        let rotated = plain.with_password("new-secret");
        let json = serde_json::to_value(&rotated).unwrap();
        assert_eq!(json["password"], "new-secret");
        assert_eq!(json["stage"], "active");
        assert_eq!(json["port"], 30412);
        assert_eq!(json["agent_version"], env!("CARGO_PKG_VERSION"));

        let rotated_stage =
            ReportRequest::new(Stage::Rotated, 30413, 32100, "fp", "ca-pem")
                .with_password("new-secret");
        assert_eq!(
            serde_json::to_value(rotated_stage).unwrap()["stage"],
            "rotated"
        );
    }

    #[test]
    fn failed_report_carries_truncated_redacted_error() {
        let body = ReportRequest::new(Stage::Failed, 1, 2, "fp", "ca-pem")
            .with_error(format!("token agt_ABC leaked password={}", "x".repeat(600)));
        assert!(body.error.as_ref().unwrap().chars().count() <= 301);
        assert!(!body.error.as_ref().unwrap().contains("agt_ABC"));
    }

    #[test]
    fn debug_does_not_leak_secrets() {
        let d = format!("{:?}", desired());
        assert!(!d.contains("secret-password"));
        assert!(d.contains("30412"));

        let e = Enrollment {
            server_id: "srv_1".into(),
            server_token: "agt_secret".into(),
            desired: desired(),
            token_public_key: Some(r#"{"kty":"OKP","crv":"Ed25519","x":"abc"}"#.into()),
            cert_pem: Some("-----BEGIN CERTIFICATE-----\nleaf\n-----END CERTIFICATE-----".into()),
            ca_pem: Some("-----BEGIN CERTIFICATE-----\nroot\n-----END CERTIFICATE-----".into()),
        };
        let e = format!("{e:?}");
        assert!(!e.contains("agt_secret"));
        assert!(!e.contains("secret-password"));
        assert!(!e.contains("BEGIN CERTIFICATE"));
    }

    #[test]
    fn error_display_redacts_body() {
        let err = ControlError::Status {
            status: 400,
            body: r#"{"password":"hunter2","reason":"bad"}"#.into(),
        };
        let text = err.to_string();
        assert!(!text.contains("hunter2"));
        assert!(text.contains("400"));
    }

    #[test]
    fn error_debug_also_redacts_body() {
        let err = ControlError::Status {
            status: 409,
            body: r#"{"desired":{"password":"hunter2"},"reason":"server_destroyed"}"#.into(),
        };
        let debug = format!("{err:?}");
        assert!(!debug.contains("hunter2"));
        assert!(debug.contains("409"));
        assert!(debug.contains("server_destroyed"));
    }
}
