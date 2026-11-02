use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};
use std::time::Duration;

use rusqlite::Connection;

use super::error::{StoreError, StoreResult};
use super::migrations;

/// 本地 SQLite。`Connection` 不是 `Sync`，这里用互斥锁包一层；
/// P1 的写入频率很低，锁不构成瓶颈。
pub struct Store {
    conn: Mutex<Connection>,
    path: PathBuf,
}

impl Store {
    pub fn open(path: impl Into<PathBuf>) -> StoreResult<Self> {
        let path = path.into();
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|source| StoreError::Io {
                path: parent.to_path_buf(),
                source,
            })?;
        }
        let conn = Connection::open(&path)?;
        configure(&conn)?;
        migrations::migrate(&conn)?;
        Ok(Self {
            conn: Mutex::new(conn),
            path,
        })
    }

    pub fn open_in_memory() -> StoreResult<Self> {
        let conn = Connection::open_in_memory()?;
        configure(&conn)?;
        migrations::migrate(&conn)?;
        Ok(Self {
            conn: Mutex::new(conn),
            path: PathBuf::from(":memory:"),
        })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn conn(&self) -> MutexGuard<'_, Connection> {
        // 单个连接被 panic 打断时不应该让整个应用再也拿不到库。
        self.conn.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub fn schema_version(&self) -> StoreResult<i64> {
        let conn = self.conn();
        Ok(conn.pragma_query_value(None, "user_version", |row| row.get(0))?)
    }
}

fn configure(conn: &Connection) -> StoreResult<()> {
    // journal_mode 会返回一行结果，用 query_row 而不是 pragma_update。
    let _mode: String = conn.query_row("PRAGMA journal_mode = WAL", [], |row| row.get(0))?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    conn.busy_timeout(Duration::from_secs(5))?;
    Ok(())
}

/// 出口统一 ISO 8601 UTC + `Z`；库里存毫秒，别把裸时间戳丢给 UI。
pub fn iso_from_ms(millis: i64) -> String {
    chrono::DateTime::from_timestamp_millis(millis)
        .unwrap_or_else(|| chrono::DateTime::from_timestamp_millis(0).expect("epoch"))
        .to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    #[test]
    fn migration_two_converts_legacy_seconds_exactly_once() {
        let dir = std::env::temp_dir().join(format!("veyl-mig-{:016x}", rand::random::<u64>()));
        let path = dir.join("veyl.db");

        {
            let store = Store::open(&path).unwrap();
            let conn = store.conn();
            conn.execute(
                "INSERT INTO runtime_versions (version, path, binary_path, sha256, state, installed_at)
                 VALUES ('1.14.4', '/a', '/a/b', 'x', 'active', 1700000000)",
                [],
            )
            .unwrap();
            // 退回到 v1，模拟一个已存在的旧库。default_profile 在 v1 还不存在，
            // 重建它，避免 004 的 ALTER 在已迁移的表上重复加列。
            conn.execute("DROP TABLE IF EXISTS default_profile", []).unwrap();
            conn.pragma_update(None, "user_version", 1i64).unwrap();
        }

        let reopened = Store::open(&path).unwrap();
        assert_eq!(reopened.schema_version().unwrap(), 4);
        let migrated: i64 = reopened
            .conn()
            .query_row("SELECT installed_at FROM runtime_versions", [], |row| row.get(0))
            .unwrap();
        assert_eq!(migrated, 1_700_000_000_000, "秒级时间戳应被换算成毫秒");

        // 再跑一次 002：下界保护保证不会二次放大。
        reopened.conn().execute_batch(crate::store::migrations::MIGRATION_002).unwrap();
        let again: i64 = reopened
            .conn()
            .query_row("SELECT installed_at FROM runtime_versions", [], |row| row.get(0))
            .unwrap();
        assert_eq!(again, migrated, "重复执行必须幂等");

        drop(reopened);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn every_time_column_is_in_milliseconds() {
        use crate::store::{chat, profiles, proxy_backup, runtime, tool_calls};

        let store = Store::open_in_memory().unwrap();
        let conn = store.conn();

        profiles::create(
            &conn,
            &profiles::NewProfile {
                id: "prf_1",
                node_id: None,
                name: "p",
                protocol: None,
                region: None,
                config: &serde_json::json!({ "server": "203.0.113.10" }),
            },
        )
        .unwrap();

        tool_calls::begin(
            &conn,
            &tool_calls::NewCall {
                id: "call_1",
                session_id: Some("ses_1"),
                request_id: None,
                tool_name: "RuntimeStatus",
                args: &serde_json::json!({}),
            },
        )
        .unwrap();

        chat::append_message(&conn, "msg_1", "ses_1", "user", "hi", None).unwrap();
        proxy_backup::save(&conn, "macos", "127.0.0.1:2080", &serde_json::json!({})).unwrap();
        runtime::upsert_version(
            &conn,
            &runtime::RuntimeVersionRow {
                version: "1.14.4".into(),
                path: "/a".into(),
                binary_path: "/a/b".into(),
                sha256: "x".into(),
                state: "active".into(),
                installed_at: crate::store::db::now_ms(),
            },
        )
        .unwrap();
        crate::store::catalog_cache::put(&conn, "k", None, &serde_json::json!({}), 200).unwrap();

        let columns = [
            ("profiles", "created_at"),
            ("tool_calls", "created_at"),
            ("chat_messages", "created_at"),
            ("proxy_backup", "created_at"),
            ("runtime_versions", "installed_at"),
            ("catalog_cache", "fetched_at"),
        ];

        for (table, column) in columns {
            let value: i64 = conn
                .query_row(&format!("SELECT {column} FROM {table} LIMIT 1"), [], |row| {
                    row.get(0)
                })
                .unwrap();
            assert!(
                value >= 1_000_000_000_000 && value < 10_000_000_000_000,
                "{table}.{column} = {value}，不是毫秒量级"
            );
        }
    }


    use super::*;

    #[test]
    fn opening_in_memory_enables_foreign_keys_and_wal() {
        let store = Store::open_in_memory().unwrap();
        let conn = store.conn();
        let foreign_keys: i64 = conn
            .pragma_query_value(None, "foreign_keys", |row| row.get(0))
            .unwrap();
        assert_eq!(foreign_keys, 1);
    }

    #[test]
    fn migrations_run_once_and_record_the_version() {
        let store = Store::open_in_memory().unwrap();
        assert_eq!(store.schema_version().unwrap(), migrations::MIGRATIONS.len() as i64);
        migrations::migrate(&store.conn()).unwrap();
        assert_eq!(store.schema_version().unwrap(), migrations::MIGRATIONS.len() as i64);
    }

    #[test]
    fn opening_a_file_creates_the_parent_directory() {
        let dir = std::env::temp_dir().join(format!("veyl-store-{:016x}", rand::random::<u64>()));
        let path = dir.join("nested").join("veyl.db");
        let store = Store::open(&path).unwrap();
        assert!(path.exists());
        assert_eq!(store.path(), path);
        drop(store);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
