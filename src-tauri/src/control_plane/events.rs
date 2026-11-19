//! 「我的服务器」事件：命令观察到状态变化时发给 UI（`events.md` 2.13.0）。
//!
//! 控制面没有反向推送通道；Host 在列表/详情/操作命令拿到新状态时比较本地镜像，
//! 只在**状态真的变了**时发事件，UI 的轮询是事件不可用时的兜底。

use serde_json::json;

use super::servers::{MyServer, MyServerOrder};
use crate::claurst_session::events::{
    now, CONTRACT_VERSION, EV_MY_SERVER_ACCOUNT_CLEARED, EV_MY_SERVER_CHANGED,
    EV_MY_SERVER_ORDER_CHANGED, EV_MY_SERVER_RENAMED,
};

pub fn emit_server_changed(server: &MyServer) {
    let payload = json!({
        "contract_version": CONTRACT_VERSION,
        "server_id": server.server_id,
        "state": server.state,
        "failure": server.failure,
        "node_id": server.node_id,
        "at": now(),
        "emitted_at": now(),
    });
    crate::agent::app_handle::emit(EV_MY_SERVER_CHANGED, payload);
}

pub fn emit_order_changed(order: &MyServerOrder) {
    let payload = json!({
        "contract_version": CONTRACT_VERSION,
        "order_id": order.order_id,
        "state": order.state,
        "failure": order.failure,
        "server_id": order.server_id,
        "at": now(),
        "emitted_at": now(),
    });
    crate::agent::app_handle::emit(EV_MY_SERVER_ORDER_CHANGED, payload);
}

/// 登出被服务端拒绝（设备被停用、账户被封、令牌失效）后本地已清理。
/// 只让界面立刻回到未登录态；payload 不含令牌、账户 id 或邮箱。
pub fn emit_account_cleared(reason: &str) {
    let payload = json!({
        "contract_version": CONTRACT_VERSION,
        "reason": reason,
        "emitted_at": now(),
    });
    crate::agent::app_handle::emit(EV_MY_SERVER_ACCOUNT_CLEARED, payload);
}

/// 服务器改名成功：只带服务器 id、新名字与本地节点 id，不带任何账号信息。
///
/// `local_node_id` 让连接页能就地改节点名：节点对象只有本地 id，没有 `server_id`，
/// 缺了它前端只能重拉整个配置。节点还没落地时为 `null`（契约 `string | null`）。
pub fn emit_server_renamed(server: &MyServer) {
    crate::agent::app_handle::emit(EV_MY_SERVER_RENAMED, server_renamed_payload(server));
}

fn server_renamed_payload(server: &MyServer) -> serde_json::Value {
    json!({
        "contract_version": CONTRACT_VERSION,
        "server_id": server.server_id,
        "name": server.name,
        "local_node_id": server.local_node_id,
        "emitted_at": now(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn server(local_node_id: Option<&str>) -> MyServer {
        let mut value = json!({
            "server_id": "srv_1",
            "name": "新加坡-0.3u",
            "region": "sgp",
            "plan": "s-1vcpu-1gb",
            "state": "active",
            "created_at": "2026-11-19T07:11:44Z",
            "hourly_usd": 0.0,
            "monthly_usd": 6.0,
            "daily_price_cents": 20,
            "transfer_gib": 0,
            "billing_state": "active",
            "node_id": "nd_abc"
        });
        if let Some(id) = local_node_id {
            value["local_node_id"] = json!(id);
        }
        serde_json::from_value(value).unwrap()
    }

    /// 改名事件带上本地节点 id：前端据此就地改节点名，不用重拉配置。
    #[test]
    fn the_rename_event_carries_the_local_node_id() {
        let payload = server_renamed_payload(&server(Some("nd_local")));
        assert_eq!(payload["server_id"], json!("srv_1"));
        assert_eq!(payload["name"], json!("新加坡-0.3u"));
        assert_eq!(payload["local_node_id"], json!("nd_local"));
    }

    /// 节点还没落地（没取过凭据）时为 null，不能拿控制面 id 顶替。
    #[test]
    fn an_unlinked_server_reports_a_null_local_node_id() {
        let payload = server_renamed_payload(&server(None));
        assert!(payload["local_node_id"].is_null(), "{payload}");
        assert_eq!(payload["server_id"], json!("srv_1"));
    }
}
