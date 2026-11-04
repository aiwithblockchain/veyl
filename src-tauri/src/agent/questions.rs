//! AskUserQuestion 的一等通道：Claurst 的 `UserQuestionEvent` → Tauri 事件 → 回答回传。
//!
//! 语义（契约 1.2.0）：单选，answer 必须是 options 之一；空字符串表示跳过。
//! 300 秒未答由 Host 自动回空串；请求结束 / 取消 / 会话删除时清理，避免 oneshot 永远挂着。

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use claurst_tools::UserQuestionEvent;
use serde_json::{json, Value};
use tokio::sync::oneshot;

use super::app_handle;
use crate::claurst_session::events::{now, EV_ASK_USER_QUESTION};

const ANSWER_TIMEOUT_MS: i64 = 300_000;

/// 提问工具的注册名。恢复时靠它在 `tool_calls` 里认人。
const ASK_TOOL: &str = "AskUserQuestion";

fn not_pending() -> (String, String) {
    ("question_not_pending".into(), "问题不存在或已回答".into())
}

struct PendingQuestion {
    session_id: String,
    request_id: String,
    question: String,
    options: Vec<String>,
    created_at: i64,
    reply: Option<oneshot::Sender<String>>,
}

fn pending() -> &'static Mutex<HashMap<String, PendingQuestion>> {
    static PENDING: OnceLock<Mutex<HashMap<String, PendingQuestion>>> = OnceLock::new();
    PENDING.get_or_init(|| Mutex::new(HashMap::new()))
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// 收到 Claurst 的提问：登记 pending、发事件、启动超时。
pub fn register(session_id: &str, request_id: &str, event: UserQuestionEvent) {
    let options = event.options.clone().unwrap_or_default();
    if options.is_empty() {
        // 正常路径由 AskUserQuestionGuard 拦成 INVALID_ARGUMENT；这里只做防御，不发事件。
        log::warn!("AskUserQuestion 收到空 options，按跳过处理");
        let _ = event.reply_tx.send(String::new());
        return;
    }

    let question_id = format!("q_{}_{:08x}", now_ms(), rand::random::<u32>());
    let created_at = now_ms();
    let expires_at = created_at + ANSWER_TIMEOUT_MS;

    {
        let mut guard = pending().lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        guard.insert(
            question_id.clone(),
            PendingQuestion {
                session_id: session_id.to_string(),
                request_id: request_id.to_string(),
                question: event.question.clone(),
                options: options.clone(),
                created_at,
                reply: Some(event.reply_tx),
            },
        );
    }

    app_handle::emit(
        EV_ASK_USER_QUESTION,
        json!({
            "contract_version": "2.1.0",
            "session_id": session_id,
            "request_id": request_id,
            "question_id": question_id,
            "question": event.question,
            "options": options,
            "created_at": created_at,
            "expires_at": expires_at,
            "emitted_at": now(),
        }),
    );

    let timeout_id = question_id.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(ANSWER_TIMEOUT_MS as u64)).await;
        if settle(&timeout_id, String::new()) {
            log::info!("用户问题 {timeout_id} 超时，自动跳过");
        }
    });
}

/// 取出并移除一个 pending，向等待方发送答案（空串 = 跳过）。
fn take(question_id: &str) -> Option<PendingQuestion> {
    pending()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .remove(question_id)
}

fn settle(question_id: &str, answer: String) -> bool {
    let Some(mut question) = take(question_id) else {
        return false;
    };
    if let Some(tx) = question.reply.take() {
        let _ = tx.send(answer);
    }
    true
}

/// UI 回答。`answer` 必须是 options 之一，或空串（跳过）。
///
/// 内存里找不到时回落到 `tool_calls`：进程重启后内存是空的，
/// 但那条提问记录还在，`finished_at` 为空就说明还没人答过。
pub fn reply(session_id: &str, question_id: &str, answer: &str) -> Result<(), (String, String)> {
    if let Some(options) = memory_options(session_id, question_id)? {
        validate_answer(&options, answer)?;
        if settle(question_id, answer.to_string()) {
            return Ok(());
        }
        return Err(not_pending());
    }

    let Some(store) = crate::store::global() else {
        return Err(not_pending());
    };
    reply_recovered(store, session_id, question_id, answer)
}

/// 内存里有没有这条 pending；有就返回它的选项。返回 `Ok(None)` 表示没有。
fn memory_options(
    session_id: &str,
    question_id: &str,
) -> Result<Option<Vec<String>>, (String, String)> {
    let guard = pending().lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    match guard.get(question_id) {
        None => Ok(None),
        Some(question) if question.session_id != session_id => Err(not_pending()),
        Some(question) => Ok(Some(question.options.clone())),
    }
}

fn validate_answer(options: &[String], answer: &str) -> Result<(), (String, String)> {
    if !answer.is_empty() && !options.iter().any(|option| option == answer) {
        return Err((
            "answer_not_in_options".into(),
            "回答必须是给定选项之一".into(),
        ));
    }
    Ok(())
}

/// 回答一条「重启后恢复」的提问：校验选项，然后把这行工具调用标记为已完成
/// （答案写进 `result_json`），下次就不会再被列出来。
fn reply_recovered(
    store: &crate::store::Store,
    session_id: &str,
    question_id: &str,
    answer: &str,
) -> Result<(), (String, String)> {
    let row = {
        let conn = store.conn();
        crate::store::tool_calls::get(&conn, question_id)
            .ok()
            .flatten()
            .ok_or_else(not_pending)?
    };
    if row.session_id.as_deref() != Some(session_id)
        || row.tool_name != ASK_TOOL
        || row.finished_at.is_some()
    {
        return Err(not_pending());
    }

    let options = question_options(&row.args);
    validate_answer(&options, answer)?;

    let conn = store.conn();
    crate::store::tool_calls::finish(&conn, question_id, &Value::String(answer.to_string()), false)
        .map_err(|error| ("INTERNAL".to_string(), error.to_string()))?;
    log::info!("恢复了重启前未回答的问题 {question_id}");
    Ok(())
}

fn question_options(args: &Value) -> Vec<String> {
    args.get("options")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
}

/// 从 `tool_calls` 还原该会话里还在等回答的那个提问。
fn recovered_questions(store: &crate::store::Store, session_id: &str) -> Vec<Value> {
    let row = {
        let conn = store.conn();
        crate::store::tool_calls::latest_unfinished(&conn, session_id, ASK_TOOL).ok().flatten()
    };
    let Some(row) = row else {
        return Vec::new();
    };
    let options = question_options(&row.args);
    if options.is_empty() {
        return Vec::new();
    }
    let question = row
        .args
        .get("question")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    vec![json!({
        "question_id": row.id,
        "session_id": session_id,
        "request_id": row.request_id,
        "question": question,
        "options": options,
        "created_at": row.created_at,
        "expires_at": row.created_at + ANSWER_TIMEOUT_MS,
    })]
}

/// 当前 session 未回答的问题（重连恢复用）。
///
/// 同进程重连走内存；进程重启后内存是空的，回落到 `tool_calls` 里
/// 那条尚未完成的 `AskUserQuestion`。
pub fn list_pending(session_id: &str) -> Value {
    let from_memory = memory_questions(session_id);
    if !from_memory.is_empty() {
        return json!({ "questions": from_memory });
    }
    let from_store = crate::store::global()
        .map(|store| recovered_questions(store, session_id))
        .unwrap_or_default();
    json!({ "questions": from_store })
}

fn memory_questions(session_id: &str) -> Vec<Value> {
    let guard = pending().lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let mut entries: Vec<(&String, &PendingQuestion)> = guard
        .iter()
        .filter(|(_, question)| question.session_id == session_id)
        .collect();
    entries.sort_by_key(|(_, question)| question.created_at);
    entries
        .into_iter()
        .map(|(question_id, question)| {
            json!({
                "question_id": question_id,
                "session_id": question.session_id,
                "request_id": question.request_id,
                "question": question.question,
                "options": question.options,
                "created_at": question.created_at,
                "expires_at": question.created_at + ANSWER_TIMEOUT_MS,
            })
        })
        .collect()
}

/// 请求结束 / 取消：把该请求下未答的问题作废。
pub fn cleanup_request(session_id: &str, request_id: &str) {
    let ids: Vec<String> = {
        let guard = pending().lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        guard
            .iter()
            .filter(|(_, question)| {
                question.session_id == session_id && question.request_id == request_id
            })
            .map(|(id, _)| id.clone())
            .collect()
    };
    for id in ids {
        settle(&id, String::new());
    }
}

/// 会话删除：作废该会话所有未答问题。
pub fn cleanup_session(session_id: &str) {
    let ids: Vec<String> = {
        let guard = pending().lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        guard
            .iter()
            .filter(|(_, question)| question.session_id == session_id)
            .map(|(id, _)| id.clone())
            .collect()
    };
    for id in ids {
        settle(&id, String::new());
    }
}

#[cfg(test)]
mod recovery_tests {
    use super::*;
    use crate::store::Store;

    fn store_with_question(session: &str, tool_id: &str, answered: bool) -> Store {
        let store = Store::open_in_memory().unwrap();
        {
            let conn = store.conn();
            crate::store::tool_calls::begin(
                &conn,
            &crate::store::tool_calls::NewCall {
                    id: tool_id,
                    session_id: Some(session),
                    request_id: Some("req_1"),
                    tool_name: ASK_TOOL,
                    args: &json!({
                        "question": "你主要想用它做什么？",
                        "options": ["仅使用网页浏览网站", "APP 也需要使用 VPN", "其它服务"]
                    }),
                },
            )
            .unwrap();
            if answered {
                crate::store::tool_calls::finish(
                    &conn,
                    tool_id,
                    &Value::String("APP 也需要使用 VPN".into()),
                    false,
                )
                .unwrap();
            }
        }
        store
    }

    /// 进程重启后内存是空的，问题要从 `tool_calls` 还原出来。
    #[test]
    fn an_unanswered_question_is_restored_from_tool_calls() {
        let store = store_with_question("ses_a", "toolu_1", false);
        let restored = recovered_questions(&store, "ses_a");

        assert_eq!(restored.len(), 1);
        assert_eq!(restored[0]["question_id"], "toolu_1");
        assert_eq!(restored[0]["question"], "你主要想用它做什么？");
        assert_eq!(restored[0]["options"].as_array().unwrap().len(), 3);
    }

    /// 答过的不该再冒出来。
    #[test]
    fn an_answered_question_is_not_restored() {
        let store = store_with_question("ses_b", "toolu_2", true);
        assert!(recovered_questions(&store, "ses_b").is_empty());
    }

    /// 回答恢复出来的问题：当成已答处理，之后不再列出。
    #[test]
    fn replying_to_a_restored_question_marks_it_finished() {
        let store = store_with_question("ses_c", "toolu_3", false);
        reply_recovered(&store, "ses_c", "toolu_3", "APP 也需要使用 VPN").unwrap();
        assert!(recovered_questions(&store, "ses_c").is_empty());
    }

    /// 选项校验对恢复出来的问题同样生效。
    #[test]
    fn a_restored_question_rejects_an_answer_outside_its_options() {
        let store = store_with_question("ses_d", "toolu_4", false);
        let error = reply_recovered(&store, "ses_d", "toolu_4", "别的").unwrap_err();
        assert_eq!(error.0, "answer_not_in_options");
        assert!(!recovered_questions(&store, "ses_d").is_empty(), "拒绝的回答不能把它标成已完成");
    }

    /// 别的会话的提问不能被这条会话认领。
    #[test]
    fn a_question_belongs_to_its_own_session() {
        let store = store_with_question("ses_e", "toolu_5", false);
        assert!(recovered_questions(&store, "ses_other").is_empty());
        assert!(reply_recovered(&store, "ses_other", "toolu_5", "").is_err());
    }
}
