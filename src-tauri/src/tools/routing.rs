//! 分流与规则数据的 AI 工具（`docs/contracts/routing.md` / `tools.md` 3.2）。

use std::sync::Arc;

use async_trait::async_trait;
use claurst_tools::{PermissionLevel, Tool, ToolContext, ToolResult};
use serde_json::{json, Value};

use super::display::{Changed, Fact, FactKey};
use super::envelope::{self, AivpnError, NextAction, ToolOutcome};
use super::services::VpnToolServices;

fn failure(error: anyhow::Error) -> AivpnError {
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

/// 切换成功的摘要要说清「设成了什么」「哪些分类跟着生效」「现在有没有连上」。
/// 只报「已更新」的话，模型无法确认分类落没落上，也不知道重连失败的连接其实已经断了，
/// 只能再调一次 `RouteGet` / `RuntimeStatus`。
fn summarise_route_change(data: &Value) -> String {
    let mode = data
        .get("routing_mode")
        .and_then(Value::as_str)
        .unwrap_or("-");
    let targets = data
        .get("targets")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .collect::<Vec<_>>()
                .join("、")
        })
        .unwrap_or_default();
    let targets = if targets.is_empty() {
        String::new()
    } else {
        format!("，目标分类：{targets}")
    };
    let hot = data
        .get("hot_switched")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    // TUN 起来了但平台未采集设备状态：切换成功，接管无法确认。
    // 这条必须优先于热切换/重连文案，否则「连接未中断」会把不确定性盖掉。
    if data.get("runtime_state").and_then(Value::as_str) == Some("tun_unknown") {
        return format!(
            "分流模式已切换为 {mode}{targets}，TUN 已启动，但当前平台未采集设备状态，\
             无法确认是否接管，需要用系统命令确认。"
        );
    }
    if hot {
        format!("分流模式已热切换为 {mode}{targets}，连接未中断。")
    } else {
        match data.get("reconnect").and_then(Value::as_str) {
            Some("reconnected") => {
                format!("分流模式已切换为 {mode}{targets}，已重新连接生效。")
            }
            Some("reconnect_failed") => {
                // 切换后的重连失败不代表已经断开：`abort_connection` 只撤代理、
                // 不停 runtime，引擎可能还在 Running/Starting。按真实 state 说。
                let state = data
                    .get("runtime_state")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown");
                match state {
                    "running" | "degraded" | "starting" | "restarting" => format!(
                        "分流模式已保存为 {mode}{targets}，但自动重连时报错；\
                         运行时当前 state={state}，是否生效要用 RuntimeStatus 确认。"
                    ),
                    "idle" | "stopping" => format!(
                        "分流模式已保存为 {mode}{targets}，自动重连失败，\
                         运行时已停止（state={state}），当前没有连上。"
                    ),
                    "failed" => format!(
                        "分流模式已保存为 {mode}{targets}，自动重连失败，\
                         运行时已失败（state=failed），当前没有连上。"
                    ),
                    // helper 接受了启动请求，但 TUN 设备没起来：接管可能根本没发生。
                    "tun_unconfirmed" => format!(
                        "分流模式已保存为 {mode}{targets}，但 TUN 启动后没确认接管\
                         （设备没起来），当前可能没有真正接管流量，需要重新连接。"
                    ),
                    _ => format!(
                        "分流模式已保存为 {mode}{targets}，自动重连失败，\
                         运行时状态未知，是否生效要用 RuntimeStatus 确认。"
                    ),
                }
            }
            _ => format!("分流模式已设为 {mode}{targets}，下一次连接生效。"),
        }
    }
}

/// 分流模式本身没有闭集 key；这里表达接管状态、连接影响与服务数。
fn route_change_facts(data: &Value) -> Vec<Fact> {
    let mut facts = Vec::new();
    match data.get("runtime_state").and_then(Value::as_str) {
        Some("tun_unconfirmed") => facts.push(Fact::with_params(
            FactKey::RoutingOwnership,
            json!({ "state": "unconfirmed" }),
        )),
        Some("tun_unknown") => facts.push(Fact::with_params(
            FactKey::RoutingOwnership,
            json!({ "state": "unknown" }),
        )),
        _ => {
            if data
                .get("hot_switched")
                .and_then(Value::as_bool)
                .unwrap_or(false)
            {
                facts.push(Fact::with_params(
                    FactKey::ConnectionState,
                    json!({ "state": "intact" }),
                ));
            } else {
                match data.get("reconnect").and_then(Value::as_str) {
                    Some("reconnected") => facts.push(Fact::with_params(
                        FactKey::ConnectionState,
                        json!({ "state": "restored" }),
                    )),
                    Some("reconnect_failed") => {
                        facts.push(Fact::new(FactKey::RoutingReconnectFailed))
                    }
                    _ => facts.push(Fact::new(FactKey::EffectNextConnect)),
                }
            }
        }
    }
    if let Some(count) = data
        .get("targets")
        .and_then(Value::as_array)
        .map(Vec::len)
        .filter(|count| *count > 0)
    {
        facts.push(Fact::with_params(
            FactKey::RoutingServiceCount,
            json!({ "count": count }),
        ));
    }
    facts
}

/// 重连失败 / 接管未确认时操作目标没达成，不能报成功。
/// `connect_changed` 由服务从连接失败信号带出：已回滚 → restored，没动 → none。
fn route_set_mode_outcome(data: Value) -> ToolOutcome {
    let state = data.get("runtime_state").and_then(Value::as_str);
    let reconnect_failed = data.get("reconnect").and_then(Value::as_str)
        == Some("reconnect_failed");
    let tun_unconfirmed = state == Some("tun_unconfirmed");

    if tun_unconfirmed || reconnect_failed {
        let changed = match data.get("connect_changed").and_then(Value::as_str) {
            Some("restored") => Changed::Restored,
            Some("none") => Changed::None,
            _ => Changed::Unknown,
        };
        let reason = if tun_unconfirmed {
            "tun_unconfirmed"
        } else {
            "reconnect_failed"
        };
        return ToolOutcome::fail(
            AivpnError::new("PRECONDITION_FAILED", summarise_route_change(&data)).with_details(
                json!({
                    "reason": reason,
                    "runtime_state": data.get("runtime_state").cloned().unwrap_or(Value::Null),
                }),
            ),
        )
        .with_display(route_change_facts(&data), changed)
        .with_next(NextAction {
            label: "诊断一下".to_string(),
            tool: "DiagRun".to_string(),
            args: json!({}),
        });
    }

    let facts = route_change_facts(&data);
    ToolOutcome::ok(summarise_route_change(&data), data).with_display(facts, Changed::None)
}

/// 机器枚举之外补上界面标签：模型看到 `direct` / `proxy_all` 时要能和界面
/// 上的「智能」/「全局」对上，否则只能猜。工具内容只有中文，中英标签一并写出。
fn mode_with_label(mode: &str) -> String {
    match mode {
        "direct" => format!("{mode}（界面上的「智能」/ Smart）"),
        "proxy_all" => format!("{mode}（界面上的「全局」/ Global）"),
        _ => mode.to_string(),
    }
}

fn summarise_route(data: &Value) -> String {
    let mode = data
        .get("routing_mode")
        .and_then(Value::as_str)
        .unwrap_or("-");
    let applied = data
        .get("applied_mode")
        .and_then(Value::as_str)
        .unwrap_or("未生效");
    let targets = data
        .get("targets")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .collect::<Vec<_>>()
                .join("、")
        })
        .unwrap_or_default();
    let effective = data
        .get("effective")
        .and_then(Value::as_str)
        .unwrap_or("next_connection");
    format!(
        "分流模式 {}，当前生效 {}{}。生效状态：{effective}。",
        mode_with_label(mode),
        mode_with_label(applied),
        if targets.is_empty() {
            String::new()
        } else {
            format!("，目标分类：{targets}")
        }
    )
}

pub struct RouteGetTool {
    services: Arc<dyn VpnToolServices>,
}

impl RouteGetTool {
    pub fn new(services: Arc<dyn VpnToolServices>) -> Self {
        Self { services }
    }
}

#[async_trait]
impl Tool for RouteGetTool {
    fn name(&self) -> &str {
        "RouteGet"
    }

    fn description(&self) -> &str {
        "读取一套配置的分流模式、指定服务分类、当前是否已生效。只读，不联网。\n说「哪些软件走 VPN」「直连」，不出现分流、规则集、rule、category id。"
    }

    fn permission_level(&self) -> PermissionLevel {
        PermissionLevel::ReadOnly
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": { "config_id": { "type": "string" } },
            "additionalProperties": false
        })
    }

    async fn execute(&self, input: Value, ctx: &ToolContext) -> ToolResult {
        let config_id = match super::optional_string(&input, "config_id") {
            Ok(value) => value,
            Err(error) => return envelope::finish(ctx, "RouteGet", ToolOutcome::fail(error)),
        };
        let outcome = match self.services.route_get(config_id).await {
            Ok(data) => {
                // 分流模式用机器值，界面按 mode 查本地表。
                let mut facts = Vec::new();
                let mode = data
                    .get("routing_mode")
                    .and_then(Value::as_str)
                    .unwrap_or("");
                if matches!(mode, "direct" | "proxy_all" | "proxy_selected") {
                    facts.push(Fact::with_params(
                        FactKey::RoutingMode,
                        json!({ "mode": mode }),
                    ));
                }
                if let Some(count) = data
                    .get("targets")
                    .and_then(Value::as_array)
                    .map(Vec::len)
                    .filter(|count| *count > 0)
                {
                    facts.push(Fact::with_params(
                        FactKey::RoutingCategoryCount,
                        json!({ "count": count }),
                    ));
                }
                if data.get("effective").and_then(Value::as_str) != Some("current_connection") {
                    facts.push(Fact::new(FactKey::EffectNextConnect));
                }
                ToolOutcome::ok(summarise_route(&data), data).with_facts(facts)
            }
            Err(error) => ToolOutcome::fail(failure(error)),
        };
        envelope::finish(ctx, "RouteGet", outcome)
    }
}

pub struct RouteSetModeTool {
    services: Arc<dyn VpnToolServices>,
}

impl RouteSetModeTool {
    pub fn new(services: Arc<dyn VpnToolServices>) -> Self {
        Self { services }
    }
}

#[async_trait]
impl Tool for RouteSetModeTool {
    fn name(&self) -> &str {
        "RouteSetMode"
    }

    fn description(&self) -> &str {
        "切换分流模式，只有 direct / proxy_all 两档；已连接时热切不断流。\
         旧配置仍是 proxy_selected 时，切到两档会断开重连，必须先问用户再带 confirm_reconnect=true。\n说「哪些软件走 VPN」「直连」，不出现分流、规则集、rule、category id。"
    }

    fn permission_level(&self) -> PermissionLevel {
        PermissionLevel::Execute
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "config_id": { "type": "string" },
                "mode": { "type": "string", "enum": ["direct", "proxy_all"] },
                "confirm_reconnect": { "type": "boolean", "default": false }
            },
            "required": ["mode"],
            "additionalProperties": false
        })
    }

    async fn execute(&self, input: Value, ctx: &ToolContext) -> ToolResult {
        let Some(mode) = input.get("mode").and_then(Value::as_str) else {
            return envelope::finish(
                ctx,
                "RouteSetMode",
                ToolOutcome::fail(AivpnError::new("INVALID_ARGUMENT", "缺少 mode"))
                    .with_changed(Changed::None),
            );
        };
        let config_id = match super::optional_string(&input, "config_id") {
            Ok(value) => value,
            Err(error) => {
                return envelope::finish(
                    ctx,
                    "RouteSetMode",
                    ToolOutcome::fail(error).with_changed(Changed::None),
                )
            }
        };
        let confirm = input
            .get("confirm_reconnect")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let outcome = match self
            .services
            .route_set_mode(config_id, mode, confirm)
            .await
        {
            Ok(data) => route_set_mode_outcome(data),
            Err(error) => ToolOutcome::fail(failure(error)).with_changed(Changed::Unknown),
        };
        envelope::finish(ctx, "RouteSetMode", outcome)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn changed(extra: serde_json::Value) -> String {
        let mut data = json!({
            "routing_mode": "proxy_all",
            "targets": [],
            "hot_switched": false,
            "reconnect": null,
        });
        // 用对象插入而不是下标赋值：`Value` 只保证实现了 `Index<&str>`。
        if let (Some(target), Some(source)) = (data.as_object_mut(), extra.as_object()) {
            for (key, value) in source {
                target.insert(key.clone(), value.clone());
            }
        }
        summarise_route_change(&data)
    }

    #[test]
    fn a_hot_switch_says_the_connection_was_not_interrupted() {
        let text = changed(json!({ "hot_switched": true }));
        assert!(text.contains("热切换"), "{text}");
        assert!(text.contains("连接未中断"), "{text}");
    }

    #[test]
    fn the_new_mode_is_always_named() {
        let text = changed(json!({ "reconnect": "not_running" }));
        assert!(text.contains("proxy_all"), "{text}");
        assert!(text.contains("下一次连接生效"), "{text}");
    }

    #[test]
    fn selected_categories_are_listed() {
        let text = changed(json!({
            "routing_mode": "proxy_selected",
            "targets": ["social", "streaming"],
            "reconnect": "not_running",
        }));
        assert!(text.contains("目标分类：social、streaming"), "{text}");
    }

    /// 模型看到 `direct` 要能和界面上的「智能」对上，否则会猜出
    /// 「界面写智能、实际全部走 VPN」这种不存在的矛盾。
    #[test]
    fn route_get_content_labels_direct_as_smart() {
        let text = summarise_route(&json!({
            "routing_mode": "direct",
            "applied_mode": "direct",
            "effective": "current_connection",
            "targets": [],
        }));
        assert!(
            text.contains("分流模式 direct（界面上的「智能」/ Smart）"),
            "{text}"
        );
        assert!(
            text.contains("当前生效 direct（界面上的「智能」/ Smart）"),
            "{text}"
        );
    }

    #[test]
    fn route_get_content_labels_proxy_all_as_global() {
        let text = summarise_route(&json!({
            "routing_mode": "proxy_all",
            "applied_mode": null,
            "effective": "next_connection",
            "targets": [],
        }));
        assert!(
            text.contains("分流模式 proxy_all（界面上的「全局」/ Global）"),
            "{text}"
        );
        assert!(text.contains("当前生效 未生效"), "{text}");
    }

    /// 重连失败时 `abort_connection` 只撤代理、不停 runtime：
    /// 引擎还在 running 就不能说「没有连上」。
    #[test]
    fn a_failed_reconnect_does_not_invent_a_disconnection() {
        let text = changed(json!({
            "reconnect": "reconnect_failed",
            "runtime_state": "running",
        }));
        assert!(!text.contains("没有连上"), "{text}");
        assert!(text.contains("state=running"), "{text}");
        assert!(text.contains("RuntimeStatus"), "要给出确认途径：{text}");
    }

    #[test]
    fn a_failed_reconnect_with_a_dead_runtime_says_so() {
        for state in ["idle", "failed"] {
            let text = changed(json!({
                "reconnect": "reconnect_failed",
                "runtime_state": state,
            }));
            assert!(text.contains("没有连上"), "{state}: {text}");
            assert!(text.contains(&format!("state={state}")), "{state}: {text}");
        }
    }

    #[test]
    fn an_unknown_runtime_state_is_reported_as_unknown() {
        let text = changed(json!({ "reconnect": "reconnect_failed" }));
        assert!(text.contains("状态未知"), "{text}");
        assert!(!text.contains("没有连上"), "{text}");
    }

    /// TUN 的 Ok 只说明 helper 收下了启动请求：设备没起来就不能说重连成功。
    #[test]
    fn an_unconfirmed_tun_reconnect_does_not_claim_success() {
        let text = changed(json!({
            "reconnect": "reconnect_failed",
            "runtime_state": "tun_unconfirmed",
        }));
        assert!(text.contains("没确认接管"), "{text}");
        assert!(!text.contains("已重新连接生效"), "{text}");
        assert!(!text.contains("没有连上"), "没证据就不能断言断开：{text}");
    }

    /// 设备状态未采集（Windows）不是失败，也不能说成「连接未中断」。
    /// 设备状态未采集（Windows）不是失败，也不能说成「连接未中断」。
    #[test]
    fn an_uncollected_tun_device_state_is_reported_as_unknown() {
        let text = changed(json!({
            "hot_switched": true,
            "reconnect": "reconnected",
            "runtime_state": "tun_unknown",
        }));
        assert!(text.contains("未采集设备状态"), "{text}");
        assert!(text.contains("无法确认是否接管"), "{text}");
        assert!(text.contains("系统命令"), "要给出确认途径：{text}");
        assert!(!text.contains("连接未中断"), "不确定性不能被盖掉：{text}");
        assert!(!text.contains("没有连上"), "{text}");
    }

    /// 重连失败时不能报成功：目标（连上）没达成，绿色对勾会误导用户。
    #[test]
    fn a_failed_reconnect_is_reported_as_failure() {
        let outcome = route_set_mode_outcome(json!({
            "routing_mode": "proxy_selected",
            "targets": ["social"],
            "hot_switched": false,
            "reconnect": "reconnect_failed",
            "runtime_state": "running",
            "connect_changed": "restored",
        }));
        assert!(!outcome.ok);
        assert_eq!(outcome.display.changed, Changed::Restored);
        assert_eq!(
            outcome.display.facts,
            vec![
                Fact::new(FactKey::RoutingReconnectFailed),
                Fact::with_params(FactKey::RoutingServiceCount, json!({ "count": 1 })),
            ]
        );
        assert_eq!(outcome.next_actions[0].tool, "DiagRun");
    }

    /// 没确认接管时 changed 只能是 unknown，不能假装没改动。
    #[test]
    fn an_unconfirmed_tun_takeover_is_a_failure_with_unknown_change() {
        let outcome = route_set_mode_outcome(json!({
            "routing_mode": "proxy_all",
            "targets": [],
            "hot_switched": false,
            "reconnect": "reconnect_failed",
            "runtime_state": "tun_unconfirmed",
        }));
        assert!(!outcome.ok);
        assert_eq!(outcome.display.changed, Changed::Unknown);
        assert_eq!(
            outcome.display.facts,
            vec![Fact::with_params(
                FactKey::RoutingOwnership,
                json!({ "state": "unconfirmed" })
            )]
        );
    }

    #[test]
    fn a_successful_mode_change_reports_no_change() {
        let outcome = route_set_mode_outcome(json!({
            "routing_mode": "direct",
            "targets": [],
            "hot_switched": true,
            "reconnect": null,
        }));
        assert!(outcome.ok);
        assert_eq!(outcome.display.changed, Changed::None);
        assert_eq!(
            outcome.display.facts,
            vec![Fact::with_params(
                FactKey::ConnectionState,
                json!({ "state": "intact" })
            )]
        );
        assert!(outcome.next_actions.is_empty());
    }

    /// 未采集设备状态不是失败，但也不能说「连接未中断」。
    #[test]
    fn an_uncollected_tun_state_stays_successful_but_unconfirmed() {
        let outcome = route_set_mode_outcome(json!({
            "routing_mode": "proxy_all",
            "targets": [],
            "hot_switched": true,
            "reconnect": "reconnected",
            "runtime_state": "tun_unknown",
        }));
        assert!(outcome.ok);
        assert_eq!(outcome.display.changed, Changed::None);
        // 采集不到接管状态时给 ownership.unknown，不能假装「连接未中断」。
        assert_eq!(
            outcome.display.facts,
            vec![Fact::with_params(
                FactKey::RoutingOwnership,
                json!({ "state": "unknown" })
            )]
        );
    }
}
