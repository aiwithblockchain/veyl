//! 种子：拉取、解析、加密缓存与按内容哈希检测更新。
//!
//! 客户端只消费 `veyl_seed.json`（只含节点，不含分流）。种子原文含节点密码，
//! 因此整包加密存放在 `secrets.enc` 的 `seed:<content_sha256>`；SQLite 只保存
//! 哈希、etag、节点数与时间戳。
//!
//! 更新判据是**内容哈希**，不是 `version` 字段。
//! 拉取失败永远不清空缓存，也不返回致命错误：离线是正常场景。

use std::collections::{HashMap, HashSet};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use rusqlite::Connection;

use crate::nodes;
use crate::public_http;
use crate::store::{self, configs, seed_cache, Store};

pub const DEFAULT_SEED_URL: &str = "https://veyl.dessage.xyz/v1/seed";
pub const SEED_ID: &str = "veyl_seed";
pub const REFRESH_INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);
const MAX_SEED_BYTES: usize = 1024 * 1024;

/// 同一时刻只允许一个刷新请求在飞，避免并发写坏缓存。
static REFRESH_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[derive(Clone, Serialize, Deserialize)]
pub struct SeedNode {
    pub name: String,
    pub server: String,
    pub port: u16,
    pub method: String,
    #[serde(skip_serializing)]
    pub password: String,
}

impl std::fmt::Debug for SeedNode {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SeedNode")
            .field("name", &self.name)
            .field("server", &self.server)
            .field("port", &self.port)
            .field("method", &self.method)
            .field("password", &"<redacted>")
            .finish()
    }
}

#[derive(Debug, Deserialize)]
struct SeedFile {
    #[serde(default)]
    version: Option<i64>,
    #[serde(default)]
    updated_at: Option<String>,
    #[serde(default)]
    nodes: Vec<RawNode>,
}

#[derive(Debug, Deserialize)]
struct RawNode {
    #[serde(default)]
    name: String,
    #[serde(default)]
    server: String,
    #[serde(default)]
    port: u16,
    #[serde(default)]
    method: String,
    #[serde(default)]
    password: String,
}

#[derive(Debug, Clone)]
pub struct ParsedSeed {
    pub version: Option<i64>,
    pub source_updated_at: Option<String>,
    pub nodes: Vec<SeedNode>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RefreshOutcome {
    Updated {
        node_count: i64,
        added: Option<i64>,
        removed: Option<i64>,
        removed_node_name: Option<String>,
        replacement_node_name: Option<String>,
    },
    /// 304 或内容哈希未变。`node_count` 为缓存里的数量。
    Unchanged {
        node_count: i64,
    },
    /// 拉取或解析失败；缓存原样保留。
    Offline {
        cached: bool,
        error: String,
        reason: OfflineReason,
    },
    /// 试用已到期：没有联网，也没有改动任何缓存（`trial-seed-expiry.md` §3.2）。
    TrialExpired,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OfflineReason {
    Offline,
    InvalidContent,
    /// 本地写入失败（钥匙串、磁盘、数据库）；不是节点内容的问题。
    LocalWrite,
}

impl OfflineReason {
    pub fn as_str(self) -> &'static str {
        match self {
            OfflineReason::Offline => "offline",
            OfflineReason::InvalidContent => "invalid_content",
            OfflineReason::LocalWrite => "local_write",
        }
    }
}

/// 测试与本地调试可用 `VEYL_SEED_URL` 覆盖；**release 构建忽略它**，只认固定地址。
pub fn source_url() -> String {
    #[cfg(debug_assertions)]
    if let Ok(value) = std::env::var("VEYL_SEED_URL") {
        let value = value.trim().to_string();
        if !value.is_empty() {
            return value;
        }
    }
    DEFAULT_SEED_URL.to_string()
}

pub fn content_sha256(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hex::encode(hasher.finalize())
}

pub(crate) fn secret_key(hash: &str) -> String {
    format!("seed:{hash}")
}

pub fn parse_seed(bytes: &[u8]) -> Result<ParsedSeed, String> {
    let file: SeedFile =
        serde_json::from_slice(bytes).map_err(|error| format!("种子文件不是合法 JSON：{error}"))?;
    if file.nodes.is_empty() {
        return Err("种子文件没有节点".into());
    }

    let mut nodes = Vec::new();
    for raw in file.nodes {
        match validate_seed_node(raw) {
            Ok(node) => nodes.push(node),
            Err(reason) => log::warn!("种子节点被跳过：{reason}"),
        }
    }
    if nodes.is_empty() {
        return Err("种子文件没有可用的 Shadowsocks 节点".into());
    }

    Ok(ParsedSeed {
        version: file.version,
        source_updated_at: file.updated_at,
        nodes,
    })
}

fn validate_seed_node(raw: RawNode) -> Result<SeedNode, String> {
    let server = raw.server.trim();
    if server.is_empty() || server.len() > 253 {
        return Err("服务器地址不合法".into());
    }
    if server.contains("://")
        || server
            .chars()
            .any(|c| c.is_whitespace() || c == '/' || c == '\\' || c.is_control())
    {
        return Err("服务器地址包含非法字符".into());
    }
    if raw.port == 0 {
        return Err("端口不在 1-65535 之间".into());
    }

    let method = raw.method.trim().to_ascii_lowercase();
    if !nodes::SUPPORTED_METHODS.contains(&method.as_str()) {
        return Err(format!("不支持的加密方式：{method}"));
    }
    if raw.password.trim().is_empty() {
        return Err("缺少密码".into());
    }

    let name = if raw.name.trim().is_empty() {
        format!("{server}:{}", raw.port)
    } else {
        raw.name.trim().to_string()
    };

    Ok(SeedNode {
        name,
        server: server.to_string(),
        port: raw.port,
        method,
        password: raw.password,
    })
}

/// 读取当前缓存里的节点（解密后）。没有缓存或缓存损坏时返回 None。
pub fn load_nodes(store: &Store) -> Option<Vec<SeedNode>> {
    let conn = store.conn();
    load_nodes_with(&conn)
}

/// 同 [`load_nodes`]，但复用调用方已经持有的连接。
///
/// 服务层要把「判定 + 物化」放进同一个连接守卫，不能在中途再抢 store 锁。
pub fn load_nodes_with(conn: &Connection) -> Option<Vec<SeedNode>> {
    let row = seed_cache::load(conn).ok().flatten()?;
    let raw = crate::secrets::get_secret(&secret_key(&row.content_sha256))
        .ok()
        .flatten()?;
    parse_seed(raw.as_bytes()).ok().map(|parsed| parsed.nodes)
}

/// 拉取并应用种子。`running` 为真且内容变化时只标记「有新版本」，不碰在线连接。
///
/// **只有主源**：失败或内容不合法且本地无缓存才 `Offline`，**绝不清理已有缓存**。
pub async fn refresh(store: &Store, running: bool, force: bool) -> RefreshOutcome {
    let sources = vec![source_url()];
    refresh_with(store, running, force, sources, |url, etag| {
        let url = url.to_string();
        async move { public_http::get(&url, etag.as_deref(), MAX_SEED_BYTES).await }
    })
    .await
}

/// 同 [`refresh`]，但把「源列表」与「发请求」抽出来，测试可以注入假的响应。
async fn refresh_with<F, Fut>(
    store: &Store,
    running: bool,
    force: bool,
    sources: Vec<String>,
    fetch: F,
) -> RefreshOutcome
where
    F: Fn(&str, Option<String>) -> Fut,
    Fut: std::future::Future<Output = Result<crate::public_http::PublicResponse, String>>,
{
    let _guard = REFRESH_LOCK.lock().await;

    // 判定点 1：入口。读过缓存、发过请求之前就挡住，不联网也不写库。
    {
        let conn = store.conn();
        if crate::trial::ensure_seed_trial_active(&conn).is_err() {
            log::info!("试用已过期，跳过种子刷新");
            return RefreshOutcome::TrialExpired;
        }
    }

    let current = {
        let conn = store.conn();
        seed_cache::load(&conn).ok().flatten()
    };
    let now = store::now_ms();

    // **DB 里有行不等于内容还在。** 种子原文加密存在 `secrets.enc` 里，
    // 文件丢失、换加密密钥、只恢复了数据库，都会留下「元数据在、内容没了」。
    // 这种情况下任何「内容没变」的判定都是错的。
    let content_ok = cached_content_available(store);

    if !force && content_ok {
        if let Some(row) = &current {
            if now.saturating_sub(row.checked_at) < REFRESH_INTERVAL.as_millis() as i64 {
                return RefreshOutcome::Unchanged {
                    node_count: row.node_count,
                };
            }
        }
    }

    let mut last_error = String::new();
    let mut last_reason = OfflineReason::Offline;

    for source in &sources {
        // ETag 只发给产出它的来源：当前只有主源，判断保留是为了多源时不会误用。
        let etag = current
            .as_ref()
            .filter(|row| row.etag_source.as_deref() == Some(source.as_str()))
            .and_then(|row| row.etag.clone());
        let sent_etag = etag.is_some();

        let mut response = match fetch(source, etag).await {
            Ok(response) => response,
            Err(error) => {
                log::warn!("种子拉取失败 source={source}，尝试下一个源：{error}");
                last_error = error;
                last_reason = OfflineReason::Offline;
                continue;
            }
        };

        if needs_refetch(response.status, content_ok) {
            // 304 没有 body，而本地内容已经丢了——不带 etag 重拉一次。
            log::warn!("种子元数据还在但内容已丢失，强制重新拉取 source={source}");
            response = match fetch(source, None).await {
                Ok(response) => response,
                Err(error) => {
                    log::warn!("种子重新拉取失败 source={source}，尝试下一个源：{error}");
                    last_error = error;
                    last_reason = OfflineReason::Offline;
                    continue;
                }
            };
        }

        // 判定点 2：拿到响应后。必须在 needs_refetch 的重拉之后、304 / 200
        // 分支之前——两处都会续命 `checked_at` 或写新内容。
        {
            let conn = store.conn();
            if crate::trial::ensure_seed_trial_active(&conn).is_err() {
                log::info!("试用已过期，种子响应不落库");
                return RefreshOutcome::TrialExpired;
            }
        }

        if response.status == 304 {
            if !sent_etag || !cached_content_available(store) {
                // 没发 ETag 却收到 304（或重拉仍是 304）：内容拿不回来。
                // 不更新 `checked_at`——续命时间戳等于把「坏掉」的状态一直藏下去。
                log::warn!("种子源 {source} 返回 304 但本地内容不可用");
                last_error = "种子元数据还在但内容缺失，远端未返回内容".into();
                last_reason = OfflineReason::Offline;
                continue;
            }
            let conn = store.conn();
            let _ = seed_cache::touch(&conn, now, response.etag.as_deref(), Some(source));
            return RefreshOutcome::Unchanged {
                node_count: current.as_ref().map(|row| row.node_count).unwrap_or(0),
            };
        }

        if response.status != 200 {
            log::warn!("种子源 {source} 返回 HTTP {}，尝试下一个源", response.status);
            last_error = format!("种子源返回 HTTP {}", response.status);
            last_reason = OfflineReason::Offline;
            continue;
        }

        // 正文不合法或没有可用节点。
        if let Err(error) = parse_seed(&response.body) {
            log::warn!("种子源 {source} 内容不可用：{error}");
            last_error = error;
            last_reason = OfflineReason::InvalidContent;
            continue;
        }

        return apply_fetch(store, current.as_ref(), response, now, running, source).await;
    }

    if last_error.is_empty() {
        last_error = "没有可用的种子源".into();
    }
    log::warn!("种子源失败，保留缓存：{last_error}");
    RefreshOutcome::Offline {
        cached: cached_content_available(store),
        error: last_error,
        reason: last_reason,
    }
}

/// 304 且本地内容已丢时必须不带 ETag 重拉一次：304 没有 body，
/// 拿不到内容就补不回来。
fn needs_refetch(status: u16, content_ok: bool) -> bool {
    status == 304 && !content_ok
}

/// 本地缓存的内容是不是真的还能解出来。
fn cached_content_available(store: &Store) -> bool {
    load_nodes(store).is_some()
}

/// 把一次 200 响应落库。
///
/// **哈希相同但本地内容不在时不能算 `Unchanged`**——那种情况要接着往下
/// 重新写入密文，否则 `secrets.enc` 一旦丢失，种子节点永远补不回来。
async fn apply_fetch(
    store: &Store,
    current: Option<&seed_cache::SeedCacheRow>,
    response: crate::public_http::PublicResponse,
    now: i64,
    running: bool,
    source: &str,
) -> RefreshOutcome {

    let hash = content_sha256(&response.body);
    let parsed = match parse_seed(&response.body) {
        Ok(parsed) => parsed,
        Err(error) => {
            log::warn!("种子校验失败，保留缓存：{error}");
            return RefreshOutcome::Offline {
                cached: cached_content_available(store),
                error,
                reason: OfflineReason::InvalidContent,
            };
        }
    };
    let node_count = parsed.nodes.len() as i64;

    if let Some(row) = current {
        if row.content_sha256 == hash && cached_content_available(store) {
            let conn = store.conn();
            // 内容没变的「心跳」路径也续命 `checked_at`：判定放在 touch 之前，
            // 过期时连时间戳都不推进。
            if crate::trial::ensure_seed_trial_active(&conn).is_err() {
                log::info!("试用已过期，不续命种子检查时间");
                return RefreshOutcome::TrialExpired;
            }
            let _ = seed_cache::touch(&conn, now, response.etag.as_deref(), Some(source));
            return RefreshOutcome::Unchanged {
                node_count: row.node_count,
            };
        }
        if row.content_sha256 == hash {
            log::warn!("种子哈希未变但本地内容缺失，正在重建密文");
        }
    }

    // 先写密文再写元数据：元数据指向的哈希必须已经能解出原文。
    let raw = String::from_utf8_lossy(&response.body).into_owned();
    if let Err(error) = crate::secrets::set_secret(&secret_key(&hash), &raw) {
        log::warn!("种子缓存写入失败，保留旧缓存：{error}");
        return RefreshOutcome::Offline {
            cached: cached_content_available(store),
            error: format!("保存种子缓存失败：{error}"),
            reason: OfflineReason::LocalWrite,
        };
    }

    let sync = match sync_seed_nodes(store, &parsed.nodes) {
        Ok(sync) => sync,
        Err(SyncSeedError::TrialExpired) => {
            // 刚写进 `secrets.enc` 的这份内容没人用了：删掉，旧密文与缓存元数据不动。
            let _ = crate::secrets::delete_secret(&secret_key(&hash));
            log::info!("试用已过期，种子内容不落库");
            return RefreshOutcome::TrialExpired;
        }
        Err(SyncSeedError::Local(error)) => {
            // 整体回滚，且**不写新哈希**：下一次刷新（含 force）还能再来一次。
            log::warn!("种子节点同步失败，整批回滚并保留旧缓存：{error}");
            return RefreshOutcome::Offline {
                cached: cached_content_available(store),
                error: format!("保存 Veyl 免费节点失败：{error}"),
                reason: OfflineReason::LocalWrite,
            };
        }
    };
    let changed_ids = sync.changed_ids.clone();

    let row = seed_cache::SeedCacheRow {
        content_sha256: hash.clone(),
        etag: response.etag.clone(),
        etag_source: Some(source.to_string()),
        source_version: parsed.version.map(|value| value.to_string()),
        source_updated_at: parsed.source_updated_at.clone(),
        node_count,
        fetched_at: now,
        checked_at: now,
    };
    {
        let conn = store.conn();
        // 元数据也必须在同一个守卫里复查：`sync_seed_nodes` 提交之后、这里之前，
        // 到期清理可能刚删光种子行与缓存；这时再写回一行缓存会让「过期 + 有缓存」复活。
        if crate::trial::ensure_seed_trial_active(&conn).is_err() {
            drop(conn);
            let _ = crate::secrets::delete_secret(&secret_key(&hash));
            log::info!("试用已过期，种子元数据不落库");
            return RefreshOutcome::TrialExpired;
        }
        if let Err(error) = seed_cache::save(&conn, &row) {
            drop(conn);
            log::warn!("种子元数据写入失败：{error}");
            return RefreshOutcome::Offline {
                cached: cached_content_available(store),
                error: error.to_string(),
                reason: OfflineReason::LocalWrite,
            };
        }
    }

    // 只保留最新一份原文密文。
    if let Some(previous) = &current {
        if previous.content_sha256 != hash {
            let _ = crate::secrets::delete_secret(&secret_key(&previous.content_sha256));
        }
    }

    crate::agent::app_handle::emit(
        "default-profile-updated",
        json!({
            "contract_version": crate::runtime::EVENT_CONTRACT_VERSION,
            "seed_id": SEED_ID,
            "content_sha256": hash,
            "version": row.source_version,
            "node_count": node_count,
            "new_version_available": running,
            "applied_at": now,
            "emitted_at": chrono::Utc::now()
                .to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
        }),
    );
    if !changed_ids.is_empty() {
        emit_node_list_changed(store, "seed_refreshed", None, &changed_ids);
    }
    log::info!("种子已更新：{node_count} 个节点");

    RefreshOutcome::Updated {
        node_count,
        added: sync.added,
        removed: sync.removed,
        removed_node_name: sync.removed_node_name,
        replacement_node_name: sync.replacement_node_name,
    }
}

/// 让已物化的种子节点层跟随新种子：按 `source_key` upsert，删掉新种子里没有的。
///
/// 从未创建过 seed 配置时不物化任何节点——没被用过的种子不该出现在节点池里。
/// 新增节点会自动绑到「已经在引用种子节点」的配置上；用户移除过的节点由
/// `seed_node_exclusions` 跳过，不自动复活。
struct SeedSync {
    added: Option<i64>,
    removed: Option<i64>,
    changed_ids: Vec<String>,
    removed_node_name: Option<String>,
    replacement_node_name: Option<String>,
}

/// 同步失败的两种性质：试用到期必须原样上报，其余按本地写入失败处理。
#[derive(Debug)]
enum SyncSeedError {
    TrialExpired,
    Local(String),
}

impl std::fmt::Display for SyncSeedError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SyncSeedError::TrialExpired => f.write_str(crate::trial::SEED_TRIAL_EXPIRED_MESSAGE),
            SyncSeedError::Local(error) => f.write_str(error),
        }
    }
}

fn sync_seed_nodes(store: &Store, seed_nodes: &[SeedNode]) -> Result<SeedSync, SyncSeedError> {
    // 判定点 3：最终判定。判定与写入区间只持这一把守卫，到期事务插不进来；
    // 早退分支同样在判定之后。
    let conn = store.conn();
    crate::trial::ensure_seed_trial_active(&conn).map_err(|_| SyncSeedError::TrialExpired)?;

    let local = |error: store::error::StoreError| SyncSeedError::Local(error.to_string());
    let existing = configs::list_nodes_by_source(&conn, configs::SOURCE_SEED).map_err(local)?;
    let exclusions = configs::seed_exclusions(&conn).map_err(local)?;
    let following_configs = configs::config_ids_with_seed_nodes(&conn).map_err(local)?;
    if existing.is_empty() {
        return Ok(SeedSync {
            added: Some(0),
            removed: Some(0),
            changed_ids: Vec::new(),
            removed_node_name: None,
            replacement_node_name: None,
        });
    }

    let existing_names: HashMap<String, String> = existing
        .iter()
        .map(|node| (node.id.clone(), node.name.clone()))
        .collect();
    let mut added = 0;
    let mut removed = 0;
    let mut keep = HashSet::new();
    let mut changed = Vec::new();
    // 先记下刷新前每套配置的当前节点：删除节点时外键可能已把它置空，
    // 事后就再也说不出「原来的 X 已下架」了。
    let previous_current: HashMap<String, String> = following_configs
        .iter()
        .filter_map(|config_id| {
            configs::get(&conn, config_id)
                .ok()
                .flatten()
                .and_then(|config| config.current_node_id)
                .map(|node_id| (config_id.clone(), node_id))
        })
        .collect();
    let active_id = configs::active(&conn)
        .ok()
        .flatten()
        .map(|config| config.id);

    // 整层替换必须原子：任何一步失败都回滚，不能留下「部分新增、部分删除」。
    let tx = conn
        .unchecked_transaction()
        .map_err(|error| SyncSeedError::Local(error.to_string()))?;

    for node in seed_nodes {
        let key = nodes::source_key(&node.name, &node.server, node.port, &node.method);
        if exclusions.contains(&key) {
            continue;
        }
        let id = nodes::node_id(configs::SOURCE_SEED, &key);
        let reference = nodes::password_ref(&id);
        crate::secrets::set_secret(&reference, &node.password)
            .map_err(|error| SyncSeedError::Local(error.to_string()))?;
        configs::upsert_node(
            &tx,
            &configs::NewNode {
                id: &id,
                name: &node.name,
                server: &node.server,
                port: node.port,
                method: &node.method,
                password_ref: &reference,
                source: configs::SOURCE_SEED,
                source_key: &key,
            },
        )
        .map_err(local)?;
        for config_id in &following_configs {
            configs::attach_node(&tx, config_id, &id).map_err(local)?;
        }
        if !existing.iter().any(|row| row.id == id) {
            added += 1;
            changed.push(id.clone());
        }
        keep.insert(id);
    }

    for row in existing {
        if exclusions.contains(&row.source_key) {
            // 用户移除过的节点：不复活，但也不因为「不在新种子」而被误删。
            keep.insert(row.id.clone());
            continue;
        }
        if !keep.contains(&row.id) {
            configs::delete_node(&tx, &row.id).map_err(local)?;
            let _ = crate::secrets::delete_secret(&row.password_ref);
            removed += 1;
            changed.push(row.id);
        }
    }

    // 当前节点被下架：落到剩余列表的第一个；剩余为空才置 null。
    // 必须让界面知道「原来的 X 已下架，已切换到 Y」，不能静默替换。
    let (mut removed_node_name, mut replacement_node_name) = (None, None);
    let mut affected: Vec<String> = following_configs.clone();
    if let Some(active) = active_id.as_ref() {
        affected.sort_by_key(|id| id != active);
    }
    let mut updated_configs = Vec::new();
    for config_id in &affected {
        let nodes = configs::list_nodes(&tx, config_id).unwrap_or_default();
        let Some(current) = previous_current.get(config_id).cloned() else {
            continue;
        };
        if nodes.iter().any(|node| node.id == current) {
            continue;
        }

        let removed_name = existing_names.get(&current).cloned();
        let replacement = nodes.first().cloned();
        let new_current = replacement.as_ref().map(|node| node.id.clone());
        configs::update(
            &tx,
            config_id,
            &configs::ConfigPatch {
                current_node_id: Some(new_current),
                ..Default::default()
            },
        )
        .map_err(local)?;
        if removed_node_name.is_none() {
            removed_node_name = removed_name;
            replacement_node_name = replacement.as_ref().map(|node| node.name.clone());
        }
        updated_configs.push(config_id.clone());
    }

    tx.commit()
        .map_err(|error| SyncSeedError::Local(error.to_string()))?;
    // 先释放连接再去发事件：事件读取同一把 store 锁，持有连接会死锁。
    drop(conn);

    // 提交成功后才通知界面，避免「事件说切了、库里没切」。
    for config_id in updated_configs {
        emit_config_updated(store, &config_id);
    }

    Ok(SeedSync {
        added: Some(added),
        removed: Some(removed),
        changed_ids: changed,
        removed_node_name,
        replacement_node_name,
    })
}

/// 当前节点被种子刷新换掉后，通知 UI 更新这套配置的摘要。
fn emit_config_updated(store: &Store, config_id: &str) {
    let (config, node_count, active_id) = {
        let conn = store.conn();
        (
            configs::get(&conn, config_id).ok().flatten(),
            configs::node_count(&conn, config_id).unwrap_or(0),
            configs::active(&conn)
                .ok()
                .flatten()
                .map(|config| config.id),
        )
    };
    let Some(config) = config else { return };
    let summary = json!({
        "config_id": config.id,
        "name": config.name,
        "connect_mode": config.connection_mode,
        "routing_mode": config.routing_mode,
        "node_count": node_count,
        "listen_port": config.listen_port,
        "is_active": config.is_active,
        "current_node_id": config.current_node_id,
        "created_at": config.created_at,
        "updated_at": config.updated_at,
        "last_used_at": config.last_used_at,
    });
    crate::agent::app_handle::emit(
        "config-changed",
        json!({
            "contract_version": crate::runtime::EVENT_CONTRACT_VERSION,
            "change": "updated",
            "config_id": config.id,
            "config": summary,
            "active_config_id": active_id,
            "emitted_at": chrono::Utc::now()
                .to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
        }),
    );
}

/// 只读状态，不联网。形状见 `commands.md` §8.1。
///
/// 「有新版本」不落库：它只在刷新时由「远端哈希 != 缓存哈希」推导，
/// 避免多一个需要同步的真值来源。
pub fn status(store: &Store) -> Value {
    // **内容不可用就等于没有缓存。** 行只是元数据，`secrets.enc` 丢了之后
    // `node_count` 报 2 而实际一个节点都取不到，界面和 AI 都会被骗。
    let Some(nodes) = load_nodes(store) else {
        return no_cache_status();
    };
    let row = {
        let conn = store.conn();
        seed_cache::load(&conn).ok().flatten()
    };
    let Some(row) = row else {
        return no_cache_status();
    };
    json!({
        "seed_id": SEED_ID,
        "version": row.source_version,
        "content_sha256": row.content_sha256,
        "node_count": nodes.len() as i64,
        "applied_at": row.fetched_at,
        "checked_at": row.checked_at,
        "new_version_available": false,
        "source": "cache",
        "changed": false,
        "reason": null,
        "added": null,
        "removed": null,
        "removed_node_name": null,
        "replacement_node_name": null,
    })
}

fn no_cache_status() -> Value {
    json!({
        "seed_id": SEED_ID,
        "version": null,
        "content_sha256": null,
        "node_count": 0,
        "applied_at": null,
        "checked_at": null,
        "new_version_available": false,
        "source": "cache",
        "changed": false,
        "reason": null,
        "added": null,
        "removed": null,
        "removed_node_name": null,
        "replacement_node_name": null,
    })
}

pub fn emit_node_list_changed(
    store: &Store,
    reason: &str,
    config_id: Option<&str>,
    changed: &[String],
) {
    let changed_node_ids = if changed.len() > 200 {
        Vec::new()
    } else {
        changed.to_vec()
    };
    let total = {
        let conn = store.conn();
        configs::list_pool_nodes(&conn)
            .map(|nodes| nodes.len())
            .unwrap_or(0)
    };
    crate::agent::app_handle::emit(
        "node-list-changed",
        json!({
            "contract_version": crate::runtime::EVENT_CONTRACT_VERSION,
            "reason": reason,
            "config_id": config_id,
            "node_count_total": total,
            "changed_node_ids": changed_node_ids,
            "emitted_at": chrono::Utc::now()
                .to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
        }),
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> String {
        r#"{
          "version": 1,
          "updated_at": "2026-11-03T13:53:52Z",
          "nodes": [
            { "name": "meshflux69 [美国]", "server": "203.0.113.10", "port": 13774,
              "method": "aes-256-gcm", "password": "pw-a" },
            { "name": "", "server": "203.0.113.11", "port": 8388,
              "method": "chacha20-ietf-poly1305", "password": "pw-b" }
          ]
        }"#
        .to_string()
    }

    #[test]
    fn parses_and_normalises_nodes() {
        let parsed = parse_seed(sample().as_bytes()).unwrap();
        assert_eq!(parsed.version, Some(1));
        assert_eq!(parsed.source_updated_at.as_deref(), Some("2026-11-03T13:53:52Z"));
        assert_eq!(parsed.nodes.len(), 2);
        assert_eq!(parsed.nodes[1].name, "203.0.113.11:8388");
    }

    #[test]
    fn invalid_nodes_are_skipped_but_a_valid_one_keeps_the_seed_usable() {
        let body = r#"{"nodes":[
            {"name":"ok","server":"203.0.113.10","port":8388,"method":"aes-256-gcm","password":"p"},
            {"name":"bad","server":"10.0.0.1","port":0,"method":"aes-256-gcm","password":"p"},
            {"name":"bad2","server":"203.0.113.12","port":8388,"method":"rc4-md5","password":"p"}
        ]}"#;
        let parsed = parse_seed(body.as_bytes()).unwrap();
        assert_eq!(parsed.nodes.len(), 1);
        assert_eq!(parsed.nodes[0].name, "ok");
    }

    #[test]
    fn an_empty_or_unparseable_seed_is_rejected() {
        assert!(parse_seed(b"{}").is_err());
        assert!(parse_seed(b"not json").is_err());
        assert!(parse_seed(
            br#"{"nodes":[{"server":"203.0.113.10","port":8388,"method":"rc4-md5","password":"p"}]}"#
        )
        .is_err());
    }

    #[test]
    fn content_hash_ignores_the_version_field() {
        let first = sample();
        let second = sample().replace("\"version\": 1", "\"version\": 999");
        assert_ne!(content_sha256(first.as_bytes()), content_sha256(second.as_bytes()));
        assert_eq!(content_sha256(b"same"), content_sha256(b"same"));
    }

    #[test]
    fn status_reports_unavailable_without_cache() {
        let store = Store::open_in_memory().unwrap();
        let value = status(&store);
        assert_eq!(value["seed_id"], SEED_ID);
        assert!(value["content_sha256"].is_null());
        assert_eq!(value["node_count"], 0);
        assert_eq!(value["new_version_available"], false);
    }

    #[test]
    fn cached_nodes_round_trip_through_the_encrypted_store() {
        crate::test_support::install_test_secrets();
        let store = Store::open_in_memory().unwrap();
        let body = sample();
        let hash = content_sha256(body.as_bytes());
        crate::secrets::set_secret(&secret_key(&hash), &body).unwrap();
        {
            let conn = store.conn();
            seed_cache::save(
                &conn,
                &seed_cache::SeedCacheRow {
                    content_sha256: hash.clone(),
                    etag: Some("\"v1\"".into()),
                    etag_source: Some(DEFAULT_SEED_URL.into()),
                    source_version: Some("1".into()),
                    source_updated_at: Some("2026-11-03T13:53:52Z".into()),
                    node_count: 2,
                    fetched_at: store::now_ms(),
                    checked_at: store::now_ms(),
                },
            )
            .unwrap();
        }

        let nodes = load_nodes(&store).unwrap();
        assert_eq!(nodes.len(), 2);
        assert_eq!(nodes[0].password, "pw-a");

        let value = status(&store);
        assert_eq!(value["content_sha256"], hash);
        assert_eq!(value["version"], "1");
        assert_eq!(value["node_count"], 2);

        crate::secrets::delete_secret(&secret_key(&hash)).unwrap();
    }

    /// 当前节点被新种子下架：落到剩余第一个，并把两个名字带回去给界面提示。
    #[test]
    fn a_removed_current_node_falls_back_to_the_first_remaining() {
        crate::test_support::install_test_secrets();
        let store = Store::open_in_memory().unwrap();

        let old = r#"{"nodes":[
            {"name":"东京 01","server":"203.0.113.41","port":8388,"method":"aes-256-gcm","password":"p1"},
            {"name":"香港 01","server":"203.0.113.42","port":8389,"method":"aes-256-gcm","password":"p2"}
        ]}"#;
        let new = r#"{"nodes":[
            {"name":"东京 01","server":"203.0.113.41","port":8388,"method":"aes-256-gcm","password":"p1"}
        ]}"#;
        let parsed_old = parse_seed(old.as_bytes()).unwrap();
        let parsed_new = parse_seed(new.as_bytes()).unwrap();

        let id_for = |node: &SeedNode| {
            let key = nodes::source_key(&node.name, &node.server, node.port, &node.method);
            nodes::node_id(configs::SOURCE_SEED, &key)
        };
        let tokyo_id = id_for(&parsed_old.nodes[0]);
        let hong_kong_id = id_for(&parsed_old.nodes[1]);

        {
            let conn = store.conn();
            configs::create(
                &conn,
                &configs::NewConfig {
                    id: "cfg_1",
                    name: "跟随种子",
                    connection_mode: configs::CONNECTION_SYSTEM_PROXY,
                    routing_mode: configs::ROUTING_PROXY_ALL,
                    listen_port: Some(7890),
                    dns: &json!({ "mode": "auto", "local": [], "remote": [] }),
                    tun_excludes: &json!([]),
                },
            )
            .unwrap();
            for node in &parsed_old.nodes {
                let id = id_for(node);
                let key = nodes::source_key(&node.name, &node.server, node.port, &node.method);
                let reference = nodes::password_ref(&id);
                crate::secrets::set_secret(&reference, &node.password).unwrap();
                configs::upsert_node(
                    &conn,
                    &configs::NewNode {
                        id: &id,
                        name: &node.name,
                        server: &node.server,
                        port: node.port,
                        method: &node.method,
                        password_ref: &reference,
                        source: configs::SOURCE_SEED,
                        source_key: &key,
                    },
                )
                .unwrap();
                configs::attach_node(&conn, "cfg_1", &id).unwrap();
            }
            configs::update(
                &conn,
                "cfg_1",
                &configs::ConfigPatch {
                    current_node_id: Some(Some(hong_kong_id.clone())),
                    ..Default::default()
                },
            )
            .unwrap();
            let config = configs::get(&conn, "cfg_1").unwrap().unwrap();
            assert_eq!(config.current_node_id.as_deref(), Some(hong_kong_id.as_str()));
        }

        let sync = sync_seed_nodes(&store, &parsed_new.nodes).unwrap();
        assert_eq!(sync.added, Some(0));
        assert_eq!(sync.removed, Some(1));
        assert_eq!(sync.removed_node_name.as_deref(), Some("香港 01"));
        assert_eq!(sync.replacement_node_name.as_deref(), Some("东京 01"));

        let conn = store.conn();
        let config = configs::get(&conn, "cfg_1").unwrap().unwrap();
        assert_eq!(config.current_node_id.as_deref(), Some(tokyo_id.as_str()));
        assert_eq!(configs::list_nodes(&conn, "cfg_1").unwrap().len(), 1);
    }

    /// 结果字段齐全：设置页据此分「离线」与「内容异常」以及「更新了几个」。
    #[test]
    fn status_and_refresh_results_carry_the_ui_fields() {
        let store = Store::open_in_memory().unwrap();
        let value = status(&store);
        for field in [
            "source",
            "changed",
            "reason",
            "added",
            "removed",
            "removed_node_name",
            "replacement_node_name",
        ] {
            assert!(value.get(field).is_some(), "缺少字段 {field}");
        }
        assert_eq!(value["reason"], Value::Null);
        assert_eq!(value["source"], "cache");
    }

    #[test]
    fn refresh_binds_new_seed_nodes_and_skips_exclusions() {
        crate::test_support::install_test_secrets();
        let store = Store::open_in_memory().unwrap();
        let parsed = parse_seed(sample().as_bytes()).unwrap();
        let first = &parsed.nodes[0];
        let second = &parsed.nodes[1];
        let first_key = nodes::source_key(&first.name, &first.server, first.port, &first.method);
        let second_key = nodes::source_key(&second.name, &second.server, second.port, &second.method);
        let first_id = nodes::node_id(configs::SOURCE_SEED, &first_key);

        {
            let conn = store.conn();
            configs::create(
                &conn,
                &configs::NewConfig {
                    id: "cfg_1",
                    name: "跟随种子",
                    connection_mode: configs::CONNECTION_SYSTEM_PROXY,
                    routing_mode: configs::ROUTING_PROXY_ALL,
                    listen_port: Some(7890),
                    dns: &json!({ "mode": "auto", "local": [], "remote": [] }),
                    tun_excludes: &json!([]),
                },
            )
            .unwrap();
            crate::secrets::set_secret(&nodes::password_ref(&first_id), &first.password).unwrap();
            configs::upsert_node(
                &conn,
                &configs::NewNode {
                    id: &first_id,
                    name: &first.name,
                    server: &first.server,
                    port: first.port,
                    method: &first.method,
                    password_ref: &nodes::password_ref(&first_id),
                    source: configs::SOURCE_SEED,
                    source_key: &first_key,
                },
            )
            .unwrap();
            configs::attach_node(&conn, "cfg_1", &first_id).unwrap();

            // 用户移除过第二个节点：刷新不能把它加回来。
            configs::record_seed_exclusion(&conn, &second_key).unwrap();
        }

        sync_seed_nodes(&store, &parsed.nodes).unwrap();
        {
            let conn = store.conn();
            assert_eq!(configs::list_nodes(&conn, "cfg_1").unwrap().len(), 1);
        }

        // 明确撤销排除后，下一次刷新会绑定。
        {
            let conn = store.conn();
            configs::remove_seed_exclusion(&conn, &second_key).unwrap();
        }
        sync_seed_nodes(&store, &parsed.nodes).unwrap();
        {
            let conn = store.conn();
            assert_eq!(configs::list_nodes(&conn, "cfg_1").unwrap().len(), 2);
        }
    }

    /// **回归：元数据还在、密文丢了，不能判「无需更新」。**
    ///
    /// `secrets.enc` 丢失（换机器、误删、只从备份恢复数据库）之后，
    /// 旧逻辑比对哈希得出「内容没变」，于是种子节点永远补不回来，
    /// 用户看到的是「默认节点一直是 0」，而我们什么都不报。
    #[tokio::test]
    async fn a_lost_secret_is_rebuilt_instead_of_reported_unchanged() {
        crate::test_support::install_test_secrets();
        let store = Store::open_in_memory().unwrap();
        // 用自己的内容，别和 `cached_nodes_round_trip...` 共用同一份：
        // 两条测试共享同一个 `secrets.enc`，内容相同就会算到同一个 key 上，
        // 这条的清理会把那条的数据删掉。
        let body = r#"{
          "version": 1,
          "updated_at": "2026-11-04T00:00:00Z",
          "nodes": [
            { "name": "iso-a", "server": "203.0.113.21", "port": 8388,
              "method": "aes-256-gcm", "password": "pw-iso-a" },
            { "name": "iso-b", "server": "203.0.113.22", "port": 8389,
              "method": "aes-256-gcm", "password": "pw-iso-b" }
          ]
        }"#
        .to_string();
        let hash = content_sha256(body.as_bytes());

        crate::secrets::set_secret(&secret_key(&hash), &body).unwrap();
        let row = seed_cache::SeedCacheRow {
            content_sha256: hash.clone(),
            etag: Some("\"v1\"".into()),
            etag_source: Some(DEFAULT_SEED_URL.into()),
            source_version: Some("1".into()),
            source_updated_at: None,
            node_count: 2,
            fetched_at: store::now_ms(),
            checked_at: store::now_ms(),
        };
        {
            let conn = store.conn();
            seed_cache::save(&conn, &row).unwrap();
        }

        // 模拟密文丢失
        crate::secrets::delete_secret(&secret_key(&hash)).unwrap();
        assert!(load_nodes(&store).is_none(), "前置条件：内容确实丢了");

        let outcome = apply_fetch(
            &store,
            Some(&row),
            crate::public_http::PublicResponse {
                status: 200,
                etag: Some("\"v1\"".into()),
                body: body.clone().into_bytes(),
            },
            store::now_ms(),
            false,
            DEFAULT_SEED_URL,
        )
        .await;

        assert!(
            !matches!(outcome, RefreshOutcome::Unchanged { .. }),
            "内容缺失时报了「无需更新」，种子将永远补不回来"
        );
        assert_eq!(
            load_nodes(&store).map(|nodes| nodes.len()),
            Some(2),
            "密文应当被重建"
        );

        crate::secrets::delete_secret(&secret_key(&hash)).unwrap();
    }

    #[test]
    fn a_304_with_lost_content_forces_a_refetch() {
        assert!(needs_refetch(304, false), "304 + 内容丢了必须重拉");
        assert!(!needs_refetch(304, true), "304 + 内容在，直接用缓存");
        assert!(!needs_refetch(200, false), "200 有 body，不需要重拉");
    }

    /// 行还在、内容丢了 → 对外必须报「没有缓存」，不能报 node_count=2。
    #[test]
    fn a_row_without_content_reports_no_cache() {
        crate::test_support::install_test_secrets();
        let store = Store::open_in_memory().unwrap();
        let body = r#"{
          "version": 1,
          "updated_at": "2026-11-04T00:00:00Z",
          "nodes": [
            { "name": "gone-a", "server": "203.0.113.31", "port": 8388,
              "method": "aes-256-gcm", "password": "pw-gone-a" },
            { "name": "gone-b", "server": "203.0.113.32", "port": 8389,
              "method": "aes-256-gcm", "password": "pw-gone-b" }
          ]
        }"#
        .to_string();
        let hash = content_sha256(body.as_bytes());
        crate::secrets::set_secret(&secret_key(&hash), &body).unwrap();
        {
            let conn = store.conn();
            seed_cache::save(
                &conn,
                &seed_cache::SeedCacheRow {
                    content_sha256: hash.clone(),
                    etag: None,
                    etag_source: None,
                    source_version: Some("1".into()),
                    source_updated_at: None,
                    node_count: 2,
                    fetched_at: store::now_ms(),
                    checked_at: store::now_ms(),
                },
            )
            .unwrap();
        }
        crate::secrets::delete_secret(&secret_key(&hash)).unwrap();

        let value = status(&store);
        assert_eq!(value["node_count"], 0, "内容不可用时不能报有节点");
        assert!(value["version"].is_null(), "不能报一个用不了的版本号");
    }

    /// **refresh 层的回归**：304 + 本地内容丢了 → 必须不带 ETag 再拉一次。
    ///
    /// 只测 `needs_refetch` 纯函数不够——真正会出错的是这两次调用之间的衔接。
    #[tokio::test]
    async fn a_304_with_lost_content_refetches_without_etag() {
        crate::test_support::install_test_secrets();
        let store = Store::open_in_memory().unwrap();

        let body = r#"{
          "version": 1,
          "updated_at": "2026-11-04T00:00:00Z",
          "nodes": [
            { "name": "retry-a", "server": "203.0.113.41", "port": 8388,
              "method": "aes-256-gcm", "password": "pw-retry-a" },
            { "name": "retry-b", "server": "203.0.113.42", "port": 8389,
              "method": "aes-256-gcm", "password": "pw-retry-b" }
          ]
        }"#
        .to_string();
        let hash = content_sha256(body.as_bytes());

        crate::secrets::set_secret(&secret_key(&hash), &body).unwrap();
        {
            let conn = store.conn();
            seed_cache::save(
                &conn,
                &seed_cache::SeedCacheRow {
                    content_sha256: hash.clone(),
                    etag: Some("\"v1\"".into()),
                    etag_source: Some(DEFAULT_SEED_URL.into()),
                    source_version: Some("1".into()),
                    source_updated_at: None,
                    node_count: 2,
                    fetched_at: store::now_ms(),
                    checked_at: store::now_ms(),
                },
            )
            .unwrap();
        }
        crate::secrets::delete_secret(&secret_key(&hash)).unwrap();
        assert!(load_nodes(&store).is_none(), "前置条件：内容已丢");

        let calls = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let payload = body.clone().into_bytes();
        let recorder = std::sync::Arc::clone(&calls);

        let outcome = refresh_with(
            &store,
            false,
            false,
            vec![DEFAULT_SEED_URL.to_string()],
            move |_url: &str, etag: Option<String>| {
                let recorder = std::sync::Arc::clone(&recorder);
                let payload = payload.clone();
                async move {
                    recorder.lock().unwrap().push(etag.clone());
                    match etag {
                        // 第一次带 ETag：服务器说没变
                        Some(_) => Ok(crate::public_http::PublicResponse {
                            status: 304,
                            etag: Some("\"v1\"".into()),
                            body: Vec::new(),
                        }),
                        // 重拉不带 ETag：给完整内容
                        None => Ok(crate::public_http::PublicResponse {
                            status: 200,
                            etag: Some("\"v1\"".into()),
                            body: payload,
                        }),
                    }
                }
            },
        )
        .await;

        let calls = calls.lock().unwrap().clone();
        assert_eq!(
            calls.len(),
            2,
            "第一次拿到 304 之后应当无 ETag 再拉一次，实际调用：{calls:?}"
        );
        assert!(calls[0].is_some(), "第一次必须带 ETag");
        assert!(calls[1].is_none(), "第二次必须不带 ETag，否则又只会拿到 304");
        assert!(
            matches!(outcome, RefreshOutcome::Updated { .. }),
            "内容被补回来才算成功"
        );
        assert_eq!(
            load_nodes(&store).map(|nodes| nodes.len()),
            Some(2),
            "内容应当恢复"
        );
    }

    fn two_node_body(tag: &str) -> String {
        two_node_body_at(tag, Some("2026-11-17T00:00:00Z"))
    }

    /// 写一条缓存并把原文放进密文存储。
    fn save_cache(store: &Store, body: &str, checked_at: i64) -> String {
        let hash = content_sha256(body.as_bytes());
        crate::secrets::set_secret(&secret_key(&hash), body).unwrap();
        let conn = store.conn();
        seed_cache::save(
            &conn,
            &seed_cache::SeedCacheRow {
                content_sha256: hash.clone(),
                etag: Some("\"v1\"".into()),
                etag_source: Some(DEFAULT_SEED_URL.into()),
                source_version: Some("1".into()),
                source_updated_at: None,
                node_count: 2,
                fetched_at: 1,
                checked_at,
            },
        )
        .unwrap();
        hash
    }

    fn start_trial(store: &Store, started_at_ms: i64) {
        let conn = store.conn();
        crate::trial::mark_started(&conn, started_at_ms).unwrap();
    }

    fn cache_row(store: &Store) -> seed_cache::SeedCacheRow {
        let conn = store.conn();
        seed_cache::load(&conn).unwrap().unwrap()
    }

    /// #1 未开始试用：刷新照常发请求、应用内容。
    #[tokio::test]
    async fn refresh_runs_when_the_trial_has_not_started() {
        crate::test_support::install_test_secrets();
        let store = Store::open_in_memory().unwrap();
        let body = two_node_body("available");

        let outcome = refresh_with(
            &store,
            false,
            true,
            vec![DEFAULT_SEED_URL.to_string()],
            |_url: &str, _etag: Option<String>| {
                let body = body.clone();
                async move {
                    Ok(crate::public_http::PublicResponse {
                        status: 200,
                        etag: Some("\"v1\"".into()),
                        body: body.into_bytes(),
                    })
                }
            },
        )
        .await;

        assert!(
            matches!(outcome, RefreshOutcome::Updated { node_count: 2, .. }),
            "available 必须照常刷新：{outcome:?}"
        );
    }

    /// #2 试用中：照常刷新。
    #[tokio::test]
    async fn refresh_runs_while_the_trial_is_active() {
        crate::test_support::install_test_secrets();
        let store = Store::open_in_memory().unwrap();
        start_trial(&store, store::now_ms() - 60 * 60 * 1000);
        let body = two_node_body("active");

        let outcome = refresh_with(
            &store,
            false,
            true,
            vec![DEFAULT_SEED_URL.to_string()],
            |_url: &str, _etag: Option<String>| {
                let body = body.clone();
                async move {
                    Ok(crate::public_http::PublicResponse {
                        status: 200,
                        etag: Some("\"v1\"".into()),
                        body: body.into_bytes(),
                    })
                }
            },
        )
        .await;

        assert!(
            matches!(outcome, RefreshOutcome::Updated { node_count: 2, .. }),
            "active 必须照常刷新：{outcome:?}"
        );
    }

    /// #3 开始 8 天前、还没跑清理：入口判定就挡住，不联网、不续命。
    #[tokio::test]
    async fn refresh_is_rejected_when_the_trial_started_eight_days_ago() {
        crate::test_support::install_test_secrets();
        let store = Store::open_in_memory().unwrap();
        let _hash = save_cache(&store, &two_node_body("old"), 7);
        start_trial(&store, store::now_ms() - 8 * 24 * 60 * 60 * 1000);

        let calls = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let recorder = std::sync::Arc::clone(&calls);
        let outcome = refresh_with(
            &store,
            false,
            true,
            vec![DEFAULT_SEED_URL.to_string()],
            move |_url: &str, _etag: Option<String>| {
                let recorder = std::sync::Arc::clone(&recorder);
                async move {
                    recorder.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    Err("不该联网".to_string())
                }
            },
        )
        .await;

        assert!(matches!(outcome, RefreshOutcome::TrialExpired), "{outcome:?}");
        assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 0);
        assert_eq!(cache_row(&store).checked_at, 7, "过期不能续命检查时间");
    }

    /// #4 `ended_at` 非空：即使今天才开始，也算过期。
    #[tokio::test]
    async fn refresh_is_rejected_when_the_trial_ended_today() {
        crate::test_support::install_test_secrets();
        let store = Store::open_in_memory().unwrap();
        let now = store::now_ms();
        start_trial(&store, now);
        {
            let conn = store.conn();
            conn.execute(
                "UPDATE trial_state SET ended_at = ?1 WHERE id = 1",
                rusqlite::params![now + 1],
            )
            .unwrap();
        }

        let calls = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let recorder = std::sync::Arc::clone(&calls);
        let outcome = refresh_with(
            &store,
            false,
            true,
            vec![DEFAULT_SEED_URL.to_string()],
            move |_url: &str, _etag: Option<String>| {
                let recorder = std::sync::Arc::clone(&recorder);
                async move {
                    recorder.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    Err("不该联网".to_string())
                }
            },
        )
        .await;

        assert!(matches!(outcome, RefreshOutcome::TrialExpired), "{outcome:?}");
        assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 0);
    }

    /// #5 入口放行后、响应回来前才过期：第二次判定挡住，200 也不落库。
    #[tokio::test]
    async fn an_expiry_during_the_fetch_discards_the_response() {
        crate::test_support::install_test_secrets();
        let store = std::sync::Arc::new(Store::open_in_memory().unwrap());
        let old_body = two_node_body("before");
        let old_hash = save_cache(&store, &old_body, 5);
        let new_body = two_node_body("after");
        let new_hash = content_sha256(new_body.as_bytes());

        let backdate = std::sync::Arc::clone(&store);
        let outcome = refresh_with(
            &store,
            false,
            true,
            vec![DEFAULT_SEED_URL.to_string()],
            move |_url: &str, _etag: Option<String>| {
                let backdate = std::sync::Arc::clone(&backdate);
                let body = new_body.clone();
                async move {
                    // 入口检查已经过了，这里把试用改到 8 天前再返回内容。
                    {
                        let conn = backdate.conn();
                        crate::trial::mark_started(
                            &conn,
                            store::now_ms() - 8 * 24 * 60 * 60 * 1000,
                        )
                        .unwrap();
                    }
                    Ok(crate::public_http::PublicResponse {
                        status: 200,
                        etag: Some("\"v2\"".into()),
                        body: body.into_bytes(),
                    })
                }
            },
        )
        .await;

        assert!(matches!(outcome, RefreshOutcome::TrialExpired), "{outcome:?}");
        assert_eq!(cache_row(&store).content_sha256, old_hash, "不推进 hash");
        assert!(
            crate::secrets::get_secret(&secret_key(&new_hash))
                .ok()
                .flatten()
                .is_none(),
            "过期时不能留下新密文"
        );
        let names: Vec<String> = load_nodes(&store)
            .unwrap()
            .into_iter()
            .map(|node| node.name)
            .collect();
        assert!(names.iter().all(|name| name.starts_with("before-")), "{names:?}");
    }

    /// #5b 同样的时点但返回 304：不更新 `checked_at`。
    #[tokio::test]
    async fn an_expiry_during_a_304_does_not_touch_the_cache() {
        crate::test_support::install_test_secrets();
        let store = std::sync::Arc::new(Store::open_in_memory().unwrap());
        let _hash = save_cache(&store, &two_node_body("cached"), 5);

        let backdate = std::sync::Arc::clone(&store);
        let outcome = refresh_with(
            &store,
            false,
            true,
            vec![DEFAULT_SEED_URL.to_string()],
            move |_url: &str, _etag: Option<String>| {
                let backdate = std::sync::Arc::clone(&backdate);
                async move {
                    {
                        let conn = backdate.conn();
                        crate::trial::mark_started(
                            &conn,
                            store::now_ms() - 8 * 24 * 60 * 60 * 1000,
                        )
                        .unwrap();
                    }
                    Ok(crate::public_http::PublicResponse {
                        status: 304,
                        etag: Some("\"v1\"".into()),
                        body: Vec::new(),
                    })
                }
            },
        )
        .await;

        assert!(matches!(outcome, RefreshOutcome::TrialExpired), "{outcome:?}");
        assert_eq!(cache_row(&store).checked_at, 5, "304 也不能续命");
    }

    /// #5c 写事务内的最终判定：直接调 `sync_seed_nodes` 也不写、不绑、不删。
    #[test]
    fn sync_is_rejected_inside_the_write_transaction_when_expired() {
        crate::test_support::install_test_secrets();
        let store = Store::open_in_memory().unwrap();
        let parsed = parse_seed(two_node_body("tx").as_bytes()).unwrap();
        let existing = &parsed.nodes[0];
        let key = nodes::source_key(&existing.name, &existing.server, existing.port, &existing.method);
        let id = nodes::node_id(configs::SOURCE_SEED, &key);
        let reference = nodes::password_ref(&id);
        {
            let conn = store.conn();
            configs::create(
                &conn,
                &configs::NewConfig {
                    id: "cfg_tx",
                    name: "跟随种子",
                    connection_mode: configs::CONNECTION_SYSTEM_PROXY,
                    routing_mode: configs::ROUTING_PROXY_ALL,
                    listen_port: None,
                    dns: &json!({ "mode": "auto", "local": [], "remote": [] }),
                    tun_excludes: &json!([]),
                },
            )
            .unwrap();
            crate::secrets::set_secret(&reference, &existing.password).unwrap();
            configs::upsert_node(
                &conn,
                &configs::NewNode {
                    id: &id,
                    name: &existing.name,
                    server: &existing.server,
                    port: existing.port,
                    method: &existing.method,
                    password_ref: &reference,
                    source: configs::SOURCE_SEED,
                    source_key: &key,
                },
            )
            .unwrap();
            configs::attach_node(&conn, "cfg_tx", &id).unwrap();
        }
        start_trial(&store, store::now_ms() - 8 * 24 * 60 * 60 * 1000);

        let result = sync_seed_nodes(&store, &parsed.nodes);
        assert!(
            matches!(result, Err(SyncSeedError::TrialExpired)),
            "事务内必须返回 TrialExpired：{:?}",
            result.err().map(|error| error.to_string())
        );

        let conn = store.conn();
        let nodes = configs::list_nodes(&conn, "cfg_tx").unwrap();
        assert_eq!(nodes.len(), 1, "不能删旧节点，也不能绑新节点");
        assert_eq!(nodes[0].id, id);
    }

    /// #6 删掉 `trial_state` 行等于重置：下一次刷新恢复拉取。
    #[tokio::test]
    async fn deleting_the_trial_row_restores_refreshing() {
        crate::test_support::install_test_secrets();
        let store = Store::open_in_memory().unwrap();
        start_trial(&store, store::now_ms() - 8 * 24 * 60 * 60 * 1000);
        {
            let conn = store.conn();
            conn.execute("DELETE FROM trial_state", []).unwrap();
        }
        let body = two_node_body("reset");

        let outcome = refresh_with(
            &store,
            false,
            true,
            vec![DEFAULT_SEED_URL.to_string()],
            |_url: &str, _etag: Option<String>| {
                let body = body.clone();
                async move {
                    Ok(crate::public_http::PublicResponse {
                        status: 200,
                        etag: Some("\"v1\"".into()),
                        body: body.into_bytes(),
                    })
                }
            },
        )
        .await;

        assert!(
            matches!(outcome, RefreshOutcome::Updated { node_count: 2, .. }),
            "重置后必须恢复：{outcome:?}"
        );
    }

    fn two_node_body_at(tag: &str, updated_at: Option<&str>) -> String {
        let stamp = updated_at
            .map(|value| format!(r#""updated_at": "{value}","#))
            .unwrap_or_default();
        format!(
            r#"{{
              "version": 1,
              {stamp}
              "nodes": [
                {{ "name": "{tag}-a", "server": "203.0.113.51", "port": 8388,
                  "method": "aes-256-gcm", "password": "pw-{tag}-a" }},
                {{ "name": "{tag}-b", "server": "203.0.113.52", "port": 8389,
                  "method": "aes-256-gcm", "password": "pw-{tag}-b" }}
              ]
            }}"#
        )
    }

    #[test]
    fn the_shared_golden_fixture_matches_the_client_rules() {
        #[derive(serde::Deserialize)]
        struct Golden {
            valid: Vec<RawNode>,
            invalid: Vec<GoldenInvalid>,
        }
        #[derive(serde::Deserialize)]
        struct GoldenInvalid {
            case: String,
            node: RawNode,
        }

        // TS 侧 test/seed.test.ts 读同一份文件，防止两端规则漂移。
        let fixture: Golden = serde_json::from_str(include_str!(
            "../../seed/fixtures/seed.golden.json"
        ))
        .expect("golden fixture 必须能解析");
        assert!(!fixture.valid.is_empty());
        for (index, node) in fixture.valid.into_iter().enumerate() {
            assert!(
                validate_seed_node(node).is_ok(),
                "合法样本被拒绝：#{index}"
            );
        }
        for invalid in fixture.invalid {
            assert!(
                validate_seed_node(invalid.node).is_err(),
                "非法样本被放行：{}",
                invalid.case
            );
        }
    }

    /// 唯一来源失败 → `Offline`，已有缓存与节点一个都不能丢。
    #[tokio::test]
    async fn a_failed_source_keeps_the_cached_nodes() {
        crate::test_support::install_test_secrets();
        let store = Store::open_in_memory().unwrap();
        let body = two_node_body("keep");
        let hash = content_sha256(body.as_bytes());
        crate::secrets::set_secret(&secret_key(&hash), &body).unwrap();
        {
            let conn = store.conn();
            seed_cache::save(
                &conn,
                &seed_cache::SeedCacheRow {
                    content_sha256: hash.clone(),
                    etag: Some("\"v1\"".into()),
                    etag_source: Some(DEFAULT_SEED_URL.into()),
                    source_version: Some("1".into()),
                    source_updated_at: None,
                    node_count: 2,
                    fetched_at: store::now_ms(),
                    checked_at: 0,
                },
            )
            .unwrap();
        }

        let outcome = refresh_with(
            &store,
            false,
            true,
            vec![DEFAULT_SEED_URL.to_string()],
            |_url: &str, _etag: Option<String>| async move {
                Err("offline".to_string())
            },
        )
        .await;

        match outcome {
            RefreshOutcome::Offline { cached, .. } => assert!(cached, "必须承认缓存还在"),
            other => panic!("源失败不能报成功：{other:?}"),
        }
        let row = {
            let conn = store.conn();
            seed_cache::load(&conn).unwrap().unwrap()
        };
        assert_eq!(row.content_sha256, hash, "失败不能改哈希");
        assert_eq!(load_nodes(&store).map(|nodes| nodes.len()), Some(2));
    }

    /// 同一份内容再来一次：哈希不变就不重写缓存，只更新时间戳与 ETag。
    #[tokio::test]
    async fn the_same_hash_is_not_rewritten_on_the_primary() {
        crate::test_support::install_test_secrets();
        let store = Store::open_in_memory().unwrap();
        let body = two_node_body("same");
        let hash = content_sha256(body.as_bytes());
        crate::secrets::set_secret(&secret_key(&hash), &body).unwrap();
        let before = {
            let conn = store.conn();
            seed_cache::save(
                &conn,
                &seed_cache::SeedCacheRow {
                    content_sha256: hash.clone(),
                    etag: Some("\"worker-old\"".into()),
                    etag_source: Some(DEFAULT_SEED_URL.into()),
                    source_version: Some("1".into()),
                    source_updated_at: None,
                    node_count: 2,
                    fetched_at: 1,
                    checked_at: 0,
                },
            )
            .unwrap();
            seed_cache::load(&conn).unwrap().unwrap()
        };

        let outcome = refresh_with(
            &store,
            false,
            true,
            vec![DEFAULT_SEED_URL.to_string()],
            |_url: &str, _etag: Option<String>| {
                let body = body.clone();
                async move {
                    Ok(crate::public_http::PublicResponse {
                        status: 200,
                        etag: Some("\"worker-v1\"".into()),
                        body: body.into_bytes(),
                    })
                }
            },
        )
        .await;

        assert!(
            matches!(outcome, RefreshOutcome::Unchanged { node_count: 2 }),
            "内容相同只能算 Unchanged：{outcome:?}"
        );
        let after = {
            let conn = store.conn();
            seed_cache::load(&conn).unwrap().unwrap()
        };
        assert_eq!(after.content_sha256, before.content_sha256);
        assert_eq!(after.fetched_at, before.fetched_at, "不能重写缓存");
        assert!(after.checked_at > before.checked_at, "检查时间要更新");
        assert_eq!(after.etag_source.as_deref(), Some(DEFAULT_SEED_URL));
    }
}
