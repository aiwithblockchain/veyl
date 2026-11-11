//! 特权 helper：以 root 运行，通过 XPC 接受**已验签的 App** 的 start/stop/status。
//!
//! 三条硬规则：
//! 1. 任何请求进来之前先验对端签名，验不过直接断开，不读消息。
//! 2. 请求里不采信任何路径：运行时从我们自己的 bundle 取、配置由我们改写、
//!    日志与 pid 落在我们自己的目录。
//! 3. 只做 tun 入站、只开回环 Clash API。
//!
//! 这个 bin 刻意不 `use veyl_lib`，只链 libxpc / Security / CoreFoundation / sha2，
//! 避免把整个 Tauri 依赖图拖进一个 root 进程。

#[path = "../../veyl_paths.rs"]
mod veyl_paths;
#[path = "../../tun/protocol.rs"]
mod protocol;
#[path = "../../tun/trust.rs"]
#[allow(dead_code)]
mod trust;
#[path = "../../tun/xpc.rs"]
#[allow(dead_code)] // 与主程序共用同一份绑定，helper 只用服务端那几个
mod xpc;

use std::ffi::{c_char, c_void};
use std::io::Write;
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use protocol::ProtocolError;
use xpc::xpc_object_t;

mod dns;

/// 进程退出时还原系统 DNS。`restart` 走 `exit(75)`，不放回收拾会把 DNS 留指向隧道。
extern "C" fn restore_dns_at_exit() {
    dns::restore_at_exit();
}

static SHUTDOWN: AtomicBool = AtomicBool::new(false);

/// `restart` 的退出码（`EX_TEMPFAIL`）。launchd 的 KeepAlive 只对非零退出重启。
const RESTART_EXIT_CODE: i32 = 75;

/// 没有子进程、没有租约、最近请求超过这个时长 → 主动 exit(0)。
/// 0 是正常退出，`KeepAlive.SuccessfulExit=false` 不会把它拉起来。
const IDLE_EXIT_AFTER: Duration = Duration::from_secs(10 * 60);
const IDLE_CHECK_INTERVAL: Duration = Duration::from_secs(30);
/// 租约断开后等多久再停隧道：给 App 重连/重启留出窗口。
const LEASE_LOSS_GRACE: Duration = Duration::from_secs(5);
/// 连接期复核系统 DNS 的最小间隔：`status` 是轮询热路径，`scutil` 要起进程。
const DNS_RECHECK_INTERVAL: Duration = Duration::from_secs(5);

/// 崩溃循环打断：10 分钟内第 3 次启动就正常退出，避免无限拉起。
const CRASH_LOOP_WINDOW: u64 = 10 * 60;
const CRASH_LOOP_LIMIT: usize = 3;

/// 纯判定：没有子进程、没有租约、没有正在处理的请求，且静默够久。
fn should_exit_idle(running: bool, leases: usize, in_flight: usize, idle: Duration) -> bool {
    !running && leases == 0 && in_flight == 0 && idle >= IDLE_EXIT_AFTER
}

/// 纯判定：租约全部丢失后应当做什么。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum LeaseLossAction {
    /// 有新租约、或有新的 start：什么都不做。
    Ignore,
    /// 没有租约也没有新 start：停隧道再退出。
    StopAndExit,
    /// 没有租约也没有隧道：直接退出。
    Exit,
}

/// `generation_changed`：租约断开后又有新的 start（新实例接手），不能动它。
///
/// 已知限制：另一个实例存活（租约非空）但不再新建连接时，崩溃方留下的隧道
/// 会一直残留到该实例退出或发起下一次 start。受 macOS 单实例约束，正常路径
/// 不会出现；这里不按连接指针区分 owner——start 与租约是两条不同的连接，
/// 指针比较既不可靠，还可能因地址复用误停别人的隧道。
fn lease_loss_action(
    leases: usize,
    running: bool,
    generation_changed: bool,
) -> LeaseLossAction {
    if generation_changed || leases > 0 {
        LeaseLossAction::Ignore
    } else if running {
        LeaseLossAction::StopAndExit
    } else {
        LeaseLossAction::Exit
    }
}

/// 纯判定：按启动时间戳（Unix 秒）判断是否进入崩溃循环。
fn crash_loop_tripped(starts: &[u64], now: u64) -> bool {
    starts
        .iter()
        .filter(|at| now.saturating_sub(**at) <= CRASH_LOOP_WINDOW)
        .count()
        >= CRASH_LOOP_LIMIT
}

/// helper 自己的 sing-box 日志上限与保留份数（GAP-02）。
/// 保留上一份而不是直接清空：排障时要看的是上一次连接的后半段。
const TUN_LOG_MAX_BYTES: u64 = 5 * 1024 * 1024;
const TUN_LOG_KEEP: usize = 1;

/// `start` 的准备阶段上限。
///
/// 只约束**规则就绪之后**的 spawn + `sing-box check`；等待规则另有 15 秒上限，
/// 运行时暂存与验签发生在更早的 `resolve_runtime`，不在这个预算里。客户端等 90 秒
/// （见 `TUN_REPLY_DEADLINE_START`），这里留出足够余量给收尾与 IPC。
const START_PREPARE_DEADLINE: Duration = Duration::from_secs(25);

/// 首连等待规则就绪的上限。
///
/// 必须**短于**客户端的 start 期限（90 秒）：后台线程还在解包时，
/// 连接宁可快点返回「正在准备」，也不要让客户端先超时、用户重试又排在
/// 这次等待后面。超时不会 spawn，也不会留下孤儿。
const RULES_WAIT_DEADLINE: Duration = Duration::from_secs(15);

/// `sing-box check` 的上限。挂住的 check 会一直占着 `start_lock`，
/// 后面的 start/stop 全被堵死。
const CHECK_TIMEOUT: Duration = Duration::from_secs(20);

/// helper 自己的诊断日志上限；超了直接重开，避免无限增长。
const HELPER_LOG_MAX_BYTES: u64 = 1024 * 1024;

/// 规则预置的进度。监听先起，后台线程负责解包，`start` 只等结果。
#[derive(Debug, Clone, PartialEq, Eq)]
enum RulesState {
    Pending,
    Ready,
    Failed { code: &'static str, message: String },
}

/// 跑 `sing-box check`，带超时。
///
/// `Command::output()` 没有超时：check 一旦挂住就会一直占着 `start_lock`，
/// 后面的 start 与 stop 全部被堵死。
fn check_config(
    binary: &Path,
    config: &Path,
    timeout: Duration,
) -> Result<std::process::Output, ProtocolError> {
    let mut child = Command::new(binary)
        .arg("check")
        .arg("-c")
        .arg(config)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| {
            ProtocolError::new(
                protocol::ERR_RUNTIME_MISSING,
                format!("无法执行运行时：{error}"),
            )
        })?;

    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => {
                return child.wait_with_output().map_err(|error| {
                    ProtocolError::new(
                        protocol::ERR_TUN_START_FAILED,
                        format!("读取校验结果失败：{error}"),
                    )
                })
            }
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(50)),
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(ProtocolError::new(
                    protocol::ERR_TUN_START_FAILED,
                    format!("配置校验超过 {} 秒，已终止", timeout.as_secs()),
                ));
            }
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(ProtocolError::new(
                    protocol::ERR_TUN_START_FAILED,
                    format!("等待配置校验失败：{error}"),
                ));
            }
        }
    }
}

/// 准备阶段的让路判定。拆成纯函数，便于直接断言「stop 打断 start」与「超时放弃」。
fn check_start_allowed(stop_requested: bool, elapsed: Duration) -> Result<(), ProtocolError> {
    if stop_requested {
        return Err(ProtocolError::new(
            protocol::ERR_TUN_START_FAILED,
            "启动被停止请求取消",
        ));
    }
    if elapsed > START_PREPARE_DEADLINE {
        return Err(ProtocolError::new(
            protocol::ERR_TUN_START_FAILED,
            format!(
                "启动准备超过 {} 秒仍未就绪，已放弃（规则或运行时可能还在准备）",
                START_PREPARE_DEADLINE.as_secs()
            ),
        ));
    }
    Ok(())
}

/// 运行时的签名 identifier。裸 Mach-O 没有 Info.plist，codesign 用文件名作 identifier。
/// `staged_runtime_signature_valid` 钉住它，打包脚本也有同样的断言。
const RUNTIME_IDENTIFIER: &str = "sing-box";

/// 运行时文件的上限。真实的 universal sing-box 约 173 MB；
/// 超过这个数只可能是读错对象（或有人塞了个大文件），没必要读进内存。
const MAX_RUNTIME_BYTES: u64 = 256 * 1024 * 1024;

extern "C" fn on_signal(_signal: libc::c_int) {
    SHUTDOWN.store(true, Ordering::SeqCst);
}

pub fn run() {
    if !is_root() {
        eprintln!("veyl-helper: 必须以 root 运行");
        std::process::exit(1);
    }
    // 任何 exit 路径都先把系统 DNS 还回去（含 restart 的 exit(75)）。
    unsafe { libc::atexit(restore_dns_at_exit) };

    let root = match prepare_trust_root() {
        Ok(root) => root,
        Err(error) => {
            // 不合规就退出，不降级、不「修好」——修好等于把别人建的东西合法化。
            eprintln!("veyl-helper: 信任根校验失败：{error}");
            std::process::exit(2);
        }
    };

    if crash_loop_tripped_now(&root) {
        eprintln!("veyl-helper: 10 分钟内第 3 次启动，正常退出以打断崩溃循环");
        std::process::exit(0);
    }
    let _ = HELPER_BUILD.set(self_cdhash().unwrap_or_default());

    let supervisor = Arc::new(Supervisor::new(root));
    // 必须在监听起来之前完成：sweep 与任何 start 不能并发。
    let sweep_started = Instant::now();
    supervisor.sweep_stale();
    supervisor.note(&format!(
        "启动 sweep={}ms",
        sweep_started.elapsed().as_millis()
    ));

    // 规则解包 + 逐项校验是首跑最慢的一步（真机 2233 个规则集约 30 秒）。
    // 放到后台线程做、监听先起：`start` 只等结果（最多 `RULES_WAIT_DEADLINE`），
    // 不能因为解包比客户端期限（90 秒）还慢就必然失败。
    let staging = Arc::clone(&supervisor);
    std::thread::spawn(move || {
        let started = Instant::now();
        let outcome = staging.ensure_rules_staged();
        staging.record_rules(outcome, started.elapsed());
    });

    // SAFETY: 处理器只写一个原子变量。
    unsafe {
        libc::signal(
            libc::SIGTERM,
            on_signal as extern "C" fn(libc::c_int) as libc::sighandler_t,
        );
        libc::signal(
            libc::SIGINT,
            on_signal as extern "C" fn(libc::c_int) as libc::sighandler_t,
        );
    }

    let watchdog = Arc::clone(&supervisor);
    std::thread::spawn(move || {
        while !SHUTDOWN.load(Ordering::SeqCst) {
            std::thread::sleep(Duration::from_millis(200));
        }
        watchdog.stop();
        clear_start_record(&watchdog.root);
        std::process::exit(0);
    });

    spawn_idle_watchdog(Arc::clone(&supervisor));

    serve(supervisor);
}

/// 监听 Mach service，对每个新连接先验签再挂消息处理器。
fn serve(supervisor: Arc<Supervisor>) -> ! {
    use block2::RcBlock;

    let listener = xpc::create_listener(protocol::MACH_SERVICE);
    if listener.is_null() {
        eprintln!("veyl-helper: 无法创建监听（Mach service 未注册？）");
        std::process::exit(3);
    }

    // 在连接建立时由 libxpc 校验对端签名，从根上消掉「取 pid 之后再验」的窗口。
    if let Err(error) =
        unsafe { xpc::set_peer_code_signing_requirement(listener, &protocol::app_requirement()) }
    {
        eprintln!("veyl-helper: {error}");
        std::process::exit(4);
    }

    let listener_handler: RcBlock<dyn Fn(xpc_object_t)> =
        RcBlock::new(move |event: xpc_object_t| {
            if unsafe { xpc::is_error(event) } {
                eprintln!("veyl-helper: 监听器事件：{}", unsafe {
                    xpc::describe(event)
                });
                return;
            }

            let connection = event;
            // 监听器已经过滤不满足 requirement 的消息；这里对连接本身再设一次，
            // 双向兜底（对每个连接只能设一次）。
            if let Err(error) = unsafe {
                xpc::set_peer_code_signing_requirement(connection, &protocol::app_requirement())
            } {
                eprintln!("veyl-helper: 拒绝连接：{error}");
                unsafe { xpc::cancel(connection) };
                return;
            }

            // 并发队列：`start` 可能准备几十秒，`stop` 不能被它堵在主队列上。
            // 每个连接一个 handler，不同连接之间就能并发执行。
            // 必须在 resume 之前设置。
            unsafe { xpc::set_target_queue(connection, xpc::global_queue()) };

            let per_connection = Arc::clone(&supervisor);
            let handler: RcBlock<dyn Fn(xpc_object_t)> =
                RcBlock::new(move |message: xpc_object_t| {
                    if unsafe { xpc::is_error(message) } {
                        // 连接失效：如果它持有租约，5 秒后按租约数与 generation
                        // 决定是否停隧道。
                        let generation = per_connection.generation.load(Ordering::SeqCst);
                        if per_connection.release_lease(connection) {
                            spawn_lease_loss_check(&per_connection, generation);
                        }
                        return;
                    }
                    handle_message(&per_connection, connection, message);
                });
            // block 必须活得和连接一样久；leak 是刻意的。
            let raw = RcBlock::as_ptr(&handler) as *mut c_void;
            std::mem::forget(handler);
            unsafe { xpc::set_event_handler(connection, raw) };
            unsafe { xpc::resume(connection) };
        });

    let raw = RcBlock::as_ptr(&listener_handler) as *mut c_void;
    std::mem::forget(listener_handler);
    unsafe { xpc::set_event_handler(listener, raw) };
    unsafe { xpc::resume(listener) };

    unsafe { dispatch_main() }
}

fn handle_message(
    supervisor: &Supervisor,
    connection: xpc::xpc_connection_t,
    message: xpc_object_t,
) {
    // 处理期间不参与空闲退出；同时刷新「最近请求」。
    let _request = supervisor.begin_request();
    // 日志归属按**这条消息的连接**取；切换用户后另一条连接会拿到自己的 uid。
    let euid = unsafe { xpc::connection_euid(connection) };

    let method = unsafe { xpc::dict_get_string(message, "method") }.unwrap_or_default();
    let reply = unsafe { xpc::make_reply(message) };

    let outcome: Result<(), ProtocolError> = match method.as_str() {
        "start" => {
            let raw = unsafe { xpc::dict_get_data(message, "config") }.unwrap_or_default();
            let config = String::from_utf8_lossy(&raw).to_string();
            match supervisor.start(&config, euid) {
                Ok(started) => {
                    unsafe { xpc::dict_set_bool(reply, "ok", true) };
                    unsafe { xpc::dict_set_int64(reply, "pid", started.pid as i64) };
                    unsafe { xpc::dict_set_string(reply, "clash_addr", &started.clash_addr) };
                    unsafe { xpc::dict_set_string(reply, "clash_secret", &started.clash_secret) };
                    unsafe { xpc::dict_set_string(reply, "since", &started.since) };
                    unsafe {
                        xpc::dict_set_bool(reply, "dns_applied", started.dns.applied);
                    }
                    if let Some(reason) = &started.dns.reason {
                        unsafe { xpc::dict_set_string(reply, "dns_reason", reason) };
                    }
                    Ok(())
                }
                Err(error) => Err(error),
            }
        }
        "stop" => {
            supervisor.stop();
            unsafe { xpc::dict_set_bool(reply, "ok", true) };
            Ok(())
        }
        // restart：start 正在进行时拒绝（precondition_failed），否则先停掉
        // 已登记的隧道，再回 ok 并 exit(75)。这样不会把 root sing-box 留给
        // 新 helper 去 sweep，也不会与并发 start 抢子进程。
        // `_guard` 一直持有到进程退出，并发 start 无法在回复与退出之间插进来。
        "restart" => match supervisor.start_lock.try_lock() {
            Ok(_guard) => {
                supervisor.stop_child("restart");
                unsafe { xpc::dict_set_bool(reply, "ok", true) };
                unsafe { xpc::send_message(connection, reply) };
                unsafe { xpc::release(reply) };
                // 给 libxpc 一点时间把回复排出去；退出码 75 由 KeepAlive 拉起新映像。
                std::thread::sleep(Duration::from_millis(100));
                supervisor.note("restart：回复后以 75 退出，等待 launchd 拉起新映像");
                clear_start_record(&supervisor.root);
                std::process::exit(RESTART_EXIT_CODE);
            }
            Err(_) => Err(ProtocolError::new(
                protocol::ERR_PRECONDITION_FAILED,
                "正在启动连接，稍后再重启后台组件",
            )),
        },
        // 会话租约：连接保持打开，断开事件由事件处理器释放。
        "lease" => {
            supervisor.register_lease(connection);
            unsafe { xpc::dict_set_bool(reply, "ok", true) };
            Ok(())
        }
        // 降级兜底：App 崩溃、helper 重启后原始快照已经丢了，
        // 但系统 DNS 可能还指着旧版本写进去的隧道对端。只清那种整组残留，
        // 不碰我们新写的公网地址（它自己能解析，也可能本来就是用户设的）。
        "restore_dns" => {
            let legacy = dns::legacy_peer_from_config(&supervisor.config_path());
            match dns::restore_or_clear(legacy.as_deref()) {
                Ok(()) => {
                    unsafe { xpc::dict_set_bool(reply, "ok", true) };
                    Ok(())
                }
                Err(message) => Err(ProtocolError::new(protocol::ERR_INTERNAL, message)),
            }
        }
        // 只有 root 能 HUP mDNSResponder：普通用户执行 killall 会失败，
        // 而 `dscacheutil -flushcache` 即使返回 0 也清不掉它的缓存。
        // 强制重置与 TUN 回滚都依赖这条路径。
        "flush_dns" => match flush_system_dns() {
            Ok(()) => {
                unsafe { xpc::dict_set_bool(reply, "ok", true) };
                Ok(())
            }
            Err(message) => Err(ProtocolError::new(protocol::ERR_INTERNAL, message)),
        },
        "status" => {
            let status = supervisor.status();
            unsafe { xpc::dict_set_bool(reply, "ok", true) };
            unsafe { xpc::dict_set_bool(reply, "running", status.is_some()) };
            if let Some(build) = helper_build() {
                unsafe { xpc::dict_set_string(reply, "helper_build", build) };
            }
            unsafe {
                xpc::dict_set_string(reply, "helper_version", env!("CARGO_PKG_VERSION"))
            };
            match status {
                Some(running) => {
                    unsafe { xpc::dict_set_int64(reply, "pid", running.pid as i64) };
                    unsafe { xpc::dict_set_string(reply, "clash_addr", &running.clash_addr) };
                    unsafe { xpc::dict_set_string(reply, "clash_secret", &running.clash_secret) };
                    unsafe { xpc::dict_set_string(reply, "since", &running.since) };
                    // DNS 接管结果随之回报：设置失败时界面要能说「国外网站可能较慢」。
                    if let Some(dns) = supervisor.last_dns() {
                        unsafe { xpc::dict_set_bool(reply, "dns_applied", dns.applied) };
                        if let Some(reason) = &dns.reason {
                            unsafe { xpc::dict_set_string(reply, "dns_reason", reason) };
                        }
                    }
                }
                // 未运行时三项都不写，客户端按缺失处理成 null（契约 §3.2）。
                None => {
                    unsafe { xpc::dict_set_int64(reply, "pid", 0) };
                }
            }
            Ok(())
        }
        other => Err(ProtocolError::new(
            protocol::ERR_BAD_REQUEST,
            format!("未知方法：{other}"),
        )),
    };

    if let Err(error) = outcome {
        unsafe { xpc::dict_set_bool(reply, "ok", false) };
        unsafe { xpc::dict_set_string(reply, "code", error.code) };
        unsafe { xpc::dict_set_string(reply, "message", &error.message) };
    }

    unsafe { xpc::send_message(connection, reply) };
    unsafe { xpc::release(reply) };
}

// ---------------------------------------------------------------------------
// 系统 DNS
// ---------------------------------------------------------------------------

/// 以 root 刷新系统 DNS。
///
/// 两条都要跑：`dscacheutil` 清目录服务缓存，`killall -HUP` 才是让
/// mDNSResponder 丢掉解析缓存的那一步。普通用户跑第二条会直接失败，
/// 所以这条能力必须留在特权侧。
fn flush_system_dns() -> Result<(), String> {
    flush_system_dns_within(None)
}

/// `deadline` 是退出路径的总预算：flush 只是收尾，超了就跳过，不能拖住 launchd。
fn flush_system_dns_within(deadline: Option<Instant>) -> Result<(), String> {
    if deadline.is_some_and(|at| Instant::now() >= at) {
        eprintln!("veyl-helper: [warn] 还原超过退出时限，跳过 DNS 缓存刷新");
        return Ok(());
    }
    let mut failures = Vec::new();
    if let Err(error) = run_command_within("/usr/bin/dscacheutil", &["-flushcache"], deadline) {
        failures.push(format!("dscacheutil：{error}"));
    }
    if let Err(error) = run_command_within("/usr/bin/killall", &["-HUP", "mDNSResponder"], deadline) {
        failures.push(format!("mDNSResponder：{error}"));
    }
    if failures.is_empty() {
        Ok(())
    } else {
        Err(failures.join("；"))
    }
}

/// 单次外部命令的上限：退出路径上不能有无限等待——`dscacheutil` 卡住会让
/// launchd 等不到旧进程退出。
const COMMAND_TIMEOUT: Duration = Duration::from_millis(1500);

/// 仅测试用的无预算版本（生产路径都带退出预算）。
#[cfg(test)]
fn run_command(program: &str, args: &[&str]) -> Result<(), String> {
    run_command_within(program, args, None)
}

fn run_command_within(
    program: &str,
    args: &[&str],
    budget: Option<Instant>,
) -> Result<(), String> {
    let mut child = Command::new(program)
        .args(args)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| error.to_string())?;
    let timeout = budget.map_or(COMMAND_TIMEOUT, |at| {
        at.saturating_duration_since(Instant::now()).min(COMMAND_TIMEOUT)
    });
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(status)) if status.success() => return Ok(()),
            Ok(Some(status)) => return Err(format!("退出状态 {status}")),
            Ok(None) if Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(20));
            }
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("命令超时，已终止".to_string());
            }
            Err(error) => return Err(error.to_string()),
        }
    }
}

// ---------------------------------------------------------------------------
// Supervisor
// ---------------------------------------------------------------------------
struct Started {
    pid: u32,
    clash_addr: String,
    clash_secret: String,
    since: String,
    /// 系统 DNS 是否已指向隧道。失败不影响连接，但必须如实回报。
    dns: dns::DnsHijack,
}

/// 正在运行的那个 sing-box 的完整信息。
///
/// App 只崩自己、不会崩 helper，所以 App 重启后 `status` 必须还能拿到
/// `clash_api` 与 `since`（契约 §3.2 第 6 条）；这几项只在 helper 内存里活，
/// helper 自己重启时 `sweep_stale` 会先把旧进程收掉，不会留下错位状态。
#[derive(Debug, Clone)]
struct Running {
    pid: u32,
    clash_addr: String,
    clash_secret: String,
    since: String,
}

struct RequestGuard<'a> {
    supervisor: &'a Supervisor,
}

impl Drop for RequestGuard<'_> {
    fn drop(&mut self) {
        self.supervisor.in_flight.fetch_sub(1, Ordering::SeqCst);
    }
}

/// presence 租约断开后等 5 秒再判：期间 App 重启/重连会重新登记租约。
///
/// 租约是 **App 启动到退出** 的存活信号：没有新租约说明 App 已经不在了。
/// 还有隧道就先停，然后正常退出（0）；KeepAlive 不会拉起，下一次请求由
/// launchd 按需启动。
fn spawn_lease_loss_check(supervisor: &Arc<Supervisor>, generation: u64) {
    let supervisor = Arc::clone(supervisor);
    std::thread::spawn(move || {
        std::thread::sleep(LEASE_LOSS_GRACE);
        let leases = supervisor.lease_count();
        let running = supervisor.status().is_some();
        let generation_changed = supervisor.generation.load(Ordering::SeqCst) != generation;
        match lease_loss_action(leases, running, generation_changed) {
            LeaseLossAction::Ignore => {}
            LeaseLossAction::StopAndExit => {
                supervisor.note("[diag] presence 租约断开且无新租约，停止隧道后退出");
                supervisor.stop_child("lease_lost");
                clear_start_record(&supervisor.root);
                std::process::exit(0);
            }
            LeaseLossAction::Exit => {
                supervisor.note("[diag] presence 租约断开且无隧道，退出");
                clear_start_record(&supervisor.root);
                std::process::exit(0);
            }
        }
    });
}

/// 空闲退出：无子进程、无租约、无请求，静默 10 分钟就正常退出。
/// 正常退出（0）不会触发 KeepAlive，下次 status/start 由 launchd 按需拉起。
fn spawn_idle_watchdog(supervisor: Arc<Supervisor>) {
    std::thread::spawn(move || loop {
        std::thread::sleep(IDLE_CHECK_INTERVAL);
        let running = supervisor.status().is_some();
        let leases = supervisor.lease_count();
        let in_flight = supervisor.in_flight.load(Ordering::SeqCst);
        if should_exit_idle(running, leases, in_flight, supervisor.idle_for()) {
            supervisor.note("空闲退出：无连接、无租约、10 分钟无请求");
            clear_start_record(&supervisor.root);
            std::process::exit(0);
        }
    });
}

struct Supervisor {
    root: PathBuf,
    child: Mutex<Option<Child>>,
    /// 与 `child` 同生共死；`status` 用它回答 clash 地址与启动时刻。
    running: Mutex<Option<Running>>,
    /// 外部 stop 请求。`start` 在准备阶段与 spawn 前后据此让路，
    /// 否则 client 超时后的 stop 只能干等 start 跑完。
    stop_requested: AtomicBool,
    /// 串行化 `start`。处理器现在跑在并发队列上，两次 start 并发会各自
    /// spawn 一个，后登记的覆盖前一个 child，留下没人管的 root 进程。
    /// `stop` 不能抢这把锁——它必须能在 start 进行中插进来。
    start_lock: Mutex<()>,
    /// 每次 start 递增。老的 `stop_child` 等完子进程后只能清理它那一代的
    /// config/pid，不能把新 start 刚写好的文件删掉。
    generation: AtomicU64,
    rules: Mutex<RulesState>,
    /// 每个连接用户一份日志：helper 是系统级 daemon，可能先后服务多个用户。
    user_logs: Mutex<std::collections::HashMap<u32, Arc<UserLogs>>>,
    /// 还没有连接用户时产生的日志行，灌进第一份用户日志。
    pending_notes: Mutex<Vec<String>>,
    /// 最近一次接入的用户。没有连接上下文的 note（例如规则预置完成）
    /// 优先写进它，避免日志建成之后还一直堆在 pending 里。
    last_uid: Mutex<Option<u32>>,
    /// TUN 运行期间 App 保持的会话租约（按连接指针记）。
    leases: Mutex<std::collections::HashSet<usize>>,
    /// 最近一次连接的系统 DNS 接管结果。`None` = 没有连接或已停止。
    /// 单独存一份而不是塞进 `Running`：激活发生在 `register_child` 之后，
    /// 但 status 可能在激活完成前被问到。
    last_dns: Mutex<Option<dns::DnsHijack>>,
    /// 本次连接写进系统的地址（公网 DNS）；连接期复核用。
    dns_target: Mutex<Option<String>>,
    /// 上一次复核系统 DNS 的时刻。轮询很频繁，`scutil` 要起进程，必须节流。
    dns_checked_at: Mutex<Option<Instant>>,
    /// 最近一次请求时刻。空闲退出用它判断「真的没人用了」。
    last_request: Mutex<Instant>,
    /// 正在处理的请求数。空闲退出不能在处理中退出。
    in_flight: AtomicUsize,
}

impl Supervisor {
    fn new(root: PathBuf) -> Self {
        Self {
            root,
            child: Mutex::new(None),
            running: Mutex::new(None),
            stop_requested: AtomicBool::new(false),
            start_lock: Mutex::new(()),
            generation: AtomicU64::new(0),
            rules: Mutex::new(RulesState::Pending),
            user_logs: Mutex::new(std::collections::HashMap::new()),
            pending_notes: Mutex::new(Vec::new()),
            last_uid: Mutex::new(None),
            leases: Mutex::new(std::collections::HashSet::new()),
            last_dns: Mutex::new(None),
            dns_target: Mutex::new(None),
            dns_checked_at: Mutex::new(None),
            last_request: Mutex::new(Instant::now()),
            in_flight: AtomicUsize::new(0),
        }
    }

    /// 取（必要时创建）某个用户的日志。uid 来自处理这条消息的连接，
    /// 不能钉死成首个对端——A 连完切到 B 时，B 的日志必须写进 B 的家目录。
    /// 请求开始/结束的计数守卫：空闲退出不能在请求处理中触发。
    fn begin_request(&self) -> RequestGuard<'_> {
        self.in_flight.fetch_add(1, Ordering::SeqCst);
        *self.last_request.lock().unwrap() = Instant::now();
        RequestGuard { supervisor: self }
    }

    /// 登记一条会话租约。连接断开时由事件处理器释放。
    fn register_lease(&self, connection: xpc::xpc_connection_t) {
        self.leases.lock().unwrap().insert(connection as usize);
        self.note("[diag] 租约建立");
    }

    /// 释放租约；返回 `true` 表示这条连接原本持有租约。
    fn release_lease(&self, connection: xpc::xpc_connection_t) -> bool {
        self.leases.lock().unwrap().remove(&(connection as usize))
    }

    fn lease_count(&self) -> usize {
        self.leases.lock().unwrap().len()
    }

    /// 最近一次连接的系统 DNS 接管结果（`None` = 没在连接）。
    fn last_dns(&self) -> Option<dns::DnsHijack> {
        self.last_dns.lock().unwrap().clone()
    }

    fn idle_for(&self) -> Duration {
        self.last_request.lock().unwrap().elapsed()
    }

    fn logs_for(&self, uid: u32) -> Option<Arc<UserLogs>> {
        {
            let map = self.user_logs.lock().unwrap();
            if let Some(existing) = map.get(&uid) {
                *self.last_uid.lock().unwrap() = Some(uid);
                return Some(Arc::clone(existing));
            }
        }
        let Some((home, gid)) = peer_account(uid) else {
            eprintln!("veyl-helper: 无法解析 uid {uid} 的 home，日志只写 stderr");
            return None;
        };
        let logs = match UserLogs::open(&home, uid, gid) {
            Ok(logs) => Arc::new(logs),
            Err(error) => {
                eprintln!("veyl-helper: uid {uid} 的用户日志不可用，只写 stderr：{error}");
                return None;
            }
        };
        let mut map = self.user_logs.lock().unwrap();
        // 并发的另一条连接可能刚插进来；以先到的为准。
        if let Some(existing) = map.get(&uid) {
            return Some(Arc::clone(existing));
        }
        if map.is_empty() {
            let pending = std::mem::take(&mut *self.pending_notes.lock().unwrap());
            for line in pending {
                logs.append_helper(&line);
            }
        }
        map.insert(uid, Arc::clone(&logs));
        *self.last_uid.lock().unwrap() = Some(uid);
        Some(logs)
    }

    #[cfg(test)]
    fn sing_box_log_path(&self, uid: u32) -> Option<PathBuf> {
        self.logs_for(uid).map(|logs| logs.sing_box_path.clone())
    }

    /// 带用户归属的日志：start/stop 的每一步都写进发起连接的那个用户。
    fn note_for(&self, uid: u32, message: &str) {
        self.emit_note(message);
        let line = self.stamped(message);
        match self.logs_for(uid) {
            Some(logs) => logs.append_helper(&line),
            None => eprintln!("veyl-helper: 用户日志不可用，本行只写 stderr"),
        }
    }

    /// 没有连接上下文的日志（helper 启动阶段、规则预置完成等）。
    /// 已经有用户日志就写进最近那个；还没有才缓存，等第一份日志建好再补写。
    fn note(&self, message: &str) {
        self.emit_note(message);
        let line = self.stamped(message);
        let last = *self.last_uid.lock().unwrap();
        if let Some(uid) = last {
            if let Some(logs) = self.logs_for(uid) {
                logs.append_helper(&line);
                return;
            }
        }
        let mut pending = self.pending_notes.lock().unwrap();
        if pending.len() < 200 {
            pending.push(line);
        }
    }

    fn emit_note(&self, message: &str) {
        eprintln!("veyl-helper: {message}");
    }

    fn stamped(&self, message: &str) -> String {
        format!(
            "{} {message}",
            chrono::Local::now().format("%Y-%m-%d %H:%M:%S%.3f")
        )
    }

    /// 规则就绪前最多等 `timeout`；失败原因原样带出去。
    ///
    /// 循环里也看 `stop_requested`：客户端超时后的 stop 不能被
    /// 这次等待挡住——否则它继续握着 `start_lock`，用户重试只能排队再超时。
    fn wait_for_rules(&self, timeout: Duration) -> Result<(), ProtocolError> {
        let deadline = Instant::now() + timeout;
        loop {
            if self.stop_requested.load(Ordering::SeqCst) {
                return Err(ProtocolError::new(
                    protocol::ERR_TUN_START_FAILED,
                    "启动被停止请求取消",
                ));
            }
            {
                let state = self.rules.lock().unwrap();
                match &*state {
                    RulesState::Ready => return Ok(()),
                    RulesState::Failed { code, message } => {
                        return Err(ProtocolError::new(code, message.clone()))
                    }
                    RulesState::Pending => {}
                }
            }
            if Instant::now() >= deadline {
                return Err(ProtocolError::new(
                    protocol::ERR_TUN_START_FAILED,
                    "分流数据正在准备，请稍后重试",
                ));
            }
            std::thread::sleep(Duration::from_millis(100));
        }
    }

    fn record_rules(&self, outcome: Result<(), ProtocolError>, elapsed: Duration) {
        let state = match outcome {
            Ok(()) => RulesState::Ready,
            Err(error) => RulesState::Failed {
                code: error.code,
                message: error.message,
            },
        };
        let ready = matches!(state, RulesState::Ready);
        *self.rules.lock().unwrap() = state;
        self.note(&format!(
            "规则预置{} 耗时={}ms",
            if ready { "完成" } else { "失败" },
            elapsed.as_millis()
        ));
    }

    /// 等完子进程后按代号清理文件：新一代 start 已经开始的话，文件归它。
    fn cleanup_files(&self, generation: u64) {
        if self.generation.load(Ordering::SeqCst) != generation {
            return;
        }
        let _ = std::fs::remove_file(self.config_path());
        let _ = std::fs::remove_file(self.pid_path());
    }

    /// spawn 之后的登记。与 `stop_child` 抢同一把 child 锁：
    /// stop 先置标志再取锁，所以这里要么看见标志，要么 stop 随后一定能取到 child。
    fn register_child(&self, child: Child, running: Running, uid: u32) -> Result<(), ProtocolError> {
        let pid = running.pid;
        let mut slot = self.child.lock().unwrap();
        let mut running_slot = self.running.lock().unwrap();
        if self.stop_requested.load(Ordering::SeqCst) {
            drop(running_slot);
            drop(slot);
            unsafe { libc::kill(pid as libc::pid_t, libc::SIGKILL) };
            let mut child = child;
            let _ = child.wait();
            let _ = std::fs::remove_file(self.config_path());
            let _ = std::fs::remove_file(self.pid_path());
            self.note_for(uid, &format!("start 在 spawn 后被停止请求取消 pid={pid}"));
            return Err(ProtocolError::new(
                protocol::ERR_TUN_START_FAILED,
                "启动被停止请求取消",
            ));
        }
        *slot = Some(child);
        *running_slot = Some(running);
        Ok(())
    }

    fn tun_dir(&self) -> PathBuf {
        self.root.join("tun")
    }

    fn config_path(&self) -> PathBuf {
        self.tun_dir().join("active.json")
    }

    fn pid_path(&self) -> PathBuf {
        self.tun_dir().join("sing-box.pid")
    }

    fn rules_dir(&self) -> PathBuf {
        self.root.join("rules").join("current")
    }

    /// 把 bundle 里的规则归档解到自己的目录，并逐项校验。
    ///
    /// 信任链：归档的 sha256 编译进 helper → 归档里的清单 → 每个 `.srs` 的 sha256。
    /// 从包里读清单、再用清单里的哈希比对包里的文件，那叫自证，不叫验证。
    fn ensure_rules_staged(&self) -> Result<(), ProtocolError> {
        let missing = |detail: String| {
            ProtocolError::new(
                protocol::ERR_RULE_SET_MISSING,
                format!("规则数据不可用：{detail}"),
            )
        };

        ensure_bundle_trusted()?;

        let archive = bundled_rules_archive()
            .ok_or_else(|| missing("安装包里没有 veyl-rules-*.tar.zst".into()))?;
        let expected = protocol::rules_archive_sha256()
            .ok_or_else(|| missing("这份构建里没有随包规则（构建时没找到归档）".into()))?;

        let bytes = std::fs::read(&archive).map_err(|error| missing(format!("{error}")))?;
        if !trust::hash_matches(&bytes, expected) {
            return Err(missing("规则归档的哈希与编译进 helper 的值不符".into()));
        }

        // 比归档哈希，不比版本号：同一天、同一版本号重新打包时，
        // 版本号不变但内容变了，只比版本号会留着旧规则不更新。
        let current = self.rules_dir();
        if std::fs::read_to_string(current.join(".archive-sha256"))
            .ok()
            .as_deref()
            == Some(expected)
        {
            return Ok(());
        }

        // 解压到 staging，校验通过再整体换上去。
        let staging = self.root.join("rules").join("staging");
        let _ = std::fs::remove_dir_all(&staging);
        std::fs::create_dir_all(&staging)
            .map_err(|error| missing(format!("创建临时目录失败：{error}")))?;

        if let Err(error) = unpack_archive(&archive, &staging) {
            let _ = std::fs::remove_dir_all(&staging);
            return Err(missing(error));
        }

        let staged_version = verify_staged_rules(&staging)?;

        let _ = std::fs::remove_dir_all(&current);
        std::fs::rename(&staging, &current)
            .map_err(|error| missing(format!("替换规则目录失败：{error}")))?;
        write_private(&current.join(".version"), staged_version.as_bytes())
            .map_err(|error| missing(format!("写版本标记失败：{error}")))?;
        write_private(&current.join(".archive-sha256"), expected.as_bytes())
            .map_err(|error| missing(format!("写归档哈希失败：{error}")))?;
        Ok(())
    }

    /// tag → 磁盘路径。请求方只说 tag，路径由这里决定。
    ///
    /// **没有规则数据时返回空表，不报错。** 不带分流的配置（全部走 VPN）
    /// 根本不需要规则；在这里报错会把它们一起挡住。
    /// 真正需要规则的配置会在 `prepare_config` 里按 tag 查不到时报
    /// `rule_set_missing`——那才是准确的错误位置。
    fn rule_index(&self) -> std::collections::HashMap<String, PathBuf> {
        let dir = self.rules_dir();
        let mut index = std::collections::HashMap::new();

        let Ok(text) = std::fs::read_to_string(dir.join("manifest.json")) else {
            return index;
        };
        let Ok(manifest) = serde_json::from_str::<serde_json::Value>(&text) else {
            return index;
        };

        for item in manifest["items"].as_array().into_iter().flatten() {
            let id = item["id"].as_str().unwrap_or_default();
            let file = item["file"].as_str().unwrap_or_default();
            // 与 staging 用同一套路径约束；不合规的项直接跳过，不进索引。
            if validate_rule_item(&dir, id, file).is_err() {
                continue;
            }
            index.insert(id.to_string(), dir.join(file));
        }
        index
    }

    /// 上次崩溃留下的东西：此刻没有任何连接，目录里的活动配置一定是残留。
    /// 它含节点密码，不能等下一次连接再删。
    ///
    /// 光删文件不够：如果 sing-box 还活着，那就是一个带着活跃隧道、
    /// 没人管的 root 进程。先把它收掉。
    fn sweep_stale(&self) {
        self.kill_orphan();
        // 崩溃后系统 DNS 可能还指着旧版本写进去的隧道对端。**先趁 active.json
        // 还在**取一次对端：删掉之后只能靠常量猜。公网地址不清（见 `dns` 模块）。
        let legacy = dns::legacy_peer_from_config(&self.config_path());
        let _ = dns::restore_or_clear(legacy.as_deref());
        for path in [self.config_path(), self.pid_path()] {
            match std::fs::remove_file(&path) {
                Ok(()) => eprintln!("veyl-helper: 清理残留 {}", path.display()),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => eprintln!("veyl-helper: 清理 {} 失败：{error}", path.display()),
            }
        }
    }

    fn status(&self) -> Option<Running> {
        let exited = {
            let mut guard = self.child.lock().unwrap();
            let child = guard.as_mut()?;
            match child.try_wait() {
                Ok(None) => false,
                _ => {
                    *guard = None;
                    true
                }
            }
        };
        if exited {
            *self.running.lock().unwrap() = None;
            *self.last_dns.lock().unwrap() = None;
            *self.dns_target.lock().unwrap() = None;
            *self.dns_checked_at.lock().unwrap() = None;
            // 子进程自己退出了：DNS 不能继续指向已经消失的隧道。
            let _ = dns::restore();
            return None;
        }
        self.recheck_dns();
        self.running.lock().unwrap().clone()
    }

    /// 连接期复核系统 DNS 是否还指向隧道。
    ///
    /// 换 Wi-Fi 或用户手动改 DNS 会冲掉我们的键，`dns.applied` 必须回落，
    /// 否则界面会一直显示「已接管」。
    ///
    /// **节流到 5 秒**：`status` 是轮询热路径，每次起一个 `scutil` 代价太高。
    /// 这里刻意用轮询而不是 SCDynamicStore 通知——当前结构没有可挂的事件循环，
    /// 5 秒的滞后对「换网络后提示降级」够用；真要缩短再上通知，这是有意的取舍。
    fn recheck_dns(&self) {
        let Some(current) = self.last_dns() else {
            return;
        };
        let target = self.dns_target.lock().unwrap().clone();
        let Some(target) = target else {
            return;
        };
        let due = {
            let mut at = self.dns_checked_at.lock().unwrap();
            match *at {
                Some(checked) if checked.elapsed() < DNS_RECHECK_INTERVAL => false,
                _ => {
                    *at = Some(Instant::now());
                    true
                }
            }
        };
        if !due {
            return;
        }
        let probe = dns::target_still_applied(&target);
        if let Err(error) = &probe {
            // 读不到系统 DNS 不等于失效：保留上一次的结论，下次再查。
            eprintln!("veyl-helper: 复核系统 DNS 失败：{error}");
        }
        let Some(outcome) = dns_recheck_outcome(probe) else {
            return;
        };
        if outcome == current {
            return;
        }
        // 双向：用户把 DNS 改回来、或网络恢复后，界面要能回到「已接管」，
        // 不能一降级就锁死到下次重连。
        if outcome.applied {
            eprintln!("veyl-helper: 系统 DNS 已重新含我们写入的地址，恢复接管状态");
        } else {
            eprintln!("veyl-helper: 系统 DNS 已不再含我们写入的地址（连接期间网络或 DNS 设置变了）");
        }
        *self.last_dns.lock().unwrap() = Some(outcome);
    }

    fn start(&self, config: &str, uid: u32) -> Result<Started, ProtocolError> {
        // 先声明「这次 start 是新的」，再排队等锁：
        // 反过来的话，等待期间到达的 stop 会被拿到锁之后的那次 store 抹掉。
        self.stop_requested.store(false, Ordering::SeqCst);
        // 两次 start 串行：并发 spawn 会留下一个没人持有的 child。
        let _start_guard = self.start_lock.lock().unwrap();

        #[cfg(debug_assertions)]
        {
            let first = self.status().is_none();
            diag(
                self,
                uid,
                &format!(
                    "start 收到 mode=tun config_bytes={} 首次={first}",
                    config.len()
                ),
            );
        }

        // 代号：老的 stop_child 只能清理自己那一代的文件。
        self.generation.fetch_add(1, Ordering::SeqCst);
        let mut started_at = Instant::now();

        // 构建期没读到随包运行时（build.rs 把它留空）说明这份二进制不是按发布流程
        // 构出来的。放在启动路径而不是 `resolve_runtime`：测试环境没有那 173 MB
        // 运行时，放在下面会让 staging 的单测在干净 CI 上直接失败。
        if protocol::runtime_sha256().is_none() {
            return Err(ProtocolError::new(
                protocol::ERR_RUNTIME_MISSING,
                "这份构建里没有随包运行时，TUN 无法启动",
            ));
        }

        // 每次 start 都重验整条链，而不是只在 helper 启动时验一次。
        // 理由不是当下的风险，是这条链以后会被改：哪天给 tun/ 加了子目录、
        // 或者权限被别的代码动了，这里不改也不会漏。
        let phase = Instant::now();
        self.verify_trust_chain()?;
        self.note_for(uid, &format!(
            "start 阶段 trust_chain={}ms",
            phase.elapsed().as_millis()
        ));

        let phase = Instant::now();
        let binary = self.resolve_runtime()?;
        self.note_for(uid, &format!(
            "start 阶段 runtime={}ms",
            phase.elapsed().as_millis()
        ));
        #[cfg(debug_assertions)]
        diag(
            self,
            uid,
            &format!(
                "runtime 解析 来源=bundled path={} 验签=通过 耗时={}ms",
                binary.display(),
                phase.elapsed().as_millis()
            ),
        );

        // 规则不是每个配置都要；错在这里不应该挡住不带分流的配置。
        let has_rule_sets = serde_json::from_str::<serde_json::Value>(config)
            .ok()
            .and_then(|value| {
                value["route"]["rule_set"]
                    .as_array()
                    .map(|items| !items.is_empty())
            })
            .unwrap_or(false);
        if has_rule_sets {
            #[cfg(debug_assertions)]
            let rules_before = self.rule_index().len();
            let phase = Instant::now();
            // 规则由启动时的后台线程解包，这里只等结果；等待不计入 25 秒准备上限。
            self.wait_for_rules(RULES_WAIT_DEADLINE)?;
            self.note_for(uid, &format!(
                "start 阶段 rules_wait={}ms",
                phase.elapsed().as_millis()
            ));
            #[cfg(debug_assertions)]
            diag(
                self,
                uid,
                &format!(
                    "规则就绪 数量={} 耗时={}ms cache_hit={}",
                    self.rule_index().len(),
                    phase.elapsed().as_millis(),
                    rules_before > 0
                ),
            );
            started_at = Instant::now();
        }

        // 规则准备完就检查一次：客户端可能已经超时并撤了。
        check_start_allowed(
            self.stop_requested.load(Ordering::SeqCst),
            started_at.elapsed(),
        )?;

        let phase = Instant::now();
        // 替换语义：先收旧进程，但不设置取消标志（那会把这次 start 自己取消掉）。
        let had_child = { self.child.lock().unwrap().is_some() };
        self.stop_child("replace");
        self.note_for(uid, &format!(
            "start 阶段 stop_old={}ms had_child={had_child}",
            phase.elapsed().as_millis()
        ));

        // 旧进程已经停了，这时才能删旧运行时目录：
        //   · 提前删（在 resolve_runtime 里）会让 `ensure_rules_staged()` 失败后仍活着的
        //     旧 sing-box 变成「可执行文件已被 unlink」，helper 崩溃重启后
        //     `proc_pidpath` 认不出它，孤儿回收就失效，留下 root 隧道；
        //   · 现在删，文件没了，回收路径仍然按 pid 文件里的记录走。
        // 正在跑的进程即使文件被删也还能继续用（UNIX 语义），但这里已经停了它。
        if let Some(digest) = binary
            .parent()
            .and_then(Path::file_name)
            .and_then(|name| name.to_str())
        {
            prune_staged_runtimes(&self.root.join("runtime"), digest);
        }

        let phase = Instant::now();
        let clash_port = pick_loopback_port()?;
        let clash_secret = random_secret();
        let rules = self.rule_index();
        let prepared = protocol::prepare_config(config, &rules, clash_port, &clash_secret)?;
        let prepared_bytes = serde_json::to_vec_pretty(&prepared).unwrap();

        write_private(&self.config_path(), &prepared_bytes).map_err(|error| {
            ProtocolError::new(
                protocol::ERR_TUN_START_FAILED,
                format!("写入配置失败：{error}"),
            )
        })?;
        #[cfg(debug_assertions)]
        diag(
            self,
            uid,
            &format!(
                "配置写入 path={} bytes={} sha256={}",
                self.config_path().display(),
                prepared_bytes.len(),
                short_sha256(&prepared_bytes)
            ),
        );
        self.note_for(uid, &format!(
            "start 阶段 prepare={}ms",
            phase.elapsed().as_millis()
        ));

        // 先跑 check，不过就不启动。挂住就 kill：它会一直占着 start_lock。
        let phase = Instant::now();
        let check = check_config(&binary, &self.config_path(), CHECK_TIMEOUT)?;
        if !check.status.success() {
            let _ = std::fs::remove_file(self.config_path());
            let detail = String::from_utf8_lossy(&check.stderr).trim().to_string();
            return Err(ProtocolError::new(
                protocol::ERR_TUN_START_FAILED,
                format!("配置校验没过：{detail}"),
            ));
        }
        self.note_for(uid, &format!(
            "start 阶段 check={}ms",
            phase.elapsed().as_millis()
        ));

        // spawn 前最后一次让路：客户端可能已经超时并发来 stop。
        check_start_allowed(
            self.stop_requested.load(Ordering::SeqCst),
            started_at.elapsed(),
        )?;

        // 上次的 sing-box 已经停掉（见上面的 stop_child），此刻没有写入者。
        // 相对已校验的 dirfd 打开；之后父链被换掉也写不到别处去。
        let user_logs = self.logs_for(uid);
        if let Some(logs) = &user_logs {
            self.note_for(uid, &format!("sing-box 日志={}", logs.sing_box_path.display()));
        }
        let capture = match &user_logs {
            Some(logs) => match logs.begin_sing_box() {
                Ok(session) => Some((Arc::clone(logs), session)),
                Err(error) => {
                    self.note_for(uid, &format!("sing-box 日志打开失败，输出丢弃：{error}"));
                    None
                }
            },
            None => None,
        };
        if capture.is_none() {
            self.note_for(uid, "用户日志目录不可用，sing-box 输出将被丢弃");
        }

        let phase = Instant::now();
        let spawned = match &capture {
            Some((logs, session)) => {
                let mut command = Command::new(&binary);
                command.arg("run").arg("-c").arg(self.config_path());
                match spawn_with_pipe(command, logs, *session) {
                    Ok(child) => Ok(child),
                    Err(error) => {
                        // 管道/读线程起不来就丢弃输出，绝不把没人读的管道交给子进程。
                        self.note_for(uid, &format!("日志管道不可用，输出丢弃：{error}"));
                        spawn_without_log(&binary, &self.config_path())
                    }
                }
            }
            None => spawn_without_log(&binary, &self.config_path()),
        };
        let child = spawned.map_err(|error| {
            let _ = std::fs::remove_file(self.config_path());
            ProtocolError::new(
                protocol::ERR_TUN_START_FAILED,
                format!("启动运行时失败：{error}"),
            )
        })?;
        self.note_for(uid, &format!(
            "start 阶段 spawn={}ms",
            phase.elapsed().as_millis()
        ));

        let pid = child.id();
        #[cfg(debug_assertions)]
        diag(
            self,
            uid,
            &format!(
                "spawn pid={pid} args=run -c {}",
                self.config_path().display()
            ),
        );
        // 启动时刻由特权侧生成（契约 §3.1），App 崩溃重启后 `status` 也报这个值。
        let since = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
        // 记下启动时间与可执行路径：下次崩溃重启时靠这三样认出「是我们起的那个」，
        // 只按 pid 杀会在 pid 复用时误杀别的进程。
        let record = format!(
            "{pid}\n{}\n{}\n",
            ps_start(pid).unwrap_or_default(),
            binary.display()
        );
        if let Err(error) = write_private(&self.pid_path(), record.as_bytes()) {
            self.note_for(uid, &format!("写 pid 失败：{error}"));
        }

        let clash_addr = format!("127.0.0.1:{clash_port}");
        self.register_child(
            child,
            Running {
                pid,
                clash_addr: clash_addr.clone(),
                clash_secret: clash_secret.clone(),
                since: since.clone(),
            },
            uid,
        )?;

        // 系统解析器指向公网 DNS（不是 TUN 对端——对端落在排除段里，查询出物理网卡后
        // 黑洞，2026-11-11 真机）。查询进 TUN 后由 `hijack-dns` 回答。
        // **失败不阻断连接**：DNS 是优化项，隧道才是产品；但要如实回报，
        // 让界面能说明「国外网站可能较慢」，不能静默降级。
        let phase = Instant::now();
        let hijack = dns::activate();
        if !hijack.applied {
            self.note_for(
                uid,
                &format!(
                    "[warn] 系统 DNS 未接管（连接照常，国外网站可能较慢）：{}",
                    hijack.reason.as_deref().unwrap_or("未知原因")
                ),
            );
        }
        *self.last_dns.lock().unwrap() = Some(hijack.clone());
        *self.dns_target.lock().unwrap() = Some(dns::SYSTEM_DNS_TARGET.to_string());
        *self.dns_checked_at.lock().unwrap() = Some(Instant::now());
        self.note_for(
            uid,
            &format!("start 阶段 dns={}ms", phase.elapsed().as_millis()),
        );

        #[cfg(debug_assertions)]
        {
            let address = diag_tun_address(&prepared);
            diag(self, uid, &format!("接管开始 等待路由 address={address}"));
            let phase = Instant::now();
            let mut found = None;
            for _ in 0..15 {
                found = diag_tun_interface(&address);
                if found.is_some() {
                    break;
                }
                std::thread::sleep(Duration::from_millis(100));
            }
            match found {
                Some(name) => {
                    // 路由表比设备晚一步装好：spawn 后立刻查会固定看到「缺失 0/1、128/1」，
                    // 那是还没装完，不是结论。最多再等 500ms 复查一次稳定结果。
                    let mut snapshot = diag_route_snapshot(&name);
                    for _ in 0..5 {
                        if snapshot.1.is_empty() {
                            break;
                        }
                        std::thread::sleep(Duration::from_millis(100));
                        snapshot = diag_route_snapshot(&name);
                    }
                    let (count, missing) = snapshot;
                    let suffix = if missing.is_empty() {
                        ""
                    } else {
                        "（路由仍在安装，非结论）"
                    };
                    diag(
                        self,
                        uid,
                        &format!(
                            "接管结束 tun={name} 路由数={count} 关键段={}/4 缺失={missing:?} 耗时={}ms{suffix}",
                            4 - missing.len(),
                            phase.elapsed().as_millis()
                        ),
                    );
                }
                None => diag(
                    self,
                    uid,
                    &format!(
                        "接管结束 未找到 TUN 设备（address={address}）耗时={}ms",
                        phase.elapsed().as_millis()
                    ),
                ),
            }
        }

        self.note_for(uid, &format!(
            "start 完成 总耗时={}ms",
            started_at.elapsed().as_millis()
        ));
        Ok(Started {
            pid,
            clash_addr,
            clash_secret,
            since,
            dns: hijack,
        })
    }

    /// 外部 stop：先置取消标志，再收子进程。
    ///
    /// 标志必须先置：`start` 在准备阶段和 spawn 前后各看一次，
    /// 否则客户端超时后的 stop 只能等 start 自己跑完。
    fn stop(&self) {
        self.stop_requested.store(true, Ordering::SeqCst);
        self.stop_child("external");
    }

    /// 只收自己起的子进程，不动取消标志。`start` 的替换语义用它——
    /// 走 `stop()` 会把这次 start 自己取消掉。
    fn stop_child(&self, reason: &str) {
        #[cfg(not(debug_assertions))]
        let _ = reason;
        // 记下代号：等子进程最多 5 秒，这期间新一代 start 可能已经写好文件。
        let generation = self.generation.load(Ordering::SeqCst);
        let child = self.child.lock().unwrap().take();
        // 与 child 同步清空：App 崩溃后接手不到一个已经停掉的连接。
        *self.running.lock().unwrap() = None;
        if let Some(mut child) = child {
            unsafe { libc::kill(child.id() as libc::pid_t, libc::SIGTERM) };
            let deadline = Instant::now() + Duration::from_secs(5);
            loop {
                match child.try_wait() {
                    Ok(Some(_)) => break,
                    Ok(None) if Instant::now() < deadline => {
                        std::thread::sleep(Duration::from_millis(100))
                    }
                    _ => {
                        let _ = child.kill();
                        let _ = child.wait();
                        break;
                    }
                }
            }
        }
        // 代号没变才删：变了说明新 start 已经接管这些文件，
        // 删掉会让 live root 进程失去孤儿回收线索。
        self.cleanup_files(generation);

        // 子进程没了，系统 DNS 必须还回去：留着指向隧道等于把所有解析都打死。
        // 幂等：没改过 DNS 时这里是空操作。
        let _ = dns::restore();
        *self.last_dns.lock().unwrap() = None;
        *self.dns_target.lock().unwrap() = None;
        *self.dns_checked_at.lock().unwrap() = None;

        #[cfg(debug_assertions)]
        self.note(&format!(
            "[diag] stop 原因={reason} 进程=已停止 残留utun路由={}",
            diag_utun_route_count()
        ));
    }

    /// 收掉上次崩溃留下的 sing-box。
    ///
    /// 三重核对缺一不可：可执行文件路径是我们记录的那个、启动时间对得上、
    /// pid 确实还活着。只凭 pid 会误杀——pid 会被复用。
    fn kill_orphan(&self) {
        let Ok(text) = std::fs::read_to_string(self.pid_path()) else {
            return;
        };
        let mut lines = text.lines();
        let Some(pid) = lines
            .next()
            .and_then(|value| value.trim().parse::<u32>().ok())
        else {
            return;
        };
        let recorded_start = lines.next().unwrap_or_default().trim().to_string();
        let recorded_exe = lines.next().unwrap_or_default().trim().to_string();

        if recorded_exe.is_empty() || recorded_start.is_empty() {
            return;
        }
        if process_exe(pid).as_deref() != Some(Path::new(&recorded_exe)) {
            return;
        }
        if ps_start(pid).as_deref() != Some(recorded_start.as_str()) {
            return;
        }

        eprintln!("veyl-helper: 收掉上次遗留的 sing-box pid={pid}");
        unsafe { libc::kill(pid as libc::pid_t, libc::SIGTERM) };
        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline {
            if !process_alive(pid) {
                return;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        unsafe { libc::kill(pid as libc::pid_t, libc::SIGKILL) };
    }

    /// 信任根整条链：root 本身 + 三个子目录。任何一级不合规就拒绝启动。
    fn verify_trust_chain(&self) -> Result<(), ProtocolError> {
        let reject = |error: trust::TrustError| {
            ProtocolError::new(
                protocol::ERR_TUN_START_FAILED,
                format!("信任根校验未通过：{error}"),
            )
        };
        verify_under_library(&self.root).map_err(reject)?;
        for name in ["runtime", "tun", "rules"] {
            verify_under_library(&self.root.join(name)).map_err(reject)?;
        }
        // 规则目录是延迟创建的，存在就一并验。
        let rules = self.rules_dir();
        if rules.exists() {
            verify_under_library(&rules).map_err(reject)?;
        }
        Ok(())
    }

    /// 运行时只来自 helper 自己的 bundle，落到 root 目录，
    /// **每次 start 都重新校验**：普通文件、非软链、uid 0、0755、完整 256 位哈希。
    ///
    /// 哈希以**包内文件当前的内容**为准，不用 `build.rs` 的构建期值：
    /// 打包签名会重签这个 Mach-O，字节随签名改变，构建期哈希只对未签名的产物成立。
    /// 目录名与内容哈希绑定，所以「staged 文件被换掉」和「目录名对不上内容」
    /// 都会在启动前被发现。
    fn resolve_runtime(&self) -> Result<PathBuf, ProtocolError> {
        self.resolve_runtime_from(
            bundled_runtime(),
            ensure_bundle_trusted,
            verify_staged_signature,
            0,
        )
    }

    /// `resolve_runtime` 的可注入版本：验签闭包与期望 uid 由调用方给，
    /// 测试才能在不依赖签名环境的前提下走完整路径。
    fn resolve_runtime_from(
        &self,
        bundled: Option<PathBuf>,
        verify_bundle: impl FnOnce() -> Result<(), ProtocolError>,
        verify_signature: impl Fn(&Path) -> Result<(), ProtocolError>,
        expect_uid: u32,
    ) -> Result<PathBuf, ProtocolError> {
        let bundled = bundled.ok_or_else(|| {
            ProtocolError::new(
                protocol::ERR_RUNTIME_MISSING,
                "安装包里没有运行时，TUN 无法启动",
            )
        })?;

        // **先验来源，再读内容。** 顺序不能反：bundle 的属主可能就是当前用户，
        // 先读再验会让「读到的字节」与「被验证的 bundle」脱钩——读时换进恶意
        // 字节、验前再换回正版，恶意内容就会被写进 root 目录。
        //
        // 冷启动的耗时几乎都在这里：真机复现过 runtime 阶段 33 秒，客户端 30 秒
        // 就超时了。下面每一步都打点，下次直接看 helper.log 就知道是验签还是 I/O。
        // **必须走 `note`**：launchd 的 plist 没配 `StandardErrorPath`，`eprintln!`
        // 会被直接丢掉；`note` 写用户日志（首连时先缓存、建好日志再补写）。
        let phase = Instant::now();
        verify_bundle()?;
        self.note(&format!(
            "[runtime] bundle_verify={}ms",
            phase.elapsed().as_millis()
        ));

        // O_NOFOLLOW：`is_file()` 与读取之间若被换成软链，这里直接失败。
        let phase = Instant::now();
        let bytes = read_no_follow(&bundled).map_err(|error| {
            ProtocolError::new(
                protocol::ERR_RUNTIME_MISSING,
                format!("读取安装包内的运行时失败：{error}"),
            )
        })?;
        self.note(&format!(
            "[runtime] read={}ms bytes={}",
            phase.elapsed().as_millis(),
            bytes.len()
        ));
        let phase = Instant::now();
        let digest = sha256_hex(&bytes);
        self.note(&format!(
            "[runtime] sha256={}ms digest={}",
            phase.elapsed().as_millis(),
            short_digest(&digest)
        ));
        if let Some(expected) = protocol::runtime_sha256() {
            if expected != digest.as_str() {
                // bundle 签名已经验过；这里不一致说明 helper 与包不是同一次构建，
                // 值得在日志里留一条（不算安全问题，但排查时很关键）。
                self.note(&format!(
                    "[warn] 包内运行时哈希与构建期不一致（包内 {} / 构建期 {}）",
                    short_digest(&digest),
                    short_digest(expected)
                ));
            }
        }
        let dir = self.root.join("runtime").join(&digest);
        let dest = dir.join("sing-box");

        if dest.exists() {
            let phase = Instant::now();
            let reused = verify_staged_runtime_file(&dest, &digest, expect_uid).is_ok();
            self.note(&format!(
                "[runtime] reuse_verify={}ms reused={reused}",
                phase.elapsed().as_millis()
            ));
            if reused {
                return Ok(dest);
            }
            // 磁盘上的副本坏了（上次写到一半、或被人动过）：删掉，用刚读到的
            // 包内字节重建一次；重建后仍不合格就报错，不降级。
            let _ = std::fs::remove_dir_all(&dir);
        }

        let phase = Instant::now();
        write_staged_runtime(&dir, &dest, &bytes)?;
        self.note(&format!(
            "[runtime] write={}ms",
            phase.elapsed().as_millis()
        ));
        // 内容绑定的最后一环：写进 root 目录的字节必须带着我们的签名。
        // 没有这一步，「先验 bundle 再读」之间仍留着一个可替换的窗口。
        let phase = Instant::now();
        if let Err(error) = verify_signature(&dest) {
            let _ = std::fs::remove_dir_all(&dir);
            return Err(error);
        }
        self.note(&format!(
            "[runtime] code_sign={}ms",
            phase.elapsed().as_millis()
        ));
        if let Err(error) = set_mode(&dest, 0o755) {
            let _ = std::fs::remove_dir_all(&dir);
            return Err(error);
        }
        let phase = Instant::now();
        if let Err(error) = verify_staged_runtime_file(&dest, &digest, expect_uid) {
            let _ = std::fs::remove_dir_all(&dir);
            return Err(error);
        }
        self.note(&format!(
            "[runtime] staged_verify={}ms",
            phase.elapsed().as_millis()
        ));

        // 清理旧运行时**不在这里做**：此刻旧的 sing-box 可能还在跑。
        // 提前删目录会让它在 helper 崩溃重启后 `proc_pidpath` 认不出来，
        // 变成没人回收的 root 隧道。清理放在 `Supervisor::start` 的 stop() 之后。
        Ok(dest)
    }
}

/// 只用来给运行时命名与复核；不参与信任判断（信任来自签名与 root 目录）。
fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    hex(Sha256::digest(bytes).as_slice())
}

/// 日志里只留前 12 位，够对照、又不至于刷屏。
fn short_digest(digest: &str) -> &str {
    digest.get(..12).unwrap_or(digest)
}

/// 读一个文件并拒绝软链。用在「路径来自 bundle、内容是执行候选」的地方。
///
/// `O_NONBLOCK` 让 FIFO 不会把 root 进程挂住；打开后还会检查它确实是普通文件。
/// 读取有上限，避免一个异常大的文件把 helper 的内存吃掉。
fn read_no_follow(path: &Path) -> std::io::Result<Vec<u8>> {
    use std::io::Read;
    let file = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)?;
    let metadata = file.metadata()?;
    if !metadata.is_file() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "不是普通文件",
        ));
    }
    if metadata.len() > MAX_RUNTIME_BYTES {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("文件过大：{} 字节", metadata.len()),
        ));
    }
    // `take` 而不是信任 metadata：文件可能在 stat 与读完之间被追加。
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.take(MAX_RUNTIME_BYTES + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAX_RUNTIME_BYTES {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "文件在读取过程中超过了上限",
        ));
    }
    Ok(bytes)
}

/// staged 文件必须：普通文件、非软链、指定属主、0755、完整哈希。
fn verify_staged_runtime_file(
    dest: &Path,
    digest: &str,
    expect_uid: u32,
) -> Result<(), ProtocolError> {
    trust::verify_file(dest, expect_uid, 0o755, Some(digest)).map_err(|error| {
        ProtocolError::new(
            protocol::ERR_RUNTIME_MISSING,
            format!("运行时校验未通过：{error}"),
        )
    })
}

fn set_mode(path: &Path, mode: u32) -> Result<(), ProtocolError> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode))
        .map_err(|error| ProtocolError::new(protocol::ERR_RUNTIME_MISSING, format!("{error}")))
}

/// 写 `<root>/runtime/<内容哈希>/sing-box`（先 0600），目录 0700。
///
/// temp + fsync + rename：并发 start 不会交错写坏，中途失败也不会留下
/// 半截的可执行文件。可执行位由调用方在签名校验通过之后再加。
fn write_staged_runtime(dir: &Path, dest: &Path, bytes: &[u8]) -> Result<(), ProtocolError> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::create_dir_all(dir)
        .map_err(|error| ProtocolError::new(protocol::ERR_RUNTIME_MISSING, format!("{error}")))?;
    let _ = std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700));
    // 随机后缀：两次 start 万一并发，各写各的临时文件，rename 仍是原子的。
    let temp = dir.join(format!(".sing-box.tmp.{:016x}", rand::random::<u64>()));
    if let Err(error) = write_private(&temp, bytes) {
        let _ = std::fs::remove_file(&temp);
        return Err(ProtocolError::new(
            protocol::ERR_RUNTIME_MISSING,
            format!("{error}"),
        ));
    }
    if let Err(error) = std::fs::rename(&temp, dest) {
        let _ = std::fs::remove_file(&temp);
        return Err(ProtocolError::new(
            protocol::ERR_RUNTIME_MISSING,
            format!("{error}"),
        ));
    }
    Ok(())
}

/// 只保留当前这一个运行时。名字不是完整 sha256 的一律不动——那不是我们建的。
fn prune_staged_runtimes(runtime_dir: &Path, keep: &str) {
    let Ok(entries) = std::fs::read_dir(runtime_dir) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if name == keep || !trust::is_full_sha256(&name) {
            continue;
        }
        // `file_type` 不跟随软链：软链不会被当成目录删掉。
        if entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false) {
            let _ = std::fs::remove_dir_all(entry.path());
        }
    }
}

extern "C" {
    fn dispatch_main() -> !;
}

// ---------------------------------------------------------------------------
// bundle 签名校验
//
// 属主不是可信判据：本机 38 个 App 里有 15 个属主是登录用户。
// 用户把 App 拖进「应用程序」文件夹是完全正常的安装方式，不能拒。
// 真正的判据是代码签名，而且它与属主无关。
// ---------------------------------------------------------------------------

#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    fn CFURLCreateFromFileSystemRepresentation(
        allocator: *const c_void,
        buffer: *const u8,
        buf_len: isize,
        is_directory: bool,
    ) -> *const c_void;
    fn CFStringCreateWithCString(
        allocator: *const c_void,
        c_str: *const c_char,
        encoding: u32,
    ) -> *const c_void;
    fn CFRelease(value: *const c_void);
    fn CFDictionaryGetValue(dictionary: *const c_void, key: *const c_void) -> *const c_void;
    fn CFDataGetLength(data: *const c_void) -> isize;
    fn CFDataGetBytePtr(data: *const c_void) -> *const u8;
}

#[link(name = "Security", kind = "framework")]
extern "C" {
    fn SecCodeCopySelf(flags: u32, code: *mut *const c_void) -> i32;
    fn SecCodeCopySigningInformation(
        code: *const c_void,
        flags: u32,
        information: *mut *const c_void,
    ) -> i32;
    fn SecStaticCodeCreateWithPath(
        path: *const c_void,
        flags: u32,
        code: *mut *const c_void,
    ) -> i32;
    fn SecStaticCodeCheckValidity(
        code: *const c_void,
        flags: u32,
        requirement: *const c_void,
    ) -> i32;
    fn SecRequirementCreateWithString(
        text: *const c_void,
        flags: u32,
        requirement: *mut *const c_void,
    ) -> i32;
}

const K_CF_STRING_ENCODING_UTF8: u32 = 0x0800_0100;

/// 对 `.app` 做静态签名校验，要求它满足我们自己的 designated requirement。
/// 包被替换过、或者不是我们签的，这里就过不去。
fn bundle_signature_valid(bundle: &Path) -> Result<(), String> {
    // kSecCSCheckAllArchitectures(1) | kSecCSCheckNestedCode(8) | kSecCSStrictValidate(16)
    //
    // 这是**纵深防御，不是补漏洞**：默认 flags 本来就会校验封存资源
    // （`kSecCSDefaultFlags` 的定义就是 "checks ... including resources"）。
    // 这三项补的是默认不查的部分——嵌套代码与非当前架构。
    // 而 helper 自己就是 App 里的嵌套代码，正好落在这个缺口上。
    static_requirement_check(bundle, true, &protocol::app_requirement(), 1 | 8 | 16)
}

/// staged 运行时（一个裸 Mach-O）自身的签名：必须由我们 Team 签发的**那个**运行时。
///
/// 这一步把「写进 root 目录的字节」重新绑定到「我们签发的代码」上：
/// 包内文件在读取前后被换掉都不影响结论——没有我们签名的字节进不了执行路径。
///
/// 只钉 Team OU 不够：同一个 Team 签的其它二进制（例如 `Contents/MacOS/veyl`）
/// 也能满足 OU。裸 Mach-O 的默认 identifier 就是文件名，所以这里把它一起钉住。
/// `anchor apple generic` 同时排除 ad-hoc 与自签名。
///
/// 未签名或 ad-hoc 的包（例如没有 `VEYL_DEV_ID_APP` 的本地构建）会在这里失败，
/// 这是预期行为：TUN 本来就只在签名包上可用。
fn staged_runtime_signature_valid(path: &Path) -> Result<(), String> {
    let requirement = format!(
        "anchor apple generic and identifier \"{RUNTIME_IDENTIFIER}\" and certificate leaf[subject.OU] = \"{}\"",
        protocol::TEAM_ID
    );
    // universal 二进制的两片都要是我们签的，所以查全部架构。
    static_requirement_check(path, false, &requirement, 1)
}

fn verify_staged_signature(path: &Path) -> Result<(), ProtocolError> {
    staged_runtime_signature_valid(path).map_err(|detail| {
        ProtocolError::new(
            protocol::ERR_RUNTIME_MISSING,
            format!("运行时签名校验未通过：{detail}"),
        )
    })
}

/// 对 `path`（bundle 或裸可执行文件）做静态签名校验。
fn static_requirement_check(
    path: &Path,
    is_directory: bool,
    requirement: &str,
    flags: u32,
) -> Result<(), String> {
    let path = path.to_string_lossy().to_string();
    // SAFETY: Create 出来的 CF 对象都在本函数内释放；requirement 字符串在调用后
    // 就可以释放（文档明确允许）。
    unsafe {
        let url = CFURLCreateFromFileSystemRepresentation(
            std::ptr::null(),
            path.as_ptr(),
            path.len() as isize,
            is_directory,
        );
        if url.is_null() {
            return Err("无法构造文件 URL".into());
        }

        let mut code: *const c_void = std::ptr::null();
        let status = SecStaticCodeCreateWithPath(url, 0, &mut code);
        CFRelease(url);
        if status != 0 || code.is_null() {
            return Err(format!("读不到代码签名（OSStatus {status}）"));
        }

        let text = match std::ffi::CString::new(requirement) {
            Ok(text) => text,
            Err(_) => {
                CFRelease(code);
                return Err("requirement 含空字节".into());
            }
        };
        let requirement_text =
            CFStringCreateWithCString(std::ptr::null(), text.as_ptr(), K_CF_STRING_ENCODING_UTF8);
        if requirement_text.is_null() {
            CFRelease(code);
            return Err("无法构造签名要求".into());
        }
        let mut parsed: *const c_void = std::ptr::null();
        let status = SecRequirementCreateWithString(requirement_text, 0, &mut parsed);
        CFRelease(requirement_text);
        if status != 0 || parsed.is_null() {
            CFRelease(code);
            return Err(format!("签名要求字符串无效（OSStatus {status}）"));
        }

        let valid = SecStaticCodeCheckValidity(code, flags, parsed);
        CFRelease(parsed);
        CFRelease(code);
        if valid == 0 {
            Ok(())
        } else {
            Err(format!("签名不满足我们的要求（OSStatus {valid}）"))
        }
    }
}

/// 自身镜像的 cdhash。启动时算一次，`status` 作为诊断字段返回。
static HELPER_BUILD: std::sync::OnceLock<String> = std::sync::OnceLock::new();

fn helper_build() -> Option<&'static str> {
    HELPER_BUILD
        .get()
        .map(String::as_str)
        .filter(|value| !value.is_empty())
}

/// 取运行中 helper 自己的代码目录哈希（cdhash）。
///
/// 这是与 App 侧 `SecCodeCopyGuestWithAttributes` 同一套算法：两端比的是
/// 「这份映像的哈希」，与版本号无关，因此 App 降级也能正确判断。
fn self_cdhash() -> Option<String> {
    // kSecCSSigningInformation = 2
    const SIGNING_INFORMATION: u32 = 2;
    unsafe {
        let mut code: *const c_void = std::ptr::null();
        if SecCodeCopySelf(0, &mut code) != 0 || code.is_null() {
            return None;
        }
        let mut info: *const c_void = std::ptr::null();
        let status = SecCodeCopySigningInformation(code, SIGNING_INFORMATION, &mut info);
        if status != 0 || info.is_null() {
            CFRelease(code);
            return None;
        }
        let key = CFStringCreateWithCString(
            std::ptr::null(),
            b"unique\0".as_ptr() as *const c_char,
            K_CF_STRING_ENCODING_UTF8,
        );
        let data = if key.is_null() {
            std::ptr::null()
        } else {
            CFDictionaryGetValue(info, key)
        };
        let mut hex = None;
        if !data.is_null() {
            let length = CFDataGetLength(data);
            if length > 0 {
                let bytes = CFDataGetBytePtr(data);
                if !bytes.is_null() {
                    hex = Some(
                        (0..length as usize)
                            .map(|i| format!("{:02x}", *bytes.add(i)))
                            .collect::<String>(),
                    );
                }
            }
        }
        if !key.is_null() {
            CFRelease(key);
        }
        CFRelease(info);
        CFRelease(code);
        hex
    }
}

/// 崩溃循环打断：把本次启动记进 `<root>/helper-starts`，10 分钟内第 3 次
/// 就正常退出（0），让 launchd 停下来，而不是无限拉起。
fn crash_loop_tripped_now(root: &Path) -> bool {
    let path = root.join("helper-starts");
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|value| value.as_secs())
        .unwrap_or_default();
    let mut starts: Vec<u64> = std::fs::read_to_string(&path)
        .ok()
        .map(|text| {
            text.lines()
                .filter_map(|line| line.trim().parse::<u64>().ok())
                .collect()
        })
        .unwrap_or_default();
    starts.push(now);
    starts.retain(|at| now.saturating_sub(*at) <= CRASH_LOOP_WINDOW);
    let tripped = crash_loop_tripped(&starts, now);
    if tripped {
        // 这次退出是保护自己决定的，不是崩溃。撤掉刚写的这条，否则每被拉起
        // 一次就续一次窗口：应用一天里重建几次 app 就会把 helper 永久锁死。
        starts.pop();
    }

    let text = starts
        .iter()
        .map(|at| at.to_string())
        .collect::<Vec<_>>()
        .join("\n");
    if let Err(error) = std::fs::write(&path, text) {
        eprintln!("veyl-helper: 写启动记录失败：{error}");
    }
    tripped
}

/// 干净退出时撤掉本次启动记录。
///
/// 崩溃循环保护只该统计真正的崩溃。升级重启、空闲退出、收到 SIGTERM、租约断开
/// 都是正常生命周期——把它们算进去，开发期重建几次 app 就会触发保护，而保护
/// 一旦触发 helper 就再也起不来。
fn clear_start_record(root: &Path) {
    let path = root.join("helper-starts");
    let Ok(text) = std::fs::read_to_string(&path) else {
        return;
    };
    let mut lines: Vec<&str> = text
        .lines()
        .filter(|line| !line.trim().is_empty())
        .collect();
    lines.pop();
    if let Err(error) = std::fs::write(&path, lines.join("\n")) {
        eprintln!("veyl-helper: 清理启动记录失败：{error}");
    }
}

// ---------------------------------------------------------------------------
// debug 构建专用的分段诊断日志
//
// release 构建里这些函数与调用点都不编译，行为与日志完全不受影响。
// 日志里不出现配置内容、密码或密钥；只写路径、字节数、哈希前缀、IP/端口。
// ---------------------------------------------------------------------------

#[cfg(debug_assertions)]
fn diag(supervisor: &Supervisor, uid: u32, message: &str) {
    supervisor.note_for(uid, &format!("[diag] {message}"));
}

#[cfg(debug_assertions)]
fn short_sha256(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let digest = hex(Sha256::digest(bytes).as_slice());
    digest.get(..12).unwrap_or(&digest).to_string()
}

/// 从配置里取第一个 TUN 入站的地址，去掉前缀长度。
///
/// `address` 在 sing-box 配置里是**数组**（`["172.19.0.1/30"]`）。早先按字符串取，
/// 结果永远是空串，诊断固定打成「未找到 TUN 设备」，误导过一轮排查。
#[cfg(any(debug_assertions, test))]
fn diag_tun_address(config: &serde_json::Value) -> String {
    config["inbounds"]
        .as_array()
        .and_then(|entries| entries.first())
        .and_then(|entry| entry.get("address"))
        .and_then(|value| match value {
            serde_json::Value::Array(list) => list.first(),
            other => Some(other),
        })
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default()
        .split('/')
        .next()
        .unwrap_or_default()
        .to_string()
}

/// 复核探测结果的解释。单独抽出来，测试不用真的去读系统 DNS。
///
/// 双向：读到我们的地址 = 已接管，读不到 = 降级，读不到系统 DNS 保留上一次结论。
fn dns_recheck_outcome(probe: Result<bool, String>) -> Option<dns::DnsHijack> {
    match probe {
        Ok(true) => Some(dns::DnsHijack::applied()),
        Ok(false) => Some(dns::DnsHijack::failed("连接期间网络或 DNS 设置变了")),
        Err(_) => None,
    }
}

/// 从 `ifconfig -a` 里找持有该地址的 utun。地址不带前缀长度。
#[cfg(debug_assertions)]
fn diag_tun_interface(address: &str) -> Option<String> {
    let output = std::process::Command::new("/sbin/ifconfig")
        .arg("-a")
        .output()
        .ok()?;
    let text = String::from_utf8_lossy(&output.stdout);
    let mut current: Option<String> = None;
    for line in text.lines() {
        if !line.starts_with(char::is_whitespace) {
            current = line.split(':').next().map(str::to_string);
            continue;
        }
        let Some(name) = current.as_deref() else {
            continue;
        };
        if !name.starts_with("utun") {
            continue;
        }
        let tokens: Vec<&str> = line.split_whitespace().collect();
        if tokens.first() == Some(&"inet") && tokens.get(1) == Some(&address) {
            return Some(name.to_string());
        }
    }
    None
}

/// 指向该接口的路由数，以及缺失的关键段（0/1、128/1、16/4、32/3）。
#[cfg(debug_assertions)]
fn diag_route_snapshot(interface: &str) -> (usize, Vec<&'static str>) {
    let Ok(output) = std::process::Command::new("/usr/sbin/netstat")
        .args(["-rn", "-f", "inet"])
        .output()
    else {
        return (0, vec!["0/1", "128/1", "16/4", "32/3"]);
    };
    let text = String::from_utf8_lossy(&output.stdout);
    let mut count = 0usize;
    let mut has = [false; 4];
    for line in text.lines() {
        let tokens: Vec<&str> = line.split_whitespace().collect();
        if tokens.len() < 4 || tokens[3] != interface {
            continue;
        }
        count += 1;
        match tokens[0] {
            "0/1" | "0.0.0.0/1" => has[0] = true,
            "128/1" | "128.0.0.0/1" => has[1] = true,
            "16/4" | "16.0.0.0/4" => has[2] = true, // secret-scan:allow 接管关键段常量
            "32/3" | "32.0.0.0/3" => has[3] = true, // secret-scan:allow 接管关键段常量
            _ => {}
        }
    }
    let labels = ["0/1", "128/1", "16/4", "32/3"];
    let missing = labels
        .iter()
        .enumerate()
        .filter(|(index, _)| !has[*index])
        .map(|(_, label)| *label)
        .collect();
    (count, missing)
}

/// 全局 utun 路由数：stop 后用它判断有没有残留。
#[cfg(debug_assertions)]
fn diag_utun_route_count() -> usize {
    let Ok(output) = std::process::Command::new("/usr/sbin/netstat")
        .args(["-rn", "-f", "inet"])
        .output()
    else {
        return 0;
    };
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter(|line| {
            let tokens: Vec<&str> = line.split_whitespace().collect();
            tokens.len() >= 4 && tokens[3].starts_with("utun")
        })
        .count()
}

// ---------------------------------------------------------------------------
// 杂项
// ---------------------------------------------------------------------------

/// 建好并校验信任根。
///
/// 已存在但属主不是 root 的，**直接失败**——不去 chown 把它「修好」，
/// 那等于把别人建的东西合法化。
fn prepare_trust_root() -> Result<PathBuf, trust::TrustError> {
    use std::os::unix::fs::PermissionsExt;

    let root = PathBuf::from(trust::TRUST_ROOT);
    let parent = root
        .parent()
        .ok_or_else(|| trust::TrustError::Io("信任根没有父目录".into()))?
        .to_path_buf();

    // 父链必须已经存在且合规（/Library/Application Support 是 root:admin 0755，
    // 普通用户与管理员都建不了东西在里面）。
    verify_under_library(&parent)?;

    if !root.exists() {
        std::fs::create_dir(&root)
            .map_err(|error| trust::TrustError::Io(format!("创建信任根失败：{error}")))?;
        std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o755))
            .map_err(|error| trust::TrustError::Io(format!("设置权限失败：{error}")))?;
    }
    verify_under_library(&root)?;

    for name in ["runtime", "tun", "rules"] {
        let dir = root.join(name);
        if !dir.exists() {
            std::fs::create_dir(&dir)
                .map_err(|error| trust::TrustError::Io(format!("创建 {name} 失败：{error}")))?;
            std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700))
                .map_err(|error| trust::TrustError::Io(format!("设置权限失败：{error}")))?;
        }
        verify_under_library(&dir)?;
    }
    Ok(root)
}

/// 生产环境只从 `/Library` 往下判：再往上的 `/`、`/System` 不归我们管。
fn verify_under_library(path: &Path) -> Result<(), trust::TrustError> {
    trust::verify_chain_from(Path::new("/Library"), path, 0)
}

/// bundle 本身必须在用户写不了的地方。
///
/// **不检查 `/Applications` 自己的写位**——真机实测它是 `root:admin 0775`，
/// group 可写是系统默认。要保证的是「这个 .app 及其内容不是普通用户可写的」。
fn ensure_bundle_trusted() -> Result<(), ProtocolError> {
    let untrusted = |detail: String| {
        ProtocolError::new(
            protocol::ERR_RUNTIME_MISSING,
            format!("安装包所在位置不可信，拒绝从里面取运行时：{detail}"),
        )
    };

    let exe = std::env::current_exe().map_err(|error| untrusted(format!("{error}")))?;
    let bundle = exe
        .ancestors()
        .nth(3)
        .ok_or_else(|| untrusted("无法定位 App bundle".into()))?;

    trust::verify_bundle(bundle, Path::new("/Applications"))
        .map_err(|error| untrusted(error.to_string()))?;

    // 属主不作数（拖拽安装的 App 属主是用户本人）。真正决定可信的是签名。
    bundle_signature_valid(bundle).map_err(untrusted)
}

/// 安装包里的规则归档：`.../Contents/Resources/resources/rules/veyl-rules-*.tar.zst`。
///
/// 注意这是 Tauri 对 `"resources": ["resources/rules/"]` 的映射结果，
/// **没有在真实打包产物上验证过**（见报告）。
fn bundled_rules_archive() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let contents = exe.parent()?.parent()?;
    rules_archive_in(&contents.join("Resources/resources/rules"))
}

/// 在给定目录里挑规则归档。抽出来是为了能直接测「路径对不对」，
/// 不用真的打一个包。
fn rules_archive_in(dir: &Path) -> Option<PathBuf> {
    let mut archives: Vec<PathBuf> = std::fs::read_dir(dir)
        .ok()?
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| {
            let name = path
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or_default();
            name.starts_with("veyl-rules-") && name.ends_with(".tar.zst")
        })
        .collect();
    archives.sort();
    archives.pop()
}

/// 解压 zstd+tar。目标目录已由我们创建并校验过。
fn unpack_archive(archive: &Path, target: &Path) -> Result<(), String> {
    let file = std::fs::File::open(archive).map_err(|error| format!("打开归档失败：{error}"))?;
    let decoder =
        zstd::stream::read::Decoder::new(file).map_err(|error| format!("解压失败：{error}"))?;
    let mut tar = tar::Archive::new(decoder);
    tar.unpack(target)
        .map_err(|error| format!("展开归档失败：{error}"))
}

/// 校验 staging 目录里的规则：清单可读、版本存在、每一项路径合规且哈希匹配。
///
/// 抽成独立函数是为了让测试能直接跑这条**生产路径**，而不是在测试里重写一遍。
fn verify_staged_rules(staging: &Path) -> Result<String, ProtocolError> {
    let missing = |detail: String| {
        ProtocolError::new(
            protocol::ERR_RULE_SET_MISSING,
            format!("规则数据不可用：{detail}"),
        )
    };

    let manifest_text = std::fs::read_to_string(staging.join("manifest.json"))
        .map_err(|error| missing(format!("归档里没有 manifest.json：{error}")))?;
    let manifest: serde_json::Value = serde_json::from_str(&manifest_text)
        .map_err(|error| missing(format!("清单不是合法 JSON：{error}")))?;
    let version = manifest["version"]
        .as_str()
        .ok_or_else(|| missing("清单缺少 version".into()))?
        .to_string();

    let items = manifest["items"]
        .as_array()
        .ok_or_else(|| missing("清单缺少 items".into()))?;
    if items.is_empty() {
        return Err(missing("清单是空的".into()));
    }

    for item in items {
        let id = item["id"].as_str().unwrap_or_default();
        let file = item["file"].as_str().unwrap_or_default();
        let sha = item["sha256"].as_str().unwrap_or_default();
        validate_rule_item(staging, id, file)?;
        if !trust::is_full_sha256(sha) {
            return Err(missing(format!("{id} 的哈希不是完整 sha256")));
        }
        let data = std::fs::read(staging.join(file))
            .map_err(|error| missing(format!("读取 {file} 失败：{error}")))?;
        if !trust::hash_matches(&data, sha) {
            return Err(missing(format!("{file} 的哈希与清单不符")));
        }
    }

    Ok(version)
}

/// 清单里的 `file` 必须是相对路径、不含 `..`，且解析后仍在规则目录内。
/// 否则 root 会按清单里的值去读任意文件。
fn validate_rule_item(dir: &Path, id: &str, file: &str) -> Result<(), ProtocolError> {
    let reject = |detail: String| {
        ProtocolError::new(
            protocol::ERR_RULE_SET_MISSING,
            format!("规则清单项不合法：{detail}"),
        )
    };
    if id.is_empty() || file.is_empty() {
        return Err(reject("id 或 file 为空".into()));
    }
    if id.contains('/') || id.contains('\\') || id.contains("..") {
        return Err(reject(format!("id 含路径成分：{id}")));
    }
    let path = Path::new(file);
    if path.is_absolute() {
        return Err(reject(format!("file 是绝对路径：{file}")));
    }
    if path
        .components()
        .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        return Err(reject(format!("file 含 ..：{file}")));
    }
    let joined = dir.join(path);
    if !joined.starts_with(dir) {
        return Err(reject(format!("file 跑出规则目录：{file}")));
    }
    Ok(())
}

/// 安装包内的运行时：`.../Veyl.app/Contents/MacOS/veyl-helper`
/// → `.../Veyl.app/Contents/Resources/runtime/sing-box`。
fn bundled_runtime() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let contents = exe.parent()?.parent()?;
    runtime_in(&contents.join("Resources/runtime"))
}

fn runtime_in(dir: &Path) -> Option<PathBuf> {
    let candidate = dir.join("sing-box");
    candidate.is_file().then_some(candidate)
}

fn pick_loopback_port() -> Result<u16, ProtocolError> {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").map_err(|error| {
        ProtocolError::new(
            protocol::ERR_TUN_START_FAILED,
            format!("无法分配控制端口：{error}"),
        )
    })?;
    let port = listener
        .local_addr()
        .map_err(|error| ProtocolError::new(protocol::ERR_TUN_START_FAILED, format!("{error}")))?
        .port();
    drop(listener);
    Ok(port)
}

fn random_secret() -> String {
    use rand::RngCore;
    let mut bytes = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut bytes);
    hex(&bytes)
}

fn hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

/// 只写自己目录里的文件；`O_NOFOLLOW` 挡符号链接，权限 0600。
fn write_private(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)?;
    file.write_all(bytes)?;
    file.sync_all()
}

// ---------------------------------------------------------------------------
// 用户目录日志：~/.veyl/helper-logs/{helper,sing-box}.log
//
// helper 是 root，写用户目录必须防软链与替换：逐级 openat(O_DIRECTORY|O_NOFOLLOW)、
// 校验属主与写权限，文件 O_CREAT|O_APPEND|O_NOFOLLOW + 0644。
// 任何异常只打 stderr，不失败、不换路径。
// uid 由 XPC 连接对端推出（getpwuid），不采信客户端传来的任何路径。
// ---------------------------------------------------------------------------

/// 一次连接的日志写入端。`session` 让上一轮读线程收尾迟到时被丢弃，
/// 不会把旧连接的尾巴写进新连接的文件。
struct SingBoxSink {
    file: std::fs::File,
    written: u64,
    session: u64,
}

struct UserLogs {
    helper: Mutex<std::fs::File>,
    sing_box: Mutex<Option<SingBoxSink>>,
    /// 上一轮读线程的完成信号。新连接最多等它 500ms，避免新一轮的轮转
    /// 落在旧一轮还在写的时刻。
    reader_done: Mutex<Option<std::sync::mpsc::Receiver<()>>>,
    sing_box_session: AtomicU64,
    sing_box_write_failed: AtomicBool,
    sing_box_path: PathBuf,
    uid: u32,
    /// 已经校验过的 `helper-logs` 目录。之后的 openat / renameat / unlinkat
    /// 全部相对它执行；父链事后被换成软链也影响不到这里。
    dir: Fd,
}

impl UserLogs {
    fn open(home: &Path, uid: u32, gid: u32) -> Result<Self, String> {
        let home_fd = Fd::new(open_dir_nofollow(home)?);
        verify_dir(home_fd.raw(), uid, false)?;
        let veyl_fd = Fd::new(open_or_create_dir(
            home_fd.raw(),
            veyl_paths::DATA_DIR_NAME,
            0o700,
            uid,
            gid,
            true,
        )?);
        let dir = Fd::new(open_or_create_dir(
            veyl_fd.raw(),
            "helper-logs",
            0o755,
            uid,
            gid,
            false,
        )?);
        let dir_path = veyl_paths::helper_logs_dir(&veyl_paths::data_dir_under(home));
        let sing_box_path = dir_path.join("sing-box.log");
        rotate_in_dir(dir.raw(), "helper.log", HELPER_LOG_MAX_BYTES, 1);
        let helper = open_log_at(dir.raw(), "helper.log", uid)?;
        Ok(Self {
            helper: Mutex::new(helper),
            sing_box: Mutex::new(None),
            reader_done: Mutex::new(None),
            sing_box_session: AtomicU64::new(0),
            sing_box_write_failed: AtomicBool::new(false),
            sing_box_path,
            uid,
            dir,
        })
    }

    fn append_helper(&self, line: &str) {
        let mut file = self.helper.lock().unwrap();
        let oversized = file
            .metadata()
            .map(|meta| meta.len() > HELPER_LOG_MAX_BYTES)
            .unwrap_or(false);
        if oversized {
            rotate_in_dir(self.dir.raw(), "helper.log", HELPER_LOG_MAX_BYTES, 1);
            if let Ok(reopened) = open_log_at(self.dir.raw(), "helper.log", self.uid) {
                *file = reopened;
            }
        }
        let _ = writeln!(file, "{line}");
    }

    /// 为新一次连接准备 sing-box 日志：等上一轮读线程收尾、轮转过大的旧文件、
    /// 打开新的写入端。返回这一轮的会话号。
    fn begin_sing_box(&self) -> Result<u64, String> {
        let previous = self.reader_done.lock().unwrap().take();
        if let Some(done) = previous {
            // 子进程已经退出，读线程通常立刻返回；等不到就继续，
            // 最坏只是让旧读线程多写一个管道缓冲进新文件，会话号会挡住它。
            let _ = done.recv_timeout(Duration::from_millis(500));
        }
        let session = self.sing_box_session.fetch_add(1, Ordering::SeqCst) + 1;
        self.sing_box_write_failed.store(false, Ordering::SeqCst);
        // 旧版本或异常中断可能留下远超上限的文件：整份留成备份等于没上限，直接丢掉。
        let existing = stat_at(self.dir.raw(), "sing-box.log")
            .map(|stat| stat.st_size.max(0) as u64)
            .unwrap_or(0);
        if existing > TUN_LOG_MAX_BYTES {
            unlink_at(self.dir.raw(), "sing-box.log");
        } else {
            rotate_in_dir(
                self.dir.raw(),
                "sing-box.log",
                TUN_LOG_MAX_BYTES,
                TUN_LOG_KEEP,
            );
        }
        let file = open_log_at(self.dir.raw(), "sing-box.log", self.uid)?;
        // 没到阈值时上一次的文件会继续用，计数必须从实际大小起算，
        // 否则能一路涨到接近两倍才轮转。
        let written = file.metadata().map(|meta| meta.len()).unwrap_or(0);
        *self.sing_box.lock().unwrap() = Some(SingBoxSink {
            file,
            written,
            session,
        });
        Ok(session)
    }

    /// 起常驻读线程。必须在子进程 spawn **之前**调用：管道没人读会写满，
    /// 子进程会阻塞在写日志上。
    fn start_capture(self: &Arc<Self>, read: std::fs::File, session: u64) -> Result<(), String> {
        let (done_tx, done_rx) = std::sync::mpsc::channel();
        let logs = Arc::clone(self);
        // 句柄丢掉即分离：线程读到 EOF 自己退出，收尾靠 `done_rx` 判断。
        let _reader = std::thread::Builder::new()
            .name("veyl-singbox-log".into())
            .spawn(move || {
                logs.pump(read, session);
                let _ = done_tx.send(());
            })
            .map_err(|error| format!("启动日志读线程失败：{error}"))?;
        *self.reader_done.lock().unwrap() = Some(done_rx);
        Ok(())
    }

    /// 把管道内容搬进文件；子进程退出（写端全关）时读到 EOF 自然结束。
    fn pump(&self, read: std::fs::File, session: u64) {
        use std::io::Read;
        let mut reader = std::io::BufReader::with_capacity(64 * 1024, read);
        let mut buf = vec![0u8; 64 * 1024];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(len) => self.append_sing_box(session, &buf[..len]),
                Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(_) => break,
            }
        }
    }

    fn append_sing_box(&self, session: u64, chunk: &[u8]) {
        use std::io::Write;
        let failed = {
            let mut slot = self.sing_box.lock().unwrap();
            let Some(sink) = slot.as_mut() else { return };
            if sink.session != session {
                return;
            }
            if sink.written + chunk.len() as u64 > TUN_LOG_MAX_BYTES {
                self.rotate_sing_box(sink);
            }
            match sink.file.write_all(chunk) {
                Ok(()) => {
                    sink.written += chunk.len() as u64;
                    false
                }
                Err(_) => true,
            }
        };
        if failed {
            // 写不进去（磁盘满等）不能阻塞子进程：继续读并丢弃，只在 helper.log 记一次。
            if !self.sing_box_write_failed.swap(true, Ordering::SeqCst) {
                self.append_helper("sing-box 日志写入失败，本次连接剩余输出丢弃");
            }
        }
    }

    /// 轮转运行中的日志。rename 没成功时打开的还是原文件，就地清空兜住上限；
    /// 打不开就清空旧句柄（此时它已经是 `.1`），同样不让文件继续长。
    fn rotate_sing_box(&self, sink: &mut SingBoxSink) {
        rotate_in_dir(
            self.dir.raw(),
            "sing-box.log",
            TUN_LOG_MAX_BYTES,
            TUN_LOG_KEEP,
        );
        match open_log_at(self.dir.raw(), "sing-box.log", self.uid) {
            Ok(file) => {
                let _ = file.set_len(0);
                sink.file = file;
            }
            Err(_) => {
                let _ = sink.file.set_len(0);
            }
        }
        sink.written = 0;
    }
}

/// 连接用户的 home 与 gid；解析不出来就放弃写用户日志。
fn peer_account(uid: u32) -> Option<(PathBuf, u32)> {
    use std::ffi::CStr;
    use std::os::unix::ffi::OsStrExt;

    let mut pwd: libc::passwd = unsafe { std::mem::zeroed() };
    let mut buf = vec![0 as libc::c_char; 4096];
    let mut result: *mut libc::passwd = std::ptr::null_mut();
    let status = unsafe {
        libc::getpwuid_r(
            uid as libc::uid_t,
            &mut pwd,
            buf.as_mut_ptr(),
            buf.len(),
            &mut result,
        )
    };
    if status != 0 || result.is_null() || pwd.pw_dir.is_null() {
        return None;
    }
    let home = unsafe { CStr::from_ptr(pwd.pw_dir) };
    Some((
        PathBuf::from(std::ffi::OsStr::from_bytes(home.to_bytes())),
        pwd.pw_gid as u32,
    ))
}

struct Fd(std::os::fd::RawFd);

impl Fd {
    fn new(fd: std::os::fd::RawFd) -> Self {
        Self(fd)
    }

    fn raw(&self) -> std::os::fd::RawFd {
        self.0
    }
}

impl Drop for Fd {
    fn drop(&mut self) {
        unsafe { libc::close(self.0) };
    }
}

fn open_dir_nofollow(path: &Path) -> Result<std::os::fd::RawFd, String> {
    use std::os::unix::ffi::OsStrExt;

    let c = std::ffi::CString::new(path.as_os_str().as_bytes())
        .map_err(|_| "路径含 NUL".to_string())?;
    let fd = unsafe {
        libc::open(
            c.as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
    };
    if fd < 0 {
        return Err(format!(
            "打开 {} 失败：{}",
            path.display(),
            std::io::Error::last_os_error()
        ));
    }
    Ok(fd)
}

fn open_or_create_dir(
    parent: std::os::fd::RawFd,
    name: &str,
    mode: u32,
    uid: u32,
    gid: u32,
    private: bool,
) -> Result<std::os::fd::RawFd, String> {
    let c = std::ffi::CString::new(name).map_err(|_| "目录名含 NUL".to_string())?;
    let flags = libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC;
    let mut fd = unsafe { libc::openat(parent, c.as_ptr(), flags) };
    if fd < 0 {
        let error = std::io::Error::last_os_error();
        if error.raw_os_error() != Some(libc::ENOENT) {
            return Err(format!("打开 {name} 失败：{error}"));
        }
        if unsafe { libc::mkdirat(parent, c.as_ptr(), mode as libc::mode_t) } != 0 {
            return Err(format!(
                "创建 {name} 失败：{}",
                std::io::Error::last_os_error()
            ));
        }
        fd = unsafe { libc::openat(parent, c.as_ptr(), flags) };
        if fd < 0 {
            return Err(format!(
                "重新打开 {name} 失败：{}",
                std::io::Error::last_os_error()
            ));
        }
        // root 创建时要交还给连接用户；以用户身份运行时目录本来就是他的。
        let chown_failed = unsafe { libc::geteuid() } == 0
            && unsafe { libc::fchown(fd, uid, gid) } != 0;
        if chown_failed || unsafe { libc::fchmod(fd, mode as libc::mode_t) } != 0 {
            unsafe { libc::close(fd) };
            return Err(format!(
                "{name} 属主/权限设置失败：{}",
                std::io::Error::last_os_error()
            ));
        }
    }
    verify_dir(fd, uid, private)?;
    Ok(fd)
}

fn verify_dir(fd: std::os::fd::RawFd, uid: u32, private: bool) -> Result<(), String> {
    let mut stat: libc::stat = unsafe { std::mem::zeroed() };
    if unsafe { libc::fstat(fd, &mut stat) } != 0 {
        return Err(format!(
            "读取目录状态失败：{}",
            std::io::Error::last_os_error()
        ));
    }
    if stat.st_mode & libc::S_IFMT != libc::S_IFDIR {
        return Err("不是目录".into());
    }
    if stat.st_uid != uid {
        return Err("目录属主不是连接用户".into());
    }
    if stat.st_mode & 0o022 != 0 {
        return Err("目录允许 group/other 写入".into());
    }
    if private && stat.st_mode & 0o077 != 0 {
        return Err("私有目录权限不是 0700".into());
    }
    Ok(())
}

fn open_log_at(dir_fd: std::os::fd::RawFd, name: &str, uid: u32) -> Result<std::fs::File, String> {
    use std::os::fd::FromRawFd;

    let c = std::ffi::CString::new(name).map_err(|_| "文件名含 NUL".to_string())?;
    let fd = unsafe {
        libc::openat(
            dir_fd,
            c.as_ptr(),
            libc::O_WRONLY | libc::O_CREAT | libc::O_APPEND | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            0o644 as libc::c_int,
        )
    };
    if fd < 0 {
        return Err(format!(
            "打开 {name} 失败：{}",
            std::io::Error::last_os_error()
        ));
    }
    if let Err(error) = verify_log_file(fd, uid) {
        unsafe { libc::close(fd) };
        return Err(error);
    }
    Ok(unsafe { std::fs::File::from_raw_fd(fd) })
}

fn verify_log_file(fd: std::os::fd::RawFd, uid: u32) -> Result<(), String> {
    let mut stat: libc::stat = unsafe { std::mem::zeroed() };
    if unsafe { libc::fstat(fd, &mut stat) } != 0 {
        return Err(format!(
            "读取日志状态失败：{}",
            std::io::Error::last_os_error()
        ));
    }
    if stat.st_mode & libc::S_IFMT != libc::S_IFREG {
        return Err("日志不是普通文件".into());
    }
    if stat.st_uid != uid && stat.st_uid != 0 {
        return Err("日志属主不合法".into());
    }
    if stat.st_mode & 0o022 != 0 {
        return Err("日志允许 group/other 写入".into());
    }
    Ok(())
}

/// 相对目录轮转：`fstatat` / `renameat` / `unlinkat`，不跟随任何路径。
fn rotate_in_dir(dir: std::os::fd::RawFd, name: &str, max_bytes: u64, keep: usize) {
    let Ok(stat) = stat_at(dir, name) else {
        return;
    };
    if stat.st_mode & libc::S_IFMT != libc::S_IFREG || (stat.st_size.max(0) as u64) < max_bytes {
        return;
    }
    if keep == 0 {
        let _ = unlink_at(dir, name);
        return;
    }
    for index in (1..=keep).rev() {
        let target = format!("{name}.{index}");
        if index == keep {
            let _ = unlink_at(dir, &target);
        }
        let source = if index == 1 {
            name.to_string()
        } else {
            format!("{name}.{}", index - 1)
        };
        let _ = rename_at(dir, &source, dir, &target);
    }
}

fn stat_at(dir: std::os::fd::RawFd, name: &str) -> Result<libc::stat, ()> {
    let c = std::ffi::CString::new(name).map_err(|_| ())?;
    let mut stat: libc::stat = unsafe { std::mem::zeroed() };
    if unsafe { libc::fstatat(dir, c.as_ptr(), &mut stat, libc::AT_SYMLINK_NOFOLLOW) } == 0 {
        Ok(stat)
    } else {
        Err(())
    }
}

fn unlink_at(dir: std::os::fd::RawFd, name: &str) {
    if let Ok(c) = std::ffi::CString::new(name) {
        unsafe { libc::unlinkat(dir, c.as_ptr(), 0) };
    }
}

fn rename_at(
    old_dir: std::os::fd::RawFd,
    old_name: &str,
    new_dir: std::os::fd::RawFd,
    new_name: &str,
) {
    let (Ok(old), Ok(new)) = (
        std::ffi::CString::new(old_name),
        std::ffi::CString::new(new_name),
    ) else {
        return;
    };
    unsafe { libc::renameat(old_dir, old.as_ptr(), new_dir, new.as_ptr()) };
}

/// 正常路径：sing-box 的 stdout/stderr 直接写用户日志。
/// 子进程的 stdout/stderr 接到同一根管道，由 helper 按大小轮转写入文件。
///
/// 读线程必须在 `spawn` **之前**就位：管道没人读会写满，子进程会阻塞在日志上。
/// helper 被 SIGKILL 时读端消失，sing-box 会在下一次写日志时收到 SIGPIPE 退出
/// （实测 1.14.4 退出码 141，不是忽略）；即便如此，`kill_orphan` 仍是兜底，
/// 不能只靠这个——发布版日志级别是 warn，可能很久才写下一行。
///
/// `Command` 必须按值传入：spawn 之后它仍持有写端的副本，只有 Command 被 drop
/// 才会关闭。调用方若把 Command 留在作用域里，读线程永远等不到 EOF。
fn spawn_with_pipe(
    mut command: Command,
    logs: &Arc<UserLogs>,
    session: u64,
) -> std::io::Result<Child> {
    use std::os::fd::FromRawFd;

    let mut fds = [0 as libc::c_int; 2];
    if unsafe { libc::pipe(fds.as_mut_ptr()) } != 0 {
        return Err(std::io::Error::last_os_error());
    }
    let (read_fd, write_fd) = (fds[0], fds[1]);
    // 别让别的线程 fork 出来的进程继承写端，否则子进程退出后管道永远等不到 EOF。
    for fd in [read_fd, write_fd] {
        unsafe { libc::fcntl(fd, libc::F_SETFD, libc::FD_CLOEXEC) };
    }
    let stderr_fd = unsafe { libc::dup(write_fd) };
    if stderr_fd < 0 {
        let error = std::io::Error::last_os_error();
        unsafe {
            libc::close(read_fd);
            libc::close(write_fd);
        }
        return Err(error);
    }
    unsafe { libc::fcntl(stderr_fd, libc::F_SETFD, libc::FD_CLOEXEC) };
    // 所有权转移：读端归读线程，两个写端归 Command（spawn 后父进程里的副本自动关闭）。
    let read = unsafe { std::fs::File::from_raw_fd(read_fd) };
    if let Err(error) = logs.start_capture(read, session) {
        unsafe {
            libc::close(write_fd);
            libc::close(stderr_fd);
        }
        return Err(std::io::Error::new(std::io::ErrorKind::Other, error));
    }
    let stdout = unsafe { Stdio::from_raw_fd(write_fd) };
    let stderr = unsafe { Stdio::from_raw_fd(stderr_fd) };
    command
        .stdin(Stdio::null())
        .stdout(stdout)
        .stderr(stderr)
        .spawn()
}

/// 用户日志不可用时宁可丢弃输出，也不退回别的路径。
fn spawn_without_log(binary: &Path, config: &Path) -> std::io::Result<Child> {
    Command::new(binary)
        .arg("run")
        .arg("-c")
        .arg(config)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
}

/// 进程启动时间（`LC_ALL=C` 固定格式）。用 `ps` 而不是 sysctl：
/// `kinfo_proc` 的结构布局要手抄一遍，抄错就是静默误判。
fn ps_start(pid: u32) -> Option<String> {
    let output = Command::new("/bin/ps")
        .env("LC_ALL", "C")
        .args(["-o", "lstart=", "-p", &pid.to_string()])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
    (!text.is_empty()).then_some(text)
}

#[link(name = "System")]
extern "C" {
    fn proc_pidpath(pid: libc::c_int, buffer: *mut c_void, size: u32) -> libc::c_int;
}

fn process_exe(pid: u32) -> Option<PathBuf> {
    let mut buffer = vec![0u8; 4096];
    let len = unsafe {
        proc_pidpath(
            pid as libc::c_int,
            buffer.as_mut_ptr() as *mut c_void,
            buffer.len() as u32,
        )
    };
    if len <= 0 {
        return None;
    }
    Some(PathBuf::from(
        String::from_utf8_lossy(&buffer[..len as usize]).to_string(),
    ))
}

fn process_alive(pid: u32) -> bool {
    unsafe { libc::kill(pid as libc::pid_t, 0) == 0 }
}

fn is_root() -> bool {
    // SAFETY: geteuid 无副作用。
    unsafe { libc::geteuid() == 0 }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(tag: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("veyl-helper-{tag}-{:016x}", rand::random::<u64>()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn a_changed_system_dns_downgrades_the_hijack_status() {
        let failed = dns_recheck_outcome(Ok(false)).expect("探测到已改写必须降级");
        assert!(!failed.applied);
        assert!(failed
            .reason
            .unwrap_or_default()
            .contains("网络或 DNS"));
        assert!(
            dns_recheck_outcome(Err("scutil 失败".into())).is_none(),
            "读不到不等于失效，保留上一次的结论"
        );
    }

    /// 降级不能是单向闩锁：用户把 DNS 改回来要能恢复「已接管」。
    #[test]
    fn a_restored_system_dns_brings_the_hijack_status_back() {
        let applied = dns_recheck_outcome(Ok(true)).expect("地址回来了必须恢复");
        assert!(applied.applied);
        assert!(applied.reason.is_none(), "恢复后不能留着上一次的原因");
    }

    #[test]
    fn diag_reads_the_tun_address_from_the_array() {
        let config = serde_json::json!({
            "inbounds": [{ "type": "tun", "address": ["172.19.0.1/30"] }]
        });
        assert_eq!(diag_tun_address(&config), "172.19.0.1");

        // 老形状（字符串）也认，别在换写法时把诊断再打回空串。
        let single = serde_json::json!({
            "inbounds": [{ "type": "tun", "address": "198.18.0.1/15" }]
        });
        assert_eq!(diag_tun_address(&single), "198.18.0.1");
    }

    #[test]
    fn diag_address_is_empty_when_the_config_has_none() {
        assert_eq!(diag_tun_address(&serde_json::json!({})), "");
        assert_eq!(
            diag_tun_address(&serde_json::json!({ "inbounds": [{ "type": "tun" }] })),
            ""
        );
    }

    #[test]
    fn rule_items_must_stay_inside_the_rules_directory() {
        let dir = temp("rules");
        assert!(validate_rule_item(&dir, "geosite-cn", "geosite/cn.srs").is_ok());

        for (id, file) in [
            ("geosite-cn", "/etc/passwd"),
            ("geosite-cn", "../../etc/passwd"),
            ("../evil", "geosite/cn.srs"),
            ("a/b", "geosite/cn.srs"),
            ("", "geosite/cn.srs"),
        ] {
            assert!(
                validate_rule_item(&dir, id, file).is_err(),
                "必须拒绝 id={id} file={file}"
            );
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_archive_round_trips() {
        // 这条验证的是解压路径本身：真打一个 tar.zst 再解开。
        let dir = temp("archive");
        let target = dir.join("out");
        std::fs::create_dir_all(&target).unwrap();

        let path = dir.join("veyl-rules-test.tar.zst");
        let file = std::fs::File::create(&path).unwrap();
        let encoder = zstd::stream::write::Encoder::new(file, 3).unwrap();
        let mut tar = tar::Builder::new(encoder);
        let body = b"{\"version\":\"test\"}";
        let mut header = tar::Header::new_gnu();
        header.set_size(body.len() as u64);
        header.set_mode(0o644);
        header.set_cksum();
        tar.append_data(&mut header, "manifest.json", &body[..])
            .unwrap();
        let encoder = tar.into_inner().unwrap();
        encoder.finish().unwrap();

        unpack_archive(&path, &target).unwrap();
        let text = std::fs::read_to_string(target.join("manifest.json")).unwrap();
        assert!(text.contains("test"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn bundled_archive_lookup_ignores_unrelated_files() {
        // 只认 veyl-rules-*.tar.zst，别的文件不参与。
        let dir = temp("pick");
        let rules = dir.join("rules");
        std::fs::create_dir_all(&rules).unwrap();
        std::fs::write(rules.join("manifest.json"), b"{}").unwrap();
        std::fs::write(rules.join("veyl-rules-1.tar.zst"), b"x").unwrap();

        let names: Vec<String> = std::fs::read_dir(&rules)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().to_string())
            .filter(|n| n.starts_with("veyl-rules-") && n.ends_with(".tar.zst"))
            .collect();
        assert_eq!(names, vec!["veyl-rules-1.tar.zst"]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 拿仓库里**真实的**规则归档跑一遍：解压 → 读清单 → 逐项核对哈希。
    /// 没有归档时跳过（CI 上不保证有）。这条是「资源这条链对不对」的直接证据。
    #[test]
    fn the_real_rules_archive_unpacks_and_verifies() {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("resources/rules");
        let archive = std::fs::read_dir(&dir).ok().and_then(|entries| {
            let mut found: Vec<PathBuf> = entries
                .flatten()
                .map(|entry| entry.path())
                .filter(|path| {
                    let name = path
                        .file_name()
                        .and_then(|n| n.to_str())
                        .unwrap_or_default();
                    name.starts_with("veyl-rules-") && name.ends_with(".tar.zst")
                })
                .collect();
            found.sort();
            found.pop()
        });
        let Some(archive) = archive else {
            eprintln!("没有规则归档，跳过");
            return;
        };

        let work = temp("real-rules");
        unpack_archive(&archive, &work).expect("真实归档必须能解开");

        // 直接跑生产路径：解压之后的校验就是这个函数。
        let version = verify_staged_rules(&work).expect("真实归档必须通过校验");
        assert!(!version.is_empty());

        let manifest: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(work.join("manifest.json")).unwrap())
                .expect("清单必须是合法 JSON");
        let ids: Vec<&str> = manifest["items"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|item| item["id"].as_str())
            .collect();
        for needed in ["geosite-cn", "geoip-cn"] {
            assert!(ids.contains(&needed), "缺少 {needed}");
        }
        eprintln!("版本 {version}，{} 个规则集全部通过校验", ids.len());

        let _ = std::fs::remove_dir_all(&work);
    }

    /// bundle 内资源落点：`Contents/Resources/runtime/sing-box` 与
    /// `Contents/Resources/resources/rules/veyl-rules-*.tar.zst`。
    /// 这两个路径是推断出来的（Tauri 对 `resources/rules/` 的映射），
    /// 所以至少要证明「按这个布局放文件，helper 找得到」。
    #[test]
    fn bundle_resource_paths_resolve_as_expected() {
        let root = temp("bundle");
        let contents = root.join("Contents");
        std::fs::create_dir_all(contents.join("Resources/runtime")).unwrap();
        std::fs::create_dir_all(contents.join("Resources/resources/rules")).unwrap();

        std::fs::write(contents.join("Resources/runtime/sing-box"), b"x").unwrap();
        std::fs::write(
            contents.join("Resources/resources/rules/veyl-rules-2026-11-04.1.tar.zst"),
            b"x",
        )
        .unwrap();
        std::fs::write(
            contents.join("Resources/resources/rules/manifest.json"),
            b"{}",
        )
        .unwrap();

        assert_eq!(
            runtime_in(&contents.join("Resources/runtime")),
            Some(contents.join("Resources/runtime/sing-box"))
        );
        let archive = rules_archive_in(&contents.join("Resources/resources/rules"))
            .expect("必须找到规则归档");
        assert!(archive
            .to_string_lossy()
            .ends_with("veyl-rules-2026-11-04.1.tar.zst"));

        let _ = std::fs::remove_dir_all(&root);
    }

    /// A 类问题的专属回归：没有规则数据时必须给空表。
    /// 之前这里返回 Result，不带分流的配置（全部走 VPN）会被一起挡住。
    #[test]
    fn a_missing_rule_index_is_empty_not_an_error() {
        let dir = temp("noindex");
        let supervisor = Supervisor::new(dir.clone());
        assert!(
            supervisor.rule_index().is_empty(),
            "没有规则数据时要给空表，不能报错"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_rule_index_skips_items_with_bad_paths() {
        let dir = temp("badindex");
        let current = dir.join("rules").join("current");
        std::fs::create_dir_all(&current).unwrap();
        std::fs::write(current.join("ok.srs"), b"x").unwrap();
        std::fs::write(
            current.join("manifest.json"),
            serde_json::json!({
                "version": "t",
                "items": [
                    {"id": "geosite-cn", "file": "ok.srs", "sha256": "0".repeat(64)},
                    {"id": "evil", "file": "/etc/passwd", "sha256": "0".repeat(64)},
                    {"id": "trav", "file": "../../etc/passwd", "sha256": "0".repeat(64)}
                ]
            })
            .to_string(),
        )
        .unwrap();

        let supervisor = Supervisor::new(dir.clone());
        let index = supervisor.rule_index();
        assert_eq!(index.len(), 1, "不合规的项必须被跳过：{index:?}");
        assert!(index.contains_key("geosite-cn"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn current_uid() -> u32 {
        // SAFETY: geteuid 无副作用。
        unsafe { libc::geteuid() as u32 }
    }

    /// 测试里的签名校验：不在 CI 或本机上依赖真实证书。
    fn signature_ok(_: &Path) -> Result<(), ProtocolError> {
        Ok(())
    }

    fn stage(supervisor: &Supervisor, bundled: PathBuf) -> Result<PathBuf, ProtocolError> {
        supervisor.resolve_runtime_from(Some(bundled), || Ok(()), signature_ok, current_uid())
    }

    /// 签名会重签包内那个 Mach-O，字节随之改变，构建期哈希只对未签名的产物成立。
    /// 这里钉住新行为：哈希取自**包内文件自身的内容**，目录名与执行的文件同源。
    #[test]
    fn a_runtime_is_staged_under_the_hash_of_its_own_bytes() {
        let root = temp("stage");
        let bundled = root.join("bundle-sing-box");
        let bytes = b"a signed runtime whose bytes no longer match the build-time digest";
        std::fs::write(&bundled, bytes).unwrap();

        let supervisor = Supervisor::new(root.clone());
        let dest = stage(&supervisor, bundled).unwrap();

        let digest = sha256_hex(bytes);
        if let Some(built) = protocol::runtime_sha256() {
            assert_ne!(digest, built, "签名后的文件不可能与构建期哈希一致");
        }
        assert_eq!(dest, root.join("runtime").join(&digest).join("sing-box"));
        assert_eq!(std::fs::read(&dest).unwrap(), bytes);
        let _ = std::fs::remove_dir_all(&root);
    }

    /// 先验来源、再读内容：bundle 不可信时不该先把它的字节读进来。
    #[test]
    fn an_untrusted_bundle_is_rejected_before_its_bytes_are_read() {
        let root = temp("untrusted");
        let supervisor = Supervisor::new(root.clone());
        let missing = root.join("does-not-exist");

        let error = supervisor
            .resolve_runtime_from(
                Some(missing),
                || {
                    Err(ProtocolError::new(
                        protocol::ERR_RUNTIME_MISSING,
                        "来源不可信",
                    ))
                },
                signature_ok,
                current_uid(),
            )
            .unwrap_err();

        assert_eq!(
            error.message, "来源不可信",
            "必须先验 bundle；先去读文件会得到另一条错误"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    /// 磁盘上的副本坏了：删掉，用包内字节重建一次——而不是直接采信。
    #[test]
    fn a_tampered_staged_runtime_is_rebuilt_from_the_bundle() {
        use std::os::unix::fs::PermissionsExt;

        let root = temp("tamper");
        let bundled = root.join("bundle-sing-box");
        let bytes = b"genuine runtime";
        std::fs::write(&bundled, bytes).unwrap();

        let supervisor = Supervisor::new(root.clone());
        let dest = stage(&supervisor, bundled.clone()).unwrap();
        std::fs::write(&dest, b"tampered runtime").unwrap();
        std::fs::set_permissions(&dest, std::fs::Permissions::from_mode(0o755)).unwrap();

        let rebuilt = stage(&supervisor, bundled).unwrap();

        assert_eq!(rebuilt, dest);
        assert_eq!(
            std::fs::read(&rebuilt).unwrap(),
            bytes,
            "必须用包内字节重建，不能沿用被替换的副本"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    /// 签名不过的内容不许留在 root 目录里，也不许被执行。
    #[test]
    fn a_runtime_that_fails_signature_verification_leaves_nothing_behind() {
        let root = temp("badsig");
        let bundled = root.join("bundle-sing-box");
        let bytes = b"unsigned runtime";
        std::fs::write(&bundled, bytes).unwrap();

        let supervisor = Supervisor::new(root.clone());
        let error = supervisor
            .resolve_runtime_from(
                Some(bundled),
                || Ok(()),
                |_| {
                    Err(ProtocolError::new(
                        protocol::ERR_RUNTIME_MISSING,
                        "签名不符",
                    ))
                },
                current_uid(),
            )
            .unwrap_err();

        assert_eq!(error.code, protocol::ERR_RUNTIME_MISSING);
        assert!(
            !root.join("runtime").join(sha256_hex(bytes)).exists(),
            "签名不过的内容必须删掉"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    /// 每次重签都会产生新哈希；旧目录不清理，一次就多留 173 MB。
    /// 但只动我们自己建的（名字是完整 sha256 的目录）。
    #[test]
    fn staging_prunes_previous_runtimes_and_leaves_foreign_entries_alone() {
        let root = temp("prune");
        let runtime_dir = root.join("runtime");
        std::fs::create_dir_all(&runtime_dir).unwrap();

        let old = runtime_dir.join("a".repeat(64));
        std::fs::create_dir_all(&old).unwrap();
        let foreign = runtime_dir.join("not-ours");
        std::fs::create_dir_all(&foreign).unwrap();
        let keep = "b".repeat(64);
        std::fs::create_dir_all(runtime_dir.join(&keep)).unwrap();

        prune_staged_runtimes(&runtime_dir, &keep);

        assert!(!old.exists(), "旧哈希目录必须清掉");
        assert!(runtime_dir.join(&keep).exists());
        assert!(foreign.exists(), "不是我们建的目录不动");
        let _ = std::fs::remove_dir_all(&root);
    }

    /// 清理只删真实目录：名字像哈希的软链不能被顺着删到外面去。
    #[test]
    fn pruning_does_not_follow_symlinks() {
        let root = temp("prune-link");
        let runtime_dir = root.join("runtime");
        std::fs::create_dir_all(&runtime_dir).unwrap();

        let target = root.join("elsewhere");
        std::fs::create_dir_all(&target).unwrap();
        std::fs::write(target.join("keep-me"), b"x").unwrap();
        let link = runtime_dir.join("c".repeat(64));
        std::os::unix::fs::symlink(&target, &link).unwrap();

        prune_staged_runtimes(&runtime_dir, &"d".repeat(64));

        assert!(
            target.join("keep-me").exists(),
            "不能顺着软链删掉外面的东西"
        );
        assert!(
            std::fs::symlink_metadata(&link).is_ok(),
            "软链本身不是我们建的目录，不能被删——回归成 path.is_dir() 时这条会红"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    /// 已有 staged 副本也不能绕过 bundle 验签：不回退到旧副本。
    #[test]
    fn an_existing_staged_copy_does_not_bypass_a_failing_bundle_check() {
        let root = temp("no-fallback");
        let bundled = root.join("bundle-sing-box");
        std::fs::write(&bundled, b"runtime").unwrap();

        let supervisor = Supervisor::new(root.clone());
        stage(&supervisor, bundled.clone()).unwrap();

        let error = supervisor
            .resolve_runtime_from(
                Some(bundled),
                || {
                    Err(ProtocolError::new(
                        protocol::ERR_RUNTIME_MISSING,
                        "来源不可信",
                    ))
                },
                signature_ok,
                current_uid(),
            )
            .unwrap_err();

        assert_eq!(
            error.message, "来源不可信",
            "bundle 验不过时必须报错，不能拿已有副本继续"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    /// 契约 §3.2：运行中要能报出 clash 地址与特权侧生成的启动时刻，
    /// App 崩溃重启后靠这一次 `status` 接手。
    #[test]
    fn a_running_child_reports_its_clash_endpoint_and_start_time() {
        let dir = temp("running");
        let supervisor = Supervisor::new(dir.clone());
        let child = Command::new("/bin/sleep").arg("30").spawn().unwrap();
        let pid = child.id();
        *supervisor.child.lock().unwrap() = Some(child);
        *supervisor.running.lock().unwrap() = Some(Running {
            pid,
            clash_addr: "127.0.0.1:50000".into(),
            clash_secret: "s3cret".into(),
            since: "2026-11-05T00:00:00Z".into(),
        });

        let status = supervisor.status().expect("sleep 还活着");
        assert_eq!(status.pid, pid);
        assert_eq!(status.clash_addr, "127.0.0.1:50000");
        assert_eq!(status.clash_secret, "s3cret");
        assert_eq!(status.since, "2026-11-05T00:00:00Z");

        supervisor.stop();
        assert!(supervisor.status().is_none(), "停掉之后不能再报 running");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 子进程死了，旧的 clash 信息必须一起清掉，不能报一个已经不在的连接。
    #[test]
    fn a_dead_child_clears_the_running_details() {
        let dir = temp("dead-child");
        let supervisor = Supervisor::new(dir.clone());
        let child = Command::new("/usr/bin/true").spawn().unwrap();
        let pid = child.id();
        *supervisor.child.lock().unwrap() = Some(child);
        *supervisor.running.lock().unwrap() = Some(Running {
            pid,
            clash_addr: "127.0.0.1:50000".into(),
            clash_secret: "s".into(),
            since: "2026-11-05T00:00:00Z".into(),
        });

        std::thread::sleep(Duration::from_millis(300));
        assert!(supervisor.status().is_none());
        assert!(
            supervisor.running.lock().unwrap().is_none(),
            "死掉的子进程不能让旧信息留着"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 轮转必须走 dirfd；父链被别人换掉也只会作用在原来的目录上。
    #[test]
    fn an_oversized_helper_log_is_rotated_inside_the_original_dir() {
        let home = temp("log-rotate");
        let uid = unsafe { libc::getuid() };
        let gid = unsafe { libc::getgid() };
        let logs = UserLogs::open(&home, uid, gid).unwrap();
        let dir = veyl_paths::helper_logs_dir(&veyl_paths::data_dir_under(&home));

        logs.append_helper(&"x".repeat(HELPER_LOG_MAX_BYTES as usize + 1));
        logs.append_helper("after-rotation");

        assert!(dir.join("helper.log.1").exists(), "超限的日志要挪走");
        let current = std::fs::read_to_string(dir.join("helper.log")).unwrap();
        assert!(current.contains("after-rotation"), "{current}");
        let _ = std::fs::remove_dir_all(&home);
    }

    fn sing_box_size(dir: &Path) -> u64 {
        std::fs::metadata(dir.join("sing-box.log"))
            .map(|meta| meta.len())
            .unwrap_or(0)
    }

    /// 会话进行中写穿阈值也必须轮转：不能等下一次连接。
    #[test]
    fn an_oversized_sing_box_log_rotates_while_the_session_is_running() {
        let home = temp("sing-box-rotate");
        let uid = unsafe { libc::getuid() };
        let gid = unsafe { libc::getgid() };
        let logs = UserLogs::open(&home, uid, gid).unwrap();
        let dir = veyl_paths::helper_logs_dir(&veyl_paths::data_dir_under(&home));
        let session = logs.begin_sing_box().unwrap();

        let chunk = vec![b'x'; 64 * 1024];
        for _ in 0..(TUN_LOG_MAX_BYTES / chunk.len() as u64 + 20) {
            logs.append_sing_box(session, &chunk);
        }

        assert!(dir.join("sing-box.log.1").exists(), "超限的日志要挪走");
        assert!(sing_box_size(&dir) <= TUN_LOG_MAX_BYTES);
        let backup = std::fs::metadata(dir.join("sing-box.log.1")).unwrap().len();
        assert!(backup <= TUN_LOG_MAX_BYTES, "备份也不能超限：{backup}");
        assert!(
            std::fs::metadata(dir.join("sing-box.log.2")).is_err(),
            "只保留一份备份"
        );

        logs.append_sing_box(session, b"after-rotation\n");
        let current = std::fs::read_to_string(dir.join("sing-box.log")).unwrap();
        assert!(current.contains("after-rotation"), "{current}");
        let _ = std::fs::remove_dir_all(&home);
    }

    /// 上一轮读线程迟到的尾巴不能写进新一轮的文件。
    #[test]
    fn a_late_writer_from_the_previous_session_is_ignored() {
        let home = temp("sing-box-session");
        let uid = unsafe { libc::getuid() };
        let gid = unsafe { libc::getgid() };
        let logs = UserLogs::open(&home, uid, gid).unwrap();
        let dir = veyl_paths::helper_logs_dir(&veyl_paths::data_dir_under(&home));

        let previous = logs.begin_sing_box().unwrap();
        let current = logs.begin_sing_box().unwrap();
        logs.append_sing_box(previous, b"stale\n");
        logs.append_sing_box(current, b"fresh\n");

        let text = std::fs::read_to_string(dir.join("sing-box.log")).unwrap();
        assert!(!text.contains("stale"), "旧会话的尾巴必须丢弃：{text}");
        assert!(text.contains("fresh"), "{text}");
        let _ = std::fs::remove_dir_all(&home);
    }

    /// 管道版：stdout/stderr 都进同一个文件，写端关闭后读线程必须 drain 完再退出。
    #[test]
    fn a_childs_stdout_and_stderr_are_drained_into_the_log() {
        use std::sync::Arc;

        let home = temp("sing-box-pipe");
        let uid = unsafe { libc::getuid() };
        let gid = unsafe { libc::getgid() };
        let logs = Arc::new(UserLogs::open(&home, uid, gid).unwrap());
        let dir = veyl_paths::helper_logs_dir(&veyl_paths::data_dir_under(&home));
        let session = logs.begin_sing_box().unwrap();

        let mut command = Command::new("/bin/sh");
        command
            .arg("-c")
            .arg("printf 'from-stdout\\n'; printf 'from-stderr\\n' 1>&2");
        let mut child = spawn_with_pipe(command, &logs, session).unwrap();
        child.wait().unwrap();

        let done = logs.reader_done.lock().unwrap().take().unwrap();
        done.recv_timeout(Duration::from_secs(5))
            .expect("写端关闭后读线程必须退出");

        let text = std::fs::read_to_string(dir.join("sing-box.log")).unwrap();
        assert!(text.contains("from-stdout"), "{text}");
        assert!(text.contains("from-stderr"), "{text}");
        let _ = std::fs::remove_dir_all(&home);
    }

    /// helper 崩溃后重启：崩溃前刚好写满的文件在重新打开时轮转；
    /// 旧版本留下的超大文件直接丢掉，不能整份留成备份。
    #[test]
    fn a_log_left_oversized_by_a_crashed_helper_is_brought_back_under_the_cap() {
        let home = temp("sing-box-crash");
        let uid = unsafe { libc::getuid() };
        let gid = unsafe { libc::getgid() };
        let logs = UserLogs::open(&home, uid, gid).unwrap();
        let dir = veyl_paths::helper_logs_dir(&veyl_paths::data_dir_under(&home));
        std::fs::write(
            dir.join("sing-box.log"),
            vec![b'x'; TUN_LOG_MAX_BYTES as usize],
        )
        .unwrap();

        logs.begin_sing_box().unwrap();

        assert!(dir.join("sing-box.log.1").exists());
        assert!(sing_box_size(&dir) <= TUN_LOG_MAX_BYTES);
        let backup = std::fs::metadata(dir.join("sing-box.log.1")).unwrap().len();
        assert!(backup <= TUN_LOG_MAX_BYTES, "备份也不能超限：{backup}");

        std::fs::write(
            dir.join("sing-box.log"),
            vec![b'x'; TUN_LOG_MAX_BYTES as usize * 3],
        )
        .unwrap();
        logs.begin_sing_box().unwrap();

        assert_eq!(sing_box_size(&dir), 0, "超大遗留文件必须清空");
        assert!(
            std::fs::metadata(dir.join("sing-box.log.2")).is_err(),
            "超大文件不能整份留成备份"
        );
        let _ = std::fs::remove_dir_all(&home);
    }

    /// 打开之后把 `helper-logs` 换成软链：写入和新建都必须留在原目录。
    #[test]
    fn a_replaced_logs_dir_does_not_redirect_writes() {
        let home = temp("log-swap");
        let uid = unsafe { libc::getuid() };
        let gid = unsafe { libc::getgid() };
        let logs = UserLogs::open(&home, uid, gid).unwrap();
        let data = veyl_paths::data_dir_under(&home);
        let real = data.join("helper-logs");
        let moved = data.join("helper-logs-real");
        std::fs::rename(&real, &moved).unwrap();
        let elsewhere = home.join("elsewhere");
        std::fs::create_dir_all(&elsewhere).unwrap();
        std::os::unix::fs::symlink(&elsewhere, &real).unwrap();

        logs.append_helper("after-swap");
        logs.begin_sing_box().unwrap();

        assert!(
            std::fs::read_to_string(moved.join("helper.log"))
                .unwrap()
                .contains("after-swap"),
            "写入必须落在已经校验过的目录"
        );
        assert!(moved.join("sing-box.log").exists());
        assert!(!elsewhere.join("helper.log").exists(), "软链目标不能出现日志");
        assert!(!elsewhere.join("sing-box.log").exists());
        let _ = std::fs::remove_dir_all(&home);
    }

    /// 规则预置完成发生在一个用户已经连过之后：这条没有连接上下文的日志
    /// 必须写进最近那个用户日志，不能一直堆在 pending 里。
    #[test]
    fn a_note_after_a_user_log_exists_is_written_not_buffered() {
        use std::sync::Arc;

        let home = temp("late-notes");
        let uid = unsafe { libc::getuid() };
        let gid = unsafe { libc::getgid() };
        let supervisor = Supervisor::new(temp("late-root"));
        let logs = Arc::new(UserLogs::open(&home, uid, gid).unwrap());
        let fake = 100_010;
        supervisor
            .user_logs
            .lock()
            .unwrap()
            .insert(fake, Arc::clone(&logs));
        // 模拟这个用户刚刚连过：note() 应当跟随最近一次接入。
        *supervisor.last_uid.lock().unwrap() = Some(fake);

        supervisor.note("规则预置完成");

        let text = std::fs::read_to_string(
            veyl_paths::helper_logs_dir(&veyl_paths::data_dir_under(&home)).join("helper.log"),
        )
        .unwrap();
        assert!(text.contains("规则预置完成"), "{text}");
        assert!(
            supervisor.pending_notes.lock().unwrap().is_empty(),
            "已有用户日志时不该再进 pending"
        );
        let _ = std::fs::remove_dir_all(&home);
    }

    /// 多用户：每个 uid 的日志与 sing-box 日志各回各家。
    #[test]
    fn different_users_get_their_own_logs() {
        use std::sync::Arc;

        let home_a = temp("multi-a");
        let home_b = temp("multi-b");
        let uid = unsafe { libc::getuid() };
        let gid = unsafe { libc::getgid() };
        let logs_a = Arc::new(UserLogs::open(&home_a, uid, gid).unwrap());
        let logs_b = Arc::new(UserLogs::open(&home_b, uid, gid).unwrap());
        let supervisor = Supervisor::new(temp("multi-root"));
        supervisor
            .user_logs
            .lock()
            .unwrap()
            .insert(100_001, Arc::clone(&logs_a));
        supervisor
            .user_logs
            .lock()
            .unwrap()
            .insert(100_002, Arc::clone(&logs_b));

        supervisor.note_for(100_001, "a-line");
        supervisor.note_for(100_002, "b-line");

        let read = |home: &Path| {
            std::fs::read_to_string(
                veyl_paths::helper_logs_dir(&veyl_paths::data_dir_under(home))
                    .join("helper.log"),
            )
            .unwrap()
        };
        assert!(read(&home_a).contains("a-line"));
        assert!(!read(&home_a).contains("b-line"));
        assert!(read(&home_b).contains("b-line"));
        assert!(!read(&home_b).contains("a-line"));
        assert_eq!(
            supervisor.sing_box_log_path(100_001),
            Some(logs_a.sing_box_path.clone())
        );
        assert_eq!(
            supervisor.sing_box_log_path(100_002),
            Some(logs_b.sing_box_path.clone())
        );
        let _ = std::fs::remove_dir_all(&home_a);
        let _ = std::fs::remove_dir_all(&home_b);
    }

    /// 客户端超时后发来的 stop 必须能让进行中的 start 让路。
    #[test]
    fn a_stop_request_cancels_a_pending_start() {
        let root = temp("cancel");
        let supervisor = Supervisor::new(root.clone());
        assert!(!supervisor.stop_requested.load(Ordering::SeqCst));

        supervisor.stop();
        assert!(supervisor.stop_requested.load(Ordering::SeqCst));

        let error = check_start_allowed(true, Duration::from_millis(1)).unwrap_err();
        assert!(error.message.contains("取消"), "{}", error.message);
        let _ = std::fs::remove_dir_all(&root);
    }

    /// 准备阶段超过上限就不该再 spawn。
    #[test]
    fn a_start_that_takes_too_long_is_abandoned_before_spawn() {
        assert!(check_start_allowed(false, Duration::from_secs(1)).is_ok());

        let error = check_start_allowed(false, START_PREPARE_DEADLINE + Duration::from_secs(1))
            .unwrap_err();
        assert!(error.message.contains("25 秒"), "{}", error.message);
    }

    /// spawn 之后才到达的 stop：登记前必须杀掉这个 child。
    #[test]
    fn a_child_spawned_after_a_stop_is_killed_on_registration() {
        let root = temp("postspawn-cancel");
        let supervisor = Supervisor::new(root.clone());
        supervisor.stop_requested.store(true, Ordering::SeqCst);

        let child = Command::new("/bin/sleep").arg("30").spawn().unwrap();
        let pid = child.id();
        let error = supervisor
            .register_child(
                child,
                Running {
                    pid,
                    clash_addr: "127.0.0.1:1".into(),
                    clash_secret: "s".into(),
                    since: "2026-01-01T00:00:00Z".into(),
                        },
                // 假 uid：解析不到 home，只写 stderr，测试不碰真实家目录。
                60_000,
            )
            .unwrap_err();

        assert!(error.message.contains("取消"), "{}", error.message);
        let alive = unsafe { libc::kill(pid as libc::pid_t, 0) == 0 };
        assert!(!alive, "取消后子进程必须已经退出");
        let _ = std::fs::remove_dir_all(&root);
    }

    /// check 挂住必须在期限处被终止，否则会一直占着 start_lock。
    #[test]
    fn a_hung_check_is_killed_at_the_deadline() {
        use std::os::unix::fs::PermissionsExt;

        let dir = temp("check-timeout");
        let script = dir.join("slow-check");
        // 睡够久：期限一旦被放松，下面的 <1s 断言会立刻红。
        std::fs::write(&script, "#!/bin/sh\nsleep 10\n").unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();

        let started = Instant::now();
        let error = check_config(
            &script,
            &dir.join("config.json"),
            Duration::from_millis(200),
        )
        .unwrap_err();
        assert!(error.message.contains("超过"), "{}", error.message);
        assert!(
            started.elapsed() < Duration::from_secs(1),
            "应当在超时点就返回，实际 {:?}",
            started.elapsed()
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// start 只等规则结果，不再自己解包。
    #[test]
    fn a_start_waits_for_rules_and_reports_a_clear_timeout() {
        let root = temp("rules-wait");
        let supervisor = Supervisor::new(root.clone());

        let error = supervisor
            .wait_for_rules(Duration::from_millis(150))
            .unwrap_err();
        assert!(
            error.message.contains("分流数据正在准备"),
            "{}",
            error.message
        );
        assert_eq!(error.code, protocol::ERR_TUN_START_FAILED);

        supervisor.record_rules(Ok(()), Duration::from_millis(1));
        assert!(supervisor.wait_for_rules(Duration::from_millis(10)).is_ok());
        let _ = std::fs::remove_dir_all(&root);
    }

    /// 等待规则时必须能被 stop 打断：否则它继续占着 start_lock，
    /// 用户重试只能排在后面再超时一次。
    #[test]
    fn a_stop_during_the_rules_wait_aborts_before_spawn() {
        let root = temp("rules-cancel");
        let supervisor = Supervisor::new(root.clone());
        supervisor.stop_requested.store(true, Ordering::SeqCst);

        let started = Instant::now();
        let error = supervisor
            .wait_for_rules(Duration::from_secs(15))
            .unwrap_err();
        assert!(error.message.contains("取消"), "{}", error.message);
        assert!(
            started.elapsed() < Duration::from_secs(1),
            "被取消时不该等满整个期限"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_rules_failure_is_surfaced_to_the_next_start() {
        let root = temp("rules-failed");
        let supervisor = Supervisor::new(root.clone());
        supervisor.record_rules(
            Err(ProtocolError::new(
                protocol::ERR_RULE_SET_MISSING,
                "规则归档哈希不符",
            )),
            Duration::from_millis(1),
        );

        let error = supervisor
            .wait_for_rules(Duration::from_millis(10))
            .unwrap_err();
        assert_eq!(error.code, protocol::ERR_RULE_SET_MISSING);
        assert!(error.message.contains("哈希不符"), "{}", error.message);
        let _ = std::fs::remove_dir_all(&root);
    }

    /// 等完子进程的 stop 只能清理自己那一代：新 start 的文件不能被它删掉。
    #[test]
    fn a_stale_stop_cannot_delete_the_next_starts_files() {
        let root = temp("generation");
        let supervisor = Supervisor::new(root.clone());
        std::fs::create_dir_all(supervisor.tun_dir()).unwrap();

        let stale = supervisor.generation.load(Ordering::SeqCst);
        std::fs::write(supervisor.config_path(), "{}").unwrap();
        std::fs::write(supervisor.pid_path(), "1\n").unwrap();

        // 新一次 start 已经把代号推进了。
        supervisor.generation.fetch_add(1, Ordering::SeqCst);
        supervisor.cleanup_files(stale);
        assert!(supervisor.config_path().exists(), "新 start 的配置不能被删");
        assert!(supervisor.pid_path().exists());

        // 同一代才清理。
        supervisor.cleanup_files(supervisor.generation.load(Ordering::SeqCst));
        assert!(!supervisor.config_path().exists());
        assert!(!supervisor.pid_path().exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    /// stop 不能等 start_lock：进行中的 start 可能还要几十秒。
    #[test]
    fn a_stop_does_not_wait_for_the_start_lock() {
        let root = temp("concurrent");
        let supervisor = Arc::new(Supervisor::new(root.clone()));
        let guard = supervisor.start_lock.lock().unwrap();

        let (tx, rx) = std::sync::mpsc::channel();
        let worker = {
            let supervisor = Arc::clone(&supervisor);
            std::thread::spawn(move || {
                supervisor.stop();
                let _ = tx.send(());
            })
        };

        assert!(
            rx.recv_timeout(Duration::from_secs(2)).is_ok(),
            "stop 被 start_lock 挡住了"
        );
        assert!(supervisor.stop_requested.load(Ordering::SeqCst));

        worker.join().unwrap();
        drop(guard);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_failing_command_is_reported_instead_of_swallowed() {
        assert!(run_command("/bin/echo", &["ok"]).is_ok());
        assert!(run_command("/bin/false", &[]).is_err());
        assert!(run_command("/nonexistent/binary", &[]).is_err());
    }

    #[test]
    fn user_logs_create_private_dirs_and_readable_files() {
        use std::os::unix::fs::MetadataExt;

        let home = temp("userlogs");
        let uid = unsafe { libc::getuid() };
        let gid = unsafe { libc::getgid() };
        let logs = UserLogs::open(&home, uid, gid).unwrap();
        logs.append_helper("hello");

        let dir = home.join(veyl_paths::DATA_DIR_NAME);
        assert_eq!(std::fs::metadata(&dir).unwrap().mode() & 0o777, 0o700);
        let helper_dir = dir.join("helper-logs");
        assert_eq!(
            std::fs::metadata(&helper_dir).unwrap().mode() & 0o777,
            0o755
        );
        let path = helper_dir.join("helper.log");
        let meta = std::fs::metadata(&path).unwrap();
        assert_eq!(meta.uid(), uid);
        assert_eq!(meta.mode() & 0o777, 0o644);
        assert!(std::fs::read_to_string(&path).unwrap().contains("hello"));
        assert_eq!(logs.sing_box_path, helper_dir.join("sing-box.log"));
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn user_logs_reject_a_symlinked_data_dir() {
        let home = temp("userlogs-symlink");
        let elsewhere = home.join("elsewhere");
        std::fs::create_dir_all(&elsewhere).unwrap();
        std::os::unix::fs::symlink(&elsewhere, home.join(veyl_paths::DATA_DIR_NAME)).unwrap();
        let uid = unsafe { libc::getuid() };
        let gid = unsafe { libc::getgid() };
        let error = UserLogs::open(&home, uid, gid).err().expect("应当拒绝");
        assert!(error.contains("失败"), "{error}");
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn user_logs_require_a_private_data_dir() {
        use std::os::unix::fs::PermissionsExt;

        let home = temp("userlogs-private");
        let dir = home.join(veyl_paths::DATA_DIR_NAME);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o755)).unwrap();
        let uid = unsafe { libc::getuid() };
        let gid = unsafe { libc::getgid() };
        let error = UserLogs::open(&home, uid, gid).err().expect("应当拒绝");
        assert!(error.contains("0700"), "{error}");
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn user_logs_reject_a_group_writable_log() {
        use std::os::unix::fs::PermissionsExt;

        let home = temp("userlogs-mode");
        let uid = unsafe { libc::getuid() };
        let gid = unsafe { libc::getgid() };
        let _ = UserLogs::open(&home, uid, gid).unwrap();
        let path = home
            .join(veyl_paths::DATA_DIR_NAME)
            .join("helper-logs")
            .join("helper.log");
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o666)).unwrap();
        let error = UserLogs::open(&home, uid, gid).err().expect("应当拒绝");
        assert!(error.contains("group/other"), "{error}");
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn restart_exits_with_tempfail_so_launchd_restarts() {
        // 0 是正常退出，KeepAlive 不会拉起；必须用非零。
        assert_eq!(RESTART_EXIT_CODE, 75);
    }

    #[test]
    fn idle_exit_needs_no_child_no_lease_and_no_request_in_flight() {
        let long_enough = IDLE_EXIT_AFTER + Duration::from_secs(1);
        assert!(should_exit_idle(false, 0, 0, long_enough));
        assert!(!should_exit_idle(true, 0, 0, long_enough), "子进程还在");
        assert!(!should_exit_idle(false, 1, 0, long_enough), "还有租约");
        assert!(!should_exit_idle(false, 0, 1, long_enough), "请求处理中");
        assert!(
            !should_exit_idle(false, 0, 0, Duration::from_secs(60)),
            "还没到 10 分钟"
        );
    }

    #[test]
    fn lease_loss_respects_generation_and_other_leases() {
        // 还有新租约：不动。
        assert_eq!(
            lease_loss_action(1, false, false),
            LeaseLossAction::Ignore
        );
        assert_eq!(
            lease_loss_action(1, true, false),
            LeaseLossAction::Ignore,
            "另一个实例还活着，不能动隧道"
        );
        // 租约断开后又有新 start（新实例接手）：不动它的隧道。
        assert_eq!(
            lease_loss_action(0, true, true),
            LeaseLossAction::Ignore
        );
        // 没有租约、没有新 start：停隧道再退出。
        assert_eq!(
            lease_loss_action(0, true, false),
            LeaseLossAction::StopAndExit
        );
        assert_eq!(
            lease_loss_action(0, false, false),
            LeaseLossAction::Exit
        );
    }

    #[test]
    fn three_starts_within_ten_minutes_trip_the_crash_guard() {
        let now = 1_000_000;
        assert!(!crash_loop_tripped(&[now - 30, now - 600], now));
        assert!(crash_loop_tripped(&[now - 600, now - 30, now], now));
        assert!(
            !crash_loop_tripped(&[now - 601, now - 30, now], now),
            "窗口外的启动不算"
        );
    }

    /// 升级重启、空闲退出这些正常生命周期不该累计成崩溃。
    #[test]
    fn clean_exits_do_not_accumulate_towards_the_crash_guard() {
        let root = temp("clean-exit");
        for _ in 0..5 {
            assert!(
                !crash_loop_tripped_now(&root),
                "干净退出后清掉记录，不该被判定为崩溃循环"
            );
            clear_start_record(&root);
        }
    }

    /// 保护自己决定的退出不能留下记录：每被拉起一次就续一次窗口的话，
    /// helper 会被永久锁死，再也起不来。
    #[test]
    fn a_tripped_guard_does_not_extend_its_own_window() {
        let root = temp("tripped");
        let path = root.join("helper-starts");
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs();
        std::fs::write(&path, format!("{}\n{}", now - 30, now - 10)).unwrap();

        assert!(crash_loop_tripped_now(&root));
        let text = std::fs::read_to_string(&path).unwrap();
        assert_eq!(
            text.lines().filter(|line| !line.is_empty()).count(),
            2,
            "保护自己这次退出不该写进窗口"
        );
    }
}
