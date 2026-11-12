//! 问题报告的脱敏（`docs/design/issue-report.md` §6 / §6.1）。
//!
//! 处理顺序固定：**整值替换（节点地址 / 节点名 / 配置名）→ `logging::mask_secrets`
//! → 模式规则（IP、域名、URL、邮箱、手机号、家目录）**。顺序反了，`mask_secrets`
//! 就看不到原始凭据形态。
//!
//! 唯一占位符是 `***`；不做半掩码（`goo***.com` 这类既不能读也不能查）。

use serde::Serialize;
use serde_json::{json, Value};

use crate::logging::mask_secrets;

pub const REDACTION_MARKER: &str = "***";

/// 可注册域的后缀表。没有引入 PSL 依赖：只列常见多段后缀，
/// 其余按「保留最后两段」退化（设计文档明确这是已知局限）。
const MULTI_LABEL_SUFFIXES: &[&str] = &[
    "co.uk", "org.uk", "gov.uk", "ac.uk", "co.jp", "ne.jp", "or.jp", "com.cn", "net.cn",
    "org.cn", "gov.cn", "com.tw", "com.hk", "com.sg", "com.au", "net.au", "org.au", "co.nz",
    "co.kr", "co.in", "com.br", "com.mx", "com.tr", "com.ru", "com.ua", "co.za", "com.ar",
];

#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize)]
pub struct RedactionCounts {
    pub domains: usize,
    pub public_ips: usize,
    pub paths: usize,
    pub urls: usize,
    pub node_refs: usize,
    pub config_refs: usize,
    /// `mask_secrets` 实际改写的 token 数（凭据形态）。
    pub secrets: usize,
}

#[derive(Debug, Clone)]
pub struct Redactor {
    include_domains: bool,
    counts: RedactionCounts,
    /// 节点服务器地址：整值替换成 `***`，任何模式都不出现。
    node_hosts: Vec<String>,
    /// 节点名 / 配置名 → `节点 N` / `配置 N`（长的先换，避免子串吃掉）。
    aliases: Vec<(String, String)>,
}

impl Redactor {
    pub fn new(include_domains: bool) -> Self {
        Self {
            include_domains,
            counts: RedactionCounts::default(),
            node_hosts: Vec::new(),
            aliases: Vec::new(),
        }
    }

    /// 注册节点地址与名字。节点地址优先于名字替换。
    pub fn with_aliases(
        mut self,
        node_hosts: Vec<String>,
        node_names: Vec<String>,
        config_names: Vec<String>,
    ) -> Self {
        self.node_hosts = node_hosts
            .into_iter()
            .filter(|host| !host.trim().is_empty())
            .collect();
        let mut aliases = Vec::new();
        for (index, name) in node_names.into_iter().enumerate() {
            if !name.trim().is_empty() {
                aliases.push((name, format!("节点 {}", index + 1)));
            }
        }
        for (index, name) in config_names.into_iter().enumerate() {
            if !name.trim().is_empty() {
                aliases.push((name, format!("配置 {}", index + 1)));
            }
        }
        aliases.sort_by(|a, b| b.0.len().cmp(&a.0.len()));
        self.aliases = aliases;
        self
    }

    pub fn counts(&self) -> &RedactionCounts {
        &self.counts
    }

    pub fn include_domains(&self) -> bool {
        self.include_domains
    }

    /// 脱敏一段自由文本。
    pub fn redact(&mut self, text: &str) -> String {
        let mut out = text.to_string();
        for host in &self.node_hosts {
            let hits = out.matches(host.as_str()).count();
            if hits > 0 {
                self.counts.node_refs += hits;
                out = out.replace(host, REDACTION_MARKER);
            }
        }
        for (actual, alias) in &self.aliases {
            let hits = out.matches(actual.as_str()).count();
            if hits > 0 {
                if alias.starts_with("节点") {
                    self.counts.node_refs += hits;
                } else {
                    self.counts.config_refs += hits;
                }
                out = out.replace(actual, alias);
            }
        }

        // 路径先归约，再做凭据掩码；但**带 `/` 的 token 不进 `mask_secrets`**：
        // `/` 属于「凭据形态」的字符集，一整条路径会被当成一个长 base64 token
        // 整段打成 `***`，家目录与文件结构就没了。URL 的 userinfo 由 URL 规则处理。
        let paths = self.redact_home_paths(&out);
        // 凭据键要在 `mask_secrets` **之前**处理：否则 `password=hunter2` 会整串
        // 被当成 base64，连键名一起打掉，报告里就看不出是哪个字段。
        let pairs = self.mask_credential_pairs(&paths);
        self.mask_tokens(&pairs)
    }

    /// 凭据键（`key=` / `key:`）命中时，把**整个值**换成 `***`。
    ///
    /// 值可能带认证方案（`Bearer `、`Basic `）与后续令牌，也可能含空格，
    /// 所以要按「键 + 分隔符 + 值范围」在原文上定位，而不是按空白切词。
    fn mask_credential_pairs(&mut self, text: &str) -> String {
        const SCHEMES: &[&str] = &["bearer", "basic", "digest", "token", "bot", "negotiate", "ntlm"];
        let mut out = text.to_string();
        let mut index = 0usize;
        while index < out.len() {
            let Some((key, separator_at)) = parse_key_at(&out, index) else {
                index += char_len_at(&out, index);
                continue;
            };
            if !is_credential_key(key) {
                index = separator_at;
                continue;
            }
            let separator_end = separator_at + 1; // '=' 或 ':'（ASCII）
            let Some(value_start) = skip_spaces(&out, separator_end) else {
                index = separator_end;
                continue;
            };
            let Some(mut value_end) = word_end(&out, value_start) else {
                index = separator_end;
                continue;
            };
            // `Bearer abc123`：把认证方案和它后面的令牌一起算进值范围。
            let first = out[value_start..value_end].to_ascii_lowercase();
            if SCHEMES.contains(&first.as_str()) {
                if let Some(next_start) = skip_spaces(&out, value_end) {
                    if let Some(next_end) = word_end(&out, next_start) {
                        value_end = next_end;
                    }
                }
            }
            if value_end > value_start {
                out.replace_range(value_start..value_end, REDACTION_MARKER);
            }
            self.counts.secrets += 1;
            index = value_start + REDACTION_MARKER.len();
        }
        out
    }

    /// 逐 token 掩码凭据；只统计真正被改写的 token。
    fn mask_tokens(&mut self, text: &str) -> String {
        let mut out = String::with_capacity(text.len());
        let mut word = String::new();
        let flush = |word: &mut String, out: &mut String, this: &mut Self| {
            if word.is_empty() {
                return;
            }
            // `key=value`：只对值跑掩码，键名保留；结构类键的值原样。
            if let Some((key, value)) = word.split_once('=') {
                if !key.is_empty() && is_plain_key(key) {
                    out.push_str(word);
                    word.clear();
                    return;
                }
                let (masked, changed) = mask_token(value);
                if changed {
                    this.counts.secrets += 1;
                }
                out.push_str(key);
                out.push('=');
                out.push_str(&masked);
                word.clear();
                return;
            }
            let (masked, changed) = mask_token(word);
            if changed {
                this.counts.secrets += 1;
            }
            out.push_str(&masked);
            word.clear();
        };
        for ch in text.chars() {
            if ch.is_whitespace() {
                flush(&mut word, &mut out, self);
                out.push(ch);
            } else {
                word.push(ch);
            }
        }
        flush(&mut word, &mut out, self);
        out
    }

    /// 家目录：`/Users/<x>`、`/home/<x>`、`C:\Users\<x>` → `~`，其余路径结构保留。
    fn redact_home_paths(&mut self, text: &str) -> String {
        let mut out = text.to_string();
        for prefix in ["/Users/", "/home/", "C:\\Users\\", "c:\\Users\\"] {
            let mut search_from = 0usize;
            while let Some(found) = out[search_from..].find(prefix) {
                let start = search_from + found;
                // 只在 token 开头或紧跟在 `=` 之后折叠：`some/home/alice` 里
                // 的 `/home/` 不是主目录，折了会产出 `some~` 这种残片。
                let previous = out[..start].chars().last();
                let at_boundary = match previous {
                    None => true,
                    Some(ch) => ch.is_whitespace() || matches!(ch, '=' | '"' | '\''),
                };
                if !at_boundary {
                    search_from = start + prefix.len();
                    continue;
                }
                let after = start + prefix.len();
                let rest = &out[after..];
                let take = rest
                    .find(|ch: char| matches!(ch, '/' | '\\' | ' ' | '\t' | '"' | '\'' | '\n' | ')' | ','))
                    .unwrap_or(rest.len());
                if take == 0 {
                    search_from = after;
                    continue;
                }
                let end = after + take;
                // 只替换「家目录这一段」，后面的结构原样保留。
                let tail = out[end..].to_string();
                out = format!("{}~{}", &out[..start], tail);
                self.counts.paths += 1;
                search_from = start + 1;
            }
        }
        out
    }

    /// 按空白切词后逐 token 脱敏；token 内的边界标点原样保留。
    fn redact_tokens(&mut self, text: &str) -> String {
        let mut out = String::with_capacity(text.len());
        let mut token = String::new();
        let flush = |token: &mut String, out: &mut String, this: &mut Self| {
            if token.is_empty() {
                return;
            }
            out.push_str(&this.redact_token(token));
            token.clear();
        };
        for ch in text.chars() {
            if ch.is_whitespace() {
                flush(&mut token, &mut out, self);
                out.push(ch);
            } else {
                token.push(ch);
            }
        }
        flush(&mut token, &mut out, self);
        out
    }

    fn redact_token(&mut self, token: &str) -> String {
        // 前后包裹的标点不参与识别，原样还回去。
        let start = token
            .char_indices()
            .find(|(_, ch)| ch.is_alphanumeric() || matches!(ch, '/' | '*' | '[' | ']'))
            .map(|(index, _)| index)
            .unwrap_or(token.len());
        let end = token
            .char_indices()
            .rev()
            .find(|(_, ch)| ch.is_alphanumeric() || matches!(ch, '/' | '*' | '[' | ']'))
            .map(|(index, ch)| index + ch.len_utf8())
            .unwrap_or(start);
        if start >= end {
            return token.to_string();
        }
        let (lead, core, tail) = (&token[..start], &token[start..end], &token[end..]);
        format!("{lead}{}{tail}", self.redact_core(core))
    }

    fn redact_core(&mut self, core: &str) -> String {
        if core.contains("://") {
            return self.redact_url(core);
        }
        // `host=`、`dst=`、`server=` 这类 key=value：键保留，值按同一套规则处理。
        if let Some(folded) = fold_path_value(core) {
            return folded;
        }
        if let Some((key, value)) = core.split_once('=') {
            let key_ok = !key.is_empty()
                && key
                    .chars()
                    .all(|ch| ch.is_alphanumeric() || matches!(ch, '_' | '-' | '.'));
            if key_ok && !value.is_empty() {
                if is_credential_key(key) {
                    // 凭据类键不看长度、不看形态：整值打码。
                    self.counts.secrets += 1;
                    return format!("{key}={REDACTION_MARKER}");
                }
                if let Some(folded) = fold_path_value(value) {
                    return format!("{key}={folded}");
                }
                return format!("{key}={}", self.redact_core(value));
            }
        }
        // `[2001:db8::1]:443`：括号里是 IPv6，端口原样保留。
        if let Some(rest) = core.strip_prefix('[') {
            if let Some((inner, tail)) = rest.split_once(']') {
                if let Ok(ip) = inner.parse::<std::net::Ipv6Addr>() {
                    return format!(
                        "[{}]{}",
                        self.redact_ip(std::net::IpAddr::V6(ip)),
                        tail
                    );
                }
            }
        }
        if let Some((user, host)) = core.split_once('@') {
            if !user.is_empty() && host.contains('.') && !host.contains('/') {
                return format!("{REDACTION_MARKER}@{REDACTION_MARKER}");
            }
        }
        if is_phone(core) {
            return REDACTION_MARKER.to_string();
        }
        if let Some(ip) = parse_ip(core) {
            return self.redact_ip(ip);
        }
        // host:port（IPv6 已在上面处理；这里只处理单冒号的域名/IPv4 形态）
        if let Some((host, port)) = split_host_port(core) {
            if is_domain(host) || parse_ip(host).is_some() {
                let masked = if let Some(ip) = parse_ip(host) {
                    self.redact_ip(ip)
                } else {
                    self.redact_domain(host)
                };
                return format!("{masked}:{port}");
            }
        }
        if is_domain(core) {
            return self.redact_domain(core);
        }
        // 中文/标点紧贴地址时（`203.0.113.9，探测`），按 ASCII 片段再扫一遍。
        if core.chars().any(|ch| !allowed_in_core(ch)) {
            if let Some(text) = self.redact_subruns(core) {
                return text;
            }
        }
        core.to_string()
    }

    fn redact_subruns(&mut self, core: &str) -> Option<String> {
        let mut out = String::with_capacity(core.len());
        let mut run = String::new();
        let mut changed = false;
        for ch in core.chars() {
            if allowed_in_core(ch) {
                run.push(ch);
                continue;
            }
            if !run.is_empty() {
                let redacted = self.redact_core(&run);
                changed |= redacted != run;
                out.push_str(&redacted);
                run.clear();
            }
            out.push(ch);
        }
        if !run.is_empty() {
            let redacted = self.redact_core(&run);
            changed |= redacted != run;
            out.push_str(&redacted);
        }
        changed.then_some(out)
    }

    fn redact_url(&mut self, url: &str) -> String {
        let Some((scheme, rest)) = url.split_once("://") else {
            return url.to_string();
        };
        let authority_end = rest
            .find(|ch: char| matches!(ch, '/' | '?' | '#'))
            .unwrap_or(rest.len());
        let authority = &rest[..authority_end];
        let path_and_more = &rest[authority_end..];
        // 丢掉 userinfo 与查询串：查询串里经常带 token。
        let host_part = authority.rsplit('@').next().unwrap_or(authority);
        // `[2001:db8::1]` 与 `host:port` 都要把真正的主机取出来。
        let host = if let Some(rest) = host_part.strip_prefix('[') {
            rest.split_once(']').map(|(inner, _)| inner).unwrap_or(host_part)
        } else {
            match host_part.rsplit_once(':') {
                Some((head, port)) if !port.is_empty() && port.chars().all(|ch| ch.is_ascii_digit()) => head,
                _ => host_part,
            }
        };
        let masked = if let Some(ip) = parse_ip(host) {
            self.redact_ip(ip)
        } else if is_domain(host) {
            self.redact_domain(host)
        } else {
            host.to_string()
        };
        let path = path_and_more.split(|ch: char| matches!(ch, '?' | '#')).next().unwrap_or("");
        let segments = path.split('/').filter(|part| !part.is_empty()).count();
        self.counts.urls += 1;
        if segments == 0 {
            format!("{scheme}://{masked}/")
        } else {
            format!("{scheme}://{masked}/（路径 {segments} 段）")
        }
    }

    fn redact_domain(&mut self, host: &str) -> String {
        if host.contains('*') {
            return host.to_string();
        }
        self.counts.domains += 1;
        if self.include_domains {
            return host.to_string();
        }
        match registrable_domain(host) {
            Some(domain) => format!("{REDACTION_MARKER}.{domain}"),
            None => REDACTION_MARKER.to_string(),
        }
    }

    fn redact_ip(&mut self, ip: std::net::IpAddr) -> String {
        if is_private_ip(ip) {
            return ip.to_string();
        }
        self.counts.public_ips += 1;
        match ip {
            std::net::IpAddr::V4(v4) => {
                if self.include_domains {
                    let octets = v4.octets();
                    format!("{}.{}.*.*", octets[0], octets[1])
                } else {
                    "*.*.*.*".to_string()
                }
            }
            std::net::IpAddr::V6(v6) => {
                let groups: Vec<String> = v6
                    .segments()
                    .iter()
                    .map(|segment| format!("{segment:x}"))
                    .collect();
                if self.include_domains {
                    format!(
                        "{}:{}:{}:*:*:*:*:*",
                        groups[0], groups[1], groups[2]
                    )
                } else {
                    "*:*:*:*:*:*:*:*".to_string()
                }
            }
        }
    }
}

/// 逐 token 跑 `mask_secrets`：含 `/` 的 token 按段处理，
/// 这样路径结构保留，而带 `/` 的 base64 / socks 密码仍会被掩掉。
fn mask_token(word: &str) -> (String, bool) {
    // 含 `/` 的短凭据（如 `AbCdEfGhIj/KlMnOpQrSt`）拆段后两边都不够 16 位，
    // 逐段掩码会整串漏掉。非路径形态的 token 对整串再跑一次。
    if word.contains('/') && !looks_like_path(word) {
        let whole = mask_secrets(word);
        if whole != word {
            return (whole, true);
        }
    }
    let mut changed = false;
    let mut out = String::with_capacity(word.len());
    for (index, segment) in word.split('/').enumerate() {
        if index > 0 {
            out.push('/');
        }
        let masked = mask_secrets(segment);
        if masked != segment {
            changed = true;
        }
        out.push_str(&masked);
    }
    (out, changed)
}

/// 路径形态：绝对路径、`~/`、URL、Windows 盘符。这些要保持结构，不整串当凭据。
fn looks_like_path(word: &str) -> bool {
    if word.starts_with('/') || word.starts_with("~/") || word.starts_with("~\\") {
        return true;
    }
    if word.contains("://") {
        return true;
    }
    let bytes = word.as_bytes();
    if bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && matches!(bytes[2], b'/' | b'\\')
    {
        return true;
    }
    // 相对路径（`Support/Veyl/logs/app.log`）：最后一段有像扩展名的后缀。
    let last = word.rsplit('/').next().unwrap_or(word);
    last.rsplit_once('.').is_some_and(|(_, ext)| {
        !ext.is_empty() && ext.len() <= 5 && ext.chars().all(|ch| ch.is_ascii_alphanumeric())
    })
}

/// 自由文本脱敏的统一入口（日志、报告、错误消息）。
pub fn redact_text(redactor: &mut Redactor, text: &str) -> String {
    // 先做整值替换与凭据掩码，再跑 token 级规则。
    let first = redactor.redact(text);
    redactor.redact_tokens(&first)
}

/// 凭据键：**精确匹配**（先小写、去掉 `-`/`_` 再比）。
///
/// 子串匹配会把 `keyword`、`author` 误伤；归一化后还能覆盖 `x-api-key`、`api_key`。
fn is_credential_key(key: &str) -> bool {
    let normalized: String = key
        .to_ascii_lowercase()
        .chars()
        .filter(|ch| !matches!(ch, '-' | '_'))
        .collect();
    const WORDS: &[&str] = &[
        "token",
        "password",
        "passwd",
        "pwd",
        "secret",
        "key",
        "auth",
        "authorization",
        "apikey",
        "xapikey",
        "accesstoken",
        "refreshtoken",
        "credential",
        "signature",
        "passphrase",
    ];
    if WORDS.contains(&normalized.as_str()) {
        return true;
    }
    matches!(key, "密码" | "令牌" | "密钥" | "口令" | "凭据")
}

/// 结构类键：值直接保留，不跑通用凭据掩码（否则加密方式 / 模式会被打掉）。
fn is_plain_key(key: &str) -> bool {
    let lower = key.to_ascii_lowercase();
    matches!(
        lower.as_str(),
        "method"
            | "mode"
            | "uuid"
            | "host"
            | "port"
            | "name"
            | "server"
            | "dst"
            | "src"
            | "type"
            | "tag"
            | "address"
            | "path"
            | "file"
            | "url"
            | "reason"
    )
}

/// `key=value` 里的路径值：折叠主目录，兼容没有前导 `/` 的写法。
fn fold_path_value(value: &str) -> Option<String> {
    if let Some(folded) = crate::reports::fold_home(value) {
        return Some(folded);
    }
    if value.starts_with('~') || value.contains("://") {
        return None;
    }
    fold_inline_home(value, home_basename().as_deref())
}

fn home_basename() -> Option<String> {
    let home = std::env::var("HOME")
        .ok()
        .or_else(|| std::env::var("USERPROFILE").ok())?;
    let trimmed = home.trim_end_matches(['/', '\\']);
    trimmed
        .rsplit(['/', '\\'])
        .next()
        .filter(|name| !name.is_empty())
        .map(str::to_string)
}

/// `Users/<名字>/…`、`home/<名字>/…`、`<home 的最后一段>/…` → `~/…`；
/// `Users/`、`home/` 后面那一段就是用户名，**连同名字一起消掉**。
///
/// 只认 token 开头或紧跟在 `=` 之后；`some/home/alice` 这种中间出现的不折。
fn fold_inline_home(value: &str, home_basename: Option<&str>) -> Option<String> {
    let allowed_at = |position: usize| position == 0 || value[..position].ends_with('=');

    // 主目录 basename 形式：`wesley/.veyl` —— 名字已被 marker 吃掉，剩下就是尾巴。
    if let Some(name) = home_basename.filter(|name| !name.is_empty()) {
        for separator in ['/', '\\'] {
            let marker = format!("{name}{separator}");
            if let Some(position) = value.find(&marker) {
                if allowed_at(position) {
                    let tail = &value[position + marker.len()..];
                    if !tail.is_empty() {
                        let trimmed = tail.trim_start_matches(['/', '\\']);
                        let folded = if trimmed.is_empty() {
                            "~".to_string()
                        } else {
                            format!("~{separator}{trimmed}")
                        };
                        return Some(format!("{}{folded}", &value[..position]));
                    }
                }
            }
        }
    }

    // `Users/<名字>/…`：marker 后还要跳过名字。
    for marker in ["Users/", "users/", "Users\\", "home/", "home\\"] {
        let Some(position) = value.find(marker) else {
            continue;
        };
        if !allowed_at(position) {
            continue;
        }
        let rest = &value[position + marker.len()..];
        let name_end = rest.find(['/', '\\', ' ']).unwrap_or(rest.len());
        if name_end == 0 {
            continue;
        }
        let tail = &rest[name_end..];
        let separator = if marker.ends_with('\\') { "\\" } else { "/" };
        let trimmed = tail.trim_start_matches(['/', '\\']);
        let folded = if trimmed.is_empty() {
            "~".to_string()
        } else {
            format!("~{separator}{trimmed}")
        };
        return Some(format!("{}{folded}", &value[..position]));
    }
    None
}

fn allowed_in_core(ch: char) -> bool {
    ch.is_ascii_alphanumeric()
        || matches!(ch, '.' | ':' | '-' | '_' | '@' | '/' | '[' | ']' | '=' | '?')
}

fn char_len_at(text: &str, index: usize) -> usize {
    text[index..].chars().next().map(char::len_utf8).unwrap_or(1)
}

/// 从 `index` 开始解析一个键名，后面必须紧跟（可含空格）`=` 或 `:`。
/// 返回（键名, 分隔符位置）。键名前不能是字母/数字/`-`/`_`。
fn parse_key_at(text: &str, index: usize) -> Option<(&str, usize)> {
    if index > 0 {
        let previous = text[..index].chars().last()?;
        if previous.is_alphanumeric() || matches!(previous, '-' | '_' | '.') {
            return None;
        }
    }
    let bytes = text.as_bytes();
    let mut end = index;
    while end < bytes.len() {
        let ch = bytes[end] as char;
        if ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_') {
            end += 1;
        } else {
            break;
        }
    }
    if end == index {
        return None;
    }
    let key = &text[index..end];
    let spaces_end = skip_spaces(text, end)?;
    if spaces_end >= bytes.len() {
        return None;
    }
    let separator = bytes[spaces_end];
    if separator == b'=' || separator == b':' {
        Some((key, spaces_end))
    } else {
        None
    }
}

fn skip_spaces(text: &str, mut index: usize) -> Option<usize> {
    let bytes = text.as_bytes();
    while index < bytes.len() && (bytes[index] as char).is_whitespace() {
        index += 1;
    }
    (index < bytes.len()).then_some(index)
}

fn word_end(text: &str, start: usize) -> Option<usize> {
    let bytes = text.as_bytes();
    let mut end = start;
    while end < bytes.len() {
        let ch = text[end..].chars().next()?;
        if ch.is_whitespace() || matches!(ch, '"' | '\'' | ',' | ';' | ')' | ']' | '}') {
            break;
        }
        end += ch.len_utf8();
    }
    (end > start).then_some(end)
}

fn is_phone(token: &str) -> bool {
    token.len() == 11 && token.starts_with('1') && token.chars().all(|ch| ch.is_ascii_digit())
}

fn parse_ip(token: &str) -> Option<std::net::IpAddr> {
    token
        .parse::<std::net::Ipv4Addr>()
        .map(std::net::IpAddr::V4)
        .ok()
        .or_else(|| token.parse::<std::net::Ipv6Addr>().map(std::net::IpAddr::V6).ok())
}

fn is_private_ip(ip: std::net::IpAddr) -> bool {
    match ip {
        std::net::IpAddr::V4(v4) => {
            v4.is_private()
                || v4.is_loopback()
                || v4.is_link_local()
                || v4.is_unspecified()
                || v4.octets()[0] == 100 && (64..=127).contains(&v4.octets()[1])
        }
        std::net::IpAddr::V6(v6) => {
            v6.is_loopback()
                || v6.is_unspecified()
                || (v6.segments()[0] & 0xffc0) == 0xfe80
                || (v6.segments()[0] & 0xfe00) == 0xfc00
        }
    }
}

fn split_host_port(core: &str) -> Option<(&str, &str)> {
    let (host, port) = core.rsplit_once(':')?;
    if host.is_empty() || port.is_empty() || !port.chars().all(|ch| ch.is_ascii_digit()) {
        return None;
    }
    Some((host, port))
}

/// 常见文件名后缀：`app-2026-11-12.log`、`veyl.db` 不是域名，不能被域名规则吃掉。
const FILE_EXTENSIONS: &[&str] = &[
    "log", "json", "txt", "md", "exe", "dmg", "app", "plist", "db", "enc", "pak", "srs",
    "yaml", "yml", "toml", "conf", "pid", "lock", "png", "ico", "zip", "tar", "gz", "zst",
];

fn is_domain(token: &str) -> bool {
    if token.len() < 4
        || token.contains("://")
        || token.contains('*')
        || token.contains('/')
        || token.contains('\\')
    {
        return false;
    }
    let labels: Vec<&str> = token.split('.').collect();
    if labels.len() < 2 {
        return false;
    }
    if labels.iter().any(|label| label.is_empty()) {
        return false;
    }
    let tld = labels.last().copied().unwrap_or_default();
    if FILE_EXTENSIONS.contains(&tld.to_ascii_lowercase().as_str()) {
        return false;
    }
    tld.len() >= 2 && tld.chars().all(|ch| ch.is_ascii_alphabetic())
        && labels
            .iter()
            .all(|label| label.chars().all(|ch| ch.is_ascii_alphanumeric() || ch == '-'))
}

/// 可注册域（eTLD+1）：命中内置多段后缀就保留三段，否则保留最后两段。
pub fn registrable_domain(host: &str) -> Option<String> {
    let labels: Vec<&str> = host.split('.').collect();
    if labels.len() < 2 {
        return None;
    }
    let last_two = format!(
        "{}.{}",
        labels[labels.len() - 2],
        labels[labels.len() - 1]
    );
    if MULTI_LABEL_SUFFIXES.contains(&last_two.as_str()) && labels.len() >= 3 {
        return Some(format!(
            "{}.{}",
            labels[labels.len() - 3],
            last_two
        ));
    }
    Some(last_two)
}

/// `现场.json` / 返回给模型的计数对象。
pub fn counts_json(counts: &RedactionCounts, mode: &str) -> Value {
    json!({
        "domains": counts.domains,
        "public_ips": counts.public_ips,
        "paths": counts.paths,
        "urls": counts.urls,
        "node_refs": counts.node_refs,
        "config_refs": counts.config_refs,
        "secrets": counts.secrets,
        "mode": if mode == "detailed" { "detailed" } else { "minimal" },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn redactor() -> Redactor {
        Redactor::new(false)
    }

    fn redact_one(text: &str) -> String {
        let mut redactor = redactor();
        redact_text(&mut redactor, text)
    }

    /// 契约的例子必须逐字成立。
    #[test]
    fn domains_keep_the_registrable_domain_by_default() {
        assert_eq!(redact_one("访问 www.google.com 失败"), "访问 ***.google.com 失败");
        assert_eq!(
            redact_one("a.b.example.co.uk 解析超时"),
            "***.example.co.uk 解析超时"
        );
        assert_eq!(redact_one("api.openai.com"), "***.openai.com");
    }

    #[test]
    fn domains_stay_intact_when_the_user_opts_in() {
        let mut redactor = Redactor::new(true);
        assert_eq!(
            redact_text(&mut redactor, "访问 www.google.com 失败"),
            "访问 www.google.com 失败"
        );
    }

    /// 节点地址任何模式都不出现，端口保留。
    #[test]
    fn node_addresses_never_appear_but_ports_stay() {
        let mut redactor = Redactor::new(true)
            .with_aliases(vec!["203.0.113.10".into()], Vec::new(), Vec::new());
        let text = redact_text(&mut redactor, "连接 203.0.113.10:8388 失败");
        assert!(!text.contains("203.0.113.10"), "{text}");
        assert!(text.contains("8388"), "端口要保留：{text}");
        assert!(text.contains("***"), "{text}");
    }

    #[test]
    fn public_ips_are_starred_and_private_ones_kept() {
        assert_eq!(redact_one("出口 203.0.113.9"), "出口 *.*.*.*");
        assert_eq!(redact_one("DNS 10.0.0.53"), "DNS 10.0.0.53");
        assert_eq!(redact_one("本地 127.0.0.1:7890"), "本地 127.0.0.1:7890");
        assert_eq!(redact_one("网关 192.168.1.1"), "网关 192.168.1.1");
    }

    #[test]
    fn public_ips_keep_two_octets_when_domains_are_allowed() {
        let mut redactor = Redactor::new(true);
        assert_eq!(
            redact_text(&mut redactor, "出口 203.0.113.9"),
            "出口 203.0.*.*"
        );
    }

    #[test]
    fn ipv6_is_starred() {
        assert_eq!(
            redact_one("2001:db8::1 不可达"),
            "*:*:*:*:*:*:*:* 不可达"
        );
        assert_eq!(redact_one("fe80::1"), "fe80::1");
    }

    /// URL 的查询串整段丢弃，主机按域名规则。
    #[test]
    fn url_query_strings_are_dropped() {
        let text = redact_one("GET https://www.google.com/search?q=secret&token=abc 200");
        assert!(!text.contains("secret"), "{text}");
        assert!(!text.contains("token"), "{text}");
        assert!(text.contains("***.google.com"), "{text}");
    }

    /// URL 的主机是 IP 时也要按 IP 规则打码，不能原样保留。
    #[test]
    fn url_hosts_that_are_ips_are_masked() {
        let text = redact_one("GET https://203.0.113.9/admin?token=abc 200");
        assert!(!text.contains("203.0.113.9"), "{text}");
        assert!(text.contains("*.*.*.*"), "{text}");
        let v6 = redact_one("https://[2001:db8::1]/x");
        assert!(!v6.contains("2001:db8::1"), "{v6}");
        assert!(v6.contains("*:*:*:*:*:*:*:*"), "{v6}");
    }

    /// `host=` / `dst=` 这类 key=value 里的值也要脱敏。
    #[test]
    fn key_value_pairs_are_redacted_on_the_value_only() {
        assert_eq!(redact_one("host=www.google.com"), "host=***.google.com");
        assert_eq!(redact_one("dst=203.0.113.9"), "dst=*.*.*.*");
        assert_eq!(redact_one("[2001:db8::1]:443"), "[*:*:*:*:*:*:*:*]:443");
    }

    /// 凭据类键的值不看长度，整段打码；键名精确匹配，不误伤 keyword/author。
    #[test]
    fn credential_keys_are_matched_exactly() {
        for text in [
            "token=abc123",
            "password=hunter2",
            "secret=a",
            "key=1",
            "auth=x",
            "authorization=Bearerxyz",
            "x-api-key=xyz",
            "apikey=xyz",
            "api_key=xyz",
            "access_token=xyz",
            "refresh_token=xyz",
            "密码=abc",
            "令牌=abc",
        ] {
            let out = redact_one(text);
            assert!(out.ends_with("=***"), "{text} -> {out}");
        }
        // 认证方案与令牌一起掩掉，不能只掩第一个词。
        assert_eq!(
            redact_one("authorization=Bearer abc123"),
            "authorization=***"
        );
        assert_eq!(
            redact_one("Authorization: Bearer abc123"),
            "Authorization: ***"
        );
        for text in [
            "keyword=abc",
            "author=bob",
            "mode=auto",
            "method=2022-blake3-aes-128-gcm",
            "uuid=abcd",
            "host=example",
            "port=8080",
            "name=Tokyo",
        ] {
            assert_eq!(redact_one(text), text, "{text} 不该被打码");
        }
    }

    /// `key=` 里的路径值也要折叠主目录，包括没有前导 `/` 的写法。
    #[test]
    fn path_values_in_key_pairs_are_folded() {
        assert_eq!(redact_one("data_dir=/Users/wesley/.veyl"), "data_dir=~/.veyl");
        assert_eq!(redact_one("data_dir=Users/wesley/.veyl"), "data_dir=~/.veyl");
        assert_eq!(redact_one("data_dir=home/wesley/.veyl"), "data_dir=~/.veyl");
        // 主目录 basename 同样能折（这里显式给 home 的最后一段）。
        assert_eq!(
            fold_inline_home("wesley/.veyl", Some("wesley")).as_deref(),
            Some("~/.veyl")
        );
        // 只认 token 开头 / `=` 之后：中间出现的 home 不折，更不能产出 `some~`。
        assert_eq!(redact_one("path=some/home/alice"), "path=some/home/alice");
        assert_eq!(redact_one("dir=home/alice"), "dir=~");
        assert_eq!(redact_one("Users/wesley/.veyl"), "~/.veyl");
        // 折叠的唯一目的就是隐藏账户名：结果里不得出现主目录 basename。
        for text in [
            "data_dir=/Users/wesley/.veyl",
            "data_dir=Users/wesley/.veyl",
            "data_dir=home/wesley/.veyl",
        ] {
            assert!(!redact_one(text).contains("wesley"), "泄漏用户名：{text}");
        }
        assert_eq!(fold_inline_home("some/home/alice", Some("wesley")), None);
    }

    /// 斜杠两侧都不够阈值的短凭据也要整串掩掉。
    #[test]
    fn short_slash_separated_credentials_are_masked() {
        let text = redact_one("pass AbCdEfGhIj/KlMnOpQrSt used");
        assert!(!text.contains("AbCdEfGhIj"), "{text}");
        assert!(text.contains("***"), "{text}");
        // 真正的路径不能被当凭据整段打掉。
        let path = redact_one("~/Library/Application Support/Veyl/logs/app.log");
        assert!(path.contains("~/Library/Application"), "{path}");
    }

    /// 中文、标点紧贴地址时也要识别（`redact_subruns`）。
    #[test]
    fn addresses_touching_cjk_text_are_still_masked() {
        assert_eq!(redact_one("出口203.0.113.9，探测失败"), "出口*.*.*.*，探测失败");
        assert_eq!(
            redact_one("连接cp.cloudflare.com失败"),
            "连接***.cloudflare.com失败"
        );
    }

    /// 含 `/` 的 base64 不再整 token 跳过：路径结构保留，凭据仍被掩掉。
    #[test]
    fn slash_containing_secrets_are_still_masked() {
        let text = redact_one("token QUJDREVGR0hJSktMTU5PUFFSU1RVVldY/YZ");
        assert!(!text.contains("QUJDREVGR0hJSktM"), "{text}");
        assert!(text.contains("***"), "{text}");
        // 路径结构不受影响。
        let path = redact_one("/Users/alice/Library/Application Support/Veyl/logs/app.log");
        assert!(path.contains("~/Library/Application Support/Veyl/logs/app.log"), "{path}");
    }

    #[test]
    fn emails_and_phones_are_masked() {
        assert_eq!(redact_one("联系 someone@example.com"), "联系 ***@***");
        assert_eq!(redact_one("电话 13800138000"), "电话 ***");
    }

    #[test]
    fn home_directories_become_tilde() {
        let text = redact_one(
            "读取 /Users/alice/Library/Application Support/Veyl/logs/app.log 失败",
        );
        assert!(!text.contains("alice"), "{text}");
        assert!(text.contains("~/Library/Application Support/Veyl/logs/app.log"), "{text}");
        let windows = redact_one("C:\\Users\\bob\\AppData\\Roaming\\Veyl\\x.log");
        assert!(!windows.contains("bob"), "{windows}");
    }

    #[test]
    fn secrets_are_masked_by_the_shared_helper() {
        let text = redact_one("api key sk-abcdefghijklmnopqrstuvwxyz0123456789");
        assert!(text.contains("***"), "{text}");
        assert!(!text.contains("abcdefghijk"), "{text}");
    }

    #[test]
    fn node_and_config_names_are_replaced_by_ordinals() {
        let mut redactor = Redactor::new(false).with_aliases(
            Vec::new(),
            vec!["东京 01".into()],
            vec!["我的订阅".into()],
        );
        let text = redact_text(&mut redactor, "节点 东京 01 / 配置 我的订阅");
        assert!(!text.contains("东京"), "{text}");
        assert!(text.contains("节点 1"), "{text}");
        assert!(text.contains("配置 1"), "{text}");
    }

    /// 不做半掩码：输出里每个掩码都是完整占位符。
    #[test]
    fn masking_is_all_or_nothing() {
        let text = redact_one("www.google.com 203.0.113.9");
        assert!(!text.contains("goo***"), "{text}");
        assert!(!text.contains("203.***"), "{text}");
    }

    #[test]
    fn registrable_domains_fall_back_to_two_labels() {
        assert_eq!(registrable_domain("a.b.example.unknowntld").as_deref(), Some("example.unknowntld"));
        assert_eq!(registrable_domain("example.co.uk").as_deref(), Some("example.co.uk"));
        assert_eq!(registrable_domain("a.b.example.co.uk").as_deref(), Some("example.co.uk"));
    }
}
