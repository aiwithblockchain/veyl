//! TUN 连接的生命周期：确保特权组件可用 → 通过 `TunBackend` 发 start → 拿 pid。
//!
//! **不直接依赖 XPC / 管道**：平台差异都被 `tun::backend::TunBackend` 挡住，
//! 会话逻辑两端同一份（实施计划 §1.1）。
//!
//! 这里**不碰** `RuntimeManager`：TUN 的 sing-box 是特权进程的子进程，
//! 不是我们的子进程，manager 那套 Child 句柄的启停模型对它不适用。
//! 代价是 TUN 连接不参与 manager 的重连/看门狗。

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use super::backend::{ClashApi, StartReply, TunBackend, TunError, TunSnapshot};
use super::privilege::{HelperStatus, Registration};

/// 缓存中的 pid 超过这个间隔就向后端复核一次：helper 崩溃或被停掉时，
/// 界面不能一直报「已连接」。测试里缩短，避免用例等 5 秒。
#[cfg(not(test))]
const RUNNING_RECHECK_INTERVAL: Duration = Duration::from_secs(5);
#[cfg(test)]
const RUNNING_RECHECK_INTERVAL: Duration = Duration::from_millis(20);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Started {
    pub pid: u32,
    pub clash_addr: String,
    pub clash_secret: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TunState {
    Stopped,
    Running { pid: u32 },
}

/// 启动 TUN 时记住的上下文。
///
/// `runtime_status` 要给前端一份和代理模式同形状的快照，但 manager 完全不知道
/// TUN 的存在，配置名、节点、路由版本这些只能在这里留一份。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TunLaunchMeta {
    pub config_id: String,
    pub config_name: Option<String>,
    pub node_id: Option<String>,
    pub node_name: Option<String>,
    pub applied_route_revision: Option<i64>,
}

pub struct TunSession {
    backend: Arc<dyn TunBackend>,
    kind: &'static str,
    /// 上次成功 start 拿到的 pid。**刻意不每次读后端**：
    /// `runtime_status` 是热路径，同步 IPC 会把它拖慢。
    pid: Mutex<Option<u32>>,
    /// 这次连的是哪套配置、哪条线路。manager 不知道 TUN 的存在，删配置的守卫只能靠它。
    meta: Mutex<Option<TunLaunchMeta>>,
    /// 启动时刻（ISO 8601）：给快照，也用来算 uptime。接手老连接时以 helper
    /// 报的值为准——那是真正的进程启动时刻，不是「App 发现它的时刻」。
    connected: Mutex<Option<String>>,
    /// 本次进程的 Clash API；App 崩溃接手时从 helper 的 status 补回来。
    clash: Mutex<Option<ClashApi>>,
    /// 上一次向后端复核的时刻。缓存不能永远不出门：helper 死了要能发现。
    last_check: Mutex<Option<Instant>>,
    /// App 崩溃重启后 TUN 还活着，这时内存里没有 pid。
    /// 首次查状态时向后端问一次，之后不再重复。
    probed: AtomicBool,
}

impl TunSession {
    /// 沿用既有构造入口：配置里只给注册器，后端在这里按平台装配。
    ///
    /// Windows 没有「注册后台助手」这个动作——服务由提权安装器注册，
    /// 应用只做普通用户的管道请求，所以 `registration` 在这里不参与装配。
    pub fn new(registration: Arc<dyn Registration>) -> Self {
        #[cfg(target_os = "windows")]
        {
            let _ = registration;
            Self::with_backend(
                Arc::new(super::backend::WinPipeBackend::new()),
                "windows_pipe",
            )
        }
        #[cfg(not(target_os = "windows"))]
        {
            let kind = registration.kind();
            #[cfg(target_os = "macos")]
            let backend: Arc<dyn TunBackend> =
                Arc::new(super::backend::MacXpcBackend::new(registration));
            #[cfg(not(target_os = "macos"))]
            let backend: Arc<dyn TunBackend> = {
                let _ = registration;
                Arc::new(super::backend::UnsupportedBackend)
            };
            Self::with_backend(backend, kind)
        }
    }

    /// 测试与将来 Windows 装配用：直接注入一个后端。
    pub fn with_backend(backend: Arc<dyn TunBackend>, kind: &'static str) -> Self {
        Self {
            backend,
            kind,
            pid: Mutex::new(None),
            meta: Mutex::new(None),
            connected: Mutex::new(None),
            clash: Mutex::new(None),
            last_check: Mutex::new(None),
            probed: AtomicBool::new(false),
        }
    }

    pub fn launcher_kind(&self) -> &'static str {
        self.kind
    }

    /// 特权组件当前状态。`stop()` 在助手不可用时会直接返回成功（没有可停的东西），
    /// 强制重置必须能区分「真的没在跑」和「问不到」。
    pub fn helper_status(&self) -> HelperStatus {
        self.backend
            .availability()
            .unwrap_or(HelperStatus::Unsupported)
    }

    /// 起 TUN。顺序不可换：**先确认特权组件可用**再发请求，
    /// 否则连不上时用户只会看到一个无意义的超时。
    pub fn launch(&self, config: &str, meta: &TunLaunchMeta) -> Result<Started, TunError> {
        self.backend.ensure_available()?;
        let reply: StartReply = self.backend.start(config)?;

        *self.pid.lock().unwrap() = Some(reply.pid);
        *self.meta.lock().unwrap() = Some(meta.clone());
        *self.connected.lock().unwrap() = Some(reply.since.clone());
        *self.clash.lock().unwrap() = Some(reply.clash_api.clone());
        *self.last_check.lock().unwrap() = Some(Instant::now());

        Ok(Started {
            pid: reply.pid,
            clash_addr: reply.clash_api.addr,
            clash_secret: reply.clash_api.secret,
        })
    }

    /// 正在接管的配置。只有 TUN 确实在跑时才回答；
    /// App 重启后接手的老连接没有配置 id，这里返回 None（调用方按「身份未知」处理）。
    pub fn connected_config_id(&self) -> Option<String> {
        self.launch_meta().map(|meta| meta.config_id)
    }

    /// 本次连接的上下文；没在跑时是 None。
    pub fn launch_meta(&self) -> Option<TunLaunchMeta> {
        if !matches!(self.status(), TunState::Running { .. }) {
            return None;
        }
        self.meta.lock().unwrap().clone()
    }

    /// 本次连接的启动时刻（ISO 8601 UTC）。
    pub fn connected_since(&self) -> Option<String> {
        if !matches!(self.status(), TunState::Running { .. }) {
            return None;
        }
        self.connected.lock().unwrap().clone()
    }

    /// 本次进程的 Clash API；App 崩溃接手后也能从 helper 的 status 拿到。
    pub fn clash_api(&self) -> Option<ClashApi> {
        if !matches!(self.status(), TunState::Running { .. }) {
            return None;
        }
        self.clash.lock().unwrap().clone()
    }

    /// 连接已持续多少秒。按 helper 报的启动时刻算，接手老连接也一样。
    pub fn uptime_seconds(&self) -> Option<u64> {
        if !matches!(self.status(), TunState::Running { .. }) {
            return None;
        }
        let since = self.connected.lock().unwrap().clone()?;
        let started = chrono::DateTime::parse_from_rfc3339(&since).ok()?;
        let elapsed = chrono::Utc::now() - started.with_timezone(&chrono::Utc);
        Some(elapsed.num_seconds().max(0) as u64)
    }

    /// 测试用：直接摆出「正在跑 + 记得是哪套配置」的状态，不碰后端。
    #[cfg(test)]
    pub fn force_running_for_test(&self, pid: u32, config_id: Option<&str>) {
        *self.pid.lock().unwrap() = Some(pid);
        *self.meta.lock().unwrap() = config_id.map(|id| TunLaunchMeta {
            config_id: id.to_string(),
            config_name: None,
            node_id: None,
            node_name: None,
            applied_route_revision: None,
        });
        *self.connected.lock().unwrap() = Some("2026-11-04T00:00:00Z".into());
        *self.last_check.lock().unwrap() = Some(Instant::now());
    }

    /// 幂等。本来就没起过时不发请求——否则每次断开代理连接都要等一次超时。
    pub fn stop(&self) -> Result<(), TunError> {
        if self.status() == TunState::Stopped {
            return Ok(());
        }
        match self.backend.stop() {
            Ok(()) => {
                self.clear_state();
                Ok(())
            }
            // 只有真的停掉了才清状态：停失败还清掉，界面会显示已断开，
            // 而特权侧里的 sing-box 还在接管流量。
            Err(error) => Err(error),
        }
    }

    fn clear_state(&self) {
        *self.pid.lock().unwrap() = None;
        *self.meta.lock().unwrap() = None;
        *self.connected.lock().unwrap() = None;
        *self.clash.lock().unwrap() = None;
        *self.last_check.lock().unwrap() = None;
    }

    /// 热路径：缓存有效时只读内存，超过复核间隔才问一次后端。
    ///
    /// 缓存不能永远不出门：helper 崩溃或被停掉时，界面必须能变成「未连接」，
    /// 否则删配置的守卫会以为配置还在用。问不到后端时**不据此判定断开**，
    /// 保留缓存，下一个间隔再试。
    pub fn status(&self) -> TunState {
        // 先复制出来再解锁：`if let Some(pid) = *lock...` 会把 MutexGuard 持有到
        // 整个分支结束，而分支里会再锁 pid（adopt / clear_state），造成自死锁。
        let cached = { *self.pid.lock().unwrap() };
        if let Some(pid) = cached {
            let due = self
                .last_check
                .lock()
                .unwrap()
                .map(|at| at.elapsed() >= RUNNING_RECHECK_INTERVAL)
                .unwrap_or(true);
            if !due {
                return TunState::Running { pid };
            }
            return self.recheck(pid);
        }
        self.probe_once()
    }

    /// 没有缓存时的一次性接手：先判就绪，再问后端。
    fn probe_once(&self) -> TunState {
        // **先判就绪，再决定要不要探测。**
        // 旧顺序是先 `probed.swap(true)` 再判就绪：未就绪时第一次调用
        // 就把标志永久置真，之后即使组件起来了也不会接手。
        if !matches!(self.backend.availability(), Ok(status) if status.is_ready()) {
            // 未就绪时把标志复位，等它真的可用了还能再探一次。
            self.probed.store(false, Ordering::SeqCst);
            return TunState::Stopped;
        }
        if self.probed.swap(true, Ordering::SeqCst) {
            return TunState::Stopped;
        }
        match self.backend.status() {
            Ok(snapshot) => match snapshot.pid {
                Some(pid) => {
                    self.adopt(&snapshot, pid);
                    TunState::Running { pid }
                }
                None => TunState::Stopped,
            },
            Err(_) => {
                // 问不到不等于没在跑；复位标志，让下一次还能再试。
                self.probed.store(false, Ordering::SeqCst);
                TunState::Stopped
            }
        }
    }

    /// 缓存命中但已过复核间隔：向后端确认一次。
    fn recheck(&self, cached_pid: u32) -> TunState {
        *self.last_check.lock().unwrap() = Some(Instant::now());
        match self.backend.status() {
            Ok(snapshot) => match snapshot.pid {
                Some(pid) => {
                    self.adopt(&snapshot, pid);
                    TunState::Running { pid }
                }
                None => {
                    self.clear_state();
                    TunState::Stopped
                }
            },
            // 后端暂时问不到：保留缓存，不把「问不到」当成「已断开」。
            Err(_) => TunState::Running { pid: cached_pid },
        }
    }

    /// 把后端报的 pid / since / clash 写回缓存（启动成功或接手老连接）。
    fn adopt(&self, snapshot: &TunSnapshot, pid: u32) {
        *self.pid.lock().unwrap() = Some(pid);
        if let Some(since) = snapshot.since.clone() {
            *self.connected.lock().unwrap() = Some(since);
        }
        if let Some(api) = snapshot.clash_api.clone() {
            *self.clash.lock().unwrap() = Some(api);
        }
        *self.last_check.lock().unwrap() = Some(Instant::now());
    }
}

/// 断开 / 卸载前要做的网络恢复，**E3 以后直接调这个**（`capabilities.md` §3.1
/// 要求卸载清理与 E3 共用同一段代码）。
#[derive(Debug, Default, PartialEq, Eq)]
pub struct CleanupReport {
    pub stopped_tun: bool,
    pub stopped_runtime: bool,
    pub restored_proxy: bool,
    pub flushed_dns: bool,
    pub removed_configs: usize,
    pub failures: Vec<String>,
}

impl CleanupReport {
    pub fn is_clean(&self) -> bool {
        self.failures.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tun::backend::{ClashApi, TunErrorCode, TunSnapshot};
    use crate::tun::privilege::{HelperStatus, PrivilegeError, ERR_TUN_DENIED};
    use std::sync::atomic::AtomicUsize;

    /// 假注册：不碰系统，只按剧本成功或拒绝。
    struct FakeRegistration {
        ready: bool,
    }

    impl Registration for FakeRegistration {
        fn kind(&self) -> &'static str {
            "fake"
        }
        fn status(&self) -> HelperStatus {
            HelperStatus::Enabled
        }
        fn ensure_registered(&self) -> Result<(), PrivilegeError> {
            if self.ready {
                Ok(())
            } else {
                Err(PrivilegeError::new(ERR_TUN_DENIED, "用户拒绝了"))
            }
        }
        fn unregister(&self) -> Result<(), PrivilegeError> {
            Ok(())
        }
    }

    /// 假后端：把会话与传输层隔开，验证 `TunSession` 只依赖 trait。
    struct FakeBackend {
        starts: AtomicUsize,
        stops: AtomicUsize,
        running: Mutex<Option<u32>>,
        clash: Mutex<Option<ClashApi>>,
        since: Mutex<Option<String>>,
    }

    impl FakeBackend {
        fn new() -> Self {
            Self {
                starts: AtomicUsize::new(0),
                stops: AtomicUsize::new(0),
                running: Mutex::new(None),
                clash: Mutex::new(None),
                since: Mutex::new(None),
            }
        }
    }

    impl TunBackend for FakeBackend {
        fn availability(&self) -> Result<HelperStatus, TunError> {
            Ok(HelperStatus::Enabled)
        }
        fn ensure_available(&self) -> Result<HelperStatus, TunError> {
            Ok(HelperStatus::Enabled)
        }
        fn start(&self, _config: &str) -> Result<StartReply, TunError> {
            self.starts.fetch_add(1, Ordering::SeqCst);
            let pid = 4242;
            *self.running.lock().unwrap() = Some(pid);
            let clash_api = ClashApi {
                addr: "127.0.0.1:51234".into(),
                secret: "s".into(),
            };
            *self.clash.lock().unwrap() = Some(clash_api.clone());
            let since = "2026-11-05T00:00:00Z".to_string();
            *self.since.lock().unwrap() = Some(since.clone());
            Ok(StartReply {
                pid,
                clash_api,
                since,
            })
        }
        fn stop(&self) -> Result<(), TunError> {
            self.stops.fetch_add(1, Ordering::SeqCst);
            *self.running.lock().unwrap() = None;
            *self.clash.lock().unwrap() = None;
            *self.since.lock().unwrap() = None;
            Ok(())
        }
        fn status(&self) -> Result<TunSnapshot, TunError> {
            let pid = *self.running.lock().unwrap();
            Ok(TunSnapshot {
                running: pid.is_some(),
                pid,
                clash_api: self.clash.lock().unwrap().clone(),
                since: self.since.lock().unwrap().clone(),
                last_error: None,
            })
        }
    }

    fn meta() -> TunLaunchMeta {
        TunLaunchMeta {
            config_id: "cfg_test".into(),
            config_name: None,
            node_id: None,
            node_name: None,
            applied_route_revision: None,
        }
    }

    #[test]
    fn a_rejected_registration_stops_before_any_ipc_call() {
        // 没被批准时 launch 必须立刻失败，而不是去连一个不存在的服务。
        let session = TunSession::new(Arc::new(FakeRegistration { ready: false }));
        let error = session.launch("{}", &meta()).unwrap_err();
        assert_eq!(error.code, TunErrorCode::TunDenied);
    }

    /// 会话只依赖 trait：start / stop / since 都由后端回包决定。
    #[test]
    fn the_session_goes_through_the_backend_trait() {
        let backend = Arc::new(FakeBackend::new());
        let session = TunSession::with_backend(backend.clone(), "fake");

        let started = session.launch("{}", &meta()).unwrap();
        assert_eq!(started.pid, 4242);
        assert_eq!(started.clash_addr, "127.0.0.1:51234");
        assert_eq!(session.status(), TunState::Running { pid: 4242 });
        assert_eq!(
            session.connected_since().as_deref(),
            Some("2026-11-05T00:00:00Z")
        );

        session.stop().unwrap();
        assert_eq!(backend.stops.load(Ordering::SeqCst), 1);
        assert_eq!(session.status(), TunState::Stopped);

        // 幂等：第二次 stop 不再打后端。
        session.stop().unwrap();
        assert_eq!(backend.stops.load(Ordering::SeqCst), 1);
        assert_eq!(backend.starts.load(Ordering::SeqCst), 1);
    }

    /// 后端报 running 时，首次 status 能接手（App 崩溃重启场景），
    /// 并把 helper 报的 since / clash_api 一起缓存下来。
    #[test]
    fn an_adopted_running_backend_is_picked_up_with_since_and_clash() {
        let backend = Arc::new(FakeBackend::new());
        *backend.running.lock().unwrap() = Some(777);
        *backend.since.lock().unwrap() = Some("2026-11-05T00:00:00Z".into());
        *backend.clash.lock().unwrap() = Some(ClashApi {
            addr: "127.0.0.1:60000".into(),
            secret: "s".into(),
        });
        let session = TunSession::with_backend(backend, "fake");

        assert_eq!(session.status(), TunState::Running { pid: 777 });
        assert_eq!(
            session.connected_since().as_deref(),
            Some("2026-11-05T00:00:00Z")
        );
        assert_eq!(
            session.clash_api().map(|api| api.addr).as_deref(),
            Some("127.0.0.1:60000")
        );
        assert!(session.launch_meta().is_none(), "接手的老连接没有配置归属");
    }

    /// 缓存不能永远不出门：helper 那边停了，复核必须把状态改回未连接。
    #[test]
    fn a_cached_running_state_is_rechecked_and_cleared_when_the_backend_stops() {
        let backend = Arc::new(FakeBackend::new());
        let session = TunSession::with_backend(backend.clone(), "fake");
        session.launch("{}", &meta()).unwrap();
        assert_eq!(session.status(), TunState::Running { pid: 4242 });

        *backend.running.lock().unwrap() = None;
        std::thread::sleep(RUNNING_RECHECK_INTERVAL + Duration::from_millis(20));

        assert_eq!(
            session.status(),
            TunState::Stopped,
            "helper 停了就不能再报 Running"
        );
    }

    #[test]
    fn a_cleanup_report_is_clean_only_without_failures() {
        assert!(CleanupReport::default().is_clean());
        let mut report = CleanupReport::default();
        report.failures.push("还原系统代理失败".into());
        assert!(!report.is_clean());
    }

    /// 运行中的 TUN 必须记得自己连的是哪套配置——删配置的守卫靠它。
    #[test]
    fn a_running_session_remembers_which_config_it_launched() {
        let session = TunSession::new(Arc::new(FakeRegistration { ready: true }));
        assert!(
            session.connected_config_id().is_none(),
            "没跑的时候没有归属"
        );

        session.force_running_for_test(42, Some("cfg_a"));
        assert_eq!(session.connected_config_id().as_deref(), Some("cfg_a"));

        session.force_running_for_test(42, None);
        assert!(
            session.connected_config_id().is_none(),
            "重启后接手的老连接读不到 id，必须如实返回 None"
        );
    }
}
