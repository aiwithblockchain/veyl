use std::collections::HashMap;

use rusqlite::{params, Connection, OptionalExtension};

use super::error::{StoreError, StoreResult};

/// 本地代理端口（用户设置）。值是十进制字符串；缺失或损坏时回落默认值。
pub const PROXY_PORT_KEY: &str = "proxy_port";

/// 读用户设置的代理端口。**读不写库**：从未设置过时返回默认值。
pub fn proxy_port(conn: &Connection) -> u16 {
    get(conn, PROXY_PORT_KEY)
        .ok()
        .flatten()
        .and_then(|value| value.trim().parse::<u16>().ok())
        .filter(|port| *port > 0)
        .unwrap_or(crate::config::ports::DEFAULT_PROXY_PORT)
}

/// 保存用户设置的代理端口。
pub fn set_proxy_port(conn: &Connection, port: u16) -> StoreResult<()> {
    set(conn, PROXY_PORT_KEY, &port.to_string())
}

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

    #[test]
    fn proxy_port_defaults_without_writing_and_round_trips() {
        let store = super::super::db::Store::open_in_memory().unwrap();
        let conn = store.conn();

        // 读不产生副作用。
        assert_eq!(proxy_port(&conn), 7890);
        assert!(get(&conn, PROXY_PORT_KEY).unwrap().is_none());

        set_proxy_port(&conn, 8080).unwrap();
        assert_eq!(proxy_port(&conn), 8080);

        // 损坏 / 越界的值也回落默认值，不报错。
        set(&conn, PROXY_PORT_KEY, "oops").unwrap();
        assert_eq!(proxy_port(&conn), 7890);
        set(&conn, PROXY_PORT_KEY, "70000").unwrap();
        assert_eq!(proxy_port(&conn), 7890);
        set(&conn, PROXY_PORT_KEY, "0").unwrap();
        assert_eq!(proxy_port(&conn), 7890);
    }
}
