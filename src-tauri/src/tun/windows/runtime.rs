//! 运行时 staging：`sing-box.exe` + `wintun.dll`。
//!
//! 服务以 LocalSystem 运行，**只从 `C:\Program Files\Veyl\` 读**这两个文件，
//! 复制到 `%ProgramData%\Veyl\runtime\<sha256>\` 后再执行。用户可写的位置
//! （per-user 应用目录、`%TEMP%`）永远不参与。
//!
//! 哈希在构建时由 `build.rs` 编进二进制（`VEYL_RUNTIME_SHA256` /
//! `VEYL_WINTUN_SHA256`），请求方说了不算。任何一个对不上就失败关闭，
//! 不降级、不找替代文件。

use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

pub const SING_BOX: &str = "sing-box.exe";
pub const WINTUN: &str = "wintun.dll";

const RUNTIME_SHA256: &str = match option_env!("VEYL_RUNTIME_SHA256") {
    Some(value) => value,
    None => "",
};
const WINTUN_SHA256: &str = match option_env!("VEYL_WINTUN_SHA256") {
    Some(value) => value,
    None => "",
};

/// 与契约 §4.2 的 wire 码一致：`runtime_missing` / `tun_start_failed`。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RuntimeError {
    pub code: &'static str,
    pub message: String,
}

impl RuntimeError {
    fn missing(message: impl Into<String>) -> Self {
        Self {
            code: "runtime_missing",
            message: message.into(),
        }
    }

    fn failed(message: impl Into<String>) -> Self {
        Self {
            code: "tun_start_failed",
            message: message.into(),
        }
    }
}

/// 解析（必要时 staging）出可执行的 `sing-box.exe`。
pub fn resolve(install_root: &Path, data_root: &Path) -> Result<PathBuf, RuntimeError> {
    resolve_with(install_root, data_root, RUNTIME_SHA256, WINTUN_SHA256)
}

/// 可注入哈希的版本：测试不必依赖构建时有没有那 78 MB 运行时。
pub fn resolve_with(
    install_root: &Path,
    data_root: &Path,
    runtime_sha: &str,
    wintun_sha: &str,
) -> Result<PathBuf, RuntimeError> {
    if !is_full_sha256(runtime_sha) || !is_full_sha256(wintun_sha) {
        return Err(RuntimeError::missing(
            "这份构建里没有随包运行时（构建时没找到 sing-box.exe 或 wintun.dll）",
        ));
    }

    let source_dir = install_root.join("runtime");
    if !super::path_within(install_root, &source_dir) {
        return Err(RuntimeError::missing("运行时目录不在安装目录下"));
    }
    let source_exe = source_dir.join(SING_BOX);
    let source_dll = source_dir.join(WINTUN);
    for source in [&source_exe, &source_dll] {
        if !super::path_within(install_root, source) {
            return Err(RuntimeError::missing("运行时不位于安装目录"));
        }
        if !source.is_file() {
            return Err(RuntimeError::missing(format!(
                "安装目录里缺少 {}",
                source
                    .file_name()
                    .and_then(|name| name.to_str())
                    .unwrap_or("运行时")
            )));
        }
    }

    let staged = data_root.join("runtime").join(runtime_sha);
    if !super::path_within(data_root, &staged) {
        return Err(RuntimeError::missing("staging 目录不合法"));
    }
    std::fs::create_dir_all(&staged)
        .map_err(|error| RuntimeError::failed(format!("创建运行时目录失败：{error}")))?;

    stage_file(&source_exe, &staged.join(SING_BOX), runtime_sha)?;
    stage_file(&source_dll, &staged.join(WINTUN), wintun_sha)?;

    prune(data_root, runtime_sha);

    let executable = staged.join(SING_BOX);
    if !executable.is_file() {
        return Err(RuntimeError::failed("staging 后找不到 sing-box.exe"));
    }
    Ok(executable)
}

/// 复制并校验。已经有一份哈希正确的副本时直接复用——首次启动要复制约 78 MB，
/// 不能每次 `start` 都再付一遍。
fn stage_file(source: &Path, destination: &Path, expected: &str) -> Result<(), RuntimeError> {
    if hash_matches(destination, expected) {
        return Ok(());
    }

    let bytes = std::fs::read(source).map_err(|error| {
        RuntimeError::missing(format!(
            "读取 {} 失败：{error}",
            source
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("运行时")
        ))
    })?;
    let actual = sha256_hex(&bytes);
    if actual != expected {
        return Err(RuntimeError::missing(format!(
            "{} 的哈希与编译进服务的值不符（实际 {actual}）",
            source
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("运行时")
        )));
    }

    // 先写临时文件再改名：中途失败不会留下一个半截的「验证过」的副本。
    let temporary = destination.with_extension("tmp");
    std::fs::write(&temporary, &bytes)
        .map_err(|error| RuntimeError::failed(format!("写入运行时失败：{error}")))?;
    if destination.exists() {
        std::fs::remove_file(destination)
            .map_err(|error| RuntimeError::failed(format!("替换旧运行时失败：{error}")))?;
    }
    std::fs::rename(&temporary, destination)
        .map_err(|error| RuntimeError::failed(format!("落盘运行时失败：{error}")))?;
    Ok(())
}

fn hash_matches(path: &Path, expected: &str) -> bool {
    let Ok(bytes) = std::fs::read(path) else {
        return false;
    };
    sha256_hex(&bytes) == expected
}

/// 只保留当前哈希目录。只删「64 位十六进制命名的目录」，别的条目一概不碰；
/// 不跟随 symlink / junction。
fn prune(data_root: &Path, keep: &str) {
    let root = data_root.join("runtime");
    let Ok(entries) = std::fs::read_dir(&root) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        if name == keep || !is_full_sha256(name) {
            continue;
        }
        let path = entry.path();
        let Ok(metadata) = std::fs::symlink_metadata(&path) else {
            continue;
        };
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            continue;
        }
        let _ = std::fs::remove_dir_all(path);
    }
}

pub fn is_full_sha256(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TempDir(PathBuf);

    impl TempDir {
        fn new(tag: &str) -> Self {
            let path = std::env::temp_dir()
                .join(format!("veyl-runtime-{tag}-{:016x}", rand::random::<u64>()));
            std::fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    const EXE: &[u8] = b"fake sing-box executable";
    const DLL: &[u8] = b"fake wintun dll";

    fn install(temp: &TempDir) -> PathBuf {
        let dir = temp.0.join("install");
        std::fs::create_dir_all(dir.join("runtime")).unwrap();
        std::fs::write(dir.join("runtime").join(SING_BOX), EXE).unwrap();
        std::fs::write(dir.join("runtime").join(WINTUN), DLL).unwrap();
        dir
    }

    #[test]
    fn the_runtime_is_staged_under_the_hash_of_its_own_bytes() {
        let temp = TempDir::new("stage");
        let install = install(&temp);
        let data = temp.0.join("data");
        std::fs::create_dir_all(&data).unwrap();

        let exe = resolve_with(&install, &data, &sha256_hex(EXE), &sha256_hex(DLL)).unwrap();
        assert_eq!(
            exe,
            data.join("runtime").join(sha256_hex(EXE)).join(SING_BOX)
        );
        assert_eq!(std::fs::read(&exe).unwrap(), EXE);
        assert_eq!(
            std::fs::read(exe.with_file_name(WINTUN)).unwrap(),
            DLL,
            "wintun.dll 必须和 sing-box.exe 同目录"
        );
    }

    #[test]
    fn a_tampered_staged_copy_is_rebuilt_from_the_install_dir() {
        let temp = TempDir::new("tamper");
        let install = install(&temp);
        let data = temp.0.join("data");
        let digest = sha256_hex(EXE);
        let staged = data.join("runtime").join(&digest);
        std::fs::create_dir_all(&staged).unwrap();
        std::fs::write(staged.join(SING_BOX), b"tampered").unwrap();

        resolve_with(&install, &data, &digest, &sha256_hex(DLL)).unwrap();
        assert_eq!(std::fs::read(staged.join(SING_BOX)).unwrap(), EXE);
    }

    #[test]
    fn a_source_that_does_not_match_the_compiled_hash_is_refused() {
        let temp = TempDir::new("mismatch");
        let install = install(&temp);
        let data = temp.0.join("data");
        std::fs::create_dir_all(&data).unwrap();

        let error = resolve_with(&install, &data, &"0".repeat(64), &sha256_hex(DLL)).unwrap_err();
        assert_eq!(error.code, "runtime_missing");
        assert!(
            !data
                .join("runtime")
                .join("0".repeat(64))
                .join(SING_BOX)
                .exists(),
            "校验不过不能留下任何可执行副本"
        );
    }

    #[test]
    fn an_empty_compiled_hash_means_runtime_missing() {
        let temp = TempDir::new("empty");
        let install = install(&temp);
        let error = resolve_with(&install, &temp.0.join("data"), "", "").unwrap_err();
        assert_eq!(error.code, "runtime_missing");
    }

    #[test]
    fn a_missing_wintun_is_reported_not_guessed() {
        let temp = TempDir::new("nodll");
        let install = install(&temp);
        std::fs::remove_file(install.join("runtime").join(WINTUN)).unwrap();
        let data = temp.0.join("data");
        let error = resolve_with(&install, &data, &sha256_hex(EXE), &sha256_hex(DLL)).unwrap_err();
        assert_eq!(error.code, "runtime_missing");
        assert!(error.message.contains("wintun.dll"), "{}", error.message);
    }

    #[test]
    fn staging_prunes_previous_runtimes_and_keeps_foreign_entries() {
        let temp = TempDir::new("prune");
        let install = install(&temp);
        let data = temp.0.join("data");
        let old = data.join("runtime").join("a".repeat(64));
        std::fs::create_dir_all(&old).unwrap();
        std::fs::write(old.join(SING_BOX), b"old").unwrap();
        let foreign = data.join("runtime").join("logs");
        std::fs::create_dir_all(&foreign).unwrap();

        let digest = sha256_hex(EXE);
        resolve_with(&install, &data, &digest, &sha256_hex(DLL)).unwrap();
        assert!(!old.exists(), "旧运行时目录要清掉");
        assert!(foreign.exists(), "不是哈希命名的目录一概不碰");
        assert!(data.join("runtime").join(digest).is_dir());
    }

    #[test]
    fn only_full_sha256_strings_are_accepted() {
        assert!(is_full_sha256(&sha256_hex(b"x")));
        assert!(!is_full_sha256(""));
        assert!(!is_full_sha256(&"a".repeat(63)));
        assert!(!is_full_sha256(&"g".repeat(64)));
    }
}
