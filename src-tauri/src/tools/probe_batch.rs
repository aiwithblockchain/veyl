//! UI 批量测速（`docs/design/node-list.md` §6）。
//!
//! 批次只在内存里：不进 Job、不落库、不发 `*-changed`；应用退出直接丢掉。
//! 同一时刻全局只允许一个批次，跨配置也一样。

use std::collections::{HashMap, HashSet, VecDeque};
use std::future::Future;
use std::path::Path;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use parking_lot::Mutex;
use serde_json::{json, Value};
use tokio_util::sync::CancellationToken;

use crate::config as vpn_config;
use crate::runtime::{InstalledRuntime, RuntimeManager, StartPlan};
use crate::store::configs::Node;
use crate::store::{configs, Store};

use super::services::{clash_delay, probe_ok, probe_unreachable, probe_untested};

pub const CONCURRENCY: usize = 6;

/// 单节点测速留下的空闲运行时：60 秒内再点测直接复用，不冷启动。
pub const IDLE_TTL: Duration = Duration::from_secs(60);

/// 一批测速只选一种方式：已连接本配置走当前 Clash 延迟，其余需要临时运行时。
#[derive(Clone)]
pub struct ClashTarget {
    pub addr: String,
    pub secret: String,
}

/// 临时探针运行时起不来的原因，映射成 `untested` 的 `reason`。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProbeFailure {
    Missing,
    Failed,
    Timeout,
    Cancelled,
}

impl ProbeFailure {
    pub fn reason(self) -> &'static str {
        match self {
            Self::Missing => "runtime_missing",
            Self::Failed => "runtime_failed",
            Self::Timeout => "runtime_timeout",
            Self::Cancelled => "connection_busy",
        }
    }
}

/// 唯一测得口径：Clash `/proxies/node-<id>/delay`，经 sing-box 真发一次请求。
pub async fn probe_node(node: &Node, target: &ClashTarget) -> Value {
    // 没有凭据的节点在渲染运行配置时就被跳过了，selector 里不会有它的 tag。
    if crate::secrets::get_secret(&node.password_ref)
        .ok()
        .flatten()
        .is_none()
    {
        return probe_untested(&node.id, "no_credentials");
    }
    match clash_delay(&target.addr, &target.secret, &format!("node-{}", node.id)).await {
        Ok(latency) => probe_ok(&node.id, latency),
        // 节点在池里但还没进运行配置：如实报未测，不能冒充「连不通」。
        Err(crate::runtime::health::DelayError::ProxyNotFound) => {
            probe_untested(&node.id, "node_not_in_running_config")
        }
        Err(error) => probe_unreachable(&node.id, &error.to_string()),
    }
}

/// 一条批次的状态。`done` 会被快照与进度事件同时读。
pub struct BatchMeta {
    run_id: String,
    config_id: String,
    total: usize,
    done: AtomicUsize,
    started_at: i64,
    phase: Mutex<&'static str>,
    method: Mutex<&'static str>,
    reason: Mutex<Option<&'static str>>,
    cancel: CancellationToken,
}

pub struct StartedBatch {
    pub meta: Arc<BatchMeta>,
    pub run_id: String,
    pub total: usize,
}

impl BatchMeta {
    pub fn cancel_token(&self) -> CancellationToken {
        self.cancel.clone()
    }

    pub fn is_cancelled(&self) -> bool {
        self.cancel.is_cancelled()
    }
}

/// 进程内批次与结果缓存。缓存键是 `node_id`，跨配置共用。
#[derive(Default)]
pub struct ProbeBatchState {
    current: Mutex<Option<Arc<BatchMeta>>>,
    cache: Mutex<HashMap<String, Value>>,
    /// 参数改过、缓存已作废的节点：在途批次回写时也要丢掉它们的结果。
    /// 下一次批次开始（重新测）时整体清空。
    stale: Mutex<HashSet<String>>,
    /// 单节点测速留下的空闲探针（仅同一配置可复用）。
    idle: Mutex<Option<IdleProbe>>,
    /// 正在启动的空闲探针：用户开始连接时要能取消它。
    idle_cancel: Mutex<Option<CancellationToken>>,
    /// 让过期的定时器不再误杀新一代探针。
    generation: AtomicU64,
}

struct IdleProbe {
    config_id: String,
    addr: String,
    secret: String,
    generation: u64,
    expires_at: std::time::Instant,
}

impl ProbeBatchState {
    /// 开始一次空闲探针启动：清掉旧槽位并返回用于取消的令牌。
    pub fn begin_idle_probe(&self) -> (u64, CancellationToken) {
        let generation = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
        *self.idle.lock() = None;
        let token = CancellationToken::new();
        *self.idle_cancel.lock() = Some(token.clone());
        (generation, token)
    }

    /// 停掉空闲探针的复用资格；正在启动的那次也一并取消。
    pub fn cancel_idle(&self) {
        self.generation.fetch_add(1, Ordering::SeqCst);
        *self.idle.lock() = None;
        if let Some(token) = self.idle_cancel.lock().take() {
            token.cancel();
        }
    }

    /// 同一配置、未过期的空闲探针。
    pub fn idle_target(&self, config_id: &str) -> Option<ClashTarget> {
        let mut idle = self.idle.lock();
        match idle.as_ref() {
            Some(state) if state.config_id == config_id => {
                if std::time::Instant::now() < state.expires_at {
                    Some(ClashTarget {
                        addr: state.addr.clone(),
                        secret: state.secret.clone(),
                    })
                } else {
                    *idle = None;
                    None
                }
            }
            _ => None,
        }
    }

    /// 记下一次可复用的空闲探针，返回新一代编号（定时器用它判断是否过期）。
    ///
    /// `expected` 是启动开始时拿到的编号：期间用户开始连接（`cancel_idle` 会
    /// 递增编号）时不再记录，避免把已被连接抢走进程的探针留在槽里。
    pub fn note_idle(
        &self,
        config_id: &str,
        target: &ClashTarget,
        expected: Option<u64>,
    ) -> Option<u64> {
        self.note_idle_with_ttl(config_id, target, expected, IDLE_TTL)
    }

    fn note_idle_with_ttl(
        &self,
        config_id: &str,
        target: &ClashTarget,
        expected: Option<u64>,
        ttl: Duration,
    ) -> Option<u64> {
        let mut idle = self.idle.lock();
        if let Some(expected) = expected {
            if self.generation.load(Ordering::SeqCst) != expected {
                return None;
            }
        }
        let generation = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
        *idle = Some(IdleProbe {
            config_id: config_id.to_string(),
            addr: target.addr.clone(),
            secret: target.secret.clone(),
            generation,
            expires_at: std::time::Instant::now() + ttl,
        });
        self.idle_cancel.lock().take();
        Some(generation)
    }

    /// 定时器到点：只有槽里还是自己那一代时才允许停进程。
    pub fn expire_idle(&self, generation: u64) -> bool {
        let mut idle = self.idle.lock();
        if idle.as_ref().map(|state| state.generation) == Some(generation) {
            *idle = None;
            true
        } else {
            false
        }
    }

    /// 节点参数变了：旧结果作废，正在跑的批次回写这个节点时也丢弃。
    /// 空闲探针的运行时是用旧渲染配置起的，一并停掉，免得 60 秒内复用。
    pub fn forget_node(&self, node_id: &str) {
        self.cache.lock().remove(node_id);
        self.stale.lock().insert(node_id.to_string());
        self.cancel_idle();
    }

    /// 测试用：直接放一条缓存结果，模拟「这个节点之前测过」。
    #[cfg(test)]
    pub(crate) fn seed_cache_for_test(&self, node_id: &str, result: Value) {
        self.cache.lock().insert(node_id.to_string(), result);
    }

    /// 启动一批。已有批次在跑时返回它的 `run_id`（调用方映射成 BUSY）。
    /// `method` 是整批唯一使用的方式：`clash` 或 `none`。
    pub fn start(
        &self,
        config_id: &str,
        total: usize,
        method: &'static str,
    ) -> Result<StartedBatch, String> {
        let mut current = self.current.lock();
        if let Some(existing) = current.as_ref() {
            if !existing.cancel.is_cancelled() {
                // 已有批次在跑：不能顺手清失效集合——那会让在跑的旧批次
                // 把改过参数的节点结果写回缓存。只有真正开新批次时才清。
                return Err(existing.run_id.clone());
            }
        }
        // 新批次会按当前参数重测：上次作废的节点这次可以重新写缓存。
        self.stale.lock().clear();
        let run_id = new_run_id();
        let meta = Arc::new(BatchMeta {
            run_id: run_id.clone(),
            config_id: config_id.to_string(),
            total,
            done: AtomicUsize::new(0),
            started_at: now_ms(),
            phase: Mutex::new("preparing"),
            method: Mutex::new(method),
            reason: Mutex::new(None),
            cancel: CancellationToken::new(),
        });
        *current = Some(Arc::clone(&meta));
        Ok(StartedBatch {
            meta,
            run_id,
            total,
        })
    }

    /// 幂等：批次不存在或已结束返回 false，不报错。
    pub fn cancel(&self, run_id: &str) -> bool {
        let current = self.current.lock();
        match current.as_ref() {
            Some(meta) if meta.run_id == run_id => {
                meta.cancel.cancel();
                true
            }
            _ => false,
        }
    }

    /// 用户开始连接时停掉正在跑的批次，并在 finished 里说明原因。
    /// 空闲的探针运行时同理：连接要独占运行时槽位，复用资格立即作废。
    pub fn cancel_for_connection(&self) {
        self.cancel_idle();
        let current = self.current.lock();
        if let Some(meta) = current.as_ref() {
            *meta.reason.lock() = Some("connected");
            meta.cancel.cancel();
        }
    }

    /// 是否有批次正在跑（已取消的批次不算）。单节点测速不能与批次抢同一个运行时槽位。
    pub fn has_running_batch(&self) -> bool {
        self.current
            .lock()
            .as_ref()
            .is_some_and(|meta| !meta.cancel.is_cancelled())
    }

    /// 返回该配置节点集里的缓存结果，以及「该配置是否有批次在跑」。
    /// 别的配置在跑时 `run` 为 None，但这不代表没有批次。
    pub fn snapshot(&self, config_id: &str, node_ids: &[String]) -> (Vec<Value>, Option<Value>) {
        let results = {
            let cache = self.cache.lock();
            node_ids
                .iter()
                .filter_map(|id| cache.get(id).cloned())
                .collect()
        };
        let run = self
            .current
            .lock()
            .as_ref()
            .filter(|meta| meta.config_id == config_id)
            .map(|meta| {
                json!({
                    "run_id": meta.run_id,
                    "done": meta.done.load(Ordering::SeqCst),
                    "total": meta.total,
                    "started_at": meta.started_at,
                    "phase": *meta.phase.lock(),
                    "method": *meta.method.lock(),
                })
            });
        (results, run)
    }

    fn record(&self, result: &Value) {
        if let Some(node_id) = result.get("node_id").and_then(Value::as_str) {
            let stale = {
                let stale = self.stale.lock();
                stale.contains(node_id)
            };
            // 参数改过之后，在途批次回来的旧结果不能写进缓存。
            if stale {
                return;
            }
            self.cache.lock().insert(node_id.to_string(), result.clone());
        }
    }

    fn finish(&self, run_id: &str) {
        let mut current = self.current.lock();
        if current
            .as_ref()
            .map(|meta| meta.run_id.as_str())
            == Some(run_id)
        {
            *current = None;
        }
    }
}

pub struct BatchOutcome {
    pub done: usize,
    pub ok: usize,
    pub failed: usize,
    /// 没测成的节点数：`ok + failed + untested == done`。
    pub untested: usize,
    pub cancelled: bool,
    pub network: &'static str,
    pub method: &'static str,
    pub reason: Option<&'static str>,
}

/// 跑一批：固定 6 路，按完成顺序发进度；单点失败不中断。
///
/// `probe` 由调用方决定方式（一批只用一种），这里只负责调度、缓存与事件。
pub async fn run_batch<F, Fut>(
    state: Arc<ProbeBatchState>,
    meta: Arc<BatchMeta>,
    nodes: Vec<Node>,
    probe: F,
) -> BatchOutcome
where
    F: Fn(&Node) -> Fut + Send + Sync + 'static,
    Fut: Future<Output = Value> + Send + 'static,
{
    run_batch_inner(state, meta, nodes, probe, true).await
}

/// 已经做过准备阶段的批次：不再发 `preparing`，直接以最终方式进入 `probing`。
pub async fn run_batch_probing<F, Fut>(
    state: Arc<ProbeBatchState>,
    meta: Arc<BatchMeta>,
    nodes: Vec<Node>,
    probe: F,
) -> BatchOutcome
where
    F: Fn(&Node) -> Fut + Send + Sync + 'static,
    Fut: Future<Output = Value> + Send + 'static,
{
    run_batch_inner(state, meta, nodes, probe, false).await
}

async fn run_batch_inner<F, Fut>(
    state: Arc<ProbeBatchState>,
    meta: Arc<BatchMeta>,
    nodes: Vec<Node>,
    probe: F,
    announce_preparing: bool,
) -> BatchOutcome
where
    F: Fn(&Node) -> Fut + Send + Sync + 'static,
    Fut: Future<Output = Value> + Send + 'static,
{
    // 先把阶段告诉 UI：准备阶段没有结果；随后进入探测并锁定方式。
    // 已被取消（例如用户刚点了连接）就不要再发进度。
    if !meta.cancel.is_cancelled() {
        if announce_preparing {
            emit_progress(&meta, "preparing", 0, None);
        }
        *meta.phase.lock() = "probing";
        emit_progress(&meta, "probing", 0, None);
    }

    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<Value>();
    let queue = Arc::new(Mutex::new(VecDeque::from(nodes)));
    let probe = Arc::new(probe);
    let mut workers = Vec::new();
    for _ in 0..CONCURRENCY {
        let queue = Arc::clone(&queue);
        let tx = tx.clone();
        let meta = Arc::clone(&meta);
        let probe = Arc::clone(&probe);
        workers.push(tokio::spawn(async move {
            loop {
                if meta.cancel.is_cancelled() {
                    break;
                }
                let node = queue.lock().pop_front();
                let Some(node) = node else { break };
                let result = probe(&node).await;
                // 取消后不再产出：在飞探测的结果直接丢弃。
                if meta.cancel.is_cancelled() || tx.send(result).is_err() {
                    break;
                }
            }
        }));
    }
    drop(tx);

    let mut ok = 0usize;
    // 测不通（真经隧道失败）与没测成分开计：界面不能把「没跑」说成「都不通」。
    let mut failed = 0usize;
    let mut untested = 0usize;
    loop {
        tokio::select! {
            _ = meta.cancel.cancelled() => break,
            item = rx.recv() => {
                let Some(result) = item else { break };
                let done = meta.done.fetch_add(1, Ordering::SeqCst) + 1;
                match result.get("reachable").and_then(Value::as_bool) {
                    Some(true) => ok += 1,
                    Some(false) => failed += 1,
                    None => untested += 1,
                }
                state.record(&result);
                emit_progress(&meta, "probing", done, Some(&result));
            }
        }
    }
    for worker in &workers {
        worker.abort();
    }
    let _ = tokio::task::yield_now().await;

    let cancelled = meta.cancel.is_cancelled();
    let done = meta.done.load(Ordering::SeqCst);
    debug_assert_eq!(ok + failed + untested, done);
    // 只有「全部失败」才多打一次本机连通性检查，避免把节点故障误报成本机断网。
    // 有 untested 就不是「全部失败」：没测的节点不能当失败证据。
    let network = if !cancelled
        && ok == 0
        && failed > 0
        && untested == 0
        && done == meta.total
        && done > 0
    {
        local_network().await
    } else {
        "ok"
    };
    emit_finished(&meta, ok, failed, untested, cancelled, network);
    let reason = *meta.reason.lock();
    state.finish(&meta.run_id);
    BatchOutcome {
        done,
        ok,
        failed,
        untested,
        cancelled,
        network,
        method: *meta.method.lock(),
        reason,
    }
}

/// 准备阶段结束后再确定最终方式（运行时起不来就是 `none`：整批标成未测）。
pub fn set_method(meta: &BatchMeta, method: &'static str) {
    *meta.method.lock() = method;
}

/// 准备阶段的第一条事件；探测阶段的 `probing` 由 `run_batch_probing` 发。
pub fn emit_preparing(meta: &BatchMeta) {
    emit_progress(meta, "preparing", 0, None);
}

fn emit_progress(meta: &BatchMeta, phase: &str, done: usize, result: Option<&Value>) {
    crate::agent::app_handle::emit(
        "node-probe-progress",
        json!({
            "contract_version": crate::runtime::EVENT_CONTRACT_VERSION,
            "run_id": meta.run_id,
            "config_id": meta.config_id,
            "phase": phase,
            "method": *meta.method.lock(),
            "done": done,
            "total": meta.total,
            "result": result,
            "emitted_at": now_rfc3339(),
        }),
    );
}

/// `ok + failed + untested == done`；`failed` 只算真测过且不通的节点。
fn emit_finished(
    meta: &BatchMeta,
    ok: usize,
    failed: usize,
    untested: usize,
    cancelled: bool,
    network: &str,
) {
    crate::agent::app_handle::emit(
        "node-probe-finished",
        json!({
            "contract_version": crate::runtime::EVENT_CONTRACT_VERSION,
            "run_id": meta.run_id,
            "config_id": meta.config_id,
            "total": meta.total,
            "ok": ok,
            "failed": failed,
            "untested": untested,
            "method": *meta.method.lock(),
            "cancelled": cancelled,
            "reason": *meta.reason.lock(),
            "network": network,
            "emitted_at": now_rfc3339(),
        }),
    );
}

/// 不走代理的 204 检查：代理本身坏了时不能误判成本机断网。
async fn local_network() -> &'static str {
    let Ok(client) = reqwest::Client::builder()
        .no_proxy()
        .timeout(std::time::Duration::from_secs(3))
        .build()
    else {
        return "offline";
    };
    match client
        .get("https://www.gstatic.com/generate_204")
        .send()
        .await
    {
        Ok(response) if response.status().is_success() => "ok",
        _ => "offline",
    }
}

fn new_run_id() -> String {
    format!("probe_{}", crate::config::random_secret())
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

fn now_rfc3339() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

/// 面板搜索过滤后的「测这 N 个」：只保留属于该配置的 id，未知 id 原样返回。
/// 调用方负责把空结果映射成 `no_nodes`。
pub fn select_nodes(all: &[Node], ids: Option<&[String]>) -> (Vec<Node>, Vec<String>) {
    let Some(ids) = ids else {
        return (all.to_vec(), Vec::new());
    };
    let selected = all
        .iter()
        .filter(|node| ids.iter().any(|id| id == &node.id))
        .cloned()
        .collect();
    let ignored = ids
        .iter()
        .filter(|id| !all.iter().any(|node| &node.id == *id))
        .cloned()
        .collect();
    (selected, ignored)
}

/// 未连接时临时起一次运行时，只为跑 Clash 真实延迟。
///
/// 不进连接状态机：不设系统代理、不启 TUN、用临时端口、日志单独一份。
/// 8 秒内没就绪或启动失败都按原因返回，调用方把结果标成 `untested`——
/// **不再降级 TCP**：本地握手证明不了「经 sing-box 转发能通」。
pub async fn start_probe_runtime(
    store: Arc<Store>,
    manager: Arc<RuntimeManager>,
    data_dir: &Path,
    config: &configs::Config,
    installed: &InstalledRuntime,
    cancel: &CancellationToken,
) -> Result<ClashTarget, ProbeFailure> {
    if !installed.binary.is_file() {
        return Err(ProbeFailure::Missing);
    }
    let rules = crate::rules::load_active(&store, data_dir).ok_or(ProbeFailure::Failed)?;
    let (region, _) = crate::rules::effective_region(&store);
    let route_plan = crate::rules::plan::build(&crate::rules::plan::RouteInput {
        mode: "proxy_all",
        region: &region,
        targets: &[],
        rules: &rules,
        // 探测运行时只跑 Clash 延迟，不承载 App 自己的流量。
        control_domains: &[],
    })
    .map_err(|_| ProbeFailure::Failed)?;

    let nodes = {
        let conn = store.conn();
        configs::list_nodes(&conn, &config.id).map_err(|_| ProbeFailure::Failed)?
    };
    if nodes.is_empty() {
        return Err(ProbeFailure::Failed);
    }
    let current = config
        .current_node_id
        .as_ref()
        .and_then(|id| nodes.iter().find(|node| &node.id == id))
        .unwrap_or(&nodes[0]);

    let mut descriptors = Vec::new();
    for member in &nodes {
        let Some(password) = crate::secrets::get_secret(&member.password_ref)
            .ok()
            .flatten()
        else {
            continue;
        };
        descriptors.push(vpn_config::NodeDescriptor {
            id: member.id.clone(),
            name: member.name.clone(),
            server: member.server.clone(),
            server_port: member.port,
            protocol: vpn_config::ProtocolConfig::Shadowsocks {
                password,
                method: member.method.clone(),
            },
        });
    }
    let current_descriptor = descriptors
        .iter()
        .find(|node| node.id == current.id)
        .cloned()
        .ok_or(ProbeFailure::Failed)?;

    // 探针在独立槽里跑，必须避开用户设置的代理端口：否则批次中点「启动 VPN」
    // 会被我们自己占掉端口，白白制造一次降级（port-stability.md §7）。
    let excluded = {
        let conn = store.conn();
        vec![crate::store::settings::proxy_port(&conn)]
    };
    let mixed_port = vpn_config::pick_free_port_excluding(&excluded).map_err(|_| ProbeFailure::Failed)?;
    let mut clash_port =
        vpn_config::pick_free_port_excluding(&excluded).map_err(|_| ProbeFailure::Failed)?;
    while clash_port == mixed_port {
        clash_port =
            vpn_config::pick_free_port_excluding(&excluded).map_err(|_| ProbeFailure::Failed)?;
    }
    let secret = vpn_config::random_secret();
    let value = vpn_config::build_routed_multi(
        &vpn_config::BuildInput::new(
            current_descriptor,
            mixed_port,
            clash_port,
            secret.clone(),
        ),
        &descriptors,
        &current.id,
        &route_plan,
    )
    .map_err(|_| ProbeFailure::Failed)?;

    let config_dir = data_dir.join("config");
    std::fs::create_dir_all(&config_dir).map_err(|_| ProbeFailure::Failed)?;
    let config_key = format!("probe-{}", vpn_config::random_secret());
    let config_path = vpn_config::install_profile(
        &installed.binary,
        &config_dir,
        &config_key,
        &value,
        None,
    )
    .await
    .map_err(|_| ProbeFailure::Failed)?;

    let start_plan = StartPlan {
        version: installed.version.clone(),
        binary: installed.binary.clone(),
        config_path: config_path.clone(),
        work_dir: installed.dir.clone(),
        log_path: data_dir.join("logs").join(format!("{config_key}.log")),
        clash_addr: format!("127.0.0.1:{clash_port}"),
        clash_secret: secret.clone(),
        mixed_port,
        requested_port: None,
        fallback_reason: None,
        config_id: None,
        config_name: None,
        node_id: None,
        node_name: None,
        applied_route_revision: None,
        route_region: region.code().map(str::to_string),
    };
    if cancel.is_cancelled() {
        let _ = std::fs::remove_file(&config_path);
        return Err(ProbeFailure::Cancelled);
    }
    if manager.start_probe(start_plan).await.is_err() {
        let _ = std::fs::remove_file(&config_path);
        return Err(ProbeFailure::Failed);
    }
    // 启动与「用户点连接」可能交错：起来之后再看一眼，已被取消就立刻收掉。
    if cancel.is_cancelled() {
        manager.stop_probe().await;
        return Err(ProbeFailure::Cancelled);
    }

    let deadline = tokio::time::Instant::now() + Duration::from_secs(8);
    loop {
        if cancel.is_cancelled() {
            manager.stop_probe().await;
            return Err(ProbeFailure::Cancelled);
        }
        if manager.probe_healthy().await {
            break;
        }
        if tokio::time::Instant::now() >= deadline {
            log::warn!("测速运行时 8 秒内未就绪，整批标成未测");
            manager.stop_probe().await;
            return Err(ProbeFailure::Timeout);
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }

    Ok(ClashTarget {
        addr: format!("127.0.0.1:{clash_port}"),
        secret,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;
    use std::time::Duration;

    fn node(index: usize) -> Node {
        Node {
            id: format!("nod_{index}"),
            name: format!("节点 {index}"),
            server: "203.0.113.1".to_string(),
            port: 443,
            method: "aes-256-gcm".to_string(),
            password_ref: "ref".to_string(),
            source: "manual".to_string(),
            source_key: String::new(),
            created_at: 0,
            updated_at: 0,
        }
    }

    fn result(id: &str, reachable: bool) -> Value {
        json!({
            "node_id": id,
            "status": if reachable { "ok" } else { "unreachable" },
            "reachable": reachable,
            "latency_ms": if reachable { json!(12) } else { Value::Null },
            "probe_method": "clash_delay",
            "checked_at": 0,
            "error": if reachable { Value::Null } else { json!({"code": "CLASH_DELAY_FAILED", "message": "超时"}) },
        })
    }

    #[test]
    fn a_node_subset_keeps_order_and_ignores_unknown_ids() {
        let all: Vec<Node> = (0..4).map(node).collect();
        let (picked, ignored) = select_nodes(
            &all,
            Some(&["nod_3".to_string(), "missing".to_string()]),
        );
        assert_eq!(picked.len(), 1);
        assert_eq!(picked[0].id, "nod_3");
        assert_eq!(ignored, vec!["missing".to_string()]);

        let all_ids: Vec<String> = (0..4).map(|i| format!("nod_{i}")).collect();
        let (every, ignored) = select_nodes(&all, Some(&all_ids));
        let ids: Vec<&str> = every.iter().map(|node| node.id.as_str()).collect();
        assert_eq!(ids, vec!["nod_0", "nod_1", "nod_2", "nod_3"], "顺序按配置节点顺序");
        assert!(ignored.is_empty());

        let (empty, _) = select_nodes(&all, Some(&[]));
        assert!(empty.is_empty());
        let (all_nodes, ignored) = select_nodes(&all, None);
        assert_eq!(all_nodes.len(), 4);
        assert!(ignored.is_empty());
    }

    #[tokio::test]
    async fn concurrency_never_exceeds_six() {
        let state = Arc::new(ProbeBatchState::default());
        let started = state.start("cfg_1", 24, "clash").unwrap();
        let in_flight = Arc::new(AtomicUsize::new(0));
        let max = Arc::new(AtomicUsize::new(0));
        let probe = {
            let in_flight = Arc::clone(&in_flight);
            let max = Arc::clone(&max);
            move |node: &Node| {
                let id = node.id.clone();
                let in_flight = Arc::clone(&in_flight);
                let max = Arc::clone(&max);
                async move {
                    let now = in_flight.fetch_add(1, Ordering::SeqCst) + 1;
                    max.fetch_max(now, Ordering::SeqCst);
                    tokio::time::sleep(Duration::from_millis(5)).await;
                    in_flight.fetch_sub(1, Ordering::SeqCst);
                    result(&id, true)
                }
            }
        };
        let nodes: Vec<Node> = (0..24).map(node).collect();
        let outcome = run_batch(Arc::clone(&state), started.meta, nodes, probe).await;
        assert_eq!(outcome.done, 24);
        assert_eq!(outcome.ok, 24);
        assert!(max.load(Ordering::SeqCst) <= 6, "并发超过 6");
    }

    #[tokio::test]
    async fn one_failure_does_not_stop_the_batch() {
        let state = Arc::new(ProbeBatchState::default());
        let started = state.start("cfg_1", 4, "clash").unwrap();
        let nodes: Vec<Node> = (0..4).map(node).collect();
        let outcome = run_batch(Arc::clone(&state), started.meta, nodes, |node: &Node| {
            let id = node.id.clone();
            let reachable = id != "nod_2";
            async move { result(&id, reachable) }
        })
        .await;

        assert_eq!(outcome.done, 4);
        assert_eq!(outcome.ok, 3);
        assert_eq!(outcome.failed, 1);
        assert_eq!(outcome.untested, 0);
        assert!(!outcome.cancelled);
        let ids: Vec<String> = (0..4).map(|i| format!("nod_{i}")).collect();
        let (results, run) = state.snapshot("cfg_1", &ids);
        assert_eq!(results.len(), 4, "失败结果也要缓存");
        assert!(run.is_none(), "跑完后 run 必须为空");
    }

    #[tokio::test]
    async fn cancel_stops_further_probes_and_keeps_finished_results() {
        let state = Arc::new(ProbeBatchState::default());
        let started = state.start("cfg_1", 20, "clash").unwrap();
        let probes = Arc::new(AtomicUsize::new(0));
        let nodes: Vec<Node> = (0..20).map(node).collect();
        let probe = {
            let probes = Arc::clone(&probes);
            move |node: &Node| {
                let id = node.id.clone();
                let probes = Arc::clone(&probes);
                async move {
                    probes.fetch_add(1, Ordering::SeqCst);
                    tokio::time::sleep(Duration::from_millis(10)).await;
                    result(&id, true)
                }
            }
        };

        let cancel = Arc::clone(&state);
        let run_id = started.run_id.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(25)).await;
            assert!(cancel.cancel(&run_id));
        });
        let outcome = run_batch(Arc::clone(&state), started.meta, nodes, probe).await;

        assert!(outcome.cancelled);
        assert!(outcome.done < 20, "取消后不应跑完全部");
        assert!(
            probes.load(Ordering::SeqCst) >= outcome.done,
            "已发出的结果不能多于实际探测数"
        );
        let ids: Vec<String> = (0..20).map(|i| format!("nod_{i}")).collect();
        let (results, run) = state.snapshot("cfg_1", &ids);
        assert_eq!(results.len(), outcome.done, "已出的结果必须保留");
        assert!(run.is_none(), "取消后批次要清掉");
    }

    #[tokio::test]
    async fn a_second_batch_is_busy_with_the_running_run_id() {
        let state = ProbeBatchState::default();
        let first = state.start("cfg_1", 3, "clash").unwrap();
        let err = match state.start("cfg_2", 5, "clash") {
            Ok(_) => panic!("第二个批次必须被拒绝"),
            Err(run_id) => run_id,
        };
        assert_eq!(err, first.run_id);
        assert!(state.cancel(&first.run_id));
        // 取消后允许新批次。
        let second = state.start("cfg_2", 5, "clash").unwrap();
        assert_ne!(second.run_id, first.run_id);
    }

    #[tokio::test]
    async fn snapshot_run_is_only_present_for_its_own_config() {
        let state = ProbeBatchState::default();
        let ids = vec!["nod_1".to_string()];
        state.cache.lock().insert(
            "nod_1".to_string(),
            json!({"node_id": "nod_1", "reachable": true}),
        );
        let (results, run) = state.snapshot("cfg_1", &ids);
        assert_eq!(results.len(), 1);
        assert!(run.is_none(), "没在跑时 run 为空");

        let started = state.start("cfg_1", 1, "clash").unwrap();
        let (_, run_own) = state.snapshot("cfg_1", &ids);
        assert!(run_own.is_some());
        assert_eq!(run_own.as_ref().unwrap()["method"], json!("clash"));
        let (_, run_other) = state.snapshot("cfg_2", &ids);
        assert!(run_other.is_none(), "别的配置在跑时本配置拿到 null");
        state.cancel(&started.run_id);
        state.finish(&started.run_id);
    }

    /// 节点参数改过：旧结果作废，在途回写也丢弃；下一次批次可以重新写入。
    #[tokio::test]
    async fn forget_node_drops_old_results_and_ignores_late_writes() {
        let state = ProbeBatchState::default();
        let ids = vec!["nod_1".to_string()];
        state.cache.lock().insert(
            "nod_1".to_string(),
            json!({"node_id": "nod_1", "reachable": true}),
        );

        state.forget_node("nod_1");
        let (results, _) = state.snapshot("cfg_1", &ids);
        assert!(results.is_empty(), "作废后不能再返回旧结果");

        state.record(&json!({"node_id": "nod_1", "reachable": false}));
        let (results, _) = state.snapshot("cfg_1", &ids);
        assert!(results.is_empty(), "在途批次回来的旧结果必须丢弃");

        let _started = state.start("cfg_1", 1, "clash").unwrap();
        state.record(&json!({"node_id": "nod_1", "reachable": true}));
        let (results, _) = state.snapshot("cfg_1", &ids);
        assert_eq!(results.len(), 1, "新批次的结果要能写进缓存");
    }

    /// 批次在跑时再点测速：返回 BUSY，且不能顺手清掉失效集合——否则在跑的旧批次
    /// 会把改过参数的节点结果写回缓存。
    #[tokio::test]
    async fn start_while_a_batch_is_running_keeps_the_stale_set() {
        let state = ProbeBatchState::default();
        let first = state.start("cfg_1", 2, "clash").unwrap();
        state.forget_node("nod_1");

        let busy = match state.start("cfg_1", 2, "clash") {
            Ok(_) => panic!("已有批次在跑时必须返回 BUSY"),
            Err(run_id) => run_id,
        };
        assert_eq!(busy, first.run_id);

        state.record(&json!({"node_id": "nod_1", "reachable": true}));
        let (results, _) = state.snapshot("cfg_1", &["nod_1".to_string()]);
        assert!(results.is_empty(), "旧批次回写仍必须被丢弃");
    }

    #[tokio::test]
    async fn snapshot_reports_phase_and_the_batch_method() {
        let state = Arc::new(ProbeBatchState::default());
        let started = state.start("cfg_1", 2, "clash").unwrap();
        let ids = vec!["nod_0".to_string(), "nod_1".to_string()];
        let (_, before) = state.snapshot("cfg_1", &ids);
        assert_eq!(before.as_ref().unwrap()["phase"], json!("preparing"));

        let seen = Arc::new(Mutex::new(None));
        let probe = {
            let seen = Arc::clone(&seen);
            let state = Arc::clone(&state);
            move |node: &Node| {
                let id = node.id.clone();
                let seen = Arc::clone(&seen);
                let state = Arc::clone(&state);
                async move {
                    let (_, run) = state.snapshot("cfg_1", &ids_for(&id));
                    *seen.lock() = run;
                    result(&id, true)
                }
            }
        };
        let (_, run) = state.snapshot("cfg_1", &ids_for("nod_0"));
        assert!(run.is_some());
        let nodes: Vec<Node> = (0..2).map(node).collect();
        run_batch(Arc::clone(&state), started.meta, nodes, probe).await;
        let seen = seen.lock().clone().expect("探测时应能读到运行态");
        assert_eq!(seen["phase"], json!("probing"));
        assert_eq!(seen["method"], json!("clash"));
    }

    #[tokio::test]
    async fn starting_a_connection_cancels_with_reason_connected() {
        let state = Arc::new(ProbeBatchState::default());
        let started = state.start("cfg_1", 5, "clash").unwrap();
        state.cancel_for_connection();
        let nodes: Vec<Node> = (0..5).map(node).collect();
        let outcome = run_batch(Arc::clone(&state), started.meta, nodes, |node: &Node| {
            let id = node.id.clone();
            async move { result(&id, true) }
        })
        .await;
        assert!(outcome.cancelled);
        assert_eq!(outcome.reason, Some("connected"));
        assert_eq!(outcome.done, 0, "取消先于启动，不应再发结果");
    }

    #[tokio::test]
    async fn a_whole_untested_batch_still_finishes_with_every_result() {
        let state = Arc::new(ProbeBatchState::default());
        let started = state.start("cfg_1", 3, "none").unwrap();
        let nodes: Vec<Node> = (0..3).map(node).collect();
        // 起不了运行时：整批 untested，不再降级 TCP。
        let outcome = run_batch(Arc::clone(&state), started.meta, nodes, |node: &Node| {
            let id = node.id.clone();
            async move { probe_untested(&id, "node_not_in_config") }
        })
        .await;

        assert_eq!(outcome.done, 3);
        assert_eq!(outcome.ok, 0, "没测成不算成功");
        assert_eq!(outcome.failed, 0, "没测成不是测不通");
        assert_eq!(outcome.untested, 3);
        assert_eq!(outcome.ok + outcome.failed + outcome.untested, 3);
        assert_eq!(outcome.method, "none");
        assert_eq!(outcome.network, "ok", "整批没测不该去查本机网络");

        let ids: Vec<String> = (0..3).map(|i| format!("nod_{i}")).collect();
        let (results, run) = state.snapshot("cfg_1", &ids);
        assert_eq!(results.len(), 3, "未测结果也要缓存");
        for result in results {
            assert_eq!(result["status"], "untested");
            assert_eq!(result["reachable"], Value::Null);
            assert_eq!(result["probe_method"], "none");
            assert_eq!(result["error"]["reason"], "node_not_in_config");
        }
        assert!(run.is_none());
    }

    /// 假的 Clash 控制口：固定回一个状态码，用于区分 404 与其它失败。
    fn spawn_delay_api(status_line: &'static str, body: &'static str) -> String {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap().to_string();
        std::thread::spawn(move || {
            for socket in listener.incoming() {
                let Ok(mut socket) = socket else { return };
                let mut buf = [0u8; 4096];
                let _ = socket.read(&mut buf);
                let response = format!(
                    "HTTP/1.1 {status_line}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = socket.write_all(response.as_bytes());
            }
        });
        addr
    }

    /// 批量侧同样区分：Proxy 不在运行配置（404）→ untested，5xx → unreachable。
    #[tokio::test]
    async fn a_batch_probe_separates_missing_proxy_from_clash_errors() {
        crate::test_support::install_test_secrets();
        crate::secrets::set_secret("ref", "pw").unwrap(); // secret-scan:allow

        let missing = ClashTarget {
            addr: spawn_delay_api("404 Not Found", "{}"),
            secret: "s".into(),
        };
        let result = probe_node(&node(1), &missing).await;
        assert_eq!(result["status"], "untested");
        assert_eq!(result["probe_method"], "none");
        assert_eq!(
            result["error"]["reason"], "node_not_in_running_config",
            "{result}"
        );

        let broken = ClashTarget {
            addr: spawn_delay_api("500 Internal Server Error", "{}"),
            secret: "s".into(),
        };
        let result = probe_node(&node(2), &broken).await;
        assert_eq!(result["status"], "unreachable");
        assert_eq!(result["probe_method"], "clash_delay");
    }

    #[tokio::test]
    async fn ok_failed_and_untested_add_up_to_done() {
        let state = Arc::new(ProbeBatchState::default());
        let started = state.start("cfg_1", 3, "clash").unwrap();
        let nodes: Vec<Node> = (0..3).map(node).collect();
        let outcome = run_batch(Arc::clone(&state), started.meta, nodes, |node: &Node| {
            let id = node.id.clone();
            async move {
                match id.as_str() {
                    "nod_0" => result(&id, true),
                    "nod_1" => result(&id, false),
                    _ => probe_untested(&id, "no_credentials"),
                }
            }
        })
        .await;

        assert_eq!(outcome.ok, 1);
        assert_eq!(outcome.failed, 1);
        assert_eq!(outcome.untested, 1);
        assert_eq!(outcome.done, 3);
        assert_eq!(
            outcome.ok + outcome.failed + outcome.untested,
            outcome.done,
            "三类必须加得起来"
        );
        // 有 untested 就不是「全部失败」：不该去查本机网络。
        assert_eq!(outcome.network, "ok");
    }

    #[test]
    fn an_untested_result_is_not_a_failed_probe() {
        let value = probe_untested("nod_1", "connection_busy");
        assert_eq!(value["status"], "untested");
        assert_eq!(value["reachable"], Value::Null, "null 不能写成 false");
        assert_eq!(value["probe_method"], "none");
        assert_eq!(value["error"]["code"], "PROBE_UNAVAILABLE");
        assert_eq!(value["error"]["reason"], "connection_busy");
        assert!(value["error"]["message"]
            .as_str()
            .unwrap_or_default()
            .contains("稍后再测"));
    }

    fn target(addr: &str) -> ClashTarget {
        ClashTarget {
            addr: addr.to_string(),
            secret: "secret".into(),
        }
    }

    #[test]
    fn an_idle_probe_is_reused_only_for_the_same_config() {
        let state = ProbeBatchState::default();
        let target = target("127.0.0.1:9091");

        let (generation, token) = state.begin_idle_probe();
        assert!(!token.is_cancelled());
        assert!(state.idle_target("cfg_1").is_none(), "刚清过槽位");

        let generation = state
            .note_idle("cfg_1", &target, Some(generation))
            .expect("启动成功应当可复用");
        assert_eq!(state.idle_target("cfg_1").unwrap().addr, target.addr);
        assert!(
            state.idle_target("cfg_2").is_none(),
            "别的配置的运行时里没有这个节点的出站"
        );

        assert!(state.expire_idle(generation));
        assert!(state.idle_target("cfg_1").is_none());
        assert!(!state.expire_idle(generation), "过期只能成功一次");
    }

    #[test]
    fn an_expired_idle_probe_is_not_reused() {
        let state = ProbeBatchState::default();
        let target = target("127.0.0.1:9092");
        let (generation, _) = state.begin_idle_probe();
        state
            .note_idle_with_ttl("cfg_1", &target, Some(generation), Duration::from_millis(1))
            .unwrap();
        std::thread::sleep(Duration::from_millis(5));
        assert!(state.idle_target("cfg_1").is_none());
    }

    #[test]
    fn a_connection_cancels_a_starting_idle_probe_and_blocks_recording() {
        let state = ProbeBatchState::default();
        let target = target("127.0.0.1:9093");
        let (generation, token) = state.begin_idle_probe();
        state.cancel_for_connection();
        assert!(token.is_cancelled(), "启动中的探针要被连接取消");
        assert!(
            state.note_idle("cfg_1", &target, Some(generation)).is_none(),
            "取消之后不能再记成可复用"
        );
        assert!(state.idle_target("cfg_1").is_none());
    }

    #[test]
    fn refreshing_an_idle_probe_retires_the_old_timer() {
        let state = ProbeBatchState::default();
        let target = target("127.0.0.1:9094");
        let (generation, _) = state.begin_idle_probe();
        let first = state.note_idle("cfg_1", &target, Some(generation)).unwrap();
        let second = state.note_idle("cfg_1", &target, None).expect("复用要刷新 60 秒窗口");
        assert_ne!(first, second);
        assert!(!state.expire_idle(first), "旧定时器不能杀新探针");
        assert!(state.idle_target("cfg_1").is_some());
        assert!(state.expire_idle(second));
    }

    fn ids_for(id: &str) -> Vec<String> {
        vec![id.to_string()]
    }
}
