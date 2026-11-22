//! 控制面 HTTP 传输：带 Bearer 的请求、401 单次刷新重试、错误信封。
//!
//! 业务层（`servers` / `credentials`）只关心路径与 JSON，不重复处理令牌。

use std::time::{Duration, Instant};

use reqwest::Method;
use serde_json::Value;

use super::auth;
use super::error::{self, CpError};

const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_RESPONSE_BYTES: usize = 1024 * 1024;

/// 控制面 HTTP 客户端的唯一构造入口：代理只能由调用方显式传入。
///
/// 控制面自己（[`http_client`]）永远传 `None`：一律直连，不读系统代理
/// （macOS 网络设置 / Windows WinINET），也不读
/// `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY`：用户连着系统代理或 TUN 时，
/// 代理可能正好指向一个不可用的 VPN 节点，而「管理我自己的服务器」这件事
/// 本来就不该依赖 VPN 本身通畅。先 `no_proxy()` 再按参数追加，保证任何
/// 情况下都不会顺带捡起环境变量或系统代理。
///
/// **边界**：只有控制面直连。用户订阅导入、节点探测、运行时下载等仍然走
/// 用户当前网络策略（`public_http.rs` 等），不要复用这个 builder。
///
/// TUN 是网络层劫持，`no_proxy` 挡不住它：生成路由时另有一条控制通道直连规则
/// （`rules::plan` 的 `control_domains`，`docs/contracts/routing.md` §3.6）。
pub fn builder(proxy: Option<reqwest::Proxy>) -> reqwest::ClientBuilder {
    match proxy {
        None => reqwest::Client::builder().no_proxy(),
        Some(proxy) => reqwest::Client::builder().no_proxy().proxy(proxy),
    }
}

pub fn http_client(timeout: Duration) -> Result<reqwest::Client, CpError> {
    builder(None)
        .timeout(timeout)
        .build()
        .map_err(|error| CpError::internal(format!("创建控制面客户端失败：{error}")))
}

/// 日志里只保留 path：查询串可能带一次性参数，不能落盘。
pub(crate) fn log_path(path: &str) -> &str {
    path.split(['?', '#']).next().unwrap_or(path)
}

/// reqwest 错误的 source 链。**不含顶层 Display**：那一层会带完整 URL，
/// 违反「日志不记完整 URL」；内层连接错误本身不含 URL。
fn source_chain(error: &reqwest::Error) -> String {
    let mut parts = Vec::new();
    let mut current = std::error::Error::source(error);
    while let Some(inner) = current {
        parts.push(inner.to_string());
        current = inner.source();
    }
    let text = parts.join(" | ");
    if text.trim().is_empty() {
        "-".into()
    } else {
        text
    }
}

/// 传输错误分类：`dns` / `connect` / `timeout` / `tls`，其它归 `other`。
///
/// `is_connect()` 对 DNS 解析失败同样为真，所以先看 source 文本里的
/// dns / lookup 线索，再看 TLS，最后才落到 connect。这是判断
/// 「workers.dev 在当前网络不可达」还是「我们代码问题」的关键证据。
pub(crate) fn transport_kind(error: &reqwest::Error) -> &'static str {
    // 先看 source 文本：DNS 卡住直到整体超时时，`is_timeout()` 也为真，
    // 但那实际是 DNS 不可达，不能记成普通超时。
    let text = source_chain(error).to_ascii_lowercase();
    if text.contains("dns") || text.contains("lookup") || text.contains("resolve") {
        return "dns";
    }
    if text.contains("certificate")
        || text.contains("tls")
        || text.contains("ssl")
        || text.contains("handshake")
    {
        return "tls";
    }
    if error.is_timeout() {
        return "timeout";
    }
    if error.is_connect() {
        return "connect";
    }
    "other"
}

/// 控制面请求失败：只打一行 warn，成功不打。`reason` 是 `details.reason`，
/// 传输失败用 `network` / `timeout`，便于和 Worker 侧访问日志对上。
pub(crate) fn warn_failure(
    operation: &str,
    method: &str,
    path: &str,
    kind: &str,
    status: Option<u16>,
    retryable: bool,
    reason: &str,
    detail: &str,
) {
    let status = status
        .map(|value| value.to_string())
        .unwrap_or_else(|| "-".into());
    log::warn!(
        "控制面请求失败 op={operation} method={method} path={} kind={kind} status={status} reason={reason} retryable={retryable} detail={detail}",
        log_path(path)
    );
}

/// 传输层失败（DNS / 连接 / 超时 / TLS），detail 是 source 链。
pub(crate) fn warn_transport(operation: &str, method: &str, path: &str, error: &reqwest::Error) {
    warn_failure(
        operation,
        method,
        path,
        transport_kind(error),
        None,
        true,
        if error.is_timeout() { "timeout" } else { "network" },
        &source_chain(error),
    );
}

/// 传输层失败：**没拿到任何 HTTP 响应**，请求可能已经在服务端生效。
///
/// `details.transport = true` 让调用方（如销毁）区分「结果不确定」与
/// 「服务端明确回了错误」；结构化响应走的 `decode` 不带这个标记。
fn transport_error(error: reqwest::Error) -> CpError {
    let mut cp = CpError::network(error.is_timeout());
    if let Some(object) = cp.details.as_object_mut() {
        object.insert("transport".into(), Value::Bool(true));
    }
    cp
}

pub struct ControlPlane {
    base_url: String,
    http: reqwest::Client,
}

impl ControlPlane {
    pub fn new() -> Result<Self, CpError> {
        let http = http_client(REQUEST_TIMEOUT)?;
        Ok(Self {
            base_url: crate::control_plane::env::current().base_url,
            http,
        })
    }

    pub async fn request(
        &self,
        method: Method,
        path: &str,
        body: Option<&Value>,
        idempotency_key: Option<&str>,
    ) -> Result<Value, CpError> {
        self.request_with_timeout(method, path, body, idempotency_key, None)
            .await
    }

    /// 同 `request`，但只给**这一次**请求换超时（`None` = 用客户端的全局超时）。
    pub async fn request_with_timeout(
        &self,
        method: Method,
        path: &str,
        body: Option<&Value>,
        idempotency_key: Option<&str>,
        timeout: Option<Duration>,
    ) -> Result<Value, CpError> {
        let method_label = method.as_str().to_string();
        log::debug!("控制面请求开始 method={method_label} path={}", log_path(path));
        let token = auth::ensure_access(&self.base_url, &self.http, None).await?;
        let (status, text) = self
            .send(method.clone(), path, body, idempotency_key, Some(token.as_str()), timeout)
            .await?;
        if status != 401 {
            return decode_logged(&method_label, path, status, &text);
        }

        // access 过期：刷新（或重新注册）后只重试一次。幂等键原样复用。
        log::debug!(
            "控制面请求收到 401，刷新令牌后重试一次 method={method_label} path={}",
            log_path(path)
        );
        let refreshed = auth::ensure_access(&self.base_url, &self.http, Some(&token)).await?;
        let (status, text) = self
            .send(method, path, body, idempotency_key, Some(refreshed.as_str()), timeout)
            .await?;
        decode_logged(&method_label, path, status, &text)
    }

    pub async fn get(&self, path: &str) -> Result<Value, CpError> {
        self.request(Method::GET, path, None, None).await
    }

    /// 公开读取：不带令牌，也不触发设备注册。
    ///
    /// 问题墙的读取对所有用户开放（`design/issue-report-api.md` §2.2）。用
    /// `get` 会先 `ensure_access`，未登录用户会被注册成匿名设备——读一条公开
    /// 帖子不该产生这个副作用。
    pub async fn get_public(&self, path: &str) -> Result<Value, CpError> {
        log::debug!("控制面公开请求 method=GET path={}", log_path(path));
        let (status, text) = self
            .send(Method::GET, path, None, None, None, None)
            .await?;
        decode_logged("GET", path, status, &text)
    }

    pub async fn post(
        &self,
        path: &str,
        body: Option<&Value>,
        idempotency_key: Option<&str>,
    ) -> Result<Value, CpError> {
        self.request(Method::POST, path, body, idempotency_key).await
    }

    /// 只给这一个 POST 换超时：销毁要同步等 `deleteDroplet`，10 秒不够。
    pub async fn post_with_timeout(
        &self,
        path: &str,
        body: Option<&Value>,
        idempotency_key: Option<&str>,
        timeout: Duration,
    ) -> Result<Value, CpError> {
        self.request_with_timeout(Method::POST, path, body, idempotency_key, Some(timeout))
            .await
    }

    pub async fn patch(&self, path: &str, body: Option<&Value>) -> Result<Value, CpError> {
        self.request(Method::PATCH, path, body, None).await
    }

    async fn send(
        &self,
        method: Method,
        path: &str,
        body: Option<&Value>,
        idempotency_key: Option<&str>,
        token: Option<&str>,
        timeout: Option<Duration>,
    ) -> Result<(u16, String), CpError> {
        let url = format!("{}{}", self.base_url.trim_end_matches('/'), path);
        let method_label = method.as_str().to_string();
        let started = Instant::now();
        let mut request = self.http.request(method, url);
        if let Some(token) = token {
            request = request.bearer_auth(token);
        }
        request = request.header(reqwest::header::ACCEPT, "application/json");
        if let Some(timeout) = timeout {
            request = request.timeout(timeout);
        }
        if let Some(key) = idempotency_key {
            request = request.header("Idempotency-Key", key);
        }
        if let Some(body) = body {
            request = request.json(body);
        }

        let response = request
            .send()
            .await
            .map_err(|error| {
                warn_transport("api", &method_label, path, &error);
                transport_error(error)
            })?;
        if let Some(length) = response.content_length() {
            if length as usize > MAX_RESPONSE_BYTES {
                return Err(CpError::invalid_response("控制面响应过大"));
            }
        }
        let status = response.status().as_u16();
        log::debug!(
            "控制面响应 method={method_label} path={} status={status} elapsed_ms={}",
            log_path(path),
            started.elapsed().as_millis()
        );
        let bytes = response
            .bytes()
            .await
            .map_err(|error| transport_error(error))?;
        if bytes.len() > MAX_RESPONSE_BYTES {
            return Err(CpError::invalid_response("控制面响应过大"));
        }
        let text = String::from_utf8(bytes.to_vec())
            .map_err(|_| CpError::invalid_response("控制面响应不是 UTF-8"))?;
        Ok((status, text))
    }
}

fn decode(status: u16, text: &str) -> Result<Value, CpError> {
    if !(200..=299).contains(&status) {
        return Err(error::from_response(status, text));
    }
    if text.trim().is_empty() {
        return Ok(Value::Null);
    }
    serde_json::from_str(text)
        .map_err(|_| CpError::invalid_response("控制面响应格式不正确"))
}

/// `decode` 的日志版：非 2xx 记 `kind=status`，2xx 但响应体不合法记
/// `kind=invalid_response`。成功不产生日志。
fn decode_logged(method: &str, path: &str, status: u16, text: &str) -> Result<Value, CpError> {
    match decode(status, text) {
        Ok(value) => Ok(value),
        Err(error) => {
            let kind = if (200..=299).contains(&status) {
                "invalid_response"
            } else {
                "status"
            };
            warn_failure(
                "api",
                method,
                path,
                kind,
                Some(status),
                error.retryable,
                error.reason().unwrap_or("-"),
                "-",
            );
            Err(error)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_204_is_an_empty_success() {
        // `my_server_destroy` 的 HTTP 响应是 204；命令层把它映射成
        // `state: "destroying"` 的 MyServer，前端不用特判空响应。
        assert_eq!(decode(204, "").unwrap(), Value::Null);
        assert_eq!(decode(204, "  ").unwrap(), Value::Null);
        assert!(decode(500, "").is_err());
    }

    #[test]
    fn log_paths_drop_query_and_fragment() {
        assert_eq!(log_path("/v1/servers?token=secret"), "/v1/servers");
        assert_eq!(log_path("/v1/servers#frag"), "/v1/servers");
        assert_eq!(log_path("/v1/servers"), "/v1/servers");
    }

    /// 只在测试期间运行的本地 HTTP 桩：读到请求头结束再回响应。
    struct Stub {
        hits: std::sync::Arc<std::sync::atomic::AtomicUsize>,
        stop: std::sync::Arc<std::sync::atomic::AtomicBool>,
        handle: Option<std::thread::JoinHandle<()>>,
        /// 桩线程已经进到 accept 循环后才发这一条：父进程用它代替「睡一会儿应该好了」。
        ready: std::sync::mpsc::Receiver<()>,
        addr: std::net::SocketAddr,
    }

    impl Stub {
        fn spawn(body: &'static [u8]) -> Self {
            use std::io::{Read, Write};
            use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
            use std::sync::Arc;

            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            let addr = listener.local_addr().unwrap();
            listener.set_nonblocking(true).unwrap();
            let hits = Arc::new(AtomicUsize::new(0));
            let stop = Arc::new(AtomicBool::new(false));
            let (ready_tx, ready) = std::sync::mpsc::channel();
            let hits_thread = Arc::clone(&hits);
            let stop_thread = Arc::clone(&stop);
            let handle = std::thread::spawn(move || {
                // 明确的就绪信号：就绪之前父进程不往下走，不赌调度。
                let _ = ready_tx.send(());
                while !stop_thread.load(Ordering::SeqCst) {
                    match listener.accept() {
                        Ok((mut stream, _)) => {
                            // macOS/BSD 上 accept() 出来的 socket **继承**监听套接字的
                            // O_NONBLOCK：不显式改回阻塞，read 会在客户端还没发出请求时
                            // 立刻 WouldBlock，桩连收 8 次错误就把连接关掉——客户端看到
                            // 的是 `hyper IncompleteMessage`（偶发、极快）。
                            let _ = stream.set_nonblocking(false);
                            hits_thread.fetch_add(1, Ordering::SeqCst);
                            let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
                            let mut buffer = Vec::new();
                            let mut chunk = [0u8; 1024];
                            let mut complete = false;
                            let mut saw_bytes = false;
                            // 结束原因只为诊断记录：下次失败时能一眼区分
                            // 「对端关了」「读错误」「30 秒没读全」。
                            let mut end = "deadline";
                            // 整机高负载时对端进程可能被冻结几秒，超时后继续等而不是
                            // 提前关连接；提前回响应/关闭会让 hyper 报
                            // `UnexpectedMessage` / `IncompleteMessage`。
                            let deadline = std::time::Instant::now() + Duration::from_secs(30);
                            let mut errors = 0u32;
                            while std::time::Instant::now() < deadline {
                                match stream.read(&mut chunk) {
                                    Ok(0) => {
                                        end = "eof";
                                        break;
                                    }
                                    Ok(n) => {
                                        saw_bytes = true;
                                        buffer.extend_from_slice(&chunk[..n]);
                                        if buffer.windows(4).any(|w| w == b"\r\n\r\n") {
                                            complete = true;
                                            end = "complete";
                                            break;
                                        }
                                    }
                                    Err(_) => {
                                        errors += 1;
                                        end = "read_error";
                                        // 连接被重置时 read 会立刻连续报错，别拿它空转到 30 秒预算。
                                        if errors >= 8 {
                                            break;
                                        }
                                        continue;
                                    }
                                }
                            }
                            if complete {
                                match stream.write_all(body) {
                                    Ok(()) => match stream.flush() {
                                        Ok(()) => {
                                            // 显式半关：让内核在 close 前把响应按序发完
                                            // （响应带 `Connection: close`）。
                                            let _ = stream
                                                .shutdown(std::net::Shutdown::Write);
                                        }
                                        Err(error) => {
                                            eprintln!("本地 HTTP 桩：flush 响应失败：{error}");
                                        }
                                    },
                                    Err(error) => {
                                        eprintln!(
                                            "本地 HTTP 桩：写响应失败（请求已读 {} 字节）：{error}",
                                            buffer.len()
                                        );
                                    }
                                }
                            } else if saw_bytes {
                                // 请求没读全也必须回一个明确响应：静默关连接会被
                                // hyper 记成 `IncompleteMessage`，把「桩没读到请求」
                                // 伪装成「客户端连接出错」——这条用例被误导了一整天
                                // 就是这个原因。
                                let _ = stream.write_all(
                                    b"HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                                );
                                let _ = stream.flush();
                                eprintln!(
                                    "本地 HTTP 桩：请求未读全 end={end} errors={errors} bytes={}",
                                    buffer.len()
                                );
                            }
                            // 一个字节都没读到的是空闲探测连接：静默关掉。
                        }
                        Err(ref error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                            std::thread::sleep(Duration::from_millis(5));
                        }
                        Err(_) => std::thread::sleep(Duration::from_millis(10)),
                    }
                }
            });
            Self {
                hits,
                stop,
                handle: Some(handle),
                ready,
                addr,
            }
        }

        /// 等桩线程真的进到 accept 循环。父进程不靠固定时间猜「应该起来了」。
        fn wait_ready(&self) {
            self.ready.recv().expect("本地 HTTP 桩没有报就绪就退出了");
        }

        fn hits(&self) -> usize {
            self.hits.load(std::sync::atomic::Ordering::SeqCst)
        }
    }

    impl Drop for Stub {
        fn drop(&mut self) {
            self.stop.store(true, std::sync::atomic::Ordering::SeqCst);
            // 线程每轮最多睡 10ms，join 不会卡住。
            if let Some(handle) = self.handle.take() {
                let _ = handle.join();
            }
        }
    }

    /// 会回 502 的假代理与回 200 的目标站。
    const POISON: &[u8] =
        b"HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
    const TARGET: &[u8] = b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}";


    fn runtime() -> tokio::runtime::Runtime {
        // 独占运行时：不与别的测试共用全局运行时，免得连接被别处的收尾取消。
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
    }

    /// 代理是构造参数，不是环境变量：显式传 `Some(proxy)` 的客户端会走代理，
    /// 控制面自己的 `http_client` 不传，直连目标。
    ///
    /// 这里不碰进程环境变量——`set_var` 与其它测试的 `getenv` 并发是未定义
    /// 行为，`ENV_LOCK` 也挡不住不上锁的读者。环境变量那一层见下一个测试。
    #[test]
    fn the_control_plane_client_never_uses_a_proxy() {
        let poison = Stub::spawn(POISON);
        let target = Stub::spawn(TARGET);
        poison.wait_ready();
        target.wait_ready();
        let runtime = runtime();

        // 注入代理：请求确实落到代理上，证明这条注入路径真的生效，
        // 也证明「打没打到代理」这件事本身测得出来。
        let proxied = builder(Some(
            reqwest::Proxy::all(format!("http://{}", poison.addr)).unwrap(),
        ))
        // 本机桩 + 整机高负载：和另外两处一样给 10 秒，避免进程被冻结时误判。
        .timeout(Duration::from_secs(10))
        .build()
        .unwrap();
        let response = runtime
            .block_on(async {
                proxied
                    .get(format!("http://{}/v1/health", target.addr))
                    .send()
                    .await
            })
            .expect("注入代理的客户端应该连上代理");
        assert_eq!(response.status().as_u16(), 502);
        assert_eq!(poison.hits(), 1);
        assert_eq!(target.hits(), 0, "请求没有经过代理");

        // 控制面的真实构造函数：不传代理，直连目标。
        // 本机桩 + 整机高负载：给 10 秒，避免进程被冻结时误判成超时。
        let direct = http_client(Duration::from_secs(10)).unwrap();
        let response = runtime
            .block_on(async {
                direct
                    .get(format!("http://{}/v1/health", target.addr))
                    .send()
                    .await
            })
            .expect("控制面客户端应该直连目标");
        assert_eq!(response.status().as_u16(), 200);
        assert_eq!(target.hits(), 1);
        std::thread::sleep(Duration::from_millis(50));
        assert_eq!(poison.hits(), 1, "控制面请求走了代理");
    }

    /// 环境变量这一层单独验证：用户 shell / 系统里设了代理时控制面仍然直连。
    ///
    /// 代理变量只给子进程，测试进程自己的环境一点不动：进程内 `set_var` 与
    /// 其它测试的 `getenv` 并发是未定义行为，这正是原来那条偶发失败的根因。
    #[test]
    fn the_control_plane_client_ignores_proxy_environment() {
        let poison = Stub::spawn(POISON);
        let target = Stub::spawn(TARGET);
        poison.wait_ready();
        target.wait_ready();
        let exe = std::env::current_exe().unwrap();
        // 就绪信号走回环 TCP：子进程起来后连回这条监听，父进程 accept 到才继续。
        // 不用固定时间赌子进程「应该起来了」，也不用 stdio 管道（在测试进程里
        // 输出可能被 libtest 的捕获层吞掉）。
        let ready = std::net::TcpListener::bind("127.0.0.1:0").expect("绑定就绪监听");
        ready.set_nonblocking(true).expect("就绪监听设为非阻塞");
        let ready_addr = ready.local_addr().expect("读就绪地址");
        let mut child = std::process::Command::new(&exe)
            .args([
                "--exact",
                "control_plane::client::tests::proxy_environment_probe",
                "--ignored",
                "--test-threads=1",
                // panic 直接落到 stderr，父进程的断言一眼能看到原文与行号；
                // 不开的话 panic 只在 libtest 捕获的 stdout 里。
                "--nocapture",
            ])
            .env("VEYL_TEST_PROBE_READY", ready_addr.to_string())
            .env("VEYL_TEST_PROXY_TARGET", format!("http://{}/v1/health", target.addr))
            .env("HTTP_PROXY", format!("http://{}", poison.addr))
            .env("http_proxy", format!("http://{}", poison.addr))
            .env("HTTPS_PROXY", format!("http://{}", poison.addr))
            .env("https_proxy", format!("http://{}", poison.addr))
            .env("ALL_PROXY", format!("http://{}", poison.addr))
            .env_remove("NO_PROXY")
            .env_remove("no_proxy")
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .expect("启动子进程失败");
        // 只等「就绪信号」和「子进程退出」两个事件；60 秒上限只当挂死兜底，
        // 不是判定窗口（调大/调小都不该影响结论）。
        let deadline = std::time::Instant::now() + Duration::from_secs(60);
        let mut ready_signaled = false;
        loop {
            match ready.accept() {
                Ok((stream, _)) => {
                    drop(stream);
                    ready_signaled = true;
                    break;
                }
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {}
                Err(error) => panic!("就绪监听出错：{error}"),
            }
            if child.try_wait().expect("等待子进程").is_some() {
                // 子进程可能「连上就退出」：排队的就绪连接仍要收一次，
                // 连着的话说明信号其实已经到了。
                ready_signaled = ready.accept().is_ok();
                break;
            }
            if std::time::Instant::now() > deadline {
                let _ = child.kill();
                break;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        // 等子进程结束，同样有上限：挂死要变成明确失败，不能拖住整套测量。
        let mut timed_out = false;
        while child.try_wait().expect("等待子进程").is_none() {
            if std::time::Instant::now() > deadline {
                let _ = child.kill();
                timed_out = true;
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        let output = child.wait_with_output().expect("收集子进程输出");
        assert!(
            ready_signaled && !timed_out && output.status.success(),
            "子进程里的控制面客户端没有直连（{}，就绪={ready_signaled}，超时={timed_out}）：\n--- stdout ---\n{}\n--- stderr ---\n{}",
            output.status,
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(target.hits(), 1);
        std::thread::sleep(Duration::from_millis(50));
        assert_eq!(poison.hits(), 0, "控制面请求走了环境代理");
    }

    /// 只由上面的测试以子进程方式运行；手动 `--ignored` 跑不到目标时直接跳过。
    #[test]
    #[ignore = "由 the_control_plane_client_ignores_proxy_environment 起子进程运行"]
    fn proxy_environment_probe() {
        let Ok(url) = std::env::var("VEYL_TEST_PROXY_TARGET") else {
            return;
        };
        // 超时只当「进程挂死」的兜底，不再拿 10 秒赌机器负载——原来那条偶发失败
        // 就是整机高负载时子进程被冻结超过 10 秒。结论由下面的 200 断言给出。
        let client = http_client(Duration::from_secs(300)).unwrap();
        // 显式就绪信号：连一下父进程的 ready 监听就断开。父进程 accept 到这个
        // 连接才继续；信号不到（子进程没起来/提前退出）由父进程按失败处理。
        if let Ok(addr) = std::env::var("VEYL_TEST_PROBE_READY") {
            let _ = std::net::TcpStream::connect(addr);
        }
        let response = runtime()
            .block_on(async { client.get(&url).send().await })
            .expect("设了代理环境变量的子进程里，控制面客户端应该直连目标");
        assert_eq!(response.status().as_u16(), 200);
    }
}
