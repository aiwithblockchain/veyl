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

    async fn default_profile_status(&self) -> anyhow::Result<Value>;
    async fn default_profile_refresh(&self) -> anyhow::Result<Value>;
    async fn default_profile_tool_status(&self) -> anyhow::Result<Value>;
    async fn catalog_refresh(&self, force: bool) -> anyhow::Result<Value>;

    async fn net_config_get(&self) -> anyhow::Result<Value>;
    async fn net_repair(&self, action: &str, port: Option<u16>) -> anyhow::Result<Value>;

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
        "contract_version": crate::runtime::CONTRACT_VERSION,
        "state": "idle",
        "mode": "system_proxy",
        "pid": null,
        "upstream_version": null,
        "uptime_seconds": null,
        "profile_id": null,
        "mixed_port": null,
        "profile_name": null,
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

    async fn default_profile_status(&self) -> anyhow::Result<Value> {
        not_wired("默认配置状态")
    }

    async fn default_profile_refresh(&self) -> anyhow::Result<Value> {
        not_wired("刷新默认配置")
    }

    async fn default_profile_tool_status(&self) -> anyhow::Result<Value> {
        not_wired("默认配置状态")
    }

    async fn catalog_refresh(&self, _force: bool) -> anyhow::Result<Value> {
        not_wired("刷新默认配置")
    }

    async fn net_config_get(&self) -> anyhow::Result<Value> {
        not_wired("读取系统网络")
    }

    async fn net_repair(&self, _action: &str, _port: Option<u16>) -> anyhow::Result<Value> {
        not_wired("修复系统网络")
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
use crate::store::Store;

/// 服务层错误统一带契约错误码前缀（`CODE: 说明`），由信封层转成 `AivpnError`。
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

/// 连接只有真的进入 running 才算成功。
///
/// `manager.start` 在并发 stop 或退出时会返回 `Ok(Idle)`；这时继续设置系统代理
/// 会把流量指向没人监听的端口，用户会直接断网。
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

fn catalog_result(store: &Store, changed: bool, offline: bool, detail: &str) -> Value {
    match crate::default_profile::status(store) {
        Some(status) => json!({
            "changed": changed,
            "offline": offline,
            "package_id": status.package_id,
            "version": status.version,
            "applied_at": status.applied_at,
            "node_count": status.node_count,
            "new_version_available": status.new_version_available,
            "detail": detail,
        }),
        None => json!({
            "changed": false,
            "offline": offline,
            "package_id": null,
            "version": null,
            "applied_at": null,
            "node_count": 0,
            "new_version_available": false,
            "detail": detail,
        }),
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

async fn http_reachable(url: &str) -> bool {
    let Ok(client) = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .build()
    else {
        return false;
    };
    client.get(url).send().await.is_ok()
}

fn default_profile_status_json(store: &Store) -> Value {
    match crate::default_profile::status(store) {
        Some(status) => json!({
            "package_id": status.package_id,
            "name": status.name,
            "version": status.version,
            "applied_at": status.applied_at,
            "new_version_available": status.new_version_available,
            "node_count": status.node_count,
        }),
        None => json!({
            "package_id": null,
            "name": null,
            "version": null,
            "applied_at": null,
            "new_version_available": false,
            "node_count": 0,
        }),
    }
}


/// 首次注册的串行闸门。
///
/// 并发调用 `ensure` 时只有一个会真正执行注册，其余等它结束后直接返回；
/// 注册失败则不置位，下一次调用可以重试。
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

    /// 让下一次 `ensure` 重新执行注册（401 后调用）。
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
    /// 首次注册的串行闸门：并发调用只会真正注册一次。
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

    fn active_profile_id(&self) -> Option<String> {
        let conn = self.store.conn();
        crate::store::profiles::active(&conn)
            .ok()
            .flatten()
            .map(|profile| profile.id)
    }


    /// 首次目录调用前确保有设备 token：先读本地，没有就注册一次。
    /// `RegistrationGate` 保证并发调用只注册一次；注册失败不阻塞其它功能。
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

    /// 401 之后：清掉本地 token，重新注册一次（只重试一次，不会死循环）。
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

    async fn catalog_detail(
        &self,
        node_id: &str,
    ) -> anyhow::Result<crate::catalog::NodeDetailResponse> {
        self.ensure_device_token().await?;
        match self.catalog.node_detail(node_id).await {
            Ok(detail) => Ok(detail),
            Err(error) if error.is_unauthorized() => {
                log::warn!("节点详情 401，重新注册设备后重试一次");
                self.reauthenticate().await?;
                self.catalog
                    .node_detail(node_id)
                    .await
                    .map_err(|e| svc_error(e.code.clone(), e))
            }
            Err(error) => Err(svc_error(error.code.clone(), error)),
        }
    }


    /// 种子导入的 profile 没有 node_id：凭据存在 `secrets.enc` 的 `node:<profile_id>`。
    /// 这里是唯一读取它的地方，返回值不落盘、不序列化。
    fn seed_build_input(
        &self,
        profile_id: &str,
        mixed_port: u16,
        clash_port: u16,
        clash_secret: String,
    ) -> Result<crate::config::BuildInput, &'static str> {
        let raw = crate::secrets::get_secret(&format!("node:{profile_id}"))
            .map_err(|_| "credentials_missing")?
            .ok_or("credentials_missing")?;

        let value: Value = serde_json::from_str(&raw).map_err(|_| "credentials_missing")?;
        let server = value
            .get("server")
            .and_then(Value::as_str)
            .ok_or("credentials_missing")?;
        let server_port = value
            .get("server_port")
            .and_then(Value::as_u64)
            .and_then(|port| u16::try_from(port).ok())
            .ok_or("credentials_missing")?;
        let name = value
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or("种子节点");

        let protocol = match value.get("protocol").and_then(Value::as_str).unwrap_or("shadowsocks") {
            "shadowsocks" => {
                let password = value
                    .get("password")
                    .and_then(Value::as_str)
                    .ok_or("credentials_missing")?;
                let method = value
                    .get("method")
                    .and_then(Value::as_str)
                    .ok_or("credentials_missing")?;
                if !crate::catalog::SUPPORTED_METHODS.contains(&method) {
                    return Err("unsupported_method");
                }
                crate::config::ProtocolConfig::Shadowsocks {
                    password: password.to_string(),
                    method: method.to_string(),
                }
            }
            _ => return Err("unsupported_protocol"),
        };

        Ok(crate::config::BuildInput::new(
            crate::config::NodeDescriptor {
                id: profile_id.to_string(),
                name: name.to_string(),
                server: server.to_string(),
                server_port,
                protocol,
            },
            mixed_port,
            clash_port,
            clash_secret,
        ))
    }

    fn resolve_profile(&self, target: &ConnectTarget) -> anyhow::Result<crate::store::Profile> {
        let conn = self.store.conn();
        let found = match target {
            ConnectTarget::Profile(id) => crate::store::profiles::get(&conn, id)
                .map_err(|e| svc_error(e.code(), e))?,
            ConnectTarget::Node(node_id) => crate::store::profiles::list(&conn)
                .map_err(|e| svc_error(e.code(), e))?
                .into_iter()
                .find(|profile| profile.node_id.as_deref() == Some(node_id.as_str())),
        };
        found.ok_or_else(|| svc_error("NOT_FOUND", "找不到对应的本地配置，先导入节点"))
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
}

#[async_trait]
impl VpnToolServices for WiredServices {
    async fn runtime_status(&self) -> anyhow::Result<Value> {
        let status = self.manager.status().await;
        serde_json::to_value(status).map_err(|e| svc_error("INTERNAL", e))
    }

    async fn runtime_start(&self, profile_id: Option<String>) -> anyhow::Result<Value> {
        match profile_id {
            Some(id) => self.connect(ConnectTarget::Profile(id)).await,
            None => {
                if let Some(active) = self.active_profile_id() {
                    self.connect(ConnectTarget::Profile(active)).await
                } else if crate::default_profile::status(&self.store).is_some() {
                    // 没有本地 profile 但有默认配置包：用它连。
                    self.connect_default_package().await
                } else {
                    Err(svc_error(
                        "PRECONDITION_FAILED",
                        "还没有可用节点：先获取默认配置或导入节点文件",
                    ))
                }
            }
        }
    }

    async fn runtime_stop(&self, _force: bool) -> anyhow::Result<Value> {
        // 先记下要清理的 profile：断开后 active 会被清空。
        let active = self.active_profile_id();
        // 撤代理失败必须中止断开，不能留下指向死端口的系统代理。
        self.restore_system_proxy()?;
        self.manager.set_system_proxy_enabled(false).await;
        let status = self
            .manager
            .stop()
            .await
            .map_err(|e| svc_error(e.code(), e))?;
        let conn = self.store.conn();
        let _ = crate::store::profiles::clear_active(&conn);
        // 断开即删明文配置：它只在连接期间允许存在。
        if let Some(profile_id) = active {
            vpn_config::remove_profile_config(&self.config_dir(), &profile_id);
        }
        // 默认配置包的渲染文件用固定键，也一起清掉。
        vpn_config::remove_profile_config(&self.config_dir(), "default");
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
        Ok(json!({ "lines": tail, "truncated": false, "redacted_fields": ["uuid", "password"] }))
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
        // 未知取值不能当成「不过滤」：那会让模型传错值时静默拿到全部节点。
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
            // P1 没有本地节点缓存，每次都是实时拉取；键必须存在。
            "stale": false,
        }))
    }

    async fn profile_list(&self) -> anyhow::Result<Value> {
        let conn = self.store.conn();
        let profiles = crate::store::profiles::list(&conn).map_err(|e| svc_error(e.code(), e))?;
        let items: Vec<Value> = profiles
            .iter()
            .map(|profile| {
                json!({
                    "profile_id": profile.id,
                    "node_id": profile.node_id,
                    "name": profile.name,
                    "protocol": profile.protocol,
                    "region": profile.region,
                    "is_active": profile.is_active,
                    "created_at": crate::store::iso_from_ms(profile.created_at),
                })
            })
            .collect();
        let active = profiles.iter().find(|p| p.is_active).map(|p| p.id.clone());
        Ok(json!({ "profiles": items, "active_profile_id": active }))
    }

    async fn profile_import(&self, node_id: &str, name: Option<String>) -> anyhow::Result<Value> {
        let detail = self.catalog_detail(node_id).await?;

        let snapshot = detail.node.non_secret_config();
        let id = format!("prf_{node_id}");

        // 数据库操作全部在这个块里完成，不跨 await 持有连接。
        let (display, created) = {
            let conn = self.store.conn();
            match crate::store::profiles::get(&conn, &id).map_err(|e| svc_error(e.code(), e))? {
                Some(existing) => (existing.name, false),
                None => {
                    let display = name.unwrap_or_else(|| detail.node.summary.name.clone());
                    crate::store::profiles::create(
                        &conn,
                        &crate::store::NewProfile {
                            id: &id,
                            node_id: Some(node_id),
                            name: &display,
                            protocol: Some(detail.node.summary.protocol.as_str()),
                            region: Some(detail.node.summary.region.as_str()),
                            config: &snapshot,
                        },
                    )
                    .map_err(|e| svc_error(e.code(), e))?;
                    (display, true)
                }
            }
        };

        Ok(json!({
            "profile_id": id,
            "name": display,
            "protocol": detail.node.summary.protocol.as_str(),
            "region": detail.node.summary.region,
            "already_existed": !created,
        }))
    }

    async fn profile_delete(&self, profile_id: &str) -> anyhow::Result<Value> {
        // 准入检查先于执行：命中活动配置直接拒绝。
        if let Some(active) = self.manager.active_profile_id().await {
            if active == profile_id {
                return Err(svc_error(
                    "PRECONDITION_FAILED",
                    "ACTIVE_PROFILE_IN_USE",
                ));
            }
        }
        let existed = {
            let conn = self.store.conn();
            let existed = crate::store::profiles::get(&conn, profile_id)
                .map_err(|e| svc_error(e.code(), e))?
                .is_some();
            crate::store::profiles::delete(&conn, profile_id)
                .map_err(|e| svc_error(e.code(), e))?;
            existed
        };

        // 删配置时必须把带凭据的文件和 secrets 条目一起清掉，否则磁盘上会留下孤儿密文。
        vpn_config::remove_profile_config(&self.config_dir(), profile_id);
        let _ = crate::secrets::delete_secret(&format!("node:{profile_id}"));

        let active_after = {
            let conn = self.store.conn();
            crate::store::profiles::active(&conn)
                .ok()
                .flatten()
                .map(|profile| profile.id)
        };

        Ok(json!({
            "profile_id": profile_id,
            "deleted": existed,
            "already_absent": !existed,
            "active_profile_id": active_after,
        }))
    }

    async fn vpn_connect(
        &self,
        target: ConnectTarget,
        _strategy: &str,
    ) -> anyhow::Result<Value> {
        self.connect(target).await
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
        let default_status = crate::default_profile::status(&self.store);

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

        let source_reachable = http_reachable(&crate::default_profile::source_url()).await;
        checks.push(diag_check(
            "network.reachable_default_source",
            "network",
            source_reachable,
            if source_reachable { "默认配置源可达".into() } else { "默认配置源不可达".into() },
            if source_reachable { None } else { Some("连上网络后刷新默认配置") },
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
        let deepseek = http_reachable("https://api.deepseek.com").await;
        checks.push(diag_check(
            "network.reachable_deepseek",
            "network",
            deepseek,
            if deepseek { "DeepSeek API 可达".into() } else { "DeepSeek API 不可达".into() },
            None,
            None,
        ));

        let has_profile = status.profile_id.is_some() || running;
        checks.push(diag_check(
            "config.current_profile",
            "config",
            has_profile || default_status.is_some(),
            status
                .profile_name
                .clone()
                .or_else(|| status.profile_id.clone())
                .or_else(|| default_status.as_ref().map(|status| format!("默认配置 {}", status.version)))
                .unwrap_or_else(|| "还没有可用配置".into()),
            if has_profile || default_status.is_some() { None } else { Some("获取默认配置或导入节点文件") },
            if has_profile || default_status.is_some() { None } else { Some(json!({ "kind": "open_default_profile" })) },
        ));

        let package_ok = default_status.is_some();
        checks.push(diag_check(
            "config.default_package",
            "config",
            package_ok,
            default_status
                .as_ref()
                .map(|status| format!("默认配置 {} · {} 个节点", status.version, status.node_count))
                .unwrap_or_else(|| "没有默认配置".into()),
            if package_ok { None } else { Some("刷新默认配置") },
            if package_ok { None } else { Some(json!({ "kind": "refresh_default_profile" })) },
        ));

        let stale = crate::default_profile::last_checked_ms(&self.store)
            .map(|checked| {
                crate::store::now_ms().saturating_sub(checked)
                    > crate::default_profile::REFRESH_INTERVAL.as_millis() as i64
            })
            .unwrap_or(false);
        checks.push(diag_check(
            "config.package_stale",
            "config",
            !stale,
            if default_status.is_some() {
                if stale { "默认配置超过 6 小时未更新".into() } else { "默认配置较新".into() }
            } else {
                "没有默认配置".into()
            },
            if stale { Some("刷新默认配置") } else { None },
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
            "contract_version": "1.1.0",
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
        // 与 `deepseek_save_key` 命令共用 secrets::save_deepseek_key，不维护第二套逻辑。
        let outcome = crate::secrets::save_deepseek_key(key).await.map_err(|error| {
            // 工具信封只认契约错误码，把 UI 用的细分码折进去。
            let code = match error.ui_code() {
                "INVALID_KEY" => "INVALID_ARGUMENT",
                _ => "INTERNAL",
            };
            svc_error(code, error.message())
        })?;
        // 与 UI 命令共用同一个更新函数，工具存档后对话也立刻用新 Key。
        crate::agent::update_credentials(Some(key.trim().to_string()));
        Ok(json!({
            "saved": true,
            "validation": outcome.validation,
            "validation_detail": outcome.validation_detail,
        }))
    }

    async fn job_get(&self, _job_id: &str) -> anyhow::Result<Value> {
        Err(svc_error("NOT_FOUND", "P1 没有长任务"))
    }

    async fn default_profile_status(&self) -> anyhow::Result<Value> {
        Ok(default_profile_status_json(&self.store))
    }

    async fn default_profile_refresh(&self) -> anyhow::Result<Value> {
        let state = self.manager.status().await.state;
        let running = matches!(
            state,
            crate::runtime::RuntimeState::Running | crate::runtime::RuntimeState::Degraded
        );
        crate::default_profile::refresh(&self.store, running)
            .await
            .map_err(|error| svc_error("UPSTREAM_ERROR", error))?;
        Ok(default_profile_status_json(&self.store))
    }

    async fn default_profile_tool_status(&self) -> anyhow::Result<Value> {
        Ok(crate::default_profile::tool_status(&self.store))
    }

    async fn catalog_refresh(&self, force: bool) -> anyhow::Result<Value> {
        if !force {
            if let Some(checked) = crate::default_profile::last_checked_ms(&self.store) {
                let now = crate::store::now_ms();
                let interval = crate::default_profile::REFRESH_INTERVAL.as_millis() as i64;
                if now.saturating_sub(checked) < interval {
                    return Ok(catalog_result(
                        &self.store,
                        false,
                        false,
                        "6 小时内已检查过，未重复拉取",
                    ));
                }
            }
        }

        let state = self.manager.status().await.state;
        let running = matches!(
            state,
            crate::runtime::RuntimeState::Running | crate::runtime::RuntimeState::Degraded
        );
        match crate::default_profile::refresh(&self.store, running).await {
            Ok(outcome) => {
                let changed = matches!(outcome, crate::default_profile::RefreshOutcome::Updated { .. });
                let detail = if changed && running {
                    "已更新默认配置，下次连接生效"
                } else if changed {
                    "已更新默认配置"
                } else {
                    "默认配置已是最新"
                };
                Ok(catalog_result(&self.store, changed, false, detail))
            }
            Err(error) => {
                // 有缓存时拉取失败不算错：离线是正常场景。
                if crate::default_profile::status(&self.store).is_some() {
                    let age_days = crate::default_profile::last_checked_ms(&self.store)
                        .map(|checked| {
                            (crate::store::now_ms().saturating_sub(checked) / 86_400_000).max(0)
                        })
                        .unwrap_or(0);
                    Ok(catalog_result(
                        &self.store,
                        false,
                        true,
                        &format!("离线，沿用本地缓存（上次更新 {age_days} 天前）"),
                    ))
                } else {
                    Err(svc_error(
                        "UPSTREAM_ERROR",
                        format!(
                            "现在无法访问默认配置源，这在未连接时是正常的。请先导入本地配置文件并连接，再检查更新。（{error}）"
                        ),
                    ))
                }
            }
        }
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
    profile_id: String,
    armed: bool,
}

impl RenderedConfigGuard {
    fn new(config_dir: PathBuf, profile_id: String) -> Self {
        Self {
            config_dir,
            profile_id,
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
            vpn_config::remove_profile_config(&self.config_dir, &self.profile_id);
        }
    }
}

impl WiredServices {

    /// 连接在启动阶段中止：先把可能还开着的系统代理（切换节点时是上一个的）撤掉。
    fn abort_connection(&self, error: anyhow::Error) -> anyhow::Error {
        if let Err(disable_error) = self.proxy.disable() {
            log::warn!("连接中止后撤销系统代理失败：{disable_error}");
        }
        error
    }

    /// 撤系统代理并校验：没有任何网络服务仍指向我们写进去的端点。
    ///
    /// 失败返回 `PRECONDITION_FAILED / proxy_restore_failed`；调用方**不得**继续停运行时，
    /// 否则就是「界面说已断开、代理还指着死端口」。
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

    /// enable 失败时回滚：先把系统代理还原，再停运行时。
    ///
    /// macOS 的 apply 是逐个网络服务写的，中途失败会留下「半开着」的状态；
    /// 只停运行时会留下指向死端口的代理，本会话内用户直接断网。
    async fn rollback_proxy_after_enable_failure(&self) {
        if let Err(error) = self.proxy.disable() {
            log::warn!("回滚系统代理失败：{error}");
        }
        let _ = self.manager.stop().await;
    }

    /// 切换 profile 时清掉上一个 profile 的明文配置；目标自己不能删。
    fn drop_previous_rendered_config(&self, target_profile_id: &str) {
        if let Some(previous) = self.active_profile_id() {
            if previous != target_profile_id {
                vpn_config::remove_profile_config(&self.config_dir(), &previous);
            }
        }
    }

    /// 连接：每次都从凭据源重新渲染配置。
    ///
    /// 渲染出的配置文件含明文凭据，只在连接期间存在：断开、连接失败、应用退出都会删除。
    /// 不能复用磁盘上的旧文件，否则 secrets.enc 的加密等于白做。
    async fn connect(&self, target: ConnectTarget) -> anyhow::Result<Value> {
        // §4.6 第 1 步：退出流程开始后拒绝新的连接请求。
        if crate::lifecycle::is_quitting() {
            return Err(svc_error(
                "PRECONDITION_FAILED",
                "应用正在退出，不能再发起连接",
            ));
        }
        let profile = self.resolve_profile(&target)?;
        let installed = self.ensure_runtime_installed()?;

        // 切换 profile：先删上一个的明文配置，别每切一次就多留一份。
        self.drop_previous_rendered_config(&profile.id);

        // 凭据来源按 profile 类型二选一：
        // - 有 node_id：走目录详情，要求目录服务可达，凭据只进内存与 0600 配置；
        // - 无 node_id（种子导入）：读本地 node:<profile_id>，缺失就明确报错。
        let mixed_port = vpn_config::pick_free_port().map_err(|e| svc_error(e.code(), e))?;
        let clash_port = vpn_config::pick_free_port().map_err(|e| svc_error(e.code(), e))?;
        let clash_secret = vpn_config::random_secret();

        let (value, etag) = match profile.node_id.clone() {
            Some(node_id) => {
                let detail = self.catalog_detail(&node_id).await?;
                let input = detail
                    .node
                    .clone()
                    .into_build_input(mixed_port, clash_port, clash_secret)
                    .map_err(|e| svc_error(e.code(), e))?;
                (
                    vpn_config::build(&input).map_err(|e| svc_error(e.code(), e))?,
                    Some(detail.etag.clone()),
                )
            }
            None => {
                let input = self
                    .seed_build_input(&profile.id, mixed_port, clash_port, clash_secret)
                    .map_err(|e| svc_error("PRECONDITION_FAILED", e))?;
                (
                    vpn_config::build(&input).map_err(|e| svc_error(e.code(), e))?,
                    None,
                )
            }
        };

        self.start_connection(
            &installed,
            &profile.id,
            Some(profile.id.clone()),
            Some(profile.name.clone()),
            &value,
            etag.as_deref(),
        )
        .await
    }

    /// 渲染 → 启动 → 设代理 → 等出口 IP 的公共尾巴。
    /// `config_key` 决定落盘文件名：普通 profile 用 profile_id，默认配置包用 "default"。
    async fn start_connection(
        &self,
        installed: &crate::runtime::InstalledRuntime,
        config_key: &str,
        db_profile_id: Option<String>,
        profile_name: Option<String>,
        value: &Value,
        etag: Option<&str>,
    ) -> anyhow::Result<Value> {
        // guard 先于 install_profile 建立：它中途失败时明文可能已经落盘。
        // 删除幂等，文件不存在会走 NotFound 分支，提前建不会误删别的东西。
        let guard = RenderedConfigGuard::new(self.config_dir(), config_key.to_string());

        let path = vpn_config::install_profile(
            &installed.binary,
            &self.config_dir(),
            config_key,
            value,
            etag,
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
            profile_id: db_profile_id.clone(),
            profile_name,
        };

        // 切节点/重连：先撤旧代理，避免旧进程已停、代理还指着旧端口。
        // 撤不掉就中止，保持旧连接原样。
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
                // 切换时 start 可能已经停掉旧节点；旧代理还指着死端口，必须撤掉。
                return Err(self.abort_connection(svc_error(error.code(), error)));
            }
        };

        // start() 在并发 stop（含退出）时会返回 Ok(Idle)，那不是连上。
        // 不拦的话会继续写系统代理，把流量指向没人监听的端口。
        if let Err(error) = require_running_state(started.state) {
            return Err(self.abort_connection(error));
        }

        if let Err(error) = self.proxy.enable(mixed_port) {
            self.rollback_proxy_after_enable_failure().await;
            return Err(svc_error("INTERNAL", format!("设置系统代理失败：{error}")));
        }
        self.manager.set_system_proxy_enabled(true).await;

        if let Some(profile_id) = db_profile_id.as_deref() {
            let conn = self.store.conn();
            let _ = crate::store::profiles::set_active(&conn, profile_id);
        }

        // 出口 IP 在进入 running 后才探测；按契约 4.11 第 6 步在这里等结果。
        // 最多等 3 秒：正常 1 秒内能回，再久说明探测链路本身有问题，不该拖住对话。
        // 超时只是留空，连接本身照常成功。
        let awaited_ip = self
            .manager
            .await_exit_ip(std::time::Duration::from_secs(3))
            .await;

        // 等待期间状态可能已经变化，返回最新的快照而不是启动瞬间的。
        let status = self.manager.status().await;
        // 快照里的值可能已被后台探测回填，优先用它；没有再退回等待的结果。
        let exit_ip = status.health.exit_ip.clone().or(awaited_ip);
        let latency_ms = if exit_ip.is_some() {
            self.manager.exit_ip_latency_ms().await
        } else {
            None
        };
        let mut data = serde_json::to_value(status).map_err(|e| svc_error("INTERNAL", e))?;
        data["exit_ip"] = exit_ip.map(Value::String).unwrap_or(Value::Null);
        // 契约要求这个键永远存在；测不到就显式 null，别留 undefined。
        data["latency_ms"] = latency_ms.map(Value::from).unwrap_or(Value::Null);

        if config_key == "default" {
            // 新版本从这次连接起生效，「有新版本」徽标可以消掉。
            crate::default_profile::mark_applied(&self.store);
        }
        guard.disarm();
        Ok(data)
    }

    /// 用默认配置包连接：适配 tun→mixed 后走正常渲染/启动流程。
    /// 新包渲染失败时回退上一版并重试一次。
    async fn connect_default_package(&self) -> anyhow::Result<Value> {
        if crate::lifecycle::is_quitting() {
            return Err(svc_error(
                "PRECONDITION_FAILED",
                "应用正在退出，不能再发起连接",
            ));
        }
        let installed = self.ensure_runtime_installed()?;
        // 默认配置与普通 profile 互斥：先把上一个 profile 的明文配置清掉。
        if let Some(previous) = self.active_profile_id() {
            vpn_config::remove_profile_config(&self.config_dir(), &previous);
        }

        let attempt = self.try_default_once(&installed).await;
        match attempt {
            Ok(data) => Ok(data),
            Err(first) => {
                // 只有配置本身不可用时才回退；启动/代理失败回退也救不了。
                let text = first.to_string();
                if !text.contains("RUNTIME_CONFIG_INVALID") && !text.contains("INVALID_ARGUMENT") {
                    return Err(first);
                }
                if !crate::default_profile::rollback(&self.store) {
                    return Err(first);
                }
                log::warn!("默认配置包不可用，已回退上一版并重试：{text}");
                self.try_default_once(&installed).await.map_err(|_| first)
            }
        }
    }

    async fn try_default_once(
        &self,
        installed: &crate::runtime::InstalledRuntime,
    ) -> anyhow::Result<Value> {
        let Some((_row, package)) = crate::default_profile::load_package(&self.store) else {
            return Err(svc_error(
                "PRECONDITION_FAILED",
                "还没有默认配置，先获取默认配置或导入节点",
            ));
        };

        let mixed_port = vpn_config::pick_free_port().map_err(|e| svc_error(e.code(), e))?;
        let clash_port = vpn_config::pick_free_port().map_err(|e| svc_error(e.code(), e))?;
        let clash_secret = vpn_config::random_secret();

        let adapted = crate::default_profile::adapt(
            &package,
            mixed_port,
            clash_port,
            &clash_secret,
            None,
        )
        .map_err(|error| svc_error("RUNTIME_CONFIG_INVALID", error))?;

        // 上一次的 default 配置可能还在；先删，保证不复用旧明文。
        vpn_config::remove_profile_config(&self.config_dir(), "default");

        self.start_connection(
            installed,
            "default",
            None,
            Some("默认配置".to_string()),
            &adapted,
            None,
        )
        .await
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
mod proxy_rollback_tests {
    use super::*;
    use crate::proxy::backup::MemoryBackupStore;
    use crate::proxy::{PlatformProxy, ProxyController};
    use crate::runtime::{RuntimeError, RuntimeResult};
    use serde_json::Value;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static RESTORE_CALLS: AtomicUsize = AtomicUsize::new(0);

    struct FailingProxy;

    impl PlatformProxy for FailingProxy {
        fn platform(&self) -> &'static str {
            "test"
        }

        fn capture(&self) -> RuntimeResult<Value> {
            Ok(serde_json::json!({ "http": "original:8080" }))
        }

        fn apply(&self, _port: u16) -> RuntimeResult<()> {
            Err(RuntimeError::Proxy("apply failed".into()))
        }

        fn restore(&self, _payload: &Value) -> RuntimeResult<()> {
            RESTORE_CALLS.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }

        fn current(&self) -> RuntimeResult<Option<String>> {
            Ok(None)
        }
    }

    static FAILING: FailingProxy = FailingProxy;

    static ABORT_RESTORES: AtomicUsize = AtomicUsize::new(0);

    struct SucceedingApplyProxy;

    impl PlatformProxy for SucceedingApplyProxy {
        fn platform(&self) -> &'static str {
            "test"
        }

        fn capture(&self) -> RuntimeResult<Value> {
            Ok(serde_json::json!({ "http": "original:8080" }))
        }

        fn apply(&self, _port: u16) -> RuntimeResult<()> {
            Ok(())
        }

        fn restore(&self, _payload: &Value) -> RuntimeResult<()> {
            ABORT_RESTORES.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }

        fn current(&self) -> RuntimeResult<Option<String>> {
            Ok(None)
        }
    }

    static SUCCEEDING: SucceedingApplyProxy = SucceedingApplyProxy;

    struct FailingRestoreProxy;

    impl PlatformProxy for FailingRestoreProxy {
        fn platform(&self) -> &'static str {
            "test"
        }

        fn capture(&self) -> RuntimeResult<Value> {
            Ok(serde_json::json!({ "http": "original:8080" }))
        }

        fn apply(&self, _port: u16) -> RuntimeResult<()> {
            Ok(())
        }

        fn restore(&self, _payload: &Value) -> RuntimeResult<()> {
            Err(RuntimeError::Proxy("restore failed".into()))
        }

        fn current(&self) -> RuntimeResult<Option<String>> {
            Ok(None)
        }
    }

    static FAILING_RESTORE: FailingRestoreProxy = FailingRestoreProxy;

    fn services_with_proxy(
        dir: &std::path::Path,
        backend: &'static dyn PlatformProxy,
    ) -> WiredServices {
        let store = Arc::new(Store::open_in_memory().unwrap());
        let manager =
            crate::runtime::RuntimeManager::new(crate::runtime::RuntimeConfig::new(dir));
        let proxy =
            Arc::new(ProxyController::with_backend(
                Box::new(MemoryBackupStore::new()),
                backend,
            ));
        let catalog = Arc::new(CatalogClient::new("http://127.0.0.1:9/v1"));
        WiredServices::new(store, manager, proxy, catalog, dir)
    }

    #[tokio::test]
    async fn a_failed_enable_rolls_the_proxy_back() {
        let dir = std::env::temp_dir().join(format!("veyl-proxy-{:016x}", rand::random::<u64>()));
        std::fs::create_dir_all(&dir).unwrap();
        let services = services_with_proxy(&dir, &FAILING);

        RESTORE_CALLS.store(0, Ordering::SeqCst);
        assert!(services.proxy.enable(1234).is_err(), "假的 apply 必须失败");
        services.rollback_proxy_after_enable_failure().await;

        assert_eq!(
            RESTORE_CALLS.load(Ordering::SeqCst),
            1,
            "enable 失败后必须还原系统代理"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn stopping_aborts_when_the_proxy_cannot_be_restored() {
        let dir = std::env::temp_dir().join(format!("veyl-proxy-{:016x}", rand::random::<u64>()));
        std::fs::create_dir_all(&dir).unwrap();
        let services = services_with_proxy(&dir, &FAILING_RESTORE);

        // 先让备份存在，模拟「已连接」。
        services.proxy.enable(4321).unwrap();

        let error = services.runtime_stop(false).await.unwrap_err();
        let service = error
            .downcast_ref::<ServiceError>()
            .expect("必须是结构化错误");
        assert_eq!(service.code, "PRECONDITION_FAILED");
        assert_eq!(
            service.details.as_ref().unwrap()["reason"],
            "proxy_restore_failed"
        );
        // 撤代理失败时不能继续停运行时，运行时保持原状态。
        assert_eq!(
            services.manager.status().await.state,
            crate::runtime::RuntimeState::Idle
        );
        // 备份仍在，下一次可以重试恢复。
        assert!(services.proxy.applied_endpoint().unwrap().is_some());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn aborting_a_connection_disables_the_proxy() {
        let dir = std::env::temp_dir().join(format!("veyl-proxy-{:016x}", rand::random::<u64>()));
        std::fs::create_dir_all(&dir).unwrap();
        let services = services_with_proxy(&dir, &SUCCEEDING);

        services.proxy.enable(1234).unwrap();
        ABORT_RESTORES.store(0, Ordering::SeqCst);

        let error = services.abort_connection(anyhow::anyhow!("runtime not running"));

        assert_eq!(
            ABORT_RESTORES.load(Ordering::SeqCst),
            1,
            "连接中止时必须撤掉可能还开着的代理"
        );
        assert!(error.to_string().contains("runtime not running"));
        let _ = std::fs::remove_dir_all(&dir);
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
mod rendered_config_tests {
    use super::*;

    fn write_rendered(dir: &std::path::Path, profile_id: &str) {
        std::fs::create_dir_all(dir).unwrap();
        std::fs::write(dir.join(format!("profile-{profile_id}.json")), "{}").unwrap();
        std::fs::write(
            dir.join(format!("profile-{profile_id}.meta.json")),
            "{}",
        )
        .unwrap();
    }

    #[test]
    fn the_guard_deletes_the_rendered_config_on_failure() {
        let dir =
            std::env::temp_dir().join(format!("veyl-guard-{:016x}", rand::random::<u64>()));
        write_rendered(&dir, "p1");

        {
            let _guard = RenderedConfigGuard::new(dir.clone(), "p1".to_string());
        }

        assert!(!dir.join("profile-p1.json").exists(), "失败路径必须删掉明文配置");
        assert!(!dir.join("profile-p1.meta.json").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_disarmed_guard_keeps_the_config_for_the_connection() {
        let dir =
            std::env::temp_dir().join(format!("veyl-guard-{:016x}", rand::random::<u64>()));
        write_rendered(&dir, "p1");

        RenderedConfigGuard::new(dir.clone(), "p1".to_string()).disarm();

        assert!(dir.join("profile-p1.json").exists(), "连接成功时配置要继续可用");
        let _ = std::fs::remove_dir_all(&dir);
    }
    #[tokio::test]
    async fn a_failed_install_leaves_no_rendered_config_behind() {
        let dir =
            std::env::temp_dir().join(format!("veyl-guard-{:016x}", rand::random::<u64>()));
        let config_dir = dir.join("config");
        std::fs::create_dir_all(&config_dir).unwrap();
        // 模拟上一轮遗留的元数据。
        std::fs::write(config_dir.join("profile-p1.meta.json"), "{}").unwrap();

        // guard 必须早于 install_profile 建立，它失败时才能清掉已落盘的文件。
        let guard = RenderedConfigGuard::new(config_dir.clone(), "p1".to_string());
        let result = vpn_config::install_profile(
            std::path::Path::new("/nonexistent/sing-box"),
            &config_dir,
            "p1",
            &serde_json::json!({}),
            None,
        )
        .await;
        assert!(result.is_err(), "无效二进制必须让安装失败");
        drop(guard);

        assert!(
            !config_dir.join("profile-p1.json").exists(),
            "安装失败后不能留明文配置"
        );
        assert!(
            !config_dir.join("profile-p1.meta.json").exists(),
            "安装失败后不能留元数据"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}

#[cfg(test)]
mod profile_shape_tests {
    use super::*;
    use std::path::Path;

    fn services(dir: &Path) -> WiredServices {
        let store = Arc::new(Store::open_in_memory().unwrap());
        let manager = crate::runtime::RuntimeManager::new(crate::runtime::RuntimeConfig::new(dir));
        let proxy = Arc::new(crate::proxy::ProxyController::new(Box::new(
            crate::proxy::backup::MemoryBackupStore::new(),
        )));
        let catalog = Arc::new(CatalogClient::new("http://127.0.0.1:9/v1"));
        WiredServices::new(store, manager, proxy, catalog, dir)
    }

    #[tokio::test]
    async fn profile_list_uses_profile_id_not_id() {
        let dir = std::env::temp_dir().join(format!("veyl-svc-{:016x}", rand::random::<u64>()));
        std::fs::create_dir_all(&dir).unwrap();
        let services = services(&dir);

        {
            let conn = services.store.conn();
            crate::store::profiles::create(
                &conn,
                &crate::store::NewProfile {
                    id: "prf_1",
                    node_id: Some("seed-jp-01"),
                    name: "东京 01",
                    protocol: Some("vless_reality"),
                    region: Some("jp"),
                    config: &serde_json::json!({ "server": "203.0.113.10" }),
                },
            )
            .unwrap();
        }

        let data = services.profile_list().await.unwrap();
        let first = &data["profiles"][0];
        assert_eq!(first["profile_id"], "prf_1");
        assert!(first.get("id").is_none(), "契约里叫 profile_id：{first}");
        for field in ["name", "node_id", "protocol", "region", "created_at", "is_active"] {
            assert!(first.get(field).is_some(), "缺少字段 {field}：{first}");
        }

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn switching_profiles_removes_only_the_previous_rendered_config() {
        let dir = std::env::temp_dir().join(format!("veyl-svc-{:016x}", rand::random::<u64>()));
        std::fs::create_dir_all(&dir).unwrap();
        let services = services(&dir);

        {
            let conn = services.store.conn();
            for (id, name) in [("prf_a", "A"), ("prf_b", "B")] {
                crate::store::profiles::create(
                    &conn,
                    &crate::store::NewProfile {
                        id,
                        node_id: None,
                        name,
                        protocol: Some("shadowsocks"),
                        region: None,
                        config: &serde_json::json!({}),
                    },
                )
                .unwrap();
            }
            crate::store::profiles::set_active(&conn, "prf_a").unwrap();
        }

        let config_dir = dir.join("config");
        std::fs::create_dir_all(&config_dir).unwrap();
        for id in ["prf_a", "prf_b"] {
            std::fs::write(config_dir.join(format!("profile-{id}.json")), "{}").unwrap();
            std::fs::write(
                config_dir.join(format!("profile-{id}.meta.json")),
                "{}",
            )
            .unwrap();
        }

        services.drop_previous_rendered_config("prf_b");

        assert!(
            !config_dir.join("profile-prf_a.json").exists(),
            "切换前那个 profile 的明文配置必须删掉"
        );
        assert!(!config_dir.join("profile-prf_a.meta.json").exists());
        assert!(
            config_dir.join("profile-prf_b.json").exists(),
            "目标 profile 自己不能被误删"
        );
        assert!(config_dir.join("profile-prf_b.meta.json").exists());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn profile_delete_reports_absence_and_active_profile() {
        let dir = std::env::temp_dir().join(format!("veyl-svc-{:016x}", rand::random::<u64>()));
        std::fs::create_dir_all(&dir).unwrap();
        let services = services(&dir);

        let data = services.profile_delete("prf_missing").await.unwrap();
        assert_eq!(data["profile_id"], "prf_missing");
        assert_eq!(data["deleted"], false);
        assert_eq!(data["already_absent"], true);
        assert!(data["active_profile_id"].is_null());

        let _ = std::fs::remove_dir_all(&dir);
    }
}
