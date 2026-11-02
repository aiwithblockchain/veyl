//! 前端可调用的命令面。命令名已冻结（`docs/contracts/events.md` §5）。

use std::sync::Arc;

use serde_json::{json, Value};
use tauri::State;

use super::AppState;

/// 发起一轮对话。立即返回 request_id，事件在后台推。
#[tauri::command]
pub async fn ai_send_message(
    state: State<'_, Arc<AppState>>,
    session_id: String,
    text: String,
) -> Result<Value, String> {
    let session = state
        .session(&session_id)
        .await
        .map_err(|error| error.to_string())?;

    let request_id = AppState::next_request_id();
    state.track_request(&request_id, &session_id);

    let state_handle = Arc::clone(state.inner());
    let task_request_id = request_id.clone();
    tokio::spawn(async move {
        if let Err(error) = session.send_message(task_request_id.clone(), text).await {
            log::error!("[agent] send_message failed: {error}");
        }
        state_handle.untrack_request(&task_request_id);
    });

    Ok(json!({ "request_id": request_id }))
}

#[tauri::command]
pub async fn ai_cancel(state: State<'_, Arc<AppState>>, request_id: String) -> Result<Value, String> {
    match state.session_for_request(&request_id).await {
        Some(session) => {
            session.cancel().await;
            Ok(json!({ "cancelled": true }))
        }
        None => Ok(json!({ "cancelled": false })),
    }
}

#[tauri::command]
pub async fn ai_approval_decision(
    approval_id: String,
    decision: String,
    scope: String,
) -> Result<Value, String> {
    if decision != "allow" && decision != "deny" {
        return Err(format!("未知的确认结果：{decision}"));
    }
    if scope != "call" && scope != "session" {
        return Err(format!("未知的授权范围：{scope}"));
    }

    let ok = crate::tools::policy::resolve(&approval_id, &decision, &scope);
    Ok(json!({ "ok": ok }))
}

/// 状态快照；事件不可达时 UI 的兜底（契约 §5）。
#[tauri::command]
pub async fn runtime_status(state: State<'_, Arc<AppState>>) -> Result<Value, String> {
    state
        .services
        .runtime_status()
        .await
        .map_err(|error| error.to_string())
}

/// 无 AI 模式的删除配置入口。破坏性操作，无论来源都要审批（events.md §5）。
/// UI 直连没有会话上下文，`session_id` 取固定的 "ui"；ProfileDelete 恒为 call 级。
#[tauri::command]
pub async fn profile_delete(
    state: State<'_, Arc<AppState>>,
    profile_id: String,
) -> Result<Value, Value> {
    if profile_id.trim().is_empty() {
        return Err(json!(crate::tools::AivpnError::new(
            "INVALID_ARGUMENT",
            "profile_id 不能为空"
        )));
    }

    let input = json!({ "profile_id": profile_id });
    let summary = format!("删除本地配置 {profile_id}");
    if let Some(error) =
        crate::tools::policy::require("ui", "ProfileDelete", &input, &summary, "medium")
    {
        return Err(json!(error));
    }

    state
        .services
        .profile_delete(&profile_id)
        .await
        .map_err(|error| json!(crate::tools::AivpnError::new("INTERNAL", error.to_string())))
}
