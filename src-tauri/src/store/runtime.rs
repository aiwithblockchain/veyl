use rusqlite::{params, Connection};

use super::error::{StoreError, StoreResult};

#[derive(Debug, Clone)]
pub struct RuntimeVersionRow {
    pub version: String,
    pub path: String,
    pub binary_path: String,
    pub sha256: String,
    /// installed / active / failed
    pub state: String,
    pub installed_at: i64,
}


pub fn upsert_version(conn: &Connection, row: &RuntimeVersionRow) -> StoreResult<()> {
    conn.execute(
        "INSERT INTO runtime_versions (version, path, binary_path, sha256, state, installed_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(version) DO UPDATE SET
             path = excluded.path,
             binary_path = excluded.binary_path,
             sha256 = excluded.sha256,
             state = excluded.state,
             installed_at = excluded.installed_at",
        params![
            row.version,
            row.path,
            row.binary_path,
            row.sha256,
            row.state,
            row.installed_at
        ],
    )?;
    Ok(())
}

pub fn list_versions(conn: &Connection) -> StoreResult<Vec<RuntimeVersionRow>> {
    let mut statement = conn.prepare(
        "SELECT version, path, binary_path, sha256, state, installed_at
           FROM runtime_versions ORDER BY installed_at ASC",
    )?;
    let rows = statement.query_map([], |row| {
        Ok(RuntimeVersionRow {
            version: row.get(0)?,
            path: row.get(1)?,
            binary_path: row.get(2)?,
            sha256: row.get(3)?,
            state: row.get(4)?,
            installed_at: row.get(5)?,
        })
    })?;
    rows.collect::<Result<Vec<_>, _>>().map_err(StoreError::from)
}



#[cfg(test)]
mod tests {
    use super::*;

    fn version(name: &str) -> RuntimeVersionRow {
        RuntimeVersionRow {
            version: name.into(),
            path: format!("/tmp/veyl/runtime/{name}"),
            binary_path: format!("/tmp/veyl/runtime/{name}/sing-box"),
            sha256: "0".repeat(64),
            state: "installed".into(),
            installed_at: 1,
        }
    }

    #[test]
    fn versions_upsert_by_version() {
        let store = super::super::db::Store::open_in_memory().unwrap();
        let conn = store.conn();

        upsert_version(&conn, &version("1.14.4")).unwrap();
        let mut updated = version("1.14.4");
        updated.state = "active".into();
        upsert_version(&conn, &updated).unwrap();

        let rows = list_versions(&conn).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].state, "active");
    }

}
