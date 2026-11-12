//! 工具结果的用户可见摘要（`docs/design/tool-display.md`）。
//!
//! `ToolResult.content` 是写给模型的，里面会混入「先用本工具匹配出 config_id」
//! 这类指令，不能直接渲染。这里给每个工具准备一段完成/失败文案与结构化事实，
//! 由 Host 投影到 `tool-call-end.display`，卡片只读这份数据。
//!
//! 约束：
//! - `text` ≤ 24 字，不含 id、路径、字段名、错误码、英文；
//! - `facts` ≤ 4 行，每行是 `标签：值` 的完整短句；
//! - 成功时 `changed` 固定 `none`（界面不显示这一行）；
//!   失败时只读工具固定 `none`，写/执行工具默认 `unknown`（保守）。

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

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Display {
    pub text: String,
    pub facts: Vec<String>,
    pub changed: Changed,
    /// 2.11.0：最多两个；没有动作时不序列化，保持旧事件的形状。
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub actions: Vec<DisplayAction>,
}

impl Display {
    pub fn new(text: impl Into<String>, changed: Changed) -> Self {
        Self {
            text: text.into(),
            facts: Vec::new(),
            changed,
            actions: Vec::new(),
        }
    }

    pub fn with_facts(mut self, facts: Vec<String>) -> Self {
        self.facts = facts;
        self
    }

    pub fn with_actions(mut self, actions: Vec<DisplayAction>) -> Self {
        self.actions = actions;
        self
    }
}

/// 工具名 → (完成文案, 失败文案, 是否只读)。
fn table(tool: &str) -> (&'static str, &'static str, bool) {
    match tool {
        "RuntimeStatus" => ("已读取运行状态", "没能读取运行状态", true),
        "RuntimeStart" => ("后台运行库已启动", "没能启动后台运行库", false),
        "RuntimeStop" => ("后台运行库已停止", "没能停止后台运行库", false),
        "RuntimeRestart" => ("后台运行库已重启", "没能重启后台运行库", false),
        "RuntimeLogs" => ("已取到运行记录", "没能取到运行记录", true),
        "CoreListVersions" => ("已查看运行库版本", "没能读取运行库版本", true),
        "CoreUpgrade" => ("已是最新版本", "没能升级，仍是旧版本", false),
        "CatalogSearch" => ("看到可用节点", "没找到可用节点", true),
        "ConfigList" => ("已查看配置", "没能读取配置", true),
        "ConfigDetail" => ("已读取配置详情", "没能读取配置", true),
        "ConfigCreate" => ("配置已创建", "没能创建配置", false),
        "ConfigUpdate" => ("配置已更新", "没能更新配置", false),
        "ConfigDelete" => ("配置已删除", "没能删除配置", false),
        "NodeImportUrl" => ("节点已导入", "没能导入节点", false),
        "NodeCreate" => ("节点已添加", "没能添加节点", false),
        "NodeSwitch" => ("已切换节点", "没能切换节点", false),
        "NodeProbe" => ("节点能连上", "节点连不上", true),
        "RouteGet" => ("已读取上网设置", "没能读取上网设置", true),
        "RouteSetMode" => ("走法已切换", "没能切换走法", false),
        "RouteTargetsSet" => ("直连范围已更新", "没能修改直连范围", false),
        "CategoryList" => ("已读取服务分类", "没能读取服务分类", true),
        "RulesStatus" => ("已读取直连数据状态", "没能读取直连数据状态", true),
        "VpnConnect" => ("已连接", "没能连上", false),
        "VpnDisconnect" => ("已断开", "没能断开连接", false),
        "DiagRun" => ("诊断完成", "没能完成诊断", true),
        "IssueReport" => ("问题报告已生成", "没能生成问题报告", false),
        "DeepseekSetupKey" => ("已给出开通步骤", "没能给出步骤", true),
        "DeepseekSaveKey" => ("密钥已保存", "没能保存密钥", false),
        "JobGet" => ("已读取任务进度", "没能读取任务进度", true),
        "NetConfigGet" => ("已读取网络设置", "没能读取网络设置", true),
        "NetRepair" => ("已恢复网络", "没能恢复网络", false),
        "CatalogRefresh" => ("测试节点已更新", "没能更新测试节点", false),
        "DefaultProfileStatus" => ("已读取测试节点状态", "没能读取测试节点状态", true),
        // 未登记的工具（含 Claurst 内置工具）只给通用文案，不猜语义。
        _ => ("已完成", "没有完成", false),
    }
}

pub fn is_readonly(tool: &str) -> bool {
    table(tool).2
}

/// 工具自己没给 display 时的兜底。
pub fn fallback(tool: &str, ok: bool) -> Display {
    let (success, failure, readonly) = table(tool);
    Display {
        text: (if ok { success } else { failure }).to_string(),
        facts: Vec::new(),
        changed: if ok || readonly {
            Changed::None
        } else {
            Changed::Unknown
        },
        actions: Vec::new(),
    }
}

/// 契约上限：24 字。超了截断而不是让前端自己猜。
pub fn clamp_text(text: &str) -> String {
    if text.chars().count() <= 24 {
        return text.to_string();
    }
    format!("{}…", text.chars().take(23).collect::<String>())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// 表里所有文案都要满足契约：≤24 字、纯中文、不含内部标识。
    #[test]
    fn every_registered_tool_has_short_user_facing_copy() {
        let tools = [
            "RuntimeStatus",
            "RuntimeStart",
            "RuntimeStop",
            "RuntimeRestart",
            "RuntimeLogs",
            "CoreListVersions",
            "CoreUpgrade",
            "CatalogSearch",
            "ConfigList",
            "ConfigDetail",
            "ConfigCreate",
            "ConfigUpdate",
            "ConfigDelete",
            "NodeImportUrl",
            "NodeCreate",
            "NodeSwitch",
            "NodeProbe",
            "RouteGet",
            "RouteSetMode",
            "RouteTargetsSet",
            "CategoryList",
            "RulesStatus",
            "VpnConnect",
            "VpnDisconnect",
            "DiagRun",
            "IssueReport",
            "DeepseekSetupKey",
            "DeepseekSaveKey",
            "JobGet",
            "NetConfigGet",
            "NetRepair",
            "CatalogRefresh",
            "DefaultProfileStatus",
        ];
        for tool in tools {
            for ok in [true, false] {
                let display = fallback(tool, ok);
                assert!(
                    display.text.chars().count() <= 24,
                    "{tool} ok={ok} 文案超过 24 字：{}",
                    display.text
                );
                assert!(!display.text.is_empty(), "{tool} ok={ok} 没有文案");
                assert!(
                    display.text.chars().all(|c| !c.is_ascii_alphabetic()),
                    "{tool} ok={ok} 文案含英文：{}",
                    display.text
                );
                for needle in ["INTERNAL", "INVALID_ARGUMENT", "_", "/", "cfg_"] {
                    assert!(
                        !display.text.contains(needle),
                        "{tool} ok={ok} 文案含内部标识 {needle}：{}",
                        display.text
                    );
                }
            }
        }
    }

    /// 成功时界面不显示「有没有改动」，工具固定填 none。
    #[test]
    fn success_never_reports_a_change() {
        for tool in ["ConfigCreate", "VpnDisconnect", "VpnConnect", "NetRepair"] {
            assert_eq!(fallback(tool, true).changed, Changed::None, "{tool}");
        }
    }

    /// 只读工具失败也不能声称改动过。
    #[test]
    fn read_only_tools_never_report_a_change() {
        for tool in ["ConfigList", "DiagRun", "RuntimeStatus", "CategoryList"] {
            for ok in [true, false] {
                assert_eq!(fallback(tool, ok).changed, Changed::None, "{tool}");
            }
        }
    }

    /// 写/执行工具失败时默认保守：可能改过，且无法确认是否恢复。
    #[test]
    fn mutating_tools_fail_conservatively() {
        for tool in ["ConfigCreate", "VpnConnect", "NetRepair", "NodeSwitch"] {
            assert_eq!(
                fallback(tool, false).changed,
                Changed::Unknown,
                "{tool} 失败时"
            );
        }
    }

    /// 写/执行工具的失败文案必须来自本表，而不是未知工具兜底；
    /// `changed` 也由本表显式声明（默认 unknown 只用于「真不确定」）。
    #[test]
    fn every_write_tool_has_an_explicit_failure_entry() {
        for tool in [
            "RuntimeStart",
            "RuntimeStop",
            "RuntimeRestart",
            "CoreUpgrade",
            "ConfigCreate",
            "ConfigUpdate",
            "ConfigDelete",
            "NodeImportUrl",
            "NodeCreate",
            "NodeSwitch",
            "RouteSetMode",
            "RouteTargetsSet",
            "VpnConnect",
            "VpnDisconnect",
            "DeepseekSaveKey",
            "NetRepair",
            "CatalogRefresh",
        ] {
            assert!(!is_readonly(tool), "{tool} 应登记为写/执行工具");
            let display = fallback(tool, false);
            assert_ne!(display.text, "没有完成", "{tool} 落到了未知工具兜底");
            assert!(!display.text.is_empty(), "{tool} 没有失败文案");
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

    #[test]
    fn overlong_copy_is_clamped_to_24_chars() {
        let text = "这是一段明显超过二十四个字符的用户可见文案用来验证截断逻辑";
        let clamped = clamp_text(text);
        assert_eq!(clamped.chars().count(), 24, "{clamped}");
        assert!(clamped.ends_with('…'));
    }
}
