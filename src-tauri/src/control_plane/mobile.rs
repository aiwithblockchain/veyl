//! 手机端导出：确保账户级令牌 → 拼远程配置 URL → 生成 sing-box 二维码。
//!
//! 令牌只在内存里经过一次：不写日志、不进事件、不落本地库（设计 §7.1 / §7.2）。
//! profile 的 origin 只取 [`super::env::current`]，本模块不为它写域名常量（§4.1）；
//! 下载页二维码用的是产品写死的公开链接，与 profile origin 无关。

use std::time::Duration;

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use url::Url;

use super::env;
use super::error::CpError;

/// 路径字面量在 Rust 与 Worker 两侧各有一份（跨语言没有共享常量，§4.1）。
pub const PROFILE_PATH: &str = "/v1/mobile/profile";
const TOKEN_PATH: &str = "/v1/mobile/token";
const TOKEN_ROTATE_PATH: &str = "/v1/mobile/token/rotate";
const PROFILE_USERNAME: &str = "veyl";
const SCHEME_PREFIX: &str = "sing-box://import-remote-profile";
const PROFILE_LABEL: &str = "Veyl";
/// 160 CSS px 的 4 倍：高分屏下清晰，静区由 `qrcode` 的默认实现保留（§4.3）。
const QR_PIXELS: u32 = 640;
/// `mp_` + 32 字节 base64url（43 字符）的固定长度（§1.2）。
const TOKEN_LEN: usize = 46;
const TOKEN_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_RESPONSE_BYTES: usize = 1024 * 1024;
/// 下载页固定 URL。命令不接受前端传入，避免变成任意内容二维码生成器。
pub const CLIENTS_URL: &str = "https://sing-box.sagernet.org/clients/";

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum MobileExportData {
    Ok {
        /// 含令牌：UI 不得渲染为文本 / `alt` / `title`。
        url: String,
        qr_data_url: String,
        node_count: u32,
        created_at: i64,
    },
    LoginRequired,
    NoReadyServer,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct MobileClientsQr {
    pub qr_data_url: String,
}

#[derive(Debug, Deserialize)]
struct TokenResponse {
    token: String,
    created_at: i64,
}

pub async fn get() -> Result<MobileExportData, CpError> {
    export(false).await
}

pub async fn rotate() -> Result<MobileExportData, CpError> {
    export(true).await
}

/// 下载页二维码（仅 UI）：不登录、不调控制面、不涉及令牌。
pub fn clients_qr() -> Result<MobileClientsQr, CpError> {
    Ok(MobileClientsQr {
        qr_data_url: qr_data_url(CLIENTS_URL)?,
    })
}

async fn export(rotate: bool) -> Result<MobileExportData, CpError> {
    let logged_in = super::auth::account_state().logged_in;
    let node_count = ready_server_count();
    if let Some(state) = gate(logged_in, node_count) {
        return Ok(state);
    }

    // 先校验 origin 再建令牌：地址不安全时不应该在控制面留下一条用不了的令牌。
    let origin = ProfileOrigin::parse(&env::current().base_url)?;
    let token = match fetch_token(rotate).await {
        Ok(token) => token,
        Err(error) if is_login_required(&error) => return Ok(MobileExportData::LoginRequired),
        Err(error) => return Err(error),
    };
    let url = origin.profile_url(&token.token)?;
    let qr = qr_data_url(&scheme_url(&url))?;
    log::debug!("手机端导出：rotate={rotate} node_count={node_count}");
    Ok(MobileExportData::Ok {
        url,
        qr_data_url: qr,
        node_count,
        created_at: token.created_at,
    })
}

/// 门禁是预期状态，不是错误（契约 §7.21）。
fn gate(logged_in: bool, node_count: u32) -> Option<MobileExportData> {
    if !logged_in {
        return Some(MobileExportData::LoginRequired);
    }
    if node_count == 0 {
        return Some(MobileExportData::NoReadyServer);
    }
    None
}

/// 本地镜像里「节点已就绪」的自建服务器台数：`active` / `healthy` 且已关联本地节点。
///
/// 判定与左栏行的出现条件一致（§4.4）；只读本地库，不联网。
fn ready_server_count() -> u32 {
    let Some(store) = crate::store::global() else {
        return 0;
    };
    let conn = store.conn();
    conn.query_row(
        "SELECT COUNT(*) FROM my_servers
          WHERE state IN ('active', 'healthy') AND node_id IS NOT NULL",
        [],
        |row| row.get::<_, i64>(0),
    )
    .map(|count| count.clamp(0, i64::from(u32::MAX)) as u32)
    .unwrap_or(0)
}

async fn fetch_token(rotate: bool) -> Result<TokenResponse, CpError> {
    let path = if rotate {
        TOKEN_ROTATE_PATH
    } else {
        TOKEN_PATH
    };
    let raw = post_token(path).await?;
    let token = raw
        .get("token")
        .and_then(Value::as_str)
        .ok_or_else(|| CpError::invalid_response("导出令牌响应缺少 token"))?;
    if !valid_token(token) {
        return Err(token_corrupt());
    }
    let created_at = raw
        .get("created_at")
        .and_then(Value::as_i64)
        .ok_or_else(|| CpError::invalid_response("导出令牌响应缺少 created_at"))?;
    Ok(TokenResponse {
        token: token.to_string(),
        created_at,
    })
}

/// 两个令牌端点的 POST：Bearer + 401 单次刷新，与 `client::ControlPlane` 同口径。
///
/// 不复用 `ControlPlane::post`：共享错误映射会把 `INTERNAL` 的 reason 固定写成
/// `internal`，而这里必须保留控制面的原始 reason（`mobile_token_corrupt` 与
/// 可重试的配置缺失要分开）。路径与状态可记日志，令牌不进日志。
async fn post_token(path: &str) -> Result<Value, CpError> {
    let base_url = env::current().base_url;
    let http = super::client::http_client(TOKEN_TIMEOUT)?;
    let access = super::auth::ensure_access(&base_url, &http, None).await?;
    let (status, body) = send_token(&http, &base_url, path, &access).await?;
    let (status, body) = if status == 401 {
        log::debug!(
            "手机端导出：令牌端点收到 401，刷新后重试一次 path={}",
            super::client::log_path(path)
        );
        let refreshed = super::auth::ensure_access(&base_url, &http, Some(&access)).await?;
        send_token(&http, &base_url, path, &refreshed).await?
    } else {
        (status, body)
    };
    decode_token(path, status, &body)
}

async fn send_token(
    http: &reqwest::Client,
    base_url: &str,
    path: &str,
    access: &str,
) -> Result<(u16, String), CpError> {
    let response = http
        .post(format!("{}{}", base_url.trim_end_matches('/'), path))
        .bearer_auth(access)
        .header(reqwest::header::ACCEPT, "application/json")
        .send()
        .await
        .map_err(|error| {
            super::client::warn_transport("mobile", "POST", path, &error);
            CpError::network(error.is_timeout())
        })?;
    if let Some(length) = response.content_length() {
        if length as usize > MAX_RESPONSE_BYTES {
            return Err(CpError::invalid_response("控制面响应过大"));
        }
    }
    let status = response.status().as_u16();
    let bytes = response.bytes().await.map_err(|error| {
        super::client::warn_transport("mobile", "POST", path, &error);
        CpError::network(error.is_timeout())
    })?;
    if bytes.len() > MAX_RESPONSE_BYTES {
        return Err(CpError::invalid_response("控制面响应过大"));
    }
    let text = String::from_utf8(bytes.to_vec())
        .map_err(|_| CpError::invalid_response("控制面响应不是 UTF-8"))?;
    log::debug!(
        "手机端导出：令牌端点响应 path={} status={status}",
        super::client::log_path(path)
    );
    Ok((status, text))
}

fn decode_token(path: &str, status: u16, body: &str) -> Result<Value, CpError> {
    if !(200..=299).contains(&status) {
        let error = error_from_body(status, body);
        log::warn!(
            "控制面请求失败 op=mobile method=POST path={} kind=status status={status} reason={} retryable={}",
            super::client::log_path(path),
            error.reason().unwrap_or("-"),
            error.retryable
        );
        return Err(error);
    }
    if body.trim().is_empty() {
        return Ok(Value::Null);
    }
    serde_json::from_str(body).map_err(|_| CpError::invalid_response("控制面响应格式不正确"))
}

/// `error::from_response` 会把 `INTERNAL` 的 reason 固定成 `internal`；
/// 令牌端点要区分「密文解不开」与可重试的配置缺失，这里把响应体里的
/// `details.reason` 原样放回。其它码由共享映射保留 reason，不需要再动。
fn error_from_body(status: u16, body: &str) -> CpError {
    let error = super::error::from_response(status, body);
    if error.code != "INTERNAL" {
        return error;
    }
    let reason = serde_json::from_str::<Value>(body).ok().and_then(|value| {
        value
            .get("details")
            .and_then(|details| details.get("reason"))
            .and_then(Value::as_str)
            .map(str::to_string)
    });
    match reason {
        Some(reason) => error.with_reason(&reason),
        None => error,
    }
}

/// 控制面对匿名账户回 `PRECONDITION_FAILED / login_required`（§1.3）。
fn is_login_required(error: &CpError) -> bool {
    error.code == "PRECONDITION_FAILED" && error.reason() == Some("login_required")
}

/// 固定形态：`mp_` + 43 个 base64url 字符。形态不对就不拼进 URL。
fn valid_token(token: &str) -> bool {
    token.len() == TOKEN_LEN
        && token.starts_with("mp_")
        && token[3..]
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}

struct ProfileOrigin {
    base: Url,
}

impl ProfileOrigin {
    /// 语法检查：必须 `https://`，host 不得是 `workers.dev` 或其子域（含尾点写法）（§4.1 / §7.4）。
    fn parse(base_url: &str) -> Result<Self, CpError> {
        let base = Url::parse(base_url.trim()).map_err(|_| insecure_origin())?;
        if base.scheme() != "https" {
            return Err(insecure_origin());
        }
        let host = match base.host_str() {
            Some(host) => host.trim_end_matches('.').to_ascii_lowercase(),
            None => return Err(insecure_origin()),
        };
        if host == "workers.dev" || host.ends_with(".workers.dev") {
            return Err(insecure_origin());
        }
        Ok(Self { base })
    }

    /// `https://veyl:<token>@<base 去掉末尾斜杠>/v1/mobile/profile`。
    fn profile_url(&self, token: &str) -> Result<String, CpError> {
        let mut url = self.base.clone();
        let path = format!("{}{}", url.path().trim_end_matches('/'), PROFILE_PATH);
        url.set_path(&path);
        url.set_query(None);
        url.set_fragment(None);
        url.set_username(PROFILE_USERNAME)
            .map_err(|_| insecure_origin())?;
        url.set_password(Some(token))
            .map_err(|_| insecure_origin())?;
        Ok(url.to_string())
    }
}

/// 扫码内容：`sing-box://import-remote-profile?url=<整体 encode>#Veyl`（§4.2）。
///
/// 用 `form_urlencoded` 的序列化器，不手写转义：`@`、`:`、`&` 漏一个都会让
/// 客户端拿到截断的 URL。
fn scheme_url(profile_url: &str) -> String {
    let query = url::form_urlencoded::Serializer::new(String::new())
        .append_pair("url", profile_url)
        .finish();
    format!("{SCHEME_PREFIX}?{query}#{PROFILE_LABEL}")
}

fn qr_data_url(payload: &str) -> Result<String, CpError> {
    let code = qrcode::QrCode::with_error_correction_level(payload.as_bytes(), qrcode::EcLevel::M)
        .map_err(|_| qr_failed())?;
    let svg = code
        .render::<qrcode::render::svg::Color>()
        .min_dimensions(QR_PIXELS, QR_PIXELS)
        .build();
    Ok(format!(
        "data:image/svg+xml;base64,{}",
        BASE64.encode(svg.as_bytes())
    ))
}

fn insecure_origin() -> CpError {
    CpError::new(
        "PRECONDITION_FAILED",
        "导出链接的服务器地址不安全",
        false,
        json!({ "reason": "insecure_profile_origin" }),
    )
}

fn qr_failed() -> CpError {
    CpError::new(
        "INTERNAL",
        "二维码暂时生成不了",
        false,
        json!({ "reason": "qr_encode_failed" }),
    )
}

fn token_corrupt() -> CpError {
    CpError::new(
        "INTERNAL",
        "导出令牌不可用，请重新生成",
        false,
        json!({ "reason": "mobile_token_corrupt" }),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    const TOKEN: &str = "mp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

    #[test]
    fn token_length_matches_the_contract() {
        assert_eq!(TOKEN.len(), TOKEN_LEN);
    }

    #[test]
    fn origin_accepts_https_without_workers_dev() {
        for base in [
            "https://veyl.dessage.xyz",
            "https://veyl.dessage.xyz/",
            "https://cp-dev.veyl.dessage.xyz",
            "https://example.test/api",
        ] {
            assert!(ProfileOrigin::parse(base).is_ok(), "{base}");
        }
    }

    #[test]
    fn origin_rejects_http_and_workers_dev() {
        for base in [
            "http://veyl.dessage.xyz",
            "https://veyl.workers.dev",
            "https://veyl.workers.dev.",
            "https://veyl.workers.dev..",
            "https://veyl-control-plane.foo.workers.dev",
            "https://workers.dev",
            "https://workers.dev/",
            "https://WORKERS.DEV/",
            "https://x.Workers.Dev./",
            "http://example.test/",
            "",
            "not a url",
        ] {
            let error = ProfileOrigin::parse(base).err().expect(base);
            assert_eq!(error.code, "PRECONDITION_FAILED", "{base}");
            assert_eq!(error.reason(), Some("insecure_profile_origin"), "{base}");
        }
    }

    #[test]
    fn profile_url_puts_the_token_in_userinfo() {
        let origin = ProfileOrigin::parse("https://veyl.dessage.xyz/").unwrap();
        let url = origin.profile_url(TOKEN).unwrap();
        assert_eq!(
            url,
            format!("https://veyl:{TOKEN}@veyl.dessage.xyz/v1/mobile/profile")
        );

        let parsed = Url::parse(&url).unwrap();
        assert_eq!(parsed.username(), "veyl");
        assert_eq!(parsed.password(), Some(TOKEN));
        assert_eq!(parsed.path(), "/v1/mobile/profile");
        assert_eq!(parsed.query(), None);
    }

    #[test]
    fn profile_url_keeps_a_base_path_and_drops_a_trailing_slash() {
        let origin = ProfileOrigin::parse("https://example.test/api/").unwrap();
        assert_eq!(
            origin.profile_url(TOKEN).unwrap(),
            format!("https://veyl:{TOKEN}@example.test/api/v1/mobile/profile")
        );
    }

    #[test]
    fn scheme_url_percent_encodes_the_whole_profile_url() {
        let profile = "https://veyl:mp_x@host.test/v1/mobile/profile?a=1&b=2#frag";
        let scheme = scheme_url(profile);
        assert!(
            scheme.starts_with("sing-box://import-remote-profile?url="),
            "{scheme}"
        );
        assert!(scheme.ends_with("#Veyl"), "{scheme}");
        // 整个 URL 作为一个 query 值：`:` `@` `&` `#` 都不能漏。
        for needle in ["%3A", "%2F", "%40", "%26", "%3D", "%23"] {
            assert!(scheme.contains(needle), "{needle} 未编码：{scheme}");
        }
        let query = scheme.split_once('?').unwrap().1.split('#').next().unwrap();
        let decoded: Vec<_> = url::form_urlencoded::parse(query.as_bytes()).collect();
        assert_eq!(decoded[0].0, "url");
        assert_eq!(decoded[0].1, profile);
    }

    #[test]
    fn gate_returns_the_three_contract_states() {
        assert_eq!(gate(false, 3), Some(MobileExportData::LoginRequired));
        assert_eq!(gate(true, 0), Some(MobileExportData::NoReadyServer));
        assert_eq!(gate(true, 2), None);
    }

    #[test]
    fn token_shape_is_pinned() {
        assert!(valid_token(TOKEN));
        for bad in [
            "",
            "mp_",
            "mp_short",
            "cp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
            "mp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA!",
            "mp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        ] {
            assert!(!valid_token(bad), "{bad:?}");
        }
    }

    #[test]
    fn internal_errors_keep_the_control_plane_reason() {
        let corrupt = error_from_body(
            500,
            r#"{"code":"INTERNAL","message":"令牌读取失败，请重新生成","retryable":false,"details":{"reason":"mobile_token_corrupt"}}"#,
        );
        assert_eq!(corrupt.code, "INTERNAL");
        assert_eq!(corrupt.reason(), Some("mobile_token_corrupt"));
        assert!(!corrupt.retryable);

        // 可重试的配置缺失不能被误报成「令牌损坏」。
        for reason in [
            "mobile_token_missing",
            "credential_key_missing",
            "mobile_key_missing",
        ] {
            let body = format!(
                r#"{{"code":"INTERNAL","message":"暂时不可用","retryable":true,"details":{{"reason":"{reason}"}}}}"#
            );
            let error = error_from_body(503, &body);
            assert_eq!(error.reason(), Some(reason), "{reason}");
            assert!(error.retryable, "{reason}");
        }

        // 响应体没有 reason 时保持共享映射的兜底。
        let bare = error_from_body(
            500,
            r#"{"code":"INTERNAL","message":"内部错误","retryable":false,"details":{}}"#,
        );
        assert_eq!(bare.reason(), Some("internal"));
    }

    #[test]
    fn non_internal_errors_pass_through_the_shared_mapping() {
        let limited = error_from_body(
            429,
            r#"{"code":"RATE_LIMITED","message":"稍后再试","retryable":true,"details":{"reason":"mobile_token_rate_limited"}}"#,
        );
        assert_eq!(limited.code, "RATE_LIMITED");
        assert_eq!(limited.reason(), Some("mobile_token_rate_limited"));
        assert!(limited.retryable);
    }

    #[test]
    fn login_required_from_the_control_plane_is_recognized() {
        assert!(is_login_required(&CpError::new(
            "PRECONDITION_FAILED",
            "需要登录",
            false,
            json!({ "reason": "login_required" }),
        )));
        assert!(!is_login_required(&CpError::new(
            "PRECONDITION_FAILED",
            "需要登录",
            false,
            json!({ "reason": "auth_required" }),
        )));
    }

    #[test]
    fn qr_is_an_svg_data_url() {
        let origin = ProfileOrigin::parse("https://veyl.dessage.xyz").unwrap();
        let url = origin.profile_url(TOKEN).unwrap();
        let data_url = qr_data_url(&scheme_url(&url)).unwrap();
        let encoded = data_url
            .strip_prefix("data:image/svg+xml;base64,")
            .expect("prefix");
        let svg = String::from_utf8(BASE64.decode(encoded).unwrap()).unwrap();
        assert!(svg.contains("<svg"), "{}", &svg[..svg.len().min(80)]);
        assert!(svg.contains("viewBox"), "静区与尺寸由 SVG 自身表达");
        assert!(!svg.contains(TOKEN), "二维码内容不能出现在 SVG 文本里");
    }

    #[test]
    fn clients_qr_is_the_fixed_download_page_and_carries_no_token() {
        let clients = clients_qr().unwrap();
        assert_eq!(
            clients.qr_data_url,
            qr_data_url(CLIENTS_URL).unwrap(),
            "二维码内容必须是写死的下载页 URL"
        );
        let encoded = clients
            .qr_data_url
            .strip_prefix("data:image/svg+xml;base64,")
            .expect("prefix");
        let svg = String::from_utf8(BASE64.decode(encoded).unwrap()).unwrap();
        assert!(svg.contains("<svg"), "解码后必须是 SVG");
        assert!(!clients.qr_data_url.contains("mp_"), "不得含任何令牌");
        assert_eq!(CLIENTS_URL, "https://sing-box.sagernet.org/clients/");
    }

    #[test]
    fn clients_qr_serializes_as_the_contract_shape() {
        let value = serde_json::to_value(clients_qr().unwrap()).unwrap();
        assert_eq!(value.as_object().unwrap().len(), 1);
        assert!(value["qr_data_url"]
            .as_str()
            .unwrap()
            .starts_with("data:image/svg+xml;base64,"));
    }

    #[test]
    fn data_serializes_the_contract_shape() {
        let ok = serde_json::to_value(MobileExportData::Ok {
            url: "https://veyl:t@host.test/v1/mobile/profile".into(),
            qr_data_url: "data:image/svg+xml;base64,AA".into(),
            node_count: 2,
            created_at: 1_763_596_800_000,
        })
        .unwrap();
        assert_eq!(ok["state"], "ok");
        assert_eq!(ok["node_count"], 2);
        assert_eq!(ok["created_at"], 1_763_596_800_000_i64);
        assert_eq!(
            serde_json::to_value(MobileExportData::LoginRequired).unwrap()["state"],
            "login_required"
        );
        assert_eq!(
            serde_json::to_value(MobileExportData::NoReadyServer).unwrap()["state"],
            "no_ready_server"
        );
    }
}
