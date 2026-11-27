//! 进程内共享状态：配置存储、密钥存储、HTTP 客户端、数据目录。

use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;

use crate::connection::ConnectionManager;
use crate::error::AppResult;
use crate::secrets::{self, SecretStore};
use crate::store::Store;

/// 内核校验用的临时目录。启动时清一次：崩溃可能在里面留下含节点密码的配置。
pub const STAGING_DIR: &str = "staging";

pub struct AppState {
    pub data_dir: PathBuf,
    pub store: Store,
    pub secrets: Arc<dyn SecretStore>,
    pub http: reqwest::Client,
    pub connection: ConnectionManager,
    /// 退出流程是否已经开始：`RunEvent::ExitRequested` 会再来一次，不能重复拦。
    pub shutdown_started: AtomicBool,
}

impl AppState {
    pub fn new(data_dir: PathBuf, service: &str) -> AppResult<Self> {
        let store = Store::new(&data_dir)?;
        let _ = crate::fsutil::remove_dir_if_exists(&data_dir.join(STAGING_DIR));
        let secrets = secrets::open(&data_dir, service);
        let http = crate::fetch::client()?;
        let session = Arc::new(veyl_tun::session::TunSession::new(veyl_tun::privilege::select()));
        let connection = ConnectionManager::new(session, http.clone());
        Ok(Self {
            data_dir,
            store,
            secrets,
            http,
            connection,
            shutdown_started: AtomicBool::new(false),
        })
    }

    #[cfg(test)]
    pub fn for_tests(data_dir: PathBuf) -> Self {
        crate::tun_identity::install();
        let http = crate::fetch::client().expect("测试网络客户端可用");
        let session = Arc::new(veyl_tun::session::TunSession::new(veyl_tun::privilege::select()));
        Self {
            store: Store::new(&data_dir).expect("测试目录可写"),
            secrets: Arc::new(secrets::MemoryStore::new()),
            connection: ConnectionManager::new(session, http.clone()),
            http,
            data_dir,
            shutdown_started: AtomicBool::new(false),
        }
    }
}
