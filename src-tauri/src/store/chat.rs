use rusqlite::{params, Connection, OptionalExtension};
use serde_json::Value;

use super::db::now_ms;
use super::error::{StoreError, StoreResult};

#[derive(Debug, Clone)]
pub struct ChatSession {
    pub id: String,
    pub title: String,
    pub created_at: i64,
}

#[derive(Debug, Clone)]
pub struct ChatMessage {
    pub id: String,
    pub session_id: String,
    pub role: String,
    pub content: String,
    pub tool: Option<Value>,
    pub created_at: i64,
}

/// 幂等：会话不存在就建；已存在不改标题。
pub fn ensure_session(conn: &Connection, id: &str, title: &str) -> StoreResult<()> {
    conn.execute(
        "INSERT INTO chat_sessions (id, title, created_at) VALUES (?1, ?2, ?3)
         ON CONFLICT(id) DO NOTHING",
        params![id, title, now_ms()],
    )?;
    Ok(())
}

pub fn append_message(
    conn: &Connection,
    id: &str,
    session_id: &str,
    role: &str,
    content: &str,
    tool: Option<&Value>,
) -> StoreResult<()> {
    ensure_session(conn, session_id, &default_title(content))?;
    conn.execute(
        "INSERT INTO chat_messages (id, session_id, role, content, tool_json, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![
            id,
            session_id,
            role,
            content,
            tool.map(|value| value.to_string()),
            now_ms()
        ],
    )?;
    Ok(())
}

pub fn list_sessions(conn: &Connection) -> StoreResult<Vec<ChatSession>> {
    let mut statement =
        conn.prepare("SELECT id, title, created_at FROM chat_sessions ORDER BY created_at ASC")?;
    let rows = statement.query_map([], |row| {
        Ok(ChatSession {
            id: row.get(0)?,
            title: row.get(1)?,
            created_at: row.get(2)?,
        })
    })?;
    rows.collect::<Result<Vec<_>, _>>().map_err(StoreError::from)
}

pub fn messages(conn: &Connection, session_id: &str) -> StoreResult<Vec<ChatMessage>> {
    let mut statement = conn.prepare(
        "SELECT id, session_id, role, content, tool_json, created_at
           FROM chat_messages WHERE session_id = ?1 ORDER BY created_at ASC",
    )?;
    let rows = statement.query_map(params![session_id], |row| {
        let tool_json: Option<String> = row.get(4)?;
        Ok(ChatMessage {
            id: row.get(0)?,
            session_id: row.get(1)?,
            role: row.get(2)?,
            content: row.get(3)?,
            tool: tool_json.and_then(|text| serde_json::from_str(&text).ok()),
            created_at: row.get(5)?,
        })
    })?;
    rows.collect::<Result<Vec<_>, _>>().map_err(StoreError::from)
}

pub fn latest_session(conn: &Connection) -> StoreResult<Option<ChatSession>> {
    conn.query_row(
        "SELECT id, title, created_at FROM chat_sessions ORDER BY created_at DESC LIMIT 1",
        [],
        |row| {
            Ok(ChatSession {
                id: row.get(0)?,
                title: row.get(1)?,
                created_at: row.get(2)?,
            })
        },
    )
    .optional()
    .map_err(StoreError::from)
}

pub fn delete_session(conn: &Connection, session_id: &str) -> StoreResult<()> {
    conn.execute("DELETE FROM chat_sessions WHERE id = ?1", params![session_id])?;
    Ok(())
}

fn default_title(content: &str) -> String {
    let title: String = content.trim().chars().take(30).collect();
    if title.is_empty() {
        "新会话".to_string()
    } else {
        title
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn messages_round_trip_in_order() {
        let store = super::super::db::Store::open_in_memory().unwrap();
        let conn = store.conn();

        append_message(&conn, "msg_1", "ses_1", "user", "连到日本", None).unwrap();
        append_message(
            &conn,
            "msg_2",
            "ses_1",
            "assistant",
            "已连接",
            Some(&serde_json::json!({ "tool": "VpnConnect" })),
        )
        .unwrap();

        let messages = messages(&conn, "ses_1").unwrap();
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0].role, "user");
        assert_eq!(messages[1].tool.as_ref().unwrap()["tool"], "VpnConnect");

        let sessions = list_sessions(&conn).unwrap();
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].title, "连到日本");
    }

    #[test]
    fn ensuring_a_session_twice_keeps_the_first_title() {
        let store = super::super::db::Store::open_in_memory().unwrap();
        let conn = store.conn();

        ensure_session(&conn, "ses_1", "第一个标题").unwrap();
        ensure_session(&conn, "ses_1", "第二个标题").unwrap();

        let sessions = list_sessions(&conn).unwrap();
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].title, "第一个标题");
    }

    #[test]
    fn messages_survive_a_reopen() {
        let dir = std::env::temp_dir().join(format!("veyl-chat-{:016x}", rand::random::<u64>()));
        let path = dir.join("veyl.db");

        {
            let store = super::super::db::Store::open(&path).unwrap();
            let conn = store.conn();
            append_message(&conn, "msg_1", "ses_1", "user", "连到日本", None).unwrap();
            append_message(&conn, "msg_2", "ses_1", "assistant", "已连接", None).unwrap();
        }

        let reopened = super::super::db::Store::open(&path).unwrap();
        {
            let conn = reopened.conn();
            let messages = messages(&conn, "ses_1").unwrap();
            assert_eq!(messages.len(), 2);
            assert_eq!(messages[1].content, "已连接");
            assert_eq!(latest_session(&conn).unwrap().unwrap().id, "ses_1");
        }
        drop(reopened);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn deleting_a_session_cascades_to_messages() {
        let store = super::super::db::Store::open_in_memory().unwrap();
        let conn = store.conn();

        append_message(&conn, "msg_1", "ses_1", "user", "hi", None).unwrap();
        delete_session(&conn, "ses_1").unwrap();

        assert!(messages(&conn, "ses_1").unwrap().is_empty());
        assert!(latest_session(&conn).unwrap().is_none());
    }
}
