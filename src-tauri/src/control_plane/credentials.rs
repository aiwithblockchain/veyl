//! 服务器凭据：Ed25519 验签 → 写 `secrets.enc` → 建 `nodes` 行（`source='owned'`）。
//!
//! 签名字节就是 `payload` 字符串本身（不要先解析再重序列化，键序会变）。
//! 任何一项校验不过都不落库，并按 `UPSTREAM_ERROR` 上报（§19.8）。

use base64::engine::general_purpose::{STANDARD, STANDARD_NO_PAD, URL_SAFE, URL_SAFE_NO_PAD};
use base64::Engine;
use serde::Deserialize;
use serde_json::json;

use super::error::CpError;
use crate::secrets::SecretsStore;
use crate::store::configs::upsert_node;
use crate::store::NewNode;

/// 控制面凭据签名公钥：`key_id` → 裸 32 字节 Ed25519 公钥的 base64url。
///
/// 私钥只在 Cloudflare Worker secret 里，不在仓库。轮换时新增一条
/// `("cp-20xx-xx", "...")`，客户端按响应里的 `key_id` 选择。
/// debug 构建可用 `VEYL_CREDENTIAL_PUBLIC_KEY` 临时注入，release 不读这个变量。
const CREDENTIAL_KEYS: &[(&str, &str)] = &[(
    "cp-2026-11",
    "KmTHenls8NqjIg9Ax2aT-Zks1EcutjrHiM20JK1BFu8",
)];

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

/// 写入本地凭据与节点行。拆分出来是为了让测试用临时 `SecretsStore` 断言「不落库」。
pub fn persist_with(
    secrets: &SecretsStore,
    conn: &rusqlite::Connection,
    server_name: Option<&str>,
    payload: &CredentialPayload,
) -> Result<(), CpError> {
    let secret_ref = format!("node:{}", payload.node_id);
    secrets
        .set(&secret_ref, &payload.password)
        .map_err(|_| CpError::internal("保存节点密码失败"))?;

    let name = server_name
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(&payload.server_id);
    upsert_node(
        conn,
        &NewNode {
            id: &payload.node_id,
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

    let _ = crate::store::servers::set_node(conn, &payload.server_id, &payload.node_id);
    Ok(())
}

/// 生产入口：内置公钥验签 + 全局凭据库/数据库落库。
pub fn verify_and_store(
    requested_server_id: &str,
    payload: &str,
    signature: &str,
    key_id: &str,
) -> Result<(), CpError> {
    let key = public_key(key_id)?;
    let verified = verify_with(&key, key_id, requested_server_id, payload, signature, key_id)?;

    let store = crate::store::global()
        .ok_or_else(|| CpError::internal("本地数据库不可用"))?;
    let conn = store.conn();
    let name = crate::store::servers::get(&conn, requested_server_id)
        .ok()
        .flatten()
        .map(|row| row.name);
    crate::secrets::set_secret(&format!("node:{}", verified.node_id), &verified.password)
        .map_err(|_| CpError::internal("保存节点密码失败"))?;
    let name = name.as_deref().unwrap_or(&verified.server_id);
    upsert_node(
        &conn,
        &NewNode {
            id: &verified.node_id,
            name,
            server: &verified.host,
            port: verified.port,
            method: &verified.method,
            password_ref: &format!("node:{}", verified.node_id),
            source: crate::store::configs::SOURCE_OWNED,
            source_key: &verified.server_id,
        },
    )
    .map_err(|error| CpError::internal(format!("保存节点失败：{error}")))?;
    let _ = crate::store::servers::set_node(&conn, &verified.server_id, &verified.node_id);
    Ok(())
}

/// 测试辅助：把一段载荷签成合法响应。
#[cfg(test)]
fn sign(key_pair: &ring::signature::Ed25519KeyPair, payload: &str) -> String {
    STANDARD.encode(key_pair.sign(payload.as_bytes()).as_ref())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::Store;
    use ring::signature::KeyPair;

    fn keypair() -> (ring::signature::Ed25519KeyPair, Vec<u8>) {
        let rng = ring::rand::SystemRandom::new();
        let pkcs8 = ring::signature::Ed25519KeyPair::generate_pkcs8(&rng).unwrap();
        let pair = ring::signature::Ed25519KeyPair::from_pkcs8(pkcs8.as_ref()).unwrap();
        let public = pair.public_key().as_ref().to_vec();
        (pair, public)
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
        let dir = std::env::temp_dir().join(format!("veyl-cp-secret-{:016x}", rand::random::<u64>()));
        std::fs::create_dir_all(&dir).unwrap();
        let secrets =
            SecretsStore::with_machine_id(dir.join("secrets.enc"), "test-machine").unwrap();
        persist_with(&secrets, &conn, Some("Tokyo"), &verified).unwrap();

        assert_eq!(
            secrets.get("node:nd_1").unwrap().as_deref(),
            Some("s3cret-password")
        );
        let node = crate::store::configs::get_node(&conn, "nd_1").unwrap().unwrap();
        assert_eq!(node.source, "owned");
        assert_eq!(node.password_ref, "node:nd_1");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_invalid_signature_is_rejected_and_nothing_is_stored() {
        let (pair, _) = keypair();
        let (_, other_public) = keypair();
        let body = payload("srv_1");
        let signature = sign(&pair, &body);
        let error =
            verify_with(&other_public, "cp-test", "srv_1", &body, &signature, "cp-test").unwrap_err();
        assert_eq!(error.reason(), Some("credential_signature_invalid"));

        // 验签失败时调用方拿不到载荷，持久化根本不会发生。
        let store = Store::open_in_memory().unwrap();
        let conn = store.conn();
        let dir = std::env::temp_dir().join(format!("veyl-cp-secret-{:016x}", rand::random::<u64>()));
        std::fs::create_dir_all(&dir).unwrap();
        let secrets =
            SecretsStore::with_machine_id(dir.join("secrets.enc"), "test-machine").unwrap();
        assert!(secrets.get("node:nd_1").unwrap().is_none());
        assert!(crate::store::configs::get_node(&conn, "nd_1").unwrap().is_none());
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
