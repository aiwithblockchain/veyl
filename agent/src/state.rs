//! Persistent agent state: identity, long-lived server token, recently used
//! ports. Written atomically with mode 0600; the token never appears in logs.

use std::fmt;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

use crate::control::DesiredState;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PendingRotation {
    pub port: u16,
    pub at_unix: u64,
}

/// Last desired state the control plane handed out. Persisted (0600) because the
/// password appears only in the enroll response and the latest desired-state
/// fetch; keeping it lets a restart survive a control-plane outage. Never logged.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StoredDesired {
    pub port: u16,
    pub password: String,
    pub control_port: u16,
    pub singbox_version: String,
    pub singbox_sha256: String,
    pub singbox_url: String,
    pub at_unix: u64,
}

impl StoredDesired {
    pub fn from_desired(desired: &DesiredState, at_unix: u64) -> Self {
        Self {
            port: desired.port,
            password: desired.password.clone(),
            control_port: desired.control_port,
            singbox_version: desired.singbox.version.clone(),
            singbox_sha256: desired.singbox.sha256.clone(),
            singbox_url: desired.singbox.url.clone(),
            at_unix,
        }
    }

    pub fn to_desired(&self) -> DesiredState {
        DesiredState {
            port: self.port,
            password: self.password.clone(),
            control_port: self.control_port,
            singbox: crate::control::SingBoxDesired {
                version: self.singbox_version.clone(),
                sha256: self.singbox_sha256.clone(),
                url: self.singbox_url.clone(),
            },
        }
    }
}

impl fmt::Debug for StoredDesired {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("StoredDesired")
            .field("port", &self.port)
            .field("password", &"***")
            .field("control_port", &self.control_port)
            .field("singbox_version", &self.singbox_version)
            .field("at_unix", &self.at_unix)
            .finish()
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct AgentState {
    #[serde(default)]
    pub server_id: Option<String>,
    #[serde(default)]
    pub server_token: Option<String>,
    #[serde(default)]
    pub recent_ports: Vec<u16>,
    #[serde(default)]
    pub applied_port: Option<u16>,
    #[serde(default)]
    pub cert_fingerprint: Option<String>,
    /// Public JWK returned by enroll; used to verify desktop tokens offline
    /// after a restart.
    #[serde(default)]
    pub agent_token_public_key: Option<String>,
    /// Set after a rotation until the control plane's desired state reflects it.
    /// Prevents the poll loop from undoing a just-applied port change.
    #[serde(default)]
    pub pending_rotation: Option<PendingRotation>,
    /// Last applied credentials, including the password (0600 file).
    #[serde(default)]
    pub last_desired: Option<StoredDesired>,
    /// Set when an `active` report failed; the poll loop keeps re-reporting so
    /// an installing/verifying node is not swept while it is serving fine.
    #[serde(default)]
    pub active_unconfirmed: bool,
}

impl AgentState {
    pub fn remember_port(&mut self, port: u16, keep: usize) {
        self.recent_ports.retain(|p| *p != port);
        self.recent_ports.push(port);
        if self.recent_ports.len() > keep {
            let drop = self.recent_ports.len() - keep;
            self.recent_ports.drain(0..drop);
        }
        self.applied_port = Some(port);
    }
}

#[derive(Debug, Clone)]
pub struct StateStore {
    path: PathBuf,
}

impl StateStore {
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self { path: path.into() }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn load(&self) -> Result<AgentState> {
        match std::fs::read_to_string(&self.path) {
            Ok(text) => serde_json::from_str(&text)
                .with_context(|| format!("parse state {}", self.path.display())),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(AgentState::default()),
            Err(e) => Err(e).with_context(|| format!("read state {}", self.path.display())),
        }
    }

    pub fn save(&self, state: &AgentState) -> Result<()> {
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("create state dir {}", parent.display()))?;
        }
        let tmp = self.path.with_extension("json.tmp");
        let text = serde_json::to_string_pretty(state)?;
        {
            use std::io::Write;
            let mut options = std::fs::OpenOptions::new();
            options.write(true).create(true).truncate(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            let mut file = options
                .open(&tmp)
                .with_context(|| format!("create {}", tmp.display()))?;
            file.write_all(text.as_bytes())
                .with_context(|| format!("write {}", tmp.display()))?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600))
                    .with_context(|| format!("chmod 600 {}", tmp.display()))?;
            }
        }
        std::fs::rename(&tmp, &self.path)
            .with_context(|| format!("rename {} -> {}", tmp.display(), self.path.display()))?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmpdir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "veyl-agent-state-{name}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .subsec_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn missing_state_is_empty_and_roundtrips() {
        let dir = tmpdir("roundtrip");
        let store = StateStore::new(dir.join("state.json"));
        assert_eq!(store.load().unwrap(), AgentState::default());

        let mut state = AgentState {
            server_id: Some("srv_1".into()),
            server_token: Some("agt_secret".into()),
            cert_fingerprint: Some("aa".into()),
            last_desired: Some(StoredDesired {
                port: 30412,
                password: "secret-password".into(),
                control_port: 32100,
                singbox_version: "1.14.4".into(),
                singbox_sha256: "sha".into(),
                singbox_url: "https://example.com/sb.tar.gz".into(),
                at_unix: 1,
            }),
            ..Default::default()
        };
        state.remember_port(30412, 2);
        state.remember_port(30413, 2);
        store.save(&state).unwrap();

        let loaded = store.load().unwrap();
        assert_eq!(loaded, state);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(store.path()).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
        }
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn recent_ports_are_deduped_and_bounded() {
        let mut state = AgentState::default();
        for port in [30001, 30002, 30001, 30003] {
            state.remember_port(port, 2);
        }
        assert_eq!(state.recent_ports, vec![30001, 30003]);
        assert_eq!(state.applied_port, Some(30003));
    }

    #[test]
    fn stored_desired_roundtrips_without_leaking_in_debug() {
        let desired = crate::control::DesiredState {
            port: 30412,
            password: "hunter2".into(),
            control_port: 32100,
            singbox: crate::control::SingBoxDesired {
                version: "1.14.4".into(),
                sha256: "abc".into(),
                url: "https://example.com/sb.tar.gz".into(),
            },
        };
        let stored = StoredDesired::from_desired(&desired, 42);
        assert_eq!(stored.to_desired(), desired);
        let debug = format!("{stored:?}");
        assert!(!debug.contains("hunter2"));
        assert!(debug.contains("30412"));

        let json = serde_json::to_string(&stored).unwrap();
        let back: StoredDesired = serde_json::from_str(&json).unwrap();
        assert_eq!(back, stored);
    }
}
