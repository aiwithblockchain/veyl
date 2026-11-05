//! Windows 特权服务 `veyl-service.exe`。
//!
//! 形态与 macOS 的 `veyl-helper` 对应：界面进程永远普通用户，只有这个
//! LocalSystem 服务做特权操作。本轮只实现服务骨架、命名管道与对端认证；
//! sing-box 的实际拉起与安装器在后续阶段。
//!
//! 开发用法（管理员）：
//!   veyl-service --console        前台跑管道，Ctrl+C 退出
//!   veyl-service --client ping    普通用户即可，验证对端认证与协议
//!
//! 正式用法：由 SCM 以 LocalSystem 启动（不带参数）。

#[cfg(windows)]
mod server;
#[cfg(windows)]
mod service;

#[cfg(windows)]
// 这份模块是客户端与服务端共用的：服务二进制只用到服务端那一半，
// release 下 `--client` 被移除后客户端函数在本 bin 里没有调用点。
#[allow(dead_code)]
#[path = "../../tun/windows/mod.rs"]
mod win;

// 只读引用 `tun/protocol.rs`：allowlist 与 macOS 共用同一份实现。
// 其中 macOS 专属的常量/函数在这个 bin 里用不到，不必逐条报死代码。
#[cfg(windows)]
#[allow(dead_code)]
#[path = "../../tun/protocol.rs"]
mod protocol;

pub fn main() {
    #[cfg(windows)]
    {
        service::main();
    }

    #[cfg(not(windows))]
    {
        eprintln!("veyl-service: 这个平台没有 Windows 特权服务");
        std::process::exit(3);
    }
}
