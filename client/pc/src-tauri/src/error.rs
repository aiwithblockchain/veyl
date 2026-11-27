//! 统一错误：命令层直接把它序列化给前端。
//!
//! 文案按仓库约定三段式：`message` 说发生了什么，`hint` 说现在做什么，
//! 中间的「为什么」由 `reason` 承担（可为空）。界面上不出现令牌或完整 URL。

use serde::Serialize;

#[derive(Debug, Clone, Serialize, thiserror::Error)]
#[error("{message}")]
pub struct AppError {
    /// 稳定的机器可读码，前端按码分支，不解析文案。
    pub code: &'static str,
    /// 发生了什么。
    pub message: String,
    /// 为什么（可选）。
    pub reason: String,
    /// 现在做什么。
    pub hint: String,
}

pub type AppResult<T> = Result<T, AppError>;

impl AppError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            reason: String::new(),
            hint: String::new(),
        }
    }

    pub fn with_reason(mut self, reason: impl Into<String>) -> Self {
        self.reason = reason.into();
        self
    }

    pub fn with_hint(mut self, hint: impl Into<String>) -> Self {
        self.hint = hint.into();
        self
    }

    pub fn invalid(message: impl Into<String>) -> Self {
        Self::new("INVALID_ARGUMENT", message)
    }

    pub fn internal(message: impl Into<String>) -> Self {
        Self::new("INTERNAL", message)
    }

    pub fn not_found(message: impl Into<String>) -> Self {
        Self::new("NOT_FOUND", message)
    }
}

impl From<std::io::Error> for AppError {
    fn from(error: std::io::Error) -> Self {
        Self::new("INTERNAL", format!("读写本地文件失败：{error}"))
            .with_hint("重试一次；仍然失败就检查应用数据目录的权限。")
    }
}

impl From<serde_json::Error> for AppError {
    fn from(error: serde_json::Error) -> Self {
        Self::new("CONFIG_INVALID", format!("配置不是合法 JSON：{error}"))
            .with_hint("重新导入一份 sing-box 配置。")
    }
}
