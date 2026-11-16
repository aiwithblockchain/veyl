//! 控制面 HTTP 传输：带 Bearer 的请求、401 单次刷新重试、错误信封。
//!
//! 业务层（`servers` / `credentials`）只关心路径与 JSON，不重复处理令牌。

use std::time::{Duration, Instant};

use reqwest::Method;
use serde_json::Value;

use super::auth;
use super::error::{self, CpError};

const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_RESPONSE_BYTES: usize = 1024 * 1024;

/// 控制面 HTTP 客户端的唯一构造入口：**一律直连**。
///
/// 不读系统代理（macOS 网络设置 / Windows WinINET），也不读
/// `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY`：用户连着系统代理或 TUN 时，
/// 代理可能正好指向一个不可用的 VPN 节点，而「管理我自己的服务器」这件事
/// 本来就不该依赖 VPN 本身通畅。
///
/// **边界**：只有控制面直连。用户订阅导入、节点探测、运行时下载等仍然走
/// 用户当前网络策略（`public_http.rs` 等），不要复用这个 builder。
pub fn builder() -> reqwest::ClientBuilder {
    reqwest::Client::builder().no_proxy()
}

pub fn http_client(timeout: Duration) -> Result<reqwest::Client, CpError> {
    builder()
        .timeout(timeout)
        .build()
        .map_err(|error| CpError::internal(format!("创建控制面客户端失败：{error}")))
}

/// 日志里只保留 path：查询串可能带一次性参数，不能落盘。
pub(crate) fn log_path(path: &str) -> &str {
    path.split(['?', '#']).next().unwrap_or(path)
}

/// reqwest 错误的 source 链。**不含顶层 Display**：那一层会带完整 URL，
/// 违反「日志不记完整 URL」；内层连接错误本身不含 URL。
fn source_chain(error: &reqwest::Error) -> String {
    let mut parts = Vec::new();
    let mut current = std::error::Error::source(error);
    while let Some(inner) = current {
        parts.push(inner.to_string());
        current = inner.source();
    }
    let text = parts.join(" | ");
    if text.trim().is_empty() {
        "-".into()
    } else {
        text
    }
}

/// 传输错误分类：`dns` / `connect` / `timeout` / `tls`，其它归 `other`。
///
/// `is_connect()` 对 DNS 解析失败同样为真，所以先看 source 文本里的
/// dns / lookup 线索，再看 TLS，最后才落到 connect。这是判断
/// 「workers.dev 在当前网络不可达」还是「我们代码问题」的关键证据。
pub(crate) fn transport_kind(error: &reqwest::Error) -> &'static str {
    // 先看 source 文本：DNS 卡住直到整体超时时，`is_timeout()` 也为真，
    // 但那实际是 DNS 不可达，不能记成普通超时。
    let text = source_chain(error).to_ascii_lowercase();
    if text.contains("dns") || text.contains("lookup") || text.contains("resolve") {
        return "dns";
    }
    if text.contains("certificate")
        || text.contains("tls")
        || text.contains("ssl")
        || text.contains("handshake")
    {
        return "tls";
    }
    if error.is_timeout() {
        return "timeout";
    }
    if error.is_connect() {
        return "connect";
    }
    "other"
}

/// 控制面请求失败：只打一行 warn，成功不打。`reason` 是 `details.reason`，
/// 传输失败用 `network` / `timeout`，便于和 Worker 侧访问日志对上。
pub(crate) fn warn_failure(
    operation: &str,
    method: &str,
    path: &str,
    kind: &str,
    status: Option<u16>,
    retryable: bool,
    reason: &str,
    detail: &str,
) {
    let status = status
        .map(|value| value.to_string())
        .unwrap_or_else(|| "-".into());
    log::warn!(
        "控制面请求失败 op={operation} method={method} path={} kind={kind} status={status} reason={reason} retryable={retryable} detail={detail}",
        log_path(path)
    );
}

/// 传输层失败（DNS / 连接 / 超时 / TLS），detail 是 source 链。
pub(crate) fn warn_transport(operation: &str, method: &str, path: &str, error: &reqwest::Error) {
    warn_failure(
        operation,
        method,
        path,
        transport_kind(error),
        None,
        true,
        if error.is_timeout() { "timeout" } else { "network" },
        &source_chain(error),
    );
}

pub struct ControlPlane {
    base_url: String,
    http: reqwest::Client,
}

impl ControlPlane {
    pub fn new() -> Result<Self, CpError> {
        let http = http_client(REQUEST_TIMEOUT)?;
        Ok(Self {
            base_url: crate::control_plane::env::current().base_url,
            http,
        })
    }

    pub async fn request(
        &self,
        method: Method,
        path: &str,
        body: Option<&Value>,
        idempotency_key: Option<&str>,
    ) -> Result<Value, CpError> {
        let method_label = method.as_str().to_string();
        log::debug!("控制面请求开始 method={method_label} path={}", log_path(path));
        let token = auth::ensure_access(&self.base_url, &self.http, None).await?;
        let (status, text) = self
            .send(method.clone(), path, body, idempotency_key, &token)
            .await?;
        if status != 401 {
            return decode_logged(&method_label, path, status, &text);
        }

        // access 过期：刷新（或重新注册）后只重试一次。幂等键原样复用。
        log::debug!(
            "控制面请求收到 401，刷新令牌后重试一次 method={method_label} path={}",
            log_path(path)
        );
        let refreshed = auth::ensure_access(&self.base_url, &self.http, Some(&token)).await?;
        let (status, text) = self
            .send(method, path, body, idempotency_key, &refreshed)
            .await?;
        decode_logged(&method_label, path, status, &text)
    }

    pub async fn get(&self, path: &str) -> Result<Value, CpError> {
        self.request(Method::GET, path, None, None).await
    }

    pub async fn post(
        &self,
        path: &str,
        body: Option<&Value>,
        idempotency_key: Option<&str>,
    ) -> Result<Value, CpError> {
        self.request(Method::POST, path, body, idempotency_key).await
    }

    async fn send(
        &self,
        method: Method,
        path: &str,
        body: Option<&Value>,
        idempotency_key: Option<&str>,
        token: &str,
    ) -> Result<(u16, String), CpError> {
        let url = format!("{}{}", self.base_url.trim_end_matches('/'), path);
        let method_label = method.as_str().to_string();
        let started = Instant::now();
        let mut request = self
            .http
            .request(method, url)
            .bearer_auth(token)
            .header(reqwest::header::ACCEPT, "application/json");
        if let Some(key) = idempotency_key {
            request = request.header("Idempotency-Key", key);
        }
        if let Some(body) = body {
            request = request.json(body);
        }

        let response = request
            .send()
            .await
            .map_err(|error| {
                warn_transport("api", &method_label, path, &error);
                CpError::network(error.is_timeout())
            })?;
        if let Some(length) = response.content_length() {
            if length as usize > MAX_RESPONSE_BYTES {
                return Err(CpError::invalid_response("控制面响应过大"));
            }
        }
        let status = response.status().as_u16();
        log::debug!(
            "控制面响应 method={method_label} path={} status={status} elapsed_ms={}",
            log_path(path),
            started.elapsed().as_millis()
        );
        let bytes = response
            .bytes()
            .await
            .map_err(|error| CpError::network(error.is_timeout()))?;
        if bytes.len() > MAX_RESPONSE_BYTES {
            return Err(CpError::invalid_response("控制面响应过大"));
        }
        let text = String::from_utf8(bytes.to_vec())
            .map_err(|_| CpError::invalid_response("控制面响应不是 UTF-8"))?;
        Ok((status, text))
    }
}

fn decode(status: u16, text: &str) -> Result<Value, CpError> {
    if !(200..=299).contains(&status) {
        return Err(error::from_response(status, text));
    }
    if text.trim().is_empty() {
        return Ok(Value::Null);
    }
    serde_json::from_str(text)
        .map_err(|_| CpError::invalid_response("控制面响应格式不正确"))
}

/// `decode` 的日志版：非 2xx 记 `kind=status`，2xx 但响应体不合法记
/// `kind=invalid_response`。成功不产生日志。
fn decode_logged(method: &str, path: &str, status: u16, text: &str) -> Result<Value, CpError> {
    match decode(status, text) {
        Ok(value) => Ok(value),
        Err(error) => {
            let kind = if (200..=299).contains(&status) {
                "invalid_response"
            } else {
                "status"
            };
            warn_failure(
                "api",
                method,
                path,
                kind,
                Some(status),
                error.retryable,
                error.reason().unwrap_or("-"),
                "-",
            );
            Err(error)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_204_is_an_empty_success() {
        // `my_server_destroy` 的 HTTP 响应是 204；命令层把它映射成
        // `state: "destroying"` 的 MyServer，前端不用特判空响应。
        assert_eq!(decode(204, "").unwrap(), Value::Null);
        assert_eq!(decode(204, "  ").unwrap(), Value::Null);
        assert!(decode(500, "").is_err());
    }

    #[test]
    fn log_paths_drop_query_and_fragment() {
        assert_eq!(log_path("/v1/servers?token=secret"), "/v1/servers");
        assert_eq!(log_path("/v1/servers#frag"), "/v1/servers");
        assert_eq!(log_path("/v1/servers"), "/v1/servers");
    }

    /// 用真实请求验证 `builder()` 的 `no_proxy()`：构建前把代理环境变量指向
    /// 一个只会返回 502 的假代理，请求如果走了代理就必然失败。
    ///
    /// reqwest 在 `build()` 时读取代理设置，所以环境变量只在 build 期间注入；
    /// 之后即使没装 `no_proxy`，客户端也已经固化了代理配置。
    #[test]
    fn the_control_plane_client_never_uses_a_proxy() {
        use std::io::{Read, Write};
        use std::net::TcpListener;
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::sync::Arc;
        use std::time::Instant;

        fn serve(listener: TcpListener, body: &'static [u8], hits: Arc<AtomicUsize>) {
            listener.set_nonblocking(true).unwrap();
            std::thread::spawn(move || {
                let start = Instant::now();
                while start.elapsed() < Duration::from_secs(3) {
                    match listener.accept() {
                        Ok((mut stream, _)) => {
                            hits.fetch_add(1, Ordering::SeqCst);
                            let _ =
                                stream.set_read_timeout(Some(Duration::from_millis(500)));
                            let mut buffer = [0u8; 1024];
                            let _ = stream.read(&mut buffer);
                            let _ = stream.write_all(body);
                            let _ = stream.flush();
                        }
                        Err(_) => std::thread::sleep(Duration::from_millis(10)),
                    }
                }
            });
        }

        let poison = TcpListener::bind("127.0.0.1:0").unwrap();
        let poison_addr = poison.local_addr().unwrap();
        let poison_hits = Arc::new(AtomicUsize::new(0));
        serve(
            poison,
            b"HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n",
            poison_hits.clone(),
        );

        let target = TcpListener::bind("127.0.0.1:0").unwrap();
        let target_addr = target.local_addr().unwrap();
        let target_hits = Arc::new(AtomicUsize::new(0));
        serve(
            target,
            b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}",
            target_hits.clone(),
        );

        let keys = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY"];
        let saved: Vec<(&str, Option<String>)> =
            keys.iter().map(|key| (*key, std::env::var(key).ok())).collect();
        for key in ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY"] {
            std::env::set_var(key, format!("http://{poison_addr}"));
        }
        std::env::remove_var("NO_PROXY");
        let client = builder().timeout(Duration::from_secs(2)).build().unwrap();
        for (key, value) in saved {
            match value {
                Some(value) => std::env::set_var(key, value),
                None => std::env::remove_var(key),
            }
        }

        let url = format!("http://{target_addr}/v1/health");
        // 独占运行时：不与别的测试共用全局运行时，免得连接被别处的收尾取消。
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let response = runtime
            .block_on(async { client.get(&url).send().await })
            .expect("控制面客户端应该直连目标");
        assert_eq!(response.status().as_u16(), 200);
        assert_eq!(target_hits.load(Ordering::SeqCst), 1);
        std::thread::sleep(Duration::from_millis(50));
        assert_eq!(
            poison_hits.load(Ordering::SeqCst),
            0,
            "控制面请求走了系统/环境代理"
        );
    }
}
