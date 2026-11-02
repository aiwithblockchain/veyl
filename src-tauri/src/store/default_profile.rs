//! 默认配置包的元数据。包体（含共享凭据）加密存在 `secrets.enc`，这里只放可展示信息。

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use super::error::{StoreError, StoreResult};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PreviousProfile {
    pub provider_id: String,
    pub name: Option<String>,
    /// 发布方的版本标签，只作展示。
    pub package_hash: String,
    /// 原始响应字节的 sha256；包体解密键的一部分。
    pub content_sha256: String,
    pub source_updated_at: Option<String>,
    pub outbound_tags: Vec<String>,
    pub node_count: i64,
    pub applied_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DefaultProfileRow {
    pub provider_id: String,
    pub name: Option<String>,
    /// 发布方的版本标签，只作展示，不参与「是否变化」的判断。
    pub package_hash: String,
    /// 原始响应字节的 sha256。身份判据是 `(provider_id, content_sha256)`。
    pub content_sha256: String,
    pub source_updated_at: Option<String>,
    pub outbound_tags: Vec<String>,
    pub node_count: i64,
    pub applied_at: i64,
    pub checked_at: i64,
    pub new_version_available: bool,
    pub previous: Option<PreviousProfile>,
}

impl DefaultProfileRow {
    /// UI 上的版本标识：优先 `source_updated_at`，没有就用发布方标签。
    pub fn version_label(&self) -> String {
        self.source_updated_at
            .clone()
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| self.package_hash.clone())
    }
}

pub fn load(conn: &Connection) -> StoreResult<Option<DefaultProfileRow>> {
    conn.query_row(
        "SELECT provider_id, name, package_hash, source_updated_at, outbound_tags,
                node_count, applied_at, checked_at, new_version_available,
                previous_provider_id, previous_name, previous_hash,
                previous_source_updated_at, previous_outbound_tags,
                previous_node_count, previous_applied_at,
                content_sha256, previous_content_sha256
         FROM default_profile WHERE id = 1",
        [],
        |row| {
            let tags: String = row.get(4)?;
            let previous_provider: Option<String> = row.get(9)?;
            Ok(DefaultProfileRow {
                provider_id: row.get(0)?,
                name: row.get(1)?,
                package_hash: row.get(2)?,
                source_updated_at: row.get(3)?,
                outbound_tags: serde_json::from_str(&tags).unwrap_or_default(),
                node_count: row.get(5)?,
                applied_at: row.get(6)?,
                checked_at: row.get(7)?,
                new_version_available: row.get::<_, i64>(8)? != 0,
                previous: match previous_provider {
                    Some(provider_id) => Some(PreviousProfile {
                        provider_id,
                        name: row.get(10)?,
                        package_hash: row.get(11)?,
                        source_updated_at: row.get(12)?,
                        outbound_tags: row
                            .get::<_, Option<String>>(13)?
                            .and_then(|value| serde_json::from_str(&value).ok())
                            .unwrap_or_default(),
                        node_count: row.get::<_, Option<i64>>(14)?.unwrap_or(0),
                        applied_at: row.get::<_, Option<i64>>(15)?.unwrap_or(0),
                        content_sha256: row.get::<_, Option<String>>(17)?.unwrap_or_default(),
                    }),
                    None => None,
                },
                content_sha256: row.get(16)?,
            })
        },
    )
    .optional()
    .map_err(StoreError::from)
}

pub fn save(conn: &Connection, row: &DefaultProfileRow) -> StoreResult<()> {
    let tags = serde_json::to_string(&row.outbound_tags).unwrap_or_else(|_| "[]".into());
    let previous = row.previous.as_ref();
    let previous_tags = previous
        .map(|previous| serde_json::to_string(&previous.outbound_tags).unwrap_or_default());

    conn.execute(
        "INSERT INTO default_profile (
            id, provider_id, name, package_hash, source_updated_at, outbound_tags,
            node_count, applied_at, checked_at, new_version_available,
            previous_provider_id, previous_name, previous_hash,
            previous_source_updated_at, previous_outbound_tags,
            previous_node_count, previous_applied_at,
            content_sha256, previous_content_sha256
         ) VALUES (1, ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18)
         ON CONFLICT(id) DO UPDATE SET
            provider_id = excluded.provider_id,
            name = excluded.name,
            package_hash = excluded.package_hash,
            source_updated_at = excluded.source_updated_at,
            outbound_tags = excluded.outbound_tags,
            node_count = excluded.node_count,
            applied_at = excluded.applied_at,
            checked_at = excluded.checked_at,
            new_version_available = excluded.new_version_available,
            previous_provider_id = excluded.previous_provider_id,
            previous_name = excluded.previous_name,
            previous_hash = excluded.previous_hash,
            previous_source_updated_at = excluded.previous_source_updated_at,
            previous_outbound_tags = excluded.previous_outbound_tags,
            previous_node_count = excluded.previous_node_count,
            previous_applied_at = excluded.previous_applied_at,
            content_sha256 = excluded.content_sha256,
            previous_content_sha256 = excluded.previous_content_sha256",
        params![
            row.provider_id,
            row.name,
            row.package_hash,
            row.source_updated_at,
            tags,
            row.node_count,
            row.applied_at,
            row.checked_at,
            if row.new_version_available { 1 } else { 0 },
            previous.map(|previous| previous.provider_id.clone()),
            previous.and_then(|previous| previous.name.clone()),
            previous.map(|previous| previous.package_hash.clone()),
            previous.and_then(|previous| previous.source_updated_at.clone()),
            previous_tags,
            previous.map(|previous| previous.node_count),
            previous.map(|previous| previous.applied_at),
            row.content_sha256,
            previous.map(|previous| previous.content_sha256.clone()),
        ],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row() -> DefaultProfileRow {
        DefaultProfileRow {
            provider_id: "seed-v21".into(),
            name: Some("种子V21".into()),
            package_hash: "seed-dynamic-tag-test-20260313".into(),
            content_sha256: "content-hash-1".into(),
            source_updated_at: Some("2026-11-01T00:00:00Z".into()),
            outbound_tags: vec!["node-a".into(), "node-b".into()],
            node_count: 2,
            applied_at: 1,
            checked_at: 2,
            new_version_available: false,
            previous: None,
        }
    }

    #[test]
    fn metadata_round_trips() {
        let store = crate::store::Store::open_in_memory().unwrap();
        let conn = store.conn();
        save(&conn, &row()).unwrap();

        let loaded = load(&conn).unwrap().unwrap();
        assert_eq!(loaded.provider_id, "seed-v21");
        assert_eq!(loaded.content_sha256, "content-hash-1");
        assert_eq!(loaded.outbound_tags, vec!["node-a", "node-b"]);
        assert_eq!(loaded.version_label(), "2026-11-01T00:00:00Z");
    }

    #[test]
    fn previous_version_is_kept_for_rollback() {
        let store = crate::store::Store::open_in_memory().unwrap();
        let conn = store.conn();

        let mut current = row();
        current.content_sha256 = "content-hash-2".into();
        current.previous = Some(PreviousProfile {
            provider_id: "seed-v21".into(),
            name: Some("种子V21".into()),
            package_hash: "seed-dynamic-tag-test-20260313".into(),
            content_sha256: "content-hash-1".into(),
            source_updated_at: Some("2026-10-01T00:00:00Z".into()),
            outbound_tags: vec!["node-a".into()],
            node_count: 1,
            applied_at: 1,
        });
        save(&conn, &current).unwrap();

        let loaded = load(&conn).unwrap().unwrap();
        let previous = loaded.previous.expect("上一版要留着");
        assert_eq!(previous.content_sha256, "content-hash-1");
        assert_eq!(previous.node_count, 1);
    }

    #[test]
    fn a_legacy_row_without_content_hash_still_loads() {
        let store = crate::store::Store::open_in_memory().unwrap();
        let conn = store.conn();
        save(&conn, &row()).unwrap();
        // 模拟 004 之前写入的行：content_sha256 为空串。
        conn.execute("UPDATE default_profile SET content_sha256 = ''", [])
            .unwrap();

        let loaded = load(&conn).unwrap().unwrap();
        assert_eq!(loaded.content_sha256, "");
    }
}
