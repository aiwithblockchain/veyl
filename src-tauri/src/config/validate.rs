use std::path::{Path, PathBuf};

use serde_json::Value;

use crate::runtime::error::{IoContext, RuntimeError, RuntimeResult};
use crate::runtime::fsutil;

/// 用目标二进制自带的 `check` 校验配置，避免我们自己猜字段名。
pub async fn check(binary: &Path, config: &Path) -> RuntimeResult<()> {
    let output = tokio::process::Command::new(binary)
        .arg("check")
        .arg("-c")
        .arg(config)
        .output()
        .await
        .map_err(|e| {
            RuntimeError::Process(format!(
                "failed to run {} check: {e}",
                binary.display()
            ))
        })?;

    if output.status.success() {
        return Ok(());
    }

    let mut detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if detail.is_empty() {
        detail = String::from_utf8_lossy(&output.stdout).trim().to_string();
    }
    Err(RuntimeError::ConfigInvalid(truncate(&detail, 2000)))
}

/// 写入临时文件（0600）→ `sing-box check` → 通过后原子替换成 active 配置。
pub async fn install(
    binary: &Path,
    config_dir: &Path,
    value: &Value,
) -> RuntimeResult<PathBuf> {
    fsutil::ensure_dir(config_dir)?;
    let tmp_dir = config_dir.join("tmp");
    fsutil::ensure_dir(&tmp_dir)?;
    let tmp = tmp_dir.join(format!("config-{:016x}.json", rand::random::<u64>()));

    let bytes = serde_json::to_vec_pretty(value)
        .map_err(|e| RuntimeError::Config(format!("serialize config: {e}")))?;
    fsutil::write_atomic(&tmp, &bytes)?;

    if let Err(e) = check(binary, &tmp).await {
        let _ = std::fs::remove_file(&tmp);
        return Err(e);
    }

    let active = config_dir.join("active.json");
    std::fs::rename(&tmp, &active).io_ctx(&active)?;
    fsutil::set_private(&active)?;
    Ok(active)
}


/// 删除某个 profile 的明文渲染配置与元数据；幂等。
///
/// 这些文件含凭据，只应存在于连接期间。
pub fn remove_profile_config(config_dir: &Path, profile_id: &str) {
    for name in [
        format!("profile-{profile_id}.json"),
        format!("profile-{profile_id}.meta.json"),
    ] {
        let path = config_dir.join(name);
        match std::fs::remove_file(&path) {
            Ok(()) => log::info!("active_config removed path={}", path.display()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => log::warn!("删除配置文件失败 {}：{error}", path.display()),
        }
    }
}

/// 清空所有 profile 渲染配置与元数据。
///
/// 每次连接都会重新渲染，所以启动与退出时可以整体清掉——它们都含明文凭据，
/// 不能留在磁盘上等下一次连接。
pub fn remove_all_profile_configs(config_dir: &Path) -> usize {
    let Ok(entries) = std::fs::read_dir(config_dir) else {
        return 0;
    };
    let mut removed = 0;
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        if !name.starts_with("profile-") || !name.ends_with(".json") {
            continue;
        }
        match std::fs::remove_file(&path) {
            Ok(()) => {
                removed += 1;
                log::info!("active_config removed path={}", path.display());
            }
            Err(error) => log::warn!("删除配置文件失败 {}：{error}", path.display()),
        }
    }
    removed
}

/// 按 profile 落盘**完整**配置（含凭据），权限 0600。
/// SQLite 里永远不存凭据，完整配置只在这类磁盘文件里。
pub async fn install_profile(
    binary: &Path,
    config_dir: &Path,
    profile_id: &str,
    value: &Value,
    etag: Option<&str>,
) -> RuntimeResult<PathBuf> {
    // 这里会落明文凭据，目录用 0700。
    fsutil::ensure_private_dir(config_dir)?;
    let final_path = config_dir.join(format!("profile-{profile_id}.json"));

    let bytes = serde_json::to_vec_pretty(value)
        .map_err(|e| RuntimeError::Config(format!("serialize config: {e}")))?;
    fsutil::write_atomic(&final_path, &bytes)?;

    if let Err(error) = check(binary, &final_path).await {
        let _ = std::fs::remove_file(&final_path);
        log::info!("active_config removed path={} reason=check_failed", final_path.display());
        return Err(error);
    }
    fsutil::set_private(&final_path)?;
    // 只打路径与权限，绝不打内容。
    log::info!(
        "active_config path={} mode=0600",
        final_path.display()
    );

    let meta = serde_json::json!({
        "schema": 1,
        "profile_id": profile_id,
        "etag": etag,
        "written_at": chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
    });
    fsutil::write_atomic_json(&config_dir.join(format!("profile-{profile_id}.meta.json")), &meta)?;

    Ok(final_path)
}

fn truncate(text: &str, limit: usize) -> String {
    if text.chars().count() <= limit {
        return text.to_string();
    }
    text.chars().take(limit).collect::<String>() + "…"
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn removes_only_the_given_profiles_rendered_files() {
        let dir = std::env::temp_dir().join(format!("veyl-cfg-{:016x}", rand::random::<u64>()));
        fsutil::ensure_dir(&dir).unwrap();
        fsutil::write_atomic(&dir.join("profile-a.json"), b"{}").unwrap();
        fsutil::write_atomic(&dir.join("profile-a.meta.json"), b"{}").unwrap();
        fsutil::write_atomic(&dir.join("profile-b.json"), b"{}").unwrap();
        fsutil::write_atomic(&dir.join("notes.txt"), b"x").unwrap();

        remove_profile_config(&dir, "a");

        assert!(!dir.join("profile-a.json").exists());
        assert!(!dir.join("profile-a.meta.json").exists());
        assert!(dir.join("profile-b.json").exists(), "不能误删其它 profile");
        assert!(dir.join("notes.txt").exists(), "不能误删非配置文件");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn removing_all_rendered_configs_keeps_unrelated_files() {
        let dir = std::env::temp_dir().join(format!("veyl-cfg-{:016x}", rand::random::<u64>()));
        fsutil::ensure_dir(&dir).unwrap();
        fsutil::write_atomic(&dir.join("profile-a.json"), b"{}").unwrap();
        fsutil::write_atomic(&dir.join("profile-b.meta.json"), b"{}").unwrap();
        fsutil::write_atomic(&dir.join("keep.txt"), b"x").unwrap();

        assert_eq!(remove_all_profile_configs(&dir), 2);

        assert!(!dir.join("profile-a.json").exists());
        assert!(!dir.join("profile-b.meta.json").exists());
        assert!(dir.join("keep.txt").exists());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn check_fails_for_an_invalid_binary() {
        let dir = std::env::temp_dir().join(format!("aivpn-cfg-{:016x}", rand::random::<u64>()));
        fsutil::ensure_dir(&dir).unwrap();
        let config = dir.join("c.json");
        fsutil::write_atomic(&config, b"{}").unwrap();
        let err = check(Path::new("/nonexistent/sing-box"), &config)
            .await
            .unwrap_err();
        assert!(matches!(err, RuntimeError::Process(_)));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn truncate_keeps_short_text() {
        assert_eq!(truncate("abc", 10), "abc");
        assert_eq!(truncate("abcdef", 3), "abc…");
    }
}
