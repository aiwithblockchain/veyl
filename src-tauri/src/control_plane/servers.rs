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
    #[serde(default)]
    pub failure: Option<MyServerFailure>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MyServerOrderFailure {
    pub code: String,
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

fn validate_server(server: &MyServer) -> Result<(), CpError> {
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
    Ok(())
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
        let server: MyServer = serde_json::from_value(value.clone())
            .map_err(|_| CpError::invalid_response("服务器列表条目格式不正确"))?;
        validate_server(&server)?;
        servers.push(server);
    }
    for server in &servers {
        cache_server(server);
    }
    Ok(servers)
}

pub async fn get(server_id: &str) -> Result<MyServer, CpError> {
    let client = ControlPlane::new()?;
    get_with(&client, server_id).await
}

async fn get_with(client: &ControlPlane, server_id: &str) -> Result<MyServer, CpError> {
    let raw = client.get(&format!("/v1/servers/{server_id}")).await?;
    let server: MyServer = serde_json::from_value(raw)
        .map_err(|_| CpError::invalid_response("服务器详情格式不正确"))?;
    validate_server(&server)?;
    cache_server(&server);
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

pub async fn checkout(order_id: &str) -> Result<MyServerOrder, CpError> {
    let client = ControlPlane::new()?;
    let body = json!({ "channel": "fake" });
    let raw = client
        .post(
            &format!("/v1/orders/{order_id}/checkout"),
            Some(&body),
            Some(&new_idempotency_key()),
        )
        .await?;
    let fallback = remembered_order(order_id);
    merge_order(parse_order(raw)?, order_id, fallback.as_ref(), None, None)
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
    cache_server(&server);
    if let Some(node_id) = server.node_id.as_deref() {
        // 销毁即销毁凭据（§19.8）；节点记录保留并能在界面标「服务器已销毁」。
        let _ = crate::secrets::delete_secret(&format!("node:{node_id}"));
    }
    Ok(server)
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
            failure: None,
        };
        cache_server(&created);
    }

    Ok(json!({ "newServerId": new_id, "state": state }))
}

pub async fn credentials(server_id: &str) -> Result<Value, CpError> {
    let client = ControlPlane::new()?;
    let raw = client
        .post(&format!("/v1/servers/{server_id}/credentials"), None, None)
        .await?;
    let payload = raw
        .get("payload")
        .and_then(Value::as_str)
        .ok_or_else(|| CpError::invalid_response("凭据响应缺少 payload"))?;
    let signature = raw
        .get("signature")
        .and_then(Value::as_str)
        .ok_or_else(|| CpError::invalid_response("凭据响应缺少 signature"))?;
    let key_id = raw
        .get("key_id")
        .and_then(Value::as_str)
        .unwrap_or_default();

    super::credentials::verify_and_store(server_id, payload, signature, key_id)?;
    Ok(json!({ "payload": payload, "signature": signature }))
}

fn cache_server(server: &MyServer) {
    let Some(store) = crate::store::global() else {
        return;
    };
    let conn = store.conn();
    let before = crate::store::servers::get(&conn, &server.server_id)
        .ok()
        .flatten();
    let created_at = parse_iso_ms(&server.created_at).unwrap_or_else(crate::store::now_ms);
    // `my_servers.node_id` 有外键；远端可能比本地先给出 node_id（凭据还没取），
    // 此时先留空，等 `my_server_credentials` 建好节点行再回填。
    let node_id = server
        .node_id
        .as_deref()
        .or_else(|| before.as_ref().and_then(|row| row.node_id.as_deref()))
        .filter(|id| {
            crate::store::configs::get_node(&conn, id)
                .ok()
                .flatten()
                .is_some()
        });
    let new = crate::store::NewMyServer {
        id: &server.server_id,
        provider: "digitalocean",
        name: &server.name,
        region: &server.region,
        plan: &server.plan,
        state: &server.state,
        node_id,
        hourly_usd: server.hourly_usd,
        monthly_usd: server.monthly_usd,
        created_at,
    };
    if let Err(error) = crate::store::servers::upsert(&conn, &new) {
        log::warn!("缓存我的服务器失败：{error}");
        return;
    }
    let changed = before
        .as_ref()
        .map(|row| row.state.as_str() != server.state)
        .unwrap_or(true);
    if changed {
        super::events::emit_server_changed(server);
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
        node_id: row.node_id,
        hourly_usd: row.hourly_usd,
        monthly_usd: row.monthly_usd,
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
            failure: None,
        };
        assert!(validate_server(&server).is_ok());

        server.state = "unknown-state".into();
        assert_eq!(
            validate_server(&server).unwrap_err().reason(),
            Some("invalid_response")
        );
        server.state = "healthy".into();
        server.created_at = "yesterday".into();
        assert!(validate_server(&server).is_err());
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
}
