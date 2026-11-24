//! 系统网络只读 / 受限修复与默认配置包工具（1.1.0）。
//!
//! 不提供通用 shell：所有系统操作都收敛在固定动作里。

use std::sync::Arc;

use async_trait::async_trait;
use claurst_tools::{PermissionLevel, Tool, ToolContext, ToolResult};
use serde_json::{json, Value};

use super::display::{remaining_days_text, Changed, Fact, FactKey};
use super::envelope::{self, AivpnError, ToolOutcome};
use super::services::VpnToolServices;

fn tool_error(error: anyhow::Error) -> AivpnError {
    let text = error.to_string();
    match text.split_once(": ") {
        Some((code, message))
            if !code.is_empty()
                && code
                    .chars()
                    .all(|c| c.is_ascii_uppercase() || c == '_') =>
        {
            AivpnError::new(code, message)
        }
        _ => AivpnError::new("INTERNAL", text),
    }
}

/// 默认接口缺失或为空时不推 fact：不填中文兜底，句子由前端按语言组装。
fn default_interface(data: &Value) -> Option<&str> {
    data.get("route")
        .and_then(|route| route.get("default_interface"))
        .and_then(Value::as_str)
        .filter(|name| !name.is_empty())
}

fn net_config_facts(services: usize, interface: Option<&str>) -> Vec<Fact> {
    let mut facts = vec![Fact::with_params(
        FactKey::NetServiceCount,
        json!({ "count": services }),
    )];
    if let Some(interface) = interface {
        facts.push(Fact::with_params(
            FactKey::NetDefaultInterface,
            json!({ "name": interface }),
        ));
    }
    facts
}

pub struct NetConfigGetTool {
    services: Arc<dyn VpnToolServices>,
}

impl NetConfigGetTool {
    pub fn new(services: Arc<dyn VpnToolServices>) -> Self {
        Self { services }
    }
}

#[async_trait]
impl Tool for NetConfigGetTool {
    fn name(&self) -> &str {
        "NetConfigGet"
    }

    fn description(&self) -> &str {
        "读取本机网络配置：逐网络服务的系统代理、DNS、默认路由与接口、回环监听端口。\
         只读，不修改任何设置，不返回 MAC / Wi-Fi 名称。\n说检查结果；不出现 DNS 地址列表、路由表、字段名。"
    }

    fn permission_level(&self) -> PermissionLevel {
        PermissionLevel::ReadOnly
    }

    fn input_schema(&self) -> Value {
        json!({ "type": "object", "properties": {}, "additionalProperties": false })
    }

    async fn execute(&self, _input: Value, ctx: &ToolContext) -> ToolResult {
        let outcome = match self.services.net_config_get().await {
            Ok(data) => {
                let services = data
                    .get("proxies")
                    .and_then(Value::as_array)
                    .map(|items| items.len())
                    .unwrap_or(0);
                let interface = default_interface(&data);
                let summary = match interface {
                    Some(interface) => format!(
                        "读取到 {services} 个网络服务的代理设置；默认接口 {interface}。"
                    ),
                    None => format!("读取到 {services} 个网络服务的代理设置。"),
                };
                let facts = net_config_facts(services, interface);
                ToolOutcome::ok(summary, data).with_facts(facts)
            }
            Err(error) => ToolOutcome::fail(tool_error(error)),
        };
        envelope::finish(ctx, "NetConfigGet", outcome)
    }
}

pub struct NetRepairTool {
    services: Arc<dyn VpnToolServices>,
}

impl NetRepairTool {
    pub fn new(services: Arc<dyn VpnToolServices>) -> Self {
        Self { services }
    }
}

#[async_trait]
impl Tool for NetRepairTool {
    fn name(&self) -> &str {
        "NetRepair"
    }

    fn description(&self) -> &str {
        "有限的网络修复：restore_direct（撤销 Veyl 的代理并停运行时）、flush_dns（刷新 DNS 缓存）、\
         set_proxy / clear_proxy（只改 Veyl 自己的代理端口）。\
         不要用本工具修改与 Veyl 无关的网络配置。\n说检查结果；不出现 DNS 地址列表、路由表、字段名。失败必须说明是否已恢复。"
    }

    fn permission_level(&self) -> PermissionLevel {
        PermissionLevel::Execute
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "action": {
                    "type": "string",
                    "enum": ["restore_direct", "flush_dns", "set_proxy", "clear_proxy"]
                },
                "port": { "type": "integer", "minimum": 1024, "maximum": 65535 }
            },
            "required": ["action"],
            "additionalProperties": false
        })
    }

    async fn execute(&self, input: Value, ctx: &ToolContext) -> ToolResult {
        let Some(action) = input.get("action").and_then(Value::as_str) else {
            return envelope::finish(
                ctx,
                "NetRepair",
                ToolOutcome::fail(AivpnError::new("INVALID_ARGUMENT", "缺少 action")),
            );
        };
        let port = input
            .get("port")
            .and_then(Value::as_u64)
            .and_then(|port| u16::try_from(port).ok());

        let outcome = match self.services.net_repair(action, port).await {
            Ok(data) => {
                let detail = data
                    .get("detail")
                    .and_then(Value::as_str)
                    .unwrap_or("已执行")
                    .to_string();
                let verified = data.get("verified").and_then(Value::as_bool).unwrap_or(false);
                if verified {
                    ToolOutcome::ok(detail, data).with_display(Vec::new(), Changed::None)
                } else {
                    ToolOutcome::fail(
                        AivpnError::new("PRECONDITION_FAILED", detail).with_details(json!({
                            "reason": "verify_failed",
                            "action": action,
                        })),
                    )
                    .with_display(Vec::new(), Changed::Unknown)
                }
            }
            Err(error) => {
                ToolOutcome::fail(tool_error(error)).with_display(Vec::new(), Changed::Unknown)
            }
        };
        envelope::finish(ctx, "NetRepair", outcome)
    }
}

pub struct CatalogRefreshTool {
    services: Arc<dyn VpnToolServices>,
}

impl CatalogRefreshTool {
    pub fn new(services: Arc<dyn VpnToolServices>) -> Self {
        Self { services }
    }
}

#[async_trait]
impl Tool for CatalogRefreshTool {
    fn name(&self) -> &str {
        "CatalogRefresh"
    }

    fn description(&self) -> &str {
        "拉取并应用 Veyl 免费节点（veyl_seed.json）。有本地缓存时离线不算错误；\
         按内容哈希判断是否变化，不依赖 version 字段。\n\
         用户明确选过节点来源之前，不得凭本工具拉取并应用免费节点；没问过就先问。"
    }

    fn permission_level(&self) -> PermissionLevel {
        PermissionLevel::Write
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": { "force": { "type": "boolean", "default": false } },
            "additionalProperties": false
        })
    }

    async fn execute(&self, input: Value, ctx: &ToolContext) -> ToolResult {
        let force = input.get("force").and_then(Value::as_bool).unwrap_or(false);
        let outcome = match self.services.default_profile_refresh(force).await {
            Ok(data) => {
                let node_count = data
                    .get("node_count")
                    .and_then(Value::as_i64)
                    .unwrap_or(0);
                // 闭集里只有节点数：是不是刚更新、用的是不是缓存，留给模型正文说。
                ToolOutcome::ok(format!("Veyl 免费节点已检查（{node_count} 个）"), data)
                    .with_display(
                        vec![Fact::with_params(
                            FactKey::NetFreeNodeCount,
                            json!({ "count": node_count }),
                        )],
                        Changed::None,
                    )
            }
            Err(error) => ToolOutcome::fail(tool_error(error)),
        };
        envelope::finish(ctx, "CatalogRefresh", outcome)
    }
}

pub struct DefaultProfileStatusTool {
    services: Arc<dyn VpnToolServices>,
}

impl DefaultProfileStatusTool {
    pub fn new(services: Arc<dyn VpnToolServices>) -> Self {
        Self { services }
    }
}

/// 日期只取 ISO 8601 的前 10 位（YYYY-MM-DD）；读不到或为空时返回 `None`。
fn iso_date(value: Option<&str>) -> Option<String> {
    value
        .map(|at| at.chars().take(10).collect::<String>())
        .filter(|date| !date.is_empty())
}

/// 试用状态那句。读不到或状态不认识时整句省略，不编。
fn trial_sentence(trial: Option<&Value>) -> Option<String> {
    let trial = trial?;
    let state = trial.get("state").and_then(Value::as_str)?;
    let pool = trial
        .get("seed_node_count")
        .and_then(Value::as_i64)
        .unwrap_or(0);
    Some(match state {
        "expired" if pool > 0 => format!(
            "免费节点试用已到期：免费节点将被移出节点池，刷新不会加回。池内免费节点 {pool} 个。"
        ),
        "expired" => {
            "免费节点试用已到期：节点已从节点池移除，刷新不会加回。池内免费节点 0 个。".into()
        }
        "active" => {
            let remaining = trial
                .get("remaining_ms")
                .and_then(Value::as_i64)
                .unwrap_or(0);
            format!(
                "免费节点试用中：还剩 {}。池内免费节点 {pool} 个。",
                remaining_days_text(remaining)
            )
        }
        "available" => {
            format!("免费节点试用还没有开始：第一次连上免费节点起算。池内免费节点 {pool} 个。")
        }
        _ => return None,
    })
}

/// 试用状态 + 缓存状态两句话。模型只看得到 `content`，两份事实都要落在这里。
fn default_profile_summary(data: &Value, trial: Option<&Value>) -> String {
    let cache = if data.get("content_sha256").and_then(Value::as_str).is_some() {
        let count = data.get("node_count").and_then(Value::as_i64).unwrap_or(0);
        match data.get("checked_at").and_then(Value::as_i64) {
            Some(checked) => match iso_date(Some(&crate::store::db::iso_from_ms(checked))) {
                Some(date) => format!("缓存里 {count} 个，检查于 {date}。"),
                None => format!("缓存里 {count} 个，检查时间未知。"),
            },
            None => format!("缓存里 {count} 个，检查时间未知。"),
        }
    } else {
        "还没有 Veyl 免费节点缓存，先运行 CatalogRefresh。".into()
    };
    match trial_sentence(trial) {
        Some(sentence) => format!("{sentence}\n{cache}"),
        None => cache,
    }
}

/// 试用状态读不到时的摘要：缓存句照常给，末尾说明试用这句缺失，不能静默。
fn unreadable_trial_summary(data: &Value) -> String {
    format!(
        "{}\n试用状态暂时读不到。",
        default_profile_summary(data, None)
    )
}

#[async_trait]
impl Tool for DefaultProfileStatusTool {
    fn name(&self) -> &str {
        "DefaultProfileStatus"
    }

    fn description(&self) -> &str {
        "读取 Veyl 免费节点缓存状态（不联网）：节点数、内容哈希、检查时间，以及免费节点试用状态\
         （阶段、剩余天数、池内免费节点数）。回答「试用还剩几天 / 是不是到期了」用它；\
         缓存里的节点数不等于池内节点数，也不是用户的节点总量——「我有几个节点」要用 ConfigDetail。"
    }

    fn permission_level(&self) -> PermissionLevel {
        PermissionLevel::ReadOnly
    }

    fn input_schema(&self) -> Value {
        json!({ "type": "object", "properties": {}, "additionalProperties": false })
    }

    async fn execute(&self, _input: Value, ctx: &ToolContext) -> ToolResult {
        let outcome = match self.services.default_profile_status().await {
            Ok(data) => {
                let available = data
                    .get("content_sha256")
                    .and_then(Value::as_str)
                    .is_some();
                let trial = self.services.trial_status().await;
                let summary = match trial.as_ref() {
                    Ok(trial) => default_profile_summary(&data, Some(trial)),
                    Err(error) => {
                        log::debug!("读取试用状态失败：{error}");
                        unreadable_trial_summary(&data)
                    }
                };
                let facts = if available {
                    let count = data
                        .get("node_count")
                        .and_then(Value::as_i64)
                        .unwrap_or(0);
                    vec![Fact::with_params(
                        FactKey::NetFreeNodeCount,
                        json!({ "count": count }),
                    )]
                } else {
                    vec![Fact::new(FactKey::NetFreeCacheMissing)]
                };
                ToolOutcome::ok(summary, data).with_display(facts, Changed::None)
            }
            Err(error) => ToolOutcome::fail(tool_error(error)),
        };
        envelope::finish(ctx, "DefaultProfileStatus", outcome)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 缺字段不推 fact：英文界面不能收到「未知」这样的中文兜底。
    #[test]
    fn a_missing_default_interface_is_not_pushed_as_a_fact() {
        for data in [
            json!({}),
            json!({ "route": {} }),
            json!({ "route": { "default_interface": null } }),
            json!({ "route": { "default_interface": "" } }),
        ] {
            assert!(
                default_interface(&data).is_none(),
                "缺接口时不能推 net.default_interface：{data}"
            );
        }
        assert_eq!(
            net_config_facts(3, None),
            vec![Fact::with_params(
                FactKey::NetServiceCount,
                json!({ "count": 3 })
            )]
        );
        let connected = json!({ "route": { "default_interface": "en0" } });
        assert_eq!(
            net_config_facts(3, default_interface(&connected)),
            vec![
                Fact::with_params(FactKey::NetServiceCount, json!({ "count": 3 })),
                Fact::with_params(FactKey::NetDefaultInterface, json!({ "name": "en0" })),
            ]
        );
    }

    fn cache(count: i64, checked_at: Option<i64>) -> Value {
        json!({
            "content_sha256": "abc",
            "node_count": count,
            "checked_at": checked_at,
        })
    }

    #[test]
    fn an_expired_trial_says_refresh_will_not_bring_nodes_back() {
        let trial = json!({
            "state": "expired",
            "expires_at": "2026-11-20T00:00:00Z",
            "remaining_ms": 0,
            "seed_node_count": 0,
        });
        let text = default_profile_summary(&cache(2, Some(0)), Some(&trial));
        assert!(
            text.starts_with(
                "免费节点试用已到期：节点已从节点池移除，刷新不会加回。池内免费节点 0 个。"
            ),
            "{text}"
        );
        assert!(!text.contains("结束"), "{text}");
        assert!(text.contains("缓存里 2 个，检查于 1970-01-01。"), "{text}");
    }

    #[test]
    fn an_expired_trial_with_nodes_left_in_the_pool_says_they_will_be_removed() {
        let trial = json!({
            "state": "expired",
            "expires_at": "2026-11-20T00:00:00Z",
            "remaining_ms": 0,
            "seed_node_count": 2,
        });
        let text = default_profile_summary(&cache(2, Some(0)), Some(&trial));
        assert!(
            text.starts_with(
                "免费节点试用已到期：免费节点将被移出节点池，刷新不会加回。池内免费节点 2 个。"
            ),
            "{text}"
        );
    }

    #[test]
    fn an_active_trial_floors_the_remaining_days_like_the_ui() {
        let trial = json!({
            "state": "active",
            "expires_at": "2026-12-01T00:00:00Z",
            "remaining_ms": 24 * 60 * 60 * 1000 + 1,
            "seed_node_count": 2,
        });
        let text = default_profile_summary(&cache(3, Some(0)), Some(&trial));
        assert!(
            text.contains("免费节点试用中：还剩 1 天。池内免费节点 2 个。"),
            "{text}"
        );
        assert!(!text.contains("到期）"), "{text}");
        assert!(text.contains("\n缓存里 3 个"), "{text}");
    }

    #[test]
    fn a_trial_that_has_not_started_says_when_it_starts() {
        let trial = json!({
            "state": "available",
            "expires_at": null,
            "remaining_ms": null,
            "seed_node_count": 2,
        });
        let text = default_profile_summary(&cache(2, Some(0)), Some(&trial));
        assert!(
            text.starts_with("免费节点试用还没有开始：第一次连上免费节点起算。池内免费节点 2 个。"),
            "{text}"
        );
    }

    #[test]
    fn an_unreadable_trial_leaves_only_the_cache_sentence() {
        let text = default_profile_summary(&cache(2, Some(0)), None);
        assert!(!text.contains("试用"), "{text}");
        assert!(!text.contains('\n'), "{text}");
        assert!(text.starts_with("缓存里 2 个"), "{text}");
        let missing = default_profile_summary(&json!({}), None);
        assert_eq!(missing, "还没有 Veyl 免费节点缓存，先运行 CatalogRefresh。");
    }

    /// S6：读不到试用时不能静默，摘要末尾必须说明。
    #[test]
    fn an_unreadable_trial_adds_a_note_instead_of_staying_silent() {
        let text = unreadable_trial_summary(&cache(2, Some(0)));
        assert!(text.contains("试用状态暂时读不到。"), "{text}");
        assert!(text.contains("缓存里 2 个"), "{text}");
    }
}
