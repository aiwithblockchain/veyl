//! 我的服务器：8 个控制面端点 + 本地镜像缓存。
//!
//! 控制面是唯一事实源；本地 `my_servers` 只用于离线展示与节点关联。
//! 命令层只负责参数搬运，所有业务在这里。

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::client::ControlPlane;
use super::error::CpError;

pub const SERVER_STATES: [&str; 10] = [
    "creating",
    "booting",
    "installing",
    "verifying",
    "healthy",
    "active",
    "error",
    "destroying",
    "destroyed",
    "gone",
];

pub const ORDER_STATES: [&str; 6] = [
    "pending_payment",
    "paid",
    "provisioning",
    "ready",
    "cancelled",
    "failed",
];

/// 计费状态（控制面 Cron 每日推进）。
pub const BILLING_STATES: [&str; 3] = ["active", "past_due", "expired"];

/// 宽限期：`grace_ends_at` 的派生口径（§4.6），控制面不给时由 Host 计算。
const GRACE_DAYS: i64 = 7;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MyServerFailure {
    pub stage: String,
    pub code: String,
    pub message: String,
    pub retryable: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MyServer {
    pub server_id: String,
    pub name: String,
    pub region: String,
    pub plan: String,
    pub state: String,
    pub created_at: String,
    #[serde(default)]
    pub ip: Option<String>,
    #[serde(default)]
    pub port: Option<u16>,
    #[serde(default)]
    pub node_id: Option<String>,
    pub hourly_usd: f64,
    pub monthly_usd: f64,
    /// 售价快照（USD 分 / 天），即每天实际扣多少。
    pub daily_price_cents: i64,
    /// 每月公网出口额度快照（GiB）；0 = 未知，不参与任何扣费。
    pub transfer_gib: i64,
    /// 已付到哪个时刻（ISO 8601）；建行时即写入，永不为 null。
    pub paid_until: String,
    pub billing_state: String,
    /// 派生值：`paid_until + 7d`，不落库；仅 past_due / expired 非空。
    #[serde(default)]
    pub grace_ends_at: Option<String>,
    #[serde(default)]
    pub failure: Option<MyServerFailure>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MyServerOrderFailure {
    pub code: String,
    // 展示用文案：缺了它不该让整条订单解析失败。
    #[serde(default)]
    pub message: String,
    pub retryable: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MyServerOrder {
    pub order_id: String,
    pub state: String,
    pub region: String,
    pub plan: String,
    pub amount_usd: f64,
    pub created_at: String,
    #[serde(default)]
    pub expires_at: Option<String>,
    #[serde(default)]
    pub server_id: Option<String>,
    #[serde(default)]
    pub failure: Option<MyServerOrderFailure>,
}

/// `my_server_checkout` 的返回：收银台会话（2.27.0）。
/// `my_server_checkout` 的返回：从余额扣一个月（2.28.0）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MyServerCharge {
    #[serde(default)]
    pub order_id: String,
    pub state: String,
    /// 实际扣费（美分）。已付过的订单重复调用为 0。
    pub charged_cents: i64,
    pub balance_after_cents: i64,
}

const CHARGE_STATES: [&str; 3] = ["paid", "provisioning", "ready"];

/// `my_server_wallet` 的返回：余额（USD 分）与可选充值面额（整数分，升序）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MyServerWallet {
    pub balance_cents: i64,
    #[serde(default = "default_currency")]
    pub currency: String,
    /// 充值档位，直接来自控制面，Host 不排序、不换算。
    #[serde(default)]
    pub denominations_cents: Vec<i64>,
    /// 控制面不给时间，由 Host 补本地时间。
    #[serde(default)]
    pub updated_at: String,
}

fn default_currency() -> String {
    "USD".into()
}

/// `my_server_topup` 的返回：充值收银台会话；非生产 fake 通道没有 URL。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MyServerTopup {
    pub topup_id: String,
    #[serde(default)]
    pub checkout_url: Option<String>,
    pub denomination_cents: i64,
}

#[derive(Debug, Default, Deserialize)]
struct RawOrder {
    #[serde(default)]
    order_id: Option<String>,
    #[serde(default)]
    state: Option<String>,
    #[serde(default)]
    region: Option<String>,
    #[serde(default)]
    plan: Option<String>,
    #[serde(default)]
    amount_usd: Option<f64>,
    #[serde(default)]
    created_at: Option<String>,
    #[serde(default)]
    expires_at: Option<String>,
    #[serde(default)]
    server_id: Option<String>,
    #[serde(default)]
    failure: Option<MyServerOrderFailure>,
}

static ORDERS: parking_lot::Mutex<Vec<MyServerOrder>> = parking_lot::Mutex::new(Vec::new());
const REMEMBERED_ORDERS: usize = 20;

pub fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

/// UUIDv4：每个用户动作一个，重试复用同一个键（§19.5）。
pub fn new_idempotency_key() -> String {
    let mut bytes: [u8; 16] = rand::random();
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    format!(
        "{:02x}{:02x}{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
        bytes[0],
        bytes[1],
        bytes[2],
        bytes[3],
        bytes[4],
        bytes[5],
        bytes[6],
        bytes[7],
        bytes[8],
        bytes[9],
        bytes[10],
        bytes[11],
        bytes[12],
        bytes[13],
        bytes[14],
        bytes[15]
    )
}

fn parse_iso_ms(value: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|time| time.timestamp_millis())
}

fn validate_state(state: &str, allowed: &[&str], what: &str) -> Result<(), CpError> {
    if allowed.contains(&state) {
        Ok(())
    } else {
        Err(CpError::invalid_response(format!(
            "{what}状态不合法：{state}"
        )))
    }
}

fn validate_server(server: &mut MyServer) -> Result<(), CpError> {
    if server.server_id.trim().is_empty() {
        return Err(CpError::invalid_response("服务器缺少 server_id"));
    }
    validate_state(&server.state, &SERVER_STATES, "服务器")?;
    if parse_iso_ms(&server.created_at).is_none() {
        return Err(CpError::invalid_response("服务器 created_at 不是 ISO 8601"));
    }
    if !server.hourly_usd.is_finite() || !server.monthly_usd.is_finite() {
        return Err(CpError::invalid_response("服务器价格不是有限数值"));
    }
    if server.hourly_usd < 0.0 || server.monthly_usd < 0.0 {
        return Err(CpError::invalid_response("服务器价格不能为负"));
    }
    if server.daily_price_cents < 0 {
        return Err(CpError::invalid_response("服务器日价不能为负"));
    }
    if server.transfer_gib < 0 {
        return Err(CpError::invalid_response("服务器流量额度不能为负"));
    }
    let paid_until = parse_iso_ms(&server.paid_until)
        .ok_or_else(|| CpError::invalid_response("服务器 paid_until 不是 ISO 8601"))?;
    validate_state(&server.billing_state, &BILLING_STATES, "计费")?;
    normalize_grace(server, paid_until);
    Ok(())
}

/// `grace_ends_at` 是派生值，不落库（commands.md 2.30.0）。
///
/// 控制面给了就校验后透传；没给时按 `paid_until + 7d` 算。`active` 永远为 null，
/// 否则界面会显示「还在宽限」而实际已在正常计费。
fn normalize_grace(server: &mut MyServer, paid_until_ms: i64) {
    if server.billing_state == "active" {
        server.grace_ends_at = None;
        return;
    }
    let valid = server
        .grace_ends_at
        .as_deref()
        .and_then(parse_iso_ms)
        .is_some();
    if !valid {
        let grace = paid_until_ms.saturating_add(GRACE_DAYS * 24 * 3600 * 1000);
        server.grace_ends_at = Some(crate::store::iso_from_ms(grace));
    }
}

fn remember_order(order: &MyServerOrder) {
    let mut orders = ORDERS.lock();
    orders.retain(|existing| existing.order_id != order.order_id);
    orders.push(order.clone());
    if orders.len() > REMEMBERED_ORDERS {
        orders.remove(0);
    }
}

fn remembered_order(order_id: &str) -> Option<MyServerOrder> {
    ORDERS
        .lock()
        .iter()
        .find(|order| order.order_id == order_id)
        .cloned()
}

#[allow(clippy::too_many_arguments)]
fn merge_order(
    raw: RawOrder,
    order_id: &str,
    fallback: Option<&MyServerOrder>,
    region: Option<&str>,
    plan: Option<&str>,
) -> Result<MyServerOrder, CpError> {
    let state = raw
        .state
        .or_else(|| fallback.map(|order| order.state.clone()))
        .ok_or_else(|| CpError::invalid_response("订单响应缺少 state"))?;
    validate_state(&state, &ORDER_STATES, "订单")?;

    let order = MyServerOrder {
        order_id: raw
            .order_id
            .unwrap_or_else(|| order_id.to_string()),
        state,
        region: raw
            .region
            .or_else(|| fallback.map(|order| order.region.clone()))
            .or_else(|| region.map(str::to_string))
            .unwrap_or_default(),
        plan: raw
            .plan
            .or_else(|| fallback.map(|order| order.plan.clone()))
            .or_else(|| plan.map(str::to_string))
            .unwrap_or_default(),
        amount_usd: raw
            .amount_usd
            .or_else(|| fallback.map(|order| order.amount_usd))
            .unwrap_or(0.0),
        created_at: raw
            .created_at
            .or_else(|| fallback.map(|order| order.created_at.clone()))
            .unwrap_or_else(now_iso),
        expires_at: raw
            .expires_at
            .or_else(|| fallback.and_then(|order| order.expires_at.clone())),
        server_id: raw
            .server_id
            .or_else(|| fallback.and_then(|order| order.server_id.clone())),
        failure: raw
            .failure
            .or_else(|| fallback.and_then(|order| order.failure.clone())),
    };
    remember_order(&order);
    Ok(order)
}

fn parse_order(raw: Value) -> Result<RawOrder, CpError> {
    serde_json::from_value(raw).map_err(|_| CpError::invalid_response("订单响应格式不正确"))
}

pub async fn list() -> Result<Vec<MyServer>, CpError> {
    let client = ControlPlane::new()?;
    let raw = client.get("/v1/servers").await?;
    let values = raw
        .get("servers")
        .and_then(Value::as_array)
        .ok_or_else(|| CpError::invalid_response("服务器列表响应缺少 servers"))?;
    let mut servers = Vec::with_capacity(values.len());
    for value in values {
        let mut server: MyServer = serde_json::from_value(value.clone())
            .map_err(|_| CpError::invalid_response("服务器列表条目格式不正确"))?;
        validate_server(&mut server)?;
        servers.push(server);
    }
    // 读路径也会顺带维护缓存，这是有意的：一次成功的列表响应是唯一能判断
    // 「云端已无这台服务器」的完整快照；落库与收敛必须共用同一个连接，
    // 否则并发 list 的旧快照可能删掉新快照刚建的行。
    if let Some(store) = crate::store::global() {
        let conn = store.conn();
        for server in &servers {
            cache_server(&conn, server);
        }
        let ids: Vec<&str> = servers
            .iter()
            .map(|server| server.server_id.as_str())
            .collect();
        if let Err(error) = crate::store::servers::retain_only(&conn, &ids) {
            log::warn!("收敛我的服务器镜像失败：{error}");
        }
    }
    Ok(servers)
}

pub async fn get(server_id: &str) -> Result<MyServer, CpError> {
    let client = ControlPlane::new()?;
    get_with(&client, server_id).await
}

async fn get_with(client: &ControlPlane, server_id: &str) -> Result<MyServer, CpError> {
    let raw = client.get(&format!("/v1/servers/{server_id}")).await?;
    let mut server: MyServer = serde_json::from_value(raw)
        .map_err(|_| CpError::invalid_response("服务器详情格式不正确"))?;
    validate_server(&mut server)?;
    if let Some(store) = crate::store::global() {
        let conn = store.conn();
        cache_server(&conn, &server);
    }
    Ok(server)
}

pub async fn create(
    region: &str,
    plan: &str,
    idempotency_key: &str,
) -> Result<MyServerOrder, CpError> {
    let client = ControlPlane::new()?;
    let body = json!({ "region": region, "plan": plan });
    let raw = client
        .post("/v1/orders", Some(&body), Some(idempotency_key))
        .await?;
    let raw = parse_order(raw)?;
    let order_id = raw
        .order_id
        .clone()
        .ok_or_else(|| CpError::invalid_response("下单响应缺少 order_id"))?;
    merge_order(raw, &order_id, None, Some(region), Some(plan))
}

/// 从余额扣一个月并开始建机（2.28.0）。
///
/// 余额不足由控制面返回 `PRECONDITION_FAILED / insufficient_balance`，并带
/// `details.shortfall_cents`；Host 原样透出，不做浮点换算。已付过的订单重复
/// 调用返回 200 且 `charged_cents = 0`，不是二次扣费。
pub async fn checkout(order_id: &str) -> Result<MyServerCharge, CpError> {
    let client = ControlPlane::new()?;
    let raw = client
        .post(
            &format!("/v1/orders/{order_id}/checkout"),
            None,
            Some(&new_idempotency_key()),
        )
        .await?;
    let charge = parse_charge(raw, order_id)?;
    // 扣费成功即已付款：把订单缓存与既有事件跟上。
    let fallback = remembered_order(&charge.order_id);
    let update = RawOrder {
        order_id: Some(charge.order_id.clone()),
        state: Some(charge.state.clone()),
        ..Default::default()
    };
    if let Ok(order) = merge_order(update, &charge.order_id, fallback.as_ref(), None, None) {
        super::events::emit_order_changed(&order);
    }
    Ok(charge)
}

/// 支付通道：省略 = `dodo`；`fake` 只在非生产可用（本地开发与 E2E 的后门）。
fn resolve_channel<'a>(
    channel: &'a str,
    env: crate::control_plane::env::ControlPlaneEnv,
) -> Result<&'a str, CpError> {
    let channel = match channel.trim() {
        "" => "dodo",
        other => other,
    };
    if !matches!(channel, "dodo" | "fake") {
        return Err(CpError::new(
            "INVALID_ARGUMENT",
            "不支持的支付通道",
            false,
            json!({ "reason": "channel_invalid" }),
        ));
    }
    if channel == "fake" && env == crate::control_plane::env::ControlPlaneEnv::Prod {
        return Err(CpError::new(
            "PRECONDITION_FAILED",
            "生产环境不支持假充值",
            false,
            json!({ "reason": "channel_not_allowed" }),
        ));
    }
    Ok(channel)
}

fn parse_charge(raw: Value, order_id: &str) -> Result<MyServerCharge, CpError> {
    let mut charge: MyServerCharge = serde_json::from_value(raw)
        .map_err(|_| CpError::invalid_response("扣费响应格式不正确"))?;
    validate_state(&charge.state, &CHARGE_STATES, "扣费")?;
    if charge.order_id.trim().is_empty() {
        charge.order_id = order_id.to_string();
    }
    if charge.charged_cents < 0 || charge.balance_after_cents < 0 {
        return Err(CpError::invalid_response("扣费金额不能为负"));
    }
    Ok(charge)
}

/// 读余额（`GET /v1/wallet`，USD 分）。`updated_at` 由 Host 补本地时间。
pub async fn wallet() -> Result<MyServerWallet, CpError> {
    let client = ControlPlane::new()?;
    let raw = client.get("/v1/wallet").await?;
    parse_wallet(raw)
}

fn parse_wallet(raw: Value) -> Result<MyServerWallet, CpError> {
    let mut wallet: MyServerWallet = serde_json::from_value(raw)
        .map_err(|_| CpError::invalid_response("钱包响应格式不正确"))?;
    if wallet.balance_cents < 0 {
        return Err(CpError::invalid_response("钱包余额不能为负"));
    }
    if wallet.denominations_cents.iter().any(|cents| *cents <= 0) {
        return Err(CpError::invalid_response("充值面额必须是正整数分"));
    }
    if wallet.currency.trim().is_empty() {
        wallet.currency = default_currency();
    }
    wallet.updated_at = now_iso();
    Ok(wallet)
}

/// 创建充值会话（`POST /v1/topups`）。面额是整数美分；非生产 `fake` 直接入账。
pub async fn topup(denomination_cents: i64, channel: &str) -> Result<MyServerTopup, CpError> {
    if denomination_cents <= 0 {
        return Err(CpError::new(
            "PRECONDITION_FAILED",
            "充值面额不合法",
            false,
            json!({ "reason": "invalid_denomination" }),
        ));
    }
    let channel = resolve_channel(channel, crate::control_plane::env::current().env)?;
    let client = ControlPlane::new()?;
    let body = json!({
        "denomination_cents": denomination_cents,
        "channel": channel,
    });
    let raw = client.post("/v1/topups", Some(&body), Some(&new_idempotency_key())).await?;
    parse_topup(raw, denomination_cents)
}

fn parse_topup(raw: Value, requested_cents: i64) -> Result<MyServerTopup, CpError> {
    #[derive(Deserialize)]
    struct RawTopup {
        #[serde(default)]
        topup_id: Option<String>,
        #[serde(default)]
        checkout_url: Option<String>,
        #[serde(default)]
        denomination_cents: Option<i64>,
    }

    let raw: RawTopup = serde_json::from_value(raw)
        .map_err(|_| CpError::invalid_response("充值响应格式不正确"))?;
    let topup_id = raw
        .topup_id
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| CpError::invalid_response("充值响应缺少 topup_id"))?;
    let denomination_cents = raw.denomination_cents.unwrap_or(requested_cents);
    if denomination_cents <= 0 {
        return Err(CpError::invalid_response("充值面额不合法"));
    }
    Ok(MyServerTopup {
        topup_id,
        checkout_url: raw.checkout_url.filter(|value| !value.trim().is_empty()),
        denomination_cents,
    })
}

/// 支付与开通轮询（`GET /v1/orders/{id}`）。状态变化时发既有订单事件。
pub async fn get_order(order_id: &str) -> Result<MyServerOrder, CpError> {
    let client = ControlPlane::new()?;
    let raw = client.get(&format!("/v1/orders/{order_id}")).await?;
    let fallback = remembered_order(order_id);
    let previous = fallback.as_ref().map(|order| order.state.clone());
    let order = merge_order(parse_order(raw)?, order_id, fallback.as_ref(), None, None)?;
    if previous.as_deref() != Some(order.state.as_str()) {
        super::events::emit_order_changed(&order);
    }
    Ok(order)
}

pub async fn cancel_order(order_id: &str) -> Result<MyServerOrder, CpError> {
    let client = ControlPlane::new()?;
    let raw = client
        .post(
            &format!("/v1/orders/{order_id}/cancel"),
            None,
            Some(&new_idempotency_key()),
        )
        .await?;
    let fallback = remembered_order(order_id);
    merge_order(parse_order(raw)?, order_id, fallback.as_ref(), None, None)
}

pub async fn destroy(server_id: &str, confirm: bool) -> Result<MyServer, CpError> {
    if !confirm {
        return Err(CpError::new(
            "PRECONDITION_FAILED",
            "销毁需要二次确认",
            false,
            json!({ "reason": "confirm_required" }),
        ));
    }
    let client = ControlPlane::new()?;
    let before = match get_with(&client, server_id).await {
        Ok(server) => Some(server),
        Err(error) if error.code == "NOT_FOUND" => local_server(server_id),
        Err(_) => local_server(server_id),
    };
    client
        .post(
            &format!("/v1/servers/{server_id}/destroy"),
            Some(&json!({ "confirm": true })),
            Some(&new_idempotency_key()),
        )
        .await?;

    let mut server = before.ok_or_else(|| {
        CpError::new(
            "NOT_FOUND",
            "找不到这台服务器",
            false,
            json!({ "reason": "server_gone" }),
        )
    })?;
    server.state = "destroying".into();
    // 销毁即销毁凭据（§19.8）；节点记录保留并能在界面标「服务器已销毁」。
    if let Some(store) = crate::store::global() {
        let conn = store.conn();
        cache_server(&conn, &server);
        forget_credentials(&conn, server_id, server.node_id.as_deref(), |key| {
            let _ = crate::secrets::delete_secret(key);
        });
    } else if let Some(node_id) = server.node_id.as_deref() {
        let _ = crate::secrets::delete_secret(&format!("node:{node_id}"));
    }
    Ok(server)
}

/// 删除某台服务器在本地的节点密码。
///
/// 键以本地节点行的 `password_ref` 为准：控制面换发凭据后 `MyServer.node_id`
/// 可能是远端 id，按它拼键会漏删本地密码。只有找不到本地节点时才用远端 id 兜底。
fn forget_credentials(
    conn: &rusqlite::Connection,
    server_id: &str,
    remote_node_id: Option<&str>,
    mut delete: impl FnMut(&str),
) {
    if let Ok(Some(node)) = crate::store::configs::find_node_by_source_key(
        conn,
        crate::store::configs::SOURCE_OWNED,
        server_id,
    ) {
        delete(&node.password_ref);
        return;
    }
    if let Some(node_id) = remote_node_id {
        delete(&format!("node:{node_id}"));
    }
}

pub async fn rebuild(server_id: &str, confirm: bool) -> Result<Value, CpError> {
    if !confirm {
        return Err(CpError::new(
            "PRECONDITION_FAILED",
            "重新建一台需要二次确认",
            false,
            json!({ "reason": "confirm_required" }),
        ));
    }
    let client = ControlPlane::new()?;
    let old = match get_with(&client, server_id).await {
        Ok(server) => Some(server),
        Err(_) => local_server(server_id),
    };
    let raw = client
        .post(
            &format!("/v1/servers/{server_id}/rebuild"),
            Some(&json!({ "confirm": true })),
            Some(&new_idempotency_key()),
        )
        .await?;
    let new_id = raw
        .get("new_server_id")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| CpError::invalid_response("重建响应缺少 new_server_id"))?;
    let state = raw
        .get("state")
        .and_then(Value::as_str)
        .unwrap_or("creating");
    validate_state(state, &SERVER_STATES, "新服务器")?;

    if let Some(old) = old {
        let created = MyServer {
            server_id: new_id.to_string(),
            name: old.name,
            region: old.region,
            plan: old.plan,
            state: state.to_string(),
            created_at: now_iso(),
            ip: None,
            port: None,
            node_id: None,
            hourly_usd: old.hourly_usd,
            monthly_usd: old.monthly_usd,
            daily_price_cents: old.daily_price_cents,
            transfer_gib: old.transfer_gib,
            // rebuild 是新的计费生命周期：第 0 天已扣，先按 1 天估算，
            // 下一次列表/详情以控制面为准。
            paid_until: crate::store::iso_from_ms(crate::store::now_ms() + 24 * 3600 * 1000),
            billing_state: "active".into(),
            grace_ends_at: None,
            failure: None,
        };
        if let Some(store) = crate::store::global() {
            let conn = store.conn();
            cache_server(&conn, &created);
        }
    }

    Ok(json!({ "newServerId": new_id, "state": state }))
}

pub async fn credentials(server_id: &str) -> Result<Value, CpError> {
    let client = ControlPlane::new()?;
    let raw = client
        .post(&format!("/v1/servers/{server_id}/credentials"), None, None)
        .await?;
    let response = credential_response(&raw)?;

    let linked_before = local_server(server_id).and_then(|server| server.node_id);
    let node = super::credentials::verify_and_store(
        server_id,
        response.payload,
        response.signature,
        response.key_id,
    )?;
    // 本地关联真的变了才发事件；重复取凭据不制造无意义的状态事件。
    let linked_after = local_server(server_id);
    if linked_after
        .as_ref()
        .and_then(|server| server.node_id.as_deref())
        != linked_before.as_deref()
    {
        if let Some(server) = linked_after {
            super::events::emit_server_changed(&server);
        }
    }
    // 只回本地节点：密码留在 `secrets.enc`，不再把含密码的 payload 交给界面。
    Ok(json!(node))
}

/// 凭据响应的三个字段缺一不可；缺字段按 `invalid_response` 报错，不猜默认值。
fn credential_response(raw: &Value) -> Result<super::credentials::CredentialResponse<'_>, CpError> {
    let payload = raw
        .get("payload")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| CpError::invalid_response("凭据响应缺少 payload"))?;
    let signature = raw
        .get("signature")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| CpError::invalid_response("凭据响应缺少 signature"))?;
    let key_id = raw
        .get("key_id")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| CpError::invalid_response("凭据响应缺少 key_id"))?;
    Ok(super::credentials::CredentialResponse {
        payload,
        signature,
        key_id,
    })
}

/// 本地节点关联以 `nodes(source='owned', source_key=server_id)` 为准。
///
/// 控制面换发凭据时可能给出新的 `node_id`，本地仍复用旧节点行；反过来，
/// 本地行缺失时只有确实存在的节点 id 才能写进 `my_servers`（外键约束）。
fn linked_node_id(
    conn: &rusqlite::Connection,
    server_id: &str,
    remote: Option<&str>,
) -> Option<String> {
    if let Ok(Some(node)) = crate::store::configs::find_node_by_source_key(
        conn,
        crate::store::configs::SOURCE_OWNED,
        server_id,
    ) {
        return Some(node.id);
    }
    remote
        .filter(|id| {
            crate::store::configs::get_node(conn, id)
                .ok()
                .flatten()
                .is_some()
        })
        .map(str::to_string)
}

fn cache_server(conn: &rusqlite::Connection, server: &MyServer) {
    let before = crate::store::servers::get(conn, &server.server_id)
        .ok()
        .flatten();
    let created_at = parse_iso_ms(&server.created_at).unwrap_or_else(crate::store::now_ms);
    let paid_until = match parse_iso_ms(&server.paid_until) {
        Some(value) => value,
        None => {
            log::warn!("缓存我的服务器失败：paid_until 不是 ISO 8601");
            return;
        }
    };
    // `my_servers.node_id` 有外键；远端可能比本地先给出 node_id（凭据还没取），
    // 此时先留空，等 `my_server_credentials` 建好节点行再回填。
    // 关联以本地节点行为准：换发凭据后远端 id 可能已经变了。
    let node_id = linked_node_id(conn, &server.server_id, server.node_id.as_deref());
    let new = crate::store::NewMyServer {
        id: &server.server_id,
        provider: "digitalocean",
        name: &server.name,
        region: &server.region,
        plan: &server.plan,
        state: &server.state,
        node_id: node_id.as_deref(),
        hourly_usd: server.hourly_usd,
        monthly_usd: server.monthly_usd,
        daily_price_cents: server.daily_price_cents,
        transfer_gib: server.transfer_gib,
        paid_until,
        billing_state: &server.billing_state,
        created_at,
    };
    if let Err(error) = crate::store::servers::upsert(conn, &new) {
        log::warn!("缓存我的服务器失败：{error}");
        return;
    }
    let changed = before
        .as_ref()
        .map(|row| row.state.as_str() != server.state)
        .unwrap_or(true);
    if changed {
        // 事件里的 `node_id` 非空表示「节点已可用来建配置」，只能是本地节点 id；
        // 控制面 `nd_…` 在本地节点建好前不可用，按 null 上报。
        let mut event = server.clone();
        event.node_id = node_id;
        super::events::emit_server_changed(&event);
    }
}

fn local_server(server_id: &str) -> Option<MyServer> {
    let store = crate::store::global()?;
    let conn = store.conn();
    let row = crate::store::servers::get(&conn, server_id).ok().flatten()?;
    Some(MyServer {
        server_id: row.id,
        name: row.name,
        region: row.region,
        plan: row.plan,
        state: row.state,
        created_at: crate::store::iso_from_ms(row.created_at),
        ip: None,
        port: None,
        node_id: linked_node_id(&conn, server_id, row.node_id.as_deref()),
        hourly_usd: row.hourly_usd,
        monthly_usd: row.monthly_usd,
        daily_price_cents: row.daily_price_cents,
        transfer_gib: row.transfer_gib,
        paid_until: crate::store::iso_from_ms(row.paid_until),
        billing_state: row.billing_state.clone(),
        grace_ends_at: if row.billing_state == "active" {
            None
        } else {
            Some(crate::store::iso_from_ms(
                row.paid_until + GRACE_DAYS * 24 * 3600 * 1000,
            ))
        },
        failure: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_idempotency_key_is_a_uuid_v4() {
        let key = new_idempotency_key();
        let parts: Vec<_> = key.split('-').collect();
        assert_eq!(parts.len(), 5);
        assert_eq!(parts[0].len(), 8);
        assert_eq!(parts[1].len(), 4);
        assert!(parts[2].starts_with('4'), "version nibble: {key}");
        assert!(
            parts[3].starts_with('8') || parts[3].starts_with('9') || parts[3].starts_with('a') || parts[3].starts_with('b'),
            "variant nibble: {key}"
        );
        assert_ne!(key, new_idempotency_key());
    }

    #[test]
    fn a_server_response_is_validated() {
        let mut server = MyServer {
            server_id: "srv_1".into(),
            name: "Tokyo".into(),
            region: "tyo".into(),
            plan: "s-1vcpu-1gb".into(),
            state: "healthy".into(),
            created_at: "2026-11-14T08:00:00Z".into(),
            ip: None,
            port: None,
            node_id: None,
            hourly_usd: 0.009,
            monthly_usd: 6.0,
            daily_price_cents: 20,
            transfer_gib: 1000,
            paid_until: "2026-11-15T08:00:00Z".into(),
            billing_state: "active".into(),
            grace_ends_at: None,
            failure: None,
        };
        assert!(validate_server(&mut server).is_ok());

        server.state = "unknown-state".into();
        assert_eq!(
            validate_server(&mut server).unwrap_err().reason(),
            Some("invalid_response")
        );
        server.state = "healthy".into();
        server.created_at = "yesterday".into();
        assert!(validate_server(&mut server).is_err());
    }

    fn a_server_json() -> Value {
        json!({
            "server_id": "srv_1",
            "name": "Tokyo",
            "region": "tyo",
            "plan": "s-1vcpu-1gb",
            "state": "healthy",
            "created_at": "2026-11-14T08:00:00Z",
            "hourly_usd": 0.009,
            "monthly_usd": 6.0,
            "daily_price_cents": 20,
            "transfer_gib": 1000,
            "paid_until": "2026-11-15T08:00:00Z",
            "billing_state": "active",
        })
    }

    #[test]
    fn billing_fields_are_required_and_paid_until_is_never_null() {
        let mut server: MyServer = serde_json::from_value(a_server_json()).unwrap();
        assert!(validate_server(&mut server).is_ok());
        assert_eq!(server.daily_price_cents, 20);
        assert_eq!(server.transfer_gib, 1000);
        assert_eq!(server.paid_until, "2026-11-15T08:00:00Z");
        assert_eq!(server.billing_state, "active");
        // active 没有宽限期：即使上游误发也要清掉。
        server.grace_ends_at = Some("2026-11-22T08:00:00Z".into());
        assert!(validate_server(&mut server).is_ok());
        assert!(server.grace_ends_at.is_none());

        for field in ["daily_price_cents", "transfer_gib", "paid_until", "billing_state"] {
            let mut value = a_server_json();
            value.as_object_mut().unwrap().remove(field);
            assert!(
                serde_json::from_value::<MyServer>(value).is_err(),
                "{field} 缺失必须解析失败"
            );
        }

        // 契约 2.30.0：paid_until 收紧为非空，null 不能被当成没付过费。
        let mut value = a_server_json();
        value["paid_until"] = Value::Null;
        assert!(serde_json::from_value::<MyServer>(value).is_err());
    }

    #[test]
    fn grace_ends_at_is_derived_for_past_due_and_expired_servers() {
        let mut server: MyServer = serde_json::from_value(a_server_json()).unwrap();
        server.billing_state = "past_due".into();
        validate_server(&mut server).unwrap();
        // 控制面不给 grace_ends_at：Host 按 paid_until + 7d 算。
        assert_eq!(
            server.grace_ends_at.as_deref(),
            Some("2026-11-22T08:00:00Z")
        );

        // 控制面给了合法值就透传。
        server.grace_ends_at = Some("2026-11-30T08:00:00Z".into());
        validate_server(&mut server).unwrap();
        assert_eq!(
            server.grace_ends_at.as_deref(),
            Some("2026-11-30T08:00:00Z")
        );

        // 非法值按缺失处理，仍按契约重算，不把垃圾字符串交给界面。
        server.grace_ends_at = Some("soon".into());
        validate_server(&mut server).unwrap();
        assert_eq!(
            server.grace_ends_at.as_deref(),
            Some("2026-11-22T08:00:00Z")
        );

        server.billing_state = "weird".into();
        assert_eq!(
            validate_server(&mut server).unwrap_err().reason(),
            Some("invalid_response")
        );
    }

    #[test]
    fn an_order_merges_the_response_with_the_request_and_cache() {
        let fallback = MyServerOrder {
            order_id: "ord_1".into(),
            state: "pending_payment".into(),
            region: "tyo".into(),
            plan: "s-1vcpu-1gb".into(),
            amount_usd: 6.0,
            created_at: "2026-11-14T08:00:00Z".into(),
            expires_at: Some("2026-11-14T08:10:00Z".into()),
            server_id: None,
            failure: None,
        };
        let raw = parse_order(json!({ "state": "paid", "server_id": "srv_1" })).unwrap();
        let merged = merge_order(raw, "ord_1", Some(&fallback), None, None).unwrap();
        assert_eq!(merged.order_id, "ord_1");
        assert_eq!(merged.state, "paid");
        assert_eq!(merged.region, "tyo");
        assert_eq!(merged.amount_usd, 6.0);
        assert_eq!(merged.server_id.as_deref(), Some("srv_1"));
    }

    #[test]
    fn an_unknown_order_state_is_rejected() {
        let raw = parse_order(json!({ "state": "weird" })).unwrap();
        assert!(merge_order(raw, "ord_1", None, None, None).is_err());
    }

    #[test]
    fn the_removed_checkout_states_are_rejected() {
        for state in ["awaiting_payment", "payment_failed", "expired"] {
            let raw = parse_order(json!({ "state": state })).unwrap();
            let error = merge_order(raw, "ord_1", None, None, None).unwrap_err();
            assert_eq!(error.reason(), Some("invalid_response"), "{state}");
        }
    }

    #[test]
    fn a_charge_response_carries_cents_and_supports_repeat_calls() {
        let charge = parse_charge(
            json!({
                "order_id": "ord_1",
                "state": "paid",
                "charged_cents": 900,
                "balance_after_cents": 1100,
            }),
            "ord_fallback",
        )
        .unwrap();
        assert_eq!(charge.order_id, "ord_1");
        assert_eq!(charge.state, "paid");
        assert_eq!(charge.charged_cents, 900);
        assert_eq!(charge.balance_after_cents, 1100);

        // 已付过的订单重复调用：charged_cents = 0，不是二次扣费。
        let charge =
            parse_charge(json!({ "state": "ready", "charged_cents": 0, "balance_after_cents": 1100 }), "ord_2")
                .unwrap();
        assert_eq!(charge.order_id, "ord_2");
        assert_eq!(charge.charged_cents, 0);

        // 旧收银台状态与负金额都按 invalid_response 处理，不 panic。
        let error = parse_charge(
            json!({ "state": "awaiting_payment", "charged_cents": 1, "balance_after_cents": 1 }),
            "ord_3",
        )
        .unwrap_err();
        assert_eq!(error.reason(), Some("invalid_response"));
        assert!(parse_charge(
            json!({ "state": "paid", "charged_cents": -1, "balance_after_cents": 1 }),
            "ord_4",
        )
        .is_err());
    }

    #[test]
    fn a_wallet_response_defaults_currency_and_stamps_local_time() {
        let wallet = parse_wallet(json!({
            "balance_cents": 2000,
            "denominations_cents": [1000, 2000, 5000, 10000],
        }))
        .unwrap();
        assert_eq!(wallet.balance_cents, 2000);
        assert_eq!(wallet.currency, "USD");
        assert_eq!(
            wallet.denominations_cents,
            vec![1000, 2000, 5000, 10000]
        );
        assert!(chrono::DateTime::parse_from_rfc3339(&wallet.updated_at).is_ok());

        // 缺面额字段按空数组容错；非法面额拒绝。
        assert!(parse_wallet(json!({ "balance_cents": 0 }))
            .unwrap()
            .denominations_cents
            .is_empty());
        assert!(parse_wallet(json!({ "balance_cents": 0, "denominations_cents": [0] })).is_err());
        assert!(parse_wallet(json!({ "balance_cents": -1 })).is_err());
    }

    #[test]
    fn a_topup_response_fills_the_requested_denomination() {
        let topup = parse_topup(
            json!({ "topup_id": "tp_1", "checkout_url": "https://pay.example/t" }),
            2000,
        )
        .unwrap();
        assert_eq!(topup.topup_id, "tp_1");
        assert_eq!(topup.denomination_cents, 2000);
        assert_eq!(topup.checkout_url.as_deref(), Some("https://pay.example/t"));

        // fake 通道直接入账：没有 URL；响应自带面额时以响应为准。
        let topup = parse_topup(
            json!({ "topup_id": "tp_2", "checkout_url": null, "denomination_cents": 1000 }),
            2000,
        )
        .unwrap();
        assert_eq!(topup.denomination_cents, 1000);
        assert!(topup.checkout_url.is_none());

        // 缺 topup_id 不可信。
        assert!(parse_topup(json!({ "denomination_cents": 1000 }), 2000).is_err());
    }

    #[test]
    fn the_channel_rules_separate_production_from_local_testing() {
        use crate::control_plane::env::ControlPlaneEnv;

        assert_eq!(resolve_channel("", ControlPlaneEnv::Prod).unwrap(), "dodo");
        assert_eq!(resolve_channel("fake", ControlPlaneEnv::Dev).unwrap(), "fake");

        let error = resolve_channel("fake", ControlPlaneEnv::Prod).unwrap_err();
        assert_eq!(error.code, "PRECONDITION_FAILED");
        assert_eq!(error.reason(), Some("channel_not_allowed"));

        let error = resolve_channel("paypal", ControlPlaneEnv::Dev).unwrap_err();
        assert_eq!(error.code, "INVALID_ARGUMENT");
    }

    #[test]
    fn a_credential_response_needs_all_three_fields() {
        let complete = json!({ "payload": "{}", "signature": "sig", "key_id": "cp-test" });
        assert!(credential_response(&complete).is_ok());

        for field in ["payload", "signature", "key_id"] {
            let mut value = complete.clone();
            let _ = value.as_object_mut().unwrap().remove(field);
            let error = credential_response(&value).unwrap_err();
            assert_eq!(error.code, "UPSTREAM_ERROR", "{field}");
            assert_eq!(error.reason(), Some("invalid_response"), "{field}");
        }

        // 空串与缺字段同罪：别拿空 key_id 去撞「未知密钥」的误导文案。
        let mut empty = complete;
        empty["key_id"] = json!("");
        assert_eq!(
            credential_response(&empty).unwrap_err().reason(),
            Some("invalid_response")
        );
    }

    #[test]
    fn destroying_a_server_forgets_the_local_password_key() {
        let store = crate::store::Store::open_in_memory().unwrap();
        let conn = store.conn();
        crate::store::configs::upsert_node(
            &conn,
            &crate::store::NewNode {
                id: "nd_local",
                name: "Tokyo",
                server: "203.0.113.10",
                port: 20343,
                method: "aes-256-gcm",
                password_ref: "node:nd_local",
                source: crate::store::configs::SOURCE_OWNED,
                source_key: "srv_1",
            },
        )
        .unwrap();

        // 控制面换发后远端 id 与本地节点 id 不同：必须删本地 `password_ref`。
        let mut deleted = Vec::new();
        forget_credentials(&conn, "srv_1", Some("nd_remote"), |key| {
            deleted.push(key.to_string())
        });
        assert_eq!(deleted, vec!["node:nd_local"]);

        // 本地没有节点行时才用远端 id 兜底。
        let mut deleted = Vec::new();
        forget_credentials(&conn, "srv_2", Some("nd_remote"), |key| {
            deleted.push(key.to_string())
        });
        assert_eq!(deleted, vec!["node:nd_remote"]);
    }

    #[test]
    fn the_owned_node_link_wins_over_a_reissued_remote_id() {
        let store = crate::store::Store::open_in_memory().unwrap();
        let conn = store.conn();
        crate::store::configs::upsert_node(
            &conn,
            &crate::store::NewNode {
                id: "nd_local",
                name: "Tokyo",
                server: "203.0.113.10",
                port: 20343,
                method: "aes-256-gcm",
                password_ref: "node:nd_local",
                source: crate::store::configs::SOURCE_OWNED,
                source_key: "srv_1",
            },
        )
        .unwrap();

        // 控制面换发了新 id：本地仍指向 `source_key = srv_1` 的节点行。
        assert_eq!(
            linked_node_id(&conn, "srv_1", Some("nd_new")),
            Some("nd_local".into())
        );
        // 没有 source_key 命中时，只有真实存在的节点 id 能写进 `my_servers`（外键）。
        assert_eq!(linked_node_id(&conn, "srv_2", Some("nd_missing")), None);
        assert_eq!(
            linked_node_id(&conn, "srv_2", Some("nd_local")),
            Some("nd_local".into())
        );
    }
}
