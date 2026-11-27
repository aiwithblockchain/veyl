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

    // 规则里的 outbound 同样必须是存在的出站：没有内核时这是最后一道网。
    if let Some(rules) = config
        .get("route")
        .and_then(|route| route.get("rules"))
        .and_then(Value::as_array)
    {
        for outbound in rules
            .iter()
            .filter_map(|rule| rule.get("outbound").and_then(Value::as_str))
        {
            if !tags.contains(&outbound) {
                return Err(AppError::new(
                    "CONFIG_INVALID",
                    format!("route.rules 指向了不存在的出站：{outbound}"),
                )
                .with_hint("这份配置在服务端就已经不一致，联系支持或重新导出。"));
            }
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
    // 模板可能带 interface_name。写死名字在 macOS 上是 `bad tun name`（主客户端
    // 实测结论）：留空让系统分配 utunN，Windows 交给 Wintun 自己命名。
    inbound.remove("interface_name");
    inbound.insert(
        "address".into(),
        Value::Array(vec![Value::String(platform::tun_address().into())]),
    );
    inbound.insert("stack".into(), Value::String(platform::TUN_STACK.into()));
    inbound.insert("mtu".into(), json!(platform::TUN_MTU));
    inbound.insert("auto_route".into(), Value::Bool(true));
    // 连接期系统解析器指向公网 DNS，查询进 TUN 后由它接管。
    inbound.insert("dns_mode".into(), Value::String("hijack".into()));
    // 服务端模板里的 dns_address 属于它自己的网段，必须换成本平台网段内的地址；
    // IPv6 不接管，模板里的 v6 项一并丢掉。
    inbound.insert(
        "dns_address".into(),
        Value::Array(vec![Value::String(platform::dns_address().into())]),
    );
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
                {"type": "tun", "tag": "server-tun", "address": ["172.19.0.1/30"], "stack": "mixed", "interface_name": "utun9", "dns_address": ["172.18.0.2", "fdfe:dcba:9876::2"]}
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
        // 服务端模板宣告的 DNS 地址属于它自己的网段，必须换掉，且不再带 IPv6。
        assert_eq!(inbounds[0]["dns_address"], json!([platform::dns_address()]));
        assert!(!inbounds[0]["dns_address"].to_string().contains("172.18.0.2"));
        // 模板里的 interface_name 要丢掉：写死名字在 macOS 上 bad tun name。
        assert!(inbounds[0].get("interface_name").is_none());
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
    fn dangling_rule_outbound_is_rejected() {
        let mut config = sample();
        config["route"]["rules"][0]["outbound"] = json!("missing");
        let error = validate_structure(&config).unwrap_err();
        assert!(error.message.contains("route.rules"), "{}", error.message);
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

// ---------------------------------------------------------------------------
// 交给 helper 的形态
// ---------------------------------------------------------------------------


/// 把装配结果改成交给 helper 的最终形态。
///
/// 三件事只有 helper 能做：注入自己的 clash_api、给规则补本地路径、校验配置。
/// 我们不能把这些字段发过去——发过去会被 allowlist 直接拒绝：
/// - `experimental`：helper 用 `force_clash_api` 覆盖，发过去也没用；
/// - `http_clients` / `route.default_http_client`：只服务远程规则下载，而 helper
///   禁止远程规则；
/// - `inbounds[].dns_address`：不在 helper 的 inbound 白名单里；
/// - `rule_set[]` 的 `type/format/path`：由 helper 按 tag 补。
pub fn for_helper(config: &Value) -> AppResult<Value> {
    let assembled = assemble(
        config,
        &ConnectParams {
            clash_port: 0,
            clash_secret: String::new(),
        },
    )?;
    let mut out = assembled.runtime;
    let object = out
        .as_object_mut()
        .ok_or_else(|| AppError::new("CONFIG_INVALID", "配置必须是一个 JSON 对象"))?;

    object.remove("experimental");
    object.remove("http_clients");

    if let Some(route) = object.get_mut("route").and_then(Value::as_object_mut) {
        route.remove("default_http_client");

        if let Some(entries) = route.get_mut("rule_set").and_then(Value::as_array_mut) {
            let mut rewritten = Vec::with_capacity(entries.len());
            for entry in entries.iter() {
                let tag = entry
                    .get("tag")
                    .and_then(Value::as_str)
                    .ok_or_else(|| {
                        AppError::new("CONFIG_INVALID", "rule_set 缺少 tag")
                            .with_hint("重新导入配置；反复出现就回桌面端重新导出。")
                    })?
                    .to_string();
                rewritten.push(json!({ "tag": tag }));
            }
            *entries = rewritten;
        }

        ensure_transport_rules(route);

        if let Some(unknown) = route
            .keys()
            .find(|key| !veyl_tun::protocol::ROUTE_KEYS.contains(&key.as_str()))
        {
            return Err(AppError::new(
                "CONFIG_FORBIDDEN",
                format!("路由里有这一版客户端还不支持的字段：{unknown}"),
            )
            .with_hint("更新客户端，或回桌面端重新导出配置。"));
        }
    }

    if let Some(inbounds) = object.get_mut("inbounds").and_then(Value::as_array_mut) {
        for inbound in inbounds.iter_mut() {
            if let Some(map) = inbound.as_object_mut() {
                map.remove("dns_address");
            }
        }
    }

    if let Some(unknown) = object
        .keys()
        .find(|key| !veyl_tun::protocol::TOP_LEVEL.contains(&key.as_str()))
    {
        return Err(AppError::new(
            "CONFIG_FORBIDDEN",
            format!("配置顶层有这一版客户端还不支持的字段：{unknown}"),
        )
        .with_hint("更新客户端，或回桌面端重新导出配置。"));
    }

    Ok(out)
}

/// sniff 与 hijack-dns 必须在规则最前面；缺了 DNS 劫持会静默失效。
fn ensure_transport_rules(route: &mut Map<String, Value>) {
    let rules = route
        .entry("rules")
        .or_insert_with(|| Value::Array(Vec::new()));
    let Some(rules) = rules.as_array_mut() else {
        return;
    };

    let action_is = |rule: &Value, action: &str| {
        rule.get("action").and_then(Value::as_str) == Some(action)
    };
    let has_hijack = rules.iter().any(|rule| action_is(rule, "hijack-dns"));
    let has_sniff = rules.iter().any(|rule| action_is(rule, "sniff"));

    if !has_hijack {
        rules.insert(0, json!({ "protocol": "dns", "action": "hijack-dns" }));
    }
    if !has_sniff {
        rules.insert(
            0,
            json!({
                "action": "sniff",
                "sniffer": veyl_tun::SNIFFERS,
                "timeout": veyl_tun::SNIFF_TIMEOUT,
            }),
        );
    }
}

#[cfg(test)]
mod helper_tests {
    use super::*;

    fn routed() -> Value {
        json!({
            "log": {"level": "info"},
            "http_clients": [{"tag": "veyl-download", "detour": "proxy"}],
            "inbounds": [{"type": "tun", "tag": "tun-in", "address": ["172.19.0.1/30"], "dns_address": ["172.18.0.2"]}],
            "outbounds": [
                {"type": "selector", "tag": "proxy", "outbounds": ["node-a"], "default": "node-a"},
                {"type": "vless", "tag": "node-a", "server": "a.example.com", "server_port": 443},
                {"type": "direct", "tag": "direct"}
            ],
            "route": {
                "final": "proxy",
                "default_http_client": "veyl-download",
                "rule_set": [
                    {"type": "remote", "tag": "geosite-cn", "format": "binary", "url": "https://example.com/g.srs"},
                    {"type": "remote", "tag": "geoip-cn", "format": "binary", "url": "https://example.com/i.srs"}
                ],
                "rules": [
                    {"action": "sniff", "sniffer": ["http", "tls", "quic", "dns"], "timeout": "300ms"},
                    {"action": "hijack-dns", "protocol": "dns"},
                    {"action": "route", "rule_set": ["geosite-cn"], "outbound": "direct"}
                ]
            },
            "experimental": {"clash_api": {"external_controller": "0.0.0.0:9090"}}
        })
    }

    #[test]
    fn drops_what_the_helper_rejects_or_overrides() {
        let out = for_helper(&routed()).unwrap();
        assert!(out.get("experimental").is_none(), "helper 会自己注入 clash_api");
        assert!(out.get("http_clients").is_none(), "helper 不允许顶层 http_clients");
        assert!(
            out["route"].get("default_http_client").is_none(),
            "它指向的客户端已经删了"
        );
        assert!(
            out["inbounds"][0].get("dns_address").is_none(),
            "dns_address 不在 helper 的 inbound 白名单里"
        );
    }

    #[test]
    fn rule_sets_become_tags_only() {
        let out = for_helper(&routed()).unwrap();
        assert_eq!(
            out["route"]["rule_set"],
            json!([{"tag": "geosite-cn"}, {"tag": "geoip-cn"}])
        );
    }

    #[test]
    fn unknown_route_keys_are_rejected_with_a_readable_code() {
        let mut config = routed();
        config["route"]["geoip"] = json!({"path": "/tmp/x"});
        let error = for_helper(&config).unwrap_err();
        assert_eq!(error.code, "CONFIG_FORBIDDEN");
        assert!(error.message.contains("geoip"));
    }

    #[test]
    fn unknown_top_level_keys_are_rejected() {
        let mut config = routed();
        config["some_future_field"] = json!(true);
        let error = for_helper(&config).unwrap_err();
        assert_eq!(error.code, "CONFIG_FORBIDDEN");
        assert!(error.message.contains("some_future_field"));
    }

    #[test]
    fn transport_rules_are_guaranteed() {
        let mut config = routed();
        config["route"]["rules"] = json!([{"action": "route", "outbound": "direct"}]);
        let out = for_helper(&config).unwrap();
        let rules = out["route"]["rules"].as_array().unwrap();
        assert_eq!(rules[0]["action"], "sniff");
        assert_eq!(rules[1]["action"], "hijack-dns");
    }

    #[test]
    fn zero_nodes_still_cannot_be_assembled() {
        let config = json!({
            "outbounds": [{"type": "direct", "tag": "direct"}],
            "route": {"final": "direct"}
        });
        assert_eq!(for_helper(&config).unwrap_err().code, "NO_NODES");
    }
}
