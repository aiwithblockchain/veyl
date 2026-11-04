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

    /// `/connections` 的一次采样：累计流量 + 当前活跃连接数。
    ///
    /// Clash 的字段名是 `uploadTotal` / `downloadTotal`，单位字节、从进程启动起累加。
    /// 速率由两次采样的差值算——`/traffic` 那条流式端点更适合做每秒速率，
    /// 但我们要和健康检查同频（2s），轮询一次 `/connections` 已经够用。
    pub async fn connection_sample(&self) -> RuntimeResult<Option<ConnectionSample>> {
        let response = self
            .http
            .get(format!("{}/connections", self.base))
            .bearer_auth(&self.secret)
            .timeout(Duration::from_secs(2))
            .send()
            .await
            .map_err(|e| RuntimeError::ClashApi(format!("GET /connections: {e}")))?;

        if !response.status().is_success() {
            return Err(RuntimeError::ClashApi(format!(
                "GET /connections returned HTTP {}",
                response.status()
            )));
        }

        let body: ConnectionsResponse = response
            .json()
            .await
            .map_err(|e| RuntimeError::ClashApi(format!("GET /connections body: {e}")))?;
        Ok(body.into_sample())
    }
}

/// 一次 `/connections` 采样：累计上下行字节 + 活跃连接数。
///
/// `active` 是 `Option`：响应里没有 `connections` 数组时，「未知」和「0 条」
/// 必须能区分开。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct ConnectionSample {
    pub up_bytes: u64,
    pub down_bytes: u64,
    pub active: Option<u32>,
}

#[derive(Debug, Deserialize)]
struct ConnectionsResponse {
    #[serde(rename = "uploadTotal")]
    upload_total: Option<u64>,
    #[serde(rename = "downloadTotal")]
    download_total: Option<u64>,
    connections: Option<Vec<serde_json::Value>>,
}

impl ConnectionsResponse {
    /// 两个累计字段缺任一，就当作这次采样没有数据。
    ///
    /// **不能落成 0**：刚连上时 Clash 可能还没统计，`serde(default)` 会造出一个
    /// 合法的 `traffic: {0,0}`，UI 就会显示「0 B」——正好破坏
    /// 「没有数据」和「真的 0 字节」的区分。
    fn into_sample(self) -> Option<ConnectionSample> {
        Some(ConnectionSample {
            up_bytes: self.upload_total?,
            down_bytes: self.download_total?,
            active: self.connections.map(|items| items.len() as u32),
        })
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

/// 出口 IP 探测地址：纯文本返回，body 就是 IP 本身。
/// 不能复用数据面探测的 URL——`generate_204` 没有 body，拿不到 IP。
pub const DEFAULT_EXIT_IP_PROBE: &str = "https://ifconfig.me/ip";

/// 经本地 mixed 入站访问纯文本 IP 服务，取得当前公网出口地址。
#[derive(Clone)]
pub struct ExitIpProbe {
    url: String,
    http: reqwest::Client,
}

impl ExitIpProbe {
    pub fn new(url: impl Into<String>, mixed_port: u16) -> RuntimeResult<Self> {
        let proxy = reqwest::Proxy::all(format!("http://127.0.0.1:{mixed_port}"))
            .map_err(|e| RuntimeError::ClashApi(format!("invalid exit ip proxy: {e}")))?;
        let http = reqwest::Client::builder()
            .proxy(proxy)
            .timeout(Duration::from_secs(5))
            .build()
            .map_err(|e| RuntimeError::ClashApi(format!("exit ip client: {e}")))?;
        Ok(Self {
            url: url.into(),
            http,
        })
    }

    /// `Ok(None)` 表示响应不是 IP（门户页、错误串等），按没拿到处理。
    pub async fn check(&self) -> RuntimeResult<Option<String>> {
        let response = self
            .http
            .get(&self.url)
            .send()
            .await
            .map_err(|e| RuntimeError::ClashApi(format!("exit ip probe: {e}")))?;
        if !response.status().is_success() {
            return Err(RuntimeError::ClashApi(format!(
                "exit ip probe returned HTTP {}",
                response.status()
            )));
        }
        let body = response
            .text()
            .await
            .map_err(|e| RuntimeError::ClashApi(format!("exit ip probe body: {e}")))?;
        Ok(parse_exit_ip(&body).map(|ip| ip.to_string()))
    }
}

/// 只接受纯 IP：允许首尾空白（ifconfig.me 会带换行），
/// HTML、错误串、`ip:port`、多行内容一律拒绝，避免把垃圾写进状态。
pub fn parse_exit_ip(body: &str) -> Option<std::net::IpAddr> {
    body.trim().parse::<std::net::IpAddr>().ok()
}

/// 直连出口 IP 的探测地址。与出口探测用同一个纯文本服务。
pub const DEFAULT_DIRECT_IP_PROBE: &str = "https://ifconfig.me/ip";

/// 不经任何代理，直接测本机公网出口。用于与 `exit_ip` 对照。
#[derive(Clone)]
pub struct DirectIpProbe {
    url: String,
    http: reqwest::Client,
}

impl DirectIpProbe {
    pub fn new(url: impl Into<String>) -> RuntimeResult<Self> {
        // no_proxy：不读环境变量、不碰系统代理，拿到的才是直连出口。
        let http = reqwest::Client::builder()
            .no_proxy()
            .timeout(Duration::from_secs(5))
            .build()
            .map_err(|e| RuntimeError::ClashApi(format!("direct ip client: {e}")))?;
        Ok(Self {
            url: url.into(),
            http,
        })
    }

    pub async fn check(&self) -> RuntimeResult<Option<String>> {
        let response = self
            .http
            .get(&self.url)
            .send()
            .await
            .map_err(|e| RuntimeError::ClashApi(format!("direct ip probe: {e}")))?;
        if !response.status().is_success() {
            return Err(RuntimeError::ClashApi(format!(
                "direct ip probe returned HTTP {}",
                response.status()
            )));
        }
        let body = response
            .text()
            .await
            .map_err(|e| RuntimeError::ClashApi(format!("direct ip probe body: {e}")))?;
        Ok(parse_exit_ip(&body).map(|ip| ip.to_string()))
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

    /// Clash 的字段名是驼峰，缺字段按 0 处理（刚连上时可能还没统计）。
    #[test]
    fn connections_totals_read_the_clash_field_names() {
        let body: ConnectionsResponse = serde_json::from_str(
            r#"{"uploadTotal": 12, "downloadTotal": 34, "connections": [{}, {}]}"#,
        )
        .unwrap();
        assert_eq!(
            body.into_sample(),
            Some(ConnectionSample {
                up_bytes: 12,
                down_bytes: 34,
                active: Some(2),
            })
        );

        // 没有 connections 数组时，连接数是「未知」而不是 0。
        let no_connections: ConnectionsResponse =
            serde_json::from_str(r#"{"uploadTotal": 1, "downloadTotal": 2}"#).unwrap();
        assert_eq!(
            no_connections.into_sample(),
            Some(ConnectionSample {
                up_bytes: 1,
                down_bytes: 2,
                active: None,
            })
        );
    }

    /// 缺字段不能兜成 0：那会把「还没统计到」显示成「0 B」。
    #[test]
    fn a_partial_connection_response_is_no_data_not_zero() {
        for raw in [
            r#"{}"#,
            r#"{"uploadTotal": 12}"#,
            r#"{"downloadTotal": 34}"#,
        ] {
            let body: ConnectionsResponse = serde_json::from_str(raw).unwrap();
            assert_eq!(body.into_sample(), None, "这份响应应视为无数据：{raw}");
        }
    }

    #[test]
    fn probe_rejects_unusable_proxy_address() {
        assert!(DataPlaneProbe::new("https://example.com", 2080).is_ok());
    }

    #[test]
    fn parses_plain_ipv4_and_ipv6() {
        assert_eq!(
            parse_exit_ip("203.0.113.10").map(|ip| ip.to_string()).as_deref(),
            Some("203.0.113.10")
        );
        assert!(parse_exit_ip("2001:db8::1").is_some());
    }

    #[test]
    fn tolerates_surrounding_whitespace() {
        assert_eq!(
            parse_exit_ip("  203.0.113.10\r\n").map(|ip| ip.to_string()).as_deref(),
            Some("203.0.113.10")
        );
    }

    #[test]
    fn rejects_anything_that_is_not_a_bare_ip() {
        for body in [
            "",
            "   \n",
            "<html><body>login</body></html>",
            "error: upstream timeout",
            "203.0.113.10:8080",
            "203.0.113.10\nYOUR_IP",
            "not-an-ip",
        ] {
            assert!(parse_exit_ip(body).is_none(), "不该接受 {body:?}");
        }
    }
}
