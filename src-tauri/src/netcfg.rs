//! 系统网络只读视图与受限修复动作（NetConfigGet / NetRepair 的底层）。
//!
//! 只返回本机信息：不列外网监听、不读 MAC / DHCP / SSID，日志里也不打印地址。

use serde::Serialize;

pub const DNS_PROBE_DOMAIN: &str = "platform.deepseek.com";

#[derive(Debug, Clone, Serialize)]
pub struct ProxyEntry {
    pub enabled: bool,
    pub server: Option<String>,
    pub port: Option<u16>,
}

impl Default for ProxyEntry {
    fn default() -> Self {
        Self {
            enabled: false,
            server: None,
            port: None,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct ServiceProxies {
    pub service: String,
    pub http: ProxyEntry,
    pub https: ProxyEntry,
    pub socks: ProxyEntry,
}

#[derive(Debug, Clone, Serialize)]
pub struct DnsInfo {
    pub servers: Vec<String>,
    pub probe_domain: String,
    pub resolvable: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct RouteInfo {
    pub default_interface: Option<String>,
    pub default_gateway: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct InterfaceInfo {
    pub name: String,
    pub addresses: Vec<String>,
    pub up: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct ListenerInfo {
    pub port: u16,
    pub loopback_only: bool,
    pub process: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct NetConfig {
    pub platform: String,
    pub proxies: Vec<ServiceProxies>,
    pub dns: DnsInfo,
    pub route: RouteInfo,
    pub interfaces: Vec<InterfaceInfo>,
    pub listeners: Vec<ListenerInfo>,
}

pub fn platform_name() -> &'static str {
    if cfg!(target_os = "macos") {
        "darwin"
    } else if cfg!(windows) {
        "windows"
    } else {
        "linux"
    }
}

/// 读取本机网络配置。Windows/Linux 的逐服务代理暂未实现，返回 UNSUPPORTED。
pub fn read() -> Result<NetConfig, String> {
    #[cfg(target_os = "macos")]
    {
        macos::read()
    }
    #[cfg(not(target_os = "macos"))]
    {
        Err("UNSUPPORTED: 当前平台暂未实现系统网络读取".into())
    }
}

/// 本机能否解析探针域名。
pub fn dns_resolvable() -> bool {
    use std::net::ToSocketAddrs;
    (DNS_PROBE_DOMAIN, 443)
        .to_socket_addrs()
        .map(|mut addrs| addrs.next().is_some())
        .unwrap_or(false)
}

/// `scutil --dns` 里配置的全部 nameserver（去重）。
///
/// 强制重置读它来点名残留解析器；读不到就是错误，不能当成「没有残留」。
pub fn dns_servers() -> Result<Vec<String>, String> {
    #[cfg(target_os = "macos")]
    {
        let output = run("/usr/sbin/scutil", &["--dns"])?;
        Ok(parse_dns_servers(&output))
    }
    #[cfg(not(target_os = "macos"))]
    {
        Err("当前平台未实现 DNS 解析器读取".into())
    }
}

/// 指向本机回环、TUN 地址或 fakeip 段的解析器。
///
/// 这些**可能**是 Veyl 的残留，也可能是用户自建的本地 DNS（AdGuard 等）。
/// 这里只负责点名；是否真的坏了交给解析探测判断，不按地址预设罪名。
pub fn suspicious_dns_servers() -> Result<Vec<String>, String> {
    Ok(dns_servers()?
        .into_iter()
        .filter(|server| is_local_dns(server))
        .collect())
}

fn is_local_dns(server: &str) -> bool {
    use std::net::IpAddr;
    let Ok(ip) = server.parse::<IpAddr>() else {
        return false;
    };
    match ip {
        IpAddr::V4(v4) => {
            v4.is_loopback()
                || crate::tun::cidr::contains(crate::tun::TUN_ADDRESS, v4).unwrap_or(false)
                || crate::tun::cidr::contains("198.18.0.0/15", v4).unwrap_or(false)
        }
        IpAddr::V6(v6) => v6.is_loopback(),
    }
}

pub(crate) fn parse_dns_servers(output: &str) -> Vec<String> {
    let mut servers: Vec<String> = Vec::new();
    for line in output.lines() {
        let line = line.trim();
        if let Some(value) = line.strip_prefix("nameserver[") {
            if let Some((_, address)) = value.split_once(':') {
                let address = address.trim();
                if !address.is_empty() && !servers.iter().any(|item| item == address) {
                    servers.push(address.to_string());
                }
            }
        }
    }
    servers
}

/// 只做一条受限的系统命令，不做通用 shell。
pub fn flush_dns() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        run("/usr/bin/dscacheutil", &["-flushcache"])?;
        // mDNSResponder 可能以非零退出，刷新本身已经生效。
        let _ = std::process::Command::new("/usr/bin/killall")
            .args(["-HUP", "mDNSResponder"])
            .status();
        Ok(())
    }
    #[cfg(windows)]
    {
        run("ipconfig", &["/flushdns"])
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let _ = run("resolvectl", &["flush-caches"]);
        Ok(())
    }
}

pub fn run(program: &str, args: &[&str]) -> Result<String, String> {
    let output = std::process::Command::new(program)
        .args(args)
        .output()
        .map_err(|error| format!("执行 {program} 失败：{error}"))?;
    if !output.status.success() {
        return Err(format!("{program} 返回 {}", output.status));
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

/// 只关掉「指向本机指定端口」的系统代理，不动别人的设置。
///
/// 强制重置用：备份丢了、但系统代理还指着 Veyl 的端口时，按端口精确清理。
/// 返回被改动的网络服务名。
pub fn disable_proxy_for_port(port: u16) -> Result<Vec<String>, String> {
    #[cfg(target_os = "macos")]
    {
        macos::disable_proxy_for_port(port)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = port;
        Err("当前平台暂未实现按端口清理系统代理".into())
    }
}

#[cfg(target_os = "macos")]
mod macos {
    use super::*;

    pub fn read() -> Result<NetConfig, String> {
        Ok(NetConfig {
            platform: "darwin".into(),
            proxies: read_proxies()?,
            dns: DnsInfo {
                servers: read_dns_servers(),
                probe_domain: DNS_PROBE_DOMAIN.to_string(),
                resolvable: dns_resolvable(),
            },
            route: read_route(),
            interfaces: read_interfaces(),
            listeners: read_listeners(),
        })
    }

    fn run_network_setup(args: &[&str]) -> Result<String, String> {
        run("/usr/sbin/networksetup", args)
    }

    fn list_services() -> Result<Vec<String>, String> {
        let output = run_network_setup(&["-listallnetworkservices"])?;
        Ok(output
            .lines()
            .map(str::trim)
            .filter(|line| {
                !line.is_empty()
                    && !line.contains("denotes that a network service is disabled")
                    && !line.starts_with('*')
            })
            .map(str::to_string)
            .collect())
    }

    fn read_setting(service: &str, flag: &str) -> ProxyEntry {
        let Ok(output) = run_network_setup(&[flag, service]) else {
            return ProxyEntry::default();
        };
        let mut entry = ProxyEntry::default();
        for line in output.lines() {
            let line = line.trim();
            if let Some(value) = line.strip_prefix("Enabled:") {
                entry.enabled = value.trim().eq_ignore_ascii_case("yes");
            } else if let Some(value) = line.strip_prefix("Server:") {
                let server = value.trim();
                if !server.is_empty() {
                    entry.server = Some(server.to_string());
                }
            } else if let Some(value) = line.strip_prefix("Port:") {
                entry.port = value.trim().parse().ok().filter(|port| *port != 0);
            }
        }
        entry
    }

    fn read_proxies() -> Result<Vec<ServiceProxies>, String> {
        let mut proxies = Vec::new();
        for service in list_services()? {
            proxies.push(ServiceProxies {
                http: read_setting(&service, "-getwebproxy"),
                https: read_setting(&service, "-getsecurewebproxy"),
                socks: read_setting(&service, "-getsocksfirewallproxy"),
                service,
            });
        }
        Ok(proxies)
    }

    /// 是不是我们写进去的那一份：已启用、端口一致、服务器是本机回环。
    /// 只认 `127.0.0.1` / `localhost`，用户自己的远端代理不会被误伤。
    fn points_at(entry: &ProxyEntry, port: u16) -> bool {
        entry.enabled
            && entry.port == Some(port)
            && matches!(
                entry.server.as_deref(),
                Some("127.0.0.1") | Some("localhost")
            )
    }

    pub fn disable_proxy_for_port(port: u16) -> Result<Vec<String>, String> {
        let mut touched = Vec::new();
        for service in list_services()? {
            let mut cleared = false;
            for (entry, flag) in [
                (read_setting(&service, "-getwebproxy"), "-setwebproxystate"),
                (
                    read_setting(&service, "-getsecurewebproxy"),
                    "-setsecurewebproxystate",
                ),
                (
                    read_setting(&service, "-getsocksfirewallproxy"),
                    "-setsocksfirewallproxystate",
                ),
            ] {
                if points_at(&entry, port) {
                    run_network_setup(&[flag, service.as_str(), "off"])?;
                    cleared = true;
                }
            }
            if cleared {
                touched.push(service);
            }
        }
        Ok(touched)
    }

    fn read_dns_servers() -> Vec<String> {
        super::dns_servers().unwrap_or_default()
    }

    fn read_route() -> RouteInfo {
        let Ok(output) = run("/sbin/route", &["-n", "get", "default"]) else {
            return RouteInfo {
                default_interface: None,
                default_gateway: None,
            };
        };
        let mut info = RouteInfo {
            default_interface: None,
            default_gateway: None,
        };
        for line in output.lines() {
            let line = line.trim();
            if let Some(value) = line.strip_prefix("interface:") {
                info.default_interface = Some(value.trim().to_string());
            } else if let Some(value) = line.strip_prefix("gateway:") {
                info.default_gateway = Some(value.trim().to_string());
            }
        }
        info
    }

    fn read_interfaces() -> Vec<InterfaceInfo> {
        let Ok(output) = run("/sbin/ifconfig", &["-a"]) else {
            return Vec::new();
        };
        let mut interfaces: Vec<InterfaceInfo> = Vec::new();
        for line in output.lines() {
            if !line.starts_with(char::is_whitespace) {
                let name = line
                    .split(':')
                    .next()
                    .unwrap_or_default()
                    .trim()
                    .to_string();
                if name.is_empty() {
                    continue;
                }
                let up =
                    line.contains("<") && line.split('<').nth(1).unwrap_or("").starts_with("UP");
                interfaces.push(InterfaceInfo {
                    name,
                    addresses: Vec::new(),
                    up,
                });
                continue;
            }
            let line = line.trim();
            let address = if let Some(value) = line.strip_prefix("inet ") {
                Some(value.split_whitespace().next().unwrap_or_default())
            } else if let Some(value) = line.strip_prefix("inet6 ") {
                Some(value.split_whitespace().next().unwrap_or_default())
            } else {
                None
            };
            if let Some(address) = address.filter(|address| !address.is_empty()) {
                if let Some(current) = interfaces.last_mut() {
                    current.addresses.push(address.to_string());
                }
            }
        }
        interfaces
    }

    fn read_listeners() -> Vec<ListenerInfo> {
        // -F 输出里 p=pid、c=命令名、n=地址；只保留回环上的 LISTEN。
        let Ok(output) = run("/usr/sbin/lsof", &["-nP", "-iTCP", "-sTCP:LISTEN", "-Fcn"]) else {
            return Vec::new();
        };
        let mut listeners: Vec<ListenerInfo> = Vec::new();
        let mut process: Option<String> = None;
        for line in output.lines() {
            if let Some(name) = line.strip_prefix('c') {
                process = Some(name.to_string());
                continue;
            }
            let Some(name) = line.strip_prefix('n') else {
                continue;
            };
            let Some((host, port)) = name.rsplit_once(':') else {
                continue;
            };
            let loopback = host == "127.0.0.1" || host == "[::1]" || host == "localhost";
            if !loopback {
                continue;
            }
            let Ok(port) = port.parse::<u16>() else {
                continue;
            };
            if listeners.iter().any(|item| item.port == port) {
                continue;
            }
            listeners.push(ListenerInfo {
                port,
                loopback_only: true,
                process: process.clone(),
            });
        }
        listeners.sort_by_key(|item| item.port);
        listeners.truncate(50);
        listeners
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        fn entry(enabled: bool, server: &str, port: u16) -> ProxyEntry {
            ProxyEntry {
                enabled,
                server: Some(server.into()),
                port: Some(port),
            }
        }

        /// 只认「已启用 + 回环 + 端口一致」；用户自己的代理不能被误伤。
        #[test]
        fn only_our_loopback_endpoint_is_matched() {
            assert!(points_at(&entry(true, "127.0.0.1", 2080), 2080));
            assert!(points_at(&entry(true, "localhost", 2080), 2080));
            assert!(!points_at(&entry(true, "127.0.0.1", 2081), 2080));
            assert!(!points_at(&entry(false, "127.0.0.1", 2080), 2080));
            assert!(!points_at(&entry(true, "10.0.0.1", 2080), 2080));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn platform_name_is_known() {
        assert!(["darwin", "windows", "linux"].contains(&platform_name()));
    }

    #[test]
    fn dns_servers_are_read_from_scutil_output() {
        let output = "\
DNS configuration

resolver #1
  nameserver[0] : 211.179.155.161
  nameserver[1] : 223.5.5.5
  nameserver[0] : 211.179.155.161

resolver #2
  domain   : local
  options  : mdns
";
        assert_eq!(
            parse_dns_servers(output),
            vec!["211.179.155.161", "223.5.5.5"]
        );
    }

    /// 回环、TUN 地址、fakeip 段要被点名；正常公网 DNS 不能被误伤。
    #[test]
    fn local_resolvers_are_flagged_but_public_ones_are_not() {
        for suspicious in ["127.0.0.1", "127.0.0.53", "::1", "172.19.0.1", "198.18.0.1"] {
            assert!(is_local_dns(suspicious), "{suspicious} 应被点名");
        }
        for public in ["223.5.5.5", "1.1.1.1", "211.179.155.161", "2409:8c00::1"] {
            assert!(!is_local_dns(public), "{public} 不该被误伤");
        }
    }
}
