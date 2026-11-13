use std::time::Duration;

use crate::guard::{check_once, GuardBackend, GuardStep};
use crate::lease::{FileLock, LeasePaths};
use crate::macos_wire;

/// 连续多少次「没有租约」后退出。登录时被 `RunAtLoad` 拉起、
/// 而用户根本没连代理的情况下，别白白常驻。
const IDLE_CHECKS: u32 = 3;

const RECHECK_INTERVAL: Duration = Duration::from_secs(1);

struct MacBackend;

impl GuardBackend for MacBackend {
    fn current(&self) -> Result<Option<String>, String> {
        macos_wire::current()
    }

    fn endpoint_in_use(&self, endpoint: &str) -> Result<bool, String> {
        Ok(macos_wire::active_endpoints()?
            .iter()
            .any(|value| value == endpoint))
    }

    fn restore(&self, payload: &serde_json::Value) -> Result<(), String> {
        macos_wire::restore(payload)
    }

    fn original_endpoint(&self, payload: &serde_json::Value) -> Option<String> {
        macos_wire::original_endpoint(payload)
    }
}

struct StderrLogger;

impl log::Log for StderrLogger {
    fn enabled(&self, _metadata: &log::Metadata) -> bool {
        true
    }

    fn log(&self, record: &log::Record) {
        // launchd 把 stdout/stderr 重定向到 ~/.veyl/logs/proxy-guard.log。
        eprintln!("[{}] {}", record.level(), record.args());
    }

    fn flush(&self) {}
}

static LOGGER: StderrLogger = StderrLogger;

/// `launchctl bootout` 会发 SIGTERM。默认动作的退出码非 0，会被
/// `KeepAlive.SuccessfulExit=false` 当成「异常退出」反复拉起；这里干净地退 0。
extern "C" fn on_terminate(_signal: libc::c_int) {
    unsafe { libc::_exit(0) };
}

pub fn run() {
    let _ = log::set_logger(&LOGGER);
    log::set_max_level(log::LevelFilter::Info);

    unsafe {
        let handler = on_terminate as extern "C" fn(libc::c_int) as libc::sighandler_t;
        libc::signal(libc::SIGTERM, handler);
        libc::signal(libc::SIGHUP, handler);
        libc::signal(libc::SIGINT, handler);
    }

    let home = match std::env::var_os("HOME") {
        Some(home) => home,
        None => {
            log::error!("HOME 未设置，无法定位 ~/.veyl");
            return;
        }
    };
    let paths = LeasePaths::in_dir(crate::veyl_paths::data_dir_under(
        std::path::Path::new(&home),
    ));

    // 单实例：WatchPaths 与 kickstart 同时触发时只留一个。
    let _guard_lock = match FileLock::try_exclusive(&paths.guard_lock()) {
        Ok(Some(lock)) => lock,
        Ok(None) => {
            log::info!("另一个看门狗已在运行，退出");
            return;
        }
        Err(error) => {
            log::error!("获取看门狗单实例锁失败：{error}");
            return;
        }
    };

    let backend = MacBackend;
    let mut idle_checks = 0u32;
    loop {
        match check_once(&paths, &backend) {
            GuardStep::Finished(report) => {
                log::info!("处理完成：{:?}（当前 {:?}）", report.status, report.current);
                return;
            }
            GuardStep::NoLease => {
                idle_checks += 1;
                if idle_checks >= IDLE_CHECKS {
                    return;
                }
            }
            GuardStep::Waiting => {
                idle_checks = 0;
            }
        }
        std::thread::sleep(RECHECK_INTERVAL);
    }
}
