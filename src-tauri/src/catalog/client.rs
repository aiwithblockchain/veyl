use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;

use rand::Rng;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};

use super::error::{CatalogError, CatalogResult};
use super::types::{NodeDetailResponse, NodeListResponse, NodeProtocol};

pub const CATALOG_CONTRACT_VERSION: &str = "1.0.10";

const MAX_RESPONSE_BYTES: usize = 512 * 1024;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Debug, Clone, Default)]
pub struct NodeQuery {
    pub region: Option<String>,
    pub protocol: Option<NodeProtocol>,
    pub limit: Option<u8>,
    pub cursor: Option<String>,
}

impl NodeQuery {
    fn to_pairs(&self) -> CatalogResult<Vec<(String, String)>> {
        let mut pairs = Vec::new();
        if let Some(region) = &self.region {
            let normalised = region.trim().to_ascii_lowercase();
            if normalised.len() != 2 || !normalised.chars().all(|c| c.is_ascii_lowercase()) {
                return Err(CatalogError::invalid(
                    "region must be a lowercase ISO 3166-1 alpha-2 code",
                ));
            }
            pairs.push(("region".into(), normalised));
        }
        if let Some(protocol) = self.protocol {
            pairs.push(("protocol".into(), protocol.as_str().into()));
        }
        if let Some(limit) = self.limit {
            if !(1..=50).contains(&limit) {
                return Err(CatalogError::invalid("limit must be between 1 and 50"));
            }
            pairs.push(("limit".into(), limit.to_string()));
        }
        if let Some(cursor) = &self.cursor {
            pairs.push(("cursor".into(), cursor.clone()));
        }
        Ok(pairs)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RegisterDeviceRequest {
    pub contract_version: String,
    pub platform: String,
    pub arch: String,
    pub app_version: String,
    pub device_fingerprint: String,
}

impl RegisterDeviceRequest {
    pub fn new(device_fingerprint: impl Into<String>) -> Self {
        let (platform, arch) = host_platform();
        Self {
            contract_version: CATALOG_CONTRACT_VERSION.into(),
            platform,
            arch,
            app_version: env!("CARGO_PKG_VERSION").into(),
            device_fingerprint: device_fingerprint.into(),
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct RegisterDeviceResponse {
    pub device_id: String,
    pub device_token: String,
    #[serde(default)]
    pub issued_at: String,
    #[serde(default)]
    pub expires_at: String,
}

#[derive(Clone)]
struct Cache<T> {
    etag: String,
    value: T,
}

enum Fetched<T> {
    Fresh { data: T, etag: Option<String> },
    NotModified,
}

#[derive(Deserialize)]
struct Envelope<T> {
    #[serde(default)]
    contract_version: String,
    #[serde(default)]
    ok: bool,
    #[serde(default)]
    request_id: String,
    data: Option<T>,
    error: Option<ApiErrorBody>,
}

#[derive(Deserialize)]
struct ApiErrorBody {
    code: String,
    #[serde(default)]
    message: String,
    #[serde(default)]
    retryable: bool,
    #[serde(default)]
    details: Option<serde_json::Value>,
}

pub struct CatalogClient {
    base: String,
    token: Mutex<Option<String>>,
    http: reqwest::Client,
    list_cache: Mutex<Option<Cache<NodeListResponse>>>,
    detail_cache: Mutex<HashMap<String, Cache<NodeDetailResponse>>>,
}

impl CatalogClient {
    pub fn new(base_url: impl Into<String>) -> Self {
        let http = reqwest::Client::builder()
            .user_agent(concat!("veyl/", env!("CARGO_PKG_VERSION")))
            .timeout(REQUEST_TIMEOUT)
            .build()
            .unwrap_or_default();
        Self {
            base: base_url.into().trim_end_matches('/').to_string(),
            token: Mutex::new(None),
            http,
            list_cache: Mutex::new(None),
            detail_cache: Mutex::new(HashMap::new()),
        }
    }

    pub fn with_token(self, token: impl Into<String>) -> Self {
        *self.token.lock().unwrap() = Some(token.into());
        self
    }

    pub fn set_token(&self, token: Option<String>) {
        *self.token.lock().unwrap() = token;
    }

    pub fn clear_cache(&self) {
        *self.list_cache.lock().unwrap() = None;
        self.detail_cache.lock().unwrap().clear();
    }

    /// 匿名注册。token 由调用方写入钥匙串，客户端不持久化。
    pub async fn register_device(
        &self,
        request: &RegisterDeviceRequest,
    ) -> CatalogResult<RegisterDeviceResponse> {
        let response = self
            .http
            .post(format!("{}/devices", self.base))
            .header("X-Request-Id", request_id())
            .json(request)
            .send()
            .await
            .map_err(CatalogError::transport)?;

        let status = response.status();
        let bytes = response.bytes().await.map_err(CatalogError::transport)?;
        if !status.is_success() {
            return Err(parse_error(status, &bytes));
        }
        let envelope: Envelope<RegisterDeviceResponse> = serde_json::from_slice(&bytes)
            .map_err(|e| CatalogError::new("INTERNAL", format!("malformed response: {e}"), false))?;
        envelope
            .data
            .ok_or_else(|| CatalogError::new("INTERNAL", "response has no data", false))
    }

    /// 列表只返回摘要，不含任何凭据。
    pub async fn list_nodes(&self, query: &NodeQuery) -> CatalogResult<NodeListResponse> {
        let pairs = query.to_pairs()?;
        let cached = self.list_cache.lock().unwrap().clone();
        let etag = cached.as_ref().map(|c| c.etag.clone());

        match self
            .fetch::<NodeListResponse>("/catalog/nodes", &pairs, etag)
            .await?
        {
            Fetched::NotModified => {
                let mut value = cached.map(|c| c.value).ok_or_else(|| {
                    CatalogError::new("NOT_MODIFIED", "server returned 304 with no cache", false)
                })?;
                value.fetched_at = now_iso();
                *self.list_cache.lock().unwrap() = Some(Cache {
                    etag: value.etag.clone(),
                    value: value.clone(),
                });
                Ok(value)
            }
            Fetched::Fresh { data, etag } => {
                let etag = if data.etag.is_empty() {
                    etag.unwrap_or_default()
                } else {
                    data.etag.clone()
                };
                *self.list_cache.lock().unwrap() = Some(Cache {
                    etag,
                    value: data.clone(),
                });
                Ok(data)
            }
        }
    }

    /// 详情含凭据，调用方只能是 Config Builder；不要把它放进 ToolResult。
    pub async fn node_detail(&self, node_id: &str) -> CatalogResult<NodeDetailResponse> {
        if node_id.trim().is_empty() {
            return Err(CatalogError::invalid("node_id must not be empty"));
        }

        let cached = self
            .detail_cache
            .lock()
            .unwrap()
            .get(node_id)
            .cloned();
        let etag = cached.as_ref().map(|c| c.etag.clone());

        let path = format!("/catalog/nodes/{}", percent_encode(node_id));
        match self.fetch::<NodeDetailResponse>(&path, &[], etag).await? {
            Fetched::NotModified => {
                let mut value = cached.map(|c| c.value).ok_or_else(|| {
                    CatalogError::new("NOT_MODIFIED", "server returned 304 with no cache", false)
                })?;
                value.fetched_at = now_iso();
                self.detail_cache.lock().unwrap().insert(
                    node_id.to_string(),
                    Cache {
                        etag: value.etag.clone(),
                        value: value.clone(),
                    },
                );
                Ok(value)
            }
            Fetched::Fresh { data, etag } => {
                let etag = if data.etag.is_empty() {
                    etag.unwrap_or_default()
                } else {
                    data.etag.clone()
                };
                self.detail_cache.lock().unwrap().insert(
                    node_id.to_string(),
                    Cache {
                        etag,
                        value: data.clone(),
                    },
                );
                Ok(data)
            }
        }
    }

    async fn fetch<T: DeserializeOwned>(
        &self,
        path: &str,
        query: &[(String, String)],
        etag: Option<String>,
    ) -> CatalogResult<Fetched<T>> {
        let mut request = self
            .http
            .get(format!("{}{}", self.base, path))
            .header("Accept", "application/json")
            .header("X-Request-Id", request_id());

        if let Some(token) = self.token.lock().unwrap().clone() {
            request = request.bearer_auth(token);
        }
        if let Some(etag) = etag {
            request = request.header(reqwest::header::IF_NONE_MATCH, quote_etag(&etag));
        }
        if !query.is_empty() {
            request = request.query(query);
        }

        let response = request.send().await.map_err(CatalogError::transport)?;
        if response.status() == reqwest::StatusCode::NOT_MODIFIED {
            return Ok(Fetched::NotModified);
        }

        let response_etag = response
            .headers()
            .get(reqwest::header::ETAG)
            .and_then(|value| value.to_str().ok())
            .map(unquote_etag);
        let status = response.status();
        let bytes = response.bytes().await.map_err(CatalogError::transport)?;

        if bytes.len() > MAX_RESPONSE_BYTES {
            return Err(CatalogError::new(
                "PAYLOAD_TOO_LARGE",
                "response exceeds 512 KB",
                false,
            ));
        }
        if !status.is_success() {
            return Err(parse_error(status, &bytes));
        }

        let envelope: Envelope<T> = serde_json::from_slice(&bytes)
            .map_err(|e| CatalogError::new("INTERNAL", format!("malformed response: {e}"), false))?;

        if !envelope.ok {
            let body = envelope.error;
            return Err(CatalogError {
                code: body
                    .as_ref()
                    .map(|b| b.code.clone())
                    .unwrap_or_else(|| "INTERNAL".into()),
                message: body
                    .as_ref()
                    .map(|b| b.message.clone())
                    .unwrap_or_else(|| "catalog returned ok=false".into()),
                retryable: body.as_ref().map(|b| b.retryable).unwrap_or(false),
                details: body.and_then(|b| b.details),
                request_id: Some(envelope.request_id),
            });
        }

        if !envelope.contract_version.is_empty()
            && !contract_compatible(&envelope.contract_version)
        {
            return Err(CatalogError::new(
                "UNSUPPORTED_CONTRACT_VERSION",
                format!(
                    "server speaks {}, client speaks {CATALOG_CONTRACT_VERSION}",
                    envelope.contract_version
                ),
                false,
            )
            .with_details(Some(serde_json::json!({
                "client_version": CATALOG_CONTRACT_VERSION,
                "server_version": envelope.contract_version,
            })))
            .with_request_id(Some(envelope.request_id)));
        }

        let data = envelope
            .data
            .ok_or_else(|| CatalogError::new("INTERNAL", "response has no data", false))?;
        Ok(Fetched::Fresh {
            data,
            etag: response_etag,
        })
    }
}

fn parse_error(status: reqwest::StatusCode, bytes: &[u8]) -> CatalogError {
    if let Ok(envelope) = serde_json::from_slice::<Envelope<serde_json::Value>>(bytes) {
        if let Some(error) = envelope.error {
            return CatalogError {
                code: error.code,
                message: error.message,
                retryable: error.retryable,
                details: error.details,
                request_id: Some(envelope.request_id),
            };
        }
    }
    let code = match status.as_u16() {
        401 => "DEVICE_TOKEN_INVALID",
        404 => "NOT_FOUND",
        429 => "RATE_LIMITED",
        503 => "CATALOG_UNAVAILABLE",
        _ => "INTERNAL",
    };
    CatalogError::new(
        code,
        format!("catalog returned HTTP {status}"),
        matches!(status.as_u16(), 429 | 502 | 503),
    )
}

/// 只比较 major.minor：补丁版本差异不该打断客户端。
fn contract_compatible(server_version: &str) -> bool {
    fn major_minor(version: &str) -> Option<(u32, u32)> {
        let mut parts = version.trim().split('.');
        Some((parts.next()?.parse().ok()?, parts.next()?.parse().ok()?))
    }
    match (
        major_minor(server_version),
        major_minor(CATALOG_CONTRACT_VERSION),
    ) {
        (Some(server), Some(client)) => server == client,
        _ => false,
    }
}

fn quote_etag(etag: &str) -> String {    if etag.starts_with('"') {
        etag.to_string()
    } else {
        format!("\"{etag}\"")
    }
}

fn unquote_etag(etag: &str) -> String {
    etag.trim_matches('"').to_string()
}

fn percent_encode(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(byte as char)
            }
            other => out.push_str(&format!("%{other:02X}")),
        }
    }
    out
}

fn request_id() -> String {
    let mut bytes = [0u8; 16];
    rand::thread_rng().fill(&mut bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let hex = hex::encode(bytes);
    format!(
        "{}-{}-{}-{}-{}",
        &hex[0..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..32]
    )
}

fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn host_platform() -> (String, String) {
    let platform = match std::env::consts::OS {
        "macos" => "darwin",
        other => other,
    };
    let arch = match std::env::consts::ARCH {
        "aarch64" => "arm64",
        "x86" => "x86",
        other => other,
    };
    (platform.to_string(), arch.to_string())
}

/// 机器稳定标识；统一走 `secrets::machine_id()`，只维护一份实现。
pub fn machine_fingerprint() -> Option<String> {
    crate::secrets::machine_id()
}

/// `base64url(sha256(platform|arch|machine_id))`
pub fn device_fingerprint(machine_id: &str) -> String {
    use base64::Engine;
    use sha2::{Digest, Sha256};

    let (platform, arch) = host_platform();
    let mut hasher = Sha256::new();
    hasher.update(format!("{platform}|{arch}|{machine_id}"));
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(hasher.finalize())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn etag_round_trips_between_headers_and_body() {
        assert_eq!(quote_etag("v12"), "\"v12\"");
        assert_eq!(quote_etag("\"v12\""), "\"v12\"");
        assert_eq!(unquote_etag("\"v12\""), "v12");
    }

    #[test]
    fn region_must_be_two_lowercase_letters() {
        let query = NodeQuery {
            region: Some("JP".into()),
            ..Default::default()
        };
        let pairs = query.to_pairs().unwrap();
        assert_eq!(pairs, vec![("region".to_string(), "jp".to_string())]);

        let bad = NodeQuery {
            region: Some("japan".into()),
            ..Default::default()
        };
        assert!(bad.to_pairs().is_err());
    }

    #[test]
    fn limit_is_bounded() {
        let query = NodeQuery {
            limit: Some(51),
            ..Default::default()
        };
        assert!(query.to_pairs().is_err());
    }

    #[test]
    fn request_ids_look_like_uuid_v4() {
        let id = request_id();
        assert_eq!(id.len(), 36);
        assert_eq!(id.as_bytes()[14], b'4');
        assert_eq!(id.as_bytes()[8], b'-');
    }

    #[test]
    fn a_list_payload_drops_credentials_even_if_the_server_sends_them() {
        let payload = r#"{
            "contract_version": "1.0.10", "ok": true, "request_id": "req_1",
            "data": {
                "etag": "v12",
                "nodes": [{
                    "id": "seed-jp-01", "name": "东京 01", "region": "jp", "city": "Tokyo",
                    "protocol": "vless_reality", "latency_ms": 42, "health_score": 0.98,
                    "tags": ["seed"], "updated_at": "2026-11-02T09:15:03Z",
                    "server": "203.0.113.10", "server_port": 443,
                    "credentials": { "uuid": "secret-uuid" }
                }],
                "next_cursor": null, "fetched_at": "2026-11-02T09:15:03Z"
            }
        }"#;
        let envelope: Envelope<NodeListResponse> = serde_json::from_str(payload).unwrap();
        let data = envelope.data.unwrap();
        let text = serde_json::to_string(&data).unwrap();
        assert!(!text.contains("secret-uuid"));
        assert!(!text.contains("203.0.113.10"));
    }

    #[test]
    fn fingerprints_are_stable_and_non_reversible() {
        let a = device_fingerprint("machine-1");
        let b = device_fingerprint("machine-1");
        let c = device_fingerprint("machine-2");
        assert_eq!(a, b);
        assert_ne!(a, c);
        assert!(!a.contains("machine-1"));
    }
}
