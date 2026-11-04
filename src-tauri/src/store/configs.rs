//! 配置与节点。
//!
//! 一套配置 = 名字 + 连接方式 + 分流策略 + 节点集 + 当前节点 + 端口 + DNS + 内网排除。
//! 节点独立存在，通过 `config_nodes` 被多套配置引用；密码只保存
//! `secrets.enc` 的键（`password_ref`），明文永不落库。
//!
//! DDL 以 `docs/data-model.md` §3 为准。

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use serde_json::Value;

use super::db::now_ms;
use super::error::{StoreError, StoreResult};

pub const CONNECTION_SYSTEM_PROXY: &str = "system_proxy";
pub const CONNECTION_TUN: &str = "tun";

pub const ROUTING_DIRECT: &str = "direct";
pub const ROUTING_PROXY_ALL: &str = "proxy_all";
pub const ROUTING_PROXY_SELECTED: &str = "proxy_selected";

pub const SOURCE_SEED: &str = "seed";
pub const SOURCE_URL: &str = "url";
pub const SOURCE_MANUAL: &str = "manual";

pub const MAX_NAME_CHARS: usize = 40;
pub const MAX_NODE_NAME_CHARS: usize = 64;

pub const DEFAULT_DNS_JSON: &str = r#"{"mode":"auto","local":[],"remote":[]}"#;

#[derive(Debug, Clone, Serialize)]
pub struct Config {
    pub id: String,
    pub name: String,
    pub connection_mode: String,
    pub routing_mode: String,
    /// 「指定服务」的分类 id 数组，仅 proxy_selected 使用。
    pub route_targets: Value,
    /// 每次改 targets / 自定义规则 +1。
    pub route_revision: i64,
    pub listen_port: Option<u16>,
    pub dns: Value,
    pub tun_excludes: Value,
    pub current_node_id: Option<String>,
    pub is_active: bool,
    pub created_at: i64,
    pub updated_at: i64,
    pub last_used_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Node {
    pub id: String,
    pub name: String,
    pub server: String,
    pub port: u16,
    pub method: String,
    #[serde(skip_serializing)]
    pub password_ref: String,
    pub source: String,
    #[serde(skip_serializing)]
    pub source_key: String,
    pub created_at: i64,
    pub updated_at: i64,
}

pub struct NewConfig<'a> {
    pub id: &'a str,
    pub name: &'a str,
    pub connection_mode: &'a str,
    pub routing_mode: &'a str,
    pub listen_port: Option<u16>,
    pub dns: &'a Value,
    pub tun_excludes: &'a Value,
}

pub struct NewNode<'a> {
    pub id: &'a str,
    pub name: &'a str,
    pub server: &'a str,
    pub port: u16,
    pub method: &'a str,
    pub password_ref: &'a str,
    pub source: &'a str,
    pub source_key: &'a str,
}

#[derive(Debug, Default, Clone)]
pub struct ConfigPatch {
    pub name: Option<String>,
    pub routing_mode: Option<String>,
    /// `Some(None)` 表示改为自动分配（或 tun 模式必须为 NULL）。
    pub listen_port: Option<Option<u16>>,
    pub dns: Option<Value>,
    pub tun_excludes: Option<Value>,
    /// `Some(None)` 表示清空当前节点。
    pub current_node_id: Option<Option<String>>,
}

pub fn create(conn: &Connection, new: &NewConfig<'_>) -> StoreResult<Config> {
    let name = validate_name(new.name)?;
    validate_connection_mode(new.connection_mode)?;
    validate_routing_mode(new.routing_mode)?;
    validate_listen_port(new.connection_mode, new.listen_port)?;

    if name_exists(conn, &name, None)? {
        return Err(StoreError::Invalid("配置名已存在".into()));
    }

    let now = now_ms();
    conn.execute(
        "INSERT INTO configs
            (id, name, connection_mode, routing_mode, listen_port, dns_json,
             tun_excludes_json, current_node_id, is_active, created_at, updated_at, last_used_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, NULL, 0, ?8, ?8, NULL)",
        params![
            new.id,
            name,
            new.connection_mode,
            new.routing_mode,
            new.listen_port,
            json_text(new.dns, "DNS")?,
            json_text(new.tun_excludes, "内网排除")?,
            now
        ],
    )
    .map_err(map_unique_name)?;

    get(conn, new.id)?.ok_or_else(|| StoreError::NotFound(new.id.to_string()))
}

pub fn get(conn: &Connection, id: &str) -> StoreResult<Option<Config>> {
    conn.query_row(
        "SELECT id, name, connection_mode, routing_mode, route_targets_json, route_revision,
                listen_port, dns_json, tun_excludes_json, current_node_id, is_active,
                created_at, updated_at, last_used_at
           FROM configs WHERE id = ?1",
        params![id],
        row_to_config,
    )
    .optional()
    .map_err(StoreError::from)
}

/// 左栏顺序：最近使用过的在前，从未使用过的按创建时间。
pub fn list(conn: &Connection) -> StoreResult<Vec<Config>> {
    let mut statement = conn.prepare(
        "SELECT id, name, connection_mode, routing_mode, route_targets_json, route_revision,
                listen_port, dns_json, tun_excludes_json, current_node_id, is_active,
                created_at, updated_at, last_used_at
           FROM configs
          ORDER BY (last_used_at IS NULL) ASC, last_used_at DESC, created_at ASC",
    )?;
    let rows = statement.query_map([], row_to_config)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(StoreError::from)
}

pub fn active(conn: &Connection) -> StoreResult<Option<Config>> {
    conn.query_row(
        "SELECT id, name, connection_mode, routing_mode, route_targets_json, route_revision,
                listen_port, dns_json, tun_excludes_json, current_node_id, is_active,
                created_at, updated_at, last_used_at
           FROM configs WHERE is_active = 1",
        [],
        row_to_config,
    )
    .optional()
    .map_err(StoreError::from)
}

pub fn update(conn: &Connection, id: &str, patch: &ConfigPatch) -> StoreResult<Config> {
    let current = get(conn, id)?.ok_or_else(|| StoreError::NotFound(id.to_string()))?;

    let name = match &patch.name {
        Some(value) => validate_name(value)?,
        None => current.name.clone(),
    };
    let routing_mode = patch
        .routing_mode
        .clone()
        .unwrap_or_else(|| current.routing_mode.clone());
    let listen_port = patch.listen_port.unwrap_or(current.listen_port);
    let dns = patch.dns.clone().unwrap_or_else(|| current.dns.clone());
    let tun_excludes = patch
        .tun_excludes
        .clone()
        .unwrap_or_else(|| current.tun_excludes.clone());
    validate_routing_mode(&routing_mode)?;
    validate_listen_port(&current.connection_mode, listen_port)?;

    if name_exists(conn, &name, Some(id))? {
        return Err(StoreError::Invalid("配置名已存在".into()));
    }

    let current_node_id = match &patch.current_node_id {
        Some(Some(node_id)) => {
            if !is_member(conn, id, node_id)? {
                return Err(StoreError::Invalid("当前节点必须属于这套配置".into()));
            }
            Some(node_id.clone())
        }
        Some(None) => None,
        None => current.current_node_id.clone(),
    };

    conn.execute(
        "UPDATE configs
            SET name = ?2, routing_mode = ?3, listen_port = ?4, dns_json = ?5,
                tun_excludes_json = ?6, current_node_id = ?7, updated_at = ?8
          WHERE id = ?1",
        params![
            id,
            name,
            routing_mode,
            listen_port,
            json_text(&dns, "DNS")?,
            json_text(&tun_excludes, "内网排除")?,
            current_node_id,
            now_ms()
        ],
    )
    .map_err(map_unique_name)?;

    get(conn, id)?.ok_or_else(|| StoreError::NotFound(id.to_string()))
}

/// 幂等：不存在也返回 false。
pub fn delete(conn: &Connection, id: &str) -> StoreResult<bool> {
    let changed = conn.execute("DELETE FROM configs WHERE id = ?1", params![id])?;
    Ok(changed > 0)
}

/// 只改 active，不改 `last_used_at`（那是「发起连接」的时刻）。
pub fn activate(conn: &Connection, id: &str) -> StoreResult<()> {
    let tx = conn.unchecked_transaction()?;
    tx.execute("UPDATE configs SET is_active = 0 WHERE is_active = 1", [])?;
    let changed = tx.execute("UPDATE configs SET is_active = 1 WHERE id = ?1", params![id])?;
    if changed == 0 {
        return Err(StoreError::NotFound(id.to_string()));
    }
    tx.commit()?;
    Ok(())
}

pub fn mark_used(conn: &Connection, id: &str) -> StoreResult<()> {
    conn.execute(
        "UPDATE configs SET last_used_at = ?2 WHERE id = ?1",
        params![id, now_ms()],
    )?;
    Ok(())
}

/// 整体替换「指定服务」的分类集合；每次变更把 `route_revision` +1。
pub fn set_route_targets(conn: &Connection, id: &str, targets: &Value) -> StoreResult<Config> {
    conn.execute(
        "UPDATE configs
            SET route_targets_json = ?2,
                route_revision = route_revision + 1,
                updated_at = ?3
          WHERE id = ?1",
        params![id, json_text(targets, "分流目标")?, now_ms()],
    )?;
    get(conn, id)?.ok_or_else(|| StoreError::NotFound(id.to_string()))
}

pub fn upsert_node(conn: &Connection, new: &NewNode<'_>) -> StoreResult<Node> {
    validate_source(new.source)?;
    let name = validate_node_name(new.name)?;
    let server = validate_server(new.server)?;
    if new.port == 0 {
        return Err(StoreError::Invalid("端口必须在 1-65535 之间".into()));
    }
    if new.method.trim().is_empty() {
        return Err(StoreError::Invalid("加密方式不能为空".into()));
    }
    if new.password_ref.trim().is_empty() {
        return Err(StoreError::Invalid("凭据引用不能为空".into()));
    }
    if new.source_key.trim().is_empty() {
        return Err(StoreError::Invalid("去重键不能为空".into()));
    }

    let now = now_ms();
    conn.execute(
        "INSERT INTO nodes
            (id, name, server, port, method, password_ref, source, source_key, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)
         ON CONFLICT(id) DO UPDATE SET
             name = excluded.name,
             server = excluded.server,
             port = excluded.port,
             method = excluded.method,
             password_ref = excluded.password_ref,
             source = excluded.source,
             source_key = excluded.source_key,
             updated_at = excluded.updated_at",
        params![
            new.id,
            name,
            server,
            new.port,
            new.method,
            new.password_ref,
            new.source,
            new.source_key,
            now
        ],
    )
    .map_err(map_node_unique)?;

    get_node(conn, new.id)?.ok_or_else(|| StoreError::NotFound(new.id.to_string()))
}

pub fn get_node(conn: &Connection, id: &str) -> StoreResult<Option<Node>> {
    conn.query_row(
        "SELECT id, name, server, port, method, password_ref, source, source_key,
                created_at, updated_at
           FROM nodes WHERE id = ?1",
        params![id],
        row_to_node,
    )
    .optional()
    .map_err(StoreError::from)
}

/// 按 `(source, source_key)` 找已存在的节点（导入判重用）。
pub fn find_node_by_source_key(
    conn: &Connection,
    source: &str,
    source_key: &str,
) -> StoreResult<Option<Node>> {
    conn.query_row(
        "SELECT id, name, server, port, method, password_ref, source, source_key,
                created_at, updated_at
           FROM nodes WHERE source = ?1 AND source_key = ?2",
        params![source, source_key],
        row_to_node,
    )
    .optional()
    .map_err(StoreError::from)
}

pub fn delete_node(conn: &Connection, id: &str) -> StoreResult<bool> {
    let changed = conn.execute("DELETE FROM nodes WHERE id = ?1", params![id])?;
    Ok(changed > 0)
}

pub fn attach_node(conn: &Connection, config_id: &str, node_id: &str) -> StoreResult<()> {
    let next: i64 = conn.query_row(
        "SELECT COALESCE(MAX(position), -1) + 1 FROM config_nodes WHERE config_id = ?1",
        params![config_id],
        |row| row.get(0),
    )?;
    conn.execute(
        "INSERT INTO config_nodes (config_id, node_id, position)
         VALUES (?1, ?2, ?3)
         ON CONFLICT(config_id, node_id) DO NOTHING",
        params![config_id, node_id, next],
    )?;
    Ok(())
}

pub fn list_nodes(conn: &Connection, config_id: &str) -> StoreResult<Vec<Node>> {
    let mut statement = conn.prepare(
        "SELECT n.id, n.name, n.server, n.port, n.method, n.password_ref,
                n.source, n.source_key, n.created_at, n.updated_at
           FROM nodes n
           JOIN config_nodes cn ON cn.node_id = n.id
          WHERE cn.config_id = ?1
          ORDER BY cn.position ASC, n.created_at ASC",
    )?;
    let rows = statement.query_map(params![config_id], row_to_node)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(StoreError::from)
}

pub fn list_pool_nodes(conn: &Connection) -> StoreResult<Vec<Node>> {
    let mut statement = conn.prepare(
        "SELECT id, name, server, port, method, password_ref, source, source_key,
                created_at, updated_at
           FROM nodes ORDER BY created_at ASC",
    )?;
    let rows = statement.query_map([], row_to_node)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(StoreError::from)
}

pub fn list_nodes_by_source(conn: &Connection, source: &str) -> StoreResult<Vec<Node>> {
    let mut statement = conn.prepare(
        "SELECT id, name, server, port, method, password_ref, source, source_key,
                created_at, updated_at
           FROM nodes WHERE source = ?1 ORDER BY created_at ASC",
    )?;
    let rows = statement.query_map(params![source], row_to_node)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(StoreError::from)
}

/// 引用过种子节点的配置：种子刷新新增节点时自动绑到这些配置上。
pub fn config_ids_with_seed_nodes(conn: &Connection) -> StoreResult<Vec<String>> {
    let mut statement = conn.prepare(
        "SELECT DISTINCT cn.config_id
           FROM config_nodes cn
           JOIN nodes n ON n.id = cn.node_id
          WHERE n.source = ?1",
    )?;
    let rows = statement.query_map(params![SOURCE_SEED], |row| row.get::<_, String>(0))?;
    rows.collect::<Result<Vec<_>, _>>().map_err(StoreError::from)
}

pub fn config_ids_for_node(conn: &Connection, node_id: &str) -> StoreResult<Vec<String>> {
    let mut statement = conn.prepare(
        "SELECT DISTINCT config_id FROM config_nodes WHERE node_id = ?1",
    )?;
    let rows = statement.query_map(params![node_id], |row| row.get::<_, String>(0))?;
    rows.collect::<Result<Vec<_>, _>>().map_err(StoreError::from)
}

pub fn record_seed_exclusion(conn: &Connection, source_key: &str) -> StoreResult<()> {
    conn.execute(
        "INSERT INTO seed_node_exclusions (source_key, created_at)
         VALUES (?1, ?2)
         ON CONFLICT(source_key) DO NOTHING",
        params![source_key, now_ms()],
    )?;
    Ok(())
}

pub fn remove_seed_exclusion(conn: &Connection, source_key: &str) -> StoreResult<()> {
    conn.execute(
        "DELETE FROM seed_node_exclusions WHERE source_key = ?1",
        params![source_key],
    )?;
    Ok(())
}

pub fn seed_exclusions(conn: &Connection) -> StoreResult<std::collections::HashSet<String>> {
    let mut statement = conn.prepare("SELECT source_key FROM seed_node_exclusions")?;
    let rows = statement.query_map([], |row| row.get::<_, String>(0))?;
    Ok(rows.collect::<Result<std::collections::HashSet<_>, _>>()?)
}

/// 返回这些 id 里不存在的节点（一次报全）。
pub fn missing_nodes(conn: &Connection, node_ids: &[String]) -> StoreResult<Vec<String>> {
    let mut missing = Vec::new();
    for id in node_ids {
        if get_node(conn, id)?.is_none() {
            missing.push(id.clone());
        }
    }
    Ok(missing)
}

/// 整体替换节点集，顺序即新顺序。
/// 当前节点不在新集合里时落到第一个；新集合为空时置 NULL。
pub fn replace_nodes(
    conn: &Connection,
    config_id: &str,
    node_ids: &[String],
) -> StoreResult<Config> {
    let current = get(conn, config_id)?.ok_or_else(|| StoreError::NotFound(config_id.to_string()))?;
    let missing = missing_nodes(conn, node_ids)?;
    if !missing.is_empty() {
        return Err(StoreError::NotFound(missing.join(",")));
    }

    let current_still_present = current
        .current_node_id
        .as_ref()
        .map(|id| node_ids.iter().any(|candidate| candidate == id))
        .unwrap_or(false);
    let next_current = if current_still_present {
        current.current_node_id.clone()
    } else {
        node_ids.first().cloned()
    };

    let tx = conn.unchecked_transaction()?;
    tx.execute(
        "DELETE FROM config_nodes WHERE config_id = ?1",
        params![config_id],
    )?;
    for (position, node_id) in node_ids.iter().enumerate() {
        tx.execute(
            "INSERT INTO config_nodes (config_id, node_id, position) VALUES (?1, ?2, ?3)",
            params![config_id, node_id, position as i64],
        )?;
    }
    tx.execute(
        "UPDATE configs SET current_node_id = ?2, updated_at = ?3 WHERE id = ?1",
        params![config_id, next_current, now_ms()],
    )?;
    tx.commit()?;

    get(conn, config_id)?.ok_or_else(|| StoreError::NotFound(config_id.to_string()))
}

pub fn node_count(conn: &Connection, config_id: &str) -> StoreResult<i64> {
    Ok(conn.query_row(
        "SELECT COUNT(*) FROM config_nodes WHERE config_id = ?1",
        params![config_id],
        |row| row.get(0),
    )?)
}

/// 删除配置后，找出不再被任何配置引用的节点；**不自动删除**（节点是共享池）。
pub fn orphan_nodes(conn: &Connection, node_ids: &[String]) -> StoreResult<Vec<Node>> {
    let mut orphans = Vec::new();
    for node_id in node_ids {
        let referenced: i64 = conn.query_row(
            "SELECT COUNT(*) FROM config_nodes WHERE node_id = ?1",
            params![node_id],
            |row| row.get(0),
        )?;
        if referenced == 0 {
            if let Some(node) = get_node(conn, node_id)? {
                orphans.push(node);
            }
        }
    }
    Ok(orphans)
}

fn is_member(conn: &Connection, config_id: &str, node_id: &str) -> StoreResult<bool> {
    let exists: i64 = conn.query_row(
        "SELECT COUNT(*) FROM config_nodes WHERE config_id = ?1 AND node_id = ?2",
        params![config_id, node_id],
        |row| row.get(0),
    )?;
    Ok(exists > 0)
}

fn name_exists(conn: &Connection, name: &str, except_id: Option<&str>) -> StoreResult<bool> {
    let count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM configs WHERE name = ?1 AND id IS NOT ?2",
        params![name, except_id],
        |row| row.get(0),
    )?;
    Ok(count > 0)
}

fn validate_name(value: &str) -> StoreResult<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(StoreError::Invalid("配置名不能为空".into()));
    }
    if trimmed.chars().count() > MAX_NAME_CHARS {
        return Err(StoreError::Invalid(format!(
            "配置名最多 {MAX_NAME_CHARS} 个字符"
        )));
    }
    Ok(trimmed.to_string())
}

fn validate_node_name(value: &str) -> StoreResult<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(StoreError::Invalid("节点名不能为空".into()));
    }
    if trimmed.chars().count() > MAX_NODE_NAME_CHARS {
        return Err(StoreError::Invalid(format!(
            "节点名最多 {MAX_NODE_NAME_CHARS} 个字符"
        )));
    }
    Ok(trimmed.to_string())
}

fn validate_server(value: &str) -> StoreResult<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() || trimmed.len() > 253 {
        return Err(StoreError::Invalid("服务器地址不合法".into()));
    }
    if trimmed.contains("://") {
        return Err(StoreError::Invalid(
            "服务器地址只填主机名或 IP，不要带协议".into(),
        ));
    }
    if trimmed
        .chars()
        .any(|c| c.is_whitespace() || c == '/' || c == '\\' || c.is_control())
    {
        return Err(StoreError::Invalid("服务器地址包含非法字符".into()));
    }
    Ok(trimmed.to_string())
}

fn validate_connection_mode(value: &str) -> StoreResult<()> {
    if matches!(value, CONNECTION_SYSTEM_PROXY | CONNECTION_TUN) {
        Ok(())
    } else {
        Err(StoreError::Invalid(format!("不支持的连接方式：{value}")))
    }
}

fn validate_routing_mode(value: &str) -> StoreResult<()> {
    if matches!(
        value,
        ROUTING_DIRECT | ROUTING_PROXY_ALL | ROUTING_PROXY_SELECTED
    ) {
        Ok(())
    } else {
        Err(StoreError::Invalid(format!("不支持的分流策略：{value}")))
    }
}

fn validate_listen_port(connection_mode: &str, port: Option<u16>) -> StoreResult<()> {
    match (connection_mode, port) {
        (CONNECTION_TUN, Some(_)) => Err(StoreError::Invalid(
            "接管全部流量不需要代理端口".into(),
        )),
        (_, Some(0)) => Err(StoreError::Invalid("端口必须在 1-65535 之间".into())),
        _ => Ok(()),
    }
}

fn validate_source(value: &str) -> StoreResult<()> {
    if matches!(value, SOURCE_SEED | SOURCE_URL | SOURCE_MANUAL) {
        Ok(())
    } else {
        Err(StoreError::Invalid(format!("不支持的节点来源：{value}")))
    }
}

fn json_text(value: &Value, field: &str) -> StoreResult<String> {
    serde_json::to_string(value)
        .map_err(|error| StoreError::Invalid(format!("{field}不是合法 JSON：{error}")))
}

fn parse_json_field(text: &str, fallback: Value) -> Value {
    serde_json::from_str(text).unwrap_or(fallback)
}

fn map_unique_name(error: rusqlite::Error) -> StoreError {
    if is_constraint(&error) {
        return StoreError::Invalid("配置名已存在".into());
    }
    StoreError::Sqlite(error)
}

fn map_node_unique(error: rusqlite::Error) -> StoreError {
    if is_constraint(&error) {
        return StoreError::Invalid("同一来源里已经有相同的节点".into());
    }
    StoreError::Sqlite(error)
}

fn is_constraint(error: &rusqlite::Error) -> bool {
    matches!(
        error,
        rusqlite::Error::SqliteFailure(inner, _)
            if inner.code == rusqlite::ErrorCode::ConstraintViolation
    )
}

fn row_to_config(row: &rusqlite::Row<'_>) -> rusqlite::Result<Config> {
    Ok(Config {
        id: row.get(0)?,
        name: row.get(1)?,
        connection_mode: row.get(2)?,
        routing_mode: row.get(3)?,
        route_targets: parse_json_field(&row.get::<_, String>(4)?, serde_json::json!([])),
        route_revision: row.get(5)?,
        listen_port: row.get::<_, Option<i64>>(6)?.map(|port| port as u16),
        dns: parse_json_field(
            &row.get::<_, String>(7)?,
            serde_json::json!({ "mode": "auto", "local": [], "remote": [] }),
        ),
        tun_excludes: parse_json_field(&row.get::<_, String>(8)?, serde_json::json!([])),
        current_node_id: row.get(9)?,
        is_active: row.get::<_, i64>(10)? == 1,
        created_at: row.get(11)?,
        updated_at: row.get(12)?,
        last_used_at: row.get(13)?,
    })
}

fn row_to_node(row: &rusqlite::Row<'_>) -> rusqlite::Result<Node> {
    Ok(Node {
        id: row.get(0)?,
        name: row.get(1)?,
        server: row.get(2)?,
        port: row.get::<_, i64>(3)? as u16,
        method: row.get(4)?,
        password_ref: row.get(5)?,
        source: row.get(6)?,
        source_key: row.get(7)?,
        created_at: row.get(8)?,
        updated_at: row.get(9)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::Store;
    use serde_json::json;

    fn auto_dns() -> &'static Value {
        static VALUE: std::sync::OnceLock<Value> = std::sync::OnceLock::new();
        VALUE.get_or_init(|| json!({ "mode": "auto", "local": [], "remote": [] }))
    }

    fn no_excludes() -> &'static Value {
        static VALUE: std::sync::OnceLock<Value> = std::sync::OnceLock::new();
        VALUE.get_or_init(|| json!([]))
    }

    fn config<'a>(id: &'a str, name: &'a str) -> NewConfig<'a> {
        NewConfig {
            id,
            name,
            connection_mode: CONNECTION_SYSTEM_PROXY,
            routing_mode: ROUTING_PROXY_ALL,
            listen_port: Some(7890),
            dns: auto_dns(),
            tun_excludes: no_excludes(),
        }
    }

    fn node<'a>(id: &'a str, server: &'a str) -> NewNode<'a> {
        NewNode {
            id,
            name: id,
            server,
            port: 8388,
            method: "aes-256-gcm",
            password_ref: "node:pw",
            source: SOURCE_MANUAL,
            source_key: id,
        }
    }

    #[test]
    fn create_then_list_round_trips() {
        let store = Store::open_in_memory().unwrap();
        let conn = store.conn();
        let created = create(&conn, &config("cfg_1", "家里 · 本机代理")).unwrap();
        assert_eq!(created.name, "家里 · 本机代理");
        assert_eq!(created.listen_port, Some(7890));
        assert!(!created.is_active);
        assert_eq!(created.dns["mode"], "auto");

        let all = list(&conn).unwrap();
        assert_eq!(all.len(), 1);
    }

    #[test]
    fn names_are_trimmed_limited_and_unique() {
        let store = Store::open_in_memory().unwrap();
        let conn = store.conn();
        create(&conn, &config("cfg_1", "  家里  ")).unwrap();
        assert_eq!(get(&conn, "cfg_1").unwrap().unwrap().name, "家里");

        let error = create(&conn, &config("cfg_2", "家里")).unwrap_err();
        assert!(matches!(error, StoreError::Invalid(_)));

        let too_long = "汉".repeat(MAX_NAME_CHARS + 1);
        assert!(create(&conn, &config("cfg_3", &too_long)).is_err());
    }

    #[test]
    fn only_one_config_is_active() {
        let store = Store::open_in_memory().unwrap();
        let conn = store.conn();
        create(&conn, &config("cfg_1", "A")).unwrap();
        create(&conn, &config("cfg_2", "B")).unwrap();

        activate(&conn, "cfg_1").unwrap();
        activate(&conn, "cfg_2").unwrap();

        assert_eq!(active(&conn).unwrap().unwrap().id, "cfg_2");
        assert_eq!(list(&conn).unwrap().iter().filter(|c| c.is_active).count(), 1);
    }

    #[test]
    fn activate_does_not_touch_last_used_at() {
        let store = Store::open_in_memory().unwrap();
        let conn = store.conn();
        create(&conn, &config("cfg_1", "A")).unwrap();
        activate(&conn, "cfg_1").unwrap();
        assert!(get(&conn, "cfg_1").unwrap().unwrap().last_used_at.is_none());
        mark_used(&conn, "cfg_1").unwrap();
        assert!(get(&conn, "cfg_1").unwrap().unwrap().last_used_at.is_some());
    }

    #[test]
    fn tun_config_has_no_listen_port() {
        let store = Store::open_in_memory().unwrap();
        let conn = store.conn();
        let mut tun = config("cfg_1", "A");
        tun.connection_mode = CONNECTION_TUN;
        assert!(create(&conn, &tun).is_err());
        tun.listen_port = None;
        assert!(create(&conn, &tun).is_ok());
    }

    #[test]
    fn a_node_can_be_shared_by_two_configs() {
        let store = Store::open_in_memory().unwrap();
        let conn = store.conn();
        create(&conn, &config("cfg_1", "A")).unwrap();
        create(&conn, &config("cfg_2", "B")).unwrap();
        upsert_node(&conn, &node("node_1", "203.0.113.10")).unwrap();

        attach_node(&conn, "cfg_1", "node_1").unwrap();
        attach_node(&conn, "cfg_2", "node_1").unwrap();
        assert_eq!(list_nodes(&conn, "cfg_1").unwrap().len(), 1);
        assert_eq!(list_nodes(&conn, "cfg_2").unwrap().len(), 1);

        delete(&conn, "cfg_1").unwrap();
        assert_eq!(list_nodes(&conn, "cfg_2").unwrap().len(), 1);
        assert!(get_node(&conn, "node_1").unwrap().is_some());
    }

    #[test]
    fn replacing_nodes_updates_current_node() {
        let store = Store::open_in_memory().unwrap();
        let conn = store.conn();
        create(&conn, &config("cfg_1", "A")).unwrap();
        upsert_node(&conn, &node("node_1", "203.0.113.10")).unwrap();
        upsert_node(&conn, &node("node_2", "203.0.113.11")).unwrap();
        attach_node(&conn, "cfg_1", "node_1").unwrap();
        update(
            &conn,
            "cfg_1",
            &ConfigPatch {
                current_node_id: Some(Some("node_1".into())),
                ..Default::default()
            },
        )
        .unwrap();

        replace_nodes(&conn, "cfg_1", &["node_2".to_string()]).unwrap();
        let config = get(&conn, "cfg_1").unwrap().unwrap();
        assert_eq!(config.current_node_id.as_deref(), Some("node_2"));
        assert_eq!(list_nodes(&conn, "cfg_1").unwrap().len(), 1);
    }

    #[test]
    fn current_node_must_belong_to_the_config() {
        let store = Store::open_in_memory().unwrap();
        let conn = store.conn();
        create(&conn, &config("cfg_1", "A")).unwrap();
        upsert_node(&conn, &node("node_1", "203.0.113.10")).unwrap();

        let error = update(
            &conn,
            "cfg_1",
            &ConfigPatch {
                current_node_id: Some(Some("node_1".into())),
                ..Default::default()
            },
        )
        .unwrap_err();
        assert!(matches!(error, StoreError::Invalid(_)));
    }

    #[test]
    fn duplicate_source_and_source_key_is_rejected() {
        let store = Store::open_in_memory().unwrap();
        let conn = store.conn();
        upsert_node(&conn, &node("node_1", "203.0.113.10")).unwrap();
        let mut second = node("node_2", "203.0.113.10");
        second.source_key = "node_1";
        assert!(upsert_node(&conn, &second).is_err());
    }

    #[test]
    fn invalid_server_is_rejected_before_touching_the_database() {
        let store = Store::open_in_memory().unwrap();
        let conn = store.conn();
        for server in ["", "https://x", "a b", "a/b"] {
            assert!(upsert_node(&conn, &node("node_1", server)).is_err(), "{server}");
        }
    }

    #[test]
    fn seed_exclusions_round_trip() {
        let store = Store::open_in_memory().unwrap();
        let conn = store.conn();
        assert!(seed_exclusions(&conn).unwrap().is_empty());

        record_seed_exclusion(&conn, "key-a").unwrap();
        record_seed_exclusion(&conn, "key-a").unwrap();
        record_seed_exclusion(&conn, "key-b").unwrap();
        let excluded = seed_exclusions(&conn).unwrap();
        assert_eq!(excluded.len(), 2);
        assert!(excluded.contains("key-a"));

        remove_seed_exclusion(&conn, "key-a").unwrap();
        assert_eq!(seed_exclusions(&conn).unwrap().len(), 1);
    }

    #[test]
    fn config_ids_with_seed_nodes_ignores_manual_nodes() {
        let store = Store::open_in_memory().unwrap();
        let conn = store.conn();
        create(&conn, &config("cfg_1", "A")).unwrap();
        create(&conn, &config("cfg_2", "B")).unwrap();
        upsert_node(
            &conn,
            &NewNode {
                id: "nod_seed",
                name: "seed",
                server: "203.0.113.10",
                port: 8388,
                method: "aes-256-gcm",
                password_ref: "node:nod_seed",
                source: SOURCE_SEED,
                source_key: "key-seed",
            },
        )
        .unwrap();
        attach_node(&conn, "cfg_1", "nod_seed").unwrap();
        upsert_node(&conn, &node("nod_manual", "203.0.113.11")).unwrap();
        attach_node(&conn, "cfg_2", "nod_manual").unwrap();

        assert_eq!(config_ids_with_seed_nodes(&conn).unwrap(), vec!["cfg_1"]);
    }
}
