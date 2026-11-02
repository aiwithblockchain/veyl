use rusqlite::Connection;

use super::error::StoreResult;

/// 每段迁移只追加、不修改；`PRAGMA user_version` 记录已执行到第几段。
pub const MIGRATION_002: &str = include_str!("migrations/002_timestamps_ms.sql");
pub const MIGRATION_003: &str = include_str!("migrations/003_default_profile.sql");
pub const MIGRATION_004: &str = include_str!("migrations/004_default_profile_content_hash.sql");

pub const MIGRATIONS: &[&str] = &[
    include_str!("migrations/001_init.sql"),
    MIGRATION_002,
    MIGRATION_003,
    MIGRATION_004,
];

pub fn migrate(conn: &Connection) -> StoreResult<()> {
    let current: i64 = conn.pragma_query_value(None, "user_version", |row| row.get(0))?;
    let target = MIGRATIONS.len() as i64;
    if current >= target {
        return Ok(());
    }

    for (index, sql) in MIGRATIONS.iter().enumerate().skip(current.max(0) as usize) {
        let tx = conn.unchecked_transaction()?;
        tx.execute_batch(sql)?;
        tx.pragma_update(None, "user_version", (index as i64) + 1)?;
        tx.commit()?;
    }
    Ok(())
}
