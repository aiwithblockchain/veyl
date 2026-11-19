//! 「我的服务器」还活着吗：只在用户 / AI 主动操作时顺手查一次，**不做后台定时轮询**。
//!
//! 余额不足停机销毁由控制面在每小时 Cron 里做，控制面没有反向推送通道。与其让常开
//! 应用每分钟打一次控制面，不如在「用户正在用这台服务器」的动作里顺便确认一次：
//! 拉详情、探测连通失败时。发现已经是 `destroyed` 就先停隧道（远端机器没了，本地
//! sing-box 不会自己断）。

use std::future::Future;
use std::sync::Arc;

use crate::control_plane::error::CpError;
use crate::control_plane::servers::MyServer;
use crate::tools::services::VpnToolServices;

use super::AppState;

/// 这个节点对应的自建服务器 id（`source_key` 就是服务器 id）。
///
/// 先按节点行判，不看 `my_servers` 镜像：镜像行可能还没建（首次连接）或已被清掉，
/// 而节点行一定在，`source_key` 足以找到服务器。
fn owned_server_of_node_in(conn: &rusqlite::Connection, node_id: &str) -> Option<String> {
    let node = crate::store::configs::get_node(conn, node_id)
        .ok()
        .flatten()?;
    (node.source == crate::store::configs::SOURCE_OWNED && !node.source_key.is_empty())
        .then_some(node.source_key)
}

pub(crate) fn owned_server_of_node(node_id: &str) -> Option<String> {
    let store = crate::store::global()?;
    let conn = store.conn();
    owned_server_of_node_in(&conn, node_id)
}

/// 当前正在用的自建服务器（种子 / 手动节点返回 `None`）。
fn current_owned_server_in(conn: &rusqlite::Connection) -> Option<String> {
    let current = crate::store::configs::active(conn)
        .ok()
        .flatten()?
        .current_node_id?;
    owned_server_of_node_in(conn, &current)
}

fn current_owned_server() -> Option<String> {
    let store = crate::store::global()?;
    let conn = store.conn();
    current_owned_server_in(&conn)
}

/// 这台服务器是不是当前节点对应的自建服务器（销毁前决定要不要先停隧道）。
pub(crate) fn is_current_server(server_id: &str) -> bool {
    crate::store::global()
        .and_then(|store| crate::control_plane::servers::active_node_of_server(store, server_id))
        .is_some()
}

/// `my_server_list` 成功后的一次收敛：列表里缺失的 owned 节点逐个确认一次。
///
/// 只有「销毁请求超时/断网、控制面其实已经删了」才会出现这种节点：镜像行被列表
/// 对齐清掉，节点却还留在连接页，用户没有任何入口能删。正常情况下没有这类节点，
/// 零额外请求；这里也不做定时轮询。
pub(crate) async fn reconcile_orphan_owned_nodes(
    services: Arc<dyn VpnToolServices>,
    listed: &[MyServer],
) {
    let Some(store) = crate::store::global() else {
        return;
    };
    let orphans = {
        let conn = store.conn();
        let ids: Vec<String> = listed.iter().map(|server| server.server_id.clone()).collect();
        crate::control_plane::servers::orphan_owned_nodes(&conn, &ids)
    };
    if orphans.is_empty() {
        return;
    }
    let stop_services = Arc::clone(&services);
    let recheck_services = Arc::clone(&services);
    reconcile_orphans_with(
        orphans,
        |server_id: String| async move { crate::control_plane::servers::get(&server_id).await },
        move |server_id: &str| {
            // 确认「服务器确实没了」之后、删节点之前重读：这 1–2 秒里用户可能切走
            // 或刚连上这个残留节点。
            let services = Arc::clone(&recheck_services);
            let server_id = server_id.to_string();
            async move {
                let live = runtime_state_of(services.as_ref())
                    .await
                    .as_deref()
                    .is_some_and(state_is_live);
                (is_current_server(&server_id), live)
            }
        },
        move || {
            let services = Arc::clone(&stop_services);
            async move {
                if let Err(error) = services.runtime_stop(false).await {
                    log::warn!("服务器已销毁，停止运行时失败：{error}");
                }
            }
        },
        |orphan| {
            if !crate::control_plane::servers::forget_gone_owned_node(store, orphan) {
                log::warn!("清理残留节点失败 node={}", orphan.node_id);
            }
        },
    )
    .await;
}

/// 收敛主体：`fetch` / `recheck` / `stop` / `remove` 由调用方注入，测试不碰网络、
/// 运行时与库。`recheck` 在确认服务器没了**之后**才调用，返回
/// `(是否仍是当前节点, 运行时是否在跑)`。
async fn reconcile_orphans_with<F, Fut, C, CFut, S, SF, R>(
    orphans: Vec<crate::control_plane::servers::OrphanOwnedNode>,
    fetch: F,
    recheck: C,
    stop: S,
    remove: R,
) -> usize
where
    F: Fn(String) -> Fut,
    Fut: Future<Output = Result<MyServer, CpError>>,
    C: Fn(&str) -> CFut,
    CFut: Future<Output = (bool, bool)>,
    S: Fn() -> SF,
    SF: Future<Output = ()>,
    R: Fn(&crate::control_plane::servers::OrphanOwnedNode),
{
    let mut removed = 0;
    for orphan in &orphans {
        let result = fetch(orphan.server_id.clone()).await;
        // 还活着 / 网络失败：保留——不是「机器没了」。
        if !crate::control_plane::servers::server_is_gone(&result) {
            continue;
        }
        let (is_current, runtime_live) = recheck(&orphan.server_id).await;
        if is_current && runtime_live {
            stop().await;
        }
        remove(orphan);
        removed += 1;
    }
    removed
}

/// `starting` / `restarting` 也算在跑：`runtime_stop` 在启动窗口里会 bump epoch
/// 取代在途启动（`tools/services.rs`），不把这两个算进来，销毁或删节点就会漏掉
/// 「隧道马上要起来、`current_node_id` 却已是 NULL」的原症状。
fn state_is_live(state: &str) -> bool {
    matches!(state, "running" | "degraded" | "starting" | "restarting")
}

pub(crate) async fn runtime_is_live(state: &AppState) -> bool {
    runtime_state_of(state.services.as_ref())
        .await
        .as_deref()
        .is_some_and(state_is_live)
}

/// 只依赖服务层：AI 工具路径（`tools/configs.rs`）没有 `AppState`，用的是同一个判据。
async fn runtime_state_of(services: &dyn crate::tools::services::VpnToolServices) -> Option<String> {
    let value = services.runtime_status().await.ok()?;
    value
        .get("state")
        .and_then(|value| value.as_str())
        .map(str::to_string)
}

/// 该不该停隧道：运行时在跑，控制的正是这台服务器，而控制面说它已经销毁。
fn should_stop(
    runtime_state: Option<&str>,
    is_current_owned_server: bool,
    server_state: &str,
) -> bool {
    is_current_owned_server
        && server_state == "destroyed"
        && runtime_state.is_some_and(state_is_live)
}

/// 用户 / AI 主动操作时顺手检查：`server_id` 正是当前连接的自建服务器才查。
///
/// 只查不重试：网络失败按「什么都没发现」处理，不报错、不改任何状态。
///
/// **顺序**：详情先落库并（状态变化时）发出既有 `my-server-changed`，随后才停运行时。
/// 事件比 `runtime_stop` 早几毫秒到界面，用户不可能在这几毫秒里操作，所以不为它
/// 在 `servers.rs` 另开一条不落库的取数路径。
///
/// **超时只包「取详情 + 重读」**：`runtime_stop` 不是取消安全的——`manager.stop()`
/// 拿到锁后先把状态置 `Stopping` 并取走 child，再 `terminate` 最多等 5 秒；被超时
/// 砍掉会把运行时永远卡在 `stopping`。所以确定为已销毁后把停运行时丢到后台任务，
/// 既不进超时，也不让详情 / 探测请求等它。
pub(crate) async fn ensure_current_server_alive(
    services: Arc<dyn VpnToolServices>,
    server_id: &str,
) {
    const CHECK_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);

    // 联网前先做便宜判断，避免无关的详情调用也打控制面。
    if current_owned_server().as_deref() != Some(server_id) {
        return;
    }
    if !runtime_state_of(services.as_ref())
        .await
        .as_deref()
        .is_some_and(state_is_live)
    {
        return;
    }

    let fetch = |server_id: String| async move {
        crate::control_plane::servers::get(&server_id).await
    };
    // 网络往返之后再读一次：这 1–2 秒里用户可能切了节点或断开重连，
    // 不能拿请求前的快照把新建的连接停掉。
    let recheck = {
        let services = Arc::clone(&services);
        move || {
            let services = Arc::clone(&services);
            async move {
                let runtime = runtime_state_of(services.as_ref()).await;
                let still_current = current_owned_server().as_deref() == Some(server_id);
                (runtime, still_current)
            }
        }
    };

    let stop_needed =
        match tokio::time::timeout(CHECK_TIMEOUT, decide_stop(server_id, fetch, recheck)).await {
            Ok(stop_needed) => stop_needed,
            Err(_) => {
                log::debug!("顺手检查服务器状态超时 server={server_id}");
                return;
            }
        };
    if !stop_needed {
        return;
    }
    // 丢到后台：调用方（详情 / 探测）不必等运行时停完才返回，也天然不受取消影响。
    log::info!("服务器已停机销毁，正在停止运行时 server={server_id}");
    let server_id = server_id.to_string();
    let services = Arc::clone(&services);
    tauri::async_runtime::spawn(async move {
        if let Err(error) = services.runtime_stop(false).await {
            log::warn!("服务器已停机销毁，停止运行时失败 server={server_id}：{error}");
        }
    });
}

/// 这一轮要不要停隧道：取详情 + 往返后重读，**不含 `runtime_stop`**。
///
/// `recheck` 返回 `(运行时状态, 是否仍是当前节点)`，**必须在 `fetch` 之后取值**。
async fn decide_stop<F, Fut, C, CFut>(server_id: &str, fetch: F, recheck: C) -> bool
where
    F: Fn(String) -> Fut,
    Fut: Future<Output = Result<MyServer, CpError>>,
    C: Fn() -> CFut,
    CFut: Future<Output = (Option<String>, bool)>,
{
    let server_state = match fetch(server_id.to_string()).await {
        Ok(server) => server.state,
        // 控制面明确说没有这台：比网络失败更该停，按 `destroyed` 处理。
        Err(error) if error.code == "NOT_FOUND" => "destroyed".to_string(),
        Err(error) => {
            // 网络失败不等于服务器没了：什么都不做，下一动作再说。
            log::debug!("顺手检查服务器状态失败 server={server_id}：{}", error.message);
            return false;
        }
    };
    let (runtime, is_current) = recheck().await;
    should_stop(runtime.as_deref(), is_current, &server_state)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::atomic::{AtomicBool, Ordering};

    fn server(state: &str) -> MyServer {
        serde_json::from_value(json!({
            "server_id": "srv_1",
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

    /// 运行时没在跑：不停。
    #[test]
    fn an_idle_runtime_does_not_stop() {
        assert!(!should_stop(Some("idle"), true, "destroyed"));
        assert!(!should_stop(None, true, "destroyed"));
    }

    /// 连的不是自建服务器节点（或不是当前节点）：不停。
    #[test]
    fn a_node_that_is_not_the_current_owned_server_does_not_stop() {
        assert!(!should_stop(Some("running"), false, "destroyed"));
    }

    /// 运行时在跑、服务器已被停机销毁、正是当前节点：要停。
    #[test]
    fn a_destroyed_server_on_the_current_node_stops_the_tunnel() {
        assert!(should_stop(Some("running"), true, "destroyed"));
        assert!(should_stop(Some("starting"), true, "destroyed"));
    }

    /// 服务器还活着：不动隧道。
    #[test]
    fn a_live_server_does_not_stop() {
        for state in ["active", "healthy", "destroying", "booting"] {
            assert!(!should_stop(Some("running"), true, state), "{state} 不该停");
        }
    }

    /// 拉详情的网络失败：当作什么都没发现，不报错、不停。
    #[tokio::test]
    async fn a_network_failure_finds_nothing() {
        let stop = decide_stop(
            "srv_1",
            |_server_id: String| async {
                Err(CpError::new(
                    "UPSTREAM_ERROR",
                    "断网",
                    true,
                    json!({ "reason": "provider_unavailable" }),
                ))
            },
            || async { (Some("running".to_string()), true) },
        )
        .await;
        assert!(!stop);
    }

    /// 控制面明确说没有这台（404）：按已销毁处理，要停。
    #[tokio::test]
    async fn a_not_found_server_counts_as_destroyed() {
        let stop = decide_stop(
            "srv_1",
            |_server_id: String| async {
                Err(CpError::new("NOT_FOUND", "找不到这台服务器", false, json!({})))
            },
            || async { (Some("running".to_string()), true) },
        )
        .await;
        assert!(stop);
    }

    /// 控制面说已销毁、仍是当前节点：要停。
    #[tokio::test]
    async fn a_destroyed_server_stops_the_tunnel_once() {
        let stop = decide_stop(
            "srv_1",
            |_server_id: String| async { Ok(server("destroyed")) },
            || async { (Some("running".to_string()), true) },
        )
        .await;
        assert!(stop);
    }

    /// 往返期间用户切走了节点：重读必须发生在请求之后，否则会停掉新连接。
    /// 把重读挪回请求前，这条测试就会失败（`switched` 此时还是 false）。
    #[tokio::test]
    async fn a_switch_during_the_round_trip_leaves_the_tunnel_alone() {
        let switched = Arc::new(AtomicBool::new(false));

        let switched_in = Arc::clone(&switched);
        let recheck_switched = Arc::clone(&switched);
        let stop = decide_stop(
            "srv_1",
            move |_server_id: String| {
                let switched = Arc::clone(&switched_in);
                async move {
                    // 往返期间：用户切到了别的节点。
                    switched.store(true, Ordering::SeqCst);
                    Ok(server("destroyed"))
                }
            },
            move || {
                let switched = Arc::clone(&recheck_switched);
                async move {
                    let still_current = !switched.load(Ordering::SeqCst);
                    (Some("running".to_string()), still_current)
                }
            },
        )
        .await;
        assert!(!stop);
    }

    /// 往返期间用户断开了：同样不能拿请求前的快照继续停。
    #[tokio::test]
    async fn a_disconnect_during_the_round_trip_leaves_the_tunnel_alone() {
        let disconnected = Arc::new(AtomicBool::new(false));

        let disconnected_in = Arc::clone(&disconnected);
        let recheck_disconnected = Arc::clone(&disconnected);
        let stop = decide_stop(
            "srv_1",
            move |_server_id: String| {
                let disconnected = Arc::clone(&disconnected_in);
                async move {
                    disconnected.store(true, Ordering::SeqCst);
                    Ok(server("destroyed"))
                }
            },
            move || {
                let disconnected = Arc::clone(&recheck_disconnected);
                async move {
                    let runtime = if disconnected.load(Ordering::SeqCst) {
                        Some("idle".to_string())
                    } else {
                        Some("running".to_string())
                    };
                    (runtime, true)
                }
            },
        )
        .await;
        assert!(!stop);
    }

    fn store_with_node(id: &str, source: &str, source_key: &str) -> crate::store::Store {
        let store = crate::store::Store::open_in_memory().unwrap();
        {
            let conn = store.conn();
            crate::store::configs::upsert_node(
                &conn,
                &crate::store::NewNode {
                    id,
                    name: "Tokyo",
                    server: "203.0.113.10",
                    port: 20343,
                    method: "aes-256-gcm",
                    password_ref: "node:nd",
                    source,
                    source_key,
                },
            )
            .unwrap();
        }
        store
    }

    /// 自建节点：`source_key` 就是服务器 id（镜像行还没建也认）。
    #[test]
    fn an_owned_node_maps_to_its_server() {
        let store = store_with_node("nd_a", crate::store::configs::SOURCE_OWNED, "srv_1");
        let conn = store.conn();
        assert_eq!(
            owned_server_of_node_in(&conn, "nd_a").as_deref(),
            Some("srv_1")
        );
    }

    /// 种子 / 手动节点不是服务器节点：不映射。
    #[test]
    fn a_seed_node_maps_to_nothing() {
        let store = store_with_node("nd_seed", "seed", "veyl_seed");
        let conn = store.conn();
        assert_eq!(owned_server_of_node_in(&conn, "nd_seed"), None);
        assert_eq!(owned_server_of_node_in(&conn, "nd_missing"), None);
    }

    fn activate_config_with_current(conn: &rusqlite::Connection, node_id: Option<&str>) {
        let dns = json!({ "mode": "auto", "local": [], "remote": [] });
        let excludes = json!([]);
        crate::store::configs::create(
            conn,
            &crate::store::NewConfig {
                id: "cfg_1",
                name: "A",
                connection_mode: crate::store::configs::CONNECTION_SYSTEM_PROXY,
                routing_mode: crate::store::configs::ROUTING_PROXY_ALL,
                listen_port: Some(7890),
                dns: &dns,
                tun_excludes: &excludes,
            },
        )
        .unwrap();
        crate::store::configs::activate(conn, "cfg_1").unwrap();
        if let Some(node_id) = node_id {
            crate::store::configs::attach_node(conn, "cfg_1", node_id).unwrap();
            crate::store::configs::update(
                conn,
                "cfg_1",
                &crate::store::configs::ConfigPatch {
                    current_node_id: Some(Some(node_id.into())),
                    ..Default::default()
                },
            )
            .unwrap();
        }
    }

    /// 当前节点是自建服务器节点 → 命中那台服务器。
    #[test]
    fn the_current_node_resolves_to_its_server() {
        let store = store_with_node("nd_a", crate::store::configs::SOURCE_OWNED, "srv_1");
        let conn = store.conn();
        activate_config_with_current(&conn, Some("nd_a"));
        assert_eq!(current_owned_server_in(&conn).as_deref(), Some("srv_1"));
    }

    /// 当前是种子节点 / 没有当前节点 → 不是服务器，返回 None。
    #[test]
    fn a_seed_current_node_is_not_a_server() {
        let seed = store_with_node("nd_seed", "seed", "veyl_seed");
        {
            let conn = seed.conn();
            activate_config_with_current(&conn, Some("nd_seed"));
            assert_eq!(current_owned_server_in(&conn), None);
        }

        let empty = crate::store::Store::open_in_memory().unwrap();
        {
            let conn = empty.conn();
            activate_config_with_current(&conn, None);
            assert_eq!(current_owned_server_in(&conn), None);
        }
    }
}

#[cfg(test)]
mod reconcile_tests {
    use super::reconcile_orphans_with;
    use crate::control_plane::error::CpError;
    use crate::control_plane::servers::{MyServer, OrphanOwnedNode};
    use serde_json::json;
    use std::sync::{Arc, Mutex};

    fn orphan() -> OrphanOwnedNode {
        OrphanOwnedNode {
            node_id: "nd_1".into(),
            server_id: "srv_1".into(),
            password_ref: "node:nd_1".into(),
        }
    }

    fn server(state: &str) -> MyServer {
        serde_json::from_value(json!({
            "server_id": "srv_1",
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

    fn events() -> Arc<Mutex<Vec<&'static str>>> {
        Arc::new(Mutex::new(Vec::new()))
    }

    /// 列表里确认已销毁：删掉残留节点。
    #[tokio::test]
    async fn a_destroyed_server_removes_the_orphan_node() {
        let log = events();
        let log_remove = Arc::clone(&log);
        let removed = reconcile_orphans_with(
            vec![orphan()],
            |_server_id: String| async { Ok(server("destroyed")) },
            |_server_id: &str| async { (false, true) },
            || async {},
            move |_orphan| log_remove.lock().unwrap().push("remove"),
        )
        .await;
        assert_eq!(removed, 1);
        assert_eq!(*log.lock().unwrap(), vec!["remove"]);
    }

    /// 详情 404：同样按「已不存在」处理。
    #[tokio::test]
    async fn a_not_found_server_removes_the_orphan_node() {
        let removed = reconcile_orphans_with(
            vec![orphan()],
            |_server_id: String| async {
                Err(CpError::new("NOT_FOUND", "找不到这台服务器", false, json!({})))
            },
            |_server_id: &str| async { (false, true) },
            || async {},
            |_orphan| {},
        )
        .await;
        assert_eq!(removed, 1);
    }

    /// 网络失败 / 服务器还活着：保留，等下一次列表。
    #[tokio::test]
    async fn an_uncertain_or_live_server_keeps_the_node() {
        let removed = reconcile_orphans_with(
            vec![orphan()],
            |_server_id: String| async {
                Err(CpError::new(
                    "UPSTREAM_ERROR",
                    "断网",
                    true,
                    json!({ "reason": "provider_unavailable" }),
                ))
            },
            |_server_id: &str| async { panic!("没确认没了就不该重读") },
            || async {},
            |_orphan| panic!("网络失败时不能删"),
        )
        .await;
        assert_eq!(removed, 0);

        let removed = reconcile_orphans_with(
            vec![orphan()],
            |_server_id: String| async { Ok(server("active")) },
            |_server_id: &str| async { panic!("服务器还活着时不该重读") },
            || async {},
            |_orphan| panic!("服务器还活着时不能删"),
        )
        .await;
        assert_eq!(removed, 0);
    }

    /// 确认没了、且此刻仍是当前节点、运行时在跑：先停运行时，再删节点。
    #[tokio::test]
    async fn a_current_orphan_stops_before_it_is_removed() {
        let log = events();
        let log_stop = Arc::clone(&log);
        let log_remove = Arc::clone(&log);
        let removed = reconcile_orphans_with(
            vec![orphan()],
            |_server_id: String| async { Ok(server("destroyed")) },
            |_server_id: &str| async { (true, true) },
            move || {
                let log = Arc::clone(&log_stop);
                async move {
                    log.lock().unwrap().push("stop");
                }
            },
            move |_orphan| log_remove.lock().unwrap().push("remove"),
        )
        .await;
        assert_eq!(removed, 1);
        assert_eq!(*log.lock().unwrap(), vec!["stop", "remove"]);
    }

    /// 运行时没在跑：不停，只删节点。
    #[tokio::test]
    async fn an_idle_runtime_does_not_stop_for_an_orphan() {
        let log = events();
        let log_remove = Arc::clone(&log);
        let removed = reconcile_orphans_with(
            vec![orphan()],
            |_server_id: String| async { Ok(server("destroyed")) },
            |_server_id: &str| async { (true, false) },
            || async { panic!("运行时没在跑时不该调 stop") },
            move |_orphan| log_remove.lock().unwrap().push("remove"),
        )
        .await;
        assert_eq!(removed, 1);
        assert_eq!(*log.lock().unwrap(), vec!["remove"]);
    }

    /// 请求期间用户切走了节点：确认之后重读不再是当前节点 → 不停，但仍删。
    /// 把重读挪到请求之前（或用请求前的快照），这条测试就会失败。
    #[tokio::test]
    async fn a_switch_during_the_check_keeps_the_tunnel_but_still_removes_the_node() {
        let log = events();
        let log_remove = Arc::clone(&log);
        let removed = reconcile_orphans_with(
            vec![orphan()],
            |_server_id: String| async { Ok(server("destroyed")) },
            |_server_id: &str| async { (false, true) },
            || async { panic!("已经切走了，不该停隧道") },
            move |_orphan| log_remove.lock().unwrap().push("remove"),
        )
        .await;
        assert_eq!(removed, 1);
        assert_eq!(*log.lock().unwrap(), vec!["remove"]);
    }
}
