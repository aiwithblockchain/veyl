//! 常驻与生命周期：托盘、窗口隐藏、退出确认与有序退出。
//!
//! 托盘三态用不同形状区分（圆环 / 实心圆 / 三角），不能只靠颜色。
//! 退出流程严格按序：撤系统代理并校验 → 停运行时 → 删明文配置 → 退出。

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicI32, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

use futures::FutureExt;
use serde_json::json;
use tauri::image::Image;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager, Runtime};
use tauri_plugin_dialog::{
    DialogExt, MessageDialogButtons, MessageDialogKind, MessageDialogResult,
};
use tokio::sync::oneshot;

use crate::claurst_session::events::{EV_QUIT_DISMISSED, EV_QUIT_REQUESTED};
use crate::proxy::ProxyController;
use crate::runtime::health::DataPlaneProbe;
use crate::runtime::{
    HealthSnapshot, RuntimeEvent, RuntimeHealthChangedPayload, RuntimeManager, RuntimeState,
    CONTRACT_VERSION, DEFAULT_DATA_PLANE_PROBE, EVENT_CONTRACT_VERSION,
};
use crate::tun::session::{TunSession, TunState};

const TRAY_ID: &str = "veyl-tray";
const MAIN_WINDOW: &str = "main";

static QUITTING: AtomicBool = AtomicBool::new(false);
static EXIT_PROMPT_OPEN: AtomicBool = AtomicBool::new(false);

/// 前端至少调过一次命令，说明页面与事件监听已经跑起来。
static FRONTEND_ALIVE: AtomicBool = AtomicBool::new(false);

/// 应用内退出确认的等待上限。
const QUIT_DECISION_TIMEOUT: Duration = Duration::from_secs(30);

/// 用户在退出确认里的选择。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum QuitDecision {
    Background,
    Quit,
}

impl QuitDecision {
    pub fn parse(action: &str) -> Option<Self> {
        match action {
            "background" => Some(Self::Background),
            "quit" => Some(Self::Quit),
            _ => None,
        }
    }
}

/// 一次应用内确认的等待结果。
#[derive(Debug, PartialEq, Eq)]
pub enum PromptResult {
    Decision(QuitDecision),
    TimedOut,
    Closed,
}

/// 一次只允许有一个退出确认在等；第二次决策、重复打开都按忽略处理。
#[derive(Default)]
pub struct QuitPrompt {
    sender: std::sync::Mutex<Option<oneshot::Sender<QuitDecision>>>,
}

impl QuitPrompt {
    pub fn open(&self) -> Option<oneshot::Receiver<QuitDecision>> {
        let (sender, receiver) = oneshot::channel();
        let mut slot = self
            .sender
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if slot.is_some() {
            return None;
        }
        *slot = Some(sender);
        Some(receiver)
    }

    /// 只有第一次决策生效；没有等待、已超时或已被回退路径取走时返回 false。
    pub fn decide(&self, decision: QuitDecision) -> bool {
        let sender = self
            .sender
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .take();
        match sender {
            Some(sender) => sender.send(decision).is_ok(),
            None => false,
        }
    }

    /// 放弃这次等待（回落到原生弹窗时用），迟到的决策一并作废。
    pub fn close(&self) {
        self.sender
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .take();
    }

    pub fn is_open(&self) -> bool {
        self.sender
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .is_some()
    }
}

static QUIT_PROMPT: OnceLock<QuitPrompt> = OnceLock::new();

fn quit_prompt() -> &'static QuitPrompt {
    QUIT_PROMPT.get_or_init(QuitPrompt::default)
}

/// 前端命令分发处调用：页面已经能收发事件。
pub fn note_frontend_alive() {
    FRONTEND_ALIVE.store(true, Ordering::Relaxed);
}

fn frontend_ready() -> bool {
    FRONTEND_ALIVE.load(Ordering::Relaxed)
}

/// 应用内确认需要页面已经能收发事件，且主窗口还在。
fn can_use_in_app_prompt(frontend_alive: bool, has_main_window: bool) -> bool {
    frontend_alive && has_main_window
}

/// 处理 `quit_decision`：返回是否被接受；第二次调用与非法取值都不改状态。
pub fn resolve_quit_decision(action: &str) -> Option<bool> {
    let decision = QuitDecision::parse(action)?;
    Some(quit_prompt().decide(decision))
}

/// 退出请求的来源，决定是否需要先问一次（`docs/design/quit-dialog.md` §0）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum QuitRoute {
    /// 应用菜单「退出 Veyl」/ Cmd+Q：用户主动要离开窗口，任何时候都问一次。
    Menu,
    /// 系统注销 / 关机触发的 `ExitRequested`：系统已在收尾，问只会卡住关机。
    System,
    /// 托盘菜单「退出」：意图明确，直接退出。
    Tray,
}

impl QuitRoute {
    /// 只有菜单 / Cmd+Q 需要确认。**与连接状态无关**：系统注销与托盘都视为
    /// 用户已经明确说了「退出」。
    fn asks_before_quitting(self) -> bool {
        matches!(self, QuitRoute::Menu)
    }
}

async fn wait_decision(
    receiver: oneshot::Receiver<QuitDecision>,
    timeout: Duration,
) -> PromptResult {
    match tokio::time::timeout(timeout, receiver).await {
        Err(_) => PromptResult::TimedOut,
        Ok(Ok(decision)) => PromptResult::Decision(decision),
        // 发送端被回退路径取走：那次回退会接管后续动作。
        Ok(Err(_)) => PromptResult::Closed,
    }
}

/// 等待结果里哪些路径需要通知前端收起弹窗：只有超时。
/// 回落原生与 panic 在各自调用点直接发；正常决策与回落已发的 `Closed` 不重复发。
fn should_emit_quit_dismissed(result: &PromptResult) -> bool {
    matches!(result, PromptResult::TimedOut)
}

/// 本次应用内确认没有经过用户决策就结束了（超时、回落原生、panic）。
fn emit_quit_dismissed<R: Runtime>(app: &AppHandle<R>) {
    let payload = json!({
        "contract_version": EVENT_CONTRACT_VERSION,
        "emitted_at": crate::claurst_session::events::now(),
    });
    if let Err(error) = app.emit(EV_QUIT_DISMISSED, payload) {
        log::warn!("quit-dismissed 发送失败：{error}");
    }
}

/// 信号处理器的 self-pipe 写端；`-1` = 未安装。
#[cfg(unix)]
static SIGNAL_WRITE_FD: AtomicI32 = AtomicI32::new(-1);

/// 信号处理器里唯一允许做的事：往 self-pipe 写一个字节（async-signal-safe）。
#[cfg(unix)]
extern "C" fn forward_signal(_signal: libc::c_int) {
    let fd = SIGNAL_WRITE_FD.load(Ordering::Relaxed);
    if fd >= 0 {
        let byte = 1u8;
        unsafe {
            libc::write(fd, &byte as *const u8 as *const libc::c_void, 1);
        }
    }
}

/// 安装 SIGTERM / SIGINT / SIGHUP 的进程内兜底。
///
/// 处理器只写 self-pipe；独立的清理线程按启动恢复同一套判定还原一次，
/// 硬超时 2 秒后 `_exit(0)`。**不在 panic hook 里做还原**（见设计稿 §5）。
pub fn install_signal_cleanup(proxy: Arc<ProxyController>) {
    #[cfg(unix)]
    {
        let mut fds = [0i32; 2];
        if unsafe { libc::pipe(fds.as_mut_ptr()) } != 0 {
            log::error!(
                "信号清理：创建 self-pipe 失败：{}",
                std::io::Error::last_os_error()
            );
            return;
        }
        let (read_fd, write_fd) = (fds[0], fds[1]);
        unsafe {
            let flags = libc::fcntl(write_fd, libc::F_GETFL);
            if flags >= 0 {
                libc::fcntl(write_fd, libc::F_SETFL, flags | libc::O_NONBLOCK);
            }
        }
        SIGNAL_WRITE_FD.store(write_fd, Ordering::SeqCst);

        let handler = forward_signal as extern "C" fn(libc::c_int) as libc::sighandler_t;
        unsafe {
            libc::signal(libc::SIGTERM, handler);
            libc::signal(libc::SIGINT, handler);
            libc::signal(libc::SIGHUP, handler);
        }

        std::thread::spawn(move || {
            let mut byte = 0u8;
            loop {
                let read = unsafe {
                    libc::read(read_fd, &mut byte as *mut u8 as *mut libc::c_void, 1)
                };
                if read < 0 {
                    let error = std::io::Error::last_os_error();
                    if error.kind() == std::io::ErrorKind::Interrupted {
                        continue;
                    }
                    log::error!("信号清理：读 self-pipe 失败：{error}");
                    return;
                }
                if read != 1 {
                    return;
                }
                break;
            }

            // 硬超时：清理线程卡在 networksetup 或数据库锁上时也必须退出。
            std::thread::spawn(|| {
                std::thread::sleep(Duration::from_secs(2));
                log::error!("信号清理超时（2 秒），强制退出");
                unsafe { libc::_exit(0) };
            });

            match proxy.recover_on_signal() {
                Ok(Some(report)) => log::warn!("信号清理已完成：{:?}", report.status),
                Ok(None) => log::info!("信号清理：没有需要恢复的代理"),
                Err(error) => log::error!("信号清理失败（交给下次启动）：{error}"),
            }
            unsafe { libc::_exit(0) };
        });
    }
    #[cfg(not(unix))]
    {
        let _ = proxy;
    }
}

#[derive(Clone)]
pub struct Parts {
    pub proxy: Arc<ProxyController>,
    pub manager: Arc<RuntimeManager>,
    pub config_dir: PathBuf,
    /// TUN 的 sing-box 是特权助手的子进程，`manager.stop()` 碰不到它。
    pub tun: Arc<crate::tun::session::TunSession>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TrayState {
    Idle,
    Connected,
    Error,
}

/// 应用是否正在退出。连接入口据此拒绝新请求（§4.6 第 1 步）。
pub fn is_quitting() -> bool {
    QUITTING.load(Ordering::SeqCst)
}

/// `true` = 拦下并进入确认流程；`false` = 放行。
///
/// **不要用 `code` 判断来源**：实测 macOS Cmd+Q 也可能带 `Some(0)`。
/// 只认我们自己的 `QUITTING`：`app.exit(0)` 之前已置位，二次触发正好放行。
pub fn should_intercept_exit(quitting: bool, _code: Option<i32>) -> bool {
    !quitting
}

pub fn show_main_window<R: Runtime>(app: &AppHandle<R>) {
    #[cfg(target_os = "macos")]
    {
        // 隐藏时切到 Accessory 的，这里切回 Regular，Dock 图标与焦点才回来。
        if let Err(error) = app.set_activation_policy(tauri::ActivationPolicy::Regular) {
            log::warn!("恢复 Dock 图标失败：{error}");
        }
    }
    if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

pub fn hide_main_window<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
        let _ = window.hide();
    }
    #[cfg(target_os = "macos")]
    {
        // 允许降级：若 Accessory 策略导致窗口无法恢复，删掉这一段即保留 Dock 图标。
        if let Err(error) = app.set_activation_policy(tauri::ActivationPolicy::Accessory) {
            log::warn!("切换为菜单栏模式失败：{error}");
        }
    }
}

/// 建托盘。失败只记日志，绝不阻止应用启动（§4.9）。
pub fn setup_tray<R: Runtime>(app: &AppHandle<R>, parts: Parts) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "tray-show", "显示 Veyl", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "tray-quit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &quit])?;

    let quit_parts = parts.clone();
    TrayIconBuilder::with_id(TRAY_ID)
        .icon(tray_icon(TrayState::Idle))
        .icon_as_template(cfg!(target_os = "macos"))
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(move |app, event| match event.id().as_ref() {
            "tray-show" => show_main_window(app),
            "tray-quit" => request_quit(app, quit_parts.clone(), QuitRoute::Tray),
            _ => {}
        })
        .build(app)?;

    spawn_tray_state_loop(app.clone(), parts.manager, parts.tun);
    Ok(())
}

/// 托盘状态的兜底轮询间隔。
///
/// 2.20.0 起 TUN 的状态变化也并进 manager 的同一条广播（`RuntimeManager::publish_state`），
/// 托盘与主界面订阅的是同一条流，不会再一个说断开、一个说连着。**事件是主线**：
/// 收到 `runtime-state-changed` 就立刻重算。这一拍只兜底——事件丢失、或 App 重启
/// 接手已有 TUN 时，一两秒内也能算对。
const TRAY_RECHECK_INTERVAL: Duration = Duration::from_secs(2);

/// 单次外部调用的等待上限：读运行时状态、等 TUN 探测结果、把图标画到主线程。
///
/// 超时只保持上一个图标并记日志。任何一次调用都不允许把整条循环拖住：托盘安静地
/// 停在一个旧状态上、日志里又什么都没有，是这件事最难查的地方。
const TRAY_STATUS_TIMEOUT: Duration = Duration::from_secs(1);

fn spawn_tray_state_loop<R: Runtime>(
    app: AppHandle<R>,
    manager: Arc<RuntimeManager>,
    tun: Arc<TunSession>,
) {
    tauri::async_runtime::spawn(async move {
        // 循环里任何一次 panic 都会让任务静默消失、托盘从此不动且不留痕迹。
        // 兜住它并留下一条 error：宁可少更新一次，也不能查不出原因。
        let flow = std::panic::AssertUnwindSafe(tray_state_loop(app, manager, tun));
        if flow.catch_unwind().await.is_err() {
            log::error!("托盘状态循环因 panic 退出，图标将停住不再更新");
        }
    });
}

async fn tray_state_loop<R: Runtime>(
    app: AppHandle<R>,
    manager: Arc<RuntimeManager>,
    tun: Arc<TunSession>,
) {
    let mut events = manager.subscribe();
    // 「循环到底有没有跑」的唯一判据，用 info：不设 RUST_LOG 时也看得见。
    log::info!("托盘状态循环启动 id={TRAY_ID}");

    let (probe_tx, mut probe_rx) = tokio::sync::mpsc::channel::<bool>(1);
    let mut current: Option<TrayState> = None;
    // 两个来源各自「最近一次已知值」；读不到时保持旧值，不拿默认值去猜。
    let mut manager_state = match tokio::time::timeout(TRAY_STATUS_TIMEOUT, manager.status()).await
    {
        Ok(status) => Some(status.state),
        Err(_) => {
            log::warn!("托盘：启动读运行时状态超过 {TRAY_STATUS_TIMEOUT:?}，先按未连接画");
            None
        }
    };
    // 启动先算一次：App 重启接手已有 TUN 时，第一帧就该是对的，不能先闪一下盾牌。
    // 探测本身仍在阻塞线程池里跑，这里只等 1 秒；等的期间不阻塞任何异步工作线程。
    kick_tun_probe(&tun, &probe_tx);
    let mut probing = true;
    let mut probe_started: Option<tokio::time::Instant>;
    let mut tun_running_known =
        match tokio::time::timeout(TRAY_STATUS_TIMEOUT, probe_rx.recv()).await {
            Ok(Some(running)) => {
                probing = false;
                probe_started = None;
                Some(running)
            }
            _ => {
                log::warn!("托盘：启动 TUN 探测超过 {TRAY_STATUS_TIMEOUT:?} 未返回，先按未连接画");
                probe_started = None;
                None
            }
        };
    // 广播关了不等于该停止画图标：兜底轮询还得继续，否则图标永远停在最后一个状态上。
    let mut events_alive = true;
    let mut probe_wanted = false;
    // 启动那一轮刚算过，兜底从下一个间隔开始，不立刻再读一遍。
    let mut next_fallback = tokio::time::Instant::now() + TRAY_RECHECK_INTERVAL;

    apply_tray_state(&app, &mut current, manager_state, tun_running_known).await;

    loop {
        tokio::select! {
            event = events.recv(), if events_alive => {
                match event {
                    Ok(RuntimeEvent::StateChanged(payload)) => {
                        log::debug!(
                            "托盘：收到状态事件 {} {:?} → {:?}",
                            payload.event,
                            payload.from,
                            payload.to
                        );
                        manager_state = Some(payload.to);
                        probe_wanted = true;
                    }
                    Ok(RuntimeEvent::HealthChanged(_)) => {}
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(skipped)) => {
                        log::warn!("托盘：漏掉 {skipped} 条事件，改为直接读状态");
                        probe_wanted = true;
                        next_fallback = tokio::time::Instant::now();
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                        log::warn!("托盘：运行时事件流已关闭，只剩兜底轮询");
                        events_alive = false;
                        next_fallback = tokio::time::Instant::now();
                    }
                }
            }
            Some(running) = probe_rx.recv(), if probing => {
                probing = false;
                probe_started = None;
                log::debug!("托盘：TUN 探测返回 running={running}");
                tun_running_known = Some(running);
            }
            _ = tokio::time::sleep_until(
                probe_started
                    .map(|at| at + TRAY_STATUS_TIMEOUT)
                    .unwrap_or_else(|| tokio::time::Instant::now() + Duration::from_secs(3600))
            ), if probe_started.is_some() => {
                // 只提醒一次。阻塞调用取消不了，结果回来时照常由上面的分支收下。
                log::warn!(
                    "托盘：TUN 状态探测超过 {TRAY_STATUS_TIMEOUT:?} 仍未返回，先保持上一个图标"
                );
                probe_started = None;
            }
            _ = tokio::time::sleep_until(next_fallback) => {
                next_fallback = tokio::time::Instant::now() + TRAY_RECHECK_INTERVAL;
                match tokio::time::timeout(TRAY_STATUS_TIMEOUT, manager.status()).await {
                    Ok(status) => manager_state = Some(status.state),
                    Err(_) => log::warn!(
                        "托盘：读运行时状态超过 {TRAY_STATUS_TIMEOUT:?}，保持上一个图标"
                    ),
                }
                probe_wanted = true;
            }
        }

        apply_tray_state(&app, &mut current, manager_state, tun_running_known).await;

        // 事件本身不告诉我们 TUN 在不在跑（那是另一条进程路径），状态可能变了
        // 就补一次权威探测；在飞时不重复起。
        if probe_wanted && !probing {
            probe_wanted = false;
            probing = true;
            probe_started = Some(tokio::time::Instant::now());
            kick_tun_probe(&tun, &probe_tx);
        }
    }
}

/// 起一次 TUN 探测，结果走 channel 回来。
///
/// `TunSession::status()` 是同步调用，缓存过期时会做一次最长 10 秒的特权助手探测：
/// 必须放阻塞线程池，绝不在异步工作线程上直接跑。同一时刻只允许一个在飞，
/// 否则每次超时都再起一个，迟早堆满阻塞线程池。
fn kick_tun_probe(tun: &Arc<TunSession>, tx: &tokio::sync::mpsc::Sender<bool>) {
    let probe_tun = Arc::clone(tun);
    let tx = tx.clone();
    tokio::task::spawn_blocking(move || {
        let _ = tx.blocking_send(tun_running(&probe_tun));
    });
}

/// 合成并画托盘。两个来源都是「最近一次已知值」：状态没变时什么都不做。
///
/// manager 侧一次都没读到过（`None`）不直接放弃：TUN 的 sing-box 本来就不归 manager 管，
/// TUN 明确在跑时托盘必须能独立点亮，否则 manager 一旦卡住，托盘就再也点不亮。
async fn apply_tray_state<R: Runtime>(
    app: &AppHandle<R>,
    current: &mut Option<TrayState>,
    manager_state: Option<RuntimeState>,
    tun_running_known: Option<bool>,
) {
    let next = match (manager_state, tun_running_known) {
        (Some(manager_state), _) => {
            combined_tray_state(manager_state, tun_running_known.unwrap_or(false))
        }
        (None, Some(true)) => TrayState::Connected,
        // manager 与 TUN 都不知道：不猜，保持现状。
        (None, _) => return,
    };
    if *current == Some(next) {
        return;
    }
    // 进入 Connected 那一跳用 info：真机验收时要能直接 grep 到，不必为看托盘开 debug。
    if next == TrayState::Connected {
        log::info!(
            "托盘状态变化 {:?} → {next:?}（来源 manager={manager_state:?} tun_running={tun_running_known:?}）",
            *current
        );
    } else {
        log::debug!(
            "托盘状态变化 {:?} → {next:?}（来源 manager={manager_state:?} tun_running={tun_running_known:?}）",
            *current
        );
    }
    *current = Some(next);
    update_tray_icon(app.clone(), next).await;
}

fn tun_running(tun: &TunSession) -> bool {
    matches!(tun.status(), TunState::Running { .. })
}

/// TUN 数据面探测间隔（契约 `runtime.md` §2.3.1：10s 一次、5s 超时）。
const TUN_DATA_PLANE_INTERVAL: Duration = Duration::from_secs(10);

/// 驱动 TUN 的数据面探测。
///
/// 代理模式由 `RuntimeManager::supervise` 自己的 10s 循环探；TUN 的 sing-box
/// 是 helper 的子进程、不归 manager 管，那条循环覆盖不到它。没有这条循环，
/// `health.data_plane` 在 TUN 下只能写死 `true`——正是「连上了但打不开网页，
/// 界面仍显示已连接」的来源。
///
/// 判据：**经 TUN 出网的普通请求**（不设代理，由系统路由接管），不是某个
/// 具体站点是否可达；也不看用户有没有流量——没流量不等于不通。
pub fn spawn_tun_data_plane_loop(tun: Arc<TunSession>) {
    let probe = match DataPlaneProbe::direct(DEFAULT_DATA_PLANE_PROBE) {
        Ok(probe) => probe,
        Err(error) => {
            log::error!("TUN 数据面探测无法启动：{error}");
            return;
        }
    };

    tauri::async_runtime::spawn(async move {
        let mut identity: Option<String> = None;
        let mut next_probe = Instant::now();
        loop {
            // 与托盘轮询同频；`tun.status()` 自带 5s 缓存，这一跳很便宜。
            tokio::time::sleep(TRAY_RECHECK_INTERVAL).await;

            let current = tun.running_identity();
            if current != identity {
                // 新连接（含 App 崩溃后接手）：去抖从零开始，第一轮探测放 10s 后，
                // 头 10 秒按契约保持乐观。
                identity = current;
                tun.begin_data_plane();
                next_probe = Instant::now() + TUN_DATA_PLANE_INTERVAL;
                if identity.is_none() {
                    continue;
                }
            }

            if identity.is_none() || Instant::now() < next_probe {
                continue;
            }
            next_probe = Instant::now() + TUN_DATA_PLANE_INTERVAL;

            let ok = probe.ok().await;
            // 去抖在 session 里：单次失败不改值，连续两次才置 false。
            tun.record_data_plane(ok);
            emit_tun_health(&tun);
        }
    });
}

/// 每次探测后发一条 `runtime-health-changed`，与代理模式同频同形状。
///
/// TUN 下 `clash_api` / `exit_ip` / `node_latency` 都不适用，如实给 `false` / `null`，
/// 让消费方按契约 §2.3.1 的「各模式适用表」读。
fn emit_tun_health(tun: &TunSession) {
    if !tun_running(tun) {
        return;
    }
    let (data_plane, checked_at) = tun.data_plane_health();
    let payload = RuntimeHealthChangedPayload {
        contract_version: EVENT_CONTRACT_VERSION,
        health: HealthSnapshot {
            contract_version: CONTRACT_VERSION,
            process: true,
            clash_api: false,
            data_plane,
            exit_ip: None,
            // 这个计数按控制面口径统计；TUN 不查控制面，恒为 0。
            consecutive_failures: 0,
            checked_at,
        },
        traffic: None,
        connections: None,
        latency_ms: None,
        node_latency_ms: None,
        emitted_at: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
    };
    if let Ok(value) = serde_json::to_value(payload) {
        crate::agent::app_handle::emit(
            crate::claurst_session::events::EV_RUNTIME_HEALTH_CHANGED,
            value,
        );
    }
}

/// manager 与 TUN 两条路径合成托盘状态。
///
/// **TUN Running 优先报已连接**：它的 sing-box 不经过 manager，manager 那边永远
/// 停在 Idle，只看 manager 就会「连上了但图标未连接」。TUN 只有 Stopped / Running
/// 两种，没有独立的失败态，所以不会抢走 manager 的 Error 语义。
fn combined_tray_state(manager: RuntimeState, tun_running: bool) -> TrayState {
    if tun_running {
        return TrayState::Connected;
    }
    state_to_tray(manager)
}

fn state_to_tray(state: RuntimeState) -> TrayState {
    match state {
        RuntimeState::Running | RuntimeState::Degraded => TrayState::Connected,
        RuntimeState::Failed => TrayState::Error,
        _ => TrayState::Idle,
    }
}

/// macOS 用 32×32 template（黑 + alpha），剪影分别是盾 / 勾 / 三角。
#[cfg(target_os = "macos")]
fn tray_icon(state: TrayState) -> Image<'static> {
    let bytes: &'static [u8] = match state {
        TrayState::Idle => include_bytes!("../icons/tray-idle-mac.png").as_slice(),
        TrayState::Connected => include_bytes!("../icons/tray-connected-mac.png").as_slice(),
        TrayState::Error => include_bytes!("../icons/tray-error-mac.png").as_slice(),
    };
    Image::from_bytes(bytes).expect("内置托盘图标必须是合法 PNG")
}

/// Windows（及 Linux 兜底）用彩色图；32px 供高 DPI 缩放，16/20/24 也在仓库里。
#[cfg(not(target_os = "macos"))]
fn tray_icon(state: TrayState) -> Image<'static> {
    let bytes: &'static [u8] = match state {
        TrayState::Idle => include_bytes!("../icons/tray-idle-win-32.png").as_slice(),
        TrayState::Connected => include_bytes!("../icons/tray-connected-win-32.png").as_slice(),
        TrayState::Error => include_bytes!("../icons/tray-error-win-32.png").as_slice(),
    };
    Image::from_bytes(bytes).expect("内置托盘图标必须是合法 PNG")
}

/// 画图标。
///
/// Tauri 的 `set_icon_with_as_template` 内部把闭包丢给主线程并**一直等到它执行完**，
/// 主线程一忙（弹窗、长任务），调用线程就停在那里。所以放到阻塞线程池并加超时：
/// 拖住的是那一个线程，不是整条状态循环。
async fn update_tray_icon<R: Runtime>(app: AppHandle<R>, state: TrayState) {
    let painting = tokio::task::spawn_blocking(move || set_tray_icon(&app, state));
    match tokio::time::timeout(TRAY_STATUS_TIMEOUT, painting).await {
        Ok(Ok(())) => {}
        Ok(Err(error)) => log::warn!("托盘：更新图标的线程异常结束：{error}"),
        Err(_) => log::warn!(
            "托盘：更新图标超过 {TRAY_STATUS_TIMEOUT:?} 未完成（主线程可能被占用），状态={state:?}"
        ),
    }
}

fn set_tray_icon<R: Runtime>(app: &AppHandle<R>, state: TrayState) {
    let Some(tray) = app.tray_by_id(TRAY_ID) else {
        // 以前这里静默什么都不做：托盘不动时根本看不出是「拿不到句柄」。
        log::warn!("托盘句柄缺失 id={TRAY_ID}，{state:?} 没能画上去");
        return;
    };
    // 原子设置图标与 template：单独 set_icon 会丢掉 template，macOS 下会显示成黑块或闪烁。
    match tray.set_icon_with_as_template(Some(tray_icon(state)), cfg!(target_os = "macos")) {
        Ok(()) => log::debug!("托盘图标已更新 {state:?}"),
        Err(error) => log::warn!("更新托盘图标失败 {state:?}：{error}"),
    }
}

/// 应用菜单「退出 Veyl」/ Cmd+Q：用户主动退出，**无论是否已连接**都弹一次。
pub fn on_menu_quit<R: Runtime>(app: &AppHandle<R>, parts: Parts) {
    request_quit(app, parts, QuitRoute::Menu);
}

/// 系统注销 / 关机触发的 `RunEvent::ExitRequested`：有连接才问，没连接直接退出。
pub fn on_exit_requested<R: Runtime>(app: &AppHandle<R>, parts: Parts) {
    log::info!(
        "ExitRequested 收到，quitting={}",
        QUITTING.load(Ordering::SeqCst)
    );
    request_quit(app, parts, QuitRoute::System);
}

/// 只有菜单 / Cmd+Q 会先弹确认；系统注销与托盘「退出」直接走退出流程。
///
/// `Menu` 一律发 `quit-requested` 等前端弹窗，30 秒没有决策按后台运行处理；
/// 前端不在或事件发不出去时回落到原生确认框。确认不依赖连接状态，也就不在
/// 异步任务里读 manager 快照。对话框继续用异步 `show_with_result`，
/// **不要改回 `blocking_show`**——主线程一旦被阻塞，`run_on_main_thread` 永远回不来。
pub fn request_quit<R: Runtime>(app: &AppHandle<R>, parts: Parts, route: QuitRoute) {
    if QUITTING.load(Ordering::SeqCst) || EXIT_PROMPT_OPEN.swap(true, Ordering::SeqCst) {
        return;
    }
    log::info!("开始退出流程 route={route:?}");
    if !route.asks_before_quitting() {
        start_shutdown(app.clone(), parts, None);
        return;
    }

    let app = app.clone();
    let recovery_app = app.clone();
    tauri::async_runtime::spawn(async move {
        let flow = std::panic::AssertUnwindSafe(async move {
            show_main_window(&app);
            ask_exit_in_app(app, parts).await;
        });
        if flow.catch_unwind().await.is_err() {
            // 弹窗都失败时不能把进程留在「QUITTING 但没退出」的状态。
            log::error!("退出确认流程 panic，保持后台运行");
            QUITTING.store(false, Ordering::SeqCst);
            EXIT_PROMPT_OPEN.store(false, Ordering::SeqCst);
            quit_prompt().close();
            emit_quit_dismissed(&recovery_app);
            hide_main_window(&recovery_app);
        }
    });
}

/// 菜单退出的确认：优先应用内弹窗，前端不可用时回落原生弹窗。
async fn ask_exit_in_app<R: Runtime>(app: AppHandle<R>, parts: Parts) {
    let receiver = match quit_prompt().open() {
        Some(receiver) => receiver,
        // 已有一次确认在等：保留那一次，不重复发事件。
        None => return,
    };

    if !can_use_in_app_prompt(
        frontend_ready(),
        app.get_webview_window(MAIN_WINDOW).is_some(),
    ) {
        log::warn!("前端未就绪或没有主窗口，回落到原生退出确认");
        quit_prompt().close();
        emit_quit_dismissed(&app);
        fall_back_to_native(app, parts);
        return;
    }

    let payload = json!({
        "contract_version": EVENT_CONTRACT_VERSION,
        "emitted_at": crate::claurst_session::events::now(),
    });
    if let Err(error) = app.emit(EV_QUIT_REQUESTED, payload) {
        log::warn!("quit-requested 发送失败，回落到原生退出确认：{error}");
        quit_prompt().close();
        emit_quit_dismissed(&app);
        fall_back_to_native(app, parts);
        return;
    }

    let result = wait_decision(receiver, QUIT_DECISION_TIMEOUT).await;
    if should_emit_quit_dismissed(&result) {
        emit_quit_dismissed(&app);
    }
    match result {
        PromptResult::Decision(decision) => apply_quit_decision(app, parts, decision),
        PromptResult::TimedOut => {
            log::info!(
                "退出确认 {} 秒没有决策，按后台运行处理",
                QUIT_DECISION_TIMEOUT.as_secs()
            );
            // 清掉已无人接收的等待，否则下一次 Cmd+Q 会打不开新的确认。
            quit_prompt().close();
            apply_quit_decision(app, parts, QuitDecision::Background);
        }
        PromptResult::Closed => {}
    }
}

fn fall_back_to_native<R: Runtime>(app: AppHandle<R>, parts: Parts) {
    let dialog_app = app.clone();
    ask_exit(&dialog_app, move |choice| {
        let decision = match choice {
            ExitChoice::Background => QuitDecision::Background,
            ExitChoice::Quit => QuitDecision::Quit,
        };
        apply_quit_decision(app, parts, decision);
    });
}

fn apply_quit_decision<R: Runtime>(app: AppHandle<R>, parts: Parts, decision: QuitDecision) {
    match decision {
        QuitDecision::Background => {
            EXIT_PROMPT_OPEN.store(false, Ordering::SeqCst);
            hide_main_window(&app);
        }
        QuitDecision::Quit => start_shutdown(app, parts, None),
    }
}

enum ExitChoice {
    Background,
    Quit,
}

/// 异步弹确认框；回调里决定后台运行还是走退出流程。
fn ask_exit<R: Runtime>(
    app: &AppHandle<R>,
    on_choice: impl FnOnce(ExitChoice) + Send + 'static,
) {
    // 窗口隐藏时要先把应用带到前台，否则对话框可能没有焦点。
    show_main_window(app);
    let mut builder = app
        .dialog()
        .message(
            "想让连接保持，请选择「后台运行」；App 会留在后台，后台组件继续工作。\n选择「退出」会先断开连接并恢复网络，后台组件随后自动退出。",
        )
        .title("退出 Veyl")
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom(
            "后台运行".into(),
            "退出".into(),
        ));
    if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
        builder = builder.parent(&window);
    }
    builder.show_with_result(move |result| {
        let choice = match result {
            MessageDialogResult::Custom(label) if label == "退出" => ExitChoice::Quit,
            _ => ExitChoice::Background,
        };
        on_choice(choice);
    });
}

/// 进入退出流程（§4.6 第 1 步：从这里开始拒绝新连接）。
fn start_shutdown<R: Runtime>(
    app: AppHandle<R>,
    parts: Parts,
    applied: Option<crate::proxy::ProxyEndpoint>,
) {
    QUITTING.store(true, Ordering::SeqCst);
    log::info!("进入退出流程：撤代理 → 停运行时 → 清明文配置");
    // 停运行时与 networksetup 都是同步调用，放到阻塞线程里跑，不占用事件循环。
    tauri::async_runtime::spawn_blocking(move || {
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            run_shutdown(app.clone(), parts, applied);
        }));
        if result.is_err() {
            // 绝不带着已经撤了一半的代理直接退出；留后台，让用户可以重试或恢复网络。
            log::error!("退出流程 panic，已中止退出并恢复后台运行");
            QUITTING.store(false, Ordering::SeqCst);
            EXIT_PROMPT_OPEN.store(false, Ordering::SeqCst);
            hide_main_window(&app);
        }
    });
}

fn run_shutdown<R: Runtime>(
    app: AppHandle<R>,
    parts: Parts,
    mut applied: Option<crate::proxy::ProxyEndpoint>,
) {
    match perform_shutdown(&parts, &mut applied) {
        Ok(()) => app.exit(0),
        Err(reason) => {
            log::warn!("退出已中止：{reason}");
            let dialog_app = app.clone();
            ask_proxy_failure(&app, &reason, move |choice| match choice {
                ForceChoice::Retry => start_shutdown(dialog_app, parts, applied),
                ForceChoice::Force => {
                    force_cleanup(&parts);
                    dialog_app.exit(0);
                }
                ForceChoice::Cancel => {
                    // 用户选择留下继续用，退出流程作废。
                    QUITTING.store(false, Ordering::SeqCst);
                    EXIT_PROMPT_OPEN.store(false, Ordering::SeqCst);
                    // 与真实代理状态对账：撤代理可能已经成功但校验失败。
                    let proxy_on = parts.proxy.current_endpoint().ok().flatten().is_some();
                    tauri::async_runtime::block_on(
                        parts.manager.set_system_proxy_enabled(proxy_on),
                    );
                    hide_main_window(&dialog_app);
                }
            });
        }
    }
}

enum ForceChoice {
    Retry,
    Force,
    Cancel,
}

fn ask_proxy_failure<R: Runtime>(
    app: &AppHandle<R>,
    reason: &str,
    on_choice: impl FnOnce(ForceChoice) + Send + 'static,
) {
    show_main_window(app);
    let mut builder = app
        .dialog()
        .message(format!(
            "网络尚未恢复，退出会导致断网。\n\n{reason}\n\n请重试；只有确认可以断网时才选择「强制退出」。"
        ))
        .title("网络尚未恢复")
        .kind(MessageDialogKind::Error)
        .buttons(MessageDialogButtons::OkCancelCustom(
            "重试".into(),
            "强制退出".into(),
        ));
    if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
        builder = builder.parent(&window);
    }
    builder.show_with_result(move |result| {
        let choice = match result {
            MessageDialogResult::Custom(label) if label == "强制退出" => ForceChoice::Force,
            MessageDialogResult::Custom(label) if label == "重试" => ForceChoice::Retry,
            _ => ForceChoice::Cancel,
        };
        on_choice(choice);
    });
}

/// §4.6：撤代理并校验 → 停运行时 → 删明文配置。
///
/// `applied` 跨重试保留：disable 成功后备份会被清掉，重试时仍要拿它做校验。
fn perform_shutdown(
    parts: &Parts,
    applied: &mut Option<crate::proxy::ProxyEndpoint>,
) -> Result<(), String> {
    // 探针运行时是测速临时进程，先停掉，不参与连接状态。
    tauri::async_runtime::block_on(parts.manager.stop_probe());
    // 先停 TUN：它的 sing-box 由 helper 持有，退出后 App 的租约也会断，
    // 但等 5 秒兜底太慢，用户点「退出」就应当立刻断开。
    // 失败只记日志、继续退出——契约 §7.8.3 不允许清理失败卡住退出。
    if let Err(error) = parts
        .tun
        .stop_with_deadline(std::time::Duration::from_secs(10))
    {
        log::warn!("退出时停止 TUN 失败（继续退出）：{}", error.message);
    } else {
        log::info!("TUN 已停止");
    }

    if applied.is_none() {
        *applied = parts
            .proxy
            .applied_endpoint()
            .map_err(|error| format!("读取代理备份失败：{error}"))?;
    }

    parts
        .proxy
        .disable()
        .map_err(|error| format!("撤销系统代理失败：{error}"))?;
    log::info!("系统代理已撤销");

    // 只校验我们写进去的那个端点：用户本来就可能自建本地代理，不能一律拦截。
    if let Some(endpoint) = applied.as_ref() {
        let still = parts
            .proxy
            .endpoint_in_use(endpoint)
            .map_err(|error| format!("校验系统代理失败：{error}"))?;
        if !still.is_empty() {
            return Err(format!(
                "{endpoint} 仍被这些网络服务使用：{}",
                still.join("、")
            ));
        }
    }

    if let Err(error) = tauri::async_runtime::block_on(parts.manager.stop()) {
        log::warn!("退出时停止运行时失败（启动回收会兜底）：{error}");
    } else {
        log::info!("运行时已停止");
    }
    crate::config::remove_all_profile_configs(&parts.config_dir);
    log::info!("退出清理完成");
    Ok(())
}

/// 强制退出：跳过代理校验，但仍尽力停运行时、清明文配置。
fn force_cleanup(parts: &Parts) {
    tauri::async_runtime::block_on(parts.manager.stop_probe());
    if let Err(error) = parts
        .tun
        .stop_with_deadline(std::time::Duration::from_secs(10))
    {
        log::warn!("强制退出时停止 TUN 失败：{}", error.message);
    }
    if let Err(error) = parts.proxy.disable() {
        log::warn!("强制退出时撤销系统代理失败：{error}");
    }
    if let Err(error) = tauri::async_runtime::block_on(parts.manager.stop()) {
        log::warn!("强制退出时停止运行时失败：{error}");
    }
    crate::config::remove_all_profile_configs(&parts.config_dir);
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 菜单「退出 Veyl」/ Cmd+Q 是用户主动离开窗口，任何时候都弹窗
    /// （2026-11-17 产品决定，`docs/design/quit-dialog.md` §0）。
    #[test]
    fn menu_quit_always_asks() {
        assert!(QuitRoute::Menu.asks_before_quitting());
    }

    /// 系统注销 / 关机不弹：系统有收尾超时，弹窗只会卡住关机，即便正在连接。
    #[test]
    fn system_exit_goes_straight_through_even_while_running() {
        assert!(!QuitRoute::System.asks_before_quitting());
    }

    /// 托盘「退出」意图明确，直接退出。
    #[test]
    fn tray_quit_goes_straight_through() {
        assert!(!QuitRoute::Tray.asks_before_quitting());
    }

    /// 前端没调过命令或主窗口不在时，不能用应用内弹窗；这条路径回落原生并补发 `quit-dismissed`。
    #[test]
    fn in_app_prompt_requires_a_live_frontend_and_main_window() {
        assert!(!can_use_in_app_prompt(false, true));
        assert!(!can_use_in_app_prompt(true, false));
        assert!(can_use_in_app_prompt(true, true));
    }

    /// 只有超时会在等待路径上发 `quit-dismissed`；正常决策不发。
    /// 回落原生与 panic 在各自分支直接发，`Closed` 已由回落路径发过，不重复。
    #[test]
    fn quit_dismissed_is_sent_only_when_no_decision_arrives() {
        assert!(should_emit_quit_dismissed(&PromptResult::TimedOut));
        assert!(!should_emit_quit_dismissed(&PromptResult::Decision(
            QuitDecision::Background
        )));
        assert!(!should_emit_quit_dismissed(&PromptResult::Decision(
            QuitDecision::Quit
        )));
        assert!(!should_emit_quit_dismissed(&PromptResult::Closed));
    }

    #[test]
    fn quit_decision_parses_only_the_two_actions() {
        assert_eq!(
            QuitDecision::parse("background"),
            Some(QuitDecision::Background)
        );
        assert_eq!(QuitDecision::parse("quit"), Some(QuitDecision::Quit));
        assert_eq!(QuitDecision::parse("cancel"), None);
    }

    #[tokio::test]
    async fn quit_prompt_forwards_background_and_ignores_a_second_decision() {
        let prompt = QuitPrompt::default();
        let receiver = prompt.open().expect("第一次 open 必须成功");
        assert!(prompt.decide(QuitDecision::Background));
        assert!(
            !prompt.decide(QuitDecision::Quit),
            "第二次 quit_decision 必须被忽略"
        );
        assert_eq!(
            wait_decision(receiver, Duration::from_secs(1)).await,
            PromptResult::Decision(QuitDecision::Background)
        );
        assert!(!prompt.is_open());
    }

    #[tokio::test]
    async fn quit_prompt_forwards_quit() {
        let prompt = QuitPrompt::default();
        let receiver = prompt.open().expect("第一次 open 必须成功");
        assert!(prompt.decide(QuitDecision::Quit));
        assert_eq!(
            wait_decision(receiver, Duration::from_secs(1)).await,
            PromptResult::Decision(QuitDecision::Quit)
        );
    }

    #[tokio::test]
    async fn quit_prompt_times_out_and_drops_late_decisions() {
        let prompt = QuitPrompt::default();
        let receiver = prompt.open().expect("第一次 open 必须成功");
        assert_eq!(
            wait_decision(receiver, Duration::from_millis(10)).await,
            PromptResult::TimedOut
        );
        // 生产路径在超时后必须 close，否则残留的发送端会让下一次确认打不开。
        prompt.close();
        assert!(!prompt.is_open());
        assert!(!prompt.decide(QuitDecision::Quit), "超时后的决策不能再生效");
    }

    /// 回落到原生弹窗时关掉应用内等待，之后到达的决策一律作废。
    #[tokio::test]
    async fn closing_the_prompt_falls_back_and_rejects_late_decisions() {
        let prompt = QuitPrompt::default();
        let receiver = prompt.open().expect("第一次 open 必须成功");
        prompt.close();
        assert_eq!(
            wait_decision(receiver, Duration::from_secs(1)).await,
            PromptResult::Closed
        );
        assert!(!prompt.decide(QuitDecision::Background));
    }

    #[test]
    fn quit_prompt_never_opens_twice() {
        let prompt = QuitPrompt::default();
        assert!(prompt.open().is_some());
        assert!(prompt.open().is_none(), "已有确认在等时不能重复弹");
        prompt.close();
        assert!(prompt.open().is_some(), "上一次结束后可以重新打开");
    }

    #[test]
    fn exit_interception_never_trusts_the_code() {
        // 实测 Cmd+Q 可能带 Some(0)：仍然要拦。
        assert!(should_intercept_exit(false, Some(0)));
        assert!(should_intercept_exit(false, None));
        // 我们自己 app.exit(0) 前已置位 QUITTING：放行。
        assert!(!should_intercept_exit(true, Some(0)));
        assert!(!should_intercept_exit(true, None));
    }

    #[test]
    fn tray_states_follow_the_runtime_state() {
        assert_eq!(state_to_tray(RuntimeState::Running), TrayState::Connected);
        assert_eq!(state_to_tray(RuntimeState::Degraded), TrayState::Connected);
        assert_eq!(state_to_tray(RuntimeState::Failed), TrayState::Error);
        for state in [
            RuntimeState::Idle,
            RuntimeState::Starting,
            RuntimeState::Stopping,
            RuntimeState::Restarting,
        ] {
            assert_eq!(state_to_tray(state), TrayState::Idle, "{state:?}");
        }
    }

    /// 托盘必须同时反映 manager（代理模式）与 TUN（特权助手的子进程）两条路径。
    #[test]
    fn tray_combines_manager_and_tun_state() {
        // TUN 连着、manager 不知道：这正是「连上了但图标未连接」的修复点。
        assert_eq!(
            combined_tray_state(RuntimeState::Idle, true),
            TrayState::Connected
        );
        // manager 连着、TUN 没开：代理模式。
        assert_eq!(
            combined_tray_state(RuntimeState::Running, false),
            TrayState::Connected
        );
        // 两边都连着。
        assert_eq!(
            combined_tray_state(RuntimeState::Running, true),
            TrayState::Connected
        );
        // 两边都没连。
        assert_eq!(
            combined_tray_state(RuntimeState::Idle, false),
            TrayState::Idle
        );
        assert_eq!(
            combined_tray_state(RuntimeState::Starting, false),
            TrayState::Idle
        );
    }

    /// 托盘与主界面同源：事件流的 `to` 与快照 `state` 是同一个值，
    /// 两边读同一份状态，不可能再互相矛盾。
    #[test]
    fn tray_state_agrees_with_the_event_snapshot() {
        for (state, tun_running) in [
            (RuntimeState::Starting, false),
            (RuntimeState::Running, true),
            (RuntimeState::Stopping, true),
            (RuntimeState::Idle, false),
            (RuntimeState::Failed, false),
        ] {
            let snapshot = crate::runtime::RuntimeStatus::tun_pending(state, None, None);
            assert_eq!(snapshot.state, state, "事件不变量：snapshot.state == to");
            assert_eq!(
                combined_tray_state(state, tun_running),
                combined_tray_state(snapshot.state, tun_running),
                "{state:?}"
            );
        }
        // 启动窗口不算「连着」：主界面这时也显示连接中，而不是已连接。
        assert_eq!(
            combined_tray_state(RuntimeState::Starting, false),
            TrayState::Idle
        );
    }

    /// TUN 只有 Stopped / Running，不能抢 manager 的失败语义；
    /// 但 TUN 真的在跑时优先级最高。
    #[test]
    fn tun_does_not_steal_the_manager_error_state() {
        assert_eq!(
            combined_tray_state(RuntimeState::Failed, false),
            TrayState::Error
        );
        assert_eq!(
            combined_tray_state(RuntimeState::Failed, true),
            TrayState::Connected
        );
    }
}
