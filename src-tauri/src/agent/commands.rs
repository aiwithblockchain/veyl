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

/// 状态快照；事件不可达时 UI 的兜底（契约 §5）。
#[tauri::command]
pub async fn runtime_status(state: State<'_, Arc<AppState>>) -> Result<Value, String> {
    state
        .services
        .runtime_status()
        .await
        .map_err(|error| error.to_string())
}

/// 服务层错误已经是结构化的 `ServiceError`；还原成契约里的 AivpnError 形状。
fn error_value(error: anyhow::Error) -> Value {
    if let Some(service) = error.downcast_ref::<crate::tools::services::ServiceError>() {
        return json!({
            "contract_version": crate::runtime::EVENT_CONTRACT_VERSION,
            "code": service.code,
            "message": service.message,
            "retryable": service.retryable,
            "details": service.details,
            "request_id": "",
        });
    }

    let text = error.to_string();
    match text.split_once(": ") {
        Some((code, message))
            if !code.is_empty()
                && code
                    .chars()
                    .all(|c| c.is_ascii_uppercase() || c == '_') =>
        {
            json!({
                "contract_version": crate::runtime::EVENT_CONTRACT_VERSION,
                "code": code,
                "message": message,
                "retryable": false,
                "details": null,
                "request_id": "",
            })
        }
        _ => json!({
            "contract_version": crate::runtime::EVENT_CONTRACT_VERSION,
            "code": "INTERNAL",
            "message": text,
            "retryable": false,
            "details": null,
            "request_id": "",
        }),
    }
}

/// 面板主按钮：连接。`profileId` 省略时用当前激活配置。
#[tauri::command]
pub async fn runtime_start(
    state: State<'_, Arc<AppState>>,
    profile_id: Option<String>,
) -> Result<Value, Value> {
    state
        .services
        .runtime_start(profile_id)
        .await
        .map_err(error_value)
}

/// 面板主按钮：断开。
#[tauri::command]
pub async fn runtime_stop(state: State<'_, Arc<AppState>>) -> Result<Value, Value> {
    state.services.runtime_stop(false).await.map_err(error_value)
}

/// 节点切换列表。与工具通道同名同序：`profile_id` + `active_profile_id` + `node_id`。
#[tauri::command]
pub async fn profile_list(state: State<'_, Arc<AppState>>) -> Result<Value, Value> {
    let data = state.services.profile_list().await.map_err(error_value)?;
    let mut profiles = data
        .get("profiles")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    // 与工具一致：created_at 升序。
    profiles.sort_by(|left, right| {
        let left = left.get("created_at").and_then(Value::as_str).unwrap_or("");
        let right = right.get("created_at").and_then(Value::as_str).unwrap_or("");
        left.cmp(right)
    });

    Ok(json!({
        "profiles": profiles
            .iter()
            .map(|profile| json!({
                "profile_id": profile.get("profile_id").cloned().unwrap_or(Value::Null),
                "node_id": profile.get("node_id").cloned().unwrap_or(Value::Null),
                "name": profile.get("name").cloned().unwrap_or(Value::Null),
                "protocol": profile.get("protocol").cloned().unwrap_or(Value::Null),
                "region": profile.get("region").cloned().unwrap_or(Value::Null),
                "is_active": profile.get("is_active").cloned().unwrap_or(Value::Bool(false)),
                "created_at": profile.get("created_at").cloned().unwrap_or(Value::Null),
            }))
            .collect::<Vec<_>>(),
        "active_profile_id": data.get("active_profile_id").cloned().unwrap_or(Value::Null),
    }))
}

/// 面板三级折叠里的「打开日志」：用系统文件管理器定位到日志文件。
/// 不接受路径参数，避免变成任意文件打开入口。
#[tauri::command]
pub async fn open_log_dir() -> Result<Value, Value> {
    let logs_dir = crate::runtime::default_app_data_dir().join("logs");
    let Some(target) = latest_log_file(&logs_dir) else {
        return Err(json!({
            "code": "NOT_FOUND",
            "message": "还没有日志，先连接一次",
            "details": { "hint": "还没有日志，先连接一次" },
        }));
    };
    reveal_in_file_manager(&target)
        .map_err(|error| json!({ "code": "INTERNAL", "message": error }))?;
    Ok(json!({ "path": target.to_string_lossy() }))
}

fn latest_log_file(dir: &std::path::Path) -> Option<std::path::PathBuf> {
    std::fs::read_dir(dir)
        .ok()?
        .flatten()
        .filter_map(|entry| {
            let path = entry.path();
            if !path.is_file() {
                return None;
            }
            let modified = entry.metadata().ok().and_then(|meta| meta.modified().ok())?;
            Some((modified, path))
        })
        .max_by_key(|(modified, _)| *modified)
        .map(|(_, path)| path)
}

fn reveal_in_file_manager(path: &std::path::Path) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    let status = std::process::Command::new("open")
        .arg("-R")
        .arg(path)
        .status();
    #[cfg(windows)]
    let status = std::process::Command::new("explorer")
        .arg(format!("/select,{}", path.display()))
        .status();
    #[cfg(all(unix, not(target_os = "macos")))]
    let status = std::process::Command::new("xdg-open")
        .arg(path.parent().unwrap_or(path))
        .status();

    match status {
        Ok(status) if status.success() => Ok(()),
        Ok(status) => Err(format!("文件管理器返回 {status}")),
        Err(error) => Err(format!("启动文件管理器失败：{error}")),
    }
}

/// 默认配置包状态（离线可读，不联网）。
#[tauri::command]
pub async fn default_profile_status(state: State<'_, Arc<AppState>>) -> Result<Value, Value> {
    state
        .services
        .default_profile_status()
        .await
        .map_err(error_value)
}

/// 拉取并应用默认配置包；在线时只标记新版本，不打断连接。
#[tauri::command]
pub async fn default_profile_refresh(state: State<'_, Arc<AppState>>) -> Result<Value, Value> {
    state
        .services
        .default_profile_refresh()
        .await
        .map_err(error_value)
}

/// 受限网络修复。与 AI 工具 NetRepair 共用同一份实现。
#[tauri::command]
pub async fn net_repair(
    state: State<'_, Arc<AppState>>,
    action: String,
    port: Option<u16>,
) -> Result<Value, Value> {
    state
        .services
        .net_repair(&action, port)
        .await
        .map_err(error_value)
}

/// 删除会话及其全部消息与工具调用记录（同事务）。有进行中的请求时拒绝。
#[tauri::command]
pub async fn chat_delete(
    state: State<'_, Arc<AppState>>,
    session_id: String,
) -> Result<Value, Value> {
    if state.has_active_request_for_session(&session_id) {
        return Err(json!({
            "contract_version": crate::runtime::EVENT_CONTRACT_VERSION,
            "code": "PRECONDITION_FAILED",
            "message": "会话有进行中的请求，先停止再删除",
            "retryable": false,
            "details": { "reason": "active_request" },
            "request_id": "",
        }));
    }

    let Some(store) = crate::store::global() else {
        return Err(json!({
            "contract_version": crate::runtime::EVENT_CONTRACT_VERSION,
            "code": "INTERNAL",
            "message": "本地数据库不可用",
            "retryable": false,
            "details": null,
            "request_id": "",
        }));
    };

    let deleted = {
        // 连接守卫不能跨 await：先完成删除，再更新内存会话。
        let conn = store.conn();
        crate::store::chat::delete_session_cascade(&conn, &session_id)
    };
    match deleted {
        Ok(true) => {
            // 内存里的会话也要丢掉，否则下一次发送会往已删除的会话写消息。
            state.drop_session(&session_id).await;
            Ok(json!({ "ok": true }))
        }
        Ok(false) => Err(json!({
            "contract_version": crate::runtime::EVENT_CONTRACT_VERSION,
            "code": "NOT_FOUND",
            "message": "会话不存在",
            "retryable": false,
            "details": null,
            "request_id": "",
        })),
        Err(error) => Err(json!({
            "contract_version": crate::runtime::EVENT_CONTRACT_VERSION,
            "code": error.code(),
            "message": error.to_string(),
            "retryable": false,
            "details": null,
            "request_id": "",
        })),
    }
}

/* ------------------------------------------------------------------ */
/* 多 provider 模型 API 设置（R32）                                     */
/* ------------------------------------------------------------------ */

fn llm_error((reason, message): (String, String)) -> Value {
    let code = match reason.as_str() {
        "not_found" => "NOT_FOUND",
        "SECRET_STORE" => "SECRET_STORE",
        "INTERNAL" => "INTERNAL",
        _ => "INVALID_ARGUMENT",
    };
    json!({
        "contract_version": crate::runtime::EVENT_CONTRACT_VERSION,
        "code": code,
        "message": message,
        "retryable": false,
        "details": { "reason": reason },
        "request_id": "",
    })
}

fn global_store() -> Result<&'static Arc<crate::store::Store>, Value> {
    crate::store::global().ok_or_else(|| {
        json!({
            "contract_version": crate::runtime::EVENT_CONTRACT_VERSION,
            "code": "INTERNAL",
            "message": "本地数据库不可用",
            "retryable": false,
            "details": null,
            "request_id": "",
        })
    })
}

#[tauri::command]
pub async fn llm_provider_list() -> Result<Value, Value> {
    let store = global_store()?;
    crate::llm::ensure_migrated(store);
    Ok(crate::llm::list_json(store))
}

#[tauri::command]
pub async fn llm_provider_save(
    provider_id: Option<String>,
    name: String,
    protocol: String,
    base_url: Option<String>,
    model: String,
    api_key: Option<String>,
) -> Result<Value, Value> {
    let store = global_store()?;
    crate::llm::ensure_migrated(store);
    let input = crate::llm::ProviderInput {
        provider_id,
        name,
        protocol,
        base_url,
        model,
        api_key,
    };
    match crate::llm::save(store, input) {
        Ok(value) => {
            // 保存即设为当前：新请求立即用新 provider，旧请求不受影响。
            crate::agent::refresh_credentials();
            Ok(value)
        }
        Err(error) => Err(llm_error(error)),
    }
}

#[tauri::command]
pub async fn llm_provider_delete(provider_id: String) -> Result<Value, Value> {
    let store = global_store()?;
    match crate::llm::delete(store, &provider_id) {
        Ok(()) => {
            crate::agent::refresh_credentials();
            Ok(json!({ "ok": true }))
        }
        Err(error) => Err(llm_error(error)),
    }
}

#[tauri::command]
pub async fn llm_provider_activate(provider_id: String) -> Result<Value, Value> {
    let store = global_store()?;
    match crate::llm::activate(store, &provider_id) {
        Ok(()) => {
            crate::agent::refresh_credentials();
            Ok(json!({ "active_provider_id": provider_id }))
        }
        Err(error) => Err(llm_error(error)),
    }
}

/// 测试连接：只传 providerId 时用已存配置与 Key；带字段时按草稿测。
#[tauri::command]
pub async fn llm_provider_test(
    provider_id: Option<String>,
    name: Option<String>,
    protocol: Option<String>,
    base_url: Option<String>,
    model: Option<String>,
    api_key: Option<String>,
) -> Result<Value, Value> {
    let store = global_store()?;
    crate::llm::ensure_migrated(store);
    let input = crate::llm::ProviderInput {
        provider_id,
        name: name.unwrap_or_default(),
        protocol: protocol.unwrap_or_default(),
        base_url,
        model: model.unwrap_or_default(),
        api_key,
    };
    crate::llm::test(store, input).await.map_err(llm_error)
}

/// 用系统浏览器打开白名单内的链接（目前只有 DeepSeek 开放平台）。
/// 域名写死在这里，避免变成任意 URL 打开器。
#[tauri::command]
pub async fn open_external(
    app: tauri::AppHandle,
    url: String,
) -> Result<Value, Value> {
    use tauri_plugin_opener::OpenerExt;

    const ALLOWED_PREFIX: &str = "https://platform.deepseek.com/";
    if !url.starts_with(ALLOWED_PREFIX) {
        return Err(json!({
            "contract_version": crate::runtime::EVENT_CONTRACT_VERSION,
            "code": "INVALID_ARGUMENT",
            "message": "只允许打开 DeepSeek 开放平台的链接",
            "retryable": false,
            "details": { "reason": "url_not_allowed" },
            "request_id": "",
        }));
    }

    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|error| json!({
            "contract_version": crate::runtime::EVENT_CONTRACT_VERSION,
            "code": "INTERNAL",
            "message": format!("打开浏览器失败：{error}"),
            "retryable": false,
            "details": null,
            "request_id": "",
        }))?;
    Ok(json!({ "opened": true }))
}

/// 引导是否需要展示。`completed` 由设置表持久化。
#[tauri::command]
pub async fn onboarding_status(state: State<'_, Arc<AppState>>) -> Result<Value, Value> {
    let completed = crate::store::global()
        .map(|store| {
            let conn = store.conn();
            crate::store::settings::get(&conn, "onboarding_completed")
                .ok()
                .flatten()
                .map(|value| {
                    // 全库约定时间戳是毫秒；兼容早期写过的 "true"。
                    value == "true"
                        || value
                            .parse::<i64>()
                            .map(|millis| millis > 0)
                            .unwrap_or(false)
                })
                .unwrap_or(false)
        })
        .unwrap_or(false);

    let profile_count = state
        .services
        .profile_list()
        .await
        .ok()
        .and_then(|data| {
            data.get("profiles")
                .and_then(Value::as_array)
                .map(|profiles| profiles.len())
        })
        .unwrap_or(0);

    let has_key = state.has_credentials()
        || crate::store::global()
            .map(|store| crate::llm::has_any_usable(store))
            .unwrap_or(false);
    Ok(json!({
        "completed": completed,
        "has_key": has_key,
        "profile_count": profile_count,
    }))
}

/// 标记引导完成。`skipped_key` 只入库备查，不参与判定。
#[tauri::command]
pub async fn onboarding_complete(
    skipped_key: Option<bool>,
) -> Result<Value, Value> {
    let Some(store) = crate::store::global() else {
        return Err(json!({ "code": "INTERNAL", "message": "本地数据库不可用" }));
    };
    let conn = store.conn();
    let skipped = skipped_key.unwrap_or(false);
    // 全库约定：完成时刻存 Unix 毫秒。
    crate::store::settings::set(
        &conn,
        "onboarding_completed",
        &crate::store::now_ms().to_string(),
    )
    .map_err(|error| json!({ "code": "INTERNAL", "message": error.to_string() }))?;
    crate::store::settings::set(
        &conn,
        "onboarding_skipped_key",
        if skipped { "true" } else { "false" },
    )
    .map_err(|error| json!({ "code": "INTERNAL", "message": error.to_string() }))?;
    Ok(json!({ "ok": true }))
}

/// 无 AI 模式的删除配置入口。审批已移除，直接执行；
/// 「不能删活动配置」的前置校验仍在服务层（`active_profile_id`）。
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
    _state: State<'_, Arc<AppState>>,
    key: String,
) -> Result<Value, Value> {
    match crate::secrets::save_deepseek_key(&key).await {
        Ok(outcome) => {
            // 热更新内存凭据：只有当前 active provider 是 DeepSeek 时才会换 key。
            crate::agent::refresh_credentials();
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

/// 设置页显示当前是否已配置 DeepSeek（基础模式专用，不随 active provider 变化）。
#[tauri::command]
pub async fn deepseek_key_status(state: State<'_, Arc<AppState>>) -> Result<Value, Value> {
    let _ = state;
    let key = crate::secrets::get_deepseek_key().ok().flatten();
    Ok(json!({
        "configured": key.is_some(),
        "masked": key.as_deref().map(crate::secrets::mask),
    }))
}

/// 清除 Key：钥匙串与内存一起清，避免「钥匙串没了但内存还留着」。
#[tauri::command]
pub async fn deepseek_clear_key(_state: State<'_, Arc<AppState>>) -> Result<Value, Value> {
    match crate::secrets::delete_deepseek_key() {
        Ok(()) => {
            crate::agent::refresh_credentials();
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

/// 拖拽导入节点文件（设置页）。只做校验、错误分类与脱敏，解析/写入复用 `seed_import`。
///
/// 校验顺序固定：扩展名 → 大小 → 可读 → 内容。先校验再读，别把大文件读进内存。
/// 返回值、日志、错误信息都不含 password，也不回显文件内容。
#[tauri::command]
pub async fn import_seed_file(path: String) -> Result<Value, Value> {
    const MAX_BYTES: u64 = 1024 * 1024;

    fn invalid(reason: &str, message: &str) -> Value {
        json!({
            "code": "INVALID_ARGUMENT",
            "message": message,
            "details": { "reason": reason },
        })
    }

    let file_path = std::path::Path::new(&path);

    let is_json = file_path
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.eq_ignore_ascii_case("json"))
        .unwrap_or(false);
    if !is_json {
        return Err(invalid("not_json_file", "只支持 .json 文件"));
    }

    let metadata = match std::fs::metadata(file_path) {
        Ok(metadata) if metadata.is_file() => metadata,
        _ => return Err(invalid("file_unreadable", "文件不存在或无法读取")),
    };
    if metadata.len() > MAX_BYTES {
        return Err(json!({
            "code": "INVALID_ARGUMENT",
            "message": "文件超过 1 MB",
            "details": { "reason": "file_too_large", "max_bytes": MAX_BYTES },
        }));
    }

    let bytes = match std::fs::read(file_path) {
        Ok(bytes) => bytes,
        Err(_) => return Err(invalid("file_unreadable", "文件不存在或无法读取")),
    };
    let contents = match String::from_utf8(bytes) {
        Ok(contents) => contents,
        Err(_) => return Err(invalid("invalid_json", "文件不是合法的 UTF-8 文本")),
    };

    let package = match crate::seed_import::parse(&contents) {
        Ok(package) => package,
        Err(error) => {
            // 只记 serde 的行列信息，不记原文——原文里是密码。
            log::warn!("seed import: invalid json: {error}");
            return Err(invalid("invalid_json", "文件不是合法的节点 JSON"));
        }
    };

    let plan = crate::seed_import::plan(&package);
    if plan.imported.is_empty() {
        if let Some(method) = plan
            .skipped
            .iter()
            .find_map(|skip| skip.reason.strip_prefix("unsupported method: "))
        {
            return Err(json!({
                "code": "UNSUPPORTED",
                "message": format!("不支持的加密方式：{method}"),
                "details": { "method": method },
            }));
        }
        let mut error = invalid("no_importable_nodes", "文件里没有可导入的节点");
        error["details"]["skipped"] = serde_json::json!(plan.skipped.len());
        return Err(error);
    }

    let Some(store) = crate::store::global() else {
        return Err(json!({ "code": "INTERNAL", "message": "本地数据库不可用" }));
    };

    match crate::seed_import::apply(&store, &plan) {
        Ok(_) => {
            for node in &plan.imported {
                log::info!("seed import: {} pw_fp={}", node.id, node.password_fingerprint);
            }
            Ok(json!({
                "imported": plan.imported.len(),
                "skipped": plan.skipped.iter().map(|skip| json!({
                    "name": skip.tag,
                    "reason": skip.reason,
                })).collect::<Vec<_>>(),
                "profiles": plan.imported.iter().map(|node| json!({
                    "id": node.id,
                    "name": node.name,
                    "server": node.server,
                    // 契约里没有，但验收要求「列出名称与 server:port」，补一个端口字段（纯新增）。
                    "server_port": node.server_port,
                    "method": node.method,
                })).collect::<Vec<_>>(),
            }))
        }
        Err(crate::seed_import::ApplyError::Secret(error)) => Err(json!({
            "code": "SECRET_STORE",
            "message": error.to_string(),
        })),
        Err(error) => Err(json!({ "code": "INTERNAL", "message": error.to_string() })),
    }
}

#[cfg(test)]
mod seed_command_tests {
    use super::*;
    use std::path::PathBuf;
    use std::sync::OnceLock;

    const GOOD: &str = r#"{"provider_id":"p","name":"Demo","config":{"outbounds":[
        {"type":"shadowsocks","tag":"Tokyo-01","server":"203.0.113.5","server_port":8388,
         "method":"aes-256-gcm","password":"pw-secret-tokyo"},
        {"type":"direct","tag":"direct"}]}}"#;

    fn temp_file(name: &str, contents: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("veyl-seed-cmd-{:016x}", rand::random::<u64>()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(name);
        std::fs::write(&path, contents).unwrap();
        path
    }

    fn ensure_runtime() {
        static ONCE: OnceLock<()> = OnceLock::new();
        ONCE.get_or_init(|| {
            if crate::store::global().is_none() {
                let store = std::sync::Arc::new(crate::store::Store::open_in_memory().unwrap());
                crate::store::install_global(store);
            }
            let dir = std::env::temp_dir().join("veyl-seed-command-secrets");
            let _ = std::fs::create_dir_all(&dir);
            crate::secrets::install(&dir);
        });
    }

    #[tokio::test]
    async fn only_json_files_are_accepted() {
        let path = temp_file("seeds.txt", GOOD);
        let error = import_seed_file(path.to_string_lossy().into_owned())
            .await
            .unwrap_err();
        assert_eq!(error["code"], "INVALID_ARGUMENT");
        assert_eq!(error["details"]["reason"], "not_json_file");
    }

    #[tokio::test]
    async fn a_missing_file_is_unreadable() {
        let path = std::env::temp_dir().join("veyl-does-not-exist-xyz.json");
        let error = import_seed_file(path.to_string_lossy().into_owned())
            .await
            .unwrap_err();
        assert_eq!(error["details"]["reason"], "file_unreadable");
    }

    #[tokio::test]
    async fn files_over_one_megabyte_are_rejected_before_reading() {
        let dir = std::env::temp_dir().join(format!("veyl-seed-big-{:016x}", rand::random::<u64>()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("big.json");
        std::fs::write(&path, vec![b'a'; 1024 * 1024 + 1]).unwrap();

        let error = import_seed_file(path.to_string_lossy().into_owned())
            .await
            .unwrap_err();
        assert_eq!(error["details"]["reason"], "file_too_large");
        assert_eq!(error["details"]["max_bytes"], 1024 * 1024);
    }

    #[tokio::test]
    async fn invalid_json_is_reported_without_echoing_the_file() {
        let path = temp_file("bad.json", r#"{"password":"pw-leak-me""#);
        let error = import_seed_file(path.to_string_lossy().into_owned())
            .await
            .unwrap_err();
        assert_eq!(error["details"]["reason"], "invalid_json");
        assert!(!error.to_string().contains("pw-leak-me"), "{error}");
        assert!(
            !error.to_string().contains(&path.file_name().unwrap().to_string_lossy().to_string()),
            "错误信息不应回显路径：{error}"
        );
    }

    #[tokio::test]
    async fn an_unsupported_method_is_unsupported_not_invalid() {
        let body = r#"{"provider_id":"p","name":"Demo","config":{"outbounds":[
            {"type":"shadowsocks","tag":"x","server":"203.0.113.5","server_port":8388,
             "method":"rc4-md5","password":"pw"}]}}"#;
        let path = temp_file("rc4.json", body);
        let error = import_seed_file(path.to_string_lossy().into_owned())
            .await
            .unwrap_err();
        assert_eq!(error["code"], "UNSUPPORTED");
        assert_eq!(error["details"]["method"], "rc4-md5");
    }

    #[tokio::test]
    async fn nothing_importable_is_reported_separately() {
        let body = r#"{"provider_id":"p","name":"Demo","config":{"outbounds":[
            {"type":"direct","tag":"direct"}]}}"#;
        let path = temp_file("direct.json", body);
        let error = import_seed_file(path.to_string_lossy().into_owned())
            .await
            .unwrap_err();
        assert_eq!(error["details"]["reason"], "no_importable_nodes");
        assert_eq!(error["details"]["skipped"], 1, "UI 需要这个数字来写「已跳过 M 个」");
    }

    #[tokio::test]
    async fn a_partial_import_succeeds_and_never_returns_passwords() {
        ensure_runtime();
        let path = temp_file("good.json", GOOD);
        let response = import_seed_file(path.to_string_lossy().into_owned())
            .await
            .unwrap();

        assert_eq!(response["imported"], 1);
        assert_eq!(response["skipped"].as_array().unwrap().len(), 1);
        let profiles = response["profiles"].as_array().unwrap();
        assert_eq!(profiles[0]["method"], "aes-256-gcm");
        assert_eq!(profiles[0]["server"], "203.0.113.5");
        assert_eq!(profiles[0]["server_port"], 8388);
        assert!(profiles[0]["id"].as_str().unwrap().starts_with("seed-"));

        let text = response.to_string();
        assert!(!text.contains("pw-secret-tokyo"), "{text}");
        assert!(!text.contains("password"), "{text}");
    }
}
