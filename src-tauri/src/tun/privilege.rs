//! TUN 的提权层：只负责「helper 有没有被系统注册并批准」。
//!
//! 通道本身在 `tun::xpc`（XPC + 对端验签），这里不再有控制文件，
//! 也不再有「用管理员弹窗直接拉进程」的调试通道——那会是一个绕过验签的入口。

use std::sync::Arc;

/// 错误码，与 `docs/tun-mode.md` §8 对齐。
pub const ERR_HELPER_MISSING: &str = "helper_missing";
pub const ERR_HELPER_INSTALL_FAILED: &str = "helper_install_failed";
pub const ERR_TUN_DENIED: &str = "tun_denied";
pub const ERR_TUN_START_FAILED: &str = "tun_start_failed";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HelperStatus {
    NotRegistered,
    RequiresApproval,
    Enabled,
    NotFound,
    Unsupported,
}

impl HelperStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            HelperStatus::NotRegistered => "not_registered",
            HelperStatus::RequiresApproval => "requires_approval",
            HelperStatus::Enabled => "enabled",
            HelperStatus::NotFound => "not_found",
            HelperStatus::Unsupported => "unsupported",
        }
    }

    pub fn is_ready(&self) -> bool {
        matches!(self, HelperStatus::Enabled)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PrivilegeError {
    pub code: &'static str,
    pub message: String,
    pub detail: Option<String>,
}

impl PrivilegeError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            detail: None,
        }
    }

    pub fn with_detail(mut self, detail: impl Into<String>) -> Self {
        self.detail = Some(detail.into());
        self
    }

    /// 权限类失败**不是**网络故障（`docs/tun-mode.md` §8）。
    pub fn is_permission_problem(&self) -> bool {
        matches!(
            self.code,
            ERR_HELPER_MISSING | ERR_HELPER_INSTALL_FAILED | ERR_TUN_DENIED
        )
    }
}

impl std::fmt::Display for PrivilegeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}

impl std::error::Error for PrivilegeError {}

pub trait Registration: Send + Sync {
    fn kind(&self) -> &'static str;
    fn status(&self) -> HelperStatus;
    /// 注册并等待用户批准。用户拒绝时是 `tun_denied`，只给重试。
    fn ensure_registered(&self) -> Result<(), PrivilegeError>;
    /// 卸载路径专用。
    fn unregister(&self) -> Result<(), PrivilegeError>;
}

pub fn select() -> Arc<dyn Registration> {
    #[cfg(target_os = "macos")]
    {
        Arc::new(smappservice::SmAppService)
    }
    #[cfg(not(target_os = "macos"))]
    {
        Arc::new(Unsupported)
    }
}

/// 把用户送到能点「允许」的那一页。
///
/// 首次连接返回 `tun_denied` / `requires_approval` 时，界面调用这个入口，
/// 用户批准后**原地重试连接**即可——重新调用连接命令会再走一次
/// `ensure_registered()`，没有任何状态会挡住第二次。
pub fn open_login_items() {
    #[cfg(target_os = "macos")]
    smappservice::open_login_items();
}

/// 注销后台助手。App 内的「卸载助手」入口调用这里。
///
/// 没注册过也算成功（幂等）；真正的失败返回 `helper_install_failed`。
pub fn unregister_helper() -> Result<(), PrivilegeError> {
    select().unregister()
}

#[cfg(not(target_os = "macos"))]
pub struct Unsupported;

#[cfg(not(target_os = "macos"))]
impl Registration for Unsupported {
    fn kind(&self) -> &'static str {
        "unsupported"
    }
    fn status(&self) -> HelperStatus {
        HelperStatus::Unsupported
    }
    fn ensure_registered(&self) -> Result<(), PrivilegeError> {
        Err(PrivilegeError::new(
            ERR_HELPER_MISSING,
            "这个平台上还不支持接管全部流量",
        ))
    }
    fn unregister(&self) -> Result<(), PrivilegeError> {
        Ok(())
    }
}

/// App 不在 `/Applications` 时，LaunchDaemon 的开机自举不保证。
/// 这不是错误，但必须在失败时告诉用户，而不是让他对着 `helper_missing` 猜。
pub fn app_location_hint() -> Option<String> {
    let exe = std::env::current_exe().ok()?;
    if exe.starts_with("/Applications/") {
        None
    } else {
        Some("把 Veyl 拖到「应用程序」文件夹后，接管全部流量才能用".into())
    }
}

#[cfg(target_os = "macos")]
pub mod smappservice;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_enabled_counts_as_ready() {
        assert!(HelperStatus::Enabled.is_ready());
        assert!(!HelperStatus::RequiresApproval.is_ready());
        assert!(!HelperStatus::NotRegistered.is_ready());
        assert!(!HelperStatus::NotFound.is_ready());
        assert!(!HelperStatus::Unsupported.is_ready());
    }

    #[test]
    fn permission_errors_are_not_reported_as_network_problems() {
        for code in [ERR_HELPER_MISSING, ERR_HELPER_INSTALL_FAILED, ERR_TUN_DENIED] {
            assert!(PrivilegeError::new(code, "x").is_permission_problem());
        }
        assert!(!PrivilegeError::new(ERR_TUN_START_FAILED, "x").is_permission_problem());
    }

    #[test]
    fn the_location_hint_fires_outside_applications() {
        // 测试二进制在 target/ 下，必然不是 /Applications。
        let hint = app_location_hint().expect("测试运行时不在 /Applications");
        assert!(hint.contains("应用程序"));
    }
}
