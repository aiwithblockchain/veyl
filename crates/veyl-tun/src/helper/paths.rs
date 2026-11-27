//! 用户数据目录约定（helper 侧）。
//!
//! 目录名是 APP 身份的一部分（`~/.veyl` 与 `~/.veyl-cli` 互不可见），
//! 所以从注入的 [`crate::identity`] 取，而不是写死常量。

use std::path::{Path, PathBuf};

/// 家目录下的数据目录名。
pub fn data_dir_name() -> &'static str {
    crate::identity::data_dir_name()
}

/// 例如 `~/.veyl`。
pub fn data_dir_under(home: &Path) -> PathBuf {
    home.join(data_dir_name())
}

/// helper 与 sing-box 的日志目录。
pub fn helper_logs_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("helper-logs")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_logs_dir_lives_under_the_data_dir() {
        let data = data_dir_under(Path::new("/Users/example"));
        assert!(data.ends_with(data_dir_name()));
        assert!(helper_logs_dir(&data).ends_with("helper-logs"));
    }
}
