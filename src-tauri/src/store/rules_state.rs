//! 当前生效的规则数据版本。规则文件在 `app_data/rules/<version>/`，不进库。

use rusqlite::{params, Connection, OptionalExtension};

use super::error::{StoreError, StoreResult};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RulesState {
    pub active_version: String,
    pub manifest_sha256: String,
    pub bundled_version: String,
    pub geosite_tag: Option<String>,
    pub geoip_tag: Option<String>,
    pub item_count: i64,
    pub total_bytes: i64,
    pub applied_at: i64,
    pub checked_at: Option<i64>,
}

pub fn load(conn: &Connection) -> StoreResult<Option<RulesState>> {
    conn.query_row(
        "SELECT active_version, manifest_sha256, bundled_version, geosite_tag, geoip_tag,
                item_count, total_bytes, applied_at, checked_at
           FROM rules_state WHERE id = 1",
        [],
        |row| {
            Ok(RulesState {
                active_version: row.get(0)?,
                manifest_sha256: row.get(1)?,
                bundled_version: row.get(2)?,
                geosite_tag: row.get(3)?,
                geoip_tag: row.get(4)?,
                item_count: row.get(5)?,
                total_bytes: row.get(6)?,
                applied_at: row.get(7)?,
                checked_at: row.get(8)?,
            })
        },
    )
    .optional()
    .map_err(StoreError::from)
}

pub fn save(conn: &Connection, state: &RulesState) -> StoreResult<()> {
    conn.execute(
        "INSERT INTO rules_state
            (id, active_version, manifest_sha256, bundled_version, geosite_tag, geoip_tag,
             item_count, total_bytes, applied_at, checked_at)
         VALUES (1, ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
         ON CONFLICT(id) DO UPDATE SET
            active_version = excluded.active_version,
            manifest_sha256 = excluded.manifest_sha256,
            bundled_version = excluded.bundled_version,
            geosite_tag = excluded.geosite_tag,
            geoip_tag = excluded.geoip_tag,
            item_count = excluded.item_count,
            total_bytes = excluded.total_bytes,
            applied_at = excluded.applied_at,
            checked_at = excluded.checked_at",
        params![
            state.active_version,
            state.manifest_sha256,
            state.bundled_version,
            state.geosite_tag,
            state.geoip_tag,
            state.item_count,
            state.total_bytes,
            state.applied_at,
            state.checked_at
        ],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::Store;

    #[test]
    fn round_trips_and_updates_in_place() {
        let store = Store::open_in_memory().unwrap();
        let conn = store.conn();
        assert!(load(&conn).unwrap().is_none());

        let mut state = RulesState {
            active_version: "2026-11-03.1".into(),
            manifest_sha256: "abc".into(),
            bundled_version: "2026-11-03.1".into(),
            geosite_tag: Some("rule-set@aaaa".into()),
            geoip_tag: Some("rule-set@bbbb".into()),
            item_count: 2233,
            total_bytes: 2_250_000,
            applied_at: 1,
            checked_at: None,
        };
        save(&conn, &state).unwrap();
        assert_eq!(load(&conn).unwrap().unwrap().active_version, "2026-11-03.1");

        state.active_version = "2026-11-04.1".into();
        state.checked_at = Some(2);
        save(&conn, &state).unwrap();
        let loaded = load(&conn).unwrap().unwrap();
        assert_eq!(loaded.active_version, "2026-11-04.1");
        assert_eq!(loaded.checked_at, Some(2));
    }
}
