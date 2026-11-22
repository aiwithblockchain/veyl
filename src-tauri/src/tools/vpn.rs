use std::sync::Arc;

use async_trait::async_trait;
use claurst_tools::{PermissionLevel, Tool, ToolContext, ToolResult};
use serde_json::{json, Value};

use super::display::{Changed, Fact, FactKey};
use super::envelope::{self, AivpnError, NextAction, ToolOutcome};
use super::services::{ServiceError, VpnToolServices};

pub struct VpnConnectTool {
    services: Arc<dyn VpnToolServices>,
}

impl VpnConnectTool {
    pub fn new(services: Arc<dyn VpnToolServices>) -> Self {
        Self { services }
    }
}

#[async_trait]
impl Tool for VpnConnectTool {
    fn name(&self) -> &str {
        "VpnConnect"
    }

    fn description(&self) -> &str {
        "连接一套配置并设置系统代理。省略 config_id 时使用当前激活配置。\
         如果已经连着另一套配置，会先断开旧的再连新的，网络会短暂中断。\
         切换当前节点请用 NodeSwitch，不要用本工具。\
         state=running 即已连上；exit_ip 为 null 表示已连接但出口尚未测到，\
         不代表连接失败，可用 RuntimeStatus 再查。\n只说「已经连上了」；不提代理端口、入站、selector、路由表。失败时说明系统网络设置是否已恢复原样。"
    }

    fn permission_level(&self) -> PermissionLevel {
        PermissionLevel::Execute
    }

    fn self_gates(&self) -> bool {
        true
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "config_id": { "type": "string" }
            },
            "additionalProperties": false
        })
    }

    async fn execute(&self, input: Value, ctx: &ToolContext) -> ToolResult {
        let config_id = match super::optional_string(&input, "config_id") {
            Ok(value) => value,
            Err(error) => return envelope::finish(ctx, "VpnConnect", ToolOutcome::fail(error)),
        };

        let outcome = match self.services.vpn_connect(config_id).await {
            Ok(data) => {
                let summary = connect_summary(&data);
                let facts = connect_facts(&data);
                ToolOutcome::ok(summary, data)
                    .with_display(facts, Changed::None)
                    .with_next(NextAction {
                        label: "断开连接".to_string(),
                        tool: "VpnDisconnect".to_string(),
                        args: json!({}),
                    })
            }
            Err(error) => {
                let changed = connect_failure(&error);
                ToolOutcome::fail(
                    AivpnError::new("UPSTREAM_ERROR", error.to_string())
                        .with_details(json!({ "hint": "换一个同地区节点，或运行 DiagRun 诊断" })),
                )
                .with_display(Vec::new(), changed)
                .with_next(NextAction {
                    label: "诊断一下".to_string(),
                    tool: "DiagRun".to_string(),
                    args: json!({}),
                })
            }
        };
        envelope::finish(ctx, "VpnConnect", outcome)
    }
}

/// 连接成功后的摘要：模型下一步就要向用户报「用的哪条线路、代理地址、出口 IP」。
/// 少给一样它就得再调一次 `RuntimeStatus`，首启的轮次预算经不起这么花。
fn connect_summary(data: &Value) -> String {
    // 判断模式只看 `mode`。以前用 `mixed_port` 是否为 null 猜 TUN，
    // 而 TUN 的 payload 里 mixed_port 恰好也是 null——猜对了纯属巧合。
    if data.get("mode").and_then(Value::as_str) == Some("tun") {
        return tun_summary(data);
    }

    let name = data
        .get("config_name")
        .and_then(Value::as_str)
        .unwrap_or("当前配置");
    let mut parts = vec![format!("已连接：配置「{name}」")];
    if let Some(node) = data.get("node_name").and_then(Value::as_str) {
        parts.push(format!("节点「{node}」"));
    }
    match data.get("mixed_port").and_then(Value::as_u64) {
        Some(port) => parts.push(format!("代理地址 127.0.0.1:{port}")),
        None => parts.push("本机代理端口未拿到".to_string()),
    }
    match data.get("exit_ip").and_then(Value::as_str) {
        Some(ip) => {
            parts.push(match data.get("latency_ms").and_then(Value::as_u64) {
                Some(ms) => format!("出口 IP {ip}（{ms}ms）"),
                None => format!("出口 IP {ip}"),
            });
        }
        None => parts.push("出口 IP 仍在探测中".to_string()),
    }
    format!("{}。", parts.join("，"))
}

/// 连接失败时按服务带回的信号选 changed：回滚了说「已恢复原样」，
/// 完全没动说「没有改动」，拿不到信号才说「不确定」。
fn connect_failure(error: &anyhow::Error) -> Changed {
    let signal = error
        .downcast_ref::<ServiceError>()
        .and_then(|service| service.details.as_ref())
        .and_then(|details| details.get("connect_changed"))
        .and_then(Value::as_str);
    match signal {
        Some("restored") => Changed::Restored,
        Some("none") => Changed::None,
        _ => Changed::Unknown,
    }
}

/// 卡片上的事实。TUN 是否接管确不确认，由模型正文说；这里只给确定的机器值。
fn connect_facts(data: &Value) -> Vec<Fact> {
    let mut facts = Vec::new();
    if let Some(name) = data.get("config_name").and_then(Value::as_str) {
        facts.push(Fact::with_params(
            FactKey::ConfigName,
            json!({ "name": name }),
        ));
    }
    if let Some(node) = data.get("node_name").and_then(Value::as_str) {
        facts.push(Fact::with_params(
            FactKey::NodeName,
            json!({ "name": node }),
        ));
    }
    if let Some(ip) = data.get("exit_ip").and_then(Value::as_str) {
        facts.push(Fact::with_params(
            FactKey::RuntimeExitIp,
            json!({ "ip": ip }),
        ));
    }
    facts
}

/// TUN 的摘要不能说假话：
/// - helper 的 start 只保证 sing-box 起来了，不等 TUN 设备与路由表；
/// - 设备存在只证明 utun 建好了，不证明流量被送了进去——「全部接管」还要
///   默认路由真的指到这个接口上；
/// - `proxy_selected` 只接管选定的服务，不能说「全部」；
/// - 没有证据时，只能说「还没确认接管」，出口 IP 单独也不能证明全量接管。
fn tun_summary(data: &Value) -> String {
    let name = data
        .get("config_name")
        .and_then(Value::as_str)
        .unwrap_or("当前配置");
    let mut parts = vec![format!("已启动 TUN：配置「{name}」")];
    if let Some(node) = data.get("node_name").and_then(Value::as_str) {
        parts.push(format!("节点「{node}」"));
    }

    let routing = data
        .get("routing_mode")
        .and_then(Value::as_str)
        .unwrap_or("");
    // 三态：true / false / 未采集（null 或键不存在）。
    // 未采集不能说成「设备没出现」——那是把「不知道」当成「没起来」。
    let device_up = data.get("tun_device_up").and_then(Value::as_bool);
    let default_route = data.get("tun_default_route").and_then(Value::as_bool);
    match device_up {
        None => parts.push(
            "当前平台未采集 TUN 设备状态，无法确认是否接管；不要告诉用户已经接管".to_string(),
        ),
        Some(false) => {
            parts.push("但还没确认接管（没看到 TUN 设备），不要告诉用户已经接管".to_string())
        }
        Some(true) if routing == "proxy_all" => match default_route {
            Some(true) => {
                parts.push("TUN 设备已就绪、默认路由已指过来，全部流量已接管".to_string())
            }
            Some(false) => parts.push(
                "TUN 设备已就绪，但默认路由还没指过来，接管尚未确认，\
                 不要告诉用户已经全部接管"
                    .to_string(),
            ),
            None => parts.push(
                "TUN 设备已就绪，但默认路由状态未采集，无法确认全部接管，\
                 不要告诉用户已经全部接管"
                    .to_string(),
            ),
        },
        Some(true) if routing == "direct" => {
            parts.push("TUN 设备已就绪，但当前分流模式是直连，流量没有走进 VPN".to_string())
        }
        Some(true) => parts.push("TUN 设备已就绪，按分流规则接管选定服务".to_string()),
    }

    match data.get("exit_ip").and_then(Value::as_str) {
        Some(ip) => parts.push(format!("出口 IP {ip}")),
        None => parts.push("出口尚未确认".to_string()),
    }
    format!("{}。", parts.join("，"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_proxy_connection_reports_address_ip_and_latency() {
        let text = connect_summary(&json!({
            "mode": "system_proxy",
            "config_name": "浏览器代理",
            "node_name": "meshflux69",
            "mixed_port": 63486,
            "exit_ip": "203.0.113.7",
            "latency_ms": 252,
        }));
        assert!(text.starts_with("已连接"), "{text}");
        assert!(text.contains("127.0.0.1:63486"), "{text}");
        assert!(text.contains("203.0.113.7"), "{text}");
        assert!(text.contains("252ms"), "{text}");
    }

    #[test]
    fn a_proxy_connection_without_exit_ip_stays_pending() {
        let text = connect_summary(&json!({
            "mode": "system_proxy",
            "config_name": "C",
            "mixed_port": 7890,
            "exit_ip": null,
        }));
        assert!(text.contains("仍在探测中"), "{text}");
    }

    /// helper 只等 sing-box 起来，不等 TUN 设备。没看到设备就不能说接管了。
    #[test]
    fn a_tun_start_without_a_device_never_claims_takeover() {
        let text = connect_summary(&json!({
            "mode": "tun",
            "config_name": "C",
            "routing_mode": "proxy_all",
            "mixed_port": null,
            "tun_device_up": false,
        }));
        assert!(text.contains("还没确认接管"), "{text}");
        assert!(!text.contains("全部"), "设备没起来不能声称任何接管：{text}");
        assert!(
            !text.starts_with("已连接"),
            "TUN 只能说「已启动」，不能说「已连接」：{text}"
        );
    }

    #[test]
    fn proxy_all_with_the_device_and_route_up_may_claim_full_takeover() {
        let text = connect_summary(&json!({
            "mode": "tun",
            "config_name": "C",
            "routing_mode": "proxy_all",
            "mixed_port": null,
            "tun_device_up": true,
            "tun_default_route": true,
        }));
        assert!(text.contains("全部流量已接管"), "{text}");
        assert!(text.contains("出口尚未确认"), "{text}");
    }

    /// 设备在、默认路由没指过来：流量可能还从物理网卡出去，不能说「全部」。
    #[test]
    fn a_device_without_the_default_route_is_not_full_takeover() {
        let text = connect_summary(&json!({
            "mode": "tun",
            "config_name": "C",
            "routing_mode": "proxy_all",
            "tun_device_up": true,
            "tun_default_route": false,
        }));
        assert!(!text.contains("全部流量已接管"), "{text}");
        assert!(text.contains("接管尚未确认"), "{text}");
    }

    /// 未采集（null）不是「设备没出现」：不能说设备没起来，更不能说已经接管。
    #[test]
    fn an_uncollected_device_state_is_not_reported_as_missing() {
        let text = connect_summary(&json!({
            "mode": "tun",
            "config_name": "C",
            "routing_mode": "proxy_all",
            "tun_device_up": null,
            "tun_default_route": null,
        }));
        assert!(text.contains("未采集"), "{text}");
        assert!(!text.contains("没看到 TUN 设备"), "{text}");
        assert!(text.contains("不要告诉用户已经接管"), "{text}");
    }

    /// 默认路由未采集时，也不能断言「还没指过来」。
    #[test]
    fn an_uncollected_default_route_is_not_a_negative_claim() {
        let text = connect_summary(&json!({
            "mode": "tun",
            "config_name": "C",
            "routing_mode": "proxy_all",
            "tun_device_up": true,
            "tun_default_route": null,
        }));
        assert!(text.contains("默认路由状态未采集"), "{text}");
        assert!(!text.contains("还没指过来"), "{text}");
        assert!(!text.contains("全部流量已接管"), "{text}");
    }

    /// 只接管选定服务时，「全部」这两个字一次都不能出现。
    #[test]
    fn proxy_selected_never_claims_all_traffic() {
        let text = connect_summary(&json!({
            "mode": "tun",
            "config_name": "C",
            "routing_mode": "proxy_selected",
            "mixed_port": null,
            "tun_device_up": true,
        }));
        assert!(!text.contains("全部"), "{text}");
        assert!(text.contains("按分流规则接管选定服务"), "{text}");
    }

    #[test]
    fn a_direct_routing_mode_does_not_pretend_traffic_goes_through_the_vpn() {
        let text = connect_summary(&json!({
            "mode": "tun",
            "config_name": "C",
            "routing_mode": "direct",
            "tun_device_up": true,
        }));
        assert!(text.contains("没有走进 VPN"), "{text}");
        assert!(!text.contains("全部流量已接管"), "{text}");
    }

    /// 服务确认回滚过 → restored；完全没动 → none；没信号才 unknown。
    #[test]
    fn a_connect_failure_uses_the_service_rollback_signal() {
        let with = |signal: Option<&str>| {
            let details = signal.map(|value| json!({ "connect_changed": value }));
            anyhow::Error::new(ServiceError {
                code: "RUNTIME_EXITED".to_string(),
                message: "启动失败".to_string(),
                retryable: false,
                details,
            })
        };

        assert_eq!(connect_failure(&with(Some("restored"))), Changed::Restored);
        assert_eq!(connect_failure(&with(Some("none"))), Changed::None);
        assert_eq!(connect_failure(&with(None)), Changed::Unknown);
        assert_eq!(
            connect_failure(&with(Some("unknown"))),
            Changed::Unknown
        );
    }

    /// 代理没恢复却报成功，会让用户以为网络正常；必须是失败。
    #[test]
    fn a_disconnect_without_proxy_restore_is_a_failure() {
        let outcome = disconnect_outcome(json!({ "system_proxy_restored": false }));
        assert!(!outcome.ok, "代理没恢复不能算成功");
        assert_eq!(outcome.display.changed, Changed::Unknown);
        assert!(outcome.display.facts.is_empty(), "{:?}", outcome.display.facts);
        assert_eq!(outcome.next_actions.len(), 1);
        assert_eq!(outcome.next_actions[0].tool, "NetRepair");
        assert_eq!(outcome.next_actions[0].args["action"], "restore_direct");
        assert!(outcome.error.is_some());
    }

    #[test]
    fn a_clean_disconnect_reports_no_change_on_success() {
        let outcome = disconnect_outcome(json!({ "system_proxy_restored": true }));
        assert!(outcome.ok);
        assert_eq!(outcome.display.changed, Changed::None);
        assert_eq!(
            outcome.display.facts,
            vec![Fact::with_params(
                FactKey::ConnectionState,
                json!({ "state": "restored" })
            )]
        );
    }
}

pub struct VpnDisconnectTool {
    services: Arc<dyn VpnToolServices>,
}

impl VpnDisconnectTool {
    pub fn new(services: Arc<dyn VpnToolServices>) -> Self {
        Self { services }
    }
}

#[async_trait]
impl Tool for VpnDisconnectTool {
    fn name(&self) -> &str {
        "VpnDisconnect"
    }

    fn description(&self) -> &str {
        "断开当前连接并恢复系统代理设置。已是未连接状态时为幂等成功。\n说「已经断开，网络恢复直连」。"
    }

    fn permission_level(&self) -> PermissionLevel {
        PermissionLevel::Write
    }

    fn input_schema(&self) -> Value {
        json!({ "type": "object", "properties": {}, "additionalProperties": false })
    }

    async fn execute(&self, _input: Value, ctx: &ToolContext) -> ToolResult {
        let outcome = match self.services.vpn_disconnect().await {
            Ok(data) => disconnect_outcome(data),
            Err(error) => ToolOutcome::fail(AivpnError::new("INTERNAL", error.to_string()))
                .with_display(Vec::new(), Changed::Unknown),
        };
        envelope::finish(ctx, "VpnDisconnect", outcome)
    }
}

/// 断开成功但代理没恢复，对用户就是失败：系统代理还可能指向已关闭的端口。
fn disconnect_outcome(data: Value) -> ToolOutcome {
    let restored = data
        .get("system_proxy_restored")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    if restored {
        return ToolOutcome::ok("已断开，系统代理已恢复。", data).with_display(
            vec![Fact::with_params(
                FactKey::ConnectionState,
                json!({ "state": "restored" }),
            )],
            Changed::None,
        );
    }

    ToolOutcome::fail(
        AivpnError::new("INTERNAL", "已断开，但系统代理没有恢复")
            .with_details(json!({ "reason": "proxy_not_restored" })),
    )
    .with_display(Vec::new(), Changed::Unknown)
    .with_next(NextAction {
        label: "恢复网络".to_string(),
        tool: "NetRepair".to_string(),
        args: json!({ "action": "restore_direct" }),
    })
}
