//! `CoreUpgrade`：AI 代劳运行库升级，必须经过 Host 确认卡。
//!
//! 结构性约束：工具自己**没有**直接下载的入口。它只能先查更新、再弹
//! `core_upgrade_confirm`，用户逐字选「升级」后才调用同一个 `core_upgrade`。
//! 因此提示词注入最多让模型多问一次，不能让它跳过确认或零点击下载。
//!
//! 只在用户明确要求更新时可用；询问版本、排查连接都不得调用（提示词 + 描述写死）。

use std::collections::HashSet;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use async_trait::async_trait;
use claurst_tools::{PermissionLevel, Tool, ToolContext, ToolResult, UserQuestionEvent};
use serde_json::{json, Value};

use super::display::Changed;
use super::envelope::{self, AivpnError, ToolOutcome};
use super::services::{ServiceError, VpnToolServices};
use crate::agent::questions::{self, QuestionExtras};
use crate::tools::policy;

const CONFIRM_OPTION: &str = "升级";
const CANCEL_OPTION: &str = "取消";
const CHECK_TIMEOUT: Duration = Duration::from_secs(5);
const SYNC_BUDGET: Duration = Duration::from_secs(12);

pub struct CoreUpgradeTool {
    services: Arc<dyn VpnToolServices>,
}

impl CoreUpgradeTool {
    pub fn new(services: Arc<dyn VpnToolServices>) -> Self {
        Self { services }
    }
}

#[async_trait]
impl Tool for CoreUpgradeTool {
    fn name(&self) -> &str {
        "CoreUpgrade"
    }

    fn description(&self) -> &str {
        "仅在用户明确要求更新运行库时使用：检查官方更新并弹确认卡，用户逐字选「升级」后才会下载安装。\
询问版本、排查连接、给安装建议都不得调用本工具。\n说「新版本」「下次连接生效」，不出现清单、sha256、URL。"
    }

    fn permission_level(&self) -> PermissionLevel {
        PermissionLevel::Execute
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "version": {
                    "type": "string",
                    "pattern": "^[0-9]+\\.[0-9]+\\.[0-9]+$",
                    "description": "可选；不传则升级到官方清单里的最新版本"
                }
            },
            "additionalProperties": false
        })
    }

    async fn execute(&self, input: Value, ctx: &ToolContext) -> ToolResult {
        let outcome = match self.run(input, ctx).await {
            Ok(outcome) => outcome,
            Err(error) => {
                let facts = error
                    .details
                    .as_ref()
                    .and_then(|details| details.get("current_version"))
                    .and_then(Value::as_str)
                    .map(|version| vec![format!("当前版本：{version}")])
                    .unwrap_or_default();
                // 升级失败时版本没变；临时文件由启动清理，不算改动。
                let text = if error.code == "CANCELLED" {
                    "已取消升级"
                } else if error.code == "BUSY" {
                    "本轮没有再次升级"
                } else {
                    "没能升级，仍是旧版本"
                };
                ToolOutcome::fail(error).with_display(text, facts, Changed::None)
            }
        };
        envelope::finish(ctx, "CoreUpgrade", outcome)
    }
}

impl CoreUpgradeTool {
    async fn run(&self, input: Value, ctx: &ToolContext) -> Result<ToolOutcome, AivpnError> {
        let requested = validate_input(&input)?;

        let request_id = policy::current_request_id(&ctx.session_id).ok_or_else(|| {
            AivpnError::new("INTERNAL", "无法确定当前请求，升级没有发起")
        })?;
        if !begin_attempt(&ctx.session_id, &request_id) {
            return Err(AivpnError::new(
                "BUSY",
                "本轮已经尝试过一次升级，不会自动重试；需要的话请用户再发一条消息",
            ));
        }

        // ---- 先查网络，再比较版本。本机信息不联网，失败时也能带上当前版本 ----
        let info = self.services.core_info().await.map_err(|error| {
            AivpnError::new("INTERNAL", format!("读取运行库信息失败：{error}"))
        })?;
        let current = current_version(&info).ok_or_else(|| {
            AivpnError::new("NOT_FOUND", "读不到当前运行库版本，升级没有发起")
        })?;
        let restart_required = info
            .get("restart_required")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let check = self.check_with_retry(&current).await?;

        let Some(target) = pick_target(&check, &current, requested.as_deref())? else {
            return Ok(
                ToolOutcome::ok(
                    format!("运行库 {current} 已是最新版本，没有需要下载的内容。"),
                    json!({
                        "job_id": null,
                        "current_version": current,
                        "target_version": current,
                        "changed": false,
                        "confirmation": "not_needed",
                    }),
                )
                .with_display(
                    "运行库已是最新",
                    vec![format!("当前版本：{current}")],
                    Changed::None,
                ),
            );
        };

        // ---- 确认卡：默认焦点「取消」，Esc/关闭/超时都视为取消 ----
        // 生效时机只看**当前连接状态**，不用升级前的 restart_required：
        // 有连接 → 断开重连；空闲 → 下次连接。卡片与成功消息同一规则。
        let connected = self.is_connected().await;
        let approved = self
            .ask_for_confirmation(
                &ctx.session_id,
                &request_id,
                &current,
                &target,
                restart_required,
                connected,
            )
            .await?;
        if !approved {
            return Err(AivpnError::new(
                "CANCELLED",
                format!("用户取消了升级，没有下载任何内容；现在运行的是 {current}"),
            )
            .with_details(json!({ "current_version": current })));
        }

        match self
            .services
            .core_upgrade(&target.version, "agent", Some(&target.sha256))
            .await
        {
            Ok(data) => {
                let job_id = data
                    .get("job_id")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string();
                // 成功消息按**升级后的实时状态**再算一次，措辞与卡片一致。
                let (restart_after, connected_after) = self.live_effective_state().await;
                let effective = effective_text(restart_after, connected_after);
                Ok(ToolOutcome::ok(
                    format!(
                        "已开始升级到 {}（任务 {job_id}）。{effective}。",
                        target.version
                    ),
                    json!({
                        "job_id": job_id,
                        "current_version": current,
                        "target_version": target.version,
                        "changed": true,
                        "confirmation": "accepted",
                    }),
                )
                .with_display(
                    "升级已开始",
                    vec![
                        format!("版本：{} → {}", current, target.version),
                        format!("生效：{effective}"),
                    ],
                    Changed::None,
                ))
            }
            Err(error) => Err(upgrade_error(&error, &current)),
        }
    }

    async fn check_with_retry(&self, current: &str) -> Result<Value, AivpnError> {
        let result = tokio::time::timeout(SYNC_BUDGET, async {
            let mut last = "未知错误".to_string();
            for attempt in 0..2 {
                let outcome =
                    tokio::time::timeout(CHECK_TIMEOUT, self.services.core_check_updates()).await;
                let network = match &outcome {
                    Err(_) => {
                        last = "检查更新超时".into();
                        "unreachable"
                    }
                    Ok(Err(error)) => {
                        last = error.to_string();
                        if service_error_code(error) == "NETWORK_UNREACHABLE" {
                            "unreachable"
                        } else {
                            "source_error"
                        }
                    }
                    Ok(Ok(value)) => {
                        let network = value.get("network").and_then(Value::as_str).unwrap_or("");
                        if network == "ok" {
                            return Ok(value.clone());
                        }
                        last = value
                            .get("message")
                            .and_then(Value::as_str)
                            .unwrap_or("更新服务不可用")
                            .to_string();
                        if network == "unreachable" {
                            "unreachable"
                        } else {
                            "source_error"
                        }
                    }
                };

                // 只有网络错误允许重试一次；源错误/签名错误不重试。
                if network == "unreachable" && attempt == 0 {
                    continue;
                }
                let code = if network == "unreachable" {
                    "NETWORK_UNREACHABLE"
                } else {
                    "SOURCE_UNAVAILABLE"
                };
                return Err(AivpnError::new(
                    code,
                    format!(
                        "检查更新失败（{last}），升级没有发起；现在运行的是 {current}，未做任何改动"
                    ),
                )
                .with_details(json!({ "current_version": current })));
            }
            Err(AivpnError::new(
                "NETWORK_UNREACHABLE",
                format!("检查更新失败（{last}），升级没有发起；现在运行的是 {current}，未做任何改动"),
            )
            .with_details(json!({ "current_version": current })))
        })
        .await
        .map_err(|_| {
            AivpnError::new(
                "NETWORK_UNREACHABLE",
                format!(
                    "检查更新超过 12 秒，升级没有发起；现在运行的是 {current}，未做任何改动"
                ),
            )
            .with_details(json!({ "current_version": current }))
        })?;
        result
    }

    /// 当前是否有连接（代理或 TUN 在跑）。只用于生成生效时机文案。
    async fn is_connected(&self) -> bool {
        match self.services.runtime_status().await {
            Ok(snapshot) => matches!(
                snapshot.get("state").and_then(Value::as_str),
                Some("running") | Some("degraded")
            ),
            Err(_) => false,
        }
    }

    /// 生效文案的两个输入：是否需要重启 App、当前是否有连接。
    async fn live_effective_state(&self) -> (bool, bool) {
        let restart_required = self
            .services
            .core_info()
            .await
            .ok()
            .and_then(|info| info.get("restart_required").and_then(Value::as_bool))
            .unwrap_or(false);
        (restart_required, self.is_connected().await)
    }

    async fn ask_for_confirmation(
        &self,
        session_id: &str,
        request_id: &str,
        current: &str,
        target: &Target,
        restart_required: bool,
        connected: bool,
    ) -> Result<bool, AivpnError> {
        let size = if target.size > 0 {
            format_size(target.size)
        } else {
            "大小未知".to_string()
        };
        let question = format!(
            "运行库当前 {current}，可升级到 {}。下载 {size}，来源：官方更新。{}。\n是否升级？",
            target.version,
            effective_text(restart_required, connected)
        );
        let details = confirmation_details(current, target, restart_required);

        let (tx, rx) = tokio::sync::oneshot::channel();
        questions::register_with(
            session_id,
            request_id,
            UserQuestionEvent {
                question,
                options: Some(vec![CONFIRM_OPTION.to_string(), CANCEL_OPTION.to_string()]),
                reply_tx: tx,
            },
            Some(QuestionExtras {
                kind: "core_upgrade_confirm",
                details,
                // 默认焦点必须是「取消」。
                default_index: 1,
                target_version: Some(target.version.clone()),
                artifact_sha256: Some(target.sha256.clone()),
            }),
        );

        // 确认等待不计入工具超时；questions 层 15 分钟后自动回空串。
        let answer = rx.await.unwrap_or_default();
        Ok(answer == CONFIRM_OPTION
            && questions::consume_upgrade_consent(
                session_id,
                request_id,
                &target.version,
                &target.sha256,
            ))
    }
}

fn effective_text(restart_required: bool, connected: bool) -> &'static str {
    if restart_required {
        "重启 Veyl 后生效"
    } else if connected {
        "断开并重新连接后生效"
    } else {
        "下次连接时生效"
    }
}

fn confirmation_details(current: &str, target: &Target, restart_required: bool) -> Value {
    json!({
        "current_version": current,
        "target_version": target.version,
        // 清单没给大小（或为 0）时是 null；UI 显示「大小未知」。
        "size": if target.size > 0 { json!(target.size) } else { Value::Null },
        "source": "official",
        "restart_required": restart_required,
    })
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Target {
    version: String,
    size: u64,
    sha256: String,
}

fn validate_input(input: &Value) -> Result<Option<String>, AivpnError> {
    let Some(object) = input.as_object() else {
        return Err(AivpnError::new("INVALID_ARGUMENT", "参数必须是一个对象"));
    };
    // 只允许 version。url / sha256 / size / force 等一律拒绝，不做「忽略」。
    for key in object.keys() {
        if key != "version" {
            return Err(AivpnError::new(
                "INVALID_ARGUMENT",
                format!("不支持的参数 {key}；升级目标只能由版本号决定"),
            )
            .with_details(json!({ "reason": "unknown_argument" })));
        }
    }
    match object.get("version") {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(version)) if is_plain_version(version.trim()) => {
            Ok(Some(version.trim().to_string()))
        }
        Some(_) => Err(AivpnError::new(
            "INVALID_ARGUMENT",
            "version 必须是形如 1.15.0 的版本号",
        )),
    }
}

fn is_plain_version(value: &str) -> bool {
    let parts: Vec<&str> = value.split('.').collect();
    parts.len() == 3
        && parts
            .iter()
            .all(|part| !part.is_empty() && part.chars().all(|ch| ch.is_ascii_digit()))
}

fn current_version(info: &Value) -> Option<String> {
    info.get("active_version")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .or_else(|| {
            info.get("bundled_version")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
        })
        .map(str::to_string)
}

/// 从检查结果里选目标。`requested` 指定时必须在清单里且严格更新；
/// 未指定时选最新且严格新于当前的版本。没有 → `None`（已是最新）。
fn pick_target(
    check: &Value,
    current: &str,
    requested: Option<&str>,
) -> Result<Option<Target>, AivpnError> {
    let current_text = current.to_string();
    let current = semver::Version::parse(&current_text)
        .map_err(|_| AivpnError::new("INTERNAL", "当前运行库版本号不是 semver，无法比较"))?;
    let mut candidates: Vec<(semver::Version, Target)> = check
        .get("candidates")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    let version = item.get("version").and_then(Value::as_str)?;
                    let parsed = semver::Version::parse(version).ok()?;
                    Some((
                        parsed,
                        Target {
                            version: version.to_string(),
                            size: item.get("size").and_then(Value::as_u64).unwrap_or(0),
                            sha256: item
                                .get("sha256")
                                .and_then(Value::as_str)
                                .unwrap_or_default()
                                .to_string(),
                        },
                    ))
                })
                .collect()
        })
        .unwrap_or_default();
    candidates.sort_by(|left, right| right.0.cmp(&left.0));

    if let Some(requested) = requested {
        let known: Vec<&str> = check
            .get("known_versions")
            .and_then(Value::as_array)
            .map(|items| items.iter().filter_map(Value::as_str).collect())
            .unwrap_or_default();
        if !known.contains(&requested) {
            return Err(AivpnError::new(
                "NOT_FOUND",
                format!("官方清单里没有可用版本 {requested}，升级没有发起"),
            ));
        }
        let requested_version = semver::Version::parse(requested).map_err(|_| {
            AivpnError::new(
                "NOT_FOUND",
                format!("官方清单里没有可用版本 {requested}，升级没有发起"),
            )
        })?;
        // 清单里有但不比当前新：这是 not_newer，不是 NOT_FOUND。
        if requested_version <= current {
            return Err(not_newer(&current_text, requested));
        }
        let Some((_, target)) = candidates
            .into_iter()
            .find(|(_, target)| target.version == requested)
        else {
            return Err(AivpnError::new(
                "NOT_FOUND",
                format!("版本 {requested} 缺少可用的产物信息，升级没有发起"),
            ));
        };
        if target.sha256.is_empty() {
            return Err(AivpnError::new(
                "NOT_FOUND",
                format!("版本 {requested} 缺少产物哈希，升级没有发起"),
            ));
        }
        return Ok(Some(target));
    }

    let newest = candidates.into_iter().find(|(version, _)| *version > current);
    match newest {
        Some((_, target)) if !target.sha256.is_empty() => Ok(Some(target)),
        _ => Ok(None),
    }
}

fn not_newer(current: &str, requested: &str) -> AivpnError {
    AivpnError::new(
        "PRECONDITION_FAILED",
        format!("目标版本 {requested} 不高于当前 {current}，无需升级"),
    )
    .with_details(json!({
        "reason": "not_newer",
        "current_version": current,
        "target_version": requested,
    }))
}

fn upgrade_error(error: &anyhow::Error, current: &str) -> AivpnError {
    let (code, message, service_details) = match error.downcast_ref::<ServiceError>() {
        Some(service) => (
            service.code.clone(),
            service.message.clone(),
            service.details.clone(),
        ),
        None => (service_error_code(error), error.to_string(), None),
    };
    // 保留服务层的结构化字段（例如 BUSY 的 job_id、artifact_changed 的哈希），
    // 再补当前版本与「未改动」。
    let reason = service_details
        .as_ref()
        .and_then(|details| details.get("reason"))
        .and_then(Value::as_str)
        .map(str::to_string);
    let mut details = match service_details {
        Some(Value::Object(map)) => Value::Object(map),
        _ => json!({}),
    };
    details["current_version"] = json!(current);
    details["changed"] = json!(false);
    let message = if reason.as_deref() == Some("artifact_changed") {
        format!("更新内容已变化，需要重新确认。现在运行的是 {current}，本次没有改动任何文件。")
    } else {
        format!("升级失败：{message}。现在运行的是 {current}，本次没有改动任何文件。")
    };
    AivpnError::new(&code, message).with_details(details)
}

fn service_error_code(error: &anyhow::Error) -> String {
    if let Some(service) = error.downcast_ref::<ServiceError>() {
        return service.code.clone();
    }
    let text = error.to_string();
    match text.split_once(": ") {
        Some((code, _))
            if !code.is_empty()
                && code.chars().all(|ch| ch.is_ascii_uppercase() || ch == '_') =>
        {
            code.to_string()
        }
        _ => "INTERNAL".to_string(),
    }
}

fn format_size(bytes: u64) -> String {
    const MB: f64 = 1024.0 * 1024.0;
    if bytes as f64 >= MB {
        format!("{:.1} MB", bytes as f64 / MB)
    } else {
        format!("{:.0} KB", bytes as f64 / 1024.0)
    }
}

/// 一次请求最多一次：同一 `(session, request)` 的第二次调用直接 BUSY，
/// 失败也不在同一轮自动重试。键是唯一的 request_id，不会长期累积。
fn attempts() -> &'static Mutex<HashSet<(String, String)>> {
    static ATTEMPTS: OnceLock<Mutex<HashSet<(String, String)>>> = OnceLock::new();
    ATTEMPTS.get_or_init(|| Mutex::new(HashSet::new()))
}

fn begin_attempt(session_id: &str, request_id: &str) -> bool {
    let mut attempts = attempts()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if attempts.len() > 512 {
        attempts.clear();
    }
    attempts.insert((session_id.to_string(), request_id.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn url_hash_size_and_force_are_rejected() {
        for key in ["url", "sha256", "size", "force"] {
            let error = validate_input(&json!({ (key): "x" })).unwrap_err();
            assert_eq!(error.code, "INVALID_ARGUMENT", "{key}");
        }
        assert!(validate_input(&json!({ "version": "1.15.0" }))
            .unwrap()
            .is_some());
        assert_eq!(validate_input(&json!({})).unwrap(), None);
        assert_eq!(
            validate_input(&json!({ "version": "" })).unwrap_err().code,
            "INVALID_ARGUMENT"
        );
    }

    #[test]
    fn picks_the_newest_newer_candidate() {
        let check = json!({
            "network": "ok",
            "candidates": [
                { "version": "1.14.0", "size": 10, "sha256": "aa" },
                { "version": "1.16.0", "size": 30, "sha256": "cc" },
                { "version": "1.15.0", "size": 20, "sha256": "bb" }
            ]
        });
        let target = pick_target(&check, "1.14.4", None).unwrap().unwrap();
        assert_eq!(target.version, "1.16.0");
        assert_eq!(target.sha256, "cc");

        // 当前就是最新 → 不升级。
        assert!(pick_target(&check, "1.16.0", None).unwrap().is_none());
    }

    #[test]
    fn a_version_outside_the_manifest_is_not_found() {
        let check = json!({
            "network": "ok",
            "candidates": [{ "version": "1.16.0", "size": 30, "sha256": "cc" }],
            "known_versions": ["1.16.0", "1.13.0"]
        });
        assert_eq!(
            pick_target(&check, "1.14.4", Some("9.9.9"))
                .unwrap_err()
                .code,
            "NOT_FOUND"
        );
        // 清单里有、但不比当前新：必须是 not_newer，不是 NOT_FOUND。
        let equal = pick_target(&check, "1.16.0", Some("1.16.0")).unwrap_err();
        assert_eq!(equal.code, "PRECONDITION_FAILED");
        assert_eq!(equal.details.unwrap()["reason"], "not_newer");
        let older = pick_target(&check, "1.16.0", Some("1.13.0")).unwrap_err();
        assert_eq!(older.code, "PRECONDITION_FAILED");
        assert_eq!(older.details.unwrap()["reason"], "not_newer");

        // 显式指定更高版本：正常选中。
        let target = pick_target(&check, "1.14.4", Some("1.16.0"))
            .unwrap()
            .expect("1.16.0 应当可升级");
        assert_eq!(target.version, "1.16.0");
    }

    /// 只有逐字「升级」才算同意；取消/关闭/超时/其它答案都不算。
    #[test]
    fn only_the_exact_upgrade_answer_is_consent() {
        for answer in ["", "取消", "升级（推荐）", "ok"] {
            assert_ne!(answer, CONFIRM_OPTION);
        }
        assert_eq!(CONFIRM_OPTION, "升级");
        assert_eq!(CANCEL_OPTION, "取消");
    }

    #[test]
    fn a_failure_says_what_still_runs_and_that_nothing_changed() {
        let error = anyhow::Error::new(ServiceError {
            code: "HASH_MISMATCH".into(),
            message: "下载内容哈希不符".into(),
            retryable: false,
            details: None,
        });
        let mapped = upgrade_error(&error, "1.14.4");
        assert_eq!(mapped.code, "HASH_MISMATCH");
        assert!(mapped.message.contains("现在运行的是 1.14.4"), "{}", mapped.message);
        assert!(mapped.message.contains("没有改动任何文件"), "{}", mapped.message);
        assert_eq!(mapped.details.unwrap()["changed"], false);
    }

    #[test]
    fn one_attempt_per_request() {
        assert!(begin_attempt("ses_attempt", "req_attempt"));
        assert!(!begin_attempt("ses_attempt", "req_attempt"));
        assert!(begin_attempt("ses_attempt", "req_other"));
    }

    #[test]
    fn sizes_are_human_readable() {
        assert_eq!(format_size(0), "0 KB");
        assert_eq!(format_size(2 * 1024 * 1024), "2.0 MB");
    }

    #[test]
    fn effective_text_follows_restart_then_connection_state() {
        assert_eq!(effective_text(true, true), "重启 Veyl 后生效");
        assert_eq!(effective_text(true, false), "重启 Veyl 后生效");
        assert_eq!(effective_text(false, true), "断开并重新连接后生效");
        assert_eq!(effective_text(false, false), "下次连接时生效");
    }

    #[test]
    fn the_confirmation_card_carries_restart_required_and_nullable_size() {
        let target = Target {
            version: "1.15.0".into(),
            size: 0,
            sha256: "aa".into(),
        };
        let details = confirmation_details("1.14.4", &target, false);
        assert_eq!(details["current_version"], "1.14.4");
        assert_eq!(details["target_version"], "1.15.0");
        assert_eq!(details["size"], Value::Null, "缺失大小必须是 null");
        assert_eq!(details["source"], "official");
        assert_eq!(details["restart_required"], false);

        let target = Target {
            size: 1024,
            ..target
        };
        let details = confirmation_details("1.14.4", &target, true);
        assert_eq!(details["size"], 1024);
        assert_eq!(details["restart_required"], true);
    }
}
