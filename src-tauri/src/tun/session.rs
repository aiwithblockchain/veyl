//! TUN 连接的生命周期：确保特权组件可用 → 通过 `TunBackend` 发 start → 拿 pid。
//!
//! **不直接依赖 XPC / 管道**：平台差异都被 `tun::backend::TunBackend` 挡住，
//! 会话逻辑两端同一份（实施计划 §1.1）。
//!
//! 这里**不碰** `RuntimeManager`：TUN 的 sing-box 是特权进程的子进程，
//! 不是我们的子进程，manager 那套 Child 句柄的启停模型对它不适用。
//! 代价是 TUN 连接不参与 manager 的重连/看门狗。

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use super::backend::{
    ClashApi, DnsHijack, StartReply, TunBackend, TunError, TunErrorCode, TunSnapshot,
    TUN_REPLY_DEADLINE_CONTROL,
};
use super::privilege::{HelperStatus, Registration};
use crate::runtime::health::DataPlaneGate;

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

/// 一次在途启动的登记。
struct Launching {
    seq: u64,
    config_id: String,
    /// 是否已经把 `start` 发给 helper。迟到的旧启动要靠它判断
    /// 「新连接会不会替我收掉旧实例」——helper 的 start 是替换语义。
    start_sent: bool,
}

/// 在途启动的凭据：只有登记时的代次仍然有效，才允许把结果写成「已连接」。
///
/// `TunState` 只有 `Stopped` / `Running`，而 TUN 首次启动要十几秒（真机
/// 13.4 秒）；这段时间里既没有 pid 也没有 meta，只看状态会把「正在连」当成
/// 「没在连」——切配置会静默改 active、断开也停不掉正在起来的那次连接。
pub struct LaunchSlot<'a> {
    session: &'a TunSession,
    seq: u64,
    settled: bool,
}

impl<'a> LaunchSlot<'a> {
    /// 这次启动在 helper 动手期间是否已被取消（stop / 切配置）。
    pub fn cancelled(&self) -> bool {
        !self.session.launch_is_current(self.seq)
    }

    /// 本次启动生效：把 pid 与连接上下文写进状态。返回 false 表示已被取消。
    pub fn commit(mut self, meta: &TunLaunchMeta, reply: &StartReply) -> bool {
        self.settled = true;
        self.session.commit_launch(self.seq, meta, reply)
    }
}

impl Drop for LaunchSlot<'_> {
    /// 失败、超时或提前返回：把登记撤掉，别让「正在连」永远挂着。
    fn drop(&mut self) {
        if !self.settled {
            self.session.abandon_launch(self.seq);
        }
    }
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
    /// 生成这份 TUN 配置时判定的地区；界面显示实际生效值。
    pub route_region: Option<String>,
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
    /// 连接期系统 DNS 接管结果；未连接时为 None。来自 start 回复或 status 快照。
    dns: Mutex<Option<DnsHijack>>,
    /// 上一次向后端复核的时刻。缓存不能永远不出门：helper 死了要能发现。
    last_check: Mutex<Option<Instant>>,
    /// App 崩溃重启后 TUN 还活着，这时内存里没有 pid。
    /// 首次查状态时向后端问一次，之后不再重复。
    probed: AtomicBool,
    /// 是否发起过 start。**只在 stop 成功后清除**。
    ///
    /// 与 pid 分开记：start 超时后本地没有 pid，但 helper 里可能已经有
    /// root 进程。只看 pid 会把这种情况下的 `helper_missing` 当成「没东西可停」。
    start_attempted: AtomicBool,
    /// 在途启动登记：`(代次, 配置 id)`。启动窗口里判断「有没有连接在途」只靠它。
    launching: Mutex<Option<Launching>>,
    /// 启动代次发生器。stop / 切配置会作废旧代次，迟到的 start 不得再写状态。
    launch_seq: AtomicU64,
    /// 数据面探测结果。只由健康循环写，`runtime_status` 读；
    /// 去抖口径与代理模式共用 `DataPlaneGate`（契约 §2.3.1）。
    data_plane: Mutex<DataPlaneSnapshot>,
}

/// 一次连接内的数据面结论 + 探测时刻。
///
/// 新连接开始时整体重置：上一条连接的失败不能算到下一条头上。
#[derive(Debug, Clone)]
struct DataPlaneSnapshot {
    gate: DataPlaneGate,
    checked_at: String,
}

impl DataPlaneSnapshot {
    fn fresh(checked_at: String) -> Self {
        Self {
            gate: DataPlaneGate::default(),
            checked_at,
        }
    }
}

fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

/// 这次连接已被切配置 / 断开取代：不是该展示给用户的故障，只是这次请求作废了。
fn cancelled_connection_error() -> TunError {
    TunError::new(TunErrorCode::Cancelled, "这次连接已被新的操作取消")
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
            dns: Mutex::new(None),
            last_check: Mutex::new(None),
            probed: AtomicBool::new(false),
            start_attempted: AtomicBool::new(false),
            launching: Mutex::new(None),
            launch_seq: AtomicU64::new(0),
            data_plane: Mutex::new(DataPlaneSnapshot::fresh(now_iso())),
        }
    }

    /// 底层通道。helper 构建检查与升级需要它，但状态仍由本会话统一持有。
    pub fn backend(&self) -> Arc<dyn TunBackend> {
        Arc::clone(&self.backend)
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
        let slot = self.begin_launch(&meta.config_id);
        self.launch_registered(slot, config, meta)
    }

    /// 登记一次在途启动。调用方从拿到凭据的那一刻起就算「正在连」，
    /// 直到 `LaunchSlot::commit` 或它被丢弃。
    pub fn begin_launch(&self, config_id: &str) -> LaunchSlot<'_> {
        // 先取号再登记：切配置可能在两步之间把登记清掉，那时这次启动立即作废。
        let seq = self.launch_seq.fetch_add(1, Ordering::SeqCst) + 1;
        *self.launching.lock().unwrap() = Some(Launching {
            seq,
            config_id: config_id.to_string(),
            start_sent: false,
        });
        LaunchSlot {
            session: self,
            seq,
            settled: false,
        }
    }

    /// 用已有的登记发起 start。`slot` 被取消时，刚起来的进程也要停掉——
    /// 否则界面说「切换了」，流量还在旧连接上。
    pub fn launch_registered(
        &self,
        slot: LaunchSlot<'_>,
        config: &str,
        meta: &TunLaunchMeta,
    ) -> Result<Started, TunError> {
        if slot.cancelled() {
            return Err(cancelled_connection_error());
        }
        self.backend.ensure_available()?;
        // helper 检查可能弹授权、等十几秒：发 start 前再确认一次。已经断开或切走了
        // 就不要再拉起隧道——helper 的 start 会把 `stop_requested` 置回 false。
        if slot.cancelled() {
            return Err(cancelled_connection_error());
        }
        // 必须在调 start **之前**置位：start 失败或超时也意味着 helper
        // 可能已经动手了。标志只有 stop 成功才清。
        self.start_attempted.store(true, Ordering::SeqCst);
        // 先标记再发：迟到的旧启动据此判断「新连接会不会替我收掉旧实例」。
        self.mark_start_sent(slot.seq);
        let reply: StartReply = self.backend.start(config)?;

        if !slot.commit(meta, &reply) {
            // 已经作废：helper 可能还是把实例拉起来了。
            if self.newer_launch_sent_start() {
                // 更晚的启动已经把 start 发出去，helper 的替换语义会收掉这个迟到的
                // 实例。这里再停一次（stop 是全局的）会把新连接一起杀掉。
                log::warn!(
                    "启动已被取代，交给新连接的替换语义收掉旧实例 pid={} config={}",
                    reply.pid,
                    meta.config_id
                );
            } else {
                log::warn!(
                    "启动被取消，停掉 helper 刚拉起的实例 pid={} config={}",
                    reply.pid,
                    meta.config_id
                );
                self.stop_backend_only();
            }
            return Err(cancelled_connection_error());
        }

        Ok(Started {
            pid: reply.pid,
            clash_addr: reply.clash_api.addr,
            clash_secret: reply.clash_api.secret,
        })
    }

    /// 有 start 在途（还没拿到 pid，也没确认失败）。
    pub fn is_launching(&self) -> bool {
        self.launching.lock().unwrap().is_some()
    }

    /// 在途启动对应的配置；没有在途启动时为 None。
    pub fn launching_config_id(&self) -> Option<String> {
        self.launching
            .lock()
            .unwrap()
            .as_ref()
            .map(|launch| launch.config_id.clone())
    }

    /// 作废在途启动（切配置 / 断开）。返回是否确实有在途启动。
    ///
    /// 只清登记、不碰进程：调用方随后要自己 `stop`，那一步会排到在途 start 后面。
    pub fn cancel_launch(&self) -> bool {
        self.launching.lock().unwrap().take().is_some()
    }

    fn launch_is_current(&self, seq: u64) -> bool {
        self.launching
            .lock()
            .unwrap()
            .as_ref()
            .map(|launch| launch.seq)
            == Some(seq)
    }

    fn mark_start_sent(&self, seq: u64) {
        if let Some(launch) = self.launching.lock().unwrap().as_mut() {
            if launch.seq == seq {
                launch.start_sent = true;
            }
        }
    }

    /// 有没有更晚的一次启动已经把 `start` 发给 helper。
    /// 有的话替换语义会收掉旧实例，这里再全局 stop 会把新连接一起杀掉。
    fn newer_launch_sent_start(&self) -> bool {
        self.launching
            .lock()
            .unwrap()
            .as_ref()
            .map(|launch| launch.start_sent)
            .unwrap_or(false)
    }

    /// 补停用：只停后端，**不动在途启动的登记**。
    /// 迟到的旧启动收尾时，登记可能已经属于更新的那次启动。
    fn stop_backend_only(&self) {
        match self.backend.stop_with_deadline(TUN_REPLY_DEADLINE_CONTROL) {
            Ok(()) => {
                // 与 `stop_with_deadline` 的成功分支对齐：真的停掉了，之后那次
                // `HelperMissing` 才该被当成「本来就没东西可停」。
                self.start_attempted.store(false, Ordering::SeqCst);
                self.clear_state();
            }
            Err(error) => log::warn!("取消后补停失败：{}", error.message),
        }
    }

    fn commit_launch(&self, seq: u64, meta: &TunLaunchMeta, reply: &StartReply) -> bool {
        let mut launching = self.launching.lock().unwrap();
        if launching.as_ref().map(|launch| launch.seq) != Some(seq) {
            return false;
        }
        // 先写 Running 再撤登记：反过来的话，两步之间有一瞬「既没连、也不在启动」，
        // 这时切配置 / 断开正好读到这里，就会把在途连接当成不存在。
        self.write_running(meta, reply);
        *launching = None;
        true
    }

    fn abandon_launch(&self, seq: u64) {
        let mut launching = self.launching.lock().unwrap();
        if launching.as_ref().map(|launch| launch.seq) == Some(seq) {
            *launching = None;
        }
    }

    fn write_running(&self, meta: &TunLaunchMeta, reply: &StartReply) {
        *self.pid.lock().unwrap() = Some(reply.pid);
        *self.meta.lock().unwrap() = Some(meta.clone());
        *self.connected.lock().unwrap() = Some(reply.since.clone());
        *self.clash.lock().unwrap() = Some(reply.clash_api.clone());
        *self.dns.lock().unwrap() = Some(reply.dns_hijack.clone());
        *self.last_check.lock().unwrap() = Some(Instant::now());
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

    /// 本次连接的 Clash API；App 崩溃接手后也能从 helper 的 status 拿到。
    pub fn clash_api(&self) -> Option<ClashApi> {
        if !matches!(self.status(), TunState::Running { .. }) {
            return None;
        }
        self.clash.lock().unwrap().clone()
    }

    /// 节点热切后同步本次连接的节点信息；否则界面刷新会读到旧节点。
    pub fn set_current_node(&self, node_id: &str, node_name: &str) {
        let mut guard = self.meta.lock().unwrap();
        if let Some(meta) = guard.as_mut() {
            meta.node_id = Some(node_id.to_string());
            meta.node_name = Some(node_name.to_string());
        }
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

    /// 连接身份：`pid@启动时刻`；未连接为 None。
    ///
    /// 健康循环据此判断「是不是新的一次连接」——App 崩溃接手、重新连接、
    /// 停止后再连都会换身份，去抖计数随之清零。
    pub fn running_identity(&self) -> Option<String> {
        match self.status() {
            TunState::Running { pid } => {
                let since = self.connected.lock().unwrap().clone().unwrap_or_default();
                Some(format!("{pid}@{since}"))
            }
            TunState::Stopped => None,
        }
    }

    /// 新连接的第一轮探测之前：乐观 `true`，时刻用连接时刻。
    ///
    /// 契约 §2.3.1：连接后还没跑完第一轮探测时按未知的乐观值处理，
    /// 这样界面不会在刚连上的头 10 秒里先闪一条「没有流量」。
    pub fn begin_data_plane(&self) {
        let since = self.connected.lock().unwrap().clone();
        *self.data_plane.lock().unwrap() = DataPlaneSnapshot::fresh(since.unwrap_or_else(now_iso));
    }

    /// 记一次探测结果，返回 `data_plane` 是否翻转。只由健康循环调用。
    pub fn record_data_plane(&self, ok: bool) -> bool {
        let mut snapshot = self.data_plane.lock().unwrap();
        let changed = snapshot.gate.record(ok);
        snapshot.checked_at = now_iso();
        changed
    }

    /// `runtime_status` 用：`(data_plane, 该结论的探测时刻)`。
    pub fn data_plane_health(&self) -> (bool, String) {
        let snapshot = self.data_plane.lock().unwrap();
        (snapshot.gate.up(), snapshot.checked_at.clone())
    }

    /// 测试用：摆出「正在跑 + 记得是哪套配置」，并可带一个 Clash 端点。
    #[cfg(test)]
    pub fn force_running_with_clash_for_test(
        &self,
        pid: u32,
        config_id: &str,
        route_revision: Option<i64>,
        addr: &str,
        secret: &str,
    ) {
        self.force_running_for_test(pid, Some(config_id));
        if let Some(revision) = route_revision {
            if let Some(meta) = self.meta.lock().unwrap().as_mut() {
                meta.applied_route_revision = Some(revision);
            }
        }
        *self.clash.lock().unwrap() = Some(ClashApi {
            addr: addr.to_string(),
            secret: secret.to_string(),
        });
    }

    /// 测试用：直接摆出「正在跑 + 记得是哪套配置」的状态，不碰后端。
    #[cfg(test)]
    pub fn force_running_for_test(&self, pid: u32, config_id: Option<&str>) {
        *self.launching.lock().unwrap() = None;
        *self.pid.lock().unwrap() = Some(pid);
        *self.meta.lock().unwrap() = config_id.map(|id| TunLaunchMeta {
            config_id: id.to_string(),
            config_name: None,
            node_id: None,
            node_name: None,
            applied_route_revision: None,
            route_region: None,
        });
        *self.connected.lock().unwrap() = Some("2026-11-04T00:00:00Z".into());
        // 复核时刻放到未来：测试里没有真 helper，不能让 20ms（测试用的复核间隔）
        // 一到就去问后端，把「正在跑」清成 Stopped。`elapsed()` 对未来时刻返回 0。
        *self.last_check.lock().unwrap() = Some(Instant::now() + Duration::from_secs(3600));
        *self.data_plane.lock().unwrap() = DataPlaneSnapshot::fresh(now_iso());
    }

    /// 测试用：摆出「正在连、还没起来」的启动窗口，不碰后端。
    #[cfg(test)]
    pub fn force_launching_for_test(&self, config_id: &str) {
        let seq = self.launch_seq.fetch_add(1, Ordering::SeqCst) + 1;
        *self.launching.lock().unwrap() = Some(Launching {
            seq,
            config_id: config_id.to_string(),
            start_sent: false,
        });
    }

    /// 幂等，且**永远发请求**。
    ///
    /// 不能因为本地缓存是 `Stopped` 就跳过：start 超时/失败时本地没记下 pid，
    /// 但 helper 可能已经或即将把 sing-box 拉起来。真机上就是这样漏的——
    /// 客户端超时后 session 是 Stopped，`backend.stop()` 一次都没发出去，
    /// helper 里的 root 进程一直活着。后端的 stop 本身幂等，多一次 IPC
    /// 比留一个 root 进程便宜得多。
    pub fn stop(&self) -> Result<(), TunError> {
        self.stop_with_deadline(TUN_REPLY_DEADLINE_CONTROL)
    }

    /// 强制重置用：start 可能还在准备（真机首跑约 30 秒），stop 要能排到它后面。
    pub fn stop_with_deadline(&self, deadline: Duration) -> Result<(), TunError> {
        // 启动窗口里 stop 也必须算数：先作废在途启动，迟到的 start 回来时
        // 不会再写成「已连接」，也不会改连接上下文。
        self.cancel_launch();
        // 先取本地状态再解锁：后面要据此判断「报错能不能吞」。
        let had_state = { self.pid.lock().unwrap().is_some() };
        let attempted = self.start_attempted.load(Ordering::SeqCst);

        match self.backend.stop_with_deadline(deadline) {
            Ok(()) => {
                self.start_attempted.store(false, Ordering::SeqCst);
                self.clear_state();
                Ok(())
            }
            // 两个条件都要满足才能吞：没有发起过 start，本地也没有 pid。
            // start 超时后 pid 是空的，但 helper 里可能有 root 进程——
            // 只看 pid 会把这种 `helper_missing` 当成「没东西可停」。
            Err(error)
                if !attempted
                    && !had_state
                    && matches!(error.code, TunErrorCode::HelperMissing) =>
            {
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
        *self.dns.lock().unwrap() = None;
        *self.last_check.lock().unwrap() = None;
        // 断开后旧结论作废；下次连接由 begin_data_plane 重新开始。
        *self.data_plane.lock().unwrap() = DataPlaneSnapshot::fresh(now_iso());
    }

    /// 连接期系统 DNS 的接管结果；没在连接时是 None。
    pub fn dns_hijack(&self) -> Option<DnsHijack> {
        self.dns.lock().unwrap().clone()
    }

    /// 刷新系统 DNS 缓存。
    ///
    /// 没在跑也能调：TUN 回滚时进程已经停了，但 hijack 期间写进
    /// mDNSResponder 的坏缓存还在，要一起清掉。
    pub fn flush_dns(&self) -> Result<(), TunError> {
        self.backend.flush_dns()
    }

    /// 还原连接期被改写的系统 DNS。幂等：没改过就是空操作。
    pub fn restore_dns(&self) -> Result<(), TunError> {
        self.backend.restore_dns()
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
        *self.dns.lock().unwrap() = Some(snapshot.dns_hijack.clone());
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
        flushes: AtomicUsize,
        running: Mutex<Option<u32>>,
        clash: Mutex<Option<ClashApi>>,
        since: Mutex<Option<String>>,
        start_error: Mutex<Option<TunErrorCode>>,
        stop_error: Mutex<Option<TunErrorCode>>,
    }

    impl FakeBackend {
        fn new() -> Self {
            Self {
                starts: AtomicUsize::new(0),
                stops: AtomicUsize::new(0),
                flushes: AtomicUsize::new(0),
                running: Mutex::new(None),
                clash: Mutex::new(None),
                since: Mutex::new(None),
                start_error: Mutex::new(None),
                stop_error: Mutex::new(None),
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
            if let Some(code) = *self.start_error.lock().unwrap() {
                return Err(TunError::new(code, "fake start error"));
            }
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
                dns_hijack: DnsHijack::default(),
            })
        }
        fn stop(&self) -> Result<(), TunError> {
            self.stops.fetch_add(1, Ordering::SeqCst);
            if let Some(code) = *self.stop_error.lock().unwrap() {
                return Err(TunError::new(code, "fake stop error"));
            }
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
                dns_hijack: DnsHijack::default(),
                helper_build: None,
                helper_version: None,
                helper_pid: None,
            })
        }

        fn flush_dns(&self) -> Result<(), TunError> {
            self.flushes.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }

        fn restart(&self) -> Result<(), TunError> {
            Ok(())
        }
    }

    fn meta() -> TunLaunchMeta {
        TunLaunchMeta {
            config_id: "cfg_test".into(),
            config_name: None,
            node_id: None,
            node_name: None,
            applied_route_revision: None,
            route_region: None,
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

        // 仍然幂等（返回成功），但每次都会发请求：
        // 本地缓存不能当作「不用停」的依据。
        session.stop().unwrap();
        assert_eq!(backend.stops.load(Ordering::SeqCst), 2);
        assert_eq!(backend.starts.load(Ordering::SeqCst), 1);
    }

    /// 真机洞：start 超时后本地没有 pid（status 是 Stopped），
    /// 但 helper 可能已经把 sing-box 拉起来了——stop 必须照样发请求。
    #[test]
    fn a_stop_after_a_failed_start_still_reaches_the_backend() {
        let backend = Arc::new(FakeBackend::new());
        let session = TunSession::with_backend(backend.clone(), "fake");
        assert_eq!(session.status(), TunState::Stopped);

        session.stop().unwrap();
        assert_eq!(
            backend.stops.load(Ordering::SeqCst),
            1,
            "缓存是 Stopped 也必须发 stop"
        );
    }

    /// start 超时后 helper 仍可能把进程拉起来：此时 stop 拿到 `helper_missing`
    /// 不能被当成成功吞掉（真机断网事故的正式修复）。
    #[test]
    fn a_helper_missing_after_a_start_attempt_is_not_swallowed() {
        let backend = Arc::new(FakeBackend::new());
        *backend.start_error.lock().unwrap() = Some(TunErrorCode::Timeout);
        *backend.stop_error.lock().unwrap() = Some(TunErrorCode::HelperMissing);

        let session = TunSession::with_backend(backend.clone(), "fake");
        assert!(session.launch("{}", &meta()).is_err());

        let error = session.stop().unwrap_err();
        assert_eq!(
            error.code,
            TunErrorCode::HelperMissing,
            "发起过 start 就必须如实报出来"
        );
    }

    /// 从未尝试过 start、本地也没有 pid：断开代理连接不该因为助手不在而失败。
    #[test]
    fn a_helper_missing_before_any_start_attempt_is_swallowed() {
        let backend = Arc::new(FakeBackend::new());
        *backend.stop_error.lock().unwrap() = Some(TunErrorCode::HelperMissing);

        let session = TunSession::with_backend(backend, "fake");
        assert!(session.stop().is_ok());
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

    /// 回滚时进程已经停了，但缓存还要清：flush 不能依赖运行状态。
    #[test]
    fn dns_flush_reaches_the_backend_even_when_stopped() {
        let backend = Arc::new(FakeBackend::new());
        let session = TunSession::with_backend(backend.clone(), "fake");
        assert!(matches!(session.status(), TunState::Stopped));
        session.flush_dns().unwrap();
        assert_eq!(backend.flushes.load(Ordering::SeqCst), 1);
    }

    /// 契约 §2.3.1：未探测时乐观 true；**连续两次**失败才置 false。
    #[test]
    fn tun_data_plane_needs_two_consecutive_failures() {
        let session = TunSession::new(Arc::new(FakeRegistration { ready: true }));
        session.force_running_for_test(9, Some("cfg"));
        session.begin_data_plane();
        assert!(session.data_plane_health().0, "连接后头 10s 按乐观处理");

        assert!(!session.record_data_plane(false), "第一次失败不能翻转");
        assert!(session.data_plane_health().0, "单次失败不该让界面闪红");

        assert!(session.record_data_plane(false), "连续第二次失败才翻转");
        assert!(!session.data_plane_health().0);
    }

    /// 一次成功立即回 true；之后要重新连续两次失败才会再降级。
    #[test]
    fn tun_data_plane_recovers_on_the_first_success() {
        let session = TunSession::new(Arc::new(FakeRegistration { ready: true }));
        session.force_running_for_test(9, Some("cfg"));
        session.begin_data_plane();
        session.record_data_plane(false);
        session.record_data_plane(false);
        assert!(!session.data_plane_health().0);

        assert!(session.record_data_plane(true), "成功要立刻翻转回 true");
        assert!(session.data_plane_health().0);

        session.record_data_plane(false);
        assert!(session.data_plane_health().0, "恢复后单次失败不再翻回去");
    }

    /// 没有用户流量不是失败：判据只有探测请求的结果，
    /// session 里根本没有「流量」这个输入，不会因为用户没上网就报不通。
    #[test]
    fn tun_data_plane_does_not_read_user_traffic() {
        let session = TunSession::new(Arc::new(FakeRegistration { ready: true }));
        session.force_running_for_test(9, Some("cfg"));
        session.begin_data_plane();

        let (data_plane, checked_at) = session.data_plane_health();
        assert!(data_plane, "零流量 + 未探测时仍然是乐观 true");
        assert!(!checked_at.is_empty(), "checked_at 必须有值，UI 要算新鲜度");
    }

    /// 新连接（身份变化）不能继承上一条连接的失败次数。
    #[test]
    fn a_new_tun_connection_starts_optimistic_again() {
        let session = TunSession::new(Arc::new(FakeRegistration { ready: true }));
        session.force_running_for_test(9, Some("cfg"));
        session.begin_data_plane();
        session.record_data_plane(false);
        session.record_data_plane(false);
        assert!(!session.data_plane_health().0);

        session.force_running_for_test(10, Some("cfg"));
        session.begin_data_plane();
        assert!(session.data_plane_health().0);
    }

    /// 健康循环靠身份判断「是不是新连接」：pid 变了必须算新连接。
    #[test]
    fn the_running_identity_follows_the_connection() {
        let session = TunSession::new(Arc::new(FakeRegistration { ready: true }));
        assert_eq!(session.running_identity(), None);

        session.force_running_for_test(1, Some("cfg"));
        let first = session.running_identity();
        assert!(first.is_some());

        session.force_running_for_test(2, Some("cfg"));
        assert_ne!(first, session.running_identity(), "换了进程就是新连接");
    }

    /// 启动会卡在 `start` 的假后端：模拟 helper 正在拉 sing-box 的那段窗口。
    struct SlowStartBackend {
        entered: Mutex<Option<std::sync::mpsc::Sender<()>>>,
        release: Mutex<Option<std::sync::mpsc::Receiver<()>>>,
        stops: AtomicUsize,
    }

    impl SlowStartBackend {
        fn new(
            entered: std::sync::mpsc::Sender<()>,
            release: std::sync::mpsc::Receiver<()>,
        ) -> Self {
            Self {
                entered: Mutex::new(Some(entered)),
                release: Mutex::new(Some(release)),
                stops: AtomicUsize::new(0),
            }
        }
    }

    impl TunBackend for SlowStartBackend {
        fn availability(&self) -> Result<HelperStatus, TunError> {
            Ok(HelperStatus::Enabled)
        }
        fn ensure_available(&self) -> Result<HelperStatus, TunError> {
            Ok(HelperStatus::Enabled)
        }
        fn start(&self, _config: &str) -> Result<StartReply, TunError> {
            if let Some(entered) = self.entered.lock().unwrap().take() {
                let _ = entered.send(());
            }
            let release = self.release.lock().unwrap().take().expect("只启动一次");
            release
                .recv_timeout(Duration::from_secs(5))
                .expect("测试要放行这次 start");
            Ok(StartReply {
                pid: 7777,
                clash_api: ClashApi {
                    addr: "127.0.0.1:51234".into(),
                    secret: "s".into(),
                },
                since: "2026-11-05T00:00:00Z".into(),
                dns_hijack: DnsHijack::default(),
            })
        }
        fn stop(&self) -> Result<(), TunError> {
            self.stops.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }
        fn status(&self) -> Result<TunSnapshot, TunError> {
            // helper 还没拉起 sing-box：这段时间后端看到的就是没在跑。
            Ok(TunSnapshot {
                running: false,
                pid: None,
                clash_api: None,
                since: None,
                last_error: None,
                dns_hijack: DnsHijack::default(),
                helper_build: None,
                helper_version: None,
                helper_pid: None,
            })
        }
        fn restart(&self) -> Result<(), TunError> {
            Ok(())
        }
    }

    /// 启动窗口里断开：迟到的 start 不得写成 Running、不得改连接上下文，
    /// 而且 helper 刚拉起来的实例必须被停掉。
    #[test]
    fn a_cancelled_start_never_becomes_running() {
        let (entered_tx, entered_rx) = std::sync::mpsc::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let backend = Arc::new(SlowStartBackend::new(entered_tx, release_rx));
        let session = Arc::new(TunSession::with_backend(backend.clone(), "fake"));

        let worker_session = Arc::clone(&session);
        let meta = meta();
        let handle = std::thread::spawn(move || worker_session.launch("{}", &meta));

        entered_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("start 已经进入 helper");
        assert!(session.is_launching(), "启动窗口必须对上层可见");
        assert_eq!(session.launching_config_id().as_deref(), Some("cfg_test"));

        session.stop().expect("断开要能取消在途启动");
        assert!(!session.is_launching(), "取消后不能再报「正在连」");

        release_tx.send(()).expect("放行迟到的 start");
        let result = handle.join().expect("工作线程不能 panic");
        assert!(result.is_err(), "被取消的启动不得报成功");

        assert_eq!(session.status(), TunState::Stopped);
        assert!(session.connected_config_id().is_none());
        assert_eq!(
            backend.stops.load(Ordering::SeqCst),
            2,
            "断开停一次，迟到的实例还要再停一次"
        );
    }

    /// 新连接已经把 start 发出去：helper 的替换语义会收掉旧实例，
    /// 这时旧启动再停一次（stop 是全局的）会误杀新连接。
    #[test]
    fn a_superseded_start_leaves_the_instance_to_the_newer_launch() {
        let (entered_tx, entered_rx) = std::sync::mpsc::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let backend = Arc::new(SlowStartBackend::new(entered_tx, release_rx));
        let session = Arc::new(TunSession::with_backend(backend.clone(), "fake"));

        let worker_session = Arc::clone(&session);
        let meta = meta();
        let handle = std::thread::spawn(move || worker_session.launch("{}", &meta));
        entered_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("start 已经进入 helper");

        // 用户切到另一套：旧代次作废，新启动已经登记并发出了 start。
        assert!(session.cancel_launch());
        let newer = session.begin_launch("cfg_new");
        session.mark_start_sent(newer.seq);

        release_tx.send(()).expect("放行迟到的 start");
        let result = handle.join().expect("工作线程不能 panic");
        assert!(result.is_err(), "被取代的启动不得报成功");
        assert_eq!(
            backend.stops.load(Ordering::SeqCst),
            0,
            "新连接已发出 start，旧启动不能再停后端"
        );
        assert!(session.is_launching(), "新启动的登记不能被旧启动撤掉");
        drop(newer);
    }

    /// 新启动还卡在检查 / 授权阶段，压根没发 start：旧实例没人收，必须由这里停掉，
    /// 否则界面显示未连接、root 隧道还在。
    #[test]
    fn a_superseded_start_stops_the_old_instance_when_the_newer_never_started() {
        let (entered_tx, entered_rx) = std::sync::mpsc::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let backend = Arc::new(SlowStartBackend::new(entered_tx, release_rx));
        let session = Arc::new(TunSession::with_backend(backend.clone(), "fake"));

        let worker_session = Arc::clone(&session);
        let meta = meta();
        let handle = std::thread::spawn(move || worker_session.launch("{}", &meta));
        entered_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("start 已经进入 helper");

        assert!(session.cancel_launch());
        let newer = session.begin_launch("cfg_new");

        release_tx.send(()).expect("放行迟到的 start");
        assert!(handle.join().expect("工作线程不能 panic").is_err());
        assert_eq!(
            backend.stops.load(Ordering::SeqCst),
            1,
            "新启动还没发 start，旧实例必须在这里停掉"
        );
        assert!(session.is_launching(), "补停不能撤掉新启动的登记");
        drop(newer);
    }

    /// 取消发生在 helper 检查之前：不要再发 start，提前返回。
    #[test]
    fn a_cancelled_launch_never_reaches_the_backend() {
        let backend = Arc::new(FakeBackend::new());
        let session = TunSession::with_backend(backend.clone(), "fake");
        let slot = session.begin_launch("cfg_a");
        assert!(session.cancel_launch());

        let error = session
            .launch_registered(slot, "{}", &meta())
            .expect_err("已取消的启动必须提前返回");
        assert_eq!(error.code, TunErrorCode::Cancelled);
        assert_eq!(
            backend.starts.load(Ordering::SeqCst),
            0,
            "取消后不得再向 helper 发 start"
        );
        assert_eq!(session.status(), TunState::Stopped);
    }

    /// 在途启动对上层可见，收尾后变回 Running；丢弃凭据则撤销登记。
    #[test]
    fn a_launch_is_visible_until_it_lands() {
        let session = TunSession::with_backend(Arc::new(FakeBackend::new()), "fake");
        let meta = meta();
        let slot = session.begin_launch(&meta.config_id);
        assert!(session.is_launching());
        assert_eq!(session.launching_config_id().as_deref(), Some("cfg_test"));

        let reply = StartReply {
            pid: 88,
            clash_api: ClashApi {
                addr: "127.0.0.1:51234".into(),
                secret: "s".into(),
            },
            since: "2026-11-05T00:00:00Z".into(),
            dns_hijack: DnsHijack::default(),
        };
        assert!(slot.commit(&meta, &reply));
        assert!(!session.is_launching());
        assert_eq!(session.status(), TunState::Running { pid: 88 });
        assert_eq!(session.connected_config_id().as_deref(), Some("cfg_test"));
    }

    /// 失败或提前返回时凭据被丢弃：不能把「正在连」永远挂着。
    #[test]
    fn a_dropped_launch_clears_the_flag() {
        let session = TunSession::with_backend(Arc::new(FakeBackend::new()), "fake");
        {
            let _slot = session.begin_launch("cfg_a");
            assert!(session.is_launching());
        }
        assert!(!session.is_launching());
        assert_eq!(session.status(), TunState::Stopped);
    }
}
