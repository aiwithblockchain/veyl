//! 「我的服务器」本地镜像（`data-model.md` 6）。
//!
//! 目前只服务离线展示与节点关联：控制面仍是唯一事实源，这里不存任何凭据。
//! 时间列与库内其余表一致，统一用 Unix 毫秒。

use rusqlite::{params, Connection, OptionalExtension};

use super::db::now_ms;
use super::error::{StoreError, StoreResult};

#[derive(Debug, Clone, PartialEq)]
pub struct MyServerRow {
    pub id: String,
    pub provider: String,
    pub name: String,
    pub region: String,
    pub plan: String,
    pub state: String,
    pub node_id: Option<String>,
    pub hourly_usd: f64,
    pub monthly_usd: f64,
    pub created_at: i64,
    pub updated_at: i64,
    pub last_synced_at: i64,
}

pub struct NewMyServer<'a> {
    pub id: &'a str,
    pub provider: &'a str,
    pub name: &'a str,
    pub region: &'a str,
    pub plan: &'a str,
    pub state: &'a str,
    pub node_id: Option<&'a str>,
    pub hourly_usd: f64,
    pub monthly_usd: f64,
    /// 控制面给的创建时刻（Unix 毫秒）。
    pub created_at: i64,
}

pub fn upsert(conn: &Connection, new: &NewMyServer<'_>) -> StoreResult<MyServerRow> {
    if new.id.trim().is_empty() {
        return Err(StoreError::Invalid("服务器 id 不能为空".into()));
    }
    let now = now_ms();
    conn.execute(
        "INSERT INTO my_servers
            (id, provider, name, region, plan, state, node_id,
             hourly_usd, monthly_usd, created_at, updated_at, last_synced_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?11)
         ON CONFLICT(id) DO UPDATE SET
             provider = excluded.provider,
             name = excluded.name,
             region = excluded.region,
             plan = excluded.plan,
             state = excluded.state,
             node_id = COALESCE(excluded.node_id, my_servers.node_id),
             hourly_usd = excluded.hourly_usd,
             monthly_usd = excluded.monthly_usd,
             created_at = excluded.created_at,
             updated_at = excluded.updated_at,
             last_synced_at = excluded.last_synced_at",
        params![
            new.id,
            new.provider,
            new.name,
            new.region,
            new.plan,
            new.state,
            new.node_id,
            new.hourly_usd,
            new.monthly_usd,
            new.created_at,
            now
        ],
    )?;
    get(conn, new.id)?.ok_or_else(|| StoreError::NotFound(new.id.to_string()))
}

/// 列表按创建时间倒序；已销毁的服务器不再出现在列表里（§7.4）。
pub fn list(conn: &Connection) -> StoreResult<Vec<MyServerRow>> {
    let mut statement = conn.prepare(
        "SELECT id, provider, name, region, plan, state, node_id,
                hourly_usd, monthly_usd, created_at, updated_at, last_synced_at
           FROM my_servers
          WHERE state != 'destroyed'
          ORDER BY created_at DESC",
    )?;
    let rows = statement.query_map([], row_to_server)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(StoreError::from)
}

pub fn get(conn: &Connection, id: &str) -> StoreResult<Option<MyServerRow>> {
    conn.query_row(
        "SELECT id, provider, name, region, plan, state, node_id,
                hourly_usd, monthly_usd, created_at, updated_at, last_synced_at
           FROM my_servers WHERE id = ?1",
        params![id],
        row_to_server,
    )
    .optional()
    .map_err(StoreError::from)
}

pub fn set_node(conn: &Connection, id: &str, node_id: &str) -> StoreResult<()> {
    conn.execute(
        "UPDATE my_servers SET node_id = ?2, updated_at = ?3, last_synced_at = ?3 WHERE id = ?1",
        params![id, node_id, now_ms()],
    )?;
    Ok(())
}

pub fn delete(conn: &Connection, id: &str) -> StoreResult<bool> {
    let changed = conn.execute("DELETE FROM my_servers WHERE id = ?1", params![id])?;
    Ok(changed > 0)
}

fn row_to_server(row: &rusqlite::Row<'_>) -> rusqlite::Result<MyServerRow> {
    Ok(MyServerRow {
        id: row.get(0)?,
        provider: row.get(1)?,
        name: row.get(2)?,
        region: row.get(3)?,
        plan: row.get(4)?,
        state: row.get(5)?,
        node_id: row.get(6)?,
        hourly_usd: row.get(7)?,
        monthly_usd: row.get(8)?,
        created_at: row.get(9)?,
        updated_at: row.get(10)?,
        last_synced_at: row.get(11)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::Store;

    fn new_server<'a>(id: &'a str, state: &'a str) -> NewMyServer<'a> {
        NewMyServer {
            id,
            provider: "digitalocean",
            name: "Tokyo",
            region: "tyo",
            plan: "s-1vcpu-1gb",
            state,
            node_id: None,
            hourly_usd: 0.009,
            monthly_usd: 6.0,
            created_at: 1_700_000_000_000,
        }
    }

    #[test]
    fn upsert_keeps_one_row_and_preserves_the_node_link() {
        let store = Store::open_in_memory().unwrap();
        let conn = store.conn();
        upsert(&conn, &new_server("srv_1", "creating")).unwrap();
        upsert(&conn, &new_server("srv_1", "healthy")).unwrap();
        let row = get(&conn, "srv_1").unwrap().unwrap();
        assert_eq!(row.state, "healthy");
        assert_eq!(row.created_at, 1_700_000_000_000);
        assert_eq!(list(&conn).unwrap().len(), 1);
    }

    #[test]
    fn destroyed_servers_are_hidden_from_the_list() {
        let store = Store::open_in_memory().unwrap();
        let conn = store.conn();
        upsert(&conn, &new_server("srv_1", "healthy")).unwrap();
        upsert(&conn, &new_server("srv_2", "destroyed")).unwrap();
        let ids: Vec<_> = list(&conn).unwrap().into_iter().map(|row| row.id).collect();
        assert_eq!(ids, vec!["srv_1"]);
    }

    #[test]
    fn a_node_link_is_kept_when_later_syncs_do_not_carry_it() {
        let store = Store::open_in_memory().unwrap();
        let conn = store.conn();
        // 外键是刻意的：只允许关联真实存在的节点行。先建节点再关联。
        crate::store::configs::upsert_node(
            &conn,
            &crate::store::NewNode {
                id: "nd_1",
                name: "Tokyo",
                server: "203.0.113.10",
                port: 20343,
                method: "aes-256-gcm",
                password_ref: "node:nd_1",
                source: crate::store::configs::SOURCE_OWNED,
                source_key: "srv_1",
            },
        )
        .unwrap();

        upsert(&conn, &new_server("srv_1", "installing")).unwrap();
        set_node(&conn, "srv_1", "nd_1").unwrap();
        upsert(&conn, &new_server("srv_1", "healthy")).unwrap();
        assert_eq!(
            get(&conn, "srv_1").unwrap().unwrap().node_id.as_deref(),
            Some("nd_1")
        );
    }
}
