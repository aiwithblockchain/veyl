use serde_json::Value;

/// 目录服务的错误，`code` 与 `docs/contracts/catalog.md` §8 一致。
#[derive(Debug, Clone)]
pub struct CatalogError {
    pub code: String,
    pub message: String,
    pub retryable: bool,
    pub details: Option<Value>,
    pub request_id: Option<String>,
}

pub type CatalogResult<T> = Result<T, CatalogError>;

impl CatalogError {
    pub fn new(code: impl Into<String>, message: impl Into<String>, retryable: bool) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            retryable,
            details: None,
            request_id: None,
        }
    }

    pub fn invalid(message: impl Into<String>) -> Self {
        Self::new("INVALID_ARGUMENT", message, false)
    }

    pub fn transport(error: impl std::fmt::Display) -> Self {
        Self::new("UPSTREAM_ERROR", format!("catalog transport: {error}"), true)
    }

    pub fn with_request_id(mut self, request_id: Option<String>) -> Self {
        self.request_id = request_id;
        self
    }

    pub fn with_details(mut self, details: Option<Value>) -> Self {
        self.details = details;
        self
    }

    pub fn is_unauthorized(&self) -> bool {
        matches!(
            self.code.as_str(),
            "DEVICE_TOKEN_INVALID" | "DEVICE_TOKEN_EXPIRED"
        )
    }
}

impl std::fmt::Display for CatalogError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "catalog {}: {}", self.code, self.message)
    }
}

impl std::error::Error for CatalogError {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn device_token_errors_trigger_the_reauth_path() {
        assert!(CatalogError::new("DEVICE_TOKEN_INVALID", "x", false).is_unauthorized());
        assert!(CatalogError::new("DEVICE_TOKEN_EXPIRED", "x", false).is_unauthorized());
        assert!(!CatalogError::new("NODE_NOT_FOUND", "x", false).is_unauthorized());
        assert!(!CatalogError::new("RATE_LIMITED", "x", true).is_unauthorized());
    }
}
