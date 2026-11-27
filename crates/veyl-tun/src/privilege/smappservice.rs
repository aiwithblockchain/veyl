//! `SMAppService` 实现（macOS 13+）。
//!
//! 需要**签名并打包**的 .app：daemon plist 放在
//! `Veyl.app/Contents/Library/LaunchDaemons/`，helper 与 App 同一个 Team ID 签名。
//!
//! `status()` 的 `.notFound` 表示「系统注册库里还没有这个服务」，**不是**
//! 「bundle 里没有 plist」。注册前、以及 `tauri dev` 出来的未签名二进制上，
//! 这个值都是正常的；只有 `register()` 真的失败才说明装不上。

use objc2::rc::Retained;
use objc2::runtime::AnyClass;
use objc2_foundation::{NSBundle, NSString};
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

        ensure_registered_with(
            map_status(unsafe { service.status() }),
            || {
                unsafe { service.registerAndReturnError() }
                    .map_err(|error| error.localizedDescription().to_string())
            },
            || map_status(unsafe { service.status() }),
            open_login_items,
        )
    }

    fn unregister(&self) -> Result<(), PrivilegeError> {
        let Some(service) = service() else {
            return Ok(());
        };
        // 先看状态：压根没注册、或 bundle 里没有 plist，卸载就是幂等成功。
        // 不能只靠错误文案——系统语言一变，`not found` 还认不认得出来全靠运气。
        if matches!(
            map_status(unsafe { service.status() }),
            HelperStatus::NotFound | HelperStatus::NotRegistered
        ) {
            return Ok(());
        }

        match unsafe { service.unregisterAndReturnError() } {
            Ok(()) => Ok(()),
            Err(error) => {
                // 失败后状态已经不在了：并发卸载或状态滞后，对调用方同样是成功。
                // Apple 没有为 SMAppServiceErrorDomain 公开错误码，状态才是主判据。
                if matches!(
                    map_status(unsafe { service.status() }),
                    HelperStatus::NotFound | HelperStatus::NotRegistered
                ) {
                    return Ok(());
                }
                let domain = error.domain().to_string();
                let text = error.localizedDescription().to_string();
                // 最后兜底：同域、且文案明确表示「没找到」。
                // 前两步都没有结论时才用，避免把真正的失败当成成功。
                if domain == "SMAppServiceErrorDomain"
                    && (text.contains("not found") || text.contains("JobNotFound"))
                {
                    return Ok(());
                }
                Err(PrivilegeError::new(
                    ERR_HELPER_INSTALL_FAILED,
                    "移除后台助手失败",
                )
                .with_detail(format!(
                    "{domain}:{}: {text}",
                    error.code()
                )))
            }
        }
    }
}

fn denied(message: &str) -> PrivilegeError {
    PrivilegeError::new(ERR_TUN_DENIED, message)
}

/// 注册分支的判定逻辑，与 Objective-C 运行时隔开，便于直接用伪造状态覆盖。
///
/// `NotFound` 与 `NotRegistered` **必须走同一条分支**。`.notFound` 的语义是
/// 「系统注册库里还没有这个服务」，不是「bundle 里没有 plist」：注册前即使
/// plist 放对了，`status()` 也常常返回 `.notFound`。把它当成「安装包里没有」
/// 会直接短路，`register()` 永远调不到，用户也永远看不到授权提示。
///
/// `register` 的 `Err` 是系统给的 `localizedDescription`；`recheck` 在注册之后
/// 重新读一次状态——注册前的结论不能复用。
fn ensure_registered_with(
    initial: HelperStatus,
    register: impl FnOnce() -> Result<(), String>,
    recheck: impl FnOnce() -> HelperStatus,
    open_settings: impl FnOnce(),
) -> Result<(), PrivilegeError> {
    match initial {
        HelperStatus::Enabled => Ok(()),
        HelperStatus::RequiresApproval => {
            open_settings();
            Err(denied(
                "需要你在「系统设置 › 登录项与扩展」里允许 Veyl 的后台助手",
            ))
        }
        HelperStatus::NotRegistered | HelperStatus::NotFound => {
            // 注册本身可能直接抛出，也可能注册成功但停在 RequiresApproval。
            if let Err(detail) = register() {
                return Err(PrivilegeError::new(
                    ERR_HELPER_INSTALL_FAILED,
                    "安装后台助手失败",
                )
                .with_detail(detail));
            }
            match recheck() {
                HelperStatus::Enabled => Ok(()),
                HelperStatus::RequiresApproval => {
                    open_settings();
                    Err(denied(
                        "需要在「系统设置 › 登录项与扩展」里允许 Veyl 的后台助手",
                    ))
                }
                // 注册返回成功但状态还是没变：系统拒绝了这份 plist（位置、
                // BundleProgram、签名），这仍然是安装问题，要带上当时的状态。
                other => Err(PrivilegeError::new(
                    ERR_HELPER_INSTALL_FAILED,
                    "后台助手安装后仍然不可用",
                )
                .with_detail(format!("注册后状态：{}", other.as_str()))),
            }
        }
        HelperStatus::Unsupported => Err(PrivilegeError::new(
            ERR_HELPER_MISSING,
            "这台机器上的系统版本不支持后台助手",
        )),
    }
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
pub(crate) fn open_login_items() {
    if AnyClass::get(c"SMAppService").is_none() {
        return;
    }
    unsafe { SMAppService::openSystemSettingsLoginItems() }
}

/// 当前进程的 main bundle 是不是一个 `.app`。
///
/// `daemonServiceWithPlistName` 按 main bundle 解析 daemon plist：裸二进制
/// （`npm run tauri dev` 出的 `target/debug/veyl`）没有 `.app` 外壳，系统找到的
/// 是另一个 bundle，`status()` 永远不会是 `Enabled`，`register()` 也装不上。
/// 这种情况下去系统设置点「允许」不会有用，必须先告诉用户换打包后的 App。
pub fn runs_in_app_bundle() -> bool {
    let bundle = NSBundle::mainBundle();
    let path = bundle.bundlePath();
    bundle_path_is_app(&path.to_string())
}

/// 判据单独拿出来，便于直接对路径单测。
pub fn bundle_path_is_app(path: &str) -> bool {
    path.trim_end_matches('/').ends_with(".app")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    /// 真机根因：`.notFound` 被当成「包里没有 plist」时，`register()` 永远调不到，
    /// 用户也永远看不到授权提示。
    #[test]
    fn not_found_still_goes_through_registration() {
        let registered = Cell::new(false);
        let result = ensure_registered_with(
            HelperStatus::NotFound,
            || {
                registered.set(true);
                Ok(())
            },
            || HelperStatus::Enabled,
            || panic!("注册成功后不该打开登录项"),
        );
        assert!(result.is_ok());
        assert!(registered.get(), "NotFound 必须走 register()");
    }

    /// 两个「还没注册」的状态走同一条分支，语义上不可分叉。
    #[test]
    fn not_registered_follows_the_same_branch() {
        let registered = Cell::new(false);
        assert!(ensure_registered_with(
            HelperStatus::NotRegistered,
            || {
                registered.set(true);
                Ok(())
            },
            || HelperStatus::Enabled,
            || {}
        )
        .is_ok());
        assert!(registered.get());
    }

    /// 注册真的失败时，报安装失败并带上系统给的原因，
    /// 不能再退回「安装包里没有找到后台助手」——那句话是错的。
    #[test]
    fn a_failed_registration_reports_the_system_error() {
        let error = ensure_registered_with(
            HelperStatus::NotFound,
            || Err("Operation not permitted".to_string()),
            || panic!("注册失败后不该再读状态"),
            || panic!("注册失败不该打开登录项"),
        )
        .unwrap_err();
        assert_eq!(error.code, ERR_HELPER_INSTALL_FAILED);
        assert_eq!(error.detail.as_deref(), Some("Operation not permitted"));
        assert!(!error.message.contains("安装包里没有"));
    }

    /// 注册成功但停在审批态：打开登录项，返回 `tun_denied` 让用户去点允许。
    #[test]
    fn approval_after_registration_sends_the_user_to_login_items() {
        let opened = Cell::new(false);
        let error = ensure_registered_with(
            HelperStatus::NotFound,
            || Ok(()),
            || HelperStatus::RequiresApproval,
            || opened.set(true),
        )
        .unwrap_err();
        assert_eq!(error.code, ERR_TUN_DENIED);
        assert!(opened.get());
    }

    /// 注册返回成功但状态没变：系统拒绝了这份 plist，算安装失败。
    #[test]
    fn a_registration_that_leaves_the_status_unchanged_is_an_install_failure() {
        let error = ensure_registered_with(
            HelperStatus::NotFound,
            || Ok(()),
            || HelperStatus::NotFound,
            || {},
        )
        .unwrap_err();
        assert_eq!(error.code, ERR_HELPER_INSTALL_FAILED);
        assert!(
            error.detail.as_deref().unwrap_or("").contains("not_found"),
            "{:?}",
            error.detail
        );
    }

    #[test]
    fn an_enabled_helper_is_never_registered_again() {
        assert!(ensure_registered_with(
            HelperStatus::Enabled,
            || panic!("已启用时不该重复注册"),
            || panic!("已启用时不该再读状态"),
            || panic!("已启用时不该打开登录项"),
        )
        .is_ok());
    }

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

    /// 打包后的 App 才注册得上 daemon；裸二进制必须被认出来。
    #[test]
    fn only_an_app_bundle_counts_as_packaged() {
        assert!(bundle_path_is_app("/Applications/Veyl.app"));
        assert!(bundle_path_is_app("/Applications/Veyl.app/"));
        assert!(bundle_path_is_app("/Users/x/build/Veyl.app"));
        assert!(!bundle_path_is_app(
            "/Users/x/ai/veyl/src-tauri/target/debug"
        ));
        assert!(!bundle_path_is_app(
            "/Users/x/ai/veyl/src-tauri/target/debug/veyl"
        ));
    }

    /// 测试进程本身就是裸二进制：真实检测必须返回「未打包」。
    #[test]
    fn the_test_binary_runs_outside_an_app_bundle() {
        assert!(!runs_in_app_bundle());
    }
}
