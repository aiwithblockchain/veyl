use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::db::now_ms;
use super::error::{StoreError, StoreResult};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Profile {
    pub id: String,
    pub node_id: Option<String>,
    pub name: String,
    pub protocol: Option<String>,
    pub region: Option<String>,
    /// 非凭据部分：server / port / tls / flow。
    pub config: Value,
    pub is_active: bool,
    pub created_at: i64,
}

#[derive(Debug, Clone)]
pub struct NewProfile<'a> {
    pub id: &'a str,
    pub node_id: Option<&'a str>,
    pub name: &'a str,
    pub protocol: Option<&'a str>,
    pub region: Option<&'a str>,
    pub config: &'a Value,
}

pub fn create(conn: &Connection, new: &NewProfile<'_>) -> StoreResult<Profile> {
    ensure_no_credentials(new.config)?;
    let created_at = now_ms();
    conn.execute(
        "INSERT INTO profiles (id, node_id, name, protocol, region, config_json, is_active, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, ?7)",
        params![
            new.id,
            new.node_id,
            new.name,
            new.protocol,
            new.region,
            new.config.to_string(),
            created_at
        ],
    )?;
    get(conn, new.id)?.ok_or_else(|| StoreError::NotFound(new.id.to_string()))
}

/// 幂等写入：同 id 覆盖字段，但**不改变** `is_active`（不会把用户正在用的配置顶掉）。
pub fn upsert(conn: &Connection, new: &NewProfile<'_>) -> StoreResult<Profile> {
    ensure_no_credentials(new.config)?;
    conn.execute(
        "INSERT INTO profiles (id, node_id, name, protocol, region, config_json, is_active, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, ?7)
         ON CONFLICT(id) DO UPDATE SET
             node_id = excluded.node_id,
             name = excluded.name,
             protocol = excluded.protocol,
             region = excluded.region,
             config_json = excluded.config_json",
        params![
            new.id,
            new.node_id,
            new.name,
            new.protocol,
            new.region,
            new.config.to_string(),
            now_ms()
        ],
    )?;
    get(conn, new.id)?.ok_or_else(|| StoreError::NotFound(new.id.to_string()))
}

pub fn get(conn: &Connection, id: &str) -> StoreResult<Option<Profile>> {
    conn.query_row(
        "SELECT id, node_id, name, protocol, region, config_json, is_active, created_at
           FROM profiles WHERE id = ?1",
        params![id],
        row_to_profile,
    )
    .optional()
    .map_err(StoreError::from)
}

pub fn list(conn: &Connection) -> StoreResult<Vec<Profile>> {
    let mut statement = conn.prepare(
        "SELECT id, node_id, name, protocol, region, config_json, is_active, created_at
           FROM profiles ORDER BY created_at ASC",
    )?;
    let rows = statement.query_map([], row_to_profile)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(StoreError::from)
}

pub fn active(conn: &Connection) -> StoreResult<Option<Profile>> {
    conn.query_row(
        "SELECT id, node_id, name, protocol, region, config_json, is_active, created_at
           FROM profiles WHERE is_active = 1",
        [],
        row_to_profile,
    )
    .optional()
    .map_err(StoreError::from)
}

/// 幂等：不存在也返回成功。
pub fn delete(conn: &Connection, id: &str) -> StoreResult<()> {
    conn.execute("DELETE FROM profiles WHERE id = ?1", params![id])?;
    Ok(())
}

pub fn set_active(conn: &Connection, id: &str) -> StoreResult<()> {
    let tx = conn.unchecked_transaction()?;
    tx.execute("UPDATE profiles SET is_active = 0 WHERE is_active = 1", [])?;
    let changed = tx.execute(
        "UPDATE profiles SET is_active = 1 WHERE id = ?1",
        params![id],
    )?;
    if changed == 0 {
        return Err(StoreError::NotFound(id.to_string()));
    }
    tx.commit()?;
    Ok(())
}

pub fn clear_active(conn: &Connection) -> StoreResult<()> {
    conn.execute("UPDATE profiles SET is_active = 0 WHERE is_active = 1", [])?;
    Ok(())
}

fn row_to_profile(row: &rusqlite::Row<'_>) -> rusqlite::Result<Profile> {
    let config_json: String = row.get(5)?;
    Ok(Profile {
        id: row.get(0)?,
        node_id: row.get(1)?,
        name: row.get(2)?,
        protocol: row.get(3)?,
        region: row.get(4)?,
        config: serde_json::from_str(&config_json).unwrap_or(Value::Null),
        is_active: row.get::<_, i64>(6)? == 1,
        created_at: row.get(7)?,
    })
}

/// 凭据隔离的最后一道闸：配置里出现这些键就拒绝写入。
fn ensure_no_credentials(value: &Value) -> StoreResult<()> {
    const FORBIDDEN: [&str; 4] = ["credentials", "uuid", "password", "private_key"];

    fn walk(value: &Value) -> bool {
        match value {
            Value::Object(map) => map
                .iter()
                .any(|(key, child)| FORBIDDEN.contains(&key.as_str()) || walk(child)),
            Value::Array(items) => items.iter().any(walk),
            _ => false,
        }
    }

    if walk(value) {
        return Err(StoreError::Invalid(
            "profile 配置里不允许出现凭据字段（credentials/uuid/password/private_key）".into(),
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn sample() -> Value {
        json!({ "server": "203.0.113.10", "server_port": 443, "tls": { "server_name": "www.example.com" } })
    }

    #[test]
    fn create_then_list_round_trips() {
        let store = super::super::db::Store::open_in_memory().unwrap();
        let conn = store.conn();
        let profile = create(
            &conn,
            &NewProfile {
                id: "prf_1",
                node_id: Some("seed-jp-01"),
                name: "东京 01",
                protocol: Some("vless_reality"),
                region: Some("jp"),
                config: &sample(),
            },
        )
        .unwrap();
        assert_eq!(profile.name, "东京 01");
        assert!(!profile.is_active);

        let all = list(&conn).unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].config["server"], "203.0.113.10");
    }

    #[test]
    fn only_one_profile_can_be_active() {
        let store = super::super::db::Store::open_in_memory().unwrap();
        let conn = store.conn();
        for id in ["prf_1", "prf_2"] {
            create(
                &conn,
                &NewProfile {
                    id,
                    node_id: None,
                    name: id,
                    protocol: None,
                    region: None,
                    config: &sample(),
                },
            )
            .unwrap();
        }

        set_active(&conn, "prf_1").unwrap();
        set_active(&conn, "prf_2").unwrap();

        assert_eq!(active(&conn).unwrap().unwrap().id, "prf_2");
        assert_eq!(list(&conn).unwrap().iter().filter(|p| p.is_active).count(), 1);
    }

    #[test]
    fn deleting_a_missing_profile_is_ok() {
        let store = super::super::db::Store::open_in_memory().unwrap();
        delete(&store.conn(), "prf_missing").unwrap();
    }

    #[test]
    fn credentials_are_rejected_on_write() {
        let store = super::super::db::Store::open_in_memory().unwrap();
        let conn = store.conn();
        let err = create(
            &conn,
            &NewProfile {
                id: "prf_bad",
                node_id: None,
                name: "bad",
                protocol: None,
                region: None,
                config: &json!({ "credentials": { "uuid": "x" } }),
            },
        )
        .unwrap_err();
        assert!(matches!(err, StoreError::Invalid(_)));
        assert!(list(&conn).unwrap().is_empty());
    }

    #[test]
    fn setting_active_on_a_missing_profile_fails() {
        let store = super::super::db::Store::open_in_memory().unwrap();
        let err = set_active(&store.conn(), "prf_missing").unwrap_err();
        assert!(matches!(err, StoreError::NotFound(_)));
    }
}
