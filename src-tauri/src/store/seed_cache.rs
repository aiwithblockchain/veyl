//! 种子缓存元数据。原文（含节点密码）加密存在 `secrets.enc`。

use rusqlite::{params, Connection, OptionalExtension};

use super::error::{StoreError, StoreResult};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SeedCacheRow {
    pub content_sha256: String,
    pub etag: Option<String>,
    pub source_version: Option<String>,
    pub source_updated_at: Option<String>,
    pub node_count: i64,
    pub fetched_at: i64,
    pub checked_at: i64,
    pub new_version_available: bool,
}

pub fn load(conn: &Connection) -> StoreResult<Option<SeedCacheRow>> {
    conn.query_row(
        "SELECT content_sha256, etag, source_version, source_updated_at, node_count,
                fetched_at, checked_at, new_version_available
           FROM seed_cache WHERE id = 1",
        [],
        |row| {
            Ok(SeedCacheRow {
                content_sha256: row.get(0)?,
                etag: row.get(1)?,
                source_version: row.get(2)?,
                source_updated_at: row.get(3)?,
                node_count: row.get(4)?,
                fetched_at: row.get(5)?,
                checked_at: row.get(6)?,
                new_version_available: row.get::<_, i64>(7)? != 0,
            })
        },
    )
    .optional()
    .map_err(StoreError::from)
}

pub fn save(conn: &Connection, row: &SeedCacheRow) -> StoreResult<()> {
    conn.execute(
        "INSERT INTO seed_cache
            (id, content_sha256, etag, source_version, source_updated_at,
             node_count, fetched_at, checked_at, new_version_available)
         VALUES (1, ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
         ON CONFLICT(id) DO UPDATE SET
            content_sha256 = excluded.content_sha256,
            etag = excluded.etag,
            source_version = excluded.source_version,
            source_updated_at = excluded.source_updated_at,
            node_count = excluded.node_count,
            fetched_at = excluded.fetched_at,
            checked_at = excluded.checked_at,
            new_version_available = excluded.new_version_available",
        params![
            row.content_sha256,
            row.etag,
            row.source_version,
            row.source_updated_at,
            row.node_count,
            row.fetched_at,
            row.checked_at,
            if row.new_version_available { 1 } else { 0 }
        ],
    )?;
    Ok(())
}

/// 304 或内容没变：只更新最近检查时间与 etag。
pub fn touch(conn: &Connection, checked_at: i64, etag: Option<&str>) -> StoreResult<()> {
    conn.execute(
        "UPDATE seed_cache
            SET checked_at = ?1,
                etag = COALESCE(?2, etag)
          WHERE id = 1",
        params![checked_at, etag],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::Store;

    fn row() -> SeedCacheRow {
        SeedCacheRow {
            content_sha256: "abc".into(),
            etag: Some("\"v1\"".into()),
            source_version: Some("1".into()),
            source_updated_at: Some("2026-11-03T13:53:52Z".into()),
            node_count: 2,
            fetched_at: 1,
            checked_at: 2,
            new_version_available: false,
        }
    }

    #[test]
    fn round_trips_and_updates_in_place() {
        let store = Store::open_in_memory().unwrap();
        let conn = store.conn();
        assert!(load(&conn).unwrap().is_none());

        save(&conn, &row()).unwrap();
        let loaded = load(&conn).unwrap().unwrap();
        assert_eq!(loaded.content_sha256, "abc");
        assert_eq!(loaded.source_version.as_deref(), Some("1"));

        let mut next = row();
        next.content_sha256 = "def".into();
        next.new_version_available = true;
        save(&conn, &next).unwrap();
        assert!(load(&conn).unwrap().unwrap().new_version_available);
    }

    #[test]
    fn touch_keeps_the_content_identity() {
        let store = Store::open_in_memory().unwrap();
        let conn = store.conn();
        save(&conn, &row()).unwrap();
        touch(&conn, 99, Some("\"v2\"")).unwrap();
        let loaded = load(&conn).unwrap().unwrap();
        assert_eq!(loaded.checked_at, 99);
        assert_eq!(loaded.etag.as_deref(), Some("\"v2\""));
        assert_eq!(loaded.content_sha256, "abc");
    }
}
