//! 设备身份与令牌（`my-servers.md` §19.2）。
//!
//! - `device_secret` / `device_id` 只生成一次，存本地加密凭据库，**永不发给前端**；
//! - access 15 分钟、refresh 30 天滑动；刷新单飞，旧 refresh 重放由控制面按族作废；
//! - 刷新被拒（401）→ 用 `device_secret` 重新注册；注册失败原样上报。
//!
//! 存储说明：本仓库的 `secrets` 模块用机器绑定的本地密文文件（AES-256-GCM，0600），
//! 不读写系统钥匙串（macOS 每次访问都可能弹授权框）。与设计稿写的 Keychain 有差异，
//! 已在交付说明里标注。

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::time::Duration;

use super::error::{self, CpError};

const DEVICE_KEY: &str = "control-plane.device";
const TOKENS_KEY: &str = "control-plane.tokens";
/// SQLite 里的账户标记：只用来区分「首次使用」与「钥匙串/本地凭据丢了」。
const ACCOUNT_MARKER: &str = "control_plane_account_id";
const ACCESS_SKEW_MS: i64 = 30_000;

/// 全进程共享：并发请求同时发现 access 过期时只刷新一次，避免 refresh 互相作废。
static REFRESH_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[derive(Debug, Clone, Serialize, Deserialize)]
struct StoredDevice {
    device_id: String,
    device_secret: String,
    #[serde(default)]
    account_id: String,
}

/// 与 `POST /v1/auth/device` / `POST /v1/auth/refresh` 的成功响应一一对应。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct TokenSet {
    pub account_id: String,
    pub device_id: String,
    pub access_token: String,
    pub access_expires_at: String,
    pub refresh_token: String,
    pub refresh_expires_at: String,
}

pub fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn expires_ms(value: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|time| time.timestamp_millis())
}

/// access 是否还能用：留 30 秒余量，避免请求发出时刚好过期。
pub fn access_valid(tokens: &TokenSet, now: i64) -> bool {
    expires_ms(&tokens.access_expires_at)
        .map(|expires| expires - ACCESS_SKEW_MS > now)
        .unwrap_or(false)
}

fn b64u(bytes: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(bytes)
}

fn random_b64u(size: usize) -> String {
    use rand::RngCore;
    let mut bytes = vec![0u8; size];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    b64u(&bytes)
}

pub fn secret_hash(secret: &str) -> String {
    b64u(&Sha256::digest(secret.as_bytes()))
}

fn new_device() -> StoredDevice {
    StoredDevice {
        device_id: format!("dev_{}", random_b64u(16)),
        device_secret: random_b64u(32),
        account_id: String::new(),
    }
}

fn load_device() -> Result<StoredDevice, CpError> {
    match crate::secrets::get_secret(DEVICE_KEY) {
        Ok(Some(raw)) => serde_json::from_str(&raw)
            .map_err(|_| CpError::internal("本地设备身份已损坏，请重新注册设备")),
        Ok(None) => {
            // 本地有账户标记、但设备秘密没了：这是「身份丢失」，不能悄悄建新账户
            // （§19.2.4：旧服务器仍在计费，却会从列表里消失）。
            if stored_account_marker().is_some() {
                return Err(CpError::new(
                    "PRECONDITION_FAILED",
                    "这台设备的身份已丢失。已买的服务器仍在计费，这里无法管理。",
                    false,
                    json!({ "reason": "device_identity_lost" }),
                ));
            }
            let device = new_device();
            store_device(&device)?;
            Ok(device)
        }
        Err(_) => Err(CpError::internal("本地凭据存储不可用")),
    }
}

fn store_device(device: &StoredDevice) -> Result<(), CpError> {
    let raw = serde_json::to_string(device).map_err(|_| CpError::internal("序列化设备身份失败"))?;
    crate::secrets::set_secret(DEVICE_KEY, &raw)
        .map_err(|_| CpError::internal("保存设备身份失败"))
}

fn load_tokens() -> Option<TokenSet> {
    crate::secrets::get_secret(TOKENS_KEY)
        .ok()
        .flatten()
        .and_then(|raw| serde_json::from_str(&raw).ok())
}

fn store_tokens(tokens: &TokenSet) -> Result<(), CpError> {
    let raw = serde_json::to_string(tokens).map_err(|_| CpError::internal("序列化令牌失败"))?;
    crate::secrets::set_secret(TOKENS_KEY, &raw).map_err(|_| CpError::internal("保存令牌失败"))?;
    remember_account(&tokens.account_id);
    Ok(())
}

/// SQLite 只镜像 `account_id`，不含任何可用于认证的材料。
fn stored_account_marker() -> Option<String> {
    let store = crate::store::global()?;
    let conn = store.conn();
    crate::store::settings::get(&conn, ACCOUNT_MARKER)
        .ok()
        .flatten()
}

fn remember_account(account_id: &str) {
    if account_id.trim().is_empty() {
        return;
    }
    let Some(store) = crate::store::global() else {
        return;
    };
    let conn = store.conn();
    let _ = crate::store::settings::set(&conn, ACCOUNT_MARKER, account_id);
}

fn clear_tokens() {
    let _ = crate::secrets::delete_secret(TOKENS_KEY);
}

fn registration_body(device: &StoredDevice) -> serde_json::Value {
    json!({
        "device_id": device.device_id,
        "secret_hash": secret_hash(&device.device_secret),
        "platform": std::env::consts::OS,
        "app_version": env!("CARGO_PKG_VERSION"),
    })
}

fn endpoint(base_url: &str, path: &str) -> String {
    format!("{}{}", base_url.trim_end_matches('/'), path)
}

async fn send_json(
    http: &reqwest::Client,
    url: &str,
    body: &serde_json::Value,
) -> Result<(u16, String), CpError> {
    let response = http
        .post(url)
        .header(reqwest::header::ACCEPT, "application/json")
        .json(body)
        .send()
        .await
        .map_err(|error| CpError::network(error.is_timeout()))?;
    let status = response.status().as_u16();
    let text = response.text().await.unwrap_or_default();
    Ok((status, text))
}

async fn register(
    base_url: &str,
    http: &reqwest::Client,
    device: &StoredDevice,
) -> Result<TokenSet, CpError> {
    let (status, body) =
        send_json(http, &endpoint(base_url, "/v1/auth/device"), &registration_body(device)).await?;
    if !(200..=299).contains(&status) {
        return Err(error::from_response(status, &body));
    }
    let tokens: TokenSet = serde_json::from_str(&body)
        .map_err(|_| CpError::invalid_response("设备注册响应格式不正确"))?;
    store_tokens(&tokens)?;
    let mut updated = device.clone();
    updated.account_id = tokens.account_id.clone();
    let _ = store_device(&updated);
    Ok(tokens)
}

async fn refresh(
    base_url: &str,
    http: &reqwest::Client,
    refresh_token: &str,
) -> Result<TokenSet, CpError> {
    let body = json!({ "refresh_token": refresh_token });
    let (status, text) =
        send_json(http, &endpoint(base_url, "/v1/auth/refresh"), &body).await?;
    if !(200..=299).contains(&status) {
        return Err(error::from_response(status, &text));
    }
    let tokens: TokenSet = serde_json::from_str(&text)
        .map_err(|_| CpError::invalid_response("令牌刷新响应格式不正确"))?;
    store_tokens(&tokens)?;
    Ok(tokens)
}

/// 刷新被拒后该怎么办。401（无效 / 过期 / 重放）→ 用 `device_secret` 重新注册；
/// 其它错误原样上报（403 设备停用、429 限流等）。
pub enum RefreshAction {
    ReRegister,
    Fatal(CpError),
}

pub fn classify_refresh_failure(status: u16, body: &str) -> RefreshAction {
    let error = error::from_response(status, body);
    if status == 401 || error.reason() == Some("auth_required") {
        RefreshAction::ReRegister
    } else {
        RefreshAction::Fatal(error)
    }
}

/// 显式重新注册（§19.2.4 的「重新注册设备」）：
/// 丢弃当前 device_id / device_secret / 令牌，生成新身份并静默注册。
/// 旧服务器的本地记录保留为只读；新账户从空列表开始。
pub async fn register_device() -> Result<Value, CpError> {
    let base_url = crate::control_plane::env::current().base_url;
    let http = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|error| CpError::internal(format!("创建控制面客户端失败：{error}")))?;

    // 与自动刷新/注册共用一把锁：重新注册期间不允许并发请求拿着旧令牌发出去。
    let _guard = REFRESH_LOCK.lock().await;
    let _ = crate::secrets::delete_secret(DEVICE_KEY);
    let _ = crate::secrets::delete_secret(TOKENS_KEY);

    let device = new_device();
    store_device(&device)?;
    let tokens = register(&base_url, &http, &device).await?;
    Ok(json!({
        "account_id": tokens.account_id,
        "device_id": tokens.device_id,
    }))
}

/// 取一个可用的 access token；`stale` 是刚被 401 拒掉的那个（并发刷新在锁内复核用）。
pub async fn ensure_access(
    base_url: &str,
    http: &reqwest::Client,
    stale: Option<&str>,
) -> Result<String, CpError> {
    let _guard = REFRESH_LOCK.lock().await;

    if let Some(tokens) = load_tokens() {
        let fresh = access_valid(&tokens, now_ms());
        let superseded = stale.map(|value| value != tokens.access_token).unwrap_or(false);
        if fresh && (stale.is_none() || superseded) {
            return Ok(tokens.access_token);
        }
    }

    let device = load_device()?;

    let tokens = match load_tokens() {
        Some(tokens) => match refresh(base_url, http, &tokens.refresh_token).await {
            Ok(tokens) => tokens,
            Err(error) if error.reason() == Some("auth_required") => {
                // 刷新令牌无效 / 过期 / 被重放：用长期秘密重新注册（§19.2.4）。
                clear_tokens();
                register(base_url, http, &device).await?
            }
            Err(error) => return Err(error),
        },
        None => register(base_url, http, &device).await?,
    };

    Ok(tokens.access_token)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tokens(access_expires_at: &str) -> TokenSet {
        TokenSet {
            account_id: "acct_1".into(),
            device_id: "dev_1".into(),
            access_token: "access".into(),
            access_expires_at: access_expires_at.into(),
            refresh_token: "refresh".into(),
            refresh_expires_at: "2027-01-01T00:00:00Z".into(),
        }
    }

    #[test]
    fn access_expiry_keeps_a_thirty_second_margin() {
        let now = chrono::DateTime::parse_from_rfc3339("2026-11-14T08:00:00Z")
            .unwrap()
            .timestamp_millis();
        assert!(access_valid(&tokens("2026-11-14T08:00:31Z"), now));
        assert!(!access_valid(&tokens("2026-11-14T08:00:20Z"), now));
        assert!(!access_valid(&tokens("not-a-time"), now));
    }

    #[test]
    fn the_secret_hash_is_base64url_sha256() {
        let hash = secret_hash("s3cret");
        assert_eq!(hash.len(), 43);
        assert!(!hash.contains('='));
        assert!(!hash.contains('+'));
        assert!(!hash.contains('/'));
    }

    #[test]
    fn the_registration_body_sends_only_the_hash() {
        let device = StoredDevice {
            device_id: "dev_abc".into(),
            device_secret: "super-secret".into(),
            account_id: String::new(),
        };
        let body = registration_body(&device);
        assert_eq!(body["device_id"], "dev_abc");
        assert_eq!(body["secret_hash"], secret_hash("super-secret"));
        assert!(body.get("device_secret").is_none());
        assert!(body.get("secret").is_none());
    }

    #[test]
    fn a_replayed_refresh_token_falls_back_to_registration() {
        // 401 + refresh_reused：控制面已作废整族，只能重新注册。
        assert!(matches!(
            classify_refresh_failure(
                401,
                r#"{"code":"UNAUTHENTICATED","details":{"reason":"refresh_reused"}}"#
            ),
            RefreshAction::ReRegister
        ));
        // 403 设备停用：不能靠重注册绕过。
        match classify_refresh_failure(
            403,
            r#"{"code":"FORBIDDEN","details":{"reason":"device_revoked"}}"#,
        ) {
            RefreshAction::Fatal(error) => {
                assert_eq!(error.code, "PERMISSION_DENIED");
                assert!(!error.retryable);
            }
            _ => panic!("403 必须是不可重试错误"),
        }
        // 429：可重试，不重注册。
        match classify_refresh_failure(429, r#"{"code":"RATE_LIMITED"}"#) {
            RefreshAction::Fatal(error) => {
                assert_eq!(error.code, "RATE_LIMITED");
                assert!(error.retryable);
            }
            _ => panic!("429 必须是可重试错误"),
        }
    }
}
