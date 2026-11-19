//! 「我的服务器」后台轮询：控制面没有反向推送通道。
//!
//! 余额不足停机销毁由控制面在每小时 Cron 里做，客户端只能靠自己发现：
//! 这里每 60 秒拉一次列表（**只在活动配置里还有 owned 节点时**），
//! 先把「刚变成 destroyed、且正被当前连接使用」的隧道停掉，再落库发事件。

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use crate::control_plane::servers::MyServer;

use super::AppState;

const POLL_INTERVAL: Duration = Duration::from_secs(60);

pub fn spawn(state: Arc<AppState>) {
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(POLL_INTERVAL).await;
            if let Err(error) = poll_once(&state).await {
                // 网络失败下一轮再试；不打 warn，免得断网时每分钟刷屏。
                log::debug!("我的服务器后台刷新失败：{error}");
            }
        }
    });
}

async fn poll_once(state: &Arc<AppState>) -> Result<(), String> {
    if !active_config_has_owned_node() {
        return Ok(());
    }
    let mut servers = crate::control_plane::servers::fetch_all()
        .await
        .map_err(|error| error.message.clone())?;

    // 必须先停运行时、再落库发事件：事件到达界面时隧道不能还在跑。
    let previous = previous_mirror(&servers);
    let current = current_node_id();
    if runtime_is_live(state).await
        && pause_needed(&servers, &previous, current.as_deref())
    {
        if let Err(error) = state.services.runtime_stop(false).await {
            log::warn!("停机销毁后停止运行时失败：{error}");
        }
    }

    crate::control_plane::servers::cache_all(&mut servers);
    Ok(())
}

/// 活动配置里有没有 owned 节点；没有就不需要轮询（种子 / 自建节点不走控制面计费）。
fn active_config_has_owned_node() -> bool {
    let Some(store) = crate::store::global() else {
        return false;
    };
    let conn = store.conn();
    let Ok(Some(config)) = crate::store::configs::active(&conn) else {
        return false;
    };
    crate::store::configs::list_nodes(&conn, &config.id)
        .map(|nodes| {
            nodes
                .iter()
                .any(|node| node.source == crate::store::configs::SOURCE_OWNED)
        })
        .unwrap_or(false)
}

/// 上次看到的镜像状态 + 关联的本地节点 id（判「刚变成 destroyed」用）。
struct Previous {
    state: Option<String>,
    node_id: Option<String>,
}

/// 这次快照涉及的服务器在本地镜像里的上一版。
///
/// 镜像行可能还不存在（首次轮询、刚重启）：此时按本机的 owned 节点兜底，
/// 否则「刚启动就连着节点、控制面此时销毁」会漏掉停运行时这一步。
fn previous_mirror(servers: &[MyServer]) -> HashMap<String, Previous> {
    let Some(store) = crate::store::global() else {
        return HashMap::new();
    };
    let conn = store.conn();
    servers
        .iter()
        .map(|server| {
            let row = crate::store::servers::get(&conn, &server.server_id)
                .ok()
                .flatten();
            let node_id = row
                .as_ref()
                .and_then(|row| row.node_id.clone())
                .or_else(|| {
                    crate::store::configs::find_node_by_source_key(
                        &conn,
                        crate::store::configs::SOURCE_OWNED,
                        &server.server_id,
                    )
                    .ok()
                    .flatten()
                    .map(|node| node.id)
                });
            (
                server.server_id.clone(),
                Previous {
                    state: row.map(|row| row.state),
                    node_id,
                },
            )
        })
        .collect()
}

fn current_node_id() -> Option<String> {
    let store = crate::store::global()?;
    let conn = store.conn();
    crate::store::configs::active(&conn)
        .ok()
        .flatten()
        .and_then(|config| config.current_node_id)
}

/// `starting` / `restarting` 也算在跑：`runtime_stop` 在启动窗口里会 bump epoch
/// 取代在途启动（`tools/services.rs`），不把这两个算进来，销毁或删节点就会漏掉
/// 「隧道马上要起来、`current_node_id` 却已是 NULL」的原症状。
fn state_is_live(state: &str) -> bool {
    matches!(state, "running" | "degraded" | "starting" | "restarting")
}

pub(crate) async fn runtime_is_live(state: &AppState) -> bool {
    let Ok(value) = state.services.runtime_status().await else {
        return false;
    };
    value
        .get("state")
        .and_then(|value| value.as_str())
        .is_some_and(state_is_live)
}

/// 有没有「刚变成 destroyed、且本地节点正是当前连接节点」的服务器。
fn pause_needed(
    servers: &[MyServer],
    previous: &HashMap<String, Previous>,
    current_node: Option<&str>,
) -> bool {
    let Some(current) = current_node else {
        return false;
    };
    servers.iter().any(|server| {
        server.state == "destroyed"
            && previous.get(&server.server_id).is_some_and(|prev| {
                prev.state.as_deref() != Some("destroyed")
                    && prev.node_id.as_deref() == Some(current)
            })
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn server(id: &str, state: &str) -> MyServer {
        serde_json::from_value(json!({
            "server_id": id,
            "name": "东京",
            "region": "sgp1",
            "plan": "s-1vcpu-1gb",
            "state": state,
            "created_at": "2026-11-19T08:00:00Z",
            "hourly_usd": 0.0,
            "monthly_usd": 6.0,
            "daily_price_cents": 20,
            "transfer_gib": 0,
            "billing_state": "active",
        }))
        .unwrap()
    }

    fn prev(state: Option<&str>, node_id: Option<&str>) -> Previous {
        Previous {
            state: state.map(str::to_string),
            node_id: node_id.map(str::to_string),
        }
    }

    /// 刚变成 destroyed、且当前连接正用它的节点 → 先停运行时。
    #[test]
    fn a_newly_destroyed_server_using_the_current_node_needs_a_stop() {
        let previous =
            HashMap::from([("srv_1".to_string(), prev(Some("active"), Some("nd_1")))]);
        assert!(pause_needed(
            &[server("srv_1", "destroyed")],
            &previous,
            Some("nd_1")
        ));
    }

    /// 首次轮询 / 刚重启：镜像行缺失但按 owned 节点兜底到了节点 id，同样要停。
    #[test]
    fn a_missing_mirror_row_still_matches_through_the_owned_node() {
        let previous = HashMap::from([("srv_1".to_string(), prev(None, Some("nd_1")))]);
        assert!(pause_needed(
            &[server("srv_1", "destroyed")],
            &previous,
            Some("nd_1")
        ));
    }

    /// 已经停过一次（镜像里已是 destroyed）不再重复停。
    #[test]
    fn an_already_seen_destroyed_server_does_not_need_another_stop() {
        let previous = HashMap::from([(
            "srv_1".to_string(),
            prev(Some("destroyed"), Some("nd_1")),
        )]);
        assert!(!pause_needed(
            &[server("srv_1", "destroyed")],
            &previous,
            Some("nd_1")
        ));
    }

    /// 当前连接用的是别的节点、或者根本没连：不动隧道。
    #[test]
    fn a_destroyed_server_that_is_not_the_current_node_leaves_the_tunnel_alone() {
        let previous =
            HashMap::from([("srv_1".to_string(), prev(Some("active"), Some("nd_1")))]);
        assert!(!pause_needed(
            &[server("srv_1", "destroyed")],
            &previous,
            Some("nd_2")
        ));
        assert!(!pause_needed(
            &[server("srv_1", "destroyed")],
            &previous,
            None
        ));
    }

    /// 还有没 destroyed 的服务器时不误触发。
    #[test]
    fn a_running_server_never_pauses_the_tunnel() {
        let previous =
            HashMap::from([("srv_1".to_string(), prev(Some("active"), Some("nd_1")))]);
        assert!(!pause_needed(
            &[server("srv_1", "active")],
            &previous,
            Some("nd_1")
        ));
    }

    /// 启动窗口里销毁/删节点也必须停：`starting` / `restarting` 算在跑。
    #[test]
    fn starting_and_restarting_count_as_live() {
        for state in ["running", "degraded", "starting", "restarting"] {
            assert!(state_is_live(state), "{state} 应该算在跑");
        }
        for state in ["stopping", "failed", "idle"] {
            assert!(!state_is_live(state), "{state} 不该算在跑");
        }
        assert!(!state_is_live(""), "未知状态不该算在跑");
    }
}
