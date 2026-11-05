//! 日志目录与日期文件名。
//!
//! 同一份源码被两棵模块树引用：
//! - 主程序：`crate::log_paths`；
//! - 特权 helper：`#[path]` 引入（helper 不 `use veyl_lib`）。
//!
//! debug 构建写仓库根的 `logs/`，release 写数据目录；路径由编译期常量决定，
//! 与运行时的 cwd 无关。

use std::path::{Path, PathBuf};

/// 仓库根：`CARGO_MANIFEST_DIR` 是 `src-tauri/`，父目录就是根。
pub fn repository_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("."))
}

/// 目录选择的纯函数版本：单测要同时覆盖 debug 与 release 两条分支。
pub fn resolve_log_dir_for(data_dir: &Path, debug: bool) -> PathBuf {
    if debug {
        repository_root().join("logs")
    } else {
        data_dir.join("logs")
    }
}

/// 当前构建的日志目录。
pub fn resolve_log_dir(data_dir: &Path) -> PathBuf {
    resolve_log_dir_for(data_dir, cfg!(debug_assertions))
}

pub fn today() -> chrono::NaiveDate {
    chrono::Local::now().date_naive()
}

/// `<dir>/<prefix>-YYYY-MM-DD.log`
pub fn dated_log_path(dir: &Path, prefix: &str, date: chrono::NaiveDate) -> PathBuf {
    dir.join(format!("{prefix}-{}.log", date.format("%Y-%m-%d")))
}

/// `<dir>/<prefix>-YYYY-MM-DD.<index>.log`
pub fn rotated_log_path(dir: &Path, prefix: &str, date: chrono::NaiveDate, index: u32) -> PathBuf {
    dir.join(format!("{prefix}-{}.{index}.log", date.format("%Y-%m-%d")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn debug_and_release_pick_different_directories() {
        let data_dir = Path::new("/tmp/veyl-data");
        let debug = resolve_log_dir_for(data_dir, true);
        let release = resolve_log_dir_for(data_dir, false);

        assert_eq!(debug, repository_root().join("logs"));
        assert_eq!(release, data_dir.join("logs"));
        assert_ne!(debug, release);
    }

    #[test]
    fn dated_names_carry_the_prefix_and_date() {
        let dir = Path::new("/tmp/logs");
        let date = chrono::NaiveDate::from_ymd_opt(2026, 11, 5).unwrap();
        assert_eq!(
            dated_log_path(dir, "helper", date),
            PathBuf::from("/tmp/logs/helper-2026-11-05.log")
        );
        assert_eq!(
            rotated_log_path(dir, "sing-box", date, 2),
            PathBuf::from("/tmp/logs/sing-box-2026-11-05.2.log")
        );
    }
}
