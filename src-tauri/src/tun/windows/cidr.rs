//! IPv4 CIDR 的纯计算：排除网段是否覆盖了 TUN 自己的地址。
//!
//! 同一份源码被两棵模块树以 `#[path]` 引用：
//! - 主程序：`tun/mod.rs` 声明成 `tun::cidr`；
//! - 服务二进制：`bin/veyl-service/main.rs` 声明成 `crate::cidr`。
//!
//! **不放在 `tun/windows/mod.rs`**：那份文件已经被服务二进制整份引入，
//! 在里面再声明一次会让主程序把同一份源码编两遍。这里没有 Windows API，
//! 因此 macOS 上也能跑这些单元测试。

use std::net::Ipv4Addr;

/// `"198.18.0.0/15"` → `(网络地址, 前缀长度)`；不带前缀的裸 IPv4 按 `/32`。
/// IPv6、非法前缀、越界前缀都是 None。
///
/// 裸 IP 必须解析成 `/32`：sing-box 的 Listable 字段接受单个字符串，
/// 调用方（尤其是配置校验）不能因为写法不同就漏判。
pub fn parse(value: &str) -> Option<(u32, u8)> {
    let value = value.trim();
    let (address, prefix) = match value.split_once('/') {
        Some((address, prefix)) => (address, prefix.trim().parse::<u8>().ok()?),
        None => (value, 32),
    };
    let address: Ipv4Addr = address.trim().parse().ok()?;
    if prefix > 32 {
        return None;
    }
    Some((u32::from(address), prefix))
}

/// `cidr` 是否包含 `address`。解析不了（含 IPv6 条目）时返回 None，
/// 调用方不要把 None 当成 false——那等于静默放行。
pub fn contains(cidr: &str, address: Ipv4Addr) -> Option<bool> {
    let (network, prefix) = parse(cidr)?;
    let mask = if prefix == 0 {
        0
    } else {
        u32::MAX << (32 - prefix)
    };
    Some(u32::from(address) & mask == network & mask)
}

/// TUN 地址里的那一段 IP。`"198.18.0.1/15"` → `198.18.0.1`。
pub fn address_of(tun_address: &str) -> Option<Ipv4Addr> {
    tun_address.split('/').next()?.trim().parse().ok()
}

fn covers(entry: &str, tun_address: &str) -> bool {
    let Some(address) = address_of(tun_address) else {
        return false;
    };
    contains(entry, address).unwrap_or(false)
}

/// 第一个覆盖 TUN 地址的条目。启动校验用它点名是哪一个网段。
pub fn first_covering<'a, I>(entries: I, tun_address: &str) -> Option<String>
where
    I: IntoIterator<Item = &'a str>,
{
    entries
        .into_iter()
        .find(|entry| covers(entry, tun_address))
        .map(str::to_string)
}

/// 去掉覆盖 TUN 地址的条目。
///
/// 判据是几何关系（CIDR 覆盖），不是字面量比较：换地址段、或用户把
/// 段写成 `198.18.0.0/16`，都不会漏。
pub fn remove_covering<'a, I>(entries: I, tun_address: &str) -> Vec<String>
where
    I: IntoIterator<Item = &'a str>,
{
    entries
        .into_iter()
        .filter(|entry| !covers(entry, tun_address))
        .map(str::to_string)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    const WINDOWS_TUN: &str = "198.18.0.1/15";
    const MACOS_TUN: &str = "172.19.0.1/30";

    #[test]
    fn a_prefix_covers_its_own_network() {
        assert_eq!(
            contains("198.18.0.0/15", "198.18.0.1".parse().unwrap()),
            Some(true)
        );
        assert_eq!(
            contains("198.18.0.0/15", "198.19.255.254".parse().unwrap()),
            Some(true)
        );
        assert_eq!(
            contains("198.18.0.0/15", "198.20.0.1".parse().unwrap()), // secret-scan:allow 测试边界常量：紧邻 198.18/15 之外的地址
            Some(false)
        );
        assert_eq!(
            contains("10.0.0.0/8", "198.18.0.1".parse().unwrap()),
            Some(false)
        );
    }

    #[test]
    fn host_bits_in_the_network_field_do_not_change_the_match() {
        assert_eq!(
            contains("198.18.0.5/15", "198.18.7.7".parse().unwrap()),
            Some(true)
        );
    }

    #[test]
    fn zero_and_full_prefixes_are_boundaries() {
        assert_eq!(
            contains("0.0.0.0/0", "1.2.3.4".parse().unwrap()), // secret-scan:allow 测试常量：0.0.0.0/0 的匹配边界
            Some(true)
        );
        assert_eq!(
            contains("198.18.0.1/32", "198.18.0.1".parse().unwrap()),
            Some(true)
        );
        assert_eq!(
            contains("198.18.0.1/32", "198.18.0.2".parse().unwrap()),
            Some(false)
        );
    }

    #[test]
    fn ipv6_and_malformed_entries_are_not_judged() {
        assert_eq!(contains("fc00::/7", "198.18.0.1".parse().unwrap()), None);
        assert_eq!(contains("198.18.0.0/", "198.18.0.1".parse().unwrap()), None);
        assert_eq!(
            contains("198.18.0.0/33", "198.18.0.1".parse().unwrap()),
            None
        );
        assert_eq!(contains("garbage/8", "198.18.0.1".parse().unwrap()), None);
    }

    /// sing-box 的 Listable 字段接受裸 IP；按 /32 处理，不能漏判。
    #[test]
    fn a_bare_ipv4_counts_as_a_host_route() {
        let host: Ipv4Addr = "198.18.0.1".parse().unwrap();
        assert_eq!(parse("198.18.0.1"), Some((u32::from(host), 32)));
        assert_eq!(contains("198.18.0.1", host), Some(true));
        assert_eq!(
            contains("198.18.0.1", "198.18.0.2".parse().unwrap()),
            Some(false)
        );
        assert_eq!(
            first_covering(["198.18.0.1"], "198.18.0.1/15").as_deref(),
            Some("198.18.0.1")
        );
        assert_eq!(
            first_covering([" 198.18.0.1 "], "198.18.0.1/15").as_deref(),
            Some(" 198.18.0.1 "),
            "首尾空白不影响判定"
        );
    }

    #[test]
    fn the_windows_tun_address_drops_the_fakeip_exclusion() {
        let entries = ["10.0.0.0/8", "198.18.0.0/15", "224.0.0.0/4", "fc00::/7"];
        let kept = remove_covering(entries, WINDOWS_TUN);
        assert_eq!(kept, vec!["10.0.0.0/8", "224.0.0.0/4", "fc00::/7"]);
        assert_eq!(
            first_covering(entries, WINDOWS_TUN).as_deref(),
            Some("198.18.0.0/15")
        );
    }

    #[test]
    fn a_user_entry_that_covers_the_tun_address_is_reported_by_name() {
        let entries = ["10.0.0.0/8".to_string(), "198.18.0.0/16".to_string()];
        assert_eq!(
            first_covering(entries.iter().map(String::as_str), WINDOWS_TUN).as_deref(),
            Some("198.18.0.0/16")
        );
        assert_eq!(
            first_covering(entries.iter().map(String::as_str), MACOS_TUN),
            None
        );
    }

    #[test]
    fn a_macos_tun_address_is_not_affected_by_the_windows_range() {
        assert_eq!(first_covering(["198.18.0.0/15"], MACOS_TUN), None);
        assert_eq!(
            first_covering(["172.16.0.0/12"], MACOS_TUN).as_deref(),
            Some("172.16.0.0/12")
        );
    }
}
