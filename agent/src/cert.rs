//! Node TLS material: an ECDSA P-256 key and CSR generated locally, a leaf
//! signed by the control plane's shared root. No CA or CA key is created here —
//! the root private key must never reach a node
//! (`docs/design/agent-signing-contract.md` §1–§4).

use std::net::IpAddr;
use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};
use base64::Engine as _;
#[cfg(any(test, feature = "dev"))]
use rcgen::{BasicConstraints, ExtendedKeyUsagePurpose, IsCa, Issuer, KeyUsagePurpose};
use rcgen::{CertificateParams, DnType, KeyPair, PublicKeyData, SanType};
use rustls::pki_types::{
    CertificateDer, PrivateKeyDer, PrivatePkcs1KeyDer, PrivatePkcs8KeyDer, PrivateSec1KeyDer,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// Start renewing once the leaf has less than this left (contract §3).
pub const RENEWAL_WINDOW_SECS: i64 = 30 * 24 * 60 * 60;

#[derive(Debug, Clone)]
pub struct CertPaths {
    /// The control plane's root, not a node-local CA.
    pub ca_cert: PathBuf,
    pub leaf_cert: PathBuf,
    pub leaf_key: PathBuf,
    pub leaf_meta: PathBuf,
    pub leaf_sans: PathBuf,
}

pub fn paths(dir: &Path) -> CertPaths {
    CertPaths {
        ca_cert: dir.join("ca-cert.pem"),
        leaf_cert: dir.join("leaf-cert.pem"),
        leaf_key: dir.join("leaf-key.pem"),
        leaf_meta: dir.join("leaf-meta.json"),
        leaf_sans: dir.join("leaf-sans.json"),
    }
}

/// What the control plane issued, recorded next to the files. Its presence is
/// what tells a migrated node apart from one still on its old self-signed pair.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LeafMeta {
    /// SHA-256 (hex) of the root certificate's DER. The leaf is trusted by the
    /// current root only when this equals the local `ca-cert.pem`.
    pub root_fingerprint: String,
    /// Unix seconds.
    pub not_after: i64,
}

/// The key and CSR for one request. The private key stays in memory until the
/// control plane has issued the certificate, so a failed request cannot damage
/// a leaf that still works.
#[derive(Debug)]
pub struct LeafRequest {
    key_pem: String,
    csr_b64: String,
    hosts: Vec<String>,
}

impl LeafRequest {
    /// Standard base64 of the DER CSR; the control plane takes no PEM here.
    pub fn csr_b64(&self) -> &str {
        &self.csr_b64
    }

    pub fn hosts(&self) -> &[String] {
        &self.hosts
    }

    fn key_pair(&self) -> Result<KeyPair> {
        KeyPair::from_pem(&self.key_pem).context("parse the pending private key")
    }
}

/// Write via `*.tmp` + fsync + rename: a crash never leaves a truncated file
/// where the previous readable one used to be.
fn write_atomic(path: &Path, contents: &str, mode: u32) -> Result<()> {
    use std::io::Write;
    let tmp = path.with_extension("tmp");
    {
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(mode);
        }
        let mut file = options
            .open(&tmp)
            .with_context(|| format!("create {}", tmp.display()))?;
        file.write_all(contents.as_bytes())
            .with_context(|| format!("write {}", tmp.display()))?;
        file.sync_all()
            .with_context(|| format!("fsync {}", tmp.display()))?;
    }
    std::fs::rename(&tmp, path)
        .with_context(|| format!("rename {} -> {}", tmp.display(), path.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode))
            .with_context(|| format!("chmod {mode:o} {}", path.display()))?;
    }
    Ok(())
}

fn write_secret(path: &Path, contents: &str) -> Result<()> {
    write_atomic(path, contents, 0o600)
}

fn write_public(path: &Path, contents: &str) -> Result<()> {
    write_atomic(path, contents, 0o644)
}

/// Hosts that go into the CSR and the SAN marker: the loopback names plus the
/// node's public address. Configured domains are dropped on purpose — the
/// control plane only signs `servers.ip` + localhost and rejects anything else
/// with `403 san_rejected` (contract §4), so asking would just fail.
pub fn canonical_hosts(extra: &[String]) -> Vec<String> {
    let mut hosts = vec!["localhost".to_string(), "127.0.0.1".to_string()];
    for host in extra {
        let host = host.trim();
        if !host.is_empty() && host.parse::<IpAddr>().is_ok() {
            hosts.push(host.to_string());
        }
    }
    let mut seen = std::collections::BTreeSet::new();
    hosts.retain(|h| seen.insert(h.clone()));
    hosts
}

/// Build a fresh key and CSR for `hosts`. Safe to call when an older leaf is
/// still on disk: nothing is written until [`install_leaf`] succeeds.
pub fn request_leaf(hosts: &[String]) -> Result<LeafRequest> {
    let key = KeyPair::generate().context("generate an ECDSA P-256 key")?;
    let mut params = CertificateParams::new(Vec::<String>::new())?;
    params
        .distinguished_name
        .push(DnType::CommonName, "veyl-node-agent");
    push_sans(&mut params, hosts)?;
    let csr = params
        .serialize_request(&key)
        .context("serialize the CSR")?;
    Ok(LeafRequest {
        key_pem: key.serialize_pem(),
        csr_b64: base64::engine::general_purpose::STANDARD.encode(csr.der().as_ref()),
        hosts: hosts.to_vec(),
    })
}

fn push_sans(params: &mut CertificateParams, hosts: &[String]) -> Result<()> {
    for host in hosts {
        match host.parse::<IpAddr>() {
            Ok(ip) => params.subject_alt_names.push(SanType::IpAddress(ip)),
            Err(_) => params
                .subject_alt_names
                .push(SanType::DnsName(host.as_str().try_into()?)),
        }
    }
    Ok(())
}

/// Persist a leaf the control plane just issued. Every file goes through a
/// `*.tmp` + fsync + rename, `leaf-meta.json` last: it is the commit marker, so
/// a crash mid-write leaves the node without a current certificate and it asks
/// again instead of serving a half-replaced pair.
pub fn install_leaf(
    dir: &Path,
    req: &LeafRequest,
    cert_pem: &str,
    ca_pem: &str,
    not_after: Option<i64>,
) -> Result<CertPaths> {
    std::fs::create_dir_all(dir)?;
    let p = paths(dir);

    let cert_der = first_der(cert_pem, "CERTIFICATE").context("leaf certificate")?;
    let ca_der = first_der(ca_pem, "CERTIFICATE").context("root certificate")?;
    let key = req.key_pair()?;
    let parsed = parse_x509(&cert_der)?;
    if parsed.tbs_certificate.subject_pki.raw != key.subject_public_key_info().as_slice() {
        bail!("the issued certificate does not match the requested private key");
    }
    let root = parse_x509(&ca_der)?;
    parsed
        .verify_signature(Some(root.public_key()))
        .map_err(|e| {
            anyhow::anyhow!("the issued certificate is not signed by the returned root: {e}")
        })?;
    let not_after = match not_after {
        Some(value) => value,
        None => parsed.validity().not_after.timestamp(),
    };

    write_secret(&p.leaf_key, &req.key_pem)?;
    write_secret(&p.leaf_cert, cert_pem)?;
    write_secret(&p.ca_cert, ca_pem)?;
    write_public(&p.leaf_sans, &serde_json::to_string_pretty(&req.hosts)?)?;
    let meta = LeafMeta {
        root_fingerprint: sha256_hex(&ca_der),
        not_after,
    };
    write_public(&p.leaf_meta, &serde_json::to_string_pretty(&meta)?)?;

    // Make the renames durable; best effort, the files themselves are synced.
    #[cfg(unix)]
    if let Ok(dir) = std::fs::File::open(dir) {
        let _ = dir.sync_all();
    }

    // The legacy self-signed CA's key signs nothing anymore; keep the node from
    // leaving a stale private key behind.
    let _ = std::fs::remove_file(dir.join("ca-key.pem"));
    Ok(p)
}

/// Contract §4. Three conditions decide whether the leaf on disk is the one the
/// current root issued for the current host list.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LeafState {
    /// Leaf and key exist, parse, and belong together.
    pub files_ok: bool,
    /// The certificate's own SANs cover every host this node needs. The SAN
    /// marker is *not* used here: the control plane adds `servers.ip` from its
    /// own row, so the marker can lag behind a certificate that is fine.
    pub hosts_cover: bool,
    /// The SAN marker lists exactly the current hosts, i.e. this build asked
    /// for exactly what it needs now.
    pub hosts_exact: bool,
    /// `leaf-meta.json` says the leaf came from the root in `ca-cert.pem`.
    pub issued_by_current_root: bool,
    pub not_after: Option<i64>,
}

impl LeafState {
    /// Signed by the current root, files intact, SANs up to date.
    pub fn is_current(&self) -> bool {
        self.files_ok && self.hosts_exact && self.issued_by_current_root
    }

    /// Good enough to keep serving while a re-issue is impossible. A legacy
    /// self-signed pair satisfies this even though it is not current.
    pub fn servable(&self) -> bool {
        self.files_ok && self.hosts_cover
    }

    pub fn renewal_due(&self, now_unix: i64) -> bool {
        self.not_after
            .is_some_and(|not_after| not_after - now_unix < RENEWAL_WINDOW_SECS)
    }
}

pub fn inspect(dir: &Path, hosts: &[String]) -> LeafState {
    let p = paths(dir);
    // Only the certificate decides whether the node can serve: the control
    // plane fills SANs in from `servers.ip`, so the marker can lag behind.
    let leaf = leaf_pair(&p.leaf_cert, &p.leaf_key);
    let files_ok = leaf.is_ok();
    let cert_hosts = leaf.unwrap_or_default();
    let hosts_cover = hosts.iter().all(|host| {
        cert_hosts
            .iter()
            .any(|name| name.eq_ignore_ascii_case(host))
    });

    // The marker records what the request asked for; it only feeds the
    // "exactly current" check, never the servable one.
    let marker: Option<Vec<String>> = std::fs::read_to_string(&p.leaf_sans)
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok());
    let hosts_exact = marker.as_deref() == Some(hosts);

    let meta = read_meta(&p.leaf_meta);
    let issued_by_current_root = match (&meta, ca_fingerprint(&p.ca_cert)) {
        (Some(meta), Ok(fingerprint)) => meta.root_fingerprint == fingerprint,
        _ => false,
    };

    LeafState {
        files_ok,
        hosts_cover,
        hosts_exact,
        issued_by_current_root,
        not_after: meta.map(|meta| meta.not_after),
    }
}

fn read_meta(path: &Path) -> Option<LeafMeta> {
    let text = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&text).ok()
}

/// Parse both halves, prove they belong together, and return the SANs the
/// certificate actually carries. A half-replaced pair would otherwise be
/// "parseable" and every handshake would fail.
fn leaf_pair(cert_path: &Path, key_path: &Path) -> Result<Vec<String>> {
    let der = load_certs(cert_path)?
        .into_iter()
        .next()
        .with_context(|| format!("no certificate in {}", cert_path.display()))?;
    let text = std::fs::read_to_string(key_path)
        .with_context(|| format!("read {}", key_path.display()))?;
    let key = KeyPair::from_pem(&text).context("parse private key")?;
    let parsed = parse_x509(der.as_ref())?;
    if parsed.tbs_certificate.subject_pki.raw != key.subject_public_key_info().as_slice() {
        bail!(
            "{} and {} are not a key pair",
            cert_path.display(),
            key_path.display()
        );
    }
    sans_of(&parsed)
}

fn sans_of(cert: &x509_parser::certificate::X509Certificate<'_>) -> Result<Vec<String>> {
    let Some(extension) = cert
        .subject_alternative_name()
        .map_err(|e| anyhow::anyhow!("parse the certificate SANs: {e}"))?
    else {
        return Ok(Vec::new());
    };
    let mut names = Vec::new();
    for name in &extension.value.general_names {
        match name {
            x509_parser::extensions::GeneralName::DNSName(dns) => {
                names.push(dns.to_ascii_lowercase())
            }
            x509_parser::extensions::GeneralName::IPAddress(bytes) => {
                let ip = match bytes.len() {
                    4 => IpAddr::from(<[u8; 4]>::try_from(*bytes).context("IPv4 SAN")?),
                    16 => IpAddr::from(<[u8; 16]>::try_from(*bytes).context("IPv6 SAN")?),
                    other => bail!("IP SAN with {other} bytes"),
                };
                names.push(ip.to_string());
            }
            _ => {}
        }
    }
    Ok(names)
}

fn parse_x509(der: &[u8]) -> Result<x509_parser::certificate::X509Certificate<'_>> {
    let (_, parsed) = x509_parser::parse_x509_certificate(der)
        .map_err(|e| anyhow::anyhow!("parse certificate: {e}"))?;
    Ok(parsed)
}

fn first_der(text: &str, label: &str) -> Result<Vec<u8>> {
    pem_blocks(text, label)?
        .into_iter()
        .next()
        .with_context(|| format!("no {label} block"))
}

fn pem_blocks(text: &str, label: &str) -> Result<Vec<Vec<u8>>> {
    let begin = format!("-----BEGIN {label}-----");
    let end = format!("-----END {label}-----");
    let mut out = Vec::new();
    let mut rest = text;
    while let Some(i) = rest.find(&begin) {
        let after = &rest[i + begin.len()..];
        let Some(j) = after.find(&end) else { break };
        let b64: String = after[..j].chars().filter(|c| !c.is_whitespace()).collect();
        out.push(
            base64::engine::general_purpose::STANDARD
                .decode(b64)
                .context("decode PEM base64")?,
        );
        rest = &after[j + end.len()..];
    }
    Ok(out)
}

pub fn load_certs(path: &Path) -> Result<Vec<CertificateDer<'static>>> {
    let text = std::fs::read_to_string(path).with_context(|| format!("read {}", path.display()))?;
    let blocks = pem_blocks(&text, "CERTIFICATE")?;
    if blocks.is_empty() {
        bail!("no CERTIFICATE block in {}", path.display());
    }
    Ok(blocks.into_iter().map(CertificateDer::from).collect())
}

pub fn load_key(path: &Path) -> Result<PrivateKeyDer<'static>> {
    let text = std::fs::read_to_string(path).with_context(|| format!("read {}", path.display()))?;
    for (label, wrap) in [
        ("PRIVATE KEY", true), // PKCS#8, what rcgen writes
        ("RSA PRIVATE KEY", false),
        ("EC PRIVATE KEY", false),
    ] {
        if let Some(der) = pem_blocks(&text, label)?.into_iter().next() {
            return if wrap {
                Ok(PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(der)))
            } else if label == "RSA PRIVATE KEY" {
                Ok(PrivateKeyDer::Pkcs1(PrivatePkcs1KeyDer::from(der)))
            } else {
                Ok(PrivateKeyDer::Sec1(PrivateSec1KeyDer::from(der)))
            };
        }
    }
    bail!("no private key in {}", path.display())
}

pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    hex(Sha256::digest(bytes).as_slice())
}

fn first_cert_fingerprint(path: &Path) -> Result<String> {
    let der = load_certs(path)?
        .into_iter()
        .next()
        .with_context(|| format!("no certificate in {}", path.display()))?;
    Ok(sha256_hex(der.as_ref()))
}

pub fn leaf_fingerprint(path: &Path) -> Result<String> {
    first_cert_fingerprint(path)
}

pub fn ca_fingerprint(path: &Path) -> Result<String> {
    first_cert_fingerprint(path)
}

/// SANs from the last leaf, minus the always-present local ones. Used when the
/// public IP cannot be detected at startup: the previous address must stay in
/// the host list, or the restarted agent would ask for a leaf without it.
pub fn previous_extra_hosts(dir: &Path) -> Option<Vec<String>> {
    let text = std::fs::read_to_string(paths(dir).leaf_sans).ok()?;
    let hosts: Vec<String> = serde_json::from_str(&text).ok()?;
    Some(
        hosts
            .into_iter()
            .filter(|h| h != "localhost" && h != "127.0.0.1")
            .collect(),
    )
}

pub fn parse_fingerprint(s: &str) -> Result<[u8; 32]> {
    let clean: String = s.chars().filter(|c| c.is_ascii_hexdigit()).collect();
    if clean.len() != 64 {
        bail!(
            "fingerprint must be 64 hex chars (32 bytes), got {}",
            clean.len()
        );
    }
    let mut out = [0u8; 32];
    for (i, byte) in out.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&clean[i * 2..i * 2 + 2], 16)?;
    }
    Ok(out)
}

/// Dev/test only: a throwaway self-signed CA plus a leaf, written exactly like
/// a control-plane install. The production binary never compiles this — a node
/// must not be able to mint its own trust anchor.
#[cfg(any(test, feature = "dev"))]
pub fn generate(dir: &Path) -> Result<CertPaths> {
    generate_with_hosts(dir, &[])
}

#[cfg(any(test, feature = "dev"))]
pub fn generate_with_hosts(dir: &Path, extra_hosts: &[String]) -> Result<CertPaths> {
    let hosts = canonical_hosts(extra_hosts);
    let req = request_leaf(&hosts)?;
    let (cert_pem, ca_pem) = dev_sign(&req)?;
    install_leaf(dir, &req, &cert_pem, &ca_pem, None)
}

/// Dev/test only: sign a pending request with a throwaway CA, standing in for
/// the control plane.
#[cfg(any(test, feature = "dev"))]
pub(crate) fn dev_sign(req: &LeafRequest) -> Result<(String, String)> {
    let key = req.key_pair()?;

    let mut ca_params = CertificateParams::new(Vec::<String>::new())?;
    ca_params
        .distinguished_name
        .push(DnType::CommonName, "Veyl Dev CA");
    ca_params.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
    ca_params.key_usages = vec![
        KeyUsagePurpose::KeyCertSign,
        KeyUsagePurpose::CrlSign,
        KeyUsagePurpose::DigitalSignature,
    ];
    let ca_key = KeyPair::generate()?;
    let ca_cert = ca_params.self_signed(&ca_key)?;
    let issuer = Issuer::new(ca_params, ca_key);

    let mut params = CertificateParams::new(Vec::<String>::new())?;
    params
        .distinguished_name
        .push(DnType::CommonName, "veyl-node-agent");
    push_sans(&mut params, req.hosts())?;
    params.key_usages = vec![
        KeyUsagePurpose::DigitalSignature,
        KeyUsagePurpose::KeyEncipherment,
    ];
    params.extended_key_usages = vec![ExtendedKeyUsagePurpose::ServerAuth];
    params.use_authority_key_identifier_extension = true;
    let leaf = params.signed_by(&key, &issuer)?;
    Ok((leaf.pem(), ca_cert.pem()))
}

/// Dev/test only: keep an existing current dev pair, otherwise make one.
#[cfg(any(test, feature = "dev"))]
pub fn ensure_dev_certs(dir: &Path, extra_hosts: &[String]) -> Result<CertPaths> {
    let hosts = canonical_hosts(extra_hosts);
    if inspect(dir, &hosts).is_current() {
        return Ok(paths(dir));
    }
    generate_with_hosts(dir, extra_hosts)
}

#[cfg(test)]
mod tests {
    use super::*;
    use x509_parser::prelude::{FromDer, GeneralName, ParsedExtension, X509CertificationRequest};

    fn tmpdir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "veyl-agent-cert-{name}-{}-{}",
            std::process::id(),
            auth_nonce()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn auth_nonce() -> u64 {
        use std::time::{SystemTime, UNIX_EPOCH};
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .subsec_nanos() as u64
    }

    #[test]
    fn canonical_hosts_drop_names_the_root_will_not_sign() {
        let hosts = canonical_hosts(&[
            "203.0.113.7".to_string(),
            "node.example.com".to_string(),
            "203.0.113.7".to_string(),
        ]);
        assert_eq!(hosts, vec!["localhost", "127.0.0.1", "203.0.113.7"]);
    }

    #[test]
    fn a_request_is_a_p256_csr_for_the_leaf_hosts() {
        let hosts = canonical_hosts(&["203.0.113.7".to_string()]);
        let req = request_leaf(&hosts).unwrap();
        assert_eq!(req.hosts(), hosts.as_slice());

        let der = base64::engine::general_purpose::STANDARD
            .decode(req.csr_b64())
            .unwrap();
        let (_, csr) = X509CertificationRequest::from_der(&der).unwrap();
        let names = csr
            .requested_extensions()
            .and_then(|mut extensions| {
                extensions.find_map(|extension| match extension {
                    ParsedExtension::SubjectAlternativeName(san) => Some(san.general_names.clone()),
                    _ => None,
                })
            })
            .expect("the CSR carries its SANs");
        let names: Vec<String> = names
            .iter()
            .map(|name| match name {
                GeneralName::DNSName(dns) => format!("dns:{dns}"),
                GeneralName::IPAddress(bytes) => {
                    let addr = <[u8; 4]>::try_from(*bytes).expect("IPv4 SAN");
                    format!("ip:{}", std::net::IpAddr::from(addr))
                }
                other => format!("other:{other:?}"),
            })
            .collect();
        assert!(names.contains(&"dns:localhost".to_string()));
        assert!(names.contains(&"ip:127.0.0.1".to_string()));
        assert!(names.contains(&"ip:203.0.113.7".to_string()));
    }

    #[test]
    fn installing_persists_all_four_pieces_and_marks_the_leaf_current() {
        let dir = tmpdir("install");
        let hosts = canonical_hosts(&["203.0.113.7".to_string()]);
        generate_with_hosts(&dir, &["203.0.113.7".to_string()]).unwrap();

        let p = paths(&dir);
        assert!(p.leaf_cert.exists());
        assert!(p.leaf_key.exists());
        assert!(p.ca_cert.exists());
        assert!(p.leaf_meta.exists());
        assert!(!dir.join("ca-key.pem").exists(), "no CA key on a node");

        let meta = read_meta(&p.leaf_meta).unwrap();
        assert_eq!(meta.root_fingerprint, ca_fingerprint(&p.ca_cert).unwrap());
        assert!(meta.not_after > 0);

        let state = inspect(&dir, &hosts);
        assert!(state.files_ok && state.hosts_exact && state.issued_by_current_root);
        assert!(state.is_current() && state.servable());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_legacy_leaf_is_servable_but_not_current() {
        // The migration trigger: an old self-signed node has no leaf-meta.json,
        // so it must ask the control plane for a new leaf — but it can keep
        // serving the old pair until that works.
        let dir = tmpdir("legacy");
        let hosts = canonical_hosts(&[]);
        generate_with_hosts(&dir, &[]).unwrap();
        std::fs::remove_file(paths(&dir).leaf_meta).unwrap();

        let state = inspect(&dir, &hosts);
        assert!(state.files_ok && state.hosts_exact);
        assert!(!state.issued_by_current_root);
        assert!(!state.is_current());
        assert!(
            state.servable(),
            "a migrated node still serves its old leaf"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn changing_the_public_ip_needs_a_new_leaf() {
        let dir = tmpdir("hosts");
        generate_with_hosts(&dir, &[]).unwrap();

        // The certificate itself has no SAN for the new address.
        let state = inspect(&dir, &canonical_hosts(&["203.0.113.7".to_string()]));
        assert!(state.files_ok);
        assert!(!state.hosts_cover && !state.hosts_exact);
        assert!(!state.is_current() && !state.servable());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_lagging_marker_does_not_make_a_good_certificate_unservable() {
        // The control plane adds `servers.ip` from its own row, so a
        // certificate can cover more than the CSR asked for. Only the
        // certificate decides whether the node can serve.
        let dir = tmpdir("lagging");
        let hosts = canonical_hosts(&["203.0.113.7".to_string()]);
        generate_with_hosts(&dir, &["203.0.113.7".to_string()]).unwrap();
        std::fs::write(
            paths(&dir).leaf_sans,
            serde_json::to_vec(&vec!["localhost".to_string(), "127.0.0.1".to_string()]).unwrap(),
        )
        .unwrap();

        let state = inspect(&dir, &hosts);
        assert!(state.hosts_cover, "the certificate itself carries the IP");
        assert!(!state.hosts_exact, "the marker still lacks it");
        assert!(state.servable());
        assert!(!state.is_current());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_missing_marker_does_not_stop_the_node_serving_its_certificate() {
        let dir = tmpdir("no-marker");
        let hosts = canonical_hosts(&["203.0.113.7".to_string()]);
        generate_with_hosts(&dir, &["203.0.113.7".to_string()]).unwrap();
        std::fs::remove_file(paths(&dir).leaf_sans).unwrap();

        let state = inspect(&dir, &hosts);
        assert!(state.files_ok && state.hosts_cover);
        assert!(!state.hosts_exact);
        assert!(state.servable() && !state.is_current());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn renewal_starts_thirty_days_before_expiry() {
        let dir = tmpdir("renewal");
        let hosts = canonical_hosts(&[]);
        generate_with_hosts(&dir, &[]).unwrap();

        let mut meta = read_meta(&paths(&dir).leaf_meta).unwrap();
        let now = 1_900_000_000;
        meta.not_after = now + RENEWAL_WINDOW_SECS + 60;
        std::fs::write(paths(&dir).leaf_meta, serde_json::to_vec(&meta).unwrap()).unwrap();
        assert!(!inspect(&dir, &hosts).renewal_due(now));

        meta.not_after = now + RENEWAL_WINDOW_SECS - 60;
        std::fs::write(paths(&dir).leaf_meta, serde_json::to_vec(&meta).unwrap()).unwrap();
        assert!(inspect(&dir, &hosts).renewal_due(now));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_half_replaced_pair_is_not_servable() {
        let dir = tmpdir("pair");
        let hosts = canonical_hosts(&[]);
        generate_with_hosts(&dir, &[]).unwrap();
        // Simulate a crash between writing the key and the certificate.
        write_secret(
            &paths(&dir).leaf_key,
            &KeyPair::generate().unwrap().serialize_pem(),
        )
        .unwrap();

        let state = inspect(&dir, &hosts);
        assert!(!state.files_ok);
        assert!(!state.servable());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_failed_renewal_leaves_the_servable_leaf_in_place() {
        let dir = tmpdir("stale");
        let hosts = canonical_hosts(&[]);
        generate_with_hosts(&dir, &[]).unwrap();
        std::fs::remove_file(paths(&dir).leaf_meta).unwrap();
        let before = leaf_fingerprint(&paths(&dir).leaf_cert).unwrap();

        // Nothing is written when the request cannot be installed (the agent
        // does not call install_leaf on a failed round), so the old leaf stays.
        let state = inspect(&dir, &hosts);
        assert!(state.servable() && !state.is_current());
        assert_eq!(leaf_fingerprint(&paths(&dir).leaf_cert).unwrap(), before);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_certificate_for_another_key_is_not_servable() {
        let dir = tmpdir("pair-mismatch");
        let hosts = canonical_hosts(&[]);
        generate_with_hosts(&dir, &[]).unwrap();

        // A perfectly valid certificate, just for a different private key.
        let other = request_leaf(&hosts).unwrap();
        let (other_cert, _) = dev_sign(&other).unwrap();
        write_secret(&paths(&dir).leaf_cert, &other_cert).unwrap();

        let state = inspect(&dir, &hosts);
        assert!(!state.files_ok && !state.servable());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn installing_a_certificate_for_another_key_is_refused() {
        let dir = tmpdir("install-mismatch");
        let hosts = canonical_hosts(&[]);
        let req = request_leaf(&hosts).unwrap();
        let other = request_leaf(&hosts).unwrap();
        let (cert_pem, ca_pem) = dev_sign(&other).unwrap();

        assert!(install_leaf(&dir, &req, &cert_pem, &ca_pem, None).is_err());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn installing_a_certificate_from_another_root_is_refused() {
        let dir = tmpdir("root-mismatch");
        let hosts = canonical_hosts(&[]);
        let req = request_leaf(&hosts).unwrap();
        let (cert_pem, _) = dev_sign(&req).unwrap();
        let (_, other_ca) = dev_sign(&request_leaf(&hosts).unwrap()).unwrap();

        assert!(install_leaf(&dir, &req, &cert_pem, &other_ca, None).is_err());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn install_derives_not_after_from_the_certificate_when_omitted() {
        let dir = tmpdir("not-after");
        generate_with_hosts(&dir, &[]).unwrap();
        let meta = read_meta(&paths(&dir).leaf_meta).unwrap();
        let der = load_certs(&paths(&dir).leaf_cert).unwrap().remove(0);
        assert_eq!(
            meta.not_after,
            parse_x509(der.as_ref())
                .unwrap()
                .validity()
                .not_after
                .timestamp()
        );
        std::fs::remove_dir_all(&dir).ok();
    }
}
