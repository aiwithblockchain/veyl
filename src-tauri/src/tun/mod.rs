//! TUN 接管与提权协议层。实现已移入 `crates/veyl-tun`，主客户端与 veyl-cli 共用。
//!
//! 保留这个模块名，是为了让 `crate::tun::…` 的既有引用一行不改。

pub use veyl_tun::{backend, cidr, helper_update, privilege, protocol, session};
#[cfg(unix)]
pub use veyl_tun::trust;
#[cfg(target_os = "macos")]
pub use veyl_tun::xpc;
#[cfg(target_os = "windows")]
pub use veyl_tun::windows;

pub use veyl_tun::{
    collect, default_route_goes_through, describe_range, device_is_up, device_name, excludes,
    expected_takeover_ranges, fixed_excludes, host_prefixes, missing_takeover, routes_left,
    subnets, try_collect, wait_until_device_up, LocalAddr, AUTO_ROUTE_BASE_V4, FIXED_EXCLUDES,
    SNIFFERS, SNIFF_TIMEOUT, TUN_ADDRESS, TUN_ADDRESS_MACOS, TUN_ADDRESS_WINDOWS,
    TUN_DNS_STRATEGY, TUN_MTU, TUN_STACK, V4Range,
};
