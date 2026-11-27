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
use std::sync::atomic::{AtomicI64, AtomicU8, Ordering};
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

/// 与 `POST /v1/auth/device` / `POST /v1/auth/refresh` / 登录接口的成功响应一一对应。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct TokenSet {
    pub account_id: String,
    pub device_id: String,
    pub access_token: String,
    pub access_expires_at: String,
    pub refresh_token: String,
    pub refresh_expires_at: String,
    /// `device` | `email`（2.27.0 登录后才有）。旧令牌没有这个字段，按未登录处理。
    #[serde(default)]
    pub account_kind: String,
    #[serde(default)]
    pub email: Option<String>,
}

/// 登录态（返回给界面，不含令牌）。
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct AccountState {
    pub logged_in: bool,
    pub email: Option<String>,
    pub account_id: Option<String>,
    pub device_id: Option<String>,
    /// `device` | `email`；`null` = 还没有设备身份（或旧令牌没有这个字段）。
    pub account_kind: Option<String>,
    /// refresh 到期时间（ISO 8601）；没有邮箱登录会话时为 `null`。
    pub session_expires_at: Option<String>,
}

/// `my_server_login_start` 的返回。
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct LoginTicket {
    pub sent: bool,
    pub cooldown_seconds: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retry_after_seconds: Option<u64>,
}

#[derive(Debug, Deserialize)]
struct LoginStartResponse {
    #[serde(default = "default_sent")]
    sent: bool,
    #[serde(default = "default_cooldown")]
    cooldown_seconds: u64,
}

fn default_sent() -> bool {
    true
}

fn default_cooldown() -> u64 {
    60
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

impl TokenSet {
    /// refresh 是否还在有效期内。时间解析失败按已过期处理：宁可让用户重新登录，
    /// 也不能拿一个读不出到期时间的令牌继续声称「已登录」。
    pub fn refresh_valid(&self, now: i64) -> bool {
        expires_ms(&self.refresh_expires_at)
            .map(|expires| expires > now)
            .unwrap_or(false)
    }
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

/// 测试用：跨模块摆出登录态（工具门禁用例）。写的是进程级共享凭据库，
/// 调用方必须持有 `test_support::AUTH_STATE_LOCK`。
#[cfg(test)]
pub(crate) fn store_tokens_for_test(tokens: &TokenSet) {
    store_tokens(tokens).expect("测试里写令牌不该失败");
}

/// 测试用：清掉本地令牌，回到未登录态。
#[cfg(test)]
pub(crate) fn clear_tokens_for_test() {
    clear_tokens();
}

/// 测试用：造一个可用的设备身份（`account_kind` 需要设备 id 才成立）。
#[cfg(test)]
pub(crate) fn store_device_for_test(device_id: &str) {
    store_device(&StoredDevice {
        device_id: device_id.to_string(),
        device_secret: "test-device-secret".to_string(),
        account_id: String::new(),
    })
    .expect("测试里写设备身份不该失败");
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

/// 账户标记只是本机镜像，清令牌时必须一起清掉，否则界面还会拿它当「登录过」。
fn forget_account() {
    let Some(store) = crate::store::global() else {
        return;
    };
    let conn = store.conn();
    let _ = crate::store::settings::delete(&conn, ACCOUNT_MARKER);
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
    path: &str,
    body: &serde_json::Value,
) -> Result<(u16, String), CpError> {
    let response = http
        .post(url)
        .header(reqwest::header::ACCEPT, "application/json")
        .json(body)
        .send()
        .await
        .map_err(|error| {
            super::client::warn_transport("auth", "POST", path, &error);
            // 登录 / 刷新 / 注册同样会反映控制面可达性：传输失败记不可达。
            note_control_plane_unreachable(error.is_timeout());
            CpError::network(error.is_timeout())
        })?;
    let status = response.status().as_u16();
    // 拿到 HTTP 响应（含 401 / 5xx）就说明控制面可达。
    note_control_plane_reachable();
    // 响应体读到一半断开是传输失败，不是「格式不对」：必须可重试，
    // 否则刷新丢响应会被判成 invalid_response，跳过自动重试又被踢下线。
    let text = response.text().await.map_err(|error| {
        super::client::warn_transport("auth", "POST", path, &error);
        CpError::network(error.is_timeout())
    })?;
    Ok((status, text))
}

fn log_status_failure(path: &str, status: u16, error: &CpError) {
    super::client::warn_failure(
        "auth",
        "POST",
        path,
        "status",
        Some(status),
        error.retryable,
        error.reason().unwrap_or("-"),
        "-",
    );
}

async fn register(
    base_url: &str,
    http: &reqwest::Client,
    device: &StoredDevice,
) -> Result<TokenSet, CpError> {
    let path = "/v1/auth/device";
    let (status, body) =
        send_json(http, &endpoint(base_url, path), path, &registration_body(device)).await?;
    if !(200..=299).contains(&status) {
        let error = error::from_response(status, &body);
        log_status_failure(path, status, &error);
        return Err(error);
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
    let path = "/v1/auth/refresh";
    let body = json!({ "refresh_token": refresh_token });
    let (status, text) = send_json(http, &endpoint(base_url, path), path, &body).await?;
    if !(200..=299).contains(&status) {
        let error = error::from_response(status, &text);
        log_status_failure(path, status, &error);
        return Err(error);
    }
    let tokens: TokenSet = serde_json::from_str(&text)
        .map_err(|_| CpError::invalid_response("令牌刷新响应格式不正确"))?;
    let mut tokens = tokens;
    // 刷新响应若省略登录字段，不能把本地登录态冲掉（§3.3）。
    if tokens.account_kind.is_empty() {
        if let Some(previous) = load_tokens() {
            tokens.account_kind = previous.account_kind;
            tokens.email = tokens.email.or(previous.email);
        }
    }
    store_tokens(&tokens)?;
    Ok(tokens)
}

/// 刷新遇到可重试错误后，隔多久再试一次。
///
/// **只重试一次**：服务端对每枚旧 refresh 的宽限赎回只允许一次（`redeemed_count < 1`），
/// 第一次重试**可能**用掉这一次（仅当第一次请求已到达服务端并完成轮换——客户端分不清
/// 「没发出去」和「到了、回程丢了」）；若再失败后第三次还拿同一枚旧令牌去换，会被判
/// 重放、整族作废。所以不做多轮退避。测试里不真等，`cfg(test)` 下是 0。
#[cfg(not(test))]
const REFRESH_RETRY_DELAY: Duration = Duration::from_secs(2);
#[cfg(test)]
const REFRESH_RETRY_DELAY: Duration = Duration::ZERO;

/// 从发第一次请求起，最多等这么久；超过就放弃重试、原样返回第一次的错误。
///
/// 预算覆盖「第一次请求 + 等待」的**总耗时**：第一次请求自身最长可能耗 10 秒
/// （`client.rs` 的请求超时），服务端的宽限又是从轮换发生的那一刻开始算、比第一次
/// 请求更早。睡眠还可能被系统挂起 / App Nap 拉长成几分钟。超过预算后再用旧令牌重试
/// 大概率已越过 60 秒宽限，只会把「重放」坐实、作废整族；50 秒是给宽限留 10 秒余量
/// 与时钟误差。
const REFRESH_RETRY_MAX_WAITED: Duration = Duration::from_secs(50);

/// 刷新一次；可重试错误（网络 / 5xx / 429）固定等 `REFRESH_RETRY_DELAY` 再试一次。
///
/// 「服务端已轮换、回程响应却被网络重置」时，客户端只看到连接错误、本地仍是旧 refresh。
/// 若等到下一次触发再刷（可能几十分钟后），早已越过服务端 60 秒宽限，会被判重放并
/// 作废整族；立刻重试一次能在宽限内完成赎回。会话已失效的错误绝不重试。
async fn refresh_with_retry(
    base_url: &str,
    http: &reqwest::Client,
    refresh_token: &str,
) -> Result<TokenSet, CpError> {
    // 从第一次请求发出前开始计时：50 秒预算要覆盖「第一次请求 + 等待」的总耗时，
    // 只算睡眠的话，10 秒请求超时加 50 秒等待正好擦着服务端 60 秒宽限。
    let started = std::time::Instant::now();
    let error = match refresh(base_url, http, refresh_token).await {
        Ok(tokens) => return Ok(tokens),
        Err(error) if error.retryable && !session_is_dead(&error) => error,
        Err(error) => return Err(error),
    };
    log::debug!(
        "鉴权：刷新可重试失败，{} 毫秒后重试一次 code={} reason={}",
        REFRESH_RETRY_DELAY.as_millis(),
        error.code,
        error.reason().unwrap_or("-")
    );
    tokio::time::sleep(REFRESH_RETRY_DELAY).await;
    if started.elapsed() > REFRESH_RETRY_MAX_WAITED {
        log::debug!(
            "鉴权：刷新重试等待过久（{} 毫秒），放弃重试以免越过宽限",
            started.elapsed().as_millis()
        );
        return Err(error);
    }
    match refresh(base_url, http, refresh_token).await {
        Ok(tokens) => Ok(tokens),
        Err(error) => {
            log::debug!(
                "鉴权：刷新重试仍失败 code={} reason={} retryable={}",
                error.code,
                error.reason().unwrap_or("-"),
                error.retryable
            );
            Err(error)
        }
    }
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

/// 刷新失败是否意味着「登录真的没了」。
///
/// 网络错误、5xx、429 都不是：断网一次不能把用户踢下线。只有服务端明确的认证失效
/// （`UNAUTHENTICATED`：`token_invalid` / `auth_required` / `refresh_unknown` /
/// 重放检测 `refresh_reused`）与设备 / 账户被停用（`device_revoked` / `account_blocked`）
/// 才算。
fn session_is_dead(error: &CpError) -> bool {
    if error.code == "UNAUTHENTICATED" {
        return true;
    }
    if error.code == "PERMISSION_DENIED" {
        return matches!(
            error.reason(),
            Some("device_revoked") | Some("account_blocked")
        );
    }
    // 上游 UNAUTHENTICATED 的非登录 reason（`refresh_unknown` / 重放 `refresh_reused`）
    // 由 `from_response` 映射成 `PRECONDITION_FAILED / auth_required`，同样算掉登录。
    error.reason() == Some("auth_required")
}

/// 邮箱账户刷新失败后对外报什么。
///
/// 设备 / 账户被停用要保留原错误：邮箱登录本身也会拒绝已停用设备（403
/// `device_revoked`），改写成「登录已过期」只会让用户反复重登失败。只有真正的
/// 认证失效才合成为 `token_invalid`，提示重新登录。
fn email_refresh_error(error: CpError) -> CpError {
    if error.code == "PERMISSION_DENIED" {
        return error;
    }
    CpError::new(
        "UNAUTHENTICATED",
        "登录已过期，请重新登录",
        true,
        json!({ "reason": "token_invalid" }),
    )
}

/// 显式重新注册（§19.2.4 的「重新注册设备」）：
/// 丢弃当前 device_id / device_secret / 令牌，生成新身份并静默注册。
/// 旧服务器的本地记录保留为只读；新账户从空列表开始。
pub async fn register_device() -> Result<Value, CpError> {
    let base_url = crate::control_plane::env::current().base_url;
    let http = super::client::http_client(Duration::from_secs(10))?;

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

/// 只读本地设备身份：不生成、不重建（`my_server_account` 用）。
fn existing_device() -> Option<StoredDevice> {
    crate::secrets::get_secret(DEVICE_KEY)
        .ok()
        .flatten()
        .and_then(|raw| serde_json::from_str(&raw).ok())
}

/// 登录前拿设备身份：身份丢失时换发新的（§3.5：登录优先于重新注册设备）。
fn device_for_login() -> Result<StoredDevice, CpError> {
    match load_device() {
        Ok(device) => Ok(device),
        Err(error) if error.reason() == Some("device_identity_lost") => {
            let device = new_device();
            store_device(&device)?;
            Ok(device)
        }
        Err(error) => Err(error),
    }
}

fn account_state_from(tokens: Option<TokenSet>, device_id: Option<String>) -> AccountState {
    // 没有设备身份、或还没有令牌 → 不给 kind（旧令牌没有该字段同样落空）。
    let account_kind = match (
        device_id.as_deref(),
        tokens.as_ref().map(|tokens| tokens.account_kind.as_str()),
    ) {
        (Some(_), Some("email")) => Some("email".to_string()),
        (Some(_), Some("device")) => Some("device".to_string()),
        _ => None,
    };
    let logged_in = account_kind.as_deref() == Some("email")
        && tokens
            .as_ref()
            .map(|tokens| tokens.refresh_valid(now_ms()))
            .unwrap_or(false);
    // 会话到期时间给界面显示；过期的也照给（界面才能说「已过期」），
    // 但解析不出来的字符串不下发，否则界面算出无效日期。
    let session_expires_at = match (tokens.as_ref(), account_kind.as_deref()) {
        (Some(tokens), Some("email"))
            if expires_ms(&tokens.refresh_expires_at).is_some() =>
        {
            Some(tokens.refresh_expires_at.clone())
        }
        _ => None,
    };
    let (account_id, email) = match tokens {
        Some(tokens) if logged_in => (Some(tokens.account_id), tokens.email),
        _ => (None, None),
    };
    AccountState {
        logged_in,
        email,
        account_id,
        device_id,
        account_kind,
        session_expires_at,
    }
}

/// 只读本地登录态：不联网、不刷新、不生成设备身份。
pub fn account_state() -> AccountState {
    account_state_from(
        load_tokens(),
        existing_device().map(|device| device.device_id),
    )
}

/// 控制面可达性结论：0 = 可达 / 未知，1 = 网络类失败，2 = 超时。
///
/// 只用于把「连不上」和「未登录」分开（`my_server_account`）。它不参与登录态
/// 推导：网络错误永远不改 `logged_in`，也不清本地令牌。
static CONTROL_PLANE_STATE: AtomicU8 = AtomicU8::new(STATE_REACHABLE);
static CONTROL_PLANE_STATE_AT: AtomicI64 = AtomicI64::new(0);
const STATE_REACHABLE: u8 = 0;
const STATE_NETWORK: u8 = 1;
const STATE_TIMEOUT: u8 = 2;
/// 超过这个时间没有新请求，就不再拿旧的失败结论吓用户。
const UNREACHABLE_TTL_MS: i64 = 60_000;

pub(crate) fn note_control_plane_reachable() {
    CONTROL_PLANE_STATE.store(STATE_REACHABLE, Ordering::Relaxed);
    CONTROL_PLANE_STATE_AT.store(now_ms(), Ordering::Relaxed);
}

pub(crate) fn note_control_plane_unreachable(timeout: bool) {
    CONTROL_PLANE_STATE.store(
        if timeout {
            STATE_TIMEOUT
        } else {
            STATE_NETWORK
        },
        Ordering::Relaxed,
    );
    CONTROL_PLANE_STATE_AT.store(now_ms(), Ordering::Relaxed);
}

/// 最近一次请求的「不可达」结论（60 秒内有效）。`None` = 可达或还没请求过。
pub fn control_plane_unreachable() -> Option<CpError> {
    unreachable_error(
        CONTROL_PLANE_STATE.load(Ordering::Relaxed),
        CONTROL_PLANE_STATE_AT.load(Ordering::Relaxed),
        now_ms(),
    )
}

/// 测试用：清掉进程级可达性结论，避免与并行用例互相影响。
#[cfg(test)]
pub(crate) fn reset_control_plane_state_for_test() {
    CONTROL_PLANE_STATE.store(STATE_REACHABLE, Ordering::Relaxed);
    CONTROL_PLANE_STATE_AT.store(0, Ordering::Relaxed);
}

/// 测试用：串起所有读写上面两个原子量的用例（auth 与 client 的测试共用）。
#[cfg(test)]
pub(crate) static CONTROL_PLANE_STATE_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn unreachable_error(state: u8, at: i64, now: i64) -> Option<CpError> {
    if state == STATE_REACHABLE || now - at > UNREACHABLE_TTL_MS {
        return None;
    }
    Some(CpError::network(state == STATE_TIMEOUT))
}

/// 发邮箱验证码（`POST /v1/auth/email/start`）。是否注册过同一返回，防枚举。
pub async fn login_start(email: &str) -> Result<LoginTicket, CpError> {
    let base_url = crate::control_plane::env::current().base_url;
    let http = super::client::http_client(Duration::from_secs(10))?;
    let path = "/v1/auth/email/start";
    let body = json!({ "email": email });
    let (status, text) = send_json(&http, &endpoint(&base_url, path), path, &body).await?;
    if !(200..=299).contains(&status) {
        let error = error::from_response(status, &text);
        log_status_failure(path, status, &error);
        return Err(error);
    }
    let response: LoginStartResponse = serde_json::from_str(&text)
        .map_err(|_| CpError::invalid_response("发码响应格式不正确"))?;
    Ok(LoginTicket {
        sent: response.sent,
        cooldown_seconds: response.cooldown_seconds,
        retry_after_seconds: None,
    })
}

/// 校验验证码并登录（`POST /v1/auth/email/verify`）：Host 自动带设备证明。
pub async fn login_verify(email: &str, code: &str) -> Result<AccountState, CpError> {
    let device = device_for_login()?;
    let base_url = crate::control_plane::env::current().base_url;
    let http = super::client::http_client(Duration::from_secs(10))?;
    let path = "/v1/auth/email/verify";
    let body = json!({
        "email": email,
        "code": code,
        "device_id": device.device_id,
        "secret_hash": secret_hash(&device.device_secret),
    });
    let (status, text) = send_json(&http, &endpoint(&base_url, path), path, &body).await?;
    if !(200..=299).contains(&status) {
        let error = error::from_response(status, &text);
        log_status_failure(path, status, &error);
        return Err(error);
    }
    let tokens: TokenSet = serde_json::from_str(&text)
        .map_err(|_| CpError::invalid_response("登录响应格式不正确"))?;
    store_tokens(&tokens)?;
    let mut updated = device;
    updated.account_id = tokens.account_id.clone();
    let _ = store_device(&updated);
    Ok(account_state())
}

/// 服务端登出（`POST /v1/auth/logout`）：作废 refresh 并把设备解绑到匿名账户。
///
/// 只在服务端成功后才写本地令牌；离线失败原样上报，不允许本地假装已退出（§2.4）。
/// 例外：服务端明确说令牌已无效（dev 库重建、设备被删、401）时，本地令牌必须清掉
/// 并回到未登录态——否则用户会被永久卡在「已登录」却退不出去。
pub async fn logout() -> Result<AccountState, CpError> {
    let client = super::client::ControlPlane::new()?;
    match client.post("/v1/auth/logout", None, None).await {
        Ok(raw) => {
            let tokens: TokenSet = serde_json::from_value(raw)
                .map_err(|_| CpError::invalid_response("登出响应格式不正确"))?;
            store_tokens(&tokens)?;
            if let Some(mut device) = existing_device() {
                device.account_id = tokens.account_id.clone();
                let _ = store_device(&device);
            }
            Ok(account_state())
        }
        Err(error) => logout_failure(error),
    }
}

/// 服务端拒绝登出时清本地态；网络、5xx 等其它失败仍原样上报。
///
/// 403（`device_revoked` / `account_blocked`）必须和 401 一样处理：服务端不让登出时，
/// 本地更不能被锁死——否则账户被停用后，用户在这台设备上永远退不出去。
/// 注意 `from_response` 的 `details` 不带 HTTP 状态码，所以这里只看 reason 与映射后的 code。
fn logout_failure(error: CpError) -> Result<AccountState, CpError> {
    let rejected = matches!(
        error.reason(),
        Some("token_invalid") | Some("auth_required")
    ) || error.code == "PERMISSION_DENIED"
        || matches!(
            error.reason(),
            Some("device_revoked") | Some("account_blocked")
        );
    if !rejected {
        return Err(error);
    }
    let reason = match error.reason() {
        // 事件载荷只认这四个 reason（events.md §4.27）；未知原因归到 server_rejected。
        Some(value @ ("token_invalid" | "auth_required" | "device_revoked" | "account_blocked")) => {
            value
        }
        _ => "server_rejected",
    };
    clear_tokens();
    forget_account();
    log::warn!(
        "登出：服务端拒绝（code={} reason={}），已清本地令牌与账户标记",
        error.code,
        reason
    );
    super::events::emit_account_cleared(reason);
    Ok(account_state())
}

/// 本机设备身份状态（只读本地）。`account_id` 只在有身份时给出。
#[derive(Debug, Clone, PartialEq)]
pub struct LocalIdentity {
    pub has_identity: bool,
    pub account_id: Option<String>,
}

fn identity_from(device: Option<&str>, account_marker: Option<&str>) -> LocalIdentity {
    let Some(device) =
        device.and_then(|raw| serde_json::from_str::<StoredDevice>(raw).ok())
    else {
        return LocalIdentity {
            has_identity: false,
            account_id: None,
        };
    };
    if device.device_id.trim().is_empty() || device.device_secret.trim().is_empty() {
        return LocalIdentity {
            has_identity: false,
            account_id: None,
        };
    }
    let account_id = Some(device.account_id)
        .filter(|value| !value.trim().is_empty())
        .or_else(|| account_marker.map(str::to_string))
        .filter(|value| !value.trim().is_empty());
    LocalIdentity {
        has_identity: true,
        account_id,
    }
}

/// 只读本地：不联网、不注册、不刷新令牌、不写任何状态。
///
/// 有账户标记但设备秘密丢失（身份丢失）时返回 `false`，**不自动重建**——
/// 恢复只能走 [`register_device`]，由用户点按钮触发。
pub fn local_identity() -> LocalIdentity {
    let raw = crate::secrets::get_secret(DEVICE_KEY).ok().flatten();
    let marker = stored_account_marker();
    identity_from(raw.as_deref(), marker.as_deref())
}

/// 日志里的账户标识：只用 `account_id`，绝不打印邮箱或令牌。
fn account_label(tokens: &TokenSet) -> &str {
    let id = tokens.account_id.trim();
    if id.is_empty() {
        "-"
    } else {
        id
    }
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
        log::debug!(
            "鉴权：本地令牌 fresh={fresh} superseded={superseded} account={}",
            account_label(&tokens)
        );
        if fresh && (stale.is_none() || superseded) {
            log::debug!(
                "鉴权：复用本地 access 令牌 account={}",
                account_label(&tokens)
            );
            return Ok(tokens.access_token);
        }
    }

    let device = load_device()?;

    let tokens = match load_tokens() {
        Some(tokens) => {
            let was_email = tokens.account_kind == "email";
            log::debug!(
                "鉴权：access 已过期，开始刷新 account={} account_kind={}",
                account_label(&tokens),
                tokens.account_kind
            );
            match refresh_with_retry(base_url, http, &tokens.refresh_token).await {
                Ok(tokens) => {
                    log::debug!(
                        "鉴权：刷新成功 account={} account_kind={}",
                        account_label(&tokens),
                        tokens.account_kind
                    );
                    tokens
                }
                Err(error) if session_is_dead(&error) => {
                    clear_tokens();
                    if was_email {
                        // 邮箱账户的 refresh 失效不重新注册设备：设备行还绑着账户，
                        // 重新注册会换出匿名账户。按 §3.3 回到未登录态，让用户重新登录。
                        log::debug!(
                            "鉴权：会话失效 code={} reason={}，邮箱账户需要重新登录 account={}",
                            error.code,
                            error.reason().unwrap_or("-"),
                            account_label(&tokens)
                        );
                        return Err(email_refresh_error(error));
                    }
                    if error.code != "PERMISSION_DENIED" {
                        // 匿名设备的 401 类（含 refresh_unknown 与重放检测）：
                        // 用长期秘密重新注册（§19.2.4）。
                        log::debug!(
                            "鉴权：刷新被拒（401），用设备身份重新注册 device={}",
                            device.device_id
                        );
                        let tokens = register(base_url, http, &device).await?;
                        log::debug!(
                            "鉴权：重新注册成功 account={} device={}",
                            account_label(&tokens),
                            tokens.device_id
                        );
                        tokens
                    } else {
                        // 403 设备停用 / 账户停用：不能靠重注册绕过；本地令牌已清掉。
                        return Err(error);
                    }
                }
                Err(error) => {
                    // 网络错误 / 5xx / 429：本地令牌与登录态都保留，只把错误上报。
                    log::debug!(
                        "鉴权：刷新失败，保留本地令牌 code={} reason={} retryable={}",
                        error.code,
                        error.reason().unwrap_or("-"),
                        error.retryable
                    );
                    return Err(error);
                }
            }
        }
        None => {
            log::debug!("鉴权：没有本地令牌，注册设备 device={}", device.device_id);
            register(base_url, http, &device).await?
        }
    };

    Ok(tokens.access_token)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 令牌与账户标记读写的是进程级共享的 secrets 文件与全局库：会写它们的测试
    /// 必须串行，否则通过与失败取决于调度。锁放在 `test_support`，让别的模块
    /// 的测试也能拿同一把（见那里的根因说明）。
    fn auth_state_lock() -> std::sync::MutexGuard<'static, ()> {
        crate::test_support::AUTH_STATE_LOCK
            .lock()
            .unwrap_or_else(|error| error.into_inner())
    }

    /// 全进程的库（正式启动时由 `lib.rs` 装）；`install_global` 先到先得。
    /// 账户标记读写的是 `store::global()`，测试里必须先装一个，否则永远读不到。
    fn test_store() {
        // 凭据库也要先装：并行跑单个用例时别指望别人先初始化（`OnceLock` 只做一次）。
        crate::test_support::install_test_secrets();
        static STORE: std::sync::OnceLock<std::sync::Arc<crate::store::Store>> =
            std::sync::OnceLock::new();
        crate::store::install_global(
            STORE
                .get_or_init(|| {
                    std::sync::Arc::new(
                        crate::store::Store::open_in_memory().expect("内存库打不开"),
                    )
                })
                .clone(),
        );
    }

    fn tokens(access_expires_at: &str) -> TokenSet {
        TokenSet {
            account_id: "acct_1".into(),
            device_id: "dev_1".into(),
            access_token: "access".into(),
            access_expires_at: access_expires_at.into(),
            refresh_token: "refresh".into(),
            refresh_expires_at: "2027-01-01T00:00:00Z".into(),
            account_kind: "device".into(),
            email: None,
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
    fn account_state_requires_an_email_account() {
        let mut email_tokens = tokens("2026-11-14T08:00:31Z");
        email_tokens.account_kind = "email".into();
        email_tokens.email = Some("a@example.com".into());
        let state = account_state_from(Some(email_tokens), Some("dev_1".into()));
        assert!(state.logged_in);
        assert_eq!(state.account_kind.as_deref(), Some("email"));
        assert_eq!(state.account_id.as_deref(), Some("acct_1"));
        assert_eq!(state.email.as_deref(), Some("a@example.com"));
        assert_eq!(state.device_id.as_deref(), Some("dev_1"));

        // 匿名设备账户不是登录态，但 device_id 仍要返回。
        let state =
            account_state_from(Some(tokens("2026-11-14T08:00:31Z")), Some("dev_1".into()));
        assert!(!state.logged_in);
        assert_eq!(state.account_kind.as_deref(), Some("device"));
        assert_eq!(state.account_id, None);
        assert_eq!(state.email, None);
        assert_eq!(state.device_id.as_deref(), Some("dev_1"));
    }

    #[test]
    fn account_kind_is_null_without_tokens_or_a_device() {
        // 没有令牌（即使设备身份在）→ null。
        let state = account_state_from(None, Some("dev_1".into()));
        assert_eq!(state.account_kind, None);
        assert!(!state.logged_in);
        assert_eq!(state.device_id.as_deref(), Some("dev_1"));

        // 没有设备身份 → null。
        let state = account_state_from(None, None);
        assert_eq!(state.account_kind, None);
        assert!(!state.logged_in);
        assert_eq!(state.device_id, None);

        // 旧令牌没有 account_kind 字段 → null，不能当成 device。
        let mut legacy = tokens("2026-11-14T08:00:31Z");
        legacy.account_kind = String::new();
        let state = account_state_from(Some(legacy), Some("dev_1".into()));
        assert_eq!(state.account_kind, None);
        assert!(!state.logged_in);
    }

    #[test]
    fn account_state_serializes_the_contract_shape() {
        let mut email_tokens = tokens("2026-11-14T08:00:31Z");
        email_tokens.account_kind = "email".into();
        email_tokens.email = Some("a@example.com".into());
        let value = serde_json::to_value(account_state_from(
            Some(email_tokens),
            Some("dev_1".into()),
        ))
        .unwrap();
        assert_eq!(value["logged_in"], true);
        assert_eq!(value["account_kind"], "email");
        assert_eq!(value["email"], "a@example.com");
        assert_eq!(value["device_id"], "dev_1");
        assert!(value.get("access_token").is_none());

        let value = serde_json::to_value(account_state_from(None, None)).unwrap();
        assert_eq!(value["account_kind"], serde_json::Value::Null);
        assert_eq!(value["logged_in"], false);
        assert_eq!(value["session_expires_at"], serde_json::Value::Null);
    }

    /// refresh 过期 = 登录态结束；到期时间仍要交给界面，方便显示「已过期」。
    #[test]
    fn an_expired_refresh_token_ends_the_login_session() {
        let mut expired = tokens("2026-11-14T08:00:31Z");
        expired.account_kind = "email".into();
        expired.email = Some("a@example.com".into());
        expired.refresh_expires_at = "2020-01-01T00:00:00Z".into();
        let state = account_state_from(Some(expired.clone()), Some("dev_1".into()));
        assert!(!state.logged_in);
        assert_eq!(state.email, None);
        assert_eq!(state.account_id, None);
        assert_eq!(state.account_kind.as_deref(), Some("email"));
        assert_eq!(
            state.session_expires_at.as_deref(),
            Some("2020-01-01T00:00:00Z")
        );

        // 到期时间解析不出来同样按过期处理，不能假装还登录着；
        // 解析不出的字符串也不下发给界面。
        expired.refresh_expires_at = "not-a-time".into();
        let state = account_state_from(Some(expired), Some("dev_1".into()));
        assert!(!state.logged_in);
        assert_eq!(state.session_expires_at, None);

        // 没过期的会话照常登录。
        let mut live = tokens("2026-11-14T08:00:31Z");
        live.account_kind = "email".into();
        live.email = Some("a@example.com".into());
        live.refresh_expires_at = "2099-01-01T00:00:00Z".into();
        let state = account_state_from(Some(live), Some("dev_1".into()));
        assert!(state.logged_in);
        assert_eq!(
            state.session_expires_at.as_deref(),
            Some("2099-01-01T00:00:00Z")
        );
    }

    /// 控制面不可达只影响「显示成什么错误」，不参与登录态推导。
    #[test]
    fn an_unreachable_control_plane_is_reported_as_an_error() {
        let now = now_ms();
        assert!(unreachable_error(STATE_REACHABLE, now, now).is_none());

        let network = unreachable_error(STATE_NETWORK, now, now).unwrap();
        assert_eq!(network.code, "UPSTREAM_ERROR");
        assert_eq!(network.reason(), Some("provider_unavailable"));
        assert!(network.retryable);

        let timeout = unreachable_error(STATE_TIMEOUT, now, now).unwrap();
        assert_eq!(timeout.code, "TIMEOUT");
        assert_eq!(timeout.reason(), Some("timeout"));
        assert!(timeout.retryable);

        // 过了 TTL 的旧结论不再把界面顶成错误态。
        assert!(unreachable_error(STATE_NETWORK, now - UNREACHABLE_TTL_MS - 1, now).is_none());
    }

    /// 本地桩：读到请求头结束就回 200 `{}`。
    fn spawn_json_stub() -> String {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap().to_string();
        std::thread::spawn(move || {
            for socket in listener.incoming() {
                let Ok(mut socket) = socket else { return };
                let mut buf = [0u8; 4096];
                let _ = socket.read(&mut buf);
                let body = "{}";
                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = socket.write_all(response.as_bytes());
            }
        });
        addr
    }

    /// 登录 / 刷新 / 注册通道也要更新可达性：成功一次就清掉「不可达」。
    #[test]
    fn a_successful_auth_request_clears_the_unreachable_state() {
        let _guard = CONTROL_PLANE_STATE_LOCK
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let addr = spawn_json_stub();
        note_control_plane_unreachable(false);
        assert!(control_plane_unreachable().is_some());

        let http = super::super::client::http_client(Duration::from_secs(2)).unwrap();
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let (status, _) = runtime
            .block_on(send_json(
                &http,
                &format!("http://{addr}/v1/auth/refresh"),
                "/v1/auth/refresh",
                &json!({}),
            ))
            .unwrap();
        assert_eq!(status, 200);
        assert!(
            control_plane_unreachable().is_none(),
            "成功的 auth 请求必须清掉「不可达」"
        );
    }

    /// 设备被停用：邮箱账户刷新失败要保留原错误，不能改写成「登录已过期」。
    #[test]
    fn a_blocked_device_keeps_its_own_error() {
        let blocked = error::from_response(
            403,
            r#"{"code":"FORBIDDEN","details":{"reason":"device_revoked"}}"#,
        );
        let mapped = email_refresh_error(blocked);
        assert_eq!(mapped.code, "PERMISSION_DENIED");
        assert_eq!(mapped.reason(), Some("device_revoked"));

        let blocked = error::from_response(
            403,
            r#"{"code":"FORBIDDEN","details":{"reason":"account_blocked"}}"#,
        );
        assert_eq!(
            email_refresh_error(blocked).reason(),
            Some("account_blocked")
        );

        // 真正的认证失效才合成 token_invalid。
        let expired = error::from_response(
            401,
            r#"{"code":"UNAUTHENTICATED","details":{"reason":"refresh_unknown"}}"#,
        );
        let mapped = email_refresh_error(expired);
        assert_eq!(mapped.code, "UNAUTHENTICATED");
        assert_eq!(mapped.reason(), Some("token_invalid"));
    }

    /// 断网、5xx、限流不能把用户踢下线；只有认证失效与设备停用算掉登录。
    #[test]
    fn only_authentication_failures_end_the_session() {
        assert!(!session_is_dead(&CpError::network(false)));
        assert!(!session_is_dead(&CpError::network(true)));
        assert!(!session_is_dead(&error::from_response(503, "")));
        assert!(!session_is_dead(&error::from_response(
            429,
            r#"{"code":"RATE_LIMITED"}"#
        )));

        for reason in [
            "token_invalid",
            "auth_required",
            "refresh_unknown",
            "refresh_reused",
        ] {
            let body = format!(r#"{{"code":"UNAUTHENTICATED","details":{{"reason":"{reason}"}}}}"#);
            assert!(
                session_is_dead(&error::from_response(401, &body)),
                "{reason} 应当是掉登录"
            );
        }
        for reason in ["device_revoked", "account_blocked"] {
            let body = format!(r#"{{"code":"FORBIDDEN","details":{{"reason":"{reason}"}}}}"#);
            assert!(
                session_is_dead(&error::from_response(403, &body)),
                "{reason} 应当是掉登录"
            );
        }
    }

    #[test]
    fn old_token_bundles_deserialize_as_device_accounts() {
        let raw = r#"{"account_id":"acct_1","device_id":"dev_1","access_token":"a","access_expires_at":"2026-11-14T08:00:31Z","refresh_token":"r","refresh_expires_at":"2027-01-01T00:00:00Z"}"#;
        let parsed: TokenSet = serde_json::from_str(raw).unwrap();
        assert!(parsed.account_kind.is_empty());
        assert_eq!(parsed.email, None);
        // 旧令牌没有 kind：账号态按 null 处理，不能凭空当成 device。
        let state = account_state_from(Some(parsed), Some("dev_1".into()));
        assert_eq!(state.account_kind, None);
        assert!(!state.logged_in);
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
    fn local_identity_is_false_without_a_device_secret() {
        let status = identity_from(None, None);
        assert!(!status.has_identity);
        assert_eq!(status.account_id, None);
    }

    #[test]
    fn local_identity_reports_the_account_for_a_complete_device() {
        let device = StoredDevice {
            device_id: "dev_1".into(),
            device_secret: "secret".into(),
            account_id: "acct_1".into(),
        };
        let raw = serde_json::to_string(&device).unwrap();
        let status = identity_from(Some(&raw), None);
        assert!(status.has_identity);
        assert_eq!(status.account_id.as_deref(), Some("acct_1"));

        // 设备行里没有账户 id 时退回 SQLite 的账户标记。
        let device = StoredDevice {
            account_id: String::new(),
            ..device
        };
        let raw = serde_json::to_string(&device).unwrap();
        assert_eq!(
            identity_from(Some(&raw), Some("acct_2"))
                .account_id
                .as_deref(),
            Some("acct_2")
        );
    }

    #[test]
    fn a_rejected_logout_clears_local_state_but_a_network_error_does_not() {
        let _guard = auth_state_lock();
        crate::test_support::install_test_secrets();
        test_store();
        clear_tokens();
        forget_account();
        store_tokens(&tokens("2026-11-14T08:00:31Z")).unwrap();
        assert_eq!(stored_account_marker().as_deref(), Some("acct_1"));

        // 网络失败：原样上报，不能假装已退出。
        let error = logout_failure(CpError::network(false)).unwrap_err();
        assert_eq!(error.code, "UPSTREAM_ERROR");
        assert!(load_tokens().is_some(), "网络失败必须保留本地令牌");

        // 403 账户被停用：服务端不让登出，但本地必须能退出——令牌与账户标记一起清掉。
        let blocked = error::from_response(
            403,
            r#"{"code":"FORBIDDEN","message":"账户已被停用","retryable":false,"details":{"reason":"account_blocked"},"request_id":"r1"}"#,
        );
        let state = logout_failure(blocked).unwrap();
        assert!(!state.logged_in);
        assert!(load_tokens().is_none(), "账户被停用也必须能退出");
        assert_eq!(stored_account_marker(), None, "账户标记不能留下");

        // 403 空响应体：按状态码兜底，同样清。
        store_tokens(&tokens("2026-11-14T08:00:31Z")).unwrap();
        let state = logout_failure(error::from_response(403, "")).unwrap();
        assert!(!state.logged_in);
        assert!(load_tokens().is_none());
        assert_eq!(stored_account_marker(), None);

        // 403 但 reason 是没见过的新值：仍按「服务端拒绝」退出（映射后的 code 是 PERMISSION_DENIED）。
        store_tokens(&tokens("2026-11-14T08:00:31Z")).unwrap();
        let odd = error::from_response(
            403,
            r#"{"code":"FORBIDDEN","message":"账户不可用","details":{"reason":"account_frozen"},"request_id":"r1"}"#,
        );
        let state = logout_failure(odd).unwrap();
        assert!(!state.logged_in);
        assert!(load_tokens().is_none());
        assert_eq!(stored_account_marker(), None);

        // 服务端 401 token_invalid：本地令牌清掉，回到未登录态。
        store_tokens(&tokens("2026-11-14T08:00:31Z")).unwrap();
        let rejected = error::from_response(
            401,
            r#"{"code":"UNAUTHENTICATED","message":"需要重新登录","retryable":true,"details":{"reason":"token_invalid"},"request_id":"r1"}"#,
        );
        let state = logout_failure(rejected).unwrap();
        assert!(!state.logged_in);
        assert_eq!(state.account_kind, None);
        assert!(load_tokens().is_none(), "令牌被服务端拒绝后必须清掉");

        // 401 但响应体不可解析：按状态码兜底，同样清本地态。
        store_tokens(&tokens("2026-11-14T08:00:31Z")).unwrap();
        let state = logout_failure(error::from_response(401, "")).unwrap();
        assert!(!state.logged_in);
        assert!(load_tokens().is_none());

        clear_tokens();
        forget_account();
    }

    #[test]
    fn a_lost_identity_is_false_and_is_not_rebuilt() {        // 有账户标记但没有设备秘密：返回 false / null，这个函数不写入任何东西；
        // 重建只能走 register_device()，由用户显式触发。
        let status = identity_from(None, Some("acct_1"));
        assert!(!status.has_identity);
        assert_eq!(status.account_id, None);

        // 秘密字段为空同样不算有身份。
        let empty = StoredDevice {
            device_id: "dev_1".into(),
            device_secret: String::new(),
            account_id: "acct_1".into(),
        };
        let raw = serde_json::to_string(&empty).unwrap();
        let status = identity_from(Some(&raw), Some("acct_1"));
        assert!(!status.has_identity);
        assert_eq!(status.account_id, None);
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

    /// 脚本化本地桩：按顺序处理每个连接。`Drop` 表示读完请求直接断开——
    /// 与服务端已处理、回程响应被网络重置时客户端看到的现象一致。
    enum StubReply {
        Drop,
        Http(u16, &'static str),
        /// 头里声明更长的 `Content-Length`，正文只发一部分就断开：模拟「响应体读到一半」。
        Truncated(&'static str),
    }

    fn spawn_scripted_stub(
        script: Vec<StubReply>,
    ) -> (String, std::sync::Arc<std::sync::atomic::AtomicUsize>) {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap().to_string();
        let hits = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let counter = hits.clone();
        std::thread::spawn(move || {
            for socket in listener.incoming() {
                let Ok(mut socket) = socket else { return };
                let index = counter.fetch_add(1, Ordering::SeqCst);
                let mut buf = [0u8; 4096];
                let _ = socket.read(&mut buf);
                match script.get(index) {
                    Some(StubReply::Drop) | None => drop(socket),
                    Some(StubReply::Http(status, body)) => {
                        let response = format!(
                            "HTTP/1.1 {status} OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                            body.len()
                        );
                        let _ = socket.write_all(response.as_bytes());
                    }
                    Some(StubReply::Truncated(body)) => {
                        let head = format!(
                            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                            body.len() + 64
                        );
                        let _ = socket.write_all(head.as_bytes());
                        let _ = socket.write_all(body.as_bytes());
                    }
                }
            }
        });
        (addr, hits)
    }

    /// 刷新成功响应里的新令牌；`refresh_with_retry` 必须把它落盘。
    const REFRESHED_TOKENS: &str = r#"{"account_id":"acct_1","device_id":"dev_1","access_token":"access-2","access_expires_at":"2099-01-01T00:00:00Z","refresh_token":"refresh-2","refresh_expires_at":"2099-01-01T00:00:00Z","account_kind":"device"}"#;

    fn expired_tokens() -> TokenSet {
        // access 已过期，`ensure_access` 才会走刷新分支。
        tokens("2020-01-01T00:00:00Z")
    }

    fn block_on_ensure_access(addr: &str, http: &reqwest::Client) -> Result<String, CpError> {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        runtime.block_on(ensure_access(&format!("http://{addr}"), http, None))
    }

    fn clean_up_auth_state() {
        clear_tokens();
        forget_account();
        let _ = crate::secrets::delete_secret(DEVICE_KEY);
        note_control_plane_reachable();
    }

    /// 服务端已轮换、回程响应被重置：立刻重试一次就能在 60 秒宽限内完成赎回。
    #[test]
    fn a_reset_refresh_is_retried_once_and_succeeds() {
        let _state = CONTROL_PLANE_STATE_LOCK
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let _auth = auth_state_lock();
        test_store();
        let (addr, hits) = spawn_scripted_stub(vec![
            StubReply::Drop,
            StubReply::Http(200, REFRESHED_TOKENS),
        ]);
        store_device_for_test("dev_1");
        store_tokens(&expired_tokens()).unwrap();

        let http = super::super::client::http_client(Duration::from_secs(2)).unwrap();
        let access = block_on_ensure_access(&addr, &http).expect("第二次刷新应成功");

        assert_eq!(access, "access-2");
        assert_eq!(hits.load(Ordering::SeqCst), 2, "断连后只重试一次");
        assert_eq!(
            load_tokens().expect("新令牌必须落盘").refresh_token,
            "refresh-2"
        );
        clean_up_auth_state();
    }

    /// 响应体读到一半断开：要按传输失败重试，不能当成 invalid_response（不可重试）。
    #[test]
    fn a_truncated_refresh_body_is_retried() {
        let _state = CONTROL_PLANE_STATE_LOCK
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let _auth = auth_state_lock();
        test_store();
        let (addr, hits) = spawn_scripted_stub(vec![
            StubReply::Truncated(REFRESHED_TOKENS),
            StubReply::Http(200, REFRESHED_TOKENS),
        ]);
        store_device_for_test("dev_1");
        store_tokens(&expired_tokens()).unwrap();

        let http = super::super::client::http_client(Duration::from_secs(2)).unwrap();
        let access = block_on_ensure_access(&addr, &http).expect("第二次刷新应成功");

        assert_eq!(access, "access-2");
        assert_eq!(hits.load(Ordering::SeqCst), 2, "响应体截断必须重试");
        assert_eq!(
            load_tokens().expect("新令牌必须落盘").refresh_token,
            "refresh-2"
        );
        clean_up_auth_state();
    }

    /// 会话已失效（401）绝不重试：重试只会把「旧令牌重放」坐实。
    #[test]
    fn a_dead_session_is_not_retried() {
        let _state = CONTROL_PLANE_STATE_LOCK
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let _auth = auth_state_lock();
        test_store();
        let (addr, hits) = spawn_scripted_stub(vec![StubReply::Http(
            401,
            r#"{"code":"UNAUTHENTICATED","details":{"reason":"refresh_reused"},"retryable":false}"#,
        )]);
        store_device_for_test("dev_1");
        let mut email = expired_tokens();
        email.account_kind = "email".into();
        email.email = Some("a@example.com".into());
        store_tokens(&email).unwrap();

        let http = super::super::client::http_client(Duration::from_secs(2)).unwrap();
        let error = block_on_ensure_access(&addr, &http).unwrap_err();

        assert_eq!(error.code, "UNAUTHENTICATED");
        assert_eq!(error.reason(), Some("token_invalid"));
        assert_eq!(hits.load(Ordering::SeqCst), 1, "会话失效不能重试");
        clean_up_auth_state();
    }

    /// 可重试错误连续两次：只尝试两次就停，本地令牌保留，等下次触发再刷。
    #[test]
    fn two_retryable_failures_stop_after_one_retry() {
        let _state = CONTROL_PLANE_STATE_LOCK
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let _auth = auth_state_lock();
        test_store();
        let (addr, hits) = spawn_scripted_stub(vec![StubReply::Drop, StubReply::Drop]);
        store_device_for_test("dev_1");
        store_tokens(&expired_tokens()).unwrap();

        let http = super::super::client::http_client(Duration::from_secs(2)).unwrap();
        let error = block_on_ensure_access(&addr, &http).unwrap_err();

        assert!(error.retryable, "{error:?}");
        assert_eq!(hits.load(Ordering::SeqCst), 2, "最多尝试两次，不做多轮退避");
        assert_eq!(
            load_tokens()
                .expect("可重试失败不能清本地令牌")
                .refresh_token,
            "refresh",
            "旧令牌必须原样保留"
        );
        clean_up_auth_state();
    }

    /// 403 设备停用：不是可重试错误，不重试。
    #[test]
    fn a_revoked_device_is_not_retried() {
        let _state = CONTROL_PLANE_STATE_LOCK
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let _auth = auth_state_lock();
        test_store();
        let (addr, hits) = spawn_scripted_stub(vec![StubReply::Http(
            403,
            r#"{"code":"FORBIDDEN","details":{"reason":"device_revoked"}}"#,
        )]);
        store_device_for_test("dev_1");
        store_tokens(&expired_tokens()).unwrap();

        let http = super::super::client::http_client(Duration::from_secs(2)).unwrap();
        let error = block_on_ensure_access(&addr, &http).unwrap_err();

        assert_eq!(error.code, "PERMISSION_DENIED");
        assert_eq!(error.reason(), Some("device_revoked"));
        assert_eq!(hits.load(Ordering::SeqCst), 1, "设备停用不能重试");
        clean_up_auth_state();
    }
}
