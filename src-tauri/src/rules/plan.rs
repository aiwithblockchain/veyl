//! 把「地区 + 分流模式 + 目标分类」落成 route / dns 两段。
//!
//! 只把实际引用的规则集写进 `route.rule_set`；未引用的 `.srs` 只占磁盘。
//! 这是 `docs/contracts/routing.md` §2.3 / §3 的实现。

use serde_json::{json, Value};

use super::{Category, InstalledRules, Region};

pub const MAX_RULE_SETS: usize = 32;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PlanError {
    InvalidMode(String),
    EmptyTargets,
    UnknownCategory(String),
    MissingRuleSet(String),
    TooManyRuleSets(usize),
}

impl PlanError {
    pub fn code(&self) -> &'static str {
        match self {
            PlanError::InvalidMode(_) => "INVALID_ARGUMENT",
            PlanError::EmptyTargets => "PRECONDITION_FAILED",
            PlanError::UnknownCategory(_) | PlanError::MissingRuleSet(_) => "PRECONDITION_FAILED",
            PlanError::TooManyRuleSets(_) => "PRECONDITION_FAILED",
        }
    }

    pub fn reason(&self) -> &'static str {
        match self {
            PlanError::InvalidMode(_) => "invalid_routing_mode",
            PlanError::EmptyTargets => "route_targets_empty",
            PlanError::UnknownCategory(_) => "category_unknown",
            PlanError::MissingRuleSet(_) => "rule_set_missing",
            PlanError::TooManyRuleSets(_) => "too_many_rule_sets",
        }
    }
}

impl std::fmt::Display for PlanError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            PlanError::InvalidMode(mode) => write!(f, "不支持的分流模式：{mode}"),
            PlanError::EmptyTargets => write!(f, "指定服务走 VPN 时至少要选一个分类"),
            PlanError::UnknownCategory(id) => write!(f, "未知分类：{id}"),
            PlanError::MissingRuleSet(id) => write!(f, "规则数据里缺少规则集：{id}"),
            PlanError::TooManyRuleSets(count) => {
                write!(f, "单套配置引用了 {count} 个规则集，超过上限 {MAX_RULE_SETS}")
            }
        }
    }
}

pub struct RouteInput<'a> {
    pub mode: &'a str,
    /// 由 [`crate::rules::detect_region`] 判定；**未知就是未知**，不要在这里兜底。
    pub region: &'a Region,
    pub targets: &'a [String],
    pub rules: &'a InstalledRules,
}

#[derive(Debug, Clone)]
pub struct RoutePlan {
    pub rule_sets: Vec<Value>,
    pub route_rules: Vec<Value>,
    pub route_final: &'static str,
    pub dns: Value,
    /// `Some` 表示生成 `route-local` selector；值为它的默认出口。
    pub outbound_local: Option<&'static str>,
    pub referenced: Vec<String>,
}

impl RoutePlan {
    /// `route.default_domain_resolver`。1.14 起缺这个字段是 **FATAL**，
    /// 不是降级——proxy 与 tun 都一样。
    ///
    /// 取 DNS 表里第一个本地候选：本地候选总是排在远程之前。
    pub fn default_domain_resolver(&self) -> String {
        self.dns["servers"]
            .as_array()
            .and_then(|servers| {
                servers
                    .iter()
                    .find(|server| {
                        server["tag"]
                            .as_str()
                            .map(|tag| tag.starts_with("dns-local"))
                            .unwrap_or(false)
                    })
                    .or_else(|| servers.first())
            })
            .and_then(|server| server["tag"].as_str())
            .unwrap_or("dns-local-1")
            .to_string()
    }
}

/// 未知地区返回 `None`。**不要在这里回落 `cn`**：那会让非中国用户套上中国规则集与国内 DNS。
fn normalized_region(region: &Region) -> Option<String> {
    match region {
        Region::Cn => Some("cn".to_string()),
        Region::Cc(code) => {
            let code = code.trim().to_ascii_lowercase();
            (!code.is_empty()).then_some(code)
        }
        Region::Unknown => None,
    }
}

fn category_rule_sets<'a>(
    rules: &'a InstalledRules,
    targets: &[String],
) -> Result<Vec<&'a Category>, PlanError> {
    if targets.is_empty() {
        return Err(PlanError::EmptyTargets);
    }
    let mut categories = Vec::new();
    for id in targets {
        let category = rules
            .category(id)
            .ok_or_else(|| PlanError::UnknownCategory(id.clone()))?;
        categories.push(category);
    }
    Ok(categories)
}

fn dedup_preserve(ids: Vec<String>) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    for id in ids {
        if seen.insert(id.clone()) {
            out.push(id);
        }
    }
    out
}

fn local_layer(region: Option<&str>) -> Vec<String> {
    match region {
        Some("cn") => vec!["geosite-cn".into(), "geoip-cn".into()],
        Some(code) => vec![format!("geoip-{code}")],
        // 判不出地区：没有本地直连层，除内网外全部走代理。
        None => Vec::new(),
    }
}

/// 1.14 起旧写法（`{"tag","address"}`）已被**删除**，不是弃用——
/// 生成的配置连 `sing-box check` 都过不去。新格式必须带 `type` + `server`。
fn dns_servers(region: Option<&str>, include_remote: bool) -> Vec<Value> {
    let (local, remote) = if region == Some("cn") {
        (
            vec!["223.5.5.5", "119.29.29.29"],
            vec!["1.1.1.1", "dns.google"],
        )
    } else {
        (
            vec!["1.1.1.1", "8.8.8.8"],
            vec!["1.1.1.1", "dns.google"],
        )
    };

    let mut servers = Vec::new();
    for (index, address) in local.iter().enumerate() {
        // **不能写 `detour: "direct"`。** 1.14 的 `run` 会直接 FATAL：
        // `detour to an empty direct outbound makes no sense`——我们的 `direct`
        // 出站没有任何字段，指向它等于没指。而 `sing-box check` 查不出这个错，
        // 只有真正跑起来才炸。不写 detour 就是进程自己直连，正是本地 DNS 要的。
        servers.push(json!({
            "type": "udp",
            "tag": format!("dns-local-{}", index + 1),
            "server": address,
        }));
    }
    if include_remote {
        for (index, address) in remote.iter().enumerate() {
            servers.push(json!({
                "type": "https",
                "tag": format!("dns-remote-{}", index + 1),
                "server": address,
                "detour": "proxy",
            }));
        }
    }
    servers
}

pub fn build(input: &RouteInput<'_>) -> Result<RoutePlan, PlanError> {
    let mode = input.mode.trim();
    if !matches!(mode, "direct" | "proxy_all" | "proxy_selected") {
        return Err(PlanError::InvalidMode(mode.to_string()));
    }
    let region = normalized_region(input.region);
    let local_mode = mode != "proxy_selected";

    let (referenced, local_downgraded) = if local_mode {
        let ids = local_layer(region.as_deref());
        // 本地层是**系统推断**出来的：规则包缺这个国家的 `geoip-<cc>` 时降级成
        // 「无本地层 + 国际 DNS」，不能让一次连接直接失败。
        // 用户显式选的分类（`proxy_selected`）缺规则集仍然报错——两者性质不同。
        if ids.iter().any(|id| input.rules.rule_set(id).is_none()) {
            log::warn!(
                "本地层规则集缺失（region={}，rule_set={}），本次不做本地直连",
                region.as_deref().unwrap_or("unknown"),
                ids.join(",")
            );
            (Vec::new(), true)
        } else {
            (ids, false)
        }
    } else {
        let categories = category_rule_sets(input.rules, input.targets)?;
        (
            dedup_preserve(
                categories
                    .iter()
                    .flat_map(|category| category.rule_sets.iter().cloned())
                    .collect(),
            ),
            false,
        )
    };

    if referenced.len() > MAX_RULE_SETS {
        return Err(PlanError::TooManyRuleSets(referenced.len()));
    }

    let mut rule_sets = Vec::new();
    for id in &referenced {
        let item = input
            .rules
            .rule_set(id)
            .ok_or_else(|| PlanError::MissingRuleSet(id.clone()))?;
        let path = input.rules.root.join(&item.file);
        rule_sets.push(json!({
            "tag": id,
            "type": "local",
            "format": "binary",
            "path": path.to_string_lossy(),
        }));
    }

    let mut route_rules = vec![json!({
        "ip_is_private": true,
        "action": "route",
        "outbound": "direct",
    })];

    let (route_final, outbound_local) = if local_mode {
        if !referenced.is_empty() {
            route_rules.push(json!({
                "rule_set": referenced.clone(),
                "action": "route",
                "outbound": "route-local",
            }));
        }
        (
            "proxy",
            Some(if mode == "direct" { "direct" } else { "proxy" }),
        )
    } else {
        if !referenced.is_empty() {
            route_rules.push(json!({
                "rule_set": referenced.clone(),
                "action": "route",
                "outbound": "proxy",
            }));
        }
        ("direct", None)
    };

    // 本地层降级后 DNS 也走国际组：规则集都没了，再指向国内 DNS 没有依据。
    let dns_region = if local_downgraded {
        None
    } else {
        region.as_deref()
    };
    let dns_region_is_cn = dns_region == Some("cn");

    // DNS 只引用 geosite：查询阶段还没有目标 IP，geoip 规则在这里不会命中。
    let geosite_ids = referenced
        .iter()
        .filter(|id| {
            input
                .rules
                .rule_set(id)
                .map(|item| item.kind == "geosite")
                .unwrap_or(false)
        })
        .cloned()
        .collect::<Vec<_>>();

    let mut dns_rules = Vec::new();
    let dns_final = if dns_region_is_cn && local_mode {
        if !geosite_ids.is_empty() {
            dns_rules.push(json!({
                "rule_set": geosite_ids,
                "server": "dns-local-1",
            }));
        }
        "dns-remote-1"
    } else if !local_mode && dns_region_is_cn {
        if !geosite_ids.is_empty() {
            dns_rules.push(json!({
                "rule_set": geosite_ids,
                "server": "dns-remote-1",
            }));
        }
        "dns-local-1"
    } else if !local_mode {
        if !geosite_ids.is_empty() {
            dns_rules.push(json!({
                "rule_set": geosite_ids,
                "server": "dns-remote-1",
            }));
        }
        "dns-local-1"
    } else {
        // 非中国 + A/B：全部本地解析，route 用 geoip 判 IP。
        "dns-local-1"
    };

    let include_remote = dns_final == "dns-remote-1"
        || dns_rules
            .iter()
            .any(|rule| rule["server"] == "dns-remote-1");
    let dns = json!({
        "servers": dns_servers(dns_region, include_remote),
        "rules": dns_rules,
        "final": dns_final,
        "strategy": "prefer_ipv4",
    });

    Ok(RoutePlan {
        rule_sets,
        route_rules,
        route_final,
        dns,
        outbound_local,
        referenced,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rules::{ManifestItem, ManifestSource, RulesManifest};

    fn rules() -> InstalledRules {
        InstalledRules {
            root: std::path::PathBuf::from("/rules/2026-11-04.1"),
            manifest: RulesManifest {
                schema: 1,
                version: "2026-11-04.1".into(),
                source: ManifestSource {
                    geosite_tag: None,
                    geoip_tag: None,
                    geosite_commit_date: None,
                    geoip_commit_date: None,
                    fetched_at: None,
                },
                items: [
                    ("geosite-cn", "geosite", "geosite/cn.srs"),
                    ("geoip-cn", "geoip", "geoip/cn.srs"),
                    ("geosite-openai", "geosite", "geosite/openai.srs"),
                    ("geoip-jp", "geoip", "geoip/jp.srs"),
                ]
                .into_iter()
                .map(|(id, kind, file)| ManifestItem {
                    id: id.into(),
                    kind: kind.into(),
                    file: file.into(),
                    sha256: "x".into(),
                    bytes: 1,
                })
                .collect(),
            },
            categories: vec![Category {
                id: "openai".into(),
                name_zh: "ChatGPT".into(),
                name_en: "OpenAI".into(),
                description: "x".into(),
                item_count: 0,
                rule_sets: vec!["geosite-openai".into()],
                dns_classifiable: true,
            }],
        }
    }

    fn plan(mode: &str, region: &str, targets: &[&str]) -> RoutePlan {
        plan_region(mode, &Region::from_code(region), targets)
    }

    fn plan_region(mode: &str, region: &Region, targets: &[&str]) -> RoutePlan {
        build(&RouteInput {
            mode,
            region,
            targets: &targets.iter().map(|id| id.to_string()).collect::<Vec<_>>(),
            rules: &rules(),
        })
        .unwrap()
    }

    #[test]
    fn cn_direct_uses_cn_sets_and_route_local() {
        let plan = plan("direct", "cn", &[]);
        assert_eq!(plan.referenced, vec!["geosite-cn", "geoip-cn"]);
        assert_eq!(plan.rule_sets.len(), 2);
        assert_eq!(plan.route_final, "proxy");
        assert_eq!(plan.outbound_local, Some("direct"));
        assert_eq!(plan.dns["final"], "dns-remote-1");
        assert_eq!(plan.dns["rules"][0]["server"], "dns-local-1");
        assert_eq!(plan.dns["rules"][0]["rule_set"][0], "geosite-cn");
    }

    #[test]
    fn proxy_all_uses_the_same_sets_but_route_local_defaults_to_proxy() {
        let plan = plan("proxy_all", "cn", &[]);
        assert_eq!(plan.referenced, vec!["geosite-cn", "geoip-cn"]);
        assert_eq!(plan.outbound_local, Some("proxy"));
        assert_eq!(plan.route_final, "proxy");
    }

    #[test]
    fn proxy_selected_only_uses_target_categories() {
        let plan = plan("proxy_selected", "cn", &["openai"]);
        assert_eq!(plan.referenced, vec!["geosite-openai"]);
        assert_eq!(plan.route_final, "direct");
        assert_eq!(plan.outbound_local, None);
        assert_eq!(plan.route_rules[1]["outbound"], "proxy");
        assert_eq!(plan.dns["final"], "dns-local-1");
        assert_eq!(plan.dns["rules"][0]["server"], "dns-remote-1");
    }

    #[test]
    fn non_cn_direct_uses_geoip_only_and_all_local_dns() {
        let plan = plan("direct", "jp", &[]);
        assert_eq!(plan.referenced, vec!["geoip-jp"]);
        assert_eq!(plan.dns["final"], "dns-local-1");
        assert!(plan.dns["rules"].as_array().unwrap().is_empty());
        assert_eq!(plan.outbound_local, Some("direct"));
    }

    /// 未知地区**不再回落 `cn`**：没有本地直连层，DNS 用国际组。
    #[test]
    fn unknown_region_has_no_local_layer_and_uses_international_dns() {
        for mode in ["direct", "proxy_all"] {
            let plan = plan_region(mode, &Region::Unknown, &[]);
            assert!(plan.referenced.is_empty(), "{mode} 不该引用任何规则集");
            assert!(plan.rule_sets.is_empty(), "{mode} 不该有 rule_set 定义");
            assert_eq!(plan.route_final, "proxy");
            // 只剩内网直连那一条。
            assert_eq!(plan.route_rules.len(), 1, "{mode}");
            assert_eq!(plan.route_rules[0]["ip_is_private"], true);

            let servers = plan.dns["servers"].to_string();
            assert!(servers.contains("1.1.1.1"), "{mode} 应用国际 DNS");
            assert!(!servers.contains("223.5.5.5"), "{mode} 不该用国内 DNS");
            assert!(!servers.contains("119.29.29.29"), "{mode} 不该用国内 DNS");
            assert_eq!(plan.dns["final"], "dns-local-1");
        }
    }

    /// 未知地区时也不许出现 `geosite-cn` / `geoip-cn`——这是那个折返点的回归断言。
    #[test]
    fn unknown_region_never_emits_cn_rule_sets() {
        let plan = plan_region("proxy_all", &Region::Unknown, &[]);
        let text = plan.referenced.join(",");
        assert!(!text.contains("geosite-cn"), "{text}");
        assert!(!text.contains("geoip-cn"), "{text}");
    }

    #[test]
    fn target_required_and_unknown_category_fails() {
        let rules = rules();
        let err = build(&RouteInput {
            mode: "proxy_selected",
            region: &Region::Cn,
            targets: &[],
            rules: &rules,
        })
        .unwrap_err();
        assert_eq!(err.reason(), "route_targets_empty");

        let targets = vec!["nope".to_string()];
        let err = build(&RouteInput {
            mode: "proxy_selected",
            region: &Region::Cn,
            targets: &targets,
            rules: &rules,
        })
        .unwrap_err();
        assert_eq!(err.reason(), "category_unknown");
    }

    #[test]
    fn quoted_paths_are_absolute() {
        let plan = plan("direct", "cn", &[]);
        assert!(plan.rule_sets[0]["path"].as_str().unwrap().starts_with('/'));
    }

    #[test]
    fn dns_servers_use_the_1_14_format() {
        // 1.14.0 起旧写法（tag + address）被删除，不是弃用：
        // 生成的配置连 `sing-box check` 都过不去。这条是回归护栏。
        let plan = plan("direct", "cn", &[]);
        let servers = plan.dns["servers"].as_array().unwrap();
        assert!(!servers.is_empty());
        for server in servers {
            assert!(
                server.get("address").is_none(),
                "address 字段在 1.14 已删除：{server}"
            );
            assert!(
                server["type"].as_str().is_some(),
                "新格式必须带 type：{server}"
            );
            assert!(
                server["server"].as_str().is_some(),
                "新格式必须带 server：{server}"
            );
        }
        assert_eq!(servers[0]["type"], "udp");
        assert_eq!(servers[0]["server"], "223.5.5.5");
    }

    #[test]
    fn remote_dns_servers_are_doh_over_the_proxy() {
        let plan = plan("direct", "cn", &[]);
        let remote = plan.dns["servers"]
            .as_array()
            .unwrap()
            .iter()
            .find(|server| server["tag"] == "dns-remote-1")
            .expect("cn direct 需要远程 DNS");
        assert_eq!(remote["type"], "https");
        assert_eq!(remote["detour"], "proxy");
        assert_eq!(remote["server"], "1.1.1.1", "不要带 https:// 前缀");
    }

    #[test]
    fn every_mode_exposes_a_default_domain_resolver() {
        // 缺它是 FATAL，proxy 与 tun 都一样。
        for (mode, region, targets) in [
            ("direct", "cn", vec![]),
            ("proxy_all", "cn", vec![]),
            ("proxy_selected", "cn", vec!["openai"]),
            ("direct", "jp", vec![]),
        ] {
            let plan = plan(mode, region, &targets);
            let tag = plan.default_domain_resolver();
            assert!(tag.starts_with("dns-local"), "{mode}/{region} → {tag}");
            assert!(plan
                .dns["servers"]
                .as_array()
                .unwrap()
                .iter()
                .any(|server| server["tag"] == tag.as_str()));
        }
    }
}
