//! veyl-cli 自己的平台常量。
//!
//! 两个 APP 可能同时接管网络，地址段不能与主客户端相同（技术设计 §2.3）：
//! 主客户端 macOS 用 `172.19.0.1/30`、Windows 用 `198.18.0.1/15`；
//! 这里错开到 `172.20.0.1/30` 与 `198.20.0.1/16`（不要用 `198.19.x`，
//! 它落在主客户端 /15 的范围内）。

/// macOS 的 TUN 网段。
pub const TUN_ADDRESS_MACOS: &str = "172.20.0.1/30";

/// Windows 的 fakeip 段。
pub const TUN_ADDRESS_WINDOWS: &str = "198.20.0.1/16";

/// TUN 入站的协议栈：全程用户态，不依赖内核 NAT（macOS 上 mixed 会握手不完成）。
pub const TUN_STACK: &str = "gvisor";

/// TUN 设备 MTU。
pub const TUN_MTU: u32 = 9000;

/// Clash API 只监听回环。
pub const CLASH_LISTEN: &str = "127.0.0.1";

/// 本平台使用的 TUN 网段。
pub fn tun_address() -> &'static str {
    if cfg!(windows) {
        TUN_ADDRESS_WINDOWS
    } else {
        TUN_ADDRESS_MACOS
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 两个 APP 同时接管时地址不能撞（技术设计 §2.3）。
    #[test]
    fn ranges_do_not_overlap_the_main_client() {
        assert_ne!(TUN_ADDRESS_MACOS, "172.19.0.1/30");
        assert_ne!(TUN_ADDRESS_WINDOWS, "198.18.0.1/15");
        // 198.19.x 落在主客户端 /15 里。
        assert!(!TUN_ADDRESS_WINDOWS.starts_with("198.19."));
    }
}
