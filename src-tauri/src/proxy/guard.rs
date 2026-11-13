//! 看门狗的单步逻辑。主循环（每 1 秒一次）与单实例锁在
//! `bin/veyl-proxy-guard/main.rs`；这里只做「检查一次」，
//! 这样可以用假后端在 `cargo test --lib` 里跑完整判定与还原。
//!
//! 本文件同时被看门狗二进制用 `#[path]` 引入，必须自包含：
//! 通过 `crate::lease` / `crate::recovery` 引用共享模块（两边都在 crate 根）。

use serde_json::Value;

use crate::lease::{
    self, FileLock, LeasePaths, RecoveryReport, RecoverySource, RecoveryStatus,
};
use crate::recovery::{decide, Decision};

/// 还原动作的平台实现。看门狗只决定「要不要还原」，具体 `networksetup`
/// 由 App 与看门狗共用的 `macos_wire` 提供（见 `bin/veyl-proxy-guard`）。
pub trait GuardBackend {
    fn current(&self) -> Result<Option<String>, String>;
    fn endpoint_in_use(&self, endpoint: &str) -> Result<bool, String>;
    fn restore(&self, payload: &Value) -> Result<(), String>;
    fn original_endpoint(&self, payload: &Value) -> Option<String>;
}

#[derive(Debug)]
pub enum GuardStep {
    /// 没有租约：连续几次都没有就退出。
    NoLease,
    /// App 还活着（租约锁被占），继续等。
    Waiting,
    /// 已经处理完（成功或失败），调用方应退出 0。
    Finished(RecoveryReport),
}

/// 判定之后、落笔之前的二次读结果。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum LeaseCheck {
    Proceed,
    /// 租约被换过（App 重启）或读不出来：放弃这一轮。
    Changed,
    /// 租约被正常删除（App 在 disable）：没有事可做。
    Gone,
}

fn recheck_lease(path: &std::path::Path, expected_id: &str) -> LeaseCheck {
    match lease::read_lease(path) {
        Ok(Some(entry)) if entry.lease_id == expected_id => LeaseCheck::Proceed,
        Ok(Some(_)) => LeaseCheck::Changed,
        Ok(None) => LeaseCheck::Gone,
        Err(_) => LeaseCheck::Changed,
    }
}

pub fn check_once(paths: &LeasePaths, backend: &dyn GuardBackend) -> GuardStep {
    if !paths.lease().exists() {
        return GuardStep::NoLease;
    }

    // 拿不到锁 = App 还活着。锁的持有者是内核事实，pid 复用不会误判。
    let _lock = match FileLock::try_exclusive(&paths.lease_lock()) {
        Ok(Some(lock)) => lock,
        Ok(None) => return GuardStep::Waiting,
        Err(error) => {
            log::warn!("看门狗读取租约锁失败：{error}");
            return GuardStep::Waiting;
        }
    };

    let lease_entry = match lease::read_lease(&paths.lease()) {
        Ok(Some(entry)) => entry,
        // 拿到锁之后租约被正常删除（App 在 disable）：没有事可做。
        Ok(None) => return GuardStep::NoLease,
        Err(error) => {
            // 租约读不出来就没法还原；删掉它，让下次启动按 proxy_backup 表处理。
            log::error!("看门狗读到损坏的租约，交由下次启动恢复：{error}");
            let _ = lease::remove_if_exists(&paths.lease());
            let report = RecoveryReport::new(
                RecoveryStatus::Failed,
                "",
                backend.current().ok().flatten(),
                Some(format!("代理租约无法解析：{error}")),
                RecoverySource::Watchdog,
            );
            write_report(paths, &report);
            return GuardStep::Finished(report);
        }
    };

    let current = match backend.current() {
        Ok(current) => current,
        Err(error) => {
            let report = RecoveryReport::new(
                RecoveryStatus::Failed,
                lease_entry.endpoint.clone(),
                None,
                Some(format!("读取系统代理失败：{error}")),
                RecoverySource::Watchdog,
            );
            write_report(paths, &report);
            return GuardStep::Finished(report);
        }
    };

    let original = backend.original_endpoint(&lease_entry.payload);
    let decision = decide(current.as_deref(), original.as_deref(), &lease_entry.endpoint);

    // 判定之后、落笔之前再读一次：App 重启会换 lease_id，值变了就放弃。
    match recheck_lease(&paths.lease(), &lease_entry.lease_id) {
        LeaseCheck::Proceed => {}
        LeaseCheck::Changed => return GuardStep::Waiting,
        LeaseCheck::Gone => return GuardStep::NoLease,
    }

    let report = match decision {
        Decision::Restored => match backend.restore(&lease_entry.payload) {
            Ok(()) => match backend.endpoint_in_use(&lease_entry.endpoint) {
                Ok(false) => RecoveryReport::new(
                    RecoveryStatus::Restored,
                    lease_entry.endpoint.clone(),
                    backend.current().ok().flatten(),
                    None,
                    RecoverySource::Watchdog,
                ),
                Ok(true) => failed(
                    &lease_entry.endpoint,
                    backend.current().ok().flatten(),
                    format!("还原后 {} 仍被网络服务使用", lease_entry.endpoint),
                ),
                Err(error) => failed(
                    &lease_entry.endpoint,
                    backend.current().ok().flatten(),
                    format!("校验系统代理失败：{error}"),
                ),
            },
            Err(error) => failed(
                &lease_entry.endpoint,
                backend.current().ok().flatten(),
                format!("还原系统代理失败：{error}"),
            ),
        },
        Decision::AlreadyRestored => RecoveryReport::new(
            RecoveryStatus::AlreadyRestored,
            lease_entry.endpoint.clone(),
            current,
            None,
            RecoverySource::Watchdog,
        ),
        Decision::LeftAlone { current } => RecoveryReport::new(
            RecoveryStatus::LeftAlone,
            lease_entry.endpoint.clone(),
            current,
            None,
            RecoverySource::Watchdog,
        ),
    };

    let keep_lease = report.status == RecoveryStatus::Failed;
    let written = write_report(paths, &report);
    if !keep_lease && written {
        if let Err(error) = lease::remove_if_exists(&paths.lease()) {
            log::warn!("看门狗删除租约失败：{error}");
        }
    }
    GuardStep::Finished(report)
}

fn failed(endpoint: &str, current: Option<String>, error: String) -> RecoveryReport {
    RecoveryReport::new(
        RecoveryStatus::Failed,
        endpoint,
        current,
        Some(error),
        RecoverySource::Watchdog,
    )
}

/// 写报告成功返回 true；失败只记日志——租约保留，下次启动会再走一遍。
fn write_report(paths: &LeasePaths, report: &RecoveryReport) -> bool {
    match lease::write_report(&paths.report(), report) {
        Ok(()) => true,
        Err(error) => {
            log::error!("看门狗写恢复报告失败（交由下次启动恢复）：{error}");
            false
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    struct Fake {
        current: RefCell<Option<String>>,
        restore_to: Option<String>,
        fail_restore: bool,
        fail_current: bool,
        keep_endpoint_after_restore: bool,
    }

    impl Fake {
        fn new(current: Option<&str>, original: Option<&str>) -> Self {
            Self {
                current: RefCell::new(current.map(str::to_string)),
                restore_to: original.map(str::to_string),
                fail_restore: false,
                fail_current: false,
                keep_endpoint_after_restore: false,
            }
        }
    }

    impl GuardBackend for Fake {
        fn current(&self) -> Result<Option<String>, String> {
            if self.fail_current {
                return Err("networksetup failed".into());
            }
            Ok(self.current.borrow().clone())
        }

        fn endpoint_in_use(&self, endpoint: &str) -> Result<bool, String> {
            Ok(self.current.borrow().as_deref() == Some(endpoint))
        }

        fn restore(&self, _payload: &Value) -> Result<(), String> {
            if self.fail_restore {
                return Err("denied".into());
            }
            if self.keep_endpoint_after_restore {
                return Ok(());
            }
            *self.current.borrow_mut() = self.restore_to.clone();
            Ok(())
        }

        fn original_endpoint(&self, payload: &Value) -> Option<String> {
            payload.get("original").and_then(Value::as_str).map(str::to_string)
        }
    }

    fn temp_paths(tag: &str) -> LeasePaths {
        let dir = std::env::temp_dir().join(format!(
            "veyl-guard-{tag}-{:016x}",
            rand::random::<u64>()
        ));
        LeasePaths::in_dir(dir)
    }

    fn install_lease(paths: &LeasePaths) {
        let lease = lease::ProxyLease::new(
            "fake",
            "127.0.0.1:2080",
            serde_json::json!({ "original": "corp-proxy:8080" }),
        );
        lease::write_lease(&paths.lease(), &lease).unwrap();
    }

    #[test]
    fn a_crashed_app_leftover_is_restored() {
        let paths = temp_paths("restored");
        install_lease(&paths);
        let backend = Fake::new(Some("127.0.0.1:2080"), Some("corp-proxy:8080"));

        match check_once(&paths, &backend) {
            GuardStep::Finished(report) => {
                assert_eq!(report.status, RecoveryStatus::Restored);
                assert_eq!(report.current.as_deref(), Some("corp-proxy:8080"));
                assert_eq!(report.source, RecoverySource::Watchdog);
            }
            other => panic!("应当完成恢复，实际 {other:?}"),
        }
        assert!(!paths.lease().exists(), "恢复成功后必须删除租约");
        let report = lease::take_report(&paths.report()).unwrap().unwrap();
        assert_eq!(report.status, RecoveryStatus::Restored);
        let _ = std::fs::remove_dir_all(paths.dir());
    }

    #[test]
    fn a_lease_that_never_applied_is_just_discarded() {
        let paths = temp_paths("already");
        install_lease(&paths);
        let backend = Fake::new(Some("corp-proxy:8080"), Some("corp-proxy:8080"));

        match check_once(&paths, &backend) {
            GuardStep::Finished(report) => {
                assert_eq!(report.status, RecoveryStatus::AlreadyRestored);
            }
            other => panic!("应当是 already_restored，实际 {other:?}"),
        }
        assert!(!paths.lease().exists());
        let _ = std::fs::remove_dir_all(paths.dir());
    }

    #[test]
    fn user_changes_are_left_alone() {
        let paths = temp_paths("left-alone");
        install_lease(&paths);
        let backend = Fake::new(Some("user-proxy:3128"), Some("corp-proxy:8080"));

        match check_once(&paths, &backend) {
            GuardStep::Finished(report) => {
                assert_eq!(report.status, RecoveryStatus::LeftAlone);
                assert_eq!(report.current.as_deref(), Some("user-proxy:3128"));
            }
            other => panic!("应当是 left_alone，实际 {other:?}"),
        }
        assert_eq!(
            backend.current().unwrap().as_deref(),
            Some("user-proxy:3128"),
            "绝不能覆盖用户自己的设置"
        );
        assert!(!paths.lease().exists());
        let _ = std::fs::remove_dir_all(paths.dir());
    }

    #[test]
    fn a_failed_restore_keeps_the_lease_for_the_next_startup() {
        let paths = temp_paths("failed");
        install_lease(&paths);
        let mut backend = Fake::new(Some("127.0.0.1:2080"), Some("corp-proxy:8080"));
        backend.fail_restore = true;

        match check_once(&paths, &backend) {
            GuardStep::Finished(report) => {
                assert_eq!(report.status, RecoveryStatus::Failed);
                assert!(report.error.is_some());
            }
            other => panic!("应当是 failed，实际 {other:?}"),
        }
        assert!(paths.lease().exists(), "失败时租约必须保留");
        let _ = std::fs::remove_dir_all(paths.dir());
    }

    #[test]
    fn a_live_app_is_never_touched() {
        let paths = temp_paths("alive");
        install_lease(&paths);
        let _held = FileLock::try_exclusive(&paths.lease_lock()).unwrap().unwrap();
        let backend = Fake::new(Some("127.0.0.1:2080"), Some("corp-proxy:8080"));

        assert!(matches!(check_once(&paths, &backend), GuardStep::Waiting));
        assert!(paths.lease().exists());
        let _ = std::fs::remove_dir_all(paths.dir());
    }

    #[test]
    fn no_lease_means_nothing_to_do() {
        let paths = temp_paths("none");
        let backend = Fake::new(None, None);
        assert!(matches!(check_once(&paths, &backend), GuardStep::NoLease));
        let _ = std::fs::remove_dir_all(paths.dir());
    }

    #[test]
    fn a_rewritten_or_missing_lease_aborts_the_round() {
        let paths = temp_paths("recheck");
        install_lease(&paths);
        let first = lease::read_lease(&paths.lease()).unwrap().unwrap();
        assert_eq!(
            recheck_lease(&paths.lease(), &first.lease_id),
            LeaseCheck::Proceed
        );

        // App 重启：lease_id 变了，看门狗必须放弃。
        lease::write_lease(
            &paths.lease(),
            &lease::ProxyLease::new("fake", "127.0.0.1:2080", serde_json::json!({})),
        )
        .unwrap();
        assert_eq!(
            recheck_lease(&paths.lease(), &first.lease_id),
            LeaseCheck::Changed
        );

        // 正常断开：租约被删。
        lease::remove_if_exists(&paths.lease()).unwrap();
        assert_eq!(
            recheck_lease(&paths.lease(), &first.lease_id),
            LeaseCheck::Gone
        );

        // 读不出来按「变了」处理，宁可放弃。
        std::fs::write(paths.lease(), b"not json").unwrap();
        assert_eq!(
            recheck_lease(&paths.lease(), &first.lease_id),
            LeaseCheck::Changed
        );
        let _ = std::fs::remove_dir_all(paths.dir());
    }

    #[test]
    fn a_corrupt_lease_fails_and_is_removed() {
        let paths = temp_paths("corrupt");
        std::fs::create_dir_all(paths.dir()).unwrap();
        std::fs::write(paths.lease(), b"not json").unwrap();
        let backend = Fake::new(Some("127.0.0.1:2080"), Some("corp-proxy:8080"));

        match check_once(&paths, &backend) {
            GuardStep::Finished(report) => {
                assert_eq!(report.status, RecoveryStatus::Failed);
                assert!(report.error.unwrap().contains("无法解析"));
                assert_eq!(report.current.as_deref(), Some("127.0.0.1:2080"));
            }
            other => panic!("应当是 failed，实际 {other:?}"),
        }
        assert!(!paths.lease().exists(), "坏租约必须删掉，交给下次启动");
        let _ = std::fs::remove_dir_all(paths.dir());
    }

    #[test]
    fn a_current_read_failure_keeps_the_lease() {
        let paths = temp_paths("current-failed");
        install_lease(&paths);
        let mut backend = Fake::new(Some("127.0.0.1:2080"), Some("corp-proxy:8080"));
        backend.fail_current = true;

        match check_once(&paths, &backend) {
            GuardStep::Finished(report) => {
                assert_eq!(report.status, RecoveryStatus::Failed);
                assert!(report.error.unwrap().contains("读取系统代理失败"));
            }
            other => panic!("应当是 failed，实际 {other:?}"),
        }
        assert!(paths.lease().exists(), "读不到当前值时必须保留租约");
        let _ = std::fs::remove_dir_all(paths.dir());
    }

    #[test]
    fn an_endpoint_that_survives_the_restore_is_a_failure() {
        let paths = temp_paths("still-in-use");
        install_lease(&paths);
        let mut backend = Fake::new(Some("127.0.0.1:2080"), Some("corp-proxy:8080"));
        backend.keep_endpoint_after_restore = true;

        match check_once(&paths, &backend) {
            GuardStep::Finished(report) => {
                assert_eq!(report.status, RecoveryStatus::Failed);
                assert!(report.error.unwrap().contains("仍被网络服务使用"));
                assert_eq!(report.current.as_deref(), Some("127.0.0.1:2080"));
            }
            other => panic!("应当是 failed，实际 {other:?}"),
        }
        assert!(paths.lease().exists(), "还原没生效时必须保留租约");
        let _ = std::fs::remove_dir_all(paths.dir());
    }
}
