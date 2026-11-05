//! `WinPipeBackend`：把命名管道通道包成契约后端（`docs/contracts/tun-backend.md` §2）。
//!
//! 这个文件通过 `tun/backend.rs` 的 `#[path]` 挂进模块树，所以 `super` 就是
//! `tun::backend`。不放在 `tun/windows/mod.rs` 里声明，是因为那份文件会被
//! 服务二进制整份引入，而服务端不需要（也不该链接）`TunBackend`。

use serde_json::{json, Value};

use super::*;
use crate::tun::windows::ipc::{Request, Response};
use crate::tun::windows::pipe::{self, IpcError};
use crate::tun::windows::scm::{self, ScmError};
use crate::tun::windows::SERVICE_NAME;

use windows_sys::Win32::System::Services::SERVICE_RUNNING;

/// Windows 实现：普通用户进程，只通过命名管道与服务通信。
pub struct WinPipeBackend;

impl WinPipeBackend {
    pub fn new() -> Self {
        Self
    }
}

impl Default for WinPipeBackend {
    fn default() -> Self {
        Self::new()
    }
}

impl TunBackend for WinPipeBackend {
    fn availability(&self) -> Result<HelperStatus, TunError> {
        Ok(availability())
    }

    /// **不安装、不提权、不弹窗。** 服务未装或未运行时明确返回 `helper_missing`；
    /// 安装归 W5 的提权安装器（`docs/windows-tun.md` §3.2），应用里静默安装
    /// 既做不到（普通用户建不了服务），也不该做。
    fn ensure_available(&self) -> Result<HelperStatus, TunError> {
        let status = self.availability()?;
        if status.is_ready() {
            return Ok(status);
        }
        Err(TunError::new(
            TunErrorCode::HelperMissing,
            "Veyl 特权服务没有运行。接管全部流量要用到它；如果还没有安装，应用会在需要时请求管理员权限",
        ))
    }

    fn start(&self, config: &str) -> Result<StartReply, TunError> {
        let response = pipe::call(&Request::Start {
            config: config.to_string(),
        })
        .map_err(map_ipc)?;
        let result = ok_result(response)?;
        serde_json::from_value(result).map_err(|error| {
            TunError::new(
                TunErrorCode::TransportError,
                "特权服务返回了无法识别的启动结果",
            )
            .with_detail(json!({
                "local_code": "transport_error",
                "detail": error.to_string(),
            }))
        })
    }

    fn stop(&self) -> Result<(), TunError> {
        let response = pipe::call(&Request::Stop).map_err(map_ipc)?;
        ok_result(response).map(|_| ())
    }

    fn status(&self) -> Result<TunSnapshot, TunError> {
        let response = pipe::call(&Request::Status).map_err(map_ipc)?;
        let result = ok_result(response)?;
        serde_json::from_value(result).map_err(|error| {
            TunError::new(TunErrorCode::TransportError, "特权服务返回了无法识别的状态").with_detail(
                json!({
                    "local_code": "transport_error",
                    "detail": error.to_string(),
                }),
            )
        })
    }
}

/// 契约 §2.1 的 Windows 映射：`enabled` = 服务存在且正在运行；
/// `not_registered` = 没装或没在跑；`not_found` = 注册项在但 ImagePath 不可执行。
fn availability() -> HelperStatus {
    match scm::query(SERVICE_NAME) {
        Ok(query) if query.state == SERVICE_RUNNING => match scm::binary_path(SERVICE_NAME) {
            Some(path) if !path.is_file() => HelperStatus::NotFound,
            _ => HelperStatus::Enabled,
        },
        // 服务在但没跑（含被禁用）：下次连接会再次 `ensure_available`，这里如实说没起来。
        Ok(_) => HelperStatus::NotRegistered,
        Err(ScmError::NotFound(_)) | Err(ScmError::Query(_)) => HelperStatus::NotRegistered,
    }
}

fn ok_result(response: Response) -> Result<Value, TunError> {
    if response.ok {
        return Ok(response.result.unwrap_or(Value::Null));
    }
    let wire = response.code.unwrap_or_else(|| "internal".to_string());
    let message = response
        .message
        .unwrap_or_else(|| "特权服务拒绝了这次请求".to_string());
    let code = TunErrorCode::from_wire(&wire).unwrap_or(TunErrorCode::TunStartFailed);
    // 契约 §4.3：wire 码原样带上，供日志与问题上报；UI 不展示它。
    Err(TunError::new(code, message).with_detail(json!({ "wire_code": wire })))
}

/// 本地错误（不跨线）按契约 §4.4 分流：`helper_missing` / `peer_unverified` /
/// `timeout` / `transport_error`。message 不回显可疑进程的路径或 pid。
fn map_ipc(error: IpcError) -> TunError {
    let local_code = error.local_code();
    let (code, message) = match &error {
        IpcError::HelperMissing(_) => (TunErrorCode::HelperMissing, "Veyl 特权服务不可用"),
        IpcError::PeerUnverified { .. } => (TunErrorCode::PeerUnverified, "服务没有正常启动"),
        IpcError::Timeout(_) => (TunErrorCode::Timeout, "Veyl 特权服务没有在限定时间内回复"),
        IpcError::Unavailable(_) | IpcError::Protocol(_) => {
            (TunErrorCode::TransportError, "与 Veyl 特权服务的连接失败")
        }
    };
    TunError::new(code, message).with_detail(json!({
        "local_code": local_code,
        "detail": error.to_string(),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn local(error: IpcError) -> (String, Value) {
        let mapped = map_ipc(error);
        let detail = mapped.detail.clone().unwrap();
        (detail["local_code"].as_str().unwrap().to_string(), detail)
    }

    #[test]
    fn local_errors_keep_the_contract_codes() {
        assert_eq!(
            local(IpcError::HelperMissing("x".into())).0,
            "helper_missing"
        );
        assert_eq!(
            local(IpcError::PeerUnverified { detail: "x".into() }).0,
            "peer_unverified"
        );
        assert_eq!(local(IpcError::Timeout("x".into())).0, "timeout");
        assert_eq!(
            local(IpcError::Unavailable("x".into())).0,
            "transport_error"
        );
        assert_eq!(local(IpcError::Protocol("x".into())).0, "transport_error");
    }

    #[test]
    fn peer_failures_are_permission_problems_not_network_errors() {
        let error = map_ipc(IpcError::PeerUnverified {
            detail: "pid 不一致".into(),
        });
        assert_eq!(error.code, TunErrorCode::PeerUnverified);
        assert_eq!(error.code.ui_reason(), "helper_missing");
        assert_eq!(error.message, "服务没有正常启动");
        assert!(
            !error.message.contains("pid"),
            "message 不能回显探测细节：{}",
            error.message
        );
        assert!(!error.code.is_wire());
    }

    #[test]
    fn a_server_rejection_is_a_wire_code() {
        let response = Response {
            ok: false,
            code: Some("config_forbidden".into()),
            message: Some("不允许远程引用".into()),
            detail: None,
            result: None,
        };
        let error = ok_result(response).unwrap_err();
        assert_eq!(error.code, TunErrorCode::ConfigForbidden);
        assert!(error.code.is_wire());
        assert_eq!(error.detail.unwrap()["wire_code"], "config_forbidden");
    }

    #[test]
    fn an_unknown_wire_code_falls_back_but_keeps_the_original() {
        let response = Response {
            ok: false,
            code: Some("something_new".into()),
            message: Some("x".into()),
            detail: None,
            result: None,
        };
        let error = ok_result(response).unwrap_err();
        assert_eq!(error.code, TunErrorCode::TunStartFailed);
        assert_eq!(error.detail.unwrap()["wire_code"], "something_new");
    }

    #[test]
    fn a_successful_stop_result_is_null() {
        let response = Response {
            ok: true,
            code: None,
            message: None,
            detail: None,
            result: Some(Value::Null),
        };
        assert_eq!(ok_result(response).unwrap(), Value::Null);
    }
}
