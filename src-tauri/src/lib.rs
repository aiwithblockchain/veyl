//! Veyl host library.
//!
//! 模块由 PM 统一接线；此文件只声明模块与 Tauri 启动入口。

pub mod agent;
pub mod catalog;
pub mod claurst_session;
pub mod config;
pub mod logging;
pub mod proxy;
pub mod runtime;
pub mod secrets;
pub mod seed_import;
pub mod store;
pub mod tools;

use std::sync::Arc;

use crate::proxy::{ProxyController, SqliteBackupStore};
use crate::runtime::{RuntimeConfig, RuntimeManager};
use crate::store::Store;
use crate::tools::VpnToolServices;
use crate::tools::services::WiredServices;

const DEFAULT_CATALOG_URL: &str = "http://127.0.0.1:18090/v1";

fn catalog_base_url(store: &Store) -> String {
    if let Ok(url) = std::env::var("VEYL_CATALOG_URL") {
        if !url.trim().is_empty() {
            return url;
        }
    }
    let conn = store.conn();
    crate::store::settings::get(&conn, "catalog_base_url")
        .ok()
        .flatten()
        .filter(|url| !url.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_CATALOG_URL.to_string())
}

pub fn run() {
    let data_dir = crate::runtime::default_app_data_dir();
    // 日志最先初始化：后面每一步失败都要能落盘。
    crate::logging::init(&data_dir);
    // 本地加密凭据文件；不访问系统钥匙串。
    crate::secrets::install(&data_dir);

    let store = match Store::open(crate::store::default_db_path(&data_dir)) {
        Ok(store) => Arc::new(store),
        Err(error) => {
            log::error!("本地数据库打开失败，改用内存库：{error}");
            Arc::new(Store::open_in_memory().expect("内存数据库也打不开"))
        }
    };

    crate::store::install_global(Arc::clone(&store));

    let manager = RuntimeManager::new(RuntimeConfig::new(&data_dir));
    let proxy = Arc::new(ProxyController::new(Box::new(SqliteBackupStore::new(
        Arc::clone(&store),
    ))));

    // 异常退出后不留系统代理：启动时先看 proxy_backup，有残留就恢复。
    match proxy.recover_stale() {
        Ok(crate::proxy::RecoveryOutcome::Recovered { endpoint }) => {
            log::warn!("已恢复上次异常退出遗留的系统代理（{endpoint}）");
        }
        Ok(crate::proxy::RecoveryOutcome::LeftAlone { current, .. }) => {
            log::warn!("检测到未清理的代理备份，但当前代理是 {current}，按用户设置保留");
        }
        Ok(crate::proxy::RecoveryOutcome::Nothing) => {}
        Err(error) => log::error!("系统代理恢复失败：{error}"),
    }

    let catalog = Arc::new(crate::catalog::CatalogClient::new(catalog_base_url(&store)));
    let services: Arc<dyn VpnToolServices> = Arc::new(WiredServices::new(
        Arc::clone(&store),
        manager,
        proxy,
        catalog,
        &data_dir,
    ));
    let state = Arc::new(agent::AppState::new(services));
    // 工具路径没有 AppState 句柄，热更新凭据靠这个弱引用。
    agent::install_app_state(&state);

    tauri::Builder::default()
        .manage(Arc::clone(&state))
        .setup(|app| {
            // 工具事件（tool-call-start 等）需要全局句柄。
            agent::app_handle::set(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            agent::commands::ai_send_message,
            agent::commands::ai_cancel,
            agent::commands::runtime_status,
            agent::commands::profile_delete,
            agent::commands::chat_history,
            agent::commands::deepseek_save_key,
            agent::commands::deepseek_key_status,
            agent::commands::deepseek_clear_key,
            agent::commands::rename_session,
        ])
        .run(tauri::generate_context!())
        .expect("Veyl 启动失败");
}
