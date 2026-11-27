use tauri::{Emitter, Manager};

pub mod assemble;
pub mod commands;
pub mod connection;
pub mod error;
pub mod fetch;
pub mod fsutil;
pub mod kernel_check;
pub mod models;
pub mod platform;
pub mod secrets;
pub mod state;
pub mod store;
pub mod subscription_url;
mod tun_identity;

#[derive(serde::Serialize)]
struct AppInfo {
    name: &'static str,
    version: &'static str,
}

#[tauri::command]
fn app_info() -> AppInfo {
    AppInfo {
        name: env!("CARGO_PKG_NAME"),
        version: env!("CARGO_PKG_VERSION"),
    }
}

pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            // 身份最先注入：连接路径一碰 TUN 就会读它。
            tun_identity::install();
            let data_dir = app
                .path()
                .app_data_dir()
                .map_err(|error| format!("无法定位应用数据目录：{error}"))?;
            let service = app.config().identifier.clone();
            let state = state::AppState::new(data_dir, &service)?;
            {
                // 连接状态一变就推给界面；命令层不再各自发事件。
                let handle = app.handle().clone();
                state.connection.set_observer(std::sync::Arc::new(move |snapshot| {
                    let _ = handle.emit("connection-changed", snapshot.clone());
                }));
            }
            app.manage(state);

            // 上一次 App 没拆干净时，helper 可能还在跑隧道：启动就把状态接过来，
            // 否则界面会显示「未连接」而流量还在隧道里。
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let state = handle.state::<state::AppState>();
                state.connection.adopt_existing().await;
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            app_info,
            commands::profiles_list,
            commands::profiles_active,
            commands::profile_select,
            commands::profile_import_url,
            commands::profile_import_file,
            commands::profile_refresh,
            commands::profile_rename,
            commands::profile_remove,
            commands::profile_detail,
            commands::connect,
            commands::disconnect,
            commands::connection_status,
            commands::switch_node,
        ])
        .build(tauri::generate_context!())
        .expect("veyl-cli: failed to build app");

    app.run(|handle, event| {
        // 显式退出/关窗退出前先拆隧道：关掉进程却留着隧道是最坏的一种「已断开」。
        if let tauri::RunEvent::ExitRequested { api, .. } = event {
            let already = handle
                .state::<state::AppState>()
                .shutdown_started
                .swap(true, std::sync::atomic::Ordering::SeqCst);
            if already {
                return;
            }
            api.prevent_exit();
            let handle = handle.clone();
            tauri::async_runtime::spawn(async move {
                let state = handle.state::<state::AppState>();
                // 清理最多等 15 秒；helper 的停止预算本身是 10 秒。
                let _ = tokio::time::timeout(
                    std::time::Duration::from_secs(15),
                    state.connection.disconnect(),
                )
                .await;
                drop(state);
                handle.exit(0);
            });
        }
    });
}
