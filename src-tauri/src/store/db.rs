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
