//! Runtime TLS identity: leaf fingerprint, CA PEM, and the dynamic Host
//! allow-list. When the public IP was unknown at startup, the poll loop can
//! retry detection and re-sign the leaf without restarting the agent.

use std::path::{Path, PathBuf};
use std::sync::RwLock;

use anyhow::{Context, Result};

use crate::cert::{self, CertPaths};

#[derive(Debug, Clone)]
pub struct IdentitySnapshot {
    pub leaf_fingerprint: String,
    pub public_host: Option<String>,
    pub allowed_hosts: Vec<String>,
}

pub struct Identity {
    dir: PathBuf,
    certs: CertPaths,
    static_hosts: Vec<String>,
    ca_pem: String,
    snapshot: RwLock<IdentitySnapshot>,
}

impl Identity {
    /// Load or generate the CA/leaf. `public_host` is the address clients will
    /// use; when it is missing, the previous leaf's SANs are kept so a restart
    /// during a metadata outage does not drop the IP.
    pub fn load(
        dir: &Path,
        static_hosts: &[String],
        public_host: Option<String>,
    ) -> Result<Self> {
        let mut extras: Vec<String> = static_hosts.to_vec();
        if let Some(host) = &public_host {
            extras.push(host.clone());
        } else if let Some(previous) = cert::previous_extra_hosts(dir) {
            extras.extend(previous);
        }
        let certs = cert::ensure_certs_with_hosts(dir, &extras)?;
        let leaf_fingerprint = cert::leaf_fingerprint(&certs.leaf_cert)?;
        let ca_pem = std::fs::read_to_string(&certs.ca_cert)
            .with_context(|| format!("read {}", certs.ca_cert.display()))?;
        let allowed_hosts = build_allowed_hosts(static_hosts, public_host.as_deref());
        Ok(Self {
            dir: dir.to_path_buf(),
            certs,
            static_hosts: static_hosts.to_vec(),
            ca_pem,
            snapshot: RwLock::new(IdentitySnapshot {
                leaf_fingerprint,
                public_host,
                allowed_hosts,
            }),
        })
    }

    pub fn certs(&self) -> &CertPaths {
        &self.certs
    }

    pub fn snapshot(&self) -> IdentitySnapshot {
        self.snapshot.read().expect("identity poisoned").clone()
    }

    pub fn leaf_fingerprint(&self) -> String {
        self.snapshot.read().expect("identity poisoned").leaf_fingerprint.clone()
    }

    pub fn public_host(&self) -> Option<String> {
        self.snapshot.read().expect("identity poisoned").public_host.clone()
    }

    pub fn ca_pem(&self) -> String {
        self.ca_pem.clone()
    }

    /// Re-sign the leaf with `ip` added, if it is not already the public host.
    /// Returns true when the certificate (and fingerprint) changed.
    pub fn set_public_host(&self, ip: &str) -> Result<bool> {
        {
            let snapshot = self.snapshot.read().expect("identity poisoned");
            if snapshot.public_host.as_deref() == Some(ip) {
                return Ok(false);
            }
        }
        let mut extras = self.static_hosts.clone();
        extras.push(ip.to_string());
        let certs = cert::ensure_certs_with_hosts(&self.dir, &extras)?;
        let leaf_fingerprint = cert::leaf_fingerprint(&certs.leaf_cert)?;
        let allowed_hosts = build_allowed_hosts(&self.static_hosts, Some(ip));
        let mut snapshot = self.snapshot.write().expect("identity poisoned");
        snapshot.leaf_fingerprint = leaf_fingerprint;
        snapshot.public_host = Some(ip.to_string());
        snapshot.allowed_hosts = allowed_hosts;
        Ok(true)
    }

    /// Dynamic Host-header allow-list check. rmcp's static check is disabled;
    /// this one can learn the public IP later.
    pub fn host_allowed(&self, host_header: Option<&str>) -> bool {
        let Some(raw) = host_header else {
            return false;
        };
        let host = strip_port(raw);
        let snapshot = self.snapshot.read().expect("identity poisoned");
        snapshot
            .allowed_hosts
            .iter()
            .any(|allowed| strip_port(allowed).eq_ignore_ascii_case(host))
    }
}

fn build_allowed_hosts(static_hosts: &[String], public_host: Option<&str>) -> Vec<String> {
    let mut hosts = vec![
        "localhost".to_string(),
        "127.0.0.1".to_string(),
        "::1".to_string(),
    ];
    hosts.extend(static_hosts.iter().cloned());
    if let Some(host) = public_host {
        hosts.push(host.to_string());
    }
    let mut seen = std::collections::BTreeSet::new();
    hosts.retain(|h| !h.trim().is_empty() && seen.insert(h.to_ascii_lowercase()));
    hosts
}

fn strip_port(value: &str) -> &str {
    if let Some(rest) = value.strip_prefix('[') {
        if let Some((host, _)) = rest.split_once(']') {
            return host;
        }
    }
    match value.rsplit_once(':') {
        Some((host, port))
            if !host.contains(':') && !port.is_empty() && port.chars().all(|c| c.is_ascii_digit()) =>
        {
            host
        }
        _ => value,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmpdir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "veyl-agent-identity-{name}-{}-{}",
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
    fn host_allow_list_accepts_ports_and_localhost() {
        let dir = tmpdir("hosts");
        let identity = Identity::load(&dir, &["node.example.com".into()], Some("203.0.113.7".into()))
            .unwrap();
        assert!(identity.host_allowed(Some("127.0.0.1:32100")));
        assert!(identity.host_allowed(Some("localhost")));
        assert!(identity.host_allowed(Some("203.0.113.7:32100")));
        assert!(identity.host_allowed(Some("node.example.com:9443")));
        assert!(!identity.host_allowed(Some("evil.example.com")));
        assert!(!identity.host_allowed(None));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn set_public_host_resigns_only_once() {
        let dir = tmpdir("resign");
        let identity = Identity::load(&dir, &[], None).unwrap();
        let before = identity.leaf_fingerprint();
        assert!(!identity.host_allowed(Some("203.0.113.7:32100")));

        assert!(identity.set_public_host("203.0.113.7").unwrap());
        let after = identity.leaf_fingerprint();
        assert_ne!(before, after);
        assert!(identity.host_allowed(Some("203.0.113.7:32100")));
        assert!(!identity.set_public_host("203.0.113.7").unwrap());
        std::fs::remove_dir_all(&dir).ok();
    }
}
