//! 后台助手（TUN helper）的构建检查与自助升级。
//!
//! 判定依据是 **cdhash**，不是版本号：同一份代码在 App 降级后依然相等，
//! 而重打包但版本号没变时也能被发现。旧 helper 是否支持 `restart` 只看它
//! 认不认识这个方法（`bad_request` = 旧版），不看它自报的构建号。
//!
//! 原则（PM 2026-11-05）：
//! - 磁盘文件验签不过 → 绝不重启、不执行，报 `file_invalid`；
//! - 运行中 helper 的 cdhash 用 pid 从系统取，不信它自己报的值；
//! - 不自动回滚特权二进制；失败就标记，本次不再重试。

use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;

use super::backend::{TunBackend, TunLease};

/// helper 可执行文件名（与 `Contents/MacOS/veyl-helper` 一致）。
pub const HELPER_BINARY_NAME: &str = "veyl-helper";

const POLL_TIMEOUT: Duration = Duration::from_secs(10);
const POLL_INTERVAL: Duration = Duration::from_secs(1);
/// TUN 断开后再等这么久才换 helper，避开连接刚结束的清理窗口。
const PENDING_AFTER_DISCONNECT: Duration = Duration::from_secs(5);
const PERIODIC_CHECK: Duration = Duration::from_secs(6 * 60 * 60);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum HelperState {
    Running,
    NotRunning,
    Stale,
    StartFailed,
    FileInvalid,
}

impl HelperState {
    pub fn as_str(self) -> &'static str {
        match self {
            HelperState::Running => "running",
            HelperState::NotRunning => "not_running",
            HelperState::Stale => "stale",
            HelperState::StartFailed => "start_failed",
            HelperState::FileInvalid => "file_invalid",
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct HelperInfo {
    pub running_build: Option<String>,
    pub expected_build: String,
    pub stale: bool,
    pub state: HelperState,
    pub needs_admin_restart: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct HelperRestartReport {
    pub ok: bool,
    pub restarted: bool,
    pub needs_admin_restart: bool,
    /// helper 正在执行 start，restart 被拒；稍后重试即可，不是故障。
    pub busy: bool,
}

#[derive(Default)]
struct PendingGate {
    /// TUN 已经断开的时刻；TUN 重新跑起来就清空。
    stopped_at: Option<Instant>,
}

impl PendingGate {
    /// TUN 在跑 → 不执行；断开后等满 5 秒才允许执行。
    fn ready(&mut self, tun_running: bool, now: Instant) -> bool {
        if tun_running {
            self.stopped_at = None;
            return false;
        }
        let stopped = *self.stopped_at.get_or_insert(now);
        now.saturating_duration_since(stopped) >= PENDING_AFTER_DISCONNECT
    }
}

#[derive(Default)]
struct Flags {
    /// 本次进程生命周期内已经失败过：不再自动重试。
    start_failed: bool,
    /// 管理员授权只尝试一次。
    #[cfg(target_os = "macos")]
    admin_attempted: bool,
    /// 静默路径发现旧 helper 不认识 `restart`：等用户真正请求 TUN 时再要授权。
    #[cfg(target_os = "macos")]
    admin_required: bool,
}

pub struct HelperUpdater {
    backend: Arc<dyn TunBackend>,
    flags: Mutex<Flags>,
    /// App 启动到退出的 presence 租约。进程结束时内核关闭连接，helper 据此
    /// 在 5 秒后停隧道并退出——崩溃/强杀也一样。
    presence: Mutex<Option<TunLease>>,
    /// 弹管理员授权对话框的唯一出口；测试里换成计数器。
    #[cfg(target_os = "macos")]
    admin_restart: Arc<dyn Fn() -> bool + Send + Sync>,
    #[cfg(test)]
    poll_timeout: Duration,
    #[cfg(test)]
    info_override: Mutex<Option<HelperInfo>>,
}

impl HelperUpdater {
    pub fn new(backend: Arc<dyn TunBackend>) -> Self {
        Self {
            backend,
            flags: Mutex::new(Flags::default()),
            presence: Mutex::new(None),
            #[cfg(target_os = "macos")]
            admin_restart: Arc::new(macos::run_admin_restart),
            #[cfg(test)]
            poll_timeout: POLL_TIMEOUT,
            #[cfg(test)]
            info_override: Mutex::new(None),
        }
    }

    #[cfg(all(test, target_os = "macos"))]
    fn for_test(
        backend: Arc<dyn TunBackend>,
        admin_restart: Arc<dyn Fn() -> bool + Send + Sync>,
    ) -> Self {
        Self {
            backend,
            flags: Mutex::new(Flags::default()),
            presence: Mutex::new(None),
            admin_restart,
            poll_timeout: Duration::ZERO,
            info_override: Mutex::new(None),
        }
    }

    /// 建立 presence 租约（幂等）。helper 未安装/未批准时只记 debug，不打扰用户。
    pub fn ensure_presence(&self) {
        if self.presence.lock().unwrap().is_some() {
            return;
        }
        match self.backend.acquire_lease() {
            Ok(Some(lease)) => {
                let mut slot = self.presence.lock().unwrap();
                if slot.is_none() {
                    *slot = Some(lease);
                    log::info!("presence 租约已建立");
                }
            }
            Ok(None) => {}
            Err(error) => log::debug!("presence 租约暂时不可用：{}", error.message),
        }
    }

    /// helper 换映像后旧连接已失效：换一条新的 presence 租约。
    /// 返回 `true` 表示当前确实持有租约。
    fn refresh_presence(&self) -> bool {
        self.presence.lock().unwrap().take();
        self.ensure_presence();
        self.presence.lock().unwrap().is_some()
    }

    /// 随包的 helper 路径：与主程序同目录。
    pub fn expected_helper_path() -> Option<PathBuf> {
        let exe = std::env::current_exe().ok()?;
        let path = exe.parent()?.join(HELPER_BINARY_NAME);
        path.is_file().then_some(path)
    }

    /// 当前状态。只读、不写盘；status 调用本身会让 launchd 按需拉起 helper。
    pub fn info(&self) -> HelperInfo {
        #[cfg(test)]
        if let Some(info) = self.info_override.lock().unwrap().clone() {
            return info;
        }

        #[cfg(not(target_os = "macos"))]
        {
            HelperInfo {
                running_build: None,
                expected_build: String::new(),
                stale: false,
                state: HelperState::NotRunning,
                needs_admin_restart: false,
            }
        }

        #[cfg(target_os = "macos")]
        {
            let Some(path) = Self::expected_helper_path() else {
                return file_invalid();
            };
            let expected = match macos::helper_file_build(&path) {
                Ok(build) => build,
                Err(detail) => {
                    log::warn!("helper 文件校验未通过（{}）：{detail}", path.display());
                    return file_invalid();
                }
            };

            match self.backend.status() {
                Ok(snapshot) => {
                    // 只信系统按 pid 取到的 cdhash。helper 自报的 helper_build
                    // 只能用于诊断——用被检查方的说法当证据等于不检查。
                    let running_build = snapshot
                        .helper_pid
                        .and_then(macos::running_helper_build);
                    let (stale, state) = match running_build.as_deref() {
                        Some(build) if !cdhash_eq(build, &expected) => {
                            (true, HelperState::Stale)
                        }
                        Some(_) => (false, HelperState::Running),
                        None => {
                            log::warn!(
                                "无法确认运行中 helper 的 cdhash（pid={:?}），按需要更新处理",
                                snapshot.helper_pid
                            );
                            (true, HelperState::Stale)
                        }
                    };
                    let needs_admin_restart = match state {
                        HelperState::Running => false,
                        // 静默换不动（旧 helper）或上次失败：界面要能提前说
                        // 「连接全部流量时会请求授权」，别等点了才弹。
                        _ => {
                            let flags = self.flags.lock().unwrap();
                            flags.admin_required || flags.start_failed
                        }
                    };
                    HelperInfo {
                        running_build,
                        expected_build: expected,
                        stale,
                        state,
                        needs_admin_restart,
                    }
                }
                Err(error) => {
                    let (start_failed, admin_required) = {
                        let flags = self.flags.lock().unwrap();
                        (flags.start_failed, flags.admin_required)
                    };
                    log::debug!("helper status 不可用：{error}");
                    HelperInfo {
                        running_build: None,
                        expected_build: expected,
                        stale: false,
                        state: if start_failed {
                            HelperState::StartFailed
                        } else {
                            HelperState::NotRunning
                        },
                        needs_admin_restart: start_failed || admin_required,
                    }
                }
            }
        }
    }

    /// 静默换新：启动检查与 6 小时轮询只走这条路。
    /// 旧 helper 不认识 `restart` 时**不弹管理员授权**，只记下待授权状态。
    pub fn restart_silent(&self) -> HelperRestartReport {
        let info = self.info();
        self.restart_with(info, false)
    }

    /// 用户主动请求 TUN、或显式点「重启」时才允许走这条路：旧 helper 会弹一次授权。
    pub fn restart_with_admin(&self) -> HelperRestartReport {
        let info = self.info();
        self.restart_with(info, true)
    }

    fn restart_with(&self, info: HelperInfo, allow_admin: bool) -> HelperRestartReport {
        if info.state == HelperState::FileInvalid {
            return HelperRestartReport {
                ok: false,
                restarted: false,
                needs_admin_restart: true,
                busy: false,
            };
        }
        let was_running = matches!(info.state, HelperState::Running | HelperState::Stale);

        match self.backend.restart() {
            Ok(()) => {}
            Err(error) if is_bad_request(&error) => {
                // 只有旧 helper 不认识 restart 才值得走管理员授权：
                // 服务没注册/未批准时 kickstart 必然失败，不能白弹一次密码框。
                log::warn!("旧 helper 不认识 restart：{}", error.message);
                if !allow_admin {
                    log::info!("后台组件待更新，需要管理员授权；等用户连接全部流量时再请求");
                    self.mark_admin_required();
                    return HelperRestartReport {
                        ok: false,
                        restarted: false,
                        needs_admin_restart: true,
                        busy: false,
                    };
                }
                #[cfg(target_os = "macos")]
                let granted = self.try_admin_restart();
                #[cfg(not(target_os = "macos"))]
                let granted = false;
                if !granted {
                    self.mark_admin_required();
                    self.flags.lock().unwrap().start_failed = true;
                    return HelperRestartReport {
                        ok: false,
                        restarted: false,
                        needs_admin_restart: true,
                        busy: false,
                    };
                }
            }
            Err(error) if is_precondition_failed(&error) => {
                // helper 正在执行 start：这是暂时的忙，不是故障。
                // 不置 start_failed、不置 needs_admin；下一次检查/用户重试即可。
                log::info!("restart 被正在进行的 start 拒绝，按 busy 处理，稍后重试");
                return HelperRestartReport {
                    ok: false,
                    restarted: false,
                    needs_admin_restart: false,
                    busy: true,
                };
            }
            Err(error) => {
                log::warn!(
                    "helper restart 失败（不走管理员授权）：{}",
                    error.message
                );
                self.flags.lock().unwrap().start_failed = true;
                return HelperRestartReport {
                    ok: false,
                    restarted: false,
                    needs_admin_restart: true,
                    busy: false,
                };
            }
        }

        let ok = self.poll_until_fresh();
        // 换映像后旧 presence 连接已断：立刻给新 helper 一条新租约。
        let _ = self.refresh_presence();
        {
            let mut flags = self.flags.lock().unwrap();
            if ok {
                flags.start_failed = false;
                #[cfg(target_os = "macos")]
                {
                    flags.admin_required = false;
                }
            } else {
                flags.start_failed = true;
            }
        }
        HelperRestartReport {
            ok,
            restarted: was_running,
            needs_admin_restart: !ok,
            busy: false,
        }
    }

    #[cfg(target_os = "macos")]
    fn mark_admin_required(&self) {
        self.flags.lock().unwrap().admin_required = true;
    }

    #[cfg(not(target_os = "macos"))]
    fn mark_admin_required(&self) {}

    /// 用户显式点「重试授权」时调用：允许再尝试一次管理员授权。
    pub fn restart_from_user(&self) -> HelperRestartReport {
        #[cfg(target_os = "macos")]
        {
            self.flags.lock().unwrap().admin_attempted = false;
        }
        self.restart_with_admin()
    }

    /// 连接 TUN 之前再比对一次：不一致就先升级；升级不成让本次连接失败。
    /// 返回 `(给用户看的中文, details.reason)`。
    pub fn ensure_current_for_connect(&self) -> Result<(), (String, &'static str)> {
        // 其它平台没有「包内 helper 映像」这回事，不参与这套检查。
        #[cfg(not(target_os = "macos"))]
        {
            return Ok(());
        }

        #[cfg(target_os = "macos")]
        {
            // 连接是用户主动行为：先确保注册/批准，再确认 helper 在跑。
            // 不先这一步的话，未注册时 status 失败会被误判成「需要管理员重启」。
            if let Err(error) = self.backend.ensure_available() {
                return Err((error.message, "helper_unavailable"));
            }
            // 强制换一条新租约，避免 helper 被外部重启后「有隧道、无租约」。
            let info = self.info();
            match info.state {
                HelperState::Running => {
                    if !self.refresh_presence() {
                        return Err((
                            "无法建立后台组件会话租约，暂时不能接管全部流量。代理模式与直连仍可用。"
                                .into(),
                            "helper_unavailable",
                        ));
                    }
                    Ok(())
                }
                HelperState::FileInvalid => Err((
                    "后台组件文件不可用（验签未通过），请重新安装 Veyl。代理模式与直连仍可用。"
                        .into(),
                    "helper_file_invalid",
                )),
                // 用户这次确实要用全部流量：允许在这里弹一次管理员授权。
                // 静默路径失败过（旧 helper）时，正是这一下把它换新。
                HelperState::StartFailed | HelperState::NotRunning | HelperState::Stale => {
                    let report = self.restart_with_admin();
                    if report.ok {
                        Ok(())
                    } else if report.busy {
                        Err((
                            "后台组件正在准备，请稍后再试。代理模式与直连仍可用。".into(),
                            "helper_busy",
                        ))
                    } else {
                        Err((
                            "后台组件未能换新，需要管理员重新授权。代理模式与直连仍可用。"
                                .into(),
                            "helper_needs_admin",
                        ))
                    }
                }
            }
        }
    }

    /// 后台检查：启动后一次 + 每 6 小时一次。TUN 在跑时等断开 5 秒再换。
    ///
    /// **只走静默路径**：用户可能根本不用全部流量，不能因为 helper 待更新就在
    /// 启动时弹 root 密码框。旧 helper 只记 `needs_admin_restart`，等用户请求
    /// TUN（或自己点「重启」）时再授权。
    pub fn check_and_upgrade(&self) {
        // 每轮都刷新 presence：helper 被外部重启/空闲退出过也能自动补上。
        let _ = self.refresh_presence();
        let info = self.info();
        if info.state != HelperState::Stale {
            return;
        }

        if self.tun_running() {
            log::info!("helper 需要升级，TUN 正在运行；等断开 5 秒后执行");
            let mut gate = PendingGate::default();
            loop {
                if gate.ready(self.tun_running(), Instant::now()) {
                    break;
                }
                std::thread::sleep(POLL_INTERVAL);
            }
            // 等待期间可能已经换过：再判一次，避免无谓重启。
            if self.info().state == HelperState::Running {
                return;
            }
        }

        let report = self.restart_silent();
        log::info!(
            "helper 自助升级 ok={} restarted={} needs_admin={} busy={}",
            report.ok,
            report.restarted,
            report.needs_admin_restart,
            report.busy
        );
    }

    /// 启动后台检查线程：先等 3 秒，之后每 6 小时一次。
    pub fn spawn_background(self: &Arc<Self>) {
        let updater = Arc::clone(self);
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_secs(3));
            updater.ensure_presence();
            loop {
                updater.check_and_upgrade();
                std::thread::sleep(PERIODIC_CHECK);
            }
        });
    }

    fn tun_running(&self) -> bool {
        self.backend
            .status()
            .map(|snapshot| snapshot.running)
            .unwrap_or(false)
    }

    fn poll_until_fresh(&self) -> bool {
        #[cfg(test)]
        let timeout = self.poll_timeout;
        #[cfg(not(test))]
        let timeout = POLL_TIMEOUT;
        let deadline = Instant::now() + timeout;
        while Instant::now() < deadline {
            std::thread::sleep(POLL_INTERVAL);
            if self.info().state == HelperState::Running {
                return true;
            }
        }
        false
    }

    /// 唯一一次管理员授权。密码由系统弹窗收集，不落盘、不进参数、不进日志。
    #[cfg(target_os = "macos")]
    fn try_admin_restart(&self) -> bool {
        {
            let mut flags = self.flags.lock().unwrap();
            if flags.admin_attempted {
                return false;
            }
            flags.admin_attempted = true;
        }
        (self.admin_restart)()
    }
}

#[cfg(target_os = "macos")]
fn file_invalid() -> HelperInfo {
    HelperInfo {
        running_build: None,
        expected_build: String::new(),
        stale: false,
        state: HelperState::FileInvalid,
        needs_admin_restart: true,
    }
}

/// cdhash 比较：只比内容，不用版本号；大小写归一。
pub fn cdhash_eq(left: &str, right: &str) -> bool {
    !left.is_empty()
        && !right.is_empty()
        && left.trim().eq_ignore_ascii_case(right.trim())
}

fn wire_code(error: &super::backend::TunError) -> Option<&str> {
    error
        .detail
        .as_ref()
        .and_then(|detail| detail.get("wire_code"))
        .and_then(|code| code.as_str())
}

fn is_bad_request(error: &super::backend::TunError) -> bool {
    wire_code(error) == Some("bad_request")
}

fn is_precondition_failed(error: &super::backend::TunError) -> bool {
    wire_code(error) == Some("precondition_failed")
}

#[cfg(target_os = "macos")]
mod macos {
    use std::ffi::{c_char, c_void, CString};
    use std::path::Path;

    /// 授权对话框正文，`docs/design/helper-update.md` §4.3.1 定稿。
    /// 标题从 Monterey 起固定是 "osascript"（经 osascript 调用的已知限制），
    /// 所以身份说明和「哪些功能不受影响」必须写在正文里。
    pub(super) const ADMIN_PROMPT: &str = "Veyl 更新后台组件，它负责让「全部流量」走 VPN。不是新权限，只用于这个功能，这次之后不再需要手动授权；代理模式不需要授权。";

    /// AppleScript 字符串字面量：`"` 与 `\` 必须转义；中文引号「」是普通字符。
    pub(super) fn applescript_quote(text: &str) -> String {
        let escaped = text.replace('\\', "\\\\").replace('"', "\\\"");
        format!("\"{escaped}\"")
    }

    /// 管理员重启：唯一会弹系统密码框的地方。
    ///
    /// 密码只进系统对话框；这里只根据退出码与「用户取消」标记记录，
    /// 绝不把 stderr 原文写进日志。
    pub(super) fn run_admin_restart() -> bool {
        let script = format!(
            "do shell script \"/bin/launchctl kickstart -k system/com.veyl.helper\" with prompt {} with administrator privileges",
            applescript_quote(ADMIN_PROMPT)
        );
        match std::process::Command::new("/usr/bin/osascript")
            .arg("-e")
            .arg(&script)
            .output()
        {
            Ok(output) => {
                let stderr = String::from_utf8_lossy(&output.stderr);
                let cancelled = stderr.contains("-128") || stderr.contains("User canceled");
                if cancelled {
                    log::info!("管理员授权被用户取消（-128），本次不自动重试；界面可重试授权");
                } else {
                    log::info!("管理员重启 helper 结束 exit={:?}", output.status.code());
                }
                output.status.success()
            }
            Err(error) => {
                log::warn!("调用 osascript 失败：{error}");
                false
            }
        }
    }

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
        fn CFStringGetLength(value: *const c_void) -> isize;
        fn CFStringGetMaximumSizeForEncoding(length: isize, encoding: u32) -> isize;
        fn CFStringGetCString(
            value: *const c_void,
            buffer: *mut c_char,
            buffer_size: isize,
            encoding: u32,
        ) -> bool;
        fn CFNumberCreate(
            allocator: *const c_void,
            number_type: i32,
            value: *const c_void,
        ) -> *const c_void;
        fn CFDictionaryCreate(
            allocator: *const c_void,
            keys: *const *const c_void,
            values: *const *const c_void,
            count: isize,
            key_callbacks: *const c_void,
            value_callbacks: *const c_void,
        ) -> *const c_void;
        fn CFDictionaryGetValue(dictionary: *const c_void, key: *const c_void) -> *const c_void;
        fn CFDataGetLength(data: *const c_void) -> isize;
        fn CFDataGetBytePtr(data: *const c_void) -> *const u8;
        fn CFRelease(value: *const c_void);
    }

    #[link(name = "Security", kind = "framework")]
    extern "C" {
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
        fn SecCodeCopyGuestWithAttributes(
            host: *const c_void,
            attributes: *const c_void,
            flags: u32,
            code: *mut *const c_void,
        ) -> i32;
        fn SecCodeCopySigningInformation(
            code: *const c_void,
            flags: u32,
            information: *mut *const c_void,
        ) -> i32;
        // Security 按 CFString 键查字典，依赖字典本身带键回调；传 null 回调的
        // 字典它查不到 pid，直接返回 errSecCSGuestInvalid(-67067)。
        static kCFTypeDictionaryKeyCallBacks: c_void;
        static kCFTypeDictionaryValueCallBacks: c_void;
    }

    const UTF8: u32 = 0x0800_0100;
    /// kSecCSSigningInformation
    const SIGNING_INFORMATION: u32 = 2;
    /// kCFNumberSInt32Type
    const SINT32: i32 = 3;

    fn cfstring(value: &str) -> *const c_void {
        let Ok(text) = CString::new(value) else {
            return std::ptr::null();
        };
        unsafe { CFStringCreateWithCString(std::ptr::null(), text.as_ptr(), UTF8) }
    }

    fn cfstring_value(value: *const c_void) -> Option<String> {
        if value.is_null() {
            return None;
        }
        unsafe {
            let length = CFStringGetLength(value);
            if length <= 0 {
                return None;
            }
            let size = CFStringGetMaximumSizeForEncoding(length, UTF8) + 1;
            let mut buffer = vec![0u8; size as usize];
            let ok = CFStringGetCString(value, buffer.as_mut_ptr() as *mut c_char, size, UTF8);
            if !ok {
                return None;
            }
            let end = buffer.iter().position(|byte| *byte == 0).unwrap_or(buffer.len());
            String::from_utf8(buffer[..end].to_vec()).ok()
        }
    }

    fn dict_string(dict: *const c_void, key: &str) -> Option<String> {
        if dict.is_null() {
            return None;
        }
        let key_ref = cfstring(key);
        if key_ref.is_null() {
            return None;
        }
        let value = unsafe { CFDictionaryGetValue(dict, key_ref) };
        let text = cfstring_value(value);
        unsafe { CFRelease(key_ref) };
        text
    }

    fn unique_hex(info: *const c_void) -> Option<String> {
        if info.is_null() {
            return None;
        }
        let key = cfstring("unique");
        if key.is_null() {
            return None;
        }
        let data = unsafe { CFDictionaryGetValue(info, key) };
        unsafe { CFRelease(key) };
        if data.is_null() {
            return None;
        }
        unsafe {
            let length = CFDataGetLength(data);
            if length <= 0 {
                return None;
            }
            let bytes = CFDataGetBytePtr(data);
            if bytes.is_null() {
                return None;
            }
            Some(
                (0..length as usize)
                    .map(|index| format!("{:02x}", *bytes.add(index)))
                    .collect(),
            )
        }
    }

    fn signing_info(code: *const c_void) -> Option<*const c_void> {
        let mut info: *const c_void = std::ptr::null();
        let status = unsafe { SecCodeCopySigningInformation(code, SIGNING_INFORMATION, &mut info) };
        (status == 0 && !info.is_null()).then_some(info)
    }

    fn helper_requirement() -> String {
        format!(
            "anchor apple generic and identifier \"{}\" and certificate leaf[subject.OU] = \"{}\"",
            super::HELPER_BINARY_NAME,
            crate::tun::protocol::TEAM_ID
        )
    }

    /// 磁盘文件：先验签（Team + identifier），再取 cdhash。
    pub(super) fn helper_file_build(path: &Path) -> Result<String, String> {
        use std::os::unix::fs::PermissionsExt;

        let metadata = std::fs::metadata(path).map_err(|error| format!("读不到文件：{error}"))?;
        if !metadata.is_file() {
            return Err("不是普通文件".into());
        }
        if metadata.permissions().mode() & 0o111 == 0 {
            return Err("没有可执行权限".into());
        }

        let text = path.to_string_lossy().to_string();
        // SAFETY: 所有 CF/Sec 对象都在本函数内释放。
        unsafe {
            let url = CFURLCreateFromFileSystemRepresentation(
                std::ptr::null(),
                text.as_ptr(),
                text.len() as isize,
                false,
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

            let requirement_text = cfstring(&helper_requirement());
            let mut requirement: *const c_void = std::ptr::null();
            let status = if requirement_text.is_null() {
                -1
            } else {
                SecRequirementCreateWithString(requirement_text, 0, &mut requirement)
            };
            if !requirement_text.is_null() {
                CFRelease(requirement_text);
            }
            if status != 0 || requirement.is_null() {
                CFRelease(code);
                return Err(format!("签名要求字符串无效（OSStatus {status}）"));
            }
            // kSecCSCheckAllArchitectures
            let valid = SecStaticCodeCheckValidity(code, 1, requirement);
            CFRelease(requirement);
            if valid != 0 {
                CFRelease(code);
                return Err(format!("签名不满足我们的要求（OSStatus {valid}）"));
            }

            let info = signing_info(code);
            let build = info.and_then(unique_hex);
            if let Some(info) = info {
                CFRelease(info);
            }
            CFRelease(code);
            build.ok_or_else(|| "取不到 cdhash".into())
        }
    }

    /// 运行中的 helper：按 pid 取 cdhash，并核对 identifier 与 Team。
    pub(super) fn running_helper_build(pid: u32) -> Option<String> {
        let pid_value = pid as i32;
        unsafe {
            let key = cfstring("pid");
            let value = CFNumberCreate(
                std::ptr::null(),
                SINT32,
                &pid_value as *const i32 as *const c_void,
            );
            if key.is_null() || value.is_null() {
                if !key.is_null() {
                    CFRelease(key);
                }
                if !value.is_null() {
                    CFRelease(value);
                }
                return None;
            }
            let keys = [key];
            let values = [value];
            // 必须用 CFType 回调。传 null 回调时字典没有键比较能力，Security 按
            // "pid" 查不到，直接返回 errSecCSGuestInvalid(-67067)——命令行探针对
            // 同一个 pid 用标准回调就能正常取到签名，是这段差异暴露了原因。
            // 回调会 retain，所以两个对象在调用后再释放是安全的。
            let attributes = CFDictionaryCreate(
                std::ptr::null(),
                keys.as_ptr(),
                values.as_ptr(),
                1,
                std::ptr::addr_of!(kCFTypeDictionaryKeyCallBacks),
                std::ptr::addr_of!(kCFTypeDictionaryValueCallBacks),
            );
            if attributes.is_null() {
                CFRelease(key);
                CFRelease(value);
                return None;
            }

            let mut code: *const c_void = std::ptr::null();
            let status =
                SecCodeCopyGuestWithAttributes(std::ptr::null(), attributes, 0, &mut code);
            CFRelease(attributes);
            CFRelease(value);
            CFRelease(key);
            if status != 0 || code.is_null() {
                // 这个调用失败会直接导致「判定为过期 → 重启 → 仍读不到 → 连接失败」，
                // 必须把 OSStatus 留下，否则只能看到「无法确认 cdhash」这一句。
                log::warn!(
                    "读取运行中 helper 的代码签名失败 pid={pid} status={status} null={}",
                    code.is_null()
                );
                return None;
            }

            let info = signing_info(code);
            let build = info.and_then(|info| {
                let identifier = dict_string(info, "identifier");
                let team = dict_string(info, "teamid");
                let matches = identifier.as_deref() == Some(super::HELPER_BINARY_NAME)
                    && team.as_deref() == Some(crate::tun::protocol::TEAM_ID);
                if matches {
                    unique_hex(info)
                } else {
                    log::warn!(
                        "运行中 helper 的签名对不上 identifier={identifier:?} team={team:?}"
                    );
                    None
                }
            });
            if let Some(info) = info {
                CFRelease(info);
            }
            CFRelease(code);
            build
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cdhash_comparison_ignores_case_but_not_content() {
        assert!(cdhash_eq("AABB", "aabb"));
        assert!(cdhash_eq(" aabb ", "aabb"));
        assert!(!cdhash_eq("aabb", "aacc"));
        assert!(!cdhash_eq("", ""));
        assert!(!cdhash_eq("aabb", ""));
    }

    /// 升级必须等 TUN 断开 5 秒，不能在连接期间换 helper。
    #[test]
    fn helper_upgrade_waits_for_disconnect_then_five_seconds() {
        let base = Instant::now();
        let mut gate = PendingGate::default();

        assert!(!gate.ready(true, base), "TUN 在跑时不能升级");
        assert!(!gate.ready(false, base), "刚断开，开始计时");
        assert!(
            !gate.ready(false, base + Duration::from_secs(4)),
            "不到 5 秒不执行"
        );
        assert!(
            gate.ready(false, base + PENDING_AFTER_DISCONNECT),
            "满 5 秒才执行"
        );

        // 又连上了：重新计时。
        assert!(!gate.ready(true, base + Duration::from_secs(6)));
        assert!(!gate.ready(false, base + Duration::from_secs(7)));
        assert!(!gate.ready(false, base + Duration::from_secs(11)));
        assert!(gate.ready(false, base + Duration::from_secs(12)));
    }

    /// 旧 helper 的 `bad_request` 必须被识别成版本协商，不是内部错误。
    #[test]
    fn a_bad_request_marks_an_old_helper() {
        let error = super::super::backend::TunError::new(
            super::super::backend::TunErrorCode::BadRequest,
            "未知方法 restart",
        )
        .with_detail(serde_json::json!({ "wire_code": "bad_request" }));
        assert!(is_bad_request(&error));

        let other = super::super::backend::TunError::new(
            super::super::backend::TunErrorCode::TunStartFailed,
            "启动失败",
        )
        .with_detail(serde_json::json!({ "wire_code": "tun_start_failed" }));
        assert!(!is_bad_request(&other));
    }

    /// helper 正在 start 时 restart 被拒：busy/可重试，绝不能当成需要管理员授权。
    #[test]
    fn precondition_failed_is_busy_not_an_admin_problem() {
        let error = super::super::backend::TunError::new(
            super::super::backend::TunErrorCode::TunStartFailed,
            "正在启动连接",
        )
        .with_detail(serde_json::json!({ "wire_code": "precondition_failed" }));

        assert!(is_precondition_failed(&error));
        assert!(!is_bad_request(&error), "不能被当成旧 helper");
    }

    /// 授权弹窗正文必须自带身份说明（标题固定是 osascript），且能安全嵌进 AppleScript。
    #[cfg(target_os = "macos")]
    #[test]
    fn the_admin_prompt_is_an_identity_statement() {
        let prompt = macos::ADMIN_PROMPT;
        assert!(prompt.contains("Veyl"));
        assert!(prompt.contains("后台组件"));
        assert!(
            prompt.contains("代理模式不需要授权"),
            "要明确说出不受影响的功能，用户才不会以为自己装了什么"
        );
        assert!(
            !prompt.contains('"') && !prompt.contains('\\'),
            "正文里的引号/反斜杠要转义，别直接拼进脚本"
        );
        assert_eq!(macos::applescript_quote(prompt), format!("\"{prompt}\""));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn applescript_strings_escape_quotes_and_backslashes() {
        assert_eq!(macos::applescript_quote(r#"a"b\c"#), r#""a\"b\\c""#);
    }

    /// 授权时机（PM 2026-11-06）：只用代理模式的用户，启动时不能被弹 root 密码。
    #[cfg(target_os = "macos")]
    mod admin_restart_tests {
        use super::super::*;
        use crate::tun::backend::{StartReply, TunError, TunErrorCode, TunSnapshot};
        use crate::tun::privilege::HelperStatus;
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::sync::Arc;

        #[derive(Clone, Copy, PartialEq, Eq)]
        enum RestartReply {
            /// 新 helper，认识 `restart`。
            Supported,
            /// 旧 helper，回 `bad_request`。
            OldHelper,
        }

        struct FakeBackend {
            reply: RestartReply,
        }

        impl TunBackend for FakeBackend {
            fn availability(&self) -> Result<HelperStatus, TunError> {
                Ok(HelperStatus::Enabled)
            }

            fn ensure_available(&self) -> Result<HelperStatus, TunError> {
                Ok(HelperStatus::Enabled)
            }

            fn start(&self, _config: &str) -> Result<StartReply, TunError> {
                unreachable!("测试不启动隧道")
            }

            fn stop(&self) -> Result<(), TunError> {
                Ok(())
            }

            fn status(&self) -> Result<TunSnapshot, TunError> {
                Ok(TunSnapshot {
                    running: false,
                    pid: None,
                    clash_api: None,
                    since: None,
                    last_error: None,
                    dns_hijack: Default::default(),
                    helper_build: None,
                    helper_version: None,
                    helper_pid: None,
                })
            }

            fn restart(&self) -> Result<(), TunError> {
                match self.reply {
                    RestartReply::Supported => Ok(()),
                    RestartReply::OldHelper => Err(TunError::new(
                        TunErrorCode::BadRequest,
                        "未知方法 restart",
                    )
                    .with_detail(serde_json::json!({ "wire_code": "bad_request" }))),
                }
            }
        }

        /// cdhash 不一致、且还不知道 helper 认不认识 `restart`。
        fn stale_info() -> HelperInfo {
            HelperInfo {
                running_build: Some("old".into()),
                expected_build: "new".into(),
                stale: true,
                state: HelperState::Stale,
                needs_admin_restart: false,
            }
        }

        /// 返回更新器与「管理员授权被调用次数」。授权一律模拟用户取消，
        /// 好验证「一次会话只弹一次」。
        fn updater(reply: RestartReply) -> (HelperUpdater, Arc<AtomicUsize>) {
            let calls = Arc::new(AtomicUsize::new(0));
            let counter = Arc::clone(&calls);
            let updater = HelperUpdater::for_test(
                Arc::new(FakeBackend { reply }),
                Arc::new(move || {
                    counter.fetch_add(1, Ordering::SeqCst);
                    false
                }),
            );
            *updater.info_override.lock().unwrap() = Some(stale_info());
            (updater, calls)
        }

        /// 启动时与 6 小时轮询：旧 helper 也绝不调用 osascript，只记待授权。
        #[test]
        fn background_checks_never_ask_for_admin_on_an_old_helper() {
            let (updater, calls) = updater(RestartReply::OldHelper);
            updater.check_and_upgrade();
            assert_eq!(calls.load(Ordering::SeqCst), 0, "启动检查不能弹密码框");
            assert!(
                updater.flags.lock().unwrap().admin_required,
                "静默换不动时要记下 needs_admin_restart，界面才能提前提示"
            );
        }

        /// 用户真正请求 TUN 时允许弹一次；用户取消后不再反复弹。
        #[test]
        fn connecting_all_traffic_asks_for_admin_exactly_once() {
            let (updater, calls) = updater(RestartReply::OldHelper);
            let first = updater.ensure_current_for_connect();
            assert_eq!(calls.load(Ordering::SeqCst), 1);
            assert!(first.is_err(), "授权被取消时本次连接要失败");

            let second = updater.ensure_current_for_connect();
            assert_eq!(calls.load(Ordering::SeqCst), 1, "同一次会话不再弹第二次");
            assert!(second.is_err());

            // 设置页显式点「重试授权」是用户主动行为，允许再弹一次。
            let _ = updater.restart_from_user();
            assert_eq!(calls.load(Ordering::SeqCst), 2);
        }

        /// helper 认识 `restart` 时，两条路径都不该弹授权。
        #[test]
        fn a_current_helper_never_asks_for_admin() {
            let (updater, calls) = updater(RestartReply::Supported);
            updater.check_and_upgrade();
            let _ = updater.ensure_current_for_connect();
            assert_eq!(calls.load(Ordering::SeqCst), 0);
        }
    }
}
