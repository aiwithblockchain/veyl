pub mod backup;
pub mod lease;
pub mod recovery;

#[cfg(target_os = "macos")]
pub mod guard;
#[cfg(target_os = "macos")]
pub mod guard_launch;
#[cfg(target_os = "macos")]
pub mod macos_wire;

#[cfg(target_os = "macos")]
mod macos;
#[cfg(windows)]
mod windows;

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;

use crate::runtime::RuntimeError;
use crate::runtime::RuntimeResult;
use backup::{BackupStore, Endpoint, FileBackupStore, ProxyBackup};
use lease::{
    FileLock, LeasePaths, ProxyLease, RecoveryReport, RecoverySource, RecoveryStatus,
};
use recovery::{decide, Decision};

pub use backup::{BackupStore as ProxyBackupStore, Endpoint as ProxyEndpoint, ProxyBackup as ProxyBackupSnapshot, SqliteBackupStore};
pub use lease::RecoveryReport as ProxyRecoveryReport;

pub trait PlatformProxy: Send + Sync {
    fn platform(&self) -> &'static str;
    fn capture(&self) -> RuntimeResult<serde_json::Value>;
    fn apply(&self, port: u16) -> RuntimeResult<()>;
    fn restore(&self, payload: &serde_json::Value) -> RuntimeResult<()>;
    fn current(&self) -> RuntimeResult<Option<String>>;

    /// 当前所有已启用的系统代理端点（`server:port`）。退出前用它确认
    /// 我们写进去的端口已经没有任何服务在用。默认只查主代理。
    fn active_endpoints(&self) -> RuntimeResult<Vec<String>> {
        Ok(self.current()?.into_iter().collect())
    }

    /// 备份载荷里的「原始状态」在 `current()` 口径下的读数。
    /// 平台实现负责解析各自的载荷；解析不了就返回 `None`（按用户改过处理）。
    fn original_endpoint(&self, _payload: &serde_json::Value) -> Option<String> {
        None
    }
}

#[cfg(target_os = "macos")]
fn backend() -> &'static dyn PlatformProxy {
    &macos::MacProxy
}

#[cfg(windows)]
fn backend() -> &'static dyn PlatformProxy {
    &windows::WindowsProxy
}

#[cfg(not(any(target_os = "macos", windows)))]
struct UnsupportedProxy;

#[cfg(not(any(target_os = "macos", windows)))]
impl PlatformProxy for UnsupportedProxy {
    fn platform(&self) -> &'static str {
        std::env::consts::OS
    }

    fn capture(&self) -> RuntimeResult<serde_json::Value> {
        Ok(serde_json::Value::Null)
    }

    fn apply(&self, _port: u16) -> RuntimeResult<()> {
        Err(crate::runtime::RuntimeError::Proxy(format!(
            "system proxy is not supported on {}",
            std::env::consts::OS
        )))
    }

    fn restore(&self, _payload: &serde_json::Value) -> RuntimeResult<()> {
        Ok(())
    }

    fn current(&self) -> RuntimeResult<Option<String>> {
        Ok(None)
    }
}

#[cfg(not(any(target_os = "macos", windows)))]
fn backend() -> &'static dyn PlatformProxy {
    &UnsupportedProxy
}

#[derive(Debug, Clone, Serialize)]
pub struct ProxyStatus {
    pub platform: String,
    pub current: Option<String>,
    pub endpoint: Option<String>,
    pub has_backup: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum RecoveryOutcome {
    Nothing,
    Recovered { endpoint: String },
    LeftAlone { current: String, endpoint: String },
}

pub struct ProxyController {
    store: Box<dyn BackupStore>,
    backend: &'static dyn PlatformProxy,
    /// `None` = 不写租约（测试与旧构造路径）；`Some` = 生产路径。
    lease: Option<LeasePaths>,
    /// 拿到后全程持有：看门狗靠它判断 App 死没死。
    lease_lock: Mutex<Option<FileLock>>,
    /// 每次 `enable()` 安装/唤醒 LaunchAgent。测试为 false。
    #[cfg(target_os = "macos")]
    install_guard: bool,
}

impl ProxyController {
    pub fn new(store: Box<dyn BackupStore>) -> Self {
        Self {
            store,
            backend: backend(),
            lease: None,
            lease_lock: Mutex::new(None),
            #[cfg(target_os = "macos")]
            install_guard: false,
        }
    }

    pub fn with_file_store(app_data_dir: impl AsRef<Path>) -> Self {
        Self::new(Box::new(FileBackupStore::in_app_data(app_data_dir)))
    }

    pub fn with_backend(store: Box<dyn BackupStore>, backend: &'static dyn PlatformProxy) -> Self {
        Self {
            store,
            backend,
            lease: None,
            lease_lock: Mutex::new(None),
            #[cfg(target_os = "macos")]
            install_guard: false,
        }
    }

    /// 生产路径：租约与恢复报告落在 `~/.veyl`。
    pub fn with_lease(mut self, app_data_dir: impl Into<PathBuf>) -> Self {
        self.lease = Some(LeasePaths::in_dir(app_data_dir));
        self
    }

    /// 每次 `enable()` 安装并唤醒用户级看门狗（只在正式路径启用）。
    #[cfg(target_os = "macos")]
    pub fn with_guard(mut self) -> Self {
        self.install_guard = true;
        self
    }

    pub fn platform(&self) -> &'static str {
        self.backend.platform()
    }

    /// 首次启用时先备份；重复调用不会覆盖原始备份。
    ///
    /// 固定顺序（设计 §2.3）：`capture() → 写表 → flock → 写租约 → apply()`。
    /// 任一步崩溃都有兜底：没有租约时看门狗不动；下次启动按表恢复。
    pub fn enable(&self, port: u16) -> RuntimeResult<()> {
        let endpoint = Endpoint::loopback(port);
        if self.store.load()?.is_none() {
            let payload = self.backend.capture()?;
            self.store.save(&ProxyBackup::new(
                self.backend.platform(),
                endpoint.clone(),
                payload,
            ))?;
        }

        if let Some(paths) = &self.lease {
            self.ensure_lease_lock(paths)?;
            let mut backup = self.store.load()?.ok_or_else(|| {
                RuntimeError::Proxy("代理备份在写租约前消失了".into())
            })?;
            // 端口回退后重新连接时，表里可能还是上一次的端点。租约和表都
            // 必须记录「这次真正写进去的端点」，否则看门狗会把当前值当成用户改的。
            if backup.applied != endpoint {
                backup.applied = endpoint.clone();
                if let Err(error) = self.store.save(&backup) {
                    log::warn!("更新代理备份端点失败：{error}");
                }
            }
            let lease = ProxyLease::new(
                backup.platform.clone(),
                endpoint.to_string(),
                backup.payload.clone(),
            );
            if let Err(error) = lease::write_lease(&paths.lease(), &lease) {
                // 租约写不出来只影响「崩溃后 2 秒内恢复」，不阻断连接；
                // `proxy_backup` 表仍能覆盖下次启动。
                log::warn!("写代理租约失败，崩溃后只能等下次启动恢复：{error}");
            }
            #[cfg(target_os = "macos")]
            if self.install_guard {
                if let Err(error) = guard_launch::ensure_running(paths.dir()) {
                    log::warn!("注册代理看门狗失败，崩溃后只能等下次启动恢复：{error}");
                }
            }
        }

        self.backend.apply(port)
    }

    pub fn disable(&self) -> RuntimeResult<()> {
        // 仅 debug 构建：验收「退出时撤代理失败必须中止退出」用的故障注入。
        // release 构建里整段被编掉，运行时完全不认这个变量。
        #[cfg(debug_assertions)]
        if std::env::var("VEYL_FAULT_PROXY_DISABLE").ok().as_deref() == Some("1") {
            log::warn!(
                "故障注入已生效：VEYL_FAULT_PROXY_DISABLE=1，disable() 直接失败且未执行任何 networksetup"
            );
            return Err(RuntimeError::Proxy(
                "fault injection: VEYL_FAULT_PROXY_DISABLE=1".into(),
            ));
        }

        let Some(backup) = self.store.load()? else {
            self.remove_lease();
            return Ok(());
        };

        // restore → 校验 → 清表 → 删租约。中途失败时租约还在，看门狗会重放一次。
        self.backend.restore(&backup.payload)?;
        let endpoint = backup.applied.to_string();
        if self
            .backend
            .active_endpoints()?
            .iter()
            .any(|value| value == &endpoint)
        {
            return Err(RuntimeError::Proxy(format!(
                "{endpoint} 仍被网络服务使用"
            )));
        }
        self.store.clear()?;
        self.remove_lease();
        Ok(())
    }

    /// 我们最近一次写进系统的代理端点；没有备份时为 `None`。
    pub fn applied_endpoint(&self) -> RuntimeResult<Option<Endpoint>> {
        Ok(self.store.load()?.map(|backup| backup.applied))
    }

    /// 仍在使用指定端点的网络服务列表。退出流程用它做「确实已恢复」的校验。
    pub fn endpoint_in_use(&self, endpoint: &Endpoint) -> RuntimeResult<Vec<String>> {
        let target = endpoint.to_string();
        Ok(self
            .backend
            .active_endpoints()?
            .into_iter()
            .filter(|value| value == &target)
            .collect())
    }

    /// 当前系统代理端点（`server:port`），用于修复后的复读校验。
    pub fn current_endpoint(&self) -> RuntimeResult<Option<String>> {
        self.backend.current()
    }

    /// 只按 `proxy_backup` 表恢复（旧的入口，测试与 `recover_after_crash` 在用）。
    ///
    /// 生产启动路径用 [`recover_on_startup`](Self::recover_on_startup)：
    /// 它先消费看门狗报告、优先用租约，再回落到这张表。
    pub fn recover_stale(&self) -> RuntimeResult<RecoveryOutcome> {
        let Some(backup) = self.store.load()? else {
            return Ok(RecoveryOutcome::Nothing);
        };
        let report = self.attempt_recovery(
            self.lease.as_ref(),
            RecoveryInput::Backup(backup),
            RecoverySource::Startup,
            false,
        )?;
        Ok(match report.status {
            RecoveryStatus::Restored => RecoveryOutcome::Recovered {
                endpoint: report.endpoint,
            },
            RecoveryStatus::AlreadyRestored => RecoveryOutcome::Nothing,
            RecoveryStatus::LeftAlone => RecoveryOutcome::LeftAlone {
                current: report.current.unwrap_or_default(),
                endpoint: report.endpoint,
            },
            RecoveryStatus::Failed => {
                return Err(RuntimeError::Proxy(
                    report
                        .error
                        .unwrap_or_else(|| "系统代理恢复失败".into()),
                ))
            }
        })
    }

    /// 启动时的完整恢复（设计 §4.1）：先锁、再读报告、再租约优先 / 表兜底。
    ///
    /// 返回本次启动的恢复结果给界面；**不落报告文件**（启动恢复当下就有
    /// App 在跑，写文件只会在正常退出后留下过期报告，下次启动误报）。
    pub fn recover_on_startup(&self) -> RuntimeResult<Option<RecoveryReport>> {
        let Some(paths) = &self.lease else {
            return Ok(match self.recover_stale()? {
                RecoveryOutcome::Nothing => None,
                RecoveryOutcome::Recovered { endpoint } => Some(RecoveryReport::new(
                    RecoveryStatus::Restored,
                    endpoint,
                    self.backend.current().ok().flatten(),
                    None,
                    RecoverySource::Startup,
                )),
                RecoveryOutcome::LeftAlone { current, endpoint } => Some(RecoveryReport::new(
                    RecoveryStatus::LeftAlone,
                    endpoint,
                    Some(current),
                    None,
                    RecoverySource::Startup,
                )),
            });
        };

        // 1. 拿锁：拿不到说明看门狗正在收尸。它要跑约 18 次 networksetup，
        //    3 秒可能不够；超时后再等一轮，避免两边并发恢复，也避免它随后
        //    写出的报告漏在磁盘上、被下次正常启动误读。
        let lock_held = match self.ensure_lease_lock(paths) {
            Ok(()) => true,
            Err(error) => {
                log::warn!("启动时未拿到代理租约锁（看门狗可能仍在还原），再等一轮：{error}");
                match self.ensure_lease_lock(paths) {
                    Ok(()) => true,
                    Err(error) => {
                        log::warn!("仍未拿到代理租约锁，继续恢复；稍后会清掉迟到的报告：{error}");
                        false
                    }
                }
            }
        };

        // 2. 读看门狗留下的报告，并按它处理备份表。
        let prior = match lease::take_report(&paths.report()) {
            Ok(report) => report,
            Err(error) => {
                log::warn!("读取代理恢复报告失败：{error}");
                None
            }
        };
        let mut table_settled = false;
        if let Some(report) = &prior {
            match report.status {
                RecoveryStatus::Restored | RecoveryStatus::AlreadyRestored => {
                    self.store.clear()?;
                    table_settled = true;
                }
                RecoveryStatus::LeftAlone => {
                    // 归档是证据，不是前置条件：写不进去也必须清表（§4.2）。
                    if let Err(error) = self.archive_table_backup(paths) {
                        log::warn!("归档 LeftAlone 备份失败（继续清表）：{error}");
                    }
                    self.store.clear()?;
                    table_settled = true;
                }
                RecoveryStatus::Failed => {}
            }
        }

        // 3. 租约优先，表兜底。
        let input = match lease::read_lease(&paths.lease()) {
            Ok(Some(entry)) => Some(RecoveryInput::Lease(entry)),
            Ok(None) => {
                if table_settled {
                    None
                } else {
                    self.store.load()?.map(RecoveryInput::Backup)
                }
            }
            Err(error) => {
                // 租约损坏：删掉它，交给表（表是应用侧事实源）。
                log::warn!("读代理租约失败，改按备份表恢复：{error}");
                let _ = lease::remove_if_exists(&paths.lease());
                self.store.load()?.map(RecoveryInput::Backup)
            }
        };

        let outcome = (|| -> RuntimeResult<Option<RecoveryReport>> {
            let Some(input) = input else {
                return Ok(prior);
            };
            let report = self.attempt_recovery(
                Some(paths),
                input,
                RecoverySource::Startup,
                false,
            )?;
            if let Some(prior) = prior {
                // 第二步已经确认过一次，这次只是幂等复读；保留信息量更大的那份。
                if prior.status != RecoveryStatus::Failed
                    && report.status == RecoveryStatus::AlreadyRestored
                {
                    return Ok(Some(prior));
                }
            }
            Ok(Some(report))
        })();

        // 没拿到锁：看门狗可能在我们处理完之后才写完报告。它描述的是同一场崩溃，
        // App 已经自己恢复过；这份报告若留到下次启动，就会在正常退出后误弹提示。
        if !lock_held {
            drain_late_reports(paths);
        }
        outcome
    }

    /// `SIGTERM` / `SIGINT` / `SIGHUP` 的进程内兜底：按同一套判定还原一次。
    /// 结果写报告文件，供下次启动提示（看门狗没跑或被信号打断时）。
    pub fn recover_on_signal(&self) -> RuntimeResult<Option<RecoveryReport>> {
        let Some(paths) = &self.lease else {
            return Ok(None);
        };
        let input = match lease::read_lease(&paths.lease()) {
            Ok(Some(entry)) => Some(RecoveryInput::Lease(entry)),
            Ok(None) => self.store.load()?.map(RecoveryInput::Backup),
            Err(error) => {
                log::warn!("信号清理读到损坏的租约，改按备份表恢复：{error}");
                let _ = lease::remove_if_exists(&paths.lease());
                self.store.load()?.map(RecoveryInput::Backup)
            }
        };
        let Some(input) = input else {
            return Ok(None);
        };
        let report =
            self.attempt_recovery(Some(paths), input, RecoverySource::Signal, true)?;
        Ok(Some(report))
    }

    pub fn status(&self) -> RuntimeResult<ProxyStatus> {
        let backup = self.store.load()?;
        Ok(ProxyStatus {
            platform: self.backend.platform().to_string(),
            current: self.backend.current()?,
            endpoint: backup.as_ref().map(|b| b.applied.to_string()),
            has_backup: backup.is_some(),
        })
    }

    fn ensure_lease_lock(&self, paths: &LeasePaths) -> RuntimeResult<()> {
        self.ensure_lease_lock_for(paths, Duration::from_secs(3))
    }

    fn ensure_lease_lock_for(&self, paths: &LeasePaths, timeout: Duration) -> RuntimeResult<()> {
        let mut held = self
            .lease_lock
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if held.is_some() {
            return Ok(());
        }
        match FileLock::exclusive_with_timeout(&paths.lease_lock(), timeout) {
            Ok(Some(lock)) => {
                *held = Some(lock);
                Ok(())
            }
            Ok(None) => Err(RuntimeError::Proxy(
                "代理看门狗仍在还原上次的系统代理，请稍后重试".into(),
            )),
            Err(error) => Err(RuntimeError::Proxy(format!(
                "获取代理租约锁失败：{error}"
            ))),
        }
    }

    /// 失败报告里的 `current`：契约 §7.13 要求它是「失败那刻的值」。
    fn current_now(&self) -> Option<String> {
        self.backend.current().ok().flatten()
    }

    fn remove_lease(&self) {
        let Some(paths) = &self.lease else {
            return;
        };
        if let Err(error) = lease::remove_if_exists(&paths.lease()) {
            log::warn!("删除代理租约失败：{error}");
        }
    }

    /// 恢复的核心：判定 → 还原/保留 → 清表删租约 → 出报告。
    ///
    /// 看门狗与启动/信号恢复都走这一份（看门狗直接调 `recovery::decide`，
    /// 通过 `guard::check_once`）；这里只负责 App 侧对 `proxy_backup` 的收尾。
    fn attempt_recovery(
        &self,
        paths: Option<&LeasePaths>,
        input: RecoveryInput,
        source: RecoverySource,
        write_report_file: bool,
    ) -> RuntimeResult<RecoveryReport> {
        let (payload, endpoint, platform) = match &input {
            RecoveryInput::Lease(entry) => (
                entry.payload.clone(),
                entry.endpoint.clone(),
                entry.platform.clone(),
            ),
            RecoveryInput::Backup(backup) => (
                backup.payload.clone(),
                backup.applied.to_string(),
                backup.platform.clone(),
            ),
        };

        let current = match self.backend.current() {
            Ok(current) => current,
            Err(error) => {
                return Ok(RecoveryReport::new(
                    RecoveryStatus::Failed,
                    endpoint,
                    None,
                    Some(format!("读取系统代理失败：{error}")),
                    source,
                ))
            }
        };
        let original = self.backend.original_endpoint(&payload);

        let report = match decide(current.as_deref(), original.as_deref(), &endpoint) {
            Decision::Restored => match self.backend.restore(&payload) {
                Ok(()) => match self.backend.active_endpoints() {
                    Ok(endpoints) if !endpoints.iter().any(|value| value == &endpoint) => {
                        self.retire(paths, &input)?;
                        RecoveryReport::new(
                            RecoveryStatus::Restored,
                            endpoint,
                            self.backend.current().ok().flatten(),
                            None,
                            source,
                        )
                    }
                    Ok(_) => RecoveryReport::new(
                        RecoveryStatus::Failed,
                        endpoint.clone(),
                        self.current_now(),
                        Some(format!("还原后 {endpoint} 仍被网络服务使用")),
                        source,
                    ),
                    Err(error) => RecoveryReport::new(
                        RecoveryStatus::Failed,
                        endpoint.clone(),
                        self.current_now(),
                        Some(format!("校验系统代理失败：{error}")),
                        source,
                    ),
                },
                Err(error) => RecoveryReport::new(
                    RecoveryStatus::Failed,
                    endpoint.clone(),
                    self.current_now(),
                    Some(format!("还原系统代理失败：{error}")),
                    source,
                ),
            },
            Decision::AlreadyRestored => {
                self.retire(paths, &input)?;
                RecoveryReport::new(
                    RecoveryStatus::AlreadyRestored,
                    endpoint,
                    current,
                    None,
                    source,
                )
            }
            Decision::LeftAlone { current } => {
                if let Some(paths) = paths {
                    // 归档失败不能挡住清表（§4.2 修正必须生效）。
                    if let Err(error) = self.archive_left_alone(paths, &input, &platform) {
                        log::warn!("归档 LeftAlone 备份失败（继续清表）：{error}");
                    }
                }
                self.retire(paths, &input)?;
                RecoveryReport::new(
                    RecoveryStatus::LeftAlone,
                    endpoint,
                    current,
                    None,
                    source,
                )
            }
        };

        if write_report_file {
            if let Some(paths) = paths {
                if let Err(error) = lease::write_report(&paths.report(), &report) {
                    log::warn!("写代理恢复报告失败：{error}");
                }
            }
        }
        Ok(report)
    }

    /// 备份已经有了结论：清表、删租约。`failed` 不会走到这里。
    fn retire(&self, paths: Option<&LeasePaths>, input: &RecoveryInput) -> RuntimeResult<()> {
        self.store.clear()?;
        if let Some(paths) = paths {
            if matches!(input, RecoveryInput::Lease(_)) {
                lease::remove_if_exists(&paths.lease()).map_err(|error| {
                    RuntimeError::State(format!("删除代理租约失败：{error}"))
                })?;
            } else {
                // 表兜底时也可能留着一个坏租约，一并清掉。
                let _ = lease::remove_if_exists(&paths.lease());
            }
        }
        Ok(())
    }

    /// §4.2：`LeftAlone` 时把旧备份移走后清表，避免下次断开时覆盖用户的新设置。
    fn archive_left_alone(
        &self,
        paths: &LeasePaths,
        input: &RecoveryInput,
        platform: &str,
    ) -> RuntimeResult<()> {
        let backup = match input {
            RecoveryInput::Backup(backup) => Some(backup.clone()),
            RecoveryInput::Lease(entry) => self.store.load()?.or_else(|| {
                Endpoint::parse(&entry.endpoint).map(|applied| {
                    ProxyBackup::new(platform.to_string(), applied, entry.payload.clone())
                })
            }),
        };
        match backup {
            Some(backup) => write_left_alone(paths, &backup),
            None => Ok(()),
        }
    }

    /// 表格兜底的 `LeftAlone`：把表里的备份归档后清表。
    fn archive_table_backup(&self, paths: &LeasePaths) -> RuntimeResult<()> {
        match self.store.load()? {
            Some(backup) => write_left_alone(paths, &backup),
            None => Ok(()),
        }
    }
}

/// 拿锁超时后清掉看门狗「迟到」的报告。
///
/// 这种报告描述的是启动时同一场崩溃，App 已经自己恢复过；若留到下一次启动，
/// 就会在一次正常退出之后误弹「上次没退出干净」。立即清一次，再用一个短线程
/// 兜住「恰好晚于这次清理」的写入（看门狗写完报告才放锁，之后不会再有新报告）。
fn drain_late_reports(paths: &LeasePaths) {
    match lease::take_report(&paths.report()) {
        Ok(Some(report)) => log::warn!("丢弃看门狗迟到的恢复报告：{:?}", report.status),
        Ok(None) => {}
        Err(error) => log::warn!("清理迟到的代理恢复报告失败：{error}"),
    }

    let report_path = paths.report();
    std::thread::spawn(move || {
        for delay in [2u64, 5, 10] {
            std::thread::sleep(Duration::from_secs(delay));
            match lease::take_report(&report_path) {
                Ok(Some(report)) => {
                    log::warn!("丢弃看门狗迟到的恢复报告：{:?}", report.status);
                    return;
                }
                Ok(None) => {}
                Err(error) => {
                    log::warn!("清理迟到的代理恢复报告失败：{error}");
                    return;
                }
            }
        }
    });
}

fn write_left_alone(paths: &LeasePaths, backup: &ProxyBackup) -> RuntimeResult<()> {
    let bytes = serde_json::to_vec_pretty(backup)
        .map_err(|error| RuntimeError::State(format!("序列化左置备份失败：{error}")))?;
    lease::write_atomic_private(&paths.left_alone(), &bytes)
        .map_err(|error| RuntimeError::State(format!("归档左置备份失败：{error}")))
}

enum RecoveryInput {
    Lease(ProxyLease),
    Backup(ProxyBackup),
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use super::*;

    struct Fake {
        current: Mutex<Option<String>>,
        applied: Mutex<Vec<u16>>,
        fail_apply: bool,
        lease_path: Mutex<Option<PathBuf>>,
        lease_seen_at_apply: Mutex<bool>,
    }

    impl Fake {
        fn new(current: Option<&str>) -> Self {
            Self {
                current: Mutex::new(current.map(str::to_string)),
                applied: Mutex::new(vec![]),
                fail_apply: false,
                lease_path: Mutex::new(None),
                lease_seen_at_apply: Mutex::new(false),
            }
        }
    }

    impl PlatformProxy for Fake {
        fn platform(&self) -> &'static str {
            "fake"
        }

        fn capture(&self) -> RuntimeResult<serde_json::Value> {
            Ok(serde_json::json!({ "original": self.current.lock().unwrap().clone() }))
        }

        fn apply(&self, port: u16) -> RuntimeResult<()> {
            if self.fail_apply {
                return Err(crate::runtime::RuntimeError::Proxy("denied".into()));
            }
            *self.lease_seen_at_apply.lock().unwrap() = self
                .lease_path
                .lock()
                .unwrap()
                .as_ref()
                .map(|path| path.exists())
                .unwrap_or(false);
            self.applied.lock().unwrap().push(port);
            *self.current.lock().unwrap() = Some(format!("127.0.0.1:{port}"));
            Ok(())
        }

        fn restore(&self, payload: &serde_json::Value) -> RuntimeResult<()> {
            let original = payload
                .get("original")
                .and_then(|v| v.as_str())
                .map(str::to_string);
            *self.current.lock().unwrap() = original;
            Ok(())
        }

        fn current(&self) -> RuntimeResult<Option<String>> {
            Ok(self.current.lock().unwrap().clone())
        }

        fn original_endpoint(&self, payload: &serde_json::Value) -> Option<String> {
            payload.get("original").and_then(|v| v.as_str()).map(str::to_string)
        }
    }

    fn controller(fake: &'static Fake) -> ProxyController {
        ProxyController::with_backend(Box::new(backup::MemoryBackupStore::new()), fake)
    }

    fn temp_dir(tag: &str) -> PathBuf {
        std::env::temp_dir().join(format!("veyl-proxy-{tag}-{:016x}", rand::random::<u64>()))
    }

    #[test]
    fn enabling_then_disabling_restores_the_original() {
        let fake = Box::leak(Box::new(Fake::new(Some("corp-proxy:8080"))));
        let ctrl = controller(fake);

        ctrl.enable(2080).unwrap();
        assert_eq!(fake.current().unwrap().as_deref(), Some("127.0.0.1:2080"));
        assert!(ctrl.status().unwrap().has_backup);

        ctrl.disable().unwrap();
        assert_eq!(fake.current().unwrap().as_deref(), Some("corp-proxy:8080"));
        assert!(!ctrl.status().unwrap().has_backup);
    }

    #[test]
    fn enabling_twice_keeps_the_first_backup() {
        let fake = Box::leak(Box::new(Fake::new(Some("corp-proxy:8080"))));
        let ctrl = controller(fake);

        ctrl.enable(2080).unwrap();
        ctrl.enable(2090).unwrap();
        ctrl.disable().unwrap();
        assert_eq!(fake.current().unwrap().as_deref(), Some("corp-proxy:8080"));
    }

    #[test]
    fn recovery_leaves_user_changes_alone() {
        let fake = Box::leak(Box::new(Fake::new(Some("corp-proxy:8080"))));
        let ctrl = controller(fake);
        ctrl.enable(2080).unwrap();
        *fake.current.lock().unwrap() = Some("user-proxy:3128".into());

        let outcome = ctrl.recover_stale().unwrap();
        assert_eq!(
            outcome,
            RecoveryOutcome::LeftAlone {
                current: "user-proxy:3128".into(),
                endpoint: "127.0.0.1:2080".into()
            }
        );
        assert_eq!(fake.current().unwrap().as_deref(), Some("user-proxy:3128"));
        // §4.2：用户改过之后旧备份必须作废，不能再覆盖用户的新设置。
        assert!(!ctrl.status().unwrap().has_backup);
    }

    #[test]
    fn recovery_restores_our_own_leftover() {
        let fake = Box::leak(Box::new(Fake::new(None)));
        let ctrl = controller(fake);
        ctrl.enable(2080).unwrap();

        let outcome = ctrl.recover_stale().unwrap();
        assert_eq!(
            outcome,
            RecoveryOutcome::Recovered {
                endpoint: "127.0.0.1:2080".into()
            }
        );
        assert_eq!(fake.current().unwrap(), None);
    }

    #[test]
    fn a_leftover_backup_in_sqlite_is_recovered_on_startup() {
        use std::sync::Arc;

        let store = Arc::new(crate::store::Store::open_in_memory().unwrap());
        let fake = Box::leak(Box::new(Fake::new(Some("corp-proxy:8080"))));

        let first = ProxyController::with_backend(
            Box::new(crate::proxy::SqliteBackupStore::new(Arc::clone(&store))),
            fake,
        );
        first.enable(2080).unwrap();
        assert_eq!(fake.current().unwrap().as_deref(), Some("127.0.0.1:2080"));
        // 模拟异常退出：不调用 disable，直接构造新的控制器走启动恢复。
        drop(first);

        let second = ProxyController::with_backend(
            Box::new(crate::proxy::SqliteBackupStore::new(store)),
            fake,
        );
        assert_eq!(
            second.recover_stale().unwrap(),
            RecoveryOutcome::Recovered {
                endpoint: "127.0.0.1:2080".into()
            }
        );
        assert_eq!(fake.current().unwrap().as_deref(), Some("corp-proxy:8080"));
        assert!(!second.status().unwrap().has_backup);
    }

    #[test]
    fn recovery_clears_a_backup_when_proxy_is_already_off() {
        let mut fake = Fake::new(None);
        fake.fail_apply = true;
        let fake = Box::leak(Box::new(fake));
        let ctrl = controller(fake);
        assert!(ctrl.enable(2080).is_err());
        assert_eq!(ctrl.recover_stale().unwrap(), RecoveryOutcome::Nothing);
        assert!(!ctrl.status().unwrap().has_backup);
    }

    #[test]
    fn endpoint_in_use_follows_the_applied_endpoint() {
        let fake = Box::leak(Box::new(Fake::new(None)));
        let ctrl = controller(fake);
        ctrl.enable(4321).unwrap();

        assert_eq!(
            ctrl.applied_endpoint().unwrap(),
            Some(Endpoint::loopback(4321))
        );
        assert_eq!(
            ctrl.endpoint_in_use(&Endpoint::loopback(4321)).unwrap().len(),
            1
        );
        assert!(ctrl
            .endpoint_in_use(&Endpoint::loopback(9999))
            .unwrap()
            .is_empty());

        ctrl.disable().unwrap();
        assert!(ctrl
            .endpoint_in_use(&Endpoint::loopback(4321))
            .unwrap()
            .is_empty());
    }

    #[test]
    fn the_lease_is_written_before_apply_and_removed_after_disable() {
        let dir = temp_dir("lease-order");
        let paths = LeasePaths::in_dir(&dir);
        let fake = Box::leak(Box::new(Fake::new(Some("corp-proxy:8080"))));
        *fake.lease_path.lock().unwrap() = Some(paths.lease());
        let ctrl = controller(fake).with_lease(&dir);

        ctrl.enable(2080).unwrap();
        assert!(
            *fake.lease_seen_at_apply.lock().unwrap(),
            "apply 之前必须已经写好租约"
        );
        let lease = lease::read_lease(&paths.lease()).unwrap().unwrap();
        assert_eq!(lease.endpoint, "127.0.0.1:2080");

        ctrl.disable().unwrap();
        assert!(!paths.lease().exists(), "正常断开后租约必须删除");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn left_alone_archives_the_backup_and_clears_the_table() {
        let dir = temp_dir("left-alone");
        let paths = LeasePaths::in_dir(&dir);
        let fake = Box::leak(Box::new(Fake::new(Some("corp-proxy:8080"))));
        let ctrl = controller(fake).with_lease(&dir);
        ctrl.enable(2080).unwrap();
        *fake.current.lock().unwrap() = Some("user-proxy:3128".into());
        // 模拟崩溃：把租约写出来。
        let backup = ctrl.store.load().unwrap().unwrap();
        lease::write_lease(
            &paths.lease(),
            &ProxyLease::new("fake", "127.0.0.1:2080", backup.payload),
        )
        .unwrap();

        let report = ctrl.recover_on_startup().unwrap().unwrap();
        assert_eq!(report.status, RecoveryStatus::LeftAlone);
        assert_eq!(report.current.as_deref(), Some("user-proxy:3128"));
        assert!(paths.left_alone().exists(), "旧备份必须留证据");
        assert!(!ctrl.status().unwrap().has_backup, "旧备份必须作废");
        assert!(!paths.lease().exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn startup_consumes_the_watchdog_report_and_clears_the_backup() {
        let dir = temp_dir("watchdog-report");
        let paths = LeasePaths::in_dir(&dir);
        let fake = Box::leak(Box::new(Fake::new(Some("corp-proxy:8080"))));
        let ctrl = controller(fake).with_lease(&dir);
        ctrl.enable(2080).unwrap();
        ctrl.disable().unwrap();
        // 再造一份“看门狗已经修好”的表与报告。
        ctrl.enable(2080).unwrap();
        *fake.current.lock().unwrap() = Some("corp-proxy:8080".into());
        lease::write_report(
            &paths.report(),
            &RecoveryReport::new(
                RecoveryStatus::Restored,
                "127.0.0.1:2080",
                Some("corp-proxy:8080".into()),
                None,
                RecoverySource::Watchdog,
            ),
        )
        .unwrap();
        let _ = lease::remove_if_exists(&paths.lease());

        let report = ctrl.recover_on_startup().unwrap().unwrap();
        assert_eq!(report.status, RecoveryStatus::Restored);
        assert_eq!(report.source, RecoverySource::Watchdog);
        assert!(!ctrl.status().unwrap().has_backup, "报告已处理，表必须清掉");
        assert!(!paths.report().exists(), "报告只消费一次");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn startup_restores_from_the_lease_without_leaving_a_report() {
        let dir = temp_dir("lease-recovery");
        let paths = LeasePaths::in_dir(&dir);
        let fake = Box::leak(Box::new(Fake::new(Some("corp-proxy:8080"))));
        let ctrl = controller(fake).with_lease(&dir);
        ctrl.enable(2080).unwrap();
        assert_eq!(fake.current().unwrap().as_deref(), Some("127.0.0.1:2080"));
        // 模拟进程被杀：不 disable，租约还在。换一个控制器（等价于下次启动）。
        drop(ctrl);
        let ctrl = ProxyController::with_backend(
            Box::new(backup::MemoryBackupStore::new()),
            fake,
        )
        .with_lease(&dir);
        // 用同一个存储模拟表里还有备份：直接把租约读出来恢复即可。
        let report = ctrl.recover_on_startup().unwrap().unwrap();
        assert_eq!(report.status, RecoveryStatus::Restored);
        assert_eq!(report.source, RecoverySource::Startup);
        assert_eq!(fake.current().unwrap().as_deref(), Some("corp-proxy:8080"));
        assert!(!paths.lease().exists());
        assert!(
            !paths.report().exists(),
            "启动恢复不落报告文件（正常退出后会变成过期提示）"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn startup_settles_an_already_restored_lease() {
        let dir = temp_dir("startup-already");
        let paths = LeasePaths::in_dir(&dir);
        let fake = Box::leak(Box::new(Fake::new(Some("corp-proxy:8080"))));
        let ctrl = controller(fake).with_lease(&dir);
        ctrl.enable(2080).unwrap();
        // 模拟「租约写了、apply 没写成功」（或已经回到原值）。
        *fake.current.lock().unwrap() = Some("corp-proxy:8080".into());

        let report = ctrl.recover_on_startup().unwrap().unwrap();
        assert_eq!(report.status, RecoveryStatus::AlreadyRestored);
        assert_eq!(report.source, RecoverySource::Startup);
        assert!(!paths.lease().exists(), "already_restored 必须删租约");
        assert!(!ctrl.status().unwrap().has_backup, "already_restored 必须清表");
        assert!(!paths.report().exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_lease_lock_times_out_while_the_watchdog_holds_it() {
        use std::io::{BufRead, BufReader};
        use std::process::{Command, Stdio};
        use std::time::Instant;

        let dir = temp_dir("lock-timeout");
        std::fs::create_dir_all(&dir).unwrap();
        let paths = LeasePaths::in_dir(&dir);
        let fake = Box::leak(Box::new(Fake::new(None)));
        let ctrl = controller(fake).with_lease(&dir);

        // 用子进程持有锁：同一进程内 macOS 的 flock 会复用/转换，测不出争用。
        let mut child = match Command::new("python3")
            .arg("-c")
            .arg(
                "import fcntl,sys,time\n\
                 f=open(sys.argv[1],'w')\n\
                 fcntl.flock(f, fcntl.LOCK_EX)\n\
                 print('locked', flush=True)\n\
                 time.sleep(1.0)",
            )
            .arg(paths.lease_lock())
            .stdout(Stdio::piped())
            .spawn()
        {
            Ok(child) => child,
            Err(error) => {
                eprintln!("跳过：没有 python3（{error}）");
                return;
            }
        };
        {
            let stdout = child.stdout.take().unwrap();
            let mut line = String::new();
            BufReader::new(stdout).read_line(&mut line).unwrap();
            assert_eq!(line.trim(), "locked");
        }

        let started = Instant::now();
        let error = ctrl
            .ensure_lease_lock_for(&paths, Duration::from_millis(120))
            .unwrap_err();
        assert!(
            started.elapsed() >= Duration::from_millis(100),
            "必须等满超时才失败"
        );
        assert!(error.to_string().contains("看门狗"));

        child.wait().unwrap();
        ctrl.ensure_lease_lock_for(&paths, Duration::from_millis(500))
            .unwrap();
        let _ = std::fs::remove_dir_all(&dir);
    }
}
