//! 测试共用的小工具。

use std::sync::OnceLock;

/// 进程环境变量是全局共享状态：并行测试里 `set_var` / `getenv` 并发是未定义行为。
/// 任何要改环境变量的测试都必须先拿这把锁（`rules/mod.rs` 的归档路径）。
/// 能不改进程环境的就不要改：只给子进程用的变量用 `Command::env`。
pub static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// 整个测试进程只安装一次本机凭据存储（`secrets.enc`）。
pub fn install_test_secrets() {
    static ONCE: OnceLock<()> = OnceLock::new();
    ONCE.get_or_init(|| {
        let dir = std::env::temp_dir().join("veyl-test-secrets");
        let _ = std::fs::create_dir_all(&dir);
        crate::secrets::install(&dir);
    });
}
