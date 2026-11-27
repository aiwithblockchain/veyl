//! Windows 特权服务 `veyl-service.exe`。
//!
//! 形态与 macOS 的 `veyl-helper` 对应：界面进程永远普通用户，只有这个
//! LocalSystem 服务做特权操作。W1–W2 是服务骨架、命名管道与对端认证；
//! W3 起由它 staging 运行时、拉起与回收 sing-box。安装器仍归 W5。
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

// 纯 IPv4 CIDR 计算与协议层都来自共享 crate，不再 `#[path]` 内联源码。
#[cfg(windows)]
#[allow(unused_imports)]
pub(crate) use veyl_tun::cidr;
#[cfg(windows)]
#[allow(unused_imports)]
pub(crate) use veyl_tun::protocol;
// 命名管道 + 服务的实现：客户端与服务端共用一份。
#[cfg(windows)]
#[allow(unused_imports)]
pub(crate) use veyl_tun::windows as win;

// 身份参数：与主程序、helper 共用同一份组装逻辑（每个二进制各自注入一次）。
#[cfg(windows)]
#[path = "../../tun_identity.rs"]
mod tun_identity;

pub fn main() {
    #[cfg(windows)]
    {
        tun_identity::install();
        service::main();
    }

    #[cfg(not(windows))]
    {
        eprintln!("veyl-service: 这个平台没有 Windows 特权服务");
        std::process::exit(3);
    }
}
