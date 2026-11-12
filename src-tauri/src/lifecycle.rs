//! 常驻与生命周期：托盘、窗口隐藏、退出确认与有序退出。
//!
//! 托盘三态用不同形状区分（圆环 / 实心圆 / 三角），不能只靠颜色。
//! 退出流程严格按序：撤系统代理并校验 → 停运行时 → 删明文配置 → 退出。

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use tauri::image::Image;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_dialog::{
    DialogExt, MessageDialogButtons, MessageDialogKind, MessageDialogResult,
};

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
            "tray-quit" => request_quit(app, quit_parts.clone(), false),
            _ => {}
        })
        .build(app)?;

    spawn_tray_state_loop(app.clone(), parts.manager, parts.tun);
    Ok(())
}

/// 托盘状态的兜底轮询间隔。
///
/// manager 的状态变化有广播事件，TUN 的 sing-box 却是特权助手的子进程、不经过
/// manager，发不出事件。用短超时把 `recv` 打断再全量算一次，TUN 断开后一两秒内
/// 就能反映到托盘；再加上循环启动时先算一次，App 重启接手活着的 TUN 也不会显示
/// 「未连接」。
const TRAY_RECHECK_INTERVAL: Duration = Duration::from_secs(2);

fn spawn_tray_state_loop<R: Runtime>(
    app: AppHandle<R>,
    manager: Arc<RuntimeManager>,
    tun: Arc<TunSession>,
) {
    let mut events = manager.subscribe();
    tauri::async_runtime::spawn(async move {
        let mut current =
            combined_tray_state(manager.status().await.state, tun_running(&tun));
        set_tray_icon(&app, current);
        loop {
            let next = match tokio::time::timeout(TRAY_RECHECK_INTERVAL, events.recv()).await {
                Ok(Ok(RuntimeEvent::StateChanged(payload))) => {
                    combined_tray_state(payload.to, tun_running(&tun))
                }
                Ok(Ok(RuntimeEvent::HealthChanged(_))) => continue,
                // 事件丢了或这一轮没有事件：直接问两条路径的当前状态。
                Ok(Err(tokio::sync::broadcast::error::RecvError::Lagged(_))) | Err(_) => {
                    combined_tray_state(manager.status().await.state, tun_running(&tun))
                }
                Ok(Err(tokio::sync::broadcast::error::RecvError::Closed)) => break,
            };
            if next != current {
                current = next;
                set_tray_icon(&app, current);
            }
        }
    });
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

fn set_tray_icon<R: Runtime>(app: &AppHandle<R>, state: TrayState) {
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        // 原子设置图标与 template：单独 set_icon 会丢掉 template，macOS 下会显示成黑块或闪烁。
        if let Err(error) =
            tray.set_icon_with_as_template(Some(tray_icon(state)), cfg!(target_os = "macos"))
        {
            log::warn!("更新托盘图标失败：{error}");
        }
    }
}

/// Cmd+Q / 应用菜单「退出 Veyl」被拦截后调用。
pub fn on_exit_requested<R: Runtime>(app: &AppHandle<R>, parts: Parts) {
    log::info!(
        "ExitRequested 收到，quitting={}",
        QUITTING.load(Ordering::SeqCst)
    );
    request_quit(app, parts, true);
}

/// 托盘「退出」传 `confirm = false`，直接走退出流程。
///
/// 注意：对话框一律用异步 `show_with_result`，**不要改回 `blocking_show`**。
/// 主线程一旦被阻塞，`run_on_main_thread` 永远回不来，是标准死锁形态。
pub fn request_quit<R: Runtime>(app: &AppHandle<R>, parts: Parts, confirm: bool) {
    if QUITTING.load(Ordering::SeqCst) || EXIT_PROMPT_OPEN.swap(true, Ordering::SeqCst) {
        return;
    }
    log::info!("开始退出流程 confirm={confirm}");
    let app = app.clone();
    let recovery_app = app.clone();
    let scheduled = std::panic::catch_unwind(std::panic::AssertUnwindSafe(move || {
        if confirm {
            let dialog_app = app.clone();
            ask_exit(&dialog_app, move |choice| match choice {
                ExitChoice::Background => {
                    EXIT_PROMPT_OPEN.store(false, Ordering::SeqCst);
                    hide_main_window(&app);
                }
                ExitChoice::Quit => start_shutdown(app, parts, None),
            });
        } else {
            start_shutdown(app, parts, None);
        }
    }));
    if scheduled.is_err() {
        // 弹窗都失败时不能把进程留在「QUITTING 但没退出」的状态。
        log::error!("退出确认流程 panic，保持后台运行");
        QUITTING.store(false, Ordering::SeqCst);
        EXIT_PROMPT_OPEN.store(false, Ordering::SeqCst);
        hide_main_window(&recovery_app);
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
