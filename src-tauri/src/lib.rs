//! Veyl host library.
//!
//! 模块由 PM 统一接线；此文件只声明模块与 Tauri 启动入口。

pub mod agent;
pub mod catalog;
pub mod claurst_session;
pub mod config;
pub mod lifecycle;
pub mod llm;
pub mod logging;
pub mod netcfg;
pub mod nodes;
pub mod proxy;
pub mod public_http;
pub mod runtime;
pub mod rules;
pub mod secrets;
pub mod seed;
pub mod store;
pub mod tools;
pub mod tun;

#[cfg(test)]
mod test_support;

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
    let menu_parts = lifecycle_parts.clone();

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

    // ---- 启动序列：一行一条，故障时能直接看出「应用此刻认为自己处于什么状态」 ----
    log::info!("启动 data_dir={}", short_path(&data_dir));
    log::info!("启动 数据库={}", short_path(&crate::store::default_db_path(&data_dir)));
    match crate::runtime::Installer::new(&data_dir).active() {
        Ok(Some(rt)) => log::info!("启动 运行时={} ({})", rt.version, short_path(&rt.binary)),
        Ok(None) => log::info!("启动 运行时=未安装"),
        Err(error) => log::warn!("启动 运行时状态读取失败：{error}"),
    }
    log::info!(
        "启动 种子节点={}",
        crate::seed::load_nodes(&store).map(|nodes| nodes.len()).unwrap_or(0)
    );
    log::info!(
        "启动 AI provider={:?} 可用={}",
        crate::llm::active_id(&store),
        crate::llm::has_any_usable(&store)
    );
    log::info!(
        "启动 TUN helper={}",
        crate::tun::privilege::select().status().as_str()
    );

    let setup_store = Arc::clone(&store);
    let rules_data_dir = data_dir.clone();

    let app = tauri::Builder::default()
        // 单实例必须是第一个插件：它的 setup 在 Builder::build 阶段执行，
        // 检测到第二实例会立刻 process::exit(0)，早于下面的用户 setup。
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            lifecycle::show_main_window(app);
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(Arc::clone(&state))
        .setup(move |app| {            // 旧 Key 迁移只补元数据，幂等；放在 setup 里，第二实例不会执行。
            crate::llm::ensure_migrated(&setup_store);
            crate::agent::refresh_credentials();

            // 自建应用菜单：Cmd+Q 必须由我们接管。
            // macOS 默认 Quit 走 NSApp terminate，会绕过 ExitRequested。
            if let Err(error) = install_app_menu(app.handle()) {
                log::error!("应用菜单创建失败，Cmd+Q 仍由 ExitRequested 兜底：{error}");
            }
            // 菜单事件必须在 setup 里注册（对齐 TweetPilot 的写法）。
            app.on_menu_event(move |app, event| {
                if event.id().as_ref() == "app-quit" {
                    log::info!("菜单退出被拦截");
                    lifecycle::on_exit_requested(app, menu_parts.clone());
                }
            });

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

            // 运行时把状态迁移与健康检查发进内部 broadcast，前端订阅的是 Tauri 事件。
            // 这里只做序列化转发：不查状态、不加锁，否则会与状态迁移脱节。
            let mut runtime_events = recovery_parts.manager.subscribe();
            tauri::async_runtime::spawn(async move {
                loop {
                    match runtime_events.recv().await {
                        Ok(event) => {
                            match crate::runtime::runtime_event_to_emit(&event) {
                                Some((name, payload)) => agent::app_handle::emit(name, payload),
                                None => log::warn!("运行时事件序列化失败：{event:?}"),
                            }
                        }
                        Err(tokio::sync::broadcast::error::RecvError::Lagged(skipped)) => {
                            log::warn!("运行时事件转发落后 {skipped} 条，继续");
                        }
                        Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                    }
                }
            });

            // 规则数据：随包归档 → app_data/rules/<version>/。失败不阻塞启动，
            // 生成分流配置时再报 RULES_NOT_READY。
            let resource_dir = app.path().resource_dir().ok();
            match crate::rules::install_bundled(
                &setup_store,
                &rules_data_dir,
                resource_dir.as_deref(),
            ) {
                Ok(rules) => log::info!(
                    "规则数据就绪：{} · {} 个规则集",
                    rules.manifest.version,
                    rules.manifest.items.len()
                ),
                Err(error) => log::warn!("规则数据未就绪：{error}"),
            }

            // 默认节点刷新：首次没有缓存时立即拉取；有缓存时启动 5 分钟后
            // 再检查，之后每 6 小时一次。失败保留缓存，不阻塞启动。
            let refresh_store = Arc::clone(&setup_store);
            let refresh_manager = Arc::clone(&recovery_parts.manager);
            tauri::async_runtime::spawn(async move {
                // 判「内容能不能用」，不是「行在不在」：
                // `secrets.enc` 丢过之后元数据还在，只看行会误判成「有缓存」，
                // 于是白等 5 分钟才去修。和 `seed::refresh` 里那三处是同一个判据。
                let has_cache = crate::seed::load_nodes(&refresh_store).is_some();
                if has_cache {
                    tokio::time::sleep(std::time::Duration::from_secs(5 * 60)).await;
                }
                loop {
                    let running = matches!(
                        refresh_manager.status().await.state,
                        crate::runtime::RuntimeState::Running
                            | crate::runtime::RuntimeState::Degraded
                    );
                    match crate::seed::refresh(&refresh_store, running, false).await {
                        crate::seed::RefreshOutcome::Offline { cached, error } => {
                            log::warn!("默认节点刷新失败（cached={cached}）：{error}")
                        }
                        outcome => log::info!("默认节点刷新：{outcome:?}"),
                    }
                    tokio::time::sleep(crate::seed::REFRESH_INTERVAL).await;
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
        .invoke_handler({
            // 在**唯一的分发点**统一记录：前端点了什么命令、带了什么参数、多久返回。
            // 39 个命令逐个加日志既容易漏，也会让每个函数都变长。
            let handler: fn(tauri::ipc::Invoke<tauri::Wry>) -> bool = tauri::generate_handler![
            agent::commands::ai_send_message,
            agent::commands::ai_cancel,
            agent::commands::runtime_status,
            agent::commands::runtime_start,
            agent::commands::runtime_stop,
            agent::commands::config_list,
            agent::commands::config_detail,
            agent::commands::config_create,
            agent::commands::config_update,
            agent::commands::config_delete,
            agent::commands::config_activate,
            agent::commands::node_import_url,
            agent::commands::node_create,
            agent::commands::node_switch,
            agent::commands::node_probe,
            agent::commands::route_get,
            agent::commands::route_set_mode,
            agent::commands::route_targets_set,
            agent::commands::default_profile_status,
            agent::commands::default_profile_refresh,
            agent::commands::import_seed_file,
            agent::commands::rules_status,
            agent::commands::category_list,
            agent::commands::net_repair,
            agent::commands::open_log_dir,
            agent::commands::open_external,
            agent::commands::tun_helper_open_settings,
            agent::commands::tun_helper_uninstall,
            agent::commands::chat_history,
            agent::commands::chat_delete,
            agent::commands::reply_user_question,
            agent::commands::list_pending_questions,
            agent::commands::deepseek_save_key,
            agent::commands::deepseek_key_status,
            agent::commands::deepseek_clear_key,
            agent::commands::llm_provider_list,
            agent::commands::llm_provider_save,
            agent::commands::llm_provider_delete,
            agent::commands::llm_provider_activate,
            agent::commands::llm_provider_test,
            agent::commands::rename_session,
        ];
            move |invoke: tauri::ipc::Invoke<tauri::Wry>| {
                let command = invoke.message.command().to_string();
                let args = describe_invoke_args(invoke.message.payload());
                let started = std::time::Instant::now();
                let handled = handler(invoke);
                let elapsed = started.elapsed().as_millis();
                if handled {
                    log::debug!("命令 {command} {elapsed}ms args={args}");
                } else {
                    log::warn!("命令 {command} 没有对应的处理函数");
                }
                handled
            }
        })
        .build(tauri::generate_context!())
        .expect("Veyl 启动失败");

    app.run(move |handle, event| {
        if let tauri::RunEvent::ExitRequested { api, code, .. } = event {
            // 实测 Cmd+Q 也可能带 Some(0)，不能用 code 区分来源。
            // 只认自己的 QUITTING：app.exit(0) 前已置位，二次触发时放行。
            if !lifecycle::should_intercept_exit(lifecycle::is_quitting(), code) {
                return;
            }
            api.prevent_exit();
            lifecycle::on_exit_requested(handle, exit_parts.clone());
        }
    });
}

/// 日志里只留路径最后两段：本地日志没必要写全路径。
fn short_path(path: &std::path::Path) -> String {
    let parts: Vec<_> = path
        .components()
        .rev()
        .take(2)
        .map(|part| part.as_os_str().to_string_lossy().to_string())
        .collect();
    parts.into_iter().rev().collect::<Vec<_>>().join("/")
}

/// 把命令参数渲染成一行：**先脱敏再序列化**，敏感字段永远是 `***`。
fn describe_invoke_args(body: &tauri::ipc::InvokeBody) -> String {
    match body {
        tauri::ipc::InvokeBody::Json(value) => crate::logging::redact_json(value).to_string(),
        tauri::ipc::InvokeBody::Raw(bytes) => format!("<raw {} 字节>", bytes.len()),
    }
}

/// 自建应用菜单：接管 Cmd+Q，并保留常用编辑/窗口快捷键。
/// 结构对齐 TweetPilot 的 main.rs（File / Edit / View / Window / Help）。
fn install_app_menu(app: &tauri::AppHandle) -> tauri::Result<()> {
    use tauri::menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder};

    let quit = MenuItemBuilder::with_id("app-quit", "退出 Veyl")
        .accelerator("CmdOrCtrl+Q")
        .build(app)?;

    let file_menu = SubmenuBuilder::new(app, "文件")
        .close_window()
        .separator()
        .item(&quit)
        .build()?;

    let edit_menu = SubmenuBuilder::new(app, "编辑")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .build()?;

    let view_menu = SubmenuBuilder::new(app, "显示").build()?;

    let window_menu = SubmenuBuilder::new(app, "窗口")
        .minimize()
        .maximize()
        .build()?;

    let help_menu = SubmenuBuilder::new(app, "帮助").build()?;

    let menu = MenuBuilder::new(app)
        .item(&file_menu)
        .item(&edit_menu)
        .item(&view_menu)
        .item(&window_menu)
        .item(&help_menu)
        .build()?;
    app.set_menu(menu)?;
    Ok(())
}
