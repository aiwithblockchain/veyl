use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use serde::Serialize;
use sha2::{Digest, Sha256};
use tokio::process::Child;
use tokio::sync::{broadcast, Mutex, Notify};
use tokio::time::Instant;

use super::error::{RuntimeError, RuntimeResult};
use super::health::{ClashApi, DataPlaneProbe};
use super::process::{self, SpawnOptions};

pub const CONTRACT_VERSION: &str = "1.0.2";
pub const EVENT_CONTRACT_VERSION: &str = "1.0.3";

/// 契约要求数据面检查默认开启（2026-11-02 拍板），置 `None` 可关闭。
pub const DEFAULT_DATA_PLANE_PROBE: &str = "http://cp.cloudflare.com/generate_204";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RuntimeState {
    Idle,
    Starting,
    Running,
    Degraded,
    Restarting,
    Stopping,
    Failed,
}

impl RuntimeState {
    pub fn as_str(self) -> &'static str {
        match self {
            RuntimeState::Idle => "idle",
            RuntimeState::Starting => "starting",
            RuntimeState::Running => "running",
            RuntimeState::Degraded => "degraded",
            RuntimeState::Restarting => "restarting",
            RuntimeState::Stopping => "stopping",
            RuntimeState::Failed => "failed",
        }
    }

    fn terminal(self) -> bool {
        matches!(self, RuntimeState::Idle | RuntimeState::Failed)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RuntimeMode {
    SystemProxy,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RuntimeEventKind {
    StartReq,
    ProcessReady,
    HealthOk,
    HealthFail,
    Crash,
    StopReq,
    RestartReq,
    Stopped,
    GiveUp,
}

impl RuntimeEventKind {
    fn as_str(self) -> &'static str {
        match self {
            RuntimeEventKind::StartReq => "start_req",
            RuntimeEventKind::ProcessReady => "process_ready",
            RuntimeEventKind::HealthOk => "health_ok",
            RuntimeEventKind::HealthFail => "health_fail",
            RuntimeEventKind::Crash => "crash",
            RuntimeEventKind::StopReq => "stop_req",
            RuntimeEventKind::RestartReq => "restart_req",
            RuntimeEventKind::Stopped => "stopped",
            RuntimeEventKind::GiveUp => "give_up",
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct HealthSnapshot {
    pub contract_version: &'static str,
    pub process: bool,
    pub clash_api: bool,
    pub data_plane: bool,
    pub exit_ip: Option<String>,
    pub consecutive_failures: u32,
    pub checked_at: String,
}

impl Default for HealthSnapshot {
    fn default() -> Self {
        Self {
            contract_version: CONTRACT_VERSION,
            process: false,
            clash_api: false,
            // 契约：未探测时 data_plane = true，UI 才能区分「未探测」与「失败」。
            data_plane: true,
            exit_ip: None,
            consecutive_failures: 0,
            checked_at: now_iso(),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct RuntimeStatus {
    pub contract_version: &'static str,
    pub state: RuntimeState,
    pub mode: Option<RuntimeMode>,
    pub pid: Option<u32>,
    pub upstream_version: Option<String>,
    pub uptime_seconds: Option<u64>,
    pub profile_id: Option<String>,
    pub config_hash: Option<String>,
    pub system_proxy_enabled: bool,
    pub health: HealthSnapshot,
    /// P2 才采集；P1 恒为 null。
    pub traffic: Option<serde_json::Value>,
    /// P2 才采集；P1 恒为 null。
    pub connections: Option<u32>,
    pub restart_count: u32,
    pub last_error: Option<String>,
    pub last_transition_at: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct RuntimeStateChangedPayload {
    pub contract_version: &'static str,
    pub from: RuntimeState,
    pub to: RuntimeState,
    pub event: &'static str,
    pub pid: Option<u32>,
    pub upstream_version: Option<String>,
    pub reason: Option<String>,
    pub emitted_at: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct RuntimeHealthChangedPayload {
    pub contract_version: &'static str,
    pub health: HealthSnapshot,
    pub emitted_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "event", content = "payload")]
pub enum RuntimeEvent {
    #[serde(rename = "runtime-state-changed")]
    StateChanged(RuntimeStateChangedPayload),
    #[serde(rename = "runtime-health-changed")]
    HealthChanged(RuntimeHealthChangedPayload),
}

#[derive(Debug, Clone)]
pub struct RuntimeConfig {
    pub app_data_dir: PathBuf,
    pub startup_timeout: Duration,
    pub health_interval: Duration,
    pub tick_interval: Duration,
    pub stop_grace: Duration,
    pub max_restarts: u32,
    /// 连续 running 满该时长后，崩溃重启计数归零。
    pub restart_count_reset_after: Duration,
    /// degraded 持续该时长仍不恢复则自动重启。
    pub degraded_restart_after: Duration,
    /// 关闭（`None`）时不做数据面探测。
    pub data_plane_probe: Option<String>,
}

impl RuntimeConfig {
    pub fn new(app_data_dir: impl Into<PathBuf>) -> Self {
        Self {
            app_data_dir: app_data_dir.into(),
            startup_timeout: Duration::from_secs(10),
            health_interval: Duration::from_secs(2),
            tick_interval: Duration::from_secs(1),
            stop_grace: Duration::from_secs(5),
            max_restarts: 3,
            restart_count_reset_after: Duration::from_secs(60),
            degraded_restart_after: Duration::from_secs(30),
            data_plane_probe: Some(DEFAULT_DATA_PLANE_PROBE.to_string()),
        }
    }

    pub fn log_dir(&self) -> PathBuf {
        self.app_data_dir.join("logs")
    }
}

impl Default for RuntimeConfig {
    fn default() -> Self {
        Self::new(default_app_data_dir())
    }
}

#[derive(Clone)]
pub struct StartPlan {
    pub version: String,
    pub binary: PathBuf,
    pub config_path: PathBuf,
    pub work_dir: PathBuf,
    pub log_path: PathBuf,
    pub clash_addr: String,
    pub clash_secret: String,
    pub mixed_port: u16,
    pub profile_id: Option<String>,
}

impl std::fmt::Debug for StartPlan {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("StartPlan")
            .field("version", &self.version)
            .field("binary", &self.binary)
            .field("config_path", &self.config_path)
            .field("work_dir", &self.work_dir)
            .field("log_path", &self.log_path)
            .field("clash_addr", &self.clash_addr)
            .field("clash_secret", &"<redacted>")
            .field("mixed_port", &self.mixed_port)
            .field("profile_id", &self.profile_id)
            .finish()
    }
}

impl StartPlan {
    pub fn log_path(cfg: &RuntimeConfig, version: &str) -> PathBuf {
        cfg.log_dir().join(format!("runtime-{version}.log"))
    }
}

struct Inner {
    state: RuntimeState,
    plan: Option<StartPlan>,
    child: Option<Child>,
    pid: Option<u32>,
    version: Option<String>,
    restart_count: u32,
    last_error: Option<String>,
    generation: u64,
    desired_stop: bool,
    running_since: Option<Instant>,
    last_transition_at: String,
    config_hash: Option<String>,
    system_proxy_enabled: bool,
    health: HealthSnapshot,
}

impl Inner {
    fn new() -> Self {
        Self {
            state: RuntimeState::Idle,
            plan: None,
            child: None,
            pid: None,
            version: None,
            restart_count: 0,
            last_error: None,
            generation: 0,
            desired_stop: false,
            running_since: None,
            last_transition_at: now_iso(),
            config_hash: None,
            system_proxy_enabled: false,
            health: HealthSnapshot::default(),
        }
    }

    fn snapshot(&self) -> RuntimeStatus {
        let terminal = self.state.terminal();
        let running = !terminal && self.state != RuntimeState::Idle;

        RuntimeStatus {
            contract_version: CONTRACT_VERSION,
            state: self.state,
            mode: if running {
                Some(RuntimeMode::SystemProxy)
            } else {
                None
            },
            pid: if terminal { None } else { self.pid },
            upstream_version: if terminal { None } else { self.version.clone() },
            uptime_seconds: self.running_since.map(|since| since.elapsed().as_secs()),
            profile_id: self.plan.as_ref().and_then(|p| p.profile_id.clone()),
            config_hash: self.config_hash.clone(),
            system_proxy_enabled: self.system_proxy_enabled,
            health: self.health.clone(),
            traffic: None,
            connections: None,
            restart_count: self.restart_count,
            last_error: self.last_error.clone(),
            last_transition_at: self.last_transition_at.clone(),
        }
    }
}

enum SuperviseExit {
    Stopped,
    Crash(String),
}

pub struct RuntimeManager {
    pub cfg: RuntimeConfig,
    inner: Mutex<Inner>,
    events: broadcast::Sender<RuntimeEvent>,
    wake: Notify,
}

impl RuntimeManager {
    pub fn new(cfg: RuntimeConfig) -> Arc<Self> {
        let (events, _) = broadcast::channel(256);
        Arc::new(Self {
            cfg,
            inner: Mutex::new(Inner::new()),
            events,
            wake: Notify::new(),
        })
    }

    pub fn subscribe(&self) -> broadcast::Receiver<RuntimeEvent> {
        self.events.subscribe()
    }

    pub async fn status(&self) -> RuntimeStatus {
        self.inner.lock().await.snapshot()
    }

    /// 由连接编排层在设置/恢复系统代理后调用。
    pub async fn set_system_proxy_enabled(&self, enabled: bool) {
        self.inner.lock().await.system_proxy_enabled = enabled;
    }

    /// 出口 IP 由连接编排层探测后回填，用于状态快照展示。
    pub async fn set_exit_ip(&self, exit_ip: Option<String>) {
        let mut inner = self.inner.lock().await;
        inner.health.exit_ip = exit_ip;
        inner.health.checked_at = now_iso();
    }

    /// 正在使用（含启动、切换、停止中）的 profile；`None` 表示没有活动连接。
    pub async fn active_profile_id(&self) -> Option<String> {
        let inner = self.inner.lock().await;
        match inner.state {
            RuntimeState::Starting
            | RuntimeState::Running
            | RuntimeState::Degraded
            | RuntimeState::Restarting
            | RuntimeState::Stopping => inner.plan.as_ref().and_then(|p| p.profile_id.clone()),
            _ => None,
        }
    }

    /// ProfileDelete 的准入检查：active profile 一律拒绝，不自动断开。
    pub async fn ensure_profile_not_active(&self, profile_id: &str) -> RuntimeResult<()> {
        match self.active_profile_id().await {
            Some(active) if active == profile_id => Err(RuntimeError::Precondition {
                reason: "ACTIVE_PROFILE_IN_USE",
                message: format!("profile {profile_id} is in use; disconnect before deleting"),
            }),
            _ => Ok(()),
        }
    }

    pub async fn start(self: &Arc<Self>, plan: StartPlan) -> RuntimeResult<RuntimeStatus> {
        let (stale_child, gen, from, version) = {
            let mut inner = self.inner.lock().await;
            if matches!(
                inner.state,
                RuntimeState::Starting
                    | RuntimeState::Running
                    | RuntimeState::Degraded
                    | RuntimeState::Restarting
            ) {
                return Ok(inner.snapshot());
            }

            if !plan.binary.is_file() {
                return Err(RuntimeError::NotInstalled);
            }

            let from = inner.state;
            inner.generation += 1;
            inner.desired_stop = false;
            inner.restart_count = 0;
            inner.last_error = None;
            inner.running_since = None;
            inner.health = HealthSnapshot::default();
            inner.config_hash = hash_file(&plan.config_path);
            inner.version = Some(plan.version.clone());
            inner.plan = Some(plan.clone());
            inner.state = RuntimeState::Starting;
            inner.last_transition_at = now_iso();

            (
                inner.child.take(),
                inner.generation,
                from,
                plan.version.clone(),
            )
        };

        if let Some(mut child) = stale_child {
            let _ = process::terminate(&mut child, self.cfg.stop_grace).await;
        }

        self.emit(RuntimeEvent::StateChanged(state_payload(
            from,
            RuntimeState::Starting,
            RuntimeEventKind::StartReq,
            None,
            None,
            Some(version),
        )));

        let manager = Arc::clone(self);
        tokio::spawn(async move {
            manager.engine(gen).await;
        });

        let budget = self.cfg.startup_timeout + Duration::from_secs(2);
        self.wait_settled(gen, budget).await
    }

    pub async fn stop(&self) -> RuntimeResult<RuntimeStatus> {
        let (child, from) = {
            let mut inner = self.inner.lock().await;
            if inner.state == RuntimeState::Idle && inner.child.is_none() {
                return Ok(inner.snapshot());
            }
            let from = inner.state;
            inner.generation += 1;
            inner.desired_stop = true;
            inner.state = RuntimeState::Stopping;
            inner.last_transition_at = now_iso();
            (inner.child.take(), from)
        };

        self.wake.notify_waiters();
        self.emit(RuntimeEvent::StateChanged(RuntimeStateChangedPayload {
            contract_version: EVENT_CONTRACT_VERSION,
            from,
            to: RuntimeState::Stopping,
            event: RuntimeEventKind::StopReq.as_str(),
            pid: None,
            upstream_version: None,
            reason: None,
            emitted_at: now_iso(),
        }));

        if let Some(mut child) = child {
            let _ = process::terminate(&mut child, self.cfg.stop_grace).await;
        }

        let snapshot = {
            let mut inner = self.inner.lock().await;
            inner.state = RuntimeState::Idle;
            inner.pid = None;
            inner.running_since = None;
            inner.child = None;
            inner.last_transition_at = now_iso();
            inner.snapshot()
        };

        self.emit(RuntimeEvent::StateChanged(RuntimeStateChangedPayload {
            contract_version: EVENT_CONTRACT_VERSION,
            from: RuntimeState::Stopping,
            to: RuntimeState::Idle,
            event: RuntimeEventKind::Stopped.as_str(),
            pid: None,
            upstream_version: None,
            reason: None,
            emitted_at: now_iso(),
        }));

        Ok(snapshot)
    }

    pub async fn restart(self: &Arc<Self>) -> RuntimeResult<RuntimeStatus> {
        let (plan, current) = {
            let inner = self.inner.lock().await;
            (inner.plan.clone(), inner.state.as_str().to_string())
        };

        let plan = plan.ok_or_else(|| RuntimeError::InvalidState {
            current,
            action: "restart".into(),
        })?;

        self.stop().await?;
        self.start(plan).await
    }

    async fn engine(self: Arc<Self>, gen: u64) {
        let mut restarts: u32 = 0;

        loop {
            if !self.is_current(gen).await {
                return;
            }

            let plan = match self.plan_of(gen).await {
                Some(plan) => plan,
                None => return,
            };

            self.kill_child().await;

            let options = SpawnOptions {
                binary: plan.binary.clone(),
                config: plan.config_path.clone(),
                work_dir: plan.work_dir.clone(),
                log_path: plan.log_path.clone(),
            };

            let mut child = match process::spawn(&options).await {
                Ok(child) => child,
                Err(e) => {
                    self.fail(gen, e.to_string()).await;
                    return;
                }
            };

            let pid = child.id();
            {
                let mut inner = self.inner.lock().await;
                if inner.generation != gen || inner.desired_stop {
                    drop(inner);
                    let _ = process::terminate(&mut child, Duration::from_secs(1)).await;
                    return;
                }
                inner.pid = pid;
                inner.child = Some(child);
            }

            if !self.wait_until_ready(gen, &plan).await {
                let reason = self
                    .last_error()
                    .await
                    .unwrap_or_else(|| "runtime did not become ready".into());
                self.kill_child().await;
                // 契约：starting + CRASH → failed，启动失败不重试。
                self.fail(gen, reason).await;
                return;
            }

            self.enter_running(gen).await;

            match self.supervise(gen, &plan).await {
                SuperviseExit::Stopped => return,
                SuperviseExit::Crash(reason) => {
                    self.kill_child().await;

                    if self.running_for(gen).await >= self.cfg.restart_count_reset_after {
                        restarts = 0;
                        self.set_restart_count(0).await;
                    }

                    restarts += 1;
                    self.set_restart_count(restarts).await;

                    if restarts > self.cfg.max_restarts {
                        self.give_up(gen, reason).await;
                        return;
                    }

                    self.transition(
                        gen,
                        RuntimeState::Restarting,
                        RuntimeEventKind::Crash,
                        Some(reason),
                    )
                    .await;

                    let backoff = backoff_for(restarts);
                    tokio::select! {
                        _ = tokio::time::sleep(backoff) => {}
                        _ = self.wake.notified() => {}
                    }

                    if !self.is_current(gen).await {
                        return;
                    }
                    self.transition(
                        gen,
                        RuntimeState::Starting,
                        RuntimeEventKind::StartReq,
                        None,
                    )
                    .await;
                }
            }
        }
    }

    async fn wait_until_ready(&self, gen: u64, plan: &StartPlan) -> bool {
        let api = ClashApi::new(&plan.clash_addr, &plan.clash_secret);
        let deadline = Instant::now() + self.cfg.startup_timeout;

        loop {
            if !self.is_current(gen).await {
                return false;
            }

            let exited = {
                let mut inner = self.inner.lock().await;
                match inner.child.as_mut() {
                    Some(child) => process::try_exit(child),
                    None => Some("process handle is missing".to_string()),
                }
            };
            if let Some(reason) = exited {
                self.record_error(reason).await;
                return false;
            }

            if api.healthy().await {
                self.update_health(|health| {
                    health.process = true;
                    health.clash_api = true;
                    health.consecutive_failures = 0;
                    health.checked_at = now_iso();
                })
                .await;
                self.emit_health().await;
                return true;
            }

            if Instant::now() >= deadline {
                self.record_error(format!(
                    "startup timed out after {} ms",
                    self.cfg.startup_timeout.as_millis()
                ))
                .await;
                return false;
            }

            tokio::time::sleep(Duration::from_millis(200)).await;
        }
    }

    async fn supervise(&self, gen: u64, plan: &StartPlan) -> SuperviseExit {
        let api = ClashApi::new(&plan.clash_addr, &plan.clash_secret);
        let probe = self
            .cfg
            .data_plane_probe
            .as_ref()
            .and_then(|url| DataPlaneProbe::new(url.clone(), plan.mixed_port).ok());

        let mut failures: u32 = 0;
        let mut degraded_since: Option<Instant> = None;
        let mut next_health = Instant::now() + self.cfg.health_interval;
        let mut next_probe = Instant::now() + Duration::from_secs(10);

        loop {
            tokio::select! {
                _ = self.wake.notified() => {}
                _ = tokio::time::sleep(self.cfg.tick_interval) => {}
            }

            {
                let inner = self.inner.lock().await;
                if inner.generation != gen
                    || inner.desired_stop
                    || !matches!(inner.state, RuntimeState::Running | RuntimeState::Degraded)
                {
                    return SuperviseExit::Stopped;
                }
            }

            let exited = {
                let mut inner = self.inner.lock().await;
                match inner.child.as_mut() {
                    Some(child) => process::try_exit(child),
                    None => Some("process handle is missing".to_string()),
                }
            };
            if let Some(reason) = exited {
                self.update_health(|health| {
                    health.process = false;
                    health.checked_at = now_iso();
                })
                .await;
                self.emit_health().await;
                return SuperviseExit::Crash(reason);
            }

            if Instant::now() >= next_health {
                next_health = Instant::now() + self.cfg.health_interval;
                let ok = api.healthy().await;

                if ok {
                    if failures > 0 {
                        failures = 0;
                    }
                    self.update_health(|health| {
                        health.process = true;
                        health.clash_api = true;
                        health.consecutive_failures = 0;
                        health.checked_at = now_iso();
                    })
                    .await;

                    if degraded_since.take().is_some() {
                        self.transition(gen, RuntimeState::Running, RuntimeEventKind::HealthOk, None)
                            .await;
                    }
                } else {
                    failures += 1;
                    self.update_health(|health| {
                        health.process = true;
                        health.clash_api = false;
                        health.consecutive_failures = failures;
                        health.checked_at = now_iso();
                    })
                    .await;

                    if failures >= 3 && degraded_since.is_none() {
                        degraded_since = Some(Instant::now());
                        self.transition(
                            gen,
                            RuntimeState::Degraded,
                            RuntimeEventKind::HealthFail,
                            Some("clash_api_unavailable".into()),
                        )
                        .await;
                    }
                }
                self.emit_health().await;
            }

            if let Some(probe) = &probe {
                if Instant::now() >= next_probe {
                    next_probe = Instant::now() + Duration::from_secs(10);
                    // 契约：数据面失败只更新快照，不单独判 HEALTH_FAIL。
                    let ok = probe.ok().await;
                    self.update_health(|health| {
                        health.data_plane = ok;
                        health.checked_at = now_iso();
                    })
                    .await;
                    self.emit_health().await;
                }
            }

            if let Some(since) = degraded_since {
                if since.elapsed() >= self.cfg.degraded_restart_after {
                    return SuperviseExit::Crash(
                        "degraded without recovery; restarting".to_string(),
                    );
                }
            }
        }
    }

    async fn enter_running(&self, gen: u64) {
        let payload = {
            let mut inner = self.inner.lock().await;
            if inner.generation != gen || inner.desired_stop {
                return;
            }
            let from = inner.state;
            inner.state = RuntimeState::Running;
            inner.running_since = Some(Instant::now());
            inner.pid = inner.child.as_ref().and_then(|c| c.id());
            inner.last_transition_at = now_iso();
            state_payload(
                from,
                RuntimeState::Running,
                RuntimeEventKind::ProcessReady,
                None,
                inner.pid,
                inner.version.clone(),
            )
        };
        self.emit(RuntimeEvent::StateChanged(payload));
    }

    async fn fail(&self, gen: u64, reason: String) {
        {
            let mut inner = self.inner.lock().await;
            if inner.generation != gen {
                return;
            }
            inner.last_error = Some(reason.clone());
        }
        self.transition(gen, RuntimeState::Failed, RuntimeEventKind::Crash, Some(reason))
            .await;
    }

    async fn give_up(&self, gen: u64, reason: String) {
        {
            let mut inner = self.inner.lock().await;
            if inner.generation != gen {
                return;
            }
            inner.last_error = Some(reason.clone());
        }
        self.transition(gen, RuntimeState::Failed, RuntimeEventKind::GiveUp, Some(reason))
            .await;
    }

    async fn transition(
        &self,
        gen: u64,
        to: RuntimeState,
        event: RuntimeEventKind,
        reason: Option<String>,
    ) {
        let payload = {
            let mut inner = self.inner.lock().await;
            if inner.generation != gen {
                return;
            }
            let from = inner.state;
            inner.state = to;
            inner.last_transition_at = now_iso();
            if to.terminal() {
                inner.pid = None;
                inner.running_since = None;
            }
            state_payload(
                from,
                to,
                event,
                reason,
                if to.terminal() { None } else { inner.pid },
                if to.terminal() {
                    None
                } else {
                    inner.version.clone()
                },
            )
        };
        self.emit(RuntimeEvent::StateChanged(payload));
    }

    async fn update_health(&self, update: impl FnOnce(&mut HealthSnapshot)) {
        let mut inner = self.inner.lock().await;
        update(&mut inner.health);
    }

    async fn emit_health(&self) {
        let health = { self.inner.lock().await.health.clone() };
        self.emit(RuntimeEvent::HealthChanged(RuntimeHealthChangedPayload {
            contract_version: EVENT_CONTRACT_VERSION,
            health,
            emitted_at: now_iso(),
        }));
    }

    async fn set_restart_count(&self, count: u32) {
        self.inner.lock().await.restart_count = count;
    }

    async fn running_for(&self, gen: u64) -> Duration {
        let inner = self.inner.lock().await;
        if inner.generation != gen {
            return Duration::ZERO;
        }
        inner
            .running_since
            .map(|since| since.elapsed())
            .unwrap_or(Duration::ZERO)
    }

    async fn kill_child(&self) {
        let child = { self.inner.lock().await.child.take() };
        if let Some(mut child) = child {
            let _ = process::terminate(&mut child, self.cfg.stop_grace).await;
        }
    }

    async fn plan_of(&self, gen: u64) -> Option<StartPlan> {
        let inner = self.inner.lock().await;
        if inner.generation != gen || inner.desired_stop {
            None
        } else {
            inner.plan.clone()
        }
    }

    async fn is_current(&self, gen: u64) -> bool {
        let inner = self.inner.lock().await;
        inner.generation == gen && !inner.desired_stop
    }

    async fn record_error(&self, reason: String) {
        self.inner.lock().await.last_error = Some(reason);
    }

    async fn last_error(&self) -> Option<String> {
        self.inner.lock().await.last_error.clone()
    }

    async fn wait_settled(&self, gen: u64, budget: Duration) -> RuntimeResult<RuntimeStatus> {
        let deadline = Instant::now() + budget;

        loop {
            {
                let inner = self.inner.lock().await;
                if inner.generation != gen {
                    return Ok(inner.snapshot());
                }
                match inner.state {
                    RuntimeState::Running => return Ok(inner.snapshot()),
                    RuntimeState::Failed => {
                        return Err(RuntimeError::Process(
                            inner
                                .last_error
                                .clone()
                                .unwrap_or_else(|| "runtime failed to start".into()),
                        ))
                    }
                    RuntimeState::Idle => return Ok(inner.snapshot()),
                    _ => {}
                }
            }

            if Instant::now() >= deadline {
                return Err(RuntimeError::StartupTimeout(budget.as_millis() as u64));
            }

            tokio::select! {
                _ = self.wake.notified() => {}
                _ = tokio::time::sleep(Duration::from_millis(50)) => {}
            }
        }
    }

    fn emit(&self, event: RuntimeEvent) {
        let _ = self.events.send(event);
    }
}

fn state_payload(
    from: RuntimeState,
    to: RuntimeState,
    event: RuntimeEventKind,
    reason: Option<String>,
    pid: Option<u32>,
    upstream_version: Option<String>,
) -> RuntimeStateChangedPayload {
    RuntimeStateChangedPayload {
        contract_version: EVENT_CONTRACT_VERSION,
        from,
        to,
        event: event.as_str(),
        pid,
        upstream_version,
        reason,
        emitted_at: now_iso(),
    }
}

fn hash_file(path: &std::path::Path) -> Option<String> {
    let bytes = std::fs::read(path).ok()?;
    let mut hasher = Sha256::new();
    hasher.update(&bytes);
    Some(format!("sha256:{}", hex::encode(hasher.finalize())))
}

fn backoff_for(attempt: u32) -> Duration {
    Duration::from_secs(1u64 << attempt.saturating_sub(1).min(5))
}

fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

pub fn default_app_data_dir() -> PathBuf {
    #[cfg(target_os = "macos")]
    {
        if let Ok(home) = std::env::var("HOME") {
            return PathBuf::from(home).join("Library/Application Support/AIVPN");
        }
    }

    #[cfg(windows)]
    {
        if let Ok(local) = std::env::var("LOCALAPPDATA") {
            return PathBuf::from(local).join("AIVPN");
        }
    }

    #[cfg(all(not(target_os = "macos"), not(windows)))]
    {
        if let Ok(xdg) = std::env::var("XDG_DATA_HOME") {
            return PathBuf::from(xdg).join("aivpn");
        }
        if let Ok(home) = std::env::var("HOME") {
            return PathBuf::from(home).join(".local/share/aivpn");
        }
    }

    std::env::temp_dir().join("aivpn")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        std::env::temp_dir().join(format!("aivpn-{tag}-{:016x}", rand::random::<u64>()))
    }

    fn plan(binary: PathBuf, dir: &std::path::Path) -> StartPlan {
        StartPlan {
            version: "0.0.0".into(),
            binary,
            config_path: dir.join("config.json"),
            work_dir: dir.to_path_buf(),
            log_path: dir.join("runtime.log"),
            clash_addr: "127.0.0.1:1".into(),
            clash_secret: "secret".into(),
            mixed_port: 1,
            profile_id: Some("profile-1".into()),
        }
    }

    #[test]
    fn backoff_matches_the_contract() {
        assert_eq!(backoff_for(1), Duration::from_secs(1));
        assert_eq!(backoff_for(2), Duration::from_secs(2));
        assert_eq!(backoff_for(3), Duration::from_secs(4));
    }

    #[tokio::test]
    async fn stopping_an_idle_manager_is_a_noop() {
        let dir = temp_dir("mgr");
        let manager = RuntimeManager::new(RuntimeConfig::new(&dir));
        let status = manager.stop().await.unwrap();
        assert_eq!(status.state, RuntimeState::Idle);
    }

    #[tokio::test]
    async fn a_missing_binary_fails_without_retrying() {
        let dir = temp_dir("mgr");
        std::fs::create_dir_all(&dir).unwrap();
        let manager = RuntimeManager::new(RuntimeConfig::new(&dir));

        let err = manager
            .start(plan(dir.join("does-not-exist"), &dir))
            .await
            .unwrap_err();
        assert!(matches!(err, RuntimeError::NotInstalled), "{err}");
        assert_eq!(manager.status().await.state, RuntimeState::Idle);
        assert_eq!(manager.status().await.restart_count, 0);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_startup_crash_goes_straight_to_failed() {
        use std::os::unix::fs::PermissionsExt;

        let dir = temp_dir("crash");
        std::fs::create_dir_all(&dir).unwrap();
        let fake = dir.join("fake-sing-box");
        std::fs::write(&fake, "#!/bin/sh\nexit 1\n").unwrap();
        std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o755)).unwrap();

        let mut cfg = RuntimeConfig::new(&dir);
        cfg.startup_timeout = Duration::from_millis(300);
        let manager = RuntimeManager::new(cfg);
        let mut events = manager.subscribe();

        let err = manager.start(plan(fake, &dir)).await.unwrap_err();
        assert!(matches!(err, RuntimeError::Process(_)), "{err}");

        let status = manager.status().await;
        assert_eq!(status.state, RuntimeState::Failed);
        assert_eq!(status.restart_count, 0);
        assert!(status.pid.is_none());
        assert!(status.upstream_version.is_none());
        assert!(status.last_error.is_some());

        let mut restarts = 0;
        while let Ok(event) = events.try_recv() {
            if let RuntimeEvent::StateChanged(payload) = event {
                assert!(
                    matches!(
                        payload.event,
                        "start_req" | "crash" | "process_ready" | "stopped"
                    ),
                    "unexpected event {}",
                    payload.event
                );
                if payload.to == RuntimeState::Restarting {
                    restarts += 1;
                }
            }
        }
        assert_eq!(restarts, 0);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn an_active_profile_cannot_be_deleted() {
        let dir = temp_dir("active");
        std::fs::create_dir_all(&dir).unwrap();
        let manager = RuntimeManager::new(RuntimeConfig::new(&dir));

        assert!(manager.active_profile_id().await.is_none());
        assert!(manager.ensure_profile_not_active("profile-1").await.is_ok());

        {
            let mut inner = manager.inner.lock().await;
            inner.state = RuntimeState::Running;
            inner.plan = Some(plan(PathBuf::from("/nonexistent"), &dir));
        }

        assert_eq!(
            manager.active_profile_id().await.as_deref(),
            Some("profile-1")
        );

        let err = manager
            .ensure_profile_not_active("profile-1")
            .await
            .unwrap_err();
        assert_eq!(err.code(), "PRECONDITION_FAILED");
        assert_eq!(
            err.details().unwrap()["reason"],
            serde_json::json!("ACTIVE_PROFILE_IN_USE")
        );

        assert!(manager.ensure_profile_not_active("profile-2").await.is_ok());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn snapshot_hides_identity_when_terminal() {        let mut inner = Inner::new();
        inner.state = RuntimeState::Failed;
        inner.pid = Some(4242);
        inner.version = Some("1.14.4".into());
        let snapshot = inner.snapshot();
        assert!(snapshot.pid.is_none());
        assert!(snapshot.upstream_version.is_none());
        assert!(snapshot.uptime_seconds.is_none());
        assert!(snapshot.mode.is_none());
    }
}
