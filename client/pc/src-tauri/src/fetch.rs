//! 订阅拉取。
//!
//! 规则见 `client/docs/client-apps-technical.md` §6.2：
//! Basic 认证、连接 10s / 总 20s、512 KiB 上限、**不跟随重定向**
//! （跟随会把 `Authorization` 带到别的主机）、按状态码给出确定的同步状态。
//!
//! 返回的是 `FetchOutcome` 而不是 `Result`：401/403/429 是「同步状态」，
//! 不是错误——调用方要据此保留旧配置并停止自动更新。

use std::time::Duration;

use crate::error::AppResult;
use crate::subscription_url::SubscriptionUrl;

/// 正文上限：真实配置几 KB，超过视为异常。
pub const MAX_BODY_BYTES: usize = 512 * 1024;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const TOTAL_TIMEOUT: Duration = Duration::from_secs(20);
/// 错误正文只取开头一点，足够读错误码。
const ERROR_BODY_BYTES: usize = 2048;

#[derive(Debug)]
pub enum FetchOutcome {
    Ok(String),
    /// 令牌失效（典型是被轮换过）。
    Unauthorized,
    /// 账户停用。
    Forbidden,
    /// 限流，带上服务端给的等待秒数。
    RateLimited(Option<u64>),
    /// 网络失败、5xx、或任何非预期状态。`message` 不含 URL 与令牌。
    Failed(String),
}

pub fn client() -> AppResult<reqwest::Client> {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .no_proxy()
        .connect_timeout(CONNECT_TIMEOUT)
        .user_agent(concat!("veyl-cli/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|error| {
            crate::error::AppError::internal(format!("初始化网络客户端失败：{error}"))
                .with_hint("重启应用再试。")
        })
}

pub async fn fetch_profile(client: &reqwest::Client, url: &SubscriptionUrl) -> FetchOutcome {
    let response = client
        .get(url.request_url())
        .basic_auth("veyl", Some(url.token()))
        .timeout(TOTAL_TIMEOUT)
        .send()
        .await;

    let response = match response {
        Ok(response) => response,
        Err(error) => {
            return FetchOutcome::Failed(network_message(&error));
        }
    };

    match response.status().as_u16() {
        200 => {}
        401 => return FetchOutcome::Unauthorized,
        403 => return FetchOutcome::Forbidden,
        429 => {
            let retry_after = response
                .headers()
                .get(reqwest::header::RETRY_AFTER)
                .and_then(|value| value.to_str().ok())
                .and_then(|value| value.trim().parse::<u64>().ok());
            return FetchOutcome::RateLimited(retry_after);
        }
        status => {
            let detail = read_capped(response, ERROR_BODY_BYTES).await;
            let mut outcome = format!("同步失败（HTTP {status}）");
            if let Some(detail) = detail.and_then(|body| first_line(&body)) {
                outcome.push_str(&format!("：{detail}"));
            }
            return FetchOutcome::Failed(outcome);
        }
    }

    if let Some(length) = response.content_length() {
        if length > MAX_BODY_BYTES as u64 {
            return FetchOutcome::Failed(format!(
                "配置过大（{} 字节，上限 {MAX_BODY_BYTES}）",
                length
            ));
        }
    }

    match read_body_capped(response, MAX_BODY_BYTES).await {
        Ok(body) => FetchOutcome::Ok(body),
        Err(BodyError::TooLarge) => {
            FetchOutcome::Failed(format!("配置过大（超过 {MAX_BODY_BYTES} 字节上限）"))
        }
        Err(BodyError::Network(message)) => FetchOutcome::Failed(message),
    }
}

enum BodyError {
    TooLarge,
    Network(String),
}

async fn read_body_capped(mut response: reqwest::Response, cap: usize) -> Result<String, BodyError> {
    let mut body: Vec<u8> = Vec::with_capacity(8 * 1024);
    loop {
        match response.chunk().await {
            Ok(Some(chunk)) => {
                if body.len() + chunk.len() > cap {
                    return Err(BodyError::TooLarge);
                }
                body.extend_from_slice(&chunk);
            }
            Ok(None) => break,
            Err(error) => return Err(BodyError::Network(network_message(&error))),
        }
    }
    String::from_utf8(body).map_err(|_| {
        BodyError::Network("服务器返回的内容不是 UTF-8 文本".to_string())
    })
}

async fn read_capped(mut response: reqwest::Response, cap: usize) -> Option<String> {
    let mut body: Vec<u8> = Vec::new();
    while let Ok(Some(chunk)) = response.chunk().await {
        let remaining = cap.saturating_sub(body.len());
        if remaining == 0 {
            break;
        }
        body.extend_from_slice(&chunk[..chunk.len().min(remaining)]);
    }
    String::from_utf8(body).ok()
}

fn first_line(body: &str) -> Option<String> {
    let line = body.lines().map(str::trim).find(|line| !line.is_empty())?;
    Some(line.chars().take(200).collect())
}

/// 网络错误的人话版本。**不带 URL**——err 的 Display 里可能含完整地址。
fn network_message(error: &reqwest::Error) -> String {
    if error.is_timeout() {
        "同步超时".to_string()
    } else if error.is_connect() {
        "连不上服务器".to_string()
    } else {
        "网络请求失败".to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::{TcpListener, TcpStream};
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    fn token() -> String {
        format!("mp_{}", "a".repeat(43))
    }

    /// 一条连接内的一问一答；`handler(request) -> raw response bytes`。
    fn serve<F>(handler: F) -> std::net::SocketAddr
    where
        F: Fn(&str) -> Vec<u8> + Send + Sync + 'static,
    {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let handler = Arc::new(handler);
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { continue };
                let request = read_request(&mut stream);
                let response = handler(&request);
                let _ = stream.write_all(&response);
                let _ = stream.flush();
            }
        });
        addr
    }

    fn read_request(stream: &mut TcpStream) -> String {
        let mut buffer = Vec::new();
        let mut byte = [0u8; 1];
        while stream.read(&mut byte).is_ok() && byte[0] != 0 {
            buffer.push(byte[0]);
            if buffer.ends_with(b"\r\n\r\n") {
                break;
            }
        }
        String::from_utf8_lossy(&buffer).into_owned()
    }

    fn response(status: &str, headers: &[(&str, &str)], body: &str) -> Vec<u8> {
        let mut out = format!("HTTP/1.1 {status}\r\n");
        for (name, value) in headers {
            out.push_str(&format!("{name}: {value}\r\n"));
        }
        out.push_str(&format!("Content-Length: {}\r\n", body.len()));
        out.push_str("Connection: close\r\n\r\n");
        out.push_str(body);
        out.into_bytes()
    }

    fn url_for(addr: std::net::SocketAddr) -> SubscriptionUrl {
        let raw = format!("http://veyl:{}@127.0.0.1:{}/v1/mobile/profile", token(), addr.port());
        SubscriptionUrl::parse(&raw).unwrap()
    }

    async fn fetch(addr: std::net::SocketAddr) -> FetchOutcome {
        let client = client().unwrap();
        fetch_profile(&client, &url_for(addr)).await
    }

    #[tokio::test]
    async fn sends_basic_auth_and_returns_the_body() {
        let expected = {
            use base64::engine::general_purpose::STANDARD;
            use base64::Engine;
            format!("Basic {}", STANDARD.encode(format!("veyl:{}", token())))
        };
        let seen = Arc::new(std::sync::Mutex::new(String::new()));
        let seen_clone = seen.clone();
        let addr = serve(move |request| {
            *seen_clone.lock().unwrap() = request.to_string();
            response("200 OK", &[("Content-Type", "application/json")], "{\"outbounds\":[]}")
        });

        match fetch(addr).await {
            FetchOutcome::Ok(body) => assert_eq!(body, "{\"outbounds\":[]}"),
            other => panic!("期望 200，拿到 {other:?}"),
        }

        let request = seen.lock().unwrap().clone();
        assert!(
            request.contains(&format!("authorization: {expected}"))
                || request.contains(&format!("Authorization: {expected}")),
            "缺少 Basic 认证头：{request}"
        );
        // 请求行里不能出现令牌。
        let request_line = request.lines().next().unwrap_or_default();
        assert!(!request_line.contains(&token()), "令牌进了请求行：{request_line}");
    }

    #[tokio::test]
    async fn maps_forbidden() {
        let addr = serve(|_| response("403 Forbidden", &[], ""));
        assert!(matches!(fetch(addr).await, FetchOutcome::Forbidden));
    }

    #[tokio::test]
    async fn maps_rate_limit_with_retry_after() {
        let addr = serve(|_| response("429 Too Many Requests", &[("Retry-After", "2")], ""));
        match fetch(addr).await {
            FetchOutcome::RateLimited(Some(seconds)) => assert_eq!(seconds, 2),
            other => panic!("期望 429，拿到 {other:?}"),
        }
    }

    #[tokio::test]
    async fn maps_server_errors_without_leaking_the_url() {
        let addr = serve(|_| response("503 Service Unavailable", &[], "upstream down"));
        match fetch(addr).await {
            FetchOutcome::Failed(message) => {
                assert!(message.contains("503"));
                assert!(message.contains("upstream down"));
                assert!(!message.contains(&token()));
                assert!(!message.contains("127.0.0.1"));
            }
            other => panic!("期望失败，拿到 {other:?}"),
        }
    }

    /// 302 不许跟随：跟随会把 Authorization 带到 Location 指向的主机。
    #[tokio::test]
    async fn does_not_follow_redirects() {
        let target = TcpListener::bind("127.0.0.1:0").unwrap();
        let target_addr = target.local_addr().unwrap();
        let hits = Arc::new(AtomicUsize::new(0));
        let hits_clone = hits.clone();
        std::thread::spawn(move || {
            for stream in target.incoming() {
                if stream.is_ok() {
                    hits_clone.fetch_add(1, Ordering::SeqCst);
                }
            }
        });

        let location = format!("http://127.0.0.1:{}/leak", target_addr.port());
        let addr = serve(move |_| {
            response("302 Found", &[("Location", location.as_str())], "")
        });

        match fetch(addr).await {
            FetchOutcome::Failed(message) => assert!(message.contains("302"), "{message}"),
            other => panic!("期望失败，拿到 {other:?}"),
        }
        assert_eq!(hits.load(Ordering::SeqCst), 0, "居然跟随了重定向");
    }

    #[tokio::test]
    async fn accepts_exactly_the_limit() {
        let body = "a".repeat(MAX_BODY_BYTES);
        let addr = serve(move |_| response("200 OK", &[], &body));
        match fetch(addr).await {
            FetchOutcome::Ok(returned) => assert_eq!(returned.len(), MAX_BODY_BYTES),
            other => panic!("期望通过，拿到 {other:?}"),
        }
    }

    /// 上限要看实际收了多少字节，而不是信 Content-Length。
    #[tokio::test]
    async fn rejects_an_endless_body() {
        let addr = serve(|_| {
            let mut out = b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n".to_vec();
            let chunk = [b'a'; 8192];
            let header = format!("{:x}\r\n", chunk.len());
            for _ in 0..80 {
                out.extend_from_slice(header.as_bytes());
                out.extend_from_slice(&chunk);
                out.extend_from_slice(b"\r\n");
            }
            out.extend_from_slice(b"0\r\n\r\n");
            out
        });
        match fetch(addr).await {
            FetchOutcome::Failed(message) => assert!(message.contains("配置过大"), "{message}"),
            other => panic!("期望拒绝，拿到 {other:?}"),
        }
    }
}
