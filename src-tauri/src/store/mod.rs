//! 本地持久化：SQLite（rusqlite，bundled）。
//!
//! schema 版本由 `PRAGMA user_version` 管理，每段迁移幂等、只追加不修改。
//! 凭据不进库：`profiles.config_json` 写入前会做一次键名扫描。

pub mod catalog_cache;
pub mod chat;
pub mod db;
pub mod error;
pub mod migrations;
pub mod profiles;
pub mod proxy_backup;
pub mod runtime;
pub mod settings;
pub mod tool_calls;

pub use db::{iso_from_ms, now_ms, Store};

use std::sync::{Arc, OnceLock};

/// 进程级句柄：审计与聊天记录写入点分散在工具层，统一从这里取库。
static GLOBAL: OnceLock<Arc<Store>> = OnceLock::new();

pub fn install_global(store: Arc<Store>) {
    let _ = GLOBAL.set(store);
}

pub fn global() -> Option<&'static Arc<Store>> {
    GLOBAL.get()
}
pub use error::{StoreError, StoreResult};
pub use profiles::{NewProfile, Profile};
pub use proxy_backup::ProxyBackupRow;
pub use runtime::RuntimeVersionRow;
pub use tool_calls::{Approval, NewCall, ToolCallRecord};

/// 应用数据目录下的库文件名。
pub const DB_FILE_NAME: &str = "veyl.db";

pub fn default_db_path(app_data_dir: impl AsRef<std::path::Path>) -> std::path::PathBuf {
    app_data_dir.as_ref().join(DB_FILE_NAME)
}

