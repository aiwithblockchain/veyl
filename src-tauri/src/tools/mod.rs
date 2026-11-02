//! P1 工具集：Agent 操作应用的全部入口。
//!
//! 每个工具实现 Claurst 的 `Tool` trait，直接跑在主进程里（不走 MCP）。
//! 结果信封、权限级别、错误码见 `docs/contracts/tools.md`。

pub mod catalog;
pub mod core;
pub mod deepseek;
pub mod diag;
pub mod envelope;
pub mod job;
pub mod policy;
pub mod runtime;
pub mod services;
pub mod vpn;

use std::sync::Arc;

use claurst_tools::Tool;

pub use envelope::{AivpnError, NextAction, ToolOutcome};
pub use services::{CatalogQuery, ConnectTarget, NotWiredServices, VpnToolServices};

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
        Box::new(catalog::ProfileListTool::new(Arc::clone(&services))),
        Box::new(catalog::ProfileImportTool::new(Arc::clone(&services))),
        Box::new(catalog::ProfileDeleteTool::new(Arc::clone(&services))),
        Box::new(vpn::VpnConnectTool::new(Arc::clone(&services))),
        Box::new(vpn::VpnDisconnectTool::new(Arc::clone(&services))),
        Box::new(diag::DiagRunTool::new(Arc::clone(&services))),
        Box::new(deepseek::DeepseekSetupKeyTool),
        Box::new(deepseek::DeepseekSaveKeyTool::new(Arc::clone(&services))),
        Box::new(job::JobGetTool::new(Arc::clone(&services))),
        Box::new(claurst_tools::AskUserQuestionTool),
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
