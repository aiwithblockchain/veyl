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
}

impl fmt::Debug for Enrollment {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Enrollment")
            .field("server_id", &self.server_id)
            .field("server_token", &"***")
            .field("desired", &self.desired)
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
    /// Sent only on a successful rotation; `None` for every other report.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub password: Option<String>,
}

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

pub struct ControlPlane {
    http: reqwest::Client,
    base: String,
    enroll_url: Option<String>,
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
        })
    }

    /// cloud-init writes the full enroll URL; use it verbatim when present.
    pub fn with_enroll_url(mut self, enroll_url: Option<String>) -> Self {
        self.enroll_url = enroll_url;
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

    /// CONTRACT: the one-time token is sent as `Authorization: Bearer <token>`;
    /// the body is an empty JSON object.
    pub async fn enroll(&self, enrollment_token: &str) -> Result<Enrollment, ControlError> {
        let url = self
            .enroll_url
            .clone()
            .unwrap_or_else(|| self.url("/v1/agent/enroll"));
        let resp = self
            .http
            .post(url)
            .bearer_auth(enrollment_token)
            .header("accept", "application/json")
            .json(&json!({}))
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
        };
        let e = format!("{e:?}");
        assert!(!e.contains("agt_secret"));
        assert!(!e.contains("secret-password"));
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
