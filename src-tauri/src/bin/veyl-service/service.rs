//! 进程入口：SCM 服务、控制台开发模式、命令行客户端。
//!
//! 正式服务的启动由 SCM 完成（不带参数）。`--console` 与 `--client`
//! 只是开发/验证入口，走的是同一条管道和同一套对端校验，没有额外特权通道。
//! `--client` 只在 debug 构建存在，不进入发布二进制的命令行面。

use std::ffi::c_void;
use std::sync::atomic::{AtomicU32, AtomicUsize, Ordering};
use std::sync::Arc;

use windows_sys::core::PWSTR;
use windows_sys::Win32::Foundation::{
    GetLastError, ERROR_FAILED_SERVICE_CONTROLLER_CONNECT, ERROR_SERVICE_SPECIFIC_ERROR,
    ERROR_SUCCESS,
};
use windows_sys::Win32::System::LibraryLoader::{
    SetDefaultDllDirectories, LOAD_LIBRARY_SEARCH_APPLICATION_DIR, LOAD_LIBRARY_SEARCH_SYSTEM32,
};
use windows_sys::Win32::System::Services::{
    RegisterServiceCtrlHandlerExW, SetServiceStatus, StartServiceCtrlDispatcherW,
    SERVICE_ACCEPT_SHUTDOWN, SERVICE_ACCEPT_STOP, SERVICE_CONTROL_INTERROGATE,
    SERVICE_CONTROL_SHUTDOWN, SERVICE_CONTROL_STOP, SERVICE_RUNNING, SERVICE_START_PENDING,
    SERVICE_STATUS, SERVICE_STATUS_HANDLE, SERVICE_STOPPED, SERVICE_STOP_PENDING,
    SERVICE_TABLE_ENTRYW, SERVICE_WIN32_OWN_PROCESS,
};

use super::server;
#[cfg(debug_assertions)]
use super::win::ipc::Request;
use super::win::log::ServiceLog;
use super::win::pipe;

static STATUS_HANDLE: AtomicUsize = AtomicUsize::new(0);
static CURRENT_STATE: AtomicU32 = AtomicU32::new(SERVICE_STOPPED);

pub fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("--console") => run_console(),
        #[cfg(debug_assertions)]
        Some("--client") => run_client(&args[1..]),
        #[cfg(not(debug_assertions))]
        Some("--client") => {
            eprintln!("release 构建不提供 --client；客户端工具只在 debug 构建可用");
            std::process::exit(2);
        }
        Some("--help") | Some("-h") => print_help(),
        Some("--service") | None => run_service(),
        Some(other) => {
            eprintln!("未知参数：{other}");
            print_help();
            std::process::exit(2);
        }
    }
}

fn print_help() {
    println!(
        "veyl-service — Veyl Windows 特权服务\n\
         \n\
         用法：\n\
           veyl-service                          由 SCM 启动（LocalSystem）\n\
           veyl-service --console                前台运行，开发/验证用\n\
           veyl-service --help"
    );
    #[cfg(debug_assertions)]
    print_client_help();
}

/// release 构建里这个函数不存在，帮助文本也就不会列出 `--client`。
#[cfg(debug_assertions)]
fn print_client_help() {
    println!(
        "  veyl-service --client ping            仅 debug：探活\n\
         \x20 veyl-service --client status\n\
         \x20 veyl-service --client stop\n\
         \x20 veyl-service --client start <config.json>"
    );
}

// ---------------------------------------------------------------------------
// 开发模式
// ---------------------------------------------------------------------------

fn run_console() {
    // 先建/校验数据目录，再创建日志文件：否则日志目录会以默认继承 ACL 被创建，
    // 后面再收紧就晚了。普通用户跑 --console 会在这里直接失败。
    if let Err(error) = super::win::acl::ensure_data_layout(&super::win::program_data_dir()) {
        eprintln!("数据目录权限不合规：{error}");
        eprintln!("%ProgramData%\\Veyl 必须只允许 SYSTEM/Administrators 写");
        std::process::exit(1);
    }
    let log = Arc::new(ServiceLog::open(true));
    harden_process(&log);
    log.info(format!(
        "控制台模式启动，pid={}；管道 {}",
        std::process::id(),
        super::win::PIPE_NAME
    ));
    let server = Arc::new(server::Server::new(log.clone()));
    server.sweep_stale();
    pipe::reset_stop();

    let dispatch = server.clone();
    let rollback = server.clone();
    match pipe::serve(
        log.clone(),
        move |request| dispatch.dispatch(request),
        move |request| rollback.abort_started(request),
    ) {
        Ok(()) => {
            server.shutdown();
            log.info("控制台模式结束");
        }
        Err(error) => {
            server.shutdown();
            log.error(format!("无法启动：{error}"));
            std::process::exit(1);
        }
    }
}

#[cfg(debug_assertions)]
fn run_client(args: &[String]) {
    let request = match args.first().map(String::as_str) {
        #[cfg(debug_assertions)]
        Some("ping") => Request::Ping,
        #[cfg(not(debug_assertions))]
        Some("ping") => {
            eprintln!("release 构建不提供 --client ping；请用 --client status 探活");
            std::process::exit(2);
        }
        Some("status") => Request::Status,
        Some("stop") => Request::Stop,
        Some("start") => {
            let Some(path) = args.get(1) else {
                eprintln!("--client start 需要配置文件路径");
                std::process::exit(2);
            };
            let text = match std::fs::read_to_string(path) {
                Ok(text) => text,
                Err(error) => {
                    eprintln!("读取 {path} 失败：{error}");
                    std::process::exit(2);
                }
            };
            // 本地先校验一次 JSON，错误早点暴露；服务端仍然按契约重新校验。
            if let Err(error) = serde_json::from_str::<serde_json::Value>(&text) {
                eprintln!("{path} 不是合法 JSON：{error}");
                std::process::exit(2);
            }
            Request::Start { config: text }
        }
        other => {
            eprintln!("未知客户端命令：{:?}", other.unwrap_or_default());
            print_help();
            std::process::exit(2);
        }
    };

    match pipe::call(&request) {
        Ok(response) => {
            let text =
                serde_json::to_string_pretty(&response).unwrap_or_else(|_| format!("{response:?}"));
            println!("{text}");
            if !response.ok {
                std::process::exit(3);
            }
        }
        Err(error) => {
            eprintln!("{error}");
            std::process::exit(4);
        }
    }
}

// ---------------------------------------------------------------------------
// SCM 服务
// ---------------------------------------------------------------------------

fn run_service() {
    let name = super::win::wide(super::win::SERVICE_NAME);
    let mut table = [
        SERVICE_TABLE_ENTRYW {
            lpServiceName: name.as_ptr() as PWSTR,
            lpServiceProc: Some(service_main),
        },
        SERVICE_TABLE_ENTRYW {
            lpServiceName: std::ptr::null_mut(),
            lpServiceProc: None,
        },
    ];

    let ok = unsafe { StartServiceCtrlDispatcherW(table.as_mut_ptr()) };
    if ok == 0 {
        let code = unsafe { GetLastError() };
        if code == ERROR_FAILED_SERVICE_CONTROLLER_CONNECT {
            eprintln!(
                "veyl-service 不是由服务控制管理器启动。\n\
                 开发时用 `veyl-service --console`；安装服务见 scripts/windows/dev-install-service.ps1。"
            );
            std::process::exit(2);
        }
        eprintln!("StartServiceCtrlDispatcherW 失败（Win32 {code}）");
        std::process::exit(1);
    }
}

unsafe extern "system" fn service_main(_argc: u32, _argv: *mut PWSTR) {
    // 必须在注册控制回调之前清停止标志：回调一旦注册，STOP 可能随时到达。
    pipe::reset_stop();
    let name = super::win::wide(super::win::SERVICE_NAME);
    let handle = unsafe {
        RegisterServiceCtrlHandlerExW(
            name.as_ptr(),
            Some(control_handler),
            std::ptr::null::<c_void>(),
        )
    };
    if handle.is_null() {
        return;
    }
    STATUS_HANDLE.store(handle as usize, Ordering::SeqCst);

    report(SERVICE_START_PENDING, 0, 10_000);
    // 先建/校验数据目录，再创建日志文件：否则日志目录会以默认（可能宽松的）
    // 继承 ACL 被创建。staged 的 sing-box.exe 会从这里执行，这一步失败即拒绝启动。
    if let Err(error) = super::win::acl::ensure_data_layout(&super::win::program_data_dir()) {
        // 失败路径**不碰日志文件**：logs 可能是预置的软链，SYSTEM 会往目标追加。
        // SCM 收不到 stderr，但 `sc.exe query` 会显示服务没有起来，排障看事件日志。
        eprintln!("数据目录权限不合规：{error}");
        eprintln!("%ProgramData%\\Veyl 必须只允许 SYSTEM/Administrators 写；服务拒绝启动");
        report_failure();
        return;
    }
    let log = Arc::new(ServiceLog::open(false));
    log.info(format!("服务启动，pid={}", std::process::id()));
    harden_process(&log);

    // 上次崩溃留下的 sing-box 必须在对外服务之前收掉：它是一个还在接管流量、
    // 却没有任何客户端知道存在的进程。核对是 pid + 启动时间 + 镜像路径三重。
    let server = Arc::new(server::Server::new(log.clone()));
    server.sweep_stale();

    report(
        SERVICE_RUNNING,
        SERVICE_ACCEPT_STOP | SERVICE_ACCEPT_SHUTDOWN,
        0,
    );

    // 起不来就停服务并留下明确原因（例如同名管道被抢占）。
    // 不降级、不换名字——换名字等于把「先到先得」的窗口留给攻击者。
    let dispatch = server.clone();
    let rollback = server.clone();
    match pipe::serve(
        log.clone(),
        move |request| dispatch.dispatch(request),
        move |request| rollback.abort_started(request),
    ) {
        Ok(()) => {
            // STOP / SHUTDOWN 之后由这里收掉 sing-box；子进程不会随服务退出自动结束。
            server.shutdown();
            log.info("服务停止");
            report(SERVICE_STOPPED, 0, 0);
        }
        Err(error) => {
            server.shutdown();
            log.error(format!("服务无法启动：{error}"));
            log.warn("常见原因：同名管道已被别的进程创建，或安装目录/ACL 不完整");
            report_failure();
        }
    }
}

unsafe extern "system" fn control_handler(
    control: u32,
    _event_type: u32,
    _event_data: *mut c_void,
    _context: *mut c_void,
) -> u32 {
    match control {
        SERVICE_CONTROL_STOP | SERVICE_CONTROL_SHUTDOWN => {
            // 停止要等 sing-box 退出（最多 5 s），给 SCM 一个诚实的等待提示。
            report(SERVICE_STOP_PENDING, 0, 10_000);
            pipe::request_stop();
            ERROR_SUCCESS
        }
        SERVICE_CONTROL_INTERROGATE => {
            let state = CURRENT_STATE.load(Ordering::SeqCst);
            let accepted = if state == SERVICE_RUNNING {
                SERVICE_ACCEPT_STOP | SERVICE_ACCEPT_SHUTDOWN
            } else {
                0
            };
            report(state, accepted, 0);
            ERROR_SUCCESS
        }
        _ => ERROR_SUCCESS,
    }
}

fn report(state: u32, accepted: u32, wait_hint: u32) {
    CURRENT_STATE.store(state, Ordering::SeqCst);
    let handle = STATUS_HANDLE.load(Ordering::SeqCst) as SERVICE_STATUS_HANDLE;
    if handle.is_null() {
        return;
    }
    let status = SERVICE_STATUS {
        dwServiceType: SERVICE_WIN32_OWN_PROCESS,
        dwCurrentState: state,
        dwControlsAccepted: accepted,
        dwWin32ExitCode: ERROR_SUCCESS,
        dwServiceSpecificExitCode: 0,
        dwCheckPoint: 0,
        dwWaitHint: wait_hint,
    };
    unsafe { SetServiceStatus(handle, &status) };
}

fn report_failure() {
    CURRENT_STATE.store(SERVICE_STOPPED, Ordering::SeqCst);
    let handle = STATUS_HANDLE.load(Ordering::SeqCst) as SERVICE_STATUS_HANDLE;
    if handle.is_null() {
        return;
    }
    let status = SERVICE_STATUS {
        dwServiceType: SERVICE_WIN32_OWN_PROCESS,
        dwCurrentState: SERVICE_STOPPED,
        dwControlsAccepted: 0,
        dwWin32ExitCode: ERROR_SERVICE_SPECIFIC_ERROR,
        dwServiceSpecificExitCode: 1,
        dwCheckPoint: 0,
        dwWaitHint: 0,
    };
    unsafe { SetServiceStatus(handle, &status) };
}

/// 特权进程的加载面收口：DLL 只从 System32 与应用目录找，工作目录固定。
///
/// 契约 §5.4：路径白名单约束的是服务**自己执行或加载**的文件，不是客户端。
/// 这里先记录自身镜像是否位于安装目录；`sing-box.exe` 与 `wintun.dll`
/// 由 `win::runtime` 从安装目录 staging 到 `%ProgramData%`，并校验编译进
/// 二进制的哈希——那一段同样是「自己要读的文件」，走同一条规则。
fn harden_process(log: &ServiceLog) {
    unsafe {
        SetDefaultDllDirectories(
            LOAD_LIBRARY_SEARCH_SYSTEM32 | LOAD_LIBRARY_SEARCH_APPLICATION_DIR,
        );
    }

    let install = super::win::install_dir();
    if let Ok(exe) = std::env::current_exe() {
        log.info(format!(
            "服务镜像 {}（位于安装目录：{}）",
            exe.display(),
            super::win::path_within(&install, &exe)
        ));
    }

    let directory = if install.is_dir() {
        install
    } else {
        std::env::current_exe()
            .ok()
            .and_then(|path| path.parent().map(|parent| parent.to_path_buf()))
            .unwrap_or_else(|| std::path::PathBuf::from(r"C:\Windows\System32"))
    };

    match std::env::set_current_dir(&directory) {
        Ok(()) => log.info(format!("工作目录固定为 {}", directory.display())),
        Err(error) => log.warn(format!(
            "设置工作目录为 {} 失败：{error}",
            directory.display()
        )),
    }
}
