//! 订阅链接（令牌）的加密存储。
//!
//! 技术设计 §6.3 指定系统钥匙串；但主客户端的经验是 macOS 每次读写都可能弹
//! 授权框、debug 每次重建签名变化还会重新问。所以这里把它抽成 `SecretStore`：
//!
//! - 发布构建默认 `KeyringStore`（macOS Keychain / Windows 凭据管理器）；
//! - debug 构建默认 `FileStore`：`<data_dir>/secrets.enc`，0600，
//!   AES-256-GCM，密钥由机器标识 + 固定盐派生（与主客户端同一套构造）；
//! - `VEYL_CLI_SECRET_BACKEND=keychain|file` 可强制指定。
//!
//! 两种实现都是加密落盘，满足 §9「令牌不得明文落盘」。

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

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
const VERIFY_PLAINTEXT: &str = "veyl-cli-secret-store-v1";

pub const SECRETS_FILE: &str = "secrets.enc";

pub trait SecretStore: Send + Sync {
    fn get(&self, account: &str) -> Result<Option<String>, String>;
    fn set(&self, account: &str, value: &str) -> Result<(), String>;
    fn delete(&self, account: &str) -> Result<(), String>;
}

/// 按构建与开关选择实现。`service` 用作钥匙串的 service 名（= bundle id）。
pub fn open(data_dir: &Path, service: &str) -> Arc<dyn SecretStore> {
    let choice = std::env::var("VEYL_CLI_SECRET_BACKEND")
        .ok()
        .map(|value| value.trim().to_ascii_lowercase());
    let want_keychain = match choice.as_deref() {
        Some("keychain") => true,
        Some("file") => false,
        // 未指定：发布用钥匙串，debug 用文件。
        _ => !cfg!(debug_assertions),
    };

    if want_keychain {
        #[cfg(any(target_os = "macos", target_os = "windows"))]
        {
            return Arc::new(KeyringStore::new(service));
        }
    }

    match FileStore::new(data_dir.join(SECRETS_FILE)) {
        Ok(store) => Arc::new(store),
        Err(error) => {
            // 加密后端起不来时不能退化成明文：宁可这次会话里存不进去。
            Arc::new(BrokenStore {
                reason: error.to_string(),
            })
        }
    }
}

pub struct BrokenStore {
    reason: String,
}

impl SecretStore for BrokenStore {
    fn get(&self, _account: &str) -> Result<Option<String>, String> {
        Err(self.reason.clone())
    }

    fn set(&self, _account: &str, _value: &str) -> Result<(), String> {
        Err(self.reason.clone())
    }

    fn delete(&self, _account: &str) -> Result<(), String> {
        Err(self.reason.clone())
    }
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
pub struct KeyringStore {
    service: String,
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
impl KeyringStore {
    pub fn new(service: &str) -> Self {
        Self {
            service: service.to_string(),
        }
    }

    fn entry(&self, account: &str) -> Result<keyring::Entry, String> {
        keyring::Entry::new(&self.service, account).map_err(|error| error.to_string())
    }
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
impl SecretStore for KeyringStore {
    fn get(&self, account: &str) -> Result<Option<String>, String> {
        match self.entry(account)?.get_password() {
            Ok(value) => Ok(Some(value)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(error) => Err(error.to_string()),
        }
    }

    fn set(&self, account: &str, value: &str) -> Result<(), String> {
        self.entry(account)?
            .set_password(value)
            .map_err(|error| error.to_string())
    }

    fn delete(&self, account: &str) -> Result<(), String> {
        match self.entry(account)?.delete_credential() {
            Ok(()) => Ok(()),
            Err(keyring::Error::NoEntry) => Ok(()),
            Err(error) => Err(error.to_string()),
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
    fn has_user_entries(&self) -> bool {
        self.entries.keys().any(|key| key != VERIFY_FIELD)
    }
}

pub struct FileStore {
    path: PathBuf,
    cipher: Aes256Gcm,
    lock: Mutex<()>,
}

impl FileStore {
    pub fn new(path: PathBuf) -> Result<Self, String> {
        let machine = machine_id().ok_or_else(|| "无法获取本机机器标识".to_string())?;
        let mut key = [0u8; KEY_LEN];
        pbkdf2_hmac::<Sha256>(
            machine.as_bytes(),
            KEY_SALT,
            PBKDF2_ITERATIONS,
            &mut key,
        );
        let cipher = Aes256Gcm::new_from_slice(&key)
            .map_err(|_| "初始化加密器失败".to_string())?;
        Ok(Self {
            path,
            cipher,
            lock: Mutex::new(()),
        })
    }

    /// 测试用：指定密钥与路径，不依赖本机标识。
    pub fn with_key(path: PathBuf, machine: &str) -> Result<Self, String> {
        let mut key = [0u8; KEY_LEN];
        pbkdf2_hmac::<Sha256>(machine.as_bytes(), KEY_SALT, PBKDF2_ITERATIONS, &mut key);
        let cipher = Aes256Gcm::new_from_slice(&key)
            .map_err(|_| "初始化加密器失败".to_string())?;
        Ok(Self {
            path,
            cipher,
            lock: Mutex::new(()),
        })
    }

    fn read_file(&self) -> Result<SecretsFile, String> {
        match std::fs::read_to_string(&self.path) {
            Ok(text) => serde_json::from_str(&text).map_err(|_| "凭据文件损坏".to_string()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                Ok(SecretsFile::default())
            }
            Err(error) => Err(error.to_string()),
        }
    }

    fn persist(&self, file: &SecretsFile) -> Result<(), String> {
        if !file.has_user_entries() {
            return match std::fs::remove_file(&self.path) {
                Ok(()) => Ok(()),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
                Err(error) => Err(error.to_string()),
            };
        }
        let mut out = file.clone();
        if !out.entries.contains_key(VERIFY_FIELD) {
            out.entries
                .insert(VERIFY_FIELD.to_string(), self.encrypt(VERIFY_PLAINTEXT)?);
        }
        let bytes = serde_json::to_vec_pretty(&out).map_err(|error| error.to_string())?;
        crate::fsutil::write_private(&self.path, &bytes).map_err(|error| error.to_string())
    }

    fn encrypt(&self, plaintext: &str) -> Result<String, String> {
        let mut nonce_bytes = [0u8; NONCE_LEN];
        rand::thread_rng().fill_bytes(&mut nonce_bytes);
        let ciphertext = self
            .cipher
            .encrypt(Nonce::from_slice(&nonce_bytes), plaintext.as_bytes())
            .map_err(|_| "加密失败".to_string())?;
        let mut output = Vec::with_capacity(NONCE_LEN + ciphertext.len());
        output.extend_from_slice(&nonce_bytes);
        output.extend_from_slice(&ciphertext);
        Ok(BASE64.encode(output))
    }

    fn decrypt(&self, encoded: &str) -> Result<String, String> {
        let payload = BASE64.decode(encoded).map_err(|_| "凭据文件损坏".to_string())?;
        if payload.len() <= NONCE_LEN {
            return Err("凭据文件损坏".to_string());
        }
        let (nonce_bytes, encrypted) = payload.split_at(NONCE_LEN);
        let plaintext = self
            .cipher
            .decrypt(Nonce::from_slice(nonce_bytes), encrypted)
            .map_err(|_| "凭据文件损坏".to_string())?;
        String::from_utf8(plaintext).map_err(|_| "凭据文件损坏".to_string())
    }
}

impl SecretStore for FileStore {
    fn get(&self, account: &str) -> Result<Option<String>, String> {
        let _guard = self.lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let file = self.read_file()?;
        match file.entries.get(account) {
            Some(ciphertext) => self.decrypt(ciphertext).map(Some),
            None => Ok(None),
        }
    }

    fn set(&self, account: &str, value: &str) -> Result<(), String> {
        if value.trim().is_empty() {
            return Err("凭据内容为空".to_string());
        }
        let _guard = self.lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let mut file = self.read_file()?;
        file.entries
            .insert(account.to_string(), self.encrypt(value.trim())?);
        self.persist(&file)
    }

    fn delete(&self, account: &str) -> Result<(), String> {
        let _guard = self.lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let mut file = self.read_file()?;
        if file.entries.remove(account).is_none() {
            return Ok(());
        }
        self.persist(&file)
    }
}

fn machine_id() -> Option<String> {
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

#[cfg(test)]
pub struct MemoryStore {
    entries: Mutex<BTreeMap<String, String>>,
}

#[cfg(test)]
impl MemoryStore {
    pub fn new() -> Self {
        Self {
            entries: Mutex::new(BTreeMap::new()),
        }
    }
}

#[cfg(test)]
impl SecretStore for MemoryStore {
    fn get(&self, account: &str) -> Result<Option<String>, String> {
        Ok(self.entries.lock().unwrap().get(account).cloned())
    }

    fn set(&self, account: &str, value: &str) -> Result<(), String> {
        self.entries
            .lock()
            .unwrap()
            .insert(account.to_string(), value.to_string());
        Ok(())
    }

    fn delete(&self, account: &str) -> Result<(), String> {
        self.entries.lock().unwrap().remove(account);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_store_roundtrips_and_encrypts() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(SECRETS_FILE);
        let store = FileStore::with_key(path.clone(), "machine-a").unwrap();

        store.set("profile-1", "https://veyl:mp_secret@host/v1/mobile/profile").unwrap();
        assert_eq!(
            store.get("profile-1").unwrap().as_deref(),
            Some("https://veyl:mp_secret@host/v1/mobile/profile")
        );

        let raw = std::fs::read_to_string(&path).unwrap();
        assert!(!raw.contains("mp_secret"), "令牌不该明文落盘：{raw}");

        store.delete("profile-1").unwrap();
        assert!(store.get("profile-1").unwrap().is_none());
    }

    #[test]
    fn another_machine_cannot_decrypt() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(SECRETS_FILE);
        FileStore::with_key(path.clone(), "machine-a")
            .unwrap()
            .set("profile-1", "https://veyl:mp_secret@host/v1/mobile/profile")
            .unwrap();

        let other = FileStore::with_key(path, "machine-b").unwrap();
        assert!(other.get("profile-1").is_err(), "换机器必须解不开");
    }

    #[test]
    fn deleting_everything_removes_the_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(SECRETS_FILE);
        let store = FileStore::with_key(path.clone(), "machine-a").unwrap();
        store.set("a", "x").unwrap();
        assert!(path.exists());
        store.delete("a").unwrap();
        assert!(!path.exists(), "空文件应被删除");
    }

    #[cfg(unix)]
    #[test]
    fn secrets_file_is_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(SECRETS_FILE);
        let store = FileStore::with_key(path.clone(), "machine-a").unwrap();
        store.set("a", "x").unwrap();
        let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
    }
}
