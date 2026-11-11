//! 连接期间把系统解析器指向 TUN 对端，断开时还原。
//!
//! 为什么必须改系统 DNS：sing-box 的 `hijack-dns` 只能截住**进入 TUN** 的查询。
//! macOS 默认用当前服务的 DNS（家里就是路由器），查询从 en0 直接出去，永远不经过
//! TUN——`plan.rs` 里「境外域名走 DoH over proxy」那套规则在运行时是死代码，
//! 境外域名被运营商 DNS 解析成污染/劣质 IP，代理再拿这些 IP 去连，就是「能连但很慢」。
//!
//! 为什么指向 `172.19.0.2` 而不是 `172.19.0.1`：后者是 utun 自己的地址，内核当成
//! 本机地址走 lo0，包根本不会进 TUN。`.2` 是 utun 的对端（网关）地址，由配置里的
//! `address` 推算，不在这里抄一份常量。
//!
//! 用 per-service 的 `State:/Network/Service/<uuid>/DNS` 而不是 `networksetup`：
//! 服务名会随系统语言变，UUID 不会。

use std::io::Write;
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::time::Duration;

const SCUTIL: &str = "/usr/sbin/scutil";
const VERIFY_ATTEMPTS: usize = 15;
const VERIFY_INTERVAL: Duration = Duration::from_millis(100);

/// 我们自己写进系统的地址。配置里的 TUN 是 `172.19.0.1/30`，对端固定 `.2`
/// （见 `src/tun/mod.rs` 的 `TUN_ADDRESS_MACOS`）。helper 刻意不链 `veyl_lib`，
/// 所以这里留一份常量：它是「快照丢失」时唯一的线索，不能省。
const FALLBACK_PEER: &str = "172.19.0.2";

/// 我们改写前的系统 DNS 原样快照。
#[derive(Debug, Clone, PartialEq, Eq)]
struct SavedDns {
    /// `State:/Network/Service/<uuid>/DNS` 里的 uuid。
    service: String,
    /// 我们写进去的地址。恢复前用它判断「现在的值还是不是我们的」。
    peer: String,
    /// 原本有没有这条状态键。没有 = 系统自动（DHCP），恢复时要删掉。
    had_state: bool,
    servers: Vec<String>,
    search: Vec<String>,
}

/// 恢复时该做什么。
///
/// **当前值已经不是我们的就什么都别做**：连接期间换了网络或用户手动改过 DNS，
/// 把上个网络的原始值写进新网络，会让断连后完全解析不了。
#[derive(Debug, Clone, PartialEq, Eq)]
enum RestoreAction {
    Nothing,
    Write {
        servers: Vec<String>,
        search: Vec<String>,
    },
    Remove,
}

fn restore_action(current: &[String], saved: &SavedDns) -> RestoreAction {
    if current != [saved.peer.clone()] {
        return RestoreAction::Nothing;
    }
    if saved.had_state {
        RestoreAction::Write {
            servers: saved.servers.clone(),
            search: saved.search.clone(),
        }
    } else {
        RestoreAction::Remove
    }
}

static SAVED: Mutex<Option<SavedDns>> = Mutex::new(None);

/// 连接期系统 DNS 是否被接管。`applied = false` 时 `reason` 说明原因。
///
/// **失败不阻断连接**：DNS 是优化项，隧道才是产品。降级必须可见（回给 App 的
/// `dns_hijack` 字段），不能静默。
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct DnsHijack {
    pub applied: bool,
    pub reason: Option<String>,
}

impl DnsHijack {
    fn applied() -> Self {
        Self {
            applied: true,
            reason: None,
        }
    }

    pub(super) fn failed(reason: impl Into<String>) -> Self {
        Self {
            applied: false,
            reason: Some(reason.into()),
        }
    }
}

/// 第一次失败后等一会儿再试：服务刚起来时读不到 PrimaryService 是瞬时的。
const RETRY_DELAY: Duration = Duration::from_millis(400);

/// 把系统解析器指向 TUN 对端；失败重试一次，仍失败就返回未接管的原因。
///
/// 调用方**不要**因此让连接失败——照常连，把 `applied=false` 报给界面。
pub(super) fn activate(config: &serde_json::Value) -> DnsHijack {
    activate_with(|| activate_once(config))
}

/// 重试逻辑单独抽出来，测试可以注入「第一次失败、第二次成功」的时序。
fn activate_with(mut attempt: impl FnMut() -> Result<(), String>) -> DnsHijack {
    match attempt() {
        Ok(()) => return DnsHijack::applied(),
        Err(first) => {
            std::thread::sleep(RETRY_DELAY);
            match attempt() {
                Ok(()) => DnsHijack::applied(),
                Err(second) => {
                    eprintln!("veyl-helper: 系统 DNS 未接管（第一次：{first}；重试：{second}）");
                    DnsHijack::failed(second)
                }
            }
        }
    }
}

/// 一次尝试。失败时保持「什么都没改」——回滚在函数内部完成。
///
/// **幂等**：已经改过（`SAVED` 有值）就不再读一遍当前值。否则第二次 start 会把
/// 我们自己设的地址记成「原始值」，之后再也恢复不回去。
fn activate_once(config: &serde_json::Value) -> Result<(), String> {
    let peer = tun_peer_address(config)
        .ok_or_else(|| "配置里没有可用的 IPv4 TUN 地址，无法把系统 DNS 指进隧道".to_string())?;

    let mut guard = SAVED.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    // 快照可能属于旧服务（连接期间换过网络）：复用前先确认它还是当前主服务，
    // 否则会把 DNS 写进一个已经不存在的服务。发现不一致就丢掉重采，宁可丢原始值。
    let stale = match guard.as_ref() {
        Some(saved) => primary_service().ok().as_deref() != Some(saved.service.as_str()),
        None => false,
    };
    if stale {
        *guard = None;
    }
    let recorded = guard.as_ref().map(|saved| saved.service.clone());
    let service = match recorded {
        Some(service) => service,
        None => {
            let service = primary_service()?;
            let (had_state, mut servers, mut search) = read_service_dns(&service)?;
            // 上一次连接崩溃留下的地址不能当「原始值」记下来——否则恢复时又把一个
            // 已经不通的隧道地址写回去。这种情况按「本来就没有自定义 DNS」处理。
            let left_behind = had_state && is_leftover(&servers, &peer);
            if left_behind {
                servers.clear();
                search.clear();
            }
            remember_once(
                &mut guard,
                SavedDns {
                    service: service.clone(),
                    peer: peer.clone(),
                    had_state: had_state && !left_behind,
                    servers,
                    search,
                },
            );
            service
        }
    };
    // 配置里的地址变了（罕见）：以这次真正写入的为准，恢复判定才对得上。
    if let Some(saved) = guard.as_mut() {
        if saved.peer != peer {
            saved.peer = peer.clone();
        }
    }

    if let Err(error) = write_service_dns(&service, &[peer.as_str()], &[]) {
        let _ = restore_locked(&mut guard);
        return Err(error);
    }
    if let Err(error) = verify_effective(&peer) {
        let _ = restore_locked(&mut guard);
        return Err(error);
    }
    eprintln!("veyl-helper: 系统 DNS 已指向 TUN 对端 {peer}（服务 {service}）");
    Ok(())
}

/// 只在还没有快照时记录原始值，并返回真正生效的那份。
///
/// 这是幂等的关键：第二次 start 拿到的「当前值」已经是我们自己设的地址，
/// 覆盖上去就再也恢复不回用户原来的 DNS。
fn remember_once(slot: &mut Option<SavedDns>, candidate: SavedDns) -> SavedDns {
    if let Some(saved) = slot.as_ref() {
        return saved.clone();
    }
    *slot = Some(candidate.clone());
    candidate
}

/// 还原系统 DNS。没改过就什么都不做（幂等）。
pub(super) fn restore() -> Result<(), String> {
    let mut guard = SAVED.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    restore_locked(&mut guard)
}

/// 退出路径专用：最后一道还原，尽量别放弃。
///
/// 拿不到锁时自旋最多 200ms——另一条线程可能正好在改 DNS，等它一下就能收尾；
/// 超过这个时限就认输，不能在退出路径上无限阻塞。
pub(super) fn restore_at_exit() {
    let deadline = std::time::Instant::now() + Duration::from_millis(200);
    let mut guard = loop {
        match SAVED.try_lock() {
            Ok(guard) => break guard,
            Err(std::sync::TryLockError::WouldBlock)
                if std::time::Instant::now() < deadline =>
            {
                std::thread::sleep(Duration::from_millis(10));
            }
            Err(_) => return,
        }
    };
    let _ = restore_locked(&mut guard);
}

/// 连接期复核：系统主解析器是否仍然是我们写进去的地址。
///
/// 连接期间换 Wi-Fi 或用户手动改 DNS 会把我们的键冲掉；靠它把
/// `dns.applied` 纠正回 false，界面才会显示降级。
pub(super) fn peer_still_applied(peer: &str) -> Result<bool, String> {
    let service = primary_service()?;
    let (_, servers, _) = read_service_dns(&service)?;
    Ok(servers == [peer.to_string()])
}

/// 恢复或**兜底清理**：没有原始快照（helper 崩溃后重启）时，只在当前解析器
/// 正好是我们设的那个地址时才把它清掉，不动用户自己的 DNS。
pub(super) fn restore_or_clear(tun_peer: Option<&str>) -> Result<(), String> {
    let mut guard = SAVED.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    if guard.is_some() {
        return restore_locked(&mut guard);
    }
    // 没有快照也必须清：我们自己写的地址是常量（`FALLBACK_PEER`），不依赖快照。
    // helper 崩溃后 active.json 可能已经被删掉，这条是「Wi-Fi 在但完全上不了网」的兜底。
    let Ok(service) = primary_service() else {
        return Ok(());
    };
    let (_, servers, _) = read_service_dns(&service)?;
    // 配置里的地址与兜底常量**都试**：TUN 地址改过之后，旧残留仍在旧地址上。
    // helper 不链 `veyl_lib`，两个常量只能各自维护，所以这里必须容错。
    let mut candidates: Vec<&str> = Vec::new();
    if let Some(peer) = tun_peer {
        candidates.push(peer);
    }
    candidates.push(FALLBACK_PEER);
    let Some(peer) = leftover_peer(&servers, &candidates) else {
        return Ok(());
    };
    remove_service_dns(&service)?;
    let _ = super::flush_system_dns();
    eprintln!("veyl-helper: 系统 DNS 残留 {peer}，已清回自动（没有原始快照可还原）");
    Ok(())
}

/// 当前 DNS 值命中的候选地址（配置文件里的 + 兜底常量）。
fn leftover_peer<'a>(servers: &[String], candidates: &[&'a str]) -> Option<&'a str> {
    candidates
        .iter()
        .copied()
        .find(|peer| is_leftover(servers, *peer))
}

fn restore_locked(guard: &mut Option<SavedDns>) -> Result<(), String> {
    let Some(saved) = guard.clone() else {
        return Ok(());
    };
    let read = read_service_dns(&saved.service);
    apply_restore(guard, &saved, read)
}

/// 把「快照 + 回读结果」变成实际动作。
///
/// **回读失败也要丢快照**：读不回来通常意味着服务已经没了；留着它，下一次
/// `activate_once` 会拿旧 `service` 直接写，把 DNS 写进一个不存在的服务。
/// 宁可丢原始值，也不要写错地方。
fn apply_restore(
    guard: &mut Option<SavedDns>,
    saved: &SavedDns,
    read: Result<(bool, Vec<String>, Vec<String>), String>,
) -> Result<(), String> {
    let current = match read {
        Ok((_, servers, _)) => servers,
        Err(error) => {
            *guard = None;
            return Err(error);
        }
    };
    // 连接期间可能换了网络（服务键被 DHCP 重建）或用户手动改过 DNS：
    // 只有当前值仍然是我们的，才把原始值写回去。
    match restore_action(&current, saved) {
        RestoreAction::Nothing => {
            eprintln!(
                "veyl-helper: 系统 DNS 已被别处改写（当前 {current:?}），不写回旧网络的原始值"
            );
        }
        RestoreAction::Write { servers, search } => {
            let refs: Vec<&str> = servers.iter().map(String::as_str).collect();
            let search_refs: Vec<&str> = search.iter().map(String::as_str).collect();
            write_service_dns(&saved.service, &refs, &search_refs)?;
        }
        RestoreAction::Remove => remove_service_dns(&saved.service)?,
    }
    *guard = None;
    let _ = super::flush_system_dns();
    eprintln!("veyl-helper: 系统 DNS 已还原");
    Ok(())
}

/// 从配置里取第一个 TUN 入站的地址，算出对端（地址 + 1）。
fn tun_peer_address(config: &serde_json::Value) -> Option<String> {
    let address = config["inbounds"]
        .as_array()?
        .first()?
        .get("address")?;
    let first = match address {
        serde_json::Value::Array(list) => list.first()?,
        other => other,
    };
    peer_address(first.as_str()?)
}

/// `172.19.0.1/30` → `172.19.0.2`。
fn peer_address(cidr: &str) -> Option<String> {
    let address = cidr.split('/').next()?;
    let ip: std::net::Ipv4Addr = address.parse().ok()?;
    let next = u32::from(ip).checked_add(1)?;
    Some(std::net::Ipv4Addr::from(next).to_string())
}

/// 当前解析器是不是「上一次连接崩溃留下的我们的地址」。
fn is_leftover(servers: &[String], peer: &str) -> bool {
    servers == [peer.to_string()]
}

/// 从配置里取 TUN 对端；`start` 之后要用它做连接期复核。
pub(super) fn configured_peer(config: &serde_json::Value) -> Option<String> {
    tun_peer_address(config)
}

/// 从落盘的配置文件里取 TUN 对端（兜底清理用；读不到就是 `None`）。
pub(super) fn peer_from_config(path: &std::path::Path) -> Option<String> {
    let text = std::fs::read_to_string(path).ok()?;
    let config: serde_json::Value = serde_json::from_str(&text).ok()?;
    tun_peer_address(&config)
}

fn primary_service() -> Result<String, String> {
    // 必须用 `show`：`get` 只把值读进会话里的 `d` 字典，**不打印任何东西**，
    // 用 `get` 时解析永远是空，表现就是「读不到当前网络服务」。
    let text = scutil_script("open\nshow State:/Network/Global/IPv4\n")?;
    let dict = parse_show(&text);
    let service = dict.scalar("PrimaryService").ok_or_else(|| {
        "读不到当前网络服务（State:/Network/Global/IPv4 没有 PrimaryService）".to_string()
    })?;
    // 服务 UUID 会拼进 scutil 脚本，畸形值不能放行。
    if service.is_empty() || service.chars().any(|c| c.is_whitespace()) {
        return Err(format!("当前网络服务标识不合法：{service:?}"));
    }
    Ok(service)
}

/// 读某个服务当前的 DNS 状态。返回 `had_state=false` 表示「系统自动」，恢复时删键。
fn read_service_dns(service: &str) -> Result<(bool, Vec<String>, Vec<String>), String> {
    // 同上：`show` 才输出；键不存在时它打印 `No such key`，按「系统自动」处理。
    let text = scutil_script(&format!("open\nshow State:/Network/Service/{service}/DNS\n"))?;
    if !text.contains("<dictionary>") {
        return Ok((false, Vec::new(), Vec::new()));
    }
    let dict = parse_show(&text);
    Ok((
        true,
        dict.array("ServerAddresses"),
        dict.array("SearchDomains"),
    ))
}

fn write_service_dns(service: &str, servers: &[&str], search: &[&str]) -> Result<(), String> {
    if servers.is_empty() && search.is_empty() {
        return remove_service_dns(service);
    }
    let mut script = String::from("open\nd.init\n");
    if !servers.is_empty() {
        let values = join_tokens(servers)?;
        script.push_str(&format!("d.add ServerAddresses * {values}\n"));
    }
    if !search.is_empty() {
        let values = join_tokens(search)?;
        script.push_str(&format!("d.add SearchDomains * {values}\n"));
    }
    script.push_str(&format!("set State:/Network/Service/{service}/DNS\n"));
    scutil_script(&script).map(|_| ())
}

fn remove_service_dns(service: &str) -> Result<(), String> {
    scutil_script(&format!(
        "open\nremove State:/Network/Service/{service}/DNS\n"
    ))
    .map(|_| ())
}

/// scutil 的脚本是一条命令一行，值里出现空白或换行就能注入别的命令。
fn join_tokens(values: &[&str]) -> Result<String, String> {
    let mut out = Vec::with_capacity(values.len());
    for value in values {
        if value.is_empty() || value.chars().any(|c| c.is_whitespace() || c == '\n') {
            return Err(format!("DNS 值不合法，拒绝写入：{value:?}"));
        }
        out.push(*value);
    }
    Ok(out.join(" "))
}

/// 回读校验：系统实际生效的第一个解析器必须是我们要的地址。
///
/// 写状态和 mDNSResponder 生效之间有一个短暂的过渡期，所以要轮询。
fn verify_effective(peer: &str) -> Result<(), String> {
    for _ in 0..VERIFY_ATTEMPTS {
        if primary_nameserver().as_deref() == Some(peer) {
            return Ok(());
        }
        std::thread::sleep(VERIFY_INTERVAL);
    }
    Err(format!(
        "设置后回读不到 {peer}：系统解析器没有切到隧道，已按失败处理"
    ))
}

fn primary_nameserver() -> Option<String> {
    let text = run_scutil(&["--dns"])?;
    let mut in_first = false;
    for line in text.lines() {
        let line = line.trim();
        if let Some(rest) = line.strip_prefix("resolver #") {
            if in_first && rest.trim() != "1" {
                break;
            }
            in_first = rest.trim() == "1";
            continue;
        }
        if in_first {
            if let Some(rest) = line.strip_prefix("nameserver[0]") {
                return rest
                    .trim_start_matches(':')
                    .trim()
                    .split_whitespace()
                    .next()
                    .map(str::to_string);
            }
        }
    }
    None
}

fn scutil_script(script: &str) -> Result<String, String> {
    let mut child = Command::new(SCUTIL)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("无法执行 scutil：{error}"))?;
    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(script.as_bytes())
            .map_err(|error| format!("写入 scutil 脚本失败：{error}"))?;
    }
    let output = child
        .wait_with_output()
        .map_err(|error| format!("等待 scutil 失败：{error}"))?;
    if !output.status.success() {
        return Err(format!(
            "scutil 执行失败：{}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

fn run_scutil(args: &[&str]) -> Option<String> {
    let output = Command::new(SCUTIL).args(args).output().ok()?;
    if !output.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&output.stdout).to_string())
}

/// `scutil` 的 `<dictionary>` 输出。只解析我们用到的两种形态：标量与数组。
#[derive(Debug, Default, PartialEq, Eq)]
struct ScutilDict {
    scalars: Vec<(String, String)>,
    arrays: Vec<(String, Vec<String>)>,
}

impl ScutilDict {
    fn scalar(&self, key: &str) -> Option<String> {
        self.scalars
            .iter()
            .find(|(name, _)| name == key)
            .map(|(_, value)| value.clone())
    }

    fn array(&self, key: &str) -> Vec<String> {
        self.arrays
            .iter()
            .find(|(name, _)| name == key)
            .map(|(_, values)| values.clone())
            .unwrap_or_default()
    }
}

fn parse_show(text: &str) -> ScutilDict {
    let mut dict = ScutilDict::default();
    let mut current: Option<(String, Vec<String>)> = None;

    for raw in text.lines() {
        let line = raw.trim();
        if line.is_empty() {
            continue;
        }
        if let Some((name, values)) = current.as_mut() {
            if line == "}" {
                dict.arrays
                    .push((std::mem::take(name), std::mem::take(values)));
                current = None;
            } else if let Some((_, value)) = line.split_once(" : ") {
                values.push(value.trim().to_string());
            }
            continue;
        }
        if let Some(name) = line.strip_suffix(" : <array> {") {
            current = Some((name.trim().to_string(), Vec::new()));
            continue;
        }
        if let Some((key, value)) = line.split_once(" : ") {
            let value = value.trim();
            if !value.is_empty() && !value.starts_with('<') {
                dict.scalars.push((key.trim().to_string(), value.to_string()));
            }
        }
    }
    dict
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn peer_address_is_the_next_ip_in_the_subnet() {
        assert_eq!(peer_address("172.19.0.1/30").as_deref(), Some("172.19.0.2"));
        assert_eq!(peer_address("172.19.0.2/30").as_deref(), Some("172.19.0.3"));
        assert_eq!(peer_address("198.18.0.1/15").as_deref(), Some("198.18.0.2"));
        assert_eq!(peer_address("not-an-ip/30"), None);
    }

    #[test]
    fn peer_address_comes_from_the_generated_config() {
        let config = serde_json::json!({
            "inbounds": [{ "type": "tun", "address": ["172.19.0.1/30"] }]
        });
        assert_eq!(tun_peer_address(&config).as_deref(), Some("172.19.0.2"));

        // 老形状（字符串）也认。
        let single = serde_json::json!({
            "inbounds": [{ "type": "tun", "address": "172.19.0.1/30" }]
        });
        assert_eq!(tun_peer_address(&single).as_deref(), Some("172.19.0.2"));

        assert_eq!(tun_peer_address(&serde_json::json!({})), None);
    }

    #[test]
    fn parsing_reads_scalars_and_arrays() {
        let text = "<dictionary> {\n  PrimaryService : ABC-123\n  Router : 192.168.43.1\n}";
        let dict = parse_show(text);
        assert_eq!(dict.scalar("PrimaryService").as_deref(), Some("ABC-123"));
        assert_eq!(dict.scalar("Router").as_deref(), Some("192.168.43.1"));

        let dns = "<dictionary> {\n  ServerAddresses : <array> {\n    0 : 10.0.0.53\n    1 : 1.1.1.1\n  }\n  SearchDomains : <array> {\n    0 : lan\n  }\n}";
        let dict = parse_show(dns);
        assert_eq!(dict.array("ServerAddresses"), vec!["10.0.0.53", "1.1.1.1"]);
        assert_eq!(dict.array("SearchDomains"), vec!["lan"]);
    }

    #[test]
    fn restore_writes_back_the_original_values_not_empty() {
        let saved = SavedDns {
            service: "ABC".into(),
            peer: "172.19.0.2".into(),
            had_state: true,
            servers: vec!["10.0.0.53".into()],
            search: vec!["lan".into()],
        };
        assert_eq!(
            restore_action(&["172.19.0.2".to_string()], &saved),
            RestoreAction::Write {
                servers: vec!["10.0.0.53".into()],
                search: vec!["lan".into()],
            },
            "当前值仍是我们的，用户原来的自定义 DNS 必须还原，不能清成自动"
        );
    }

    #[test]
    fn restore_removes_the_key_when_there_was_no_dns_state() {
        let saved = SavedDns {
            service: "ABC".into(),
            peer: "172.19.0.2".into(),
            had_state: false,
            servers: Vec::new(),
            search: Vec::new(),
        };
        assert_eq!(
            restore_action(&["172.19.0.2".to_string()], &saved),
            RestoreAction::Remove
        );
    }

    /// 连接期间换了网络或用户手动改过 DNS：当前值已经不是我们的，
    /// 绝不能把上个网络的原始值写进新网络。
    #[test]
    fn restore_leaves_a_changed_dns_alone() {
        let saved = SavedDns {
            service: "ABC".into(),
            peer: "172.19.0.2".into(),
            had_state: true,
            servers: vec!["192.168.1.1".into()],
            search: Vec::new(),
        };
        assert_eq!(
            restore_action(&["192.168.43.1".to_string()], &saved),
            RestoreAction::Nothing,
            "网络换了就什么都别写，否则断连后完全解析不了"
        );
        assert_eq!(
            restore_action(&[], &saved),
            RestoreAction::Nothing,
            "键都被删了说明不是我们管的"
        );
    }

    /// 快照丢失（helper 崩溃重启、active.json 已删）时仍要认出自己的地址。
    #[test]
    fn a_lost_snapshot_still_recognises_our_address() {
        assert!(
            is_leftover(&["172.19.0.2".to_string()], FALLBACK_PEER),
            "没有快照也要能清掉指向隧道的残留"
        );
        assert!(!is_leftover(
            &["192.168.43.1".to_string()],
            FALLBACK_PEER
        ));
        assert!(!is_leftover(&[], FALLBACK_PEER));
    }

    #[test]
    fn the_first_snapshot_wins_across_repeated_starts() {
        // 模拟「第二次 start」：已经记过原始值，就不能拿当前值（我们设的地址）覆盖它。
        let first = SavedDns {
            service: "ABC".into(),
            peer: "172.19.0.2".into(),
            had_state: true,
            servers: vec!["10.0.0.53".into()],
            search: Vec::new(),
        };
        let mut slot = Some(first.clone());
        let current = SavedDns {
            service: "ABC".into(),
            peer: "172.19.0.2".into(),
            had_state: true,
            servers: vec!["172.19.0.2".into()],
            search: Vec::new(),
        };
        remember_once(&mut slot, current);
        assert_eq!(slot, Some(first), "原始值只能记录一次");
    }

    #[test]
    fn activation_retries_once_before_reporting_failure() {
        let mut attempts = 0;
        let result = activate_with(|| {
            attempts += 1;
            if attempts == 1 {
                Err("服务还没就绪".to_string())
            } else {
                Ok(())
            }
        });
        assert!(result.applied, "第二次成功就算接管成功");
        assert_eq!(attempts, 2);

        let mut attempts = 0;
        let result = activate_with(|| {
            attempts += 1;
            Err(format!("第 {attempts} 次失败"))
        });
        assert!(!result.applied);
        assert_eq!(attempts, 2, "只重试一次，不能无限重试");
        assert_eq!(result.reason.as_deref(), Some("第 2 次失败"));
    }

    /// TUN 地址改过之后，旧残留还在兜底常量上：两个候选都要试。
    #[test]
    fn a_leftover_is_cleared_even_when_the_config_address_changed() {
        let candidates = ["172.20.0.1", FALLBACK_PEER];
        assert_eq!(
            leftover_peer(&["172.19.0.2".to_string()], &candidates),
            Some(FALLBACK_PEER),
            "配置换了地址，旧残留要按兜底常量认出来"
        );
        assert_eq!(
            leftover_peer(&["172.20.0.1".to_string()], &candidates),
            Some("172.20.0.1")
        );
        assert_eq!(
            leftover_peer(&["192.168.43.1".to_string()], &candidates),
            None
        );
    }

    /// 回读失败时快照必须丢弃：留着它，下次会拿旧 service 写进不存在的服务。
    #[test]
    fn a_failed_read_drops_the_snapshot() {
        let saved = SavedDns {
            service: "ABC".into(),
            peer: "172.19.0.2".into(),
            had_state: true,
            servers: vec!["10.0.0.53".into()],
            search: Vec::new(),
        };
        let mut slot = Some(saved.clone());
        let result = apply_restore(&mut slot, &saved, Err("No such key".into()));
        assert!(result.is_err());
        assert_eq!(slot, None, "读不回来宁可丢原始值，也不能下次写错服务");
    }

    #[test]
    fn a_leftover_address_is_not_recorded_as_the_original() {
        assert!(is_leftover(&["172.19.0.2".to_string()], "172.19.0.2"));
        assert!(!is_leftover(&["10.0.0.53".to_string()], "172.19.0.2"));
        assert!(!is_leftover(&[], "172.19.0.2"));
    }

    #[test]
    fn joining_rejects_values_that_could_inject_commands() {
        assert!(join_tokens(&["1.1.1.1", "8.8.8.8"]).is_ok());
        assert!(join_tokens(&["1.1.1.1\nremove State:/Network/Global"]).is_err());
        assert!(join_tokens(&["a b"]).is_err());
        assert!(join_tokens(&[""]).is_err());
    }
}
