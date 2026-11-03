//! 种子：拉取、解析、加密缓存与按内容哈希检测更新。
//!
//! 客户端只消费 `veyl_seed.json`（只含节点，不含分流）。种子原文含节点密码，
//! 因此整包加密存放在 `secrets.enc` 的 `seed:<content_sha256>`；SQLite 只保存
//! 哈希、etag、节点数与时间戳。
//!
//! 更新判据是**内容哈希**，不是 `version` 字段。
//! 拉取失败永远不清空缓存，也不返回致命错误：离线是正常场景。

use std::collections::HashSet;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::nodes;
use crate::public_http;
use crate::store::{self, configs, seed_cache, Store};

pub const DEFAULT_SEED_URL: &str = "https://meshnetprotocol.github.io/veyl_seed.json";
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
    Updated { node_count: i64 },
    /// 304 或内容哈希未变。`node_count` 为缓存里的数量。
    Unchanged { node_count: i64 },
    /// 拉取或解析失败；缓存原样保留。
    Offline { cached: bool, error: String },
}

/// 调试可用环境变量覆盖；正常构建只认固定地址。
pub fn source_url() -> String {
    std::env::var("VEYL_SEED_URL")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| DEFAULT_SEED_URL.to_string())
}

pub fn content_sha256(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hex::encode(hasher.finalize())
}

fn secret_key(hash: &str) -> String {
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
    let row = {
        let conn = store.conn();
        seed_cache::load(&conn).ok().flatten()?
    };
    let raw = crate::secrets::get_secret(&secret_key(&row.content_sha256))
        .ok()
        .flatten()?;
    parse_seed(raw.as_bytes()).ok().map(|parsed| parsed.nodes)
}

/// 拉取并应用种子。`running` 为真且内容变化时只标记「有新版本」，不碰在线连接。
///
/// 任何网络或解析失败都返回 `Offline`，绝不清理已有缓存。
pub async fn refresh(store: &Store, running: bool, force: bool) -> RefreshOutcome {
    let _guard = REFRESH_LOCK.lock().await;

    let current = {
        let conn = store.conn();
        seed_cache::load(&conn).ok().flatten()
    };
    let now = store::now_ms();

    if !force {
        if let Some(row) = &current {
            if now.saturating_sub(row.checked_at) < REFRESH_INTERVAL.as_millis() as i64 {
                return RefreshOutcome::Unchanged {
                    node_count: row.node_count,
                };
            }
        }
    }

    let url = source_url();
    let etag = current.as_ref().and_then(|row| row.etag.clone());
    let response = match public_http::get(&url, etag.as_deref(), MAX_SEED_BYTES).await {
        Ok(response) => response,
        Err(error) => {
            log::warn!("种子拉取失败，保留缓存：{error}");
            return RefreshOutcome::Offline {
                cached: current.is_some(),
                error,
            };
        }
    };

    if response.status == 304 {
        let conn = store.conn();
        let _ = seed_cache::touch(&conn, now, response.etag.as_deref());
        return RefreshOutcome::Unchanged {
            node_count: current.map(|row| row.node_count).unwrap_or(0),
        };
    }

    let hash = content_sha256(&response.body);
    let parsed = match parse_seed(&response.body) {
        Ok(parsed) => parsed,
        Err(error) => {
            log::warn!("种子校验失败，保留缓存：{error}");
            return RefreshOutcome::Offline {
                cached: current.is_some(),
                error,
            };
        }
    };
    let node_count = parsed.nodes.len() as i64;

    if let Some(row) = &current {
        if row.content_sha256 == hash {
            let conn = store.conn();
            let _ = seed_cache::touch(&conn, now, response.etag.as_deref());
            return RefreshOutcome::Unchanged {
                node_count: row.node_count,
            };
        }
    }

    // 先写密文再写元数据：元数据指向的哈希必须已经能解出原文。
    let raw = String::from_utf8_lossy(&response.body).into_owned();
    if let Err(error) = crate::secrets::set_secret(&secret_key(&hash), &raw) {
        log::warn!("种子缓存写入失败，保留旧缓存：{error}");
        return RefreshOutcome::Offline {
            cached: current.is_some(),
            error: format!("保存种子缓存失败：{error}"),
        };
    }

    let changed_ids = match sync_seed_nodes(store, &parsed.nodes) {
        Ok(changed) => changed,
        Err(error) => {
            log::warn!("种子节点同步失败（缓存已更新，下次刷新再补）：{error}");
            Vec::new()
        }
    };

    let row = seed_cache::SeedCacheRow {
        content_sha256: hash.clone(),
        etag: response.etag.clone(),
        source_version: parsed.version.map(|value| value.to_string()),
        source_updated_at: parsed.source_updated_at.clone(),
        node_count,
        fetched_at: now,
        checked_at: now,
        // 在线时新版本只在下次连接生效，入口显示「有新版本」。
        new_version_available: running,
    };
    if let Err(error) = {
        let conn = store.conn();
        seed_cache::save(&conn, &row)
    } {
        log::warn!("种子元数据写入失败：{error}");
        return RefreshOutcome::Offline {
            cached: current.is_some(),
            error: error.to_string(),
        };
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
            "new_version_available": row.new_version_available,
            "applied_at": now,
            "emitted_at": chrono::Utc::now()
                .to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
        }),
    );
    if !changed_ids.is_empty() {
        emit_node_list_changed(store, "seed_refreshed", None, &changed_ids);
    }
    log::info!("种子已更新：{node_count} 个节点");

    RefreshOutcome::Updated { node_count }
}

/// 让已物化的种子节点层跟随新种子：按 `source_key` upsert，删掉新种子里没有的。
///
/// 从未创建过 seed 配置时不物化任何节点——没被用过的种子不该出现在节点池里。
fn sync_seed_nodes(store: &Store, seed_nodes: &[SeedNode]) -> Result<Vec<String>, String> {
    let existing = {
        let conn = store.conn();
        configs::list_nodes_by_source(&conn, configs::SOURCE_SEED)
            .map_err(|error| error.to_string())?
    };
    if existing.is_empty() {
        return Ok(Vec::new());
    }

    let mut keep = HashSet::new();
    let mut changed = Vec::new();
    for node in seed_nodes {
        let key = nodes::source_key(&node.name, &node.server, node.port, &node.method);
        let id = nodes::node_id(configs::SOURCE_SEED, &key);
        let reference = nodes::password_ref(&id);
        crate::secrets::set_secret(&reference, &node.password).map_err(|error| error.to_string())?;
        {
            let conn = store.conn();
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
            .map_err(|error| error.to_string())?;
        }
        if !existing.iter().any(|row| row.id == id) {
            changed.push(id.clone());
        }
        keep.insert(id);
    }

    for row in existing {
        if !keep.contains(&row.id) {
            {
                let conn = store.conn();
                configs::delete_node(&conn, &row.id).map_err(|error| error.to_string())?;
            }
            let _ = crate::secrets::delete_secret(&row.password_ref);
            changed.push(row.id);
        }
    }
    Ok(changed)
}

/// 离线兜底：把一份 `veyl_seed.json` 文件合并进节点池。
///
/// **只增不删**：手工导入不能删掉种子拉取层已有的节点。
pub fn merge_file_nodes(store: &Store, contents: &[u8]) -> Result<(usize, Vec<String>), String> {
    let parsed = parse_seed(contents)?;
    let mut imported = 0;
    let mut added = Vec::new();
    for node in &parsed.nodes {
        let key = nodes::source_key(&node.name, &node.server, node.port, &node.method);
        let exists = {
            let conn = store.conn();
            configs::find_node_by_source_key(&conn, configs::SOURCE_SEED, &key)
                .map_err(|error| error.to_string())?
                .is_some()
        };
        if exists {
            continue;
        }
        let id = nodes::node_id(configs::SOURCE_SEED, &key);
        let reference = nodes::password_ref(&id);
        crate::secrets::set_secret(&reference, &node.password).map_err(|error| error.to_string())?;
        {
            let conn = store.conn();
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
            .map_err(|error| error.to_string())?;
        }
        imported += 1;
        added.push(id);
    }
    if !added.is_empty() {
        emit_node_list_changed(store, "seed_refreshed", None, &added);
    }
    Ok((imported, added))
}

/// 连接成功后清掉「有新版本」标记。
pub fn mark_applied(store: &Store) {
    let conn = store.conn();
    if let Ok(Some(mut row)) = seed_cache::load(&conn) {
        if row.new_version_available {
            row.new_version_available = false;
            let _ = seed_cache::save(&conn, &row);
        }
    }
}

/// 只读状态，不联网。形状见 `commands.md` §8.1。
pub fn status(store: &Store) -> Value {
    let row = {
        let conn = store.conn();
        seed_cache::load(&conn).ok().flatten()
    };
    let Some(row) = row else {
        return json!({
            "seed_id": SEED_ID,
            "version": null,
            "content_sha256": null,
            "node_count": 0,
            "applied_at": null,
            "checked_at": null,
            "new_version_available": false,
        });
    };
    json!({
        "seed_id": SEED_ID,
        "version": row.source_version,
        "content_sha256": row.content_sha256,
        "node_count": row.node_count,
        "applied_at": row.fetched_at,
        "checked_at": row.checked_at,
        "new_version_available": row.new_version_available,
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
                    source_version: Some("1".into()),
                    source_updated_at: Some("2026-11-03T13:53:52Z".into()),
                    node_count: 2,
                    fetched_at: store::now_ms(),
                    checked_at: store::now_ms(),
                    new_version_available: false,
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
}
