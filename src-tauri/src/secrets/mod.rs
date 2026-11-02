//! 本地加密凭据存储。
//!
//! 不碰系统钥匙串——macOS 每次读写都可能弹授权框，debug 每次重建还会重新问。
//! 改为机器绑定的本地密文文件：`<data_dir>/secrets.enc`，权限 0600，
//! AES-256-GCM，密钥由 `机器标识 + 固定盐` 经 PBKDF2-HMAC-SHA256 派生。
//!
//! 文件里额外存一条 `__verify`（加密的已知常量），用来区分两种失败：
//! - `__verify` 能解开、但某条解不开 → 该条被篡改/损坏，删掉它，保留其余
//! - `__verify` 解不开 → 不是本机的文件（换机/重装），**保留原文件**，仅报错
//!
//! 明文 Key 不落盘、不落日志、不进 SQLite。

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use pbkdf2::pbkdf2_hmac;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::Sha256;

const KEY_LEN: usize = 32;
const NONCE_LEN: usize = 12;
const PBKDF2_ITERATIONS: u32 = 100_000;
const KEY_SALT: &[u8] = b"veyl:secret-store:v1";
const VERIFY_FIELD: &str = "__verify";
const VERIFY_PLAINTEXT: &str = "veyl-secret-store-v1";

pub const SECRETS_FILE: &str = "secrets.enc";
pub const PROVIDER_DEEPSEEK: &str = "provider:deepseek";
pub const DEVICE_TOKEN: &str = "device_token";

#[derive(Debug, thiserror::Error)]
pub enum SecretError {
    #[error("本地凭据存储不可用：{0}")]
    Backend(String),

    #[error("凭据不存在")]
    NotFound,

    #[error("凭据内容为空")]
    Empty,

    #[error("本机密文无法解密：文件损坏，或密钥与本机不匹配（换机/重装后需要重新输入 Key）")]
    Corrupt,
}

pub type SecretResult<T> = Result<T, SecretError>;

impl SecretError {
    pub fn code(&self) -> &'static str {
        match self {
            SecretError::Backend(_) => "INTERNAL",
            SecretError::NotFound | SecretError::Corrupt => "NOT_FOUND",
            SecretError::Empty => "INVALID_ARGUMENT",
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct SecretsFile {
    #[serde(default = "file_version")]
    version: u32,
    #[serde(flatten)]
    entries: BTreeMap<String, String>,
}

fn file_version() -> u32 {
    1
}

impl SecretsFile {
    /// 除 `__verify` 外还有没有真正的凭据。
    fn has_user_entries(&self) -> bool {
        self.entries.keys().any(|key| key != VERIFY_FIELD)
    }
}

pub struct SecretsStore {
    path: PathBuf,
    cipher: Aes256Gcm,
    /// 文件读写串行化，避免并发写互相覆盖。
    lock: Mutex<()>,
}

impl SecretsStore {
    pub fn new(data_dir: &Path) -> SecretResult<Self> {
        let machine_id = machine_id()
            .ok_or_else(|| SecretError::Backend("无法获取本机机器标识".to_string()))?;
        Self::with_machine_id(data_dir.join(SECRETS_FILE), &machine_id)
    }

    /// 测试与「错机器」用例走这里。
    pub fn with_machine_id(path: PathBuf, machine_id: &str) -> SecretResult<Self> {
        let mut key = [0u8; KEY_LEN];
        pbkdf2_hmac::<Sha256>(
            machine_id.as_bytes(),
            KEY_SALT,
            PBKDF2_ITERATIONS,
            &mut key,
        );
        let cipher = Aes256Gcm::new_from_slice(&key)
            .map_err(|_| SecretError::Backend("初始化加密器失败".to_string()))?;
        Ok(Self {
            path,
            cipher,
            lock: Mutex::new(()),
        })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn set(&self, field: &str, value: &str) -> SecretResult<()> {
        if value.trim().is_empty() {
            return Err(SecretError::Empty);
        }

        let _guard = self
            .lock
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let mut file = self.read_file()?;
        file.entries
            .insert(field.to_string(), self.encrypt(value.trim())?);
        self.persist(&file)
    }

    pub fn get(&self, field: &str) -> SecretResult<Option<String>> {
        let _guard = self
            .lock
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let mut file = self.read_file()?;

        let Some(ciphertext) = file.entries.get(field).cloned() else {
            return Ok(None);
        };

        match self.decrypt(&ciphertext) {
            Ok(value) => Ok(Some(value)),
            Err(SecretError::Corrupt) => {
                if !self.verifier_matches(&file) {
                    // 不是本机的文件：保留原样，等用户在新机器上重新输入。
                    return Err(SecretError::Corrupt);
                }
                // 本机文件、单条校验失败 = 该条损坏；删掉它，其余条目保留。
                log::warn!("凭据条目 {field} 认证失败，判定为损坏并删除（其余条目保留）");
                file.entries.remove(field);
                self.persist(&file)?;
                Ok(None)
            }
            Err(other) => Err(other),
        }
    }

    pub fn delete(&self, field: &str) -> SecretResult<()> {
        let _guard = self
            .lock
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let mut file = self.read_file()?;
        if file.entries.remove(field).is_none() {
            return Ok(());
        }
        self.persist(&file)
    }

    fn verifier_matches(&self, file: &SecretsFile) -> bool {
        match file.entries.get(VERIFY_FIELD) {
            Some(ciphertext) => self
                .decrypt(ciphertext)
                .map(|value| value == VERIFY_PLAINTEXT)
                .unwrap_or(false),
            // 老文件没有校验值，无法确认归属，按「不确定」处理：不删。
            None => false,
        }
    }

    fn read_file(&self) -> SecretResult<SecretsFile> {
        match std::fs::read_to_string(&self.path) {
            Ok(text) => serde_json::from_str(&text).map_err(|_| SecretError::Corrupt),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                Ok(SecretsFile::default())
            }
            Err(error) => Err(SecretError::Backend(error.to_string())),
        }
    }

    /// 空文件（只剩 `__verify`）直接删除，避免留下无意义的密文文件。
    fn persist(&self, file: &SecretsFile) -> SecretResult<()> {
        if !file.has_user_entries() {
            return match std::fs::remove_file(&self.path) {
                Ok(()) => Ok(()),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
                Err(error) => Err(SecretError::Backend(error.to_string())),
            };
        }
        self.write_file(file)
    }

    fn write_file(&self, file: &SecretsFile) -> SecretResult<()> {
        let mut out = file.clone();
        if !out.entries.contains_key(VERIFY_FIELD) {
            out.entries
                .insert(VERIFY_FIELD.to_string(), self.encrypt(VERIFY_PLAINTEXT)?);
        }

        let bytes =
            serde_json::to_vec_pretty(&out).map_err(|e| SecretError::Backend(e.to_string()))?;
        // 临时文件 + fsync + rename（write_atomic 已包含），顺手置 0600。
        crate::runtime::fsutil::write_atomic(&self.path, &bytes)
            .map_err(|e| SecretError::Backend(e.to_string()))
    }

    fn encrypt(&self, plaintext: &str) -> SecretResult<String> {
        let mut nonce_bytes = [0u8; NONCE_LEN];
        rand::thread_rng().fill_bytes(&mut nonce_bytes);
        let nonce = Nonce::from_slice(&nonce_bytes);

        let ciphertext = self
            .cipher
            .encrypt(nonce, plaintext.as_bytes())
            .map_err(|_| SecretError::Backend("加密失败".to_string()))?;

        let mut output = Vec::with_capacity(NONCE_LEN + ciphertext.len());
        output.extend_from_slice(&nonce_bytes);
        output.extend_from_slice(&ciphertext);
        Ok(BASE64.encode(output))
    }

    fn decrypt(&self, encoded: &str) -> SecretResult<String> {
        let payload = BASE64.decode(encoded).map_err(|_| SecretError::Corrupt)?;
        if payload.len() <= NONCE_LEN {
            return Err(SecretError::Corrupt);
        }

        let (nonce_bytes, encrypted) = payload.split_at(NONCE_LEN);
        let plaintext = self
            .cipher
            .decrypt(Nonce::from_slice(nonce_bytes), encrypted)
            .map_err(|_| SecretError::Corrupt)?;

        String::from_utf8(plaintext).map_err(|_| SecretError::Corrupt)
    }
}

static STORE: OnceLock<SecretsStore> = OnceLock::new();

/// 启动时调用一次；失败不影响应用启动，只意味着暂时读写不了 Key。
pub fn install(data_dir: &Path) {
    if let Ok(store) = SecretsStore::new(data_dir) {
        let _ = STORE.set(store);
    }
}

fn store() -> SecretResult<&'static SecretsStore> {
    STORE
        .get()
        .ok_or_else(|| SecretError::Backend("凭据存储尚未初始化".to_string()))
}

pub fn set_secret(account: &str, value: &str) -> SecretResult<()> {
    if value.trim().is_empty() {
        return Err(SecretError::Empty);
    }
    store()?.set(account, value)
}

pub fn get_secret(account: &str) -> SecretResult<Option<String>> {
    store()?.get(account)
}

pub fn delete_secret(account: &str) -> SecretResult<()> {
    store()?.delete(account)
}

pub fn set_deepseek_key(key: &str) -> SecretResult<()> {
    set_secret(PROVIDER_DEEPSEEK, key)
}

pub fn get_deepseek_key() -> SecretResult<Option<String>> {
    get_secret(PROVIDER_DEEPSEEK)
}

pub fn delete_deepseek_key() -> SecretResult<()> {
    delete_secret(PROVIDER_DEEPSEEK)
}

pub fn set_device_token(token: &str) -> SecretResult<()> {
    set_secret(DEVICE_TOKEN, token)
}

pub fn get_device_token() -> SecretResult<Option<String>> {
    get_secret(DEVICE_TOKEN)
}

pub fn delete_device_token() -> SecretResult<()> {
    delete_secret(DEVICE_TOKEN)
}

/// 机器稳定标识：macOS `IOPlatformUUID`、Windows `MachineGuid`、Linux `/etc/machine-id`。
pub fn machine_id() -> Option<String> {
    #[cfg(target_os = "macos")]
    {
        let output = std::process::Command::new("ioreg")
            .args(["-rd1", "-c", "IOPlatformExpertDevice"])
            .output()
            .ok()?;
        let text = String::from_utf8_lossy(&output.stdout);
        return text.lines().find_map(|line| {
            let (_, rest) = line.split_once("IOPlatformUUID")?;
            rest.split('"').nth(1).map(str::to_string)
        });
    }

    #[cfg(windows)]
    {
        use winreg::enums::HKEY_LOCAL_MACHINE;
        let key = winreg::RegKey::predef(HKEY_LOCAL_MACHINE)
            .open_subkey(r"SOFTWARE\Microsoft\Cryptography")
            .ok()?;
        return key.get_value::<String, _>("MachineGuid").ok();
    }

    #[cfg(all(not(target_os = "macos"), not(windows)))]
    {
        return std::fs::read_to_string("/etc/machine-id")
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());
    }

    #[allow(unreachable_code)]
    None
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
    Storage(SecretError),
}

impl KeySaveError {
    pub fn ui_code(&self) -> &'static str {
        match self {
            KeySaveError::Storage(error) => match error {
                SecretError::Empty => "INVALID_KEY",
                _ => "SECRET_STORE",
            },
        }
    }

    pub fn message(&self) -> String {
        match self {
            KeySaveError::Storage(error) => error.to_string(),
        }
    }
}

impl From<SecretError> for KeySaveError {
    fn from(error: SecretError) -> Self {
        KeySaveError::Storage(error)
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
/// 写成功即返回，**不回读**——回读只会多一次 IO，掩盖不了任何问题。
pub async fn save_deepseek_key(key: &str) -> Result<KeySaveOutcome, KeySaveError> {
    let key = key.trim();
    set_deepseek_key(key)?;
    let (validation, validation_detail) = validate_deepseek_key(key).await;
    Ok(KeySaveOutcome {
        masked: mask(key),
        validation,
        validation_detail,
    })
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

    fn temp_dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("veyl-secrets-{:016x}", rand::random::<u64>()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn store_in(dir: &Path) -> SecretsStore {
        SecretsStore::with_machine_id(dir.join(SECRETS_FILE), "machine-A").unwrap()
    }

    fn read_file(store: &SecretsStore) -> SecretsFile {
        serde_json::from_str(&std::fs::read_to_string(store.path()).unwrap()).unwrap()
    }

    fn write_file(store: &SecretsStore, file: &SecretsFile) {
        std::fs::write(store.path(), serde_json::to_vec(file).unwrap()).unwrap();
    }

    #[test]
    fn a_value_round_trips_through_the_encrypted_file() {
        let dir = temp_dir();
        let store = store_in(&dir);

        store.set(PROVIDER_DEEPSEEK, "sk-abcdefgh1234").unwrap();
        assert_eq!(
            store.get(PROVIDER_DEEPSEEK).unwrap().as_deref(),
            Some("sk-abcdefgh1234")
        );

        let raw = std::fs::read_to_string(store.path()).unwrap();
        assert!(!raw.contains("sk-abcdefgh1234"), "落盘必须是密文");
        assert!(raw.contains("provider:deepseek"));
        assert!(raw.contains(VERIFY_FIELD));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn both_contract_keys_can_coexist() {
        let dir = temp_dir();
        let store = store_in(&dir);
        store.set(PROVIDER_DEEPSEEK, "sk-abcdefgh1234").unwrap();
        store.set(DEVICE_TOKEN, "device-token-xyz").unwrap();

        assert_eq!(
            store.get(PROVIDER_DEEPSEEK).unwrap().as_deref(),
            Some("sk-abcdefgh1234")
        );
        assert_eq!(
            store.get(DEVICE_TOKEN).unwrap().as_deref(),
            Some("device-token-xyz")
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn the_secrets_file_is_private() {
        use std::os::unix::fs::PermissionsExt;
        let dir = temp_dir();
        let store = store_in(&dir);
        store.set(PROVIDER_DEEPSEEK, "sk-abcdefgh1234").unwrap();

        let mode = std::fs::metadata(store.path()).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_missing_file_reads_as_none() {
        let dir = temp_dir();
        let store = store_in(&dir);
        assert!(store.get(PROVIDER_DEEPSEEK).unwrap().is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn deleting_the_last_key_removes_the_file() {
        let dir = temp_dir();
        let store = store_in(&dir);
        store.set(PROVIDER_DEEPSEEK, "sk-abcdefgh1234").unwrap();
        store.delete(PROVIDER_DEEPSEEK).unwrap();
        assert!(store.get(PROVIDER_DEEPSEEK).unwrap().is_none());
        assert!(!store.path().exists());
        store.delete(PROVIDER_DEEPSEEK).unwrap();
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn empty_values_are_rejected() {
        let dir = temp_dir();
        let store = store_in(&dir);
        assert!(matches!(
            store.set(PROVIDER_DEEPSEEK, "   "),
            Err(SecretError::Empty)
        ));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_tampered_entry_is_dropped_but_its_siblings_survive() {
        let dir = temp_dir();
        let store = store_in(&dir);
        store.set(PROVIDER_DEEPSEEK, "sk-abcdefgh1234").unwrap();
        store.set(DEVICE_TOKEN, "device-token-xyz").unwrap();

        let mut file = read_file(&store);
        file.entries
            .entry(PROVIDER_DEEPSEEK.to_string())
            .and_modify(|ciphertext| ciphertext.push('A'));
        write_file(&store, &file);

        assert!(store.get(PROVIDER_DEEPSEEK).unwrap().is_none(), "损坏条目应被删除");
        assert_eq!(
            store.get(DEVICE_TOKEN).unwrap().as_deref(),
            Some("device-token-xyz"),
            "其它条目不能被牵连"
        );
        assert!(!read_file(&store).entries.contains_key(PROVIDER_DEEPSEEK));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn another_machine_reports_an_error_and_keeps_the_file() {
        let dir = temp_dir();
        store_in(&dir).set(PROVIDER_DEEPSEEK, "sk-abcdefgh1234").unwrap();
        let original = std::fs::read_to_string(dir.join(SECRETS_FILE)).unwrap();

        let other = SecretsStore::with_machine_id(dir.join(SECRETS_FILE), "machine-B").unwrap();
        let error = other.get(PROVIDER_DEEPSEEK).unwrap_err();
        assert!(matches!(error, SecretError::Corrupt));
        assert!(error.to_string().contains("密钥与本机不匹配"));
        assert_eq!(
            std::fs::read_to_string(dir.join(SECRETS_FILE)).unwrap(),
            original,
            "换机不能删掉用户的文件"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_corrupt_file_is_reported_and_left_alone() {
        let dir = temp_dir();
        let store = store_in(&dir);
        std::fs::write(store.path(), b"{ not json").unwrap();

        let error = store.get(PROVIDER_DEEPSEEK).unwrap_err();
        assert_eq!(error.code(), "NOT_FOUND");
        assert!(store.path().exists(), "整体损坏时不做破坏性处理");
        let _ = std::fs::remove_dir_all(&dir);
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
        assert_eq!(classify_status(402), ("ok", Some("insufficient_balance")));
        assert_eq!(classify_status(500), ("unverified", Some("network")));
    }

    #[test]
    fn ui_error_codes_are_distinct() {
        assert_eq!(
            KeySaveError::Storage(SecretError::Empty).ui_code(),
            "INVALID_KEY"
        );
        assert_eq!(
            KeySaveError::Storage(SecretError::Corrupt).ui_code(),
            "SECRET_STORE"
        );
    }
}
