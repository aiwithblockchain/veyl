//! 问题墙：提交与公开读取（`docs/design/issue-report-api.md` §3）。
//!
//! 提交走带账户令牌的 `ControlPlane`；读取是公开数据，走不带令牌的
//! `get_public`——未登录用户也应能读，不应为此注册一个匿名设备。

use serde_json::{json, Value};

use super::client::ControlPlane;
use super::error::CpError;

pub const REPORT_VERSION: u32 = 1;
pub const PLATFORMS: [&str; 3] = ["macos", "windows", "linux"];
pub const STAGES: [&str; 4] = ["connectivity", "config_update", "rotate", "ai"];
pub const DEFAULT_LIMIT: u32 = 10;
pub const MAX_LIMIT: u32 = 20;

/// Host 读取运行中应用后填给服务端的客户端信息。模型不能指定这些字段。
#[derive(Debug, Clone, PartialEq)]
pub struct ClientInfo {
    pub app_version: String,
    pub build: String,
    pub platform: String,
    pub os_version: String,
    pub arch: String,
    pub locale: String,
}

impl ClientInfo {
    pub fn current(locale: &str) -> Self {
        Self {
            app_version: env!("CARGO_PKG_VERSION").into(),
            build: option_env!("VEYL_BUILD")
                .unwrap_or(env!("CARGO_PKG_VERSION"))
                .into(),
            platform: platform_name().into(),
            os_version: crate::reports::os_version(),
            arch: arch_name().into(),
            locale: locale.into(),
        }
    }

    pub fn to_json(&self) -> Value {
        json!({
            "app_version": self.app_version,
            "build": self.build,
            "platform": self.platform,
            "os_version": self.os_version,
            "arch": self.arch,
            "locale": self.locale,
        })
    }

    pub fn from_json(value: &Value) -> Option<Self> {
        Some(Self {
            app_version: value.get("app_version")?.as_str()?.to_string(),
            build: value.get("build")?.as_str()?.to_string(),
            platform: value.get("platform")?.as_str()?.to_string(),
            os_version: value.get("os_version")?.as_str()?.to_string(),
            arch: value.get("arch")?.as_str()?.to_string(),
            locale: value.get("locale")?.as_str()?.to_string(),
        })
    }
}

fn platform_name() -> &'static str {
    match std::env::consts::OS {
        "macos" => "macos",
        "windows" => "windows",
        _ => "linux",
    }
}

/// 服务端只接受 `arm64` / `x64`；未知架构按 `x64` 上报，不让整次提交失败。
fn arch_name() -> &'static str {
    match std::env::consts::ARCH {
        "aarch64" => "arm64",
        _ => "x64",
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct IssueQuery {
    pub query: Option<String>,
    pub issue_id: Option<String>,
    pub platform: Option<String>,
    pub stage: Option<String>,
    pub limit: u32,
}

impl Default for IssueQuery {
    fn default() -> Self {
        Self {
            query: None,
            issue_id: None,
            platform: None,
            stage: None,
            limit: DEFAULT_LIMIT,
        }
    }
}

pub async fn submit(payload: &Value, idempotency_key: &str) -> Result<Value, CpError> {
    log::debug!("问题墙提交 请求 key={idempotency_key}");
    let client = ControlPlane::new()?;
    client
        .post("/v1/issues", Some(payload), Some(idempotency_key))
        .await
}

pub async fn read(query: &IssueQuery) -> Result<Value, CpError> {
    log::debug!(
        "问题墙读取 请求 mode={} issue_id={:?} limit={}",
        if query.issue_id.is_some() { "thread" } else { "search" },
        query.issue_id,
        query.limit
    );
    let client = ControlPlane::new()?;
    let path = match query.issue_id.as_deref().filter(|id| !id.trim().is_empty()) {
        Some(id) => format!("/v1/issues/{}", encode_segment(id)),
        None => list_path(query),
    };
    client.get_public(&path).await
}

/// 拼查询串必须放在同步函数里：`form_urlencoded::Serializer` 不是 `Send`，
/// 留在 `read` 的栈上会跨 `.await`，整个 future 就不是 `Send`。
fn list_path(query: &IssueQuery) -> String {
    let mut serializer = url::form_urlencoded::Serializer::new(String::new());
    serializer.append_pair("limit", &query.limit.to_string());
    if let Some(text) = query
        .query
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        serializer.append_pair("q", text);
    }
    if let Some(platform) = query.platform.as_deref() {
        serializer.append_pair("platform", platform);
    }
    if let Some(stage) = query.stage.as_deref() {
        serializer.append_pair("stage", stage);
    }
    format!("/v1/issues?{}", serializer.finish())
}

fn encode_segment(value: &str) -> String {
    url::form_urlencoded::byte_serialize(value.trim().as_bytes()).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn client_info_carries_the_running_version_and_contract_arch() {
        let info = ClientInfo::current("zh");
        assert_eq!(info.app_version, env!("CARGO_PKG_VERSION"));
        assert!(PLATFORMS.contains(&info.platform.as_str()), "{info:?}");
        assert!(matches!(info.arch.as_str(), "arm64" | "x64"), "{info:?}");
        assert!(!info.os_version.is_empty(), "{info:?}");
    }

    #[test]
    fn client_info_round_trips_through_json() {
        let info = ClientInfo::current("en");
        assert_eq!(ClientInfo::from_json(&info.to_json()), Some(info));
    }

    #[test]
    fn issue_ids_are_percent_encoded_for_the_path() {
        assert_eq!(encode_segment("iss_ab/cd"), "iss_ab%2Fcd");
        assert_eq!(encode_segment(" iss_abc "), "iss_abc");
    }
}
