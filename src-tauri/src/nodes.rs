//! Shadowsocks 节点解析与导入。
//!
//! 本阶段只做 Shadowsocks：
//! - URL 模式只接受 base64 编码的多节点订阅（整段 `ss://` 列表）；
//! - 手动模式五个字段：name / server / port / password / method。
//!
//! 密码只在内存与本模块的返回结构里出现，落库时由服务层写入 `secrets.enc`。

use base64::engine::general_purpose::{STANDARD, STANDARD_NO_PAD, URL_SAFE, URL_SAFE_NO_PAD};
use base64::Engine;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::public_http;

const MAX_SUBSCRIPTION_BYTES: usize = 1024 * 1024;

/// sing-box 支持的 Shadowsocks 方法。只做 shadowsocks，不猜其它协议。
pub const SUPPORTED_METHODS: &[&str] = &[
    "aes-128-gcm",
    "aes-192-gcm",
    "aes-256-gcm",
    "aes-128-ctr",
    "aes-192-ctr",
    "aes-256-ctr",
    "chacha20-ietf-poly1305",
    "xchacha20-ietf-poly1305",
    "2022-blake3-aes-128-gcm",
    "2022-blake3-aes-256-gcm",
    "2022-blake3-chacha20-poly1305",
    "none",
];

#[derive(Clone, Serialize, Deserialize)]
pub struct ParsedNode {
    pub name: String,
    pub server: String,
    pub port: u16,
    pub method: String,
    #[serde(skip_serializing)]
    pub password: String,
}

impl std::fmt::Debug for ParsedNode {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ParsedNode")
            .field("name", &self.name)
            .field("server", &self.server)
            .field("port", &self.port)
            .field("method", &self.method)
            .field("password", &"<redacted>")
            .finish()
    }
}

/// 与 `commands.md` §4.1 的 `ImportSkipReason` 一一对应。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SkipReason {
    UnsupportedScheme,
    UnsupportedMethod,
    Malformed,
    Duplicate,
    SubscriptionEmpty,
}

impl SkipReason {
    pub fn as_str(self) -> &'static str {
        match self {
            SkipReason::UnsupportedScheme => "unsupported_scheme",
            SkipReason::UnsupportedMethod => "unsupported_method",
            SkipReason::Malformed => "malformed",
            SkipReason::Duplicate => "duplicate",
            SkipReason::SubscriptionEmpty => "subscription_empty",
        }
    }
}

#[derive(Debug, Clone)]
pub struct SkippedNode {
    pub name: Option<String>,
    pub reason: SkipReason,
    /// 只用于日志，不回显给调用方。
    pub detail: String,
}

impl SkippedNode {
    pub fn new(reason: SkipReason, detail: impl Into<String>) -> Self {
        Self {
            name: None,
            reason,
            detail: detail.into(),
        }
    }
}

#[derive(Debug, Clone, Default)]
pub struct Subscription {
    pub nodes: Vec<ParsedNode>,
    pub skipped: Vec<SkippedNode>,
}

#[derive(Debug, thiserror::Error)]
pub enum ImportError {
    #[error("{0}")]
    Unsupported(String),
    #[error("{0}")]
    Invalid(String),
    #[error("{0}")]
    Fetch(String),
}

impl ImportError {
    pub fn code(&self) -> &'static str {
        match self {
            ImportError::Unsupported(_) | ImportError::Invalid(_) => "INVALID_ARGUMENT",
            ImportError::Fetch(_) => "UPSTREAM_ERROR",
        }
    }

    pub fn reason(&self) -> &'static str {
        match self {
            ImportError::Unsupported(_) => "not_subscription",
            ImportError::Invalid(_) => "not_subscription",
            ImportError::Fetch(_) => "fetch_failed",
        }
    }
}

/// 节点去重键：`sha256(name \x1f server \x1f port \x1f method)`。
pub fn source_key(name: &str, server: &str, port: u16, method: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(format!("{name}\x1f{server}\x1f{port}\x1f{method}").as_bytes());
    hex::encode(hasher.finalize())
}

/// 节点 id：`nod_` + `sha256(source \x1f source_key)` 前 16 位。
///
/// 不同来源可以有同名同地址的两条（`docs/data-model.md` §3.2）。
pub fn node_id(source: &str, key: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(format!("{source}\x1f{key}").as_bytes());
    format!("nod_{}", &hex::encode(hasher.finalize())[..16])
}

pub fn password_ref(node_id: &str) -> String {
    format!("node:{node_id}")
}

/// 拉取并解析订阅。只解析，不连接。
pub async fn fetch_subscription(url: &str) -> Result<Subscription, ImportError> {
    let response = public_http::get(url, None, MAX_SUBSCRIPTION_BYTES)
        .await
        .map_err(ImportError::Fetch)?;
    let body = String::from_utf8(response.body)
        .map_err(|_| ImportError::Invalid("订阅内容不是 UTF-8 文本".into()))?;
    parse_subscription(&body)
}

/// 解析一段订阅：优先按 base64 解码，失败时接受已经展开的 `ss://` 列表。
pub fn parse_subscription(text: &str) -> Result<Subscription, ImportError> {
    let raw = text.trim();
    if raw.is_empty() {
        return Err(ImportError::Invalid("订阅内容为空".into()));
    }

    let compact: String = raw.chars().filter(|c| !c.is_whitespace()).collect();
    let decoded = decode_base64(&compact)
        .and_then(|bytes| String::from_utf8(bytes).ok())
        .filter(|text| text.contains("ss://"));

    let body = match decoded {
        Some(decoded) => decoded,
        None if raw.contains("ss://") => raw.to_string(),
        None => {
            return Err(ImportError::Unsupported(
                "只支持 base64 编码的 ss:// 多节点订阅".into(),
            ))
        }
    };

    let mut subscription = Subscription::default();
    for line in body.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        if !line.starts_with("ss://") {
            subscription
                .skipped
                .push(SkippedNode::new(SkipReason::UnsupportedScheme, "不是 ss:// 链接"));
            continue;
        }
        match parse_ss_uri(line) {
            Ok(node) => subscription.nodes.push(node),
            Err(error) => subscription.skipped.push(error),
        }
    }

    if subscription.nodes.is_empty() {
        if subscription.skipped.is_empty() {
            subscription
                .skipped
                .push(SkippedNode::new(SkipReason::SubscriptionEmpty, "订阅里没有节点"));
        }
        return Err(ImportError::Unsupported(
            "订阅里没有可用的 Shadowsocks 节点".into(),
        ));
    }
    Ok(subscription)
}

/// 解析单条 `ss://`。
///
/// 支持 SIP002（`ss://base64(method:password)@host:port#tag`）与旧式整段
/// base64（`ss://base64(method:password@host:port)#tag`）。
pub fn parse_ss_uri(uri: &str) -> Result<ParsedNode, SkippedNode> {
    let rest = uri
        .trim()
        .strip_prefix("ss://")
        .ok_or_else(|| SkippedNode::new(SkipReason::UnsupportedScheme, "不是 ss:// 链接"))?;

    let (before_fragment, fragment) = match rest.split_once('#') {
        Some((head, tag)) => (head, percent_decode(tag)),
        None => (rest, String::new()),
    };
    let (body, query) = match before_fragment.split_once('?') {
        Some((head, query)) => (head, query),
        None => (before_fragment, ""),
    };

    if query_has_plugin(query) {
        return Err(SkippedNode::new(
            SkipReason::Malformed,
            "暂不支持带 plugin 的 Shadowsocks 节点",
        ));
    }

    let (userinfo, hostport) = if let Some((userinfo, hostport)) = body.rsplit_once('@') {
        (userinfo.to_string(), hostport.to_string())
    } else {
        let decoded = decode_base64(body).ok_or_else(|| {
            SkippedNode::new(SkipReason::Malformed, "ss 链接不是合法的 base64")
        })?;
        let decoded = String::from_utf8(decoded)
            .map_err(|_| SkippedNode::new(SkipReason::Malformed, "ss 链接解码后不是 UTF-8"))?;
        let (userinfo, hostport) = decoded
            .rsplit_once('@')
            .ok_or_else(|| SkippedNode::new(SkipReason::Malformed, "ss 链接缺少服务器地址"))?;
        (userinfo.to_string(), hostport.to_string())
    };

    let userinfo = percent_decode(&userinfo);
    let credentials = if userinfo.contains(':') {
        userinfo
    } else {
        let decoded = decode_base64(&userinfo)
            .ok_or_else(|| SkippedNode::new(SkipReason::Malformed, "凭据不是合法的 base64"))?;
        String::from_utf8(decoded)
            .map_err(|_| SkippedNode::new(SkipReason::Malformed, "凭据不是 UTF-8"))?
    };
    let (method, password) = credentials
        .split_once(':')
        .ok_or_else(|| SkippedNode::new(SkipReason::Malformed, "缺少 method:password"))?;
    let method = method.trim().to_ascii_lowercase();
    if password.is_empty() {
        return Err(SkippedNode::new(SkipReason::Malformed, "缺少密码"));
    }
    if !SUPPORTED_METHODS.contains(&method.as_str()) {
        let mut skipped = SkippedNode::new(
            SkipReason::UnsupportedMethod,
            format!("不支持的加密方式：{method}"),
        );
        if !fragment.trim().is_empty() {
            skipped.name = Some(fragment.trim().to_string());
        }
        return Err(skipped);
    }

    let (server, port) = split_host_port(&hostport).map_err(|detail| {
        SkippedNode::new(SkipReason::Malformed, detail)
    })?;
    let name = if fragment.trim().is_empty() {
        format!("{server}:{port}")
    } else {
        fragment.trim().to_string()
    };

    Ok(ParsedNode {
        name,
        server,
        port,
        method,
        password: password.to_string(),
    })
}

/// 手动模式的输入校验。返回的字段已 trim（密码除外）。
pub fn validate_manual(
    name: &str,
    server: &str,
    port: u16,
    password: &str,
    method: &str,
) -> Result<ParsedNode, ImportError> {
    let name = name.trim();
    if name.is_empty() {
        return Err(ImportError::Invalid("节点名不能为空".into()));
    }
    if name.chars().count() > 64 {
        return Err(ImportError::Invalid("节点名最多 64 个字符".into()));
    }

    let server = server.trim();
    if server.is_empty() || server.len() > 253 {
        return Err(ImportError::Invalid("服务器地址不合法".into()));
    }
    if server.contains("://")
        || server
            .chars()
            .any(|c| c.is_whitespace() || c == '/' || c == '\\' || c.is_control())
    {
        return Err(ImportError::Invalid(
            "服务器地址只填主机名或 IP，不要带协议".into(),
        ));
    }
    if port == 0 {
        return Err(ImportError::Invalid("端口必须在 1-65535 之间".into()));
    }

    if password.trim().is_empty() {
        return Err(ImportError::Invalid("密码不能为空".into()));
    }
    if password.chars().count() > 256 {
        return Err(ImportError::Invalid("密码最多 256 个字符".into()));
    }

    let method = method.trim().to_ascii_lowercase();
    if !SUPPORTED_METHODS.contains(&method.as_str()) {
        return Err(ImportError::Unsupported(format!(
            "不支持的加密方式：{method}"
        )));
    }

    Ok(ParsedNode {
        name: name.to_string(),
        server: server.to_string(),
        port,
        method,
        password: password.to_string(),
    })
}

fn query_has_plugin(query: &str) -> bool {
    query.split('&').any(|pair| {
        let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
        key.eq_ignore_ascii_case("plugin") && !value.trim().is_empty()
    })
}

fn split_host_port(hostport: &str) -> Result<(String, u16), String> {
    let hostport = hostport.trim().trim_end_matches('/');
    let (host, port) = if let Some(rest) = hostport.strip_prefix('[') {
        let (host, after) = rest
            .split_once(']')
            .ok_or_else(|| "IPv6 地址缺少右括号".to_string())?;
        let port = after
            .strip_prefix(':')
            .ok_or_else(|| "缺少端口".to_string())?;
        (host.to_string(), port)
    } else {
        let (host, port) = hostport
            .rsplit_once(':')
            .ok_or_else(|| "缺少端口".to_string())?;
        (host.to_string(), port)
    };

    if host.trim().is_empty() {
        return Err("缺少服务器地址".into());
    }
    let port: u16 = port
        .parse()
        .map_err(|_| "端口不是 1-65535 之间的数字".to_string())?;
    if port == 0 {
        return Err("端口必须在 1-65535 之间".into());
    }
    Ok((host, port))
}

fn decode_base64(value: &str) -> Option<Vec<u8>> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return None;
    }
    for engine in [&STANDARD, &STANDARD_NO_PAD, &URL_SAFE, &URL_SAFE_NO_PAD] {
        if let Ok(bytes) = engine.decode(trimmed) {
            return Some(bytes);
        }
    }
    None
}

fn percent_decode(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            if let (Some(high), Some(low)) =
                (hex_value(bytes[index + 1]), hex_value(bytes[index + 2]))
            {
                out.push(high * 16 + low);
                index += 3;
                continue;
            }
        }
        out.push(bytes[index]);
        index += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn hex_value(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::engine::general_purpose::STANDARD;

    fn encode(value: &str) -> String {
        STANDARD.encode(value.as_bytes())
    }

    #[test]
    fn parses_sip002_with_base64_userinfo_and_tag() {
        let uri = format!(
            "ss://{}@203.0.113.10:8388#%E6%B4%9B%E6%9D%89%E7%9F%B6",
            encode("aes-256-gcm:pa:ss")
        );
        let node = parse_ss_uri(&uri).unwrap();
        assert_eq!(node.name, "洛杉矶");
        assert_eq!(node.server, "203.0.113.10");
        assert_eq!(node.port, 8388);
        assert_eq!(node.method, "aes-256-gcm");
        assert_eq!(node.password, "pa:ss");
    }

    #[test]
    fn parses_plaintext_userinfo() {
        let node = parse_ss_uri("ss://chacha20-ietf-poly1305:pw@example.com:443#Tokyo").unwrap();
        assert_eq!(node.method, "chacha20-ietf-poly1305");
        assert_eq!(node.name, "Tokyo");
    }

    #[test]
    fn parses_legacy_fully_base64_uri() {
        let uri = format!("ss://{}#Legacy", encode("aes-128-gcm:secret@198.51.100.7:9000"));
        let node = parse_ss_uri(&uri).unwrap();
        assert_eq!(node.server, "198.51.100.7");
        assert_eq!(node.port, 9000);
        assert_eq!(node.name, "Legacy");
    }

    #[test]
    fn parses_ipv6_hosts() {
        let uri = "ss://aes-256-gcm:pw@[2001:4860::1]:8388#v6";
        let node = parse_ss_uri(uri).unwrap();
        assert_eq!(node.server, "2001:4860::1");
        assert_eq!(node.port, 8388);
    }

    #[test]
    fn rejects_plugins_unsupported_methods_and_bad_ports() {
        let cases = [
            ("ss://aes-256-gcm:pw@example.com:8388/?plugin=obfs-local", SkipReason::Malformed),
            ("ss://rc4-md5:pw@example.com:8388", SkipReason::UnsupportedMethod),
            ("ss://aes-256-gcm:pw@example.com:0", SkipReason::Malformed),
            ("ss://aes-256-gcm:@example.com:8388", SkipReason::Malformed),
            ("vmess://abc", SkipReason::UnsupportedScheme),
        ];
        for (uri, expected) in cases {
            let skipped = parse_ss_uri(uri).unwrap_err();
            assert_eq!(skipped.reason, expected, "{uri}");
        }
    }

    #[test]
    fn parses_a_base64_multi_node_subscription() {
        let list = [
            format!("ss://{}@203.0.113.10:8388#A", encode("aes-256-gcm:pw-a")),
            format!("ss://{}@203.0.113.11:8388#B", encode("aes-256-gcm:pw-b")),
            "vmess://unsupported".to_string(),
        ]
        .join("\n");
        let subscription = parse_subscription(&encode(&list)).unwrap();
        assert_eq!(subscription.nodes.len(), 2);
        assert_eq!(subscription.skipped.len(), 1);
        assert_eq!(
            subscription.skipped[0].reason,
            SkipReason::UnsupportedScheme
        );
        assert_eq!(subscription.nodes[0].name, "A");
        assert_eq!(subscription.nodes[1].password, "pw-b");
    }

    #[test]
    fn accepts_a_plain_ss_list_too_and_reports_garbage() {
        let text = "ss://aes-256-gcm:pw@203.0.113.10:8388#A\nnot-a-node";
        let subscription = parse_subscription(text).unwrap();
        assert_eq!(subscription.nodes.len(), 1);
        assert_eq!(subscription.skipped.len(), 1);
    }

    #[test]
    fn a_subscription_without_ss_nodes_is_unsupported() {
        let error = parse_subscription("vmess://a\nvmess://b").unwrap_err();
        assert_eq!(error.code(), "INVALID_ARGUMENT");
        assert!(matches!(error, ImportError::Unsupported(_)));
    }

    #[test]
    fn manual_validation_normalises_fields() {
        let node = validate_manual(
            "  洛杉矶 ",
            " 203.0.113.10 ",
            8388,
            "pw",
            "AES-256-GCM",
        )
        .unwrap();
        assert_eq!(node.name, "洛杉矶");
        assert_eq!(node.server, "203.0.113.10");
        assert_eq!(node.method, "aes-256-gcm");
        assert_eq!(node.password, "pw");
    }

    #[test]
    fn manual_validation_rejects_bad_input() {
        assert!(validate_manual("", "203.0.113.10", 8388, "pw", "aes-256-gcm").is_err());
        assert!(validate_manual("n", "https://x", 8388, "pw", "aes-256-gcm").is_err());
        assert!(validate_manual("n", "203.0.113.10", 0, "pw", "aes-256-gcm").is_err());
        assert!(validate_manual("n", "203.0.113.10", 8388, " ", "aes-256-gcm").is_err());
        assert!(validate_manual("n", "203.0.113.10", 8388, "pw", "rc4-md5").is_err());
    }

    #[test]
    fn parsed_nodes_never_serialise_or_debug_the_password() {
        let node = validate_manual("n", "203.0.113.10", 8388, "pw", "aes-256-gcm").unwrap();
        let text = serde_json::to_string(&node).unwrap();
        assert!(!text.contains("pw"), "{text}");
        assert!(!text.contains("password"), "{text}");
        let debug = format!("{node:?}");
        assert!(!debug.contains("pw"), "{debug}");
        assert!(debug.contains("<redacted>"));
    }

    #[test]
    fn identity_helpers_are_stable_and_source_sensitive() {
        let key = source_key("A", "203.0.113.10", 8388, "aes-256-gcm");
        assert_eq!(key.len(), 64);
        assert_eq!(
            node_id("url", &key),
            node_id("url", &key),
            "同来源同身份必须稳定"
        );
        assert_ne!(
            node_id("url", &key),
            node_id("manual", &key),
            "不同来源允许同名同地址两条"
        );
        assert!(node_id("url", &key).starts_with("nod_"));
    }
}
