pub mod backup;

#[cfg(target_os = "macos")]
mod macos;
#[cfg(windows)]
mod windows;

use std::path::Path;

use serde::Serialize;

use crate::runtime::RuntimeResult;
use backup::{BackupStore, Endpoint, FileBackupStore, ProxyBackup};

pub use backup::{BackupStore as ProxyBackupStore, Endpoint as ProxyEndpoint, ProxyBackup as ProxyBackupSnapshot, SqliteBackupStore};

pub trait PlatformProxy: Send + Sync {
    fn platform(&self) -> &'static str;
    fn capture(&self) -> RuntimeResult<serde_json::Value>;
    fn apply(&self, port: u16) -> RuntimeResult<()>;
    fn restore(&self, payload: &serde_json::Value) -> RuntimeResult<()>;
    fn current(&self) -> RuntimeResult<Option<String>>;
}

#[cfg(target_os = "macos")]
fn backend() -> &'static dyn PlatformProxy {
    &macos::MacProxy
}

#[cfg(windows)]
fn backend() -> &'static dyn PlatformProxy {
    &windows::WindowsProxy
}

#[cfg(not(any(target_os = "macos", windows)))]
struct UnsupportedProxy;

#[cfg(not(any(target_os = "macos", windows)))]
impl PlatformProxy for UnsupportedProxy {
    fn platform(&self) -> &'static str {
        std::env::consts::OS
    }

    fn capture(&self) -> RuntimeResult<serde_json::Value> {
        Ok(serde_json::Value::Null)
    }

    fn apply(&self, _port: u16) -> RuntimeResult<()> {
        Err(crate::runtime::RuntimeError::Proxy(format!(
            "system proxy is not supported on {}",
            std::env::consts::OS
        )))
    }

    fn restore(&self, _payload: &serde_json::Value) -> RuntimeResult<()> {
        Ok(())
    }

    fn current(&self) -> RuntimeResult<Option<String>> {
        Ok(None)
    }
}

#[cfg(not(any(target_os = "macos", windows)))]
fn backend() -> &'static dyn PlatformProxy {
    &UnsupportedProxy
}

#[derive(Debug, Clone, Serialize)]
pub struct ProxyStatus {
    pub platform: String,
    pub current: Option<String>,
    pub endpoint: Option<String>,
    pub has_backup: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum RecoveryOutcome {
    Nothing,
    Recovered { endpoint: String },
    LeftAlone { current: String, endpoint: String },
}

pub struct ProxyController {
    store: Box<dyn BackupStore>,
    backend: &'static dyn PlatformProxy,
}

impl ProxyController {
    pub fn new(store: Box<dyn BackupStore>) -> Self {
        Self {
            store,
            backend: backend(),
        }
    }

    pub fn with_file_store(app_data_dir: impl AsRef<Path>) -> Self {
        Self::new(Box::new(FileBackupStore::in_app_data(app_data_dir)))
    }

    pub fn with_backend(store: Box<dyn BackupStore>, backend: &'static dyn PlatformProxy) -> Self {
        Self { store, backend }
    }

    pub fn platform(&self) -> &'static str {
        self.backend.platform()
    }

    /// 首次启用时先备份；重复调用不会覆盖原始备份。
    pub fn enable(&self, port: u16) -> RuntimeResult<()> {
        let endpoint = Endpoint::loopback(port);
        if self.store.load()?.is_none() {
            let payload = self.backend.capture()?;
            self.store.save(&ProxyBackup::new(
                self.backend.platform(),
                endpoint.clone(),
                payload,
            ))?;
        }
        self.backend.apply(port)
    }

    pub fn disable(&self) -> RuntimeResult<()> {
        let Some(backup) = self.store.load()? else {
            return Ok(());
        };
        self.backend.restore(&backup.payload)?;
        self.store.clear()
    }

    /// 启动时调用：只有当前代理仍是我们设的值才恢复，用户改过就只报告。
    pub fn recover_stale(&self) -> RuntimeResult<RecoveryOutcome> {
        let Some(backup) = self.store.load()? else {
            return Ok(RecoveryOutcome::Nothing);
        };
        let endpoint = backup.applied.to_string();

        match self.backend.current()? {
            Some(current) if current == endpoint => {
                self.backend.restore(&backup.payload)?;
                self.store.clear()?;
                Ok(RecoveryOutcome::Recovered { endpoint })
            }
            Some(current) => Ok(RecoveryOutcome::LeftAlone { current, endpoint }),
            None => {
                self.store.clear()?;
                Ok(RecoveryOutcome::Nothing)
            }
        }
    }

    pub fn status(&self) -> RuntimeResult<ProxyStatus> {
        let backup = self.store.load()?;
        Ok(ProxyStatus {
            platform: self.backend.platform().to_string(),
            current: self.backend.current()?,
            endpoint: backup.as_ref().map(|b| b.applied.to_string()),
            has_backup: backup.is_some(),
        })
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use super::*;

    struct Fake {
        current: Mutex<Option<String>>,
        applied: Mutex<Vec<u16>>,
        fail_apply: bool,
    }

    impl PlatformProxy for Fake {
        fn platform(&self) -> &'static str {
            "fake"
        }

        fn capture(&self) -> RuntimeResult<serde_json::Value> {
            Ok(serde_json::json!({ "original": self.current.lock().unwrap().clone() }))
        }

        fn apply(&self, port: u16) -> RuntimeResult<()> {
            if self.fail_apply {
                return Err(crate::runtime::RuntimeError::Proxy("denied".into()));
            }
            self.applied.lock().unwrap().push(port);
            *self.current.lock().unwrap() = Some(format!("127.0.0.1:{port}"));
            Ok(())
        }

        fn restore(&self, payload: &serde_json::Value) -> RuntimeResult<()> {
            let original = payload
                .get("original")
                .and_then(|v| v.as_str())
                .map(str::to_string);
            *self.current.lock().unwrap() = original;
            Ok(())
        }

        fn current(&self) -> RuntimeResult<Option<String>> {
            Ok(self.current.lock().unwrap().clone())
        }
    }

    fn controller(fake: &'static Fake) -> ProxyController {
        ProxyController::with_backend(Box::new(backup::MemoryBackupStore::new()), fake)
    }

    #[test]
    fn enabling_then_disabling_restores_the_original() {
        let fake = Box::leak(Box::new(Fake {
            current: Mutex::new(Some("corp-proxy:8080".into())),
            applied: Mutex::new(vec![]),
            fail_apply: false,
        }));
        let ctrl = controller(fake);

        ctrl.enable(2080).unwrap();
        assert_eq!(fake.current().unwrap().as_deref(), Some("127.0.0.1:2080"));
        assert!(ctrl.status().unwrap().has_backup);

        ctrl.disable().unwrap();
        assert_eq!(fake.current().unwrap().as_deref(), Some("corp-proxy:8080"));
        assert!(!ctrl.status().unwrap().has_backup);
    }

    #[test]
    fn enabling_twice_keeps_the_first_backup() {
        let fake = Box::leak(Box::new(Fake {
            current: Mutex::new(Some("corp-proxy:8080".into())),
            applied: Mutex::new(vec![]),
            fail_apply: false,
        }));
        let ctrl = controller(fake);

        ctrl.enable(2080).unwrap();
        ctrl.enable(2090).unwrap();
        ctrl.disable().unwrap();
        assert_eq!(fake.current().unwrap().as_deref(), Some("corp-proxy:8080"));
    }

    #[test]
    fn recovery_leaves_user_changes_alone() {
        let fake = Box::leak(Box::new(Fake {
            current: Mutex::new(Some("corp-proxy:8080".into())),
            applied: Mutex::new(vec![]),
            fail_apply: false,
        }));
        let ctrl = controller(fake);
        ctrl.enable(2080).unwrap();
        *fake.current.lock().unwrap() = Some("user-proxy:3128".into());

        let outcome = ctrl.recover_stale().unwrap();
        assert_eq!(
            outcome,
            RecoveryOutcome::LeftAlone {
                current: "user-proxy:3128".into(),
                endpoint: "127.0.0.1:2080".into()
            }
        );
        assert_eq!(fake.current().unwrap().as_deref(), Some("user-proxy:3128"));
    }

    #[test]
    fn recovery_restores_our_own_leftover() {
        let fake = Box::leak(Box::new(Fake {
            current: Mutex::new(None),
            applied: Mutex::new(vec![]),
            fail_apply: false,
        }));
        let ctrl = controller(fake);
        ctrl.enable(2080).unwrap();

        let outcome = ctrl.recover_stale().unwrap();
        assert_eq!(
            outcome,
            RecoveryOutcome::Recovered {
                endpoint: "127.0.0.1:2080".into()
            }
        );
        assert_eq!(fake.current().unwrap(), None);
    }

    #[test]
    fn a_leftover_backup_in_sqlite_is_recovered_on_startup() {
        use std::sync::Arc;

        let store = Arc::new(crate::store::Store::open_in_memory().unwrap());
        let fake = Box::leak(Box::new(Fake {
            current: Mutex::new(Some("corp-proxy:8080".into())),
            applied: Mutex::new(vec![]),
            fail_apply: false,
        }));

        let first = ProxyController::with_backend(
            Box::new(crate::proxy::SqliteBackupStore::new(Arc::clone(&store))),
            fake,
        );
        first.enable(2080).unwrap();
        assert_eq!(fake.current().unwrap().as_deref(), Some("127.0.0.1:2080"));
        // 模拟异常退出：不调用 disable，直接构造新的控制器走启动恢复。
        drop(first);

        let second = ProxyController::with_backend(
            Box::new(crate::proxy::SqliteBackupStore::new(store)),
            fake,
        );
        assert_eq!(
            second.recover_stale().unwrap(),
            RecoveryOutcome::Recovered {
                endpoint: "127.0.0.1:2080".into()
            }
        );
        assert_eq!(fake.current().unwrap().as_deref(), Some("corp-proxy:8080"));
        assert!(!second.status().unwrap().has_backup);
    }

    #[test]
    fn recovery_clears_a_backup_when_proxy_is_already_off() {
        let fake = Box::leak(Box::new(Fake {
            current: Mutex::new(None),
            applied: Mutex::new(vec![]),
            fail_apply: true,
        }));
        let ctrl = controller(fake);
        assert!(ctrl.enable(2080).is_err());
        assert_eq!(ctrl.recover_stale().unwrap(), RecoveryOutcome::Nothing);
        assert!(!ctrl.status().unwrap().has_backup);
    }
}
