//! 把服务端下发的 sing-box 配置装配成 veyl-cli 自己的运行时配置。
//!
//! 规则见 `client/docs/client-apps-technical.md` §3.2：**只改必须改的三处**
//! （`inbounds`、`experimental`、`log`），其余字段原样保留——服务端模板已经过
//! 真机验收（TUN、DNS、规则顺序都踩过坑），自己重拼会丢掉那些结论。
//!
//! 动态值（Clash API 端口与 secret）由调用方传入：连接时重新分配，**不能**
//! 把某次分配的端口当成持久真值。

use serde_json::{json, Map, Value};

use crate::error::{AppError, AppResult};
use crate::models::NodeBrief;
use crate::platform;

/// `outbounds` 里这些类型不是「节点」：出口、拦截、DNS，以及两个把别人编组的
/// 出站（selector / urltest）。节点数指真正能承载流量的节点。
const NON_NODE_TYPES: [&str; 5] = ["direct", "block", "dns", "selector", "urltest"];

pub struct ConnectParams {
    pub clash_port: u16,
    pub clash_secret: String,
}

#[derive(Debug)]
pub struct Assembled {
    pub runtime: Value,
    pub nodes: Vec<NodeBrief>,
}

/// 解析成 JSON 对象；不是对象直接拒绝。
pub fn parse(raw: &str) -> AppResult<Value> {
    let value: Value = serde_json::from_str(raw).map_err(|error| {
        AppError::new("CONFIG_INVALID", format!("配置不是合法 JSON：{error}"))
            .with_hint("重新导入一份 sing-box 配置。")
    })?;
    if !value.is_object() {
        return Err(AppError::new("CONFIG_INVALID", "配置必须是一个 JSON 对象")
            .with_hint("重新导入一份 sing-box 配置。"));
    }
    Ok(value)
}

/// 结构校验（§3.2 的第一道门）。零节点允许导入，但不允许带 DNS。
pub fn validate_structure(config: &Value) -> AppResult<()> {
    let outbounds = config
        .get("outbounds")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            AppError::new("CONFIG_INVALID", "配置里没有 outbounds")
                .with_hint("重新导入一份 sing-box 配置。")
        })?;

    let tags: Vec<&str> = outbounds
        .iter()
        .filter_map(|outbound| outbound.get("tag").and_then(Value::as_str))
        .collect();

    if let Some(final_tag) = config
        .get("route")
        .and_then(|route| route.get("final"))
        .and_then(Value::as_str)
    {
        if !tags.contains(&final_tag) {
            return Err(AppError::new(
                "CONFIG_INVALID",
                format!("route.final 指向了不存在的出站：{final_tag}"),
            )
            .with_hint("这份配置在服务端就已经不一致，联系支持或重新导出。"));
        }
    }

    if let Some(servers) = config
        .get("dns")
        .and_then(|dns| dns.get("servers"))
        .and_then(Value::as_array)
    {
        for detour in servers
            .iter()
            .filter_map(|server| server.get("detour").and_then(Value::as_str))
        {
            if !tags.contains(&detour) {
                return Err(AppError::new(
                    "CONFIG_INVALID",
                    format!("DNS 的 detour 指向了不存在的出站：{detour}"),
                )
                .with_hint("这份配置在服务端就已经不一致，联系支持或重新导出。"));
            }
        }
    }

    if nodes_of(config).is_empty() && config.get("dns").is_some() {
        return Err(AppError::new(
            "CONFIG_INVALID",
            "没有可用节点，但配置里带了 DNS",
        )
        .with_hint("回桌面端确认账户下还有可用服务器。"));
    }

    Ok(())
}

/// 代理节点（排除 direct / block / dns）。
pub fn nodes_of(config: &Value) -> Vec<NodeBrief> {
    config
        .get("outbounds")
        .and_then(Value::as_array)
        .map(|outbounds| {
            outbounds
                .iter()
                .filter_map(|outbound| {
                    let tag = outbound.get("tag").and_then(Value::as_str)?;
                    let kind = outbound.get("type").and_then(Value::as_str)?;
                    if NON_NODE_TYPES.contains(&kind) {
                        return None;
                    }
                    Some(NodeBrief {
                        tag: tag.to_string(),
                        kind: kind.to_string(),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// 装配。零节点时返回错误——没有代理出站的配置不能启动。
pub fn assemble(config: &Value, params: &ConnectParams) -> AppResult<Assembled> {
    validate_structure(config)?;

    let nodes = nodes_of(config);
    if nodes.is_empty() {
        return Err(AppError::new("NO_NODES", "这套配置里没有可用节点")
            .with_hint("回桌面端确认账户下还有可用服务器，然后刷新。"));
    }

    let mut runtime = config.clone();
    let object = runtime
        .as_object_mut()
        .ok_or_else(|| AppError::new("CONFIG_INVALID", "配置必须是一个 JSON 对象"))?;

    object.insert("inbounds".into(), Value::Array(vec![tun_inbound(config)]));
    object.insert("experimental".into(), clash_api(params));
    object.insert(
        "log".into(),
        json!({"level": "warn", "timestamp": true}),
    );

    // 没有它，TUN 不接管默认路由：表现是「已连接但流量为 0」。
    let route = object
        .entry("route")
        .or_insert_with(|| Value::Object(Map::new()));
    if let Some(route) = route.as_object_mut() {
        route.insert("auto_detect_interface".into(), Value::Bool(true));
    }

    Ok(Assembled { runtime, nodes })
}

/// 取服务端模板里的 TUN 入站，改掉必须改的字段；模板没有就补一个最小的。
fn tun_inbound(config: &Value) -> Value {
    let template = config
        .get("inbounds")
        .and_then(Value::as_array)
        .and_then(|inbounds| {
            inbounds
                .iter()
                .find(|inbound| inbound.get("type").and_then(Value::as_str) == Some("tun"))
                .cloned()
        })
        .unwrap_or_else(|| json!({"type": "tun", "tag": "tun-in"}));

    let mut inbound = template.as_object().cloned().unwrap_or_default();
    inbound.insert("type".into(), Value::String("tun".into()));
    if !inbound.contains_key("tag") {
        inbound.insert("tag".into(), Value::String("tun-in".into()));
    }
    inbound.insert(
        "address".into(),
        Value::Array(vec![Value::String(platform::tun_address().into())]),
    );
    inbound.insert("stack".into(), Value::String(platform::TUN_STACK.into()));
    inbound.insert("mtu".into(), json!(platform::TUN_MTU));
    inbound.insert("auto_route".into(), Value::Bool(true));
    // 连接期系统解析器指向公网 DNS，查询进 TUN 后由它接管。
    inbound.insert("dns_mode".into(), Value::String("hijack".into()));
    #[cfg(target_os = "windows")]
    {
        // 用 WFP 挡住 TUN 之外的 DNS / 流量泄漏。
        inbound.insert("strict_route".into(), Value::Bool(true));
    }
    Value::Object(inbound)
}

fn clash_api(params: &ConnectParams) -> Value {
    json!({
        "clash_api": {
            "external_controller": format!("{}:{}", platform::CLASH_LISTEN, params.clash_port),
            "secret": params.clash_secret,
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn params() -> ConnectParams {
        ConnectParams {
            clash_port: 19090,
            clash_secret: "preview-secret".into(),
        }
    }

    fn sample() -> Value {
        json!({
            "log": {"level": "info", "output": "/tmp/server.log"},
            "dns": {
                "servers": [{"tag": "dns-remote", "address": "https://1.1.1.1/dns-query", "detour": "proxy"}],
                "final": "dns-remote"
            },
            "inbounds": [
                {"type": "mixed", "tag": "mixed-in", "listen": "127.0.0.1", "listen_port": 7890},
                {"type": "tun", "tag": "server-tun", "address": ["172.19.0.1/30"], "stack": "mixed"}
            ],
            "outbounds": [
                {"type": "selector", "tag": "proxy", "outbounds": ["node-a"], "default": "node-a"},
                {"type": "vless", "tag": "node-a", "server": "a.example.com", "server_port": 443},
                {"type": "hysteria2", "tag": "node-b", "server": "b.example.com", "server_port": 443},
                {"type": "direct", "tag": "direct"}
            ],
            "route": {"final": "proxy", "rules": [{"outbound": "proxy", "domain_suffix": [".example.com"]}]},
            "http_clients": [{"tag": "custom"}],
            "some_future_field": {"kept": true}
        })
    }

    #[test]
    fn keeps_everything_it_does_not_have_to_change() {
        let assembled = assemble(&sample(), &params()).unwrap();
        let runtime = &assembled.runtime;
        assert_eq!(runtime["outbounds"], sample()["outbounds"]);
        assert_eq!(runtime["dns"], sample()["dns"]);
        assert_eq!(runtime["route"]["rules"], sample()["route"]["rules"]);
        assert_eq!(runtime["http_clients"], sample()["http_clients"]);
        assert_eq!(runtime["some_future_field"], sample()["some_future_field"]);
    }

    #[test]
    fn keeps_only_one_tun_inbound_and_rewrites_its_address() {
        let assembled = assemble(&sample(), &params()).unwrap();
        let inbounds = assembled.runtime["inbounds"].as_array().unwrap();
        assert_eq!(inbounds.len(), 1);
        assert_eq!(inbounds[0]["type"], "tun");
        assert_eq!(inbounds[0]["tag"], "server-tun");
        assert_eq!(inbounds[0]["address"][0], platform::tun_address());
        assert_eq!(inbounds[0]["stack"], platform::TUN_STACK);
        assert_eq!(inbounds[0]["mtu"], platform::TUN_MTU);
        assert_eq!(inbounds[0]["auto_route"], true);
        assert_eq!(inbounds[0]["dns_mode"], "hijack");
    }

    #[test]
    fn injects_its_own_clash_api_and_drops_the_servers() {
        let mut config = sample();
        config["experimental"] = json!({"clash_api": {"external_controller": "0.0.0.0:9090"}});
        let assembled = assemble(&config, &params()).unwrap();
        let experimental = &assembled.runtime["experimental"];
        assert_eq!(experimental["clash_api"]["external_controller"], "127.0.0.1:19090");
        assert_eq!(experimental["clash_api"]["secret"], "preview-secret");
        assert_eq!(experimental.as_object().unwrap().len(), 1);
    }

    #[test]
    fn normalizes_log_and_forces_auto_detect_interface() {
        let assembled = assemble(&sample(), &params()).unwrap();
        assert_eq!(assembled.runtime["log"]["level"], "warn");
        assert_eq!(assembled.runtime["log"]["output"], Value::Null);
        assert_eq!(assembled.runtime["route"]["auto_detect_interface"], true);
    }

    #[test]
    fn counts_only_proxy_nodes() {
        let nodes = nodes_of(&sample());
        let tags: Vec<&str> = nodes.iter().map(|node| node.tag.as_str()).collect();
        assert_eq!(tags, vec!["node-a", "node-b"]);
        assert_eq!(nodes[0].kind, "vless");
    }

    #[test]
    fn a_config_without_a_tun_inbound_gets_a_minimal_one() {
        let mut config = sample();
        config["inbounds"] = json!([]);
        let assembled = assemble(&config, &params()).unwrap();
        let inbound = &assembled.runtime["inbounds"][0];
        assert_eq!(inbound["tag"], "tun-in");
        assert_eq!(inbound["address"][0], platform::tun_address());
    }

    #[test]
    fn zero_nodes_is_structure_ok_but_cannot_be_assembled() {
        let config = json!({
            "outbounds": [{"type": "direct", "tag": "direct"}],
            "route": {"final": "direct"}
        });
        validate_structure(&config).unwrap();
        let error = assemble(&config, &params()).unwrap_err();
        assert_eq!(error.code, "NO_NODES");
    }

    #[test]
    fn zero_nodes_with_dns_is_rejected() {
        let config = json!({
            "outbounds": [{"type": "direct", "tag": "direct"}],
            "dns": {"servers": [{"tag": "d", "address": "1.1.1.1"}]}
        });
        let error = validate_structure(&config).unwrap_err();
        assert!(error.message.contains("没有可用节点"));
    }

    #[test]
    fn dangling_route_final_is_rejected() {
        let mut config = sample();
        config["route"]["final"] = json!("missing");
        let error = validate_structure(&config).unwrap_err();
        assert!(error.message.contains("route.final"));
    }

    #[test]
    fn dangling_dns_detour_is_rejected() {
        let mut config = sample();
        config["dns"]["servers"][0]["detour"] = json!("missing");
        let error = validate_structure(&config).unwrap_err();
        assert!(error.message.contains("detour"));
    }

    #[test]
    fn missing_outbounds_is_rejected() {
        let config = json!({"dns": {}});
        let error = validate_structure(&config).unwrap_err();
        assert!(error.message.contains("outbounds"));
    }

    #[test]
    fn a_non_object_config_is_rejected() {
        assert!(parse("[]").is_err());
        assert!(parse("not json").is_err());
        assert!(parse("{}").unwrap().is_object());
    }
}
