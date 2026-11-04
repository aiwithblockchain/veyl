//! AskUserQuestion 的一等通道：Claurst 的 `UserQuestionEvent` → Tauri 事件 → 回答回传。
//!
//! 语义（契约 1.2.0）：单选，answer 必须是 options 之一；空字符串表示跳过。
//! 300 秒未答由 Host 自动回空串；请求结束 / 取消 / 会话删除时清理，避免 oneshot 永远挂着。

use std::collections::{HashMap, HashSet};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use claurst_tools::UserQuestionEvent;
use serde_json::{json, Value};
use tokio::sync::oneshot;

use super::app_handle;
use crate::claurst_session::events::{now, EV_ASK_USER_QUESTION};

/// 等用户回答的时限。
///
/// 首启那两个问题是产品主流程，5 分钟不够——用户去倒杯水回来就没了。
/// 但也不能永不超时：这一轮对话会一直挂着等一个 oneshot。
/// 15 分钟是「人可能离开」与「别把会话挂死」之间的折中。
/// 超时之后问题不会恢复——重启后的会话没有历史，答案传不回模型；
/// 那时的正确路径是重新发一条消息让 AI 再问一遍。
const ANSWER_TIMEOUT_MS: i64 = 15 * 60 * 1000;

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

/// 「用 Veyl 提供的默认节点」这个选项里一定会出现的词。
///
/// 选项文案由模型生成，可能写成「使用 Veyl 的默认节点」「用默认节点」，
/// 所以按语义片段认，不按整串相等——认错方向只会多问一次，不会少问。
const SEED_OPTION_MARKER: &str = "默认节点";

/// 用户已明确选择默认节点的记录，键是 (session_id, request_id)。
///
/// 只为一件事存在：挡住绕开提示词、直接 `ConfigCreate(source:"seed")` 的路径。
/// 请求结束就清掉——下一个请求要重新问，用户没答过就不能用我们的服务器。
fn seed_consents() -> &'static Mutex<HashSet<(String, String)>> {
    static CONSENTS: OnceLock<Mutex<HashSet<(String, String)>>> = OnceLock::new();
    CONSENTS.get_or_init(|| Mutex::new(HashSet::new()))
}

/// 本请求里用户是否明确选过「用 Veyl 提供的默认节点」。
pub fn seed_consent_granted(session_id: &str, request_id: &str) -> bool {
    seed_consents()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .contains(&(session_id.to_string(), request_id.to_string()))
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
/// **只认内存里的 pending。** 进程重启后 pending 就没了——这是刻意的：
/// 恢复出来的问题即使能显示，答案也传不回模型（那一轮对话已经结束，
/// oneshot 与消息历史都不在了）。重启后的正确路径是重新发一条消息，
/// 让 AI 重新问一遍。
pub fn reply(session_id: &str, question_id: &str, answer: &str) -> Result<(), (String, String)> {
    let matched = {
        let guard = pending().lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        match guard.get(question_id) {
            None => None,
            Some(question) if question.session_id != session_id => {
                return Err(not_pending());
            }
            Some(question) => Some((question.options.clone(), question.request_id.clone())),
        }
    };

    let Some((options, request_id)) = matched else {
        return Err(not_pending());
    };
    if !answer.is_empty() && !options.iter().any(|option| option == answer) {
        return Err((
            "answer_not_in_options".into(),
            "回答必须是给定选项之一".into(),
        ));
    }

    if !settle(question_id, answer.to_string()) {
        return Err(not_pending());
    }
    // 记在 settle 之后：同一问题被并发答两次时，失败的那次不该留下同意记录。
    if !answer.is_empty() && answer.contains(SEED_OPTION_MARKER) {
        seed_consents()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert((session_id.to_string(), request_id));
    }
    Ok(())
}

/// 当前 session 未回答的问题（同一进程内重连用）。
///
/// 只读内存：跨进程不做恢复，理由见 [`reply`]。
pub fn list_pending(session_id: &str) -> Value {
    let guard = pending().lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let mut entries: Vec<(&String, &PendingQuestion)> = guard
        .iter()
        .filter(|(_, question)| question.session_id == session_id)
        .collect();
    entries.sort_by_key(|(_, question)| question.created_at);
    let items: Vec<Value> = entries
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
        .collect();
    json!({ "questions": items })
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
    seed_consents()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .retain(|(session, request)| {
            !(session.as_str() == session_id && request.as_str() == request_id)
        });
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
    seed_consents()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .retain(|(session, _)| session.as_str() != session_id);
}

#[cfg(test)]
mod memory_tests {
    use super::*;
    use tokio::sync::oneshot;

    fn event(question: &str, options: &[&str]) -> (UserQuestionEvent, oneshot::Receiver<String>) {
        let (tx, rx) = oneshot::channel();
        (
            UserQuestionEvent {
                question: question.to_string(),
                options: Some(options.iter().map(|option| option.to_string()).collect()),
                reply_tx: tx,
            },
            rx,
        )
    }

    #[tokio::test]
    async fn a_live_question_is_listed_and_its_answer_reaches_the_tool() {
        let (event, rx) = event(
            "你主要想用它做什么？",
            &["仅使用网页浏览网站", "APP 也需要使用 VPN"],
        );
        register("ses_live", "req_live", event);

        let listed = list_pending("ses_live");
        let items = listed["questions"].as_array().unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0]["question"], "你主要想用它做什么？");
        let question_id = items[0]["question_id"].as_str().unwrap().to_string();

        reply("ses_live", &question_id, "APP 也需要使用 VPN").unwrap();
        assert_eq!(rx.await.unwrap(), "APP 也需要使用 VPN");
        assert!(list_pending("ses_live")["questions"]
            .as_array()
            .unwrap()
            .is_empty());
    }

    /// 进程重启后内存是空的：`list_pending` 必须返回空数组。
    ///
    /// 这是**现在的正确行为**——跨进程不恢复，重启后由「重新发一条消息」
    /// 让 AI 重新提问。从数据库翻旧问题没有意义：答案传不回模型。
    #[tokio::test]
    async fn pending_questions_do_not_survive_a_restart() {
        assert!(list_pending("ses_after_restart")["questions"]
            .as_array()
            .unwrap()
            .is_empty());
        assert!(reply("ses_after_restart", "q_whatever", "A").is_err());
    }

    #[tokio::test]
    async fn an_answer_outside_the_options_is_rejected_and_the_question_stays() {
        let (event, _rx) = event("选一个", &["A", "B"]);
        register("ses_options", "req_options", event);
        let id = list_pending("ses_options")["questions"][0]["question_id"]
            .as_str()
            .unwrap()
            .to_string();

        let error = reply("ses_options", &id, "C").unwrap_err();
        assert_eq!(error.0, "answer_not_in_options");
        assert_eq!(
            list_pending("ses_options")["questions"].as_array().unwrap().len(),
            1,
            "被拒绝的回答不能让问题消失"
        );
    }

    /// 选了「用 Veyl 提供的默认节点」才留下同意记录，且只对当前请求有效。
    #[tokio::test]
    async fn choosing_the_default_nodes_grants_consent_until_the_request_ends() {
        let (event, _rx) = event(
            "节点从哪来？",
            &["用 Veyl 提供的默认节点", "用我自己的节点"],
        );
        register("ses_seed", "req_seed", event);
        let id = list_pending("ses_seed")["questions"][0]["question_id"]
            .as_str()
            .unwrap()
            .to_string();

        assert!(!seed_consent_granted("ses_seed", "req_seed"));
        reply("ses_seed", &id, "用 Veyl 提供的默认节点").unwrap();
        assert!(seed_consent_granted("ses_seed", "req_seed"));
        assert!(
            !seed_consent_granted("ses_seed", "req_other"),
            "同意只属于当前请求"
        );

        cleanup_request("ses_seed", "req_seed");
        assert!(
            !seed_consent_granted("ses_seed", "req_seed"),
            "请求结束后必须清掉：下一次要重新问"
        );
    }

    #[tokio::test]
    async fn choosing_own_nodes_does_not_grant_consent() {
        let (event, _rx) = event(
            "节点从哪来？",
            &["用 Veyl 提供的默认节点", "用我自己的节点"],
        );
        register("ses_own", "req_own", event);
        let id = list_pending("ses_own")["questions"][0]["question_id"]
            .as_str()
            .unwrap()
            .to_string();

        reply("ses_own", &id, "用我自己的节点").unwrap();
        assert!(!seed_consent_granted("ses_own", "req_own"));
        cleanup_request("ses_own", "req_own");
    }

    /// 超时自动跳过不算同意。
    #[tokio::test]
    async fn skipping_the_question_does_not_grant_consent() {
        let (event, _rx) = event(
            "节点从哪来？",
            &["用 Veyl 提供的默认节点", "用我自己的节点"],
        );
        register("ses_skip", "req_skip", event);
        let id = list_pending("ses_skip")["questions"][0]["question_id"]
            .as_str()
            .unwrap()
            .to_string();

        reply("ses_skip", &id, "").unwrap();
        assert!(!seed_consent_granted("ses_skip", "req_skip"));
        cleanup_request("ses_skip", "req_skip");
    }
}
