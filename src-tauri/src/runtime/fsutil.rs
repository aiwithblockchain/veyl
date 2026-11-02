use std::fs;
use std::io::Write;
use std::path::Path;

use super::error::{IoContext, RuntimeError, RuntimeResult};

pub fn set_executable(path: &Path) -> RuntimeResult<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = fs::metadata(path).io_ctx(path)?.permissions();
        perms.set_mode(0o755);
        fs::set_permissions(path, perms).io_ctx(path)?;
    }
    #[cfg(not(unix))]
    {
        let _ = path;
    }
    Ok(())
}

pub fn set_private(path: &Path) -> RuntimeResult<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = fs::metadata(path).io_ctx(path)?.permissions();
        perms.set_mode(0o600);
        fs::set_permissions(path, perms).io_ctx(path)?;
    }
    #[cfg(not(unix))]
    {
        let _ = path;
    }
    Ok(())
}

/// 写入临时文件后 rename（同目录），避免出现半截文件。
pub fn write_atomic(path: &Path, bytes: &[u8]) -> RuntimeResult<()> {
    let parent = path
        .parent()
        .ok_or_else(|| RuntimeError::State(format!("{} has no parent", path.display())))?;
    fs::create_dir_all(parent).io_ctx(parent)?;

    let file_name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "state".to_string());
    let tmp = parent.join(format!(".{file_name}.tmp-{:016x}", rand::random::<u64>()));

    let result = (|| -> RuntimeResult<()> {
        let mut file = fs::File::create(&tmp).io_ctx(&tmp)?;
        file.write_all(bytes).io_ctx(&tmp)?;
        file.sync_all().io_ctx(&tmp)?;
        drop(file);
        set_private(&tmp)?;
        fs::rename(&tmp, path).io_ctx(path)?;
        Ok(())
    })();

    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
}

pub fn write_atomic_json<T: serde::Serialize>(path: &Path, value: &T) -> RuntimeResult<()> {
    let bytes = serde_json::to_vec_pretty(value)
        .map_err(|e| RuntimeError::State(format!("serialize {}: {e}", path.display())))?;
    write_atomic(path, &bytes)
}

pub fn read_json<T: serde::de::DeserializeOwned>(path: &Path) -> RuntimeResult<Option<T>> {
    match fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map(Some)
            .map_err(|e| RuntimeError::State(format!("parse {}: {e}", path.display()))),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(RuntimeError::Io {
            path: path.to_path_buf(),
            source: e,
        }),
    }
}

pub fn ensure_dir(path: &Path) -> RuntimeResult<()> {
    fs::create_dir_all(path).io_ctx(path)
}

/// 存放凭据相关文件的目录用 0700。
pub fn ensure_private_dir(path: &Path) -> RuntimeResult<()> {
    fs::create_dir_all(path).io_ctx(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = fs::metadata(path).io_ctx(path)?.permissions();
        perms.set_mode(0o700);
        fs::set_permissions(path, perms).io_ctx(path)?;
    }
    Ok(())
}

/// 递归删除；不存在视为成功。
pub fn remove_dir_if_exists(path: &Path) -> RuntimeResult<()> {
    match fs::remove_dir_all(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(RuntimeError::Io {
            path: path.to_path_buf(),
            source: e,
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[test]
    fn private_dirs_are_0700() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("veyl-fsutil-{:016x}", rand::random::<u64>()));
        ensure_private_dir(&dir).unwrap();
        let mode = fs::metadata(&dir).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o700);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn atomic_write_replaces_content() {
        let dir = std::env::temp_dir().join(format!("veyl-fsutil-{:016x}", rand::random::<u64>()));
        ensure_dir(&dir).unwrap();
        let path = dir.join("state.json");
        write_atomic(&path, b"one").unwrap();
        write_atomic(&path, b"two").unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "two");
        let _ = fs::remove_dir_all(&dir);
    }
}
