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
    fn xpc_connection_send_message_with_reply_sync(
        connection: xpc_connection_t,
        message: xpc_object_t,
    ) -> xpc_object_t;
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
    fn xpc_release(object: xpc_object_t);
    fn xpc_copy_description(object: xpc_object_t) -> *mut c_char;
}

// `XPC_TYPE_ERROR` 的符号地址。用它判断「回的不是字典而是一个错误对象」。
extern "C" {
    static _xpc_type_error: c_void;
    static _xpc_type_dictionary: c_void;
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
}

impl std::fmt::Display for XpcError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            XpcError::Unavailable(message) => write!(f, "无法连接特权助手：{message}"),
            XpcError::Server { code, message } => write!(f, "{code}: {message}"),
            XpcError::Protocol(message) => write!(f, "助手返回了无法识别的回复：{message}"),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Reply {
    Started {
        pid: u32,
        clash_addr: String,
        clash_secret: String,
    },
    Stopped,
    Status {
        running: bool,
        pid: Option<u32>,
    },
}

/// 发一条请求并等回复。阻塞调用，调用方负责放到不会卡住 runtime 的地方。
pub fn call(
    service: &str,
    method: &str,
    config: Option<&[u8]>,
) -> Result<Reply, XpcError> {
    let service = cstring(service);
    log::info!("xpc call method={method} service={}", service.to_string_lossy());
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

        let reply = xpc_connection_send_message_with_reply_sync(connection, message);
        xpc_release(message);
        xpc_connection_cancel(connection);
        // create_* 出来的对象由我们持有，cancel 之后释放；不释放就是每次调用漏一个。
        xpc_release(connection);

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
        }),
        "stop" => Ok(Reply::Stopped),
        "status" => Ok(Reply::Status {
            running: unsafe { xpc_dictionary_get_bool(reply, cstring("running").as_ptr()) },
            pid: get_i64(reply, "pid").filter(|pid| *pid > 0).map(|pid| pid as u32),
        }),
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
    use block2::RcBlock;

    let handler: RcBlock<dyn Fn(xpc_object_t)> = RcBlock::new(|_event: xpc_object_t| {});
    let raw = RcBlock::as_ptr(&handler) as *mut c_void;
    // 处理器必须活得和连接一样久；由 libxpc 持有引用，这里不让它 drop。
    std::mem::forget(handler);
    unsafe { xpc_connection_set_event_handler(connection, raw) };
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
