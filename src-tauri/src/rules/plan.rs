//! 把「地区 + 分流模式 + 目标分类」落成 route / dns 两段。
//!
//! 只把实际引用的规则集写进 `route.rule_set`；未引用的 `.srs` 只占磁盘。
//! 这是 `docs/contracts/routing.md` §2.3 / §3 的实现。

use serde_json::{json, Value};

use super::{Category, InstalledRules};

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
    pub region: Option<&'a str>,
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

fn normalized_region(region: Option<&str>) -> String {
    region
        .unwrap_or("cn")
        .trim()
        .to_ascii_lowercase()
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

fn local_layer(region: &str) -> Vec<String> {
    if region == "cn" {
        vec!["geosite-cn".into(), "geoip-cn".into()]
    } else {
        vec![format!("geoip-{region}")]
    }
}

fn dns_servers(region: &str, include_remote: bool) -> Vec<Value> {
    let (local, remote) = if region == "cn" {
        (
            vec!["223.5.5.5", "119.29.29.29"],
            vec!["https://1.1.1.1/dns-query", "https://dns.google/dns-query"],
        )
    } else {
        (
            vec!["1.1.1.1", "8.8.8.8"],
            vec!["https://1.1.1.1/dns-query", "https://dns.google/dns-query"],
        )
    };

    let mut servers = Vec::new();
    for (index, address) in local.iter().enumerate() {
        servers.push(json!({
            "tag": format!("dns-local-{}", index + 1),
            "address": address,
            "detour": "direct",
        }));
    }
    if include_remote {
        for (index, address) in remote.iter().enumerate() {
            servers.push(json!({
                "tag": format!("dns-remote-{}", index + 1),
                "address": address,
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

    let referenced = if local_mode {
        local_layer(&region)
    } else {
        let categories = category_rule_sets(input.rules, input.targets)?;
        dedup_preserve(
            categories
                .iter()
                .flat_map(|category| category.rule_sets.iter().cloned())
                .collect(),
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
        route_rules.push(json!({
            "rule_set": referenced.clone(),
            "action": "route",
            "outbound": "route-local",
        }));
        (
            "proxy",
            Some(if mode == "direct" { "direct" } else { "proxy" }),
        )
    } else {
        route_rules.push(json!({
            "rule_set": referenced.clone(),
            "action": "route",
            "outbound": "proxy",
        }));
        ("direct", None)
    };

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
    let dns_final = if region == "cn" && local_mode {
        if !geosite_ids.is_empty() {
            dns_rules.push(json!({
                "rule_set": geosite_ids,
                "server": "dns-local-1",
            }));
        }
        "dns-remote-1"
    } else if !local_mode && region == "cn" {
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
        "servers": dns_servers(&region, include_remote),
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
        build(&RouteInput {
            mode,
            region: Some(region),
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

    #[test]
    fn target_required_and_unknown_category_fails() {
        let rules = rules();
        let err = build(&RouteInput {
            mode: "proxy_selected",
            region: Some("cn"),
            targets: &[],
            rules: &rules,
        })
        .unwrap_err();
        assert_eq!(err.reason(), "route_targets_empty");

        let targets = vec!["nope".to_string()];
        let err = build(&RouteInput {
            mode: "proxy_selected",
            region: Some("cn"),
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
}
