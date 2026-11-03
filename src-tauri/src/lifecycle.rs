//! 常驻与生命周期：托盘、窗口隐藏、退出确认与有序退出。
//!
//! 托盘三态用不同形状区分（圆环 / 实心圆 / 三角），不能只靠颜色。
//! 退出流程严格按序：撤系统代理并校验 → 停运行时 → 删明文配置 → 退出。

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use tauri::image::Image;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_dialog::{
    DialogExt, MessageDialogButtons, MessageDialogKind, MessageDialogResult,
};

use crate::proxy::ProxyController;
use crate::runtime::{RuntimeEvent, RuntimeManager, RuntimeState};

const TRAY_ID: &str = "veyl-tray";
const MAIN_WINDOW: &str = "main";

static QUITTING: AtomicBool = AtomicBool::new(false);
static EXIT_PROMPT_OPEN: AtomicBool = AtomicBool::new(false);

#[derive(Clone)]
pub struct Parts {
    pub proxy: Arc<ProxyController>,
    pub manager: Arc<RuntimeManager>,
    pub config_dir: PathBuf,
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

    spawn_tray_state_loop(app.clone(), parts.manager);
    Ok(())
}

fn spawn_tray_state_loop<R: Runtime>(app: AppHandle<R>, manager: Arc<RuntimeManager>) {
    let mut events = manager.subscribe();
    tauri::async_runtime::spawn(async move {
        let mut current = TrayState::Idle;
        set_tray_icon(&app, current);
        loop {
            let next = match events.recv().await {
                Ok(RuntimeEvent::StateChanged(payload)) => state_to_tray(payload.to),
                Ok(RuntimeEvent::HealthChanged(_)) => continue,
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                    state_to_tray(manager.status().await.state)
                }
                Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
            };
            if next != current {
                current = next;
                set_tray_icon(&app, current);
            }
        }
    });
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
            "退出 Veyl 会断开当前连接并恢复网络。\n想让连接保持，请选择「后台运行」。",
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
    }
    crate::config::remove_all_profile_configs(&parts.config_dir);
    Ok(())
}

/// 强制退出：跳过代理校验，但仍尽力停运行时、清明文配置。
fn force_cleanup(parts: &Parts) {
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
}
