//! 代理看门狗：App 异常退出后自动还原系统代理。
//!
//! 由用户级 LaunchAgent（`com.veyl.proxyguard`）在登录时 / 租约变化时拉起。
//! 存活判据是 `flock(proxy-lease.lock)`：App 活着就独占，进程一死内核立刻释放，
//! 不依赖 pid，也不做心跳。判定与还原复用 App 的同一份源码：
//! `proxy/{lease,recovery,guard,macos_wire}.rs` 用 `#[path]` 引入，**不链 Tauri**。
//!
//! 其它平台编译成空壳：看门狗目前只有 macOS 有等价物（设计稿 §7.6）。

#[cfg(target_os = "macos")]
#[path = "../../proxy/lease.rs"]
#[allow(dead_code)]
mod lease;
#[cfg(target_os = "macos")]
#[path = "../../proxy/recovery.rs"]
#[allow(dead_code)]
mod recovery;
#[cfg(target_os = "macos")]
#[path = "../../proxy/guard.rs"]
#[allow(dead_code)]
mod guard;
#[cfg(target_os = "macos")]
#[path = "../../proxy/macos_wire.rs"]
#[allow(dead_code)]
mod macos_wire;
#[cfg(target_os = "macos")]
#[path = "../../veyl_paths.rs"]
#[allow(dead_code)]
mod veyl_paths;
#[cfg(target_os = "macos")]
mod run;

fn main() {
    #[cfg(target_os = "macos")]
    {
        run::run();
    }

    #[cfg(not(target_os = "macos"))]
    {
        eprintln!("veyl-proxy-guard: 这个平台还没有代理看门狗");
        std::process::exit(2);
    }
}
