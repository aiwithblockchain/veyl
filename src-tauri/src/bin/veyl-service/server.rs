//! 请求分发与 sing-box 生命周期。
//!
//! 服务端是唯一持有特权的部分：运行时由它 staging（只从 `Program Files` 复制）、
//! 配置由它落盘、子进程由它拉起与回收。请求里仍然没有路径——
//! 调用方只送配置文本，能不能执行、执行哪个文件由这里决定。
//!
//! 状态只放在内存里供 `status` 读（契约 §2.1：不哈希、不遍历、不扫进程），
//! 另外写一份 pid 记录供崩溃重启后**三重核对**孤儿（pid + 启动时间 + 镜像路径）。

use std::collections::HashMap;
use std::io::Read;
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStderr, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use super::protocol;
use super::win::ipc::{Request, Response};
use super::win::log::ServiceLog;
use super::win::{process, runtime};

/// sing-box 自己的日志。与 `service.log` 分开：它按连接打印，量级完全不同。
const SING_BOX_LOG_MAX_BYTES: u64 = 5 * 1024 * 1024;

/// 停子进程最多等这么久，超时就再来一次强制结束。
const STOP_TIMEOUT: Duration = Duration::from_secs(5);

struct Running {
    pid: u32,
    clash_addr: String,
    clash_secret: String,
    since: String,
}

struct LastError {
    code: String,
    message: String,
    at: String,
}

struct State {
    child: Option<Child>,
    running: Option<Running>,
    last_error: Option<LastError>,
}

pub struct Server {
    state: Mutex<State>,
    log: Arc<ServiceLog>,
    sing_box: Arc<SingBoxCapture>,
}

impl Server {
    pub fn new(log: Arc<ServiceLog>) -> Self {
        let sing_box = Arc::new(SingBoxCapture::new(
            super::win::logs_dir().join("sing-box.log"),
            Arc::clone(&log),
        ));
        Self {
            state: Mutex::new(State {
                child: None,
                running: None,
                last_error: None,
            }),
            log,
            sing_box,
        }
    }

    pub fn dispatch(&self, request: &Request) -> Response {
        match request {
            #[cfg(debug_assertions)]
            Request::Ping => Response::ok(json!({
                "pong": true,
                "protocol": super::win::ipc::PROTOCOL_VERSION,
                "service_pid": std::process::id(),
            })),
            Request::Status => self.snapshot(),
            Request::Stop => self.stop(),
            Request::Start { config } => self.start(config),
        }
    }

    /// 服务启动时调用一次：收掉上次崩溃留下的 sing-box，删掉含凭据的残留配置。
    pub fn sweep_stale(&self) {
        let record = record_path();
        match std::fs::read_to_string(&record) {
            Ok(text) => match process::parse_record(&text) {
                Some(stale) => {
                    // 三重核对：只按 pid 杀会在 pid 复用时误杀别人的进程。
                    // 核对与终止在同一个句柄上完成（见 `process::terminate_if_ours`）。
                    match process::terminate_if_ours(&stale, STOP_TIMEOUT) {
                        process::TerminateOutcome::Killed => {
                            self.log
                                .warn(format!("收掉上次遗留的 sing-box pid={}", stale.pid));
                        }
                        process::TerminateOutcome::Gone => self
                            .log
                            .info(format!("记录里的 sing-box pid={} 已经不在", stale.pid)),
                        process::TerminateOutcome::NotOurs => self.log.info(format!(
                            "记录里的 pid={} 已不是我们起的进程，跳过",
                            stale.pid
                        )),
                        process::TerminateOutcome::Failed(code) => self.log.error(format!(
                            "收掉遗留 sing-box pid={} 失败（Win32 {code}）",
                            stale.pid
                        )),
                    }
                }
                None => self.log.warn("pid 记录无法解析，跳过孤儿回收"),
            },
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => self.log.warn(format!("读取 pid 记录失败：{error}")),
        }
        remove_quietly(&self.log, &config_path());
        remove_quietly(&self.log, &record);
    }

    /// 服务停止时调用：先停子进程，再删残留。
    pub fn shutdown(&self) {
        self.stop_child();
    }

    /// `start` 的回复没能在契约期限内送达（或客户端已断开）时由管道层回调。
    /// 契约 §1.3：**不得**留下一个客户端不知道存在的 TUN。
    pub fn abort_started(&self, request: &Request) {
        if !matches!(request, Request::Start { .. }) {
            return;
        }
        self.log
            .error("start 回复未能在期限内送达，回滚已启动的运行时");
        self.stop_child();
        self.record_error("tun_start_failed", "启动回复未能送达客户端，已回滚");
    }

    fn start(&self, config: &str) -> Response {
        let data_root = super::win::program_data_dir();
        let install_root = super::win::install_dir();

        // 0. 数据目录的 ACL 每次 start 都重验：服务运行期间它可能被改过。
        //    staged 的 sing-box.exe 从这里执行，普通用户可写就是提权。
        if let Err(error) = super::win::acl::ensure_data_layout(&data_root) {
            return self.fail("tun_start_failed", format!("数据目录权限不合规：{error}"));
        }

        // 1. 运行时：只从安装目录复制，哈希对不上就失败关闭。
        let binary = match runtime::resolve(&install_root, &data_root) {
            Ok(binary) => binary,
            Err(error) => return self.fail(error.code, error.message),
        };

        // 2. 配置：与 macOS 同一份 allowlist；端口与 secret 由服务端决定。
        let port = match ephemeral_clash_port() {
            Ok(port) => port,
            Err(message) => return self.fail("internal", message),
        };
        let rules = rule_index();
        let secret = hex::encode(rand::random::<[u8; 24]>());
        let prepared = match protocol::prepare_config(config, &rules, port, &secret) {
            Ok(prepared) => prepared,
            Err(error) => return self.fail(error.code, error.message),
        };
        if let Some(message) = self_excluded(&prepared) {
            return self.fail(protocol::ERR_CONFIG_FORBIDDEN, message);
        }

        // 3. 替换语义：先停旧实例，再起新的（契约 §2）。
        self.stop_child();

        let config_file = config_path();
        if let Some(parent) = config_file.parent() {
            if let Err(error) = std::fs::create_dir_all(parent) {
                return self.fail("tun_start_failed", format!("创建数据目录失败：{error}"));
            }
        }
        if let Err(error) = std::fs::write(
            &config_file,
            serde_json::to_vec_pretty(&prepared).unwrap_or_default(),
        ) {
            return self.fail("tun_start_failed", format!("写入配置失败：{error}"));
        }

        // 4. 先跑 check，不过就不启动。
        if let Err(message) = sing_box_check(&binary, &config_file) {
            remove_quietly(&self.log, &config_file);
            return self.fail("tun_start_failed", message);
        }

        // 5. 临时端口在 pick 与真正 bind 之间可能被别的进程拿走：起进程前再确认一次。
        if !port_is_free(port) {
            remove_quietly(&self.log, &config_file);
            return self.fail(
                "tun_start_failed",
                format!("Clash API 端口 {port} 已被占用"),
            );
        }

        let mut child = match spawn_sing_box(&binary, &config_file, &self.log, &self.sing_box) {
            Ok(child) => child,
            Err(message) => {
                remove_quietly(&self.log, &config_file);
                return self.fail("tun_start_failed", message);
            }
        };

        let pid = child.id();
        let since = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
        // 没有创建时间就写不出一份能用于三重核对的记录——将来没人能安全地收掉它。
        // 与其留下一个永远无法回收的孤儿，不如现在就停掉。
        let Some(creation) = process::creation_time(pid) else {
            self.log.error(format!(
                "取不到 sing-box pid={pid} 的启动时间，无法保证孤儿可回收"
            ));
            let _ = child.kill();
            let _ = child.wait();
            remove_quietly(&self.log, &config_file);
            return self.fail(
                "tun_start_failed",
                "取不到运行时的启动时间，已停止刚启动的进程",
            );
        };
        let image =
            process::image_path(pid).unwrap_or_else(|| binary.to_string_lossy().to_string());
        let record = process::ProcessRecord {
            pid,
            creation,
            image,
        };
        if let Err(error) = std::fs::write(record_path(), process::format_record(&record)) {
            // 写不出记录 = 下次崩溃后没人认得出它。不能留下这种进程。
            self.log.error(format!("写 pid 记录失败：{error}"));
            let _ = child.kill();
            let _ = child.wait();
            remove_quietly(&self.log, &config_file);
            return self.fail("tun_start_failed", "写 pid 记录失败，已停止刚启动的运行时");
        }

        let clash_addr = format!("127.0.0.1:{port}");
        self.log
            .info(format!("sing-box 已启动 pid={pid} clash={clash_addr}"));
        // secret 不进日志（契约 §3.1）。
        let mut state = self.state.lock().unwrap();
        state.child = Some(child);
        state.running = Some(Running {
            pid,
            clash_addr: clash_addr.clone(),
            clash_secret: secret.clone(),
            since: since.clone(),
        });
        state.last_error = None;
        drop(state);
        // 回复形状见契约 §3.1。
        Response::ok(json!({
            "pid": pid,
            "clash_api": { "addr": clash_addr, "secret": secret },
            "since": since,
        }))
    }

    fn stop(&self) -> Response {
        self.stop_child();
        Response::ok(Value::Null)
    }

    fn snapshot(&self) -> Response {
        let mut state = self.state.lock().unwrap();

        // 子进程自己退出时，内存里的 running 必须跟着清掉。
        let exit = match state.child.as_mut() {
            Some(child) => match child.try_wait() {
                Ok(Some(status)) => Some(status.code().unwrap_or(-1)),
                // 查不到退出码不等于退出了：保留状态，下一次再查。
                Ok(None) | Err(_) => None,
            },
            None => None,
        };
        if let Some(code) = exit {
            state.child = None;
            state.running = None;
            self.log.warn(format!("sing-box 已退出，退出码 {code}"));
            remove_quietly(&self.log, &config_path());
            remove_quietly(&self.log, &record_path());
        }

        let last_error = state.last_error.as_ref().map(|error| {
            json!({
                "code": error.code,
                "message": error.message,
                "at": error.at,
            })
        });
        let snapshot = match &state.running {
            Some(running) => json!({
                "running": true,
                "pid": running.pid,
                "clash_api": {
                    "addr": running.clash_addr,
                    "secret": running.clash_secret,
                },
                "since": running.since,
                "last_error": last_error,
            }),
            None => json!({
                "running": false,
                "pid": Value::Null,
                "clash_api": Value::Null,
                "since": Value::Null,
                "last_error": last_error,
            }),
        };
        Response::ok(snapshot)
    }

    fn stop_child(&self) {
        let mut state = self.state.lock().unwrap();
        if let Some(mut child) = state.child.take() {
            let pid = child.id();
            let _ = child.kill();
            let deadline = Instant::now() + STOP_TIMEOUT;
            loop {
                match child.try_wait() {
                    Ok(Some(status)) => {
                        self.log.info(format!(
                            "sing-box pid={pid} 已停止（退出码 {}）",
                            status.code().unwrap_or(-1)
                        ));
                        break;
                    }
                    Ok(None) if Instant::now() < deadline => {
                        std::thread::sleep(Duration::from_millis(100));
                    }
                    _ => {
                        let _ = child.kill();
                        let _ = child.wait();
                        self.log
                            .warn(format!("sing-box pid={pid} 未在期限内退出，已强制结束"));
                        break;
                    }
                }
            }
        }
        state.running = None;
        drop(state);
        remove_quietly(&self.log, &config_path());
        remove_quietly(&self.log, &record_path());
    }

    fn fail(&self, code: &'static str, message: impl Into<String>) -> Response {
        let message = message.into();
        self.record_error(code, &message);
        Response::error(code, message)
    }

    fn record_error(&self, code: &str, message: &str) {
        let at = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
        if let Ok(mut state) = self.state.lock() {
            state.last_error = Some(LastError {
                code: code.to_string(),
                message: message.to_string(),
                at,
            });
        }
    }
}

/// 配置里的 `route_exclude_address` 覆盖了 TUN 自己的地址 → 拒绝。
///
/// 生成器已经在 Windows 上摘掉了 fakeip 段，但服务端不能只信调用方：
/// 这段配置由 LocalSystem 消费，覆盖 TUN 地址会让隧道入口被绕开。
///
/// `address` / `route_exclude_address` 都是 sing-box 的 Listable 字段，
/// **数组与单值字符串都合法**；只按数组解析会让
/// `"address": "198.18.0.1/15"` 这种写法绕过检查。
fn self_excluded(prepared: &Value) -> Option<String> {
    let inbounds = prepared.get("inbounds")?.as_array()?;
    for inbound in inbounds {
        let Some(inbound) = inbound.as_object() else {
            continue;
        };
        let addresses = inbound.get("address").map(listable).unwrap_or_default();
        let excludes = inbound
            .get("route_exclude_address")
            .map(listable)
            .unwrap_or_default();
        for address in addresses {
            if let Some(entry) = super::cidr::first_covering(excludes.iter().copied(), address) {
                return Some(format!(
                    "排除网段 {entry} 覆盖了 TUN 地址 {address}：TUN 自己的流量会绕开隧道"
                ));
            }
        }
    }
    None
}

/// sing-box 的 Listable：字符串按单元素处理，数组逐项取字符串。
fn listable(value: &Value) -> Vec<&str> {
    match value {
        Value::String(text) => vec![text.as_str()],
        Value::Array(items) => items.iter().filter_map(Value::as_str).collect(),
        _ => Vec::new(),
    }
}

fn sing_box_check(binary: &Path, config: &Path) -> Result<(), String> {
    let output = Command::new(binary)
        .arg("check")
        .arg("-c")
        .arg(config)
        // 与 spawn 用同一个工作目录：相对路径解析与 DLL 查找保持一致。
        .current_dir(binary.parent().unwrap_or(Path::new(".")))
        .stdin(Stdio::null())
        .output()
        .map_err(|error| format!("无法执行运行时：{error}"))?;
    if output.status.success() {
        return Ok(());
    }
    // stderr 里会出现配置路径；契约 §1.1 要求 message 不含路径。
    let detail = String::from_utf8_lossy(&output.stderr)
        .replace(&config.to_string_lossy().to_string(), "配置")
        .trim()
        .to_string();
    let detail = truncate(&detail, 400);
    Err(format!("配置校验没过：{detail}"))
}

fn truncate(value: &str, max: usize) -> String {
    if value.chars().count() <= max {
        return value.to_string();
    }
    value.chars().take(max).collect::<String>() + "…"
}

/// 一次连接的日志写入端。`session` 让上一轮读线程收尾迟到时被丢弃，
/// 不会把旧连接的尾巴写进新连接的文件。
struct SingBoxSink {
    file: std::fs::File,
    written: u64,
    session: u64,
}

/// sing-box 的 stdout/stderr 接管道，服务端自己按大小轮转。
///
/// 与 macOS 的 helper 同一套思路，但 Windows 上没有 SIGPIPE：读端消失后
/// 子进程只是拿到 ERROR_BROKEN_PIPE，可能继续以孤儿身份跑。真正的兜底仍是
/// 服务启动时的 `sweep_stale`（pid + 启动时间 + 镜像路径三重核对）。
struct SingBoxCapture {
    path: PathBuf,
    log: Arc<ServiceLog>,
    sink: Mutex<Option<SingBoxSink>>,
    /// 还在跑的读线程数。新一轮开始前最多等 500ms，避免轮转落在旧会话还在写的时候。
    readers: AtomicUsize,
    session: AtomicU64,
    write_failed: AtomicBool,
}

impl SingBoxCapture {
    fn new(path: PathBuf, log: Arc<ServiceLog>) -> Self {
        Self {
            path,
            log,
            sink: Mutex::new(None),
            readers: AtomicUsize::new(0),
            session: AtomicU64::new(0),
            write_failed: AtomicBool::new(false),
        }
    }

    /// 为新一次连接准备写入端：等上一轮读线程收尾、处理过大的旧文件、打开日志。
    fn begin(&self) -> Option<u64> {
        let deadline = Instant::now() + Duration::from_millis(500);
        while self.readers.load(Ordering::SeqCst) > 0 && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(10));
        }
        let session = self.session.fetch_add(1, Ordering::SeqCst) + 1;
        self.write_failed.store(false, Ordering::SeqCst);
        if let Some(parent) = self.path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        // 旧版本或异常中断可能留下远超上限的文件：整份留成备份等于没上限，直接丢掉。
        let existing = std::fs::metadata(&self.path)
            .map(|metadata| metadata.len())
            .unwrap_or(0);
        if existing > SING_BOX_LOG_MAX_BYTES {
            let _ = std::fs::remove_file(&self.path);
        } else {
            rotate_if_oversized(&self.path);
        }
        let file = match open_sing_box_log(&self.path) {
            Ok(file) => file,
            Err(error) => {
                self.log
                    .warn(format!("无法打开 sing-box 日志，输出丢弃：{error}"));
                return None;
            }
        };
        // 跨会话沿用未满的文件时，计数必须从实际大小起算。
        let written = file.metadata().map(|metadata| metadata.len()).unwrap_or(0);
        *self.sink.lock().unwrap() = Some(SingBoxSink {
            file,
            written,
            session,
        });
        Some(session)
    }

    /// 起两个常驻读线程（stdout/stderr 各一根管道），放在 spawn 之后立刻调用；
    /// 管道有 64 KB 缓冲，来不及读时子进程只会短暂阻塞。
    fn attach(
        self: &Arc<Self>,
        stdout: ChildStdout,
        stderr: ChildStderr,
        session: u64,
    ) -> Result<(), String> {
        self.spawn_reader(Box::new(stdout), session)?;
        self.spawn_reader(Box::new(stderr), session)
    }

    fn spawn_reader(
        self: &Arc<Self>,
        stream: Box<dyn Read + Send>,
        session: u64,
    ) -> Result<(), String> {
        self.readers.fetch_add(1, Ordering::SeqCst);
        let capture = Arc::clone(self);
        match std::thread::Builder::new()
            .name("veyl-singbox-log".into())
            .spawn(move || {
                capture.pump(stream, session);
                capture.readers.fetch_sub(1, Ordering::SeqCst);
            }) {
            Ok(_) => Ok(()),
            Err(error) => {
                self.readers.fetch_sub(1, Ordering::SeqCst);
                Err(format!("启动日志读线程失败：{error}"))
            }
        }
    }

    fn pump(&self, mut stream: Box<dyn Read + Send>, session: u64) {
        let mut buf = vec![0u8; 64 * 1024];
        loop {
            match stream.read(&mut buf) {
                Ok(0) => break,
                Ok(len) => self.apply(session, &buf[..len]),
                Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(_) => break,
            }
        }
    }

    fn apply(&self, session: u64, chunk: &[u8]) {
        use std::io::Write;
        let (failed, rotation) = {
            let mut slot = self.sink.lock().unwrap();
            let Some(sink) = slot.as_mut() else { return };
            if sink.session != session {
                return;
            }
            let rotation = if sink.written + chunk.len() as u64 > SING_BOX_LOG_MAX_BYTES {
                self.rotate(sink)
            } else {
                None
            };
            match sink.file.write_all(chunk) {
                Ok(()) => {
                    sink.written += chunk.len() as u64;
                    (false, rotation)
                }
                Err(_) => (true, rotation),
            }
        };
        // 轮转没成功时文件会继续增长：必须能从服务日志里看出来，不能吞掉。
        if let Some(problem) = rotation {
            self.log.warn(problem);
        }
        // 写不进去（磁盘满等）不能阻塞子进程：继续读并丢弃，只记一次。
        if failed && !self.write_failed.swap(true, Ordering::SeqCst) {
            self.log.warn("sing-box 日志写入失败，本次连接剩余输出丢弃");
        }
    }

    /// 轮转运行中的日志。写入端是 append-only 句柄，Windows 上不能直接
    /// `set_len`（见 `truncate_log`），所以 rename 或重开失败时用独立句柄
    /// 清空文件；清不掉就把原因带回调用方，不假装成功。
    ///
    /// 返回 `Some(原因)` 表示轮转没有完成、文件会继续增长。
    fn rotate(&self, sink: &mut SingBoxSink) -> Option<String> {
        let rotated = self.path.with_extension("log.1");
        let _ = std::fs::remove_file(&rotated);
        // 需要清空的是写入端此刻指向的那个文件：rename 成功但重开失败时是
        // `.1`，rename 失败时还是原文件。
        let left_open: Option<&Path> = if std::fs::rename(&self.path, &rotated).is_ok() {
            match open_sing_box_log(&self.path) {
                Ok(file) => {
                    sink.file = file;
                    None
                }
                Err(_) => Some(rotated.as_path()),
            }
        } else {
            Some(self.path.as_path())
        };
        sink.written = 0;
        let target = left_open?;
        match truncate_log(target) {
            Ok(()) => None,
            Err(error) => Some(format!(
                "sing-box 日志轮转失败，且无法清空 {}：{error}",
                target.display()
            )),
        }
    }
}

/// 用独立的一次性句柄把文件清零。
///
/// 日志写入端是 `.append(true)` 打开的，Windows 上只拿到 `FILE_APPEND_DATA`；
/// `FileEndOfFileInfo` 要求句柄带 `FILE_WRITE_DATA`，所以对写入端直接
/// `set_len` 必然 `ERROR_ACCESS_DENIED`。这里另开一个 `write(true)`
/// （即 `GENERIC_WRITE`）的句柄，截断后随语句结束关闭。
fn truncate_log(path: &Path) -> std::io::Result<()> {
    std::fs::OpenOptions::new()
        .write(true)
        .open(path)?
        .set_len(0)
}

fn open_sing_box_log(path: &Path) -> std::io::Result<std::fs::File> {
    std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
}

/// 子进程的 DLL 搜索从它自己的目录开始，`wintun.dll` 就在 `sing-box.exe` 旁边。
/// 不继承服务的 `SetDefaultDllDirectories`（那只作用于本进程）。
fn spawn_sing_box(
    binary: &Path,
    config: &Path,
    log: &ServiceLog,
    capture: &Arc<SingBoxCapture>,
) -> Result<Child, String> {
    let session = capture.begin();
    let mut command = Command::new(binary);
    command
        .arg("run")
        .arg("-c")
        .arg(config)
        .current_dir(binary.parent().unwrap_or(Path::new(".")))
        .stdin(Stdio::null())
        .creation_flags(super::win::CREATE_NO_WINDOW);
    if session.is_some() {
        command.stdout(Stdio::piped()).stderr(Stdio::piped());
    } else {
        command.stdout(Stdio::null()).stderr(Stdio::null());
    }
    let mut child = command.spawn().map_err(|error| {
        log.error(format!("启动运行时失败：{error}"));
        format!("启动运行时失败：{error}")
    })?;

    if let Some(session) = session {
        let attached = match (child.stdout.take(), child.stderr.take()) {
            (Some(stdout), Some(stderr)) => capture.attach(stdout, stderr, session),
            _ => Err("取不到子进程的日志管道".to_string()),
        };
        if let Err(error) = attached {
            // 绝不让子进程拿着没人读的管道：停掉它，改用丢弃输出的方式重起。
            log.warn(format!("日志管道不可用，输出丢弃：{error}"));
            let _ = child.kill();
            let _ = child.wait();
            return spawn_sing_box_without_log(binary, config, log);
        }
    }
    Ok(child)
}

fn spawn_sing_box_without_log(
    binary: &Path,
    config: &Path,
    log: &ServiceLog,
) -> Result<Child, String> {
    Command::new(binary)
        .arg("run")
        .arg("-c")
        .arg(config)
        .current_dir(binary.parent().unwrap_or(Path::new(".")))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(super::win::CREATE_NO_WINDOW)
        .spawn()
        .map_err(|error| {
            log.error(format!("启动运行时失败：{error}"));
            format!("启动运行时失败：{error}")
        })
}

fn rotate_if_oversized(path: &Path) {
    let too_big = std::fs::metadata(path)
        .map(|metadata| metadata.len() > SING_BOX_LOG_MAX_BYTES)
        .unwrap_or(false);
    if too_big {
        // Windows 的 rename 在目标已存在时失败，必须先删掉上一份。
        let rotated = path.with_extension("log.1");
        let _ = std::fs::remove_file(&rotated);
        let _ = std::fs::rename(path, &rotated);
    }
}

fn remove_quietly(log: &ServiceLog, path: &Path) {
    match std::fs::remove_file(path) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        // 配置里有节点凭据：删不掉必须留记录，不能静默。
        Err(error) => log.warn(format!("删除 {} 失败：{error}", path.display())),
    }
}

fn tun_dir() -> PathBuf {
    super::win::program_data_dir().join("tun")
}

fn config_path() -> PathBuf {
    tun_dir().join("active.json")
}

fn record_path() -> PathBuf {
    tun_dir().join("sing-box.pid")
}

/// 契约要求 Clash API 只绑回环、端口在 49152–65535。
fn ephemeral_clash_port() -> Result<u16, String> {
    let listener = std::net::TcpListener::bind(("127.0.0.1", 0))
        .map_err(|error| format!("分配回环端口失败：{error}"))?;
    let port = listener
        .local_addr()
        .map_err(|error| format!("读取回环端口失败：{error}"))?
        .port();
    drop(listener);
    if !(49152..=65535).contains(&port) {
        return Err(format!("系统分配的端口 {port} 不在契约范围 49152–65535"));
    }
    Ok(port)
}

fn port_is_free(port: u16) -> bool {
    std::net::TcpListener::bind(("127.0.0.1", port)).is_ok()
}

/// 规则集只认 tag，文件由服务自己从 `%ProgramData%\Veyl\rules\` 取。
fn rule_index() -> HashMap<String, PathBuf> {
    let directory = super::win::program_data_dir().join("rules");
    let mut rules = HashMap::new();
    let Ok(entries) = std::fs::read_dir(&directory) else {
        return rules;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|value| value.to_str()) != Some("srs") {
            continue;
        }
        if let Some(tag) = path.file_stem().and_then(|value| value.to_str()) {
            rules.insert(tag.to_string(), path);
        }
    }
    rules
}

// `CommandExt::creation_flags` 是 Windows 专属的。

#[cfg(test)]
mod tests {
    use super::*;

    /// 服务端也要拦：调用方送的配置覆盖了 TUN 地址就不能起。
    #[test]
    fn a_config_that_excludes_its_own_tun_address_is_refused() {
        let config = json!({
            "inbounds": [{
                "type": "tun",
                "address": ["198.18.0.1/15"],
                "route_exclude_address": ["10.0.0.0/8", "198.18.0.0/15"]
            }]
        });
        let message = self_excluded(&config).expect("必须拦住");
        assert!(message.contains("198.18.0.0/15"), "{message}");
    }

    #[test]
    fn a_heapier_exclusion_table_is_fine() {
        let config = json!({
            "inbounds": [{
                "type": "tun",
                "address": ["198.18.0.1/15"],
                "route_exclude_address": ["10.0.0.0/8", "224.0.0.0/4"]
            }]
        });
        assert_eq!(self_excluded(&config), None);
    }

    /// sing-box 的 Listable 接受单值字符串：只按数组解析就会漏判。
    #[test]
    fn a_string_listable_cannot_hide_an_overlap() {
        let config = json!({
            "inbounds": [{
                "type": "tun",
                "address": "198.18.0.1/15",
                "route_exclude_address": "198.18.0.0/15"
            }]
        });
        assert!(self_excluded(&config).is_some(), "字符串形态必须同样被拦住");
    }

    /// 裸 IP 按 /32 处理；去掉这个默认值，下面两条会变红。
    #[test]
    fn a_bare_address_or_exclusion_is_a_host_route() {
        let bare_address = json!({
            "inbounds": [{
                "type": "tun",
                "address": "198.18.0.1",
                "route_exclude_address": ["198.18.0.0/15"]
            }]
        });
        assert!(self_excluded(&bare_address).is_some());

        let bare_exclusion = json!({
            "inbounds": [{
                "type": "tun",
                "address": "198.18.0.1/15",
                "route_exclude_address": "198.18.0.1"
            }]
        });
        assert!(self_excluded(&bare_exclusion).is_some());

        // 裸 IP 不等于 TUN 地址时不能误判。
        let other = json!({
            "inbounds": [{
                "type": "tun",
                "address": "198.18.0.1",
                "route_exclude_address": ["198.18.0.2"]
            }]
        });
        assert_eq!(self_excluded(&other), None);
    }

    /// 数组里混着其它地址时，覆盖关系仍然要看得出来。
    #[test]
    fn a_mixed_address_list_is_checked_entry_by_entry() {
        let config = json!({
            "inbounds": [{
                "type": "tun",
                "address": ["10.0.0.1/32", "198.18.0.1/15"],
                "route_exclude_address": ["10.0.0.0/8", "198.18.0.0/15"]
            }]
        });
        assert!(self_excluded(&config).is_some());
    }

    #[test]
    fn a_config_without_excludes_or_addresses_is_not_this_checks_business() {
        assert_eq!(self_excluded(&json!({"inbounds": [{"type": "tun"}]})), None);
        assert_eq!(self_excluded(&json!({})), None);
    }

    #[test]
    fn long_check_output_is_truncated() {
        let text = "x".repeat(500);
        let cut = truncate(&text, 400);
        assert_eq!(cut.chars().count(), 401);
        assert!(cut.ends_with('…'));
    }

    fn temp_capture(tag: &str) -> (Arc<SingBoxCapture>, PathBuf) {
        let dir =
            std::env::temp_dir().join(format!("veyl-service-{tag}-{:016x}", rand::random::<u64>()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("sing-box.log");
        (
            Arc::new(SingBoxCapture::new(path, Arc::new(ServiceLog::disabled()))),
            dir,
        )
    }

    fn sing_box_size(path: &Path) -> u64 {
        std::fs::metadata(path)
            .map(|metadata| metadata.len())
            .unwrap_or(0)
    }

    /// 会话进行中写穿阈值也必须轮转：不能等下一次连接。
    #[test]
    fn an_oversized_sing_box_log_rotates_while_the_session_is_running() {
        let (capture, dir) = temp_capture("rotate");
        let path = dir.join("sing-box.log");
        let session = capture.begin().unwrap();

        let chunk = vec![b'x'; 64 * 1024];
        for _ in 0..(SING_BOX_LOG_MAX_BYTES / chunk.len() as u64 + 20) {
            capture.apply(session, &chunk);
        }

        assert!(dir.join("sing-box.log.1").exists(), "超限的日志要挪走");
        assert!(sing_box_size(&path) <= SING_BOX_LOG_MAX_BYTES);
        let backup = sing_box_size(&dir.join("sing-box.log.1"));
        assert!(backup <= SING_BOX_LOG_MAX_BYTES, "备份也不能超限：{backup}");
        assert!(
            std::fs::metadata(dir.join("sing-box.log.2")).is_err(),
            "只保留一份备份"
        );

        capture.apply(session, b"after-rotation\n");
        let current = std::fs::read_to_string(&path).unwrap();
        assert!(current.contains("after-rotation"), "{current}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// rename 被外部句柄挡住时（打印工具、杀软常见），退化路径必须真的把文件
    /// 压回上限内。写入端是 append-only 句柄，直接 `set_len` 在 Windows 上会
    /// 拿到 ERROR_ACCESS_DENIED，所以这里只能走独立句柄。
    #[test]
    fn a_blocked_rename_still_truncates_the_live_log() {
        use std::os::windows::fs::OpenOptionsExt;
        use windows_sys::Win32::Storage::FileSystem::{FILE_SHARE_READ, FILE_SHARE_WRITE};

        let (capture, dir) = temp_capture("blocked");
        let path = dir.join("sing-box.log");
        // 填到离上限 1 KiB：begin() 会把实际大小计入 written。
        std::fs::write(&path, vec![b'x'; SING_BOX_LOG_MAX_BYTES as usize - 1024]).unwrap();
        let session = capture.begin().unwrap();

        // 允许读写、拒绝 delete 共享：rename 必然失败，截断仍必须成功。
        let holder = std::fs::OpenOptions::new()
            .read(true)
            .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
            .open(&path)
            .unwrap();

        let chunk = vec![b'y'; 8 * 1024];
        capture.apply(session, &chunk);

        let length = sing_box_size(&path);
        assert!(
            length <= SING_BOX_LOG_MAX_BYTES,
            "rename 被挡住时也必须把文件清零：{length}"
        );
        assert!(
            std::fs::metadata(dir.join("sing-box.log.1")).is_err(),
            "rename 失败时不应留下备份"
        );

        drop(holder);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 上一轮读线程迟到的尾巴不能写进新一轮的文件。
    #[test]
    fn a_late_writer_from_the_previous_session_is_ignored() {
        let (capture, dir) = temp_capture("session");
        let path = dir.join("sing-box.log");

        let previous = capture.begin().unwrap();
        let current = capture.begin().unwrap();
        capture.apply(previous, b"stale\n");
        capture.apply(current, b"fresh\n");

        let text = std::fs::read_to_string(&path).unwrap();
        assert!(!text.contains("stale"), "旧会话的尾巴必须丢弃：{text}");
        assert!(text.contains("fresh"), "{text}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 旧版本留下的超大文件：不能整份留成备份，直接丢掉。
    #[test]
    fn a_log_left_oversized_is_discarded_on_begin() {
        let (capture, dir) = temp_capture("crash");
        let path = dir.join("sing-box.log");
        std::fs::write(&path, vec![b'x'; SING_BOX_LOG_MAX_BYTES as usize * 3]).unwrap();

        capture.begin().unwrap();

        assert_eq!(sing_box_size(&path), 0, "超大遗留文件必须清空");
        assert!(
            std::fs::metadata(dir.join("sing-box.log.1")).is_err(),
            "超大文件不能整份留成备份"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// stdout/stderr 两根管道都要读进同一个文件，写端关闭后读线程必须退出。
    #[test]
    fn a_childs_stdout_and_stderr_are_drained_into_the_log() {
        let (capture, dir) = temp_capture("pipe");
        let path = dir.join("sing-box.log");
        let session = capture.begin().unwrap();

        let mut child = Command::new("cmd")
            .args(["/C", "echo from-stdout & echo from-stderr 1>&2"])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .creation_flags(super::super::win::CREATE_NO_WINDOW)
            .spawn()
            .unwrap();
        capture
            .attach(
                child.stdout.take().unwrap(),
                child.stderr.take().unwrap(),
                session,
            )
            .unwrap();
        child.wait().unwrap();

        let deadline = Instant::now() + Duration::from_secs(2);
        while capture.readers.load(Ordering::SeqCst) > 0 && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(10));
        }
        assert_eq!(
            capture.readers.load(Ordering::SeqCst),
            0,
            "写端关闭后读线程必须退出"
        );

        let text = std::fs::read_to_string(&path).unwrap();
        assert!(text.contains("from-stdout"), "{text}");
        assert!(text.contains("from-stderr"), "{text}");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
