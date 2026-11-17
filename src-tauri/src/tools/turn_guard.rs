//! 一轮一次的公共闸门（`tools.md` §4.50 / §4.52）。
//!
//! 键是 `(工具名, session_id, current_turn)`：同一个工具在同一会话同一轮最多成功一次，
//! 不同工具互不影响——`OpenSettings` 与 `StageSelect` 在同一轮都能各调一次。

use std::collections::HashSet;
use std::sync::atomic::Ordering;
use std::sync::{Mutex, OnceLock};

use claurst_tools::ToolContext;

fn claimed() -> &'static Mutex<HashSet<(String, String, usize)>> {
    static CLAIMED: OnceLock<Mutex<HashSet<(String, String, usize)>>> = OnceLock::new();
    CLAIMED.get_or_init(|| Mutex::new(HashSet::new()))
}

/// 尝试占用本轮名额。成功 `true`；同一工具同轮第二次 `false`。
///
/// **必须在所有校验通过之后调用**：校验失败不占名额，模型才能在同一轮用正确参数重试。
pub fn claim(tool: &str, ctx: &ToolContext) -> bool {
    let turn = ctx.current_turn.load(Ordering::Relaxed);
    let key = (tool.to_string(), ctx.session_id.clone(), turn);
    let mut set = claimed()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    // 只保留本会话当前这一轮的记录，避免集合无限增长。
    set.retain(|(_, session, seen)| session != &key.1 || *seen == turn);
    set.insert(key)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::permission_handler::AivpnPermissionHandler;
    use claurst_core::file_history::FileHistory;
    use claurst_core::{CostTracker, PermissionMode};
    use std::sync::atomic::AtomicUsize;
    use std::sync::Arc;

    fn context(session: &str, turn: usize) -> ToolContext {
        let dir = std::env::temp_dir();
        ToolContext {
            working_dir: dir.clone(),
            permission_mode: PermissionMode::BypassPermissions,
            permission_handler: Arc::new(AivpnPermissionHandler::new(dir)),
            cost_tracker: CostTracker::with_model("test"),
            session_id: session.to_string(),
            file_history: Arc::new(parking_lot::Mutex::new(FileHistory::new())),
            current_turn: Arc::new(AtomicUsize::new(turn)),
            non_interactive: true,
            mcp_manager: None,
            config: Default::default(),
            managed_agent_config: None,
            completion_notifier: None,
            pending_permissions: None,
            permission_manager: None,
            user_question_tx: None,
            cancel_token: tokio_util::sync::CancellationToken::new(),
            batch_rejection: Default::default(),
        }
    }

    #[test]
    fn the_same_tool_is_once_per_turn_but_different_tools_do_not_collide() {
        let ctx = context(&format!("turn-guard-{:016x}", rand::random::<u64>()), 3);
        assert!(claim("OpenSettings", &ctx));
        assert!(!claim("OpenSettings", &ctx));
        assert!(claim("StageSelect", &ctx), "不同工具不能互相顶掉");
        assert!(!claim("StageSelect", &ctx));

        let next = context(&ctx.session_id, 4);
        assert!(claim("OpenSettings", &next));
        assert!(claim("StageSelect", &next));
    }
}
