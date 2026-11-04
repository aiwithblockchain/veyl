//! 面向不可信 URL 的受限 HTTP 客户端。
//!
//! 种子与用户订阅都由我们发起请求，因此必须防 SSRF：
//! - 只允许 HTTPS；
//! - 解析到的每个地址都必须是公网地址（禁止本机 / 内网 / 链路本地 / 保留段）；
//! - 每一跳重定向都重新校验，且把连接固定到已校验的 IP（防 DNS rebinding）；
//! - 限制响应大小、超时与重定向次数。

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::time::Duration;

use futures_util::StreamExt;
use reqwest::header::{ACCEPT, CONTENT_LENGTH, ETAG, IF_NONE_MATCH, LOCATION};
use serde_json::Value;

const MAX_REDIRECTS: usize = 3;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Debug, Clone)]
pub struct PublicResponse {
    pub status: u16,
    pub etag: Option<String>,
    pub body: Vec<u8>,
}

/// 发起一次受限 GET。`if_none_match` 只作用于第一跳（条件请求）。
pub async fn get(
    url: &str,
    if_none_match: Option<&str>,
    max_bytes: usize,
) -> Result<PublicResponse, String> {
    let mut current = reqwest::Url::parse(url).map_err(|error| format!("地址无效：{error}"))?;

    for hop in 0..=MAX_REDIRECTS {
        ensure_allowed_url(&current)?;
        let (host, address) = resolve_public(&current).await?;

        let client = reqwest::Client::builder()
            .timeout(REQUEST_TIMEOUT)
            .redirect(reqwest::redirect::Policy::none())
            // 种子是最后的恢复手段：绝不能跟随系统代理，否则代理坏了
            // 就永远拉不到种子、修不好。也让 DNS pinning 真正有效。
            .no_proxy()
            .resolve(&host, address)
            .build()
            .map_err(|error| format!("创建下载客户端失败：{error}"))?;

        let mut request = client
            .get(current.clone())
            .header(ACCEPT, "application/json, text/plain;q=0.9, */*;q=0.1");
        if hop == 0 {
            if let Some(etag) = if_none_match {
                request = request.header(IF_NONE_MATCH, etag);
            }
        }

        let response = request
            .send()
            .await
            .map_err(|error| format!("请求失败：{error}"))?;
        let status = response.status();

        if status.is_redirection() {
            let location = response
                .headers()
                .get(LOCATION)
                .and_then(|value| value.to_str().ok())
                .ok_or_else(|| "重定向缺少 Location".to_string())?;
            current = current
                .join(location)
                .map_err(|error| format!("重定向地址无效：{error}"))?;
            continue;
        }

        if status.as_u16() == 304 {
            return Ok(PublicResponse {
                status: 304,
                etag: response
                    .headers()
                    .get(ETAG)
                    .and_then(|value| value.to_str().ok())
                    .map(str::to_string)
                    .or_else(|| if_none_match.map(str::to_string)),
                body: Vec::new(),
            });
        }

        if !status.is_success() {
            return Err(format!("远程返回 HTTP {status}"));
        }

        if let Some(length) = response
            .headers()
            .get(CONTENT_LENGTH)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.parse::<u64>().ok())
        {
            if length > max_bytes as u64 {
                return Err(format!("响应超过上限（{} 字节）", max_bytes));
            }
        }

        let etag = response
            .headers()
            .get(ETAG)
            .and_then(|value| value.to_str().ok())
            .map(str::to_string);

        let mut body = Vec::new();
        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|error| format!("读取响应失败：{error}"))?;
            if body.len() + chunk.len() > max_bytes {
                return Err(format!("响应超过上限（{} 字节）", max_bytes));
            }
            body.extend_from_slice(&chunk);
        }

        return Ok(PublicResponse {
            status: status.as_u16(),
            etag,
            body,
        });
    }

    Err("重定向次数过多".into())
}

/// 解析并校验 JSON（种子等）时复用：内容必须是一个 JSON 对象。
pub fn parse_json_object(bytes: &[u8]) -> Result<Value, String> {
    serde_json::from_slice(bytes).map_err(|error| format!("内容不是合法 JSON：{error}"))
}

fn ensure_allowed_url(url: &reqwest::Url) -> Result<(), String> {
    if url.scheme() != "https" {
        return Err("只允许 HTTPS 地址".into());
    }
    if url.username() != "" || url.password().is_some() {
        return Err("地址里不能包含用户名或密码".into());
    }
    let host = url
        .host_str()
        .filter(|host| !host.is_empty())
        .ok_or_else(|| "地址缺少主机名".to_string())?;

    // IP 字面量先直接判断，避免把内网 IP 交给 DNS。
    let bare_host = host.trim_start_matches('[').trim_end_matches(']');
    if let Ok(ip) = bare_host.parse::<IpAddr>() {
        if !is_public_ip(ip) {
            return Err("地址指向内网或保留地址，已拒绝".into());
        }
    }
    Ok(())
}

async fn resolve_public(url: &reqwest::Url) -> Result<(String, SocketAddr), String> {
    let host = url
        .host_str()
        .filter(|host| !host.is_empty())
        .ok_or_else(|| "地址缺少主机名".to_string())?
        .to_string();
    let port = url.port_or_known_default().unwrap_or(443);

    let addresses: Vec<SocketAddr> = tokio::net::lookup_host((host.as_str(), port))
        .await
        .map_err(|error| format!("域名解析失败：{error}"))?
        .collect();
    if addresses.is_empty() {
        return Err("域名没有解析到任何地址".into());
    }
    for address in &addresses {
        if !is_public_ip(address.ip()) {
            return Err("域名解析到内网或保留地址，已拒绝".into());
        }
    }

    // 固定到已校验的第一个地址，防止校验后 DNS 再次变化。
    Ok((host, addresses[0]))
}

pub fn is_public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => is_public_v4(v4),
        IpAddr::V6(v6) => is_public_v6(v6),
    }
}

fn is_public_v4(ip: Ipv4Addr) -> bool {
    let o = ip.octets();
    // 0.0.0.0/8、10/8、127/8、169.254/16、172.16/12、192.168/16
    if o[0] == 0 || o[0] == 10 || o[0] == 127 {
        return false;
    }
    if o[0] == 169 && o[1] == 254 {
        return false;
    }
    if o[0] == 172 && (16..=31).contains(&o[1]) {
        return false;
    }
    if o[0] == 192 && o[1] == 168 {
        return false;
    }
    // 100.64/10（运营商级 NAT）
    if o[0] == 100 && (64..=127).contains(&o[1]) {
        return false;
    }
    // 192.0.0/24、192.0.2/24、192.88.99/24
    if o[0] == 192 && o[1] == 0 || (o[0] == 192 && o[1] == 88 && o[2] == 99) {
        return false;
    }
    // 198.18/15（基准测试）、198.51.100/24、203.0.113/24（文档）
    if o[0] == 198 && (o[1] == 18 || o[1] == 19 || (o[1] == 51 && o[2] == 100)) {
        return false;
    }
    if o[0] == 203 && o[1] == 0 && o[2] == 113 {
        return false;
    }
    // 224/4 组播、240/4 保留、255.255.255.255
    if o[0] >= 224 {
        return false;
    }
    true
}

fn is_public_v6(ip: Ipv6Addr) -> bool {
    if let Some(mapped) = ip.to_ipv4_mapped() {
        return is_public_v4(mapped);
    }
    let segments = ip.segments();
    if ip.is_unspecified() || ip.is_loopback() || ip.is_multicast() {
        return false;
    }
    // fc00::/7 唯一本地地址
    if segments[0] & 0xfe00 == 0xfc00 {
        return false;
    }
    // fe80::/10 链路本地、fec0::/10 站点本地
    if segments[0] & 0xffc0 == 0xfe80 || segments[0] & 0xffc0 == 0xfec0 {
        return false;
    }
    // 2001:db8::/32 文档地址
    if segments[0] == 0x2001 && segments[1] == 0x0db8 {
        return false;
    }
    // 64:ff9b::/96 NAT64：内网 IPv4 可以嵌在里面重新包装成公网形式
    if segments[0] == 0x0064 && segments[1] == 0xff9b {
        return false;
    }
    // 2002::/16 6to4：同样可以内嵌内网 IPv4
    if segments[0] == 0x2002 {
        return false;
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ip(value: &str) -> IpAddr {
        value.parse().unwrap()
    }

    #[test]
    fn private_and_reserved_addresses_are_not_public() {
        for value in [
            "0.0.0.0",
            "10.1.2.3",
            "100.64.0.1",
            "127.0.0.1",
            "169.254.1.1",
            "172.16.0.1",
            "172.31.255.255",
            "192.0.2.1",
            "192.168.1.1",
            "198.18.0.1",
            "198.51.100.1",
            "203.0.113.1",
            "224.0.0.1",
            "255.255.255.255",
            "::",
            "::1",
            "fc00::1",
            "fd12:3456::1",
            "fe80::1",
            "ff02::1",
            "2001:db8::1",
            "64:ff9b::10.0.0.1",
            "2002:0a00:0001::1",
            "::ffff:127.0.0.1",
        ] {
            assert!(!is_public_ip(ip(value)), "{value} 不应被视为公网地址");
        }
    }

    #[test]
    fn ordinary_public_addresses_pass() {
        for value in ["1.1.1.1", "8.8.8.8", "185.199.108.153", "2606:4700::1111"] {
            assert!(is_public_ip(ip(value)), "{value} 应是公网地址");
        }
    }

    #[test]
    fn non_https_and_credentials_are_rejected_before_any_request() {
        for url in [
            "http://example.com/x",
            "ftp://example.com/x",
            "https://user:pass@example.com/x",
            "https://127.0.0.1/x",
            "https://10.0.0.1/x",
            "https://[::1]/x",
        ] {
            let parsed = reqwest::Url::parse(url).unwrap();
            assert!(ensure_allowed_url(&parsed).is_err(), "{url} 应被拒绝");
        }
    }
}
