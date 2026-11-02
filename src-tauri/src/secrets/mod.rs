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
