//! 订阅链接的解析、归一化与打码。
//!
//! 链接形如 `https://veyl:<token>@<origin>/v1/mobile/profile`，令牌就是凭据，
//! 因此这个类型**只以打码形式**出现在 `Display` / `Debug` / 错误文案里；
//! 完整链接只能通过 [`SubscriptionUrl::as_str`] 显式取出，交给密钥存储。
//!
//! 规则来自 `client/docs/client-apps-technical.md` §6.2 与
//! `docs/design/mobile-export-technical.md` §1.2。

use std::fmt;

use crate::error::{AppError, AppResult};

const PROFILE_PATH: &str = "/v1/mobile/profile";
const TOKEN_PREFIX: &str = "mp_";
/// `mp_` + 32 字节随机数的 base64url = 46 个字符。
const TOKEN_LEN: usize = 46;

pub struct SubscriptionUrl {
    url: url::Url,
    token: String,
}

impl SubscriptionUrl {
    pub fn parse(raw: &str) -> AppResult<Self> {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            return Err(AppError::invalid("订阅链接是空的").with_hint("粘贴桌面端给出的完整链接。"));
        }

        let mut url = url::Url::parse(trimmed).map_err(|_| {
            AppError::invalid("这不是一个合法的链接")
                .with_hint("链接应该以 https:// 开头，从桌面端直接复制。")
        })?;

        match url.scheme() {
            "https" => {}
            "http" if is_loopback(&url) => {}
            "http" => {
                return Err(AppError::invalid("订阅链接必须用 https")
                    .with_reason("http 会把链接里的令牌明文发到网络上")
                    .with_hint("把链接开头的 http:// 换成 https:// 再试。"));
            }
            _ => {
                return Err(AppError::invalid("只支持 http(s) 链接")
                    .with_hint("从桌面端复制以 https:// 开头的订阅链接。"));
            }
        }

        // 先看有没有把令牌塞进查询串：这种写法最常见，也最容易泄漏。
        if url.query().is_some() || url.fragment().is_some() {
            return Err(AppError::invalid("链接不能带查询参数或锚点")
                .with_reason("令牌只能放在用户名密码段，放进查询串会进访问日志")
                .with_hint("只保留 https://veyl:<令牌>@主机/v1/mobile/profile 这一段。"));
        }

        let token = url.password().map(str::to_string).unwrap_or_default();
        if token.is_empty() {
            return Err(AppError::invalid("链接里没有令牌")
                .with_reason("桌面端给出的链接形如 https://veyl:<令牌>@主机/v1/mobile/profile")
                .with_hint("回桌面端重新复制一次完整链接。"));
        }
        if !valid_token(&token) {
            return Err(AppError::invalid("链接里的令牌形态不对")
                .with_hint("回桌面端重新复制一次完整链接，不要手动改动。"));
        }

        let path = url.path().trim_end_matches('/');
        if path != PROFILE_PATH {
            return Err(AppError::invalid("这不是 Veyl 的订阅链接")
                .with_reason(format!("路径应当以 {PROFILE_PATH} 结尾"))
                .with_hint("从桌面端「在其它设备上使用」里复制 veyl-cli 那一行。"));
        }

        // 服务端只校验密码，用户名归一化即可（§1.2）。
        let _ = url.set_username("veyl");

        Ok(Self { url, token })
    }

    /// 完整链接（含令牌）。只给密钥存储用，不要写日志、不要进命令返回值。
    pub fn as_str(&self) -> &str {
        self.url.as_str()
    }

    pub fn token(&self) -> &str {
        &self.token
    }

    /// 主机（含非默认端口），用于界面显示来源。
    pub fn host(&self) -> String {
        match self.url.port() {
            Some(port) => format!("{}:{port}", self.url.host_str().unwrap_or("")),
            None => self.url.host_str().unwrap_or("").to_string(),
        }
    }

    pub fn masked(&self) -> String {
        format!("{}://veyl:***@{}{}", self.url.scheme(), self.host(), PROFILE_PATH)
    }
}

impl fmt::Display for SubscriptionUrl {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.masked())
    }
}

impl fmt::Debug for SubscriptionUrl {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.masked())
    }
}

fn is_loopback(url: &url::Url) -> bool {
    match url.host_str() {
        Some("localhost") => true,
        Some(host) => host
            .trim_matches(|c| c == '[' || c == ']')
            .parse::<std::net::IpAddr>()
            .map(|ip| ip.is_loopback())
            .unwrap_or(false),
        None => false,
    }
}

fn valid_token(token: &str) -> bool {
    token.len() == TOKEN_LEN
        && token.starts_with(TOKEN_PREFIX)
        && token[TOKEN_PREFIX.len()..]
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

#[cfg(test)]
mod tests {
    use super::*;

    fn token() -> String {
        format!("mp_{}", "a".repeat(43))
    }

    fn link(host: &str) -> String {
        format!("https://veyl:{}@{host}/v1/mobile/profile", token())
    }

    #[test]
    fn parses_a_real_shaped_link() {
        let parsed = SubscriptionUrl::parse(&link("vpn.example.com")).unwrap();
        assert_eq!(parsed.token(), token());
        assert_eq!(parsed.host(), "vpn.example.com");
    }

    #[test]
    fn normalizes_the_username() {
        let raw = format!("https://someone:{}@vpn.example.com/v1/mobile/profile", token());
        let parsed = SubscriptionUrl::parse(&raw).unwrap();
        assert!(parsed.as_str().starts_with("https://veyl:"));
    }

    #[test]
    fn accepts_a_trailing_slash() {
        let raw = format!("https://veyl:{}@vpn.example.com/v1/mobile/profile/", token());
        assert!(SubscriptionUrl::parse(&raw).is_ok());
    }

    #[test]
    fn rejects_a_link_without_a_token() {
        let error = SubscriptionUrl::parse("https://vpn.example.com/v1/mobile/profile").unwrap_err();
        assert_eq!(error.code, "INVALID_ARGUMENT");
        assert!(error.reason.contains("令牌"));
    }

    #[test]
    fn rejects_plain_http_for_remote_hosts() {
        let raw = format!("http://veyl:{}@vpn.example.com/v1/mobile/profile", token());
        let error = SubscriptionUrl::parse(&raw).unwrap_err();
        assert!(error.message.contains("https"));
    }

    #[test]
    fn allows_http_only_on_loopback() {
        let raw = format!("http://veyl:{}@127.0.0.1:8123/v1/mobile/profile", token());
        let parsed = SubscriptionUrl::parse(&raw).unwrap();
        assert_eq!(parsed.host(), "127.0.0.1:8123");
    }

    #[test]
    fn rejects_query_or_fragment_tokens() {
        let raw = format!("https://vpn.example.com/v1/mobile/profile?token={}", token());
        let error = SubscriptionUrl::parse(&raw).unwrap_err();
        assert!(error.message.contains("查询参数"));

        let raw = format!("https://veyl:{}@vpn.example.com/v1/mobile/profile#Veyl", token());
        assert!(SubscriptionUrl::parse(&raw).is_err());
    }

    #[test]
    fn rejects_other_paths() {
        let raw = format!("https://veyl:{}@vpn.example.com/v1/mobile/profile/clash", token());
        let error = SubscriptionUrl::parse(&raw).unwrap_err();
        assert!(error.message.contains("不是 Veyl 的订阅链接"));
    }

    #[test]
    fn rejects_a_malformed_token() {
        let raw = "https://veyl:short@vpn.example.com/v1/mobile/profile";
        assert!(SubscriptionUrl::parse(raw).is_err());
        let raw = format!("https://veyl:{}@vpn.example.com/v1/mobile/profile", "x".repeat(46));
        assert!(SubscriptionUrl::parse(&raw).is_err());
    }

    #[test]
    fn never_prints_the_token() {
        let parsed = SubscriptionUrl::parse(&link("vpn.example.com")).unwrap();
        let shown = format!("{parsed} {parsed:?}");
        assert!(shown.contains("veyl:***@vpn.example.com"));
        assert!(!shown.contains(&token()));
        assert_eq!(parsed.masked(), "https://veyl:***@vpn.example.com/v1/mobile/profile");
    }
}
