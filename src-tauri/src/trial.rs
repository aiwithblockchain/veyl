//! 免费节点 7 天试用：本地时间锚点与到期清理。
//!
//! 契约：`commands.md` §7.19、`events.md` §4.24、`data-model.md` §3.12。
//! 只在本地计时，不做服务端防刷；删除 `trial_state` 行等于重置。

use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};

use crate::store::configs;
use crate::store::db::{iso_from_ms, now_ms};
use crate::store::error::StoreResult;
use crate::store::seed_cache;

pub const TRIAL_DURATION_MS: i64 = 7 * 24 * 60 * 60 * 1000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Phase {
    Available,
    Active,
    Expired,
}

impl Phase {
    pub fn as_str(self) -> &'static str {
        match self {
            Phase::Available => "available",
            Phase::Active => "active",
            Phase::Expired => "expired",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Status {
    pub phase: Phase,
    pub started_at_ms: Option<i64>,
    pub expires_at_ms: Option<i64>,
    pub remaining_ms: Option<i64>,
}

pub fn status(conn: &Connection) -> StoreResult<Status> {
    status_at(conn, now_ms())
}

pub fn status_at(conn: &Connection, now: i64) -> StoreResult<Status> {
    let row: Option<(Option<i64>, Option<i64>)> = conn
        .query_row(
            "SELECT started_at, ended_at FROM trial_state WHERE id = 1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    let Some((Some(started_at), ended_at)) = row else {
        return Ok(Status {
            phase: Phase::Available,
            started_at_ms: None,
            expires_at_ms: None,
            remaining_ms: None,
        });
    };

    let expires_at = started_at.saturating_add(TRIAL_DURATION_MS);
    if ended_at.is_some() || now >= expires_at {
        return Ok(Status {
            phase: Phase::Expired,
            started_at_ms: Some(started_at),
            expires_at_ms: Some(expires_at),
            remaining_ms: Some(0),
        });
    }

    Ok(Status {
        phase: Phase::Active,
        started_at_ms: Some(started_at),
        expires_at_ms: Some(expires_at),
        remaining_ms: Some((expires_at - now).max(0)),
    })
}

/// 种子写入闸门的哨兵错误：只表示「试用已到期」。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SeedTrialExpired;

impl std::fmt::Display for SeedTrialExpired {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(SEED_TRIAL_EXPIRED_MESSAGE)
    }
}

impl std::error::Error for SeedTrialExpired {}

/// 对外固定文案（AI 工具信封与 UI 通道共用）。
pub const SEED_TRIAL_EXPIRED_MESSAGE: &str =
    "试用节点已过期，不再更新。换用自己的节点，或新建一台服务器。";

/// 六条种子写入路径共用的判定（`docs/design/trial-seed-expiry.md` §3.5）。
///
/// 只有 `Expired` 返回 `Err`；读状态失败按「未过期」放行并记 warn——
/// 闸门是防续期，不是安全边界，不能因为数据库暂时读不出来拦住正常用户。
pub fn ensure_seed_trial_active(conn: &Connection) -> Result<(), SeedTrialExpired> {
    match status(conn) {
        Ok(status) if status.phase == Phase::Expired => Err(SeedTrialExpired),
        Ok(_) => Ok(()),
        Err(error) => {
            log::warn!("读取试用状态失败，按未过期放行：{error}");
            Ok(())
        }
    }
}

/// `TrialStatusData`（`commands.md` §7.19）。只读，不触发清理。
pub fn status_json(conn: &Connection) -> StoreResult<Value> {
    let status = status(conn)?;
    Ok(json!({
        "state": status.phase.as_str(),
        "started_at": status.started_at_ms.map(iso_from_ms),
        "expires_at": status.expires_at_ms.map(iso_from_ms),
        "remaining_ms": status.remaining_ms,
        "seed_node_count": seed_node_count(conn)?,
    }))
}

/// 全库去重的种子节点数：以 `config_nodes` 的池子为准。
///
/// 清理后节点行还在（`data-model.md` §3.12），但关联已经没了，所以这里是 0。
fn seed_node_count(conn: &Connection) -> StoreResult<i64> {
    let count = conn.query_row(
        "SELECT COUNT(DISTINCT n.id)
           FROM config_nodes cn
           JOIN nodes n ON n.id = cn.node_id
          WHERE n.source = ?1",
        params![configs::SOURCE_SEED],
        |row| row.get(0),
    )?;
    Ok(count)
}

/// 第一次连上种子节点时写 `started_at`，只写一次。
///
/// 返回本次是否真的写入；已开始过的试用不会被后续连接改写。
pub fn mark_started(conn: &Connection, at_ms: i64) -> StoreResult<bool> {
    let changed = conn.execute(
        "INSERT INTO trial_state (id, started_at, ended_at) VALUES (1, ?1, NULL)
         ON CONFLICT(id) DO UPDATE SET started_at = excluded.started_at
         WHERE trial_state.started_at IS NULL",
        params![at_ms],
    )?;
    Ok(changed > 0)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Expired {
    pub ended_at_ms: i64,
    /// 本次清理删掉的种子节点 id（全部 `source = 'seed'` 行）。
    pub removed_node_ids: Vec<String>,
}

impl Expired {
    pub fn removed_node_count(&self) -> usize {
        self.removed_node_ids.len()
    }
}

/// 到期清理：一次事务里写排除、删关联、修当前节点、删节点行与缓存、写 `ended_at`。
///
/// 到期后本地不留任何可绑回的种子数据：节点行、缓存元数据都在事务里删掉，
/// `secrets.enc` 里的条目在提交后 best-effort 删除。
///
/// 返回 `None` 表示还没到期或已经清过；`Some` 只会在**第一次**写入
/// `ended_at` 时返回一次，调用方据此保证 `trial-expired` 每台机器只发一次。
pub fn expire_if_needed(conn: &Connection, at_ms: i64) -> StoreResult<Option<Expired>> {
    let tx = conn.unchecked_transaction()?;

    // 事务内重新读一次：只有一个连接，但把判定和写入放在同一事务里更稳。
    let row: Option<(Option<i64>, Option<i64>)> = tx
        .query_row(
            "SELECT started_at, ended_at FROM trial_state WHERE id = 1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    let Some((Some(started_at), None)) = row else {
        return Ok(None);
    };
    if at_ms < started_at.saturating_add(TRIAL_DURATION_MS) {
        return Ok(None);
    }

    // 1. 收齐种子节点（id / 去重键 / 凭据引用），再把去重键写进排除表。
    // 排除表保留：即使将来有别的路径重新拉种子，也不会自动复活。
    let seed_nodes: Vec<(String, String, String)> = {
        let mut statement = tx.prepare(
            "SELECT id, source_key, password_ref FROM nodes WHERE source = ?1",
        )?;
        let rows = statement.query_map(params![configs::SOURCE_SEED], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?))
        })?;
        rows.collect::<Result<Vec<_>, _>>()?
    };
    for (_, key, _) in &seed_nodes {
        tx.execute(
            "INSERT INTO seed_node_exclusions (source_key, created_at)
             VALUES (?1, ?2)
             ON CONFLICT(source_key) DO NOTHING",
            params![key, at_ms],
        )?;
    }
    let removed_node_ids: Vec<String> = seed_nodes
        .iter()
        .map(|(id, _, _)| id.clone())
        .collect();

    // 2. 删掉所有种子节点的配置关联。
    tx.execute(
        "DELETE FROM config_nodes
          WHERE node_id IN (SELECT id FROM nodes WHERE source = ?1)",
        params![configs::SOURCE_SEED],
    )?;

    // 3. 当前节点被移除时落到剩余第一个；没有剩余则置 NULL。
    // 必须排在删节点行之前：子查询还要读 `nodes`。
    tx.execute(
        "UPDATE configs
            SET current_node_id = (
                    SELECT cn.node_id
                      FROM config_nodes cn
                     WHERE cn.config_id = configs.id
                     ORDER BY cn.position ASC
                     LIMIT 1
                ),
                updated_at = ?1
          WHERE current_node_id IS NOT NULL
            AND current_node_id IN (SELECT id FROM nodes WHERE source = ?2)",
        params![at_ms, configs::SOURCE_SEED],
    )?;

    // 4. 删掉种子节点行本身。到期后不再保留「供离线诊断」的节点，
    // 否则 `node_attach({ nodeIds })` 还能把带旧密码的种子节点绑回来。
    tx.execute(
        "DELETE FROM nodes WHERE source = ?1",
        params![configs::SOURCE_SEED],
    )?;

    // 5. 清种子缓存元数据。原文密文不在 SQLite 里，提交后单独删（见下）。
    let cache_hash = seed_cache::clear(&tx)?.map(|row| row.content_sha256);

    // 6. 写结束时刻。只有这一次会写成功，后续扫描直接跳过。
    tx.execute(
        "UPDATE trial_state SET ended_at = ?1 WHERE id = 1 AND ended_at IS NULL",
        params![at_ms],
    )?;

    tx.commit()?;

    // 密文在提交后删，顺序不能反：
    // - 先删密文再提交，一旦提交失败，库里会留下取不到密码的节点行；
    // - 提交后删是 best-effort，失败只记 warn，不影响到期结果（节点行与缓存已经没了）。
    // 崩溃窗口：进程若在提交后、删密文前退出，`secrets.enc` 会留下孤儿条目。
    // 这些密钥没有任何 `nodes` / `seed_cache` 引用，不会进入任何读取路径，
    // 只是占用加密文件的磁盘；本轮不做自动清扫（`secrets` 模块不能枚举键，
    // 见 `data-model.md` §5.4）。
    let mut secret_refs: Vec<String> = seed_nodes
        .iter()
        .map(|(_, _, password_ref)| password_ref.clone())
        .collect();
    if let Some(hash) = cache_hash {
        secret_refs.push(crate::seed::secret_key(&hash));
    }
    for reference in secret_refs {
        if let Err(error) = crate::secrets::delete_secret(&reference) {
            log::warn!("到期清理删除种子凭据失败（不影响到期结果）：{reference}：{error}");
        }
    }

    Ok(Some(Expired {
        ended_at_ms: at_ms,
        removed_node_ids,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::configs::{
        self, NewConfig, NewNode, CONNECTION_SYSTEM_PROXY, ROUTING_PROXY_ALL, SOURCE_MANUAL,
        SOURCE_SEED,
    };
    use crate::store::Store;

    fn store_with_config() -> (Store, String) {
        let store = Store::open_in_memory().unwrap();
        let conn = store.conn();
        let config = configs::create(
            &conn,
            &NewConfig {
                id: "cfg_trial",
                name: "默认配置",
                connection_mode: CONNECTION_SYSTEM_PROXY,
                routing_mode: ROUTING_PROXY_ALL,
                listen_port: None,
                dns: &json!({"mode": "auto", "local": [], "remote": []}),
                tun_excludes: &json!([]),
            },
        )
        .unwrap();
        configs::activate(&conn, &config.id).unwrap();
        drop(conn);
        (store, config.id)
    }

    fn add_node(store: &Store, config_id: &str, id: &str, source: &str, key: &str) {
        let conn = store.conn();
        configs::upsert_node(
            &conn,
            &NewNode {
                id,
                name: id,
                server: "198.51.100.10",
                port: 8388,
                method: "aes-256-gcm",
                password_ref: &format!("node:{id}"),
                source,
                source_key: key,
            },
        )
        .unwrap();
        configs::attach_node(&conn, config_id, id).unwrap();
    }

    fn set_current(store: &Store, config_id: &str, node_id: Option<&str>) {
        let conn = store.conn();
        configs::update(
            &conn,
            config_id,
            &configs::ConfigPatch {
                current_node_id: Some(node_id.map(str::to_string)),
                ..Default::default()
            },
        )
        .unwrap();
    }

    fn set_started(store: &Store, at_ms: i64) {
        let conn = store.conn();
        assert!(mark_started(&conn, at_ms).unwrap());
    }

    #[test]
    fn status_reports_available_active_and_expired() {
        let (store, _) = store_with_config();
        {
            let conn = store.conn();
            let available = status_at(&conn, now_ms()).unwrap();
            assert_eq!(available.phase, Phase::Available);
            assert_eq!(available.started_at_ms, None);
            assert_eq!(available.expires_at_ms, None);
            assert_eq!(available.remaining_ms, None);
        }

        let now = now_ms();
        set_started(&store, now);
        {
            let conn = store.conn();
            let active = status_at(&conn, now + 1000).unwrap();
            assert_eq!(active.phase, Phase::Active);
            assert_eq!(active.remaining_ms, Some(TRIAL_DURATION_MS - 1000));
        }

        // 到期由时间推导，不需要先跑清理。
        {
            let conn = store.conn();
            let expired = status_at(&conn, now + TRIAL_DURATION_MS).unwrap();
            assert_eq!(expired.phase, Phase::Expired);
            assert_eq!(expired.remaining_ms, Some(0));
        }
    }

    #[test]
    fn ended_at_marks_expired_even_before_the_deadline() {
        let (store, _) = store_with_config();
        let now = now_ms();
        set_started(&store, now);
        {
            let conn = store.conn();
            conn.execute(
                "UPDATE trial_state SET ended_at = ?1 WHERE id = 1",
                params![now + 1],
            )
            .unwrap();
            let status = status_at(&conn, now + 2).unwrap();
            assert_eq!(status.phase, Phase::Expired);
            assert_eq!(status.remaining_ms, Some(0));
        }
    }

    #[test]
    fn mark_started_only_writes_once() {
        let (store, _) = store_with_config();
        let first = now_ms();
        {
            let conn = store.conn();
            assert!(mark_started(&conn, first).unwrap());
            assert!(!mark_started(&conn, first + 10_000).unwrap());
            let started: Option<i64> = conn
                .query_row(
                    "SELECT started_at FROM trial_state WHERE id = 1",
                    [],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(started, Some(first));
        }
    }

    #[test]
    fn expire_writes_exclusions_removes_seed_links_and_fixes_current() {
        let (store, config_id) = store_with_config();
        add_node(&store, &config_id, "node_seed", SOURCE_SEED, "seed-key");
        add_node(&store, &config_id, "node_own", SOURCE_MANUAL, "own-key");
        set_current(&store, &config_id, Some("node_seed"));
        let started = now_ms() - TRIAL_DURATION_MS - 1;
        set_started(&store, started);

        let expired = {
            let conn = store.conn();
            expire_if_needed(&conn, now_ms()).unwrap().unwrap()
        };
        assert_eq!(expired.removed_node_ids, vec!["node_seed".to_string()]);
        assert_eq!(expired.removed_node_count(), 1);

        let conn = store.conn();
        // 排除表：刷新不会把种子加回来。
        let excluded: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM seed_node_exclusions WHERE source_key = 'seed-key'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(excluded, 1);
        // 只留用户自己的节点。
        let links: Vec<String> = {
            let mut statement = conn
                .prepare("SELECT node_id FROM config_nodes WHERE config_id = ?1 ORDER BY position")
                .unwrap();
            statement
                .query_map(params![config_id], |row| row.get(0))
                .unwrap()
                .collect::<Result<Vec<_>, _>>()
                .unwrap()
        };
        assert_eq!(links, vec!["node_own".to_string()]);
        assert!(configs::get_node(&conn, "node_seed").unwrap().is_none());
        // 当前节点落到剩余的第一个。
        let current: Option<String> = conn
            .query_row(
                "SELECT current_node_id FROM configs WHERE id = ?1",
                params![config_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(current.as_deref(), Some("node_own"));
        // ended_at 已写，第二次扫描不会再返回 Some。
        assert!(expire_if_needed(&conn, now_ms() + 1).unwrap().is_none());
    }

    #[test]
    fn expire_clears_current_node_when_no_nodes_remain() {
        let (store, config_id) = store_with_config();
        add_node(&store, &config_id, "node_seed", SOURCE_SEED, "seed-key");
        set_current(&store, &config_id, Some("node_seed"));
        set_started(&store, now_ms() - TRIAL_DURATION_MS - 1);

        {
            let conn = store.conn();
            assert_eq!(
                expire_if_needed(&conn, now_ms())
                    .unwrap()
                    .unwrap()
                    .removed_node_count(),
                1
            );
            let current: Option<String> = conn
                .query_row(
                    "SELECT current_node_id FROM configs WHERE id = ?1",
                    params![config_id],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(current, None);
        }
    }

    /// 到期清理把种子留痕清干净：节点行、缓存元数据、密文都不留；
    /// 二次扫描仍返回 `None`，不会因为节点已删而报错。
    #[test]
    fn expiry_purges_seed_nodes_cache_and_secrets() {
        crate::test_support::install_test_secrets();
        let (store, config_id) = store_with_config();
        add_node(&store, &config_id, "node_seed", SOURCE_SEED, "seed-key");
        let body = r#"{"nodes":[
            {"name":"A","server":"203.0.113.10","port":8388,"method":"aes-256-gcm","password":"pw"}
        ]}"#;
        let hash = crate::seed::content_sha256(body.as_bytes());
        {
            let conn = store.conn();
            crate::secrets::set_secret("node:node_seed", "pw-node").unwrap();
            crate::secrets::set_secret(&crate::seed::secret_key(&hash), body).unwrap();
            seed_cache::save(
                &conn,
                &seed_cache::SeedCacheRow {
                    content_sha256: hash.clone(),
                    etag: None,
                    etag_source: None,
                    source_version: Some("1".into()),
                    source_updated_at: None,
                    node_count: 1,
                    fetched_at: 1,
                    checked_at: 1,
                },
            )
            .unwrap();
        }
        set_started(&store, now_ms() - TRIAL_DURATION_MS - 1);

        {
            let conn = store.conn();
            assert_eq!(
                expire_if_needed(&conn, now_ms())
                    .unwrap()
                    .unwrap()
                    .removed_node_count(),
                1
            );
            let seed_rows: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM nodes WHERE source = ?1",
                    params![SOURCE_SEED],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(seed_rows, 0, "种子节点行必须删掉");
            assert!(seed_cache::load(&conn).unwrap().is_none(), "缓存元数据必须清空");
            let status = status_json(&conn).unwrap();
            assert_eq!(status["state"], "expired");
            assert_eq!(status["seed_node_count"], 0);
            assert!(
                expire_if_needed(&conn, now_ms() + 1).unwrap().is_none(),
                "第二次扫描不能再执行清理"
            );
        }

        assert!(
            crate::secrets::get_secret("node:node_seed").unwrap().is_none(),
            "节点凭据应删除"
        );
        assert!(
            crate::secrets::get_secret(&crate::seed::secret_key(&hash))
                .unwrap()
                .is_none(),
            "缓存原文应删除"
        );
    }

    #[test]
    fn expire_does_nothing_before_the_deadline() {
        let (store, config_id) = store_with_config();
        add_node(&store, &config_id, "node_seed", SOURCE_SEED, "seed-key");
        set_current(&store, &config_id, Some("node_seed"));
        let now = now_ms();
        set_started(&store, now);

        {
            let conn = store.conn();
            assert!(expire_if_needed(&conn, now + 1000).unwrap().is_none());
            let excluded: i64 = conn
                .query_row("SELECT COUNT(*) FROM seed_node_exclusions", [], |row| {
                    row.get(0)
                })
                .unwrap();
            assert_eq!(excluded, 0, "未到期不能写排除");
            let ended: Option<i64> = conn
                .query_row("SELECT ended_at FROM trial_state WHERE id = 1", [], |row| {
                    row.get(0)
                })
                .unwrap();
            assert_eq!(ended, None);
        }
    }

    #[test]
    fn trial_status_shape_matches_the_contract() {
        let (store, config_id) = store_with_config();
        add_node(&store, &config_id, "node_seed", SOURCE_SEED, "seed-key");
        let now = now_ms();
        set_started(&store, now);

        let conn = store.conn();
        let data = status_json(&conn).unwrap();
        assert_eq!(data["state"], "active");
        assert!(data["started_at"].as_str().unwrap().ends_with('Z'));
        assert!(data["expires_at"].as_str().unwrap().ends_with('Z'));
        assert!(data["remaining_ms"].as_i64().unwrap() > 0);
        assert_eq!(data["seed_node_count"], 1);
    }

    /// 删除 `trial_state` 行等于重置：状态回到 available，下一次首连可以重新起算。
    #[test]
    fn deleting_the_row_resets_the_trial() {
        let (store, _) = store_with_config();
        let first = now_ms();
        {
            let conn = store.conn();
            assert!(mark_started(&conn, first).unwrap());
            assert_eq!(status_at(&conn, first + 1).unwrap().phase, Phase::Active);
            conn.execute("DELETE FROM trial_state", []).unwrap();
            assert_eq!(status_at(&conn, first + 1).unwrap().phase, Phase::Available);
            assert!(mark_started(&conn, first + 1000).unwrap());
            let started: Option<i64> = conn
                .query_row(
                    "SELECT started_at FROM trial_state WHERE id = 1",
                    [],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(started, Some(first + 1000), "重置后允许重新写入");
        }
    }

    /// `seed_node_count` 是全库去重：跨配置共享的种子节点只算一次；
    /// available 也报真实值，不恒报 0。
    #[test]
    fn seed_node_count_is_global_and_deduplicated() {
        let (store, first_config) = store_with_config();
        let second_id = {
            let conn = store.conn();
            configs::create(
                &conn,
                &NewConfig {
                    id: "cfg_second",
                    name: "第二套",
                    connection_mode: CONNECTION_SYSTEM_PROXY,
                    routing_mode: ROUTING_PROXY_ALL,
                    listen_port: None,
                    dns: &json!({"mode": "auto", "local": [], "remote": []}),
                    tun_excludes: &json!([]),
                },
            )
            .unwrap()
            .id
        };

        // S1 同时挂在两套配置上；S2 只在第二套。去重后是 2，不是 3。
        add_node(&store, &first_config, "node_s1", SOURCE_SEED, "seed-s1");
        add_node(&store, &second_id, "node_s2", SOURCE_SEED, "seed-s2");
        {
            let conn = store.conn();
            configs::attach_node(&conn, &second_id, "node_s1").unwrap();
            // 还没开始试用也必须报真实数量。
            let available = status_json(&conn).unwrap();
            assert_eq!(available["state"], "available");
            assert_eq!(available["seed_node_count"], 2);
        }

        set_started(&store, now_ms() - TRIAL_DURATION_MS - 1);
        {
            let conn = store.conn();
            assert_eq!(status_json(&conn).unwrap()["seed_node_count"], 2);
            assert!(expire_if_needed(&conn, now_ms()).unwrap().is_some());
            assert_eq!(
                status_json(&conn).unwrap()["seed_node_count"],
                0,
                "清理后池子里不应再有种子节点"
            );
        }
    }
}
