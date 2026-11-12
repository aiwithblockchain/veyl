//! 前端可调用的命令面。命令名已冻结（`docs/contracts/events.md` §5）。

use std::sync::Arc;

use serde_json::{json, Value};
use tauri::State;

use super::AppState;

/// 用户输入落库。
///
/// `hidden` 为真时是**系统代发**的开场触发（引导页配好 Key 之后自动发起），
/// 不能出现在聊天记录里。文本仍照常送给模型，只是不写 `chat_messages`。
fn record_user_message(store: &crate::store::Store, session_id: &str, text: &str, hidden: bool) {
    if hidden {
        return;
    }
    let conn = store.conn();
    let _ = crate::store::chat::append_message(
        &conn,
        &crate::store::chat::new_message_id(),
        session_id,
        "user",
        text,
        None,
    );
}

/// 发起一轮对话。立即返回 request_id，事件在后台推。
#[tauri::command]
pub async fn ai_send_message(
    state: State<'_, Arc<AppState>>,
    session_id: String,
    text: String,
    hidden: Option<bool>,
) -> Result<Value, Value> {
    send_message_for_state(state.inner(), &session_id, &text, hidden.unwrap_or(false)).await
}

/// 请求槽的 RAII 兜底：任务 panic、提前返回或被丢弃时照样释放，
/// 不会给会话留下永久的 BUSY。
struct RequestSlotGuard {
    state: Arc<AppState>,
    request_id: String,
}

impl Drop for RequestSlotGuard {
    fn drop(&mut self) {
        self.state.finish_request(&self.request_id);
    }
}

/// 同一会话同一时刻只处理一条请求；第二条直接拒绝，**不落库、不排队**。
async fn send_message_for_state(
    state: &Arc<AppState>,
    session_id: &str,
    text: &str,
    hidden: bool,
) -> Result<Value, Value> {
    if text.trim().is_empty() {
        return Err(json!({
            "contract_version": crate::runtime::EVENT_CONTRACT_VERSION,
            "code": "INVALID_ARGUMENT",
            "message": "消息不能为空",
            "retryable": false,
            "details": { "reason": "empty_text" },
            "request_id": "",
        }));
    }

    let request_id = AppState::next_request_id();
    let cancel = match state.reserve_request(&request_id, session_id) {
        Ok(token) => token,
        Err(active_request_id) => {
            return Err(json!({
                "contract_version": crate::runtime::EVENT_CONTRACT_VERSION,
                "code": "BUSY",
                "message": "上一条消息还在处理中，等它回完再发",
                "retryable": true,
                "details": {
                    "reason": "request_in_flight",
                    "active_request_id": active_request_id,
                },
                "request_id": "",
            }))
        }
    };
    // 一旦占槽成功，释放交给 Drop：panic / 会话创建失败 / 任务被丢弃都覆盖。
    let slot = RequestSlotGuard {
        state: Arc::clone(state),
        request_id: request_id.clone(),
    };

    let session = match state.session(session_id).await {
        Ok(session) => session,
        // 提前返回时 slot 在这里析构，槽位不会卡住。
        Err(error) => return Err(error_value(error)),
    };

    // 占槽成功后才落库：被拒绝的消息不能出现在聊天记录里。
    if let Some(store) = crate::store::global() {
        record_user_message(store, session_id, text, hidden);
    }

    let task_text = text.to_string();
    let task_request_id = request_id.clone();
    tokio::spawn(async move {
        if let Err(error) = session
            .send_message(task_request_id, task_text, cancel, slot)
            .await
        {
            log::error!("[agent] send_message failed: {error}");
        }
    });

    Ok(json!({ "request_id": request_id }))
}

#[tauri::command]
pub async fn ai_cancel(
    state: State<'_, Arc<AppState>>,
    request_id: String,
) -> Result<Value, String> {
    // 令牌存在 AppState 里，不依赖会话实例：spawn 前、切 provider 后都能取消。
    Ok(json!({ "cancelled": state.cancel_request(&request_id) }))
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

fn command_error(code: &str, message: impl std::fmt::Display, details: Value) -> Value {
    json!({
        "contract_version": crate::runtime::EVENT_CONTRACT_VERSION,
        "code": code,
        "message": message.to_string(),
        "retryable": false,
        "details": details,
        "request_id": "",
    })
}

/// 用户设置的本地代理端口。未设置过返回默认值，读不写库。
#[tauri::command]
pub async fn proxy_port_get() -> Result<Value, Value> {
    let Some(store) = crate::store::global() else {
        return Err(command_error("INTERNAL", "本地数据库不可用", Value::Null));
    };
    let port = {
        let conn = store.conn();
        crate::store::settings::proxy_port(&conn)
    };
    // `default_port` 给界面画「恢复默认」，省得前端硬编码 7890。
    Ok(json!({
        "port": port,
        "default_port": crate::config::DEFAULT_PROXY_PORT,
    }))
}

/// 保存本地代理端口。整数 1–65535；<1024 只提示；当前被占用也允许保存。
#[tauri::command]
pub async fn proxy_port_set(port: Value) -> Result<Value, Value> {
    let Some(port) = port
        .as_u64()
        .and_then(|value| u16::try_from(value).ok())
        .filter(|port| *port > 0)
    else {
        return Err(command_error(
            "INVALID_ARGUMENT",
            "请填一个 1–65535 之间的数字",
            json!({ "reason": "invalid_port" }),
        ));
    };

    let Some(store) = crate::store::global() else {
        return Err(command_error("INTERNAL", "本地数据库不可用", Value::Null));
    };
    {
        let conn = store.conn();
        crate::store::settings::set_proxy_port(&conn, port)
            .map_err(|error| command_error("INTERNAL", error, Value::Null))?;
    }

    // 占用只是临时状态：允许保存，界面据此决定显示哪句提示。
    // 三态直接映射保存那一刻的实测结果，不再多包一层布尔。
    let availability = match crate::config::port_availability(port) {
        crate::config::PortAvailability::Free => "free",
        crate::config::PortAvailability::Occupied => "occupied",
        crate::config::PortAvailability::Unavailable => "unavailable",
    };
    Ok(json!({ "port": port, "availability": availability }))
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
            if !code.is_empty() && code.chars().all(|c| c.is_ascii_uppercase() || c == '_') =>
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
    state
        .services
        .runtime_stop(false)
        .await
        .map_err(error_value)
}

// ---------------------------------------------------------------------------
// 运行库（高级设置）。安装/升级只能由用户在这里显式发起，AI 不代劳。
// ---------------------------------------------------------------------------

/// 当前随包版本、激活版本、来源、是否需要重启。
#[tauri::command]
pub async fn core_info(state: State<'_, Arc<AppState>>) -> Result<Value, Value> {
    state.services.core_info().await.map_err(error_value)
}

/// 检查更新。断网时返回 `NETWORK_UNREACHABLE`，不进入下载。
#[tauri::command]
pub async fn core_check_updates(state: State<'_, Arc<AppState>>) -> Result<Value, Value> {
    state
        .services
        .core_check_updates()
        .await
        .map_err(error_value)
}

/// 开始升级，立即返回 `{ job_id }`；进度走 `core-upgrade-progress` 事件。
#[tauri::command]
pub async fn core_upgrade(
    state: State<'_, Arc<AppState>>,
    version: String,
) -> Result<Value, Value> {
    state
        .services
        .core_upgrade(&version, "ui", None)
        .await
        .map_err(error_value)
}

#[tauri::command]
pub async fn core_cancel_upgrade(
    state: State<'_, Arc<AppState>>,
    job_id: String,
) -> Result<Value, Value> {
    state
        .services
        .core_cancel_upgrade(&job_id)
        .await
        .map_err(error_value)
}

/// 回到随包运行时。
#[tauri::command]
pub async fn core_rollback(state: State<'_, Arc<AppState>>) -> Result<Value, Value> {
    state.services.core_rollback().await.map_err(error_value)
}

/// 后台组件（TUN helper）的构建与运行状态。仅 UI，不进 AI 工具集。
#[tauri::command]
pub async fn tun_helper_info(state: State<'_, Arc<AppState>>) -> Result<Value, Value> {
    state.services.tun_helper_info().await.map_err(error_value)
}

/// 换新后台组件映像。仅 UI；TUN 在跑时拒绝。
#[tauri::command]
pub async fn tun_helper_restart(state: State<'_, Arc<AppState>>) -> Result<Value, Value> {
    state
        .services
        .tun_helper_restart()
        .await
        .map_err(error_value)
}

/// 仅 debug 构建：TUN 已连接时采集一次诊断，返回结论与报告路径。
///
/// 不注册进 release 的 invoke_handler；也不在任何 AI 工具集里。
#[cfg(debug_assertions)]
#[tauri::command]
pub async fn tun_probe(state: State<'_, Arc<AppState>>) -> Result<Value, Value> {
    state.services.tun_probe().await.map_err(error_value)
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
            listen_port: None,
            dns,
            tun_excludes,
        })
        .await
        .map_err(error_value)
}

/// 就地更新一套配置。改连接方式必须新建，`connectMode` 会被拒绝。
///
/// 用原始 `Request` 解析参数：`configId` / `name` 等允许缺省，未知字段忽略。
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
    let dns = arg("dns", "dns").cloned();
    let tun_excludes = arg("tunExcludes", "tun_excludes")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect::<Vec<_>>()
        });
    let node_ids = arg("nodeIds", "node_ids")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect::<Vec<_>>()
        });
    let targets = arg("targets", "targets")
        .and_then(Value::as_array)
        .map(|items| {
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
                listen_port: None,
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

/// 粘贴文本模式：解析用户贴进来的 `ss://`（可多行），只解析、不联网。
/// 与 `node_import_url` 分开：URL 那条要为「我们替用户去拉」做 SSRF 限制，
/// 混用会把口子开大。
#[tauri::command]
pub async fn node_import_text(
    state: State<'_, Arc<AppState>>,
    text: String,
    config_id: Option<String>,
) -> Result<Value, Value> {
    state
        .services
        .node_import_text(config_id, &text)
        .await
        .map_err(error_value)
}

/// 文件导入上限：与 `import_seed_file`、URL 拉取一致（契约 §4.1.2）。
///
/// 大小以打开后的**句柄**为准，读取再用 `take(MAX + 1)` 卡住，最多只读
/// 1 MiB + 1 字节。
pub(crate) const MAX_NODE_FILE_BYTES: u64 = 1024 * 1024;

/// 本地文件导入：与 `node_import_text` 共用解析与落库，只多一步路径校验和读取。
///
/// **仅 UI**：不注册为 AI 工具——AI 侧继续走 `NodeImportText`，不给模型读本地
/// 文件的能力（契约 §4.1.2）。
#[tauri::command]
pub async fn node_import_file(
    state: State<'_, Arc<AppState>>,
    path: String,
    config_id: Option<String>,
) -> Result<Value, Value> {
    import_nodes_from_file(state.services.as_ref(), &path, config_id).await
}

/// 仅 UI：读/写「问题报告是否包含完整域名」。
///
/// 省略参数 = 读取；传 `includeDomains` = 写入。不注册为 AI 工具：
/// 脱敏开关属于用户，模型只能收窄、不能放宽。
#[tauri::command]
pub async fn issue_report_preference(
    state: State<'_, Arc<AppState>>,
    include_domains: Option<bool>,
) -> Result<Value, Value> {
    state
        .services
        .issue_report_preference(include_domains)
        .await
        .map_err(error_value)
}

/// 仅 UI：在文件管理器里显示问题报告目录。
///
/// 只认本机登记过的 `report_id`（内存或各目录的 `.report-id`），
/// **不接受路径参数**——通用「打开任意路径」的能力会变成模型可诱导的入口。
#[tauri::command]
pub async fn issue_report_reveal(report_id: String) -> Result<Value, Value> {
    crate::reports::reveal(&report_id, &crate::reports::default_report_root())
        .map_err(report_error_value)
}

/// 仅 UI：调起系统邮件客户端，预填收件人、标题、正文（不发送）。
#[tauri::command]
pub async fn issue_report_mail(report_id: String) -> Result<Value, Value> {
    crate::reports::compose_mail(&report_id, &crate::reports::default_report_root())
        .map_err(report_error_value)
}

fn report_error_value(error: crate::reports::ReportError) -> Value {
    let details = error
        .reason
        .map(|reason| json!({ "reason": reason }))
        .unwrap_or(Value::Null);
    command_error(error.code, error.message, details)
}

/// 文件导入的核心，抽出来是为了能脱离 Tauri `State` 测。
///
/// 读文件失败用契约 §4.1.2 的三个 reason；解析失败沿用文本导入的
/// `not_node_text`，只把可读消息换成文件措辞（解析器是共用的）。
pub(crate) async fn import_nodes_from_file(
    services: &dyn crate::tools::VpnToolServices,
    path: &str,
    config_id: Option<String>,
) -> Result<Value, Value> {
    let path = path.to_string();
    // 同步读放进阻塞池：慢盘或网络卷不能占住 async 线程。
    let text = tokio::task::spawn_blocking(move || read_node_file(&path))
        .await
        .map_err(|error| {
            command_error(
                "INTERNAL",
                format!("读取文件任务异常：{error}"),
                Value::Null,
            )
        })??;
    match services.node_import_text(config_id, &text).await {
        Ok(value) => Ok(value),
        Err(error) => {
            let mut value = error_value(error);
            if value["details"]["reason"] == "not_node_text" {
                value["message"] = json!("这个文件里没有可用的节点（支持多行 ss:// 链接）");
            }
            Err(value)
        }
    }
}

/// 路径校验 + 读取。错误码与 `details.reason` 按契约 §4.1.2。
///
/// 只打开一次：类型与大小都看句柄上的 metadata，读取再用 `take` 卡在
/// `MAX + 1` 字节——「先查后读」之间文件被换掉或长大也不会超读。
/// 消息里**不出现路径**（与日志口径一致），也不回显文件内容。
fn read_node_file(path: &str) -> Result<String, Value> {
    use std::io::Read;

    let candidate = std::path::Path::new(path);
    if path.is_empty() || !candidate.is_absolute() {
        return Err(file_error(
            "invalid_path",
            "请选择要导入的文件（必须是绝对路径）",
            None,
        ));
    }
    let mut file = open_for_read(candidate).map_err(|_| unreadable_file_error())?;
    let metadata = file.metadata().map_err(|_| unreadable_file_error())?;
    if !metadata.is_file() {
        return Err(file_error(
            "file_unreadable",
            "只能导入普通文件，不能是目录或特殊文件",
            None,
        ));
    }
    if metadata.len() > MAX_NODE_FILE_BYTES {
        return Err(file_too_large_error());
    }
    let mut bytes = Vec::new();
    (&mut file)
        .take(MAX_NODE_FILE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| unreadable_file_error())?;
    // 读的是句柄，但仍可能边读边长：截断后刚好超限也算超限。
    if bytes.len() as u64 > MAX_NODE_FILE_BYTES {
        return Err(file_too_large_error());
    }
    // 不做编码猜测：非法字节替换为 U+FFFD（契约 §4.1.2）。
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

/// 只读打开。unix 上加 `O_NONBLOCK`：FIFO 这类特殊文件会在 `open` 处
/// 一直等到有写端，占住阻塞线程；普通文件不受该标志影响。
fn open_for_read(path: &std::path::Path) -> std::io::Result<std::fs::File> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        return std::fs::OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NONBLOCK)
            .open(path);
    }
    #[cfg(not(unix))]
    {
        std::fs::File::open(path)
    }
}

fn unreadable_file_error() -> Value {
    file_error(
        "file_unreadable",
        "这个文件无法读取（可能不存在或没有权限）",
        None,
    )
}

fn file_too_large_error() -> Value {
    file_error(
        "file_too_large",
        "文件超过 1 MiB，请选择更小的文件",
        Some(MAX_NODE_FILE_BYTES),
    )
}

fn file_error(reason: &str, message: &str, max_bytes: Option<u64>) -> Value {
    let mut details = json!({ "reason": reason });
    if let Some(max) = max_bytes {
        details["max_bytes"] = json!(max);
    }
    json!({
        "contract_version": crate::runtime::EVENT_CONTRACT_VERSION,
        "code": "INVALID_ARGUMENT",
        "message": message,
        "retryable": false,
        "details": details,
        "request_id": "",
    })
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

/// 切换一套配置的当前节点。已连接时走 selector 热切，不断流。
#[tauri::command]
pub async fn node_switch(
    state: State<'_, Arc<AppState>>,
    config_id: String,
    node_id: String,
) -> Result<Value, Value> {
    state
        .services
        .node_switch(&config_id, &node_id)
        .await
        .map_err(error_value)
}

/// 测试单个节点连通性。未连接退化为 TCP 探测，不启动运行时。
#[tauri::command]
pub async fn node_probe(state: State<'_, Arc<AppState>>, node_id: String) -> Result<Value, Value> {
    state
        .services
        .node_probe(&node_id)
        .await
        .map_err(error_value)
}

/// 启动一批节点测速（UI 专用，只读；全局同时只允许一批）。
#[tauri::command]
pub async fn node_probe_all(
    state: State<'_, Arc<AppState>>,
    config_id: Option<String>,
    node_ids: Option<Vec<String>>,
) -> Result<Value, Value> {
    state
        .services
        .node_probe_all(config_id, node_ids)
        .await
        .map_err(error_value)
}

/// 尽力取消一批测速；批次不存在时返回 `{ cancelled: false }`。
#[tauri::command]
pub async fn node_probe_cancel(
    state: State<'_, Arc<AppState>>,
    run_id: String,
) -> Result<Value, Value> {
    state
        .services
        .node_probe_cancel(&run_id)
        .await
        .map_err(error_value)
}

/// 读取该配置的缓存结果与运行态；不发起网络请求。
#[tauri::command]
pub async fn node_probe_snapshot(
    state: State<'_, Arc<AppState>>,
    config_id: Option<String>,
) -> Result<Value, Value> {
    state
        .services
        .node_probe_snapshot(config_id)
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
pub async fn default_profile_refresh(state: State<'_, Arc<AppState>>) -> Result<Value, Value> {
    // 用户手动点「检查更新」，意图就是立刻查一次；不能被 6 小时短路成「已是最新」。
    state
        .services
        .default_profile_refresh(true)
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

/// 查看一套配置的分流状态。`configId` 省略时用 active 配置。
#[tauri::command]
pub async fn route_get(
    state: State<'_, Arc<AppState>>,
    config_id: Option<String>,
) -> Result<Value, Value> {
    state
        .services
        .route_get(config_id)
        .await
        .map_err(error_value)
}

/// 切换分流模式。`direct` ↔ `proxy_all` 已连接时走 selector 热切；
/// 涉及 `proxy_selected` 的跨家族切换会断开重连，需要 `confirmReconnect`。
#[tauri::command]
pub async fn route_set_mode(
    state: State<'_, Arc<AppState>>,
    config_id: Option<String>,
    mode: String,
    confirm_reconnect: Option<bool>,
) -> Result<Value, Value> {
    state
        .services
        .route_set_mode(config_id, &mode, confirm_reconnect.unwrap_or(false))
        .await
        .map_err(error_value)
}

/// 整体替换「指定服务」分类集合。
#[tauri::command]
pub async fn route_targets_set(
    state: State<'_, Arc<AppState>>,
    config_id: String,
    categories: Vec<String>,
) -> Result<Value, Value> {
    state
        .services
        .route_targets_set(&config_id, categories)
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

/// 系统地区（离线；由时区与区域设置推断，不是 IP 定位）。
/// 全新安装还没有配置时也要能拿到，所以不依赖 `route_get`。
#[tauri::command]
pub async fn system_region() -> Result<Value, Value> {
    Ok(json!({ "region": crate::rules::detect_region().code() }))
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
            let modified = entry
                .metadata()
                .ok()
                .and_then(|meta| meta.modified().ok())?;
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

/// 强制重置网络。UI 专用，不注册为 AI 工具（`tools/net.rs` 里没有这个动作）。
///
/// 八步固定、逐项回报；每一步失败都不影响后续步骤，最终以 `verify` 为准。
/// 并发双击时第二次直接拒绝，不跑两轮互相拆台。
static FORCE_RESET_IN_FLIGHT: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

#[tauri::command]
pub async fn network_force_reset(state: State<'_, Arc<AppState>>) -> Result<Value, Value> {
    use std::sync::atomic::Ordering;

    if FORCE_RESET_IN_FLIGHT.swap(true, Ordering::SeqCst) {
        return Err(json!({
            "contract_version": crate::runtime::EVENT_CONTRACT_VERSION,
            "code": "PRECONDITION_FAILED",
            "message": "强制重置正在进行中，请等当前这次结束",
            "retryable": true,
            "details": { "reason": "reset_in_flight" },
            "request_id": "",
        }));
    }
    // 无论正常返回、报错还是被取消，都要把标志放回去。
    struct InFlight;
    impl Drop for InFlight {
        fn drop(&mut self) {
            FORCE_RESET_IN_FLIGHT.store(false, Ordering::SeqCst);
        }
    }
    let _guard = InFlight;

    state
        .services
        .network_force_reset()
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

/// AskUserQuestion 的回答。普通提问接受任何非空文本，空字符串表示跳过；
/// 升级确认卡仍只认 options 里的原文。
#[tauri::command]
pub async fn reply_user_question(
    session_id: String,
    question_id: String,
    answer: String,
) -> Result<Value, Value> {
    crate::agent::questions::reply(&session_id, &question_id, &answer).map_err(
        |(reason, message)| {
            let code = match reason.as_str() {
                "question_not_pending" => "NOT_FOUND",
                // 只剩升级确认卡会走到这里：装包授权不能靠打字。
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
        },
    )?;
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
pub async fn open_external(app: tauri::AppHandle, url: String) -> Result<Value, Value> {
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

    app.opener().open_url(url, None::<&str>).map_err(|error| {
        json!({
            "contract_version": crate::runtime::EVENT_CONTRACT_VERSION,
            "code": "INTERNAL",
            "message": format!("打开浏览器失败：{error}"),
            "retryable": false,
            "details": null,
            "request_id": "",
        })
    })?;
    Ok(json!({ "opened": true }))
}

/// 把用户送到「系统设置 › 登录项与扩展」。
///
/// 首次 TUN 连接返回 `tun_denied` 时，界面给一个可点击的入口；用户批准后
/// 重新调用连接命令即可，不需要退出 App。
#[tauri::command]
pub async fn tun_helper_open_settings() -> Result<Value, Value> {
    crate::tun::privilege::open_login_items();
    Ok(json!({ "opened": true }))
}

/// 卸载后台助手。「设置」或诊断区调用。
///
/// 幂等：没注册过也算成功；真正的失败返回 `{code, message}`。
#[tauri::command]
pub async fn tun_helper_uninstall() -> Result<Value, Value> {
    crate::tun::privilege::unregister_helper()
        .map(|()| json!({ "ok": true }))
        .map_err(|error| json!({ "code": error.code, "message": error.message }))
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

/// 清除 Key：本地密文与内存一起清。若当前激活的就是 DeepSeek，
/// 同时清掉 active provider，避免「Key 没了但 AI 仍显示已配置」。
#[tauri::command]
pub async fn deepseek_clear_key(_state: State<'_, Arc<AppState>>) -> Result<Value, Value> {
    match crate::secrets::delete_deepseek_key() {
        Ok(()) => {
            if let Some(store) = crate::store::global() {
                if crate::llm::active_id(store).as_deref() == Some(crate::llm::PROVIDER_DEEPSEEK) {
                    let _ = crate::llm::set_active_id(store, None);
                }
            }
            crate::agent::refresh_credentials();
            Ok(json!({ "ok": true }))
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
mod node_import_file_tests {
    use super::*;

    fn temp_path(tag: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "veyl-import-{tag}-{:016x}",
            rand::random::<u64>()
        ))
    }

    #[test]
    fn relative_or_empty_paths_are_rejected() {
        for path in ["", "nodes.txt", "./nodes.txt", "~/nodes.txt"] {
            let error = read_node_file(path).unwrap_err();
            assert_eq!(error["code"], "INVALID_ARGUMENT");
            assert_eq!(error["details"]["reason"], "invalid_path", "{path:?}");
        }
    }

    #[test]
    fn a_directory_is_not_a_readable_file() {
        let dir = std::env::temp_dir();
        let error = read_node_file(dir.to_str().unwrap()).unwrap_err();
        assert_eq!(error["code"], "INVALID_ARGUMENT");
        assert_eq!(error["details"]["reason"], "file_unreadable");
    }

    #[test]
    fn a_missing_path_is_reported_as_unreadable() {
        let missing = temp_path("missing");
        let error = read_node_file(missing.to_str().unwrap()).unwrap_err();
        assert_eq!(error["details"]["reason"], "file_unreadable");
    }

    #[test]
    fn files_over_one_mib_are_rejected_with_the_limit() {
        let path = temp_path("big");
        std::fs::write(&path, vec![b'a'; (MAX_NODE_FILE_BYTES + 1) as usize]).unwrap();
        let error = read_node_file(path.to_str().unwrap()).unwrap_err();
        assert_eq!(error["details"]["reason"], "file_too_large");
        assert_eq!(error["details"]["max_bytes"], MAX_NODE_FILE_BYTES);
        let _ = std::fs::remove_file(&path);
    }

    /// 边界另一侧：恰好 1 MiB 是允许的，不能被上限本身挡掉。
    #[test]
    fn exactly_one_mib_is_accepted() {
        let path = temp_path("limit");
        std::fs::write(&path, vec![b'a'; MAX_NODE_FILE_BYTES as usize]).unwrap();
        let text = read_node_file(path.to_str().unwrap()).unwrap();
        assert_eq!(text.len() as u64, MAX_NODE_FILE_BYTES);
        let _ = std::fs::remove_file(&path);
    }

    #[cfg(unix)]
    #[test]
    fn a_symlink_to_a_directory_is_rejected() {
        let link = temp_path("dirlink");
        std::os::unix::fs::symlink(std::env::temp_dir(), &link).unwrap();
        let error = read_node_file(link.to_str().unwrap()).unwrap_err();
        assert_eq!(error["code"], "INVALID_ARGUMENT");
        assert_eq!(error["details"]["reason"], "file_unreadable");
        let _ = std::fs::remove_file(&link);
    }

    /// 符号链接指向 FIFO：必须被判为不可读，且不能卡在 `open` 上。
    #[cfg(unix)]
    #[test]
    fn a_symlink_to_a_fifo_is_rejected_without_blocking() {
        let fifo = temp_path("fifo");
        let status = std::process::Command::new("mkfifo")
            .arg(&fifo)
            .status()
            .unwrap();
        assert!(status.success());

        let link = temp_path("fifolink");
        std::os::unix::fs::symlink(&fifo, &link).unwrap();

        let (tx, rx) = std::sync::mpsc::channel();
        let target = link.clone();
        std::thread::spawn(move || {
            let _ = tx.send(read_node_file(target.to_str().unwrap()));
        });
        let outcome = rx
            .recv_timeout(std::time::Duration::from_secs(2))
            .expect("读取 FIFO 不能阻塞");
        let error = outcome.unwrap_err();
        assert_eq!(error["details"]["reason"], "file_unreadable");

        let _ = std::fs::remove_file(&link);
        let _ = std::fs::remove_file(&fifo);
    }

    /// 报错消息里不能回显路径：路径可能带用户名等身份信息。
    #[test]
    fn error_messages_do_not_echo_the_path() {
        let missing = temp_path("hidden");
        let shown = missing.to_str().unwrap().to_string();
        let error = read_node_file(&shown).unwrap_err();
        assert!(!error["message"].as_str().unwrap().contains(&shown));

        let dir = std::env::temp_dir();
        let shown = dir.to_str().unwrap().to_string();
        let error = read_node_file(&shown).unwrap_err();
        assert!(!error["message"].as_str().unwrap().contains(&shown));

        let big = temp_path("hiddenbig");
        std::fs::write(&big, vec![b'a'; (MAX_NODE_FILE_BYTES + 1) as usize]).unwrap();
        let shown = big.to_str().unwrap().to_string();
        let error = read_node_file(&shown).unwrap_err();
        assert!(!error["message"].as_str().unwrap().contains(&shown));
        let _ = std::fs::remove_file(&big);
    }

    #[test]
    fn a_valid_file_is_read_as_lossy_utf8() {
        let path = temp_path("ok");
        std::fs::write(&path, b"ss://aes-256-gcm:pw@203.0.113.10:8388#A").unwrap();
        assert_eq!(
            read_node_file(path.to_str().unwrap()).unwrap(),
            "ss://aes-256-gcm:pw@203.0.113.10:8388#A"
        );
        let _ = std::fs::remove_file(&path);

        // 非法字节替换为 U+FFFD；不做编码猜测，也不因此报错。
        let path = temp_path("utf8");
        std::fs::write(&path, [b's', b's', b':', 0xff]).unwrap();
        assert!(read_node_file(path.to_str().unwrap())
            .unwrap()
            .ends_with('\u{FFFD}'));
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn an_empty_file_reads_as_empty_text() {
        // 空文件本身可读；「没有可用节点」由共用的解析器判断。
        let path = temp_path("empty");
        std::fs::write(&path, b"").unwrap();
        assert_eq!(read_node_file(path.to_str().unwrap()).unwrap(), "");
        let _ = std::fs::remove_file(&path);
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

#[cfg(test)]
mod hidden_message_tests {
    use super::record_user_message;
    use crate::store::Store;

    /// 系统代发的开场触发不能出现在聊天记录里。
    #[test]
    fn hidden_messages_are_not_persisted() {
        let store = Store::open_in_memory().unwrap();
        record_user_message(&store, "ses_hidden", "系统代发的开场", true);

        let conn = store.conn();
        assert!(
            crate::store::chat::messages(&conn, "ses_hidden")
                .unwrap()
                .is_empty(),
            "hidden=true 时不该落库"
        );
    }

    /// 缺省（不传 hidden）必须和以前逐字一致：照常落库。
    #[test]
    fn visible_messages_are_persisted() {
        let store = Store::open_in_memory().unwrap();
        record_user_message(&store, "ses_visible", "你好", false);

        let conn = store.conn();
        let messages = crate::store::chat::messages(&conn, "ses_visible").unwrap();
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0].content, "你好");
    }
}

#[cfg(test)]
mod send_message_tests {
    use super::*;
    use std::sync::Arc;

    fn install_store() {
        if crate::store::global().is_none() {
            let store = Arc::new(crate::store::Store::open_in_memory().expect("内存库"));
            crate::store::install_global(store);
        }
    }

    fn test_state() -> Arc<AppState> {
        Arc::new(crate::agent::AppState::new_without_keychain(Arc::new(
            crate::tools::services::NotWiredServices,
        )))
    }

    /// 同一会话第二条请求必须被拒绝，而且**不能落库**。
    #[tokio::test]
    async fn a_second_send_is_rejected_without_persisting() {
        install_store();
        let state = test_state();
        let session_id = "ses_busy_test";

        let first = AppState::next_request_id();
        let token = state.reserve_request(&first, session_id).unwrap();
        assert!(!token.is_cancelled());
        let second = AppState::next_request_id();
        assert_eq!(
            state.reserve_request(&second, session_id).unwrap_err(),
            first,
            "同一会话只能有一个请求槽"
        );

        let error = send_message_for_state(&state, session_id, "第二条", false)
            .await
            .unwrap_err();
        assert_eq!(error["code"], "BUSY");
        assert_eq!(error["details"]["reason"], "request_in_flight");
        assert_eq!(error["details"]["active_request_id"], first.as_str());

        let store = crate::store::global().expect("全局库已安装");
        let conn = store.conn();
        assert!(
            crate::store::chat::messages(&conn, session_id)
                .unwrap()
                .is_empty(),
            "被拒绝的消息不能落库"
        );

        state.finish_request(&first);
    }

    /// 成功路径：占槽 → guard 释放 → 可再次占槽。
    #[tokio::test]
    async fn the_slot_is_released_by_the_guard() {
        let state = test_state();
        let id = AppState::next_request_id();
        state.reserve_request(&id, "ses_guard").unwrap();
        drop(RequestSlotGuard {
            state: Arc::clone(&state),
            request_id: id,
        });
        assert!(state
            .reserve_request(&AppState::next_request_id(), "ses_guard")
            .is_ok());
    }

    /// 任务 panic 时 guard 照样释放，不会留下永久 BUSY。
    #[tokio::test]
    async fn a_panicking_task_releases_the_slot() {
        let state = test_state();
        let id = AppState::next_request_id();
        state.reserve_request(&id, "ses_panic").unwrap();
        let guard = RequestSlotGuard {
            state: Arc::clone(&state),
            request_id: id,
        };
        let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(move || {
            let _held = guard;
            panic!("boom");
        }));
        assert!(outcome.is_err());
        assert!(
            state
                .reserve_request(&AppState::next_request_id(), "ses_panic")
                .is_ok(),
            "panic 后槽位必须释放"
        );
    }

    /// 会话创建失败（没有凭据）也要释放槽位，不留下一条永远没人处理的“进行中”。
    #[tokio::test]
    async fn a_failed_session_creation_releases_the_slot() {
        let state = test_state();
        let session_id = "ses_no_credentials";
        let error = send_message_for_state(&state, session_id, "你好", false)
            .await
            .unwrap_err();
        assert_eq!(error["code"], "INTERNAL", "{error}");
        assert!(
            state
                .reserve_request(&AppState::next_request_id(), session_id)
                .is_ok(),
            "会话创建失败后槽位必须释放"
        );
    }

    /// 空文本在占槽与落库之前就被拒绝。
    #[tokio::test]
    async fn empty_text_is_rejected_before_reserving() {
        install_store();
        let state = test_state();
        let session_id = "ses_empty";
        let error = send_message_for_state(&state, session_id, "   ", false)
            .await
            .unwrap_err();
        assert_eq!(error["code"], "INVALID_ARGUMENT");
        assert_eq!(error["details"]["reason"], "empty_text");
        assert!(
            state
                .reserve_request(&AppState::next_request_id(), session_id)
                .is_ok(),
            "被拒绝的空消息不能占槽"
        );
        let store = crate::store::global().expect("全局库已安装");
        let conn = store.conn();
        assert!(crate::store::chat::messages(&conn, session_id)
            .unwrap()
            .is_empty());
    }

    /// 取消只命中指定请求；迟到的取消与旧 request_id 都不能误伤新请求。
    #[tokio::test]
    async fn cancel_targets_only_the_matching_request() {
        let state = test_state();
        let first = AppState::next_request_id();
        let token = state.reserve_request(&first, "ses_cancel").unwrap();
        assert!(!state.cancel_request("req_other"));
        assert!(!token.is_cancelled(), "别的 request_id 不能取消它");
        assert!(state.cancel_request(&first));
        assert!(token.is_cancelled());

        state.finish_request(&first);
        assert!(
            !state.cancel_request(&first),
            "迟到的取消不能命中已结束的请求"
        );

        let second = AppState::next_request_id();
        let token = state.reserve_request(&second, "ses_cancel").unwrap();
        assert!(
            !state.cancel_request(&first),
            "旧 request_id 不能取消新请求"
        );
        assert!(!token.is_cancelled());
        state.finish_request(&second);
    }
}

#[cfg(test)]
mod proxy_port_command_tests {
    use super::*;
    use std::sync::Arc;

    fn install_store() {
        if crate::store::global().is_none() {
            let store = Arc::new(crate::store::Store::open_in_memory().expect("内存库"));
            crate::store::install_global(store);
        }
    }

    #[tokio::test]
    async fn set_validates_and_reports_three_states() {
        install_store();

        // 被占：占用者仍活着。
        let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let occupied = listener.local_addr().unwrap().port();
        let saved = proxy_port_set(json!(occupied)).await.unwrap();
        assert_eq!(saved["port"], json!(occupied));
        assert_eq!(saved["availability"], "occupied");

        // 可绑定。
        let free = crate::config::any_free_port().unwrap();
        let saved = proxy_port_set(json!(free)).await.unwrap();
        assert_eq!(saved["availability"], "free");

        // 非法值全部拒绝，且不能改库。
        for bad in [
            json!(0),
            json!(65536),
            json!(-1),
            json!(12.5),
            json!("8080"),
        ] {
            let error = proxy_port_set(bad.clone()).await.unwrap_err();
            assert_eq!(error["code"], "INVALID_ARGUMENT", "{bad}");
            assert_eq!(error["details"]["reason"], "invalid_port", "{bad}");
        }

        let current = proxy_port_get().await.unwrap();
        assert_eq!(current["port"], json!(free), "非法值不能改库");
        assert_eq!(current["default_port"], json!(7890));
    }
}
