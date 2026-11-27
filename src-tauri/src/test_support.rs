//! 测试共用的小工具。

use std::sync::OnceLock;

/// 进程环境变量是全局共享状态：并行测试里 `set_var` / `getenv` 并发是未定义行为。
/// 任何要改环境变量的测试都必须先拿这把锁（`rules/mod.rs` 的归档路径）。
/// 能不改进程环境的就不要改：只给子进程用的变量用 `Command::env`。
pub static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// 鉴权状态测试的串行闸门。
///
/// 令牌、设备身份与账户标记读写的是**进程级共享**的 secrets（`secrets.enc`）
/// 与全局库（`store::global()`）。两个测试并发写会互相覆盖，通过与失败取决于
/// 调度顺序——整套连跑三遍可能给出三个不同数字。所以任何调用
/// `store_tokens` / `clear_tokens` / `stored_account_marker` / `forget_account` /
/// `logout_failure`（或直接读写 `TOKENS_KEY` / `DEVICE_KEY`）的测试都必须先拿
/// 这把锁；只有读的断言也一样要用，否则读到的是别人写了一半的状态。
pub static AUTH_STATE_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// 整个测试进程只安装一次本机凭据存储（`secrets.enc`）。
pub fn install_test_secrets() {
    static ONCE: OnceLock<()> = OnceLock::new();
    ONCE.get_or_init(|| {
        // 目录必须带进程号：多个会话/多个测试进程会**同时**跑整套，共享同一个
        // 目录时各自的 `secrets.enc` 互相覆盖，测试结果取决于谁最后写。
        let dir = std::env::temp_dir().join(format!("veyl-test-secrets-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        crate::secrets::install(&dir);
    });
}
