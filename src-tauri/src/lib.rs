//! AIVPN host library.
//!
//! 模块由 PM 统一接线；此文件只声明模块与 Tauri 启动入口。

pub mod agent;
pub mod catalog;
pub mod claurst_session;
pub mod config;
pub mod proxy;
pub mod runtime;
pub mod tools;

use std::sync::Arc;

use crate::tools::VpnToolServices;

pub fn run() {
    // P1 W1–W2：真实后端尚未接线，工具返回明确的「尚未接线」错误。
    // W3 换成 Runtime Manager + Connection Orchestrator 的实现即可，工具层不用动。
    let services: Arc<dyn VpnToolServices> = Arc::new(crate::tools::NotWiredServices);
    let state = Arc::new(agent::AppState::new(services));

    tauri::Builder::default()
        .manage(Arc::clone(&state))
        .setup(|app| {
            // 审批事件从工具实现里发出，需要全局句柄。
            agent::app_handle::set(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            agent::commands::ai_send_message,
            agent::commands::ai_cancel,
            agent::commands::ai_approval_decision,
            agent::commands::runtime_status,
        ])
        .run(tauri::generate_context!())
        .expect("AIVPN 启动失败");
}
