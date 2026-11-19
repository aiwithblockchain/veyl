//! `MyServers`：只读地列出「我的服务器」与状态（`tools.md` §4.x）。
//!
//! 建机 / 销毁 / 凭据只能由用户点界面；本工具不返回 IP、端口、密码或节点 id。

use std::sync::Arc;

use async_trait::async_trait;
use claurst_tools::{PermissionLevel, Tool, ToolContext, ToolResult};
use serde_json::{json, Value};

use super::envelope::{self, AivpnError, ToolOutcome};
use super::services::VpnToolServices;

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

/// 对模型可见的单条：destroyed 时补人话原因，并把内部 failure 对象抹掉。
fn visible_server(server: &Value) -> Value {
    let state = server.get("state").and_then(Value::as_str).unwrap_or("");
    let failure_code = server
        .get("failure")
        .and_then(|failure| failure.get("code"))
        .and_then(Value::as_str);
    let mut visible = server.clone();
    if let Some(reason) = destroyed_reason(state, failure_code) {
        visible["failure"] = Value::Null;
        visible["destroyed_reason"] = json!(reason);
    }
    visible
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
        "查看「我的服务器」列表：名称、地区、状态、是否可用、月费。只读；不返回地址、端口或密码。\
         已销毁的会给出人话原因（`destroyed_reason`：因余额不足停机删除 / 已销毁），\
         不返回内部错误码。建机与销毁只能由用户在「我的服务器」页面操作。\n\
         用「服务器」「地区」「安装中」这些词；不出现 server_id、node_id、IP、端口。"
    }

    fn permission_level(&self) -> PermissionLevel {
        PermissionLevel::ReadOnly
    }

    fn input_schema(&self) -> Value {
        json!({ "type": "object", "properties": {}, "additionalProperties": false })
    }

    async fn execute(&self, _input: Value, ctx: &ToolContext) -> ToolResult {
        let outcome = match self.services.my_servers().await {
            Ok(data) => {
                let servers: Vec<Value> = data
                    .get("servers")
                    .and_then(Value::as_array)
                    .map(|servers| servers.iter().map(visible_server).collect())
                    .unwrap_or_default();
                let facts = if servers.is_empty() {
                    vec!["还没有服务器".to_string()]
                } else {
                    servers
                        .iter()
                        .take(8)
                        .map(|server| {
                            let name = server
                                .get("name")
                                .and_then(Value::as_str)
                                .unwrap_or("未命名");
                            let region = server.get("region").and_then(Value::as_str).unwrap_or("");
                            let state = server.get("state").and_then(Value::as_str).unwrap_or("");
                            let reason = server
                                .get("destroyed_reason")
                                .and_then(Value::as_str)
                                .map(|reason| format!(" · {reason}"))
                                .unwrap_or_default();
                            format!("{name} · {region} · {}{reason}", state_label(state))
                        })
                        .collect()
                };
                let count = servers.len();
                let mut visible = data;
                visible["servers"] = Value::Array(servers);
                ToolOutcome::ok(format!("共 {count} 台服务器。"), visible).with_facts(facts)
            }
            Err(error) => ToolOutcome::fail(failure(error)),
        };
        envelope::finish(ctx, "MyServers", outcome)
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
                Err(error) => ToolOutcome::fail(failure(error)).with_display(
                    "没读到失败详情，稍后再试",
                    Vec::new(),
                    super::display::Changed::None,
                ),
            },
            Err(error) => ToolOutcome::fail(error).with_display(
                "没读到失败详情，稍后再试",
                Vec::new(),
                super::display::Changed::None,
            ),
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
            facts.push(format!("阶段：{stage}"));
            facts.push(format!("原因：{message}"));
            facts.push(format!("能不能重试：{}", retry_label(retryable)));
            format!(
                "{name}（{}）这次失败在「{stage}」：{message}，{}。最近 {events} 条订单事件；没有建机原始日志。",
                state_label(state),
                retry_label(retryable)
            )
        }
        None => {
            if state == "error" {
                facts.push("记录：不完整".to_string());
                facts.push("建议：重建或联系支持".to_string());
                format!("{name}这次失败的记录不完整，建议重建或联系支持；没有建机原始日志。")
            } else {
                facts.push("失败：本次进程内没有记录".to_string());
                format!(
                    "{name}（{}）本次进程内没有失败记录；这不代表从未失败，也没有建机原始日志。",
                    state_label(state)
                )
            }
        }
    };

    ToolOutcome::ok(summary, data.clone()).with_display(
        "读到了这次失败的记录",
        facts,
        super::display::Changed::None,
    )
}
