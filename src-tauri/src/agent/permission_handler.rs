//! AIVPN 的权限裁决。
//!
//! 只读工具直接放行；写/执行类一律 `Ask`，交给 Claurst 的待确认队列，
//! 由前端的内联确认卡采集决策。不在这里复制一套风险引擎。

use std::path::PathBuf;

use claurst_core::permissions::{PermissionDecision, PermissionHandler, PermissionRequest};

pub struct AivpnPermissionHandler {
    workspace_root: PathBuf,
}

impl AivpnPermissionHandler {
    pub fn new(workspace_root: PathBuf) -> Self {
        Self { workspace_root }
    }
}

impl PermissionHandler for AivpnPermissionHandler {
    fn check_permission(&self, request: &PermissionRequest) -> PermissionDecision {
        if request.is_read_only {
            return PermissionDecision::Allow;
        }

        PermissionDecision::Ask {
            reason: format!(
                "{} 需要改动本机状态（工作目录 {}）",
                request.tool_name,
                self.workspace_root.display()
            ),
        }
    }

    fn request_permission(&self, request: &PermissionRequest) -> PermissionDecision {
        self.check_permission(request)
    }
}
