//! One-time bearer tokens, in the exact format the control plane signs
//! (`cloudflare/control-plane/src/lib/crypto.ts`):
//!
//! ```text
//! base64url({"alg":"EdDSA","typ":"JWT"}) . base64url({server_id,jti,exp}) . base64url(sig)
//! ```
//!
//! The signature covers `header.payload`. The agent verifies fully offline with
//! the Ed25519 public key handed out by `/v1/agent/enroll` (JWK), then checks
//! `exp`, `server_id`, and that the jti has not already authorized a tool call.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::Context;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use ed25519_dalek::{Signature, Signer, SigningKey, VerifyingKey};
use rand_core::RngCore;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TokenPayload {
    pub server_id: String,
    pub jti: String,
    /// Unix seconds.
    pub exp: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct TokenHeader {
    alg: String,
    typ: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuthError {
    Missing,
    Malformed,
    BadSignature,
    WrongServer,
    Expired,
    Replayed,
}

impl AuthError {
    pub fn code(self) -> &'static str {
        match self {
            AuthError::Missing => "missing_token",
            AuthError::Malformed => "malformed_token",
            AuthError::BadSignature => "bad_signature",
            AuthError::WrongServer => "wrong_server",
            AuthError::Expired => "expired",
            AuthError::Replayed => "replayed",
        }
    }
}

impl std::fmt::Display for AuthError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.code())
    }
}

impl std::error::Error for AuthError {}

pub fn now_unix() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

pub fn mint_token(signing_key: &SigningKey, server_id: &str, jti: &str, exp: u64) -> String {
    let payload = TokenPayload {
        server_id: server_id.to_string(),
        jti: jti.to_string(),
        exp,
    };
    mint_payload(signing_key, &payload)
}

pub fn mint_payload(signing_key: &SigningKey, payload: &TokenPayload) -> String {
    let header = TokenHeader {
        alg: "EdDSA".into(),
        typ: "JWT".into(),
    };
    let header_b64 =
        URL_SAFE_NO_PAD.encode(serde_json::to_vec(&header).expect("token header serializes"));
    let payload_b64 =
        URL_SAFE_NO_PAD.encode(serde_json::to_vec(payload).expect("token payload serializes"));
    let signing_input = format!("{header_b64}.{payload_b64}");
    let sig = signing_key.sign(signing_input.as_bytes());
    format!(
        "{signing_input}.{}",
        URL_SAFE_NO_PAD.encode(sig.to_bytes())
    )
}

/// Upper bound on persisted jti entries; expired ones are dropped first.
const MAX_REPLAY_ENTRIES: usize = 512;

/// Shared verification + replay state.
pub struct AuthState {
    verifying_key: VerifyingKey,
    server_id: String,
    /// jti -> exp for tokens that have already executed a tool.
    executed: Mutex<HashMap<String, u64>>,
    /// Optional 0600 file so a restart cannot reopen the 60-second replay
    /// window. None in the demo/serve helpers.
    replay_path: Option<PathBuf>,
}

impl AuthState {
    pub fn new(verifying_key: VerifyingKey, server_id: impl Into<String>) -> Self {
        Self {
            verifying_key,
            server_id: server_id.into(),
            executed: Mutex::new(HashMap::new()),
            replay_path: None,
        }
    }

    /// Like `new`, but persists used jtis so replay protection survives a
    /// restart (systemd restarts, console reboots).
    pub fn with_store(
        verifying_key: VerifyingKey,
        server_id: impl Into<String>,
        replay_path: PathBuf,
    ) -> Self {
        let executed = load_replay(&replay_path);
        Self {
            verifying_key,
            server_id: server_id.into(),
            executed: Mutex::new(executed),
            replay_path: Some(replay_path),
        }
    }

    pub fn server_id(&self) -> &str {
        &self.server_id
    }

    /// Signature, then server binding, then expiry. Replay is checked only when
    /// a tool is about to execute (see [`Self::consume_jti`]) so that the
    /// multi-request MCP handshake can share one token.
    pub fn verify(&self, token: &str) -> Result<TokenPayload, AuthError> {
        let parts: Vec<&str> = token.split('.').collect();
        if parts.len() != 3 {
            return Err(AuthError::Malformed);
        }
        let (header_b64, payload_b64, sig_b64) = (parts[0], parts[1], parts[2]);

        let header_bytes = URL_SAFE_NO_PAD
            .decode(header_b64)
            .map_err(|_| AuthError::Malformed)?;
        let header: TokenHeader =
            serde_json::from_slice(&header_bytes).map_err(|_| AuthError::Malformed)?;
        if header.alg != "EdDSA" {
            return Err(AuthError::Malformed);
        }

        let sig_bytes = URL_SAFE_NO_PAD
            .decode(sig_b64)
            .map_err(|_| AuthError::Malformed)?;
        let sig = Signature::from_slice(&sig_bytes).map_err(|_| AuthError::Malformed)?;
        let signing_input = format!("{header_b64}.{payload_b64}");
        self.verifying_key
            .verify_strict(signing_input.as_bytes(), &sig)
            .map_err(|_| AuthError::BadSignature)?;

        let payload_bytes = URL_SAFE_NO_PAD
            .decode(payload_b64)
            .map_err(|_| AuthError::Malformed)?;
        let payload: TokenPayload =
            serde_json::from_slice(&payload_bytes).map_err(|_| AuthError::Malformed)?;
        if payload.server_id != self.server_id {
            return Err(AuthError::WrongServer);
        }
        if payload.exp <= now_unix() {
            return Err(AuthError::Expired);
        }
        Ok(payload)
    }

    /// Atomically mark this jti as used by a tool execution. The first caller
    /// wins; any later caller gets `Replayed`. The set is persisted (0600,
    /// atomic rename) when a store path was configured.
    pub fn consume_jti(&self, payload: &TokenPayload) -> Result<(), AuthError> {
        let now = now_unix();
        let mut executed = self.executed.lock().expect("replay map poisoned");
        executed.retain(|_, exp| *exp > now);
        if executed.contains_key(&payload.jti) {
            return Err(AuthError::Replayed);
        }
        executed.insert(payload.jti.clone(), payload.exp);
        cap_replay(&mut executed);
        if let Some(path) = &self.replay_path {
            if let Err(e) = persist_replay(path, &executed) {
                tracing::error!(error = %e, "failed to persist the jti replay set");
            }
        }
        Ok(())
    }

    pub fn executed_count(&self) -> usize {
        self.executed.lock().expect("replay map poisoned").len()
    }
}

fn load_replay(path: &Path) -> HashMap<String, u64> {
    let text = match std::fs::read_to_string(path) {
        Ok(text) => text,
        // No file yet: the normal first-run path.
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return HashMap::new(),
        // Anything else means the replay set could not be loaded. Say so — an
        // empty set that nobody noticed lets recent jtis be replayed after a
        // restart.
        Err(e) => {
            tracing::warn!(
                error = %e,
                path = %path.display(),
                "could not load the jti replay set; starting empty"
            );
            return HashMap::new();
        }
    };
    match serde_json::from_str::<HashMap<String, u64>>(&text) {
        Ok(mut map) => {
            let now = now_unix();
            map.retain(|_, exp| *exp > now);
            map
        }
        Err(e) => {
            tracing::warn!(error = %e, path = %path.display(), "ignoring unreadable jti replay file");
            HashMap::new()
        }
    }
}

/// Keep the map bounded: when over the cap, drop the entries that expire
/// soonest (they are the least useful for replay protection).
fn cap_replay(map: &mut HashMap<String, u64>) {
    if map.len() <= MAX_REPLAY_ENTRIES {
        return;
    }
    let mut entries: Vec<(String, u64)> = map.iter().map(|(k, v)| (k.clone(), *v)).collect();
    entries.sort_by_key(|(_, exp)| *exp);
    let excess = entries.len() - MAX_REPLAY_ENTRIES;
    for (jti, _) in entries.into_iter().take(excess) {
        map.remove(&jti);
    }
}

fn persist_replay(path: &Path, map: &HashMap<String, u64>) -> anyhow::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let tmp = path.with_extension("json.tmp");
    let text = serde_json::to_string(map)?;
    {
        use std::io::Write;
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&tmp)?;
        file.write_all(text.as_bytes())?;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600))?;
    }
    std::fs::rename(&tmp, path)?;
    Ok(())
}

pub fn parse_verifying_key_hex(s: &str) -> anyhow::Result<VerifyingKey> {
    let clean: String = s.chars().filter(|c| c.is_ascii_hexdigit()).collect();
    anyhow::ensure!(
        clean.len() == 64,
        "public key must be 64 hex chars, got {}",
        clean.len()
    );
    let mut bytes = [0u8; 32];
    for (i, b) in bytes.iter_mut().enumerate() {
        *b = u8::from_str_radix(&clean[i * 2..i * 2 + 2], 16)?;
    }
    VerifyingKey::from_bytes(&bytes).map_err(|e| anyhow::anyhow!("invalid Ed25519 public key: {e}"))
}

#[derive(Deserialize)]
struct Jwk {
    kty: String,
    crv: String,
    x: String,
}

/// Parse the public JWK the control plane returns as `token_public_key`.
pub fn parse_verifying_key_jwk(json: &str) -> anyhow::Result<VerifyingKey> {
    let jwk: Jwk = serde_json::from_str(json).context("parse Ed25519 JWK")?;
    anyhow::ensure!(
        jwk.kty == "OKP" && jwk.crv == "Ed25519",
        "JWK is not an Ed25519 OKP key"
    );
    let bytes = URL_SAFE_NO_PAD
        .decode(jwk.x.trim())
        .context("decode JWK x")?;
    anyhow::ensure!(
        bytes.len() == 32,
        "JWK x must be 32 bytes, got {}",
        bytes.len()
    );
    let mut arr = [0u8; 32];
    arr.copy_from_slice(&bytes);
    VerifyingKey::from_bytes(&arr).map_err(|e| anyhow::anyhow!("invalid Ed25519 public key: {e}"))
}

pub fn parse_signing_key_hex(s: &str) -> anyhow::Result<SigningKey> {
    let clean: String = s.chars().filter(|c| c.is_ascii_hexdigit()).collect();
    anyhow::ensure!(
        clean.len() == 64,
        "signing key seed must be 64 hex chars, got {}",
        clean.len()
    );
    let mut bytes = [0u8; 32];
    for (i, b) in bytes.iter_mut().enumerate() {
        *b = u8::from_str_radix(&clean[i * 2..i * 2 + 2], 16)?;
    }
    Ok(SigningKey::from_bytes(&bytes))
}

pub fn random_jti() -> String {
    let mut bytes = [0u8; 16];
    rand_core::OsRng.fill_bytes(&mut bytes);
    crate::cert::hex(&bytes)
}

pub fn ttl_now(ttl: Duration) -> u64 {
    now_unix() + ttl.as_secs()
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::SigningKey;
    use rand_core::OsRng;

    fn key() -> SigningKey {
        SigningKey::generate(&mut OsRng)
    }

    #[test]
    fn jwk_parses_and_jwt_verifies() {
        let sk = key();
        let jwk = format!(
            r#"{{"kty":"OKP","crv":"Ed25519","x":"{}"}}"#,
            URL_SAFE_NO_PAD.encode(sk.verifying_key().as_bytes())
        );
        let vk = parse_verifying_key_jwk(&jwk).unwrap();
        assert_eq!(vk, sk.verifying_key());
        let auth = AuthState::new(vk, "srv_1");
        let token = mint_token(&sk, "srv_1", "j1", now_unix() + 60);
        assert_eq!(token.split('.').count(), 3);
        let header = URL_SAFE_NO_PAD
            .decode(token.split('.').next().unwrap())
            .unwrap();
        let header: serde_json::Value = serde_json::from_slice(&header).unwrap();
        assert_eq!(header["alg"], "EdDSA");
        assert_eq!(auth.verify(&token).unwrap().jti, "j1");
    }

    #[test]
    fn tampering_with_the_payload_breaks_the_signature() {
        let sk = key();
        let auth = AuthState::new(sk.verifying_key(), "srv_1");
        let token = mint_token(&sk, "srv_1", "j1", now_unix() + 60);
        let mut parts: Vec<&str> = token.split('.').collect();
        parts[1] = "eyJzZXJ2ZXJfaWQiOiJzcnZfMiJ9"; // {"server_id":"srv_2"}
        assert_eq!(
            auth.verify(&parts.join(".")),
            Err(AuthError::BadSignature)
        );
    }

    #[test]
    fn rejects_alg_none() {
        let sk = key();
        let auth = AuthState::new(sk.verifying_key(), "srv_1");
        let token = mint_token(&sk, "srv_1", "j1", now_unix() + 60);
        let mut parts: Vec<&str> = token.split('.').collect();
        parts[0] = "eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0"; // alg=none
        assert_eq!(auth.verify(&parts.join(".")), Err(AuthError::Malformed));
    }

    #[test]
    fn roundtrip_and_expiry() {
        let sk = key();
        let auth = AuthState::new(sk.verifying_key(), "srv_1");
        let t = mint_token(&sk, "srv_1", "j1", now_unix() + 60);
        assert_eq!(auth.verify(&t).unwrap().jti, "j1");

        let expired = mint_token(&sk, "srv_1", "j2", now_unix().saturating_sub(1));
        assert_eq!(auth.verify(&expired), Err(AuthError::Expired));
    }

    #[test]
    fn wrong_server_and_signature() {
        let sk = key();
        let auth = AuthState::new(sk.verifying_key(), "srv_1");
        let other = mint_token(&key(), "srv_1", "j1", now_unix() + 60);
        assert_eq!(auth.verify(&other), Err(AuthError::BadSignature));
        let wrong = mint_token(&sk, "srv_2", "j1", now_unix() + 60);
        assert_eq!(auth.verify(&wrong), Err(AuthError::WrongServer));
    }

    #[test]
    fn jti_is_consumed_once() {
        let sk = key();
        let auth = AuthState::new(sk.verifying_key(), "srv_1");
        let p = auth
            .verify(&mint_token(&sk, "srv_1", "j1", now_unix() + 60))
            .unwrap();
        assert!(auth.consume_jti(&p).is_ok());
        assert_eq!(auth.consume_jti(&p), Err(AuthError::Replayed));
    }

    fn tmpdir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "veyl-agent-auth-{name}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .subsec_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn a_missing_or_unreadable_replay_file_starts_empty() {
        let dir = tmpdir("replay-load");

        // Missing: the normal first-run path, no file at all.
        assert!(load_replay(&dir.join("absent.json")).is_empty());

        // Unreadable for another reason: a path under a regular file. It still
        // yields an empty set — there is nothing else to do — but the failure
        // is logged instead of passing as "no replay entries yet".
        let blocker = dir.join("blocker");
        std::fs::write(&blocker, b"x").unwrap();
        assert!(load_replay(&blocker.join("jti.json")).is_empty());

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn jti_replay_survives_a_restart() {
        let dir = tmpdir("restart");
        let path = dir.join("jtis.json");
        let sk = key();
        let token = mint_token(&sk, "srv_1", "j1", now_unix() + 60);

        {
            let auth = AuthState::with_store(sk.verifying_key(), "srv_1", path.clone());
            let p = auth.verify(&token).unwrap();
            auth.consume_jti(&p).unwrap();
        }
        // A new process would load the same file.
        let auth = AuthState::with_store(sk.verifying_key(), "srv_1", path.clone());
        let p = auth.verify(&token).unwrap();
        assert_eq!(auth.consume_jti(&p), Err(AuthError::Replayed));

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
        }
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn expired_jtis_are_not_loaded_back() {
        let dir = tmpdir("expired");
        let path = dir.join("jtis.json");
        std::fs::write(
            &path,
            format!(r#"{{"old":{},"live":{}}}"#, now_unix() - 1, now_unix() + 60),
        )
        .unwrap();
        let auth = AuthState::with_store(key().verifying_key(), "srv_1", path);
        assert_eq!(auth.executed_count(), 1);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn replay_set_is_capped() {
        let mut map = HashMap::new();
        for i in 0..MAX_REPLAY_ENTRIES + 50 {
            map.insert(format!("j{i}"), now_unix() + i as u64);
        }
        cap_replay(&mut map);
        assert_eq!(map.len(), MAX_REPLAY_ENTRIES);
        // The soonest-to-expire entries were dropped first.
        assert!(!map.contains_key("j0"));
        assert!(map.contains_key(&format!("j{}", MAX_REPLAY_ENTRIES + 49)));
    }
}
