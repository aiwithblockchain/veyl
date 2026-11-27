//! 连接状态机：装配 → 交给 helper → 等就绪 → 断开 / 切节点。
//!
//! 就绪判定按技术设计 §3.3：进程仍在 + Clash API `GET /version` 返回 200，
//! 15 秒内没起来就停掉隧道并判失败。设备是否 UP、路由是否接管只做诊断展示，
//! 不作为就绪门槛——它们比控制口慢，也更容易被系统策略影响。

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::Value;

use crate::assemble;
use crate::error::{AppError, AppResult};
use crate::models::Profile;
use veyl_tun::backend::TunErrorCode;
use veyl_tun::session::{TunLaunchMeta, TunSession, TunState};

const READY_TIMEOUT: Duration = Duration::from_secs(15);
const READY_INTERVAL: Duration = Duration::from_millis(300);
const VERSION_TIMEOUT: Duration = Duration::from_secs(1);
const STOP_DEADLINE: Duration = Duration::from_secs(10);

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum ConnectionState {
    Idle,
    Connecting { config_id: String },
    Connected {
        config_id: String,
        pid: u32,
        since: String,
        node: Option<String>,
    },
    Disconnecting,
    Failed {
        code: String,
        message: String,
        reason: String,
        hint: String,
    },
}

#[derive(Debug, Clone, Serialize)]
pub struct ConnectionSnapshot {
    #[serde(flatten)]
    pub state: ConnectionState,
    /// 已连接的秒数；未连接为 null。
    pub uptime_seconds: Option<u64>,
}

struct Inner {
    state: ConnectionState,
    /// 连接时用的 selector tag（`route.final` 指向的 selector）。
    selector: Option<String>,
    /// 用户选过的节点；未连接时只记在内存里（持久化留到下一轮）。
    selected_node: Option<String>,
}

type Observer = Arc<dyn Fn(&ConnectionSnapshot) + Send + Sync>;

pub struct ConnectionManager {
    session: Arc<TunSession>,
    http: reqwest::Client,
    /// 构建期注入的随包产物哈希；预检用。
    runtime_sha: String,
    rules_sha: String,
    ready_timeout: Duration,
    ready_interval: Duration,
    inner: Mutex<Inner>,
    /// 连接/断开/切节点串行化，避免两次点击交叉执行。
    op: tokio::sync::Mutex<()>,
    observer: Mutex<Option<Observer>>,
}

impl ConnectionManager {
    pub fn new(session: Arc<TunSession>, http: reqwest::Client) -> Self {
        let (runtime_sha, rules_sha) = veyl_tun::identity::try_identity()
            .map(|identity| {
                (
                    identity.runtime_sha256.to_string(),
                    identity.rules_archive_sha256.to_string(),
                )
            })
            .unwrap_or_default();
        Self {
            session,
            http,
            runtime_sha,
            rules_sha,
            ready_timeout: READY_TIMEOUT,
            ready_interval: READY_INTERVAL,
            inner: Mutex::new(Inner {
                state: ConnectionState::Idle,
                selector: None,
                selected_node: None,
            }),
            op: tokio::sync::Mutex::new(()),
            observer: Mutex::new(None),
        }
    }

    /// 测试用：跳过构建期哈希（本机构建可能没有随包产物）。
    #[cfg(test)]
    pub fn for_tests(session: Arc<TunSession>, http: reqwest::Client) -> Self {
        Self {
            session,
            http,
            runtime_sha: "a".repeat(64),
            rules_sha: "b".repeat(64),
            ready_timeout: Duration::from_millis(400),
            ready_interval: Duration::from_millis(20),
            inner: Mutex::new(Inner {
                state: ConnectionState::Idle,
                selector: None,
                selected_node: None,
            }),
            op: tokio::sync::Mutex::new(()),
            observer: Mutex::new(None),
        }
    }

    pub fn set_observer(&self, observer: Observer) {
        *self.observer.lock().unwrap() = Some(observer);
    }

    pub fn snapshot(&self) -> ConnectionSnapshot {
        let inner = self.inner.lock().unwrap();
        let uptime_seconds = match inner.state {
            ConnectionState::Connected { .. } => self.session.uptime_seconds(),
            _ => None,
        };
        ConnectionSnapshot {
            state: inner.state.clone(),
            uptime_seconds,
        }
    }

    fn set_state(&self, state: ConnectionState) {
        {
            let mut inner = self.inner.lock().unwrap();
            inner.state = state;
        }
        self.emit();
    }

    fn fail(&self, code: &str, message: impl Into<String>) -> AppError {
        self.fail_with(code, message, String::new(), String::new())
    }

    fn fail_with(
        &self,
        code: &str,
        message: impl Into<String>,
        reason: impl Into<String>,
        hint: impl Into<String>,
    ) -> AppError {
        let error = AppError::new(code_static(code), message)
            .with_reason(reason)
            .with_hint(hint);
        self.set_state(ConnectionState::Failed {
            code: error.code.to_string(),
            message: error.message.clone(),
            reason: error.reason.clone(),
            hint: error.hint.clone(),
        });
        error
    }

    fn emit(&self) {
        let snapshot = self.snapshot();
        let observer = self.observer.lock().unwrap().clone();
        if let Some(observer) = observer {
            observer(&snapshot);
        }
    }

    /// 记住用户选的节点（未连接时只改内存）。
    pub fn select_node(&self, tag: &str) {
        {
            let mut inner = self.inner.lock().unwrap();
            inner.selected_node = Some(tag.to_string());
        }
        self.emit();
    }

    pub fn selected_node(&self) -> Option<String> {
        self.inner.lock().unwrap().selected_node.clone()
    }

    // -----------------------------------------------------------------------
    // 连接
    // -----------------------------------------------------------------------

    pub async fn connect(&self, profile: &Profile, raw: &str) -> AppResult<ConnectionSnapshot> {
        let _guard = self.op.lock().await;

        match self.inner.lock().unwrap().state.clone() {
            ConnectionState::Connecting { .. } | ConnectionState::Disconnecting => {
                return Err(AppError::new("BUSY", "上一次连接还没结束")
                    .with_hint("等它完成，或者先断开。"));
            }
            ConnectionState::Connected { config_id, .. } if config_id == profile.id => {
                return Ok(self.snapshot());
            }
            ConnectionState::Connected { .. } => {
                self.disconnect_locked().await?;
            }
            _ => {}
        }

        // 装配 + 预检；任何一步失败都不去碰 helper。
        let prepared = (|| -> AppResult<(String, Option<String>)> {
            let config = assemble::parse(raw)?;
            let helper_config = assemble::for_helper(&config)?;
            self.preflight(&helper_config)?;
            let selector = selector_of(&config);
            let text = serde_json::to_string(&helper_config)
                .map_err(|error| AppError::internal(format!("序列化配置失败：{error}")))?;
            Ok((text, selector))
        })();

        let (config_json, selector) = match prepared {
            Ok(prepared) => prepared,
            Err(error) => {
                self.fail_with(
                    error.code,
                    error.message.clone(),
                    error.reason.clone(),
                    error.hint.clone(),
                );
                return Err(error);
            }
        };

        {
            let mut inner = self.inner.lock().unwrap();
            inner.selector = selector;
            inner.state = ConnectionState::Connecting {
                config_id: profile.id.clone(),
            };
        }
        self.emit();

        let meta = TunLaunchMeta {
            config_id: profile.id.clone(),
            config_name: Some(profile.name.clone()),
            node_id: None,
            node_name: self.selected_node(),
            applied_route_revision: None,
            route_region: None,
        };

        let session = self.session.clone();
        let config_for_start = config_json.clone();
        let id_for_start = profile.id.clone();
        let started = tauri::async_runtime::spawn_blocking(move || {
            let slot = session.begin_launch(&id_for_start);
            session.launch_registered(&slot, &config_for_start, &meta)
        })
        .await
        .map_err(|error| AppError::internal(format!("启动线程异常：{error}")))?;

        let reply = match started {
            Ok(reply) => reply,
            Err(error) => {
                return Err(self.fail_with(
                    tun_code(error.code),
                    error.message.clone(),
                    error
                        .detail
                        .as_ref()
                        .map(|detail| detail.to_string())
                        .unwrap_or_default(),
                    hint_for(error.code),
                ));
            }
        };

        if let Err(error) = self
            .wait_ready(&reply.clash_addr, &reply.clash_secret)
            .await
        {
            let session = self.session.clone();
            let _ = tauri::async_runtime::spawn_blocking(move || {
                let _ = session.stop_with_deadline(STOP_DEADLINE);
                let _ = session.restore_dns();
            })
            .await;
            return Err(self.fail_with(
                error.code,
                error.message.clone(),
                error.reason.clone(),
                error.hint.clone(),
            ));
        }

        // 连接成功后应用用户记住的节点；失败不阻断连接，用户可以再点一次。
        if let Some(node) = self.selected_node() {
            let _ = self
                .switch_live(&reply.clash_addr, &reply.clash_secret, &node)
                .await;
        }

        {
            let mut inner = self.inner.lock().unwrap();
            inner.state = ConnectionState::Connected {
                config_id: profile.id.clone(),
                pid: reply.pid,
                since: self.session.connected_since().unwrap_or_default(),
                node: inner.selected_node.clone(),
            };
        }
        self.emit();
        Ok(self.snapshot())
    }

    async fn wait_ready(&self, addr: &str, secret: &str) -> AppResult<()> {
        let deadline = Instant::now() + self.ready_timeout;
        loop {
            if !matches!(self.session.status(), TunState::Running { .. }) {
                return Err(AppError::new("TUN_EXITED", "隧道进程启动后又退出了")
                    .with_hint("重试连接；反复出现就查看 helper 日志。"));
            }
            if clash_version(&self.http, addr, secret).await {
                return Ok(());
            }
            if Instant::now() >= deadline {
                return Err(AppError::new(
                    "READY_TIMEOUT",
                    "隧道起来了，但控制口 15 秒内没有响应",
                )
                .with_hint("重试一次；仍然不行就换一个节点再试。"));
            }
            tokio::time::sleep(self.ready_interval).await;
        }
    }

    // -----------------------------------------------------------------------
    // 断开
    // -----------------------------------------------------------------------

    pub async fn disconnect(&self) -> AppResult<ConnectionSnapshot> {
        let _guard = self.op.lock().await;
        self.disconnect_locked().await?;
        Ok(self.snapshot())
    }

    async fn disconnect_locked(&self) -> AppResult<()> {
        {
            let mut inner = self.inner.lock().unwrap();
            if matches!(inner.state, ConnectionState::Idle) {
                return Ok(());
            }
            inner.state = ConnectionState::Disconnecting;
        }
        self.emit();

        let session = self.session.clone();
        let stopped =
            tauri::async_runtime::spawn_blocking(move || session.stop_with_deadline(STOP_DEADLINE))
                .await
                .map_err(|error| AppError::internal(format!("停止线程异常：{error}")))?;

        if let Err(error) = stopped {
            return Err(self.fail_with(
                tun_code(error.code),
                error.message,
                "",
                "先重试断开；仍然失败就用「重置网络」清掉残留。",
            ));
        }

        // DNS 还原与缓存刷新是幂等的；失败不改变「已断开」的结论。
        let session = self.session.clone();
        let _ = tauri::async_runtime::spawn_blocking(move || {
            let _ = session.restore_dns();
            let _ = session.flush_dns();
        })
        .await;

        self.set_state(ConnectionState::Idle);
        Ok(())
    }

    // -----------------------------------------------------------------------
    // 节点切换
    // -----------------------------------------------------------------------

    pub async fn switch_node(&self, tag: &str) -> AppResult<ConnectionSnapshot> {
        let _guard = self.op.lock().await;
        let connected = matches!(
            self.inner.lock().unwrap().state,
            ConnectionState::Connected { .. }
        );
        if !connected {
            self.select_node(tag);
            return Ok(self.snapshot());
        }

        let api = self
            .session
            .clash_api()
            .ok_or_else(|| AppError::new("NOT_RUNNING", "隧道没有在运行，无法切换节点"))?;
        self.switch_live(&api.addr, &api.secret, tag).await?;

        {
            let mut inner = self.inner.lock().unwrap();
            inner.selected_node = Some(tag.to_string());
            if let ConnectionState::Connected { node, .. } = &mut inner.state {
                *node = Some(tag.to_string());
            }
        }
        self.emit();
        Ok(self.snapshot())
    }

    async fn switch_live(&self, addr: &str, secret: &str, tag: &str) -> AppResult<()> {
        let selector = self
            .inner
            .lock()
            .unwrap()
            .selector
            .clone()
            .ok_or_else(|| AppError::new("NO_SELECTOR", "这套配置里没有可切换的节点组"))?;

        clash_put_selector(&self.http, addr, secret, &selector, tag)
        .await
        .map_err(|reason| {
            AppError::new("SWITCH_FAILED", format!("切换节点失败：{reason}"))
                .with_hint("重试一次；仍然不行就断开重连。")
        })?;

        // 读回校验：PUT 成功不等于真的生效。
        let current = clash_get_selector(&self.http, addr, secret, &selector)
        .await
        .map_err(|reason| AppError::new("SWITCH_FAILED", format!("切换后读不回来：{reason}")))?;
        if current.as_deref() != Some(tag) {
            return Err(AppError::new("SWITCH_FAILED", "切换没有生效")
                .with_hint("重试一次；仍然不行就断开重连。"));
        }
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// 预检与 Clash 调用
// ---------------------------------------------------------------------------

impl ConnectionManager {
fn preflight(&self, config: &Value) -> AppResult<()> {
    if !is_full_sha256(&self.runtime_sha) {
        return Err(AppError::new("RUNTIME_MISSING", "这次构建没有随包内核")
            .with_reason("安装包里缺少 sing-box 运行时")
            .with_hint("重新安装完整安装包。"));
    }

    let has_rule_sets = config
        .get("route")
        .and_then(|route| route.get("rule_set"))
        .and_then(Value::as_array)
        .map(|entries| !entries.is_empty())
        .unwrap_or(false);
    if has_rule_sets && !is_full_sha256(&self.rules_sha) {
        return Err(AppError::new("RULE_SET_MISSING", "这次构建没有随包规则数据")
            .with_reason("订阅里的分流规则需要本地规则归档")
            .with_hint("重新安装完整安装包。"));
    }
    Ok(())
}
}

fn is_full_sha256(value: &str) -> bool {
    value.len() == 64 && value.chars().all(|c| c.is_ascii_hexdigit())
}

/// selector 优先取 `route.final` 指向的那个；没有就用配置里第一个 selector。
pub fn selector_of(config: &Value) -> Option<String> {
    let outbounds = config.get("outbounds").and_then(Value::as_array)?;
    let is_selector = |tag: &str| {
        outbounds.iter().any(|outbound| {
            outbound.get("tag").and_then(Value::as_str) == Some(tag)
                && outbound.get("type").and_then(Value::as_str) == Some("selector")
        })
    };

    if let Some(final_tag) = config
        .get("route")
        .and_then(|route| route.get("final"))
        .and_then(Value::as_str)
    {
        if is_selector(final_tag) {
            return Some(final_tag.to_string());
        }
    }

    outbounds
        .iter()
        .find(|outbound| outbound.get("type").and_then(Value::as_str) == Some("selector"))
        .and_then(|outbound| outbound.get("tag").and_then(Value::as_str))
        .map(str::to_string)
}

async fn clash_version(http: &reqwest::Client, addr: &str, secret: &str) -> bool {
    let Ok(response) = http
        .get(format!("http://{addr}/version"))
        .bearer_auth(secret)
        .timeout(VERSION_TIMEOUT)
        .send()
        .await
    else {
        return false;
    };
    response.status().is_success()
}

async fn clash_put_selector(
    http: &reqwest::Client,
    addr: &str,
    secret: &str,
    selector: &str,
    name: &str,
) -> Result<(), String> {
    let response = http
        .put(format!("http://{addr}/proxies/{selector}"))
        .bearer_auth(secret)
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .body(serde_json::json!({ "name": name }).to_string())
        .timeout(Duration::from_secs(3))
        .send()
        .await
        .map_err(|error| format!("控制口不可达：{error}"))?;
    if response.status().is_success() {
        Ok(())
    } else {
        Err(format!("控制口返回 HTTP {}", response.status()))
    }
}

async fn clash_get_selector(
    http: &reqwest::Client,
    addr: &str,
    secret: &str,
    selector: &str,
) -> Result<Option<String>, String> {
    let response = http
        .get(format!("http://{addr}/proxies/{selector}"))
        .bearer_auth(secret)
        .timeout(Duration::from_secs(3))
        .send()
        .await
        .map_err(|error| format!("控制口不可达：{error}"))?;
    if !response.status().is_success() {
        return Err(format!("控制口返回 HTTP {}", response.status()));
    }
    let text = response
        .text()
        .await
        .map_err(|error| format!("控制口返回读不出来：{error}"))?;
    let body: Value = serde_json::from_str(&text)
        .map_err(|error| format!("控制口返回的不是 JSON：{error}"))?;
    Ok(body
        .get("now")
        .and_then(Value::as_str)
        .map(str::to_string))
}

fn tun_code(code: TunErrorCode) -> &'static str {
    match code {
        TunErrorCode::BadRequest => "BAD_REQUEST",
        TunErrorCode::ConfigTooLarge => "CONFIG_TOO_LARGE",
        TunErrorCode::ConfigInvalid => "CONFIG_INVALID",
        TunErrorCode::ConfigForbidden => "CONFIG_FORBIDDEN",
        TunErrorCode::RuleSetMissing => "RULE_SET_MISSING",
        TunErrorCode::RuntimeMissing => "RUNTIME_MISSING",
        TunErrorCode::TunStartFailed => "TUN_START_FAILED",
        TunErrorCode::TunDenied => "TUN_DENIED",
        TunErrorCode::HelperMissing => "HELPER_MISSING",
        _ => "TUN_ERROR",
    }
}

/// 错误码是 `&'static str`；这里把动态码映射回静态串。
fn code_static(code: &str) -> &'static str {
    match code {
        "BAD_REQUEST" => "BAD_REQUEST",
        "CONFIG_TOO_LARGE" => "CONFIG_TOO_LARGE",
        "CONFIG_INVALID" => "CONFIG_INVALID",
        "CONFIG_FORBIDDEN" => "CONFIG_FORBIDDEN",
        "RULE_SET_MISSING" => "RULE_SET_MISSING",
        "RUNTIME_MISSING" => "RUNTIME_MISSING",
        "TUN_START_FAILED" => "TUN_START_FAILED",
        "TUN_DENIED" => "TUN_DENIED",
        "HELPER_MISSING" => "HELPER_MISSING",
        "TUN_EXITED" => "TUN_EXITED",
        "READY_TIMEOUT" => "READY_TIMEOUT",
        "NOT_RUNNING" => "NOT_RUNNING",
        "NO_SELECTOR" => "NO_SELECTOR",
        "SWITCH_FAILED" => "SWITCH_FAILED",
        "BUSY" => "BUSY",
        _ => "TUN_ERROR",
    }
}

fn hint_for(code: TunErrorCode) -> &'static str {
    match code {
        TunErrorCode::TunDenied => "到「系统设置 → 通用 → 登录项」里允许本应用的后台项，然后再连一次。",
        TunErrorCode::HelperMissing => "重新安装应用；仍然不行就重启一次系统。",
        TunErrorCode::RuntimeMissing | TunErrorCode::RuleSetMissing => "重新安装完整安装包。",
        _ => "重试一次；反复出现就查看 helper 日志。",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::{SocketAddr, TcpListener, TcpStream};
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

    use veyl_tun::backend::{
        ClashApi, DnsHijack, StartReply, TunBackend, TunError, TunErrorCode, TunSnapshot,
    };
    use veyl_tun::privilege::HelperStatus;

    struct FakeBackend {
        reply: Mutex<Result<StartReply, TunError>>,
        stops: AtomicUsize,
        restores: AtomicUsize,
        running: AtomicBool,
    }

    impl FakeBackend {
        fn new(reply: Result<StartReply, TunError>) -> Arc<Self> {
            Arc::new(Self {
                reply: Mutex::new(reply),
                stops: AtomicUsize::new(0),
                restores: AtomicUsize::new(0),
                running: AtomicBool::new(false),
            })
        }
    }

    impl TunBackend for FakeBackend {
        fn availability(&self) -> Result<HelperStatus, TunError> {
            Ok(HelperStatus::Enabled)
        }

        fn ensure_available(&self) -> Result<HelperStatus, TunError> {
            Ok(HelperStatus::Enabled)
        }

        fn start(&self, _config: &str) -> Result<StartReply, TunError> {
            let reply = self.reply.lock().unwrap().clone();
            if reply.is_ok() {
                self.running.store(true, Ordering::SeqCst);
            }
            reply
        }

        fn stop(&self) -> Result<(), TunError> {
            self.stops.fetch_add(1, Ordering::SeqCst);
            self.running.store(false, Ordering::SeqCst);
            Ok(())
        }

        fn restore_dns(&self) -> Result<(), TunError> {
            self.restores.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }

        fn status(&self) -> Result<TunSnapshot, TunError> {
            Ok(TunSnapshot {
                running: self.running.load(Ordering::SeqCst),
                pid: None,
                clash_api: None,
                since: None,
                last_error: None,
                dns_hijack: DnsHijack::default(),
                helper_build: None,
                helper_version: None,
                helper_pid: None,
            })
        }

        fn restart(&self) -> Result<(), TunError> {
            Ok(())
        }
    }

    /// 进程内的假 Clash 控制口。
    struct FakeClash {
        addr: SocketAddr,
        healthy: Arc<AtomicBool>,
        now: Arc<std::sync::Mutex<String>>,
        puts: Arc<AtomicUsize>,
    }

    fn fake_clash(healthy: bool) -> FakeClash {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let healthy = Arc::new(AtomicBool::new(healthy));
        let now = Arc::new(std::sync::Mutex::new("悉尼".to_string()));
        let puts = Arc::new(AtomicUsize::new(0));
        let (h, n, p) = (healthy.clone(), now.clone(), puts.clone());
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { continue };
                let request = read_request(&mut stream);
                let first = request.lines().next().unwrap_or_default().to_string();
                let response = if first.starts_with("GET /version") {
                    if h.load(Ordering::SeqCst) {
                        http_response("200 OK", "{\"version\":\"1.14.4\"}")
                    } else {
                        http_response("500 Internal Server Error", "")
                    }
                } else if first.starts_with("GET /proxies/proxy") {
                    http_response("200 OK", &format!("{{\"now\":\"{}\"}}", n.lock().unwrap()))
                } else if first.starts_with("PUT /proxies/proxy") {
                    p.fetch_add(1, Ordering::SeqCst);
                    if let Some(body) = request.split("\r\n\r\n").nth(1) {
                        if let Ok(value) = serde_json::from_str::<Value>(body) {
                            if let Some(name) = value.get("name").and_then(Value::as_str) {
                                *n.lock().unwrap() = name.to_string();
                            }
                        }
                    }
                    http_response("204 No Content", "")
                } else {
                    http_response("404 Not Found", "")
                };
                let _ = stream.write_all(&response);
                let _ = stream.flush();
            }
        });
        FakeClash {
            addr,
            healthy,
            now,
            puts,
        }
    }

    fn read_request(stream: &mut TcpStream) -> String {
        let mut buffer = Vec::new();
        let mut byte = [0u8; 1];
        while stream.read(&mut byte).is_ok() && byte[0] != 0 {
            buffer.push(byte[0]);
            if buffer.ends_with(b"\r\n\r\n") {
                break;
            }
        }
        // PUT 带 body：按 Content-Length 读完。
        let head = String::from_utf8_lossy(&buffer).into_owned();
        let length = head
            .lines()
            .find_map(|line| {
                let lower = line.to_ascii_lowercase();
                lower
                    .strip_prefix("content-length:")
                    .and_then(|value| value.trim().parse::<usize>().ok())
            })
            .unwrap_or(0);
        let mut body = vec![0u8; length];
        if length > 0 {
            let _ = stream.read_exact(&mut body);
        }
        format!("{head}{}", String::from_utf8_lossy(&body))
    }

    fn http_response(status: &str, body: &str) -> Vec<u8> {
        format!(
            "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        )
        .into_bytes()
    }

    fn profile() -> Profile {
        Profile {
            id: "p1".into(),
            name: "测试配置".into(),
            source: crate::models::ProfileSource::Subscription {
                host: "vpn.example.com".into(),
            },
            node_count: 1,
            last_synced_at: None,
            sync_state: crate::models::SyncState::Ok,
            sync_error: None,
            created_at: 0,
            kernel_check: crate::models::KernelCheck::Unavailable,
        }
    }

    fn raw_config() -> String {
        serde_json::json!({
            "outbounds": [
                {"type": "selector", "tag": "proxy", "outbounds": ["node-a"], "default": "node-a"},
                {"type": "vless", "tag": "node-a", "server": "a.example.com", "server_port": 443},
                {"type": "direct", "tag": "direct"}
            ],
            "route": {"final": "proxy"}
        })
        .to_string()
    }

    fn start_reply(clash: &FakeClash) -> StartReply {
        StartReply {
            pid: 4242,
            clash_api: ClashApi {
                addr: clash.addr.to_string(),
                secret: "s".into(),
            },
            since: "2026-11-27T00:00:00Z".into(),
            dns_hijack: DnsHijack::default(),
        }
    }

    fn manager(backend: Arc<FakeBackend>, clash: &FakeClash) -> ConnectionManager {
        let session = Arc::new(TunSession::with_backend(backend, "fake"));
        let _ = clash;
        ConnectionManager::for_tests(session, reqwest::Client::new())
    }

    #[tokio::test]
    async fn connects_once_the_control_port_answers() {
        let clash = fake_clash(true);
        let backend = FakeBackend::new(Ok(start_reply(&clash)));
        let manager = manager(backend.clone(), &clash);

        let snapshot = manager.connect(&profile(), &raw_config()).await.unwrap();
        assert!(matches!(snapshot.state, ConnectionState::Connected { pid: 4242, .. }));
        assert!(snapshot.uptime_seconds.is_some());
        assert_eq!(backend.stops.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn a_silent_control_port_fails_and_stops_the_tunnel() {
        let clash = fake_clash(false);
        let backend = FakeBackend::new(Ok(start_reply(&clash)));
        let manager = manager(backend.clone(), &clash);

        let error = manager.connect(&profile(), &raw_config()).await.unwrap_err();
        assert_eq!(error.code, "READY_TIMEOUT");
        assert_eq!(backend.stops.load(Ordering::SeqCst), 1, "超时必须停掉隧道");
        assert_eq!(backend.restores.load(Ordering::SeqCst), 1, "超时必须还原 DNS");
        assert!(matches!(manager.snapshot().state, ConnectionState::Failed { .. }));
    }

    #[tokio::test]
    async fn a_start_failure_keeps_its_code_and_hint() {
        let clash = fake_clash(true);
        let backend = FakeBackend::new(Err(TunError::new(
            TunErrorCode::TunDenied,
            "用户还没批准后台项",
        )));
        let manager = manager(backend, &clash);

        let error = manager.connect(&profile(), &raw_config()).await.unwrap_err();
        assert_eq!(error.code, "TUN_DENIED");
        assert!(error.hint.contains("登录项"));
    }

    #[tokio::test]
    async fn disconnecting_restores_dns_and_is_idempotent() {
        let clash = fake_clash(true);
        let backend = FakeBackend::new(Ok(start_reply(&clash)));
        let manager = manager(backend.clone(), &clash);

        manager.connect(&profile(), &raw_config()).await.unwrap();
        manager.disconnect().await.unwrap();
        assert!(matches!(manager.snapshot().state, ConnectionState::Idle));
        assert_eq!(backend.restores.load(Ordering::SeqCst), 1);

        manager.disconnect().await.unwrap();
        assert_eq!(backend.stops.load(Ordering::SeqCst), 1, "重复断开不再调 stop");
    }

    #[tokio::test]
    async fn switching_a_node_puts_it_and_reads_it_back() {
        let clash = fake_clash(true);
        let backend = FakeBackend::new(Ok(start_reply(&clash)));
        let manager = manager(backend, &clash);
        manager.connect(&profile(), &raw_config()).await.unwrap();

        let snapshot = manager.switch_node("新加坡").await.unwrap();
        assert!(matches!(
            snapshot.state,
            ConnectionState::Connected { node: Some(ref tag), .. } if tag == "新加坡"
        ));
        assert_eq!(clash.puts.load(Ordering::SeqCst), 1);
        assert_eq!(clash.now.lock().unwrap().as_str(), "新加坡");
    }

    #[tokio::test]
    async fn choosing_a_node_while_idle_only_remembers_it() {
        let clash = fake_clash(true);
        let backend = FakeBackend::new(Ok(start_reply(&clash)));
        let manager = manager(backend, &clash);

        let snapshot = manager.switch_node("新加坡").await.unwrap();
        assert!(matches!(snapshot.state, ConnectionState::Idle));
        assert_eq!(manager.selected_node().as_deref(), Some("新加坡"));
        assert_eq!(clash.puts.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn the_selector_is_the_final_outbound_when_it_is_one() {
        let config: Value = serde_json::from_str(&raw_config()).unwrap();
        assert_eq!(selector_of(&config).as_deref(), Some("proxy"));
    }
}
