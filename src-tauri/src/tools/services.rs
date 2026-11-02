//! VPN 工具层与宿主能力之间的接缝。
//!
//! 工具只依赖这里的 trait，不直接碰 runtime / config / proxy / catalog 模块。
//! P1 W1–W2 用 [`NotWiredServices`] 占位；W3 由 Runtime Manager + Connection
//! Orchestrator 实现并替换注册。返回结构遵循 `docs/contracts/tools.md` §4。

use async_trait::async_trait;
use serde_json::{json, Value};

#[derive(Debug, Clone, Default)]
pub struct CatalogQuery {
    pub region: Option<String>,
    pub protocol: Option<String>,
    pub limit: Option<u32>,
    pub cursor: Option<String>,
}

/// 宿主能力。每个方法返回契约里对应的 `data` 对象。
#[async_trait]
pub trait VpnToolServices: Send + Sync {
    async fn runtime_status(&self) -> anyhow::Result<Value>;
    async fn runtime_start(&self, profile_id: Option<String>) -> anyhow::Result<Value>;
    async fn runtime_stop(&self, force: bool) -> anyhow::Result<Value>;
    async fn runtime_restart(&self, reason: Option<String>) -> anyhow::Result<Value>;
    async fn runtime_logs(&self, lines: u32, level: Option<String>) -> anyhow::Result<Value>;

    async fn core_list_versions(&self) -> anyhow::Result<Value>;
    async fn core_install(&self, version: &str) -> anyhow::Result<Value>;

    async fn catalog_search(&self, query: CatalogQuery) -> anyhow::Result<Value>;
    async fn profile_list(&self) -> anyhow::Result<Value>;
    async fn profile_import(&self, node_id: &str, name: Option<String>) -> anyhow::Result<Value>;
    async fn profile_delete(&self, profile_id: &str) -> anyhow::Result<Value>;

    async fn vpn_connect(
        &self,
        target: ConnectTarget,
        strategy: &str,
    ) -> anyhow::Result<Value>;
    async fn vpn_disconnect(&self) -> anyhow::Result<Value>;

    async fn diag_run(&self, include_logs: bool) -> anyhow::Result<Value>;

    async fn save_deepseek_key(&self, key: &str) -> anyhow::Result<Value>;
    async fn job_get(&self, job_id: &str) -> anyhow::Result<Value>;
}

#[derive(Debug, Clone)]
pub enum ConnectTarget {
    Node(String),
    Profile(String),
}

/// 占位实现：返回明确的「尚未接线」错误，UI 上能看出是哪一层没接。
pub struct NotWiredServices;

fn not_wired<T>(what: &str) -> anyhow::Result<T> {
    Err(anyhow::anyhow!(
        "{what} 尚未接线（P1 W3 由 Runtime Manager / Connection Orchestrator 提供）"
    ))
}

fn idle_snapshot() -> Value {
    json!({
        "contract_version": "1.0.4",
        "state": "idle",
        "mode": "system_proxy",
        "pid": null,
        "upstream_version": null,
        "uptime_seconds": null,
        "profile_id": null,
        "config_hash": null,
        "system_proxy_enabled": false,
        "health": {
            "contract_version": "1.0.4",
            "process": false,
            "clash_api": false,
            "data_plane": false,
            "exit_ip": null,
            "consecutive_failures": 0,
            "checked_at": "1970-01-01T00:00:00Z"
        },
        "traffic": null,
        "connections": null,
        "restart_count": 0,
        "last_error": null,
        "last_transition_at": "1970-01-01T00:00:00Z"
    })
}

#[async_trait]
impl VpnToolServices for NotWiredServices {
    async fn runtime_status(&self) -> anyhow::Result<Value> {
        Ok(idle_snapshot())
    }

    async fn runtime_start(&self, _profile_id: Option<String>) -> anyhow::Result<Value> {
        not_wired("启动运行时")
    }

    async fn runtime_stop(&self, _force: bool) -> anyhow::Result<Value> {
        not_wired("停止运行时")
    }

    async fn runtime_restart(&self, _reason: Option<String>) -> anyhow::Result<Value> {
        not_wired("重启运行时")
    }

    async fn runtime_logs(&self, _lines: u32, _level: Option<String>) -> anyhow::Result<Value> {
        Ok(json!({ "lines": [], "truncated": false, "redacted_fields": [] }))
    }

    async fn core_list_versions(&self) -> anyhow::Result<Value> {
        Ok(json!({
            "active_version": null,
            "installed": [],
            "available": [],
            "manifest_source": "bundled",
            "manifest_stale": false
        }))
    }

    async fn core_install(&self, _version: &str) -> anyhow::Result<Value> {
        not_wired("安装运行时")
    }

    async fn catalog_search(&self, _query: CatalogQuery) -> anyhow::Result<Value> {
        not_wired("节点目录")
    }

    async fn profile_list(&self) -> anyhow::Result<Value> {
        Ok(json!({ "profiles": [], "active_profile_id": null }))
    }

    async fn profile_import(
        &self,
        _node_id: &str,
        _name: Option<String>,
    ) -> anyhow::Result<Value> {
        not_wired("导入节点")
    }

    async fn profile_delete(&self, _profile_id: &str) -> anyhow::Result<Value> {
        not_wired("删除配置")
    }

    async fn vpn_connect(&self, _target: ConnectTarget, _strategy: &str) -> anyhow::Result<Value> {
        not_wired("连接")
    }

    async fn vpn_disconnect(&self) -> anyhow::Result<Value> {
        not_wired("断开")
    }

    async fn diag_run(&self, _include_logs: bool) -> anyhow::Result<Value> {
        not_wired("诊断")
    }

    async fn save_deepseek_key(&self, _key: &str) -> anyhow::Result<Value> {
        not_wired("保存 DeepSeek Key")
    }

    async fn job_get(&self, _job_id: &str) -> anyhow::Result<Value> {
        not_wired("长任务查询")
    }
}
