//! 配置清单与配置文件的持久化。
//!
//! 布局（技术设计 §6.3）：
//! ```text
//! <root>/profiles.json               # 元数据数组，绝不含 URL 或令牌
//! <root>/profiles/<id>/profile.json  # 原始 sing-box JSON（重新装配的唯一来源）
//! <root>/profiles/<id>/runtime.json  # 装配后的预览（M1-B 连接时重新装配）
//! ```
//!
//! 一切写入都是 0600 原子写。id 只允许 `[A-Za-z0-9-]`，避免被拼成路径穿越。

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};
use crate::fsutil;
use crate::models::Profile;

pub const PROFILE_LIST_FILE: &str = "profiles.json";
pub const RAW_FILE: &str = "profile.json";
pub const RUNTIME_FILE: &str = "runtime.json";
const PROFILES_DIR: &str = "profiles";
const LIST_VERSION: u32 = 1;

#[derive(Debug, Serialize, Deserialize)]
struct ProfilesFile {
    #[serde(default = "list_version")]
    version: u32,
    #[serde(default)]
    profiles: Vec<Profile>,
}

fn list_version() -> u32 {
    LIST_VERSION
}

impl Default for ProfilesFile {
    fn default() -> Self {
        Self {
            version: LIST_VERSION,
            profiles: Vec::new(),
        }
    }
}

pub struct Store {
    root: PathBuf,
}

impl Store {
    pub fn new(root: impl Into<PathBuf>) -> AppResult<Self> {
        let root = root.into();
        fsutil::ensure_private_dir(&root)?;
        fsutil::ensure_private_dir(&root.join(PROFILES_DIR))?;
        Ok(Self { root })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    fn list_path(&self) -> PathBuf {
        self.root.join(PROFILE_LIST_FILE)
    }

    fn profile_dir(&self, id: &str) -> AppResult<PathBuf> {
        validate_id(id)?;
        Ok(self.root.join(PROFILES_DIR).join(id))
    }

    pub fn raw_path(&self, id: &str) -> AppResult<PathBuf> {
        Ok(self.profile_dir(id)?.join(RAW_FILE))
    }

    pub fn runtime_path(&self, id: &str) -> AppResult<PathBuf> {
        Ok(self.profile_dir(id)?.join(RUNTIME_FILE))
    }

    pub fn list(&self) -> AppResult<Vec<Profile>> {
        let file: Option<ProfilesFile> = fsutil::read_json(&self.list_path()).map_err(|error| {
            AppError::internal(format!("配置清单读不出来：{error}"))
                .with_hint("重试一次；仍然失败就检查应用数据目录。")
        })?;
        Ok(file.map(|file| file.profiles).unwrap_or_default())
    }

    pub fn get(&self, id: &str) -> AppResult<Option<Profile>> {
        Ok(self.list()?.into_iter().find(|profile| profile.id == id))
    }

    /// 有则整体替换，无则追加到末尾。
    pub fn upsert(&self, profile: &Profile) -> AppResult<()> {
        let mut profiles = self.list()?;
        match profiles.iter_mut().find(|item| item.id == profile.id) {
            Some(slot) => *slot = profile.clone(),
            None => profiles.push(profile.clone()),
        }
        self.save_list(&profiles)
    }

    /// 删元数据、删目录（原文件与装配预览一起消失）。
    pub fn remove(&self, id: &str) -> AppResult<()> {
        let mut profiles = self.list()?;
        profiles.retain(|profile| profile.id != id);
        self.save_list(&profiles)?;
        fsutil::remove_dir_if_exists(&self.profile_dir(id)?)?;
        Ok(())
    }

    fn save_list(&self, profiles: &[Profile]) -> AppResult<()> {
        let file = ProfilesFile {
            version: LIST_VERSION,
            profiles: profiles.to_vec(),
        };
        fsutil::write_json(&self.list_path(), &file)?;
        Ok(())
    }

    pub fn prepare_dir(&self, id: &str) -> AppResult<()> {
        fsutil::ensure_private_dir(&self.profile_dir(id)?)?;
        Ok(())
    }

    pub fn write_raw(&self, id: &str, text: &str) -> AppResult<()> {
        self.prepare_dir(id)?;
        fsutil::write_private(&self.raw_path(id)?, text.as_bytes())?;
        Ok(())
    }

    pub fn read_raw(&self, id: &str) -> AppResult<Option<String>> {
        let path = self.raw_path(id)?;
        match std::fs::read_to_string(&path) {
            Ok(text) => Ok(Some(text)),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(error.into()),
        }
    }

    pub fn write_runtime(&self, id: &str, value: &serde_json::Value) -> AppResult<()> {
        self.prepare_dir(id)?;
        fsutil::write_json(&self.runtime_path(id)?, value)?;
        Ok(())
    }

    pub fn remove_runtime(&self, id: &str) -> AppResult<()> {
        fsutil::remove_file_if_exists(&self.runtime_path(id)?)?;
        Ok(())
    }
}

fn validate_id(id: &str) -> AppResult<()> {
    let ok = !id.is_empty()
        && id.len() <= 64
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-');
    if ok {
        Ok(())
    } else {
        Err(AppError::invalid("配置标识不合法"))
    }
}

/// 生成一个新的配置 id。
pub fn new_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{KernelCheck, ProfileSource, SyncState};

    fn profile(id: &str) -> Profile {
        Profile {
            id: id.to_string(),
            name: format!("配置 {id}"),
            source: ProfileSource::Subscription {
                host: "vpn.example.com".into(),
            },
            node_count: 2,
            last_synced_at: Some(1_763_000_000_000),
            sync_state: SyncState::Ok,
            sync_error: None,
            created_at: 1_763_000_000_000,
            kernel_check: KernelCheck::Passed,
        }
    }

    #[test]
    fn upsert_list_and_remove_round_trip() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::new(dir.path()).unwrap();

        store.upsert(&profile("a")).unwrap();
        store.upsert(&profile("b")).unwrap();
        assert_eq!(store.list().unwrap().len(), 2);

        let mut updated = profile("a");
        updated.name = "改名了".into();
        store.upsert(&updated).unwrap();
        assert_eq!(store.get("a").unwrap().unwrap().name, "改名了");

        store.write_raw("a", "{\"outbounds\":[]}").unwrap();
        assert_eq!(store.read_raw("a").unwrap().unwrap(), "{\"outbounds\":[]}");

        store.remove("a").unwrap();
        assert!(store.get("a").unwrap().is_none());
        assert!(store.read_raw("a").unwrap().is_none());
        assert!(!store.raw_path("a").unwrap().parent().unwrap().exists());
    }

    #[test]
    fn the_list_file_never_contains_a_token() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::new(dir.path()).unwrap();
        store.upsert(&profile("a")).unwrap();
        let text = std::fs::read_to_string(store.list_path()).unwrap();
        assert!(!text.contains("mp_"), "{text}");
        assert!(!text.contains("https://"), "{text}");
    }

    #[test]
    fn rejects_ids_that_could_escape_the_directory() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::new(dir.path()).unwrap();
        assert!(store.raw_path("../escape").is_err());
        assert!(store.raw_path("a/b").is_err());
        assert!(store.raw_path("").is_err());
    }

    #[test]
    fn missing_list_file_is_an_empty_list() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::new(dir.path()).unwrap();
        assert!(store.list().unwrap().is_empty());
    }

    #[test]
    fn runtime_preview_is_readable_json() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::new(dir.path()).unwrap();
        let value = serde_json::json!({"log": {"level": "warn"}});
        store.write_runtime("a", &value).unwrap();
        let text = std::fs::read_to_string(store.runtime_path("a").unwrap()).unwrap();
        let back: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert_eq!(back, value);
        store.remove_runtime("a").unwrap();
        assert!(!store.runtime_path("a").unwrap().exists());
    }
}
