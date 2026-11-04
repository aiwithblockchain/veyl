use std::sync::Arc;

use async_trait::async_trait;
use claurst_tools::{PermissionLevel, Tool, ToolContext, ToolResult};
use serde_json::{json, Value};

use super::envelope::{self, AivpnError, NextAction, ToolOutcome};
use super::services::VpnToolServices;

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
         切换当前节点请用 NodeSwitch，不要用本工具。\
         state=running 即已连上；exit_ip 为 null 表示已连接但出口尚未测到，\
         不代表连接失败，可用 RuntimeStatus 再查。"
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
                ToolOutcome::ok(summary, data).with_next(
                    NextAction {
                        label: "断开连接".to_string(),
                        tool: "VpnDisconnect".to_string(),
                        args: json!({}),
                    },
                )
            }
            Err(error) => ToolOutcome::fail(
                AivpnError::new("UPSTREAM_ERROR", error.to_string())
                    .with_details(json!({ "hint": "换一个同地区节点，或运行 DiagRun 诊断" })),
            )
            .with_next(NextAction {
                label: "诊断一下".to_string(),
                tool: "DiagRun".to_string(),
                args: json!({}),
            }),
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
    let device_up = data
        .get("tun_device_up")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let default_route = data
        .get("tun_default_route")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    if !device_up {
        parts.push("但还没确认接管（没看到 TUN 设备），不要告诉用户已经接管".to_string());
    } else if routing == "proxy_all" {
        if default_route {
            parts.push("TUN 设备已就绪、默认路由已指过来，全部流量已接管".to_string());
        } else {
            parts.push(
                "TUN 设备已就绪，但默认路由还没指过来，接管尚未确认，\
                 不要告诉用户已经全部接管"
                    .to_string(),
            );
        }
    } else if routing == "direct" {
        parts.push("TUN 设备已就绪，但当前分流模式是直连，流量没有走进 VPN".to_string());
    } else {
        parts.push("TUN 设备已就绪，按分流规则接管选定服务".to_string());
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
        "断开当前连接并恢复系统代理设置。已是未连接状态时为幂等成功。"
    }

    fn permission_level(&self) -> PermissionLevel {
        PermissionLevel::Write
    }

    fn input_schema(&self) -> Value {
        json!({ "type": "object", "properties": {}, "additionalProperties": false })
    }

    async fn execute(&self, _input: Value, ctx: &ToolContext) -> ToolResult {
        let outcome = match self.services.vpn_disconnect().await {
            Ok(data) => {
                let restored = data
                    .get("system_proxy_restored")
                    .and_then(Value::as_bool)
                    .unwrap_or(true);
                ToolOutcome::ok(
                    if restored {
                        "已断开，系统代理已恢复。"
                    } else {
                        "已断开，但系统代理未能恢复，请检查系统设置。"
                    },
                    data,
                )
            }
            Err(error) => ToolOutcome::fail(AivpnError::new("INTERNAL", error.to_string())),
        };
        envelope::finish(ctx, "VpnDisconnect", outcome)
    }
}
