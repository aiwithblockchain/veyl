//! 内核校验：`sing-box check -c <file>`（§3.2 的第二道门）。
//!
//! 本轮不打包内核，所以「找不到内核」是一个明确的第三种结果，界面要写
//! 「未做内核校验」——**不能当作通过**，也不能因此拒绝导入。

use std::path::{Path, PathBuf};
use std::time::Duration;

const BINARY_NAME: &str = if cfg!(windows) {
    "sing-box.exe"
} else {
    "sing-box"
};
const TIMEOUT: Duration = Duration::from_secs(10);
/// 内核错误只保留开头这些字符，够定位即可。
const MAX_ERROR_CHARS: usize = 400;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum KernelCheck {
    Passed,
    Failed(String),
    Unavailable,
}

/// 内核路径：先用 `VEYL_CLI_SING_BOX` 指定，再看应用目录下的 `bin/`。
pub fn find_binary(data_dir: &Path) -> Option<PathBuf> {
    if let Some(path) = std::env::var_os("VEYL_CLI_SING_BOX") {
        let path = PathBuf::from(path);
        if path.is_file() {
            return Some(path);
        }
    }
    let bundled = data_dir.join("bin").join(BINARY_NAME);
    bundled.is_file().then_some(bundled)
}

pub async fn check(data_dir: &Path, config: &Path) -> KernelCheck {
    match find_binary(data_dir) {
        Some(binary) => run(&binary, config).await,
        None => KernelCheck::Unavailable,
    }
}

pub async fn run(binary: &Path, config: &Path) -> KernelCheck {
    let mut command = tokio::process::Command::new(binary);
    command.arg("check").arg("-c").arg(config);
    command.kill_on_drop(true);

    match tokio::time::timeout(TIMEOUT, command.output()).await {
        Err(_) => KernelCheck::Failed("内核校验超时（10 秒）".to_string()),
        Ok(Err(error)) => KernelCheck::Failed(format!("无法运行内核：{error}")),
        Ok(Ok(output)) if output.status.success() => KernelCheck::Passed,
        Ok(Ok(output)) => {
            let mut text = String::from_utf8_lossy(&output.stderr).trim().to_string();
            if text.is_empty() {
                text = String::from_utf8_lossy(&output.stdout).trim().to_string();
            }
            if text.is_empty() {
                text = format!("内核退出码 {}", output.status);
            }
            KernelCheck::Failed(text.chars().take(MAX_ERROR_CHARS).collect())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn missing_binary_is_unavailable_not_passed() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(find_binary(dir.path()), None);
    }

    #[tokio::test]
    async fn unavailable_when_the_directory_has_no_kernel() {
        let dir = tempfile::tempdir().unwrap();
        let config = dir.path().join("runtime.json");
        std::fs::write(&config, "{}").unwrap();
        assert_eq!(check(dir.path(), &config).await, KernelCheck::Unavailable);
    }

    #[cfg(unix)]
    fn fake_kernel(dir: &Path, script: &str) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let bin = dir.join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        let path = bin.join(BINARY_NAME);
        let mut file = std::fs::File::create(&path).unwrap();
        file.write_all(format!("#!/bin/sh\n{script}\n").as_bytes())
            .unwrap();
        drop(file);
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        path
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_successful_check_passes() {
        let dir = tempfile::tempdir().unwrap();
        fake_kernel(dir.path(), "exit 0");
        let config = dir.path().join("runtime.json");
        std::fs::write(&config, "{}").unwrap();
        assert_eq!(check(dir.path(), &config).await, KernelCheck::Passed);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_kernel_error_is_reported_verbatim() {
        let dir = tempfile::tempdir().unwrap();
        fake_kernel(dir.path(), "echo 'FATAL bad tun address' >&2; exit 1");
        let config = dir.path().join("runtime.json");
        std::fs::write(&config, "{}").unwrap();
        match check(dir.path(), &config).await {
            KernelCheck::Failed(message) => assert!(message.contains("bad tun address")),
            other => panic!("期望失败，拿到 {other:?}"),
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn the_binary_gets_check_and_the_config_path() {
        let dir = tempfile::tempdir().unwrap();
        let marker = dir.path().join("args.txt");
        fake_kernel(
            dir.path(),
            &format!("printf '%s' \"$*\" > '{}'", marker.display()),
        );
        let config = dir.path().join("runtime.json");
        std::fs::write(&config, "{}").unwrap();
        check(dir.path(), &config).await;
        let args = std::fs::read_to_string(&marker).unwrap();
        assert!(args.contains("check"), "{args}");
        assert!(args.contains("-c"), "{args}");
        assert!(args.contains("runtime.json"), "{args}");
    }
}
