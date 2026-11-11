//! 连接期间把系统解析器指向一个公网 DNS 地址，断开时还原。
//!
//! 为什么必须改系统 DNS：sing-box 的 `hijack-dns` 只能截住**进入 TUN** 的查询。
//! macOS 默认用当前服务的 DNS（家里就是路由器），查询从 en0 直接出去，永远不经过
//! TUN——`plan.rs` 里「境外域名走 DoH over proxy」那套规则在运行时是死代码，
//! 境外域名被运营商 DNS 解析成污染/劣质 IP，代理再拿这些 IP 去连，就是「能连但很慢」。
//!
//! 为什么指向公网 `223.5.5.5` 而不是 TUN 对端 `172.19.0.2`：
//! 2026-11-11 真机验证——`172.16.0.0/12` 在 `FIXED_EXCLUDES` 里（见 `tun/mod.rs`），
//! 对端正好落在其中，发往它的查询被排除路由送到物理网卡后黑洞：`scutil --dns`
//! 显示 `nameserver[0] = 172.19.0.2`，但 sing-box 侧 `inbound DNS packet` 0 条，
//! 整台机器 `Resolving timed out`（国内外全挂）。公网地址不在排除表里，`auto_route`
//! 会把它收进隧道，由 `dns_mode: "hijack"` 回答。附带两个好处：用户路由器 DNS 是
//! 私网地址、本来就被排除表放过的情形一并解决；隧道挂了查询直接走公网解析，不断网。
//!
//! 也不能用 `172.19.0.1`（utun 自己的地址）：内核当成本机地址走 lo0，包不进 TUN。
//!
//! 用 per-service 的 `State:/Network/Service/<uuid>/DNS` 而不是 `networksetup`：
//! 服务名会随系统语言变，UUID 不会。

use std::io::Write;
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

const SCUTIL: &str = "/usr/sbin/scutil";
const VERIFY_ATTEMPTS: usize = 15;
const VERIFY_INTERVAL: Duration = Duration::from_millis(100);

/// 连接期写进系统解析器的地址。
///
/// 必须同时满足两点：**不在排除表里**（否则查询出物理网卡，见模块注释）、
/// **本身是一个可用的公网 DNS**（隧道消失时它自己还能解析，机器不会断网）。
/// 选 223.5.5.5（阿里）而不是 1.1.1.1 / 8.8.8.8：用户主体在中国大陆，后两者
/// 常被阻断或污染，而这条路径恰恰不能在用户最需要的时候失效。
pub(super) const SYSTEM_DNS_TARGET: &str = "223.5.5.5";

/// 旧设计写进系统的 TUN 对端地址，**只用于清扫旧版本崩溃留下的残留**。
///
/// 2026-11-11 真机：它落在 `172.16.0.0/12` 排除段里，查询出物理网卡后黑洞。
/// helper 刻意不链 `veyl_lib`，所以这里留一份常量：它是「快照丢失」时唯一的线索。
const LEGACY_PEER: &str = "172.19.0.2";

/// 最后一道兜底：连全局 DNS 都读不到时，宁可写一组可用的 DNS 也不能让机器没有解析。
///
/// 选阿里 / 腾讯而不用 1.1.1.1 / 8.8.8.8：理由同上。**兜底值的标准是「目标用户
/// 所在网络能解析」，不是「国际公认」。**
/// 2026-11-11 真机验证：删掉服务级 DNS 键**不会**回落到 DHCP，机器会直接
/// 「没有 nameserver、Not Reachable」，只能关开 Wi-Fi 才恢复。
const PUBLIC_DNS: [&str; 2] = ["223.5.5.5", "119.29.29.29"];

/// 我们改写前的系统 DNS 原样快照。
#[derive(Debug, Clone, PartialEq, Eq)]
struct SavedDns {
    /// `State:/Network/Service/<uuid>/DNS` 里的 uuid。
    service: String,
    /// 我们写进去的地址。恢复前用它判断「现在的值还是不是我们的」。
    written: String,
    /// 原本有没有这条状态键。没有 = 系统自动（DHCP）。
    had_state: bool,
    servers: Vec<String>,
    search: Vec<String>,
    /// 激活时读到的全局 DNS（`State:/Network/Global/DNS`），服务级没有原始值时用它兜底。
    global_servers: Vec<String>,
}

/// 恢复时该做什么。
///
/// **当前值里没有我们的地址就什么都别做**：连接期间换了网络或用户手动改过 DNS，
/// 把上个网络的原始值写进新网络，会让断连后完全解析不了。
#[derive(Debug, Clone, PartialEq, Eq)]
enum RestoreAction {
    Nothing,
    Write {
        servers: Vec<String>,
        search: Vec<String>,
    },
    /// 当前含我们写入的地址但还夹着别的条目（用户连接期间手动加过 DNS）：摘掉它、保留其余。
    RemovePeer {
        remaining: Vec<String>,
    },
    /// 服务级没有可用值（空键，或原本就是自动）：写一组可用地址。
    ///
    /// `use_snapshot = false` 表示当前是**空键**——机器现在没有解析，救援只能用
    /// 现读的全局 DNS，**不许**用快照（快照是旧网络的地址，会串网）。
    Rescue {
        use_snapshot: bool,
    },
}

fn restore_action(current: &[String], saved: &SavedDns) -> RestoreAction {
    if current.is_empty() {
        return RestoreAction::Rescue {
            use_snapshot: false,
        };
    }
    if current == [saved.written.clone()] {
        return if saved.had_state {
            RestoreAction::Write {
                servers: saved.servers.clone(),
                search: saved.search.clone(),
            }
        } else {
            RestoreAction::Rescue {
                use_snapshot: true,
            }
        };
    }
    if current.iter().any(|value| value == &saved.written) {
        // 摘掉我们写入的地址，也摘掉旧设计留下的隧道对端（升级后可能残留）。
        let remaining: Vec<String> = current
            .iter()
            .filter(|value| *value != &saved.written && value.as_str() != LEGACY_PEER)
            .cloned()
            .collect();
        if remaining.is_empty() {
            // 只剩我们的地址：改写出一组可用 DNS，不能写空。
            return RestoreAction::Rescue {
                use_snapshot: false,
            };
        }
        return RestoreAction::RemovePeer { remaining };
    }
    RestoreAction::Nothing
}

/// `RemovePeer` 的写回内容：只摘掉我们写入的地址，**搜索域沿用快照**——那是用户的，
/// 清空等于断连后永久丢掉。
fn remove_peer_plan(saved: &SavedDns, remaining: &[String]) -> (Vec<String>, Vec<String>) {
    (remaining.to_vec(), saved.search.clone())
}

/// 捕获原始值前摘掉旧版本遗留的隧道对端。
///
/// 只要它出现在列表里就摘（不必整组相等）：激活时我们还没接管，此刻出现的它
/// 一定是旧版本崩溃留下的。返回清理后的列表是否还能当「用户原本有自定义 DNS」；
/// 只剩它一个时按「本来就没有」处理，搜索域也一并清掉。
fn strip_legacy_peer(servers: &mut Vec<String>, search: &mut Vec<String>) -> bool {
    servers.retain(|value| value != LEGACY_PEER);
    if servers.is_empty() {
        search.clear();
        return false;
    }
    true
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
    pub(super) fn applied() -> Self {
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

/// 把系统解析器指向公网地址；失败重试一次，仍失败就返回未接管的原因。
///
/// 调用方**不要**因此让连接失败——照常连，把 `applied=false` 报给界面。
pub(super) fn activate() -> DnsHijack {
    activate_with(activate_once)
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
fn activate_once() -> Result<(), String> {
    let target = SYSTEM_DNS_TARGET.to_string();

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
            // 旧版本崩溃留下的隧道对端不能当「原始值」记下来——那是死地址，
            // 恢复时又写回去等于断网；排在 nameserver[0] 时还会让每次查询先等它超时。
            // 只要它出现在列表里就摘掉（不必整组相等：激活时我们确认过还没接管）。
            // 注意**不能**把本次要写的公网地址也当残留：那可能是用户自己设的。
            let had_state = had_state && strip_legacy_peer(&mut servers, &mut search);
            // 服务级没有原始值时靠它兜底，绝不能让机器落进「没有 DNS」。
            let mut global_servers = global_dns_servers().unwrap_or_default();
            global_servers.retain(|value| value != LEGACY_PEER);
            remember_once(
                &mut guard,
                SavedDns {
                    service: service.clone(),
                    written: target.clone(),
                    had_state,
                    servers,
                    search,
                    global_servers,
                },
            );
            service
        }
    };

    if let Err(error) = write_service_dns(&service, &[target.as_str()], &[]) {
        let _ = restore_locked(&mut guard, None);
        return Err(error);
    }
    if let Err(error) = verify_written(&service, &target, None) {
        let _ = restore_locked(&mut guard, None);
        return Err(error);
    }
    eprintln!("veyl-helper: 系统 DNS 已指向 {target}（查询走隧道，由 hijack-dns 回答；服务 {service}）");
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
    restore_locked(&mut guard, None)
}

/// 退出路径专用：最后一道还原，尽量别放弃。
///
/// 两道时限：拿锁自旋最多 200ms（另一条线程可能正在改 DNS）；拿到锁之后整条
/// 还原**总共只有 2 秒**（`EXIT_RESTORE_BUDGET`）——launchd 等着旧进程退出，
/// 退出路径宁可少还原一点，也不能卡死。
pub(super) fn restore_at_exit() {
    let lock_deadline = Instant::now() + Duration::from_millis(200);
    let mut guard = loop {
        match SAVED.try_lock() {
            Ok(guard) => break guard,
            Err(std::sync::TryLockError::WouldBlock) if Instant::now() < lock_deadline => {
                std::thread::sleep(Duration::from_millis(10));
            }
            Err(_) => return,
        }
    };
    let deadline = Some(Instant::now() + EXIT_RESTORE_BUDGET);
    if let Err(error) = restore_locked(&mut guard, deadline) {
        eprintln!("veyl-helper: [warn] 退出时还原系统 DNS 失败：{error}");
    }
}

/// 连接期复核：系统主解析器里是否仍然有我们写进去的地址。
///
/// 连接期间换 Wi-Fi 或用户手动改 DNS 会把我们的键冲掉；靠它把
/// `dns.applied` 纠正回 false，界面才会显示降级。
pub(super) fn target_still_applied(target: &str) -> Result<bool, String> {
    let service = primary_service()?;
    let (_, servers, _) = read_service_dns(&service)?;
    Ok(readback_confirms(&servers, target))
}

/// 退出路径的总时限：超过就放弃（launchd 等着旧进程退出，不能卡死）。
const EXIT_RESTORE_BUDGET: Duration = Duration::from_secs(2);

fn deadline_passed(deadline: Option<Instant>) -> bool {
    deadline.is_some_and(|at| Instant::now() >= at)
}

/// 恢复或**兜底清理**：没有原始快照（helper 崩溃后重启）时，扫描**所有**服务的
/// DNS 键——残留可能留在连接中换下来的旧服务上。
///
/// 只清**旧设计**留下的隧道对端地址（配置推得的对端与 `LEGACY_PEER`），整组恰好
/// 等于才动。**不清 `SYSTEM_DNS_TARGET`**：`223.5.5.5` 是真实可用的公网 DNS，也是
/// 用户可能自己设的值，我们没有可靠标记能证明它是我们写的。宁可留一组能用的 DNS，
/// 也不误伤用户配置——崩溃后机器仍能正常解析，只是用户的原始自定义 DNS 丢了。
pub(super) fn restore_or_clear(legacy_peer: Option<&str>) -> Result<(), String> {
    let mut guard = SAVED.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    if guard.is_some() {
        return restore_locked(&mut guard, None);
    }
    let candidates = sweep_candidates(legacy_peer);
    let candidate_refs: Vec<&str> = candidates.iter().map(String::as_str).collect();
    // 救撰写入时同样不能把我们自己写的公网地址当候选（全局 DNS 可能是它的派生值）。
    let mut exclude_refs = candidate_refs.clone();
    exclude_refs.push(SYSTEM_DNS_TARGET);

    let mut cleaned = 0usize;
    let mut first_error: Option<String> = None;
    for key in service_dns_keys()? {
        let Some(service) = service_from_key(&key) else {
            continue;
        };
        let Ok((_, servers, _)) = read_service_dns(&service) else {
            continue;
        };
        let Some(peer) = leftover_peer(&servers, &candidate_refs) else {
            continue;
        };
        // **不能删键**：2026-11-11 真机验证，删掉服务级 DNS 键不会回到 DHCP，
        // 机器会直接「没有 nameserver、Not Reachable」，只能关开 Wi-Fi 才恢复。
        // 一个服务失败不中断其余服务。
        if let Err(error) = rescue_service_dns(&service, &[], &exclude_refs, None) {
            eprintln!("veyl-helper: 服务 {service} 的 DNS 改写失败：{error}");
            first_error.get_or_insert(error);
            continue;
        }
        cleaned += 1;
        eprintln!("veyl-helper: 服务 {service} 的 DNS 仍指向 {peer}，已改写成可用 DNS");
    }
    if cleaned > 0 {
        eprintln!("veyl-helper: 共清理 {cleaned} 个服务的 DNS 残留（没有原始快照可还原）");
    }
    match first_error {
        Some(error) => Err(error),
        None => Ok(()),
    }
}

/// 无快照清扫的候选：配置里的对端 + 旧常量，**去掉本次写入的公网地址**。
///
/// 配置里推得的对端在旧版本就是 `172.19.0.2`；单独抽出来是为了能测「用户把 DNS
/// 设成同值的公网地址时不被误清」。
fn sweep_candidates(legacy_peer: Option<&str>) -> Vec<String> {
    let mut candidates: Vec<String> = Vec::new();
    if let Some(peer) = legacy_peer {
        candidates.push(peer.to_string());
    }
    if !candidates.iter().any(|peer| peer == LEGACY_PEER) {
        candidates.push(LEGACY_PEER.to_string());
    }
    candidates.retain(|peer| peer != SYSTEM_DNS_TARGET);
    candidates
}

/// `list State:/Network/Service/.*/DNS` 的全部键。
///
/// scutil 的输出形如 `  subKey [0] = State:/Network/Service/<uuid>/DNS`。
fn service_dns_keys() -> Result<Vec<String>, String> {
    let text = scutil_script("open\nlist State:/Network/Service/.*/DNS\n")?;
    Ok(text
        .lines()
        .filter_map(|line| line.split_once('=').map(|(_, value)| value.trim()))
        .filter(|key| key.starts_with("State:/Network/Service/") && key.ends_with("/DNS"))
        .map(str::to_string)
        .collect())
}

/// 从 `State:/Network/Service/<uuid>/DNS` 里取出 uuid。
fn service_from_key(key: &str) -> Option<String> {
    key.strip_prefix("State:/Network/Service/")?
        .strip_suffix("/DNS")
        .map(str::to_string)
        .filter(|service| !service.is_empty() && !service.chars().any(char::is_whitespace))
}

/// 当前 DNS 值命中的候选地址（配置文件里的 + 兜底常量）。
fn leftover_peer<'a>(servers: &[String], candidates: &[&'a str]) -> Option<&'a str> {
    candidates
        .iter()
        .copied()
        .find(|peer| is_leftover(servers, *peer))
}

fn restore_locked(guard: &mut Option<SavedDns>, deadline: Option<Instant>) -> Result<(), String> {
    let Some(saved) = guard.clone() else {
        return Ok(());
    };
    if deadline_passed(deadline) {
        return Err("还原超过退出时限，已放弃".to_string());
    }
    let read = read_service_dns_within(&saved.service, deadline);
    apply_restore(guard, &saved, read, deadline)
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
    deadline: Option<Instant>,
) -> Result<(), String> {
    let current = match read {
        Ok((_, servers, _)) => servers,
        Err(error) => {
            *guard = None;
            return Err(error);
        }
    };
    // 救援时**不能**把我们自己写进去的地址当结果：全局 DNS 键此刻就是从我们的键
    // 派生的，读回来只有 223.5.5.5 时若照抄，等于「还原」成自己，用户的 DHCP /
    // 自定义 DNS 永远回不来。旧设计的对端同理。
    let exclude = [saved.written.as_str(), LEGACY_PEER];
    match restore_action(&current, saved) {
        RestoreAction::Nothing => {
            eprintln!(
                "veyl-helper: 系统 DNS 已被别处改写（当前 {current:?}），不写回旧网络的原始值"
            );
        }
        RestoreAction::Write { servers, search } => {
            if servers.is_empty() {
                // 只有 SearchDomains 的原始状态写不出去（写入会拒绝空服务器），
                // 退回兜底，总比把机器留在我们的地址上好。
                rescue_service_dns(&saved.service, &saved.global_servers, &exclude, deadline)?;
            } else {
                let refs: Vec<&str> = servers.iter().map(String::as_str).collect();
                let search_refs: Vec<&str> = search.iter().map(String::as_str).collect();
                write_and_confirm(&saved.service, &refs, &search_refs, deadline)?;
            }
        }
        RestoreAction::RemovePeer { remaining } => {
            // 用户连接期间手动加过 DNS：只摘掉我们的地址，其余保持；搜索域沿用快照。
            let (servers, search) = remove_peer_plan(saved, &remaining);
            let refs: Vec<&str> = servers.iter().map(String::as_str).collect();
            let search_refs: Vec<&str> = search.iter().map(String::as_str).collect();
            write_and_confirm(&saved.service, &refs, &search_refs, deadline)?;
        }
        RestoreAction::Rescue { use_snapshot } => {
            // 空键只能用现读的全局 DNS：快照是旧网络的，用了就串网。
            let snapshot: &[String] = if use_snapshot {
                &saved.global_servers
            } else {
                &[]
            };
            rescue_service_dns(&saved.service, snapshot, &exclude, deadline)?;
        }
    }
    *guard = None;
    if !deadline_passed(deadline) {
        let _ = super::flush_system_dns_within(deadline);
    }
    eprintln!("veyl-helper: 系统 DNS 已还原");
    Ok(())
}

/// 写入并回读确认：实际值必须与我们写的一致，否则报错让调用方保留快照。
///
/// `scutil set` 可能退出 0 却没生效；不回读就把快照清掉，机器会留在我们的地址上。
fn write_and_confirm(
    service: &str,
    servers: &[&str],
    search: &[&str],
    deadline: Option<Instant>,
) -> Result<(), String> {
    if deadline_passed(deadline) {
        return Err("写入超过退出时限，已跳过".to_string());
    }
    write_service_dns_within(service, servers, search, deadline)?;
    let expected: Vec<String> = servers.iter().map(|value| (*value).to_string()).collect();
    for _ in 0..VERIFY_ATTEMPTS {
        if deadline_passed(deadline) {
            break;
        }
        let (_, written, _) = read_service_dns_within(service, deadline)?;
        if written == expected {
            return Ok(());
        }
        std::thread::sleep(VERIFY_INTERVAL);
    }
    Err(format!("写入后回读不一致：期望 {expected:?}"))
}

/// 从配置里取第一个 TUN 入站的地址，算出对端（地址 + 1）。
/// **只用于识别旧版本留下的死地址**，不再作为接管目标。
fn configured_legacy_peer(config: &serde_json::Value) -> Option<String> {
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

/// 当前解析器是否**整组恰好**等于这个地址。
///
/// 清扫路径用严格相等：`172.19.0.2` 是常用私有网段地址，用户真把内网 DNS 设成
/// 它也合法，不能因为「包含」就在每次启动时把整组换掉。部分命中留给有快照的
/// `RemovePeer` 处理——那时我们确认过是自己写的。
fn is_leftover(servers: &[String], peer: &str) -> bool {
    servers == [peer.to_string()]
}

/// 从落盘的配置文件里取 TUN 对端（仅用于清扫旧版本残留；读不到就是 `None`）。
pub(super) fn legacy_peer_from_config(path: &std::path::Path) -> Option<String> {
    let text = std::fs::read_to_string(path).ok()?;
    let config: serde_json::Value = serde_json::from_str(&text).ok()?;
    configured_legacy_peer(&config)
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
    read_service_dns_within(service, None)
}

fn read_service_dns_within(
    service: &str,
    deadline: Option<Instant>,
) -> Result<(bool, Vec<String>, Vec<String>), String> {
    // 同上：`show` 才输出；键不存在时它打印 `No such key`，按「系统自动」处理。
    let text = scutil_script_within(
        &format!("open\nshow State:/Network/Service/{service}/DNS\n"),
        deadline,
    )?;
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
    write_service_dns_within(service, servers, search, None)
}

fn write_service_dns_within(
    service: &str,
    servers: &[&str],
    search: &[&str],
    deadline: Option<Instant>,
) -> Result<(), String> {
    if servers.is_empty() {
        // 2026-11-11 真机验证：没有 DNS 服务器的服务就是「Not Reachable」。
        // 任何路径都不许把机器写成这个状态——宁可报错让上层保留快照重试。
        return Err("拒绝写入空 DNS：机器会完全无法解析".to_string());
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
    scutil_script_within(&script, deadline).map(|_| ())
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

/// 读全局 DNS（`State:/Network/Global/DNS`），服务级没有原始值时用它兜底。
fn global_dns_servers() -> Result<Vec<String>, String> {
    global_dns_servers_within(None)
}

fn global_dns_servers_within(deadline: Option<Instant>) -> Result<Vec<String>, String> {
    let text = scutil_script_within("open\nshow State:/Network/Global/DNS\n", deadline)?;
    if !text.contains("<dictionary>") {
        return Ok(Vec::new());
    }
    Ok(parse_show(&text).array("ServerAddresses"))
}

/// 兜底该写哪组地址：快照里的全局 DNS 优先，其次现读的全局 DNS，最后兜底 DNS 223.5.5.5 / 119.29.29.29。
///
/// **永远不返回空**——空等于让机器没有解析。`exclude` 用来滤掉我们自己的地址
/// （崩溃残留时全局 DNS 也可能已经被污染成它）。
fn rescue_candidates(snapshot: &[String], live: &[String], exclude: &[&str]) -> Vec<String> {
    for source in [snapshot, live] {
        let values: Vec<String> = source
            .iter()
            .filter(|value| !value.is_empty() && !exclude.contains(&value.as_str()))
            .cloned()
            .collect();
        if !values.is_empty() {
            return values;
        }
    }
    PUBLIC_DNS.iter().map(|value| (*value).to_string()).collect()
}

/// 把服务级 DNS 改写成一组可用地址，并回读确认**不为空**。
///
/// 这是「绝不留下没有 DNS 的状态」的最后防线：删键不会回落到 DHCP，
/// 只能显式写一组地址进去。
fn rescue_service_dns(
    service: &str,
    snapshot_global: &[String],
    exclude: &[&str],
    deadline: Option<Instant>,
) -> Result<(), String> {
    if deadline_passed(deadline) {
        return Err("救援超过退出时限，已跳过".to_string());
    }
    let live = global_dns_servers_within(deadline).unwrap_or_default();
    let servers = rescue_candidates(snapshot_global, &live, exclude);
    let used_public = servers
        .iter()
        .all(|value| PUBLIC_DNS.contains(&value.as_str()));
    if used_public {
        eprintln!(
            "veyl-helper: [warn] 读不到任何全局 DNS，已写入兜底 DNS {servers:?}（阿里/腾讯）：用户可在系统设置里改回"
        );
    }
    let refs: Vec<&str> = servers.iter().map(String::as_str).collect();
    write_service_dns_within(service, &refs, &[], deadline)?;
    // 回读必须**命中我们写的候选之一**：写失败时键里可能还是旧的 peer，
    // 只判「非空」会把死地址当成功，然后清掉快照。
    for _ in 0..VERIFY_ATTEMPTS {
        if deadline_passed(deadline) {
            break;
        }
        let (_, written, _) = read_service_dns_within(service, deadline)?;
        if rescue_confirmed(&written, &servers) {
            if !deadline_passed(deadline) {
                let _ = super::flush_system_dns_within(deadline);
            }
            return Ok(());
        }
        std::thread::sleep(VERIFY_INTERVAL);
    }
    Err("写入兜底 DNS 后回读没有命中任何候选地址".to_string())
}

/// 救援回读的判定：键里必须出现**我们写的候选之一**，只判「非空」会把旧的 peer 当成功。
fn rescue_confirmed(written: &[String], candidates: &[String]) -> bool {
    written
        .iter()
        .any(|value| candidates.iter().any(|expected| expected == value))
}

/// 写入是否成功的判定：只看服务级键里有没有我们写入的地址。
///
/// 不把 `scutil --dns` 的 `resolver #1` 当判定条件——解析器编号与顺序会被系统重排。
fn readback_confirms(servers: &[String], target: &str) -> bool {
    servers.iter().any(|value| value == target)
}

fn verify_written(
    service: &str,
    target: &str,
    deadline: Option<Instant>,
) -> Result<(), String> {
    for _ in 0..VERIFY_ATTEMPTS {
        if deadline_passed(deadline) {
            break;
        }
        let (_, servers, _) = read_service_dns_within(service, deadline)?;
        if readback_confirms(&servers, target) {
            let hint = primary_nameserver();
            if hint.as_deref() != Some(target) {
                eprintln!(
                    "veyl-helper: 服务级 DNS 已含 {target}，但 resolver #1 是 {hint:?}；按写入成功处理"
                );
                log_resolver_head();
            }
            return Ok(());
        }
        std::thread::sleep(VERIFY_INTERVAL);
    }
    Err(format!(
        "写入后回读服务级 DNS 不含 {target}，按失败处理"
    ))
}

/// 把 `scutil --dns` 的头几行打进日志，下次真机失败能直接看出是哪种情形。
fn log_resolver_head() {
    let Some(text) = run_scutil(&["--dns"]) else {
        return;
    };
    let head: Vec<&str> = text.lines().take(8).collect();
    eprintln!("veyl-helper: scutil --dns 头部：{}", head.join(" | "));
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

/// 单次 scutil 调用的上限：卡住的 scutil 不能把退出路径或连接流程拖死。
const SCUTIL_TIMEOUT: Duration = Duration::from_millis(1500);

/// 单次调用的实际上限：不超过 `cap`，也不超过剩余预算（退出路径用）。
fn timeout_within(deadline: Option<Instant>, cap: Duration) -> Duration {
    match deadline {
        Some(at) => at.saturating_duration_since(Instant::now()).min(cap),
        None => cap,
    }
}

fn scutil_script(script: &str) -> Result<String, String> {
    scutil_script_within(script, None)
}

fn scutil_script_within(script: &str, deadline: Option<Instant>) -> Result<String, String> {
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
    let output = wait_with_timeout(child, timeout_within(deadline, SCUTIL_TIMEOUT))?;
    if !output.status.success() {
        return Err(format!(
            "scutil 执行失败：{}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

/// 等子进程退出，超时就杀掉。退出路径上不能有无限等待。
fn wait_with_timeout(
    mut child: std::process::Child,
    timeout: Duration,
) -> Result<std::process::Output, String> {
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            // `try_wait` 已经把退出状态收进 `Child`，`wait_with_output` 会直接用它。
            Ok(Some(_)) => {
                return child
                    .wait_with_output()
                    .map_err(|error| format!("读取 scutil 输出失败：{error}"))
            }
            Ok(None) if Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(20));
            }
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("scutil 超时，已终止".to_string());
            }
            Err(error) => return Err(format!("等待 scutil 失败：{error}")),
        }
    }
}

fn run_scutil(args: &[&str]) -> Option<String> {
    let child = Command::new(SCUTIL)
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .ok()?;
    let output = wait_with_timeout(child, SCUTIL_TIMEOUT).ok()?;
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
    fn the_configured_legacy_peer_comes_from_the_generated_config() {
        let config = serde_json::json!({
            "inbounds": [{ "type": "tun", "address": ["172.19.0.1/30"] }]
        });
        assert_eq!(configured_legacy_peer(&config).as_deref(), Some("172.19.0.2"));

        // 老形状（字符串）也认。
        let single = serde_json::json!({
            "inbounds": [{ "type": "tun", "address": "172.19.0.1/30" }]
        });
        assert_eq!(configured_legacy_peer(&single).as_deref(), Some("172.19.0.2"));

        assert_eq!(configured_legacy_peer(&serde_json::json!({})), None);
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

    /// 写入目标必须是**排除表之外**的公网 DNS。这是 2026-11-11 真机换来的结论：
    /// TUN 对端落在 `172.16.0.0/12` 里，查询出物理网卡后黑洞。
    #[test]
    fn the_takeover_address_is_a_public_resolver_not_the_tunnel_peer() {
        assert_eq!(SYSTEM_DNS_TARGET, "223.5.5.5");
        assert_ne!(SYSTEM_DNS_TARGET, LEGACY_PEER);
        let ip: std::net::Ipv4Addr = SYSTEM_DNS_TARGET.parse().unwrap();
        assert!(
            !ip.is_private() && !ip.is_loopback() && !ip.is_link_local() && !ip.is_multicast(),
            "落进排除段就会被 auto_route 放给物理网卡"
        );
    }

    #[test]
    fn restore_writes_back_the_original_values_not_empty() {
        let saved = SavedDns {
            service: "ABC".into(),
            written: SYSTEM_DNS_TARGET.into(),
            had_state: true,
            servers: vec!["10.0.0.53".into()],
            search: vec!["lan".into()],
            global_servers: Vec::new(),
        };
        assert_eq!(
            restore_action(&[SYSTEM_DNS_TARGET.to_string()], &saved),
            RestoreAction::Write {
                servers: vec!["10.0.0.53".into()],
                search: vec!["lan".into()],
            },
            "当前值仍是我们的，用户原来的自定义 DNS 必须还原，不能清成自动"
        );
    }

    /// 原本没有服务级 DNS：**不能删键**（删了机器就没 DNS），要用全局快照兜底。
    #[test]
    fn restore_rescues_with_the_global_snapshot_instead_of_removing() {
        let saved = SavedDns {
            service: "ABC".into(),
            written: SYSTEM_DNS_TARGET.into(),
            had_state: false,
            servers: Vec::new(),
            search: Vec::new(),
            global_servers: vec!["192.168.43.1".into()],
        };
        assert_eq!(
            restore_action(&[SYSTEM_DNS_TARGET.to_string()], &saved),
            RestoreAction::Rescue {
                use_snapshot: true
            }
        );
        assert_eq!(
            rescue_candidates(&saved.global_servers, &[], &[LEGACY_PEER]),
            vec!["192.168.43.1".to_string()],
            "写回全局快照里的地址，而不是空"
        );
    }

    /// 服务键是空的（用户清过、别的东西清过）：机器现在没有解析，必须救援。
    /// 此时**不许用快照**——那是旧网络的地址。
    #[test]
    fn an_empty_key_is_rescued_without_the_snapshot() {
        let saved = SavedDns {
            service: "ABC".into(),
            written: SYSTEM_DNS_TARGET.into(),
            had_state: false,
            servers: Vec::new(),
            search: Vec::new(),
            global_servers: vec!["192.168.1.1".into()],
        };
        assert_eq!(
            restore_action(&[], &saved),
            RestoreAction::Rescue {
                use_snapshot: false
            },
            "空键也要救援，而且不能用旧网络的快照"
        );
    }

    /// 用户连接期间手动加过 DNS：只摘掉我们的地址，其余保留。
    #[test]
    fn a_partial_list_only_drops_our_address() {
        let saved = SavedDns {
            service: "ABC".into(),
            written: SYSTEM_DNS_TARGET.into(),
            had_state: true,
            servers: vec!["10.0.0.53".into()],
            search: Vec::new(),
            global_servers: Vec::new(),
        };
        assert_eq!(
            restore_action(
                &[SYSTEM_DNS_TARGET.to_string(), "1.1.1.1".to_string()],
                &saved
            ),
            RestoreAction::RemovePeer {
                remaining: vec!["1.1.1.1".into()]
            },
            "我们写进去的地址不能留在列表里"
        );
    }

    /// 全局快照里残留旧设计的隧道对端时，不能把它当正常 DNS 写回去。
    #[test]
    fn a_stale_legacy_peer_in_the_global_snapshot_is_not_written_back() {
        assert_eq!(
            rescue_candidates(
                &[LEGACY_PEER.to_string()],
                &[],
                &["172.20.0.1", LEGACY_PEER]
            ),
            PUBLIC_DNS
                .iter()
                .map(|value| value.to_string())
                .collect::<Vec<_>>(),
            "旧常量也要被排除，落到兜底 DNS"
        );
    }

    /// 救援回读必须命中候选；键里还是旧对端时不能判成功。
    #[test]
    fn rescue_readback_must_hit_one_of_the_candidates() {
        let candidates = vec!["192.168.43.1".to_string()];
        assert!(rescue_confirmed(
            &["192.168.43.1".to_string()],
            &candidates
        ));
        assert!(
            !rescue_confirmed(&[LEGACY_PEER.to_string()], &candidates),
            "写入失败时键里还是旧对端，非空不等于成功"
        );
    }

    /// 崩溃兜底同样不能把机器留在「没有 DNS」：候选永远非空。
    #[test]
    fn rescue_never_leaves_dns_empty() {
        assert_eq!(
            rescue_candidates(&[], &[], &[LEGACY_PEER]),
            PUBLIC_DNS.iter().map(|value| value.to_string()).collect::<Vec<_>>(),
            "没有任何来源时写兜底 DNS，宁可改了用户的设置也不能让他没网"
        );
        assert_eq!(
            rescue_candidates(
                &[LEGACY_PEER.to_string()],
                &[LEGACY_PEER.to_string()],
                &[LEGACY_PEER]
            ),
            PUBLIC_DNS.iter().map(|value| value.to_string()).collect::<Vec<_>>(),
            "全局 DNS 也只剩旧对端时同样要落到兜底 DNS"
        );
    }

    /// 判定只看服务级键：resolver #1 被系统重排成别人也算成功。
    #[test]
    fn readback_accepts_our_target_regardless_of_resolver_order() {
        let target = SYSTEM_DNS_TARGET;
        assert!(readback_confirms(&[target.to_string()], target));
        assert!(readback_confirms(
            &["192.168.43.1".to_string(), target.to_string()],
            target
        ));
        assert!(!readback_confirms(&["192.168.43.1".to_string()], target));
    }

    /// 连接期间换了网络或用户手动改过 DNS：当前值已经不是我们的，
    /// 绝不能把上个网络的原始值写进新网络。
    #[test]
    fn restore_leaves_a_changed_dns_alone() {
        let saved = SavedDns {
            service: "ABC".into(),
            written: SYSTEM_DNS_TARGET.into(),
            had_state: true,
            servers: vec!["192.168.1.1".into()],
            search: Vec::new(),
            global_servers: Vec::new(),
        };
        assert_eq!(
            restore_action(&["192.168.43.1".to_string()], &saved),
            RestoreAction::Nothing,
            "网络换了就什么都别写，否则断连后完全解析不了"
        );
    }

    /// 快照丢失（helper 崩溃重启、active.json 已删）时仍要认出旧版本留下的对端。
    #[test]
    fn a_lost_snapshot_still_recognises_the_legacy_peer() {
        assert!(
            is_leftover(&[LEGACY_PEER.to_string()], LEGACY_PEER),
            "没有快照也要能清掉指向旧隧道对端的残留"
        );
        assert!(!is_leftover(&["192.168.43.1".to_string()], LEGACY_PEER));
        assert!(!is_leftover(&[], LEGACY_PEER));
    }

    /// 摘地址时也要摘掉旧设计留下的对端，且搜索域不能丢。
    #[test]
    fn removing_our_address_also_drops_the_stale_constant() {
        let saved = SavedDns {
            service: "ABC".into(),
            written: "172.20.0.1".into(),
            had_state: true,
            servers: vec!["10.0.0.53".into()],
            search: vec!["lan".into()],
            global_servers: Vec::new(),
        };
        assert_eq!(
            restore_action(
                &["172.20.0.1".to_string(), LEGACY_PEER.to_string()],
                &saved
            ),
            RestoreAction::Rescue {
                use_snapshot: false
            },
            "两个都是该死/过时的地址，不能改写成只剩旧对端的一组"
        );

        let (servers, search) = remove_peer_plan(&saved, &["1.1.1.1".to_string()]);
        assert_eq!(servers, vec!["1.1.1.1".to_string()]);
        assert_eq!(search, vec!["lan".to_string()], "搜索域是用户的，不能丢");
    }

    /// 崩溃清扫只认「整组恰好等于」：`172.19.0.2` 也是常用内网地址，
    /// 用户真这么配不能每次启动都被我们换掉。
    #[test]
    fn the_crash_sweep_only_touches_an_exact_match() {
        assert!(is_leftover(&[LEGACY_PEER.to_string()], LEGACY_PEER));
        assert!(
            !is_leftover(
                &[LEGACY_PEER.to_string(), "8.8.8.8".to_string()],
                LEGACY_PEER
            ),
            "包含不等于我们的残留，部分命中交给有快照的 RemovePeer"
        );
    }

    /// 崩溃清扫**不碰**我们新写入的公网地址：那是用户也可能自己设的可用 DNS，
    /// 没有可靠标记就不动，宁可留一组能用的。
    #[test]
    fn the_crash_sweep_never_touches_the_public_address_we_write() {
        let candidates = sweep_candidates(Some(SYSTEM_DNS_TARGET));
        assert!(
            !candidates.iter().any(|peer| peer == SYSTEM_DNS_TARGET),
            "即使配置推得的对端撞上公网地址，也不能把它当残留"
        );
        let refs: Vec<&str> = candidates.iter().map(String::as_str).collect();
        assert_eq!(
            leftover_peer(&[SYSTEM_DNS_TARGET.to_string()], &refs),
            None,
            "用户自己的 [223.5.5.5] 不能被清掉"
        );
        assert_eq!(
            leftover_peer(&[LEGACY_PEER.to_string()], &refs),
            Some(LEGACY_PEER)
        );
    }

    #[test]
    fn sweep_candidates_keep_both_legacy_peers() {
        assert_eq!(
            sweep_candidates(Some("172.20.0.1")),
            vec!["172.20.0.1".to_string(), LEGACY_PEER.to_string()]
        );
        assert_eq!(sweep_candidates(None), vec![LEGACY_PEER.to_string()]);
    }

    /// P1：全局 DNS 读到的就是我们自己写的地址时，不能把它当救援结果照抄回去——
    /// 否则「还原」成自己，用户原来的 DHCP / 自定义 DNS 永远回不来。
    #[test]
    fn rescue_does_not_copy_our_own_address_back() {
        let exclude = [SYSTEM_DNS_TARGET, LEGACY_PEER];
        assert_eq!(
            rescue_candidates(&[], &[SYSTEM_DNS_TARGET.to_string()], &exclude),
            PUBLIC_DNS
                .iter()
                .map(|value| value.to_string())
                .collect::<Vec<_>>(),
            "只剩我们自己的地址时要继续往下一级候选走"
        );
        assert_eq!(
            rescue_candidates(
                &[],
                &[SYSTEM_DNS_TARGET.to_string(), "192.168.1.1".to_string()],
                &exclude
            ),
            vec!["192.168.1.1".to_string()],
            "live 源里的真实地址要保留，只滤掉我们自己的"
        );
    }

    /// 捕获原始值时，混在列表里的旧对端也要摘掉——它排在 `nameserver[0]`
    /// 会让每次未命中缓存的查询先等它超时。
    #[test]
    fn capturing_the_original_drops_a_mixed_legacy_address() {
        let mut servers = vec![LEGACY_PEER.to_string(), "8.8.8.8".to_string()];
        let mut search = vec!["lan".to_string()];
        assert!(strip_legacy_peer(&mut servers, &mut search));
        assert_eq!(servers, vec!["8.8.8.8".to_string()]);
        assert_eq!(search, vec!["lan".to_string()], "用户的搜索域要留");

        let mut only = vec![LEGACY_PEER.to_string()];
        let mut search = vec!["lan".to_string()];
        assert!(!strip_legacy_peer(&mut only, &mut search));
        assert!(only.is_empty());
        assert!(search.is_empty(), "只剩我们的残留时按「本来没有」处理");
    }

    /// 这次事故的根因就是「写了一个被排除表覆盖的地址」。直接盯住固定排除表：
    /// 以后把目标改成 `100.64.x` / `198.18.x` 也必须让测试红。
    #[test]
    fn the_takeover_address_is_not_in_any_fixed_exclude() {
        let excludes = fixed_excludes_from_source();
        assert!(excludes.len() >= 10, "排除表解析失败：{excludes:?}");
        let target: std::net::Ipv4Addr = SYSTEM_DNS_TARGET.parse().unwrap();
        for entry in excludes {
            if let Some(hit) = cidr_contains_v4(&entry, target) {
                assert!(
                    !hit,
                    "目标地址 {SYSTEM_DNS_TARGET} 落在排除段 {entry} 里：查询会出隧道，整台机器解析超时"
                );
            }
        }
    }

    /// helper 刻意不链 `veyl_lib`，测试只能从源码里读固定排除表。
    fn fixed_excludes_from_source() -> Vec<String> {
        const SOURCE: &str = include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/src/tun/mod.rs"));
        let start = SOURCE
            .find("pub const FIXED_EXCLUDES: [&str; 15] = [")
            .expect("固定排除表改了形状，测试要跟着改");
        let body = &SOURCE[start..];
        let body = &body[body.find('[').expect("缺少数组起始")..];
        let end = body.find("];").expect("固定排除表没有结束");
        body[..end]
            .split('"')
            .skip(1)
            .step_by(2)
            .map(str::to_string)
            .collect()
    }

    fn cidr_contains_v4(cidr: &str, ip: std::net::Ipv4Addr) -> Option<bool> {
        let (address, length) = cidr.split_once('/')?;
        let base: std::net::Ipv4Addr = address.parse().ok()?;
        let length: u32 = length.parse().ok()?;
        if length > 32 {
            return None;
        }
        let mask = if length == 0 { 0 } else { u32::MAX << (32 - length) };
        Some((u32::from(ip) & mask) == (u32::from(base) & mask))
    }

    #[test]
    fn the_first_snapshot_wins_across_repeated_starts() {
        // 模拟「第二次 start」：已经记过原始值，就不能拿当前值（我们设的地址）覆盖它。
        let first = SavedDns {
            service: "ABC".into(),
            written: SYSTEM_DNS_TARGET.into(),
            had_state: true,
            servers: vec!["10.0.0.53".into()],
            search: Vec::new(),
            global_servers: Vec::new(),
        };
        let mut slot = Some(first.clone());
        let current = SavedDns {
            service: "ABC".into(),
            written: SYSTEM_DNS_TARGET.into(),
            had_state: true,
            servers: vec![SYSTEM_DNS_TARGET.into()],
            search: Vec::new(),
            global_servers: Vec::new(),
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

    /// TUN 地址改过之后，旧残留还在旧常量上：两个候选都要试。
    #[test]
    fn a_leftover_is_cleared_even_when_the_config_address_changed() {
        let candidates = ["172.20.0.1", LEGACY_PEER];
        assert_eq!(
            leftover_peer(&[LEGACY_PEER.to_string()], &candidates),
            Some(LEGACY_PEER),
            "配置换了地址，旧残留要按旧常量认出来"
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
            written: SYSTEM_DNS_TARGET.into(),
            had_state: true,
            servers: vec!["10.0.0.53".into()],
            search: Vec::new(),
            global_servers: Vec::new(),
        };
        let mut slot = Some(saved.clone());
        let result = apply_restore(&mut slot, &saved, Err("No such key".into()), None);
        assert!(result.is_err());
        assert_eq!(slot, None, "读不回来宁可丢原始值，也不能下次写错服务");
    }

    /// 旧版本崩溃留下的对端不算原始值；但公网目标可能是用户自己设的，必须照常记录。
    #[test]
    fn a_legacy_peer_left_behind_is_not_recorded_as_the_original() {
        assert!(is_leftover(&[LEGACY_PEER.to_string()], LEGACY_PEER));
        assert!(!is_leftover(&["10.0.0.53".to_string()], LEGACY_PEER));
        assert!(!is_leftover(&[], LEGACY_PEER));
        assert!(
            !is_leftover(&[SYSTEM_DNS_TARGET.to_string()], LEGACY_PEER),
            "223.5.5.5 是用户可能自己设的值，不能当残留清掉"
        );
    }

    #[test]
    fn joining_rejects_values_that_could_inject_commands() {
        assert!(join_tokens(&["1.1.1.1", "8.8.8.8"]).is_ok());
        assert!(join_tokens(&["1.1.1.1\nremove State:/Network/Global"]).is_err());
        assert!(join_tokens(&["a b"]).is_err());
        assert!(join_tokens(&[""]).is_err());
    }
}
