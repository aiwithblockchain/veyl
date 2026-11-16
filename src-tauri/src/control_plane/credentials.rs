//! 服务器凭据：Ed25519 验签 → 写 `secrets.enc` → 建 `nodes` 行（`source='owned'`）。
//!
//! 签名字节就是 `payload` 字符串本身（不要先解析再重序列化，键序会变）。
//! 任何一项校验不过都不落库，并按 `UPSTREAM_ERROR` 上报（§19.8）。

use base64::engine::general_purpose::{STANDARD, STANDARD_NO_PAD, URL_SAFE, URL_SAFE_NO_PAD};
use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::json;

use super::error::CpError;
use crate::store::configs::upsert_node;
use crate::store::NewNode;

/// 控制面凭据签名公钥：`key_id` → 裸 32 字节 Ed25519 公钥的 base64url。
///
/// 私钥只在 Cloudflare Worker secret 里，不在仓库。轮换时新增一条
/// `("cp-20xx-xx", "...")`，客户端按响应里的 `key_id` 选择。
/// debug 构建可用 `VEYL_CREDENTIAL_PUBLIC_KEY` 临时注入，release 不读这个变量。
const CREDENTIAL_KEYS: &[(&str, &str)] = &[
    (
        "cp-2026-11",
        "KmTHenls8NqjIg9Ax2aT-Zks1EcutjrHiM20JK1BFu8",
    ),
    (
        "cp-2026-12",
        "riyn69Uz-9j4L5LRfShKsFIQtZ7pSdrwfvg40KpmEaI",
    ),
];

fn decode_any(value: &str) -> Option<Vec<u8>> {
    let trimmed = value.trim();
    for engine in [&STANDARD, &STANDARD_NO_PAD, &URL_SAFE, &URL_SAFE_NO_PAD] {
        if let Ok(bytes) = engine.decode(trimmed) {
            return Some(bytes);
        }
    }
    None
}

fn public_key(key_id: &str) -> Result<Vec<u8>, CpError> {
    if cfg!(debug_assertions) {
        if let Ok(value) = std::env::var("VEYL_CREDENTIAL_PUBLIC_KEY") {
            if let Some(bytes) = decode_any(&value) {
                if bytes.len() == 32 {
                    return Ok(bytes);
                }
            }
            return Err(CpError::new(
                "INTERNAL",
                "VEYL_CREDENTIAL_PUBLIC_KEY 不是 32 字节公钥",
                false,
                json!({ "reason": "credential_key_invalid" }),
            ));
        }
    }

    let Some((_, encoded)) = CREDENTIAL_KEYS.iter().find(|(id, _)| *id == key_id) else {
        return Err(CpError::new(
            "UPSTREAM_ERROR",
            "控制面用了未知的凭据签名密钥",
            false,
            json!({ "reason": "credential_key_unknown" }),
        ));
    };
    if encoded.is_empty() {
        return Err(CpError::new(
            "UPSTREAM_ERROR",
            "控制面凭据公钥尚未配置",
            false,
            json!({ "reason": "credential_key_missing" }),
        ));
    }
    let bytes = decode_any(encoded)
        .filter(|bytes| bytes.len() == 32)
        .ok_or_else(|| {
            CpError::new(
                "INTERNAL",
                "内置的凭据公钥不是 32 字节",
                false,
                json!({ "reason": "credential_key_invalid" }),
            )
        })?;
    Ok(bytes)
}

#[derive(Debug, Clone, Deserialize)]
pub struct CredentialPayload {
    pub server_id: String,
    pub node_id: String,
    pub host: String,
    pub port: u16,
    pub method: String,
    pub password: String,
    #[serde(default)]
    pub issued_at: Option<String>,
    pub expires_at: String,
}

fn parse_time(value: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|time| time.timestamp_millis())
}

fn validate_payload(
    requested_server_id: &str,
    payload: &CredentialPayload,
    now: i64,
) -> Result<(), CpError> {
    if payload.server_id != requested_server_id {
        return Err(CpError::new(
            "UPSTREAM_ERROR",
            "凭据与请求的服务器不一致",
            false,
            json!({ "reason": "credential_server_mismatch" }),
        ));
    }
    if payload.node_id.trim().is_empty() {
        return Err(CpError::invalid_response("凭据缺少 node_id"));
    }
    if payload.host.trim().is_empty() || payload.port == 0 {
        return Err(CpError::invalid_response("凭据里的服务器地址不合法"));
    }
    if !crate::catalog::SUPPORTED_METHODS.contains(&payload.method.as_str()) {
        return Err(CpError::new(
            "UNSUPPORTED",
            format!("不支持的加密方式：{}", payload.method),
            false,
            json!({ "reason": "unsupported_method" }),
        ));
    }
    if payload.password.is_empty() {
        return Err(CpError::invalid_response("凭据缺少密码"));
    }
    match parse_time(&payload.expires_at) {
        Some(expires) if expires > now => Ok(()),
        Some(_) => Err(CpError::new(
            "PRECONDITION_FAILED",
            "凭据已过期，请重新获取",
            true,
            json!({ "reason": "credential_expired" }),
        )),
        None => Err(CpError::invalid_response("凭据 expires_at 不是 ISO 8601")),
    }
}

/// 用指定公钥验签并校验载荷。`expected_key_id` 由调用方提供，测试可绕过内置表。
pub fn verify_with(
    public_key: &[u8],
    expected_key_id: &str,
    requested_server_id: &str,
    payload: &str,
    signature: &str,
    key_id: &str,
) -> Result<CredentialPayload, CpError> {
    if key_id != expected_key_id {
        return Err(CpError::new(
            "UPSTREAM_ERROR",
            "控制面用了未知的凭据签名密钥",
            false,
            json!({ "reason": "credential_key_unknown", "key_id": key_id }),
        ));
    }
    let signature = decode_any(signature).ok_or_else(|| {
        CpError::invalid_response("凭据签名不是合法的 base64")
    })?;
    ring::signature::UnparsedPublicKey::new(&ring::signature::ED25519, public_key)
        .verify(payload.as_bytes(), &signature)
        .map_err(|_| {
            CpError::new(
                "UPSTREAM_ERROR",
                "凭据验签失败",
                false,
                json!({ "reason": "credential_signature_invalid" }),
            )
        })?;

    let payload: CredentialPayload = serde_json::from_str(payload)
        .map_err(|_| CpError::invalid_response("凭据载荷格式不正确"))?;
    validate_payload(requested_server_id, &payload, chrono::Utc::now().timestamp_millis())?;
    Ok(payload)
}

/// 凭据落库后界面能用的本地节点；不含密码（密码只在 `secrets.enc`）。
///
/// `node_id` 是本地 `nodes.id` 而不是响应里的 `node_id`：两者首次签发时相同，
/// 控制面换发后本地仍沿用旧行，界面必须拿本地 id 才能建配置。
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct OwnedNode {
    pub server_id: String,
    pub node_id: String,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub method: String,
}

/// 控制面凭据响应的三个字段。缺任何一个都视为不可信响应，不落库。
#[derive(Debug, Clone, Copy)]
pub struct CredentialResponse<'a> {
    pub payload: &'a str,
    pub signature: &'a str,
    pub key_id: &'a str,
}

/// 写入本地凭据与节点行，并回填 `my_servers.node_id`。
///
/// 幂等键是 `(source='owned', source_key=server_id)`：同一台服务器重新取凭据时复用
/// 已有节点行（即使控制面换发了新 `node_id`），不会撞 `nodes` 的来源唯一索引。
/// `save_secret` 让测试用临时凭据库，生产走全局 `secrets.enc`。
pub fn persist_with(
    conn: &rusqlite::Connection,
    server_name: Option<&str>,
    payload: &CredentialPayload,
    save_secret: impl Fn(&str, &str) -> Result<(), ()>,
) -> Result<OwnedNode, CpError> {
    let existing = crate::store::configs::find_node_by_source_key(
        conn,
        crate::store::configs::SOURCE_OWNED,
        &payload.server_id,
    )
    .map_err(|error| CpError::internal(format!("读取本地节点失败：{error}")))?;
    let created = existing.is_none();
    let node_id = existing
        .as_ref()
        .map(|node| node.id.clone())
        .unwrap_or_else(|| payload.node_id.clone());
    let secret_ref = existing
        .as_ref()
        .map(|node| node.password_ref.clone())
        .unwrap_or_else(|| format!("node:{node_id}"));

    let name = server_name
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(&payload.server_id);
    // 先写节点再写密码：反过来一旦节点写失败，`secrets.enc` 会留下没有任何
    // 行引用的孤儿密钥。新节点密码写失败时回删刚建的节点行；已有节点保留旧密码。
    let node = upsert_node(
        conn,
        &NewNode {
            id: &node_id,
            name,
            server: &payload.host,
            port: payload.port,
            method: &payload.method,
            password_ref: &secret_ref,
            source: crate::store::configs::SOURCE_OWNED,
            source_key: &payload.server_id,
        },
    )
    .map_err(|error| CpError::internal(format!("保存节点失败：{error}")))?;

    if save_secret(&secret_ref, &payload.password).is_err() {
        if created {
            let _ = crate::store::configs::delete_node(conn, &node.id);
        }
        return Err(CpError::internal("保存节点密码失败"));
    }

    crate::store::servers::set_node(conn, &payload.server_id, &node.id)
        .map_err(|error| CpError::internal(format!("回填服务器节点失败：{error}")))?;

    Ok(OwnedNode {
        server_id: payload.server_id.clone(),
        node_id: node.id,
        name: node.name,
        host: node.server,
        port: node.port,
        method: node.method,
    })
}

/// 验签 → 落库：验不过就返回错误，调用方拿不到任何可持久化的东西。
///
/// 生产入口与单测走同一条路径，避免「测试只测了验签、生产落库另写一遍」。
pub fn materialize_with(
    conn: &rusqlite::Connection,
    server_name: Option<&str>,
    requested_server_id: &str,
    response: &CredentialResponse<'_>,
    public_key: &[u8],
    expected_key_id: &str,
    save_secret: impl Fn(&str, &str) -> Result<(), ()>,
) -> Result<OwnedNode, CpError> {
    let verified = verify_with(
        public_key,
        expected_key_id,
        requested_server_id,
        response.payload,
        response.signature,
        response.key_id,
    )?;
    persist_with(conn, server_name, &verified, save_secret)
}

/// 生产入口：内置公钥验签 + 全局凭据库/数据库落库，返回本地节点。
pub fn verify_and_store(
    requested_server_id: &str,
    payload: &str,
    signature: &str,
    key_id: &str,
) -> Result<OwnedNode, CpError> {
    let key = public_key(key_id)?;

    let store = crate::store::global().ok_or_else(|| CpError::internal("本地数据库不可用"))?;
    let conn = store.conn();
    let name = crate::store::servers::get(&conn, requested_server_id)
        .ok()
        .flatten()
        .map(|row| row.name);
    let response = CredentialResponse {
        payload,
        signature,
        key_id,
    };
    materialize_with(
        &conn,
        name.as_deref(),
        requested_server_id,
        &response,
        &key,
        key_id,
        |key, value| crate::secrets::set_secret(key, value).map_err(|_| ()),
    )
}

/// 测试辅助：把一段载荷签成合法响应。
#[cfg(test)]
fn sign(key_pair: &ring::signature::Ed25519KeyPair, payload: &str) -> String {
    STANDARD.encode(key_pair.sign(payload.as_bytes()).as_ref())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::secrets::SecretsStore;
    use crate::store::servers::NewMyServer;
    use crate::store::Store;
    use ring::signature::KeyPair;

    fn keypair() -> (ring::signature::Ed25519KeyPair, Vec<u8>) {
        let rng = ring::rand::SystemRandom::new();
        let pkcs8 = ring::signature::Ed25519KeyPair::generate_pkcs8(&rng).unwrap();
        let pair = ring::signature::Ed25519KeyPair::from_pkcs8(pkcs8.as_ref()).unwrap();
        let public = pair.public_key().as_ref().to_vec();
        (pair, public)
    }

    fn secrets_store() -> (SecretsStore, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!("veyl-cp-secret-{:016x}", rand::random::<u64>()));
        std::fs::create_dir_all(&dir).unwrap();
        let secrets =
            SecretsStore::with_machine_id(dir.join("secrets.enc"), "test-machine").unwrap();
        (secrets, dir)
    }

    fn save_into(secrets: &SecretsStore) -> impl Fn(&str, &str) -> Result<(), ()> + '_ {
        move |key, value| secrets.set(key, value).map_err(|_| ())
    }

    fn local_server(conn: &rusqlite::Connection) {
        crate::store::servers::upsert(
            conn,
            &NewMyServer {
                id: "srv_1",
                provider: "digitalocean",
                name: "Tokyo",
                region: "tyo",
                plan: "s-1vcpu-1gb",
                state: "active",
                node_id: None,
                hourly_usd: 0.009,
                monthly_usd: 6.0,
                daily_price_cents: 20,
                transfer_gib: 1000,
                paid_until: 1_700_086_400_000,
                billing_state: "active",
                created_at: 1_700_000_000_000,
            },
        )
        .unwrap();
    }

    fn payload(server_id: &str) -> String {
        let expires = (chrono::Utc::now() + chrono::Duration::minutes(5))
            .to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
        json!({
            "server_id": server_id,
            "node_id": "nd_1",
            "host": "203.0.113.10",
            "port": 20343,
            "method": "aes-256-gcm",
            "password": "s3cret-password",
            "issued_at": "2026-11-14T08:00:00Z",
            "expires_at": expires,
        })
        .to_string()
    }

    #[test]
    fn a_valid_signature_is_accepted_and_stored() {
        let (pair, public) = keypair();
        let body = payload("srv_1");
        let signature = sign(&pair, &body);
        let verified =
            verify_with(&public, "cp-test", "srv_1", &body, &signature, "cp-test").unwrap();
        assert_eq!(verified.node_id, "nd_1");

        let store = Store::open_in_memory().unwrap();
        let conn = store.conn();
        local_server(&conn);
        let (secrets, dir) = secrets_store();
        let node = persist_with(&conn, Some("Tokyo"), &verified, save_into(&secrets)).unwrap();

        assert_eq!(node.server_id, "srv_1");
        assert_eq!(node.node_id, "nd_1");
        assert_eq!(node.host, "203.0.113.10");
        assert_eq!(node.method, "aes-256-gcm");
        assert_eq!(
            secrets.get("node:nd_1").unwrap().as_deref(),
            Some("s3cret-password")
        );
        let stored = crate::store::configs::get_node(&conn, "nd_1").unwrap().unwrap();
        assert_eq!(stored.source, "owned");
        assert_eq!(stored.source_key, "srv_1");
        assert_eq!(stored.password_ref, "node:nd_1");
        // 服务器 ↔ 本地节点建立关联：界面后续用这个 id 建配置。
        assert_eq!(
            crate::store::servers::get(&conn, "srv_1")
                .unwrap()
                .unwrap()
                .node_id
                .as_deref(),
            Some("nd_1")
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_reissued_credential_reuses_the_same_local_node() {
        let (pair, public) = keypair();
        let body = payload("srv_1");
        let signature = sign(&pair, &body);
        let verified =
            verify_with(&public, "cp-test", "srv_1", &body, &signature, "cp-test").unwrap();

        let store = Store::open_in_memory().unwrap();
        let conn = store.conn();
        local_server(&conn);
        let (secrets, dir) = secrets_store();
        let first = persist_with(&conn, Some("Tokyo"), &verified, save_into(&secrets)).unwrap();
        assert_eq!(first.node_id, "nd_1");

        // 控制面重新签发，node_id 和端口都变了；本地仍以 server_id 为键复用同一行。
        let mut value: serde_json::Value =
            serde_json::from_str(&payload("srv_1")).unwrap();
        value["node_id"] = json!("nd_2");
        value["port"] = json!(20443);
        let body = value.to_string();
        let signature = sign(&pair, &body);
        let verified =
            verify_with(&public, "cp-test", "srv_1", &body, &signature, "cp-test").unwrap();
        let second = persist_with(&conn, Some("Tokyo"), &verified, save_into(&secrets)).unwrap();

        assert_eq!(second.node_id, "nd_1");
        assert_eq!(second.server_id, "srv_1");
        assert_eq!(second.port, 20443);
        // 服务器关联也要保持本地 id：换发后不能改成控制面的新 `nd_2`。
        assert_eq!(
            crate::store::servers::get(&conn, "srv_1")
                .unwrap()
                .unwrap()
                .node_id
                .as_deref(),
            Some("nd_1")
        );
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM nodes WHERE source = 'owned'", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(count, 1);
        assert_eq!(
            secrets.get("node:nd_1").unwrap().as_deref(),
            Some("s3cret-password")
        );
        assert!(secrets.get("node:nd_2").unwrap().is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_invalid_signature_is_rejected_and_nothing_is_stored() {
        let (pair, _) = keypair();
        let (_, other_public) = keypair();
        let body = payload("srv_1");
        let signature = sign(&pair, &body);

        let store = Store::open_in_memory().unwrap();
        let conn = store.conn();
        local_server(&conn);
        let (secrets, dir) = secrets_store();
        let response = CredentialResponse {
            payload: &body,
            signature: &signature,
            key_id: "cp-test",
        };
        let error = materialize_with(
            &conn,
            Some("Tokyo"),
            "srv_1",
            &response,
            &other_public,
            "cp-test",
            save_into(&secrets),
        )
        .unwrap_err();
        assert_eq!(error.reason(), Some("credential_signature_invalid"));

        // 验签在落库之前：错误路径上节点行、密码、服务器关联都不该出现。
        assert!(crate::store::configs::get_node(&conn, "nd_1")
            .unwrap()
            .is_none());
        assert!(secrets.get("node:nd_1").unwrap().is_none());
        assert_eq!(
            crate::store::servers::get(&conn, "srv_1")
                .unwrap()
                .unwrap()
                .node_id,
            None
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_payload_missing_required_fields_is_rejected_and_nothing_is_stored() {
        let (pair, public) = keypair();
        let store = Store::open_in_memory().unwrap();
        let conn = store.conn();
        local_server(&conn);
        let (secrets, dir) = secrets_store();

        let missing: [(&str, serde_json::Value); 4] = [
            ("password", json!("")),
            ("host", json!("")),
            ("port", json!(0)),
            ("node_id", json!("")),
        ];
        for (field, value) in missing {
            let mut body: serde_json::Value = serde_json::from_str(&payload("srv_1")).unwrap();
            body[field] = value;
            let body = body.to_string();
            let signature = sign(&pair, &body);
            let response = CredentialResponse {
                payload: &body,
                signature: &signature,
                key_id: "cp-test",
            };
            let error = materialize_with(
                &conn,
                Some("Tokyo"),
                "srv_1",
                &response,
                &public,
                "cp-test",
                save_into(&secrets),
            )
            .unwrap_err();
            assert_eq!(error.reason(), Some("invalid_response"), "{field}");
            assert_eq!(error.code, "UPSTREAM_ERROR", "{field}");
        }

        assert!(crate::store::configs::get_node(&conn, "nd_1")
            .unwrap()
            .is_none());
        assert!(secrets.get("node:nd_1").unwrap().is_none());
        assert_eq!(
            crate::store::servers::get(&conn, "srv_1")
                .unwrap()
                .unwrap()
                .node_id,
            None
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_failed_secret_write_removes_the_new_node() {
        let (pair, public) = keypair();
        let body = payload("srv_1");
        let signature = sign(&pair, &body);
        let verified =
            verify_with(&public, "cp-test", "srv_1", &body, &signature, "cp-test").unwrap();

        let store = Store::open_in_memory().unwrap();
        let conn = store.conn();
        local_server(&conn);
        let error = persist_with(&conn, Some("Tokyo"), &verified, |_, _| Err(())).unwrap_err();
        assert_eq!(error.reason(), Some("internal"));

        // 新节点还没写进密码，不能留在节点池里；服务器也不该关联它。
        assert!(crate::store::configs::get_node(&conn, "nd_1")
            .unwrap()
            .is_none());
        assert_eq!(
            crate::store::servers::get(&conn, "srv_1")
                .unwrap()
                .unwrap()
                .node_id,
            None
        );
    }

    #[test]
    fn a_failed_secret_write_keeps_an_existing_node_and_its_password() {
        let (pair, public) = keypair();
        let body = payload("srv_1");
        let signature = sign(&pair, &body);
        let verified =
            verify_with(&public, "cp-test", "srv_1", &body, &signature, "cp-test").unwrap();

        let store = Store::open_in_memory().unwrap();
        let conn = store.conn();
        local_server(&conn);
        let (secrets, dir) = secrets_store();
        persist_with(&conn, Some("Tokyo"), &verified, save_into(&secrets)).unwrap();

        // 控制面换发：新 node_id、新密码；覆盖写密码失败时旧密码与旧节点必须保留。
        let mut value: serde_json::Value = serde_json::from_str(&payload("srv_1")).unwrap();
        value["node_id"] = json!("nd_2");
        value["password"] = json!("rotated-password");
        let body = value.to_string();
        let signature = sign(&pair, &body);
        let verified =
            verify_with(&public, "cp-test", "srv_1", &body, &signature, "cp-test").unwrap();
        let error = persist_with(&conn, Some("Tokyo"), &verified, |_, _| Err(())).unwrap_err();
        assert_eq!(error.reason(), Some("internal"));

        assert!(crate::store::configs::get_node(&conn, "nd_2")
            .unwrap()
            .is_none());
        let stored = crate::store::configs::get_node(&conn, "nd_1")
            .unwrap()
            .unwrap();
        assert_eq!(stored.password_ref, "node:nd_1");
        assert_eq!(
            secrets.get("node:nd_1").unwrap().as_deref(),
            Some("s3cret-password")
        );
        assert_eq!(
            crate::store::servers::get(&conn, "srv_1")
                .unwrap()
                .unwrap()
                .node_id
                .as_deref(),
            Some("nd_1")
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_payload_for_another_server_is_rejected() {
        let (pair, public) = keypair();
        let body = payload("srv_1");
        let signature = sign(&pair, &body);
        let error =
            verify_with(&public, "cp-test", "srv_2", &body, &signature, "cp-test").unwrap_err();
        assert_eq!(error.reason(), Some("credential_server_mismatch"));
    }

    #[test]
    fn an_expired_or_unknown_key_payload_is_rejected() {
        let (pair, public) = keypair();
        let mut value: serde_json::Value = serde_json::from_str(&payload("srv_1")).unwrap();
        value["expires_at"] = json!("2020-01-01T00:00:00Z");
        let body = value.to_string();
        let signature = sign(&pair, &body);
        let error =
            verify_with(&public, "cp-test", "srv_1", &body, &signature, "cp-test").unwrap_err();
        assert_eq!(error.reason(), Some("credential_expired"));

        let error =
            verify_with(&public, "cp-test", "srv_1", &body, &signature, "cp-other").unwrap_err();
        assert_eq!(error.reason(), Some("credential_key_unknown"));
    }

    #[test]
    fn the_built_in_public_key_is_a_32_byte_ed25519_key() {
        let (key_id, encoded) = CREDENTIAL_KEYS
            .iter()
            .find(|(id, _)| *id == "cp-2026-11")
            .expect("必须内置 cp-2026-11");
        assert_eq!(*key_id, "cp-2026-11");
        // 固定断言当前公钥：旧密钥已按泄露处理并轮换，留旧值会让真机验签静默失败。
        assert_eq!(
            *encoded,
            "KmTHenls8NqjIg9Ax2aT-Zks1EcutjrHiM20JK1BFu8"
        );
        assert_eq!(
            decode_any(encoded).expect("公钥必须是合法 base64url").len(),
            32,
            "Ed25519 公钥必须是裸 32 字节"
        );
    }

    #[test]
    fn an_unsupported_method_is_rejected() {
        let (pair, public) = keypair();
        let mut value: serde_json::Value = serde_json::from_str(&payload("srv_1")).unwrap();
        value["method"] = json!("chacha20-ietf-poly1305");
        let body = value.to_string();
        let signature = sign(&pair, &body);
        let error =
            verify_with(&public, "cp-test", "srv_1", &body, &signature, "cp-test").unwrap_err();
        assert_eq!(error.code, "UNSUPPORTED");
    }
}
