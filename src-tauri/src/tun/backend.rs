//! 平台无关的 TUN 特权后端契约（`docs/contracts/tun-backend.md` v1.0.6）。
//!
//! 这里只有 `TunBackend` 与数据结构，**不含任何平台 API**。
//! 会话状态（`session.rs`）只依赖这一层；macOS 的实现是
//! `xpc::MacXpcBackend`，Windows 的实现由 `tun/windows/` 提供。
//!
//! 两条不能丢的语义：
//! - `start` 是**替换语义**（先停旧实例再起新的），绝不返回「已在运行」；
//! - `stop` 是**幂等**的，没在运行也返回成功。

use std::time::Duration;

use serde::{Deserialize, Serialize};

use super::privilege::{
    HelperStatus, PrivilegeError, ERR_HELPER_INSTALL_FAILED, ERR_HELPER_MISSING, ERR_TUN_DENIED,
    ERR_TUN_START_FAILED,
};

/// 客户端等 `status` / `stop` 回复的上限（契约 §1.3）。
pub const TUN_REPLY_DEADLINE_CONTROL: Duration = Duration::from_secs(10);

/// 客户端等 `start` 回复的上限。首次 start 可能要复制运行时并跑 check，给足时间。
pub const TUN_REPLY_DEADLINE_START: Duration = Duration::from_secs(30);

pub trait TunBackend: Send + Sync {
    /// 查特权组件的注册状态。纯查询，不触发任何系统弹窗。
    fn availability(&self) -> Result<HelperStatus, TunError>;

    /// 确保可用：必要时触发一次系统授权流程。**幂等**。
    fn ensure_available(&self) -> Result<HelperStatus, TunError>;

    /// 起 TUN。替换语义：已有实例先停再起。
    fn start(&self, config: &str) -> Result<StartReply, TunError>;

    /// 停 TUN。幂等：没在运行也返回成功。
    fn stop(&self) -> Result<(), TunError>;

    /// 读快照。随时可调，不改变状态；必须便宜（一次 IPC，不读大文件、不 spawn）。
    fn status(&self) -> Result<TunSnapshot, TunError>;
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ClashApi {
    /// `127.0.0.1:<port>`，端口只在 49152–65535。
    pub addr: String,
    /// 本次进程生命周期内有效的随机串。不得进日志。
    pub secret: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StartReply {
    pub pid: u32,
    pub clash_api: ClashApi,
    /// ISO 8601 UTC，由特权侧生成。
    pub since: String,
}

/// 字段恒存在，无值写 `null`——省略键会让 TS 消费方拿到 `undefined`。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TunSnapshot {
    pub running: bool,
    pub pid: Option<u32>,
    pub clash_api: Option<ClashApi>,
    pub since: Option<String>,
    pub last_error: Option<TunErrorRecord>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TunErrorRecord {
    pub code: TunErrorCode,
    pub message: String,
    pub at: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TunErrorCode {
    // ---- wire 码：特权侧 → 界面进程（§4.2） ----
    BadRequest,
    ConfigTooLarge,
    ConfigInvalid,
    ConfigForbidden,
    RuleSetMissing,
    RuntimeMissing,
    TunStartFailed,
    Internal,
    // ---- 权限层：由 `ensure_available` 产生，不跨线（§2、§4.3） ----
    TunDenied,
    HelperMissing,
    HelperInstallFailed,
    // ---- 本地错误：界面进程自己产生（§4.4） ----
    Timeout,
    PeerUnverified,
    TransportError,
    UnsupportedPlatform,
}

impl TunErrorCode {
    pub fn as_str(self) -> &'static str {
        match self {
            TunErrorCode::BadRequest => "bad_request",
            TunErrorCode::ConfigTooLarge => "config_too_large",
            TunErrorCode::ConfigInvalid => "config_invalid",
            TunErrorCode::ConfigForbidden => "config_forbidden",
            TunErrorCode::RuleSetMissing => "rule_set_missing",
            TunErrorCode::RuntimeMissing => "runtime_missing",
            TunErrorCode::TunStartFailed => "tun_start_failed",
            TunErrorCode::Internal => "internal",
            TunErrorCode::TunDenied => "tun_denied",
            TunErrorCode::HelperMissing => "helper_missing",
            TunErrorCode::HelperInstallFailed => "helper_install_failed",
            TunErrorCode::Timeout => "timeout",
            TunErrorCode::PeerUnverified => "peer_unverified",
            TunErrorCode::TransportError => "transport_error",
            TunErrorCode::UnsupportedPlatform => "unsupported_platform",
        }
    }

    /// 只有这八个是跨线传输的 wire 码；本地错误不得混进去（§4.4）。
    pub fn is_wire(self) -> bool {
        matches!(
            self,
            TunErrorCode::BadRequest
                | TunErrorCode::ConfigTooLarge
                | TunErrorCode::ConfigInvalid
                | TunErrorCode::ConfigForbidden
                | TunErrorCode::RuleSetMissing
                | TunErrorCode::RuntimeMissing
                | TunErrorCode::TunStartFailed
                | TunErrorCode::Internal
        )
    }

    /// 特权侧回的字符串码翻回枚举；不认识的按 `tun_start_failed` 处理，
    /// 但原串仍会写进 `details.wire_code`，不丢诊断信息。
    pub fn from_wire(value: &str) -> Option<Self> {
        Some(match value {
            "bad_request" => TunErrorCode::BadRequest,
            "config_too_large" => TunErrorCode::ConfigTooLarge,
            "config_invalid" => TunErrorCode::ConfigInvalid,
            "config_forbidden" => TunErrorCode::ConfigForbidden,
            "rule_set_missing" => TunErrorCode::RuleSetMissing,
            "runtime_missing" => TunErrorCode::RuntimeMissing,
            "tun_start_failed" => TunErrorCode::TunStartFailed,
            "internal" => TunErrorCode::Internal,
            _ => return None,
        })
    }

    /// 翻译成前端认的 `details.reason`（§4.3）。界面进程负责翻译，不能把 wire 码直接甩给 UI。
    pub fn ui_reason(self) -> &'static str {
        match self {
            TunErrorCode::TunDenied => "tun_denied",
            TunErrorCode::HelperMissing
            | TunErrorCode::HelperInstallFailed
            | TunErrorCode::PeerUnverified => "helper_missing",
            TunErrorCode::UnsupportedPlatform => "unsupported_platform",
            _ => "tun_start_failed",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TunError {
    pub code: TunErrorCode,
    /// 给用户看的中文，不含路径、凭据与内部错误栈。
    pub message: String,
    /// 结构化诊断，不含路径与凭据。
    pub detail: Option<serde_json::Value>,
}

impl TunError {
    pub fn new(code: TunErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            detail: None,
        }
    }

    pub fn with_detail(mut self, detail: impl Into<serde_json::Value>) -> Self {
        self.detail = Some(detail.into());
        self
    }

    /// 权限层的 `PrivilegeError` 只是在本地流转，这里翻成统一错误。
    pub fn from_privilege(error: PrivilegeError) -> Self {
        let code = match error.code {
            ERR_TUN_DENIED => TunErrorCode::TunDenied,
            ERR_HELPER_MISSING => TunErrorCode::HelperMissing,
            ERR_HELPER_INSTALL_FAILED => TunErrorCode::HelperInstallFailed,
            ERR_TUN_START_FAILED => TunErrorCode::TunStartFailed,
            _ => TunErrorCode::Internal,
        };
        Self {
            code,
            message: error.message,
            detail: error.detail.map(serde_json::Value::String),
        }
    }
}

impl std::fmt::Display for TunError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}

impl std::error::Error for TunError {}

/// 非 macOS / 非 Windows 的占位实现：任何操作都明确说「这个平台还不支持」。
pub struct UnsupportedBackend;

impl TunBackend for UnsupportedBackend {
    fn availability(&self) -> Result<HelperStatus, TunError> {
        Ok(HelperStatus::Unsupported)
    }

    fn ensure_available(&self) -> Result<HelperStatus, TunError> {
        Err(unsupported_platform_error())
    }

    fn start(&self, _config: &str) -> Result<StartReply, TunError> {
        Err(unsupported_platform_error())
    }

    fn stop(&self) -> Result<(), TunError> {
        Err(unsupported_platform_error())
    }

    fn status(&self) -> Result<TunSnapshot, TunError> {
        Err(unsupported_platform_error())
    }
}

pub fn unsupported_platform_error() -> TunError {
    TunError::new(
        TunErrorCode::UnsupportedPlatform,
        "这个平台还不支持接管全部流量，请改用代理模式",
    )
}

// ---------------------------------------------------------------------------
// macOS 实现
//
// 放在这里而不是 `xpc.rs`：`xpc.rs` 被 helper 用 `#[path]` 引入，模块树里没有
// `backend`，在里面 `use super::backend` 会把 helper 编挂。这里只在主程序编译。
// ---------------------------------------------------------------------------

#[cfg(target_os = "macos")]
mod macos {
    use std::sync::Arc;

    use super::*;
    use crate::tun::privilege::{app_location_hint, Registration};
    use crate::tun::protocol::MACH_SERVICE;
    use crate::tun::xpc::{self, Reply, XpcError};

    /// 把现有 XPC 通道与 SMAppService 注册包成契约后端。
    pub struct MacXpcBackend {
        registration: Arc<dyn Registration>,
    }

    impl MacXpcBackend {
        pub fn new(registration: Arc<dyn Registration>) -> Self {
            Self { registration }
        }
    }

    impl TunBackend for MacXpcBackend {
        fn availability(&self) -> Result<HelperStatus, TunError> {
            Ok(self.registration.status())
        }

        fn ensure_available(&self) -> Result<HelperStatus, TunError> {
            self.registration
                .ensure_registered()
                .map_err(TunError::from_privilege)?;
            Ok(self.registration.status())
        }

        fn start(&self, config: &str) -> Result<StartReply, TunError> {
            match xpc::call_with_timeout(
                MACH_SERVICE,
                "start",
                Some(config.as_bytes()),
                TUN_REPLY_DEADLINE_START,
            ) {
                Ok(Reply::Started {
                    pid,
                    clash_addr,
                    clash_secret,
                    since,
                }) => Ok(StartReply {
                    pid,
                    clash_api: ClashApi {
                        addr: clash_addr,
                        secret: clash_secret,
                    },
                    // `since` 由 helper 生成（契约 §3.1），不是调用方时刻。
                    since,
                }),
                Ok(_) => Err(TunError::new(
                    TunErrorCode::Internal,
                    "特权助手回了意料之外的结果",
                )),
                Err(error) => Err(map_xpc_error(error)),
            }
        }

        fn stop(&self) -> Result<(), TunError> {
            match xpc::call_with_timeout(
                MACH_SERVICE,
                "stop",
                None,
                TUN_REPLY_DEADLINE_CONTROL,
            ) {
                Ok(_) => Ok(()),
                Err(error) => Err(map_xpc_error(error)),
            }
        }

        fn status(&self) -> Result<TunSnapshot, TunError> {
            match xpc::call_with_timeout(
                MACH_SERVICE,
                "status",
                None,
                TUN_REPLY_DEADLINE_CONTROL,
            ) {
                Ok(Reply::Status {
                    running,
                    pid,
                    clash_addr,
                    clash_secret,
                    since,
                }) => Ok(TunSnapshot {
                    running,
                    pid: if running { pid } else { None },
                    clash_api: match (clash_addr, clash_secret) {
                        (Some(addr), Some(secret)) => Some(ClashApi { addr, secret }),
                        // 未运行时 helper 不写这两项；缺一项也当作未知，不拼半份。
                        _ => None,
                    },
                    since: if running { since } else { None },
                    last_error: None,
                }),
                Ok(_) => Err(TunError::new(
                    TunErrorCode::Internal,
                    "特权助手回了意料之外的结果",
                )),
                Err(error) => Err(map_xpc_error(error)),
            }
        }
    }

    /// XPC 的失败翻译成用户能懂的两类：**助手不在**（权限/安装），
    /// 和**助手在但拒绝了**（启动失败）。两者都不该被当成网络故障。
    ///
    /// 本地错误（超时、传输失败）按契约 §4.4 放在 `details.local_code`，
    /// 不混进 wire 码；helper 返回的 wire 码原样放进 `details.wire_code`。
    pub fn map_xpc_error(error: XpcError) -> TunError {
        match error {
            XpcError::Unavailable(detail) => {
                let mut message = String::from("连不上特权助手，接管全部流量需要它");
                if let Some(hint) = app_location_hint() {
                    message.push_str(&format!("。{hint}"));
                }
                // 契约 §4.4：这是**调用竞态**（服务没起来/连接被拒），不是
                // `ensure_available` 的可用性结论，所以带上 local_code。
                // 权限层失败由 `TunError::from_privilege` 产生，那条不应带 local_code。
                TunError::new(TunErrorCode::HelperMissing, message).with_detail(
                    serde_json::json!({ "local_code": "helper_missing", "detail": detail }),
                )
            }
            XpcError::Server { code, message } => {
                let parsed =
                    TunErrorCode::from_wire(&code).unwrap_or(TunErrorCode::TunStartFailed);
                TunError::new(parsed, message)
                    .with_detail(serde_json::json!({ "wire_code": code }))
            }
            XpcError::Protocol(detail) => TunError::new(
                TunErrorCode::TransportError,
                "特权助手返回了无法识别的回复",
            )
            .with_detail(
                serde_json::json!({ "local_code": "transport_error", "detail": detail }),
            ),
            // 连接被中断是传输层问题，不是「没装/没批准」。
            XpcError::Interrupted(detail) => {
                TunError::new(TunErrorCode::TransportError, "与特权助手的连接中断").with_detail(
                    serde_json::json!({ "local_code": "transport_error", "detail": detail }),
                )
            }
            XpcError::Timeout => {
                TunError::new(TunErrorCode::Timeout, "特权助手没有在限定时间内回复").with_detail(
                    serde_json::json!({ "local_code": "timeout" }),
                )
            }
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn unavailable_helper_is_reported_as_a_permission_problem() {
            let error = map_xpc_error(XpcError::Unavailable("connection invalid".into()));
            assert_eq!(error.code, TunErrorCode::HelperMissing);
            assert_eq!(error.code.ui_reason(), "helper_missing");
            // 测试环境不在 /Applications，提示必须带上。
            assert!(error.message.contains("应用程序"), "{}", error.message);
        }

        #[test]
        fn a_server_rejection_is_a_start_failure_not_a_permission_problem() {
            let error = map_xpc_error(XpcError::Server {
                code: "config_forbidden".into(),
                message: "不允许远程引用".into(),
            });
            // wire 码原样保留，界面理由仍是 tun_start_failed（§4.3）。
            assert_eq!(error.code, TunErrorCode::ConfigForbidden);
            assert!(error.code.is_wire());
            assert_eq!(error.code.ui_reason(), "tun_start_failed");
            assert_eq!(error.message, "不允许远程引用");
            assert_eq!(error.detail.unwrap()["wire_code"], "config_forbidden");
        }

        /// 契约 §1.3 / §4.4：超时是本地错误，不能混成 wire 码。
        #[test]
        fn a_timeout_is_a_local_error() {
            let error = map_xpc_error(XpcError::Timeout);
            assert_eq!(error.code, TunErrorCode::Timeout);
            assert!(!error.code.is_wire());
            assert_eq!(error.code.ui_reason(), "tun_start_failed");
            assert_eq!(error.detail.unwrap()["local_code"], "timeout");
        }

        /// 解析失败的回复按 transport_error 处理，同样不是 wire 码。
        #[test]
        fn a_malformed_reply_is_a_transport_error() {
            let error = map_xpc_error(XpcError::Protocol("garbage".into()));
            assert_eq!(error.code, TunErrorCode::TransportError);
            assert!(!error.code.is_wire());
            assert_eq!(error.detail.unwrap()["local_code"], "transport_error");
        }

        /// 连接中断不能伪装成「没装」：它是传输层问题。
        #[test]
        fn an_interrupted_connection_is_a_transport_error() {
            let error = map_xpc_error(XpcError::Interrupted("connection interrupted".into()));
            assert_eq!(error.code, TunErrorCode::TransportError);
            assert_eq!(error.code.ui_reason(), "tun_start_failed");
            assert_eq!(error.detail.unwrap()["local_code"], "transport_error");
        }
    }
}

#[cfg(target_os = "macos")]
pub use macos::MacXpcBackend;


#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wire_codes_and_local_codes_do_not_mix() {
        for code in [
            TunErrorCode::BadRequest,
            TunErrorCode::ConfigTooLarge,
            TunErrorCode::ConfigInvalid,
            TunErrorCode::ConfigForbidden,
            TunErrorCode::RuleSetMissing,
            TunErrorCode::RuntimeMissing,
            TunErrorCode::TunStartFailed,
            TunErrorCode::Internal,
        ] {
            assert!(code.is_wire(), "{} 应当是 wire 码", code.as_str());
        }
        for code in [
            TunErrorCode::TunDenied,
            TunErrorCode::HelperMissing,
            TunErrorCode::HelperInstallFailed,
            TunErrorCode::Timeout,
            TunErrorCode::PeerUnverified,
            TunErrorCode::TransportError,
            TunErrorCode::UnsupportedPlatform,
        ] {
            assert!(!code.is_wire(), "{} 不是 wire 码", code.as_str());
        }
    }

    #[test]
    fn known_wire_codes_round_trip_and_unknown_falls_back() {
        let wire = [
            TunErrorCode::BadRequest,
            TunErrorCode::ConfigTooLarge,
            TunErrorCode::ConfigInvalid,
            TunErrorCode::ConfigForbidden,
            TunErrorCode::RuleSetMissing,
            TunErrorCode::RuntimeMissing,
            TunErrorCode::TunStartFailed,
            TunErrorCode::Internal,
        ];
        for code in wire {
            assert_eq!(TunErrorCode::from_wire(code.as_str()), Some(code));
        }
        assert_eq!(TunErrorCode::from_wire("already_running"), None);
        assert_eq!(TunErrorCode::from_wire(""), None);
    }

    #[test]
    fn ui_reasons_follow_the_contract_table() {        assert_eq!(TunErrorCode::TunDenied.ui_reason(), "tun_denied");
        assert_eq!(TunErrorCode::HelperMissing.ui_reason(), "helper_missing");
        assert_eq!(TunErrorCode::PeerUnverified.ui_reason(), "helper_missing");
        assert_eq!(
            TunErrorCode::UnsupportedPlatform.ui_reason(),
            "unsupported_platform"
        );
        for code in [
            TunErrorCode::ConfigForbidden,
            TunErrorCode::RuntimeMissing,
            TunErrorCode::Timeout,
            TunErrorCode::TransportError,
            TunErrorCode::Internal,
        ] {
            assert_eq!(code.ui_reason(), "tun_start_failed");
        }
    }

    #[test]
    fn privilege_errors_keep_their_meaning() {
        let denied = TunError::from_privilege(PrivilegeError::new(ERR_TUN_DENIED, "用户拒绝了"));
        assert_eq!(denied.code, TunErrorCode::TunDenied);
        let missing =
            TunError::from_privilege(PrivilegeError::new(ERR_HELPER_MISSING, "助手不在"));
        assert_eq!(missing.code, TunErrorCode::HelperMissing);
    }

    /// 契约 §3.2：字段恒存在，无值时是 null，不是省略键。
    #[test]
    fn an_idle_snapshot_serializes_every_key_as_null() {
        let snapshot = TunSnapshot {
            running: false,
            pid: None,
            clash_api: None,
            since: None,
            last_error: None,
        };
        let value = serde_json::to_value(&snapshot).unwrap();
        for key in ["running", "pid", "clash_api", "since", "last_error"] {
            assert!(value.get(key).is_some(), "缺少键 {key}");
        }
        assert_eq!(value["pid"], serde_json::Value::Null);
    }
}
