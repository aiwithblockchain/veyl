use std::path::PathBuf;

#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error("sqlite error: {0}")]
    Sqlite(#[from] rusqlite::Error),

    #[error("io error at {path:?}: {source}")]
    Io {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },

    #[error("数据不合法：{0}")]
    Invalid(String),

    #[error("找不到记录：{0}")]
    NotFound(String),
}

pub type StoreResult<T> = Result<T, StoreError>;

impl StoreError {
    /// 映射到 `docs/contracts/runtime.md` §6 的错误码。
    pub fn code(&self) -> &'static str {
        match self {
            StoreError::Invalid(_) => "INVALID_ARGUMENT",
            StoreError::NotFound(_) => "NOT_FOUND",
            StoreError::Sqlite(_) | StoreError::Io { .. } => "INTERNAL",
        }
    }
}
