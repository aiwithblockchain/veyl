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

    // 用户输入在入口落库：claurst 只对 assistant/results 发 MessageCommitted，
    // 不依赖事件补写，避免重复。
    if let Some(store) = crate::store::global() {
        let conn = store.conn();
        let _ = crate::store::chat::append_message(
            &conn,
            &crate::store::chat::new_message_id(),
            &session_id,
            "user",
            &text,
            None,
        );
    }

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
pub async fn deepseek_save_key(
    state: State<'_, Arc<AppState>>,
    key: String,
) -> Result<Value, Value> {
    match crate::secrets::save_deepseek_key(&key).await {
        Ok(outcome) => {
            // 钥匙串写成功后立刻热更新内存，下一次对话就用新 Key。
            state.apply_credentials(Some(key.trim().to_string()));
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

/// 设置页显示当前是否已配置；读内存，保证与「保存后立即生效」一致。
#[tauri::command]
pub async fn deepseek_key_status(state: State<'_, Arc<AppState>>) -> Result<Value, Value> {
    Ok(json!({
        "configured": state.has_credentials(),
        "masked": state.masked_key(),
    }))
}

/// 清除 Key：钥匙串与内存一起清，避免「钥匙串没了但内存还留着」。
#[tauri::command]
pub async fn deepseek_clear_key(state: State<'_, Arc<AppState>>) -> Result<Value, Value> {
    match crate::secrets::delete_deepseek_key() {
        Ok(()) => {
            state.apply_credentials(None);
            Ok(json!({ "cleared": true }))
        }
        Err(error) => Err(json!({
            "code": "KEYCHAIN",
            "message": error.to_string(),
        })),
    }
}


pub const MAX_TITLE_CHARS: usize = 80;

/// 先 trim 再校验：空标题、超长都返回契约里的 INVALID_ARGUMENT + details.reason。
/// 80 是 Unicode 标量数，不是字节数——80 个汉字与 80 个字母同样合法。
fn normalise_title(title: &str) -> Result<&str, Value> {
    let trimmed = title.trim();
    if trimmed.is_empty() {
        return Err(json!({
            "code": "INVALID_ARGUMENT",
            "message": "标题不能为空",
            "details": { "reason": "empty_title" },
        }));
    }

    let length = trimmed.chars().count();
    if length > MAX_TITLE_CHARS {
        return Err(json!({
            "code": "INVALID_ARGUMENT",
            "message": format!("标题最多 {MAX_TITLE_CHARS} 个字符"),
            "details": {
                "reason": "title_too_long",
                "max": MAX_TITLE_CHARS,
                "actual": length,
            },
        }));
    }

    Ok(trimmed)
}

/// 会话重命名。先 trim 再校验、再落库；契约 events.md §5.1。
#[tauri::command]
pub async fn rename_session(session_id: String, title: String) -> Result<Value, Value> {
    let trimmed = normalise_title(&title)?;

    let Some(store) = crate::store::global() else {
        return Err(json!({
            "code": "INTERNAL",
            "message": "本地数据库不可用",
        }));
    };

    let conn = store.conn();
    match crate::store::chat::rename_session(&conn, &session_id, trimmed) {
        Ok(session) => Ok(json!({
            "id": session.id,
            "title": session.title,
            "created_at": crate::store::iso_from_ms(session.created_at),
        })),
        Err(crate::store::StoreError::NotFound(_)) => Err(json!({
            "code": "NOT_FOUND",
            "message": "会话不存在",
        })),
        Err(error) => Err(json!({
            "code": "INTERNAL",
            "message": error.to_string(),
        })),
    }
}

#[cfg(test)]
mod title_tests {
    use super::*;

    #[test]
    fn trims_surrounding_whitespace() {
        assert_eq!(normalise_title("  东京节点  ").unwrap(), "东京节点");
    }

    #[test]
    fn an_empty_or_blank_title_is_rejected() {
        for candidate in ["", "   ", "\n\t"] {
            let error = normalise_title(candidate).unwrap_err();
            assert_eq!(error["code"], "INVALID_ARGUMENT");
            assert_eq!(error["details"]["reason"], "empty_title");
        }
    }

    #[test]
    fn eighty_unicode_scalars_are_allowed_and_eighty_one_are_not() {
        let allowed = "汉".repeat(MAX_TITLE_CHARS);
        assert_eq!(normalise_title(&allowed).unwrap(), allowed);

        let too_long = "汉".repeat(MAX_TITLE_CHARS + 1);
        let error = normalise_title(&too_long).unwrap_err();
        assert_eq!(error["code"], "INVALID_ARGUMENT");
        assert_eq!(error["details"]["reason"], "title_too_long");
        assert_eq!(error["details"]["max"], MAX_TITLE_CHARS);
        assert_eq!(error["details"]["actual"], MAX_TITLE_CHARS + 1);
    }

    #[test]
    fn length_counts_scalars_not_bytes() {
        // 80 个汉字是 240 字节，按字节算会被误判成超长。
        let mixed = "汉".repeat(40) + &"a".repeat(40);
        assert_eq!(mixed.len(), 160);
        assert!(normalise_title(&mixed).is_ok());
    }
}
