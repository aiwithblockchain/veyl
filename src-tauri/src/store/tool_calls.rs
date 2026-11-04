use rusqlite::{params, Connection, OptionalExtension};
use serde_json::Value;

use super::db::now_ms;
use super::error::{StoreError, StoreResult};

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
    /// 审批已移除，恒为 NULL；保留字段供审计表兼容。
    pub approved: Option<i64>,
    pub result: Option<Value>,
    pub is_error: bool,
    pub created_at: i64,
    pub finished_at: Option<i64>,
}

/// 请求开始时写入一行；审批已移除，`approved` 恒为 NULL。
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

/// 会话里最新一条**尚未完成**的某个工具调用。
///
/// 进程重启后内存里的 pending 没了，但 `tool_calls` 那行还在：
/// `finished_at` 为空就说明没人答过，可以据此还原等待中的提问。
pub fn latest_unfinished(
    conn: &Connection,
    session_id: &str,
    tool_name: &str,
) -> StoreResult<Option<ToolCallRecord>> {
    conn.query_row(
        "SELECT id, session_id, request_id, tool_name, args_json, approved, result_json,
                is_error, created_at, finished_at
           FROM tool_calls
          WHERE session_id = ?1 AND tool_name = ?2 AND finished_at IS NULL
          ORDER BY created_at DESC, rowid DESC
          LIMIT 1",
        params![session_id, tool_name],
        row_to_record,
    )
    .optional()
    .map_err(StoreError::from)
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
        approved,
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
    fn a_call_is_recorded_and_finished_without_an_approval() {
        let store = super::super::db::Store::open_in_memory().unwrap();
        let conn = store.conn();

        begin_sample(&conn, "call_1");
        let record = get(&conn, "call_1").unwrap().unwrap();
        assert_eq!(record.approved, None, "审批已移除，始终为 NULL");
        assert!(record.finished_at.is_none());

        finish(&conn, "call_1", &json!({ "ok": true }), false).unwrap();

        let record = get(&conn, "call_1").unwrap().unwrap();
        assert_eq!(record.approved, None, "执行结束后仍为 NULL（语义：不适用）");
        assert!(!record.is_error);
        assert_eq!(record.result.unwrap()["ok"], true);
        assert!(record.finished_at.is_some());
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
