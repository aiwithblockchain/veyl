//! Agent 层：会话注册表与对前端的命令面。

pub mod app_handle;
pub mod commands;
pub mod permission_handler;
pub mod questions;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, OnceLock, Weak};

use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;

use crate::claurst_session::provider::LlmCredentials;
use crate::claurst_session::AivpnSession;
use crate::tools::VpnToolServices;

pub struct AppState {
    pub services: Arc<dyn VpnToolServices>,
    sessions: Mutex<HashMap<String, SessionEntry>>,
    /// request_id → session_id，用于占用会话槽与删除前检查。
    active_requests: parking_lot::Mutex<HashMap<String, String>>,
    /// request_id → 取消令牌。令牌不挂在会话实例上：切 provider 会重建会话，
    /// 但取消必须始终能找到正在跑的那一轮。
    request_cancels: parking_lot::Mutex<HashMap<String, CancellationToken>>,
    credentials: parking_lot::RwLock<Option<LlmCredentials>>,
    /// 凭据每变一次 +1；已经建好的会话拿着旧凭据，下次取用时按代数重建。
    credential_generation: AtomicU64,
    working_dir: PathBuf,
}

struct SessionEntry {
    generation: u64,
    session: Arc<AivpnSession>,
}

/// 进程级句柄：工具路径（`tools::services`）拿不到 `AppState`，通过它热更新凭据。
static APP_STATE: OnceLock<Weak<AppState>> = OnceLock::new();

pub fn install_app_state(state: &Arc<AppState>) {
    let _ = APP_STATE.set(Arc::downgrade(state));
}

/// 保存/清除 Key 后统一从这里更新内存凭据。
pub fn update_credentials(api_key: Option<String>) {
    if let Some(state) = APP_STATE.get().and_then(|weak| weak.upgrade()) {
        state.apply_credentials(api_key);
    }
}

impl AppState {
    pub fn new(services: Arc<dyn VpnToolServices>) -> Self {
        Self::build(services, load_initial_credentials())
    }

    /// 测试用：完全不碰系统钥匙串。
    /// `cargo test` 里如果读钥匙串，macOS 会每次弹授权框。
    pub fn new_without_keychain(services: Arc<dyn VpnToolServices>) -> Self {
        Self::build(services, None)
    }

    fn build(
        services: Arc<dyn VpnToolServices>,
        credentials: Option<LlmCredentials>,
    ) -> Self {
        Self {
            services,
            credential_generation: AtomicU64::new(0),
            sessions: Mutex::new(HashMap::new()),
            active_requests: parking_lot::Mutex::new(HashMap::new()),
            request_cancels: parking_lot::Mutex::new(HashMap::new()),
            credentials: parking_lot::RwLock::new(credentials),
            working_dir: working_dir(),
        }
    }

    /// 保存或清除 DeepSeek Key 后更新内存凭据（兼容旧入口）。
    /// 注意：只有在当前 active provider 是 DeepSeek 时才应调用；否则用 `refresh_credentials`。
    pub fn apply_credentials(&self, api_key: Option<String>) {
        let credentials = api_key
            .map(|key| key.trim().to_string())
            .filter(|key| !key.is_empty())
            .map(LlmCredentials::deepseek);
        self.apply_provider(credentials);
    }

    /// 切换当前 provider 后更新内存凭据；不打断进行中的请求（下次建会话生效）。
    pub fn apply_provider(&self, credentials: Option<LlmCredentials>) {
        *self.credentials.write() = credentials;
        self.credential_generation.fetch_add(1, Ordering::SeqCst);
    }

    pub fn has_credentials(&self) -> bool {
        self.credentials.read().is_some()
    }

    /// 设置页展示用；只返回掩码。
    pub fn masked_key(&self) -> Option<String> {
        self.credentials
            .read()
            .as_ref()
            .map(|credentials| crate::secrets::mask(&credentials.api_key))
    }

    pub async fn existing(&self, session_id: &str) -> Option<Arc<AivpnSession>> {
        self.sessions
            .lock()
            .await
            .get(session_id)
            .map(|entry| Arc::clone(&entry.session))
    }

    pub async fn session(&self, session_id: &str) -> anyhow::Result<Arc<AivpnSession>> {
        let mut sessions = self.sessions.lock().await;
        let generation = self.credential_generation.load(Ordering::SeqCst);

        if let Some(entry) = sessions.get(session_id) {
            if entry.generation == generation {
                return Ok(Arc::clone(&entry.session));
            }
            // 凭据换过了：丢掉旧会话，下面用新 Key 重建。
            sessions.remove(session_id);
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

        sessions.insert(
            session_id.to_string(),
            SessionEntry {
                generation,
                session: Arc::clone(&session),
            },
        );
        Ok(session)
    }

    /// 占住会话的请求槽并创建取消令牌。同一会话已有请求在跑时返回它的
    /// request_id，不覆盖、不排队；调用方据此拒绝这次发送。
    ///
    /// 令牌在占槽时就建好并存进 `AppState`：spawn 之前、切 provider 重建
    /// 会话之后，`ai_cancel` 都能直接找到它。
    pub fn reserve_request(
        &self,
        request_id: &str,
        session_id: &str,
    ) -> Result<CancellationToken, String> {
        let mut active = self.active_requests.lock();
        if let Some((existing, _)) = active
            .iter()
            .find(|(_, value)| value.as_str() == session_id)
        {
            return Err(existing.clone());
        }
        active.insert(request_id.to_string(), session_id.to_string());
        let token = CancellationToken::new();
        self.request_cancels
            .lock()
            .insert(request_id.to_string(), token.clone());
        Ok(token)
    }

    /// 只取消指定请求；已结束或不存在返回 false，不误伤别的请求。
    pub fn cancel_request(&self, request_id: &str) -> bool {
        let cancels = self.request_cancels.lock();
        match cancels.get(request_id) {
            Some(token) => {
                token.cancel();
                true
            }
            None => false,
        }
    }

    /// 释放会话槽与取消令牌。幂等；RAII guard 的 Drop 会调它。
    pub fn finish_request(&self, request_id: &str) {
        self.active_requests.lock().remove(request_id);
        self.request_cancels.lock().remove(request_id);
    }

    /// 该会话是否还有进行中的 AI 请求（删除会话前必须为空）。
    pub fn has_active_request_for_session(&self, session_id: &str) -> bool {
        self.active_requests
            .lock()
            .values()
            .any(|value| value == session_id)
    }

    pub async fn drop_session(&self, session_id: &str) {
        self.sessions.lock().await.remove(session_id);
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

/// 启动时取一次凭据：环境变量优先（便于测试），否则读系统钥匙串。
fn load_initial_credentials() -> Option<LlmCredentials> {
    if let Some(key) = std::env::var("DEEPSEEK_API_KEY")
        .ok()
        .filter(|key| !key.trim().is_empty())
    {
        return Some(LlmCredentials::deepseek(key));
    }
    crate::store::global().and_then(|store| crate::llm::credentials(store))
}

/// 切 provider / 改 Key 后，从 settings 重新解析当前凭据。
pub fn refresh_credentials() {
    let Some(state) = APP_STATE.get().and_then(|weak| weak.upgrade()) else {
        return;
    };
    let credentials = crate::store::global().and_then(|store| crate::llm::credentials(store));
    state.apply_provider(credentials);
}

/// 只有改动的是当前 provider 时才重建凭据，避免无关改动丢掉会话上下文。
pub fn refresh_credentials_if_active(provider_id: &str) {
    let active = crate::store::global().and_then(|store| crate::llm::active_id(store));
    if active.as_deref() == Some(provider_id) {
        refresh_credentials();
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tools::NotWiredServices;

    fn app_state() -> Arc<AppState> {
        Arc::new(AppState::new_without_keychain(Arc::new(NotWiredServices)))
    }

    #[test]
    fn saving_a_key_updates_memory_immediately() {
        let state = app_state();
        state.apply_credentials(Some(" sk-abcdefgh1234 ".into()));
        assert!(state.has_credentials());
        assert_eq!(state.masked_key().as_deref(), Some("sk-****1234"));
    }

    #[test]
    fn clearing_a_key_empties_memory() {
        let state = app_state();
        state.apply_credentials(Some("sk-abcdefgh1234".into()));
        state.apply_credentials(None);
        assert!(!state.has_credentials());
        assert!(state.masked_key().is_none());
    }

    #[test]
    fn a_blank_key_counts_as_cleared() {
        let state = app_state();
        state.apply_credentials(Some("sk-abcdefgh1234".into()));
        state.apply_credentials(Some("   ".into()));
        assert!(!state.has_credentials());
    }

    #[tokio::test]
    async fn changing_the_key_rebuilds_the_session() {
        let state = app_state();
        state.apply_credentials(Some("sk-first-key-1111".into()));
        let first = state.session("ses_hot_reload").await.unwrap();

        state.apply_credentials(Some("sk-second-key-2222".into()));
        let second = state.session("ses_hot_reload").await.unwrap();

        assert!(
            !Arc::ptr_eq(&first, &second),
            "换 Key 后必须重建会话，否则对话仍用旧 Key"
        );
    }

    #[tokio::test]
    async fn sessions_survive_an_unchanged_key() {
        let state = app_state();
        state.apply_credentials(Some("sk-stable-key-3333".into()));
        let first = state.session("ses_stable").await.unwrap();
        let second = state.session("ses_stable").await.unwrap();
        assert!(Arc::ptr_eq(&first, &second), "Key 没变就不该重建会话");
    }
}
