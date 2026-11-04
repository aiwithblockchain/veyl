//! TUN 连接的生命周期：确保 helper 已注册 → 通过 XPC 发 start → 拿 pid。
//!
//! 这里**不碰** `RuntimeManager`：TUN 的 sing-box 是 helper（root）的子进程，
//! 不是我们的子进程，manager 那套 Child 句柄的启停模型对它不适用。
//! 代价是 TUN 连接不参与 manager 的重连/看门狗，这一点在报告里写清楚。

use std::sync::{Arc, Mutex};

#[cfg(target_os = "macos")]
use std::sync::atomic::{AtomicBool, Ordering};

use super::privilege::{PrivilegeError, Registration, ERR_HELPER_MISSING};
#[cfg(target_os = "macos")]
use super::privilege::{app_location_hint, ERR_TUN_START_FAILED};
#[cfg(target_os = "macos")]
use super::protocol::MACH_SERVICE;
#[cfg(target_os = "macos")]
use super::xpc::{self, Reply, XpcError};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Started {
    pub pid: u32,
    pub clash_addr: String,
    pub clash_secret: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TunState {
    Stopped,
    Running { pid: u32 },
}

pub struct TunSession {
    registration: Arc<dyn Registration>,
    /// 上次成功 start 拿到的 pid。**刻意不每次读 XPC**：
    /// `runtime_status` 是热路径，同步 XPC 会把它拖慢。
    pid: Mutex<Option<u32>>,
    /// App 崩溃重启后 TUN 还活着，这时内存里没有 pid。
    /// 首次查状态时向 helper 问一次，之后不再重复。
    #[cfg(target_os = "macos")]
    probed: AtomicBool,
}

impl TunSession {
    pub fn new(registration: Arc<dyn Registration>) -> Self {
        Self {
            registration,
            pid: Mutex::new(None),
            #[cfg(target_os = "macos")]
            probed: AtomicBool::new(false),
        }
    }

    pub fn launcher_kind(&self) -> &'static str {
        self.registration.kind()
    }

    /// 起 TUN。顺序不可换：**先确认 helper 已被批准**再发请求，
    /// 否则连不上时用户只会看到一个无意义的超时。
    pub fn launch(&self, config: &str) -> Result<Started, PrivilegeError> {
        self.registration.ensure_registered()?;

        #[cfg(target_os = "macos")]
        {
            return match xpc::call(MACH_SERVICE, "start", Some(config.as_bytes())) {
                Ok(Reply::Started {
                    pid,
                    clash_addr,
                    clash_secret,
                }) => {
                    *self.pid.lock().unwrap() = Some(pid);
                    Ok(Started {
                        pid,
                        clash_addr,
                        clash_secret,
                    })
                }
                Ok(_) => Err(PrivilegeError::new(
                    ERR_TUN_START_FAILED,
                    "特权助手回了意料之外的结果",
                )),
                Err(error) => Err(map_xpc_error(error)),
            };
        }

        #[cfg(not(target_os = "macos"))]
        {
            let _ = config;
            Err(unsupported_platform())
        }
    }

    /// 幂等。本来就没起过时不发 XPC——否则每次断开代理连接都要等一次超时。
    pub fn stop(&self) -> Result<(), PrivilegeError> {
        if self.status() == TunState::Stopped {
            return Ok(());
        }
        #[cfg(target_os = "macos")]
        {
            let result = match xpc::call(MACH_SERVICE, "stop", None) {
                Ok(_) => Ok(()),
                Err(error) => Err(map_xpc_error(error)),
            };
            *self.pid.lock().unwrap() = None;
            return result;
        }
        #[cfg(not(target_os = "macos"))]
        {
            *self.pid.lock().unwrap() = None;
            Ok(())
        }
    }

    /// 热路径：只读内存里的 pid，不打 XPC。
    ///
    /// 但 App 崩溃重启后 TUN 可能还连着（helper 是独立进程），
    /// 这时内存里没有 pid——首次调用向 helper 问一次把它接手过来。
    pub fn status(&self) -> TunState {
        if let Some(pid) = *self.pid.lock().unwrap() {
            return TunState::Running { pid };
        }
        #[cfg(target_os = "macos")]
        {
            if self.probed.swap(true, Ordering::SeqCst) {
                return TunState::Stopped;
            }
            // helper 没被注册/批准时根本不碰 XPC。
            // `status()` 跑在启动路径上，可选功能的探测不该在那里制造任何风险。
            if !self.registration.status().is_ready() {
                return TunState::Stopped;
            }
            if let Ok(Reply::Status {
                running: true,
                pid: Some(pid),
            }) = xpc::call(MACH_SERVICE, "status", None)
            {
                *self.pid.lock().unwrap() = Some(pid);
                return TunState::Running { pid };
            }
        }
        TunState::Stopped
    }
}

#[cfg(not(target_os = "macos"))]
fn unsupported_platform() -> PrivilegeError {
    PrivilegeError::new(
        ERR_HELPER_MISSING,
        "这个平台还不支持接管全部流量，请改用代理模式",
    )
}

/// XPC 的失败翻译成用户能懂的两类：**助手不在**（权限/安装），
/// 和**助手在但拒绝了**（启动失败）。两者都不该被当成网络故障。
#[cfg(target_os = "macos")]
pub fn map_xpc_error(error: XpcError) -> PrivilegeError {
    match error {
        XpcError::Unavailable(detail) => {
            let mut message = String::from("连不上特权助手，接管全部流量需要它");
            if let Some(hint) = app_location_hint() {
                message.push_str(&format!("。{hint}"));
            }
            PrivilegeError::new(ERR_HELPER_MISSING, message).with_detail(detail)
        }
        XpcError::Server { code, message } => {
            PrivilegeError::new(ERR_TUN_START_FAILED, message).with_detail(code)
        }
        XpcError::Protocol(detail) => {
            PrivilegeError::new(ERR_TUN_START_FAILED, "特权助手返回了无法识别的回复")
                .with_detail(detail)
        }
    }
}

/// 断开 / 卸载前要做的网络恢复，**E3 以后直接调这个**（`capabilities.md` §3.1
/// 要求卸载清理与 E3 共用同一段代码）。
#[derive(Debug, Default, PartialEq, Eq)]
pub struct CleanupReport {
    pub stopped_tun: bool,
    pub stopped_runtime: bool,
    pub restored_proxy: bool,
    pub flushed_dns: bool,
    pub removed_configs: usize,
    pub failures: Vec<String>,
}

impl CleanupReport {
    pub fn is_clean(&self) -> bool {
        self.failures.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tun::privilege::{HelperStatus, ERR_TUN_DENIED};

    /// 假注册：不碰系统，只按剧本成功或拒绝。
    struct FakeRegistration {
        ready: bool,
    }

    impl Registration for FakeRegistration {
        fn kind(&self) -> &'static str {
            "fake"
        }
        fn status(&self) -> HelperStatus {
            HelperStatus::Enabled
        }
        fn ensure_registered(&self) -> Result<(), PrivilegeError> {
            if self.ready {
                Ok(())
            } else {
                Err(PrivilegeError::new(ERR_TUN_DENIED, "用户拒绝了"))
            }
        }
        fn unregister(&self) -> Result<(), PrivilegeError> {
            Ok(())
        }
    }

    #[test]
    fn a_rejected_registration_stops_before_any_xpc_call() {
        // 没被批准时 launch 必须立刻失败，而不是去连一个不存在的服务。
        let session = TunSession::new(Arc::new(FakeRegistration { ready: false }));
        let error = session.launch("{}").unwrap_err();
        assert_eq!(error.code, ERR_TUN_DENIED);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn unavailable_helper_is_reported_as_a_permission_problem() {
        let error = map_xpc_error(XpcError::Unavailable("connection invalid".into()));
        assert_eq!(error.code, ERR_HELPER_MISSING);
        assert!(error.is_permission_problem());
        // 测试环境不在 /Applications，提示必须带上。
        assert!(error.message.contains("应用程序"), "{}", error.message);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn a_server_rejection_is_a_start_failure_not_a_permission_problem() {
        let error = map_xpc_error(XpcError::Server {
            code: "config_forbidden".into(),
            message: "不允许远程引用".into(),
        });
        assert_eq!(error.code, ERR_TUN_START_FAILED);
        assert!(!error.is_permission_problem());
        assert_eq!(error.message, "不允许远程引用");
    }

    #[test]
    fn a_cleanup_report_is_clean_only_without_failures() {
        assert!(CleanupReport::default().is_clean());
        let mut report = CleanupReport::default();
        report.failures.push("还原系统代理失败".into());
        assert!(!report.is_clean());
    }
}
