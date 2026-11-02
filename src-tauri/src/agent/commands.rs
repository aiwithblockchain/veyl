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

    let resolved = crate::tools::policy::resolve(&approval_id, &decision, &scope);

    if let Some(resolved) = &resolved {
        if let Some(store) = crate::store::global() {
            let approval = if !resolved.granted {
                crate::store::Approval::Denied
            } else if resolved.scope == "session" {
                crate::store::Approval::Session
            } else {
                crate::store::Approval::Once
            };
            let conn = store.conn();
            let _ = crate::store::tool_calls::record_approval_for(
                &conn,
                &resolved.session_id,
                &resolved.tool,
                approval,
            );
        }
    }

    Ok(json!({ "ok": resolved.is_some() }))
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

/// 重启后恢复会话：不传 `session_id` 时取最近一个会话。
#[tauri::command]
pub async fn chat_history(session_id: Option<String>) -> Result<Value, String> {
    let Some(store) = crate::store::global() else {
        return Ok(json!({ "sessions": [], "active_session_id": null, "messages": [] }));
    };
    let conn = store.conn();

    let sessions = crate::store::chat::list_sessions(&conn).map_err(|e| e.to_string())?;
    let active = match session_id {
        Some(id) => Some(id),
        None => crate::store::chat::latest_session(&conn)
            .map_err(|e| e.to_string())?
            .map(|session| session.id),
    };
    let messages = match &active {
        Some(id) => crate::store::chat::messages(&conn, id).map_err(|e| e.to_string())?,
        None => Vec::new(),
    };

    Ok(json!({
        "sessions": sessions
            .iter()
            .map(|session| json!({
                "id": session.id,
                "title": session.title,
                "created_at": crate::store::iso_from_ms(session.created_at),
            }))
            .collect::<Vec<_>>(),
        "active_session_id": active,
        "messages": messages
            .iter()
            .map(|message| json!({
                "id": message.id,
                "role": message.role,
                "content": message.content,
                "created_at": crate::store::iso_from_ms(message.created_at),
            }))
            .collect::<Vec<_>>(),
    }))
}

/// 设置页保存 DeepSeek Key。与工具路径共用 `secrets::save_deepseek_key`。
/// 返回值绝不包含明文 Key。
#[tauri::command]
pub async fn deepseek_save_key(key: String) -> Result<Value, Value> {
    match crate::secrets::save_deepseek_key(&key).await {
        Ok(outcome) => {
            if outcome.validation == "invalid" {
                return Err(json!({
                    "code": "INVALID_KEY",
                    "message": "DeepSeek 鉴权失败，Key 可能无效或已被吊销",
                }));
            }
            Ok(json!({
                "masked": outcome.masked,
                "verified": outcome.validation == "ok",
            }))
        }
        Err(error) => Err(json!({
            "code": error.ui_code(),
            "message": error.message(),
        })),
    }
}

/// 设置页显示当前是否已配置；只回掩码。
#[tauri::command]
pub async fn deepseek_key_status() -> Result<Value, Value> {
    match crate::secrets::key_status() {
        Ok((configured, masked)) => Ok(json!({ "configured": configured, "masked": masked })),
        Err(error) => Err(json!({
            "code": "KEYCHAIN",
            "message": error.to_string(),
        })),
    }
}
