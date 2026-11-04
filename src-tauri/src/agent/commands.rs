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

/// 面板主按钮：连接。`configId` 省略时用当前激活配置。
#[tauri::command]
pub async fn runtime_start(
    state: State<'_, Arc<AppState>>,
    config_id: Option<String>,
) -> Result<Value, Value> {
    state
        .services
        .runtime_start(config_id)
        .await
        .map_err(error_value)
}

/// 面板主按钮：断开。
#[tauri::command]
pub async fn runtime_stop(state: State<'_, Arc<AppState>>) -> Result<Value, Value> {
    state.services.runtime_stop(false).await.map_err(error_value)
}

/// 配置列表（`ConfigListData`）。不返回节点明细，要节点用 config_detail。
#[tauri::command]
pub async fn config_list(state: State<'_, Arc<AppState>>) -> Result<Value, Value> {
    state.services.config_list().await.map_err(error_value)
}

#[tauri::command]
pub async fn config_detail(
    state: State<'_, Arc<AppState>>,
    config_id: String,
) -> Result<Value, Value> {
    state
        .services
        .config_detail(&config_id)
        .await
        .map_err(error_value)
}

/// 新建一套配置。`source = "seed"` 时绑定当前种子的全部节点。
#[tauri::command]
pub async fn config_create(
    state: State<'_, Arc<AppState>>,
    name: String,
    connect_mode: String,
    routing_mode: String,
    source: Option<String>,
    node_ids: Option<Vec<String>>,
    targets: Option<Vec<String>>,
    listen_port: Option<u16>,
    dns: Option<Value>,
    tun_excludes: Option<Vec<String>>,
) -> Result<Value, Value> {
    state
        .services
        .config_create(crate::tools::ConfigCreateInput {
            name,
            connect_mode,
            routing_mode,
            source,
            node_ids,
            targets,
            listen_port,
            dns,
            tun_excludes,
        })
        .await
        .map_err(error_value)
}

/// 就地更新一套配置。改连接方式必须新建，`connectMode` 会被拒绝。
///
/// 用原始 `Request` 解析参数：只有这样才能区分 `listenPort` 的三种状态
/// 「没传 / 传了 null / 传了数字」。Tauri 的 `Option<Option<T>>` 会把
/// 缺失与 null 都折成 None。
#[tauri::command]
pub async fn config_update(
    state: State<'_, Arc<AppState>>,
    request: tauri::ipc::Request<'_>,
) -> Result<Value, Value> {
    fn invalid(reason: &str, message: &str) -> Value {
        json!({
            "contract_version": crate::runtime::EVENT_CONTRACT_VERSION,
            "code": "INVALID_ARGUMENT",
            "message": message,
            "retryable": false,
            "details": { "reason": reason },
            "request_id": "",
        })
    }

    let payload = match request.body() {
        tauri::ipc::InvokeBody::Json(value) => value,
        _ => return Err(invalid("invalid_payload", "参数必须是 JSON 对象")),
    };
    let object = payload
        .as_object()
        .ok_or_else(|| invalid("invalid_payload", "参数必须是 JSON 对象"))?;

    let arg = |camel: &str, snake: &str| object.get(camel).or_else(|| object.get(snake));

    let config_id = arg("configId", "config_id")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| invalid("invalid_config_id", "config_id 不能为空"))?
        .to_string();

    if arg("connectMode", "connect_mode").is_some() {
        return Err(invalid(
            "connect_mode_immutable",
            "改连接方式必须新建一套配置",
        ));
    }

    let name = arg("name", "name")
        .and_then(Value::as_str)
        .map(str::to_string);
    let routing_mode = arg("routingMode", "routing_mode")
        .and_then(Value::as_str)
        .map(str::to_string);
    let listen_port = match arg("listenPort", "listen_port") {
        None => None,
        Some(Value::Null) => Some(None),
        Some(value) => match value
            .as_u64()
            .and_then(|port| u16::try_from(port).ok())
        {
            Some(port) => Some(Some(port)),
            None => return Err(invalid("invalid_listen_port", "listenPort 必须是数字或 null")),
        },
    };
    let dns = arg("dns", "dns").cloned();
    let tun_excludes = arg("tunExcludes", "tun_excludes").and_then(Value::as_array).map(|items| {
        items
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_string)
            .collect::<Vec<_>>()
    });
    let node_ids = arg("nodeIds", "node_ids").and_then(Value::as_array).map(|items| {
        items
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_string)
            .collect::<Vec<_>>()
    });
    let targets = arg("targets", "targets").and_then(Value::as_array).map(|items| {
        items
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_string)
            .collect::<Vec<_>>()
    });

    state
        .services
        .config_update(
            &config_id,
            crate::tools::ConfigUpdateInput {
                name,
                routing_mode,
                listen_port,
                dns,
                tun_excludes,
                node_ids,
                targets,
                connect_mode: None,
            },
        )
        .await
        .map_err(error_value)
}

#[tauri::command]
pub async fn config_delete(
    state: State<'_, Arc<AppState>>,
    config_id: String,
) -> Result<Value, Value> {
    state
        .services
        .config_delete(&config_id)
        .await
        .map_err(error_value)
}

/// 切换激活配置。已连接且换到另一套时必须带 `confirmDisconnect`。
#[tauri::command]
pub async fn config_activate(
    state: State<'_, Arc<AppState>>,
    config_id: String,
    confirm_disconnect: Option<bool>,
) -> Result<Value, Value> {
    state
        .services
        .config_activate(&config_id, confirm_disconnect.unwrap_or(false))
        .await
        .map_err(error_value)
}

/// URL 模式：拉取 base64 多节点订阅并解析，只解析、不连接。
#[tauri::command]
pub async fn node_import_url(
    state: State<'_, Arc<AppState>>,
    url: String,
    config_id: Option<String>,
) -> Result<Value, Value> {
    state
        .services
        .node_import_url(config_id, &url)
        .await
        .map_err(error_value)
}

/// 手动模式：五个字段创建节点。密码只进 secrets.enc。
#[tauri::command]
pub async fn node_create(
    state: State<'_, Arc<AppState>>,
    name: String,
    server: String,
    port: u16,
    password: String,
    method: String,
    config_id: Option<String>,
) -> Result<Value, Value> {
    state
        .services
        .node_create(crate::tools::NodeCreateInput {
            config_id,
            name,
            server,
            port,
            password,
            method,
        })
        .await
        .map_err(error_value)
}

/// 默认节点缓存状态（离线可读，不联网）。
#[tauri::command]
pub async fn default_profile_status(state: State<'_, Arc<AppState>>) -> Result<Value, Value> {
    state
        .services
        .default_profile_status()
        .await
        .map_err(error_value)
}

/// 拉取并应用默认节点；有缓存时离线沿用缓存，不报死错。
#[tauri::command]
pub async fn default_profile_refresh(
    state: State<'_, Arc<AppState>>,
) -> Result<Value, Value> {
    state
        .services
        .default_profile_refresh(false)
        .await
        .map_err(error_value)
}

/// 离线兜底：把一份 `veyl_seed.json` 合并进节点池（只增不删）。
#[tauri::command]
pub async fn import_seed_file(
    state: State<'_, Arc<AppState>>,
    path: String,
) -> Result<Value, Value> {
    state
        .services
        .import_seed_file(&path)
        .await
        .map_err(error_value)
}

/// 规则数据状态（不联网）。
#[tauri::command]
pub async fn rules_status(state: State<'_, Arc<AppState>>) -> Result<Value, Value> {
    state.services.rules_status().await.map_err(error_value)
}

/// 分类目录（AI 与 UI 共用），只读当前生效版本。
#[tauri::command]
pub async fn category_list(
    state: State<'_, Arc<AppState>>,
    query: Option<String>,
    limit: Option<u32>,
) -> Result<Value, Value> {
    state
        .services
        .category_list(query, limit)
        .await
        .map_err(error_value)
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
            crate::agent::questions::cleanup_session(&session_id);
            Ok(json!({ "ok": true }))
        }
        Ok(false) => {
            // DB 里已经没有了，也要清掉该会话可能残留的待答问题。
            crate::agent::questions::cleanup_session(&session_id);
            Err(json!({
            "contract_version": crate::runtime::EVENT_CONTRACT_VERSION,
            "code": "NOT_FOUND",
            "message": "会话不存在",
            "retryable": false,
            "details": null,
            "request_id": "",
            }))
        }
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
        "builtin_provider" | "no_key" => "PRECONDITION_FAILED",
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
    let active_before = crate::llm::active_id(store);
    match crate::llm::save(store, input) {
        Ok(value) => {
            // 只在 active 真的变化、或改的就是当前 provider 时才重建凭据；
            // 否则编辑备用 provider 会让凭据代数 +1、丢掉当前会话上下文。
            let active_after = crate::llm::active_id(store);
            let saved_id = value.get("provider_id").and_then(Value::as_str);
            if active_after != active_before || saved_id == active_after.as_deref() {
                crate::agent::refresh_credentials();
            }
            Ok(value)
        }
        Err(error) => Err(llm_error(error)),
    }
}

#[tauri::command]
pub async fn llm_provider_delete(provider_id: String) -> Result<Value, Value> {
    let store = global_store()?;
    let active_before = crate::llm::active_id(store);
    match crate::llm::delete(store, &provider_id) {
        Ok(()) => {
            if crate::llm::active_id(store) != active_before {
                crate::agent::refresh_credentials();
            }
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

/// AskUserQuestion 的回答。answer 必须是选项之一，空字符串表示跳过。
#[tauri::command]
pub async fn reply_user_question(
    session_id: String,
    question_id: String,
    answer: String,
) -> Result<Value, Value> {
    crate::agent::questions::reply(&session_id, &question_id, &answer).map_err(|(reason, message)| {
        let code = match reason.as_str() {
            "question_not_pending" => "NOT_FOUND",
            "answer_not_in_options" => "INVALID_ARGUMENT",
            _ => "INTERNAL",
        };
        json!({
            "contract_version": crate::runtime::EVENT_CONTRACT_VERSION,
            "code": code,
            "message": message,
            "retryable": false,
            "details": { "reason": reason },
            "request_id": "",
        })
    })?;
    Ok(json!({ "ok": true }))
}

/// 当前会话未回答的问题（重连后恢复提问浮层）。
#[tauri::command]
pub async fn list_pending_questions(session_id: String) -> Result<Value, Value> {
    Ok(crate::agent::questions::list_pending(&session_id))
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

    let config_count = state
        .services
        .config_list()
        .await
        .ok()
        .and_then(|data| {
            data.get("configs")
                .and_then(Value::as_array)
                .map(|configs| configs.len())
        })
        .unwrap_or(0);

    let has_key = state.has_credentials()
        || crate::store::global()
            .map(|store| crate::llm::has_any_usable(store))
            .unwrap_or(false);
    Ok(json!({
        "completed": completed,
        "has_key": has_key,
        "config_count": config_count,
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
            // 热更新内存凭据：只有当前 active provider 是 DeepSeek 时才换 key。
            crate::agent::refresh_credentials_if_active(crate::llm::PROVIDER_DEEPSEEK);
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
            crate::agent::refresh_credentials_if_active(crate::llm::PROVIDER_DEEPSEEK);
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

