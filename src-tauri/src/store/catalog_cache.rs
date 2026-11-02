use rusqlite::{params, Connection, OptionalExtension};
use serde_json::Value;

use super::db::now_ms;
use super::error::{StoreError, StoreResult};

#[derive(Debug, Clone)]
pub struct CacheEntry {
    pub cache_key: String,
    pub etag: Option<String>,
    pub body: Value,
    pub fetched_at: i64,
    pub http_status: i64,
}

pub fn get(conn: &Connection, key: &str) -> StoreResult<Option<CacheEntry>> {
    conn.query_row(
        "SELECT cache_key, etag, body_json, fetched_at, http_status
           FROM catalog_cache WHERE cache_key = ?1",
        params![key],
        |row| {
            let body_json: String = row.get(2)?;
            Ok(CacheEntry {
                cache_key: row.get(0)?,
                etag: row.get(1)?,
                body: serde_json::from_str(&body_json).unwrap_or(Value::Null),
                fetched_at: row.get(3)?,
                http_status: row.get(4)?,
            })
        },
    )
    .optional()
    .map_err(StoreError::from)
}

pub fn put(
    conn: &Connection,
    key: &str,
    etag: Option<&str>,
    body: &Value,
    http_status: i64,
) -> StoreResult<()> {
    conn.execute(
        "INSERT INTO catalog_cache (cache_key, etag, body_json, fetched_at, http_status)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(cache_key) DO UPDATE SET
             etag = excluded.etag,
             body_json = excluded.body_json,
             fetched_at = excluded.fetched_at,
             http_status = excluded.http_status",
        params![key, etag, body.to_string(), now_ms(), http_status],
    )?;
    Ok(())
}

pub fn clear(conn: &Connection) -> StoreResult<()> {
    conn.execute("DELETE FROM catalog_cache", [])?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn put_then_get_upserts_by_key() {
        let store = super::super::db::Store::open_in_memory().unwrap();
        let conn = store.conn();

        assert!(get(&conn, "nodes:jp").unwrap().is_none());
        put(&conn, "nodes:jp", Some("v1"), &json!({ "nodes": [] }), 200).unwrap();
        put(&conn, "nodes:jp", Some("v2"), &json!({ "nodes": [1] }), 200).unwrap();

        let entry = get(&conn, "nodes:jp").unwrap().unwrap();
        assert_eq!(entry.etag.as_deref(), Some("v2"));
        assert_eq!(entry.body["nodes"][0], 1);
        assert_eq!(entry.http_status, 200);

        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM catalog_cache", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 1);
    }

    #[test]
    fn clear_removes_everything() {
        let store = super::super::db::Store::open_in_memory().unwrap();
        let conn = store.conn();
        put(&conn, "a", None, &json!({}), 200).unwrap();
        clear(&conn).unwrap();
        assert!(get(&conn, "a").unwrap().is_none());
    }
}
