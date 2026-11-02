//! 审批策略与授权表（`docs/contracts/tools.md` §2.2 / §2.3）。
//!
//! 判定顺序：
//! 1. 只读工具由 Claurst 权限层直接放行；
//! 2. `never` → 放行；
//! 3. `always` → 每次都要确认；
//! 4. `first_time_per_session` → 本会话已有 Grant 则放行，否则确认一次。
//!
//! Grant 只存内存，应用重启即清空；`approval_id` 绑定参数哈希，只管一次执行。

use std::collections::hash_map::DefaultHasher;
use std::collections::{HashMap, HashSet};
use std::hash::{Hash, Hasher};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use claurst_tools::{PermissionLevel, ToolContext, ToolResult};
use parking_lot::Mutex;
use serde_json::{json, Value};

use super::envelope::{self, AivpnError, ToolOutcome};

pub const APPROVAL_TTL: Duration = Duration::from_secs(300);

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum ApprovalPolicy {
    Never,
    Always,
    FirstTimePerSession,
}

impl ApprovalPolicy {
    pub fn as_str(self) -> &'static str {
        match self {
            ApprovalPolicy::Never => "never",
            ApprovalPolicy::Always => "always",
            ApprovalPolicy::FirstTimePerSession => "first_time_per_session",
        }
    }
}

/// 模型可见名 → 审批策略（`tools.md` §3 总表）。
pub fn policy_for(tool: &str) -> ApprovalPolicy {
    match tool {
        "CoreInstall" | "ProfileDelete" => ApprovalPolicy::Always,
        "VpnConnect" => ApprovalPolicy::FirstTimePerSession,
        _ => ApprovalPolicy::Never,
    }
}

pub fn permission_level_str(level: PermissionLevel) -> &'static str {
    match level {
        PermissionLevel::None => "none",
        PermissionLevel::ReadOnly => "read_only",
        PermissionLevel::Write => "write",
        PermissionLevel::Execute => "execute",
        PermissionLevel::Dangerous | PermissionLevel::Forbidden => "execute",
    }
}

struct Pending {
    tool: String,
    session_id: String,
    args_hash: u64,
    created_at: Instant,
}

#[derive(Default)]
struct Gate {
    grants: HashSet<(String, String)>,
    denied: HashSet<(String, String)>,
    /// 已弹卡、等用户点按钮。
    pending: HashMap<String, Pending>,
    /// 用户已允许、等 Agent 带 approval_id 重试。
    approved: HashMap<String, Pending>,
}

fn gate() -> &'static Mutex<Gate> {
    static GATE: OnceLock<Mutex<Gate>> = OnceLock::new();
    GATE.get_or_init(|| Mutex::new(Gate::default()))
}

/// session_id → 当前 request_id。审批事件需要带上它，而工具拿不到。
fn current_requests() -> &'static Mutex<HashMap<String, String>> {
    static CURRENT: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
    CURRENT.get_or_init(|| Mutex::new(HashMap::new()))
}

pub fn set_current_request(session_id: &str, request_id: &str) {
    current_requests()
        .lock()
        .insert(session_id.to_string(), request_id.to_string());
}

pub fn clear_current_request(session_id: &str) {
    current_requests().lock().remove(session_id);
}

fn current_request(session_id: &str) -> Option<String> {
    current_requests().lock().get(session_id).cloned()
}

fn args_hash(input: &Value) -> u64 {
    let mut hasher = DefaultHasher::new();
    let mut keys: Vec<&String> = input
        .as_object()
        .map(|object| object.keys().filter(|key| *key != "approval_id").collect())
        .unwrap_or_default();
    keys.sort();
    for key in keys {
        key.hash(&mut hasher);
        input[key].to_string().hash(&mut hasher);
    }
    hasher.finish()
}

fn new_approval_id(tool: &str) -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_nanos())
        .unwrap_or(0);
    format!("apr_{tool}_{nanos:x}")
}

/// 工具入口处调用：需要确认时返回可直接返回给模型的 `ToolResult`，并已发出
/// `approval-requested` 事件；不需要确认时返回 None，调用方继续执行。
pub fn guard(
    ctx: &ToolContext,
    tool: &str,
    input: &Value,
    summary: &str,
    risk: &str,
) -> Option<ToolResult> {
    let policy = policy_for(tool);
    let session_id = ctx.session_id.clone();

    match policy {
        ApprovalPolicy::Never => return None,
        ApprovalPolicy::Always => {}
        ApprovalPolicy::FirstTimePerSession => {
            if gate().lock().grants.contains(&(session_id.clone(), tool.to_string())) {
                return None;
            }
        }
    }

    if gate()
        .lock()
        .denied
        .contains(&(session_id.clone(), tool.to_string()))
    {
        return Some(envelope::finish(
            ctx,
            tool,
            ToolOutcome::fail(AivpnError::new(
                "PERMISSION_DENIED",
                format!("用户本会话已拒绝 {tool}，不再重复询问"),
            )),
        ));
    }

    // 带 approval_id 的重试：校验参数哈希一致后放行。
    if let Some(approval_id) = input.get("approval_id").and_then(Value::as_str) {
        let mut gate_state = gate().lock();
        let matched = gate_state
            .approved
            .remove(approval_id)
            .filter(|pending| {
                pending.tool == tool
                    && pending.args_hash == args_hash(input)
                    && pending.created_at.elapsed() < APPROVAL_TTL
            })
            .is_some();

        if matched {
            if policy == ApprovalPolicy::FirstTimePerSession {
                gate_state
                    .grants
                    .insert((session_id.clone(), tool.to_string()));
            }
            return None;
        }
    }

    let approval_id = new_approval_id(tool);
    let scope = if policy == ApprovalPolicy::FirstTimePerSession {
        "session"
    } else {
        "call"
    };
    let expires_at = chrono::Utc::now() + chrono::Duration::from_std(APPROVAL_TTL).unwrap();

    gate().lock().pending.insert(
        approval_id.clone(),
        Pending {
            tool: tool.to_string(),
            session_id: ctx.session_id.clone(),
            args_hash: args_hash(input),
            created_at: Instant::now(),
        },
    );

    let risk = risk.to_string();
    let summary_owned = summary.to_string();
    let request_id = current_request(&ctx.session_id);
    let payload = json!({
        "contract_version": envelope::CONTRACT_VERSION,
        "approval_id": approval_id.clone(),
        "request_id": request_id,
        "session_id": session_id,
        "tool": tool,
        "summary": summary_owned,
        "risk": risk,
        "scope": scope,
        "expires_at": expires_at.to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
        "emitted_at": chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
    });
    crate::agent::app_handle::emit(crate::claurst_session::events::EV_APPROVAL_REQUESTED, payload);

    let mut error = AivpnError::new(
        "APPROVAL_REQUIRED",
        format!("{summary} 需要用户确认后才能执行"),
    );
    error.details = Some(json!({
        "approval_id": approval_id,
        "tool": tool,
        "summary": summary,
        "risk": risk,
        "scope": scope,
        "session_id": ctx.session_id,
        "expires_at": expires_at.to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
    }));

    let mut outcome = ToolOutcome::fail(error);
    outcome.next_actions.push(super::envelope::NextAction {
        label: "允许后重试".to_string(),
        tool: tool.to_string(),
        args: json!({}),
    });
    Some(envelope::finish(ctx, tool, outcome))
}

/// UI 的审批结果。返回 false 表示这个 approval_id 已失效。
pub fn resolve(approval_id: &str, decision: &str, scope: &str) -> bool {
    let mut gate_state = gate().lock();
    let Some(pending) = gate_state.pending.remove(approval_id) else {
        return false;
    };

    if decision == "deny" {
        gate_state
            .denied
            .insert((pending.session_id, pending.tool));
        return true;
    }

    if scope == "session" {
        gate_state
            .grants
            .insert((pending.session_id.clone(), pending.tool.clone()));
    }
    gate_state.approved.insert(approval_id.to_string(), pending);
    true
}

/// 会话结束时清空该会话的授权与否定缓存（契约 §2.2 铁律）。
pub fn clear_session(session_id: &str) {
    let mut gate_state = gate().lock();
    gate_state.grants.retain(|(sid, _)| sid != session_id);
    gate_state.denied.retain(|(sid, _)| sid != session_id);
    gate_state.pending.retain(|_, p| p.session_id != session_id);
    gate_state.approved.retain(|_, p| p.session_id != session_id);
}
