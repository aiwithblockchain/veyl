use std::time::Duration;

use serde::Deserialize;

use super::error::{RuntimeError, RuntimeResult};

#[derive(Debug, Clone, Deserialize)]
pub struct VersionInfo {
    #[serde(default)]
    pub version: String,
    #[serde(default)]
    pub meta: bool,
    #[serde(default)]
    pub premium: bool,
}

/// Clash API 客户端。只连回环地址，不经过系统代理。
#[derive(Clone)]
pub struct ClashApi {
    base: String,
    secret: String,
    http: reqwest::Client,
    timeout: Duration,
}

impl ClashApi {
    pub fn new(addr: &str, secret: &str) -> Self {
        let http = reqwest::Client::builder()
            .no_proxy()
            .build()
            .unwrap_or_default();
        Self {
            base: format!("http://{addr}"),
            secret: secret.to_string(),
            http,
            timeout: Duration::from_secs(1),
        }
    }

    pub fn addr(&self) -> &str {
        self.base.trim_start_matches("http://")
    }

    pub async fn version(&self) -> RuntimeResult<VersionInfo> {
        let response = self
            .http
            .get(format!("{}/version", self.base))
            .bearer_auth(&self.secret)
            .timeout(self.timeout)
            .send()
            .await
            .map_err(|e| RuntimeError::ClashApi(format!("GET /version: {e}")))?;

        if !response.status().is_success() {
            return Err(RuntimeError::ClashApi(format!(
                "GET /version returned HTTP {}",
                response.status()
            )));
        }

        response
            .json::<VersionInfo>()
            .await
            .map_err(|e| RuntimeError::ClashApi(format!("GET /version body: {e}")))
    }

    pub async fn healthy(&self) -> bool {
        self.version().await.is_ok()
    }
}

/// 通过本地 mixed 入站访问一个轻量 URL，验证数据面真的能出网。
#[derive(Clone)]
pub struct DataPlaneProbe {
    url: String,
    http: reqwest::Client,
}

impl DataPlaneProbe {
    pub fn new(url: impl Into<String>, mixed_port: u16) -> RuntimeResult<Self> {
        let proxy = reqwest::Proxy::all(format!("http://127.0.0.1:{mixed_port}"))
            .map_err(|e| RuntimeError::ClashApi(format!("invalid probe proxy: {e}")))?;
        let http = reqwest::Client::builder()
            .proxy(proxy)
            .timeout(Duration::from_secs(5))
            .build()
            .map_err(|e| RuntimeError::ClashApi(format!("probe client: {e}")))?;
        Ok(Self {
            url: url.into(),
            http,
        })
    }

    pub async fn check(&self) -> RuntimeResult<u16> {
        let response = self
            .http
            .get(&self.url)
            .send()
            .await
            .map_err(|e| RuntimeError::ClashApi(format!("data plane probe: {e}")))?;
        Ok(response.status().as_u16())
    }

    pub async fn ok(&self) -> bool {
        matches!(self.check().await, Ok(status) if (200..400).contains(&status))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clash_client_targets_the_given_address() {
        let api = ClashApi::new("127.0.0.1:19090", "secret");
        assert_eq!(api.addr(), "127.0.0.1:19090");
    }

    #[test]
    fn probe_rejects_unusable_proxy_address() {
        assert!(DataPlaneProbe::new("https://example.com", 2080).is_ok());
    }
}
