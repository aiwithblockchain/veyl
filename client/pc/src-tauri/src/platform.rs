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

/// TUN 入站宣告给系统的 DNS 地址。**必须落在本平台网段内**：服务端模板里的
/// `dns_address` 属于它自己的网段，照抄会指向一个不在隧道里的地址，表现是
/// 「连上了但域名解析不了」。
pub fn dns_address() -> &'static str {
    if cfg!(windows) {
        "198.20.0.2"
    } else {
        "172.20.0.2"
    }
}

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

    /// 宣告的 DNS 地址必须落在自己的网段里，否则域名解析会指向隧道外。
    #[test]
    fn the_announced_dns_address_lives_inside_our_range() {
        let (network, prefix) = TUN_ADDRESS_MACOS.split_once('/').unwrap();
        let octets: Vec<u32> = network.split('.').map(|part| part.parse().unwrap()).collect();
        let dns: Vec<u32> = dns_address().split('.').map(|part| part.parse().unwrap()).collect();
        assert_eq!(&octets[..3], &dns[..3]);
        assert_eq!(prefix, "30");
        assert!(dns[3] <= 3, "172.20.0.0/30 只有 .0–.3");
    }
}
