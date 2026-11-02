use rusqlite::{params, Connection, OptionalExtension};
use serde_json::Value;

use super::db::now_ms;
use super::error::{StoreError, StoreResult};

#[derive(Debug, Clone)]
pub struct ProxyBackupRow {
    pub platform: String,
    pub endpoint: String,
    pub payload: Value,
    pub created_at: i64,
}

pub fn load(conn: &Connection) -> StoreResult<Option<ProxyBackupRow>> {
    conn.query_row(
        "SELECT platform, endpoint, payload_json, created_at FROM proxy_backup WHERE id = 1",
        [],
        |row| {
            let payload_json: String = row.get(2)?;
            Ok(ProxyBackupRow {
                platform: row.get(0)?,
                endpoint: row.get(1)?,
                payload: serde_json::from_str(&payload_json).unwrap_or(Value::Null),
                created_at: row.get(3)?,
            })
        },
    )
    .optional()
    .map_err(StoreError::from)
}

pub fn save(
    conn: &Connection,
    platform: &str,
    endpoint: &str,
    payload: &Value,
) -> StoreResult<()> {
    conn.execute(
        "INSERT INTO proxy_backup (id, platform, endpoint, payload_json, created_at)
         VALUES (1, ?1, ?2, ?3, ?4)
         ON CONFLICT(id) DO UPDATE SET
             platform = excluded.platform,
             endpoint = excluded.endpoint,
             payload_json = excluded.payload_json,
             created_at = excluded.created_at",
        params![platform, endpoint, payload.to_string(), now_ms()],
    )?;
    Ok(())
}

pub fn clear(conn: &Connection) -> StoreResult<()> {
    conn.execute("DELETE FROM proxy_backup WHERE id = 1", [])?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn save_load_then_clear() {
        let store = super::super::db::Store::open_in_memory().unwrap();
        let conn = store.conn();

        assert!(load(&conn).unwrap().is_none());
        save(
            &conn,
            "macos",
            "127.0.0.1:2080",
            &json!({ "services": [] }),
        )
        .unwrap();

        let row = load(&conn).unwrap().unwrap();
        assert_eq!(row.endpoint, "127.0.0.1:2080");
        assert_eq!(row.platform, "macos");

        clear(&conn).unwrap();
        assert!(load(&conn).unwrap().is_none());
    }

    #[test]
    fn saving_twice_keeps_a_single_row() {
        let store = super::super::db::Store::open_in_memory().unwrap();
        let conn = store.conn();

        save(&conn, "macos", "127.0.0.1:2080", &json!({})).unwrap();
        save(&conn, "macos", "127.0.0.1:2090", &json!({})).unwrap();

        assert_eq!(load(&conn).unwrap().unwrap().endpoint, "127.0.0.1:2090");
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM proxy_backup", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 1);
    }
}
