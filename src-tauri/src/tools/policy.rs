//! 工具元数据：权限级别展示 + 当前请求关联。
//!
//! **审批已移除**（2026-11-02 用户拍板）：所有工具默认放行，Host 不再拦截、
//! 不再生成 `approval_id`、也不再维护 Grant / 待确认队列。
//! 审计仍然保留：`tool_calls.approved` 恒为 NULL（语义是「不适用」）。

use std::collections::HashMap;
use std::sync::OnceLock;

use claurst_tools::PermissionLevel;
use parking_lot::Mutex;

pub fn permission_level_str(level: PermissionLevel) -> &'static str {
    match level {
        PermissionLevel::None => "none",
        PermissionLevel::ReadOnly => "read_only",
        PermissionLevel::Write => "write",
        PermissionLevel::Execute => "execute",
        PermissionLevel::Dangerous | PermissionLevel::Forbidden => "execute",
    }
}

/// session_id → 当前 request_id，供工具审计把调用记到对应请求上。
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

pub fn current_request_id(session_id: &str) -> Option<String> {
    current_requests().lock().get(session_id).cloned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn permission_levels_map_to_contract_strings() {
        assert_eq!(permission_level_str(PermissionLevel::ReadOnly), "read_only");
        assert_eq!(permission_level_str(PermissionLevel::Write), "write");
        assert_eq!(permission_level_str(PermissionLevel::Execute), "execute");
        assert_eq!(permission_level_str(PermissionLevel::Dangerous), "execute");
    }

    #[test]
    fn request_registry_round_trips() {
        set_current_request("ses_req", "req_1");
        assert_eq!(current_request_id("ses_req").as_deref(), Some("req_1"));
        clear_current_request("ses_req");
        assert!(current_request_id("ses_req").is_none());
    }
}
