//! 「强制重置网络」的底层动作：可测的纯解析 + 少量受限系统命令。
//!
//! 编排与判定在 `tools/services.rs::WiredServices::network_force_reset`；
//! 这里只回答「路由表里有什么」「哪些进程是我们的」「怎么删一条路由」。
//!
//! 所有路径都靠整段前缀比较，不按空白切分：`Application Support` 带空格。

use std::path::{Path, PathBuf};

/// 一条分流的默认路由（`0.0.0.0/1` 或 `128.0.0.0/1`）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SplitRoute {
    pub destination: String,
    pub interface: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProcessEntry {
    pub pid: u32,
    pub command: String,
}

/// netstat 对这两条路由的写法不统一：`0/1`、`0.0.0.0/1`、`128.0.0.0/1`。
fn is_split_default(destination: &str) -> bool {
    matches!(
        destination,
        "0/1" | "0.0.0.0/1" | "128/1" | "128.0.0.0/1"
    )
}

/// 从 `netstat -rn -f inet` 里挑出两条分流默认路由。
pub fn parse_split_default_routes(output: &str) -> Vec<SplitRoute> {
    output
        .lines()
        .filter_map(|line| {
            let tokens: Vec<&str> = line.split_whitespace().collect();
            if tokens.len() < 4 || !is_split_default(tokens[0]) {
                return None;
            }
            Some(SplitRoute {
                destination: tokens[0].to_string(),
                interface: tokens[3].to_string(),
            })
        })
        .collect()
}

/// 只留下「指向已消失 utun」的分流路由。
///
/// 接口还在就说明 TUN 没停干净，这时删路由既没用也不安全，交给调用方如实报告。
pub fn stale_split_routes(output: &str, live_interfaces: &[String]) -> Vec<SplitRoute> {
    parse_split_default_routes(output)
        .into_iter()
        .filter(|route| {
            route.interface.starts_with("utun")
                && !live_interfaces.iter().any(|name| name == &route.interface)
        })
        .collect()
}

/// `ifconfig -a` 的接口名。带缩进的行是属性，不是新接口。
pub fn parse_interface_names(ifconfig: &str) -> Vec<String> {
    ifconfig
        .lines()
        .filter(|line| !line.starts_with(char::is_whitespace) && !line.trim().is_empty())
        .filter_map(|line| line.split(':').next())
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map(str::to_string)
        .collect()
}

/// `ps -axww -o pid=,command=`。
pub fn parse_ps(output: &str) -> Vec<ProcessEntry> {
    output
        .lines()
        .filter_map(|line| {
            let line = line.trim_start();
            let (pid, command) = line.split_once(char::is_whitespace)?;
            let command = command.trim_start();
            if command.is_empty() {
                return None;
            }
            Some(ProcessEntry {
                pid: pid.parse().ok()?,
                command: command.to_string(),
            })
        })
        .collect()
}

/// 命令行是不是我们自己的 sing-box：`<root>/runtime/<version>/sing-box ...`。
///
/// 整段前缀比较，不按空白切分——数据目录里有空格。
pub fn is_our_sing_box(command: &str, root: &Path) -> bool {
    let prefix = format!("{}/runtime/", root.display());
    let Some(rest) = command.strip_prefix(&prefix) else {
        return false;
    };
    let Some((version, tail)) = rest.split_once('/') else {
        return false;
    };
    !version.is_empty() && (tail == "sing-box" || tail.starts_with("sing-box "))
}

pub fn find_sing_box_processes<'a>(
    entries: &'a [ProcessEntry],
    roots: &[PathBuf],
) -> Vec<&'a ProcessEntry> {
    entries
        .iter()
        .filter(|entry| roots.iter().any(|root| is_our_sing_box(&entry.command, root)))
        .collect()
}

/// TUN 运行时的信任根；非 unix 平台没有这个路径。
pub fn tun_runtime_root() -> Option<PathBuf> {
    #[cfg(unix)]
    {
        Some(PathBuf::from(crate::tun::trust::TRUST_ROOT))
    }
    #[cfg(not(unix))]
    {
        None
    }
}

/// 进程来自 TUN 信任根（root 所有，只有 helper 能停）。
pub fn is_helper_runtime(command: &str) -> bool {
    tun_runtime_root()
        .map(|root| is_our_sing_box(command, &root))
        .unwrap_or(false)
}

pub fn read_ifconfig() -> Result<String, String> {
    crate::netcfg::run("/sbin/ifconfig", &["-a"])
}

pub fn read_netstat() -> Result<String, String> {
    crate::netcfg::run("/usr/sbin/netstat", &["-rn", "-f", "inet"])
}

pub fn read_ps() -> Result<String, String> {
    crate::netcfg::run("/bin/ps", &["-axww", "-o", "pid=,command="])
}

/// 删除一条路由。
///
/// `-ifscope` 指定接口：同一目的地址可能挂在多个 utun 上，不带它会删错。
/// 改路由表需要 root，失败要如实往上报。
pub fn delete_route(destination: &str, interface: &str) -> Result<(), String> {
    crate::netcfg::run(
        "/sbin/route",
        &[
            "-n",
            "delete",
            "-net",
            destination,
            "-ifscope",
            interface,
        ],
    )
    .map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;

    const NETSTAT: &str = "\
Routing tables

Internet:
Destination        Gateway            Flags               Netif Expire
default            192.168.18.1       UGScg                 en0
0/1                link#20            UCSIg                 utun6
128.0.0.0/1        link#20            UCSIg                 utun6
192.168.18         link#13            UCS                   en0
";

    const IFCONFIG: &str = "\
lo0: flags=8049<UP,LOOPBACK,RUNNING,MULTICAST> mtu 16384
\tinet 127.0.0.1 netmask 0xff000000
en0: flags=8863<UP,BROADCAST,SMART,RUNNING,SIMPLEX,MULTICAST> mtu 1500
\tinet 192.168.18.7 netmask 0xffffff00 broadcast 192.168.18.255
utun6: flags=8051<UP,POINTOPOINT,RUNNING,MULTICAST> mtu 1500
\tinet 172.19.0.1 --> 172.19.0.2 netmask 0xfffffffc
";

    #[test]
    fn split_default_routes_are_read_in_both_notations() {
        let routes = parse_split_default_routes(NETSTAT);
        assert_eq!(routes.len(), 2);
        assert_eq!(routes[0].destination, "0/1");
        assert_eq!(routes[0].interface, "utun6");
        assert_eq!(routes[1].destination, "128.0.0.0/1");
        assert_eq!(routes[1].interface, "utun6");
    }

    #[test]
    fn long_form_split_routes_are_recognised_too() {
        let output = "\
0.0.0.0/1          link#20            UCSIg                 utun4
128.0.0.0/1        link#20            UCSIg                 utun4
";
        let stale = stale_split_routes(output, &[]);
        assert_eq!(stale.len(), 2);
        assert_eq!(stale[0].destination, "0.0.0.0/1");
        assert_eq!(stale[1].destination, "128.0.0.0/1");
    }

    #[test]
    fn a_live_utun_is_not_treated_as_stale() {
        let live = parse_interface_names(IFCONFIG);
        assert!(live.contains(&"utun6".to_string()));
        assert!(stale_split_routes(NETSTAT, &live).is_empty());
    }

    #[test]
    fn a_vanished_utun_leaves_both_routes_stale() {
        let live: Vec<String> = parse_interface_names(IFCONFIG)
            .into_iter()
            .filter(|name| name != "utun6")
            .collect();
        let stale = stale_split_routes(NETSTAT, &live);
        assert_eq!(stale.len(), 2);
        assert!(stale.iter().all(|route| route.interface == "utun6"));
    }

    #[test]
    fn non_utun_routes_are_never_touched() {
        let output = "0/1   link#4   UCSIg   en0\n";
        assert!(stale_split_routes(output, &[]).is_empty());
    }

    #[test]
    fn interface_names_skip_attribute_lines() {
        let names = parse_interface_names(IFCONFIG);
        assert_eq!(names, vec!["lo0", "en0", "utun6"]);
    }

    #[test]
    fn ps_lines_keep_paths_with_spaces_intact() {
        let output = "\
  123 /Users/x/Library/Application Support/Veyl/runtime/1.14.4/sing-box run -c /tmp/a.json
  456 /Library/Application Support/Veyl/runtime/ab12/sing-box run -c /tmp/b.json
  789 /usr/sbin/something-else
";
        let entries = parse_ps(output);
        assert_eq!(entries.len(), 3);
        assert_eq!(entries[0].pid, 123);
        assert!(entries[0].command.starts_with("/Users/x/Library/Application Support"));
    }

    #[test]
    fn only_our_runtime_binaries_match() {
        let root = Path::new("/Users/x/Library/Application Support/Veyl");
        assert!(is_our_sing_box(
            "/Users/x/Library/Application Support/Veyl/runtime/1.14.4/sing-box run -c /tmp/a.json",
            root
        ));
        // 目录里别的程序不算。
        assert!(!is_our_sing_box(
            "/Users/x/Library/Application Support/Veyl/runtime/1.14.4/not-sing-box",
            root
        ));
        // 名字前缀相同但不是我们的目录。
        assert!(!is_our_sing_box(
            "/Users/x/Library/Application Support/Veyl-other/runtime/1/sing-box",
            root
        ));
        // 完全不相干的进程。
        assert!(!is_our_sing_box("/usr/bin/sing-box run", root));
    }

    #[test]
    fn helper_runtime_is_identified_separately_when_present() {
        if tun_runtime_root().is_none() {
            return;
        }
        let root = tun_runtime_root().unwrap();
        let command = format!("{}/runtime/abc/sing-box run -c /tmp/c.json", root.display());
        assert!(is_helper_runtime(&command));
        assert!(!is_helper_runtime("/usr/bin/sing-box run"));
    }
}
