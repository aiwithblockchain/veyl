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

#[path = "../tun/protocol.rs"]
mod protocol;
#[path = "../tun/trust.rs"]
#[allow(dead_code)]
mod trust;
#[path = "../tun/xpc.rs"]
#[allow(dead_code)] // 与主程序共用同一份绑定，helper 只用服务端那几个
mod xpc;

use std::ffi::{c_char, c_void};
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use protocol::ProtocolError;
use xpc::xpc_object_t;

static SHUTDOWN: AtomicBool = AtomicBool::new(false);

extern "C" fn on_signal(_signal: libc::c_int) {
    SHUTDOWN.store(true, Ordering::SeqCst);
}

fn main() {
    if !is_root() {
        eprintln!("veyl-helper: 必须以 root 运行");
        std::process::exit(1);
    }

    let root = match prepare_trust_root() {
        Ok(root) => root,
        Err(error) => {
            // 不合规就退出，不降级、不「修好」——修好等于把别人建的东西合法化。
            eprintln!("veyl-helper: 信任根校验失败：{error}");
            std::process::exit(2);
        }
    };

    let supervisor = Arc::new(Supervisor::new(root));
    supervisor.sweep_stale();

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
        std::process::exit(0);
    });

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
    if let Err(error) = xpc::set_peer_code_signing_requirement(listener, &protocol::app_requirement())
    {
        eprintln!("veyl-helper: {error}");
        std::process::exit(4);
    }

    let listener_handler: RcBlock<dyn Fn(xpc_object_t)> = RcBlock::new(move |event: xpc_object_t| {
        if xpc::is_error(event) {
            eprintln!("veyl-helper: 监听器事件：{}", xpc::describe(event));
            return;
        }

        let connection = event;
        // 监听器已经过滤不满足 requirement 的消息；这里对连接本身再设一次，
        // 双向兜底（对每个连接只能设一次）。
        if let Err(error) =
            xpc::set_peer_code_signing_requirement(connection, &protocol::app_requirement())
        {
            eprintln!("veyl-helper: 拒绝连接：{error}");
            xpc::cancel(connection);
            return;
        }

        let per_connection = Arc::clone(&supervisor);
        let handler: RcBlock<dyn Fn(xpc_object_t)> =
            RcBlock::new(move |message: xpc_object_t| {
                if xpc::is_error(message) {
                    return;
                }
                handle_message(&per_connection, connection, message);
            });
        // block 必须活得和连接一样久；leak 是刻意的。
        let raw = RcBlock::as_ptr(&handler) as *mut c_void;
        std::mem::forget(handler);
        xpc::set_event_handler(connection, raw);
        xpc::resume(connection);
    });

    let raw = RcBlock::as_ptr(&listener_handler) as *mut c_void;
    std::mem::forget(listener_handler);
    xpc::set_event_handler(listener, raw);
    xpc::resume(listener);

    unsafe { dispatch_main() }
}

fn handle_message(
    supervisor: &Supervisor,
    connection: xpc::xpc_connection_t,
    message: xpc_object_t,
) {
    let method = xpc::dict_get_string(message, "method").unwrap_or_default();
    let reply = xpc::make_reply(message);

    let outcome: Result<(), ProtocolError> = match method.as_str() {
        "start" => {
            let raw = xpc::dict_get_data(message, "config").unwrap_or_default();
            let config = String::from_utf8_lossy(&raw).to_string();
            match supervisor.start(&config) {
                Ok(started) => {
                    xpc::dict_set_bool(reply, "ok", true);
                    xpc::dict_set_int64(reply, "pid", started.pid as i64);
                    xpc::dict_set_string(reply, "clash_addr", &started.clash_addr);
                    xpc::dict_set_string(reply, "clash_secret", &started.clash_secret);
                    Ok(())
                }
                Err(error) => Err(error),
            }
        }
        "stop" => {
            supervisor.stop();
            xpc::dict_set_bool(reply, "ok", true);
            Ok(())
        }
        "status" => {
            let status = supervisor.status();
            xpc::dict_set_bool(reply, "ok", true);
            xpc::dict_set_bool(reply, "running", status.is_some());
            xpc::dict_set_int64(reply, "pid", status.unwrap_or(0) as i64);
            Ok(())
        }
        other => Err(ProtocolError::new(
            protocol::ERR_BAD_REQUEST,
            format!("未知方法：{other}"),
        )),
    };

    if let Err(error) = outcome {
        xpc::dict_set_bool(reply, "ok", false);
        xpc::dict_set_string(reply, "code", error.code);
        xpc::dict_set_string(reply, "message", &error.message);
    }

    xpc::send_message(connection, reply);
    xpc::release(reply);
}

// ---------------------------------------------------------------------------
// Supervisor
// ---------------------------------------------------------------------------

struct Started {
    pid: u32,
    clash_addr: String,
    clash_secret: String,
}

struct Supervisor {
    root: PathBuf,
    child: Mutex<Option<Child>>,
}

impl Supervisor {
    fn new(root: PathBuf) -> Self {
        Self {
            root,
            child: Mutex::new(None),
        }
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

    fn log_path(&self) -> PathBuf {
        self.tun_dir().join("sing-box.log")
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
        if std::fs::read_to_string(current.join(".archive-sha256")).ok().as_deref()
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
        for path in [self.config_path(), self.pid_path()] {
            match std::fs::remove_file(&path) {
                Ok(()) => eprintln!("veyl-helper: 清理残留 {}", path.display()),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => eprintln!("veyl-helper: 清理 {} 失败：{error}", path.display()),
            }
        }
    }

    fn status(&self) -> Option<u32> {
        let mut guard = self.child.lock().unwrap();
        let child = guard.as_mut()?;
        match child.try_wait() {
            Ok(None) => Some(child.id()),
            _ => {
                *guard = None;
                None
            }
        }
    }

    fn start(&self, config: &str) -> Result<Started, ProtocolError> {
        // 每次 start 都重验整条链，而不是只在 helper 启动时验一次。
        // 理由不是当下的风险，是这条链以后会被改：哪天给 tun/ 加了子目录、
        // 或者权限被别的代码动了，这里不改也不会漏。
        self.verify_trust_chain()?;
        let binary = self.resolve_runtime()?;

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
            self.ensure_rules_staged()?;
        }

        self.stop();

        let clash_port = pick_loopback_port()?;
        let clash_secret = random_secret();
        let rules = self.rule_index();
        let prepared = protocol::prepare_config(config, &rules, clash_port, &clash_secret)?;

        write_private(
            &self.config_path(),
            &serde_json::to_vec_pretty(&prepared).unwrap(),
        )
        .map_err(|error| {
            ProtocolError::new(
                protocol::ERR_TUN_START_FAILED,
                format!("写入配置失败：{error}"),
            )
        })?;

        // 先跑 check，不过就不启动。
        let check = Command::new(&binary)
            .arg("check")
            .arg("-c")
            .arg(self.config_path())
            .output()
            .map_err(|error| {
                ProtocolError::new(
                    protocol::ERR_RUNTIME_MISSING,
                    format!("无法执行运行时：{error}"),
                )
            })?;
        if !check.status.success() {
            let _ = std::fs::remove_file(self.config_path());
            let detail = String::from_utf8_lossy(&check.stderr).trim().to_string();
            return Err(ProtocolError::new(
                protocol::ERR_TUN_START_FAILED,
                format!("配置校验没过：{detail}"),
            ));
        }

        let log = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW)
            .open(self.log_path())
            .map_err(|error| {
                ProtocolError::new(
                    protocol::ERR_TUN_START_FAILED,
                    format!("无法打开日志：{error}"),
                )
            })?;
        let log_err = log.try_clone().map_err(|error| {
            ProtocolError::new(protocol::ERR_TUN_START_FAILED, format!("{error}"))
        })?;

        let child = Command::new(&binary)
            .arg("run")
            .arg("-c")
            .arg(self.config_path())
            .stdin(Stdio::null())
            .stdout(Stdio::from(log))
            .stderr(Stdio::from(log_err))
            .spawn()
            .map_err(|error| {
                let _ = std::fs::remove_file(self.config_path());
                ProtocolError::new(
                    protocol::ERR_TUN_START_FAILED,
                    format!("启动运行时失败：{error}"),
                )
            })?;

        let pid = child.id();
        // 记下启动时间与可执行路径：下次崩溃重启时靠这三样认出「是我们起的那个」，
        // 只按 pid 杀会在 pid 复用时误杀别的进程。
        let record = format!(
            "{pid}\n{}\n{}\n",
            ps_start(pid).unwrap_or_default(),
            binary.display()
        );
        if let Err(error) = write_private(&self.pid_path(), record.as_bytes()) {
            eprintln!("veyl-helper: 写 pid 失败：{error}");
        }
        *self.child.lock().unwrap() = Some(child);

        Ok(Started {
            pid,
            clash_addr: format!("127.0.0.1:{clash_port}"),
            clash_secret,
        })
    }

    fn stop(&self) {
        let child = self.child.lock().unwrap().take();
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
        let _ = std::fs::remove_file(self.config_path());
        let _ = std::fs::remove_file(self.pid_path());
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
        let Some(pid) = lines.next().and_then(|value| value.trim().parse::<u32>().ok()) else {
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
    fn resolve_runtime(&self) -> Result<PathBuf, ProtocolError> {
        let digest = protocol::runtime_sha256().ok_or_else(|| {
            ProtocolError::new(
                protocol::ERR_RUNTIME_MISSING,
                "这份构建里没有随包运行时，TUN 无法启动",
            )
        })?;

        let dir = self.root.join("runtime").join(digest);
        let dest = dir.join("sing-box");
        if !dest.exists() {
            self.stage_runtime(digest, &dir, &dest)?;
        }

        trust::verify_file(&dest, 0, 0o755, Some(digest)).map_err(|error| {
            ProtocolError::new(
                protocol::ERR_RUNTIME_MISSING,
                format!("运行时校验未通过：{error}"),
            )
        })?;
        Ok(dest)
    }

    /// 从 bundle 复制一次。bundle 本身必须在用户不可写的位置，
    /// 否则「bundle 里的运行时」和用户目录里的运行时没有区别。
    fn stage_runtime(&self, digest: &str, dir: &Path, dest: &Path) -> Result<(), ProtocolError> {
        ensure_bundle_trusted()?;
        let bundled = bundled_runtime().ok_or_else(|| {
            ProtocolError::new(
                protocol::ERR_RUNTIME_MISSING,
                "安装包里没有运行时，TUN 无法启动",
            )
        })?;
        let bytes = std::fs::read(&bundled).map_err(|error| {
            ProtocolError::new(
                protocol::ERR_RUNTIME_MISSING,
                format!("读取安装包内的运行时失败：{error}"),
            )
        })?;
        if !trust::hash_matches(&bytes, digest) {
            return Err(ProtocolError::new(
                protocol::ERR_RUNTIME_MISSING,
                "安装包内的运行时与编译进 helper 的哈希不一致，拒绝执行",
            ));
        }

        std::fs::create_dir_all(dir).map_err(|error| {
            ProtocolError::new(protocol::ERR_RUNTIME_MISSING, format!("{error}"))
        })?;
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700));
        write_private(dest, &bytes).map_err(|error| {
            ProtocolError::new(protocol::ERR_RUNTIME_MISSING, format!("{error}"))
        })?;
        std::fs::set_permissions(dest, std::fs::Permissions::from_mode(0o755)).map_err(
            |error| ProtocolError::new(protocol::ERR_RUNTIME_MISSING, format!("{error}")),
        )?;
        Ok(())
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
}

#[link(name = "Security", kind = "framework")]
extern "C" {
    fn SecStaticCodeCreateWithPath(path: *const c_void, flags: u32, code: *mut *const c_void) -> i32;
    fn SecStaticCodeCheckValidity(code: *const c_void, flags: u32, requirement: *const c_void) -> i32;
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
    let path = bundle.to_string_lossy().to_string();
    // SAFETY: Create 出来的 CF 对象都在本函数内释放；requirement 字符串在调用后
    // 就可以释放（文档明确允许）。
    unsafe {
        let url = CFURLCreateFromFileSystemRepresentation(
            std::ptr::null(),
            path.as_ptr(),
            path.len() as isize,
            true,
        );
        if url.is_null() {
            return Err("无法构造 bundle 的 URL".into());
        }

        let mut code: *const c_void = std::ptr::null();
        let status = SecStaticCodeCreateWithPath(url, 0, &mut code);
        CFRelease(url);
        if status != 0 || code.is_null() {
            return Err(format!("读不到 App 的签名（OSStatus {status}）"));
        }

        let text = std::ffi::CString::new(protocol::app_requirement())
            .map_err(|_| "requirement 含空字节".to_string())?;
        let requirement_text =
            CFStringCreateWithCString(std::ptr::null(), text.as_ptr(), K_CF_STRING_ENCODING_UTF8);
        if requirement_text.is_null() {
            CFRelease(code);
            return Err("无法构造签名要求".into());
        }
        let mut requirement: *const c_void = std::ptr::null();
        let status = SecRequirementCreateWithString(requirement_text, 0, &mut requirement);
        CFRelease(requirement_text);
        if status != 0 || requirement.is_null() {
            CFRelease(code);
            return Err(format!("签名要求字符串无效（OSStatus {status}）"));
        }

        // kSecCSCheckAllArchitectures(1) | kSecCSCheckNestedCode(8) | kSecCSStrictValidate(16)
        //
        // 这是**纵深防御，不是补漏洞**：默认 flags 本来就会校验封存资源
        // （`kSecCSDefaultFlags` 的定义就是 "checks ... including resources"）。
        // 这三项补的是默认不查的部分——嵌套代码与非当前架构。
        // 而 helper 自己就是 App 里的嵌套代码，正好落在这个缺口上。
        const FLAGS: u32 = 1 | 8 | 16;
        let valid = SecStaticCodeCheckValidity(code, FLAGS, requirement);
        CFRelease(requirement);
        CFRelease(code);
        if valid == 0 {
            Ok(())
        } else {
            Err(format!("App 的签名不满足我们的要求（OSStatus {valid}）"))
        }
    }
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
            let name = path.file_name().and_then(|n| n.to_str()).unwrap_or_default();
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
    if path.components().any(|c| matches!(c, std::path::Component::ParentDir)) {
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
        let dir = std::env::temp_dir().join(format!("veyl-helper-{tag}-{:016x}", rand::random::<u64>()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
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
        tar.append_data(&mut header, "manifest.json", &body[..]).unwrap();
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
                    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or_default();
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
}
