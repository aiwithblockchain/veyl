//! `HttpCheck`：只读地看一眼某个 https 地址能不能打开，附带 Cloudflare 挑战标记。
//!
//! 安全约束（`docs/contracts/tools.md` §4.54）是硬要求，不是「尽量」：模型给的
//! URL 绝不能被用来访问本机或内网。
//!
//! 两条路径都做每跳静态解析校验（解析 + 判私网）。差别在「谁最终决定连接目标」：
//! - **直连**（未连接 / TUN）：校验过的地址 pin 给连接层（`resolve_to_addrs`）并
//!   `no_proxy`，DNS rebinding 与环境代理都改变不了连接目标。
//! - **经本机代理**（Proxy 连接中）：目标最终由 sing-box 再解析一次，我们 pin 不住，
//!   存在 TOCTOU 窗口。窗口内最多造成**一次到私网 443 的连接尝试**——TLS 证书不可能
//!   匹配所请求的域名，握手即失败，读不到任何内容；本工具只读响应头、只允许 https/443。
//!
//! **重审触发条件**：一旦支持 `http` 或非 443 端口、读正文（哪怕一段）、或允许自定义
//! 请求头/方法，上面的残余风险就不再成立，必须回到「探针专用入站 + 置顶规则
//! `{inbound:["probe-in"], ip_is_private, action:"reject"}`」。这条写进 §4.54。

use std::net::IpAddr;
use std::sync::Arc;
use std::time::{Duration, Instant};

use async_trait::async_trait;
use claurst_tools::{PermissionLevel, Tool, ToolContext, ToolResult};
use serde_json::{json, Value};

use super::{envelope, AivpnError, ToolOutcome};

const MAX_REDIRECTS: usize = 5;
const DEFAULT_TIMEOUT_MS: u64 = 8000;
const MIN_TIMEOUT_MS: u64 = 1000;
const MAX_TIMEOUT_MS: u64 = 15000;
/// 只发这一个头；不带 Cookie / Authorization，也没有请求体。
const USER_AGENT: &str = "Veyl-Check/1.0";
/// 正文一律不读；这个上限只用于「响应头异常大」的防御性截断。
const MAX_HEADER_BYTES: usize = 64 * 1024;

/// 一跳响应里我们关心的东西。
#[derive(Debug, Clone, Default)]
pub struct ProbeResponse {
    pub status: u16,
    pub location: Option<String>,
    pub server: Option<String>,
    pub cf_mitigated: Option<String>,
    /// 响应头总字节数，仅用于防御性判断。
    pub header_bytes: usize,
}

/// 这一跳走哪条路。**测的必须是用户实际在走的那条路**：用户连着 Proxy 而我们
/// 直连去测，会得出「站点正常」而用户正卡着——那正是最坏的一种错误诊断。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Route {
    /// 直连（含 TUN：流量本来就被 TUN 捕获）。
    Direct,
    /// 指向本地混合端口（Proxy 模式连接中）。
    Proxy(String),
}

/// 连接状态 → (怎么连, 这次测量代表哪条路)。
///
/// TUN 连接中虽然直连，但流量本来就被 TUN 捕获，测的仍是隧道那条路，
/// 所以 `via` 必须是 `tunnel`——否则同一句「状态码 200」会被解释成完全相反的意思。
fn route_from_status(status: &Value) -> (Route, &'static str) {
    let state = status.get("state").and_then(Value::as_str).unwrap_or("");
    let connected = matches!(state, "running" | "degraded" | "starting" | "restarting");
    if !connected {
        return (Route::Direct, "direct");
    }
    let mode = status.get("mode").and_then(Value::as_str).unwrap_or("");
    if mode == "system_proxy" {
        if let Some(port) = status.get("mixed_port").and_then(Value::as_u64) {
            if let Ok(port) = u16::try_from(port) {
                return (Route::Proxy(format!("http://127.0.0.1:{port}")), "tunnel");
            }
        }
        // 拿不到混合端口：只能直连，且不能假装这次走了隧道。
        return (Route::Direct, "direct");
    }
    // TUN：直连即可（流量在系统层被接管），但代表的仍是隧道那条路。
    (Route::Direct, "tunnel")
}

/// 可注入的探测口：默认实现联网，测试用假实现，保证单测不联网。
#[async_trait]
pub trait HttpProbe: Send + Sync {
    async fn resolve(&self, host: &str, port: u16) -> Result<Vec<IpAddr>, String>;
    /// 不跟随重定向（由调用方逐跳校验后自行决定）。
    ///
    /// `addrs` 是**已校验过**的地址集合：直连时必须把它们 pin 给客户端，
    /// 否则建连时会再解析一次，校验形同虚设（DNS rebinding）。
    async fn fetch(
        &self,
        url: &str,
        addrs: &[IpAddr],
        route: &Route,
        timeout: Duration,
    ) -> Result<ProbeResponse, String>;
}

/// 真实实现：reqwest（rustls）+ 系统解析器。
pub struct ReqwestProbe;

impl ReqwestProbe {
    pub fn new() -> Self {
        Self
    }
}

impl Default for ReqwestProbe {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl HttpProbe for ReqwestProbe {
    async fn resolve(&self, host: &str, port: u16) -> Result<Vec<IpAddr>, String> {
        let addrs = tokio::net::lookup_host((host, port))
            .await
            .map_err(|error| format!("解析 {host} 失败：{error}"))?;
        Ok(addrs.map(|addr| addr.ip()).collect())
    }

    async fn fetch(
        &self,
        url: &str,
        addrs: &[IpAddr],
        route: &Route,
        timeout: Duration,
    ) -> Result<ProbeResponse, String> {
        let mut builder = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(timeout);
        builder = match route {
            Route::Direct => {
                // 环境变量里的代理会决定连接目标，那样校验就没有意义了。
                let pinned: Vec<std::net::SocketAddr> = addrs
                    .iter()
                    .map(|ip| std::net::SocketAddr::new(*ip, 443))
                    .collect();
                let host = host_of(url)?;
                builder
                    .no_proxy()
                    .resolve_to_addrs(&host, &pinned)
            }
            // 走我们自己的混合端口：CONNECT 由本地 sing-box 解析，
            // 这里 pin 不住目标地址（那是代理侧的事），所以只在直连时 pin。
            Route::Proxy(proxy) => builder.proxy(
                reqwest::Proxy::all(proxy.clone())
                    .map_err(|error| format!("代理地址不合法：{error}"))?,
            ),
        };
        let client = builder.build().map_err(|error| error.to_string())?;

        let response = client
            .get(url)
            .header(reqwest::header::USER_AGENT, USER_AGENT)
            .send()
            .await
            .map_err(|error| {
                if error.is_timeout() {
                    "等响应超时".to_string()
                } else {
                    error.to_string()
                }
            })?;
        let header = |name: &str| {
            response
                .headers()
                .get(name)
                .and_then(|value| value.to_str().ok())
                .map(str::to_string)
        };
        let header_bytes = response
            .headers()
            .iter()
            .map(|(name, value)| name.as_str().len() + value.as_bytes().len())
            .sum();
        // 正文不读：drop 掉 response 即丢弃，避免把页面内容带进模型上下文。
        Ok(ProbeResponse {
            status: response.status().as_u16(),
            location: header("location"),
            server: header("server"),
            cf_mitigated: header("cf-mitigated"),
            header_bytes,
        })
    }
}

fn host_of(url: &str) -> Result<String, String> {
    let rest = url
        .strip_prefix("https://")
        .ok_or_else(|| "只支持 https".to_string())?;
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    let host = if let Some(bracketed) = authority.strip_prefix('[') {
        bracketed
            .split(']')
            .next()
            .unwrap_or_default()
            .to_string()
    } else {
        authority.split(':').next().unwrap_or_default().to_string()
    };
    if host.is_empty() {
        return Err("地址里缺少主机名".to_string());
    }
    Ok(host)
}

/// 校验通过的 https 目标。
#[derive(Debug, Clone, PartialEq, Eq)]
struct Target {
    url: String,
    host: String,
    port: u16,
}

impl Target {
    fn origin(&self) -> String {
        if self.host.contains(':') {
            format!("https://[{}]", self.host)
        } else {
            format!("https://{}", self.host)
        }
    }

    fn path_and_query(&self) -> String {
        let rest = self.url.strip_prefix("https://").unwrap_or("");
        let after_authority = rest
            .find(['/', '?', '#'])
            .map(|index| &rest[index..])
            .unwrap_or("/");
        let without_fragment = after_authority.split('#').next().unwrap_or("/");
        if without_fragment.starts_with('/') {
            without_fragment.to_string()
        } else {
            format!("/{without_fragment}")
        }
    }
}

fn invalid_argument(message: impl Into<String>, reason: &str) -> AivpnError {
    AivpnError::new("INVALID_ARGUMENT", message).with_details(json!({ "reason": reason }))
}

fn invalid_url(message: impl Into<String>) -> AivpnError {
    invalid_argument(message, "invalid_url")
}

fn insecure_scheme(message: impl Into<String>) -> AivpnError {
    invalid_argument(message, "insecure_scheme")
}

fn unsupported_port(message: impl Into<String>) -> AivpnError {
    invalid_argument(message, "unsupported_port")
}

fn private_address() -> AivpnError {
    invalid_argument("这个地址指向本机或内网，不能访问", "private_address")
}

/// 只接受 `https://`、只接受 443、不接受 userinfo。
fn parse_https_url(raw: &str) -> Result<Target, AivpnError> {
    let raw = raw.trim();
    let rest = raw
        .strip_prefix("https://")
        .ok_or_else(|| insecure_scheme("只支持 https:// 开头的地址"))?;
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    if authority.is_empty() {
        return Err(invalid_url("地址里缺少主机名"));
    }
    if authority.contains('@') {
        return Err(invalid_url("地址里不能带用户名或密码"));
    }

    let (host, port) = if let Some(bracketed) = authority.strip_prefix('[') {
        let end = bracketed
            .find(']')
            .ok_or_else(|| invalid_url("IPv6 地址格式不对"))?;
        let host = &bracketed[..end];
        let after = &bracketed[end + 1..];
        let port = if after.is_empty() {
            443
        } else {
            let digits = after
                .strip_prefix(':')
                .ok_or_else(|| invalid_url("端口格式不对"))?;
            digits
                .parse::<u16>()
                .map_err(|_| invalid_url("端口格式不对"))?
        };
        (host.to_string(), port)
    } else if let Some((host, digits)) = authority.rsplit_once(':') {
        // 裸 IPv6（没有方括号）不是合法 URL，这里按「主机:端口」解析必然失败。
        if host.contains(':') {
            return Err(invalid_url("IPv6 地址要加方括号"));
        }
        let port = digits
            .parse::<u16>()
            .map_err(|_| invalid_url("端口格式不对"))?;
        (host.to_string(), port)
    } else {
        (authority.to_string(), 443)
    };

    if port != 443 {
        return Err(unsupported_port("只允许 443 端口"));
    }
    // host 统一小写、去掉单个尾点：reqwest 的 `resolve_to_addrs` 按字符串匹配 host，
    // 「我们校验的 host」和「reqwest 实际用的 host」必须是同一个字节序列，
    // 否则 pin 不中会回落到真实 DNS，绕过校验。
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    if host.is_empty() {
        return Err(invalid_url("地址里缺少主机名"));
    }
    // 非 ASCII 主机名会在 reqwest 里被转成 punycode，与我们的 pin key 对不上
    // （pin 不中就回落真实 DNS）。这个工具不接受 IDN，模型应传 punycode 形式。
    if !host.is_ascii() {
        return Err(invalid_url("这个工具只接受 ASCII 域名，请用 punycode 形式"));
    }

    let mut target = Target {
        url: raw.to_string(),
        host,
        port,
    };
    // 请求也用规范化后的 URL 重建：parser 之间的差异（尾点、大小写、相对段）一并关掉。
    target.url = format!("{}{}", target.origin(), target.path_and_query());
    Ok(target)
}

/// 私网 / 环回 / 链路本地 / ULA / 组播 / unspecified 一律不算公网。
fn is_public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            let octets = v4.octets();
            !(v4.is_private()
                || v4.is_loopback()
                || v4.is_link_local()
                || v4.is_broadcast()
                || v4.is_documentation()
                || v4.is_unspecified()
                || v4.is_multicast()
                || octets[0] == 0
                // 100.64.0.0/10（CGNAT）
                || (octets[0] == 100 && (64..=127).contains(&octets[1]))
                // 192.0.0.0/24（协议保留）
                || (octets[0] == 192 && octets[1] == 0 && octets[2] == 0))
        }
        IpAddr::V6(v6) => {
            if v6.is_loopback() || v6.is_unspecified() || v6.is_multicast() {
                return false;
            }
            let octets = v6.octets();
            // fc00::/7 唯一本地地址
            if octets[0] & 0xfe == 0xfc {
                return false;
            }
            // fe80::/10 链路本地
            if octets[0] == 0xfe && octets[1] & 0xc0 == 0x80 {
                return false;
            }
            // ::ffff:a.b.c.d 与 ::a.b.c.d 映射：按内嵌的 IPv4 判
            if let Some(v4) = v6.to_ipv4_mapped().or_else(|| v6.to_ipv4()) {
                return is_public_ip(IpAddr::V4(v4));
            }
            true
        }
    }
}

/// 把 `Location` 解析成下一跳的绝对 https 目标（同样要过全部校验）。
fn next_target(current: &Target, location: &str) -> Result<Target, AivpnError> {
    let location = location.trim();
    if location.is_empty() {
        return Err(invalid_url("跳转地址为空"));
    }
    if location.starts_with("https://") {
        return parse_https_url(location);
    }
    // 其它协议（http:// 等）一律不跟：契约只允许 https。
    if location.contains("://") {
        return Err(insecure_scheme("重定向到了非 https 地址，不跟"));
    }
    if location.starts_with("//") {
        return parse_https_url(&format!("https:{location}"));
    }
    let origin = current.origin();
    // `?x=1`：保留当前路径，只换 query（RFC 3986 §5.3）。
    if let Some(query) = location.strip_prefix('?') {
        let path = current.path_and_query();
        let base_path = path.split('?').next().unwrap_or("/");
        return parse_https_url(&format!("{origin}{base_path}?{query}"));
    }
    if location.starts_with('/') {
        return parse_https_url(&format!("{origin}{location}"));
    }
    // 相对路径：退到当前路径所在目录。
    let path = current.path_and_query();
    let directory = match path.rfind('/') {
        Some(index) => &path[..=index],
        None => "/",
    };
    parse_https_url(&format!("{origin}{directory}{location}"))
}

/// 网络 / TLS 失败：按契约仍是工具成功返回，只是 `status: null` + `HTTP_CHECK_FAILED`。
fn failure_result(
    raw_url: &str,
    via: &str,
    started: Instant,
    redirects: usize,
    message: &str,
) -> Value {
    json!({
        "url": raw_url,
        "via": via,
        "status": Value::Null,
        "elapsed_ms": started.elapsed().as_millis() as u64,
        "redirects": redirects,
        "server": Value::Null,
        "cf_mitigated": Value::Null,
        "tls_ok": false,
        "error": { "code": "HTTP_CHECK_FAILED", "message": message },
    })
}

/// 整体超时：按契约仍是工具成功返回，只是 `status: null` + `HTTP_CHECK_FAILED`。
fn timeout_result(raw_url: &str, via: &str, started: Instant, redirects: usize) -> Value {
    failure_result(raw_url, via, started, redirects, "等响应超时")
}

pub struct HttpCheckTool {
    probe: Arc<dyn HttpProbe>,
    services: Arc<dyn super::VpnToolServices>,
}

impl HttpCheckTool {
    pub fn new(services: Arc<dyn super::VpnToolServices>) -> Self {
        Self {
            probe: Arc::new(ReqwestProbe::new()),
            services,
        }
    }

    #[cfg(test)]
    pub fn with_probe(services: Arc<dyn super::VpnToolServices>, probe: Arc<dyn HttpProbe>) -> Self {
        Self { probe, services }
    }

    /// 这次测量该走哪条路：Proxy 模式连接中指向本地混合端口，其余直连。
    async fn route(&self) -> (Route, &'static str) {
        let Ok(status) = self.services.runtime_status().await else {
            return (Route::Direct, "direct");
        };
        route_from_status(&status)
    }

    async fn check(&self, raw_url: &str, timeout: Duration) -> Result<Value, AivpnError> {
        let target = parse_https_url(raw_url)?;
        // `started` 在选路之前：选路要读 `runtime_status()`，TUN 下可能带一次探测，
        // 那段时间也算进 `timeout_ms`，否则总耗时能超出用户给的上限。
        let started = Instant::now();
        let (route, via) = self.route().await;
        self.check_with_route(raw_url, target, timeout, started, route, via)
            .await
    }

    /// 校验与拉起的主体。`route` 由调用方给，用例可以直接指定（不必伪造整个服务层）。
    async fn check_with_route(
        &self,
        raw_url: &str,
        mut target: Target,
        timeout: Duration,
        started: Instant,
        route: Route,
        via: &'static str,
    ) -> Result<Value, AivpnError> {
        let mut redirects = 0usize;

        loop {
            // 每一跳都重新解析、重新校验：重定向到 10.0.0.1 或 127.0.0.1 必须被拒。
            let addresses = match self.probe.resolve(&target.host, target.port).await {
                Ok(addresses) => addresses,
                // 解析不了是网络问题，不是「你给的地址不合法」。
                Err(message) => {
                    return Ok(failure_result(
                        raw_url, via, started, redirects, &message,
                    ))
                }
            };
            if addresses.is_empty() || !addresses.iter().all(|ip| is_public_ip(*ip)) {
                return Err(private_address());
            }

            // `timeout_ms` 是整次检查的上限，不是每一跳各给一次。
            let remaining = timeout
                .checked_sub(started.elapsed())
                .filter(|left| !left.is_zero());
            let Some(remaining) = remaining else {
                return Ok(timeout_result(raw_url, via, started, redirects));
            };

            let response = match self
                .probe
                .fetch(&target.url, &addresses, &route, remaining)
                .await
            {
                Ok(response) => response,
                Err(message) => {
                    return Ok(failure_result(
                        raw_url, via, started, redirects, &message,
                    ))
                }
            };

            if response.header_bytes > MAX_HEADER_BYTES {
                return Ok(json!({
                    "url": raw_url,
                    "via": via,
                    "status": response.status,
                    "elapsed_ms": started.elapsed().as_millis() as u64,
                    "redirects": redirects,
                    "server": response.server,
                    "cf_mitigated": response.cf_mitigated,
                    "tls_ok": true,
                    "error": {
                        "code": "HTTP_CHECK_FAILED",
                        "message": "响应头异常大，没有按完整响应判断"
                    },
                }));
            }

            if (300..400).contains(&response.status) {
                if let Some(location) = response.location.as_deref() {
                    if redirects >= MAX_REDIRECTS {
                        return Err(invalid_url(format!("跳转超过 {MAX_REDIRECTS} 次，放弃")));
                    }
                    redirects += 1;
                    target = next_target(&target, location)?;
                    continue;
                }
            }

            return Ok(json!({
                "url": raw_url,
                "via": via,
                "status": response.status,
                "elapsed_ms": started.elapsed().as_millis() as u64,
                "redirects": redirects,
                "server": response.server,
                "cf_mitigated": response.cf_mitigated,
                "tls_ok": true,
                "error": Value::Null,
            }));
        }
    }
}

#[async_trait]
impl Tool for HttpCheckTool {
    fn name(&self) -> &str {
        "HttpCheck"
    }

    fn description(&self) -> &str {
        "访问一个网页地址，只读状态码与 Cloudflare 挑战标记。\
         仅用于验证某个站点当前能不能打开。\n\
         只接受 https、只能访问公网；只说结论，不出现响应头名字。"
    }

    fn permission_level(&self) -> PermissionLevel {
        PermissionLevel::ReadOnly
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "url": { "type": "string", "minLength": 1, "maxLength": 2048 },
                "timeout_ms": {
                    "type": "integer",
                    "minimum": MIN_TIMEOUT_MS,
                    "maximum": MAX_TIMEOUT_MS
                }
            },
            "required": ["url"],
            "additionalProperties": false
        })
    }

    async fn execute(&self, input: Value, ctx: &ToolContext) -> ToolResult {
        let outcome = match parse_input(&input) {
            Ok(request) => match self.check(&request.url, request.timeout).await {
                Ok(data) => {
                    let failed = data.get("error").map(|error| !error.is_null()).unwrap_or(false);
                    if failed {
                        let message = data["error"]["message"]
                            .as_str()
                            .unwrap_or("没能访问这个地址")
                            .to_string();
                        ToolOutcome::ok("没访问成功", data).with_facts(vec![message])
                    } else {
                        let status = data["status"].as_u64().unwrap_or(0);
                        let mut facts = vec![
                            format!("状态码：{status}"),
                            format!("耗时：{} ms", data["elapsed_ms"].as_u64().unwrap_or(0)),
                            format!("跳转：{} 次", data["redirects"].as_u64().unwrap_or(0)),
                        ];
                        if let Some(server) = data.get("server").and_then(Value::as_str) {
                            facts.push(format!("站点服务：{server}"));
                        }
                        if data.get("cf_mitigated").and_then(Value::as_str).is_some() {
                            facts.push("站点要求人机验证".to_string());
                        }
                        // 挑战只转述：不得据此判断 VPN 有没有生效。
                        ToolOutcome::ok(format!("网页返回 {status}"), data).with_facts(facts)
                    }
                }
                Err(error) => ToolOutcome::fail(error)
                    .with_display("没访问成功", Vec::new(), super::display::Changed::None),
            },
            Err(error) => ToolOutcome::fail(error),
        };
        envelope::finish(ctx, "HttpCheck", outcome)
    }
}

struct Request {
    url: String,
    timeout: Duration,
}

fn parse_input(input: &Value) -> Result<Request, AivpnError> {
    let url = input
        .get("url")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|url| !url.is_empty())
        .ok_or_else(|| invalid_url("缺少要检查的地址"))?;
    let timeout_ms = match input.get("timeout_ms") {
        None | Some(Value::Null) => DEFAULT_TIMEOUT_MS,
        Some(value) => value
            .as_u64()
            .ok_or_else(|| invalid_url("timeout_ms 必须是整数"))?,
    };
    if !(MIN_TIMEOUT_MS..=MAX_TIMEOUT_MS).contains(&timeout_ms) {
        return Err(invalid_url(format!(
            "timeout_ms 要在 {MIN_TIMEOUT_MS}–{MAX_TIMEOUT_MS} 之间"
        )));
    }
    Ok(Request {
        url: url.to_string(),
        timeout: Duration::from_millis(timeout_ms),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::net::{Ipv4Addr, Ipv6Addr};
    use std::sync::Mutex;

    /// 假探测口：解析表与响应表都由用例预先写好，绝不联网。
    /// 没登记的主机会让解析失败——「漏写 with_host」必须表现为测试失败，而不是静默通过。
    #[derive(Default)]
    struct FakeProbe {
        hosts: Mutex<HashMap<String, Vec<IpAddr>>>,
        responses: Mutex<HashMap<String, Result<ProbeResponse, String>>>,
        seen: Mutex<Vec<(String, Vec<IpAddr>, Route)>>,
    }

    impl FakeProbe {
        fn with_host(self, host: &str, ip: IpAddr) -> Self {
            self.hosts
                .lock()
                .unwrap()
                .insert(host.to_string(), vec![ip]);
            self
        }

        fn with_response(self, url: &str, response: ProbeResponse) -> Self {
            self.responses
                .lock()
                .unwrap()
                .insert(url.to_string(), Ok(response));
            self
        }

        fn with_fetch_error(self, url: &str, message: &str) -> Self {
            self.responses
                .lock()
                .unwrap()
                .insert(url.to_string(), Err(message.to_string()));
            self
        }

        fn fetched(&self) -> Vec<String> {
            self.seen
                .lock()
                .unwrap()
                .iter()
                .map(|(url, _, _)| url.clone())
                .collect()
        }

        fn seen(&self) -> Vec<(String, Vec<IpAddr>, Route)> {
            self.seen.lock().unwrap().clone()
        }
    }

    #[async_trait]
    impl HttpProbe for FakeProbe {
        async fn resolve(&self, host: &str, _port: u16) -> Result<Vec<IpAddr>, String> {
            self.hosts
                .lock()
                .unwrap()
                .get(host)
                .cloned()
                .ok_or_else(|| format!("未登记 host：{host}"))
        }

        async fn fetch(
            &self,
            url: &str,
            addrs: &[IpAddr],
            route: &Route,
            _timeout: Duration,
        ) -> Result<ProbeResponse, String> {
            self.seen
                .lock()
                .unwrap()
                .push((url.to_string(), addrs.to_vec(), route.clone()));
            match self.responses.lock().unwrap().get(url) {
                Some(Ok(response)) => Ok(response.clone()),
                Some(Err(message)) => Err(message.clone()),
                None => Ok(ProbeResponse {
                    status: 200,
                    ..ProbeResponse::default()
                }),
            }
        }
    }

    fn tool_with(probe: Arc<FakeProbe>) -> HttpCheckTool {
        HttpCheckTool::with_probe(
            Arc::new(crate::tools::services::NotWiredServices),
            probe,
        )
    }

    async fn check_error(probe: Arc<FakeProbe>, url: &str) -> (String, String) {
        let tool = tool_with(probe);
        match tool.check(url, Duration::from_millis(DEFAULT_TIMEOUT_MS)).await {
            Ok(value) => panic!("应当被拒：{value}"),
            Err(error) => (
                error.code,
                error
                    .details
                    .and_then(|details| details["reason"].as_str().map(str::to_string))
                    .unwrap_or_default(),
            ),
        }
    }

    #[tokio::test]
    async fn only_https_on_port_443_is_accepted() {
        for (url, reason) in [
            ("http://example.com/", "insecure_scheme"),
            ("ftp://example.com/", "insecure_scheme"),
            ("https://example.com:8443/", "unsupported_port"),
            ("https://user:pass@example.com/", "invalid_url"),
        ] {
            let (code, actual) = check_error(Arc::new(FakeProbe::default()), url).await;
            assert_eq!(code, "INVALID_ARGUMENT", "{url} 必须被拒");
            assert_eq!(actual, reason, "{url} 的 reason 不对");
        }
    }

    #[tokio::test]
    async fn private_and_internal_addresses_are_rejected() {
        let cases = [
            ("localhost", IpAddr::V4(Ipv4Addr::LOCALHOST)),
            ("site.test", IpAddr::V4(Ipv4Addr::new(10, 0, 0, 1))),
            ("site.test", IpAddr::V4(Ipv4Addr::new(127, 0, 0, 1))),
            ("site.test", IpAddr::V6(Ipv6Addr::LOCALHOST)),
            ("site.test", "fe80::1".parse().unwrap()),
            ("site.test", "fd00::1".parse().unwrap()),
            ("site.test", "::ffff:10.0.0.1".parse().unwrap()),
        ];
        for (host, ip) in cases {
            let probe = Arc::new(FakeProbe::default().with_host(host, ip));
            let (code, reason) = check_error(probe, &format!("https://{host}/")).await;
            assert_eq!(code, "INVALID_ARGUMENT", "{ip} 必须被拒");
            assert_eq!(reason, "private_address", "{ip} 的 reason 不对");
        }
    }

    /// 代理路径同样做「首跳解析到私网就拒」：残余风险只在 TOCTOU，不是没校验。
    #[tokio::test]
    async fn the_proxy_route_still_rejects_a_private_first_resolution() {
        let probe = Arc::new(
            FakeProbe::default().with_host("site.test", IpAddr::V4(Ipv4Addr::new(10, 0, 0, 1))),
        );
        let tool = tool_with(probe);
        let target = parse_https_url("https://site.test/").unwrap();
        let error = tool
            .check_with_route(
                "https://site.test/",
                target,
                Duration::from_millis(DEFAULT_TIMEOUT_MS),
                Instant::now(),
                Route::Proxy("http://127.0.0.1:7890".to_string()),
                "tunnel",
            )
            .await
            .unwrap_err();
        assert_eq!(error.code, "INVALID_ARGUMENT");
        assert_eq!(
            error.details.unwrap()["reason"], "private_address",
            "代理模式也必须先做静态校验"
        );
    }

    #[tokio::test]
    async fn a_redirect_into_the_lan_is_rejected_on_the_second_hop() {
        let probe = Arc::new(
            FakeProbe::default()
                .with_response(
                    "https://public.example/start",
                    ProbeResponse {
                        status: 302,
                        location: Some("https://192.168.1.1/admin".to_string()),
                        ..ProbeResponse::default()
                    },
                )
                .with_host("public.example", IpAddr::V4(Ipv4Addr::new(93, 184, 216, 34)))
                .with_host(
                    "192.168.1.1",
                    IpAddr::V4(Ipv4Addr::new(192, 168, 1, 1)),
                ),
        );
        let (code, reason) =
            check_error(Arc::clone(&probe), "https://public.example/start").await;
        assert_eq!(code, "INVALID_ARGUMENT", "重定向到内网必须被拒");
        assert_eq!(reason, "private_address", "第二跳解析到私网");
        assert_eq!(
            probe.fetched(),
            vec!["https://public.example/start".to_string()],
            "第二跳连发都不该发出去"
        );
    }

    #[tokio::test]
    async fn an_https_redirect_is_followed_and_revalidated() {
        let probe = Arc::new(
            FakeProbe::default()
                .with_response(
                    "https://public.example/start",
                    ProbeResponse {
                        status: 302,
                        location: Some("https://other.example/final".to_string()),
                        ..ProbeResponse::default()
                    },
                )
                .with_response(
                    "https://other.example/final",
                    ProbeResponse {
                        status: 203,
                        server: Some("cloudflare".to_string()),
                        cf_mitigated: Some("challenge".to_string()),
                        ..ProbeResponse::default()
                    },
                )
                .with_host("public.example", IpAddr::V4(Ipv4Addr::new(93, 184, 216, 34)))
                .with_host(
                    "other.example",
                    IpAddr::V4(Ipv4Addr::new(93, 184, 216, 35)),
                ),
        );
        let tool = tool_with(probe);
        let value = tool
            .check(
                "https://public.example/start",
                Duration::from_millis(DEFAULT_TIMEOUT_MS),
            )
            .await
            .unwrap();
        assert_eq!(value["status"], 203, "{value}");
        assert_eq!(value["redirects"], 1, "{value}");
        assert_eq!(value["cf_mitigated"], "challenge", "{value}");
        assert_eq!(value["tls_ok"], true, "{value}");
    }

    #[tokio::test]
    async fn a_fetch_failure_is_reported_not_raised() {
        let probe = Arc::new(
            FakeProbe::default()
                .with_fetch_error("https://public.example/", "等响应超时")
                .with_host("public.example", IpAddr::V4(Ipv4Addr::new(93, 184, 216, 34))),
        );
        let tool = tool_with(probe);
        let value = tool
            .check(
                "https://public.example/",
                Duration::from_millis(DEFAULT_TIMEOUT_MS),
            )
            .await
            .unwrap();
        assert!(value["status"].is_null(), "{value}");
        assert_eq!(value["tls_ok"], false, "{value}");
        assert_eq!(value["error"]["code"], "HTTP_CHECK_FAILED", "{value}");
    }

    #[test]
    fn relative_locations_resolve_against_the_current_origin() {
        let target = parse_https_url("https://example.com/a/b?q=1").unwrap();
        let next = next_target(&target, "/c").unwrap();
        assert_eq!(next.url, "https://example.com/c");
        let next = next_target(&target, "d").unwrap();
        assert_eq!(next.url, "https://example.com/a/d");
        let next = next_target(&target, "//other.example/x").unwrap();
        assert_eq!(next.url, "https://other.example/x");
        // `?x=1` 换 query、保留路径（RFC 3986 §5.3）。
        let next = next_target(&target, "?page=2").unwrap();
        assert_eq!(next.url, "https://example.com/a/b?page=2");
        assert!(next_target(&target, "http://example.com/").is_err());
    }

    /// 校验的地址必须原样交给连接层：这就是 DNS rebinding 的封堵点。
    #[tokio::test]
    async fn fetch_gets_exactly_the_validated_addresses() {
        let validated = IpAddr::V4(Ipv4Addr::new(93, 184, 216, 34));
        let probe = Arc::new(FakeProbe::default().with_host("public.example", validated));
        let tool = tool_with(probe.clone());
        let _ = tool
            .check(
                "https://public.example/",
                Duration::from_millis(DEFAULT_TIMEOUT_MS),
            )
            .await
            .unwrap();

        let seen = probe.seen();
        assert_eq!(seen.len(), 1, "只该发一跳");
        assert_eq!(seen[0].1, vec![validated], "连接层拿到的必须是校验过的地址");
        assert_eq!(
            host_of(&seen[0].0).unwrap(),
            "public.example",
            "pin 的 host 与请求的 host 必须是同一个字符串"
        );
        assert_eq!(seen[0].2, Route::Direct, "未连接时直连");
    }

    /// 非 ASCII 主机名会与 pin key 不一致（reqwest 转 punycode），直接拒。
    #[tokio::test]
    async fn a_non_ascii_host_is_rejected() {
        let (code, reason) =
            check_error(Arc::new(FakeProbe::default()), "https://例子.测试/").await;
        assert_eq!(code, "INVALID_ARGUMENT");
        assert_eq!(reason, "invalid_url");
    }

    /// host 必须规范化并同时用于「请求」与「pin」，否则 pin 中不了会回落真实 DNS。
    #[test]
    fn the_host_is_normalized_for_both_the_request_and_the_pin() {
        let target = parse_https_url("https://Example.COM.:443/a?b=1").unwrap();
        assert_eq!(target.host, "example.com");
        assert_eq!(target.url, "https://example.com/a?b=1");
        assert_eq!(host_of(&target.url).unwrap(), target.host);
    }

    #[test]
    fn the_route_follows_the_users_actual_path() {
        // Proxy 连接中：走我们自己的混合端口，代表隧道那条路。
        let (route, via) = route_from_status(&json!({
            "state": "running", "mode": "system_proxy", "mixed_port": 7890
        }));
        assert_eq!(route, Route::Proxy("http://127.0.0.1:7890".to_string()));
        assert_eq!(via, "tunnel");

        // TUN 连接中：直连即可（流量在系统层被接管），但仍代表隧道那条路。
        let (route, via) = route_from_status(&json!({
            "state": "running", "mode": "tun", "mixed_port": Value::Null
        }));
        assert_eq!(route, Route::Direct);
        assert_eq!(via, "tunnel");

        // 未连接：直连，并如实标注。
        let (route, via) = route_from_status(&json!({ "state": "idle" }));
        assert_eq!(route, Route::Direct);
        assert_eq!(via, "direct");

        // Proxy 连接中但拿不到端口：退回直连，绝不能假装走了隧道。
        let (route, via) = route_from_status(&json!({
            "state": "running", "mode": "system_proxy", "mixed_port": Value::Null
        }));
        assert_eq!(route, Route::Direct);
        assert_eq!(via, "direct");
    }
}
