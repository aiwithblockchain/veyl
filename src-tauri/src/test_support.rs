//! 测试共用的小工具。

use std::sync::OnceLock;

/// 整个测试进程只安装一次本机凭据存储（`secrets.enc`）。
pub fn install_test_secrets() {
    static ONCE: OnceLock<()> = OnceLock::new();
    ONCE.get_or_init(|| {
        let dir = std::env::temp_dir().join("veyl-test-secrets");
        let _ = std::fs::create_dir_all(&dir);
        crate::secrets::install(&dir);
    });
}
