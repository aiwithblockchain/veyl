//! 用户数据目录约定。app 与特权 helper 共用。
//!
//! helper 不 `use veyl_lib`，用 `#[path]` 引入本文件；这里只放纯路径计算，
//! 不依赖任何 crate 内模块。

use std::path::{Path, PathBuf};

/// 用户数据目录名（家目录下）。
pub const DATA_DIR_NAME: &str = ".veyl";

/// `~/.veyl`
pub fn data_dir_under(home: &Path) -> PathBuf {
    home.join(DATA_DIR_NAME)
}

/// `~/.veyl/helper-logs`：helper 与 sing-box 的日志（两种构建都写）。
pub fn helper_logs_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("helper-logs")
}

/// `~/.veyl/logs`：用户级后台组件（代理看门狗）的 stdout/stderr。
pub fn proxy_logs_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("logs")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_data_dir_lives_under_the_home_directory() {
        let home = Path::new("/Users/example");
        assert_eq!(data_dir_under(home), PathBuf::from("/Users/example/.veyl"));
        assert_eq!(
            helper_logs_dir(&data_dir_under(home)),
            PathBuf::from("/Users/example/.veyl/helper-logs")
        );
    }
}
