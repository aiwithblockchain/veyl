//! Tauri 命令层（技术设计 §7）。
//!
//! 命令名与返回形状按 §7；每个命令只负责取 `AppState`、发事件，真正的逻辑在
//! 同一文件里的普通函数中，便于脱离 Tauri 测试。
//!
//! **返回值里永远不出现完整 URL 或令牌**：订阅来源只带主机名。

use std::path::{Path, PathBuf};
use std::sync::Arc;

use rand::Rng;
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::assemble::{self, ConnectParams};
use crate::error::{AppError, AppResult};
use crate::fetch::{self, FetchOutcome, MAX_BODY_BYTES};
use crate::kernel_check::{self, KernelCheck as KernelOutcome};
use crate::models::{
    KernelCheck, NodeBrief, Profile, ProfileDetail, ProfileSource, SyncState,
};
use crate::secrets::SecretStore;
use crate::state::AppState;
use crate::store::{self, Store};
use crate::subscription_url::SubscriptionUrl;

pub const EVENT_PROFILES_CHANGED: &str = "profiles-changed";
pub const EVENT_SYNC_CHANGED: &str = "sync-changed";

/// 本地文件导入的大小上限：与订阅正文同一口径。
const MAX_FILE_BYTES: u64 = MAX_BODY_BYTES as u64;
const MAX_NAME_CHARS: usize = 60;

// ---------------------------------------------------------------------------
// 纯逻辑
// ---------------------------------------------------------------------------

fn now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

fn preview_params() -> ConnectParams {
    let mut rng = rand::thread_rng();
    let port: u16 = rng.gen_range(15_000..25_000);
    let secret: String = (0..32)
        .map(|_| format!("{:x}", rng.gen_range(0..16u8)))
        .collect();
    ConnectParams {
        clash_port: port,
        clash_secret: secret,
    }
}

fn source_label(profile: &Profile) -> String {
    match &profile.source {
        ProfileSource::Subscription { host } => host.clone(),
        ProfileSource::File { path } => Path::new(path)
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_else(|| "本地文件".to_string()),
    }
}

fn validate_name(name: &str) -> AppResult<String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err(AppError::invalid("名称不能为空").with_hint("换一个名字再保存。"));
    }
    if trimmed.chars().count() > MAX_NAME_CHARS {
        return Err(AppError::invalid(format!("名称最多 {MAX_NAME_CHARS} 个字符"))
            .with_hint("缩短一点再保存。"));
    }
    Ok(trimmed.to_string())
}

struct Prepared {
    raw: serde_json::Value,
    nodes: Vec<NodeBrief>,
    kernel: KernelCheck,
}

/// 解析 → 结构校验 → 装配预览 → 内核校验。
///
/// 任一步失败都不落盘（装配预览会先写 `runtime.json`，失败时删掉）。
async fn prepare(state: &AppState, raw_text: &str, id: &str) -> AppResult<Prepared> {
    let raw = assemble::parse(raw_text)?;
    assemble::validate_structure(&raw)?;
    let nodes = assemble::nodes_of(&raw);

    if nodes.is_empty() {
        return Ok(Prepared {
            raw,
            nodes,
            kernel: KernelCheck::Unavailable,
        });
    }

    let assembled = assemble::assemble(&raw, &preview_params())?;
    state.store.write_runtime(id, &assembled.runtime)?;
    let runtime_path = state.store.runtime_path(id)?;
    let outcome = kernel_check::check(&state.data_dir, &runtime_path).await;

    if let KernelOutcome::Failed(message) = &outcome {
        let _ = state.store.remove_runtime(id);
        return Err(AppError::new("KERNEL_CHECK_FAILED", "内核不认这份配置")
            .with_reason(message.clone())
            .with_hint("重新导入一次；反复出现就回桌面端重新导出配置。"));
    }

    let kernel = match outcome {
        KernelOutcome::Passed => KernelCheck::Passed,
        _ => KernelCheck::Unavailable,
    };

    Ok(Prepared { raw, nodes, kernel })
}

fn commit(
    store: &Store,
    id: &str,
    prepared: &Prepared,
    name: String,
    source: ProfileSource,
    sync_state: SyncState,
    synced_at: Option<i64>,
    sync_error: Option<String>,
) -> AppResult<Profile> {
    let raw_text = serde_json::to_string(&prepared.raw)
        .map_err(|error| AppError::internal(format!("保存配置失败：{error}")))?;
    store.write_raw(id, &raw_text)?;

    let profile = Profile {
        id: id.to_string(),
        name,
        source,
        node_count: prepared.nodes.len(),
        last_synced_at: synced_at,
        sync_state,
        sync_error,
        created_at: now_millis(),
        kernel_check: prepared.kernel,
    };
    store.upsert(&profile)?;
    Ok(profile)
}

fn secret_set(secrets: &Arc<dyn SecretStore>, id: &str, value: &str) -> AppResult<()> {
    secrets.set(id, value).map_err(|error| {
        AppError::internal(format!("保存订阅链接失败：{error}"))
            .with_hint("重试一次；仍然失败就检查系统钥匙串/应用目录权限。")
    })
}

fn secret_get(secrets: &Arc<dyn SecretStore>, id: &str) -> AppResult<Option<String>> {
    secrets.get(id).map_err(|error| {
        AppError::internal(format!("读取订阅链接失败：{error}"))
            .with_hint("重新粘贴一次链接。")
    })
}

fn secret_delete(secrets: &Arc<dyn SecretStore>, id: &str) {
    let _ = secrets.delete(id);
}

fn fetch_error(outcome: FetchOutcome) -> AppError {
    match outcome {
        FetchOutcome::Unauthorized => AppError::new("UNAUTHORIZED", "订阅链接已失效")
            .with_reason("桌面端重新生成过令牌，旧链接不再有效")
            .with_hint("回桌面端复制新的链接，重新导入。"),
        FetchOutcome::Forbidden => AppError::new("FORBIDDEN", "账户当前不可用")
            .with_hint("回桌面端确认账户状态。"),
        FetchOutcome::RateLimited(Some(seconds)) => AppError::new(
            "RATE_LIMITED",
            format!("请求太频繁，{seconds} 秒后再试"),
        )
        .with_hint("稍等一会儿再刷新。"),
        FetchOutcome::RateLimited(None) => AppError::new("RATE_LIMITED", "请求太频繁")
            .with_hint("稍等一会儿再刷新。"),
        FetchOutcome::Failed(message) => AppError::new("SYNC_FAILED", format!("同步失败：{message}"))
            .with_hint("检查网络后重试；现有配置不受影响。"),
        FetchOutcome::Ok(_) => AppError::internal("内部状态错误"),
    }
}

// ---------------------------------------------------------------------------
// 可测试的实现
// ---------------------------------------------------------------------------

pub async fn import_url(state: &AppState, raw_url: &str) -> AppResult<Profile> {
    let url = SubscriptionUrl::parse(raw_url)?;
    let body = match fetch::fetch_profile(&state.http, &url).await {
        FetchOutcome::Ok(body) => body,
        other => return Err(fetch_error(other)),
    };

    let id = store::new_id();
    let prepared = prepare(state, &body, &id).await?;

    // 链接先写密钥存储：写不进去就不落配置——否则会留下一个永远刷不了的配置。
    secret_set(&state.secrets, &id, url.as_str())?;
    let result = commit(
        &state.store,
        &id,
        &prepared,
        url.host(),
        ProfileSource::Subscription { host: url.host() },
        SyncState::Ok,
        Some(now_millis()),
        None,
    );
    if result.is_err() {
        secret_delete(&state.secrets, &id);
    }
    result
}

pub async fn import_file(state: &AppState, path: &str) -> AppResult<Profile> {
    let path = PathBuf::from(path.trim());
    if !path.is_absolute() {
        return Err(AppError::invalid("需要一个绝对路径")
            .with_hint("重新选一次文件。"));
    }
    let metadata = std::fs::metadata(&path).map_err(|error| {
        AppError::new("FILE_UNREADABLE", format!("读不了这个文件：{error}"))
            .with_hint("确认文件还在，并且有读取权限。")
    })?;
    if !metadata.is_file() {
        return Err(AppError::invalid("选中的不是文件").with_hint("重新选一次文件。"));
    }
    if metadata.len() > MAX_FILE_BYTES {
        return Err(AppError::invalid(format!(
            "文件过大（{} 字节，上限 {MAX_FILE_BYTES}）",
            metadata.len()
        ))
        .with_hint("选一份 sing-box 配置 JSON。"));
    }

    let text = crate::fsutil::read_text(&path)?;
    let id = store::new_id();
    let prepared = prepare(state, &text, &id).await?;

    let name = path
        .file_stem()
        .map(|stem| stem.to_string_lossy().into_owned())
        .unwrap_or_else(|| "本地配置".to_string());

    let stored_path = state.store.raw_path(&id)?;
    commit(
        &state.store,
        &id,
        &prepared,
        validate_name(&name)?,
        ProfileSource::File {
            path: stored_path.to_string_lossy().into_owned(),
        },
        SyncState::Never,
        None,
        None,
    )
}

pub async fn refresh(state: &AppState, id: &str) -> AppResult<Profile> {
    let profile = state
        .store
        .get(id)?
        .ok_or_else(|| AppError::not_found("这套配置已经不存在了").with_hint("刷新列表。"))?;

    if matches!(profile.source, ProfileSource::File { .. }) {
        return Err(AppError::invalid("文件导入的配置不参与同步")
            .with_hint("要换内容就重新导入一份文件。"));
    }

    let Some(raw_url) = secret_get(&state.secrets, id)? else {
        return mark_sync(
            state,
            profile,
            SyncState::Unauthorized,
            Some("这台机器上没有这条订阅的链接，请重新粘贴导入".to_string()),
        );
    };

    let url = match SubscriptionUrl::parse(&raw_url) {
        Ok(url) => url,
        Err(error) => {
            return mark_sync(
                state,
                profile,
                SyncState::Unauthorized,
                Some(format!("{} {}", error.message, error.hint)),
            );
        }
    };

    match fetch::fetch_profile(&state.http, &url).await {
        FetchOutcome::Ok(body) => match prepare(state, &body, id).await {
            Ok(prepared) => {
                let mut updated = profile;
                let raw_text = serde_json::to_string(&prepared.raw)
                    .map_err(|error| AppError::internal(error.to_string()))?;
                state.store.write_raw(id, &raw_text)?;
                updated.node_count = prepared.nodes.len();
                updated.last_synced_at = Some(now_millis());
                updated.sync_state = SyncState::Ok;
                updated.sync_error = None;
                updated.kernel_check = prepared.kernel;
                state.store.upsert(&updated)?;
                Ok(updated)
            }
            // 新配置不可用：保留旧配置，只标记这次同步失败。
            Err(error) => mark_sync(
                state,
                profile,
                SyncState::Failed,
                Some(format!("{} {}", error.message, error.reason)),
            ),
        },
        FetchOutcome::Unauthorized => mark_sync(
            state,
            profile,
            SyncState::Unauthorized,
            Some("链接已失效，回桌面端重新复制".to_string()),
        ),
        FetchOutcome::Forbidden => mark_sync(
            state,
            profile,
            SyncState::Failed,
            Some("账户不可用".to_string()),
        ),
        FetchOutcome::RateLimited(Some(seconds)) => mark_sync(
            state,
            profile,
            SyncState::Failed,
            Some(format!("请求太频繁，{seconds} 秒后再试")),
        ),
        FetchOutcome::RateLimited(None) => mark_sync(
            state,
            profile,
            SyncState::Failed,
            Some("请求太频繁，稍后再试".to_string()),
        ),
        FetchOutcome::Failed(message) => {
            mark_sync(state, profile, SyncState::Failed, Some(message))
        }
    }
}

fn mark_sync(
    state: &AppState,
    mut profile: Profile,
    sync_state: SyncState,
    sync_error: Option<String>,
) -> AppResult<Profile> {
    profile.sync_state = sync_state;    profile.sync_error = sync_error;
    state.store.upsert(&profile)?;
    Ok(profile)
}

pub fn rename(state: &AppState, id: &str, name: &str) -> AppResult<Profile> {
    let mut profile = state
        .store
        .get(id)?
        .ok_or_else(|| AppError::not_found("这套配置已经不存在了").with_hint("刷新列表。"))?;
    profile.name = validate_name(name)?;
    state.store.upsert(&profile)?;
    Ok(profile)
}

pub fn remove(state: &AppState, id: &str) -> AppResult<()> {
    secret_delete(&state.secrets, id);
    state.store.remove(id)
}

pub fn detail(state: &AppState, id: &str) -> AppResult<ProfileDetail> {
    let profile = state
        .store
        .get(id)?
        .ok_or_else(|| AppError::not_found("这套配置已经不存在了").with_hint("刷新列表。"))?;
    let nodes = match state.store.read_raw(id)? {
        Some(text) => assemble::parse(&text)
            .map(|config| assemble::nodes_of(&config))
            .unwrap_or_default(),
        None => Vec::new(),
    };
    Ok(ProfileDetail {
        source_label: source_label(&profile),
        profile,
        nodes,
    })
}

// ---------------------------------------------------------------------------
// Tauri 命令
// ---------------------------------------------------------------------------

#[derive(Serialize, Clone)]
struct ProfilesChanged {
    active_id: Option<String>,
}

fn emit_profiles(app: &AppHandle, state: &AppState) {
    let active_id = state.store.active_id().unwrap_or(None);
    let _ = app.emit(EVENT_PROFILES_CHANGED, ProfilesChanged { active_id });
}

fn emit_sync(app: &AppHandle, profile: &Profile) {
    let _ = app.emit(EVENT_SYNC_CHANGED, profile.clone());
}

#[tauri::command]
pub fn profiles_list(state: State<'_, AppState>) -> AppResult<Vec<Profile>> {
    state.inner().store.list()
}

#[tauri::command]
pub fn profiles_active(state: State<'_, AppState>) -> AppResult<Option<String>> {
    state.inner().store.active_id()
}

#[tauri::command]
pub fn profile_select(app: AppHandle, state: State<'_, AppState>, id: String) -> AppResult<()> {
    state.inner().store.set_active(&id)?;
    emit_profiles(&app, state.inner());
    Ok(())
}

#[tauri::command]
pub async fn profile_import_url(
    app: AppHandle,
    state: State<'_, AppState>,
    url: String,
) -> AppResult<Profile> {
    let profile = import_url(state.inner(), &url).await?;
    emit_profiles(&app, state.inner());
    Ok(profile)
}

#[tauri::command]
pub async fn profile_import_file(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
) -> AppResult<Profile> {
    let profile = import_file(state.inner(), &path).await?;
    emit_profiles(&app, state.inner());
    Ok(profile)
}

#[tauri::command]
pub async fn profile_refresh(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> AppResult<Profile> {
    let profile = refresh(state.inner(), &id).await?;
    emit_sync(&app, &profile);
    Ok(profile)
}

#[tauri::command]
pub fn profile_rename(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    name: String,
) -> AppResult<Profile> {
    let profile = rename(state.inner(), &id, &name)?;
    emit_profiles(&app, state.inner());
    Ok(profile)
}

#[tauri::command]
pub fn profile_remove(app: AppHandle, state: State<'_, AppState>, id: String) -> AppResult<()> {
    remove(state.inner(), &id)?;
    emit_profiles(&app, state.inner());
    Ok(())
}

#[tauri::command]
pub fn profile_detail(state: State<'_, AppState>, id: String) -> AppResult<ProfileDetail> {
    detail(state.inner(), &id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::{TcpListener, TcpStream};
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    fn sample_config() -> serde_json::Value {
        serde_json::json!({
            "outbounds": [
                {"type": "selector", "tag": "proxy", "outbounds": ["node-a"], "default": "node-a"},
                {"type": "vless", "tag": "node-a", "server": "a.example.com", "server_port": 443},
                {"type": "direct", "tag": "direct"}
            ],
            "route": {"final": "proxy"}
        })
    }

    fn write_config(dir: &std::path::Path) -> std::path::PathBuf {
        let path = dir.join("import.json");
        std::fs::write(&path, sample_config().to_string()).unwrap();
        path
    }

    #[tokio::test]
    async fn importing_a_file_copies_it_into_private_storage() {
        let data = tempfile::tempdir().unwrap();
        let source_dir = tempfile::tempdir().unwrap();
        let source = write_config(source_dir.path());
        let state = AppState::for_tests(data.path().to_path_buf());

        let profile = import_file(&state, &source.to_string_lossy()).await.unwrap();
        assert_eq!(profile.node_count, 1);
        assert_eq!(profile.sync_state, SyncState::Never);
        assert_eq!(profile.kernel_check, KernelCheck::Unavailable);
        assert!(matches!(profile.source, ProfileSource::File { .. }));

        // 副本在应用目录里，原文件删掉也不影响。
        let copy = state.store.read_raw(&profile.id).unwrap().unwrap();
        assert!(copy.contains("node-a"));
        std::fs::remove_file(&source).unwrap();
        assert!(state.store.read_raw(&profile.id).unwrap().is_some());

        let stored_path = match &profile.source {
            ProfileSource::File { path } => path.clone(),
            _ => panic!("来源应当是文件"),
        };
        assert!(stored_path.starts_with(&data.path().to_string_lossy().to_string()));
    }

    #[tokio::test]
    async fn importing_invalid_json_leaves_nothing_behind() {
        let data = tempfile::tempdir().unwrap();
        let source_dir = tempfile::tempdir().unwrap();
        let source = source_dir.path().join("bad.json");
        std::fs::write(&source, "{not json").unwrap();
        let state = AppState::for_tests(data.path().to_path_buf());

        let error = import_file(&state, &source.to_string_lossy()).await.unwrap_err();
        assert_eq!(error.code, "CONFIG_INVALID");
        assert!(state.store.list().unwrap().is_empty());
        let leftovers: Vec<_> = std::fs::read_dir(data.path().join("profiles"))
            .unwrap()
            .filter_map(|entry| entry.ok())
            .collect();
        assert!(leftovers.is_empty(), "不该留下目录：{leftovers:?}");
    }

    #[tokio::test]
    async fn importing_a_relative_path_is_rejected() {
        let data = tempfile::tempdir().unwrap();
        let state = AppState::for_tests(data.path().to_path_buf());
        assert!(import_file(&state, "import.json").await.is_err());
    }

    #[test]
    fn names_are_trimmed_and_capped() {
        assert_eq!(validate_name("  我的订阅 ").unwrap(), "我的订阅");
        assert!(validate_name("   ").is_err());
        assert!(validate_name(&"字".repeat(61)).is_err());
        assert!(validate_name(&"字".repeat(60)).is_ok());
    }

    #[tokio::test]
    async fn file_profiles_do_not_refresh() {
        let data = tempfile::tempdir().unwrap();
        let state = AppState::for_tests(data.path().to_path_buf());
        let source_dir = tempfile::tempdir().unwrap();
        let source = write_config(source_dir.path());
        let profile = import_file(&state, &source.to_string_lossy()).await.unwrap();

        let error = refresh(&state, &profile.id).await.unwrap_err();
        assert!(error.message.contains("不参与同步"));
    }

    // ---- 订阅导入与刷新：进程内 HTTP ----

    fn serve<F>(handler: F) -> std::net::SocketAddr
    where
        F: Fn(&str) -> Vec<u8> + Send + Sync + 'static,
    {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let handler = Arc::new(handler);
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { continue };
                let request = read_request(&mut stream);
                let _ = stream.write_all(&handler(&request));
                let _ = stream.flush();
            }
        });
        addr
    }

    fn read_request(stream: &mut TcpStream) -> String {
        let mut buffer = Vec::new();
        let mut byte = [0u8; 1];
        while stream.read(&mut byte).is_ok() && byte[0] != 0 {
            buffer.push(byte[0]);
            if buffer.ends_with(b"\r\n\r\n") {
                break;
            }
        }
        String::from_utf8_lossy(&buffer).into_owned()
    }

    fn ok_json(body: &str) -> Vec<u8> {
        let out = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        out.into_bytes()
    }

    fn status(code: &str) -> Vec<u8> {
        format!("HTTP/1.1 {code}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").into_bytes()
    }

    fn token() -> String {
        format!("mp_{}", "b".repeat(43))
    }

    fn url_for(addr: std::net::SocketAddr) -> String {
        format!("http://veyl:{}@127.0.0.1:{}/v1/mobile/profile", token(), addr.port())
    }

    #[tokio::test]
    async fn importing_a_subscription_stores_the_link_but_not_in_metadata() {
        let body = sample_config().to_string();
        let addr = serve(move |_| ok_json(&body));
        let data = tempfile::tempdir().unwrap();
        let state = AppState::for_tests(data.path().to_path_buf());

        let profile = import_url(&state, &url_for(addr)).await.unwrap();
        assert_eq!(profile.node_count, 1);
        assert_eq!(profile.sync_state, SyncState::Ok);
        assert!(matches!(profile.source, ProfileSource::Subscription { .. }));

        // 密钥确实写进去了（内存实现直接读）。
        assert_eq!(
            state.secrets.get(&profile.id).unwrap().as_deref(),
            Some(url_for(addr).as_str())
        );

        let listed = serde_json::to_string(&state.store.list().unwrap()).unwrap();
        assert!(!listed.contains(&token()), "元数据里出现了令牌：{listed}");
        assert!(!listed.contains("http"), "元数据里出现了链接：{listed}");
    }

    #[tokio::test]
    async fn a_revoked_token_marks_the_profile_unauthorized() {
        let hits = Arc::new(AtomicUsize::new(0));
        let body = sample_config().to_string();
        let hits_clone = hits.clone();
        let addr = serve(move |_| {
            let count = hits_clone.fetch_add(1, Ordering::SeqCst);
            if count == 0 {
                ok_json(&body)
            } else {
                status("401 Unauthorized")
            }
        });

        let data = tempfile::tempdir().unwrap();
        let state = AppState::for_tests(data.path().to_path_buf());
        let profile = import_url(&state, &url_for(addr)).await.unwrap();

        let after = refresh(&state, &profile.id).await.unwrap();
        assert_eq!(after.sync_state, SyncState::Unauthorized);
        assert!(after.sync_error.is_some());
        // 旧配置仍在。
        assert!(state.store.read_raw(&profile.id).unwrap().is_some());
    }

    #[tokio::test]
    async fn a_failed_sync_keeps_the_old_config() {
        let body = sample_config().to_string();
        let hits = Arc::new(AtomicUsize::new(0));
        let hits_clone = hits.clone();
        let addr = serve(move |_| {
            let count = hits_clone.fetch_add(1, Ordering::SeqCst);
            if count == 0 {
                ok_json(&body)
            } else {
                status("503 Service Unavailable")
            }
        });

        let data = tempfile::tempdir().unwrap();
        let state = AppState::for_tests(data.path().to_path_buf());
        let profile = import_url(&state, &url_for(addr)).await.unwrap();

        let after = refresh(&state, &profile.id).await.unwrap();
        assert_eq!(after.sync_state, SyncState::Failed);
        assert_eq!(after.node_count, 1);
        assert!(state.store.read_raw(&profile.id).unwrap().is_some());
    }

    #[tokio::test]
    async fn detail_lists_nodes_without_their_credentials() {
        let data = tempfile::tempdir().unwrap();
        let source_dir = tempfile::tempdir().unwrap();
        let source = write_config(source_dir.path());
        let state = AppState::for_tests(data.path().to_path_buf());
        let profile = import_file(&state, &source.to_string_lossy()).await.unwrap();

        let detail = detail(&state, &profile.id).unwrap();
        assert_eq!(detail.nodes.len(), 1);
        assert_eq!(detail.nodes[0].tag, "node-a");
        let json = serde_json::to_string(&detail).unwrap();
        assert!(!json.contains("server_port"));
    }
}
