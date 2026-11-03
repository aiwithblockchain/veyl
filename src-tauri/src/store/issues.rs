//! 问题管理。批 1 只建表与合并写入，采集与展示在批 6。
//!
//! 同类问题按 `merge_key = coalesce(config_id,'') \x1f kind \x1f target`
//! 合并：只加 `occurrences`，不新建行。DDL 见 `docs/data-model.md` §3.5。

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;

use super::db::now_ms;
use super::error::{StoreError, StoreResult};

#[derive(Debug, Clone, Serialize)]
pub struct Issue {
    pub id: String,
    pub merge_key: String,
    pub config_id: Option<String>,
    pub kind: String,
    pub target: String,
    pub severity: String,
    pub status: String,
    pub mode: String,
    pub title: String,
    pub occurrences: i64,
    pub first_seen_at: i64,
    pub last_seen_at: i64,
    pub evidence_json: String,
    pub session_id: Option<String>,
    pub last_handoff_at: Option<i64>,
    pub resolved_at: Option<i64>,
}

pub struct NewIssue<'a> {
    pub id: &'a str,
    pub config_id: Option<&'a str>,
    pub kind: &'a str,
    pub target: &'a str,
    pub severity: &'a str,
    pub mode: &'a str,
    pub title: &'a str,
    pub evidence_json: &'a str,
}

/// 唯一的写入口：命中合并键就累加计数并重开，否则插入。
pub fn record(conn: &Connection, new: &NewIssue<'_>) -> StoreResult<Issue> {
    validate_severity(new.severity)?;
    validate_mode(new.mode)?;

    let merge_key = format!(
        "{}\x1f{}\x1f{}",
        new.config_id.unwrap_or(""),
        new.kind,
        new.target
    );
    let now = now_ms();

    let existing: Option<Issue> = conn
        .query_row(
            "SELECT id, merge_key, config_id, kind, target, severity, status, mode, title,
                    occurrences, first_seen_at, last_seen_at, evidence_json, session_id,
                    last_handoff_at, resolved_at
               FROM issues WHERE merge_key = ?1",
            params![merge_key],
            row_to_issue,
        )
        .optional()?;

    match existing {
        Some(existing) => {
            let severity = max_severity(&existing.severity, new.severity);
            conn.execute(
                "UPDATE issues
                    SET occurrences = occurrences + 1,
                        last_seen_at = ?2,
                        title = ?3,
                        evidence_json = ?4,
                        mode = ?5,
                        severity = ?6,
                        status = 'open',
                        resolved_at = NULL
                  WHERE id = ?1",
                params![
                    existing.id,
                    now,
                    new.title,
                    new.evidence_json,
                    new.mode,
                    severity
                ],
            )?;
            get(conn, &existing.id)?.ok_or_else(|| StoreError::NotFound(existing.id))
        }
        None => {
            conn.execute(
                "INSERT INTO issues
                    (id, merge_key, config_id, kind, target, severity, status, mode, title,
                     occurrences, first_seen_at, last_seen_at, evidence_json, session_id,
                     last_handoff_at, resolved_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'open', ?7, ?8, 1, ?9, ?9, ?10, NULL, NULL, NULL)",
                params![
                    new.id,
                    merge_key,
                    new.config_id,
                    new.kind,
                    new.target,
                    new.severity,
                    new.mode,
                    new.title,
                    now,
                    new.evidence_json
                ],
            )?;
            get(conn, new.id)?.ok_or_else(|| StoreError::NotFound(new.id.to_string()))
        }
    }
}

pub fn get(conn: &Connection, id: &str) -> StoreResult<Option<Issue>> {
    conn.query_row(
        "SELECT id, merge_key, config_id, kind, target, severity, status, mode, title,
                occurrences, first_seen_at, last_seen_at, evidence_json, session_id,
                last_handoff_at, resolved_at
           FROM issues WHERE id = ?1",
        params![id],
        row_to_issue,
    )
    .optional()
    .map_err(StoreError::from)
}

pub fn list_open(conn: &Connection) -> StoreResult<Vec<Issue>> {
    let mut statement = conn.prepare(
        "SELECT id, merge_key, config_id, kind, target, severity, status, mode, title,
                occurrences, first_seen_at, last_seen_at, evidence_json, session_id,
                last_handoff_at, resolved_at
           FROM issues WHERE status = 'open'
          ORDER BY severity ASC, last_seen_at DESC",
    )?;
    let rows = statement.query_map([], row_to_issue)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(StoreError::from)
}

pub fn resolve(conn: &Connection, id: &str) -> StoreResult<()> {
    conn.execute(
        "UPDATE issues SET status = 'resolved', resolved_at = ?2 WHERE id = ?1",
        params![id, now_ms()],
    )?;
    Ok(())
}

fn max_severity(left: &str, right: &str) -> String {
    let rank = |value: &str| match value {
        "P0" => 0,
        "P1" => 1,
        _ => 2,
    };
    if rank(left) <= rank(right) {
        left.to_string()
    } else {
        right.to_string()
    }
}

fn validate_severity(value: &str) -> StoreResult<()> {
    if matches!(value, "P0" | "P1" | "P2") {
        Ok(())
    } else {
        Err(StoreError::Invalid(format!("不支持的问题严重度：{value}")))
    }
}

fn validate_mode(value: &str) -> StoreResult<()> {
    if matches!(value, "system_proxy" | "tun") {
        Ok(())
    } else {
        Err(StoreError::Invalid(format!("不支持的连接方式：{value}")))
    }
}

fn row_to_issue(row: &rusqlite::Row<'_>) -> rusqlite::Result<Issue> {
    Ok(Issue {
        id: row.get(0)?,
        merge_key: row.get(1)?,
        config_id: row.get(2)?,
        kind: row.get(3)?,
        target: row.get(4)?,
        severity: row.get(5)?,
        status: row.get(6)?,
        mode: row.get(7)?,
        title: row.get(8)?,
        occurrences: row.get(9)?,
        first_seen_at: row.get(10)?,
        last_seen_at: row.get(11)?,
        evidence_json: row.get(12)?,
        session_id: row.get(13)?,
        last_handoff_at: row.get(14)?,
        resolved_at: row.get(15)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::configs::{self, NewConfig};
    use crate::store::Store;
    use serde_json::json;

    fn issue<'a>(id: &'a str, severity: &'a str) -> NewIssue<'a> {
        NewIssue {
            id,
            config_id: None,
            kind: "dns_fail",
            target: "",
            severity,
            mode: "system_proxy",
            title: "DNS 解析失败",
            evidence_json: "{}",
        }
    }

    #[test]
    fn identical_issues_are_merged_and_counted() {
        let store = Store::open_in_memory().unwrap();
        let conn = store.conn();
        record(&conn, &issue("iss_1", "P2")).unwrap();
        let merged = record(&conn, &issue("iss_2", "P0")).unwrap();
        assert_eq!(merged.id, "iss_1");
        assert_eq!(merged.occurrences, 2);
        assert_eq!(merged.severity, "P0", "严重度取更严重的那个");
        assert_eq!(list_open(&conn).unwrap().len(), 1);
    }

    #[test]
    fn global_and_per_config_issues_do_not_merge() {
        let store = Store::open_in_memory().unwrap();
        let conn = store.conn();
        configs::create(
            &conn,
            &NewConfig {
                id: "cfg_1",
                name: "A",
                connection_mode: "system_proxy",
                routing_mode: "proxy_all",
                listen_port: Some(7890),
                dns: &json!({ "mode": "auto", "local": [], "remote": [] }),
                tun_excludes: &json!([]),
            },
        )
        .unwrap();

        record(&conn, &issue("iss_1", "P1")).unwrap();
        let mut scoped = issue("iss_2", "P1");
        scoped.config_id = Some("cfg_1");
        record(&conn, &scoped).unwrap();
        assert_eq!(list_open(&conn).unwrap().len(), 2);
    }

    #[test]
    fn resolving_then_recording_reopens_the_same_row() {
        let store = Store::open_in_memory().unwrap();
        let conn = store.conn();
        record(&conn, &issue("iss_1", "P1")).unwrap();
        resolve(&conn, "iss_1").unwrap();
        assert!(list_open(&conn).unwrap().is_empty());

        let reopened = record(&conn, &issue("iss_2", "P1")).unwrap();
        assert_eq!(reopened.id, "iss_1");
        assert_eq!(reopened.status, "open");
        assert_eq!(reopened.occurrences, 2);
        assert!(reopened.resolved_at.is_none());
    }
}
