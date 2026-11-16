use rusqlite::Connection;

use super::error::StoreResult;

/// 发布前只保留当前基线：产品还没发布，本地库不做历史迁移，旧 schema 直接重建。
pub const MIGRATIONS: &[&str] = &[include_str!("migrations/001_init.sql")];

/// 本地 schema 的显式版本，**与迁移数组长度解耦**。
///
/// 改 `001_init.sql`（加列、改约束）时必须 +1；否则已有库的 `user_version`
/// 仍等于旧值，`migrate()` 会以为结构没变而跳过重建，运行时才报
/// `table … has no column named …`。
pub const SCHEMA_VERSION: i64 = 4;

/// `my_servers` 的计费/额度列。列探测是版本号之外的兜底：
/// 即使有人改了基线忘了 bump 版本，这里也会发现漂移并触发重建。
const REQUIRED_SERVER_COLUMNS: [&str; 4] = [
    "daily_price_cents",
    "transfer_gib",
    "paid_until",
    "billing_state",
];

pub fn migrate(conn: &Connection) -> StoreResult<()> {
    let current: i64 = conn.pragma_query_value(None, "user_version", |row| row.get(0))?;
    if current == SCHEMA_VERSION && has_current_schema(conn)? {
        return Ok(());
    }

    // 发布前不做增量迁移：版本不符或结构漂移一律清空重建。
    reset_schema(conn)?;

    let tx = conn.unchecked_transaction()?;
    for sql in MIGRATIONS {
        tx.execute_batch(sql)?;
    }
    tx.pragma_update(None, "user_version", SCHEMA_VERSION)?;
    tx.commit()?;
    Ok(())
}

fn has_current_schema(conn: &Connection) -> StoreResult<bool> {
    let count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM sqlite_master
          WHERE type = 'table'
            AND name IN ('configs', 'nodes', 'config_nodes', 'issues', 'layout', 'seed_cache',
                         'seed_node_exclusions', 'rules_state', 'my_servers', 'trial_state')",
        [],
        |row| row.get(0),
    )?;
    if count != 10 {
        return Ok(false);
    }
    my_servers_has_required_columns(conn)
}

fn my_servers_has_required_columns(conn: &Connection) -> StoreResult<bool> {
    let mut statement = conn.prepare("PRAGMA table_info(my_servers)")?;
    let columns = statement
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(REQUIRED_SERVER_COLUMNS
        .iter()
        .all(|expected| columns.iter().any(|column| column == expected)))
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
        assert_eq!(store.schema_version().unwrap(), SCHEMA_VERSION);
        assert!(has_current_schema(&store.conn()).unwrap());
    }

    #[test]
    fn a_different_schema_version_is_rebuilt() {
        let dir = std::env::temp_dir().join(format!("veyl-mig-newer-{:016x}", rand::random::<u64>()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("veyl.db");
        {
            // 发布前没有增量迁移：版本与基线不一致就整库重建。
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch(MIGRATIONS[0]).unwrap();
            conn.execute(
                "INSERT INTO my_servers
                    (id, provider, name, region, plan, state, hourly_usd, monthly_usd,
                     daily_price_cents, paid_until, billing_state,
                     created_at, updated_at, last_synced_at)
                 VALUES ('srv_1', 'digitalocean', 'Tokyo', 'tyo', 's-1vcpu-1gb', 'active',
                         0.009, 6.0, 20, 1, 'active', 1, 1, 1)",
                [],
            )
            .unwrap();
            conn.pragma_update(None, "user_version", SCHEMA_VERSION - 1)
                .unwrap();
        }

        let store = Store::open(&path).unwrap();
        assert_eq!(store.schema_version().unwrap(), SCHEMA_VERSION);
        assert!(has_current_schema(&store.conn()).unwrap());
        assert!(
            crate::store::servers::get(&store.conn(), "srv_1")
                .unwrap()
                .is_none(),
            "旧库不迁移，直接重建"
        );

        drop(store);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 线上真 bug：三列并入基线但版本号没变，`user_version` 相等 + 表存在，
    /// 结果跳过重建，运行时报 `no column named daily_price_cents`。
    #[test]
    fn a_schema_missing_billing_columns_is_rebuilt_even_at_the_same_version() {
        let dir = std::env::temp_dir().join(format!("veyl-mig-cols-{:016x}", rand::random::<u64>()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("veyl.db");
        {
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch(MIGRATIONS[0]).unwrap();
            // 退化成按天计费之前的 my_servers，并把版本号设成「当前版本」。
            conn.execute_batch(
                "ALTER TABLE my_servers DROP COLUMN daily_price_cents;
                 ALTER TABLE my_servers DROP COLUMN paid_until;
                 ALTER TABLE my_servers DROP COLUMN billing_state;
                 INSERT INTO my_servers
                    (id, provider, name, region, plan, state, hourly_usd, monthly_usd,
                     created_at, updated_at, last_synced_at)
                 VALUES ('srv_old', 'digitalocean', 'Tokyo', 'tyo', 's-1vcpu-1gb', 'active',
                         0.009, 6.0, 1, 1, 1);",
            )
            .unwrap();
            conn.pragma_update(None, "user_version", SCHEMA_VERSION)
                .unwrap();
            // 只有列探测能发现这种漂移。
            assert!(!has_current_schema(&conn).unwrap());
        }

        let store = Store::open(&path).unwrap();
        assert_eq!(store.schema_version().unwrap(), SCHEMA_VERSION);
        assert!(has_current_schema(&store.conn()).unwrap());
        assert!(
            crate::store::servers::get(&store.conn(), "srv_old")
                .unwrap()
                .is_none(),
            "缺列的旧库必须重建"
        );

        drop(store);
        let _ = std::fs::remove_dir_all(&dir);
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
        assert_eq!(store.schema_version().unwrap(), SCHEMA_VERSION);
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
        {
            let conn = store.conn();
            crate::store::servers::upsert(
                &conn,
                &crate::store::NewMyServer {
                    id: "srv_1",
                    provider: "digitalocean",
                    name: "Tokyo",
                    region: "tyo",
                    plan: "s-1vcpu-1gb",
                    state: "active",
                    node_id: None,
                    hourly_usd: 0.009,
                    monthly_usd: 6.0,
                    daily_price_cents: 20,
                    transfer_gib: 1000,
                    paid_until: 1_700_086_400_000,
                    billing_state: "active",
                    created_at: 1_700_000_000_000,
                },
            )
            .unwrap();

            migrate(&conn).unwrap();
            assert!(
                crate::store::servers::get(&conn, "srv_1").unwrap().is_some(),
                "已是最新 schema 时不能重建"
            );
        }
        assert_eq!(store.schema_version().unwrap(), SCHEMA_VERSION);
    }
}
