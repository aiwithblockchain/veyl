//! Claurst 权限层的裁决。
//!
//! **审批已移除**（2026-11-02 用户拍板）：所有工具默认放行。
//! 这个 handler 仍然必须存在（`ToolContext` 要一个 `Arc<dyn PermissionHandler>`），
//! 但不再区分只读与写入，一律 `Allow`；真正的风险控制在各工具自己的参数校验与
//! 服务层前置检查里（例如「不能删活动配置」）。

use std::path::PathBuf;

use claurst_core::permissions::{PermissionDecision, PermissionHandler, PermissionRequest};

pub struct AivpnPermissionHandler;

impl AivpnPermissionHandler {
    pub fn new(_workspace_root: PathBuf) -> Self {
        Self
    }
}

impl PermissionHandler for AivpnPermissionHandler {
    fn check_permission(&self, _request: &PermissionRequest) -> PermissionDecision {
        PermissionDecision::Allow
    }

    fn request_permission(&self, request: &PermissionRequest) -> PermissionDecision {
        self.check_permission(request)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_decision_is_allow() {
        let handler = AivpnPermissionHandler::new(PathBuf::from("/tmp"));
        let request = PermissionRequest {
            tool_name: "VpnConnect".to_string(),
            description: "连接节点".to_string(),
            details: None,
            is_read_only: false,
            path: None,
            working_dir: None,
            allowed_roots: Vec::new(),
            context_description: None,
        };
        assert!(matches!(
            handler.check_permission(&request),
            PermissionDecision::Allow
        ));
        assert!(matches!(
            handler.request_permission(&request),
            PermissionDecision::Allow
        ));
    }
}
