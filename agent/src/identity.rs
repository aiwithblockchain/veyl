//! Runtime TLS identity: leaf fingerprint, root PEM, the dynamic Host
//! allow-list, and whether the leaf on disk is still the one the control plane
//! issued for this node.
//!
//! Nothing here signs a certificate. A missing, stale or expiring leaf is
//! reported by [`Identity::needs_new_cert`]; the run loop asks the control
//! plane and then calls [`Identity::install_issued`].

use std::net::IpAddr;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::RwLock;

use anyhow::{Context, Result};

use crate::cert::{self, CertPaths, LeafRequest};

#[derive(Debug, Clone)]
pub struct IdentitySnapshot {
    pub leaf_fingerprint: String,
    pub public_host: Option<String>,
    /// Host header allow-list (configured hosts included).
    pub allowed_hosts: Vec<String>,
    /// Hosts the leaf must cover: localhost, 127.0.0.1 and the public IP.
    pub cert_hosts: Vec<String>,
}

/// Which kind of leaf the node has, as `get_status` reports it. `cert: null`
/// alone could not tell "still self-signed" from "files destroyed", and a lost
/// migration marker is not the same incident as a node that never migrated.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CertState {
    /// Intact pair signed by the root in `ca-cert.pem`, covering today's hosts.
    Current,
    /// Files missing, corrupt, or not a key pair.
    Broken,
    /// The old per-node CA (`CN=Veyl Node Agent CA`) signed this leaf: a node
    /// installed before the shared root. Its migration is expected and cannot
    /// fail. The leaf itself is never self-signed.
    Legacy,
    /// Not the old per-node CA and not current (the root marker was lost or the
    /// root changed). Needs a new leaf before it can be trusted.
    Stale,
}

impl CertState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Current => "current",
            Self::Broken => "broken",
            Self::Legacy => "legacy",
            Self::Stale => "stale",
        }
    }
}

pub struct Identity {
    dir: PathBuf,
    certs: CertPaths,
    static_hosts: Vec<String>,
    ca_pem: RwLock<String>,
    snapshot: RwLock<IdentitySnapshot>,
    /// Consecutive failed replacement rounds; reset by a successful install.
    /// Diagnostic only, never persisted (`agent-health.md` §3.5).
    renewal_failures: AtomicU64,
    last_renewal_error: RwLock<Option<String>>,
}

impl Identity {
    /// Load whatever is on disk. It deliberately does not create certificates:
    /// production nodes are signed by the control plane, and a node without a
    /// leaf has to wait for one (contract §4).
    ///
    /// `public_host` is the address clients use. When it is missing, the
    /// previous leaf's addresses are kept so a restart during a metadata outage
    /// does not drop the IP.
    pub fn load(dir: &Path, static_hosts: &[String], public_host: Option<String>) -> Result<Self> {
        // An install killed mid-way leaves a backup behind; put the working
        // pair back before deciding anything from what is on disk. A backup
        // whose current pair is already fine is stale and gets discarded.
        match cert::recover_interrupted_install(dir) {
            Ok(true) => {
                tracing::warn!("restored the certificate pair from an interrupted install")
            }
            Ok(false) => {}
            Err(e) => tracing::error!(
                error = %e,
                "could not restore the certificate pair from an interrupted install"
            ),
        }
        let extras: Vec<String> = match &public_host {
            Some(host) => vec![host.clone()],
            None => cert::previous_extra_hosts(dir)
                .unwrap_or_default()
                .into_iter()
                .filter(|host| host.parse::<IpAddr>().is_ok())
                .collect(),
        };
        let cert_hosts = cert::canonical_hosts(&extras);
        let certs = cert::paths(dir);
        let ca_pem = std::fs::read_to_string(&certs.ca_cert).unwrap_or_default();
        let leaf_fingerprint = cert::leaf_fingerprint(&certs.leaf_cert).unwrap_or_default();
        let allowed_hosts = build_allowed_hosts(static_hosts, public_host.as_deref());
        Ok(Self {
            dir: dir.to_path_buf(),
            certs,
            static_hosts: static_hosts.to_vec(),
            ca_pem: RwLock::new(ca_pem),
            snapshot: RwLock::new(IdentitySnapshot {
                leaf_fingerprint,
                public_host,
                allowed_hosts,
                cert_hosts,
            }),
            renewal_failures: AtomicU64::new(0),
            last_renewal_error: RwLock::new(None),
        })
    }

    pub fn certs(&self) -> &CertPaths {
        &self.certs
    }

    pub fn snapshot(&self) -> IdentitySnapshot {
        self.snapshot.read().expect("identity poisoned").clone()
    }

    pub fn leaf_fingerprint(&self) -> String {
        self.snapshot
            .read()
            .expect("identity poisoned")
            .leaf_fingerprint
            .clone()
    }

    pub fn public_host(&self) -> Option<String> {
        self.snapshot
            .read()
            .expect("identity poisoned")
            .public_host
            .clone()
    }

    pub fn ca_pem(&self) -> String {
        self.ca_pem.read().expect("ca_pem poisoned").clone()
    }

    /// Hosts the next CSR must cover (contract §4: localhost, 127.0.0.1, the
    /// public IP; configured domains are never requested).
    pub fn cert_hosts(&self) -> Vec<String> {
        self.snapshot
            .read()
            .expect("identity poisoned")
            .cert_hosts
            .clone()
    }

    pub fn leaf_state(&self) -> cert::LeafState {
        cert::inspect(&self.dir, &self.cert_hosts())
    }

    /// A leaf that can be served right now, even if it still needs replacing.
    pub fn servable(&self) -> bool {
        self.leaf_state().servable()
    }

    /// Remaining lifetime is under 30 days (contract §3).
    pub fn renewal_due(&self) -> bool {
        self.leaf_state()
            .renewal_due(crate::auth::now_unix() as i64)
    }

    /// The leaf must be replaced: not signed by the current root, files
    /// incomplete, SANs changed, or inside the renewal window.
    pub fn needs_new_cert(&self) -> bool {
        let state = self.leaf_state();
        !state.is_current() || state.renewal_due(crate::auth::now_unix() as i64)
    }

    /// Which kind of leaf is on disk, for `get_status` (`cert_state`). A
    /// certificate that covers today's hosts is `current` even when the SAN
    /// marker lags; whether to re-issue is `needs_new_cert`'s call.
    pub fn cert_state(&self) -> CertState {
        let state = self.leaf_state();
        if state.files_ok && state.issued_by_current_root && state.hosts_cover {
            CertState::Current
        } else if !state.files_ok {
            CertState::Broken
        } else if state.legacy_ca {
            CertState::Legacy
        } else {
            CertState::Stale
        }
    }

    /// `not_after` of a leaf the current root issued, or `None` for a legacy
    /// self-signed pair. `get_status` renders a null `cert` block in that case
    /// (`agent-health.md` §3.3).
    pub fn cert_not_after(&self) -> Option<i64> {
        let state = self.leaf_state();
        if state.files_ok && state.issued_by_current_root {
            state.not_after
        } else {
            None
        }
    }

    pub fn renewal_failures(&self) -> u64 {
        self.renewal_failures.load(Ordering::Relaxed)
    }

    pub fn last_renewal_error(&self) -> Option<String> {
        self.last_renewal_error
            .read()
            .expect("renewal error poisoned")
            .clone()
    }

    pub fn record_renewal_success(&self) {
        self.renewal_failures.store(0, Ordering::Relaxed);
        *self
            .last_renewal_error
            .write()
            .expect("renewal error poisoned") = None;
    }

    /// Count a failed replacement round and keep its redacted cause for
    /// `get_status`; the value is diagnostic only and never persisted.
    pub fn record_renewal_failure(&self, error: &str) {
        self.renewal_failures.fetch_add(1, Ordering::Relaxed);
        *self
            .last_renewal_error
            .write()
            .expect("renewal error poisoned") = Some(crate::logging::truncate(
            &crate::logging::redact_sensitive(error),
            300,
        ));
    }

    /// Record an address discovered after startup. Returns true when the leaf's
    /// host list changed, i.e. the certificate has to be re-issued.
    pub fn note_public_host(&self, ip: &str) -> bool {
        let mut snapshot = self.snapshot.write().expect("identity poisoned");
        if snapshot.public_host.as_deref() == Some(ip) {
            return false;
        }
        let cert_hosts = cert::canonical_hosts(&[ip.to_string()]);
        let changed = cert_hosts != snapshot.cert_hosts;
        snapshot.public_host = Some(ip.to_string());
        snapshot.cert_hosts = cert_hosts;
        snapshot.allowed_hosts = build_allowed_hosts(&self.static_hosts, Some(ip));
        changed
    }

    /// Persist a leaf the control plane just issued and start serving it. The
    /// TLS acceptor cache reloads on the fingerprint change.
    pub fn install_issued(
        &self,
        req: &LeafRequest,
        cert_pem: &str,
        ca_pem: &str,
        not_after: Option<i64>,
    ) -> Result<()> {
        cert::install_leaf(&self.dir, req, cert_pem, ca_pem, not_after)?;
        self.reload()
    }

    /// Re-read the root and leaf from disk.
    pub fn reload(&self) -> Result<()> {
        let ca_pem = std::fs::read_to_string(&self.certs.ca_cert)
            .with_context(|| format!("read {}", self.certs.ca_cert.display()))?;
        let leaf_fingerprint = cert::leaf_fingerprint(&self.certs.leaf_cert)?;
        *self.ca_pem.write().expect("ca_pem poisoned") = ca_pem;
        self.snapshot
            .write()
            .expect("identity poisoned")
            .leaf_fingerprint = leaf_fingerprint;
        Ok(())
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
    fn a_node_without_certificates_waits_for_the_control_plane() {
        let dir = tmpdir("empty");
        let identity = Identity::load(&dir, &[], None).unwrap();
        assert_eq!(identity.leaf_fingerprint(), "");
        assert!(!identity.servable());
        assert!(identity.needs_new_cert());
        assert!(!identity.renewal_due());
        assert!(
            std::fs::read_dir(&dir).unwrap().next().is_none(),
            "load writes nothing"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_dev_leaf_is_current_and_renewal_is_not_due() {
        let dir = tmpdir("current");
        cert::ensure_dev_certs(&dir, &[]).unwrap();
        let identity = Identity::load(&dir, &[], None).unwrap();
        assert!(identity.servable());
        assert!(!identity.needs_new_cert());
        assert!(!identity.renewal_due());
        assert!(identity.ca_pem().contains("BEGIN CERTIFICATE"));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_legacy_leaf_needs_replacing_but_stays_servable() {
        let dir = tmpdir("legacy");
        cert::ensure_dev_certs(&dir, &[]).unwrap();
        std::fs::remove_file(cert::paths(&dir).leaf_meta).unwrap();

        let identity = Identity::load(&dir, &[], None).unwrap();
        assert!(identity.servable());
        assert!(identity.needs_new_cert());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_late_public_ip_changes_the_host_list_and_the_allow_list() {
        let dir = tmpdir("late-ip");
        cert::ensure_dev_certs(&dir, &[]).unwrap();
        let identity = Identity::load(&dir, &[], None).unwrap();
        assert!(!identity.host_allowed(Some("203.0.113.7:32100")));

        assert!(identity.note_public_host("203.0.113.7"));
        assert!(identity.host_allowed(Some("203.0.113.7:32100")));
        assert!(
            identity.needs_new_cert(),
            "the new address must trigger a re-issue"
        );
        assert!(!identity.note_public_host("203.0.113.7"));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn renewal_failures_are_counted_redacted_and_cleared() {
        let dir = tmpdir("renewal-counters");
        let identity = Identity::load(&dir, &[], None).unwrap();
        assert_eq!(identity.renewal_failures(), 0);
        assert_eq!(identity.last_renewal_error(), None);

        identity.record_renewal_failure("GET failed: token agt_ABC123 password=hunter2");
        identity.record_renewal_failure(&"x".repeat(500));
        assert_eq!(identity.renewal_failures(), 2);
        let last = identity.last_renewal_error().unwrap();
        assert!(last.chars().count() <= 301, "truncated with an ellipsis");
        assert!(!last.contains("agt_ABC123"));
        assert!(!last.contains("hunter2"));

        identity.record_renewal_success();
        assert_eq!(identity.renewal_failures(), 0);
        assert_eq!(identity.last_renewal_error(), None);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn cert_not_after_requires_the_current_root() {
        let dir = tmpdir("cert-not-after");
        cert::ensure_dev_certs(&dir, &[]).unwrap();
        let identity = Identity::load(&dir, &[], None).unwrap();
        assert!(identity.cert_not_after().is_some());

        std::fs::write(
            cert::paths(&dir).leaf_meta,
            r#"{"root_fingerprint":"nope","not_after":1955000000}"#,
        )
        .unwrap();
        assert_eq!(identity.cert_not_after(), None);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn cert_state_distinguishes_current_stale_and_broken() {
        let dir = tmpdir("cert-state");
        cert::ensure_dev_certs(&dir, &[]).unwrap();
        let identity = Identity::load(&dir, &[], None).unwrap();
        assert_eq!(identity.cert_state(), CertState::Current);

        // The dev leaf is signed by a dev root, not self-signed: losing its
        // marker leaves a state that needs a new leaf, not a plan to migrate.
        std::fs::remove_file(cert::paths(&dir).leaf_meta).unwrap();
        assert_eq!(identity.cert_state(), CertState::Stale);

        // A destroyed key makes the pair unparseable, whatever the marker says.
        std::fs::write(cert::paths(&dir).leaf_key, "not a private key").unwrap();
        assert_eq!(identity.cert_state(), CertState::Broken);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn cert_state_is_legacy_for_the_old_per_node_ca() {
        let dir = tmpdir("legacy-ca");
        cert::install_legacy_leaf(&dir, &[]).unwrap();
        let identity = Identity::load(&dir, &[], None).unwrap();
        assert_eq!(
            identity.cert_state(),
            CertState::Legacy,
            "a node installed before the shared root has an expected migration"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn cert_state_is_current_while_the_san_marker_lags() {
        let dir = tmpdir("lagging-current");
        cert::ensure_dev_certs(&dir, &["203.0.113.7".to_string()]).unwrap();
        // The certificate covers the IP; only the marker forgot it.
        std::fs::write(cert::paths(&dir).leaf_sans, r#"["localhost","127.0.0.1"]"#).unwrap();
        let identity = Identity::load(&dir, &[], Some("203.0.113.7".to_string())).unwrap();

        assert_eq!(identity.cert_state(), CertState::Current);
        assert!(
            identity.needs_new_cert(),
            "the lagging marker still asks for a re-issue"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn cert_not_after_is_none_when_the_key_is_missing() {
        let dir = tmpdir("cert-not-after-broken");
        cert::ensure_dev_certs(&dir, &[]).unwrap();
        let identity = Identity::load(&dir, &[], None).unwrap();
        std::fs::remove_file(cert::paths(&dir).leaf_key).unwrap();

        // The certificate itself still matches the root, but without its key
        // nothing can be served, so no expiry may be advertised.
        assert!(identity.leaf_state().issued_by_current_root);
        assert_eq!(identity.cert_not_after(), None);
        assert_eq!(identity.cert_state(), CertState::Broken);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn load_restores_a_pair_left_broken_by_an_interrupted_install() {
        let dir = tmpdir("interrupted-install");
        cert::ensure_dev_certs(&dir, &[]).unwrap();
        let before = Identity::load(&dir, &[], None).unwrap().leaf_fingerprint();

        // A crash after the backup was taken and the key was replaced.
        cert::take_backup(&dir).unwrap();
        std::fs::write(cert::paths(&dir).leaf_key, "not a private key").unwrap();
        assert!(!cert::inspect(&dir, &[]).files_ok);

        let identity = Identity::load(&dir, &[], None).unwrap();
        assert_eq!(
            identity.leaf_fingerprint(),
            before,
            "the pair from before the interrupted install is back"
        );
        assert!(identity.servable());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn installing_an_issued_leaf_switches_the_fingerprint_and_root() {
        let dir = tmpdir("install");
        cert::ensure_dev_certs(&dir, &[]).unwrap();
        let identity = Identity::load(&dir, &[], None).unwrap();
        let before = identity.leaf_fingerprint();

        // A second issued pair: new key, new root, same host list.
        let hosts = identity.cert_hosts();
        let req = cert::request_leaf(&hosts).unwrap();
        let (cert_pem, ca_pem) = cert::dev_sign(&req).unwrap();
        identity
            .install_issued(&req, &cert_pem, &ca_pem, None)
            .unwrap();

        assert_ne!(identity.leaf_fingerprint(), before);
        assert!(!identity.needs_new_cert());
        std::fs::remove_dir_all(&dir).ok();
    }
}
