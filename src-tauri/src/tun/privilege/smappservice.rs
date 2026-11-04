//! `SMAppService` 实现（macOS 13+）。
//!
//! 需要**签名并打包**的 .app：daemon plist 放在
//! `Veyl.app/Contents/Library/LaunchDaemons/`，helper 与 App 同一个 Team ID 签名。
//! `tauri dev` 出来的未签名二进制上，`status()` 会返回 `NotFound`——
//! 这是预期行为，不是 bug。

use objc2::rc::Retained;
use objc2::runtime::AnyClass;
use objc2_foundation::NSString;
use objc2_service_management::{SMAppService, SMAppServiceStatus};

use super::{
    HelperStatus, PrivilegeError, Registration, ERR_HELPER_INSTALL_FAILED, ERR_HELPER_MISSING,
    ERR_TUN_DENIED,
};

/// 必须与打包进 `Contents/Library/LaunchDaemons/` 的文件名一致。
pub const DAEMON_PLIST: &str = "com.veyl.helper.plist";

pub struct SmAppService;

impl Registration for SmAppService {
    fn kind(&self) -> &'static str {
        "smappservice"
    }

    fn status(&self) -> HelperStatus {
        match service() {
            Some(service) => map_status(unsafe { service.status() }),
            None => HelperStatus::Unsupported,
        }
    }

    fn ensure_registered(&self) -> Result<(), PrivilegeError> {
        let Some(service) = service() else {
            return Err(PrivilegeError::new(
                ERR_HELPER_MISSING,
                "这台机器上的系统版本不支持后台助手，无法接管全部流量",
            )
            .with_detail("SMAppService 需要 macOS 13 或更高"));
        };

        match map_status(unsafe { service.status() }) {
            HelperStatus::Enabled => Ok(()),
            HelperStatus::RequiresApproval => {
                open_login_items();
                Err(denied(
                    "需要你在「系统设置 › 登录项与扩展」里允许 Veyl 的后台助手",
                ))
            }
            HelperStatus::NotRegistered => {
                // 注册本身可能直接抛出，也可能注册成功但停在 RequiresApproval。
                if let Err(error) = unsafe { service.registerAndReturnError() } {
                    return Err(PrivilegeError::new(
                        ERR_HELPER_INSTALL_FAILED,
                        "安装后台助手失败",
                    )
                    .with_detail(error.localizedDescription().to_string()));
                }
                match map_status(unsafe { service.status() }) {
                    HelperStatus::Enabled => Ok(()),
                    HelperStatus::RequiresApproval => {
                        open_login_items();
                        Err(denied(
                            "需要在「系统设置 › 登录项与扩展」里允许 Veyl 的后台助手",
                        ))
                    }
                    other => Err(PrivilegeError::new(
                        ERR_HELPER_MISSING,
                        "后台助手安装后仍然不可用",
                    )
                    .with_detail(other.as_str())),
                }
            }
            HelperStatus::NotFound => Err(PrivilegeError::new(
                ERR_HELPER_MISSING,
                "安装包里没有找到后台助手",
            )
            .with_detail(DAEMON_PLIST)),
            HelperStatus::Unsupported => Err(PrivilegeError::new(
                ERR_HELPER_MISSING,
                "这台机器上的系统版本不支持后台助手",
            )),
        }
    }

    fn unregister(&self) -> Result<(), PrivilegeError> {
        let Some(service) = service() else {
            return Ok(());
        };
        match unsafe { service.unregisterAndReturnError() } {
            Ok(()) => Ok(()),
            // 本来就没注册：卸载时这是成功，不是错误。
            Err(error) => {
                let text = error.localizedDescription().to_string();
                if text.contains("not found") || text.contains("JobNotFound") {
                    Ok(())
                } else {
                    Err(PrivilegeError::new(
                        ERR_HELPER_INSTALL_FAILED,
                        "移除后台助手失败",
                    )
                    .with_detail(text))
                }
            }
        }
    }
}

fn denied(message: &str) -> PrivilegeError {
    PrivilegeError::new(ERR_TUN_DENIED, message)
}

/// 类不存在＝系统版本低于 13。直接在 nil 上发消息是 UB，所以必须先查。
fn service() -> Option<Retained<SMAppService>> {
    AnyClass::get(c"SMAppService")?;
    let name = NSString::from_str(DAEMON_PLIST);
    Some(unsafe { SMAppService::daemonServiceWithPlistName(&name) })
}

fn map_status(status: SMAppServiceStatus) -> HelperStatus {
    match status {
        SMAppServiceStatus::Enabled => HelperStatus::Enabled,
        SMAppServiceStatus::RequiresApproval => HelperStatus::RequiresApproval,
        SMAppServiceStatus::NotFound => HelperStatus::NotFound,
        SMAppServiceStatus::NotRegistered => HelperStatus::NotRegistered,
        _ => HelperStatus::Unsupported,
    }
}

/// 把用户送到能点「允许」的那一页。
fn open_login_items() {
    if AnyClass::get(c"SMAppService").is_none() {
        return;
    }
    unsafe { SMAppService::openSystemSettingsLoginItems() }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_mapping_covers_every_constant() {
        assert_eq!(map_status(SMAppServiceStatus::Enabled), HelperStatus::Enabled);
        assert_eq!(
            map_status(SMAppServiceStatus::RequiresApproval),
            HelperStatus::RequiresApproval
        );
        assert_eq!(
            map_status(SMAppServiceStatus::NotFound),
            HelperStatus::NotFound
        );
        assert_eq!(
            map_status(SMAppServiceStatus::NotRegistered),
            HelperStatus::NotRegistered
        );
        assert_eq!(map_status(SMAppServiceStatus(99)), HelperStatus::Unsupported);
    }

    /// 未签名、未打包的构建里拿到的一定不是 `Enabled`。
    /// 这条同时证明「查询本身不会崩」——在 `tauri dev` 的二进制上真跑过。
    #[test]
    fn querying_status_outside_a_signed_bundle_is_safe() {
        let status = SmAppService.status();
        eprintln!("SMAppService status = {}", status.as_str());
        assert!(
            !status.is_ready(),
            "没打包没签名时不该报 ready，实际是 {}",
            status.as_str()
        );
    }

    #[test]
    fn kind_is_stable() {
        assert_eq!(SmAppService.kind(), "smappservice");
    }
}
