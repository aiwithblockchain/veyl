use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use serde::Serialize;
use sha2::{Digest, Sha256};
use tokio::process::Child;
use tokio::sync::{broadcast, Mutex, Notify};
use tokio::time::Instant;

use super::error::{RuntimeError, RuntimeResult};
use super::health::{ClashApi, ConnectionSample, DataPlaneProbe, DirectIpProbe, ExitIpProbe, DEFAULT_DIRECT_IP_PROBE, DEFAULT_EXIT_IP_PROBE};
use super::process::{self, SpawnOptions};

pub const CONTRACT_VERSION: &str = "2.3.0";
pub const EVENT_CONTRACT_VERSION: &str = "2.5.0";

/// 契约要求数据面检查默认开启（2026-11-02 拍板），置 `None` 可关闭。
pub const DEFAULT_DATA_PLANE_PROBE: &str = "http://cp.cloudflare.com/generate_204";

/// 节点延迟（Clash delay）刷新间隔。每次测试都是一次真实请求，不跟 2s 健康循环同频。
const LATENCY_REFRESH_INTERVAL: Duration = Duration::from_secs(30);

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
    Tun,
}

/// 拼 TUN 快照需要的输入。都来自 `TunSession`（manager 不知道 TUN 的存在）。
#[derive(Debug, Clone, Default)]
pub struct TunSnapshotInput {
    pub pid: u32,
    pub config_id: Option<String>,
    pub config_name: Option<String>,
    pub node_id: Option<String>,
    pub node_name: Option<String>,
    pub applied_route_revision: Option<i64>,
    pub connected_since: Option<String>,
    pub uptime_seconds: Option<u64>,
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
    pub config_id: Option<String>,
    pub mixed_port: Option<u16>,
    pub config_name: Option<String>,
    pub node_id: Option<String>,
    pub node_name: Option<String>,
    pub applied_route_revision: Option<i64>,
    pub connected_since: Option<String>,
    /// 出口 IP 探测往返耗时（契约固定语义，**不是**节点延迟）。
    pub latency_ms: Option<u64>,
    /// 经该节点出网的真实延迟（Clash delay）；与 `latency_ms` 是两个指标。
    pub node_latency_ms: Option<u64>,
    pub direct_ip: Option<String>,
    pub config_hash: Option<String>,
    pub system_proxy_enabled: bool,
    pub health: HealthSnapshot,
    /// 每 2s 随健康检查从 `/connections` 采样；未连接或采不到时为 null。
    pub traffic: Option<serde_json::Value>,
    /// 活跃连接数，与 `traffic` 同一次采样；未连接时 null。
    pub connections: Option<u32>,
    pub restart_count: u32,
    pub last_error: Option<RuntimeErrorInfo>,
    pub last_transition_at: String,
}

/// 契约里的 `AivpnError` 形状（`docs/contracts/runtime.md` §2.5）。
impl RuntimeStatus {
    /// TUN 连接的快照。
    ///
    /// TUN 的 sing-box 是 helper 的子进程，不归 `RuntimeManager` 管；但前端只认
    /// `RuntimeStatus` 这一种形状，**缺任何一个顶层字段**（尤其是 `health`）
    /// 都会让界面直接崩。所以复用同一个结构体来拼，不手工构造 JSON。
    ///
    /// TUN 没有 Clash API 探测通道：`clash_api` 如实给 `false` 而不是假装探测过；
    /// `data_plane` 按契约「未探测时为 true」。
    pub fn tun(input: TunSnapshotInput) -> Self {
        let now = now_iso();
        Self {
            contract_version: CONTRACT_VERSION,
            state: RuntimeState::Running,
            mode: Some(RuntimeMode::Tun),
            pid: Some(input.pid),
            upstream_version: None,
            uptime_seconds: input.uptime_seconds,
            config_id: input.config_id,
            mixed_port: None,
            config_name: input.config_name,
            node_id: input.node_id,
            node_name: input.node_name,
            applied_route_revision: input.applied_route_revision,
            connected_since: input.connected_since.clone(),
            latency_ms: None,
            node_latency_ms: None,
            direct_ip: None,
            config_hash: None,
            system_proxy_enabled: false,
            health: HealthSnapshot {
                contract_version: CONTRACT_VERSION,
                process: true,
                clash_api: false,
                data_plane: true,
                exit_ip: None,
                consecutive_failures: 0,
                checked_at: now.clone(),
            },
            traffic: None,
            connections: None,
            restart_count: 0,
            last_error: None,
            last_transition_at: input.connected_since.unwrap_or(now),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct RuntimeErrorInfo {
    pub contract_version: &'static str,
    pub code: String,
    pub message: String,
    pub retryable: bool,
    pub details: Option<serde_json::Value>,
    pub request_id: String,
}

impl RuntimeErrorInfo {
    fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            contract_version: CONTRACT_VERSION,
            code: code.into(),
            message: message.into(),
            retryable: false,
            details: None,
            request_id: String::new(),
        }
    }
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
    pub error: Option<RuntimeErrorInfo>,
    /// 迁移后的完整快照，不变量：`snapshot.state == to`。
    pub snapshot: RuntimeStatus,
    pub emitted_at: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct RuntimeHealthChangedPayload {
    pub contract_version: &'static str,
    pub health: HealthSnapshot,
    /// 流量快照；未连接或还没采到时为 `null`。
    /// **不要用 0 代替**：UI 要能区分「0 字节」和「没有数据」。
    pub traffic: Option<serde_json::Value>,
    /// 活跃连接数，与 `traffic` 同一次采样；未连接或没采到为 `null`。
    pub connections: Option<u32>,
    /// 出口 IP 探测往返耗时（契约固定语义）；未连接或没测到为 `null`。
    pub latency_ms: Option<u64>,
    /// 经该节点出网的真实延迟（Clash delay）；未连接或没测到为 `null`。
    pub node_latency_ms: Option<u64>,
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
    /// 连接成功后探测一次出口 IP 的纯文本地址；`None` 表示不探测。
    pub exit_ip_probe: Option<String>,
    /// 连接成功后探测一次直连 IP 的地址（不走任何代理）。
    pub direct_ip_probe: Option<String>,
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
            exit_ip_probe: Some(DEFAULT_EXIT_IP_PROBE.to_string()),
            direct_ip_probe: Some(DEFAULT_DIRECT_IP_PROBE.to_string()),
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
    pub config_id: Option<String>,
    pub config_name: Option<String>,
    pub node_id: Option<String>,
    pub node_name: Option<String>,
    /// 建连时 `configs.route_revision` 的值。
    pub applied_route_revision: Option<i64>,
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
            .field("config_id", &self.config_id)
            .field("config_name", &self.config_name)
            .field("node_id", &self.node_id)
            .field("node_name", &self.node_name)
            .field("applied_route_revision", &self.applied_route_revision)
            .finish()
    }
}

impl StartPlan {
    pub fn log_path(cfg: &RuntimeConfig, version: &str) -> PathBuf {
        cfg.log_dir().join(format!("runtime-{version}.log"))
    }

    /// 是否是同一份启动计划。端口、配置路径、二进制、版本、控制面都必须一致；
    /// 换节点时这些都是新值，绝不能只比配置路径（同一 profile 重连路径不变）。
    fn same_launch(&self, other: &Self) -> bool {
        self.binary == other.binary
            && self.config_path == other.config_path
            && self.version == other.version
            && self.mixed_port == other.mixed_port
            && self.clash_addr == other.clash_addr
            && self.clash_secret == other.clash_secret
    }
}

/// 持久化的运行中进程，用于下次启动时回收（应用崩溃/被强杀时 child handle 会丢）。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
struct RunningPid {
    pid: u32,
    binary: String,
    config: String,
    started_at: i64,
}

struct Inner {
    state: RuntimeState,
    plan: Option<StartPlan>,
    child: Option<Child>,
    pid: Option<u32>,
    version: Option<String>,
    restart_count: u32,
    last_error: Option<RuntimeErrorInfo>,
    generation: u64,
    desired_stop: bool,
    running_since: Option<Instant>,
    connected_since: Option<String>,
    last_transition_at: String,
    config_hash: Option<String>,
    system_proxy_enabled: bool,
    health: HealthSnapshot,
    /// 最近一次成功探测出口 IP 的往返耗时；`health.exit_ip` 为空时视为无效。
    last_exit_ip_latency_ms: Option<u64>,
    /// 最近一次 Clash delay 测得的节点延迟（毫秒）。与出口 IP 无关，单独成字段，
    /// 不占用契约里的 `latency_ms`（那是出口探测耗时）。
    last_node_latency_ms: Option<u64>,
    /// 不经代理测得的直连出口 IP；连接期间才有效。
    direct_ip: Option<String>,
    /// 最近一次成功采到的流量快照；未连接或没采到时为 None。
    /// 字段形状见 `docs/contracts/runtime.md` §2.4。
    traffic: Option<serde_json::Value>,
    /// 活跃连接数，来自同一次 `/connections` 采样。
    connections: Option<u32>,
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
            connected_since: None,
            last_transition_at: now_iso(),
            config_hash: None,
            system_proxy_enabled: false,
            health: HealthSnapshot::default(),
            traffic: None,
            connections: None,
            last_exit_ip_latency_ms: None,
            last_node_latency_ms: None,
            direct_ip: None,
        }
    }

    fn snapshot(&self) -> RuntimeStatus {
        let terminal = self.state.terminal();
        let running = !terminal && self.state != RuntimeState::Idle;
        // runtime.md §2.5.1：这些字段只在 running / degraded 下非 null。
        let connected = matches!(self.state, RuntimeState::Running | RuntimeState::Degraded);

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
            config_id: if terminal {
                None
            } else {
                self.plan.as_ref().and_then(|p| p.config_id.clone())
            },
            mixed_port: if connected {
                self.plan.as_ref().map(|p| p.mixed_port)
            } else {
                None
            },
            config_name: if terminal {
                None
            } else {
                self.plan.as_ref().and_then(|p| p.config_name.clone())
            },
            node_id: if terminal {
                None
            } else {
                self.plan.as_ref().and_then(|p| p.node_id.clone())
            },
            node_name: if terminal {
                None
            } else {
                self.plan.as_ref().and_then(|p| p.node_name.clone())
            },
            applied_route_revision: if connected {
                self.plan.as_ref().and_then(|p| p.applied_route_revision)
            } else {
                None
            },
            connected_since: if connected {
                self.connected_since.clone()
            } else {
                None
            },
            // 出口探测延迟：维持契约原义（出口 IP 探测往返耗时）。
            latency_ms: if connected && self.health.exit_ip.is_some() {
                self.last_exit_ip_latency_ms
            } else {
                None
            },
            // 节点延迟单独给，不受出口 IP 是否测到影响。
            node_latency_ms: if connected {
                self.last_node_latency_ms
            } else {
                None
            },
            direct_ip: if connected { self.direct_ip.clone() } else { None },
            config_hash: self.config_hash.clone(),
            system_proxy_enabled: self.system_proxy_enabled,
            health: self.health.clone(),
            traffic: if connected { self.traffic.clone() } else { None },
            connections: if connected { self.connections } else { None },
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
    /// 进入 Failed 时回调宿主（例如撤销系统代理）；运行时不认识代理模块。
    terminal_failure_hook: std::sync::Mutex<Option<Arc<dyn Fn() + Send + Sync>>>,
}

impl RuntimeManager {
    pub fn new(cfg: RuntimeConfig) -> Arc<Self> {
        let (events, _) = broadcast::channel(256);
        Arc::new(Self {
            cfg,
            inner: Mutex::new(Inner::new()),
            events,
            wake: Notify::new(),
            terminal_failure_hook: std::sync::Mutex::new(None),
        })
    }

    /// 运行时进入终态失败时触发。钩子自己负责容错，不能影响状态机。
    pub fn set_terminal_failure_hook(&self, hook: Arc<dyn Fn() + Send + Sync>) {
        if let Ok(mut slot) = self.terminal_failure_hook.lock() {
            *slot = Some(hook);
        }
    }

    fn notify_terminal_failure(&self) {
        // 先取出钩子再调用：钩子可能做同步 IO，不能在持锁时跑。
        let hook = self
            .terminal_failure_hook
            .lock()
            .ok()
            .and_then(|slot| slot.clone());
        if let Some(hook) = hook {
            hook();
        }
    }

    pub fn subscribe(&self) -> broadcast::Receiver<RuntimeEvent> {
        self.events.subscribe()
    }

    /// 当前运行计划（含本次分配的真实端口），用于诊断与测试。
    pub async fn current_plan(&self) -> Option<StartPlan> {
        self.inner.lock().await.plan.clone()
    }

    pub async fn status(&self) -> RuntimeStatus {
        self.inner.lock().await.snapshot()
    }

    /// 由连接编排层在设置/恢复系统代理后调用。
    pub async fn set_system_proxy_enabled(&self, enabled: bool) {
        self.inner.lock().await.system_proxy_enabled = enabled;
    }

    /// selector 热切节点后同步快照里的 node_id/node_name，不重启进程。
    pub async fn set_plan_node(&self, node_id: String, node_name: String) {
        {
            let mut inner = self.inner.lock().await;
            if let Some(plan) = inner.plan.as_mut() {
                plan.node_id = Some(node_id);
                plan.node_name = Some(node_name);
            }
            // 切换瞬间不能再展示上一个节点的延迟；supervise 下一拍会用新 tag 重测。
            inner.last_node_latency_ms = None;
        }
        // 叫醒 supervise，让它立刻按新节点重测，而不是等下一个 tick。
        self.wake.notify_waiters();
        self.emit_health().await;
    }

    /// 出口 IP 由连接编排层探测后回填，用于状态快照展示。
    pub async fn set_exit_ip(&self, exit_ip: Option<String>) {
        let mut inner = self.inner.lock().await;
        inner.health.exit_ip = exit_ip;
        inner.health.checked_at = now_iso();
    }

    /// 记录一次采样：流量与活跃连接数来自同一个 `/connections` 响应。
    ///
    /// **写入前必须复查 generation / desired_stop / state**：stop 已经把状态清空
    /// 并发了 null 事件，晚到的采样如果把旧流量写回去，就会发出「未连接却有流量」
    /// 的快照，违反契约。
    async fn set_traffic_if_live(
        &self,
        gen: u64,
        sample: ConnectionSample,
        up_rate: u64,
        down_rate: u64,
    ) -> bool {
        let mut inner = self.inner.lock().await;
        if inner.generation != gen
            || inner.desired_stop
            || !matches!(
                inner.state,
                RuntimeState::Running | RuntimeState::Degraded
            )
        {
            return false;
        }
        inner.traffic = Some(serde_json::json!({
            "up_bytes": sample.up_bytes,
            "down_bytes": sample.down_bytes,
            "up_rate": up_rate,
            "down_rate": down_rate,
            "sampled_at": now_iso(),
        }));
        // 响应里没有 connections 数组时保留上一次的值：未知不等于 0。
        if let Some(active) = sample.active {
            inner.connections = Some(active);
        }
        true
    }

    /// 连接编排层用：短暂等待异步探测的结果，让 `VpnConnect` 能带回出口 IP。
    ///
    /// 超时、探测失败或中途断开都返回 `None`——这不影响连接本身。
    pub async fn await_exit_ip(&self, timeout: Duration) -> Option<String> {
        let deadline = Instant::now() + timeout;
        loop {
            {
                let inner = self.inner.lock().await;
                if let Some(ip) = inner.health.exit_ip.clone() {
                    return Some(ip);
                }
                if !matches!(inner.state, RuntimeState::Running | RuntimeState::Degraded) {
                    return None;
                }
            }
            if Instant::now() >= deadline {
                return None;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }

    /// 正在使用（含启动、切换、停止中）的配置；`None` 表示没有活动连接。
    pub async fn active_config_id(&self) -> Option<String> {
        let inner = self.inner.lock().await;
        match inner.state {
            RuntimeState::Starting
            | RuntimeState::Running
            | RuntimeState::Degraded
            | RuntimeState::Restarting
            | RuntimeState::Stopping => inner.plan.as_ref().and_then(|p| p.config_id.clone()),
            _ => None,
        }
    }

    /// ConfigDelete 的准入检查：正在连接的配置一律拒绝，不自动断开。
    pub async fn ensure_config_not_active(&self, config_id: &str) -> RuntimeResult<()> {
        match self.active_config_id().await {
            Some(active) if active == config_id => Err(RuntimeError::Precondition {
                reason: "ACTIVE_CONFIG_IN_USE",
                message: format!("config {config_id} is in use; disconnect before deleting"),
            }),
            _ => Ok(()),
        }
    }

    pub async fn start(self: &Arc<Self>, plan: StartPlan) -> RuntimeResult<RuntimeStatus> {
        // 同一份 plan 已经在跑：保持现状（并发重复启动的保护）。
        // plan 不同（换节点/换端口）必须先停掉旧进程再启动，
        // 否则新端口没人监听，系统代理会指向死端口、用户整机断网。
        let replace = {
            let inner = self.inner.lock().await;
            match inner.state {
                RuntimeState::Starting
                | RuntimeState::Running
                | RuntimeState::Degraded
                | RuntimeState::Restarting => match inner.plan.as_ref() {
                    Some(current) if current.same_launch(&plan) => {
                        return Ok(inner.snapshot());
                    }
                    _ => true,
                },
                RuntimeState::Stopping => true,
                _ => false,
            }
        };
        if replace {
            // 启动途中切换也一样：先完整停下，不并发替换。
            self.stop().await?;
        }

        let (stale_child, gen, from, version, snapshot) = {
            let mut inner = self.inner.lock().await;
            if !plan.binary.is_file() {
                return Err(RuntimeError::NotInstalled);
            }

            let from = inner.state;
            inner.generation += 1;
            inner.desired_stop = false;
            inner.restart_count = 0;
            inner.last_error = None;
            inner.direct_ip = None;
            inner.running_since = None;
            inner.connected_since = None;
            inner.health = HealthSnapshot::default();
            // 上一次连接的流量与连接数不能带进这一次。
            inner.traffic = None;
            inner.connections = None;
            inner.last_exit_ip_latency_ms = None;
            inner.last_node_latency_ms = None;
            inner.config_hash = hash_file(&plan.config_path);
            inner.version = Some(plan.version.clone());
            inner.plan = Some(plan.clone());
            inner.state = RuntimeState::Starting;
            inner.last_transition_at = now_iso();
            // 快照在持锁位置取：锁外再补会和后续迁移脱节。
            let snapshot = inner.snapshot();

            (
                inner.child.take(),
                inner.generation,
                from,
                plan.version.clone(),
                snapshot,
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
            snapshot,
        )));

        let manager = Arc::clone(self);
        tokio::spawn(async move {
            manager.engine(gen).await;
        });

        let budget = self.cfg.startup_timeout + Duration::from_secs(2);
        self.wait_settled(gen, budget).await
    }

    pub async fn stop(&self) -> RuntimeResult<RuntimeStatus> {
        let (child, from, snapshot) = {
            let mut inner = self.inner.lock().await;
            if inner.state == RuntimeState::Idle && inner.child.is_none() {
                // 配置可能已被断开清理删掉，旧的 plan 不能再用于重启。
                inner.plan = None;
                return Ok(inner.snapshot());
            }
            let from = inner.state;
            inner.generation += 1;
            inner.desired_stop = true;
            inner.state = RuntimeState::Stopping;
            inner.last_transition_at = now_iso();
            let snapshot = inner.snapshot();
            (inner.child.take(), from, snapshot)
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
            error: None,
            snapshot,
            emitted_at: now_iso(),
        }));

        let child_pid = child.as_ref().and_then(|child| child.id());
        if let Some(mut child) = child {
            let _ = process::terminate(&mut child, self.cfg.stop_grace).await;
        }
        // 确认进程真的死了才删记录；SIGKILL 也可能落空，那时留给下次启动回收。
        match child_pid {
            Some(pid) if process::is_alive(pid) => {
                log::warn!("sing-box pid={pid} 未能终止，保留 runtime.pid 等下次启动回收");
            }
            _ => self.clear_running_pid(),
        }

        let snapshot = {
            let mut inner = self.inner.lock().await;
            inner.state = RuntimeState::Idle;
            inner.pid = None;
            inner.running_since = None;
            inner.child = None;
            // plan 指向的配置文件已被断开清理删掉，留着只会让 restart 拿死路径去启动。
            inner.plan = None;
            inner.connected_since = None;
            // 断开后不能还显示上一个节点的出口地址，也不能留着上次的流量。
            inner.health.exit_ip = None;
            inner.direct_ip = None;
            inner.traffic = None;
            inner.connections = None;
            inner.last_exit_ip_latency_ms = None;
            inner.last_node_latency_ms = None;
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
            error: None,
            snapshot: snapshot.clone(),
            emitted_at: now_iso(),
        }));
        // exit_ip 已在上面清空；推一次健康事件，否则面板会一直显示上一个节点的地址。
        self.emit_health().await;

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


    fn running_pid_path(&self) -> PathBuf {
        self.cfg.app_data_dir.join("runtime.pid")
    }

    /// spawn 成功后立刻接管 child 并把 pid 落盘。
    ///
    /// 不能等到 `enter_running` 再写：`wait_until_ready` 最长要等 `startup_timeout`，
    /// 这个窗口里被强杀的话，下次启动只能靠 pid 文件找到孤儿。
    async fn adopt_child(&self, gen: u64, child: Child) -> Result<(), Child> {
        let pid = child.id();
        let mut inner = self.inner.lock().await;
        if inner.generation != gen || inner.desired_stop {
            return Err(child);
        }
        inner.pid = pid;
        inner.child = Some(child);
        if let (Some(pid), Some(plan)) = (pid, inner.plan.clone()) {
            self.record_running_pid(&plan, pid);
        }
        Ok(())
    }

    fn record_running_pid(&self, plan: &StartPlan, pid: u32) {
        let record = RunningPid {
            pid,
            binary: plan.binary.to_string_lossy().into_owned(),
            config: plan.config_path.to_string_lossy().into_owned(),
            started_at: crate::store::db::now_ms(),
        };
        if let Err(error) =
            crate::runtime::fsutil::write_atomic_json(&self.running_pid_path(), &record)
        {
            log::warn!("写入 runtime.pid 失败：{error}");
        }
    }

    fn clear_running_pid(&self) {
        let _ = std::fs::remove_file(self.running_pid_path());
    }

    /// 启动时回收上一次没来得及带走的 sing-box。
    ///
    /// 只回收「还在跑、且命令行确实是我们启动的那个进程」——pid 会被系统复用，
    /// 认错就会误杀别人的程序。宁可漏掉一个孤儿，也不能杀错用户进程。
    pub async fn reclaim_stale(&self) -> RuntimeResult<Option<u32>> {
        let path = self.running_pid_path();
        let Some(record) = crate::runtime::fsutil::read_json::<RunningPid>(&path)? else {
            return Ok(None);
        };

        if !process::is_alive(record.pid) {
            self.clear_running_pid();
            return Ok(None);
        }

        match process::command_line(record.pid) {
            Some(command)
                if process::matches_launch(&command, &record.binary, &record.config) => {}
            Some(_) => {
                log::warn!(
                    "pid={} 的命令行无法确认是我们启动的 sing-box，跳过回收（保留 runtime.pid 供排查）",
                    record.pid
                );
                return Ok(None);
            }
            None => {
                log::warn!(
                    "无法确认 pid={} 的命令行，跳过回收（不冒险杀未知进程）",
                    record.pid
                );
                return Ok(None);
            }
        }

        let pid = record.pid;
        let exited = process::terminate_pid(pid, self.cfg.stop_grace).await;
        if exited {
            self.clear_running_pid();
            log::warn!("回收了上次遗留的 sing-box pid={pid}");
            Ok(Some(pid))
        } else {
            // 进程没死就保留记录，下次启动的 reclaim_stale 再试一次。
            log::error!("遗留 sing-box pid={pid} 未能终止，保留 runtime.pid 等下次重试");
            Ok(None)
        }
    }

    /// `runtime.pid` 里记录的进程是否还活着、且确实是我们启动的那个 sing-box。
    ///
    /// 与 `reclaim_stale` 同一套三重核对（pid 活着 + 命令行对得上），
    /// 但**只读不杀**。强制重置用它决定能不能删掉运行记录：只凭 pid
    /// 判断会被 pid 复用骗到，那一项就永远红。
    pub fn recorded_sing_box_is_alive(&self) -> bool {
        let path = self.running_pid_path();
        let Ok(Some(record)) = crate::runtime::fsutil::read_json::<RunningPid>(&path) else {
            return false;
        };
        if !process::is_alive(record.pid) {
            return false;
        }
        process::command_line(record.pid)
            .map(|command| process::matches_launch(&command, &record.binary, &record.config))
            .unwrap_or(false)
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

            let child = match process::spawn(&options).await {
                Ok(child) => child,
                Err(e) => {
                    self.fail(gen, e.code(), e.to_string()).await;
                    return;
                }
            };

            if let Err(mut child) = self.adopt_child(gen, child).await {
                let _ = process::terminate(&mut child, Duration::from_secs(1)).await;
                return;
            }

            if !self.wait_until_ready(gen, &plan).await {
                let reason = self
                    .last_error()
                    .await
                    .unwrap_or_else(|| "runtime did not become ready".into());
                self.kill_child().await;
                // 契约：starting + CRASH → failed，启动失败不重试。
                let code = if reason.contains("timed out") {
                    "RUNTIME_START_TIMEOUT"
                } else {
                    "RUNTIME_EXITED"
                };
                self.fail(gen, code, reason).await;
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

                    if restarts >= self.cfg.max_restarts {
                        // 预算用尽：restart_count 保持已执行的重启次数，不再累加。
                        self.set_restart_count(restarts).await;
                        self.give_up(gen, reason).await;
                        return;
                    }

                    restarts += 1;
                    self.set_restart_count(restarts).await;

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
        #[cfg(test)]
        let started = Instant::now();
        #[cfg(test)]
        let debug_crash_path = plan
            .work_dir
            .file_name()
            .and_then(|name| name.to_str())
            .map(|name| name.starts_with("veyl-crash-"))
            .unwrap_or(false);

        loop {
            if !self.is_current(gen).await {
                #[cfg(test)]
                if debug_crash_path {
                    eprintln!("[wait] gen mismatch at {:?}", started.elapsed());
                }
                return false;
            }

            let exit = self.child_exit_reason().await;
            #[cfg(test)]
            if debug_crash_path {
                eprintln!(
                    "[wait] t={:?} exit={exit:?}",
                    started.elapsed()
                );
            }
            if let Some(reason) = exit {
                self.record_error(reason).await;
                return false;
            }

            // 先判 deadline，再做可能阻塞的健康检查：健康请求有自己的 1s 超时，
            // 放在 deadline 之后会把「进程已退出」误报成「启动超时」。
            if Instant::now() >= deadline {
                // deadline 到点后再查一次：进程可能刚好在这轮健康检查期间退出。
                if let Some(reason) = self.child_exit_reason().await {
                    self.record_error(reason).await;
                    return false;
                }
                #[cfg(test)]
                if debug_crash_path {
                    let pid = self.inner.lock().await.pid;
                    eprintln!(
                        "[wait] timeout pid={pid:?} alive={:?} cmd={:?}",
                        pid.map(process::is_alive),
                        pid.and_then(process::command_line)
                    );
                }
                self.record_error(format!(
                    "startup timed out after {} ms",
                    self.cfg.startup_timeout.as_millis()
                ))
                .await;
                return false;
            }

            #[cfg(test)]
            let health_started = Instant::now();
            let healthy = api.healthy().await;
            #[cfg(test)]
            if debug_crash_path {
                eprintln!(
                    "[wait] t={:?} healthy={healthy} took={:?}",
                    started.elapsed(),
                    health_started.elapsed()
                );
            }
            if healthy {
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

            tokio::time::sleep(Duration::from_millis(200)).await;
        }
    }

    async fn child_exit_reason(&self) -> Option<String> {
        let mut inner = self.inner.lock().await;
        match inner.child.as_mut() {
            Some(child) => process::try_exit(child),
            None => Some("process handle is missing".to_string()),
        }
    }

    async fn supervise(self: &Arc<Self>, gen: u64, plan: &StartPlan) -> SuperviseExit {
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
        // 延迟不进 2s 健康循环：每次 delay 都是一次真实请求。
        let mut next_latency = Instant::now() + LATENCY_REFRESH_INTERVAL;
        // 热切换只改 inner.plan、不换 gen，也不重进 enter_running：
        // 记住最近一次探测用的节点，不一致就作废旧值并立刻重测。
        let mut probed_node = plan.node_id.clone();
        // 上一次流量采样，用来算速率。
        let mut last_traffic: Option<(ConnectionSample, Instant)> = None;

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
                    health.exit_ip = None;
                    health.checked_at = now_iso();
                })
                .await;
                // 进程已经没了：先把流量/连接数清掉再发事件，
                // 否则这条「进程退出」的健康事件会带着上一次的旧流量。
                {
                    let mut inner = self.inner.lock().await;
                    inner.traffic = None;
                    inner.connections = None;
                    // 进程没了，上一段连接的两种延迟都不再可信。
                    inner.last_exit_ip_latency_ms = None;
                    inner.last_node_latency_ms = None;
                }
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

                    // 流量与健康检查同频（默认 2s）。采不到就保留上一次的值，
                    // **不要写 0**：UI 会把它当成「这次真的没流量」。
                    if let Ok(Some(sample)) = api.connection_sample().await {
                        let sampled_at = Instant::now();
                        let (up_rate, down_rate) = match last_traffic {
                            Some((previous, at)) => {
                                let seconds =
                                    sampled_at.duration_since(at).as_secs_f64().max(0.001);
                                (
                                    ((sample.up_bytes.saturating_sub(previous.up_bytes)) as f64
                                        / seconds)
                                        .round() as u64,
                                    ((sample.down_bytes.saturating_sub(previous.down_bytes))
                                        as f64
                                        / seconds)
                                        .round() as u64,
                                )
                            }
                            None => (0, 0),
                        };
                        last_traffic = Some((sample, sampled_at));
                        self.set_traffic_if_live(gen, sample, up_rate, down_rate)
                            .await;
                    }
                } else {
                    failures += 1;
                    self.update_health(|health| {
                        health.process = true;
                        health.clash_api = false;
                        health.consecutive_failures = failures;
                        // 连续失败判定为不健康：出口 IP 已不可信，清掉避免展示陈旧地址。
                        if failures >= 3 {
                            health.exit_ip = None;
                        }
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

            // 延迟必须跟着当前节点走：循环里捕获的 plan 可能已经是旧节点。
            let current_node = self.plan_of(gen).await.and_then(|plan| plan.node_id);
            if current_node != probed_node {
                {
                    let mut inner = self.inner.lock().await;
                    if inner.generation == gen {
                        inner.last_node_latency_ms = None;
                    }
                }
                probed_node = current_node;
                next_latency = Instant::now();
                self.emit_health().await;
            }

            if Instant::now() >= next_latency {
                next_latency = Instant::now() + LATENCY_REFRESH_INTERVAL;
                if let Some(current) = self.plan_of(gen).await {
                    // spawn 出去：delay 最长 6s，不能挡住健康检查和崩溃检测。
                    let manager = Arc::clone(self);
                    tokio::spawn(async move {
                        manager.probe_latency(gen, current).await;
                    });
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

    async fn enter_running(self: &Arc<Self>, gen: u64) {
        let (payload, plan) = {
            let mut inner = self.inner.lock().await;
            if inner.generation != gen || inner.desired_stop {
                return;
            }
            let from = inner.state;
            inner.state = RuntimeState::Running;
            inner.running_since = Some(Instant::now());
            inner.connected_since = Some(now_iso());
            inner.pid = inner.child.as_ref().and_then(|c| c.id());
            inner.last_transition_at = now_iso();

            (
                state_payload(
                    from,
                    RuntimeState::Running,
                    RuntimeEventKind::ProcessReady,
                    None,
                    inner.pid,
                    inner.version.clone(),
                    inner.snapshot(),
                ),
                inner.plan.clone(),
            )
        };
        self.emit(RuntimeEvent::StateChanged(payload));

        // 出口 IP 只探一次，不放进每 10 秒的健康循环。
        if let Some(plan) = plan {
            let manager = Arc::clone(self);
            let latency_plan = plan.clone();
            tokio::spawn(async move {
                manager.probe_exit_ip(gen, plan).await;
            });
            // 节点延迟一进入 running 就测一次；之后的刷新在 supervise 里每 30s 一次。
            let manager = Arc::clone(self);
            tokio::spawn(async move {
                manager.probe_latency(gen, latency_plan).await;
            });
        }

        // 直连 IP 也只探一次，用于和出口 IP 对照「是否真的走了代理」。
        let direct = Arc::clone(self);
        tokio::spawn(async move {
            direct.probe_direct_ip(gen).await;
        });
    }

    /// 不经代理探测直连出口 IP。失败只记日志，不影响连接。
    async fn probe_direct_ip(self: Arc<Self>, gen: u64) {
        let Some(url) = self.cfg.direct_ip_probe.clone() else {
            return;
        };
        let probe = match DirectIpProbe::new(url) {
            Ok(probe) => probe,
            Err(error) => {
                log::warn!("直连 IP 探测器创建失败：{error}");
                return;
            }
        };

        let result = probe.check().await;

        let still_running = {
            let inner = self.inner.lock().await;
            inner.generation == gen
                && matches!(inner.state, RuntimeState::Running | RuntimeState::Degraded)
        };
        if !still_running {
            return;
        }

        match result {
            Ok(Some(ip)) => {
                log::info!("直连 IP：{ip}");
                self.inner.lock().await.direct_ip = Some(ip);
            }
            Ok(None) => log::warn!("直连 IP 探测返回的不是 IP，忽略（direct_ip 保持未知）"),
            Err(error) => log::warn!("直连 IP 探测失败：{error}（direct_ip 保持未知）"),
        }
    }

    /// 经本地 mixed 入站探测出口 IP。失败只记日志，不影响连接状态。
    async fn probe_exit_ip(self: Arc<Self>, gen: u64, plan: StartPlan) {
        let Some(url) = self.cfg.exit_ip_probe.clone() else {
            return;
        };
        let probe = match ExitIpProbe::new(url, plan.mixed_port) {
            Ok(probe) => probe,
            Err(error) => {
                log::warn!("出口 IP 探测器创建失败：{error}");
                return;
            }
        };

        let started = Instant::now();
        let result = probe.check().await;
        // 契约：`latency_ms` 就是这次出口探测的往返耗时（含 DNS + TLS）。
        let latency_ms = started.elapsed().as_millis() as u64;

        // 探测是异步的：这期间可能已经断开或切了节点，只有仍是同一代且仍在运行才回填。
        let still_running = {
            let inner = self.inner.lock().await;
            inner.generation == gen
                && matches!(inner.state, RuntimeState::Running | RuntimeState::Degraded)
        };
        if !still_running {
            return;
        }

        match result {
            Ok(Some(ip)) => {
                log::info!("出口 IP：{ip}（{latency_ms}ms）");
                // 先记延迟再写 exit_ip：await_exit_ip 以 exit_ip 出现为信号。
                self.inner.lock().await.last_exit_ip_latency_ms = Some(latency_ms);
                self.set_exit_ip(Some(ip)).await;
                self.emit_health().await;
            }
            Ok(None) => log::warn!("出口 IP 探测返回的不是 IP，忽略（exit_ip 保持未知）"),
            Err(error) => log::warn!("出口 IP 探测失败：{error}（exit_ip 保持未知）"),
        }
    }

    /// 用 Clash API 的 delay 端点测「经该节点出网」的真实延迟。
    ///
    /// 失败写 `None`（契约要求「探测失败为 null」），不影响连接状态。
    /// 热切换不走 enter_running：由 `set_plan_node` 清空、`supervise` 察觉节点变化后重测；
    /// 晚到的旧节点结果会被下面的 node_id 校验丢弃。
    async fn probe_latency(self: Arc<Self>, gen: u64, plan: StartPlan) {
        let Some(node_id) = plan.node_id.clone() else {
            return;
        };
        // 配置生成时节点的 outbound tag 就是 node-{node_id}（与 node_probe 一致）。
        let tag = format!("node-{node_id}");
        let api = ClashApi::new(&plan.clash_addr, &plan.clash_secret);
        // 失败也要把值清成 null：契约要求「探测失败为 null」，
        // 保留上一次的数字会让面板显示一个并不成立的延迟。
        let delay = match api.delay(&tag).await {
            Ok(delay) => Some(delay),
            Err(error) => {
                log::debug!("节点延迟测试失败（{tag}）：{error}");
                None
            }
        };

        let mut inner = self.inner.lock().await;
        // 晚到的探测不能写回去：热切换后 inner.plan 已经是新节点，
        // 用它挡住旧 tag 的结果（否则切换后会被旧值覆盖一秒）。
        let current_node = inner.plan.as_ref().and_then(|plan| plan.node_id.as_deref());
        if inner.generation != gen
            || !matches!(inner.state, RuntimeState::Running | RuntimeState::Degraded)
            || current_node != Some(node_id.as_str())
        {
            return;
        }
        inner.last_node_latency_ms = delay;
        drop(inner);
        self.emit_health().await;
    }

    async fn fail(&self, gen: u64, code: &'static str, reason: String) {
        {
            let mut inner = self.inner.lock().await;
            if inner.generation != gen {
                return;
            }
            inner.last_error = Some(RuntimeErrorInfo::new(code, &reason));
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
            inner.last_error = Some(RuntimeErrorInfo::new("RUNTIME_EXITED", &reason));
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
        let (mut payload, error) = {
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
                inner.connected_since = None;
                inner.health.exit_ip = None;
                inner.direct_ip = None;
                // 两种延迟都属于上一段连接，进终态后不能再展示。
                inner.last_exit_ip_latency_ms = None;
                inner.last_node_latency_ms = None;
                // 配置可能已被 guard 删除；清掉 plan，restart 会返回 InvalidState，
                // 而不是拿死路径去启动、报一个用户看不懂的底层错误。
                inner.plan = None;
                // pid 文件由 kill_child / stop 按「进程是否真的退出」决定是否删除，
                // 这里不能再无条件清掉，否则 D-23 的回收记录会丢。
            }
            let error = if to == RuntimeState::Failed {
                inner.last_error.clone()
            } else {
                None
            };
            (
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
                    inner.snapshot(),
                ),
                error,
            )
        };
        payload.error = error;
        self.emit(RuntimeEvent::StateChanged(payload));
        if to == RuntimeState::Failed {
            // 锁已释放：钩子可以安全地做同步 IO（例如还原系统代理）。
            self.notify_terminal_failure();
        }
        if to.terminal() {
            // 失败也是断开：同步清掉面板上的出口 IP。
            self.emit_health().await;
        }
    }

    async fn update_health(&self, update: impl FnOnce(&mut HealthSnapshot)) {
        let mut inner = self.inner.lock().await;
        update(&mut inner.health);
    }

    async fn emit_health(&self) {
        let (health, traffic, connections, latency_ms, node_latency_ms) = {
            let inner = self.inner.lock().await;
            // 事件里的流量/连接数/延迟只在连接期间给值：
            // 断开的瞬间状态先变、采样可能还没回来，按 state 门控才不会发出旧值。
            let connected = matches!(
                inner.state,
                RuntimeState::Running | RuntimeState::Degraded
            );
            (
                inner.health.clone(),
                if connected { inner.traffic.clone() } else { None },
                if connected { inner.connections } else { None },
                // 出口探测延迟维持契约原义：出口 IP 没测到就不给。
                if connected && inner.health.exit_ip.is_some() {
                    inner.last_exit_ip_latency_ms
                } else {
                    None
                },
                // 节点延迟单独给，不受出口 IP 影响。
                if connected {
                    inner.last_node_latency_ms
                } else {
                    None
                },
            )
        };
        self.emit(RuntimeEvent::HealthChanged(RuntimeHealthChangedPayload {
            contract_version: EVENT_CONTRACT_VERSION,
            health,
            traffic,
            connections,
            latency_ms,
            node_latency_ms,
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
        let Some(mut child) = self.inner.lock().await.child.take() else {
            return;
        };
        let pid = child.id();
        let _ = process::terminate(&mut child, self.cfg.stop_grace).await;
        // 确认死了才删 pid 文件；还活着就留着，让下次启动的 reclaim_stale 再试。
        match pid {
            Some(pid) if process::is_alive(pid) => {
                log::warn!("sing-box pid={pid} 未能终止，保留 runtime.pid 等下次启动回收");
            }
            _ => self.clear_running_pid(),
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
        let code = if reason.contains("timed out") {
            "RUNTIME_START_TIMEOUT"
        } else {
            "RUNTIME_EXITED"
        };
        self.inner.lock().await.last_error = Some(RuntimeErrorInfo::new(code, reason));
    }

    async fn last_error(&self) -> Option<String> {
        self.inner
            .lock()
            .await
            .last_error
            .as_ref()
            .map(|error| error.message.clone())
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
                                .as_ref()
                                .map(|error| error.message.clone())
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
    snapshot: RuntimeStatus,
) -> RuntimeStateChangedPayload {
    RuntimeStateChangedPayload {
        contract_version: EVENT_CONTRACT_VERSION,
        from,
        to,
        event: event.as_str(),
        pid,
        upstream_version,
        reason,
        error: None,
        snapshot,
        emitted_at: now_iso(),
    }
}

/// 把内部广播事件转成前端事件名 + payload。
///
/// 转发层只做这一步：不查状态、不加锁，避免与状态迁移脱节。
pub fn runtime_event_to_emit(
    event: &RuntimeEvent,
) -> Option<(&'static str, serde_json::Value)> {
    match event {
        RuntimeEvent::StateChanged(payload) => Some((
            crate::claurst_session::events::EV_RUNTIME_STATE_CHANGED,
            serde_json::to_value(payload).ok()?,
        )),
        RuntimeEvent::HealthChanged(payload) => Some((
            crate::claurst_session::events::EV_RUNTIME_HEALTH_CHANGED,
            serde_json::to_value(payload).ok()?,
        )),
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

pub fn default_app_data_dir() -> PathBuf {    #[cfg(windows)]
    {
        if let Ok(profile) = std::env::var("USERPROFILE") {
            return crate::veyl_paths::data_dir_under(Path::new(&profile));
        }
        if let Ok(home) = std::env::var("HOME") {
            return crate::veyl_paths::data_dir_under(Path::new(&home));
        }
    }

    #[cfg(not(windows))]
    {
        if let Ok(home) = std::env::var("HOME") {
            return crate::veyl_paths::data_dir_under(Path::new(&home));
        }
    }

    std::env::temp_dir().join("veyl")
}

/// 首次启动准备用户数据目录：`~/.veyl` 0700、`helper-logs` 0755。
///
/// 迁移不做：旧目录用户已删除，这里只保证空目录能全新初始化。
/// 失败不阻断——上层会记录，真正的读写错误在各自的位置再报。
pub fn prepare_app_data_dir(data_dir: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(data_dir)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(data_dir, std::fs::Permissions::from_mode(0o700))?;
    }
    let helper_logs = crate::veyl_paths::helper_logs_dir(data_dir);
    std::fs::create_dir_all(&helper_logs)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&helper_logs, std::fs::Permissions::from_mode(0o755))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        std::env::temp_dir().join(format!("veyl-{tag}-{:016x}", rand::random::<u64>()))
    }

    #[test]
    fn the_default_data_dir_is_dot_veyl() {
        let path = default_app_data_dir();
        assert_eq!(
            path.file_name().and_then(|name| name.to_str()),
            Some(".veyl")
        );
    }

    /// 空目录首次启动：`~/.veyl` 自己 0700，helper 日志目录 0755。
    #[test]
    fn first_start_creates_private_data_dir_and_helper_logs() {
        use std::os::unix::fs::MetadataExt;

        let root = temp_dir("prepare");
        std::fs::create_dir_all(&root).unwrap();
        let data = root.join(".veyl");
        prepare_app_data_dir(&data).unwrap();
        assert_eq!(std::fs::metadata(&data).unwrap().mode() & 0o777, 0o700);
        let helper = data.join("helper-logs");
        assert_eq!(std::fs::metadata(&helper).unwrap().mode() & 0o777, 0o755);

        // 幂等：第二次调用不报错，权限不被改坏。
        prepare_app_data_dir(&data).unwrap();
        assert_eq!(std::fs::metadata(&data).unwrap().mode() & 0o777, 0o700);
        let _ = std::fs::remove_dir_all(&root);
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
            config_id: Some("profile-1".into()),
            config_name: None,
            node_id: None,
            node_name: None,
            applied_route_revision: None,
        }
    }

    /// 假 Clash API：`/version` 返回可解析的版本；delay 端点按 tag 给不同结果
    /// （n1 = 123ms、n2 = 456ms、bad = HTTP 500），用来验证热切换换的是 tag。
    async fn fake_clash_server() -> (u16, tokio::task::JoinHandle<()>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let handle = tokio::spawn(async move {
            loop {
                let Ok((mut socket, _)) = listener.accept().await else {
                    break;
                };
                tokio::spawn(async move {
                    use tokio::io::{AsyncReadExt, AsyncWriteExt};
                    let mut buf = [0u8; 2048];
                    let n = socket.read(&mut buf).await.unwrap_or(0);
                    let request = String::from_utf8_lossy(&buf[..n]);
                    let (status, body) = if request.contains("/proxies/node-n2/delay") {
                        ("200 OK", r#"{"delay":456}"#.to_string())
                    } else if request.contains("/proxies/node-bad/delay") {
                        (
                            "500 Internal Server Error",
                            r#"{"message":"timeout"}"#.to_string(),
                        )
                    } else if request.contains("/delay") {
                        ("200 OK", r#"{"delay":123}"#.to_string())
                    } else {
                        (
                            "200 OK",
                            r#"{"version":"test","meta":false,"premium":false}"#.to_string(),
                        )
                    };
                    let head = format!(
                        "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                        body.len()
                    );
                    let _ = socket.write_all(head.as_bytes()).await;
                    let _ = socket.write_all(body.as_bytes()).await;
                });
            }
        });
        (port, handle)
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn switching_to_a_different_plan_replaces_the_running_child() {
        use std::os::unix::fs::PermissionsExt;

        let dir = temp_dir("switch-plan");
        std::fs::create_dir_all(&dir).unwrap();
        let fake = dir.join("fake-sing-box");
        std::fs::write(&fake, "#!/bin/sh\nexec sleep 30\n").unwrap();
        std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o755)).unwrap();

        let (clash_port, server) = fake_clash_server().await;
        let manager = RuntimeManager::new(RuntimeConfig::new(&dir));

        // 旧连接：一个真实的活进程 + Running 状态。
        let old = tokio::process::Command::new("/usr/bin/tail")
            .args(["-f", "/dev/null"])
            .spawn()
            .unwrap();
        let old_pid = old.id().unwrap();

        let new_plan = StartPlan {
            binary: fake.clone(),
            config_path: dir.join("config-new.json"),
            version: "0.0.0".into(),
            work_dir: dir.clone(),
            log_path: dir.join("runtime.log"),
            clash_addr: format!("127.0.0.1:{clash_port}"),
            clash_secret: "new-secret".into(),
            mixed_port: 4321,
            config_id: Some("profile-2".into()),
            config_name: None,
            node_id: None,
            node_name: None,
            applied_route_revision: None,
        };

        {
            let mut inner = manager.inner.lock().await;
            inner.state = RuntimeState::Running;
            inner.plan = Some(plan(fake, &dir));
            inner.pid = Some(old_pid);
            inner.child = Some(old);
        }

        let status = manager.start(new_plan.clone()).await.unwrap();

        assert_eq!(status.state, RuntimeState::Running);
        assert_ne!(status.pid, Some(old_pid), "切换必须换成新进程");
        assert!(!process::is_alive(old_pid), "旧 child 必须先被终止");
        let current = manager.current_plan().await.unwrap();
        assert_eq!(current.mixed_port, 4321, "新 plan 的端口必须生效");
        assert_eq!(current.config_path, new_plan.config_path);

        manager.stop().await.unwrap();
        server.abort();
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn starting_the_same_plan_does_not_restart_the_child() {
        use std::os::unix::fs::PermissionsExt;

        let dir = temp_dir("same-plan");
        std::fs::create_dir_all(&dir).unwrap();
        let fake = dir.join("fake-sing-box");
        std::fs::write(&fake, "#!/bin/sh\nexec sleep 30\n").unwrap();
        std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o755)).unwrap();

        let (clash_port, server) = fake_clash_server().await;
        let manager = RuntimeManager::new(RuntimeConfig::new(&dir));

        let start_plan = StartPlan {
            binary: fake,
            config_path: dir.join("config.json"),
            version: "0.0.0".into(),
            work_dir: dir.clone(),
            log_path: dir.join("runtime.log"),
            clash_addr: format!("127.0.0.1:{clash_port}"),
            clash_secret: "secret".into(),
            mixed_port: 4321,
            config_id: Some("profile-1".into()),
            config_name: None,
            node_id: None,
            node_name: None,
            applied_route_revision: None,
        };

        let first = manager.start(start_plan.clone()).await.unwrap();
        let pid = first.pid.expect("第一次启动应有 pid");

        let second = manager.start(start_plan).await.unwrap();
        assert_eq!(second.pid, Some(pid), "同一 plan 不应重启进程");
        assert!(process::is_alive(pid), "原进程必须继续运行");

        manager.stop().await.unwrap();
        server.abort();
        let _ = std::fs::remove_dir_all(&dir);
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
    #[cfg(unix)]
    #[tokio::test]
    async fn entering_failed_fires_the_terminal_hook_once() {
        use std::os::unix::fs::PermissionsExt;
        use std::sync::atomic::{AtomicUsize, Ordering};

        let dir = temp_dir("terminal-hook");
        std::fs::create_dir_all(&dir).unwrap();
        let fake = dir.join("fake-sing-box");
        std::fs::write(&fake, "#!/bin/sh\nexit 1\n").unwrap();
        std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o755)).unwrap();

        let mut cfg = RuntimeConfig::new(&dir);
        cfg.startup_timeout = Duration::from_millis(300);
        let manager = RuntimeManager::new(cfg);

        let calls = Arc::new(AtomicUsize::new(0));
        let hook_calls = Arc::clone(&calls);
        manager.set_terminal_failure_hook(Arc::new(move || {
            hook_calls.fetch_add(1, Ordering::SeqCst);
        }));

        let _ = manager.start(plan(fake, &dir)).await;

        assert_eq!(calls.load(Ordering::SeqCst), 1, "进入 Failed 必须触发一次钩子");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_startup_crash_goes_straight_to_failed() {
        let dir = temp_dir("crash");
        std::fs::create_dir_all(&dir).unwrap();
        // 用系统自带的 /usr/bin/false，而不是现写一个 shell 脚本。
        // 并行负载下新脚本的 fork/exec 可能超过 startup_timeout；那时进程确实还活着，
        // 报 TIMEOUT 是正确行为，但这条测试要验证的是「崩溃 → EXITED」。
        let fake = PathBuf::from("/usr/bin/false");

        let mut cfg = RuntimeConfig::new(&dir);
        // 2s 不是放宽断言：只是给并行测试负载下的进程启动留出余量。
        // 断言仍然是「崩溃必须报 RUNTIME_EXITED，不是超时」。
        cfg.startup_timeout = Duration::from_secs(2);
        let manager = RuntimeManager::new(cfg);
        let mut events = manager.subscribe();

        let started = Instant::now();
        let err = manager.start(plan(fake, &dir)).await.unwrap_err();
        eprintln!(
            "[manager-test] crash start failed after {:?}: {err}",
            started.elapsed()
        );
        assert!(matches!(err, RuntimeError::Process(_)), "{err}");

        let status = manager.status().await;
        eprintln!(
            "[manager-test] state={:?} last_error={:?}",
            status.state,
            status.last_error.as_ref().map(|error| (&error.code, &error.message))
        );
        assert_eq!(status.state, RuntimeState::Failed);
        assert_eq!(status.restart_count, 0);
        assert!(status.pid.is_none());
        assert!(status.upstream_version.is_none());
        assert!(status.last_error.is_some());
        assert_eq!(
            status.last_error.as_ref().unwrap().code,
            "RUNTIME_EXITED",
            "last_error 必须是结构化对象"
        );
        assert_eq!(
            status.last_error.as_ref().unwrap().contract_version,
            "2.3.0"
        );

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
                if payload.to == RuntimeState::Failed {
                    assert!(
                        payload.error.is_some(),
                        "failed 迁移必须带上结构化 error"
                    );
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

        assert!(manager.active_config_id().await.is_none());
        assert!(manager.ensure_config_not_active("profile-1").await.is_ok());

        {
            let mut inner = manager.inner.lock().await;
            inner.state = RuntimeState::Running;
            inner.plan = Some(plan(PathBuf::from("/nonexistent"), &dir));
        }

        assert_eq!(
            manager.active_config_id().await.as_deref(),
            Some("profile-1")
        );

        let err = manager
            .ensure_config_not_active("profile-1")
            .await
            .unwrap_err();
        assert_eq!(err.code(), "PRECONDITION_FAILED");
        assert_eq!(
            err.details().unwrap()["reason"],
            serde_json::json!("ACTIVE_CONFIG_IN_USE")
        );

        assert!(manager.ensure_config_not_active("profile-2").await.is_ok());
        let _ = std::fs::remove_dir_all(&dir);
    }


    #[cfg(unix)]
    #[tokio::test]
    async fn restart_after_a_failed_start_is_rejected() {
        use std::os::unix::fs::PermissionsExt;

        let dir = temp_dir("restart-after-failed-start");
        std::fs::create_dir_all(&dir).unwrap();
        let fake = dir.join("fake-sing-box");
        std::fs::write(&fake, "#!/bin/sh\nexit 1\n").unwrap();
        std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o755)).unwrap();

        let mut cfg = RuntimeConfig::new(&dir);
        cfg.startup_timeout = Duration::from_millis(300);
        let manager = RuntimeManager::new(cfg);

        let _ = manager.start(plan(fake, &dir)).await;
        assert_eq!(manager.status().await.state, RuntimeState::Failed);

        let err = manager.restart().await.unwrap_err();
        assert!(
            matches!(err, RuntimeError::InvalidState { .. }),
            "失败后 plan 已清，重启必须是 InvalidState：{err}"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn restart_after_disconnect_is_rejected() {
        let dir = temp_dir("restart-after-stop");
        std::fs::create_dir_all(&dir).unwrap();
        let manager = RuntimeManager::new(RuntimeConfig::new(&dir));

        {
            let mut inner = manager.inner.lock().await;
            inner.state = RuntimeState::Running;
            inner.plan = Some(plan(PathBuf::from("/nonexistent"), &dir));
        }

        manager.stop().await.unwrap();
        assert_eq!(manager.status().await.state, RuntimeState::Idle);

        let err = manager.restart().await.unwrap_err();
        assert!(
            matches!(err, RuntimeError::InvalidState { .. }),
            "配置已删，重启必须是 InvalidState：{err}"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_pid_file_is_written_and_cleared() {
        let dir = temp_dir("pidfile");
        std::fs::create_dir_all(&dir).unwrap();
        let manager = RuntimeManager::new(RuntimeConfig::new(&dir));
        let plan = plan(PathBuf::from("/tmp/veyl/sing-box"), &dir);

        manager.record_running_pid(&plan, 4242);
        let raw = std::fs::read_to_string(dir.join("runtime.pid")).unwrap();
        assert!(raw.contains("4242"), "{raw}");
        assert!(raw.contains("sing-box"), "{raw}");

        manager.clear_running_pid();
        assert!(!dir.join("runtime.pid").exists());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn the_pid_is_recorded_as_soon_as_the_child_starts() {
        let dir = temp_dir("pid-spawn");
        std::fs::create_dir_all(&dir).unwrap();
        let manager = RuntimeManager::new(RuntimeConfig::new(&dir));

        {
            let mut inner = manager.inner.lock().await;
            inner.generation = 1;
            inner.state = RuntimeState::Starting;
            inner.plan = Some(plan(PathBuf::from("/usr/bin/tail"), &dir));
        }

        let child = tokio::process::Command::new("/usr/bin/tail")
            .args(["-f", "/dev/null"])
            .spawn()
            .unwrap();
        let pid = child.id().unwrap();

        manager
            .adopt_child(1, child)
            .await
            .expect("spawn 后应立即接管");

        let record: RunningPid =
            crate::runtime::fsutil::read_json(&manager.running_pid_path())
                .unwrap()
                .unwrap();
        assert_eq!(record.pid, pid, "spawn 后必须立刻有 pid 文件");
        assert_eq!(record.binary, "/usr/bin/tail");

        manager.kill_child().await;
        assert!(!manager.running_pid_path().exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn reclaiming_without_a_pid_file_is_a_noop() {
        let dir = temp_dir("reclaim-empty");
        std::fs::create_dir_all(&dir).unwrap();
        let manager = RuntimeManager::new(RuntimeConfig::new(&dir));
        assert_eq!(manager.reclaim_stale().await.unwrap(), None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_leftover_sing_box_is_reclaimed() {
        let dir = temp_dir("reclaim");
        std::fs::create_dir_all(&dir).unwrap();

        // 用 sh 起一个真正的孤儿进程（父进程立刻退出），模拟上次应用遗留的 sing-box；
        // 直接 spawn 的话它是测试进程的子进程，被杀后会变僵尸，kill(pid,0) 仍返回存活。
        // argv[0] 与配置路径都必须和记录一致，否则会被新的严格校验跳过。
        let config = dir.join("config.json");
        std::fs::write(&config, "{}").unwrap();
        let output = std::process::Command::new("sh")
            .arg("-c")
            .arg(format!(
                "nohup /usr/bin/tail -f {} >/dev/null 2>&1 & echo $!",
                config.display()
            ))
            .output()
            .unwrap();
        let pid: u32 = String::from_utf8_lossy(&output.stdout).trim().parse().unwrap();

        let record = RunningPid {
            pid,
            binary: "/usr/bin/tail".into(),
            config: config.to_string_lossy().into_owned(),
            started_at: 1,
        };
        crate::runtime::fsutil::write_atomic_json(&dir.join("runtime.pid"), &record).unwrap();

        let manager = RuntimeManager::new(RuntimeConfig::new(&dir));
        assert_eq!(manager.reclaim_stale().await.unwrap(), Some(pid));
        assert!(!process::is_alive(pid), "遗留进程必须被终止");
        assert!(!dir.join("runtime.pid").exists(), "pid 文件应清理掉");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_reused_pid_is_not_killed() {
        let dir = temp_dir("reclaim-reuse");
        std::fs::create_dir_all(&dir).unwrap();

        // pid 指向测试进程自己，但记录里的 binary 是 sing-box：
        // 命令行对不上，绝不能杀。
        let record = RunningPid {
            pid: std::process::id(),
            binary: "/opt/veyl/sing-box".into(),
            config: "/tmp/whatever.json".into(),
            started_at: 1,
        };
        crate::runtime::fsutil::write_atomic_json(&dir.join("runtime.pid"), &record).unwrap();

        let manager = RuntimeManager::new(RuntimeConfig::new(&dir));
        assert_eq!(manager.reclaim_stale().await.unwrap(), None);
        assert!(
            dir.join("runtime.pid").exists(),
            "无法确认身份的记录保留供排查，不静默清除"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_command_line_that_only_mentions_sing_box_is_not_killed() {
        let dir = temp_dir("reclaim-lookalike");
        std::fs::create_dir_all(&dir).unwrap();
        let log = dir.join("sing-box.log");
        std::fs::write(&log, "").unwrap();

        // 命令行里有 sing-box，但 argv[0] 是 tail：这是用户进程，绝不能杀。
        let mut child = tokio::process::Command::new("/usr/bin/tail")
            .arg("-f")
            .arg(&log)
            .spawn()
            .unwrap();
        let pid = child.id().unwrap();

        let record = RunningPid {
            pid,
            binary: "/opt/veyl/sing-box".into(),
            config: dir.join("config.json").to_string_lossy().into_owned(),
            started_at: 1,
        };
        crate::runtime::fsutil::write_atomic_json(&dir.join("runtime.pid"), &record).unwrap();

        let manager = RuntimeManager::new(RuntimeConfig::new(&dir));
        assert_eq!(manager.reclaim_stale().await.unwrap(), None);
        assert!(
            process::is_alive(pid),
            "命令行只是含 sing-box 的用户进程不能被杀"
        );
        assert!(
            manager.running_pid_path().exists(),
            "无法确认的记录不能被静默清除"
        );

        let _ = child.kill().await;
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn snapshot_carries_live_connection_fields() {
        let mut inner = Inner::new();
        inner.state = RuntimeState::Running;
        let mut current = plan(PathBuf::from("/tmp/sing-box"), std::path::Path::new("/tmp"));
        current.mixed_port = 4321;
        current.config_name = Some("东京 01".into());
        inner.plan = Some(current);
        inner.connected_since = Some("2026-11-02T00:00:00Z".into());
        inner.health.exit_ip = Some("203.0.113.10".into());
        inner.direct_ip = Some("198.51.100.7".into());
        inner.last_exit_ip_latency_ms = Some(123);
        inner.last_node_latency_ms = Some(45);

        let snapshot = inner.snapshot();
        assert_eq!(snapshot.mixed_port, Some(4321));
        assert_eq!(snapshot.config_name.as_deref(), Some("东京 01"));
        assert_eq!(
            snapshot.connected_since.as_deref(),
            Some("2026-11-02T00:00:00Z")
        );
        assert_eq!(snapshot.latency_ms, Some(123), "latency_ms 仍是出口探测耗时");
        assert_eq!(snapshot.node_latency_ms, Some(45), "节点延迟单独成字段");
        assert_eq!(snapshot.direct_ip.as_deref(), Some("198.51.100.7"));

        // 两个指标互不门控：出口 IP 没测到，latency_ms 变 null，节点延迟照常展示。
        inner.health.exit_ip = None;
        let snapshot = inner.snapshot();
        assert!(snapshot.latency_ms.is_none());
        assert_eq!(snapshot.node_latency_ms, Some(45));

        inner.state = RuntimeState::Failed;
        let snapshot = inner.snapshot();
        assert!(snapshot.mixed_port.is_none());
        assert!(snapshot.config_name.is_none());
        assert!(snapshot.connected_since.is_none());
        assert!(snapshot.latency_ms.is_none());
        assert!(snapshot.node_latency_ms.is_none());
        assert!(snapshot.direct_ip.is_none());
    }

    /// 断开之后晚到的采样必须丢掉：否则会发出「未连接却有流量」的快照。
    #[tokio::test]
    async fn a_late_traffic_sample_is_dropped_after_stop() {
        let manager = RuntimeManager::new(RuntimeConfig::new(temp_dir("late-sample")));
        {
            let mut inner = manager.inner.lock().await;
            inner.generation = 7;
            inner.state = RuntimeState::Running;
        }

        let sample = ConnectionSample {
            up_bytes: 10,
            down_bytes: 20,
            active: Some(1),
        };
        assert!(manager.set_traffic_if_live(7, sample, 1, 1).await);
        {
            let inner = manager.inner.lock().await;
            assert_eq!(inner.connections, Some(1));
            assert!(inner.traffic.is_some());
        }

        // 断开：状态回落、流量清空。
        {
            let mut inner = manager.inner.lock().await;
            inner.state = RuntimeState::Idle;
            inner.desired_stop = true;
            inner.traffic = None;
            inner.connections = None;
        }
        assert!(
            !manager.set_traffic_if_live(7, sample, 1, 1).await,
            "断开后晚到的采样不能写回"
        );
        {
            let inner = manager.inner.lock().await;
            assert!(inner.traffic.is_none());
            assert!(inner.connections.is_none());
        }

        // generation 变了（重连）也不能写进新连接。
        {
            let mut inner = manager.inner.lock().await;
            inner.state = RuntimeState::Running;
            inner.desired_stop = false;
            inner.generation = 8;
        }
        assert!(!manager.set_traffic_if_live(7, sample, 1, 1).await);
    }

    /// 活跃连接数在响应里缺失时保留上一次的值：未知 ≠ 0。
    #[tokio::test]
    async fn a_sample_without_connections_keeps_the_previous_count() {
        let manager = RuntimeManager::new(RuntimeConfig::new(temp_dir("no-connections")));
        {
            let mut inner = manager.inner.lock().await;
            inner.generation = 1;
            inner.state = RuntimeState::Running;
        }
        manager
            .set_traffic_if_live(
                1,
                ConnectionSample {
                    up_bytes: 1,
                    down_bytes: 1,
                    active: Some(4),
                },
                0,
                0,
            )
            .await;
        manager
            .set_traffic_if_live(
                1,
                ConnectionSample {
                    up_bytes: 2,
                    down_bytes: 2,
                    active: None,
                },
                0,
                0,
            )
            .await;

        let inner = manager.inner.lock().await;
        assert_eq!(inner.connections, Some(4), "缺失时不能落成 0");
        assert_eq!(inner.traffic.clone().unwrap()["down_bytes"], 2);
    }

    /// 流量只在连接期间出现；未连接时必须是 null，不能是 0。
    #[test]
    fn traffic_is_exposed_only_while_connected() {
        let mut inner = Inner::new();
        inner.traffic = Some(serde_json::json!({
            "up_bytes": 1024,
            "down_bytes": 2048,
            "up_rate": 0,
            "down_rate": 0,
            "sampled_at": "2026-11-04T00:00:00Z",
        }));

        assert!(
            inner.snapshot().traffic.is_none(),
            "未连接时不能带流量：0 字节和没有数据要能区分"
        );
        assert!(
            inner.snapshot().connections.is_none(),
            "未连接时连接数必须是 null"
        );

        inner.state = RuntimeState::Running;
        inner.connections = Some(3);
        let snapshot = inner.snapshot();
        assert_eq!(snapshot.traffic.unwrap()["down_bytes"], 2048);
        assert_eq!(snapshot.connections, Some(3));

        inner.state = RuntimeState::Failed;
        assert!(inner.snapshot().traffic.is_none(), "失败后不能留着上次的流量");
        assert!(inner.snapshot().connections.is_none());
    }

    #[test]
    fn snapshot_hides_identity_when_terminal() {
        let mut inner = Inner::new();
        inner.state = RuntimeState::Failed;
        inner.pid = Some(4242);
        inner.version = Some("1.14.4".into());
        let snapshot = inner.snapshot();
        assert!(snapshot.pid.is_none());
        assert!(snapshot.upstream_version.is_none());
        assert!(snapshot.uptime_seconds.is_none());
        assert!(snapshot.mode.is_none());
    }

    #[test]
    fn runtime_events_map_to_frozen_event_names() {
        let mut inner = Inner::new();
        inner.state = RuntimeState::Starting;
        let state_event = RuntimeEvent::StateChanged(state_payload(
            RuntimeState::Idle,
            RuntimeState::Starting,
            RuntimeEventKind::StartReq,
            None,
            None,
            None,
            inner.snapshot(),
        ));

        let (name, payload) = runtime_event_to_emit(&state_event).unwrap();
        assert_eq!(name, "runtime-state-changed");
        assert_eq!(payload["from"], "idle");
        assert_eq!(payload["to"], "starting");
        assert_eq!(payload["snapshot"]["state"], "starting");
        assert!(
            payload["snapshot"]["health"].is_object(),
            "快照必须带齐顶层字段，缺 health 前端会崩"
        );
        assert!(payload["emitted_at"].is_string());

        let health_event = RuntimeEvent::HealthChanged(RuntimeHealthChangedPayload {
            contract_version: EVENT_CONTRACT_VERSION,
            health: HealthSnapshot::default(),
            traffic: None,
            connections: None,
            latency_ms: None,
            node_latency_ms: None,
            emitted_at: now_iso(),
        });
        let (name, payload) = runtime_event_to_emit(&health_event).unwrap();
        assert_eq!(name, "runtime-health-changed");
        assert!(payload["health"].is_object());
        assert!(
            payload["traffic"].is_null(),
            "没有采样必须是 null，不能用 0 冒充"
        );
        assert!(payload["connections"].is_null());
        assert!(payload["node_latency_ms"].is_null());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn state_changed_events_carry_snapshot_matching_to() {
        use std::os::unix::fs::PermissionsExt;

        let dir = temp_dir("state-snapshot");
        std::fs::create_dir_all(&dir).unwrap();
        let fake = dir.join("fake-sing-box");
        std::fs::write(&fake, "#!/bin/sh\nexec sleep 30\n").unwrap();
        std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o755)).unwrap();

        let (clash_port, server) = fake_clash_server().await;
        let manager = RuntimeManager::new(RuntimeConfig::new(&dir));
        let mut events = manager.subscribe();

        let mut launch = plan(fake, &dir);
        launch.clash_addr = format!("127.0.0.1:{clash_port}");

        let status = manager.start(launch).await.unwrap();
        assert_eq!(status.state, RuntimeState::Running);
        manager.stop().await.unwrap();
        server.abort();

        let mut reached_running = false;
        while let Ok(event) = events.try_recv() {
            if let RuntimeEvent::StateChanged(payload) = event {
                assert_eq!(
                    payload.snapshot.state,
                    payload.to,
                    "snapshot.state 必须等于 to（{} → {}）",
                    payload.from.as_str(),
                    payload.to.as_str()
                );
                if payload.to == RuntimeState::Running {
                    reached_running = true;
                    assert_eq!(payload.snapshot.config_id.as_deref(), Some("profile-1"));
                    assert_eq!(payload.snapshot.pid, status.pid);
                }
            }
        }
        assert!(reached_running, "必须收到进入 running 的迁移事件");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 节点延迟来自 Clash delay，且与 `latency_ms`（出口探测耗时）是两个字段。
    #[cfg(unix)]
    #[tokio::test]
    async fn node_latency_is_separate_from_exit_probe_latency() {
        use std::os::unix::fs::PermissionsExt;

        let dir = temp_dir("node-latency");
        std::fs::create_dir_all(&dir).unwrap();
        let fake = dir.join("fake-sing-box");
        std::fs::write(&fake, "#!/bin/sh\nexec sleep 30\n").unwrap();
        std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o755)).unwrap();

        let (clash_port, server) = fake_clash_server().await;
        let manager = RuntimeManager::new(RuntimeConfig::new(&dir));
        let mut events = manager.subscribe();

        let mut launch = plan(fake, &dir);
        launch.clash_addr = format!("127.0.0.1:{clash_port}");
        launch.node_id = Some("n1".into());

        let status = manager.start(launch).await.unwrap();
        assert_eq!(status.state, RuntimeState::Running);

        // 一进入 running 就会测一次；等第一条带 node_latency_ms 的 health 事件。
        let mut node_latency = None;
        let mut exit_latency = None;
        let deadline = Instant::now() + Duration::from_secs(5);
        while node_latency.is_none() && Instant::now() < deadline {
            match tokio::time::timeout(Duration::from_millis(300), events.recv()).await {
                Ok(Ok(RuntimeEvent::HealthChanged(payload))) => {
                    node_latency = payload.node_latency_ms;
                    if node_latency.is_some() {
                        exit_latency = payload.latency_ms;
                    }
                }
                Ok(Ok(_)) | Ok(Err(_)) => {}
                Err(_) => {}
            }
        }
        assert_eq!(node_latency, Some(123), "health 事件必须带 Clash delay 的值");
        assert!(
            exit_latency.is_none(),
            "latency_ms 是出口探测耗时：出口没测到就只能是 null，不能拿节点延迟顶替"
        );
        assert_eq!(
            manager.status().await.node_latency_ms,
            Some(123),
            "快照里必须有节点延迟"
        );

        manager.stop().await.unwrap();
        let stopped = manager.status().await;
        assert!(stopped.latency_ms.is_none(), "断开后出口探测延迟要清空");
        assert!(stopped.node_latency_ms.is_none(), "断开后节点延迟要清空");
        let inner = manager.inner.lock().await;
        assert!(inner.last_exit_ip_latency_ms.is_none());
        assert!(inner.last_node_latency_ms.is_none());

        server.abort();
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 等到一条 `node_latency_ms == want` 的 health 事件。
    async fn wait_for_latency(events: &mut broadcast::Receiver<RuntimeEvent>, want: u64) -> bool {
        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline {
            match tokio::time::timeout(Duration::from_millis(300), events.recv()).await {
                Ok(Ok(RuntimeEvent::HealthChanged(payload)))
                    if payload.node_latency_ms == Some(want) =>
                {
                    return true;
                }
                Ok(Ok(_)) | Ok(Err(_)) | Err(_) => {}
            }
        }
        false
    }

    /// 热切换只改 inner.plan，不换 gen：延迟必须清空并用新节点的 tag 重测。
    #[cfg(unix)]
    #[tokio::test]
    async fn hot_switching_nodes_clears_and_remeasures_latency() {
        use std::os::unix::fs::PermissionsExt;

        let dir = temp_dir("latency-switch");
        std::fs::create_dir_all(&dir).unwrap();
        let fake = dir.join("fake-sing-box");
        std::fs::write(&fake, "#!/bin/sh\nexec sleep 30\n").unwrap();
        std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o755)).unwrap();

        let (clash_port, server) = fake_clash_server().await;
        let manager = RuntimeManager::new(RuntimeConfig::new(&dir));
        let mut events = manager.subscribe();

        let mut launch = plan(fake, &dir);
        launch.clash_addr = format!("127.0.0.1:{clash_port}");
        launch.node_id = Some("n1".into());

        manager.start(launch).await.unwrap();
        assert!(wait_for_latency(&mut events, 123).await, "n1 必须先测出 123");

        // 热切换：不换 gen、不重进 enter_running。
        manager.set_plan_node("n2".into(), "节点二".into()).await;
        assert!(
            manager.status().await.node_latency_ms.is_none(),
            "切换瞬间必须清空旧节点的延迟"
        );
        assert!(
            wait_for_latency(&mut events, 456).await,
            "必须用 node-n2 的 tag 重测，而不是继续测旧节点"
        );

        manager.stop().await.unwrap();
        server.abort();
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 探测失败必须清成 null，不能保留上一次的数字。
    #[tokio::test]
    async fn a_failed_delay_probe_clears_the_previous_latency() {
        let dir = temp_dir("latency-fail");
        std::fs::create_dir_all(&dir).unwrap();
        let (clash_port, server) = fake_clash_server().await;

        let manager = RuntimeManager::new(RuntimeConfig::new(&dir));
        let mut bad = plan(PathBuf::from("/tmp/sing-box"), &dir);
        bad.clash_addr = format!("127.0.0.1:{clash_port}");
        bad.node_id = Some("bad".into());
        {
            let mut inner = manager.inner.lock().await;
            inner.state = RuntimeState::Running;
            inner.generation = 7;
            inner.last_node_latency_ms = Some(999);
            inner.plan = Some(bad.clone());
        }

        manager.clone().probe_latency(7, bad).await;
        assert!(
            manager.inner.lock().await.last_node_latency_ms.is_none(),
            "探测失败后延迟必须是 null，不能留着上一次的值"
        );

        server.abort();
        let _ = std::fs::remove_dir_all(&dir);
    }
}
