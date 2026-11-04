//! P1 工具集：Agent 操作应用的全部入口。
//!
//! 每个工具实现 Claurst 的 `Tool` trait，直接跑在主进程里（不走 MCP）。
//! 结果信封、权限级别、错误码见 `docs/contracts/tools.md`。

pub mod catalog;
pub mod configs;
pub mod core;
pub mod deepseek;
pub mod diag;
pub mod envelope;
pub mod job;
pub mod net;
pub mod policy;
pub mod routing;
pub mod runtime;
pub mod services;
pub mod vpn;

use std::sync::Arc;

use async_trait::async_trait;
use claurst_tools::{PermissionLevel, Tool, ToolContext, ToolResult};
use serde_json::Value;

pub use envelope::{AivpnError, NextAction, ToolOutcome};
pub use services::{
    CatalogQuery, ConfigCreateInput, ConfigUpdateInput, NodeCreateInput, NotWiredServices,
    VpnToolServices,
};

/// AskUserQuestion 的护栏：契约要求 options 非空，否则直接把这次工具调用
/// 作为 INVALID_ARGUMENT 结束，让模型带选项重问（不能静默丢弃成「跳过」）。
struct AskUserQuestionGuard {
    inner: claurst_tools::AskUserQuestionTool,
}

impl AskUserQuestionGuard {
    fn new() -> Self {
        Self {
            inner: claurst_tools::AskUserQuestionTool,
        }
    }
}

#[async_trait]
impl Tool for AskUserQuestionGuard {
    fn name(&self) -> &str {
        self.inner.name()
    }

    fn description(&self) -> &str {
        self.inner.description()
    }

    fn permission_level(&self) -> PermissionLevel {
        self.inner.permission_level()
    }

    fn input_schema(&self) -> Value {
        self.inner.input_schema()
    }

    async fn execute(&self, mut input: Value, ctx: &ToolContext) -> ToolResult {
        match normalize_question_options(&input) {
            Ok(options) => {
                // 用过滤后的列表继续，不能带着空白项发事件。
                input["options"] = Value::Array(options);
            }
            Err(message) => return ToolResult::error(format!("INVALID_ARGUMENT: {message}")),
        }
        self.inner.execute(input, ctx).await
    }
}

/// 校验并清理 AskUserQuestion 的 options：必须是字符串数组，去掉 trim 后为空的项。
fn normalize_question_options(input: &Value) -> Result<Vec<Value>, &'static str> {
    let Some(items) = input.get("options").and_then(Value::as_array) else {
        return Err("这次提问没有提供选项。请用 options 给出至少一个可选项后重新调用。");
    };
    if items.is_empty() {
        return Err("这次提问没有提供选项。请用 options 给出至少一个可选项后重新调用。");
    }

    let mut filtered = Vec::with_capacity(items.len());
    for item in items {
        let Some(text) = item.as_str() else {
            return Err("options 的每一项都必须是字符串。");
        };
        if text.trim().is_empty() {
            continue;
        }
        filtered.push(Value::String(text.to_string()));
    }

    if filtered.is_empty() {
        return Err("选项不能是空字符串，请给出至少一个可选项后重新提问。");
    }
    Ok(filtered)
}

/// P1 注册清单，顺序与 `tools.md` §3.1 一致。
pub fn vpn_tools(services: Arc<dyn VpnToolServices>) -> Vec<Box<dyn Tool>> {
    vec![
        Box::new(runtime::RuntimeStatusTool::new(Arc::clone(&services))),
        Box::new(runtime::RuntimeStartTool::new(Arc::clone(&services))),
        Box::new(runtime::RuntimeStopTool::new(Arc::clone(&services))),
        Box::new(runtime::RuntimeRestartTool::new(Arc::clone(&services))),
        Box::new(runtime::RuntimeLogsTool::new(Arc::clone(&services))),
        Box::new(core::CoreListVersionsTool::new(Arc::clone(&services))),
        Box::new(core::CoreInstallTool::new(Arc::clone(&services))),
        Box::new(catalog::CatalogSearchTool::new(Arc::clone(&services))),
        Box::new(configs::ConfigListTool::new(Arc::clone(&services))),
        Box::new(configs::ConfigDetailTool::new(Arc::clone(&services))),
        Box::new(configs::ConfigCreateTool::new(Arc::clone(&services))),
        Box::new(configs::ConfigUpdateTool::new(Arc::clone(&services))),
        Box::new(configs::ConfigDeleteTool::new(Arc::clone(&services))),
        Box::new(configs::NodeImportUrlTool::new(Arc::clone(&services))),
        Box::new(configs::NodeCreateTool::new(Arc::clone(&services))),
        Box::new(configs::NodeSwitchTool::new(Arc::clone(&services))),
        Box::new(configs::NodeProbeTool::new(Arc::clone(&services))),
        Box::new(routing::RouteGetTool::new(Arc::clone(&services))),
        Box::new(routing::RouteSetModeTool::new(Arc::clone(&services))),
        Box::new(routing::RouteTargetsSetTool::new(Arc::clone(&services))),
        Box::new(routing::CategoryListTool::new(Arc::clone(&services))),
        Box::new(routing::RulesStatusTool::new(Arc::clone(&services))),
        Box::new(vpn::VpnConnectTool::new(Arc::clone(&services))),
        Box::new(vpn::VpnDisconnectTool::new(Arc::clone(&services))),
        Box::new(diag::DiagRunTool::new(Arc::clone(&services))),
        Box::new(deepseek::DeepseekSetupKeyTool),
        Box::new(deepseek::DeepseekSaveKeyTool::new(Arc::clone(&services))),
        Box::new(job::JobGetTool::new(Arc::clone(&services))),
        Box::new(net::NetConfigGetTool::new(Arc::clone(&services))),
        Box::new(net::NetRepairTool::new(Arc::clone(&services))),
        Box::new(net::CatalogRefreshTool::new(Arc::clone(&services))),
        Box::new(net::DefaultProfileStatusTool::new(Arc::clone(&services))),
        Box::new(AskUserQuestionGuard::new()),
    ]
}

/// 工具名 → 权限级别（生成 `tool-call-start` 的 `permission_level` 用）。
pub fn permission_level_of(tools: &[Box<dyn Tool>], name: &str) -> &'static str {
    tools
        .iter()
        .find(|tool| tool.name() == name)
        .map(|tool| policy::permission_level_str(tool.permission_level()))
        .unwrap_or("none")
}

/// 工具名 → input schema，用于生成 `args_preview`。
pub fn schema_of(tools: &[Box<dyn Tool>], name: &str) -> Option<serde_json::Value> {
    tools
        .iter()
        .find(|tool| tool.name() == name)
        .map(|tool| tool.input_schema())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn ask_user_options_drop_blank_entries_only() {
        let options =
            normalize_question_options(&json!({ "options": ["东京", "", "   ", " 新加坡 "] }))
                .unwrap();
        assert_eq!(
            options,
            vec![json!("东京"), json!(" 新加坡 ")]
        );
    }

    #[test]
    fn ask_user_options_all_blank_still_fails() {
        assert!(normalize_question_options(&json!({ "options": ["", "  "] })).is_err());
    }

    #[test]
    fn ask_user_options_missing_or_not_strings_fail() {
        assert!(normalize_question_options(&json!({})).is_err());
        assert!(normalize_question_options(&json!({ "options": [] })).is_err());
        assert!(normalize_question_options(&json!({ "options": [42] })).is_err());
    }
}
