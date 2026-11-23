//! 前端可调用的命令面。命令名已冻结（`docs/contracts/events.md` §5）。

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};
use tauri::State;

use super::ui_context;
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
    text: Option<String>,
    hidden: Option<bool>,
    context: Option<Value>,
) -> Result<Value, Value> {
    send_message_for_state(
        state.inner(),
        &session_id,
        text.as_deref(),
        hidden.unwrap_or(false),
        context.as_ref(),
    )
    .await
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
    text: Option<&str>,
    hidden: bool,
    context: Option<&Value>,
) -> Result<Value, Value> {
    // 界面上报先校验：太大或 screen 不认识时，整条消息都不发送。
    let parsed_context = match context {
        Some(value) => {
            let action_ids = crate::store::global()
                .map(|store| ui_context::rendered_action_ids(store))
                .unwrap_or_default();
            Some(ui_context::parse(value, &action_ids).map_err(|error| {
                command_error(
                    "INVALID_ARGUMENT",
                    error.message(),
                    json!({ "reason": error.reason() }),
                )
            })?)
        }
        None => None,
    };

    let (user_text, task_text) = prepare_message(
        text,
        hidden,
        parsed_context.as_ref(),
        client_status(parsed_context.as_ref()).as_ref(),
    )?;

    // 没有任何可用 AI 时直接拒绝（契约 §9.1，2.52.0）：不占槽、不落库、不建会话。
    // 放在输入校验之后：非法请求就是非法请求，不因 AI 未配置改报另一种错误。
    // 只兜住绕过界面的直接命令调用；界面以前端判断为准。
    require_configured_ai(state)?;

    let request_id = AppState::next_request_id();
    let cancel = match state.reserve_request(&request_id, session_id) {
        Ok(token) => token,
        Err(active_request_id) => {
            return Err(json!({
                "contract_version": crate::runtime::EVENT_CONTRACT_VERSION,
                "code": "BUSY",
                "message": "",
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
    // context 只在内存里包给模型，不写 chat_messages / tool_calls。
    if !hidden {
        if let Some(store) = crate::store::global() {
            record_user_message(store, session_id, &user_text, false);
        }
    }

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

/// 未配置 AI 时拒绝发送（契约 §9.1，2.52.0）。
///
/// 只回答「有没有配」：当前 active provider 有 Key 或是本机端点即可，
/// 不在这里验证 Key 是否有效——那是保存/测试连接的事。
fn require_configured_ai(state: &AppState) -> Result<(), Value> {
    if state.has_credentials() {
        return Ok(());
    }
    Err(command_error(
        "AI_NOT_CONFIGURED",
        "还没有配置 AI 服务",
        json!({ "reason": "ai_not_configured" }),
    ))
}

/// `screen = client` 时补上界面 chip 的当前值。
///
/// 只读活跃配置（与 chip 同源），**不读运行时**：`runtime_status()` 在 TUN 下
/// 可能触发一次助手探测（最长 10s），发消息的路径不该被它拖住；芯片显示的就是
/// 配置值，助手按同一套话说才不会和界面打架。
///
/// **不要「顺手改成实际生效路径」**：那会把一次最长 10s 的探测塞进每条消息的
/// 发送路径，卡顿还很难归因。真要报实际路径，走工具，不在这一层做。
fn client_status(context: Option<&ui_context::UiContext>) -> Option<ui_context::ClientStatus> {
    if context?.screen != "client" {
        return None;
    }
    let store = crate::store::global()?;
    let conn = store.conn();
    let config = crate::store::configs::active(&conn).ok().flatten()?;
    Some(ui_context::ClientStatus::from_config(
        &config.connection_mode,
        &config.routing_mode,
    ))
}

/// 分出「落库/展示的用户文本」与「送给模型的文本」。
///
/// `context` 只进后者：`chat_messages` 里永远只有用户原话或 Host 生成的界面事件。
fn prepare_message(
    text: Option<&str>,
    hidden: bool,
    context: Option<&ui_context::UiContext>,
    client: Option<&ui_context::ClientStatus>,
) -> Result<(String, String), Value> {
    let trimmed = text.unwrap_or_default().trim();
    let user_text = if trimmed.is_empty() {
        // 唯一例外：系统代发（hidden）且刚点了一个界面按钮，文本由 Host 生成。
        match (context, hidden) {
            (Some(context), true) if context.last_action.is_some() => {
                ui_context::generated_text(context).expect("last_action 一定有文本")
            }
            _ => {
                return Err(json!({
                    "contract_version": crate::runtime::EVENT_CONTRACT_VERSION,
                    "code": "INVALID_ARGUMENT",
                    "message": "",
                    "retryable": false,
                    "details": { "reason": "empty_text" },
                    "request_id": "",
                }))
            }
        }
    } else {
        trimmed.to_string()
    };
    let model_text = ui_context::model_text_with_client(context, client, &user_text);
    Ok((user_text, model_text))
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

/// 应用内退出确认的决策。第二次决策与未知取值都不改状态。
#[tauri::command]
pub async fn quit_decision(action: String) -> Result<Value, Value> {
    match crate::lifecycle::resolve_quit_decision(&action) {
        Some(accepted) => Ok(json!({ "accepted": accepted })),
        None => Err(command_error(
            "INVALID_ARGUMENT",
            "action 只能是 background 或 quit",
            json!({ "reason": "invalid_action" }),
        )),
    }
}

/// 免费节点 7 天试用状态。只读本地，不触发到期清理。
#[tauri::command]
pub async fn trial_status(state: State<'_, Arc<AppState>>) -> Result<Value, Value> {
    state.services.trial_status().await.map_err(error_value)
}

/// 界面可见的错误信封：`message` 恒为空串（契约 §1.2 / §1.6），诊断文本只进日志。
fn command_error(code: &str, message: impl std::fmt::Display, details: Value) -> Value {
    let message = message.to_string();
    if !message.is_empty() {
        log::warn!("[command] {code}: {message}");
    }
    json!({
        "contract_version": crate::runtime::EVENT_CONTRACT_VERSION,
        "code": code,
        "message": "",
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

/// 读语言设置：`selected` 是存库档位，`resolved` 是实际语言。
/// 系统语言只在 Rust 解析，前端不自己读 OS locale。
#[tauri::command]
pub async fn app_language_get() -> Result<Value, Value> {
    let Some(store) = crate::store::global() else {
        return Err(command_error("INTERNAL", "", Value::Null));
    };
    let selected = {
        let conn = store.conn();
        crate::store::settings::app_language(&conn)
    };
    Ok(json!({
        "selected": selected,
        "resolved": crate::i18n::resolve(selected),
    }))
}

/// 保存语言档位。只认 `system` / `zh` / `en`；**先写库成功再返回新值**。
/// 失败只返回稳定错误码，不带文案（Q4：文案由前端按 code 映射）。
#[tauri::command]
pub async fn app_language_set(language: Option<Value>) -> Result<Value, Value> {
    let language = language
        .as_ref()
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    if language != crate::i18n::SELECTED_SYSTEM && !crate::i18n::LANGUAGES.contains(&language) {
        return Err(command_error(
            "INVALID_ARGUMENT",
            "",
            json!({ "reason": "invalid_language" }),
        ));
    }

    let Some(store) = crate::store::global() else {
        return Err(command_error("INTERNAL", "", Value::Null));
    };
    {
        let conn = store.conn();
        crate::store::settings::set_app_language(&conn, language)
            .map_err(|_| command_error("INTERNAL", "", Value::Null))?;
    }
    Ok(json!({
        "selected": language,
        "resolved": crate::i18n::resolve(language),
    }))
}

/// 本次启动读到的系统代理自动恢复结果（契约 §7.13，仅 UI，只读）。
///
/// 恢复发生在 Host `setup` 阶段、webview 注册监听之前，所以用一次性读取而不是事件。
/// 同一进程内重复调用返回同一个值，不清除、不需要 ack。
#[tauri::command]
pub async fn proxy_recovery_report(state: State<'_, Arc<AppState>>) -> Result<Value, Value> {
    Ok(json!({ "recovery": state.proxy_recovery() }))
}

/// 「我的服务器」目录：地区与套餐（只读，仅 UI；控制面公开接口）。
///
/// base_url 由 `control_plane::env` 决定，release 只认 prod；这里不写死域名。
#[tauri::command]
pub async fn my_server_catalog(
    state: State<'_, Arc<AppState>>,
    fresh: Option<bool>,
) -> Result<Value, Value> {
    // 与 StageSelect / CatalogOptions 共用 `VpnToolServices::server_catalog()`。
    // 只有打开新建向导时才要求回源（`fresh = true`）；页面加载等不带参数的路径
    // 走控制面的全局年龄判断，避免每次进页面都打 DO（commands.md §7.14）。
    let source = state.services.server_catalog();
    let result = if fresh.unwrap_or(false) {
        source.fetch_fresh().await
    } else {
        source.fetch().await
    };
    match result {
        Ok(catalog) => serde_json::to_value(catalog)
            .map_err(|error| command_error("INTERNAL", error, Value::Null)),
        Err(error) => {
            log::warn!("[my_server_catalog] {}: {}", error.code, error.message);
            Err(json!({
                "contract_version": crate::runtime::EVENT_CONTRACT_VERSION,
                "code": error.code,
                "message": "",
                "retryable": error.retryable,
                "details": error.details,
                "request_id": "",
            }))
        }
    }
}

// ---- 我的服务器（§19.9，仅 UI 通道）----
//
// 命令层只做参数搬运；设备令牌、幂等键、验签与本地镜像都在
// `control_plane::{auth,servers,credentials}`，AI 工具不经过这里。

#[tauri::command]
pub async fn my_server_list(state: State<'_, Arc<AppState>>) -> Result<Value, Value> {
    match crate::control_plane::servers::list().await {
        Ok(servers) => {
            log::debug!("我的服务器：列表成功 count={}", servers.len());
            // 列表对齐后顺手收敛「服务器没了、节点还在」的残留（正常情况下零请求）。
            super::server_watch::reconcile_orphan_owned_nodes(
                Arc::clone(&state.services),
                &servers,
            )
            .await;
            Ok(json!({ "servers": servers }))
        }
        Err(error) => {
            log::warn!(
                "我的服务器：列表失败 code={} reason={} retryable={} message={}",
                error.code,
                error.reason().unwrap_or("-"),
                error.retryable,
                error.message
            );
            Err(error.envelope())
        }
    }
}

/// 顺手确认一次服务器是否已被停机销毁。
///
/// 超时只包「取详情 + 重读」（在 `ensure_current_server_alive` 内部）；确定为已销毁后的
/// `runtime_stop` 丢到后台任务，既不进超时、也不让详情请求等它（被取消会把运行时卡在
/// `stopping`）。
async fn check_server_alive_quietly(state: &Arc<AppState>, server_id: &str) {
    let services = Arc::clone(&state.services);
    super::server_watch::ensure_current_server_alive(services, server_id).await;
}

#[tauri::command]
pub async fn my_server_get(
    state: State<'_, Arc<AppState>>,
    server_id: String,
) -> Result<Value, Value> {
    match crate::control_plane::servers::get(&server_id).await {
        Ok(server) => {
            // 点开的就是当前连着的服务器时顺手确认一次：已经被停机销毁的话先把隧道停掉。
            check_server_alive_quietly(state.inner(), &server_id).await;
            Ok(json!(server))
        }
        Err(error) => Err(error.envelope()),
    }
}

#[tauri::command]
pub async fn my_server_create(
    region: String,
    plan: String,
    idempotency_key: String,
) -> Result<Value, Value> {
    match crate::control_plane::servers::create(&region, &plan, &idempotency_key).await {
        Ok(order) => {
            crate::control_plane::events::emit_order_changed(&order);
            Ok(json!(order))
        }
        Err(error) => Err(error.envelope()),
    }
}

/// 确认下单并开始建机（2.39.0，仅 UI）：不再扣费，返回 `MyServerOrder`；
/// 余额门槛（日价 × 7）不足时原样透出 `required_cents` / `shortfall_cents` / `min_days`。
#[tauri::command]
pub async fn my_server_checkout(order_id: String) -> Result<Value, Value> {
    match crate::control_plane::servers::checkout(&order_id).await {
        Ok(order) => {
            log::info!(
                "我的服务器：确认下单 order={} state={}（就绪后结算）",
                order.order_id,
                order.state
            );
            serde_json::to_value(&order)
                .map_err(|error| command_error("INTERNAL", error, Value::Null))
        }
        Err(error) => {
            log::warn!(
                "我的服务器：确认下单失败 order={} code={} reason={} retryable={}",
                order_id,
                error.code,
                error.reason().unwrap_or("-"),
                error.retryable
            );
            Err(error.envelope())
        }
    }
}

/// 读钱包余额（仅 UI）。
#[tauri::command]
pub async fn my_server_wallet() -> Result<Value, Value> {
    match crate::control_plane::servers::wallet().await {
        Ok(wallet) => Ok(json!(wallet)),
        Err(error) => Err(error.envelope()),
    }
}

/// 创建充值会话并在系统浏览器打开（仅 UI）。
#[tauri::command]
pub async fn my_server_topup(app: tauri::AppHandle, denomination: i64) -> Result<Value, Value> {
    match crate::control_plane::servers::topup(denomination).await {
        Ok(topup) => {
            log::info!(
                "我的服务器：充值会话创建 denomination_cents={} topup={} checkout_url={}",
                topup.denomination_cents,
                topup.topup_id,
                if topup.checkout_url.is_some() { "有" } else { "无" }
            );
            let opened = match topup.checkout_url.as_deref() {
                Some(url) => open_checkout_url(&app, url),
                None => Ok(()),
            };
            if let Err(error) = &opened {
                log::warn!(
                    "我的服务器：收银台打开失败 topup={} error={}",
                    topup.topup_id,
                    error
                );
            }
            finish_topup(topup, opened)
        }
        Err(error) => {
            log::warn!(
                "我的服务器：充值失败 denomination_cents={} code={} reason={} retryable={}",
                denomination,
                error.code,
                error.reason().unwrap_or("-"),
                error.retryable
            );
            Err(error.envelope())
        }
    }
}

/// 系统默认浏览器打开充值收银台；失败把原因交给命令层，由它带着链接报错。
fn open_checkout_url(app: &tauri::AppHandle, url: &str) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;

    if !url.starts_with("https://") {
        log::warn!("收银台地址不是 https，拒绝打开：{url}");
        return Err("checkout_url_not_https".into());
    }
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|error| error.to_string())
}

/// 收银台打开结果落到命令返回值：成功返回会话，失败返回错误并带上可重开/可复制的链接。
fn finish_topup(
    topup: crate::control_plane::servers::MyServerTopup,
    opened: Result<(), String>,
) -> Result<Value, Value> {
    match opened {
        Ok(()) => Ok(json!(topup)),
        Err(detail) => {
            log::warn!("[topup] 收银台打开失败：{detail}");
            Err(json!({
                "contract_version": crate::runtime::EVENT_CONTRACT_VERSION,
                "code": "INTERNAL",
                "message": "",
                "retryable": false,
                "details": {
                    "reason": "checkout_open_failed",
                    "topup_id": topup.topup_id,
                    "checkout_url": topup.checkout_url,
                },
                "request_id": "",
            }))
        }
    }
}

/// 支付与开通轮询（仅 UI）。
#[tauri::command]
pub async fn my_server_order_get(order_id: String) -> Result<Value, Value> {
    match crate::control_plane::servers::get_order(&order_id).await {
        Ok(order) => Ok(json!(order)),
        Err(error) => Err(error.envelope()),
    }
}

/// 发邮箱验证码（仅 UI）；60 秒冷却与同 IP 限频由控制面决定。
#[tauri::command]
pub async fn my_server_login_start(email: String) -> Result<Value, Value> {
    match crate::control_plane::auth::login_start(&email).await {
        Ok(ticket) => {
            log::info!(
                "登录：验证码请求结果 sent={} cooldown_seconds={} retry_after_seconds={}",
                ticket.sent,
                ticket.cooldown_seconds,
                ticket
                    .retry_after_seconds
                    .map(|value| value.to_string())
                    .unwrap_or_else(|| "-".into())
            );
            Ok(json!(ticket))
        }
        Err(error) => {
            log::warn!(
                "登录：验证码请求失败 code={} reason={} retryable={} cooldown_seconds={}",
                error.code,
                error.reason().unwrap_or("-"),
                error.retryable,
                error
                    .details
                    .get("retry_after_seconds")
                    .and_then(Value::as_u64)
                    .map(|value| value.to_string())
                    .unwrap_or_else(|| "-".into())
            );
            Err(error.envelope())
        }
    }
}

/// 校验验证码并登录（仅 UI）；设备证明由 Host 自动带。
#[tauri::command]
pub async fn my_server_login_verify(email: String, code: String) -> Result<Value, Value> {
    match crate::control_plane::auth::login_verify(&email, &code).await {
        Ok(account) => {
            log::info!(
                "登录：验证码校验成功 logged_in={} account_kind={} account={}",
                account.logged_in,
                account.account_kind.as_deref().unwrap_or("-"),
                account.account_id.as_deref().unwrap_or("-")
            );
            Ok(json!(account))
        }
        Err(error) => {
            log::warn!(
                "登录：验证码校验失败 code={} reason={} retryable={} attempts_remaining={}",
                error.code,
                error.reason().unwrap_or("-"),
                error.retryable,
                error
                    .details
                    .get("attempts_remaining")
                    .and_then(Value::as_u64)
                    .map(|value| value.to_string())
                    .unwrap_or_else(|| "-".into())
            );
            Err(error.envelope())
        }
    }
}

/// 只读本地登录态（仅 UI）：不联网、不刷新令牌。
///
/// 如果最近 60 秒内有控制面请求在传输层失败（DNS / 连接 / 超时），返回错误而不是
/// 「未登录」：界面据此显示「控制面不可达 / 检查网络」，不能把用户推回登录引导。
#[tauri::command]
pub async fn my_server_account() -> Result<Value, Value> {
    if let Some(error) = crate::control_plane::auth::control_plane_unreachable() {
        return Err(error.envelope());
    }
    Ok(json!(crate::control_plane::auth::account_state()))
}

/// 服务端登出（仅 UI）：网络/5xx 原样上报；服务端拒绝（401/403）时清本地令牌与账户标记，
/// 返回未登录态——账户被停用时用户也必须能退出去。
#[tauri::command]
pub async fn my_server_logout() -> Result<Value, Value> {
    match crate::control_plane::auth::logout().await {
        Ok(account) => Ok(json!(account)),
        Err(error) => Err(error.envelope()),
    }
}

#[tauri::command]
pub async fn my_server_rename(server_id: String, name: String) -> Result<Value, Value> {
    match crate::control_plane::servers::rename(&server_id, &name).await {
        Ok(server) => {
            crate::control_plane::events::emit_server_renamed(&server);
            Ok(json!(server))
        }
        Err(error) => Err(error.envelope()),
    }
}

#[tauri::command]
pub async fn my_server_cancel_order(order_id: String) -> Result<Value, Value> {
    match crate::control_plane::servers::cancel_order(&order_id).await {
        Ok(order) => {
            crate::control_plane::events::emit_order_changed(&order);
            Ok(json!(order))
        }
        Err(error) => Err(error.envelope()),
    }
}

#[tauri::command]
pub async fn my_server_destroy(
    state: State<'_, Arc<AppState>>,
    server_id: String,
    confirm: bool,
) -> Result<Value, Value> {
    let stop_services = Arc::clone(&state.services);
    match destroy_server_with(
        &server_id,
        // 没确认就什么都没发生：不能因为一次误调先把隧道停了。
        || confirm && super::server_watch::is_current_server(&server_id),
        move || {
            let services = Arc::clone(&stop_services);
            async move {
                match services.runtime_stop(false).await {
                    Ok(_) => true,
                    Err(error) => {
                        log::warn!("停止运行时失败：{error}");
                        false
                    }
                }
            }
        },
        || async { crate::control_plane::servers::destroy(&server_id, confirm).await },
    )
    .await
    {
        Ok(server) => Ok(json!(server)),
        Err(error) => Err(error.envelope()),
    }
}

/// 销毁编排：当前节点先停运行时再发请求；没停成就在销毁成功后补停一次。
///
/// 先停是因为销毁请求要走网络：控制面同步删 droplet，隧道随机器一起死，请求会被
/// 自己删掉的隧道掐断。停失败只 warn，继续销毁（用户点销毁已接受断线）。
///
/// `stop` 回报的是**真的停成了**（`runtime_stop` 的 `Ok`），不是「试过了」：
/// 销毁成功后节点行已删、`current_node_id` 已被外键置 NULL，那时再查只会得到
/// 「不是当前节点」，所以必须用请求前的 `was_current` 决定要不要补停。
pub(crate) async fn destroy_server_with<C, S, SF, D, DFut>(
    server_id: &str,
    is_current: C,
    stop: S,
    destroy: D,
) -> Result<crate::control_plane::servers::MyServer, crate::control_plane::error::CpError>
where
    C: Fn() -> bool,
    S: Fn() -> SF,
    SF: std::future::Future<Output = bool>,
    D: Fn() -> DFut,
    DFut: std::future::Future<
        Output = Result<crate::control_plane::servers::MyServer, crate::control_plane::error::CpError>,
    >,
{
    let was_current = is_current();
    let mut stopped = false;
    if was_current {
        stopped = stop().await;
    }
    match destroy().await {
        Ok(server) => {
            // pre-stop 没成功（运行期操作锁超时等）而销毁成功：节点已删、隧道还活着，
            // 正是 2.45.1 要消灭的症状，补停一次（失败仍只 warn）。
            if was_current && !stopped {
                log::warn!("销毁前停止运行时没成功，补停一次 server={server_id}");
                stop().await;
            }
            Ok(server)
        }
        Err(error) => {
            // 结果不确定：远端可能已经删了，隧道不断用户连重试都做不到。
            if !stopped && is_current() && destroy_outcome_uncertain(&error) {
                log::warn!("销毁结果不确定，先停止运行时 server={server_id}：{}", error.message);
                stop().await;
            }
            Err(error)
        }
    }
}

/// 没有拿到结构化响应（传输层失败/超时）：请求可能已经在服务端生效。
/// 服务端明确回的 4xx/5xx 不带 `transport` 标记，不算。
fn destroy_outcome_uncertain(error: &crate::control_plane::error::CpError) -> bool {
    error.code == "TIMEOUT"
        || error
            .details
            .get("transport")
            .and_then(Value::as_bool)
            .unwrap_or(false)
}

#[tauri::command]
pub async fn my_server_rebuild(server_id: String, confirm: bool) -> Result<Value, Value> {
    match crate::control_plane::servers::rebuild(&server_id, confirm).await {
        Ok(value) => Ok(value),
        Err(error) => Err(error.envelope()),
    }
}

#[tauri::command]
pub async fn my_server_credentials(server_id: String) -> Result<Value, Value> {
    match crate::control_plane::servers::credentials(&server_id).await {
        Ok(value) => Ok(value),
        Err(error) => Err(error.envelope()),
    }
}

/// 节点配置同步（仅 UI，契约 §7.28）：一次拉列表 + 逐台取凭据落库。
#[tauri::command]
pub async fn my_server_sync() -> Result<Value, Value> {
    match crate::control_plane::servers::sync_all().await {
        Ok(data) => Ok(serde_json::to_value(data).unwrap_or(Value::Null)),
        Err(error) => Err(error.envelope()),
    }
}

const SERVER_SYNC_INTERVAL_KEY: &str = "server_sync_interval_minutes";
const SERVER_SYNC_INTERVAL_DEFAULT: u16 = 240;
const SERVER_SYNC_INTERVALS: [u16; 6] = [0, 30, 60, 240, 480, 1440];

fn parse_sync_interval(minutes: Option<&str>) -> u16 {
    minutes
        .and_then(|value| value.trim().parse::<u16>().ok())
        .filter(|value| SERVER_SYNC_INTERVALS.contains(value))
        .unwrap_or(SERVER_SYNC_INTERVAL_DEFAULT)
}

/// 节点配置同步间隔（仅 UI，契约 §7.29）。读不写库：缺失或存库值非法都按 240。
#[tauri::command]
pub async fn server_sync_interval_get() -> Result<Value, Value> {
    let Some(store) = crate::store::global() else {
        log::warn!("[server_sync_interval] code=INTERNAL reason=store_unavailable");
        return Err(command_error("INTERNAL", "", Value::Null));
    };
    let raw = {
        let conn = store.conn();
        match crate::store::settings::get(&conn, SERVER_SYNC_INTERVAL_KEY) {
            Ok(value) => value,
            Err(_) => {
                log::warn!("[server_sync_interval] code=INTERNAL reason=store_error");
                None
            }
        }
    };
    Ok(json!({ "minutes": parse_sync_interval(raw.as_deref()) }))
}

/// 节点配置同步间隔（仅 UI，契约 §7.29）。只认 0/30/60/240/480/1440，先写库成功再返回。
#[tauri::command]
pub async fn server_sync_interval_set(minutes: Value) -> Result<Value, Value> {
    let minutes = minutes
        .as_u64()
        .and_then(|value| u16::try_from(value).ok())
        .filter(|value| SERVER_SYNC_INTERVALS.contains(value));
    let Some(minutes) = minutes else {
        log::warn!("[server_sync_interval] code=INVALID_ARGUMENT reason=invalid_interval");
        return Err(command_error(
            "INVALID_ARGUMENT",
            "",
            json!({ "reason": "invalid_interval" }),
        ));
    };
    let Some(store) = crate::store::global() else {
        log::warn!("[server_sync_interval] code=INTERNAL reason=store_unavailable");
        return Err(command_error("INTERNAL", "", Value::Null));
    };
    let saved = {
        let conn = store.conn();
        crate::store::settings::set(&conn, SERVER_SYNC_INTERVAL_KEY, &minutes.to_string())
    };
    if saved.is_err() {
        log::warn!("[server_sync_interval] code=INTERNAL reason=store_error");
        return Err(command_error("INTERNAL", "", Value::Null));
    }
    Ok(json!({ "minutes": minutes }))
}

/// 界面「智能修复」：与 AI 工具 `NodeRotateCredentials` 共用同一个执行入口
/// （`tools::node_rotate::rotate_from_ui` → `execute_rotation`），90 秒超时与凭据刷新都不另起一套。
///
/// 按钮本身就是用户确认，所以不弹确认卡；失败 reason 与工具完全一致，前端按 reason 选文案。
/// 令牌与密码不进返回值。
#[tauri::command]
pub async fn node_rotate_credentials(server_id: Option<Value>) -> Result<Value, Value> {
    match crate::tools::node_rotate::rotate_from_ui(server_id).await {
        Ok(value) => Ok(value),
        Err(error) => Err(json!({
            "contract_version": crate::runtime::EVENT_CONTRACT_VERSION,
            "code": error.code,
            "message": "",
            "retryable": error.retryable,
            "details": error.details,
            "request_id": "",
        })),
    }
}

/// 用户主动删掉一个本地节点（「余额不足停机」留下的墓碑只能这样清，仅 UI）。
///
/// **顺序是有意的**：先让控制面忽略墓碑，全部成功后才动本地（停运行时 → 删镜像行 →
/// 删节点 → 发事件）。反过来先删本地的话，断网时控制面的墓碑还在，下次列表又把它拉
/// 回来，而本地节点已经没了，那一行的删除按钮就永远点不动了。
#[tauri::command]
pub async fn node_forget(state: State<'_, Arc<AppState>>, node_id: String) -> Result<Value, Value> {
    let Some(store) = crate::store::global().cloned() else {
        return Err(json!({
            "contract_version": crate::runtime::EVENT_CONTRACT_VERSION,
            "code": "INTERNAL",
            "message": "",
            "retryable": true,
            "details": { "reason": "store_unavailable" },
            "request_id": "",
        }));
    };

    let state = state.inner().clone();
    forget_owned_node(
        &store,
        &node_id,
        |server_id: String| async move {
            crate::control_plane::servers::dismiss(&server_id).await
        },
        || async {
            if super::server_watch::runtime_is_live(&state).await {
                if let Err(error) = state.services.runtime_stop(false).await {
                    log::warn!("删除节点前停止运行时失败：{error}");
                }
            }
        },
    )
    .await
}

/// `node_forget` 的可测主体：`dismiss` 与 `pause` 由调用方注入，测试不碰网络与运行时。
pub(crate) async fn forget_owned_node<D, DF, P, PF>(
    store: &crate::store::Store,
    node_id: &str,
    dismiss: D,
    pause: P,
) -> Result<Value, Value>
where
    D: Fn(String) -> DF,
    DF: std::future::Future<Output = Result<(), crate::control_plane::error::CpError>>,
    P: Fn() -> PF,
    PF: std::future::Future<Output = ()>,
{
    // 只允许删自己名下（source = 'owned'）的节点：种子 / 手动节点有别的清理路径，
    // 这个命令只服务于「余额不足停机」留下的墓碑。
    // `source_key` 就是控制面服务器 id：镜像行缺失时也靠它找到要 dismiss 的服务器。
    let dismiss_ids = {
        let conn = store.conn();
        let node = match crate::store::configs::get_node(&conn, node_id) {
            Ok(Some(node)) => node,
            Ok(None) => return Ok(json!({ "removed": false })),
            Err(error) => {
                log::warn!("读取本地节点失败：{error}");
                return Err(json!({
                    "contract_version": crate::runtime::EVENT_CONTRACT_VERSION,
                    "code": "INTERNAL",
                    "message": "",
                    "retryable": true,
                    "details": { "reason": "store_error" },
                    "request_id": "",
                }));
            }
        };
        if node.source != crate::store::configs::SOURCE_OWNED {
            return Err(json!({
                "contract_version": crate::runtime::EVENT_CONTRACT_VERSION,
                "code": "PRECONDITION_FAILED",
                "message": "",
                "retryable": false,
                "details": { "reason": "not_owned" },
                "request_id": "",
            }));
        }

        let mut ids: Vec<String> =
            crate::store::servers::destroyed_with_node(&conn, node_id)
                .unwrap_or_default()
                .into_iter()
                .map(|grave| grave.id)
                .collect();
        if !node.source_key.is_empty() && !ids.iter().any(|id| id == &node.source_key) {
            ids.push(node.source_key.clone());
        }
        ids
    };

    // 控制面先落定：任何一台没被忽略都整体失败，本地一行都不动（可重试）。
    for server_id in &dismiss_ids {
        match dismiss(server_id.clone()).await {
            Ok(()) => {}
            Err(error) if error.code == "NOT_FOUND" => {
                log::debug!("控制面已没有这台服务器 server={server_id}");
            }
            Err(error) => {
                log::warn!("让控制面忽略墓碑失败 server={server_id}：{}", error.message);
                return Err(json!({
                    "contract_version": crate::runtime::EVENT_CONTRACT_VERSION,
                    "code": "UPSTREAM_ERROR",
                    "message": "",
                    "retryable": true,
                    "details": { "reason": "dismiss_failed", "server_id": server_id },
                    "request_id": "",
                }));
            }
        }
    }

    // 控制面已经不再返回这条墓碑，才可以断隧道、删本地。
    // 当前节点必须在网络往返**之后**再读：期间用户可能刚连上这个节点。
    let connected = {
        let conn = store.conn();
        crate::store::configs::active(&conn)
            .ok()
            .flatten()
            .and_then(|config| config.current_node_id)
            .as_deref()
            == Some(node_id)
    };
    if connected {
        pause().await;
    }

    // 先删节点、成功后再删镜像行：出错时尽量不留半截。镜像行按 `server_id` 删，
    // 不依赖 `node_id`（删节点会把它置 NULL）。
    let removed = {
        let conn = store.conn();
        let removed = match crate::store::configs::delete_node(&conn, node_id) {
            Ok(removed) => removed,
            Err(error) => {
                // 控制面已经忽略墓碑了，这里不能再吞掉：报告可重试的错误，让用户再点一次
                // （dismiss 幂等，重试会走 NOT_FOUND 分支继续删）。
                log::warn!("删除本地节点失败 node={node_id}：{error}");
                return Err(json!({
                    "contract_version": crate::runtime::EVENT_CONTRACT_VERSION,
                    "code": "INTERNAL",
                    "message": "",
                    "retryable": true,
                    "details": { "reason": "store_error" },
                    "request_id": "",
                }));
            }
        };
        for server_id in &dismiss_ids {
            match crate::store::servers::get(&conn, server_id) {
                Ok(Some(row)) if row.state == "destroyed" => {
                    if let Err(error) = crate::store::servers::delete(&conn, server_id) {
                        log::warn!("删除已销毁服务器缓存行失败：{error}");
                    }
                }
                Ok(_) => {}
                Err(error) => log::warn!("读取已销毁服务器缓存行失败：{error}"),
            }
        }
        removed
    };

    if removed {
        let changed = [node_id.to_string()];
        crate::seed::emit_node_list_changed(store, "node_deleted", None, &changed);
    }
    Ok(json!({ "removed": removed }))
}

/// 手机端导出（仅 UI，契约 §7.21）：幂等取令牌并返回三种格式的 URL 与二维码。
///
/// 返回的每个 `formats[].url` 都含令牌：不记日志、不发事件、不进 AI 上下文（设计 §7.1）。
#[tauri::command]
pub async fn mobile_export_get() -> Result<Value, Value> {
    match crate::control_plane::mobile::get().await {
        Ok(data) => Ok(json!(data)),
        Err(error) => Err(error.envelope()),
    }
}

/// 重新生成手机端导出令牌（仅 UI，契约 §7.22）：`confirm` 缺失或为 false 都拒绝。
#[tauri::command]
pub async fn mobile_export_rotate(confirm: Option<bool>) -> Result<Value, Value> {
    if confirm != Some(true) {
        return Err(crate::control_plane::error::CpError::new(
            "INVALID_ARGUMENT",
            "重新生成需要确认",
            false,
            json!({ "reason": "confirmation_required" }),
        )
        .envelope());
    }
    match crate::control_plane::mobile::rotate().await {
        Ok(data) => Ok(json!(data)),
        Err(error) => Err(error.envelope()),
    }
}

/// 下载指定客户端的二维码（仅 UI，契约 §7.23）：固定链接，不登录、不联网。
///
/// `client` 用 `Option<Value>` 接住缺参与类型错误（与 `proxy_port_set` 同风格）：
/// 两种输入都要走契约里的 `INVALID_ARGUMENT / unknown_client`，不能落到 Tauri 自己的参数错误。
#[tauri::command]
pub async fn mobile_clients_qr(client: Option<Value>) -> Result<Value, Value> {
    let client = client.as_ref().and_then(Value::as_str).unwrap_or_default();
    match crate::control_plane::mobile::clients_qr(client) {
        Ok(data) => Ok(json!(data)),
        Err(error) => Err(error.envelope()),
    }
}

/// 显式重新注册设备（§19.2.4）：丢弃当前身份与令牌，生成新的并静默注册。
/// 旧服务器的本地记录保留为只读；本命令只由界面上的「重新注册设备」触发。
#[tauri::command]
pub async fn my_server_register_device() -> Result<Value, Value> {
    match crate::control_plane::auth::register_device().await {
        Ok(value) => Ok(value),
        Err(error) => Err(error.envelope()),
    }
}

/// 本机是否已有设备身份（只读本地，仅 UI）：不联网、不注册、不刷新令牌。
///
/// 界面打开「我的服务器」时先只拉公开目录；`has_identity` 为真才拉列表，
/// 点「创建服务器」时才做身份初始化。
#[tauri::command]
pub async fn my_server_identity() -> Result<Value, Value> {
    let identity = crate::control_plane::auth::local_identity();
    Ok(json!({
        "has_identity": identity.has_identity,
        "account_id": identity.account_id,
    }))
}

/// 服务层错误已经是结构化的 `ServiceError`；还原成契约里的 AivpnError 形状。
fn error_value(error: anyhow::Error) -> Value {
    if let Some(service) = error.downcast_ref::<crate::tools::services::ServiceError>() {
        if !service.message.is_empty() {
            log::warn!("[service] {}: {}", service.code, service.message);
        }
        // 界面命令不再产出 SECRET_STORE：本机钥匙串失败统一成 INTERNAL / keychain_failed，
        // 工具通道仍保留原码（`tools.md` 写给模型）。
        if service.code == "SECRET_STORE" {
            let mut details = match &service.details {
                Some(Value::Object(map)) => Value::Object(map.clone()),
                _ => json!({}),
            };
            details["reason"] = json!("keychain_failed");
            return json!({
                "contract_version": crate::runtime::EVENT_CONTRACT_VERSION,
                "code": "INTERNAL",
                "message": "",
                "retryable": service.retryable,
                "details": details,
                "request_id": "",
            });
        }
        return json!({
            "contract_version": crate::runtime::EVENT_CONTRACT_VERSION,
            "code": service.code,
            "message": "",
            "retryable": service.retryable,
            "details": service.details,
            "request_id": "",
        });
    }

    let text = error.to_string();
    log::warn!("[command] {text}");
    match text.split_once(": ") {
        Some((code, _))
            if !code.is_empty() && code.chars().all(|c| c.is_ascii_uppercase() || c == '_') =>
        {
            json!({
                "contract_version": crate::runtime::EVENT_CONTRACT_VERSION,
                "code": code,
                "message": "",
                "retryable": false,
                "details": null,
                "request_id": "",
            })
        }
        _ => json!({
            "contract_version": crate::runtime::EVENT_CONTRACT_VERSION,
            "code": "INTERNAL",
            "message": "",
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
        .config_detail(Some(config_id))
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
    // 命令是公开入口：必须在服务层之前拦住空来源，不能只靠 UI 自觉。
    crate::tools::services::require_node_source(source.as_deref(), node_ids.as_deref())
        .map_err(error_value)?;
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
        log::warn!("[config_update] {reason}: {message}");
        json!({
            "contract_version": crate::runtime::EVENT_CONTRACT_VERSION,
            "code": "INVALID_ARGUMENT",
            "message": "",
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

/// 切换当前使用的配置。只改 active，不断开、不重连——连接由 `runtime_start` 负责。
#[tauri::command]
pub async fn config_activate(
    state: State<'_, Arc<AppState>>,
    config_id: String,
) -> Result<Value, Value> {
    state
        .services
        .config_activate(&config_id)
        .await
        .map_err(error_value)
}

/// 在线切换接管方式（`system_proxy` ↔ `tun`）：唯一会因改配置而断开重连的命令。
///
/// UI 直接调用（用户点了开关就是确认）；AI 侧走 `ConfigSetMode` 工具并先弹确认卡。
#[tauri::command]
pub async fn config_set_mode(
    state: State<'_, Arc<AppState>>,
    config_id: String,
    mode: String,
) -> Result<Value, Value> {
    state
        .services
        .config_set_mode(Some(config_id), &mode, true)
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
                json!({ "reason": "job_read_failed" }),
            )
        })??;
    match services.node_import_text(config_id, &text).await {
        Ok(value) => Ok(value),
        Err(error) => Err(error_value(error)),
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
    log::warn!("[node_import_file] {reason}: {message}");
    let mut details = json!({ "reason": reason });
    if let Some(max) = max_bytes {
        details["max_bytes"] = json!(max);
    }
    json!({
        "contract_version": crate::runtime::EVENT_CONTRACT_VERSION,
        "code": "INVALID_ARGUMENT",
        "message": "",
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

/// 仅 UI：把节点绑进全局配置。`source` 与 `nodeIds` 二选一；幂等，不改当前节点。
#[tauri::command]
pub async fn node_attach(
    state: State<'_, Arc<AppState>>,
    source: Option<String>,
    node_ids: Option<Vec<String>>,
    config_id: Option<String>,
) -> Result<Value, Value> {
    state
        .services
        .node_attach(source, node_ids, config_id)
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

/// 测试单个节点连通性。未连接时起临时运行时；测不了返回 `untested`，不退化成 TCP。
#[tauri::command]
pub async fn node_probe(state: State<'_, Arc<AppState>>, node_id: String) -> Result<Value, Value> {
    let value = state
        .services
        .node_probe(&node_id)
        .await
        .map_err(error_value)?;
    // 探不通的自建服务器节点顺手确认一次：可能是服务器已被停机销毁。
    // 探通了就不查，避免多打一次控制面。
    if value.get("status").and_then(Value::as_str) != Some("ok") {
        if let Some(server_id) = super::server_watch::owned_server_of_node(&node_id) {
            check_server_alive_quietly(state.inner(), &server_id).await;
        }
    }
    Ok(value)
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

/// 生效地区（离线；系统推断基线，可被用户明示的地区覆盖）。
/// 全新安装还没有配置时也要能拿到，所以不依赖 `route_get`。
#[tauri::command]
pub async fn system_region(state: State<'_, Arc<AppState>>) -> Result<Value, Value> {
    state.services.system_region().await.map_err(error_value)
}

/// 面板三级折叠里的「打开日志」：用系统文件管理器定位到日志文件。
/// 不接受路径参数，避免变成任意文件打开入口。
#[tauri::command]
pub async fn open_log_dir() -> Result<Value, Value> {
    let logs_dir = crate::runtime::default_app_data_dir().join("logs");
    let Some(target) = latest_log_file(&logs_dir) else {
        return Err(json!({
            "contract_version": crate::runtime::EVENT_CONTRACT_VERSION,
            "code": "PRECONDITION_FAILED",
            "message": "",
            "retryable": false,
            "details": { "reason": "no_logs" },
            "request_id": "",
        }));
    };
    reveal_in_file_manager(&target).map_err(|error| {
        log::warn!("打开日志目录失败：{error}");
        json!({
            "contract_version": crate::runtime::EVENT_CONTRACT_VERSION,
            "code": "INTERNAL",
            "message": "",
            "retryable": false,
            "details": { "reason": "internal" },
            "request_id": "",
        })
    })?;
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
            "message": "",
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
            "message": "",
            "retryable": false,
            "details": { "reason": "active_request" },
            "request_id": "",
        }));
    }

    let Some(store) = crate::store::global() else {
        return Err(json!({
            "contract_version": crate::runtime::EVENT_CONTRACT_VERSION,
            "code": "INTERNAL",
            "message": "",
            "retryable": false,
            "details": { "reason": "store_unavailable" },
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
            "message": "",
            "retryable": false,
            "details": { "reason": "session_gone" },
            "request_id": "",
            }))
        }
        Err(error) => {
            log::warn!("删除会话失败：{error}");
            Err(json!({
            "contract_version": crate::runtime::EVENT_CONTRACT_VERSION,
            "code": error.code(),
            "message": "",
            "retryable": false,
            "details": { "reason": "store_error" },
            "request_id": "",
            }))
        }
    }
}

/* ------------------------------------------------------------------ */
/* 多 provider 模型 API 设置（R32）                                     */
/* ------------------------------------------------------------------ */

fn llm_error((reason, message): (String, String)) -> Value {
    let code = match reason.as_str() {
        "not_found" => "NOT_FOUND",
        "SECRET_STORE" => "INTERNAL",
        "INTERNAL" => "INTERNAL",
        "builtin_provider" | "no_key" => "PRECONDITION_FAILED",
        _ => "INVALID_ARGUMENT",
    };
    let reason = match reason.as_str() {
        "SECRET_STORE" => "keychain_failed".to_string(),
        "INTERNAL" => "internal".to_string(),
        other => other.to_string(),
    };
    log::warn!("[llm] {code}/{reason}: {message}");
    json!({
        "contract_version": crate::runtime::EVENT_CONTRACT_VERSION,
        "code": code,
        "message": "",
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
            "message": "",
            "retryable": false,
            "details": { "reason": "store_unavailable" },
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
            log::warn!("[questions] {code}/{reason}: {message}");
            json!({
                "contract_version": crate::runtime::EVENT_CONTRACT_VERSION,
                "code": code,
                "message": "",
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

/// `open_external` 的白名单：按前缀匹配，前缀必须停在路径段边界。
///
/// 条目本身就是合法前缀：不带尾斜杠的条目（如 `https://github.com/hiddify/hiddify-app`）放行它自己、
/// 子路径以及 `?` / `#`；带尾斜杠的条目（如 `https://sing-box.sagernet.org/`）放行该路径
/// 下的一切。相邻名字不算命中：`…/shadowrocket-other`、`…/hiddify-app-evil` 都拒绝。
///
/// 不写「域名后缀」判断：`https://apps.apple.com.evil.test/` 会命中后缀规则。
/// GitHub 只放开 ClashMetaForAndroid 与 hiddify-app 两个仓库，不放开整个 `github.com`；
/// App Store 只放开列表里出现的两个 App，不放开整站。
const OPEN_EXTERNAL_PREFIXES: [&str; 8] = [
    "https://platform.deepseek.com/",
    "https://apps.apple.com/app/sing-box-mt",
    "https://apps.apple.com/us/app/shadowrocket",
    "https://apps.apple.com/us/app/hiddify-proxy-vpn",
    "https://sing-box.sagernet.org/",
    "https://github.com/SagerNet/sing-box",
    "https://github.com/hiddify/hiddify-app",
    "https://github.com/MetaCubeX/ClashMetaForAndroid/",
];

/// 白名单匹配：先按 URL 规范归一化，再比前缀。
///
/// 归一化会改写地址（`…/ClashMetaForAndroid/../../evil` → `https://github.com/evil`，
/// `%2e` 也算点段）；这类输入一律拒绝，避免前缀匹配被路径穿越绕过。
fn external_url_allowed(raw: &str) -> bool {
    let Ok(parsed) = url::Url::parse(raw) else {
        return false;
    };
    let normalized = parsed.as_str();
    // 只接受无需改写的输入；裸 origin 允许补一个尾部 `/`（如 `https://sing-box.sagernet.org`）。
    if raw != normalized && raw != normalized.trim_end_matches('/') {
        return false;
    }
    OPEN_EXTERNAL_PREFIXES
        .iter()
        .any(|prefix| prefix_matches(normalized, prefix))
}

/// 前缀必须停在路径段边界：`…/shadowrocket` 不能命中 `…/shadowrocket-other`。
fn prefix_matches(normalized: &str, prefix: &str) -> bool {
    let Some(rest) = normalized.strip_prefix(prefix) else {
        return false;
    };
    prefix.ends_with('/')
        || rest.is_empty()
        || rest.starts_with('/')
        || rest.starts_with('?')
        || rest.starts_with('#')
}

/// UI 日志的限速窗口：高 32 位是窗口所在的 Unix 秒，低 32 位是本秒内已放行的条数。
static UI_LOG_WINDOW: AtomicU64 = AtomicU64::new(0);

/// 每秒最多写多少条 UI 日志。超出的直接丢弃：界面卡住时日志会成串涌来，
/// 磁盘和界面线程都不该陪它一起忙。
const UI_LOG_PER_SECOND: u64 = 50;

/// 前端日志：把界面上的关键事件写进文件日志，供真机排障。
///
/// 只写日志：不读写任何状态、不返回数据。`target` 与 `message` 都来自 WebView，
/// 所以 target 不合法就整条丢弃，message 先脱敏、再换掉换行、最后截断到 300 字符。
#[tauri::command]
pub fn ui_log(level: String, target: String, message: String) {
    let Some(target) = ui_log_target(&target) else {
        return;
    };
    if !ui_log_allowed() {
        return;
    }
    let target = format!("ui::{target}");
    log::log!(
        target: target.as_str(),
        ui_log_level(&level),
        "{}",
        ui_log_message(&message)
    );
}

fn ui_log_allowed() -> bool {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs() & 0xFFFF_FFFF)
        .unwrap_or(0);
    let mut window = UI_LOG_WINDOW.load(Ordering::Relaxed);
    loop {
        let (next, allowed) = take_ui_log_budget(window, now);
        match UI_LOG_WINDOW.compare_exchange_weak(
            window,
            next,
            Ordering::Relaxed,
            Ordering::Relaxed,
        ) {
            Ok(_) => return allowed,
            Err(actual) => window = actual,
        }
    }
}

/// 纯函数部分：给定窗口值与当前秒，得出新窗口值和是否放行。
///
/// 跨秒就整个换窗口、计数从 1 起；同一秒超过配额就不再累加，直接丢。
fn take_ui_log_budget(window: u64, now: u64) -> (u64, bool) {
    let (second, used) = (window >> 32, window & 0xFFFF_FFFF);
    if second != now {
        ((now << 32) | 1, true)
    } else if used < UI_LOG_PER_SECOND {
        ((second << 32) | (used + 1), true)
    } else {
        (window, false)
    }
}

/// 只认四个 level；白名单外（含大小写不匹配、`trace`）一律按 debug，不报错。
///
/// `debug` 映射成 `Info`：文件 logger 的级别就是 INFO，比它更细的日志不会写盘，
/// 让 UI 的 debug 停在 `Debug` 等于写了一条永远看不见的日志。白名单外的值仍落
/// `Debug`——前端把级别拼错时宁可不写，也不要借错误输入往文件里刷。
fn ui_log_level(raw: &str) -> log::Level {
    match raw {
        "debug" | "info" => log::Level::Info,
        "warn" => log::Level::Warn,
        "error" => log::Level::Error,
        _ => log::Level::Debug,
    }
}

/// target 只允许 `[A-Za-z0-9_-]` 且 1..=32 字符；不合法返回 None，整条日志丢弃。
fn ui_log_target(raw: &str) -> Option<&str> {
    let valid = !raw.is_empty()
        && raw.chars().count() <= 32
        && raw
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-');
    valid.then_some(raw)
}

/// message 是唯一可能带自由文本的入口：先掩掉密钥形态的片段，再把换行类字符
/// 换成空格，最后按 300 字符截断。
///
/// 脱敏必须在截断前：先截断会把长密钥切成短片段，短片段不再满足「像密钥」的判定。
/// 换行必须在截断前：`\r` / `\n` / `\t` 会让人用一条消息在文件里伪造出多行。
fn ui_log_message(raw: &str) -> String {
    const MAX_CHARS: usize = 300;
    crate::logging::mask_secrets(raw)
        .chars()
        .map(|c| match c {
            '\r' | '\n' | '\t' => ' ',
            other => other,
        })
        .take(MAX_CHARS)
        .collect()
}

/// 用系统浏览器打开白名单内的链接（DeepSeek 开放平台、App Store、sing-box 官网）。
/// 域名写死在这里，避免变成任意 URL 打开器。
#[tauri::command]
pub async fn open_external(app: tauri::AppHandle, url: String) -> Result<Value, Value> {
    use tauri_plugin_opener::OpenerExt;

    if !external_url_allowed(&url) {
        return Err(json!({
            "contract_version": crate::runtime::EVENT_CONTRACT_VERSION,
            "code": "INVALID_ARGUMENT",
            "message": "",
            "retryable": false,
            "details": { "reason": "url_not_allowed" },
            "request_id": "",
        }));
    }

    app.opener().open_url(url, None::<&str>).map_err(|error| {
        log::warn!("打开浏览器失败：{error}");
        json!({
            "contract_version": crate::runtime::EVENT_CONTRACT_VERSION,
            "code": "INTERNAL",
            "message": "",
            "retryable": false,
            "details": { "reason": "open_browser_failed" },
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
        .map_err(|error| {
            log::warn!("卸载后台助手失败：{} {}", error.message, error.detail.unwrap_or_default());
            json!({
                "contract_version": crate::runtime::EVENT_CONTRACT_VERSION,
                "code": error.code,
                "message": "",
                "retryable": false,
                "details": { "reason": "internal" },
                "request_id": "",
            })
        })
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

/// 保存 DeepSeek Key 之后的后处理，顺序只在这里一处。
///
/// 已知无效（401/403）不激活：界面会提示失败，应用不该变成「已配置」。
/// `ok` / `unverified`（网络/超时）都激活内置 DeepSeek，离线用户不能被卡住；
/// 已有可用 active 时 `activate_builtin_if_unconfigured` 不会抢。
fn apply_saved_deepseek_key(store: &crate::store::Store, validation: &str) -> Result<(), Value> {
    if validation == "invalid" {
        log::warn!("DeepSeek Key 鉴权失败：Key 可能无效或已被吊销");
        return Err(json!({
            "contract_version": crate::runtime::EVENT_CONTRACT_VERSION,
            "code": "INVALID_ARGUMENT",
            "message": "",
            "retryable": false,
            "details": { "reason": "provider_key_invalid" },
            "request_id": "",
        }));
    }
    crate::llm::activate_builtin_if_unconfigured(store);
    // 热更新内存凭据：只有当前 active provider 是 DeepSeek 时才换 key。
    crate::agent::refresh_credentials_if_active(crate::llm::PROVIDER_DEEPSEEK);
    Ok(())
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
            if let Some(store) = crate::store::global() {
                apply_saved_deepseek_key(&store, &outcome.validation)?;
            }
            Ok(json!({
                "masked": outcome.masked,
                "verified": outcome.validation == "ok",
            }))
        }
        Err(error) => {
            let code = error.ui_code();
            log::warn!("保存 DeepSeek Key 失败：{code} {}", error.message());
            if code == "INVALID_KEY" {
                Err(json!({
                    "contract_version": crate::runtime::EVENT_CONTRACT_VERSION,
                    "code": "INVALID_ARGUMENT",
                    "message": "",
                    "retryable": false,
                    "details": { "reason": "provider_key_invalid" },
                    "request_id": "",
                }))
            } else {
                Err(json!({
                    "contract_version": crate::runtime::EVENT_CONTRACT_VERSION,
                    "code": "INTERNAL",
                    "message": "",
                    "retryable": false,
                    "details": { "reason": "keychain_failed" },
                    "request_id": "",
                }))
            }
        }
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
        Err(error) => {
            log::warn!("清除 DeepSeek Key 失败：{error}");
            Err(json!({
                "contract_version": crate::runtime::EVENT_CONTRACT_VERSION,
                "code": "INTERNAL",
                "message": "",
                "retryable": false,
                "details": { "reason": "keychain_failed" },
                "request_id": "",
            }))
        }
    }
}

pub const MAX_TITLE_CHARS: usize = 80;

/// 先 trim 再校验：空标题、超长都返回契约里的 INVALID_ARGUMENT + details.reason。
/// 80 是 Unicode 标量数，不是字节数——80 个汉字与 80 个字母同样合法。
fn normalise_title(title: &str) -> Result<&str, Value> {
    let trimmed = title.trim();
    if trimmed.is_empty() {
        return Err(json!({
            "contract_version": crate::runtime::EVENT_CONTRACT_VERSION,
            "code": "INVALID_ARGUMENT",
            "message": "",
            "retryable": false,
            "details": { "reason": "empty_title" },
            "request_id": "",
        }));
    }

    let length = trimmed.chars().count();
    if length > MAX_TITLE_CHARS {
        return Err(json!({
            "contract_version": crate::runtime::EVENT_CONTRACT_VERSION,
            "code": "INVALID_ARGUMENT",
            "message": "",
            "retryable": false,
            "details": {
                "reason": "title_too_long",
                "max": MAX_TITLE_CHARS,
                "actual": length,
            },
            "request_id": "",
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
            "contract_version": crate::runtime::EVENT_CONTRACT_VERSION,
            "code": "INTERNAL",
            "message": "",
            "retryable": false,
            "details": { "reason": "store_unavailable" },
            "request_id": "",
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
            "contract_version": crate::runtime::EVENT_CONTRACT_VERSION,
            "code": "NOT_FOUND",
            "message": "",
            "retryable": false,
            "details": { "reason": "session_gone" },
            "request_id": "",
        })),
        Err(error) => {
            log::warn!("重命名会话失败：{error}");
            Err(json!({
                "contract_version": crate::runtime::EVENT_CONTRACT_VERSION,
                "code": "INTERNAL",
                "message": "",
                "retryable": false,
                "details": { "reason": "store_error" },
                "request_id": "",
            }))
        }
    }
}

#[cfg(test)]
mod error_envelope_tests {
    use super::*;

    /// 界面可见的错误信封必须六个字段齐全、`message` 恒为空（契约 §1.2 / §1.6）。
    fn assert_interface_envelope(error: &Value) {
        for key in [
            "contract_version",
            "code",
            "message",
            "retryable",
            "details",
            "request_id",
        ] {
            assert!(error.get(key).is_some(), "缺少字段 {key}：{error}");
        }
        assert_eq!(error["contract_version"], crate::runtime::EVENT_CONTRACT_VERSION);
        assert_eq!(error["message"], "", "错误不得带界面文案：{error}");
        assert_eq!(error["request_id"], "");
    }

    #[test]
    fn every_interface_error_envelope_has_an_empty_message() {
        let envelopes = [
            command_error("INTERNAL", "本地数据库不可用", json!({ "reason": "store_unavailable" })),
            file_error("invalid_path", "请选择要导入的文件", None),
            file_error("file_too_large", "文件超过 1 MiB", Some(1024)),
            error_value(anyhow::anyhow!("INTERNAL: 内部错误")),
            error_value(anyhow::anyhow!("普通失败")),
            llm_error(("invalid_key".into(), "Key 无效".into())),
            normalise_title("").unwrap_err(),
            normalise_title(&"汉".repeat(MAX_TITLE_CHARS + 1)).unwrap_err(),
        ];
        for error in &envelopes {
            assert_interface_envelope(error);
        }
    }

    /// 错误归类：带显式码的走该码，不带的落到 INTERNAL，文案都只进日志。
    #[test]
    fn error_value_keeps_the_code_and_drops_the_text() {
        let coded = error_value(anyhow::anyhow!("UPSTREAM_ERROR: 上游炸了"));
        assert_eq!(coded["code"], "UPSTREAM_ERROR");
        assert_eq!(coded["message"], "");

        let plain = error_value(anyhow::anyhow!("some io failure 中文"));
        assert_eq!(plain["code"], "INTERNAL");
        assert_eq!(plain["message"], "");
    }

    /// 界面命令不产出 SECRET_STORE：钥匙串失败归一成 INTERNAL / keychain_failed，
    /// 已有的 details 键不能丢。
    #[test]
    fn a_service_secret_store_error_becomes_internal_keychain_failed() {
        use crate::tools::services::ServiceError;

        let bare = error_value(anyhow::Error::new(ServiceError {
            code: "SECRET_STORE".into(),
            message: "钥匙串不可用".into(),
            retryable: false,
            details: None,
        }));
        assert_eq!(bare["code"], "INTERNAL");
        assert_eq!(bare["details"]["reason"], "keychain_failed");
        assert_eq!(bare["message"], "");
        assert_interface_envelope(&bare);

        let with_details = error_value(anyhow::Error::new(ServiceError {
            code: "SECRET_STORE".into(),
            message: "钥匙串不可用".into(),
            retryable: true,
            details: Some(json!({ "config_id": "cfg_1" })),
        }));
        assert_eq!(with_details["code"], "INTERNAL");
        assert_eq!(with_details["details"]["reason"], "keychain_failed");
        assert_eq!(with_details["details"]["config_id"], "cfg_1");
        assert_eq!(with_details["retryable"], true);
        assert_eq!(with_details["message"], "");
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

    /// 界面可见的错误不带文案：路径（可能带用户名）不会经错误出网。
    #[test]
    fn error_messages_are_empty() {
        let missing = temp_path("hidden");
        let error = read_node_file(missing.to_str().unwrap()).unwrap_err();
        assert_eq!(error["message"], "");

        let dir = std::env::temp_dir();
        let error = read_node_file(dir.to_str().unwrap()).unwrap_err();
        assert_eq!(error["message"], "");

        let big = temp_path("hiddenbig");
        std::fs::write(&big, vec![b'a'; (MAX_NODE_FILE_BYTES + 1) as usize]).unwrap();
        let error = read_node_file(big.to_str().unwrap()).unwrap_err();
        assert_eq!(error["message"], "");
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

    /// 有凭据但不会真发请求：只用来穿过 2.52.0 的 AI_NOT_CONFIGURED 闸门，
    /// 让 BUSY 这类占槽之后的状态可观测。
    fn configured_state() -> Arc<AppState> {
        let state = test_state();
        state.apply_credentials(Some("sk-test-key-0001".into()));
        state
    }

    /// 没有任何可用 AI 时直接拒绝：不占槽、不落库、不建会话（契约 §9.1，2.52.0）。
    #[tokio::test]
    async fn no_credentials_is_rejected_without_reserving() {
        install_store();
        let state = test_state();
        let session_id = "ses_ai_not_configured";

        let error = send_message_for_state(&state, session_id, Some("你好"), false, None)
            .await
            .unwrap_err();
        assert_eq!(error["code"], "AI_NOT_CONFIGURED");
        assert_eq!(error["message"], "");
        assert_eq!(error["retryable"], false);
        assert_eq!(error["details"]["reason"], "ai_not_configured");
        assert_eq!(error["request_id"], "");
        assert!(state.existing(session_id).await.is_none(), "不能建会话");
        assert!(
            state
                .reserve_request(&AppState::next_request_id(), session_id)
                .is_ok(),
            "被拒绝的消息不能占槽"
        );
        let store = crate::store::global().expect("全局库已安装");
        let conn = store.conn();
        assert!(crate::store::chat::messages(&conn, session_id)
            .unwrap()
            .is_empty());
    }

    /// 输入错误优先于 AI 状态：无凭据时，空文本仍报 INVALID_ARGUMENT。
    #[tokio::test]
    async fn empty_text_wins_over_missing_credentials() {
        let state = test_state();
        let error = send_message_for_state(&state, "ses_empty_no_ai", Some("   "), false, None)
            .await
            .unwrap_err();
        assert_eq!(error["code"], "INVALID_ARGUMENT");
        assert_eq!(error["details"]["reason"], "empty_text");
    }

    /// 闸门本身：没有可用凭据就拒绝。
    #[test]
    fn require_configured_ai_rejects_without_credentials() {
        let state = test_state();
        let error = require_configured_ai(&state).unwrap_err();
        assert_eq!(error["code"], "AI_NOT_CONFIGURED");
        assert_eq!(error["details"]["reason"], "ai_not_configured");
    }

    /// 闸门本身：本机端点免 Key，算已配置（只注入凭据，不真发请求）。
    #[test]
    fn a_local_endpoint_counts_as_configured() {
        let state = test_state();
        state.apply_provider(Some(crate::claurst_session::provider::LlmCredentials {
            provider_id: "ollama".into(),
            protocol: "openai".into(),
            api_key: String::new(),
            base_url: "http://127.0.0.1:11434".into(),
            model: "test-model".into(),
        }));
        assert!(require_configured_ai(&state).is_ok());
    }

    /// 同一会话第二条请求必须被拒绝，而且**不能落库**。
    #[tokio::test]
    async fn a_second_send_is_rejected_without_persisting() {
        install_store();
        let state = configured_state();
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

        let error = send_message_for_state(&state, session_id, Some("第二条"), false, None)
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

    /// 空文本在占槽与落库之前就被拒绝。
    #[tokio::test]
    async fn empty_text_is_rejected_before_reserving() {
        install_store();
        let state = test_state();
        let session_id = "ses_empty";
        let error = send_message_for_state(&state, session_id, Some("   "), false, None)
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

    /// 点「停止」时还有未答问题：取消必须立刻把工具解开，而不是等 15 分钟超时。
    ///
    /// 工具一返回，循环下一轮就能看到取消令牌，这一轮以 cancelled 收尾、
    /// `ai-request-end` 到达、前端的卡片随之消失。
    #[tokio::test]
    async fn cancelling_a_request_frees_the_question_it_was_waiting_on() {
        let state = test_state();
        let request = AppState::next_request_id();
        let token = state.reserve_request(&request, "ses_stop_q").unwrap();
        let (tx, rx) = tokio::sync::oneshot::channel();
        crate::agent::questions::register(
            "ses_stop_q",
            &request,
            claurst_tools::UserQuestionEvent {
                question: "怎么接管？".into(),
                options: Some(vec!["Tun 模式".into(), "Proxy 模式".into()]),
                reply_tx: tx,
            },
        );
        assert_eq!(
            crate::agent::questions::list_pending("ses_stop_q")["questions"]
                .as_array()
                .unwrap()
                .len(),
            1
        );

        assert!(state.cancel_request(&request));
        assert!(token.is_cancelled());

        assert_eq!(rx.await.unwrap(), "", "工具侧必须立即拿到空串");
        assert!(
            crate::agent::questions::list_pending("ses_stop_q")["questions"]
                .as_array()
                .unwrap()
                .is_empty(),
            "作废后不能再留下可回答的 pending"
        );
        state.finish_request(&request);
        crate::agent::questions::cleanup_request("ses_stop_q", &request);
    }

    fn ui_context_value() -> Value {
        json!({
            "screen": "client",
            "controls": [{ "id": "client.primary", "label": "连接", "kind": "button" }],
            "last_action": { "id": "client.primary" }
        })
    }

    /// context 只包给模型；落库/展示用的仍是用户原话。
    #[test]
    fn context_is_wrapped_for_the_model_but_not_stored() {
        let context = ui_context::parse(&ui_context_value(), &Default::default()).unwrap();
        let (user_text, model_text) =
            prepare_message(Some("  你好  "), false, Some(&context), None).unwrap();
        assert_eq!(user_text, "你好");
        assert!(!user_text.contains("<ui-context>"));
        assert!(model_text.contains("<ui-context>"));
        assert!(model_text.contains("不是用户指令"));
        assert!(model_text.contains("你好"));
    }

    /// `screen = client` 时界面块要带上当前接管方式与流量范围；
    /// 这些事实只进模型文本，落库的仍是用户原话。
    #[test]
    fn the_client_screen_block_carries_the_current_settings() {
        let context = ui_context::parse(&ui_context_value(), &Default::default()).unwrap();
        let status = ui_context::ClientStatus::from_config("tun", "proxy_all");
        let (user_text, model_text) = prepare_message(
            Some("为什么浏览器不走节点"),
            false,
            Some(&context),
            Some(&status),
        )
        .unwrap();
        assert_eq!(user_text, "为什么浏览器不走节点");
        assert!(model_text.contains("当前接管方式：Tun 模式"), "{model_text}");
        assert!(model_text.contains("当前流量范围：全局"), "{model_text}");
        assert!(
            model_text.contains("要改的话，主按钮下面那行点一下。"),
            "{model_text}"
        );
    }

    /// 没有活跃配置（或不是 client 屏）时不补事实：宁可不提，也不能编一个。
    #[test]
    fn the_client_facts_are_only_rendered_when_provided() {
        let context = ui_context::parse(&ui_context_value(), &Default::default()).unwrap();
        let (_, model_text) = prepare_message(Some("你好"), false, Some(&context), None).unwrap();
        assert!(!model_text.contains("当前接管方式"), "{model_text}");

        let servers = ui_context::parse(&json!({ "screen": "servers" }), &Default::default()).unwrap();
        let status = ui_context::ClientStatus::from_config("system_proxy", "proxy_selected");
        let (_, model_text) =
            prepare_message(Some("你好"), false, Some(&servers), Some(&status)).unwrap();
        assert!(!model_text.contains("当前接管方式"), "{model_text}");
    }

    #[test]
    fn hidden_last_action_can_omit_text_and_host_generates_it() {
        let context = ui_context::parse(&ui_context_value(), &Default::default()).unwrap();
        let (user_text, model_text) = prepare_message(None, true, Some(&context), None).unwrap();
        assert_eq!(user_text, "界面事件：在「客户端」点了「连接」。");
        assert!(model_text.contains("<ui-context>"));
        assert_eq!(
            model_text,
            format!(
                "{}\n\n{user_text}",
                ui_context::model_block_with_client(&context, None)
            )
        );
    }

    #[test]
    fn omitting_text_without_hidden_or_action_is_rejected() {
        let context =
            ui_context::parse(&ui_context_value(), &Default::default()).unwrap();
        assert_eq!(
            prepare_message(None, false, Some(&context), None).unwrap_err()["details"]["reason"],
            "empty_text"
        );
        assert_eq!(
            prepare_message(None, true, None, None).unwrap_err()["details"]["reason"],
            "empty_text"
        );
        let no_action =
            ui_context::parse(&json!({ "screen": "client", "controls": [] }), &Default::default())
                .unwrap();
        assert_eq!(
            prepare_message(None, true, Some(&no_action), None).unwrap_err()["details"]["reason"],
            "empty_text"
        );
    }

    #[tokio::test]
    async fn bad_context_is_rejected_before_reserving() {
        install_store();
        let state = test_state();
        let session_id = "ses_context_bad";

        let big = json!({
            "screen": "client",
            "controls": [],
            "padding": "x".repeat(5000)
        });
        let error = send_message_for_state(&state, session_id, Some("你好"), false, Some(&big))
            .await
            .unwrap_err();
        assert_eq!(error["code"], "INVALID_ARGUMENT");
        assert_eq!(error["details"]["reason"], "context_too_large");

        let error = send_message_for_state(
            &state,
            session_id,
            Some("你好"),
            false,
            Some(&json!({ "screen": "nope" })),
        )
        .await
        .unwrap_err();
        assert_eq!(error["details"]["reason"], "invalid_context");

        assert!(
            state
                .reserve_request(&AppState::next_request_id(), session_id)
                .is_ok(),
            "被拒绝的 context 不能占槽"
        );
        let store = crate::store::global().expect("全局库已安装");
        let conn = store.conn();
        assert!(crate::store::chat::messages(&conn, session_id)
            .unwrap()
            .is_empty());
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

#[cfg(test)]
mod checkout_command_tests {
    use super::*;
    use crate::control_plane::servers::MyServerTopup;

    fn topup() -> MyServerTopup {
        MyServerTopup {
            topup_id: "topup_1".into(),
            checkout_url: Some("https://checkout.example/session".into()),
            denomination_cents: 1500,
        }
    }

    #[test]
    fn a_failed_browser_open_returns_an_error_not_a_success() {
        let error = finish_topup(topup(), Err("no browser".into())).unwrap_err();
        assert_eq!(error["code"], "INTERNAL");
        assert_eq!(error["details"]["reason"], "checkout_open_failed");
        assert_eq!(error["retryable"], false);
        assert_eq!(error["details"]["topup_id"], "topup_1");
        assert_eq!(
            error["details"]["checkout_url"],
            "https://checkout.example/session",
            "失败必须把链接带回去，界面才能重开或复制"
        );
        assert_eq!(error["message"], "", "界面可见的错误不带文案");
    }

    #[test]
    fn an_opened_checkout_returns_the_topup() {
        let value = finish_topup(topup(), Ok(())).unwrap();
        assert_eq!(value["topup_id"], "topup_1");
        assert_eq!(value["checkout_url"], "https://checkout.example/session");
    }
}

#[cfg(test)]
mod node_forget_tests {
    use super::forget_owned_node;
    use crate::control_plane::error::CpError;
    use crate::store::configs::{self, NewNode, SOURCE_OWNED};
    use crate::store::servers::{self, NewMyServer};
    use crate::store::Store;
    use serde_json::json;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};

    fn seeded(with_mirror: bool) -> Store {
        let store = Store::open_in_memory().unwrap();
        {
            let conn = store.conn();
            configs::upsert_node(
                &conn,
                &NewNode {
                    id: "nd_local",
                    name: "Tokyo",
                    server: "203.0.113.10",
                    port: 20343,
                    method: "aes-256-gcm",
                    password_ref: "node:nd_local",
                    source: SOURCE_OWNED,
                    source_key: "srv_1",
                },
            )
            .unwrap();
            if with_mirror {
                servers::upsert(
                    &conn,
                    &NewMyServer {
                        id: "srv_1",
                        provider: "digitalocean",
                        name: "Tokyo",
                        region: "sgp1",
                        plan: "basic",
                        state: "destroyed",
                        node_id: Some("nd_local"),
                        hourly_usd: 0.01,
                        monthly_usd: 6.0,
                        daily_price_cents: 20,
                        transfer_gib: 0,
                        paid_until: 0,
                        billing_state: "active",
                        created_at: 1,
                    },
                )
                .unwrap();
            }
        }
        store
    }

    /// dismiss 失败必须整体失败：节点行、镜像行、运行时都原地不动，错误可重试。
    #[tokio::test]
    async fn a_failed_dismiss_leaves_the_node_and_the_mirror_row_in_place() {
        let store = seeded(true);
        let pauses = Arc::new(AtomicUsize::new(0));
        let pauses_in = Arc::clone(&pauses);

        let error = forget_owned_node(
            &store,
            "nd_local",
            |server_id: String| async move {
                Err(CpError::new(
                    "UPSTREAM_ERROR",
                    format!("dismiss {server_id} 失败"),
                    true,
                    json!({ "reason": "provider_unavailable" }),
                ))
            },
            move || {
                let pauses = Arc::clone(&pauses_in);
                async move {
                    pauses.fetch_add(1, Ordering::SeqCst);
                }
            },
        )
        .await
        .unwrap_err();

        assert_eq!(error["code"], "UPSTREAM_ERROR");
        assert_eq!(error["details"]["reason"], "dismiss_failed");
        assert_eq!(error["details"]["server_id"], "srv_1");
        assert_eq!(error["retryable"], true);
        assert_eq!(pauses.load(Ordering::SeqCst), 0, "失败时不能先断开隧道");

        let conn = store.conn();
        assert!(
            configs::get_node(&conn, "nd_local").unwrap().is_some(),
            "dismiss 失败时节点行必须还在"
        );
        assert!(
            servers::get(&conn, "srv_1").unwrap().is_some(),
            "dismiss 失败时镜像行必须还在"
        );
    }

    /// 控制面回 NOT_FOUND 表示已经没有这条墓碑，按成功处理，本地照常删干净。
    #[tokio::test]
    async fn a_not_found_dismiss_still_removes_the_node_and_the_mirror_row() {
        let store = seeded(true);
        let seen = Arc::new(Mutex::new(Vec::new()));
        let seen_in = Arc::clone(&seen);

        let value = forget_owned_node(
            &store,
            "nd_local",
            move |server_id: String| {
                let seen = Arc::clone(&seen_in);
                async move {
                    seen.lock().unwrap().push(server_id);
                    Err(CpError::new("NOT_FOUND", "not found", false, json!({})))
                }
            },
            || async {},
        )
        .await
        .unwrap();

        assert_eq!(value["removed"], true);
        assert_eq!(
            *seen.lock().unwrap(),
            vec!["srv_1".to_string()],
            "镜像行与 source_key 是同一台，只能 dismiss 一次"
        );

        let conn = store.conn();
        assert!(configs::get_node(&conn, "nd_local").unwrap().is_none());
        assert!(servers::get(&conn, "srv_1").unwrap().is_none());
    }

    /// 镜像行缺失时靠 `node.source_key` 找到要 dismiss 的服务器。
    #[tokio::test]
    async fn a_missing_mirror_row_falls_back_to_the_node_source_key() {
        let store = seeded(false);
        let seen = Arc::new(Mutex::new(Vec::new()));
        let seen_in = Arc::clone(&seen);

        let value = forget_owned_node(
            &store,
            "nd_local",
            move |server_id: String| {
                let seen = Arc::clone(&seen_in);
                async move {
                    seen.lock().unwrap().push(server_id);
                    Ok(())
                }
            },
            || async {},
        )
        .await
        .unwrap();

        assert_eq!(value["removed"], true);
        assert_eq!(*seen.lock().unwrap(), vec!["srv_1".to_string()]);
        let conn = store.conn();
        assert!(configs::get_node(&conn, "nd_local").unwrap().is_none());
    }

    /// 建好活动配置并把节点挂进去，但 `current_node_id` 先留空——
    /// 「连接发生在网络往返期间」由测试里的 dismiss 闭包制造。
    fn make_active_config(store: &Store) {
        let conn = store.conn();
        let dns = json!({ "mode": "auto", "local": [], "remote": [] });
        let excludes = json!([]);
        configs::create(
            &conn,
            &crate::store::NewConfig {
                id: "cfg_1",
                name: "A",
                connection_mode: configs::CONNECTION_SYSTEM_PROXY,
                routing_mode: configs::ROUTING_PROXY_ALL,
                listen_port: Some(7890),
                dns: &dns,
                tun_excludes: &excludes,
            },
        )
        .unwrap();
        configs::activate(&conn, "cfg_1").unwrap();
        configs::attach_node(&conn, "cfg_1", "nd_local").unwrap();
    }

    /// 控制面已通过、删本地节点却失败时必须报可重试错误，不能假报 `removed: false`
    /// 让界面乐观收起——否则墓碑已 dismiss，行和节点会各留一半。
    #[tokio::test]
    async fn a_failed_local_delete_reports_a_retryable_error_and_keeps_the_node() {
        let store = seeded(true);
        {
            let conn = store.conn();
            conn.execute_batch(
                "CREATE TRIGGER node_forget_block BEFORE DELETE ON nodes
                 BEGIN SELECT RAISE(ABORT, 'boom'); END;",
            )
            .unwrap();
        }

        let error = forget_owned_node(
            &store,
            "nd_local",
            |_server_id: String| async { Ok(()) },
            || async {},
        )
        .await
        .unwrap_err();

        assert_eq!(error["code"], "INTERNAL");
        assert_eq!(error["details"]["reason"], "store_error");
        assert_eq!(error["retryable"], true);

        let conn = store.conn();
        assert!(
            configs::get_node(&conn, "nd_local").unwrap().is_some(),
            "删除失败时节点行必须还在"
        );
        assert!(
            servers::get(&conn, "srv_1").unwrap().is_some(),
            "先删节点、后删镜像行：节点失败时镜像行不动"
        );
    }

    /// 当前节点是在 dismiss 往返**期间**才连上的，也必须先停隧道再删。
    /// 起点 `current_node_id` 为空：把「重读」挪回 dismiss 之前，这条测试就会失败。
    #[tokio::test]
    async fn a_node_connected_during_the_dismiss_still_stops_the_runtime() {
        let store = seeded(true);
        make_active_config(&store);
        let store_ref = &store;
        let pauses = Arc::new(AtomicUsize::new(0));

        let pauses_in = Arc::clone(&pauses);
        let value = forget_owned_node(
            &store,
            "nd_local",
            |_server_id: String| async move {
                // 用户就在这次网络往返里连上了这个节点。
                let conn = store_ref.conn();
                configs::update(
                    &conn,
                    "cfg_1",
                    &configs::ConfigPatch {
                        current_node_id: Some(Some("nd_local".into())),
                        ..Default::default()
                    },
                )
                .unwrap();
                Ok(())
            },
            move || {
                let pauses = Arc::clone(&pauses_in);
                async move {
                    let still_there = {
                        let conn = store_ref.conn();
                        configs::get_node(&conn, "nd_local").unwrap().is_some()
                    };
                    assert!(still_there, "pause 必须早于删节点");
                    pauses.fetch_add(1, Ordering::SeqCst);
                }
            },
        )
        .await
        .unwrap();

        assert_eq!(value["removed"], true);
        assert_eq!(pauses.load(Ordering::SeqCst), 1, "当前节点必须停一次隧道");
        let conn = store.conn();
        assert!(configs::get_node(&conn, "nd_local").unwrap().is_none());
        assert_eq!(
            configs::active(&conn).unwrap().unwrap().current_node_id,
            None,
            "删节点后 current_node_id 由外键置 NULL"
        );
    }
}

#[cfg(test)]
mod destroy_flow_tests {
    use super::destroy_server_with;
    use crate::control_plane::error::CpError;
    use crate::control_plane::servers::MyServer;
    use serde_json::json;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Mutex};

    fn server() -> MyServer {
        serde_json::from_value(json!({
            "server_id": "srv_1",
            "name": "东京",
            "region": "sgp1",
            "plan": "s-1vcpu-1gb",
            "state": "destroying",
            "created_at": "2026-11-19T08:00:00Z",
            "hourly_usd": 0.0,
            "monthly_usd": 6.0,
            "daily_price_cents": 20,
            "transfer_gib": 0,
            "billing_state": "active",
        }))
        .unwrap()
    }

    fn events() -> Arc<Mutex<Vec<&'static str>>> {
        Arc::new(Mutex::new(Vec::new()))
    }

    fn recorder(
        log: &Arc<Mutex<Vec<&'static str>>>,
        label: &'static str,
    ) -> impl Fn() -> std::pin::Pin<Box<dyn std::future::Future<Output = bool> + Send>> {
        let log = Arc::clone(log);
        move || {
            let log = Arc::clone(&log);
            Box::pin(async move {
                log.lock().unwrap().push(label);
                true
            })
        }
    }

    /// 模拟「停运行时失败」（运行期操作锁超时等），仍然记一次尝试。
    fn failing_stop(
        log: &Arc<Mutex<Vec<&'static str>>>,
        label: &'static str,
    ) -> impl Fn() -> std::pin::Pin<Box<dyn std::future::Future<Output = bool> + Send>> {
        let log = Arc::clone(log);
        move || {
            let log = Arc::clone(&log);
            Box::pin(async move {
                log.lock().unwrap().push(label);
                false
            })
        }
    }

    /// 目标不是当前节点：销毁前不停，失败（明确 4xx）也不停。
    #[tokio::test]
    async fn a_server_that_is_not_current_never_stops_the_tunnel() {
        let log = events();
        let log_destroy = Arc::clone(&log);
        let result = destroy_server_with(
            "srv_1",
            || false,
            recorder(&log, "stop"),
            move || {
                let log = Arc::clone(&log_destroy);
                async move {
                    log.lock().unwrap().push("destroy");
                    Err(CpError::new(
                        "PRECONDITION_FAILED",
                        "当前状态不允许这个操作",
                        false,
                        json!({ "reason": "server_busy" }),
                    ))
                }
            },
        )
        .await;
        assert_eq!(result.unwrap_err().code, "PRECONDITION_FAILED");
        assert_eq!(*log.lock().unwrap(), vec!["destroy"]);
    }

    /// 目标是当前节点：先停运行时，再发销毁请求。
    #[tokio::test]
    async fn a_current_node_stops_before_the_destroy_request() {
        let log = events();
        let log_destroy = Arc::clone(&log);
        let result = destroy_server_with(
            "srv_1",
            || true,
            recorder(&log, "stop"),
            move || {
                let log = Arc::clone(&log_destroy);
                async move {
                    log.lock().unwrap().push("destroy");
                    Ok(server())
                }
            },
        )
        .await;
        assert!(result.is_ok());
        assert_eq!(*log.lock().unwrap(), vec!["stop", "destroy"]);
    }

    /// 销毁超时且此刻仍是当前节点：结果不确定，再停一次。
    #[tokio::test]
    async fn an_uncertain_destroy_stops_the_tunnel() {
        let log = events();
        let current = Arc::new(AtomicBool::new(false));
        let current_in_destroy = Arc::clone(&current);
        let current_in_check = Arc::clone(&current);
        let log_destroy = Arc::clone(&log);
        let result = destroy_server_with(
            "srv_1",
            move || current_in_check.load(Ordering::SeqCst),
            recorder(&log, "stop"),
            move || {
                let log = Arc::clone(&log_destroy);
                let current = Arc::clone(&current_in_destroy);
                async move {
                    log.lock().unwrap().push("destroy");
                    // 请求期间用户正好连上了这台（或它一直是当前节点）。
                    current.store(true, Ordering::SeqCst);
                    Err(CpError::new("TIMEOUT", "连接服务器服务超时", true, json!({})))
                }
            },
        )
        .await;
        assert_eq!(result.unwrap_err().code, "TIMEOUT");
        assert_eq!(*log.lock().unwrap(), vec!["destroy", "stop"]);
    }

    /// 已经先停过：超时不再重复停。
    #[tokio::test]
    async fn an_already_stopped_tunnel_is_not_stopped_twice() {
        let log = events();
        let log_destroy = Arc::clone(&log);
        let result = destroy_server_with(
            "srv_1",
            || true,
            recorder(&log, "stop"),
            move || {
                let log = Arc::clone(&log_destroy);
                async move {
                    log.lock().unwrap().push("destroy");
                    Err(CpError::new("TIMEOUT", "连接服务器服务超时", true, json!({})))
                }
            },
        )
        .await;
        assert_eq!(result.unwrap_err().code, "TIMEOUT");
        assert_eq!(*log.lock().unwrap(), vec!["stop", "destroy"]);
    }

    /// 先停没成功（运行期操作锁超时等）但销毁成功：补停一次，别留下
    /// 「节点已删、隧道还活着」的原症状。
    #[tokio::test]
    async fn a_failed_pre_stop_is_retried_after_a_successful_destroy() {
        let log = events();
        let log_destroy = Arc::clone(&log);
        let result = destroy_server_with(
            "srv_1",
            || true,
            failing_stop(&log, "stop"),
            move || {
                let log = Arc::clone(&log_destroy);
                async move {
                    log.lock().unwrap().push("destroy");
                    Ok(server())
                }
            },
        )
        .await;
        assert!(result.is_ok());
        assert_eq!(*log.lock().unwrap(), vec!["stop", "destroy", "stop"]);
    }

    /// 明确的 4xx（结果确定）即使请求期间用户连上了这台，也不额外停。
    #[tokio::test]
    async fn a_definite_error_after_connecting_mid_flight_does_not_stop() {
        let log = events();
        let current = Arc::new(AtomicBool::new(false));
        let current_in_destroy = Arc::clone(&current);
        let current_in_check = Arc::clone(&current);
        let log_destroy = Arc::clone(&log);
        let result = destroy_server_with(
            "srv_1",
            move || current_in_check.load(Ordering::SeqCst),
            recorder(&log, "stop"),
            move || {
                let log = Arc::clone(&log_destroy);
                let current = Arc::clone(&current_in_destroy);
                async move {
                    log.lock().unwrap().push("destroy");
                    current.store(true, Ordering::SeqCst);
                    Err(CpError::new(
                        "PRECONDITION_FAILED",
                        "当前状态不允许这个操作",
                        false,
                        json!({ "reason": "server_busy" }),
                    ))
                }
            },
        )
        .await;
        assert_eq!(result.unwrap_err().code, "PRECONDITION_FAILED");
        assert_eq!(*log.lock().unwrap(), vec!["destroy"]);
    }
}

#[cfg(test)]
mod open_external_tests {
    use super::external_url_allowed;

    #[test]
    fn the_allowlisted_prefixes_are_opened() {
        for url in [
            "https://platform.deepseek.com/usage",
            "https://apps.apple.com/app/sing-box-mt/id6785326793",
            "https://apps.apple.com/us/app/shadowrocket/id932747118",
            "https://apps.apple.com/us/app/shadowrocket/id932747118/",
            "https://sing-box.sagernet.org/clients/",
            "https://github.com/hiddify/hiddify-app",
            "https://github.com/hiddify/hiddify-app/",
            "https://github.com/hiddify/hiddify-app/releases",
            "https://github.com/MetaCubeX/ClashMetaForAndroid/releases",
        ] {
            assert!(external_url_allowed(url), "{url}");
        }
    }

    #[test]
    fn lookalike_hosts_and_other_schemes_are_rejected() {
        for url in [
            "https://apps.apple.com.evil.test/app",
            "https://platform.deepseek.com.evil.test/",
            "https://hiddify.com.evil.test/",
            "https://evil.test/https://apps.apple.com/",
            "http://apps.apple.com/app",
            // 旧域名与仿冒路径都不再放行。
            "https://hiddify.com",
            "https://hiddify.com/",
            "http://github.com/hiddify/hiddify-app",
            "https://github.com/evil/hiddify-app",
            "https://github.com/hiddify",
            "https://github.com/hiddify/other-app",
            "https://github.com/hiddify/hiddify-app-evil",
            "https://github.com/hiddify/hiddify-app@evil.test/",
            "https://github.com/hiddify/hiddify-app.evil.test/",
            "https://github.com/other/repo",
            "https://github.com/MetaCubeX/sing-box/releases",
            // App Store 只放行两个 App，其它页面与相邻名字都不行。
            "https://apps.apple.com/",
            "https://apps.apple.com/cn/iphone/today",
            "https://apps.apple.com/us/app/stash-rule-based-proxy/id1596063349",
            "https://apps.apple.com/us/app/shadowrocket-extra/id1",
            // 点段 / 百分号编码的 `..` / 多重斜杠都不能靠前缀匹配绕过。
            "https://github.com/MetaCubeX/ClashMetaForAndroid/../../evil",
            "https://github.com/MetaCubeX/ClashMetaForAndroid/%2e%2e/%2e%2e/evil",
            "https://github.com/MetaCubeX/ClashMetaForAndroid/%2E%2E/evil",
            "https://github.com/MetaCubeX/ClashMetaForAndroid/./releases",
            "https://github.com/MetaCubeX/ClashMetaForAndroid//../../evil",
            "https://workers.dev/",
            "",
        ] {
            assert!(!external_url_allowed(url), "{url}");
        }
    }

    /// 「打开下载页」把固定映射的 URL 直接交给 `open_external`：两处必须同源，
    /// 否则换域名只改一处，用户点了没反应。
    #[test]
    fn every_download_url_is_openable() {
        for (client, platform, url) in crate::control_plane::mobile::CLIENT_PLATFORM_URLS {
            assert!(
                external_url_allowed(url),
                "{client}/{platform:?} 的下载页 {url} 必须能打开"
            );
            assert!(
                external_url_allowed(&format!("{url}/")),
                "{client}/{platform:?} 的尾斜杠写法也必须能打开"
            );
        }
    }
}

#[cfg(test)]
mod ui_log_tests {
    use super::{
        take_ui_log_budget, ui_log, ui_log_level, ui_log_message, ui_log_target, UI_LOG_PER_SECOND,
    };
    use log::Level;

    #[test]
    fn the_four_levels_are_accepted_and_anything_else_is_debug() {
        assert_eq!(
            ui_log_level("debug"),
            Level::Info,
            "UI 的 debug 视为文件可见级，否则真机上永远看不到"
        );
        assert_eq!(ui_log_level("info"), Level::Info);
        assert_eq!(ui_log_level("warn"), Level::Warn);
        assert_eq!(ui_log_level("error"), Level::Error);
        assert_eq!(ui_log_level("trace"), Level::Debug, "白名单外的级别按 debug 处理");
        assert_eq!(ui_log_level("INFO"), Level::Debug, "大小写不匹配也按 debug");
        assert_eq!(ui_log_level(""), Level::Debug);
    }

    #[test]
    fn ui_debug_lands_in_the_default_file_level() {
        // 文件 logger 的默认级别是 INFO；映射错了这条日志在真机上就是隐形的。
        assert!(
            crate::logging::file_accepts(ui_log_level("debug")),
            "默认文件级别收不到 UI 的 debug"
        );
        assert!(crate::logging::file_accepts(ui_log_level("info")));
        assert!(crate::logging::file_accepts(ui_log_level("warn")));
        assert!(crate::logging::file_accepts(ui_log_level("error")));
        assert!(
            !crate::logging::file_accepts(ui_log_level("trace")),
            "白名单外的值不应落盘"
        );
    }

    #[test]
    fn only_short_identifier_targets_survive() {
        assert_eq!(ui_log_target("wallet"), Some("wallet"));
        assert_eq!(ui_log_target("wallet-refresh_1"), Some("wallet-refresh_1"));

        let max = "a".repeat(32);
        assert_eq!(ui_log_target(&max), Some(max.as_str()));

        let too_long = "a".repeat(33);
        for bad in ["", "wallet refresh", "ui::wallet", "钱包", too_long.as_str()] {
            assert!(ui_log_target(bad).is_none(), "{bad:?} 不该通过");
        }
    }

    #[test]
    fn long_messages_are_cut_at_300_characters() {
        assert_eq!(ui_log_message(&"x".repeat(400)).chars().count(), 300);
        assert_eq!(
            ui_log_message(&"字".repeat(400)).chars().count(),
            300,
            "按字符截断，不是按字节"
        );
        assert_eq!(ui_log_message("短消息"), "短消息");
    }

    #[test]
    fn secret_shaped_fragments_are_masked() {
        let out = ui_log_message(
            "key sk-abcdefghijklmnopqrst token AbCdEf0123456789AbCdEf0123456789 done",
        );
        assert!(!out.contains("sk-abcdefghijklmnopqrst"), "{out}");
        assert!(!out.contains("AbCdEf0123456789AbCdEf0123456789"), "{out}");
        assert!(out.contains("***"), "{out}");
        assert!(out.contains("done"), "普通文本必须留下：{out}");
    }

    #[test]
    fn newlines_cannot_forge_extra_log_lines() {
        let out = ui_log_message("第一行\n第二行\r\n缩进\t结束");
        assert_eq!(out, "第一行 第二行  缩进 结束");
        assert!(!out.contains(['\r', '\n', '\t']), "{out:?}");
    }

    #[test]
    fn each_second_allows_at_most_fifty_lines() {
        let mut window = 0;
        for _ in 0..UI_LOG_PER_SECOND {
            let (next, allowed) = take_ui_log_budget(window, 1_000);
            assert!(allowed, "配额内的日志必须放行");
            window = next;
        }
        let (after, allowed) = take_ui_log_budget(window, 1_000);
        assert!(!allowed, "第 {} 条要丢弃", UI_LOG_PER_SECOND + 1);
        assert_eq!(after, window, "丢弃不计数、不排队");

        let (next_second, allowed) = take_ui_log_budget(after, 1_001);
        assert!(allowed, "下一秒重新开始");
        assert_eq!(next_second, (1_001 << 32) | 1);
    }

    #[test]
    fn the_command_never_panics() {
        ui_log("info".into(), "wallet".into(), "刷新余额：手动".into());
        ui_log("nonsense".into(), "bad target".into(), "应被丢弃".into());
        ui_log("".into(), "wallet".into(), "".into());
    }
}

#[cfg(test)]
mod deepseek_save_key_tests {
    use super::*;

    fn store() -> crate::store::Store {
        crate::test_support::install_test_secrets();
        crate::store::Store::open_in_memory().unwrap()
    }

    /// 已知无效的 Key 不激活：界面收到 INVALID_ARGUMENT / provider_key_invalid，应用仍是「未配置」。
    #[test]
    fn an_invalid_key_does_not_activate_the_builtin() {
        let store = store();
        // 同下：内置记录在、active 为空，激活与否才可观测。
        crate::llm::ensure_migrated(&store);
        crate::llm::set_active_id(&store, None).unwrap();

        let error = apply_saved_deepseek_key(&store, "invalid").unwrap_err();
        assert_eq!(error["code"], "INVALID_ARGUMENT");
        assert_eq!(error["details"]["reason"], "provider_key_invalid");
        assert_eq!(error["message"], "");
        assert_eq!(crate::llm::active_id(&store), None);
    }

    /// 无法验证（离线/超时）也算保存成功，并激活内置 DeepSeek。
    #[test]
    fn an_unverified_key_activates_the_builtin() {
        let store = store();
        // 内置记录先落库再清空 active，模拟「active 为空、内置 DeepSeek 还在」。
        crate::llm::ensure_migrated(&store);
        crate::llm::set_active_id(&store, None).unwrap();

        apply_saved_deepseek_key(&store, "unverified").unwrap();
        assert_eq!(
            crate::llm::active_id(&store).as_deref(),
            Some(crate::llm::PROVIDER_DEEPSEEK)
        );
    }

    /// 已有可用的自定义 active 时，保存 DeepSeek Key 不抢 active。
    #[test]
    fn a_valid_key_keeps_a_usable_active_provider() {
        let store = store();
        let saved = crate::llm::save(
            &store,
            crate::llm::ProviderInput {
                provider_id: None,
                name: "自定义".into(),
                protocol: "anthropic".into(),
                base_url: Some("https://api.anthropic.com".into()),
                model: "test-model".into(),
                api_key: Some("sk-custom".into()),
            },
        )
        .unwrap();
        let id = saved["provider_id"].as_str().unwrap().to_string();
        assert_eq!(crate::llm::active_id(&store).as_deref(), Some(id.as_str()));

        apply_saved_deepseek_key(&store, "ok").unwrap();
        assert_eq!(crate::llm::active_id(&store).as_deref(), Some(id.as_str()));
    }
}

#[cfg(test)]
mod server_sync_settings_tests {
    use super::*;

    fn install_store() {
        if crate::store::global().is_none() {
            let store = Arc::new(crate::store::Store::open_in_memory().expect("内存库"));
            crate::store::install_global(store);
        }
    }

    /// 缺失/非法都读 240；只认六个合法值，写入后可再读出。
    #[tokio::test]
    async fn interval_defaults_validates_and_persists() {
        install_store();
        let store = crate::store::global().expect("全局库已安装");

        {
            let conn = store.conn();
            let _ = crate::store::settings::delete(&conn, SERVER_SYNC_INTERVAL_KEY);
        }
        assert_eq!(
            server_sync_interval_get().await.unwrap()["minutes"],
            json!(240),
            "缺失按 240"
        );

        {
            let conn = store.conn();
            crate::store::settings::set(&conn, SERVER_SYNC_INTERVAL_KEY, "7").unwrap();
        }
        assert_eq!(
            server_sync_interval_get().await.unwrap()["minutes"],
            json!(240),
            "存库非法值按 240"
        );

        for invalid in [json!(7), json!(5), json!(15)] {
            let error = server_sync_interval_set(invalid.clone()).await.unwrap_err();
            assert_eq!(error["code"], "INVALID_ARGUMENT");
            assert_eq!(error["details"]["reason"], "invalid_interval");
            assert_eq!(
                server_sync_interval_get().await.unwrap()["minutes"],
                json!(240),
                "非法入参不能改库：{invalid}"
            );
        }

        for legal in [0u16, 30, 60, 240, 480, 1440] {
            assert_eq!(
                server_sync_interval_set(json!(legal)).await.unwrap()["minutes"],
                json!(legal)
            );
            assert_eq!(
                server_sync_interval_get().await.unwrap()["minutes"],
                json!(legal)
            );
        }
    }
}
