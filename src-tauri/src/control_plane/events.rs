//! 「我的服务器」事件：命令观察到状态变化时发给 UI（`events.md` 2.13.0）。
//!
//! 控制面没有反向推送通道；Host 在列表/详情/操作命令拿到新状态时比较本地镜像，
//! 只在**状态真的变了**时发事件，UI 的轮询是事件不可用时的兜底。

use serde_json::json;

use super::servers::{MyServer, MyServerOrder};
use crate::claurst_session::events::{
    now, CONTRACT_VERSION, EV_MY_SERVER_CHANGED, EV_MY_SERVER_ORDER_CHANGED,
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
