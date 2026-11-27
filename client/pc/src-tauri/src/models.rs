//! 应用侧模型（对应技术设计 §6.1）。
//!
//! sing-box 配置本身**不在这里建模**：§3.2 要求未知字段原样透传，用 typed
//! struct 会静默丢字段，所以配置一律是 `serde_json::Value`。
//!
//! 订阅链接的令牌不在这些结构里：它只进密钥存储，元数据只留主机名。

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SyncState {
    /// 最近一次同步成功。
    Ok,
    /// 网络或服务端失败，旧配置仍然可用。
    Failed,
    /// 令牌失效或被轮换过；停止自动刷新。
    Unauthorized,
    /// 文件来源从不参与同步。
    Never,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ProfileSource {
    Subscription { host: String },
    File { path: String },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum KernelCheck {
    Passed,
    /// 本机没有内核，结构校验过了但没做内核校验。
    Unavailable,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Profile {
    pub id: String,
    pub name: String,
    pub source: ProfileSource,
    pub node_count: usize,
    pub last_synced_at: Option<i64>,
    pub sync_state: SyncState,
    pub sync_error: Option<String>,
    pub created_at: i64,
    pub kernel_check: KernelCheck,
}

/// 详情页要展示的一个节点。只给名字与类型，不给地址与密码。
#[derive(Debug, Clone, Serialize)]
pub struct NodeBrief {
    pub tag: String,
    pub kind: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ProfileDetail {
    pub profile: Profile,
    pub nodes: Vec<NodeBrief>,
    /// 界面上展示的来源：订阅是打码后的主机，文件是文件名。
    pub source_label: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn source_serializes_with_a_kind_tag() {
        let source = ProfileSource::Subscription {
            host: "vpn.example.com".into(),
        };
        let value = serde_json::to_value(&source).unwrap();
        assert_eq!(value["kind"], "subscription");
        assert_eq!(value["host"], "vpn.example.com");
    }

    #[test]
    fn a_profile_round_trips() {
        let profile = Profile {
            id: "018f".into(),
            name: "我的订阅".into(),
            source: ProfileSource::File {
                path: "/tmp/profile.json".into(),
            },
            node_count: 3,
            last_synced_at: Some(1_763_000_000_000),
            sync_state: SyncState::Never,
            sync_error: None,
            created_at: 1_763_000_000_000,
            kernel_check: KernelCheck::Unavailable,
        };
        let text = serde_json::to_string(&profile).unwrap();
        let back: Profile = serde_json::from_str(&text).unwrap();
        assert_eq!(back.name, profile.name);
        assert_eq!(back.node_count, 3);
    }
}
