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
        "contract_version": "1.0.8",
        "state": "idle",
        "mode": "system_proxy",
        "pid": null,
        "upstream_version": null,
        "uptime_seconds": null,
        "profile_id": null,
        "config_hash": null,
        "system_proxy_enabled": false,
        "health": {
            "contract_version": "1.0.8",
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
fn svc_error(code: impl std::fmt::Display, message: impl std::fmt::Display) -> anyhow::Error {
    anyhow::anyhow!("{code}: {message}")
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

    fn profile_config_path(&self, profile_id: &str) -> PathBuf {
        self.config_dir().join(format!("profile-{profile_id}.json"))
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
        let target = match profile_id {
            Some(id) => ConnectTarget::Profile(id),
            None => ConnectTarget::Profile(
                self.active_profile_id()
                    .ok_or_else(|| svc_error("PRECONDITION_FAILED", "没有活动配置"))?,
            ),
        };
        self.connect(target).await
    }

    async fn runtime_stop(&self, _force: bool) -> anyhow::Result<Value> {
        let _ = self.proxy.disable();
        self.manager.set_system_proxy_enabled(false).await;
        let status = self
            .manager
            .stop()
            .await
            .map_err(|e| svc_error(e.code(), e))?;
        let conn = self.store.conn();
        let _ = crate::store::profiles::clear_active(&conn);
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
        let query = crate::catalog::NodeQuery {
            region: query.region,
            protocol: query.protocol.as_deref().and_then(|value| match value {
                "vless_reality" => Some(crate::catalog::NodeProtocol::VlessReality),
                "hysteria2" => Some(crate::catalog::NodeProtocol::Hysteria2),
                _ => None,
            }),
            limit: query.limit.map(|limit| limit.min(50) as u8),
            cursor: query.cursor,
        };
        let response = self.catalog_list(&query).await?;
        Ok(json!({
            "nodes": response.nodes,
            "next_cursor": response.next_cursor,
            "fetched_at": response.fetched_at,
        }))
    }

    async fn profile_list(&self) -> anyhow::Result<Value> {
        let conn = self.store.conn();
        let profiles = crate::store::profiles::list(&conn).map_err(|e| svc_error(e.code(), e))?;
        let items: Vec<Value> = profiles
            .iter()
            .map(|profile| {
                json!({
                    "id": profile.id,
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

        if created {
            // 顺手把完整配置（含凭据）写到 0600 磁盘文件，下次离线也能连。
            if let Ok(Some(installed)) = self.installer.active() {
                let _ = self
                    .write_profile_config(&installed, &id, &detail.node, Some(&detail.etag))
                    .await;
            }
        }

        Ok(json!({ "profile_id": id, "name": display, "created": created }))
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
        {
            let conn = self.store.conn();
            crate::store::profiles::delete(&conn, profile_id)
                .map_err(|e| svc_error(e.code(), e))?;
        }
        Ok(json!({ "deleted": true }))
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
        let proxy = self.proxy.status().ok();
        let logs = if include_logs {
            self.runtime_logs(50, None).await?.get("lines").cloned()
        } else {
            None
        };
        Ok(json!({
            "runtime": status,
            "system_proxy": proxy,
            "logs": logs,
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
}


impl WiredServices {
    /// 目录详情 → 生成配置 → 写到 config/profile-<id>.json（0600）→ sing-box check。
    async fn write_profile_config(
        &self,
        installed: &crate::runtime::InstalledRuntime,
        profile_id: &str,
        node: &crate::catalog::NodeDescriptor,
        etag: Option<&str>,
    ) -> anyhow::Result<PathBuf> {
        let mixed_port = vpn_config::pick_free_port().map_err(|e| svc_error(e.code(), e))?;
        let clash_port = vpn_config::pick_free_port().map_err(|e| svc_error(e.code(), e))?;
        let secret = vpn_config::random_secret();

        let input = node
            .clone()
            .into_build_input(mixed_port, clash_port, secret)
            .map_err(|e| svc_error(e.code(), e))?;
        let value = vpn_config::build(&input).map_err(|e| svc_error(e.code(), e))?;

        vpn_config::install_profile(&installed.binary, &self.config_dir(), profile_id, &value, etag)
            .await
            .map_err(|e| svc_error(e.code(), e))
    }

    /// 连接：优先用磁盘上已渲染的完整配置（含凭据，0600），没有才联网重拉。
    async fn connect(&self, target: ConnectTarget) -> anyhow::Result<Value> {
        let profile = self.resolve_profile(&target)?;
        let installed = self.ensure_runtime_installed()?;

        let config_path = self.profile_config_path(&profile.id);
        let path = if config_path.is_file() {
            config_path
        } else {
            let node_id = profile.node_id.clone().ok_or_else(|| {
                svc_error(
                    "PRECONDITION_FAILED",
                    "本地没有可用配置，需要联网刷新一次",
                )
            })?;
            let detail = self
                .catalog
                .node_detail(&node_id)
                .await
                .map_err(|e| svc_error(e.code.clone(), e))?;
            self.write_profile_config(&installed, &profile.id, &detail.node, Some(&detail.etag))
                .await?
        };

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
            profile_id: Some(profile.id.clone()),
        };

        let status = self
            .manager
            .start(plan)
            .await
            .map_err(|e| svc_error(e.code(), e))?;

        if let Err(error) = self.proxy.enable(mixed_port) {
            let _ = self.manager.stop().await;
            return Err(svc_error("INTERNAL", format!("设置系统代理失败：{error}")));
        }
        self.manager.set_system_proxy_enabled(true).await;

        {
            let conn = self.store.conn();
            let _ = crate::store::profiles::set_active(&conn, &profile.id);
        }

        serde_json::to_value(status).map_err(|e| svc_error("INTERNAL", e))
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
