//! Agent 层：会话注册表、审批路由与对前端的命令面。

pub mod app_handle;
pub mod commands;
pub mod permission_handler;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use tokio::sync::Mutex;

use crate::claurst_session::provider::DeepSeekCredentials;
use crate::claurst_session::AivpnSession;
use crate::tools::VpnToolServices;

pub struct AppState {
    pub services: Arc<dyn VpnToolServices>,
    sessions: Mutex<HashMap<String, Arc<AivpnSession>>>,
    /// request_id → session_id，用于取消。
    active_requests: parking_lot::Mutex<HashMap<String, String>>,
    credentials: parking_lot::RwLock<Option<DeepSeekCredentials>>,
    working_dir: PathBuf,
}

impl AppState {
    pub fn new(services: Arc<dyn VpnToolServices>) -> Self {
        // 环境变量优先（便于测试），否则读系统钥匙串。
        let credentials = std::env::var("DEEPSEEK_API_KEY")
            .ok()
            .filter(|key| !key.trim().is_empty())
            .or_else(|| crate::secrets::get_deepseek_key().ok().flatten())
            .map(DeepSeekCredentials::new);

        Self {
            services,
            sessions: Mutex::new(HashMap::new()),
            active_requests: parking_lot::Mutex::new(HashMap::new()),
            credentials: parking_lot::RwLock::new(credentials),
            working_dir: working_dir(),
        }
    }

    pub fn set_credentials(&self, credentials: DeepSeekCredentials) {
        *self.credentials.write() = Some(credentials);
    }

    pub fn has_credentials(&self) -> bool {
        self.credentials.read().is_some()
    }

    pub async fn existing(&self, session_id: &str) -> Option<Arc<AivpnSession>> {
        self.sessions.lock().await.get(session_id).cloned()
    }

    pub async fn session(&self, session_id: &str) -> anyhow::Result<Arc<AivpnSession>> {
        let mut sessions = self.sessions.lock().await;
        if let Some(existing) = sessions.get(session_id) {
            return Ok(Arc::clone(existing));
        }

        let credentials = self
            .credentials
            .read()
            .clone()
            .ok_or_else(|| anyhow::anyhow!("还没有配置 DeepSeek API Key"))?;

        let session = AivpnSession::new(
            session_id.to_string(),
            &credentials,
            Arc::clone(&self.services),
            self.working_dir.clone(),
        )?;

        sessions.insert(session_id.to_string(), Arc::clone(&session));
        Ok(session)
    }

    pub fn track_request(&self, request_id: &str, session_id: &str) {
        self.active_requests
            .lock()
            .insert(request_id.to_string(), session_id.to_string());
    }

    pub fn untrack_request(&self, request_id: &str) {
        self.active_requests.lock().remove(request_id);
    }

    /// 取消时由 request_id 找回会话；找不到说明这一轮已经结束。
    pub async fn session_for_request(&self, request_id: &str) -> Option<Arc<AivpnSession>> {
        let session_id = self.active_requests.lock().get(request_id).cloned()?;
        self.existing(&session_id).await
    }

    /// 新会话或删除会话时清掉该会话的审批授权（契约 §2.2）。
    pub async fn drop_session(&self, session_id: &str) {
        self.sessions.lock().await.remove(session_id);
        crate::tools::policy::clear_session(session_id);
    }

    pub fn next_request_id() -> String {
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|elapsed| elapsed.as_nanos())
            .unwrap_or(0);
        let seq = COUNTER.fetch_add(1, Ordering::Relaxed);
        format!("req_{nanos:x}_{seq}")
    }
}

/// 会话工作目录：P1 W1 先用用户主目录下的 `.veyl/sessions`，W3 起改用平台数据目录。
fn working_dir() -> PathBuf {
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map(PathBuf::from)
        .unwrap_or_else(|_| std::env::temp_dir());

    let dir = home.join(".veyl").join("sessions");
    let _ = std::fs::create_dir_all(&dir);
    dir
}
