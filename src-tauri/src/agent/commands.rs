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
