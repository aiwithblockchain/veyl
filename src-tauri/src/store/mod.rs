//! 本地持久化：SQLite（rusqlite，bundled）。
//!
//! schema 版本由 `PRAGMA user_version` 管理。产品尚未发布，数据库整体重建：
//! 只有一份 `001_init.sql`，旧库在打开时被清空重建。
//! 凭据不进库：节点的 `password_ref` 只是 `secrets.enc` 的键。

pub mod catalog_cache;
pub mod chat;
pub mod configs;
pub mod db;
pub mod error;
pub mod issues;
pub mod layout;
pub mod migrations;
pub mod proxy_backup;
pub mod runtime;
pub mod rules_state;
pub mod seed_cache;
pub mod servers;
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

pub use configs::{Config, ConfigPatch, NewConfig, NewNode, Node};
pub use error::{StoreError, StoreResult};
pub use proxy_backup::ProxyBackupRow;
pub use runtime::RuntimeVersionRow;
pub use servers::{MyServerRow, NewMyServer};
pub use tool_calls::{NewCall, ToolCallRecord};

/// 应用数据目录下的库文件名。
pub const DB_FILE_NAME: &str = "veyl.db";

pub fn default_db_path(app_data_dir: impl AsRef<std::path::Path>) -> std::path::PathBuf {
    app_data_dir.as_ref().join(DB_FILE_NAME)
}
