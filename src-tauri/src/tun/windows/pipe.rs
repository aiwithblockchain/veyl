//! 命名管道的两端。
//!
//! 服务端：
//! - `FILE_FLAG_FIRST_PIPE_INSTANCE`：同名管道已存在时创建失败，服务拒绝启动（不降级）。
//! - `PIPE_REJECT_REMOTE_CLIENTS`：拒绝远程客户端。
//! - DACL 只给 SYSTEM、Administrators 与当前控制台用户。
//! - 每个连接先 `peer::verify`，失败立即断开，不读请求体。
//!
//! 客户端（主程序，普通用户）只做三件事：连、发一帧、读一帧。

use std::io::{self, Read, Write};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use windows_sys::Win32::Foundation::{
    CloseHandle, GetLastError, LocalFree, BOOL, ERROR_BROKEN_PIPE, ERROR_IO_PENDING,
    ERROR_OPERATION_ABORTED, ERROR_PIPE_NOT_CONNECTED, GENERIC_READ, GENERIC_WRITE, HANDLE,
    INVALID_HANDLE_VALUE, WAIT_OBJECT_0, WAIT_TIMEOUT,
};
use windows_sys::Win32::Security::Authorization::{
    ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1,
};
use windows_sys::Win32::Security::{
    GetTokenInformation, TokenUser, SECURITY_ATTRIBUTES, TOKEN_USER,
};
use windows_sys::Win32::Storage::FileSystem::{
    CreateFileW, ReadFile, WriteFile, FILE_FLAG_FIRST_PIPE_INSTANCE, FILE_FLAG_OVERLAPPED,
    OPEN_EXISTING, PIPE_ACCESS_DUPLEX,
};
use windows_sys::Win32::System::Pipes::{
    ConnectNamedPipe, CreateNamedPipeW, DisconnectNamedPipe, GetNamedPipeServerProcessId,
    WaitNamedPipeW, PIPE_READMODE_BYTE, PIPE_REJECT_REMOTE_CLIENTS, PIPE_TYPE_BYTE, PIPE_WAIT,
};
use windows_sys::Win32::System::RemoteDesktop::{WTSGetActiveConsoleSessionId, WTSQueryUserToken};
use windows_sys::Win32::System::Services::{
    CloseServiceHandle, OpenSCManagerW, OpenServiceW, QueryServiceStatusEx, SC_HANDLE,
    SC_MANAGER_CONNECT, SC_STATUS_PROCESS_INFO, SERVICE_QUERY_STATUS, SERVICE_RUNNING,
    SERVICE_STATUS_PROCESS,
};
use windows_sys::Win32::System::Threading::{
    CreateEventW, GetCurrentThreadId, OpenThread, ResetEvent, WaitForSingleObject, THREAD_TERMINATE,
};
use windows_sys::Win32::System::IO::{
    CancelIoEx, CancelSynchronousIo, GetOverlappedResult, OVERLAPPED,
};

use super::ipc::{self, Request, Response};
use super::log::ServiceLog;
use super::peer;

/// 契约 1.0.4 §1.3 的四个最终值。改值只改这里，不要用同一个笼统常量覆盖不同语义。
pub const TUN_CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
pub const TUN_FIRST_FRAME_TIMEOUT: Duration = Duration::from_secs(5);
pub const TUN_REPLY_DEADLINE_CONTROL: Duration = Duration::from_secs(10);
pub const TUN_REPLY_DEADLINE_START: Duration = Duration::from_secs(30);

/// 写请求本身的时限。契约未单列；一帧最大 2 MiB，5 秒足够把它交给管道。
/// 读回复用上面按请求类型区分的 deadline。
const CLIENT_WRITE_TIMEOUT: Duration = Duration::from_secs(5);

const BUFFER_BYTES: u32 = 64 * 1024;

/// 管道句柄交给 `CancelIoEx` 用：控制回调在另一个线程，只能传数值。
static CURRENT_PIPE: AtomicUsize = AtomicUsize::new(0);
static STOP: AtomicBool = AtomicBool::new(false);

#[derive(Debug)]
pub enum IpcError {
    /// 服务不存在，或 SCM/服务状态查询本身失败。
    /// 契约 §4.4：`local_code = helper_missing`；message 不回显细节。
    HelperMissing(String),
    /// 连上之后发现对端不是我们的服务（SCM 状态/pid 不符，或服务没运行）。
    /// 契约 §4.4：`local_code = peer_unverified`，UI 理由 `helper_missing`；
    /// `message` 只说「服务没有正常启动」，探测细节放 `detail` 进日志。
    PeerUnverified {
        detail: String,
    },
    Unavailable(String),
    Timeout(String),
    Protocol(String),
}

impl IpcError {
    /// 契约 §4.4 的本地错误码（不跨线）：
    /// `helper_missing` / `peer_unverified` / `timeout` / `transport_error`。
    pub fn local_code(&self) -> &'static str {
        match self {
            IpcError::HelperMissing(_) => "helper_missing",
            IpcError::PeerUnverified { .. } => "peer_unverified",
            IpcError::Timeout(_) => "timeout",
            IpcError::Unavailable(_) | IpcError::Protocol(_) => "transport_error",
        }
    }
}

impl std::fmt::Display for IpcError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            IpcError::HelperMissing(_) => write!(f, "Veyl 特权服务不可用"),
            IpcError::PeerUnverified { .. } => write!(f, "服务没有正常启动"),
            IpcError::Unavailable(message) => write!(f, "连不上 Veyl 特权服务：{message}"),
            IpcError::Timeout(message) => write!(f, "Veyl 特权服务没有在期限内回复：{message}"),
            IpcError::Protocol(message) => {
                write!(f, "特权服务返回了无法识别的回复：{message}")
            }
        }
    }
}

impl std::error::Error for IpcError {}

struct Handle(HANDLE);

impl Handle {
    fn raw(&self) -> HANDLE {
        self.0
    }
}

impl Drop for Handle {
    fn drop(&mut self) {
        if !self.0.is_null() && self.0 != INVALID_HANDLE_VALUE {
            unsafe { CloseHandle(self.0) };
        }
    }
}

// 句柄只在创建它的线程里用；`AtomicUsize` 只保存数值供 CancelIoEx。
unsafe impl Send for Handle {}

// ---------------------------------------------------------------------------
// 客户端
// ---------------------------------------------------------------------------

/// 发一条请求并等回复。阻塞调用；主程序应放到不会卡住 async 线程的地方。
pub fn call(request: &Request) -> Result<Response, IpcError> {
    call_with_timeout(request, TUN_CONNECT_TIMEOUT)
}

pub fn call_with_timeout(
    request: &Request,
    connect_timeout: Duration,
) -> Result<Response, IpcError> {
    let pipe = connect_client(connect_timeout)?;
    // **写任何数据之前**先确认对端是 SCM 起的服务进程。否则同用户进程可以在服务
    // 启动前抢占管道名，收走配置（含节点凭据）或伪造 ok。
    verify_server(&pipe)?;

    // `start` 可能要在服务侧复制运行时，给 30 秒；status/stop 10 秒。
    let reply_deadline = match request {
        Request::Start { .. } => TUN_REPLY_DEADLINE_START,
        _ => TUN_REPLY_DEADLINE_CONTROL,
    };
    let mut io = ClientIo::new(pipe.raw(), CLIENT_WRITE_TIMEOUT, reply_deadline)
        .map_err(|error| IpcError::Unavailable(format!("初始化管道 I/O 失败：{error}")))?;

    let body = ipc::encode(request).map_err(|error| IpcError::Protocol(error.to_string()))?;
    ipc::write_frame(&mut io, &body).map_err(|error| map_io("写请求", error))?;

    let reply = ipc::read_frame(&mut io).map_err(|error| map_io("读回复", error))?;
    serde_json::from_slice(&reply).map_err(|error| IpcError::Protocol(error.to_string()))
}

fn map_io(what: &str, error: io::Error) -> IpcError {
    if error.kind() == io::ErrorKind::TimedOut {
        IpcError::Timeout(format!("{what}：{error}"))
    } else {
        IpcError::Unavailable(format!("{what}失败：{error}"))
    }
}

fn unverified(detail: String) -> IpcError {
    IpcError::PeerUnverified { detail }
}

fn helper_missing(detail: String) -> IpcError {
    IpcError::HelperMissing(detail)
}

/// 客户端侧的对端认证：管道服务端 pid 必须等于 SCM 里本服务的 pid。
///
/// SCM 是可信来源（注册服务需要管理员）。这样即使同名管道在服务启动前被抢占，
/// 客户端也不会把配置发给占位进程，更不会读到伪造的 `ok:true`。
/// 「服务没装 / 查询失败」是 `helper_missing`；「连上了但对端身份不对 / 不在运行」
/// 是 `peer_unverified`（契约 §4.4）。
fn verify_server(pipe: &Handle) -> Result<(), IpcError> {
    let mut server_pid = 0u32;
    if unsafe { GetNamedPipeServerProcessId(pipe.raw(), &mut server_pid) } == 0 {
        return Err(unverified(format!(
            "取管道服务端 pid 失败（Win32 {}）",
            unsafe { GetLastError() }
        )));
    }

    let scm = unsafe { OpenSCManagerW(std::ptr::null(), std::ptr::null(), SC_MANAGER_CONNECT) };
    if scm.is_null() {
        return Err(helper_missing(format!(
            "打开服务控制管理器失败（Win32 {}）",
            unsafe { GetLastError() }
        )));
    }
    let scm = ScHandle(scm);

    let name = super::wide(super::SERVICE_NAME);
    let service = unsafe { OpenServiceW(scm.0, name.as_ptr(), SERVICE_QUERY_STATUS) };
    if service.is_null() {
        return Err(helper_missing(format!(
            "服务 {} 未安装或不可查询（Win32 {}）",
            super::SERVICE_NAME,
            unsafe { GetLastError() }
        )));
    }
    let service = ScHandle(service);

    let mut status: SERVICE_STATUS_PROCESS = unsafe { std::mem::zeroed() };
    let mut needed = 0u32;
    let ok = unsafe {
        QueryServiceStatusEx(
            service.0,
            SC_STATUS_PROCESS_INFO,
            &mut status as *mut SERVICE_STATUS_PROCESS as *mut u8,
            std::mem::size_of::<SERVICE_STATUS_PROCESS>() as u32,
            &mut needed,
        )
    };
    if ok == 0 {
        return Err(helper_missing(format!(
            "查询服务状态失败（Win32 {}）",
            unsafe { GetLastError() }
        )));
    }
    if status.dwCurrentState != SERVICE_RUNNING {
        return Err(unverified(format!(
            "服务状态不是运行中（state={}）",
            status.dwCurrentState
        )));
    }
    if status.dwProcessId == 0 || status.dwProcessId != server_pid {
        // 契约 §4.4：不回显可疑进程的 pid / 路径。
        return Err(unverified(
            "管道对端与服务进程不一致（SCM 记录的进程不是它）".to_string(),
        ));
    }
    Ok(())
}

struct ScHandle(SC_HANDLE);

impl Drop for ScHandle {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe { CloseServiceHandle(self.0) };
        }
    }
}

fn connect_client(timeout: Duration) -> Result<Handle, IpcError> {
    let name = super::wide(super::PIPE_NAME);
    let deadline = Instant::now() + timeout;

    loop {
        let handle = unsafe {
            CreateFileW(
                name.as_ptr(),
                GENERIC_READ | GENERIC_WRITE,
                0,
                std::ptr::null(),
                OPEN_EXISTING,
                // overlapped：读/写都要能超时取消。
                FILE_FLAG_OVERLAPPED,
                std::ptr::null_mut(),
            )
        };
        if !handle.is_null() && handle != INVALID_HANDLE_VALUE {
            return Ok(Handle(handle));
        }

        let code = unsafe { GetLastError() };
        if code != windows_sys::Win32::Foundation::ERROR_PIPE_BUSY
            && code != windows_sys::Win32::Foundation::ERROR_FILE_NOT_FOUND
        {
            return Err(IpcError::Unavailable(format!(
                "打开 {} 失败（Win32 {code}）；服务可能没有安装或没有权限",
                super::PIPE_NAME
            )));
        }

        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(IpcError::Unavailable(format!(
                "等待 {} 超时（Win32 {code}）",
                super::PIPE_NAME
            )));
        }
        let wait = remaining.as_millis().min(200) as u32;
        unsafe { WaitNamedPipeW(name.as_ptr(), wait) };
    }
}

fn to_millis(duration: Duration) -> u32 {
    duration.as_millis().min(u32::MAX as u128) as u32
}

fn timed_out(write: bool, budget: Duration) -> io::Error {
    let what = if write {
        "整条请求"
    } else {
        "整条回复"
    };
    io::Error::new(
        io::ErrorKind::TimedOut,
        format!("{what}超过 {} ms 未完成", budget.as_millis()),
    )
}

/// 以 overlapped 方式读写的客户端句柄。
///
/// **整条请求 / 整条回复各只有一个 deadline**：`write_deadline` 在构造时定为
/// now + 5s，`read_deadline` 为 now + 所选常量（status/stop 10s，start 30s）。
/// 每次分块 I/O 只等剩余时间；服务端慢速滴字节不会把总时长拖过契约上限。
struct ClientIo {
    handle: HANDLE,
    event: HANDLE,
    write_deadline: Instant,
    write_budget: Duration,
    read_deadline: Instant,
    read_budget: Duration,
}

impl ClientIo {
    fn new(handle: HANDLE, write_budget: Duration, read_budget: Duration) -> io::Result<Self> {
        let event = unsafe { CreateEventW(std::ptr::null(), 0, 0, std::ptr::null()) };
        if event.is_null() {
            return Err(io::Error::other(format!(
                "创建事件失败（Win32 {}）",
                unsafe { GetLastError() }
            )));
        }
        let now = Instant::now();
        Ok(Self {
            handle,
            event,
            write_deadline: now + write_budget,
            write_budget,
            read_deadline: now + read_budget,
            read_budget,
        })
    }

    fn read_bytes(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        self.transfer(buffer.as_mut_ptr(), buffer.len(), false)
    }

    fn write_bytes(&mut self, buffer: &[u8]) -> io::Result<usize> {
        self.transfer(buffer.as_ptr() as *mut u8, buffer.len(), true)
    }

    fn transfer(&mut self, pointer: *mut u8, size: usize, write: bool) -> io::Result<usize> {
        let (deadline, budget) = if write {
            (self.write_deadline, self.write_budget)
        } else {
            (self.read_deadline, self.read_budget)
        };
        if deadline.saturating_duration_since(Instant::now()).is_zero() {
            return Err(timed_out(write, budget));
        }
        let length = size.min(64 * 1024) as u32;
        let mut overlapped: OVERLAPPED = unsafe { std::mem::zeroed() };
        overlapped.hEvent = self.event;
        unsafe { ResetEvent(self.event) };

        let started = unsafe {
            if write {
                WriteFile(
                    self.handle,
                    pointer,
                    length,
                    std::ptr::null_mut(),
                    &mut overlapped,
                )
            } else {
                ReadFile(
                    self.handle,
                    pointer,
                    length,
                    std::ptr::null_mut(),
                    &mut overlapped,
                )
            }
        };

        if started == 0 {
            let code = unsafe { GetLastError() };
            if code != ERROR_IO_PENDING {
                if code == ERROR_BROKEN_PIPE
                    || code == ERROR_PIPE_NOT_CONNECTED
                    || code == ERROR_OPERATION_ABORTED
                {
                    return Ok(0);
                }
                return Err(io::Error::other(format!("管道 I/O 失败（Win32 {code}）")));
            }

            // 只等这条请求/回复剩余的时间，而不是重新等一整个 budget。
            let remaining = deadline.saturating_duration_since(Instant::now());
            let wait = unsafe { WaitForSingleObject(self.event, to_millis(remaining)) };
            if wait == WAIT_TIMEOUT {
                unsafe { CancelIoEx(self.handle, &overlapped) };
                let mut ignored = 0u32;
                unsafe { GetOverlappedResult(self.handle, &overlapped, &mut ignored, 1) };
                return Err(timed_out(write, budget));
            }
            if wait != WAIT_OBJECT_0 {
                return Err(io::Error::other(format!(
                    "等待管道 I/O 失败（wait={wait}）"
                )));
            }
        }

        let mut transferred = 0u32;
        if unsafe { GetOverlappedResult(self.handle, &overlapped, &mut transferred, 0) } == 0 {
            let code = unsafe { GetLastError() };
            if code == ERROR_BROKEN_PIPE
                || code == ERROR_PIPE_NOT_CONNECTED
                || code == ERROR_OPERATION_ABORTED
            {
                return Ok(0);
            }
            return Err(io::Error::other(format!(
                "取得管道 I/O 结果失败（Win32 {code}）"
            )));
        }
        Ok(transferred as usize)
    }
}

impl Read for ClientIo {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        self.read_bytes(buffer)
    }
}

impl Write for ClientIo {
    fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
        self.write_bytes(buffer)
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

impl Drop for ClientIo {
    fn drop(&mut self) {
        if !self.event.is_null() {
            unsafe { CloseHandle(self.event) };
        }
    }
}

// ---------------------------------------------------------------------------
// 服务端
// ---------------------------------------------------------------------------

/// 在注册 SCM 控制回调**之前**调用。`serve` 自己不再重置：否则
/// 「服务已报 RUNNING / 回调已注册 → 收到 STOP → serve 把标志清掉」会丢停止请求。
pub fn reset_stop() {
    STOP.store(false, Ordering::SeqCst);
}

/// 让阻塞中的 `ConnectNamedPipe` / `ReadFile` 返回，服务控制回调调用。
///
/// 单次 `CancelIoEx` 会和「服务端刚检查完 stop、还没发起下一次阻塞调用」
/// 撞上：取消的是空气，随后 `ConnectNamedPipe` 照样阻塞。SCM 的停止请求
/// 允许几秒，这里在 2 秒内重复取消，覆盖那个窗口。
pub fn request_stop() {
    STOP.store(true, Ordering::SeqCst);
    for _ in 0..40 {
        let raw = CURRENT_PIPE.load(Ordering::SeqCst);
        if raw == 0 {
            return;
        }
        unsafe { CancelIoEx(raw as HANDLE, std::ptr::null()) };
        std::thread::sleep(Duration::from_millis(50));
    }
}

/// 建立唯一一条管道实例并循环服务。单线程：一次一个客户端。
pub fn serve<F>(log: Arc<ServiceLog>, dispatch: F) -> Result<(), String>
where
    F: Fn(&Request) -> Response,
{
    let listener = Listener::new(&log)?;
    let pipe = listener.create_pipe()?;
    CURRENT_PIPE.store(pipe.raw() as usize, Ordering::SeqCst);
    log.info(format!("命名管道已就绪：{}", super::PIPE_NAME));

    while !STOP.load(Ordering::SeqCst) {
        match connect_server(&pipe) {
            Ok(()) => {}
            Err(code) if code == windows_sys::Win32::Foundation::ERROR_OPERATION_ABORTED => break,
            Err(code) => {
                log.error(format!("等待客户端失败（Win32 {code}）"));
                std::thread::sleep(Duration::from_millis(200));
                continue;
            }
        }

        if STOP.load(Ordering::SeqCst) {
            break;
        }

        // **先验对端，后读消息。** 校验失败不碰请求体。
        match peer::verify(pipe.raw()) {
            Ok(peer) => {
                if let Some(reason) = &peer.signature.debug_relaxation {
                    log.warn(format!(
                        "对端校验放宽：{reason}（pid={} image={}）",
                        peer.pid, peer.image
                    ));
                }
                log.info(format!(
                    "接受客户端 pid={} image={} 签名={} / {}",
                    peer.pid, peer.image, peer.signature.subject, peer.signature.thumbprint
                ));
                // `peer` 持有客户端进程句柄到会话结束，防止 pid 在验证后被复用。
                if let Err(error) = session(&pipe, &log, &dispatch, &peer) {
                    log.warn(format!("连接结束：{error}"));
                }
            }
            Err(error) => log.warn(format!("拒绝客户端：{error}")),
        }

        unsafe { DisconnectNamedPipe(pipe.raw()) };
    }

    CURRENT_PIPE.store(0, Ordering::SeqCst);
    log.info("命名管道已停止");
    Ok(())
}

fn connect_server(pipe: &Handle) -> Result<(), u32> {
    let ok = unsafe { ConnectNamedPipe(pipe.raw(), std::ptr::null_mut()) };
    if ok != 0 {
        return Ok(());
    }
    let code = unsafe { GetLastError() };
    // 客户端在 CreateNamedPipe 与 ConnectNamedPipe 之间连上了，这是正常的。
    if code == windows_sys::Win32::Foundation::ERROR_PIPE_CONNECTED {
        Ok(())
    } else {
        Err(code)
    }
}

/// 一次连接只处理一条请求：读一帧 → 分发 → 回一帧 → 由调用方断开。
/// 契约 §1.1：没有长连接、没有请求 ID；首帧有超时，避免「连上不发包」锁死唯一实例。
fn session<F>(
    pipe: &Handle,
    log: &ServiceLog,
    dispatch: &F,
    _peer: &peer::PeerSession,
) -> Result<(), String>
where
    F: Fn(&Request) -> Response,
{
    if STOP.load(Ordering::SeqCst) {
        return Ok(());
    }

    let frame = match read_first_frame(pipe) {
        Ok(frame) => frame,
        Err(error) if error.kind() == io::ErrorKind::TimedOut => {
            log.warn(format!("断开连接：{error}"));
            return Ok(());
        }
        Err(error) if is_disconnect(&error) => return Ok(()),
        Err(error) => return Err(format!("读取请求失败：{error}")),
    };

    let response = match ipc::parse_request(&frame) {
        Ok(request) => dispatch(&request),
        Err(error) => Response::error("bad_request", error),
    };

    let mut io = PipeIo(pipe.raw());
    let body = serde_json::to_vec(&response).map_err(|error| error.to_string())?;
    ipc::write_frame(&mut io, &body).map_err(|error| format!("写回复失败：{error}"))?;
    Ok(())
}

/// 服务端首帧读取超时。
///
/// 服务端管道是**同步句柄**，`CancelIoEx(handle, &overlapped)` 不适用（overlapped
/// 只对以 `FILE_FLAG_OVERLAPPED` 打开的句柄有效）。这里用 `CancelSynchronousIo`
/// 只取消**本读线程**上挂起的同步 I/O，不会误伤同一句柄上的回复写；
/// `CancelIoEx(handle, NULL)` 仅作为拿不到线程句柄时的兜底。
/// 定时线程在 `read_frame` 返回前 join；回复写发生在 join 之后，且取消只作用于
/// 读线程——该句柄此刻只做首帧读，不会误伤回复写。
fn read_first_frame(pipe: &Handle) -> io::Result<Vec<u8>> {
    let thread = ThreadHandle(unsafe { OpenThread(THREAD_TERMINATE, 0, GetCurrentThreadId()) });
    if thread.0.is_null() {
        // 拿不到线程句柄就无法精确取消；宁可拒绝这根连接，也不在没有超时的情况下读。
        return Err(io::Error::other(format!(
            "无法打开当前线程句柄以设置首帧超时（Win32 {}）",
            unsafe { GetLastError() }
        )));
    }
    let thread_raw = thread.0 as usize;

    let done = Arc::new(AtomicBool::new(false));
    let flag = done.clone();
    let timer = std::thread::spawn(move || {
        let deadline = Instant::now() + TUN_FIRST_FRAME_TIMEOUT;
        while Instant::now() < deadline {
            if flag.load(Ordering::SeqCst) {
                return false;
            }
            std::thread::sleep(Duration::from_millis(25));
        }
        if flag.load(Ordering::SeqCst) {
            return false;
        }

        // 到期后重复取消：覆盖「读完 4 字节 header、下一次 ReadFile 还没发起」
        // 的窗口。只作用在读线程上，最多多等 2 秒。
        let grace = Instant::now() + Duration::from_secs(2);
        loop {
            // 一旦开始取消，读线程返回时就按超时处理。
            if flag.load(Ordering::SeqCst) {
                return true;
            }
            unsafe { CancelSynchronousIo(thread_raw as HANDLE) };
            if Instant::now() >= grace {
                return true;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
    });

    let mut io = PipeIo(pipe.raw());
    let result = ipc::read_frame(&mut io);
    done.store(true, Ordering::SeqCst);
    let timed_out = timer.join().unwrap_or(false);
    drop(thread);

    match result {
        // 读已完成时以结果为准：定时线程可能刚好在边界上启动取消。
        Ok(frame) => Ok(frame),
        Err(_) if timed_out => Err(io::Error::new(
            io::ErrorKind::TimedOut,
            format!(
                "客户端 {} ms 内没有发送请求",
                TUN_FIRST_FRAME_TIMEOUT.as_millis()
            ),
        )),
        Err(error) => Err(error),
    }
}

struct ThreadHandle(HANDLE);

impl Drop for ThreadHandle {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe { CloseHandle(self.0) };
        }
    }
}

fn is_disconnect(error: &io::Error) -> bool {
    matches!(
        error.kind(),
        io::ErrorKind::UnexpectedEof
            | io::ErrorKind::BrokenPipe
            | io::ErrorKind::ConnectionReset
            | io::ErrorKind::ConnectionAborted
    )
}

// ---------------------------------------------------------------------------
// 管道与安全描述符
// ---------------------------------------------------------------------------

struct SecurityDescriptor(*mut core::ffi::c_void);

impl Drop for SecurityDescriptor {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe { LocalFree(self.0) };
        }
    }
}

unsafe impl Send for SecurityDescriptor {}
unsafe impl Sync for SecurityDescriptor {}

struct Listener {
    _descriptor: SecurityDescriptor,
    attributes: SECURITY_ATTRIBUTES,
}

impl Listener {
    fn new(log: &ServiceLog) -> Result<Self, String> {
        let sddl = security_descriptor_sddl(log);
        let sddl_wide = super::wide(&sddl);
        let mut descriptor: *mut core::ffi::c_void = std::ptr::null_mut();
        let ok = unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                sddl_wide.as_ptr(),
                SDDL_REVISION_1,
                &mut descriptor,
                std::ptr::null_mut(),
            )
        };
        if ok == 0 {
            return Err(format!("构造管道安全描述符失败（Win32 {}）", unsafe {
                GetLastError()
            }));
        }

        let attributes = SECURITY_ATTRIBUTES {
            nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: descriptor,
            bInheritHandle: 0,
        };
        Ok(Self {
            _descriptor: SecurityDescriptor(descriptor),
            attributes,
        })
    }

    fn create_pipe(&self) -> Result<Handle, String> {
        let name = super::wide(super::PIPE_NAME);
        let handle = unsafe {
            CreateNamedPipeW(
                name.as_ptr(),
                PIPE_ACCESS_DUPLEX | FILE_FLAG_FIRST_PIPE_INSTANCE,
                PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
                1,
                BUFFER_BYTES,
                BUFFER_BYTES,
                0,
                &self.attributes,
            )
        };
        if handle == INVALID_HANDLE_VALUE {
            let code = unsafe { GetLastError() };
            return Err(format!(
                "创建命名管道 {} 失败（Win32 {code}）；同名管道可能已被其他进程占用",
                super::PIPE_NAME
            ));
        }
        Ok(Handle(handle))
    }
}

/// DACL：SYSTEM + Administrators + 当前控制台用户。远程客户端由
/// `PIPE_REJECT_REMOTE_CLIENTS` 拒绝。
///
/// **真正的安全边界是 Authenticode 签名 + 管道 ACL，不是客户端路径。**
/// 多用户限制：本机任意用户只要运行的是我们签名过的 Veyl 客户端都能连
/// （与 macOS 的信任模型一致）；同一时刻只允许一条 TUN。
///
/// 取不到控制台用户时退回 `IU`（已登录的交互用户）只是**可用性兜底，
/// 不是权限边界**：服务可能在用户登录前启动，准入仍由签名决定。
/// 若安全评审要求 fail-closed，可改为登录前不创建管道，而不是放宽 ACL。
fn security_descriptor_sddl(log: &ServiceLog) -> String {
    match interactive_user_sid() {
        Some(sid) => format!("D:P(A;;GA;;;SY)(A;;GA;;;BA)(A;;GA;;;{sid})"),
        None => {
            log.warn("取不到当前控制台用户 SID（服务可能早于登录启动），管道 ACL 退回 INTERACTIVE");
            "D:P(A;;GA;;;SY)(A;;GA;;;BA)(A;;GA;;;IU)".to_string()
        }
    }
}

fn interactive_user_sid() -> Option<String> {
    let session = unsafe { WTSGetActiveConsoleSessionId() };
    if session == u32::MAX {
        return None;
    }

    let mut token: HANDLE = std::ptr::null_mut();
    if unsafe { WTSQueryUserToken(session, &mut token) } == 0 {
        return None;
    }
    let token = TokenHandle(token);

    let mut size = 0u32;
    unsafe { GetTokenInformation(token.0, TokenUser, std::ptr::null_mut(), 0, &mut size) };
    if size == 0 {
        return None;
    }

    // `TOKEN_USER` 含指针，缓冲区必须按对齐单位分配，不能拿 Vec<u8> 硬转。
    let words = (size as usize).div_ceil(std::mem::size_of::<usize>());
    let mut buffer = vec![0usize; words];
    let ok = unsafe {
        GetTokenInformation(
            token.0,
            TokenUser,
            buffer.as_mut_ptr() as *mut core::ffi::c_void,
            size,
            &mut size,
        )
    };
    if ok == 0 {
        return None;
    }

    // SAFETY: GetTokenInformation(TokenUser) 填的是 TOKEN_USER，长度已由系统给出。
    let user = unsafe { &*(buffer.as_ptr() as *const TOKEN_USER) };
    if user.User.Sid.is_null() {
        return None;
    }

    let mut text: *mut u16 = std::ptr::null_mut();
    if unsafe { ConvertSidToStringSidW(user.User.Sid, &mut text) } == 0 {
        return None;
    }
    let mut length = 0usize;
    // ConvertSidToStringSidW 返回的是以 NUL 结尾、刚好这么长的分配。
    while unsafe { *text.add(length) } != 0 {
        length += 1;
        if length > 512 {
            break;
        }
    }
    let value = super::from_wide(unsafe { std::slice::from_raw_parts(text, length) });
    unsafe { LocalFree(text as *mut core::ffi::c_void) };
    Some(value)
}

struct TokenHandle(HANDLE);

impl Drop for TokenHandle {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe { CloseHandle(self.0) };
        }
    }
}

// ---------------------------------------------------------------------------
// 句柄上的读写
// ---------------------------------------------------------------------------

struct PipeIo(HANDLE);

impl Read for PipeIo {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        let length = buffer.len().min(64 * 1024) as u32;
        let mut read = 0u32;
        let ok: BOOL = unsafe {
            ReadFile(
                self.0,
                buffer.as_mut_ptr(),
                length,
                &mut read,
                std::ptr::null_mut(),
            )
        };
        if ok == 0 {
            let code = unsafe { GetLastError() };
            // 停止服务时 CancelIoEx 会让阻塞读返回 OPERATION_ABORTED。
            if code == windows_sys::Win32::Foundation::ERROR_BROKEN_PIPE
                || code == windows_sys::Win32::Foundation::ERROR_PIPE_NOT_CONNECTED
                || code == windows_sys::Win32::Foundation::ERROR_OPERATION_ABORTED
            {
                return Ok(0);
            }
            return Err(io::Error::other(format!("ReadFile 失败（Win32 {code}）")));
        }
        Ok(read as usize)
    }
}

impl Write for PipeIo {
    fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
        let length = buffer.len().min(64 * 1024) as u32;
        let mut written = 0u32;
        let ok = unsafe {
            WriteFile(
                self.0,
                buffer.as_ptr(),
                length,
                &mut written,
                std::ptr::null_mut(),
            )
        };
        if ok == 0 {
            let code = unsafe { GetLastError() };
            if code == windows_sys::Win32::Foundation::ERROR_BROKEN_PIPE
                || code == windows_sys::Win32::Foundation::ERROR_PIPE_NOT_CONNECTED
            {
                return Err(io::Error::new(io::ErrorKind::BrokenPipe, "对端已断开"));
            }
            return Err(io::Error::other(format!("WriteFile 失败（Win32 {code}）")));
        }
        Ok(written as usize)
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}
