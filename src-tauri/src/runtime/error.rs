use std::path::PathBuf;

#[derive(Debug, thiserror::Error)]
pub enum RuntimeError {
    #[error("platform not supported: {os}/{arch}")]
    UnsupportedPlatform { os: String, arch: String },

    #[error("release not found for {0}/{1}")]
    ReleaseNotFound(String, String),

    #[error("http error: {0}")]
    Http(String),

    #[error("download failed: {0}")]
    Download(String),

    #[error("checksum mismatch: expected sha256 {expected}, got {actual}")]
    Sha256Mismatch { expected: String, actual: String },

    #[error("size mismatch: expected {expected} bytes, got {actual}")]
    SizeMismatch { expected: u64, actual: u64 },

    #[error("unsafe archive entry {entry}: {reason}")]
    UnsafeArchive { entry: String, reason: String },

    #[error("archive error: {0}")]
    Archive(String),

    #[error("io error at {path:?}: {source}")]
    Io {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },

    #[error("process error: {0}")]
    Process(String),

    #[error("runtime startup timed out after {0} ms")]
    StartupTimeout(u64),

    #[error("invalid state: current={current}, action={action}")]
    InvalidState { current: String, action: String },

    #[error("clash api error: {0}")]
    ClashApi(String),

    #[error("runtime is not installed")]
    NotInstalled,

    #[error("install aborted")]
    InstallAborted,

    #[error("config error: {0}")]
    Config(String),

    #[error("config validation failed: {0}")]
    ConfigInvalid(String),

    #[error("proxy error: {0}")]
    Proxy(String),

    #[error("state file error: {0}")]
    State(String),

    #[error("unsupported: {message}")]
    Unsupported {
        message: String,
        details: serde_json::Value,
    },

    #[error("precondition failed ({reason}): {message}")]
    Precondition {
        reason: &'static str,
        message: String,
    },
}

pub type RuntimeResult<T> = Result<T, RuntimeError>;

impl RuntimeError {
    /// 映射到 `docs/contracts/runtime.md` §6 的错误码，Host → UI → Agent 共用同一标识。
    pub fn code(&self) -> &'static str {
        match self {
            RuntimeError::NotInstalled => "RUNTIME_NOT_INSTALLED",
            RuntimeError::StartupTimeout(_) => "RUNTIME_START_TIMEOUT",
            RuntimeError::ConfigInvalid(_) => "RUNTIME_CONFIG_INVALID",
            RuntimeError::Config(_) => "INVALID_ARGUMENT",
            RuntimeError::InvalidState { .. } => "RUNTIME_BUSY",
            RuntimeError::Process(message) if message.contains("failed to spawn") => {
                "RUNTIME_BINARY_NOT_EXECUTABLE"
            }
            RuntimeError::Process(_) => "RUNTIME_EXITED",
            RuntimeError::ClashApi(_) => "RUNTIME_CLASH_UPSTREAM_ERROR",
            RuntimeError::UnsupportedPlatform { .. } => "UNSUPPORTED",
            RuntimeError::ReleaseNotFound(_, _) => "RUNTIME_VERSION_UNSUPPORTED",
            RuntimeError::Http(_) | RuntimeError::Download(_) => "UPSTREAM_ERROR",
            RuntimeError::Sha256Mismatch { .. } | RuntimeError::SizeMismatch { .. } => {
                "PRECONDITION_FAILED"
            }
            RuntimeError::UnsafeArchive { .. } | RuntimeError::Archive(_) => {
                "PRECONDITION_FAILED"
            }
            RuntimeError::Io { .. } | RuntimeError::State(_) => "INTERNAL",
            RuntimeError::Proxy(_) => "INTERNAL",
            RuntimeError::InstallAborted => "CANCELLED",
            RuntimeError::Precondition { .. } => "PRECONDITION_FAILED",
            RuntimeError::Unsupported { .. } => "UNSUPPORTED",
        }
    }

    /// `details` 字段；契约里的 `AivpnError.details`。
    pub fn details(&self) -> Option<serde_json::Value> {
        match self {
            RuntimeError::Precondition { reason, .. } => {
                Some(serde_json::json!({ "reason": reason }))
            }
            RuntimeError::NotInstalled => Some(serde_json::json!({ "hint": "call CoreInstall" })),
            RuntimeError::Unsupported { details, .. } => Some(details.clone()),
            _ => None,
        }
    }

    pub fn retryable(&self) -> bool {
        matches!(
            self,
            RuntimeError::StartupTimeout(_)
                | RuntimeError::Http(_)
                | RuntimeError::Download(_)
                | RuntimeError::ClashApi(_)
                | RuntimeError::InvalidState { .. }
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn precondition_maps_to_the_contract_code() {
        let err = RuntimeError::Precondition {
            reason: "ACTIVE_PROFILE_IN_USE",
            message: "profile p1 is in use".into(),
        };
        assert_eq!(err.code(), "PRECONDITION_FAILED");
        assert!(!err.retryable());
        assert_eq!(
            err.details().unwrap()["reason"],
            serde_json::json!("ACTIVE_PROFILE_IN_USE")
        );
    }

    #[test]
    fn missing_runtime_points_at_core_install() {
        let err = RuntimeError::NotInstalled;
        assert_eq!(err.code(), "RUNTIME_NOT_INSTALLED");
        assert_eq!(err.details().unwrap()["hint"], "call CoreInstall");
    }

    #[test]
    fn config_errors_are_not_retryable() {
        let err = RuntimeError::ConfigInvalid("bad uuid".into());
        assert_eq!(err.code(), "RUNTIME_CONFIG_INVALID");
        assert!(!err.retryable());
    }
}

pub(crate) trait IoContext<T> {
    fn io_ctx(self, path: impl Into<PathBuf>) -> RuntimeResult<T>;
}

impl<T> IoContext<T> for std::io::Result<T> {
    fn io_ctx(self, path: impl Into<PathBuf>) -> RuntimeResult<T> {
        self.map_err(|source| RuntimeError::Io {
            path: path.into(),
            source,
        })
    }
}
