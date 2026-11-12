//! AskUserQuestion 的一等通道：Claurst 的 `UserQuestionEvent` → Tauri 事件 → 回答回传。
//!
//! 语义（契约 2.16.0）：普通提问接受任何非空文本，空字符串表示跳过；
//! 升级确认卡（`core_upgrade_confirm`）是装包授权，仍必须逐字等于 options 之一。
//! 15 分钟未答由 Host 自动回空串；请求结束 / 取消 / 会话删除时清理，避免 oneshot 永远挂着。

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
    /// UI 用来渲染专用卡片（当前只有 `core_upgrade_confirm`）。
    kind: Option<String>,
    details: Option<Value>,
    default_index: Option<u32>,
    /// 升级确认绑定：同意一次只对这一个版本 + 产物哈希有效。
    target_version: Option<String>,
    artifact_sha256: Option<String>,
}

/// 带专用卡片信息的提问（目前只有 AI 代劳升级）。
pub struct QuestionExtras {
    pub kind: &'static str,
    pub details: Value,
    pub default_index: u32,
    pub target_version: Option<String>,
    pub artifact_sha256: Option<String>,
}

fn pending() -> &'static Mutex<HashMap<String, PendingQuestion>> {
    static PENDING: OnceLock<Mutex<HashMap<String, PendingQuestion>>> = OnceLock::new();
    PENDING.get_or_init(|| Mutex::new(HashMap::new()))
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// 节点来源那一问的规范选项。**只认这一串，逐字相等**。
///
/// 曾经用「答案包含『默认节点』」判断，模型问「不使用默认节点」、用户选了它，
/// 也会被记成同意——门槛形同虚设。问题里没给这个规范选项的，一律不算。
const SEED_OPTION: &str = "Veyl 免费节点（仅供试用）";

/// 这次回答算不算「同意用默认节点」：问题确实给了规范选项，且用户选的正是它。
fn grants_seed_consent(options: &[String], answer: &str) -> bool {
    options.iter().any(|option| option == SEED_OPTION) && answer.trim() == SEED_OPTION
}

/// 用户已明确选择默认节点的记录，键是 (session_id, request_id)。
///
/// 只为一件事存在：挡住绕开提示词、直接 `ConfigCreate(source:"seed")` 的路径。
/// 请求结束就清掉——下一个请求要重新问，用户没答过就不能用我们的服务器。
fn seed_consents() -> &'static Mutex<HashSet<(String, String)>> {
    static CONSENTS: OnceLock<Mutex<HashSet<(String, String)>>> = OnceLock::new();
    CONSENTS.get_or_init(|| Mutex::new(HashSet::new()))
}

fn record_seed_consent(session_id: &str, request_id: &str) {
    seed_consents()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .insert((session_id.to_string(), request_id.to_string()));
}

/// 本请求里用户是否明确选过「Veyl 免费节点（仅供试用）」。
pub fn seed_consent_granted(session_id: &str, request_id: &str) -> bool {
    seed_consents()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .contains(&(session_id.to_string(), request_id.to_string()))
}

/// 升级确认的一次性同意：`(session_id, request_id, target_version, artifact_sha256)`。
///
/// 换版本或换产物必须重新确认——模型不能拿上一次的同意去装另一个包。
fn upgrade_consents() -> &'static Mutex<HashSet<(String, String, String, String)>> {
    static CONSENTS: OnceLock<Mutex<HashSet<(String, String, String, String)>>> = OnceLock::new();
    CONSENTS.get_or_init(|| Mutex::new(HashSet::new()))
}

fn record_upgrade_consent(session_id: &str, request_id: &str, target: &str, sha: &str) {
    upgrade_consents()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .insert((
            session_id.to_string(),
            request_id.to_string(),
            target.to_string(),
            sha.to_ascii_lowercase(),
        ));
}

pub fn upgrade_consent_granted(
    session_id: &str,
    request_id: &str,
    target: &str,
    sha: &str,
) -> bool {
    upgrade_consents()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .contains(&(
            session_id.to_string(),
            request_id.to_string(),
            target.to_string(),
            sha.to_ascii_lowercase(),
        ))
}

/// 取走并删除一次性同意。建任务时只消费一次，第二次升级必须重新确认。
pub fn consume_upgrade_consent(
    session_id: &str,
    request_id: &str,
    target: &str,
    sha: &str,
) -> bool {
    upgrade_consents()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .remove(&(
            session_id.to_string(),
            request_id.to_string(),
            target.to_string(),
            sha.to_ascii_lowercase(),
        ))
}

/// 收到 Claurst 的提问：登记 pending、发事件、启动超时。
pub fn register(session_id: &str, request_id: &str, event: UserQuestionEvent) {
    register_with(session_id, request_id, event, None);
}

/// 同 `register`，但可以带专用卡片（kind/details/默认焦点）与升级绑定信息。
pub fn register_with(
    session_id: &str,
    request_id: &str,
    event: UserQuestionEvent,
    extras: Option<QuestionExtras>,
) {
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

    let (kind, details, default_index, target_version, artifact_sha256) = match extras {
        Some(extras) => (
            Some(extras.kind.to_string()),
            Some(extras.details),
            Some(extras.default_index),
            extras.target_version,
            extras.artifact_sha256,
        ),
        None => (None, None, None, None, None),
    };

    {
        let mut guard = pending()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        guard.insert(
            question_id.clone(),
            PendingQuestion {
                session_id: session_id.to_string(),
                request_id: request_id.to_string(),
                question: event.question.clone(),
                options: options.clone(),
                created_at,
                reply: Some(event.reply_tx),
                kind: kind.clone(),
                details: details.clone(),
                default_index,
                target_version,
                artifact_sha256,
            },
        );
    }

    let mut payload = json!({
        "contract_version": crate::runtime::EVENT_CONTRACT_VERSION,
        "session_id": session_id,
        "request_id": request_id,
        "question_id": question_id,
        "question": event.question,
        "options": options,
        "created_at": created_at,
        "expires_at": expires_at,
        "emitted_at": now(),
    });
    if let Some(kind) = &kind {
        payload["kind"] = json!(kind);
    }
    if let Some(details) = details {
        payload["details"] = details;
    }
    if let Some(index) = default_index {
        payload["default_index"] = json!(index);
    }
    app_handle::emit(EV_ASK_USER_QUESTION, payload);

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

/// UI 回答。普通提问接受任何非空文本，空串 = 跳过；
/// `core_upgrade_confirm` 只认 options 里的原文。
///
/// **只认内存里的 pending。** 进程重启后 pending 就没了——这是刻意的：
/// 恢复出来的问题即使能显示，答案也传不回模型（那一轮对话已经结束，
/// oneshot 与消息历史都不在了）。重启后的正确路径是重新发一条消息，
/// 让 AI 重新问一遍。
pub fn reply(session_id: &str, question_id: &str, answer: &str) -> Result<(), (String, String)> {
    let matched = {
        let guard = pending()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        match guard.get(question_id) {
            None => None,
            Some(question) if question.session_id != session_id => {
                return Err(not_pending());
            }
            Some(question) => Some((
                question.options.clone(),
                question.request_id.clone(),
                question.kind.clone(),
                question.target_version.clone(),
                question.artifact_sha256.clone(),
            )),
        }
    };

    let Some((options, request_id, kind, target_version, artifact_sha256)) = matched else {
        return Err(not_pending());
    };
    // 装包授权不能靠打字确认：卡片上的选项才是唯一的「同意」。
    let confirm_card = kind.as_deref() == Some("core_upgrade_confirm");
    let skipping = answer.trim().is_empty();
    if confirm_card && !skipping && !options.iter().any(|option| option == answer) {
        return Err((
            "answer_not_in_options".into(),
            "升级确认只能逐字选择给定选项".into(),
        ));
    }
    let answer = if skipping {
        String::new()
    } else {
        answer.to_string()
    };

    // 先认领、再记账、最后送通道。
    //
    // take 是原子的：并发的第二个回答在这里拿到 None，什么都还没记，直接报不存在。
    // 反过来（先记账、settle 失败再回滚）会让第二个回答把第一个刚记的同意删掉。
    let Some(mut question) = take(question_id) else {
        return Err(not_pending());
    };
    // 记账在送通道之前：模型收到答案就会继续跑，可能立刻调 ConfigCreate。
    let granted = grants_seed_consent(&options, &answer);
    if granted {
        record_seed_consent(session_id, &request_id);
    }
    // 升级确认只认逐字「升级」，并且绑定本次的目标版本与产物哈希。
    let upgrade_granted =
        confirm_card && answer == "升级" && target_version.is_some() && artifact_sha256.is_some();
    if let (true, Some(target), Some(sha)) = (upgrade_granted, &target_version, &artifact_sha256) {
        record_upgrade_consent(session_id, &request_id, target, sha);
    }
    if let Some(tx) = question.reply.take() {
        let _ = tx.send(answer.clone());
    }
    if !answer.is_empty() {
        record_user_answer(session_id, &answer);
    }
    Ok(())
}

/// 回答落库，只作聊天历史。
///
/// 答案已经通过工具结果送回模型，写库是给重启后的聊天记录用的，不会再喂一遍。
/// 在成功认领这条问题之后写：认领失败说明它已被别处处理（超时 / 取消 / 请求结束），
/// 那条答案根本没送到模型，不该出现在历史里。
fn record_user_answer(session_id: &str, answer: &str) {
    let Some(store) = crate::store::global() else {
        return;
    };
    let conn = store.conn();
    if let Err(error) = crate::store::chat::append_message(
        &conn,
        &crate::store::chat::new_message_id(),
        session_id,
        "user",
        answer,
        None,
    ) {
        log::warn!("AskUserQuestion 的回答没写进聊天历史：{error}");
    }
}

/// 当前 session 未回答的问题（同一进程内重连用）。
///
/// 只读内存：跨进程不做恢复，理由见 [`reply`]。
pub fn list_pending(session_id: &str) -> Value {
    let guard = pending()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
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
                "kind": question.kind,
                "details": question.details,
                "default_index": question.default_index,
            })
        })
        .collect();
    json!({ "questions": items })
}

/// 请求结束 / 取消：把该请求下未答的问题作废。
pub fn cleanup_request(session_id: &str, request_id: &str) {
    let ids: Vec<String> = {
        let guard = pending()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
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
    upgrade_consents()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .retain(|(session, request, _, _)| {
            !(session.as_str() == session_id && request.as_str() == request_id)
        });
}

/// 会话删除：作废该会话所有未答问题。
pub fn cleanup_session(session_id: &str) {
    let ids: Vec<String> = {
        let guard = pending()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
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
    upgrade_consents()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .retain(|(session, _, _, _)| session.as_str() != session_id);
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

    /// 全进程的库（正式启动时由 `lib.rs` 装）。
    ///
    /// `install_global` 先到先得：别的测试模块可能已经装过自己的内存库，
    /// 那就用它的——`reply` 落库写的是 `global()`，读必须读同一个。
    fn test_store() -> std::sync::Arc<crate::store::Store> {
        static STORE: OnceLock<std::sync::Arc<crate::store::Store>> = OnceLock::new();
        crate::store::install_global(
            STORE
                .get_or_init(|| {
                    std::sync::Arc::new(
                        crate::store::Store::open_in_memory().expect("内存库打不开"),
                    )
                })
                .clone(),
        );
        crate::store::global().expect("全局库已装").clone()
    }

    /// 一条 `role = "user"` 的回答记录（没有就别返回空）。
    fn answer_rows(session_id: &str) -> Vec<crate::store::chat::ChatMessage> {
        let store = test_store();
        let conn = store.conn();
        crate::store::chat::messages(&conn, session_id)
            .expect("读聊天记录")
            .into_iter()
            .filter(|message| message.role == "user")
            .collect()
    }

    /// 普通提问是自由文本：用户想补充说明时不该被选项卡住。
    #[tokio::test]
    async fn a_free_text_answer_is_accepted_and_reaches_the_tool() {
        test_store();
        let (event, rx) = event("你主要想用它做什么？", &["仅浏览网页", "APP 也要用"]);
        register("ses_free", "req_free", event);
        let id = list_pending("ses_free")["questions"][0]["question_id"]
            .as_str()
            .unwrap()
            .to_string();

        reply("ses_free", &id, "上班要查资料，手机上也要刷视频").unwrap();
        assert_eq!(rx.await.unwrap(), "上班要查资料，手机上也要刷视频");
        assert!(
            list_pending("ses_free")["questions"]
                .as_array()
                .unwrap()
                .is_empty(),
            "回答之后问题必须消失"
        );

        let rows = answer_rows("ses_free");
        assert_eq!(rows.len(), 1, "回答落库恰好一条：{rows:?}");
        assert_eq!(rows[0].content, "上班要查资料，手机上也要刷视频");
        assert!(rows[0].tool.is_none());
        cleanup_request("ses_free", "req_free");
    }

    /// 装包授权不能靠自由文本：卡片上的选项才是唯一的「同意」。
    #[tokio::test]
    async fn the_upgrade_card_still_rejects_free_text() {
        test_store();
        let (event, _rx) = event("是否升级？", &["升级", "取消"]);
        register_with(
            "ses_up_free",
            "req_up_free",
            event,
            Some(QuestionExtras {
                kind: "core_upgrade_confirm",
                details: json!({}),
                default_index: 1,
                target_version: Some("1.15.0".into()),
                artifact_sha256: Some("ab".into()),
            }),
        );
        let id = list_pending("ses_up_free")["questions"][0]["question_id"]
            .as_str()
            .unwrap()
            .to_string();

        let error = reply("ses_up_free", &id, "那就升吧").unwrap_err();
        assert_eq!(error.0, "answer_not_in_options");
        assert_eq!(
            list_pending("ses_up_free")["questions"]
                .as_array()
                .unwrap()
                .len(),
            1,
            "被拒绝的回答不能让问题消失"
        );
        assert!(
            answer_rows("ses_up_free").is_empty(),
            "没送出去的答案不能落库"
        );
        cleanup_request("ses_up_free", "req_up_free");
    }

    /// 自由作答不授予默认节点同意：同意必须逐字选中规范选项。
    #[tokio::test]
    async fn free_text_does_not_grant_seed_consent() {
        let (event, _rx) = event(
            "节点从哪来？",
            &["Veyl 免费节点（仅供试用）", "用我自己的节点"],
        );
        register("ses_seed_free", "req_seed_free", event);
        let id = list_pending("ses_seed_free")["questions"][0]["question_id"]
            .as_str()
            .unwrap()
            .to_string();

        reply("ses_seed_free", &id, "先用你们的试试").unwrap();
        assert!(!seed_consent_granted("ses_seed_free", "req_seed_free"));
        cleanup_request("ses_seed_free", "req_seed_free");
    }

    /// 两条提交路径（点选项 / 输入框回车）同时回答同一条问题：只有一个能认领，
    /// 认领失败的那个不能把赢家刚记下的同意删掉。
    ///
    /// 跑多轮是为了让「输家回滚晚于赢家记账」的交错一定出现一次——单轮有概率躲过去。
    #[tokio::test]
    async fn concurrent_answers_do_not_revoke_the_consent_that_was_granted() {
        for round in 0..8 {
            let session = format!("ses_race_{round}");
            let request = format!("req_race_{round}");
            let (event, rx) = event(
                "节点从哪来？",
                &["Veyl 免费节点（仅供试用）", "用我自己的节点"],
            );
            register(&session, &request, event);
            let id = list_pending(&session)["questions"][0]["question_id"]
                .as_str()
                .unwrap()
                .to_string();

            let barrier = std::sync::Barrier::new(2);
            let results: Vec<Result<(), (String, String)>> = std::thread::scope(|scope| {
                let handles: Vec<_> = (0..2)
                    .map(|_| {
                        scope.spawn(|| {
                            barrier.wait();
                            reply(&session, &id, SEED_OPTION)
                        })
                    })
                    .collect();
                handles
                    .into_iter()
                    .map(|handle| handle.join().expect("线程不该 panic"))
                    .collect()
            });

            assert_eq!(
                results.iter().filter(|result| result.is_ok()).count(),
                1,
                "第 {round} 轮：只能有一个回答被接受：{results:?}"
            );
            let rejected = results
                .iter()
                .find_map(|result| result.as_ref().err())
                .expect("另一个必须被拒");
            assert_eq!(rejected.0, "question_not_pending");
            assert!(
                seed_consent_granted(&session, &request),
                "第 {round} 轮：赢家记下的同意不能被输家的回滚删掉"
            );
            assert_eq!(rx.await.unwrap(), SEED_OPTION);
            cleanup_request(&session, &request);
        }
    }

    /// 跳过（空串）不落库：历史里只该有用户真说过的话。
    #[tokio::test]
    async fn skipping_a_question_is_not_written_to_history() {
        test_store();
        let (event, _rx) = event("选一个", &["A", "B"]);
        register("ses_skip_store", "req_skip_store", event);
        let id = list_pending("ses_skip_store")["questions"][0]["question_id"]
            .as_str()
            .unwrap()
            .to_string();

        reply("ses_skip_store", &id, "").unwrap();
        assert!(answer_rows("ses_skip_store").is_empty());
        cleanup_request("ses_skip_store", "req_skip_store");
    }

    /// 选了「Veyl 免费节点（仅供试用）」才留下同意记录，且只对当前请求有效。
    #[tokio::test]
    async fn choosing_the_default_nodes_grants_consent_until_the_request_ends() {
        let (event, _rx) = event(
            "节点从哪来？",
            &["Veyl 免费节点（仅供试用）", "用我自己的节点"],
        );
        register("ses_seed", "req_seed", event);
        let id = list_pending("ses_seed")["questions"][0]["question_id"]
            .as_str()
            .unwrap()
            .to_string();

        assert!(!seed_consent_granted("ses_seed", "req_seed"));
        reply("ses_seed", &id, "Veyl 免费节点（仅供试用）").unwrap();
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
            &["Veyl 免费节点（仅供试用）", "用我自己的节点"],
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

    /// 升级同意只绑定本次的目标版本与产物哈希，且只认逐字「升级」。
    #[tokio::test]
    async fn upgrade_consent_is_bound_to_target_and_hash() {
        let extras = || QuestionExtras {
            kind: "core_upgrade_confirm",
            details: json!({ "current_version": "1.14.4", "target_version": "1.15.0" }),
            default_index: 1,
            target_version: Some("1.15.0".into()),
            artifact_sha256: Some("AABB".into()),
        };
        let (event, rx) = event("是否升级？", &["升级", "取消"]);
        register_with("ses_up", "req_up", event, Some(extras()));
        let listed = list_pending("ses_up");
        assert_eq!(listed["questions"][0]["kind"], "core_upgrade_confirm");
        assert_eq!(listed["questions"][0]["default_index"], 1);
        let id = listed["questions"][0]["question_id"]
            .as_str()
            .unwrap()
            .to_string();

        reply("ses_up", &id, "升级").unwrap();
        assert_eq!(rx.await.unwrap(), "升级");
        assert!(upgrade_consent_granted(
            "ses_up", "req_up", "1.15.0", "aabb"
        ));
        assert!(
            !upgrade_consent_granted("ses_up", "req_up", "1.16.0", "aabb"),
            "换版本必须重新确认"
        );
        assert!(
            !upgrade_consent_granted("ses_up", "req_up", "1.15.0", "ccdd"),
            "换产物必须重新确认"
        );
        // 建任务时消费掉：同一份同意不能再用第二次。
        assert!(consume_upgrade_consent(
            "ses_up", "req_up", "1.15.0", "aabb"
        ));
        assert!(!upgrade_consent_granted(
            "ses_up", "req_up", "1.15.0", "aabb"
        ));
        cleanup_request("ses_up", "req_up");
        assert!(!upgrade_consent_granted(
            "ses_up", "req_up", "1.15.0", "aabb"
        ));
    }

    #[tokio::test]
    async fn cancelling_an_upgrade_does_not_grant_consent() {
        let (event, _rx) = event("是否升级？", &["升级", "取消"]);
        register_with(
            "ses_up_cancel",
            "req_up_cancel",
            event,
            Some(QuestionExtras {
                kind: "core_upgrade_confirm",
                details: json!({}),
                default_index: 1,
                target_version: Some("1.15.0".into()),
                artifact_sha256: Some("ab".into()),
            }),
        );
        let id = list_pending("ses_up_cancel")["questions"][0]["question_id"]
            .as_str()
            .unwrap()
            .to_string();
        reply("ses_up_cancel", &id, "取消").unwrap();
        assert!(!upgrade_consent_granted(
            "ses_up_cancel",
            "req_up_cancel",
            "1.15.0",
            "ab"
        ));
        cleanup_request("ses_up_cancel", "req_up_cancel");
    }

    /// 超时自动跳过不算同意。
    #[tokio::test]
    async fn skipping_the_question_does_not_grant_consent() {
        let (event, _rx) = event(
            "节点从哪来？",
            &["Veyl 免费节点（仅供试用）", "用我自己的节点"],
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

    /// 否定选项不能被当成同意：「不使用默认节点」里也有那四个字。
    #[tokio::test]
    async fn a_negative_option_never_grants_consent() {
        let (event, _rx) = event("节点从哪来？", &["使用默认节点", "不使用默认节点"]);
        register("ses_neg", "req_neg", event);
        let id = list_pending("ses_neg")["questions"][0]["question_id"]
            .as_str()
            .unwrap()
            .to_string();

        reply("ses_neg", &id, "不使用默认节点").unwrap();
        assert!(!seed_consent_granted("ses_neg", "req_neg"));
        cleanup_request("ses_neg", "req_neg");
    }

    /// 只认逐字等于规范选项的那一个；加了「（推荐）」之类的变体都不算。
    #[tokio::test]
    async fn only_the_canonical_option_grants_consent() {
        let (event, _rx) = event(
            "节点从哪来？",
            &[
                "Veyl 免费节点（仅供试用）（推荐）",
                "用我自己的节点",
            ],
        );
        register("ses_variant", "req_variant", event);
        let id = list_pending("ses_variant")["questions"][0]["question_id"]
            .as_str()
            .unwrap()
            .to_string();

        reply(
            "ses_variant",
            &id,
            "Veyl 免费节点（仅供试用）（推荐）",
        )
        .unwrap();
        assert!(
            !seed_consent_granted("ses_variant", "req_variant"),
            "变体选项不能授权：同意必须对应提示词规定的那个选项"
        );
        cleanup_request("ses_variant", "req_variant");
    }
}
