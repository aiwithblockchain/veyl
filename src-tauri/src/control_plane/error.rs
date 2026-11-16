//! 控制面错误 → 现有 AivpnError 信封。
//!
//! 码只用 `runtime.md` §6.1 的通用码，细分放 `details.reason`； Worker 自己的
//! `UNAUTHENTICATED` / `FORBIDDEN` 也在这里映射成通用码，不向下透传。

use serde_json::{json, Value};

#[derive(Debug, Clone, PartialEq)]
pub struct CpError {
    pub code: String,
    pub message: String,
    pub retryable: bool,
    pub details: Value,
    pub request_id: String,
}

impl CpError {
    pub fn new(
        code: impl Into<String>,
        message: impl Into<String>,
        retryable: bool,
        details: Value,
    ) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            retryable,
            details,
            request_id: String::new(),
        }
    }

    pub fn reason(&self) -> Option<&str> {
        self.details.get("reason").and_then(Value::as_str)
    }

    pub fn with_reason(mut self, reason: &str) -> Self {
        if let Some(object) = self.details.as_object_mut() {
            object.insert("reason".into(), Value::String(reason.to_string()));
        } else {
            self.details = json!({ "reason": reason });
        }
        self
    }

    /// 命令层原样返回的错误信封（字段与 `commands.md` §1 一致）。
    pub fn envelope(&self) -> Value {
        json!({
            "contract_version": crate::runtime::EVENT_CONTRACT_VERSION,
            "code": self.code,
            "message": self.message,
            "retryable": self.retryable,
            "details": self.details,
            "request_id": self.request_id,
        })
    }

    pub fn network(timeout: bool) -> Self {
        if timeout {
            Self::new("TIMEOUT", "连接服务器服务超时", true, json!({ "reason": "timeout" }))
        } else {
            Self::new(
                "UPSTREAM_ERROR",
                "暂时连不上服务器服务",
                true,
                json!({ "reason": "provider_unavailable" }),
            )
        }
    }

    pub fn invalid_response(message: impl Into<String>) -> Self {
        Self::new(
            "UPSTREAM_ERROR",
            message,
            false,
            json!({ "reason": "invalid_response" }),
        )
    }

    pub fn auth_required(message: impl Into<String>) -> Self {
        Self::new(
            "PRECONDITION_FAILED",
            message,
            true,
            json!({ "reason": "auth_required" }),
        )
    }

    pub fn internal(message: impl Into<String>) -> Self {
        Self::new("INTERNAL", message, false, json!({ "reason": "internal" }))
    }
}

/// Worker 的错误信封 → 通用码。响应体不是信封时按状态码兜底。
pub fn from_response(status: u16, body: &str) -> CpError {
    let parsed: Option<Value> = serde_json::from_str(body).ok();
    let code = parsed
        .as_ref()
        .and_then(|value| value.get("code"))
        .and_then(Value::as_str)
        .unwrap_or("");
    let message = parsed
        .as_ref()
        .and_then(|value| value.get("message"))
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(str::to_string);
    let retryable = parsed
        .as_ref()
        .and_then(|value| value.get("retryable"))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let reason = parsed
        .as_ref()
        .and_then(|value| value.get("details"))
        .and_then(|details| details.get("reason"))
        .and_then(Value::as_str)
        .map(str::to_string);
    let request_id = parsed
        .as_ref()
        .and_then(|value| value.get("request_id"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    // 这两个字段驱动界面文案（冷却倒计时、剩余尝试次数），不能在映射时丢掉。
    let retry_after_seconds = parsed
        .as_ref()
        .and_then(|value| value.get("details"))
        .and_then(|details| details.get("retry_after_seconds"))
        .and_then(Value::as_u64);
    let attempts_remaining = parsed
        .as_ref()
        .and_then(|value| value.get("details"))
        .and_then(|details| details.get("attempts_remaining"))
        .and_then(Value::as_u64);
    let shortfall_cents = parsed
        .as_ref()
        .and_then(|value| value.get("details"))
        .and_then(|details| details.get("shortfall_cents"))
        .and_then(Value::as_i64);

    let mapped = match code {
        // 登录门禁的两种 reason 用 `UNAUTHENTICATED`（commands.md §7.18）；
        // 设备刷新失败仍按原语义归到 `PRECONDITION_FAILED / auth_required`。
        "UNAUTHENTICATED" => {
            let login_reason =
                matches!(reason.as_deref(), Some("auth_required") | Some("token_invalid"));
            let text = message.unwrap_or_else(|| "需要登录后使用".into());
            if login_reason {
                CpError::new(
                    "UNAUTHENTICATED",
                    text,
                    true,
                    json!({ "reason": reason.unwrap_or_default() }),
                )
            } else {
                CpError::auth_required(text)
            }
        }
        "FORBIDDEN" => CpError::new(
            "PERMISSION_DENIED",
            message.unwrap_or_else(|| "这台设备已被停用".into()),
            false,
            json!({ "reason": reason.unwrap_or_else(|| "account_blocked".into()) }),
        ),
        "NOT_FOUND" => CpError::new(
            "NOT_FOUND",
            message.unwrap_or_else(|| "找不到这台服务器".into()),
            false,
            json!({ "reason": reason.unwrap_or_else(|| "server_gone".into()) }),
        ),
        "PRECONDITION_FAILED" | "CONFLICT" => CpError::new(
            "PRECONDITION_FAILED",
            message.unwrap_or_else(|| "当前状态不允许这个操作".into()),
            retryable,
            json!({ "reason": reason.unwrap_or_else(|| "conflict".into()) }),
        ),
        "RATE_LIMITED" => CpError::new(
            "RATE_LIMITED",
            message.unwrap_or_else(|| "操作太频繁，稍后再试".into()),
            true,
            json!({ "reason": reason.unwrap_or_else(|| "rate_limited".into()) }),
        ),
        "TIMEOUT" => CpError::new(
            "TIMEOUT",
            message.unwrap_or_else(|| "服务器服务超时".into()),
            true,
            json!({ "reason": "timeout" }),
        ),
        "UPSTREAM_ERROR" => CpError::new(
            "UPSTREAM_ERROR",
            message.unwrap_or_else(|| "服务器服务暂时不可用".into()),
            true,
            json!({ "reason": reason.unwrap_or_else(|| "provider_unavailable".into()) }),
        ),
        "INTERNAL" => CpError::new(
            "INTERNAL",
            message.unwrap_or_else(|| "服务器服务内部错误".into()),
            retryable,
            json!({ "reason": "internal" }),
        ),
        "" => status_fallback(status, message),
        other => CpError::new(
            "UPSTREAM_ERROR",
            message.unwrap_or_else(|| "服务器服务返回了未知错误".into()),
            retryable,
            json!({ "reason": "unexpected_code", "upstream_code": other }),
        ),
    };

    let mut mapped = mapped;
    if let Some(details) = mapped.details.as_object_mut() {
        if let Some(value) = retry_after_seconds {
            details.insert("retry_after_seconds".into(), json!(value));
        }
        if let Some(value) = attempts_remaining {
            details.insert("attempts_remaining".into(), json!(value));
        }
        if let Some(value) = shortfall_cents {
            details.insert("shortfall_cents".into(), json!(value));
        }
    }

    CpError {
        request_id,
        ..mapped
    }
}

fn status_fallback(status: u16, message: Option<String>) -> CpError {
    match status {
        401 => CpError::auth_required(message.unwrap_or_else(|| "需要重新验证设备".into())),
        403 => CpError::new(
            "PERMISSION_DENIED",
            message.unwrap_or_else(|| "这台设备已被停用".into()),
            false,
            json!({ "reason": "account_blocked" }),
        ),
        404 => CpError::new(
            "NOT_FOUND",
            message.unwrap_or_else(|| "找不到这台服务器".into()),
            false,
            json!({ "reason": "server_gone" }),
        ),
        409 => CpError::new(
            "PRECONDITION_FAILED",
            message.unwrap_or_else(|| "当前状态不允许这个操作".into()),
            false,
            json!({ "reason": "conflict" }),
        ),
        429 => CpError::new(
            "RATE_LIMITED",
            message.unwrap_or_else(|| "操作太频繁，稍后再试".into()),
            true,
            json!({ "reason": "rate_limited" }),
        ),
        500..=599 => CpError::new(
            "UPSTREAM_ERROR",
            message.unwrap_or_else(|| "服务器服务暂时不可用".into()),
            true,
            json!({ "reason": "provider_unavailable", "status": status }),
        ),
        _ => CpError::new(
            "UPSTREAM_ERROR",
            message.unwrap_or_else(|| "服务器服务返回了异常响应".into()),
            false,
            json!({ "reason": "unexpected_status", "status": status }),
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn login_reasons_keep_their_code_and_limits() {
        let error = from_response(
            429,
            r#"{"code":"RATE_LIMITED","message":"稍后再试","retryable":true,"details":{"reason":"email_cooldown","retry_after_seconds":42}}"#,
        );
        assert_eq!(error.code, "RATE_LIMITED");
        assert_eq!(error.reason(), Some("email_cooldown"));
        assert_eq!(error.details["retry_after_seconds"], 42);

        let error = from_response(
            401,
            r#"{"code":"UNAUTHENTICATED","message":"需要登录","details":{"reason":"auth_required"}}"#,
        );
        assert_eq!(error.code, "UNAUTHENTICATED");
        assert_eq!(error.reason(), Some("auth_required"));
        assert!(error.retryable);

        let error = from_response(
            400,
            r#"{"code":"PRECONDITION_FAILED","message":"验证码错误","retryable":true,"details":{"reason":"code_invalid","attempts_remaining":2}}"#,
        );
        assert_eq!(error.code, "PRECONDITION_FAILED");
        assert_eq!(error.reason(), Some("code_invalid"));
        assert_eq!(error.details["attempts_remaining"], 2);

        // 余额不足的差额必须原样透出，界面据此显示「还差 $N」。
        let error = from_response(
            402,
            r#"{"code":"PRECONDITION_FAILED","message":"余额不足","retryable":true,"details":{"reason":"insufficient_balance","shortfall_cents":350}}"#,
        );
        assert_eq!(error.code, "PRECONDITION_FAILED");
        assert_eq!(error.reason(), Some("insufficient_balance"));
        assert_eq!(error.details["shortfall_cents"], 350);
        assert!(error.retryable);
    }

    #[test]
    fn a_worker_envelope_is_mapped_to_general_codes() {
        let error = from_response(
            401,
            r#"{"code":"UNAUTHENTICATED","message":"刷新令牌无效","retryable":false,"details":{"reason":"refresh_unknown"},"request_id":"r1"}"#,
        );
        assert_eq!(error.code, "PRECONDITION_FAILED");
        assert_eq!(error.reason(), Some("auth_required"));
        assert!(error.retryable);
        assert_eq!(error.request_id, "r1");

        let error = from_response(
            403,
            r#"{"code":"FORBIDDEN","message":"这台设备已被停用","details":{"reason":"device_revoked"},"request_id":"r2"}"#,
        );
        assert_eq!(error.code, "PERMISSION_DENIED");
        assert_eq!(error.reason(), Some("device_revoked"));
        assert_eq!(error.request_id, "r2");
        assert!(!error.retryable);
    }

    #[test]
    fn idempotency_conflicts_keep_their_reason_and_retryability() {
        let error = from_response(
            409,
            r#"{"code":"PRECONDITION_FAILED","message":"正在处理，稍等","retryable":true,"details":{"reason":"idempotency_in_flight"}}"#,
        );
        assert_eq!(error.code, "PRECONDITION_FAILED");
        assert_eq!(error.reason(), Some("idempotency_in_flight"));
        assert!(error.retryable);
    }

    #[test]
    fn an_unknown_upstream_code_never_leaks_through() {
        let error = from_response(418, r#"{"code":"TEAPOT","message":"no"}"#);
        assert_eq!(error.code, "UPSTREAM_ERROR");
        assert_eq!(error.reason(), Some("unexpected_code"));
        assert_eq!(error.details["upstream_code"], "TEAPOT");
    }

    #[test]
    fn a_non_json_body_falls_back_to_the_status() {
        let error = from_response(503, "<html>bad gateway</html>");
        assert_eq!(error.code, "UPSTREAM_ERROR");
        assert!(error.retryable);
        assert_eq!(error.details["reason"], "provider_unavailable");
    }

    #[test]
    fn the_envelope_has_no_token_or_password_fields() {
        let error = CpError::new("UPSTREAM_ERROR", "失败", true, json!({ "reason": "x" }));
        let value = error.envelope();
        for key in ["access_token", "refresh_token", "password", "device_secret"] {
            assert!(value.get(key).is_none(), "{key} 不能出现在错误信封里");
        }
    }
}
