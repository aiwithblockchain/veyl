//! TUN 模式的固定参数、内网排除与网段反推。
//!
//! 对应 `docs/tun-mode.md` §3 / §6。这里只做**纯计算**与一次系统接口采样：
//! 生成 sing-box 配置的其余部分仍走 `config::builder`，路由与 DNS 与 proxy 模式共用。

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

pub mod backend;
/// 纯 IPv4 CIDR 计算。源码在 `windows/` 下，但声明放在这里：
/// 服务二进制也 `#[path]` 引用同一份文件，而 macOS 上同样需要它的单元测试。
#[path = "windows/cidr.rs"]
pub mod cidr;
pub mod privilege;
pub mod protocol;
pub mod session;
#[cfg(unix)]
pub mod trust;

#[cfg(target_os = "macos")]
pub mod xpc;

// Windows 的通道是命名管道 + 服务，与 XPC 没有可复用的代码。
// 主程序侧用 `windows::pipe::call`（对端校验在服务端做），
// 服务端在 `src/bin/veyl-service/`。
#[cfg(target_os = "windows")]
pub mod windows;

/// macOS 只接受 `utunN` 形式（或留空让系统分配），固定私有段。
pub const TUN_ADDRESS_MACOS: &str = "172.19.0.1/30";

/// Windows 用 fakeip 段，与 macOS 的 `172.19.0.1/30` **不能互换**。
/// 地址段是本轮的决定，真机效果按 `docs/windows-tun-w3-handover.md` 验证；
/// 在验证通过之前不要把它当成「已实测」。
pub const TUN_ADDRESS_WINDOWS: &str = "198.18.0.1/15";

#[cfg(target_os = "windows")]
pub const TUN_ADDRESS: &str = TUN_ADDRESS_WINDOWS;
#[cfg(not(target_os = "windows"))]
pub const TUN_ADDRESS: &str = TUN_ADDRESS_MACOS;

/// Windows TUN 入站的协议栈。`gvisor` 是纯用户态实现，不依赖系统栈，
/// Windows 上与其它 VPN / 安全软件的共存问题最少；更换前先看交接文档里的实测项。
pub const WINDOWS_TUN_STACK: &str = "gvisor";

/// TUN 模式下 DNS 的地址族策略。
///
/// Windows 的 TUN 只有 IPv4 地址（`198.18.0.1/15`），AAAA 查询交给应用后
/// 要么被 `strict_route` 黑洞、要么绕开隧道，两者都不是我们要的。
/// `ipv4_only` 让 sing-box 直接不返回 AAAA 记录，行为是确定的。
/// macOS 继续用 `prefer_ipv4`（配方见 `docs/tun-windows-notes.md` §5.1）。
#[cfg(target_os = "windows")]
pub const TUN_DNS_STRATEGY: &str = "ipv4_only";
#[cfg(not(target_os = "windows"))]
pub const TUN_DNS_STRATEGY: &str = "prefer_ipv4";

/// TUN 设备是否真的起来了：本机接口里能看到我们固定的 TUN 地址。
///
/// helper 的 start 只做 sing-box check + spawn 就返回，不等 TUN 设备与路由表就绪。
/// 设备出现是「流量真的被接管」的第一手证据；没有它就不能对用户说接管成功。
pub fn device_is_up(addrs: &[LocalAddr]) -> bool {
    device_name(addrs).is_some()
}

/// 带 TUN 地址的接口名（`utunN`）。设备没起来时是 None。
pub fn device_name(addrs: &[LocalAddr]) -> Option<String> {
    let tun_ip = TUN_ADDRESS.split('/').next().unwrap_or(TUN_ADDRESS);
    addrs
        .iter()
        .find(|addr| addr.address.to_string() == tun_ip)
        .map(|addr| addr.name.clone())
}

/// 轮询等 TUN 设备出现，最多等 `timeout`。等到就返回接口名。
pub async fn wait_until_device_up(timeout: std::time::Duration) -> Option<String> {
    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        // `collect()` 会起 `ifconfig`，别占着 async 的执行线程。
        let found = tokio::task::spawn_blocking(|| device_name(&collect()))
            .await
            .unwrap_or(None);
        if found.is_some() {
            return found;
        }
        if tokio::time::Instant::now() >= deadline {
            return None;
        }
        tokio::time::sleep(std::time::Duration::from_millis(150)).await;
    }
}

/// 默认路由是否指向指定的 TUN 接口。
///
/// 设备存在只证明 utun 接口建好了，不证明流量真的被送进去。
/// `proxy_all` 想对用户说「全部接管」，必须有这条路由证据。
pub fn default_route_goes_through(tun_name: &str) -> bool {
    let Ok(output) = crate::netcfg::run("/usr/sbin/netstat", &["-rn", "-f", "inet"]) else {
        return false;
    };
    parse_default_route_interface(&output)
        .map(|iface| iface == tun_name)
        .unwrap_or(false)
}

/// 从 `netstat -rn -f inet` 里取默认路由的接口名。
///
/// macOS 的行长这样：`default  192.168.1.1  UGScg  en0`（少数带 Expire 列）。
pub(crate) fn parse_default_route_interface(output: &str) -> Option<String> {
    output.lines().find_map(|line| {
        let tokens: Vec<&str> = line.split_whitespace().collect();
        if tokens.first() != Some(&"default") || tokens.len() < 4 {
            return None;
        }
        Some(tokens[3].to_string())
    })
}

/// `dns` 必须在列表里，否则 `hijack-dns` 规则不会命中（`tun-mode.md` §3）。
pub const SNIFFERS: [&str; 4] = ["http", "tls", "quic", "dns"];
pub const SNIFF_TIMEOUT: &str = "300ms";

/// 固定排除表。`ip_is_private` 覆盖不到的那几段也在这里，
/// 所以这一张表同时用于路由表排除与确认页展示。
///
/// 这是**平台无关的底表**；Windows 实际使用的表还会去掉覆盖 TUN 自身地址的段，
/// 见 [`fixed_excludes`]。不要在别处再抄一份。
pub const FIXED_EXCLUDES: [&str; 15] = [
    // IPv4 私有段
    "10.0.0.0/8",
    "172.16.0.0/12",
    "192.168.0.0/16",
    "127.0.0.0/8",
    "169.254.0.0/16",
    // `ip_is_private` 不覆盖：
    "100.64.0.0/10", // CGNAT，Tailscale 用这一段
    "198.18.0.0/15", // fakeip
    "224.0.0.0/4",   // 组播
    "255.255.255.255/32",
    // IPv6
    "fc00::/7",
    "fe80::/10",
    "ff00::/8",
    "::1/128",
    // IPv6 里能绕回 IPv4 私网的两种编码，`ip_is_private` 也不覆盖
    "64:ff9b::/96", // NAT64
    "2002::/16",    // 6to4
];

/// 一个网络接口上的地址。由 `collect()` 从系统读，测试里直接构造。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocalAddr {
    pub name: String,
    pub address: IpAddr,
    pub prefix_len: u8,
}

impl LocalAddr {
    pub fn new(name: &str, address: IpAddr, prefix_len: u8) -> Self {
        Self {
            name: name.to_string(),
            address,
            prefix_len,
        }
    }
}

/// 反推本机所在网段，供确认页展示与补充进排除表。
///
/// 只保留**用户真的在用**的网段：跳过回环、链路本地与未指定地址。
/// 不做「是否已被固定表覆盖」的判断——展示要用真实网段，
/// 而重复的 CIDR 对 `route_exclude_address` 无害。
pub fn subnets(addrs: &[LocalAddr]) -> Vec<String> {
    let mut out = Vec::new();
    for addr in addrs {
        if !is_user_subnet(addr) {
            continue;
        }
        let masked = match addr.address {
            IpAddr::V4(v4) => IpAddr::V4(mask_v4(v4, addr.prefix_len)),
            IpAddr::V6(v6) => IpAddr::V6(mask_v6(v6, addr.prefix_len)),
        };
        let entry = format!("{masked}/{}", addr.prefix_len);
        if !out.contains(&entry) {
            out.push(entry);
        }
    }
    out
}

/// 固定表 + 本机反推 + 用户自己补充的网段，按顺序去重。
///
/// 用户补充的排在最后：它们是用户显式要求的，出问题时更容易被看见。
pub fn excludes(local: &[String], user: &[String]) -> Vec<String> {
    let fixed = fixed_excludes();
    let mut out = Vec::with_capacity(fixed.len() + local.len() + user.len());
    for entry in fixed
        .into_iter()
        .chain(local.iter().cloned())
        .chain(user.iter().cloned())
    {
        let entry = entry.trim().to_string();
        if !entry.is_empty() && !out.contains(&entry) {
            out.push(entry);
        }
    }
    out
}

/// 当前平台的固定排除表。
///
/// Windows 的 TUN 地址就在 `198.18.0.0/15` 里，而这一段本来是要排除的 fakeip 段。
/// 留着它，TUN 自己的流量也会被判定为「绕开隧道」；所以按**几何覆盖**把它去掉，
/// 而不是按字面量匹配——用户把段写成 `198.18.0.0/16` 也躲不过。
///
/// macOS 保持不变：那边 TUN 是 `172.19.0.1/30`，固定表里的私有段不参与本轮调整。
pub fn fixed_excludes() -> Vec<String> {
    #[cfg(target_os = "windows")]
    {
        cidr::remove_covering(FIXED_EXCLUDES.iter().copied(), TUN_ADDRESS)
    }
    #[cfg(not(target_os = "windows"))]
    {
        FIXED_EXCLUDES
            .iter()
            .map(|entry| (*entry).to_string())
            .collect()
    }
}

fn is_user_subnet(addr: &LocalAddr) -> bool {
    if addr.prefix_len == 0 {
        return false;
    }
    match addr.address {
        IpAddr::V4(v4) => {
            !v4.is_loopback() && !v4.is_link_local() && !v4.is_unspecified() && !v4.is_broadcast()
        }
        IpAddr::V6(v6) => {
            // fd00::/8 之类的 ULA 是用户内网，要保留；回环与链路本地不要。
            !v6.is_loopback() && !v6.is_unspecified() && !is_v6_link_local(&v6)
        }
    }
}

fn is_v6_link_local(v6: &Ipv6Addr) -> bool {
    (v6.segments()[0] & 0xffc0) == 0xfe80
}

fn mask_v4(addr: Ipv4Addr, prefix: u8) -> Ipv4Addr {
    let prefix = prefix.min(32) as usize;
    let bits = u32::from(addr);
    let mask = if prefix == 0 {
        0
    } else {
        u32::MAX << (32 - prefix)
    };
    Ipv4Addr::from(bits & mask)
}

fn mask_v6(addr: Ipv6Addr, prefix: u8) -> Ipv6Addr {
    let prefix = prefix.min(128) as usize;
    let src = addr.octets();
    let mut out = [0u8; 16];
    let mut remaining = prefix;
    for (index, byte) in out.iter_mut().enumerate() {
        if remaining >= 8 {
            *byte = src[index];
            remaining -= 8;
        } else if remaining > 0 {
            *byte = src[index] & (0xffu8 << (8 - remaining));
            remaining = 0;
        }
    }
    Ipv6Addr::from(out)
}

/// 从系统读一次本机接口地址，只为拿到前缀长度（`netcfg` 那层没有保留 prefix）。
///
/// 读不到就返回空——TUN 仍然可用，只是确认页上少一句「我会绕开你的网段」。
pub fn collect() -> Vec<LocalAddr> {
    try_collect().unwrap_or_default()
}

/// 同 `collect`，但读不到接口时返回错误。
///
/// 「没有 TUN」和「根本没读到接口」必须分开：后者当成前者，
/// 会让复核把未知状态报成已恢复。
pub fn try_collect() -> Result<Vec<LocalAddr>, String> {
    #[cfg(target_os = "macos")]
    {
        let output = crate::netcfg::run("/sbin/ifconfig", &["-a"])?;
        Ok(parse_ifconfig(&output))
    }
    #[cfg(not(target_os = "macos"))]
    {
        Err("当前平台未实现本机接口采集".into())
    }
}

/// 解析 `ifconfig -a`。macOS 的两种写法：
///
/// ```text
/// inet 192.168.1.23 netmask 0xffffff00 broadcast 192.168.1.255
/// inet6 fe80::1c2b:3f4e%en0 prefixlen 64 secured scopeid 0xd
/// ```
pub(crate) fn parse_ifconfig(output: &str) -> Vec<LocalAddr> {
    let mut out = Vec::new();
    let mut iface = String::new();
    for line in output.lines() {
        if !line.starts_with(char::is_whitespace) {
            iface = line
                .split(':')
                .next()
                .unwrap_or_default()
                .trim()
                .to_string();
            continue;
        }
        let line = line.trim();
        if let Some(rest) = line.strip_prefix("inet ") {
            let mut parts = rest.split_whitespace();
            let Some(address) = parts.next() else {
                continue;
            };
            let Ok(address) = address.parse::<Ipv4Addr>() else {
                continue;
            };
            let mut prefix = 32u8;
            let tokens = parts.collect::<Vec<_>>();
            for (index, token) in tokens.iter().enumerate() {
                match *token {
                    "netmask" => {
                        if let Some(value) = tokens.get(index + 1) {
                            prefix = netmask_prefix(value);
                        }
                    }
                    // 新版 ifconfig 偶尔直接给 prefixlen
                    "prefixlen" => {
                        if let Some(value) = tokens.get(index + 1) {
                            prefix = value.parse().unwrap_or(prefix);
                        }
                    }
                    _ => {}
                }
            }
            out.push(LocalAddr::new(&iface, IpAddr::V4(address), prefix));
        } else if let Some(rest) = line.strip_prefix("inet6 ") {
            let mut parts = rest.split_whitespace();
            let Some(address) = parts.next() else {
                continue;
            };
            // 链路本地地址带 `%en0` 作用域后缀
            let address = address.split('%').next().unwrap_or(address);
            let Ok(address) = address.parse::<Ipv6Addr>() else {
                continue;
            };
            let mut prefix = 128u8;
            let tokens = parts.collect::<Vec<_>>();
            for (index, token) in tokens.iter().enumerate() {
                if *token == "prefixlen" {
                    if let Some(value) = tokens.get(index + 1) {
                        prefix = value.parse().unwrap_or(prefix);
                    }
                }
            }
            out.push(LocalAddr::new(&iface, IpAddr::V6(address), prefix));
        }
    }
    out
}

fn netmask_prefix(value: &str) -> u8 {
    if let Some(hex) = value.strip_prefix("0x") {
        let bits = u32::from_str_radix(hex, 16).unwrap_or(0);
        // 0xffffff00 → 24
        return (bits.count_ones().min(32)) as u8;
    }
    if let Ok(v4) = value.parse::<Ipv4Addr>() {
        return u32::from(v4).count_ones() as u8;
    }
    32
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v4(addr: &str) -> IpAddr {
        IpAddr::V4(addr.parse().unwrap())
    }

    #[test]
    fn subnets_mask_the_host_bits() {
        let addrs = vec![LocalAddr::new("en0", v4("192.168.1.23"), 24)];
        assert_eq!(subnets(&addrs), vec!["192.168.1.0/24"]);
    }

    #[test]
    fn subnets_skip_loopback_and_link_local() {
        let addrs = vec![
            LocalAddr::new("lo0", v4("127.0.0.1"), 8),
            LocalAddr::new("en0", v4("169.254.10.1"), 16),
            LocalAddr::new("en0", v4("10.1.2.3"), 8),
        ];
        assert_eq!(subnets(&addrs), vec!["10.0.0.0/8"]);
    }

    #[test]
    fn subnets_dedup_repeated_interfaces() {
        let addrs = vec![
            LocalAddr::new("en0", v4("192.168.1.23"), 24),
            LocalAddr::new("en1", v4("192.168.1.99"), 24),
        ];
        assert_eq!(subnets(&addrs), vec!["192.168.1.0/24"]);
    }

    #[test]
    fn ipv6_ula_is_kept_but_link_local_is_not() {
        let addrs = vec![
            LocalAddr::new("en0", "fd12:3456::1".parse().unwrap(), 64),
            LocalAddr::new("en0", "fe80::1".parse().unwrap(), 64),
            LocalAddr::new("lo0", "::1".parse().unwrap(), 128),
        ];
        assert_eq!(subnets(&addrs), vec!["fd12:3456::/64"]);
    }

    #[test]
    fn excludes_start_with_the_fixed_table_then_user_entries() {
        let local = vec!["192.168.1.0/24".to_string()];
        let user = vec!["172.30.0.0/16".to_string(), " ".to_string()];
        let result = excludes(&local, &user);
        let fixed = fixed_excludes();
        assert_eq!(result.len(), fixed.len() + 2);
        assert_eq!(
            &result[..3],
            &["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"]
        );
        assert_eq!(result[fixed.len()], "192.168.1.0/24");
        assert_eq!(result[fixed.len() + 1], "172.30.0.0/16");
    }

    #[test]
    fn excludes_drop_duplicates_from_user_input() {
        let user = vec!["10.0.0.0/8".to_string()];
        let result = excludes(&[], &user);
        assert_eq!(
            result.len(),
            fixed_excludes().len(),
            "固定表里已有的不再重复"
        );
    }

    /// Windows 的 TUN 地址落在 fakeip 段里：这一段必须从排除表里消失，
    /// 否则 TUN 自己的流量会被判定为「绕开隧道」。
    #[test]
    fn the_windows_fixed_table_drops_the_range_that_holds_its_tun_address() {
        let fixed = cidr::remove_covering(FIXED_EXCLUDES.iter().copied(), TUN_ADDRESS_WINDOWS);
        assert!(!fixed.iter().any(|entry| entry == "198.18.0.0/15"));
        assert!(fixed.iter().any(|entry| entry == "10.0.0.0/8"));
        assert_eq!(fixed.len(), FIXED_EXCLUDES.len() - 1);
        // macOS 的地址段不受影响，固定表保持原样。
        let untouched = cidr::remove_covering(FIXED_EXCLUDES.iter().copied(), TUN_ADDRESS_MACOS);
        assert_eq!(
            untouched.len(),
            FIXED_EXCLUDES.len() - 1,
            "172.16.0.0/12 覆盖 macOS 地址"
        );
    }

    /// Windows 上这条是启动前提：固定表不能排除 TUN 自己的地址。
    /// macOS 的固定表里 `172.16.0.0/12` 覆盖 `172.19.0.1/30`，本轮按决定不动它。
    #[cfg(target_os = "windows")]
    #[test]
    fn the_platform_fixed_table_never_excludes_the_platform_tun_address() {
        let fixed = fixed_excludes();
        assert_eq!(
            cidr::first_covering(fixed.iter().map(String::as_str), TUN_ADDRESS),
            None,
            "固定表不能排除 TUN 自己的地址"
        );
    }

    #[test]
    fn fixed_table_covers_what_ip_is_private_misses() {
        for needle in [
            "100.64.0.0/10",
            "198.18.0.0/15",
            "255.255.255.255/32",
            "64:ff9b::/96",
            "2002::/16",
        ] {
            assert!(
                FIXED_EXCLUDES.contains(&needle),
                "ip_is_private 盖不到的 {needle} 必须显式排除"
            );
        }
    }

    #[test]
    fn sniffers_include_dns_or_hijack_never_fires() {
        assert!(
            SNIFFERS.contains(&"dns"),
            "缺 dns 嗅探，hijack-dns 规则不命中"
        );
    }

    #[test]
    fn parses_macos_ifconfig_output() {
        let output = "\
lo0: flags=8049<UP,LOOPBACK,RUNNING,MULTICAST> mtu 16384
\tinet 127.0.0.1 netmask 0xff000000
\tinet6 ::1 prefixlen 128
en0: flags=8863<UP,BROADCAST,SMART,RUNNING,SIMPLEX,MULTICAST> mtu 1500
\tinet 192.168.1.23 netmask 0xffffff00 broadcast 192.168.1.255
\tinet6 fe80::1c2b:3f4e%en0 prefixlen 64 secured scopeid 0xd
\tinet6 2408:8207:1234::5 prefixlen 64 autoconf secured
";
        let parsed = parse_ifconfig(output);
        assert_eq!(parsed.len(), 5);
        assert_eq!(
            parsed[1],
            LocalAddr::new("lo0", "::1".parse().unwrap(), 128)
        );
        assert_eq!(parsed[2], LocalAddr::new("en0", v4("192.168.1.23"), 24));
        assert_eq!(
            parsed[3],
            LocalAddr::new("en0", "fe80::1c2b:3f4e".parse().unwrap(), 64)
        );
        assert_eq!(
            parsed[4],
            LocalAddr::new("en0", "2408:8207:1234::5".parse().unwrap(), 64)
        );

        let derived = subnets(&parsed);
        assert_eq!(derived, vec!["192.168.1.0/24", "2408:8207:1234::/64"]);
    }

    #[test]
    fn netmask_prefix_handles_hex_and_dotted_forms() {
        assert_eq!(netmask_prefix("0xffffff00"), 24);
        assert_eq!(netmask_prefix("0xff000000"), 8);
        assert_eq!(netmask_prefix("255.255.255.0"), 24);
        assert_eq!(netmask_prefix("garbage"), 32);
    }

    #[test]
    fn mask_v6_keeps_only_the_prefix() {
        let addr: Ipv6Addr = "2001:db8:abcd:1234:5678::1".parse().unwrap();
        assert_eq!(mask_v6(addr, 64).to_string(), "2001:db8:abcd:1234::");
        assert_eq!(mask_v6(addr, 32).to_string(), "2001:db8::");
        assert_eq!(mask_v6(addr, 0).to_string(), "::");
    }

    #[test]
    fn the_tun_device_is_found_by_its_fixed_address() {
        let addrs = vec![
            LocalAddr::new("en0", v4("192.168.1.23"), 24),
            LocalAddr::new("utun6", v4("172.19.0.1"), 30),
        ];
        assert_eq!(device_name(&addrs).as_deref(), Some("utun6"));
        assert!(device_is_up(&addrs));

        let without_tun = vec![LocalAddr::new("en0", v4("192.168.1.23"), 24)];
        assert_eq!(device_name(&without_tun), None);
        assert!(!device_is_up(&without_tun));
    }

    #[test]
    fn the_default_route_interface_is_read_from_netstat() {
        let output = "\
Routing tables

Internet:
Destination        Gateway            Flags        Netif Expire
default            192.168.1.1        UGScg          en0
10/8               link#4             UCSIg          en0
";
        assert_eq!(
            parse_default_route_interface(output).as_deref(),
            Some("en0")
        );
    }

    #[test]
    fn a_default_route_on_the_tun_interface_is_recognised() {
        let output = "default            link#20            UGScIg         utun6\n";
        assert_eq!(
            parse_default_route_interface(output).as_deref(),
            Some("utun6")
        );
    }

    #[test]
    fn a_missing_default_route_is_not_mistaken_for_one() {
        let output =
            "Destination        Gateway            Flags        Netif\n10/8  link#4  UCSIg  en0\n";
        assert_eq!(parse_default_route_interface(output), None);
    }
}
