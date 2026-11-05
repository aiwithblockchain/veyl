//! XPC 协议与**由 root 消费的配置**的校验规则。
//!
//! 这份文件同时被主程序与特权 helper 编译（helper 用 `#[path]` 引入），
//! 只依赖 std + serde_json，不碰任何平台 API。
//!
//! 核心前提：**请求里不出现任何可执行文件路径，也不出现任何由 root 落盘的路径。**
//! 能验签证明「请求来自我们签名的 App」还不够——webview 里跑的 JS 没被验过，
//! Tauri 的命令通道也不认证调用方。所以这里假设 App 可能让它做傻事，
//! 凡是会产生副作用的字段一律不采信。

use std::collections::HashMap;
use std::path::PathBuf;

use serde_json::{json, Map, Value};

pub const MACH_SERVICE: &str = "com.veyl.helper";

/// 配置内容上限。真实配置 10 KB 上下，512 KB 留足余量又不至于被塞爆内存。
pub const MAX_CONFIG_BYTES: usize = 512 * 1024;

pub const ERR_BAD_REQUEST: &str = "bad_request";
pub const ERR_CONFIG_TOO_LARGE: &str = "config_too_large";
pub const ERR_CONFIG_INVALID: &str = "config_invalid";
pub const ERR_CONFIG_FORBIDDEN: &str = "config_forbidden";
pub const ERR_RULE_SET_MISSING: &str = "rule_set_missing";
pub const ERR_RUNTIME_MISSING: &str = "runtime_missing";
pub const ERR_INTERNAL: &str = "internal";
pub const ERR_TUN_START_FAILED: &str = "tun_start_failed";
/// `restart` 在 start 进行中会被拒绝；调用方稍后重试。
pub const ERR_PRECONDITION_FAILED: &str = "precondition_failed";

/// 从 `tauri.conf.json` 编译进来的 bundle identifier（见 `build.rs`）。
/// 不要在别处再写一遍字面量——写错一次就是所有 XPC 连接被拒。
pub const BUNDLE_IDENTIFIER: &str = env!("VEYL_BUNDLE_IDENTIFIER");
pub const TEAM_ID: &str = env!("VEYL_TEAM_ID");

/// helper 用来判定「对端是不是我们签名的 App」的 designated requirement。
pub fn app_requirement() -> String {
    format!(
        "anchor apple generic and identifier \"{BUNDLE_IDENTIFIER}\" and certificate leaf[subject.OU] = \"{TEAM_ID}\""
    )
}

// ---------------------------------------------------------------------------
// 白名单
//
// denylist 永远漏一个。配置由 root 消费，只放行我们生成器真的会产出的字段，
// 其余一律拒绝，并在错误里点名是哪一段的哪个键。
// ---------------------------------------------------------------------------

const TOP_LEVEL: &[&str] = &[
    "log",
    "dns",
    "inbounds",
    "outbounds",
    "route",
    "experimental",
];
// `output` 放行进来是为了**删掉它**：由 force_log 处理，不是采信它的值。
const LOG_KEYS: &[&str] = &["level", "timestamp", "disabled", "output"];
const INBOUND_KEYS: &[&str] = &[
    "type",
    "tag",
    "address",
    "auto_route",
    "route_exclude_address",
    "mtu",
    "stack",
    "strict_route",
];
const OUTBOUND_KEYS: &[&str] = &[
    "type",
    "tag",
    "server",
    "server_port",
    "method",
    "password",
    "uuid",
    "flow",
    "tls",
    "outbounds",
    "default",
    "multiplex",
];
const OUTBOUND_TYPES: &[&str] = &["shadowsocks", "vless", "hysteria2", "selector", "direct"];
const TLS_KEYS: &[&str] = &["enabled", "server_name", "insecure", "utls", "reality"];
const DNS_KEYS: &[&str] = &["servers", "rules", "final", "strategy", "independent_cache"];
const DNS_SERVER_KEYS: &[&str] = &["type", "tag", "server", "detour"];
const DNS_SERVER_TYPES: &[&str] = &["udp", "tcp", "tls", "https", "quic", "h3"];
const DNS_RULE_KEYS: &[&str] = &[
    "rule_set",
    "server",
    "action",
    "domain",
    "domain_suffix",
    "domain_keyword",
];
const ROUTE_KEYS: &[&str] = &[
    "rules",
    "rule_set",
    "final",
    "auto_detect_interface",
    "default_domain_resolver",
];
// `path` 放行进来是为了**覆盖它**：最终值由 helper 按 tag 算，见 reject_remote_rule_sets。
const RULE_SET_KEYS: &[&str] = &["tag", "type", "format", "path"];
const RULE_KEYS: &[&str] = &[
    "action",
    "outbound",
    "protocol",
    "sniffer",
    "timeout",
    "rule_set",
    "ip_is_private",
    "domain",
    "domain_suffix",
    "domain_keyword",
    "ip_cidr",
    "port",
];
const EXPERIMENTAL_KEYS: &[&str] = &["clash_api"];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProtocolError {
    pub code: &'static str,
    pub message: String,
}

impl ProtocolError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

impl std::fmt::Display for ProtocolError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

/// 运行时只认 helper 自己编译进来的完整 sha256。请求方说了不算。
///
/// 返回 `None` 表示这份构建里没有随包运行时——helper 会在 start 时报
/// `runtime_missing`，而不是去猜一个路径。
#[cfg(unix)]
pub fn runtime_sha256() -> Option<&'static str> {
    let digest = env!("VEYL_RUNTIME_SHA256");
    super::trust::is_full_sha256(digest).then_some(digest)
}

/// 规则归档的 sha256，由 `build.rs` 从**构建时那个归档**算出来。
///
/// 这是一个**有效的构建期绑定**：哈希编进 helper 二进制，helper 又被签名，
/// 所以构建完成之后再替换包里的归档会被发现。
///
/// 但它不是「来源可信」的证明——哈希是从归档本身算出来的，构建期就被换掉的话验不出来。
/// 真正的信任根是签名封存 bundle，以及 SMAppService 启动 helper 时对 helper 的验签
/// （见 `docs/tun-privilege.md`）。
///
/// 它的作用是让 helper 不必从包里读 manifest 再自证：先认这个值，再认归档里的清单。
#[cfg(unix)]
pub fn rules_archive_sha256() -> Option<&'static str> {
    let digest = env!("VEYL_RULES_ARCHIVE_SHA256");
    super::trust::is_full_sha256(digest).then_some(digest)
}

/// 把 App 送来的配置改写成**由 helper 决定路径**的版本。
///
/// 改写而不是「校验后原样使用」：请求里的路径即使看起来合法，也在用户可写的地盘上。
/// 这里只认 `tag`，文件从 `rules_dir` 里取，取不到就报错，不猜。
pub fn prepare_config(
    raw: &str,
    rules: &HashMap<String, PathBuf>,
    clash_port: u16,
    clash_secret: &str,
) -> Result<Value, ProtocolError> {
    if raw.len() > MAX_CONFIG_BYTES {
        return Err(ProtocolError::new(
            ERR_CONFIG_TOO_LARGE,
            format!("配置 {} 字节，超过上限 {}", raw.len(), MAX_CONFIG_BYTES),
        ));
    }

    let mut root: Value = serde_json::from_str(raw).map_err(|error| {
        ProtocolError::new(ERR_CONFIG_INVALID, format!("配置不是合法 JSON：{error}"))
    })?;
    let object = root
        .as_object_mut()
        .ok_or_else(|| ProtocolError::new(ERR_CONFIG_INVALID, "配置必须是一个 JSON 对象"))?;

    enforce_allowlist(object)?;
    force_log(object);
    reject_remote_rule_sets(object, rules)?;
    force_clash_api(object, clash_port, clash_secret)?;
    require_tun_only(object)?;

    Ok(root)
}

/// 只放行生成器真的会产出的字段。任何多余键都是拒绝，不是忽略——
/// 忽略等于让它静静地影响 root 进程的行为。
fn enforce_allowlist(object: &Map<String, Value>) -> Result<(), ProtocolError> {
    deny_unknown(object, TOP_LEVEL, "顶层")?;

    if let Some(log) = object.get("log").and_then(|value| value.as_object()) {
        deny_unknown(log, LOG_KEYS, "log")?;
    }

    if let Some(items) = object.get("inbounds").and_then(|value| value.as_array()) {
        for item in items {
            let map = item.as_object().ok_or_else(|| {
                ProtocolError::new(ERR_CONFIG_INVALID, "inbounds 的每一项都必须是对象")
            })?;
            deny_unknown(map, INBOUND_KEYS, "inbounds")?;
        }
    }

    if let Some(items) = object.get("outbounds").and_then(|value| value.as_array()) {
        for item in items {
            let map = item.as_object().ok_or_else(|| {
                ProtocolError::new(ERR_CONFIG_INVALID, "outbounds 的每一项都必须是对象")
            })?;
            deny_unknown(map, OUTBOUND_KEYS, "outbounds")?;
            let kind = map
                .get("type")
                .and_then(|value| value.as_str())
                .unwrap_or("");
            if !OUTBOUND_TYPES.contains(&kind) {
                return Err(ProtocolError::new(
                    ERR_CONFIG_FORBIDDEN,
                    format!("outbounds 不支持的类型：{kind}"),
                ));
            }
            if let Some(tls) = map.get("tls").and_then(|value| value.as_object()) {
                deny_unknown(tls, TLS_KEYS, "outbounds.tls")?;
            }
            if let Some(multiplex) = map.get("multiplex").and_then(|value| value.as_object()) {
                deny_unknown(
                    multiplex,
                    &["enabled", "protocol", "max_connections"],
                    "outbounds.multiplex",
                )?;
            }
        }
    }

    if let Some(dns) = object.get("dns").and_then(|value| value.as_object()) {
        deny_unknown(dns, DNS_KEYS, "dns")?;
        if let Some(servers) = dns.get("servers").and_then(|value| value.as_array()) {
            for server in servers {
                let map = server.as_object().ok_or_else(|| {
                    ProtocolError::new(ERR_CONFIG_INVALID, "dns.servers 的每一项都必须是对象")
                })?;
                deny_unknown(map, DNS_SERVER_KEYS, "dns.servers")?;
                let kind = map
                    .get("type")
                    .and_then(|value| value.as_str())
                    .unwrap_or("");
                if !DNS_SERVER_TYPES.contains(&kind) {
                    return Err(ProtocolError::new(
                        ERR_CONFIG_FORBIDDEN,
                        format!("dns.servers 不支持的类型：{kind}"),
                    ));
                }
            }
        }
        if let Some(rules) = dns.get("rules").and_then(|value| value.as_array()) {
            for rule in rules {
                let map = rule.as_object().ok_or_else(|| {
                    ProtocolError::new(ERR_CONFIG_INVALID, "dns.rules 的每一项都必须是对象")
                })?;
                deny_unknown(map, DNS_RULE_KEYS, "dns.rules")?;
            }
        }
    }

    if let Some(route) = object.get("route").and_then(|value| value.as_object()) {
        deny_unknown(route, ROUTE_KEYS, "route")?;
        if let Some(entries) = route.get("rule_set").and_then(|value| value.as_array()) {
            for entry in entries {
                let map = entry.as_object().ok_or_else(|| {
                    ProtocolError::new(ERR_CONFIG_INVALID, "route.rule_set 的每一项都必须是对象")
                })?;
                deny_unknown(map, RULE_SET_KEYS, "route.rule_set")?;
            }
        }
        if let Some(rules) = route.get("rules").and_then(|value| value.as_array()) {
            for rule in rules {
                let map = rule.as_object().ok_or_else(|| {
                    ProtocolError::new(ERR_CONFIG_INVALID, "route.rules 的每一项都必须是对象")
                })?;
                deny_unknown(map, RULE_KEYS, "route.rules")?;
            }
        }
    }

    if let Some(experimental) = object
        .get("experimental")
        .and_then(|value| value.as_object())
    {
        deny_unknown(experimental, EXPERIMENTAL_KEYS, "experimental")?;
    }

    Ok(())
}

/// 任何以 `_path` / `_file` 结尾的键、以及白名单外的键，全部拒绝。
fn deny_unknown(
    map: &Map<String, Value>,
    allowed: &[&str],
    where_: &str,
) -> Result<(), ProtocolError> {
    for key in map.keys() {
        if allowed.contains(&key.as_str()) {
            continue;
        }
        let hint =
            if key.ends_with("_path") || key.ends_with("_file") || key.contains("certificate") {
                "（这类字段会把 root 的文件读写指到别处）"
            } else {
                ""
            };
        return Err(ProtocolError::new(
            ERR_CONFIG_FORBIDDEN,
            format!("{where_} 不允许字段 {key}{hint}"),
        ));
    }
    Ok(())
}

/// `log.output` 决定 root 往哪写文件。不采信请求方的值，直接删掉；
/// helper 用重定向把输出写进自己的固定日志。
fn force_log(object: &mut Map<String, Value>) {
    if let Some(log) = object
        .get_mut("log")
        .and_then(|value| value.as_object_mut())
    {
        log.remove("output");
    }
}

fn rule_set_entries(object: &mut Map<String, Value>) -> Option<&mut Vec<Value>> {
    object
        .get_mut("route")?
        .as_object_mut()?
        .get_mut("rule_set")?
        .as_array_mut()
}

/// 规则集只认 `tag`。任何远程引用直接拒绝——否则就是**以 root 身份做的 SSRF**。
/// 规则集只认 `tag`，最终路径由 helper 给的索引决定——请求方连「哪个文件」都决定不了。
fn reject_remote_rule_sets(
    object: &mut Map<String, Value>,
    rules: &HashMap<String, PathBuf>,
) -> Result<(), ProtocolError> {
    let Some(entries) = rule_set_entries(object) else {
        return Ok(());
    };

    for entry in entries.iter_mut() {
        let Some(map) = entry.as_object_mut() else {
            return Err(ProtocolError::new(
                ERR_CONFIG_INVALID,
                "rule_set 里的每一项都必须是对象",
            ));
        };
        for forbidden in ["url", "http_client", "download_detour"] {
            if map.contains_key(forbidden) {
                return Err(ProtocolError::new(
                    ERR_CONFIG_FORBIDDEN,
                    format!("rule_set 不允许远程引用（{forbidden}）。规则数据由 helper 自己提供"),
                ));
            }
        }
        let tag = map
            .get("tag")
            .and_then(|value| value.as_str())
            .ok_or_else(|| ProtocolError::new(ERR_CONFIG_INVALID, "rule_set 缺少 tag"))?
            .to_string();

        if tag.contains('/') || tag.contains('\\') || tag.contains("..") {
            return Err(ProtocolError::new(
                ERR_CONFIG_FORBIDDEN,
                format!("rule_set tag 含路径成分：{tag}"),
            ));
        }

        let path = rules.get(&tag).ok_or_else(|| {
            ProtocolError::new(ERR_RULE_SET_MISSING, format!("缺少规则数据：{tag}"))
        })?;
        // 请求里的 path 一律丢弃，用我们算出来的。
        map.insert("path".into(), json!(path.to_string_lossy().to_string()));
        map.insert("type".into(), json!("local"));
        map.insert("format".into(), json!("binary"));
    }
    Ok(())
}

/// Clash API 是控制面。只允许回环，secret 由 helper 决定。
fn force_clash_api(
    object: &mut Map<String, Value>,
    port: u16,
    secret: &str,
) -> Result<(), ProtocolError> {
    if port == 0 {
        return Err(ProtocolError::new(ERR_BAD_REQUEST, "clash 端口不能为 0"));
    }
    let experimental = object.entry("experimental").or_insert_with(|| json!({}));
    let Some(experimental) = experimental.as_object_mut() else {
        return Err(ProtocolError::new(
            ERR_CONFIG_INVALID,
            "experimental 必须是对象",
        ));
    };
    experimental.insert(
        "clash_api".into(),
        json!({
            "external_controller": format!("127.0.0.1:{port}"),
            "secret": secret,
        }),
    );
    Ok(())
}

/// 只接受 tun 入站。请求里出现 mixed/http/socks 等其它入站一律拒绝——
/// 那会在用户不知情时多开一个监听。
fn require_tun_only(object: &mut Map<String, Value>) -> Result<(), ProtocolError> {
    let inbounds = object
        .get("inbounds")
        .and_then(|value| value.as_array())
        .ok_or_else(|| ProtocolError::new(ERR_CONFIG_INVALID, "配置缺少 inbounds"))?;
    if inbounds.is_empty() {
        return Err(ProtocolError::new(ERR_CONFIG_INVALID, "配置没有入站"));
    }
    for inbound in inbounds {
        let kind = inbound
            .get("type")
            .and_then(|value| value.as_str())
            .unwrap_or_default();
        if kind != "tun" {
            return Err(ProtocolError::new(
                ERR_CONFIG_FORBIDDEN,
                format!("接管模式下只接受 tun 入站，收到 {kind}"),
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    type Rules = HashMap<String, PathBuf>;

    fn rules_dir(tags: &[&str]) -> (std::path::PathBuf, Rules) {
        let dir = std::env::temp_dir().join(format!("veyl-proto-{:016x}", rand::random::<u64>()));
        fs::create_dir_all(&dir).unwrap();
        let mut map = HashMap::new();
        for tag in tags {
            let path = dir.join(format!("{tag}.srs"));
            fs::write(&path, b"x").unwrap();
            map.insert((*tag).to_string(), path);
        }
        (dir, map)
    }

    fn tun_config(rule_sets: Value) -> String {
        json!({
            "log": {"level": "info", "output": "/etc/evil.log"},
            "inbounds": [{"type": "tun", "tag": "tun-in", "address": ["172.19.0.1/30"]}],
            "outbounds": [{"type": "direct", "tag": "direct"}],
            "route": {"rule_set": rule_sets, "rules": [], "final": "direct"},
            "experimental": {"clash_api": {"external_controller": "0.0.0.0:9999", "secret": "x"}}
        })
        .to_string()
    }

    #[test]
    fn strips_log_output_because_root_would_write_it() {
        let (dir, rules) = rules_dir(&[]);
        let config = prepare_config(&tun_config(json!([])), &rules, 19090, "s").unwrap();
        assert!(
            config["log"].get("output").is_none(),
            "root 不能按请求方给的路径写文件"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn forces_clash_api_onto_loopback_with_our_secret() {
        let (dir, rules) = rules_dir(&[]);
        let config =
            prepare_config(&tun_config(json!([])), &rules, 19090, "helper-secret").unwrap();
        assert_eq!(
            config["experimental"]["clash_api"]["external_controller"],
            "127.0.0.1:19090"
        );
        assert_eq!(
            config["experimental"]["clash_api"]["secret"], "helper-secret",
            "secret 不能采信请求方的值"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn rejects_remote_rule_sets() {
        let (dir, rules) = rules_dir(&[]);
        for forbidden in ["url", "http_client", "download_detour"] {
            let mut entry = json!({"tag": "geosite-cn", "type": "remote"});
            entry[forbidden] = json!("http://evil.example/x.srs");
            let error =
                prepare_config(&tun_config(json!([entry])), &rules, 19090, "s").unwrap_err();
            assert_eq!(
                error.code, ERR_CONFIG_FORBIDDEN,
                "root 去拉远程规则就是以 root 做 SSRF（{forbidden}）"
            );
        }
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn rewrites_the_rule_set_path_from_its_tag() {
        let (dir, rules) = rules_dir(&["geosite-cn"]);
        let entry = json!({"tag": "geosite-cn", "type": "local", "path": "/Users/x/.ssh/id_rsa"});
        let config = prepare_config(&tun_config(json!([entry])), &rules, 19090, "s").unwrap();
        let rewritten = config["route"]["rule_set"][0]["path"].as_str().unwrap();
        assert_eq!(rewritten, dir.join("geosite-cn.srs").to_string_lossy());
        assert!(
            !rewritten.contains("id_rsa"),
            "请求里的 path 必须被丢弃，不是被校验"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_missing_rule_set_is_reported_not_guessed() {
        let (dir, rules) = rules_dir(&[]);
        let entry = json!({"tag": "geosite-cn", "type": "local"});
        let error = prepare_config(&tun_config(json!([entry])), &rules, 19090, "s").unwrap_err();
        assert_eq!(error.code, ERR_RULE_SET_MISSING);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_tag_with_path_components_is_rejected() {
        let (dir, rules) = rules_dir(&[]);
        let entry = json!({"tag": "../../etc/passwd", "type": "local"});
        let error = prepare_config(&tun_config(json!([entry])), &rules, 19090, "s").unwrap_err();
        assert_eq!(error.code, ERR_CONFIG_FORBIDDEN);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn rejects_non_tun_inbounds() {
        let (dir, rules) = rules_dir(&[]);
        let mut config: Value = serde_json::from_str(&tun_config(json!([]))).unwrap();
        config["inbounds"] = json!([
            {"type": "tun", "tag": "a"},
            {"type": "mixed", "listen": "0.0.0.0", "listen_port": 1080}
        ]);
        let error = prepare_config(&config.to_string(), &rules, 19090, "s").unwrap_err();
        assert_eq!(error.code, ERR_CONFIG_FORBIDDEN, "不能悄悄多开一个监听");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn rejects_oversized_and_malformed_payloads() {
        let (dir, rules) = rules_dir(&[]);
        let huge = "x".repeat(MAX_CONFIG_BYTES + 1);
        assert_eq!(
            prepare_config(&huge, &rules, 19090, "s").unwrap_err().code,
            ERR_CONFIG_TOO_LARGE
        );
        assert_eq!(
            prepare_config("{not json", &rules, 19090, "s")
                .unwrap_err()
                .code,
            ERR_CONFIG_INVALID
        );
        assert_eq!(
            prepare_config("[]", &rules, 19090, "s").unwrap_err().code,
            ERR_CONFIG_INVALID
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn allowlist_rejects_fields_that_give_root_side_effects() {
        let (dir, rules) = rules_dir(&[]);

        // 顶层多一个 v2ray_api
        let mut config: Value = serde_json::from_str(&tun_config(json!([]))).unwrap();
        config["v2ray_api"] = json!({"listen": "127.0.0.1:8080"});
        assert_eq!(
            prepare_config(&config.to_string(), &rules, 19090, "s")
                .unwrap_err()
                .code,
            ERR_CONFIG_FORBIDDEN
        );

        // cache_file：root 按这个路径存盘
        let mut config: Value = serde_json::from_str(&tun_config(json!([]))).unwrap();
        config["experimental"]["cache_file"] = json!("/tmp/evil.db");
        assert_eq!(
            prepare_config(&config.to_string(), &rules, 19090, "s")
                .unwrap_err()
                .code,
            ERR_CONFIG_FORBIDDEN
        );

        // experimental.external_ui
        let mut config: Value = serde_json::from_str(&tun_config(json!([]))).unwrap();
        config["experimental"]["external_ui"] = json!("/Users/x/ui");
        assert_eq!(
            prepare_config(&config.to_string(), &rules, 19090, "s")
                .unwrap_err()
                .code,
            ERR_CONFIG_FORBIDDEN
        );

        // ntp
        let mut config: Value = serde_json::from_str(&tun_config(json!([]))).unwrap();
        config["ntp"] = json!({"enabled": true, "server": "x"});
        assert_eq!(
            prepare_config(&config.to_string(), &rules, 19090, "s")
                .unwrap_err()
                .code,
            ERR_CONFIG_FORBIDDEN
        );

        // 出站里的证书路径
        let mut config: Value = serde_json::from_str(&tun_config(json!([]))).unwrap();
        config["outbounds"][0] =
            json!({"type": "direct", "tag": "direct", "tls": {"certificate_path": "/tmp/x"}});
        assert_eq!(
            prepare_config(&config.to_string(), &rules, 19090, "s")
                .unwrap_err()
                .code,
            ERR_CONFIG_FORBIDDEN
        );

        // 未知出站类型
        let mut config: Value = serde_json::from_str(&tun_config(json!([]))).unwrap();
        config["outbounds"][0] = json!({"type": "tor", "tag": "x"});
        assert_eq!(
            prepare_config(&config.to_string(), &rules, 19090, "s")
                .unwrap_err()
                .code,
            ERR_CONFIG_FORBIDDEN
        );

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_realistically_shaped_config_passes_the_allowlist() {
        // 生成器真实产出的形状必须能过白名单，否则这条防线就是把功能也挡了。
        let (dir, rules) = rules_dir(&["geosite-cn"]);
        let config = json!({
            "log": {"level": "info", "timestamp": true},
            "inbounds": [{
                "type": "tun", "tag": "tun-in", "address": ["172.19.0.1/30"],
                "auto_route": true, "route_exclude_address": ["10.0.0.0/8"]
            }],
            "outbounds": [
                {"type": "shadowsocks", "tag": "node-1", "server": "203.0.113.10",
                 "server_port": 8388, "method": "aes-256-gcm", "password": "p"},
                {"type": "selector", "tag": "proxy", "outbounds": ["node-1"], "default": "node-1"},
                {"type": "direct", "tag": "direct"}
            ],
            "route": {
                "rule_set": [{"tag": "geosite-cn", "type": "local", "format": "binary"}],
                "rules": [
                    {"action": "sniff", "sniffer": ["http", "tls", "quic", "dns"], "timeout": "300ms"},
                    {"protocol": "dns", "action": "hijack-dns"},
                    {"ip_is_private": true, "action": "route", "outbound": "direct"},
                    {"rule_set": ["geosite-cn"], "action": "route", "outbound": "direct"}
                ],
                "final": "proxy", "auto_detect_interface": true,
                "default_domain_resolver": "dns-local-1"
            },
            "dns": {
                "servers": [{"type": "udp", "tag": "dns-local-1", "server": "223.5.5.5", "detour": "direct"}], // secret-scan:allow 测试夹具：公共 DNS 地址
                "rules": [], "final": "dns-local-1", "strategy": "prefer_ipv4"
            },
            "experimental": {"clash_api": {"external_controller": "127.0.0.1:1", "secret": "x"}}
        });
        prepare_config(&config.to_string(), &rules, 19090, "helper-secret")
            .expect("真实形状必须通过");
        let _ = fs::remove_dir_all(&dir);
    }

    /// 这条字符串写错一次就是所有连接被拒，而且编译期、单测都不会发现。
    /// 所以不靠人眼：直接从 tauri.conf.json 读出来比对。
    #[test]
    fn the_requirement_uses_the_real_bundle_identifier() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tauri.conf.json");
        let text = std::fs::read_to_string(&path).expect("读取 tauri.conf.json");
        let key = "\"identifier\"";
        let after = &text[text.find(key).expect("配置里没有 identifier") + key.len()..];
        let after = &after[after.find(':').expect("格式不对") + 1..];
        let start = after.find('"').expect("格式不对") + 1;
        let identifier = &after[start..start + after[start..].find('"').unwrap()];

        let requirement = app_requirement();
        assert!(
            requirement.contains(&format!("identifier \"{identifier}\"")),
            "requirement 里的 identifier 与 tauri.conf.json 不一致：{requirement}"
        );
        assert!(
            !requirement.contains("com.veyl.app"),
            "这是之前写错的那个值"
        );
        assert!(
            requirement.contains(&format!("subject.OU] = \"{TEAM_ID}\"")),
            "Team ID 必须进 requirement：{requirement}"
        );
    }
}
