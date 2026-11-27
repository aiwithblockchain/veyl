//! 私有目录里的原子写。
//!
//! 配置里含节点密码与 Clash API 的 secret，所以目录 0700、文件 0600；
//! 写入一律「同目录临时文件 → fsync → rename」，中途失败不会留下半个文件。

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

use serde::de::DeserializeOwned;
use serde::Serialize;

fn random_suffix() -> String {
    use rand::RngCore;
    let mut bytes = [0u8; 8];
    rand::thread_rng().fill_bytes(&mut bytes);
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

#[cfg(unix)]
fn set_mode(path: &Path, mode: u32) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(mode))
}

#[cfg(not(unix))]
fn set_mode(_path: &Path, _mode: u32) -> std::io::Result<()> {
    Ok(())
}

/// 建一个只有自己能进的目录（已存在则只收紧权限）。
pub fn ensure_private_dir(path: &Path) -> std::io::Result<()> {
    fs::create_dir_all(path)?;
    set_mode(path, 0o700)
}

/// 原子写一个 0600 文件。父目录必须已存在。
pub fn write_private(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    let temp = parent.join(format!(
        ".{}.tmp-{}",
        path.file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_else(|| "file".into()),
        random_suffix()
    ));

    let result = (|| {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        set_mode(&temp, 0o600)?;
        fs::rename(&temp, path)?;
        Ok(())
    })();

    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result
}

pub fn write_json<T: Serialize>(path: &Path, value: &T) -> std::io::Result<()> {
    let bytes = serde_json::to_vec_pretty(value)
        .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidData, error))?;
    write_private(path, &bytes)
}

/// 读 JSON。文件不存在返回 `Ok(None)`，内容坏了返回 Err——两者不能混。
pub fn read_json<T: DeserializeOwned>(path: &Path) -> std::io::Result<Option<T>> {
    match fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map(Some)
            .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidData, error)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error),
    }
}

pub fn read_text(path: &Path) -> std::io::Result<String> {
    fs::read_to_string(path)
}

pub fn remove_file_if_exists(path: &Path) -> std::io::Result<()> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}

pub fn remove_dir_if_exists(path: &Path) -> std::io::Result<()> {
    match fs::remove_dir_all(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}

pub fn data_dir_join(root: &Path, name: &str) -> PathBuf {
    root.join(name)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_atomically_and_overwrites() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("profile.json");
        write_private(&path, b"{\"a\":1}").unwrap();
        assert_eq!(read_text(&path).unwrap(), "{\"a\":1}");
        write_private(&path, b"{\"a\":2}").unwrap();
        assert_eq!(read_text(&path).unwrap(), "{\"a\":2}");
        // 临时文件不许留下。
        let leftovers: Vec<_> = fs::read_dir(dir.path())
            .unwrap()
            .filter_map(|entry| entry.ok())
            .filter(|entry| entry.file_name().to_string_lossy().contains(".tmp-"))
            .collect();
        assert!(leftovers.is_empty(), "残留临时文件：{leftovers:?}");
    }

    #[cfg(unix)]
    #[test]
    fn files_are_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("runtime.json");
        write_private(&path, b"{}").unwrap();
        let mode = fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "配置文件必须 0600");
    }

    #[test]
    fn missing_file_is_none_but_corrupt_is_error() {
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("none.json");
        let value: Option<serde_json::Value> = read_json(&missing).unwrap();
        assert!(value.is_none());

        let corrupt = dir.path().join("bad.json");
        fs::write(&corrupt, b"{not json").unwrap();
        assert!(read_json::<serde_json::Value>(&corrupt).is_err());
    }
}
