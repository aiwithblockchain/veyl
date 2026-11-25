//! 工具结果的用户可见事实（`docs/contracts/events.md` §3.4 / §3.4.1）。
//!
//! `ToolResult.content` 是写给模型的，里面会混入「先用本工具匹配出 config_id」
//! 这类指令，不能直接渲染。这里只给结构化事实：`FactKey` 闭集 + 语言无关的
//! 参数，句子由前端按界面语言查表组装（2.24.0 起 `display` 里没有自由文本）。
//!
//! 约束：
//! - `facts` ≤ 4 行；没有事实时整个字段省略，不发空数组；
//! - `params` 只放标量，不放错误原文、URL、凭据（`report.location.path` 除外）；
//! - 成功时 `changed` 固定 `none`；失败时只读工具固定 `none`，
//!   写/执行工具默认 `unknown`（保守）。

use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Changed {
    /// 没有改动用户的任何设置、文件或网络。
    None,
    /// 改过，但已恢复到调用前的状态。
    Restored,
    /// 改过，且无法确认是否恢复。
    #[default]
    Unknown,
}

/// 卡片上可直接点击的动作（`events.md` §3.4，2.11.0）。
///
/// 只带不透明的 `report_id`，**不带路径**：一旦出现通用「打开路径」的动作，
/// 模型就可能诱导 UI 打开任意位置。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum DisplayAction {
    RevealReportDir { report_id: String },
    ComposeReportMail { report_id: String },
}

/// `display.facts[].key` 的闭集（`events.md` §3.4.1）。
///
/// 名字就是线上值；新增 key 必须先改契约再改这里。枚举参数（`mode` /
/// `state` / `destroyed` / `stage` / `retryable` / `http.error.reason`）
/// 给机器值，由 UI 映射成人话；未知值由 UI 丢弃该行。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum FactKey {
    #[serde(rename = "core.active_version")]
    CoreActiveVersion,
    #[serde(rename = "core.latest_version")]
    CoreLatestVersion,
    #[serde(rename = "core.current_version")]
    CoreCurrentVersion,
    #[serde(rename = "core.version_change")]
    CoreVersionChange,
    #[serde(rename = "core.no_active")]
    CoreNoActive,
    #[serde(rename = "core.installed_count")]
    CoreInstalledCount,
    #[serde(rename = "runtime.connected")]
    RuntimeConnected,
    #[serde(rename = "runtime.disconnected")]
    RuntimeDisconnected,
    #[serde(rename = "runtime.version")]
    RuntimeVersion,
    #[serde(rename = "runtime.exit_ip")]
    RuntimeExitIp,
    #[serde(rename = "runtime.logs_empty")]
    RuntimeLogsEmpty,
    #[serde(rename = "runtime.logs_recent")]
    RuntimeLogsRecent,
    #[serde(rename = "job.state")]
    JobState,
    #[serde(rename = "job.progress")]
    JobProgress,
    #[serde(rename = "net.service_count")]
    NetServiceCount,
    #[serde(rename = "net.default_interface")]
    NetDefaultInterface,
    #[serde(rename = "net.free_node_count")]
    NetFreeNodeCount,
    #[serde(rename = "net.free_cache_missing")]
    NetFreeCacheMissing,
    #[serde(rename = "config.name")]
    ConfigName,
    #[serde(rename = "config.current_node")]
    ConfigCurrentNode,
    #[serde(rename = "config.node_count")]
    ConfigNodeCount,
    #[serde(rename = "node.name")]
    NodeName,
    #[serde(rename = "node.new_port")]
    NodeNewPort,
    #[serde(rename = "node.credential_refresh_failed")]
    NodeCredentialRefreshFailed,
    #[serde(rename = "probe.latency_ms")]
    ProbeLatencyMs,
    #[serde(rename = "probe.unreachable")]
    ProbeUnreachable,
    #[serde(rename = "probe.untested")]
    ProbeUntested,
    #[serde(rename = "import.added")]
    ImportAdded,
    #[serde(rename = "import.skipped")]
    ImportSkipped,
    #[serde(rename = "mode.current")]
    ModeCurrent,
    #[serde(rename = "connection.state")]
    ConnectionState,
    #[serde(rename = "effect.next_connect")]
    EffectNextConnect,
    #[serde(rename = "effect.reconnect")]
    EffectReconnect,
    #[serde(rename = "scope.no_http3")]
    ScopeNoHttp3,
    #[serde(rename = "servers.empty")]
    ServersEmpty,
    #[serde(rename = "server.row")]
    ServerRow,
    #[serde(rename = "server.stage")]
    ServerStage,
    #[serde(rename = "server.retryable")]
    ServerRetryable,
    #[serde(rename = "server.record_incomplete")]
    ServerRecordIncomplete,
    #[serde(rename = "server.advice_rebuild")]
    ServerAdviceRebuild,
    #[serde(rename = "server.no_record")]
    ServerNoRecord,
    #[serde(rename = "server.failure_code")]
    ServerFailureCode,
    #[serde(rename = "report.location")]
    ReportLocation,
    #[serde(rename = "report.log_count")]
    ReportLogCount,
    #[serde(rename = "report.category_count")]
    ReportCategoryCount,
    #[serde(rename = "http.status_code")]
    HttpStatusCode,
    #[serde(rename = "http.elapsed_ms")]
    HttpElapsedMs,
    #[serde(rename = "http.redirects")]
    HttpRedirects,
    #[serde(rename = "http.server")]
    HttpServer,
    #[serde(rename = "http.captcha_required")]
    HttpCaptchaRequired,
    #[serde(rename = "http.error")]
    HttpError,
    #[serde(rename = "catalog.node_count")]
    CatalogNodeCount,
    #[serde(rename = "catalog.region_count")]
    CatalogRegionCount,
    #[serde(rename = "catalog.plan_count")]
    CatalogPlanCount,
    #[serde(rename = "routing.mode")]
    RoutingMode,
    #[serde(rename = "diag.result")]
    DiagResult,
    #[serde(rename = "routing.category_count")]
    RoutingCategoryCount,
    #[serde(rename = "routing.service_count")]
    RoutingServiceCount,
    #[serde(rename = "routing.ownership")]
    RoutingOwnership,
    #[serde(rename = "routing.reconnect_failed")]
    RoutingReconnectFailed,
    #[serde(rename = "rules.version")]
    RulesVersion,
    #[serde(rename = "rules.status")]
    RulesStatus,
    #[serde(rename = "deepseek.verify")]
    DeepseekVerify,
    #[serde(rename = "region.code")]
    RegionCode,
    #[serde(rename = "region.name")]
    RegionName,
    #[serde(rename = "plan.label")]
    PlanLabel,
}

/// 一行事实：`key` 决定句子，`params` 只放标量插值。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Fact {
    pub key: FactKey,
    /// `None` 时不序列化（契约里 `params` 是可选的）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub params: Option<serde_json::Value>,
}

impl Fact {
    pub fn new(key: FactKey) -> Self {
        Self { key, params: None }
    }

    pub fn with_params(key: FactKey, params: serde_json::Value) -> Self {
        Self {
            key,
            params: Some(params),
        }
    }
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Display {
    /// 2.24.0：≤4 行；没有事实时省略字段，不发空数组。
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub facts: Vec<Fact>,
    pub changed: Changed,
    /// 2.11.0：最多两个；没有动作时不序列化，保持旧事件的形状。
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub actions: Vec<DisplayAction>,
}

impl Display {
    pub fn new(changed: Changed) -> Self {
        Self {
            facts: Vec::new(),
            changed,
            actions: Vec::new(),
        }
    }

    pub fn with_facts(mut self, facts: Vec<Fact>) -> Self {
        self.facts = facts;
        self
    }

    pub fn with_actions(mut self, actions: Vec<DisplayAction>) -> Self {
        self.actions = actions;
        self
    }
}

const DAY_MS: i64 = 24 * 60 * 60 * 1000;

/// 剩余天数按界面口径向下取整（`src/myservers/labels.ts`）：不足 24 小时
/// 写「不到 1 天」。0 或负数也走这一档——是否到期由调用方判断。
pub(crate) fn remaining_days_text(remaining_ms: i64) -> String {
    let days = remaining_ms / DAY_MS;
    if days < 1 {
        "不到 1 天".into()
    } else {
        format!("{days} 天")
    }
}

/// 只读工具失败时也不能声称改动过。列表与 `tools.md` §2.4 的只读工具一致。
pub fn is_readonly(tool: &str) -> bool {
    matches!(
        tool,
        "RuntimeStatus"
            | "RuntimeLogs"
            | "CoreListVersions"
            | "CatalogSearch"
            | "ConfigDetail"
            | "NodeProbe"
            | "RouteGet"
            | "DiagRun"
            | "read_public_issue_wall"
            | "DeepseekSetupKey"
            | "JobGet"
            | "NetConfigGet"
            | "DefaultProfileStatus"
            | "OpenSettings"
            | "ServerOptions"
            | "MyServerFailure"
    )
}

/// 工具自己没给 display 时的兜底：没有事实，只有 `changed`。
pub fn fallback(tool: &str, ok: bool) -> Display {
    Display::new(if ok || is_readonly(tool) {
        Changed::None
    } else {
        Changed::Unknown
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// 只读工具失败也不能声称改动过。
    #[test]
    fn read_only_tools_never_report_a_change() {
        for tool in ["DiagRun", "RuntimeStatus", "RouteGet"] {
            for ok in [true, false] {
                assert_eq!(fallback(tool, ok).changed, Changed::None, "{tool}");
            }
        }
    }

    /// 成功时界面不显示「有没有改动」，工具固定填 none。
    #[test]
    fn success_never_reports_a_change() {
        for tool in ["VpnDisconnect", "VpnConnect", "NetRepair"] {
            assert_eq!(fallback(tool, true).changed, Changed::None, "{tool}");
        }
    }

    /// 写/执行工具失败时默认保守：可能改过，且无法确认是否恢复。
    #[test]
    fn mutating_tools_fail_conservatively() {
        for tool in ["VpnConnect", "NetRepair", "NodeSwitch"] {
            assert_eq!(
                fallback(tool, false).changed,
                Changed::Unknown,
                "{tool} 失败时"
            );
        }
    }

    #[test]
    fn changed_serializes_to_the_contract_names() {
        assert_eq!(serde_json::to_value(Changed::None).unwrap(), json!("none"));
        assert_eq!(
            serde_json::to_value(Changed::Restored).unwrap(),
            json!("restored")
        );
        assert_eq!(
            serde_json::to_value(Changed::Unknown).unwrap(),
            json!("unknown")
        );
    }

    /// 线上 key 必须逐条等于 §3.4.1 的点号名。
    #[test]
    fn fact_keys_serialize_to_the_contract_names() {
        let table = [
            (FactKey::CoreActiveVersion, "core.active_version"),
            (FactKey::CoreLatestVersion, "core.latest_version"),
            (FactKey::CoreCurrentVersion, "core.current_version"),
            (FactKey::CoreVersionChange, "core.version_change"),
            (FactKey::CoreNoActive, "core.no_active"),
            (FactKey::CoreInstalledCount, "core.installed_count"),
            (FactKey::RuntimeConnected, "runtime.connected"),
            (FactKey::RuntimeDisconnected, "runtime.disconnected"),
            (FactKey::RuntimeVersion, "runtime.version"),
            (FactKey::RuntimeExitIp, "runtime.exit_ip"),
            (FactKey::RuntimeLogsEmpty, "runtime.logs_empty"),
            (FactKey::RuntimeLogsRecent, "runtime.logs_recent"),
            (FactKey::JobState, "job.state"),
            (FactKey::JobProgress, "job.progress"),
            (FactKey::NetServiceCount, "net.service_count"),
            (FactKey::NetDefaultInterface, "net.default_interface"),
            (FactKey::NetFreeNodeCount, "net.free_node_count"),
            (FactKey::NetFreeCacheMissing, "net.free_cache_missing"),
            (FactKey::ConfigName, "config.name"),
            (FactKey::ConfigCurrentNode, "config.current_node"),
            (FactKey::ConfigNodeCount, "config.node_count"),
            (FactKey::NodeName, "node.name"),
            (FactKey::NodeNewPort, "node.new_port"),
            (
                FactKey::NodeCredentialRefreshFailed,
                "node.credential_refresh_failed",
            ),
            (FactKey::ProbeLatencyMs, "probe.latency_ms"),
            (FactKey::ProbeUnreachable, "probe.unreachable"),
            (FactKey::ProbeUntested, "probe.untested"),
            (FactKey::ImportAdded, "import.added"),
            (FactKey::ImportSkipped, "import.skipped"),
            (FactKey::ModeCurrent, "mode.current"),
            (FactKey::ConnectionState, "connection.state"),
            (FactKey::EffectNextConnect, "effect.next_connect"),
            (FactKey::EffectReconnect, "effect.reconnect"),
            (FactKey::ScopeNoHttp3, "scope.no_http3"),
            (FactKey::ServersEmpty, "servers.empty"),
            (FactKey::ServerRow, "server.row"),
            (FactKey::ServerStage, "server.stage"),
            (FactKey::ServerRetryable, "server.retryable"),
            (FactKey::ServerRecordIncomplete, "server.record_incomplete"),
            (FactKey::ServerAdviceRebuild, "server.advice_rebuild"),
            (FactKey::ServerNoRecord, "server.no_record"),
            (FactKey::ServerFailureCode, "server.failure_code"),
            (FactKey::ReportLocation, "report.location"),
            (FactKey::ReportLogCount, "report.log_count"),
            (FactKey::ReportCategoryCount, "report.category_count"),
            (FactKey::HttpStatusCode, "http.status_code"),
            (FactKey::HttpElapsedMs, "http.elapsed_ms"),
            (FactKey::HttpRedirects, "http.redirects"),
            (FactKey::HttpServer, "http.server"),
            (FactKey::HttpCaptchaRequired, "http.captcha_required"),
            (FactKey::HttpError, "http.error"),
            (FactKey::RegionName, "region.name"),
            (FactKey::RegionCode, "region.code"),
            (FactKey::PlanLabel, "plan.label"),
            (FactKey::CatalogNodeCount, "catalog.node_count"),
            (FactKey::CatalogRegionCount, "catalog.region_count"),
            (FactKey::CatalogPlanCount, "catalog.plan_count"),
            (FactKey::RoutingMode, "routing.mode"),
            (FactKey::DiagResult, "diag.result"),
            (FactKey::RoutingCategoryCount, "routing.category_count"),
            (FactKey::RoutingServiceCount, "routing.service_count"),
            (FactKey::RoutingOwnership, "routing.ownership"),
            (FactKey::RoutingReconnectFailed, "routing.reconnect_failed"),
            (FactKey::RulesVersion, "rules.version"),
            (FactKey::RulesStatus, "rules.status"),
            (FactKey::DeepseekVerify, "deepseek.verify"),
        ];
        for (key, name) in table {
            assert_eq!(serde_json::to_value(key).unwrap(), json!(name));
        }
    }

    /// 没有 params 时不出现 `params` 键；没有 facts 时整个字段省略。
    #[test]
    fn empty_parts_are_omitted() {
        let display = Display::new(Changed::None);
        let value = serde_json::to_value(display).unwrap();
        assert!(value.get("facts").is_none(), "{value}");
        assert!(value.get("actions").is_none(), "{value}");

        let fact = Fact::new(FactKey::CoreNoActive);
        assert_eq!(
            serde_json::to_value(fact).unwrap(),
            json!({ "key": "core.no_active" })
        );

        let fact = Fact::with_params(FactKey::CoreInstalledCount, json!({ "count": 2 }));
        assert_eq!(
            serde_json::to_value(fact).unwrap(),
            json!({ "key": "core.installed_count", "params": { "count": 2 } })
        );
    }

    /// 剩余天数与界面一致：向下取整，不足 24 小时「不到 1 天」。
    #[test]
    fn remaining_days_floor_like_the_ui() {
        let hour = 60 * 60 * 1000;
        let table = [
            (0, "不到 1 天"),
            (hour, "不到 1 天"),
            (DAY_MS - 1, "不到 1 天"),
            (DAY_MS, "1 天"),
            (3 * DAY_MS, "3 天"),
            (6 * DAY_MS + 23 * hour, "6 天"),
        ];
        for (remaining_ms, expected) in table {
            assert_eq!(
                remaining_days_text(remaining_ms),
                expected,
                "{remaining_ms}ms"
            );
        }
    }
}
