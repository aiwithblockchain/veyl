use std::collections::HashMap;

use rusqlite::{params, Connection, OptionalExtension};

use super::error::{StoreError, StoreResult};

pub fn get(conn: &Connection, key: &str) -> StoreResult<Option<String>> {
    conn.query_row("SELECT value FROM settings WHERE key = ?1", params![key], |row| {
        row.get(0)
    })
    .optional()
    .map_err(StoreError::from)
}

pub fn set(conn: &Connection, key: &str, value: &str) -> StoreResult<()> {
    conn.execute(
        "INSERT INTO settings (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )?;
    Ok(())
}

pub fn delete(conn: &Connection, key: &str) -> StoreResult<()> {
    conn.execute("DELETE FROM settings WHERE key = ?1", params![key])?;
    Ok(())
}

pub fn all(conn: &Connection) -> StoreResult<HashMap<String, String>> {
    let mut statement = conn.prepare("SELECT key, value FROM settings")?;
    let rows = statement.query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?;
    rows.collect::<Result<HashMap<_, _>, _>>()
        .map_err(StoreError::from)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn set_overwrites_and_delete_removes() {
        let store = super::super::db::Store::open_in_memory().unwrap();
        let conn = store.conn();

        assert!(get(&conn, "proxy_port").unwrap().is_none());
        set(&conn, "proxy_port", "2080").unwrap();
        set(&conn, "proxy_port", "2081").unwrap();
        assert_eq!(get(&conn, "proxy_port").unwrap().as_deref(), Some("2081"));

        delete(&conn, "proxy_port").unwrap();
        assert!(get(&conn, "proxy_port").unwrap().is_none());
        delete(&conn, "proxy_port").unwrap();
    }

    #[test]
    fn all_returns_every_key() {
        let store = super::super::db::Store::open_in_memory().unwrap();
        let conn = store.conn();
        set(&conn, "a", "1").unwrap();
        set(&conn, "b", "2").unwrap();

        let map = all(&conn).unwrap();
        assert_eq!(map.len(), 2);
        assert_eq!(map["b"], "2");
    }
}
