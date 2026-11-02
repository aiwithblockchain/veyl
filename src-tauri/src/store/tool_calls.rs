use rusqlite::{params, Connection, OptionalExtension};
use serde_json::Value;

use super::db::now_ms;
use super::error::{StoreError, StoreResult};

/// `tool_calls.approved` 的三值语义。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Approval {
    Denied,
    Once,
    Session,
}

impl Approval {
    pub fn as_code(self) -> i64 {
        match self {
            Approval::Denied => 0,
            Approval::Once => 1,
            Approval::Session => 2,
        }
    }

    pub fn from_code(code: i64) -> Option<Self> {
        match code {
            0 => Some(Approval::Denied),
            1 => Some(Approval::Once),
            2 => Some(Approval::Session),
            _ => None,
        }
    }

    /// 同会话内由 Grant 自动放行的调用也记 2，审计表能看出「没弹卡是因为会话授权」。
    pub fn auto_granted() -> Self {
        Approval::Session
    }
}

#[derive(Debug, Clone)]
pub struct NewCall<'a> {
    pub id: &'a str,
    pub session_id: Option<&'a str>,
    pub request_id: Option<&'a str>,
    pub tool_name: &'a str,
    pub args: &'a Value,
}

#[derive(Debug, Clone)]
pub struct ToolCallRecord {
    pub id: String,
    pub session_id: Option<String>,
    pub request_id: Option<String>,
    pub tool_name: String,
    pub args: Value,
    pub approved: Option<Approval>,
    pub result: Option<Value>,
    pub is_error: bool,
    pub created_at: i64,
    pub finished_at: Option<i64>,
}

/// 请求开始时写入一行；`approved` 留空，等审批结果再回填。
pub fn begin(conn: &Connection, call: &NewCall<'_>) -> StoreResult<()> {
    conn.execute(
        "INSERT INTO tool_calls (id, session_id, request_id, tool_name, args_json, approved, is_error, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, NULL, 0, ?6)",
        params![
            call.id,
            call.session_id,
            call.request_id,
            call.tool_name,
            call.args.to_string(),
            now_ms()
        ],
    )?;
    Ok(())
}

pub fn record_approval(conn: &Connection, id: &str, approval: Approval) -> StoreResult<()> {
    let changed = conn.execute(
        "UPDATE tool_calls SET approved = ?1 WHERE id = ?2",
        params![approval.as_code(), id],
    )?;
    if changed == 0 {
        return Err(StoreError::NotFound(id.to_string()));
    }
    Ok(())
}

/// 按 (session, tool) 找到最近一条尚未定论的调用并回填审批结果。
/// UI 的审批命令拿不到 tool_id，只能这样关联。
pub fn record_approval_for(
    conn: &Connection,
    session_id: &str,
    tool_name: &str,
    approval: Approval,
) -> StoreResult<usize> {
    let changed = conn.execute(
        "UPDATE tool_calls SET approved = ?1
          WHERE id = (
              SELECT id FROM tool_calls
               WHERE session_id = ?2 AND tool_name = ?3 AND approved IS NULL
               ORDER BY created_at DESC LIMIT 1
          )",
        params![approval.as_code(), session_id, tool_name],
    )?;
    Ok(changed)
}

pub fn finish(conn: &Connection, id: &str, result: &Value, is_error: bool) -> StoreResult<()> {
    let changed = conn.execute(
        "UPDATE tool_calls SET result_json = ?1, is_error = ?2, finished_at = ?3 WHERE id = ?4",
        params![result.to_string(), if is_error { 1 } else { 0 }, now_ms(), id],
    )?;
    if changed == 0 {
        return Err(StoreError::NotFound(id.to_string()));
    }
    Ok(())
}

pub fn get(conn: &Connection, id: &str) -> StoreResult<Option<ToolCallRecord>> {
    conn.query_row(
        "SELECT id, session_id, request_id, tool_name, args_json, approved, result_json,
                is_error, created_at, finished_at
           FROM tool_calls WHERE id = ?1",
        params![id],
        row_to_record,
    )
    .optional()
    .map_err(StoreError::from)
}

pub fn recent(conn: &Connection, session_id: Option<&str>, limit: u32) -> StoreResult<Vec<ToolCallRecord>> {
    let mut statement = conn.prepare(
        "SELECT id, session_id, request_id, tool_name, args_json, approved, result_json,
                is_error, created_at, finished_at
           FROM tool_calls
          WHERE (?1 IS NULL OR session_id = ?1)
          ORDER BY created_at DESC
          LIMIT ?2",
    )?;
    let rows = statement.query_map(params![session_id, limit], row_to_record)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(StoreError::from)
}

fn row_to_record(row: &rusqlite::Row<'_>) -> rusqlite::Result<ToolCallRecord> {
    let args_json: String = row.get(4)?;
    let approved: Option<i64> = row.get(5)?;
    let result_json: Option<String> = row.get(6)?;
    Ok(ToolCallRecord {
        id: row.get(0)?,
        session_id: row.get(1)?,
        request_id: row.get(2)?,
        tool_name: row.get(3)?,
        args: serde_json::from_str(&args_json).unwrap_or(Value::Null),
        approved: approved.and_then(Approval::from_code),
        result: result_json.and_then(|text| serde_json::from_str(&text).ok()),
        is_error: row.get::<_, i64>(7)? == 1,
        created_at: row.get(8)?,
        finished_at: row.get(9)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn begin_sample(conn: &Connection, id: &str) {
        begin(
            conn,
            &NewCall {
                id,
                session_id: Some("ses_1"),
                request_id: Some("req_1"),
                tool_name: "VpnConnect",
                args: &json!({ "target": { "node_id": "seed-jp-01" } }),
            },
        )
        .unwrap();
    }

    #[test]
    fn approval_codes_match_the_contract() {
        assert_eq!(Approval::Denied.as_code(), 0);
        assert_eq!(Approval::Once.as_code(), 1);
        assert_eq!(Approval::Session.as_code(), 2);
        assert_eq!(Approval::from_code(2), Some(Approval::Session));
        assert_eq!(Approval::from_code(7), None);
    }

    #[test]
    fn a_call_starts_without_an_approval_and_finishes_with_a_result() {
        let store = super::super::db::Store::open_in_memory().unwrap();
        let conn = store.conn();

        begin_sample(&conn, "call_1");
        let record = get(&conn, "call_1").unwrap().unwrap();
        assert_eq!(record.approved, None);
        assert!(record.finished_at.is_none());

        record_approval(&conn, "call_1", Approval::Once).unwrap();
        finish(&conn, "call_1", &json!({ "ok": true }), false).unwrap();

        let record = get(&conn, "call_1").unwrap().unwrap();
        assert_eq!(record.approved, Some(Approval::Once));
        assert!(!record.is_error);
        assert_eq!(record.result.unwrap()["ok"], true);
        assert!(record.finished_at.is_some());
    }

    #[test]
    fn session_grants_are_recorded_as_two() {
        let store = super::super::db::Store::open_in_memory().unwrap();
        let conn = store.conn();

        begin_sample(&conn, "call_2");
        record_approval(&conn, "call_2", Approval::auto_granted()).unwrap();

        assert_eq!(
            get(&conn, "call_2").unwrap().unwrap().approved,
            Some(Approval::Session)
        );
    }

    #[test]
    fn rejecting_a_call_is_recorded_as_zero() {
        let store = super::super::db::Store::open_in_memory().unwrap();
        let conn = store.conn();

        begin_sample(&conn, "call_3");
        record_approval(&conn, "call_3", Approval::Denied).unwrap();
        finish(
            &conn,
            "call_3",
            &json!({ "ok": false, "error": { "code": "PERMISSION_DENIED" } }),
            true,
        )
        .unwrap();

        let record = get(&conn, "call_3").unwrap().unwrap();
        assert_eq!(record.approved, Some(Approval::Denied));
        assert!(record.is_error);
    }

    #[test]
    fn record_approval_for_targets_the_open_call() {
        let store = super::super::db::Store::open_in_memory().unwrap();
        let conn = store.conn();

        begin_sample(&conn, "call_1");
        let changed =
            record_approval_for(&conn, "ses_1", "VpnConnect", Approval::Session).unwrap();
        assert_eq!(changed, 1);
        assert_eq!(
            get(&conn, "call_1").unwrap().unwrap().approved,
            Some(Approval::Session)
        );

        // 已经定论的调用不会被第二次改写。
        let again = record_approval_for(&conn, "ses_1", "VpnConnect", Approval::Denied).unwrap();
        assert_eq!(again, 0);
        assert_eq!(
            get(&conn, "call_1").unwrap().unwrap().approved,
            Some(Approval::Session)
        );
    }

    #[test]
    fn recent_filters_by_session() {
        let store = super::super::db::Store::open_in_memory().unwrap();
        let conn = store.conn();
        begin_sample(&conn, "call_a");
        begin(
            &conn,
            &NewCall {
                id: "call_b",
                session_id: Some("ses_2"),
                request_id: None,
                tool_name: "RuntimeStatus",
                args: &json!({}),
            },
        )
        .unwrap();

        assert_eq!(recent(&conn, Some("ses_1"), 10).unwrap().len(), 1);
        assert_eq!(recent(&conn, None, 10).unwrap().len(), 2);
    }
}
