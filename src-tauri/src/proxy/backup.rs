use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::runtime::error::{RuntimeError, RuntimeResult};
use crate::runtime::fsutil;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Endpoint {
    pub server: String,
    pub port: u16,
}

impl Endpoint {
    pub fn loopback(port: u16) -> Self {
        Self {
            server: "127.0.0.1".into(),
            port,
        }
    }
}

impl std::fmt::Display for Endpoint {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}:{}", self.server, self.port)
    }
}

/// 代理备份。`payload` 的平台结构各自定义，避免把 macOS/Windows 的字段搅在一起。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProxyBackup {
    #[serde(default = "default_schema")]
    pub schema: u32,
    pub platform: String,
    pub applied: Endpoint,
    pub payload: serde_json::Value,
    pub created_at: i64,
}

fn default_schema() -> u32 {
    1
}

impl ProxyBackup {
    pub fn new(platform: impl Into<String>, applied: Endpoint, payload: serde_json::Value) -> Self {
        Self {
            schema: 1,
            platform: platform.into(),
            applied,
            payload,
            created_at: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_secs() as i64)
                .unwrap_or(0),
        }
    }
}

pub trait BackupStore: Send + Sync {
    fn load(&self) -> RuntimeResult<Option<ProxyBackup>>;
    fn save(&self, backup: &ProxyBackup) -> RuntimeResult<()>;
    fn clear(&self) -> RuntimeResult<()>;
}

pub struct FileBackupStore {
    path: PathBuf,
}

impl FileBackupStore {
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self { path: path.into() }
    }

    pub fn in_app_data(app_data_dir: impl AsRef<Path>) -> Self {
        Self::new(app_data_dir.as_ref().join("proxy-backup.json"))
    }

    pub fn path(&self) -> &Path {
        &self.path
    }
}

impl BackupStore for FileBackupStore {
    fn load(&self) -> RuntimeResult<Option<ProxyBackup>> {
        fsutil::read_json(&self.path)
    }

    fn save(&self, backup: &ProxyBackup) -> RuntimeResult<()> {
        fsutil::write_atomic_json(&self.path, backup)
    }

    fn clear(&self) -> RuntimeResult<()> {
        match std::fs::remove_file(&self.path) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(RuntimeError::Io {
                path: self.path.clone(),
                source: e,
            }),
        }
    }
}

#[derive(Default)]
pub struct MemoryBackupStore {
    inner: Mutex<Option<ProxyBackup>>,
}

impl MemoryBackupStore {
    pub fn new() -> Self {
        Self::default()
    }
}

impl BackupStore for MemoryBackupStore {
    fn load(&self) -> RuntimeResult<Option<ProxyBackup>> {
        Ok(self.inner.lock().unwrap().clone())
    }

    fn save(&self, backup: &ProxyBackup) -> RuntimeResult<()> {
        *self.inner.lock().unwrap() = Some(backup.clone());
        Ok(())
    }

    fn clear(&self) -> RuntimeResult<()> {
        *self.inner.lock().unwrap() = None;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_store_round_trips_and_clears() {
        let dir = std::env::temp_dir().join(format!("aivpn-store-{:016x}", rand::random::<u64>()));
        fsutil::ensure_dir(&dir).unwrap();
        let store = FileBackupStore::in_app_data(&dir);
        assert!(store.load().unwrap().is_none());

        let backup = ProxyBackup::new("macos", Endpoint::loopback(2080), serde_json::json!({}));
        store.save(&backup).unwrap();
        assert_eq!(
            store.load().unwrap().unwrap().applied,
            Endpoint::loopback(2080)
        );

        store.clear().unwrap();
        assert!(store.load().unwrap().is_none());
        store.clear().unwrap();
        let _ = std::fs::remove_dir_all(&dir);
    }
}
