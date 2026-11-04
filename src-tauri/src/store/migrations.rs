use rusqlite::Connection;

use super::error::StoreResult;

/// 只有一份迁移：产品尚未发布，数据库整体重建，不做历史迁移。
pub const MIGRATIONS: &[&str] = &[include_str!("migrations/001_init.sql")];

pub fn migrate(conn: &Connection) -> StoreResult<()> {
    let current: i64 = conn.pragma_query_value(None, "user_version", |row| row.get(0))?;
    if current == MIGRATIONS.len() as i64 && has_current_schema(conn)? {
        return Ok(());
    }

    if current != 0 || !has_current_schema(conn)? {
        // 旧库（P1 的 profiles / default_profile 等）没有迁移价值。
        // 产品还没有用户，直接清空所有表后按新 schema 重建。
        reset_schema(conn)?;
    }

    let tx = conn.unchecked_transaction()?;
    for (index, sql) in MIGRATIONS.iter().enumerate() {
        tx.execute_batch(sql)?;
        tx.pragma_update(None, "user_version", (index as i64) + 1)?;
    }
    tx.commit()?;
    Ok(())
}

fn has_current_schema(conn: &Connection) -> StoreResult<bool> {
    let count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM sqlite_master
          WHERE type = 'table'
            AND name IN ('configs', 'nodes', 'config_nodes', 'issues', 'layout', 'seed_cache',
                         'seed_node_exclusions', 'rules_state')",
        [],
        |row| row.get(0),
    )?;
    Ok(count == 8)
}

/// 删除所有用户表。`sqlite_*` 内部表不在 sqlite_master 的普通表里。
fn reset_schema(conn: &Connection) -> StoreResult<()> {
    let tables: Vec<String> = {
        let mut statement = conn.prepare(
            "SELECT name FROM sqlite_master
              WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
        )?;
        let rows = statement.query_map([], |row| row.get::<_, String>(0))?;
        rows.collect::<Result<Vec<_>, _>>()?
    };

    // PRAGMA foreign_keys 在事务内无效，必须在 BEGIN 之前关闭；
    // 否则逐表 DROP 会触发旧表之间的级联/约束检查。
    conn.pragma_update(None, "foreign_keys", "OFF")?;
    let tx = conn.unchecked_transaction()?;
    for table in tables {
        // 表名来自 sqlite_master，不是用户输入；仍用双引号包裹。
        tx.execute_batch(&format!("DROP TABLE IF EXISTS \"{}\";", table.replace('"', "\"\"")))?;
    }
    tx.pragma_update(None, "user_version", 0i64)?;
    tx.commit()?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::Store;

    #[test]
    fn fresh_database_gets_the_current_schema() {
        let store = Store::open_in_memory().unwrap();
        assert_eq!(store.schema_version().unwrap(), 1);
        assert!(has_current_schema(&store.conn()).unwrap());
    }

    #[test]
    fn an_old_p1_database_is_rebuilt() {
        let dir = std::env::temp_dir().join(format!("veyl-mig-{:016x}", rand::random::<u64>()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("veyl.db");
        {
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch(
                "CREATE TABLE profiles (id TEXT PRIMARY KEY, config_json TEXT);
                 CREATE TABLE default_profile (id INTEGER PRIMARY KEY);
                 PRAGMA user_version = 4;",
            )
            .unwrap();
        }

        let store = Store::open(&path).unwrap();
        assert_eq!(store.schema_version().unwrap(), 1);
        let conn = store.conn();
        assert!(has_current_schema(&conn).unwrap());
        let legacy: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='profiles'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(legacy, 0, "旧表必须删除");

        drop(conn);
        drop(store);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn migrating_twice_is_a_no_op() {
        let store = Store::open_in_memory().unwrap();
        migrate(&store.conn()).unwrap();
        assert_eq!(store.schema_version().unwrap(), 1);
    }
}
