//! VPN 工具层与宿主能力之间的接缝。
//!
//! 工具只依赖这里的 trait，不直接碰 runtime / config / proxy / catalog 模块。
//! 返回结构遵循 `docs/contracts/tools.md` §4；配置模型见
//! `docs/configs-and-nav.md` §3。

use async_trait::async_trait;
use serde_json::{json, Value};

#[derive(Debug, Clone, Default)]
pub struct CatalogQuery {
    pub region: Option<String>,
    pub protocol: Option<String>,
    pub limit: Option<u32>,
    pub cursor: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct ConfigCreateInput {
    pub name: String,
    /// system_proxy | tun
    pub connect_mode: String,
    /// direct | proxy_all | proxy_selected
    pub routing_mode: String,
    /// seed：绑定当前种子的全部节点；与 node_ids 互斥
    pub source: Option<String>,
    /// 绑定已有节点；顺序即节点顺序
    pub node_ids: Option<Vec<String>>,
    /// 「指定服务」分类 id；proxy_selected 时必填
    pub targets: Option<Vec<String>>,
    pub listen_port: Option<u16>,
    pub dns: Option<Value>,
    pub tun_excludes: Option<Vec<String>>,
}

#[derive(Debug, Clone, Default)]
pub struct ConfigUpdateInput {
    pub name: Option<String>,
    pub routing_mode: Option<String>,
    /// None = 不改；Some(None) = 改为自动；Some(Some(port)) = 指定端口。
    pub listen_port: Option<Option<u16>>,
    pub dns: Option<Value>,
    pub tun_excludes: Option<Vec<String>>,
    /// 整体替换节点集；顺序即新顺序。
    pub node_ids: Option<Vec<String>>,
    /// 整体替换「指定服务」分类集合。
    pub targets: Option<Vec<String>>,
    /// 契约里没有这个参数；带上它必须报 `connect_mode_immutable`。
    pub connect_mode: Option<String>,
}

#[derive(Clone, Default)]
pub struct NodeCreateInput {
    pub config_id: Option<String>,
    pub name: String,
    pub server: String,
    pub port: u16,
    pub password: String,
    pub method: String,
}

impl std::fmt::Debug for NodeCreateInput {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("NodeCreateInput")
            .field("config_id", &self.config_id)
            .field("name", &self.name)
            .field("server", &self.server)
            .field("port", &self.port)
            .field("method", &self.method)
            .field("password", &"<redacted>")
            .finish()
    }
}

/// 宿主能力。每个方法返回契约里对应的 `data` 对象。
#[async_trait]
pub trait VpnToolServices: Send + Sync {
    async fn runtime_status(&self) -> anyhow::Result<Value>;
    async fn runtime_start(&self, config_id: Option<String>) -> anyhow::Result<Value>;
    async fn runtime_stop(&self, force: bool) -> anyhow::Result<Value>;
    async fn runtime_restart(&self, reason: Option<String>) -> anyhow::Result<Value>;
    async fn runtime_logs(&self, lines: u32, level: Option<String>) -> anyhow::Result<Value>;

    async fn core_list_versions(&self) -> anyhow::Result<Value>;
    // 运行库的安装不再由 AI 触发：CoreInstall 已从工具集移除。
    // 下面这一组只服务于「高级设置 → 运行库」里用户主动发起的操作。
    async fn core_info(&self) -> anyhow::Result<Value>;
    async fn core_check_updates(&self) -> anyhow::Result<Value>;
    async fn core_upgrade(
        &self,
        version: &str,
        origin: &str,
        expected_sha256: Option<&str>,
    ) -> anyhow::Result<Value>;
    async fn core_cancel_upgrade(&self, job_id: &str) -> anyhow::Result<Value>;
    async fn core_rollback(&self) -> anyhow::Result<Value>;

    /// 仅 UI：后台组件（TUN helper）的构建与运行状态。只读。
    async fn tun_helper_info(&self) -> anyhow::Result<Value>;
    /// 仅 UI：换新 helper 映像。TUN 在跑时必须先拒绝。
    async fn tun_helper_restart(&self) -> anyhow::Result<Value>;

    /// 仅 debug 构建：TUN 已连接时采集一次诊断报告。release 里这个方法不存在。
    #[cfg(debug_assertions)]
    async fn tun_probe(&self) -> anyhow::Result<Value>;

    async fn catalog_search(&self, query: CatalogQuery) -> anyhow::Result<Value>;

    async fn config_list(&self) -> anyhow::Result<Value>;
    async fn config_detail(&self, config_id: &str) -> anyhow::Result<Value>;
    async fn config_create(&self, input: ConfigCreateInput) -> anyhow::Result<Value>;
    async fn config_update(
        &self,
        config_id: &str,
        input: ConfigUpdateInput,
    ) -> anyhow::Result<Value>;
    async fn config_delete(&self, config_id: &str) -> anyhow::Result<Value>;
    async fn config_activate(
        &self,
        config_id: &str,
        confirm_disconnect: bool,
    ) -> anyhow::Result<Value>;

    async fn node_import_url(&self, config_id: Option<String>, url: &str) -> anyhow::Result<Value>;
    async fn node_create(&self, input: NodeCreateInput) -> anyhow::Result<Value>;
    async fn node_switch(&self, config_id: &str, node_id: &str) -> anyhow::Result<Value>;
    async fn node_probe(&self, node_id: &str) -> anyhow::Result<Value>;

    async fn default_profile_status(&self) -> anyhow::Result<Value>;
    async fn default_profile_refresh(&self, force: bool) -> anyhow::Result<Value>;
    async fn import_seed_file(&self, path: &str) -> anyhow::Result<Value>;

    async fn rules_status(&self) -> anyhow::Result<Value>;
    async fn category_list(
        &self,
        query: Option<String>,
        limit: Option<u32>,
    ) -> anyhow::Result<Value>;

    async fn route_get(&self, config_id: Option<String>) -> anyhow::Result<Value>;
    async fn route_set_mode(
        &self,
        config_id: Option<String>,
        mode: &str,
        confirm_reconnect: bool,
    ) -> anyhow::Result<Value>;
    async fn route_targets_set(
        &self,
        config_id: &str,
        categories: Vec<String>,
    ) -> anyhow::Result<Value>;

    async fn net_config_get(&self) -> anyhow::Result<Value>;
    async fn net_repair(&self, action: &str, port: Option<u16>) -> anyhow::Result<Value>;

    /// 强制重置网络（**UI 专用，不注册为 AI 工具**）。
    ///
    /// 与 `net_repair` 的区别：这是「不知道现在什么状态，给我恢复干净」——
    /// TUN 与代理模式的残留一起收，并逐项复核，失败不中断后续。
    async fn network_force_reset(&self) -> anyhow::Result<Value>;

    async fn vpn_connect(&self, config_id: Option<String>) -> anyhow::Result<Value>;
    async fn vpn_disconnect(&self) -> anyhow::Result<Value>;

    async fn diag_run(&self, include_logs: bool) -> anyhow::Result<Value>;

    async fn save_deepseek_key(&self, key: &str) -> anyhow::Result<Value>;
    async fn job_get(&self, job_id: &str) -> anyhow::Result<Value>;
}

/// 占位实现：返回明确的「尚未接线」错误。
pub struct NotWiredServices;

fn not_wired<T>(what: &str) -> anyhow::Result<T> {
    Err(anyhow::anyhow!(
        "{what} 尚未接线（P1 W3 由 Runtime Manager / Connection Orchestrator 提供）"
    ))
}

fn idle_snapshot() -> Value {
    json!({
        "contract_version": crate::runtime::CONTRACT_VERSION,
        "state": "idle",
        "mode": "system_proxy",
        "pid": null,
        "upstream_version": null,
        "runtime_source": "none",
        "uptime_seconds": null,
        "config_id": null,
        "mixed_port": null,
        "config_name": null,
        "node_id": null,
        "node_name": null,
        "applied_route_revision": null,
        "connected_since": null,
        "latency_ms": null,
        "node_latency_ms": null,
        "direct_ip": null,
        "config_hash": null,
        "system_proxy_enabled": false,
        "health": {
            "contract_version": crate::runtime::CONTRACT_VERSION,
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

    async fn runtime_start(&self, _config_id: Option<String>) -> anyhow::Result<Value> {
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

    async fn core_info(&self) -> anyhow::Result<Value> {
        not_wired("运行库信息")
    }

    async fn core_check_updates(&self) -> anyhow::Result<Value> {
        not_wired("检查运行库更新")
    }

    async fn core_upgrade(
        &self,
        _version: &str,
        _origin: &str,
        _expected_sha256: Option<&str>,
    ) -> anyhow::Result<Value> {
        not_wired("升级运行库")
    }

    async fn core_cancel_upgrade(&self, _job_id: &str) -> anyhow::Result<Value> {
        not_wired("取消运行库升级")
    }

    async fn core_rollback(&self) -> anyhow::Result<Value> {
        not_wired("回滚运行库")
    }

    async fn tun_helper_info(&self) -> anyhow::Result<Value> {
        Ok(json!({
            "running_build": null,
            "expected_build": "",
            "stale": false,
            "state": "not_running",
            "needs_admin_restart": false,
        }))
    }

    async fn tun_helper_restart(&self) -> anyhow::Result<Value> {
        not_wired("重启后台组件")
    }

    #[cfg(debug_assertions)]
    async fn tun_probe(&self) -> anyhow::Result<Value> {
        not_wired("TUN 诊断")
    }

    async fn catalog_search(&self, _query: CatalogQuery) -> anyhow::Result<Value> {
        not_wired("节点目录")
    }

    async fn config_list(&self) -> anyhow::Result<Value> {
        Ok(json!({ "configs": [], "active_config_id": null }))
    }

    async fn config_detail(&self, _config_id: &str) -> anyhow::Result<Value> {
        not_wired("读取配置详情")
    }

    async fn config_create(&self, _input: ConfigCreateInput) -> anyhow::Result<Value> {
        not_wired("创建配置")
    }

    async fn config_update(
        &self,
        _config_id: &str,
        _input: ConfigUpdateInput,
    ) -> anyhow::Result<Value> {
        not_wired("更新配置")
    }

    async fn config_delete(&self, _config_id: &str) -> anyhow::Result<Value> {
        not_wired("删除配置")
    }

    async fn config_activate(
        &self,
        _config_id: &str,
        _confirm_disconnect: bool,
    ) -> anyhow::Result<Value> {
        not_wired("激活配置")
    }

    async fn node_import_url(
        &self,
        _config_id: Option<String>,
        _url: &str,
    ) -> anyhow::Result<Value> {
        not_wired("导入节点")
    }

    async fn node_create(&self, _input: NodeCreateInput) -> anyhow::Result<Value> {
        not_wired("创建节点")
    }

    async fn node_switch(&self, _config_id: &str, _node_id: &str) -> anyhow::Result<Value> {
        not_wired("切换节点")
    }

    async fn node_probe(&self, _node_id: &str) -> anyhow::Result<Value> {
        not_wired("测试节点")
    }

    async fn default_profile_status(&self) -> anyhow::Result<Value> {
        not_wired("种子状态")
    }

    async fn default_profile_refresh(&self, _force: bool) -> anyhow::Result<Value> {
        not_wired("刷新种子")
    }

    async fn import_seed_file(&self, _path: &str) -> anyhow::Result<Value> {
        not_wired("导入种子文件")
    }

    async fn rules_status(&self) -> anyhow::Result<Value> {
        not_wired("规则数据状态")
    }

    async fn category_list(
        &self,
        _query: Option<String>,
        _limit: Option<u32>,
    ) -> anyhow::Result<Value> {
        not_wired("分类目录")
    }

    async fn route_get(&self, _config_id: Option<String>) -> anyhow::Result<Value> {
        not_wired("分流状态")
    }

    async fn route_set_mode(
        &self,
        _config_id: Option<String>,
        _mode: &str,
        _confirm_reconnect: bool,
    ) -> anyhow::Result<Value> {
        not_wired("切换分流模式")
    }

    async fn route_targets_set(
        &self,
        _config_id: &str,
        _categories: Vec<String>,
    ) -> anyhow::Result<Value> {
        not_wired("设置分流目标")
    }

    async fn net_config_get(&self) -> anyhow::Result<Value> {
        not_wired("读取系统网络")
    }

    async fn net_repair(&self, _action: &str, _port: Option<u16>) -> anyhow::Result<Value> {
        not_wired("修复系统网络")
    }

    async fn network_force_reset(&self) -> anyhow::Result<Value> {
        not_wired("强制重置网络")
    }

    async fn vpn_connect(&self, _config_id: Option<String>) -> anyhow::Result<Value> {
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

// ---------------------------------------------------------------------------
// 真实实现：store + RuntimeManager + ProxyController + CatalogClient
// ---------------------------------------------------------------------------

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use crate::catalog::CatalogClient;
use crate::config::{self as vpn_config};
use crate::proxy::{ProxyController, RecoveryOutcome};
use crate::runtime::{Installer, RuntimeManager, StartPlan};
use crate::store::{self, configs, Store};

/// 结构化的服务层错误。命令层用 downcast 还原 code / details / retryable。
#[derive(Debug)]
pub struct ServiceError {
    pub code: String,
    pub message: String,
    pub retryable: bool,
    pub details: Option<Value>,
}

impl std::fmt::Display for ServiceError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for ServiceError {}

fn svc_error(code: impl std::fmt::Display, message: impl std::fmt::Display) -> anyhow::Error {
    anyhow::Error::new(ServiceError {
        code: code.to_string(),
        message: message.to_string(),
        retryable: false,
        details: None,
    })
}

fn svc_error_with_details(
    code: impl std::fmt::Display,
    message: impl std::fmt::Display,
    details: Value,
) -> anyhow::Error {
    anyhow::Error::new(ServiceError {
        code: code.to_string(),
        message: message.to_string(),
        retryable: false,
        details: Some(details),
    })
}

fn update_error(error: crate::runtime::updates::UpdateError) -> anyhow::Error {
    match error.details {
        Some(details) => svc_error_with_details(error.code, error.message, details),
        None => svc_error(error.code, error.message),
    }
}

/// 从结构化错误里取 code / detail.reason / wire_code，供 debug 日志一行说清。
fn service_error_fields(error: &anyhow::Error) -> (String, Option<String>, Option<String>) {
    let Some(service) = error.downcast_ref::<ServiceError>() else {
        return ("INTERNAL".into(), None, None);
    };
    let details = service.details.as_ref();
    let detail_reason = details
        .and_then(|value| value.get("detail"))
        .and_then(|value| value.get("reason"))
        .and_then(|value| value.as_str())
        .map(str::to_string);
    let reason = detail_reason.or_else(|| {
        details
            .and_then(|value| value.get("reason"))
            .and_then(|value| value.as_str())
            .map(str::to_string)
    });
    let wire_code = details
        .and_then(|value| value.get("wire_code"))
        .and_then(|value| value.as_str())
        .map(str::to_string);
    (service.code.clone(), reason, wire_code)
}

/// 把错误映射成「卡在哪一步」，只用于 debug 日志。
fn connect_phase(code: &str, reason: Option<&str>) -> &'static str {
    match reason {
        Some("node_server_unresolved") => "节点服务器解析",
        Some("takeover_incomplete") => "路由接管",
        Some("rules_not_ready") => "规则数据",
        Some("helper_missing") | Some("helper_install_failed") | Some("tun_denied") => "特权助手",
        _ => match code {
            "RUNTIME_NOT_INSTALLED" => "运行时",
            "RUNTIME_START_TIMEOUT" => "sing-box 启动超时",
            "RUNTIME_EXITED" | "RUNTIME_BINARY_NOT_EXECUTABLE" => "sing-box 进程",
            "tun_start_failed" => "TUN 启动",
            _ => "未分类",
        },
    }
}

/// 某个 utun 上的路由数与关键段覆盖（`tun_probe` 用，仅 debug）。
#[cfg(debug_assertions)]
fn tun_route_stats(netstat: &str, interface: &str) -> (usize, String) {
    let mut count = 0usize;
    let mut has = [false; 4];
    for line in netstat.lines() {
        let tokens: Vec<&str> = line.split_whitespace().collect();
        if tokens.len() < 4 || tokens[3] != interface {
            continue;
        }
        count += 1;
        match tokens[0] {
            "0/1" | "0.0.0.0/1" => has[0] = true,
            "128/1" | "128.0.0.0/1" => has[1] = true,
            "16/4" | "16.0.0.0/4" => has[2] = true, // secret-scan:allow 接管关键段常量
            "32/3" | "32.0.0.0/3" => has[3] = true, // secret-scan:allow 接管关键段常量
            _ => {}
        }
    }
    let present = has.iter().filter(|value| **value).count();
    (count, format!("{present}/4"))
}

/// TUN 启动回复里的设备状态，三态。
///
/// `null` 不是「没起来」：Windows 在适配器枚举实现之前就是未采集，
/// 把它当成失败会让每次分流切换都被判成重连失败。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TunTakeover {
    /// 非 TUN 模式，或设备已确认起来。
    Confirmed,
    /// 明确没看到设备。
    Unconfirmed,
    /// 当前平台未采集。
    Unknown,
}

fn tun_takeover(started: &Value) -> TunTakeover {
    if started.get("mode").and_then(Value::as_str) != Some("tun") {
        return TunTakeover::Confirmed;
    }
    match started.get("tun_device_up").and_then(Value::as_bool) {
        Some(false) => TunTakeover::Unconfirmed,
        Some(true) => TunTakeover::Confirmed,
        None => TunTakeover::Unknown,
    }
}

#[cfg(test)]
mod tun_takeover_tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn an_uncollected_device_state_is_unknown_not_unconfirmed() {
        assert_eq!(
            tun_takeover(&json!({ "mode": "tun", "tun_device_up": null })),
            TunTakeover::Unknown
        );
        assert_eq!(
            tun_takeover(&json!({ "mode": "tun" })),
            TunTakeover::Unknown,
            "缺键也是未采集，不能默认成 false"
        );
        assert_eq!(
            tun_takeover(&json!({ "mode": "tun", "tun_device_up": false })),
            TunTakeover::Unconfirmed
        );
        assert_eq!(
            tun_takeover(&json!({ "mode": "tun", "tun_device_up": true })),
            TunTakeover::Confirmed
        );
        assert_eq!(
            tun_takeover(&json!({ "mode": "system_proxy" })),
            TunTakeover::Confirmed,
            "非 TUN 模式不参与这条判断"
        );
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn a_half_taken_over_tun_is_a_start_failure_without_internal_codes() {
        let error = takeover_incomplete_error(&["16.0.0.0/4".into()], None, false, None);
        let service = error.downcast_ref::<ServiceError>().expect("ServiceError");
        assert_eq!(service.code, "tun_start_failed");
        assert!(
            service.message.contains("16.0.0.0/4"),
            "{}",
            service.message
        );
        assert!(
            !service.message.contains("tun_start_failed"),
            "错误码不能进用户文案：{}",
            service.message
        );
        let details = service.details.as_ref().unwrap();
        assert_eq!(details["reason"], "tun_start_failed");
        assert_eq!(details["detail"]["reason"], "takeover_incomplete");
        assert_eq!(details["detail"]["missing"][0], "16.0.0.0/4");
        assert_eq!(details["permission_problem"], false);
        assert_eq!(details["detail"]["dns_flushed"], true);

        let with_dns_error =
            takeover_incomplete_error(&[], None, false, Some("mDNSResponder 失败"));
        let service = with_dns_error
            .downcast_ref::<ServiceError>()
            .expect("ServiceError");
        assert!(service.message.contains("重启系统"), "{}", service.message);
        assert_eq!(
            service.details.as_ref().unwrap()["detail"]["dns_flushed"],
            false
        );
    }

    /// 退出码 0 不等于清干净：助手可用时必须真的走成特权刷新。
    #[test]
    fn dns_flush_needs_more_than_a_zero_exit_code() {
        assert!(flush_dns_verdict(true, true, true));
        assert!(
            !flush_dns_verdict(true, false, true),
            "助手在却没走特权刷新"
        );
        assert!(!flush_dns_verdict(false, true, true), "解析没恢复");
        assert!(
            flush_dns_verdict(true, false, false),
            "没有助手时以解析为准"
        );
        assert!(!flush_dns_verdict(false, false, false));
    }

    #[tokio::test]
    async fn tun_bypasses_every_node_server_literal_and_pins_resolved_domains() {
        let descriptor = |server: &str| vpn_config::NodeDescriptor {
            id: server.to_string(),
            name: server.to_string(),
            server: server.to_string(),
            server_port: 8388,
            protocol: vpn_config::ProtocolConfig::Shadowsocks {
                password: "test".into(),
                method: "aes-256-gcm".into(),
            },
        };
        let list = [
            descriptor("64.177.43.69"),
            descriptor("64.177.57.184"), // secret-scan:allow 测试常量：节点绕过计划
            descriptor("localhost"),
            descriptor("2001:db8::1"),
        ];
        let plan = node_bypass_plan(&list).await;
        for expected in ["64.177.43.69/32", "64.177.57.184/32", "2001:db8::1/128"] { // secret-scan:allow 测试常量：节点绕过计划
            assert!(
                plan.prefixes.iter().any(|item| item == expected),
                "{:?}",
                plan.prefixes
            );
        }
        assert!(
            plan.prefixes
                .iter()
                .any(|item| item == "127.0.0.1/32" || item == "::1/128"),
            "域名要解析成旁路：{:?}",
            plan.prefixes
        );
        // 域名必须被钉成字面量 IP；字面量 IP 本身不需要再钉。
        assert!(plan.pinned.contains_key("localhost"), "{:?}", plan.pinned);
        assert!(!plan.pinned.contains_key("64.177.43.69")); // secret-scan:allow 测试常量：节点绕过计划
        assert!(node_server_is_resolved("64.177.43.69", &plan.pinned)); // secret-scan:allow 测试常量：节点绕过计划
        assert!(node_server_is_resolved("localhost", &plan.pinned));
        assert!(!node_server_is_resolved("unresolved.invalid", &plan.pinned));
    }

    /// 订阅里几十个域名、DNS 又挂掉时，不能 2s × N 串行拖死连接。
    ///
    /// 用永不返回的解析器：并发实现所有任务同时起跑、2 秒内全部超时；
    /// 串行实现要 40 × 2s，必然超过这里的 3 秒断言。
    #[tokio::test]
    async fn many_slow_node_domains_run_concurrently_under_one_deadline() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::sync::Arc;

        let started = Arc::new(AtomicUsize::new(0));
        let counter = Arc::clone(&started);
        let resolver: NodeResolver = Arc::new(move |_server: String| {
            counter.fetch_add(1, Ordering::SeqCst);
            Box::pin(async {
                tokio::time::sleep(std::time::Duration::from_secs(30)).await;
                Ok::<Vec<std::net::IpAddr>, ()>(Vec::new())
            })
        });
        let descriptor = |server: String| vpn_config::NodeDescriptor {
            id: server.clone(),
            name: server.clone(),
            server,
            server_port: 8388,
            protocol: vpn_config::ProtocolConfig::Shadowsocks {
                password: "test".into(),
                method: "aes-256-gcm".into(),
            },
        };
        let list = (0..40)
            .map(|index| descriptor(format!("node{index}.invalid")))
            .collect::<Vec<_>>();
        let begin = std::time::Instant::now();
        let plan = node_bypass_plan_with(&list, resolver).await;
        let elapsed = begin.elapsed();
        assert_eq!(
            started.load(Ordering::SeqCst),
            list.len(),
            "所有域名必须同时开始解析"
        );
        assert!(plan.pinned.is_empty());
        assert!(
            elapsed < std::time::Duration::from_secs(3),
            "必须受全局上限约束，实际 {elapsed:?}"
        );
    }
}

/// TUN 后端错误 → `AivpnError.details`（契约 §4.3 / §4.4）。
///
/// `reason` 只允许四种；wire 码与本地码分开放，UI 不展示它们。
fn tun_error_details(error: &crate::tun::backend::TunError) -> Value {
    use crate::tun::backend::TunErrorCode;

    // 后端可以显式标注 local_code——例如 `XpcError::Unavailable` 是一次调用竞态，
    // 不是 `ensure_available` 的可用性结论。没有标注时再按三种本地码回退。
    let local_code = error
        .detail
        .as_ref()
        .and_then(|detail| detail.get("local_code"))
        .and_then(|code| code.as_str())
        .map(str::to_string)
        .or_else(|| match error.code {
            TunErrorCode::Timeout | TunErrorCode::PeerUnverified | TunErrorCode::TransportError => {
                Some(error.code.as_str().to_string())
            }
            _ => None,
        });
    json!({
        "reason": error.code.ui_reason(),
        "permission_problem": matches!(
            error.code,
            TunErrorCode::TunDenied
                | TunErrorCode::HelperMissing
                | TunErrorCode::HelperInstallFailed
        ),
        "wire_code": if error.code.is_wire() { Some(error.code.as_str()) } else { None },
        "local_code": local_code,
        "detail": error.detail,
    })
}

/// 强制重置里的一步。字段固定为 `{id, ok, detail}`，前端按 id 渲染。
fn reset_step(id: &str, ok: bool, detail: impl Into<String>) -> Value {
    json!({ "id": id, "ok": ok, "detail": detail.into() })
}

/// 刷新 DNS 的判定：解析必须真的恢复；助手可用时还必须走成特权刷新。
///
/// 只跑 `dscacheutil` 会返回 0 却清不掉 mDNSResponder 的缓存，
/// 这正是「重置报 ok、网络没恢复」的成因，不能让退出码再冒充成功。
fn flush_dns_verdict(resolved: bool, privileged_ok: bool, helper_enabled: bool) -> bool {
    resolved && (privileged_ok || !helper_enabled)
}

/// 特权刷新失败的文案：不把 wire 码或「未知方法」这类内部字眼甩给用户。
fn flush_dns_failure_message(error: &crate::tun::backend::TunError) -> String {
    use crate::tun::backend::TunErrorCode;
    match error.code {
        TunErrorCode::BadRequest => {
            "后台助手版本过旧，无法彻底刷新 DNS；请重启 Veyl 或重装后台助手".to_string()
        }
        TunErrorCode::HelperMissing
        | TunErrorCode::HelperInstallFailed
        | TunErrorCode::TunDenied => {
            "后台助手不可用，无法彻底刷新 DNS；请重启 Veyl 或重装后台助手".to_string()
        }
        TunErrorCode::Timeout => {
            "后台助手没有响应，无法彻底刷新 DNS；请重启 Veyl 后再试".to_string()
        }
        _ => "刷新 DNS 失败，请重启 Veyl 或重装后台助手后再试".to_string(),
    }
}

/// UI 只该看到 message。`ServiceError` 的 Display 是「CODE: message」，
/// 直接拼进 step.detail 会把内部错误码露给用户。
fn user_message(error: &anyhow::Error) -> String {
    error
        .downcast_ref::<ServiceError>()
        .map(|service| service.message.clone())
        .unwrap_or_else(|| error.to_string())
}

/// `server:port` 里的 server 部分；IPv6 可能是 `[::1]:8080`。
fn endpoint_server(endpoint: &str) -> &str {
    endpoint
        .rsplit_once(':')
        .map(|(server, _)| server)
        .unwrap_or(endpoint)
}

fn is_loopback_endpoint(endpoint: &str) -> bool {
    let server = endpoint_server(endpoint)
        .trim()
        .trim_start_matches('[')
        .trim_end_matches(']');
    matches!(server, "127.0.0.1" | "localhost" | "::1")
}

/// 八步全过才算成功；任何一步 false 都不能抬成 true。
fn steps_all_ok(steps: &[Value]) -> bool {
    !steps.is_empty()
        && steps
            .iter()
            .all(|step| step.get("ok").and_then(Value::as_bool) == Some(true))
}

/// 停 TUN 的三种结果。`Unconfirmed` 与 `Failed` 都不能被当成「停掉了」。
#[derive(Debug, Clone, PartialEq, Eq)]
enum TunStopOutcome {
    Stopped { was_running: bool },
    Unconfirmed(String),
    Failed(String),
}

/// 读系统代理当前指向的端点；读不到时是 `Unknown`，不能当成「没有代理」。
#[derive(Debug, Clone, PartialEq, Eq)]
enum CurrentProxy {
    Known(Option<String>),
    Unknown(String),
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct ProxyResetFacts {
    applied: Option<crate::proxy::ProxyEndpoint>,
    plan_port: Option<u16>,
    disable_error: Option<String>,
    clear_error: Option<String>,
    cleared_services: Vec<String>,
    /// 有备份时：仍在使用该端点的网络服务；`None` 表示读失败。
    in_use: Option<Vec<String>>,
    /// 没有备份时：系统代理当前指向；`None` 表示不需要读。
    current: Option<CurrentProxy>,
}

/// `restore_proxy` 的判定，与系统调用隔开以便直接构造事实做测试。
fn judge_restore_proxy(facts: &ProxyResetFacts) -> Value {
    if let Some(error) = &facts.disable_error {
        let mut detail = format!("恢复系统代理失败：{error}");
        if let Some(clear) = &facts.clear_error {
            detail.push_str(&format!("；按端口清理也失败：{clear}"));
        }
        return reset_step("restore_proxy", false, detail);
    }
    if let Some(error) = &facts.clear_error {
        return reset_step("restore_proxy", false, format!("清理系统代理失败：{error}"));
    }

    if let Some(endpoint) = &facts.applied {
        return match &facts.in_use {
            Some(still) if still.is_empty() => reset_step(
                "restore_proxy",
                true,
                format!("已恢复连接前的系统代理（{endpoint}）"),
            ),
            Some(still) => reset_step(
                "restore_proxy",
                false,
                format!("{endpoint} 仍被 {} 个网络服务使用", still.len()),
            ),
            // 核对不了就不能算已恢复。
            None => reset_step("restore_proxy", false, "无法确认系统代理是否已恢复"),
        };
    }

    let current = match facts.current.as_ref() {
        Some(CurrentProxy::Known(value)) => value,
        Some(CurrentProxy::Unknown(error)) => {
            return reset_step(
                "restore_proxy",
                false,
                format!("无法读取系统代理状态：{error}"),
            )
        }
        None => return reset_step("restore_proxy", false, "无法确认系统代理状态"),
    };

    let ours = facts.plan_port.map(|port| format!("127.0.0.1:{port}"));
    if let Some(ours) = &ours {
        if current.as_deref() == Some(ours.as_str()) {
            return reset_step(
                "restore_proxy",
                false,
                format!("系统代理仍指向 Veyl（{ours}）"),
            );
        }
    }
    if !facts.cleared_services.is_empty() {
        return reset_step(
            "restore_proxy",
            true,
            format!(
                "已清掉指向 Veyl 端口的系统代理：{}",
                facts.cleared_services.join("、")
            ),
        );
    }
    if ours.is_some() {
        // 知道我们的端口，且它不在当前设置里，可以确认。
        return reset_step("restore_proxy", true, "系统代理未指向 Veyl");
    }

    match current {
        None => reset_step("restore_proxy", true, "系统代理已关闭"),
        // 明确不是 Veyl：非回环地址，我们没有理由动它，也不该因此报失败。
        Some(endpoint) if !is_loopback_endpoint(endpoint) => reset_step(
            "restore_proxy",
            true,
            format!("系统代理不属于 Veyl（{endpoint}），未改动"),
        ),
        // 回环但端口对不上任何已知的本次连接：可能仍是 Veyl 的残留，不能算确认。
        Some(endpoint) => reset_step(
            "restore_proxy",
            false,
            format!("系统代理指向本机端口（{endpoint}），无法确认是否属于 Veyl；未做改动"),
        ),
    }
}

/// 顶层错误码保持旧取值；安装失败也归到 `helper_missing`，不出现第五种理由。
fn tun_error_code(error: &crate::tun::backend::TunError) -> &'static str {
    use crate::tun::backend::TunErrorCode;
    match error.code {
        TunErrorCode::TunDenied => "tun_denied",
        TunErrorCode::HelperMissing
        | TunErrorCode::HelperInstallFailed
        | TunErrorCode::UnsupportedPlatform => "helper_missing",
        _ => "tun_start_failed",
    }
}

/// 一次解析的产物：旁路前缀 + 域名 → 钉住的地址。
///
/// 没解析出来的域名不在这里出现；调用方按「是不是当前节点」决定是否阻断。
struct NodeBypass {
    prefixes: Vec<String>,
    pinned: std::collections::HashMap<String, std::net::IpAddr>,
}

type NodeResolveFuture =
    std::pin::Pin<Box<dyn std::future::Future<Output = Result<Vec<std::net::IpAddr>, ()>> + Send>>;
type NodeResolver = std::sync::Arc<dyn Fn(String) -> NodeResolveFuture + Send + Sync>;

/// 节点服务器必须直连，否则 sing-box 连自己的服务器也会被吸进 TUN，形成环路。
///
/// 所有域名**并发**解析，总时限 2.5 秒（单个域名另给 2 秒防长尾）。
/// 解析结果同时做两件事：
///   1) 全部地址（A/AAAA）加进 `route_exclude_address`；
///   2) 出站 `server` 钉到其中一个字面量 IP——否则 sing-box 会用
///      `default_domain_resolver` 再解析一次，GeoDNS / 轮换给出别的地址，
///      旁路就漏了，又绕回环路。TLS 的 `server_name` 保持域名不变。
async fn node_bypass_plan(descriptors: &[vpn_config::NodeDescriptor]) -> NodeBypass {
    let resolver: NodeResolver = std::sync::Arc::new(|server: String| {
        Box::pin(async move {
            tokio::net::lookup_host((server, 0))
                .await
                .map(|addresses| addresses.map(|address| address.ip()).collect())
                .map_err(|_| ())
        })
    });
    node_bypass_plan_with(descriptors, resolver).await
}

/// 解析器可注入：单测用一个永远不返回的解析器，才验证得到「并发 + 全局上限」，
/// 而不是碰运气等系统 DNS 快速失败。
async fn node_bypass_plan_with(
    descriptors: &[vpn_config::NodeDescriptor],
    resolver: NodeResolver,
) -> NodeBypass {
    use std::collections::{HashMap, HashSet};
    use std::net::IpAddr;

    const MAX_ADDRESSES_PER_HOST: usize = 16;
    const LOOKUP_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(2);
    const TOTAL_TIMEOUT: std::time::Duration = std::time::Duration::from_millis(2500);

    let mut plan = NodeBypass {
        prefixes: crate::tun::host_prefixes(descriptors.iter().map(|item| item.server.as_str())),
        pinned: HashMap::new(),
    };
    let mut seen = HashSet::new();
    let mut tasks = tokio::task::JoinSet::new();
    for descriptor in descriptors {
        let server = descriptor.server.trim().to_string();
        if server.parse::<IpAddr>().is_ok() || !seen.insert(server.clone()) {
            continue;
        }
        let resolver = std::sync::Arc::clone(&resolver);
        tasks.spawn(async move {
            let lookup = tokio::time::timeout(LOOKUP_TIMEOUT, resolver(server.clone())).await;
            (server, lookup)
        });
    }

    // 全局上限：订阅里几十个域名、DNS 又不通时，不能 2s × N 地串行等下去。
    let deadline = tokio::time::Instant::now() + TOTAL_TIMEOUT;
    while !tasks.is_empty() {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            tasks.abort_all();
            break;
        }
        match tokio::time::timeout(remaining, tasks.join_next()).await {
            Ok(Some(Ok((server, Ok(Ok(addresses)))))) => {
                let addresses = addresses
                    .into_iter()
                    .take(MAX_ADDRESSES_PER_HOST)
                    .collect::<Vec<_>>();
                if addresses.is_empty() {
                    continue;
                }
                // 优先 IPv4；只有 v6 时才用 v6。订阅里的节点绝大多数是 v4。
                let chosen = addresses
                    .iter()
                    .find(|address| address.is_ipv4())
                    .copied()
                    .unwrap_or(addresses[0]);
                for address in &addresses {
                    let prefix = match address {
                        IpAddr::V4(v4) => format!("{v4}/32"),
                        IpAddr::V6(v6) => format!("{v6}/128"),
                    };
                    if !plan.prefixes.contains(&prefix) {
                        plan.prefixes.push(prefix);
                    }
                }
                plan.pinned.insert(server, chosen);
            }
            Ok(Some(Ok(_))) | Ok(Some(Err(_))) => {}
            Ok(None) => break,
            Err(_) => {
                tasks.abort_all();
                break;
            }
        }
    }
    plan
}

/// 当前节点有没有可用的直连地址：字面量 IP，或者域名解析成功并已钉住。
fn node_server_is_resolved(
    server: &str,
    pinned: &std::collections::HashMap<String, std::net::IpAddr>,
) -> bool {
    let server = server.trim();
    server.parse::<std::net::IpAddr>().is_ok() || pinned.contains_key(server)
}

/// 轮询路由表直到接管完整或超时。返回仍然缺失的网段（空 = 完整）。
#[cfg(not(target_os = "windows"))]
async fn wait_for_takeover(
    tun_name: &str,
    excludes: &[String],
    timeout: std::time::Duration,
) -> Vec<String> {
    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        let name = tun_name.to_string();
        let expected = excludes.to_vec();
        let result =
            tokio::task::spawn_blocking(move || crate::tun::missing_takeover(&name, &expected))
                .await
                .unwrap_or_else(|error| Err(format!("路由复核任务失败：{error}")));
        match result {
            Ok(missing) if missing.is_empty() => return Vec::new(),
            Ok(missing) => {
                if tokio::time::Instant::now() >= deadline {
                    return missing;
                }
            }
            Err(error) => {
                log::warn!("读取路由表失败，继续等待：{error}");
                if tokio::time::Instant::now() >= deadline {
                    return vec![format!("无法读取路由表：{error}")];
                }
            }
        }
        tokio::time::sleep(std::time::Duration::from_millis(150)).await;
    }
}

/// 接管不完整按启动失败处理：**不能**把半成品留给用户，
/// 上层更不许把它报成「已连接」。
#[cfg(not(target_os = "windows"))]
fn takeover_incomplete_error(
    missing: &[String],
    stop_error: Option<&crate::tun::backend::TunError>,
    residual_routes: bool,
    dns_error: Option<&str>,
) -> anyhow::Error {
    let mut message = String::from("TUN 接管路由没有完整生效，已自动停止");
    if let Some(error) = stop_error {
        log::error!("回滚时停止 TUN 失败：{error}");
        message.push_str("。停止未成功，请到设置里执行「强制重置网络」");
    } else if residual_routes {
        log::error!("回滚后仍检测到残留路由或无法确认已清除");
        message.push_str("。未能确认接管路由已清除，请到设置里执行「强制重置网络」");
    } else {
        message.push_str("并清理路由");
    }
    // TUN 期间被 hijack 的 DNS 会把坏答案留在 mDNSResponder 里；
    // 进程停了不等于网络恢复，这一步失败要如实说。
    if let Some(error) = dns_error {
        log::error!("回滚时刷新 DNS 失败：{error}");
        message.push_str("。DNS 缓存未能刷新，若仍无法上网请重启系统");
    } else {
        message.push_str("，DNS 缓存已刷新");
    }
    if !missing.is_empty() {
        message.push_str("（未覆盖：");
        message.push_str(&missing.join("、"));
        message.push('）');
    }
    svc_error_with_details(
        "tun_start_failed",
        message,
        json!({
            "reason": "tun_start_failed",
            "permission_problem": false,
            "wire_code": null,
            "local_code": null,
            "detail": {
                "reason": "takeover_incomplete",
                "missing": missing,
                "residual_routes": residual_routes,
                "dns_flushed": dns_error.is_none(),
            },
        }),
    )
}

/// 停止后等接口销毁（内核会连带删掉接口上的路由）。
/// 返回 `false` 表示超时后仍读得到残留路由。
#[cfg(not(target_os = "windows"))]
async fn wait_until_routes_gone(tun_name: &str, timeout: std::time::Duration) -> bool {
    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        let name = tun_name.to_string();
        match tokio::task::spawn_blocking(move || crate::tun::routes_left(&name)).await {
            Ok(Ok(false)) => return true,
            Ok(Ok(true)) => {
                if tokio::time::Instant::now() >= deadline {
                    return false;
                }
            }
            Ok(Err(error)) => {
                // 读不到路由表 = 未知，不能当成「已清干净」；回滚宁可多提示一次。
                log::warn!("回滚后读取路由表失败，按未确认处理：{error}");
                return false;
            }
            Err(error) => {
                log::warn!("回滚核对任务失败，按未确认处理：{error}");
                return false;
            }
        }
        tokio::time::sleep(std::time::Duration::from_millis(150)).await;
    }
}

/// 用户视角的 DNS：系统解析器真的能给出地址。
///
/// 「进程没了、路由没了」不代表用户能上网——mDNSResponder 里可能还留着
/// TUN 期间的坏答案。
async fn probe_dns(domain: &str, timeout: std::time::Duration) -> Result<Vec<String>, String> {
    match tokio::time::timeout(timeout, tokio::net::lookup_host((domain, 443))).await {
        Ok(Ok(addresses)) => {
            let list = addresses
                .map(|address| address.ip().to_string())
                .collect::<Vec<_>>();
            if list.is_empty() {
                Err("没有返回任何地址".into())
            } else {
                Ok(list)
            }
        }
        Ok(Err(error)) => Err(format!("解析失败：{error}")),
        Err(_) => Err("解析超时".into()),
    }
}

/// 强制重置的直连 HTTPS 探针。第一个是这次真机故障的现场，
/// 第二个兜底，避免单个站点自身故障把「已恢复」误判成失败。
const DIRECT_PROBE_URLS: [&str; 2] = ["https://www.apple.com/", "https://www.baidu.com/"];

/// 真发一次 HTTPS 请求。`no_proxy` 是刻意的：要验证的是**直连**，
/// 不能让环境变量里的代理把结果洗白。
async fn probe_https(urls: &[&str], timeout: std::time::Duration) -> Result<(String, u16), String> {
    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(timeout)
        .build()
        .map_err(|error| format!("创建探测客户端失败：{error}"))?;
    let mut last = String::from("没有可用的探测地址");
    for url in urls {
        match client.get(*url).send().await {
            Ok(response) if response.status().is_success() => {
                return Ok(((*url).to_string(), response.status().as_u16()));
            }
            Ok(response) => last = format!("{url} 返回 {}", response.status().as_u16()),
            Err(error) => last = format!("{url} 请求失败：{error}"),
        }
    }
    Err(last)
}

/// 连接失败时带出来的运行时日志行数。
const RUNTIME_LOG_TAIL_LINES: usize = 20;

/// 读日志文件末尾：最多 32 KiB，再取最后 `lines` 个非空行。
///
/// 从中间开始读，避免为了 20 行把一个很大的日志整个读进内存；
/// 第一行可能是半截，丢掉。只掩掉像密钥的片段，不截断——截断了就看不出原因。
fn read_log_tail(path: &std::path::Path, lines: usize) -> Option<String> {
    use std::io::{Read, Seek, SeekFrom};

    const MAX_BYTES: u64 = 32 * 1024;
    let mut file = std::fs::File::open(path).ok()?;
    let len = file.metadata().ok()?.len();
    let start = len.saturating_sub(MAX_BYTES);
    file.seek(SeekFrom::Start(start)).ok()?;
    let mut bytes = Vec::new();
    file.take(MAX_BYTES).read_to_end(&mut bytes).ok()?;

    let text = String::from_utf8_lossy(&bytes).to_string();
    let text = if start > 0 {
        text.split_once('\n')
            .map(|(_, rest)| rest.to_string())
            .unwrap_or_default()
    } else {
        text
    };

    let picked: Vec<&str> = text
        .lines()
        .filter(|line| !line.trim().is_empty())
        .rev()
        .take(lines)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();
    if picked.is_empty() {
        return None;
    }

    let masked = crate::logging::mask_secrets(&picked.join("\n"));
    Some(if masked.chars().count() > 2000 {
        let head: String = masked.chars().take(2000).collect();
        format!("{head}…")
    } else {
        masked
    })
}

/// 配置里存的用户自定义排除网段（`tun_excludes` 是 JSON 数组）。
fn tun_excludes_from_value(value: &Value) -> Vec<String> {
    value
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_str())
                .map(|item| item.trim().to_string())
                .filter(|item| !item.is_empty())
                .collect()
        })
        .unwrap_or_default()
}

#[cfg(test)]
mod tun_wiring_tests {
    use super::*;

    #[test]
    fn tun_excludes_are_read_from_the_config_as_a_string_array() {
        let value = json!(["172.30.0.0/16", " 10.20.0.0/16 ", "", 42]);
        assert_eq!(
            tun_excludes_from_value(&value),
            vec!["172.30.0.0/16".to_string(), "10.20.0.0/16".to_string()],
            "非字符串与空串要丢掉，不能把一个数字当网段用"
        );
    }

    #[test]
    fn tun_excludes_tolerate_the_default_empty_object() {
        // 建表默认值是 {"mode":"auto","local":[],"remote":[]}，不是数组。
        let default = json!({"mode": "auto", "local": [], "remote": []});
        assert!(tun_excludes_from_value(&default).is_empty());
        assert!(tun_excludes_from_value(&Value::Null).is_empty());
    }
}

fn config_store_error(error: store::StoreError) -> anyhow::Error {
    match &error {
        store::StoreError::Invalid(message) if message.contains("配置名已存在") => {
            svc_error_with_details(
                "CONFLICT",
                "配置名已存在",
                json!({ "reason": "duplicate_name" }),
            )
        }
        store::StoreError::Invalid(message) => svc_error_with_details(
            "INVALID_ARGUMENT",
            message.clone(),
            json!({ "reason": "invalid_argument" }),
        ),
        store::StoreError::NotFound(_) => {
            svc_error_with_details("NOT_FOUND", "记录不存在", json!({ "reason": "not_found" }))
        }
        other => svc_error(other.code(), other),
    }
}

/// 连接只有真的进入 running 才算成功。
fn require_running_state(state: crate::runtime::RuntimeState) -> anyhow::Result<()> {
    if state == crate::runtime::RuntimeState::Running {
        Ok(())
    } else {
        Err(svc_error(
            "PRECONDITION_FAILED",
            format!(
                "运行时未进入 running（当前 {}），连接已中止",
                state.as_str()
            ),
        ))
    }
}

/// 可用运行时的判定：已安装记录优先，其次随包。
///
/// `active` 是 `(版本, 来源)`；来源为 `SOURCE_BUNDLED` 或 `SOURCE_INSTALLED`。
fn choose_available_runtime(
    active: Option<(String, String)>,
    bundled: Option<String>,
) -> Option<(String, &'static str)> {
    match active {
        Some((version, source)) if source == crate::runtime::SOURCE_BUNDLED => {
            Some((version, crate::runtime::SOURCE_BUNDLED))
        }
        Some((version, _)) => Some((version, crate::runtime::SOURCE_INSTALLED)),
        None => bundled.map(|version| (version, crate::runtime::SOURCE_BUNDLED)),
    }
}

fn runtime_source_label(source: &str) -> &'static str {
    if source == crate::runtime::SOURCE_BUNDLED {
        "随包"
    } else {
        "已安装"
    }
}

#[cfg(test)]
mod runtime_availability_tests {
    use super::*;
    use crate::runtime::{SOURCE_BUNDLED, SOURCE_INSTALLED};

    #[test]
    fn an_installed_runtime_wins_over_the_bundled_one() {
        let picked = choose_available_runtime(
            Some(("1.15.0".into(), SOURCE_INSTALLED.into())),
            Some("1.14.4".into()),
        );
        assert_eq!(picked, Some(("1.15.0".to_string(), SOURCE_INSTALLED)));
    }

    #[test]
    fn a_bundled_install_record_keeps_the_bundled_source() {
        let picked = choose_available_runtime(
            Some(("1.14.4".into(), SOURCE_BUNDLED.into())),
            Some("1.13.0".into()),
        );
        assert_eq!(picked, Some(("1.14.4".to_string(), SOURCE_BUNDLED)));
    }

    #[test]
    fn the_bundled_runtime_is_used_when_nothing_is_installed() {
        let picked = choose_available_runtime(None, Some("1.14.4".into()));
        assert_eq!(picked, Some(("1.14.4".to_string(), SOURCE_BUNDLED)));
    }

    /// 只有两份都没有时才是真正的「运行时不可用」。
    #[test]
    fn none_means_really_unavailable() {
        assert_eq!(choose_available_runtime(None, None), None);
    }
}

fn diag_check(
    name: &str,
    group: &str,
    ok: bool,
    detail: String,
    remediation: Option<&str>,
    action: Option<Value>,
) -> Value {
    json!({
        "name": name,
        "group": group,
        "ok": ok,
        "detail": detail,
        "remediation": remediation,
        "action": action,
    })
}

fn probe_result(
    node_id: &str,
    reachable: bool,
    latency_ms: Option<u64>,
    probe_method: &str,
    error: Option<(&str, &str)>,
) -> Value {
    json!({
        "node_id": node_id,
        "reachable": reachable,
        "latency_ms": latency_ms,
        "probe_method": probe_method,
        "checked_at": store::now_ms(),
        "error": error.map(|(code, message)| json!({ "code": code, "message": message })),
    })
}

/// 未连接时的降级探测：对 server:port 做 TCP 握手，3 秒超时。
async fn tcp_probe(server: &str, port: u16) -> Result<u64, String> {
    let address = if server.contains(':') {
        format!("[{server}]:{port}")
    } else {
        format!("{server}:{port}")
    };
    let started = std::time::Instant::now();
    match tokio::time::timeout(
        std::time::Duration::from_secs(3),
        tokio::net::TcpStream::connect(address),
    )
    .await
    {
        Ok(Ok(_stream)) => Ok(started.elapsed().as_millis() as u64),
        Ok(Err(error)) => Err(format!("TCP 连接失败：{error}")),
        Err(_) => Err("TCP 连接超时（3 秒）".to_string()),
    }
}

async fn clash_put_selector(
    addr: &str,
    secret: &str,
    selector: &str,
    value: &str,
) -> Result<(), String> {
    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(std::time::Duration::from_secs(5))
        .build()
        .map_err(|error| format!("创建控制面客户端失败：{error}"))?;
    let response = client
        .put(format!("http://{addr}/proxies/{selector}"))
        .bearer_auth(secret)
        .json(&json!({ "name": value }))
        .send()
        .await
        .map_err(|error| format!("切换选择器请求失败：{error}"))?;
    if !response.status().is_success() {
        return Err(format!("切换选择器返回 HTTP {}", response.status()));
    }
    Ok(())
}

async fn clash_get_selector(
    addr: &str,
    secret: &str,
    selector: &str,
) -> Result<Option<String>, String> {
    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(std::time::Duration::from_secs(5))
        .build()
        .map_err(|error| format!("创建控制面客户端失败：{error}"))?;
    let response = client
        .get(format!("http://{addr}/proxies/{selector}"))
        .bearer_auth(secret)
        .send()
        .await
        .map_err(|error| format!("读取选择器请求失败：{error}"))?;
    if response.status().as_u16() == 404 {
        return Ok(None);
    }
    if !response.status().is_success() {
        return Err(format!("读取选择器返回 HTTP {}", response.status()));
    }
    let value: Value = response
        .json()
        .await
        .map_err(|error| format!("读取选择器响应失败：{error}"))?;
    Ok(value.get("now").and_then(Value::as_str).map(str::to_string))
}

/// Clash API `GET /proxies/{selector}` 的成员表。
///
/// 热切前先查一次：TUN 会把解析不出地址的节点剔出 selector，
/// 直接 PUT 只会得到一句看不懂的 HTTP 400。
async fn clash_selector_members(
    addr: &str,
    secret: &str,
    selector: &str,
) -> Result<Vec<String>, String> {
    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(std::time::Duration::from_secs(5))
        .build()
        .map_err(|error| format!("创建控制面客户端失败：{error}"))?;
    let response = client
        .get(format!("http://{addr}/proxies/{selector}"))
        .bearer_auth(secret)
        .send()
        .await
        .map_err(|error| format!("读取选择器请求失败：{error}"))?;
    if !response.status().is_success() {
        return Err(format!("读取选择器返回 HTTP {}", response.status()));
    }
    let value: Value = response
        .json()
        .await
        .map_err(|error| format!("读取选择器响应失败：{error}"))?;
    Ok(value
        .get("all")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default())
}

/// 已连接的节点延迟：Clash API `GET /proxies/{tag}/delay`。
async fn clash_delay(addr: &str, secret: &str, tag: &str) -> Result<u64, String> {
    crate::runtime::health::ClashApi::new(addr, secret)
        .delay(tag)
        .await
        .map_err(|error| error.to_string())
}

async fn http_reachable(url: &str) -> bool {
    let Ok(client) = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .build()
    else {
        return false;
    };
    client.get(url).send().await.is_ok()
}

/// 首次注册的串行闸门。
pub struct RegistrationGate {
    ready: AtomicBool,
    lock: tokio::sync::Mutex<()>,
}

impl Default for RegistrationGate {
    fn default() -> Self {
        Self::new()
    }
}

impl RegistrationGate {
    pub fn new() -> Self {
        Self {
            ready: AtomicBool::new(false),
            lock: tokio::sync::Mutex::new(()),
        }
    }

    pub fn is_ready(&self) -> bool {
        self.ready.load(Ordering::SeqCst)
    }

    pub fn reset(&self) {
        self.ready.store(false, Ordering::SeqCst);
    }

    pub async fn ensure<F, Fut, E>(&self, register: F) -> Result<(), E>
    where
        F: FnOnce() -> Fut,
        Fut: std::future::Future<Output = Result<(), E>>,
    {
        if self.is_ready() {
            return Ok(());
        }

        let _guard = self.lock.lock().await;
        if self.is_ready() {
            return Ok(());
        }

        let result = register().await;
        if result.is_ok() {
            self.ready.store(true, Ordering::SeqCst);
        }
        result
    }
}

pub struct WiredServices {
    store: Arc<Store>,
    manager: Arc<RuntimeManager>,
    proxy: Arc<ProxyController>,
    catalog: Arc<CatalogClient>,
    installer: Installer,
    updates: crate::runtime::updates::UpdateManager,
    data_dir: PathBuf,
    device_gate: RegistrationGate,
    tun: Arc<crate::tun::session::TunSession>,
    helper: Arc<crate::tun::helper_update::HelperUpdater>,
}

impl WiredServices {
    pub fn new(
        store: Arc<Store>,
        manager: Arc<RuntimeManager>,
        proxy: Arc<ProxyController>,
        catalog: Arc<CatalogClient>,
        data_dir: impl Into<PathBuf>,
    ) -> Self {
        let data_dir = data_dir.into();
        let tun = Arc::new(crate::tun::session::TunSession::new(
            crate::tun::privilege::select(),
        ));
        let helper = Arc::new(crate::tun::helper_update::HelperUpdater::new(tun.backend()));
        Self {
            installer: Installer::new(&data_dir),
            updates: crate::runtime::updates::UpdateManager::new(&data_dir),
            store,
            manager,
            proxy,
            catalog,
            data_dir,
            device_gate: RegistrationGate::new(),
            tun,
            helper,
        }
    }

    /// 启动后台的 helper 构建检查（不阻塞 UI、不弹窗）。
    pub fn spawn_helper_updater(self: &Arc<Self>) {
        self.helper.spawn_background();
    }

    /// 退出流程需要直接停 TUN；生命周期层不依赖工具层。
    pub fn tun_session(&self) -> Arc<crate::tun::session::TunSession> {
        Arc::clone(&self.tun)
    }

    fn config_dir(&self) -> PathBuf {
        self.data_dir.join("config")
    }

    /// 测试夹具专用：假运行时是 shell 脚本，不可能带上代码签名。
    #[cfg(test)]
    pub(crate) fn allow_unsigned_runtime(&mut self) {
        self.installer.allow_unsigned_runtime();
    }

    /// 把网络恢复到「我们没动过」的状态。
    ///
    /// **E3 重置网络与卸载清理都调这一个函数**（`docs/capabilities.md` §3.1：
    /// 两处必须共用同一段代码，不能各写一套）。E3 的界面这轮不做。
    ///
    /// 顺序不可换：先停进程再撤代理。反过来的话，中间那几百毫秒里系统代理
    /// 指向一个已经关掉的端口，用户那一刻整机没有网。
    /// 共享动作：E3/卸载（`cleanup_network`）与强制重置走**同一份**。
    ///
    /// `Err` 表示「没能确认停掉」，不是「本来就没事」——helper 不可用时
    /// `TunSession::stop()` 会直接返回成功，这里必须挡在它前面。
    fn decide_tun_stop(
        was_running: bool,
        helper: crate::tun::privilege::HelperStatus,
        stop: Result<(), String>,
    ) -> TunStopOutcome {
        use crate::tun::privilege::HelperStatus;

        if !helper.is_ready() && !matches!(helper, HelperStatus::Unsupported) {
            return TunStopOutcome::Unconfirmed(format!(
                "特权助手不可用（{}），无法停止或确认 TUN",
                helper.as_str()
            ));
        }
        match stop {
            Ok(()) => TunStopOutcome::Stopped { was_running },
            Err(message) => TunStopOutcome::Failed(message),
        }
    }

    async fn tun_stop_outcome(&self) -> TunStopOutcome {
        use crate::tun::session::TunState;

        let was_running = matches!(self.tun.status(), TunState::Running { .. });
        let helper = self.tun.helper_status();
        let stop = if helper.is_ready()
            || matches!(helper, crate::tun::privilege::HelperStatus::Unsupported)
        {
            // 强制重置的 stop 要能排到进行中的 start 后面：真机首跑准备规则约 30 秒。
            self.tun
                .stop_with_deadline(std::time::Duration::from_secs(60))
                .map_err(|error| format!("停止 TUN 失败：{}", error.message))
        } else {
            // 问不到就别发请求：stop() 在这种状态下会假装成功。
            Ok(())
        };
        Self::decide_tun_stop(was_running, helper, stop)
    }

    async fn stop_tun_action(&self) -> Result<bool, String> {
        match self.tun_stop_outcome().await {
            TunStopOutcome::Stopped { was_running } => Ok(was_running),
            TunStopOutcome::Unconfirmed(message) | TunStopOutcome::Failed(message) => Err(message),
        }
    }

    async fn stop_runtime_action(&self) -> Result<(), String> {
        self.manager
            .stop()
            .await
            .map_err(|error| format!("停止运行时失败：{error}"))?;
        // 与 cleanup_network 共用同一段：运行时停了，快照里的标志也要落。
        self.manager.set_system_proxy_enabled(false).await;
        Ok(())
    }

    fn restore_proxy_action(&self) -> Result<(), anyhow::Error> {
        self.restore_system_proxy()
    }

    fn flush_dns_action(&self) -> Result<(), String> {
        // 助手可用时走特权通道：macOS 上 mDNSResponder 只有 root 能 HUP。
        if matches!(
            self.tun.helper_status(),
            crate::tun::privilege::HelperStatus::Enabled
        ) {
            return self
                .tun
                .flush_dns()
                .map_err(|error| flush_dns_failure_message(&error));
        }
        crate::netcfg::flush_dns()
    }

    /// 清掉明文配置与运行记录。返回 `(profile 数, 是否删了 active.json, 是否删了 runtime.pid)`。
    fn clear_plaintext_action(&self) -> Result<(usize, bool, bool), String> {
        let removed = vpn_config::remove_all_profile_configs_checked(&self.config_dir())?;

        // `remove_all_profile_configs_checked` 只清 `profile-*`，连接时 rename
        // 出来的 `active.json` 同样是明文，要单独删。
        let active_path = self.config_dir().join("active.json");
        let active_removed = match std::fs::remove_file(&active_path) {
            Ok(()) => true,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
            Err(error) => return Err(format!("删除 active.json 失败：{error}")),
        };

        // 进程还活着就别删记录：那是下次启动安全回收的唯一线索。
        // 用命令行核对，不只看 pid——pid 会被复用。
        if self.manager.recorded_sing_box_is_alive() {
            return Err("明文配置已清理；代理 sing-box 仍在运行，保留运行记录以便下次回收".into());
        }
        let pid_path = self.data_dir.join("runtime.pid");
        let pid_removed = match std::fs::remove_file(&pid_path) {
            Ok(()) => true,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
            Err(error) => return Err(format!("删除运行记录失败：{error}")),
        };

        Ok((removed, active_removed, pid_removed))
    }

    #[allow(dead_code)] // E3 重置网络与卸载清理的接缝，界面还没做
    pub(crate) async fn cleanup_network(
        &self,
        config_id: Option<String>,
    ) -> crate::tun::session::CleanupReport {
        use crate::tun::session::CleanupReport;

        let mut report = CleanupReport::default();

        match self.stop_tun_action().await {
            Ok(_) => report.stopped_tun = true,
            Err(error) => report.failures.push(error),
        }
        match self.stop_runtime_action().await {
            Ok(()) => report.stopped_runtime = true,
            Err(error) => report.failures.push(error),
        }
        match self.restore_proxy_action() {
            Ok(()) => report.restored_proxy = true,
            Err(error) => report.failures.push(user_message(&error)),
        }
        match self.flush_dns_action() {
            Ok(()) => report.flushed_dns = true,
            Err(error) => report.failures.push(error),
        }

        report.removed_configs = match config_id {
            Some(id) => {
                vpn_config::remove_profile_config(&self.config_dir(), &id);
                1
            }
            None => match self.clear_plaintext_action() {
                Ok((removed, _, _)) => removed,
                Err(error) => {
                    report.failures.push(error);
                    0
                }
            },
        };

        report
    }

    fn active_config_id(&self) -> Option<String> {
        let conn = self.store.conn();
        configs::active(&conn)
            .ok()
            .flatten()
            .map(|config| config.id)
    }

    fn require_config(&self, config_id: &str) -> anyhow::Result<configs::Config> {
        let conn = self.store.conn();
        configs::get(&conn, config_id)
            .map_err(|error| svc_error(error.code(), error))?
            .ok_or_else(|| svc_error("NOT_FOUND", "配置不存在"))
    }

    fn resolve_config(&self, config_id: Option<String>) -> anyhow::Result<configs::Config> {
        match config_id {
            Some(id) => self.require_config(&id),
            None => {
                let id = self.active_config_id().ok_or_else(|| {
                    svc_error_with_details(
                        "PRECONDITION_FAILED",
                        "还没有配置，先新建一套",
                        json!({ "reason": "no_config" }),
                    )
                })?;
                self.require_config(&id)
            }
        }
    }

    fn update_routing_mode(&self, config_id: &str, mode: &str) -> anyhow::Result<configs::Config> {
        {
            let conn = self.store.conn();
            configs::update(
                &conn,
                config_id,
                &configs::ConfigPatch {
                    routing_mode: Some(mode.to_string()),
                    ..Default::default()
                },
            )
            .map_err(|error| svc_error(error.code(), error))?;
        }
        self.require_config(config_id)
    }

    fn route_state_json(
        &self,
        config: &configs::Config,
        applied_mode: Option<&str>,
        applied_revision: Option<i64>,
    ) -> Value {
        let targets = config
            .route_targets
            .as_array()
            .map(|items| {
                items
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_string)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let applied = applied_mode.is_some() && applied_revision == Some(config.route_revision);
        let region = crate::rules::detected_region();
        let basis = if region.as_deref().unwrap_or("cn") == "cn" {
            "domain_and_ip"
        } else {
            "ip_only"
        };
        json!({
            "config_id": config.id,
            "routing_mode": config.routing_mode,
            "applied_mode": applied_mode,
            "targets": targets,
            "custom_rules": [],
            "route_revision": config.route_revision,
            "applied_revision": applied_revision,
            "effective": if applied { "current_connection" } else { "next_connection" },
            "reconnect_required": !applied,
            "local_direct_basis": basis,
            "detected_region": region,
        })
    }

    fn emit_routing_changed(
        &self,
        config: &configs::Config,
        change: &str,
        applied_mode: Option<&str>,
        applied_revision: Option<i64>,
        hot_switched: bool,
    ) {
        let state = self.route_state_json(config, applied_mode, applied_revision);
        crate::agent::app_handle::emit(
            "routing-changed",
            json!({
                "contract_version": crate::runtime::EVENT_CONTRACT_VERSION,
                "config_id": config.id,
                "routing_mode": config.routing_mode,
                "applied_mode": applied_mode,
                "targets": state["targets"].clone(),
                "route_revision": config.route_revision,
                "applied_revision": applied_revision,
                "change": change,
                "hot_switched": hot_switched,
                "reconnect_required": state["reconnect_required"].clone(),
                "emitted_at": chrono::Utc::now()
                    .to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
            }),
        );
    }

    async fn ensure_device_token(&self) -> anyhow::Result<()> {
        self.device_gate
            .ensure(|| async {
                match crate::secrets::get_device_token() {
                    Ok(Some(token)) => {
                        self.catalog.set_token(Some(token));
                        return Ok(());
                    }
                    Ok(None) => {}
                    Err(error) => log::warn!("读取本地设备 token 失败：{error}"),
                }
                self.register_device().await
            })
            .await
    }

    async fn reauthenticate(&self) -> anyhow::Result<()> {
        self.device_gate.reset();
        let _ = crate::secrets::delete_device_token();
        self.catalog.set_token(None);
        self.ensure_device_token().await
    }

    async fn register_device(&self) -> anyhow::Result<()> {
        let machine_id = crate::catalog::machine_fingerprint()
            .unwrap_or_else(|| format!("unknown-{:016x}", rand::random::<u64>()));
        let request = crate::catalog::RegisterDeviceRequest::new(
            crate::catalog::device_fingerprint(&machine_id),
        );

        let response = self
            .catalog
            .register_device(&request)
            .await
            .map_err(|e| svc_error(e.code.clone(), format!("设备注册失败：{e}")))?;

        if let Err(error) = crate::secrets::set_device_token(&response.device_token) {
            log::warn!("设备 token 写本地失败（本次运行仍可用）：{error}");
        }
        self.catalog.set_token(Some(response.device_token.clone()));
        log::info!("目录服务设备已注册：{}", response.device_id);
        Ok(())
    }

    async fn catalog_list(
        &self,
        query: &crate::catalog::NodeQuery,
    ) -> anyhow::Result<crate::catalog::NodeListResponse> {
        self.ensure_device_token().await?;
        match self.catalog.list_nodes(query).await {
            Ok(response) => Ok(response),
            Err(error) if error.is_unauthorized() => {
                log::warn!("目录查询 401，重新注册设备后重试一次");
                self.reauthenticate().await?;
                self.catalog
                    .list_nodes(query)
                    .await
                    .map_err(|e| svc_error(e.code.clone(), e))
            }
            Err(error) => Err(svc_error(error.code.clone(), error)),
        }
    }

    /// 当前可用的运行时：已安装且可执行 > 随包。与 `core_info` 同一判据。
    ///
    /// 「未运行」不等于「未安装」：状态查询必须能把可用的版本与来源报出来，
    /// 否则未连接时会被误判成没有运行时。
    async fn available_runtime(&self) -> Option<(String, &'static str)> {
        let active = self
            .installer
            .active()
            .ok()
            .flatten()
            .map(|runtime| (runtime.version, runtime.source));
        let bundled = if active.is_none() {
            self.installer.bundled_version().await
        } else {
            None
        };
        choose_available_runtime(active, bundled)
    }

    /// 连接前取运行时：已安装且校验通过优先，否则用随包那份。
    ///
    /// **不联网。** 两份都不可用时直接失败并把原因说清楚——首次启动时用户
    /// 最可能没有网，静默下载只会把可诊断的问题拖成超时。
    async fn ensure_runtime(&self) -> anyhow::Result<crate::runtime::InstalledRuntime> {
        self.installer
            .select_runtime()
            .await
            .map_err(|error| match &error {
                crate::runtime::RuntimeError::BundledUnavailable(detail) => {
                    svc_error_with_details(
                        error.code(),
                        format!(
                            "{}（{detail}）",
                            crate::runtime::signature::rejection_hint()
                        ),
                        json!({ "reason": "runtime_unavailable" }),
                    )
                }
                _ => svc_error(error.code(), error),
            })
    }

    /// 磁盘配置里读回端口与 secret；配置损坏时返回 None。
    fn config_endpoints(value: &Value) -> Option<(u16, u16, String)> {
        let mixed = value
            .get("inbounds")?
            .as_array()?
            .first()?
            .get("listen_port")?
            .as_u64()? as u16;
        let clash = value.get("experimental")?.get("clash_api")?;
        let controller = clash.get("external_controller")?.as_str()?;
        let clash_port = controller.rsplit(':').next()?.parse().ok()?;
        let secret = clash.get("secret")?.as_str()?.to_string();
        Some((mixed, clash_port, secret))
    }

    /// `ConfigSummary`（`commands.md` §3.0）。列表里不返回节点明细。
    fn config_summary_json(&self, config: &configs::Config) -> anyhow::Result<Value> {
        let node_count = {
            let conn = self.store.conn();
            configs::node_count(&conn, &config.id)
                .map_err(|error| svc_error(error.code(), error))?
        };
        Ok(json!({
            "config_id": config.id,
            "name": config.name,
            "connect_mode": config.connection_mode,
            "routing_mode": config.routing_mode,
            "node_count": node_count,
            "listen_port": config.listen_port,
            "is_active": config.is_active,
            "current_node_id": config.current_node_id,
            "created_at": config.created_at,
            "updated_at": config.updated_at,
            "last_used_at": config.last_used_at,
        }))
    }

    /// `ConfigDetail`：摘要 + 节点集 + DNS + 内网排除 + 布局。
    fn config_detail_json(&self, config: &configs::Config) -> anyhow::Result<Value> {
        let (nodes, layout) = {
            let conn = self.store.conn();
            let nodes = configs::list_nodes(&conn, &config.id)
                .map_err(|error| svc_error(error.code(), error))?;
            let layout = crate::store::layout::get(&conn, &config.id)
                .map_err(|error| svc_error(error.code(), error))?
                .map(|(_revision, layout)| layout);
            (nodes, layout)
        };
        let mut detail = self.config_summary_json(config)?;
        detail["nodes"] = Value::Array(nodes.iter().map(node_json).collect());
        detail["dns"] = config.dns.clone();
        detail["tun_excludes"] = config.tun_excludes.clone();
        detail["layout"] = layout.unwrap_or(Value::Null);
        Ok(detail)
    }

    fn emit_config_changed(&self, change: &str, config: Option<&configs::Config>) {
        let summary = config
            .and_then(|config| self.config_summary_json(config).ok())
            .unwrap_or(Value::Null);
        crate::agent::app_handle::emit(
            "config-changed",
            json!({
                "contract_version": crate::runtime::EVENT_CONTRACT_VERSION,
                "change": change,
                "config_id": config.map(|config| config.id.clone()),
                "config": summary,
                "active_config_id": self.active_config_id(),
                "emitted_at": chrono::Utc::now()
                    .to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
            }),
        );
    }

    /// 写节点：先凭据后行；`skip_duplicates` 用于 URL 导入（同来源同身份算重复）。
    fn add_parsed_nodes(
        &self,
        config_id: Option<&str>,
        parsed: &[crate::nodes::ParsedNode],
        source: &str,
        skip_duplicates: bool,
    ) -> anyhow::Result<(Vec<configs::Node>, Vec<crate::nodes::SkippedNode>)> {
        let mut added = Vec::new();
        let mut skipped = Vec::new();
        for node in parsed {
            let key = crate::nodes::source_key(&node.name, &node.server, node.port, &node.method);
            let id = crate::nodes::node_id(source, &key);
            let password_ref = crate::nodes::password_ref(&id);

            if skip_duplicates {
                let exists = {
                    let conn = self.store.conn();
                    configs::find_node_by_source_key(&conn, source, &key)
                        .map_err(|error| svc_error(error.code(), error))?
                        .is_some()
                };
                if exists {
                    skipped.push(crate::nodes::SkippedNode {
                        name: Some(node.name.clone()),
                        reason: crate::nodes::SkipReason::Duplicate,
                        detail: "节点池里已有相同节点".into(),
                    });
                    continue;
                }
            }

            // 先写凭据再写行：反过来一旦凭据写失败，库里会留下一条连不上的节点。
            crate::secrets::set_secret(&password_ref, &node.password)
                .map_err(|error| svc_error("SECRET_STORE", error))?;

            let stored = (|| -> anyhow::Result<configs::Node> {
                let conn = self.store.conn();
                let stored = configs::upsert_node(
                    &conn,
                    &configs::NewNode {
                        id: &id,
                        name: &node.name,
                        server: &node.server,
                        port: node.port,
                        method: &node.method,
                        password_ref: &password_ref,
                        source,
                        source_key: &key,
                    },
                )
                .map_err(|error| svc_error(error.code(), error))?;
                if let Some(config_id) = config_id {
                    configs::attach_node(&conn, config_id, &id)
                        .map_err(|error| svc_error(error.code(), error))?;
                }
                Ok(stored)
            })();

            match stored {
                Ok(stored) => added.push(stored),
                Err(error) => {
                    // 行没写进去，凭据也不该留下。
                    let _ = crate::secrets::delete_secret(&password_ref);
                    return Err(error);
                }
            }
        }

        if let Some(config_id) = config_id {
            if !added.is_empty() {
                let conn = self.store.conn();
                let config = configs::get(&conn, config_id)
                    .map_err(|error| svc_error(error.code(), error))?
                    .ok_or_else(|| svc_error("NOT_FOUND", "配置不存在"))?;
                if config.current_node_id.is_none() {
                    let _ = configs::update(
                        &conn,
                        config_id,
                        &configs::ConfigPatch {
                            current_node_id: Some(Some(added[0].id.clone())),
                            ..Default::default()
                        },
                    );
                }
            }
        }
        Ok((added, skipped))
    }

    /// 把种子缓存里的节点落到当前配置。种子只给节点，分流由配置自己决定。
    fn materialize_seed_nodes(&self, config_id: &str) -> anyhow::Result<usize> {
        let nodes = crate::seed::load_nodes(&self.store).ok_or_else(|| {
            svc_error_with_details(
                "PRECONDITION_FAILED",
                "现在拿不到测试节点，先刷新测试节点或手动添加一个",
                json!({ "reason": "seed_unavailable", "hint": "先刷新测试节点或手动添加节点" }),
            )
        })?;
        let exclusions = {
            let conn = self.store.conn();
            configs::seed_exclusions(&conn).map_err(|error| svc_error(error.code(), error))?
        };
        let parsed: Vec<crate::nodes::ParsedNode> = nodes
            .into_iter()
            .filter(|node| {
                let key =
                    crate::nodes::source_key(&node.name, &node.server, node.port, &node.method);
                !exclusions.contains(&key)
            })
            .map(|node| crate::nodes::ParsedNode {
                name: node.name,
                server: node.server,
                port: node.port,
                method: node.method,
                password: node.password,
            })
            .collect();
        let (added, _) =
            self.add_parsed_nodes(Some(config_id), &parsed, configs::SOURCE_SEED, false)?;
        Ok(added.len())
    }

    fn active_node(&self, config: &configs::Config) -> anyhow::Result<(configs::Node, String)> {
        let nodes = {
            let conn = self.store.conn();
            configs::list_nodes(&conn, &config.id)
                .map_err(|error| svc_error(error.code(), error))?
        };
        if nodes.is_empty() {
            return Err(svc_error_with_details(
                "PRECONDITION_FAILED",
                "这套配置还没有节点，先导入或添加一个",
                json!({ "reason": "no_nodes" }),
            ));
        }

        let node = config
            .current_node_id
            .as_ref()
            .and_then(|id| nodes.iter().find(|node| &node.id == id).cloned())
            .unwrap_or_else(|| nodes[0].clone());

        let password = crate::secrets::get_secret(&node.password_ref)
            .map_err(|error| svc_error("SECRET_STORE", error))?
            .ok_or_else(|| svc_error("PRECONDITION_FAILED", "节点凭据缺失，请重新导入该节点"))?;

        Ok((node, password))
    }

    fn is_connected(&self, status: &crate::runtime::RuntimeStatus) -> bool {
        matches!(
            status.state,
            crate::runtime::RuntimeState::Running | crate::runtime::RuntimeState::Degraded
        )
    }

    fn seed_status_json(&self, source: &str, changed: bool) -> Value {
        let mut status = crate::seed::status(&self.store);
        // `source = cache` 表示本次没有成功访问远端，用的是本地缓存；
        // `changed = true` 才表示这次刷新真的换了内容。
        status["source"] = json!(source);
        status["changed"] = json!(changed);
        status
    }

    /// 校验「指定服务」分类：必须存在且能参与 DNS 决策。
    fn validate_targets(&self, targets: &[String]) -> anyhow::Result<()> {
        if targets.is_empty() {
            return Err(svc_error_with_details(
                "PRECONDITION_FAILED",
                "指定服务走 VPN 时至少要选一个分类",
                json!({ "reason": "route_targets_empty" }),
            ));
        }
        let categories = crate::rules::categories(&self.store, &self.data_dir);
        if categories.is_empty() {
            return Err(svc_error_with_details(
                "PRECONDITION_FAILED",
                "规则数据尚未就绪",
                json!({ "reason": "rules_not_ready" }),
            ));
        }
        let known = categories
            .iter()
            .map(|category| (category.id.as_str(), category))
            .collect::<std::collections::HashMap<_, _>>();
        let unknown = targets
            .iter()
            .filter(|id| !known.contains_key(id.as_str()))
            .cloned()
            .collect::<Vec<_>>();
        if !unknown.is_empty() {
            return Err(svc_error_with_details(
                "NOT_FOUND",
                "有分类不存在",
                json!({ "reason": "category_unknown", "unknown": unknown }),
            ));
        }
        let not_classifiable = targets
            .iter()
            .filter(|id| {
                known
                    .get(id.as_str())
                    .map(|category| !category.dns_classifiable)
                    .unwrap_or(false)
            })
            .cloned()
            .collect::<Vec<_>>();
        if !not_classifiable.is_empty() {
            return Err(svc_error_with_details(
                "UNSUPPORTED",
                "这些分类没有域名规则集，不能用于指定服务走 VPN",
                json!({
                    "reason": "category_not_dns_classifiable",
                    "categories": not_classifiable
                }),
            ));
        }
        Ok(())
    }

    async fn connected_config_id(&self) -> Option<String> {
        // TUN 的进程不在 manager 里，只看 current_plan 会漏掉一整个连接方式。
        if let Some(id) = self.tun.connected_config_id() {
            return Some(id);
        }
        self.manager
            .current_plan()
            .await
            .and_then(|plan| plan.config_id)
    }
}

/// 节点 JSON（`commands.md` §3.0 的 `NodeSummary`）。不含密码。
fn node_json(node: &configs::Node) -> Value {
    json!({
        "node_id": node.id,
        "name": node.name,
        "server": node.server,
        "port": node.port,
        "method": node.method,
        "protocol": "shadowsocks",
        "source": node.source,
        "created_at": node.created_at,
    })
}

fn validate_connect_mode(value: &str) -> anyhow::Result<()> {
    if matches!(
        value,
        configs::CONNECTION_SYSTEM_PROXY | configs::CONNECTION_TUN
    ) {
        Ok(())
    } else {
        Err(svc_error_with_details(
            "INVALID_ARGUMENT",
            format!("不支持的连接方式：{value}"),
            json!({ "reason": "invalid_connect_mode" }),
        ))
    }
}

fn validate_routing_mode(value: &str) -> anyhow::Result<()> {
    if matches!(
        value,
        configs::ROUTING_DIRECT | configs::ROUTING_PROXY_ALL | configs::ROUTING_PROXY_SELECTED
    ) {
        Ok(())
    } else {
        Err(svc_error_with_details(
            "INVALID_ARGUMENT",
            format!("不支持的分流策略：{value}"),
            json!({ "reason": "invalid_routing_mode" }),
        ))
    }
}

fn validate_dns(dns: Option<&Value>) -> anyhow::Result<Value> {
    let Some(dns) = dns else {
        return Ok(json!({ "mode": "auto", "local": [], "remote": [] }));
    };
    let object = dns.as_object().ok_or_else(|| {
        svc_error_with_details(
            "INVALID_ARGUMENT",
            "DNS 配置必须是对象",
            json!({ "reason": "invalid_dns" }),
        )
    })?;

    let mode = object.get("mode").and_then(Value::as_str).unwrap_or("auto");
    if !matches!(mode, "auto" | "custom") {
        return Err(svc_error_with_details(
            "INVALID_ARGUMENT",
            "DNS mode 只能是 auto 或 custom",
            json!({ "reason": "invalid_dns" }),
        ));
    }

    let list = |key: &str| -> anyhow::Result<Vec<String>> {
        let items = object
            .get(key)
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let mut entries = Vec::new();
        for item in items {
            let value = item.as_str().ok_or_else(|| {
                svc_error_with_details(
                    "INVALID_ARGUMENT",
                    "DNS 候选必须是字符串数组",
                    json!({ "reason": "invalid_dns" }),
                )
            })?;
            value.parse::<std::net::IpAddr>().map_err(|_| {
                svc_error_with_details(
                    "INVALID_ARGUMENT",
                    format!("DNS 地址不合法：{value}"),
                    json!({ "reason": "invalid_dns" }),
                )
            })?;
            entries.push(value.to_string());
        }
        Ok(entries)
    };

    let local = list("local")?;
    let remote = list("remote")?;
    if local.len() > 3 || remote.len() > 2 {
        return Err(svc_error_with_details(
            "INVALID_ARGUMENT",
            "DNS 候选数量超出上限（本地 3 个、境外 2 个）",
            json!({ "reason": "invalid_dns" }),
        ));
    }
    if mode == "custom" && local.is_empty() {
        return Err(svc_error_with_details(
            "INVALID_ARGUMENT",
            "自定义 DNS 至少需要一个本地候选",
            json!({ "reason": "invalid_dns" }),
        ));
    }

    Ok(json!({ "mode": mode, "local": local, "remote": remote }))
}

fn validate_tun_excludes(
    connection_mode: &str,
    excludes: Option<&[String]>,
) -> anyhow::Result<Value> {
    let entries = excludes.unwrap_or(&[]);
    if connection_mode != configs::CONNECTION_TUN && !entries.is_empty() {
        return Err(svc_error_with_details(
            "INVALID_ARGUMENT",
            "内网排除只在接管全部流量时使用",
            json!({ "reason": "invalid_tun_excludes" }),
        ));
    }
    if entries.len() > 32 {
        return Err(svc_error_with_details(
            "INVALID_ARGUMENT",
            "内网排除最多 32 项",
            json!({ "reason": "invalid_tun_excludes" }),
        ));
    }
    for entry in entries {
        validate_cidr(entry).map_err(|detail| {
            svc_error_with_details(
                "INVALID_ARGUMENT",
                format!("网段格式不合法：{detail}"),
                json!({ "reason": "invalid_cidr" }),
            )
        })?;
    }
    Ok(json!(entries))
}

fn validate_cidr(value: &str) -> Result<(), String> {
    let (address, prefix) = value.split_once('/').ok_or_else(|| value.to_string())?;
    let ip: std::net::IpAddr = address.parse().map_err(|_| value.to_string())?;
    let prefix: u8 = prefix.parse().map_err(|_| value.to_string())?;
    let max = if ip.is_ipv4() { 32 } else { 128 };
    if prefix > max {
        return Err(value.to_string());
    }
    Ok(())
}

#[async_trait]
impl VpnToolServices for WiredServices {
    async fn runtime_status(&self) -> anyhow::Result<Value> {
        // TUN 的进程不归 RuntimeManager 管，状态得单独报，否则界面会显示「未连接」。
        // **必须返回与代理模式同形状的完整快照**：手工拼 JSON 少一个 `health`
        // 就会让 `bridge.ts` 读 undefined 直接崩（helper 在 App 崩溃后仍存活的接手场景）。
        let mut status = if let crate::tun::session::TunState::Running { pid } = self.tun.status() {
            let meta = self.tun.launch_meta();
            crate::runtime::RuntimeStatus::tun(crate::runtime::TunSnapshotInput {
                pid,
                config_id: meta.as_ref().map(|meta| meta.config_id.clone()),
                config_name: meta.as_ref().and_then(|meta| meta.config_name.clone()),
                node_id: meta.as_ref().and_then(|meta| meta.node_id.clone()),
                node_name: meta.as_ref().and_then(|meta| meta.node_name.clone()),
                applied_route_revision: meta.as_ref().and_then(|meta| meta.applied_route_revision),
                connected_since: self.tun.connected_since(),
                uptime_seconds: self.tun.uptime_seconds(),
            })
        } else {
            self.manager.status().await
        };

        // 未运行时 `upstream_version` 由 manager 置 null，但「不可用」和「没运行」
        // 是两件事：把当前可用的运行时版本与来源一并报出来，消费方不必再去猜。
        let available = self.available_runtime().await;
        status.upstream_version = match (&available, &status.upstream_version) {
            (Some((version, _)), None) => Some(version.clone()),
            (_, running) => running.clone(),
        };
        let mut value = serde_json::to_value(status).map_err(|e| svc_error("INTERNAL", e))?;
        value["runtime_source"] = json!(available
            .as_ref()
            .map(|(_, source)| *source)
            .unwrap_or("none"));
        Ok(value)
    }

    async fn runtime_start(&self, config_id: Option<String>) -> anyhow::Result<Value> {
        if crate::lifecycle::is_quitting() {
            return Err(svc_error_with_details(
                "PRECONDITION_FAILED",
                "应用正在退出，不能再发起连接",
                json!({ "reason": "quitting" }),
            ));
        }
        let config_id = match config_id {
            Some(id) => id,
            None => self.active_config_id().ok_or_else(|| {
                svc_error_with_details(
                    "PRECONDITION_FAILED",
                    "还没有配置，先新建一套",
                    json!({ "reason": "no_config" }),
                )
            })?,
        };
        let config = self.require_config(&config_id)?;
        self.connect(&config).await
    }

    async fn runtime_stop(&self, _force: bool) -> anyhow::Result<Value> {
        let connected = self.connected_config_id().await;
        // TUN 的 sing-box 是 helper 的子进程，manager 的 stop 碰不到它，单独停。
        // 幂等：本来就没在跑时直接返回。
        // 停不掉不能吞：界面上显示已停、流量却还在被接管，比报错糟得多。
        let tun_stop_error = self.tun.stop().err();
        self.restore_system_proxy()?;
        self.manager.set_system_proxy_enabled(false).await;
        let status = self
            .manager
            .stop()
            .await
            .map_err(|e| svc_error(e.code(), e))?;
        // 断开即删明文配置：它只在连接期间允许存在。
        if let Some(config_id) = connected {
            vpn_config::remove_profile_config(&self.config_dir(), &config_id);
        }
        if let Some(error) = tun_stop_error {
            return Err(svc_error_with_details(
                "INTERNAL",
                format!("特权连接没有停掉：{}", error.message),
                // 理由仍只出四种；停不掉的具体原因在 wire_code / local_code 里。
                tun_error_details(&error),
            ));
        }
        serde_json::to_value(status).map_err(|e| svc_error("INTERNAL", e))
    }

    async fn runtime_restart(&self, _reason: Option<String>) -> anyhow::Result<Value> {
        let status = self
            .manager
            .restart()
            .await
            .map_err(|e| svc_error(e.code(), e))?;
        serde_json::to_value(status).map_err(|e| svc_error("INTERNAL", e))
    }

    async fn runtime_logs(&self, lines: u32, _level: Option<String>) -> anyhow::Result<Value> {
        let status = self.manager.status().await;
        let content = match status.upstream_version {
            Some(version) => {
                let path = StartPlan::log_path(&self.manager.cfg, &version);
                std::fs::read_to_string(path).unwrap_or_default()
            }
            None => String::new(),
        };
        let tail: Vec<&str> = content.lines().rev().take(lines as usize).collect();
        let tail: Vec<&str> = tail.into_iter().rev().collect();
        Ok(json!({ "lines": tail, "truncated": false, "redacted_fields": ["password"] }))
    }

    async fn core_list_versions(&self) -> anyhow::Result<Value> {
        let manifest =
            crate::runtime::RuntimeManifest::builtin().map_err(|e| svc_error(e.code(), e))?;
        let (platform, arch) = crate::runtime::RuntimeManifest::host_platform();
        let available: Vec<Value> = manifest
            .releases
            .iter()
            .filter(|release| {
                release.platform == platform && release.arch == arch && !release.yanked
            })
            .map(|release| {
                json!({
                    "version": release.upstream_version,
                    "channel": manifest.channel,
                    "license": release.license,
                })
            })
            .collect();
        let versions = crate::store::runtime::list_versions(&self.store.conn())
            .map_err(|e| svc_error(e.code(), e))?;
        let active = versions
            .iter()
            .find(|row| row.state == "active")
            .map(|row| row.version.clone());
        let installed: Vec<Value> = versions
            .into_iter()
            .map(|row| json!({ "version": row.version, "state": row.state }))
            .collect();
        Ok(json!({
            "active_version": active,
            "installed": installed,
            "available": available,
            "manifest_source": "bundled",
            "manifest_stale": false,
        }))
    }

    async fn core_info(&self) -> anyhow::Result<Value> {
        let bundled_version = self.installer.bundled_version().await;
        let active = self.installer.active().ok().flatten();
        let running = self.manager.status().await.upstream_version;
        let restart_required = match (&active, running) {
            (Some(active), Some(running)) => active.version != running,
            _ => false,
        };
        Ok(json!({
            "bundled_version": bundled_version,
            "active_version": active.as_ref().map(|runtime| runtime.version.clone()),
            "active_source": active.as_ref().map(|runtime| runtime.source.clone()),
            "restart_required": restart_required,
        }))
    }

    async fn core_check_updates(&self) -> anyhow::Result<Value> {
        let check = self.updates.check().await.map_err(update_error)?;
        serde_json::to_value(check).map_err(|error| svc_error("INTERNAL", error))
    }

    async fn core_upgrade(
        &self,
        version: &str,
        origin: &str,
        expected_sha256: Option<&str>,
    ) -> anyhow::Result<Value> {
        match self.updates.start(version, origin, expected_sha256).await {
            Ok(started) => Ok(json!({
                "job_id": started.job_id,
                "current_version": started.current_version,
                "target_version": started.target_version,
            })),
            Err(error) if error.code == "BUSY" => Err(svc_error_with_details(
                error.code,
                error.message,
                json!({ "job_id": self.updates.active_job_id() }),
            )),
            Err(error) => Err(update_error(error)),
        }
    }

    async fn core_cancel_upgrade(&self, job_id: &str) -> anyhow::Result<Value> {
        Ok(json!({ "cancelled": self.updates.cancel(job_id) }))
    }

    #[cfg(debug_assertions)]
    async fn tun_probe(&self) -> anyhow::Result<Value> {
        use std::time::Duration;

        let pid = match self.tun.status() {
            crate::tun::session::TunState::Running { pid } => pid,
            _ => {
                return Err(svc_error(
                    "PRECONDITION_FAILED",
                    "TUN 未连接，先连接后再执行诊断",
                ))
            }
        };
        let since = self.tun.connected_since().unwrap_or_default();

        // ---- 设备与路由 ----
        let addrs = tokio::task::spawn_blocking(crate::tun::collect)
            .await
            .unwrap_or_default();
        let netstat = crate::netcfg::run("/usr/sbin/netstat", &["-rn", "-f", "inet"])
            .unwrap_or_default();
        let mut utuns: Vec<String> = Vec::new();
        for addr in addrs.iter().filter(|addr| addr.name.starts_with("utun")) {
            let (routes, key) = tun_route_stats(&netstat, &addr.name);
            utuns.push(format!(
                "{} {}/{} 路由={routes} 关键段={key}",
                addr.name, addr.address, addr.prefix_len
            ));
        }

        // ---- 节点服务器直连 ----
        let mut node_line = "未找到当前节点".to_string();
        let node_reachable = if let Some(config_id) = self.active_config_id() {
            match self.require_config(&config_id) {
                Ok(config) => match self.active_node(&config) {
                    Ok((node, _password)) => {
                        let started = std::time::Instant::now();
                        match tokio::time::timeout(
                            Duration::from_secs(4),
                            tokio::net::TcpStream::connect((node.server.as_str(), node.port)),
                        )
                        .await
                        {
                            Ok(Ok(_)) => {
                                node_line = format!(
                                    "{}:{} 可直连（{}ms）",
                                    node.server,
                                    node.port,
                                    started.elapsed().as_millis()
                                );
                                true
                            }
                            Ok(Err(error)) => {
                                node_line = format!("{}:{} 直连失败：{error}", node.server, node.port);
                                false
                            }
                            Err(_) => {
                                node_line =
                                    format!("{}:{} 直连超时（4s）", node.server, node.port);
                                false
                            }
                        }
                    }
                    Err(error) => {
                        node_line = format!("读取当前节点失败：{error}");
                        false
                    }
                },
                Err(error) => {
                    node_line = format!("读取配置失败：{error}");
                    false
                }
            }
        } else {
            false
        };

        // ---- 系统 DNS ----
        let dns_started = std::time::Instant::now();
        let dns = match tokio::time::timeout(
            Duration::from_secs(4),
            tokio::net::lookup_host(("www.apple.com", 443)),
        )
        .await
        {
            Ok(Ok(mut addresses)) => {
                let first = addresses
                    .next()
                    .map(|addr| addr.ip().to_string())
                    .unwrap_or_else(|| "无结果".into());
                format!(
                    "www.apple.com → {first}（{}ms）",
                    dns_started.elapsed().as_millis()
                )
            }
            Ok(Err(error)) => format!("解析失败：{error}"),
            Err(_) => "解析超时（4s）".into(),
        };
        let dns_ok = dns.contains("→");

        // ---- 经隧道访问 HTTPS ----
        let http_started = std::time::Instant::now();
        let https = match reqwest::Client::builder()
            .no_proxy()
            .timeout(Duration::from_secs(8))
            .build()
        {
            Ok(client) => match client.get("https://www.apple.com/").send().await {
                Ok(response) => format!(
                    "HTTP {}（{}ms）",
                    response.status().as_u16(),
                    http_started.elapsed().as_millis()
                ),
                Err(error) => format!("失败：{error}"),
            },
            Err(error) => format!("客户端初始化失败：{error}"),
        };
        let https_ok = https.starts_with("HTTP 2") || https.starts_with("HTTP 3");

        // ---- 进程 ----
        let alive = unsafe { libc::kill(pid as libc::pid_t, 0) == 0 };
        let process = format!("pid={pid} 存活={alive} since={since}");

        let conclusion = if !node_reachable {
            "节点服务器不可达（直连失败，先查本地网络/节点地址）"
        } else if !dns_ok {
            "节点可达，但系统 DNS 解析失败"
        } else if !https_ok {
            "隧道已接管，但经隧道出站失败（看出站拨号日志）"
        } else {
            "隧道与出站均正常"
        };

        let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S");
        let report = format!(
            "结论：{conclusion}\n时间：{}\n\n[设备与路由]\n{}\n\n[节点直连]\n{node_line}\n\n[系统 DNS]\n{dns}\n\n[经隧道 HTTPS]\n{https}\n\n[sing-box 进程]\n{process}\n",
            chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
            if utuns.is_empty() {
                "未发现 utun 接口".to_string()
            } else {
                utuns.join("\n")
            }
        );
        let dir = self.data_dir.join("diagnostics");
        crate::runtime::fsutil::ensure_private_dir(&dir)
            .map_err(|error| svc_error("INTERNAL", error.to_string()))?;
        let path = dir.join(format!("tun-{stamp}.txt"));
        crate::runtime::fsutil::write_atomic_private(&path, report.as_bytes())
            .map_err(|error| svc_error("INTERNAL", error.to_string()))?;

        Ok(json!({
            "conclusion": conclusion,
            "report_path": path.to_string_lossy(),
            "utun": utuns,
            "node": node_line,
            "dns": dns,
            "https": https,
            "process": process,
        }))
    }

    async fn core_rollback(&self) -> anyhow::Result<Value> {
        if self.updates.busy() {
            return Err(svc_error_with_details(
                "BUSY",
                "运行库升级进行中，完成后再回滚",
                json!({ "job_id": self.updates.active_job_id() }),
            ));
        }
        let active = self
            .installer
            .active()
            .map_err(|error| svc_error(error.code(), error))?;
        match active {
            // 契约：没有已安装版本 → NOT_FOUND；已经是随包 → 幂等返回 ok。
            None => Err(svc_error("NOT_FOUND", "没有可回滚的运行库")),
            Some(runtime) if runtime.source == crate::runtime::SOURCE_BUNDLED => {
                Ok(json!({ "ok": true }))
            }
            Some(_) => {
                self.installer
                    .rollback_to_bundled()
                    .await
                    .map_err(|error| svc_error(error.code(), error))?;
                Ok(json!({ "ok": true }))
            }
        }
    }

    async fn tun_helper_info(&self) -> anyhow::Result<Value> {
        let helper = Arc::clone(&self.helper);
        let info = tokio::task::spawn_blocking(move || helper.info())
            .await
            .map_err(|error| svc_error("INTERNAL", format!("读取后台组件状态失败：{error}")))?;
        serde_json::to_value(info).map_err(|error| svc_error("INTERNAL", error))
    }

    async fn tun_helper_restart(&self) -> anyhow::Result<Value> {
        // 契约 §7.8.2：重启会中断当前 TUN，调用方必须先断开。
        if matches!(
            self.tun.status(),
            crate::tun::session::TunState::Running { .. }
        ) {
            return Err(svc_error_with_details(
                "PRECONDITION_FAILED",
                "TUN 正在连接，先断开再重启后台组件",
                json!({ "reason": "tun_running" }),
            ));
        }
        let helper = Arc::clone(&self.helper);
        let report = tokio::task::spawn_blocking(move || helper.restart_from_user())
            .await
            .map_err(|error| svc_error("INTERNAL", format!("重启后台组件失败：{error}")))?;
        if report.busy {
            // 正在执行 start：可重试，不是故障，也不能说成「需要管理员授权」。
            return Err(anyhow::Error::new(ServiceError {
                code: "PRECONDITION_FAILED".into(),
                message: "后台组件正在准备，请稍后再试".into(),
                retryable: true,
                details: Some(json!({ "reason": "helper_busy" })),
            }));
        }
        Ok(json!({
            "ok": report.ok,
            "restarted": report.restarted,
            "needs_admin_restart": report.needs_admin_restart,
        }))
    }

    async fn catalog_search(&self, query: CatalogQuery) -> anyhow::Result<Value> {
        let protocol = match query.protocol.as_deref() {
            None => None,
            Some("vless_reality") => Some(crate::catalog::NodeProtocol::VlessReality),
            Some("hysteria2") => Some(crate::catalog::NodeProtocol::Hysteria2),
            Some("shadowsocks") => Some(crate::catalog::NodeProtocol::Shadowsocks),
            Some(other) => {
                return Err(svc_error(
                    "INVALID_ARGUMENT",
                    format!("不支持的协议 {other}，可选值：vless_reality、hysteria2、shadowsocks"),
                ))
            }
        };
        let query = crate::catalog::NodeQuery {
            region: query.region,
            protocol,
            limit: query.limit.map(|limit| limit.min(50) as u8),
            cursor: query.cursor,
        };
        let response = self.catalog_list(&query).await?;
        Ok(json!({
            "nodes": response.nodes,
            "next_cursor": response.next_cursor,
            "fetched_at": response.fetched_at,
            "stale": false,
        }))
    }

    async fn config_list(&self) -> anyhow::Result<Value> {
        let rows = {
            let conn = self.store.conn();
            configs::list(&conn).map_err(|error| svc_error(error.code(), error))?
        };
        let active = rows
            .iter()
            .find(|config| config.is_active)
            .map(|config| config.id.clone());
        let items = rows
            .iter()
            .map(|config| self.config_summary_json(config))
            .collect::<anyhow::Result<Vec<_>>>()?;
        Ok(json!({ "configs": items, "active_config_id": active }))
    }

    async fn config_detail(&self, config_id: &str) -> anyhow::Result<Value> {
        let config = self.require_config(config_id)?;
        self.config_detail_json(&config)
    }

    async fn config_create(&self, input: ConfigCreateInput) -> anyhow::Result<Value> {
        let connect_mode = input.connect_mode.trim();
        validate_connect_mode(connect_mode)?;
        let routing_mode = input.routing_mode.trim();
        validate_routing_mode(routing_mode)?;
        let targets = input.targets.clone().unwrap_or_default();
        if !targets.is_empty() || routing_mode == configs::ROUTING_PROXY_SELECTED {
            self.validate_targets(&targets)?;
        }

        if connect_mode == configs::CONNECTION_TUN && input.listen_port.is_some() {
            return Err(svc_error_with_details(
                "INVALID_ARGUMENT",
                "接管全部流量不需要代理端口",
                json!({ "reason": "listen_port_not_allowed" }),
            ));
        }
        if let Some(port) = input.listen_port {
            if !(1000..=65535).contains(&port) {
                return Err(svc_error_with_details(
                    "INVALID_ARGUMENT",
                    "代理端口必须在 1000-65535 之间",
                    json!({ "reason": "invalid_listen_port" }),
                ));
            }
        }
        if input.source.is_some() && input.node_ids.is_some() {
            return Err(svc_error_with_details(
                "INVALID_ARGUMENT",
                "source 与 nodeIds 不能同时使用",
                json!({ "reason": "source_and_node_ids_conflict" }),
            ));
        }

        let dns = validate_dns(input.dns.as_ref())?;
        let tun_excludes = validate_tun_excludes(connect_mode, input.tun_excludes.as_deref())?;

        let source = input
            .source
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_ascii_lowercase);
        if let Some(source) = &source {
            if source != "seed" && source != "empty" {
                return Err(svc_error_with_details(
                    "INVALID_ARGUMENT",
                    "source 只支持 seed 或 empty",
                    json!({ "reason": "invalid_source" }),
                ));
            }
        }

        if let Some(node_ids) = input.node_ids.as_ref() {
            let missing = {
                let conn = self.store.conn();
                configs::missing_nodes(&conn, node_ids)
                    .map_err(|error| svc_error(error.code(), error))?
            };
            if !missing.is_empty() {
                return Err(svc_error_with_details(
                    "NOT_FOUND",
                    "有节点不存在",
                    json!({ "reason": "node_not_found", "node_ids": missing }),
                ));
            }
        }

        let running = self.is_connected(&self.manager.status().await);
        if source.as_deref() == Some("seed") && crate::seed::load_nodes(&self.store).is_none() {
            crate::seed::refresh(&self.store, running, true).await;
            if crate::seed::load_nodes(&self.store).is_none() {
                return Err(svc_error_with_details(
                    "PRECONDITION_FAILED",
                    "现在拿不到测试节点",
                    json!({
                        "reason": "seed_unavailable",
                        "hint": "先刷新测试节点或手动添加节点"
                    }),
                ));
            }
        }

        let id = format!("cfg_{:016x}", rand::random::<u64>());
        let created = {
            let conn = self.store.conn();
            configs::create(
                &conn,
                &configs::NewConfig {
                    id: &id,
                    name: &input.name,
                    connection_mode: connect_mode,
                    routing_mode,
                    listen_port: input.listen_port,
                    dns: &dns,
                    tun_excludes: &tun_excludes,
                },
            )
            .map_err(|error| config_store_error(error))?
        };

        if source.as_deref() == Some("seed") {
            if let Err(error) = self.materialize_seed_nodes(&created.id) {
                let conn = self.store.conn();
                let _ = configs::delete(&conn, &created.id);
                return Err(error);
            }
        } else if let Some(node_ids) = input.node_ids.as_ref() {
            let conn = self.store.conn();
            configs::replace_nodes(&conn, &created.id, node_ids)
                .map_err(|error| config_store_error(error))?;
        }
        if !targets.is_empty() {
            let conn = self.store.conn();
            configs::set_route_targets(&conn, &created.id, &json!(targets))
                .map_err(|error| config_store_error(error))?;
        }

        let config = self.require_config(&created.id)?;
        let active_before = self.active_config_id();
        let auto_activate = active_before.is_none() || !running;
        if auto_activate {
            {
                let conn = self.store.conn();
                configs::activate(&conn, &created.id)
                    .map_err(|error| svc_error(error.code(), error))?;
            }
        }

        self.emit_config_changed("created", Some(&config));
        if auto_activate {
            let config = self.require_config(&created.id)?;
            self.emit_config_changed("activated", Some(&config));
        }
        let config = self.require_config(&created.id)?;
        self.config_detail_json(&config)
    }

    async fn config_update(
        &self,
        config_id: &str,
        input: ConfigUpdateInput,
    ) -> anyhow::Result<Value> {
        if input.connect_mode.is_some() {
            return Err(svc_error_with_details(
                "INVALID_ARGUMENT",
                "改连接方式必须新建一套配置",
                json!({ "reason": "connect_mode_immutable" }),
            ));
        }
        let current = self.require_config(config_id)?;
        if let Some(routing_mode) = input.routing_mode.as_deref() {
            validate_routing_mode(routing_mode)?;
        }
        if let Some(Some(port)) = input.listen_port {
            if current.connection_mode == configs::CONNECTION_TUN {
                return Err(svc_error_with_details(
                    "INVALID_ARGUMENT",
                    "接管全部流量不需要代理端口",
                    json!({ "reason": "listen_port_not_allowed" }),
                ));
            }
            if !(1000..=65535).contains(&port) {
                return Err(svc_error_with_details(
                    "INVALID_ARGUMENT",
                    "代理端口必须在 1000-65535 之间",
                    json!({ "reason": "invalid_listen_port" }),
                ));
            }
        }
        let dns = match input.dns.as_ref() {
            Some(value) => Some(validate_dns(Some(value))?),
            None => None,
        };
        let tun_excludes = match input.tun_excludes.as_deref() {
            Some(value) => Some(validate_tun_excludes(
                &current.connection_mode,
                Some(value),
            )?),
            None => None,
        };

        if let Some(node_ids) = input.node_ids.as_ref() {
            let missing = {
                let conn = self.store.conn();
                configs::missing_nodes(&conn, node_ids)
                    .map_err(|error| svc_error(error.code(), error))?
            };
            if !missing.is_empty() {
                return Err(svc_error_with_details(
                    "NOT_FOUND",
                    "有节点不存在",
                    json!({ "reason": "node_not_found", "node_ids": missing }),
                ));
            }
        }

        let current_nodes = {
            let conn = self.store.conn();
            configs::list_nodes(&conn, config_id).map_err(|error| svc_error(error.code(), error))?
        };
        let current_node_ids = current_nodes
            .iter()
            .map(|node| node.id.clone())
            .collect::<Vec<_>>();

        let final_mode = input
            .routing_mode
            .as_deref()
            .unwrap_or(&current.routing_mode);
        if let Some(targets) = input.targets.as_ref() {
            self.validate_targets(targets)?;
        } else if final_mode == configs::ROUTING_PROXY_SELECTED {
            let empty = current
                .route_targets
                .as_array()
                .map(|items| items.is_empty())
                .unwrap_or(true);
            if empty {
                return Err(svc_error_with_details(
                    "PRECONDITION_FAILED",
                    "指定服务走 VPN 时至少要选一个分类",
                    json!({ "reason": "route_targets_empty" }),
                ));
            }
        }

        let unchanged = input
            .name
            .as_ref()
            .map(|name| name.trim() == current.name)
            .unwrap_or(true)
            && input
                .routing_mode
                .as_ref()
                .map(|mode| mode == &current.routing_mode)
                .unwrap_or(true)
            && match input.listen_port {
                None => true,
                Some(None) => current.listen_port.is_none(),
                Some(Some(port)) => current.listen_port == Some(port),
            }
            && dns
                .as_ref()
                .map(|value| value == &current.dns)
                .unwrap_or(true)
            && tun_excludes
                .as_ref()
                .map(|value| value == &current.tun_excludes)
                .unwrap_or(true)
            && input
                .node_ids
                .as_ref()
                .map(|ids| ids == &current_node_ids)
                .unwrap_or(true)
            && input
                .targets
                .as_ref()
                .map(|targets| json!(targets) == current.route_targets)
                .unwrap_or(true);
        if unchanged {
            // 契约：参数与现状完全一致时返回同一份详情，不发事件。
            return self.config_detail_json(&current);
        }

        let previous_seed_nodes = if input.node_ids.is_some() {
            current_nodes
                .into_iter()
                .filter(|node| node.source == configs::SOURCE_SEED)
                .collect::<Vec<_>>()
        } else {
            Vec::new()
        };

        let patch = configs::ConfigPatch {
            name: input.name,
            routing_mode: input.routing_mode,
            listen_port: input.listen_port,
            dns,
            tun_excludes,
            current_node_id: None,
        };
        {
            let conn = self.store.conn();
            configs::update(&conn, config_id, &patch).map_err(|error| config_store_error(error))?;
            if let Some(node_ids) = input.node_ids.as_ref() {
                configs::replace_nodes(&conn, config_id, node_ids)
                    .map_err(|error| config_store_error(error))?;

                // 用户移除过的种子节点记一笔，刷新时不再自动加回来。
                for node in &previous_seed_nodes {
                    if !node_ids.iter().any(|id| id == &node.id) {
                        let _ = configs::record_seed_exclusion(&conn, &node.source_key);
                    }
                }
                // 明确加回来的种子节点：撤销排除。
                for node_id in node_ids {
                    if let Ok(Some(node)) = configs::get_node(&conn, node_id) {
                        if node.source == configs::SOURCE_SEED {
                            let _ = configs::remove_seed_exclusion(&conn, &node.source_key);
                        }
                    }
                }
            }
            if let Some(targets) = input.targets.as_ref() {
                configs::set_route_targets(&conn, config_id, &json!(targets))
                    .map_err(|error| config_store_error(error))?;
            }
        }

        let updated = self.require_config(config_id)?;
        self.emit_config_changed("updated", Some(&updated));
        if input.node_ids.is_some() {
            crate::seed::emit_node_list_changed(
                &self.store,
                "bindings_changed",
                Some(config_id),
                &[],
            );
        }
        self.config_detail_json(&updated)
    }

    async fn config_delete(&self, config_id: &str) -> anyhow::Result<Value> {
        if config_id.trim().is_empty() {
            return Err(svc_error_with_details(
                "INVALID_ARGUMENT",
                "config_id 不能为空",
                json!({ "reason": "invalid_config_id" }),
            ));
        }
        if self.connected_config_id().await.as_deref() == Some(config_id) {
            return Err(svc_error_with_details(
                "PRECONDITION_FAILED",
                "这套配置正在连接中，先断开再删除",
                json!({ "reason": "connected" }),
            ));
        }
        // App 重启后接手的 TUN 连接没有配置 id：不知道在跑的这套是不是要删的那套，
        // 一律拒绝——放过去就是「数据库删了、sing-box 还在接管、界面停不掉」。
        if matches!(
            self.tun.status(),
            crate::tun::session::TunState::Running { .. }
        ) && self.tun.connected_config_id().is_none()
        {
            return Err(svc_error_with_details(
                "PRECONDITION_FAILED",
                "有一个接管连接在运行，但读不到它用的是哪套配置，先断开再删除",
                json!({ "reason": "connected" }),
            ));
        }

        let deleted = {
            let conn = self.store.conn();
            configs::delete(&conn, config_id).map_err(|error| svc_error(error.code(), error))?
        };
        vpn_config::remove_profile_config(&self.config_dir(), config_id);
        self.emit_config_changed("deleted", None);

        Ok(json!({
            "config_id": config_id,
            "deleted": deleted,
            "already_absent": !deleted,
            "active_config_id": self.active_config_id(),
        }))
    }

    async fn config_activate(
        &self,
        config_id: &str,
        confirm_disconnect: bool,
    ) -> anyhow::Result<Value> {
        if crate::lifecycle::is_quitting() {
            return Err(svc_error_with_details(
                "PRECONDITION_FAILED",
                "应用正在退出，不能再切换配置",
                json!({ "reason": "quitting" }),
            ));
        }
        let target = self.require_config(config_id)?;
        let status = self.manager.status().await;
        let connected = self.is_connected(&status);
        let connected_config = self.connected_config_id().await;

        if !connected {
            {
                let conn = self.store.conn();
                configs::activate(&conn, config_id)
                    .map_err(|error| svc_error(error.code(), error))?;
            }
            self.emit_config_changed("activated", Some(&target));
            return Ok(json!({
                "active_config_id": config_id,
                "reconnect": "not_running",
                "runtime": Value::Null,
            }));
        }

        if connected_config.as_deref() == Some(config_id) {
            {
                let conn = self.store.conn();
                configs::activate(&conn, config_id)
                    .map_err(|error| svc_error(error.code(), error))?;
            }
            return Ok(json!({
                "active_config_id": config_id,
                "reconnect": "reconnected",
                "runtime": serde_json::to_value(status).map_err(|e| svc_error("INTERNAL", e))?,
            }));
        }

        if !confirm_disconnect {
            return Err(svc_error_with_details(
                "PRECONDITION_FAILED",
                "切换配置会断开当前连接",
                json!({
                    "reason": "will_disconnect",
                    "connected_config_id": connected_config,
                }),
            ));
        }

        self.runtime_stop(false).await?;
        {
            let conn = self.store.conn();
            configs::activate(&conn, config_id).map_err(|error| svc_error(error.code(), error))?;
        }
        self.emit_config_changed("activated", Some(&target));

        let node_count = {
            let conn = self.store.conn();
            configs::node_count(&conn, config_id).map_err(|error| svc_error(error.code(), error))?
        };
        if node_count == 0 {
            return Ok(json!({
                "active_config_id": config_id,
                "reconnect": "skipped_no_nodes",
                "runtime": Value::Null,
            }));
        }

        match self.runtime_start(Some(config_id.to_string())).await {
            Ok(runtime) => Ok(json!({
                "active_config_id": config_id,
                "reconnect": "reconnected",
                "runtime": runtime,
            })),
            Err(error) => {
                log::warn!("切换配置后自动重连失败：{error}");
                let status = self.manager.status().await;
                Ok(json!({
                    "active_config_id": config_id,
                    "reconnect": "reconnect_failed",
                    "runtime": serde_json::to_value(status)
                        .map_err(|e| svc_error("INTERNAL", e))?,
                }))
            }
        }
    }

    async fn node_import_url(&self, config_id: Option<String>, url: &str) -> anyhow::Result<Value> {
        if let Some(config_id) = &config_id {
            self.require_config(config_id)?;
        }
        let parsed_url = reqwest::Url::parse(url).map_err(|_| {
            svc_error_with_details(
                "INVALID_ARGUMENT",
                "订阅地址无效",
                json!({ "reason": "invalid_url" }),
            )
        })?;
        if parsed_url.scheme() != "https" {
            return Err(svc_error_with_details(
                "INVALID_ARGUMENT",
                "订阅地址必须是 HTTPS",
                json!({ "reason": "insecure_url" }),
            ));
        }

        let subscription = crate::nodes::fetch_subscription(url)
            .await
            .map_err(|error| {
                let message = error.to_string();
                svc_error_with_details(error.code(), message, json!({ "reason": error.reason() }))
            })?;
        let (added, duplicates) = self.add_parsed_nodes(
            config_id.as_deref(),
            &subscription.nodes,
            configs::SOURCE_URL,
            true,
        )?;

        let mut skipped = subscription
            .skipped
            .iter()
            .map(|skip| {
                json!({
                    "name": skip.name,
                    "reason": skip.reason.as_str(),
                })
            })
            .collect::<Vec<_>>();
        skipped.extend(duplicates.iter().map(|skip| {
            json!({
                "name": skip.name,
                "reason": skip.reason.as_str(),
            })
        }));

        let added_ids = added.iter().map(|node| node.id.clone()).collect::<Vec<_>>();
        if !added_ids.is_empty() {
            crate::seed::emit_node_list_changed(
                &self.store,
                "url_import",
                config_id.as_deref(),
                &added_ids,
            );
        }
        if let Some(config_id) = &config_id {
            if !added.is_empty() {
                if let Ok(config) = self.require_config(config_id) {
                    self.emit_config_changed("updated", Some(&config));
                }
            }
        }

        Ok(json!({
            "imported": added.len(),
            "skipped": skipped,
            "nodes": added.iter().map(node_json).collect::<Vec<_>>(),
        }))
    }

    async fn node_create(&self, input: NodeCreateInput) -> anyhow::Result<Value> {
        if let Some(config_id) = &input.config_id {
            self.require_config(config_id)?;
        }
        let parsed = crate::nodes::validate_manual(
            &input.name,
            &input.server,
            input.port,
            &input.password,
            &input.method,
        )
        .map_err(|error| {
            let message = error.to_string();
            let reason = match error {
                crate::nodes::ImportError::Unsupported(_) => "unsupported_method",
                _ => "invalid_argument",
            };
            svc_error_with_details("INVALID_ARGUMENT", message, json!({ "reason": reason }))
        })?;
        let (added, _) = self.add_parsed_nodes(
            input.config_id.as_deref(),
            &[parsed],
            configs::SOURCE_MANUAL,
            false,
        )?;
        let node = added
            .first()
            .ok_or_else(|| svc_error("INTERNAL", "节点写入失败"))?;
        let added_ids = vec![node.id.clone()];
        crate::seed::emit_node_list_changed(
            &self.store,
            "manual_create",
            input.config_id.as_deref(),
            &added_ids,
        );
        if let Some(config_id) = &input.config_id {
            if let Ok(config) = self.require_config(config_id) {
                self.emit_config_changed("updated", Some(&config));
            }
        }
        Ok(node_json(node))
    }

    async fn node_switch(&self, config_id: &str, node_id: &str) -> anyhow::Result<Value> {
        let config = self.require_config(config_id)?;
        let members = {
            let conn = self.store.conn();
            configs::list_nodes(&conn, config_id).map_err(|error| svc_error(error.code(), error))?
        };
        if !members.iter().any(|node| node.id == node_id) {
            return Err(svc_error_with_details(
                "NOT_FOUND",
                "节点不属于这套配置",
                json!({ "reason": "node_not_in_config" }),
            ));
        }

        let previous = config.current_node_id.clone();
        let status = self.manager.status().await;
        let connected = self.is_connected(&status);
        let connected_config = self.connected_config_id().await;

        if previous.as_deref() == Some(node_id) {
            return Ok(json!({
                "config_id": config_id,
                "node_id": node_id,
                "previous_node_id": previous,
                "connected": connected,
                "runtime": if connected {
                    serde_json::to_value(status).map_err(|e| svc_error("INTERNAL", e))?
                } else {
                    Value::Null
                },
            }));
        }

        if !connected {
            {
                let conn = self.store.conn();
                configs::update(
                    &conn,
                    config_id,
                    &configs::ConfigPatch {
                        current_node_id: Some(Some(node_id.to_string())),
                        ..Default::default()
                    },
                )
                .map_err(|error| svc_error(error.code(), error))?;
            }
            crate::agent::app_handle::emit(
                "node-switched",
                json!({
                    "contract_version": crate::runtime::EVENT_CONTRACT_VERSION,
                    "config_id": config_id,
                    "from_node_id": previous,
                    "to_node_id": node_id,
                    "connected": false,
                    "runtime": Value::Null,
                    "emitted_at": chrono::Utc::now()
                        .to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
                }),
            );
            return Ok(json!({
                "config_id": config_id,
                "node_id": node_id,
                "previous_node_id": previous,
                "connected": false,
                "runtime": Value::Null,
            }));
        }

        if connected_config.as_deref() != Some(config_id) {
            return Err(svc_error_with_details(
                "PRECONDITION_FAILED",
                "这套配置不是当前连接的配置",
                json!({ "reason": "config_not_running" }),
            ));
        }

        let plan = self.manager.current_plan().await.ok_or_else(|| {
            svc_error_with_details(
                "PRECONDITION_FAILED",
                "当前没有运行中的配置",
                json!({ "reason": "config_not_running" }),
            )
        })?;
        let to_tag = format!("node-{node_id}");
        // 本次连接的 selector 里可能没有它（TUN 会剔除解析失败的节点）。
        // 先查成员表，给一个用户能懂的理由，而不是一句 HTTP 400。
        match clash_selector_members(&plan.clash_addr, &plan.clash_secret, "proxy").await {
            Ok(members) if !members.is_empty() && !members.iter().any(|tag| tag == &to_tag) => {
                return Err(svc_error_with_details(
                    "PRECONDITION_FAILED",
                    "这个节点在本次连接中不可用（服务器域名解析失败），请重新连接或换一个节点",
                    json!({
                        "reason": "runtime_switch_failed",
                        "detail": { "reason": "node_server_unresolved" },
                        "node_id": node_id,
                    }),
                ));
            }
            Ok(_) => {}
            // 读不到成员表不据此拒绝，继续走原来的 PUT 路径。
            Err(error) => log::warn!("读取 selector 成员失败，跳过预检：{error}"),
        }
        if let Err(error) =
            clash_put_selector(&plan.clash_addr, &plan.clash_secret, "proxy", &to_tag).await
        {
            return Err(svc_error_with_details(
                "PRECONDITION_FAILED",
                format!("切换节点失败：{error}"),
                json!({ "reason": "runtime_switch_failed" }),
            ));
        }
        let read_back = clash_get_selector(&plan.clash_addr, &plan.clash_secret, "proxy").await;
        if !matches!(read_back, Ok(Some(ref now)) if now == &to_tag) {
            if let Some(previous) = &previous {
                let _ = clash_put_selector(
                    &plan.clash_addr,
                    &plan.clash_secret,
                    "proxy",
                    &format!("node-{previous}"),
                )
                .await;
            }
            return Err(svc_error_with_details(
                "PRECONDITION_FAILED",
                "切换节点后读回不一致",
                json!({ "reason": "runtime_switch_failed" }),
            ));
        }

        let node_name = members
            .iter()
            .find(|node| node.id == node_id)
            .map(|node| node.name.clone())
            .unwrap_or_default();
        self.manager
            .set_plan_node(node_id.to_string(), node_name)
            .await;
        {
            let conn = self.store.conn();
            configs::update(
                &conn,
                config_id,
                &configs::ConfigPatch {
                    current_node_id: Some(Some(node_id.to_string())),
                    ..Default::default()
                },
            )
            .map_err(|error| svc_error(error.code(), error))?;
        }

        let status = self.manager.status().await;
        let runtime = serde_json::to_value(&status).map_err(|e| svc_error("INTERNAL", e))?;
        crate::agent::app_handle::emit(
            "node-switched",
            json!({
                "contract_version": crate::runtime::EVENT_CONTRACT_VERSION,
                "config_id": config_id,
                "from_node_id": previous,
                "to_node_id": node_id,
                "connected": true,
                "runtime": runtime,
                "emitted_at": chrono::Utc::now()
                    .to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
            }),
        );
        Ok(json!({
            "config_id": config_id,
            "node_id": node_id,
            "previous_node_id": previous,
            "connected": true,
            "runtime": runtime,
        }))
    }

    async fn node_probe(&self, node_id: &str) -> anyhow::Result<Value> {
        let node = {
            let conn = self.store.conn();
            configs::get_node(&conn, node_id)
                .map_err(|error| svc_error(error.code(), error))?
                .ok_or_else(|| {
                    svc_error_with_details(
                        "NOT_FOUND",
                        "节点不存在",
                        json!({ "reason": "node_not_found" }),
                    )
                })?
        };

        let candidates = {
            let conn = self.store.conn();
            configs::config_ids_for_node(&conn, node_id)
                .map_err(|error| svc_error(error.code(), error))?
        };
        let status = self.manager.status().await;
        let connected = self.is_connected(&status);
        let connected_config = self.connected_config_id().await;

        // 运行时在跑，且节点属于当前连接的配置 → Clash 延迟。
        // 不要求它是当前选中的节点：用户最需要「先测一下另一个节点」。
        let can_clash = connected
            && connected_config
                .as_ref()
                .map(|id| candidates.iter().any(|candidate| candidate == id))
                .unwrap_or(false);
        if can_clash {
            if let Some(plan) = self.manager.current_plan().await {
                let tag = format!("node-{node_id}");
                if let Ok(delay) = clash_delay(&plan.clash_addr, &plan.clash_secret, &tag).await {
                    return Ok(probe_result(
                        node_id,
                        true,
                        Some(delay),
                        "clash_delay",
                        None,
                    ));
                }
            }
        }

        // 其余情况：不起运行时，直接对 server:port 做 TCP 握手。
        match tcp_probe(&node.server, node.port).await {
            Ok(delay) => Ok(probe_result(node_id, true, Some(delay), "tcp", None)),
            Err(message) => Ok(probe_result(
                node_id,
                false,
                None,
                "tcp",
                Some(("TCP_CONNECT_FAILED", message.as_str())),
            )),
        }
    }

    async fn default_profile_status(&self) -> anyhow::Result<Value> {
        Ok(self.seed_status_json("cache", false))
    }

    async fn default_profile_refresh(&self, force: bool) -> anyhow::Result<Value> {
        let running = self.is_connected(&self.manager.status().await);
        match crate::seed::refresh(&self.store, running, force).await {
            crate::seed::RefreshOutcome::Updated { .. } => {
                Ok(self.seed_status_json("network", true))
            }
            crate::seed::RefreshOutcome::Unchanged { .. } => {
                Ok(self.seed_status_json("network", false))
            }
            crate::seed::RefreshOutcome::Offline { cached: true, .. } => {
                // 有缓存时离线是正常场景：明确告诉调用方「这次用的是缓存」，
                // 不把刷新失败变成用户可见的错误。
                Ok(self.seed_status_json("cache", false))
            }
            crate::seed::RefreshOutcome::Offline { error, .. } => Err(svc_error_with_details(
                "UPSTREAM_ERROR",
                format!("现在拿不到测试节点：{error}"),
                json!({ "reason": "fetch_failed" }),
            )),
        }
    }

    async fn import_seed_file(&self, path: &str) -> anyhow::Result<Value> {
        const MAX_BYTES: u64 = 1024 * 1024;

        let file_path = std::path::Path::new(path);
        let is_json = file_path
            .extension()
            .and_then(|ext| ext.to_str())
            .map(|ext| ext.eq_ignore_ascii_case("json"))
            .unwrap_or(false);
        if !is_json {
            return Err(svc_error_with_details(
                "INVALID_ARGUMENT",
                "只支持 .json 文件",
                json!({ "reason": "not_json_file" }),
            ));
        }
        let metadata = match std::fs::metadata(file_path) {
            Ok(metadata) if metadata.is_file() => metadata,
            _ => {
                return Err(svc_error_with_details(
                    "INVALID_ARGUMENT",
                    "文件不存在或无法读取",
                    json!({ "reason": "file_unreadable" }),
                ))
            }
        };
        if metadata.len() > MAX_BYTES {
            return Err(svc_error_with_details(
                "INVALID_ARGUMENT",
                "文件超过 1 MB",
                json!({ "reason": "file_too_large", "max_bytes": MAX_BYTES }),
            ));
        }
        let bytes = std::fs::read(file_path).map_err(|_| {
            svc_error_with_details(
                "INVALID_ARGUMENT",
                "文件不存在或无法读取",
                json!({ "reason": "file_unreadable" }),
            )
        })?;

        let (imported, added_ids) =
            crate::seed::merge_file_nodes(&self.store, &bytes).map_err(|error| {
                svc_error_with_details(
                    "INVALID_ARGUMENT",
                    "文件不是合法的种子 JSON",
                    json!({ "reason": "invalid_json", "detail": error }),
                )
            })?;

        let nodes = {
            let conn = self.store.conn();
            added_ids
                .iter()
                .filter_map(|id| configs::get_node(&conn, id).ok().flatten())
                .collect::<Vec<_>>()
        };

        Ok(json!({
            "imported": imported,
            "skipped": [],
            "nodes": nodes.iter().map(node_json).collect::<Vec<_>>(),
        }))
    }

    async fn rules_status(&self) -> anyhow::Result<Value> {
        Ok(crate::rules::status(&self.store, &self.data_dir))
    }

    async fn category_list(
        &self,
        query: Option<String>,
        limit: Option<u32>,
    ) -> anyhow::Result<Value> {
        let needle = query.unwrap_or_default().trim().to_ascii_lowercase();
        let limit = limit.unwrap_or(50).clamp(1, 200) as usize;
        let all = crate::rules::categories(&self.store, &self.data_dir);
        let matched = all
            .into_iter()
            .filter(|category| {
                needle.is_empty()
                    || category.id.to_ascii_lowercase().contains(&needle)
                    || category.name_zh.to_ascii_lowercase().contains(&needle)
                    || category.name_en.to_ascii_lowercase().contains(&needle)
            })
            .collect::<Vec<_>>();
        let total = matched.len();
        let categories = matched.into_iter().take(limit).collect::<Vec<_>>();
        Ok(json!({ "categories": categories, "total": total }))
    }

    async fn route_get(&self, config_id: Option<String>) -> anyhow::Result<Value> {
        let config = self.resolve_config(config_id)?;
        let status = self.manager.status().await;
        let connected = self.is_connected(&status);
        let connected_config = self.connected_config_id().await;
        let running = connected && connected_config.as_deref() == Some(config.id.as_str());
        let applied_mode = running.then(|| config.routing_mode.clone());
        let applied_revision = running.then_some(status.applied_route_revision).flatten();
        Ok(self.route_state_json(&config, applied_mode.as_deref(), applied_revision))
    }

    async fn route_set_mode(
        &self,
        config_id: Option<String>,
        mode: &str,
        confirm_reconnect: bool,
    ) -> anyhow::Result<Value> {
        validate_routing_mode(mode)?;
        let config = self.resolve_config(config_id)?;
        let targets = config
            .route_targets
            .as_array()
            .map(|items| {
                items
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_string)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        if mode == configs::ROUTING_PROXY_SELECTED && targets.is_empty() {
            return Err(svc_error_with_details(
                "PRECONDITION_FAILED",
                "指定服务走 VPN 时至少要选一个分类",
                json!({ "reason": "route_targets_empty" }),
            ));
        }

        let status = self.manager.status().await;
        let connected = self.is_connected(&status);
        let connected_config = self.connected_config_id().await;
        let running = connected && connected_config.as_deref() == Some(config.id.as_str());
        let applied_mode = running.then(|| config.routing_mode.clone());
        let applied_revision = running.then_some(status.applied_route_revision).flatten();

        if config.routing_mode == mode {
            let mut data =
                self.route_state_json(&config, applied_mode.as_deref(), applied_revision);
            data["hot_switched"] = json!(false);
            data["reconnect"] = Value::Null;
            return Ok(data);
        }

        let same_family = matches!(
            config.routing_mode.as_str(),
            configs::ROUTING_DIRECT | configs::ROUTING_PROXY_ALL
        ) && matches!(mode, configs::ROUTING_DIRECT | configs::ROUTING_PROXY_ALL);

        if running && same_family {
            let plan = self.manager.current_plan().await.ok_or_else(|| {
                svc_error_with_details(
                    "PRECONDITION_FAILED",
                    "当前没有运行中的配置",
                    json!({ "reason": "config_not_running" }),
                )
            })?;
            let from_selector = if config.routing_mode == configs::ROUTING_DIRECT {
                "direct"
            } else {
                "proxy"
            };
            let to_selector = if mode == configs::ROUTING_DIRECT {
                "direct"
            } else {
                "proxy"
            };
            if let Err(error) = clash_put_selector(
                &plan.clash_addr,
                &plan.clash_secret,
                "route-local",
                to_selector,
            )
            .await
            {
                return Err(svc_error_with_details(
                    "PRECONDITION_FAILED",
                    format!("切换分流模式失败：{error}"),
                    json!({ "reason": "route_switch_failed" }),
                ));
            }
            let read_back =
                clash_get_selector(&plan.clash_addr, &plan.clash_secret, "route-local").await;
            let applied = matches!(read_back, Ok(Some(ref now)) if now == to_selector);
            if !applied {
                let _ = clash_put_selector(
                    &plan.clash_addr,
                    &plan.clash_secret,
                    "route-local",
                    from_selector,
                )
                .await;
                return Err(svc_error_with_details(
                    "PRECONDITION_FAILED",
                    "切换分流模式后读回不一致",
                    json!({ "reason": "route_switch_failed" }),
                ));
            }

            let updated = self.update_routing_mode(&config.id, mode)?;
            self.emit_routing_changed(&updated, "mode", Some(mode), applied_revision, true);
            let mut data = self.route_state_json(&updated, Some(mode), applied_revision);
            data["hot_switched"] = json!(true);
            data["reconnect"] = Value::Null;
            return Ok(data);
        }

        if running && !confirm_reconnect {
            return Err(svc_error_with_details(
                "PRECONDITION_FAILED",
                "切换分流模式会断开当前连接，并且域名解析方式也会改变",
                json!({
                    "reason": "will_disconnect",
                    "applied_mode": config.routing_mode,
                    "target_mode": mode,
                }),
            ));
        }

        if running {
            self.runtime_stop(false).await?;
        }
        let updated = self.update_routing_mode(&config.id, mode)?;

        if !running {
            self.emit_routing_changed(&updated, "mode", None, None, false);
            let mut data = self.route_state_json(&updated, None, None);
            data["hot_switched"] = json!(false);
            data["reconnect"] = json!("not_running");
            return Ok(data);
        }

        match self.runtime_start(Some(updated.id.clone())).await {
            Ok(started) => {
                // TUN 的 Ok 只说明 helper 接受了启动请求，不代表接管成功。
                // 三态：确认起来 / 确认没起来 / 当前平台未采集。
                let takeover = tun_takeover(&started);
                if takeover == TunTakeover::Unconfirmed {
                    log::warn!("分流切换后 TUN 已启动，但没确认接管");
                    self.emit_routing_changed(&updated, "mode", None, None, false);
                    let mut data = self.route_state_json(&updated, None, None);
                    data["hot_switched"] = json!(false);
                    data["reconnect"] = json!("reconnect_failed");
                    data["runtime_state"] = json!("tun_unconfirmed");
                    return Ok(data);
                }
                let status = self.manager.status().await;
                self.emit_routing_changed(
                    &updated,
                    "mode",
                    Some(mode),
                    status.applied_route_revision,
                    false,
                );
                let mut data =
                    self.route_state_json(&updated, Some(mode), status.applied_route_revision);
                data["reconnect"] = json!("reconnected");
                if takeover == TunTakeover::Unknown {
                    // 未采集不是失败：切换本身成功，只是无法确认接管。
                    // `hot_switched` 在这里仍是 true，与「发生过重启」的语义不符；
                    // 当前唯一消费方（`routing.rs`）先匹配 `runtime_state`，
                    // 所以这个字段实际不可见。改语义前先确认消费方。
                    log::warn!("分流切换后 TUN 已启动，但当前平台未采集设备状态，无法确认接管");
                    data["hot_switched"] = json!(true);
                    data["runtime_state"] = json!("tun_unknown");
                } else {
                    data["hot_switched"] = json!(false);
                }
                Ok(data)
            }
            Err(error) => {
                log::warn!("分流模式切换后自动重连失败：{error}");
                self.emit_routing_changed(&updated, "mode", None, None, false);
                // `abort_connection` 只撤系统代理、不停 runtime，引擎可能还在
                // Starting/Running。摘要必须按真实状态说，不能写死「未连接」。
                let status = self.manager.status().await;
                let mut data = self.route_state_json(&updated, None, None);
                data["hot_switched"] = json!(false);
                data["reconnect"] = json!("reconnect_failed");
                data["runtime_state"] = json!(status.state.as_str());
                Ok(data)
            }
        }
    }

    async fn route_targets_set(
        &self,
        config_id: &str,
        categories: Vec<String>,
    ) -> anyhow::Result<Value> {
        self.require_config(config_id)?;
        if !categories.is_empty() {
            self.validate_targets(&categories)?;
        }
        let updated = {
            let conn = self.store.conn();
            configs::set_route_targets(&conn, config_id, &json!(categories))
                .map_err(|error| config_store_error(error))?
        };
        self.emit_routing_changed(&updated, "targets", None, None, false);
        Ok(self.route_state_json(&updated, None, None))
    }

    async fn vpn_connect(&self, config_id: Option<String>) -> anyhow::Result<Value> {
        self.runtime_start(config_id).await
    }

    async fn vpn_disconnect(&self) -> anyhow::Result<Value> {
        self.runtime_stop(false).await
    }

    async fn diag_run(&self, include_logs: bool) -> anyhow::Result<Value> {
        let status = self.manager.status().await;
        let running = matches!(
            status.state,
            crate::runtime::RuntimeState::Running | crate::runtime::RuntimeState::Degraded
        );
        let available_runtime = self.available_runtime().await;
        let available = available_runtime.is_some();
        let net = tokio::task::spawn_blocking(crate::netcfg::read)
            .await
            .ok()
            .and_then(|result| result.ok());
        let seed = crate::seed::status(&self.store);
        let active_config = {
            let conn = self.store.conn();
            configs::active(&conn).ok().flatten()
        };

        let mut checks = Vec::new();

        // 「随包可用」就是可用：启动时已经从随包装好，不能再判成「未安装」。
        checks.push(diag_check(
            "app.runtime_installed",
            "app",
            available,
            match &available_runtime {
                Some((version, source)) => {
                    format!("运行时可用 {version}（{}）", runtime_source_label(source))
                }
                None => "运行时不可用（随包与已安装版本都不可用）".into(),
            },
            if available {
                None
            } else {
                Some("重新安装 Veyl，或在「高级设置 → 运行库」手动升级")
            },
            None,
        ));
        checks.push(diag_check(
            "app.process_alive",
            "app",
            status.health.process,
            if status.health.process {
                "sing-box 进程存活".into()
            } else {
                "sing-box 进程未运行".into()
            },
            None,
            if running && !status.health.process {
                Some(json!({ "kind": "reconnect" }))
            } else {
                None
            },
        ));
        let version = status
            .upstream_version
            .clone()
            .or_else(|| available_runtime.map(|(version, _)| version));
        checks.push(diag_check(
            "app.version",
            "app",
            version.is_some(),
            version
                .clone()
                .map(|value| format!("运行时版本 {value}"))
                .unwrap_or_else(|| "没有可用的运行时版本".into()),
            None,
            None,
        ));
        checks.push(diag_check(
            "app.config_valid",
            "app",
            !running || status.config_hash.is_some(),
            if running {
                status
                    .config_hash
                    .clone()
                    .unwrap_or_else(|| "缺少配置摘要".into())
            } else {
                "未连接，无活动配置".into()
            },
            None,
            None,
        ));
        checks.push(diag_check(
            "app.clash_api",
            "app",
            !running || status.health.clash_api,
            if status.health.clash_api {
                "控制面可用".into()
            } else {
                "控制面不可用".into()
            },
            if running && !status.health.clash_api {
                Some("重新连接后再试")
            } else {
                None
            },
            None,
        ));
        checks.push(diag_check(
            "app.data_plane",
            "app",
            !running || status.health.data_plane,
            if status.health.data_plane {
                "数据面可用".into()
            } else {
                "数据面不可用".into()
            },
            if running && !status.health.data_plane {
                Some("换个节点或稍后重试")
            } else {
                None
            },
            None,
        ));

        match net.as_ref() {
            Some(net) => {
                let mut endpoints = Vec::new();
                for service in &net.proxies {
                    for entry in [&service.http, &service.https, &service.socks] {
                        if entry.enabled {
                            if let (Some(server), Some(port)) = (&entry.server, entry.port) {
                                endpoints.push(format!("{server}:{port}"));
                            }
                        }
                    }
                }
                let expected = status.mixed_port.map(|port| format!("127.0.0.1:{port}"));
                let dead_loopback = endpoints.iter().any(|endpoint| {
                    let (host, port) = endpoint.rsplit_once(':').unwrap_or((endpoint, ""));
                    let loopback = matches!(host, "127.0.0.1" | "localhost" | "[::1]");
                    let port: u16 = port.parse().unwrap_or(0);
                    loopback && !net.listeners.iter().any(|listener| listener.port == port)
                });
                let (ok, detail) = if running {
                    let matches_runtime = expected
                        .as_ref()
                        .map(|expected| {
                            !endpoints.is_empty() && endpoints.iter().all(|item| item == expected)
                        })
                        .unwrap_or(false);
                    (
                        matches_runtime && !dead_loopback,
                        if endpoints.is_empty() {
                            "系统代理未接管".to_string()
                        } else {
                            format!("{} 个服务指向 {}", endpoints.len(), endpoints[0])
                        },
                    )
                } else if dead_loopback {
                    (false, "系统代理指向未监听的本地端口".to_string())
                } else {
                    (true, format!("{} 个服务启用了代理", endpoints.len()))
                };
                checks.push(diag_check(
                    "system.proxy_services",
                    "system",
                    ok,
                    detail,
                    if ok {
                        None
                    } else {
                        Some("点『恢复网络』撤掉代理后再试")
                    },
                    if ok {
                        None
                    } else {
                        Some(json!({ "kind": "restore_network" }))
                    },
                ));

                checks.push(diag_check(
                    "system.dns",
                    "system",
                    net.dns.resolvable,
                    format!(
                        "{} 个解析器，{} {}",
                        net.dns.servers.len(),
                        net.dns.probe_domain,
                        if net.dns.resolvable {
                            "可解析"
                        } else {
                            "无法解析"
                        }
                    ),
                    if net.dns.resolvable {
                        None
                    } else {
                        Some("刷新 DNS 缓存后重试")
                    },
                    if net.dns.resolvable {
                        None
                    } else {
                        Some(json!({ "kind": "flush_dns" }))
                    },
                ));

                let route_ok = net.route.default_interface.is_some();
                checks.push(diag_check(
                    "system.default_route",
                    "system",
                    route_ok,
                    match (&net.route.default_interface, &net.route.default_gateway) {
                        (Some(interface), Some(gateway)) => {
                            format!("默认接口 {interface}，网关 {gateway}")
                        }
                        (Some(interface), None) => format!("默认接口 {interface}"),
                        _ => "没有默认路由".to_string(),
                    },
                    if route_ok {
                        None
                    } else {
                        Some("检查本机网络连接")
                    },
                    None,
                ));
            }
            None => checks.push(diag_check(
                "system.proxy_services",
                "system",
                false,
                "当前平台无法读取系统网络".into(),
                None,
                None,
            )),
        }

        let exit_ip = status.health.exit_ip.clone();
        checks.push(diag_check(
            "network.exit_ip",
            "network",
            !running || exit_ip.is_some(),
            exit_ip
                .clone()
                .map(|ip| format!("代理出口 {ip}"))
                .unwrap_or_else(|| "未探测到出口 IP".into()),
            if running && exit_ip.is_none() {
                Some("重新连接以重新探测")
            } else {
                None
            },
            if running && exit_ip.is_none() {
                Some(json!({ "kind": "reconnect" }))
            } else {
                None
            },
        ));

        let source_reachable = http_reachable(&crate::seed::source_url()).await;
        checks.push(diag_check(
            "network.reachable_seed_source",
            "network",
            source_reachable,
            if source_reachable {
                "测试节点源可达".into()
            } else {
                "测试节点源不可达".into()
            },
            if source_reachable {
                None
            } else {
                Some("连上网络后刷新测试节点")
            },
            if source_reachable {
                None
            } else {
                Some(json!({ "kind": "refresh_default_profile" }))
            },
        ));
        let github = http_reachable("https://github.com").await;
        checks.push(diag_check(
            "network.reachable_github",
            "network",
            github,
            if github {
                "GitHub 可达".into()
            } else {
                "GitHub 不可达".into()
            },
            None,
            None,
        ));

        let has_config = active_config.is_some() || running;
        checks.push(diag_check(
            "config.current_config",
            "config",
            has_config,
            active_config
                .as_ref()
                .map(|config| format!("当前配置：{}", config.name))
                .unwrap_or_else(|| "还没有可用配置".into()),
            if has_config {
                None
            } else {
                Some("新建一套配置")
            },
            if has_config {
                None
            } else {
                Some(json!({ "kind": "open_default_profile" }))
            },
        ));

        let seed_available = seed.get("content_sha256").and_then(Value::as_str).is_some();
        checks.push(diag_check(
            "config.seed_available",
            "config",
            seed_available,
            if seed_available {
                format!(
                    "测试节点 {} 个",
                    seed.get("node_count").and_then(Value::as_i64).unwrap_or(0)
                )
            } else {
                "还没有测试节点缓存".into()
            },
            if seed_available {
                None
            } else {
                Some("刷新测试节点")
            },
            if seed_available {
                None
            } else {
                Some(json!({ "kind": "refresh_default_profile" }))
            },
        ));

        let stale = seed
            .get("checked_at")
            .and_then(Value::as_i64)
            .map(|checked| {
                store::now_ms().saturating_sub(checked)
                    > crate::seed::REFRESH_INTERVAL.as_millis() as i64
            })
            .unwrap_or(true);
        checks.push(diag_check(
            "config.seed_stale",
            "config",
            !stale,
            if !seed_available {
                "没有测试节点".into()
            } else if stale {
                "测试节点超过 6 小时未更新".into()
            } else {
                "测试节点较新".into()
            },
            if stale {
                Some("刷新测试节点")
            } else {
                None
            },
            if stale {
                Some(json!({ "kind": "refresh_default_profile" }))
            } else {
                None
            },
        ));

        let total = checks.len();
        let ok_count = checks
            .iter()
            .filter(|check| check.get("ok").and_then(Value::as_bool).unwrap_or(false))
            .count();
        let failed = total - ok_count;
        let verdict = if failed == 0 {
            "网络状态正常".to_string()
        } else {
            format!("发现 {failed} 项需要处理")
        };

        let labels = [
            ("app", "应用"),
            ("system", "系统"),
            ("network", "网络"),
            ("config", "配置"),
        ];
        let groups: Vec<Value> = labels
            .iter()
            .map(|(group, label)| {
                json!({
                    "group": group,
                    "label": label,
                    "checks": checks
                        .iter()
                        .filter(|check| check.get("group").and_then(Value::as_str) == Some(*group))
                        .cloned()
                        .collect::<Vec<_>>(),
                })
            })
            .collect();

        let log_excerpt = if include_logs {
            self.runtime_logs(50, None)
                .await
                .ok()
                .and_then(|value| value.get("lines").cloned())
                .and_then(|lines| lines.as_array().cloned())
                .unwrap_or_default()
        } else {
            Vec::new()
        };

        Ok(json!({
            "contract_version": "3.5.0",
            "generated_at": chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
            "app_version": env!("CARGO_PKG_VERSION"),
            "platform": crate::netcfg::platform_name(),
            "arch": std::env::consts::ARCH,
            "runtime": status,
            "summary": {
                "total": total,
                "ok": ok_count,
                "failed": failed,
                "verdict": verdict,
            },
            "groups": groups,
            "checks": checks,
            "log_excerpt": log_excerpt,
        }))
    }

    async fn save_deepseek_key(&self, key: &str) -> anyhow::Result<Value> {
        let outcome = crate::secrets::save_deepseek_key(key)
            .await
            .map_err(|error| {
                let code = match error.ui_code() {
                    "INVALID_KEY" => "INVALID_ARGUMENT",
                    _ => "INTERNAL",
                };
                svc_error(code, error.message())
            })?;
        crate::agent::refresh_credentials_if_active(crate::llm::PROVIDER_DEEPSEEK);
        Ok(json!({
            "saved": true,
            "validation": outcome.validation,
            "validation_detail": outcome.validation_detail,
        }))
    }

    async fn job_get(&self, job_id: &str) -> anyhow::Result<Value> {
        let mut job = self
            .updates
            .job(job_id)
            .ok_or_else(|| svc_error("NOT_FOUND", "任务不存在或已过期"))?;
        job["contract_version"] = json!(crate::tools::envelope::CONTRACT_VERSION);
        Ok(job)
    }

    async fn net_config_get(&self) -> anyhow::Result<Value> {
        let config = tokio::task::spawn_blocking(crate::netcfg::read)
            .await
            .map_err(|error| svc_error("INTERNAL", error))?
            .map_err(|error| {
                let code = if error.starts_with("UNSUPPORTED") {
                    "UNSUPPORTED"
                } else {
                    "INTERNAL"
                };
                svc_error(code, error)
            })?;
        serde_json::to_value(config).map_err(|error| svc_error("INTERNAL", error))
    }

    async fn net_repair(&self, action: &str, port: Option<u16>) -> anyhow::Result<Value> {
        match action {
            "restore_direct" => self.repair_restore_direct(port).await,
            "flush_dns" => self.repair_flush_dns(port).await,
            "set_proxy" => self.repair_set_proxy(port).await,
            "clear_proxy" => self.repair_clear_proxy(port).await,
            other => Err(svc_error(
                "INVALID_ARGUMENT",
                format!("不支持的修复动作：{other}"),
            )),
        }
    }

    /// UI 专用，不注册为 AI 工具。
    async fn network_force_reset(&self) -> anyhow::Result<Value> {
        if !cfg!(target_os = "macos") {
            return Err(svc_error(
                "UNSUPPORTED",
                "强制重置网络目前只支持 macOS；请重启 App 并检查网络设置",
            ));
        }
        self.force_reset_network().await
    }
}

/// 连接期间才允许存在的明文配置：中途任何失败都把它删掉。
struct RenderedConfigGuard {
    config_dir: PathBuf,
    config_key: String,
    armed: bool,
}

impl RenderedConfigGuard {
    fn new(config_dir: PathBuf, config_key: String) -> Self {
        Self {
            config_dir,
            config_key,
            armed: true,
        }
    }

    fn disarm(mut self) {
        self.armed = false;
    }
}

impl Drop for RenderedConfigGuard {
    fn drop(&mut self) {
        if self.armed {
            vpn_config::remove_profile_config(&self.config_dir, &self.config_key);
        }
    }
}

impl WiredServices {
    fn abort_connection(&self, error: anyhow::Error) -> anyhow::Error {
        if let Err(disable_error) = self.proxy.disable() {
            log::warn!("连接中止后撤销系统代理失败：{disable_error}");
        }
        error
    }

    /// 连接失败时把运行时日志末尾附到错误里。
    ///
    /// sing-box 的 FATAL 只写进它自己的日志文件（`runtime-<ver>.log`）。
    /// 不读出来，AI 和用户只能看到「进程退出了」——任何运行时故障都会
    /// 变成「不知道哪出了问题」。
    fn attach_runtime_log_tail(&self, error: anyhow::Error, version: &str) -> anyhow::Error {
        let path = StartPlan::log_path(&self.manager.cfg, version);
        let Some(tail) = read_log_tail(&path, RUNTIME_LOG_TAIL_LINES) else {
            return error;
        };
        let (code, message, mut details) = match error.downcast_ref::<ServiceError>() {
            Some(service) => (
                service.code.clone(),
                service.message.clone(),
                service.details.clone().unwrap_or_else(|| json!({})),
            ),
            None => ("INTERNAL".to_string(), error.to_string(), json!({})),
        };
        details["runtime_log_tail"] = json!(tail);
        svc_error_with_details(
            code,
            format!("{message}\n运行时日志最后 {RUNTIME_LOG_TAIL_LINES} 行：\n{tail}"),
            details,
        )
    }

    fn restore_system_proxy(&self) -> anyhow::Result<()> {
        let applied = self.proxy.applied_endpoint().ok().flatten();
        if let Err(error) = self.proxy.disable() {
            return Err(svc_error_with_details(
                "PRECONDITION_FAILED",
                format!("撤销系统代理失败：{error}"),
                json!({ "reason": "proxy_restore_failed" }),
            ));
        }
        if let Some(endpoint) = applied {
            let still = self.proxy.endpoint_in_use(&endpoint).map_err(|error| {
                svc_error_with_details(
                    "INTERNAL",
                    format!("校验系统代理失败：{error}"),
                    json!({ "reason": "proxy_restore_failed" }),
                )
            })?;
            if !still.is_empty() {
                return Err(svc_error_with_details(
                    "PRECONDITION_FAILED",
                    format!("{endpoint} 仍被 {} 个网络服务使用", still.len()),
                    json!({ "reason": "proxy_restore_failed", "services": still }),
                ));
            }
        }
        Ok(())
    }

    async fn rollback_proxy_after_enable_failure(&self) {
        if let Err(error) = self.proxy.disable() {
            log::warn!("回滚系统代理失败：{error}");
        }
        let _ = self.manager.stop().await;
    }

    fn drop_previous_rendered_config(&self, target_config_id: &str) {
        if let Some(previous) = self.active_config_id() {
            if previous != target_config_id {
                vpn_config::remove_profile_config(&self.config_dir(), &previous);
            }
        }
    }

    /// 连接一套配置。分流与节点准备两种模式共用，只有「怎么起」不同。
    /// debug 构建：一次连接的结果与耗时集中成一行，失败时带上「卡在哪一步」。
    async fn connect(&self, config: &configs::Config) -> anyhow::Result<Value> {
        let started = std::time::Instant::now();
        let result = self.connect_inner(config).await;
        if cfg!(debug_assertions) {
            match &result {
                Ok(_) => log::debug!(
                    "连接完成 config={} mode={} 耗时={}ms",
                    config.id,
                    config.connection_mode,
                    started.elapsed().as_millis()
                ),
                Err(error) => {
                    let (code, reason, wire_code) = service_error_fields(error);
                    log::debug!(
                        "连接失败 卡在={} config={} mode={} code={code} reason={} wire_code={} 耗时={}ms",
                        connect_phase(&code, reason.as_deref()),
                        config.id,
                        config.connection_mode,
                        reason.as_deref().unwrap_or("-"),
                        wire_code.as_deref().unwrap_or("-"),
                        started.elapsed().as_millis()
                    );
                }
            }
        }
        result
    }

    async fn connect_inner(&self, config: &configs::Config) -> anyhow::Result<Value> {
        log::info!(
            "连接开始 config={} mode={} routing={}",
            config.id,
            config.connection_mode,
            config.routing_mode
        );

        let installed_rules =
            crate::rules::load_active(&self.store, &self.data_dir).ok_or_else(|| {
                svc_error_with_details(
                    "PRECONDITION_FAILED",
                    "规则数据尚未就绪，先刷新规则数据",
                    json!({ "reason": "rules_not_ready" }),
                )
            })?;
        let targets = config
            .route_targets
            .as_array()
            .map(|items| {
                items
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_string)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let region = crate::rules::detected_region();
        let plan = crate::rules::plan::build(&crate::rules::plan::RouteInput {
            mode: &config.routing_mode,
            region: region.as_deref(),
            targets: &targets,
            rules: &installed_rules,
        })
        .map_err(|error| {
            svc_error_with_details(
                error.code(),
                error.to_string(),
                json!({ "reason": error.reason() }),
            )
        })?;

        let (node, password) = self.active_node(config)?;
        let installed = self.ensure_runtime().await?;
        self.drop_previous_rendered_config(&config.id);

        let mixed_port = match config.listen_port {
            Some(port) => port,
            None => vpn_config::pick_free_port().map_err(|e| svc_error(e.code(), e))?,
        };
        let mut clash_port = vpn_config::pick_free_port().map_err(|e| svc_error(e.code(), e))?;
        for _ in 0..5 {
            if clash_port != mixed_port {
                break;
            }
            clash_port = vpn_config::pick_free_port().map_err(|e| svc_error(e.code(), e))?;
        }
        let clash_secret = vpn_config::random_secret();

        // 配置内全部节点都进 selector：Clash API 才能对任意节点测延迟，
        // 也为后续节点热切保留完整成员表。
        let members = {
            let conn = self.store.conn();
            configs::list_nodes(&conn, &config.id)
                .map_err(|error| svc_error(error.code(), error))?
        };
        let mut descriptors = Vec::new();
        for member in &members {
            let member_password = if member.id == node.id {
                Some(password.clone())
            } else {
                crate::secrets::get_secret(&member.password_ref)
                    .ok()
                    .flatten()
            };
            let Some(member_password) = member_password else {
                log::warn!("节点 {} 缺少凭据，跳过 selector", member.id);
                continue;
            };
            descriptors.push(vpn_config::NodeDescriptor {
                id: member.id.clone(),
                name: member.name.clone(),
                server: member.server.clone(),
                server_port: member.port,
                protocol: vpn_config::ProtocolConfig::Shadowsocks {
                    password: member_password,
                    method: member.method.clone(),
                },
            });
        }
        let current_descriptor = descriptors
            .iter()
            .find(|descriptor| descriptor.id == node.id)
            .cloned()
            .ok_or_else(|| svc_error("PRECONDITION_FAILED", "当前节点凭据缺失，请重新导入"))?;

        let started = if config.connection_mode == configs::CONNECTION_TUN {
            self.start_tun_connection(
                config,
                &descriptors,
                &current_descriptor,
                &plan,
                mixed_port,
                clash_port,
                clash_secret,
            )
            .await
        } else {
            let input = vpn_config::BuildInput::new(
                current_descriptor,
                mixed_port,
                clash_port,
                clash_secret,
            );
            let value = vpn_config::build_routed_multi(&input, &descriptors, &node.id, &plan)
                .map_err(|e| svc_error(e.code(), e))?;
            self.start_connection(
                &installed,
                &config.id,
                Some(config.id.clone()),
                Some(config.name.clone()),
                Some(node.id.clone()),
                Some(node.name.clone()),
                Some(config.route_revision),
                &value,
            )
            .await
        };

        match started {
            Ok(data) => {
                {
                    let conn = self.store.conn();
                    let _ = configs::mark_used(&conn, &config.id);
                }
                if !config.is_active {
                    {
                        let conn = self.store.conn();
                        let _ = configs::activate(&conn, &config.id);
                    }
                    if let Ok(updated) = self.require_config(&config.id) {
                        self.emit_config_changed("activated", Some(&updated));
                    }
                }
                Ok(data)
            }
            Err(error) => {
                // 种子节点连不上时立即强制刷新一次，不等 6 小时轮询。
                if node.source == configs::SOURCE_SEED {
                    let store = Arc::clone(&self.store);
                    tauri::async_runtime::spawn(async move {
                        let outcome = crate::seed::refresh(&store, false, true).await;
                        log::info!("种子节点连接失败后强制刷新：{outcome:?}");
                    });
                }
                Err(error)
            }
        }
    }

    /// TUN：写盘（0600，含凭据）→ 特权 helper 拉起 sing-box。
    ///
    /// 与 proxy 模式**分流与节点准备完全共用**，区别只有两点：
    /// 不设系统代理（接管靠路由表），以及进程是 helper 的子进程。
    ///
    /// 失败一律是权限问题，只回 `helper_missing` / `helper_install_failed` /
    /// `tun_denied` / `tun_start_failed`，**不降级成系统代理**
    /// （`docs/tun-mode.md` §8）。
    #[allow(clippy::too_many_arguments)]
    async fn start_tun_connection(
        &self,
        config: &configs::Config,
        descriptors: &[vpn_config::NodeDescriptor],
        current: &vpn_config::NodeDescriptor,
        plan: &crate::rules::plan::RoutePlan,
        mixed_port: u16,
        clash_port: u16,
        clash_secret: String,
    ) -> anyhow::Result<Value> {
        // 排除表 = 固定表 + 本机反推 + 用户补充 + 节点服务器旁路。
        // 最后一项不能省：节点服务器若落在被接管段里，sing-box 连自己也会绕成环路。
        let local = crate::tun::subnets(&crate::tun::collect());
        let user = tun_excludes_from_value(&config.tun_excludes);
        let mut excludes = crate::tun::excludes(&local, &user);
        let bypass = node_bypass_plan(descriptors).await;
        excludes.extend(bypass.prefixes.iter().cloned());

        // 当前节点的域名解析不出来时直接失败：
        // 没有旁路就可能绕回 TUN，而且 sing-box 自己也要靠同一次解析才能连上。
        // 其它节点解析失败只记警告——它们可能永远不会被选中，不该拖死本次连接。
        if !node_server_is_resolved(&current.server, &bypass.pinned) {
            let label = if current.name.is_empty() {
                &current.id
            } else {
                &current.name
            };
            log::error!("当前节点「{label}」的服务器域名解析失败，拒绝启动 TUN");
            return Err(svc_error_with_details(
                "tun_start_failed",
                format!("节点「{label}」的服务器域名解析失败，请检查网络或换一个节点"),
                json!({
                    "reason": "tun_start_failed",
                    "permission_problem": false,
                    "wire_code": null,
                    "local_code": null,
                    "detail": { "reason": "node_server_unresolved" },
                }),
            ));
        }
        // 出站 server 钉成解析出的 IP（TLS 的 server_name 不动）：
        // 否则 sing-box 会再解析一次，GeoDNS 给出别的地址就绕过了刚加的旁路。
        //
        // 未解析出地址的节点**不进 selector**：`node_switch` 是 Clash 热切，
        // 不重连、也不会重跑解析；把它们留在里面等于给环路留后门。
        let pinned_descriptors = descriptors
            .iter()
            .filter_map(|descriptor| {
                if !node_server_is_resolved(&descriptor.server, &bypass.pinned) {
                    log::warn!(
                        "节点 {} 的服务器域名未能解析，已从 TUN selector 中剔除",
                        descriptor.id
                    );
                    return None;
                }
                let mut descriptor = descriptor.clone();
                if let Some(address) = bypass.pinned.get(descriptor.server.trim()) {
                    descriptor.server = address.to_string();
                }
                Some(descriptor)
            })
            .collect::<Vec<_>>();
        let pinned_current = pinned_descriptors
            .iter()
            .find(|descriptor| descriptor.id == current.id)
            .cloned()
            .unwrap_or_else(|| current.clone());

        let input =
            vpn_config::BuildInput::new(pinned_current, mixed_port, clash_port, clash_secret)
                .with_tun_excludes(excludes.clone());
        let value = vpn_config::build_routed_multi(&input, &pinned_descriptors, &current.id, plan)
            .map_err(|e| svc_error(e.code(), e))?;

        // 不再由我们在用户目录里写配置：helper 收内容、自己落盘、自己跑 check。
        let config_json = serde_json::to_string(&value)
            .map_err(|e| svc_error("INTERNAL", format!("序列化配置失败：{e}")))?;

        // 每次 TUN 连接前再比对一次 helper 构建：App 已升级但后台还是旧映像时，
        // 先换新再连；换不了就让本次连接失败，避免用旧 helper 接管流量。
        let helper = Arc::clone(&self.helper);
        tokio::task::spawn_blocking(move || helper.ensure_current_for_connect())
            .await
            .map_err(|error| svc_error("INTERNAL", format!("检查后台组件失败：{error}")))?
            .map_err(|(message, reason)| {
                svc_error_with_details(
                    "PRECONDITION_FAILED",
                    message,
                    json!({ "reason": reason }),
                )
            })?;

        // TUN 不设系统代理：接管靠路由表（`docs/config-execution.md` §2 第 4 步）。
        // 之前若在 proxy 模式，这里要把残留的系统代理撤掉，否则两层同时生效。
        self.restore_system_proxy()?;
        self.manager.set_system_proxy_enabled(false).await;

        log::debug!("连接 TUN 配置已生成");
        let pid = match self.tun.launch(
            &config_json,
            &crate::tun::session::TunLaunchMeta {
                config_id: config.id.clone(),
                config_name: Some(config.name.clone()),
                node_id: Some(current.id.clone()),
                node_name: Some(current.name.clone()),
                applied_route_revision: Some(config.route_revision),
            },
        ) {
            Ok(started) => {
                log::info!("连接 TUN 运行时已启动 pid={}", started.pid);
                started.pid
            }
            Err(error) => {
                log::error!(
                    "连接 TUN 启动失败 code={}：{}",
                    error.code.as_str(),
                    error.message
                );
                return Err(svc_error_with_details(
                    tun_error_code(&error),
                    error.message.clone(),
                    tun_error_details(&error),
                ));
            }
        };

        log::info!("TUN 已连接 pid={pid} config={}", config.id);
        // helper 只等 sing-box check + spawn，不等 TUN 设备与路由表。
        // 设备出现 + 接管路由完整，才算「流量真的被接管」；
        // 只看到设备就把「已连接」报给用户，等于让用户以为通了、实际半接管。
        //
        // Windows 还没有适配器枚举（`tun::collect()` 返回空）：不白等 1.5 秒，
        // 也不把「未采集」说成「设备没出现」。两个字段用 null 标记未采集。
        #[cfg(target_os = "windows")]
        let (tun_device_up, tun_default_route) = (Value::Null, Value::Null);
        #[cfg(not(target_os = "windows"))]
        let (tun_device_up, tun_default_route) = {
            let tun_device =
                crate::tun::wait_until_device_up(std::time::Duration::from_secs(5)).await;
            let Some(name) = tun_device else {
                log::error!("TUN 已启动 pid={pid}，5s 内没看到 TUN 设备，判定启动失败并回滚");
                let stop_error = self.tun.stop().err();
                let dns_error = self.tun.flush_dns().err().map(|error| error.message);
                return Err(takeover_incomplete_error(
                    &[],
                    stop_error.as_ref(),
                    false,
                    dns_error.as_deref(),
                ));
            };
            // 路由可能比设备晚几十毫秒到几秒；给 5 秒窗口，
            // 但**不接受**半覆盖：缺一段就回滚，绝不对外报已连接。
            let missing =
                wait_for_takeover(&name, &excludes, std::time::Duration::from_secs(5)).await;
            if !missing.is_empty() {
                log::error!("TUN 接管不完整 tun={name} missing={missing:?}，停止实例并回滚");
                let stop_error = self.tun.stop().err();
                let residual = stop_error.is_none()
                    && !wait_until_routes_gone(&name, std::time::Duration::from_secs(2)).await;
                // 只停进程不够：hijack 期间的坏解析结果还留在 mDNSResponder 里。
                let dns_error = self.tun.flush_dns().err().map(|error| error.message);
                return Err(takeover_incomplete_error(
                    &missing,
                    stop_error.as_ref(),
                    residual,
                    dns_error.as_deref(),
                ));
            }
            log::info!("TUN 接管已确认 pid={pid} tun={name} routes=完整");
            (json!(true), json!(true))
        };
        Ok(json!({
            "contract_version": crate::runtime::CONTRACT_VERSION,
            "state": "running",
            "mode": "tun",
            "pid": pid,
            "mixed_port": null,
            "config_id": config.id,
            "config_name": config.name,
            "routing_mode": config.routing_mode,
            "node_id": current.id,
            "node_name": current.name,
            "applied_route_revision": config.route_revision,
            "connected_since": chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
            "system_proxy_enabled": false,
            "tun_device_up": tun_device_up,
            "tun_default_route": tun_default_route,
            "exit_ip": Value::Null,
        }))
    }

    /// 渲染 → 启动 → 设代理 → 等出口 IP。
    async fn start_connection(
        &self,
        installed: &crate::runtime::InstalledRuntime,
        config_key: &str,
        db_config_id: Option<String>,
        config_name: Option<String>,
        node_id: Option<String>,
        node_name: Option<String>,
        applied_route_revision: Option<i64>,
        value: &Value,
    ) -> anyhow::Result<Value> {
        let guard = RenderedConfigGuard::new(self.config_dir(), config_key.to_string());

        let path = vpn_config::install_profile(
            &installed.binary,
            &self.config_dir(),
            config_key,
            value,
            None,
        )
        .await
        .map_err(|e| svc_error(e.code(), e))?;

        log::debug!("连接 配置已渲染并通过 check path={}", path.display());
        let text = std::fs::read_to_string(&path)
            .map_err(|e| svc_error("PRECONDITION_FAILED", format!("读取本地配置失败：{e}")))?;
        let value: Value = serde_json::from_str(&text)
            .map_err(|e| svc_error("PRECONDITION_FAILED", format!("本地配置损坏：{e}")))?;
        let (mixed_port, clash_port, secret) = Self::config_endpoints(&value)
            .ok_or_else(|| svc_error("PRECONDITION_FAILED", "本地配置缺少端口或 secret"))?;

        let plan = StartPlan {
            version: installed.version.clone(),
            binary: installed.binary.clone(),
            config_path: path,
            work_dir: installed.dir.clone(),
            log_path: StartPlan::log_path(&self.manager.cfg, &installed.version),
            clash_addr: format!("127.0.0.1:{clash_port}"),
            clash_secret: secret,
            mixed_port,
            config_id: db_config_id.clone(),
            config_name,
            node_id,
            node_name,
            applied_route_revision,
        };

        // 切配置/重连：先撤旧代理，避免旧进程已停、代理还指着旧端口。
        let state = self.manager.status().await.state;
        if matches!(
            state,
            crate::runtime::RuntimeState::Running
                | crate::runtime::RuntimeState::Degraded
                | crate::runtime::RuntimeState::Starting
                | crate::runtime::RuntimeState::Restarting
        ) {
            self.restore_system_proxy()?;
            self.manager.set_system_proxy_enabled(false).await;
        }

        let started = match self.manager.start(plan).await {
            Ok(status) => status,
            Err(error) => {
                let error = self.abort_connection(svc_error(error.code(), error));
                return Err(self.attach_runtime_log_tail(error, &installed.version));
            }
        };

        log::info!(
            "连接 运行时已启动 state={:?} pid={:?}",
            started.state,
            started.pid
        );
        if let Err(error) = require_running_state(started.state) {
            log::error!("连接 运行时状态不是 running：{error}");
            let error = self.abort_connection(error);
            return Err(self.attach_runtime_log_tail(error, &installed.version));
        }

        if let Err(error) = self.proxy.enable(mixed_port) {
            log::error!("连接 设置系统代理失败 port={mixed_port}：{error}");
            self.rollback_proxy_after_enable_failure().await;
            return Err(svc_error("INTERNAL", format!("设置系统代理失败：{error}")));
        }
        log::info!("连接 系统代理已设置 127.0.0.1:{mixed_port}");
        self.manager.set_system_proxy_enabled(true).await;

        let awaited_ip = self
            .manager
            .await_exit_ip(std::time::Duration::from_secs(3))
            .await;

        let status = self.manager.status().await;
        let exit_ip = status.health.exit_ip.clone().or(awaited_ip);
        let mut data = serde_json::to_value(status).map_err(|e| svc_error("INTERNAL", e))?;
        data["exit_ip"] = exit_ip.map(Value::String).unwrap_or(Value::Null);

        guard.disarm();
        Ok(data)
    }

    async fn repair_restore_direct(&self, port: Option<u16>) -> anyhow::Result<Value> {
        if port.is_some() {
            return Err(svc_error("INVALID_ARGUMENT", "restore_direct 不接受 port"));
        }
        let applied = self.proxy.applied_endpoint().ok().flatten();
        let mut verified = self.proxy.disable().is_ok();
        if let Some(endpoint) = applied {
            verified = verified
                && self
                    .proxy
                    .endpoint_in_use(&endpoint)
                    .map(|in_use| in_use.is_empty())
                    .unwrap_or(false);
        }
        let _ = self.manager.stop().await;
        crate::config::remove_all_profile_configs(&self.config_dir());
        verified =
            verified && self.manager.status().await.state == crate::runtime::RuntimeState::Idle;

        let exit_ip =
            match crate::runtime::DirectIpProbe::new(crate::runtime::DEFAULT_DIRECT_IP_PROBE) {
                Ok(probe) => probe.check().await.ok().flatten(),
                Err(_) => None,
            };
        let detail = if verified {
            match &exit_ip {
                Some(ip) => format!("已恢复直连，当前出口 IP {ip}"),
                None => "已恢复直连".to_string(),
            }
        } else {
            "网络设置未能完全恢复，请重试".to_string()
        };
        Ok(json!({
            "ok": verified,
            "action": "restore_direct",
            "detail": detail,
            "exit_ip": exit_ip,
            "verified": verified,
        }))
    }

    async fn repair_flush_dns(&self, port: Option<u16>) -> anyhow::Result<Value> {
        if port.is_some() {
            return Err(svc_error("INVALID_ARGUMENT", "flush_dns 不接受 port"));
        }
        // 与强制重置同一条路径：助手可用时只有它能 HUP mDNSResponder。
        if matches!(
            self.tun.helper_status(),
            crate::tun::privilege::HelperStatus::Enabled
        ) {
            let tun = Arc::clone(&self.tun);
            tokio::task::spawn_blocking(move || tun.flush_dns())
                .await
                .map_err(|error| svc_error("INTERNAL", error))?
                .map_err(|error| {
                    log::warn!("特权刷新 DNS 失败：{error}");
                    svc_error("INTERNAL", flush_dns_failure_message(&error))
                })?;
        } else {
            tokio::task::spawn_blocking(crate::netcfg::flush_dns)
                .await
                .map_err(|error| svc_error("INTERNAL", error))?
                .map_err(|error| svc_error("INTERNAL", error))?;
        }
        // HUP 之后 mDNSResponder 要几百毫秒才回来；给它 3 秒。
        let mut verified = false;
        for _ in 0..20 {
            if tokio::task::spawn_blocking(crate::netcfg::dns_resolvable)
                .await
                .unwrap_or(false)
            {
                verified = true;
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(150)).await;
        }
        Ok(json!({
            "ok": verified,
            "action": "flush_dns",
            "detail": if verified {
                "DNS 缓存已刷新，探针域名可解析"
            } else {
                "DNS 缓存已刷新，但探针域名仍无法解析"
            },
            "exit_ip": Value::Null,
            "verified": verified,
        }))
    }

    /// 强制重置网络：八步固定、顺序固定，每步独立记录，失败不中断后续。
    /// 顶层 `ok` 要求八步全过；`verified` 只反映最后一步的复检——
    /// 「跑完了」不等于「恢复好了」，两者不能混。
    async fn force_reset_network(&self) -> anyhow::Result<Value> {
        // 端口与备份必须在 stop 之前取：manager.stop() 会清掉 plan。
        let plan_port = self
            .manager
            .current_plan()
            .await
            .map(|plan| plan.mixed_port);
        let applied = self.proxy.applied_endpoint().ok().flatten();

        let mut steps = Vec::with_capacity(8);
        steps.push(self.reset_stop_tun().await);
        steps.push(self.reset_stop_runtime().await);
        steps.push(self.reset_restore_proxy(applied.as_ref(), plan_port));
        steps.push(self.reset_sweep_processes().await);
        steps.push(self.reset_clear_routes());
        steps.push(self.reset_flush_dns().await);
        steps.push(self.reset_clear_plaintext());

        let (verify, exit_ip) = self.reset_verify(applied.as_ref(), plan_port).await;
        steps.push(verify);

        let ok = steps_all_ok(&steps);
        let verified = steps
            .last()
            .and_then(|step| step.get("ok"))
            .and_then(Value::as_bool)
            .unwrap_or(false);
        log::info!(
            "强制重置网络 完成 ok={ok} verified={verified} 未通过={:?}",
            steps
                .iter()
                .filter(|step| step.get("ok").and_then(Value::as_bool) != Some(true))
                .filter_map(|step| step.get("id").and_then(Value::as_str))
                .collect::<Vec<_>>()
        );

        Ok(json!({
            "ok": ok,
            "verified": verified,
            "exit_ip": exit_ip,
            "steps": steps,
        }))
    }

    async fn reset_stop_tun(&self) -> Value {
        match self.tun_stop_outcome().await {
            TunStopOutcome::Stopped { was_running } => reset_step(
                "stop_tun",
                true,
                if was_running {
                    "TUN 已停止"
                } else {
                    "TUN 未在运行"
                },
            ),
            TunStopOutcome::Unconfirmed(message) => reset_step(
                "stop_tun",
                false,
                format!(
                    "{message}；可尝试：sudo launchctl kickstart -k system/com.veyl.helper"
                ),
            ),
            TunStopOutcome::Failed(message) => reset_step(
                "stop_tun",
                false,
                format!(
                    "{message}；可尝试：sudo launchctl kickstart -k system/com.veyl.helper，\
                     仍未停掉再执行 sudo pkill -f '/Library/Application Support/Veyl/runtime/.*/sing-box'"
                ),
            ),
        }
    }

    async fn reset_stop_runtime(&self) -> Value {
        match self.stop_runtime_action().await {
            Ok(()) => {
                let state = self.manager.status().await.state;
                let ok = state == crate::runtime::RuntimeState::Idle;
                reset_step(
                    "stop_runtime",
                    ok,
                    if ok {
                        "代理模式已停止".to_string()
                    } else {
                        format!("运行时仍处于 {}", state.as_str())
                    },
                )
            }
            Err(message) => reset_step("stop_runtime", false, message),
        }
    }

    fn reset_restore_proxy(
        &self,
        applied: Option<&crate::proxy::ProxyEndpoint>,
        plan_port: Option<u16>,
    ) -> Value {
        let applied = applied.cloned();
        // 与 cleanup_network 共用同一段「还原 + 复核」。
        let disable_error = self
            .restore_system_proxy()
            .err()
            .map(|error| user_message(&error));

        // 备份丢失或还原失败时，系统代理可能还指着我们的端口。
        // 只按「回环 + 这个端口」精确关掉，用户自己的代理一概不动。
        let mut cleared_services = Vec::new();
        let mut clear_error = None;
        if (applied.is_none() || disable_error.is_some()) && plan_port.is_some() {
            if let Some(port) = plan_port {
                match crate::netcfg::disable_proxy_for_port(port) {
                    Ok(services) => cleared_services = services,
                    Err(error) => clear_error = Some(error),
                }
            }
        }

        let in_use = applied
            .as_ref()
            .and_then(|endpoint| self.proxy.endpoint_in_use(endpoint).ok());

        let current = if applied.is_none() {
            Some(match self.proxy.current_endpoint() {
                Ok(value) => CurrentProxy::Known(value),
                Err(error) => CurrentProxy::Unknown(error.to_string()),
            })
        } else {
            None
        };

        judge_restore_proxy(&ProxyResetFacts {
            applied,
            plan_port,
            disable_error,
            clear_error,
            cleared_services,
            in_use,
            current,
        })
    }

    /// 扫描 `ps` 里属于我们的 sing-box，返回 `(pid, 命令行, 是否 root)`。
    async fn our_sing_box_processes(&self) -> Result<Vec<(u32, String, bool)>, String> {
        let mut roots = vec![self.data_dir.clone()];
        if let Some(root) = crate::net_reset::tun_runtime_root() {
            roots.push(root);
        }
        tokio::task::spawn_blocking(move || {
            let output = crate::net_reset::read_ps()?;
            let entries = crate::net_reset::parse_ps(&output);
            Ok(crate::net_reset::find_sing_box_processes(&entries, &roots)
                .into_iter()
                .map(|entry| {
                    (
                        entry.pid,
                        entry.command.clone(),
                        crate::net_reset::is_helper_runtime(&entry.command),
                    )
                })
                .collect())
        })
        .await
        .map_err(|error| format!("扫描进程失败：{error}"))?
    }

    /// helper 由 launchd 守护，刚停完 TUN 时可能短暂不可用。
    /// 给它一个短窗口，仍不可用才按失败处理。
    async fn wait_for_helper(
        &self,
        timeout: std::time::Duration,
    ) -> crate::tun::privilege::HelperStatus {
        use crate::tun::privilege::HelperStatus;

        let deadline = tokio::time::Instant::now() + timeout;
        loop {
            let status = self.tun.helper_status();
            if status.is_ready()
                || matches!(status, HelperStatus::Unsupported)
                || tokio::time::Instant::now() >= deadline
            {
                return status;
            }
            tokio::time::sleep(std::time::Duration::from_millis(250)).await;
        }
    }

    async fn reset_sweep_processes(&self) -> Value {
        use crate::tun::privilege::HelperStatus;

        let mut notes = Vec::new();
        let mut ok = true;

        // 有 pid 记录时由 manager 做三重核对后回收；没有记录的才走下面的路径匹配。
        match self.manager.reclaim_stale().await {
            Ok(Some(pid)) => notes.push(format!("回收了遗留的代理 sing-box（pid {pid}）")),
            Ok(None) => {}
            Err(error) => {
                ok = false;
                notes.push(format!("回收代理残留失败：{error}"));
            }
        }

        // 重试窗口：helper 可能正在被 launchd 重启，别一次问不到就下结论。
        let helper = self
            .wait_for_helper(std::time::Duration::from_secs(2))
            .await;
        let helper_ok = helper.is_ready() || matches!(helper, HelperStatus::Unsupported);
        if !helper_ok {
            ok = false;
            notes.push(format!(
                "特权助手不可用（{}），无法确认特权侧没有残留；先重启 App 或按提示授权再试",
                helper.as_str()
            ));
        }

        let leftovers = match self.our_sing_box_processes().await {
            Ok(found) => found,
            Err(error) => return reset_step("sweep_processes", false, error),
        };

        let mut remaining: Vec<(u32, bool)> = Vec::new();
        for (pid, command, is_root) in leftovers {
            if is_root {
                // root 进程只有 helper 能停；没有权限就不假装停了。
                remaining.push((pid, true));
                continue;
            }
            if crate::runtime::process::terminate_pid(pid, std::time::Duration::from_secs(2)).await
            {
                notes.push(format!("结束了遗留的 sing-box（pid {pid}）"));
            } else {
                log::warn!("遗留 sing-box pid={pid} 未能结束：{command}");
                remaining.push((pid, false));
            }
        }

        // root 进程也可能正在被 helper 收掉，再给 2 秒重扫。
        if remaining.iter().any(|(_, is_root)| *is_root) {
            let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(2);
            loop {
                if tokio::time::Instant::now() >= deadline {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(250)).await;
                let still: Vec<u32> = match self.our_sing_box_processes().await {
                    Ok(found) => found
                        .into_iter()
                        .filter(|(_, _, is_root)| *is_root)
                        .map(|(pid, _, _)| pid)
                        .collect(),
                    Err(_) => break,
                };
                if still.is_empty() {
                    remaining.retain(|(_, is_root)| !*is_root);
                    notes.push("特权侧的 sing-box 已在重试窗口内退出".to_string());
                    break;
                }
            }
        }

        if remaining.is_empty() {
            return reset_step(
                "sweep_processes",
                ok,
                if notes.is_empty() {
                    "没有 Veyl 的 sing-box 残留".to_string()
                } else {
                    notes.join("；")
                },
            );
        }

        let pids = remaining
            .iter()
            .map(|(pid, _)| pid.to_string())
            .collect::<Vec<_>>()
            .join("、");
        let needs_root = remaining.iter().any(|(_, root)| *root);
        let mut detail = format!("仍有 Veyl 的 sing-box 残留（pid {pids}）");
        if needs_root {
            detail.push_str("，属于特权助手，需要重启 App 或手工清理");
        }
        if !notes.is_empty() {
            detail = format!("{}；{detail}", notes.join("；"));
        }
        reset_step("sweep_processes", false, detail)
    }

    #[cfg(target_os = "macos")]
    fn reset_clear_routes(&self) -> Value {
        let netstat = match crate::net_reset::read_netstat() {
            Ok(output) => output,
            Err(error) => {
                return reset_step("clear_routes", false, format!("读取路由表失败：{error}"))
            }
        };
        let live = match crate::net_reset::read_ifconfig() {
            Ok(output) => crate::net_reset::parse_interface_names(&output),
            Err(error) => {
                // 读不到接口就无法判断哪条路由是残留：fail-closed。
                // 这里既不能删，也不能给删除建议——照做会删掉正在用的 TUN。
                return reset_step(
                    "clear_routes",
                    false,
                    format!("读取接口列表失败，未删除任何路由：{error}"),
                );
            }
        };
        let stale = crate::net_reset::stale_split_routes(&netstat, &live);
        if stale.is_empty() {
            return reset_step("clear_routes", true, "没有指向已消失 utun 的分流路由");
        }

        let mut deleted = Vec::new();
        let mut failed = Vec::new();
        for route in &stale {
            match crate::net_reset::delete_route(&route.destination, &route.interface) {
                Ok(()) => deleted.push(route.destination.clone()),
                Err(error) => {
                    log::warn!("删除路由 {} 失败：{error}", route.destination);
                    failed.push(route.clone());
                }
            }
        }

        if failed.is_empty() {
            return reset_step(
                "clear_routes",
                true,
                format!("已删除分流路由 {}", deleted.join("、")),
            );
        }
        // 改路由表要 root；这里不弹管理员，如实给出可复制的命令。
        // 只对「接口确认已消失」的路由给建议（上面的 fail-closed 保证）。
        let manual = failed
            .iter()
            .map(|route| {
                format!(
                    "sudo route -n delete -net {} -ifscope {}（该接口已消失）",
                    route.destination, route.interface
                )
            })
            .collect::<Vec<_>>()
            .join("；");
        reset_step(
            "clear_routes",
            false,
            format!("路由残留需要手工清理：{manual}"),
        )
    }

    #[cfg(not(target_os = "macos"))]
    fn reset_clear_routes(&self) -> Value {
        reset_step(
            "clear_routes",
            false,
            "当前平台未实现路由检查；若 TUN 仍在接管流量请重启系统",
        )
    }

    async fn reset_flush_dns(&self) -> Value {
        // 关键：macOS 上 `dscacheutil -flushcache` 用普通用户执行也返回 0，
        // 但真正装着解析缓存的是 mDNSResponder，只有 root 的 `killall -HUP`
        // 才清得掉。只跑本地命令正是上次「重置报 ok、网络没恢复」的原因。
        let tun = Arc::clone(&self.tun);
        let privileged = match tokio::task::spawn_blocking(move || tun.flush_dns()).await {
            Ok(Ok(())) => Ok(()),
            Ok(Err(error)) => Err(error.message),
            Err(error) => Err(format!("刷新任务失败：{error}")),
        };
        let privileged_ok = privileged.is_ok();
        if let Err(reason) = &privileged {
            log::warn!("特权刷新 DNS 失败：{reason}");
        }

        // 兜底的本机命令照跑；它清不掉 mDNSResponder，不能据此判成功。
        let local_error = if privileged_ok {
            None
        } else {
            crate::netcfg::flush_dns().err()
        };

        // HUP 之后 mDNSResponder 要几百毫秒才回来；给它 3 秒。
        let mut resolved = false;
        for _ in 0..20 {
            if tokio::task::spawn_blocking(crate::netcfg::dns_resolvable)
                .await
                .unwrap_or(false)
            {
                resolved = true;
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(150)).await;
        }

        // 点名指向本机的解析器。可能是 Veyl 残留，也可能是用户自建的本地 DNS，
        // 所以只写进 detail；是否真的坏了，由「能不能解析」判断。
        let suspicious = tokio::task::spawn_blocking(crate::netcfg::suspicious_dns_servers)
            .await
            .unwrap_or_else(|error| Err(error.to_string()));

        // 助手可用时，特权刷新失败不能算成功——缓存可能还留着别的坏答案。
        let helper_enabled = matches!(
            self.tun.helper_status(),
            crate::tun::privilege::HelperStatus::Enabled
        );
        let ok = flush_dns_verdict(resolved, privileged_ok, helper_enabled);

        let mut detail = String::new();
        if privileged_ok {
            detail.push_str("已通过特权助手刷新（dscacheutil + mDNSResponder）");
        } else {
            detail.push_str("特权刷新失败");
            if local_error.is_some() {
                detail.push_str("，本机命令也失败");
            } else {
                detail.push_str("，已退回本机命令");
            }
            if helper_enabled {
                detail.push_str("；后台助手可能版本过旧，重启 Veyl 或重装后台助手后再试");
            } else {
                detail.push_str("；后台助手不可用，无法通知 mDNSResponder");
            }
        }
        if resolved {
            detail.push_str("，探针域名可解析");
        } else {
            detail.push_str("，探针域名仍无法解析");
        }
        match suspicious {
            Ok(servers) if servers.is_empty() => {}
            Ok(servers) => detail.push_str(&format!(
                "；检测到指向本机的解析器：{}（若为自建 DNS 可忽略）",
                servers.join("、")
            )),
            Err(error) => detail.push_str(&format!("；无法读取解析器列表：{error}")),
        }
        reset_step("flush_dns", ok, detail)
    }

    fn reset_clear_plaintext(&self) -> Value {
        // 删除失败必须让这一步变红：报 ok 却把明文留在磁盘上更糟。
        match self.clear_plaintext_action() {
            Ok((removed, active_removed, pid_removed)) => reset_step(
                "clear_plaintext",
                true,
                format!(
                    "已清理 {removed} 个明文配置{}，{}",
                    if active_removed { "、active.json" } else { "" },
                    if pid_removed {
                        "运行记录已删除"
                    } else {
                        "没有残留的运行记录"
                    }
                ),
            ),
            Err(error) => reset_step("clear_plaintext", false, error),
        }
    }

    async fn reset_verify(
        &self,
        applied: Option<&crate::proxy::ProxyEndpoint>,
        plan_port: Option<u16>,
    ) -> (Value, Option<String>) {
        let mut problems: Vec<String> = Vec::new();

        // 1. 没有 TUN 接口。地址按平台取（`tun::TUN_ADDRESS`）：
        // macOS 172.19.0.1/30，Windows 198.18.0.1/15，这里不写死。
        // 读不到接口时判 unknown 并让这一步变红，不能因为「空」就通过。
        match tokio::task::spawn_blocking(crate::tun::try_collect).await {
            Ok(Ok(addrs)) => {
                if let Some(name) = crate::tun::device_name(&addrs) {
                    problems.push(format!(
                        "仍有 TUN 接口 {name}（{}）",
                        crate::tun::TUN_ADDRESS
                    ));
                }
            }
            Ok(Err(error)) => problems.push(format!("无法读取接口列表，TUN 状态未知：{error}")),
            Err(error) => problems.push(format!("无法读取接口列表，TUN 状态未知：{error}")),
        }

        // 2. 默认路由不在 utun 上
        match crate::netcfg::read() {
            Ok(config) => {
                if let Some(iface) = config.route.default_interface.as_deref() {
                    if iface.starts_with("utun") {
                        problems.push(format!("默认路由仍指向 {iface}"));
                    }
                }
            }
            Err(error) => problems.push(format!("无法读取路由表：{error}")),
        }

        // 3. 系统代理不指向 Veyl
        let mut proxy_ok = true;
        if let Some(endpoint) = applied {
            proxy_ok = self
                .proxy
                .endpoint_in_use(endpoint)
                .map(|in_use| in_use.is_empty())
                .unwrap_or(false);
        }
        if let Some(port) = plan_port {
            let ours = format!("127.0.0.1:{port}");
            if self.proxy.current_endpoint().ok().flatten().as_deref() == Some(ours.as_str()) {
                proxy_ok = false;
            }
        }
        if !proxy_ok {
            problems.push("系统代理仍指向 Veyl".into());
        }

        // 4. 没有 Veyl 的 sing-box
        match self.our_sing_box_processes().await {
            Ok(found) if found.is_empty() => {}
            Ok(found) => problems.push(format!(
                "仍有 Veyl 的 sing-box 进程：{}",
                found
                    .iter()
                    .map(|(pid, _, _)| pid.to_string())
                    .collect::<Vec<_>>()
                    .join("、")
            )),
            Err(error) => problems.push(error),
        }

        // 5. 直连出口
        let exit_ip =
            match crate::runtime::DirectIpProbe::new(crate::runtime::DEFAULT_DIRECT_IP_PROBE) {
                Ok(probe) => probe.check().await.ok().flatten(),
                Err(_) => None,
            };
        if exit_ip.is_none() {
            // 探测失败与真的离线在这里分不出来，措辞如实说「无法确认」，
            // 不能因为前面几步成功就把这一项算通过。
            problems.push("直连 IP 探测失败或当前离线，无法确认已恢复直连".into());
        }

        // 6. 用户视角：系统解析器真的能给地址。
        // 进程、路由、代理都干净但 DNS 坏掉时，用户一样上不了网——
        // 这正是上次「ok=true 但断网」的形态。
        match probe_dns(
            crate::netcfg::DNS_PROBE_DOMAIN,
            std::time::Duration::from_secs(3),
        )
        .await
        {
            Ok(addresses) => {
                log::info!("强制重置 DNS 探测通过（{} 个地址）", addresses.len());
            }
            Err(error) => problems.push(format!("探针域名无法解析：{error}")),
        }

        // 7. 用户视角：真发一次 HTTPS 请求。失败**不判重置失败**——
        //    DNS 与出口 IP 都正常时，单个站点失败更可能是站点或线路问题；
        //    只在 detail 里作为「部分完成」提示，避免误报整体失败。
        let https_warning =
            match probe_https(&DIRECT_PROBE_URLS, std::time::Duration::from_secs(5)).await {
                Ok((url, status)) => {
                    log::info!("强制重置 HTTPS 探测通过：{url} 返回 {status}");
                    None
                }
                Err(error) => {
                    log::warn!("强制重置 HTTPS 探测失败：{error}");
                    Some(error)
                }
            };

        let ok = problems.is_empty();
        let detail = if ok {
            match (&exit_ip, &https_warning) {
                (Some(ip), None) => format!("DNS、HTTPS 与直连出口均正常，出口 IP {ip}"),
                (None, None) => "DNS、HTTPS 与直连出口均正常".to_string(),
                (Some(ip), Some(error)) => format!(
                    "基础网络已恢复（出口 IP {ip}），但 HTTPS 探测未通过（{error}），可能是目标站点或线路问题"
                ),
                (None, Some(error)) => format!(
                    "基础网络已恢复，但 HTTPS 探测未通过（{error}），可能是目标站点或线路问题"
                ),
            }
        } else {
            problems.join("；")
        };
        (reset_step("verify", ok, detail), exit_ip)
    }

    async fn repair_set_proxy(&self, port: Option<u16>) -> anyhow::Result<Value> {
        let Some(port) = port else {
            return Err(svc_error(
                "INVALID_ARGUMENT",
                "set_proxy 需要 port（reason=port_required）",
            ));
        };
        let Some(plan) = self.manager.current_plan().await else {
            return Err(svc_error(
                "INVALID_ARGUMENT",
                "当前没有运行中的配置（reason=port_not_owned）",
            ));
        };
        let state = self.manager.status().await.state;
        if plan.mixed_port != port
            || !matches!(
                state,
                crate::runtime::RuntimeState::Running | crate::runtime::RuntimeState::Degraded
            )
        {
            return Err(svc_error(
                "INVALID_ARGUMENT",
                "端口不属于当前运行时（reason=port_not_owned）",
            ));
        }
        if let Err(error) = self.proxy.enable(port) {
            return Err(svc_error("INTERNAL", format!("设置系统代理失败：{error}")));
        }
        self.manager.set_system_proxy_enabled(true).await;
        let expected = format!("127.0.0.1:{port}");
        let verified =
            self.proxy.current_endpoint().ok().flatten().as_deref() == Some(expected.as_str());
        Ok(json!({
            "ok": verified,
            "action": "set_proxy",
            "detail": if verified { "系统代理已指向 Veyl" } else { "系统代理未能生效" },
            "exit_ip": Value::Null,
            "verified": verified,
        }))
    }

    async fn repair_clear_proxy(&self, port: Option<u16>) -> anyhow::Result<Value> {
        if port.is_some() {
            return Err(svc_error("INVALID_ARGUMENT", "clear_proxy 不接受 port"));
        }
        let applied = self.proxy.applied_endpoint().ok().flatten();
        let mut verified = self.proxy.disable().is_ok();
        if let Some(endpoint) = applied {
            verified = verified
                && self
                    .proxy
                    .endpoint_in_use(&endpoint)
                    .map(|in_use| in_use.is_empty())
                    .unwrap_or(false);
        }
        Ok(json!({
            "ok": verified,
            "action": "clear_proxy",
            "detail": if verified { "系统代理已撤销" } else { "系统代理未能完全撤销，请重试" },
            "exit_ip": Value::Null,
            "verified": verified,
        }))
    }

    /// 启动时的崩溃恢复：有残留代理备份就恢复并清掉。
    pub fn recover_after_crash(&self) -> anyhow::Result<RecoveryOutcome> {
        self.proxy
            .recover_stale()
            .map_err(|e| svc_error("INTERNAL", e))
    }
}

#[cfg(test)]
mod registration_gate_tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;
    use std::time::Duration;

    #[tokio::test]
    async fn concurrent_callers_register_only_once() {
        let gate = Arc::new(RegistrationGate::new());
        let calls = Arc::new(AtomicUsize::new(0));

        let mut handles = Vec::new();
        for _ in 0..8 {
            let gate = Arc::clone(&gate);
            let calls = Arc::clone(&calls);
            handles.push(tokio::spawn(async move {
                gate.ensure(|| async {
                    calls.fetch_add(1, Ordering::SeqCst);
                    tokio::time::sleep(Duration::from_millis(50)).await;
                    Ok::<(), String>(())
                })
                .await
            }));
        }
        for handle in handles {
            handle.await.unwrap().unwrap();
        }

        assert_eq!(calls.load(Ordering::SeqCst), 1, "并发只应注册一次");
        assert!(gate.is_ready());
    }

    #[tokio::test]
    async fn a_failed_registration_leaves_the_gate_open_for_retry() {
        let gate = RegistrationGate::new();
        let attempts = AtomicUsize::new(0);

        let first = gate
            .ensure(|| async {
                attempts.fetch_add(1, Ordering::SeqCst);
                Err::<(), String>("boom".into())
            })
            .await;
        assert!(first.is_err());
        assert!(!gate.is_ready());

        let second = gate
            .ensure(|| async {
                attempts.fetch_add(1, Ordering::SeqCst);
                Ok::<(), String>(())
            })
            .await;
        assert!(second.is_ok());
        assert_eq!(attempts.load(Ordering::SeqCst), 2);
        assert!(gate.is_ready());
    }

    #[tokio::test]
    async fn reset_allows_registering_again() {
        let gate = RegistrationGate::new();
        gate.ensure(|| async { Ok::<(), String>(()) })
            .await
            .unwrap();
        gate.reset();
        assert!(!gate.is_ready());
    }
}

#[cfg(test)]
mod connect_guard_tests {
    use super::*;
    use crate::runtime::RuntimeState;

    #[test]
    fn only_running_counts_as_connected() {
        assert!(require_running_state(RuntimeState::Running).is_ok());

        for state in [
            RuntimeState::Idle,
            RuntimeState::Starting,
            RuntimeState::Stopping,
            RuntimeState::Failed,
        ] {
            let error = require_running_state(state).unwrap_err();
            assert!(
                error.to_string().contains("未进入 running"),
                "{state:?} 必须被拒绝：{error}"
            );
        }
    }
}

#[cfg(test)]
mod config_service_tests {
    use super::*;
    use crate::proxy::backup::MemoryBackupStore;
    use std::path::Path;

    fn services(dir: &Path) -> WiredServices {
        let store = Arc::new(Store::open_in_memory().unwrap());
        let manager = crate::runtime::RuntimeManager::new(crate::runtime::RuntimeConfig::new(dir));
        let proxy = Arc::new(crate::proxy::ProxyController::new(Box::new(
            MemoryBackupStore::new(),
        )));
        let catalog = Arc::new(CatalogClient::new("http://127.0.0.1:9/v1"));
        WiredServices::new(store, manager, proxy, catalog, dir)
    }

    fn temp_dir() -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("veyl-svc-{:016x}", rand::random::<u64>()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn create_input(name: &str) -> ConfigCreateInput {
        ConfigCreateInput {
            name: name.into(),
            connect_mode: configs::CONNECTION_SYSTEM_PROXY.into(),
            routing_mode: configs::ROUTING_PROXY_ALL.into(),
            source: None,
            node_ids: None,
            targets: None,
            listen_port: Some(7890),
            dns: None,
            tun_excludes: None,
        }
    }

    #[tokio::test]
    async fn config_list_is_summary_only_and_detail_has_the_nodes() {
        crate::test_support::install_test_secrets();
        let dir = temp_dir();
        let services = services(&dir);

        let created = services
            .config_create(create_input("家里 · 本机代理"))
            .await
            .unwrap();
        let config_id = created["config_id"].as_str().unwrap().to_string();

        services
            .node_create(NodeCreateInput {
                config_id: Some(config_id.clone()),
                name: "东京".into(),
                server: "203.0.113.10".into(),
                port: 8388,
                password: "pw-secret".into(), // secret-scan:allow 测试夹具口令
                method: "aes-256-gcm".into(),
            })
            .await
            .unwrap();

        let list = services.config_list().await.unwrap();
        let summary = &list["configs"][0];
        assert_eq!(summary["config_id"], config_id);
        assert_eq!(summary["node_count"], 1);
        assert!(summary.get("nodes").is_none(), "列表不返回节点明细");
        assert_eq!(summary["connect_mode"], configs::CONNECTION_SYSTEM_PROXY);
        assert_eq!(summary["routing_mode"], configs::ROUTING_PROXY_ALL);
        let text = list.to_string();
        assert!(!text.contains("pw-secret"), "{text}");

        let detail = services.config_detail(&config_id).await.unwrap();
        assert_eq!(detail["nodes"][0]["server"], "203.0.113.10");
        assert_eq!(detail["nodes"][0]["protocol"], "shadowsocks");
        assert!(detail["current_node_id"].is_string());
        assert!(detail.get("layout").is_some(), "layout 键恒存在");
        assert!(!detail.to_string().contains("pw-secret"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn changing_connect_mode_is_rejected_as_invalid_argument() {
        let dir = temp_dir();
        let services = services(&dir);
        let created = services.config_create(create_input("A")).await.unwrap();
        let id = created["config_id"].as_str().unwrap();
        let error = services
            .config_update(
                id,
                ConfigUpdateInput {
                    connect_mode: Some(configs::CONNECTION_TUN.into()),
                    ..Default::default()
                },
            )
            .await
            .unwrap_err();
        let service = error.downcast_ref::<ServiceError>().unwrap();
        assert_eq!(service.code, "INVALID_ARGUMENT");
        assert_eq!(
            service.details.as_ref().unwrap()["reason"],
            "connect_mode_immutable"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn deleting_a_config_keeps_shared_nodes_and_credentials() {
        crate::test_support::install_test_secrets();
        let dir = temp_dir();
        let services = services(&dir);
        let created = services.config_create(create_input("A")).await.unwrap();
        let config_id = created["config_id"].as_str().unwrap().to_string();
        services
            .node_create(NodeCreateInput {
                config_id: Some(config_id.clone()),
                name: "东京".into(),
                server: "198.51.100.7".into(),
                port: 8388,
                password: "pw".into(),
                method: "aes-256-gcm".into(),
            })
            .await
            .unwrap();

        let node_id = {
            let conn = services.store.conn();
            configs::list_nodes(&conn, &config_id).unwrap()[0]
                .id
                .clone()
        };
        let password_ref = crate::nodes::password_ref(&node_id);
        assert!(crate::secrets::get_secret(&password_ref).unwrap().is_some());

        services.config_delete(&config_id).await.unwrap();

        // 节点是共享池：删配置只删关系，不删节点与密码。
        let conn = services.store.conn();
        assert!(configs::get_node(&conn, &node_id).unwrap().is_some());
        drop(conn);
        assert!(crate::secrets::get_secret(&password_ref).unwrap().is_some());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn listen_port_can_go_back_to_auto() {
        let dir = temp_dir();
        let services = services(&dir);
        let created = services.config_create(create_input("A")).await.unwrap();
        let id = created["config_id"].as_str().unwrap();
        assert_eq!(created["listen_port"], 7890);

        let updated = services
            .config_update(
                id,
                ConfigUpdateInput {
                    listen_port: Some(None),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        assert!(updated["listen_port"].is_null(), "传 null 表示改回自动");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn route_set_mode_without_connection_persists() {
        let dir = temp_dir();
        let services = services(&dir);
        let created = services.config_create(create_input("A")).await.unwrap();
        let config_id = created["config_id"].as_str().unwrap().to_string();

        let routed = services
            .route_set_mode(Some(config_id.clone()), configs::ROUTING_DIRECT, false)
            .await
            .unwrap();
        assert_eq!(routed["routing_mode"], configs::ROUTING_DIRECT);
        assert_eq!(routed["hot_switched"], false);
        assert_eq!(routed["reconnect"], "not_running");
        assert_eq!(routed["effective"], "next_connection");

        let detail = services.config_detail(&config_id).await.unwrap();
        assert_eq!(detail["routing_mode"], configs::ROUTING_DIRECT);

        let route = services.route_get(Some(config_id)).await.unwrap();
        assert_eq!(route["routing_mode"], configs::ROUTING_DIRECT);
        assert!(route["applied_mode"].is_null());
        assert_eq!(route["reconnect_required"], true);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn proxy_selected_without_targets_is_rejected() {
        let dir = temp_dir();
        let services = services(&dir);
        let created = services.config_create(create_input("A")).await.unwrap();
        let config_id = created["config_id"].as_str().unwrap().to_string();
        let error = services
            .route_set_mode(Some(config_id), configs::ROUTING_PROXY_SELECTED, false)
            .await
            .unwrap_err();
        let service = error.downcast_ref::<ServiceError>().unwrap();
        assert_eq!(service.code, "PRECONDITION_FAILED");
        assert_eq!(
            service.details.as_ref().unwrap()["reason"],
            "route_targets_empty"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn node_switch_updates_selection_without_starting_vpn() {
        crate::test_support::install_test_secrets();
        let dir = temp_dir();
        let services = services(&dir);
        let created = services.config_create(create_input("A")).await.unwrap();
        let config_id = created["config_id"].as_str().unwrap().to_string();
        let node = services
            .node_create(NodeCreateInput {
                config_id: Some(config_id.clone()),
                name: "东京".into(),
                server: "203.0.113.10".into(),
                port: 8388,
                password: "pw".into(),
                method: "aes-256-gcm".into(),
            })
            .await
            .unwrap();
        let node_id = node["node_id"].as_str().unwrap().to_string();

        let switched = services.node_switch(&config_id, &node_id).await.unwrap();
        assert_eq!(switched["connected"], false);
        assert!(switched["runtime"].is_null());

        let detail = services.config_detail(&config_id).await.unwrap();
        assert_eq!(detail["current_node_id"], node_id);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn node_probe_without_connection_falls_back_to_tcp() {
        crate::test_support::install_test_secrets();
        let dir = temp_dir();
        let services = services(&dir);
        let created = services.config_create(create_input("A")).await.unwrap();
        let config_id = created["config_id"].as_str().unwrap().to_string();
        // 127.0.0.1:9 通常立即拒绝，测试不会等 3 秒。
        let node = services
            .node_create(NodeCreateInput {
                config_id: Some(config_id.clone()),
                name: "本机".into(),
                server: "127.0.0.1".into(),
                port: 9,
                password: "pw".into(),
                method: "aes-256-gcm".into(),
            })
            .await
            .unwrap();
        let node_id = node["node_id"].as_str().unwrap().to_string();

        let probe = services.node_probe(&node_id).await.unwrap();
        assert_eq!(probe["reachable"], false);
        assert_eq!(probe["probe_method"], "tcp");
        assert_eq!(probe["error"]["code"], "TCP_CONNECT_FAILED");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn node_switch_rejects_a_node_outside_the_config() {
        let dir = temp_dir();
        let services = services(&dir);
        let created = services.config_create(create_input("A")).await.unwrap();
        let config_id = created["config_id"].as_str().unwrap();
        let error = services
            .node_switch(config_id, "nod_missing")
            .await
            .unwrap_err();
        let service = error.downcast_ref::<ServiceError>().unwrap();
        assert_eq!(service.code, "NOT_FOUND");
        assert_eq!(
            service.details.as_ref().unwrap()["reason"],
            "node_not_in_config"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn proxy_selected_requires_targets() {
        let dir = temp_dir();
        let services = services(&dir);
        let mut input = create_input("A");
        input.routing_mode = configs::ROUTING_PROXY_SELECTED.into();
        let error = services.config_create(input).await.unwrap_err();
        let service = error.downcast_ref::<ServiceError>().unwrap();
        assert_eq!(service.code, "PRECONDITION_FAILED");
        assert_eq!(
            service.details.as_ref().unwrap()["reason"],
            "route_targets_empty"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn tun_rejects_a_listen_port() {
        let dir = temp_dir();
        let services = services(&dir);
        let mut input = create_input("A");
        input.connect_mode = configs::CONNECTION_TUN.into();
        input.listen_port = Some(7890);
        let error = services.config_create(input).await.unwrap_err();
        let service = error.downcast_ref::<ServiceError>().unwrap();
        assert_eq!(
            service.details.as_ref().unwrap()["reason"],
            "listen_port_not_allowed"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn missing_node_ids_are_reported_together() {
        let dir = temp_dir();
        let services = services(&dir);
        let mut input = create_input("A");
        input.node_ids = Some(vec!["nod_missing1".into(), "nod_missing2".into()]);
        let error = services.config_create(input).await.unwrap_err();
        let service = error.downcast_ref::<ServiceError>().unwrap();
        assert_eq!(service.code, "NOT_FOUND");
        assert_eq!(
            service.details.as_ref().unwrap()["node_ids"]
                .as_array()
                .unwrap()
                .len(),
            2
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 失败原因来自运行时日志的末尾：只取最后几行，密钥打码，其余原样保留。
    #[test]
    fn the_runtime_log_tail_is_read_from_the_end_and_masked() {
        let dir = temp_dir();
        let path = dir.join("runtime-test.log");
        let mut text = String::new();
        for index in 0..50 {
            text.push_str(&format!("line {index}\n"));
        }
        text.push_str("FATAL start service: start dns/udp[dns-local-1]: detour makes no sense\n");
        text.push_str("password sk-abcdefghijklmnopqrstuvwxyz\n"); // check-secrets:allow 测试假值
        std::fs::write(&path, text).unwrap();

        let tail = read_log_tail(&path, 5).expect("日志存在就应该读到");
        assert!(tail.contains("FATAL start service"), "{tail}");
        assert!(!tail.contains("line 0"), "只要末尾，不要整个文件：{tail}");
        assert!(
            !tail.contains("sk-abcdefghijklmnopqrstuvwxyz"), // check-secrets:allow 测试假值
            "像密钥的片段必须打码：{tail}"
        );
        assert!(tail.contains("***"), "{tail}");

        assert!(read_log_tail(&dir.join("missing.log"), 5).is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 轮转之后，失败原因仍然读得出来——这就是「保留尾部」而不是整体移走的原因。
    #[test]
    fn a_rotated_runtime_log_still_yields_its_tail() {
        let dir = temp_dir();
        let path = dir.join("runtime-1.14.4.log");
        let mut text = String::new();
        for index in 0..400_000 {
            text.push_str(&format!("line {index} padding\n"));
        }
        text.push_str("FATAL start service: start dns/udp[dns-local-1]: detour makes no sense\n");
        std::fs::write(&path, text).unwrap();

        assert!(crate::runtime::process::rotate_if_oversized(&path).unwrap());
        let tail = read_log_tail(&path, 20).expect("轮转后仍然要读得到");
        assert!(tail.contains("FATAL start service"), "{tail}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// TUN 在跑的时候删配置：数据库删了、helper 里的 sing-box 还在接管，界面停不掉。
    #[tokio::test]
    async fn a_config_in_use_by_a_running_tun_connection_cannot_be_deleted() {
        let dir = temp_dir();
        let services = services(&dir);
        let created = services.config_create(create_input("A")).await.unwrap();
        let config_id = created["config_id"].as_str().unwrap().to_string();

        services.tun.force_running_for_test(4242, Some(&config_id));
        let error = services.config_delete(&config_id).await.unwrap_err();
        assert!(
            error.to_string().contains("正在连接中"),
            "TUN 正在用这套配置，必须拒绝删除：{error}"
        );

        // 连的是别的配置时不影响：不能因为「TUN 在跑」就什么都删不了。
        services.tun.force_running_for_test(4242, Some("cfg_other"));
        assert!(
            services.config_delete(&config_id).await.is_ok(),
            "TUN 用的是另一套配置，这套可以删"
        );
    }

    /// App 重启后接手的 TUN 连接没有配置 id：不知道是哪套，一律拒绝。
    #[tokio::test]
    async fn a_tun_connection_without_a_known_config_blocks_deletion() {
        let dir = temp_dir();
        let services = services(&dir);
        let created = services.config_create(create_input("A")).await.unwrap();
        let config_id = created["config_id"].as_str().unwrap().to_string();

        services.tun.force_running_for_test(4343, None);
        let error = services.config_delete(&config_id).await.unwrap_err();
        assert!(
            error.to_string().contains("读不到它用的是哪套配置"),
            "{error}"
        );
    }

    /// TUN 下流量与连接数采不到：字段必须在、值必须是 null，
    /// 不能缺字段（前端会读到 undefined），更不能是 0（看起来像「没走流量」）。
    #[tokio::test]
    async fn a_tun_connection_reports_traffic_and_connections_as_null() {
        let dir = temp_dir();
        let services = services(&dir);
        services.tun.force_running_for_test(5151, Some("cfg_tun"));

        let status = services.runtime_status().await.unwrap();
        assert_eq!(status["mode"], "tun");
        assert!(
            status.get("traffic").is_some(),
            "字段不能缺，缺了前端拿到的是 undefined"
        );
        assert!(status["traffic"].is_null(), "没有数据必须是 null");
        assert!(status["connections"].is_null(), "没有数据必须是 null");
    }

    /// 未连接时也要报可用的运行时版本与来源：
    /// 不能因为进程没在跑，就把已经装好的随包运行时说成「未安装」。
    #[tokio::test]
    async fn an_idle_snapshot_reports_the_available_bundled_runtime() {
        let dir = temp_dir();
        let version = "1.14.4";
        let runtime_dir = dir.join("runtime").join(version);
        std::fs::create_dir_all(&runtime_dir).unwrap();
        let binary = runtime_dir.join(crate::runtime::BINARY_NAME);
        std::fs::write(&binary, b"#!/bin/sh\nexit 0\n").unwrap();
        let state = json!({
            "schema": 1,
            "active_version": version,
            "installs": {
                (version): {
                    "version": version,
                    "dir": runtime_dir,
                    "binary": binary,
                    "license": null,
                    "sha256": "00",
                    "installed_at": 0,
                    "source": crate::runtime::SOURCE_BUNDLED,
                }
            }
        });
        std::fs::write(
            dir.join("runtime-state.json"),
            serde_json::to_vec(&state).unwrap(),
        )
        .unwrap();

        let services = services(&dir);
        let status = services.runtime_status().await.unwrap();
        assert_eq!(status["state"], "idle");
        assert_eq!(status["upstream_version"], version);
        assert_eq!(status["runtime_source"], crate::runtime::SOURCE_BUNDLED);
    }

    /// TUN 快照必须和代理模式同形状。
    /// 少一个顶层键（尤其是 `health`）前端会读到 `undefined` 并直接崩，
    /// 而 helper 在 App 崩溃后仍存活、重启后接手 TUN 正是我们要支持的场景。
    #[tokio::test]
    async fn a_tun_snapshot_has_every_key_the_proxy_snapshot_has() {
        let dir = temp_dir();
        let services = services(&dir);
        services.tun.force_running_for_test(6161, Some("cfg_tun"));

        let tun = services.runtime_status().await.unwrap();
        let proxy = NotWiredServices.runtime_status().await.unwrap();

        let keys = |value: &Value| {
            let mut keys: Vec<String> = value
                .as_object()
                .expect("快照必须是对象")
                .keys()
                .cloned()
                .collect();
            keys.sort();
            keys
        };
        assert_eq!(
            keys(&tun),
            keys(&proxy),
            "TUN 快照的顶层键必须和代理模式完全一致"
        );

        assert_eq!(tun["mode"], "tun");
        assert!(tun["health"].is_object(), "health 必须是结构合法的对象");
        assert_eq!(tun["health"]["process"], true, "TUN 进程确实在跑");
        assert_eq!(
            tun["health"]["clash_api"], false,
            "拿不到 Clash API 就如实 false，不假装探测过"
        );
        assert!(tun["traffic"].is_null());
        assert!(tun["connections"].is_null());
        assert!(tun["latency_ms"].is_null());
    }
}

/// 主流程：新建配置（带一个节点）→ 激活 → 连接 → 查询状态 → 断开。
///
/// 只测主流程，异常分支不在这里。目标是把整条链路真的走一遍：
/// 节点落库 → 渲染 sing-box 配置 → 起进程 → Clash API 就绪 → 设系统代理
/// → 断开 → 撤代理 → 回收进程。
///
/// **降级说明（重要，别把它当成真的测了）**：
/// 仓库里没有可提交的 sing-box 二进制（`resources/runtime/*` 是 gitignore 的），
/// 所以这里用 `/bin/sh` 脚本冒充内核：`check` 直接退 0，`run` 变成 `sleep`。
/// 因此下面这些是**真跑的**：配置文件真的被渲染并落盘、进程真的被 spawn 并被回收、
/// 系统代理真的被调用（走假 backend）、端口真的被挑出来并被监听。
/// 而「sing-box 会不会接受这份配置」「mixed 端口上是不是 sing-box 在服务」
/// 这两件事**没有验证**——那需要真实二进制，属于 `tests/generated_config_check.rs` 的职责。
#[cfg(test)]
mod main_flow_tests {
    use super::*;
    use crate::proxy::backup::MemoryBackupStore;
    use crate::proxy::PlatformProxy;
    use crate::runtime::{RuntimeConfig, RuntimeManager, RuntimeResult};
    use serde_json::{json, Value};
    use std::path::{Path, PathBuf};
    use std::sync::{Arc, Mutex};

    // ---------- 记录型系统代理后端 ----------

    #[derive(Default)]
    struct ProxyCalls {
        applied: Vec<u16>,
        restored: usize,
    }

    struct RecordingProxy {
        calls: Arc<Mutex<ProxyCalls>>,
    }

    impl PlatformProxy for RecordingProxy {
        fn platform(&self) -> &'static str {
            "test"
        }

        fn capture(&self) -> RuntimeResult<Value> {
            Ok(json!({ "services": [] }))
        }

        fn apply(&self, port: u16) -> RuntimeResult<()> {
            self.calls.lock().unwrap().applied.push(port);
            Ok(())
        }

        fn restore(&self, _payload: &Value) -> RuntimeResult<()> {
            self.calls.lock().unwrap().restored += 1;
            Ok(())
        }

        fn current(&self) -> RuntimeResult<Option<String>> {
            Ok(None)
        }
    }

    // ---------- 假运行时 ----------

    /// 写一个冒充 sing-box 的脚本，并把它登记成「已安装且 active」。
    ///
    /// 用 `/bin/sh` 而不是现写复杂脚本：`check` 立即退 0，`run` 直接 exec 成
    /// `sleep`，不额外 fork 一层，负载下也不会卡住。
    fn install_fake_runtime(dir: &Path) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;

        let runtime_dir = dir.join("runtime").join("test");
        std::fs::create_dir_all(&runtime_dir).unwrap();
        let binary = runtime_dir.join("sing-box");
        std::fs::write(
            &binary,
            "#!/bin/sh\nif [ \"$1\" = check ]; then exit 0; fi\nexec sleep 120\n",
        )
        .unwrap();
        std::fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o755)).unwrap();

        let state = json!({
            "schema": 1,
            "active_version": "test",
            "installs": {
                "test": {
                    "version": "test",
                    "dir": runtime_dir,
                    "binary": binary,
                    "license": Value::Null,
                    "sha256": "test",
                    "installed_at": crate::store::now_ms(),
                }
            }
        });
        std::fs::write(
            dir.join(crate::runtime::install::STATE_FILE),
            serde_json::to_vec_pretty(&state).unwrap(),
        )
        .unwrap();
        binary
    }

    // ---------- 端口监听：冒充运行时把端口占住 ----------

    /// 盯着渲染出来的配置，读到端口后把 mixed 与 clash 两个端口占上。
    ///
    /// 用**普通线程 + 阻塞 socket**，不用 tokio：在这台机器上 tokio 的 socket
    /// 轮询和 reqwest 的系统代理探测一起会把进程带进 `_xpc_api_misuse`（SIGTRAP），
    /// 与要测的连接逻辑无关。阻塞实现更笨，但不会干扰被测代码。
    fn spawn_port_watcher(data_dir: PathBuf) -> std::thread::JoinHandle<()> {
        std::thread::spawn(move || {
            let config_dir = data_dir.join("config");
            loop {
                if let Ok(entries) = std::fs::read_dir(&config_dir) {
                    for entry in entries.flatten() {
                        let path = entry.path();
                        let name = entry.file_name().to_string_lossy().to_string();
                        if !name.starts_with("profile-") || !name.ends_with(".json") {
                            continue;
                        }
                        let Ok(text) = std::fs::read_to_string(&path) else {
                            continue;
                        };
                        let Ok(value) = serde_json::from_str::<Value>(&text) else {
                            continue;
                        };
                        let Some(mixed) = value
                            .pointer("/inbounds/0/listen_port")
                            .and_then(Value::as_u64)
                        else {
                            continue;
                        };
                        let Some(clash_port) = value
                            .pointer("/experimental/clash_api/external_controller")
                            .and_then(Value::as_str)
                            .and_then(|addr| addr.rsplit(':').next())
                            .and_then(|port| port.parse::<u16>().ok())
                        else {
                            continue;
                        };

                        let Ok(clash_listener) =
                            std::net::TcpListener::bind(("127.0.0.1", clash_port))
                        else {
                            continue;
                        };
                        let Ok(mixed_listener) =
                            std::net::TcpListener::bind(("127.0.0.1", mixed as u16))
                        else {
                            continue;
                        };

                        // mixed：只要「有人能连上」就够了，假的 sing-box 不转发。
                        std::thread::spawn(move || {
                            for socket in mixed_listener.incoming() {
                                drop(socket);
                            }
                        });
                        serve_clash(clash_listener);
                        return;
                    }
                }
                std::thread::sleep(std::time::Duration::from_millis(10));
            }
        })
    }

    /// 只回 `/version` 的假 Clash API，让 manager 认为运行时已就绪。
    fn serve_clash(listener: std::net::TcpListener) {
        use std::io::{Read, Write};
        for socket in listener.incoming() {
            let Ok(mut socket) = socket else { return };
            let mut buf = [0u8; 2048];
            let _ = socket.read(&mut buf);
            let body = r#"{"version":"test","meta":false,"premium":false}"#;
            let head = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            );
            let _ = socket.write_all(head.as_bytes());
            let _ = socket.write_all(body.as_bytes());
        }
    }

    // ---------- 组装 ----------

    struct Harness {
        services: WiredServices,
        proxy_calls: Arc<Mutex<ProxyCalls>>,
        dir: PathBuf,
    }

    impl Drop for Harness {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    fn harness() -> Harness {
        crate::test_support::install_test_secrets();

        let dir =
            std::env::temp_dir().join(format!("veyl-main-flow-{:016x}", rand::random::<u64>()));
        std::fs::create_dir_all(&dir).unwrap();

        let store = Store::open_in_memory().unwrap();
        // 规则数据是连接的前置条件（`rules_not_ready` 会直接挡住 connect）。
        // 用随包归档离线安装，和 App 首次启动走同一条路径。
        crate::rules::install_bundled(&store, &dir, None).expect("随包规则归档应当可用");
        install_fake_runtime(&dir);

        let proxy_calls = Arc::new(Mutex::new(ProxyCalls::default()));
        let backend: &'static dyn PlatformProxy = Box::leak(Box::new(RecordingProxy {
            calls: Arc::clone(&proxy_calls),
        }));
        let proxy = Arc::new(crate::proxy::ProxyController::with_backend(
            Box::new(MemoryBackupStore::new()),
            backend,
        ));

        let store = Arc::new(store);
        let mut cfg = RuntimeConfig::new(&dir);
        // 关掉三个外网探测：它们要出网，测试环境里既慢又没意义，
        // 而且 reqwest 的系统代理自动探测在这台机器上会触发 XPC 误用（SIGTRAP）。
        // 连接生命周期本身不依赖它们。
        cfg.data_plane_probe = None;
        cfg.exit_ip_probe = None;
        cfg.direct_ip_probe = None;
        let manager = RuntimeManager::new(cfg);
        let catalog = Arc::new(CatalogClient::new("http://127.0.0.1:9/v1"));
        let mut services = WiredServices::new(store, manager, proxy, catalog, &dir);
        // 假运行时是 shell 脚本，不可能通过代码签名校验。
        services.allow_unsigned_runtime();

        Harness {
            services,
            proxy_calls,
            dir,
        }
    }

    fn auto_port_input(name: &str) -> ConfigCreateInput {
        ConfigCreateInput {
            name: name.into(),
            connect_mode: configs::CONNECTION_SYSTEM_PROXY.into(),
            routing_mode: configs::ROUTING_PROXY_ALL.into(),
            source: None,
            node_ids: None,
            targets: None,
            // 自动挑端口：这条断言才有意义（写死的端口测不出「状态里的是不是真端口」）。
            listen_port: None,
            dns: None,
            tun_excludes: None,
        }
    }

    #[tokio::test]
    async fn create_activate_connect_status_disconnect() {
        let h = harness();
        let dir = h.dir.clone();
        // 端口监听必须在连接之前起：配置一落盘它就去占 mixed / clash 两个端口。
        let watcher = spawn_port_watcher(dir.clone());

        // ---- 1. 新建配置 + 一个节点 ----
        let created = h
            .services
            .config_create(auto_port_input("主流程"))
            .await
            .unwrap();
        let config_id = created["config_id"].as_str().unwrap().to_string();
        assert!(
            created["listen_port"].is_null(),
            "不指定时应当留给连接时自动挑"
        );

        let node = h
            .services
            .node_create(NodeCreateInput {
                config_id: Some(config_id.clone()),
                name: "东京".into(),
                server: "198.51.100.20".into(),
                port: 8388,
                password: "pw-main-flow".into(), // secret-scan:allow 测试夹具口令
                method: "aes-256-gcm".into(),
            })
            .await
            .unwrap();
        let node_id = node["node_id"].as_str().unwrap().to_string();

        let list = h.services.config_list().await.unwrap();
        let configs = list["configs"].as_array().unwrap();
        assert_eq!(configs.len(), 1, "新建后列表里应当只有这一套");
        assert_eq!(configs[0]["config_id"], config_id.as_str());
        assert_eq!(configs[0]["node_count"], 1);
        assert_eq!(
            configs[0]["current_node_id"],
            node_id.as_str(),
            "唯一节点应当自动成为当前节点"
        );
        // 第一套配置会**自动激活**（还没有别的配置可比）。这里把这条行为钉住，
        // 后面的 `config_activate` 因此测的是「重新激活并重连」而不是「从无到有」。
        assert_eq!(
            list["active_config_id"],
            config_id.as_str(),
            "第一套配置应当自动成为 active"
        );

        // ---- 2. 激活 ----
        // 从「未连接」切过来不会顺带连接：替用户连等于替他做决定。
        // 已经连着的时候才会重连（`reconnect: "reconnected"`）。
        let activated = h.services.config_activate(&config_id, false).await.unwrap();
        assert_eq!(activated["active_config_id"], config_id.as_str());
        assert_eq!(activated["reconnect"], "not_running", "{activated}");
        assert!(activated["runtime"].is_null());

        let list = h.services.config_list().await.unwrap();
        assert_eq!(
            list["active_config_id"],
            config_id.as_str(),
            "激活后 active_config_id 要指向它"
        );
        let actives: Vec<&Value> = list["configs"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|c| c["is_active"] == true)
            .collect();
        assert_eq!(actives.len(), 1, "只能有一个 active");

        // ---- 3. 连接 ----
        let connected = h
            .services
            .runtime_start(Some(config_id.clone()))
            .await
            .unwrap();
        assert_eq!(connected["state"], "running", "{connected}");
        assert!(
            connected.get("node_latency_ms").is_some(),
            "工具结果必须带 node_latency_ms（模型直接读它）"
        );
        assert!(
            connected.get("latency_ms").is_some(),
            "latency_ms 仍是出口探测耗时，异步未测到时为 null"
        );

        // ---- 4. 查询状态 ----
        //
        // **降级**：这里不走 `WiredServices::runtime_status`（命令层），而是直接读
        // `manager.status()`。原因是命令层第一步会调 `TunSession::status()`，
        // 它在内存里没有 pid 时无条件向特权助手发一次 XPC；测试进程里没有那个
        // mach service，`xpc_connection_send_message_with_reply_sync` 会触发
        // `_xpc_api_misuse` 直接 SIGTRAP 把进程打死。这是 `src-tauri/src/tun/` 的问题，
        // 不在本次范围，已单独报给 PM。除这一步外其余断言都是真的。
        let status = serde_json::to_value(h.services.manager.status().await).unwrap();
        assert_eq!(status["state"], "running", "{status}");
        assert_eq!(status["config_id"], config_id.as_str());
        assert_eq!(status["node_id"], node_id.as_str());
        assert_eq!(status["node_name"], "东京");
        assert_eq!(status["mode"], "system_proxy");

        let mixed_port = status["mixed_port"]
            .as_u64()
            .expect("已连接时 mixed_port 必须非空") as u16;

        // 端口必须真的是被监听着的：连一下。
        tokio::net::TcpStream::connect(("127.0.0.1", mixed_port))
            .await
            .unwrap_or_else(|e| panic!("状态里报的 mixed_port {mixed_port} 没人监听：{e}"));

        // 系统代理必须被设过，而且用的是同一个端口（不是配置里随手写的值）。
        {
            let calls = h.proxy_calls.lock().unwrap();
            assert_eq!(
                calls.applied,
                vec![mixed_port],
                "设置系统代理必须只调用一次，且端口与状态一致"
            );
        }
        assert_eq!(status["system_proxy_enabled"], true);

        // ---- 5. 断开 ----
        //
        // **降级**：同样绕开 `WiredServices::runtime_stop`，因为它的第一件事也是
        // `self.tun.stop()` → `TunSession::status()` → 同一个 XPC 陷阱。
        // 这里按 `runtime_stop` 的顺序手工做同样的三步：撤系统代理、清标志、停运行时。
        // 少掉的是「删除明文配置」——那一步在 `runtime_stop` 里，受同一条阻断。
        let pid = status["pid"].as_u64().expect("运行中应有 pid") as u32;
        h.services.restore_system_proxy().unwrap();
        h.services.manager.set_system_proxy_enabled(false).await;
        let stopped = serde_json::to_value(h.services.manager.stop().await.unwrap()).unwrap();
        assert_eq!(stopped["state"], "idle", "{stopped}");
        assert!(stopped["mixed_port"].is_null(), "断开后不应再报端口");
        assert_eq!(stopped["system_proxy_enabled"], false);

        {
            let calls = h.proxy_calls.lock().unwrap();
            assert_eq!(calls.restored, 1, "断开必须撤销一次系统代理");
        }

        // 假运行时进程必须真的被回收，不能留孤儿。
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        assert!(
            !crate::runtime::process::is_alive(pid),
            "断开后运行时进程 {pid} 仍然活着"
        );

        drop(watcher);
    }
}

#[cfg(test)]
mod tun_error_details_tests {
    use super::*;
    use crate::tun::backend::{TunError, TunErrorCode};

    /// 契约 §4.3：`details.reason` 只允许四种。
    #[test]
    fn tun_errors_expose_only_the_four_ui_reasons() {
        let cases = [
            (TunErrorCode::TunDenied, "tun_denied"),
            (TunErrorCode::HelperMissing, "helper_missing"),
            (TunErrorCode::HelperInstallFailed, "helper_missing"),
            (TunErrorCode::ConfigForbidden, "tun_start_failed"),
            (TunErrorCode::Timeout, "tun_start_failed"),
            (TunErrorCode::PeerUnverified, "helper_missing"),
            (TunErrorCode::TransportError, "tun_start_failed"),
            (TunErrorCode::UnsupportedPlatform, "unsupported_platform"),
        ];
        for (code, reason) in cases {
            let details = tun_error_details(&TunError::new(code, "x"));
            assert_eq!(details["reason"], reason, "{}", code.as_str());
            assert!(details.get("wire_code").is_some(), "键必须存在");
            assert!(details.get("local_code").is_some(), "键必须存在");
        }
    }

    /// 契约 §4.4：wire 码与本地码不混用。
    #[test]
    fn wire_and_local_codes_are_kept_apart() {
        let wire = tun_error_details(&TunError::new(TunErrorCode::ConfigForbidden, "x"));
        assert_eq!(wire["wire_code"], "config_forbidden");
        assert!(wire["local_code"].is_null());

        let timeout = tun_error_details(&TunError::new(TunErrorCode::Timeout, "x"));
        assert_eq!(timeout["local_code"], "timeout");
        assert!(timeout["wire_code"].is_null());
        assert_eq!(timeout["reason"], "tun_start_failed");

        // 验收项：PeerUnverified 必须是「权限」而不是普通启动失败。
        let peer = tun_error_details(&TunError::new(TunErrorCode::PeerUnverified, "x"));
        assert_eq!(peer["reason"], "helper_missing");
        assert_eq!(peer["local_code"], "peer_unverified");
        assert!(peer["wire_code"].is_null());
    }

    /// 安装失败不能漏成第五种理由。
    #[test]
    fn install_failures_collapse_to_helper_missing() {
        let error = TunError::new(TunErrorCode::HelperInstallFailed, "x");
        assert_eq!(tun_error_code(&error), "helper_missing");
        assert_eq!(tun_error_details(&error)["reason"], "helper_missing");
    }

    /// 契约 1.0.6：调用竞态下的 helper_missing 带 local_code，
    /// 与 `ensure_available` 的可用性结论区分开。
    #[test]
    fn a_race_helper_missing_keeps_its_local_code() {
        let race = TunError::new(TunErrorCode::HelperMissing, "x")
            .with_detail(json!({ "local_code": "helper_missing" }));
        let details = tun_error_details(&race);
        assert_eq!(details["local_code"], "helper_missing");
        assert_eq!(details["reason"], "helper_missing");
        assert!(details["wire_code"].is_null());
    }

    /// 权限层的 HelperMissing 来自 availability，不是调用竞态，不能带 local_code。
    #[test]
    fn an_availability_helper_missing_has_no_local_code() {
        let availability = TunError::from_privilege(crate::tun::privilege::PrivilegeError::new(
            crate::tun::privilege::ERR_HELPER_MISSING,
            "助手不在",
        ));
        let details = tun_error_details(&availability);
        assert_eq!(details["reason"], "helper_missing");
        assert!(details["local_code"].is_null());
    }
}

#[cfg(test)]
mod force_reset_tests {
    use super::*;
    use crate::proxy::backup::MemoryBackupStore;

    fn services(root: &std::path::Path) -> WiredServices {
        let store = Arc::new(Store::open_in_memory().unwrap());
        let manager = crate::runtime::RuntimeManager::new(crate::runtime::RuntimeConfig::new(root));
        let proxy = Arc::new(crate::proxy::ProxyController::new(Box::new(
            MemoryBackupStore::new(),
        )));
        let catalog = Arc::new(CatalogClient::new("http://127.0.0.1:9/v1"));
        WiredServices::new(store, manager, proxy, catalog, root)
    }

    fn temp_dir() -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("veyl-reset-{:016x}", rand::random::<u64>()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// 契约：每一步只有 id / ok / detail 三个字段。
    #[test]
    fn a_step_has_exactly_the_contract_fields() {
        assert_eq!(
            reset_step("stop_tun", true, "TUN 未在运行"),
            json!({ "id": "stop_tun", "ok": true, "detail": "TUN 未在运行" })
        );
    }

    /// 有备份且端点仍被占用：必须红。
    #[test]
    fn a_still_in_use_endpoint_makes_restore_proxy_red() {
        let facts = ProxyResetFacts {
            applied: Some(crate::proxy::ProxyEndpoint::loopback(2080)),
            in_use: Some(vec!["Wi-Fi".into()]),
            ..Default::default()
        };
        let step = judge_restore_proxy(&facts);
        assert_eq!(step["ok"], false, "{step}");
        assert!(step["detail"].as_str().unwrap().contains("1 个"));
    }

    /// 公司固定代理不是 Veyl 的：不能因为它而报失败，也不能去动它。
    #[test]
    fn a_foreign_system_proxy_is_left_alone_and_not_a_failure() {
        let foreign = ProxyResetFacts {
            current: Some(CurrentProxy::Known(Some("corp-proxy:8080".into()))),
            ..Default::default()
        };
        let step = judge_restore_proxy(&foreign);
        assert_eq!(step["ok"], true, "{step}");
        assert!(step["detail"].as_str().unwrap().contains("不属于 Veyl"));

        // 回环但端口对不上本次连接：可能仍是我们的残留，不能确认。
        let local = ProxyResetFacts {
            current: Some(CurrentProxy::Known(Some("127.0.0.1:7890".into()))),
            ..Default::default()
        };
        let step = judge_restore_proxy(&local);
        assert_eq!(step["ok"], false, "{step}");
        assert!(step["detail"].as_str().unwrap().contains("无法确认"));

        let closed = ProxyResetFacts {
            current: Some(CurrentProxy::Known(None)),
            ..Default::default()
        };
        assert_eq!(judge_restore_proxy(&closed)["ok"], true);

        let unreadable = ProxyResetFacts {
            current: Some(CurrentProxy::Unknown("networksetup 失败".into())),
            ..Default::default()
        };
        assert_eq!(judge_restore_proxy(&unreadable)["ok"], false);
    }

    #[test]
    fn loopback_endpoints_are_recognised() {
        assert!(is_loopback_endpoint("127.0.0.1:7890"));
        assert!(is_loopback_endpoint("localhost:7890"));
        assert!(is_loopback_endpoint("[::1]:7890"));
        assert!(!is_loopback_endpoint("corp-proxy:8080"));
        assert!(!is_loopback_endpoint("10.0.0.1:8080"));
    }

    /// step.detail 是给用户看的，不能带内部错误码。
    #[test]
    fn a_service_error_is_rendered_without_its_internal_code() {
        let error = svc_error("PRECONDITION_FAILED", "撤销系统代理失败：boom");
        let message = user_message(&error);
        assert_eq!(message, "撤销系统代理失败：boom");
        assert!(!message.contains("PRECONDITION_FAILED"));

        let plain = anyhow::anyhow!("plain failure");
        assert_eq!(user_message(&plain), "plain failure");
    }

    /// 没有备份但有本次端口：确认它不在当前设置里就算恢复。
    #[test]
    fn a_known_port_absent_from_the_current_setting_is_confirmed() {
        let facts = ProxyResetFacts {
            plan_port: Some(2080),
            current: Some(CurrentProxy::Known(None)),
            ..Default::default()
        };
        let step = judge_restore_proxy(&facts);
        assert_eq!(step["ok"], true, "{step}");
        assert!(step["detail"].as_str().unwrap().contains("未指向"));

        let still = ProxyResetFacts {
            plan_port: Some(2080),
            current: Some(CurrentProxy::Known(Some("127.0.0.1:2080".into()))),
            ..Default::default()
        };
        assert_eq!(judge_restore_proxy(&still)["ok"], false);
    }

    /// ok 聚合：任何一步失败都不能被抬成 true。
    #[test]
    fn ok_aggregation_turns_red_when_any_step_fails() {
        let green = [
            reset_step("stop_tun", true, "x"),
            reset_step("verify", true, "x"),
        ];
        assert!(steps_all_ok(&green));
        let red = [
            reset_step("stop_tun", true, "x"),
            reset_step("sweep_processes", false, "x"),
        ];
        assert!(!steps_all_ok(&red), "任何一步失败都不能抬成 true");
        assert!(!steps_all_ok(&[]), "空列表不能算成功");
    }

    /// helper 不可用时不能报「TUN 已停」。
    #[test]
    fn an_unavailable_helper_makes_stop_tun_red() {
        use crate::tun::privilege::HelperStatus;

        assert_eq!(
            WiredServices::decide_tun_stop(false, HelperStatus::NotRegistered, Ok(())),
            TunStopOutcome::Unconfirmed(
                "特权助手不可用（not_registered），无法停止或确认 TUN".into()
            )
        );
        assert_eq!(
            WiredServices::decide_tun_stop(false, HelperStatus::Enabled, Ok(())),
            TunStopOutcome::Stopped { was_running: false }
        );
        assert!(matches!(
            WiredServices::decide_tun_stop(false, HelperStatus::Enabled, Err("boom".into())),
            TunStopOutcome::Failed(_)
        ));
    }

    #[tokio::test]
    async fn stopping_an_idle_runtime_is_ok() {
        let dir = temp_dir();
        let step = services(&dir).reset_stop_runtime().await;
        assert_eq!(step["id"], "stop_runtime");
        assert_eq!(step["ok"], true, "{step}");
    }

    /// active.json 与 profile-* 都是明文，必须一起清掉。
    #[test]
    fn clear_plaintext_removes_active_json_profiles_and_runtime_pid() {
        let dir = temp_dir();
        let config = dir.join("config");
        std::fs::create_dir_all(&config).unwrap();
        std::fs::write(config.join("profile-a.json"), "{}").unwrap();
        std::fs::write(config.join("profile-a.meta.json"), "{}").unwrap();
        std::fs::write(config.join("active.json"), "{}").unwrap();
        std::fs::write(dir.join("runtime.pid"), "{}").unwrap();

        let step = services(&dir).reset_clear_plaintext();
        assert_eq!(step["ok"], true, "{step}");
        assert!(!config.join("profile-a.json").exists());
        assert!(!config.join("profile-a.meta.json").exists());
        assert!(!config.join("active.json").exists());
        assert!(!dir.join("runtime.pid").exists());
    }

    /// 进程还活着且命令行对得上时不能删 runtime.pid：
    /// 那是下次启动安全回收的唯一线索。只看 pid 会被复用骗到。
    #[cfg(unix)]
    #[test]
    fn clear_plaintext_keeps_the_pid_record_while_the_process_is_alive() {
        let dir = temp_dir();
        let config = dir.join("config");
        std::fs::create_dir_all(&config).unwrap();
        let active = config.join("active.json");
        std::fs::write(&active, "{}").unwrap();

        // 用一个临时进程冒充 sing-box：命令行以 binary 开头、包含 config 路径，
        // 正好满足 `matches_launch` 的三重核对。
        // 末尾的 `:` 阻止 sh 把自己 exec 成 sleep，否则 argv[0] 会变。
        let mut child = std::process::Command::new("/bin/sh")
            .arg("-c")
            .arg("sleep 30; :")
            .arg(&active)
            .spawn()
            .unwrap();

        std::fs::write(
            dir.join("runtime.pid"),
            json!({
                "pid": child.id(),
                "binary": "/bin/sh",
                "config": active.display().to_string(),
                "started_at": 0,
            })
            .to_string(),
        )
        .unwrap();

        let step = services(&dir).reset_clear_plaintext();
        assert_eq!(step["ok"], false, "{step}");
        assert!(step["detail"].as_str().unwrap().contains("保留运行记录"));
        assert!(!active.exists(), "明文仍要清掉");
        assert!(dir.join("runtime.pid").exists());

        let _ = child.kill();
        let _ = child.wait();
    }

    /// pid 记录指向一个不相干的进程（命令行对不上）时，记录可以删。
    #[cfg(unix)]
    #[test]
    fn a_reused_pid_does_not_block_clearing_the_record() {
        let dir = temp_dir();
        std::fs::create_dir_all(dir.join("config")).unwrap();
        std::fs::write(
            dir.join("runtime.pid"),
            json!({
                "pid": std::process::id(),
                "binary": "/opt/not-our-sing-box",
                "config": "/tmp/not-ours.json",
                "started_at": 0,
            })
            .to_string(),
        )
        .unwrap();

        let step = services(&dir).reset_clear_plaintext();
        assert_eq!(step["ok"], true, "{step}");
        assert!(!dir.join("runtime.pid").exists());
    }
}
