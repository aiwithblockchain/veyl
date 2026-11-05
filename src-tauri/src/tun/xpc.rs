//! libxpc 的最小绑定，主程序与 helper 共用（helper 用 `#[path]` 引入）。
//!
//! 只用公开 C API：`xpc_connection_*`、`xpc_dictionary_*`、`xpc_get_type`。
//! 对端身份校验在 helper 侧用 Security.framework 做，不在这里。

#![allow(non_camel_case_types)]

use std::ffi::{c_char, c_void, CStr, CString};

pub type xpc_object_t = *mut c_void;
pub type xpc_connection_t = *mut c_void;
type dispatch_queue_t = *mut c_void;

pub const XPC_CONNECTION_MACH_SERVICE_LISTENER: u64 = 1 << 0;

// libxpc 的符号由 libSystem 再导出；SDK 里没有独立的 libxpc.tbd，
// 直接 -lxpc 会链接失败。
#[link(name = "System")]
extern "C" {
    fn xpc_connection_create_mach_service(
        name: *const c_char,
        targetq: dispatch_queue_t,
        flags: u64,
    ) -> xpc_connection_t;
    fn xpc_connection_resume(connection: xpc_connection_t);
    fn xpc_connection_cancel(connection: xpc_connection_t);
    fn xpc_connection_get_pid(connection: xpc_connection_t) -> libc::pid_t;
    fn xpc_connection_set_event_handler(
        connection: xpc_connection_t,
        handler: *mut c_void,
    );
    fn xpc_connection_set_peer_code_signing_requirement(
        connection: xpc_connection_t,
        requirement: *const c_char,
    ) -> i32;

    fn xpc_dictionary_create(
        keys: *const *const c_char,
        values: *const xpc_object_t,
        count: usize,
    ) -> xpc_object_t;
    fn xpc_dictionary_set_string(
        dictionary: xpc_object_t,
        key: *const c_char,
        value: *const c_char,
    );
    fn xpc_dictionary_set_data(
        dictionary: xpc_object_t,
        key: *const c_char,
        bytes: *const c_void,
        length: usize,
    );
    fn xpc_dictionary_set_int64(dictionary: xpc_object_t, key: *const c_char, value: i64);
    fn xpc_dictionary_set_bool(dictionary: xpc_object_t, key: *const c_char, value: bool);
    fn xpc_dictionary_set_value(
        dictionary: xpc_object_t,
        key: *const c_char,
        value: xpc_object_t,
    );
    fn xpc_dictionary_get_string(dictionary: xpc_object_t, key: *const c_char) -> *const c_char;
    fn xpc_dictionary_get_int64(dictionary: xpc_object_t, key: *const c_char) -> i64;
    fn xpc_dictionary_get_bool(dictionary: xpc_object_t, key: *const c_char) -> bool;
    fn xpc_dictionary_get_data(
        dictionary: xpc_object_t,
        key: *const c_char,
        length: *mut usize,
    ) -> *const c_void;
    fn xpc_dictionary_create_reply(original: xpc_object_t) -> xpc_object_t;

    fn xpc_get_type(object: xpc_object_t) -> *const c_void;
    fn xpc_retain(object: xpc_object_t) -> xpc_object_t;
    fn xpc_release(object: xpc_object_t);
    fn xpc_copy_description(object: xpc_object_t) -> *mut c_char;

    fn xpc_connection_send_message_with_reply(
        connection: xpc_connection_t,
        message: xpc_object_t,
        queue: dispatch_queue_t,
        handler: *mut c_void,
    );
}

// 全局并发队列：异步回复的 handler 在那上面跑，不占主线程。
extern "C" {
    fn dispatch_get_global_queue(identifier: isize, flags: usize) -> dispatch_queue_t;
}

// `XPC_TYPE_ERROR` 的符号地址。用它判断「回的不是字典而是一个错误对象」。
extern "C" {
    static _xpc_type_error: c_void;
    static _xpc_type_dictionary: c_void;
    /// 连接被中断（对端重启/被杀），与「服务不存在」是两回事。
    static _xpc_error_connection_interrupted: xpc_object_t;
}

///
/// # Safety
/// 传入的指针必须来自对应的 libxpc 创建函数，且在本调用期间保持有效。
pub unsafe fn is_error(object: xpc_object_t) -> bool {
    // SAFETY: 这两个都是 libxpc 导出的类型标记常量，只比较地址。
    unsafe { std::ptr::eq(xpc_get_type(object), &_xpc_type_error as *const c_void) }
}

///
/// # Safety
/// 传入的指针必须来自对应的 libxpc 创建函数，且在本调用期间保持有效。
pub unsafe fn is_dictionary(object: xpc_object_t) -> bool {
    unsafe { std::ptr::eq(xpc_get_type(object), &_xpc_type_dictionary as *const c_void) }
}

///
/// # Safety
/// 传入的指针必须来自对应的 libxpc 创建函数，且在本调用期间保持有效。
pub unsafe fn describe(object: xpc_object_t) -> String {
    unsafe {
        let text = xpc_copy_description(object);
        if text.is_null() {
            return String::new();
        }
        let value = CStr::from_ptr(text).to_string_lossy().to_string();
        libc::free(text as *mut c_void);
        value
    }
}

///
/// # Safety
/// 传入的指针必须来自对应的 libxpc 创建函数，且在本调用期间保持有效。
pub unsafe fn release(object: xpc_object_t) {
    if !object.is_null() {
        unsafe { xpc_release(object) };
    }
}

fn cstring(value: &str) -> CString {
    CString::new(value).unwrap_or_else(|_| CString::new("").unwrap())
}

// ---------------------------------------------------------------------------
// 客户端
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum XpcError {
    /// 连不上：没注册、没批准、被 launchd 拒。对用户就是「助手不可用」。
    Unavailable(String),
    /// helper 正常回了，但拒绝了这次请求。
    Server { code: String, message: String },
    /// 回了看不懂的东西。
    Protocol(String),
    /// 连接被中断：对端重启、被杀，或传输层断开。
    Interrupted(String),
    /// 在契约给的等待上限内没收到回复（`tun-backend.md` §1.3）。
    Timeout,
}

impl std::fmt::Display for XpcError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            XpcError::Unavailable(message) => write!(f, "无法连接特权助手：{message}"),
            XpcError::Server { code, message } => write!(f, "{code}: {message}"),
            XpcError::Protocol(message) => write!(f, "助手返回了无法识别的回复：{message}"),
            XpcError::Interrupted(message) => write!(f, "与特权助手的连接中断：{message}"),
            XpcError::Timeout => write!(f, "特权助手没有在限定时间内回复"),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Reply {
    Started {
        pid: u32,
        clash_addr: String,
        clash_secret: String,
        /// 特权侧生成的启动时刻（契约 §3.1）。
        since: String,
    },
    Stopped,
    Status {
        running: bool,
        pid: Option<u32>,
        /// 未运行时为 None（契约 §3.2：字段存在，值为 null）。
        clash_addr: Option<String>,
        clash_secret: Option<String>,
        since: Option<String>,
    },
}

/// 回复指针跨线程传递的包装。
///
/// SAFETY: 指针只在 handler 与等待方之间传一次；libxpc 对象由 `xpc_retain`
/// 保持在这次交互期间有效，且同一时刻只有一个线程使用它。
struct SendPtr(xpc_object_t);
unsafe impl Send for SendPtr {}

impl SendPtr {
    /// 取出指针并交出所有权；之后的 `Drop` 不再释放。
    fn take(mut self) -> xpc_object_t {
        let ptr = self.0;
        self.0 = std::ptr::null_mut();
        ptr
    }
}

impl Drop for SendPtr {
    /// 等待方超时放弃后，handler 仍可能投递成功；那条路径必须把 retain 的
    /// 引用还回去，否则每超时一次漏一个 XPC 对象。
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe { release(self.0) };
        }
    }
}

/// 发一条请求并等回复，**最多等 `timeout`**。
///
/// libxpc 的同步接口没有超时参数：helper 不回复时 `send_message_with_reply_sync`
/// 会一直阻塞。契约 §1.3 要求两端都有超时，所以这里改用异步回复 + 带超时的通道
/// 等待；到点就取消连接并返回 `XpcError::Timeout`，不留悬挂的等待者。
///
/// 通道断开（handler 没送达就没了）也按 `Protocol` 处理——那是传输层问题，
/// 不是 helper 的拒绝。
pub fn call_with_timeout(
    service: &str,
    method: &str,
    config: Option<&[u8]>,
    timeout: std::time::Duration,
) -> Result<Reply, XpcError> {
    use block2::RcBlock;
    use std::sync::mpsc::{channel, RecvTimeoutError};

    let service = cstring(service);
    log::debug!("xpc call method={method} service={}", service.to_string_lossy());
    // SAFETY: 连接句柄的生命周期由本函数管理；消息与回复都是 libxpc 对象，
    // 出错路径上也会 release。
    unsafe {
        let connection = xpc_connection_create_mach_service(service.as_ptr(), std::ptr::null_mut(), 0);
        if connection.is_null() {
            return Err(XpcError::Unavailable("无法创建到特权助手的连接".into()));
        }

        // **resume 之前必须装事件处理器**：libxpc 在 resume 时若发现没有处理器，
        // 会调 `_xpc_api_misuse` 直接 `brk`，整个进程 SIGTRAP 退出——
        // 一个可选功能的探测把 App 打死。实测复现过，不是理论风险。
        install_noop_handler(connection);
        xpc_connection_resume(connection);

        let message = xpc_dictionary_create(std::ptr::null(), std::ptr::null(), 0);
        let method_key = cstring("method");
        xpc_dictionary_set_string(message, method_key.as_ptr(), cstring(method).as_ptr());
        if let Some(bytes) = config {
            xpc_dictionary_set_data(
                message,
                cstring("config").as_ptr(),
                bytes.as_ptr() as *const c_void,
                bytes.len(),
            );
        }

        let (sender, receiver) = channel::<SendPtr>();
        let handler = RcBlock::new(move |reply: xpc_object_t| {
            let retained = if reply.is_null() {
                std::ptr::null_mut()
            } else {
                xpc_retain(reply)
            };
            // 等待方已经超时放弃时，send 会失败，SendPtr 在 drop 里把引用还回去。
            let _ = sender.send(SendPtr(retained));
        });

        // libxpc 会复制 handler 并在回复到达时调用；send 返回后我们这份可以释放。
        xpc_connection_send_message_with_reply(
            connection,
            message,
            dispatch_get_global_queue(0, 0),
            RcBlock::as_ptr(&handler) as *mut c_void,
        );
        drop(handler);
        xpc_release(message);

        let reply = match receiver.recv_timeout(timeout) {
            Ok(sent) => sent.take(),
            Err(RecvTimeoutError::Timeout) => {
                // 放弃等待：取消连接，之后即使 handler 被调用也会投递失败并释放回复。
                xpc_connection_cancel(connection);
                xpc_release(connection);
                return Err(XpcError::Timeout);
            }
            Err(RecvTimeoutError::Disconnected) => {
                xpc_connection_cancel(connection);
                xpc_release(connection);
                return Err(XpcError::Protocol("回复通道提前断开".into()));
            }
        };

        xpc_connection_cancel(connection);
        // create_* 出来的对象由我们持有，cancel 之后释放；不释放就是每次调用漏一个。
        xpc_release(connection);

        if reply.is_null() {
            return Err(XpcError::Protocol("助手返回了空回复".into()));
        }
        let result = parse_reply(&service, method, reply);
        xpc_release(reply);
        result
    }
}

fn parse_reply(service: &CString, method: &str, reply: xpc_object_t) -> Result<Reply, XpcError> {
    let _ = service;
    if reply.is_null() {
        return Err(XpcError::Unavailable(
            "助手没有回复（可能没有注册或被系统拒绝）".into(),
        ));
    }
    if unsafe { is_error(reply) } {
        // 「连接被中断」说明 helper 还在（或刚退出），是传输层问题；
        // 「连接无效」通常是没有注册/没批准。两者对用户的含义不同，不能合并。
        if reply == unsafe { _xpc_error_connection_interrupted } {
            return Err(XpcError::Interrupted(unsafe { describe(reply) }));
        }
        return Err(XpcError::Unavailable(unsafe { describe(reply) }));
    }
    if !unsafe { is_dictionary(reply) } {
        return Err(XpcError::Protocol(unsafe { describe(reply) }));
    }

    let ok = unsafe { xpc_dictionary_get_bool(reply, cstring("ok").as_ptr()) };
    if !ok {
        let code = get_string(reply, "code").unwrap_or_else(|| "unknown".into());
        let message = get_string(reply, "message").unwrap_or_default();
        return Err(XpcError::Server { code, message });
    }

    match method {
        "start" => Ok(Reply::Started {
            pid: get_i64(reply, "pid").unwrap_or(0) as u32,
            clash_addr: get_string(reply, "clash_addr").unwrap_or_default(),
            clash_secret: get_string(reply, "clash_secret").unwrap_or_default(),
            since: get_string(reply, "since").unwrap_or_default(),
        }),
        "stop" => Ok(Reply::Stopped),
        "status" => {
            let running = unsafe { xpc_dictionary_get_bool(reply, cstring("running").as_ptr()) };
            // 未运行时 helper 不写这三项；按契约给 None，不留空串冒充有效值。
            let text = |key: &str| {
                if running {
                    get_string(reply, key).filter(|value| !value.is_empty())
                } else {
                    None
                }
            };
            Ok(Reply::Status {
                running,
                pid: if running {
                    get_i64(reply, "pid").filter(|pid| *pid > 0).map(|pid| pid as u32)
                } else {
                    None
                },
                clash_addr: text("clash_addr"),
                clash_secret: text("clash_secret"),
                since: text("since"),
            })
        }
        other => Err(XpcError::Protocol(format!("未知方法 {other}"))),
    }
}

fn get_string(dict: xpc_object_t, key: &str) -> Option<String> {
    unsafe {
        let value = xpc_dictionary_get_string(dict, cstring(key).as_ptr());
        if value.is_null() {
            None
        } else {
            Some(CStr::from_ptr(value).to_string_lossy().to_string())
        }
    }
}

fn get_i64(dict: xpc_object_t, key: &str) -> Option<i64> {
    unsafe { Some(xpc_dictionary_get_int64(dict, cstring(key).as_ptr())) }
}

// ---------------------------------------------------------------------------
// 服务端基础件（helper 用）
// ---------------------------------------------------------------------------

/// 装一个什么都不做的事件处理器。
///
/// 它不是「为了收事件」，而是 `xpc_connection_resume` 的前置条件：
/// 缺了它 libxpc 会判定 API 误用并直接让进程 trap。
fn install_noop_handler(connection: xpc_connection_t) {
    unsafe { xpc_connection_set_event_handler(connection, noop_handler_ptr()) };
}

/// 整个进程共用一个空处理器。
///
/// 以前每次 `call()` 都新建一个再 `mem::forget`——连接释放了，block 却永远留着，
/// 调用多少次就漏多少份。现在只创建一次，与进程同寿。
fn noop_handler_ptr() -> *mut c_void {
    use block2::RcBlock;
    use std::sync::OnceLock;

    static POINTER: OnceLock<usize> = OnceLock::new();
    *POINTER.get_or_init(|| {
        let handler: RcBlock<dyn Fn(xpc_object_t)> = RcBlock::new(|_event: xpc_object_t| {});
        let raw = RcBlock::as_ptr(&handler) as *mut c_void;
        // 这一份是刻意的：libxpc 在连接存续期间会引用它，不能提前释放。
        std::mem::forget(handler);
        raw as usize
    }) as *mut c_void
}

pub fn create_listener(service: &str) -> xpc_connection_t {
    let name = cstring(service);
    unsafe {
        xpc_connection_create_mach_service(
            name.as_ptr(),
            std::ptr::null_mut(),
            XPC_CONNECTION_MACH_SERVICE_LISTENER,
        )
    }
}

///
/// # Safety
/// 传入的指针必须来自对应的 libxpc 创建函数，且在本调用期间保持有效。
pub unsafe fn connection_pid(connection: xpc_connection_t) -> u32 {
    unsafe { xpc_connection_get_pid(connection) as u32 }
}

///
/// # Safety
/// 传入的指针必须来自对应的 libxpc 创建函数，且在本调用期间保持有效。
pub unsafe fn resume(connection: xpc_connection_t) {
    unsafe { xpc_connection_resume(connection) };
}

///
/// # Safety
/// 传入的指针必须来自对应的 libxpc 创建函数，且在本调用期间保持有效。
pub unsafe fn cancel(connection: xpc_connection_t) {
    unsafe { xpc_connection_cancel(connection) };
}

///
/// # Safety
/// 传入的指针必须来自对应的 libxpc 创建函数，且在本调用期间保持有效。
pub unsafe fn set_event_handler(connection: xpc_connection_t, handler: *mut c_void) {
    unsafe { xpc_connection_set_event_handler(connection, handler) };
}

/// 让 libxpc 在**连接建立时**就按 requirement 校验对端。
///
/// 用它替掉「取 pid 之后再 SecCodeCheckValidity」：后者在两步之间有窗口，
/// 而且要求被验证方自己提供 pid 作为依据。返回 0 表示 requirement 字符串合法。
///
/// # Safety
/// 传入的指针必须来自对应的 libxpc 创建函数，且在本调用期间保持有效。
pub unsafe fn set_peer_code_signing_requirement(
    connection: xpc_connection_t,
    requirement: &str,
) -> Result<(), String> {
    let requirement = CString::new(requirement).map_err(|_| "requirement 含空字节".to_string())?;
    let status = unsafe {
        xpc_connection_set_peer_code_signing_requirement(connection, requirement.as_ptr())
    };
    if status == 0 {
        Ok(())
    } else {
        Err(format!("设置对端签名要求失败：{status}"))
    }
}

pub fn dict_create() -> xpc_object_t {
    unsafe { xpc_dictionary_create(std::ptr::null(), std::ptr::null(), 0) }
}

///
/// # Safety
/// 传入的指针必须来自对应的 libxpc 创建函数，且在本调用期间保持有效。
pub unsafe fn dict_set_bool(dict: xpc_object_t, key: &str, value: bool) {
    unsafe { xpc_dictionary_set_bool(dict, cstring(key).as_ptr(), value) };
}

///
/// # Safety
/// 传入的指针必须来自对应的 libxpc 创建函数，且在本调用期间保持有效。
pub unsafe fn dict_set_int64(dict: xpc_object_t, key: &str, value: i64) {
    unsafe { xpc_dictionary_set_int64(dict, cstring(key).as_ptr(), value) };
}

///
/// # Safety
/// 传入的指针必须来自对应的 libxpc 创建函数，且在本调用期间保持有效。
pub unsafe fn dict_set_string(dict: xpc_object_t, key: &str, value: &str) {
    unsafe { xpc_dictionary_set_string(dict, cstring(key).as_ptr(), cstring(value).as_ptr()) };
}

///
/// # Safety
/// 传入的指针必须来自对应的 libxpc 创建函数，且在本调用期间保持有效。
pub unsafe fn dict_get_string(dict: xpc_object_t, key: &str) -> Option<String> {
    get_string(dict, key)
}

///
/// # Safety
/// 传入的指针必须来自对应的 libxpc 创建函数，且在本调用期间保持有效。
pub unsafe fn dict_get_data(dict: xpc_object_t, key: &str) -> Option<Vec<u8>> {
    unsafe {
        let mut length: usize = 0;
        let pointer = xpc_dictionary_get_data(dict, cstring(key).as_ptr(), &mut length);
        if pointer.is_null() {
            return None;
        }
        Some(std::slice::from_raw_parts(pointer as *const u8, length).to_vec())
    }
}

///
/// # Safety
/// 传入的指针必须来自对应的 libxpc 创建函数，且在本调用期间保持有效。
pub unsafe fn make_reply(original: xpc_object_t) -> xpc_object_t {
    unsafe { xpc_dictionary_create_reply(original) }
}

/// 把回复发回对端连接。调用后由我们释放 reply。
///
/// # Safety
/// 传入的指针必须来自对应的 libxpc 创建函数，且在本调用期间保持有效。
pub unsafe fn send_message(connection: xpc_connection_t, message: xpc_object_t) {
    extern "C" {
        fn xpc_connection_send_message(connection: xpc_connection_t, message: xpc_object_t);
    }
    unsafe { xpc_connection_send_message(connection, message) };
}

///
/// # Safety
/// 传入的指针必须来自对应的 libxpc 创建函数，且在本调用期间保持有效。
pub unsafe fn set_value(dict: xpc_object_t, key: &str, value: xpc_object_t) {
    unsafe { xpc_dictionary_set_value(dict, cstring(key).as_ptr(), value) };
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, Instant};

    /// 不存在的 Mach service：必须很快报 `Unavailable`，而不是把调用方挂住。
    /// 这条覆盖的是异步回复 + 超时等待的基本路径。
    #[test]
    fn a_missing_service_fails_fast_instead_of_blocking() {
        let start = Instant::now();
        let result = call_with_timeout(
            "com.veyl.helper.nonexistent.test",
            "status",
            None,
            Duration::from_secs(2),
        );
        assert!(
            matches!(&result, Err(XpcError::Unavailable(_))),
            "应当报 Unavailable，实际 {result:?}"
        );
        assert!(
            start.elapsed() < Duration::from_secs(2),
            "不该等到超时才返回：{:?}",
            start.elapsed()
        );
    }

    fn status_dict(running: bool, pid: i64, extra: bool) -> xpc_object_t {
        unsafe {
            let dict = xpc_dictionary_create(std::ptr::null(), std::ptr::null(), 0);
            dict_set_bool(dict, "ok", true);
            dict_set_bool(dict, "running", running);
            dict_set_int64(dict, "pid", pid);
            if extra {
                dict_set_string(dict, "clash_addr", "127.0.0.1:50000");
                dict_set_string(dict, "clash_secret", "s3cret");
                dict_set_string(dict, "since", "2026-11-05T00:00:00Z");
            }
            dict
        }
    }

    /// 契约 §3.2：运行中的 status 必须带回 clash 地址与启动时刻。
    #[test]
    fn a_running_status_reply_carries_clash_and_since() {
        unsafe {
            let dict = status_dict(true, 123, true);
            let parsed = parse_reply(&cstring("svc"), "status", dict).unwrap();
            release(dict);
            assert_eq!(
                parsed,
                Reply::Status {
                    running: true,
                    pid: Some(123),
                    clash_addr: Some("127.0.0.1:50000".into()),
                    clash_secret: Some("s3cret".into()),
                    since: Some("2026-11-05T00:00:00Z".into()),
                }
            );
        }
    }

    /// 未运行时这三项是 None，不能用空串冒充有效值。
    #[test]
    fn a_stopped_status_reply_has_no_clash_fields() {
        unsafe {
            let dict = status_dict(false, 0, false);
            let parsed = parse_reply(&cstring("svc"), "status", dict).unwrap();
            release(dict);
            assert_eq!(
                parsed,
                Reply::Status {
                    running: false,
                    pid: None,
                    clash_addr: None,
                    clash_secret: None,
                    since: None,
                }
            );
        }
    }

    /// start 回复里的 `since` 来自特权侧（契约 §3.1）。
    #[test]
    fn a_start_reply_carries_the_privileged_start_time() {
        unsafe {
            let dict = xpc_dictionary_create(std::ptr::null(), std::ptr::null(), 0);
            dict_set_bool(dict, "ok", true);
            dict_set_int64(dict, "pid", 9);
            dict_set_string(dict, "clash_addr", "127.0.0.1:50001");
            dict_set_string(dict, "clash_secret", "s");
            dict_set_string(dict, "since", "2026-11-05T01:02:03Z");
            let parsed = parse_reply(&cstring("svc"), "start", dict).unwrap();
            release(dict);
            assert_eq!(
                parsed,
                Reply::Started {
                    pid: 9,
                    clash_addr: "127.0.0.1:50001".into(),
                    clash_secret: "s".into(),
                    since: "2026-11-05T01:02:03Z".into(),
                }
            );
        }
    }
}
