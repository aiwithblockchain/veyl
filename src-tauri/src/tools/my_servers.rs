//! `MyServers`：只读地列出「我的服务器」与状态（`tools.md` §4.x）。
//!
//! 建机 / 销毁 / 凭据只能由用户点界面；本工具返回地址，不返回端口、密码或节点 id。

use std::sync::Arc;

use async_trait::async_trait;
use claurst_tools::{PermissionLevel, Tool, ToolContext, ToolResult};
use serde_json::{json, Value};

use super::display::{Changed, Fact, FactKey};
use super::envelope::{self, AivpnError, ToolOutcome};
use super::services::VpnToolServices;

/// 契约里的机器阶段值；不认识的一律 `unknown`。
fn stage_param(stage: &str) -> &str {
    match stage {
        "creating" | "booting" | "installing" | "verifying" | "error" => stage,
        _ => "unknown",
    }
}

fn failure(error: anyhow::Error) -> AivpnError {
    let text = error.to_string();
    match text.split_once(": ") {
        Some((code, message))
            if !code.is_empty() && code.chars().all(|c| c.is_ascii_uppercase() || c == '_') =>
        {
            AivpnError::new(code, message)
        }
        _ => AivpnError::new("INTERNAL", text),
    }
}

fn state_label(state: &str) -> &'static str {
    match state {
        "creating" | "booting" | "installing" | "verifying" => "安装中",
        "healthy" | "active" => "可用",
        "error" => "出错",
        "destroying" => "正在销毁",
        "gone" => "已失效",
        "destroyed" => "已销毁",
        _ => "状态未知",
    }
}

/// 已销毁的服务器为什么没了，用用户能懂的话；**不暴露内部 failure_code**。
///
/// 停机删除来自控制面墓碑（`failure.code = "billing_unpaid"`），其余 destroyed
/// 都是用户自己销毁的。
fn destroyed_reason(state: &str, failure_code: Option<&str>) -> Option<&'static str> {
    if state != "destroyed" {
        return None;
    }
    Some(if failure_code == Some("billing_unpaid") {
        "因余额不足停机删除"
    } else {
        "已销毁"
    })
}

/// 对模型可见的字段白名单：地址可以给（用户已同意 AI 看到自己服务器的 IP）；
/// 端口、密码、节点 id、provider id 等内部字段一律不出。
const VISIBLE_FIELDS: [&str; 17] = [
    "server_id",
    "name",
    "region",
    "state",
    "ip",
    "node_ready",
    "monthly_usd",
    "daily_price_cents",
    "transfer_gib",
    "failure",
    // 计费口径直接透出，不推算「约可运行 N 天」：结算前 pending 时 paid_until 为 null。
    "paid_until",
    "billing_state",
    // 流量四字段原样透出：单台只回答「这台用了多少」，账号总量看顶层 traffic_pool。
    "traffic_used_bytes",
    "traffic_limit_bytes",
    "traffic_reset_at",
    "traffic_state",
    // 云服务商侧已不存在：state 仍是 active，但不再扣费、额度冻结。
    "provider_gone",
];

/// 对模型可见的单条：按白名单重建，destroyed 时补人话原因并抹掉内部 failure。
fn visible_server(server: &Value) -> Value {
    let state = server.get("state").and_then(Value::as_str).unwrap_or("");
    let failure_code = server
        .get("failure")
        .and_then(|failure| failure.get("code"))
        .and_then(Value::as_str);
    let mut visible = serde_json::Map::new();
    for field in VISIBLE_FIELDS {
        if let Some(value) = server.get(field) {
            visible.insert(field.to_string(), value.clone());
        }
    }
    if let Some(reason) = destroyed_reason(state, failure_code) {
        visible.insert("failure".into(), Value::Null);
        visible.insert("destroyed_reason".into(), json!(reason));
    }
    Value::Object(visible)
}

/// 契约里的机器状态值；不认识的一律 `unknown`（UI 会按「状态未知」渲染）。
fn state_param(state: &str) -> &str {
    match state {
        "creating" | "booting" | "installing" | "verifying" | "healthy" | "active" | "error"
        | "destroying" | "gone" | "destroyed" => state,
        _ => "unknown",
    }
}

/// 列表一行：只给机器值，句子由 UI 组装（`server.row`）。
///
/// 名称或地区缺失 / 为空时整行不推：前端不会收到空串，也不必拼出「 ()」。
fn server_row_fact(server: &Value) -> Option<Fact> {
    let name = server
        .get("name")
        .and_then(Value::as_str)
        .filter(|name| !name.is_empty())?;
    let region = server
        .get("region")
        .and_then(Value::as_str)
        .filter(|region| !region.is_empty())?;
    // 云服务商侧已删除：复用契约里已有的 `gone`（实例已不存在），否则卡片会把幽灵机
    // 写成「已开通」。已销毁优先——应用里销毁之后仍然写「已销毁」。
    let provider_gone = server
        .get("provider_gone")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let raw_state = server.get("state").and_then(Value::as_str).unwrap_or("");
    let state = if provider_gone && raw_state != "destroyed" {
        "gone"
    } else {
        raw_state
    };
    let failure_code = server
        .get("failure")
        .and_then(|failure| failure.get("code"))
        .and_then(Value::as_str);
    let mut params = json!({
        "name": name,
        "region": region,
        "state": state_param(state),
    });
    if let Some(ip) = server.get("ip").and_then(Value::as_str) {
        params["ip"] = json!(ip);
    }
    if state == "destroyed" {
        params["destroyed"] = json!(if failure_code == Some("billing_unpaid") {
            "billing_unpaid"
        } else {
            "user"
        });
    }
    Some(Fact::with_params(FactKey::ServerRow, params))
}

pub struct MyServersTool {
    services: Arc<dyn VpnToolServices>,
}

impl MyServersTool {
    pub fn new(services: Arc<dyn VpnToolServices>) -> Self {
        Self { services }
    }
}

#[async_trait]
impl Tool for MyServersTool {
    fn name(&self) -> &str {
        "MyServers"
    }

    fn description(&self) -> &str {
        "查看「我的服务器」列表：名称、地区、状态、地址、是否可用、月费、流量。\
         只读；返回地址，不返回端口、密码。用户问这台机器的地址时直接答，不要绕。\
         账号本月流量只看摘要首行，不要把各台相加——列表不含已销毁的机器；\
         流量只说已用与已累计（已累计按月逐日增长，不是整月一次性给满），不推算还能用几天，也不换算成钱。\
         已销毁的会给出人话原因（`destroyed_reason`：因余额不足停机删除 / 已销毁），\
         不返回内部错误码。云服务商侧已删除的会标「云服务商已删除，不再扣费」——\
         它的 state 仍显示可用，但已经不扣费，不要给它报日价。\
         建机与销毁只能由用户在「我的服务器」页面操作。\n\
         用「服务器」「地区」「安装中」这些词；server_id 只用于调用工具，不要把它念给用户；不出现 node_id。"
    }

    fn permission_level(&self) -> PermissionLevel {
        PermissionLevel::ReadOnly
    }

    fn input_schema(&self) -> Value {
        json!({ "type": "object", "properties": {}, "additionalProperties": false })
    }

    async fn execute(&self, _input: Value, ctx: &ToolContext) -> ToolResult {
        // 设备身份 / 会话过期时没有「我的服务器」：要求用户先登录，不拿空列表冒充。
        if !crate::control_plane::auth::account_state().logged_in {
            let error = AivpnError::new("PRECONDITION_FAILED", "需要先登录才能查看自己的服务器")
                .with_details(json!({ "reason": "auth_required" }));
            return envelope::finish(
                ctx,
                "MyServers",
                ToolOutcome::fail(error).with_changed(Changed::None),
            );
        }
        let outcome = match self.services.my_servers().await {
            Ok(data) => {
                let original: Vec<Value> = data
                    .get("servers")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default();
                let servers: Vec<Value> = original.iter().map(visible_server).collect();
                let facts = if original.is_empty() {
                    vec![Fact::new(FactKey::ServersEmpty)]
                } else {
                    original.iter().take(8).filter_map(server_row_fact).collect()
                };
                // 顶层只放契约里的两个键：服务层多给的内部字段不进界面，也不进模型。
                let pool = data.get("traffic_pool").and_then(|pool| {
                    let used = pool.get("used_bytes").and_then(Value::as_u64)?;
                    let limit = pool.get("limit_bytes").and_then(Value::as_u64)?;
                    Some(json!({ "used_bytes": used, "limit_bytes": limit }))
                });
                let summary = summarise_servers(&servers, pool.as_ref());
                let mut visible = json!({ "servers": servers });
                if let Some(pool) = pool {
                    visible["traffic_pool"] = pool;
                }
                ToolOutcome::ok(summary, visible).with_facts(facts)
            }
            Err(error) => ToolOutcome::fail(failure(error)),
        };
        envelope::finish(ctx, "MyServers", outcome)
    }
}

/// 字节按 GiB（1024³）展示，与界面 `formatTrafficGib` 同一口径；只做展示。
fn gib_text(bytes: u64) -> String {
    format!("{:.1} GiB", bytes as f64 / 1_073_741_824.0)
}

/// `limit` 是已累计额度（按存在天数逐日累计），不是整月一次性给满的「上限」；
/// 0 = 控制面没给，只说已用，不编一个 0 GiB 的额度。
fn traffic_text(used: u64, limit: u64) -> String {
    if limit == 0 {
        format!("已用 {}", gib_text(used))
    } else {
        format!("已用 {} / 已累计 {}", gib_text(used), gib_text(limit))
    }
}

/// 模型只看得到摘要（`ToolResult.content`），`data` 只进界面。
/// 所以每台的 id / 名称 / 地区 / 状态 / 地址 / 计费必须写在这里，
/// `server_id` 是 `NodeRotateCredentials` 等工具的唯一入参来源。
///
/// 账号总量只读 `traffic_pool`：列表不含已销毁 / 已 dismiss 的机器，
/// 逐台求和会把「账号已超」答成「没超」。
fn summarise_servers(servers: &[Value], pool: Option<&Value>) -> String {
    let mut lines = Vec::new();
    if let Some(pool) = pool {
        if let (Some(used), Some(limit)) = (
            pool.get("used_bytes").and_then(Value::as_u64),
            pool.get("limit_bytes").and_then(Value::as_u64),
        ) {
            // 「已累计」是按天长出来的额度，不是整月一次性给满；账号级「上限」是另一个数。
            // 不说清这层关系，模型容易把它当成「到顶了」，或反过来当成上限报给用户。
            if limit > 0 {
                lines.push(format!(
                    "本月流量：{}（已累计按月逐日增长，不是整月一次性给满；账号级「上限」另算，这里不列）",
                    traffic_text(used, limit)
                ));
            } else {
                lines.push(format!("本月流量：{}", traffic_text(used, limit)));
            }
        }
    }
    if servers.is_empty() {
        lines.push("你名下还没有自建服务器。".to_string());
        return lines.join("\n");
    }
    lines.push(format!("共 {} 台服务器：", servers.len()));
    for server in servers {
        let id = server
            .get("server_id")
            .and_then(Value::as_str)
            .unwrap_or("-");
        let name = server
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or("(未命名)");
        let region = server.get("region").and_then(Value::as_str).unwrap_or("-");
        let state = state_label(server.get("state").and_then(Value::as_str).unwrap_or(""));
        let ip = server
            .get("ip")
            .and_then(Value::as_str)
            .unwrap_or("地址未就绪");
        let ready = server
            .get("node_ready")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let daily = server
            .get("daily_price_cents")
            .and_then(Value::as_u64)
            .unwrap_or(0);
        // 云服务商侧已删除的机器：state 仍是可用，但不再扣费，报日价就是假话。
        let gone = server
            .get("provider_gone")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let mut line = format!("- {id} | {name} | {region} | {state} | {ip}");
        if gone {
            line.push_str(" | 云服务商已删除，不再扣费");
        } else {
            line.push_str(&format!(" | 每天 {:.2} 美元", daily as f64 / 100.0));
        }
        // 计费锚点：到期前 1 小时进可扣窗口，扣成功顺延一天，扣不到当场停机销毁、无宽限。
        // 所以既能说「已付到哪一刻」，也不能说成「有效期」或「到期」。
        if !gone && server.get("billing_state").and_then(Value::as_str) == Some("active") {
            if let Some(paid_until) = server
                .get("paid_until")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|until| !until.is_empty())
            {
                let until = friendly_time(paid_until).unwrap_or_else(|| paid_until.to_string());
                line.push_str(&format!(" | 已付至 {until}（每天自动续扣；扣不到即停机）"));
            }
        }
        // 逐台在已累计额度 > 0 时写；旧控制面 / 新机首报前是 0，不写，避免假零值。
        // 机型月额度与清零点只在 data 里，模型读不到，所以放在这里。
        if let (Some(used), Some(limit)) = (
            server.get("traffic_used_bytes").and_then(Value::as_u64),
            server.get("traffic_limit_bytes").and_then(Value::as_u64),
        ) {
            if limit > 0 {
                line.push_str(&format!(" | 本月流量 {}", traffic_text(used, limit)));
                let mut notes = Vec::new();
                if let Some(quota) = server
                    .get("transfer_gib")
                    .and_then(Value::as_i64)
                    .filter(|quota| *quota > 0)
                {
                    notes.push(format!("机型月额度 {quota} GiB"));
                }
                if let Some(reset) = server
                    .get("traffic_reset_at")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|reset| !reset.is_empty())
                {
                    let reset = friendly_time(reset).unwrap_or_else(|| reset.to_string());
                    notes.push(format!("{reset} 清零"));
                }
                if !notes.is_empty() {
                    line.push_str(&format!("（{}）", notes.join("，")));
                }
            }
        }
        // 非 ok 就是因流量超支停机，必须说出来。台账仍是账户级，单台不标「已超」。
        match server.get("traffic_state").and_then(Value::as_str) {
            Some("ok") | None => {}
            Some(_) => line.push_str(" | 流量超支已停机（未付费）"),
        }
        if ready {
            line.push_str(" | 可建配置");
        }
        if let Some(reason) = server.get("destroyed_reason").and_then(Value::as_str) {
            line.push_str(&format!(" | {reason}"));
        }
        lines.push(line);
    }
    lines.join("\n")
}

// ---------- MyServerWallet ----------

/// 余额对模型只说人话：分换算成金额，币种用用户看得懂的词。
fn amount_text(balance_cents: i64, currency: &str) -> String {
    let unit = match currency {
        "USD" => "美元",
        other => other,
    };
    format!("{:.2} {unit}", balance_cents as f64 / 100.0)
}

/// 控制面不给时间，`updated_at` 是 Host 取的 UTC 时刻；按本机时区显示。
fn friendly_time(updated_at: &str) -> Option<String> {
    chrono::DateTime::parse_from_rfc3339(updated_at)
        .ok()
        .map(|time| {
            time.with_timezone(&chrono::Local)
                .format("%Y-%m-%d %H:%M")
                .to_string()
        })
}

/// 只留契约里的三个字段：充值档位等收银台参数不进 AI 上下文。
fn visible_wallet(data: &Value) -> Value {
    let currency = data
        .get("currency")
        .and_then(Value::as_str)
        .filter(|currency| !currency.trim().is_empty())
        .unwrap_or("USD");
    json!({
        "balance_cents": data.get("balance_cents").and_then(Value::as_i64),
        "currency": currency,
        "updated_at": data.get("updated_at").and_then(Value::as_str).map(str::trim).filter(|t| !t.is_empty()),
    })
}

fn summarise_wallet(wallet: &Value) -> String {
    let Some(cents) = wallet.get("balance_cents").and_then(Value::as_i64) else {
        return "余额数据不完整。".to_string();
    };
    let currency = wallet
        .get("currency")
        .and_then(Value::as_str)
        .unwrap_or("USD");
    let amount = amount_text(cents, currency);
    match wallet.get("updated_at").and_then(Value::as_str) {
        Some(time) => match friendly_time(time) {
            Some(local) => format!("余额 {amount}，截至 {local}。这是最近一次快照。"),
            None => format!("余额 {amount}，读取时间未知。这是最近一次快照。"),
        },
        None => format!("余额 {amount}，读取时间未知。这是最近一次快照。"),
    }
}

pub struct MyServerWalletTool {
    services: Arc<dyn VpnToolServices>,
}

impl MyServerWalletTool {
    pub fn new(services: Arc<dyn VpnToolServices>) -> Self {
        Self { services }
    }
}

#[async_trait]
impl Tool for MyServerWalletTool {
    fn name(&self) -> &str {
        "MyServerWallet"
    }

    fn description(&self) -> &str {
        "读账户余额，返回最近一次快照（带读取时间）。只读；充值属于界面动作，不要替用户发起。\
         金额按工具返回的分换算成用户说法（例如 12.34 美元），不要推算还能用几天；\
         未登录时说还没登录，不要说余额为 0。\n\
         说「余额」和金额；不出现 balance_cents、钱包接口或充值档位。"
    }

    fn permission_level(&self) -> PermissionLevel {
        PermissionLevel::ReadOnly
    }

    fn input_schema(&self) -> Value {
        json!({ "type": "object", "properties": {}, "additionalProperties": false })
    }

    async fn execute(&self, _input: Value, ctx: &ToolContext) -> ToolResult {
        // 未登录 / 会话过期时没有余额可言：要求先登录，不能拿 0 冒充。
        if !crate::control_plane::auth::account_state().logged_in {
            let error = AivpnError::new("PRECONDITION_FAILED", "需要先登录才能查看余额")
                .with_details(json!({ "reason": "auth_required" }));
            return envelope::finish(
                ctx,
                "MyServerWallet",
                ToolOutcome::fail(error).with_changed(Changed::None),
            );
        }
        let outcome = match self.services.my_server_wallet().await {
            Ok(data) => {
                let wallet = visible_wallet(&data);
                // 缺余额时不能默认成 0：宁可报数据不完整，也不能编一个金额。
                if wallet.get("balance_cents").and_then(Value::as_i64).is_none() {
                    ToolOutcome::fail(AivpnError::new("INTERNAL", "余额数据不完整"))
                        .with_changed(Changed::None)
                } else {
                    let summary = summarise_wallet(&wallet);
                    ToolOutcome::ok(summary, wallet).with_changed(Changed::None)
                }
            }
            Err(error) => ToolOutcome::fail(failure(error)).with_changed(Changed::None),
        };
        envelope::finish(ctx, "MyServerWallet", outcome)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn a_not_wired_registry_fails_instead_of_inventing_servers() {
        let services = crate::tools::NotWiredServices;
        assert!(
            services.my_servers().await.is_err(),
            "未接入时不能返回空列表冒充成功"
        );
    }

    #[test]
    fn states_are_rendered_in_user_words() {
        assert_eq!(state_label("installing"), "安装中");
        assert_eq!(state_label("healthy"), "可用");
        assert_eq!(state_label("destroying"), "正在销毁");
        assert_eq!(state_label("nonsense"), "状态未知");
    }

    #[test]
    fn the_summary_carries_every_server_because_only_content_reaches_the_model() {
        let servers = vec![
            json!({
                "server_id": "srv_1",
                "name": "伦敦",
                "region": "lon1",
                "state": "active",
                "ip": "167.99.195.212",
                "node_ready": true,
                "daily_price_cents": 30,
            }),
            json!({
                "server_id": "srv_2",
                "name": "纽约",
                "region": "nyc1",
                "state": "destroyed",
                "ip": null,
                "node_ready": false,
                "daily_price_cents": 30,
                "destroyed_reason": "已销毁",
            }),
        ];
        let text = summarise_servers(&servers, None);
        for expected in [
            "共 2 台服务器",
            "srv_1",
            "伦敦",
            "lon1",
            "167.99.195.212",
            "可用",
            "可建配置",
            "srv_2",
            "已销毁",
        ] {
            assert!(text.contains(expected), "摘要缺少 {expected}：{text}");
        }
        assert_eq!(summarise_servers(&[], None), "你名下还没有自建服务器。");
    }

    /// 地址保留；端口、密码、节点 id、provider id 等内部字段不得出现。
    #[test]
    fn visible_servers_keep_address_and_drop_secrets() {
        let server = json!({
            "server_id": "srv_1",
            "name": "伦敦",
            "region": "lon1",
            "state": "active",
            "ip": "167.99.195.212",
            "port": 59281,
            "node_ready": true,
            "monthly_usd": 6.0,
            "password": "pw-secret",
            "node_id": "nd_x",
            "provider_id": "123",
            "traffic_used_bytes": 1_100_000_000_u64,
            "traffic_limit_bytes": 50_000_000_000_u64,
            "traffic_reset_at": "2026-12-01T00:00:00Z",
            "traffic_state": "ok",
        });
        let visible = visible_server(&server);
        assert_eq!(visible["ip"], "167.99.195.212");
        for kept in [
            "traffic_used_bytes",
            "traffic_limit_bytes",
            "traffic_reset_at",
            "traffic_state",
        ] {
            assert!(visible.get(kept).is_some(), "流量字段必须透出：{visible}");
        }
        for hidden in ["port", "password", "node_id", "provider_id"] {
            assert!(
                visible.get(hidden).is_none(),
                "内部字段 {hidden} 不能进 AI 上下文：{visible}"
            );
        }
    }

    /// 计费口径原样透出：结算前 pending 时 `paid_until` 为 null，服务中给 ISO 时刻。
    /// 不推算「约可运行 N 天」，也不把扣费/宽限派生子带出去。
    #[test]
    fn billing_fields_pass_through_without_derivation() {
        let pending = json!({
            "server_id": "srv_1",
            "state": "creating",
            "paid_until": null,
            "billing_state": "pending",
        });
        let visible = visible_server(&pending);
        assert!(visible["paid_until"].is_null(), "{visible}");
        assert_eq!(visible["billing_state"], "pending");

        let active = json!({
            "server_id": "srv_2",
            "state": "active",
            "paid_until": "2026-11-27T10:00:00Z",
            "billing_state": "active",
            "charged_cents": 3000,
            "refunded_cents": 0,
            "grace_ends_at": "2026-12-04T10:00:00Z",
        });
        let visible = visible_server(&active);
        assert_eq!(visible["paid_until"], "2026-11-27T10:00:00Z");
        assert_eq!(visible["billing_state"], "active");
        for hidden in ["charged_cents", "refunded_cents", "grace_ends_at"] {
            assert!(
                visible.get(hidden).is_none(),
                "内部金额或派生值 {hidden} 不能进 AI 上下文：{visible}"
            );
        }
    }

    /// 计费是按天自动续扣，扣不到即停机；不写成「有效期」或「到期」。
    #[test]
    fn a_paid_server_says_how_far_it_is_paid_not_an_expiry() {
        let active = summarise_servers(&[json!({
            "server_id": "srv_1", "name": "伦敦", "region": "lon1", "state": "active",
            "ip": "203.0.113.1", "node_ready": true, "daily_price_cents": 30,
            "paid_until": "2026-11-27T10:00:00Z", "billing_state": "active",
        })], None);
        assert!(active.contains("已付至"), "{active}");
        assert!(active.contains("每天自动续扣"), "{active}");
        assert!(active.contains("扣不到即停机"), "{active}");
        for forbidden in ["有效期", "到期"] {
            assert!(
                !active.contains(forbidden),
                "不能出现「{forbidden}」：{active}"
            );
        }

        let pending = summarise_servers(&[json!({
            "server_id": "srv_2", "name": "东京", "region": "tyo1", "state": "creating",
            "paid_until": null, "billing_state": "pending",
        })], None);
        assert!(!pending.contains("已付至"), "{pending}");
        assert!(!pending.contains("约可运行"), "{pending}");
    }

    /// 账号总量只认池子：列表只有一台、池子却是更大的数（已销毁机器的用量仍计扣费）。
    #[test]
    fn the_pool_wins_over_the_sum_of_listed_servers() {
        let servers = vec![json!({
            "server_id": "srv_1", "name": "伦敦", "region": "lon1", "state": "active",
            "ip": "203.0.113.1", "node_ready": true, "daily_price_cents": 30,
            "traffic_used_bytes": 1_100_000_000_u64,
            "traffic_limit_bytes": 50_000_000_000_u64,
            "traffic_state": "ok",
        })];
        let pool = json!({
            "used_bytes": 5_400_000_000_u64,
            "limit_bytes": 100_000_000_000_u64,
        });
        let text = summarise_servers(&servers, Some(&pool));
        assert!(
            text.starts_with("本月流量：已用 5.0 GiB / 已累计 93.1 GiB"),
            "首行必须是账号池：{text}"
        );
        assert!(
            text.contains("已累计按月逐日增长，不是整月一次性给满；账号级「上限」另算"),
            "账号行要讲清与「上限」的区别：{text}"
        );
        assert!(
            !text.contains("已释放"),
            "用词与界面统一为「已累计」：{text}"
        );
        assert!(
            !text.contains("本月流量：已用 1.0"),
            "不能把逐台求和当账号总量：{text}"
        );
        assert!(
            text.contains("本月流量 已用 1.0 GiB"),
            "每台自己的用量照写：{text}"
        );
    }

    /// 云服务商侧已删除的机器：state 仍是可用，但不再扣费，不能报日价。
    #[test]
    fn a_ghost_is_not_quoted_a_daily_price() {
        let servers = vec![json!({
            "server_id": "srv_1", "name": "悉尼", "region": "syd1", "state": "active",
            "ip": "203.0.113.9", "node_ready": true, "daily_price_cents": 40,
            "paid_until": "2026-11-27T00:00:00Z", "billing_state": "active",
            "provider_gone": true,
            "traffic_used_bytes": 1_000_000_u64,
            "traffic_limit_bytes": 38_000_000_000_u64,
            "traffic_state": "ok",
        })];
        let text = summarise_servers(&servers, None);
        assert!(text.contains("云服务商已删除，不再扣费"), "{text}");
        assert!(!text.contains("每天 0.40 美元"), "{text}");
        assert!(!text.contains("已付至"), "{text}");
    }

    /// 旧控制面没有池子：整段不出现，也绝不补一个 0。
    #[test]
    fn a_missing_pool_is_not_invented_as_zero() {
        let text = summarise_servers(&[], None);
        assert_eq!(text, "你名下还没有自建服务器。");
        assert!(!text.contains("本月流量"), "{text}");
        assert!(!text.contains("0.0 GB"), "{text}");
    }

    /// 机器都销毁了但账号还有用量：池子照说。
    #[test]
    fn the_pool_survives_an_empty_server_list() {
        let pool = json!({ "used_bytes": 500_000_000_u64, "limit_bytes": 100_000_000_000_u64 });
        let text = summarise_servers(&[], Some(&pool));
        assert!(text.contains("本月流量：已用 0.5 GiB / 已累计 93.1 GiB"), "{text}");
        assert!(text.contains("还没有自建服务器"), "{text}");
    }

    /// 额度为 0 是「未知」：只说已用，不写 0 GB。
    #[test]
    fn an_unknown_limit_is_not_printed_as_zero() {
        let pool = json!({ "used_bytes": 500_000_000_u64, "limit_bytes": 0 });
        let text = summarise_servers(&[], Some(&pool));
        assert!(text.contains("本月流量：已用 0.5 GiB"), "{text}");
        assert!(!text.contains("额度"), "{text}");
    }

    /// 每台都写本月流量：已累计额度、机型月额度、清零点（本机时区）都要出来。
    #[test]
    fn a_server_row_carries_accumulated_quota_and_reset_time() {
        let text = summarise_servers(&[json!({
            "server_id": "srv_1", "name": "伦敦", "region": "lon1", "state": "active",
            "traffic_used_bytes": 3_200_000_000_u64,
            "traffic_limit_bytes": 12_000_000_000_u64,
            "transfer_gib": 50,
            "traffic_reset_at": "2026-12-01T00:00:00Z",
            "traffic_state": "ok",
        })], None);
        assert!(text.contains("已累计 11.2 GiB"), "{text}");
        assert!(text.contains("机型月额度 50 GiB"), "{text}");
        assert!(text.contains("清零"), "{text}");
        assert!(!text.contains("流量超支"), "正常机不标超支：{text}");
        assert!(!text.contains("GB"), "单位只能 GiB，不能混 GB：{text}");
    }

    /// 非 ok（unpaid）额外标「流量超支已停机」；流量数字每台照写。
    #[test]
    fn an_unpaid_server_is_marked_as_stopped_for_traffic() {
        let text = summarise_servers(&[json!({
            "server_id": "srv_1", "name": "伦敦", "region": "lon1", "state": "active",
            "ip": null, "node_ready": false, "daily_price_cents": 30,
            "traffic_used_bytes": 6_000_000_000_u64,
            "traffic_limit_bytes": 5_000_000_000_u64,
            "traffic_state": "unpaid",
        })], None);
        assert!(
            text.contains("本月流量 已用 5.6 GiB / 已累计 4.7 GiB"),
            "{text}"
        );
        assert!(text.contains("流量超支已停机（未付费）"), "{text}");
    }

    /// 旧控制面给空串：不能拼出「已付至 （…）」或「（ 清零）」。
    #[test]
    fn empty_timestamps_do_not_leave_empty_parentheses() {
        let text = summarise_servers(&[json!({
            "server_id": "srv_1", "name": "伦敦", "region": "lon1", "state": "active",
            "paid_until": "   ", "billing_state": "active",
            "traffic_used_bytes": 1_000_000_000_u64,
            "traffic_limit_bytes": 50_000_000_000_u64,
            "traffic_reset_at": "",
            "traffic_state": "ok",
        })], None);
        assert!(!text.contains("已付至"), "{text}");
        assert!(!text.contains("清零"), "{text}");
        assert!(!text.contains("（）"), "{text}");
        assert!(!text.contains("（ "), "{text}");
    }

    /// 旧控制面四字段默认 0：逐台不写流量，不能编「已用 0.0 GiB」。
    #[test]
    fn legacy_zero_traffic_is_not_reported_as_zero() {
        let text = summarise_servers(&[json!({
            "server_id": "srv_1", "name": "伦敦", "region": "lon1", "state": "active",
            "traffic_used_bytes": 0, "traffic_limit_bytes": 0,
            "traffic_reset_at": "", "traffic_state": "ok",
        })], None);
        assert!(!text.contains("本月流量"), "{text}");
        assert!(!text.contains("0.0 GiB"), "{text}");
    }

    /// 单位与界面一致：GiB（1024³），任何一处都不出现 GB。
    #[test]
    fn traffic_uses_gib_not_gb() {
        let text = summarise_servers(&[json!({
            "server_id": "srv_1", "name": "伦敦", "region": "lon1", "state": "active",
            "traffic_used_bytes": 536_870_912_000_u64,
            "traffic_limit_bytes": 536_870_912_000_u64,
            "transfer_gib": 500,
            "traffic_reset_at": "2026-12-01T00:00:00Z",
            "traffic_state": "ok",
        })], None);
        assert!(text.contains("已用 500.0 GiB / 已累计 500.0 GiB"), "{text}");
        assert!(text.contains("机型月额度 500 GiB"), "{text}");
        assert!(!text.contains("GB"), "不能混用 GB：{text}");
    }

    /// 已销毁的服务器给用户能懂的原因；内部 failure_code 不能交给模型。
    #[test]
    fn destroyed_servers_carry_a_human_reason() {
        let tombstone = json!({
            "server_id": "srv_1",
            "name": "纽约",
            "region": "nyc1",
            "state": "destroyed",
            "failure": {
                "code": "billing_unpaid",
                "message": "余额不足，已停机删除",
                "stage": "active",
                "retryable": false
            }
        });
        let visible = visible_server(&tombstone);
        assert_eq!(visible["destroyed_reason"], "因余额不足停机删除");
        assert!(
            visible["failure"].is_null(),
            "不能把内部 failure_code 交给模型"
        );

        let user_destroyed = json!({ "server_id": "srv_2", "state": "destroyed" });
        assert_eq!(visible_server(&user_destroyed)["destroyed_reason"], "已销毁");

        let active = json!({ "server_id": "srv_3", "state": "active" });
        let visible = visible_server(&active);
        assert!(visible.get("destroyed_reason").is_none());
        assert_eq!(visible["state"], "active");
    }

    /// 名称或地区缺失 / 为空时整行不推：前端不会收到空串拼出的「 ()」。
    #[test]
    fn a_row_without_name_or_region_is_not_pushed() {
        for server in [
            json!({ "state": "active", "region": "lon1" }),
            json!({ "state": "active", "name": "伦敦" }),
            json!({ "state": "active", "name": "", "region": "" }),
            json!({ "state": "active", "name": null, "region": "lon1" }),
        ] {
            assert!(
                server_row_fact(&server).is_none(),
                "缺名称或地区时不能推 server.row：{server}"
            );
        }
        assert_eq!(
            server_row_fact(&json!({ "state": "active", "name": "伦敦", "region": "lon1" })),
            Some(Fact::with_params(
                FactKey::ServerRow,
                json!({ "name": "伦敦", "region": "lon1", "state": "active" })
            ))
        );
    }

    /// 云服务商侧已删除的机器：卡片状态词换掉，不能写成「已开通」。
    #[test]
    fn a_ghost_row_is_pushed_as_gone() {
        assert_eq!(
            server_row_fact(&json!({
                "state": "active", "name": "悉尼", "region": "syd1", "provider_gone": true
            })),
            Some(Fact::with_params(
                FactKey::ServerRow,
                json!({ "name": "悉尼", "region": "syd1", "state": "gone" })
            ))
        );
        // 应用里销毁之后仍写「已销毁」，不被 provider_gone 覆盖。
        assert_eq!(
            server_row_fact(&json!({
                "state": "destroyed", "name": "悉尼", "region": "syd1",
                "provider_gone": true, "failure": null
            })),
            Some(Fact::with_params(
                FactKey::ServerRow,
                json!({
                    "name": "悉尼", "region": "syd1", "state": "destroyed",
                    "destroyed": "user"
                })
            ))
        );
    }

    /// `failure: null` 只代表本次进程内没有记录，描述里必须写死这条，防止模型下错结论。
    #[test]
    fn failure_description_pins_the_missing_record_rule() {
        let tool = MyServerFailureTool::new(Arc::new(crate::tools::NotWiredServices));
        let description = tool.description();
        assert!(
            description.contains("不代表从未失败"),
            "描述必须说明 null 不代表从未失败：{description}"
        );
        assert!(
            description.contains("记录不完整，建议重建或联系支持"),
            "描述必须给出 error + null 时的唯一说法：{description}"
        );
    }
}

// ---------- MyServerFailure ----------

fn parse_failure_input(input: &Value) -> Result<String, AivpnError> {
    let Some(object) = input.as_object() else {
        return Err(AivpnError::new("INVALID_ARGUMENT", "参数必须是一个对象")
            .with_details(json!({ "reason": "invalid_payload" })));
    };
    for key in object.keys() {
        if key != "serverId" {
            return Err(
                AivpnError::new("INVALID_ARGUMENT", format!("不支持的参数 {key}"))
                    .with_details(json!({ "reason": "unknown_argument" })),
            );
        }
    }
    let value = object
        .get("serverId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            AivpnError::new("INVALID_ARGUMENT", "缺少 serverId")
                .with_details(json!({ "reason": "missing_server_id" }))
        })?;
    Ok(value.to_string())
}

fn retry_label(retryable: bool) -> &'static str {
    if retryable {
        "可以重试"
    } else {
        "不能重试"
    }
}

/// 失败阶段用用户词：`stage` 取值同 `MyServerState`，不能把内部枚举直接摆到卡片上。
fn stage_label(stage: &str) -> &'static str {
    match stage {
        "creating" => "创建",
        "booting" => "开机",
        "installing" => "装环境",
        "verifying" => "校验",
        "error" => "出错",
        _ => "未知阶段",
    }
}

pub struct MyServerFailureTool {
    services: Arc<dyn VpnToolServices>,
}

impl MyServerFailureTool {
    pub fn new(services: Arc<dyn VpnToolServices>) -> Self {
        Self { services }
    }
}

#[async_trait]
impl Tool for MyServerFailureTool {
    fn name(&self) -> &str {
        "MyServerFailure"
    }

    fn description(&self) -> &str {
        "只在用户点了「AI 定位」或明确问「这次为什么失败」时调用。\
         返回某台服务器的结构化失败、订单失败与最近 20 条订单事件。\
         failure 为 null 只表示本次进程内没有记录，不代表从未失败，不得据此断定「没有失败」；\
         服务器 state 为 error 但 failure 为 null 时，只能说「记录不完整，建议重建或联系支持」。\
         控制面没有建机原始日志，log_available 恒为 false：不得声称读过日志，\
         也不得让用户上传日志。\n\
         用「阶段」「原因」「能不能重试」这些词；不出现 server_id、order_id、IP、端口。"
    }

    fn permission_level(&self) -> PermissionLevel {
        PermissionLevel::ReadOnly
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "serverId": { "type": "string", "minLength": 1 }
            },
            "required": ["serverId"],
            "additionalProperties": false
        })
    }

    async fn execute(&self, input: Value, ctx: &ToolContext) -> ToolResult {
        let outcome = match parse_failure_input(&input) {
            Ok(server_id) => match self.services.my_server_failure(&server_id).await {
                Ok(data) => success_outcome(&data),
                Err(error) => {
                    ToolOutcome::fail(failure(error)).with_display(Vec::new(), Changed::None)
                }
            },
            Err(error) => ToolOutcome::fail(error).with_display(Vec::new(), Changed::None),
        };
        envelope::finish(ctx, "MyServerFailure", outcome)
    }
}

fn success_outcome(data: &Value) -> ToolOutcome {
    let name = data
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or("这台服务器");
    let state = data.get("state").and_then(Value::as_str).unwrap_or("");
    let failure = data.get("failure").filter(|value| !value.is_null());
    let events = data
        .get("recent_events")
        .and_then(Value::as_array)
        .map(Vec::len)
        .unwrap_or(0);

    let mut facts = Vec::new();
    let summary = match failure {
        Some(failure) => {
            let stage = failure
                .get("stage")
                .and_then(Value::as_str)
                .unwrap_or("未知阶段");
            let stage = stage_label(stage);
            let message = failure
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("没有说明");
            let retryable = failure
                .get("retryable")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            if let Some(code) = failure.get("code").and_then(Value::as_str) {
                facts.push(Fact::with_params(
                    FactKey::ServerFailureCode,
                    json!({ "code": code }),
                ));
            }
            facts.push(Fact::with_params(
                FactKey::ServerStage,
                json!({ "stage": stage_param(failure.get("stage").and_then(Value::as_str).unwrap_or("")) }),
            ));
            facts.push(Fact::with_params(
                FactKey::ServerRetryable,
                json!({ "value": if retryable { "yes" } else { "no" } }),
            ));
            format!(
                "{name}（{}）这次失败在「{stage}」：{message}，{}。最近 {events} 条订单事件；没有建机原始日志。",
                state_label(state),
                retry_label(retryable)
            )
        }
        None => {
            if state == "error" {
                facts.push(Fact::new(FactKey::ServerRecordIncomplete));
                facts.push(Fact::new(FactKey::ServerAdviceRebuild));
                format!("{name}这次失败的记录不完整，建议重建或联系支持；没有建机原始日志。")
            } else {
                facts.push(Fact::new(FactKey::ServerNoRecord));
                format!(
                    "{name}（{}）本次进程内没有失败记录；这不代表从未失败，也没有建机原始日志。",
                    state_label(state)
                )
            }
        }
    };

    ToolOutcome::ok(summary, data.clone()).with_display(facts, Changed::None)
}
