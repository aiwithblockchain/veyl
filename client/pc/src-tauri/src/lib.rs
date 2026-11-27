use tauri::Manager;

pub mod assemble;
pub mod commands;
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
    tauri::Builder::default()
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
            app.manage(state);
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
        ])
        .run(tauri::generate_context!())
        .expect("veyl-cli: failed to launch");
}
