//! 系统凭据存储：macOS Keychain / Windows Credential Manager。
//!
//! 明文 Key 不落 SQLite、不落配置文件、不进日志。
//! 读取路径供 provider 初始化使用；写入失败必须显式报错，不能静默降级。

use keyring::Entry;

pub const SERVICE: &str = "io.github.aiwithblockchain.veyl";
pub const DEEPSEEK_ACCOUNT: &str = "deepseek_api_key";

#[derive(Debug, thiserror::Error)]
pub enum SecretError {
    #[error("系统凭据存储不可用：{0}")]
    Backend(String),

    #[error("凭据不存在")]
    NotFound,

    #[error("凭据内容为空")]
    Empty,
}

pub type SecretResult<T> = Result<T, SecretError>;

impl SecretError {
    pub fn code(&self) -> &'static str {
        match self {
            SecretError::Backend(_) => "INTERNAL",
            SecretError::NotFound => "NOT_FOUND",
            SecretError::Empty => "INVALID_ARGUMENT",
        }
    }
}

fn entry(account: &str) -> SecretResult<Entry> {
    Entry::new(SERVICE, account).map_err(|e| SecretError::Backend(e.to_string()))
}

fn map_error(error: keyring::Error) -> SecretError {
    match error {
        keyring::Error::NoEntry => SecretError::NotFound,
        other => SecretError::Backend(other.to_string()),
    }
}

pub fn set_secret(account: &str, value: &str) -> SecretResult<()> {
    if value.trim().is_empty() {
        return Err(SecretError::Empty);
    }
    entry(account)?.set_password(value).map_err(map_error)
}

pub fn get_secret(account: &str) -> SecretResult<Option<String>> {
    match entry(account)?.get_password() {
        Ok(value) if value.trim().is_empty() => Ok(None),
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(other) => Err(SecretError::Backend(other.to_string())),
    }
}

pub fn delete_secret(account: &str) -> SecretResult<()> {
    match entry(account)?.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(other) => Err(SecretError::Backend(other.to_string())),
    }
}

pub fn set_deepseek_key(key: &str) -> SecretResult<()> {
    set_secret(DEEPSEEK_ACCOUNT, key.trim())
}

pub fn get_deepseek_key() -> SecretResult<Option<String>> {
    get_secret(DEEPSEEK_ACCOUNT)
}

pub fn delete_deepseek_key() -> SecretResult<()> {
    delete_secret(DEEPSEEK_ACCOUNT)
}


/// 保存后的校验结果。`validation` 与契约 §4.15 的三态一致。
#[derive(Debug, Clone)]
pub struct KeySaveOutcome {
    pub masked: String,
    pub validation: &'static str,
    pub validation_detail: Option<&'static str>,
}

#[derive(Debug)]
pub enum KeySaveError {
    Keychain(SecretError),
    ReadBackMismatch,
}

impl KeySaveError {
    /// UI 命令用的错误码。
    pub fn ui_code(&self) -> &'static str {
        match self {
            KeySaveError::Keychain(error) => match error {
                SecretError::Empty => "INVALID_KEY",
                _ => "KEYCHAIN",
            },
            KeySaveError::ReadBackMismatch => "KEYCHAIN",
        }
    }

    pub fn message(&self) -> String {
        match self {
            KeySaveError::Keychain(error) => error.to_string(),
            KeySaveError::ReadBackMismatch => "写入钥匙串后回读不一致".to_string(),
        }
    }
}

impl From<SecretError> for KeySaveError {
    fn from(error: SecretError) -> Self {
        KeySaveError::Keychain(error)
    }
}

/// `sk-****abcd`：只露前缀 3 位与后缀 4 位，任何日志与 UI 都只能看到这个。
pub fn mask(key: &str) -> String {
    let chars: Vec<char> = key.trim().chars().collect();
    if chars.len() <= 7 {
        return "****".to_string();
    }
    let prefix: String = chars.iter().take(3).collect();
    let suffix: String = chars[chars.len() - 4..].iter().collect();
    format!("{prefix}****{suffix}")
}

/// 保存并校验。命令与工具路径共用这一份，不维护两套逻辑。
pub async fn save_deepseek_key(key: &str) -> Result<KeySaveOutcome, KeySaveError> {
    let key = key.trim();
    set_deepseek_key(key)?;

    if get_deepseek_key()?.as_deref() != Some(key) {
        return Err(KeySaveError::ReadBackMismatch);
    }

    let (validation, validation_detail) = validate_deepseek_key(key).await;
    Ok(KeySaveOutcome {
        masked: mask(key),
        validation,
        validation_detail,
    })
}

/// 设置页用：只回答「有没有配置」和掩码，不返回明文。
pub fn key_status() -> Result<(bool, Option<String>), SecretError> {
    match get_deepseek_key()? {
        Some(key) => Ok((true, Some(mask(&key)))),
        None => Ok((false, None)),
    }
}

/// 只回答「Key 是否有效」：2xx 或余额不足算有效，401/403 算无效，连不上算未验证。
pub async fn validate_deepseek_key(key: &str) -> (&'static str, Option<&'static str>) {
    let client = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .build()
    {
        Ok(client) => client,
        Err(_) => return ("unverified", Some("network")),
    };

    let response = client
        .get("https://api.deepseek.com/models")
        .bearer_auth(key)
        .send()
        .await;

    match response {
        Ok(response) => classify_status(response.status().as_u16()),
        Err(error) if error.is_timeout() => ("unverified", Some("timeout")),
        Err(_) => ("unverified", Some("network")),
    }
}

pub fn classify_status(status: u16) -> (&'static str, Option<&'static str>) {
    match status {
        200..=299 => ("ok", None),
        401 | 403 => ("invalid", None),
        402 => ("ok", Some("insufficient_balance")),
        _ => ("unverified", Some("network")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_keys_are_rejected_before_touching_the_keychain() {
        assert!(matches!(
            set_deepseek_key("   "),
            Err(SecretError::Empty)
        ));
    }

    #[tokio::test]
    async fn empty_key_save_returns_invalid_key() {
        // 空 Key 在碰钥匙串之前就被挡住，所以这个用例不会弹系统授权。
        let error = save_deepseek_key("   ").await.unwrap_err();
        assert_eq!(error.ui_code(), "INVALID_KEY");
        assert!(!error.message().contains("sk-"));
    }

    #[test]
    fn masking_keeps_only_the_prefix_and_suffix() {
        assert_eq!(mask("sk-1234567890abcd"), "sk-****abcd");
        assert_eq!(mask("short"), "****");
        assert_eq!(mask("  sk-abcdefghij  "), "sk-****ghij");
    }

    #[test]
    fn validation_status_mapping_matches_the_contract() {
        assert_eq!(classify_status(200), ("ok", None));
        assert_eq!(classify_status(401), ("invalid", None));
        assert_eq!(classify_status(403), ("invalid", None));
        assert_eq!(classify_status(402), ("ok", Some("insufficient_balance")));
        assert_eq!(classify_status(500), ("unverified", Some("network")));
    }

    #[test]
    fn ui_error_codes_are_distinct() {
        assert_eq!(KeySaveError::Keychain(SecretError::Empty).ui_code(), "INVALID_KEY");
        assert_eq!(
            KeySaveError::Keychain(SecretError::Backend("x".into())).ui_code(),
            "KEYCHAIN"
        );
        assert_eq!(KeySaveError::ReadBackMismatch.ui_code(), "KEYCHAIN");
    }

    #[test]
    fn error_codes_follow_the_shared_table() {
        assert_eq!(SecretError::NotFound.code(), "NOT_FOUND");
        assert_eq!(SecretError::Empty.code(), "INVALID_ARGUMENT");
        assert_eq!(SecretError::Backend("x".into()).code(), "INTERNAL");
    }

    /// 会真的读写登录钥匙串，默认不跑：
    /// `cargo test --lib -- --ignored keychain_round_trip`
    #[test]
    #[ignore]
    fn keychain_round_trip() {
        let account = "veyl_selftest_key";
        set_secret(account, "secret-value").unwrap();
        assert_eq!(
            get_secret(account).unwrap().as_deref(),
            Some("secret-value")
        );
        delete_secret(account).unwrap();
        assert!(get_secret(account).unwrap().is_none());
    }
}
