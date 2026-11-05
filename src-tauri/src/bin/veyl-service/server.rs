//! 请求分发与 sing-box 生命周期。
//!
//! 服务端是唯一持有特权的部分：运行时由它 staging（只从 `Program Files` 复制）、
//! 配置由它落盘、子进程由它拉起与回收。请求里仍然没有路径——
//! 调用方只送配置文本，能不能执行、执行哪个文件由这里决定。
//!
//! 状态只放在内存里供 `status` 读（契约 §2.1：不哈希、不遍历、不扫进程），
//! 另外写一份 pid 记录供崩溃重启后**三重核对**孤儿（pid + 启动时间 + 镜像路径）。

use std::collections::HashMap;
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
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
}

impl Server {
    pub fn new(log: Arc<ServiceLog>) -> Self {
        Self {
            state: Mutex::new(State {
                child: None,
                running: None,
                last_error: None,
            }),
            log,
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

        let mut child = match spawn_sing_box(&binary, &config_file, &self.log) {
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

/// 子进程的 DLL 搜索从它自己的目录开始，`wintun.dll` 就在 `sing-box.exe` 旁边。
/// 不继承服务的 `SetDefaultDllDirectories`（那只作用于本进程）。
fn spawn_sing_box(binary: &Path, config: &Path, log: &ServiceLog) -> Result<Child, String> {
    let log_path = super::win::logs_dir().join("sing-box.log");
    if let Some(parent) = log_path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    rotate_if_oversized(&log_path);
    let file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .map_err(|error| format!("无法打开 sing-box 日志：{error}"))?;
    let stderr = file
        .try_clone()
        .map_err(|error| format!("无法复制日志句柄：{error}"))?;

    match Command::new(binary)
        .arg("run")
        .arg("-c")
        .arg(config)
        .current_dir(binary.parent().unwrap_or(Path::new(".")))
        .stdin(Stdio::null())
        .stdout(Stdio::from(file))
        .stderr(Stdio::from(stderr))
        .creation_flags(super::win::CREATE_NO_WINDOW)
        .spawn()
    {
        Ok(child) => Ok(child),
        Err(error) => {
            log.error(format!("启动运行时失败：{error}"));
            Err(format!("启动运行时失败：{error}"))
        }
    }
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
}
