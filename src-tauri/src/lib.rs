//! Veyl host library.
//!
//! 模块由 PM 统一接线；此文件只声明模块与 Tauri 启动入口。

pub mod agent;
pub mod catalog;
pub mod claurst_session;
pub mod config;
pub mod default_profile;
pub mod lifecycle;
pub mod logging;
pub mod netcfg;
pub mod proxy;
pub mod runtime;
pub mod secrets;
pub mod seed_import;
pub mod store;
pub mod tools;

use std::sync::Arc;

use tauri::Manager;

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

    // 运行时进入 Failed（重启失败、重试耗尽）时撤销系统代理。
    // 运行时不直接持有代理：分层靠这个钩子，由宿主接线。disable 是幂等的。
    let failure_proxy = Arc::clone(&proxy);
    manager.set_terminal_failure_hook(Arc::new(move || {
        if let Err(error) = failure_proxy.disable() {
            log::warn!("运行时失败后解除系统代理失败：{error}");
        }
    }));

    // 异常退出后的恢复动作不能在这里做：第二实例会先跑完这些步骤才被单实例插件发现，
    // 从而撤掉第一实例的代理、杀掉它的 sing-box。它们统一放进 `.setup()`，见下方。
    let config_dir = data_dir.join("config");

    // 退出与托盘共用的句柄。运行时、代理与配置目录都从这里取。
    let lifecycle_parts = lifecycle::Parts {
        proxy: Arc::clone(&proxy),
        manager: Arc::clone(&manager),
        config_dir: config_dir.clone(),
    };
    let tray_parts = lifecycle_parts.clone();
    let exit_parts = lifecycle_parts.clone();
    let recovery_parts = lifecycle_parts.clone();

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

    let setup_store = Arc::clone(&store);

    let app = tauri::Builder::default()
        // 单实例必须是第一个插件：它的 setup 在 Builder::build 阶段执行，
        // 检测到第二实例会立刻 process::exit(0)，早于下面的用户 setup。
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            lifecycle::show_main_window(app);
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(Arc::clone(&state))
        .setup(move |app| {
            // 恢复动作只能放在这里：第二实例在插件 setup 就退出了，
            // 不会撤掉第一实例的代理、杀它的 sing-box、删它的配置。
            match recovery_parts.proxy.recover_stale() {
                Ok(crate::proxy::RecoveryOutcome::Recovered { endpoint }) => {
                    log::warn!("已恢复上次异常退出遗留的系统代理（{endpoint}）");
                }
                Ok(crate::proxy::RecoveryOutcome::LeftAlone { current, .. }) => {
                    log::warn!("检测到未清理的代理备份，但当前代理是 {current}，按用户设置保留");
                }
                Ok(crate::proxy::RecoveryOutcome::Nothing) => {}
                Err(error) => log::error!("系统代理恢复失败：{error}"),
            }

            match tauri::async_runtime::block_on(recovery_parts.manager.reclaim_stale()) {
                Ok(Some(pid)) => log::warn!("启动时回收了遗留的 sing-box pid={pid}"),
                Ok(None) => {}
                Err(error) => log::warn!("回收遗留 sing-box 失败：{error}"),
            }

            let swept =
                crate::config::remove_all_profile_configs(&recovery_parts.config_dir);
            if swept > 0 {
                log::warn!("启动时清理了 {swept} 个遗留的明文配置文件");
            }

            // 工具事件（tool-call-start 等）需要全局句柄。
            agent::app_handle::set(app.handle().clone());

            // 默认配置包刷新：启动后一次，之后每 6 小时；在线时只标记新版本。
            let refresh_store = Arc::clone(&setup_store);
            let refresh_manager = Arc::clone(&recovery_parts.manager);
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_secs(3)).await;
                loop {
                    let running = matches!(
                        refresh_manager.status().await.state,
                        crate::runtime::RuntimeState::Running
                            | crate::runtime::RuntimeState::Degraded
                    );
                    match crate::default_profile::refresh(&refresh_store, running).await {
                        Ok(outcome) => log::info!("默认配置刷新：{outcome:?}"),
                        Err(error) => log::warn!("默认配置刷新失败（保留缓存）：{error}"),
                    }
                    tokio::time::sleep(crate::default_profile::REFRESH_INTERVAL).await;
                }
            });

            // 托盘失败不能阻止应用启动。
            if let Err(error) = lifecycle::setup_tray(app.handle(), tray_parts.clone()) {
                log::error!("托盘创建失败，应用继续运行：{error}");
            }
            Ok(())
        })
        // 红灯 / Cmd+W：只隐藏，不退出、不提示。只对主窗口生效。
        .on_window_event(|window, event| {
            if window.label() != "main" {
                return;
            }
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                lifecycle::hide_main_window(window.app_handle());
            }
        })
        .invoke_handler(tauri::generate_handler![
            agent::commands::ai_send_message,
            agent::commands::ai_cancel,
            agent::commands::runtime_status,
            agent::commands::runtime_start,
            agent::commands::runtime_stop,
            agent::commands::profile_list,
            agent::commands::profile_delete,
            agent::commands::default_profile_status,
            agent::commands::default_profile_refresh,
            agent::commands::net_repair,
            agent::commands::onboarding_status,
            agent::commands::onboarding_complete,
            agent::commands::open_log_dir,
            agent::commands::open_external,
            agent::commands::chat_history,
            agent::commands::chat_delete,
            agent::commands::deepseek_save_key,
            agent::commands::deepseek_key_status,
            agent::commands::deepseek_clear_key,
            agent::commands::rename_session,
            agent::commands::import_seed_file,
        ])
        .build(tauri::generate_context!())
        .expect("Veyl 启动失败");

    app.run(move |handle, event| {
        if let tauri::RunEvent::ExitRequested { api, code, .. } = event {
            // 我们自己调 app.exit(0) 时 code 是 Some，直接放行。
            if code.is_some() {
                return;
            }
            // 用户发起的退出一律先拦下：退出流程正在跑就不重复弹窗，
            // 否则交给阻塞对话框决定。
            api.prevent_exit();
            if lifecycle::is_quitting() {
                return;
            }
            lifecycle::on_exit_requested(handle, exit_parts.clone());
        }
    });
}
