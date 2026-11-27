//! 回环 DNS 中继：mDNSResponder → `127.0.0.1:53` → 隧道。
//!
//! 为什么需要它：macOS 的 mDNSResponder 按网络服务绑定物理接口发查询，
//! 发往物理网卡之外的地址时**绕过路由表**，查询永远进不了 TUN（`tun-dns-pf.md`）。
//! 发往 `127.0.0.1` 则没有路由选择这回事，包直接由 loopback 投递
//! （真机预检 A，2026-11-26）。于是：系统 DNS 指向回环 → 本模块接住查询 →
//! 自己开 socket 用 `IP_BOUND_IF` 绑到 utun 发往公网 DNS → 包进 TUN，
//! 由 sing-box 的 `hijack-dns` 回答（真机预检 B，2026-11-26）。
//!
//! 三条纪律：
//! - **只做字节中继**：不解析、不缓存、不分流；解析链仍是 sing-box 的 dns。
//! - **隧道不在就直发**：绑 utun 失败或超时，同一条查询改走不绑接口的路径，
//!   保证隧道挂掉时解析不中断（答案可能被污染，与改造前一致）。
//! - **任何错误都不 panic**：helper 是唯一解析出口，线程崩了机器就没 DNS。

use std::io::{Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream, UdpSocket};
use std::os::unix::io::AsRawFd;
use std::sync::atomic::{AtomicBool, AtomicI32, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// 系统解析器指向的回环地址。端口固定 53（macOS 的服务级 DNS 键不支持改端口）。
/// 转发器绑定的回环地址。两套 APP 同时接管时不能都占 53 端口，所以由身份注入。
pub fn listen_ip() -> &'static str {
    crate::identity::dns_forwarder_ip()
}

pub fn listen_addr() -> String {
    format!("{}:53", listen_ip())
}
/// 进隧道后的目的地址：与 `dns.rs::SYSTEM_DNS_TARGET` 一致。`hijack-dns` 按协议
/// 匹配 53 端口，不挑目的地址；不用 TUN 对端（历史坑 + 未验证）。
pub const UPSTREAM_ADDR: &str = "223.5.5.5:53";

/// 读取循环的轮询间隔：决定 stop 的响应速度，不是查询超时。
const READ_POLL: Duration = Duration::from_millis(250);
const FORWARD_TIMEOUT: Duration = Duration::from_secs(3);
const TCP_FORWARD_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_MESSAGE: usize = 64 * 1024;
/// 同时在途的查询上限。UDP 与 TCP 分开计数：TCP 是长连接，不能被几十条
/// UDP 查询挤掉。超限的 UDP 查询回 SERVFAIL（不是静默丢弃），客户端能立刻
/// 走次选 DNS，而不是干等超时。
const MAX_INFLIGHT_UDP: usize = 64;
const MAX_INFLIGHT_TCP: usize = 64;
/// DNS 报文上限（TCP 长度前缀是 u16；UDP 也按同一上限收，设计写的是 ≤64KB）。
const UDP_BUFFER: usize = 65535;
/// 重建时端口可能还被上一代线程占着：按退避重试几次，别等下一个复核周期。
const START_ATTEMPTS: usize = 6;
const START_BACKOFF: Duration = Duration::from_millis(100);

/// macOS 的 `IP_BOUND_IF`（`<netinet/in.h>`），libc 在部分版本不导出。
const IP_BOUND_IF: libc::c_int = 25;

/// 一个正在监听的转发器。
pub struct Core {
    running: Arc<AtomicBool>,
    utun: Arc<AtomicI32>,
    threads: Vec<std::thread::JoinHandle<()>>,
}

impl Core {
    pub fn start(
        listen: SocketAddr,
        upstream: SocketAddr,
        utun_index: Option<u32>,
    ) -> Result<Self, String> {
        // 上一代线程退出后内核可能还占着 53 端口一小会儿（TCP 监听线程按
        // 100ms 轮询退出）。重建时按退避重试，别把这个窗口留给下一个 5s 周期。
        let mut last = String::new();
        for attempt in 0..START_ATTEMPTS {
            match Self::bind(listen) {
                Ok((udp, tcp)) => return Ok(Self::spawn(udp, tcp, listen, upstream, utun_index)),
                Err(error) => {
                    last = error;
                    if attempt + 1 < START_ATTEMPTS {
                        std::thread::sleep(START_BACKOFF);
                    }
                }
            }
        }
        Err(last)
    }

    fn bind(listen: SocketAddr) -> Result<(UdpSocket, TcpListener), String> {
        let udp = UdpSocket::bind(listen).map_err(|e| format!("bind udp {listen}: {e}"))?;
        udp.set_read_timeout(Some(READ_POLL))
            .map_err(|e| format!("set timeout {listen}: {e}"))?;
        let tcp = TcpListener::bind(listen).map_err(|e| format!("bind tcp {listen}: {e}"))?;
        tcp.set_nonblocking(true)
            .map_err(|e| format!("set nonblocking {listen}: {e}"))?;
        Ok((udp, tcp))
    }

    fn spawn(
        udp: UdpSocket,
        tcp: TcpListener,
        listen: SocketAddr,
        upstream: SocketAddr,
        utun_index: Option<u32>,
    ) -> Self {
        let running = Arc::new(AtomicBool::new(true));
        let utun = Arc::new(AtomicI32::new(
            utun_index.map(|index| index as i32).unwrap_or(-1),
        ));
        let udp = Arc::new(udp);

        let udp_thread = spawn_udp(
            udp,
            running.clone(),
            utun.clone(),
            upstream,
            Arc::new(AtomicUsize::new(0)),
        );
        let tcp_thread = spawn_tcp(
            tcp,
            running.clone(),
            utun.clone(),
            upstream,
            Arc::new(AtomicUsize::new(0)),
        );

        eprintln!("veyl-helper: DNS 转发器已监听 {listen} → {upstream} (utun={utun_index:?})");
        Self {
            running,
            utun,
            threads: vec![udp_thread, tcp_thread],
        }
    }

    pub fn is_running(&self) -> bool {
        self.running.load(Ordering::SeqCst)
    }

    pub fn set_utun(&self, utun_index: Option<u32>) {
        self.utun.store(
            utun_index.map(|index| index as i32).unwrap_or(-1),
            Ordering::SeqCst,
        );
    }

    /// 停监听并等线程退出（最多一个 `READ_POLL` 周期）。
    pub fn shutdown(&mut self) {
        self.running.store(false, Ordering::SeqCst);
        for thread in self.threads.drain(..) {
            let _ = thread.join();
        }
    }
}

impl Drop for Core {
    fn drop(&mut self) {
        self.shutdown();
    }
}

/// 全局唯一实例：helper 是系统里唯一该占 `127.0.0.1:53` 的进程，退出路径
/// （atexit）也要能停它，所以放在模块级而不是 Supervisor 里，与 `dns.rs` 的
/// 快照同一个模式。
static ACTIVE: Mutex<Option<Core>> = Mutex::new(None);

/// 启动（或复用）全局转发器。`Err` 里带绑定失败的原因，调用方据此回退。
pub fn start(utun_index: Option<u32>) -> Result<(), String> {
    let mut active = ACTIVE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some(core) = active.as_ref() {
        if core.is_running() {
            core.set_utun(utun_index);
            return Ok(());
        }
    }
    let listen: SocketAddr = listen_addr().parse().expect("listen addr");
    let upstream: SocketAddr = UPSTREAM_ADDR.parse().expect("upstream addr");
    let core = Core::start(listen, upstream, utun_index)?;
    *active = Some(core);
    Ok(())
}

pub fn stop() {
    let core = ACTIVE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .take();
    if let Some(mut core) = core {
        core.shutdown();
        eprintln!("veyl-helper: DNS 转发器已停止");
    }
}

/// 监听是否还活着。线程意外退出后为 false，调用方可以尝试 `start` 重建。
pub fn is_running() -> bool {
    let active = ACTIVE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    active.as_ref().is_some_and(Core::is_running)
}

/// 连接期复核时更新 utun 索引（换网络、隧道重建后）。
pub fn set_utun(utun_index: Option<u32>) {
    let active = ACTIVE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some(core) = active.as_ref() {
        core.set_utun(utun_index);
    }
}

// ---------------------------------------------------------------------------
// 中继
// ---------------------------------------------------------------------------

fn spawn_udp(
    sock: Arc<UdpSocket>,
    running: Arc<AtomicBool>,
    utun: Arc<AtomicI32>,
    upstream: SocketAddr,
    inflight: Arc<AtomicUsize>,
) -> std::thread::JoinHandle<()> {
    std::thread::spawn(move || {
        let mut buf = vec![0u8; UDP_BUFFER];
        while running.load(Ordering::SeqCst) {
            let (len, peer) = match sock.recv_from(&mut buf) {
                Ok(value) => value,
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(e)
                    if matches!(
                        e.kind(),
                        std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                    ) =>
                {
                    continue;
                }
                Err(_) => {
                    // 监听线程自己退出 = 多半不可再服务，整体标记停止，
                    // 复核路径据此降级/重建（`is_running` 不能长期说假话）。
                    running.store(false, Ordering::SeqCst);
                    break;
                }
            };
            // 小于 DNS 头的包不可能是查询；直接丢，别把垃圾放大给上游。
            // 填满缓冲区说明可能被截断（超长 EDNS），同样不转发。
            if len < 12 || len == buf.len() {
                continue;
            }
            if inflight.fetch_add(1, Ordering::SeqCst) >= MAX_INFLIGHT_UDP {
                inflight.fetch_sub(1, Ordering::SeqCst);
                // 回 SERVFAIL 而不是静默丢：客户端立刻能走次选 DNS，
                // 不必干等 5 秒超时。
                let _ = sock.send_to(&servfail(&buf[..len]), peer);
                continue;
            }
            let query = buf[..len].to_vec();
            let sock = Arc::clone(&sock);
            let running = Arc::clone(&running);
            let utun = Arc::clone(&utun);
            let inflight = Arc::clone(&inflight);
            std::thread::spawn(move || {
                let bound = utun.load(Ordering::SeqCst);
                let bound_if = (bound >= 0).then_some(bound as u32);
                match relay_udp(&query, upstream, bound_if, &running) {
                    Some(reply) => {
                        let _ = sock.send_to(&reply, peer);
                    }
                    None => {
                        let _ = sock.send_to(&servfail(&query), peer);
                    }
                }
                inflight.fetch_sub(1, Ordering::SeqCst);
            });
        }
    })
}

/// 用查询报文构造一条 SERVFAIL 应答：**只保留 12 字节头 + 问题段**。
///
/// 保留问题段是必要的：mDNSResponder 按问题名匹配待决查询，只有 12 字节
/// 头部的错误应答会被当成「无法解析」而继续等，白白多等一个超时。
/// 但**不能**把整条查询复制过来再清 ARCOUNT——带 EDNS 的查询尾部有 OPT 记录，
/// ARCOUNT=0 却留着 OPT 字节是畸形报文，严格解析器会直接丢掉，
/// 「立刻 SERVFAIL」的收益就没了。问题段按 QDCOUNT 精确截断。
fn servfail(query: &[u8]) -> Vec<u8> {
    if query.len() < 12 {
        return Vec::new();
    }
    let questions = u16::from_be_bytes([query[4], query[5]]);
    let mut reply = match question_section_end(query) {
        Some(end) => {
            let mut reply = query[..end].to_vec();
            reply[4..6].copy_from_slice(&questions.to_be_bytes());
            reply
        }
        // 问题段解析不了就只回头部（QDCOUNT=0），宁可比客户端少信息，不可畸形。
        None => {
            let mut reply = query[..12].to_vec();
            reply[4..6].copy_from_slice(&0u16.to_be_bytes());
            reply
        }
    };
    reply[2] |= 0x80; // QR = 1
    reply[3] = (reply[3] & 0xF0) | 0x02; // RCODE = SERVFAIL
    reply[6..12].fill(0); // AN/NS/AR 计数归零，与截断后的报文一致
    reply
}

/// 问题段结束位置（第一个问题名 + QTYPE + QCLASS 之后）。
/// 问题名里出现压缩指针或越界就返回 `None`。
fn question_section_end(query: &[u8]) -> Option<usize> {
    let questions = u16::from_be_bytes([*query.get(4)?, *query.get(5)?]);
    let mut at = 12usize;
    for _ in 0..questions {
        loop {
            let len = *query.get(at)? as usize;
            if len == 0 {
                at += 1 + 4;
                if at > query.len() {
                    return None;
                }
                break;
            }
            if len & 0xC0 != 0 {
                return None;
            }
            at += 1 + len;
            if at > query.len() {
                return None;
            }
        }
    }
    Some(at)
}

/// 先走隧道；隧道侧失败就把**同一条查询**改走不绑接口的路径。
///
/// 这一步是「隧道挂了不断网」的核心：sing-box 退出后 utun 消失，
/// `bind_to_interface` 会失败（或查询超时），直发路径让解析继续。
fn relay_udp(
    query: &[u8],
    upstream: SocketAddr,
    bound_if: Option<u32>,
    running: &AtomicBool,
) -> Option<Vec<u8>> {
    if let Some(index) = bound_if {
        if let Some(reply) = exchange_udp(query, upstream, Some(index)) {
            return Some(reply);
        }
    }
    if !running.load(Ordering::SeqCst) {
        return None;
    }
    exchange_udp(query, upstream, None)
}

fn exchange_udp(query: &[u8], upstream: SocketAddr, bound_if: Option<u32>) -> Option<Vec<u8>> {
    let local: SocketAddr = if upstream.is_ipv4() {
        "0.0.0.0:0".parse().ok()?
    } else {
        "[::]:0".parse().ok()?
    };
    let sock = UdpSocket::bind(local).ok()?;
    sock.set_read_timeout(Some(FORWARD_TIMEOUT)).ok()?;
    if let Some(index) = bound_if {
        bind_to_interface(sock.as_raw_fd(), index).ok()?;
    }
    sock.connect(upstream).ok()?;
    sock.send(query).ok()?;
    let mut buf = vec![0u8; MAX_MESSAGE];
    let len = sock.recv(&mut buf).ok()?;
    buf.truncate(len);
    Some(buf)
}

fn spawn_tcp(
    listener: TcpListener,
    running: Arc<AtomicBool>,
    utun: Arc<AtomicI32>,
    upstream: SocketAddr,
    inflight: Arc<AtomicUsize>,
) -> std::thread::JoinHandle<()> {
    std::thread::spawn(move || {
        while running.load(Ordering::SeqCst) {
            match listener.accept() {
                Ok((client, _peer)) => {
                    if inflight.fetch_add(1, Ordering::SeqCst) >= MAX_INFLIGHT_TCP {
                        inflight.fetch_sub(1, Ordering::SeqCst);
                        // 关掉这条连接，客户端会改走 UDP 或次选，不让它挂着。
                        drop(client);
                        continue;
                    }
                    let running = Arc::clone(&running);
                    let utun = Arc::clone(&utun);
                    let inflight = Arc::clone(&inflight);
                    std::thread::spawn(move || {
                        let bound = utun.load(Ordering::SeqCst);
                        let bound_if = (bound >= 0).then_some(bound as u32);
                        relay_tcp(client, upstream, bound_if, &running);
                        inflight.fetch_sub(1, Ordering::SeqCst);
                    });
                }
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(READ_POLL.min(Duration::from_millis(100)));
                }
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(_) => {
                    // TCP 监听死了也算整体不可用：只剩 UDP 时大响应查询会卡住，
                    // 统一标死交给复核重建（`is_running` 必须同时反映 TCP）。
                    if running.load(Ordering::SeqCst) {
                        running.store(false, Ordering::SeqCst);
                    }
                    break;
                }
            }
        }
    })
}

fn relay_tcp(
    mut client: TcpStream,
    upstream: SocketAddr,
    bound_if: Option<u32>,
    running: &AtomicBool,
) {
    let _ = client.set_read_timeout(Some(TCP_FORWARD_TIMEOUT));
    let _ = client.set_write_timeout(Some(TCP_FORWARD_TIMEOUT));
    loop {
        if !running.load(Ordering::SeqCst) {
            return;
        }
        let Some(query) = read_frame(&mut client) else {
            return;
        };
        let reply = if let Some(index) = bound_if {
            exchange_tcp(&query, upstream, Some(index))
                .or_else(|| exchange_tcp(&query, upstream, None))
        } else {
            exchange_tcp(&query, upstream, None)
        };
        let Some(reply) = reply else {
            return;
        };
        if write_frame(&mut client, &reply).is_err() {
            return;
        }
    }
}

/// TCP 53 是 DNS 的大响应通道（UDP 截断后客户端重问）。
///
/// TCP **不走 `IP_BOUND_IF`**：std 的 `TcpStream` 没有「先绑接口再 connect」的接口，
/// 而 `connect` 在阻塞 socket 上的超时不可控。这里改用 `connect_timeout` 走路由表——
/// `auto_route` 已经让 `223.5.5.5` 的默认路由指向 utun，效果一致；utun 不在时
/// 它自然走物理网卡，正好是需要的兜底。
fn exchange_tcp(query: &[u8], upstream: SocketAddr, bound_if: Option<u32>) -> Option<Vec<u8>> {
    let stream = if bound_if.is_some() {
        connect_tcp_bound(upstream, bound_if?)?
    } else {
        TcpStream::connect_timeout(&upstream, TCP_FORWARD_TIMEOUT).ok()?
    };
    let mut stream = stream;
    let _ = stream.set_read_timeout(Some(TCP_FORWARD_TIMEOUT));
    let _ = stream.set_write_timeout(Some(TCP_FORWARD_TIMEOUT));
    write_frame(&mut stream, query).ok()?;
    read_frame(&mut stream)
}

/// 绑接口的 TCP 连接：非阻塞 `connect` + `poll(POLLOUT)`，避免阻塞 socket
/// 上不可控的 connect 超时。
fn connect_tcp_bound(upstream: SocketAddr, index: u32) -> Option<TcpStream> {
    let SocketAddr::V4(addr) = upstream else {
        return None;
    };
    let fd = unsafe { libc::socket(libc::AF_INET, libc::SOCK_STREAM, 0) };
    if fd < 0 {
        return None;
    }
    let close = |fd: libc::c_int| unsafe {
        libc::close(fd);
    };
    if bind_to_interface(fd, index).is_err() {
        close(fd);
        return None;
    }
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFL, 0) };
    if flags < 0 || unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0 {
        close(fd);
        return None;
    }

    let mut raw: libc::sockaddr_in = unsafe { std::mem::zeroed() };
    raw.sin_len = std::mem::size_of::<libc::sockaddr_in>() as u8;
    raw.sin_family = libc::AF_INET as u8;
    raw.sin_port = addr.port().to_be();
    raw.sin_addr = libc::in_addr {
        s_addr: u32::from_ne_bytes(addr.ip().octets()),
    };
    let rc = unsafe {
        libc::connect(
            fd,
            &raw as *const libc::sockaddr_in as *const libc::sockaddr,
            std::mem::size_of::<libc::sockaddr_in>() as libc::socklen_t,
        )
    };
    if rc != 0 {
        let err = std::io::Error::last_os_error();
        // EINPROGRESS 是正常的非阻塞连接中间态；其余立即失败。
        if err.raw_os_error() != Some(libc::EINPROGRESS) {
            close(fd);
            return None;
        }
        let mut pollfd = libc::pollfd {
            fd,
            events: libc::POLLOUT,
            revents: 0,
        };
        let ready = unsafe {
            libc::poll(
                &mut pollfd,
                1,
                TCP_FORWARD_TIMEOUT.as_millis() as libc::c_int,
            )
        };
        if ready <= 0 {
            close(fd);
            return None;
        }
        let mut so_error: libc::c_int = 0;
        let mut len = std::mem::size_of::<libc::c_int>() as libc::socklen_t;
        let rc = unsafe {
            libc::getsockopt(
                fd,
                libc::SOL_SOCKET,
                libc::SO_ERROR,
                &mut so_error as *mut libc::c_int as *mut libc::c_void,
                &mut len,
            )
        };
        if rc != 0 || so_error != 0 {
            close(fd);
            return None;
        }
    }
    // 恢复阻塞模式失败就没法安全地交给 std（读写超时语义不可靠），
    // 关掉让它走不绑接口的兜底路径。
    if unsafe { libc::fcntl(fd, libc::F_SETFL, flags) } < 0 {
        close(fd);
        return None;
    }
    Some(unsafe { <TcpStream as std::os::unix::io::FromRawFd>::from_raw_fd(fd) })
}

fn bind_to_interface(fd: libc::c_int, index: u32) -> std::io::Result<()> {
    let value = index as libc::c_int;
    let rc = unsafe {
        libc::setsockopt(
            fd,
            libc::IPPROTO_IP,
            IP_BOUND_IF,
            &value as *const libc::c_int as *const libc::c_void,
            std::mem::size_of::<libc::c_int>() as libc::socklen_t,
        )
    };
    if rc != 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(())
}

fn read_frame(stream: &mut impl Read) -> Option<Vec<u8>> {
    let mut len = [0u8; 2];
    stream.read_exact(&mut len).ok()?;
    let size = u16::from_be_bytes(len) as usize;
    if size == 0 || size > MAX_MESSAGE {
        return None;
    }
    let mut buf = vec![0u8; size];
    stream.read_exact(&mut buf).ok()?;
    Some(buf)
}

fn write_frame(stream: &mut impl Write, data: &[u8]) -> std::io::Result<()> {
    if data.is_empty() || data.len() > u16::MAX as usize {
        return Err(std::io::Error::other("dns frame too large"));
    }
    stream.write_all(&(data.len() as u16).to_be_bytes())?;
    stream.write_all(data)
}

// ---------------------------------------------------------------------------
// TUN 接口
// ---------------------------------------------------------------------------

/// 从 sing-box 配置里取 TUN 地址（去掉前缀长度）。
pub fn tun_address(config: &serde_json::Value) -> Option<String> {
    let value = config["inbounds"]
        .as_array()?
        .iter()
        .find(|entry| entry["type"] == "tun")?
        .get("address")?;
    let text = match value {
        serde_json::Value::Array(list) => list.first()?.as_str()?,
        other => other.as_str()?,
    };
    Some(text.split('/').next()?.to_string())
}

/// 带超时地跑一条命令并取 stdout。helper 里其它外部命令都有预算，这里同样。
fn run_capture_timeout(program: &str, args: &[&str], timeout: Duration) -> Option<String> {
    let mut child = std::process::Command::new(program)
        .args(args)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .ok()?;
    let deadline = std::time::Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                if !status.success() {
                    return None;
                }
                let mut out = Vec::new();
                child.stdout.take()?.read_to_end(&mut out).ok()?;
                return Some(String::from_utf8_lossy(&out).into_owned());
            }
            Ok(None) if std::time::Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(20));
            }
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
}

/// 当前持有该地址的 utun 接口索引。`None` = 隧道还没建好或已经不在了。
pub fn tun_index(config: &serde_json::Value) -> Option<u32> {
    let address = tun_address(config)?;
    // 与 helper 里其它命令一致：超时就杀掉，不能把 start 线程挂在
    // 一个卡死的 ifconfig 上。
    let text = run_capture_timeout("/sbin/ifconfig", &["-a"], Duration::from_millis(1500))?;
    let name = tun_interface_for(&text, &address)?;
    let c_name = std::ffi::CString::new(name).ok()?;
    let index = unsafe { libc::if_nametoindex(c_name.as_ptr()) };
    (index != 0).then_some(index)
}

/// `ifconfig -a` 的输出里找持有该地址的 utun。抽成纯函数便于单测。
pub fn tun_interface_for(text: &str, address: &str) -> Option<String> {
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

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_query() -> Vec<u8> {
        // 最小 DNS 查询：ID=0x1234，1 个问题，A/IN，example.com
        let mut query = vec![0x12, 0x34, 0x01, 0x00, 0, 1, 0, 0, 0, 0, 0, 0];
        for label in ["example", "com"] {
            query.push(label.len() as u8);
            query.extend_from_slice(label.as_bytes());
        }
        query.push(0);
        query.extend_from_slice(&[0, 1, 0, 1]);
        query
    }

    /// 假上游：收到什么回什么，但把答案计数改成 1，便于断言是中继回来的。
    fn spawn_echo_upstream() -> (UdpSocket, SocketAddr, Arc<AtomicUsize>) {
        let sock = UdpSocket::bind("127.0.0.1:0").unwrap();
        let addr = sock.local_addr().unwrap();
        sock.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
        let count = Arc::new(AtomicUsize::new(0));
        let counter = Arc::clone(&count);
        let upstream = sock.try_clone().unwrap();
        std::thread::spawn(move || {
            let mut buf = [0u8; 2048];
            while let Ok((len, peer)) = upstream.recv_from(&mut buf) {
                counter.fetch_add(1, Ordering::SeqCst);
                let mut reply = buf[..len].to_vec();
                reply[2] |= 0x80; // QR=1
                let _ = upstream.send_to(&reply, peer);
            }
        });
        (sock, addr, count)
    }

    #[test]
    fn tun_address_is_read_from_the_array_or_string_form() {
        let array = serde_json::json!({
            "inbounds": [{"type": "tun", "address": ["172.19.0.1/30"]}]
        });
        assert_eq!(tun_address(&array).as_deref(), Some("172.19.0.1"));
        let string = serde_json::json!({
            "inbounds": [{"type": "tun", "address": "198.18.0.1/15"}]
        });
        assert_eq!(tun_address(&string).as_deref(), Some("198.18.0.1"));
        assert_eq!(tun_address(&serde_json::json!({})), None);
    }

    #[test]
    fn finds_the_utun_holding_the_tun_address() {
        let text = "utun3: flags=8051<UP>\n\tinet 10.0.0.1 --> 10.0.0.2 netmask 0xfffffffc\n\
                    utun4: flags=8051<UP>\n\tinet 172.19.0.1 --> 172.19.0.2 netmask 0xfffffffc\n";
        assert_eq!(
            tun_interface_for(text, "172.19.0.1").as_deref(),
            Some("utun4")
        );
        assert_eq!(tun_interface_for(text, "172.19.0.2"), None);
        assert_eq!(tun_interface_for("", "172.19.0.1"), None);
    }

    #[test]
    fn udp_roundtrip_through_a_fake_upstream() {
        let (_sock, upstream, count) = spawn_echo_upstream();
        let query = tmp_query();
        let reply = exchange_udp(&query, upstream, None).expect("reply");
        assert_eq!(count.load(Ordering::SeqCst), 1);
        assert_eq!(reply.len(), query.len());
        assert_eq!(&reply[..2], &[0x12, 0x34], "DNS ID 必须原样带回");
        assert_ne!(reply[2] & 0x80, 0, "是对端回的应答");
    }

    #[test]
    fn the_forwarder_relays_and_replies_to_the_client() {
        let (_upstream_sock, upstream, count) = spawn_echo_upstream();
        let running = Arc::new(AtomicBool::new(true));
        let utun = Arc::new(AtomicI32::new(-1));
        let listener = Arc::new(UdpSocket::bind("127.0.0.1:0").unwrap());
        listener.set_read_timeout(Some(READ_POLL)).unwrap();
        let listen_addr = listener.local_addr().unwrap();
        let inflight = Arc::new(AtomicUsize::new(0));

        // 直接启动 UDP 线程（不占 53 端口，测试不需要 root）。
        let handle = spawn_udp(
            Arc::clone(&listener),
            Arc::clone(&running),
            utun,
            upstream,
            inflight,
        );

        let client = UdpSocket::bind("127.0.0.1:0").unwrap();
        client
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        let query = tmp_query();
        client.send_to(&query, listen_addr).unwrap();
        let mut buf = [0u8; 512];
        let (len, _) = client.recv_from(&mut buf).expect("relayed reply");
        assert_eq!(count.load(Ordering::SeqCst), 1);
        // 上游把 QR 置 1，其余字节原样带回（中继不改写报文）。
        assert_eq!(&buf[..2], &query[..2], "DNS ID 原样带回");
        assert_eq!(&buf[3..len], &query[3..], "除 QR 位外字节不变");

        running.store(false, Ordering::SeqCst);
        let _ = handle.join();
    }

    #[test]
    fn a_short_packet_is_dropped_without_touching_the_upstream() {
        let (_sock, upstream, count) = spawn_echo_upstream();
        let running = Arc::new(AtomicBool::new(true));
        let utun = Arc::new(AtomicI32::new(-1));
        let listener = Arc::new(UdpSocket::bind("127.0.0.1:0").unwrap());
        listener.set_read_timeout(Some(READ_POLL)).unwrap();
        let listen_addr = listener.local_addr().unwrap();

        let handle = spawn_udp(
            Arc::clone(&listener),
            Arc::clone(&running),
            utun,
            upstream,
            Arc::new(AtomicUsize::new(0)),
        );
        let client = UdpSocket::bind("127.0.0.1:0").unwrap();
        client
            .set_read_timeout(Some(Duration::from_millis(400)))
            .unwrap();
        client.send_to(b"hi", listen_addr).unwrap();
        let mut buf = [0u8; 16];
        assert!(client.recv_from(&mut buf).is_err(), "短包不应有回复");
        assert_eq!(count.load(Ordering::SeqCst), 0);

        running.store(false, Ordering::SeqCst);
        let _ = handle.join();
    }

    #[test]
    fn tcp_frames_roundtrip_with_a_length_prefix() {
        let mut buf: Vec<u8> = Vec::new();
        write_frame(&mut buf, b"hello").unwrap();
        assert_eq!(&buf[..2], &[0, 5]);
        let mut cursor = std::io::Cursor::new(buf);
        assert_eq!(read_frame(&mut cursor).as_deref(), Some(&b"hello"[..]));
    }

    #[test]
    fn an_occupied_port_is_reported_instead_of_panicking() {
        // 占住一个 TCP 端口，再让 Core 去绑同一个端口（UDP 先绑成功也无妨）。
        let holder = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = holder.local_addr().unwrap();
        let err = match Core::start(addr, "127.0.0.1:9".parse().unwrap(), None) {
            Ok(_) => panic!("绑到已占用端口应当失败"),
            Err(error) => error,
        };
        assert!(err.contains("bind"), "{err}");
    }

    #[test]
    fn stop_ends_the_threads_promptly() {
        let listener = UdpSocket::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        drop(listener);
        let mut core = Core::start(addr, "127.0.0.1:9".parse().unwrap(), None).unwrap();
        assert!(core.is_running());
        core.shutdown();
        assert!(!core.is_running());
    }

    #[test]
    fn writing_to_a_closed_upstream_falls_back_without_panicking() {
        let query = tmp_query();
        // 端口 9 上没有服务；UDP 会等到超时，这里只用 1s 以内的路径断言不 panic。
        assert!(exchange_udp(&query, "127.0.0.1:9".parse().unwrap(), None).is_none());
    }

    /// 绑 utun 失败（接口索引不存在）要自动退到直发，而不是把查询丢掉。
    #[test]
    fn a_bad_utun_index_falls_back_to_the_direct_path() {
        let (_sock, upstream, count) = spawn_echo_upstream();
        let running = AtomicBool::new(true);
        let reply =
            relay_udp(&tmp_query(), upstream, Some(999_999), &running).expect("绑定失败必须走直发");
        assert_eq!(count.load(Ordering::SeqCst), 1);
        assert_eq!(&reply[..2], &[0x12, 0x34]);
    }

    /// 并发打满时回 SERVFAIL（保留 ID），不是静默丢弃。
    #[test]
    fn a_saturated_udp_pool_answers_servfail_instead_of_dropping() {
        let (_upstream_sock, upstream, count) = spawn_echo_upstream();
        let running = Arc::new(AtomicBool::new(true));
        let utun = Arc::new(AtomicI32::new(-1));
        let listener = Arc::new(UdpSocket::bind("127.0.0.1:0").unwrap());
        listener.set_read_timeout(Some(READ_POLL)).unwrap();
        let listen_addr = listener.local_addr().unwrap();
        let inflight = Arc::new(AtomicUsize::new(MAX_INFLIGHT_UDP));
        let handle = spawn_udp(
            Arc::clone(&listener),
            Arc::clone(&running),
            utun,
            upstream,
            inflight,
        );

        let client = UdpSocket::bind("127.0.0.1:0").unwrap();
        client
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        let query = tmp_query();
        client.send_to(&query, listen_addr).unwrap();
        let mut buf = [0u8; 512];
        let (_len, _) = client.recv_from(&mut buf).expect("servfail reply");
        assert_eq!(&buf[..2], &query[..2], "ID 原样保留");
        assert_eq!(buf[3] & 0x0F, 2, "RCODE = SERVFAIL");
        assert_eq!(count.load(Ordering::SeqCst), 0, "没有打到上游");

        running.store(false, Ordering::SeqCst);
        let _ = handle.join();
    }

    #[test]
    fn servfail_keeps_the_question_section() {
        let query = tmp_query();
        let reply = servfail(&query);
        assert_eq!(&reply[..2], &query[..2]);
        assert_ne!(reply[2] & 0x80, 0, "QR = 1");
        assert_eq!(reply[3] & 0x0F, 2, "RCODE = SERVFAIL");
        assert_eq!(&reply[6..12], &[0u8; 6], "AN/NS/AR 归零");
        assert_eq!(&reply[12..], &query[12..], "问题段原样保留");
    }

    /// 带 EDNS 的查询：SERVFAIL 必须把 OPT 尾部截掉，否则 ARCOUNT=0 却留着
    /// OPT 字节，严格解析器会丢弃整条应答。
    #[test]
    fn servfail_drops_the_edns_option_record() {
        let mut query = tmp_query();
        let question_len = query.len();
        // OPT：根名 + TYPE=41 + CLASS=1232 + TTL=0 + RDLEN=0
        query.extend_from_slice(&[0x00, 0x00, 41, 0x04, 0xD0, 0, 0, 0, 0, 0, 0]);
        query[10..12].copy_from_slice(&1u16.to_be_bytes()); // ARCOUNT = 1

        let reply = servfail(&query);
        assert_eq!(reply.len(), question_len, "尾部 OPT 必须被截掉");
        assert_eq!(u16::from_be_bytes([reply[10], reply[11]]), 0, "ARCOUNT=0");
        assert_eq!(u16::from_be_bytes([reply[6], reply[7]]), 0, "ANCOUNT=0");
        assert_eq!(u16::from_be_bytes([reply[8], reply[9]]), 0, "NSCOUNT=0");
        assert_eq!(u16::from_be_bytes([reply[4], reply[5]]), 1, "QDCOUNT 保留");
        assert_eq!(reply[3] & 0x0F, 2, "RCODE = SERVFAIL");
    }

    #[test]
    fn servfail_falls_back_to_the_header_when_the_question_is_broken() {
        let mut query = tmp_query();
        query[12] = 0xC0; // 问题名里出现压缩指针：解析不了就只回头部
        let reply = servfail(&query);
        assert_eq!(reply.len(), 12);
        assert_eq!(u16::from_be_bytes([reply[4], reply[5]]), 0);
        assert_eq!(reply[3] & 0x0F, 2);
    }

    fn spawn_tcp_echo_upstream() -> (SocketAddr, Arc<AtomicUsize>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let count = Arc::new(AtomicUsize::new(0));
        let counter = Arc::clone(&count);
        std::thread::spawn(move || {
            while let Ok((mut stream, _)) = listener.accept() {
                let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
                let echo = stream.try_clone().unwrap();
                let counter = Arc::clone(&counter);
                std::thread::spawn(move || {
                    let mut echo = echo;
                    while let Some(query) = read_frame(&mut stream) {
                        counter.fetch_add(1, Ordering::SeqCst);
                        if write_frame(&mut echo, &query).is_err() {
                            return;
                        }
                    }
                });
            }
        });
        (addr, count)
    }

    /// TCP 53 端到端：客户端 → 转发器监听 → 上游 → 原路返回。
    #[test]
    fn tcp_queries_are_relayed_end_to_end() {
        let (upstream, count) = spawn_tcp_echo_upstream();
        // 先占一个端口再释放，Core 才能绑到已知端口（与端口占用的用例同法）。
        let probe = TcpListener::bind("127.0.0.1:0").unwrap();
        let listen = probe.local_addr().unwrap();
        drop(probe);

        let mut core = Core::start(listen, upstream, None).expect("start");
        let mut client = TcpStream::connect(listen).expect("connect");
        client
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        write_frame(&mut client, &tmp_query()).unwrap();
        let reply = read_frame(&mut client).expect("tcp reply");
        assert_eq!(&reply[..2], &[0x12, 0x34]);
        assert_eq!(count.load(Ordering::SeqCst), 1);
        core.shutdown();
    }

    /// 绑接口的 TCP 连接在真实接口上能建立（lo0 作为无副作用的测试目标）。
    #[test]
    fn connect_tcp_bound_works_on_a_real_interface() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let accept = std::thread::spawn(move || {
            let _ = listener.accept();
        });
        let name = std::ffi::CString::new("lo0").unwrap();
        let index = unsafe { libc::if_nametoindex(name.as_ptr()) };
        assert_ne!(index, 0);
        let stream = connect_tcp_bound(addr, index).expect("bound connect");
        drop(stream);
        let _ = accept.join();
    }

    #[test]
    fn frames_over_64k_are_rejected() {
        let mut sink: Vec<u8> = Vec::new();
        let big = vec![0u8; MAX_MESSAGE + 1];
        assert!(write_frame(&mut sink, &big).is_err());
    }
}
