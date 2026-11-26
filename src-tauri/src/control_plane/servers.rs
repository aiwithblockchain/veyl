//! 我的服务器：8 个控制面端点 + 本地镜像缓存。
//!
//! 控制面是唯一事实源；本地 `my_servers` 只用于离线展示与节点关联。
//! 命令层只负责参数搬运，所有业务在这里。

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};

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
pub const BILLING_STATES: [&str; 4] = ["active", "past_due", "expired", "pending"];

/// 扣费口径（2.39.0）：`upfront` 下单即扣（存量），`at_ready` 就绪后结算。
pub const CHARGE_MODES: [&str; 2] = ["upfront", "at_ready"];

/// 旧响应没有 `charge_mode`：建行即扣是当时唯一的形态。
fn default_charge_mode() -> String {
    "upfront".into()
}

/// 缺字段用默认值；显式 null（旧订单列可空）也按 `upfront`，不让一条历史订单拖垮整个列表。
fn deserialize_charge_mode<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Ok(Option::<String>::deserialize(deserializer)?.unwrap_or_else(default_charge_mode))
}

/// 宽限期：`grace_ends_at` 的派生口径（§4.6），控制面不给时由 Host 计算。
const GRACE_DAYS: i64 = 7;

/// 销毁要同步调 DigitalOcean `deleteDroplet`，本身就要几秒；只有这一个请求放宽到 30 秒。
const DESTROY_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MyServerFailure {
    /// 失败发生在哪个阶段；旧镜像没有这个字段时按 active 兼容。
    #[serde(default = "default_failure_stage")]
    pub stage: String,
    pub code: String,
    pub message: String,
    pub retryable: bool,
}

fn default_failure_stage() -> String {
    // 中性缺省：解析时留空，由 `remember_server_failure` 用该服务器当前状态补齐。
    String::new()
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MyServer {
    pub server_id: String,
    pub name: String,
    pub region: String,
    pub plan: String,
    pub state: String,
    pub created_at: String,
    /// 激活成功的时刻（ISO 8601）；null = 界面不渲染建机耗时，不要拿 created_at 顶替。
    #[serde(default)]
    pub ready_at: Option<String>,
    /// 首次进入 installing / verifying 的时刻；没上报过就是 null。
    #[serde(default)]
    pub installing_at: Option<String>,
    #[serde(default)]
    pub verifying_at: Option<String>,
    /// 节点最近一次上报的 sing-box 版本（不带 `v`）；还没上报过为 null，界面显示「未知」。
    #[serde(default)]
    pub singbox_version: Option<String>,
    #[serde(default)]
    pub ip: Option<String>,
    #[serde(default)]
    pub port: Option<u16>,
    /// 控制面 id（`nd_…`）；机器 active 后就有值，**不代表本地能用**。
    #[serde(default)]
    pub node_id: Option<String>,
    /// 本地节点镜像里的节点 id；本地已为这台机器建好节点行时才非空。
    ///
    /// **为空 = 本地还没有这台机器的节点行 = 用这台机器之前要先去取凭据。**
    /// 判断「要不要取凭据」只看这个字段，不要看 `node_id`：控制面在 active 之后
    /// 就会给出 `nd_…`，那时本地节点行往往还不存在，拿它判会永远为真。
    #[serde(default)]
    pub local_node_id: Option<String>,
    pub hourly_usd: f64,
    pub monthly_usd: f64,
    /// 售价快照（USD 分 / 天），即每天实际扣多少。
    pub daily_price_cents: i64,
    /// 每月公网出口额度快照（GiB）；0 = 未知，不参与任何扣费。
    pub transfer_gib: i64,
    /// 本周期（UTC 自然月）已用字节；没有上报行 = 0（契约 2.78.0）。
    #[serde(default, deserialize_with = "deserialize_lenient_bytes")]
    pub traffic_used_bytes: u64,
    /// 本周期已释放额度（字节），控制面现算、不是快照；额度未知 = 0。
    #[serde(default, deserialize_with = "deserialize_lenient_bytes")]
    pub traffic_limit_bytes: u64,
    /// 本周期清零点（下个 UTC 月 1 日 00:00，ISO 8601）；旧控制面不给时为空串。
    #[serde(default, deserialize_with = "deserialize_lenient_string")]
    pub traffic_reset_at: String,
    /// `ok` | `unpaid`（单台没有 near/over，那是账号池的判定）；缺字段、null、
    /// 认不出的值——包括旧控制面还在发的 `near` / `over`——一律降级 `ok`。
    #[serde(
        default = "default_traffic_state",
        deserialize_with = "deserialize_lenient_traffic_state"
    )]
    pub traffic_state: String,
    /// 这台服务器实际扣过的钱（USD 分）；没扣过 = 0。
    #[serde(default)]
    pub charged_cents: i64,
    /// 已退回的钱（USD 分）；没退过 = 0。
    #[serde(default)]
    pub refunded_cents: i64,
    /// 已付到哪个时刻（ISO 8601）；结算前为 null（`billing_state = "pending"`）。
    #[serde(default)]
    pub paid_until: Option<String>,
    pub billing_state: String,
    /// 扣费口径；缺字段或 null 按 `upfront`（旧控制面没有这个概念）。
    #[serde(
        default = "default_charge_mode",
        deserialize_with = "deserialize_charge_mode"
    )]
    pub charge_mode: String,
    /// 派生值：`paid_until + 7d`，不落库；仅 past_due / expired 非空。
    #[serde(default)]
    pub grace_ends_at: Option<String>,
    #[serde(default)]
    pub failure: Option<MyServerFailure>,
}

fn default_traffic_state() -> String {
    "ok".into()
}

/// 字节字段的宽解析：整数与非负浮点都收，其余（null、字符串、负数）按 0。
///
/// 口径与账单流水的逐条宽松一致：滚动升级期间宁可显示 0，也不能因为
/// 一个流量字段让整页服务器消失。
fn deserialize_lenient_bytes<'de, D>(deserializer: D) -> Result<u64, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Ok(match Option::<Value>::deserialize(deserializer)? {
        Some(Value::Number(number)) => number
            .as_u64()
            .or_else(|| {
                number
                    .as_f64()
                    .filter(|value| value.is_finite() && *value >= 0.0)
                    .map(|value| value.min(u64::MAX as f64) as u64)
            })
            .unwrap_or(0),
        _ => 0,
    })
}

fn deserialize_lenient_string<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Ok(match Option::<Value>::deserialize(deserializer)? {
        Some(Value::String(value)) => value,
        _ => String::new(),
    })
}

fn deserialize_lenient_traffic_state<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Ok(match Option::<Value>::deserialize(deserializer)? {
        Some(Value::String(value)) if TRAFFIC_STATES.contains(&value.as_str()) => value,
        _ => default_traffic_state(),
    })
}

/// 单台只有两态：`ok` / `unpaid`。滚动升级期间旧控制面还会发 `near` / `over`，
/// 它们不在白名单里，按 `ok` 降级，绝不因此让整页解析失败。
const TRAFFIC_STATES: [&str; 2] = ["ok", "unpaid"];

/// `GET /v1/servers` 的账号级流量池（契约 2.79.0）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TrafficPool {
    pub used_bytes: u64,
    pub limit_bytes: u64,
}

/// `my_server_list` 的返回：服务器列表 + 账号级流量池。
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ServerList {
    pub servers: Vec<MyServer>,
    /// 账号池；控制面没给（旧版本）时缺省，不影响解析。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub traffic_pool: Option<TrafficPool>,
    /// 有条目解析失败 → 这不是一份完整快照，不能拿它做镜像收敛。
    #[serde(skip)]
    pub complete: bool,
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
    /// 扣费口径；缺字段或 null 按 `upfront`。
    #[serde(
        default = "default_charge_mode",
        deserialize_with = "deserialize_charge_mode"
    )]
    pub charge_mode: String,
}

/// `my_server_wallet` 的返回：余额（USD 分）与可选充值面额（整数分，升序）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MyServerWallet {
    pub balance_cents: i64,
    #[serde(default = "default_currency")]
    pub currency: String,
    /// 充值档位，直接来自控制面，Host 不排序、不换算。
    #[serde(default)]
    pub denominations_cents: Vec<i64>,
    /// 自定义充值范围（USD 分）；控制面未提供时两者都按 None。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub min_topup_cents: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_topup_cents: Option<i64>,
    /// 控制面不给时间，由 Host 补本地时间。
    #[serde(default)]
    pub updated_at: String,
}

fn default_currency() -> String {
    "USD".into()
}

/// `my_server_topup` 的返回：充值收银台会话。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MyServerTopup {
    pub topup_id: String,
    #[serde(default)]
    pub checkout_url: Option<String>,
    pub denomination_cents: i64,
}

/// 服务器详情「创建记录」的一条（commands.md §7.31）。
///
/// `at` 是 Unix 毫秒，Host 原样透传、不做格式化；可选字段只在该事件类型下出现。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MyServerEvent {
    pub at: i64,
    pub code: String,
    /// 折叠次数；仅相邻同类事件合并后 > 1 时出现。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub count: Option<u32>,
    /// 仅 `activated`：sing-box 版本。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    /// 仅 `refunded` / `refund.pending`（USD 分）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub amount_cents: Option<i64>,
    /// 仅 `destroyed`：白名单枚举，未知值不下发。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MyServerEvents {
    pub events: Vec<MyServerEvent>,
    pub has_more: bool,
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
    #[serde(default)]
    charge_mode: Option<String>,
}

static ORDERS: parking_lot::Mutex<Vec<MyServerOrder>> = parking_lot::Mutex::new(Vec::new());
const REMEMBERED_ORDERS: usize = 20;

/// 一次订单状态变化。`MyServerFailure` 只用内存里的最近若干条，
/// 契约不要求跨进程持久化（`tools.md` §4.51）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MyServerOrderEvent {
    pub at: String,
    pub state: String,
    #[serde(default)]
    pub detail: Option<String>,
}

#[derive(Debug, Clone)]
struct RememberedOrderEvent {
    order_id: String,
    event: MyServerOrderEvent,
}

static ORDER_EVENTS: parking_lot::Mutex<Vec<RememberedOrderEvent>> =
    parking_lot::Mutex::new(Vec::new());
const REMEMBERED_ORDER_EVENTS: usize = 200;

/// 最近一次从控制面看到的服务器失败（`failure` 不在本地镜像表里）。
static SERVER_FAILURES: parking_lot::Mutex<Option<HashMap<String, MyServerFailure>>> =
    parking_lot::Mutex::new(None);

fn server_failures() -> parking_lot::MutexGuard<'static, Option<HashMap<String, MyServerFailure>>> {
    SERVER_FAILURES.lock()
}

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
    // 2.39.0：结算前 paid_until 为 null，只有 pending 允许；其它状态必须是合法时刻。
    let paid_until = match server.paid_until.as_deref() {
        Some(value) => Some(
            parse_iso_ms(value)
                .ok_or_else(|| CpError::invalid_response("服务器 paid_until 不是 ISO 8601"))?,
        ),
        None => {
            if server.billing_state != "pending" {
                return Err(CpError::invalid_response("服务器 paid_until 为空但不在 pending"));
            }
            None
        }
    };
    validate_state(&server.billing_state, &BILLING_STATES, "计费")?;
    validate_state(&server.charge_mode, &CHARGE_MODES, "扣费口径")?;
    normalize_grace(server, paid_until);
    Ok(())
}

/// `grace_ends_at` 是派生值，不落库（commands.md 2.30.0）。
///
/// 控制面给了就校验后透传；没给时按 `paid_until + 7d` 算。`active` 永远为 null，
/// 否则界面会显示「还在宽限」而实际已在正常计费。
fn normalize_grace(server: &mut MyServer, paid_until_ms: Option<i64>) {
    if server.billing_state == "active" {
        server.grace_ends_at = None;
        return;
    }
    let Some(paid_until_ms) = paid_until_ms else {
        // pending（结算前）没有已付时刻，也就没有宽限期。
        server.grace_ends_at = None;
        return;
    };
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

/// 只在状态真的变化时记一条；新订单的首个状态也算一条。
fn record_order_event(order: &MyServerOrder, previous_state: Option<&str>) {
    if previous_state == Some(order.state.as_str()) {
        return;
    }
    let mut events = ORDER_EVENTS.lock();
    events.push(RememberedOrderEvent {
        order_id: order.order_id.clone(),
        event: MyServerOrderEvent {
            at: now_iso(),
            state: order.state.clone(),
            detail: order.failure.as_ref().map(|failure| failure.message.clone()),
        },
    });
    if events.len() > REMEMBERED_ORDER_EVENTS {
        let drop = events.len() - REMEMBERED_ORDER_EVENTS;
        events.drain(0..drop);
    }
}

/// 这台服务器最近一次创建/开通订单（内存镜像）。
pub fn latest_order_for_server(server_id: &str) -> Option<MyServerOrder> {
    ORDERS
        .lock()
        .iter()
        .rev()
        .find(|order| order.server_id.as_deref() == Some(server_id))
        .cloned()
}

/// 某订单最近的事件，**新的在前**，最多 `limit` 条。
pub fn recent_order_events(order_id: &str, limit: usize) -> Vec<MyServerOrderEvent> {
    ORDER_EVENTS
        .lock()
        .iter()
        .rev()
        .filter(|event| event.order_id == order_id)
        .take(limit)
        .map(|event| event.event.clone())
        .collect()
}

fn remember_server_failure(server: &MyServer) {
    let mut failures = server_failures();
    let map = failures.get_or_insert_with(HashMap::new);
    match &server.failure {
        Some(failure) => {
            let mut failure = failure.clone();
            if failure.stage.trim().is_empty() {
                // 旧镜像没有 stage：用这台服务器当前的状态补，不要凭空写成 active。
                failure.stage = server.state.clone();
            }
            map.insert(server.server_id.clone(), failure);
        }
        // 最新一次观察到是健康的：旧失败不再代表现状。
        None => {
            map.remove(&server.server_id);
        }
    }
}

/// 最近一次从控制面看到的失败；没失败过或已恢复时为 None。
pub fn server_failure(server_id: &str) -> Option<MyServerFailure> {
    server_failures()
        .as_ref()
        .and_then(|failures| failures.get(server_id))
        .cloned()
}

#[cfg(test)]
pub(crate) fn remember_failure_for_test(server_id: &str, failure: MyServerFailure) {
    let mut failures = server_failures();
    failures
        .get_or_insert_with(HashMap::new)
        .insert(server_id.to_string(), failure);
}

/// 测试用：走和真实响应相同的记录路径（含事件）。
#[cfg(test)]
pub(crate) fn remember_order_for_test(order: MyServerOrder) {
    let previous = remembered_order(&order.order_id).map(|order| order.state);
    remember_order(&order);
    record_order_event(&order, previous.as_deref());
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
        charge_mode: raw
            .charge_mode
            .or_else(|| fallback.map(|order| order.charge_mode.clone()))
            .unwrap_or_else(default_charge_mode),
    };
    validate_state(&order.charge_mode, &CHARGE_MODES, "扣费口径")?;
    let previous_state = remembered_order(&order.order_id).map(|order| order.state);
    remember_order(&order);
    record_order_event(&order, previous_state.as_deref());
    Ok(order)
}

fn parse_order(raw: Value) -> Result<RawOrder, CpError> {
    serde_json::from_value(raw).map_err(|_| CpError::invalid_response("订单响应格式不正确"))
}

/// 拉取控制面的服务器列表；**不碰本地缓存**。
///
/// 拆出来给后台轮询用：那边要先看「哪台刚变成 destroyed、是不是正在连着」，
/// 才能在落库发事件之前停运行时。缓存与事件统一走 [`cache_all`]。
pub(crate) async fn fetch_all() -> Result<ServerList, CpError> {
    let client = ControlPlane::new()?;
    let raw = client.get("/v1/servers").await?;
    parse_server_list(&raw)
}

/// 解析 `GET /v1/servers` 的响应体。逐条宽松：单条坏条目跳过，不整页失败。
fn parse_server_list(raw: &Value) -> Result<ServerList, CpError> {
    let values = raw
        .get("servers")
        .and_then(Value::as_array)
        .ok_or_else(|| CpError::invalid_response("服务器列表响应缺少 servers"))?;
    let mut servers = Vec::with_capacity(values.len());
    let mut dropped = 0usize;
    for value in values {
        let Ok(mut server) = serde_json::from_value::<MyServer>(value.clone()) else {
            dropped += 1;
            continue;
        };
        if validate_server(&mut server).is_err() {
            dropped += 1;
            continue;
        }
        remember_server_failure(&server);
        servers.push(server);
    }
    if dropped > 0 {
        log::warn!(
            "服务器列表有 {dropped} 条无法解析，已跳过；这份快照不完整，不做镜像收敛"
        );
    }
    Ok(ServerList {
        servers,
        traffic_pool: parse_traffic_pool(raw.get("traffic_pool")),
        complete: dropped == 0,
    })
}

/// `traffic_pool` 整体缺失或不是对象时视为「控制面没给」；对象内的字段缺失按 0，
/// 但两个键都认不出来时也按没给——空对象不等于「额度 0」。
fn parse_traffic_pool(value: Option<&Value>) -> Option<TrafficPool> {
    let pool = value?.as_object()?;
    let used = pool.get("used_bytes").and_then(Value::as_u64);
    let limit = pool.get("limit_bytes").and_then(Value::as_u64);
    if used.is_none() && limit.is_none() {
        return None;
    }
    Some(TrafficPool {
        used_bytes: used.unwrap_or(0),
        limit_bytes: limit.unwrap_or(0),
    })
}

/// 把一次列表快照写进本地镜像，状态变了就发 `my-server-changed`。
///
/// 读路径也会顺带维护缓存，这是有意的：一次成功的列表响应是唯一能判断
/// 「云端已无这台服务器」的完整快照；落库与收敛必须共用同一个连接，
/// 否则并发 list 的旧快照可能删掉新快照刚建的行。
pub(crate) fn cache_all(servers: &mut [MyServer], prune: bool) {
    let Some(store) = crate::store::global() else {
        return;
    };
    let conn = store.conn();
    for server in servers.iter_mut() {
        cache_and_link(&conn, server);
    }
    // 有条目被跳过时这份列表不是完整快照，「云端已无这台服务器」无从判断，
    // 此时只做 upsert、不删行。
    if !prune {
        return;
    }
    let ids: Vec<&str> = servers
        .iter()
        .map(|server| server.server_id.as_str())
        .collect();
    if let Err(error) = crate::store::servers::retain_only(&conn, &ids) {
        log::warn!("收敛我的服务器镜像失败：{error}");
    }
}

/// 列表 + 账号级流量池；命令层用它，同步流程只用列表。
pub async fn list_with_pool() -> Result<ServerList, CpError> {
    let mut list = fetch_all().await?;
    cache_all(&mut list.servers, list.complete);
    Ok(list)
}

pub async fn list() -> Result<Vec<MyServer>, CpError> {
    Ok(list_with_pool().await?.servers)
}

/// 列表里缺失的 owned 节点：`source_key` 不在本次列表里，可能服务器已经没了。
pub(crate) struct OrphanOwnedNode {
    pub node_id: String,
    pub server_id: String,
    pub password_ref: String,
}

/// 本地所有 `source = 'owned'` 且 `source_key` 非空、但不在本次列表里的节点。
///
/// 正常情况下不会有：只有「销毁请求超时/断网、控制面其实已经删了」才会留下。
pub(crate) fn orphan_owned_nodes(
    conn: &rusqlite::Connection,
    listed: &[String],
) -> Vec<OrphanOwnedNode> {
    let Ok(nodes) =
        crate::store::configs::list_nodes_by_source(conn, crate::store::configs::SOURCE_OWNED)
    else {
        return Vec::new();
    };
    nodes
        .into_iter()
        .filter(|node| !node.source_key.is_empty())
        .filter(|node| !listed.iter().any(|id| id == &node.source_key))
        .map(|node| OrphanOwnedNode {
            node_id: node.id,
            server_id: node.source_key,
            password_ref: node.password_ref,
        })
        .collect()
}

/// 详情确认这台服务器确实没了：`destroyed`，或控制面明确 404（已不存在）。
/// 网络失败不算——可能只是列表口径问题，节点要保留。
pub(crate) fn server_is_gone(result: &Result<MyServer, CpError>) -> bool {
    match result {
        Ok(server) => server.state == "destroyed",
        Err(error) => error.code == "NOT_FOUND",
    }
}

/// 删掉一个确认没了的 owned 节点：密码 + 节点行（外键级联清配置绑定与
/// `current_node_id`），成功则发 `node-list-changed`（`node_deleted`）。
pub(crate) fn forget_gone_owned_node(
    store: &crate::store::Store,
    orphan: &OrphanOwnedNode,
) -> bool {
    let _ = crate::secrets::delete_secret(&orphan.password_ref);
    let removed = {
        let conn = store.conn();
        crate::store::configs::delete_node(&conn, &orphan.node_id).unwrap_or(false)
    };
    if removed {
        // 连接释放后再发事件：`emit_node_list_changed` 会再拿同一把库锁。
        crate::seed::emit_node_list_changed(
            store,
            "node_deleted",
            None,
            std::slice::from_ref(&orphan.node_id),
        );
    }
    removed
}

/// 用户忽略「余额不足停机」留下的墓碑（`POST /v1/servers/{id}/dismiss`，204）。
pub async fn dismiss(server_id: &str) -> Result<(), CpError> {
    let client = ControlPlane::new()?;
    client
        .post(&format!("/v1/servers/{server_id}/dismiss"), None, None)
        .await
        .map(|_| ())
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
    remember_server_failure(&server);
    if let Some(store) = crate::store::global() {
        let conn = store.conn();
        cache_and_link(&conn, &mut server);
    }
    Ok(server)
}

/// 服务器创建记录（`GET /v1/servers/{id}/events`，commands.md §7.31）。
///
/// 只读控制面历史：不落本地库、不缓存、不发事件。
pub async fn events(server_id: &str) -> Result<MyServerEvents, CpError> {
    let client = ControlPlane::new()?;
    let raw = client
        .get(&format!("/v1/servers/{server_id}/events"))
        .await?;
    serde_json::from_value(raw)
        .map_err(|_| CpError::invalid_response("服务器创建记录格式不正确"))
}

/// 改服务器名（`PATCH /v1/servers/{id}`）：只能改自己的，允许重名。
pub async fn rename(server_id: &str, name: &str) -> Result<MyServer, CpError> {
    let client = ControlPlane::new()?;
    let raw = client
        .patch(
            &format!("/v1/servers/{server_id}"),
            Some(&json!({ "name": name })),
        )
        .await?;
    let mut server: MyServer = serde_json::from_value(raw)
        .map_err(|_| CpError::invalid_response("服务器重命名响应格式不正确"))?;
    validate_server(&mut server)?;
    remember_server_failure(&server);
    if let Some(store) = crate::store::global() {
        let conn = store.conn();
        cache_and_link(&conn, &mut server);
        // 连接页读的是本地节点行，改名必须跟着落到 `nodes.name`；
        // 只改展示字段，不重建配置、不碰运行时。节点还没落地（没取过凭据）就跳过——
        // 首次取凭据时用的就是改名后的服务器名。
        if let Some(node_id) = server.local_node_id.as_deref() {
            if let Err(error) = crate::store::configs::rename_node(&conn, node_id, &server.name) {
                log::warn!("同步节点名失败：{error}");
            }
        }
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

/// 确认下单（2.39.0）：控制面只建机、不扣费，就绪后由 enroll 结算第 0 天。
///
/// 余额门槛（日价 × 7）仍由控制面在预检时判定；不足时返回
/// `PRECONDITION_FAILED / insufficient_balance`（带 `required_cents` /
/// `shortfall_cents` / `min_days`），Host 原样透出。返回 `MyServerOrder`。
pub async fn checkout(order_id: &str) -> Result<MyServerOrder, CpError> {
    let client = ControlPlane::new()?;
    let raw = client
        .post(
            &format!("/v1/orders/{order_id}/checkout"),
            None,
            Some(&new_idempotency_key()),
        )
        .await?;
    let order = merge_order(parse_order(raw)?, order_id, remembered_order(order_id).as_ref(), None, None)?;
    super::events::emit_order_changed(&order);
    Ok(order)
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
    match (wallet.min_topup_cents, wallet.max_topup_cents) {
        (Some(min), Some(max)) => {
            if min < 100 || max < min {
                return Err(CpError::invalid_response("充值范围不合法"));
            }
        }
        // 两者必须同时出现；缺一个就都按未提供处理，客户端用自己的兜底值。
        _ => {
            wallet.min_topup_cents = None;
            wallet.max_topup_cents = None;
        }
    }
    if wallet.currency.trim().is_empty() {
        wallet.currency = default_currency();
    }
    wallet.updated_at = now_iso();
    Ok(wallet)
}

/// 创建充值会话（`POST /v1/topups`）。面额是整数美分；只有 Dodo 一条通道。
pub async fn topup(denomination_cents: i64) -> Result<MyServerTopup, CpError> {
    if denomination_cents <= 0 {
        return Err(CpError::new(
            "PRECONDITION_FAILED",
            "充值面额不合法",
            false,
            json!({ "reason": "invalid_denomination" }),
        ));
    }
    let client = ControlPlane::new()?;
    let body = json!({ "denomination_cents": denomination_cents });
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
        .post_with_timeout(
            &format!("/v1/servers/{server_id}/destroy"),
            Some(&json!({ "confirm": true })),
            Some(&new_idempotency_key()),
            DESTROY_TIMEOUT,
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
    // 销毁即销毁凭据（§19.8）。节点也一并删掉：已销毁的服务器不再出现在连接页
    // （2026-11-19 产品决定）。删 `nodes` 行由外键级联清掉 `config_nodes`、把
    // `configs.current_node_id` / `my_servers.node_id` 置 NULL（外键已 ON）。
    //
    // **不要**指望远端起效后隧道自己断：远端机器已经没了，本地 sing-box 不知道，
    // 会继续把流量发给一个不存在的节点（真机实测：状态栏仍「已连接」，而
    // `current_node_id` 已被外键置 NULL，用户没有任何断开入口）。所以命令层在销毁
    // 成功后，若这台服务器正是当前连接节点，先 `runtime_stop(false)`。
    if let Some(store) = crate::store::global() {
        let removed_node_id = {
            let conn = store.conn();
            cache_and_link(&conn, &mut server);
            forget_destroyed_node(&conn, &mut server)
        };
        // 连接释放后再发事件：`emit_node_list_changed` 会再拿同一把库锁。
        if let Some(node_id) = removed_node_id {
            crate::seed::emit_node_list_changed(
                store,
                "node_deleted",
                None,
                std::slice::from_ref(&node_id),
            );
        }
    } else if let Some(node_id) = server.node_id.as_deref() {
        let _ = crate::secrets::delete_secret(&format!("node:{node_id}"));
    }
    Ok(server)
}

/// 这台服务器的本地节点是不是活动配置正在用的那个；命中的话返回节点 id。
///
/// 必须在控制面销毁**之前**调用：销毁成功会删掉节点行、`current_node_id` 被外键
/// 置 NULL，之后就无从判断要不要停运行时了。本地节点先看镜像行的 `node_id`，
/// 镜像行缺失时用 `(source = 'owned', source_key = server_id)` 兜底。
pub(crate) fn active_node_of_server(
    store: &crate::store::Store,
    server_id: &str,
) -> Option<String> {
    let conn = store.conn();
    let node_id = crate::store::servers::get(&conn, server_id)
        .ok()
        .flatten()
        .and_then(|row| row.node_id)
        .or_else(|| {
            crate::store::configs::find_node_by_source_key(
                &conn,
                crate::store::configs::SOURCE_OWNED,
                server_id,
            )
            .ok()
            .flatten()
            .map(|node| node.id)
        })?;
    let current = crate::store::configs::active(&conn)
        .ok()
        .flatten()
        .and_then(|config| config.current_node_id);
    (current.as_deref() == Some(node_id.as_str())).then_some(node_id)
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

/// 销毁成功后的本地收尾：删密码、删节点行，返回被删掉的节点 id（没删成返回 `None`）。
///
/// 删 `nodes` 行后外键会级联清掉 `config_nodes`、把 `current_node_id` /
/// `my_servers.node_id` 置 NULL。节点本来就不存在时 `delete_node` 返回 false，
/// 这里按正常情形处理（幂等）。删除失败只记日志——钱已经退了，
/// 不能因为本地清理把销毁报成失败。
///
/// 事件不在这里发：调用方要先释放库连接，`emit_node_list_changed` 会再拿同一把锁。
fn forget_destroyed_node(
    conn: &rusqlite::Connection,
    server: &mut MyServer,
) -> Option<String> {
    forget_credentials(conn, &server.server_id, server.node_id.as_deref(), |key| {
        let _ = crate::secrets::delete_secret(key);
    });
    let node_id = server.local_node_id.clone()?;
    match crate::store::configs::delete_node(conn, &node_id) {
        Ok(true) => {
            server.local_node_id = None;
            Some(node_id)
        }
        Ok(false) => None,
        Err(error) => {
            log::warn!("销毁后删除本地节点失败：{error}");
            None
        }
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
            ready_at: None,
            installing_at: None,
            verifying_at: None,
            singbox_version: None,
            ip: None,
            port: None,
            node_id: None,
            local_node_id: None,
            hourly_usd: old.hourly_usd,
            monthly_usd: old.monthly_usd,
            daily_price_cents: old.daily_price_cents,
            transfer_gib: old.transfer_gib,
            // 流量按新机器的周期重新开始；下一次列表以控制面为准。
            traffic_used_bytes: 0,
            traffic_limit_bytes: 0,
            traffic_reset_at: String::new(),
            traffic_state: default_traffic_state(),
            // 新订单的钱还没结算，等下一次列表/详情以控制面为准。
            charged_cents: 0,
            refunded_cents: 0,
            // rebuild 是新的计费生命周期：第 0 天已扣，先按 1 天估算，
            // 下一次列表/详情以控制面为准。
            paid_until: Some(crate::store::iso_from_ms(
                crate::store::now_ms() + 24 * 3600 * 1000,
            )),
            billing_state: "active".into(),
            charge_mode: default_charge_mode(),
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
    let linked_before = local_server(server_id).and_then(|server| server.node_id);
    let port_before = local_node_snapshot(server_id).map(|(_, port, _)| port);

    // 锁只包「取回 → 验签 → 落库」：控制面慢时轮换与同步会排队，这是有意的代价，
    // 换来的是同一台不会被两路并发覆盖。发事件等后续逻辑放在锁外。
    let node = match super::credentials::with_credential_lock(async {
        let client = ControlPlane::new()?;
        let raw = client
            .post(&format!("/v1/servers/{server_id}/credentials"), None, None)
            .await?;
        let response = credential_response(&raw)?;
        super::credentials::verify_and_store(
            server_id,
            response.payload,
            response.signature,
            response.key_id,
        )
    })
    .await
    {
        Ok(node) => node,
        Err(error) => {
            log::warn!(
                "[my_server_credentials] server_id={server_id} status=failed code={} reason={}",
                error.code,
                error.reason().unwrap_or("unknown")
            );
            return Err(error);
        }
    };

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

    // 只比较端口，不打印端口值；第一次落库没有旧值时为 unknown。
    let port_changed = match (
        port_before,
        local_node_snapshot(server_id).map(|(_, port, _)| port),
    ) {
        (Some(before), Some(after)) => (before != after).to_string(),
        _ => "unknown".to_string(),
    };
    log::info!(
        "[my_server_credentials] server_id={server_id} status=ok port_changed={port_changed}"
    );

    // 只回本地节点：密码留在 `secrets.enc`，不再把含密码的 payload 交给界面。
    Ok(json!(node))
}

/// 同一时刻只允许一个整批同步（契约 §7.28）。
static SYNC_IN_FLIGHT: AtomicBool = AtomicBool::new(false);

/// 兜底释放并发闸：任务 panic 或提前返回都不会让同步永远「在跑」。
struct SyncGuard;

impl Drop for SyncGuard {
    fn drop(&mut self) {
        SYNC_IN_FLIGHT.store(false, Ordering::SeqCst);
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ServerSyncChanged {
    pub server_id: String,
    /// 本地节点行 id（不是控制面 node_id）。
    pub node_id: String,
    pub name: String,
    pub port_changed: bool,
    pub password_changed: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ServerSyncFailure {
    pub server_id: String,
    pub code: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ServerSyncData {
    pub servers: Vec<MyServer>,
    pub changed: Vec<ServerSyncChanged>,
    pub failed: Vec<ServerSyncFailure>,
}

/// 变化判定：给旧/新端口与密码，返回 `(port_changed, password_changed)`。
/// 本地原来没有节点行（首次落库）不算变化，由前端按 `local_node_id` 变化处理。
fn change_flags(
    old: Option<(u16, Option<String>)>,
    new: Option<(u16, Option<String>)>,
) -> (bool, bool) {
    match (old, new) {
        (Some((old_port, old_secret)), Some((new_port, new_secret))) => {
            (old_port != new_port, old_secret != new_secret)
        }
        _ => (false, false),
    }
}

/// 本地节点快照：row id、端口、密码值（只用于比较，永不外传或打日志）。
fn local_node_snapshot(server_id: &str) -> Option<(String, u16, Option<String>)> {
    let store = crate::store::global()?;
    let conn = store.conn();
    let node = crate::store::configs::find_node_by_source_key(
        &conn,
        crate::store::configs::SOURCE_OWNED,
        server_id,
    )
    .ok()
    .flatten()?;
    let secret = crate::secrets::get_secret(&node.password_ref)
        .ok()
        .flatten();
    Some((node.id, node.port, secret))
}

/// 同步成功且有变化时发的那一条事件；落地方式可注入（测试用记录器）。
trait SyncEvents: Send + Sync {
    fn node_list_changed(&self, changed_node_ids: &[String]);
}

struct HostSyncEvents;

impl SyncEvents for HostSyncEvents {
    fn node_list_changed(&self, changed_node_ids: &[String]) {
        if let Some(store) = crate::store::global() {
            crate::seed::emit_node_list_changed(
                store.as_ref(),
                "node_synced",
                None,
                changed_node_ids,
            );
        }
    }
}

/// 只发一条汇总；没有变化不发，也不逐台发 `my-server-changed`。
fn emit_sync_changes(events: &dyn SyncEvents, changed: &[ServerSyncChanged]) {
    if changed.is_empty() {
        return;
    }
    let ids: Vec<String> = changed.iter().map(|item| item.node_id.clone()).collect();
    events.node_list_changed(&ids);
}

/// 批量同步节点配置：先拉列表，再串行取每台可用服务器的凭据。
///
/// 单台失败进 `failed` 继续；列表失败整批返回（不写任何本地值）。
/// 不删行、不探测、不断开重连；有变化时只发一条 `node-list-changed` 汇总。
pub async fn sync_all() -> Result<ServerSyncData, CpError> {
    sync_with(
        &|| Box::pin(list()),
        &|server_id: String| Box::pin(async move { credentials(&server_id).await }),
        &HostSyncEvents,
    )
    .await
}

type SyncFuture<T> = std::pin::Pin<Box<dyn std::future::Future<Output = T> + Send>>;

/// 可注入的同步主体：列表与逐台凭据都由调用方给，生产入口传真实实现。
async fn sync_with(
    list: &(dyn Fn() -> SyncFuture<Result<Vec<MyServer>, CpError>> + Send + Sync),
    fetch_credentials: &(dyn Fn(String) -> SyncFuture<Result<Value, CpError>> + Send + Sync),
    events: &dyn SyncEvents,
) -> Result<ServerSyncData, CpError> {
    if SYNC_IN_FLIGHT.swap(true, Ordering::SeqCst) {
        return Err(CpError::new(
            "BUSY",
            "节点配置同步正在进行中",
            false,
            json!({ "reason": "sync_in_flight" }),
        ));
    }
    let _guard = SyncGuard;

    let mut servers = list().await?;
    let mut changed = Vec::new();
    let mut failed = Vec::new();

    for server in &mut servers {
        // 其余状态没有凭据可取；`node_id` 为空说明控制面还没准备好节点。
        if !matches!(server.state.as_str(), "active" | "healthy") || server.node_id.is_none() {
            continue;
        }
        let before = local_node_snapshot(&server.server_id);
        match fetch_credentials(server.server_id.clone()).await {
            Ok(node) => {
                let after = local_node_snapshot(&server.server_id);
                if let Some(node_id) = node.get("node_id").and_then(Value::as_str) {
                    server.local_node_id = Some(node_id.to_string());
                }
                let old = before
                    .as_ref()
                    .map(|(_, port, secret)| (*port, secret.clone()));
                let new = after
                    .as_ref()
                    .map(|(_, port, secret)| (*port, secret.clone()));
                let (port_changed, password_changed) = change_flags(old, new);
                if port_changed || password_changed {
                    if let Some(node_id) = after
                        .as_ref()
                        .map(|(id, _, _)| id.clone())
                        .or_else(|| server.local_node_id.clone())
                    {
                        changed.push(ServerSyncChanged {
                            server_id: server.server_id.clone(),
                            node_id,
                            name: server.name.clone(),
                            port_changed,
                            password_changed,
                        });
                    }
                }
            }
            Err(error) => {
                // 上游原文只进日志：`failed[]` 只带稳定码（§1.6 / §7.28）。
                log::warn!(
                    "节点配置同步失败：server={} code={} reason={} message={}",
                    server.server_id,
                    error.code,
                    error.reason().unwrap_or("-"),
                    crate::logging::truncate_for_log(&error.message)
                );
                failed.push(ServerSyncFailure {
                    server_id: server.server_id.clone(),
                    code: error.code,
                });
            }
        }
    }

    emit_sync_changes(events, &changed);

    Ok(ServerSyncData {
        servers,
        changed,
        failed,
    })
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
    let paid_until = match server.paid_until.as_deref() {
        Some(value) => match parse_iso_ms(value) {
            Some(value) => value,
            None => {
                log::warn!("缓存我的服务器失败：paid_until 不是 ISO 8601");
                return;
            }
        },
        // 结算前没有已付时刻：本地镜像用 0 表示，读回时还原成 null。
        None => 0,
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

/// 落库后把本地节点关联回填到返回结构里。
///
/// 用的是 `cache_server` 里同一个 `linked_node_id`，在落库之后对每台再算一次，
/// 保证返回结构里的值和本地镜像一致；`node_id` 保持控制面原值不动，只填 `local_node_id`。
fn cache_and_link(conn: &rusqlite::Connection, server: &mut MyServer) {
    cache_server(conn, server);
    server.local_node_id = linked_node_id(conn, &server.server_id, server.node_id.as_deref());
}

/// 本地镜像里的一条服务器（不联网）。`credentials` 刷新后由调用方拿去发事件。
pub(crate) fn local_server(server_id: &str) -> Option<MyServer> {
    let store = crate::store::global()?;
    let conn = store.conn();
    let row = crate::store::servers::get(&conn, server_id).ok().flatten()?;
    let node_id = linked_node_id(&conn, server_id, row.node_id.as_deref());
    Some(MyServer {
        server_id: row.id,
        name: row.name,
        region: row.region,
        plan: row.plan,
        state: row.state,
        created_at: crate::store::iso_from_ms(row.created_at),
        ready_at: None,
        installing_at: None,
        verifying_at: None,
        singbox_version: None,
        ip: None,
        port: None,
        node_id: node_id.clone(),
        // 本地兜底的这份里两个字段同值：镜像里能用的只有本地节点 id。
        local_node_id: node_id,
        hourly_usd: row.hourly_usd,
        monthly_usd: row.monthly_usd,
        daily_price_cents: row.daily_price_cents,
        transfer_gib: row.transfer_gib,
        // 本地镜像不存流量；拿不到远端时按「本周期没用过、额度未知」展示。
        traffic_used_bytes: 0,
        traffic_limit_bytes: 0,
        traffic_reset_at: String::new(),
        traffic_state: default_traffic_state(),
        // 本地缓存只存服务器状态，不存钱；拿不到远端时按「没扣过/没退过」展示。
        charged_cents: 0,
        refunded_cents: 0,
        paid_until: if row.paid_until > 0 {
            Some(crate::store::iso_from_ms(row.paid_until))
        } else {
            None
        },
        billing_state: row.billing_state.clone(),
        // 本地镜像不存扣费口径；旧口径即下单即扣，与 serde 缺省一致。
        charge_mode: default_charge_mode(),
        grace_ends_at: if row.billing_state == "active" || row.paid_until <= 0 {
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

    fn sample_server_json() -> serde_json::Value {
        json!({
            "server_id": "srv_1",
            "name": "Tokyo",
            "region": "tyo",
            "plan": "s-1vcpu-1gb",
            "state": "active",
            "created_at": "2026-11-14T08:00:00Z",
            "ip": null,
            "port": null,
            "node_id": null,
            "hourly_usd": 0.0,
            "monthly_usd": 6.0,
            "daily_price_cents": 20,
            "transfer_gib": 0,
            "paid_until": "2026-11-15T08:00:00Z",
            "billing_state": "active",
            "grace_ends_at": null,
            "failure": null
        })
    }

    #[test]
    fn traffic_fields_default_when_the_control_plane_is_old() {
        let list = parse_server_list(&json!({ "servers": [sample_server_json()] })).unwrap();
        assert_eq!(list.servers.len(), 1);
        let server = &list.servers[0];
        assert_eq!(server.traffic_used_bytes, 0);
        assert_eq!(server.traffic_limit_bytes, 0);
        assert_eq!(server.traffic_reset_at, "");
        assert_eq!(server.traffic_state, "ok");
        assert_eq!(list.traffic_pool, None);
        assert!(list.complete);
    }

    #[test]
    fn traffic_fields_accept_the_contract_and_normalize_junk() {
        let mut value = sample_server_json();
        value["traffic_used_bytes"] = json!(123_456_789_u64);
        value["traffic_limit_bytes"] = json!(1.5e9_f64);
        value["traffic_reset_at"] = json!("2026-12-01T00:00:00Z");
        value["traffic_state"] = json!("unpaid");

        let mut junk = sample_server_json();
        junk["server_id"] = json!("srv_2");
        junk["traffic_used_bytes"] = json!(-5);
        junk["traffic_limit_bytes"] = json!("nope");
        junk["traffic_reset_at"] = Value::Null;
        junk["traffic_state"] = json!("weird");

        let list = parse_server_list(&json!({ "servers": [value, junk] })).unwrap();
        assert_eq!(list.servers.len(), 2);
        assert_eq!(list.servers[0].traffic_used_bytes, 123_456_789);
        assert_eq!(list.servers[0].traffic_limit_bytes, 1_500_000_000);
        assert_eq!(list.servers[0].traffic_reset_at, "2026-12-01T00:00:00Z");
        assert_eq!(list.servers[0].traffic_state, "unpaid");
        assert_eq!(list.servers[1].traffic_used_bytes, 0);
        assert_eq!(list.servers[1].traffic_limit_bytes, 0);
        assert_eq!(list.servers[1].traffic_reset_at, "");
        assert_eq!(list.servers[1].traffic_state, "ok");
    }

    /// 单台只有 ok / unpaid。滚动升级期间旧控制面还会发 near / over，
    /// 它们必须降级成 ok，而不是让界面拿到一个已经不存在的状态。
    #[test]
    fn retired_traffic_states_degrade_to_ok() {
        let mut near = sample_server_json();
        near["traffic_state"] = json!("near");
        let mut over = sample_server_json();
        over["server_id"] = json!("srv_2");
        over["traffic_state"] = json!("over");
        let mut unpaid = sample_server_json();
        unpaid["server_id"] = json!("srv_3");
        unpaid["traffic_state"] = json!("unpaid");

        let list = parse_server_list(&json!({ "servers": [near, over, unpaid] })).unwrap();
        let states: Vec<&str> = list
            .servers
            .iter()
            .map(|server| server.traffic_state.as_str())
            .collect();
        assert_eq!(states, vec!["ok", "ok", "unpaid"]);
    }

    #[test]
    fn one_broken_entry_does_not_hide_the_rest() {
        let mut broken = sample_server_json();
        broken["server_id"] = json!("srv_2");
        broken["created_at"] = json!("not-a-date");

        let list =
            parse_server_list(&json!({ "servers": [sample_server_json(), broken] })).unwrap();
        assert_eq!(list.servers.len(), 1);
        assert_eq!(list.servers[0].server_id, "srv_1");
        assert!(!list.complete, "跳过了条目就不能拿这份快照做收敛");
    }

    #[test]
    fn the_account_traffic_pool_is_optional_and_lenient() {
        let raw = json!({
            "servers": [],
            "traffic_pool": { "used_bytes": 10, "limit_bytes": 20 }
        });
        assert_eq!(
            parse_server_list(&raw).unwrap().traffic_pool,
            Some(TrafficPool {
                used_bytes: 10,
                limit_bytes: 20
            })
        );
        let raw = json!({ "servers": [], "traffic_pool": { "used_bytes": 10 } });
        assert_eq!(
            parse_server_list(&raw).unwrap().traffic_pool,
            Some(TrafficPool {
                used_bytes: 10,
                limit_bytes: 0
            })
        );
        let raw = json!({ "servers": [], "traffic_pool": "nope" });
        assert_eq!(parse_server_list(&raw).unwrap().traffic_pool, None);
        let raw = json!({ "servers": [], "traffic_pool": {} });
        assert_eq!(parse_server_list(&raw).unwrap().traffic_pool, None);
        let raw = json!({ "servers": [] });
        assert_eq!(parse_server_list(&raw).unwrap().traffic_pool, None);
    }

    #[test]
    fn a_failure_without_stage_falls_back_to_the_server_state() {
        // 旧镜像没有 stage：解析留空，记住时用服务器当前状态补齐，不能凭空写成 active。
        let failure: MyServerFailure = serde_json::from_str(
            r#"{"code":"service_inactive","message":"没起来","retryable":false}"#,
        )
        .unwrap();
        assert!(failure.stage.is_empty());

        let mut value = sample_server_json();
        value["failure"] = json!({
            "stage": "",
            "code": "service_inactive",
            "message": "没起来",
            "retryable": false
        });
        let server: MyServer = serde_json::from_value(value).unwrap();
        remember_server_failure(&server);
        assert_eq!(server_failure("srv_1").map(|f| f.stage), Some("active".into()));
    }

    #[test]
    fn stage_timestamps_are_optional_and_pass_through() {
        let mut value = sample_server_json();
        value["installing_at"] = json!("2026-11-18T07:00:00Z");
        value["verifying_at"] = json!("2026-11-18T07:02:00Z");
        let parsed: MyServer = serde_json::from_value(value).unwrap();
        assert_eq!(parsed.installing_at.as_deref(), Some("2026-11-18T07:00:00Z"));
        assert_eq!(parsed.verifying_at.as_deref(), Some("2026-11-18T07:02:00Z"));

        // 缺字段（旧控制面）按 null。
        let parsed: MyServer = serde_json::from_value(sample_server_json()).unwrap();
        assert!(parsed.installing_at.is_none());
        assert!(parsed.verifying_at.is_none());
    }

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
            ready_at: None,
            installing_at: None,
            verifying_at: None,
            singbox_version: None,
            ip: None,
            port: None,
            node_id: None,
            local_node_id: None,
            hourly_usd: 0.009,
            monthly_usd: 6.0,
            daily_price_cents: 20,
            transfer_gib: 1000,
            traffic_used_bytes: 0,
            traffic_limit_bytes: 0,
            traffic_reset_at: String::new(),
            traffic_state: default_traffic_state(),
            charged_cents: 0,
            refunded_cents: 0,
            paid_until: Some("2026-11-15T08:00:00Z".into()),
            billing_state: "active".into(),
            charge_mode: default_charge_mode(),
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
    fn billing_fields_are_required_and_paid_until_is_nullable_only_when_pending() {
        let mut server: MyServer = serde_json::from_value(a_server_json()).unwrap();
        assert!(validate_server(&mut server).is_ok());
        assert_eq!(server.daily_price_cents, 20);
        assert_eq!(server.transfer_gib, 1000);
        assert_eq!(server.paid_until.as_deref(), Some("2026-11-15T08:00:00Z"));
        assert_eq!(server.billing_state, "active");
        // active 没有宽限期：即使上游误发也要清掉。
        server.grace_ends_at = Some("2026-11-22T08:00:00Z".into());
        assert!(validate_server(&mut server).is_ok());
        assert!(server.grace_ends_at.is_none());

        for field in ["daily_price_cents", "transfer_gib", "billing_state"] {
            let mut value = a_server_json();
            value.as_object_mut().unwrap().remove(field);
            assert!(
                serde_json::from_value::<MyServer>(value).is_err(),
                "{field} 缺失必须解析失败"
            );
        }

        // 2.39.0：pending（结算前）允许 paid_until = null，且不派生宽限期。
        let mut value = a_server_json();
        value["paid_until"] = Value::Null;
        value["billing_state"] = json!("pending");
        let mut pending: MyServer = serde_json::from_value(value).unwrap();
        assert!(validate_server(&mut pending).is_ok());
        assert!(pending.grace_ends_at.is_none());

        // 其它状态没有已付时刻是契约违约，不能被当成没付过费。
        let mut value = a_server_json();
        value["paid_until"] = Value::Null;
        let mut active: MyServer = serde_json::from_value(value).unwrap();
        assert_eq!(
            validate_server(&mut active).unwrap_err().reason(),
            Some("invalid_response")
        );
    }

    #[test]
    fn charge_mode_defaults_to_upfront_and_settle_failure_keeps_its_code() {
        // 旧响应完全没有 charge_mode：按建行即扣解析，不能因此整条失败。
        let mut server: MyServer = serde_json::from_value(a_server_json()).unwrap();
        assert_eq!(server.charge_mode, "upfront");
        assert!(validate_server(&mut server).is_ok());

        // 列可空：显式 null 同样按 upfront。
        let mut value = a_server_json();
        value["charge_mode"] = Value::Null;
        let mut server: MyServer = serde_json::from_value(value).unwrap();
        assert_eq!(server.charge_mode, "upfront");
        assert!(validate_server(&mut server).is_ok());

        // 新控制面的就绪后结算：原样透出。
        let mut value = a_server_json();
        value["charge_mode"] = json!("at_ready");
        let mut server: MyServer = serde_json::from_value(value).unwrap();
        assert!(validate_server(&mut server).is_ok());
        assert_eq!(server.charge_mode, "at_ready");

        // 状态不认识就让这一条失败，而不是按错误口径展示。
        let mut value = a_server_json();
        value["charge_mode"] = json!("prepaid");
        let mut server: MyServer = serde_json::from_value(value).unwrap();
        assert_eq!(
            validate_server(&mut server).unwrap_err().reason(),
            Some("invalid_response")
        );

        // 结算失败：服务器只有 pending 计费字段，failure.code 必须原样交给界面。
        let mut value = a_server_json();
        value["paid_until"] = Value::Null;
        value["billing_state"] = json!("pending");
        value["charge_mode"] = json!("at_ready");
        value["failure"] = json!({
            "stage": "active",
            "code": "settle_insufficient",
            "message": "这台服务器没有创建成功",
            "retryable": false,
        });
        let mut server: MyServer = serde_json::from_value(value).unwrap();
        assert!(validate_server(&mut server).is_ok());
        assert!(server.grace_ends_at.is_none());
        assert_eq!(
            server.failure.as_ref().map(|failure| failure.code.as_str()),
            Some("settle_insufficient")
        );
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
            charge_mode: default_charge_mode(),
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
    fn a_checkout_response_is_an_order_not_a_charge() {
        // 2.39.0：checkout 返回 MyServerOrder（state = provisioning），没有扣费金额。
        let raw = parse_order(json!({
            "order_id": "ord_1",
            "state": "provisioning",
            "region": "sgp1",
            "plan": "s-1vcpu-1gb",
            "amount_usd": 0.3,
            "server_id": "srv_1"
        }))
        .unwrap();
        let order = merge_order(raw, "ord_1", None, None, None).unwrap();
        assert_eq!(order.state, "provisioning");
        assert_eq!(order.server_id.as_deref(), Some("srv_1"));

        // 旧字段被忽略，不会让解析失败，也不会再造出扣费类型。
        let raw = parse_order(json!({ "state": "provisioning", "charged_cents": 30 })).unwrap();
        assert!(merge_order(raw, "ord_2", None, None, None).is_ok());
    }

    #[test]
    fn an_order_carries_charge_mode_and_settle_failure() {
        // 旧响应没有 charge_mode：按 upfront。
        let raw = parse_order(json!({ "state": "provisioning" })).unwrap();
        let order = merge_order(raw, "ord_old", None, None, None).unwrap();
        assert_eq!(order.charge_mode, "upfront");

        // 显式 null 也按 upfront（旧订单列可空）。
        let raw = parse_order(json!({ "state": "provisioning", "charge_mode": null })).unwrap();
        let order = merge_order(raw, "ord_null", None, None, None).unwrap();
        assert_eq!(order.charge_mode, "upfront");

        // 就绪后结算 + 结算失败：两个字段都要到界面。
        let raw = parse_order(json!({
            "order_id": "ord_settle",
            "state": "failed",
            "charge_mode": "at_ready",
            "failure": {
                "code": "settle_insufficient",
                "message": "服务器没建成，这笔订单已结束，没有产生服务器",
                "retryable": false
            }
        }))
        .unwrap();
        let order = merge_order(raw, "ord_settle", None, None, None).unwrap();
        assert_eq!(order.charge_mode, "at_ready");
        let failure = order.failure.expect("失败订单必须带 failure");
        assert_eq!(failure.code, "settle_insufficient");
        assert!(!failure.retryable);

        // 不认识的口径不让订单静默按错误含义展示。
        let raw = parse_order(json!({ "state": "provisioning", "charge_mode": "prepaid" })).unwrap();
        assert!(merge_order(raw, "ord_weird", None, None, None).is_err());
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
    fn a_wallet_response_carries_optional_topup_range() {
        // 缺失：两者都 None，序列化时两个 key 都不出现。
        let wallet = parse_wallet(json!({ "balance_cents": 0 })).unwrap();
        assert_eq!(wallet.min_topup_cents, None);
        assert_eq!(wallet.max_topup_cents, None);
        let value = serde_json::to_value(&wallet).unwrap();
        assert!(value.get("min_topup_cents").is_none());
        assert!(value.get("max_topup_cents").is_none());

        // 合法。
        let wallet = parse_wallet(json!({
            "balance_cents": 0,
            "min_topup_cents": 600,
            "max_topup_cents": 30000,
        }))
        .unwrap();
        assert_eq!(wallet.min_topup_cents, Some(600));
        assert_eq!(wallet.max_topup_cents, Some(30000));
        let value = serde_json::to_value(&wallet).unwrap();
        assert_eq!(value["min_topup_cents"], 600);
        assert_eq!(value["max_topup_cents"], 30000);

        // 只给一个：都按未提供处理。
        let wallet = parse_wallet(json!({
            "balance_cents": 0,
            "min_topup_cents": 600,
        }))
        .unwrap();
        assert_eq!(wallet.min_topup_cents, None);
        assert_eq!(wallet.max_topup_cents, None);

        // 非法范围。
        assert!(parse_wallet(json!({
            "balance_cents": 0,
            "min_topup_cents": 50,
            "max_topup_cents": 30000,
        }))
        .is_err());
        assert!(parse_wallet(json!({
            "balance_cents": 0,
            "min_topup_cents": 600,
            "max_topup_cents": 500,
        }))
        .is_err());
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

        // 收银台地址缺失时仍按响应解析；响应自带面额时以响应为准。
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
    fn a_server_events_payload_keeps_whitelisted_fields_and_drops_the_rest() {
        let events: MyServerEvents = serde_json::from_value(json!({
            "events": [
                {
                    "at": 1763000000000i64,
                    "code": "destroyed",
                    "count": 3,
                    "version": "1.14.4",
                    "amount_cents": 1200,
                    "reason": "billing_unpaid",
                    "detail": "上游原文不该下发",
                    "provider_id": 123456,
                    "log_excerpt": "x"
                }
            ],
            "has_more": true,
            "unknown": "ignored"
        }))
        .unwrap();

        assert!(events.has_more);
        assert_eq!(events.events.len(), 1);
        let event = &events.events[0];
        assert_eq!(event.at, 1_763_000_000_000);
        assert_eq!(event.code, "destroyed");
        assert_eq!(event.count, Some(3));
        assert_eq!(event.version.as_deref(), Some("1.14.4"));
        assert_eq!(event.amount_cents, Some(1200));
        assert_eq!(event.reason.as_deref(), Some("billing_unpaid"));

        // 透传给 UI 的只有契约字段：未知字段不会被带出去。
        let out = serde_json::to_value(&events).unwrap();
        assert!(out["events"][0].get("detail").is_none(), "{out}");
        assert!(out["events"][0].get("provider_id").is_none(), "{out}");
        assert!(out["events"][0].get("log_excerpt").is_none(), "{out}");
        assert!(out.get("unknown").is_none(), "{out}");
    }

    #[test]
    fn an_empty_server_events_list_keeps_has_more_false() {
        let events: MyServerEvents =
            serde_json::from_value(json!({ "events": [], "has_more": false })).unwrap();
        assert!(events.events.is_empty());
        assert!(!events.has_more);

        // 可选字段缺省：只出现该事件类型真正带的那几个。
        let events: MyServerEvents = serde_json::from_value(json!({
            "events": [{ "at": 1763000000000i64, "code": "order.confirmed" }],
            "has_more": false
        }))
        .unwrap();
        let event = &events.events[0];
        assert_eq!(event.code, "order.confirmed");
        assert!(event.count.is_none());
        assert!(event.version.is_none());
        assert!(event.amount_cents.is_none());
        assert!(event.reason.is_none());

        // 契约：可选字段「只在该事件类型下出现」，不能序列化成 null。
        let out = serde_json::to_value(&events).unwrap();
        let event = out["events"][0].as_object().unwrap();
        for field in ["count", "version", "amount_cents", "reason"] {
            assert!(!event.contains_key(field), "{field} 不应出现：{out}");
        }
        assert_eq!(event.len(), 2, "{out}");
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

    fn owned_server(local_node_id: Option<&str>) -> MyServer {
        let mut value = sample_server_json();
        value["node_id"] = json!("nd_abc");
        if let Some(id) = local_node_id {
            value["local_node_id"] = json!(id);
        }
        serde_json::from_value(value).unwrap()
    }

    /// 销毁后的本地收尾：节点行删掉，配置关联级联清空，当前节点置 NULL。
    #[test]
    fn destroying_a_server_deletes_its_node_and_bindings() {
        let store = crate::store::Store::open_in_memory().unwrap();
        let conn = store.conn();
        let dns = json!({ "mode": "auto", "local": [], "remote": [] });
        let excludes = json!([]);
        crate::store::configs::create(
            &conn,
            &crate::store::NewConfig {
                id: "cfg_1",
                name: "A",
                connection_mode: crate::store::configs::CONNECTION_SYSTEM_PROXY,
                routing_mode: crate::store::configs::ROUTING_PROXY_ALL,
                listen_port: Some(7890),
                dns: &dns,
                tun_excludes: &excludes,
            },
        )
        .unwrap();
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
        crate::store::configs::attach_node(&conn, "cfg_1", "nd_local").unwrap();
        crate::store::configs::update(
            &conn,
            "cfg_1",
            &crate::store::configs::ConfigPatch {
                current_node_id: Some(Some("nd_local".into())),
                ..Default::default()
            },
        )
        .unwrap();

        let mut server = owned_server(Some("nd_local"));
        assert_eq!(
            forget_destroyed_node(&conn, &mut server).as_deref(),
            Some("nd_local")
        );

        assert!(crate::store::configs::get_node(&conn, "nd_local")
            .unwrap()
            .is_none());
        assert!(crate::store::configs::list_nodes(&conn, "cfg_1")
            .unwrap()
            .is_empty());
        assert_eq!(
            crate::store::configs::get(&conn, "cfg_1")
                .unwrap()
                .unwrap()
                .current_node_id,
            None
        );
        assert_eq!(server.local_node_id, None);
    }

    /// 节点本来就不存在（或已经删过）：幂等，不报错、不改返回值。
    #[test]
    fn destroying_a_server_without_a_local_node_is_idempotent() {
        let store = crate::store::Store::open_in_memory().unwrap();
        let conn = store.conn();
        let mut server = owned_server(Some("nd_missing"));
        assert_eq!(forget_destroyed_node(&conn, &mut server), None);
    }

    fn seed_owned_node(conn: &rusqlite::Connection, id: &str, server_id: &str) {
        crate::store::configs::upsert_node(
            conn,
            &crate::store::NewNode {
                id,
                name: "Tokyo",
                server: "203.0.113.10",
                port: 20343,
                method: "aes-256-gcm",
                password_ref: &format!("node:{id}"),
                source: crate::store::configs::SOURCE_OWNED,
                source_key: server_id,
            },
        )
        .unwrap();
    }

    fn seed_mirror(conn: &rusqlite::Connection, server_id: &str, node_id: Option<&str>) {
        crate::store::servers::upsert(
            conn,
            &crate::store::NewMyServer {
                id: server_id,
                provider: "digitalocean",
                name: "Tokyo",
                region: "sgp1",
                plan: "basic",
                state: "active",
                node_id,
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

    fn seed_active_config(
        conn: &rusqlite::Connection,
        current: Option<&str>,
        attached: &[&str],
    ) {
        let dns = json!({ "mode": "auto", "local": [], "remote": [] });
        let excludes = json!([]);
        crate::store::configs::create(
            conn,
            &crate::store::NewConfig {
                id: "cfg_1",
                name: "A",
                connection_mode: crate::store::configs::CONNECTION_SYSTEM_PROXY,
                routing_mode: crate::store::configs::ROUTING_PROXY_ALL,
                listen_port: Some(7890),
                dns: &dns,
                tun_excludes: &excludes,
            },
        )
        .unwrap();
        crate::store::configs::activate(conn, "cfg_1").unwrap();
        for id in attached {
            crate::store::configs::attach_node(conn, "cfg_1", id).unwrap();
        }
        if let Some(current) = current {
            crate::store::configs::update(
                conn,
                "cfg_1",
                &crate::store::configs::ConfigPatch {
                    current_node_id: Some(Some(current.into())),
                    ..Default::default()
                },
            )
            .unwrap();
        }
    }

    /// 销毁前判断：这台服务器就是当前连接节点。
    #[test]
    fn a_server_that_is_the_current_node_is_reported() {
        let store = crate::store::Store::open_in_memory().unwrap();
        {
            let conn = store.conn();
            seed_owned_node(&conn, "nd_a", "srv_1");
            seed_mirror(&conn, "srv_1", Some("nd_a"));
            seed_active_config(&conn, Some("nd_a"), &["nd_a"]);
        }
        assert_eq!(
            active_node_of_server(&store, "srv_1").as_deref(),
            Some("nd_a")
        );
    }

    /// 当前节点是另一台服务器：不能停隧道。
    #[test]
    fn a_server_whose_node_is_not_current_is_not_reported() {
        let store = crate::store::Store::open_in_memory().unwrap();
        {
            let conn = store.conn();
            seed_owned_node(&conn, "nd_a", "srv_1");
            seed_owned_node(&conn, "nd_b", "srv_2");
            seed_mirror(&conn, "srv_1", Some("nd_a"));
            seed_active_config(&conn, Some("nd_b"), &["nd_a", "nd_b"]);
        }
        assert_eq!(active_node_of_server(&store, "srv_1"), None);
    }

    /// 这台服务器还没有本地节点行：无从判断，返回 None。
    #[test]
    fn a_server_without_a_local_node_is_not_reported() {
        let store = crate::store::Store::open_in_memory().unwrap();
        {
            let conn = store.conn();
            seed_active_config(&conn, None, &[]);
        }
        assert_eq!(active_node_of_server(&store, "srv_1"), None);
    }

    /// 镜像行缺失/没有 `node_id` 时，靠 `source_key` 找到本地节点。
    #[test]
    fn a_missing_mirror_node_id_falls_back_to_the_owned_node() {
        let store = crate::store::Store::open_in_memory().unwrap();
        {
            let conn = store.conn();
            seed_owned_node(&conn, "nd_a", "srv_1");
            seed_mirror(&conn, "srv_1", None);
            seed_active_config(&conn, Some("nd_a"), &["nd_a"]);
        }
        assert_eq!(
            active_node_of_server(&store, "srv_1").as_deref(),
            Some("nd_a")
        );
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

    /// active 的机器控制面已经给了 `nd_…`，但本地还没有节点行：
    /// 必须能从返回里看出「要去取凭据」，并且 `node_id` 仍是控制面 id。
    #[test]
    fn an_active_server_without_a_local_node_row_still_needs_credentials() {
        let store = crate::store::Store::open_in_memory().unwrap();
        let conn = store.conn();
        let mut value = sample_server_json();
        value["state"] = json!("active");
        value["node_id"] = json!("nd_abc");
        let mut server: MyServer = serde_json::from_value(value).unwrap();

        cache_and_link(&conn, &mut server);

        assert_eq!(server.local_node_id, None);
        assert_eq!(server.node_id.as_deref(), Some("nd_abc"));
        let returned = serde_json::to_value(&server).unwrap();
        assert!(returned["local_node_id"].is_null(), "{returned}");
        assert_eq!(returned["node_id"], json!("nd_abc"));
    }

    /// 取过凭据（`persist_with` 建本地节点行）之后，同一条列表响应就带上本地节点 id。
    #[test]
    fn getting_credentials_fills_the_local_node_id_on_the_next_list() {
        let store = crate::store::Store::open_in_memory().unwrap();
        let conn = store.conn();
        let mut value = sample_server_json();
        value["state"] = json!("active");
        value["node_id"] = json!("nd_abc");
        let mut before: MyServer = serde_json::from_value(value.clone()).unwrap();
        cache_and_link(&conn, &mut before);
        assert_eq!(before.local_node_id, None);

        // 与 `persist_with` 同形：本机建的节点行，`source_key` = server_id。
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

        // 下一次列表：控制面给同一条响应，重新解析后走同一条回填路径。
        let mut after: MyServer = serde_json::from_value(value).unwrap();
        cache_and_link(&conn, &mut after);
        assert_eq!(after.local_node_id.as_deref(), Some("nd_local"));
        assert_eq!(after.node_id.as_deref(), Some("nd_abc"));
        let returned = serde_json::to_value(&after).unwrap();
        assert_eq!(returned["local_node_id"], json!("nd_local"));
    }
}

#[cfg(test)]
mod orphan_tests {
    use super::*;
    use std::sync::Arc;

    fn store_with_nodes() -> crate::store::Store {
        let store = crate::store::Store::open_in_memory().unwrap();
        {
            let conn = store.conn();
            for (id, server_id) in [("nd_a", "srv_1"), ("nd_b", "srv_2")] {
                crate::store::configs::upsert_node(
                    &conn,
                    &crate::store::NewNode {
                        id,
                        name: "Tokyo",
                        server: "203.0.113.10",
                        port: 20343,
                        method: "aes-256-gcm",
                        password_ref: &format!("node:{id}"),
                        source: crate::store::configs::SOURCE_OWNED,
                        source_key: server_id,
                    },
                )
                .unwrap();
            }
        }
        store
    }

    /// 只在列表里缺失的 owned 节点才是残留；列表里有就不管。
    #[test]
    fn only_owned_nodes_missing_from_the_list_are_orphans() {
        let store = store_with_nodes();
        let conn = store.conn();
        let orphans = orphan_owned_nodes(&conn, &["srv_1".to_string()]);
        assert_eq!(orphans.len(), 1);
        assert_eq!(orphans[0].server_id, "srv_2");
        assert!(orphan_owned_nodes(&conn, &["srv_1".into(), "srv_2".into()]).is_empty());
    }

    /// 确认没了的节点：密码与节点行一起删。
    #[test]
    fn forgetting_a_gone_owned_node_deletes_its_password_and_row() {
        crate::test_support::install_test_secrets();
        let store = store_with_nodes();
        crate::secrets::set_secret("node:nd_a", "pw-a").unwrap();
        let orphan = OrphanOwnedNode {
            node_id: "nd_a".into(),
            server_id: "srv_1".into(),
            password_ref: "node:nd_a".into(),
        };
        assert!(forget_gone_owned_node(&store, &orphan));

        let conn = store.conn();
        assert!(crate::store::configs::get_node(&conn, "nd_a")
            .unwrap()
            .is_none());
        assert_eq!(crate::secrets::get_secret("node:nd_a").unwrap(), None);
    }

    /// 变化判定只看已有的行：新节点首次落库不算变化，密码只比存在值。
    #[test]
    fn change_flags_compare_existing_rows_only() {
        let old = Some((443, Some("pw-1".to_string())));
        assert_eq!(change_flags(old.clone(), old.clone()), (false, false));
        assert_eq!(
            change_flags(old.clone(), Some((8443, Some("pw-1".into())))),
            (true, false)
        );
        assert_eq!(
            change_flags(old.clone(), Some((443, Some("pw-2".into())))),
            (false, true)
        );
        assert_eq!(
            change_flags(Some((443, None)), Some((443, Some("pw-2".into())))),
            (false, true)
        );
        assert_eq!(
            change_flags(None, Some((443, Some("pw-2".into())))),
            (false, false),
            "新节点首次落库不算变化"
        );
    }

    /// 已在跑时再发一次整批同步：直接 BUSY，不排队。
    #[tokio::test]
    async fn a_second_sync_is_rejected_while_one_is_running() {
        SYNC_IN_FLIGHT.store(true, Ordering::SeqCst);
        let error = sync_all().await.unwrap_err();
        SYNC_IN_FLIGHT.store(false, Ordering::SeqCst);
        assert_eq!(error.code, "BUSY");
        assert_eq!(error.reason(), Some("sync_in_flight"));
    }

    struct RecordingEvents(std::sync::Mutex<Vec<Vec<String>>>);

    impl SyncEvents for RecordingEvents {
        fn node_list_changed(&self, changed_node_ids: &[String]) {
            self.0.lock().unwrap().push(changed_node_ids.to_vec());
        }
    }

    fn changed_at(node_id: &str) -> ServerSyncChanged {
        ServerSyncChanged {
            server_id: format!("srv_{node_id}"),
            node_id: node_id.into(),
            name: "节点".into(),
            port_changed: true,
            password_changed: false,
        }
    }

    /// 有变化只发一条汇总，`changed_node_ids` 用本地节点 id；没有变化不发。
    #[test]
    fn a_sync_with_changes_emits_one_summary_event() {
        let events = RecordingEvents(std::sync::Mutex::new(Vec::new()));
        emit_sync_changes(&events, &[changed_at("nd_a"), changed_at("nd_b")]);
        {
            let calls = events.0.lock().unwrap();
            assert_eq!(calls.len(), 1);
            assert_eq!(calls[0], vec!["nd_a".to_string(), "nd_b".to_string()]);
        }

        let quiet = RecordingEvents(std::sync::Mutex::new(Vec::new()));
        emit_sync_changes(&quiet, &[]);
        assert!(quiet.0.lock().unwrap().is_empty());
    }

    fn sync_store() -> &'static Arc<crate::store::Store> {
        if let Some(store) = crate::store::global() {
            return store;
        }
        let store = Arc::new(crate::store::Store::open_in_memory().unwrap());
        crate::store::install_global(Arc::clone(&store));
        crate::store::global().expect("全局库已安装")
    }

    fn remote(server_id: &str, name: &str) -> MyServer {
        serde_json::from_value(json!({
            "server_id": server_id,
            "name": name,
            "region": "tyo",
            "plan": "s-1vcpu-1gb",
            "state": "active",
            "created_at": "2026-11-14T08:00:00Z",
            "node_id": format!("remote-{server_id}"),
            "hourly_usd": 0.0,
            "monthly_usd": 6.0,
            "daily_price_cents": 20,
            "transfer_gib": 0,
            "billing_state": "active",
        }))
        .unwrap()
    }

    fn owned_node(
        store: &crate::store::Store,
        node_id: &str,
        server_id: &str,
        port: u16,
        secret: &str,
    ) {
        let password_ref = format!("node:{node_id}");
        {
            let conn = store.conn();
            crate::store::configs::upsert_node(
                &conn,
                &crate::store::NewNode {
                    id: node_id,
                    name: "节点",
                    server: "203.0.113.9",
                    port,
                    method: "aes-256-gcm",
                    password_ref: &password_ref,
                    source: crate::store::configs::SOURCE_OWNED,
                    source_key: server_id,
                },
            )
            .unwrap();
        }
        crate::secrets::set_secret(&password_ref, secret).unwrap();
    }

    /// 全路径：一台更新、一台失败；失败的行与密码不动，闸在返回时已释放。
    #[tokio::test]
    async fn sync_all_isolates_failures_and_releases_the_guard() {
        crate::test_support::install_test_secrets();
        let store = sync_store();
        owned_node(store, "nd_ok", "srv_ok", 20000, "old-password");
        owned_node(store, "nd_fail", "srv_fail", 20343, "old-fail-password");

        let list = || -> SyncFuture<Result<Vec<MyServer>, CpError>> {
            Box::pin(async { Ok(vec![remote("srv_ok", "好的"), remote("srv_fail", "坏的")]) })
        };
        let fetch = |server_id: String| -> SyncFuture<Result<Value, CpError>> {
            Box::pin(async move {
                if server_id == "srv_ok" {
                    let store = sync_store();
                    owned_node(store, "nd_ok", "srv_ok", 21111, "new-password");
                    Ok(json!({ "node_id": "nd_ok" }))
                } else {
                    Err(CpError::new("TIMEOUT", "请求超时", true, json!({})))
                }
            })
        };
        let events = RecordingEvents(std::sync::Mutex::new(Vec::new()));

        let data = sync_with(&list, &fetch, &events).await.unwrap();

        let ok = data
            .servers
            .iter()
            .find(|server| server.server_id == "srv_ok")
            .unwrap();
        assert_eq!(ok.local_node_id.as_deref(), Some("nd_ok"), "新节点要回填");
        assert_eq!(data.failed.len(), 1);
        assert_eq!(data.failed[0].server_id, "srv_fail");
        assert_eq!(data.failed[0].code, "TIMEOUT");
        assert_eq!(data.changed.len(), 1);
        assert_eq!(data.changed[0].node_id, "nd_ok");
        assert!(data.changed[0].port_changed);
        assert!(data.changed[0].password_changed);
        {
            let calls = events.0.lock().unwrap();
            assert_eq!(calls.len(), 1);
            assert_eq!(calls[0], vec!["nd_ok".to_string()]);
        }

        // 失败那台：本地行与密码原样保留。
        let conn = store.conn();
        let failed_node = crate::store::configs::find_node_by_source_key(
            &conn,
            crate::store::configs::SOURCE_OWNED,
            "srv_fail",
        )
        .unwrap()
        .unwrap();
        assert_eq!(failed_node.port, 20343);
        assert_eq!(
            crate::secrets::get_secret(&failed_node.password_ref)
                .unwrap()
                .as_deref(),
            Some("old-fail-password")
        );
        drop(conn);

        // 闸已释放：紧接着再跑一次不是 BUSY。
        let empty = || -> SyncFuture<Result<Vec<MyServer>, CpError>> {
            Box::pin(async { Ok(Vec::new()) })
        };
        let again = sync_with(&empty, &fetch, &events).await;
        assert!(again.is_ok(), "{:?}", again.err().map(|error| error.code));
    }
}
