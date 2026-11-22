//! VPN 工具层与宿主能力之间的接缝。
//!
//! 工具只依赖这里的 trait，不直接碰 runtime / config / proxy / catalog 模块。
//! 返回结构遵循 `docs/contracts/tools.md` §4；配置模型见
//! `docs/configs-and-nav.md` §3。

use async_trait::async_trait;
use serde_json::{json, Value};

use crate::control_plane::catalog::{fetch_catalog, Catalog, CatalogError};

/// 建机目录的取数入口：**每次现取，不做本地缓存**（`tools.md` §3.1、`commands.md` §7.14）。
/// Worker 侧已有 5 分钟缓存；Host 缓存陈旧目录会让用户看到已下架的地区或旧价格。
#[async_trait]
pub trait ServerCatalogSource: Send + Sync {
    async fn fetch(&self) -> Result<Catalog, CatalogError>;
    /// 打开新建向导时用：要求控制面绕过 5 分钟缓存回源（`?fresh=1`）。
    /// 默认退回普通取数，测试替身不用各写一遍。
    async fn fetch_fresh(&self) -> Result<Catalog, CatalogError> {
        self.fetch().await
    }
}

/// 生产实现：base_url 由 `control_plane::env` 决定，release 只认 prod。
pub struct LiveServerCatalog;

#[async_trait]
impl ServerCatalogSource for LiveServerCatalog {
    async fn fetch(&self) -> Result<Catalog, CatalogError> {
        let base_url = crate::control_plane::env::current().base_url;
        fetch_catalog(&base_url, false).await
    }

    async fn fetch_fresh(&self) -> Result<Catalog, CatalogError> {
        let base_url = crate::control_plane::env::current().base_url;
        fetch_catalog(&base_url, true).await
    }
}

#[derive(Debug, Clone, Default)]
pub struct CatalogQuery {
    pub region: Option<String>,
    pub protocol: Option<String>,
    pub limit: Option<u32>,
    pub cursor: Option<String>,
}

/// 新建配置必须指定节点来源；工具层与服务层共用同一句文案。
pub const SOURCE_REQUIRED_MESSAGE: &str =
    "新建配置必须指定节点来源：用 Veyl 免费节点（source=seed）或绑定已有节点（node_ids）";

/// 命令层与工具层共用：`source` 与 `node_ids` 不能同时缺省，
/// `source: "empty"` 与空数组也算缺省。UI 与 AI 都必须先选节点来源。
pub fn require_node_source(
    source: Option<&str>,
    node_ids: Option<&[String]>,
) -> anyhow::Result<()> {
    let has_seed = source
        .map(str::trim)
        .is_some_and(|value| value.eq_ignore_ascii_case("seed"));
    let has_nodes = node_ids.is_some_and(|ids| !ids.is_empty());
    if has_seed || has_nodes {
        return Ok(());
    }
    Err(svc_error_with_details(
        "INVALID_ARGUMENT",
        SOURCE_REQUIRED_MESSAGE,
        json!({ "reason": "source_required" }),
    ))
}

#[derive(Debug, Clone, Default)]
pub struct ConfigCreateInput {
    pub name: String,
    /// system_proxy | tun
    pub connect_mode: String,
    /// direct | proxy_all（`proxy_selected` 只用于读旧数据，写入路径已拒绝）
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

    /// 免费节点 7 天试用状态。只读，不触发到期清理。
    async fn trial_status(&self) -> anyhow::Result<Value> {
        not_wired("试用状态")
    }
    /// 到期检查由 Host 在启动 / 连接成功 / 每 5 分钟调用；不是工具。
    async fn check_trial_expiry(&self) -> anyhow::Result<()> {
        Ok(())
    }

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

    /// 建机目录（地区 + 套餐）的取数入口。每次现取，不做本地缓存；
    /// `CatalogOptions`、`StageSelect` 与 `my_server_catalog` 共用。
    fn server_catalog(&self) -> Arc<dyn ServerCatalogSource> {
        Arc::new(LiveServerCatalog)
    }

    /// 只读：「我的服务器」列表。默认未接入；结果不含地址、端口、密码。
    async fn my_servers(&self) -> anyhow::Result<Value> {
        Err(anyhow::anyhow!("我的服务器未接入"))
    }

    /// 只读：某台服务器这次创建失败的详情（`tools.md` §4.51）。
    /// 只读本地镜像与内存里的订单事件，不访问云厂商 API。
    async fn my_server_failure(&self, _server_id: &str) -> anyhow::Result<Value> {
        not_wired("服务器失败详情")
    }

    async fn config_list(&self) -> anyhow::Result<Value>;
    /// 不传 `config_id` 时读当前激活配置（与 `NodeImportUrl` 等一致）。
    async fn config_detail(&self, config_id: Option<String>) -> anyhow::Result<Value>;
    async fn config_create(&self, input: ConfigCreateInput) -> anyhow::Result<Value>;
    async fn config_update(
        &self,
        config_id: &str,
        input: ConfigUpdateInput,
    ) -> anyhow::Result<Value>;
    async fn config_delete(&self, config_id: &str) -> anyhow::Result<Value>;
    /// 只改 active（当前用哪套），不碰运行时；断开只发生在 `runtime_start`。
    async fn config_activate(&self, config_id: &str) -> anyhow::Result<Value>;

    async fn node_import_url(&self, config_id: Option<String>, url: &str) -> anyhow::Result<Value>;
    /// 用户粘贴的节点文本：逐行解析 `ss://`，**不发网络请求**。
    async fn node_import_text(
        &self,
        config_id: Option<String>,
        text: &str,
    ) -> anyhow::Result<Value>;
    async fn node_create(&self, input: NodeCreateInput) -> anyhow::Result<Value>;
    /// UI 专用：把已存在的节点绑进全局配置（`commands.md` §4.x `node_attach`）。
    /// 不联网、不改 `current_node_id`；`configs` 为空时先懒创建默认配置。
    async fn node_attach(
        &self,
        _source: Option<String>,
        _node_ids: Option<Vec<String>>,
        _config_id: Option<String>,
    ) -> anyhow::Result<Value> {
        not_wired("绑定节点")
    }
    async fn node_switch(&self, config_id: &str, node_id: &str) -> anyhow::Result<Value>;
    async fn node_probe(&self, node_id: &str) -> anyhow::Result<Value>;

    /// UI 专用：启动一批节点测速。默认未接入，测试替身不必实现。
    /// 探针 runtime 路径由 `WiredServices` 实现；未连接时先起临时运行时。
    async fn node_probe_all(
        &self,
        _config_id: Option<String>,
        _node_ids: Option<Vec<String>>,
    ) -> anyhow::Result<Value> {
        // 探针 runtime 路径由 WiredServices 实现；测试替身不接入。
        // 正式实现返回 `{ run_id, config_id, total, concurrency, ignored_node_ids }`。
        Err(anyhow::anyhow!("批量测速未接入"))
    }
    async fn node_probe_cancel(&self, _run_id: &str) -> anyhow::Result<Value> {
        Err(anyhow::anyhow!("批量测速未接入"))
    }
    async fn node_probe_snapshot(&self, _config_id: Option<String>) -> anyhow::Result<Value> {
        Err(anyhow::anyhow!("批量测速未接入"))
    }

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
    /// 在线切换接管方式（`system_proxy` ↔ `tun`），会断开重连。
    ///
    /// `confirmed` 是 Host 内部的确认门禁：正在连这套配置时，只有过了确认卡
    /// （或 UI 用户直接点开关）才传 true。门禁与「停不停连接」的判断在这一处，
    /// 调用方不能靠先查一次状态来绕开启动窗口。
    async fn config_set_mode(
        &self,
        _config_id: Option<String>,
        _mode: &str,
        _confirmed: bool,
    ) -> anyhow::Result<Value> {
        not_wired("切换接管方式")
    }
    async fn route_targets_set(
        &self,
        config_id: &str,
        categories: Vec<String>,
    ) -> anyhow::Result<Value>;

    /// 生效地区与来源（`{ region, source }`）。只读；不写库。
    /// 测试替身没有自己的 store 时走全局库；正式实现按自己的 store 读。
    async fn system_region(&self) -> anyhow::Result<Value> {
        let (region, source) = match crate::store::global() {
            Some(store) => crate::rules::effective_region(store),
            None => (
                crate::rules::detect_region(),
                crate::rules::RegionSource::System,
            ),
        };
        Ok(json!({
            "region": region.code(),
            "source": source.as_str(),
        }))
    }

    /// 写入 `settings.user_region` 并发 `region-changed`。**唯一**地区的写入路径。
    async fn set_user_region(&self, _region: &str) -> anyhow::Result<Value> {
        not_wired("设置地区")
    }

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
    /// 仅 UI：读/写「问题报告是否包含完整域名」。不注册为 AI 工具——
    /// 脱敏开关属于用户，模型不能放宽（`design/issue-report.md` §1.2）。
    async fn issue_report_preference(
        &self,
        _include_domains: Option<bool>,
    ) -> anyhow::Result<Value> {
        not_wired("问题报告偏好")
    }
    /// 问题报告（`docs/contracts/tools.md` §4.46）：收集或写入。
    /// 默认未接入，测试替身不必实现。
    async fn issue_report(
        &self,
        _session_id: &str,
        _input: crate::reports::IssueReportInput,
    ) -> anyhow::Result<Value> {
        not_wired("问题报告")
    }

    /// 问题墙：上报。`payload` 已由工具按契约组装好，`idempotency_key` 由工具按
    /// `(会话, diagnosis.session_id)` 派生，Host 只负责发出。
    async fn submit_issue_to_public_wall(
        &self,
        _payload: Value,
        _idempotency_key: &str,
    ) -> anyhow::Result<Value> {
        not_wired("问题墙上报")
    }

    /// 问题墙：公开读取。不需要登录，默认实现也不应该要求身份。
    async fn read_public_issue_wall(
        &self,
        _query: crate::control_plane::issues::IssueQuery,
    ) -> anyhow::Result<Value> {
        not_wired("问题墙读取")
    }

    /// 确认卡与请求体共用的客户端信息（应用版本 / 构建 / 平台 / 系统 / 架构 / 语言）。
    /// 模型不能指定这些值。
    fn issue_wall_client_info(&self) -> Value {
        crate::control_plane::issues::ClientInfo::current("zh").to_json()
    }

    /// 只有邮箱账户能上报；读取问题墙不需要登录。
    fn issue_wall_logged_in(&self) -> bool {
        crate::control_plane::auth::account_state().logged_in
    }

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

/// `system_dns` 的取值：连接期系统解析器是否已指向隧道。
///
/// DNS 是优化项，切不过去也照常连接；前端用这个字段常驻一行提示，
/// 不能让降级变成静默。
fn system_dns_label(hijack: Option<&crate::tun::backend::DnsHijack>) -> &'static str {
    match hijack {
        Some(value) if value.applied => "tunnel",
        _ => "unchanged",
    }
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
        "port_fallback": null,
        "config_name": null,
        "node_id": null,
        "node_name": null,
        "applied_route_revision": null,
        "route_region": null,
        "connected_since": null,
        "latency_ms": null,
        "node_latency_ms": null,
        "direct_ip": null,
        "config_hash": null,
        "system_proxy_enabled": false,
        "system_dns": null,
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

    async fn config_detail(&self, _config_id: Option<String>) -> anyhow::Result<Value> {
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

    async fn config_activate(&self, _config_id: &str) -> anyhow::Result<Value> {
        not_wired("激活配置")
    }

    async fn node_import_url(
        &self,
        _config_id: Option<String>,
        _url: &str,
    ) -> anyhow::Result<Value> {
        not_wired("导入节点")
    }

    async fn node_import_text(
        &self,
        _config_id: Option<String>,
        _text: &str,
    ) -> anyhow::Result<Value> {
        not_wired("粘贴导入节点")
    }

    async fn node_create(&self, _input: NodeCreateInput) -> anyhow::Result<Value> {
        not_wired("创建节点")
    }

    async fn node_switch(&self, _config_id: &str, _node_id: &str) -> anyhow::Result<Value> {
        not_wired("切换节点")
    }

    async fn node_probe(&self, _node_id: &str) -> anyhow::Result<Value> {
        not_wired("Veyl 免费节点")
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

/// 控制面错误 → 服务层错误：保留 code / message / details / retryable。
/// 唯一改写：登录缺失 / 过期的错误统一成 `PRECONDITION_FAILED / not_logged_in`，
/// 与工具的未登录口径一致（`design/issue-report-api.md` §2.1）。
fn svc_from_cp(mut error: crate::control_plane::error::CpError) -> anyhow::Error {
    // 关闭上报是暂时的服务端状态，不是内部故障：客户端按「上游不可用」处理。
    if error.reason() == Some("issues_closed") {
        error.code = "UPSTREAM_ERROR".into();
        error.retryable = true;
    }
    let blocked_login =
        error.code == "PERMISSION_DENIED" && error.reason() == Some("not_logged_in");
    if error.code == "UNAUTHENTICATED" || blocked_login {
        error.code = "PRECONDITION_FAILED".into();
        error.details = json!({ "reason": "not_logged_in" });
    }
    anyhow::Error::new(ServiceError {
        code: error.code,
        message: error.message,
        retryable: error.retryable,
        details: Some(error.details),
    })
}

/// `retryable: true` 的错误（并发切换：等前一个结束后由用户重来）。
fn svc_error_retryable(
    code: impl std::fmt::Display,
    message: impl std::fmt::Display,
    details: Value,
) -> anyhow::Error {
    anyhow::Error::new(ServiceError {
        code: code.to_string(),
        message: message.to_string(),
        retryable: true,
        details: Some(details),
    })
}

/// 运行期操作锁排队超时：不是操作失败，可重试（界面给「再试一次」）。
fn runtime_busy_error() -> anyhow::Error {
    svc_error_retryable(
        "TIMEOUT",
        "运行时正在执行长操作，稍后再试",
        json!({ "reason": "runtime_busy" }),
    )
}

/// 给切换接管方式的失败补上 `mode` / `previous_mode` 与回滚结果。
///
/// 保留**首次失败**的错误码：回滚是否成功只由 `details.restored` 表达。
fn with_mode_context(error: anyhow::Error, context: Value) -> anyhow::Error {
    match error.downcast_ref::<ServiceError>() {
        Some(service) => {
            let mut details = match service.details.clone() {
                Some(Value::Object(map)) => Value::Object(map),
                _ => json!({}),
            };
            if let (Some(target), Some(extra)) = (details.as_object_mut(), context.as_object()) {
                for (key, value) in extra {
                    target.insert(key.clone(), value.clone());
                }
            }
            anyhow::Error::new(ServiceError {
                code: service.code.clone(),
                message: service.message.clone(),
                retryable: service.retryable,
                details: Some(details),
            })
        }
        None => svc_error_with_details("INTERNAL", error.to_string(), context),
    }
}

/// `region-changed` 的载荷（`events.md` 2.12.0）：生效值 + 来源 + 时间。
fn region_changed_payload(
    region: &crate::rules::Region,
    source: crate::rules::RegionSource,
) -> Value {
    json!({
        "contract_version": crate::runtime::EVENT_CONTRACT_VERSION,
        "region": region.code(),
        "source": source.as_str(),
        "emitted_at": chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
    })
}

/// 一次连接最多试几个候选端口（预检查通过后仍可能在 bind 前被抢）。
const PORT_TRIAL_LIMIT: usize = 3;

/// 本轮要试的端口：候选链里当前可用的前三个；不够就少试，不拿随机端口补位
/// （补位会破坏「候选链确定」这个前提）。
///
/// `own_port` 是当前运行时正占着的端口：它马上会被 `manager.start` 停掉，
/// 不能当成「被别的软件占用」，否则重连/切配置会白降一级。
fn proxy_port_trials(configured: u16, own_port: Option<u16>) -> Vec<u16> {
    let mut trials = Vec::with_capacity(PORT_TRIAL_LIMIT);
    for port in vpn_config::proxy_port_candidates(configured) {
        if trials.len() >= PORT_TRIAL_LIMIT {
            break;
        }
        if Some(port) == own_port || vpn_config::is_port_free(port) {
            trials.push(port);
        }
    }
    // 候选链整体都不可用时才走最后一步「系统分配」，不拿随机端口把 3 个名额补满。
    if trials.is_empty() {
        if let Ok(port) = vpn_config::any_free_port() {
            trials.push(port);
        }
    }
    trials
}

/// Clash API 用独立端口，不能和 mixed 端口撞，也不占用户设置的端口。
fn clash_port_for(mixed_port: u16, excluded: &[u16]) -> anyhow::Result<u16> {
    for _ in 0..6 {
        let port =
            vpn_config::pick_free_port_excluding(excluded).map_err(|e| svc_error(e.code(), e))?;
        if port != mixed_port {
            return Ok(port);
        }
    }
    let port = vpn_config::any_free_port().map_err(|e| svc_error(e.code(), e))?;
    if port == mixed_port {
        return Err(svc_error(
            "RUNTIME_PORT_UNAVAILABLE",
            "无法为控制面分配独立端口",
        ));
    }
    Ok(port)
}

/// 启动失败是否因为端口在预检查之后被抢。
///
/// **只看本次尝试追加的日志段**（`start_connection` 打的标记），不读共享日志尾巴：
/// 日志是 append 且只在超过上限时轮转，历史行里的 "address already in use"
/// 会把任何失败都误判成端口冲突，白重试三次并掩盖真实错误。
fn is_port_conflict(error: &anyhow::Error) -> bool {
    error
        .downcast_ref::<ServiceError>()
        .and_then(|service| service.details.as_ref())
        .and_then(|details| details.get("port_conflict"))
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

fn log_size(path: &std::path::Path) -> u64 {
    std::fs::metadata(path).map(|meta| meta.len()).unwrap_or(0)
}

/// 本次启动追加到日志里的内容；文件被轮转（变短）时返回 None，
/// 宁可漏判一次竞态，也不拿历史行当本次失败。
fn log_appended(path: &std::path::Path, offset: u64) -> Option<String> {
    use std::io::{Read, Seek, SeekFrom};

    let mut file = std::fs::File::open(path).ok()?;
    let len = file.metadata().ok()?.len();
    if len <= offset {
        return None;
    }
    file.seek(SeekFrom::Start(offset)).ok()?;
    let mut bytes = Vec::new();
    file.take(64 * 1024).read_to_end(&mut bytes).ok()?;
    Some(String::from_utf8_lossy(&bytes).to_string())
}

fn is_bind_conflict_text(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    lower.contains("address already in use")
        // Windows 的措辞；未在 Windows 真机验证过，按 Go 的 `net` 报错加一条。
        || lower.contains("only one usage of each socket address")
}

fn port_unavailable_error(tried: &[u16]) -> anyhow::Error {
    let tried_text = tried
        .iter()
        .map(u16::to_string)
        .collect::<Vec<_>>()
        .join("、");
    svc_error_with_details(
        "RUNTIME_PORT_UNAVAILABLE",
        if tried_text.is_empty() {
            "本地代理端口都不可用，请在设置里换一个端口".to_string()
        } else {
            format!(
                "本地代理端口 {tried_text} 都被占用了，请在设置里换一个端口，或先关掉占用它的软件"
            )
        },
        json!({ "tried_ports": tried }),
    )
}

#[cfg(test)]
mod port_trial_tests {
    use super::*;

    /// 候选的形状约束：非空、不超上限、跳过被占端口、不重复。
    ///
    /// **不要在这里再断言「每个候选都空闲」**：那是在 `proxy_port_trials` 查过一遍
    /// 之后的二次检查，而同一测试二进制里并行跑的用例也在 `bind(0)`，两次检查之间
    /// 系统完全可能把同一个临时端口发出去——这条断言天生有竞态，随机红。
    /// 「被占端口会被跳过」由下面的确定性断言覆盖。
    #[test]
    fn trials_skip_taken_ports_and_are_distinct() {
        let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let taken = listener.local_addr().unwrap().port();
        let trials = proxy_port_trials(taken, None);
        assert!(!trials.is_empty());
        assert!(trials.len() <= PORT_TRIAL_LIMIT);
        assert!(!trials.contains(&taken), "被占的端口不能进候选");
        let mut unique = trials.clone();
        unique.sort_unstable();
        unique.dedup();
        assert_eq!(unique.len(), trials.len(), "候选不能重复");
    }

    #[test]
    fn the_runtimes_own_port_is_not_treated_as_occupied() {
        // 重连/切配置时旧进程还占着 7890，但它会在 start 前被停掉。
        let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let own = listener.local_addr().unwrap().port();
        let trials = proxy_port_trials(own, Some(own));
        assert_eq!(trials[0], own, "自己的端口必须留在候选第一位");
    }

    #[test]
    fn bind_conflict_text_covers_both_platforms() {
        assert!(is_bind_conflict_text(
            "FATAL listen tcp 127.0.0.1:7890: bind: address already in use"
        ));
        assert!(is_bind_conflict_text(
            "Only one usage of each socket address (protocol/network address/port) is normally permitted."
        ));
        assert!(!is_bind_conflict_text("FATAL something else"));
    }

    #[test]
    fn conflict_detection_uses_the_marker_not_history() {
        let marked =
            svc_error_with_details("RUNTIME_EXITED", "boom", json!({ "port_conflict": true }));
        assert!(is_port_conflict(&marked));
        let text_only = svc_error("RUNTIME_EXITED", "bind: address already in use");
        assert!(
            !is_port_conflict(&text_only),
            "不能拿历史日志文本当本次冲突"
        );
    }

    #[test]
    fn port_unavailable_carries_the_tried_ports() {
        let error = port_unavailable_error(&[7890, 7891, 7892]);
        let service = error
            .downcast_ref::<ServiceError>()
            .expect("应当是结构化错误");
        assert_eq!(service.code, "RUNTIME_PORT_UNAVAILABLE");
        assert_eq!(
            service.details.as_ref().unwrap()["tried_ports"],
            json!([7890, 7891, 7892])
        );
    }
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

/// 连接失败后，用户的网络设置有没有改动、有没有恢复原样。
///
/// 只挂在错误的 `details.connect_changed` 上，供 `VpnConnect` 的展示层选择
/// 「已恢复原样 / 没有改动 / 不确定」。不改任何服务签名。
///
/// 连接新配置前会先停掉旧连接（`runtime_start` 自动收口）：停过之后再失败，
/// 绝不能报「没有改动」——旧连接已经不在了。
fn connect_changed_state(error: &anyhow::Error) -> &'static str {
    let old_stopped = error
        .downcast_ref::<ServiceError>()
        .and_then(|service| service.details.as_ref())
        .and_then(|details| details.get("old_connection_stopped"))
        .and_then(Value::as_bool);
    if old_stopped == Some(false) {
        // 停旧失败：网络状态不确定。
        return "unknown";
    }
    let base = connect_changed_base(error);
    if old_stopped == Some(true) && base == "none" {
        "restored"
    } else {
        base
    }
}

fn connect_changed_base(error: &anyhow::Error) -> &'static str {
    let Some(service) = error.downcast_ref::<ServiceError>() else {
        return "none";
    };
    let details = service.details.as_ref();
    let reason = details
        .and_then(|value| value.get("reason"))
        .and_then(Value::as_str);
    let detail = details.and_then(|value| value.get("detail"));
    let detail_reason = detail
        .and_then(|value| value.get("reason"))
        .and_then(Value::as_str);
    // 被取代的启动：停干净了就是「改过又收回」，停不掉/不确定才是 unknown。
    if details
        .and_then(|value| value.get("superseded_start"))
        .and_then(Value::as_bool)
        == Some(true)
    {
        let stop_failed = details
            .and_then(|value| value.get("superseded_stop_failed"))
            .and_then(Value::as_bool)
            == Some(true);
        return if stop_failed { "unknown" } else { "restored" };
    }

    // 想过恢复但没成功：不能再声称「没有改动」。
    if reason == Some("proxy_restore_failed") {
        return "unknown";
    }
    if detail_reason == Some("node_server_unresolved") {
        return "none";
    }
    if detail_reason == Some("takeover_incomplete") {
        let stopped = detail
            .and_then(|value| value.get("stopped"))
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let residual = detail
            .and_then(|value| value.get("residual_routes"))
            .and_then(Value::as_bool)
            .unwrap_or(true);
        let dns_flushed = detail
            .and_then(|value| value.get("dns_flushed"))
            .and_then(Value::as_bool)
            .unwrap_or(false);
        return if stopped && !residual && dns_flushed {
            "restored"
        } else {
            "unknown"
        };
    }
    // 启动失败但没拿到回滚证据：可能起了一半。
    if service.code == "tun_start_failed" {
        return "unknown";
    }
    if matches!(
        reason,
        Some(
            "quitting"
                | "no_config"
                | "config_not_found"
                | "rules_not_ready"
                | "helper_missing"
                | "helper_install_failed"
                | "tun_denied"
        )
    ) {
        return "none";
    }

    // 进程启动/代理设置失败后都会 abort：撤代理、停运行时。
    let after_start = details
        .and_then(|value| value.get("runtime_log_tail"))
        .is_some()
        || matches!(
            service.code.as_str(),
            "RUNTIME_START_TIMEOUT" | "RUNTIME_EXITED"
        )
        || (service.code == "INTERNAL" && service.message.starts_with("设置系统代理失败"));
    if after_start {
        "restored"
    } else {
        "none"
    }
}

fn with_connect_changed(error: anyhow::Error, changed: &'static str) -> anyhow::Error {
    let (code, message, mut details) = match error.downcast_ref::<ServiceError>() {
        Some(service) => (
            service.code.clone(),
            service.message.clone(),
            service.details.clone().unwrap_or_else(|| json!({})),
        ),
        None => ("INTERNAL".to_string(), error.to_string(), json!({})),
    };
    details["connect_changed"] = json!(changed);
    svc_error_with_details(code, message, details)
}

/// 这次连接已被切配置 / 断开取代：不是失败，由新连接的事件接续。
fn is_cancelled_error(error: &anyhow::Error) -> bool {
    error
        .downcast_ref::<ServiceError>()
        .and_then(|service| service.details.as_ref())
        .and_then(|details| details.get("reason"))
        .and_then(Value::as_str)
        == Some("cancelled")
}

/// 给失败打上「旧连接已经被停掉 / 停旧失败」的标记，供 `connect_changed_state` 用。
fn mark_old_connection_stopped(error: anyhow::Error, stopped: bool) -> anyhow::Error {
    let Some(service) = error.downcast_ref::<ServiceError>() else {
        return error;
    };
    let mut details = service.details.clone().unwrap_or_else(|| json!({}));
    details["old_connection_stopped"] = json!(stopped);
    svc_error_with_details(service.code.clone(), service.message.clone(), details)
}

/// 启动决策段的结果：幂等分支直接带回快照，其余带回记好的代数。
enum ConnectionDecision {
    Idempotent(Value),
    Start { epoch: u64, old_stopped: bool },
}

/// 拉起阶段要带进 `connect_body` 的启动上下文。
#[derive(Clone, Copy)]
struct StartContext {
    /// 决策段记下的运行期代数；重建回滚没有决策段，为 `None`（不做取代检查）。
    epoch: Option<u64>,
    /// 调用方是否已持有运行期操作锁（重建回滚在锁内调 `connect_body`）。
    lock_held: bool,
}

const SUPERSEDED_START_MESSAGE: &str = "本次连接已被更新的操作取代，已取消。";
const STOP_UNKNOWN_MESSAGE: &str = "连接结果无法确认，请查看诊断日志后重试。";
/// 重建被用户断开取代时的固定文案（契约 §4.0.1）。
const USER_DISCONNECTED_REBUILD_MESSAGE: &str = "已按你的操作断开；新增节点会在下次连接时生效。";

/// 重建被用户断开取代：不回滚、不重连；节点已进池，下次连接生效。
fn user_disconnected_rebuild() -> Value {
    json!({
        "status": "failed",
        "reason": "user_disconnected",
        "restored": false,
        "new_nodes_available_next_connect": true,
        "message": USER_DISCONNECTED_REBUILD_MESSAGE,
    })
}

/// 重建后的连接状态无法确认（拿不到运行期锁）：**不能冒充用户断开**，
/// 也不能声称已恢复。节点已进池，下次连接生效。
fn rebuild_unknown() -> Value {
    json!({
        "status": "failed",
        "restored": false,
        "new_nodes_available_next_connect": true,
        "message": "没能确认当前连接状态；新节点已进池，下次连接生效。",
    })
}

/// 重建期间运行时被**另一次启动或重启**接手（连接还在）：不是用户断开，
/// 不能说「已按你的操作断开」。
fn rebuild_replaced_by_new_connection() -> Value {
    json!({
        "status": "failed",
        "restored": false,
        "new_nodes_available_next_connect": true,
        "message": "新节点这次没能应用；当前连接已由新的操作接管，重新连接后就能用它。",
    })
}

/// 拉起返回后复查到的连接状态。
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum AfterStart {
    /// 这套配置连接着。
    Connected,
    /// 没连着这套配置，但**有人在接手**（别的配置在跑，或新的启动在途中）：
    /// 这是「被新的操作接管」，不是用户断开。
    Replaced,
    /// 既没连着、也没有启动在途：用户确实断开了。
    Disconnected,
    /// 无法确认（拿不到运行期锁）：既不是连着，也不是用户断开。
    Unknown,
}

/// 被取代的启动收尾（契约 §7.1）：停干净了就是 `cancelled`（请求作废，不是故障）；
/// 停不掉或无法确认就是 `INTERNAL` + `connect_changed: "unknown"`。
fn superseded_error(message: &str, stop_failed: bool) -> anyhow::Error {
    let mut details = json!({ "reason": "cancelled", "superseded_start": true });
    if stop_failed {
        details["superseded_stop_failed"] = json!(true);
    }
    let code = if stop_failed {
        "INTERNAL"
    } else {
        "PRECONDITION_FAILED"
    };
    svc_error_with_details(code, message, details)
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
        for expected in ["64.177.43.69/32", "64.177.57.184/32", "2001:db8::1/128"] {
            // secret-scan:allow 测试常量：节点绕过计划
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

/// 这次连接已被切配置 / 断开取代：请求作废，不是要展示给用户的故障。
fn cancelled_connection_error() -> anyhow::Error {
    svc_error_with_details(
        "PRECONDITION_FAILED",
        "这次连接已被新的操作取消",
        json!({ "reason": "cancelled" }),
    )
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

/// 这台节点的服务器**现在**还能不能解析。
///
/// 只用来区分热切失败的两类原因：能解析 ⇒ 节点是连接之后才进池的；
/// 解析不出来 ⇒ 连接时就被剔除了。解析超时按失败算，但只影响这一句提示。
async fn node_server_resolves_now(server: &str) -> bool {
    let server = server.trim();
    if server.parse::<std::net::IpAddr>().is_ok() {
        return true;
    }
    match tokio::time::timeout(
        std::time::Duration::from_secs(2),
        tokio::net::lookup_host((server, 0)),
    )
    .await
    {
        Ok(Ok(addresses)) => addresses.into_iter().next().is_some(),
        _ => false,
    }
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
                "stopped": stop_error.is_none(),
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

/// 用户侧运行期操作（start / stop / restart）的排队上限。
///
/// 锁只护决策段（读状态 → 幂等判断 → 停旧 → 记代），拉起在锁外，所以排队时间
/// 与 TUN 冷启动（90s）无关；剩下最长的一段是重建决策段里的停旧（TUN stop ≤10s）。
const RUNTIME_OP_LOCK_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(20);

/// 重建自己取锁的上限：拿不到就降级成「下次连接可用」，不让 attach 等太久。
const RUNTIME_REBUILD_LOCK_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(20);

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

/// 检查项结论。`Skipped` 是「当前状态不适用、没检查」，**不是失败**
/// （`tools.md` §4.13）：不计入 `summary.failed`，也不带 remediation / action。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CheckStatus {
    Ok,
    Failed,
    Skipped,
}

impl CheckStatus {
    fn as_str(self) -> &'static str {
        match self {
            Self::Ok => "ok",
            Self::Failed => "failed",
            Self::Skipped => "skipped",
        }
    }
}

fn diag_check(
    name: &str,
    group: &str,
    status: CheckStatus,
    detail: String,
    remediation: Option<&str>,
    action: Option<Value>,
) -> Value {
    // `ok` 是兼容字段，恒等于 `status == "ok"`：只在这一处推导，消费方读两个字段
    // 不会得到互相矛盾的结论。
    debug_assert!(
        status != CheckStatus::Skipped || (remediation.is_none() && action.is_none()),
        "{name}: skipped 项不得带 remediation / action"
    );
    json!({
        "name": name,
        "group": group,
        "status": status.as_str(),
        "ok": status == CheckStatus::Ok,
        "detail": detail,
        "remediation": remediation,
        "action": action,
    })
}

/// 诊断看到的连接情况。四项与连接有关的检查按它选结论与文案：
/// 未连接时没有可判的对象（`skipped`，不是失败），TUN 与代理各有自己的检查面。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DiagConnection {
    /// 没连接，也没有连接在途。
    Idle,
    /// 启动 / 重启 / 停止途中：现在读到的健康值可能是上一轮的。
    Pending,
    /// 本机代理（`RuntimeManager` 的 sing-box）。
    Proxy,
    /// 全部流量接管（helper 里的 sing-box）。
    Tun,
}

/// 从**统一快照**判定连接情况。调用方必须传 `connection_status()` 的结果：
/// TUN 的进程不归 `RuntimeManager` 管，用 `manager.status()` 会把 TUN 连接说成
/// 「未连接」——`network.coverage` 就踩过这个坑。
fn diag_connection(status: &crate::runtime::RuntimeStatus, launching: bool) -> DiagConnection {
    use crate::runtime::{RuntimeMode, RuntimeState};
    // 途中状态先拦掉：`RuntimeStatus::tun_pending(Starting)` 同样带 `mode = Tun`，
    // 但那时隧道进程还没起来，读它的 process / health 会说假话。
    if matches!(
        status.state,
        RuntimeState::Starting | RuntimeState::Restarting | RuntimeState::Stopping
    ) {
        return DiagConnection::Pending;
    }
    // 已在跑的 TUN 连接：`connection_status()` 只在 `TunSession::status()` 报
    // Running 时才拼这个快照，所以它说明隧道进程在跑。
    if status.state == RuntimeState::Running && matches!(status.mode, Some(RuntimeMode::Tun)) {
        return DiagConnection::Tun;
    }
    if matches!(status.state, RuntimeState::Running | RuntimeState::Degraded) {
        return DiagConnection::Proxy;
    }
    if launching {
        return DiagConnection::Pending;
    }
    DiagConnection::Idle
}

/// `app.process_alive`：判据是进程本身。
/// 代理模式看 manager 的健康快照，TUN 看 `TunSession`（`status()` 与复核都会
/// 问 helper）——**不是**「连接成立就算进程活着」。
fn process_alive_check(connection: DiagConnection, alive: bool) -> Value {
    match connection {
        DiagConnection::Idle => diag_check(
            "app.process_alive",
            "app",
            CheckStatus::Skipped,
            "未连接，未检查进程".into(),
            None,
            None,
        ),
        DiagConnection::Pending => diag_check(
            "app.process_alive",
            "app",
            CheckStatus::Skipped,
            "正在连接，稍后再看".into(),
            None,
            None,
        ),
        DiagConnection::Proxy => diag_check(
            "app.process_alive",
            "app",
            if alive {
                CheckStatus::Ok
            } else {
                CheckStatus::Failed
            },
            if alive {
                "sing-box 进程存活".into()
            } else {
                "进程没在运行".into()
            },
            (!alive).then_some("重新连接后再试"),
            (!alive).then(|| json!({ "kind": "reconnect" })),
        ),
        DiagConnection::Tun => diag_check(
            "app.process_alive",
            "app",
            if alive {
                CheckStatus::Ok
            } else {
                CheckStatus::Failed
            },
            if alive {
                "隧道进程存活".into()
            } else {
                "隧道进程没在运行".into()
            },
            (!alive).then_some("重新连接后再试"),
            (!alive).then(|| json!({ "kind": "reconnect" })),
        ),
    }
}

/// `app.config_valid`：运行中的进程是不是带着一套已知配置。
/// TUN 快照不填配置摘要（`RuntimeStatus::tun`），用启动时记下的配置作证；
/// 没有摘要也没有记录时如实报 `skipped`，不说「缺配置」。
fn config_valid_check(connection: DiagConnection, status: &crate::runtime::RuntimeStatus) -> Value {
    match connection {
        DiagConnection::Idle => diag_check(
            "app.config_valid",
            "app",
            CheckStatus::Skipped,
            "未连接，无活动配置".into(),
            None,
            None,
        ),
        DiagConnection::Pending => diag_check(
            "app.config_valid",
            "app",
            CheckStatus::Skipped,
            "正在连接，稍后再看".into(),
            None,
            None,
        ),
        DiagConnection::Tun => {
            let detail = status
                .config_name
                .clone()
                .map(|name| format!("配置已应用：{name}"));
            if status.config_id.is_none() && detail.is_none() {
                return diag_check(
                    "app.config_valid",
                    "app",
                    CheckStatus::Skipped,
                    "接管模式暂未记录配置信息".into(),
                    None,
                    None,
                );
            }
            diag_check(
                "app.config_valid",
                "app",
                CheckStatus::Ok,
                detail.unwrap_or_else(|| "配置已应用".into()),
                None,
                None,
            )
        }
        DiagConnection::Proxy => match status.config_hash.clone() {
            Some(hash) => diag_check("app.config_valid", "app", CheckStatus::Ok, hash, None, None),
            None => diag_check(
                "app.config_valid",
                "app",
                CheckStatus::Failed,
                "缺少配置摘要".into(),
                None,
                None,
            ),
        },
    }
}

/// `app.clash_api`：只有端点、没有探测通道的地方不下结论。
fn clash_api_check(connection: DiagConnection, available: bool) -> Value {
    match connection {
        DiagConnection::Idle => diag_check(
            "app.clash_api",
            "app",
            CheckStatus::Skipped,
            "未连接".into(),
            None,
            None,
        ),
        DiagConnection::Pending => diag_check(
            "app.clash_api",
            "app",
            CheckStatus::Skipped,
            "正在连接".into(),
            None,
            None,
        ),
        // TUN 的控制面端点固定 `clash_api: false`（没有探测通道），不能说自己坏。
        DiagConnection::Tun => diag_check(
            "app.clash_api",
            "app",
            CheckStatus::Skipped,
            "接管模式下不检查控制面".into(),
            None,
            None,
        ),
        DiagConnection::Proxy => diag_check(
            "app.clash_api",
            "app",
            if available {
                CheckStatus::Ok
            } else {
                CheckStatus::Failed
            },
            if available {
                "控制面可用".into()
            } else {
                "控制面不可用".into()
            },
            (!available).then_some("重新连接后再试"),
            None,
        ),
    }
}

/// `app.data_plane`：TUN 与代理都来自真实探测（TUN 侧连两次失败才翻）。
fn data_plane_check(connection: DiagConnection, up: bool) -> Value {
    match connection {
        DiagConnection::Idle => diag_check(
            "app.data_plane",
            "app",
            CheckStatus::Skipped,
            "未连接".into(),
            None,
            None,
        ),
        DiagConnection::Pending => diag_check(
            "app.data_plane",
            "app",
            CheckStatus::Skipped,
            "正在连接".into(),
            None,
            None,
        ),
        DiagConnection::Tun => diag_check(
            "app.data_plane",
            "app",
            if up {
                CheckStatus::Ok
            } else {
                CheckStatus::Failed
            },
            if up {
                "流量探测正常".into()
            } else {
                "连续两次探测不通".into()
            },
            (!up).then_some("换个节点或稍后重试"),
            None,
        ),
        DiagConnection::Proxy => diag_check(
            "app.data_plane",
            "app",
            if up {
                CheckStatus::Ok
            } else {
                CheckStatus::Failed
            },
            if up {
                "数据面可用".into()
            } else {
                "数据面不可用".into()
            },
            (!up).then_some("换个节点或稍后重试"),
            None,
        ),
    }
}

/// `network.exit_ip`：TUN 不采集出口 IP；代理模式下还没探测到也算 `skipped`。
fn exit_ip_check(connection: DiagConnection, exit_ip: Option<&str>) -> Value {
    match connection {
        DiagConnection::Idle => diag_check(
            "network.exit_ip",
            "network",
            CheckStatus::Skipped,
            "未连接".into(),
            None,
            None,
        ),
        DiagConnection::Pending => diag_check(
            "network.exit_ip",
            "network",
            CheckStatus::Skipped,
            "正在连接".into(),
            None,
            None,
        ),
        DiagConnection::Tun => diag_check(
            "network.exit_ip",
            "network",
            CheckStatus::Skipped,
            "接管模式不采集出口 IP".into(),
            None,
            None,
        ),
        DiagConnection::Proxy => match exit_ip {
            Some(ip) => diag_check(
                "network.exit_ip",
                "network",
                CheckStatus::Ok,
                format!("出口 IP {ip}"),
                None,
                None,
            ),
            None => diag_check(
                "network.exit_ip",
                "network",
                CheckStatus::Skipped,
                "还没探测到".into(),
                None,
                None,
            ),
        },
    }
}

/// `system.proxy_services`：哪些系统服务挂着代理。
///
/// 只有代理模式才拿「必须指向本机端口」判它。TUN 不走系统代理，没有残留设置就是
/// `skipped`；但指针留在未监听的本地端口仍是真问题（残留设置），照样 `failed`。
fn proxy_services_check(
    connection: DiagConnection,
    endpoints: &[String],
    expected: Option<&str>,
    dead_loopback: bool,
) -> Value {
    let (status, detail) = if matches!(connection, DiagConnection::Tun) {
        if dead_loopback {
            (
                CheckStatus::Failed,
                "系统代理指向未监听的本地端口".to_string(),
            )
        } else if endpoints.is_empty() {
            (CheckStatus::Skipped, "接管模式不用系统代理".to_string())
        } else {
            (
                CheckStatus::Skipped,
                format!(
                    "接管模式不用系统代理，{} 个服务另有代理设置",
                    endpoints.len()
                ),
            )
        }
    } else if matches!(connection, DiagConnection::Proxy) {
        let matches_runtime = expected
            .map(|expected| !endpoints.is_empty() && endpoints.iter().all(|item| item == expected))
            .unwrap_or(false);
        (
            if matches_runtime && !dead_loopback {
                CheckStatus::Ok
            } else {
                CheckStatus::Failed
            },
            if endpoints.is_empty() {
                "系统代理未接管".to_string()
            } else {
                format!("{} 个服务指向 {}", endpoints.len(), endpoints[0])
            },
        )
    } else if dead_loopback {
        (
            CheckStatus::Failed,
            "系统代理指向未监听的本地端口".to_string(),
        )
    } else {
        (
            CheckStatus::Ok,
            format!("{} 个服务启用了代理", endpoints.len()),
        )
    };
    diag_check(
        "system.proxy_services",
        "system",
        status,
        detail,
        (status == CheckStatus::Failed).then_some("点『恢复网络』撤掉代理后再试"),
        (status == CheckStatus::Failed).then(|| json!({ "kind": "restore_network" })),
    )
}

/// `network.coverage`：当前接管方式覆盖哪些流量。
///
/// 它不判「有没有故障」，而是判「上面那些结论代表哪部分流量」：Proxy 模式下
/// 浏览器 HTTP/3 不走 VPN，有些站点因此打不开，而其它检查项看起来全都正常。
///
/// 判据是**连接是否成立 + 走的是哪条路**，不是 `manager.status().state`：
/// TUN 的进程不归 manager 管（`publish_state` 只发事件），拿 manager 状态判
/// 会把 TUN 连接说成「未连接」，把「全接管」这一行变成永远不可达。
///
/// 所以只有三行：`!connected` / `connected && tun` / `connected && !tun`。
/// 「连着但读不到接管方式」不成立——`tun` 已知时，`!tun` 本身就是本机代理；
/// 那种情况若单列一行回「读不到」，等于在实际覆盖范围已知时给出错误结论。
fn network_coverage_check(connected: bool, tun: bool) -> Value {
    if !connected {
        return diag_check(
            "network.coverage",
            "network",
            CheckStatus::Ok,
            "未连接，先连接再检查覆盖".into(),
            None,
            None,
        );
    }
    if tun {
        return diag_check(
            "network.coverage",
            "network",
            CheckStatus::Ok,
            "现在接管全部流量，TCP / UDP / QUIC 都经过 VPN".into(),
            None,
            None,
        );
    }
    diag_check(
        "network.coverage",
        "network",
        CheckStatus::Failed,
        // 说的是「覆盖范围不同」，不是「当前配置不好」：本机代理是产品的默认选择。
        // 这个结论只能用来解释「UDP / QUIC 应用不通」，不能当成反机器人挑战的解释。
        "覆盖范围不同：现在只为本机软件提供代理，浏览器 HTTP/3 不经过 VPN".into(),
        Some("要看全部流量的情况，点「切到全部接管」再测一次"),
        Some(json!({ "kind": "switch_mode", "to": "tun" })),
    )
}

#[cfg(test)]
mod diag_coverage_tests {
    use super::*;

    #[test]
    fn proxy_mode_reports_partial_coverage_and_offers_the_switch() {
        let check = network_coverage_check(true, false);
        assert_eq!(check["status"], "failed", "{check}");
        assert_eq!(check["ok"], false, "{check}");
        assert_eq!(check["action"]["kind"], "switch_mode", "{check}");
        assert_eq!(check["action"]["to"], "tun", "{check}");
        assert!(
            check["detail"].as_str().unwrap().contains("HTTP/3"),
            "{check}"
        );
    }

    #[test]
    fn tun_mode_is_full_coverage_without_an_action() {
        let check = network_coverage_check(true, true);
        assert_eq!(check["status"], "ok", "{check}");
        assert_eq!(check["ok"], true, "{check}");
        assert!(check["action"].is_null(), "{check}");
        assert!(
            check["detail"].as_str().unwrap().contains("QUIC"),
            "{check}"
        );
    }

    #[test]
    fn disconnected_asks_to_connect_first() {
        let check = network_coverage_check(false, false);
        // 契约 §4.13 的覆盖表：未连接仍是 ok（「先连接」不是故障）。
        assert_eq!(check["status"], "ok", "{check}");
        assert_eq!(check["ok"], true, "{check}");
        assert!(
            check["detail"].as_str().unwrap().contains("先连接"),
            "{check}"
        );
    }
}

/// 四项按连接状态分流的检查：`tools.md` §4.13 的「各模式适用表」就是这张表。
/// 字面量全部来自契约/PM 定稿，改字之前先改契约。
#[cfg(test)]
mod diag_connection_tests {
    use super::*;

    fn detail(check: &Value) -> &str {
        check["detail"].as_str().unwrap_or("")
    }

    fn assert_no_advice(check: &Value) {
        assert!(
            check["remediation"].is_null() && check["action"].is_null(),
            "skipped 项不得带建议或动作：{check}"
        );
    }

    #[test]
    fn status_and_ok_never_disagree() {
        for status in [CheckStatus::Ok, CheckStatus::Failed, CheckStatus::Skipped] {
            let check = diag_check("app.version", "app", status, "x".into(), None, None);
            assert_eq!(check["status"], status.as_str(), "{check}");
            assert_eq!(check["ok"], status == CheckStatus::Ok, "{check}");
        }
    }

    #[test]
    fn disconnected_is_not_checked_rather_than_broken() {
        let process = process_alive_check(DiagConnection::Idle, false);
        assert_eq!(process["status"], "skipped", "{process}");
        assert_eq!(detail(&process), "未连接，未检查进程");
        for check in [
            clash_api_check(DiagConnection::Idle, false),
            data_plane_check(DiagConnection::Idle, false),
            exit_ip_check(DiagConnection::Idle, None),
        ] {
            assert_eq!(check["status"], "skipped", "{check}");
            assert_eq!(detail(&check), "未连接");
            assert_no_advice(&check);
        }
        assert_no_advice(&process);
    }

    #[test]
    fn connecting_is_waited_out_not_diagnosed() {
        let process = process_alive_check(DiagConnection::Pending, false);
        assert_eq!(process["status"], "skipped", "{process}");
        assert_eq!(detail(&process), "正在连接，稍后再看");
        for check in [
            clash_api_check(DiagConnection::Pending, false),
            data_plane_check(DiagConnection::Pending, false),
            exit_ip_check(DiagConnection::Pending, None),
        ] {
            assert_eq!(check["status"], "skipped", "{check}");
            assert_eq!(detail(&check), "正在连接");
            assert_no_advice(&check);
        }
        assert_no_advice(&process);
    }

    #[test]
    fn proxy_mode_reports_the_real_health_values() {
        assert_eq!(
            detail(&process_alive_check(DiagConnection::Proxy, true)),
            "sing-box 进程存活"
        );
        let dead = process_alive_check(DiagConnection::Proxy, false);
        assert_eq!(dead["status"], "failed", "{dead}");
        assert_eq!(detail(&dead), "进程没在运行");
        assert_eq!(dead["action"]["kind"], "reconnect", "{dead}");

        let clash = clash_api_check(DiagConnection::Proxy, false);
        assert_eq!(clash["status"], "failed", "{clash}");
        assert_eq!(detail(&clash), "控制面不可用");
        assert_eq!(clash["remediation"], "重新连接后再试", "{clash}");

        assert_eq!(
            detail(&data_plane_check(DiagConnection::Proxy, true)),
            "数据面可用"
        );

        let ip = exit_ip_check(DiagConnection::Proxy, Some("203.0.113.7"));
        assert_eq!(ip["status"], "ok", "{ip}");
        assert_eq!(detail(&ip), "出口 IP 203.0.113.7");
        // 还没探测到 = 没检查，不是失败。
        let unknown = exit_ip_check(DiagConnection::Proxy, None);
        assert_eq!(unknown["status"], "skipped", "{unknown}");
        assert_eq!(detail(&unknown), "还没探测到");
        assert_no_advice(&unknown);
    }

    #[test]
    fn tun_mode_skips_what_it_cannot_check() {
        assert_eq!(
            detail(&process_alive_check(DiagConnection::Tun, true)),
            "隧道进程存活"
        );
        let clash = clash_api_check(DiagConnection::Tun, false);
        assert_eq!(clash["status"], "skipped", "{clash}");
        assert_eq!(detail(&clash), "接管模式下不检查控制面");

        let plane = data_plane_check(DiagConnection::Tun, false);
        assert_eq!(plane["status"], "failed", "{plane}");
        assert_eq!(detail(&plane), "连续两次探测不通");

        // 出口 IP 有值也不能在 TUN 下报：接管模式根本不采集。
        let ip = exit_ip_check(DiagConnection::Tun, Some("203.0.113.7"));
        assert_eq!(ip["status"], "skipped", "{ip}");
        assert_eq!(detail(&ip), "接管模式不采集出口 IP");
        assert_no_advice(&ip);
    }

    /// 启动中的 TUN 快照同样是 `mode = Tun`，但那时进程还没起来：
    /// 必须先判途中状态，否则会报「隧道进程没在运行」。
    #[test]
    fn a_launching_tunnel_is_pending_not_running() {
        let status = crate::runtime::RuntimeStatus::tun_pending(
            crate::runtime::RuntimeState::Starting,
            Some("cfg_tun".into()),
            None,
        );
        assert_eq!(diag_connection(&status, false), DiagConnection::Pending);
    }

    /// TUN 不走系统代理：无残留设置是 skipped，死指针仍是 failed。
    #[test]
    fn the_tunnel_does_not_judge_the_system_proxy_but_catches_dead_pointers() {
        let none: Vec<String> = Vec::new();
        let check = proxy_services_check(DiagConnection::Tun, &none, None, false);
        assert_eq!(check["status"], "skipped", "{check}");
        assert_eq!(detail(&check), "接管模式不用系统代理");
        assert_no_advice(&check);

        let others = vec!["127.0.0.1:1080".to_string()];
        let check = proxy_services_check(DiagConnection::Tun, &others, None, false);
        assert_eq!(check["status"], "skipped", "{check}");
        assert_eq!(detail(&check), "接管模式不用系统代理，1 个服务另有代理设置");

        let check = proxy_services_check(DiagConnection::Tun, &others, None, true);
        assert_eq!(check["status"], "failed", "{check}");
        assert_eq!(detail(&check), "系统代理指向未监听的本地端口");
        assert_eq!(check["action"]["kind"], "restore_network", "{check}");
    }

    /// 代理模式下每个服务都得指向本次的真实端口，否则算失败。
    #[test]
    fn proxy_mode_requires_every_service_to_point_at_our_port() {
        let ours = vec!["127.0.0.1:7890".to_string()];
        let check =
            proxy_services_check(DiagConnection::Proxy, &ours, Some("127.0.0.1:7890"), false);
        assert_eq!(check["status"], "ok", "{check}");

        let wrong = vec!["127.0.0.1:1080".to_string()];
        let check =
            proxy_services_check(DiagConnection::Proxy, &wrong, Some("127.0.0.1:7890"), false);
        assert_eq!(check["status"], "failed", "{check}");
        assert_eq!(check["action"]["kind"], "restore_network", "{check}");
    }

    /// 文案禁区（契约 §4.13）：未连接 / 连接中不得说「未运行」「不可用」，
    /// TUN 下不得说「sing-box 进程未运行」。
    #[test]
    fn the_forbidden_wording_never_appears() {
        for connection in [DiagConnection::Idle, DiagConnection::Pending] {
            for check in [
                process_alive_check(connection, false),
                clash_api_check(connection, false),
                data_plane_check(connection, false),
                exit_ip_check(connection, None),
            ] {
                let text = detail(&check);
                assert!(!text.contains("未运行"), "{check}");
                assert!(!text.contains("不可用"), "{check}");
            }
        }
        let tun = process_alive_check(DiagConnection::Tun, false);
        assert!(!detail(&tun).contains("sing-box"), "{tun}");
        assert_eq!(detail(&tun), "隧道进程没在运行");
    }
}

/// 单节点测速结果的三态：`ok` / `unreachable` / `untested`。///
/// `reachable` 只在测得时是布尔值；`untested` 用 `null`，不能用 `false`
/// 冒充——「没测成」和「连不通」是两件事。
pub(crate) fn probe_ok(node_id: &str, latency_ms: u64) -> Value {
    json!({
        "node_id": node_id,
        "status": "ok",
        "reachable": true,
        "latency_ms": latency_ms,
        "probe_method": "clash_delay",
        "checked_at": store::now_ms(),
        "error": Value::Null,
    })
}

/// 只在 Clash delay 真正失败时出现：经 sing-box 转发过一次但没通。
pub(crate) fn probe_unreachable(node_id: &str, message: &str) -> Value {
    json!({
        "node_id": node_id,
        "status": "unreachable",
        "reachable": false,
        "latency_ms": Value::Null,
        "probe_method": "clash_delay",
        "checked_at": store::now_ms(),
        "error": { "code": "CLASH_DELAY_FAILED", "message": message },
    })
}

pub(crate) fn probe_untested(node_id: &str, reason: &str) -> Value {
    json!({
        "node_id": node_id,
        "status": "untested",
        "reachable": Value::Null,
        "latency_ms": Value::Null,
        "probe_method": "none",
        "checked_at": store::now_ms(),
        "error": {
            "code": "PROBE_UNAVAILABLE",
            "message": probe_untested_message(reason),
            "reason": reason,
        },
    })
}

/// `untested` 的 reason 是封闭集合（契约 `commands.md` §4.4），文案在这里唯一出处。
fn probe_untested_message(reason: &str) -> &'static str {
    match reason {
        "runtime_missing" => "测速用的运行库不可用",
        "runtime_failed" => "测速用的临时运行库没能启动",
        "runtime_timeout" => "测速用的临时运行库在 8 秒内没起来",
        "connection_busy" => "正在连接或切换，稍后再测",
        "other_config" => "已连接别的配置，先断开再测",
        "no_credentials" => "这个节点缺少凭据，先重新添加",
        "clash_unavailable" => "已连接，但读不到测速接口，重新连接一次再试",
        _ => "暂时测不了，稍后再试",
    }
}

/// 单节点测速一条：只记状态、reason 短码与本地节点 id，不记地址、端口或凭据。
fn log_node_probe_outcome(node_id: &str, result: &anyhow::Result<Value>) {
    let Ok(value) = result else {
        let (code, reason) = result
            .as_ref()
            .err()
            .and_then(|error| error.downcast_ref::<ServiceError>())
            .map(|service| {
                let reason = service
                    .details
                    .as_ref()
                    .and_then(|details| details.get("reason"))
                    .and_then(Value::as_str)
                    .unwrap_or("-");
                (service.code.as_str(), reason)
            })
            .unwrap_or(("INTERNAL", "internal"));
        log::info!("[node_probe] status=failed code={code} reason={reason} node={node_id}");
        return;
    };

    let status = value
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or("unknown");
    let reason = value
        .pointer("/error/reason")
        .and_then(Value::as_str)
        .or_else(|| (status == "unreachable").then_some("clash_delay_failed"))
        .unwrap_or("-");
    log::info!("[node_probe] status={status} reason={reason} node={node_id}");
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
pub(crate) async fn clash_delay(addr: &str, secret: &str, tag: &str) -> Result<u64, String> {
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
    probes: Arc<crate::tools::probe_batch::ProbeBatchState>,
    /// 单节点测速冷启动的串行闸门：同时点测多个节点只付一次启动成本。
    probe_start: tokio::sync::Mutex<()>,
    /// 按配置串行：同配置的第二个切换请求直接 `CONFLICT / switch_in_progress`。
    mode_switches: ModeSwitches,
    /// 最近一次 TUN 状态事件的目标状态：事件链的 `from` 用它，
    /// 不能硬编码 idle（失败后再连应当是 failed → starting）。
    tun_event_state: std::sync::Mutex<crate::runtime::RuntimeState>,
    /// 运行期操作锁：重建运行配置与启动/断开互斥；后到的断开排队，重建结束后执行。
    runtime_ops: tokio::sync::Mutex<()>,
    /// 运行期代数：每次真正改变运行时（停掉在跑的东西、重启）都 +1。
    /// 排队中的启动靠它判断「我等的这段时间里运行时是否已被别人取代」。
    ///
    /// 递增入口（全部在 `runtime_ops` 锁内）：
    /// 1. `runtime_start` 的决策段（停旧之后记代；幂等分支不递增）
    /// 2. `runtime_stop` → `runtime_stop_inner`（**每次用户断开都记**，含已 idle：
    ///    重建的「停旧 → 拉起」窗口里连接已不在，只有意图能记下这次断开）
    /// 3. 重建的决策段（复查 → 停旧之后记代）
    /// 4. 重建回滚前（比过代数、确认没被取代之后）
    /// 5. `connect_inner` 换配置前停旧连接（经 `runtime_stop_inner`）
    /// 6. `stop_for_rebuild` 的 TUN 分支（经 `runtime_stop_inner`）
    /// 7. `stop_for_rebuild` 的代理分支（`manager.stop()` 前）
    /// 8. `runtime_restart`（`manager.restart()` 前）
    /// 9. `route_set_mode` 接管未确认后的回滚（只包 `tun.stop()` 那一次）
    /// 10. `repair_restore_direct`（关代理 → 停运行时 → 删明文配置整段）
    /// 11. `force_reset_network` 的停 TUN + 停运行时两步（经 `reset_stop_everything`）
    ///
    /// **不参与代数**：`lifecycle` 退出清理（进程要没了，没有并发启动可误导）、
    /// 以及本次启动自己的回滚（`rollback_proxy_after_enable_failure` /
    /// `stop_for_failed_launch`）——它们收的是自己的实例，递增会把并发启动误判成被取代。
    runtime_epoch: std::sync::atomic::AtomicU64,
    /// 测试用：让接下来 N 次「重建运行配置」的首轮启动失败，验证回滚路径。
    #[cfg(test)]
    rebuild_failures: std::sync::atomic::AtomicUsize,
    /// 测试用：注入的「首轮启动失败」正在等待的标记，供用例对齐并发动作。
    #[cfg(test)]
    rebuild_test_waiting: std::sync::atomic::AtomicUsize,
    /// 测试用：重建进入「取运行期锁」这一步的次数。
    #[cfg(test)]
    rebuild_lock_attempts: std::sync::atomic::AtomicUsize,
    /// 测试用：重建真正拿到运行期锁的次数。
    #[cfg(test)]
    rebuild_lock_acquired: std::sync::atomic::AtomicUsize,
    /// 测试用：用户启动的拉起阶段确实没占着运行期操作锁（`try_lock` 当场成功）。
    #[cfg(test)]
    start_body_without_lock: std::sync::atomic::AtomicBool,
    /// 测试用：重建首轮拉起成功后暂停一次，让用例在「已连上、还没复查」之间插进断开。
    #[cfg(test)]
    rebuild_pause_after_start: std::sync::atomic::AtomicBool,
    /// 测试用：重建回滚拉起前暂停一次，让用例在回滚启动窗口里插进重启/另一次启动。
    #[cfg(test)]
    rebuild_pause_before_rollback: std::sync::atomic::AtomicBool,
    /// 测试用：回滚前暂停正在进行中（与 `rebuild_test_waiting` 分开，避免两个窗口无缝相接）。
    #[cfg(test)]
    rebuild_rollback_paused: std::sync::atomic::AtomicBool,
    /// 测试用：放行回滚前暂停。
    #[cfg(test)]
    rebuild_rollback_release: std::sync::atomic::AtomicBool,
}

/// 切换接管方式的在途闸门。持有 guard 期间同配置的第二次调用会被拒绝。
#[derive(Default)]
struct ModeSwitches {
    busy: std::sync::Mutex<std::collections::HashSet<String>>,
}

struct ModeSwitchGuard<'a> {
    switches: &'a ModeSwitches,
    config_id: String,
}

impl ModeSwitches {
    fn try_begin(&self, config_id: &str) -> Option<ModeSwitchGuard<'_>> {
        let mut busy = self
            .busy
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if !busy.insert(config_id.to_string()) {
            return None;
        }
        Some(ModeSwitchGuard {
            switches: self,
            config_id: config_id.to_string(),
        })
    }
}

impl Drop for ModeSwitchGuard<'_> {
    fn drop(&mut self) {
        self.switches
            .busy
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(&self.config_id);
    }
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
            probes: Arc::new(crate::tools::probe_batch::ProbeBatchState::default()),
            probe_start: tokio::sync::Mutex::new(()),
            mode_switches: ModeSwitches::default(),
            tun_event_state: std::sync::Mutex::new(crate::runtime::RuntimeState::Idle),
            runtime_ops: tokio::sync::Mutex::new(()),
            runtime_epoch: std::sync::atomic::AtomicU64::new(0),
            #[cfg(test)]
            rebuild_failures: std::sync::atomic::AtomicUsize::new(0),
            #[cfg(test)]
            rebuild_test_waiting: std::sync::atomic::AtomicUsize::new(0),
            #[cfg(test)]
            rebuild_lock_attempts: std::sync::atomic::AtomicUsize::new(0),
            #[cfg(test)]
            rebuild_lock_acquired: std::sync::atomic::AtomicUsize::new(0),
            #[cfg(test)]
            start_body_without_lock: std::sync::atomic::AtomicBool::new(false),
            #[cfg(test)]
            rebuild_pause_after_start: std::sync::atomic::AtomicBool::new(false),
            #[cfg(test)]
            rebuild_pause_before_rollback: std::sync::atomic::AtomicBool::new(false),
            #[cfg(test)]
            rebuild_rollback_paused: std::sync::atomic::AtomicBool::new(false),
            #[cfg(test)]
            rebuild_rollback_release: std::sync::atomic::AtomicBool::new(false),
        }
    }

    /// 测试用：下一次重建运行配置的首轮启动按失败处理（回滚路径）。
    #[cfg(test)]
    pub fn fail_next_rebuild_for_test(&self, times: usize) {
        self.rebuild_failures
            .store(times, std::sync::atomic::Ordering::SeqCst);
    }

    /// 测试用：下一次重建的首轮拉起成功后暂停 500ms（期间用例插入断开）。
    #[cfg(test)]
    pub fn pause_after_first_rebuild_start_for_test(&self) {
        self.rebuild_pause_after_start
            .store(true, std::sync::atomic::Ordering::SeqCst);
    }

    /// 测试用：放行「回滚拉起前」的暂停。
    #[cfg(test)]
    pub fn release_rebuild_rollback_for_test(&self) {
        self.rebuild_rollback_release
            .store(true, std::sync::atomic::Ordering::SeqCst);
    }

    /// 测试用：下一次重建的回滚拉起前暂停，直到 `release_rebuild_rollback_for_test`。
    #[cfg(test)]
    pub fn pause_before_rebuild_rollback_for_test(&self) {
        self.rebuild_pause_before_rollback
            .store(true, std::sync::atomic::Ordering::SeqCst);
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

    fn update_connection_mode(
        &self,
        config_id: &str,
        mode: &str,
    ) -> anyhow::Result<configs::Config> {
        {
            let conn = self.store.conn();
            configs::set_connection_mode(&conn, config_id, mode)
                .map_err(|error| svc_error(error.code(), error))?;
        }
        self.require_config(config_id)
    }

    fn effective_region(&self) -> (crate::rules::Region, crate::rules::RegionSource) {
        crate::rules::effective_region(&self.store)
    }

    /// Clash 端点：按当前连接身份选，TUN 与代理模式不互相兜底。
    async fn clash_endpoint(&self, tun_connected: bool) -> Option<(String, String)> {
        let plan = if tun_connected {
            None
        } else {
            self.manager
                .current_plan()
                .await
                .map(|plan| (plan.clash_addr, plan.clash_secret))
        };
        let tun = if tun_connected {
            self.tun.clash_api().map(|api| (api.addr, api.secret))
        } else {
            None
        };
        resolve_clash_endpoint(tun_connected, plan, tun)
    }

    /// 当前连接（TUN 或代理）的完整快照。`runtime_status` 与状态事件共用。
    async fn connection_status(&self) -> crate::runtime::RuntimeStatus {
        if let crate::tun::session::TunState::Running { pid } = self.tun.status() {
            let meta = self.tun.launch_meta();
            let (data_plane, health_checked_at) = self.tun.data_plane_health();
            crate::runtime::RuntimeStatus::tun(crate::runtime::TunSnapshotInput {
                pid,
                config_id: meta.as_ref().map(|meta| meta.config_id.clone()),
                config_name: meta.as_ref().and_then(|meta| meta.config_name.clone()),
                node_id: meta.as_ref().and_then(|meta| meta.node_id.clone()),
                node_name: meta.as_ref().and_then(|meta| meta.node_name.clone()),
                applied_route_revision: meta.as_ref().and_then(|meta| meta.applied_route_revision),
                route_region: meta.as_ref().and_then(|meta| meta.route_region.clone()),
                connected_since: self.tun.connected_since(),
                uptime_seconds: self.tun.uptime_seconds(),
                system_dns: Some(system_dns_label(self.tun.dns_hijack().as_ref()).to_string()),
                data_plane,
                health_checked_at,
            })
        } else {
            self.manager.status().await
        }
    }

    /// 当前可用运行时的版本。`runtime.md` §2.5：未运行时 `upstream_version`
    /// 不得为 `null`（只要还有可用运行时），事件快照同样适用。
    async fn available_runtime_version(&self) -> Option<String> {
        self.available_runtime().await.map(|(version, _)| version)
    }

    /// 最近一次 TUN 事件的目标状态，用作下一条事件的 `from`。
    fn last_tun_state(&self) -> crate::runtime::RuntimeState {
        *self.tun_event_state.lock().unwrap()
    }

    /// TUN 的状态变化并进 manager 的事件流：界面与托盘只订阅这一条。
    fn publish_tun_state(
        &self,
        from: crate::runtime::RuntimeState,
        to: crate::runtime::RuntimeState,
        event: crate::runtime::RuntimeEventKind,
        reason: Option<String>,
        snapshot: crate::runtime::RuntimeStatus,
    ) {
        log::debug!("TUN 状态变化 {from:?} → {to:?} event={event:?}");
        self.manager
            .publish_state(from, to, event, reason, snapshot);
        *self.tun_event_state.lock().unwrap() = to;
    }

    /// 连接状态：TUN 的进程不归 manager 管，必须先看 `TunSession`，
    /// 否则 TUN 已连接时会被当成「未连接」。
    async fn connection_state(&self) -> ConnectionState {
        if let crate::tun::session::TunState::Running { .. } = self.tun.status() {
            let meta = self.tun.launch_meta();
            return ConnectionState {
                connected: true,
                launching: false,
                launching_config: None,
                config_id: meta.as_ref().map(|meta| meta.config_id.clone()),
                applied_route_revision: meta.as_ref().and_then(|meta| meta.applied_route_revision),
                route_region: meta.as_ref().and_then(|meta| meta.route_region.clone()),
                tun: true,
            };
        }
        let status = self.manager.status().await;
        let connected = self.is_connected(&status);
        // 与旧的 `connected_config_id` 一致：状态里没有就回落到 plan。
        let mut config_id = status.config_id.clone();
        if config_id.is_none() {
            config_id = self
                .manager
                .current_plan()
                .await
                .and_then(|plan| plan.config_id);
        }
        ConnectionState {
            connected,
            launching: self.tun.is_launching(),
            launching_config: self.tun.launching_config_id(),
            config_id,
            applied_route_revision: status.applied_route_revision,
            route_region: status.route_region,
            tun: false,
        }
    }

    /// **决策段专用**：TUN 侧只读缓存，不做后端探测。
    ///
    /// `connection_state()` 里的 `tun.status()` 在缓存过期时会 recheck 后端（最长 10s），
    /// 而决策段在 `runtime_ops` 锁内、后面还接着 `stop_for_rebuild` 的 ≤10s，
    /// 两者叠加会把 20s 的用户侧等待顶穿。对外状态仍必须用 `connection_state()`。
    async fn connection_state_cached(&self) -> ConnectionState {
        if matches!(
            self.tun.status_cached(),
            crate::tun::session::TunState::Running { .. }
        ) {
            let meta = self.tun.running_cached().map(|(_, meta)| meta);
            return ConnectionState {
                connected: true,
                launching: false,
                launching_config: None,
                config_id: meta.as_ref().map(|meta| meta.config_id.clone()),
                applied_route_revision: meta.as_ref().and_then(|meta| meta.applied_route_revision),
                route_region: meta.as_ref().and_then(|meta| meta.route_region.clone()),
                tun: true,
            };
        }
        let status = self.manager.status().await;
        let connected = self.is_connected(&status);
        let mut config_id = status.config_id.clone();
        if config_id.is_none() {
            config_id = self
                .manager
                .current_plan()
                .await
                .and_then(|plan| plan.config_id);
        }
        ConnectionState {
            connected,
            launching: self.tun.is_launching(),
            launching_config: self.tun.launching_config_id(),
            config_id,
            applied_route_revision: status.applied_route_revision,
            route_region: status.route_region,
            tun: false,
        }
    }

    /// `network.coverage` 的取值入口。状态必须来自 `connection_state()`（TUN 优先）：
    /// `manager.status()` 看不见 TUN，用它会把 TUN 连接判成「未连接」。
    async fn network_coverage_for(&self) -> Value {
        let connection = self.connection_state().await;
        network_coverage_check(connection.connected, connection.tun)
    }

    /// 诊断的连接判定：**必须**走 `connection_status()`（TUN 优先的统一快照）。
    /// 用 `manager.status()` 会把 TUN 连接说成「未连接」，四项检查全部说假话——
    /// 这就是把取源收成一个方法的原因，也便于用例直接锁住它。
    async fn diag_connection_snapshot(&self) -> (crate::runtime::RuntimeStatus, DiagConnection) {
        let status = self.connection_status().await;
        let connection = diag_connection(&status, self.tun.is_launching());
        (status, connection)
    }

    fn route_state_json(
        &self,
        config: &configs::Config,
        applied_mode: Option<&str>,
        applied_revision: Option<i64>,
        running: bool,
        applied_region: Option<&str>,
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
        let (region, _) = self.effective_region();
        // 已连接时报**运行配置实际用的地区**：用户中途改时区，配置不会重算。
        let basis_region = if running {
            applied_region
        } else {
            region.code()
        };
        let basis = local_direct_basis(basis_region);
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
            "detected_region": region.code(),
            "applied_region": applied_region,
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
        let state = self.route_state_json(config, applied_mode, applied_revision, false, None);
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
                crate::runtime::RuntimeError::BundledUnavailable(detail) => svc_error_with_details(
                    error.code(),
                    format!(
                        "{}（{detail}）",
                        crate::runtime::signature::rejection_hint()
                    ),
                    json!({ "reason": "runtime_unavailable" }),
                ),
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
        let (nodes, layout, layout_revision) = {
            let conn = self.store.conn();
            let nodes = configs::list_nodes(&conn, &config.id)
                .map_err(|error| svc_error(error.code(), error))?;
            // 节点可用性一并算好（需要读 `my_servers` 镜像）：owned 节点对应的
            // 服务器已停机销毁时，AI 才能说出「这条为什么用不了」。
            let nodes: Vec<Value> = nodes
                .iter()
                .map(|node| {
                    let mut value = node_json(node);
                    value["unavailable_reason"] = node_unavailable_reason(&conn, node);
                    value
                })
                .collect();
            let stored = crate::store::layout::get(&conn, &config.id)
                .map_err(|error| svc_error(error.code(), error))?;
            match stored {
                Some((revision, layout)) => (nodes, layout, Some(revision)),
                None => (nodes, Value::Null, None),
            }
        };
        let mut detail = self.config_summary_json(config)?;
        detail["nodes"] = Value::Array(nodes);
        detail["dns"] = config.dns.clone();
        detail["tun_excludes"] = config.tun_excludes.clone();
        detail["layout"] = layout;
        // 与 layout 同源：layout 为 null 时它也是 null。UI 靠它丢弃同配置的迟到事件。
        detail["layout_revision"] = json!(layout_revision);
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
    /// `select_first` 决定配置还没有当前节点时是否自动选中第一个；种子新建必须传
    /// `false`（`tools.md` §4.24），由界面在用户点「连接」时再 `NodeSwitch`。
    fn add_parsed_nodes(
        &self,
        config_id: Option<&str>,
        parsed: &[crate::nodes::ParsedNode],
        source: &str,
        skip_duplicates: bool,
        select_first: bool,
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
                if select_first && config.current_node_id.is_none() {
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

    /// 导入目标：显式 `configId` 只允许是全局配置；省略时懒创建全局配置。
    ///
    /// 全局单配置（`global-config-merge.md` §3.2）：不再有「只进池不绑定」的死状态。
    fn import_target(&self, config_id: Option<&str>) -> anyhow::Result<configs::Config> {
        match config_id {
            Some(id) => {
                let config = self.require_config(id)?;
                let global = {
                    let conn = self.store.conn();
                    configs::global(&conn).map_err(|error| svc_error(error.code(), error))?
                };
                if global.as_ref().map(|global| global.id.as_str()) != Some(config.id.as_str()) {
                    return Err(svc_error_with_details(
                        "CONFLICT",
                        "现在只有一套全局配置，节点只能加到它上面",
                        json!({ "reason": "not_global_config" }),
                    ));
                }
                Ok(config)
            }
            None => {
                let conn = self.store.conn();
                configs::ensure_global(&conn)
                    .map(|(config, _)| config)
                    .map_err(|error| svc_error(error.code(), error))
            }
        }
    }

    /// 种子缓存里的可用节点（已去掉用户排除项）。`None` = 现在没有种子可用。
    fn seed_parsed_nodes(&self) -> anyhow::Result<Option<Vec<crate::nodes::ParsedNode>>> {
        let Some(nodes) = crate::seed::load_nodes(&self.store) else {
            return Ok(None);
        };
        let exclusions = {
            let conn = self.store.conn();
            configs::seed_exclusions(&conn).map_err(|error| svc_error(error.code(), error))?
        };
        Ok(Some(
            nodes
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
                .collect(),
        ))
    }

    /// 刷新成功后把种子节点并入全局配置：一个事务里落行 + 绑定，失败只记日志。
    ///
    /// 刷新本身仍算成功——网络已经更新，没能并入池子不该让用户看到「刷新失败」；
    /// 下一次刷新会补上（幂等）。
    fn merge_seed_into_global_quietly(&self) {
        if let Err(error) = self.merge_seed_into_global() {
            log::warn!("刷新后把种子节点并入全局配置失败（下次刷新会重试）：{error}");
        }
    }

    fn merge_seed_into_global(&self) -> anyhow::Result<()> {
        let parsed = self.seed_parsed_nodes()?.unwrap_or_default();
        self.merge_seed_nodes(&parsed).map(|_| ())
    }

    /// 把 `parsed` 里的种子节点写进池子并并入全局配置；`parsed` 为空时只把池里
    /// 现有的种子节点绑进去（窗口拖入文件已经自己写过节点行）。
    ///
    /// 一个事务覆盖「建行 + 绑节点」；凭据在 `secrets.enc`，不在 SQLite 事务里，
    /// 所以先写。**不改 `current_node_id`**：attach 只追加关联。
    fn merge_seed_nodes(
        &self,
        parsed: &[crate::nodes::ParsedNode],
    ) -> anyhow::Result<(String, Vec<String>)> {
        for node in parsed {
            let key = crate::nodes::source_key(&node.name, &node.server, node.port, &node.method);
            let id = crate::nodes::node_id(configs::SOURCE_SEED, &key);
            crate::secrets::set_secret(&crate::nodes::password_ref(&id), &node.password)
                .map_err(|error| svc_error("SECRET_STORE", error))?;
        }

        let (global_id, attached) = {
            let conn = self.store.conn();
            let tx = conn
                .unchecked_transaction()
                .map_err(|error| svc_error("INTERNAL", error))?;
            let (global, _) =
                configs::ensure_global(&tx).map_err(|error| svc_error(error.code(), error))?;
            for node in parsed {
                let key =
                    crate::nodes::source_key(&node.name, &node.server, node.port, &node.method);
                let id = crate::nodes::node_id(configs::SOURCE_SEED, &key);
                configs::upsert_node(
                    &tx,
                    &configs::NewNode {
                        id: &id,
                        name: &node.name,
                        server: &node.server,
                        port: node.port,
                        method: &node.method,
                        password_ref: &crate::nodes::password_ref(&id),
                        source: configs::SOURCE_SEED,
                        source_key: &key,
                    },
                )
                .map_err(|error| svc_error(error.code(), error))?;
            }
            let exclusions =
                configs::seed_exclusions(&tx).map_err(|error| svc_error(error.code(), error))?;
            let ids = configs::list_nodes_by_source(&tx, configs::SOURCE_SEED)
                .map_err(|error| svc_error(error.code(), error))?
                .into_iter()
                .filter(|node| !exclusions.contains(&node.source_key))
                .map(|node| node.id)
                .collect::<Vec<_>>();
            let (attached, _) = configs::attach_nodes(&tx, &global.id, &ids)
                .map_err(|error| svc_error(error.code(), error))?;
            tx.commit().map_err(|error| svc_error("INTERNAL", error))?;
            (global.id, attached)
        };

        if !attached.is_empty() {
            crate::seed::emit_node_list_changed(
                &self.store,
                "bindings_changed",
                Some(&global_id),
                &attached,
            );
            if let Ok(config) = self.require_config(&global_id) {
                self.emit_config_changed("updated", Some(&config));
            }
        }
        Ok((global_id, attached))
    }

    fn seed_unavailable() -> anyhow::Error {
        svc_error_with_details(
            "PRECONDITION_FAILED",
            "现在拿不到 Veyl 免费节点，先刷新 Veyl 免费节点或手动添加一个",
            json!({ "reason": "seed_unavailable", "hint": "先刷新 Veyl 免费节点或手动添加节点" }),
        )
    }

    /// 把种子缓存里的节点落到当前配置。种子只给节点，分流由配置自己决定。
    fn materialize_seed_nodes(&self, config_id: &str) -> anyhow::Result<usize> {
        let parsed = self
            .seed_parsed_nodes()?
            .ok_or_else(Self::seed_unavailable)?;
        let (added, _) =
            self.add_parsed_nodes(Some(config_id), &parsed, configs::SOURCE_SEED, false, false)?;
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

    fn seed_status_json(
        &self,
        source: &str,
        changed: bool,
        reason: Option<&str>,
        added: Option<i64>,
        removed: Option<i64>,
        removed_node_name: Option<String>,
        replacement_node_name: Option<String>,
    ) -> Value {
        let mut status = crate::seed::status(&self.store);
        // `source = cache` 表示本次没有成功访问远端，用的是本地缓存；
        // `changed = true` 才表示这次刷新真的换了内容。
        status["source"] = json!(source);
        status["changed"] = json!(changed);
        status["reason"] = json!(reason);
        status["added"] = json!(added);
        status["removed"] = json!(removed);
        status["removed_node_name"] = json!(removed_node_name);
        status["replacement_node_name"] = json!(replacement_node_name);
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
        // 启动窗口里还没有 pid，但这套配置同样「正在用」：删掉它等于删掉正在连的东西。
        if let Some(id) = self.tun.launching_config_id() {
            return Some(id);
        }
        self.manager
            .current_plan()
            .await
            .and_then(|plan| plan.config_id)
    }
}

/// `ConfigSetModeData`（`commands.md` §3.7）。
fn mode_data(
    config_id: &str,
    mode: &str,
    previous_mode: &str,
    changed: bool,
    connected: bool,
    restored: bool,
    confirmation: &str,
) -> Value {
    json!({
        "config_id": config_id,
        "mode": mode,
        "previous_mode": previous_mode,
        "changed": changed,
        "connected": connected,
        "restored": restored,
        "confirmation": confirmation,
    })
}

/// 错误里的 `details.reason`，回滚失败时带给工具做说明；没有就是 null。
fn service_reason(error: &anyhow::Error) -> Value {
    error
        .downcast_ref::<ServiceError>()
        .and_then(|service| service.details.as_ref())
        .and_then(|details| details.get("reason"))
        .cloned()
        .unwrap_or(Value::Null)
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

/// 节点为什么当前不可用；只有能确定时才给原因。
///
/// owned 节点的服务器在本地镜像里已是 `destroyed` → `server_destroyed`（镜像层
/// 分不清是用户销毁还是停机删除，那要实时列表；见 `MyServers` 的人话原因）。
/// 其它情况（含种子试用、未测过的节点）返回 null——可用性要靠 `NodeProbe` 实测。
fn node_unavailable_reason(conn: &rusqlite::Connection, node: &configs::Node) -> Value {
    if node.source != crate::store::configs::SOURCE_OWNED || node.source_key.is_empty() {
        return Value::Null;
    }
    match crate::store::servers::get(conn, &node.source_key) {
        Ok(Some(row)) if row.state == "destroyed" => json!("server_destroyed"),
        _ => Value::Null,
    }
}

/// 本地直连的判定依据。未知地区没有本地层，不能报 `ip_only`。
fn local_direct_basis(region: Option<&str>) -> &'static str {
    match region {
        Some("cn") => "domain_and_ip",
        Some(_) => "ip_only",
        None => "none",
    }
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
    if matches!(value, configs::ROUTING_DIRECT | configs::ROUTING_PROXY_ALL) {
        return Ok(());
    }
    // `proxy_selected` 是已知但已下线的值：读旧数据可以，写入路径一律拒绝。
    if value == configs::ROUTING_PROXY_SELECTED {
        return Err(svc_error_with_details(
            "INVALID_ARGUMENT",
            "分流方式只有 direct / proxy_all 两档",
            json!({ "reason": "routing_mode_not_supported" }),
        ));
    }
    Err(svc_error_with_details(
        "INVALID_ARGUMENT",
        format!("不支持的分流策略：{value}"),
        json!({ "reason": "invalid_routing_mode" }),
    ))
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

/// 连接状态的统一视图：TUN 与代理模式都映射到这里，调用方不再各自读 manager。
struct ConnectionState {
    connected: bool,
    /// 有 start 在途、还没起来（TUN 首次启动十几秒）。这期间不能再当成「没在连接」。
    launching: bool,
    /// 在途启动对应的配置；没有在途启动时为 None。
    launching_config: Option<String>,
    config_id: Option<String>,
    applied_route_revision: Option<i64>,
    route_region: Option<String>,
    tun: bool,
}

/// Clash 端点按**连接身份**选：TUN 连接只用 TUN 的 `ClashApi`，代理连接只用
/// manager 的 plan。不能互相兜底——旧 plan 可能把 selector 写进另一个进程。
fn resolve_clash_endpoint(
    tun_connected: bool,
    plan: Option<(String, String)>,
    tun: Option<(String, String)>,
) -> Option<(String, String)> {
    if tun_connected {
        tun
    } else {
        plan
    }
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

impl WiredServices {
    /// 取运行期操作锁；排太久如实报 TIMEOUT，不让界面一直等。
    /// 排队超时不是操作失败：标成可重试，界面给「再试一次」。
    async fn lock_runtime_ops(&self) -> anyhow::Result<tokio::sync::MutexGuard<'_, ()>> {
        match tokio::time::timeout(RUNTIME_OP_LOCK_TIMEOUT, self.runtime_ops.lock()).await {
            Ok(guard) => Ok(guard),
            Err(_) => Err(runtime_busy_error()),
        }
    }

    /// 重建用：拿不到锁就把这次重建降级成「下次连接可用」，不阻塞 attach。
    async fn lock_runtime_ops_skipped(
        &self,
        what: &str,
    ) -> Result<tokio::sync::MutexGuard<'_, ()>, Value> {
        match tokio::time::timeout(RUNTIME_REBUILD_LOCK_TIMEOUT, self.runtime_ops.lock()).await {
            Ok(guard) => Ok(guard),
            Err(_) => {
                log::warn!("{what}：等运行期操作锁超时，跳过本次");
                Err(json!({ "status": "skipped", "reason": "runtime_busy" }))
            }
        }
    }

    /// 运行期代数 +1，返回新值。
    ///
    /// **只允许在持有 `runtime_ops` 时调用**：递增点本身也在锁内，
    /// 读代数与改变运行时必须在同一个临界区里比较，否则连点两次会互相看漏。
    fn bump_runtime_epoch(&self) -> u64 {
        self.runtime_epoch
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst)
            + 1
    }

    /// 当前运行期代数。**只允许在持有 `runtime_ops` 时调用**（理由同上）。
    /// 例外：拉起前的取代检查（`ensure_start_is_current`）在锁外读一次，
    /// 那里只用来「提前放弃」，最终结论仍以收尾段锁内比对为准。
    fn current_runtime_epoch(&self) -> u64 {
        self.runtime_epoch.load(std::sync::atomic::Ordering::SeqCst)
    }

    /// 拉起前的最后一道取代检查：决策段记下的代数已经不是当前值，说明期间有
    /// 新的启动 / 断开 / 重建跑过，再拉起只会变成「显示已连接、实际被接管」。
    fn ensure_start_is_current(&self, epoch: Option<u64>) -> anyhow::Result<()> {
        let Some(epoch) = epoch else {
            return Ok(());
        };
        if self.current_runtime_epoch() == epoch {
            return Ok(());
        }
        log::warn!("启动已被新的运行期操作取代（epoch={epoch}），不再拉起");
        Err(cancelled_connection_error())
    }

    async fn runtime_start_inner(&self, config_id: Option<String>) -> anyhow::Result<Value> {
        // 用户开始连接：正在跑的测速批次让路，finished.reason = "connected"。
        // 探针运行时先停掉，不做进程移交；正常连接随后自己起。
        self.probes.cancel_for_connection();
        self.manager.stop_probe().await;
        if crate::lifecycle::is_quitting() {
            return Err(with_connect_changed(
                svc_error_with_details(
                    "PRECONDITION_FAILED",
                    "应用正在退出，不能再发起连接",
                    json!({ "reason": "quitting" }),
                ),
                "none",
            ));
        }
        let config_id = match config_id {
            Some(id) => id,
            None => self.active_config_id().ok_or_else(|| {
                with_connect_changed(
                    svc_error_with_details(
                        "PRECONDITION_FAILED",
                        "还没有配置，先新建一套",
                        json!({ "reason": "no_config" }),
                    ),
                    "none",
                )
            })?,
        };
        let config = self
            .require_config(&config_id)
            .map_err(|error| with_connect_changed(error, "none"))?;
        self.connect(&config).await
    }

    async fn runtime_stop_inner(&self, _force: bool) -> anyhow::Result<Value> {
        let started = std::time::Instant::now();
        let connected = self.connected_config_id().await;
        // 断开前的现场：模式、配置、运行时状态。事后判断「停的时候到底是什么在跑」。
        let before = self.manager.status().await;
        let tun_running = matches!(
            self.tun.status(),
            crate::tun::session::TunState::Running { .. }
        );
        // 启动窗口里 stop 也必须算数：此时还没 pid，但确实有一次连接在途。
        let tun_launching = self.tun.is_launching();
        let tun_live = tun_running || tun_launching;
        // 每一次用户断开都记一笔意图——**即使当前没有东西在跑**。
        // 重建的「停旧 → 拉起」窗口里按下的断开，连接此刻已经不在了，
        // 只有意图能把它记录下来，否则回滚会把用户刚断开的连接接回来
        // （契约 §4.0.1 `user_disconnected`）。
        self.bump_runtime_epoch();
        // 停止失败时要如实报出「哪套配置没停掉」：`stop` 内部会清掉在途登记。
        let stop_config = if tun_launching {
            self.tun.launching_config_id()
        } else {
            connected.clone()
        };
        // TUN 的断开同样要进事件流：主界面与托盘都靠它才知道「真的断了」。
        // 运行时版本一次操作只查一次：它要起 `sing-box version` 并验签，别为每条事件重复付。
        let mut tun_runtime_version: Option<String> = None;
        if tun_live {
            tun_runtime_version = self.available_runtime_version().await;
            let snapshot = if tun_running {
                let mut snapshot = self.connection_status().await;
                snapshot.state = crate::runtime::RuntimeState::Stopping;
                snapshot
            } else {
                crate::runtime::RuntimeStatus::tun_pending(
                    crate::runtime::RuntimeState::Stopping,
                    self.tun.launching_config_id(),
                    tun_runtime_version.clone(),
                )
            };
            // `from` 跟上一条 TUN 事件（停过一次失败后再断，接的是 failed 而不是 running）；
            // 只有从没发过事件时（接手旧连接 / 测试夹具）才按现实补一个。
            let from = match self.last_tun_state() {
                crate::runtime::RuntimeState::Idle if tun_running => {
                    crate::runtime::RuntimeState::Running
                }
                crate::runtime::RuntimeState::Idle if tun_launching => {
                    crate::runtime::RuntimeState::Starting
                }
                other => other,
            };
            self.publish_tun_state(
                from,
                crate::runtime::RuntimeState::Stopping,
                crate::runtime::RuntimeEventKind::StopReq,
                None,
                snapshot,
            );
        }
        let mode = if tun_running || tun_launching {
            "tun"
        } else if before.mode.is_some() {
            "system_proxy"
        } else {
            "none"
        };
        log::info!(
            "断开：模式={mode} 配置={:?} 运行时状态={} TUN运行中={tun_running} TUN启动中={tun_launching}",
            connected,
            before.state.as_str()
        );

        // TUN 的 sing-box 是 helper 的子进程，manager 的 stop 碰不到它，单独停。
        // 幂等：本来就没在跑时直接返回。
        // 停不掉不能吞：界面上显示已停、流量却还在被接管，比报错糟得多。
        let tun_started = std::time::Instant::now();
        let tun_stop_error = self.tun.stop().err();
        let tun_ms = tun_started.elapsed().as_millis();
        match &tun_stop_error {
            None => log::info!("断开：停 TUN 成功 耗时={tun_ms}ms"),
            Some(error) => log::warn!(
                "断开：停 TUN 失败 耗时={tun_ms}ms code={:?} 原因={}",
                error.code,
                error.message
            ),
        }
        if tun_live && tun_stop_error.is_none() {
            // TUN 已经真的停了：立刻发 idle，界面与托盘先一步达成一致。
            self.publish_tun_state(
                crate::runtime::RuntimeState::Stopping,
                crate::runtime::RuntimeState::Idle,
                crate::runtime::RuntimeEventKind::Stopped,
                None,
                crate::runtime::RuntimeStatus::tun_pending(
                    crate::runtime::RuntimeState::Idle,
                    None,
                    tun_runtime_version.clone(),
                ),
            );
        }

        let proxy_started = std::time::Instant::now();
        let proxy_result = self.restore_system_proxy();
        let proxy_ms = proxy_started.elapsed().as_millis();
        match &proxy_result {
            Ok(()) => log::info!("断开：撤系统代理成功 耗时={proxy_ms}ms"),
            Err(error) => log::warn!("断开：撤系统代理失败 耗时={proxy_ms}ms 原因={error:#}"),
        }
        proxy_result?;
        self.manager.set_system_proxy_enabled(false).await;

        let runtime_started = std::time::Instant::now();
        let stopped = self.manager.stop().await;
        let runtime_ms = runtime_started.elapsed().as_millis();
        let status = match stopped {
            Ok(status) => {
                log::info!(
                    "断开：停运行时成功 耗时={runtime_ms}ms 状态={}",
                    status.state.as_str()
                );
                status
            }
            Err(error) => {
                log::warn!(
                    "断开：停运行时失败 耗时={runtime_ms}ms code={} 原因={}",
                    error.code(),
                    error
                );
                return Err(svc_error(error.code(), error));
            }
        };
        // 断开即删明文配置：它只在连接期间允许存在。
        if let Some(config_id) = connected {
            vpn_config::remove_profile_config(&self.config_dir(), &config_id);
        }
        if let Some(error) = tun_stop_error {
            log::warn!(
                "断开未完成：TUN 没停掉 code={:?} 原因={} 运行时状态={} 系统代理={} 总耗时={}ms",
                error.code,
                error.message,
                status.state.as_str(),
                if status.system_proxy_enabled {
                    "仍开启"
                } else {
                    "已关闭"
                },
                started.elapsed().as_millis()
            );
            // 停在 stopping 会让界面与托盘分叉；但也绝不能报 running——登记已被清掉，
            // 那样会得到「在跑却没有 pid / 配置」的假快照。如实报失败并带上原因。
            if tun_live {
                let mut snapshot = crate::runtime::RuntimeStatus::tun_pending(
                    crate::runtime::RuntimeState::Failed,
                    stop_config,
                    tun_runtime_version,
                );
                snapshot.last_error = Some(crate::runtime::RuntimeErrorInfo {
                    contract_version: crate::runtime::CONTRACT_VERSION,
                    code: "INTERNAL".into(),
                    message: format!("特权连接没有停掉：{}", error.message),
                    retryable: false,
                    details: None,
                    request_id: String::new(),
                });
                self.publish_tun_state(
                    crate::runtime::RuntimeState::Stopping,
                    crate::runtime::RuntimeState::Failed,
                    crate::runtime::RuntimeEventKind::GiveUp,
                    Some(format!("stop_failed: {}", error.message)),
                    snapshot,
                );
            }
            return Err(svc_error_with_details(
                "INTERNAL",
                format!("特权连接没有停掉：{}", error.message),
                // 理由仍只出四种；停不掉的具体原因在 wire_code / local_code 里。
                tun_error_details(&error),
            ));
        }
        log::info!(
            "断开完成：状态={} 系统代理={} 总耗时={}ms",
            status.state.as_str(),
            if status.system_proxy_enabled {
                "仍开启"
            } else {
                "已关闭"
            },
            started.elapsed().as_millis()
        );
        serde_json::to_value(status).map_err(|e| svc_error("INTERNAL", e))
    }

    /// 经当前连接的 Clash API 测一个节点：唯一算「测得」的口径。
    async fn probe_through_clash(&self, node: &configs::Node, addr: &str, secret: &str) -> Value {
        match clash_delay(addr, secret, &format!("node-{}", node.id)).await {
            Ok(latency) => probe_ok(&node.id, latency),
            Err(message) => probe_unreachable(&node.id, &message),
        }
    }

    /// 空闲时用哪套配置起临时探针：优先当前配置，其次任一包含该节点的配置。
    fn probe_config_for_node(&self, candidates: &[String]) -> anyhow::Result<configs::Config> {
        let active = self.active_config_id();
        let config_id = active
            .filter(|id| candidates.iter().any(|candidate| candidate == id))
            .or_else(|| candidates.first().cloned())
            .ok_or_else(|| {
                svc_error_with_details(
                    "PRECONDITION_FAILED",
                    "这个节点不在任何配置里，先把它加到配置里再测",
                    json!({ "reason": "node_not_in_config" }),
                )
            })?;
        self.require_config(&config_id)
    }

    /// 完全空闲时测一个节点：起一次临时运行时，同一配置 60 秒内复用。
    async fn probe_with_idle_runtime(
        &self,
        node: &configs::Node,
        config: &configs::Config,
    ) -> Value {
        use crate::runtime::RuntimeState;
        use crate::tools::probe_batch;

        // 串行化冷启动：两个测速同时点，只该有一个付启动成本。
        let _starting = self.probe_start.lock().await;

        // 等锁期间用户可能已经开始连接。
        let connection = self.connection_state().await;
        let runtime_state = self.manager.status().await.state;
        if connection.launching
            || connection.connected
            || matches!(
                runtime_state,
                RuntimeState::Starting | RuntimeState::Restarting | RuntimeState::Stopping
            )
            || self.probes.has_running_batch()
        {
            return probe_untested(&node.id, "connection_busy");
        }

        let (target, started_generation) = match self.probes.idle_target(&config.id) {
            Some(target) if self.manager.probe_healthy().await => (target, None),
            _ => {
                let (generation, cancel) = self.probes.begin_idle_probe();
                let installed = match self.ensure_runtime().await {
                    Ok(installed) => installed,
                    Err(_) => return probe_untested(&node.id, "runtime_missing"),
                };
                match probe_batch::start_probe_runtime(
                    Arc::clone(&self.store),
                    Arc::clone(&self.manager),
                    &self.data_dir,
                    config,
                    &installed,
                    &cancel,
                )
                .await
                {
                    Ok(target) => (target, Some(generation)),
                    Err(failure) => return probe_untested(&node.id, failure.reason()),
                }
            }
        };

        let result = self
            .probe_through_clash(node, &target.addr, &target.secret)
            .await;
        // 探测期间用户可能已经开始连接：那时报「没测成」比报「连不通」准确。
        if result.get("status").and_then(Value::as_str) == Some("unreachable") {
            let connection = self.connection_state().await;
            if connection.connected || connection.launching {
                self.stop_probe_if_ours(&target).await;
                return probe_untested(&node.id, "connection_busy");
            }
        }
        match self
            .probes
            .note_idle(&config.id, &target, started_generation)
        {
            Some(generation) => self.spawn_idle_probe_expiry(generation),
            None => {
                // 槽位已经被别人（连接 / 批次）接管：只收掉确实是这只探针的进程。
                self.stop_probe_if_ours(&target).await;
                // 失败结果可能是「探针被中途收掉」造成的，不能当成连不通。
                if result.get("status").and_then(Value::as_str) == Some("unreachable") {
                    return probe_untested(&node.id, "connection_busy");
                }
            }
        }
        result
    }

    /// 只停「自己起的那只」探针：槽位可能已经被连接或批次换成了新的运行时。
    async fn stop_probe_if_ours(&self, target: &crate::tools::probe_batch::ClashTarget) {
        if self.manager.probe_secret().await.as_deref() == Some(target.secret.as_str()) {
            self.manager.stop_probe().await;
        }
    }

    /// 60 秒空闲复用到点后停掉探针；新一代探针已经产生时这个定时器自然失效。
    fn spawn_idle_probe_expiry(&self, generation: u64) {
        let probes = Arc::clone(&self.probes);
        let manager = Arc::clone(&self.manager);
        tokio::spawn(async move {
            tokio::time::sleep(crate::tools::probe_batch::IDLE_TTL).await;
            if probes.expire_idle(generation) {
                manager.stop_probe().await;
            }
        });
    }
}

#[async_trait]
impl VpnToolServices for WiredServices {
    async fn runtime_status(&self) -> anyhow::Result<Value> {
        // TUN 的进程不归 RuntimeManager 管，状态得单独报，否则界面会显示「未连接」。
        // **必须返回与代理模式同形状的完整快照**：手工拼 JSON 少一个 `health`
        // 就会让 `bridge.ts` 读 undefined 直接崩（helper 在 App 崩溃后仍存活的接手场景）。
        let mut status = self.connection_status().await;

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
        // 锁只护决策段（幂等判断、停旧、记代）；拉起与 TUN start 在锁外，
        // 见 `connect_inner`。这里不再整段持锁：一次冷启动最长 90 秒，
        // 占着锁会让期间的断开排队到超时。
        let result = self.runtime_start_inner(config_id).await;
        // 试用钩子必须在锁外：它可能触发到期断开（`runtime_stop` 要再取这把锁）。
        if let Ok(snapshot) = &result {
            self.note_trial_connection(snapshot).await;
        }
        result
    }

    async fn trial_status(&self) -> anyhow::Result<Value> {
        let conn = self.store.conn();
        crate::trial::status_json(&conn).map_err(|error| svc_error(error.code(), error))
    }

    /// 到期清理：数据库事务先提交，之后才断连；断连失败不回滚。
    ///
    /// 返回 `Some` 只会在第一次写入 `ended_at` 时发生，所以 `trial-expired`
    /// 每台机器最多发一次。
    async fn check_trial_expiry(&self) -> anyhow::Result<()> {
        if let Some(expired) = self.expire_trial_store()? {
            self.finish_trial_expiry(expired).await;
        }
        Ok(())
    }

    async fn runtime_stop(&self, force: bool) -> anyhow::Result<Value> {
        // 与重建的决策段互斥：重建已经在锁外拉起时，这次断开不再排队，
        // 而是记一笔意图把那次重建取代（契约 §4.0.1 `user_disconnected`）。
        let _ops = self.lock_runtime_ops().await?;
        self.runtime_stop_inner(force).await
    }

    async fn runtime_restart(&self, _reason: Option<String>) -> anyhow::Result<Value> {
        let _ops = self.lock_runtime_ops().await?;
        self.bump_runtime_epoch();
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
        let netstat =
            crate::netcfg::run("/usr/sbin/netstat", &["-rn", "-f", "inet"]).unwrap_or_default();
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
                                node_line =
                                    format!("{}:{} 直连失败：{error}", node.server, node.port);
                                false
                            }
                            Err(_) => {
                                node_line = format!("{}:{} 直连超时（4s）", node.server, node.port);
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
        let alive = crate::runtime::process::is_alive(pid);
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

    async fn my_servers(&self) -> anyhow::Result<Value> {
        let servers = crate::control_plane::servers::list()
            .await
            .map_err(|error| svc_error(&error.code, error.message.clone()))?;
        // 只给用户能理解的字段：地址**可以**给（用户已同意 AI 能看到自己服务器的 IP，
        // 用于排障）；端口、密码、节点 id 与其它内部字段不给。
        let summaries: Vec<Value> = servers
            .into_iter()
            .map(|server| {
                json!({
                    "server_id": server.server_id,
                    "name": server.name,
                    "region": server.region,
                    "state": server.state,
                    "ip": server.ip,
                    // 能否用来建配置看本地节点行，不看控制面 `node_id`（active 后就有值）。
                    "node_ready": server.local_node_id.is_some(),
                    "monthly_usd": server.monthly_usd,
                    "daily_price_cents": server.daily_price_cents,
                    "transfer_gib": server.transfer_gib,
                    "failure": server.failure.map(|failure| json!({
                        "code": failure.code,
                        "message": failure.message,
                        "retryable": failure.retryable,
                    })),
                })
            })
            .collect();
        Ok(json!({ "servers": summaries }))
    }

    async fn my_server_failure(&self, server_id: &str) -> anyhow::Result<Value> {
        let row = {
            let conn = self.store.conn();
            crate::store::servers::get(&conn, server_id)
                .map_err(|error| svc_error(error.code(), error))?
        };
        let Some(row) = row else {
            return Err(svc_error_with_details(
                "NOT_FOUND",
                "找不到这台服务器",
                json!({ "reason": "server_not_found" }),
            ));
        };

        // 只读 Host 已有的内存镜像：不重新拉控制面，也不访问云厂商 API。
        let failure = crate::control_plane::servers::server_failure(server_id);
        let order = crate::control_plane::servers::latest_order_for_server(server_id);
        let (order_json, recent_events) = match &order {
            Some(order) => (
                json!({
                    "order_id": order.order_id,
                    "state": order.state,
                    "failure": order.failure.as_ref().map(|failure| json!({
                        "code": failure.code,
                        "message": failure.message,
                        "retryable": failure.retryable,
                    })),
                }),
                crate::control_plane::servers::recent_order_events(&order.order_id, 20),
            ),
            None => (Value::Null, Vec::new()),
        };

        Ok(json!({
            "server_id": row.id,
            "name": row.name,
            "region": row.region,
            "plan": row.plan,
            "state": row.state,
            "failure": failure,
            "order": order_json,
            "recent_events": recent_events,
            // 控制面不保存建机原始日志；模型不得声称读过。
            "log_available": false,
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

    async fn config_detail(&self, config_id: Option<String>) -> anyhow::Result<Value> {
        let config = self.resolve_config(config_id)?;
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

        // 连接状态要能看见 TUN：manager 只认识代理模式。
        // 启动窗口里也算「有连接」：否则新配置会在旧配置正在起来时抢占 active，
        // 而连接成功路径用的是开始时的 is_active 快照，界面上就会分叉。
        let connection = self.connection_state().await;
        let running = connection.connected || connection.launching;
        // 只返回 `seed_unavailable`，不在这里刷新重试：是否刷新由上层决定一次。
        if source.as_deref() == Some("seed") && crate::seed::load_nodes(&self.store).is_none() {
            return Err(svc_error_with_details(
                "PRECONDITION_FAILED",
                "现在拿不到 Veyl 免费节点",
                json!({
                    "reason": "seed_unavailable",
                    "hint": "先刷新 Veyl 免费节点或手动添加节点"
                }),
            ));
        }

        // 全局单配置：已有配置就拒绝，替代原来的 duplicate_name 路径。
        // 放在参数校验之后：非法参数仍按 INVALID_ARGUMENT 报，不被 config_exists 盖掉。
        {
            let conn = self.store.conn();
            let existing =
                configs::global(&conn).map_err(|error| svc_error(error.code(), error))?;
            if existing.is_some() {
                return Err(svc_error_with_details(
                    "CONFLICT",
                    "现在只有一套全局配置，新节点用 node_attach 加进节点池",
                    json!({ "reason": "config_exists" }),
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

    async fn config_delete(&self, _config_id: &str) -> anyhow::Result<Value> {
        // 全局配置是节点池的唯一载体：删了它，节点与连接参数都没有落点。
        Err(svc_error_with_details(
            "PRECONDITION_FAILED",
            "全局配置不能删除；不需要的节点从节点池里移除",
            json!({ "reason": "only_config" }),
        ))
    }

    async fn config_activate(&self, config_id: &str) -> anyhow::Result<Value> {
        // 全局单配置：只有一行，切配置这件事已经没有意义。
        let global = {
            let conn = self.store.conn();
            configs::global(&conn).map_err(|error| svc_error(error.code(), error))?
        };
        match global {
            Some(global) if global.id == config_id => {
                // 幂等成功：界面重新载入时仍会调一次。
                if !global.is_active {
                    let conn = self.store.conn();
                    configs::activate(&conn, &global.id)
                        .map_err(|error| svc_error(error.code(), error))?;
                }
                Ok(json!({
                    "active_config_id": global.id,
                    "changed": false,
                    "runtime": self.runtime_status().await?,
                }))
            }
            _ => Err(svc_error_with_details(
                "CONFLICT",
                "现在只有一套全局配置，没有可切换的配置",
                json!({ "reason": "single_config" }),
            )),
        }
    }

    async fn node_import_url(&self, config_id: Option<String>, url: &str) -> anyhow::Result<Value> {
        // 省略 configId = 绑定全局配置；没有配置时懒创建。
        let target = self.import_target(config_id.as_deref())?;
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
            Some(&target.id),
            &subscription.nodes,
            configs::SOURCE_URL,
            true,
            false,
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
                Some(&target.id),
                &added_ids,
            );
        }
        if !added.is_empty() {
            if let Ok(config) = self.require_config(&target.id) {
                self.emit_config_changed("updated", Some(&config));
            }
        }

        Ok(json!({
            "imported": added.len(),
            "skipped": skipped,
            "nodes": added.iter().map(node_json).collect::<Vec<_>>(),
        }))
    }

    /// 粘贴导入：与订阅解析共用同一套逐行逻辑，但不联网。
    async fn node_import_text(
        &self,
        config_id: Option<String>,
        text: &str,
    ) -> anyhow::Result<Value> {
        // 省略 configId = 绑定全局配置；没有配置时懒创建。
        let target = self.import_target(config_id.as_deref())?;
        let subscription = crate::nodes::parse_subscription(text).map_err(|error| {
            log::debug!("粘贴导入解析失败：{error}");
            svc_error_with_details(
                "INVALID_ARGUMENT",
                "粘贴的内容里没有可用的节点（支持多行 ss:// 链接）",
                json!({ "reason": "not_node_text" }),
            )
        })?;
        // 粘贴来的节点算「手动添加」：来源是用户自己，不是我们替他拉取。
        let (added, duplicates) = self.add_parsed_nodes(
            Some(&target.id),
            &subscription.nodes,
            configs::SOURCE_MANUAL,
            true,
            false,
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
                "manual_create",
                Some(&target.id),
                &added_ids,
            );
        }
        if !added.is_empty() {
            if let Ok(config) = self.require_config(&target.id) {
                self.emit_config_changed("updated", Some(&config));
            }
        }

        Ok(json!({
            "imported": added.len(),
            "skipped": skipped,
            "nodes": added.iter().map(node_json).collect::<Vec<_>>(),
        }))
    }

    async fn node_create(&self, input: NodeCreateInput) -> anyhow::Result<Value> {
        let target = self.import_target(input.config_id.as_deref())?;
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
            Some(&target.id),
            &[parsed],
            configs::SOURCE_MANUAL,
            false,
            false,
        )?;
        let node = added
            .first()
            .ok_or_else(|| svc_error("INTERNAL", "节点写入失败"))?;
        let added_ids = vec![node.id.clone()];
        crate::seed::emit_node_list_changed(
            &self.store,
            "manual_create",
            Some(&target.id),
            &added_ids,
        );
        if let Ok(config) = self.require_config(&target.id) {
            self.emit_config_changed("updated", Some(&config));
        }
        // 手动添加也走同一套：连接中加进来就重建运行配置，让节点立刻可用。
        // 有人正在切换接管方式时不排队，如实告诉界面「下次连接可用」。
        let runtime_rebuild = match self.mode_switches.try_begin(&target.id) {
            Some(_rebuild_guard) => match self.require_config(&target.id) {
                Ok(config) => self.rebuild_running_config(&config, &added_ids).await,
                Err(_) => json!({ "status": "skipped", "reason": "config_missing" }),
            },
            None => json!({ "status": "skipped", "reason": "switch_in_progress" }),
        };
        let mut result = node_json(node);
        // 新节点必然是可用状态；字段与 `NodeSummary` 对齐（2.45.5 起非可选）。
        result["unavailable_reason"] = Value::Null;
        if let Some(object) = result.as_object_mut() {
            object.insert("runtime_rebuild".into(), runtime_rebuild);
        }
        Ok(result)
    }

    /// UI：把节点绑进全局配置（`global-config-merge.md` §3.3）。
    ///
    /// `source` 与 `nodeIds` 二选一；幂等；**永远不改 `current_node_id`**。
    async fn node_attach(
        &self,
        source: Option<String>,
        node_ids: Option<Vec<String>>,
        config_id: Option<String>,
    ) -> anyhow::Result<Value> {
        let source = source
            .map(|value| value.trim().to_ascii_lowercase())
            .filter(|value| !value.is_empty());
        let node_ids = node_ids.filter(|ids| !ids.is_empty());
        match (&source, &node_ids) {
            (None, None) => {
                return Err(svc_error_with_details(
                    "INVALID_ARGUMENT",
                    "必须指定节点来源：source=seed 或 nodeIds",
                    json!({ "reason": "source_required" }),
                ));
            }
            (Some(_), Some(_)) => {
                return Err(svc_error_with_details(
                    "INVALID_ARGUMENT",
                    "source 与 nodeIds 不能同时使用",
                    json!({ "reason": "source_and_node_ids_conflict" }),
                ));
            }
            _ => {}
        }
        if let Some(source) = &source {
            if source != "seed" {
                return Err(svc_error_with_details(
                    "INVALID_ARGUMENT",
                    "source 只支持 seed",
                    json!({ "reason": "invalid_source" }),
                ));
            }
        }

        // 种子先确认拿得到：拿不到就不该顺手建出一套空配置。
        let seed_nodes = if source.is_some() {
            Some(
                self.seed_parsed_nodes()?
                    .ok_or_else(Self::seed_unavailable)?,
            )
        } else {
            None
        };

        // 守卫先于懒创建：被拒的请求不能先在库里留下一套空配置。
        // 运行时正在换连接（stopping / starting / restarting，或 TUN 在途）：
        // 此时绑进来的节点不在已渲染的配置里，会让界面与隧道各看各的。
        let runtime = self.manager.status().await;
        if matches!(
            runtime.state,
            crate::runtime::RuntimeState::Starting
                | crate::runtime::RuntimeState::Stopping
                | crate::runtime::RuntimeState::Restarting
        ) || self.tun.is_launching()
        {
            return Err(svc_error_retryable(
                "CONFLICT",
                "运行时正在切换连接，等它结束再绑定节点",
                json!({ "reason": "switch_in_progress" }),
            ));
        }
        // 同一套配置正在切换接管方式：两边一起改池子会让「界面看到的」与「正在起的」分叉。
        // 已经有一套配置时先拿守卫；空库没有可冲突的切换，懒创建之后再补拿。
        let existing_global = {
            let conn = self.store.conn();
            configs::global(&conn).map_err(|error| svc_error(error.code(), error))?
        };
        let held = match &existing_global {
            Some(existing) => {
                Some(self.mode_switches.try_begin(&existing.id).ok_or_else(|| {
                    svc_error_retryable(
                        "CONFLICT",
                        "这套配置正在切换接管方式，等它结束再试",
                        json!({ "reason": "switch_in_progress" }),
                    )
                })?)
            }
            None => None,
        };

        let (global, created_config) = {
            let conn = self.store.conn();
            configs::ensure_global(&conn).map_err(|error| svc_error(error.code(), error))?
        };
        if let Some(config_id) = config_id.as_deref() {
            if config_id != global.id {
                return Err(svc_error_with_details(
                    "CONFLICT",
                    "现在只有一套全局配置，节点只能绑到它上面",
                    json!({ "reason": "not_global_config" }),
                ));
            }
        }
        let _attach = match held {
            Some(guard) => guard,
            None => self.mode_switches.try_begin(&global.id).ok_or_else(|| {
                svc_error_retryable(
                    "CONFLICT",
                    "这套配置正在切换接管方式，等它结束再试",
                    json!({ "reason": "switch_in_progress" }),
                )
            })?,
        };

        let candidates: Vec<String> = if let Some(parsed) = seed_nodes {
            self.add_parsed_nodes(None, &parsed, configs::SOURCE_SEED, false, false)?;
            let conn = self.store.conn();
            let exclusions =
                configs::seed_exclusions(&conn).map_err(|error| svc_error(error.code(), error))?;
            configs::list_nodes_by_source(&conn, configs::SOURCE_SEED)
                .map_err(|error| svc_error(error.code(), error))?
                .into_iter()
                .filter(|node| !exclusions.contains(&node.source_key))
                .map(|node| node.id)
                .collect()
        } else {
            let ids = node_ids.unwrap_or_default();
            let missing = {
                let conn = self.store.conn();
                configs::missing_nodes(&conn, &ids)
                    .map_err(|error| svc_error(error.code(), error))?
            };
            if !missing.is_empty() {
                return Err(svc_error_with_details(
                    "NOT_FOUND",
                    "有节点不存在",
                    json!({ "reason": "node_not_found", "node_ids": missing }),
                ));
            }
            ids
        };

        // 同一批里重复的 id 只算第一次：attach_nodes 会把第二次报成「已存在」。
        let mut unique = Vec::new();
        let mut seen = std::collections::HashSet::new();
        for id in candidates {
            if seen.insert(id.clone()) {
                unique.push(id);
            }
        }

        let (attached, skipped) = {
            let conn = self.store.conn();
            configs::attach_nodes(&conn, &global.id, &unique)
                .map_err(|error| svc_error(error.code(), error))?
        };
        let node_count = {
            let conn = self.store.conn();
            configs::node_count(&conn, &global.id)
                .map_err(|error| svc_error(error.code(), error))?
        };
        let current_node_id = self
            .require_config(&global.id)
            .map(|config| config.current_node_id)
            .unwrap_or(None);

        if !attached.is_empty() {
            crate::seed::emit_node_list_changed(
                &self.store,
                "bindings_changed",
                Some(&global.id),
                &attached,
            );
            if let Ok(config) = self.require_config(&global.id) {
                self.emit_config_changed("updated", Some(&config));
            }
        }

        // 新节点要立刻能用：连接中就让运行配置重建一次。失败不影响 attach 本身，
        // 节点已进池，下次连接会带上；原因写在返回的 `runtime_rebuild` 里。
        let runtime_rebuild = if attached.is_empty() {
            Value::Null
        } else {
            self.rebuild_running_config(&global, &attached).await
        };

        Ok(json!({
            "config_id": global.id,
            "created_config": created_config,
            "attached_node_ids": attached,
            "skipped_node_ids": skipped,
            "node_count": node_count,
            "current_node_id": current_node_id,
            "runtime_rebuild": runtime_rebuild,
        }))
    }

    async fn node_switch(&self, config_id: &str, node_id: &str) -> anyhow::Result<Value> {
        // 幂等判断在闸之前：重建或接管切换期间点「当前节点」不改任何东西，
        // 不该被 `switch_in_progress` 拦掉——重建中点一下正在用的节点很常见。
        let config = self.require_config(config_id)?;
        let previous = config.current_node_id.clone();
        let connection = self.connection_state().await;
        let connected = connection.connected;
        // 启动窗口里也要算「有连接」：隧道还没起来，selector 不存在，
        // 这时改库会让「库里记的节点」和「隧道实际用的节点」分叉。
        let live = connection.connected || connection.launching;
        let live_config = if connection.connected {
            connection.config_id.clone()
        } else {
            connection.launching_config.clone()
        };

        if previous.as_deref() == Some(node_id) {
            return Ok(json!({
                "config_id": config_id,
                "node_id": node_id,
                "previous_node_id": previous,
                "connected": connected,
                "runtime": if live {
                    self.runtime_status().await?
                } else {
                    Value::Null
                },
            }));
        }

        // 与自动重建、接管方式切换共用一把闸：重建期间改选择会让「库里记的」
        // 和正在起的运行配置分叉。
        let _switch = self.mode_switches.try_begin(config_id).ok_or_else(|| {
            svc_error_retryable(
                "CONFLICT",
                "连接正在切换，稍后再切换节点",
                json!({ "reason": "switch_in_progress" }),
            )
        })?;
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

        // 有任何启动在途都拒绝：隧道正按启动那一刻捕获的节点起来，replace 之后
        // 库里记的节点和实际在跑的会再次分叉。等它连上或断开再改。
        if connection.launching {
            return Err(svc_error_with_details(
                "PRECONDITION_FAILED",
                "连接进行中，稍后再切换节点",
                json!({ "reason": "config_launching" }),
            ));
        }

        // 代理连接的 Starting/Stopping 不在 `connection` 里：此时 `connected` /
        // `launching` 都为 false，但运行配置正在换。只改库会让界面与隧道分叉。
        {
            let runtime = self.manager.status().await;
            if matches!(
                runtime.state,
                crate::runtime::RuntimeState::Starting
                    | crate::runtime::RuntimeState::Stopping
                    | crate::runtime::RuntimeState::Restarting
            ) {
                return Err(svc_error_with_details(
                    "PRECONDITION_FAILED",
                    "连接正在切换，稍后再切换节点",
                    json!({ "reason": "config_launching" }),
                ));
            }
        }

        // 别的配置在启动时，本套仍是「没在连」：允许先记好节点选择，不碰在途连接。
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

        if live_config.as_deref() != Some(config_id) {
            // 接手老 TUN 时 meta 里没有配置 id；这和「连的是另一套」不是同一件事。
            let config_unknown = connection.tun && live_config.is_none();
            return Err(svc_error_with_details(
                "PRECONDITION_FAILED",
                if config_unknown {
                    "当前接管连接读不到用的是哪套配置；先断开再切换节点"
                } else {
                    "这套配置不是当前连接的配置"
                },
                json!({
                    "reason": if config_unknown {
                        "config_unknown"
                    } else {
                        "config_not_running"
                    }
                }),
            ));
        }

        let (clash_addr, clash_secret) =
            self.clash_endpoint(connection.tun).await.ok_or_else(|| {
                svc_error_with_details(
                    "PRECONDITION_FAILED",
                    "当前没有运行中的配置",
                    json!({ "reason": "config_not_running" }),
                )
            })?;
        let to_tag = format!("node-{node_id}");
        // 本次连接的 selector 是按**连接那一刻**的节点池渲染的：之后才加进池的节点
        // 不在里面，启动时解析失败的节点也会被 TUN 剔除。先查成员表，分清是哪一种，
        // 别把「连接后新增」也说成域名解析失败。
        let target_server = members
            .iter()
            .find(|node| node.id == node_id)
            .map(|node| node.server.clone());
        match clash_selector_members(&clash_addr, &clash_secret, "proxy").await {
            Ok(tags) if !tags.is_empty() && !tags.iter().any(|tag| tag == &to_tag) => {
                // 现在能解析 ⇒ 这台机器是连接之后才进池的，重连一次就能用；
                // 现在也解析不出来 ⇒ 确实是启动时被剔除的那一类。
                let resolves = match target_server.as_deref() {
                    Some(server) => node_server_resolves_now(server).await,
                    None => true,
                };
                let (detail_reason, message) = if resolves {
                    (
                        "node_not_in_running_config",
                        "这个节点是连接后新增的，重新连接一次就能用它",
                    )
                } else {
                    (
                        "node_server_unresolved",
                        "这个节点在本次连接中不可用（服务器域名解析失败），请检查网络或换一个节点",
                    )
                };
                return Err(svc_error_with_details(
                    "PRECONDITION_FAILED",
                    message,
                    json!({
                        "reason": "runtime_switch_failed",
                        "detail": { "reason": detail_reason },
                        "node_id": node_id,
                    }),
                ));
            }
            Ok(_) => {}
            // 读不到成员表不据此拒绝，继续走原来的 PUT 路径。
            Err(error) => log::warn!("读取 selector 成员失败，跳过预检：{error}"),
        }
        if let Err(error) = clash_put_selector(&clash_addr, &clash_secret, "proxy", &to_tag).await {
            return Err(svc_error_with_details(
                "PRECONDITION_FAILED",
                format!("切换节点失败：{error}"),
                json!({ "reason": "runtime_switch_failed" }),
            ));
        }
        let read_back = clash_get_selector(&clash_addr, &clash_secret, "proxy").await;
        if !matches!(read_back, Ok(Some(ref now)) if now == &to_tag) {
            if let Some(previous) = &previous {
                let _ = clash_put_selector(
                    &clash_addr,
                    &clash_secret,
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
        // TUN 的 meta 不在 manager 里，单独同步，界面刷新后才显示新节点。
        if connection.tun {
            self.tun.set_current_node(node_id, &node_name);
        } else {
            self.manager
                .set_plan_node(node_id.to_string(), node_name)
                .await;
        }
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

        let runtime = self.runtime_status().await?;
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
        let result = async {
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
            let connection = self.connection_state().await;
            let runtime_state = self.manager.status().await.state;

            // 连接启动 / 切换在途：运行时槽位随时可能被接管，这时的延迟数字不可信。
            if connection.launching
                || matches!(
                    runtime_state,
                    crate::runtime::RuntimeState::Starting
                        | crate::runtime::RuntimeState::Restarting
                        | crate::runtime::RuntimeState::Stopping
                )
            {
                return Ok(probe_untested(node_id, "connection_busy"));
            }

            // 运行时在跑：只测属于当前连接配置的节点（不要求是选中节点）。
            if connection.connected {
                let in_connected_config = connection
                    .config_id
                    .as_ref()
                    .map(|id| candidates.iter().any(|candidate| candidate == id))
                    .unwrap_or(false);
                // TUN 起不了第二个运行时；proxy 模式也一律不起，避免双进程与端口/路由耦合。
                if !in_connected_config {
                    return Ok(probe_untested(node_id, "other_config"));
                }
                let Some((addr, secret)) = self.clash_endpoint(connection.tun).await else {
                    return Ok(probe_untested(node_id, "clash_unavailable"));
                };
                return Ok(self.probe_through_clash(&node, &addr, &secret).await);
            }

            // 没连接也没在启动：只有运行时完全空闲才值得临时起一个。
            if !matches!(
                runtime_state,
                crate::runtime::RuntimeState::Idle | crate::runtime::RuntimeState::Failed
            ) {
                return Ok(probe_untested(node_id, "connection_busy"));
            }
            let has_credentials = crate::secrets::get_secret(&node.password_ref)
                .ok()
                .flatten()
                .is_some();
            if !has_credentials {
                return Ok(probe_untested(node_id, "no_credentials"));
            }
            let config = self.probe_config_for_node(&candidates)?;
            Ok(self.probe_with_idle_runtime(&node, &config).await)
        }
        .await;
        log_node_probe_outcome(node_id, &result);
        result
    }

    async fn node_probe_all(
        &self,
        config_id: Option<String>,
        node_ids: Option<Vec<String>>,
    ) -> anyhow::Result<Value> {
        use crate::tools::probe_batch;

        let config = self.resolve_config(config_id)?;
        let all_nodes = {
            let conn = self.store.conn();
            configs::list_nodes(&conn, &config.id)
                .map_err(|error| svc_error(error.code(), error))?
        };
        // 「测这 N 个」只测该配置里的 id；未知 id 忽略并在返回里点名。
        let (nodes, ignored_node_ids) = probe_batch::select_nodes(&all_nodes, node_ids.as_deref());
        if nodes.is_empty() {
            return Err(svc_error_with_details(
                "PRECONDITION_FAILED",
                "这套配置还没有节点，先添加节点再测速",
                json!({ "reason": "no_nodes" }),
            ));
        }

        // 一批只用一种方式，而且只有两种：已连接本配置用当前 Clash 延迟；
        // 完全空闲时起一次临时探针运行时。不起第二个运行时、也不降级 TCP。
        let connection = self.connection_state().await;
        let runtime_state = self.manager.status().await.state;
        let launching = connection.launching
            || matches!(
                runtime_state,
                crate::runtime::RuntimeState::Starting
                    | crate::runtime::RuntimeState::Restarting
                    | crate::runtime::RuntimeState::Stopping
            );

        enum BatchRoute {
            Clash(probe_batch::ClashTarget),
            Untested(&'static str),
            Idle(Option<crate::runtime::InstalledRuntime>),
        }

        let route = if launching {
            BatchRoute::Untested("connection_busy")
        } else if connection.connected {
            if connection.config_id.as_deref() == Some(config.id.as_str()) {
                match self.clash_endpoint(connection.tun).await {
                    Some((addr, secret)) => {
                        BatchRoute::Clash(probe_batch::ClashTarget { addr, secret })
                    }
                    None => BatchRoute::Untested("clash_unavailable"),
                }
            } else {
                // TUN 起不了第二个运行时；proxy 模式也一律不起，避免双进程与端口/路由耦合。
                BatchRoute::Untested("other_config")
            }
        } else if !matches!(
            runtime_state,
            crate::runtime::RuntimeState::Idle | crate::runtime::RuntimeState::Failed
        ) {
            BatchRoute::Untested("connection_busy")
        } else {
            BatchRoute::Idle(self.ensure_runtime().await.ok())
        };

        let method = match &route {
            BatchRoute::Clash(_) => "clash",
            BatchRoute::Untested(_) => "none",
            BatchRoute::Idle(Some(_)) => "clash",
            BatchRoute::Idle(None) => "none",
        };

        let started = match self.probes.start(&config.id, nodes.len(), method) {
            Ok(started) => started,
            Err(run_id) => {
                return Err(svc_error_with_details(
                    "BUSY",
                    "已有一批测速在进行",
                    json!({ "run_id": run_id }),
                ))
            }
        };

        let run_id = started.run_id.clone();
        let total = started.total;
        let state = Arc::clone(&self.probes);
        let manager = Arc::clone(&self.manager);
        let store = Arc::clone(&self.store);
        let data_dir = self.data_dir.clone();
        let probe_config = config.clone();
        let meta = started.meta;
        let cancel = meta.cancel_token();
        tokio::spawn(async move {
            match route {
                BatchRoute::Clash(target) => {
                    let probe = move |node: &configs::Node| {
                        let node = node.clone();
                        let target = target.clone();
                        async move { probe_batch::probe_node(&node, &target).await }
                    };
                    let _ = probe_batch::run_batch(state, meta, nodes, probe).await;
                }
                BatchRoute::Untested(reason) => {
                    let probe = move |node: &configs::Node| {
                        let id = node.id.clone();
                        async move { probe_untested(&id, reason) }
                    };
                    let _ = probe_batch::run_batch(state, meta, nodes, probe).await;
                }
                BatchRoute::Idle(installed) => {
                    // 批次开始：空闲探针的复用资格立即作废，进程交给这一批。
                    state.cancel_idle();
                    probe_batch::emit_preparing(&meta);
                    let target = match installed {
                        Some(installed) if !cancel.is_cancelled() => {
                            probe_batch::start_probe_runtime(
                                store,
                                Arc::clone(&manager),
                                &data_dir,
                                &probe_config,
                                &installed,
                                &cancel,
                            )
                            .await
                        }
                        Some(_) => Err(probe_batch::ProbeFailure::Cancelled),
                        None => Err(probe_batch::ProbeFailure::Missing),
                    };
                    match target {
                        Ok(target) => {
                            probe_batch::set_method(&meta, "clash");
                            let probe = move |node: &configs::Node| {
                                let node = node.clone();
                                let target = target.clone();
                                async move { probe_batch::probe_node(&node, &target).await }
                            };
                            let _ = probe_batch::run_batch_probing(state, meta, nodes, probe).await;
                        }
                        Err(failure) => {
                            // 起不来就整批标成未测：同一句原因写进每个节点结果。
                            probe_batch::set_method(&meta, "none");
                            let reason = failure.reason();
                            let probe = move |node: &configs::Node| {
                                let id = node.id.clone();
                                async move { probe_untested(&id, reason) }
                            };
                            let _ = probe_batch::run_batch_probing(state, meta, nodes, probe).await;
                        }
                    }
                    manager.stop_probe().await;
                }
            }
        });

        Ok(json!({
            "run_id": run_id,
            "config_id": config.id,
            "total": total,
            "concurrency": probe_batch::CONCURRENCY,
            "ignored_node_ids": ignored_node_ids,
        }))
    }

    async fn node_probe_cancel(&self, run_id: &str) -> anyhow::Result<Value> {
        Ok(json!({ "cancelled": self.probes.cancel(run_id) }))
    }

    async fn node_probe_snapshot(&self, config_id: Option<String>) -> anyhow::Result<Value> {
        let config = self.resolve_config(config_id)?;
        let nodes = {
            let conn = self.store.conn();
            configs::list_nodes(&conn, &config.id)
                .map_err(|error| svc_error(error.code(), error))?
        };
        let node_ids: Vec<String> = nodes.iter().map(|node| node.id.clone()).collect();
        let (results, run) = self.probes.snapshot(&config.id, &node_ids);
        Ok(json!({
            "config_id": config.id,
            "results": results,
            "run": run,
        }))
    }

    async fn default_profile_status(&self) -> anyhow::Result<Value> {
        Ok(self.seed_status_json("cache", false, None, None, None, None, None))
    }

    async fn default_profile_refresh(&self, force: bool) -> anyhow::Result<Value> {
        // 已连接（含 TUN）或正在连接时只标记「下次连接生效」，不直接改在线连接。
        let connection = self.connection_state().await;
        let running = connection.connected || connection.launching;
        match crate::seed::refresh(&self.store, running, force).await {
            crate::seed::RefreshOutcome::Updated {
                added,
                removed,
                removed_node_name,
                replacement_node_name,
                ..
            } => {
                // 刷新成功后把种子节点并进全局配置：模型没有 node_attach 可调，
                // 这一步不做，整条免费节点链路在 AI 侧就是断的。
                self.merge_seed_into_global_quietly();
                Ok(self.seed_status_json(
                    "network",
                    true,
                    None,
                    added,
                    removed,
                    removed_node_name,
                    replacement_node_name,
                ))
            }
            crate::seed::RefreshOutcome::Unchanged { .. } => {
                self.merge_seed_into_global_quietly();
                Ok(self.seed_status_json("network", false, None, Some(0), Some(0), None, None))
            }
            crate::seed::RefreshOutcome::Offline {
                cached: true,
                reason,
                ..
            } => Ok(self.seed_status_json(
                "cache",
                false,
                Some(reason.as_str()),
                None,
                None,
                None,
                None,
            )),
            crate::seed::RefreshOutcome::Offline {
                cached: false,
                error,
                reason,
            } => {
                let code = match reason {
                    crate::seed::OfflineReason::InvalidContent => "INVALID_ARGUMENT",
                    crate::seed::OfflineReason::StaleSource => "UPSTREAM_ERROR",
                    crate::seed::OfflineReason::LocalWrite => "INTERNAL",
                    crate::seed::OfflineReason::Offline => "UPSTREAM_ERROR",
                };
                Err(svc_error_with_details(
                    code,
                    format!("现在拿不到 Veyl 免费节点：{error}"),
                    json!({ "reason": reason.as_str(), "detail": { "reason": reason.as_str() } }),
                ))
            }
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

        // 窗口拖进来的种子节点也要进全局配置：节点行已由 merge_file_nodes 写好，
        // 这里只补绑定（幂等、不改当前节点）。失败只记日志，文件本身已导入成功。
        if let Err(error) = self.merge_seed_nodes(&[]) {
            log::warn!("窗口拖入种子后并入全局配置失败（下次刷新会重试）：{error}");
        }

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
        let connection = self.connection_state().await;
        let running =
            connection.connected && connection.config_id.as_deref() == Some(config.id.as_str());
        let applied_mode = running.then(|| config.routing_mode.clone());
        let applied_revision = if running {
            connection.applied_route_revision
        } else {
            None
        };
        let applied_region = if running {
            connection.route_region.clone()
        } else {
            None
        };
        Ok(self.route_state_json(
            &config,
            applied_mode.as_deref(),
            applied_revision,
            running,
            applied_region.as_deref(),
        ))
    }

    async fn system_region(&self) -> anyhow::Result<Value> {
        let (region, source) = self.effective_region();
        Ok(json!({
            "region": region.code(),
            "source": source.as_str(),
        }))
    }

    async fn set_user_region(&self, region: &str) -> anyhow::Result<Value> {
        let parsed = crate::rules::Region::from_code(region);
        let Some(code) = parsed.code().map(str::to_string) else {
            return Err(svc_error_with_details(
                "INVALID_ARGUMENT",
                "地区必须是两字母国家/地区代码",
                json!({ "reason": "invalid_region" }),
            ));
        };
        let existing = {
            let conn = self.store.conn();
            crate::store::settings::get(&conn, crate::store::settings::USER_REGION_KEY)
                .ok()
                .flatten()
                .map(|value| crate::rules::Region::from_code(&value))
        };
        // 同一地区重复写入：成功但不发事件（`tools.md` §5.2 幂等矩阵）。
        if existing == Some(parsed.clone()) {
            return Ok(json!({
                "region": code,
                "source": crate::rules::RegionSource::Ai.as_str(),
            }));
        }
        {
            let conn = self.store.conn();
            crate::store::settings::set(&conn, crate::store::settings::USER_REGION_KEY, &code)
                .map_err(|error| svc_error("INTERNAL", error))?;
        }
        crate::agent::app_handle::emit(
            "region-changed",
            region_changed_payload(&parsed, crate::rules::RegionSource::Ai),
        );
        Ok(json!({
            "region": code,
            "source": crate::rules::RegionSource::Ai.as_str(),
        }))
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

        let conn = self.connection_state().await;
        let running = conn.connected && conn.config_id.as_deref() == Some(config.id.as_str());
        let applied_mode = running.then(|| config.routing_mode.clone());
        let applied_revision = if running {
            conn.applied_route_revision
        } else {
            None
        };
        let applied_region = if running {
            conn.route_region.clone()
        } else {
            None
        };

        // 有连接在跑但读不到它是哪套配置（接手老 TUN）：不能静默写库后说「下次生效」。
        // 幂等分支在上面先返回：设成当前值时仍给快照，不报错。

        if config.routing_mode == mode {
            let mut data = self.route_state_json(
                &config,
                applied_mode.as_deref(),
                applied_revision,
                running,
                applied_region.as_deref(),
            );
            data["hot_switched"] = json!(false);
            data["reconnect"] = Value::Null;
            return Ok(data);
        }

        if conn.connected && conn.config_id.is_none() {
            return Err(svc_error_with_details(
                "PRECONDITION_FAILED",
                "有一个接管连接在运行，但读不到它用的是哪套配置；先重连再切换分流方式",
                json!({ "reason": "config_unknown" }),
            ));
        }

        let same_family = matches!(
            config.routing_mode.as_str(),
            configs::ROUTING_DIRECT | configs::ROUTING_PROXY_ALL
        ) && matches!(mode, configs::ROUTING_DIRECT | configs::ROUTING_PROXY_ALL);

        if running && same_family {
            let (clash_addr, clash_secret) =
                self.clash_endpoint(conn.tun).await.ok_or_else(|| {
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
            if let Err(error) =
                clash_put_selector(&clash_addr, &clash_secret, "route-local", to_selector).await
            {
                return Err(svc_error_with_details(
                    "PRECONDITION_FAILED",
                    format!("切换分流模式失败：{error}"),
                    json!({ "reason": "route_switch_failed" }),
                ));
            }
            let read_back = clash_get_selector(&clash_addr, &clash_secret, "route-local").await;
            let applied = matches!(read_back, Ok(Some(ref now)) if now == to_selector);
            if !applied {
                let _ =
                    clash_put_selector(&clash_addr, &clash_secret, "route-local", from_selector)
                        .await;
                return Err(svc_error_with_details(
                    "PRECONDITION_FAILED",
                    "切换分流模式后读回不一致",
                    json!({ "reason": "route_switch_failed" }),
                ));
            }

            let updated = self.update_routing_mode(&config.id, mode)?;
            self.emit_routing_changed(&updated, "mode", Some(mode), applied_revision, true);
            let mut data = self.route_state_json(
                &updated,
                Some(mode),
                applied_revision,
                true,
                applied_region.as_deref(),
            );
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
            let mut data = self.route_state_json(&updated, None, None, false, None);
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
                    // 自己起的运行时收尾：停成功才算回到调用前；停不掉就只能是 unknown。
                    // 停 TUN 也是改运行时：进锁并在停之前递增。取不到锁就不在锁外停
                    // （会和启动/重建交错），如实按停不掉处理。
                    let stop_error = match self.lock_runtime_ops().await {
                        Ok(_ops) => {
                            self.bump_runtime_epoch();
                            self.tun.stop().err()
                        }
                        Err(error) => {
                            log::error!(
                                "接管未确认后要停 TUN，但运行期操作锁排队超时；不在锁外停：{error}"
                            );
                            Some(crate::tun::backend::TunError::new(
                                crate::tun::backend::TunErrorCode::Timeout,
                                "等运行期操作锁超时，没有停 TUN",
                            ))
                        }
                    };
                    if let Some(error) = &stop_error {
                        log::warn!("接管未确认后停止 TUN 失败：{error}");
                    }
                    let changed = if stop_error.is_none() {
                        "restored"
                    } else {
                        "unknown"
                    };
                    self.emit_routing_changed(&updated, "mode", None, None, false);
                    let mut data = self.route_state_json(&updated, None, None, false, None);
                    data["hot_switched"] = json!(false);
                    data["reconnect"] = json!("reconnect_failed");
                    data["runtime_state"] = json!("tun_unconfirmed");
                    data["connect_changed"] = json!(changed);
                    return Ok(data);
                }
                let after = self.connection_state().await;
                self.emit_routing_changed(
                    &updated,
                    "mode",
                    Some(mode),
                    after.applied_route_revision,
                    false,
                );
                let mut data = self.route_state_json(
                    &updated,
                    Some(mode),
                    after.applied_route_revision,
                    true,
                    after.route_region.as_deref(),
                );
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
                let changed = error
                    .downcast_ref::<ServiceError>()
                    .and_then(|service| service.details.as_ref())
                    .and_then(|details| details.get("connect_changed"))
                    .and_then(Value::as_str)
                    .unwrap_or("unknown")
                    .to_string();
                let mut data = self.route_state_json(&updated, None, None, false, None);
                data["hot_switched"] = json!(false);
                data["reconnect"] = json!("reconnect_failed");
                data["runtime_state"] = json!(status.state.as_str());
                data["connect_changed"] = json!(changed);
                Ok(data)
            }
        }
    }

    /// 在线切换接管方式。断线只发生在这一条命令里，其它字段仍按「只写库」。
    async fn config_set_mode(
        &self,
        config_id: Option<String>,
        mode: &str,
        confirmed: bool,
    ) -> anyhow::Result<Value> {
        validate_connect_mode(mode)?;
        if crate::lifecycle::is_quitting() {
            return Err(svc_error_with_details(
                "PRECONDITION_FAILED",
                "应用正在退出，不能切换接管方式",
                json!({ "reason": "quitting" }),
            ));
        }
        let config = self.resolve_config(config_id)?;
        let previous_mode = config.connection_mode.clone();

        // 同配置串行：第二个请求直接拒绝，不排队、不各停各起。
        let _switch = self.mode_switches.try_begin(&config.id).ok_or_else(|| {
            svc_error_retryable(
                "CONFLICT",
                "这套配置正在切换接管方式，等它结束再试",
                json!({ "reason": "switch_in_progress" }),
            )
        })?;

        let connection = self.connection_state().await;
        // 代理运行时在启动窗口里 `connected` 还是 false，但它同样「正在用这套配置」；
        // 只写库会把旧方式的连接留在后台。
        let proxy_starting = matches!(
            self.manager.status().await.state,
            crate::runtime::RuntimeState::Starting | crate::runtime::RuntimeState::Restarting
        );
        // 接管连接在跑但读不到属于哪套（接手旧 TUN）：不写库、不停起、不重试。
        if (connection.connected && connection.config_id.is_none())
            || (connection.launching && connection.launching_config.is_none())
            || (proxy_starting && connection.config_id.is_none())
        {
            return Err(svc_error_with_details(
                "PRECONDITION_FAILED",
                "有一个接管连接在运行，但读不到它用的是哪套配置；先重连再切换接管方式",
                json!({ "reason": "config_unknown" }),
            ));
        }
        let running = (connection.connected
            && connection.config_id.as_deref() == Some(config.id.as_str()))
            || (connection.launching
                && connection.launching_config.as_deref() == Some(config.id.as_str()))
            || (proxy_starting && connection.config_id.as_deref() == Some(config.id.as_str()));

        if previous_mode == mode {
            return Ok(mode_data(
                &config.id,
                mode,
                &previous_mode,
                false,
                running,
                true,
                "not_needed",
            ));
        }

        // 正在连这套配置（含启动窗口）：没有确认就不许停它。
        // 门禁必须在这里，调用方先查一次 runtime_status 会漏掉 launching / starting。
        if running && !confirmed {
            return Err(svc_error_with_details(
                "PRECONDITION_FAILED",
                "切换接管方式会短暂断开当前连接，需要用户确认",
                json!({
                    "reason": "confirmation_required",
                    "config_id": config.id.clone(),
                    "mode": mode,
                    "previous_mode": previous_mode,
                    "will_disconnect": true,
                }),
            ));
        }

        if !running {
            let updated = self.update_connection_mode(&config.id, mode)?;
            self.emit_config_changed("updated", Some(&updated));
            return Ok(mode_data(
                &config.id,
                mode,
                &previous_mode,
                true,
                false,
                true,
                "not_needed",
            ));
        }

        // 这套正在跑：停 → 写 → 用新模式起。停不掉就什么都不改。
        if let Err(error) = self.runtime_stop(false).await {
            let live = {
                let state = self.connection_state().await;
                state.connected || state.launching
            };
            return Err(with_mode_context(
                error,
                json!({
                    "config_id": config.id.clone(),
                    "mode": mode,
                    "previous_mode": previous_mode,
                    "target_mode": mode,
                    "changed": false,
                    "connected": live,
                }),
            ));
        }
        let updated = self.update_connection_mode(&config.id, mode)?;

        match self.runtime_start(Some(updated.id.clone())).await {
            Ok(_) => {
                self.emit_config_changed("updated", Some(&updated));
                Ok(mode_data(
                    &config.id,
                    mode,
                    &previous_mode,
                    true,
                    true,
                    true,
                    "accepted",
                ))
            }
            Err(first) => {
                // 回滚：写回旧值，再用旧模式重启。错误码始终用首次失败那个。
                match self.update_connection_mode(&config.id, &previous_mode) {
                    Ok(restored_config) => {
                        match self.runtime_start(Some(restored_config.id.clone())).await {
                            Ok(_) => Err(with_mode_context(
                                first,
                                json!({
                                    "config_id": config.id.clone(),
                                    "mode": mode,
                                    "previous_mode": previous_mode,
                                    "target_mode": mode,
                                    "changed": false,
                                    "connected": true,
                                    "restored": true,
                                }),
                            )),
                            Err(second) => Err(with_mode_context(
                                first,
                                json!({
                                    "config_id": config.id.clone(),
                                    "mode": mode,
                                    "previous_mode": previous_mode,
                                    "target_mode": mode,
                                    "changed": false,
                                    "connected": false,
                                    "restored": false,
                                    "rollback_reason": service_reason(&second),
                                }),
                            )),
                        }
                    }
                    Err(rollback_error) => {
                        // 库里已是新方式、连接停在断开态：界面必须能看见这个事实。
                        if let Ok(current) = self.require_config(&config.id) {
                            self.emit_config_changed("updated", Some(&current));
                        }
                        Err(with_mode_context(
                            first,
                            json!({
                                "config_id": config.id.clone(),
                                "mode": mode,
                                "previous_mode": previous_mode,
                                "target_mode": mode,
                                "changed": true,
                                "connected": false,
                                "restored": false,
                                "rollback_reason": service_reason(&rollback_error),
                            }),
                        ))
                    }
                }
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
        // 已连接且跑的就是这套配置时，基础口径按运行配置的地区报（TUN 也算连接）。
        let conn = self.connection_state().await;
        let running = conn.connected && conn.config_id.as_deref() == Some(config_id);
        let applied_region = if running {
            conn.route_region.clone()
        } else {
            None
        };
        Ok(self.route_state_json(&updated, None, None, running, applied_region.as_deref()))
    }

    async fn vpn_connect(&self, config_id: Option<String>) -> anyhow::Result<Value> {
        self.runtime_start(config_id).await
    }

    async fn vpn_disconnect(&self) -> anyhow::Result<Value> {
        self.runtime_stop(false).await
    }

    async fn diag_run(&self, include_logs: bool) -> anyhow::Result<Value> {
        let (status, connection) = self.diag_connection_snapshot().await;
        let running = matches!(connection, DiagConnection::Proxy | DiagConnection::Tun);
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
            if available {
                CheckStatus::Ok
            } else {
                CheckStatus::Failed
            },
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
        checks.push(process_alive_check(connection, status.health.process));
        let version = status
            .upstream_version
            .clone()
            .or_else(|| available_runtime.map(|(version, _)| version));
        checks.push(diag_check(
            "app.version",
            "app",
            if version.is_some() {
                CheckStatus::Ok
            } else {
                CheckStatus::Failed
            },
            version
                .clone()
                .map(|value| format!("运行时版本 {value}"))
                .unwrap_or_else(|| "没有可用的运行时版本".into()),
            None,
            None,
        ));
        checks.push(config_valid_check(connection, &status));
        checks.push(clash_api_check(connection, status.health.clash_api));
        checks.push(data_plane_check(connection, status.health.data_plane));

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
                checks.push(proxy_services_check(
                    connection,
                    &endpoints,
                    expected.as_deref(),
                    dead_loopback,
                ));

                checks.push(diag_check(
                    "system.dns",
                    "system",
                    if net.dns.resolvable {
                        CheckStatus::Ok
                    } else {
                        CheckStatus::Failed
                    },
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
                    if route_ok {
                        CheckStatus::Ok
                    } else {
                        CheckStatus::Failed
                    },
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
                CheckStatus::Failed,
                "当前平台无法读取系统网络".into(),
                None,
                None,
            )),
        }

        let exit_ip = status.health.exit_ip.clone();
        checks.push(exit_ip_check(connection, exit_ip.as_deref()));

        // 接管范围：告诉模型「这次诊断代表哪部分流量」，直接决定它能下什么结论。
        checks.push(self.network_coverage_for().await);

        let source_reachable = http_reachable(&crate::seed::source_url()).await;
        checks.push(diag_check(
            "network.reachable_seed_source",
            "network",
            if source_reachable {
                CheckStatus::Ok
            } else {
                CheckStatus::Failed
            },
            if source_reachable {
                "Veyl 免费节点源可达".into()
            } else {
                "Veyl 免费节点源不可达".into()
            },
            if source_reachable {
                None
            } else {
                Some("连上网络后刷新 Veyl 免费节点")
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
            if github {
                CheckStatus::Ok
            } else {
                CheckStatus::Failed
            },
            if github {
                "GitHub 可达".into()
            } else {
                "GitHub 不可达".into()
            },
            None,
            None,
        ));

        // 快照里的配置也是证据：TUN 在跑而 store 没有活动配置时，
        // 不能报 ok 却写「还没有可用配置」。
        let config_label = active_config
            .as_ref()
            .map(|config| config.name.clone())
            .or_else(|| status.config_name.clone())
            .or_else(|| status.config_id.clone());
        let has_config = active_config.is_some() || status.config_id.is_some() || running;
        checks.push(diag_check(
            "config.current_config",
            "config",
            if has_config {
                CheckStatus::Ok
            } else {
                CheckStatus::Failed
            },
            match (&config_label, running) {
                (Some(name), _) => format!("当前配置：{name}"),
                (None, true) => "配置已应用".to_string(),
                (None, false) => "还没有可用配置".to_string(),
            },
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
            if seed_available {
                CheckStatus::Ok
            } else {
                CheckStatus::Failed
            },
            if seed_available {
                format!(
                    "Veyl 免费节点 {} 个",
                    seed.get("node_count").and_then(Value::as_i64).unwrap_or(0)
                )
            } else {
                "还没有 Veyl 免费节点缓存".into()
            },
            if seed_available {
                None
            } else {
                Some("刷新 Veyl 免费节点")
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
            if !stale {
                CheckStatus::Ok
            } else {
                CheckStatus::Failed
            },
            if !seed_available {
                "没有 Veyl 免费节点".into()
            } else if stale {
                "Veyl 免费节点超过 6 小时未更新".into()
            } else {
                "Veyl 免费节点较新".into()
            },
            if stale {
                Some("刷新 Veyl 免费节点")
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
        let count_status = |wanted: &str| {
            checks
                .iter()
                .filter(|check| check.get("status").and_then(Value::as_str) == Some(wanted))
                .count()
        };
        let ok_count = count_status("ok");
        let skipped = count_status("skipped");
        // 不适用不是故障：skipped 单列，不并进 failed（`tools.md` §4.13）。
        let failed = total - ok_count - skipped;
        let verdict = match (failed, skipped) {
            (0, 0) => "网络状态正常".to_string(),
            (0, items) => format!("没有发现异常，{items} 项这次没检查"),
            (items, 0) => format!("发现 {items} 项需要处理"),
            (items, skipped_items) => {
                format!("发现 {items} 项需要处理，另有 {skipped_items} 项没检查")
            }
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
            "contract_version": crate::tools::envelope::CONTRACT_VERSION,
            "generated_at": chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
            "app_version": env!("CARGO_PKG_VERSION"),
            "platform": crate::netcfg::platform_name(),
            "arch": std::env::consts::ARCH,
            "runtime": status,
            "summary": {
                "total": total,
                "ok": ok_count,
                "failed": failed,
                "skipped": skipped,
                "verdict": verdict,
            },
            "groups": groups,
            "checks": checks,
            "log_excerpt": log_excerpt,
        }))
    }

    async fn issue_report_preference(
        &self,
        include_domains: Option<bool>,
    ) -> anyhow::Result<Value> {
        let conn = self.store.conn();
        if let Some(value) = include_domains {
            crate::store::settings::set(
                &conn,
                crate::reports::INCLUDE_DOMAINS_KEY,
                if value { "1" } else { "0" },
            )
            .map_err(|error| svc_error(error.code(), error))?;
        }
        let current = crate::store::settings::get(&conn, crate::reports::INCLUDE_DOMAINS_KEY)
            .ok()
            .flatten()
            .map(|value| matches!(value.trim(), "1" | "true" | "yes"))
            .unwrap_or(false);
        Ok(json!({ "includeDomains": current }))
    }

    async fn issue_report(
        &self,
        session_id: &str,
        input: crate::reports::IssueReportInput,
    ) -> anyhow::Result<Value> {
        // 材料里只能出现脱敏后的运行时子集：出口 IP 这类公网地址一律不带给模型。
        let mut runtime = self.runtime_status().await?;
        if let Some(object) = runtime.as_object_mut() {
            object.remove("exit_ip");
            object.remove("direct_ip");
            object.remove("traffic");
            object.remove("config_hash");
            // 名称类字段不进材料：报告里只需要数量与协议（`design/issue-report.md` §7.2）。
            object.remove("config_name");
            object.remove("node_name");
            if let Some(health) = object.get_mut("health").and_then(Value::as_object_mut) {
                health.remove("exit_ip");
            }
        }
        let checks = self
            .diag_run(false)
            .await
            .ok()
            .and_then(|value| value.get("checks").cloned())
            .unwrap_or_else(|| json!([]));
        let (
            config_count,
            node_count,
            routing_mode,
            node_hosts,
            node_names,
            config_names,
            node_protocols,
            user_allows,
        ) = {
            let conn = self.store.conn();
            let configs = configs::list(&conn).unwrap_or_default();
            let active = configs.iter().find(|config| config.is_active).cloned();
            let config_names = configs.iter().map(|config| config.name.clone()).collect();
            // 日志里可能出现任何一套配置的节点名与地址：汇总全部配置 + 节点池，
            // 只取活动配置会漏掉其余节点，整值替换就失效了。
            let mut nodes = Vec::new();
            for config in &configs {
                nodes.extend(configs::list_nodes(&conn, &config.id).unwrap_or_default());
            }
            nodes.extend(configs::list_pool_nodes(&conn).unwrap_or_default());
            let mut seen: Vec<String> = Vec::new();
            nodes.retain(|node| {
                if seen.iter().any(|id| id == &node.id) {
                    false
                } else {
                    seen.push(node.id.clone());
                    true
                }
            });
            let node_hosts = nodes.iter().map(|node| node.server.clone()).collect();
            let node_names = nodes.iter().map(|node| node.name.clone()).collect();
            let mut node_protocols: Vec<String> = Vec::new();
            for node in &nodes {
                let protocol = if crate::nodes::SUPPORTED_METHODS.contains(&node.method.as_str()) {
                    "shadowsocks"
                } else {
                    "unknown"
                };
                if !node_protocols.iter().any(|known| known == protocol) {
                    node_protocols.push(protocol.to_string());
                }
            }
            let active_node_count = active
                .as_ref()
                .map(|config| {
                    configs::list_nodes(&conn, &config.id)
                        .unwrap_or_default()
                        .len()
                })
                .unwrap_or(0);
            let allows = crate::store::settings::get(&conn, crate::reports::INCLUDE_DOMAINS_KEY)
                .ok()
                .flatten()
                .is_some_and(|value| matches!(value.trim(), "1" | "true" | "yes"));
            (
                configs.len(),
                active_node_count,
                active.map(|config| config.routing_mode),
                node_hosts,
                node_names,
                config_names,
                node_protocols,
                allows,
            )
        };
        let ctx = crate::reports::ReportContext {
            data_dir: self.data_dir.clone(),
            runtime,
            checks,
            app_version: env!("CARGO_PKG_VERSION").to_string(),
            platform: crate::netcfg::platform_name().to_string(),
            arch: std::env::consts::ARCH.to_string(),
            routing_mode,
            node_count,
            config_count,
            node_protocols,
            node_hosts,
            node_names,
            config_names,
            user_allows_domains: user_allows,
        };
        let root = crate::reports::reports_root(&self.data_dir);
        crate::reports::generate(session_id, &input, &ctx, &root).map_err(|error| {
            svc_error_with_details(
                error.code,
                error.message,
                error
                    .reason
                    .map(|reason| json!({ "reason": reason }))
                    .unwrap_or(Value::Null),
            )
        })
    }

    async fn submit_issue_to_public_wall(
        &self,
        payload: Value,
        idempotency_key: &str,
    ) -> anyhow::Result<Value> {
        crate::control_plane::issues::submit(&payload, idempotency_key)
            .await
            .map_err(svc_from_cp)
    }

    async fn read_public_issue_wall(
        &self,
        query: crate::control_plane::issues::IssueQuery,
    ) -> anyhow::Result<Value> {
        crate::control_plane::issues::read(&query)
            .await
            .map_err(svc_from_cp)
    }

    fn issue_wall_client_info(&self) -> Value {
        let selected = {
            let conn = self.store.conn();
            crate::store::settings::app_language(&conn)
        };
        crate::control_plane::issues::ClientInfo::current(crate::i18n::resolve(selected)).to_json()
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

    /// 代理设置失败后的回滚（架构裁决 A1）：撤代理 → 取锁 → 按实例身份判定 → 停。
    ///
    /// 只停**本次**拉起的进程：`RuntimeStatus.pid` 与本次 `started.pid` 相等才停；
    /// 不相等说明期间已有新连接接手，停下去等于把它一起杀掉。
    ///
    /// **不递增代数**：这是本次启动自己的收尾，不是新的意图。在这里递增会让
    /// 并发另一次启动的「记代」提前过期，导致它误判被取代并收掉自己的新连接。
    async fn rollback_proxy_after_enable_failure(&self, ours: Option<u32>, context: StartContext) {
        if let Err(error) = self.proxy.disable() {
            log::warn!("回滚系统代理失败：{error}");
        }
        // 重建的回滚本来就在锁内；用户的启动在锁外，这里自己取。
        let _ops = if context.lock_held {
            None
        } else {
            match self.lock_runtime_ops().await {
                Ok(guard) => Some(guard),
                Err(error) => {
                    // 取不到锁就不在锁外停：会和启动 / 重建交错，把新连接一起杀掉。
                    log::error!("代理回滚等运行期操作锁超时，不在锁外停：{error}");
                    return;
                }
            }
        };
        // 比较与停在同一把 manager 内部锁内完成；pid 只认本次 `start()` 返回的那个。
        let Some(pid) = ours else {
            // 没有启动回执里的 pid，就无法认领实例：按「不是我的」处理，不动。
            log::warn!("代理回滚：本次启动没有拿到 pid，跳过停止");
            return;
        };
        match self.manager.stop_if_pid(pid).await {
            Ok(Some(_)) => {}
            Ok(None) => log::warn!("代理回滚：pid={pid} 已不是当前实例，跳过停止"),
            Err(error) => log::warn!("代理回滚：停运行时失败：{error}"),
        }
    }

    fn drop_previous_rendered_config(&self, target_config_id: &str) {
        if let Some(previous) = self.active_config_id() {
            if previous != target_config_id {
                vpn_config::remove_profile_config(&self.config_dir(), &previous);
            }
        }
    }

    /// 只跑到期事务，不做断连。启动路径先同步调用它，保证 UI 首次读
    /// `trial_status` 时节点已经移除；断连随后在后台任务里完成。
    pub(crate) fn expire_trial_store(&self) -> anyhow::Result<Option<crate::trial::Expired>> {
        let conn = self.store.conn();
        crate::trial::expire_if_needed(&conn, crate::store::now_ms())
            .map_err(|error| svc_error(error.code(), error))
    }

    /// 事务提交后的断连与事件。到期瞬间连接还在启动时，等启动结束再判断，
    /// 最多等 30 秒；停止失败不回滚数据库。
    pub(crate) async fn finish_trial_expiry(&self, expired: crate::trial::Expired) {
        let mut disconnected = false;
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
        loop {
            let status = self.connection_status().await;
            let uses_removed = status
                .node_id
                .as_ref()
                .is_some_and(|id| expired.removed_node_ids.contains(id));
            if uses_removed {
                match self.runtime_stop(false).await {
                    Ok(_) => disconnected = true,
                    Err(error) => {
                        log::warn!("试用到期后断开连接失败（数据库不回滚）：{error}")
                    }
                }
                break;
            }

            let launching = self.tun.is_launching()
                || matches!(
                    self.manager.status().await.state,
                    crate::runtime::RuntimeState::Starting
                        | crate::runtime::RuntimeState::Restarting
                );
            if !launching || std::time::Instant::now() >= deadline {
                break;
            }
            // 到期瞬间还在启动：节点 id 要等启动落地才知道，等它落定再判一次。
            tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        }

        crate::agent::app_handle::emit(
            crate::claurst_session::events::EV_TRIAL_EXPIRED,
            json!({
                "contract_version": crate::runtime::EVENT_CONTRACT_VERSION,
                "ended_at": crate::store::iso_from_ms(expired.ended_at_ms),
                "removed_node_count": expired.removed_node_count(),
                "disconnected": disconnected,
                "emitted_at": crate::claurst_session::events::now(),
            }),
        );
    }

    /// 连接成功后的试用钩子：本次连的是种子节点才起算，只写一次。
    async fn note_trial_connection(&self, snapshot: &Value) {
        if !matches!(
            snapshot.get("state").and_then(Value::as_str),
            Some("running") | Some("degraded")
        ) {
            return;
        }
        let Some(node_id) = snapshot.get("node_id").and_then(Value::as_str) else {
            return;
        };
        let is_seed = {
            let conn = self.store.conn();
            configs::get_node(&conn, node_id)
                .ok()
                .flatten()
                .is_some_and(|node| node.source == configs::SOURCE_SEED)
        };
        if is_seed {
            let conn = self.store.conn();
            if let Err(error) = crate::trial::mark_started(&conn, crate::store::now_ms()) {
                log::warn!("写入试用开始时间失败：{error}");
            }
        }
        if let Err(error) = self.check_trial_expiry().await {
            log::warn!("连接后检查试用到期失败：{error}");
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
        result.map_err(|error| {
            let changed = connect_changed_state(&error);
            with_connect_changed(error, changed)
        })
    }

    /// 连接一套配置：先把上一套（或还在启动的那一套）收干净，再交给 `connect_body`。
    ///
    /// 锁边界（契约 §7.1「被取代的启动」）：**决策段**持锁——读连接状态、幂等判断、
    /// 停旧连接、记代数；拉起因配置渲染与 TUN `start` 最长 90 秒，放在锁外；
    /// 拉起返回后重新取锁比对代数，被取代时只收掉**本次**拉起的实例。
    async fn connect_inner(&self, config: &configs::Config) -> anyhow::Result<Value> {
        let (epoch, old_stopped) = {
            let _ops = self.lock_runtime_ops().await?;
            match self.decide_connection(config).await? {
                ConnectionDecision::Idempotent(value) => return Ok(value),
                ConnectionDecision::Start { epoch, old_stopped } => (epoch, old_stopped),
            }
        };

        let context = StartContext {
            epoch: Some(epoch),
            lock_held: false,
        };
        let result = self.connect_body(config, &[], context).await;
        self.finish_connection_start(epoch, old_stopped, result)
            .await
    }

    /// 决策段：只在持锁时调用。幂等判断 → 停旧 → 记代数，三件事必须在同一临界区，
    /// 否则连点两次会互相看漏。
    async fn decide_connection(
        &self,
        config: &configs::Config,
    ) -> anyhow::Result<ConnectionDecision> {
        let connection = self.connection_state_cached().await;
        let same_config = |id: Option<&str>| id == Some(config.id.as_str());

        // 已连接同一套：幂等返回当前快照。**幂等分支不递增代数、不作废在途启动。**
        if connection.connected
            && !connection.launching
            && same_config(connection.config_id.as_deref())
        {
            log::info!("同一套配置已连接，幂等返回：{}", config.id);
            let mut snapshot = self.runtime_status().await?;
            snapshot["already_running"] = json!(true);
            return Ok(ConnectionDecision::Idempotent(snapshot));
        }
        // 同一套还在启动：也幂等——别为了一个重复请求把正在起来的连接重启一遍。
        // 契约 §7.1：幂等只有这一种例外，返回的是 `starting` 快照。
        if connection.launching
            && !connection.connected
            && same_config(connection.launching_config.as_deref())
        {
            log::info!("同一套配置正在启动，幂等返回：{}", config.id);
            let snapshot = crate::runtime::RuntimeStatus::tun_pending(
                crate::runtime::RuntimeState::Starting,
                Some(config.id.clone()),
                self.available_runtime_version().await,
            );
            let mut value = serde_json::to_value(snapshot).map_err(|e| svc_error("INTERNAL", e))?;
            value["already_running"] = json!(true);
            return Ok(ConnectionDecision::Idempotent(value));
        }

        let mut old_stopped = false;
        if connection.connected || connection.launching {
            log::info!(
                "连接前先停旧连接：connected={} launching={} old={:?} target={}",
                connection.connected,
                connection.launching,
                connection.config_id,
                config.id
            );
            // 停不掉就如实报错，不继续启动——报「失败」却起了第二条连接是最坏的组合。
            if let Err(error) = self.runtime_stop_inner(false).await {
                // 用户的网络已经被动过（哪怕只动了一半）：不能说「没有改动」。
                return Err(mark_old_connection_stopped(error, false));
            }
            old_stopped = true;
        }
        // 这一次启动本身也是一次会改运行时的意图：记在停旧之后，
        // 并发启动按取锁顺序各记一代，后者的收尾据此判断前者是否已过期。
        let epoch = self.bump_runtime_epoch();
        Ok(ConnectionDecision::Start { epoch, old_stopped })
    }

    /// 拉起返回后的收尾：仍在锁内比对代数，被取代时只停本次拉起的实例。
    async fn finish_connection_start(
        &self,
        epoch: u64,
        old_stopped: bool,
        result: anyhow::Result<Value>,
    ) -> anyhow::Result<Value> {
        let _ops = match self.lock_runtime_ops().await {
            Ok(guard) => guard,
            Err(error) => {
                // 收尾没拿到锁就无法证明自己是否被取代，也不能在锁外停任何东西：
                // 如实按「不确定」收尾，残留由下一次 start/stop 正常回收。
                log::error!("启动收尾等运行期操作锁超时，结果不确定：{error}");
                return match result {
                    Ok(_) => Err(superseded_error(STOP_UNKNOWN_MESSAGE, true)),
                    Err(error) => Err(mark_old_connection_stopped(error, old_stopped)),
                };
            }
        };

        if self.current_runtime_epoch() == epoch {
            return match result {
                Ok(mut value) => {
                    value["already_running"] = json!(false);
                    Ok(value)
                }
                // 旧连接已经被停掉：之后的失败不能让工具说「没有改动」。
                Err(error) if old_stopped => Err(mark_old_connection_stopped(error, true)),
                Err(error) => Err(error),
            };
        }

        // 被取代：拉起本身失败/被取消时，内部回滚已经按身份处理过，这里不重复停。
        let snapshot = match result {
            Ok(snapshot) => snapshot,
            Err(error) => {
                return Err(if old_stopped {
                    mark_old_connection_stopped(error, true)
                } else {
                    error
                });
            }
        };
        log::warn!("启动已被新的运行期操作取代（epoch={epoch}），收尾本次拉起的实例");
        match self.stop_superseded_instance(&snapshot).await {
            Ok(()) => Err(superseded_error(SUPERSEDED_START_MESSAGE, false)),
            Err(error) => {
                log::error!("被取代的启动收尾失败：{error}");
                Err(superseded_error(
                    &format!("{SUPERSEDED_START_MESSAGE}但停止时失败：{error}"),
                    true,
                ))
            }
        }
    }

    /// 只停**本次**启动拉起的那个实例：按运行实例的 pid 相等判定，不相等就说明
    /// 已经是取代它的新连接，停下去等于把新连接一起杀掉。
    async fn stop_superseded_instance(&self, snapshot: &Value) -> Result<(), anyhow::Error> {
        let Some(ours) = snapshot
            .get("pid")
            .and_then(Value::as_u64)
            .and_then(|pid| u32::try_from(pid).ok())
        else {
            // 没拿到 pid：没有可归属的实例，不猜、不停。
            return Ok(());
        };
        if snapshot.get("mode").and_then(Value::as_str) == Some("tun") {
            // `stop_for_failed_launch` 本来就按「无登记 + Running pid 是本次」判身份，
            // 有更新的启动登记时不会动手。
            return self
                .tun
                .stop_for_failed_launch(ours)
                .map_err(|error| svc_error("INTERNAL", format!("停 TUN 失败：{}", error.message)));
        }
        // 比较与停在同一把 manager 内部锁内完成：不在外面读一次 pid 再进去停。
        self.manager
            .stop_if_pid(ours)
            .await
            .map_err(|error| svc_error(error.code(), error))?;
        Ok(())
    }
    /// `exclude_node_ids` 只给「重建运行配置失败后的回滚」用：用不含新节点的
    /// 那份节点集合再起一次，把用户接回原来的连接。
    /// 连接中新增节点：重建运行配置，让新节点立刻进 selector。
    ///
    /// 运行中的 sing-box 不能热加 outbound（TUN 的配置还在特权助手侧），
    /// 所以这是一次完整 stop → start：中间会有一小段断流，重启后当前选中的
    /// 节点不变（`current_node_id` 没动）。新配置起不来时，用**不含新节点**的
    /// 旧节点集合再起一次，把用户接回原来的连接；两个都失败就如实报。
    ///
    /// 返回给 `node_attach` / `node_create` 的 `runtime_rebuild` 字段；
    /// 失败不影响「节点已经进池」这件事。
    async fn rebuild_running_config(&self, config: &configs::Config, added: &[String]) -> Value {
        if added.is_empty() {
            return json!({ "status": "skipped", "reason": "no_new_nodes" });
        }
        // 锁只护决策段：复查 → 重读配置 → 停旧 → 记代。拉起（最长 90s）在锁外，
        // 否则重建期间用户按断开会排在后面等满 20s 再吃 `runtime_busy`，
        // 界面报「断开失败」而连接其实没断。
        //
        // 计数给用例证明「确实停在取锁这一步」，而不只是任意 Pending。
        #[cfg(test)]
        self.rebuild_lock_attempts
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let (latest, epoch) = {
            let _ops = match self.lock_runtime_ops_skipped("重建运行配置").await {
                Ok(guard) => {
                    #[cfg(test)]
                    self.rebuild_lock_acquired
                        .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    guard
                }
                Err(reason) => return reason,
            };
            let connection = self.connection_state_cached().await;
            if connection.launching {
                return json!({ "status": "skipped", "reason": "connection_launching" });
            }
            if !connection.connected {
                return json!({ "status": "skipped", "reason": "not_connected" });
            }
            if connection.config_id.as_deref() != Some(config.id.as_str()) {
                return json!({ "status": "skipped", "reason": "config_not_running" });
            }
            // 重读放在停旧**之前**：读不到就什么都不停，`skipped` 才真的是「跳过」。
            let latest = match self.require_config(&config.id) {
                Ok(latest) => latest,
                Err(_) => return json!({ "status": "skipped", "reason": "config_missing" }),
            };

            log::info!(
                "连接中新增 {} 个节点，重建运行配置 config={}",
                added.len(),
                config.id
            );
            if let Err(error) = self.stop_for_rebuild(connection.tun).await {
                log::warn!("重建运行配置：停旧连接失败：{error}");
                return json!({
                    "status": "failed",
                    "restored": false,
                    "new_nodes_available_next_connect": true,
                    "message": "新节点这次没能应用，当前连接也没停掉；重新连接后就能用它。",
                });
            }
            // 重建自己也是一次意图变更：锁内记代，锁外拉起后据此判断是否被取代。
            (latest, self.bump_runtime_epoch())
        };
        // 测试注入：跳过真正启动，直接走「首轮失败」的回滚分支。
        #[cfg(test)]
        let injected = {
            use std::sync::atomic::Ordering;
            if self.rebuild_failures.load(Ordering::SeqCst) > 0 {
                self.rebuild_failures.fetch_sub(1, Ordering::SeqCst);
                // 留一个窗口给用例里并发落下的 stop / switch；窗口起止用计数告诉用例。
                self.rebuild_test_waiting.fetch_add(1, Ordering::SeqCst);
                tokio::time::sleep(std::time::Duration::from_millis(500)).await;
                self.rebuild_test_waiting.fetch_sub(1, Ordering::SeqCst);
                Some(anyhow::anyhow!("测试注入：新配置启动失败"))
            } else {
                None
            }
        };
        #[cfg(not(test))]
        let injected: Option<anyhow::Error> = None;

        // 重建用的是进重建前的快照；启动前重读一次，期间改过的选择以库里为准。
        let applied = match injected {
            Some(error) => Err(error),
            // 拉起在锁外（R2 起带 epoch，收尾再比对）；这里已经不在临界区里。
            None => {
                self.connect_body(
                    &latest,
                    &[],
                    StartContext {
                        epoch: Some(epoch),
                        lock_held: false,
                    },
                )
                .await
            }
        };
        // 用例用：首轮已经连上、还没复查之前停一下，让「期间被断开」这条真实落地。
        #[cfg(test)]
        if self
            .rebuild_pause_after_start
            .swap(false, std::sync::atomic::Ordering::SeqCst)
        {
            use std::sync::atomic::Ordering;
            self.rebuild_test_waiting.fetch_add(1, Ordering::SeqCst);
            tokio::time::sleep(std::time::Duration::from_millis(500)).await;
            self.rebuild_test_waiting.fetch_sub(1, Ordering::SeqCst);
        }

        // 锁外拉起返回后持锁复查：判据不是「谁改了代数」，而是「现在实际连没连」
        // （契约 §4.0.1）。途中被断开就只收掉本次拉起的实例，不把连接接回来。
        let still_connected = self.still_connected_after_start(&config.id, &applied).await;

        if applied.is_ok() {
            match still_connected {
                AfterStart::Connected => {
                    log::info!("重建运行配置完成 config={}", config.id);
                    return json!({
                        "status": "applied",
                        "new_nodes": self.nodes_in_running_config(config, added),
                    });
                }
                // 起来了但已被断开取代：节点已进池，不再接回连接。
                AfterStart::Disconnected => return user_disconnected_rebuild(),
                AfterStart::Replaced => return rebuild_replaced_by_new_connection(),
                AfterStart::Unknown => return rebuild_unknown(),
            }
        }

        let error = match applied {
            Ok(_) => unreachable!("成功的情形上面已返回"),
            Err(error) => error,
        };
        log::warn!("重建运行配置失败，回滚到原节点集合：{error}");

        // 回滚前重新取锁比代数：期间发生过启动 / 断开 / 重启就不再回滚——
        // 那会把用户刚断开的连接接回来。拿不到锁同样不接回（不确定就不动）。
        let rollback_epoch = match self.lock_runtime_ops_skipped("重建回滚").await {
            Ok(_ops) => {
                if self.current_runtime_epoch() == epoch {
                    self.bump_runtime_epoch()
                } else {
                    // 代数变了不等于「用户断开」：也可能是重启或另一次启动。
                    // **在锁内重新读实际状态**，不能拿检查前的快照下结论。
                    return if self.connection_state_cached().await.connected {
                        rebuild_replaced_by_new_connection()
                    } else {
                        user_disconnected_rebuild()
                    };
                }
            }
            Err(_) => return rebuild_unknown(),
        };

        #[cfg(test)]
        let rollback_injected = {
            use std::sync::atomic::Ordering;
            if self.rebuild_failures.load(Ordering::SeqCst) > 0 {
                self.rebuild_failures.fetch_sub(1, Ordering::SeqCst);
                Some(anyhow::anyhow!("测试注入：回滚启动失败"))
            } else {
                None
            }
        };
        #[cfg(not(test))]
        let rollback_injected: Option<anyhow::Error> = None;
        let (restored, disconnected) = match rollback_injected {
            Some(error) => {
                log::warn!("重建回滚启动失败（测试注入）：{error}");
                (false, false)
            }
            None => {
                // 用例用：回滚拉起前停一下，让「期间被重启/另一次启动打断」真实落地。
                #[cfg(test)]
                if self
                    .rebuild_pause_before_rollback
                    .swap(false, std::sync::atomic::Ordering::SeqCst)
                {
                    use std::sync::atomic::Ordering;
                    self.rebuild_rollback_paused.store(true, Ordering::SeqCst);
                    // 等用例放行（最多 10s），不用固定睡眠去赌时序。
                    for _ in 0..500 {
                        if self.rebuild_rollback_release.swap(false, Ordering::SeqCst) {
                            break;
                        }
                        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
                    }
                    self.rebuild_rollback_paused.store(false, Ordering::SeqCst);
                }
                let rolled = self
                    .connect_body(
                        &latest,
                        added,
                        StartContext {
                            epoch: Some(rollback_epoch),
                            lock_held: false,
                        },
                    )
                    .await;
                if rolled.is_ok() {
                    // 回滚也可能在半路被用户断开取代：同样只收本次实例，不接回来。
                    match self.still_connected_after_start(&latest.id, &rolled).await {
                        AfterStart::Connected => (true, false),
                        AfterStart::Disconnected => (false, true),
                        AfterStart::Replaced => return rebuild_replaced_by_new_connection(),
                        AfterStart::Unknown => return rebuild_unknown(),
                    }
                } else if rolled
                    .as_ref()
                    .err()
                    .is_some_and(|error| is_cancelled_error(error))
                {
                    // 回滚拉起被取消 ≠ 用户断开：可能是重启或另一次启动打断了它。
                    // 与回滚守卫同型——重读实际状态再下结论。
                    match self.actual_connection_state(&latest.id).await {
                        AfterStart::Connected | AfterStart::Replaced => {
                            return rebuild_replaced_by_new_connection();
                        }
                        AfterStart::Disconnected => (false, true),
                        AfterStart::Unknown => return rebuild_unknown(),
                    }
                } else {
                    (false, false)
                }
            }
        };
        if restored {
            log::info!("重建运行配置已回滚到原节点集合 config={}", config.id);
        }
        if disconnected {
            return user_disconnected_rebuild();
        }
        json!({
            "status": "failed",
            "restored": restored,
            "new_nodes_available_next_connect": true,
            "message": if restored {
                "新节点这次没能应用，已回到原来的连接；重新连接后就能用它。"
            } else {
                "新节点这次没能应用，连接也没能恢复；重新连接会带上它。"
            },
        })
    }

    /// 锁外拉起返回后持锁复查「现在实际连没连」；**只在确认没人接手时才收本次实例**
    /// （`Disconnected`）。`Replaced` 不停：接管方要么已经停过、要么会用替换语义收掉
    /// 我们的实例，这里再停一次就是把新连接一起杀掉——后来者不要以为漏停而加回一个 stop。
    /// 拿不到锁时既不能说连着、也不能说用户断开——那是「不知道」，单独成一态。
    async fn still_connected_after_start(
        &self,
        config_id: &str,
        applied: &anyhow::Result<Value>,
    ) -> AfterStart {
        match self.lock_runtime_ops().await {
            Ok(_ops) => {
                let state = self.after_start_state(config_id).await;
                if state == AfterStart::Disconnected {
                    if let Ok(snapshot) = applied {
                        if let Err(error) = self.stop_superseded_instance(snapshot).await {
                            log::error!("拉起的连接已被取代，收尾失败：{error}");
                        }
                    }
                }
                state
            }
            Err(error) => {
                // 用户没按断开、我们也证明不了连没连：不能冒充 `user_disconnected`。
                log::error!("拉起后等运行期操作锁超时，连接状态无法确认：{error}");
                AfterStart::Unknown
            }
        }
    }

    /// 取锁读一次实际连接状态（不碰任何实例）。拿不到锁 = `Unknown`。
    async fn actual_connection_state(&self, config_id: &str) -> AfterStart {
        match self.lock_runtime_ops().await {
            Ok(_ops) => self.after_start_state(config_id).await,
            Err(error) => {
                log::error!("复查连接状态时等运行期操作锁超时：{error}");
                AfterStart::Unknown
            }
        }
    }

    /// 调用方必须已持 `runtime_ops`。判据是**重新读到的连接状态**：
    /// 这套配置连着 → `Connected`；别人在跑或有启动在途 → `Replaced`；
    /// 都没有 → `Disconnected`。
    async fn after_start_state(&self, config_id: &str) -> AfterStart {
        let state = self.connection_state_cached().await;
        if state.connected {
            return if state.config_id.as_deref() == Some(config_id) {
                AfterStart::Connected
            } else {
                AfterStart::Replaced
            };
        }
        if state.launching {
            return AfterStart::Replaced;
        }
        AfterStart::Disconnected
    }

    /// `applied` 里只列真的进了运行配置的节点：缺凭据被 `connect_body` 跳过的
    /// 不能算「已应用」，否则界面会以为它正在跑。
    fn nodes_in_running_config(&self, config: &configs::Config, added: &[String]) -> Vec<String> {
        let Ok(members) = configs::list_nodes(&self.store.conn(), &config.id) else {
            return Vec::new();
        };
        added
            .iter()
            .filter(|id| {
                members.iter().any(|member| {
                    &member.id == *id
                        && crate::secrets::get_secret(&member.password_ref)
                            .ok()
                            .flatten()
                            .is_some()
                })
            })
            .cloned()
            .collect()
    }

    /// 重建前停掉当前连接。
    ///
    /// 代理连接不碰特权助手：TUN 没参与这条连接，没必要为一次节点重建去发
    /// 一个可能超时的特权 IPC；TUN 连接才走完整的 `runtime_stop`。
    async fn stop_for_rebuild(&self, tun_connected: bool) -> anyhow::Result<()> {
        if tun_connected {
            return self.runtime_stop_inner(false).await.map(|_| ());
        }
        let connected = self.connected_config_id().await;
        self.restore_system_proxy()?;
        self.manager.set_system_proxy_enabled(false).await;
        // 代数的递增点只在这里和 `runtime_stop_inner` 各一处：TUN 分支已经走 stop_inner。
        self.bump_runtime_epoch();
        self.manager
            .stop()
            .await
            .map_err(|error| svc_error(error.code(), error))?;
        if let Some(config_id) = connected {
            vpn_config::remove_profile_config(&self.config_dir(), &config_id);
        }
        Ok(())
    }

    async fn connect_body(
        &self,
        config: &configs::Config,
        exclude_node_ids: &[String],
        context: StartContext,
    ) -> anyhow::Result<Value> {
        log::info!(
            "连接开始 config={} mode={} routing={}",
            config.id,
            config.connection_mode,
            config.routing_mode
        );

        // 用例用：用户启动的拉起阶段不该占着运行期操作锁（重建回滚例外，它在锁内）。
        #[cfg(test)]
        if context.epoch.is_some() {
            if let Ok(guard) = self.runtime_ops.try_lock() {
                drop(guard);
                self.start_body_without_lock
                    .store(true, std::sync::atomic::Ordering::SeqCst);
            }
        }

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
        let (region, _) = self.effective_region();
        let route_region = region.code().map(str::to_string);
        let plan = crate::rules::plan::build(&crate::rules::plan::RouteInput {
            mode: &config.routing_mode,
            region: &region,
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
        // 回滚用的排除集不能把当前节点去掉，否则「恢复原连接」本身就建不出来。
        if exclude_node_ids.iter().any(|id| id == &node.id) {
            return Err(svc_error(
                "INTERNAL",
                "重建运行配置时不能排除当前选中的节点",
            ));
        }
        let installed = self.ensure_runtime().await?;
        self.drop_previous_rendered_config(&config.id);

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
            if exclude_node_ids.iter().any(|id| id == &member.id) {
                continue;
            }
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

        // TUN 的进程不归 manager 管，但主界面与托盘只认同一条 `runtime-state-changed`：
        // 不发事件，就只能各读一份状态，迟早出现「界面已断开、托盘还连着」。
        let is_tun = config.connection_mode == configs::CONNECTION_TUN;
        if is_tun {
            // `from` 取上一条 TUN 事件的目标状态：失败后再连应当是 failed → starting。
            let from = self.last_tun_state();
            self.publish_tun_state(
                from,
                crate::runtime::RuntimeState::Starting,
                crate::runtime::RuntimeEventKind::StartReq,
                None,
                crate::runtime::RuntimeStatus::tun_pending(
                    crate::runtime::RuntimeState::Starting,
                    Some(config.id.clone()),
                    self.available_runtime_version().await,
                ),
            );
        }
        let started = if is_tun {
            // TUN 的 mixed 入站继续随机、不上报，也不使用用户设置；
            // 只是随机时避开设置端口，避免和之后的系统代理连接抢同一个端口。
            let configured_port = {
                let conn = self.store.conn();
                crate::store::settings::proxy_port(&conn)
            };
            let mixed_port = vpn_config::pick_free_port_excluding(&[configured_port])
                .map_err(|e| svc_error(e.code(), e))?;
            let clash_port = clash_port_for(mixed_port, &[configured_port])?;
            self.start_tun_connection(
                config,
                &descriptors,
                &current_descriptor,
                &plan,
                mixed_port,
                clash_port,
                clash_secret,
                route_region.clone(),
                context,
            )
            .await
        } else {
            let configured_port = {
                let conn = self.store.conn();
                crate::store::settings::proxy_port(&conn)
            };
            // 先预检查再启动；启动时被抢（竞态）再顺延，最多三个候选。
            // 当前运行时自己的端口会被 manager.start 先停掉，不算被占用。
            let own_port = {
                let state = self.manager.status().await.state;
                if matches!(
                    state,
                    crate::runtime::RuntimeState::Running
                        | crate::runtime::RuntimeState::Degraded
                        | crate::runtime::RuntimeState::Starting
                        | crate::runtime::RuntimeState::Restarting
                        | crate::runtime::RuntimeState::Stopping
                ) {
                    self.manager
                        .current_plan()
                        .await
                        .map(|plan| plan.mixed_port)
                } else {
                    None
                }
            };
            let trials = proxy_port_trials(configured_port, own_port);
            // 设置值为什么没用上：被占还是没权限，界面要能说不同的话。
            let mut fallback_reason = match if Some(configured_port) == own_port {
                crate::config::PortAvailability::Free
            } else {
                crate::config::port_availability(configured_port)
            } {
                crate::config::PortAvailability::Free => None,
                crate::config::PortAvailability::Occupied => {
                    Some(crate::runtime::PortFallbackReason::Occupied)
                }
                crate::config::PortAvailability::Unavailable => {
                    Some(crate::runtime::PortFallbackReason::Unavailable)
                }
            };
            let mut tried = Vec::new();
            let mut success: Option<Value> = None;
            let mut hard_error: Option<anyhow::Error> = None;
            for mixed_port in trials {
                tried.push(mixed_port);
                let clash_port = clash_port_for(mixed_port, &[configured_port])?;
                let input = vpn_config::BuildInput::new(
                    current_descriptor.clone(),
                    mixed_port,
                    clash_port,
                    clash_secret.clone(),
                );
                let value = vpn_config::build_routed_multi(&input, &descriptors, &node.id, &plan)
                    .map_err(|e| svc_error(e.code(), e))?;
                match self
                    .start_connection(
                        &installed,
                        &config.id,
                        Some(config.id.clone()),
                        Some(config.name.clone()),
                        Some(node.id.clone()),
                        Some(node.name.clone()),
                        Some(config.route_revision),
                        route_region.clone(),
                        Some(configured_port),
                        fallback_reason,
                        &value,
                        context,
                    )
                    .await
                {
                    Ok(data) => {
                        success = Some(data);
                        break;
                    }
                    Err(error) if is_port_conflict(&error) => {
                        // 设置值预检查时是空的、启动时被抢：原因改成「被占用」。
                        if mixed_port == configured_port {
                            fallback_reason = Some(crate::runtime::PortFallbackReason::Occupied);
                        }
                        log::warn!("本地端口 {mixed_port} 启动时被占用，顺延下一个候选");
                    }
                    Err(error) => {
                        hard_error = Some(error);
                        break;
                    }
                }
            }
            match (success, hard_error) {
                (Some(data), _) => Ok(data),
                (None, Some(error)) => Err(error),
                (None, None) => Err(self
                    .attach_runtime_log_tail(port_unavailable_error(&tried), &installed.version)),
            }
        };

        match started {
            Ok(data) => {
                if is_tun {
                    let snapshot = self.connection_status().await;
                    self.publish_tun_state(
                        crate::runtime::RuntimeState::Starting,
                        crate::runtime::RuntimeState::Running,
                        crate::runtime::RuntimeEventKind::ProcessReady,
                        None,
                        snapshot,
                    );
                }
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
                // 启动失败也要进事件流：界面与托盘不能一个停在「连接中」、另一个回到空闲。
                // 被新操作取代（`cancelled`）不报失败：紧接着会有新连接的 starting。
                if is_tun && !is_cancelled_error(&error) {
                    let mut snapshot = crate::runtime::RuntimeStatus::tun_pending(
                        crate::runtime::RuntimeState::Failed,
                        Some(config.id.clone()),
                        self.available_runtime_version().await,
                    );
                    if let Some(service) = error.downcast_ref::<ServiceError>() {
                        snapshot.last_error = Some(crate::runtime::RuntimeErrorInfo {
                            contract_version: crate::runtime::CONTRACT_VERSION,
                            code: service.code.clone(),
                            message: service.message.clone(),
                            retryable: service.retryable,
                            details: service.details.clone(),
                            request_id: String::new(),
                        });
                    }
                    self.publish_tun_state(
                        crate::runtime::RuntimeState::Starting,
                        crate::runtime::RuntimeState::Failed,
                        crate::runtime::RuntimeEventKind::GiveUp,
                        Some(error.to_string()),
                        snapshot,
                    );
                }
                // 连接失败必须留痕：界面只显示一句话，日志里没有记录就没法定位。
                match error.downcast_ref::<ServiceError>() {
                    Some(service) => log::error!(
                        "连接失败 code={} message={} details={:?}",
                        service.code,
                        service.message,
                        service.details
                    ),
                    None => log::error!("连接失败：{error:#}"),
                }
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
        route_region: Option<String>,
        context: StartContext,
    ) -> anyhow::Result<Value> {
        // 决策段之后已经过了渲染与准备：真的动 helper 之前再确认一次没被取代。
        self.ensure_start_is_current(context.epoch)?;
        // 从这一步起就算「正在连」：下面要建配置、等 helper 检查、再让 helper 拉
        // sing-box，真机要十几秒。这期间切配置 / 断开必须看得见这次连接在途。
        let launch = self.tun.begin_launch(&config.id);
        let result = self
            .start_tun_connection_inner(
                &launch,
                config,
                descriptors,
                current,
                plan,
                mixed_port,
                clash_port,
                clash_secret,
                route_region,
            )
            .await;
        // 任何早退（节点解析、建配置、helper 检查……）之后都要再看一眼代次：
        // 被取代的连接不能「迟到的失败」把新连接的事件链打断。
        match result {
            Err(_) if launch.cancelled() => {
                log::info!("连接已被新的操作取代，放弃这次 TUN 启动：{}", config.id);
                Err(cancelled_connection_error())
            }
            other => other,
        }
    }

    #[allow(clippy::too_many_arguments)]
    async fn start_tun_connection_inner(
        &self,
        launch: &crate::tun::session::LaunchSlot<'_>,
        config: &configs::Config,
        descriptors: &[vpn_config::NodeDescriptor],
        current: &vpn_config::NodeDescriptor,
        plan: &crate::rules::plan::RoutePlan,
        mixed_port: u16,
        clash_port: u16,
        clash_secret: String,
        route_region: Option<String>,
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

        // 节点旁路解析与配置生成可能要好几秒：用户可能已经断开或切走了。
        // 已经作废就不要再碰 helper（可能要弹授权）与系统代理。
        if launch.cancelled() {
            log::info!("连接已被取消，不再请求后台组件 config={}", config.id);
            return Err(cancelled_connection_error());
        }

        // 每次 TUN 连接前再比对一次 helper 构建：App 已升级但后台还是旧映像时，
        // 先换新再连；换不了就让本次连接失败，避免用旧 helper 接管流量。
        let helper = Arc::clone(&self.helper);
        tokio::task::spawn_blocking(move || helper.ensure_current_for_connect())
            .await
            .map_err(|error| svc_error("INTERNAL", format!("检查后台组件失败：{error}")))?
            .map_err(|(message, reason)| {
                svc_error_with_details("PRECONDITION_FAILED", message, json!({ "reason": reason }))
            })?;

        // TUN 不设系统代理：接管靠路由表（`docs/config-execution.md` §2 第 4 步）。
        // 之前若在 proxy 模式，这里要把残留的系统代理撤掉，否则两层同时生效。
        self.restore_system_proxy()?;
        self.manager.set_system_proxy_enabled(false).await;

        log::debug!("连接 TUN 配置已生成");
        let launch_meta = crate::tun::session::TunLaunchMeta {
            config_id: config.id.clone(),
            config_name: Some(config.name.clone()),
            node_id: Some(current.id.clone()),
            node_name: Some(current.name.clone()),
            applied_route_revision: Some(config.route_revision),
            route_region: route_region.clone(),
        };
        // 这次启动可能在等 helper 的时候已被取消：`launch_registered` 会拒绝写入，
        // 并把 helper 刚拉起的实例停掉。
        let pid = match self
            .tun
            .launch_registered(launch, &config_json, &launch_meta)
        {
            Ok(started) => {
                log::info!("连接 TUN 运行时已启动 pid={}", started.pid);
                started.pid
            }
            Err(error) if error.code == crate::tun::backend::TunErrorCode::Cancelled => {
                log::info!("连接 TUN 启动已被新的操作取代 config={}", config.id);
                return Err(cancelled_connection_error());
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
                let stop_error = self.tun.stop_for_failed_launch(pid).err();
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
                let stop_error = self.tun.stop_for_failed_launch(pid).err();
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
            "port_fallback": null,
            "config_id": config.id,
            "config_name": config.name,
            "routing_mode": config.routing_mode,
            "node_id": current.id,
            "node_name": current.name,
            "applied_route_revision": config.route_revision,
            "route_region": route_region,
            "connected_since": chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
            "system_proxy_enabled": false,
            "system_dns": system_dns_label(self.tun.dns_hijack().as_ref()),
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
        route_region: Option<String>,
        // 用户设置的代理端口；用于快照回显「设置的是哪个」。TUN 不经过这里。
        requested_port: Option<u16>,
        fallback_reason: Option<crate::runtime::PortFallbackReason>,
        value: &Value,
        context: StartContext,
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

        // 冲突判定只看本次启动追加的日志段，历史行不参与。
        let log_path = StartPlan::log_path(&self.manager.cfg, &installed.version);
        let log_offset = log_size(&log_path);

        let plan = StartPlan {
            version: installed.version.clone(),
            binary: installed.binary.clone(),
            config_path: path,
            work_dir: installed.dir.clone(),
            log_path: log_path.clone(),
            clash_addr: format!("127.0.0.1:{clash_port}"),
            clash_secret: secret,
            mixed_port,
            requested_port,
            fallback_reason,
            config_id: db_config_id.clone(),
            config_name,
            node_id,
            node_name,
            applied_route_revision,
            route_region,
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

        // 真正起进程之前再确认一次没被取代：否则这一次会把新连接替换掉，
        // 而收尾按代数属于它、状态却归我们。
        self.ensure_start_is_current(context.epoch)?;

        let started = match self.manager.start(plan).await {
            Ok(status) => status,
            Err(error) => {
                let conflict = log_appended(&log_path, log_offset)
                    .map(|text| is_bind_conflict_text(&text))
                    .unwrap_or(false);
                let error = if conflict {
                    svc_error_with_details(error.code(), error, json!({ "port_conflict": true }))
                } else {
                    svc_error(error.code(), error)
                };
                let error = self.abort_connection(error);
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
            self.rollback_proxy_after_enable_failure(started.pid, context)
                .await;
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
        // 关代理、停运行时、删明文配置是一整段会改运行时的操作：进锁并推进代数。
        let verified = {
            let _ops = self.lock_runtime_ops().await?;
            self.bump_runtime_epoch();
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
            verified && self.manager.status().await.state == crate::runtime::RuntimeState::Idle
        };

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
    /// 实际顺序：停 TUN → 停运行时（同一锁段，只推进一代代数）→ 系统 DNS 兜底还原
    /// （锁外执行，不是上报步骤）→ 代理还原 → 清进程 → 清路由 → 刷 DNS → 清明文 → 复检。
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
        // 停 TUN + 停运行时都真实改运行时：同一把锁内完成、只推进一代。
        // 两步相邻上报；DNS 兜底还原不是上报步骤，排在两步之后、锁外执行，
        // 不让一次 XPC 卡住整条连接路径。
        let (stop_tun, stop_runtime) = self.reset_stop_everything().await;
        steps.push(stop_tun);
        steps.push(stop_runtime);
        // 兜底：连接期系统 DNS 指向了隧道；helper 崩溃重启后原始快照会丢，
        // 这里让它再清一次（幂等，没改过就是空操作，也不会动用户自己的 DNS）。
        // 放 spawn_blocking：XPC 调用可能等到超时，不能占住 async 线程。
        {
            let tun = Arc::clone(&self.tun);
            match tokio::task::spawn_blocking(move || tun.restore_dns()).await {
                Ok(Ok(())) => {}
                Ok(Err(error)) => log::warn!("强制重置：系统 DNS 还原失败：{error}"),
                Err(error) => log::warn!("强制重置：系统 DNS 还原任务失败：{error}"),
            }
        }
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

    /// 强制重置的前两步：停 TUN + 停运行时。两者都真实改运行时，
    /// 必须在 `runtime_ops` 内、在停之前推进代数。
    /// 取不到锁就不在锁外停（会和启动/重建交错）：两步如实记失败，其余步骤照跑。
    async fn reset_stop_everything(&self) -> (Value, Value) {
        match self.lock_runtime_ops().await {
            Ok(_ops) => {
                self.bump_runtime_epoch();
                (self.reset_stop_tun().await, self.reset_stop_runtime().await)
            }
            Err(error) => {
                log::error!("强制重置：等运行期操作锁超时，未在锁外停 TUN / 运行时：{error}");
                let message = "等运行期操作锁超时，没有在锁外停；稍后重试".to_string();
                (
                    reset_step("stop_tun", false, message.clone()),
                    reset_step("stop_runtime", false, message),
                )
            }
        }
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
    use crate::tun::backend::{StartReply, TunBackend, TunError, TunSnapshot};
    use std::path::Path;
    use std::sync::atomic::AtomicUsize;

    /// 只记录 stop 的假后端：启动窗口里断开的用例不碰真实 IPC。
    #[derive(Default)]
    struct QuietBackend {
        stops: AtomicUsize,
    }

    impl TunBackend for QuietBackend {
        fn availability(&self) -> Result<crate::tun::privilege::HelperStatus, TunError> {
            Ok(crate::tun::privilege::HelperStatus::Enabled)
        }

        fn ensure_available(&self) -> Result<crate::tun::privilege::HelperStatus, TunError> {
            Ok(crate::tun::privilege::HelperStatus::Enabled)
        }

        fn start(&self, _config: &str) -> Result<StartReply, TunError> {
            unreachable!("这个用例不起进程")
        }

        fn stop(&self) -> Result<(), TunError> {
            self.stops.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }

        fn status(&self) -> Result<TunSnapshot, TunError> {
            Ok(TunSnapshot {
                running: false,
                pid: None,
                clash_api: None,
                since: None,
                last_error: None,
                dns_hijack: Default::default(),
                helper_build: None,
                helper_version: None,
                helper_pid: None,
            })
        }

        fn restart(&self) -> Result<(), TunError> {
            Ok(())
        }
    }

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
    async fn config_detail_carries_the_layout_revision() {
        crate::test_support::install_test_secrets();
        let dir = temp_dir();
        let services = services(&dir);

        let created = services
            .config_create(create_input("布局 · 本机代理"))
            .await
            .unwrap();
        let config_id = created["config_id"].as_str().unwrap().to_string();

        let detail = services
            .config_detail(Some(config_id.clone()))
            .await
            .unwrap();
        assert_eq!(detail["layout"], serde_json::json!(null));
        assert_eq!(detail["layout_revision"], serde_json::json!(null));

        let revision = {
            let conn = services.store.conn();
            crate::store::layout::set(
                &conn,
                &config_id,
                &serde_json::json!({"version":1,"blocks":[{"type":"empty_hint"}]}),
            )
            .unwrap()
        };
        assert_eq!(revision, 1);

        let detail = services
            .config_detail(Some(config_id.clone()))
            .await
            .unwrap();
        assert_eq!(detail["layout_revision"], serde_json::json!(1));
        assert_eq!(
            detail["layout"]["blocks"][0]["type"],
            serde_json::json!("empty_hint")
        );
    }

    /// 配置里有自建节点时，AI 经 `ConfigDetail` 必须看得到它，并知道它为什么不可用。
    /// 回归：AI 曾只看 `DefaultProfileStatus`，把 3 个节点（含 1 个自建）答成 2 个免费节点。
    #[tokio::test]
    async fn config_detail_shows_owned_nodes_and_why_they_are_unavailable() {
        crate::test_support::install_test_secrets();
        let dir = temp_dir();
        let services = services(&dir);

        let created = services
            .config_create(create_input("含自建节点"))
            .await
            .unwrap();
        let config_id = created["config_id"].as_str().unwrap().to_string();

        {
            let conn = services.store.conn();
            configs::upsert_node(
                &conn,
                &crate::store::NewNode {
                    id: "nd_seed",
                    name: "免费 A",
                    server: "203.0.113.10",
                    port: 8388,
                    method: "aes-256-gcm",
                    password_ref: "node:nd_seed",
                    source: "seed",
                    source_key: "seed-a",
                },
            )
            .unwrap();
            configs::upsert_node(
                &conn,
                &crate::store::NewNode {
                    id: "nd_owned",
                    name: "纽约-便宜0.2",
                    server: "203.0.113.11",
                    port: 8388,
                    method: "aes-256-gcm",
                    password_ref: "node:nd_owned",
                    source: configs::SOURCE_OWNED,
                    source_key: "srv_x",
                },
            )
            .unwrap();
            configs::attach_node(&conn, &config_id, "nd_seed").unwrap();
            configs::attach_node(&conn, &config_id, "nd_owned").unwrap();
        }

        let detail = services
            .config_detail(Some(config_id.clone()))
            .await
            .unwrap();
        assert_eq!(detail["node_count"], 2);
        let nodes = detail["nodes"].as_array().unwrap();
        let owned = nodes
            .iter()
            .find(|node| node["node_id"] == "nd_owned")
            .expect("ConfigDetail 必须包含自建节点");
        assert_eq!(owned["source"], "owned");
        assert_eq!(owned["unavailable_reason"], serde_json::Value::Null);

        // 服务器停机销毁（镜像行 destroyed）：给出原因，AI 才能解释为什么用不了。
        {
            let conn = services.store.conn();
            crate::store::servers::upsert(
                &conn,
                &crate::store::NewMyServer {
                    id: "srv_x",
                    provider: "digitalocean",
                    name: "纽约",
                    region: "nyc1",
                    plan: "basic",
                    state: "destroyed",
                    node_id: Some("nd_owned"),
                    hourly_usd: 0.01,
                    monthly_usd: 6.0,
                    daily_price_cents: 20,
                    transfer_gib: 0,
                    paid_until: 0,
                    billing_state: "active",
                    created_at: 1,
                },
            )
            .unwrap();
        }
        let detail = services
            .config_detail(Some(config_id.clone()))
            .await
            .unwrap();
        let owned = detail["nodes"]
            .as_array()
            .unwrap()
            .iter()
            .find(|node| node["node_id"] == "nd_owned")
            .unwrap()
            .clone();
        assert_eq!(owned["unavailable_reason"], "server_destroyed");
    }

    /// `node_create` 的返回值与 `NodeSummary` 对齐：新节点必然可用，原因为 null。
    #[tokio::test]
    async fn node_create_reports_a_null_unavailable_reason() {
        crate::test_support::install_test_secrets();
        let dir = temp_dir();
        let services = services(&dir);
        let created = services
            .config_create(create_input("新建节点"))
            .await
            .unwrap();
        let config_id = created["config_id"].as_str().unwrap().to_string();

        let node = services
            .node_create(NodeCreateInput {
                config_id: Some(config_id),
                name: "东京".into(),
                server: "203.0.113.20".into(),
                port: 8388,
                password: "pw-secret".into(), // secret-scan:allow 测试夹具口令
                method: "aes-256-gcm".into(),
            })
            .await
            .unwrap();
        assert_eq!(node["source"], "manual");
        assert!(
            node["unavailable_reason"].is_null(),
            "新节点的原因必须是 null：{node}"
        );
    }

    /// 不传 `config_id` 就读当前激活配置：AI 手上没有配置 id，这必须是可用的入口。
    #[tokio::test]
    async fn config_detail_without_an_id_reads_the_active_config() {
        crate::test_support::install_test_secrets();
        let dir = temp_dir();
        let services = services(&dir);
        let created = services
            .config_create(create_input("当前配置"))
            .await
            .unwrap();
        let config_id = created["config_id"].as_str().unwrap().to_string();
        {
            let conn = services.store.conn();
            configs::upsert_node(
                &conn,
                &crate::store::NewNode {
                    id: "nd_owned",
                    name: "纽约-便宜0.2",
                    server: "203.0.113.11",
                    port: 8388,
                    method: "aes-256-gcm",
                    password_ref: "node:nd_owned",
                    source: configs::SOURCE_OWNED,
                    source_key: "srv_x",
                },
            )
            .unwrap();
            configs::attach_node(&conn, &config_id, "nd_owned").unwrap();
        }

        let detail = services.config_detail(None).await.unwrap();
        assert_eq!(detail["config_id"], config_id.as_str());
        assert!(
            detail["nodes"]
                .as_array()
                .unwrap()
                .iter()
                .any(|node| node["node_id"] == "nd_owned"),
            "不传 id 也要拿到完整节点列表：{detail}"
        );
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

        let detail = services
            .config_detail(Some(config_id.clone()))
            .await
            .unwrap();
        assert_eq!(detail["nodes"][0]["server"], "203.0.113.10");
        assert_eq!(detail["nodes"][0]["protocol"], "shadowsocks");
        // 导入不写当前节点：由用户点选或「连接」时再 `node_switch`。
        assert_eq!(detail["current_node_id"], serde_json::json!(null));
        assert!(detail.get("layout").is_some(), "layout 键恒存在");
        assert!(!detail.to_string().contains("pw-secret"));

        let node_id = detail["nodes"][0]["node_id"].as_str().unwrap().to_string();
        services.node_switch(&config_id, &node_id).await.unwrap();
        let detail = services
            .config_detail(Some(config_id.clone()))
            .await
            .unwrap();
        assert_eq!(detail["current_node_id"], node_id);

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

    /// 全局配置不能删：它是节点池与连接参数的唯一载体（`global-config-merge.md` §3.3）。
    ///
    /// 拒绝之后本地节点、密码与 `my_servers` 镜像都不该有任何变化。
    #[tokio::test]
    async fn deleting_the_global_config_is_retired() {
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

        let error = services.config_delete(&config_id).await.unwrap_err();
        let service = error.downcast_ref::<ServiceError>().unwrap();
        assert_eq!(service.code, "PRECONDITION_FAILED");
        assert_eq!(service.details.as_ref().unwrap()["reason"], "only_config");

        // 一样都没动：配置、节点、密码、云端服务器镜像。
        let conn = services.store.conn();
        assert!(configs::get(&conn, &config_id).unwrap().is_some());
        assert!(configs::get_node(&conn, &node_id).unwrap().is_some());
        drop(conn);
        assert!(crate::secrets::get_secret(&password_ref).unwrap().is_some());

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 删节点只把 `my_servers.node_id` 置空，服务器镜像行保留。
    #[tokio::test]
    async fn deleting_a_node_keeps_the_cloud_server_row_and_clears_the_link() {
        crate::test_support::install_test_secrets();
        let dir = temp_dir();
        let services = services(&dir);
        let created = services.config_create(create_input("A")).await.unwrap();
        let config_id = created["config_id"].as_str().unwrap().to_string();
        services
            .node_create(NodeCreateInput {
                config_id: Some(config_id.clone()),
                name: "大阪".into(),
                server: "198.51.100.9".into(),
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
        let server_id = "srv_keep_node";
        {
            let conn = services.store.conn();
            crate::store::servers::upsert(
                &conn,
                &crate::store::servers::NewMyServer {
                    id: server_id,
                    provider: "digitalocean",
                    name: "大阪",
                    region: "osa1",
                    plan: "s-1vcpu-1gb",
                    state: "active",
                    node_id: Some(&node_id),
                    hourly_usd: 0.01,
                    monthly_usd: 6.0,
                    daily_price_cents: 20,
                    transfer_gib: 0,
                    paid_until: 0,
                    billing_state: "active",
                    created_at: 1_700_000_000_000,
                },
            )
            .unwrap();
            assert!(configs::delete_node(&conn, &node_id).unwrap());
            assert!(configs::get_node(&conn, &node_id).unwrap().is_none());
            let server = crate::store::servers::get(&conn, server_id)
                .unwrap()
                .expect("删节点不能删服务器镜像行");
            assert_eq!(
                server.node_id, None,
                "外键 ON DELETE SET NULL 应把 node_id 置空"
            );
        }

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
    async fn config_set_mode_without_a_connection_only_writes_the_store() {
        let dir = temp_dir();
        let services = services(&dir);
        let created = services.config_create(create_input("A")).await.unwrap();
        let config_id = created["config_id"].as_str().unwrap().to_string();

        let data = services
            .config_set_mode(Some(config_id.clone()), configs::CONNECTION_TUN, false)
            .await
            .unwrap();
        assert_eq!(data["mode"], configs::CONNECTION_TUN);
        assert_eq!(data["previous_mode"], configs::CONNECTION_SYSTEM_PROXY);
        assert_eq!(data["changed"], true);
        assert_eq!(data["connected"], false);
        assert_eq!(data["restored"], true);
        assert_eq!(data["confirmation"], "not_needed");

        let detail = services
            .config_detail(Some(config_id.clone()))
            .await
            .unwrap();
        assert_eq!(detail["connect_mode"], configs::CONNECTION_TUN);
        assert!(detail["listen_port"].is_null(), "全部软件不能留代理端口");

        // 同值幂等：不改库、不刷新 updated_at。
        let before = detail["updated_at"].clone();
        let again = services
            .config_set_mode(Some(config_id.clone()), configs::CONNECTION_TUN, false)
            .await
            .unwrap();
        assert_eq!(again["changed"], false);
        assert_eq!(again["connected"], false);
        assert_eq!(again["confirmation"], "not_needed");
        assert_eq!(
            services
                .config_detail(Some(config_id.clone()))
                .await
                .unwrap()["updated_at"],
            before
        );

        let error = services
            .config_set_mode(Some(config_id), "vpn", false)
            .await
            .unwrap_err();
        assert_eq!(
            error.downcast_ref::<ServiceError>().unwrap().code,
            "INVALID_ARGUMENT"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 同配置并发：第二个请求直接 CONFLICT，不排队、不改库。
    #[tokio::test]
    async fn config_set_mode_rejects_a_concurrent_switch() {
        let dir = temp_dir();
        let services = services(&dir);
        let created = services.config_create(create_input("并发")).await.unwrap();
        let config_id = created["config_id"].as_str().unwrap().to_string();
        let _held = services.mode_switches.try_begin(&config_id).unwrap();

        let error = services
            .config_set_mode(Some(config_id.clone()), configs::CONNECTION_TUN, false)
            .await
            .unwrap_err();
        let service = error.downcast_ref::<ServiceError>().unwrap();
        assert_eq!(service.code, "CONFLICT");
        assert!(service.retryable, "并发冲突允许用户稍后重来");
        assert_eq!(
            service.details.as_ref().unwrap()["reason"],
            "switch_in_progress"
        );
        assert_eq!(
            services
                .config_detail(Some(config_id.clone()))
                .await
                .unwrap()["connect_mode"],
            configs::CONNECTION_SYSTEM_PROXY,
            "被拒绝的请求不能写库"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 接手旧 TUN、读不到属于哪套：不写库、不停起。
    #[tokio::test]
    async fn config_set_mode_reports_config_unknown_for_a_legacy_connection() {
        let dir = temp_dir();
        let services = services(&dir);
        let created = services
            .config_create(create_input("老 TUN"))
            .await
            .unwrap();
        let config_id = created["config_id"].as_str().unwrap().to_string();
        services.tun.force_running_for_test(4343, None);

        let error = services
            .config_set_mode(Some(config_id.clone()), configs::CONNECTION_TUN, false)
            .await
            .unwrap_err();
        let service = error.downcast_ref::<ServiceError>().unwrap();
        assert_eq!(service.code, "PRECONDITION_FAILED");
        assert_eq!(
            service.details.as_ref().unwrap()["reason"],
            "config_unknown"
        );
        assert_eq!(
            services
                .config_detail(Some(config_id.clone()))
                .await
                .unwrap()["connect_mode"],
            configs::CONNECTION_SYSTEM_PROXY
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 启动窗口也必须先确认：`runtime_status` 在这种状态下读不到「正在连」。
    #[tokio::test]
    async fn config_set_mode_requires_confirmation_while_the_connection_is_launching() {
        let dir = temp_dir();
        let services = services(&dir);
        let created = services
            .config_create(create_input("启动窗口"))
            .await
            .unwrap();
        let config_id = created["config_id"].as_str().unwrap().to_string();
        services.tun.force_launching_for_test(&config_id);

        let error = services
            .config_set_mode(Some(config_id.clone()), configs::CONNECTION_TUN, false)
            .await
            .unwrap_err();
        let service = error.downcast_ref::<ServiceError>().unwrap();
        assert_eq!(service.code, "PRECONDITION_FAILED");
        let details = service.details.as_ref().unwrap();
        assert_eq!(details["reason"], "confirmation_required");
        assert_eq!(details["will_disconnect"], true);
        assert_eq!(details["config_id"], config_id);
        assert_eq!(
            services
                .config_detail(Some(config_id.clone()))
                .await
                .unwrap()["connect_mode"],
            configs::CONNECTION_SYSTEM_PROXY,
            "未确认不能写库"
        );

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

        let detail = services
            .config_detail(Some(config_id.clone()))
            .await
            .unwrap();
        assert_eq!(detail["routing_mode"], configs::ROUTING_DIRECT);

        let route = services.route_get(Some(config_id)).await.unwrap();
        assert_eq!(route["routing_mode"], configs::ROUTING_DIRECT);
        assert!(route["applied_mode"].is_null());
        assert_eq!(route["reconnect_required"], true);

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// TUN 连接时 manager 是 Idle；热切换必须走 TUN 端点，不能落进「未连接」分支。
    #[tokio::test]
    async fn route_set_mode_hot_switches_over_the_tun_endpoint() {
        let dir = temp_dir();
        let services = services(&dir);
        let created = services
            .config_create(create_input("TUN 热切"))
            .await
            .unwrap();
        let config_id = created["config_id"].as_str().unwrap().to_string();
        // 不可达端点：只要请求真的发向 TUN 的 Clash API，就会以 route_switch_failed 结束。
        services.tun.force_running_with_clash_for_test(
            4242,
            &config_id,
            None,
            "127.0.0.1:9",
            "tun-secret",
        );

        let error = services
            .route_set_mode(Some(config_id), configs::ROUTING_DIRECT, false)
            .await
            .unwrap_err();
        let service = error.downcast_ref::<ServiceError>().unwrap();
        assert_eq!(service.code, "PRECONDITION_FAILED");
        assert_eq!(
            service.details.as_ref().unwrap()["reason"],
            "route_switch_failed"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// TUN 连接时 route_get 必须报「已生效」，而不是「下次连接生效」。
    #[tokio::test]
    async fn route_get_reports_the_tun_connection_as_applied() {
        let dir = temp_dir();
        let services = services(&dir);
        let created = services
            .config_create(create_input("TUN 读取"))
            .await
            .unwrap();
        let config_id = created["config_id"].as_str().unwrap().to_string();
        let before = services.route_get(Some(config_id.clone())).await.unwrap();
        let revision = before["route_revision"].as_i64().unwrap();

        services.tun.force_running_with_clash_for_test(
            5151,
            &config_id,
            Some(revision),
            "127.0.0.1:9",
            "tun-secret",
        );
        let route = services.route_get(Some(config_id)).await.unwrap();
        assert_eq!(route["applied_mode"], configs::ROUTING_PROXY_ALL);
        assert_eq!(route["applied_revision"], revision);
        assert_eq!(route["effective"], "current_connection");
        assert_eq!(route["reconnect_required"], false);

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 全局单配置：切到全局配置本身是幂等成功，其它 id 一律 `single_config`。
    #[tokio::test]
    async fn config_activate_is_idempotent_for_the_global_config() {
        let dir = temp_dir();
        let services = services(&dir);
        let created = services.config_create(create_input("全局")).await.unwrap();
        let config_id = created["config_id"].as_str().unwrap().to_string();

        services.tun.force_running_for_test(4242, Some(&config_id));
        let result = services.config_activate(&config_id).await.unwrap();
        assert_eq!(result["active_config_id"], config_id);
        assert_eq!(result["changed"], false);
        assert!(
            result.get("reconnect").is_none(),
            "reconnect 字段已从契约删除：{result}"
        );
        // 连接没被动过。
        assert_eq!(
            services.tun.status(),
            crate::tun::session::TunState::Running { pid: 4242 }
        );

        let error = services.config_activate("cfg_missing").await.unwrap_err();
        let service = error.downcast_ref::<ServiceError>().unwrap();
        assert_eq!(service.code, "CONFLICT");
        assert_eq!(service.details.as_ref().unwrap()["reason"], "single_config");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 启动窗口里切节点：隧道还没用上库里这个值，改库会让「记的」和「跑的」分叉。
    #[tokio::test]
    async fn node_switch_is_rejected_while_the_config_is_starting() {
        crate::test_support::install_test_secrets();
        let dir = temp_dir();
        let services = services(&dir);
        let created = services
            .config_create(create_input("启动窗口切节点"))
            .await
            .unwrap();
        let config_id = created["config_id"].as_str().unwrap().to_string();
        for (name, port) in [("东京", 8388), ("大阪", 8389)] {
            services
                .node_create(NodeCreateInput {
                    config_id: Some(config_id.clone()),
                    name: name.into(),
                    server: "203.0.113.10".into(),
                    port,
                    password: "pw".into(),
                    method: "aes-256-gcm".into(),
                })
                .await
                .unwrap();
        }
        // 导入不写当前节点，先自己选一个，再在启动窗口里试切到另一个。
        let detail = services
            .config_detail(Some(config_id.clone()))
            .await
            .unwrap();
        let ids = detail["nodes"]
            .as_array()
            .unwrap()
            .iter()
            .map(|node| node["node_id"].as_str().unwrap().to_string())
            .collect::<Vec<_>>();
        services.node_switch(&config_id, &ids[0]).await.unwrap();
        let current = ids[0].clone();
        let other = ids[1].clone();

        services.tun.force_launching_for_test(&config_id);
        let error = services.node_switch(&config_id, &other).await.unwrap_err();
        let service = error.downcast_ref::<ServiceError>().unwrap();
        assert_eq!(service.code, "PRECONDITION_FAILED");
        assert_eq!(
            service.details.as_ref().unwrap()["reason"],
            "config_launching"
        );

        // 库里的选择没被改：界面不能宣布「已切换到 X」。
        let after = services
            .config_detail(Some(config_id.clone()))
            .await
            .unwrap();
        assert_eq!(after["current_node_id"], current);

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 全局单配置：已有配置时再 `config_create` 一律 `CONFLICT / config_exists`。
    #[tokio::test]
    async fn a_second_config_create_is_rejected() {
        let dir = temp_dir();
        let services = services(&dir);
        let a = services.config_create(create_input("全局")).await.unwrap();
        let a_id = a["config_id"].as_str().unwrap().to_string();
        assert_eq!(a["is_active"], true);

        // 已连接、启动中都不给建第二套。
        services.tun.force_running_for_test(4242, Some(&a_id));
        let error = services
            .config_create(create_input("第二套"))
            .await
            .unwrap_err();
        let service = error.downcast_ref::<ServiceError>().unwrap();
        assert_eq!(service.code, "CONFLICT");
        assert_eq!(service.details.as_ref().unwrap()["reason"], "config_exists");

        services.tun.force_launching_for_test(&a_id);
        let error = services
            .config_create(create_input("第三套"))
            .await
            .unwrap_err();
        let service = error.downcast_ref::<ServiceError>().unwrap();
        assert_eq!(service.details.as_ref().unwrap()["reason"], "config_exists");

        let list = services.config_list().await.unwrap();
        assert_eq!(list["configs"].as_array().unwrap().len(), 1);
        assert_eq!(list["active_config_id"], a_id);

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 启动窗口里按断开：取消在途启动并停掉后端，不能让迟到的 start 继续。
    #[tokio::test]
    async fn runtime_stop_cancels_a_tun_start_in_flight() {
        let dir = temp_dir();
        let mut services = services(&dir);
        let created = services
            .config_create(create_input("启动窗口断开"))
            .await
            .unwrap();
        let config_id = created["config_id"].as_str().unwrap().to_string();

        let backend = Arc::new(QuietBackend::default());
        services.tun = Arc::new(crate::tun::session::TunSession::with_backend(
            backend.clone(),
            "quiet",
        ));
        services.tun.force_launching_for_test(&config_id);
        assert!(services.tun.is_launching());

        let snapshot = services
            .runtime_stop(false)
            .await
            .expect("启动窗口里断开要成功");
        assert_eq!(snapshot["state"], "idle");
        assert!(!services.tun.is_launching(), "断开必须取消在途启动");
        assert_eq!(backend.stops.load(Ordering::SeqCst), 1);

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 接手老 TUN、meta 里没有 config_id：切分流要显式说明，不能假装「下次生效」。
    #[tokio::test]
    async fn route_set_mode_reports_config_unknown_for_a_legacy_tun_connection() {
        let dir = temp_dir();
        let services = services(&dir);
        let created = services
            .config_create(create_input("老 TUN"))
            .await
            .unwrap();
        let config_id = created["config_id"].as_str().unwrap().to_string();

        services.tun.force_running_for_test(4343, None);
        let error = services
            .route_set_mode(Some(config_id.clone()), configs::ROUTING_DIRECT, false)
            .await
            .unwrap_err();
        let service = error.downcast_ref::<ServiceError>().unwrap();
        assert_eq!(service.code, "PRECONDITION_FAILED");
        assert_eq!(
            service.details.as_ref().unwrap()["reason"],
            "config_unknown"
        );

        // 设成当前值走幂等分支：仍返回快照，不报错。
        let same = services
            .route_set_mode(Some(config_id), configs::ROUTING_PROXY_ALL, false)
            .await
            .unwrap();
        assert_eq!(same["routing_mode"], configs::ROUTING_PROXY_ALL);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn proxy_selected_is_rejected_on_route_set_mode() {
        let dir = temp_dir();
        let services = services(&dir);
        let created = services.config_create(create_input("A")).await.unwrap();
        let config_id = created["config_id"].as_str().unwrap().to_string();
        let error = services
            .route_set_mode(Some(config_id), configs::ROUTING_PROXY_SELECTED, false)
            .await
            .unwrap_err();
        let service = error.downcast_ref::<ServiceError>().unwrap();
        assert_eq!(service.code, "INVALID_ARGUMENT");
        assert_eq!(
            service.details.as_ref().unwrap()["reason"],
            "routing_mode_not_supported"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 粘贴多行：逐条解析，一条坏的不作废整批。
    #[tokio::test]
    async fn pasted_node_text_imports_good_lines_and_reports_bad_ones() {
        crate::test_support::install_test_secrets();
        let dir = temp_dir();
        let services = services(&dir);
        let text = "ss://aes-256-gcm:pw-a@203.0.113.10:8388#A\n\
                    不是节点\n\
                    ss://rc4-md5:pw@203.0.113.11:8388#B\n\
                    ss://chacha20-ietf-poly1305:pw-c@203.0.113.12:8388#C";

        let data = services.node_import_text(None, text).await.unwrap();
        assert_eq!(data["imported"], 2);
        let names = data["nodes"]
            .as_array()
            .unwrap()
            .iter()
            .map(|node| node["name"].as_str().unwrap().to_string())
            .collect::<Vec<_>>();
        assert_eq!(names, vec!["A", "C"]);

        let skipped = data["skipped"].as_array().unwrap();
        assert_eq!(skipped.len(), 2);
        assert_eq!(skipped[0]["reason"], "unsupported_scheme");
        assert_eq!(skipped[1]["reason"], "unsupported_method");
        assert_eq!(skipped[1]["name"], "B");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 重复粘贴同一个节点不是错误，`skipped` 里标 `duplicate`。
    #[tokio::test]
    async fn importing_the_same_pasted_node_twice_marks_the_duplicate() {
        crate::test_support::install_test_secrets();
        let dir = temp_dir();
        let services = services(&dir);
        let text = "ss://aes-256-gcm:pw@203.0.113.10:8388#A";

        let first = services.node_import_text(None, text).await.unwrap();
        assert_eq!(first["imported"], 1);

        let again = services.node_import_text(None, text).await.unwrap();
        assert_eq!(again["imported"], 0);
        assert_eq!(again["nodes"].as_array().unwrap().len(), 0);
        assert_eq!(again["skipped"][0]["reason"], "duplicate");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 整段都不是节点时给可读原因，前端据此提示「这行内容不是节点」。
    #[tokio::test]
    async fn text_without_any_node_is_rejected_with_a_reason() {
        let dir = temp_dir();
        let services = services(&dir);

        let error = services
            .node_import_text(None, "hello\nworld")
            .await
            .unwrap_err();
        let service = error.downcast_ref::<ServiceError>().unwrap();
        assert_eq!(service.code, "INVALID_ARGUMENT");
        assert_eq!(service.details.as_ref().unwrap()["reason"], "not_node_text");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 带 configId 时按解析顺序追加；配置原先没有当前节点则取第一个。
    #[tokio::test]
    async fn pasted_nodes_are_appended_to_the_given_config() {
        crate::test_support::install_test_secrets();
        let dir = temp_dir();
        let services = services(&dir);
        let created = services.config_create(create_input("粘贴")).await.unwrap();
        let config_id = created["config_id"].as_str().unwrap().to_string();

        let text = "ss://aes-256-gcm:pw-a@203.0.113.10:8388#A\n\
                    ss://aes-256-gcm:pw-b@203.0.113.11:8388#B";
        let data = services
            .node_import_text(Some(config_id.clone()), text)
            .await
            .unwrap();
        assert_eq!(data["imported"], 2);

        let detail = services
            .config_detail(Some(config_id.clone()))
            .await
            .unwrap();
        assert_eq!(detail["node_count"], 2);
        let nodes = detail["nodes"].as_array().unwrap();
        assert_eq!(nodes[0]["name"], "A");
        assert_eq!(nodes[1]["name"], "B");
        // 导入只进池子，不写当前节点。
        assert_eq!(detail["current_node_id"], serde_json::json!(null));
        assert_eq!(nodes[0]["source"], "manual");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 文件通道：读文件后与粘贴导入共用解析；传 configId 时追加到该配置。
    #[tokio::test]
    async fn importing_a_file_appends_to_the_given_config() {
        crate::test_support::install_test_secrets();
        let dir = temp_dir();
        let services = services(&dir);
        let created = services.config_create(create_input("文件")).await.unwrap();
        let config_id = created["config_id"].as_str().unwrap().to_string();

        let path = dir.join("nodes.txt");
        std::fs::write(&path, "ss://aes-256-gcm:pw-a@203.0.113.10:8388#F\n垃圾行").unwrap();

        let data = crate::agent::commands::import_nodes_from_file(
            &services,
            path.to_str().unwrap(),
            Some(config_id.clone()),
        )
        .await
        .unwrap();
        assert_eq!(data["imported"], 1, "一行坏的不作废整批");
        assert_eq!(data["skipped"][0]["reason"], "unsupported_scheme");

        let detail = services
            .config_detail(Some(config_id.clone()))
            .await
            .unwrap();
        assert_eq!(detail["node_count"], 1, "追加到指定配置后节点数增加");
        assert_eq!(detail["nodes"][0]["name"], "F");
        assert_eq!(detail["nodes"][0]["source"], "manual");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 空文件：可读，但解析不出节点 → `not_node_text`；文件措辞由前端按 reason 渲染。
    #[tokio::test]
    async fn an_empty_file_is_rejected_as_not_node_text() {
        crate::test_support::install_test_secrets();
        let dir = temp_dir();
        let services = services(&dir);
        let path = dir.join("empty.txt");
        std::fs::write(&path, "").unwrap();

        let error =
            crate::agent::commands::import_nodes_from_file(&services, path.to_str().unwrap(), None)
                .await
                .unwrap_err();
        assert_eq!(error["code"], "INVALID_ARGUMENT");
        assert_eq!(error["details"]["reason"], "not_node_text");
        assert_eq!(error["message"], "");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 未知 `configId` 的服务层错误原样透传，不能被文件侧错误码盖掉。
    #[tokio::test]
    async fn a_missing_config_id_keeps_the_not_found_error() {
        crate::test_support::install_test_secrets();
        let dir = temp_dir();
        let services = services(&dir);
        let path = dir.join("nodes.txt");
        std::fs::write(&path, "ss://aes-256-gcm:pw-a@203.0.113.10:8388#F\n").unwrap();

        let error = crate::agent::commands::import_nodes_from_file(
            &services,
            path.to_str().unwrap(),
            Some("config-missing".into()),
        )
        .await
        .unwrap_err();
        assert_eq!(error["code"], "NOT_FOUND");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 问题报告的域名开关：省略参数是读取，传值是写入；默认关闭。
    #[tokio::test]
    async fn issue_report_domain_preference_round_trips() {
        crate::test_support::install_test_secrets();
        let dir = temp_dir();
        let services = services(&dir);
        assert_eq!(
            services.issue_report_preference(None).await.unwrap()["includeDomains"],
            false
        );
        assert_eq!(
            services.issue_report_preference(Some(true)).await.unwrap()["includeDomains"],
            true
        );
        assert_eq!(
            services.issue_report_preference(None).await.unwrap()["includeDomains"],
            true
        );
        assert_eq!(
            services.issue_report_preference(Some(false)).await.unwrap()["includeDomains"],
            false
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Clash 端点按连接身份选：TUN 只认 TUN，代理只认 plan，绝不互相兜底。
    #[test]
    fn clash_endpoint_follows_the_connection_identity() {
        let plan = ("127.0.0.1:41000".to_string(), "plan-secret".to_string());
        let tun = ("127.0.0.1:42000".to_string(), "tun-secret".to_string());

        // TUN 连接：即使旧 plan 还在，也只用 TUN 的端点。
        assert_eq!(
            resolve_clash_endpoint(true, Some(plan.clone()), Some(tun.clone())),
            Some(tun.clone())
        );
        // 代理连接：只用 plan。
        assert_eq!(
            resolve_clash_endpoint(false, Some(plan.clone()), Some(tun.clone())),
            Some(plan)
        );
        // 身份对不上时为 None，不能写到另一个进程。
        assert_eq!(resolve_clash_endpoint(false, None, Some(tun)), None);
        assert_eq!(resolve_clash_endpoint(true, None, None), None);
    }

    /// 未知地区没有本地直连层，口径必须是 `none`，不能报成 `ip_only`。
    #[test]
    fn local_direct_basis_reports_none_for_unknown_region() {
        assert_eq!(local_direct_basis(Some("cn")), "domain_and_ip");
        assert_eq!(local_direct_basis(Some("jp")), "ip_only");
        assert_eq!(local_direct_basis(None), "none");
    }

    /// 四个入口（连接 / 测速 / `route_get` / `system_region`）读同一个来源。
    /// 连接与测速的取值没法在单测里直接观察，但它们调用的是同一个
    /// `effective_region()`；这里断言两个可观察入口一致，防止再出现各自兜底。
    #[tokio::test]
    async fn region_entry_points_agree() {
        crate::test_support::install_test_secrets();
        let dir = temp_dir();
        let services = services(&dir);
        let created = services.config_create(create_input("地区")).await.unwrap();
        let config_id = created["config_id"].as_str().unwrap().to_string();

        let route = services.route_get(Some(config_id)).await.unwrap();
        let command = services.system_region().await.unwrap();
        let (detected, source) = crate::rules::effective_region(&services.store);

        assert_eq!(command["region"], route["detected_region"]);
        assert_eq!(route["detected_region"], json!(detected.code()));
        assert_eq!(command["region"], json!(detected.code()));
        assert_eq!(command["source"], source.as_str());

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 写入后四个入口同时换值；连接 / 测速读的 `effective_region()` 也换。
    #[tokio::test]
    async fn set_user_region_updates_every_entry_point() {
        crate::test_support::install_test_secrets();
        let dir = temp_dir();
        let services = services(&dir);
        let created = services.config_create(create_input("地区")).await.unwrap();
        let config_id = created["config_id"].as_str().unwrap().to_string();

        let written = services.set_user_region("JP").await.unwrap();
        assert_eq!(written["region"], "jp");
        assert_eq!(written["source"], "ai");

        let route = services.route_get(Some(config_id)).await.unwrap();
        let command = services.system_region().await.unwrap();
        let (effective, source) = crate::rules::effective_region(&services.store);
        let basis = route["local_direct_basis"].as_str().unwrap();

        assert_eq!(route["detected_region"], "jp");
        assert_eq!(command["region"], "jp");
        assert_eq!(command["source"], "ai");
        assert_eq!(effective, crate::rules::Region::Cc("jp".into()));
        assert_eq!(source, crate::rules::RegionSource::Ai);
        assert_eq!(basis, "ip_only");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 同一地区重复写入仍成功（幂等；事件只在值真正变化时发）。
    #[tokio::test]
    async fn writing_the_same_region_twice_stays_ok() {
        crate::test_support::install_test_secrets();
        let dir = temp_dir();
        let services = services(&dir);

        let first = services.set_user_region("jp").await.unwrap();
        let second = services.set_user_region("JP").await.unwrap();
        assert_eq!(first, second);
        assert_eq!(second["region"], "jp");
        assert_eq!(second["source"], "ai");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn invalid_user_region_is_rejected_without_writing() {
        crate::test_support::install_test_secrets();
        let dir = temp_dir();
        let services = services(&dir);

        for bad in ["", "usa", "日本", "1"] {
            let error = services.set_user_region(bad).await.unwrap_err();
            let service = error.downcast_ref::<ServiceError>().unwrap();
            assert_eq!(service.code, "INVALID_ARGUMENT", "{bad}");
            assert_eq!(
                service.details.as_ref().unwrap()["reason"],
                "invalid_region",
                "{bad}"
            );
        }

        let stored = {
            let conn = services.store.conn();
            crate::store::settings::get(&conn, crate::store::settings::USER_REGION_KEY).unwrap()
        };
        assert!(stored.is_none(), "非法值不得落库");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn region_changed_event_has_the_contract_shape() {
        let payload =
            region_changed_payload(&crate::rules::Region::Cn, crate::rules::RegionSource::Ai);
        assert_eq!(
            payload["contract_version"],
            crate::runtime::EVENT_CONTRACT_VERSION
        );
        assert_eq!(payload["region"], "cn");
        assert_eq!(payload["source"], "ai");
        let emitted_at = payload["emitted_at"].as_str().unwrap();
        assert!(emitted_at.ends_with('Z'), "{emitted_at}");
        assert_eq!(payload.as_object().unwrap().len(), 4);
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

        let detail = services
            .config_detail(Some(config_id.clone()))
            .await
            .unwrap();
        assert_eq!(detail["current_node_id"], node_id);

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 只答 Clash selector 成员表的假运行时：`all` 是运行配置里实际存在的 tag。
    fn spawn_selector_api(all: Vec<String>, now: String) -> String {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap().to_string();
        let all_json = serde_json::json!(all).to_string();
        let now_json = serde_json::json!(now).to_string();
        std::thread::spawn(move || {
            for socket in listener.incoming() {
                let Ok(mut socket) = socket else { return };
                let mut buf = [0u8; 4096];
                let read = socket.read(&mut buf).unwrap_or(0);
                let head = String::from_utf8_lossy(&buf[..read]);
                let body = if head.starts_with("GET /proxies/proxy") {
                    format!(
                        r#"{{"name":"proxy","type":"Selector","now":{now_json},"all":{all_json}}}"#
                    )
                } else {
                    r#"{"version":"test","meta":false,"premium":false}"#.to_string()
                };
                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = socket.write_all(response.as_bytes());
            }
        });
        addr
    }

    /// 连接之后才 attach 进来的节点不在运行配置里：要说「连接后新增」，
    /// 不能说「服务器域名解析失败」——这台机器的地址可能就是个 IP。
    #[tokio::test]
    async fn node_switch_reports_a_node_added_after_connect() {
        crate::test_support::install_test_secrets();
        let dir = temp_dir();
        let services = services(&dir);
        let created = services
            .config_create(create_input("连接后新增"))
            .await
            .unwrap();
        let config_id = created["config_id"].as_str().unwrap().to_string();

        // 连接时池里只有旧节点；新节点是连上之后才加进来的。
        let old_id = services
            .node_create(NodeCreateInput {
                config_id: Some(config_id.clone()),
                name: "旧节点".into(),
                server: "203.0.113.10".into(),
                port: 8388,
                password: "pw".into(),
                method: "aes-256-gcm".into(),
            })
            .await
            .unwrap()["node_id"]
            .as_str()
            .unwrap()
            .to_string();
        let added_id = services
            .node_create(NodeCreateInput {
                config_id: Some(config_id.clone()),
                name: "新节点".into(),
                server: "203.0.113.11".into(),
                port: 8388,
                password: "pw".into(),
                method: "aes-256-gcm".into(),
            })
            .await
            .unwrap()["node_id"]
            .as_str()
            .unwrap()
            .to_string();
        services.node_switch(&config_id, &old_id).await.unwrap();

        let addr = spawn_selector_api(vec![format!("node-{old_id}")], format!("node-{old_id}"));
        services.tun.force_running_with_clash_for_test(
            4242,
            &config_id,
            None,
            &addr,
            "selector-secret",
        );

        let error = services
            .node_switch(&config_id, &added_id)
            .await
            .unwrap_err();
        let service = error.downcast_ref::<ServiceError>().unwrap();
        assert_eq!(service.code, "PRECONDITION_FAILED");
        let details = service.details.as_ref().unwrap();
        assert_eq!(details["reason"], "runtime_switch_failed");
        assert_eq!(details["detail"]["reason"], "node_not_in_running_config");
        assert_eq!(details["node_id"], added_id);
        assert!(
            service.message.contains("重新连接"),
            "文案要点明重连即可：{}",
            service.message
        );

        // 失败不写库：不能留下「库里切了、实际没切」的分叉。
        let detail = services
            .config_detail(Some(config_id.clone()))
            .await
            .unwrap();
        assert_eq!(detail["current_node_id"], old_id);

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 锁排队超时必须可重试：界面/工具据此给「再试一次」，而不是报失败。
    #[test]
    fn a_lock_timeout_is_retryable() {
        let error = runtime_busy_error();
        let service = error.downcast_ref::<ServiceError>().unwrap();
        assert_eq!(service.code, "TIMEOUT");
        assert!(service.retryable, "排队超时不是失败，要允许重试");
        assert_eq!(service.details.as_ref().unwrap()["reason"], "runtime_busy");
    }

    /// 排队上限是真的经锁生效的：用户侧 20s 到点前一直排队，到点才 TIMEOUT / runtime_busy；
    /// 重建侧 20s 到点降级成 skipped / runtime_busy。用冻结时钟手动 poll，不依赖调度顺序。
    #[tokio::test]
    async fn runtime_lock_waits_time_out_on_their_own_boundaries() {
        tokio::time::pause();
        let dir = temp_dir();
        let services = services(&dir);
        let hold = services.runtime_ops.lock().await;

        struct NoopWaker;
        impl std::task::Wake for NoopWaker {
            fn wake(self: std::sync::Arc<Self>) {}
        }
        let waker = std::task::Waker::from(std::sync::Arc::new(NoopWaker));
        let mut cx = std::task::Context::from_waker(&waker);

        let error = {
            let mut user = std::pin::pin!(services.lock_runtime_ops());
            // 第一次 poll 就排到锁上，超时计时从这一刻起算。
            assert!(matches!(
                std::future::Future::poll(user.as_mut(), &mut cx),
                std::task::Poll::Pending
            ));
            tokio::time::advance(std::time::Duration::from_secs(19)).await;
            assert!(
                matches!(
                    std::future::Future::poll(user.as_mut(), &mut cx),
                    std::task::Poll::Pending
                ),
                "19s 不该超时"
            );
            tokio::time::advance(std::time::Duration::from_secs(2)).await;
            match std::future::Future::poll(user.as_mut(), &mut cx) {
                std::task::Poll::Ready(Err(error)) => error,
                _ => panic!("20s 到点必须超时"),
            }
        };
        let service = error.downcast_ref::<ServiceError>().unwrap();
        assert_eq!(service.code, "TIMEOUT");
        assert!(service.retryable, "排队超时不是失败，要允许重试");
        assert_eq!(service.details.as_ref().unwrap()["reason"], "runtime_busy");

        let reason = {
            let mut rebuild = std::pin::pin!(services.lock_runtime_ops_skipped("测试"));
            assert!(matches!(
                std::future::Future::poll(rebuild.as_mut(), &mut cx),
                std::task::Poll::Pending
            ));
            tokio::time::advance(std::time::Duration::from_secs(19)).await;
            assert!(
                matches!(
                    std::future::Future::poll(rebuild.as_mut(), &mut cx),
                    std::task::Poll::Pending
                ),
                "19s 不该超时"
            );
            tokio::time::advance(std::time::Duration::from_secs(2)).await;
            match std::future::Future::poll(rebuild.as_mut(), &mut cx) {
                std::task::Poll::Ready(Err(reason)) => reason,
                _ => panic!("20s 到点必须降级成 skipped"),
            }
        };
        assert_eq!(reason["status"], "skipped");
        assert_eq!(reason["reason"], "runtime_busy");

        drop(hold);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 拿不到运行期锁时只能报「不知道」——用户没按断开，不能冒充 `user_disconnected`。
    #[tokio::test]
    async fn the_post_start_check_reports_unknown_instead_of_disconnected() {
        tokio::time::pause();
        let dir = temp_dir();
        let services = services(&dir);
        let hold = services.runtime_ops.lock().await;

        struct NoopWaker;
        impl std::task::Wake for NoopWaker {
            fn wake(self: std::sync::Arc<Self>) {}
        }
        let waker = std::task::Waker::from(std::sync::Arc::new(NoopWaker));
        let mut cx = std::task::Context::from_waker(&waker);

        let applied: anyhow::Result<Value> = Ok(json!({}));
        let state = {
            let mut check =
                std::pin::pin!(services.still_connected_after_start("cfg_test", &applied));
            assert!(matches!(
                std::future::Future::poll(check.as_mut(), &mut cx),
                std::task::Poll::Pending
            ));
            tokio::time::advance(std::time::Duration::from_secs(21)).await;
            match std::future::Future::poll(check.as_mut(), &mut cx) {
                std::task::Poll::Ready(state) => state,
                _ => panic!("20s 到点必须放弃等待"),
            }
        };
        assert_eq!(state, AfterStart::Unknown, "拿不到锁只能报「不知道」");

        let value = rebuild_unknown();
        assert!(
            value.get("reason").is_none(),
            "不能带 user_disconnected：{value}"
        );
        assert!(
            !value["message"].as_str().unwrap().contains("断开"),
            "文案不能说「已按你的操作断开」：{value}"
        );

        drop(hold);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 「被新的操作接管」不能被写成「已按你的操作断开」。
    #[test]
    fn the_replaced_rebuild_message_does_not_claim_a_user_disconnect() {
        let replaced = rebuild_replaced_by_new_connection();
        assert!(replaced.get("reason").is_none(), "{replaced}");
        assert_eq!(replaced["status"], "failed");
        assert_eq!(replaced["restored"], false);
        assert_eq!(replaced["new_nodes_available_next_connect"], true);
        assert!(
            !replaced["message"].as_str().unwrap().contains("断开"),
            "接管不是断开：{replaced}"
        );

        let disconnected = user_disconnected_rebuild();
        assert_eq!(disconnected["reason"], "user_disconnected");
        assert!(disconnected["message"].as_str().unwrap().contains("断开"));
    }

    #[tokio::test]
    async fn node_probe_without_credentials_is_untested_not_unreachable() {
        crate::test_support::install_test_secrets();
        let dir = temp_dir();
        let services = services(&dir);
        let created = services.config_create(create_input("A")).await.unwrap();
        let config_id = created["config_id"].as_str().unwrap().to_string();
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
        crate::secrets::delete_secret(&format!("node:{node_id}")).unwrap();

        // 没有凭据就渲染不出出站：如实说「没测成」，不能用 reachable=false 冒充「连不通」。
        let probe = services.node_probe(&node_id).await.unwrap();
        assert_eq!(probe["status"], "untested");
        assert_eq!(probe["reachable"], Value::Null);
        assert_eq!(probe["probe_method"], "none");
        assert_eq!(probe["error"]["code"], "PROBE_UNAVAILABLE");
        assert_eq!(probe["error"]["reason"], "no_credentials");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn node_probe_is_untested_when_another_config_is_connected() {
        crate::test_support::install_test_secrets();
        let dir = temp_dir();
        let services = services(&dir);
        let created = services
            .config_create(create_input("已连接"))
            .await
            .unwrap();
        let config_id = created["config_id"].as_str().unwrap().to_string();
        let node = services
            .node_create(NodeCreateInput {
                config_id: Some(config_id.clone()),
                name: "池里的节点".into(),
                server: "203.0.113.1".into(),
                port: 443,
                password: "pw".into(),
                method: "aes-256-gcm".into(),
            })
            .await
            .unwrap();
        let node_id = node["node_id"].as_str().unwrap().to_string();

        // 已连接的是另一套：TUN 起不了第二个运行时，proxy 模式也一律不起。
        services
            .tun
            .force_running_for_test(4343, Some("cfg_somewhere_else"));
        let probe = services.node_probe(&node_id).await.unwrap();
        assert_eq!(probe["status"], "untested");
        assert_eq!(probe["reachable"], Value::Null);
        assert_eq!(probe["probe_method"], "none");
        assert_eq!(probe["error"]["reason"], "other_config");
        assert!(
            probe["error"]["message"]
                .as_str()
                .unwrap_or_default()
                .contains("先断开"),
            "{probe}"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 已连接另一套配置：整批直接判未测，不起任何探针运行时，快照 method 为 none。
    #[tokio::test]
    async fn probe_batch_is_untested_when_another_config_is_connected() {
        crate::test_support::install_test_secrets();
        let dir = temp_dir();
        let services = services(&dir);
        let created = services
            .config_create(create_input("批量未测"))
            .await
            .unwrap();
        let config_id = created["config_id"].as_str().unwrap().to_string();
        for (name, server) in [("甲", "203.0.113.11"), ("乙", "203.0.113.12")] {
            services
                .node_create(NodeCreateInput {
                    config_id: Some(config_id.clone()),
                    name: name.into(),
                    server: server.into(),
                    port: 443,
                    password: "pw".into(), // secret-scan:allow
                    method: "aes-256-gcm".into(),
                })
                .await
                .unwrap();
        }

        // 已连接的是另一套：TUN 起不了第二个运行时，proxy 模式也一律不起。
        services
            .tun
            .force_running_for_test(4344, Some("cfg_somewhere_else"));

        let started = services
            .node_probe_all(Some(config_id.clone()), None)
            .await
            .unwrap();
        assert_eq!(started["total"], 2);

        // 批次的探针任务还没拿到执行权：第一次快照一定能看到在跑的 run 与方式。
        let mut snapshot = services
            .node_probe_snapshot(Some(config_id.clone()))
            .await
            .unwrap();
        assert!(!snapshot["run"].is_null(), "批次没有在跑：{snapshot}");
        assert_eq!(snapshot["run"]["method"], "none");

        for _ in 0..200 {
            if snapshot["run"].is_null() {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            snapshot = services
                .node_probe_snapshot(Some(config_id.clone()))
                .await
                .unwrap();
        }
        assert!(snapshot["run"].is_null(), "批次没有结束：{snapshot}");

        let results = snapshot["results"].as_array().unwrap();
        assert_eq!(results.len(), 2);
        for result in results {
            assert_eq!(result["status"], "untested", "{result}");
            assert_eq!(result["reachable"], Value::Null);
            assert_eq!(result["probe_method"], "none");
            assert_eq!(result["error"]["reason"], "other_config");
        }
        // 探针跑在独立槽位，误起探针不会改 `status`：直接看槽位里有没有 secret。
        assert!(
            services.manager.probe_secret().await.is_none(),
            "untested 分支不应起探针运行时"
        );

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
    async fn proxy_selected_is_rejected_on_create_and_update() {
        let dir = temp_dir();
        let services = services(&dir);
        let mut input = create_input("A");
        input.routing_mode = configs::ROUTING_PROXY_SELECTED.into();
        let error = services.config_create(input).await.unwrap_err();
        let service = error.downcast_ref::<ServiceError>().unwrap();
        assert_eq!(service.code, "INVALID_ARGUMENT");
        assert_eq!(
            service.details.as_ref().unwrap()["reason"],
            "routing_mode_not_supported"
        );

        let created = services.config_create(create_input("B")).await.unwrap();
        let config_id = created["config_id"].as_str().unwrap().to_string();
        let error = services
            .config_update(
                &config_id,
                ConfigUpdateInput {
                    routing_mode: Some(configs::ROUTING_PROXY_SELECTED.into()),
                    ..Default::default()
                },
            )
            .await
            .unwrap_err();
        let service = error.downcast_ref::<ServiceError>().unwrap();
        assert_eq!(service.code, "INVALID_ARGUMENT");
        assert_eq!(
            service.details.as_ref().unwrap()["reason"],
            "routing_mode_not_supported"
        );

        // 不认识的值仍是 invalid_routing_mode，两种错误不能混。
        let mut unknown = create_input("C");
        unknown.routing_mode = "smart".into();
        let error = services.config_create(unknown).await.unwrap_err();
        let service = error.downcast_ref::<ServiceError>().unwrap();
        assert_eq!(
            service.details.as_ref().unwrap()["reason"],
            "invalid_routing_mode"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 命令层直接调这个校验：缺省、`empty`、空数组都拒绝，文案与工具层一致。
    #[test]
    fn config_create_requires_a_node_source_at_the_service_layer() {
        let empty: Vec<String> = Vec::new();
        let nodes = vec!["nod_1".to_string()];
        for (source, node_ids) in [
            (None, None),
            (Some("empty"), None),
            (None, Some(empty.as_slice())),
        ] {
            let error = require_node_source(source, node_ids).unwrap_err();
            let service = error.downcast_ref::<ServiceError>().unwrap();
            assert_eq!(service.code, "INVALID_ARGUMENT");
            assert_eq!(service.message, SOURCE_REQUIRED_MESSAGE);
            assert_eq!(
                service.details.as_ref().unwrap()["reason"],
                "source_required"
            );
        }

        assert!(require_node_source(Some("seed"), None).is_ok());
        assert!(require_node_source(Some("SEED"), None).is_ok());
        assert!(require_node_source(None, Some(nodes.as_slice())).is_ok());
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
    async fn deleting_the_global_config_is_retired_even_while_tun_is_running() {
        let dir = temp_dir();
        let services = services(&dir);
        let created = services.config_create(create_input("A")).await.unwrap();
        let config_id = created["config_id"].as_str().unwrap().to_string();

        // 不管 TUN 是不是正用着这套、读不读得到配置 id，删除都只回 only_config。
        services.tun.force_running_for_test(4242, Some(&config_id));
        let error = services.config_delete(&config_id).await.unwrap_err();
        assert!(error.to_string().contains("全局配置不能删除"), "{error}");

        services.tun.force_running_for_test(4343, None);
        let error = services.config_delete(&config_id).await.unwrap_err();
        assert!(error.to_string().contains("全局配置不能删除"), "{error}");
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

    /// TUN 下 `data_plane` 必须来自真实探测：未探测乐观 true，单次失败不改值，
    /// 连续两次才报不通，一次成功立即恢复。`checked_at` 是探测时刻，不是查询时刻。
    #[tokio::test]
    async fn a_tun_connection_reports_the_probed_data_plane() {
        let dir = temp_dir();
        let services = services(&dir);
        services.tun.force_running_for_test(6262, Some("cfg_tun"));

        let status = services.runtime_status().await.unwrap();
        assert_eq!(status["health"]["data_plane"], true, "未探测时乐观为 true");
        assert!(
            status["traffic"].is_null(),
            "没有流量是 null，不能被读成探测失败"
        );
        let first_checked_at = status["health"]["checked_at"].as_str().unwrap().to_string();

        services.tun.record_data_plane(false);
        let status = services.runtime_status().await.unwrap();
        assert_eq!(status["health"]["data_plane"], true, "一次失败不改值");
        let second_checked_at = status["health"]["checked_at"].as_str().unwrap().to_string();
        assert!(second_checked_at >= first_checked_at, "探测时刻只会往前走");

        services.tun.record_data_plane(false);
        let status = services.runtime_status().await.unwrap();
        assert_eq!(
            status["health"]["data_plane"], false,
            "连续两次失败必须报不通行"
        );
        let failed_checked_at = status["health"]["checked_at"].as_str().unwrap().to_string();

        // 再查一次快照：checked_at 不能被查询时刻顶替，否则陈旧结论会被当成新鲜。
        let again = services.runtime_status().await.unwrap();
        assert_eq!(again["health"]["checked_at"], failed_checked_at);

        services.tun.record_data_plane(true);
        let status = services.runtime_status().await.unwrap();
        assert_eq!(status["health"]["data_plane"], true, "一次成功立即恢复");

        let _ = std::fs::remove_dir_all(&dir);
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
        {
            let conn = services.store.conn();
            crate::store::settings::set_proxy_port(&conn, 8080).unwrap();
        }
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
        assert!(tun["mixed_port"].is_null(), "TUN 不上报 mixed 端口");
        assert!(
            tun["port_fallback"].is_null(),
            "TUN 不读设置端口，也不存在降级"
        );
    }
    /// 刷新成功后种子节点要并进全局配置：模型没有 `node_attach` 可调。
    #[tokio::test]
    async fn a_seed_refresh_merges_new_nodes_into_the_global_config() {
        let dir = temp_dir();
        // 进程级 secrets 只能有一个根：用共享的测试存储。装到本用例自己的目录、
        // 再在结尾删掉，会让并行跑的其它用例一起报「凭据存储不可用」。
        crate::test_support::install_test_secrets();
        let services = services(&dir);
        {
            let body = r#"{
              "version": 1,
              "updated_at": "2026-11-17T00:00:00Z",
              "nodes": [
                { "name": "免费 A", "server": "203.0.113.10", "port": 8388,
                  "method": "aes-256-gcm", "password": "pw-a" },
                { "name": "免费 B", "server": "203.0.113.11", "port": 8388,
                  "method": "aes-256-gcm", "password": "pw-b" }
              ]
            }"#;
            let hash = crate::seed::content_sha256(body.as_bytes());
            crate::secrets::set_secret(&format!("seed:{hash}"), body).unwrap();
            let conn = services.store.conn();
            crate::store::seed_cache::save(
                &conn,
                &crate::store::seed_cache::SeedCacheRow {
                    content_sha256: hash,
                    etag: None,
                    etag_source: None,
                    source_version: Some("1".into()),
                    source_updated_at: None,
                    node_count: 2,
                    fetched_at: 0,
                    checked_at: 0,
                },
            )
            .unwrap();
        }

        // 空库：懒创建默认配置并绑定两个种子节点。
        services.merge_seed_into_global().unwrap();
        let list = services.config_list().await.unwrap();
        let configs = list["configs"].as_array().unwrap();
        assert_eq!(configs.len(), 1);
        assert_eq!(configs[0]["name"], configs::DEFAULT_CONFIG_NAME);
        assert_eq!(configs[0]["node_count"], 2);
        assert!(configs[0]["current_node_id"].is_null());

        // 重复合并：不重复绑定、不重复建配置。
        services.merge_seed_into_global().unwrap();
        let detail = services
            .config_detail(Some(configs[0]["config_id"].as_str().unwrap().to_string()))
            .await
            .unwrap();
        assert_eq!(detail["node_count"], 2);
        assert!(detail["current_node_id"].is_null());
    }

    /// 合并种子不动当前节点：用户已经选了自建节点时，刷新不能把选择改回种子。
    #[tokio::test]
    async fn a_seed_refresh_does_not_change_the_current_node() {
        crate::test_support::install_test_secrets();
        let dir = temp_dir();
        let services = services(&dir);
        let created = services.config_create(create_input("全局")).await.unwrap();
        let config_id = created["config_id"].as_str().unwrap().to_string();
        let node = services
            .node_create(NodeCreateInput {
                config_id: Some(config_id.clone()),
                name: "自建".into(),
                server: "198.51.100.20".into(),
                port: 8388,
                password: "pw".into(),
                method: "aes-256-gcm".into(),
            })
            .await
            .unwrap();
        let owned_id = node["node_id"].as_str().unwrap().to_string();
        services.node_switch(&config_id, &owned_id).await.unwrap();

        {
            let body = r#"{
              "version": 1,
              "updated_at": "2026-11-17T00:00:00Z",
              "nodes": [
                { "name": "免费 A", "server": "203.0.113.10", "port": 8388,
                  "method": "aes-256-gcm", "password": "pw-a" }
              ]
            }"#;
            let hash = crate::seed::content_sha256(body.as_bytes());
            crate::secrets::set_secret(&format!("seed:{hash}"), body).unwrap();
            let conn = services.store.conn();
            crate::store::seed_cache::save(
                &conn,
                &crate::store::seed_cache::SeedCacheRow {
                    content_sha256: hash,
                    etag: None,
                    etag_source: None,
                    source_version: Some("1".into()),
                    source_updated_at: None,
                    node_count: 1,
                    fetched_at: 0,
                    checked_at: 0,
                },
            )
            .unwrap();
        }

        services.merge_seed_into_global().unwrap();
        let detail = services
            .config_detail(Some(config_id.clone()))
            .await
            .unwrap();
        assert_eq!(detail["node_count"], 2, "种子节点要进池");
        assert_eq!(detail["current_node_id"], owned_id, "不能改当前节点");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// `node_attach`：空库时懒创建默认配置，把种子节点全部绑进去；第二次幂等。
    #[tokio::test]
    async fn node_attach_lazily_creates_the_global_config() {
        let dir = temp_dir();
        let services = services(&dir);
        {
            let body = r#"{
              "version": 1,
              "updated_at": "2026-11-17T00:00:00Z",
              "nodes": [
                { "name": "免费 A", "server": "203.0.113.10", "port": 8388,
                  "method": "aes-256-gcm", "password": "pw-a" },
                { "name": "免费 B", "server": "203.0.113.11", "port": 8388,
                  "method": "aes-256-gcm", "password": "pw-b" }
              ]
            }"#;
            let hash = crate::seed::content_sha256(body.as_bytes());
            crate::secrets::set_secret(&format!("seed:{hash}"), body).unwrap();
            let conn = services.store.conn();
            crate::store::seed_cache::save(
                &conn,
                &crate::store::seed_cache::SeedCacheRow {
                    content_sha256: hash,
                    etag: None,
                    etag_source: None,
                    source_version: Some("1".into()),
                    source_updated_at: None,
                    node_count: 2,
                    fetched_at: 0,
                    checked_at: 0,
                },
            )
            .unwrap();
        }

        let first = services
            .node_attach(Some("seed".into()), None, None)
            .await
            .unwrap();
        assert_eq!(first["created_config"], true);
        assert_eq!(first["node_count"], 2);
        assert_eq!(first["attached_node_ids"].as_array().unwrap().len(), 2);
        assert!(first["skipped_node_ids"].as_array().unwrap().is_empty());
        assert!(
            first["current_node_id"].is_null(),
            "attach 永远不改当前节点：{first}"
        );
        let config_id = first["config_id"].as_str().unwrap().to_string();

        let list = services.config_list().await.unwrap();
        let configs = list["configs"].as_array().unwrap();
        assert_eq!(configs.len(), 1);
        assert_eq!(configs[0]["name"], configs::DEFAULT_CONFIG_NAME);
        assert_eq!(configs[0]["connect_mode"], configs::CONNECTION_SYSTEM_PROXY);
        assert_eq!(configs[0]["routing_mode"], configs::ROUTING_DIRECT);
        assert_eq!(list["active_config_id"], config_id);

        // 幂等：第二次全部跳过，不新建、不改池子大小。
        let again = services
            .node_attach(Some("seed".into()), None, None)
            .await
            .unwrap();
        assert_eq!(again["created_config"], false);
        assert_eq!(again["attached_node_ids"].as_array().unwrap().len(), 0);
        assert_eq!(again["skipped_node_ids"].as_array().unwrap().len(), 2);
        assert_eq!(again["node_count"], 2);
        assert_eq!(again["config_id"], config_id);

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// `node_attach { nodeIds }`：只绑指定节点，已绑定的跳过，不写当前节点。
    #[tokio::test]
    async fn node_attach_binds_the_given_nodes_without_switching() {
        crate::test_support::install_test_secrets();
        let dir = temp_dir();
        let services = services(&dir);
        let created = services.config_create(create_input("全局")).await.unwrap();
        let config_id = created["config_id"].as_str().unwrap().to_string();
        let mut ids = Vec::new();
        for (name, port) in [("东京", 8388), ("大阪", 8389)] {
            let node = services
                .node_create(NodeCreateInput {
                    config_id: Some(config_id.clone()),
                    name: name.into(),
                    server: "203.0.113.10".into(),
                    port,
                    password: "pw".into(),
                    method: "aes-256-gcm".into(),
                })
                .await
                .unwrap();
            ids.push(node["node_id"].as_str().unwrap().to_string());
        }

        let first = services
            .node_attach(None, Some(vec![ids[0].clone()]), None)
            .await
            .unwrap();
        assert!(
            first["attached_node_ids"].as_array().unwrap().is_empty(),
            "node_create 已经绑过，attach 只补齐缺的：{first}"
        );
        assert_eq!(first["skipped_node_ids"], serde_json::json!([ids[0]]));
        assert_eq!(first["node_count"], 2);
        assert!(first["current_node_id"].is_null());

        let second = services
            .node_attach(None, Some(ids.clone()), Some(config_id.clone()))
            .await
            .unwrap();
        assert_eq!(second["created_config"], false);
        assert!(
            second["attached_node_ids"].as_array().unwrap().is_empty(),
            "都已在池里：{second}"
        );
        assert_eq!(second["skipped_node_ids"].as_array().unwrap().len(), 2);
        assert!(second["current_node_id"].is_null());

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// `node_attach` 的错误码：来源缺省 / 冲突 / 非法 / 节点不存在 / 非全局配置。
    #[tokio::test]
    async fn node_attach_reports_the_documented_errors() {
        crate::test_support::install_test_secrets();
        let dir = temp_dir();
        let services = services(&dir);

        let reason = |error: anyhow::Error| {
            error
                .downcast_ref::<ServiceError>()
                .unwrap()
                .details
                .as_ref()
                .unwrap()["reason"]
                .as_str()
                .unwrap()
                .to_string()
        };

        let error = services.node_attach(None, None, None).await.unwrap_err();
        assert_eq!(reason(error), "source_required");

        let error = services
            .node_attach(Some("seed".into()), Some(vec!["node_x".into()]), None)
            .await
            .unwrap_err();
        assert_eq!(reason(error), "source_and_node_ids_conflict");

        let error = services
            .node_attach(Some("url".into()), None, None)
            .await
            .unwrap_err();
        assert_eq!(reason(error), "invalid_source");

        let error = services
            .node_attach(Some("seed".into()), None, None)
            .await
            .unwrap_err();
        assert_eq!(
            reason(error),
            "seed_unavailable",
            "没有种子缓存时不建空配置"
        );

        // 全局配置还不存在：先建一套，再验证「不存在节点」与「非全局 id」。
        let created = services.config_create(create_input("全局")).await.unwrap();
        let _config_id = created["config_id"].as_str().unwrap().to_string();
        let error = services
            .node_attach(None, Some(vec!["node_missing".into()]), None)
            .await
            .unwrap_err();
        assert_eq!(reason(error), "node_not_found");

        let error = services
            .node_attach(
                None,
                Some(vec!["node_missing".into()]),
                Some("cfg_other".into()),
            )
            .await
            .unwrap_err();
        assert_eq!(reason(error), "not_global_config");

        // 同一套配置正在切接管方式：直接拒绝，不排队。
        let held = services.mode_switches.try_begin(&_config_id).unwrap();
        let error = services
            .node_attach(None, Some(vec!["node_missing".into()]), None)
            .await
            .unwrap_err();
        assert_eq!(reason(error), "switch_in_progress");
        drop(held);

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 运行时正在换连接（TUN 在途）时不允许改池子，与契约的 `switch_in_progress` 一致。
    #[tokio::test]
    async fn node_attach_is_rejected_while_the_connection_is_switching() {
        crate::test_support::install_test_secrets();
        let dir = temp_dir();
        let services = services(&dir);
        let created = services.config_create(create_input("全局")).await.unwrap();
        let config_id = created["config_id"].as_str().unwrap().to_string();

        services.tun.force_launching_for_test(&config_id);
        let error = services
            .node_attach(None, Some(vec!["node_x".into()]), None)
            .await
            .unwrap_err();
        let service = error.downcast_ref::<ServiceError>().unwrap();
        assert_eq!(service.code, "CONFLICT");
        assert!(service.retryable, "并发冲突允许用户稍后重来");
        assert_eq!(
            service.details.as_ref().unwrap()["reason"],
            "switch_in_progress"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 窗口拖入 `.json` 种子文件：节点要进全局配置，否则单配置界面里看不见。
    #[tokio::test]
    async fn a_dropped_seed_file_merges_its_nodes_into_the_global_config() {
        crate::test_support::install_test_secrets();
        let dir = temp_dir();
        let services = services(&dir);
        let path = dir.join("veyl_seed.json");
        std::fs::write(
            &path,
            r#"{
              "version": 1,
              "updated_at": "2026-11-17T00:00:00Z",
              "nodes": [
                { "name": "免费 A", "server": "203.0.113.10", "port": 8388,
                  "method": "aes-256-gcm", "password": "pw-a" },
                { "name": "免费 B", "server": "203.0.113.11", "port": 8388,
                  "method": "aes-256-gcm", "password": "pw-b" }
              ]
            }"#,
        )
        .unwrap();

        let data = services
            .import_seed_file(path.to_str().unwrap())
            .await
            .unwrap();
        assert_eq!(data["imported"], 2);

        let list = services.config_list().await.unwrap();
        let configs = list["configs"].as_array().unwrap();
        assert_eq!(configs.len(), 1, "空库时导入种子会懒创建全局配置");
        assert_eq!(configs[0]["node_count"], 2);
        assert!(configs[0]["current_node_id"].is_null());

        // 重复导入同一文件：节点与绑定都不重复。
        services
            .import_seed_file(path.to_str().unwrap())
            .await
            .unwrap();
        let detail = services
            .config_detail(Some(configs[0]["config_id"].as_str().unwrap().to_string()))
            .await
            .unwrap();
        assert_eq!(detail["node_count"], 2);
        assert!(detail["current_node_id"].is_null());

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 守卫先于懒创建：被拒的 `node_attach` 不能先在空库里留下一套配置。
    #[tokio::test]
    async fn a_rejected_attach_does_not_create_an_empty_config() {
        crate::test_support::install_test_secrets();
        let dir = temp_dir();
        let services = services(&dir);
        services.tun.force_launching_for_test("cfg_in_flight");

        let error = services
            .node_attach(None, Some(vec!["node_x".into()]), None)
            .await
            .unwrap_err();
        assert!(error.to_string().contains("正在切换连接"), "{error}");

        let list = services.config_list().await.unwrap();
        assert!(
            list["configs"].as_array().unwrap().is_empty(),
            "被拒时不能建出空配置：{list}"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 省略 `configId` 的导入绑定全局配置：没有配置时懒创建，且不写当前节点。
    #[tokio::test]
    async fn imports_without_a_config_id_bind_the_global_config() {
        crate::test_support::install_test_secrets();
        let dir = temp_dir();
        let services = services(&dir);

        let data = services
            .node_import_text(None, "ss://aes-256-gcm:pw@203.0.113.10:8388#A")
            .await
            .unwrap();
        assert_eq!(data["imported"], 1);

        let list = services.config_list().await.unwrap();
        let configs = list["configs"].as_array().unwrap();
        assert_eq!(configs.len(), 1, "没有配置时导入会懒创建一套");
        assert_eq!(configs[0]["node_count"], 1);
        assert!(configs[0]["current_node_id"].is_null());

        let config_id = configs[0]["config_id"].as_str().unwrap().to_string();
        let detail = services
            .config_detail(Some(config_id.clone()))
            .await
            .unwrap();
        assert_eq!(detail["nodes"][0]["source"], "manual");

        let _ = std::fs::remove_dir_all(&dir);
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
    use crate::runtime::{RuntimeConfig, RuntimeManager, RuntimeResult, RuntimeState};
    use serde_json::{json, Value};
    use std::path::{Path, PathBuf};
    use std::sync::{Arc, Mutex};

    /// 连接结果里 `system_dns` 的取值：只有真的接管成功才是 `tunnel`。
    #[test]
    fn system_dns_reports_tunnel_only_when_hijack_applied() {
        use crate::tun::backend::DnsHijack;
        assert_eq!(system_dns_label(None), "unchanged");
        assert_eq!(
            system_dns_label(Some(&DnsHijack {
                applied: true,
                reason: None,
            })),
            "tunnel"
        );
        assert_eq!(
            system_dns_label(Some(&DnsHijack {
                applied: false,
                reason: Some("读不到当前网络服务".into()),
            })),
            "unchanged",
            "没接管成功就不能报 tunnel"
        );
    }

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

    /// 会持续跟随新配置文件的端口监听器：停掉再起（重连/回滚）时，新端口也有人应答。
    ///
    /// 返回停止标志；用例结束时置 false。守护线程本身退出即可，已起的监听线程
    /// 随测试进程结束，与上面的单次监听器一致。
    fn spawn_reusable_port_watcher(data_dir: PathBuf) -> Arc<std::sync::atomic::AtomicBool> {
        let stop = Arc::new(std::sync::atomic::AtomicBool::new(true));
        let flag = Arc::clone(&stop);
        std::thread::spawn(move || {
            let config_dir = data_dir.join("config");
            let mut served: std::collections::HashSet<(u16, u16)> = Default::default();
            while flag.load(std::sync::atomic::Ordering::SeqCst) {
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
                        let mixed = mixed as u16;
                        if !served.insert((mixed, clash_port)) {
                            continue;
                        }
                        let Ok(clash_listener) =
                            std::net::TcpListener::bind(("127.0.0.1", clash_port))
                        else {
                            served.remove(&(mixed, clash_port));
                            continue;
                        };
                        if let Ok(mixed_listener) =
                            std::net::TcpListener::bind(("127.0.0.1", mixed))
                        {
                            std::thread::spawn(move || {
                                for socket in mixed_listener.incoming() {
                                    drop(socket);
                                }
                            });
                        }
                        std::thread::spawn(move || serve_clash(clash_listener));
                    }
                }
                std::thread::sleep(std::time::Duration::from_millis(5));
            }
        });
        stop
    }

    /// 只回 `/version` 与 `/proxies/*/delay` 的假 Clash API，让 manager 认为运行时已就绪、
    /// 测速能拿到一个确定延迟。
    fn serve_clash(listener: std::net::TcpListener) {
        use std::io::{Read, Write};
        for socket in listener.incoming() {
            let Ok(mut socket) = socket else { return };
            let mut buf = [0u8; 2048];
            let read = socket.read(&mut buf).unwrap_or(0);
            let request = String::from_utf8_lossy(&buf[..read]);
            let body = if request.contains("/delay") {
                r#"{"delay":42}"#
            } else {
                r#"{"version":"test","meta":false,"premium":false}"#
            };
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
        // 测试不碰真特权助手：真机装了 helper 时，`stop` 会发 IPC 并在高负载下超时。
        inject_silent_tun(&mut services, Arc::new(SilentTun::default()));

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
        // 与端口降级测试并行：用独立设置端口，避免都去抢 7890。
        let configured = crate::config::any_free_port().unwrap();
        {
            let conn = h.services.store.conn();
            crate::store::settings::set_proxy_port(&conn, configured).unwrap();
        }
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

        // 导入 / 新建节点只进池子；用户点选或连接时才写当前节点。
        h.services.node_switch(&config_id, &node_id).await.unwrap();

        let list = h.services.config_list().await.unwrap();
        let configs = list["configs"].as_array().unwrap();
        assert_eq!(configs.len(), 1, "新建后列表里应当只有这一套");
        assert_eq!(configs[0]["config_id"], config_id.as_str());
        assert_eq!(configs[0]["node_count"], 1);
        assert_eq!(
            configs[0]["current_node_id"],
            node_id.as_str(),
            "node_switch 之后唯一节点应当成为当前节点"
        );
        // 第一套配置会**自动激活**（还没有别的配置可比）。这里把这条行为钉住，
        // 后面的 `config_activate` 因此测的是「重新激活并重连」而不是「从无到有」。
        assert_eq!(
            list["active_config_id"],
            config_id.as_str(),
            "第一套配置应当自动成为 active"
        );

        // ---- 2. 激活 ----
        // 从「未连接」切过来不会顺带连接，也不会碰运行时：切换只是导航。
        let activated = h.services.config_activate(&config_id).await.unwrap();
        assert_eq!(activated["active_config_id"], config_id.as_str());
        assert!(
            activated.get("reconnect").is_none(),
            "reconnect 字段已删除：{activated}"
        );
        assert_eq!(activated["runtime"]["state"], "idle");

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

    /// 直接写种子缓存（内容 + 元数据），让 `source = "seed"` 的新建不用联网。
    fn install_seed_cache(services: &WiredServices, body: &str) {
        let hash = crate::seed::content_sha256(body.as_bytes());
        crate::secrets::set_secret(&format!("seed:{hash}"), body).unwrap();
        let conn = services.store.conn();
        crate::store::seed_cache::save(
            &conn,
            &crate::store::seed_cache::SeedCacheRow {
                content_sha256: hash,
                etag: None,
                etag_source: None,
                source_version: Some("1".into()),
                source_updated_at: None,
                node_count: 2,
                fetched_at: 0,
                checked_at: 0,
            },
        )
        .unwrap();
    }

    /// 架构师裁决：`source = "seed"` 的新建不设当前节点；界面在用户点「连接」时
    /// 先 `NodeSwitch` 再 `VpnConnect`。这里把整条链路钉住：空当前节点 → 切换 → 连接。
    #[tokio::test]
    async fn a_seed_config_has_no_current_node_until_the_user_switches() {
        let h = harness();
        install_seed_cache(
            &h.services,
            r#"{
              "version": 1,
              "updated_at": "2026-11-17T00:00:00Z",
              "nodes": [
                { "name": "免费 A", "server": "203.0.113.10", "port": 8388,
                  "method": "aes-256-gcm", "password": "pw-a" },
                { "name": "免费 B", "server": "203.0.113.11", "port": 8388,
                  "method": "aes-256-gcm", "password": "pw-b" }
              ]
            }"#,
        );
        let configured = crate::config::any_free_port().unwrap();
        {
            let conn = h.services.store.conn();
            crate::store::settings::set_proxy_port(&conn, configured).unwrap();
        }
        let watcher = spawn_port_watcher(h.dir.clone());

        let created = h
            .services
            .config_create(ConfigCreateInput {
                name: "免费节点".into(),
                connect_mode: configs::CONNECTION_SYSTEM_PROXY.into(),
                routing_mode: configs::ROUTING_PROXY_ALL.into(),
                source: Some("seed".into()),
                node_ids: None,
                targets: None,
                listen_port: None,
                dns: None,
                tun_excludes: None,
            })
            .await
            .unwrap();
        let config_id = created["config_id"].as_str().unwrap().to_string();
        assert!(
            created["current_node_id"].is_null(),
            "seed 新建不能自动选第一个：{created}"
        );

        // 详情必须能正常返回：空当前节点不是错误，节点集照实给出。
        let detail = h
            .services
            .config_detail(Some(config_id.clone()))
            .await
            .unwrap();
        assert!(detail["current_node_id"].is_null());
        assert_eq!(detail["node_count"], 2);
        let nodes = detail["nodes"].as_array().unwrap();
        assert_eq!(nodes.len(), 2);
        let node_id = nodes[1]["node_id"].as_str().unwrap().to_string();

        // 用户点「连接」前先落库当前节点：previous 为 null 也要成功。
        let switched = h.services.node_switch(&config_id, &node_id).await.unwrap();
        assert!(switched["previous_node_id"].is_null());
        assert_eq!(switched["node_id"], node_id.as_str());

        let connected = h
            .services
            .runtime_start(Some(config_id.clone()))
            .await
            .unwrap();
        assert_eq!(connected["state"], "running", "{connected}");

        let status = serde_json::to_value(h.services.manager.status().await).unwrap();
        assert_eq!(
            status["node_id"],
            node_id.as_str(),
            "连接的必须是切过去的那台"
        );

        h.services.restore_system_proxy().unwrap();
        h.services.manager.set_system_proxy_enabled(false).await;
        let _ = h.services.manager.stop().await;
        drop(watcher);
    }

    async fn create_config_with_node(
        services: &WiredServices,
        name: &str,
        password: &str,
    ) -> String {
        let created = services.config_create(auto_port_input(name)).await.unwrap();
        let config_id = created["config_id"].as_str().unwrap().to_string();
        services
            .node_create(NodeCreateInput {
                config_id: Some(config_id.clone()),
                name: "东京".into(),
                server: "198.51.100.30".into(),
                port: 8388,
                password: password.into(), // secret-scan:allow 测试夹具口令
                method: "aes-256-gcm".into(),
            })
            .await
            .unwrap();
        config_id
    }

    /// 一套配置 + 一个种子来源的节点，用来验证试用起算与到期清理。
    async fn create_config_with_seed_node(
        services: &WiredServices,
        name: &str,
        password: &str,
    ) -> (String, String) {
        let created = services.config_create(auto_port_input(name)).await.unwrap();
        let config_id = created["config_id"].as_str().unwrap().to_string();
        let node_id = format!("node_seed_{:016x}", rand::random::<u64>());
        let password_ref = format!("node:{node_id}");
        crate::secrets::set_secret(&password_ref, password).unwrap();
        {
            let conn = services.store.conn();
            configs::upsert_node(
                &conn,
                &configs::NewNode {
                    id: &node_id,
                    name: "免费节点",
                    server: "198.51.100.60",
                    port: 8388,
                    method: "aes-256-gcm",
                    password_ref: &password_ref, // secret-scan:allow 测试夹具口令
                    source: configs::SOURCE_SEED,
                    source_key: &format!("seed-key-{node_id}"),
                },
            )
            .unwrap();
            configs::attach_node(&conn, &config_id, &node_id).unwrap();
            configs::update(
                &conn,
                &config_id,
                &configs::ConfigPatch {
                    current_node_id: Some(Some(node_id.clone())),
                    ..Default::default()
                },
            )
            .unwrap();
        }
        (config_id, node_id)
    }

    /// 往已有配置挂一个种子来源的节点（不改变当前节点）。
    fn attach_seed_node(services: &WiredServices, config_id: &str, hint: &str) -> String {
        let node_id = format!("node_seed_{:016x}", rand::random::<u64>());
        let password_ref = format!("node:{node_id}");
        crate::secrets::set_secret(&password_ref, "pw-attached-seed").unwrap(); // secret-scan:allow
        let conn = services.store.conn();
        configs::upsert_node(
            &conn,
            &configs::NewNode {
                id: &node_id,
                name: "免费节点",
                server: "198.51.100.61",
                port: 8388,
                method: "aes-256-gcm",
                password_ref: &password_ref,
                source: configs::SOURCE_SEED,
                source_key: &format!("seed-key-{hint}-{node_id}"),
            },
        )
        .unwrap();
        configs::attach_node(&conn, config_id, &node_id).unwrap();
        node_id
    }

    /// 手动停掉运行时，绕开 `runtime_stop` 的 TUN XPC（同主流程测试的降级说明）。
    async fn stop_runtime(h: &Harness) {
        let _ = h.services.restore_system_proxy();
        h.services.manager.set_system_proxy_enabled(false).await;
        let _ = h.services.manager.stop().await;
    }

    #[tokio::test]
    async fn configured_proxy_port_is_used_without_fallback() {
        let h = harness();
        let watcher = spawn_port_watcher(h.dir.clone());
        let configured = crate::config::any_free_port().unwrap();
        {
            let conn = h.services.store.conn();
            crate::store::settings::set_proxy_port(&conn, configured).unwrap();
        }
        let config_id = create_config_with_node(&h.services, "固定端口", "pw-fixed").await;

        let connected = h.services.runtime_start(Some(config_id)).await.unwrap();
        assert_eq!(connected["state"], "running", "{connected}");
        assert_eq!(connected["mixed_port"], json!(configured));
        assert!(
            connected["port_fallback"].is_null(),
            "用了设置值就不该有降级：{connected}"
        );

        stop_runtime(&h).await;
        drop(watcher);
    }

    #[tokio::test]
    async fn occupied_configured_port_falls_back_and_reports_occupied() {
        let h = harness();
        let watcher = spawn_port_watcher(h.dir.clone());
        // 占住 7890；若它已被别的进程占着，也是同一个场景。
        let _held = std::net::TcpListener::bind(("127.0.0.1", 7890)).ok();
        {
            let conn = h.services.store.conn();
            crate::store::settings::set_proxy_port(&conn, 7890).unwrap();
        }
        let config_id = create_config_with_node(&h.services, "占用端口", "pw-busy").await;

        let connected = h.services.runtime_start(Some(config_id)).await.unwrap();
        let actual = connected["mixed_port"].as_u64().unwrap() as u16;
        assert_ne!(actual, 7890, "设置端口被占时必须顺延");
        assert_eq!(connected["port_fallback"]["requested"], json!(7890));
        assert_eq!(connected["port_fallback"]["actual"], json!(actual));
        assert_eq!(connected["port_fallback"]["reason"], "occupied");

        stop_runtime(&h).await;
        drop(watcher);
    }

    // ---------- 静默 TUN 后端：只记录 stop，不碰真实 XPC ----------
    #[derive(Default)]
    struct SilentTun {
        stops: std::sync::atomic::AtomicUsize,
        fail_stop: bool,
    }

    impl SilentTun {
        fn failing() -> Self {
            Self {
                stops: Default::default(),
                fail_stop: true,
            }
        }

        fn stops(&self) -> usize {
            self.stops.load(std::sync::atomic::Ordering::SeqCst)
        }
    }

    impl crate::tun::backend::TunBackend for SilentTun {
        fn availability(
            &self,
        ) -> Result<crate::tun::privilege::HelperStatus, crate::tun::backend::TunError> {
            Ok(crate::tun::privilege::HelperStatus::Enabled)
        }

        fn ensure_available(
            &self,
        ) -> Result<crate::tun::privilege::HelperStatus, crate::tun::backend::TunError> {
            Ok(crate::tun::privilege::HelperStatus::Enabled)
        }

        fn start(
            &self,
            _config: &str,
        ) -> Result<crate::tun::backend::StartReply, crate::tun::backend::TunError> {
            unreachable!("这些用例只验证「连之前先停」")
        }

        fn stop(&self) -> Result<(), crate::tun::backend::TunError> {
            self.stops.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            if self.fail_stop {
                return Err(crate::tun::backend::TunError::new(
                    crate::tun::backend::TunErrorCode::TunStartFailed,
                    "停不掉旧隧道",
                ));
            }
            Ok(())
        }

        fn status(
            &self,
        ) -> Result<crate::tun::backend::TunSnapshot, crate::tun::backend::TunError> {
            Ok(crate::tun::backend::TunSnapshot {
                running: false,
                pid: None,
                clash_api: None,
                since: None,
                last_error: None,
                dns_hijack: Default::default(),
                helper_build: None,
                helper_version: None,
                helper_pid: None,
            })
        }

        fn restart(&self) -> Result<(), crate::tun::backend::TunError> {
            Ok(())
        }
    }

    fn inject_silent_tun(services: &mut WiredServices, backend: Arc<SilentTun>) {
        services.tun = Arc::new(crate::tun::session::TunSession::with_backend(
            backend, "silent",
        ));
    }

    /// 连新配置前先把在跑的 TUN 停掉：不允许两条连接并存。
    #[tokio::test]
    async fn connecting_another_config_stops_the_running_tun_first() {
        let mut h = harness();
        // 全局单配置下不会有第二套；这里用一个不在库里的旧配置 id 模拟升级后接手。
        let old_id = "cfg_old_runtime".to_string();
        // 新配置没有节点：连到「取节点」这一步就会失败，正好证明旧的已经先停了。
        let new = h
            .services
            .config_create(auto_port_input("新代理"))
            .await
            .unwrap();
        let new_id = new["config_id"].as_str().unwrap().to_string();

        let backend = Arc::new(SilentTun::default());
        inject_silent_tun(&mut h.services, Arc::clone(&backend));
        h.services.tun.force_running_for_test(4242, Some(&old_id));

        let error = h
            .services
            .runtime_start(Some(new_id))
            .await
            .expect_err("新配置没有节点，连接应当失败");
        assert_eq!(backend.stops(), 1, "旧 TUN 必须在启动新连接前被停掉");
        assert_eq!(
            h.services.tun.status(),
            crate::tun::session::TunState::Stopped
        );
        let service = error.downcast_ref::<ServiceError>().unwrap();
        assert_eq!(
            service.details.as_ref().unwrap()["reason"],
            "no_nodes",
            "停完旧连接后应当继续走到新连接的准备阶段"
        );
    }

    /// 反向的「代理 → TUN」不再靠第二套配置：现在换模式走 `config_set_mode`
    /// （见下方 `config_set_mode_*` 测试），`runtime_start` 只接管同一套配置。
    ///
    /// 旧连接停不掉：必须报错，且不能继续启动第二条连接。
    #[tokio::test]
    async fn a_failing_stop_blocks_the_new_connection() {
        let mut h = harness();
        // 用一个不在库里的旧配置 id 模拟升级后接手的连接。
        let old_id = "cfg_old_runtime".to_string();
        let new = h
            .services
            .config_create(auto_port_input("新代理"))
            .await
            .unwrap();
        let new_id = new["config_id"].as_str().unwrap().to_string();

        let backend = Arc::new(SilentTun::failing());
        inject_silent_tun(&mut h.services, Arc::clone(&backend));
        h.services.tun.force_running_for_test(4242, Some(&old_id));

        let mut events = h.services.manager.subscribe();
        let error = h.services.runtime_start(Some(new_id)).await.unwrap_err();
        assert_eq!(backend.stops(), 1);
        let message = error.to_string();
        assert!(
            message.contains("特权连接没有停掉"),
            "要如实报停止失败，不能继续启动：{message}"
        );
        // 停止失败要发 stopping → failed，并带上确实是哪套没停掉。
        let seen = drain_state_events(&mut events);
        assert_eq!(seen.len(), 2, "{seen:?}");
        assert_eq!(seen[0].to, RuntimeState::Stopping);
        assert_eq!(seen[1].to, RuntimeState::Failed);
        assert_eq!(seen[1].snapshot.state, RuntimeState::Failed);
        assert_eq!(
            seen[1].snapshot.config_id.as_deref(),
            Some(old_id.as_str()),
            "停止内部会清在途登记，事件必须保留停止前的配置 id"
        );
        assert!(seen[1].snapshot.mode.is_none());
        assert!(seen[1].snapshot.last_error.is_some());
        assert_eq!(
            h.services.manager.status().await.state,
            RuntimeState::Idle,
            "新连接不能起来"
        );
    }

    /// 同一套已连接 / 正在启动：`runtime_start` 幂等，返回 `already_running`。
    #[tokio::test]
    async fn runtime_start_is_idempotent_for_the_same_config() {
        let mut h = harness();
        let created = h
            .services
            .config_create(auto_port_input("幂等连接"))
            .await
            .unwrap();
        let config_id = created["config_id"].as_str().unwrap().to_string();

        inject_silent_tun(&mut h.services, Arc::new(SilentTun::default()));
        h.services
            .tun
            .force_running_for_test(4242, Some(&config_id));
        let running = h
            .services
            .runtime_start(Some(config_id.clone()))
            .await
            .unwrap();
        assert_eq!(running["already_running"], true);
        assert_eq!(running["state"], "running");
        assert_eq!(running["pid"], 4242);

        // 换一个干净的会话摆成「启动中」：不能为了重复请求把在途连接重启一遍。
        inject_silent_tun(&mut h.services, Arc::new(SilentTun::default()));
        h.services.tun.force_launching_for_test(&config_id);
        let starting = h.services.runtime_start(Some(config_id)).await.unwrap();
        assert_eq!(starting["already_running"], true);
        assert_eq!(starting["state"], "starting");
        assert!(h.services.tun.is_launching(), "幂等返回不能取消在途启动");
    }

    /// 启动中停止失败：事件里的 config 必须是停止前记下的那套
    /// （`tun.stop` 内部会先 `cancel_launch` 清掉在途登记）。
    #[tokio::test]
    async fn stopping_a_launch_that_cannot_stop_keeps_its_config() {
        let mut h = harness();
        let created = h
            .services
            .config_create(auto_port_input("启动中停不掉"))
            .await
            .unwrap();
        let config_id = created["config_id"].as_str().unwrap().to_string();
        inject_silent_tun(&mut h.services, Arc::new(SilentTun::failing()));
        h.services.tun.force_launching_for_test(&config_id);

        let mut events = h.services.manager.subscribe();
        h.services
            .runtime_stop(false)
            .await
            .expect_err("停不掉必须报错");
        let seen = drain_state_events(&mut events);

        assert_eq!(seen.len(), 2, "{seen:?}");
        assert_eq!(seen[0].from, RuntimeState::Starting);
        assert_eq!(seen[0].to, RuntimeState::Stopping);
        assert_eq!(
            seen[0].snapshot.config_id.as_deref(),
            Some(config_id.as_str())
        );
        assert_eq!(seen[1].to, RuntimeState::Failed);
        assert_eq!(seen[1].snapshot.state, RuntimeState::Failed);
        assert_eq!(
            seen[1].snapshot.config_id.as_deref(),
            Some(config_id.as_str()),
            "停止前必须先把在途配置 id 取下来"
        );
        assert!(seen[1].snapshot.mode.is_none());
        assert!(seen[1].snapshot.last_error.is_some());
    }

    /// 收集订阅到的状态事件（非阻塞）。TUN 现在与代理共用同一条事件流。
    fn drain_state_events(
        events: &mut tokio::sync::broadcast::Receiver<crate::runtime::RuntimeEvent>,
    ) -> Vec<crate::runtime::RuntimeStateChangedPayload> {
        let mut seen = Vec::new();
        while let Ok(event) = events.try_recv() {
            if let crate::runtime::RuntimeEvent::StateChanged(payload) = event {
                seen.push(payload);
            }
        }
        seen
    }

    /// 启动窗口要有 starting 事件；启动失败要有 failed，且快照与 `to` 一致。
    #[tokio::test]
    async fn tun_start_failure_emits_starting_then_failed() {
        let h = harness();
        let mut events = h.services.manager.subscribe();
        let mut input = auto_port_input("TUN 事件");
        input.connect_mode = configs::CONNECTION_TUN.into();
        let created = h.services.config_create(input).await.unwrap();
        let config_id = created["config_id"].as_str().unwrap().to_string();
        h.services
            .node_create(NodeCreateInput {
                config_id: Some(config_id.clone()),
                name: "东京".into(),
                server: "198.51.100.30".into(),
                port: 8388,
                password: "pw-event".into(), // secret-scan:allow 测试夹具口令
                method: "aes-256-gcm".into(),
            })
            .await
            .unwrap();

        let _ = h
            .services
            .runtime_start(Some(config_id.clone()))
            .await
            .expect_err("测试进程不是打包后的 .app，TUN 必然连不上");
        let seen = drain_state_events(&mut events);

        assert_eq!(seen.len(), 2, "启动窗口只该有 starting → failed：{seen:?}");
        assert_eq!(seen[0].from, RuntimeState::Idle);
        assert_eq!(seen[0].to, RuntimeState::Starting);
        assert_eq!(seen[0].event, "start_req");
        assert_eq!(seen[0].snapshot.state, RuntimeState::Starting);
        assert_eq!(
            seen[0].snapshot.mode,
            Some(crate::runtime::RuntimeMode::Tun)
        );
        assert_eq!(
            seen[0].snapshot.config_id.as_deref(),
            Some(config_id.as_str())
        );
        assert!(
            seen[0].snapshot.upstream_version.is_some(),
            "未运行时 upstream_version 不得为 null（runtime.md §2.5）"
        );

        assert_eq!(seen[1].from, RuntimeState::Starting);
        assert_eq!(seen[1].to, RuntimeState::Failed);
        assert_eq!(seen[1].event, "give_up");
        assert_eq!(seen[1].snapshot.state, RuntimeState::Failed);
        assert!(
            seen[1].snapshot.mode.is_none(),
            "failed 下 mode 必须为 null（runtime.md §2.5）"
        );
        assert!(
            seen[1].snapshot.upstream_version.is_some(),
            "未运行时 upstream_version 不得为 null（runtime.md §2.5）"
        );
        assert!(
            seen[1].snapshot.last_error.is_some(),
            "失败事件要带上原因，界面与托盘显示同一句话"
        );

        // 失败后再连：`from` 应当是 failed，而不是硬编码的 idle。
        let _ = h.services.runtime_start(Some(config_id)).await;
        let retry = drain_state_events(&mut events);
        assert_eq!(retry[0].from, RuntimeState::Failed);
        assert_eq!(retry[0].to, RuntimeState::Starting);
    }

    /// 断开要有 stopping → idle；快照跟着走，不能停在 stopping。
    #[tokio::test]
    async fn tun_stop_emits_stopping_then_idle() {
        let mut h = harness();
        let created = h
            .services
            .config_create(auto_port_input("TUN 断开事件"))
            .await
            .unwrap();
        let config_id = created["config_id"].as_str().unwrap().to_string();
        inject_silent_tun(&mut h.services, Arc::new(SilentTun::default()));
        h.services
            .tun
            .force_running_for_test(4242, Some(&config_id));

        let mut events = h.services.manager.subscribe();
        h.services.runtime_stop(false).await.unwrap();
        let seen = drain_state_events(&mut events);

        assert_eq!(seen.len(), 2, "断开只该有 stopping → idle：{seen:?}");
        assert_eq!(seen[0].from, RuntimeState::Running);
        assert_eq!(seen[0].to, RuntimeState::Stopping);
        assert_eq!(seen[0].event, "stop_req");
        assert_eq!(seen[0].snapshot.state, RuntimeState::Stopping);
        assert_eq!(seen[0].snapshot.pid, Some(4242));

        assert_eq!(seen[1].from, RuntimeState::Stopping);
        assert_eq!(seen[1].to, RuntimeState::Idle);
        assert_eq!(seen[1].event, "stopped");
        assert_eq!(seen[1].snapshot.state, RuntimeState::Idle);
        assert!(
            seen[1].snapshot.mode.is_none(),
            "idle 下 mode 必须为 null（runtime.md §2.5）"
        );
        assert!(
            seen[1].snapshot.upstream_version.is_some(),
            "未运行时 upstream_version 不得为 null（runtime.md §2.5）"
        );
    }

    /// 每次用户断开都记一笔意图（含已 idle 的断开）：重建的「停旧 → 拉起」窗口里
    /// 连接已经不在，只有意图能记录下这次断开，回滚才不会把它接回来。
    #[tokio::test]
    async fn every_user_stop_records_intent_even_when_idle() {
        let mut h = harness();
        async fn epoch(services: &WiredServices) -> u64 {
            let _ops = services.runtime_ops.lock().await;
            services.current_runtime_epoch()
        }

        h.services.runtime_stop(false).await.unwrap();
        h.services.runtime_stop(false).await.unwrap();
        assert_eq!(
            epoch(&h.services).await,
            2,
            "已 idle 的断开也要记意图，否则重建窗口里的断开会被忽略"
        );

        let created = h
            .services
            .config_create(auto_port_input("运行期代数"))
            .await
            .unwrap();
        let config_id = created["config_id"].as_str().unwrap().to_string();
        inject_silent_tun(&mut h.services, Arc::new(SilentTun::default()));
        h.services
            .tun
            .force_running_for_test(4242, Some(&config_id));

        h.services.runtime_stop(false).await.unwrap();
        assert_eq!(epoch(&h.services).await, 3, "停掉在跑的连接再推进一代");
        h.services.runtime_stop(false).await.unwrap();
        assert_eq!(
            epoch(&h.services).await,
            4,
            "停完再停一次：没有东西可停，但意图照样记"
        );
    }

    /// 强制重置的「停 TUN + 停运行时」这一段：只在锁内停，且只推进一代。
    #[tokio::test]
    async fn force_reset_stops_the_runtime_inside_the_lock_and_bumps_the_epoch() {
        let mut h = harness();
        let created = h
            .services
            .config_create(auto_port_input("强制重置"))
            .await
            .unwrap();
        let config_id = created["config_id"].as_str().unwrap().to_string();
        inject_silent_tun(&mut h.services, Arc::new(SilentTun::default()));
        h.services
            .tun
            .force_running_for_test(4242, Some(&config_id));

        let (stop_tun, stop_runtime) = h.services.reset_stop_everything().await;
        assert_eq!(stop_tun["ok"], true, "{stop_tun}");
        assert_eq!(stop_runtime["ok"], true, "{stop_runtime}");

        let epoch = {
            let _ops = h.services.runtime_ops.lock().await;
            h.services.current_runtime_epoch()
        };
        assert_eq!(epoch, 1, "停 TUN + 停运行时只推进一代");
        assert!(
            matches!(
                h.services.tun.status(),
                crate::tun::session::TunState::Stopped
            ),
            "TUN 必须已经停掉"
        );
    }

    /// 连接成功事件的快照必须就是当时的连接状态（TUN 合成的那一份）。
    #[tokio::test]
    async fn a_tun_running_event_carries_the_live_snapshot() {
        let mut h = harness();
        let created = h
            .services
            .config_create(auto_port_input("TUN 成功事件"))
            .await
            .unwrap();
        let config_id = created["config_id"].as_str().unwrap().to_string();
        inject_silent_tun(&mut h.services, Arc::new(SilentTun::default()));
        h.services
            .tun
            .force_running_for_test(4242, Some(&config_id));

        let mut events = h.services.manager.subscribe();
        let snapshot = h.services.connection_status().await;
        h.services.publish_tun_state(
            RuntimeState::Starting,
            RuntimeState::Running,
            crate::runtime::RuntimeEventKind::ProcessReady,
            None,
            snapshot,
        );
        let seen = drain_state_events(&mut events);

        assert_eq!(seen.len(), 1);
        assert_eq!(seen[0].to, RuntimeState::Running);
        assert_eq!(seen[0].event, "process_ready");
        assert_eq!(seen[0].snapshot.state, RuntimeState::Running);
        assert_eq!(seen[0].snapshot.pid, Some(4242));
        assert_eq!(
            seen[0].snapshot.mode,
            Some(crate::runtime::RuntimeMode::Tun)
        );
        assert_eq!(
            seen[0].snapshot.config_id.as_deref(),
            Some(config_id.as_str())
        );
    }

    /// 同值时不停连接、不重启。
    #[tokio::test]
    async fn config_set_mode_is_a_no_op_for_the_running_mode() {
        let h = harness();
        let watcher = spawn_reusable_port_watcher(h.dir.clone());
        let config_id = create_config_with_node(&h.services, "本机代理", "pw-same").await;
        let _ = h
            .services
            .runtime_start(Some(config_id.clone()))
            .await
            .unwrap();
        let before = h
            .services
            .config_detail(Some(config_id.clone()))
            .await
            .unwrap()["updated_at"]
            .clone();

        let data = h
            .services
            .config_set_mode(
                Some(config_id.clone()),
                configs::CONNECTION_SYSTEM_PROXY,
                false,
            )
            .await
            .unwrap();
        assert_eq!(data["changed"], false);
        assert_eq!(data["connected"], true);
        assert_eq!(data["confirmation"], "not_needed");
        assert_eq!(
            h.proxy_calls.lock().unwrap().restored,
            0,
            "同值不能断开连接"
        );
        assert_eq!(
            h.services.manager.status().await.state,
            RuntimeState::Running
        );
        assert_eq!(
            h.services
                .config_detail(Some(config_id.clone()))
                .await
                .unwrap()["updated_at"],
            before
        );
        watcher.store(false, std::sync::atomic::Ordering::SeqCst);
    }

    /// 在线把正在跑的 TUN 切回本机代理：停 → 写 → 起，成功。
    #[tokio::test]
    async fn config_set_mode_switches_a_running_tun_back_to_proxy() {
        let mut h = harness();
        let watcher = spawn_reusable_port_watcher(h.dir.clone());
        let config_id = create_config_with_node(&h.services, "TUN 在线切换", "pw-tun-switch").await;
        h.services
            .config_set_mode(Some(config_id.clone()), configs::CONNECTION_TUN, false)
            .await
            .unwrap();

        let backend = Arc::new(SilentTun::default());
        inject_silent_tun(&mut h.services, Arc::clone(&backend));
        h.services
            .tun
            .force_running_for_test(4242, Some(&config_id));

        let data = h
            .services
            .config_set_mode(
                Some(config_id.clone()),
                configs::CONNECTION_SYSTEM_PROXY,
                true,
            )
            .await
            .unwrap();
        assert_eq!(data["mode"], configs::CONNECTION_SYSTEM_PROXY);
        assert_eq!(data["changed"], true);
        assert_eq!(data["connected"], true);
        assert_eq!(data["restored"], true);
        assert_eq!(data["confirmation"], "accepted");
        assert_eq!(backend.stops(), 1, "旧的 TUN 必须被停掉");
        assert_eq!(
            h.services.tun.status(),
            crate::tun::session::TunState::Stopped
        );
        let status = h.services.manager.status().await;
        assert_eq!(status.state, RuntimeState::Running);
        assert_eq!(status.config_id.as_deref(), Some(config_id.as_str()));
        watcher.store(false, std::sync::atomic::Ordering::SeqCst);
    }

    /// 正在连这套配置时，不带确认的调用只能被挡下：不能写库、不能停连接。
    #[tokio::test]
    async fn config_set_mode_requires_confirmation_for_a_running_connection() {
        let h = harness();
        let watcher = spawn_reusable_port_watcher(h.dir.clone());
        let config_id = create_config_with_node(&h.services, "需要确认", "pw-confirm").await;
        let _ = h
            .services
            .runtime_start(Some(config_id.clone()))
            .await
            .unwrap();

        let error = h
            .services
            .config_set_mode(Some(config_id.clone()), configs::CONNECTION_TUN, false)
            .await
            .unwrap_err();
        let service = error.downcast_ref::<ServiceError>().unwrap();
        assert_eq!(service.code, "PRECONDITION_FAILED");
        let details = service.details.as_ref().unwrap();
        assert_eq!(details["reason"], "confirmation_required");
        assert_eq!(details["will_disconnect"], true);
        assert_eq!(
            h.services.manager.status().await.state,
            RuntimeState::Running,
            "未确认不能停掉连接"
        );
        assert_eq!(
            h.services
                .config_detail(Some(config_id.clone()))
                .await
                .unwrap()["connect_mode"],
            configs::CONNECTION_SYSTEM_PROXY,
            "未确认不能写库"
        );
        watcher.store(false, std::sync::atomic::Ordering::SeqCst);
    }

    /// 停旧连接失败：details 必须带连接是否还在，UI 不能只看到「失败」。
    #[tokio::test]
    async fn config_set_mode_reports_connection_state_when_stopping_fails() {
        let mut h = harness();
        let watcher = spawn_reusable_port_watcher(h.dir.clone());
        let config_id = create_config_with_node(&h.services, "停不掉", "pw-stop-fail").await;
        let _ = h
            .services
            .runtime_start(Some(config_id.clone()))
            .await
            .unwrap();
        inject_silent_tun(&mut h.services, Arc::new(SilentTun::failing()));

        let error = h
            .services
            .config_set_mode(Some(config_id.clone()), configs::CONNECTION_TUN, true)
            .await
            .expect_err("停旧连接失败必须报错");
        let service = error.downcast_ref::<ServiceError>().unwrap();
        let details = service.details.as_ref().unwrap();
        assert_eq!(details["changed"], false, "库没有被改");
        assert!(
            details["connected"].is_boolean(),
            "必须告诉 UI 连接还在不在：{details}"
        );
        assert_eq!(
            h.services
                .config_detail(Some(config_id.clone()))
                .await
                .unwrap()["connect_mode"],
            configs::CONNECTION_SYSTEM_PROXY
        );
        watcher.store(false, std::sync::atomic::Ordering::SeqCst);
    }

    /// 新模式起不来：写回旧模式并用旧模式重启，错误码仍用首次失败那个。
    #[tokio::test]
    async fn config_set_mode_rolls_back_when_the_new_mode_fails() {
        let mut h = harness();
        // 真实 TUN 后端在测试进程里要走 XPC，`runtime_stop` 会先问一次；用假后端隔离。
        inject_silent_tun(&mut h.services, Arc::new(SilentTun::default()));
        let watcher = spawn_reusable_port_watcher(h.dir.clone());
        let config_id = create_config_with_node(&h.services, "回滚成功", "pw-rollback").await;
        let _ = h
            .services
            .runtime_start(Some(config_id.clone()))
            .await
            .unwrap();

        let error = h
            .services
            .config_set_mode(Some(config_id.clone()), configs::CONNECTION_TUN, true)
            .await
            .expect_err("测试进程不是打包后的 .app，TUN 必然连不上");
        let service = error.downcast_ref::<ServiceError>().unwrap();
        assert_eq!(service.code, "PRECONDITION_FAILED", "{}", service.message);
        let details = service.details.as_ref().unwrap();
        assert_eq!(details["reason"], "dev_unbundled", "错误码用首次失败那个");
        assert_eq!(details["restored"], true);
        assert_eq!(details["changed"], false);
        assert_eq!(details["mode"], configs::CONNECTION_TUN, "失败的是新模式");
        assert_eq!(details["previous_mode"], configs::CONNECTION_SYSTEM_PROXY);

        assert_eq!(
            h.services
                .config_detail(Some(config_id.clone()))
                .await
                .unwrap()["connect_mode"],
            configs::CONNECTION_SYSTEM_PROXY,
            "库必须写回旧方式"
        );
        assert_eq!(
            h.services.manager.status().await.state,
            RuntimeState::Running,
            "旧方式必须重新连上"
        );
        watcher.store(false, std::sync::atomic::Ordering::SeqCst);
    }

    /// 写回旧值也失败：库留着新方式、连接停在断开态，`restored:false`。
    #[tokio::test]
    async fn config_set_mode_reports_restored_false_when_the_rollback_write_fails() {
        let mut h = harness();
        inject_silent_tun(&mut h.services, Arc::new(SilentTun::default()));
        let watcher = spawn_reusable_port_watcher(h.dir.clone());
        let config_id = create_config_with_node(&h.services, "回滚失败", "pw-stuck").await;
        let _ = h
            .services
            .runtime_start(Some(config_id.clone()))
            .await
            .unwrap();
        {
            let conn = h.services.store.conn();
            conn.execute_batch(
                "CREATE TRIGGER block_mode_rollback BEFORE UPDATE OF connection_mode ON configs
                 WHEN NEW.connection_mode = 'system_proxy'
                 BEGIN SELECT RAISE(ABORT, 'rollback blocked'); END;",
            )
            .unwrap();
        }

        let error = h
            .services
            .config_set_mode(Some(config_id.clone()), configs::CONNECTION_TUN, true)
            .await
            .expect_err("TUN 起不来，写回旧方式也被挡住");
        let service = error.downcast_ref::<ServiceError>().unwrap();
        assert_eq!(service.code, "PRECONDITION_FAILED", "仍是首次失败的错误码");
        let details = service.details.as_ref().unwrap();
        assert_eq!(details["reason"], "dev_unbundled");
        assert_eq!(details["restored"], false);
        assert_eq!(details["changed"], true);
        assert_eq!(details["mode"], configs::CONNECTION_TUN, "库里是新方式");
        assert_eq!(details["previous_mode"], configs::CONNECTION_SYSTEM_PROXY);

        assert_eq!(
            h.services
                .config_detail(Some(config_id.clone()))
                .await
                .unwrap()["connect_mode"],
            configs::CONNECTION_TUN
        );
        assert_eq!(
            h.services.manager.status().await.state,
            RuntimeState::Idle,
            "连接停在断开态"
        );
        {
            let conn = h.services.store.conn();
            conn.execute_batch("DROP TRIGGER block_mode_rollback")
                .unwrap();
        }
        watcher.store(false, std::sync::atomic::Ordering::SeqCst);
    }

    /// 首连种子节点起算试用；幂等重连不重复写。
    #[tokio::test]
    async fn a_seed_connection_starts_the_trial_only_once() {
        let h = harness();
        let watcher = spawn_reusable_port_watcher(h.dir.clone());
        let (config_id, _) =
            create_config_with_seed_node(&h.services, "试用起算", "pw-trial").await;

        let connected = h
            .services
            .runtime_start(Some(config_id.clone()))
            .await
            .unwrap();
        assert_eq!(connected["state"], "running", "{connected}");
        let first = {
            let conn = h.services.store.conn();
            crate::trial::status(&conn).unwrap()
        };
        assert_eq!(first.phase, crate::trial::Phase::Active);
        let started_at = first.started_at_ms.expect("首次连上种子节点必须起算");

        let again = h.services.runtime_start(Some(config_id)).await.unwrap();
        assert_eq!(again["already_running"], true);
        let after = {
            let conn = h.services.store.conn();
            crate::trial::status(&conn).unwrap()
        };
        assert_eq!(after.started_at_ms, Some(started_at), "只写一次");

        stop_runtime(&h).await;
        watcher.store(false, std::sync::atomic::Ordering::SeqCst);
    }

    /// 契约 §7.1「被取代的启动」：拉起阶段在锁外，排队中的断开 / 重建不会被
    /// 一次最长 90 秒的冷启动堵住。
    #[tokio::test]
    async fn a_user_start_does_not_hold_the_runtime_lock_while_launching() {
        let h = harness();
        let watcher = spawn_reusable_port_watcher(h.dir.clone());
        let (config_id, _) = create_config_with_seed_node(&h.services, "锁边界", "pw-lock").await;

        let connected = h.services.runtime_start(Some(config_id)).await.unwrap();
        assert_eq!(connected["state"], "running", "{connected}");
        assert!(
            h.services
                .start_body_without_lock
                .load(std::sync::atomic::Ordering::SeqCst),
            "拉起阶段必须没有占着运行期操作锁"
        );

        stop_runtime(&h).await;
        watcher.store(false, std::sync::atomic::Ordering::SeqCst);
    }

    /// 连自建节点不起算试用。
    #[tokio::test]
    async fn a_manual_node_connection_does_not_start_the_trial() {
        let h = harness();
        let watcher = spawn_reusable_port_watcher(h.dir.clone());
        let config_id = create_config_with_node(&h.services, "自建节点", "pw-manual").await;

        let connected = h.services.runtime_start(Some(config_id)).await.unwrap();
        assert_eq!(connected["state"], "running", "{connected}");
        let status = {
            let conn = h.services.store.conn();
            crate::trial::status(&conn).unwrap()
        };
        assert_eq!(status.phase, crate::trial::Phase::Available);
        assert_eq!(status.started_at_ms, None);

        stop_runtime(&h).await;
        watcher.store(false, std::sync::atomic::Ordering::SeqCst);
    }

    /// 到期清理先提交；断连失败不回滚数据库，也不会再次发清理结果。
    #[tokio::test]
    async fn trial_expiry_commits_even_when_disconnect_fails() {
        let mut h = harness();
        let (config_id, node_id) =
            create_config_with_seed_node(&h.services, "到期清理", "pw-expire").await;
        inject_silent_tun(&mut h.services, Arc::new(SilentTun::failing()));
        h.services
            .tun
            .force_running_for_test(4242, Some(&config_id));
        h.services.tun.set_current_node(&node_id, "免费节点");
        {
            let conn = h.services.store.conn();
            let at = crate::store::now_ms() - crate::trial::TRIAL_DURATION_MS - 1;
            assert!(crate::trial::mark_started(&conn, at).unwrap());
        }

        h.services
            .check_trial_expiry()
            .await
            .expect("断连失败不能让清理报错");

        {
            let conn = h.services.store.conn();
            let status = crate::trial::status(&conn).unwrap();
            assert_eq!(status.phase, crate::trial::Phase::Expired);
            assert_eq!(status.remaining_ms, Some(0));
            let seed_links: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM config_nodes cn
                       JOIN nodes n ON n.id = cn.node_id
                      WHERE n.source = ?1",
                    rusqlite::params![configs::SOURCE_SEED],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(seed_links, 0, "数据库必须已经清理，不能因断连失败回滚");
            // 第二次检查不再返回清理结果：事件只发一次。
            assert!(
                crate::trial::expire_if_needed(&conn, crate::store::now_ms())
                    .unwrap()
                    .is_none()
            );
        }
        assert!(
            matches!(
                h.services.tun.status(),
                crate::tun::session::TunState::Running { .. }
            ),
            "停止失败时连接应保持原状"
        );
    }

    /// 到期时连的是自建节点：只能清种子关联，不能断开当前连接。
    #[tokio::test]
    async fn trial_expiry_keeps_a_manual_connection_alive() {
        let mut h = harness();
        let config_id = create_config_with_node(&h.services, "自建在线", "pw-manual-expire").await;
        let manual_node_id = {
            let conn = h.services.store.conn();
            configs::list_nodes(&conn, &config_id).unwrap()[0]
                .id
                .clone()
        };
        h.services
            .node_switch(&config_id, &manual_node_id)
            .await
            .unwrap();
        attach_seed_node(&h.services, &config_id, "manual-case");

        let backend = Arc::new(SilentTun::default());
        inject_silent_tun(&mut h.services, Arc::clone(&backend));
        h.services
            .tun
            .force_running_for_test(4242, Some(&config_id));
        h.services.tun.set_current_node(&manual_node_id, "自建");
        {
            let conn = h.services.store.conn();
            let at = crate::store::now_ms() - crate::trial::TRIAL_DURATION_MS - 1;
            assert!(crate::trial::mark_started(&conn, at).unwrap());
        }

        h.services.check_trial_expiry().await.unwrap();

        assert_eq!(backend.stops(), 0, "自建节点不能因为试用到期被断开");
        assert!(matches!(
            h.services.tun.status(),
            crate::tun::session::TunState::Running { .. }
        ));
        let conn = h.services.store.conn();
        let seed_links: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM config_nodes cn
                   JOIN nodes n ON n.id = cn.node_id
                  WHERE n.source = ?1",
                rusqlite::params![configs::SOURCE_SEED],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(seed_links, 0, "种子关联仍要清掉");
    }

    fn insert_server_row(store: &crate::store::Store, id: &str, state: &str) {
        let conn = store.conn();
        let now = crate::store::now_ms();
        crate::store::servers::upsert(
            &conn,
            &crate::store::NewMyServer {
                id,
                provider: "digitalocean",
                name: "东京",
                region: "ap-northeast-1",
                plan: "starter",
                state,
                node_id: None,
                hourly_usd: 0.01,
                monthly_usd: 7.0,
                daily_price_cents: 20,
                transfer_gib: 500,
                paid_until: now + 86_400_000,
                billing_state: "active",
                created_at: now,
            },
        )
        .unwrap();
    }

    /// 失败详情只读本地镜像与内存订单事件，且 `log_available` 恒为 false。
    #[tokio::test]
    async fn my_server_failure_reads_mirror_and_order_events() {
        let h = harness();
        let server_id = format!("srv_fail_{:016x}", rand::random::<u64>());
        let order_id = format!("ord_fail_{:016x}", rand::random::<u64>());
        insert_server_row(&h.services.store, &server_id, "error");
        crate::control_plane::servers::remember_failure_for_test(
            &server_id,
            crate::control_plane::servers::MyServerFailure {
                stage: "installing".into(),
                code: "install_failed".into(),
                message: "装环境失败".into(),
                retryable: true,
            },
        );

        let base = crate::control_plane::servers::MyServerOrder {
            order_id: order_id.clone(),
            state: "provisioning".into(),
            region: "ap-northeast-1".into(),
            plan: "starter".into(),
            amount_usd: 7.0,
            created_at: "2026-11-16T00:00:00Z".into(),
            expires_at: None,
            server_id: Some(server_id.clone()),
            failure: None,
            charge_mode: "upfront".into(),
        };
        crate::control_plane::servers::remember_order_for_test(base.clone());
        crate::control_plane::servers::remember_order_for_test(
            crate::control_plane::servers::MyServerOrder {
                state: "failed".into(),
                failure: Some(crate::control_plane::servers::MyServerOrderFailure {
                    code: "install_failed".into(),
                    message: "装环境失败".into(),
                    retryable: true,
                }),
                ..base
            },
        );

        let data = h.services.my_server_failure(&server_id).await.unwrap();
        assert_eq!(data["server_id"], server_id);
        assert_eq!(data["state"], "error");
        assert_eq!(data["failure"]["stage"], "installing");
        assert_eq!(data["failure"]["code"], "install_failed");
        assert_eq!(data["failure"]["retryable"], true);
        assert_eq!(data["order"]["order_id"], order_id);
        assert_eq!(data["order"]["state"], "failed");
        assert_eq!(data["order"]["failure"]["code"], "install_failed");
        assert_eq!(data["log_available"], false);
        let events = data["recent_events"].as_array().unwrap();
        assert_eq!(events.len(), 2);
        assert_eq!(events[0]["state"], "failed", "新的在前");
        assert_eq!(events[1]["state"], "provisioning");
    }

    /// 健康服务器没有失败记录：failure/order 为 null、事件为空也是合法结果。
    #[tokio::test]
    async fn my_server_failure_returns_null_for_a_healthy_server() {
        let h = harness();
        let server_id = format!("srv_ok_{:016x}", rand::random::<u64>());
        insert_server_row(&h.services.store, &server_id, "healthy");

        let data = h.services.my_server_failure(&server_id).await.unwrap();
        assert!(data["failure"].is_null());
        assert!(data["order"].is_null());
        assert!(data["recent_events"].as_array().unwrap().is_empty());
        assert_eq!(data["log_available"], false);
    }

    /// 本地镜像里没有这台服务器：NOT_FOUND / server_not_found。
    #[tokio::test]
    async fn my_server_failure_reports_not_found_for_unknown_servers() {
        let h = harness();
        let error = h
            .services
            .my_server_failure("srv_missing")
            .await
            .expect_err("不存在的服务器必须报错");
        let service = error.downcast_ref::<ServiceError>().unwrap();
        assert_eq!(service.code, "NOT_FOUND");
        assert_eq!(
            service.details.as_ref().unwrap()["reason"],
            "server_not_found"
        );
    }
    /// 两条重建用例都要起假运行时抢端口：互相串行，避免并行时端口/进程互相踩。
    static REBUILD_TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    /// 造一个「只在池子里、还没绑进配置」的节点（模拟 my-server 凭据落库）。
    fn write_unattached_node(services: &WiredServices, name: &str, server: &str) -> String {
        let id = format!("nod_{:016x}", rand::random::<u64>());
        let password_ref = format!("node:{id}");
        crate::secrets::set_secret(&password_ref, "pw-owned").unwrap(); // secret-scan:allow
        {
            let conn = services.store.conn();
            configs::upsert_node(
                &conn,
                &configs::NewNode {
                    id: &id,
                    name,
                    server,
                    port: 8388,
                    method: "aes-256-gcm",
                    password_ref: &password_ref,
                    source: configs::SOURCE_OWNED,
                    source_key: &id,
                },
            )
            .unwrap();
        }
        id
    }

    /// 把目录里所有渲染出来的 profile 拼起来：重建后只应剩当前那一份。
    fn rendered_profiles(dir: &std::path::Path) -> String {
        let mut text = String::new();
        if let Ok(entries) = std::fs::read_dir(dir.join("config")) {
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().to_string();
                if name.starts_with("profile-") && name.ends_with(".json") {
                    if let Ok(content) = std::fs::read_to_string(entry.path()) {
                        text.push_str(&content);
                    }
                }
            }
        }
        text
    }

    /// 连接中把新节点绑进池：自动重建运行配置，当前节点不变，新节点进 selector。
    #[tokio::test]
    async fn attaching_a_node_while_connected_rebuilds_the_running_config() {
        let _serial = REBUILD_TEST_LOCK
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let h = harness();
        let configured = crate::config::any_free_port().unwrap();
        {
            let conn = h.services.store.conn();
            crate::store::settings::set_proxy_port(&conn, configured).unwrap();
        }
        let watcher = spawn_reusable_port_watcher(h.dir.clone());

        let created = h
            .services
            .config_create(auto_port_input("自动重建"))
            .await
            .unwrap();
        let config_id = created["config_id"].as_str().unwrap().to_string();
        let node_a = h
            .services
            .node_create(NodeCreateInput {
                config_id: Some(config_id.clone()),
                name: "甲".into(),
                server: "198.51.100.41".into(),
                port: 8388,
                password: "pw-a".into(), // secret-scan:allow
                method: "aes-256-gcm".into(),
            })
            .await
            .unwrap();
        let a_id = node_a["node_id"].as_str().unwrap().to_string();
        h.services.node_switch(&config_id, &a_id).await.unwrap();
        h.services
            .runtime_start(Some(config_id.clone()))
            .await
            .unwrap();

        // 连接建立之后才进池的节点。
        let b_id = write_unattached_node(&h.services, "乙", "198.51.100.42");
        let attached = h
            .services
            .node_attach(None, Some(vec![b_id.clone()]), Some(config_id.clone()))
            .await
            .unwrap();

        assert_eq!(
            attached["runtime_rebuild"]["status"], "applied",
            "重建结果：{}",
            attached["runtime_rebuild"]
        );
        assert_eq!(attached["runtime_rebuild"]["new_nodes"][0], b_id.as_str());
        assert_eq!(attached["node_count"], 2);
        let detail = h
            .services
            .config_detail(Some(config_id.clone()))
            .await
            .unwrap();
        assert_eq!(detail["current_node_id"], a_id, "重建不能改当前节点");

        let profile = rendered_profiles(&h.dir);
        assert!(
            profile.contains(&format!("node-{b_id}")),
            "新节点必须进运行配置：{profile}"
        );
        assert!(profile.contains(&format!("node-{a_id}")));
        let status = h.services.runtime_status().await.unwrap();
        assert_eq!(status["state"], "running");
        watcher.store(false, std::sync::atomic::Ordering::SeqCst);
    }

    /// 重建失败：回到原节点集合的连接，新节点留着「下次连接可用」并给一句提示。
    #[tokio::test]
    async fn a_failed_rebuild_restores_the_previous_connection() {
        let _serial = REBUILD_TEST_LOCK
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let h = harness();
        let configured = crate::config::any_free_port().unwrap();
        {
            let conn = h.services.store.conn();
            crate::store::settings::set_proxy_port(&conn, configured).unwrap();
        }
        let watcher = spawn_reusable_port_watcher(h.dir.clone());

        let created = h
            .services
            .config_create(auto_port_input("重建失败"))
            .await
            .unwrap();
        let config_id = created["config_id"].as_str().unwrap().to_string();
        let node_a = h
            .services
            .node_create(NodeCreateInput {
                config_id: Some(config_id.clone()),
                name: "甲".into(),
                server: "198.51.100.51".into(),
                port: 8388,
                password: "pw-a".into(), // secret-scan:allow
                method: "aes-256-gcm".into(),
            })
            .await
            .unwrap();
        let a_id = node_a["node_id"].as_str().unwrap().to_string();
        h.services.node_switch(&config_id, &a_id).await.unwrap();
        h.services
            .runtime_start(Some(config_id.clone()))
            .await
            .unwrap();

        let b_id = write_unattached_node(&h.services, "乙", "198.51.100.52");
        h.services.fail_next_rebuild_for_test(1);
        let attached = h
            .services
            .node_attach(None, Some(vec![b_id.clone()]), Some(config_id.clone()))
            .await
            .unwrap();

        let rebuild = &attached["runtime_rebuild"];
        assert_eq!(rebuild["status"], "failed");
        assert_eq!(rebuild["restored"], true);
        assert!(
            rebuild["message"].as_str().unwrap().contains("重新连接"),
            "失败要给一句可行动的提示：{rebuild}"
        );
        // 节点本身已经进池，只是这次没被用上。
        assert_eq!(attached["node_count"], 2);
        // 原连接回来了：跑着，配置里没有新节点。
        let status = h.services.runtime_status().await.unwrap();
        assert_eq!(status["state"], "running");
        let profile = rendered_profiles(&h.dir);
        assert!(profile.contains(&format!("node-{a_id}")));
        assert!(
            !profile.contains(&format!("node-{b_id}")),
            "回滚后的运行配置不该含新节点：{profile}"
        );
        watcher.store(false, std::sync::atomic::Ordering::SeqCst);
    }

    /// 起一套「已连接 + 一个池外节点」的环境，给下面几条中断/并发用例复用。
    async fn connected_with_spare_node(
        tag: &str,
        spare_server: &str,
    ) -> (
        Harness,
        String,
        String,
        String,
        Arc<std::sync::atomic::AtomicBool>,
    ) {
        let h = harness();
        let configured = crate::config::any_free_port().unwrap();
        {
            let conn = h.services.store.conn();
            crate::store::settings::set_proxy_port(&conn, configured).unwrap();
        }
        let watcher = spawn_reusable_port_watcher(h.dir.clone());
        let created = h
            .services
            .config_create(auto_port_input(tag))
            .await
            .unwrap();
        let config_id = created["config_id"].as_str().unwrap().to_string();
        let node = h
            .services
            .node_create(NodeCreateInput {
                config_id: Some(config_id.clone()),
                name: "甲".into(),
                server: "198.51.100.70".into(),
                port: 8388,
                password: "pw-a".into(), // secret-scan:allow
                method: "aes-256-gcm".into(),
            })
            .await
            .unwrap();
        let a_id = node["node_id"].as_str().unwrap().to_string();
        h.services.node_switch(&config_id, &a_id).await.unwrap();
        h.services
            .runtime_start(Some(config_id.clone()))
            .await
            .unwrap();
        let spare = write_unattached_node(&h.services, "乙", spare_server);
        (h, config_id, a_id, spare, watcher)
    }

    /// 等到重建进入「首轮失败」的注入窗口，再让并发动作落地。
    async fn wait_for_rebuild_window(services: &WiredServices) {
        for _ in 0..500 {
            if services
                .rebuild_test_waiting
                .load(std::sync::atomic::Ordering::SeqCst)
                > 0
            {
                return;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        panic!("重建没有进入注入窗口");
    }

    /// 等到重建进入「回滚拉起前」的暂停窗口。
    async fn wait_for_rebuild_rollback_pause(services: &WiredServices) {
        for _ in 0..1000 {
            if services
                .rebuild_rollback_paused
                .load(std::sync::atomic::Ordering::SeqCst)
            {
                return;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        panic!("重建没有进入回滚前暂停窗口");
    }

    /// 重建期间用户断开：决策段之后重建已在锁外拉起，断开不再排队，
    /// 而是直接记一笔意图把它取代——不回滚、也不把连接接回来。
    #[tokio::test]
    async fn a_disconnect_during_a_rebuild_wins_in_the_end() {
        let _serial = REBUILD_TEST_LOCK
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let (h, config_id, _a_id, spare, watcher) =
            connected_with_spare_node("断开打断重建", "198.51.100.71").await;

        h.services.fail_next_rebuild_for_test(1);
        let (attached, (stopped, stop_waited)) = tokio::join!(
            h.services
                .node_attach(None, Some(vec![spare.clone()]), Some(config_id.clone())),
            async {
                wait_for_rebuild_window(&h.services).await;
                let started = std::time::Instant::now();
                let result = h.services.runtime_stop(false).await;
                (result, started.elapsed())
            }
        );
        stopped.unwrap();
        let attached = attached.unwrap();
        // 断开不该等重建的拉起段（那是 P1 的原始症状）：它只取决策段那把锁。
        assert!(
            stop_waited < std::time::Duration::from_secs(5),
            "断开被重建的锁外拉起挡住了：等了 {stop_waited:?}"
        );
        // 首轮启动被注入失败，回滚前代数已变（用户断开）→ 不回滚，按断开收场。
        let rebuild = &attached["runtime_rebuild"];
        assert_eq!(rebuild["status"], "failed", "{rebuild}");
        assert_eq!(rebuild["reason"], "user_disconnected", "{rebuild}");
        assert_eq!(rebuild["restored"], false, "{rebuild}");
        assert_eq!(
            rebuild["message"], "已按你的操作断开；新增节点会在下次连接时生效。",
            "{rebuild}"
        );

        let status = h.services.runtime_status().await.unwrap();
        assert_eq!(status["state"], "idle", "用户断开后不应再被接回来");
        assert_eq!(status["system_proxy_enabled"], false);
        watcher.store(false, std::sync::atomic::Ordering::SeqCst);
    }

    /// 首轮启动期间被断开：首轮其实连上了，但复查时已经不在了——
    /// 结果必须是 `failed / user_disconnected`，且**不进回滚**。
    #[tokio::test]
    async fn a_disconnect_during_the_first_rebuild_start_is_user_disconnected() {
        let _serial = REBUILD_TEST_LOCK
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let (h, config_id, _a_id, spare, watcher) =
            connected_with_spare_node("首轮被断开", "198.51.100.73").await;

        h.services.pause_after_first_rebuild_start_for_test();
        let (attached, stopped) = tokio::join!(
            h.services
                .node_attach(None, Some(vec![spare.clone()]), Some(config_id.clone())),
            async {
                wait_for_rebuild_window(&h.services).await;
                h.services.runtime_stop(false).await
            }
        );
        stopped.unwrap();
        let attached = attached.unwrap();
        let rebuild = &attached["runtime_rebuild"];
        assert_eq!(rebuild["status"], "failed", "{rebuild}");
        assert_eq!(rebuild["reason"], "user_disconnected", "{rebuild}");
        assert_eq!(rebuild["restored"], false, "{rebuild}");

        let status = h.services.runtime_status().await.unwrap();
        assert_eq!(status["state"], "idle", "断开后不能被重建接回来");
        watcher.store(false, std::sync::atomic::Ordering::SeqCst);
    }

    /// 回滚拉起被**重启/另一次启动**打断：不是用户断开，不能报「已按你的操作断开」。
    #[tokio::test]
    async fn a_rollback_interrupted_by_a_new_start_is_not_a_user_disconnect() {
        let _serial = REBUILD_TEST_LOCK
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let (h, config_id, _a_id, spare, watcher) =
            connected_with_spare_node("回滚被打断", "198.51.100.74").await;

        h.services.fail_next_rebuild_for_test(1);
        h.services.pause_before_rebuild_rollback_for_test();
        let (attached, restarted) = tokio::join!(
            h.services
                .node_attach(None, Some(vec![spare.clone()]), Some(config_id.clone())),
            async {
                // 第一段窗口是首轮失败注入，这次要等的是「回滚拉起前」那一段。
                wait_for_rebuild_rollback_pause(&h.services).await;
                let started = h.services.runtime_start(Some(config_id.clone())).await;
                h.services.release_rebuild_rollback_for_test();
                started
            }
        );
        restarted.expect("重启应当成功");
        let attached = attached.unwrap();
        let rebuild = &attached["runtime_rebuild"];
        assert!(
            rebuild.get("reason").is_none(),
            "回滚被新启动打断不是用户断开：{rebuild}"
        );
        assert_eq!(
            rebuild["message"],
            "新节点这次没能应用；当前连接已由新的操作接管，重新连接后就能用它。",
            "必须是「被接管」那条文案，不能是「无法确认」：{rebuild}"
        );
        assert_eq!(rebuild["status"], "failed", "{rebuild}");
        let status = h.services.runtime_status().await.unwrap();
        assert_eq!(status["state"], "running", "新的连接应当还在跑：{status}");
        watcher.store(false, std::sync::atomic::Ordering::SeqCst);
    }

    /// `Replaced` 的两个来源各一条：有启动在途、别的配置在跑。
    #[tokio::test]
    async fn a_launch_in_flight_counts_as_replaced_not_disconnected() {
        let h = harness();
        let slot = h.services.tun.begin_launch("cfg_target");
        assert_eq!(
            h.services.after_start_state("cfg_target").await,
            AfterStart::Replaced,
            "有启动在途时不能说「断开」"
        );
        drop(slot);
    }

    #[tokio::test]
    async fn another_config_running_counts_as_replaced_not_disconnected() {
        let mut h = harness();
        inject_silent_tun(&mut h.services, Arc::new(SilentTun::default()));
        h.services
            .tun
            .force_running_for_test(4242, Some("cfg_other"));
        assert_eq!(
            h.services.after_start_state("cfg_target").await,
            AfterStart::Replaced,
            "别的配置在跑不算这套配置断开"
        );
    }

    /// 集成用例：TUN 连接时覆盖项必须是「全接管」。
    /// 锁的是**状态来源**——用 `manager.status()` 判会把 TUN 说成「未连接」，
    /// 纯函数级用例发现不了这种接错源的问题。
    #[tokio::test]
    async fn a_tun_connection_counts_as_full_coverage() {
        let mut h = harness();
        inject_silent_tun(&mut h.services, Arc::new(SilentTun::default()));
        h.services.tun.force_running_for_test(4242, Some("cfg_tun"));
        let check = h.services.network_coverage_for().await;
        assert_eq!(check["ok"], true, "{check}");
        let detail = check["detail"].as_str().unwrap();
        assert!(detail.contains("全部流量"), "TUN 连接必须是全接管：{check}");
        assert!(
            detail.contains("TCP") && detail.contains("UDP") && detail.contains("QUIC"),
            "全接管要说清覆盖哪些流量：{check}"
        );
        assert!(check["action"].is_null(), "{check}");
        // 与主状态不矛盾：同一份夹具下 connection_state 也必须是「连着且 TUN」。
        let connection = h.services.connection_state().await;
        assert!(
            connection.connected && connection.tun,
            "夹具本身要是 TUN 连接"
        );
    }

    /// 诊断的取源必须是统一快照：TUN 连接时不能再按「未连接」报。
    /// 锁的是 `diag_connection_snapshot`——`diag_run` 就是用它拿 status 的；
    /// 谁改回 `manager.status()`，四项在 TUN 下会全部掉回 skipped。
    #[tokio::test]
    async fn diag_reads_the_tun_connection_not_the_manager() {
        let mut h = harness();
        inject_silent_tun(&mut h.services, Arc::new(SilentTun::default()));
        h.services.tun.force_running_for_test(4242, Some("cfg_tun"));
        let (status, connection) = h.services.diag_connection_snapshot().await;
        assert_eq!(connection, DiagConnection::Tun, "{status:?}");
        assert_eq!(status.mode, Some(crate::runtime::RuntimeMode::Tun));
        // TUN 快照里的 process 来自 `TunSession::status()`（会问 helper），不是猜的。
        assert_eq!(
            process_alive_check(connection, status.health.process)["status"],
            "ok",
            "TUN 已连接时不能说进程没在跑"
        );
        assert_eq!(
            clash_api_check(connection, status.health.clash_api)["status"],
            "skipped",
            "TUN 没有控制面探测通道"
        );
        assert_eq!(
            exit_ip_check(connection, status.health.exit_ip.as_deref())["status"],
            "skipped",
            "TUN 不采集出口 IP"
        );
    }

    #[tokio::test]
    async fn diag_says_disconnected_when_nothing_is_running() {
        let h = harness();
        let (status, connection) = h.services.diag_connection_snapshot().await;
        assert_eq!(connection, DiagConnection::Idle, "{status:?}");
    }

    /// 重建期间切节点：被闸门拒绝，最终仍是原节点。
    #[tokio::test]
    async fn a_node_switch_during_a_rebuild_is_rejected() {
        let _serial = REBUILD_TEST_LOCK
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let (h, config_id, a_id, spare, watcher) =
            connected_with_spare_node("重建中切节点", "198.51.100.72").await;

        h.services.fail_next_rebuild_for_test(1);
        let (attached, switched) = tokio::join!(
            h.services
                .node_attach(None, Some(vec![spare.clone()]), Some(config_id.clone())),
            async {
                wait_for_rebuild_window(&h.services).await;
                h.services.node_switch(&config_id, &spare).await
            }
        );
        let error = switched.unwrap_err();
        let service = error.downcast_ref::<ServiceError>().unwrap();
        assert_eq!(service.code, "CONFLICT");
        assert_eq!(
            service.details.as_ref().unwrap()["reason"],
            "switch_in_progress"
        );

        let attached = attached.unwrap();
        let rebuild = &attached["runtime_rebuild"];
        assert_eq!(rebuild["status"], "failed", "{rebuild}");
        assert_eq!(rebuild["restored"], true);
        let detail = h
            .services
            .config_detail(Some(config_id.clone()))
            .await
            .unwrap();
        assert_eq!(detail["current_node_id"], a_id, "库里和实际都还是原节点");
        let profile = rendered_profiles(&h.dir);
        assert!(!profile.contains(&format!("node-{spare}")));
        watcher.store(false, std::sync::atomic::Ordering::SeqCst);
    }

    /// 重建进行中点「当前节点」：不改任何东西，必须成功，不能被闸拦成 switch_in_progress。
    #[tokio::test]
    async fn switching_to_the_current_node_during_a_rebuild_succeeds() {
        let _serial = REBUILD_TEST_LOCK
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let (h, config_id, a_id, spare, watcher) =
            connected_with_spare_node("重建中点当前节点", "198.51.100.94").await;

        h.services.fail_next_rebuild_for_test(1);
        let (attached, switched) = tokio::join!(
            h.services
                .node_attach(None, Some(vec![spare.clone()]), Some(config_id.clone())),
            async {
                wait_for_rebuild_window(&h.services).await;
                h.services.node_switch(&config_id, &a_id).await
            }
        );

        // 幂等：点的是当前节点，重建中也要直接成功返回。
        let switched = switched.unwrap();
        assert_eq!(switched["config_id"], config_id);
        assert_eq!(switched["node_id"], a_id);
        assert_eq!(switched["previous_node_id"], a_id);

        let attached = attached.unwrap();
        assert_eq!(attached["runtime_rebuild"]["status"], "failed");
        assert_eq!(attached["runtime_rebuild"]["restored"], true);
        let detail = h
            .services
            .config_detail(Some(config_id.clone()))
            .await
            .unwrap();
        assert_eq!(detail["current_node_id"], a_id, "选择没被改");
        let profile = rendered_profiles(&h.dir);
        assert!(!profile.contains(&format!("node-{spare}")));
        watcher.store(false, std::sync::atomic::Ordering::SeqCst);
    }

    /// 首轮与回滚都起不来：如实报失败，别假装还连着。
    #[tokio::test]
    async fn a_rebuild_that_fails_twice_reports_no_connection() {
        let _serial = REBUILD_TEST_LOCK
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let (h, config_id, _a_id, spare, watcher) =
            connected_with_spare_node("两次都失败", "198.51.100.73").await;

        h.services.fail_next_rebuild_for_test(2);
        let attached = h
            .services
            .node_attach(None, Some(vec![spare.clone()]), Some(config_id.clone()))
            .await
            .unwrap();
        let rebuild = &attached["runtime_rebuild"];
        assert_eq!(rebuild["status"], "failed", "{rebuild}");
        assert_eq!(rebuild["restored"], false);
        assert!(
            rebuild["message"].as_str().unwrap().contains("重新连接"),
            "{rebuild}"
        );
        let status = h.services.runtime_status().await.unwrap();
        assert_eq!(status["state"], "idle");
        watcher.store(false, std::sync::atomic::Ordering::SeqCst);
    }

    /// 手动添加节点（node_create）走同一条重建路径。
    #[tokio::test]
    async fn creating_a_node_while_connected_rebuilds_the_running_config() {
        let _serial = REBUILD_TEST_LOCK
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let (h, config_id, a_id, _spare, watcher) =
            connected_with_spare_node("连接中手动添加", "198.51.100.74").await;

        let created = h
            .services
            .node_create(NodeCreateInput {
                config_id: Some(config_id.clone()),
                name: "丙".into(),
                server: "198.51.100.75".into(),
                port: 8388,
                password: "pw-c".into(), // secret-scan:allow
                method: "aes-256-gcm".into(),
            })
            .await
            .unwrap();
        let c_id = created["node_id"].as_str().unwrap().to_string();
        assert_eq!(created["runtime_rebuild"]["status"], "applied");
        let detail = h
            .services
            .config_detail(Some(config_id.clone()))
            .await
            .unwrap();
        assert_eq!(detail["current_node_id"], a_id);
        let profile = rendered_profiles(&h.dir);
        assert!(profile.contains(&format!("node-{c_id}")));
        watcher.store(false, std::sync::atomic::Ordering::SeqCst);
    }

    /// 试用到期后连种子节点：到期断开走 `runtime_stop`，若在启动锁内会自锁。
    #[tokio::test]
    async fn a_seed_connection_after_trial_expiry_does_not_deadlock() {
        let h = harness();
        let watcher = spawn_reusable_port_watcher(h.dir.clone());
        let created = h
            .services
            .config_create(auto_port_input("试用到期"))
            .await
            .unwrap();
        let config_id = created["config_id"].as_str().unwrap().to_string();

        let node_id = format!("nod_{:016x}", rand::random::<u64>());
        let password_ref = format!("node:{node_id}");
        crate::secrets::set_secret(&password_ref, "pw-seed").unwrap(); // secret-scan:allow
        {
            let conn = h.services.store.conn();
            configs::upsert_node(
                &conn,
                &configs::NewNode {
                    id: &node_id,
                    name: "种子",
                    server: "198.51.100.90",
                    port: 8388,
                    method: "aes-256-gcm",
                    password_ref: &password_ref,
                    source: configs::SOURCE_SEED,
                    source_key: &node_id,
                },
            )
            .unwrap();
            configs::attach_node(&conn, &config_id, &node_id).unwrap();
            // 试用已过期：这次连接成功后钩子会立刻到期并断开。
            crate::trial::mark_started(
                &conn,
                crate::store::now_ms() - crate::trial::TRIAL_DURATION_MS - 1,
            )
            .unwrap();
        }
        h.services.node_switch(&config_id, &node_id).await.unwrap();

        let started = tokio::time::timeout(
            std::time::Duration::from_secs(30),
            h.services.runtime_start(Some(config_id.clone())),
        )
        .await
        .expect("试用到期后的连接不能锁死")
        .unwrap();
        assert_eq!(started["state"], "running");
        // 到期断开在锁外完成：最终必须是断开。
        let status = h.services.runtime_status().await.unwrap();
        assert_eq!(status["state"], "idle");
        watcher.store(false, std::sync::atomic::Ordering::SeqCst);
    }

    /// 等锁期间用户已经断开：重建拿到锁后要复查，不能拿旧结论把连接接回来。
    #[tokio::test]
    async fn a_rebuild_after_a_queued_disconnect_is_skipped() {
        let _serial = REBUILD_TEST_LOCK
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let (h, config_id, _a_id, spare, watcher) =
            connected_with_spare_node("等锁期间断开", "198.51.100.91").await;
        let config = h.services.require_config(&config_id).unwrap();
        // 建节点时也会走一次重建（当时未连接，直接 skipped），计数归零后再测本次。
        h.services
            .rebuild_lock_attempts
            .store(0, std::sync::atomic::Ordering::SeqCst);
        h.services
            .rebuild_lock_acquired
            .store(0, std::sync::atomic::Ordering::SeqCst);

        // 先占住运行期锁，让重建在「取锁」这一步挂起。
        let hold = h.services.runtime_ops.lock().await;
        let spare_ids = [spare];
        let mut rebuild = std::pin::pin!(h.services.rebuild_running_config(&config, &spare_ids));
        // 轮询一次：老实现会在这里跑完前置判断（都通过），然后阻塞在锁上。
        {
            struct NoopWaker;
            impl std::task::Wake for NoopWaker {
                fn wake(self: std::sync::Arc<Self>) {}
            }
            let waker = std::task::Waker::from(std::sync::Arc::new(NoopWaker));
            let mut cx = std::task::Context::from_waker(&waker);
            assert!(matches!(
                std::future::Future::poll(rebuild.as_mut(), &mut cx),
                std::task::Poll::Pending
            ));
        }
        // 证据：第一次轮询确实走到了「取运行期锁」这一步，且还没拿到锁。
        // 只在锁前插一个会 yield 的 await、不取锁也会 Pending，这条断言能把它抓红。
        assert_eq!(
            h.services
                .rebuild_lock_attempts
                .load(std::sync::atomic::Ordering::SeqCst),
            1,
            "重建没有走到取锁这一步"
        );
        assert_eq!(
            h.services
                .rebuild_lock_acquired
                .load(std::sync::atomic::Ordering::SeqCst),
            0,
            "重建不应该在锁还被占着时拿到锁"
        );
        // 断开走 inner，不需要这把锁；先让它完成，再放锁。
        h.services.runtime_stop_inner(false).await.unwrap();
        drop(hold);

        let result = rebuild.await;
        assert_eq!(result["status"], "skipped", "{result}");
        assert_eq!(result["reason"], "not_connected");
        assert_eq!(
            h.services
                .rebuild_lock_acquired
                .load(std::sync::atomic::Ordering::SeqCst),
            1,
            "放锁后重建必须真正拿到锁再复查"
        );
        watcher.store(false, std::sync::atomic::Ordering::SeqCst);
    }

    /// `applied` 只列真的进运行配置的节点：缺凭据被跳过的不能算「已应用」。
    #[tokio::test]
    async fn applied_nodes_exclude_ones_without_credentials() {
        let h = harness();
        let created = h
            .services
            .config_create(auto_port_input("过滤"))
            .await
            .unwrap();
        let config_id = created["config_id"].as_str().unwrap().to_string();
        let with_secret = write_unattached_node(&h.services, "有密码", "198.51.100.80");
        // 只有节点行、没有密码：真正的连接会跳过它。
        let without_secret = format!("nod_{:016x}", rand::random::<u64>());
        {
            let conn = h.services.store.conn();
            configs::upsert_node(
                &conn,
                &configs::NewNode {
                    id: &without_secret,
                    name: "没密码",
                    server: "198.51.100.81",
                    port: 8388,
                    method: "aes-256-gcm",
                    password_ref: &format!("node:{without_secret}"),
                    source: configs::SOURCE_OWNED,
                    source_key: &without_secret,
                },
            )
            .unwrap();
        }
        {
            let conn = h.services.store.conn();
            configs::attach_nodes(
                &conn,
                &config_id,
                &[without_secret.clone(), with_secret.clone()],
            )
            .unwrap();
        }
        let config = h.services.require_config(&config_id).unwrap();
        let included = h
            .services
            .nodes_in_running_config(&config, &[without_secret.clone(), with_secret.clone()]);
        assert_eq!(included, vec![with_secret]);
    }

    /// 未连接时单节点测速：起一次临时运行时，同一配置 60 秒内复用同一个进程。
    #[tokio::test]
    async fn a_single_node_probe_cold_starts_the_runtime_and_reuses_it() {
        let h = harness();
        {
            let conn = h.services.store.conn();
            crate::store::settings::set_proxy_port(&conn, crate::config::any_free_port().unwrap())
                .unwrap();
        }
        let created = h
            .services
            .config_create(auto_port_input("单节点测速"))
            .await
            .unwrap();
        let config_id = created["config_id"].as_str().unwrap().to_string();
        let node = h
            .services
            .node_create(NodeCreateInput {
                config_id: Some(config_id),
                name: "甲".into(),
                server: "198.51.100.90".into(),
                port: 8388,
                password: "pw-a".into(), // secret-scan:allow
                method: "aes-256-gcm".into(),
            })
            .await
            .unwrap();
        let node_id = node["node_id"].as_str().unwrap().to_string();
        // 假 Clash API：`/version` 让运行时判定就绪，`/proxies/*/delay` 回 42ms。
        let watcher = spawn_port_watcher(h.dir.clone());

        let first = h.services.node_probe(&node_id).await.unwrap();
        assert_eq!(first["status"], "ok", "{first}");
        assert_eq!(first["probe_method"], "clash_delay");
        assert_eq!(first["latency_ms"], 42);
        assert_eq!(first["reachable"], true);

        let pid_path = h.dir.join("probe.pid");
        let pid = std::fs::read_to_string(&pid_path).expect("探针启动后应留下 probe.pid");
        let second = h.services.node_probe(&node_id).await.unwrap();
        assert_eq!(second["status"], "ok", "第二次应复用探针：{second}");
        assert_eq!(
            std::fs::read_to_string(&pid_path).unwrap(),
            pid,
            "60 秒内复用同一个探针进程，不重新冷启动"
        );

        drop(watcher);
        h.services.manager.stop_probe().await;
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

#[cfg(test)]
mod connect_changed_tests {
    use super::*;
    use serde_json::json;

    fn error(code: &str, message: &str, details: Option<Value>) -> anyhow::Error {
        anyhow::Error::new(ServiceError {
            code: code.to_string(),
            message: message.to_string(),
            retryable: false,
            details,
        })
    }

    #[test]
    fn failures_before_touching_the_network_report_none() {
        for reason in [
            "no_config",
            "rules_not_ready",
            "helper_missing",
            "tun_denied",
        ] {
            let error = error(
                "PRECONDITION_FAILED",
                "x",
                Some(json!({ "reason": reason })),
            );
            assert_eq!(connect_changed_state(&error), "none", "{reason}");
        }
        let error = error(
            "tun_start_failed",
            "x",
            Some(json!({
                "reason": "tun_start_failed",
                "detail": { "reason": "node_server_unresolved" },
            })),
        );
        assert_eq!(connect_changed_state(&error), "none");
    }

    /// 连接前已经停掉旧连接：之后的失败不能再报「没有改动」——旧连接已经不在了。
    #[test]
    fn a_failure_after_stopping_the_old_connection_is_not_untouched() {
        let after_stop = error(
            "PRECONDITION_FAILED",
            "x",
            Some(json!({ "reason": "no_nodes", "old_connection_stopped": true })),
        );
        assert_eq!(connect_changed_state(&after_stop), "restored");

        // 停旧本身失败：网络状态不确定。
        let stop_failed = error(
            "INTERNAL",
            "x",
            Some(json!({ "reason": "stop_failed", "old_connection_stopped": false })),
        );
        assert_eq!(connect_changed_state(&stop_failed), "unknown");
    }

    /// 启动后失败都会 abort：撤代理、停运行时，环境回到调用前。
    #[test]
    fn failures_after_start_report_restored_when_cleanup_ran() {
        let with_tail = error(
            "RUNTIME_EXITED",
            "x",
            Some(json!({ "runtime_log_tail": ["fatal"] })),
        );
        assert_eq!(connect_changed_state(&with_tail), "restored");

        let timeout = error("RUNTIME_START_TIMEOUT", "x", None);
        assert_eq!(connect_changed_state(&timeout), "restored");

        let proxy = error("INTERNAL", "设置系统代理失败：x", None);
        assert_eq!(connect_changed_state(&proxy), "restored");
    }

    #[test]
    fn an_unconfirmed_rollback_reports_unknown() {
        let restore_failed = error(
            "PRECONDITION_FAILED",
            "撤销系统代理失败：x",
            Some(json!({ "reason": "proxy_restore_failed" })),
        );
        assert_eq!(connect_changed_state(&restore_failed), "unknown");

        let tun = error(
            "tun_start_failed",
            "x",
            Some(json!({ "reason": "tun_start_failed" })),
        );
        assert_eq!(connect_changed_state(&tun), "unknown");

        let residual = error(
            "tun_start_failed",
            "x",
            Some(json!({
                "reason": "tun_start_failed",
                "detail": {
                    "reason": "takeover_incomplete",
                    "stopped": true,
                    "residual_routes": true,
                    "dns_flushed": true,
                },
            })),
        );
        assert_eq!(connect_changed_state(&residual), "unknown");
    }

    #[test]
    fn a_clean_tun_rollback_reports_restored() {
        let error = error(
            "tun_start_failed",
            "x",
            Some(json!({
                "reason": "tun_start_failed",
                "detail": {
                    "reason": "takeover_incomplete",
                    "stopped": true,
                    "residual_routes": false,
                    "dns_flushed": true,
                },
            })),
        );
        assert_eq!(connect_changed_state(&error), "restored");
    }
}
