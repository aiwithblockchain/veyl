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
        create_database_file(&path)?;
        // 老库可能是 0644：先纠正再打开，别把凭据写进一个别人可读的文件。
        restrict_permissions(&path)?;
        let conn = Connection::open(&path)?;
        configure(&conn)?;
        migrations::migrate(&conn)?;
        let store = Self {
            conn: Mutex::new(conn),
            path,
        };
        // -wal / -shm 由 SQLite 自己按 umask 建，写完才有，建库后再纠一次。
        restrict_permissions(store.path())?;
        Ok(store)
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

/// 库里有节点口令与凭据备份，文件只给本人读写。先以 0600 建，避免「按 umask 建完再 chmod」的读取窗口。
#[cfg(unix)]
fn create_database_file(path: &Path) -> StoreResult<()> {
    use std::os::unix::fs::OpenOptionsExt;

    match std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)
    {
        Ok(_) => Ok(()),
        Err(source) if source.kind() == std::io::ErrorKind::AlreadyExists => Ok(()),
        Err(source) => Err(StoreError::Io {
            path: path.to_path_buf(),
            source,
        }),
    }
}

#[cfg(not(unix))]
fn create_database_file(_path: &Path) -> StoreResult<()> {
    Ok(())
}

/// 已有的库文件也要纠正，否则老用户会一直停在 0644。
#[cfg(unix)]
fn restrict_permissions(path: &Path) -> StoreResult<()> {
    use std::os::unix::fs::PermissionsExt;

    for file in [
        path.to_path_buf(),
        sidecar(path, "-wal"),
        sidecar(path, "-shm"),
    ] {
        match std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o600)) {
            Ok(()) => {}
            Err(source) if source.kind() == std::io::ErrorKind::NotFound => {}
            Err(source) => return Err(StoreError::Io { path: file, source }),
        }
    }
    Ok(())
}

#[cfg(not(unix))]
fn restrict_permissions(_path: &Path) -> StoreResult<()> {
    Ok(())
}

#[cfg(unix)]
fn sidecar(path: &Path, suffix: &str) -> PathBuf {
    let mut name = path.as_os_str().to_owned();
    name.push(suffix);
    PathBuf::from(name)
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
    fn every_time_column_is_in_milliseconds() {
        use crate::store::{
            catalog_cache, chat, configs, proxy_backup, runtime, seed_cache, tool_calls,
        };

        let store = Store::open_in_memory().unwrap();
        let conn = store.conn();

        configs::create(
            &conn,
            &configs::NewConfig {
                id: "cfg_1",
                name: "p",
                connection_mode: configs::CONNECTION_SYSTEM_PROXY,
                routing_mode: configs::ROUTING_PROXY_ALL,
                listen_port: Some(7890),
                dns: &serde_json::json!({ "mode": "auto", "local": [], "remote": [] }),
                tun_excludes: &serde_json::json!([]),
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
        catalog_cache::put(&conn, "k", None, &serde_json::json!({}), 200).unwrap();
        seed_cache::save(
            &conn,
            &seed_cache::SeedCacheRow {
                content_sha256: "x".into(),
                etag: None,
                source_version: None,
                source_updated_at: None,
                node_count: 1,
                fetched_at: crate::store::db::now_ms(),
                checked_at: crate::store::db::now_ms(),
            },
        )
        .unwrap();

        let columns = [
            ("configs", "created_at"),
            ("tool_calls", "created_at"),
            ("chat_messages", "created_at"),
            ("proxy_backup", "created_at"),
            ("runtime_versions", "installed_at"),
            ("catalog_cache", "fetched_at"),
            ("seed_cache", "fetched_at"),
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

    #[cfg(unix)]
    #[test]
    fn the_database_file_is_private_and_legacy_modes_are_corrected() {
        use std::os::unix::fs::PermissionsExt;

        let dir = std::env::temp_dir().join(format!("veyl-store-{:016x}", rand::random::<u64>()));
        let path = dir.join("veyl.db");

        let store = Store::open(&path).unwrap();
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        for suffix in ["-wal", "-shm"] {
            let sidecar = sidecar(&path, suffix);
            if sidecar.exists() {
                assert_eq!(
                    std::fs::metadata(&sidecar).unwrap().permissions().mode() & 0o777,
                    0o600,
                    "{suffix} 不是 0600"
                );
            }
        }
        drop(store);

        // 老用户库：打开时也要纠正到 0600。
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
        let store = Store::open(&path).unwrap();
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        drop(store);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
