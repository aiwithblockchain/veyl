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

/// 只保留 `scheme://host:port`，丢掉 userinfo、路径和查询串。
///
/// 订阅链接常把凭据放在 userinfo 里（`https://user:pass@host/sub`），
/// 这些串一旦进日志或错误提示就等于把密码交出去了。
fn safe_url(url: &reqwest::Url) -> String {
    let host = url.host_str().unwrap_or("-");
    match url.port() {
        Some(port) => format!("{}://{host}:{port}", url.scheme()),
        None => format!("{}://{host}", url.scheme()),
    }
}

/// reqwest 的 `Display` 会带上整条 URL（含 userinfo）。只取分类，自己拼安全地址。
fn describe_send_error(error: &reqwest::Error, url: &reqwest::Url) -> String {
    let kind = if error.is_timeout() {
        "请求超时"
    } else if error.is_connect() {
        "连接失败"
    } else if error.is_body() || error.is_decode() {
        "响应读取失败"
    } else {
        "请求失败"
    };
    format!("{kind}（{}）", safe_url(url))
}

/// 一个响应该走哪条路。
#[derive(Debug, Clone, PartialEq, Eq)]
enum Step {
    /// 需要跟随 `Location`。
    Follow(String),
    /// 304：内容没变，没有 body，**不需要 Location**。
    NotModified,
    /// 2xx：继续读 body。
    Success,
    /// 其它：失败。
    Failure,
}

/// 只看状态码与 `Location` 决定下一步。
///
/// **304 必须排在跳转判断之前。** 它属于 3xx，但没有 `Location`；
/// 按跳转处理会直接报「重定向缺少 Location」，于是带 ETag 的条件请求
/// 永远拿不到结果——种子在内容丢失后就再也修不回来。
fn decide(status: u16, location: Option<&str>) -> Result<Step, String> {
    if status == 304 {
        return Ok(Step::NotModified);
    }
    if (300..=399).contains(&status) {
        let location = location.ok_or_else(|| "重定向缺少 Location".to_string())?;
        return Ok(Step::Follow(location.to_string()));
    }
    if (200..=299).contains(&status) {
        return Ok(Step::Success);
    }
    Ok(Step::Failure)
}

/// 发起一次受限 GET。`if_none_match` 只作用于第一跳（条件请求）。
pub async fn get(
    url: &str,
    if_none_match: Option<&str>,
    max_bytes: usize,
) -> Result<PublicResponse, String> {
    // 不把解析器的原始报错放进返回串：`Url::parse` 的 Display 会**回显整条输入**，
    // 而订阅链接里常常带 `user:pass@`。
    let mut current = reqwest::Url::parse(url).map_err(|_| "地址无效".to_string())?;

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
            .map_err(|error| describe_send_error(&error, &current))?;
        let status = response.status();
        let location = response
            .headers()
            .get(LOCATION)
            .and_then(|value| value.to_str().ok());

        match decide(status.as_u16(), location)? {
            Step::Follow(target) => {
                // 同样不回显：报错里会带上这条 location。
                current = current
                    .join(&target)
                    .map_err(|_| "重定向地址无效".to_string())?;
                continue;
            }
            Step::NotModified => {
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
            Step::Success => {}
            Step::Failure => return Err(format!("远程返回 HTTP {status}")),
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
            let chunk = chunk.map_err(|error| describe_send_error(&error, &current))?;
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

    /// 每个被拒网段的两侧边界。只写「10.1.2.3 被拒」测不出掩码写错——
    /// 把 /8 写成 /12 照样能拒 10.1.2.3，但会误伤 10.16.0.1 之类。
    #[test]
    fn cidr_boundaries_are_exact() {
        // (网段内应拒, 紧邻网段外应放行)
        let cases = [
            ("10.0.0.0", "11.0.0.0"),           // 10/8
            ("172.16.0.0", "172.15.255.255"),   // 172.16/12 下边界
            ("172.31.255.255", "172.32.0.0"),   // 172.16/12 上边界
            ("192.168.0.0", "192.167.255.255"), // 192.168/16
            ("100.64.0.0", "100.63.255.255"),   // 100.64/10 下边界
            ("100.127.255.255", "100.128.0.0"), // 100.64/10 上边界
            ("198.18.0.0", "198.17.255.255"),   // 198.18/15 下边界
            ("198.19.255.255", "198.20.0.0"),   // 198.18/15 上边界
            ("169.254.0.0", "169.253.255.255"), // 169.254/16
            ("127.0.0.0", "126.255.255.255"),   // 127/8
        ];
        for (inside, outside) in cases {
            assert!(!is_public_ip(ip(inside)), "{inside} 在保留段内，应被拒");
            assert!(is_public_ip(ip(outside)), "{outside} 是网段外，应放行");
        }
    }

    #[test]
    fn ipv4_reserved_ranges_are_rejected() {
        for value in [
            "192.0.0.1",   // 192.0.0/24 IETF 协议分配
            "192.88.99.1", // 6to4 中继任播
            "240.0.0.1",   // 240/4 保留
            "255.255.255.254",
        ] {
            assert!(!is_public_ip(ip(value)), "{value} 是保留地址，应被拒");
        }
    }

    #[test]
    fn ipv6_unicast_local_and_site_local_are_rejected() {
        for value in [
            "fec0::1",     // fec0::/10 站点本地（已废弃但仍可能被解析）
            "fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff", // fc00::/7 上边界
            "::ffff:10.0.0.1",  // IPv4 映射到内网
            "::ffff:192.168.1.1",
        ] {
            assert!(!is_public_ip(ip(value)), "{value} 不应被视为公网地址");
        }
    }

    #[test]
    fn ipv4_mapped_public_address_passes() {
        // `::ffff:8.8.8.8` 走的是 v4 判定分支，边界必须与 v4 一致。
        assert!(is_public_ip(ip("::ffff:8.8.8.8")));
        assert!(is_public_ip(ip("::ffff:185.199.108.153")));
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

    /// **这条 bug 之前没有测试才活下来**：304 属于 3xx，但永远没有 Location。
    #[test]
    fn a_304_is_not_treated_as_a_redirect() {
        assert_eq!(decide(304, None).unwrap(), Step::NotModified);
        assert_eq!(decide(304, Some("/ignored")).unwrap(), Step::NotModified);
    }

    #[test]
    fn real_redirects_still_require_a_location() {
        for status in [301, 302, 303, 307, 308] {
            assert_eq!(
                decide(status, Some("/next")).unwrap(),
                Step::Follow("/next".into())
            );
            assert!(decide(status, None).is_err(), "{status} 缺 Location 应当报错");
        }
        // 300/305/306 仍按跳转处理：不趁这次改动改变既有行为。
        for status in [300, 305, 306] {
            assert_eq!(
                decide(status, Some("/next")).unwrap(),
                Step::Follow("/next".into())
            );
        }
    }

    #[test]
    fn success_and_failure_fall_where_expected() {
        assert_eq!(decide(200, None).unwrap(), Step::Success);
        assert_eq!(decide(204, None).unwrap(), Step::Success);
        assert_eq!(decide(404, None).unwrap(), Step::Failure);
        assert_eq!(decide(500, None).unwrap(), Step::Failure);
    }

    #[test]
    fn error_text_never_carries_credentials_from_the_url() {
        let url =
            reqwest::Url::parse("https://user:hunter2@example.com/sub?token=abc").unwrap();
        let text = safe_url(&url);
        assert_eq!(text, "https://example.com");
        assert!(!text.contains("hunter2"), "{text}");
        assert!(!text.contains("token"), "{text}");
    }

    #[test]
    fn safe_url_keeps_the_port_and_drops_everything_else() {
        let url = reqwest::Url::parse("http://203.0.113.9:8080/x/y?z=1").unwrap();
        assert_eq!(safe_url(&url), "http://203.0.113.9:8080");
    }
}
