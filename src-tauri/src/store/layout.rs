//! 中间区域的布局持久化。
//!
//! `revision` 每配置单调递增：UI 收到 `revision <= 当前` 的 `layout-updated`
//! 时丢弃，避免迟到事件覆盖新布局。

use rusqlite::{params, Connection, OptionalExtension};
use serde_json::Value;

use super::db::now_ms;
use super::error::{StoreError, StoreResult};

pub fn get(conn: &Connection, config_id: &str) -> StoreResult<Option<(i64, Value)>> {
    let row: Option<(i64, String)> = conn
        .query_row(
            "SELECT revision, layout_json FROM layout WHERE config_id = ?1",
            params![config_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    Ok(row.and_then(|(revision, text)| {
        serde_json::from_str(&text)
            .ok()
            .map(|layout| (revision, layout))
    }))
}

/// 写入一份新布局，返回新的 revision。
pub fn set(conn: &Connection, config_id: &str, layout: &Value) -> StoreResult<i64> {
    let text = serde_json::to_string(layout)
        .map_err(|error| StoreError::Invalid(format!("布局不是合法 JSON：{error}")))?;

    let tx = conn.unchecked_transaction()?;
    let revision: i64 = tx.query_row(
        "SELECT COALESCE(revision, 0) + 1 FROM layout WHERE config_id = ?1",
        params![config_id],
        |row| row.get(0),
    ).optional()?.unwrap_or(1);
    tx.execute(
        "INSERT INTO layout (config_id, revision, layout_json, updated_at)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(config_id) DO UPDATE SET
             revision = excluded.revision,
             layout_json = excluded.layout_json,
             updated_at = excluded.updated_at",
        params![config_id, revision, text, now_ms()],
    )?;
    tx.commit()?;
    Ok(revision)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::configs::{self, NewConfig};
    use crate::store::Store;
    use serde_json::json;

    fn create_config(conn: &Connection, id: &str, name: &str) {
        configs::create(
            conn,
            &NewConfig {
                id,
                name,
                connection_mode: "system_proxy",
                routing_mode: "proxy_all",
                listen_port: Some(7890),
                dns: &json!({ "mode": "auto", "local": [], "remote": [] }),
                tun_excludes: &json!([]),
            },
        )
        .unwrap();
    }

    #[test]
    fn layout_is_per_config_and_revision_increases() {
        let store = Store::open_in_memory().unwrap();
        let conn = store.conn();
        create_config(&conn, "cfg_1", "A");
        create_config(&conn, "cfg_2", "B");

        assert_eq!(
            set(&conn, "cfg_1", &json!({ "version": 1, "blocks": ["proxy_card"] })).unwrap(),
            1
        );
        let (revision, layout) = get(&conn, "cfg_1").unwrap().unwrap();
        assert_eq!(revision, 1);
        assert_eq!(layout["blocks"][0], "proxy_card");

        assert_eq!(
            set(&conn, "cfg_1", &json!({ "version": 1, "blocks": [] })).unwrap(),
            2
        );
        assert!(get(&conn, "cfg_2").unwrap().is_none());
    }
}
