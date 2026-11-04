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
    async fn core_install(&self, version: &str) -> anyhow::Result<Value>;

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

    async fn node_import_url(
        &self,
        config_id: Option<String>,
        url: &str,
    ) -> anyhow::Result<Value>;
    async fn node_create(&self, input: NodeCreateInput) -> anyhow::Result<Value>;
    async fn node_switch(
        &self,
        config_id: &str,
        node_id: &str,
        confirm_reconnect: bool,
    ) -> anyhow::Result<Value>;
    async fn node_probe(&self, node_id: &str) -> anyhow::Result<Value>;

    async fn default_profile_status(&self) -> anyhow::Result<Value>;
    async fn default_profile_refresh(&self, force: bool) -> anyhow::Result<Value>;
    async fn import_seed_file(&self, path: &str) -> anyhow::Result<Value>;

    async fn rules_status(&self) -> anyhow::Result<Value>;
    async fn category_list(&self, query: Option<String>, limit: Option<u32>) -> anyhow::Result<Value>;

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
        "uptime_seconds": null,
        "config_id": null,
        "mixed_port": null,
        "config_name": null,
        "node_id": null,
        "node_name": null,
        "applied_route_revision": null,
        "connected_since": null,
        "latency_ms": null,
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

    async fn core_install(&self, _version: &str) -> anyhow::Result<Value> {
        not_wired("安装运行时")
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

    async fn node_switch(
        &self,
        _config_id: &str,
        _node_id: &str,
        _confirm_reconnect: bool,
    ) -> anyhow::Result<Value> {
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
        store::StoreError::NotFound(_) => svc_error_with_details(
            "NOT_FOUND",
            "记录不存在",
            json!({ "reason": "not_found" }),
        ),
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
            format!("运行时未进入 running（当前 {}），连接已中止", state.as_str()),
        ))
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

/// 已连接的节点延迟：Clash API `GET /proxies/{tag}/delay`。
async fn clash_delay(addr: &str, secret: &str, tag: &str) -> Result<u64, String> {
    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(std::time::Duration::from_secs(6))
        .build()
        .map_err(|error| format!("创建延迟测试客户端失败：{error}"))?;
    let response = client
        .get(format!("http://{addr}/proxies/{tag}/delay"))
        .bearer_auth(secret)
        .query(&[
            ("timeout", "3000"),
            ("url", "http://cp.cloudflare.com/generate_204"),
        ])
        .send()
        .await
        .map_err(|error| format!("延迟测试请求失败：{error}"))?;
    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    if !status.is_success() {
        let detail = body.chars().take(200).collect::<String>();
        return Err(format!("延迟测试返回 HTTP {status}：{detail}"));
    }
    let value: Value =
        serde_json::from_str(&body).map_err(|_| "延迟测试响应不是合法 JSON".to_string())?;
    value
        .get("delay")
        .and_then(Value::as_u64)
        .ok_or_else(|| "延迟测试响应缺少 delay".to_string())
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
    data_dir: PathBuf,
    device_gate: RegistrationGate,
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
        Self {
            installer: Installer::new(&data_dir),
            store,
            manager,
            proxy,
            catalog,
            data_dir,
            device_gate: RegistrationGate::new(),
        }
    }

    fn config_dir(&self) -> PathBuf {
        self.data_dir.join("config")
    }

    fn active_config_id(&self) -> Option<String> {
        let conn = self.store.conn();
        configs::active(&conn).ok().flatten().map(|config| config.id)
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

    fn update_routing_mode(
        &self,
        config_id: &str,
        mode: &str,
    ) -> anyhow::Result<configs::Config> {
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

    fn ensure_runtime_installed(&self) -> anyhow::Result<crate::runtime::InstalledRuntime> {
        self.installer
            .active()
            .map_err(|e| svc_error(e.code(), e))?
            .ok_or_else(|| svc_error("RUNTIME_NOT_INSTALLED", "还没有安装 sing-box，先调用 CoreInstall"))
    }

    /// 磁盘配置里读回端口与 secret；配置损坏时返回 None。
    fn config_endpoints(value: &Value) -> Option<(u16, u16, String)> {
        let mixed = value.get("inbounds")?.as_array()?.first()?.get("listen_port")?.as_u64()? as u16;
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
                "现在拿不到默认节点，先刷新默认节点或手动添加一个",
                json!({ "reason": "seed_unavailable", "hint": "先刷新默认配置或手动添加节点" }),
            )
        })?;
        let exclusions = {
            let conn = self.store.conn();
            configs::seed_exclusions(&conn).map_err(|error| svc_error(error.code(), error))?
        };
        let parsed: Vec<crate::nodes::ParsedNode> = nodes
            .into_iter()
            .filter(|node| {
                let key = crate::nodes::source_key(&node.name, &node.server, node.port, &node.method);
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
        let (added, _) = self.add_parsed_nodes(
            Some(config_id),
            &parsed,
            configs::SOURCE_SEED,
            false,
        )?;
        Ok(added.len())
    }

    fn active_node(
        &self,
        config: &configs::Config,
    ) -> anyhow::Result<(configs::Node, String)> {
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
        let items = object.get(key).and_then(Value::as_array).cloned().unwrap_or_default();
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
    let (address, prefix) = value
        .split_once('/')
        .ok_or_else(|| value.to_string())?;
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
        let status = self.manager.status().await;
        serde_json::to_value(status).map_err(|e| svc_error("INTERNAL", e))
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
        let manifest = crate::runtime::RuntimeManifest::builtin()
            .map_err(|e| svc_error(e.code(), e))?;
        let (platform, arch) = crate::runtime::RuntimeManifest::host_platform();
        let available: Vec<Value> = manifest
            .releases
            .iter()
            .filter(|release| release.platform == platform && release.arch == arch && !release.yanked)
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

    async fn core_install(&self, version: &str) -> anyhow::Result<Value> {
        let manifest = crate::runtime::RuntimeManifest::builtin()
            .map_err(|e| svc_error(e.code(), e))?;
        let release = manifest
            .releases
            .iter()
            .find(|release| release.upstream_version == version && !release.yanked)
            .ok_or_else(|| svc_error("NOT_FOUND", format!("清单里没有版本 {version}")))?
            .clone();

        let installed = self
            .installer
            .install(&release)
            .await
            .map_err(|e| svc_error(e.code(), e))?;

        let row = crate::store::RuntimeVersionRow {
            version: installed.version.clone(),
            path: installed.dir.to_string_lossy().into_owned(),
            binary_path: installed.binary.to_string_lossy().into_owned(),
            sha256: installed.sha256.clone(),
            state: "active".into(),
            installed_at: installed.installed_at,
        };
        {
            let conn = self.store.conn();
            crate::store::runtime::upsert_version(&conn, &row)
                .map_err(|e| svc_error(e.code(), e))?;
        }

        Ok(json!({
            "version": installed.version,
            "path": installed.binary.to_string_lossy(),
            "installed": true,
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
                    format!(
                        "不支持的协议 {other}，可选值：vless_reality、hysteria2、shadowsocks"
                    ),
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
        let tun_excludes =
            validate_tun_excludes(connect_mode, input.tun_excludes.as_deref())?;

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
                    "现在拿不到默认节点",
                    json!({
                        "reason": "seed_unavailable",
                        "hint": "先刷新默认配置或手动添加节点"
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
            configs::list_nodes(&conn, config_id)
                .map_err(|error| svc_error(error.code(), error))?
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
            && dns.as_ref().map(|value| value == &current.dns).unwrap_or(true)
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
            configs::update(&conn, config_id, &patch)
                .map_err(|error| config_store_error(error))?;
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
            crate::seed::emit_node_list_changed(&self.store, "bindings_changed", Some(config_id), &[]);
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

        let deleted = {
            let conn = self.store.conn();
            configs::delete(&conn, config_id)
                .map_err(|error| svc_error(error.code(), error))?
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
            configs::activate(&conn, config_id)
                .map_err(|error| svc_error(error.code(), error))?;
        }
        self.emit_config_changed("activated", Some(&target));

        let node_count = {
            let conn = self.store.conn();
            configs::node_count(&conn, config_id)
                .map_err(|error| svc_error(error.code(), error))?
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

    async fn node_import_url(
        &self,
        config_id: Option<String>,
        url: &str,
    ) -> anyhow::Result<Value> {
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

        let subscription = crate::nodes::fetch_subscription(url).await.map_err(|error| {
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

    async fn node_switch(
        &self,
        config_id: &str,
        node_id: &str,
        confirm_reconnect: bool,
    ) -> anyhow::Result<Value> {
        let config = self.require_config(config_id)?;
        let members = {
            let conn = self.store.conn();
            configs::list_nodes(&conn, config_id)
                .map_err(|error| svc_error(error.code(), error))?
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

        if connected {
            if connected_config.as_deref() != Some(config_id) {
                return Err(svc_error_with_details(
                    "PRECONDITION_FAILED",
                    "这套配置不是当前连接的配置",
                    json!({ "reason": "config_not_running" }),
                ));
            }
            if !confirm_reconnect {
                return Err(svc_error_with_details(
                    "PRECONDITION_FAILED",
                    "切换节点会断开当前连接",
                    json!({
                        "reason": "will_disconnect",
                        "config_id": config_id,
                        "node_id": node_id,
                    }),
                ));
            }
            self.runtime_stop(false).await?;
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

        let runtime = if connected {
            let data = self.runtime_start(Some(config_id.to_string())).await?;
            crate::agent::app_handle::emit(
                "node-switched",
                json!({
                    "contract_version": crate::runtime::EVENT_CONTRACT_VERSION,
                    "config_id": config_id,
                    "from_node_id": previous,
                    "to_node_id": node_id,
                    "connected": true,
                    "runtime": data,
                    "emitted_at": chrono::Utc::now()
                        .to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
                }),
            );
            data
        } else {
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
            Value::Null
        };

        Ok(json!({
            "config_id": config_id,
            "node_id": node_id,
            "previous_node_id": previous,
            "connected": connected,
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
                    return Ok(probe_result(node_id, true, Some(delay), "clash_delay", None));
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
                format!("现在拿不到默认节点：{error}"),
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
            let mut data = self.route_state_json(&config, applied_mode.as_deref(), applied_revision);
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
            if let Err(error) =
                clash_put_selector(&plan.clash_addr, &plan.clash_secret, "route-local", to_selector)
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
            Ok(_) => {
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
                data["hot_switched"] = json!(false);
                data["reconnect"] = json!("reconnected");
                Ok(data)
            }
            Err(error) => {
                log::warn!("分流模式切换后自动重连失败：{error}");
                self.emit_routing_changed(&updated, "mode", None, None, false);
                let mut data = self.route_state_json(&updated, None, None);
                data["hot_switched"] = json!(false);
                data["reconnect"] = json!("reconnect_failed");
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

    async fn vpn_connect(
        &self,
        config_id: Option<String>,
    ) -> anyhow::Result<Value> {
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
        let installed = self.installer.active().ok().flatten().is_some();
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

        checks.push(diag_check(
            "app.runtime_installed",
            "app",
            installed,
            if installed { "运行时已安装".into() } else { "运行时未安装".into() },
            if installed { None } else { Some("安装运行时后再试") },
            if installed { None } else { Some(json!({ "kind": "reconnect" })) },
        ));
        checks.push(diag_check(
            "app.process_alive",
            "app",
            status.health.process,
            if status.health.process { "sing-box 进程存活".into() } else { "sing-box 进程未运行".into() },
            None,
            if running && !status.health.process { Some(json!({ "kind": "reconnect" })) } else { None },
        ));
        let version = status.upstream_version.clone().or_else(|| {
            self.installer.active().ok().flatten().map(|runtime| runtime.version)
        });
        checks.push(diag_check(
            "app.version",
            "app",
            version.is_some(),
            version.clone().map(|value| format!("运行时版本 {value}")).unwrap_or_else(|| "没有可用的运行时版本".into()),
            None,
            None,
        ));
        checks.push(diag_check(
            "app.config_valid",
            "app",
            !running || status.config_hash.is_some(),
            if running {
                status.config_hash.clone().unwrap_or_else(|| "缺少配置摘要".into())
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
            if status.health.clash_api { "控制面可用".into() } else { "控制面不可用".into() },
            if running && !status.health.clash_api { Some("重新连接后再试") } else { None },
            None,
        ));
        checks.push(diag_check(
            "app.data_plane",
            "app",
            !running || status.health.data_plane,
            if status.health.data_plane { "数据面可用".into() } else { "数据面不可用".into() },
            if running && !status.health.data_plane { Some("换个节点或稍后重试") } else { None },
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
                        .map(|expected| !endpoints.is_empty() && endpoints.iter().all(|item| item == expected))
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
                    if ok { None } else { Some("点『恢复网络』撤掉代理后再试") },
                    if ok { None } else { Some(json!({ "kind": "restore_network" })) },
                ));

                checks.push(diag_check(
                    "system.dns",
                    "system",
                    net.dns.resolvable,
                    format!(
                        "{} 个解析器，{} {}",
                        net.dns.servers.len(),
                        net.dns.probe_domain,
                        if net.dns.resolvable { "可解析" } else { "无法解析" }
                    ),
                    if net.dns.resolvable { None } else { Some("刷新 DNS 缓存后重试") },
                    if net.dns.resolvable { None } else { Some(json!({ "kind": "flush_dns" })) },
                ));

                let route_ok = net.route.default_interface.is_some();
                checks.push(diag_check(
                    "system.default_route",
                    "system",
                    route_ok,
                    match (&net.route.default_interface, &net.route.default_gateway) {
                        (Some(interface), Some(gateway)) => format!("默认接口 {interface}，网关 {gateway}"),
                        (Some(interface), None) => format!("默认接口 {interface}"),
                        _ => "没有默认路由".to_string(),
                    },
                    if route_ok { None } else { Some("检查本机网络连接") },
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
            exit_ip.clone().map(|ip| format!("代理出口 {ip}")).unwrap_or_else(|| "未探测到出口 IP".into()),
            if running && exit_ip.is_none() { Some("重新连接以重新探测") } else { None },
            if running && exit_ip.is_none() { Some(json!({ "kind": "reconnect" })) } else { None },
        ));

        let source_reachable = http_reachable(&crate::seed::source_url()).await;
        checks.push(diag_check(
            "network.reachable_seed_source",
            "network",
            source_reachable,
            if source_reachable { "默认节点源可达".into() } else { "默认节点源不可达".into() },
            if source_reachable { None } else { Some("连上网络后刷新默认节点") },
            if source_reachable { None } else { Some(json!({ "kind": "refresh_default_profile" })) },
        ));
        let github = http_reachable("https://github.com").await;
        checks.push(diag_check(
            "network.reachable_github",
            "network",
            github,
            if github { "GitHub 可达".into() } else { "GitHub 不可达".into() },
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
            if has_config { None } else { Some("新建一套配置") },
            if has_config { None } else { Some(json!({ "kind": "open_default_profile" })) },
        ));

        let seed_available = seed
            .get("content_sha256")
            .and_then(Value::as_str)
            .is_some();
        checks.push(diag_check(
            "config.seed_available",
            "config",
            seed_available,
            if seed_available {
                format!(
                    "默认节点 {} 个",
                    seed.get("node_count").and_then(Value::as_i64).unwrap_or(0)
                )
            } else {
                "还没有默认节点缓存".into()
            },
            if seed_available { None } else { Some("刷新默认节点") },
            if seed_available { None } else { Some(json!({ "kind": "refresh_default_profile" })) },
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
                "没有默认节点".into()
            } else if stale {
                "默认节点超过 6 小时未更新".into()
            } else {
                "默认节点较新".into()
            },
            if stale { Some("刷新默认节点") } else { None },
            if stale { Some(json!({ "kind": "refresh_default_profile" })) } else { None },
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
            "contract_version": "3.2.0",
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
        let outcome = crate::secrets::save_deepseek_key(key).await.map_err(|error| {
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

    async fn job_get(&self, _job_id: &str) -> anyhow::Result<Value> {
        Err(svc_error("NOT_FOUND", "P1 没有长任务"))
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

    /// 连接一套配置：单节点 + 全部走代理（本轮只保证这一种能起来）。
    async fn connect(&self, config: &configs::Config) -> anyhow::Result<Value> {
        if config.connection_mode != configs::CONNECTION_SYSTEM_PROXY {
            return Err(svc_error_with_details(
                "PRECONDITION_FAILED",
                "接管全部流量需要特权助手，会在后续批次提供",
                json!({ "reason": "tun_helper_missing" }),
            ));
        }

        let installed_rules = crate::rules::load_active(&self.store, &self.data_dir).ok_or_else(|| {
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
            svc_error_with_details(error.code(), error.to_string(), json!({ "reason": error.reason() }))
        })?;

        let (node, password) = self.active_node(config)?;
        let installed = self.ensure_runtime_installed()?;
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

        let input = vpn_config::BuildInput::new(
            current_descriptor,
            mixed_port,
            clash_port,
            clash_secret,
        );
        let value = vpn_config::build_routed_multi(&input, &descriptors, &node.id, &plan)
            .map_err(|e| svc_error(e.code(), e))?;

        let started = self
            .start_connection(
                &installed,
                &config.id,
                Some(config.id.clone()),
                Some(config.name.clone()),
                Some(node.id.clone()),
                Some(node.name.clone()),
                Some(config.route_revision),
                &value,
            )
            .await;

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
                return Err(self.abort_connection(svc_error(error.code(), error)));
            }
        };

        if let Err(error) = require_running_state(started.state) {
            return Err(self.abort_connection(error));
        }

        if let Err(error) = self.proxy.enable(mixed_port) {
            self.rollback_proxy_after_enable_failure().await;
            return Err(svc_error("INTERNAL", format!("设置系统代理失败：{error}")));
        }
        self.manager.set_system_proxy_enabled(true).await;

        let awaited_ip = self
            .manager
            .await_exit_ip(std::time::Duration::from_secs(3))
            .await;

        let status = self.manager.status().await;
        let exit_ip = status.health.exit_ip.clone().or(awaited_ip);
        let latency_ms = if exit_ip.is_some() {
            self.manager.exit_ip_latency_ms().await
        } else {
            None
        };
        let mut data = serde_json::to_value(status).map_err(|e| svc_error("INTERNAL", e))?;
        data["exit_ip"] = exit_ip.map(Value::String).unwrap_or(Value::Null);
        data["latency_ms"] = latency_ms.map(Value::from).unwrap_or(Value::Null);

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

        let exit_ip = match crate::runtime::DirectIpProbe::new(crate::runtime::DEFAULT_DIRECT_IP_PROBE)
        {
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
        tokio::task::spawn_blocking(crate::netcfg::flush_dns)
            .await
            .map_err(|error| svc_error("INTERNAL", error))?
            .map_err(|error| svc_error("INTERNAL", error))?;
        let verified = tokio::task::spawn_blocking(crate::netcfg::dns_resolvable)
            .await
            .unwrap_or(false);
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
        let verified = self
            .proxy
            .current_endpoint()
            .ok()
            .flatten()
            .as_deref()
            == Some(expected.as_str());
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
        gate.ensure(|| async { Ok::<(), String>(()) }).await.unwrap();
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
                password: "pw-secret".into(),
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
        assert_eq!(service.details.as_ref().unwrap()["reason"], "connect_mode_immutable");

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
            configs::list_nodes(&conn, &config_id).unwrap()[0].id.clone()
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
            .route_set_mode(
                Some(config_id),
                configs::ROUTING_PROXY_SELECTED,
                false,
            )
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

        let switched = services
            .node_switch(&config_id, &node_id, false)
            .await
            .unwrap();
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
            .node_switch(config_id, "nod_missing", false)
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
        assert_eq!(service.details.as_ref().unwrap()["reason"], "route_targets_empty");

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
        assert_eq!(service.details.as_ref().unwrap()["reason"], "listen_port_not_allowed");

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
}
